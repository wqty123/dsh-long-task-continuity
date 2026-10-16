/**
 * 软停与边界等待（适配自 `qingyou002/dsh-auto-handoff` 的 `graceful-stop.ts`，MIT；
 * 原文件逐字保存在 `vendor/graceful-stop.ts.orig`）。
 *
 * 两处适配：
 * 1. 类型改为本包自带的结构化声明，使内核在装载前就能独立编译与测试；
 * 2. latch 的键从 `sessionId` 扩成 `sessionId + attemptScope`，因为本框架按 Actor 轮换、
 *    同一会话可能承载多个 Mission 的守卫状态。
 *
 * 最关键的一条正确性事实来自原文件：`agent/pre-step` 返回 reject 会**丢弃该步已领取的消息**，
 * 所以人类提示必须优先于任何停止闸门——否则用户输入被吞。
 */
/** `user` = 浏览器/RPC 提交；`plugin` = 注入上下文；`goal` = 目标续跑轮；`model`/`tool` = 模型与工具流量。 */
export function isHumanPrompt(message) {
    return message.source?.kind === 'user';
}
export function carriesHumanPrompt(messages) {
    return messages.some((message) => isHumanPrompt(message));
}
export function decidePreStep(input) {
    const humanPrompt = carriesHumanPrompt(input.messages);
    if (!input.stopRequested)
        return { reject: false, humanPrompt, reason: 'latch-clear' };
    if (humanPrompt)
        return { reject: false, humanPrompt, reason: 'human-prompt' };
    return { reject: true, humanPrompt, reason: 'latch-held' };
}
export class StopLatch {
    held = new Set();
    hold(key) {
        this.held.add(key);
    }
    release(key) {
        this.held.delete(key);
    }
    isHeld(key) {
        return this.held.has(key);
    }
    heldKeys() {
        return [...this.held];
    }
    clear() {
        this.held.clear();
    }
    get size() {
        return this.held.size;
    }
}
/**
 * 双边界等待：`slowAfterMs` 只报状态（契约是"继续等，但告诉用户"），
 * `deadlineMs` 才是放弃的后停。`whenIdle()` 的 reject 同样视为边界——
 * 那表示没有后续工作，怎么处理失败轮由调用方决定。
 */
export async function waitForBoundary(agent, options) {
    const now = options.now ?? Date.now;
    const tickMs = options.tickMs ?? 250;
    const started = now();
    let slowReported = false;
    const idle = agent.whenIdle().then(() => 'boundary', () => 'boundary');
    const aborted = options.signal === undefined ? undefined : cancellation(options.signal);
    for (;;) {
        const racers = [idle, delay(tickMs).then(() => 'tick')];
        if (aborted !== undefined)
            racers.push(aborted);
        const winner = await Promise.race(racers);
        if (winner === 'boundary')
            return 'boundary';
        if (winner === 'cancelled')
            return 'cancelled';
        const elapsed = now() - started;
        if (options.signal?.aborted)
            return 'cancelled';
        if (options.isCancelled())
            return 'cancelled';
        if (elapsed >= options.deadlineMs)
            return 'deadline';
        if (!slowReported && elapsed >= options.slowAfterMs) {
            slowReported = true;
            options.onSlow(elapsed);
        }
    }
}
function delay(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        // 轮询一个闩不该把进程留住。
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
            ;
            timer.unref();
        }
    });
}
function cancellation(signal) {
    if (signal.aborted)
        return Promise.resolve('cancelled');
    return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
    });
}
/** 有界等待会话可见：不引入 cron，不做无限轮询（移植自 auto-handoff 的 `waitForSession`）。 */
export async function waitForSession(id, has, attempts = 40, tickMs = 25) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (has(id))
            return true;
        await delay(tickMs);
    }
    return has(id);
}
