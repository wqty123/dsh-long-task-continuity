/**
 * 设计稿验收电池（v0.5 §29.1 的 V4-01…V4-06 与 §36.2 的 V5-03…V5-05）。
 *
 * 每条 V 编号一个用例，标题里写明"拦错侧 + 放行侧"两侧口径；断言走 `src/core/experiment.ts`
 * 的读写函数与返回结构（与 `v05-experiment.test.ts` 同一手法），不做字符串弱匹配。
 * 本文件自包含：夹具从 `v05-experiment.test.ts` 原样复制，只共享 `./fixtures.ts` 的 NOW / freshState。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Actor, ClaimRevision, EvidenceRecord, ReviewReceipt, Task, Verification } from '../src/core/entities.ts'
import { mintCriteria } from '../src/core/entities.ts'
import type { MissionControl } from '../src/core/control.ts'
import { missionCompletion } from '../src/core/completion.ts'
import { criteriaReport } from '../src/core/discipline.ts'
import { NOW, draftMission, freshState } from './fixtures.ts'
import type { ExperimentDraft, ExplorationRegistration, TrialDraft } from '../src/core/experiment.ts'
import {
  advanceExperimentStage,
  captureConjecture,
  classifyTaskWork,
  conclusionScope,
  conjectureView,
  evaluateRetry,
  experimentHead,
  explorationEntitlement,
  explorationPulse,
  frameConjecture,
  prematureNegationCheck,
  preregisterExperiment,
  probeReadyConjecture,
  recordConjectureProbe,
  recordTrial,
  registerExplorationPolicy,
  registerStrategyDecision,
  releaseExplorationReservation,
  stagnationWindow,
  trialCanSupportComparison,
  unlimitedExcuseCheck,
  upsertRouteAssessment,
  wildcardProbeAllowanceCheck,
} from '../src/core/experiment.ts'

/* ------------------------------------------------------------------ 夹具（自包含） */

const A1 = 'lead-1'
const TASK_ID = 'tsk_1'

function taskOf(overrides: Partial<Task> = {}): Task {
  return {
    taskId: TASK_ID,
    missionId: 'mss_test',
    dependsOn: [],
    title: '试验宿主任务',
    scope: '隔离试验',
    exclusions: [],
    inputRefs: [],
    criteria: mintCriteria([{ text: '试验有可交付结论' }]),
    priority: 5,
    status: 'running',
    validity: 'current',
    objectiveRevision: 1,
    specRevision: 1,
    criteriaRevision: 1,
    criteriaCheck: 'consistent',
    resourceKeys: [],
    maxAttempts: 3,
    attemptCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function withTask(base: MissionControl, overrides: Partial<Task> = {}): MissionControl {
  const task = taskOf(overrides)
  return { ...base, tasks: { ...base.tasks, [task.taskId]: task } }
}

function registration(overrides: Partial<ExplorationRegistration> = {}): ExplorationRegistration {
  return {
    reserveShare: 0.2,
    maxTrialCost: { calls: 5, note: '单次试验至多 5 次调用' },
    minDiscernibleTrial: '一次小样本对照',
    reviewTriggers: ['每 10 次试验'],
    ...overrides,
  }
}

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

function preregistered(base: MissionControl, draft: ExperimentDraft = expDraft(), now = NOW): { readonly state: MissionControl; readonly experimentId: string } {
  const result = preregisterExperiment(base, draft, now, A1)
  if (!result.applied) throw new Error(`预登记被拒：${result.reason}`)
  return { state: result.state, experimentId: result.experimentId }
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

function recordOk(state: MissionControl, draft: TrialDraft, now = NOW): { readonly state: MissionControl; readonly trialId: string } {
  const result = recordTrial(state, draft, now, A1)
  if (!result.applied) throw new Error(`登记试验被拒：${result.reason}`)
  return { state: result.state, trialId: result.trialId }
}

function evidenceRecord(evidenceId: string): EvidenceRecord {
  return { evidenceId, missionId: 'mss_test', kind: 'observation', summary: `证据 ${evidenceId}`, observedAt: NOW, sourceRef: 'run:1', validity: 'current', recordedBy: A1 }
}

function withEvidence(base: MissionControl, ...ids: readonly string[]): MissionControl {
  const evidence: Record<string, EvidenceRecord> = { ...base.evidence }
  for (const id of ids) evidence[id] = evidenceRecord(id)
  return { ...base, evidence }
}

function claimRevision(overrides: Partial<ClaimRevision> = {}): ClaimRevision {
  return {
    claimId: 'clm_1',
    version: 1,
    proposition: '候选机制有效',
    appliesUnder: [],
    sourceCategory: 'observation',
    status: 'proposed',
    validity: 'current',
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    reentryConditions: [],
    authorActorId: A1,
    createdAt: NOW,
    ...overrides,
  }
}

function withClaim(base: MissionControl, revision: ClaimRevision): MissionControl {
  return { ...base, claims: { ...base.claims, [revision.claimId]: [...(base.claims[revision.claimId] ?? []), revision] } }
}

/** §25.2 的策略复核夹具：同族三次可比较试验、全部低收益。 */
function stagnantState(): { readonly state: MissionControl; readonly experimentId: string; readonly trialIds: readonly string[] } {
  const a = preregistered(withTask(freshState()))
  const t1 = recordOk(a.state, trialDraft(a.experimentId, { observed: 'lower_than_baseline', environment: 'env-A', inputVersions: ['d1'], budgetSpentNote: '9 次调用' }), NOW + 1)
  const t2 = recordOk(t1.state, trialDraft(a.experimentId, { observed: 'no_reliable_difference', environment: 'env-A', inputVersions: ['d1'], budgetSpentNote: '9 次调用' }), NOW + 2)
  const t3 = recordOk(t2.state, trialDraft(a.experimentId, { observed: 'no_reliable_difference', environment: 'env-A', inputVersions: ['d1'], budgetSpentNote: '9 次调用' }), NOW + 3)
  return { state: t3.state, experimentId: a.experimentId, trialIds: [t1.trialId, t2.trialId, t3.trialId] }
}

/** V4-06 前提：任务已满足验收（当前判据版本下有通过记录）。 */
function satisfiedTask(base: MissionControl): { readonly state: MissionControl; readonly task: Task } {
  const task = taskOf({ status: 'completed', workKind: 'explore' })
  const criterion = task.criteria[0]
  if (criterion === undefined) throw new Error('夹具任务缺判据')
  const verification: Verification = {
    verificationId: 'vrf_1',
    missionId: 'mss_test',
    taskId: task.taskId,
    criterionId: criterion.criterionId,
    criteriaRevision: task.criteriaRevision,
    criterion: criterion.text,
    method: '脚本断言',
    methodVersion: 'v1',
    outcome: 'pass',
    checksRun: 12,
    evidenceRefs: [],
    verifier: A1,
    verifiedAt: NOW,
  }
  // 这个任务 `completed` 即进"已交付"，会撞上收口面的 R6（交付后需 reviewer 审核整体结果）。
  // 本夹具的断言只针对"探索预留是否阻断完成判定"，所以把 R6 的前提一并备齐，
  // 让它测的仍然是它自己那条判据。
  const reviewer: Actor = {
    actorId: 'reviewer-1',
    missionId: 'mss_test',
    role: 'reviewer',
    label: '夹具 reviewer',
    bindingVersion: 1,
    available: true,
    dormant: false,
    retired: false,
    rotationsLastHour: [],
    createdAt: NOW,
    updatedAt: NOW,
  }
  const review: ReviewReceipt = {
    reviewId: 'rev_1',
    missionId: 'mss_test',
    targetKind: 'task',
    targetId: task.taskId,
    selfConsistent: 'pass',
    versusHistory: 'consistent',
    sharedEvidenceIds: [],
    sawReferenceAnswer: false,
    independenceNote: '夹具：reviewer 对整体结果的独立审查记录',
    reviewerActorId: reviewer.actorId,
    methodRef: '夹具',
    reviewedAt: NOW,
  }
  return {
    state: {
      ...base,
      tasks: { ...base.tasks, [task.taskId]: task },
      verifications: { vrf_1: verification },
      actors: { ...base.actors, [reviewer.actorId]: reviewer },
      reviews: { [review.reviewId]: review },
    },
    task,
  }
}

/* ------------------------------------------------------------------ §29.1 V4-01 */

test('V4-01 连续同族微调无可靠增益：触发策略复核并按策略给有界探索机会，有证据的继续优化仍放行', () => {
  const fixture = stagnantState()
  const state = fixture.state
  const report = stagnationWindow(state, { routeFamilyId: 'route:rep', from: NOW, to: NOW + 10, preset: { minComparableTrials: 2, maxLowGainShare: 0.5 } })
  assert.equal(report.stagnant, true, '同族三次可比较试验全部低收益必须判停滞并生成策略复核')
  assert.equal(report.lowGainTrials, 3, '低收益按可比较试验统计，不按聊天消息条数')
  const window = { comparableTrials: 3, resourceNote: '3 次可比较试验与操作回执齐全', from: NOW, to: NOW + 10 }
  const chosen = { routeFamilyId: 'route:alt', option: '换表征的新路线先做有界探测', expectedInfoValue: '能区分表征限制与噪声', costNote: '两次小样本调用', chosen: true }
  const rejected = { routeFamilyId: 'route:rep', option: '继续同族微调', expectedInfoValue: '边际信息价值已低', costNote: '两次调用', chosen: false, rejectedReason: '同族微调边际收益低，先给新路线时间片' }
  const baseDraft = {
    kind: 'strategy_review' as const,
    trigger: 'stagnation_window' as const,
    window,
    currentEvidence: ['同族三次可比较试验均低收益'],
    candidates: [chosen, rejected],
    costNote: '两次小样本调用',
    reviewTrigger: '下个里程碑或新证据出现',
    stagnationCheck: { routeFamilyId: 'route:rep', preset: { minComparableTrials: 2, maxLowGainShare: 0.5 } },
  }
  const mismatch = registerStrategyDecision(state, { ...baseDraft, window: { ...window, comparableTrials: 50 } }, NOW + 4, A1)
  assert.equal(mismatch.applied, false, '自报窗口与记录不符的策略复核必须拒绝')
  assert.match(mismatch.reason, /不按消息条数/)
  const decision = registerStrategyDecision(state, baseDraft, NOW + 5, A1)
  assert.equal(decision.applied, true, '停滞窗口按记录重算一致时才登记策略复核')
  if (!decision.applied) return
  assert.equal(decision.stagnant, true)
  const stored = decision.state.strategyDecisions[decision.decisionId]
  assert.equal(stored?.candidates.find((candidate) => candidate.chosen)?.routeFamilyId, 'route:alt', '复核要选出有界新路线而不是继续同族微调')
  const explored = classifyTaskWork(decision.state, TASK_ID, 'explore', NOW + 6)
  assert.equal(explored.applied, true, '复核结论要落到探索任务分类才能按时片调度')
  if (!explored.applied) return
  const policy = registerExplorationPolicy(explored.state, registration({ wildcardProbeAllowance: { calls: 2, note: '至多 2 次调用' } }), NOW + 7, A1)
  assert.equal(policy.applied, true, '有界新路线要有探索策略与额度来源')
  if (!policy.applied) return
  const entitled = explorationEntitlement(policy.state, TASK_ID)
  assert.equal(entitled.drawsOnReservation, true, '分类为 explore 的任务按策略占用探索预留')
  assert.equal(entitled.reservationEnabled, true)
  assert.equal(wildcardProbeAllowanceCheck(policy.state, { calls: 2 }).ok, true, '按策略提供有界探索机会')
  assert.equal(wildcardProbeAllowanceCheck(policy.state, { calls: 3 }).ok, false, '超出有界额度的探索机会必须被拒')
  const evidenced = withEvidence(policy.state, 'ev_new')
  const continued = evaluateRetry(evidenced, { experimentId: fixture.experimentId, purpose: 'new_evidence', trigger: 'new_evidence', changes: ['补一组对照输入以区分噪声与机制'], newEvidenceRefs: ['ev_new'], lastTrialId: fixture.trialIds[2] })
  assert.equal(continued.ok, true, '有证据的继续优化仍可放行')
  const renameOnly = evaluateRetry(policy.state, { experimentId: fixture.experimentId, purpose: 'recovery', trigger: 'implementation_fixed', changes: ['改名为方案 B'], lastTrialId: fixture.trialIds[2] })
  assert.equal(renameOnly.materiality, 'trivial_only', '改名要按 trivial 变更识别')
  assert.equal(renameOnly.ok, false, '没有新证据的改名重试要推迟')
})

/* ------------------------------------------------------------------ §29.1 V4-02 */

test('V4-02 新路线有效试验得分较低：保留当前最佳版本且候选不被自动采纳，探索按契约完成', () => {
  const a = preregistered(withTask(freshState()), expDraft({ routeFamilyId: 'route:new', candidateMechanism: '新表征层', differenceFromCurrent: '替换表征层而非继续调参' }))
  const t = recordOk(a.state, trialDraft(a.experimentId, { observed: 'lower_than_baseline', environment: 'env-A', inputVersions: ['d1'], codeVersions: ['commit-new'], budgetSpentNote: '12 次调用' }), NOW + 1)
  const state = t.state
  assert.equal(trialCanSupportComparison(state, t.trialId).ok, true, '四层齐全的试验才算有效试验')
  const scope = conclusionScope(state, t.trialId)
  assert.equal(scope.ok, true)
  assert.match(scope.limitation, /只约束当次条件/, '得分较低只约束当次条件，不覆盖当前最佳版本')
  assert.equal(experimentHead(state, a.experimentId)?.baselineRef, 'baseline:v0', '当前最佳版本仍作为基线保留，未被试验结果覆盖')
  assert.equal(experimentHead(state, a.experimentId)?.stage, 'executable', '有效试验不自动把候选升级到发布')
  assert.equal(state.routes['route:new'], undefined, '候选不被自动采纳：路线视图里没有自动写入的状态')
  const negation = prematureNegationCheck(state, { trialId: t.trialId, proposedScope: 'route' })
  assert.equal(negation.blocked, true, '单次有效负结果也不能自动关闭整条新路线')
  const advanced = advanceExperimentStage(state, a.experimentId, 'small_scale_validity', { note: '得分低于基线同样可按契约完成小规模有效性检查', witnessTrialIds: [t.trialId] }, NOW + 2, A1)
  assert.equal(advanced.applied, true, '探索可按契约完成：阶段推进不以得分为门槛')
  if (!advanced.applied) return
  const undecided = upsertRouteAssessment(advanced.state, { routeFamilyId: 'route:new', scope: '本次隔离试验范围', state: 'disfavored_in_scope', basis: 'evidence', reason: '得分低于基线' }, NOW + 3, A1)
  assert.equal(undecided.applied, false, '降级 / 否定候选要有证据引用，不能凭得分自动生成')
  const decided = upsertRouteAssessment(advanced.state, { routeFamilyId: 'route:new', scope: '本次隔离试验范围', state: 'disfavored_in_scope', basis: 'evidence', reason: '在 env-A / d1 下有效试验得分低于基线', evidenceRefs: [t.trialId], reentryConditions: ['数据规模扩大后重看'] }, NOW + 4, A1)
  assert.equal(decided.applied, true, '候选只有经带证据的显式范围内决定后才写入路线视图')
  if (!decided.applied) return
  assert.equal(decided.previous, undefined, '此前不存在自动采纳留下的旧状态')
  assert.equal(decided.state.routes['route:new']?.state, 'disfavored_in_scope')
})

/* ------------------------------------------------------------------ §29.1 V4-03 */

test('V4-03 配置变化但实际处理未生效：标为执行 / 评价问题不永久否定机制，修复后可有界重试', () => {
  const a = preregistered(freshState())
  const dg11 = recordTrial(a.state, trialDraft(a.experimentId, { treatmentApplied: 'no', observed: 'lower_than_baseline' }), NOW + 1, A1)
  assert.equal(dg11.applied, false, '实际处理未生效却报方向性观测必须在登记层拦住')
  assert.match(dg11.reason, /DG-11/)
  const execProblem = recordOk(a.state, trialDraft(a.experimentId, { execution: 'dependency_missing', treatmentApplied: 'unknown', evaluationValidity: 'unknown', observed: 'not_measured' }), NOW + 2)
  const comparability = trialCanSupportComparison(execProblem.state, execProblem.trialId)
  assert.equal(comparability.ok, false, '实际处理未生效的试验不构成机制证据')
  assert.match(comparability.reason, /执行层/, '先标为执行问题而不是机制结论')
  const evalProblem = recordOk(execProblem.state, trialDraft(a.experimentId, { evaluationValidity: 'baseline_incomparable', observed: 'no_reliable_difference' }), NOW + 3)
  assert.match(trialCanSupportComparison(evalProblem.state, evalProblem.trialId).reason, /评价层/, '评价无效的试验同样标为评价问题')
  const evaluationProblem = recordOk(evalProblem.state, trialDraft(a.experimentId, { treatmentApplied: 'no', observed: 'no_reliable_difference' }), NOW + 4)
  const negation = prematureNegationCheck(evaluationProblem.state, { trialId: evaluationProblem.trialId, proposedScope: 'route' })
  assert.equal(negation.blocked, true, '配置变化未生效时的负向观测不能永久否定机制')
  assert.match(negation.reason, /实际处理/)
  assert.equal(unlimitedExcuseCheck(evaluationProblem.state, { experimentId: a.experimentId, attribution: 'implementation_issue' }).blocked, true, '错误归因没有证据必须拦住')
  const withEv = withEvidence(evaluationProblem.state, 'ev_impl')
  const noFix = unlimitedExcuseCheck(withEv, { experimentId: a.experimentId, attribution: 'implementation_issue', evidenceRefs: ['ev_impl'] })
  assert.equal(noFix.blocked, false)
  assert.equal(noFix.recordOnly, true, '有证据但没有修复动作只能记录：直接重试会落在同一条件下')
  const fixed = unlimitedExcuseCheck(withEv, { experimentId: a.experimentId, attribution: 'evaluation_issue', evidenceRefs: ['ev_impl'], fixes: ['修正评价器正反例后重跑'] })
  assert.equal(fixed.blocked, false)
  assert.equal(fixed.recordOnly, false, '归因有证据且修复动作已列出，可按新条件重新评估')
  const bounded = evaluateRetry(withEv, { experimentId: a.experimentId, purpose: 'recovery', trigger: 'implementation_fixed', changes: ['修复依赖注入后重跑对照'], lastTrialId: evaluationProblem.trialId })
  assert.equal(bounded.ok, true, '修复后可申请有界重试')
  assert.equal(bounded.materiality, 'material')
  assert.ok(bounded.sameConditionTrials >= 1, '重试判定要给出同条件试验计数作为有界口径')
  const renameOnly = evaluateRetry(withEv, { experimentId: a.experimentId, purpose: 'recovery', trigger: 'implementation_fixed', changes: ['改名为版本二'], lastTrialId: evaluationProblem.trialId })
  assert.equal(renameOnly.materiality, 'trivial_only', '改名要按 trivial 变更识别，不算修复动作')
  assert.equal(renameOnly.ok, false, '没有修复动作的改名重试仍要推迟')
})

/* ------------------------------------------------------------------ §29.1 V4-04 */

test('V4-04 有效负结果被改名反复重试：先识别同族与同条件并推迟，预登记噪声重复测量可执行', () => {
  const a = preregistered(withTask(freshState()))
  const t1 = recordOk(a.state, trialDraft(a.experimentId, { observed: 'lower_than_baseline', environment: 'env-A', inputVersions: ['d1'] }), NOW + 1)
  const rename1 = evaluateRetry(t1.state, { experimentId: a.experimentId, purpose: 'recovery', trigger: 'implementation_fixed', changes: ['改名为方案 B 再跑'], lastTrialId: t1.trialId })
  assert.equal(rename1.ok, false, '只改名不构成新假设，重试要推迟')
  assert.equal(rename1.materiality, 'trivial_only', '改名要按 trivial 变更识别')
  assert.equal(rename1.sameConditionTrials, 1, '同条件识别按环境与输入版本口径计数')
  const undeclared = evaluateRetry(t1.state, { experimentId: a.experimentId, purpose: 'repeat_measurement', trigger: 'constraint_change', changes: ['再测一次噪声'], lastTrialId: t1.trialId })
  assert.equal(undeclared.ok, false, '未预声明的重复测量不得当作重试理由')
  assert.match(undeclared.reason, /预登记设计/)
  const declared = evaluateRetry(t1.state, { experimentId: a.experimentId, purpose: 'repeat_measurement', trigger: 'constraint_change', changes: ['按预登记噪声设计重复测量'], repeatDesignPredeclared: true, lastTrialId: t1.trialId })
  assert.equal(declared.ok, true, '预登记的噪声重复测量可执行')
  const t2 = recordOk(t1.state, trialDraft(a.experimentId, { observed: 'no_reliable_difference', environment: 'env-A', inputVersions: ['d1'] }), NOW + 2)
  const rename2 = evaluateRetry(t2.state, { experimentId: a.experimentId, purpose: 'recovery', trigger: 'implementation_fixed', changes: ['改名为方案 B 再跑'], lastTrialId: t2.trialId })
  assert.equal(rename2.ok, false, '同条件反证面前改名仍要推迟')
  assert.equal(rename2.sameConditionTrials, 2, '同条件计数要覆盖两次同环境同输入版本的试验')
  assert.match(rename2.reason, /实质差异/)
  const t3 = recordOk(t2.state, trialDraft(a.experimentId, { observed: 'no_reliable_difference', environment: 'env-A', inputVersions: ['d1'] }), NOW + 3)
  const capped = evaluateRetry(t3.state, { experimentId: a.experimentId, purpose: 'recovery', trigger: 'implementation_fixed', changes: ['改名为方案 C'], lastTrialId: t3.trialId })
  assert.equal(capped.ok, false, '同条件反证充分时改名重试封顶')
  assert.equal(capped.sameConditionTrials, 3, '达到 maxTaskRetries 的同条件试验要被完整识别')
  assert.match(capped.reason, /无限消耗预算/)
  const renamed = preregistered(t3.state, expDraft({ routeFamilyId: 'route:rep', candidateMechanism: '改名后的方案 C', differenceFromCurrent: '只改名称不改机制' }))
  const tRenamed = recordOk(renamed.state, trialDraft(renamed.experimentId, { observed: 'lower_than_baseline', environment: 'env-A', inputVersions: ['d1'] }), NOW + 4)
  const family = stagnationWindow(tRenamed.state, { routeFamilyId: 'route:rep', from: NOW, to: NOW + 10, preset: { minComparableTrials: 2, maxLowGainShare: 0.5 } })
  assert.equal(family.ok, true)
  assert.equal(family.window.comparableTrials, 4, '改名不改路线族：同族投入按 routeFamilyId 汇总')
  assert.ok(family.trialIds.includes(tRenamed.trialId), '改名后的试验仍计入同族窗口')
  assert.equal(family.stagnant, true, '改名后低收益占比不变，仍要判停滞')
})

/* ------------------------------------------------------------------ §29.1 V4-05 */

test('V4-05 环境改变但旧摘要写"该方法失败"：先取回原始适用范围并重评，证据充分才维持否定', () => {
  const a = preregistered(freshState())
  const t1 = recordOk(a.state, trialDraft(a.experimentId, { observed: 'lower_than_baseline', environment: 'env-A', inputVersions: ['d1'], codeVersions: ['v1'], budgetSpentNote: '8 次调用' }), NOW + 1)
  const scope = conclusionScope(t1.state, t1.trialId)
  assert.equal(scope.ok, true)
  assert.equal(scope.environment, 'env-A', '取回原始适用范围要先还原当时的环境')
  assert.deepEqual(scope.implementationVersions, ['v1'], '实现版本要随结论保留，与环境一起构成前提')
  assert.equal(scope.budgetNote, '8 次调用')
  assert.match(scope.limitation, /只约束当次条件/, '旧摘要不能写成无条件的"该方法失败"')
  const staleScope = prematureNegationCheck(t1.state, { trialId: t1.trialId, proposedScope: 'route' })
  assert.equal(staleScope.blocked, true, '环境改变后沿用单次旧结论维持路线级否定要拦住')
  assert.match(staleScope.reason, /重复检验/)
  const local = prematureNegationCheck(t1.state, { trialId: t1.trialId, proposedScope: 'trial' })
  assert.equal(local.blocked, false, '环境无关的当次范围否定可以维持')
  assert.match(local.reason, /当次条件/)
  const t2 = recordOk(t1.state, trialDraft(a.experimentId, { observed: 'lower_than_baseline', environment: 'env-B', inputVersions: ['d2'], codeVersions: ['v1'], budgetSpentNote: '8 次调用' }), NOW + 2)
  const reviewed = prematureNegationCheck(t2.state, { trialId: t1.trialId, proposedScope: 'route' })
  assert.equal(reviewed.blocked, false, '在改变后的环境里重评拿到覆盖关键条件的可比较负结果，允许维持否定')
  assert.match(reviewed.reason, /覆盖关键条件/)
  const noReentry = upsertRouteAssessment(t2.state, { routeFamilyId: 'route:rep', scope: 'env-A / env-B 两次试验范围', state: 'closed_in_scope', basis: 'evidence', reason: '两次可比较负结果', evidenceRefs: [t1.trialId, t2.trialId] }, NOW + 3, A1)
  assert.equal(noReentry.applied, false, '维持否定要保留重新评估条件，不能写成无条件关闭')
  const closed = upsertRouteAssessment(t2.state, { routeFamilyId: 'route:rep', scope: 'env-A / env-B 两次试验范围', state: 'closed_in_scope', basis: 'evidence', reason: '两次可比较负结果', evidenceRefs: [t1.trialId, t2.trialId], reentryConditions: ['环境或实现版本变化后重评'] }, NOW + 4, A1)
  assert.equal(closed.applied, true, '证据充分时才允许按范围维持否定并登记重入条件')
  if (!closed.applied) return
  assert.equal(closed.state.routes['route:rep']?.state, 'closed_in_scope')
})

/* ------------------------------------------------------------------ §29.1 V4-06 */

test('V4-06 任务已满足验收但探索预留未花完：允许完成并释放预留，不制造额外任务', () => {
  const pinned = satisfiedTask(freshState({ mission: { ...draftMission(), criteria: [] } }))
  assert.equal(criteriaReport(pinned.state, pinned.task).satisfied, true, '前提：任务在当前判据版本下验收已满足')
  const registered = registerExplorationPolicy(pinned.state, registration(), NOW, A1)
  assert.equal(registered.applied, true, '探索预留仍存在且未花完')
  if (!registered.applied) return
  assert.equal(missionCompletion(registered.state).ready, true, '探索预留未花完不阻断完成判定')
  assert.equal(registered.state.mission.exploration?.reserveReleasedAt, undefined)
  assert.equal(releaseExplorationReservation(pinned.state, { reason: '交付临近', recheck: '下个里程碑' }, NOW + 1, A1).applied, false, '没有登记探索策略时没有预留可释放')
  assert.equal(releaseExplorationReservation(registered.state, { reason: ' ', recheck: '下个里程碑' }, NOW + 2, A1).applied, false, '释放要写明理由')
  assert.equal(releaseExplorationReservation(registered.state, { reason: '交付临近', recheck: '' }, NOW + 3, A1).applied, false, '释放要写明复核条件')
  const before = Object.keys(registered.state.tasks).sort()
  const released = releaseExplorationReservation(registered.state, { reason: '交付临近且任务验收已满足，预留未花完', recheck: '下个长期迭代复核预算' }, NOW + 4, A1)
  assert.equal(released.applied, true, '允许释放未花完的探索预留')
  if (!released.applied) return
  const entitlement = explorationEntitlement(released.state, TASK_ID)
  assert.equal(entitlement.reservationReleased, true)
  assert.match(entitlement.reason, /交付临近且任务验收已满足/)
  const pulse = explorationPulse(released.state, NOW + 5)
  assert.equal(pulse.released, true)
  assert.equal(pulse.reserveShare, 0.2)
  assert.deepEqual(Object.keys(released.state.tasks).sort(), before, '释放预留不得制造额外任务')
  assert.equal(wildcardProbeAllowanceCheck(released.state, { calls: 1 }).ok, false, '预留释放后不再新开探测：不制造额外探索')
  assert.equal(missionCompletion(released.state).ready, true, '释放预留不产生新的完成缺口')
  const reclassify = classifyTaskWork(released.state, TASK_ID, 'explore', NOW + 6)
  assert.equal(reclassify.applied, false, '已满足验收的任务不再被标注探索分类，不回到调度队列')
  assert.match(reclassify.reason, /终态/)
  assert.equal(releaseExplorationReservation(released.state, { reason: '再释放一次', recheck: '下个里程碑' }, NOW + 7, A1).applied, false, '重复释放只留台账噪声')
})

/* ------------------------------------------------------------------ §36.2 V5-03 */

test('V5-03 大胆猜想：无支持文献且与 Lead 观点冲突也可登记并有界探测，不得声称已实测成功', () => {
  const base = withClaim(freshState(), claimRevision({ claimId: 'clm_lead', proposition: '当前路线足够，不必换表征', status: 'supported', supportingEvidenceIds: ['ev_lead'] }))
  const noSource = captureConjecture(base, { proposition: '猜想：换掉表征会有跃升', assumptionChange: '替换表征层而不是继续调参', sourceNote: ' ' }, NOW, A1)
  assert.equal(noSource.applied, false, '来源本身不是支持证据，但要记录：缺来源即拒绝')
  const capture = captureConjecture(base, { proposition: '猜想：换掉表征会有跃升', assumptionChange: '替换表征层而不是继续调参', sourceNote: '来源：主动构想，没有支持文献，且与 Lead 当前观点冲突' }, NOW + 1, A1)
  assert.equal(capture.applied, true, '没有支持文献且与 Lead 观点冲突不阻止登记')
  if (!capture.applied) return
  assert.match(capture.reason, /不声称已实测成功/)
  const claimId = capture.claimId
  assert.equal(conjectureView(capture.state, claimId).status, 'proposed', '登记后证据状态仍是 proposed')
  assert.equal(capture.state.claims['clm_lead']?.length, 1, 'Lead 的既有观点记录不被改写')
  const policy = registerExplorationPolicy(capture.state, registration({ wildcardProbeAllowance: { calls: 2, note: '至多 2 次调用' } }), NOW + 2, A1)
  if (!policy.applied) throw new Error(policy.reason)
  assert.equal(wildcardProbeAllowanceCheck(policy.state, { calls: 2 }).ok, true, '有界探测机会来自 wildcardProbeAllowance')
  assert.equal(wildcardProbeAllowanceCheck(policy.state, { calls: 3 }).ok, false, '有界探测不得超过额度')
  const framed = frameConjecture(policy.state, claimId, { expectedSignals: ['判别器分数上升'] }, NOW + 3, A1)
  if (!framed.applied) throw new Error(framed.reason)
  const ready = probeReadyConjecture(framed.state, claimId, { nextCheapestAction: '跑一次小样本对照' }, NOW + 4, A1)
  if (!ready.applied) throw new Error(ready.reason)
  const exp = preregisterExperiment(ready.state, expDraft({ wildcard: true, plannedCost: { calls: 1 } }), NOW + 5, A1)
  assert.equal(exp.applied, true, '落在有界额度内的探测可以不排收益名次而直接开跑')
  if (!exp.applied) return
  const trial = recordOk(exp.state, trialDraft(exp.experimentId, { claimRefs: [claimId], observed: 'partial_improvement', environment: 'env-A' }), NOW + 6)
  const probe = recordConjectureProbe(trial.state, claimId, { trialId: trial.trialId }, NOW + 7, A1)
  assert.equal(probe.applied, true, '有观测结果即可完成一次有界探测')
  if (!probe.applied) return
  assert.match(probe.reason, /status 不动/)
  assert.equal(conjectureView(probe.state, claimId).status, 'proposed', '一次探测不等于实测成功：证据状态保持 proposed')
  assert.deepEqual(probe.state.claims[claimId]?.at(-1)?.supportingEvidenceIds, [], '探测不得补写支持证据')
})

/* ------------------------------------------------------------------ §36.2 V5-04 */

test('V5-04 tested_hypothesis 未证实不阻止探测；实际授权或必要实验条件缺失仍限制执行', () => {
  const captured = captureConjecture(freshState(), { proposition: '猜想：延迟预算能提高稳定性', assumptionChange: '改变预算分配假设', sourceNote: '来源：与 Lead 讨论中提出' }, NOW, A1)
  if (!captured.applied) throw new Error(captured.reason)
  const claimId = captured.claimId
  const noAuthorization = preregisterExperiment(captured.state, expDraft({ wildcard: true, plannedCost: { calls: 1 } }), NOW + 1, A1)
  assert.equal(noAuthorization.applied, false, '实际授权缺失（没有 wildcard 额度来源）仍限制执行')
  assert.match(noAuthorization.reason, /wildcard/)
  const registered = registerExplorationPolicy(captured.state, registration({ wildcardProbeAllowance: { calls: 2, note: '至多 2 次调用' } }), NOW + 2, A1)
  if (!registered.applied) throw new Error(registered.reason)
  const framed = frameConjecture(registered.state, claimId, { expectedSignals: ['稳定性指标上升'] }, NOW + 3, A1)
  if (!framed.applied) throw new Error(framed.reason)
  const ready = probeReadyConjecture(framed.state, claimId, { nextCheapestAction: '跑最小对照' }, NOW + 4, A1)
  if (!ready.applied) throw new Error(ready.reason)
  assert.deepEqual(ready.state.claims[claimId]?.at(-1)?.supportingEvidenceIds, [], '前提：tested_hypothesis 尚无支持证据')
  const exp = preregisterExperiment(ready.state, expDraft({ wildcard: true, plannedCost: { calls: 1 } }), NOW + 5, A1)
  assert.equal(exp.applied, true, 'tested_hypothesis 未证实不阻止探测')
  if (!exp.applied) return
  assert.equal(experimentHead(exp.state, exp.experimentId)?.testedHypothesis, '新表征在下游指标上更好', '探测仍绑定事先写明的可检验假设')
  const trial = recordOk(exp.state, trialDraft(exp.experimentId, { claimRefs: [claimId], observed: 'partial_improvement', environment: 'env-A' }), NOW + 6)
  assert.equal(recordConjectureProbe(trial.state, claimId, { trialId: trial.trialId }, NOW + 7, A1).applied, true, '未证实的假设可以进入一次有效探测')
  const broken = recordOk(exp.state, trialDraft(exp.experimentId, { claimRefs: [claimId], execution: 'dependency_missing', treatmentApplied: 'unknown', evaluationValidity: 'unknown', observed: 'not_measured' }), NOW + 8)
  const blockedProbe = recordConjectureProbe(broken.state, claimId, { trialId: broken.trialId }, NOW + 9, A1)
  assert.equal(blockedProbe.applied, false, '必要实验条件缺失（执行未完成 / 处理未生效）仍限制执行')
  assert.match(blockedProbe.reason, /不能算已探测/)
  const released = releaseExplorationReservation(registered.state, { reason: '本周期预算优先交付', recheck: '下个预算周期复核' }, NOW + 10, A1)
  if (!released.applied) throw new Error(released.reason)
  const noAllowance = wildcardProbeAllowanceCheck(released.state, { calls: 1 })
  assert.equal(noAllowance.ok, false, '授权被释放后没有额度，探测执行仍受限')
  assert.match(noAllowance.reason, /已释放/)
})

/* ------------------------------------------------------------------ §36.2 V5-05 */

test('V5-05 概念不可直接验证时允许有界 framing；反复空想没有产出不得无限延长', () => {
  const captured = captureConjecture(freshState(), { proposition: '猜想：某种尚不可直接测量的结构性差异', assumptionChange: '改变前提假设', sourceNote: '来源：主动构想' }, NOW, A1)
  if (!captured.applied) throw new Error(captured.reason)
  const claimId = captured.claimId
  const empty = frameConjecture(captured.state, claimId, {}, NOW + 1, A1)
  assert.equal(empty.applied, false, 'framing 要产出可观察预测或当前不可检验的原因')
  assert.match(empty.reason, /不可检验的原因/)
  const framed = frameConjecture(captured.state, claimId, { notTestableReason: '当前概念还无法设计区分试验', nextCheapestAction: '整理该概念的可观察推论' }, NOW + 2, A1)
  assert.equal(framed.applied, true, '概念尚不可直接验证时允许有界 framing')
  if (!framed.applied) return
  assert.equal(framed.stage, 'framed')
  const view = conjectureView(framed.state, claimId)
  assert.equal(view.stage, 'framed')
  assert.equal(view.nextCheapestAction, '整理该概念的可观察推论', '有界 framing 要留下最低成本下一动作')
  assert.ok(view.allowedTransitions.includes('probe_ready'))
  const noOutput = probeReadyConjecture(framed.state, claimId, { nextCheapestAction: '再想一轮' }, NOW + 3, A1)
  assert.equal(noOutput.applied, false, '空想没有产出不得进入探测')
  assert.match(noOutput.reason, /可观察预测/)
  const spun = frameConjecture(framed.state, claimId, { notTestableReason: '还是一样不可检验' }, NOW + 4, A1)
  assert.equal(spun.applied, false, '反复空想没有产出不得无限延长')
  assert.match(spun.reason, /反复空想/)
  const produced = frameConjecture(framed.state, claimId, { expectedSignals: ['某个代理指标的变化'] }, NOW + 5, A1)
  assert.equal(produced.applied, true, '产出可观察预测后 framing 可以继续推进')
  if (!produced.applied) return
  const ready = probeReadyConjecture(produced.state, claimId, { nextCheapestAction: '跑最小对照' }, NOW + 6, A1)
  assert.equal(ready.applied, true, '有产出的猜想可进入 probe_ready')
})
