/**
 * §23.2 八条组合场景：把纪律回归集（§23.1 逐条正反例）串成"撤回⁄轮换⁄授权⁄交付交错"的端到端路径。
 *
 * 每条用例都只做两件事：按真实命令链推进状态，断言设计稿点名的处置结果。
 * 不另造判定层——"什么算通过"一律现场调用 `src/core/*` 与 `src/rotation/*` 的导出函数。
 * 若内核在这条链上漏了一格守卫，用例就让它红，并在断言消息里写清应当停在哪一步。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import type { CommandContext, ReviewInput, ValidatorInput } from '../src/core/commands.ts'
import type { MissionControl } from '../src/core/control.ts'
import type { ArtifactVersion } from '../src/core/entities.ts'
import { criteriaReport, deliveryIsProcessed } from '../src/core/discipline.ts'
import { missionCompletion } from '../src/core/completion.ts'
import { MemoryStore } from '../src/core/store.ts'
import { reverifyHandoffPackage } from '../src/rotation/fsm.ts'
import { renderDisciplineMarkdown } from '../src/views/export.ts'
import {
  actorCtx,
  addedKey,
  apply,
  approveTask,
  artifactThroughAcceptance,
  asLead,
  asMember,
  claimTask,
  claimTaskAs,
  checkpointTaskAs,
  continuityCheckpoint,
  crew,
  ctx,
  dependencyInput,
  issueGrant,
  must,
  NOW,
  of,
  proposeClaim,
  proposeTask,
  readyTask,
  recordEvidence,
  recordSearch,
  registerActor,
  registerArtifact,
  registerDependency,
  req,
  refused,
  reviewInput,
  submitTaskAs,
  validatorInput,
  verifyTask,
  withClaimedTask,
} from './discipline-fixtures.ts'

const USER = ctx('user', 'human')
const SUPERVISOR = ctx('supervisor', 'supervisor-1')
const LEAD = actorCtx(asLead())
const MEMBER = actorCtx(asMember())
const SUBAGENT = actorCtx(of('sub-1', 'subagent', 'sess-3'))
const REVIEWER = actorCtx(of('review-1', 'reviewer', 'sess-4'))
const REVIEWER2 = actorCtx(of('review-2', 'reviewer', 'sess-6'))

/** 仍在积压（没有 completedAt）的 outbox 条目 id。 */
function pendingOutbox(state: MissionControl): string[] {
  return Object.values(state.outbox)
    .filter((entry) => entry.completedAt === undefined)
    .map((entry) => entry.outboxId)
}

function headOf(state: MissionControl, uri: string): ArtifactVersion {
  const group = state.artifacts[uri] ?? []
  const head = group[group.length - 1]
  if (head === undefined) throw new Error(`夹具：${uri} 没有登记版本`)
  return head
}

function recordReview(state: MissionControl, review: ReviewInput, context: CommandContext): { readonly state: MissionControl; readonly reviewId: string } {
  const before = state.reviews
  const next = apply(state, { kind: 'review.record', requestId: req(), review }, context)
  return { state: next, reviewId: addedKey(before, next.reviews) }
}

function qualifyValidator(state: MissionControl, validator: ValidatorInput): { readonly state: MissionControl; readonly validatorId: string } {
  const before = state.validators
  const next = apply(state, { kind: 'validator.qualify', requestId: req(), validator, eligible: true, reason: '有效样例与已知反例齐备，范围明确' }, LEAD)
  return { state: next, validatorId: addedKey(before, next.validators) }
}

test('S1 撤回与轮换交错：提交点拒绝旧交接包，恢复后重发新包，旧票据不能提交', () => {
  const base = withClaimedTask()
  let state = base.state
  // 轮换检查点与请求（manual 触发，S1=sess-1 → S2=sess-9）。
  const beforeCp = state.checkpoints
  state = apply(state, { kind: 'continuity.checkpoint', requestId: req(), checkpoint: continuityCheckpoint('lead-1', base.taskId, { attemptId: base.attemptId }) }, LEAD)
  const checkpointId = addedKey(beforeCp, state.checkpoints)
  const beforeRot = state.rotations
  state = apply(state, { kind: 'continuity.requestRotation', requestId: req(), actorId: 'lead-1', sourceSessionId: 'sess-1', targetSessionId: 'sess-9', checkpointId, trigger: 'manual', seedMessageId: 'msg-seed-1' }, LEAD)
  const rotationId = addedKey(beforeRot, state.rotations)
  // 请求时刻的交接包自洽：这是后面"变了"的对照基线。
  assert.equal(reverifyHandoffPackage(must('rotation', state.rotations[rotationId]), state).ready, true, '请求时交接包应自洽')
  for (const phase of ['QUIESCING', 'PREPARED', 'TARGET_READY'] as const) {
    state = apply(state, { kind: 'continuity.advanceRotation', requestId: req(), rotationId, phase }, SUPERVISOR)
  }
  // 提交点之前出现新反证：结论被撤回，依据有效性版本递增。
  const proposed = proposeClaim(state, { proposition: '交接包里的实现路径仍然可用' })
  const retracted = apply(proposed.state, { kind: 'claim.revise', requestId: req(), claimId: proposed.claimId, status: 'unsupported', retractionReason: '复跑出现相反读数，原结论不成立' }, LEAD)
  assert.equal(retracted.basisRevision, state.basisRevision + 1, '撤回必须递增依据有效性版本')
  const stale = reverifyHandoffPackage(must('rotation', retracted.rotations[rotationId]), retracted)
  assert.equal(stale.ready, false, '依据已推进，旧包不再算数')
  assert.equal(stale.pending, true, '等待重算而不是放弃轮换')
  assert.match(stale.missing.join('；'), /依据有效性版本/, '诊断要说清是哪一类版本漂移')
  // S2 放行（COMMITTED）由提交点自身的闸门拒绝：旧摘要不能把已撤回结论带进新会话。
  refused(retracted, { kind: 'continuity.advanceRotation', requestId: req(), rotationId, phase: 'COMMITTED' }, SUPERVISOR, '提交点应拒绝携带旧依据的交接包')
  assert.equal(must('lead', retracted.actors['lead-1']).sessionId, 'sess-1', '被拒的提交不改换绑')
  assert.equal(must('lead', retracted.actors['lead-1']).bindingVersion, 1, '被拒的提交不推进绑定版本')
  assert.equal(must('rotation', retracted.rotations[rotationId]).phase, 'TARGET_READY', '轮换停在提交点之前，事实保留')
  assert.equal(must('attempt', retracted.attempts[base.attemptId]).leaseVersion, 1, '在途尝试保留原租约')
  // 显式裁定保留原会话：回退不走隐式路径。
  const resolved = apply(retracted, { kind: 'continuity.resolveUnknown', requestId: req(), rotationId, decision: 'keep_source' }, USER)
  assert.equal(must('rotation', resolved.rotations[rotationId]).phase, 'WAITING_RECOVERY')
  assert.equal(must('lead', resolved.actors['lead-1']).sessionId, 'sess-1')
  assert.equal(must('lead', resolved.actors['lead-1']).bindingVersion, 2, '恢复动作本身也是一次绑定转换')
  // 按当前依据版本重建交接包，再走一次完整轮换。
  const beforeCp2 = resolved.checkpoints
  const reseeded = apply(resolved, { kind: 'continuity.checkpoint', requestId: req(), checkpoint: continuityCheckpoint('lead-1', base.taskId, { attemptId: base.attemptId }) }, LEAD)
  const checkpointId2 = addedKey(beforeCp2, reseeded.checkpoints)
  const beforeRot2 = reseeded.rotations
  const requested2 = apply(reseeded, { kind: 'continuity.requestRotation', requestId: req(), actorId: 'lead-1', sourceSessionId: 'sess-1', targetSessionId: 'sess-8', checkpointId: checkpointId2, trigger: 'manual', seedMessageId: 'msg-seed-2' }, LEAD)
  const rotationId2 = addedKey(beforeRot2, requested2.rotations)
  assert.equal(must('rotation2', requested2.rotations[rotationId2]).basisRevisionAtRequest, requested2.basisRevision, '新包冻结的是当前依据版本')
  assert.equal(reverifyHandoffPackage(must('rotation2', requested2.rotations[rotationId2]), requested2).ready, true)
  let committed = requested2
  for (const phase of ['QUIESCING', 'PREPARED', 'TARGET_READY', 'COMMITTED'] as const) {
    committed = apply(committed, { kind: 'continuity.advanceRotation', requestId: req(), rotationId: rotationId2, phase }, SUPERVISOR)
  }
  assert.equal(must('rotation2', committed.rotations[rotationId2]).phase, 'COMMITTED')
  assert.equal(must('lead', committed.actors['lead-1']).sessionId, 'sess-8', '提交点换绑到 S2')
  assert.equal(must('lead', committed.actors['lead-1']).bindingVersion, 3)
  assert.equal(must('attempt', committed.attempts[base.attemptId]).sessionId, 'sess-8', '在途事实被携带进 S2')
  assert.equal(must('attempt', committed.attempts[base.attemptId]).leaseVersion, 2, '携带即换租约版本')
  assert.equal(Object.values(committed.outbox).some((entry) => entry.kind === 'rotation.seed'), true, '提交点同批写入播种投递')
  // 换绑后的新会话不能拿旧票据提交：票据绑定的依据版本已不是当前值。
  refused(committed, { kind: 'task.submit', requestId: req(), taskId: base.taskId, leaseVersion: 2 }, actorCtx(of('lead-1', 'lead', 'sess-8')), '携带旧依据版本的票据不许提交')
})

test('S2 子代理质疑主代理：受影响任务停住、无关任务继续、裁定后修订恢复', () => {
  const crewed = crew().state
  const affected = readyTask(crewed, { title: '受影响任务' })
  const unrelated = readyTask(affected.state, { title: '无关任务' })
  let state = unrelated.state
  // 子代理登记反证并提起结构化硬冲突质疑。
  const evidence = recordEvidence(state, { summary: '复跑得到与判据互斥的结论' }, SUBAGENT)
  const beforeChl = evidence.state.challenges
  state = apply(evidence.state, {
    kind: 'challenge.raise',
    requestId: req(),
    targetKind: 'task',
    targetId: affected.taskId,
    targetRevision: 1,
    quotedText: '同一条判据推出两个互斥结论',
    contradictingEvidenceIds: [evidence.evidenceId],
    affectedActionIds: [affected.taskId],
    adjudicatorActorId: 'review-1',
    severity: 'hard_conflict',
  }, SUBAGENT)
  const challengeId = addedKey(beforeChl, state.challenges)
  assert.equal(must('challenge', state.challenges[challengeId]).severity, 'hard_conflict', '带反证的硬冲突不降级')
  assert.equal(must('challenge', state.challenges[challengeId]).outcome, 'open')
  // 受影响任务停住：未裁定硬冲突挡住认领。
  refused(state, claimTask(affected.taskId), MEMBER, '未裁定硬冲突下不许认领受影响任务')
  // 无关任务照常推进：质疑不停掉整个团队。
  const moved = claimTaskAs(state, unrelated.taskId, asMember())
  state = checkpointTaskAs(moved.state, unrelated.taskId, asMember())
  state = submitTaskAs(state, unrelated.taskId, asMember())
  assert.equal(must('unrelated', state.tasks[unrelated.taskId]).status, 'submitted', '无关任务应能走到已提交')
  // 有权角色裁定冲突成立：依据有效性版本递增。
  const beforeBasis = state.basisRevision
  state = apply(state, { kind: 'challenge.resolve', requestId: req(), challengeId, outcome: 'upheld', resolution: '两条结论确实互斥，原判据需修订' }, USER)
  assert.equal(state.basisRevision, beforeBasis + 1)
  assert.equal(must('challenge', state.challenges[challengeId]).outcome, 'upheld')
  // Lead 修订任务书（新判据版本）：受影响任务重新可认领，新票据带当前版本。
  state = apply(state, { kind: 'task.revise', requestId: req(), taskId: affected.taskId, criteria: [{ text: '按裁定口径重新推导结论' }], reason: '冲突裁定后修订判据' }, LEAD)
  assert.equal(must('affected', state.tasks[affected.taskId]).criteriaRevision, 2)
  const reclaimed = claimTaskAs(state, affected.taskId, asMember())
  state = reclaimed.state
  const ticket = must('ticket', must('attempt', state.attempts[reclaimed.attemptId]).ticket)
  assert.equal(ticket.criteriaRevision, 2, '新票据按修订后的判据版本签发')
  assert.equal(ticket.basisRevision, state.basisRevision, '新票据带当前依据版本')
  assert.equal(must('affected', state.tasks[affected.taskId]).status, 'leased', '修订后恢复执行资格')
})

test('S3 修订传播中崩溃：工作项存活于持久记录，重启后继续传播，旧发布始终无效', async () => {
  const accepted = artifactThroughAcceptance(crew().state, asLead())
  const claim = proposeClaim(accepted.state, { proposition: '最终报告在当前依据下可用' })
  let state = claim.state
  const artifactDep = registerDependency(state, dependencyInput('artifact', accepted.artifactId, 'claim', claim.claimId))
  state = artifactDep.state
  // 任务 B 在撤回时在途：通知的目标是它（有绑定会话的受影响方）。
  const taskB = readyTask(state, { title: '下游任务 B' })
  state = taskB.state
  const claimedB = claimTaskAs(state, taskB.taskId, asMember())
  state = claimedB.state
  const taskBDep = registerDependency(state, dependencyInput('task', taskB.taskId, 'claim', claim.claimId))
  state = taskBDep.state
  // 结论被撤回：依据版本递增、下游逐条失效、待传播项排队、通知进 outbox。
  const retracted = apply(state, { kind: 'claim.revise', requestId: req(), claimId: claim.claimId, status: 'refuted', retractionReason: '独立复现推翻原结论' }, LEAD)
  assert.equal(retracted.basisRevision, 1)
  assert.equal(must('taskB', retracted.tasks[taskB.taskId]).validity, 'needs_review', '在途下游任务被打上待复核')
  assert.equal(headOf(retracted, 'reports/final.md').validity, 'needs_review', '已验收产物因依据撤回失去当前有效性')
  assert.equal(headOf(retracted, 'reports/final.md').status, 'verified', '历史状态保留：是有效性变了，不是记录被抹掉')
  assert.equal(retracted.pendingPropagations.length, 2)
  const artifactItem = must('artifact propagation', retracted.pendingPropagations.find((item) => item.targetKind === 'artifact'))
  assert.equal(artifactItem.requiredAction, 'reverify_or_reissue')
  const queued = pendingOutbox(retracted)
  assert.equal(queued.length, 1, '有绑定会话的一方收到一条排队的复核通知')
  // 崩溃与重启：聚合记录先落盘再装载，工作项与通知必须原样存活。
  const store = new MemoryStore()
  await store.create(retracted.missionId, retracted)
  const revived = must('revived', (await store.load(retracted.missionId)) ?? undefined)
  assert.equal(revived.pendingPropagations.length, 2, '传播工作项从持久记录继续')
  assert.equal(pendingOutbox(revived).length, 1, '未投递通知不因重启丢失')
  assert.equal(headOf(revived, 'reports/final.md').validity, 'needs_review')
  assert.equal(must('taskB', revived.tasks[taskB.taskId]).validity, 'needs_review')
  // 旧发布票据无效：依据被撤回的产物不许发布，重启也不例外。
  const grant = issueGrant(revived, { objectScope: ['reports/final.md'] })
  refused(grant.state, { kind: 'artifact.requestPublish', requestId: req(), artifactId: accepted.artifactId, version: 1, grantId: grant.grantId }, LEAD, '依据被撤回的产物不许发布')
  // 用户裁定只收积压项，不改有效性：复核才算数。
  const taskBItem = must('taskB propagation', grant.state.pendingPropagations.find((item) => item.targetKind === 'task'))
  const resolved = apply(grant.state, { kind: 'propagation.resolve', requestId: req(), propagationId: taskBItem.propagationId, reason: '任务 B 交由用户裁定，按新依据重发' }, USER)
  assert.equal(resolved.pendingPropagations.length, 1, '裁定收走点名的积压项')
  assert.equal(headOf(resolved, 'reports/final.md').validity, 'needs_review', '裁定不能代替复核：有效性照旧')
  // 补证重发：登记新版本，旧版本的复核类待传播项收到这里。
  const reissued = registerArtifact(resolved, accepted.taskId, 'reports/final.md', 'sha256:bbbb', LEAD)
  assert.equal(reissued.state.pendingPropagations.length, 0, '重发落地后待传播项收敛')
  assert.equal(headOf(reissued.state, 'reports/final.md').version, 2)
  assert.equal(headOf(reissued.state, 'reports/final.md').validity, 'current', '新版本是当前有效候选')
  // 排队的复核通知投递完成。
  const noticeId = must('outbox id', queued[0])
  const delivered = apply(reissued.state, { kind: 'outbox.complete', requestId: req(), outboxId: noticeId }, SUPERVISOR)
  assert.notEqual(must('outbox entry', delivered.outbox[noticeId]).completedAt, undefined, '投递完成后条目才带完成时刻')
})

test('S4 授权撤销与外部写入交错：未入工具的被拒，在途的标为不明并核对', () => {
  const claimed = withClaimedTask()
  let state = claimed.state
  const grant = issueGrant(state, { actions: ['write'], objectScope: ['api/ledger.md'], sourceRef: '用户 2026-10-14 授权（台账写入）' })
  state = grant.state
  const beforeOps = state.operations
  state = apply(state, {
    kind: 'operation.intent',
    requestId: req(),
    taskId: claimed.taskId,
    operationKind: 'file_write',
    target: 'api/ledger.md',
    intent: '写入台账条目',
    idempotencyKey: req('idem'),
    retryable: false,
    reconcileMethod: '读回台账按哈希核对',
    action: 'write',
    grantId: grant.grantId,
    targetIdentity: 'api/ledger.md',
  }, LEAD)
  const opId = addedKey(beforeOps, state.operations)
  assert.equal(must('op', state.operations[opId]).status, 'intent')
  // 用户撤销授权：依据版本递增，但已进入工具的操作不被改写成"未发生"。
  const revoked = apply(state, { kind: 'authorization.revoke', requestId: req(), grantId: grant.grantId, reason: '用户撤销台账写入授权' }, USER)
  assert.equal(must('grant', revoked.grants[grant.grantId]).revokedAt, NOW)
  assert.equal(revoked.basisRevision, 1)
  assert.equal(must('op', revoked.operations[opId]).status, 'intent', '撤销不吞掉在途操作的事实')
  // 尚未进入工具的新写入：同一动作换个幂等键也被授权闸门拒绝。
  const beforeCount = Object.keys(revoked.operations).length
  refused(revoked, {
    kind: 'operation.intent',
    requestId: req(),
    taskId: claimed.taskId,
    operationKind: 'file_write',
    target: 'api/ledger.md',
    intent: '重试写入台账条目',
    idempotencyKey: req('idem'),
    retryable: false,
    reconcileMethod: '读回台账按哈希核对',
    action: 'write',
    grantId: grant.grantId,
    targetIdentity: 'api/ledger.md',
  }, LEAD, '撤销后的授权不许再开新写入')
  assert.equal(Object.keys(revoked.operations).length, beforeCount, '被拒的意图不落成第二条操作')
  // 在途操作核对：先记结果不明，再确认已执行——不把"已取消"写成"外部操作未发生"。
  const unknown = apply(revoked, { kind: 'operation.reconcile', requestId: req(), operationId: opId, verdict: 'still_unknown' }, LEAD)
  assert.equal(must('op', unknown.operations[opId]).status, 'outcome_unknown')
  assert.equal(must('op', unknown.operations[opId]).externalPhase, 'unknown')
  const executed = apply(unknown, { kind: 'operation.reconcile', requestId: req(), operationId: opId, verdict: 'executed', resultRef: 'api/ledger.md#rev-9' }, LEAD)
  assert.equal(must('op', executed.operations[opId]).status, 'succeeded', '外部操作确实发生，核对后如实入账')
  assert.equal(must('op', executed.operations[opId]).resultRef, 'api/ledger.md#rev-9')
})

test('S5 规则版本不同步：消息带版本、旧票据只成迟到记录、成员权限不扩大', () => {
  const crewed = crew().state
  const task = readyTask(crewed, { title: '成员任务' })
  let state = task.state
  // 成员执行并提交。
  const claimed = claimTaskAs(state, task.taskId, asMember())
  state = checkpointTaskAs(claimed.state, task.taskId, asMember())
  state = submitTaskAs(state, task.taskId, asMember())
  assert.equal(must('task', state.tasks[task.taskId]).status, 'submitted')
  // Lead 下发变更提案：消息携带任务书与判据版本。
  const beforeMail = state.mailbox
  state = apply(state, {
    kind: 'team.message',
    requestId: req(),
    toActorId: 'member-1',
    taskId: task.taskId,
    messageKind: 'change_proposal',
    body: '判据将按新口径修订，请等新版本再提交',
    targetKind: 'task',
    targetId: task.taskId,
    targetRevision: 1,
  }, LEAD)
  const messageId = addedKey(beforeMail, state.mailbox)
  assert.equal(must('message', state.mailbox[messageId]).criteriaRevision, 1)
  assert.equal(must('message', state.mailbox[messageId]).targetRevision, 1, '消息指向被讨论的那一版')
  // 判据修订（版本 2）：成员手里那张票据只证明版本 1。
  state = apply(state, { kind: 'task.revise', requestId: req(), taskId: task.taskId, criteria: [{ text: '按新口径核对台账' }], reason: '口径更新' }, LEAD)
  const late = verifyTask(state, { taskId: task.taskId, criterionId: 'crit_1', outcome: 'pass' }, asLead())
  state = late.state
  const lastEvent = must('last event', state.events[state.events.length - 1])
  assert.equal(lastEvent.kind, 'task/verified-late', '旧版本上的验收记录只能算迟到记录')
  assert.equal(must('task', state.tasks[task.taskId]).status, 'submitted', '迟到记录不完成旧版本任务')
  assert.equal(must('task', state.tasks[task.taskId]).validity, 'needs_review')
  assert.notEqual(state.verifications[late.verificationId], undefined, '迟到记录本身保留为历史')
  // 重试后按新版本重做：重领 → 检查点 → 提交 → 验收通过。
  state = apply(state, { kind: 'task.retry', requestId: req(), taskId: task.taskId, reason: '判据已修订，按新版本重做' }, LEAD)
  assert.equal(must('task', state.tasks[task.taskId]).status, 'retry_wait')
  const second = claimTaskAs(state, task.taskId, asMember())
  state = second.state
  const secondTicket = must('ticket', must('attempt', state.attempts[second.attemptId]).ticket)
  assert.equal(secondTicket.criteriaRevision, 2, '重领换发按当前判据版本的新票据')
  state = checkpointTaskAs(state, task.taskId, asMember())
  state = submitTaskAs(state, task.taskId, asMember())
  const done = verifyTask(state, { taskId: task.taskId, criterionId: 'crit_1', outcome: 'pass' }, asLead())
  state = done.state
  assert.equal(must('task', state.tasks[task.taskId]).status, 'completed', '按新版本重做后正常完成')
  assert.equal(must('task', state.tasks[task.taskId]).validity, 'current')
  // 成员权限不因任何消息或版本变化扩大：批准始终不属于成员。
  const followUp = proposeTask(state, { title: '后续任务' })
  refused(followUp.state, { kind: 'task.approve', requestId: req(), taskId: followUp.taskId }, MEMBER, '成员不能批准任务')
})

test('S6 登记正确但交付未确认：submitted≠completed，交付确认另算一步', () => {
  const crewed = crew().state
  const upstream = readyTask(crewed, { title: '产出任务' })
  let state = upstream.state
  const claimed = claimTaskAs(state, upstream.taskId, asMember())
  state = checkpointTaskAs(claimed.state, upstream.taskId, asMember())
  // 派单与回收：子代理返回 ≠ 任务完成，结果先进交付箱。
  const beforeOps = state.operations
  state = apply(state, { kind: 'delegate.start', requestId: req(), taskId: upstream.taskId, nativeRunId: 'run-77', childSessionId: 'sess-sub' }, MEMBER)
  const delegateOpId = addedKey(beforeOps, state.operations)
  const beforeDlv = state.deliveries
  state = apply(state, { kind: 'delegate.collect', requestId: req(), taskId: upstream.taskId, resultRefs: ['artifact:diff.md'] }, MEMBER)
  const deliveryId = addedKey(beforeDlv, state.deliveries)
  assert.equal(must('delivery', state.deliveries[deliveryId]).stage, 'registered')
  assert.equal(deliveryIsProcessed(must('delivery', state.deliveries[deliveryId])), false, '登记 ≠ 对方已处理')
  // 派单操作随子代理返回结算，否则未决操作会挡住提交。
  state = apply(state, { kind: 'operation.receipt', requestId: req(), operationId: delegateOpId, status: 'succeeded', externalPhase: 'succeeded', resultRef: 'native:run-77' }, MEMBER)
  // 下游依赖该产出：验收之前不许放行。
  const downstream = proposeTask(state, { title: '下游任务', dependsOn: [upstream.taskId] })
  state = downstream.state
  refused(state, { kind: 'task.approve', requestId: req(), taskId: downstream.taskId }, USER, '产物未验收，下游不许放行')
  // 提交与登记：任务停在 submitted——交付未处理不能把它推成 completed。
  state = submitTaskAs(state, upstream.taskId, asMember())
  const registered = registerArtifact(state, upstream.taskId, 'reports/diff.md', 'sha256:cccc', actorCtx(asMember()))
  state = registered.state
  assert.equal(must('upstream', state.tasks[upstream.taskId]).status, 'submitted')
  refused(state, { kind: 'task.approve', requestId: req(), taskId: downstream.taskId }, USER, 'submitted 也不等于 completed')
  assert.equal(deliveryIsProcessed(must('delivery', state.deliveries[deliveryId])), false)
  // 验收通过：任务完成、产物提为 verified；交付仍未被处理。
  const done = verifyTask(state, { taskId: upstream.taskId, criterionId: 'crit_1', outcome: 'pass', artifactId: registered.artifactId }, asLead())
  state = done.state
  assert.equal(must('upstream', state.tasks[upstream.taskId]).status, 'completed')
  assert.equal(headOf(state, 'reports/diff.md').status, 'verified', '通过验收才能把链头提为已验证')
  assert.equal(deliveryIsProcessed(must('delivery', state.deliveries[deliveryId])), false, '任务完成 ≠ 交付已确认')
  // 下游现在可以放行。
  state = approveTask(state, downstream.taskId, USER)
  assert.equal(must('downstream', state.tasks[downstream.taskId]).status, 'ready')
  // 收件方确认处理：交付状态独立推进到最后一步。
  state = apply(state, { kind: 'delivery.confirm', requestId: req(), deliveryId, stage: 'processed', handling: 'integrated' }, MEMBER)
  assert.equal(deliveryIsProcessed(must('delivery', state.deliveries[deliveryId])), true)
})

test('S7 独立审查输入污染：记录独立性限制，人数不累加为独立证据', () => {
  const crewed = crew().state
  const task = readyTask(crewed, { title: '被审查任务' })
  let state = task.state
  const shared = recordEvidence(state, { summary: '两路审查共用的一次原始读数' })
  state = shared.state
  // 审查一：与审查二共用原始证据，说明独立性限制后允许登记。
  const first = recordReview(state, reviewInput(task.taskId, { sharedEvidenceIds: [shared.evidenceId], independenceNote: '与 review-2 共用同一原始证据', methodRef: '重读原始读数' }), REVIEWER)
  state = first.state
  // 审查二：看过参考答案，同样登记为受限。
  state = registerActor(state, 'review-2', 'reviewer', 'sess-6')
  const second = recordReview(state, reviewInput(task.taskId, { sawReferenceAnswer: true, independenceNote: '看过参考答案，独立性受限', methodRef: '重读原始读数' }), REVIEWER2)
  state = second.state
  // 审查三：干净重读，无共享、无参考答案。
  const clean = recordReview(state, reviewInput(task.taskId, { methodRef: '重读原始读数' }), REVIEWER)
  state = clean.state
  // 记录层：共享证据与看过参考答案都不折不扣留下。
  assert.deepEqual(must('review1', state.reviews[first.reviewId]).sharedEvidenceIds, [shared.evidenceId])
  assert.equal(must('review2', state.reviews[second.reviewId]).sawReferenceAnswer, true)
  assert.equal(must('review3', state.reviews[clean.reviewId]).independenceNote, '', '干净重读不需要限制说明')
  // 视图层：受限被打标，只当带限制的独立证据用。
  const markdown = renderDisciplineMarkdown(state)
  assert.equal(markdown.includes(shared.evidenceId), true, '共用证据要在审查段可见')
  assert.equal((markdown.match(/是（独立性受限）/g) ?? []).length, 1, '只有看过参考答案的那条被打标')
  assert.match(markdown, /与 review-2 共用同一原始证据/)
  assert.match(markdown, /看过参考答案，独立性受限/)
  // 受限却缺说明：根本登记不进来。
  refused(state, { kind: 'review.record', requestId: req(), review: reviewInput(task.taskId, { sawReferenceAnswer: true }) }, REVIEWER, '看过参考答案却没写独立性说明')
})

test('S8 检查器异常：error 不折算成通过，判定相关动作停住，无关工作与检索继续', () => {
  const crewed = crew().state
  const main = readyTask(crewed, { title: '受检任务' })
  const unrelated = readyTask(main.state, { title: '无关任务' })
  let state = unrelated.state
  // 资格齐备的验证器 + 一次执行异常：结果必须是 error，不许折算成通过。
  const validator = qualifyValidator(state, validatorInput({ codeRef: 'summaries/check.mjs' }))
  state = validator.state
  const claimed = claimTaskAs(state, main.taskId, asMember())
  state = checkpointTaskAs(claimed.state, main.taskId, asMember())
  state = submitTaskAs(state, main.taskId, asMember())
  const broken = verifyTask(state, { taskId: main.taskId, criterionId: 'crit_1', outcome: 'error', validatorId: validator.validatorId, checksRun: 3, detail: '第 3 条断言解析错误' }, asLead())
  state = broken.state
  const mainTask = must('main task', state.tasks[main.taskId])
  assert.equal(mainTask.status, 'verifying', 'error 不完成也不失败，停在等补证')
  const report = criteriaReport(state, mainTask)
  assert.equal(report.satisfied, false)
  assert.equal(must('proof', report.proofs[0]).outcome, 'unproven')
  assert.match(report.blockers.join('；'), /error/, '缺口要如实写明是哪类异常')
  // 诊断与只读检索不被全局锁死。
  const searched = recordSearch(state, { query: '契约快照' }, SUBAGENT)
  state = searched.state
  assert.equal(must('search', state.searches[searched.receiptId]).outcome, 'not_found_in_scope')
  // 无关任务照样做完。
  const other = claimTaskAs(state, unrelated.taskId, asMember())
  state = checkpointTaskAs(other.state, unrelated.taskId, asMember())
  state = submitTaskAs(state, unrelated.taskId, asMember())
  const done = verifyTask(state, { taskId: unrelated.taskId, criterionId: 'crit_1', outcome: 'pass' }, asLead())
  state = done.state
  assert.equal(must('unrelated', state.tasks[unrelated.taskId]).status, 'completed')
  // Mission 不被整体停死，但完成判定如实报告缺口。
  assert.equal(state.mission.status, 'active')
  assert.equal(must('main task', state.tasks[main.taskId]).status, 'verifying', '受检任务始终停在等补证')
  const completion = missionCompletion(state)
  assert.equal(completion.ready, false)
  assert.equal(completion.missing.some((item) => item.includes('未 completed')), true)
})
