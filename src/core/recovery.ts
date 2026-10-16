/**
 * 崩溃恢复（设计稿 v0.3 §11.1、§11.2，核对面按 §10.3/§22.6/§22.14 补齐）。
 *
 * 顺序是硬要求：先拿独占权、再关入场、再核对、最后才放行明确可恢复的 Mission。
 * 用户此前暂停/取消/预算耗尽/待审批的任务，不因 Host 重启而重新启动。
 * v0.3 §11.1 第 3/7 步还要核对轮换携带的依据版本是否落后、纠正传播是否闭环、
 * 交付链是否停在未收件/未路由、承诺责任人是否已退役/休眠、票据是否仍引用失效授权——
 * 这些项状态不明确，默认阻止自动放行，只进 hold 名单展示待处理原因。
 */
import type { ControlStore } from './store.ts'
import type { MissionControl } from './control.ts'
import { availability } from './budget.ts'
import { isTerminalAttempt } from './lease.ts'

export interface RecoveryReport {
  readonly missionId: string
  readonly revision: number
  readonly blockers: readonly string[]
  readonly inFlightOperations: readonly string[]
  readonly openRotations: readonly { readonly rotationId: string; readonly phase: string; readonly nextReconcileAction?: string }[]
  readonly staleAttempts: readonly string[]
  readonly outboxBacklog: number
  readonly autoResumeAllowed: boolean
  readonly readyForAdmission: boolean
}

export function classifyOperations(state: MissionControl): { readonly kind: string; readonly action: 'retry' | 'reconcile' | 'await' }[] {
  const plan: { kind: string; action: 'retry' | 'reconcile' | 'await' }[] = []
  for (const op of Object.values(state.operations)) {
    if (op.status === 'succeeded' || op.status === 'failed') continue
    if (op.status === 'outcome_unknown') {
      plan.push({ kind: op.kind, action: 'reconcile' })
      continue
    }
    if (op.status === 'intent' && op.retryable) {
      plan.push({ kind: op.kind, action: 'retry' })
      continue
    }
    if (op.reconcileMethod !== undefined) {
      plan.push({ kind: op.kind, action: 'reconcile' })
      continue
    }
    plan.push({ kind: op.kind, action: 'await' })
  }
  return plan
}

/** 纯函数：把控制记录读成一份恢复结论，不产生任何副作用。 */
export function assess(state: MissionControl, now: number): RecoveryReport {
  const blockers: string[] = []
  const status = state.mission.status
  if (status === 'paused') blockers.push('用户暂停，需显式恢复')
  if (status === 'cancelled') blockers.push('任务已取消，不复活；需要重开请建新 Mission')
  if (status === 'completed' || status === 'failed') blockers.push(`Mission 处于终态 ${status}`)
  if (availability(state).blockedBy.length > 0) blockers.push(`预算受阻：${availability(state).blockedBy.join('/')}`)
  const unknown = Object.values(state.operations).filter((op) => op.status === 'outcome_unknown')
  if (unknown.length > 0) blockers.push(`${unknown.length} 项外部操作结果不确定，先核对`)
  const openRotations = Object.values(state.rotations)
    .filter((rotation) => rotation.phase !== 'ACTIVE')
    .map((rotation) => ({ rotationId: rotation.rotationId, phase: rotation.phase, nextReconcileAction: rotation.nextReconcileAction }))
  if (openRotations.length > 0) blockers.push(`${openRotations.length} 个轮换未收束`)
  const unacked = Object.values(state.mailbox).filter((message) => message.state === 'pending' && message.attempts >= 3)
  if (unacked.length > 0) blockers.push(`${unacked.length} 条消息投递失败，转待处理队列`)
  const staleAttempts = Object.values(state.attempts)
    .filter((attempt) => !isTerminalAttempt(attempt.status) && attempt.leaseExpiresAt < now)
    .map((attempt) => attempt.attemptId)

  // §10.3/§23.2 第 1 条：轮换携带的依据版本落后于当前记录，说明交接包之后有新反证，
  // 必须先重验依据再放行，不能只恢复旧摘要里的文字结论。
  for (const rotation of Object.values(state.rotations)) {
    if (rotation.phase === 'ACTIVE') continue
    if (rotation.basisRevisionAtRequest < state.basisRevision) {
      blockers.push(
        `轮换 ${rotation.rotationId} 停在 ${rotation.phase}，携带 basisRevision ${rotation.basisRevisionAtRequest} 落后于当前 ${state.basisRevision}：先重验依据再放行`,
      )
    }
  }

  // §22.6/§23.2 第 3 条：纠正传播未闭环时旧票据仍可能被用于发布，不放行。
  if (state.pendingPropagations.length > 0) {
    blockers.push(`依据撤回传播未闭环：${state.pendingPropagations.length} 项待复核（首项 ${state.pendingPropagations[0]?.propagationId ?? '未编号'}）`)
  }

  // §22.14：投递成功 ≠ 对方已处理；dispatched/unrouted 说明交付链未闭合。
  const dispatched = Object.values(state.deliveries).filter((delivery) => delivery.stage === 'dispatched')
  const unrouted = Object.values(state.deliveries).filter((delivery) => delivery.stage === 'unrouted')
  if (dispatched.length > 0) blockers.push(`交付链 ${dispatched.length} 项已投递未确认收件/处理（首项 ${dispatched[0]?.deliveryId ?? '未编号'}）：下游不得视为已完成`)
  if (unrouted.length > 0) blockers.push(`交付链 ${unrouted.length} 项未路由（无可用收件人，首项 ${unrouted[0]?.deliveryId ?? '未编号'}）：需显式指派`)

  // §22.7：blocked/proposed 承诺的责任人已退役/休眠（或不在记录中），恢复后无人接手。
  const stranded = Object.values(state.obligations).filter((obligation) => {
    if (obligation.stage !== 'blocked' && obligation.stage !== 'proposed') return false
    const owner = state.actors[obligation.ownerActorId]
    return owner === undefined || owner.retired || owner.dormant
  })
  if (stranded.length > 0) {
    blockers.push(`${stranded.length} 项承诺停在 blocked/proposed 且责任人已退役/休眠（首项 ${stranded[0]?.obligationId ?? '未编号'}）：需重新指派`)
  }

  // §12.2/§22.8：仍被在途票据引用的授权过期/撤销——旧票据继续放行就是拿失效授权执行。
  const ticketedGrantIds = new Set<string>()
  for (const attempt of Object.values(state.attempts)) {
    const ticket = attempt.ticket
    if (ticket === undefined) continue
    for (const grantId of ticket.grantIds) ticketedGrantIds.add(grantId)
  }
  const deadGrants: string[] = []
  for (const grant of Object.values(state.grants)) {
    if (!ticketedGrantIds.has(grant.grantId)) continue
    if (grant.revokedAt !== undefined) deadGrants.push(`${grant.grantId}=已撤销`)
    else if (grant.expiresAt !== undefined && now > grant.expiresAt) deadGrants.push(`${grant.grantId}=已过期`)
  }
  if (deadGrants.length > 0) blockers.push(`${deadGrants.length} 个过期/已撤销授权仍被票据引用（${deadGrants.join(', ')}）：重发票据前不放行`)

  return {
    missionId: state.missionId,
    revision: state.revision,
    blockers,
    inFlightOperations: classifyOperations(state).map((item) => `${item.kind}:${item.action}`),
    openRotations,
    staleAttempts,
    outboxBacklog: Object.values(state.outbox).filter((entry) => entry.completedAt === undefined).length,
    // 新增核对项都进 blockers，因此默认阻止自动放行；仅状态明确且允许自动恢复的才 admit（§11.1 第 7 步）。
    autoResumeAllowed: state.mission.allowAutoResume && status === 'active' && blockers.length === 0,
    readyForAdmission: status === 'active' || status === 'waiting',
  }
}

export interface BootPlan {
  readonly reports: readonly RecoveryReport[]
  readonly admit: readonly string[]
  readonly hold: readonly { readonly missionId: string; readonly why: readonly string[] }[]
}

/**
 * 启动恢复：加载全部控制记录并给出准入名单。
 *
 * 重建完成前不放行调度（§5.2 末句），因此这一步的产物是"能不能开始干活"的唯一依据。
 */
export async function bootRecover(store: ControlStore, now: number): Promise<BootPlan> {
  const ids = await store.list()
  const reports: RecoveryReport[] = []
  for (const missionId of ids) {
    const state = await store.load(missionId)
    if (state === null) continue
    reports.push(assess(state, now))
  }
  const admit = reports.filter((report) => report.autoResumeAllowed).map((report) => report.missionId)
  const hold = reports
    .filter((report) => !report.autoResumeAllowed)
    .map((report) => ({ missionId: report.missionId, why: report.blockers }))
  return { reports, admit, hold }
}
