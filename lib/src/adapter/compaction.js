/**
 * 预期失败 → 压缩状态（§27.5 第 3 条：busy/changed 按实际状态核对，禁止忙循环重试）。
 *
 * `cancelled` 与其余 code 一样落 `error`，但明细里必须点名 cancelled：
 * "任务被取消"要有明确结果，不能被记成一次成功压缩。`detail` 一律带上 code 与原始 message，
 * 读不到 code 时带上错误名——判据可以缺，事实不许编。
 */
export function mapCompactionError(error) {
    const code = fieldString(error, 'code');
    const text = errorText(error);
    if (code === 'busy') {
        return { status: 'busy', detail: `压缩入口被占用（code=busy）：${text}；按实际状态核对，禁止忙循环重试（§27.5 第 3 条）` };
    }
    if (code === 'changed') {
        return { status: 'changed', detail: `会话版本或选中区间已变化（code=changed）：${text}；旧评估不再适用，先重新检查（§27.5 第 2、3 条）` };
    }
    if (code === 'cancelled') {
        return { status: 'error', detail: `压缩被取消（code=cancelled）：${text}；按失败处理，不记成功（§27.5 第 3 条）` };
    }
    if (code !== undefined)
        return { status: 'error', detail: `压缩失败（code=${code}）：${text}` };
    return { status: 'error', detail: `压缩抛错（${errorLabel(error)}，未携带可识别的 ManualCompactionError code）：${text}` };
}
/**
 * 把真机引擎包成 `CompactionPort`（§27.5 第 3、4 条）。
 *
 * 三条刻意的选择：
 * 1. **agent 入口先核形状**：`compactNow` 的第一个参数必须是带 `runMaintenance` 的维护上下文；
 *    拿不到就不调用（不静默调用无效入口），直接给 `error` 并写明原因。
 * 2. **并发即 busy**：互斥入口同一时刻只允许一次调用；上一次未返回就再进，
 *    不并发调用引擎（也避免把"两次压缩"记成一次）。
 * 3. **信号由本端口自己发**：引擎要求 `AbortSignal`，我们把内部 `AbortController` 的 signal 交给它；
 *    本端口没有对外取消面，因此会话侧取消（`code=cancelled`）是唯一会真正到达的取消形态。
 */
export function compactionPort(engine, agent) {
    let inflight;
    return {
        async compactNow(session) {
            if (!hasMaintenance(agent)) {
                return {
                    status: 'error',
                    detail: 'agent 缺少可读的 runMaintenance：不满足 ManualCompactAgentContext（compaction src/index.ts:77-88），拒绝调用无效入口；' +
                        '本次压缩未发生，按未执行处理（§27.5 第 3 条）',
                };
            }
            if (inflight !== undefined) {
                return { status: 'busy', detail: '上一次压缩调用尚未返回：互斥入口不并发调用（§27.5 第 3 条）' };
            }
            const target = sessionOf(agent, session);
            if (target.error !== undefined)
                return { status: 'error', detail: target.error };
            const controller = new AbortController();
            inflight = controller;
            try {
                const raw = await engine.compactNow(agent, controller.signal);
                if (raw === null)
                    return { status: 'refused', detail: '引擎报告没有可安全压缩的区间（compactNow 返回 null）' };
                if (raw === undefined) {
                    return { status: 'error', detail: 'compactNow 返回 undefined：读不出压缩结果，按失败处理（未知 ≠ 成功，§27.5 第 4 条）' };
                }
                const summary = readCompactionSummary(raw);
                const reclaimed = fieldNumber(raw, 'shadowedTokenCount');
                const shadowed = arrayLength(raw, 'shadowedSeqs');
                if (summary === undefined && reclaimed === undefined && shadowed === undefined) {
                    return {
                        status: 'error',
                        detail: 'compactNow 返回的对象读不出 CompactionResult 的任何可核对面（summary/shadowedTokenCount/shadowedSeqs 全缺）：' +
                            '按失败处理，未知 ≠ 成功（§27.5 第 4 条）',
                    };
                }
                return {
                    status: 'completed',
                    detail: completionDetail(summary, shadowed, reclaimed),
                    ...(reclaimed === undefined ? {} : { reclaimedTokens: reclaimed }),
                };
            }
            catch (error) {
                return mapCompactionError(error);
            }
            finally {
                if (inflight === controller)
                    inflight = undefined;
            }
        },
    };
}
/**
 * `CompactionResult.summary` 的文本面（`ContentBlock[]` 里所有可读的 `text`）；
 * 读不到就返回 `undefined`——摘要文本缺失不能让调用被记成"完成且内容已在"。
 */
export function readCompactionSummary(result) {
    const blocks = fieldArray(result, 'summary');
    if (blocks === undefined)
        return undefined;
    const texts = [];
    for (const block of blocks) {
        const text = fieldString(block, 'text');
        if (text !== undefined)
            texts.push(text);
    }
    return texts.length === 0 ? undefined : texts.join('\n');
}
/** 交付回执的明细：摘要文本优先；文本读不到时如实说明"调用已发生、成效未核对"。 */
function completionDetail(summary, shadowed, reclaimed) {
    const accounting = [];
    if (shadowed !== undefined)
        accounting.push(`shadowedSeqs ${shadowed} 条`);
    if (reclaimed !== undefined)
        accounting.push(`估算回收 ~${reclaimed} token`);
    const tail = accounting.length === 0 ? '' : `（${accounting.join('，')}）`;
    if (summary === undefined) {
        return `compactNow 返回完成，但摘要文本读不到：按"调用已发生、成效未核对"处理${tail}；随后必须走压缩后核对，不得直接记 done（§27.5 第 4 条）`;
    }
    return `摘要：${summary}${tail}`;
}
/**
 * 压缩目标核对（§27.5 第 3 条）：引擎只会压 `agent` 自己绑定的那个会话，所以必须先确认
 * 它就是做评估的那个会话，否则一次"压缩"会打到别的会话上去。
 *
 * 身份口径按真机：公开类型 `Agent` 只有 `readonly id: SessionId`
 * （dsh: `packages/core/agent/src/types.ts:15-19`，另见 `tool-cordis/src/api-catalog.ts:4485` 的同形声明），
 * 运行时面再用声明合并补上 `session`/`inbox`/`status`（dsh: `packages/core/agent/src/runtime-types.ts:164-172`），
 * 所以这里依次尝试 `agent.id` → `agent.sessionId` → `agent.session.id`，取第一个读得出的身份。
 * 旧写法**只**读 `agent.session.id`：拿不到就是 `undefined`，而函数把 `undefined` 当"跳过核对"放行，
 * 等于这条守卫从来没生效过（fail-open）。现在任一侧读不出都拒绝调用（无法核对目标 = 不压；未知 ≠ 可以压）。
 */
function sessionOf(agent, session) {
    const agentSession = agentIdentity(agent);
    const observed = sessionIdentity(session);
    if (agentSession === undefined) {
        return { error: '读不出 agent 绑定的会话身份（id / sessionId / session.id 三格都空）：无法核对压缩目标，本次压缩未发生（§27.5 第 3 条）' };
    }
    if (observed === undefined) {
        return { error: `读不出观测会话身份：无法核对压缩目标（agent 绑定 ${agentSession}），本次压缩未发生（§27.5 第 3 条）` };
    }
    if (agentSession === observed)
        return {};
    return { error: `agent 绑定会话 ${agentSession} 与观测会话 ${observed} 不一致：拒绝把压缩打到别的会话上` };
}
/** agent 侧的会话身份：真机是 `agent.id`，另外容忍 `sessionId` 与旧的 `session.id` 形状。 */
function agentIdentity(agent) {
    const self = sessionIdentity(agent);
    if (self !== undefined)
        return self;
    return sessionIdentity(agentField(agent, 'session'));
}
function sessionIdentity(value) {
    const direct = fieldString(value, 'id');
    if (direct !== undefined)
        return direct;
    return fieldString(value, 'sessionId');
}
function agentField(agent, key) {
    const record = asObject(agent);
    return record === undefined ? undefined : record[key];
}
function hasMaintenance(agent) {
    const record = asObject(agent);
    return record !== undefined && typeof record['runMaintenance'] === 'function';
}
// —— 结构化读取（读不到即 undefined；未知绝不回退成 0/空/成功） ——
function asObject(value) {
    return value !== null && typeof value === 'object' ? value : undefined;
}
function fieldString(value, key) {
    const record = asObject(value);
    if (record === undefined)
        return undefined;
    const field = record[key];
    return typeof field === 'string' && field.length > 0 ? field : undefined;
}
function fieldNumber(value, key) {
    const record = asObject(value);
    if (record === undefined)
        return undefined;
    const field = record[key];
    return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}
function fieldArray(value, key) {
    const record = asObject(value);
    if (record === undefined)
        return undefined;
    const field = record[key];
    return Array.isArray(field) ? field : undefined;
}
/** 数组形态读得出就给长度：`CompactionResult.shadowedSeqs` 存在即是可核对的账目。 */
function arrayLength(value, key) {
    return fieldArray(value, key)?.length;
}
function errorText(error) {
    if (error instanceof Error)
        return error.message.length > 0 ? error.message : error.name;
    const message = fieldString(error, 'message');
    if (message !== undefined)
        return message;
    return typeof error === 'string' && error.length > 0 ? error : '非 Error 抛出物（读不出 message）';
}
function errorLabel(error) {
    if (error instanceof Error && error.name.length > 0)
        return error.name;
    return fieldString(error, 'name') ?? 'unknown-error';
}
