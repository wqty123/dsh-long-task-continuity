/**
 * v0.5 探索与改进并行、条件化失败与可修订结论、大胆猜想与分阶段求证（设计稿 §25、§26、§31）的单元用例。
 *
 * 每个判定正反例成对：表格里说放行的一侧必须放行，说拦住的一侧必须拦住；
 * 四层结果（执行 / 评价 / 观测 / 结论）分别断言，"未施加干预却有方向性观测"要被拒。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ClaimRevision, EvidenceRecord, StrategyDecision, Task } from '../src/core/entities.ts'
import { mintCriteria } from '../src/core/entities.ts'
import type { MissionControl } from '../src/core/control.ts'
import { NOW, freshState } from './fixtures.ts'
import type { ExplorationRegistration, ExperimentDraft, TrialDraft } from '../src/core/experiment.ts'
import {
  addAssumptionChange,
  advanceExperimentStage,
  captureConjecture,
  classifyTaskWork,
  closeConjectureInScope,
  conclusionScope,
  conjectureView,
  counterexampleCoverage,
  deferConjecture,
  evaluateRetry,
  experimentHead,
  explorationEntitlement,
  explorationPulse,
  frameConjecture,
  prematureNegationCheck,
  preregisterExperiment,
  probeReadyConjecture,
  pursueConjecture,
  recordConjectureProbe,
  recordTrial,
  registerExplorationPolicy,
  registerStrategyDecision,
  releaseExplorationReservation,
  restoreExplorationReservation,
  reviseExperiment,
  stagnationWindow,
  strategyDecisionCurrent,
  taskWorkKind,
  trialCanSupportComparison,
  unlimitedExcuseCheck,
  upsertRouteAssessment,
  wildcardProbeAllowanceCheck,
} from '../src/core/experiment.ts'

/* ------------------------------------------------------------------ 夹具 */

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

/* ------------------------------------------------------------------ §25.2、§31.4 工作分类与探索额度 */

test('classifyTaskWork：成功标注只写分类，终态与重复标注被拒', () => {
  const base = withTask(freshState())
  assert.equal(taskWorkKind(base, TASK_ID), undefined)
  const ok = classifyTaskWork(base, TASK_ID, 'explore', NOW + 1)
  assert.equal(ok.applied, true)
  if (!ok.applied) return
  assert.equal(taskWorkKind(ok.state, TASK_ID), 'explore')
  assert.equal(ok.state.tasks[TASK_ID]?.status, 'running')
  const again = classifyTaskWork(ok.state, TASK_ID, 'explore', NOW + 2)
  assert.equal(again.applied, false)
  assert.match(again.reason, /重复标注/)
  const terminal = classifyTaskWork(withTask(freshState(), { status: 'completed' }), TASK_ID, 'explore', NOW + 3)
  assert.equal(terminal.applied, false)
  assert.match(terminal.reason, /终态/)
  assert.equal(classifyTaskWork(base, 'tsk_missing', 'explore', NOW + 4).applied, false)
})

test('explorationEntitlement：未分类不占预留；登记后占用、释放后转入复核视图', () => {
  const base = withTask(freshState())
  assert.equal(explorationEntitlement(base, 'tsk_missing').ok, false)
  const unclassified = explorationEntitlement(base, TASK_ID)
  assert.equal(unclassified.ok, true)
  assert.equal(unclassified.drawsOnReservation, false)
  const validate = explorationEntitlement(withTask(freshState(), { workKind: 'validate' }), TASK_ID)
  assert.equal(validate.drawsOnReservation, false)
  assert.match(validate.reason, /不走探索预留/)
  const explore = explorationEntitlement(withTask(freshState(), { workKind: 'explore' }), TASK_ID)
  assert.equal(explore.drawsOnReservation, true)
  assert.equal(explore.reservationEnabled, false)
  const reg = registerExplorationPolicy(withTask(freshState(), { workKind: 'explore' }), registration(), NOW, A1)
  assert.equal(reg.applied, true)
  if (!reg.applied) return
  const entitled = explorationEntitlement(reg.state, TASK_ID)
  assert.equal(entitled.reservationEnabled, true)
  assert.equal(entitled.reservationReleased, false)
  assert.match(entitled.reason, /reserveShare=0.2/)
  const rel = releaseExplorationReservation(reg.state, { reason: '交付临近', recheck: '下个里程碑复核' }, NOW + 1, A1)
  assert.equal(rel.applied, true)
  if (!rel.applied) return
  const released = explorationEntitlement(rel.state, TASK_ID)
  assert.equal(released.reservationReleased, true)
  assert.match(released.reason, /交付临近/)
})

test('registerExplorationPolicy：份额越界、口径缺失、截止已过与 wildcard 无界都被拒', () => {
  const base = withTask(freshState())
  const cases: readonly (readonly [string, ExplorationRegistration])[] = [
    ['份额为 0', registration({ reserveShare: 0 })],
    ['份额超过 1', registration({ reserveShare: 1.2 })],
    ['缺最小可辨别试验', registration({ minDiscernibleTrial: '  ' })],
    ['成本缺备注', registration({ maxTrialCost: { calls: 2, note: ' ' } })],
    ['成本缺量纲', registration({ maxTrialCost: { note: '只有一句承诺' } })],
    ['缺复核触发器', registration({ reviewTriggers: [] })],
    ['截止不晚于当前', registration({ deadlineAt: NOW })],
    ['wildcard 缺量纲', registration({ wildcardProbeAllowance: { note: '有界机会' } })],
    ['wildcard 缺备注', registration({ wildcardProbeAllowance: { calls: 1, note: ' ' } })],
  ]
  for (const [label, reg] of cases) {
    assert.equal(registerExplorationPolicy(base, reg, NOW, A1).applied, false, label)
  }
  assert.equal(registerExplorationPolicy(base, registration(), NOW, A1).applied, true)
})

test('registerExplorationPolicy：重新登记不抹掉上一次释放记录', () => {
  const base = withTask(freshState())
  const first = registerExplorationPolicy(base, registration(), NOW, A1)
  if (!first.applied) throw new Error(first.reason)
  const released = releaseExplorationReservation(first.state, { reason: '没有合格候选', recheck: '候选清单更新时' }, NOW + 1, A1)
  if (!released.applied) throw new Error(released.reason)
  const second = registerExplorationPolicy(released.state, registration({ reserveShare: 0.3 }), NOW + 2, A1)
  assert.equal(second.applied, true)
  if (!second.applied) return
  assert.equal(second.state.mission.exploration?.reserveShare, 0.3)
  assert.equal(second.state.mission.exploration?.reserveReleasedAt, NOW + 1)
  assert.equal(second.state.mission.exploration?.releaseReason, '没有合格候选')
})

test('releaseExplorationReservation：无预留 / 空理由 / 空复核 / 重复释放被拒，成功记录理由与复核', () => {
  const base = withTask(freshState())
  assert.equal(releaseExplorationReservation(base, { reason: '资源短缺', recheck: '里程碑' }, NOW + 1, A1).applied, false)
  const reg = registerExplorationPolicy(base, registration(), NOW, A1)
  if (!reg.applied) throw new Error(reg.reason)
  assert.equal(releaseExplorationReservation(reg.state, { reason: ' ', recheck: '里程碑' }, NOW + 1, A1).applied, false)
  assert.equal(releaseExplorationReservation(reg.state, { reason: '资源短缺', recheck: '' }, NOW + 2, A1).applied, false)
  const ok = releaseExplorationReservation(reg.state, { reason: '资源短缺', recheck: '每 10 次试验复核' }, NOW + 3, A1)
  assert.equal(ok.applied, true)
  if (!ok.applied) return
  assert.equal(ok.state.mission.exploration?.reserveReleasedAt, NOW + 3)
  const again = releaseExplorationReservation(ok.state, { reason: '再释放一次', recheck: 'x' }, NOW + 4, A1)
  assert.equal(again.applied, false)
  assert.match(again.reason, /重复释放/)
})

test('wildcardProbeAllowanceCheck：无策略 / 无 allowance / 口径不可比 / 超额度被拒', () => {
  const base = withTask(freshState())
  assert.equal(wildcardProbeAllowanceCheck(base, { calls: 1 }).ok, false)
  const noAllowance = registerExplorationPolicy(base, registration(), NOW, A1)
  if (!noAllowance.applied) throw new Error(noAllowance.reason)
  assert.equal(wildcardProbeAllowanceCheck(noAllowance.state, { calls: 1 }).ok, false)
  const bounded = registerExplorationPolicy(base, registration({ wildcardProbeAllowance: { calls: 3, note: '至多 3 次调用' } }), NOW, A1)
  if (!bounded.applied) throw new Error(bounded.reason)
  assert.equal(wildcardProbeAllowanceCheck(bounded.state, { calls: 2 }).ok, true)
  assert.equal(wildcardProbeAllowanceCheck(bounded.state, { tokens: 10 }).ok, false)
  assert.equal(wildcardProbeAllowanceCheck(bounded.state, { calls: 4 }).ok, false)
  const released = releaseExplorationReservation(bounded.state, { reason: '交付临近', recheck: '里程碑' }, NOW + 1, A1)
  if (!released.applied) throw new Error(released.reason)
  assert.equal(wildcardProbeAllowanceCheck(released.state, { calls: 1 }).ok, false)
})

/* ------------------------------------------------------------------ §25.3 试验契约：预登记与成本口径 */

test('preregisterExperiment：必填字段缺失与同名差异被拒', () => {
  const base = withTask(freshState())
  const cases: readonly (readonly [string, ExperimentDraft])[] = [
    ['缺路线族', expDraft({ routeFamilyId: ' ' })],
    ['缺问题', expDraft({ problem: '' })],
    ['缺用户效用', expDraft({ userUtility: ' ' })],
    ['缺候选机制', expDraft({ candidateMechanism: ' ' })],
    ['缺实质差异', expDraft({ differenceFromCurrent: ' ' })],
    ['差异与候选同名', expDraft({ candidateMechanism: '换表征', differenceFromCurrent: '换表征' })],
    ['缺可检验假设', expDraft({ testedHypothesis: '' })],
    ['缺可观察假设', expDraft({ observable: ' ' })],
    ['缺决策影响', expDraft({ decisionImpact: '' })],
    ['缺停止条件', expDraft({ stopConditions: [] })],
    ['缺预算上限', expDraft({ budgetCapNote: '' })],
    ['缺最小有效试验', expDraft({ minViableTrial: '' })],
    ['缺风险边界', expDraft({ riskBoundary: ' ' })],
    ['缺处理说明', expDraft({ treatmentNote: '' })],
    ['缺判据', expDraft({ criteria: [] })],
    ['缺验证器', expDraft({ validatorRefs: [] })],
    ['缺基线', expDraft({ baselineRef: undefined })],
  ]
  for (const [label, draft] of cases) {
    assert.equal(preregisterExperiment(base, draft, NOW, A1).applied, false, label)
  }
})

test('preregisterExperiment：宿主、成本上限与 wildcard 额度口径的正反例', () => {
  const base = withTask(freshState())
  assert.equal(preregisterExperiment(base, expDraft({ taskId: 'tsk_missing' }), NOW, A1).applied, false)
  const deliver = withTask(freshState(), { workKind: 'deliver' })
  assert.equal(preregisterExperiment(deliver, expDraft({ taskId: TASK_ID }), NOW, A1).applied, false)
  const noPolicyWildcard = preregisterExperiment(base, expDraft({ wildcard: true, plannedCost: { calls: 1 } }), NOW, A1)
  assert.equal(noPolicyWildcard.applied, false)
  assert.match(noPolicyWildcard.reason, /wildcard/)
  const reg = registerExplorationPolicy(base, registration({ wildcardProbeAllowance: { calls: 3, note: '至多 3 次调用' } }), NOW, A1)
  if (!reg.applied) throw new Error(reg.reason)
  assert.equal(preregisterExperiment(reg.state, expDraft(), NOW + 1, A1).applied, false)
  assert.equal(preregisterExperiment(reg.state, expDraft({ plannedCost: { calls: 6 } }), NOW + 2, A1).applied, false)
  const withinCap = preregisterExperiment(reg.state, expDraft({ plannedCost: { calls: 5 } }), NOW + 3, A1)
  assert.equal(withinCap.applied, true)
  if (!withinCap.applied) return
  assert.equal(withinCap.version, 1)
  assert.equal(experimentHead(withinCap.state, withinCap.experimentId)?.stage, 'executable')
  assert.equal(preregisterExperiment(reg.state, expDraft({ wildcard: true, plannedCost: { calls: 4 } }), NOW + 4, A1).applied, false)
  const wildcardOk = preregisterExperiment(reg.state, expDraft({ wildcard: true, plannedCost: { calls: 2 } }), NOW + 5, A1)
  assert.equal(wildcardOk.applied, true)
  if (!wildcardOk.applied) return
  assert.equal(wildcardOk.wildcard, true)
  assert.equal(experimentHead(wildcardOk.state, wildcardOk.experimentId)?.wildcard, true)
  assert.equal(experimentHead(wildcardOk.state, 'exp_missing'), undefined)
})

/* ------------------------------------------------------------------ §26.1 四层结果分开登记 */

test('recordTrial：契约版本、引用与"未施加干预却有方向性观测"被拒，正例四层分开登记', () => {
  const a = preregistered(freshState())
  const state = a.state
  assert.equal(recordTrial(state, trialDraft('exp_missing'), NOW + 1, A1).applied, false)
  assert.equal(recordTrial(state, trialDraft(a.experimentId, { experimentVersion: 2 }), NOW + 2, A1).applied, false)
  const dg11 = recordTrial(state, trialDraft(a.experimentId, { treatmentApplied: 'no', observed: 'target_met' }), NOW + 3, A1)
  assert.equal(dg11.applied, false)
  assert.match(dg11.reason, /DG-11/)
  assert.equal(recordTrial(state, trialDraft(a.experimentId, { operationRefs: ['op_missing'] }), NOW + 4, A1).applied, false)
  assert.equal(recordTrial(state, trialDraft(a.experimentId, { evidenceRefs: ['ev_missing'] }), NOW + 5, A1).applied, false)
  assert.equal(recordTrial(state, trialDraft(a.experimentId, { claimRefs: ['clm_missing'] }), NOW + 6, A1).applied, false)
  assert.equal(recordTrial(state, trialDraft(a.experimentId, { taskId: 'tsk_missing' }), NOW + 7, A1).applied, false)
  const ok = recordOk(state, trialDraft(a.experimentId, { environment: 'env-A', inputVersions: ['d1'], budgetSpentNote: '12 次调用', confounders: ['数据漂移'] }), NOW + 8)
  const stored = ok.state.trials[ok.trialId]
  assert.equal(stored?.execution, 'completed')
  assert.equal(stored?.evaluationValidity, 'valid')
  assert.equal(stored?.observed, 'no_reliable_difference')
  assert.equal(stored?.environment, 'env-A')
  const quiet = recordTrial(ok.state, trialDraft(a.experimentId, { treatmentApplied: 'no', observed: 'not_measured' }), NOW + 9, A1)
  assert.equal(quiet.applied, true)
})

test('trialCanSupportComparison / conclusionScope：三层缺一不可，范围只约束当次条件', () => {
  const a = preregistered(freshState())
  let state = a.state
  const bad = recordOk(state, trialDraft(a.experimentId, { execution: 'dependency_missing', treatmentApplied: 'unknown', evaluationValidity: 'unknown', observed: 'not_measured' }), NOW + 1)
  state = bad.state
  const mid = recordOk(state, trialDraft(a.experimentId, { evaluationValidity: 'input_misaligned' }), NOW + 2)
  state = mid.state
  const off = recordOk(state, trialDraft(a.experimentId, { treatmentApplied: 'no', observed: 'not_measured' }), NOW + 3)
  state = off.state
  const good = recordOk(state, trialDraft(a.experimentId, { environment: 'env-A', codeVersions: ['commit-abc'], budgetSpentNote: '12 次调用', confounders: ['数据漂移'], unknowns: ['温度'] }), NOW + 4)
  state = good.state
  assert.equal(trialCanSupportComparison(state, 'tri_missing').ok, false)
  const execVerdict = trialCanSupportComparison(state, bad.trialId)
  assert.equal(execVerdict.ok, false)
  assert.match(execVerdict.reason, /执行层/)
  const evalVerdict = trialCanSupportComparison(state, mid.trialId)
  assert.equal(evalVerdict.ok, false)
  assert.match(evalVerdict.reason, /评价层/)
  const treatVerdict = trialCanSupportComparison(state, off.trialId)
  assert.equal(treatVerdict.ok, false)
  assert.match(treatVerdict.reason, /实际处理/)
  assert.equal(trialCanSupportComparison(state, good.trialId).ok, true)
  assert.equal(conclusionScope(state, 'tri_missing').ok, false)
  const scope = conclusionScope(state, good.trialId)
  assert.equal(scope.ok, true)
  assert.match(scope.statement, /env-A/)
  assert.match(scope.statement, /数据漂移/)
  assert.match(scope.limitation, /只约束当次条件/)
  const narrow = conclusionScope(state, mid.trialId)
  assert.equal(narrow.ok, false)
  assert.match(narrow.limitation, /不足以支撑比较/)
})

/* ------------------------------------------------------------------ §25.3 阶段推进 */

test('advanceExperimentStage：阶段性证据齐全时逐级走到 publish，之后无后续阶段', () => {
  const a = preregistered(freshState())
  let state = a.state
  const x = a.experimentId
  assert.equal(advanceExperimentStage(state, x, 'small_scale_validity', { note: '先跑通一次' }, NOW + 1, A1).applied, false)
  const t1 = recordOk(state, trialDraft(x, { evaluationValidity: 'unknown', observed: 'not_measured' }), NOW + 2)
  state = t1.state
  const s1 = advanceExperimentStage(state, x, 'small_scale_validity', { note: '执行完成且处理生效' }, NOW + 3, A1)
  assert.equal(s1.applied, true)
  if (!s1.applied) return
  state = s1.state
  assert.equal(advanceExperimentStage(state, x, 'comparable_baseline', { note: '基线可比' }, NOW + 4, A1).applied, false)
  const t2 = recordOk(state, trialDraft(x, { observed: 'target_met', environment: 'env-A' }), NOW + 5)
  state = t2.state
  const s2 = advanceExperimentStage(state, x, 'comparable_baseline', { note: '一次评价有效的试验', witnessTrialIds: [t2.trialId] }, NOW + 6, A1)
  assert.equal(s2.applied, true)
  if (!s2.applied) return
  state = s2.state
  assert.equal(advanceExperimentStage(state, x, 'publish', { note: '想跳级' }, NOW + 7, A1).applied, false)
  const s3 = advanceExperimentStage(state, x, 'robustness_integration', { note: '目标达成' }, NOW + 8, A1)
  assert.equal(s3.applied, true)
  if (!s3.applied) return
  state = s3.state
  const s4 = advanceExperimentStage(state, x, 'publish', { note: '判据满足' }, NOW + 9, A1)
  assert.equal(s4.applied, true)
  if (!s4.applied) return
  state = s4.state
  assert.equal(experimentHead(state, x)?.stage, 'publish')
  assert.equal(advanceExperimentStage(state, x, 'publish', { note: '再来一次' }, NOW + 10, A1).applied, false)
  assert.equal(reviseExperiment(state, x, { reason: '发布后想再改契约' }, NOW + 11, A1).applied, false)
})

test('advanceExperimentStage：跳级 / 空依据 / 见证试验不合规被拒', () => {
  const a = preregistered(freshState())
  const state = a.state
  assert.equal(advanceExperimentStage(state, 'exp_missing', 'small_scale_validity', { note: 'x' }, NOW + 1, A1).applied, false)
  assert.equal(advanceExperimentStage(state, a.experimentId, 'comparable_baseline', { note: '跳级' }, NOW + 2, A1).applied, false)
  assert.equal(advanceExperimentStage(state, a.experimentId, 'small_scale_validity', { note: '   ' }, NOW + 3, A1).applied, false)
  assert.equal(advanceExperimentStage(state, a.experimentId, 'small_scale_validity', { note: '见证', witnessTrialIds: ['tri_missing'] }, NOW + 4, A1).applied, false)
  assert.equal(advanceExperimentStage(state, a.experimentId, 'small_scale_validity', { note: '见证', witnessTrialIds: [] }, NOW + 5, A1).applied, false)
  const b = preregistered(state, expDraft({ routeFamilyId: 'route:alt' }))
  const tb = recordOk(b.state, trialDraft(b.experimentId), NOW + 6)
  assert.equal(advanceExperimentStage(tb.state, a.experimentId, 'small_scale_validity', { note: '见证', witnessTrialIds: [tb.trialId] }, NOW + 7, A1).applied, false)
})

/* ------------------------------------------------------------------ §25.3 修订留版本 */

test('reviseExperiment / experimentHead：留版本、禁止清空要件，结果后的修订标 postResults', () => {
  const a = preregistered(freshState())
  assert.equal(experimentHead(a.state, 'exp_missing'), undefined)
  assert.equal(reviseExperiment(a.state, 'exp_missing', { reason: 'x' }, NOW + 1, A1).applied, false)
  assert.equal(reviseExperiment(a.state, a.experimentId, { reason: ' ' }, NOW + 2, A1).applied, false)
  assert.equal(reviseExperiment(a.state, a.experimentId, { reason: '空判据', criteria: [] }, NOW + 3, A1).applied, false)
  assert.equal(reviseExperiment(a.state, a.experimentId, { reason: '空停止条件', stopConditions: [] }, NOW + 4, A1).applied, false)
  assert.equal(reviseExperiment(a.state, a.experimentId, { reason: '写成空值', problem: '  ' }, NOW + 5, A1).applied, false)
  const v2 = reviseExperiment(a.state, a.experimentId, { reason: '观察到偏差，调整最小有效试验', minViableTrial: '两次小样本对照' }, NOW + 6, A1)
  assert.equal(v2.applied, true)
  if (!v2.applied) return
  assert.equal(v2.version, 2)
  assert.equal(v2.postResults, false)
  assert.equal(experimentHead(v2.state, a.experimentId)?.version, 2)
  assert.equal(experimentHead(v2.state, a.experimentId)?.minViableTrial, '两次小样本对照')
  const trial = recordOk(v2.state, trialDraft(a.experimentId, { experimentVersion: 2 }), NOW + 7)
  const v3 = reviseExperiment(trial.state, a.experimentId, { reason: '结果登记后按事后视角复核' }, NOW + 8, A1)
  assert.equal(v3.applied, true)
  if (!v3.applied) return
  assert.equal(v3.postResults, true)
  assert.equal(experimentHead(v3.state, a.experimentId)?.version, 3)
})

/* ------------------------------------------------------------------ §25.2 预留恢复与复核视图 */

test('restoreExplorationReservation：无预留 / 未释放 / 空理由被拒，复核后回到占用', () => {
  const base = withTask(freshState(), { workKind: 'explore' })
  assert.equal(restoreExplorationReservation(base, { reason: '复核通过' }, NOW + 1, A1).applied, false)
  const reg = registerExplorationPolicy(base, registration(), NOW, A1)
  if (!reg.applied) throw new Error(reg.reason)
  assert.equal(restoreExplorationReservation(reg.state, { reason: '复核通过' }, NOW + 1, A1).applied, false)
  const rel = releaseExplorationReservation(reg.state, { reason: '没有合格候选', recheck: '里程碑重看' }, NOW + 2, A1)
  if (!rel.applied) throw new Error(rel.reason)
  assert.equal(restoreExplorationReservation(rel.state, { reason: '  ' }, NOW + 3, A1).applied, false)
  const back = restoreExplorationReservation(rel.state, { reason: '里程碑核对：仍有可执行候选' }, NOW + 4, A1)
  assert.equal(back.applied, true)
  if (!back.applied) return
  assert.equal(back.state.mission.exploration?.reserveReleasedAt, undefined)
  assert.equal(explorationEntitlement(back.state, TASK_ID).reservationReleased, false)
})

test('explorationPulse：未启用 / 释放 / 过期与 wildcard 试验清单', () => {
  const idle = explorationPulse(freshState(), NOW)
  assert.equal(idle.configured, false)
  assert.equal(idle.due, false)
  const reg = registerExplorationPolicy(withTask(freshState()), registration({ deadlineAt: NOW + 1_000, wildcardProbeAllowance: { calls: 3, note: '至多 3 次调用' } }), NOW, A1)
  if (!reg.applied) throw new Error(reg.reason)
  const before = explorationPulse(reg.state, NOW + 500)
  assert.equal(before.configured, true)
  assert.equal(before.deadlinePassed, false)
  assert.equal(before.due, false)
  const wild = preregistered(reg.state, expDraft({ wildcard: true, plannedCost: { calls: 2 } }), NOW + 600)
  const withWildcard = explorationPulse(wild.state, NOW + 700)
  assert.deepEqual(withWildcard.wildcardExperimentIds, [wild.experimentId])
  const afterDeadline = explorationPulse(wild.state, NOW + 1_000)
  assert.equal(afterDeadline.deadlinePassed, true)
  assert.equal(afterDeadline.due, true)
  assert.match(afterDeadline.reason, /已过截止时间/)
  const rel = releaseExplorationReservation(wild.state, { reason: '交付临近', recheck: '里程碑' }, NOW + 1_100, A1)
  if (!rel.applied) throw new Error(rel.reason)
  const released = explorationPulse(rel.state, NOW + 1_200)
  assert.equal(released.released, true)
  assert.equal(released.due, true)
  assert.equal(released.releaseReason, '交付临近')
})

/* ------------------------------------------------------------------ §26.2 过早否定与无限开脱 */

test('prematureNegationCheck：单次负结果只约束当次，路线级否定要重复检验且无混杂', () => {
  const a = preregistered(freshState())
  const n1 = recordOk(a.state, trialDraft(a.experimentId, { observed: 'lower_than_baseline', environment: 'env-A', inputVersions: ['d1'] }), NOW + 1)
  let state = n1.state
  assert.equal(prematureNegationCheck(state, { trialId: 'tri_missing', proposedScope: 'trial' }).blocked, true)
  assert.equal(prematureNegationCheck(state, { trialId: n1.trialId, proposedScope: 'trial' }).blocked, false)
  assert.equal(prematureNegationCheck(state, { trialId: n1.trialId, proposedScope: 'route' }).blocked, true)
  const n2 = recordOk(state, trialDraft(a.experimentId, { observed: 'no_reliable_difference', environment: 'env-A', inputVersions: ['d1'] }), NOW + 2)
  state = n2.state
  assert.equal(prematureNegationCheck(state, { trialId: n1.trialId, proposedScope: 'route' }).blocked, false)
  const broken = recordOk(state, trialDraft(a.experimentId, { evaluationValidity: 'unknown', observed: 'lower_than_baseline' }), NOW + 3)
  const blocked = prematureNegationCheck(broken.state, { trialId: broken.trialId, proposedScope: 'trial' })
  assert.equal(blocked.blocked, true)
  assert.match(blocked.reason, /评价层/)
  const positive = recordOk(state, trialDraft(a.experimentId, { observed: 'target_met' }), NOW + 4)
  const notNegative = prematureNegationCheck(positive.state, { trialId: positive.trialId, proposedScope: 'route' })
  assert.equal(notNegative.blocked, false)
  assert.match(notNegative.reason, /不是负结论/)
  const conf = recordOk(state, trialDraft(a.experimentId, { observed: 'lower_than_baseline', environment: 'env-A', inputVersions: ['d1'], confounders: ['数据版本漂移'] }), NOW + 5)
  const confBlocked = prematureNegationCheck(conf.state, { trialId: conf.trialId, proposedScope: 'route' })
  assert.equal(confBlocked.blocked, true)
  assert.match(confBlocked.reason, /混杂/)
})

test('unlimitedExcuseCheck：unknown 只记录；归因无证据被拒，有证据无修复只记录', () => {
  const a = preregistered(freshState())
  let state = a.state
  assert.equal(unlimitedExcuseCheck(state, { experimentId: 'exp_missing', attribution: 'environment_issue' }).blocked, true)
  const unknown = unlimitedExcuseCheck(state, { experimentId: a.experimentId, attribution: 'unknown' })
  assert.equal(unknown.blocked, false)
  assert.equal(unknown.recordOnly, true)
  assert.equal(unlimitedExcuseCheck(state, { experimentId: a.experimentId, attribution: 'environment_issue' }).blocked, true)
  assert.equal(unlimitedExcuseCheck(state, { experimentId: a.experimentId, attribution: 'environment_issue', evidenceRefs: ['ev_missing'] }).blocked, true)
  state = withEvidence(state, 'ev_dep')
  const noFix = unlimitedExcuseCheck(state, { experimentId: a.experimentId, attribution: 'environment_issue', evidenceRefs: ['ev_dep'] })
  assert.equal(noFix.blocked, false)
  assert.equal(noFix.recordOnly, true)
  const fixed = unlimitedExcuseCheck(state, { experimentId: a.experimentId, attribution: 'environment_issue', evidenceRefs: ['ev_dep'], fixes: ['升级依赖版本'] })
  assert.equal(fixed.blocked, false)
  assert.equal(fixed.recordOnly, false)
})

test('unlimitedExcuseCheck：同类执行失败达 maxTaskRetries 即封顶', () => {
  const a = preregistered(freshState())
  let state = a.state
  for (let i = 0; i < 3; i += 1) {
    const r = recordOk(state, trialDraft(a.experimentId, { execution: 'dependency_missing', treatmentApplied: 'unknown', evaluationValidity: 'unknown', observed: 'not_measured' }), NOW + i + 1)
    state = r.state
  }
  state = withEvidence(state, 'ev_dep')
  const verdict = unlimitedExcuseCheck(state, { experimentId: a.experimentId, attribution: 'implementation_issue', evidenceRefs: ['ev_dep'], fixes: ['固定依赖锁'] })
  assert.equal(verdict.blocked, true)
  assert.match(verdict.reason, /maxTaskRetries/)
})

/* ------------------------------------------------------------------ §26.2、§26.4 路线状态与反例覆盖 */

test('upsertRouteAssessment：预算暂停不能降级；关闭 / 降级要证据与重入条件', () => {
  const base = freshState()
  assert.equal(upsertRouteAssessment(base, { routeFamilyId: ' ', scope: 's', state: 'eligible', basis: 'priority', reason: 'r' }, NOW, A1).applied, false)
  assert.equal(upsertRouteAssessment(base, { routeFamilyId: 'route:rep', scope: ' ', state: 'eligible', basis: 'priority', reason: 'r' }, NOW, A1).applied, false)
  assert.equal(upsertRouteAssessment(base, { routeFamilyId: 'route:rep', scope: 's', state: 'eligible', basis: 'priority', reason: ' ' }, NOW, A1).applied, false)
  const paused = upsertRouteAssessment(base, { routeFamilyId: 'route:rep', scope: '试验范围', state: 'disfavored_in_scope', basis: 'budget_pause', reason: '预算耗尽' }, NOW + 1, A1)
  assert.equal(paused.applied, false)
  assert.match(paused.reason, /不等于方法被证伪/)
  assert.equal(upsertRouteAssessment(base, { routeFamilyId: 'route:rep', scope: 's', state: 'closed_in_scope', basis: 'evidence', reason: 'r', reentryConditions: ['补充证据'] }, NOW + 2, A1).applied, false)
  assert.equal(upsertRouteAssessment(base, { routeFamilyId: 'route:rep', scope: 's', state: 'closed_in_scope', basis: 'evidence', reason: 'r', evidenceRefs: ['ev_1'] }, NOW + 3, A1).applied, false)
  assert.equal(upsertRouteAssessment(base, { routeFamilyId: 'route:rep', scope: 's', state: 'disfavored_in_scope', basis: 'evidence', reason: 'r' }, NOW + 4, A1).applied, false)
  assert.equal(upsertRouteAssessment(base, { routeFamilyId: 'route:rep', scope: 's', state: 'eligible', basis: 'evidence', reason: 'r' }, NOW + 5, A1).applied, false)
  assert.equal(upsertRouteAssessment(base, { routeFamilyId: 'route:rep', scope: 's', state: 'needs_diagnosis', basis: 'evidence', reason: 'r', evidenceRefs: ['ev_missing'] }, NOW + 6, A1).applied, false)
})

test('upsertRouteAssessment：当前视图更新，相关结论的反证未进入决定即拒绝', () => {
  const base = withEvidence(freshState(), 'ev_1')
  const first = upsertRouteAssessment(base, { routeFamilyId: 'route:rep', scope: '隔离试验范围', state: 'eligible', basis: 'priority', reason: '新路线先小规模探测' }, NOW, A1)
  assert.equal(first.applied, true)
  if (!first.applied) return
  assert.equal(first.previous, undefined)
  assert.equal(first.coverage.ok, true)
  const second = upsertRouteAssessment(first.state, { routeFamilyId: 'route:rep', scope: '隔离试验范围', state: 'needs_diagnosis', basis: 'priority', reason: '出现异常观测，先诊断' }, NOW + 1, A1)
  assert.equal(second.applied, true)
  if (!second.applied) return
  assert.equal(second.previous, 'eligible')
  assert.equal(second.state.routes['route:rep']?.state, 'needs_diagnosis')
  const undecided = withClaim(base, claimRevision({ claimId: 'clm_1', contradictingEvidenceIds: ['ev_c'] }))
  const refused = upsertRouteAssessment(undecided, { routeFamilyId: 'route:rep', scope: 's', state: 'disfavored_in_scope', basis: 'evidence', reason: 'r', evidenceRefs: ['ev_1'], relatedClaimIds: ['clm_1'] }, NOW + 2, A1)
  assert.equal(refused.applied, false)
  assert.match(refused.reason, /反例/)
  const covered = upsertRouteAssessment(undecided, { routeFamilyId: 'route:rep', scope: 's', state: 'disfavored_in_scope', basis: 'evidence', reason: 'r', evidenceRefs: ['ev_1'], relatedClaimIds: ['clm_1'], consultedRefs: ['ev_c'] }, NOW + 3, A1)
  assert.equal(covered.applied, true)
  if (!covered.applied) return
  assert.equal(covered.coverage.ok, true)
})

test('counterexampleCoverage：支持证据、反证与失效记录都要进入决定', () => {
  const base = withEvidence(freshState(), 'ev_s', 'ev_c')
  assert.equal(counterexampleCoverage(base, { claimIds: ['clm_missing'], consultedRefs: [] }).ok, false)
  const stale = withClaim(base, claimRevision({ claimId: 'clm_stale', validity: 'needs_review', supportingEvidenceIds: ['ev_s'], contradictingEvidenceIds: ['ev_c'] }))
  const missing = counterexampleCoverage(stale, { claimIds: ['clm_stale'], consultedRefs: ['ev_s'] })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /同时进入决定/)
  assert.equal(counterexampleCoverage(stale, { claimIds: ['clm_stale'], consultedRefs: ['ev_s', 'ev_c', 'clm_stale'] }).ok, true)
  const refuted = withClaim(base, claimRevision({ claimId: 'clm_refuted', status: 'refuted' }))
  assert.equal(counterexampleCoverage(refuted, { claimIds: ['clm_refuted'], consultedRefs: [] }).ok, false)
  assert.equal(counterexampleCoverage(refuted, { claimIds: ['clm_refuted'], consultedRefs: ['clm_refuted'] }).ok, true)
})

/* ------------------------------------------------------------------ §26.3 有理由的重试 */

test('evaluateRetry：只改种子 / 重复未声明 / 触发不成立都被推迟', () => {
  const a = preregistered(freshState())
  const state = a.state
  assert.equal(evaluateRetry(state, { experimentId: 'exp_missing', purpose: 'recovery', trigger: 'implementation_fixed', changes: ['修复'] }).ok, false)
  const trivial = evaluateRetry(state, { experimentId: a.experimentId, purpose: 'recovery', trigger: 'implementation_fixed', changes: ['只改了随机种子'] })
  assert.equal(trivial.ok, false)
  assert.equal(trivial.materiality, 'trivial_only')
  assert.equal(evaluateRetry(state, { experimentId: a.experimentId, purpose: 'recovery', trigger: 'implementation_fixed', changes: [] }).materiality, 'none')
  const noRefs = evaluateRetry(state, { experimentId: a.experimentId, purpose: 'new_evidence', trigger: 'new_evidence', changes: ['补一组对照输入'] })
  assert.equal(noRefs.ok, false)
  assert.match(noRefs.reason, /新证据/)
  assert.equal(evaluateRetry(state, { experimentId: a.experimentId, purpose: 'new_evidence', trigger: 'new_evidence', changes: ['补一组对照输入'], newEvidenceRefs: ['ev_missing'] }).ok, false)
  assert.equal(evaluateRetry(state, { experimentId: a.experimentId, purpose: 'recovery', trigger: 'implementation_fixed', changes: ['修复依赖'], lastTrialId: 'tri_missing' }).ok, false)
  const notDeclared = evaluateRetry(state, { experimentId: a.experimentId, purpose: 'repeat_measurement', trigger: 'constraint_change', changes: ['按设计重复测量'], repeatDesignPredeclared: false })
  assert.equal(notDeclared.ok, false)
  assert.match(notDeclared.reason, /预登记设计/)
  const t = recordOk(state, trialDraft(a.experimentId), NOW + 1)
  const priorValid = evaluateRetry(t.state, { experimentId: a.experimentId, purpose: 'recovery', trigger: 'prior_evaluation_invalid', changes: ['按新验证器重评'], lastTrialId: t.trialId })
  assert.equal(priorValid.ok, false)
  assert.match(priorValid.reason, /有效/)
})

test('evaluateRetry：实质差异与新证据放行；同条件反证足够时封顶', () => {
  const a = preregistered(freshState())
  const t1 = recordOk(a.state, trialDraft(a.experimentId, { observed: 'lower_than_baseline', environment: 'env-A', inputVersions: ['d1'] }), NOW + 1)
  let state = t1.state
  const material = evaluateRetry(state, { experimentId: a.experimentId, purpose: 'recovery', trigger: 'implementation_fixed', changes: ['修复依赖版本并补对照'], lastTrialId: t1.trialId })
  assert.equal(material.ok, true)
  assert.equal(material.materiality, 'material')
  const withEv = evaluateRetry(withEvidence(state, 'ev_new'), { experimentId: a.experimentId, purpose: 'new_evidence', trigger: 'new_evidence', changes: ['补做对照输入'], newEvidenceRefs: ['ev_new'], lastTrialId: t1.trialId })
  assert.equal(withEv.ok, true)
  const t2 = recordOk(state, trialDraft(a.experimentId, { observed: 'lower_than_baseline', environment: 'env-A', inputVersions: ['d1'] }), NOW + 2)
  state = t2.state
  const t3 = recordOk(state, trialDraft(a.experimentId, { observed: 'lower_than_baseline', environment: 'env-A', inputVersions: ['d1'] }), NOW + 3)
  state = t3.state
  const capped = evaluateRetry(state, { experimentId: a.experimentId, purpose: 'repeat_measurement', trigger: 'constraint_change', changes: [], repeatDesignPredeclared: true, lastTrialId: t3.trialId })
  assert.equal(capped.ok, false)
  assert.equal(capped.sameConditionTrials, 3)
  assert.match(capped.reason, /无限消耗预算/)
})

/* ------------------------------------------------------------------ §25.4 停滞复核窗口 */

test('stagnationWindow：区间与预设无效返回空报告；不足预设不判停滞', () => {
  const a = preregistered(freshState())
  const t1 = recordOk(a.state, trialDraft(a.experimentId, { observed: 'lower_than_baseline' }), NOW + 1)
  const t2 = recordOk(t1.state, trialDraft(a.experimentId, { observed: 'no_reliable_difference' }), NOW + 2)
  const state = t2.state
  assert.equal(stagnationWindow(state, { routeFamilyId: 'route:rep', from: NOW + 5, to: NOW + 1, preset: { minComparableTrials: 2, maxLowGainShare: 0.5 } }).ok, false)
  assert.equal(stagnationWindow(state, { routeFamilyId: 'route:rep', from: NOW, to: NOW + 10, preset: { minComparableTrials: 0, maxLowGainShare: 0.5 } }).ok, false)
  assert.equal(stagnationWindow(state, { routeFamilyId: 'route:rep', from: NOW, to: NOW + 10, preset: { minComparableTrials: 2, maxLowGainShare: 0 } }).ok, false)
  const below = stagnationWindow(state, { routeFamilyId: 'route:rep', from: NOW, to: NOW + 10, preset: { minComparableTrials: 3, maxLowGainShare: 0.5 } })
  assert.equal(below.ok, true)
  assert.equal(below.stagnant, false)
  assert.equal(below.lowGainTrials, 2)
  const outOfWindow = stagnationWindow(state, { routeFamilyId: 'route:rep', from: NOW + 100, to: NOW + 200, preset: { minComparableTrials: 1, maxLowGainShare: 0.5 } })
  assert.equal(outOfWindow.ok, true)
  assert.equal(outOfWindow.stagnant, false)
  assert.match(outOfWindow.reason, /没有可比较试验/)
})

test('stagnationWindow：低收益占比达到预设即判停滞，排除项保留所在层原因', () => {
  const a = preregistered(freshState())
  const t1 = recordOk(a.state, trialDraft(a.experimentId, { observed: 'lower_than_baseline' }), NOW + 1)
  const t2 = recordOk(t1.state, trialDraft(a.experimentId, { observed: 'no_reliable_difference' }), NOW + 2)
  const t3 = recordOk(t2.state, trialDraft(a.experimentId, { evaluationValidity: 'unknown', observed: 'target_met' }), NOW + 3)
  const report = stagnationWindow(t3.state, { routeFamilyId: 'route:rep', from: NOW, to: NOW + 10, preset: { minComparableTrials: 2, maxLowGainShare: 0.5 } })
  assert.equal(report.ok, true)
  assert.equal(report.stagnant, true)
  assert.equal(report.window.comparableTrials, 2)
  assert.equal(report.lowGainTrials, 2)
  assert.equal(report.trialIds.length, 2)
  assert.equal(report.excluded.length, 1)
  assert.match(report.excluded[0]?.reason ?? '', /评价层/)
  assert.match(report.reason, /StrategyReview/)
})

/* ------------------------------------------------------------------ §25.4 策略决定 */

test('registerStrategyDecision：空依据 / 自报停滞窗口 / 只表达偏好的未选理由被拒', () => {
  const a = preregistered(freshState())
  const t1 = recordOk(a.state, trialDraft(a.experimentId, { observed: 'lower_than_baseline' }), NOW + 1)
  const t2 = recordOk(t1.state, trialDraft(a.experimentId, { observed: 'no_reliable_difference' }), NOW + 2)
  const state = t2.state
  const window = { comparableTrials: 2, resourceNote: '两次小样本对照与回执', from: NOW, to: NOW + 10 }
  const chosenCandidate = { routeFamilyId: 'route:rep', option: '继续当前路线', expectedInfoValue: '补对照', costNote: '两次调用', chosen: true }
  const baseDraft = {
    kind: 'strategy_review' as const,
    trigger: 'stagnation_window' as const,
    window,
    currentEvidence: ['两次负结果'],
    candidates: [chosenCandidate],
    costNote: '两次调用',
    reviewTrigger: '下个里程碑',
    stagnationCheck: { routeFamilyId: 'route:rep', preset: { minComparableTrials: 2, maxLowGainShare: 0.5 } },
  }
  assert.equal(registerStrategyDecision(state, { ...baseDraft, currentEvidence: [] }, NOW + 3, A1).applied, false)
  assert.equal(registerStrategyDecision(state, { ...baseDraft, costNote: ' ' }, NOW + 4, A1).applied, false)
  assert.equal(registerStrategyDecision(state, { ...baseDraft, reviewTrigger: '' }, NOW + 5, A1).applied, false)
  assert.equal(registerStrategyDecision(state, { ...baseDraft, window: { ...window, from: NOW + 5, to: NOW + 1 } }, NOW + 6, A1).applied, false)
  assert.equal(registerStrategyDecision(state, { ...baseDraft, window: { ...window, resourceNote: '' } }, NOW + 7, A1).applied, false)
  assert.equal(registerStrategyDecision(state, { ...baseDraft, stagnationCheck: undefined }, NOW + 8, A1).applied, false)
  const mismatch = registerStrategyDecision(state, { ...baseDraft, window: { ...window, comparableTrials: 50 } }, NOW + 9, A1)
  assert.equal(mismatch.applied, false)
  assert.match(mismatch.reason, /不按消息条数/)
  const notStagnant = registerStrategyDecision(state, { ...baseDraft, stagnationCheck: { routeFamilyId: 'route:rep', preset: { minComparableTrials: 5, maxLowGainShare: 0.5 } } }, NOW + 10, A1)
  assert.equal(notStagnant.applied, false)
  assert.match(notStagnant.reason, /未构成停滞/)
  assert.equal(registerStrategyDecision(state, { ...baseDraft, candidates: [{ ...chosenCandidate, chosen: false, rejectedReason: '覆盖率不足的推断' }] }, NOW + 11, A1).applied, false)
  const dismissive = registerStrategyDecision(state, { ...baseDraft, candidates: [{ ...chosenCandidate, chosen: false, rejectedReason: '可能掉分' }] }, NOW + 12, A1)
  assert.equal(dismissive.applied, false)
  assert.match(dismissive.reason, /只表达偏好/)
})

test('registerStrategyDecision：停滞窗口重算一致时放行；水位与结论版本可复核', () => {
  const a = preregistered(freshState())
  const t1 = recordOk(a.state, trialDraft(a.experimentId, { observed: 'lower_than_baseline' }), NOW + 1)
  const t2 = recordOk(t1.state, trialDraft(a.experimentId, { observed: 'no_reliable_difference' }), NOW + 2)
  const state = t2.state
  const chosen = { routeFamilyId: 'route:rep', option: '继续当前路线并补对照', expectedInfoValue: '能区分噪声与机制', costNote: '两次调用', chosen: true }
  const rejected = { routeFamilyId: 'route:alt', option: '换表征', expectedInfoValue: '潜在更稳', costNote: '一次小样本', chosen: false, rejectedReason: '当前证据未覆盖该路线，先做对照' }
  const result = registerStrategyDecision(state, {
    kind: 'strategy_review',
    trigger: 'stagnation_window',
    window: { comparableTrials: 2, resourceNote: '两次小样本对照', from: NOW, to: NOW + 10 },
    currentEvidence: ['两次负结果'],
    candidates: [chosen, rejected],
    costNote: '两次调用',
    reviewTrigger: '下个里程碑或出现新证据',
    stagnationCheck: { routeFamilyId: 'route:rep', preset: { minComparableTrials: 2, maxLowGainShare: 0.5 } },
  }, NOW + 3, A1)
  assert.equal(result.applied, true)
  if (!result.applied) return
  assert.equal(result.stagnant, true)
  const stored = result.state.strategyDecisions[result.decisionId]
  assert.ok(stored !== undefined)
  assert.equal(stored.asOfMissionRevision, state.revision)
  assert.equal(strategyDecisionCurrent(result.state, stored).ok, true)
  const milestone = registerStrategyDecision(result.state, {
    kind: 'route_choice',
    trigger: 'milestone',
    window: { comparableTrials: 0, resourceNote: '里程碑时点无新试验', from: NOW, to: NOW + 20 },
    currentEvidence: [`trial:${t1.trialId}`],
    candidates: [chosen],
    costNote: '一次调用',
    reviewTrigger: '下次复核',
  }, NOW + 4, A1)
  assert.equal(milestone.applied, true)
})

test('strategyDecisionCurrent：结论缺失 / 修订 / 撤回 / 失效都使决定过期，非结论引用被忽略', () => {
  const base = freshState()
  const makeDecision = (evidence: readonly string[]): StrategyDecision => ({
    decisionId: 'str_1',
    missionId: 'mss_test',
    kind: 'route_choice',
    trigger: 'milestone',
    window: { comparableTrials: 1, resourceNote: '一次对照', from: NOW, to: NOW + 1 },
    currentEvidence: evidence,
    candidates: [{ routeFamilyId: 'route:rep', option: '继续', expectedInfoValue: 'v', costNote: 'c', chosen: true }],
    costNote: '一次调用',
    reviewTrigger: '下次里程碑',
    asOfMissionRevision: 1,
    ownerActorId: A1,
    createdAt: NOW,
  })
  assert.equal(strategyDecisionCurrent(base, makeDecision(['clm_1@1'])).ok, false)
  const v1 = withClaim(base, claimRevision({ claimId: 'clm_1' }))
  assert.equal(strategyDecisionCurrent(v1, makeDecision(['clm_1@1'])).ok, true)
  const v1plus = withClaim(v1, claimRevision({ claimId: 'clm_1', version: 2, supersedesVersion: 1 }))
  const stale = strategyDecisionCurrent(v1plus, makeDecision(['clm_1@1']))
  assert.equal(stale.ok, false)
  assert.match(stale.reason, /过期/)
  const retracted = withClaim(base, claimRevision({ claimId: 'clm_1', retractedAt: NOW + 1, retractionReason: '反证出现' }))
  assert.equal(strategyDecisionCurrent(retracted, makeDecision(['clm_1@1'])).ok, false)
  const ineffective = withClaim(base, claimRevision({ claimId: 'clm_1', validity: 'needs_review' }))
  assert.equal(strategyDecisionCurrent(ineffective, makeDecision(['clm_1@1'])).ok, false)
  assert.equal(strategyDecisionCurrent(base, makeDecision(['trial:tri_1', 'evidence:ev_1'])).ok, true)
})

/* ------------------------------------------------------------------ §31.3 猜想生命周期 */

test('猜想生命周期：capture → frame → probe_ready → probed → pursued，阶段与证据状态分开', () => {
  const a = preregistered(freshState())
  const cap = captureConjecture(a.state, {
    proposition: '瓶颈来自表征方式',
    assumptionChange: '直接替换表征层，跳过调参',
    sourceNote: '反常观测：调参收益递减',
    expectedSignals: ['判别器分数上升'],
    competingExplanations: ['样本量增加也能解释'],
    nextCheapestAction: '跑一次小样本对照',
  }, NOW, A1)
  assert.equal(cap.applied, true)
  if (!cap.applied) return
  const claimId = cap.claimId
  const view1 = conjectureView(cap.state, claimId)
  assert.equal(view1.ok, true)
  assert.equal(view1.stage, 'captured')
  assert.equal(view1.status, 'proposed')
  assert.deepEqual(view1.allowedTransitions, ['framed', 'deferred', 'closed_in_scope'])
  const framed = frameConjecture(cap.state, claimId, { expectedSignals: ['梯度范数变化'] }, NOW + 1, A1)
  assert.equal(framed.applied, true)
  if (!framed.applied) return
  assert.equal(framed.stage, 'framed')
  const ready = probeReadyConjecture(framed.state, claimId, { nextCheapestAction: '跑 10 步小样本对照' }, NOW + 2, A1)
  assert.equal(ready.applied, true)
  if (!ready.applied) return
  assert.equal(ready.stage, 'probe_ready')
  const trial = recordOk(ready.state, trialDraft(a.experimentId, { claimRefs: [claimId], observed: 'partial_improvement', environment: 'env-A' }), NOW + 3)
  const probed = recordConjectureProbe(trial.state, claimId, { trialId: trial.trialId }, NOW + 4, A1)
  assert.equal(probed.applied, true)
  if (!probed.applied) return
  assert.equal(probed.stage, 'probed')
  const viewProbed = conjectureView(probed.state, claimId)
  assert.equal(viewProbed.status, 'proposed')
  assert.deepEqual(viewProbed.probedTrialIds, [trial.trialId])
  const pursued = pursueConjecture(probed.state, claimId, { reason: '探测支持继续小规模投入' }, NOW + 5, A1)
  assert.equal(pursued.applied, true)
  if (!pursued.applied) return
  assert.equal(pursued.stage, 'pursued')
  const viewFinal = conjectureView(pursued.state, claimId)
  assert.deepEqual(viewFinal.allowedTransitions, ['closed_in_scope'])
  assert.equal(viewFinal.competingExplanations.length, 1)
})

test('captureConjecture / frameConjecture：必填项、非猜想与空转 framing 被拒', () => {
  const base = freshState()
  const baseDraft = { proposition: '猜想命题', assumptionChange: '相对当前路线的改变', sourceNote: '来源：主动构想' }
  assert.equal(captureConjecture(base, { ...baseDraft, proposition: ' ' }, NOW, A1).applied, false)
  assert.equal(captureConjecture(base, { ...baseDraft, assumptionChange: '' }, NOW, A1).applied, false)
  assert.equal(captureConjecture(base, { ...baseDraft, sourceNote: '  ' }, NOW, A1).applied, false)
  const plain = withClaim(base, claimRevision({ claimId: 'clm_plain' }))
  assert.equal(frameConjecture(plain, 'clm_plain', { expectedSignals: ['信号'] }, NOW + 1, A1).applied, false)
  assert.equal(conjectureView(plain, 'clm_plain').ok, false)
  assert.equal(conjectureView(base, 'clm_missing').ok, false)
  assert.equal(frameConjecture(base, 'clm_missing', { expectedSignals: ['信号'] }, NOW + 2, A1).applied, false)
  const cap = captureConjecture(base, baseDraft, NOW + 3, A1)
  assert.equal(cap.applied, true)
  if (!cap.applied) return
  const noOutput = frameConjecture(cap.state, cap.claimId, {}, NOW + 4, A1)
  assert.equal(noOutput.applied, false)
  assert.match(noOutput.reason, /不可检验的原因/)
  const framed = frameConjecture(cap.state, cap.claimId, { notTestableReason: '当前概念无法设计区分试验' }, NOW + 5, A1)
  assert.equal(framed.applied, true)
  if (!framed.applied) return
  const again = frameConjecture(framed.state, cap.claimId, {}, NOW + 6, A1)
  assert.equal(again.applied, false)
  assert.match(again.reason, /反复空想/)
})

test('probeReadyConjecture / recordConjectureProbe：阶段、观测与绑定核验', () => {
  const a = preregistered(freshState())
  const cap = captureConjecture(a.state, { proposition: '猜想甲', assumptionChange: '改变甲', sourceNote: '来源甲' }, NOW, A1)
  assert.equal(cap.applied, true)
  if (!cap.applied) return
  const claimId = cap.claimId
  assert.equal(probeReadyConjecture(cap.state, claimId, { nextCheapestAction: 'x' }, NOW + 1, A1).applied, false)
  assert.equal(probeReadyConjecture(cap.state, 'clm_missing', { nextCheapestAction: 'x' }, NOW + 2, A1).applied, false)
  const framed = frameConjecture(cap.state, claimId, { expectedSignals: ['分数上升'] }, NOW + 3, A1)
  if (!framed.applied) throw new Error(framed.reason)
  assert.equal(probeReadyConjecture(framed.state, claimId, { nextCheapestAction: '  ' }, NOW + 4, A1).applied, false)
  const ready = probeReadyConjecture(framed.state, claimId, { nextCheapestAction: '跑小样本对照' }, NOW + 5, A1)
  assert.equal(ready.applied, true)
  if (!ready.applied) return
  const unbound = recordOk(ready.state, trialDraft(a.experimentId, { observed: 'partial_improvement' }), NOW + 6)
  const probeUnbound = recordConjectureProbe(unbound.state, claimId, { trialId: unbound.trialId }, NOW + 7, A1)
  assert.equal(probeUnbound.applied, false)
  assert.match(probeUnbound.reason, /claimRefs/)
  const off = recordOk(ready.state, trialDraft(a.experimentId, { claimRefs: [claimId], treatmentApplied: 'no', observed: 'not_measured' }), NOW + 8)
  assert.equal(recordConjectureProbe(off.state, claimId, { trialId: off.trialId }, NOW + 9, A1).applied, false)
  const silent = recordOk(ready.state, trialDraft(a.experimentId, { claimRefs: [claimId], observed: 'not_measured' }), NOW + 10)
  const silentProbe = recordConjectureProbe(silent.state, claimId, { trialId: silent.trialId }, NOW + 11, A1)
  assert.equal(silentProbe.applied, false)
  assert.match(silentProbe.reason, /没有观测结果/)
  assert.equal(recordConjectureProbe(ready.state, claimId, { trialId: 'tri_missing' }, NOW + 12, A1).applied, false)
})

test('pursueConjecture / deferConjecture：pursued 要理由与竞争解释；延后要说明且可重看', () => {
  const a = preregistered(freshState())
  const plain = captureConjecture(a.state, { proposition: '猜想乙', assumptionChange: '改变乙', sourceNote: '来源乙', expectedSignals: ['信号乙'] }, NOW, A1)
  if (!plain.applied) throw new Error(plain.reason)
  const framed = frameConjecture(plain.state, plain.claimId, { expectedSignals: ['信号乙-2'] }, NOW + 1, A1)
  if (!framed.applied) throw new Error(framed.reason)
  const ready = probeReadyConjecture(framed.state, plain.claimId, { nextCheapestAction: '对照乙' }, NOW + 2, A1)
  if (!ready.applied) throw new Error(ready.reason)
  assert.equal(pursueConjecture(ready.state, plain.claimId, { reason: '先探测' }, NOW + 3, A1).applied, false)
  const trial = recordOk(ready.state, trialDraft(a.experimentId, { claimRefs: [plain.claimId], observed: 'partial_improvement' }), NOW + 4)
  const probed = recordConjectureProbe(trial.state, plain.claimId, { trialId: trial.trialId }, NOW + 5, A1)
  if (!probed.applied) throw new Error(probed.reason)
  assert.equal(pursueConjecture(probed.state, plain.claimId, { reason: ' ' }, NOW + 6, A1).applied, false)
  const noCompeting = pursueConjecture(probed.state, plain.claimId, { reason: '继续投入' }, NOW + 7, A1)
  assert.equal(noCompeting.applied, false)
  assert.match(noCompeting.reason, /竞争解释/)
  assert.equal(deferConjecture(probed.state, plain.claimId, { deferralReason: 'insufficient_resources', note: ' ' }, NOW + 8, A1).applied, false)
  const deferred = deferConjecture(probed.state, plain.claimId, { deferralReason: 'insufficient_resources', note: '本周期预算优先交付', reentryCondition: '下个预算周期重看' }, NOW + 9, A1)
  assert.equal(deferred.applied, true)
  if (!deferred.applied) return
  assert.equal(deferred.stage, 'deferred')
  const view = conjectureView(deferred.state, plain.claimId)
  assert.ok(view.allowedTransitions.includes('probe_ready'))
  const back = probeReadyConjecture(deferred.state, plain.claimId, { nextCheapestAction: '预算到位后先跑最小对照' }, NOW + 10, A1)
  assert.equal(back.applied, true)
})

test('closeConjectureInScope：无探测可归档；有探测历史要证据与重入条件；终态不可再动', () => {
  const a = preregistered(freshState())
  const quiet = captureConjecture(a.state, { proposition: '无后续的灵感', assumptionChange: '记录即可', sourceNote: '灵感来源' }, NOW, A1)
  if (!quiet.applied) throw new Error(quiet.reason)
  const closed = closeConjectureInScope(quiet.state, quiet.claimId, { reason: '无后续动作，归档' }, NOW + 1, A1)
  assert.equal(closed.applied, true)
  if (!closed.applied) return
  const reclose = closeConjectureInScope(closed.state, quiet.claimId, { reason: '再关一次' }, NOW + 2, A1)
  assert.equal(reclose.applied, false)
  assert.match(reclose.reason, /终态/)
  const deferAfterClose = deferConjecture(closed.state, quiet.claimId, { deferralReason: 'irrelevant_to_goal', note: 'x' }, NOW + 3, A1)
  assert.equal(deferAfterClose.applied, false)
  assert.match(deferAfterClose.reason, /出口/)
  const hot = captureConjecture(a.state, { proposition: '已探测的猜想', assumptionChange: '改变丙', sourceNote: '来源丙', expectedSignals: ['信号丙'] }, NOW + 4, A1)
  if (!hot.applied) throw new Error(hot.reason)
  const framed = frameConjecture(hot.state, hot.claimId, { expectedSignals: ['信号丙-2'] }, NOW + 5, A1)
  if (!framed.applied) throw new Error(framed.reason)
  const ready = probeReadyConjecture(framed.state, hot.claimId, { nextCheapestAction: '对照丙' }, NOW + 6, A1)
  if (!ready.applied) throw new Error(ready.reason)
  const trial = recordOk(ready.state, trialDraft(a.experimentId, { claimRefs: [hot.claimId], observed: 'no_reliable_difference' }), NOW + 7)
  const probed = recordConjectureProbe(trial.state, hot.claimId, { trialId: trial.trialId }, NOW + 8, A1)
  if (!probed.applied) throw new Error(probed.reason)
  assert.equal(closeConjectureInScope(probed.state, hot.claimId, { reason: '无后续动作' }, NOW + 9, A1).applied, false)
  assert.equal(closeConjectureInScope(probed.state, hot.claimId, { reason: '按范围关闭', evidenceRefs: ['ev_missing'] }, NOW + 10, A1).applied, false)
  const strong = closeConjectureInScope(probed.state, hot.claimId, { reason: '当次范围无收益', evidenceRefs: [trial.trialId], reentryConditions: ['数据规模扩大后重看'] }, NOW + 11, A1)
  assert.equal(strong.applied, true)
  if (!strong.applied) return
  const view = conjectureView(strong.state, hot.claimId)
  assert.equal(view.stage, 'closed_in_scope')
  assert.deepEqual(view.allowedTransitions, [])
})

test('addAssumptionChange：观测前可记；观测后必须标 postHoc', () => {
  const a = preregistered(freshState())
  const cap = captureConjecture(a.state, { proposition: '猜想丁', assumptionChange: '改变丁', sourceNote: '来源丁', expectedSignals: ['信号丁'] }, NOW, A1)
  if (!cap.applied) throw new Error(cap.reason)
  const early = addAssumptionChange(cap.state, cap.claimId, { text: '输入范围可能过窄' }, NOW + 1, A1)
  assert.equal(early.applied, true)
  if (!early.applied) return
  assert.equal(early.postHoc, false)
  assert.equal(addAssumptionChange(cap.state, cap.claimId, { text: ' ' }, NOW + 2, A1).applied, false)
  assert.equal(addAssumptionChange(cap.state, 'clm_missing', { text: 'x' }, NOW + 3, A1).applied, false)
  const framed = frameConjecture(early.state, cap.claimId, { expectedSignals: ['信号丁-2'] }, NOW + 4, A1)
  if (!framed.applied) throw new Error(framed.reason)
  const ready = probeReadyConjecture(framed.state, cap.claimId, { nextCheapestAction: '对照丁' }, NOW + 5, A1)
  if (!ready.applied) throw new Error(ready.reason)
  const trial = recordOk(ready.state, trialDraft(a.experimentId, { claimRefs: [cap.claimId], observed: 'partial_improvement' }), NOW + 6)
  const probed = recordConjectureProbe(trial.state, cap.claimId, { trialId: trial.trialId }, NOW + 7, A1)
  if (!probed.applied) throw new Error(probed.reason)
  const late = addAssumptionChange(probed.state, cap.claimId, { text: '可能还有第三种解释' }, NOW + 8, A1)
  assert.equal(late.applied, false)
  assert.match(late.reason, /postHoc/)
  const postHoc = addAssumptionChange(probed.state, cap.claimId, { text: '事后解释：温度波动', postHoc: true }, NOW + 9, A1)
  assert.equal(postHoc.applied, true)
  if (!postHoc.applied) return
  assert.equal(postHoc.postHoc, true)
  assert.equal(conjectureView(postHoc.state, cap.claimId).assumptionChanges.length, 3)
})
