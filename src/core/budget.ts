/**
 * 预算：执行前预留、结束后按回执结算（设计稿 v0.3 §13、§15.1、§22.15）。
 *
 * 新建会话或原生 goal 不重置总账；崩溃后未结算的预留先核对，回执不确定时**不**退回可用余额。
 * 轮换频率保险按 **每 Actor 每小时**计算（放在 Actor 上），整个 Mission 不设"一生只能换 N 次"。
 * 治理开销（检查/审计/协调）计在同一本总账上但仍单列，否则规则执行能把本体工作吃光（§22.15）。
 */
import type { Actor, BudgetLedger } from './entities.ts'
import type { MissionControl } from './control.ts'

export interface Reservation {
  readonly tokens: number
  readonly calls: number
}

/** 本体工作的 token 消耗；治理开销不含在内，两栏分列才看得出钱花在哪。 */
export function consumedTokens(budget: BudgetLedger): number {
  return budget.inputTokens + budget.outputTokens + budget.cacheReadTokens
}

/** 池子里真正被占用的量：本体 + 治理。治理也花的是 Mission 总账（§22.15）。 */
function poolTokens(budget: BudgetLedger): number {
  return consumedTokens(budget) + budget.governanceTokens
}

function poolCalls(budget: BudgetLedger): number {
  return budget.modelCalls + budget.governanceCalls
}

export function reservedTokens(budget: BudgetLedger): number {
  return budget.reservations.reduce((sum, item) => sum + item.tokens, 0)
}

export function reservedCalls(budget: BudgetLedger): number {
  return budget.reservations.reduce((sum, item) => sum + item.calls, 0)
}

export type BudgetDim = 'tokens' | 'calls' | 'retries' | 'mailbox'

export interface BudgetAvailability {
  readonly tokensAvailable: number
  readonly callsAvailable: number
  readonly retryAvailable: number
  readonly mailboxAvailable: number
  readonly blockedBy: readonly BudgetDim[]
}

export function availability(state: MissionControl): BudgetAvailability {
  const limits = state.budgetLimits
  const { budget } = state
  const blockedBy: BudgetDim[] = []
  const tokensAvailable = Math.max(0, limits.maxTotalTokens - poolTokens(budget) - reservedTokens(budget))
  const callsAvailable = Math.max(0, limits.maxModelCalls - poolCalls(budget) - reservedCalls(budget))
  const retryAvailable = Math.max(0, limits.maxTaskRetries - budget.taskRetries)
  const mailboxAvailable = Math.max(0, limits.maxMailboxMessages - budget.mailboxMessages)
  if (limits.maxTotalTokens - poolTokens(budget) - reservedTokens(budget) <= 0) blockedBy.push('tokens')
  if (limits.maxModelCalls - poolCalls(budget) - reservedCalls(budget) <= 0) blockedBy.push('calls')
  if (retryAvailable <= 0) blockedBy.push('retries')
  if (mailboxAvailable <= 0) blockedBy.push('mailbox')
  return { tokensAvailable, callsAvailable, retryAvailable, mailboxAvailable, blockedBy }
}

/** 治理开销占总 token 的比例，供视图与防空转判定（§22.15：审计比本体工作还多就是信号）。 */
export function governanceShare(state: MissionControl): number {
  const total = poolTokens(state.budget)
  return total === 0 ? 0 : state.budget.governanceTokens / total
}

export function canReserve(state: MissionControl, want: Reservation): boolean {
  const pool = availability(state)
  return want.tokens <= pool.tokensAvailable && want.calls <= pool.callsAvailable
}

/** 预留失败即返回原因，调用方据此让任务等待预算，而不是先放行再超支。 */
export function reserve(
  budget: BudgetLedger,
  limits: MissionControl['budgetLimits'],
  operationId: string,
  want: Reservation,
  now: number,
): { readonly ok: boolean; readonly budget: BudgetLedger; readonly reason?: string } {
  if (!Number.isSafeInteger(want.tokens) || want.tokens < 0) return { ok: false, budget, reason: 'malformed token reservation' }
  if (!Number.isSafeInteger(want.calls) || want.calls < 0) return { ok: false, budget, reason: 'malformed call reservation' }
  // 与 `availability()` 用同一口径，否则会出现"闸门说够、记账说不够"的两种答案。
  const freeTokens = limits.maxTotalTokens - poolTokens(budget) - reservedTokens(budget)
  const freeCalls = limits.maxModelCalls - poolCalls(budget) - reservedCalls(budget)
  if (want.tokens > freeTokens) return { ok: false, budget, reason: `token pool short by ${want.tokens - freeTokens}` }
  if (want.calls > freeCalls) return { ok: false, budget, reason: `call pool short by ${want.calls - freeCalls}` }
  return {
    ok: true,
    budget: {
      ...budget,
      reservations: [...budget.reservations, { operationId, tokens: want.tokens, calls: want.calls, reservedAt: now }],
    },
  }
}

/** 结算：按回执实际量入账，并移除该操作的预留。回执不确定的操作不调用本函数。 */
export function settle(
  budget: BudgetLedger,
  operationId: string,
  actual: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly calls: number },
): BudgetLedger {
  return {
    ...budget,
    modelCalls: budget.modelCalls + actual.calls,
    inputTokens: budget.inputTokens + actual.inputTokens,
    outputTokens: budget.outputTokens + actual.outputTokens,
    cacheReadTokens: budget.cacheReadTokens + actual.cacheReadTokens,
    reservations: budget.reservations.filter((item) => item.operationId !== operationId),
  }
}

/** 无回执时保留预留进入核对态；只有核对确认"未发生"才释放。 */
export function releaseReservation(budget: BudgetLedger, operationId: string, confirmedNotExecuted: boolean): BudgetLedger {
  if (!confirmedNotExecuted) return budget
  return { ...budget, reservations: budget.reservations.filter((item) => item.operationId !== operationId) }
}

/**
 * 记一笔治理开销：检查、审计、协调、轮末守卫这些不产出业务进展的消耗（§22.15）。
 *
 * 纯函数，返回新账本。负数与 NaN 一律按 0 处理——计数器被写成负数会把已有开销抹掉，
 * 而"治理花了多少"正是判断规则是否膨胀的唯一依据。
 */
export function noteGovernance(
  budget: BudgetLedger,
  delta: { readonly calls: number; readonly tokens: number; readonly wallClockMs: number },
): BudgetLedger {
  const positive = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0)
  return {
    ...budget,
    governanceCalls: budget.governanceCalls + positive(delta.calls),
    governanceTokens: budget.governanceTokens + positive(delta.tokens),
    governanceWallClockMs: budget.governanceWallClockMs + positive(delta.wallClockMs),
  }
}

export const ROTATION_WINDOW_MS = 60 * 60 * 1000

/** 该 Actor 最近一小时的轮换时刻（滚动窗口，非一生计数）。 */
export function recentRotations(actor: Actor, now: number): number[] {
  const cutoff = now - ROTATION_WINDOW_MS
  return actor.rotationsLastHour.filter((at) => at >= cutoff)
}

export function canRotate(actor: Actor, now: number, limitPerHour: number): { readonly ok: boolean; readonly reason?: string } {
  if (actor.retired) return { ok: false, reason: 'actor-retired' }
  if (!actor.available) return { ok: false, reason: 'actor-unavailable' }
  if (recentRotations(actor, now).length >= limitPerHour) return { ok: false, reason: 'rotation-insurance-exhausted' }
  return { ok: true }
}

export function noteRotation(actor: Actor, now: number): Actor {
  return { ...actor, rotationsLastHour: recentRotations(actor, now).concat(now), updatedAt: now }
}

/** 进展度量：验收项、已解决阻塞、有据决策变化才算；消息数与新增文字不算（§13）。 */
export interface ProgressSample {
  readonly completedCriteria: number
  readonly resolvedBlockers: number
  readonly evidencedDecisions: number
}

export function hasProgress(sample: ProgressSample): boolean {
  return sample.completedCriteria + sample.resolvedBlockers + sample.evidencedDecisions > 0
}
