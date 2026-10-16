/**
 * v0.5 outcome + integration 模块用例（设计稿 §30、§34；参考 §36.2 V5-01/V5-02/V5-10/V5-11）。
 *
 * 每个用例正反例成对：先钉住合法路径，再钉住同形的非法路径必须被拒。
 * 夹具通过既有命令面（fixtures.apply）搭出真实状态，不手拼半截记录。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { MissionControl } from '../src/core/control.ts'
import type { Challenge } from '../src/core/entities.ts'
import { apply, ctx, draftMission, freshState, NOW, req, taskPayload, withClaimedTask } from './fixtures.ts'
import type { OutcomeContractInput, OutcomeReviewAnswer } from '../src/core/outcome.ts'
import {
  buildOutcomeReview,
  classifyOutcomeChange,
  commitOutcomeReview,
  outcomeReviewRequired,
  registerOutcomeContract,
  transitionEffectObservation,
  updateEffectObservation,
  validateOutcomeContract,
} from '../src/core/outcome.ts'
import type { AdjudicationInput, DisputeSide, IntegrationPlanInput, IntegrationReceiptInput } from '../src/core/integration.ts'
import {
  adjudicationVerdict,
  assembleIntegrationReceipt,
  classifyDispute,
  compareDisputeSides,
  disputeBlockingScope,
  evaluateIntegrationEligibility,
  integrationComponentDrift,
  integrationReceiptCurrent,
  registerIntegrationPlan,
  renderAdjudicationResolution,
  reviseIntegrationPlan,
  validateAdjudication,
} from '../src/core/integration.ts'

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

function contractInput(overrides: Partial<OutcomeContractInput> = {}): OutcomeContractInput {
  return {
    intendedUse: '分析师在换环境后重复运行同一分析流程',
    desiredOutcome: '流程在干净环境一次跑通并给出可解释输出',
    acceptanceExamples: [
      { kind: 'success', text: '新环境按文档运行得到与基线一致的关键结论' },
      { kind: 'boundary', text: '输入为空时给出明确报错而不是静默输出空表' },
      { kind: 'failure', text: '换机器后需要人工改三处路径才能运行' },
    ],
    metricsAndLimits: [
      { metric: '端到端运行成功率', represents: '流程可重复运行的稳定程度', cannotRepresent: '结论被用户实际采纳的程度' },
    ],
    hardConstraints: [{ text: '不得改动业务仓库', source: '用户 2026-10-14 指令' }],
    preferencesAndTradeoffs: [],
    unresolvedAssumptions: [{ text: '目标环境 Python ≥ 3.11', advanceScope: '先按当前锁定版本推进，发布前提早确认' }],
    ...overrides,
  }
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
    affectedActionIds: ['act-1', 'act-2'],
    adjudicatorActorId: 'reviewer-1',
    raisedByActorId: 'member-1',
    outcome: 'open',
    severity: 'hard_conflict',
    createdAt: NOW,
    ...overrides,
  }
}

// —— §30 目标效用 ——

test('§30.1 首次登记：合法契约成功；非法契约被拒且不落盘', () => {
  const { state } = baseState([])
  const registered = registerOutcomeContract(state, contractInput(), { actorId: 'lead-1', now: NOW, source: 'lead' })
  assert.equal(registered.ok, true)
  if (!registered.ok) return
  assert.equal(registered.change.kind, 'initial')
  assert.equal(registered.state.mission.outcome?.intendedUse, '分析师在换环境后重复运行同一分析流程')
  assert.equal(registered.state.mission.objectiveRevision, state.mission.objectiveRevision, '首次登记不推进目标版本：只是把已有指令写成契约')
  assert.equal(registered.state.revision, state.revision + 1)
  assert.equal(registered.state.events.at(-1)?.kind, 'outcome/registered')

  const rejected = registerOutcomeContract(state, contractInput({ intendedUse: '   ' }), { actorId: 'lead-1', now: NOW, source: 'lead' })
  assert.equal(rejected.ok, false)
  if (rejected.ok) return
  assert.ok(rejected.problems.some((problem) => problem.includes('intendedUse')))
  assert.equal(state.mission.outcome, undefined, '被拒不产生半截契约')
})

test('§30.1 验收例子三态：缺 success 拒绝；缺 boundary/failure 只告警；重复例子拒绝', () => {
  const { state } = baseState([])
  const missingSuccess = registerOutcomeContract(
    state,
    contractInput({ acceptanceExamples: [{ kind: 'boundary', text: '空输入报错' }, { kind: 'failure', text: '换机要改路径' }] }),
    { actorId: 'lead-1', now: NOW, source: 'lead' },
  )
  assert.equal(missingSuccess.ok, false)
  if (missingSuccess.ok) return
  assert.ok(missingSuccess.problems.some((problem) => problem.includes('success')))

  const onlySuccess = registerOutcomeContract(state, contractInput({ acceptanceExamples: [{ kind: 'success', text: '新环境跑通' }] }), {
    actorId: 'lead-1',
    now: NOW,
    source: 'lead',
  })
  assert.equal(onlySuccess.ok, true)
  if (!onlySuccess.ok) return
  assert.ok(onlySuccess.warnings.some((warning) => warning.includes('boundary')))
  assert.ok(onlySuccess.warnings.some((warning) => warning.includes('failure')), '不强迫填满表单但要有清晰告警')

  const duplicated = registerOutcomeContract(
    state,
    contractInput({ acceptanceExamples: [{ kind: 'success', text: '同一条' }, { kind: 'success', text: '同一条' }] }),
    { actorId: 'lead-1', now: NOW, source: 'lead' },
  )
  assert.equal(duplicated.ok, false)
  if (duplicated.ok) return
  assert.ok(duplicated.problems.some((problem) => problem.includes('重复')))
})

test('§30.1 指标映射：缺"无法代表"拒绝；mappingPending 与 observed 组合给出暂定告警', () => {
  const noLimit = validateOutcomeContract(contractInput({ metricsAndLimits: [{ metric: '成功率', represents: '稳定性', cannotRepresent: '  ' }] }))
  assert.ok(noLimit.problems.some((problem) => problem.includes('无法代表')))

  const pendingMetric = { metric: '成功率', represents: '稳定性', cannotRepresent: '用户采纳度', mappingPending: true }
  const pendingOk = validateOutcomeContract(contractInput({ metricsAndLimits: [pendingMetric] }))
  assert.equal(pendingOk.problems.length, 0, '指标映射本身可以尚待验证')

  const pendingObserved = validateOutcomeContract(
    contractInput({
      metricsAndLimits: [pendingMetric],
      effectObservation: { state: 'observed', note: '用户用了两周', evidenceRefs: ['ev_use_1'] },
    }),
  )
  assert.ok(pendingObserved.warnings.some((warning) => warning.includes('尚待验证')))
})

test('§30.1/V5-02 硬约束来源：模型偏好冒充被拒；用户来源通过；偏好未指定不编造', () => {
  const { state } = baseState([])
  const modelish = registerOutcomeContract(
    state,
    contractInput({ hardConstraints: [{ text: '优先选用我熟悉的框架', source: 'model preference' }] }),
    { actorId: 'lead-1', now: NOW, source: 'lead' },
  )
  assert.equal(modelish.ok, false)
  if (modelish.ok) return
  assert.ok(modelish.problems.some((problem) => problem.includes('模型偏好')))

  const userSourced = registerOutcomeContract(
    state,
    contractInput({
      hardConstraints: [{ text: '不得改动业务仓库', source: '用户 2026-10-14 指令' }],
      preferencesAndTradeoffs: [{ preference: '质量优先于速度' }],
    }),
    { actorId: 'lead-1', now: NOW, source: 'lead' },
  )
  assert.equal(userSourced.ok, true, '偏好未指定就保持未指定，不编造授权与权重')
})

test('§30.3 效果观测三态：不得跳过 outcome_pending；observed 必须带证据和说明', () => {
  const skip = transitionEffectObservation({ state: 'not_required' }, 'observed', { evidenceRefs: ['ev_1'], note: '看起来不错' })
  assert.equal(skip.ok, false)
  assert.ok(skip.problems.some((problem) => problem.includes('outcome_pending')))

  const declare = transitionEffectObservation({ state: 'not_required' }, 'outcome_pending', {})
  assert.equal(declare.ok, true)

  const noEvidence = transitionEffectObservation({ state: 'outcome_pending' }, 'observed', { note: '用户说好' })
  assert.equal(noEvidence.ok, false)
  assert.ok(noEvidence.problems.some((problem) => problem.includes('evidenceRefs')))

  const { state } = baseState([])
  const declared = registerOutcomeContract(state, contractInput({ effectObservation: { state: 'outcome_pending', note: '等待用户在新环境实际运行' } }), {
    actorId: 'lead-1',
    now: NOW,
    source: 'lead',
  })
  assert.equal(declared.ok, true)
  if (!declared.ok) return
  assert.equal(declared.contract.effectObservation.state, 'outcome_pending')

  const claimed = registerOutcomeContract(
    declared.state,
    contractInput({ effectObservation: { state: 'observed', note: '实际运行了四周' } }),
    { actorId: 'lead-1', now: NOW + 1000, source: 'lead' },
  )
  assert.equal(claimed.ok, false, '不带证据的 observed 在登记路径上也要被拒')
  if (claimed.ok) return
  assert.ok(claimed.problems.some((problem) => problem.includes('evidenceRefs')))

  const observed = updateEffectObservation(declared.state, 'observed', {
    actorId: 'lead-1',
    now: NOW + 2000,
    evidenceRefs: ['ev_use_1'],
    note: '用户在新环境连续运行四周，结论与基线一致',
  })
  assert.equal(observed.ok, true)
  if (!observed.ok) return
  assert.equal(observed.contract.effectObservation.state, 'observed')

  const downgrade = updateEffectObservation(observed.state, 'outcome_pending', { actorId: 'lead-1', now: NOW + 3000 })
  assert.equal(downgrade.ok, false, '降级需要授权主体')
  if (downgrade.ok) return
  assert.ok(downgrade.problems.some((problem) => problem.includes('授权')))
  const authorized = updateEffectObservation(observed.state, 'outcome_pending', { actorId: 'lead-1', now: NOW + 4000, authorizedBy: 'human-user' })
  assert.equal(authorized.ok, true)
})

test('§30.3 观测更新不推进 objectiveRevision（完成与效果观测分开）', () => {
  const { state } = baseState([])
  const declared = registerOutcomeContract(state, contractInput({ effectObservation: { state: 'outcome_pending', note: '等待真实使用' } }), {
    actorId: 'lead-1',
    now: NOW,
    source: 'lead',
  })
  assert.equal(declared.ok, true)
  if (!declared.ok) return
  const observed = updateEffectObservation(declared.state, 'observed', { actorId: 'lead-1', now: NOW + 1000, evidenceRefs: ['ev_use_1'], note: '连续使用四周' })
  assert.equal(observed.ok, true)
  if (!observed.ok) return
  assert.equal(observed.state.mission.objectiveRevision, declared.state.mission.objectiveRevision, '后期观测不能作废按版本绑定的整体验收')
  assert.equal(observed.state.revision, declared.state.revision + 1, '观测更新仍要留下提交记录')
  assert.equal(observed.state.events.at(-1)?.kind, 'outcome/effect-observed')
})

test('§30.2 实质修订需授权主体并推进版本；非实质修订只记录', () => {
  const claimed = withClaimedTask()
  const registered = registerOutcomeContract(claimed.state, contractInput(), { actorId: 'lead-1', now: NOW, source: 'lead' })
  assert.equal(registered.ok, true)
  if (!registered.ok) return

  const tweak = registerOutcomeContract(
    registered.state,
    contractInput({ metricsAndLimits: [{ metric: '端到端运行成功率', represents: '稳定性', cannotRepresent: '长期维护成本', mappingPending: true }] }),
    { actorId: 'lead-1', now: NOW + 1000, source: 'lead' },
  )
  assert.equal(tweak.ok, true, '既定范围内调整测量实现由 agent 继续处理')
  if (!tweak.ok) return
  assert.equal(tweak.change.kind, 'non_material')
  assert.equal(tweak.state.mission.objectiveRevision, registered.state.mission.objectiveRevision, '测量口径修订不动目标版本')
  assert.equal(tweak.state.tasks[claimed.taskId]?.status, 'leased', '非实质修订不打回在跑任务')

  const leadMaterial = registerOutcomeContract(registered.state, contractInput({ desiredOutcome: '把流程包装成对外服务' }), {
    actorId: 'lead-1',
    now: NOW + 2000,
    source: 'lead',
  })
  assert.equal(leadMaterial.ok, false)
  if (leadMaterial.ok) return
  assert.ok(leadMaterial.problems.some((problem) => problem.includes('实质修订')))

  const userMaterial = registerOutcomeContract(registered.state, contractInput({ desiredOutcome: '换一个用户目标' }), {
    actorId: 'human',
    now: NOW + 3000,
    source: 'user',
  })
  assert.equal(userMaterial.ok, true)
  if (!userMaterial.ok) return
  assert.equal(userMaterial.change.kind, 'material')
  assert.equal(userMaterial.state.mission.objectiveRevision, registered.state.mission.objectiveRevision + 1)
  assert.equal(userMaterial.state.tasks[claimed.taskId]?.status, 'planned', '目标版本推进后未完成任务回到 planned（§6.1）')
  assert.equal(userMaterial.state.tasks[claimed.taskId]?.currentAttemptId, undefined)
  assert.equal(userMaterial.state.attempts[claimed.attemptId]?.status, 'cancelled')
})

test('§30.2 变更分类：移除验收例子/降级观测是实质变更，指标修订只记录', () => {
  const { state } = baseState([])
  const registered = registerOutcomeContract(state, contractInput(), { actorId: 'lead-1', now: NOW, source: 'lead' })
  assert.equal(registered.ok, true)
  if (!registered.ok) return
  const report = classifyOutcomeChange(
    registered.contract,
    { ...registered.contract, acceptanceExamples: registered.contract.acceptanceExamples.filter((example) => example.kind !== 'failure') },
  )
  assert.equal(report.kind, 'material')
  assert.ok(report.materialChanges.some((change) => change.includes('移除验收例子')))
  const metrics = classifyOutcomeChange(registered.contract, {
    ...registered.contract,
    metricsAndLimits: [{ metric: '成功率', represents: '稳定性', cannotRepresent: '采纳度', mappingPending: true }],
  })
  assert.equal(metrics.kind, 'non_material')
  assert.ok(metrics.recordedDeltas.some((delta) => delta.includes('metricsAndLimits')))
})

test('§30.2 复核触发器：一致不额外审查；不一致/里程碑/用户纠正/整体验收前触发', () => {
  const { state } = baseState([])
  const dueForAcceptance = outcomeReviewRequired(state, { beforeOverallAcceptance: true })
  assert.equal(dueForAcceptance.required, true)
  assert.ok(dueForAcceptance.triggers.includes('pre_acceptance'))
  assert.ok(dueForAcceptance.triggers.includes('no_contract'), '要整体验收却没有契约：先自动整理')

  const daily = outcomeReviewRequired(state, {})
  assert.equal(daily.required, false, '日常小步骤复用已生效契约')

  const consistent = outcomeReviewRequired(state, { metricVsExperience: 'consistent' })
  assert.equal(consistent.required, false, 'V5-01：指标与效果一致时不制造额外审查')

  const divergent = outcomeReviewRequired(state, { metricVsExperience: 'divergent' })
  assert.equal(divergent.required, true)
  assert.ok(divergent.triggers.includes('metric_experience_divergence'))

  const multi = outcomeReviewRequired(state, { milestoneReached: true, userCorrection: true, routeChangePlanned: true })
  assert.equal(multi.required, true)
  assert.deepEqual([...multi.triggers].sort(), ['milestone', 'no_contract', 'route_change', 'user_correction'], '无契约时任何触发都先补 no_contract')
})

test('§30.2 复核记录：四问齐全、未知保留未知、无证据效用分数被拒', () => {
  const { state } = baseState([])
  const answers: OutcomeReviewAnswer[] = [
    { question: 'effect_changed', answer: '本阶段缩短了新环境上手时间', evidenceRefs: ['ev_1'] },
    { question: 'metric_evidence', answer: '成功率提高但样本只有三次', evidenceRefs: ['ev_2'] },
    { question: 'costs_and_regressions', answer: '维护脚本变长', evidenceRefs: ['ev_3'] },
    { question: 'route_still_serves', answer: '当前路线仍服务于原任务', evidenceRefs: ['ev_4'] },
  ]
  const missing = buildOutcomeReview(state, { triggers: ['pre_acceptance'], answers: answers.slice(1), conclusion: 'contract_holds' }, { actorId: 'lead-1', now: NOW })
  assert.equal(missing.ok, false)
  if (missing.ok) return
  assert.ok(missing.problems.some((problem) => problem.includes('effect_changed')))

  const noEvidence = buildOutcomeReview(
    state,
    { triggers: ['pre_acceptance'], answers: answers.map((answer) => (answer.question === 'metric_evidence' ? { ...answer, evidenceRefs: [] } : answer)), conclusion: 'contract_holds' },
    { actorId: 'lead-1', now: NOW },
  )
  assert.equal(noEvidence.ok, false)

  const scored = buildOutcomeReview(
    state,
    {
      triggers: ['metric_experience_divergence'],
      answers: answers.map((answer) => (answer.question === 'costs_and_regressions' ? { ...answer, evidenceRefs: [], answer: '效用分数 8/10' } : answer)),
      conclusion: 'contract_needs_revision',
    },
    { actorId: 'lead-1', now: NOW },
  )
  assert.equal(scored.ok, false)
  if (scored.ok) return
  assert.ok(scored.problems.some((problem) => problem.includes('效用分数')))

  const withUnknown = buildOutcomeReview(
    state,
    { triggers: ['milestone'], answers: answers.map((answer) => (answer.question === 'metric_evidence' ? { ...answer, evidenceRefs: [], unknown: true } : answer)), conclusion: 'contract_holds' },
    { actorId: 'lead-1', now: NOW },
  )
  assert.equal(withUnknown.ok, true, '未知项保留未知，不要求虚构效用分数')
  if (!withUnknown.ok) return
  const committed = commitOutcomeReview(state, withUnknown.record)
  assert.equal(committed.revision, state.revision + 1)
  assert.equal(committed.events.at(-1)?.kind, 'outcome/reviewed')
})

// —— §34 整合与争议 ——

test('§34.3 整合计划登记：拆分时声明接口与整体使用例；非法输入被拒', () => {
  const world = twoComponentWorld()
  const registered = registerIntegrationPlan(world.state, planOf(world), { actorId: 'lead-1', now: NOW })
  assert.equal(registered.ok, true)
  if (!registered.ok) return
  assert.equal(registered.state.integrations[registered.plan.integrationId]?.userFlow, '分析师在干净环境按文档跑完整流程并解释输出')
  assert.equal(registered.state.events.at(-1)?.kind, 'integration/planned')

  const noTask = registerIntegrationPlan(world.state, planOf(world, { integrationTaskId: 'task_missing' }), { actorId: 'lead-1', now: NOW })
  assert.equal(noTask.ok, false)
  const noConsumer = registerIntegrationPlan(
    world.state,
    planOf(world, { interfaces: [{ name: '清洗表接口', contract: '冻结', consumers: [] }] }),
    { actorId: 'lead-1', now: NOW },
  )
  assert.equal(noConsumer.ok, false)
  if (noConsumer.ok) return
  assert.ok(noConsumer.problems.some((problem) => problem.includes('消费者')))
  const noFlow = registerIntegrationPlan(world.state, planOf(world, { userFlow: '  ' }), { actorId: 'lead-1', now: NOW })
  assert.equal(noFlow.ok, false)
})

test('§34.3 唯一整合任务 owner：同一整合任务不能出现在两份计划', () => {
  const world = twoComponentWorld()
  const first = registerIntegrationPlan(world.state, planOf(world), { actorId: 'lead-1', now: NOW })
  assert.equal(first.ok, true)
  if (!first.ok) return
  const second = registerIntegrationPlan(first.state, planOf(world), { actorId: 'reviewer-1', now: NOW + 1000 })
  assert.equal(second.ok, false)
  if (second.ok) return
  assert.ok(second.problems.some((problem) => problem.includes('唯一')))

  const base = baseState(['组件 A', '组件 B', '整合任务', '整合任务 2'])
  const [c1, c2, it, it2] = base.taskIds as [string, string, string, string]
  const art1 = withArtifact(base.state, c1, 'report/a.json', 'hash-a1')
  const art2 = withArtifact(art1.state, c2, 'report/b.json', 'hash-b2')
  const world2: World = { state: art2.state, c1, c2, integrationTask: it, a1: art1.artifactId, a2: art2.artifactId, flowFingerprint: 'none' }
  const one = registerIntegrationPlan(world2.state, planOf(world2), { actorId: 'lead-1', now: NOW })
  assert.equal(one.ok, true)
  if (!one.ok) return
  const other = registerIntegrationPlan(one.state, planOf(world2, { integrationTaskId: it2, candidateRefs: [] }), { actorId: 'lead-1', now: NOW + 1000 })
  assert.equal(other.ok, true, '不同整合任务可以有各自计划')
})

test('§34.3 确切候选版本：漂移与未登记产物被拒；链头版本通过', () => {
  const world = twoComponentWorld()
  const stale = registerIntegrationPlan(
    world.state,
    planOf(world, {
      componentRefs: [{ taskId: world.c1, artifactId: world.a1, expectedVersion: '2', inputOutput: 'x', versionsUnitsFormats: 'y' }],
    }),
    { actorId: 'lead-1', now: NOW },
  )
  assert.equal(stale.ok, false)
  if (stale.ok) return
  assert.ok(stale.problems.some((problem) => problem.includes('不一致')))

  const missing = registerIntegrationPlan(
    world.state,
    planOf(world, {
      componentRefs: [{ taskId: world.c1, artifactId: 'art_missing', expectedVersion: '1', inputOutput: 'x', versionsUnitsFormats: 'y' }],
    }),
    { actorId: 'lead-1', now: NOW },
  )
  assert.equal(missing.ok, false)
  if (missing.ok) return
  assert.ok(missing.problems.some((problem) => problem.includes('未在台账登记')))

  const registered = registerIntegrationPlan(world.state, planOf(world), { actorId: 'lead-1', now: NOW })
  assert.equal(registered.ok, true)
  if (!registered.ok) return
  const upgraded = withArtifact(registered.state, world.c1, 'report/a.json', 'hash-a1-v2')
  const superseded = reviseIntegrationPlan(upgraded.state, registered.plan.integrationId, planOf(world, { candidateRefs: [] }), { actorId: 'lead-1', now: NOW + 1000 })
  assert.equal(superseded.ok, false, '计划引用已被取代的版本要被拒')
  if (superseded.ok) return
  assert.ok(superseded.problems.some((problem) => problem.includes('取代')))

  const v2 = upgraded.state.artifacts['report/a.json']
  const head = v2?.[v2.length - 1]
  assert.ok(head !== undefined)
  const fresh = reviseIntegrationPlan(
    upgraded.state,
    registered.plan.integrationId,
    planOf(world, {
      componentRefs: [
        { taskId: world.c1, artifactId: head.artifactId, expectedVersion: String(head.version), inputOutput: '原始数据 → 清洗表', versionsUnitsFormats: 'CSV/UTF-8' },
        { taskId: world.c2, artifactId: world.a2, expectedVersion: '1', inputOutput: '清洗表 → 报告', versionsUnitsFormats: 'Markdown' },
      ],
      candidateRefs: [head.artifactId, world.a2],
    }),
    { actorId: 'lead-1', now: NOW + 2000 },
  )
  assert.equal(fresh.ok, true, '链头确切版本可以登记')
  if (!fresh.ok) return
  assert.deepEqual(integrationComponentDrift(upgraded.state, registered.plan.integrationId), [
    `组件 ${world.a1}（计划声明 1）已被链头 v2 取代：先修订计划再整合`,
  ])
})

test('§34.3 计划修订：记录替换保留登记时间，受影响任务给出通知集合', () => {
  const world = twoComponentWorld()
  const registered = registerIntegrationPlan(world.state, planOf(world), { actorId: 'lead-1', now: NOW })
  assert.equal(registered.ok, true)
  if (!registered.ok) return
  const revised = reviseIntegrationPlan(
    registered.state,
    registered.plan.integrationId,
    planOf(world, { interfaces: [{ name: '清洗表接口', contract: '列名、口径与单位冻结', consumers: [world.c2, world.integrationTask] }] }),
    { actorId: 'lead-1', now: NOW + 1000 },
  )
  assert.equal(revised.ok, true)
  if (!revised.ok) return
  assert.equal(revised.plan.integrationId, registered.plan.integrationId)
  assert.equal(revised.plan.createdAt, registered.plan.createdAt, '修订不重置登记时间')
  assert.ok(revised.changed.some((change) => change.includes('接口')))
  assert.ok(revised.affectedTaskIds.includes(world.c2), '消费者要收到接口变动通知')
  assert.ok(revised.affectedTaskIds.includes(world.c1) && revised.affectedTaskIds.includes(world.integrationTask))
  assert.deepEqual([...revised.affectedTaskIds], [...revised.affectedTaskIds].sort(), '受影响任务按 id 排序')

  const unknown = reviseIntegrationPlan(registered.state, 'intg_missing', planOf(world), { actorId: 'lead-1', now: NOW })
  assert.equal(unknown.ok, false)
})

test('§34.4 整体回执：全 pass 且无返工 → publishEligible；版本绑定落盘', () => {
  const world = twoComponentWorld()
  const registered = registerIntegrationPlan(world.state, planOf(world), { actorId: 'lead-1', now: NOW })
  assert.equal(registered.ok, true)
  if (!registered.ok) return
  const assembled = assembleIntegrationReceipt(registered.state, receiptOf(world, registered.plan.integrationId), { actorId: 'lead-1', now: NOW + 1000 })
  assert.equal(assembled.ok, true)
  if (!assembled.ok) return
  assert.equal(assembled.receipt.publishEligible, true)
  assert.deepEqual(assembled.blockers, [])
  assert.equal(assembled.receipt.objectiveRevision, registered.state.mission.objectiveRevision, '回执绑定 OutcomeContract 版本')
  assert.equal(assembled.receipt.criteriaRevision, registered.state.tasks[world.integrationTask]?.criteriaRevision)
  assert.ok(assembled.state.integrationReceipts[assembled.receipt.receiptId] !== undefined)
  assert.equal(assembled.state.events.at(-1)?.kind, 'integration/receipt-assembled')
})

test('§34.4/V5-11 两组件通过但组合失败：拒发布并局部返工；返工未清不发资格', () => {
  const world = twoComponentWorld()
  const rework = baseState(['跨组件缺口修复'])
  const reworkState = apply(world.state, { kind: 'task.propose', requestId: req(), task: taskPayload({ title: '跨组件缺口修复' }) })
  const reworkTaskId = Object.keys(reworkState.tasks).find((id) => !Object.keys(world.state.tasks).includes(id))
  assert.ok(reworkTaskId !== undefined && reworkTaskId !== rework.taskIds[0])
  const registered = registerIntegrationPlan(reworkState, planOf(world), { actorId: 'lead-1', now: NOW })
  assert.equal(registered.ok, true)
  if (!registered.ok) return

  const failed = assembleIntegrationReceipt(
    registered.state,
    receiptOf(world, registered.plan.integrationId, {
      checks: [
        { kind: '真实调用流程', result: 'fail', note: '两组件单独通过但组合输出口径不一致' },
        { kind: '用户使用例', result: 'pass', note: '报告本身可读' },
      ],
      reworkTaskIds: [reworkTaskId],
    }),
    { actorId: 'lead-1', now: NOW + 1000 },
  )
  assert.equal(failed.ok, true, '失败的整体结果本身要落盘')
  if (!failed.ok) return
  assert.equal(failed.receipt.publishEligible, false)
  assert.ok(failed.blockers.some((blocker) => blocker.includes('fail')))
  assert.ok(failed.blockers.some((blocker) => blocker.includes('返工')))

  const pendingRework = assembleIntegrationReceipt(registered.state, receiptOf(world, registered.plan.integrationId, { reworkTaskIds: [reworkTaskId] }), {
    actorId: 'lead-1',
    now: NOW + 2000,
  })
  assert.equal(pendingRework.ok, true)
  if (!pendingRework.ok) return
  assert.equal(pendingRework.receipt.publishEligible, false, '局部返工未清不能根据成员通过发资格')
})

test('§34.4 成员通过不能投票：资格只由整体检查与返工状态决定', () => {
  const allPass = evaluateIntegrationEligibility({ checks: [{ kind: '整体使用例', result: 'pass', note: '跑通' }], reworkTaskIds: [] })
  assert.equal(allPass.eligible, true)
  const unknown = evaluateIntegrationEligibility({ checks: [{ kind: '整体使用例', result: 'unknown', note: '环境对不上' }], reworkTaskIds: [] })
  assert.equal(unknown.eligible, false)
  assert.ok(unknown.blockers.some((blocker) => blocker.includes('unknown')))
  const empty = evaluateIntegrationEligibility({ checks: [], reworkTaskIds: [] })
  assert.equal(empty.eligible, false, '没有整体检查时，成员各自通过也不构成整体通过')
})

test('§34.4 指纹绑定与组件清单：未绑定/缺项/未登记版本被拒', () => {
  const world = twoComponentWorld()
  const registered = registerIntegrationPlan(world.state, planOf(world), { actorId: 'lead-1', now: NOW })
  assert.equal(registered.ok, true)
  if (!registered.ok) return
  const planId = registered.plan.integrationId

  const unbound = assembleIntegrationReceipt(registered.state, receiptOf(world, planId, { artifactFingerprint: 'sha-unknown' }), { actorId: 'lead-1', now: NOW + 1000 })
  assert.equal(unbound.ok, false)
  if (unbound.ok) return
  assert.ok(unbound.problems.some((problem) => problem.includes('指纹')))

  const noisy = withArtifact(registered.state, world.c1, 'noise.txt', 'hash-noise')
  const unrelated = assembleIntegrationReceipt(noisy.state, receiptOf(world, planId, { artifactFingerprint: 'hash-noise' }), { actorId: 'lead-1', now: NOW + 2000 })
  assert.equal(unrelated.ok, false, '与计划/整合任务/组件都无关的产物不能当整合结果')

  const missingComponent = assembleIntegrationReceipt(
    registered.state,
    receiptOf(world, planId, { componentRefs: [{ ref: world.a1, version: '1' }] }),
    { actorId: 'lead-1', now: NOW + 3000 },
  )
  assert.equal(missingComponent.ok, false)
  if (missingComponent.ok) return
  assert.ok(missingComponent.problems.some((problem) => problem.includes('缺少计划内的组件')))

  const unregistered = assembleIntegrationReceipt(
    registered.state,
    receiptOf(world, planId, { componentRefs: [{ ref: world.a1, version: '2' }, { ref: world.a2, version: '1' }] }),
    { actorId: 'lead-1', now: NOW + 4000 },
  )
  assert.equal(unregistered.ok, false)
  if (unregistered.ok) return
  assert.ok(unregistered.problems.some((problem) => problem.includes('找不到对应版本')))
})

test('§34.4 复用与返工互斥：同一组件不能既复用又返工', () => {
  const world = twoComponentWorld()
  const reworkState = apply(world.state, { kind: 'task.propose', requestId: req(), task: taskPayload({ title: '局部返工' }) })
  const reworkTaskId = Object.keys(reworkState.tasks).find((id) => !Object.keys(world.state.tasks).includes(id))
  assert.ok(reworkTaskId !== undefined)
  const registered = registerIntegrationPlan(reworkState, planOf(world), { actorId: 'lead-1', now: NOW })
  assert.equal(registered.ok, true)
  if (!registered.ok) return

  const overlap = assembleIntegrationReceipt(
    registered.state,
    receiptOf(world, registered.plan.integrationId, { reusedComponentRefs: [world.a1], reworkTaskIds: [world.c1] }),
    { actorId: 'lead-1', now: NOW + 1000 },
  )
  assert.equal(overlap.ok, false, '组件的任务在返工名单里，旧结果不能原样复用')
  if (overlap.ok) return
  assert.ok(overlap.problems.some((problem) => problem.includes('复用')))

  const strayReuse = assembleIntegrationReceipt(
    registered.state,
    receiptOf(world, registered.plan.integrationId, { reusedComponentRefs: ['art_not_there'] }),
    { actorId: 'lead-1', now: NOW + 2000 },
  )
  assert.equal(strayReuse.ok, false)

  const legalReuse = assembleIntegrationReceipt(
    registered.state,
    receiptOf(world, registered.plan.integrationId, { reusedComponentRefs: [world.a1], reworkTaskIds: [reworkTaskId] }),
    { actorId: 'lead-1', now: NOW + 3000 },
  )
  assert.equal(legalReuse.ok, true)
  if (!legalReuse.ok) return
  assert.equal(legalReuse.receipt.publishEligible, false, '还有返工就不发资格，但组件结果按适用范围保留')
  assert.ok(legalReuse.warnings.some((warning) => warning.includes('适用范围')))
})

test('§34.4 回执时效：整合后内容改变或契约版本修订 → 不再证明当前整体', () => {
  const world = twoComponentWorld()
  const registered = registerIntegrationPlan(world.state, planOf(world), { actorId: 'lead-1', now: NOW })
  assert.equal(registered.ok, true)
  if (!registered.ok) return
  const assembled = assembleIntegrationReceipt(registered.state, receiptOf(world, registered.plan.integrationId), { actorId: 'lead-1', now: NOW + 1000 })
  assert.equal(assembled.ok, true)
  if (!assembled.ok) return
  const receiptId = assembled.receipt.receiptId
  assert.equal(integrationReceiptCurrent(assembled.state, receiptId).current, true)

  const upgraded = withArtifact(assembled.state, world.c1, 'report/a.json', 'hash-a1-v2')
  const afterChange = integrationReceiptCurrent(upgraded.state, receiptId)
  assert.equal(afterChange.current, false)
  assert.ok(afterChange.changes.some((change) => change.includes('链头')), '整合后内容改变，旧证据只能按适用范围复用')

  const initial = registerOutcomeContract(assembled.state, contractInput(), { actorId: 'lead-1', now: NOW + 2000, source: 'lead' })
  assert.equal(initial.ok, true)
  if (!initial.ok) return
  const revised = registerOutcomeContract(initial.state, contractInput({ desiredOutcome: '换成团队级交付' }), { actorId: 'human', now: NOW + 3000, source: 'user' })
  assert.equal(revised.ok, true)
  if (!revised.ok) return
  const afterRevision = integrationReceiptCurrent(revised.state, receiptId)
  assert.equal(afterRevision.current, false)
  assert.ok(afterRevision.changes.some((change) => change.includes('objectiveRevision')))
})

test('§34.1 争议分类：五类负责人与处理方式；整合冲突定位计划 owner', () => {
  const world = twoComponentWorld()
  const registered = registerIntegrationPlan(world.state, planOf(world), { actorId: 'lead-1', now: NOW })
  assert.equal(registered.ok, true)
  if (!registered.ok) return

  const authority = classifyDispute({ concern: 'permission' })
  assert.equal(authority.handler, 'supervisor')
  assert.equal(authority.kind, 'authority_block')
  assert.equal(classifyDispute({ concern: 'hard_constraint' }).handler, 'supervisor')
  assert.equal(classifyDispute({ concern: 'execution_identity' }).handler, 'supervisor')

  const evidence = classifyDispute({ concern: 'fact' })
  assert.equal(evidence.handler, 'challenge_adjudicator')
  assert.equal(evidence.blocking, 'evidence_premises')

  assert.equal(classifyDispute({ concern: 'route_priority' }).handler, 'lead')
  assert.equal(classifyDispute({ concern: 'resource_tradeoff' }).handler, 'lead')
  assert.equal(classifyDispute({ concern: 'user_goal' }).handler, 'user')

  const interfaceConflict = classifyDispute({ concern: 'component_interface', targetRef: world.c2 }, registered.state)
  assert.equal(interfaceConflict.handler, 'integration_owner')
  assert.equal(interfaceConflict.integrationId, registered.plan.integrationId)
  assert.equal(interfaceConflict.ownerActorId, 'lead-1')
  const noPlan = classifyDispute({ concern: 'version_conflict', targetRef: 'intg_none' }, registered.state)
  assert.equal(noPlan.integrationId, undefined, '没有计划时先登记计划再协调')
})

test('§34.2 阻断范围：必要前提冲突只挡相关动作；待审意见不冻结', () => {
  const world = twoComponentWorld()
  const registered = registerIntegrationPlan(world.state, planOf(world), { actorId: 'lead-1', now: NOW })
  assert.equal(registered.ok, true)
  if (!registered.ok) return

  const method = classifyDispute({ concern: 'method' })
  const hard = disputeBlockingScope(challengeOf(), method)
  assert.equal(hard.blocks, true)
  assert.deepEqual(hard.scope, ['act-1', 'act-2'], '只阻断被质疑动作，不推出全队范围')
  assert.ok(hard.reason.includes('不冻结全队'))

  const soft = disputeBlockingScope(challengeOf({ severity: 'under_evidenced' }), method)
  assert.equal(soft.blocks, false, '缺证据的质疑是待审意见，不冻结执行')

  const authority = disputeBlockingScope(challengeOf(), classifyDispute({ concern: 'permission' }))
  assert.equal(authority.blocks, true)
  const route = disputeBlockingScope(challengeOf(), classifyDispute({ concern: 'route_priority' }))
  assert.equal(route.blocks, false)
})

test('§34.2 先比条件与验证方法：条件不同保留各自范围；共用验证器不算独立支持', () => {
  const sideA: DisputeSide = {
    label: 'A',
    conditions: ['Python 3.11', 'UTC'],
    versions: { 'report/a.json': 'v2' },
    methodRefs: ['validator-x'],
    commonDeps: ['pipeline-v1'],
  }
  const sideB: DisputeSide = { ...sideA, label: 'B', conditions: ['Python 3.12', 'UTC'] }
  const different = compareDisputeSides(sideA, sideB)
  assert.equal(different.sameCondition, false)
  assert.ok(different.differing.some((entry) => entry.includes('Python')))
  assert.ok(different.note.includes('保留各自成立范围'), 'V5-10：条件不同的两个结论同时保留')

  const sideC: DisputeSide = { ...sideA, label: 'C', methodRefs: ['validator-x', 'validator-y'] }
  const same = compareDisputeSides(sideA, sideC)
  assert.equal(same.sameCondition, true)
  assert.deepEqual(same.sharedDeps, ['pipeline-v1', 'validator-x'], '共用验证器与数据处理必须点出：不是独立支持')
  assert.ok(same.note.includes('独立支持'))
})

test('§34.2 有界裁决：操作性决定与"未排除"必填，不得包装成事实证明', () => {
  const sideA: DisputeSide = { label: 'A', conditions: ['同一环境'], versions: { 'report/a.json': 'v2' }, methodRefs: ['validator-x'] }
  const same = compareDisputeSides(sideA, { ...sideA, label: 'B' })
  const base: AdjudicationInput = {
    challengeId: 'chl_1',
    comparison: same,
    scope: '路线 A 与 B 在当前条件下的取舍',
    evidenceRefs: ['ev_a', 'ev_b'],
    temporaryChoice: '在范围 X 下暂用 A',
    retainedAlternative: 'B 未排除',
    ownerActorId: 'lead-1',
    remainingBudgetNote: '探索预算还剩 2 次小试验',
    reopenConditions: ['出现新的判别试验'],
    impactScope: '只影响路线选择，不影响交付任务',
  }
  const ok = validateAdjudication(base)
  assert.equal(ok.ok, true)
  assert.equal(ok.verdict, 'temporary_choice')
  const rendered = renderAdjudicationResolution(base)
  assert.ok(rendered.includes('暂用 A') && rendered.includes('剩余预算') && rendered.includes('重开条件'))

  const dropped = { ...base, retainedAlternative: undefined }
  const noAlternative = validateAdjudication(dropped)
  assert.equal(noAlternative.ok, false)
  assert.ok(noAlternative.problems.some((problem) => problem.includes('未排除')))

  const dressedUp = validateAdjudication({ ...base, temporaryChoice: '证明 A 才是正确路线' })
  assert.equal(dressedUp.ok, false, '负责人胜出不能被包装成事实证明')
  assert.ok(dressedUp.problems.some((problem) => problem.includes('证明')))

  const byTest = validateAdjudication({ ...base, temporaryChoice: '判别试验支持 A', resolvingEvidenceIds: ['ev_trial_1'] })
  assert.equal(byTest.ok, true)
  assert.equal(byTest.verdict, 'decided_by_test')

  const diffConditions = compareDisputeSides(sideA, { ...sideA, label: 'B', conditions: ['另一环境'] })
  const bothRetained = validateAdjudication({ ...base, comparison: diffConditions, temporaryChoice: '两范围分别沿用各自结论' })
  assert.equal(bothRetained.ok, true)
  assert.equal(bothRetained.verdict, 'both_scopes_retained')
  const bothWithoutAlternative = validateAdjudication({ ...base, comparison: diffConditions, temporaryChoice: '两范围分别沿用各自结论', retainedAlternative: undefined })
  assert.equal(bothWithoutAlternative.ok, false, '保留各自范围也要写明另一方范围')
  assert.equal(adjudicationVerdict(base), 'temporary_choice')
})
