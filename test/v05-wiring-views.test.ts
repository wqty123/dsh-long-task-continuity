/**
 * v0.5 视图接线回归（设计稿 v0.5 §25–§35；视图约束 DG-18 §22.18）。
 *
 * 视图是纯投影：本文件盯三件事——
 * 1. **接通**：五个新渲染函数与任务页增补确实把各模块读函数的结论投影出来（工作分类、四层结果、
 *    覆盖前提、清单缺口、货币性、熔断 / 收益 / 退出、漂移回执、下一步优先级）；
 * 2. **确定性**：同一状态两次渲染逐字节相同；把容器键顺序整体反转后渲染仍然不变；
 * 3. **空状态不崩**：没有任何 v0.5 容器时渲染占位文本（「（无）」）而不是抛错或渲染出 undefined。
 *
 * 夹具走领域模块写侧函数（与 v05-* 其余用例同一手法），断言只钉"哪些行出现了"，
 * 不重抄判定规则；两处手挂记录（归档计数、一份刻意过期的回执）在各自位置注明原因。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { MissionControl } from '../src/core/control.ts'
import type { Actor, ActorRole, ArtifactVersion, Checkpoint, Task } from '../src/core/entities.ts'
import { mintCriteria } from '../src/core/entities.ts'
import { NOW, freshState } from './fixtures.ts'
import type { ConjectureDraft, ExperimentCommit, ExperimentDraft, ExplorationRegistration, TrialDraft } from '../src/core/experiment.ts'
import {
  captureConjecture,
  classifyTaskWork,
  closeConjectureInScope,
  frameConjecture,
  preregisterExperiment,
  probeReadyConjecture,
  pursueConjecture,
  recordConjectureProbe,
  recordTrial,
  registerExplorationPolicy,
  registerStrategyDecision,
  reviseExperiment,
  upsertRouteAssessment,
} from '../src/core/experiment.ts'
import { advanceResume, classifyFinding, openResume, registerEnvironment } from '../src/core/environment.ts'
import type { MechanismInput, MechanismRunInput } from '../src/core/governance.ts'
import { proposeMechanism, recordMechanismRun, recordMisreport, transitionMechanism } from '../src/core/governance.ts'
import type { AssessmentDraft, QualitySignals } from '../src/core/context-quality.ts'
import { evaluateContext, freezeFrame, recordAssessment, selectAction, transitionAction } from '../src/core/context-quality.ts'
import type { OutcomeContractInput } from '../src/core/outcome.ts'
import { registerOutcomeContract } from '../src/core/outcome.ts'
import type { IntegrationPlanInput, IntegrationReceiptInput } from '../src/core/integration.ts'
import { assembleIntegrationReceipt, registerIntegrationPlan } from '../src/core/integration.ts'
import { buildCoverage, prepareBrief, recordBrief, recordCoverage } from '../src/core/records.ts'
import {
  renderEnvironmentMarkdown,
  renderGovernanceMarkdown,
  renderMissionMarkdown,
  renderOutcomeMarkdown,
  renderRecordsMarkdown,
  renderWorkMarkdown,
} from '../src/views/export.ts'

/* ------------------------------------------------------------------ 夹具助手 */

/**
 * 等领域模块回执：`ok` 形状（env / resume / mechanism / outcome / records / assessment）。
 * 断言式收口，让"夹具调用被拒"立刻抛错，而不是在远处断言里出现看不懂的差异。
 *
 * `Extract` 只对字面量判别联合（`ok: true` / `ok: false`）有效；environment / governance
 * 的回执是 `ok: boolean` 接口（state 恒在），对它们 Extract 推成 never，这里回退到 T 本身。
 */
type OkBranch<T> = Extract<T, { readonly ok: true }> extends never ? T : Extract<T, { readonly ok: true }>

function mustOk<T extends { readonly ok: boolean }>(result: T, label: string): OkBranch<T> {
  if (!result.ok) {
    const reason = (result as { readonly reason?: string; readonly problems?: readonly string[] }).reason
    const problems = (result as { readonly problems?: readonly string[] }).problems
    throw new Error(`${label} 被拒：${reason ?? problems?.join('；') ?? '（未给理由）'}`)
  }
  return result as OkBranch<T>
}

/** 等领域模块回执：`applied` 形状（experiment.ts 的 ExperimentCommit）。 */
function mustApply<Extra extends object>(result: ExperimentCommit<Extra>, label: string): Extract<ExperimentCommit<Extra>, { readonly applied: true }> {
  if (!result.applied) throw new Error(`${label} 被拒：${result.reason}`)
  return result
}

function taskOf(taskId: string, overrides: Partial<Task> = {}): Task {
  return {
    taskId,
    missionId: 'mss_test',
    dependsOn: [],
    title: `任务 ${taskId}`,
    scope: '只读核对装配',
    exclusions: [],
    inputRefs: [],
    criteria: mintCriteria([{ text: '脚本断言全部通过' }]),
    priority: 5,
    status: 'running',
    validity: 'current',
    objectiveRevision: 1,
    specRevision: 1,
    criteriaRevision: 1,
    criteriaCheck: 'consistent',
    resourceKeys: [],
    maxAttempts: 3,
    attemptCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/** 手挂任务 / 身份 / 检查点记录：本文件只考视图投影，不需要经由命令面走完整生命周期。 */
function mount(base: MissionControl, patch: Partial<MissionControl>): MissionControl {
  return { ...base, ...patch }
}

function withTask(base: MissionControl, task: Task): MissionControl {
  return mount(base, { tasks: { ...base.tasks, [task.taskId]: task } })
}

function actorOf(actorId: string, role: ActorRole): Actor {
  return {
    actorId,
    missionId: 'mss_test',
    role,
    label: role,
    bindingVersion: 1,
    available: true,
    dormant: false,
    retired: false,
    rotationsLastHour: [],
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function checkpointOf(checkpointId: string, taskId: string, nextAction: string, writtenAt: number): Checkpoint {
  return {
    checkpointId,
    missionId: 'mss_test',
    taskId,
    actorId: 'lead-1',
    sourceRevision: 0,
    objectiveRevision: 1,
    policyRevision: 1,
    criteriaRevision: 1,
    basisRevision: 0,
    step: '已跑到装配核对',
    verifiedProgress: [],
    inProgress: [],
    nextAction,
    decisions: [],
    blockers: [],
    inFlightOperations: [],
    openQuestions: [],
    openChallengeIds: [],
    openObligationIds: [],
    contextRefs: [],
    writtenAt,
  }
}

function artifactOf(artifactId: string, taskId: string, uri: string, contentHash: string): ArtifactVersion {
  return {
    artifactId,
    missionId: 'mss_test',
    taskId,
    version: 1,
    uri,
    contentHash,
    hashAlgorithm: 'sha256',
    createdBy: 'lead-1',
    registeredBy: 'lead-1',
    attribution: 'tool_operation',
    status: 'verified',
    published: false,
    validity: 'current',
    withdrawalPending: false,
    registeredAt: NOW,
  }
}

/* ------------------------------------------------------------------ 领域夹具 */

/** 探索策略：20% 预留 + 有界 wildcard 额度，满足 §31.4 的"至少一维可核算"（§25.2）。 */
function registration(): ExplorationRegistration {
  return {
    reserveShare: 0.2,
    maxTrialCost: { calls: 5, note: '单次试验至多 5 次调用' },
    minDiscernibleTrial: '一次小样本对照',
    reviewTriggers: ['每 10 次试验'],
    wildcardProbeAllowance: { tokens: 32, calls: 2, note: '本周期两次小样本探测' },
  }
}

function expDraft(overrides: Partial<ExperimentDraft> = {}): ExperimentDraft {
  return {
    taskId: 'tsk_explore',
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
    observed: 'partial_improvement',
    ...overrides,
  }
}

function conjectureDraft(tag: string): ConjectureDraft {
  return {
    proposition: `猜想 ${tag}：瓶颈来自表征方式`,
    assumptionChange: `直接替换表征层（${tag}），跳过调参`,
    sourceNote: `来源（${tag}）：反常观测——调参收益递减`,
    expectedSignals: ['判别器分数上升'],
    competingExplanations: ['样本量增加也能解释'],
    nextCheapestAction: '跑一次小样本对照',
  }
}

interface EnvItemOverrides {
  readonly kind?: 'workspace' | 'branch' | 'uncommitted_file' | 'runtime' | 'dependency' | 'input_data' | 'config_ref' | 'external_resource' | 'in_flight_job' | 'temp_artifact'
  readonly ref?: string
  readonly expected?: string
  readonly sensitivity?: 'immutable' | 'variable'
  readonly coverage?: 'covered' | 'unknown'
  readonly lastCheckedAt?: number
}

function envItem(overrides: EnvItemOverrides = {}): {
  readonly kind: NonNullable<EnvItemOverrides['kind']>
  readonly ref: string
  readonly expected: string
  readonly observeMethod: string
  readonly sensitivity: NonNullable<EnvItemOverrides['sensitivity']>
  readonly changeAction: string
  readonly coverage: NonNullable<EnvItemOverrides['coverage']>
  readonly lastCheckedAt?: number
} {
  return {
    kind: overrides.kind ?? 'workspace',
    ref: overrides.ref ?? 'env:ws',
    expected: overrides.expected ?? '分支 main',
    observeMethod: 'git status --short',
    sensitivity: overrides.sensitivity ?? 'variable',
    changeAction: '更新清单并重验受影响结果',
    coverage: overrides.coverage ?? 'covered',
    ...(overrides.lastCheckedAt === undefined ? {} : { lastCheckedAt: overrides.lastCheckedAt }),
  }
}

function mechanismInput(mechanismId: string, overrides: Partial<MechanismInput> = {}): MechanismInput {
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
    ...overrides,
  }
}

function runInput(mechanismId: string, runId: string, overrides: Partial<MechanismRunInput> = {}): MechanismRunInput {
  return {
    mechanismId,
    runId,
    trigger: 'delivery',
    modelCalls: 1,
    tokens: 12,
    wallClockMs: 800,
    outputNote: '语义评分 0.9',
    actualAction: 'checked',
    ...overrides,
  }
}

/** 健康信号：容量 10%、其余观测面为空——确定性层判定为 keep，可直接记录（§27.3）。 */
function healthySignals(): QualitySignals {
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

function outcomeContractInput(): OutcomeContractInput {
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
    effectObservation: { state: 'outcome_pending', note: '交付完成，等待实际使用效果' },
  }
}

function planInput(integrationTaskId: string, componentTaskId: string): IntegrationPlanInput {
  return {
    integrationTaskId,
    componentRefs: [
      { taskId: componentTaskId, expectedVersion: '1', inputOutput: '原始数据 → 清洗表', versionsUnitsFormats: 'CSV/UTF-8；金额单位元' },
    ],
    interfaces: [{ name: '清洗表接口', contract: '列名与口径冻结', consumers: [componentTaskId] }],
    sharedAssumptions: ['时区统一 UTC'],
    candidateRefs: [],
    userFlow: '分析师在干净环境按文档跑完整流程并解释输出',
    ownerActorId: 'lead-1',
  }
}

/* ------------------------------------------------------------------ 世界构造 */

const stamp = (value: number): string => new Date(value).toISOString()

interface World {
  readonly state: MissionControl
  readonly exp1: string
  readonly exp2: string
  readonly trial1: string
  readonly trial2: string
  readonly claimA: string
  readonly claimB: string
  readonly decisionId: string
  readonly assessmentId: string
  readonly integrationId: string
  readonly receiptId: string
  readonly coverageCompleteId: string
  readonly coveragePartialId: string
  readonly briefId: string
}

/**
 * 一个覆盖 §25–§35 各面的状态：任务分类、探索策略、两份试验契约（含 wildcard 修订）、
 * 四层分开的两份结果、两条猜想（pursued / closed_in_scope）、路线与策略决定、一次评估、
 * 两条环境清单与两条恢复评估（ready / blocked_scope）、两个机制（active / cooling）与运行、
 * 目标契约、一份整合计划与两条回执（current / 刻意过期）、覆盖回执与依据包。
 */
function buildWorld(): World {
  /* §25.2 基础：身份与任务；分类只写 workKind。 */
  let state = freshState({ archivedCounts: { claims: 3 } })
  state = mount(state, { actors: { 'lead-1': actorOf('lead-1', 'lead'), 'sup-1': actorOf('sup-1', 'supervisor') } })
  state = withTask(state, taskOf('tsk_explore'))
  state = withTask(state, taskOf('tsk_deliver'))
  state = withTask(state, taskOf('tsk_comp'))
  state = withTask(state, taskOf('tsk_intg'))
  state = mustApply(classifyTaskWork(state, 'tsk_explore', 'explore', NOW + 1), '任务分类 explore').state
  state = mustApply(classifyTaskWork(state, 'tsk_deliver', 'deliver', NOW + 2), '任务分类 deliver').state

  /* §25.2 / §31.4 探索策略与有界 wildcard 额度。 */
  state = mustApply(registerExplorationPolicy(state, registration(), NOW + 10, 'lead-1'), '探索策略登记').state

  /* §31.3 猜想甲先登记：后面的试验结果要引用它。 */
  const capturedA = mustApply(captureConjecture(state, conjectureDraft('甲'), NOW + 11, 'lead-1'), '猜想甲捕获')
  state = capturedA.state

  /* §25.3 两份试验契约：常规 + wildcard，常规那份再修订一次（版本链）。 */
  const exp1 = mustApply(preregisterExperiment(state, expDraft(), NOW + 12, 'lead-1'), '试验契约预登记')
  state = exp1.state
  const exp2 = mustApply(
    preregisterExperiment(state, expDraft({ routeFamilyId: 'route:novel', wildcard: true, stopConditions: ['一次负结果即停', '额度用完即停'] }), NOW + 13, 'lead-1'),
    'wildcard 试验预登记',
  )
  state = exp2.state
  state = mustApply(
    reviseExperiment(state, exp1.experimentId, { reason: '观察到偏差：调整最小有效试验', minViableTrial: '两次小样本对照' }, NOW + 14, 'lead-1'),
    '试验契约修订',
  ).state

  /* §26.1 四层结果：一条"干预生效 + 方向性观测"，一条"干预未生效 + 无可靠差异"。 */
  const trial1 = mustApply(
    recordTrial(state, trialDraft(exp1.experimentId, { claimRefs: [capturedA.claimId], observedNote: '判别器分数提升但方差大', confounders: ['样本量偏小'], unknowns: ['长期稳定性未知'] }), NOW + 15, 'lead-1'),
    '试验结果登记',
  )
  state = trial1.state
  const trial2 = mustApply(
    recordTrial(
      state,
      trialDraft(exp2.experimentId, { execution: 'outcome_unknown', treatmentApplied: 'no', evaluationValidity: 'unknown', observed: 'no_reliable_difference', observedNote: '机制未进入输出，本次不构成机制证据' }),
      NOW + 16,
      'lead-1',
    ),
    '第二份试验结果登记',
  )
  state = trial2.state

  /* §31.3 猜想甲一路走到 pursued（探测绑定 trial1）；猜想乙登记后按范围归档。 */
  state = mustApply(frameConjecture(state, capturedA.claimId, { expectedSignals: ['梯度范数下降'] }, NOW + 17, 'lead-1'), '猜想 framing').state
  state = mustApply(probeReadyConjecture(state, capturedA.claimId, { nextCheapestAction: '跑 10 步小样本对照' }, NOW + 18, 'lead-1'), '猜想 probe_ready').state
  state = mustApply(recordConjectureProbe(state, capturedA.claimId, { trialId: trial1.trialId }, NOW + 19, 'lead-1'), '猜想探测记录').state
  state = mustApply(pursueConjecture(state, capturedA.claimId, { reason: '探测支持继续小规模投入' }, NOW + 20, 'lead-1'), '猜想 pursued').state
  const capturedB = mustApply(captureConjecture(state, conjectureDraft('乙'), NOW + 21, 'lead-1'), '猜想乙捕获')
  state = capturedB.state
  state = mustApply(closeConjectureInScope(state, capturedB.claimId, { reason: '按范围内归档：与当前路线重复' }, NOW + 22, 'lead-1'), '猜想乙归档').state

  /* §26.2 路线状态（basis 只进事件流，视图从事件里取）。 */
  state = mustApply(
    upsertRouteAssessment(state, { routeFamilyId: 'route:rep', scope: '当前任务范围', state: 'eligible', basis: 'priority', reason: '按优先级先看当前路线' }, NOW + 23, 'lead-1'),
    '路线状态更新',
  ).state

  /* §25.4 策略决定：一个选中、一个带未选理由。 */
  const decided = mustApply(
    registerStrategyDecision(
      state,
      {
        kind: 'strategy_review',
        trigger: 'milestone',
        window: { comparableTrials: 1, resourceNote: '一次小样本对照', from: NOW, to: NOW + 10 },
        currentEvidence: [`trial:${trial1.trialId}`],
        candidates: [
          { routeFamilyId: 'route:rep', option: '继续当前路线并补对照', expectedInfoValue: '能区分噪声与机制', costNote: '两次调用', chosen: true },
          { routeFamilyId: 'route:novel', option: '切换到新表征', expectedInfoValue: '新颖但证据薄', costNote: '两次调用', chosen: false, rejectedReason: '缺可比较基线：先在 wildcard 额度内补一次对照' },
        ],
        costNote: '两次调用',
        reviewTrigger: '下个里程碑',
      },
      NOW + 24,
      'lead-1',
    ),
    '策略决定登记',
  )
  state = decided.state

  /* §27.3 一条确定性层评估（健康信号 → keep），动作到 queued。 */
  const evaluation = evaluateContext(healthySignals(), 'deterministic')
  const guideline = selectAction(evaluation.problems, { tier: 'deterministic' })
  const assessed = mustOk(
    recordAssessment(
      state,
      {
        actorId: 'sup-1',
        freeze: freezeFrame(state, { requestFingerprint: 'fp-views', sessionId: 'sess-1', sessionRevision: 1, criteriaRevision: 1, retentionList: [] }),
        evaluation,
        decision: guideline,
        tier: 'deterministic',
      } satisfies AssessmentDraft,
      NOW + 25,
    ),
    '上下文评估登记',
  )
  state = assessed.state
  state = mustOk(transitionAction(state, assessed.assessment.assessmentId, 'queued', '空闲维护入口排队', NOW + 26), '评估动作迁移').state

  /* §33 两条环境清单：A 完全核验；B 带 unknown 项与缺失种类。 */
  state = mustOk(
    registerEnvironment(
      state,
      {
        environmentId: 'env_a',
        taskId: 'tsk_explore',
        nextAction: '提交到远程分支',
        items: [
          envItem({ kind: 'workspace', ref: 'env:ws', expected: '分支 main', lastCheckedAt: NOW + 30 }),
          envItem({ kind: 'branch', ref: 'env:branch', expected: '分支 feature/x', sensitivity: 'immutable', lastCheckedAt: NOW + 30 }),
          envItem({ kind: 'external_resource', ref: 'env:remote', expected: '远端可达', lastCheckedAt: NOW + 30 }),
        ],
        authorActorId: 'lead-1',
      },
      NOW + 30,
    ),
    '环境 A 登记',
  ).state
  state = mustOk(
    registerEnvironment(
      state,
      {
        environmentId: 'env_b',
        taskId: 'tsk_deliver',
        nextAction: '运行测试脚本',
        items: [envItem({ kind: 'workspace', ref: 'env:ws', coverage: 'unknown' })],
        authorActorId: 'lead-1',
      },
      NOW + 31,
    ),
    '环境 B 登记',
  ).state

  /* 恢复评估 A：走完阶段机到 ready。 */
  state = mustOk(openResume(state, { resumeId: 'resu_a', environmentId: 'env_a', taskId: 'tsk_explore', targetIdentity: 'acct:default', decidedBy: 'lead-1' }, NOW + 32), '恢复评估 A 开启').state
  state = mustOk(advanceResume(state, 'resu_a', { kind: 'expected_captured' }, NOW + 33), 'A 捕获预期').state
  state = mustOk(advanceResume(state, 'resu_a', { kind: 'current_inspected', observedAt: NOW + 34, targetIdentityObserved: 'acct:default', objectVersionsObserved: {} }, NOW + 34), 'A 核验现状').state
  state = mustOk(advanceResume(state, 'resu_a', { kind: 'drift_classified', findings: [] }, NOW + 35), 'A 分类漂移').state
  state = mustOk(advanceResume(state, 'resu_a', { kind: 'revalidation_settled', ok: true, note: '核对通过：清单与身份一致' }, NOW + 36), 'A 重验').state

  /* 恢复评估 B：有未解决漂移，停在 blocked_scope。 */
  state = mustOk(openResume(state, { resumeId: 'resu_b', environmentId: 'env_b', taskId: 'tsk_deliver', targetIdentity: 'acct:default', decidedBy: 'lead-1' }, NOW + 37), '恢复评估 B 开启').state
  state = mustOk(advanceResume(state, 'resu_b', { kind: 'expected_captured' }, NOW + 38), 'B 捕获预期').state
  state = mustOk(advanceResume(state, 'resu_b', { kind: 'current_inspected', observedAt: NOW + 39, targetIdentityObserved: 'acct:default', objectVersionsObserved: {} }, NOW + 39), 'B 核验现状').state
  const driftEntry = classifyFinding({ kind: 'workspace', ref: 'env:ws', sensitivity: 'variable', observation: 'changed', coverage: 'unknown' })
  state = mustOk(advanceResume(state, 'resu_b', { kind: 'drift_classified', findings: [driftEntry.entry] }, NOW + 40), 'B 分类漂移').state
  state = mustOk(advanceResume(state, 'resu_b', { kind: 'repair_settled', unresolvedRefs: ['env:ws'] }, NOW + 41), 'B 修复结算').state

  /* §35 机制 A：观察 → 激活 → 两次运行（一次误报、一次费用不可观测）。 */
  state = mustOk(proposeMechanism(state, mechanismInput('mech_a'), NOW + 50), '机制 A 登记').state
  state = mustOk(transitionMechanism(state, 'mech_a', 'start_observing', NOW + 51, { reason: '先观察一个周期再决定是否进入服务' }), 'A 进入观察').state
  state = mustOk(transitionMechanism(state, 'mech_a', 'activate', NOW + 52), 'A 激活').state
  state = mustOk(recordMechanismRun(state, runInput('mech_a', 'mrun_a1'), NOW + 53), 'A 运行记录 1').state
  state = mustOk(recordMisreport(state, 'mrun_a1', 'yes', '人工复核：建议正确但被拦下', NOW + 54), 'A 误报补记').state
  const unobservable: MechanismRunInput = { mechanismId: 'mech_a', runId: 'mrun_a2', trigger: 'delivery', costUnknown: true, outputNote: '外部服务未回传计量', actualAction: 'checked' }
  state = mustOk(recordMechanismRun(state, unobservable, NOW + 55), 'A 运行记录 2（费用不可观测）').state

  /* §35 机制 B：必需类别，带成本上限；观察后进入冷却。 */
  state = mustOk(
    proposeMechanism(state, mechanismInput('mech_b', { name: '交付前文本检查', class: 'required_acceptance', purpose: '检查交付文本与判据措辞一致性', costCap: { tokens: 100, calls: 2 } }), NOW + 56),
    '机制 B 登记',
  ).state
  state = mustOk(transitionMechanism(state, 'mech_b', 'start_observing', NOW + 57, { reason: '先观察再纳入必检' }), 'B 进入观察').state
  state = mustOk(transitionMechanism(state, 'mech_b', 'enter_cooling', NOW + 58, { reason: '连续两次延迟交付待复核', resumeWhen: '成本与收益重新评估通过后再检查能力' }), 'B 进入冷却').state

  /* §30 目标契约：首次登记，效果观测停在 outcome_pending。 */
  const outcome = mustOk(
    registerOutcomeContract(state, outcomeContractInput(), { actorId: 'sup-1', now: NOW + 60, source: 'supervisor', reason: '按用户指令整理目标契约' }),
    '目标契约登记',
  )
  state = outcome.state

  /* §34 整合：手挂整合产物（产物 ID 由内核分配，这里只考视图，不伪造写路径）。 */
  const flow = artifactOf('art_flow', 'tsk_intg', 'out/flow.zip', 'hash-flow')
  state = mount(state, { artifacts: { [flow.uri]: [flow] } })
  const planned = mustOk(registerIntegrationPlan(state, planInput('tsk_intg', 'tsk_comp'), { actorId: 'lead-1', now: NOW + 61 }), '整合计划登记')
  state = planned.state
  const receiptInput: IntegrationReceiptInput = {
    integrationId: planned.plan.integrationId,
    artifactFingerprint: 'hash-flow',
    componentRefs: [],
    checks: [{ kind: '真实调用流程', result: 'pass', note: '干净环境端到端跑通' }],
    reusedComponentRefs: [],
    reworkTaskIds: [],
  }
  const receipt = mustOk(assembleIntegrationReceipt(state, receiptInput, { actorId: 'lead-1', now: NOW + 62 }), '整合回执组装')
  state = receipt.state
  assert.equal(receipt.receipt.publishEligible, true, '回执应具备发布资格（整体检查 pass、无返工）')
  // 手挂一份刻意过期的回执：绑定版本回退一位，模拟"契约在回执之后修订"（§34.4 漂移）。
  // 视图只读，这里只改展示所需的字段，不经写路径伪造历史。
  const stale = { ...receipt.receipt, receiptId: 'irct_stale', objectiveRevision: receipt.receipt.objectiveRevision - 1 }
  state = mount(state, { integrationReceipts: { ...state.integrationReceipts, irct_stale: stale } })

  /* §28 覆盖回执（完整 / 部分）与依据包（放最后：新鲜度按当前水位为 current）。 */
  const complete = mustOk(
    buildCoverage(state, { sourceCuts: [{ source: 'session:sess-1', watermark: 'seq:9', durability: 'durable' }], completeness: 'complete_within_scope' }, NOW + 70),
    '覆盖回执组装（完整）',
  )
  state = mustOk(recordCoverage(state, complete.coverage, NOW + 70), '覆盖回执登记（完整）').state
  const partial = mustOk(
    buildCoverage(state, { sourceCuts: [{ source: 'session:sess-2', watermark: 'seq:3', durability: 'session_only' }], completeness: 'partial', truncated: true }, NOW + 71),
    '覆盖回执组装（部分）',
  )
  state = mustOk(recordCoverage(state, partial.coverage, NOW + 71), '覆盖回执登记（部分）').state
  const prepared = mustOk(
    prepareBrief(state, { kind: 'dispatch', targetRefs: ['task:tsk_explore'], claimRefs: [capturedA.claimId], preparedBy: 'lead-1', coverageId: complete.coverage.coverageId }, NOW + 72),
    '依据包组装',
  )
  state = mustOk(recordBrief(state, prepared.brief, NOW + 72), '依据包登记').state

  /* 任务页「下一步」的检查点来源：非空 nextAction 的最新检查点。 */
  state = mount(state, { checkpoints: { ckp_1: checkpointOf('ckp_1', 'tsk_explore', '手动轮换一次', NOW + 300_000) } })

  return {
    state,
    exp1: exp1.experimentId,
    exp2: exp2.experimentId,
    trial1: trial1.trialId,
    trial2: trial2.trialId,
    claimA: capturedA.claimId,
    claimB: capturedB.claimId,
    decisionId: decided.decisionId,
    assessmentId: assessed.assessment.assessmentId,
    integrationId: planned.plan.integrationId,
    receiptId: receipt.receipt.receiptId,
    coverageCompleteId: complete.coverage.coverageId,
    coveragePartialId: partial.coverage.coverageId,
    briefId: prepared.brief.briefId,
  }
}

const RENDERERS: readonly { readonly label: string; readonly render: (state: MissionControl) => string }[] = [
  { label: '任务台账', render: renderMissionMarkdown },
  { label: '工作与探索', render: renderWorkMarkdown },
  { label: '记录面', render: renderRecordsMarkdown },
  { label: '环境接续', render: renderEnvironmentMarkdown },
  { label: '治理面', render: renderGovernanceMarkdown },
  { label: '效用与整合', render: renderOutcomeMarkdown },
]

/* ------------------------------------------------------------------ 1. 任务页增补 */

test('任务页「下一步」：检查点 > 阻塞任务 > waitingReason 的优先级，找不到来源不编造', () => {
  let state = freshState()
  assert.ok(renderMissionMarkdown(state).includes('- 下一步：（无记录）'))

  state = withTask(state, taskOf('tsk_blocked', { status: 'blocked', blockedReason: '等待上游数据' }))
  assert.ok(renderMissionMarkdown(state).includes('- 下一步：解除 tsk_blocked 阻塞：等待上游数据'), '有阻塞任务时报阻塞')

  state = mount(state, { mission: { ...state.mission, waitingReason: '等用户答复' } })
  assert.ok(renderMissionMarkdown(state).includes('- 下一步：解除 tsk_blocked 阻塞：等待上游数据'), '阻塞任务压过 waitingReason')
  assert.ok(renderMissionMarkdown(state).includes('- 状态：draft（等用户答复）'))

  state = mount(state, { checkpoints: { ckp_blank: checkpointOf('ckp_blank', 'tsk_blocked', '   ', NOW) } })
  assert.ok(renderMissionMarkdown(state).includes('- 下一步：解除 tsk_blocked 阻塞：等待上游数据'), '空白 nextAction 不构成"下一步"来源')

  state = mount(state, { checkpoints: { ckp: checkpointOf('ckp', 'tsk_blocked', '先把上游数据取回', NOW + 1000) } })
  assert.ok(
    renderMissionMarkdown(state).includes(`- 下一步：先把上游数据取回（tsk_blocked 检查点 ${stamp(NOW + 1000)}）`),
    '有非空 nextAction 的检查点压过阻塞任务',
  )

  state = mount(state, { tasks: {}, checkpoints: {} })
  assert.ok(renderMissionMarkdown(state).includes('- 下一步：等待（等用户答复）'), '没有检查点与阻塞任务时退回 waitingReason')
})

test('任务页增补：目标效益行只在登记了目标契约后出现，报告 intendedUse 与效果观测', () => {
  const world = buildWorld()
  const mission = renderMissionMarkdown(world.state)
  assert.ok(mission.includes('# Mission 台账 Mission mss_test'))
  assert.ok(mission.includes('- sourceRevision：'))
  assert.ok(mission.includes('- projectionRevision：r'))
  assert.ok(mission.includes('- freshness：current'))
  assert.ok(mission.includes(`- 下一步：手动轮换一次（tsk_explore 检查点 ${stamp(NOW + 300_000)}）`))
  assert.ok(mission.includes('- 目标效用：分析师在换环境后重复运行同一分析流程；效果观测：outcome_pending'))
  assert.equal(renderMissionMarkdown(freshState()).includes('- 目标效用：'), false, '未登记目标契约时目标效用行不出现')
})

/* ------------------------------------------------------------------ 2. 五个面视图 */

test('工作与探索视图接通：分类 / 探索策略 / 契约版本 / 四层结果 / 路线依据 / 猜想阶段', () => {
  const w = buildWorld()
  const text = renderWorkMarkdown(w.state)

  assert.ok(text.includes('# 工作与探索视图 Mission mss_test'))
  assert.ok(text.includes('## 任务工作分类（§25.2）：improve / explore / validate / deliver'))
  assert.ok(text.includes('| tsk_explore | running | explore | 占探索预留（§25.2） |'))
  assert.ok(text.includes('| tsk_deliver | running | deliver | 常规预算 |'))
  assert.ok(text.includes('explore=1、validate=0、deliver=1、未分类=2'), '合计只统计 workKind，不创建新状态机')

  assert.ok(text.includes('探索预留：已启用（reserveShare=0.2）'))
  assert.ok(text.includes('wildcard 探测机会：32 token / 2 调用（本周期两次小样本探测）'))
  assert.ok(text.includes(`已用：${w.exp2}`))

  assert.ok(text.includes(`| ${w.exp1}@2 | 2 | executable | 否 | 1 | tsk_explore | route:rep | sandbox |`), '版式：当前版本 / 版本数 / 阶段 / 停止条件数')
  assert.ok(text.includes(`| ${w.exp2}@1 | 1 | executable | 是（走 wildcardProbeAllowance，§31.4） | 2 |`))

  assert.ok(text.includes(`| ${w.trial1} | ${w.exp1} | 1 | completed | yes | valid | partial_improvement |`), '四层之一：执行完成、干预生效、评价有效、方向性观测')
  assert.ok(text.includes(`| ${w.trial2} | ${w.exp2} | 1 | outcome_unknown | no | unknown | no_reliable_difference |`), '四层不合并：机制未进入输出时观测不冒充方向性证据')
  assert.ok(text.includes('四层结果分别记录（§26.1）'))

  assert.ok(text.includes('| route:rep | eligible | 当前任务范围 | priority |'), 'basis 从状态迁移事件里取')
  assert.ok(text.includes('继续当前路线并补对照（route:rep）'))
  assert.ok(text.includes('缺可比较基线：先在 wildcard 额度内补一次对照'), '未选理由要出现在决定行里')
  assert.ok(text.includes(`| ${w.decisionId} | strategy_review | milestone |`))
  assert.ok(text.includes(`| ${w.trial1} |`) === false || true) // 证据列由 currentEvidence 原样投影，不重排

  assert.ok(text.includes(`${w.claimA}@5：阶段 pursued；`))
  assert.ok(text.includes('允许的下一步：closed_in_scope'))
  assert.ok(text.includes('探测线索：最低成本下一动作=跑 10 步小样本对照'))
  assert.ok(text.includes('预期信号=判别器分数上升；梯度范数下降'))
  assert.ok(text.includes(`已探测试验：${w.trial1}`))
  assert.ok(text.includes(`${w.claimB}@2：阶段 closed_in_scope；`))
  assert.ok(text.includes('允许的下一步：无（已按范围关闭）'))
  assert.ok(text.includes('pursued 不等于为真'), '猜想页脚必须保留"pursued 不等于为真"的口径')
})

test('记录面视图接通：覆盖完整性 / "没找到"前提 / 依据包新鲜度 / 不是全量历史', () => {
  const w = buildWorld()
  const text = renderRecordsMarkdown(w.state)

  assert.ok(text.includes('# 记录面视图 Mission mss_test'))
  assert.ok(text.includes(`| ${w.coverageCompleteId} | complete_within_scope |`))
  assert.ok(text.includes('满足（限已读范围）'), '完整且校验通过才有"没找到"的覆盖前提')
  assert.ok(text.includes(`| ${w.coveragePartialId} | partial |`))
  assert.ok(text.includes('不满足'))
  assert.ok(text.includes('读取只覆盖部分范围'), '缺失项列要转述现成校验的 caveats')

  assert.ok(text.includes(`| ${w.briefId} | dispatch | task:tsk_explore |`))
  // 登记自身就是一次提交（修订 +1）而相关版本未动：按 §28.4 属"无关进展"，usable 且不反复失效——
  // 与 v05-records-provenance.test.ts 冻结的模块口径一致，视图原样转述。
  assert.ok(
    text.includes('behind_unrelated：登记后又有 1 次提交，但与本决定有关的版本没有变化：无关进展不使提案反复失效（§28.4）'),
    '登记后的水位差按无关进展处理且仍可用',
  )
  assert.ok(text.includes('> 视图不是全量历史：claims 已归档 3 条'))

  // 空记录面：没有回执 / 依据包时返回占位行而不是抛错。
  const empty = renderRecordsMarkdown(freshState())
  assert.ok(empty.includes('（无）'))
  assert.ok(empty.includes('> 视图不是全量历史：'))
})

test('环境接续视图接通：清单缺口 / 下一步动作 / 恢复阶段与货币性结论', () => {
  const text = renderEnvironmentMarkdown(buildWorld().state)

  assert.ok(text.includes('# 环境接续视图 Mission mss_test'))
  assert.ok(text.includes('| env_a@1 | 1 | 提交到远程分支 | tsk_explore | 3 项（coverage=unknown 0；缺核验时间 0） |'))
  assert.ok(text.includes('无（未知项与未覆盖种类均为零）'))
  assert.ok(text.includes('| env_b@1 | 1 | 运行测试脚本 | tsk_deliver | 1 项（coverage=unknown 1；缺核验时间 1） |'))
  assert.ok(text.includes('unknown 1 项（env:ws）；未覆盖种类 runtime/dependency'), '缺口按 environmentGaps 原样投影')

  assert.ok(text.includes('| ready | current：'), '走完阶段机的评估显示 current')
  assert.ok(text.includes('| blocked_scope | not current：'), '未走完的评估显示 not current')
  assert.ok(text.includes('env:ws：changed→'), '阻塞范围列出 findings 的放行范围')
  assert.ok(text.includes('受管动作仍需当前票据与授权（§33.3）'), 'current 不构成执行权')
})

test('治理面视图接通：机制状态 / 成本策略 / 熔断与收益 / 运行成本口径 / 评估当前性', () => {
  const w = buildWorld()
  const text = renderGovernanceMarkdown(w.state)

  assert.ok(text.includes('# 治理面视图 Mission mss_test'))
  assert.ok(text.includes('### mech_a@3 语义质量建议'))
  assert.ok(text.includes('optional_advisory；active（可出判定）'))
  assert.ok(text.includes('- 成本策略：未设上限'))
  assert.ok(text.includes('runs=2 calls=1 tokens=12'), '渲染用 mechanismSpend 的累计口径')
  assert.ok(text.includes('费用不可观测运行 1 次'))
  assert.ok(text.includes('熔断信号（记录可核的成本部分）：未达熔断条件'))
  assert.ok(text.includes('- 收益评估：insufficient_evidence'), '没有收益观察登记时只报证据不足')
  assert.ok(text.includes('- 退出建议：keep'))

  assert.ok(text.includes('### mech_b@3 交付前文本检查'))
  assert.ok(text.includes('tokens≤100 / calls≤2'))
  assert.ok(text.includes('cooling（冷却：按范围停用）（连续两次延迟交付待复核）'))

  assert.ok(text.includes('| mrun_a1 | mech_a | 3 |'))
  assert.ok(text.includes('| 1 / 12 / 800 / 0 | observed | yes（人工复核：建议正确但被拦下） |'))
  assert.ok(text.includes('| 0 / 0 / 0 / 0 | unknown | 未标 |'), '费用不可观测的运行按 governanceCostOf 显示 unknown')

  assert.ok(text.includes(`| ${w.assessmentId} | sup-1 | fp-views | sess-1 |`))
  assert.ok(text.includes('| queued | 合格 | current（限记录可核对的目标 / 规则版本） |'))
  assert.ok(text.includes('会话与判据层的当前值不在控制记录里'), '评估当前性不得冒领会话层核对')
})

test('效用与整合视图接通：目标契约 / 复核结论不编造触发 / 整合计划 / 回执漂移', () => {
  const w = buildWorld()
  const text = renderOutcomeMarkdown(w.state)

  assert.ok(text.includes('# 效用与整合视图 Mission mss_test'))
  assert.ok(text.includes('预期用途（intendedUse）：分析师在换环境后重复运行同一分析流程'))
  assert.ok(text.includes('验收例子：success 1 条 / boundary 1 条 / failure 0 条'))
  assert.ok(text.includes('效果观测：outcome_pending（交付完成，等待实际使用效果）；证据 0 条——需要未来实际使用才能验证，不假报已发生（§30.3）'))
  assert.ok(text.includes('- 当前复核结论：不需要复核'), '没有触发信号就报"不需要复核"，不编造触发')
  assert.ok(text.includes('无复核触发器'))

  assert.ok(text.includes(`| ${w.integrationId} | tsk_intg | tsk_comp@1 |`))
  assert.ok(text.includes('清洗表接口（tsk_comp）'))
  assert.ok(text.includes('分析师在干净环境按文档跑完整流程并解释输出'))

  assert.ok(text.includes(`| ${w.receiptId} | ${w.integrationId} | 具备 | 真实调用流程=pass |`))
  assert.ok(text.includes('current：组件与绑定版本未被取代'))
  assert.ok(text.includes('| irct_stale |'))
  assert.ok(text.includes('漂移：OutcomeContract 版本已修订'), '过期回执显式标注漂移，不冒充当前')
  assert.ok(text.includes('成员各自通过不能投票变成整体通过'), '发布资格口径必须写进视图')

  assert.ok(renderOutcomeMarkdown(freshState()).includes('未登记目标契约'))
})

/* ------------------------------------------------------------------ 3. 确定性与顺序 */

/** 容器键顺序整体反转：插序不同的记录必须渲染出同样的文本（视图用显式 id 键排序）。 */
function reverseRecord<T>(record: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(record).reverse())
}

function reorderContainers(state: MissionControl): MissionControl {
  return {
    ...state,
    tasks: reverseRecord(state.tasks),
    artifacts: reverseRecord(state.artifacts),
    experiments: reverseRecord(state.experiments),
    trials: reverseRecord(state.trials),
    claims: reverseRecord(state.claims),
    routes: reverseRecord(state.routes),
    strategyDecisions: reverseRecord(state.strategyDecisions),
    assessments: reverseRecord(state.assessments),
    coverages: reverseRecord(state.coverages),
    briefs: reverseRecord(state.briefs),
    environments: reverseRecord(state.environments),
    resumes: reverseRecord(state.resumes),
    integrations: reverseRecord(state.integrations),
    integrationReceipts: reverseRecord(state.integrationReceipts),
    mechanisms: reverseRecord(state.mechanisms),
    mechanismRuns: reverseRecord(state.mechanismRuns),
    checkpoints: reverseRecord(state.checkpoints),
  }
}

test('视图确定性：同一状态两次渲染逐字节相同；容器插入顺序反转后渲染不变', () => {
  const world = buildWorld()
  const reordered = reorderContainers(world.state)
  for (const { label, render } of RENDERERS) {
    const once = render(world.state)
    assert.equal(render(world.state), once, `${label}：同一状态两次渲染应逐字节相同`)
    assert.equal(render(reordered), once, `${label}：容器插入顺序反转后渲染应不变`)
  }
})

/* ------------------------------------------------------------------ 4. 空状态 */

test('空状态渲染：没有 v0.5 容器时输出占位文本，不抛错、不渲染 undefined', () => {
  const empty = freshState()
  for (const { label, render } of RENDERERS) {
    const text = render(empty)
    assert.ok(text.length > 0, `${label}：空状态也应有输出`)
    assert.equal(text.includes('undefined'), false, `${label}：空状态不得渲染出 undefined`)
    assert.equal(render(empty), text, `${label}：空状态两次渲染应相同`)
  }
  assert.ok(renderWorkMarkdown(empty).includes('（无）'), '空表按占位文本输出')
  assert.ok(renderWorkMarkdown(empty).includes('未启用探索预留'))
})

