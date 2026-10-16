import { ATTEMPT_TERMINAL, LEASE_EXPIRY_MS } from './entities.js';
export function isTerminalAttempt(status) {
    return ATTEMPT_TERMINAL.includes(status);
}
export function leaseVerdict(attempt, expectedVersion, now) {
    if (isTerminalAttempt(attempt.status))
        return 'terminal';
    if (attempt.leaseVersion !== expectedVersion)
        return 'superseded';
    if (now > attempt.leaseExpiresAt)
        return 'expired_needs_reconcile';
    return 'valid';
}
/** 旧执行者的迟到结果：可保存为待审证据，不能覆盖当前状态。 */
export function acceptsStateWrite(attempt, expectedVersion, now) {
    return leaseVerdict(attempt, expectedVersion, now) === 'valid';
}
/**
 * 租约时长口径：调用方（宿主入口）传设置值，没传或非法才回落到内核常量。
 * 签发与续租必须同源——只改一边的话，"过期毫秒"设置项就只是一个装饰品，
 * 同一张票据会在两处判据下得到不同结论（审阅 R8）。
 */
export function leaseDuration(declared) {
    return declared !== undefined && Number.isSafeInteger(declared) && declared > 0 ? declared : LEASE_EXPIRY_MS;
}
export function openLease(attempt, now, leaseMs) {
    return {
        ...attempt,
        status: 'running',
        leaseExpiresAt: now + leaseDuration(leaseMs),
        lastHeartbeatAt: now,
        updatedAt: now,
    };
}
export function heartbeat(attempt, now, leaseMs) {
    return { ...attempt, lastHeartbeatAt: now, leaseExpiresAt: now + leaseDuration(leaseMs), updatedAt: now };
}
/**
 * 依赖是否满足（v0.3 §6.2）：所需结果**已验收**（completed）**且当前有效性为 current**。
 * `submitted`/`verifying` 还没验收；`needs_review`/`invalid` 是依据被撤回后的历史完成，
 * 保留事件但不能继续支撑下游执行资格。依赖图是否有环另由 `findCycle` 在建任务时检查。
 */
export function dependenciesSatisfied(task, tasks) {
    return task.dependsOn.every((depId) => {
        const dep = tasks[depId];
        return dep !== undefined && dep.status === 'completed' && dep.validity === 'current';
    });
}
export function findCycle(tasks, candidate) {
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    byId.set(candidate.taskId, candidate);
    const path = [];
    const state = new Map();
    const walk = (id) => {
        const node = byId.get(id);
        if (node === undefined)
            return undefined;
        const mark = state.get(id);
        if (mark === 'visiting')
            return [...path.slice(path.indexOf(id)), id];
        if (mark === 'done')
            return undefined;
        state.set(id, 'visiting');
        path.push(id);
        for (const dep of node.dependsOn) {
            const found = walk(dep);
            if (found !== undefined)
                return found;
        }
        path.pop();
        state.set(id, 'done');
        return undefined;
    };
    return walk(candidate.taskId) ?? [];
}
