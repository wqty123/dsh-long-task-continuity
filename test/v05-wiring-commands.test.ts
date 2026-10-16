/**
 * v0.5 命令层接线回归（设计稿 v0.5 §25–§35；验收情形参考 §36.2）。
 *
 * 这一文件盯四件事，都关于"命令层有没有把 42 个新 CommandKind 全部转发到领域模块"：
 * 1. 全量成功：每个 kind 至少一条 applied=true 的用例——`default: return base` 会把漏接的
 *    case 变成静默拒绝而**不会**编译报错，所以这条用例是漏 case 的兜底；
 * 2. 权限：越权角色由 role 表在写盘之前挡回（理由含 "not allowed"），不靠领域模块事后拒绝；
 * 3. 薄转发不变形：领域模块拒绝时命令层原样退回（`transition rejected`）、修订号不动；
 * 4. 幂等：同一 requestId 重放一个 v0.5 命令返回 `dedup-hit`，不产生第二次副作用。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Command } from '../src/core/commands.ts'
import { dispatch } from '../src/core/commands.ts'
import type { MissionControl } from '../src/core/control.ts'
import { freezeFrame } from '../src/core/context-quality.ts'
import type { AssessContextInput, AssessmentFrame } from '../src/core/context-quality.ts'
import { mintCriteria } from '../src/core/entities.ts'
import type { ActorRole, RecordCoverage } from '../src/core/entities.ts'
import type { EnvironmentInput, EnvironmentItem, ResumeInput } from '../src/core/environment.ts'
import type { ExperimentDraft, TrialDraft } from '../src/core/experiment.ts'
import type { MechanismInput, MechanismRunInput } from '../src/core/governance.ts'
import type { IntegrationPlanInput, IntegrationReceiptInput } from '../src/core/integration.ts'
import type { OutcomeContractInput, OutcomeReviewAnswer } from '../src/core/outcome.ts'
import { buildCoverage, prepareBrief } from '../src/core/records.ts'
import { NOW, ctx, draftMission, freshState, req, taskPayload } from './fixtures.ts'

/* ------------------------------------------------------------------ 夹具 */

const SUP = ctx('supervisor', 'sup-1')

/** 42 个 v0.5 kind 的封口清单：大用例末尾核对实际走到过哪些。 */
const V05_KINDS: readonly Command['kind'][] = [
  'experiment.classifyWork',
  'exploration.registerPolicy',
  'exploration.release',
  'exploration.restore',
  'experiment.preregister',
  'experiment.revise',
  'experiment.advanceStage',
  'experiment.recordTrial',
  'route.assess',
  'strategy.decide',
  'conjecture.capture',
  'conjecture.frame',
  'conjecture.probeReady',
  'conjecture.recordProbe',
  'conjecture.pursue',
  'conjecture.defer',
  'conjecture.close',
  'conjecture.assumptionChange',
  'context.assess',
  'context.invalidateAssessment',
  'context.transitionAction',
  'context.applyRunPlan',
  'context.applyActionOutcome',
  'environment.register',
  'environment.revise',
  'resume.open',
  'resume.advance',
  'resume.assess',
  'mechanism.propose',
  'mechanism.revise',
  'mechanism.changeClass',
  'mechanism.transition',
  'mechanism.recordRun',
  'mechanism.recordMisreport',
  'outcome.register',
  'outcome.observe',
  'outcome.review',
  'integration.plan',
  'integration.revise',
  'integration.receipt',
  'records.recordCoverage',
  'records.recordBrief',
]

function expDraft(overrides: Partial<ExperimentDraft> = {}): ExperimentDraft {
  return {
    routeFamilyId: 'route:rep',
    problem: '表征方式是否限制效果',
    userUtility: '减少返工',
    candidateMechanism: '换表征',
    differenceFromCurrent: '替换输入表示而非调参',
    testedHypothesis: '新表征在下游指标上更好',
    observable: '判别器分数',
    decisionImpact: '若无效则回退调参路线',
    baselineRef: 'baseline:v0',
    baselineVersion: 'v0',
    plannedCost: { calls: 2, note: '两次小样本对照' },
    treatmentNote: '仅替换表征层',
    validatorRefs: ['val_1'],
    criteria: mintCriteria([{ text: '指标不低于基线' }]),
    budgetCapNote: '一次 20 次调用',
    minViableTrial: '一次小样本对照',
    stopConditions: ['两次负结果即停'],
    riskBoundary: '不影响已验收版本',
    isolation: 'sandbox',
    ...overrides,
  }
}

function trialDraft(experimentId: string, overrides: Partial<TrialDraft> = {}): TrialDraft {
  return {
    experimentId,
    experimentVersion: 1,
    execution: 'completed',
    treatmentApplied: 'yes',
    evaluationValidity: 'valid',
    observed: 'no_reliable_difference',
    ...overrides,
  }
}

/** 猜想草稿：带期望信号与竞争解释，便于一路走到 pursued（§31.3、§31.6）。 */
function conjectureDraft(tag: string): {
  readonly proposition: string
  readonly assumptionChange: string
  readonly sourceNote: string
  readonly expectedSignals: readonly string[]
  readonly competingExplanations: readonly string[]
  readonly nextCheapestAction: string
} {
  return {
    proposition: `猜想 ${tag}：瓶颈来自表征方式`,
    assumptionChange: `直接替换表征层（${tag}），跳过调参`,
    sourceNote: `来源（${tag}）：反常观测——调参收益递减`,
    expectedSignals: ['判别器分数上升'],
    competingExplanations: ['样本量增加也能解释'],
    nextCheapestAction: '跑一次小样本对照',
  }
}

function envItem(overrides: Partial<EnvironmentItem> = {}): EnvironmentItem {
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

function envInput(environmentId: string, overrides: Partial<EnvironmentInput> = {}): EnvironmentInput {
  return {
    environmentId,
    nextAction: '运行测试脚本',
    items: [envItem()],
    authorActorId: 'lead-1',
    ...overrides,
  }
}

function resumeInput(environmentId: string): ResumeInput {
  return { environmentId, targetIdentity: 'acct:default', decidedBy: 'lead-1' }
}

function mechanismInput(mechanismId: string): MechanismInput {
  return {
    mechanismId,
    name: '语义质量建议',
    class: 'optional_advisory',
    purpose: '对交付文本做语义质量评分',
    triggers: ['交付前'],
    requiredInputs: ['delivery.ref'],
    relevantRevisions: ['criteriaRevision'],
    scope: 'mission',
    benefitSignal: '发现措辞与判据不一致的次数',
    proposedBy: 'lead-1',
  }
}

function outcomeContract(): OutcomeContractInput {
  return {
    intendedUse: '分析师在换环境后重复运行同一分析流程',
    desiredOutcome: '流程在干净环境一次跑通并给出可解释输出',
    acceptanceExamples: [
      { kind: 'success', text: '新环境按文档运行得到与基线一致的关键结论' },
      { kind: 'boundary', text: '输入为空时给出明确报错而不是静默输出空表' },
    ],
    metricsAndLimits: [
      { metric: '端到端运行成功率', represents: '流程可重复运行的稳定程度', cannotRepresent: '结论被用户实际采纳的程度' },
    ],
    hardConstraints: [{ text: '不得改动业务仓库', source: '用户 2026-10-14 指令' }],
    preferencesAndTradeoffs: [],
    unresolvedAssumptions: [{ text: '目标环境 Python ≥ 3.11', advanceScope: '先按当前锁定版本推进，发布前提早确认' }],
  }
}

/** 四个问题全答、未知项保留未知：`outcome.review` 的最小合法回答（§30.2）。 */
function reviewAnswers(): readonly OutcomeReviewAnswer[] {
  return [
    { question: 'effect_changed', answer: '用户效用尚未实际观测', evidenceRefs: [], unknown: true },
    { question: 'metric_evidence', answer: '指标证据待交付后采集', evidenceRefs: [], unknown: true },
    { question: 'costs_and_regressions', answer: '暂无新增退步记录', evidenceRefs: [], unknown: true },
    { question: 'route_still_serves', answer: '当前路线仍服务于原任务', evidenceRefs: [], unknown: true },
  ]
}

/** 健康信号：容量 10%、其余观测面为空——确定性层判定为 keep，可直接记录（§27.3）。 */
function healthySignals(): AssessContextInput['signals'] {
  return {
    capacity: { requestEstimateTokens: 1000, contextWindowTokens: 10000 },
    coverage: { required: [] },
    freshness: { refs: [] },
    consistency: {},
    relevanceRedundancy: {},
    continuity: {},
    behaviorRegression: {},
  }
}

function assessInput(state: MissionControl, fingerprint: string): AssessContextInput {
  return {
    actorId: 'sup-1',
    freeze: freezeFrame(state, { requestFingerprint: fingerprint, sessionId: 'sess-1', sessionRevision: 1, criteriaRevision: 1, retentionList: [] }),
    signals: healthySignals(),
    tier: 'deterministic',
  }
}

/** 用于失效判定的"当前帧"：换请求指纹即构成阻断性漂移（§27.5 第 2 条）。 */
function frameAt(state: MissionControl, fingerprint: string): AssessmentFrame {
  return {
    sessionId: 'sess-1',
    sessionRevision: 1,
    missionRevision: state.revision,
    objectiveRevision: state.mission.objectiveRevision,
    policyRevision: state.mission.policyRevision,
    criteriaRevision: 1,
    requestFingerprint: fingerprint,
  }
}

/* ------------------------------------------------------------------ 1. 全量成功 */

test('v0.5 接线：42 个 CommandKind 全部转发到领域模块，且每次成功推进修订', () => {
  const covered = new Set<string>()
  const run = (state: MissionControl, cmd: Command): MissionControl => {
    const result = dispatch(state, cmd, SUP)
    assert.equal(result.applied, true, `${cmd.kind} 应被接受：${result.applied ? '' : result.reason}`)
    if (!result.applied) return state
    // 领域模块内部可能多步提交（如 resume.assess 走完整状态机），这里只要求"确有推进"。
    assert.ok(result.state.revision > state.revision, `${cmd.kind} 应经 commit() 推进修订`)
    covered.add(cmd.kind)
    return result.state
  }

  let state = freshState()
  state = run(state, { kind: 'mission.create', requestId: req(), mission: draftMission() })
  state = run(state, { kind: 'actor.register', requestId: req(), actorId: 'lead-1', role: 'lead', label: 'Lead', sessionId: 'sess-1' })
  state = run(state, { kind: 'task.propose', requestId: req(), task: taskPayload({ title: '试验宿主任务' }) })
  const hostTaskId = Object.keys(state.tasks)[0]!
  assert.ok(hostTaskId !== undefined)

  /* —— §25/§26/§31 探索与猜想 —— */

  state = run(state, { kind: 'experiment.classifyWork', requestId: req(), taskId: hostTaskId, workKind: 'explore' })
  state = run(state, {
    kind: 'exploration.registerPolicy',
    requestId: req(),
    registration: { reserveShare: 0.2, maxTrialCost: { calls: 5, note: '单次试验至多 5 次调用' }, minDiscernibleTrial: '一次小样本对照', reviewTriggers: ['每 10 次试验'] },
  })
  state = run(state, { kind: 'exploration.release', requestId: req(), reason: '本周期预算优先交付', recheck: '下个里程碑重看预留' })
  state = run(state, { kind: 'exploration.restore', requestId: req(), reason: '里程碑核对：合格候选已出现' })

  state = run(state, { kind: 'experiment.preregister', requestId: req(), draft: expDraft() })
  const experimentId = Object.keys(state.experiments)[0]!
  state = run(state, { kind: 'experiment.revise', requestId: req(), experimentId, revision: { reason: '观察到偏差：调整最小有效试验', minViableTrial: '两次小样本对照' } })

  const beforeCapture = state
  state = run(state, { kind: 'conjecture.capture', requestId: req(), draft: conjectureDraft('甲') })
  const claimA = Object.keys(state.claims).find((id) => beforeCapture.claims[id] === undefined)!

  state = run(state, { kind: 'experiment.recordTrial', requestId: req(), draft: trialDraft(experimentId, { claimRefs: [claimA], observed: 'partial_improvement' }) })
  const trialId = Object.keys(state.trials)[0]!
  state = run(state, { kind: 'experiment.advanceStage', requestId: req(), experimentId, to: 'small_scale_validity', evidence: { note: '执行完成且实际处理生效' } })
  state = run(state, { kind: 'route.assess', requestId: req(), input: { routeFamilyId: 'route:rep', scope: '当前任务范围', state: 'eligible', basis: 'priority', reason: '按优先级先看当前路线' } })
  state = run(state, {
    kind: 'strategy.decide',
    requestId: req(),
    draft: {
      kind: 'strategy_review',
      trigger: 'milestone',
      window: { comparableTrials: 1, resourceNote: '一次小样本对照', from: NOW, to: NOW + 10 },
      currentEvidence: [`trial:${trialId}`],
      candidates: [{ routeFamilyId: 'route:rep', option: '继续当前路线并补对照', expectedInfoValue: '能区分噪声与机制', costNote: '两次调用', chosen: true }],
      costNote: '两次调用',
      reviewTrigger: '下个里程碑',
    },
  })

  state = run(state, { kind: 'conjecture.frame', requestId: req(), claimId: claimA, framing: { expectedSignals: ['梯度范数变化'] } })
  state = run(state, { kind: 'conjecture.probeReady', requestId: req(), claimId: claimA, nextCheapestAction: '跑 10 步小样本对照' })
  state = run(state, { kind: 'conjecture.recordProbe', requestId: req(), claimId: claimA, trialId })
  state = run(state, { kind: 'conjecture.pursue', requestId: req(), claimId: claimA, reason: '探测支持继续小规模投入' })

  const beforeB = state
  state = run(state, { kind: 'conjecture.capture', requestId: req(), draft: conjectureDraft('乙') })
  const claimB = Object.keys(state.claims).find((id) => beforeB.claims[id] === undefined)!
  state = run(state, { kind: 'conjecture.defer', requestId: req(), claimId: claimB, deferralReason: 'insufficient_resources', note: '本周期预算优先交付', reentryCondition: '下个预算周期重看' })

  const beforeC = state
  state = run(state, { kind: 'conjecture.capture', requestId: req(), draft: conjectureDraft('丙') })
  const claimC = Object.keys(state.claims).find((id) => beforeC.claims[id] === undefined)!
  state = run(state, { kind: 'conjecture.close', requestId: req(), claimId: claimC, reason: '按范围内归档：与当前路线重复' })

  const beforeD = state
  state = run(state, { kind: 'conjecture.capture', requestId: req(), draft: conjectureDraft('丁') })
  const claimD = Object.keys(state.claims).find((id) => beforeD.claims[id] === undefined)!
  state = run(state, { kind: 'conjecture.assumptionChange', requestId: req(), claimId: claimD, change: { text: '补充假设：数据版本差异也能解释' } })

  /* —— §27 上下文质量（只经 supervisor） —— */

  const beforeAssessA = state
  state = run(state, { kind: 'context.assess', requestId: req(), input: assessInput(beforeAssessA, 'fp-wire-a') })
  const assessmentA = Object.keys(state.assessments).find((id) => beforeAssessA.assessments[id] === undefined)!
  state = run(state, { kind: 'context.invalidateAssessment', requestId: req(), assessmentId: assessmentA, current: frameAt(state, 'fp-wire-b') })

  const beforeAssessB = state
  state = run(state, { kind: 'context.assess', requestId: req(), input: assessInput(beforeAssessB, 'fp-wire-c') })
  const assessmentB = Object.keys(state.assessments).find((id) => beforeAssessB.assessments[id] === undefined)!
  state = run(state, { kind: 'context.transitionAction', requestId: req(), assessmentId: assessmentB, next: 'queued', note: '空闲维护入口排队' })

  const beforeAssessC = state
  state = run(state, { kind: 'context.assess', requestId: req(), input: assessInput(beforeAssessC, 'fp-wire-d') })
  const assessmentC = Object.keys(state.assessments).find((id) => beforeAssessC.assessments[id] === undefined)!
  state = run(state, { kind: 'context.applyRunPlan', requestId: req(), assessmentId: assessmentC, plan: { kind: 'skip', reason: 'keep：只记录建议，不占用维护入口' } })

  const beforeAssessD = state
  state = run(state, { kind: 'context.assess', requestId: req(), input: assessInput(beforeAssessD, 'fp-wire-e') })
  const assessmentD = Object.keys(state.assessments).find((id) => beforeAssessD.assessments[id] === undefined)!
  state = run(state, { kind: 'context.applyActionOutcome', requestId: req(), assessmentId: assessmentD, outcome: { kind: 'declined', detail: '本周期不执行压缩' } })

  /* —— §33 环境接续 —— */

  state = run(state, { kind: 'environment.register', requestId: req(), input: envInput('env_wire_a') })
  state = run(state, { kind: 'environment.revise', requestId: req(), environmentId: 'env_wire_a', patch: { nextAction: '提交到远程分支', items: [envItem({ kind: 'branch', ref: 'env:branch', expected: '分支 feature/x' })] } })
  state = run(state, { kind: 'environment.register', requestId: req(), input: envInput('env_wire_b') })
  state = run(state, { kind: 'resume.open', requestId: req(), input: resumeInput('env_wire_b') })
  const resumeId = Object.keys(state.resumes)[0]!
  state = run(state, { kind: 'resume.advance', requestId: req(), resumeId, event: { kind: 'expected_captured' } })
  state = run(state, { kind: 'environment.register', requestId: req(), input: envInput('env_wire_c') })
  state = run(state, {
    kind: 'resume.assess',
    requestId: req(),
    input: {
      ...resumeInput('env_wire_c'),
      observations: [{ kind: 'workspace', ref: 'env:ws', sensitivity: 'variable', observation: 'match' }],
    },
  })

  /* —— §35 治理 —— */

  state = run(state, { kind: 'mechanism.propose', requestId: req(), input: mechanismInput('mech_wire') })
  state = run(state, { kind: 'mechanism.revise', requestId: req(), mechanismId: 'mech_wire', patch: { purpose: '对交付文本做语义质量评分（修订口径）' } })
  state = run(state, { kind: 'mechanism.changeClass', requestId: req(), mechanismId: 'mech_wire', nextClass: 'required_acceptance', decision: { actorId: 'sup-1', basis: 'rule_owner', authorizationRef: 'user:2026-10-14' } })
  state = run(state, { kind: 'mechanism.transition', requestId: req(), mechanismId: 'mech_wire', event: 'start_observing', detail: { reason: '先观察一个周期再决定是否纳入必检' } })
  state = run(state, { kind: 'mechanism.recordRun', requestId: req(), input: { mechanismId: 'mech_wire', runId: 'mrun_wire', trigger: 'delivery', modelCalls: 1, tokens: 12, outputNote: '语义评分 0.9', actualAction: 'checked' } satisfies MechanismRunInput })
  state = run(state, { kind: 'mechanism.recordMisreport', requestId: req(), runId: 'mrun_wire', verdict: 'no', note: '人工复核：不是误报' })

  /* —— §30 目标效用 —— */

  state = run(state, { kind: 'outcome.register', requestId: req(), input: outcomeContract(), reason: '按用户指令整理目标契约' })
  state = run(state, { kind: 'outcome.observe', requestId: req(), next: 'outcome_pending', note: '交付完成，等待实际使用效果' })
  state = run(state, { kind: 'outcome.review', requestId: req(), triggers: ['milestone'], answers: reviewAnswers(), conclusion: 'contract_holds' })

  /* —— §34 整合 —— */

  for (const title of ['组件 A', '组件 B', '整合任务']) {
    state = run(state, { kind: 'task.propose', requestId: req(), task: taskPayload({ title }) })
  }
  const taskIdOf = (title: string): string => {
    const found = Object.values(state.tasks).find((task) => task.title === title)
    assert.ok(found !== undefined, `任务未创建：${title}`)
    return found!.taskId
  }
  const componentA = taskIdOf('组件 A')
  const componentB = taskIdOf('组件 B')
  const integrationTask = taskIdOf('整合任务')
  state = run(state, { kind: 'artifact.registerVersion', requestId: req(), taskId: integrationTask, uri: 'out/flow.zip', contentHash: 'hash-flow' })

  const planInput = (userFlow: string): IntegrationPlanInput => ({
    integrationTaskId: integrationTask,
    componentRefs: [
      { taskId: componentA, expectedVersion: '1', inputOutput: '原始数据 → 清洗表', versionsUnitsFormats: 'CSV/UTF-8；金额单位元' },
      { taskId: componentB, expectedVersion: '1', inputOutput: '清洗表 → 分析报告', versionsUnitsFormats: 'Markdown；术语表 v1' },
    ],
    interfaces: [{ name: '清洗表接口', contract: '列名与口径冻结', consumers: [componentB] }],
    sharedAssumptions: ['时区统一 UTC'],
    candidateRefs: [],
    userFlow,
    ownerActorId: 'lead-1',
  })
  state = run(state, { kind: 'integration.plan', requestId: req(), input: planInput('分析师在干净环境按文档跑完整流程并解释输出') })
  const integrationId = Object.keys(state.integrations)[0]!
  state = run(state, { kind: 'integration.revise', requestId: req(), integrationId, input: planInput('分析师在干净环境按文档跑完整流程、解释输出并复跑一次') })
  const receiptInput: IntegrationReceiptInput = {
    integrationId,
    artifactFingerprint: 'hash-flow',
    componentRefs: [],
    checks: [{ kind: '真实调用流程', result: 'pass', note: '干净环境端到端跑通' }],
    reusedComponentRefs: [],
    reworkTaskIds: [],
  }
  state = run(state, { kind: 'integration.receipt', requestId: req(), input: receiptInput })
  assert.equal(state.integrationReceipts[Object.keys(state.integrationReceipts)[0]!]?.publishEligible, true)

  /* —— §28 记录 —— */

  const built = buildCoverage(state, { sourceCuts: [{ source: 'session:sess-1', watermark: 'seq:9', durability: 'durable' }], completeness: 'complete_within_scope' }, NOW)
  assert.equal(built.ok, true)
  if (!built.ok) return
  const coverage: RecordCoverage = built.coverage
  state = run(state, { kind: 'records.recordCoverage', requestId: req(), coverage })
  const prepared = prepareBrief(state, { kind: 'dispatch', targetRefs: [`task:${hostTaskId}`], preparedBy: 'lead-1', coverageId: coverage.coverageId }, NOW)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  state = run(state, { kind: 'records.recordBrief', requestId: req(), brief: prepared.brief })

  // 漏接的 case 会被 `default` 静默拒绝：上面每条都应用成功过一遍才算接线完整。
  assert.equal(V05_KINDS.length, 42, '封口清单本身要盯住 42 个 kind')
  for (const kind of V05_KINDS) {
    assert.equal(covered.has(kind), true, `kind ${kind} 没有走到成功的用例：接线可能漏了 case`)
  }
})

/* ------------------------------------------------------------------ 2. 权限 */

test('v0.5 权限表：越权角色在写盘之前被挡回，修订号不动', () => {
  const state = freshState()
  const cases: readonly { readonly role: ActorRole; readonly cmd: Command; readonly why: string }[] = [
    { role: 'member', cmd: { kind: 'experiment.preregister', requestId: req(), draft: expDraft() }, why: '成员不能自己预登记试验契约' },
    { role: 'subagent', cmd: { kind: 'conjecture.capture', requestId: req(), draft: conjectureDraft('越权') }, why: '子代理不挂猜想生命周期' },
    { role: 'reviewer', cmd: { kind: 'exploration.release', requestId: req(), reason: '释放预留', recheck: '下个里程碑重看' }, why: '审查者不释放探索预留' },
    { role: 'lead', cmd: { kind: 'context.assess', requestId: req(), input: assessInput(state, 'fp-denied') }, why: '上下文评估只由插件机制自驱动（本轮只开给 supervisor）' },
  ]
  for (const item of cases) {
    const result = dispatch(state, item.cmd, ctx(item.role, `${item.role}-1`))
    assert.equal(result.applied, false, item.why)
    if (result.applied) continue
    assert.match(result.reason, /not allowed/)
    assert.equal(result.state.revision, state.revision, `${item.cmd.kind} 被拒时不能推进修订`)
  }
  // 对照：同一批命令在 supervisor 身份下不被权限门拦住（§27.1、§35.1）。
  const probe = dispatch(freshState(), { kind: 'context.assess', requestId: req(), input: assessInput(state, 'fp-probe') }, SUP)
  assert.equal(probe.applied, true, 'supervisor 必须能发 context.assess')
})

/* ------------------------------------------------------------------ 3. 薄转发不变形 */

test('薄转发不变形：领域模块拒绝时命令层原样退回、修订不动', () => {
  let state = freshState()

  // recordTrial：试验不存在，模块拒绝，命令层不得自己造状态。
  const missing = dispatch(state, { kind: 'experiment.recordTrial', requestId: req(), draft: trialDraft('exp_missing') }, SUP)
  assert.equal(missing.applied, false)
  if (!missing.applied) {
    assert.equal(missing.reason, 'transition rejected')
    assert.equal(missing.state.revision, state.revision)
    assert.deepEqual(missing.state.trials, state.trials)
  }

  // registerEnvironment：同一 environmentId 重复登记，模块拒绝第二条链。
  const first = dispatch(state, { kind: 'environment.register', requestId: req(), input: envInput('env_dup') }, SUP)
  assert.equal(first.applied, true)
  if (!first.applied) return
  state = first.state
  const again = dispatch(state, { kind: 'environment.register', requestId: req(), input: envInput('env_dup') }, SUP)
  assert.equal(again.applied, false)
  if (!again.applied) {
    assert.equal(again.reason, 'transition rejected')
    assert.equal(again.state.revision, state.revision)
    assert.equal(again.state.environments['env_dup']?.length, 1, '重复登记不能追加第二条环境链')
  }
})

/* ------------------------------------------------------------------ 4. 幂等 */

test('v0.5 命令同样走幂等入口：同一 requestId 重放返回 dedup-hit', () => {
  const state = freshState()
  const cmd: Command = { kind: 'environment.register', requestId: 'v05-dedup-1', input: envInput('env_dedup') }
  const first = dispatch(state, cmd, SUP)
  assert.equal(first.applied, true)
  if (!first.applied) return

  const replay = dispatch(first.state, cmd, SUP)
  assert.equal(replay.applied, true)
  if (!replay.applied) return
  assert.equal(replay.effect, 'dedup-hit')
  assert.equal(replay.state.revision, first.state.revision, '重放不能再涨修订')
  assert.equal(replay.state.environments['env_dedup']?.length, 1)
})
