/**
 * 设计稿 v0.5 §36.2 表：环境接续（V5-08 / V5-09）与团队裁决 / 整体验收（V5-10 / V5-11）的验收用例。
 *
 * 本文件自包含：夹具在本文件内重建，通用记录只从 `test/fixtures.ts` 取。
 * 每条 V 编号一个 test()，含两个分句的条目两侧（拦错侧 + 放行侧）都要断言；
 * 断言落在模块函数与返回结构上，消息写清口径，不用字符串弱匹配代替结构判定。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { MissionControl } from '../src/core/control.ts'
import type { Challenge } from '../src/core/entities.ts'
import { apply, checkpointPayload, ctx, draftMission, freshState, NOW, req, taskPayload } from './fixtures.ts'
import type { AssessInput, EnvironmentItem, FindingInput, JobObservation } from '../src/core/environment.ts'
import {
  FINDING_ACTIONS,
  assessResume,
  classifyFinding,
  guardedWrite,
  registerEnvironment,
  revalidationPlan,
  resumeIsCurrent,
} from '../src/core/environment.ts'
import type { AdjudicationInput, DisputeSide, IntegrationPlanInput, IntegrationReceiptInput } from '../src/core/integration.ts'
import {
  adjudicationVerdict,
  assembleIntegrationReceipt,
  classifyDispute,
  compareDisputeSides,
  disputeBlockingScope,
  evaluateIntegrationEligibility,
  integrationComponentDrift,
  registerIntegrationPlan,
  validateAdjudication,
} from '../src/core/integration.ts'

/* -------------------------------------------------------- 环境接续夹具 */

function item(overrides: Partial<EnvironmentItem> = {}): EnvironmentItem {
  return {
    kind: 'workspace',
    ref: 'env:ws',
    expected: '分支 main',
    observeMethod: 'git status --short',
    sensitivity: 'variable',
    changeAction: '更新清单并重验受影响结果',
    coverage: 'covered',
    ...overrides,
  }
}

function observation(overrides: Partial<FindingInput> = {}): FindingInput {
  return { kind: 'workspace', ref: 'env:ws', sensitivity: 'variable', observation: 'match', ...overrides }
}

function job(overrides: Partial<JobObservation> = {}): JobObservation {
  return { state: 'running', ...overrides }
}

/** 登记清单并返回 id；登记失败直接抛错，避免用例在错误基线上继续。 */
function withEnvironment(items: readonly EnvironmentItem[], nextAction: string): { readonly state: MissionControl; readonly environmentId: string } {
  const registered = registerEnvironment(freshState(), { nextAction, items, authorActorId: 'lead-1' }, NOW)
  if (!registered.ok || registered.environment === undefined) throw new Error(`环境清单未登记：${registered.reason ?? '未知原因'}`)
  return { state: registered.state, environmentId: registered.environment.environmentId }
}

function assess(state: MissionControl, environmentId: string, observations: readonly FindingInput[], extra: Partial<AssessInput> = {}) {
  return assessResume(state, {
    environmentId,
    targetIdentity: 'acct:default',
    decidedBy: 'supervisor',
    observations,
    ...extra,
  }, NOW + 1_000)
}

/* -------------------------------------------------------- 整合验收夹具 */

function baseState(titles: readonly string[]): { state: MissionControl; taskIds: string[] } {
  let state: MissionControl = freshState()
  // 团队协作口径：reviewer 等非 solo 角色只有在 collaboration=team 时才允许登记（commands actor.register）。
  state = apply(state, { kind: 'mission.create', requestId: req(), mission: draftMission({ collaboration: 'team' }) })
  state = apply(state, { kind: 'actor.register', requestId: req(), actorId: 'lead-1', role: 'lead', label: 'Lead', sessionId: 'sess-1' })
  state = apply(state, { kind: 'actor.register', requestId: req(), actorId: 'reviewer-1', role: 'reviewer', label: 'Reviewer', sessionId: 'sess-2' })
  const taskIds: string[] = []
  for (const title of titles) {
    const before = new Set(Object.keys(state.tasks))
    state = apply(state, { kind: 'task.propose', requestId: req(), task: taskPayload({ title }) })
    const created = Object.keys(state.tasks).find((id) => !before.has(id))
    if (created === undefined) throw new Error(`任务未创建：${title}`)
    taskIds.push(created)
  }
  return { state, taskIds }
}

function withArtifact(state: MissionControl, taskId: string, uri: string, contentHash: string): { state: MissionControl; artifactId: string } {
  const next = apply(state, { kind: 'artifact.registerVersion', requestId: req(), taskId, uri, contentHash }, ctx('lead', 'lead-1'))
  const group = next.artifacts[uri]
  const head = group?.[group.length - 1]
  if (head === undefined) throw new Error(`产物未登记：${uri}`)
  return { state: next, artifactId: head.artifactId }
}

interface World {
  readonly state: MissionControl
  readonly c1: string
  readonly c2: string
  readonly integrationTask: string
  readonly a1: string
  readonly a2: string
  readonly flowFingerprint: string
}

/** 两组件 + 一个整合任务 + 三份产物（组件 A/B 与整合流出物）。 */
function twoComponentWorld(): World {
  const base = baseState(['组件 A', '组件 B', '整合任务'])
  const [c1, c2, integrationTask] = base.taskIds as [string, string, string]
  const first = withArtifact(base.state, c1, 'report/a.json', 'hash-a1')
  const second = withArtifact(first.state, c2, 'report/b.json', 'hash-b2')
  const flow = withArtifact(second.state, integrationTask, 'out/flow.zip', 'hash-flow')
  return { state: flow.state, c1, c2, integrationTask, a1: first.artifactId, a2: second.artifactId, flowFingerprint: 'hash-flow' }
}

/** 让组件任务按自己的判据真的走完验收（approve → claim → checkpoint → submit → verify pass），得到 completed。 */
function completeTask(state: MissionControl, taskId: string): MissionControl {
  let next = apply(state, { kind: 'task.approve', requestId: req(), taskId }, ctx('user', 'human'))
  next = apply(next, { kind: 'task.claim', requestId: req(), taskId }, ctx('lead', 'lead-1'))
  const attemptId = next.tasks[taskId]?.currentAttemptId
  if (attemptId === undefined) throw new Error(`任务 ${taskId} 没有被认领：各自验收走不下去`)
  const leaseVersion = next.attempts[attemptId]?.leaseVersion ?? 1
  next = apply(next, { kind: 'task.checkpoint', requestId: req(), taskId, checkpoint: checkpointPayload() }, ctx('lead', 'lead-1'))
  next = apply(next, { kind: 'task.submit', requestId: req(), taskId, leaseVersion }, ctx('lead', 'lead-1'))
  const criterionId = next.tasks[taskId]?.criteria[0]?.criterionId
  if (criterionId === undefined) throw new Error(`任务 ${taskId} 没有判据：无法登记自身验收`)
  return apply(next, {
    kind: 'task.verify',
    requestId: req(),
    taskId,
    criterionId,
    outcome: 'pass',
    method: 'node --test',
    methodVersion: '1',
    evidenceRefs: ['test/acceptance-environment.test.ts'],
  }, ctx('user', 'human'))
}

function planOf(world: World, overrides: Partial<IntegrationPlanInput> = {}): IntegrationPlanInput {
  return {
    integrationTaskId: world.integrationTask,
    componentRefs: [
      { taskId: world.c1, artifactId: world.a1, expectedVersion: '1', inputOutput: '原始数据 → 清洗表', versionsUnitsFormats: 'CSV/UTF-8；金额单位元' },
      { taskId: world.c2, artifactId: world.a2, expectedVersion: '1', inputOutput: '清洗表 → 分析报告', versionsUnitsFormats: 'Markdown；术语表 v1' },
    ],
    interfaces: [{ name: '清洗表接口', contract: '列名与口径冻结', consumers: [world.c2] }],
    sharedAssumptions: ['时区统一 UTC'],
    candidateRefs: [world.a1, world.a2],
    userFlow: '分析师在干净环境按文档跑完整流程并解释输出',
    ownerActorId: 'lead-1',
    ...overrides,
  }
}

function receiptOf(world: World, integrationId: string, overrides: Partial<IntegrationReceiptInput> = {}): IntegrationReceiptInput {
  return {
    integrationId,
    artifactFingerprint: world.flowFingerprint,
    componentRefs: [
      { ref: world.a1, version: '1' },
      { ref: world.a2, version: '1' },
    ],
    checks: [
      { kind: '真实调用流程', result: 'pass', note: '干净环境端到端跑通' },
      { kind: '用户使用例', result: 'pass', note: '按文档得到可解释输出' },
    ],
    reusedComponentRefs: [],
    reworkTaskIds: [],
    ...overrides,
  }
}

function challengeOf(overrides: Partial<Challenge> = {}): Challenge {
  return {
    challengeId: 'chl_test',
    missionId: 'mss_test',
    targetKind: 'claim',
    targetId: 'clm_1',
    quotedText: '结论 B 与 A 矛盾',
    contradictingEvidenceIds: ['ev_1'],
    affectedActionIds: ['act:c1-edit'],
    adjudicatorActorId: 'reviewer-1',
    raisedByActorId: 'member-1',
    outcome: 'open',
    severity: 'hard_conflict',
    createdAt: NOW,
    ...overrides,
  }
}

/* ------------------------------------------------ V5-08 环境接续（作业回执） */

test('V5-08 环境接续：远程作业已完成但本地无回执，先核对不重复启动；无关环境变化不全面重验', () => {
  // 拦错侧：服务侧说已完成、本地没有回执 —— 处置是核对与补登记，而不是重发原动作。
  const noReceipt = classifyFinding(observation({
    kind: 'in_flight_job',
    ref: 'job:train',
    observation: 'unobserved',
    job: job({ serviceJobId: 'svc-77', state: 'done', receiptPresent: false }),
  }))
  assert.deepEqual({ ...noReceipt.entry }, {
    ref: 'job:train',
    finding: 'job_done_no_receipt',
    action: FINDING_ACTIONS.job_done_no_receipt.action,
    allowedScope: FINDING_ACTIONS.job_done_no_receipt.allowedScope,
  }, '已完成但本地缺回执：查询真实结果、核对产物并补登记，绝不重发原动作')
  assert.equal(noReceipt.entry.allowedScope, '不重发原动作', '放行范围就是不重复启动远程作业')

  // 对照：回执在本地时走另一条处置（核对产物、更新清单），不按"缺回执"补登记。
  const withReceipt = classifyFinding(observation({
    kind: 'in_flight_job',
    ref: 'job:train',
    observation: 'unobserved',
    job: job({ serviceJobId: 'svc-77', state: 'done', receiptPresent: true }),
  }))
  assert.equal(withReceipt.entry.finding, 'changed', '回执在本地：按回执核对产物、更新清单')

  const { state, environmentId } = withEnvironment([
    item({ kind: 'in_flight_job', ref: 'job:train', sensitivity: 'variable' }),
    item({ ref: 'env:ws', sensitivity: 'immutable' }),
    item({ kind: 'dependency', ref: 'env:dep', sensitivity: 'variable' }),
  ], '运行测试脚本')
  const observations = [
    observation({
      kind: 'in_flight_job',
      ref: 'job:train',
      observation: 'unobserved',
      job: job({ serviceJobId: 'svc-77', state: 'done', receiptPresent: false }),
    }),
    observation({ ref: 'env:ws', sensitivity: 'immutable' }),
    observation({ kind: 'dependency', ref: 'env:dep', observation: 'changed' }),
  ]

  // 拦错侧：核对（补登记）没有做完之前，评估不许按"可继续"收口。
  const beforeReconcile = assess(state, environmentId, observations)
  assert.equal(beforeReconcile.ok, true, '评估在结构上应能完成，停在核对阶段是正常结果')
  if (!beforeReconcile.ok) return
  assert.equal(beforeReconcile.resume.phase, 'repair_or_reconcile', '作业回执未核对完：停在核对阶段而不是 ready')
  assert.equal(beforeReconcile.verdict.ready, false)
  assert.ok(beforeReconcile.verdict.notes.some((note) => note.includes('尚未完成')), '必须写明核对 / 补登记还没做完')
  assert.equal(beforeReconcile.verdict.scopeByRef['job:train'], '不重发原动作', '作业项的处理范围：不重复启动')

  // 放行侧：核对完成并重验受影响结果之后放行；无关项不全面重验。
  const afterReconcile = assess(state, environmentId, observations, {
    repairsSettled: true,
    revalidation: { ok: true, note: '回执已核对并补登记，受影响结果已重验' },
  })
  assert.equal(afterReconcile.ok, true)
  if (!afterReconcile.ok) return
  assert.equal(afterReconcile.resume.phase, 'ready')
  assert.equal(afterReconcile.verdict.ready, true)
  assert.deepEqual([...afterReconcile.verdict.revalidateRefs], ['env:dep', 'job:train'], '只重验受影响的作业回执与变化的依赖')
  assert.equal(afterReconcile.verdict.revalidateRefs.includes('env:ws'), false, '无关的不可变项不因旁处变化被全面重验')

  const plan = revalidationPlan(afterReconcile.resume)
  assert.deepEqual([...plan.unaffectedRefs], ['env:ws'], '无关项列在不受影响范围：不重跑')
  assert.deepEqual([...plan.revalidateRefs], ['env:dep', 'job:train'])
})

/* ------------------------------------------------ V5-09 环境接续（条件写入） */

test('V5-09 环境接续：核验后目标版本变化，条件写入或再检查阻止覆盖；无变化的合法写入可继续', () => {
  const target = 'file:///tmp/report.md'
  const { state, environmentId } = withEnvironment([item({ ref: target, sensitivity: 'immutable' })], '运行测试脚本')
  const done = assess(state, environmentId, [observation({ ref: target, sensitivity: 'immutable' })], {
    objectVersions: { [target]: 'v1' },
  })
  assert.equal(done.ok, true, '完整评估在结构上应通过')
  if (!done.ok) return
  assert.equal(done.resume.phase, 'ready', '核验一致时评估走到 ready，才有条件写入的前置')
  assert.deepEqual({ ...done.resume.objectVersions }, { [target]: 'v1' }, '核验点的对象版本要落进评估')

  // 拦错侧①：核验后目标版本变化 —— 条件写入 / 再检查阻止覆盖。
  const drifted = resumeIsCurrent(done.resume, { objectVersions: { [target]: 'v2' } }, NOW + 2_000)
  assert.equal(drifted.ok, false, '核验后目标从 v1 变为 v2：检查不再有效，阻止覆盖')
  assert.match(drifted.reason, /阻止覆盖/)
  assert.equal(drifted.grantsExecution, false, '即使检查有效也不构成执行权（§33.3）')
  const conflict = guardedWrite(done.resume, target, 'v1', 'v2', { conditionalWriteSupported: true })
  assert.equal(conflict.ok, false, '预期版本对不上就停下，而不是覆盖')
  assert.match(conflict.reason, /阻止覆盖/)

  // 拦错侧②：出现评估未记录的对象、清单被修订 —— 都要"再检查"而不是照原结论录取。
  const newObject = resumeIsCurrent(done.resume, { objectVersions: { [target]: 'v1', 'file:///tmp/other.md': 'v1' } }, NOW + 2_000)
  assert.equal(newObject.ok, false, '出现评估未记录的对象：不假装它不影响本次恢复')
  const revisedManifest = resumeIsCurrent(done.resume, { environmentVersion: 2 }, NOW + 2_000)
  assert.equal(revisedManifest.ok, false, '清单已修订到 v2：评估绑定 v1，要重新检查再录取')

  // 放行侧：没有变化时合法写入可继续 —— 同时说明"检查有效"不等于执行权。
  const stillCurrent = resumeIsCurrent(done.resume, { objectVersions: { [target]: 'v1' } }, NOW + 2_000)
  assert.equal(stillCurrent.ok, true, '对象版本未变、时效内：检查仍然有效')
  assert.equal(stillCurrent.grantsExecution, false, '检查有效不等于执行权，受管动作仍需当前票据')
  const legal = guardedWrite(done.resume, target, 'v1', 'v1', { conditionalWriteSupported: true })
  assert.equal(legal.ok, true, '版本一致且具备条件写入能力：合法写入可继续')
  assert.equal(legal.caveat, undefined, '有条件写入能力时不带"时点观察"告警')
})

/* ------------------------------------------------ V5-10 团队裁决 */

test('V5-10 团队裁决：条件不同的两个结论同时保留；必要前提冲突只阻断相关动作，不冻结全队', () => {
  const sideA: DisputeSide = {
    label: 'A',
    conditions: ['Python 3.11', 'UTC'],
    versions: { 'report/a.json': 'v2' },
    methodRefs: ['validator-a'],
  }
  const sideB: DisputeSide = { ...sideA, label: 'B', conditions: ['Python 3.12', 'UTC'], methodRefs: ['validator-b'] }

  // 放行侧：两侧条件不同 —— 各自成立范围同时保留，不制造"同一条件的矛盾"。
  const different = compareDisputeSides(sideA, sideB)
  assert.equal(different.sameCondition, false, '条件不同：不能把两个结论当成同一条件的矛盾')
  assert.deepEqual([...different.differing].sort(), ['条件仅 A 声明：Python 3.11', '条件仅 B 声明：Python 3.12'], '两侧各自的条件都要被点出')
  const retained: AdjudicationInput = {
    challengeId: 'chl_cond',
    comparison: different,
    scope: '报告口径在两种 Python 版本下的解释',
    evidenceRefs: ['ev_a', 'ev_b'],
    temporaryChoice: '两个范围分别沿用各自结论',
    retainedAlternative: 'Python 3.12 范围的结论同样保留',
    ownerActorId: 'lead-1',
    remainingBudgetNote: '探索预算还剩 2 次小试验',
    reopenConditions: ['出现跨版本判别试验'],
    impactScope: '只影响这两个范围的解释，不阻断交付任务',
  }
  assert.equal(adjudicationVerdict(retained), 'both_scopes_retained', '条件不同 → 两个结论同时保留')
  assert.equal(validateAdjudication(retained).ok, true, '保留各自范围也要写明未被排除的另一侧')

  // 拦错侧：条件相同时不许把两个结论包装成"各自成立"，只能是有界临时选择。
  const same = compareDisputeSides(sideA, { ...sideA, label: 'B', methodRefs: ['validator-b'] })
  assert.equal(same.sameCondition, true)
  assert.equal(adjudicationVerdict({ ...retained, comparison: same }), 'temporary_choice', '条件相同不能声称"两个结论各自成立"')
  assert.equal(
    validateAdjudication({ ...retained, comparison: same, retainedAlternative: undefined }).ok,
    false,
    '没有判别证据时必须写明未排除的一方，不能制造一致意见',
  )

  // 拦错侧 / 放行侧：必要前提冲突只阻断被质疑的动作，无关工作不被冻结。
  const evidence = classifyDispute({ concern: 'fact' })
  assert.equal(evidence.blocking, 'evidence_premises')
  const hard = disputeBlockingScope(challengeOf(), evidence)
  assert.equal(hard.blocks, true, '必要前提的硬冲突要挡住相关动作')
  assert.deepEqual([...hard.scope], ['act:c1-edit'], '阻断范围恰好是被质疑的动作，不扩大到全队其它动作')
  assert.ok(hard.reason.includes('不冻结全队'))

  const soft = disputeBlockingScope(challengeOf({ severity: 'under_evidenced' }), evidence)
  assert.equal(soft.blocks, false, '证据不足的质疑是待审意见：保留记录但不阻断执行')
  assert.deepEqual([...soft.scope], [])
  const noAction = disputeBlockingScope(challengeOf({ affectedActionIds: [] }), evidence)
  assert.equal(noAction.blocks, false, '没有相关动作时不能凭空推出"冻结全队"')

  const authority = disputeBlockingScope(challengeOf({ affectedActionIds: ['act:deploy'] }), classifyDispute({ concern: 'permission' }))
  assert.equal(authority.blocks, true, '权限 / 硬约束冲突同样只挡对应动作')
  assert.deepEqual([...authority.scope], ['act:deploy'])
  const route = disputeBlockingScope(challengeOf(), classifyDispute({ concern: 'route_priority' }))
  assert.equal(route.blocks, false, '路线取舍争论不冻结执行范围')
})

/* ------------------------------------------------ V5-11 整体验收 */

test('V5-11 整体验收：两组件各自通过但组合失败，阻止整体发布并局部返工；可复用部分无需重复全做', () => {
  const world = twoComponentWorld()
  let memberState = completeTask(world.state, world.c1)
  memberState = completeTask(memberState, world.c2)
  assert.equal(memberState.tasks[world.c1]?.status, 'completed', '组件 A 按自己的判据通过')
  assert.equal(memberState.tasks[world.c2]?.status, 'completed', '组件 B 按自己的判据通过')

  const registered = registerIntegrationPlan(memberState, planOf(world), { actorId: 'lead-1', now: NOW })
  assert.equal(registered.ok, true, '整合计划应能登记：拆分时声明接口与整体使用例')
  if (!registered.ok) return
  assert.deepEqual(
    [...integrationComponentDrift(registered.state, registered.plan.integrationId)],
    [],
    '两个组件自己的成果仍在计划声明的确切版本上：组合失败不等于成员侧失败',
  )

  // 拦错侧：组合检查失败 + 局部返工 —— 回执落盘但不发发布资格。
  const failed = assembleIntegrationReceipt(registered.state, receiptOf(world, registered.plan.integrationId, {
    checks: [{ kind: '真实调用流程', result: 'fail', note: '两组件单独通过，组合输出口径不一致' }],
    reusedComponentRefs: [world.a2],
    reworkTaskIds: [world.c1],
  }), { actorId: 'lead-1', now: NOW + 1_000 })
  assert.equal(failed.ok, true, '失败的整体结果本身要留下记录')
  if (!failed.ok) return
  assert.equal(failed.receipt.publishEligible, false, '组合失败：阻止整体发布')
  assert.ok(failed.blockers.some((blocker) => blocker.includes('fail')), '阻断原因要写明是哪条整体检查失败')
  assert.ok(failed.blockers.some((blocker) => blocker.includes('返工')), '阻断原因要写明局部返工未清')
  assert.deepEqual([...failed.receipt.reworkTaskIds], [world.c1], '局部返工落在真实任务上')
  assert.deepEqual([...failed.receipt.reusedComponentRefs], [world.a2], '可复用部分登记在回执里，无需重做')
  assert.equal(failed.receipt.reworkTaskIds.includes(world.c2), false, '复用的组件 B 不在返工名单里')

  // 成员通过不能投票变成整体通过：资格只看整体检查。
  const memberVote = evaluateIntegrationEligibility({
    checks: [{ kind: '真实调用流程', result: 'fail', note: '两组件单独通过，组合输出口径不一致' }],
    reworkTaskIds: [],
  })
  assert.equal(
    memberVote.eligible,
    false,
    `组件任务都已 completed（${memberState.tasks[world.c1]?.status}/${memberState.tasks[world.c2]?.status}），整体检查失败时仍不发发布资格`,
  )

  // 拦错侧（复用边界）：任务在返工名单里的组件，旧结果不能标成"可复用"。
  const overlap = assembleIntegrationReceipt(registered.state, receiptOf(world, registered.plan.integrationId, {
    reusedComponentRefs: [world.a1],
    reworkTaskIds: [world.c1],
  }), { actorId: 'lead-1', now: NOW + 2_000 })
  assert.equal(overlap.ok, false, '既返工又复用同一组件必须被拒')
  if (overlap.ok) return
  assert.ok(overlap.problems.some((problem) => problem.includes('同时列入复用与局部返工')), '问题要指明复用与返工互斥的组件')

  // 放行侧：返工清完、整体检查全过 —— 复用组件 B 不必重跑，发发布资格。
  const released = assembleIntegrationReceipt(registered.state, receiptOf(world, registered.plan.integrationId, {
    reusedComponentRefs: [world.a2],
    reworkTaskIds: [],
  }), { actorId: 'lead-1', now: NOW + 3_000 })
  assert.equal(released.ok, true, '组合通过且无未清返工时整体回执应能成立')
  if (!released.ok) return
  assert.equal(released.receipt.publishEligible, true, '整体检查全过：发发布资格')
  assert.deepEqual([...released.receipt.reusedComponentRefs], [world.a2], '复用部分按适用范围生效，不必重复全做')
  assert.ok(released.warnings.some((warning) => warning.includes('适用范围')), '复用的通过证据只按适用范围生效')
})
