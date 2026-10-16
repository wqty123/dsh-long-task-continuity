export const DEFAULT_GUARD_CONFIG = {
    warnRatio: 0.45,
    hardRatio: 0.6,
    hysteresisRatio: 0.05,
    cooldownTurns: 5,
    respectCompaction: true,
    enabled: true,
};
export function initialGuardState() {
    return { level: 'none', armed: false, turn: 0, cooldown: 0, compactionDrop: false, occupancy: null };
}
const LEVEL_RANK = { none: 0, warn: 1, hard: 2 };
export function reduceGuard(state, occupancy, options = {}) {
    const cfg = options.config ?? DEFAULT_GUARD_CONFIG;
    // fail-closed：无分母不动状态机，也不清除既有档位。
    if (!occupancy.known || occupancy.ratio === null)
        return { state: { ...state }, signal: null };
    const ratio = occupancy.ratio;
    const hysteresis = Math.max(0, cfg.hysteresisRatio);
    const rearmBelow = Math.max(0, cfg.warnRatio - hysteresis);
    const wasLevel = state.level;
    const next = { ...state, occupancy: { ...occupancy } };
    if (ratio < rearmBelow) {
        if (wasLevel !== 'none')
            next.compactionDrop = true;
        next.level = 'none';
        next.armed = false;
    }
    else if (ratio < cfg.warnRatio) {
        next.compactionDrop = false;
    }
    if (ratio < cfg.warnRatio)
        return { state: next, signal: null };
    const level = ratio >= cfg.hardRatio ? 'hard' : 'warn';
    if (!next.armed) {
        next.armed = true;
        next.level = level;
        next.cooldown = Math.max(0, cfg.cooldownTurns);
        const suppressed = cfg.respectCompaction && options.atTurnBoundary === true && options.justCompacted === true;
        if (suppressed)
            return { state: next, signal: null };
        return { state: next, signal: signalOf('enter', level, next) };
    }
    if (LEVEL_RANK[level] > LEVEL_RANK[wasLevel]) {
        next.level = level;
        return { state: next, signal: signalOf('escalate', level, next) };
    }
    next.level = LEVEL_RANK[level] > LEVEL_RANK[wasLevel] ? level : wasLevel;
    return { state: next, signal: null };
}
function signalOf(kind, level, state) {
    return {
        kind,
        level,
        ratio: state.occupancy?.ratio ?? null,
        projectedTokens: state.occupancy?.projectedTokens ?? null,
        contextWindow: state.occupancy?.contextWindow ?? null,
        turn: state.turn,
        compactionDrop: state.compactionDrop,
    };
}
/** 一轮结束：判定与提示只在轮末，绝不 mid-turn（那轮已经发出去了）。 */
export function nextTurn(state) {
    return { ...state, turn: state.turn + 1, cooldown: Math.max(0, state.cooldown - 1), compactionDrop: false };
}
export function inCooldown(state) {
    return state.cooldown > 0;
}
/** 路由或目标模型变化时清空武装：旧窗口的迟滞对新窗口没有意义。 */
export function resetArming(state) {
    return { ...state, armed: false, level: 'none', cooldown: 0 };
}
/**
 * 每会话日志水位。
 *
 * `session/event` 每次持久追加都会触发；同一日志位置不能评估两次
 * （移植自 dsh-auto-handoff 的 `TokenTracker`，MIT）。
 */
export class SessionWatermark {
    marks = new Map();
    observe(sessionId, seq) {
        const previous = this.marks.get(sessionId);
        if (previous !== undefined && seq <= previous)
            return false;
        this.marks.set(sessionId, seq);
        return true;
    }
    watermark(sessionId) {
        return this.marks.get(sessionId) ?? -1;
    }
    reset(sessionId) {
        this.marks.delete(sessionId);
    }
    clear() {
        this.marks.clear();
    }
    get size() {
        return this.marks.size;
    }
}
/**
 * "等待重算交接包"这个出口的机器可读标记（§10.2、§23.2 第 1 条）。
 * 词表沿用既有 `observe`：既不是"继续换"（rotate），也不是"这条线不需要换"（none），
 * 而是"该换，但手上这份材料已经不代表当前依据，先重算再放行"。
 */
export const AWAIT_BRIEF_RECOMPUTE = 'await-brief-recompute';
/**
 * 轮换入场判定。返回**机器可读的原因**，每条都可断言。
 *
 * 顺序即优先级：退役 / 无数据 / 未启用 / 线不可用 先于一切业务判断；
 * 未结束轮换与待重算交接包、频率保险先于迟滞与冷却；
 * 边界条件最后检查——前面每一道都放行时才轮到它排队，否则排队没有意义。
 */
export function decideRotation(input) {
    if (input.actorRetired)
        return { kind: 'none', reason: 'actor-retired' };
    if (!input.occupancy.known || input.occupancy.ratio === null)
        return { kind: 'observe', reason: 'reading-unavailable' };
    if (!input.autoRotationEnabled)
        return { kind: 'none', reason: 'auto-rotation-disabled' };
    if (input.line.mode !== 'active') {
        return { kind: 'observe', reason: `rotation-line-${input.line.mode}:${input.line.reason ?? 'unknown'}` };
    }
    if (input.pendingRotation)
        return { kind: 'none', reason: 'rotation-in-flight' };
    // §23.2 第 1 条：撤回与轮换交错时旧摘要不能恢复已撤回结论，重算之前不再起新一轮。
    if (input.awaitingBriefRecompute === true)
        return { kind: 'observe', reason: AWAIT_BRIEF_RECOMPUTE };
    // §G1：这是"观测/拦截"而不是"不需要换"——压力依据可能成立，但原生 Team Lead 的自动轮换
    // 在身份迁移协议经真机验证前受限，优先原会话压缩（observe 留给状态页一个可读的原因）。
    if (input.leadProtected === true)
        return { kind: 'observe', reason: 'lead-rotation-restricted: 原生 Team Lead 的自动轮换在身份迁移协议经真机验证前受限，优先原会话压缩（§G1）' };
    if (!input.rotationBudgetLeft)
        return { kind: 'none', reason: 'rotation-insurance-exhausted' };
    if (input.turnsSinceLastRotation < input.minTurnsBetweenRotations) {
        return { kind: 'none', reason: `cooldown-${input.turnsSinceLastRotation}/${input.minTurnsBetweenRotations}` };
    }
    const ratio = input.occupancy.ratio;
    const absoluteDue = ratio >= input.line.T / input.line.window;
    const guardDue = ratio >= input.config.hardRatio;
    if (!absoluteDue && !guardDue)
        return { kind: 'none', reason: `below-threshold-${(ratio * 100).toFixed(1)}%` };
    if (!input.atSafeBoundary)
        return { kind: 'none', reason: 'pending-until-boundary' };
    return { kind: 'rotate', reason: 'pressure-boundary' };
}
/** 新会话入场占用必须低于阈值一半，否则判为上下文配置问题而不是继续换会话。 */
export function targetTooLarge(targetOccupancy, line) {
    if (line.mode !== 'active')
        return false;
    if (!targetOccupancy.known || targetOccupancy.ratio === null)
        return false;
    return targetOccupancy.ratio * line.window >= line.T * 0.5;
}
