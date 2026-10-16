/**
 * §23.1 纪律回归集：R01–R18 每条一对**正例/违例**。
 *
 * 违例用例断言两件事：转换被拒（`dispatch(...).applied === false`）**且**相关记录没被改写；
 * 正例用例断言被接受，并点明"具体记下了什么"。
 *
 * 若某条违例内核根本没拦（判定函数存在却没接进转换，或转换少一格守卫），用例就让它红，
 * 并在断言消息里写清应当拒绝的位置——这正是回归集要产出的结论；不在测试里补机制，
 * 也不把没拦下的写成通过。完全没有可执行判定的两条（R16 违例、R18 违例）以 `test.todo` 呈现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { dispatch } from '../src/core/commands.ts'
import {
  comparable,
  criteriaReport,
  detectContradictions,
  deliveryIsProcessed,
  ineffectiveClaimRefs,
  isStructural,
  latestClaim,
  openObligations,
  supportsAbsenceClaim,
  ticketIsCurrent,
} from '../src/core/discipline.ts'
import { closureGaps, missionCompletion } from '../src/core/completion.ts'
import { consumedTokens, governanceShare, hasProgress, noteGovernance, reservedTokens } from '../src/core/budget.ts'
import { renderDisciplineMarkdown, renderMissionMarkdown, toJsonl } from '../src/views/export.ts'
import type { MissionControl } from '../src/core/control.ts'
import type { Operation } from '../src/core/entities.ts'
import {
  actorCtx,
  addedKey,
  apply,
  artifactThroughAcceptance,
  asLead,
  asMember,
  claimTask,
  claimTaskAs,
  checkpointTaskAs,
  contextInput,
  crew,
  ctx,
  dependencyInput,
  dispatchInput,
  evidences,
  freshState,
  intentCommand,
  issueGrant,
  missionDraft,
  must,
  NOW,
  of,
  publishArtifact,
  proposeClaim,
  proposeObligation,
  proposeTask,
  readyTask,
  recordEvidence,
  registerArtifact,
  registerActor,
  registerDependency,
  recordSearch,
  req,
  refused,
  reviewInput,
  ruleInput,
  incidentInput,
  claimInput,
  submittedTask,
  submitTaskAs,
  validatorInput,
  verifyTask,
  withClaimedTask,
  withReadyTask,
  withSubmittedTask,
} from './discipline-fixtures.ts'

const USER = ctx('user', 'human')
const SUPERVISOR = ctx('supervisor', 'supervisor-1')
const LEAD = actorCtx(asLead())
const REVIEWER = actorCtx(of('review-1', 'reviewer', 'sess-4'))
const MEMBER = actorCtx(asMember())

/** 取状态里最后落账的那条操作：用例只在自己控制的链路上用。 */
function lastOperation(state: MissionControl): Operation {
  const operation = Object.values(state.operations).at(-1)
  if (operation === undefined) throw new Error('夹具：状态里没有操作记录')
  return operation
}

/** 从视图头部元数据里读投影标识（`projectionRevisionOf` 未导出，只能按文本取）。 */
function projectionRevision(markdown: string): string {
  const match = /- projectionRevision：(\S+)/.exec(markdown)
  if (match === null || match[1] === undefined) throw new Error('夹具：视图头部缺 projectionRevision')
  return match[1]
}

/** Lead 无当前绑定会话的班组：专门用来打"交付失联"这一格。 */
function leadlessCrew(): MissionControl {
  let state = freshState()
  state = apply(state, { kind: 'mission.create', requestId: req(), mission: missionDraft() })
  state = registerActor(state, 'lead-0', 'lead')
  state = registerActor(state, 'member-1', 'member', 'sess-2')
  state = registerActor(state, 'human', 'user')
  return state
}

// —— R01 证据口径（§22.1 DG-01）——

test('R01 违例：来源类别与分母不同的观测不得横比（§22.1 DG-01）', () => {
  const { state } = withReadyTask()
  const observed = recordEvidence(state, { kind: 'observation', summary: '真实执行的一次读数' })
  const simulated = recordEvidence(observed.state, { kind: 'simulated', summary: '同指标的一次模拟读数', sourceRef: 'sim:1' })
  const observation = must('观测证据', observed.state.evidence[observed.evidenceId])
  const simulation = must('模拟证据', simulated.state.evidence[simulated.evidenceId])

  const mixed = comparable(observation, simulation)
  assert.equal(mixed.ok, false, 'R01 违例：模拟读数与观测读数被当成同口径可比')
  assert.match(mixed.reason, /来源类别/)

  const otherDenominator = recordEvidence(simulated.state, { denominator: 'n=30' })
  const mixed2 = comparable(observation, must('证据', otherDenominator.state.evidence[otherDenominator.evidenceId]))
  assert.equal(mixed2.ok, false, 'R01 违例：分母不同的两个数值被判定为可比')
  assert.match(mixed2.reason, /分母/)

  // 违例的另一半：没有任何转换调用 `comparable`，两类口径被并登进同一本台账。
  const crossed = dispatch(
    simulated.state,
    { kind: 'claim.propose', requestId: req(), claim: claimInput({ sourceCategory: 'observation', supportingEvidenceIds: evidences(simulated.evidenceId) }) },
    LEAD,
  )
  assert.equal(
    crossed.applied,
    false,
    'R15/R01 违例未被拦下：`claim.propose`（commands.ts:1632）与 `evidence.record`（commands.ts:1622）都不调用 ' +
      '`discipline.comparable`（discipline.ts:462），把模拟读数当作观测结论的支撑登记时内核照单收下（§22.1 DG-01）',
  )
})

test('R01 正例：同口径观测可比，对象时点不同则各留各的时间（§22.1）', () => {
  const { state } = withReadyTask()
  const first = recordEvidence(state, { summary: '第一次读数' })
  const second = recordEvidence(first.state, { summary: '第二次读数' })
  const a = must('证据', first.state.evidence[first.evidenceId])
  const b = must('证据', second.state.evidence[second.evidenceId])

  const same = comparable(a, b)
  assert.equal(same.ok, true, `R01 正例：同指标同分母的同源观测被判为不可比：${same.reason}`)

  const historical = recordEvidence(second.state, { summary: '上周的一次读数', objectTime: 1_699_395_200_000 })
  const c = must('证据', historical.state.evidence[historical.evidenceId])
  const drift = comparable(a, c)
  assert.equal(drift.ok, false, 'R01 正例：对象时点不同的读数应不可横比')
  assert.match(drift.reason, /对象时点/)
  // 记录本身不被合并或改写：观测时间与对象时间分列保留。
  assert.equal(c.objectTime, 1_699_395_200_000)
  assert.equal(a.objectTime, NOW)
  assert.equal(c.observedAt, a.observedAt, 'R01 正例：后一条记录覆盖了前一条的观测时点')
})

// —— R02 检索假阴性（§22.2 DG-02）——

test('R02 违例：截断/分页未完/覆盖未知的回执不得承载"没找到"前提（§22.2 DG-02）', () => {
  const { state, taskId } = withReadyTask()
  const truncated = recordSearch(state, { truncated: true })
  refused(
    truncated.state,
    { kind: 'dispatch.plan', requestId: req(), dispatch: dispatchInput(taskId, { searchReceiptIds: [truncated.receiptId] }) },
    LEAD,
    'R02 违例：被截断的检索被当成不存在前提',
  )

  const paged = recordSearch(truncated.state, { hasMore: true, pagesFetched: 1 })
  refused(
    paged.state,
    { kind: 'dispatch.plan', requestId: req(), dispatch: dispatchInput(taskId, { searchReceiptIds: [paged.receiptId] }) },
    LEAD,
    'R02 违例：hasMore 仍为真（只取到第一页）的回执承载了不存在前提',
  )

  const unknownCoverage = recordSearch(paged.state, { coverage: 'unknown' })
  refused(
    unknownCoverage.state,
    { kind: 'dispatch.plan', requestId: req(), dispatch: dispatchInput(taskId, { searchReceiptIds: [unknownCoverage.receiptId] }) },
    LEAD,
    'R02 违例：coverage 为 unknown 的回执承载了不存在前提',
  )
  assert.equal(
    supportsAbsenceClaim(must('检索回执', unknownCoverage.state.searches[unknownCoverage.receiptId])).ok,
    false,
    'R02 违例：判定函数本身也放行了 coverage unknown',
  )
})

test('R02 正例：覆盖完整的 not_found_in_scope 才能承载前提，补全后可派单（§22.2）', () => {
  const { state, taskId } = withReadyTask()
  const partial = recordSearch(state, { coverage: 'partial', hasMore: true })
  refused(
    partial.state,
    { kind: 'dispatch.plan', requestId: req(), dispatch: dispatchInput(taskId, { searchReceiptIds: [partial.receiptId] }) },
    LEAD,
    'R02 正例前置：尚未查完的旧回执仍在前提列表里时应被拒',
  )

  const complete = recordSearch(partial.state, { pagesFetched: 3, query: 'archive marker 补全检索' })
  const planned = apply(complete.state, { kind: 'dispatch.plan', requestId: req(), dispatch: dispatchInput(taskId, { searchReceiptIds: [complete.receiptId] }) }, LEAD)
  const plan = must('派单', planned.dispatches[addedKey(complete.state.dispatches, planned.dispatches)])
  assert.deepEqual(plan.searchReceiptIds, [complete.receiptId], 'R02 正例：完整回执没有随派单记入前提')
  const receipt = must('检索回执', planned.searches[complete.receiptId])
  assert.equal(supportsAbsenceClaim(receipt).ok, true)
  assert.match(supportsAbsenceClaim(receipt).reason, /范围内未找到/)
  assert.equal(receipt.coverage, 'complete')
})

// —— R03 上下文送达回执（§22.3 DG-03）——

test('R03 违例：partial 不列缺项不得登记（§22.3 DG-03）', () => {
  const { state } = withReadyTask()
  refused(
    state,
    { kind: 'context.record', requestId: req(), context: contextInput('member-1', { completeness: 'partial', gaps: [] }) },
    LEAD,
    'R03 违例：completeness 为 partial 却没列缺项，仍被登记为已送达',
  )

  // 违例的另一半：full 与"仍有缺项"自相矛盾，内核没核对这一格。
  const contradictory = dispatch(
    state,
    { kind: 'context.record', requestId: req(), context: contextInput('member-1', { completeness: 'full', gaps: ['附录 B 未提供'] }) },
    LEAD,
  )
  assert.equal(
    contradictory.applied,
    false,
    'R03 违例未被拦下：`context.record`（commands.ts:1760）只拦"partial 且无 gaps"，' +
      '声明 full 却同时列出缺项时照单收下（§22.3 DG-03）',
  )
})

test('R03 正例：partial 连缺项一起如实登记（§22.3）', () => {
  const { state } = withReadyTask()
  const next = apply(
    state,
    {
      kind: 'context.record',
      requestId: req(),
      context: contextInput('member-1', { completeness: 'partial', gaps: ['附录 B 未提供', '规则 rul:dg07 仍是旧版'], acknowledged: false }),
    },
    LEAD,
  )
  const receipt = must('上下文回执', next.contexts[addedKey(state.contexts, next.contexts)])
  assert.equal(receipt.completeness, 'partial')
  assert.deepEqual(receipt.gaps, ['附录 B 未提供', '规则 rul:dg07 仍是旧版'], 'R03 正例：缺项未原样入档')
  assert.equal(receipt.acknowledged, false, 'R03 正例：送达回执替收件人宣称了已确认')
  assert.deepEqual(receipt.ruleVersions, { 'rul:dg01': 1 })
})

// —— R04 任务书互斥与判据版本（§22.4 DG-04、§7.1）——

test('R04 违例：结构性互斥不得进 ready，也不得随派单带走（§22.4 DG-04、§7.1）', () => {
  const proposed = proposeTask(crew().state, { title: '在冻结的台账上追加列', resourceKeys: ['台账.csv'], criteria: [{ text: '台账.csv 不得改动' }] })
  assert.equal(must('任务', proposed.state.tasks[proposed.taskId]).criteriaCheck, 'suspicious', 'R04：互斥没被记为疑点')

  refused(proposed.state, { kind: 'task.approve', requestId: req(), taskId: proposed.taskId }, USER, 'R04 违例：mutate_and_freeze（要改的对象同时被要求冻结）被批准成 ready')
  assert.equal(must('任务', proposed.state.tasks[proposed.taskId]).status, 'planned')

  refused(
    proposed.state,
    { kind: 'dispatch.plan', requestId: req(), dispatch: dispatchInput(proposed.taskId, { criteria: [{ text: '台账.csv 不得改动' }] }) },
    LEAD,
    'R04 违例：同一互斥随派单被放行',
  )

  const scopeBad = proposeTask(proposed.state, { exclusions: ['vendor/legacy'], inputRefs: ['vendor/legacy/readme.md'] })
  refused(scopeBad.state, { kind: 'task.approve', requestId: req(), taskId: scopeBad.taskId }, USER, 'R04 违例：排除项同时出现在输入引用里（scope_mismatch）仍被批准')

  // 非结构性疑点不硬拒：只标 suspicious，交由 Challenge 裁定。
  const suspicion = proposeTask(scopeBad.state, { criteria: [{ text: '新增字段并保持完整内容哈希' }] })
  assert.equal(must('任务', suspicion.state.tasks[suspicion.taskId]).criteriaCheck, 'suspicious')
  const approved = apply(suspicion.state, { kind: 'task.approve', requestId: req(), taskId: suspicion.taskId }, USER)
  assert.equal(must('任务', approved.tasks[suspicion.taskId]).status, 'ready', 'R04 违例：非结构疑点被当成硬拒绝依据')
  assert.equal(isStructural({ kind: 'add_field_and_full_hash', detail: '' }), false)
  assert.deepEqual(
    detectContradictions({ scope: '', exclusions: ['vendor/legacy'], inputRefs: ['vendor/legacy/readme.md'], resourceKeys: [], criteria: [] }).map((item) => item.kind),
    ['scope_mismatch'],
  )
})

test('R04 正例：改动对象与冻结对象分开即合法；判据改版后旧验证不再证明新版（§22.4、§5.1）', () => {
  const proposed = proposeTask(crew().state, { title: '只改台账，参考文件保持不变', resourceKeys: ['台账.csv'], criteria: [{ text: '参考.csv 内容哈希保持不变' }] })
  assert.equal(must('任务', proposed.state.tasks[proposed.taskId]).criteriaCheck, 'consistent', 'R04 正例：不同对象的改动/冻结被判为互斥')
  const ready = apply(proposed.state, { kind: 'task.approve', requestId: req(), taskId: proposed.taskId }, USER)
  assert.equal(must('任务', ready.tasks[proposed.taskId]).status, 'ready')

  const submitted = withSubmittedTask()
  const halfDone = verifyTask(submitted.state, { taskId: submitted.taskId, criterionId: 'crit_1', outcome: 'unknown', detail: '一次没跑完的核对' })
  assert.equal(must('任务', halfDone.state.tasks[submitted.taskId]).status, 'verifying')

  const revised = apply(
    halfDone.state,
    { kind: 'task.revise', requestId: req(), taskId: submitted.taskId, criteria: [{ text: '台账与内核记录逐条一致' }], reason: '判据口径写歪了，改成逐条一致' },
    LEAD,
  )
  const task = must('任务', revised.tasks[submitted.taskId])
  assert.equal(task.criteriaRevision, 2, 'R04 正例：判据改版未递增 criteriaRevision')
  assert.equal(task.criteriaCheck, 'consistent')
  assert.equal(task.validity, 'needs_review', 'R04 正例：修订后应打到需复核')
  const report = criteriaReport(revised, task)
  assert.equal(must('判据证明', report.proofs[0]).outcome, 'no_record', 'R04 正例：v1 判据下的验证记录仍在证明 v2 判据')
  assert.match(report.blockers.join(' '), /无验证记录/)
})

// —— R05 结论范围（§22.5 DG-05）——

test('R05 违例：一条结论失效不得全局停摆，只影响已登记依赖（§22.5/§22.6 DG-05/06）', () => {
  const crewState = crew().state
  const affected = readyTask(crewState, { title: '依赖该结论的核对' })
  const claim = proposeClaim(affected.state)
  const registered = registerDependency(claim.state, dependencyInput('task', affected.taskId, 'claim', claim.claimId))
  const unrelated = readyTask(registered.state, { title: '与本结论无关的核对' })
  const retracted = apply(
    unrelated.state,
    { kind: 'claim.revise', requestId: req(), claimId: claim.claimId, status: 'unsupported', retractionReason: '新反证：同条件下有成功记录' },
    LEAD,
  )

  assert.equal(must('受影响任务', retracted.tasks[affected.taskId]).validity, 'needs_review')
  assert.equal(must('无关任务', retracted.tasks[unrelated.taskId]).validity, 'current', 'R05 违例：无关任务被连带改成非当前有效')
  assert.equal(must('无关任务', retracted.tasks[unrelated.taskId]).status, 'ready', 'R05 违例：无关任务状态被连带改写')
  assert.equal(retracted.mission.status, 'active', 'R05 违例：一条结论失效把整个 Mission 停掉了')
  assert.deepEqual(ineffectiveClaimRefs(retracted), [`${claim.claimId}@2=invalid`])

  // 无关工作照常入场：内核没有把失效结论当全局禁令。
  const claimed = apply(retracted, claimTask(unrelated.taskId), LEAD)
  assert.equal(must('无关任务', claimed.tasks[unrelated.taskId]).status, 'leased')

  // 仍挂在失效结论上的新依赖：登记当场标 stale，不当作有效依据。
  const late = registerDependency(claimed, dependencyInput('task', unrelated.taskId, 'claim', claim.claimId))
  assert.equal(must('依赖', late.state.dependencies[late.dependencyId]).reviewState, 'stale')
})

test('R05 正例：否定结论保留适用范围与重入条件，重新成立后失效标记清除（§22.5）', () => {
  const claim = proposeClaim(crew().state, {
    status: 'unsupported',
    appliesUnder: ['实现版本 v1', '输入条件 A'],
    reentryConditions: ['实现升到 v2 后重跑同一组输入'],
    subject: '路径 X',
    implementationVersion: 'v1',
    inputCondition: 'A',
    verifiedRange: '30 次抽样',
  })
  const head = must('结论链头', latestClaim(claim.state, claim.claimId))
  assert.deepEqual(head.appliesUnder, ['实现版本 v1', '输入条件 A'], 'R05 正例：范围条件没有随结论登记入档')
  assert.equal(head.validity, 'current', 'R05 正例：v1 上的否定结论被写成全局无效')
  assert.deepEqual(ineffectiveClaimRefs(claim.state), [], 'R05 正例：范围化的否定结论被当成失效依据')

  const retracted = apply(
    claim.state,
    { kind: 'claim.revise', requestId: req(), claimId: claim.claimId, status: 'unsupported', retractionReason: '反证成立' },
    LEAD,
  )
  assert.equal(retracted.basisRevision, 1)
  assert.deepEqual(ineffectiveClaimRefs(retracted), [`${claim.claimId}@2=invalid`])

  const revived = apply(
    retracted,
    { kind: 'claim.revise', requestId: req(), claimId: claim.claimId, status: 'supported', validity: 'current', supportingEvidenceIds: [] },
    LEAD,
  )
  assert.equal(revived.basisRevision, 1, 'R05 正例：结论重新成立又推了一次依据版本')
  assert.deepEqual(ineffectiveClaimRefs(revived), [])
  assert.deepEqual(must('结论链头', latestClaim(revived, claim.claimId)).reentryConditions, ['实现升到 v2 后重跑同一组输入'])
})

// —— R06 依据撤回传播（§22.6 DG-06）——

test('R06 违例：依据撤回后旧票据不得提交、衍生产物不得发布（§22.6 DG-06）', () => {
  const rig = withClaimedTask()
  const claim = proposeClaim(rig.state)
  const retracted = apply(
    claim.state,
    { kind: 'claim.revise', requestId: req(), claimId: claim.claimId, status: 'unsupported', retractionReason: '反证成立' },
    LEAD,
  )
  assert.equal(retracted.basisRevision, 1)
  const staleTicket = must('票据', must('尝试', retracted.attempts[rig.attemptId]).ticket)
  assert.equal(ticketIsCurrent(retracted, staleTicket, NOW).ok, false, 'R06 违例：旧票据仍与当前依据一致')

  refused(retracted, { kind: 'task.submit', requestId: req(), taskId: rig.taskId, leaseVersion: 1 }, LEAD, 'R06 违例：依据撤回后旧票据还能提交结果')
  assert.equal(must('任务', retracted.tasks[rig.taskId]).status, 'running')

  // 衍生产物：结论撤回后被标需复核，即使授权有效也不许发布。
  const derived = artifactThroughAcceptance(crew().state, asLead(), { title: '汇总报告', uri: 'reports/summary.md', contentHash: 'sha256:1111' })
  const second = proposeClaim(derived.state)
  const dependency = registerDependency(second.state, dependencyInput('artifact', derived.artifactId, 'claim', second.claimId))
  const grant = issueGrant(dependency.state, { objectScope: ['reports/summary.md'] })
  const withdrawn = apply(
    grant.state,
    { kind: 'claim.revise', requestId: req(), claimId: second.claimId, status: 'refuted', retractionReason: '按当前实现不成立' },
    LEAD,
  )
  const artifact = must('产物版本', withdrawn.artifacts['reports/summary.md']?.at(-1))
  assert.equal(artifact.validity, 'needs_review', 'R06 违例：衍生产物没被打成需复核')
  assert.equal(withdrawn.pendingPropagations.length, 1, 'R06 违例：待传播项没有落盘')
  refused(
    withdrawn,
    { kind: 'artifact.requestPublish', requestId: req(), artifactId: derived.artifactId, version: 1, grantId: grant.grantId },
    LEAD,
    'R06 违例：依据撤回后的衍生产物仍被发布',
  )
})

test('R06 正例：无关任务照常推进；受影响任务补证后领新票据再提交（§22.6）', () => {
  const crewState = crew().state
  const claim = proposeClaim(crewState)
  const affected = readyTask(claim.state, { title: '依赖该结论的核对' })
  const registered = registerDependency(affected.state, dependencyInput('task', affected.taskId, 'claim', claim.claimId))
  const unrelated = readyTask(registered.state, { title: '与结论无关的核对' })
  const retracted = apply(
    unrelated.state,
    { kind: 'claim.revise', requestId: req(), claimId: claim.claimId, status: 'unsupported', retractionReason: '反证成立' },
    LEAD,
  )

  const unrelatedDone = submittedTask(retracted, unrelated.taskId, asLead())
  assert.equal(must('无关任务', unrelatedDone.tasks[unrelated.taskId]).status, 'submitted', 'R06 正例：无关任务被依据撤回连坐')

  const retried = apply(retracted, { kind: 'task.retry', requestId: req(), taskId: affected.taskId, reason: '在新依据下重跑' }, LEAD)
  assert.equal(must('受影响任务', retried.tasks[affected.taskId]).status, 'retry_wait')

  const fresh = claimTaskAs(retried, affected.taskId, asLead())
  const ticket = must('新票据', must('尝试', fresh.state.attempts[fresh.attemptId]).ticket)
  assert.equal(ticket.basisRevision, retracted.basisRevision, 'R06 正例：新票据没有携带当前依据版本')
  assert.equal(retracted.pendingPropagations.length, 1, 'R06 正例前置：撤回应留下 1 项待传播')
  assert.equal(fresh.state.pendingPropagations.length, 0, 'R06 正例：领新票据没有收敛该任务名下的传播项')

  const checked = checkpointTaskAs(fresh.state, affected.taskId, asLead())
  const submitted = submitTaskAs(checked, affected.taskId, asLead())
  assert.equal(must('受影响任务', submitted.tasks[affected.taskId]).status, 'submitted')
})

// —— R07 承诺闭环（§22.7 DG-07）——

test('R07 违例：没有回执不得记 verified/delivered，附证据不等于验收（§22.7 DG-07）', () => {
  const submitted = withSubmittedTask()
  const obligation = proposeObligation(submitted.state, 'lead-1', { taskId: submitted.taskId })
  const ready = apply(obligation.state, { kind: 'obligation.advance', requestId: req(), obligationId: obligation.obligationId, stage: 'ready' }, LEAD)
  const running = apply(ready, { kind: 'obligation.advance', requestId: req(), obligationId: obligation.obligationId, stage: 'running' }, LEAD)

  refused(running, { kind: 'obligation.advance', requestId: req(), obligationId: obligation.obligationId, stage: 'verified' }, LEAD, 'R07 违例：没有任何回执却记成已验证')
  refused(running, { kind: 'obligation.advance', requestId: req(), obligationId: obligation.obligationId, stage: 'delivered' }, LEAD, 'R07 违例：没有任何回执却记成已交付')
  assert.equal(must('承诺', running.obligations[obligation.obligationId]).stage, 'running')

  // 给产物附证据只是登记来源，不推进产物状态、也不闭环承诺。
  const withArtifact = registerArtifact(running, submitted.taskId, 'reports/note.md', 'sha256:note')
  const attached = apply(
    withArtifact.state,
    { kind: 'artifact.attachEvidence', requestId: req(), artifactId: withArtifact.artifactId, version: withArtifact.version, evidenceRefs: ['file:note.md'] },
    LEAD,
  )
  const note = must('产物版本', attached.artifacts['reports/note.md']?.at(-1))
  assert.equal(note.status, 'submitted', 'R07 违例：附证据把产物推成了已验收')
  assert.equal(note.published, false)

  const gaps = closureGaps(attached, submitted.taskId)
  assert.equal(gaps.openObligations.length, 1, 'R07 违例：轮末缺口清单没列出仍欠着的承诺')
  assert.match(gaps.openObligations.join(' '), /stage=running/)
  const report = missionCompletion(attached)
  assert.equal(report.ready, false)
  assert.match(report.missing.join(' '), /未闭环承诺/)
  assert.equal(openObligations(attached).length, 1)
})

test('R07 正例：带回执才推进，取消要留下理由与来源（§22.7）', () => {
  const obligation = proposeObligation(crew().state, 'lead-1')
  const ready = apply(obligation.state, { kind: 'obligation.advance', requestId: req(), obligationId: obligation.obligationId, stage: 'ready' }, LEAD)
  const running = apply(ready, { kind: 'obligation.advance', requestId: req(), obligationId: obligation.obligationId, stage: 'running' }, LEAD)
  const verified = apply(
    running,
    { kind: 'obligation.advance', requestId: req(), obligationId: obligation.obligationId, stage: 'verified', receiptRefs: ['verification:vrf_1'] },
    LEAD,
  )
  const verifiedRecord = must('承诺', verified.obligations[obligation.obligationId])
  assert.equal(verifiedRecord.stage, 'verified')
  assert.deepEqual(verifiedRecord.receiptRefs, ['verification:vrf_1'], 'R07 正例：回执引用没有记进承诺')

  const cancelled = apply(
    verified,
    { kind: 'obligation.advance', requestId: req(), obligationId: obligation.obligationId, stage: 'cancelled', reason: '判据已合并进其他项，本项作废', decisionSource: '用户 2026-10-14 裁定' },
    USER,
  )
  const cancelledRecord = must('承诺', cancelled.obligations[obligation.obligationId])
  assert.equal(cancelledRecord.stage, 'cancelled')
  assert.equal(cancelledRecord.decisionReason, '判据已合并进其他项，本项作废')
  assert.equal(cancelledRecord.decisionSource, '用户 2026-10-14 裁定')
  assert.deepEqual(openObligations(cancelled), [], 'R07 正例：已取消的承诺仍算欠着')
})

// —— R08 授权范围（§22.8 DG-08）——

test('R08 违例：范围外对象与只读授权都不得发布（§22.8 DG-08）', () => {
  const crewState = crew().state
  const inside = artifactThroughAcceptance(crewState, asLead(), { title: '报告 A', uri: 'reports/a.md', contentHash: 'sha256:a' })
  const alsoInside = artifactThroughAcceptance(inside.state, asLead(), { title: '报告 B', uri: 'reports/b.md', contentHash: 'sha256:b' })
  const outside = artifactThroughAcceptance(alsoInside.state, asLead(), { title: '报告 C', uri: 'reports/c.md', contentHash: 'sha256:c' })

  const scoped = issueGrant(outside.state, { objectScope: ['reports/a.md', 'reports/b.md'] })
  refused(
    scoped.state,
    { kind: 'artifact.requestPublish', requestId: req(), artifactId: outside.artifactId, version: 1, grantId: scoped.grantId },
    LEAD,
    'R08 违例：授权范围只覆盖 A/B，C 却被发布了',
  )

  const readOnly = issueGrant(scoped.state, { actions: ['read'], objectScope: ['reports/c.md'] })
  refused(
    readOnly.state,
    { kind: 'artifact.requestPublish', requestId: req(), artifactId: outside.artifactId, version: 1, grantId: readOnly.grantId },
    LEAD,
    'R08 违例：只读授权被用来发布',
  )
  assert.equal(must('产物版本', readOnly.state.artifacts['reports/c.md']?.at(-1)).published, false)
  assert.equal(Object.keys(readOnly.state.grants).length, 2, 'R08 违例：授权记录被发布命令就地新建了一份')
})

test('R08 正例：一份覆盖两个对象的授权可分别发布并计次（§22.8）', () => {
  const crewState = crew().state
  const first = artifactThroughAcceptance(crewState, asLead(), { title: '报告 A', uri: 'reports/a.md', contentHash: 'sha256:a' })
  const second = artifactThroughAcceptance(first.state, asLead(), { title: '报告 B', uri: 'reports/b.md', contentHash: 'sha256:b' })
  const grant = issueGrant(second.state, { actions: ['publish'], objectScope: ['reports/*'], maxUses: 5 })

  const publishedA = publishArtifact(grant.state, first.artifactId, 1, grant.grantId)
  const publishedB = publishArtifact(publishedA, second.artifactId, 1, grant.grantId)

  assert.equal(Object.keys(publishedB.grants).length, 1, 'R08 正例：两次发布各开了一份新授权')
  assert.equal(must('授权', publishedB.grants[grant.grantId]).usedCount, 2, 'R08 正例：授权计次没有累加')
  assert.equal(must('产物', publishedB.artifacts['reports/a.md']?.at(-1)).published, true)
  assert.equal(must('产物', publishedB.artifacts['reports/b.md']?.at(-1)).status, 'published')
})

// —— R09 独立审查与质疑分级（§22.9 DG-09、§22.4）——

test('R09 违例：共用证据或见过参考答案必须说明独立性；无反证的硬冲突降为待审（§22.9、§22.4）', () => {
  const crewState = crew().state
  const shared = recordEvidence(crewState)
  const task = readyTask(shared.state)
  refused(
    task.state,
    { kind: 'review.record', requestId: req(), review: reviewInput(task.taskId, { sharedEvidenceIds: evidences(shared.evidenceId), independenceNote: '' }) },
    REVIEWER,
    'R09 违例：与上一份审查共用证据却没写独立性说明，仍被记为独立审查',
  )
  refused(
    task.state,
    { kind: 'review.record', requestId: req(), review: reviewInput(task.taskId, { sawReferenceAnswer: true, independenceNote: '' }) },
    REVIEWER,
    'R09 违例：承认见过参考答案却没写独立性说明',
  )

  // 声称硬冲突却没带反证 → 降为待审意见，不阻断无关任务。
  const challenged = proposeTask(task.state, { title: '被质疑的任务' })
  const raised = apply(
    challenged.state,
    {
      kind: 'challenge.raise',
      requestId: req(),
      targetKind: 'task',
      targetId: challenged.taskId,
      quotedText: '这条判据与既有结论可能矛盾',
      contradictingEvidenceIds: [],
      affectedActionIds: [challenged.taskId],
      adjudicatorActorId: 'review-1',
      severity: 'hard_conflict',
    },
    MEMBER,
  )
  const softChallenge = must('质疑', raised.challenges[addedKey(challenged.state.challenges, raised.challenges)])
  assert.equal(softChallenge.severity, 'under_evidenced', 'R09 违例：没有反证的硬冲突被原样记为 hard_conflict')

  const unrelated = proposeTask(raised, { title: '与质疑无关的任务' })
  const approved = apply(unrelated.state, { kind: 'task.approve', requestId: req(), taskId: unrelated.taskId }, USER)
  assert.equal(must('无关任务', approved.tasks[unrelated.taskId]).status, 'ready', 'R09 违例：待审意见把无关任务一起挡下了')

  // 带上反证的硬冲突才真的阻断放行——上面那条降级因此是真实生效的。
  const hard = apply(
    approved,
    {
      kind: 'challenge.raise',
      requestId: req(),
      targetKind: 'task',
      targetId: challenged.taskId,
      quotedText: '与登记证据直接冲突',
      contradictingEvidenceIds: evidences(shared.evidenceId),
      affectedActionIds: [challenged.taskId],
      adjudicatorActorId: 'review-1',
      severity: 'hard_conflict',
    },
    MEMBER,
  )
  assert.equal(must('质疑', hard.challenges[addedKey(approved.challenges, hard.challenges)]).severity, 'hard_conflict')
  refused(hard, { kind: 'task.approve', requestId: req(), taskId: challenged.taskId }, USER, 'R09：带反证的硬冲突没挡住它指向的任务')
})

test('R09 正例：与历史重复的审查只需说明独立性，不强制新意（§22.9）', () => {
  const task = readyTask(crew().state)
  const next = apply(
    task.state,
    {
      kind: 'review.record',
      requestId: req(),
      review: reviewInput(task.taskId, { versusHistory: 'duplicate', independenceNote: '逐条重读原始证据，未参考上一份审查' }),
    },
    REVIEWER,
  )
  const review = must('审查记录', next.reviews[addedKey(task.state.reviews, next.reviews)])
  assert.equal(review.versusHistory, 'duplicate')
  assert.equal(review.novelty, undefined, 'R09 正例：审查记录被强制补写了新意')
  assert.equal(review.independenceNote, '逐条重读原始证据，未参考上一份审查')
})

// —— R10 验证器资格（§22.10 DG-10）——

test('R10 违例：零反例不得授予资格；未获资格的验证不能算通过（§22.10 DG-10）', () => {
  const crewState = crew().state
  const qualified = apply(crewState, { kind: 'validator.qualify', requestId: req(), validator: validatorInput({ counterSampleIds: [] }), eligible: true }, LEAD)
  const validatorId = addedKey(crewState.validators, qualified.validators)
  const head = must('验证器', qualified.validators[validatorId]?.at(-1))
  assert.equal(head.eligible, false, 'R10 违例：没有已知反例仍被授予资格')
  assert.match(head.qualificationReason ?? '', /样例/)

  const unqualifiedTask = readyTask(qualified, { title: '由未获资格验证器把关' })
  const submitted = submittedTask(unqualifiedTask.state, unqualifiedTask.taskId, asLead())
  const passed = verifyTask(submitted, { taskId: unqualifiedTask.taskId, criterionId: 'crit_1', outcome: 'pass', validatorId })
  assert.equal(must('任务', passed.state.tasks[unqualifiedTask.taskId]).status, 'verifying', 'R10 违例：未获资格的验证把任务判成了完成')
  const blockers = criteriaReport(passed.state, must('任务', passed.state.tasks[unqualifiedTask.taskId])).blockers
  assert.match(blockers.join(' '), /验证器资格无效/)

  // 违例的另一半：零检查（checksRun 0）的 pass 仍被当作证明。
  const plainTask = readyTask(qualified, { title: '零检查的通过' })
  const plainSubmitted = submittedTask(plainTask.state, plainTask.taskId, asLead())
  const zeroChecks = verifyTask(plainSubmitted, { taskId: plainTask.taskId, criterionId: 'crit_1', outcome: 'pass', checksRun: 0 })
  assert.notEqual(
    must('任务', zeroChecks.state.tasks[plainTask.taskId]).status,
    'completed',
    'R10 违例未被拦下：`task.verify`（commands.ts:884）与 `criteriaReport`（discipline.ts:60–72）都不看 `checksRun`，' +
      '零检查的 pass 仍算通过（§22.10 DG-10：恒真断言与零检查不算资格）',
  )
})

test('R10 正例：有反例有样例的验证器通过即完成；unknown 停在待验收并点名判据（§22.10、§6.4）', () => {
  const crewState = crew().state
  const qualified = apply(crewState, { kind: 'validator.qualify', requestId: req(), validator: validatorInput(), eligible: true }, LEAD)
  const validatorId = addedKey(crewState.validators, qualified.validators)
  assert.equal(must('验证器', qualified.validators[validatorId]?.at(-1)).eligible, true)

  const taskA = readyTask(qualified, { title: '由合格验证器把关' })
  const doneA = submittedTask(taskA.state, taskA.taskId, asLead())
  const verified = verifyTask(doneA, { taskId: taskA.taskId, criterionId: 'crit_1', outcome: 'pass', validatorId })
  assert.equal(must('任务', verified.state.tasks[taskA.taskId]).status, 'completed')
  assert.equal(must('验证记录', verified.state.verifications[verified.verificationId]).validatorId, validatorId)

  const taskB = readyTask(verified.state, { title: '需要补证的核对' })
  const doneB = submittedTask(taskB.state, taskB.taskId, asLead())
  const half = verifyTask(doneB, { taskId: taskB.taskId, criterionId: 'crit_1', outcome: 'unknown' })
  assert.equal(must('任务', half.state.tasks[taskB.taskId]).status, 'verifying', 'R10 正例：unknown 被折算成了通过或失败')
  assert.match(criteriaReport(half.state, must('任务', half.state.tasks[taskB.taskId])).blockers.join(' '), /crit_1/, 'R10 正例：阻塞项没点名判据')
})

// —— R11 结论基线字段（§22.11 DG-11）——

test('R11 违例：否定结论缺基线字段不得登记（§22.11 DG-11）', () => {
  const { state } = withReadyTask()
  const result = dispatch(
    state,
    {
      kind: 'claim.propose',
      requestId: req(),
      claim: claimInput({ status: 'refuted', subject: undefined, implementationVersion: undefined, inputCondition: undefined, verifiedRange: undefined }),
    },
    LEAD,
  )
  assert.equal(
    result.applied,
    false,
    'R11 违例未被拦下：`claim.propose`（commands.ts:1633）只核对 proposition 非空，' +
      '被反证/无支持的结论不带被测对象、实现版本、输入条件与验证范围也照样登记（§22.11 DG-11）',
  )
})

test('R11 正例：基线字段、范围与重入条件随结论入档（§22.11）', () => {
  const claim = proposeClaim(crew().state, {
    status: 'unsupported',
    subject: '重试路径 retry_after_backoff',
    implementationVersion: 'v0.3.0-rc1',
    inputCondition: '网络抖动 30%',
    verifiedRange: '500 次调用',
    appliesUnder: ['实现版本 v0.3.0-rc1', '网络抖动 30%'],
    reentryConditions: ['抖动降到 5% 以下重跑'],
  })
  const head = must('结论链头', latestClaim(claim.state, claim.claimId))
  assert.equal(head.subject, '重试路径 retry_after_backoff')
  assert.equal(head.implementationVersion, 'v0.3.0-rc1')
  assert.equal(head.inputCondition, '网络抖动 30%')
  assert.equal(head.verifiedRange, '500 次调用')
  assert.deepEqual(head.reentryConditions, ['抖动降到 5% 以下重跑'])
})

// —— R12 产物版本与哈希（§22.12 DG-12）——

test('R12 违例：被取代的旧版本不得发布；验证后内容变了旧验证不得继续证明（§22.12、§8）', () => {
  const derived = artifactThroughAcceptance(crew().state, asLead(), { title: '报告', uri: 'reports/final.md', contentHash: 'sha256:v1' })
  const grant = issueGrant(derived.state, { objectScope: ['reports/final.md'] })
  const v2 = registerArtifact(grant.state, derived.taskId, 'reports/final.md', 'sha256:v2')

  const chain = must('产物链', v2.state.artifacts['reports/final.md'])
  assert.equal(chain.at(0)?.status, 'superseded', 'R12 违例：新版本登记后旧版本状态没被取代')
  refused(
    v2.state,
    { kind: 'artifact.requestPublish', requestId: req(), artifactId: derived.artifactId, version: 1, grantId: grant.grantId },
    LEAD,
    'R12 违例：被取代的 v1 仍被发布',
  )

  // 违例的另一半：v1 上的 pass 在 v2 登记后仍算当前证明。
  const report = criteriaReport(v2.state, must('任务', v2.state.tasks[derived.taskId]))
  assert.equal(
    must('判据证明', report.proofs[0]).outcome,
    'stale_artifact',
    'R12 违例未被拦下：`artifactChanged`（discipline.ts:95–103）在链头 ID 与验证绑定 ID 不同时直接 continue，' +
      '而 `artifact.registerVersion`（commands.ts:1681）每个版本都另发 ID——v1 的 pass 继续证明已被 v2 取代的产物（§22.12 DG-12）',
  )
})

test('R12 正例：同 uri 同字节也另记一版并保留哈希口径（§22.12）', () => {
  const submitted = withSubmittedTask()
  const first = registerArtifact(submitted.state, submitted.taskId, 'reports/final.md', 'sha256:same')
  const second = registerArtifact(first.state, submitted.taskId, 'reports/final.md', 'sha256:same')
  const chain = must('产物链', second.state.artifacts['reports/final.md'])
  assert.equal(chain.length, 2, 'R12 正例：内容相同就跳过登记，版本链与"重新验算一致"的事实丢了')
  assert.notEqual(chain[0]?.artifactId, chain[1]?.artifactId)
  assert.equal(chain[0]?.status, 'superseded')
  assert.equal(chain[1]?.version, 2)
  assert.equal(chain[1]?.hashAlgorithm, 'sha256', 'R12 正例：哈希算法口径没随版本记录')
})

// —— R13 意图先行与幂等（§22.13 DG-13）——

test('R13 违例：同一幂等键与空对象范围不得记新操作；结果未定时不得另开一次写（§22.13 DG-13）', () => {
  const task = readyTask(crew().state)
  const claimed = claimTaskAs(task.state, task.taskId, asLead())
  const checked = checkpointTaskAs(claimed.state, task.taskId, asLead())
  const grant = issueGrant(checked, { actions: ['write'], objectScope: ['reports/final.md'] })
  const key = 'idem-write-1'
  const first = apply(grant.state, intentCommand(task.taskId, { idempotencyKey: key, action: 'write', grantId: grant.grantId }), LEAD)

  refused(first, intentCommand(task.taskId, { idempotencyKey: key, action: 'write', grantId: grant.grantId }), LEAD, 'R13 违例：同一幂等键被当成两次写操作收下')
  refused(first, intentCommand(task.taskId, { idempotencyKey: 'idem-write-2', target: '', action: 'write', grantId: grant.grantId }), LEAD, 'R13 违例：对象范围为空仍能登记写意图')

  const unknown = apply(first, { kind: 'operation.reconcile', requestId: req(), operationId: lastOperation(first).operationId, verdict: 'still_unknown' }, LEAD)
  const second = dispatch(unknown, intentCommand(task.taskId, { idempotencyKey: 'idem-write-3', action: 'write', grantId: grant.grantId }), LEAD)
  assert.equal(
    second.applied,
    false,
    'R13 违例未被拦下：`operation.intent`（commands.ts:1369）只在 idempotencyKey 完全相同时去重，' +
      '同一任务上还挂着 outcome_unknown 的写操作，换个新键的第二写就进来了（§22.13 DG-13：结果未明不得再写一次）',
  )
})

test('R13 正例：结果未定只能核对；预留只在确认未执行时退回，未定案不得提交（§22.13、§13）', () => {
  const task = readyTask(crew().state)
  const claimed = claimTaskAs(task.state, task.taskId, asLead())
  const checked = checkpointTaskAs(claimed.state, task.taskId, asLead())
  const grant = issueGrant(checked, { actions: ['write'], objectScope: ['reports/final.md'] })
  const intent = apply(grant.state, intentCommand(task.taskId, { action: 'write', grantId: grant.grantId, reserveTokens: 1_000, reserveCalls: 1 }), LEAD)
  const operation = lastOperation(intent)
  assert.equal(operation.status, 'intent')
  assert.equal(reservedTokens(intent.budget), 1_000, 'R13 正例：意图登记时没有预留')

  const unknown = apply(intent, { kind: 'operation.reconcile', requestId: req(), operationId: operation.operationId, verdict: 'still_unknown' }, LEAD)
  assert.equal(must('操作', unknown.operations[operation.operationId]).status, 'outcome_unknown')
  assert.equal(reservedTokens(unknown.budget), 1_000, 'R13 正例：结果未定就把预留退回了')

  refused(unknown, { kind: 'operation.receipt', requestId: req(), operationId: operation.operationId, status: 'succeeded' }, LEAD, 'R13 正例前置：结果未定的操作不该再接收据')
  refused(unknown, { kind: 'task.submit', requestId: req(), taskId: task.taskId, leaseVersion: 1 }, LEAD, 'R13 正例前置：还有未定案操作时不该能提交')

  const settled = apply(unknown, { kind: 'operation.reconcile', requestId: req(), operationId: operation.operationId, verdict: 'not_executed' }, LEAD)
  assert.equal(must('操作', settled.operations[operation.operationId]).status, 'failed')
  assert.equal(reservedTokens(settled.budget), 0, 'R13 正例：确认未执行后预留没有退回')
  const submitted = submitTaskAs(settled, task.taskId, asLead())
  assert.equal(must('任务', submitted.tasks[task.taskId]).status, 'submitted')
})

// —— R14 交付与处理分列（§22.14 DG-14）——

test('R14 违例：子代理返回既不完成父任务也不等于对方已处理（§22.14 DG-14）', () => {
  const task = readyTask(crew().state, { title: '子代理核对' })
  const claimed = claimTaskAs(task.state, task.taskId, asMember())
  const checked = checkpointTaskAs(claimed.state, task.taskId, asMember())
  const started = apply(checked, { kind: 'delegate.start', requestId: req(), taskId: task.taskId, nativeRunId: 'run-9' }, MEMBER)
  const collected = apply(started, { kind: 'delegate.collect', requestId: req(), taskId: task.taskId, resultRefs: ['run:9#result'] }, MEMBER)

  const delivery = must('交付', collected.deliveries[addedKey(started.deliveries, collected.deliveries)])
  assert.equal(delivery.stage, 'registered')
  assert.equal(delivery.handling, 'unprocessed')
  assert.equal(deliveryIsProcessed(delivery), false, 'R14 违例：登记即被当成对方已处理')
  assert.equal(must('任务', collected.tasks[task.taskId]).status, 'running', 'R14 违例：子代理返回把父任务推成了完成或已提交')

  const downstream = proposeTask(collected, { title: '依赖子代理结果的任务', dependsOn: [task.taskId] })
  refused(downstream.state, { kind: 'task.approve', requestId: req(), taskId: downstream.taskId }, USER, 'R14 违例：上游结果还没被处理，下游任务就获批了')
  assert.equal(must('下游任务', downstream.state.tasks[downstream.taskId]).status, 'planned')
})

test('R14 正例：父会话失联时结果进可见队列并挂承诺，绑定后确认处理即闭环（§22.14）', () => {
  const crewState = leadlessCrew()
  const task = readyTask(crewState, { title: '子代理核对' }, ctx('lead', 'lead-0'))
  const claimed = claimTaskAs(task.state, task.taskId, asMember())
  const checked = checkpointTaskAs(claimed.state, task.taskId, asMember())
  const collected = apply(checked, { kind: 'delegate.collect', requestId: req(), taskId: task.taskId, resultRefs: ['run:10#result'] }, MEMBER)

  const deliveryId = addedKey(checked.deliveries, collected.deliveries)
  const delivery = must('交付', collected.deliveries[deliveryId])
  assert.equal(delivery.stage, 'unrouted', 'R14 正例：收件人不可达时结果没有进可见待处理队列')
  const obligationId = delivery.obligationId
  if (obligationId === undefined) throw new Error('R14 正例：失联交付没有挂上有负责人的承诺')
  assert.equal(must('承诺', collected.obligations[obligationId]).ownerActorId, 'lead-0')
  assert.equal(missionCompletion(collected).ready, false)

  const bound = apply(collected, { kind: 'actor.bind', requestId: req(), targetActorId: 'lead-0', sessionId: 'sess-9' }, SUPERVISOR)
  assert.equal(must('Lead', bound.actors['lead-0']).sessionId, 'sess-9')
  const confirmed = apply(bound, { kind: 'delivery.confirm', requestId: req(), deliveryId, stage: 'processed', handling: 'integrated' }, actorCtx(of('lead-0', 'lead', 'sess-9')))
  assert.equal(deliveryIsProcessed(must('交付', confirmed.deliveries[deliveryId])), true)
  assert.equal(must('承诺', confirmed.obligations[obligationId]).stage, 'delivered')
  assert.deepEqual(openObligations(confirmed), [], 'R14 正例：处理确认后承诺仍未闭环')
})

// —— R15 预算依据与防空转（§22.15 DG-15、§13）——

test('R15 违例：只汇报不涨进展不得算数；Lead 不得无来源地追加约束（§22.15 DG-15、§13）', () => {
  assert.equal(hasProgress({ completedCriteria: 0, resolvedBlockers: 0, evidencedDecisions: 0 }), false, 'R15 违例：纯汇报轮次被判为有进展')
  assert.equal(hasProgress({ completedCriteria: 0, resolvedBlockers: 1, evidencedDecisions: 0 }), true)

  const { state } = withReadyTask()
  const revised = dispatch(state, { kind: 'mission.revise', requestId: req(), objective: state.mission.objective, constraints: [...state.mission.constraints, '不得再引用旧台账'] }, LEAD)
  assert.equal(
    revised.applied,
    false,
    'R15 违例未被拦下：`mission.revise`（commands.ts:627）在 Lead 追加约束却不填 constraintSource 时默认写成 "user"，' +
      '等于代理给自己伪造约束来源并推进目标版本；权限表里 Lead 本就允许 mission.revise（commands.ts:251），' +
      '"本轮无进展不得改目标/扩预算"没有任何判定入口（§22.15 DG-15）',
  )
})

test('R15 正例：预算依据写明出处、约束来源留痕；治理开销与本体工作分列（§13、§22.15）', () => {
  const created = apply(freshState(), { kind: 'mission.create', requestId: req(), mission: missionDraft({ budgetBasis: { kind: 'platform', ref: '平台部署上限 maxTotalTokens=40000000' } }) })
  assert.equal(created.mission.budgetBasis.kind, 'platform', 'R15 正例：预算依据的出处没有随 Mission 落档')
  assert.deepEqual(created.mission.constraintSources, ['用户 2026-10-14 指令'])

  const crewState = crew()
  const grant = issueGrant(crewState.state, { actions: ['write'], objectScope: ['reports/*'], maxUses: 5, tokenQuota: 100_000 })
  const task = readyTask(grant.state, { title: '带额度任务' })
  const claimed = claimTaskAs(task.state, task.taskId, asLead(), [grant.grantId])
  const ticket = must('票据', must('尝试', claimed.state.attempts[claimed.attemptId]).ticket)
  assert.deepEqual(ticket.grantIds, [grant.grantId])
  assert.equal(must('授权', claimed.state.grants[grant.grantId]).tokenQuota, 100_000)

  const withGovernance: MissionControl = { ...claimed.state, budget: noteGovernance(claimed.state.budget, { calls: 1, tokens: 500, wallClockMs: 1_200 }) }
  assert.equal(consumedTokens(withGovernance.budget), 0, 'R15 正例：治理开销串进了本体消耗')
  assert.equal(withGovernance.budget.governanceWallClockMs, 1_200)
  assert.equal(governanceShare(withGovernance), 1, 'R15 正例：治理占比无法从账本读出')
})

// —— R16 删除/停进程的独立授权（§22.16 DG-16）——

test.todo('R16 违例：内核尚无证据唯一性与进程身份判定机制，无法拦下同名目标二次删除（§22.16 DG-16）')
// 需要补的机制：`operation.intent`（commands.ts:1366）在 action 为 delete/process_stop 时，除 grantCovers
// 之外还要核对 targetIdentity 是否携带证据唯一键（内容哈希，或 PID+启动时间+可执行路径），
// 并对"同一 targetIdentity 上仍有未定案操作"的第二条删除意图就地拒绝。

test('R16 正例：删除动作走独立授权、精确对象身份与事后核对（§22.16 DG-16）', () => {
  const task = readyTask(crew().state)
  const claimed = claimTaskAs(task.state, task.taskId, asLead())
  const grant = issueGrant(claimed.state, { actions: ['delete'], objectScope: ['proc:worker-7'] })
  const intent = apply(
    grant.state,
    intentCommand(task.taskId, { operationKind: 'process_stop', target: 'proc:worker-7', targetIdentity: 'proc:worker-7', action: 'delete', grantId: grant.grantId, retryable: false }),
    LEAD,
  )
  const operation = lastOperation(intent)
  assert.equal(operation.status, 'intent', 'R16 正例：删除意图没有先落盘')
  assert.equal(operation.targetIdentity, 'proc:worker-7')
  assert.equal(operation.retryable, false, 'R16 正例：不可重试的删除被标成可重试')
  assert.equal(operation.grantId, grant.grantId)

  const settled = apply(intent, { kind: 'operation.reconcile', requestId: req(), operationId: operation.operationId, verdict: 'not_executed' }, LEAD)
  assert.equal(must('操作', settled.operations[operation.operationId]).status, 'failed')
})

// —— R17 事故总结只能出候选规则（§22.17 DG-17）——

test('R17 违例：成员自报事故不得直接激活程序化硬门（§22.17 DG-17）', () => {
  const crewState = crew().state
  const next = apply(
    crewState,
    { kind: 'incident.record', requestId: req(), incident: incidentInput({ candidateRuleIds: [] }), ruleCandidate: ruleInput({ enforcement: 'programmatic', disposition: 'deny', status: 'active' }) },
    MEMBER,
  )
  const ruleId = addedKey(crewState.rules, next.rules)
  const rule = must('规则', next.rules[ruleId]?.at(-1))
  assert.equal(rule.status, 'candidate', 'R17 违例：成员自报的 incident 直接把规则激活成硬门')
  assert.equal(rule.activatedAt, undefined)
  assert.deepEqual(rule.stats, { hits: 0, misfires: 0, misses: 0, costTokens: 0 }, 'R17 违例：候选规则被预置了收益统计')
  assert.equal(next.mission.policyRevision, crewState.mission.policyRevision, 'R17 违例：事故记录推进了规则快照版本')
  assert.equal(Object.values(next.rules).flat().some((item) => item.status === 'active'), false)
  assert.equal(must('事故', next.incidents[addedKey(crewState.incidents, next.incidents)]).recordedBy, 'member-1')
})

test('R17 正例：候选规则带反例并可关联既有规则；第二次事故仍是候选（§22.17、§21.4）', () => {
  const first = apply(
    crew().state,
    { kind: 'incident.record', requestId: req(), incident: incidentInput(), ruleCandidate: ruleInput({ exceptions: ['同一实现版本内的重复失败不算新证据'] }) },
    LEAD,
  )
  const ruleId = addedKey(crew().state.rules, first.rules)
  const rule = must('规则', first.rules[ruleId]?.at(-1))
  assert.deepEqual(rule.exceptions, ['同一实现版本内的重复失败不算新证据'], 'R17 正例：反例（例外）没随候选规则入档')
  assert.equal(rule.status, 'candidate')

  const second = apply(first, { kind: 'incident.record', requestId: req(), incident: incidentInput({ candidateRuleIds: [ruleId] }) }, LEAD)
  const incident = must('事故', second.incidents[addedKey(first.incidents, second.incidents)])
  assert.deepEqual(incident.candidateRuleIds, [ruleId], 'R17 正例：第二次事故没能关联到既有候选规则')
  assert.equal(Object.keys(second.rules).length, 1, 'R17 正例：第二次事故又激活了一条硬门')
  assert.equal(second.mission.policyRevision, 1)
})

// —— R18 视图不过时（§22.18 DG-18）——

test.todo('R18 违例：内核没有"旧 projection 不得作为当前结论"的判定入口（§22.18 DG-18）')
// 需要补的机制：受管工具入场处要比对调用方携带的 sourceRevision/projectionRevision
// 与当前 `state.revision` + `basisRevision`（现只在 views/export.ts:68 的 projectionRevisionOf 里生成，
// 属于私有投影元数据），不一致就拒绝并要求回读内核；目前任何转换都不看视图标识。

test('R18 正例：撤回在排队时视图标 unknown、投影版本变化且保留历史行（§22.18）', () => {
  const derived = artifactThroughAcceptance(crew().state, asLead(), { title: '报告', uri: 'reports/final.md', contentHash: 'sha256:v1' })
  const claim = proposeClaim(derived.state)
  const dependency = registerDependency(claim.state, dependencyInput('artifact', derived.artifactId, 'claim', claim.claimId))
  const before = renderMissionMarkdown(dependency.state)

  const retracted = apply(
    dependency.state,
    { kind: 'claim.revise', requestId: req(), claimId: claim.claimId, status: 'refuted', retractionReason: '实现变更后不再成立' },
    LEAD,
  )
  const after = renderMissionMarkdown(retracted)

  assert.match(after, /freshness：unknown/, 'R18 正例：还有失效待传播时视图仍自称 current')
  assert.notEqual(projectionRevision(after), projectionRevision(before), 'R18 正例：投影版本标识没随状态推进变化')
  assert.match(after, /项失效待传播/)
  const discipline = renderDisciplineMarkdown(retracted)
  assert.match(discipline, new RegExp(`${claim.claimId}@2`), 'R18 正例：纪律视图没标出失效的结论版本')
  assert.match(discipline, /已从当前状态剔除/)
  const jsonl = toJsonl(retracted)
  assert.match(jsonl, new RegExp(`"id":"${claim.claimId}@1"`), 'R18 正例：历史结论版本被从导出里抹掉了')
  assert.match(jsonl, new RegExp(`"id":"${claim.claimId}@2"`))
})
