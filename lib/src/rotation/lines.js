/**
 * 轮换线的计算（设计稿 v0.2 §10.1）。
 *
 * 与本机原生预算定义对齐：
 *   C = floor(min(r × W, W − R − H))        原生压缩实际生效线
 *   T = min(floor(p × W), C − M)            本插件希望早于压缩换会话
 * 取不到**同一模型、同一请求口径**的 W/R/H/r 时进入观察模式，原生压缩保持可用。
 *
 * `linesFor` 的 usable/hard 折算法来自 DS Bot（Apache-2.0，`src/host/steward.js`），
 * 改动：只保留窗口折算，判定比例改为本文件的比率口径。
 */
export const DEFAULT_WINDOW = 500_000;
/** 上下文尺寸在两次请求之间是估计值，硬线略低于模型实际可取。 */
const HARD_SHARE = 0.95;
function positive(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function ratio(value, upper) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= upper;
}
/** ds-bot 的窗口折算：可用量、硬线、按比例的判定线。 */
export function linesFor(window, reserve, checkRatio) {
    const declared = positive(window) ? window : DEFAULT_WINDOW;
    const room = positive(reserve) ? reserve : 0;
    const usable = Math.max(declared - room, Math.floor(declared / 2));
    const hard = Math.floor(usable * HARD_SHARE);
    const share = ratio(checkRatio, 0.999) ? checkRatio : 0.8;
    return { usable, hard, check: Math.min(Math.floor(usable * share), hard) };
}
/**
 * 计算 C 与 T。
 *
 * 三条 fail-closed 规则：
 * 1. 口径不全 ⇒ 观察模式（不猜测窗口）；
 * 2. T 非正 ⇒ 禁用自动轮换并给出原因，不用负阈值制造连续换会话；
 * 3. 完整启动请求 + 必要余量 ≥ T ⇒ 禁用（这是"新会话马上又超阈值"的根因判定）。
 */
export function rotationLine(input) {
    const window = input.contextWindow;
    const reserve = input.outputReserve;
    const headroom = input.compactionHeadroom;
    const ratio_ = input.compactionRatio;
    const margin = input.handoffMargin;
    const rotate = input.rotateRatio;
    if (!positive(window))
        return { mode: 'observation', reason: 'contextWindow 不可得或不为正', C: null, T: null };
    if (typeof reserve !== 'number' || !Number.isFinite(reserve) || reserve < 0) {
        return { mode: 'observation', reason: 'outputReserve 不可得', C: null, T: null };
    }
    if (!positive(headroom))
        return { mode: 'observation', reason: 'compactionHeadroom 不可得', C: null, T: null };
    if (!ratio(ratio_, 1))
        return { mode: 'observation', reason: 'compactionRatio 不可得或越界', C: null, T: null };
    if (!positive(margin))
        return { mode: 'observation', reason: 'handoffMargin 不可得', C: null, T: null };
    if (!ratio(rotate, 1))
        return { mode: 'observation', reason: 'rotateRatio 越界', C: null, T: null };
    const byRatio = Math.floor(ratio_ * window);
    const byHeadroom = Math.floor(window - reserve - headroom);
    const C = Math.floor(Math.min(byRatio, byHeadroom));
    const T = Math.min(Math.floor(rotate * window), C - margin);
    const { hard } = linesFor(window, reserve, ratio_);
    if (!Number.isFinite(C) || C <= 0)
        return { mode: 'disabled', reason: `压缩生效线 C=${C} 非正，窗口过小或预留过大`, C, T: null };
    if (!Number.isFinite(T) || T <= 0) {
        return { mode: 'disabled', reason: `轮换线 T=${T} 非正（C=${C}, M=${margin}）：不启用自动轮换`, C, T };
    }
    const startup = input.startupRequestTokens ?? 0;
    const slack = input.runtimeSlackTokens ?? 0;
    if (startup + slack >= T) {
        return { mode: 'disabled', reason: `完整启动请求 ${startup} + 运行余量 ${slack} 不小于 T=${T}：先缩小上下文方案`, C, T };
    }
    return { mode: 'active', reason: undefined, C, T, window, hard };
}
const UNKNOWN_OCCUPANCY = {
    known: false,
    ratio: null,
    ratioRaw: null,
    projectedTokens: null,
    pressureTokens: null,
    contextWindow: null,
    clampMismatch: false,
};
/**
 * 把 `contextPressure` 投影收敛成一次观测。
 *
 * 移植自 dsh-context-guard 的 `readOccupancy`（MIT）。三个官方字段是 **last-wins、不是原子观测**，
 * 切模型后会出现"新窗口配旧压力"，因此：分母缺失/非正 ⇒ 不判定；分子缺失/负 ⇒ 不判定；
 * 分子 > 分母 ⇒ 夹到 1.0，不产生 >100% 的荒谬提示。
 */
export function readOccupancy(pressure) {
    if (pressure === null || pressure === undefined || typeof pressure !== 'object')
        return UNKNOWN_OCCUPANCY;
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    const projected = num(pressure.projectedTokens);
    const window = num(pressure.contextWindow);
    const raw = num(pressure.pressureTokens);
    if (projected === null || projected < 0)
        return { ...UNKNOWN_OCCUPANCY, contextWindow: window, pressureTokens: raw };
    if (window === null || window <= 0)
        return { ...UNKNOWN_OCCUPANCY, projectedTokens: projected, pressureTokens: raw };
    const ratioRaw = projected / window;
    const clampMismatch = ratioRaw > 1;
    return {
        known: true,
        ratio: clampMismatch ? 1 : ratioRaw,
        ratioRaw,
        projectedTokens: projected,
        pressureTokens: raw,
        contextWindow: window,
        clampMismatch,
    };
}
