import { carriesHumanPrompt, decidePreStep, waitForBoundary } from '../rotation/latch.js';
import { ticketIsCurrent } from '../core/discipline.js';
/** 建 S2：预留 ID ⇒ 崩溃恢复时按同一 ID 查询并校验后复用，不另建重复会话（§10.4）。 */
export async function createOrAdoptTarget(host, spec, expectAdopt) {
    const controller = host.sessionController;
    if (controller === undefined)
        return { ok: false, reason: 'sessionController 未装载', code: 'service-missing' };
    try {
        const value = await controller.create({ sessionId: spec.sessionId, cwd: spec.cwd, ...(spec.agentPreset === undefined ? {} : { agentPreset: spec.agentPreset }) });
        return { ok: true, sessionId: String(value.sessionId), adopted: expectAdopt };
    }
    catch (error) {
        const code = errorCode(error);
        if (code === 'session/conflict')
            return { ok: false, reason: `预留会话 ${spec.sessionId} 的 cwd 或 preset 与请求不符，拒绝采用`, code };
        if (code === 'agent-preset/conflict')
            return { ok: false, reason: `预留会话 ${spec.sessionId} 的 preset 冲突`, code };
        if (code === 'session/writer-held')
            return { ok: false, reason: `会话 ${spec.sessionId} 已被其它写者持有`, code };
        return { ok: false, reason: `create 失败：${message(error)}`, code: code ?? 'create-failed' };
    }
}
/**
 * 投递固定启动消息并核对持久化回执。
 *
 * `sessions.flush()` 返回 `false` 表示**没有任何持久化者接手**，不是"没什么要写的"，
 * 因此按未落盘处理，进入 WAITING_RECOVERY 而不是继续推进（§10.4）。
 */
export async function deliverSeed(host, sessionId, text, messageId, makeMessage) {
    const controller = host.sessionController;
    if (controller === undefined)
        return { ok: false, reason: 'sessionController 未装载' };
    const found = await controller.resolveAgent(sessionId);
    if (found.error !== undefined)
        return { ok: false, reason: `resolveAgent: ${found.error.code ?? 'unknown'} ${found.error.message ?? ''}` };
    const agent = found.agent;
    if (agent === undefined)
        return { ok: false, reason: 'resolveAgent 返回体没有 agent' };
    try {
        await agent.followup(makeMessage(text, { kind: 'plugin', rpcId: messageId }));
    }
    catch (error) {
        return { ok: false, reason: `followup 抛错：${message(error)}` };
    }
    if (host.sessions === undefined)
        return { ok: false, reason: 'sessions 服务缺席，无法核对持久化回执' };
    const flushed = await host.sessions.flush(agent.session ?? agent);
    if (flushed !== true)
        return { ok: false, reason: 'flush 返回 false：无持久化者接手' };
    return { ok: true, persisted: true };
}
/**
 * 启动消息的边界标记：`confirmSeed` 在会话记录里按它反查，不依赖 plugin source 的扩展字段。
 * 定义在适配层而不是 index.ts：轮换运行器与装配层都要用它做核对，避免环形依赖。
 */
export const SEED_MARKER = '[[continuity-seed]]';
/**
 * 普通投递的边界标记：负载里没有消息 ID，所以用 outbox 条目的稳定幂等键当消息指纹。
 * 确认丢失后的重放靠它先查目标会话——查得到就不再投第二次（审阅 R2）。
 */
export const MAIL_MARKER = '[[continuity-mail]]';
/** 核对的分页参数：单页条数与页数上限（有界扫描，见 `confirmSeed`）。 */
const CONFIRM_PAGE_SIZE = 50;
const CONFIRM_MAX_PAGES = 20;
/** 取记录携带的 seq：真机是 `{ type:'event', event:{ seq } }`（`src/types.ts:426-428`），也容忍裸 `{ seq }`。 */
function recordSeq(record) {
    if (record === null || typeof record !== 'object')
        return undefined;
    const direct = record.seq;
    if (typeof direct === 'number' && Number.isFinite(direct))
        return direct;
    const event = record.event;
    const nested = event === null || event === undefined ? undefined : event.seq;
    return typeof nested === 'number' && Number.isFinite(nested) ? nested : undefined;
}
/**
 * 确认丢失时的核对：按稳定 rpcId 的**完整标记令牌**（`marker + id + marker`）查询目标会话的持久记录。
 *
 * 审阅 N1 修复：旧实现只查最近一页 50 条、未命中就报 `absent`，繁忙团队一旦跨过窗口，
 * 确认丢失后的恢复会再投一次。现在按真机分页契约向后翻页（`throughSeq: -1` 开放到最新，
 * `beforeSeq` 逐页取更旧记录，`src/history.ts:77-111`），直到：
 * - 命中完整令牌 → `present`（普通文本引用同一键不算回执：必须以成对标记为凭据）；
 * - `hasMore === false` 且扫尽仍无 → `absent`，这时"未投递"是**可证明**的，允许重投；
 * - 其余一律 `unknown`：面不匹配、没有 `hasMore` 覆盖声明、取不到游标、游标不前进、
 *   超过页数上限、读取出错——覆盖不足不是重发许可（复审验收：结果未知的重试不重投）。
 */
export async function confirmSeed(host, sessionId, messageId, marker) {
    const controller = host.sessionController;
    if (controller?.page === undefined)
        return 'unknown';
    const token = `${marker}${messageId}${marker}`;
    let beforeSeq;
    try {
        for (let index = 0; index < CONFIRM_MAX_PAGES; index += 1) {
            const request = {
                address: { kind: 'session', sessionId },
                throughSeq: -1,
                maxMessages: CONFIRM_PAGE_SIZE,
                ...(beforeSeq === undefined ? {} : { beforeSeq }),
            };
            const response = await controller.page(request, new AbortController().signal);
            const records = Array.isArray(response.records) ? response.records : undefined;
            if (records === undefined)
                return 'unknown';
            if (records.some((record) => recordHasToken(record, token)))
                return 'present';
            if (response.hasMore === false)
                return 'absent';
            if (response.hasMore !== true)
                return 'unknown';
            const oldest = oldestSeq(records);
            // 拿不到游标或游标没有前进：再翻也是同一页，直接承认覆盖不足（不许死循环、不许当 absent）。
            if (oldest === undefined || (beforeSeq !== undefined && oldest >= beforeSeq))
                return 'unknown';
            beforeSeq = oldest;
        }
        return 'unknown';
    }
    catch {
        return 'unknown';
    }
}
/** 记录里是否含完整标记令牌；序列化失败按"没有"处理，由调用方按覆盖不足收敛。 */
function recordHasToken(record, token) {
    try {
        return JSON.stringify(record)?.includes(token) ?? false;
    }
    catch {
        return false;
    }
}
/** 一页里最旧的 seq；记录都不带 seq 就返回 undefined，不许猜。 */
function oldestSeq(records) {
    let oldest;
    for (const record of records) {
        const seq = recordSeq(record);
        if (seq === undefined)
            continue;
        oldest = oldest === undefined ? seq : Math.min(oldest, seq);
    }
    return oldest;
}
export function preStepGuard(hostFor, sessionIdOf) {
    return async (payload, next) => {
        const sessionId = sessionIdOf(payload.agent);
        if (sessionId === undefined)
            return next();
        const host = hostFor(sessionId);
        if (host === undefined)
            return next();
        const verdict = decidePreStep({ stopRequested: host.latch.isHeld(host.sessionId), messages: payload.messages });
        if (verdict.reason !== 'human-prompt')
            return verdict.reject ? { kind: 'reject' } : next();
        const text = payload.messages
            .flatMap((message) => message.content ?? [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('\n');
        if (host.stage === 'before-commit') {
            host.logger?.info('pre-step：轮换提交前收到人类输入，放弃本次迁移');
            host.abandonRotation('用户在轮换提交前发来了新消息');
            return next();
        }
        try {
            await host.reroute(text);
            host.logger?.info('pre-step：人类输入已改道到当前绑定，本步拒绝');
            return { kind: 'reject' };
        }
        catch (error) {
            host.logger?.warn(`pre-step：改道失败（${String(error)}），本步放行进源会话，不丢输入`);
            return next();
        }
    };
}
export function hasHumanPrompt(messages) {
    return carriesHumanPrompt(messages);
}
/** 已软停的旧会话等待边界；`whenIdle` 的失败也算边界。 */
export async function quiesce(agent, opts) {
    return waitForBoundary(agent, opts);
}
export function toolGuard(snapshot, identify) {
    return (execution) => {
        const snapshotValue = snapshot();
        const toolName = execution.name ?? '';
        if (snapshotValue.readOnlyTools.has(toolName))
            return undefined;
        const actorId = identify(execution);
        if (actorId === undefined)
            return 'no trusted actor identity for this tool call; managed writes are stopped';
        if (snapshotValue.closed)
            return `actor ${actorId} has no execution right (admission closed)`;
        const ticket = snapshotValue.tickets.get(actorId);
        if (ticket === undefined)
            return `actor ${actorId} holds no live admission ticket`;
        if (snapshotValue.state === null)
            return `actor ${actorId} holds ticket ${ticket.attemptId} but the control record is unreadable; managed writes are stopped`;
        const freshness = ticketIsCurrent(snapshotValue.state, ticket, snapshotValue.now);
        if (!freshness.ok)
            return `actor ${actorId} ticket is stale: ${freshness.reason}`;
        return undefined;
    };
}
/**
 * 原生成员创建只能由 Lead 发起（R1：成员与 Lead 权限与纪律相同，唯一差别是只有 Lead 能创建成员）。
 *
 * 为什么单列一条守卫、而不并进 `toolGuard`：那条管的是"受管写入有没有未失效的准入票据"，
 * 而且整段注册被 `enforceAdmission` 开关门禁着（`src/index.ts:2273`）。而"谁能创建成员"是
 * **权限**，与写入准入无关，也不该被那个开关连坐——enforceAdmission 默认 false，一并进去
 * 等于这条权限约束永远不上岗。
 *
 * 覆盖面依据（已核源码）：`tools` 服务的 guard 在**普通 ctx** 上注册即全局生效
 * （dsh: `packages/core/tools/src/index.ts:1127-1130`：*"A plain-context guard applies globally"*），
 * 单调、任何 guard 都无法放开别家的拒绝（`:724-726`），所以**本体工具** `spawn_teammate`
 * 同样在拦截范围内。
 *
 * 守卫是**同步**的（dsh: `:767` `guardReason(exec)` 同步求值），所以身份判据只能来自同步快照，
 * 不能在这里 await 台账。
 *
 * @param actorOf - 按会话 id 同步取未退役 Actor（缺失即视为未入台账）。
 * @param sessionIdOf - 从执行的 agent 字段取会话 id（由装配层注入，保持本层无宿主依赖）。
 * @returns 拒绝理由；`undefined` 放行。非 `spawn_teammate` 一律放行。
 */
export function memberCreationGuard(actorOf, sessionIdOf) {
    return (execution) => {
        if ((execution.name ?? '') !== 'spawn_teammate')
            return undefined;
        const sessionId = sessionIdOf(execution.agent);
        if (sessionId === undefined) {
            return 'spawn_teammate 被拒：调用者会话未知；成员创建只允许由已入台账的 Lead 发起';
        }
        const actor = actorOf(sessionId);
        if (actor === undefined) {
            return `spawn_teammate 被拒：会话 ${sessionId} 未绑定 Actor；只有已入台账的 Lead 能创建成员`;
        }
        if (actor.role !== 'lead') {
            return `spawn_teammate 被拒：只有 Lead 能创建成员（当前身份 ${actor.role}）`;
        }
        return undefined;
    };
}
/**
 * 迁移旧会话上的定时任务到新会话（借鉴 DS Bot `moveSchedules`，Apache-2.0）。
 *
 * 未能在启用自动轮换前安全处理的定时任务，必须阻止该会话自动轮换（§10.5）。
 */
export async function moveSchedules(host, from, to) {
    const service = host.schedule;
    if (service?.list === undefined)
        return { moved: 0, blocked: ['schedule 服务不可枚举：该会话的自动轮换保持阻止'] };
    const entries = await service.list();
    const owned = (Array.isArray(entries) ? entries : [...entries]).filter((entry) => entry.sessionId === from);
    if (service.update === undefined)
        return { moved: 0, blocked: owned.map((entry) => entry.id) };
    const failed = [];
    let moved = 0;
    for (const entry of owned) {
        try {
            await service.update(entry.id, { sessionId: to, address: { kind: 'session', sessionId: to } });
            moved += 1;
        }
        catch {
            failed.push(entry.id);
        }
    }
    return { moved, blocked: failed };
}
export function readPressure(host, session) {
    const registry = host.sessionProjections;
    if (registry === undefined)
        return null;
    const state = registry.stateOf(session, 'contextPressure');
    if (state === null || state === undefined || typeof state !== 'object')
        return null;
    const raw = state;
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
    const pressureTokens = num(raw.pressureTokens);
    const surfaceTokens = num(raw.surfaceTokens);
    const sampledSurfaceTokens = num(raw.sampledSurfaceTokens);
    const projectedTokens = pressureTokens === undefined || surfaceTokens === undefined || sampledSurfaceTokens === undefined
        ? undefined
        : Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens);
    const contextWindow = num(raw.contextWindow);
    return {
        ...(projectedTokens === undefined ? {} : { projectedTokens }),
        ...(pressureTokens === undefined ? {} : { pressureTokens }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
    };
}
/**
 * `turnBoundary` 投影读取（口径来自本机 `core/agent/src/types.ts:78`）。
 *
 * 只用于**对账**：轮末判定用 `turn/end` 事件推进计数，投影给的是持久侧的轮号与"是否在轮内"。
 * 两者不一致说明本进程的事件视图与持久状态已分叉（漏事件、重挂、别的 Host 在写），
 * 此时宁可不换会话——§10.2 明确"turnBoundary 变化仅是候选信号"。
 */
export function readTurnBoundary(host, session) {
    const registry = host.sessionProjections;
    if (registry === undefined)
        return null;
    const state = registry.stateOf(session, 'turnBoundary');
    if (state === null || state === undefined || typeof state !== 'object')
        return null;
    const raw = state;
    if (typeof raw.lastTurn !== 'number' || !Number.isFinite(raw.lastTurn))
        return null;
    const open = raw.openTurnStartSeq;
    const boundary = raw.lastStepBoundary;
    return {
        lastTurn: raw.lastTurn,
        openTurnStartSeq: typeof open === 'number' && Number.isFinite(open) ? open : null,
        lastStepBoundary: boundary === null || boundary === undefined || (boundary.kind !== 'start' && boundary.kind !== 'end') ? null : boundary.kind,
    };
}
export function measuredTokens(host, session) {
    const reading = host.tokenMeter?.measure(session);
    return reading === undefined ? undefined : reading.totalTokens;
}
export function reserveSessionId() {
    return `session-${crypto.randomUUID()}`;
}
function errorCode(error) {
    const code = error?.code;
    return typeof code === 'string' ? code : undefined;
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
