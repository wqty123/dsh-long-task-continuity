import { revisionDrifts, ticketIsCurrent } from '../core/discipline.js';
import { isTerminalAttempt } from '../core/lease.js';
export const PHASES = ['REQUESTED', 'QUIESCING', 'PREPARED', 'TARGET_READY', 'COMMITTED', 'ACTIVATING', 'ACTIVE'];
/** 每阶段必须落盘的事实；缺任意一项即不许推进。 */
export const PHASE_FACTS = {
    // 依据/规则版本快照必须在 REQUESTED 当场落盘：§10.2 的放行重验要拿它和当前版本比，
    // 比"推进到 PREPARED 时再抓"更早，才覆盖得住"请求之后才出现的撤回"（§23.2 第 1 条）。
    REQUESTED: ['rotationId', 'actorId', 'sourceSessionId', 'trigger', 'basisRevisionAtRequest', 'policyRevisionAtRequest'],
    QUIESCING: ['phases', 'updatedAt'],
    PREPARED: ['checkpointId', 'targetSessionId', 'targetMessageId', 'bindingVersionBefore', 'bindingVersionAfter'],
    TARGET_READY: ['targetSessionId 已存在且禁止业务执行'],
    COMMITTED: ['Actor 当前绑定 = targetSessionId', 'bindingVersion 已递增', '启动 outbox 已写入'],
    ACTIVATING: ['启动消息 ID', '持久化回执'],
    ACTIVE: ['接续检查点已提交'],
    WAITING_RECOVERY: ['failurePhase', 'nextReconcileAction'],
};
export function missingPhaseFacts(rotation, phase) {
    const required = PHASE_FACTS[phase];
    const held = new Set(Object.keys(rotation).filter((key) => {
        const value = rotation[key];
        return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
    }));
    return required.filter((item) => !held.has(item.split(' ')[0] ?? item));
}
/**
 * 安全交接核对（§10.2 八条，v0.3 增第八条"在跑 Attempt 的票据失效先核对"）。
 *
 * 四个**前置型**信号（登记队列、子代理、外部副作用、待处理输入）按 `null = 未满足` 处理：
 * 能判定却没判定通过，比判定失败更危险。
 * `managedToolsRunning` 是唯一的例外，也是刻意的：`null` 表示本部署根本没有这个观测面
 * （我们只见过 `tool/call`/`tool/result` 配对，配对缺失说明不了"没有工具在跑"），
 * 而"是否有东西正在跑"由布尔型的 `stepRunning` 把关；这一项只在真的看到未收束调用时 (`true`) 才拦。
 *
 * `now` 只用于票据里的授权期限；默认取控制记录的最后提交时间以保持本函数可离线复算，
 * 适配器若能拿到真实时钟应当显式传入，别让旧提交时间替过期的授权说话。
 */
export function safeToHandoff(state, actor, probe, now = state.lastCommittedAt) {
    const missing = [];
    const sessionId = actor.sessionId;
    if (sessionId === undefined)
        return { ready: false, missing: ['actor 无当前会话绑定'], pending: false };
    if (probe.stepRunning(sessionId))
        missing.push('正在执行模型步骤');
    if (probe.managedToolsRunning(sessionId) === true)
        missing.push('受管工具仍在执行');
    if (probe.registerQueueFlushed() !== true)
        missing.push('登记队列未确认持久化');
    if (probe.nativeSubagentsSettled(sessionId) !== true)
        missing.push('原生子代理未结算或未确认停止');
    if (probe.externalEffectsResolved(sessionId) !== true)
        missing.push('外部副作用结果未确定');
    if (probe.pendingInputPersisted(sessionId) !== true)
        missing.push('待处理用户输入未持久化');
    const live = Object.values(state.attempts).filter((attempt) => attempt.actorId === actor.actorId && !isTerminalAttempt(attempt.status));
    if (live.length > 0 && live.every((attempt) => attempt.checkpointId === undefined))
        missing.push('无有效检查点');
    // §10.2 第 8 条（v0.3 §12.2、§22.6）：入场票据因依据撤回/授权撤销/任务书修订而失效时，
    // 这个 Attempt 的执行资格已经不成立。直接换绑等于把一份无效执行权迁到新会话继续用，
    // 因此先核对（结掉或按新版本重开），不在此刻交接。
    for (const attempt of live) {
        if (attempt.status !== 'running' || attempt.ticket === undefined)
            continue;
        const ticket = ticketIsCurrent(state, attempt.ticket, now);
        if (!ticket.ok)
            missing.push(`Attempt ${attempt.attemptId} 仍在执行但入场票据已失效（${ticket.reason}）：先核对再交接，不直接换绑`);
    }
    const unresolved = Object.values(state.operations).filter((op) => op.attemptId !== undefined && live.some((attempt) => attempt.attemptId === op.attemptId) && op.status === 'outcome_unknown');
    if (unresolved.length > 0)
        missing.push(`${unresolved.length} 项外部操作结果不确定`);
    return { ready: missing.length === 0, missing, pending: missing.length > 0 };
}
/**
 * S2 放行前的重验判定（§10.2 的安全交接条件 + §23.2 第 1 条）。
 * 与 `safeToHandoff` 的分工：那里问"此刻能不能动手"，这里问"手上这份交接包还算不算数"。
 * 返回形状一致，好让调用方共用同一套 hold/fail 出口；`missing` 里就是逐条可诊断的一句话原因。
 * `pending: true` 说的是**等待重算**而不是放弃轮换：已提交阶段与在途事实都保留。
 */
export function reverifyHandoffPackage(rotation, state) {
    const drifts = revisionDrifts(rotation, state);
    if (drifts.length === 0)
        return { ready: true, missing: [], pending: false };
    return { ready: false, missing: drifts.map((drift) => drift.detail), pending: true };
}
/**
 * 提交点之后的失败**不**自动退回 S1：执行权已属于 S2，保留事实等待核对（§10.3 末段）。
 * 回退必须走显式的新的绑定转换并再次递增版本，由 `continuity.resolveUnknown` 承载。
 */
export function pastCommit(rotation) {
    return rotation.phases.includes('COMMITTED');
}
export function shouldKeepSource(rotation) {
    return !pastCommit(rotation);
}
/** 阶段推进的合法后继（与 `commands.isLegalPhaseStep` 同源，供适配器提前拒绝）。 */
export function legalSuccessors(from) {
    if (from === 'WAITING_RECOVERY')
        return ['QUIESCING', 'COMMITTED', 'ACTIVATING', 'ACTIVE'];
    const index = PHASES.indexOf(from);
    if (index < 0)
        return [];
    const next = PHASES[index + 1];
    return next === undefined ? ['WAITING_RECOVERY'] : [next, 'WAITING_RECOVERY'];
}
