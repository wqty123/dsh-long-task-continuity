/**
 * 执行权（租约）判定（设计稿 v0.3 §6.2、§6.3）。
 *
 * 关键语义：**过期只触发核对，不证明旧进程已停**。旧终端、外部请求或子代理可能仍在运行，
 * 因此确认停止 / 隔离 / 完成外部核对之前，不允许建立冲突的新 Attempt。
 */
import type { Attempt, AttemptStatus, Task } from './entities.ts'
import { ATTEMPT_TERMINAL, LEASE_EXPIRY_MS } from './entities.ts'

export type LeaseVerdict = 'valid' | 'expired_needs_reconcile' | 'terminal' | 'superseded'

export function isTerminalAttempt(status: AttemptStatus): boolean {
  return ATTEMPT_TERMINAL.includes(status)
}

export function leaseVerdict(attempt: Attempt, expectedVersion: number, now: number): LeaseVerdict {
  if (isTerminalAttempt(attempt.status)) return 'terminal'
  if (attempt.leaseVersion !== expectedVersion) return 'superseded'
  if (now > attempt.leaseExpiresAt) return 'expired_needs_reconcile'
  return 'valid'
}

/** 旧执行者的迟到结果：可保存为待审证据，不能覆盖当前状态。 */
export function acceptsStateWrite(attempt: Attempt, expectedVersion: number, now: number): boolean {
  return leaseVerdict(attempt, expectedVersion, now) === 'valid'
}

/**
 * 租约时长口径：调用方（宿主入口）传设置值，没传或非法才回落到内核常量。
 * 签发与续租必须同源——只改一边的话，"过期毫秒"设置项就只是一个装饰品，
 * 同一张票据会在两处判据下得到不同结论（审阅 R8）。
 */
export function leaseDuration(declared: number | undefined): number {
  return declared !== undefined && Number.isSafeInteger(declared) && declared > 0 ? declared : LEASE_EXPIRY_MS
}

export function openLease(attempt: Attempt, now: number, leaseMs?: number): Attempt {
  return {
    ...attempt,
    status: 'running',
    leaseExpiresAt: now + leaseDuration(leaseMs),
    lastHeartbeatAt: now,
    updatedAt: now,
  }
}

export function heartbeat(attempt: Attempt, now: number, leaseMs?: number): Attempt {
  return { ...attempt, lastHeartbeatAt: now, leaseExpiresAt: now + leaseDuration(leaseMs), updatedAt: now }
}

/**
 * 依赖是否满足（v0.3 §6.2）：所需结果**已验收**（completed）**且当前有效性为 current**。
 * `submitted`/`verifying` 还没验收；`needs_review`/`invalid` 是依据被撤回后的历史完成，
 * 保留事件但不能继续支撑下游执行资格。依赖图是否有环另由 `findCycle` 在建任务时检查。
 */
export function dependenciesSatisfied(task: Task, tasks: Readonly<Record<string, Task>>): boolean {
  return task.dependsOn.every((depId) => {
    const dep = tasks[depId]
    return dep !== undefined && dep.status === 'completed' && dep.validity === 'current'
  })
}

export function findCycle(tasks: readonly Task[], candidate: Task): readonly string[] {
  const byId = new Map<string, Task>(tasks.map((task) => [task.taskId, task]))
  byId.set(candidate.taskId, candidate)
  const path: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const walk = (id: string): readonly string[] | undefined => {
    const node = byId.get(id)
    if (node === undefined) return undefined
    const mark = state.get(id)
    if (mark === 'visiting') return [...path.slice(path.indexOf(id)), id]
    if (mark === 'done') return undefined
    state.set(id, 'visiting')
    path.push(id)
    for (const dep of node.dependsOn) {
      const found = walk(dep)
      if (found !== undefined) return found
    }
    path.pop()
    state.set(id, 'done')
    return undefined
  }
  return walk(candidate.taskId) ?? []
}
