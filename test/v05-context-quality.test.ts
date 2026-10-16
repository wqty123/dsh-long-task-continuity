/**
 * v0.5 context-quality 模块用例（设计稿 §27.1–§27.5；验收情形参考 §36.2）。
 *
 * 每个判定都成对：先钉合法路径，再钉同形的退化/非法路径必须被拒、被标 unknown 或被延后。
 * 夹具走既有命令面（`discipline-fixtures.apply`）搭真实状态；适配层用例只打桩宿主投影面，
 * 不建会话、不联网、不落盘。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { MissionControl } from '../src/core/control.ts'
import type { ContextAssessment } from '../src/core/entities.ts'
import type {
  ActionDecision,
  ActionRunContext,
  ActionState,
  ActionTransition,
  AssessmentDraft,
  AssessmentFrame,
  AssessmentFreeze,
  AssessmentOutcome,
  BehaviorRegressionSignals,
  CapacitySignals,
  CheckTier,
  ConsistencySignals,
  ContextEvaluation,
  ContinuitySignals,
  CoverageItem,
  CoverageSignals,
  FreshnessRef,
  FreshnessSignals,
  InvalidationOutcome,
  ProblemSet,
  QualityContextSignals,
  QualitySignals,
  RelevanceRedundancySignals,
} from '../src/core/context-quality.ts'
import {
  ACTION_MATRIX,
  ACTION_ROLLOUT,
  ACTION_STATES,
  ACTION_TRANSITIONS,
  COMPONENT_ORDER,
  COMPONENT_TIERS,
  INITIAL_ACTION_STATE,
  NATIVE_FALLBACK_MARK,
  PLAN_STATE,
  SEMANTIC_TRIGGERS,
  applyActionOutcome,
  applyRunPlan,
  assessContext,
  assessmentIsCurrent,
  compactionPreflight,
  evaluateBehaviorRegression,
  evaluateCapacity,
  evaluateConsistency,
  evaluateContext,
  evaluateContinuity,
  evaluateCoverage,
  evaluateFreshness,
  evaluateRelevanceRedundancy,
  frameDrifts,
  freezeFrame,
  invalidateAssessment,
  isNativeFallback,
  legalActionStep,
  planActionRun,
  planChecks,
  readCapacity,
  recordAssessment,
  recordDrifts,
  reuseAssessment,
  selectAction,
  toAssessmentComponents,
  transitionAction,
  validateAssessment,
  verifyPostCompaction,
} from '../src/core/context-quality.ts'
import type { HostSlice, ProjectionRegistryLike } from '../src/adapter/host-types.ts'
import type { CompactionPort, ContextHeadersStateLike, ContextTimelineStateLike, ProjectionValueSourceLike } from '../src/adapter/dsh-context.ts'
import {
  DEFAULT_BULKY_OUTPUT_THRESHOLD,
  DSH_CONTEXT_PROJECTIONS,
  collectContextQuality,
  invokeCompaction,
  observationFingerprint,
  outcomeAfterVerification,
  probeDshContext,
  readNativeBudget,
  readProjection,
  retainedRefs,
  timelineDetails,
} from '../src/adapter/dsh-context.ts'
import { NOW, apply, crew, ctx, intentCommand, must, recordEvidence, req, withClaimedTask } from './discipline-fixtures.ts'

// —— 夹具（只搭状态与信号，不放判定） ——

interface SignalOverrides {
  readonly capacity?: CapacitySignals
  readonly coverage?: CoverageSignals
  readonly freshness?: FreshnessSignals
  readonly consistency?: ConsistencySignals
  readonly relevanceRedundancy?: RelevanceRedundancySignals
  readonly continuity?: ContinuitySignals
  readonly behaviorRegression?: BehaviorRegressionSignals
  readonly context?: QualityContextSignals
}

/** 缺省信号：容量 10%（健康档）、清单/引用为空（未知）、无结构化矛盾——分量判定按各自缺口展开。 */
function baseSignals(overrides: SignalOverrides = {}): QualitySignals {
  return {
    capacity: overrides.capacity ?? { requestEstimateTokens: 1000, contextWindowTokens: 10000 },
    coverage: overrides.coverage ?? { required: [] },
    freshness: overrides.freshness ?? { refs: [] },
    consistency: overrides.consistency ?? {},
    relevanceRedundancy: overrides.relevanceRedundancy ?? {},
    continuity: overrides.continuity ?? {},
    behaviorRegression: overrides.behaviorRegression ?? {},
    ...(overrides.context === undefined ? {} : { context: overrides.context }),
  }
}

function problemSet(overrides: Partial<ProblemSet> = {}): ProblemSet {
  return {
    missingKeyConditions: [],
    missingCounterSides: [],
    staleReferences: [],
    structuralConflicts: [],
    prunableBulk: [],
    unverifiableFacts: [],
    behaviorRegressionSignals: [],
    capacityRatio: 0.1,
    nearHardLimit: false,
    bloatedWithSafeSummaryRange: false,
    bloatedWithoutSafeRange: false,
    taskSwitchedWithIneffectiveRepair: false,
    progressContinues: false,
    uniqueComplexDetail: false,
    unknownComponents: [],
    ...overrides,
  }
}

function freezeFor(state: MissionControl, fingerprint: string): AssessmentFreeze {
  return freezeFrame(state, { requestFingerprint: fingerprint, sessionId: 'sess-1', sessionRevision: 1, criteriaRevision: 1, retentionList: [] })
}

interface DraftBundle {
  readonly draft: AssessmentDraft
  readonly evaluation: ContextEvaluation
  readonly decision: ActionDecision
}

function draftFor(state: MissionControl, signals: QualitySignals, tier: CheckTier, fingerprint = 'fp-1'): DraftBundle {
  const evaluation = evaluateContext(signals, tier)
  const decision = selectAction(evaluation.problems, { tier })
  const draft: AssessmentDraft = { actorId: 'lead-1', freeze: freezeFor(state, fingerprint), evaluation, decision, tier }
  return { draft, evaluation, decision }
}

function expectAssessmentOk(outcome: AssessmentOutcome, label: string): Extract<AssessmentOutcome, { readonly ok: true }> {
  if (!outcome.ok) throw new Error(`${label}：评估应被接受，却被拒（${outcome.reason}）`)
  return outcome
}

function expectAssessmentRejected(outcome: AssessmentOutcome, label: string): string {
  if (outcome.ok) throw new Error(`${label}：坏评估应被拒，却记下了 ${outcome.assessment.assessmentId}`)
  return outcome.reason
}

function expectTransitionOk(moved: ActionTransition, label: string): Extract<ActionTransition, { readonly ok: true }> {
  if (!moved.ok) throw new Error(`${label}：迁移应合法，却被拒（${moved.reason}）`)
  return moved
}

function expectTransitionRejected(moved: ActionTransition, label: string): string {
  if (moved.ok) throw new Error(`${label}：非法迁移应被拒，状态却到了 ${moved.assessment.actionState ?? INITIAL_ACTION_STATE}`)
  return moved.reason
}

function expectInvalidationOk(outcome: InvalidationOutcome, label: string): Extract<InvalidationOutcome, { readonly ok: true }> {
  if (!outcome.ok) throw new Error(`${label}：失效应被受理，却被拒（${outcome.reason}）`)
  return outcome
}

function expectInvalidationRejected(outcome: InvalidationOutcome, label: string): string {
  if (outcome.ok) throw new Error(`${label}：应被拒，却改了 ${outcome.assessment.assessmentId}`)
  return outcome.reason
}

function recordOk(state: MissionControl, bundle: DraftBundle, now = NOW + 1): { state: MissionControl; assessment: ContextAssessment } {
  const outcome = recordAssessment(state, bundle.draft, now)
  if (!outcome.ok) throw new Error(`夹具：评估应被接受，却被拒（${outcome.reason}）`)
  return { state: outcome.state, assessment: outcome.assessment }
}

function stepOk(state: MissionControl, assessmentId: string, to: ActionState, note = '测试迁移', now = NOW + 2): { state: MissionControl; assessment: ContextAssessment } {
  const moved = expectTransitionOk(transitionAction(state, assessmentId, to, note, now), `迁移到 ${to}`)
  return { state: moved.state, assessment: moved.assessment }
}

type HostStub = Pick<HostSlice, 'sessionProjections' | 'tokenMeter'>

/**
 * 桩注册表：两个读取面都给。
 *
 * `snapshot()` 是 0.70.0 的**投影响应值**公开面（`packages/session/session-projection/src/index.ts:338`），
 * 值面即 `lib/index.d.ts` 的 `Snapshot`/`HeadersState`/`ActivityState`；`stateOf()` 给的是 fold state
 * （另一面，适配层只作回退并如实标注）。适配层优先读值面（`src/adapter/dsh-context.ts:390-410`），
 * 所以本文件的投影夹具一律走值面，轻量头/截断/近似重建这些只在值面上成立的判据才可能被读到。
 */
function registryWith(states: Readonly<Record<string, unknown>>): ProjectionRegistryLike & ProjectionValueSourceLike {
  return {
    snapshot: (_session: unknown, _keys?: readonly string[]) => ({ values: states }),
    stateOf: (_session: unknown, name: string) => states[name],
  }
}

/** 只给值面的桩：`stateOf` 缺席，用来单独钉"投影响应值"这一条读取路径。 */
function snapshotOnly(values: Readonly<Record<string, unknown>>): ProjectionValueSourceLike {
  return { snapshot: (_session: unknown, _keys?: readonly string[]) => ({ values }) }
}

/** 宿主投影桩：按投影名回值，可选给 tokenMeter 一个总量读数。 */
function hostWith(states: Readonly<Record<string, unknown>>, measured?: number): HostStub {
  const registry = registryWith(states)
  return measured === undefined ? { sessionProjections: registry } : { sessionProjections: registry, tokenMeter: { measure: () => ({ totalTokens: measured }) } }
}

/**
 * dsh-context 0.70.0 三个投影都可用、且详情已随值内联的一套读数（§27.1 的真实字段面）。
 *
 * 逐项照 `D:\dsh-home\profiles\web\node_modules\dsh-context\lib\index.d.ts`：
 * - `contextTimeline` 是 `Snapshot`（`:244-312`）：`ok` + `current{...}` + 拆分代次的头部字段
 *   `counts`/`last`/`detailRev`（`:280-284`）**并且** `requests`/`events`/`nodes`/`archive` 非空、
 *   `droppedNodes: 0`、`surfaceFloor`/`archiveFloor`/`fileOpsFloor` 三个裁剪下限都不在场。
 *   这才是"缓存行把全集带回来"的内联值：`detailRev` 在场但集合也在场 ⇒ 不是 slim head
 *   （slim head 的那四个集合是空占位，`:285-297`）。
 * - `contextHeaders` 是 `HeadersState`（`:37-39`）：**只有** `headers: StoredHeaderRecord[]`
 *   （`:30-36` 的 `seq`/`time`/`systemTokens`/`tools[]{name,tokens,plugin}`）。设计稿阶段猜的
 *   `contextWindow`/`reservedForCompaction`/`requestCount` 在 0.70.0 的面上不存在（`:295-301` 的注释
 *   已由源码否证），压缩预留只能从 `request/header` 的 `config.maxTokens` 或 `maxOutputTokens` 侧取。
 * - `contextActivity` 是 `ActivityState`（`:7-18`）：按本地日键的用量台账 `days`，其中
 *   `ActivityDay.skills`（`:195-199`）是观测面上唯一能推出的重复线索；`repeatedActions`/
 *   `repeatedQuestions`/`revokedReuse`/`inFlight`/`pendingHandoffs` 都不存在——在途项与待交接项
 *   只认任务侧记录（§27.3 限制栏），本包的连续性分量因此如实给出"在途只按任务侧核对"的降级说明。
 */
function fullProjectionStates(): Record<string, unknown> {
  return {
    contextTimeline: {
      ok: true,
      model: 'deepseek-chat',
      provider: 'deepseek',
      contextWindow: 1000,
      maxOutputTokens: 100,
      current: { system: 120, tools: 60, user: 40, inject: 60, skill: 20, assistant: 50, tool: 5000, total: 5350 },
      counts: { turns: 3, steps: 5, injects: 5, compactions: 1, prunes: 1, skills: 2 },
      last: { seq: 42, total: 5350, prompt: 5300 },
      detailRev: 7,
      requests: [
        { turn: 1, step: 1, time: NOW, seq: 40, system: 120, tools: 60, user: 30, inject: 30, assistant: 20, tool: 0, total: 260, prompt: 240, cacheRead: 180, output: 20 },
        { turn: 2, step: 1, time: NOW + 1000, seq: 42, system: 120, tools: 60, user: 40, inject: 60, assistant: 50, tool: 5000, total: 5330, prompt: 5300, cacheRead: 4000, output: 30 },
      ],
      events: [
        { seq: 41, time: NOW + 500, kind: 'compaction', form: 'auto', tokens: 9000, count: 6, turn: 2, step: 1 },
        { seq: 43, time: NOW + 1500, kind: 'inject', sub: 'skill', name: 'pdf-official', tokens: 300, turn: 2, step: 1 },
      ],
      nodes: [
        // 一条 5000 token 的工具输出：0.70.0 的 `SurfaceNode`（`:439-457`）不给持久副本与调用配对，
        // 所以它是"长输出候选"但按不可剪处理（§27.4 不能直接推导栏）。
        { seq: 30, time: NOW, cat: 'tool', tokens: 5000, tool: 'Bash', err: false },
        // 两对重复的注入/技能节点：注入与技能节点按上游口径始终随值服务（`:295-297` 的 pinned 说明），
        // 重复计数在这一份清单里是数得全的 ⇒ §27.3 第 5 行的冗余候选走引用路径。
        { seq: 31, time: NOW, cat: 'inject', tokens: 300, name: 'available-skills' },
        { seq: 32, time: NOW + 500, cat: 'inject', tokens: 300, name: 'available-skills' },
        { seq: 33, time: NOW + 900, cat: 'skill', tokens: 300, skill: 'pdf-official' },
        { seq: 34, time: NOW + 1200, cat: 'skill', tokens: 300, skill: 'pdf-official' },
      ],
      droppedNodes: 0,
      archive: [{ seq: 20, time: NOW - 1000, cat: 'tool', tokens: 800, gone: 41, tool: 'Read' }],
      systems: [{ seq: 5, time: NOW - 2000, tokens: 120 }],
    },
    contextHeaders: {
      headers: [
        { seq: 4, time: NOW - 2000, systemTokens: 110, tools: [{ name: 'Read', tokens: 30, plugin: 'core' }, { name: 'Bash', tokens: 25, plugin: 'core' }] },
        { seq: 39, time: NOW, systemTokens: 120, tools: [{ name: 'Read', tokens: 30, plugin: 'core' }, { name: 'WebSearch', tokens: 28, plugin: 'mcp:web' }] },
      ],
    },
    contextActivity: {
      days: {
        '2026-10-14': { tokens: 40_000, requests: 6, skills: { 'pdf-official': { n: 1, last: NOW - 86_400_000 } } },
        '2026-10-15': { tokens: 90_000, requests: 9, skills: { 'pdf-official': { n: 2, last: NOW } } },
      },
      model: 'deepseek-chat',
      provider: 'deepseek',
    },
    contextPressure: { contextWindow: 1000, pressureTokens: 100, surfaceTokens: 20, sampledSurfaceTokens: 10 },
  }
}

// —— §27.3 分层检查 ——

test('planChecks：准入只跑确定性层，里程碑/纠正后/停滞复核/拟压缩才允许语义层（§27.3）', () => {
  const admission = planChecks('admission')
  assert.deepEqual(admission.tiers, ['deterministic'])
  assert.equal(admission.deferredReason, undefined)
  assert.equal(admission.nativeFallbackPriority, false)
  assert.deepEqual(SEMANTIC_TRIGGERS, ['milestone', 'after_correction', 'stall_review', 'before_compaction'])
  const milestone = planChecks('milestone')
  assert.deepEqual(milestone.tiers, ['deterministic', 'semantic'])
  const stall = planChecks('stall_review')
  assert.deepEqual(stall.tiers, ['deterministic', 'semantic'])
})

test('planChecks：语义检查受冷却、窗口次数与成本上限约束，确定性层不受影响（§27.3）', () => {
  const cooldown = planChecks('milestone', { budget: { now: NOW + 1000, lastSemanticAt: NOW, semanticRunsInWindow: 0 } })
  assert.deepEqual(cooldown.tiers, ['deterministic'])
  assert.match(cooldown.deferredReason ?? '', /冷却中/)
  const exhausted = planChecks('before_compaction', { budget: { now: NOW + 10_000_000, lastSemanticAt: NOW, semanticRunsInWindow: 3 } })
  assert.deepEqual(exhausted.tiers, ['deterministic'])
  assert.match(exhausted.deferredReason ?? '', /已达上限 3 次/)
  const tooCostly = planChecks('after_correction', { budget: { now: NOW + 10_000_000, semanticRunsInWindow: 0, estimatedCostTokens: 5000, costCapTokens: 4000 } })
  assert.deepEqual(tooCostly.tiers, ['deterministic'])
  assert.match(tooCostly.deferredReason ?? '', /超过窗口上限/)
  const withinBudget = planChecks('after_correction', { budget: { now: NOW + 10_000_000, semanticRunsInWindow: 1, estimatedCostTokens: 4000, costCapTokens: 4000 } })
  assert.deepEqual(withinBudget.tiers, ['deterministic', 'semantic'])
})

test('planChecks：接近硬容量时原生兜底优先，冷却不阻止（§27.4 末段）', () => {
  const plan = planChecks('admission', { budget: { now: NOW, lastSemanticAt: NOW }, nearHardLimit: true })
  assert.equal(plan.nativeFallbackPriority, true)
  const semantic = planChecks('milestone', { budget: { now: NOW, lastSemanticAt: NOW, semanticRunsInWindow: 9 }, nearHardLimit: true })
  assert.deepEqual(semantic.tiers, ['deterministic'])
  assert.equal(semantic.nativeFallbackPriority, true)
  assert.equal(planChecks('admission', { nearHardLimit: false }).nativeFallbackPriority, false)
})

test('COMPONENT_TIERS/COMPONENT_ORDER：七个分量的顺序与分层口径固定（§27.3 表格顺序）', () => {
  assert.deepEqual(
    [...COMPONENT_ORDER],
    ['capacity', 'coverage', 'freshness', 'consistency', 'relevance_redundancy', 'continuity', 'behavior_regression'],
  )
  assert.equal(COMPONENT_TIERS.capacity, 'deterministic')
  assert.equal(COMPONENT_TIERS.continuity, 'deterministic')
  assert.equal(COMPONENT_TIERS.consistency, 'semantic')
  assert.equal(COMPONENT_TIERS.relevance_redundancy, 'semantic')
})

// —— §27.3 分量判定：容量 ——

test('evaluateCapacity 正例：字段齐时给出折算读数，不产出问题（§27.3 第 1 行）', () => {
  const reading = readCapacity({ requestEstimateTokens: 1000, outputReserveTokens: 100, toolDefinitionTokens: 50, addedInputTokens: 25, contextWindowTokens: 10000 })
  assert.equal(reading.projectedTokens, 1175)
  assert.equal(reading.contextWindow, 10000)
  assert.equal(reading.ratio, 0.1175)
  const evaluation = evaluateCapacity({ requestEstimateTokens: 1000, contextWindowTokens: 10000, estimateSource: 'native_meter' })
  assert.equal(evaluation.finding.verdict, 'ok')
  assert.deepEqual(evaluation.problems, [])
  assert.match(evaluation.finding.limitNote ?? '', /不等于提供商实际精确计量/)
})

test('evaluateCapacity 反例：接近硬容量才产出 capacity_pressure；提醒档只记录不推导动作（§27.4 末段）', () => {
  const hard = evaluateCapacity({ requestEstimateTokens: 9500, contextWindowTokens: 10000 })
  assert.equal(hard.finding.verdict, 'attention')
  assert.equal(hard.problems.length, 1)
  assert.equal(must('问题', hard.problems[0]).kind, 'capacity_pressure')
  const warn = evaluateCapacity({ requestEstimateTokens: 8000, contextWindowTokens: 10000 })
  assert.equal(warn.finding.verdict, 'attention')
  assert.deepEqual(warn.problems, [])
  // 同一提醒档的比例单独不足以决定动作：没有别的问题就 keep（§27.3 首句）。
  const decision = selectAction(evaluateContext(baseSignals({ capacity: { requestEstimateTokens: 8000, contextWindowTokens: 10000 } }), 'deterministic').problems, { tier: 'deterministic' })
  assert.equal(decision.action, 'keep')
})

test('evaluateCapacity 反例：缺分母或缺估计一律 unknown，不按 0 或"健康"回退（§27.3 限制栏）', () => {
  const noWindow = evaluateCapacity({ requestEstimateTokens: 1000 })
  assert.equal(noWindow.finding.verdict, 'unknown')
  assert.match(noWindow.finding.limitNote ?? '', /不能回退成 0 或健康/)
  assert.equal(readCapacity({ requestEstimateTokens: 1000, contextWindowTokens: 0 }).ratio, null)
  assert.equal(readCapacity({ contextWindowTokens: 10000 }).ratio, null)
  assert.equal(must('问题数', noWindow.problems.length), 0)
})

test('evaluateCapacity 反例：观测面缺席标 unknown 并说明缺什么（§27.1、§27.2）', () => {
  const evaluation = evaluateCapacity({ unavailable: '容量投影未装载' })
  assert.equal(evaluation.finding.verdict, 'unknown')
  assert.match(evaluation.finding.signal, /未知：容量投影未装载/)
  assert.match(evaluation.finding.limitNote ?? '', /未知既不等于质量良好，也不禁用原生容量保护/)
  assert.deepEqual(evaluation.problems, [])
})

// —— §27.3 分量判定：覆盖 ——

function coverageItem(overrides: Partial<CoverageItem> = {}): CoverageItem {
  return { ref: 'ev-1', kind: 'evidence', receiptRef: 'rcpt-1', completeness: 'full', acknowledged: true, ...overrides }
}

test('evaluateCoverage 正例：必需清单都有完整送达回执（§27.3 第 2 行）', () => {
  const evaluation = evaluateCoverage({ required: [coverageItem(), coverageItem({ ref: 'rul-1', kind: 'rule' })] })
  assert.equal(evaluation.finding.verdict, 'ok')
  assert.deepEqual(evaluation.problems, [])
  assert.match(evaluation.finding.limitNote ?? '', /不宣称模型已理解/)
})

test('evaluateCoverage 反例：缺回执或完整度不足都算缺关键条件（§27.3 限制栏）', () => {
  const noReceipt = evaluateCoverage({ required: [coverageItem({ receiptRef: undefined })] })
  assert.equal(noReceipt.finding.verdict, 'attention')
  assert.equal(must('问题', noReceipt.problems[0]).kind, 'missing_key_condition')
  assert.match(must('问题', noReceipt.problems[0]).detail, /没有送达回执/)
  const partial = evaluateCoverage({ required: [coverageItem({ completeness: 'partial' })] })
  assert.equal(partial.problems.length, 1)
  assert.match(must('问题', partial.problems[0]).detail, /partial/)
  const unknownCompleteness = evaluateCoverage({ required: [coverageItem({ completeness: 'unknown' })] })
  assert.match(must('问题', unknownCompleteness.problems[0]).detail, /完整度未知/)
})

test('evaluateCoverage 反例：没有清单可比对时标 unknown，不承诺发现全部缺项（§27.3 限制栏）', () => {
  const evaluation = evaluateCoverage({ required: [] })
  assert.equal(evaluation.finding.verdict, 'unknown')
  assert.match(evaluation.finding.signal, /没有必需的覆盖清单/)
  assert.deepEqual(evaluation.problems, [])
  const unacknowledged = evaluateCoverage({ required: [coverageItem({ acknowledged: false })] })
  assert.equal(unacknowledged.finding.verdict, 'ok')
  assert.match(unacknowledged.finding.signal, /未确认送达/)
})

// —— §27.3 分量判定：新鲜度 ——

function freshRef(overrides: Partial<FreshnessRef> = {}): FreshnessRef {
  return { ref: 'clm-1', kind: 'conclusion', referencedVersion: 3, currentVersion: 3, ...overrides }
}

test('evaluateFreshness 正例：引用版本与权威当前版本一致（§27.3 第 3 行）', () => {
  const evaluation = evaluateFreshness({ refs: [freshRef(), freshRef({ ref: 'rul-1', kind: 'rule', referencedVersion: 'v2', currentVersion: 'v2' })] })
  assert.equal(evaluation.finding.verdict, 'ok')
  assert.deepEqual(evaluation.problems, [])
})

test('evaluateFreshness 反例：版本不一致、已撤销、已被取代都是过期引用（§27.3 第 3 行）', () => {
  const stale = evaluateFreshness({ refs: [freshRef({ currentVersion: 4 })] })
  assert.equal(stale.finding.verdict, 'attention')
  assert.equal(must('问题', stale.problems[0]).kind, 'stale_reference')
  assert.match(must('问题', stale.problems[0]).detail, /引用版本 3 ≠ 当前 4/)
  const withdrawn = evaluateFreshness({ refs: [freshRef({ withdrawn: true })] })
  assert.match(must('问题', withdrawn.problems[0]).detail, /已撤销但仍被引用/)
  const superseded = evaluateFreshness({ refs: [freshRef({ supersededBy: 'clm-1@v4' })] })
  assert.match(must('问题', superseded.problems[0]).detail, /已被 clm-1@v4 取代/)
})

test('evaluateFreshness 反例：一项都无法比对时标 unknown，不承诺发现全部旧前提（§27.3 限制栏）', () => {
  const none = evaluateFreshness({ refs: [] })
  assert.equal(none.finding.verdict, 'unknown')
  const uncomparable = evaluateFreshness({ refs: [freshRef({ currentVersion: undefined })] })
  assert.equal(uncomparable.finding.verdict, 'unknown')
  assert.match(uncomparable.finding.signal, /没有一项能与权威当前版本比对/)
  const mixed = evaluateFreshness({ refs: [freshRef(), freshRef({ ref: 'ev-9', currentVersion: undefined })] })
  assert.equal(mixed.finding.verdict, 'ok')
  assert.match(mixed.finding.signal, /1 项没有当前版本可比对/)
})

// —— §27.3 分量判定：一致性 ——

test('evaluateConsistency 正例：语义层给出结论且无结构化矛盾（§27.3 第 4 行）', () => {
  const evaluation = evaluateConsistency({ structural: [], claimSides: [{ claimRef: 'clm-1', hasSupport: true, hasCounter: true }], semanticFindings: [] }, 'semantic')
  assert.equal(evaluation.finding.verdict, 'ok')
  assert.deepEqual(evaluation.problems, [])
})

test('evaluateConsistency 反例：确定性层只做结构化筛查，没有语义结论时标 unknown（§27.3）', () => {
  const evaluation = evaluateConsistency({}, 'deterministic')
  assert.equal(evaluation.finding.verdict, 'unknown')
  assert.match(evaluation.finding.signal, /本轮为确定性层/)
  const semanticWithoutResult = evaluateConsistency({ structural: [] }, 'semantic')
  assert.equal(semanticWithoutResult.finding.verdict, 'unknown')
  assert.match(semanticWithoutResult.finding.limitNote ?? '', /不能声称"一致"/)
})

test('evaluateConsistency 反例：缺反证一侧即使在确定性层也必须拦下（§26.4、§27.3 第 4 行）', () => {
  const evaluation = evaluateConsistency({ claimSides: [{ claimRef: 'clm-1', hasSupport: true, hasCounter: false }] }, 'deterministic')
  assert.equal(evaluation.finding.verdict, 'attention')
  assert.equal(must('问题', evaluation.problems[0]).kind, 'missing_counter_side')
  const conflict = evaluateConsistency({ structural: [{ kind: 'rule_vs_task', detail: '规则与任务范围互相排斥' }] }, 'deterministic')
  assert.equal(must('问题', conflict.problems[0]).kind, 'structural_conflict')
  // 自然语言疑点只记录，不作动作依据（§27.3 限制栏）。
  const semanticOnly = evaluateConsistency({ semanticFindings: ['摘要与结论语气冲突'] }, 'semantic')
  assert.deepEqual(semanticOnly.problems, [])
  assert.match(semanticOnly.finding.signal, /语义疑点/)
})

// —— §27.3 分量判定：相关性与冗余 ——

test('evaluateRelevanceRedundancy 反例：确定性层一律 unknown，不据此剪除（§27.3）', () => {
  const evaluation = evaluateRelevanceRedundancy({ bulkyOutputs: [{ ref: 'n1', approxTokens: 9000, persistedCopy: true, toolCallPaired: true }] }, 'deterministic')
  assert.equal(evaluation.finding.verdict, 'unknown')
  assert.deepEqual(evaluation.problems, [])
})

test('evaluateRelevanceRedundancy 正例：已持久保留且调用配对完好才产出可剪候选（§27.4 第 3 行）', () => {
  const evaluation = evaluateRelevanceRedundancy(
    { bulkyOutputs: [{ ref: 'n1', approxTokens: 9000, persistedCopy: true, toolCallPaired: true }], repeats: [{ ref: '同一摘要', kind: 'summary', count: 3 }] },
    'semantic',
  )
  assert.equal(evaluation.finding.verdict, 'attention')
  assert.equal(evaluation.problems.length, 2)
  assert.ok(evaluation.problems.every((item) => item.kind === 'prunable_bulk'))
  assert.match(must('问题', evaluation.problems[0]).detail, /原件不删/)
})

test('evaluateRelevanceRedundancy 反例：未持久化/配对不完整不得剪，独立证据不按相似度删除（§27.3 限制栏）', () => {
  const notPersisted = evaluateRelevanceRedundancy({ bulkyOutputs: [{ ref: 'n1', approxTokens: 9000, persistedCopy: false, toolCallPaired: true }] }, 'semantic')
  assert.equal(notPersisted.finding.verdict, 'ok')
  assert.deepEqual(notPersisted.problems, [])
  assert.match(notPersisted.finding.limitNote ?? '', /不得删除唯一证据或破坏工具调用配对/)
  const unpaired = evaluateRelevanceRedundancy({ bulkyOutputs: [{ ref: 'n2', approxTokens: 9000, persistedCopy: true }] }, 'semantic')
  assert.deepEqual(unpaired.problems, [])
  const independent = evaluateRelevanceRedundancy({ repeats: [{ ref: '同一结论', kind: 'evidence', count: 2, independentEvidence: true }] }, 'semantic')
  assert.deepEqual(independent.problems, [])
  assert.match(independent.finding.limitNote ?? '', /独立证据意义/)
})

test('evaluateRelevanceRedundancy 反例：只有轻量头（详情未加载）标 unknown，不把读不到当没有（§27.1）', () => {
  const evaluation = evaluateRelevanceRedundancy({ detailIncomplete: '时间线只有轻量头，未加载详情' }, 'semantic')
  assert.equal(evaluation.finding.verdict, 'unknown')
  assert.deepEqual(evaluation.problems, [])
  assert.match(evaluation.finding.limitNote ?? '', /未加载不等于没有长输出/)
})

// —— §27.3 分量判定：连续性 / 行为退化 ——

test('evaluateContinuity 正例：在途项有回执且下一步可恢复（§27.3 第 6 行）', () => {
  const evaluation = evaluateContinuity({ inFlight: [{ ref: 'op-1', kind: 'file_write', status: 'intent', receiptRef: 'rcpt-1' }], nextAction: '继续核对台账' })
  assert.equal(evaluation.finding.verdict, 'ok')
  assert.match(evaluation.finding.signal, /有可恢复的下一步/)
})

test('evaluateContinuity 反例：缺回执/结果不明/待确认交接都必须先核对（§27.3 限制栏）', () => {
  const noReceipt = evaluateContinuity({ inFlight: [{ ref: 'op-1', kind: 'file_write', status: 'intent' }] })
  assert.equal(noReceipt.finding.verdict, 'attention')
  assert.equal(must('问题', noReceipt.problems[0]).kind, 'unverifiable_fact')
  const needsReconcile = evaluateContinuity({ inFlight: [{ ref: 'op-2', kind: 'file_write', status: 'executing', receiptRef: 'rcpt-2', needsReconcile: true }] })
  assert.match(must('问题', needsReconcile.problems[0]).detail, /结果不明/)
  const missing = evaluateContinuity({ missingReceipts: ['op-3'] })
  assert.match(must('问题', missing.problems[0]).detail, /先核对再继续/)
  const handoff = evaluateContinuity({ pendingHandoffs: ['sub-1 的交接包'] })
  assert.match(must('问题', handoff.problems[0]).detail, /未收到回执/)
})

test('evaluateContinuity 反例：无法核对的关键事实进 unverifiable_fact，只阻断依赖它的动作（§27.4 第 6 行）', () => {
  const evaluation = evaluateContinuity({ unverifiedFacts: ['外部写入是否落盘无法核对'] })
  assert.equal(evaluation.finding.verdict, 'attention')
  const evaluation2 = evaluateContext(baseSignals({ continuity: { unverifiedFacts: ['外部写入是否落盘无法核对'] } }), 'deterministic')
  const decision = selectAction(evaluation2.problems, { tier: 'deterministic' })
  assert.equal(decision.action, 'wait_reconcile')
  assert.match(decision.reason, /只阻断依赖该事实的动作/)
})

test('evaluateBehaviorRegression 正例/反例：线索只触发检查，不作根因结论（§27.3 第 7 行）', () => {
  const clean = evaluateBehaviorRegression({})
  assert.equal(clean.finding.verdict, 'ok')
  assert.deepEqual(clean.problems, [])
  const regressed = evaluateBehaviorRegression({ repeatedDoneWork: ['重跑已完成的核对'], repeatedQuestions: ['再次询问验收标准'], revokedReuse: ['再次引用已被撤销的结论'] })
  assert.equal(regressed.finding.verdict, 'attention')
  assert.equal(regressed.problems.length, 3)
  assert.ok(regressed.problems.every((item) => item.kind === 'behavior_regression'))
  assert.match(regressed.finding.limitNote ?? '', /不直接证明上下文是根因/)
  const decision = selectAction(evaluateContext(baseSignals({ behaviorRegression: { repeatedDoneWork: ['重跑已完成核对'] } }), 'deterministic').problems, { tier: 'deterministic' })
  assert.equal(decision.action, 'keep')
  assert.ok(decision.notes.some((note) => note.includes('只触发检查')))
})

test('unavailable 的分量一律 unknown 且写明缺什么，连行为线索也不例外（§27.1、§27.2）', () => {
  const evaluation = evaluateBehaviorRegression({ unavailable: '行为线索投影不可用' })
  assert.equal(evaluation.finding.verdict, 'unknown')
  assert.match(evaluation.finding.signal, /未知：行为线索投影不可用/)
  assert.deepEqual(evaluation.problems, [])
})

// —— §27.3 问题集合（没有总分） ——

test('evaluateContext：问题集合只有结构化字段，没有总分/加权字段（§27.3 首句）', () => {
  const evaluation = evaluateContext(baseSignals(), 'deterministic')
  assert.deepEqual(Object.keys(evaluation).sort(), ['findings', 'problems'])
  assert.deepEqual(
    Object.keys(evaluation.problems).sort(),
    [
      'behaviorRegressionSignals',
      'bloatedWithSafeSummaryRange',
      'bloatedWithoutSafeRange',
      'capacityRatio',
      'missingCounterSides',
      'missingKeyConditions',
      'nearHardLimit',
      'progressContinues',
      'prunableBulk',
      'staleReferences',
      'structuralConflicts',
      'taskSwitchedWithIneffectiveRepair',
      'uniqueComplexDetail',
      'unknownComponents',
      'unverifiableFacts',
    ].sort(),
  )
  assert.equal(evaluation.findings.length, COMPONENT_ORDER.length)
})

test('evaluateContext：unknown 分量如实列出，且不阻止原生容量保护（§27.1、§27.4 末段）', () => {
  const evaluation = evaluateContext(baseSignals(), 'deterministic')
  assert.ok(evaluation.problems.unknownComponents.includes('coverage'))
  assert.ok(evaluation.problems.unknownComponents.includes('consistency'))
  assert.ok(evaluation.problems.unknownComponents.includes('relevance_redundancy'))
  const decision = selectAction(evaluation.problems, { tier: 'deterministic' })
  assert.ok(decision.notes.some((note) => note.includes('unknown 不等于健康')))
  const nearHard = evaluateContext(baseSignals({ capacity: { requestEstimateTokens: 9500, contextWindowTokens: 10000 } }), 'deterministic')
  assert.equal(nearHard.problems.nearHardLimit, true)
  assert.equal(selectAction(nearHard.problems, { tier: 'deterministic' }).action, 'compact')
})

test('evaluateContext：历史膨胀在确定性层不得成立"可安全压缩"（§27.4 末段、§27.5 末段）', () => {
  const bloat = { bloated: true, safeSummaryRange: '前 20 轮工具输出可摘要' }
  const deterministic = evaluateContext(baseSignals({ context: { historyBloat: bloat } }), 'deterministic')
  assert.equal(deterministic.problems.bloatedWithSafeSummaryRange, false)
  assert.equal(deterministic.problems.bloatedWithoutSafeRange, true)
  const semantic = evaluateContext(baseSignals({ context: { historyBloat: bloat } }), 'semantic')
  assert.equal(semantic.problems.bloatedWithSafeSummaryRange, true)
  assert.equal(semantic.problems.bloatedWithoutSafeRange, false)
})

test('evaluateContext：正在处理唯一可辨别的复杂细节时，膨胀也不推导压缩（§27.4 末段）', () => {
  const signals = baseSignals({ context: { historyBloat: { bloated: true, safeSummaryRange: '旧摘要可合并' }, uniqueComplexDetail: true } })
  const evaluation = evaluateContext(signals, 'semantic')
  assert.equal(evaluation.problems.bloatedWithSafeSummaryRange, false)
  assert.equal(evaluation.problems.bloatedWithoutSafeRange, true)
  assert.equal(evaluation.problems.uniqueComplexDetail, true)
  const decision = selectAction(evaluation.problems, { tier: 'semantic' })
  assert.equal(decision.action, 'keep')
  assert.match(decision.reason, /唯一可辨别的复杂细节/)
})

// —— §27.4 动作矩阵 ——

test('selectAction 正例：接近硬容量走原生兜底压缩，不受阶段门限制（§27.4 末段）', () => {
  const decision = selectAction(problemSet({ nearHardLimit: true, capacityRatio: 0.95 }), { tier: 'deterministic' })
  assert.equal(decision.action, 'compact')
  assert.equal(decision.gated, true)
  assert.equal(decision.deferredAction, undefined)
  assert.ok(decision.reason.includes(NATIVE_FALLBACK_MARK))
  assert.equal(isNativeFallback(decision), true)
  assert.equal(isNativeFallback(selectAction(problemSet({ progressContinues: true }), { tier: 'deterministic' })), false)
})

test('selectAction 正例：缺关键条件→retrieve，并写明"压缩会变好"不可推导（§27.4 第 1 行）', () => {
  const decision = selectAction(problemSet({ missingKeyConditions: ['rule rul-1 没有送达回执'] }), { tier: 'deterministic' })
  assert.equal(decision.action, 'retrieve')
  assert.equal(decision.gated, false)
  assert.equal(decision.deferredAction, undefined)
  assert.equal(decision.notDerivable, ACTION_MATRIX.retrieve.notDerivable)
  assert.equal(decision.notDerivable, '压缩会变好')
})

test('selectAction 正例：旧结论/规则冲突→refresh（§27.4 第 2 行）', () => {
  const stale = selectAction(problemSet({ staleReferences: ['clm-1 已撤销但仍被引用'] }), { tier: 'deterministic' })
  assert.equal(stale.action, 'refresh')
  assert.equal(stale.notDerivable, '多加一段新摘要就能消除旧前提影响')
  const conflict = selectAction(problemSet({ structuralConflicts: ['规则与任务范围冲突'] }), { tier: 'semantic' })
  assert.equal(conflict.action, 'refresh')
})

test('selectAction：任务已切换且修复无效→rotate，但确定性层只记录不执行（§27.5 末段）', () => {
  const switched = problemSet({ taskSwitchedWithIneffectiveRepair: true })
  const semantic = selectAction(switched, { tier: 'semantic' })
  assert.equal(semantic.action, 'rotate')
  assert.equal(semantic.deferredAction, undefined)
  const deterministic = selectAction(switched, { tier: 'deterministic' })
  assert.equal(deterministic.action, 'keep')
  assert.equal(deterministic.deferredAction, 'rotate')
  assert.equal(deterministic.gated, false)
  assert.match(deterministic.reason, /经校准后才开放/)
})

test('selectAction：可安全剪除的冗余→prune，确定性层同样只记录（§27.4 第 3 行、§27.5 末段）', () => {
  const problems = problemSet({ prunableBulk: ['tool:out-1 长输出已持久保留'] })
  const semantic = selectAction(problems, { tier: 'semantic' })
  assert.equal(semantic.action, 'prune')
  assert.equal(semantic.notDerivable, '可以删除唯一证据或破坏工具调用配对')
  const deterministic = selectAction(problems, { tier: 'deterministic' })
  assert.equal(deterministic.action, 'keep')
  assert.equal(deterministic.deferredAction, 'prune')
})

test('selectAction：膨胀有安全摘要范围→compact；没有安全范围→keep，不因比例自行压缩（§27.4 第 4 行、末段）', () => {
  const safe = selectAction(problemSet({ bloatedWithSafeSummaryRange: true }), { tier: 'semantic' })
  assert.equal(safe.action, 'compact')
  assert.match(safe.reason, /在安全入口调用原生压缩/)
  const unsafe = selectAction(problemSet({ bloatedWithoutSafeRange: true, capacityRatio: 0.88 }), { tier: 'semantic' })
  assert.equal(unsafe.action, 'keep')
  assert.match(unsafe.reason, /不因占用比例自行压缩/)
})

test('selectAction 正例：数据健康且任务有进展→keep；无可判定缺口也 keep（§27.4 第 7 行、§27.5 末段）', () => {
  const progress = selectAction(problemSet({ progressContinues: true, capacityRatio: 0.4 }), { tier: 'semantic' })
  assert.equal(progress.action, 'keep')
  assert.match(progress.reason, /任务继续有进展/)
  assert.equal(progress.notDerivable, ACTION_MATRIX.keep.notDerivable)
  const nothing = selectAction(problemSet(), { tier: 'semantic' })
  assert.equal(nothing.action, 'keep')
  assert.match(nothing.reason, /只记录建议与依据/)
})

test('selectAction：行为线索与未知分量只进 notes，不改变首选动作（§27.3 限制栏）', () => {
  const decision = selectAction(problemSet({ behaviorRegressionSignals: ['复读已做工作'], unknownComponents: ['consistency'] }), { tier: 'deterministic' })
  assert.equal(decision.action, 'keep')
  assert.equal(decision.notes.length, 2)
  assert.ok(decision.notes.some((note) => note.includes('未判定分量：consistency')))
  assert.ok(decision.notes.some((note) => note.includes('行为退化线索 1 项')))
})

test('ACTION_MATRIX/ACTION_ROLLOUT：七行齐备，且分阶段口径与 §27.5 末段一致', () => {
  const actions = ['compact', 'keep', 'prune', 'refresh', 'retrieve', 'rotate', 'wait_reconcile']
  assert.deepEqual(Object.keys(ACTION_MATRIX).sort(), actions)
  assert.deepEqual(Object.keys(ACTION_ROLLOUT).sort(), actions)
  for (const action of actions) {
    assert.ok(must(`矩阵 ${action}`, ACTION_MATRIX[action as keyof typeof ACTION_MATRIX]).notDerivable.length > 0)
  }
  assert.equal(ACTION_ROLLOUT.retrieve, 'deterministic')
  assert.equal(ACTION_ROLLOUT.refresh, 'deterministic')
  assert.equal(ACTION_ROLLOUT.wait_reconcile, 'deterministic')
  assert.equal(ACTION_ROLLOUT.keep, 'deterministic')
  assert.equal(ACTION_ROLLOUT.prune, 'needs_calibration')
  assert.equal(ACTION_ROLLOUT.compact, 'needs_calibration')
  assert.equal(ACTION_ROLLOUT.rotate, 'needs_calibration')
})

// —— 评估生成与校验（§27.5 第 1、2 条） ——

test('recordAssessment 正例：经 commit 落盘，事件与动作状态齐备', () => {
  const rig = crew()
  const bundle = draftFor(rig.state, baseSignals(), 'deterministic')
  const outcome = expectAssessmentOk(recordAssessment(rig.state, bundle.draft, NOW + 1), '记录评估')
  assert.equal(outcome.state.revision, rig.state.revision + 1)
  assert.equal(Object.keys(outcome.state.assessments).length, 1)
  assert.equal(outcome.assessment.actionState, 'recorded')
  assert.equal(outcome.assessment.deterministic, true)
  assert.equal(outcome.assessment.missionRevision, rig.state.revision)
  assert.equal(outcome.assessment.objectiveRevision, rig.state.mission.objectiveRevision)
  assert.equal(outcome.assessment.requestFingerprint, 'fp-1')
  assert.equal(outcome.assessment.missionId, rig.state.missionId)
  assert.ok(outcome.assessment.assessmentId.startsWith('cqa_'))
  assert.equal(must('落盘记录', outcome.state.assessments[outcome.assessment.assessmentId]).suggestion, outcome.assessment.suggestion)
  assert.equal(must('事件', outcome.state.events.at(-1)).kind, 'context/assessment-recorded')
  assert.equal(validateAssessment(outcome.assessment).ok, true)
})

test('recordAssessment 反例：分量不齐立即拒绝，状态不推进（§27.3）', () => {
  const rig = crew()
  const bundle = draftFor(rig.state, baseSignals(), 'deterministic')
  const broken: ContextEvaluation = { findings: bundle.evaluation.findings.slice(0, 6), problems: bundle.evaluation.problems }
  const reason = expectAssessmentRejected(recordAssessment(rig.state, { ...bundle.draft, evaluation: broken }, NOW + 1), '少一个分量')
  assert.match(reason, /分量不齐，缺少：behavior_regression/)
  assert.equal(Object.keys(rig.state.assessments).length, 0)
})

test('recordAssessment 反例：标为 unknown 却没写 limitNote 的记录不许入库（§27.3）', () => {
  const rig = crew()
  const bundle = draftFor(rig.state, baseSignals(), 'deterministic')
  const evaluation: ContextEvaluation = {
    findings: bundle.evaluation.findings.map((finding) => (finding.name === 'coverage' ? { name: finding.name, signal: finding.signal, verdict: 'unknown' as const } : finding)),
    problems: bundle.evaluation.problems,
  }
  const reason = expectAssessmentRejected(recordAssessment(rig.state, { ...bundle.draft, evaluation }, NOW + 1), '未知缺说明')
  assert.match(reason, /分量 coverage 标为未知但没有 limitNote/)
})

test('recordAssessment 反例：空请求指纹无法判断"相同请求复用"（§27.3）', () => {
  const rig = crew()
  const bundle = draftFor(rig.state, baseSignals(), 'deterministic')
  const freeze = freezeFrame(rig.state, { requestFingerprint: '', sessionId: 'sess-1', sessionRevision: 1, criteriaRevision: 1, retentionList: [] })
  const reason = expectAssessmentRejected(recordAssessment(rig.state, { ...bundle.draft, freeze }, NOW + 1), '空指纹')
  assert.match(reason, /requestFingerprint 为空/)
})

test('recordAssessment：确定性层只有原生兜底可以宣布压缩，质量判断压缩一律拒绝（§27.4 末段、§27.5 末段）', () => {
  const rig = crew()
  const bundle = draftFor(rig.state, { ...baseSignals() }, 'deterministic')
  const nativeDecision: ActionDecision = {
    action: 'compact',
    reason: `${NATIVE_FALLBACK_MARK}：容量占用 95.0% 接近硬上限`,
    notDerivable: ACTION_MATRIX.compact.notDerivable,
    gated: true,
    notes: [],
  }
  const accepted = expectAssessmentOk(recordAssessment(rig.state, { ...bundle.draft, decision: nativeDecision }, NOW + 1), '原生兜底压缩')
  assert.equal(accepted.assessment.suggestion, 'compact')
  const qualityDecision: ActionDecision = { action: 'compact', reason: '历史膨胀，建议压缩', notDerivable: ACTION_MATRIX.compact.notDerivable, gated: true, notes: [] }
  const reason = expectAssessmentRejected(recordAssessment(rig.state, { ...bundle.draft, decision: qualityDecision }, NOW + 1), '质量判断压缩')
  assert.match(reason, /确定性层不得因质量判断宣布压缩/)
})

test('recordAssessment 反例：确定性层不得宣布轮换/裁剪（§27.5 末段）', () => {
  const rig = crew()
  const bundle = draftFor(rig.state, baseSignals(), 'deterministic')
  const rotateDecision: ActionDecision = { action: 'rotate', reason: '任务已切换', notDerivable: ACTION_MATRIX.rotate.notDerivable, gated: true, notes: [] }
  const rotateReason = expectAssessmentRejected(recordAssessment(rig.state, { ...bundle.draft, decision: rotateDecision }, NOW + 1), '确定性层轮换')
  assert.match(rotateReason, /不得宣布轮换\/裁剪/)
  const pruneDecision: ActionDecision = { action: 'prune', reason: '长输出可剪', notDerivable: ACTION_MATRIX.prune.notDerivable, gated: true, notes: [] }
  expectAssessmentRejected(recordAssessment(rig.state, { ...bundle.draft, decision: pruneDecision }, NOW + 1), '确定性层裁剪')
})

test('validateAssessment 反例：手拼坏记录被逐条列出（信号为空、未知缺说明、确定性层轮换）', () => {
  const rig = crew()
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'deterministic'))
  const components = recorded.assessment.components
  const first = must('首个分量', components[0])
  const broken: ContextAssessment = {
    ...recorded.assessment,
    components: [{ ...first, signal: '' }, { name: 'coverage', signal: '未知：没有必需的覆盖清单可比对', unknown: true }, ...components.slice(2)],
    suggestion: 'rotate',
    deterministic: true,
  }
  const check = validateAssessment(broken)
  assert.equal(check.ok, false)
  assert.ok(check.problems.some((problem) => problem.includes('信号为空')))
  assert.ok(check.problems.some((problem) => problem.includes('未知缺 limitNote')))
  assert.ok(check.problems.some((problem) => problem.includes('确定性层出现轮换/裁剪建议')))
})

test('toAssessmentComponents：unknown 标在实体字段上，limitNote 原样保留', () => {
  const evaluation = evaluateContext(baseSignals(), 'deterministic')
  const components = toAssessmentComponents(evaluation.findings)
  assert.equal(components.length, COMPONENT_ORDER.length)
  assert.deepEqual(components.map((component) => component.name), [...COMPONENT_ORDER])
  const coverage = must('coverage 分量', components.find((component) => component.name === 'coverage'))
  assert.equal(coverage.unknown, true)
  assert.ok((coverage.limitNote ?? '').length > 0)
  const continuity = must('continuity 分量', components.find((component) => component.name === 'continuity'))
  assert.equal(continuity.unknown, undefined)
  assert.ok((continuity.limitNote ?? '').length > 0)
})

// —— 会话/版本冻结与失效（§27.5 第 2 条） ——

test('freezeFrame：五组版本与目标保留清单一起冻结，missionRevision 取当前记录水位', () => {
  const rig = crew()
  const freeze = freezeFrame(rig.state, { requestFingerprint: 'fp-x', sessionId: 'sess-1', sessionRevision: 4, criteriaRevision: 2, retentionList: ['ev-1', 'clm-1'] })
  assert.equal(freeze.missionRevision, rig.state.revision)
  assert.equal(freeze.objectiveRevision, rig.state.mission.objectiveRevision)
  assert.equal(freeze.policyRevision, rig.state.mission.policyRevision)
  assert.equal(freeze.criteriaRevision, 2)
  assert.equal(freeze.sessionRevision, 4)
  assert.equal(freeze.sessionId, 'sess-1')
  assert.deepEqual(freeze.retentionList, ['ev-1', 'clm-1'])
})

test('frameDrifts：会话变化阻断失效，记录水位推进只报告（§27.5 第 2 条）', () => {
  const at: AssessmentFrame = { sessionId: 'sess-1', sessionRevision: 1, missionRevision: 3, objectiveRevision: 1, policyRevision: 1, criteriaRevision: 1, requestFingerprint: 'fp' }
  assert.deepEqual(frameDrifts(at, at), [])
  const session = frameDrifts(at, { ...at, sessionId: 'sess-2' })
  assert.equal(session.length, 1)
  assert.equal(must('会话漂移', session[0]).blocking, true)
  const watermark = frameDrifts(at, { ...at, missionRevision: 9 })
  assert.equal(watermark.length, 1)
  assert.equal(must('水位漂移', watermark[0]).blocking, false)
  assert.match(must('水位漂移', watermark[0]).detail, /按需重查/)
  assert.deepEqual(frameDrifts(at, { ...at, missionRevision: 2 }), [])
  const all = frameDrifts(at, { ...at, sessionRevision: 2, objectiveRevision: 2, policyRevision: 2, criteriaRevision: 2, requestFingerprint: 'other' })
  assert.equal(all.filter((drift) => drift.blocking).length, 5)
})

test('assessmentIsCurrent：只看阻断性漂移（会话/指纹/目标/规则/判据）', () => {
  const rig = crew()
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'semantic'))
  const later = { ...recorded.assessment, missionRevision: recorded.assessment.missionRevision + 7 }
  assert.equal(assessmentIsCurrent(recorded.assessment, later).ok, true)
  const drift = assessmentIsCurrent(recorded.assessment, { ...recorded.assessment, criteriaRevision: recorded.assessment.criteriaRevision + 1 })
  assert.equal(drift.ok, false)
  assert.equal(drift.blocking.length, 1)
  assert.equal(must('漂移', drift.blocking[0]).field, 'criteriaRevision')
})

test('reuseAssessment 正例：记录水位推进后仍可复用；层不同不复用（§27.3）', () => {
  const rig = crew()
  const bundle = draftFor(rig.state, baseSignals(), 'deterministic', 'fp-reuse')
  const recorded = recordOk(rig.state, bundle)
  const bumped = recordEvidence(recorded.state, {}).state
  assert.ok(bumped.revision > recorded.assessment.missionRevision)
  assert.equal(reuseAssessment(bumped, bundle.draft.freeze, 'deterministic')?.assessmentId, recorded.assessment.assessmentId)
  assert.equal(reuseAssessment(bumped, bundle.draft.freeze, 'semantic'), undefined)
})

test('reuseAssessment 反例：指纹或判据版本变了就不算同一份请求（§27.3）', () => {
  const rig = crew()
  const bundle = draftFor(rig.state, baseSignals(), 'deterministic', 'fp-reuse')
  const recorded = recordOk(rig.state, bundle)
  assert.equal(reuseAssessment(recorded.state, { ...bundle.draft.freeze, requestFingerprint: 'other' }, 'deterministic'), undefined)
  assert.equal(reuseAssessment(recorded.state, { ...bundle.draft.freeze, criteriaRevision: 2 }, 'deterministic'), undefined)
  assert.equal(reuseAssessment(recorded.state, { ...bundle.draft.freeze, sessionId: 'sess-2' }, 'deterministic'), undefined)
})

test('invalidateAssessment 正例：会话变化把未执行的评估转 skipped 并留事件（§27.5 第 2 条）', () => {
  const rig = crew()
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'deterministic'))
  const id = recorded.assessment.assessmentId
  const invalidated = expectInvalidationOk(invalidateAssessment(recorded.state, id, { ...recorded.assessment, sessionRevision: 9 }, NOW + 2), '会话变化失效')
  assert.equal(invalidated.assessment.actionState, 'skipped')
  assert.equal(must('落盘记录', invalidated.state.assessments[id]).actionState, 'skipped')
  assert.equal(invalidated.state.revision, recorded.state.revision + 1)
  assert.equal(must('事件', invalidated.state.events.at(-1)).kind, 'context/assessment-action')
  assert.equal(invalidated.drifts.filter((drift) => drift.blocking).length, 1)
})

test('invalidateAssessment 反例：版本一致时拒绝"失效"，不存在的评估也拒绝', () => {
  const rig = crew()
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'deterministic'))
  const noDrift = expectInvalidationRejected(invalidateAssessment(recorded.state, recorded.assessment.assessmentId, recorded.assessment, NOW + 2), '无漂移')
  assert.match(noDrift, /未发现失效/)
  const missing = expectInvalidationRejected(invalidateAssessment(recorded.state, 'cqa_missing', recorded.assessment, NOW + 2), '不存在的评估')
  assert.match(missing, /不在记录中/)
})

test('invalidateAssessment：已到终态的评估只追加事件，不改写历史（§27.5 第 4 条）', () => {
  const rig = crew()
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'semantic'))
  const id = recorded.assessment.assessmentId
  const running = stepOk(recorded.state, id, 'running')
  const done = stepOk(running.state, id, 'done', '核对通过')
  const invalidated = expectInvalidationOk(invalidateAssessment(done.state, id, { ...recorded.assessment, sessionRevision: 5 }, NOW + 5), '终态失效留痕')
  assert.equal(invalidated.assessment.actionState, 'done')
  assert.equal(must('落盘记录', invalidated.state.assessments[id]).actionState, 'done')
  assert.equal(must('事件', invalidated.state.events.at(-1)).kind, 'context/assessment-invalidated')
})

test('recordDrifts：只凭记录能核对目标与规则快照的修订（§27.5 第 2 条）', () => {
  const rig = crew()
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'deterministic'))
  assert.deepEqual(recordDrifts(recorded.assessment, recorded.state), [])
  const revised = apply(recorded.state, { kind: 'mission.revise', requestId: req() }, ctx('supervisor'))
  const drifted = recordDrifts(must('评估', revised.assessments[recorded.assessment.assessmentId]), revised)
  assert.equal(drifted.length, 1)
  assert.match(must('漂移', drifted[0]), /目标已修订/)
})

// —— §27.5 第 3 条：闭环状态机 ——

test('状态机：合法迁移逐格正反例，终态不可再动', () => {
  assert.deepEqual([...ACTION_STATES], ['recorded', 'queued', 'running', 'done', 'failed', 'skipped'])
  assert.equal(INITIAL_ACTION_STATE, 'recorded')
  assert.deepEqual([...ACTION_TRANSITIONS.recorded], ['queued', 'running', 'skipped'])
  assert.deepEqual([...ACTION_TRANSITIONS.queued], ['running', 'skipped'])
  assert.deepEqual([...ACTION_TRANSITIONS.running], ['done', 'failed', 'skipped'])
  assert.deepEqual([...ACTION_TRANSITIONS.done], [])
  assert.deepEqual([...ACTION_TRANSITIONS.failed], [])
  assert.deepEqual([...ACTION_TRANSITIONS.skipped], [])
  assert.equal(legalActionStep('recorded', 'running'), true)
  assert.equal(legalActionStep('recorded', 'skipped'), true)
  assert.equal(legalActionStep('queued', 'skipped'), true)
  assert.equal(legalActionStep('running', 'failed'), true)
  assert.equal(legalActionStep('recorded', 'done'), false)
  assert.equal(legalActionStep('queued', 'done'), false)
  assert.equal(legalActionStep('running', 'queued'), false)
  assert.equal(legalActionStep('done', 'running'), false)
  assert.equal(legalActionStep('failed', 'queued'), false)
  assert.equal(legalActionStep('skipped', 'running'), false)
  assert.deepEqual(PLAN_STATE, { run_now: 'running', queue: 'queued', skip: 'skipped' })
})

test('transitionAction 正例：recorded→queued→running→done 全链经 commit 落盘', () => {
  const rig = crew()
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'semantic'))
  const id = recorded.assessment.assessmentId
  const queued = stepOk(recorded.state, id, 'queued', '会话活跃先排队')
  assert.equal(queued.assessment.actionState, 'queued')
  assert.equal(queued.state.revision, recorded.state.revision + 1)
  const running = stepOk(queued.state, id, 'running', 'idle 入口空闲开跑')
  assert.deepEqual(must('事件', running.state.events.at(-1)).detail, { assessmentId: id, from: 'queued', to: 'running', note: 'idle 入口空闲开跑' })
  assert.equal(must('事件', running.state.events.at(-1)).kind, 'context/assessment-action')
  const done = stepOk(running.state, id, 'done', '核对通过')
  assert.equal(done.assessment.actionState, 'done')
  assert.equal(done.assessment.actionNote, '核对通过')
  assert.equal(done.state.revision, running.state.revision + 1)
})

test('transitionAction 反例：跳级、重复、空说明、终态再动、评估不存在一律拒绝', () => {
  const rig = crew()
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'semantic'))
  const id = recorded.assessment.assessmentId
  assert.match(expectTransitionRejected(transitionAction(recorded.state, id, 'done', '跳级', NOW + 2), '跳级'), /不是合法迁移/)
  assert.match(expectTransitionRejected(transitionAction(recorded.state, id, 'recorded', '原地', NOW + 2), '重复迁移'), /已经是 recorded/)
  assert.match(expectTransitionRejected(transitionAction(recorded.state, id, 'queued', '   ', NOW + 2), '空说明'), /必须写明依据/)
  assert.match(expectTransitionRejected(transitionAction(recorded.state, 'cqa_missing', 'queued', 'x', NOW + 2), '不存在的评估'), /不在记录中/)
  const running = stepOk(recorded.state, id, 'running')
  const done = stepOk(running.state, id, 'done', '核对通过')
  assert.match(expectTransitionRejected(transitionAction(done.state, id, 'failed', '再动终态', NOW + 3), '终态再动'), /不是合法迁移/)
})

test('transitionAction 反例：目标已修订时不许进 running，先重新检查（§27.5 第 2 条）', () => {
  const rig = crew()
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'semantic'))
  const revised = apply(recorded.state, { kind: 'mission.revise', requestId: req() }, ctx('supervisor'))
  const reason = expectTransitionRejected(transitionAction(revised, recorded.assessment.assessmentId, 'running', '直接开跑', NOW + 3), '目标已修订')
  assert.match(reason, /执行前版本核对失败/)
  assert.match(reason, /目标已修订/)
})

test('planActionRun：keep/wait_reconcile/终态不占维护入口（§27.4 第 6、7 行）', () => {
  const rig = crew()
  const idle: ActionRunContext = { entry: 'idle_maintenance', sessionActive: false, maintenanceEntryFree: true }
  const keep = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'deterministic'))
  assert.equal(keep.assessment.suggestion, 'keep')
  assert.match(planActionRun(keep.assessment, idle).reason, /只记录不占用维护入口/)
  const wait = recordOk(rig.state, draftFor(rig.state, baseSignals({ continuity: { unverifiedFacts: ['外部写入结果不明'] } }), 'deterministic'))
  assert.equal(wait.assessment.suggestion, 'wait_reconcile')
  assert.match(planActionRun(wait.assessment, idle).reason, /由守卫按依赖实施/)
  const running = stepOk(keep.state, keep.assessment.assessmentId, 'running')
  const done = stepOk(running.state, keep.assessment.assessmentId, 'done', '已完成')
  assert.match(planActionRun(done.assessment, idle).reason, /不再调度/)
})

test('planActionRun：需校准的动作没签字只跳过；原生兜底压缩例外（§27.5 末段、§27.4 末段）', () => {
  const rig = crew()
  const idle: ActionRunContext = { entry: 'idle_maintenance', sessionActive: false, maintenanceEntryFree: true }
  const rotate = recordOk(rig.state, draftFor(rig.state, baseSignals({ context: { taskSwitch: { switched: true, staleInterference: true, repairsIneffective: true } } }), 'semantic'))
  assert.equal(rotate.assessment.suggestion, 'rotate')
  assert.match(planActionRun(rotate.assessment, idle).reason, /需校准后才开放执行/)
  assert.equal(planActionRun(rotate.assessment, { ...idle, calibrationAcknowledged: true }).kind, 'run_now')
  const fallback = recordOk(rig.state, draftFor(rig.state, baseSignals({ capacity: { requestEstimateTokens: 9500, contextWindowTokens: 10000 } }), 'deterministic'))
  assert.equal(fallback.assessment.suggestion, 'compact')
  assert.equal(isNativeFallback(fallback.assessment), true)
  assert.equal(planActionRun(fallback.assessment, idle).kind, 'run_now')
})

test('planActionRun：会话活跃/入口占用/轮换在途/非 idle 入口都要排队，不冒充 idle（§27.5 第 3 条）', () => {
  const rig = crew()
  const fallback = recordOk(rig.state, draftFor(rig.state, baseSignals({ capacity: { requestEstimateTokens: 9500, contextWindowTokens: 10000 } }), 'deterministic'))
  assert.equal(planActionRun(fallback.assessment, { entry: 'idle_maintenance', sessionActive: true, maintenanceEntryFree: true }).kind, 'queue')
  assert.equal(planActionRun(fallback.assessment, { entry: 'pre_step', sessionActive: false, maintenanceEntryFree: true }).kind, 'queue')
  assert.equal(planActionRun(fallback.assessment, { entry: 'admission', sessionActive: false, maintenanceEntryFree: true }).kind, 'queue')
  assert.equal(planActionRun(fallback.assessment, { entry: 'idle_maintenance', sessionActive: false, maintenanceEntryFree: false }).kind, 'queue')
  assert.equal(planActionRun(fallback.assessment, { entry: 'idle_maintenance', sessionActive: false, maintenanceEntryFree: true, rotationPending: true }).kind, 'queue')
  assert.equal(planActionRun(fallback.assessment, { entry: 'idle_maintenance', sessionActive: false, maintenanceEntryFree: true }).kind, 'run_now')
})

test('applyRunPlan：计划到状态的唯一映射；在途再排队被拒（不忙循环重试，§27.5 第 3 条）', () => {
  const rig = crew()
  const bundle = draftFor(rig.state, baseSignals({ context: { historyBloat: { bloated: true, safeSummaryRange: '旧摘要可合并' } } }), 'semantic')
  const recorded = recordOk(rig.state, bundle)
  const id = recorded.assessment.assessmentId
  const busy: ActionRunContext = { entry: 'idle_maintenance', sessionActive: true, maintenanceEntryFree: true, calibrationAcknowledged: true }
  const idle: ActionRunContext = { entry: 'idle_maintenance', sessionActive: false, maintenanceEntryFree: true, calibrationAcknowledged: true }
  const queuePlan = planActionRun(recorded.assessment, busy)
  assert.equal(queuePlan.kind, 'queue')
  const queued = expectTransitionOk(applyRunPlan(recorded.state, id, queuePlan, NOW + 2), '计划排队')
  assert.equal(queued.assessment.actionState, 'queued')
  // 重复排队：状态已经是 queued，原地重排被拒。
  assert.match(expectTransitionRejected(applyRunPlan(queued.state, id, queuePlan, NOW + 3), '重复排队'), /已经是 queued/)
  const runPlan = planActionRun(recorded.assessment, idle)
  assert.equal(runPlan.kind, 'run_now')
  const running = expectTransitionOk(applyRunPlan(queued.state, id, runPlan, NOW + 4), '计划开跑')
  assert.equal(running.assessment.actionState, 'running')
  assert.match(expectTransitionRejected(applyRunPlan(running.state, id, queuePlan, NOW + 5), '在途再排队'), /不是合法迁移/)
})

test('applyActionOutcome 正例：done 记录效果；token 减少量单独不算成功（§27.5 第 5 条）', () => {
  const rig = crew()
  const bundle = draftFor(rig.state, baseSignals(), 'semantic')
  const recorded = recordOk(rig.state, bundle)
  const id = recorded.assessment.assessmentId
  const running = stepOk(recorded.state, id, 'running')
  const done = expectTransitionOk(
    applyActionOutcome(running.state, id, { kind: 'done', effect: { restoredInfo: true, behaviorImproved: true, reclaimedTokens: 12000, costNote: '一次原生压缩调用' } }, NOW + 4),
    '完成收口',
  )
  const note = done.assessment.actionNote ?? ''
  assert.equal(done.assessment.actionState, 'done')
  assert.match(note, /必要信息已恢复/)
  assert.match(note, /后续行为改善/)
  assert.match(note, /回收约 12000 token/)
  assert.match(note, /成本：一次原生压缩调用/)

  const tokenOnlyRunning = stepOk(recorded.state, id, 'running')
  const tokenOnly = expectTransitionOk(applyActionOutcome(tokenOnlyRunning.state, id, { kind: 'done', effect: { reclaimedTokens: 9000 } }, NOW + 5), '只有 token 记账')
  assert.match(tokenOnly.assessment.actionNote ?? '', /仅记账/)
  const empty = expectTransitionOk(applyActionOutcome(running.state, id, { kind: 'done' }, NOW + 6), '没记效果')
  assert.match(empty.assessment.actionNote ?? '', /未记录效果/)
})

test('applyActionOutcome 反例：压缩后核对缺项走 failed，写明重建/轮换而不是再压一次（§27.5 第 4 条）', () => {
  const rig = crew()
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'semantic'))
  const id = recorded.assessment.assessmentId
  const running = stepOk(recorded.state, id, 'running')
  const failed = expectTransitionOk(applyActionOutcome(running.state, id, { kind: 'shortfall', missing: ['保留清单缺项：ev-1'] }, NOW + 4), '缺项收口')
  assert.equal(failed.assessment.actionState, 'failed')
  assert.match(failed.assessment.actionNote ?? '', /不通过反复压缩修复内容缺失/)
  assert.match(failed.assessment.actionNote ?? '', /ev-1/)
})

test('applyActionOutcome 反例：原生 busy/changed 记 failed，不重排队（§27.5 第 3 条）', () => {
  const rig = crew()
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'semantic'))
  const id = recorded.assessment.assessmentId
  const running = stepOk(recorded.state, id, 'running')
  const failed = expectTransitionOk(applyActionOutcome(running.state, id, { kind: 'busy', detail: 'changed：会话刚有新提交' }, NOW + 4), 'busy 收口')
  assert.equal(failed.assessment.actionState, 'failed')
  assert.match(failed.assessment.actionNote ?? '', /禁止忙循环重试/)
  assert.equal(planActionRun(failed.assessment, { entry: 'idle_maintenance', sessionActive: false, maintenanceEntryFree: true }).kind, 'skip')
})

test('applyActionOutcome：不执行记 skipped；终态再收口被拒', () => {
  const rig = crew()
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'semantic'))
  const id = recorded.assessment.assessmentId
  const skipped = expectTransitionOk(applyActionOutcome(recorded.state, id, { kind: 'declined', detail: '本部署没有可用的压缩入口' }, NOW + 4), '不执行')
  assert.equal(skipped.assessment.actionState, 'skipped')
  assert.match(expectTransitionRejected(applyActionOutcome(skipped.state, id, { kind: 'failed', detail: 'x' }, NOW + 5), '终态再收口'), /不是合法迁移/)
})

// —— §27.5 第 1 条：压缩前清点 ——

test('compactionPreflight 正例：关键对象都在权威状态里，保留清单可解析', () => {
  const rig = withClaimedTask()
  const withEvidence = recordEvidence(rig.state, {})
  const report = compactionPreflight(withEvidence.state, [rig.taskId, withEvidence.evidenceId])
  assert.equal(report.ready, true)
  assert.deepEqual(report.missing, [])
  assert.ok(report.durable.some((line) => line.includes('下一步：提交本次结果')))
  assert.ok(report.durable.some((line) => line.includes('保留清单 2 项均可解析')))
  assert.ok(report.durable.some((line) => line.includes('在途操作 0 项')))
})

test('compactionPreflight 反例：保留清单里解析不到的项先补，不能带着缺口压', () => {
  const rig = withClaimedTask()
  const report = compactionPreflight(rig.state, [rig.taskId, 'ref-does-not-exist'])
  assert.equal(report.ready, false)
  assert.ok(report.missing.some((line) => line.includes('无法在权威状态中解析')))
})

test('compactionPreflight 反例：没有记录可恢复的下一步时不许压缩（§27.5 第 1 条）', () => {
  const rig = crew()
  const report = compactionPreflight(rig.state, [])
  assert.equal(report.ready, false)
  assert.ok(report.missing.some((line) => line.includes('没有记录可恢复的下一步')))
})

test('compactionPreflight：结果不明的在途操作必须写明核对路径（§27.5 第 1、4 条）', () => {
  const rig = withClaimedTask()
  const intent = apply(rig.state, intentCommand(rig.taskId), ctx('lead', 'lead-1', 'sess-1'))
  const operationId = must('操作', Object.keys(intent.operations)[0])
  const unknownOk = apply(intent, { kind: 'operation.reconcile', requestId: req(), operationId, verdict: 'still_unknown' }, ctx('lead', 'lead-1', 'sess-1'))
  assert.equal(must('操作', unknownOk.operations[operationId]).status, 'outcome_unknown')
  const report = compactionPreflight(unknownOk, [rig.taskId])
  assert.equal(report.ready, true)
  assert.ok(report.durable.some((line) => line.includes('结果不明的均可核对')))

  const rig2 = withClaimedTask()
  const bareIntent = apply(rig2.state, intentCommand(rig2.taskId, { reconcileMethod: undefined }), ctx('lead', 'lead-1', 'sess-1'))
  const operationId2 = must('操作', Object.keys(bareIntent.operations)[0])
  const unknownBare = apply(bareIntent, { kind: 'operation.reconcile', requestId: req(), operationId: operationId2, verdict: 'still_unknown' }, ctx('lead', 'lead-1', 'sess-1'))
  const blocked = compactionPreflight(unknownBare, [rig2.taskId])
  assert.equal(blocked.ready, false)
  assert.ok(blocked.missing.some((line) => line.includes('先定核对路径')))
})

// —— §27.5 第 4 条：压缩后核对 ——

test('verifyPostCompaction 正例：保留清单、引用、容量、版本四项都有证据才算通过', () => {
  const rig = crew()
  const bundle = draftFor(rig.state, baseSignals(), 'semantic')
  const freeze: AssessmentFreeze = { ...bundle.draft.freeze, retentionList: ['ev-1', 'clm-1'] }
  const report = verifyPostCompaction(freeze, {
    keptRefs: ['ev-1', 'clm-1'],
    unresolvableRefs: [],
    capacityAfter: { requestEstimateTokens: 100, contextWindowTokens: 1000 },
    current: freeze,
  })
  assert.equal(report.ok, true)
  assert.equal(report.nextStep, 'none')
  assert.deepEqual(report.missing, [])
  assert.equal(report.capacityNote, '压缩后新请求容量 10.0%')
  assert.deepEqual(report.frameDrifts, [])
})

test('verifyPostCompaction 反例：保留清单缺项或引用不可解析都走重建；容量仍高时走安全轮换', () => {
  const rig = crew()
  const freeze: AssessmentFreeze = { ...draftFor(rig.state, baseSignals(), 'semantic').draft.freeze, retentionList: ['ev-1', 'clm-1'] }
  const missing = verifyPostCompaction(freeze, { keptRefs: ['ev-1'], capacityAfter: { requestEstimateTokens: 100, contextWindowTokens: 1000 }, current: freeze })
  assert.equal(missing.ok, false)
  assert.equal(missing.nextStep, 'rebuild_from_authoritative_state')
  assert.ok(missing.missing.some((line) => line.includes('保留清单缺项：clm-1')))
  assert.ok(missing.notes.some((line) => line.includes('不通过反复压缩修复内容缺失')))
  const unresolved = verifyPostCompaction(freeze, { keptRefs: ['ev-1', 'clm-1'], unresolvableRefs: ['clm-1'], capacityAfter: { requestEstimateTokens: 100, contextWindowTokens: 1000 }, current: freeze })
  assert.equal(unresolved.ok, false)
  assert.ok(unresolved.missing.some((line) => line.includes('关键引用不可解析')))
  const busyLoop = verifyPostCompaction(freeze, { keptRefs: ['ev-1'], capacityAfter: { requestEstimateTokens: 9600, contextWindowTokens: 10000 }, current: freeze })
  assert.equal(busyLoop.nextStep, 'safe_rotation')
  assert.ok(busyLoop.notes.some((line) => line.includes('禁止忙循环重试或反复压缩')))
})

test('verifyPostCompaction 反例：压缩期间版本漂移即本次评估失效', () => {
  const rig = crew()
  const bundle = draftFor(rig.state, baseSignals(), 'semantic')
  const freeze: AssessmentFreeze = { ...bundle.draft.freeze, retentionList: ['ev-1'] }
  const report = verifyPostCompaction(freeze, {
    keptRefs: ['ev-1'],
    capacityAfter: { requestEstimateTokens: 100, contextWindowTokens: 1000 },
    current: { ...freeze, criteriaRevision: freeze.criteriaRevision + 1 },
  })
  assert.equal(report.ok, false)
  assert.equal(report.frameDrifts.filter((drift) => drift.blocking).length, 1)
  assert.ok(report.notes.some((line) => line.includes('本次评估失效')))
})

test('verifyPostCompaction 反例：容量或当前版本取不到时不宣称已恢复（unknown ≠ 健康）', () => {
  const rig = crew()
  const freeze: AssessmentFreeze = { ...draftFor(rig.state, baseSignals(), 'semantic').draft.freeze, retentionList: ['ev-1', 'clm-1'] }
  const report = verifyPostCompaction(freeze, { keptRefs: ['ev-1', 'clm-1'] })
  assert.equal(report.ok, false)
  assert.equal(report.nextStep, 'rebuild_from_authoritative_state')
  assert.equal(report.capacityNote, '新请求容量未取到（缺字段即未知）：不宣称已恢复')
  assert.ok(report.missing.some((line) => line.includes('有效版本未取到')))
  assert.ok(report.missing.some((line) => line.includes('新请求容量未取到')))
  assert.deepEqual(report.frameDrifts, [])
})

// —— 一次链入口 ——

test('assessContext：同一信号在语义层可宣布压缩，确定性层只记录（§27.3、§27.5 末段）', () => {
  const rig = crew()
  const signals = baseSignals({ context: { historyBloat: { bloated: true, safeSummaryRange: '前 20 轮工具输出可摘要' } } })
  const semantic = expectAssessmentOk(assessContext(rig.state, { actorId: 'lead-1', freeze: freezeFor(rig.state, 'fp-a'), signals, tier: 'semantic' }, NOW + 1), '语义层评估')
  assert.equal(semantic.assessment.suggestion, 'compact')
  assert.equal(semantic.assessment.deterministic, false)
  const deterministic = expectAssessmentOk(assessContext(rig.state, { actorId: 'lead-1', freeze: freezeFor(rig.state, 'fp-b'), signals, tier: 'deterministic' }, NOW + 1), '确定性层评估')
  assert.equal(deterministic.assessment.suggestion, 'keep')
  assert.match(deterministic.assessment.reason, /没有可判定的安全摘要范围/)
  assert.equal(deterministic.assessment.deterministic, true)
})

test('assessContext：接近硬容量走原生兜底压缩，理由里带 native-fallback 标记', () => {
  const rig = crew()
  const signals = baseSignals({ capacity: { requestEstimateTokens: 9500, contextWindowTokens: 10000 } })
  const outcome = expectAssessmentOk(assessContext(rig.state, { actorId: 'lead-1', freeze: freezeFor(rig.state, 'fp-c'), signals, tier: 'deterministic', costNote: '确定性层：无额外模型调用' }, NOW + 1), '原生兜底评估')
  assert.equal(outcome.assessment.suggestion, 'compact')
  assert.ok(outcome.assessment.reason.includes(NATIVE_FALLBACK_MARK))
  assert.equal(outcome.assessment.costNote, '确定性层：无额外模型调用')
  assert.equal(validateAssessment(outcome.assessment).ok, true)
})

// —— §27.1 适配层：投影读取 ——

test('readProjection：ok/missing/not_loaded/incompatible/error 五种口径分开记（§27.1）', () => {
  // 值面可读：0.70.0 的 `contextTimeline` 值是 `Snapshot`（`lib/index.d.ts:244-312`）。
  // 面上**没有** `loaded` 这一项——"是否加载"由 `availability` 表达，值本身只带 `ok` 与那些集合；
  // 真实空集合（`requests/events/nodes/archive` 都是空数组）是 `ok`，与 `not_loaded` 意义不同。
  const timelineValue = { ok: true, current: { system: 120, total: 1200 }, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [] }
  const ok = readProjection<ContextTimelineStateLike>(snapshotOnly({ contextTimeline: timelineValue }), {}, 'contextTimeline')
  assert.equal(ok.availability, 'ok')
  assert.equal(ok.via, 'snapshot')
  assert.equal(ok.state?.ok, true)
  assert.equal(ok.state?.current?.total, 1200)
  const missing = readProjection(undefined, {}, 'contextTimeline')
  assert.equal(missing.availability, 'missing')
  assert.match(missing.note, /投影注册表未装载/)
  const notLoaded = readProjection<ContextTimelineStateLike>(snapshotOnly({}), {}, 'contextTimeline')
  assert.equal(notLoaded.availability, 'not_loaded')
  assert.match(notLoaded.note, /未加载 ≠ 空集合/)
  // fold state 回退路径：只有 `stateOf` 时读到的是另一张面（`src/host/foldState.ts:21-63` 的 `surface`/`sums`），
  // `readProjection` 只如实标注来源（note 里写"fold state 回退"）、把这一面原样带回，不当投影响应值用；
  // 把它折算成值面 `current` 的动作在 `readDshContext` 的 `normalizeTimelineRead`（本文件 473-477 行）里做，
  // 由 #295/#300 的 `via === 'state'` 分支覆盖，不在这一层断言（§27.1）。
  const folded = readProjection<ContextTimelineStateLike>({ stateOf: () => null }, {}, 'contextTimeline')
  assert.equal(folded.availability, 'not_loaded')
  const fallback = readProjection<ContextTimelineStateLike>(
    { stateOf: (_session: unknown, name: string) => (name === 'contextTimeline' ? { surface: [{ seq: 1, cat: 'user', tokens: 300 }], sums: { user: 300 }, systemTokens: 120, requests: [], events: [], detailRev: 2 } : undefined) },
    {},
    'contextTimeline',
  )
  assert.equal(fallback.availability, 'ok')
  assert.equal(fallback.via, 'state')
  assert.match(fallback.note, /fold state 回退/)
  // 不兼容零值回退：真实门槛是 `unsupported{current,minimum}`（`lib/index.d.ts:246-251`——宿主低于基线时
  // 宿主不折叠任何数，全为零值）；`incompatibleVersion` 是同一判据在别年代值面上的写法，出现即按同名语义采信。
  const incompatible = readProjection<ContextTimelineStateLike>(snapshotOnly({ contextTimeline: { ok: false, unsupported: { current: '0.69.0', minimum: '0.70.0' } } }), {}, 'contextTimeline')
  assert.equal(incompatible.availability, 'incompatible')
  assert.match(incompatible.note, /零值回退不能解释为健康/)
  const flagged = readProjection<ContextTimelineStateLike>(snapshotOnly({ contextTimeline: { incompatibleVersion: true } }), {}, 'contextTimeline')
  assert.equal(flagged.availability, 'incompatible')
  assert.match(flagged.note, /零值回退不能解释为健康/)
  // 读取失败：两条面各自抛错都收敛成 `error`，绝不按 0 回退（§27.1）。
  const error = readProjection(
    {
      snapshot: () => {
        throw new Error('boom')
      },
    },
    {},
    'contextTimeline',
  )
  assert.equal(error.availability, 'error')
  assert.match(error.note, /投影值抛错/)
  const stateError = readProjection(
    {
      stateOf: () => {
        throw new Error('boom')
      },
    },
    {},
    'contextTimeline',
  )
  assert.equal(stateError.availability, 'error')
  assert.match(stateError.note, /fold state 抛错/)
  assert.deepEqual(DSH_CONTEXT_PROJECTIONS, { timeline: 'contextTimeline', headers: 'contextHeaders', activity: 'contextActivity' })
})

test('timelineDetails：轻量头/截断/近似重建三种退化分开记，绝不合并成"没有异常"（§27.1）', () => {
  // 内联服务的全集基线（截断/近似重建用例在它上面各加一个真实标记，保证"只有那一态"）。
  const servedCollections = {
    ok: true,
    current: { system: 120, total: 1200 },
    requests: [{ seq: 40, time: NOW, total: 300 }],
    events: [{ seq: 41, time: NOW, kind: 'inject', tokens: 20 }],
    nodes: [{ seq: 42, time: NOW, cat: 'tool', tokens: 500 }],
    droppedNodes: 0,
    archive: [{ seq: 20, time: NOW - 1000, cat: 'tool', tokens: 90, gone: 41 }],
  }
  const view = (extra: Record<string, unknown>) =>
    timelineDetails(readProjection<ContextTimelineStateLike>(snapshotOnly({ contextTimeline: { ...servedCollections, ...extra } }), {}, 'contextTimeline'))

  // 轻量头：0.70.0 值面上的形式是拆分代次头部字段在场（`detailRev`，`lib/index.d.ts:280-284`）而四个集合
  // 是空占位（`:285-297`"The slim head serves these EMPTY"，详情走 `/api/dsh-context/detail` 按需通道）。
  const light = view({ detailRev: 3, counts: { turns: 2, steps: 3 }, last: { seq: 9, total: 800 }, requests: [], events: [], nodes: [], archive: [] })
  assert.equal(light.split, true)
  assert.equal(light.loaded, false)
  assert.match(light.note, /只有轻量头/)
  assert.match(light.note, /\/api\/dsh-context\/detail/)
  assert.equal(light.truncated, false)
  assert.equal(light.reconstructed, false)
  // `heads` 清单是别年代值面上的同一"只有头"写法，出现即按同名语义采信（适配层文件头 `src/adapter/dsh-context.ts:36-37`）。
  const headsOnly = view({ heads: [{ id: 'h1', kind: 'summary', summary: '同一摘要' }], requests: [], events: [], nodes: [], archive: [] })
  assert.equal(headsOnly.split, true)
  assert.equal(headsOnly.loaded, false)

  // 真实空集合：头字段不在场、集合随值服务但为空 ⇒ "看过了，确实没有"，不是任何退化形态。
  const detailed = view({ requests: [], events: [], nodes: [], archive: [] })
  assert.equal(detailed.split, false)
  assert.equal(detailed.loaded, true)
  assert.equal(detailed.note, '轻量头与详情均已加载')
  // 缓存行内联值：`detailRev` 同样在场，但集合非空 ⇒ 不能只凭头字段判成未加载（§27.1 的分界）。
  const inlineWithRev = view({ detailRev: 7 })
  assert.equal(inlineWithRev.split, false)
  assert.equal(inlineWithRev.loaded, true)
  assert.equal(inlineWithRev.note, '轻量头与详情均已加载')

  // 被截断：真实标记是 `droppedNodes` > 0（`lib/index.d.ts:298-299`）；`truncated`/`hasMore` 是同义写法。
  // 上游在 `droppedNodes` > 0 时必然也给 `surfaceFloor`（`:303-304`"present only when droppedNodes > 0"），
  // 所以这一条读数同时命中"近似重建"——两态各自成立、都如实记录，不折成一个"覆盖不全"旗标。
  const truncated = view({ droppedNodes: 3, surfaceFloor: 61 })
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.reconstructed, true)
  assert.equal(truncated.loaded, true)
  assert.match(truncated.note, /截断/)
  const flaggedTruncation = view({ truncated: true })
  assert.equal(flaggedTruncation.truncated, true)
  assert.equal(flaggedTruncation.reconstructed, false)
  assert.equal(view({ hasMore: true }).truncated, true)

  // 历史近似重建：只有裁剪下限在场（未服务节点为 0）⇒ 只记近似重建，不记截断。
  const reconstructed = view({ archiveFloor: 12 })
  assert.equal(reconstructed.reconstructed, true)
  assert.equal(reconstructed.truncated, false)
  assert.equal(reconstructed.loaded, true)
  assert.match(reconstructed.note, /近似重建/)
  assert.equal(view({ fileOpsFloor: 7 }).reconstructed, true)
  assert.equal(view({ reconstructed: true }).reconstructed, true)

  // 不兼容的零值兜底与"读不到"各走各的口径，不并进"没有异常"。
  const zeroed = timelineDetails(readProjection<ContextTimelineStateLike>(snapshotOnly({ contextTimeline: { ok: false, unsupported: { current: '0.69.0', minimum: '0.70.0' } } }), {}, 'contextTimeline'))
  assert.equal(zeroed.zeroed, true)
  assert.equal(zeroed.loaded, false)
  assert.match(zeroed.note, /零值回退不能解释为健康/)
  const missing = timelineDetails(readProjection<ContextTimelineStateLike>(undefined, {}, 'contextTimeline'))
  assert.equal(missing.loaded, false)
  assert.match(missing.note, /missing/)
})

test('readNativeBudget：按 wire 口径折算；缺分母/缺估计一律 unavailable，不按 0 回退（§27.1、§27.2）', () => {
  const read = readNativeBudget(hostWith({ contextPressure: { contextWindow: 1000, pressureTokens: 100, surfaceTokens: 20, sampledSurfaceTokens: 10 } }), 'sess-1')
  assert.equal(read.status, 'ok')
  assert.equal(read.requestEstimateTokens, 110)
  assert.equal(read.contextWindowTokens, 1000)
  assert.equal(read.source, 'projection')
  const noWindow = readNativeBudget(hostWith({ contextPressure: { pressureTokens: 100, surfaceTokens: 20, sampledSurfaceTokens: 20 } }), 'sess-1')
  assert.equal(noWindow.status, 'unavailable')
  assert.equal(noWindow.requestEstimateTokens, 100)
  assert.match(noWindow.note, /缺分母即未知/)
  const meterOnly = readNativeBudget(hostWith({ contextPressure: { contextWindow: 1000, surfaceTokens: 0 } }, 250), 'sess-1')
  assert.equal(meterOnly.status, 'ok')
  assert.equal(meterOnly.source, 'native_meter')
  assert.equal(meterOnly.requestEstimateTokens, 250)
  const nothing = readNativeBudget(hostWith({}), 'sess-1')
  assert.equal(nothing.status, 'unavailable')
  assert.match(nothing.note, /不按 0 回退/)
  // 不兼容零值回退必须是 `incompatible`，不能退化成 `unavailable`（那会被读成"只是缺数据"）或折成 0 压力。
  // 口径依据：`contextPressure` 是宿主 token-meter 自己的投影，它的 state schema
  // （`packages/llm/token-meter/src/usage-projection.ts:96-106`，`.strict()`）只有
  // `contextWindow`/`pressureTokens`/`surfaceTokens`/`sampledSurfaceTokens`/`claim`，既没有 `unsupported`
  // 也没有 `incompatibleVersion`，而且 `contextWindow` 是 positive 约束——低于基线时它给不出"零窗口"，
  // 只能缺字段（那正是上面 `nothing`/`noWindow` 两条钉的 `unavailable` 路径）。
  // 所以本用例钉的不是真机的门槛写法，而是适配层的两条规则：`finishRead` 对同名显式标记
  // `incompatibleVersion === true` 按 `unsupported` 的同一语义采信（`src/adapter/dsh-context.ts` 的
  // `finishRead` + 文件头 line 30-31），以及 `readNativeBudget` 把 `availability === 'incompatible'`
  // 映射成 `status: 'incompatible'`（同一文件 line 641）。门槛记录在真面上的形态由 §27.1 用例 #294
  // 与 `test/acceptance-context.test.ts` 的 V4-09 用 `unsupported{current,minimum}` 钉住。
  const incompatible = readNativeBudget(hostWith({ contextPressure: { incompatibleVersion: true } }), 'sess-1')
  assert.equal(incompatible.status, 'incompatible')
  assert.match(incompatible.note, /零值回退不能解释为健康/)
  const meterDown = readNativeBudget(
    {
      sessionProjections: { stateOf: () => undefined },
      tokenMeter: {
        measure: () => {
          throw new Error('meter down')
        },
      },
    },
    'sess-1',
  )
  assert.equal(meterDown.status, 'unavailable')
})

test('observationFingerprint：同输入同指纹、随 detailRev 变化、投影缺席也非空（§27.3）', () => {
  const states = { contextPressure: { contextWindow: 1000, pressureTokens: 100, surfaceTokens: 20, sampledSurfaceTokens: 10 } }
  const budget = readNativeBudget(hostWith(states), 's')
  // 面上给得出修订/计数面的就是 `detailRev` + `counts` + `last`（`lib/index.d.ts:280-284`）；
  // `contextHeaders` 的 epoch 面只有 `headers[]{seq,systemTokens,tools[]}`（`:30-39`），没有 `requestCount`。
  const timeline = readProjection<ContextTimelineStateLike>(snapshotOnly({ contextTimeline: { ok: true, detailRev: 3, counts: { turns: 2, steps: 3 }, last: { seq: 9, total: 800 }, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [] } }), {}, 'contextTimeline')
  const headers = readProjection<ContextHeadersStateLike>(
    snapshotOnly({ contextHeaders: { headers: [{ seq: 4, time: NOW, systemTokens: 110, tools: [{ name: 'Read', tokens: 30, plugin: 'core' }] }, { seq: 9, time: NOW, systemTokens: 120, tools: [{ name: 'Bash', tokens: 25, plugin: 'core' }] }] } }),
    {},
    'contextHeaders',
  )
  const first = observationFingerprint({ budget, timeline, headers })
  assert.equal(first.length, 16)
  assert.equal(observationFingerprint({ budget, timeline, headers }), first)
  const moved = readProjection<ContextTimelineStateLike>(snapshotOnly({ contextTimeline: { ok: true, detailRev: 4, counts: { turns: 2, steps: 4 }, last: { seq: 12, total: 900 }, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [] } }), {}, 'contextTimeline')
  assert.notEqual(observationFingerprint({ budget, timeline: moved, headers }), first)
  const bare = observationFingerprint({ budget: readNativeBudget(hostWith({}), 's') })
  assert.equal(bare.length, 16)
})

// —— §27.1/§27.2 适配层：信号收集 ——

test('collectContextQuality 正例：投影齐备时产出可直接判定的分量信号，无降级说明', () => {
  const collection = collectContextQuality({
    host: hostWith(fullProjectionStates()),
    session: 'sess-1',
    required: [{ ref: 'obj-1', kind: 'objective', receiptRef: 'rcpt-9', completeness: 'full', acknowledged: true }],
    versionRefs: [{ ref: 'clm-1', kind: 'conclusion', referencedVersion: 2, currentVersion: 2 }],
    nextAction: '继续核对台账',
  })
  assert.deepEqual(collection.degradations, [])
  assert.equal(collection.details.loaded, true)
  // 内联值（`detailRev` 在场但集合非空）既不截断也不近似重建：note 必须是"两侧都在场"的那一句，
  // 而不是任何退化形态说明（§27.1 的四态不许退化成"没有异常"，也不许把健康读数误标成退化）。
  assert.equal(collection.details.split, false)
  assert.equal(collection.details.truncated, false)
  assert.equal(collection.details.reconstructed, false)
  assert.equal(collection.details.note, '轻量头与详情均已加载')
  assert.equal(collection.fingerprint.length, 16)
  const evaluation = evaluateContext(collection.signals, 'semantic')
  // 两条可剪项来自服务清单里重复在场的注入/技能节点（`inject:available-skills`、`skill:pdf-official`
  // 各两份，`lib/index.d.ts:295-297` 说明这两类是 pinned、必定随值服务）；走的是引用路径，原件不删。
  assert.equal(evaluation.problems.prunableBulk.length, 2)
  assert.equal(must('容量分量', evaluation.findings.find((finding) => finding.name === 'capacity')).verdict, 'ok')
  assert.equal(must('行为分量', evaluation.findings.find((finding) => finding.name === 'behavior_regression')).verdict, 'attention')
  const decision = selectAction(evaluation.problems, { tier: 'semantic' })
  assert.equal(decision.action, 'prune')
  // seq=30 那条 5000 token 的工具输出是长输出候选，但 0.70.0 的 `SurfaceNode`（`:439-457`）不给持久副本
  // 也不给调用配对 id：适配层因此一律留空、由 core 按"不可剪"处理（§27.4 不能直接推导栏）——
  // 它只进限制说明，不进问题集合。
  assert.ok(must('相关度分量', evaluation.findings.find((finding) => finding.name === 'relevance_redundancy')).limitNote?.includes('不可剪 1 项'))
  assert.equal(DEFAULT_BULKY_OUTPUT_THRESHOLD, 2000)
})

test('collectContextQuality 反例：dsh-context 缺席时报告覆盖不足，保留原生容量保护，不伪造观测（§27.2）', () => {
  const collection = collectContextQuality({ host: {}, session: 'sess-1', required: [] })
  assert.equal(collection.reads.timeline.availability, 'missing')
  assert.equal(collection.reads.headers.availability, 'missing')
  assert.equal(collection.reads.activity.availability, 'missing')
  assert.ok(collection.degradations.length >= 4)
  assert.ok(collection.signals.capacity.unavailable !== undefined)
  const evaluation = evaluateContext(collection.signals, 'semantic')
  assert.ok(evaluation.problems.unknownComponents.includes('capacity'))
  assert.ok(evaluation.problems.unknownComponents.includes('relevance_redundancy'))
  assert.ok(evaluation.problems.unknownComponents.includes('behavior_regression'))
  const decision = selectAction(evaluation.problems, { tier: 'semantic' })
  assert.equal(decision.action, 'keep')
  assert.ok(decision.notes.some((note) => note.includes('未判定分量')))
})

test('collectContextQuality：只有轻量头时占用类判断降级为未知；近似重建不作裁剪依据', () => {
  // 轻量头（0.70.0 的拆分代次）：`detailRev` 在场而 requests/events/nodes/archive 全是空占位
  // （`lib/index.d.ts:280-297`）；`contextHeaders` 同一批注册但另一张面，只有 epoch 列表（`:37-39`）。
  const lightStates = {
    contextTimeline: { ok: true, detailRev: 4, counts: { turns: 2, steps: 3, injects: 1, compactions: 0, prunes: 0 }, last: { seq: 12, total: 800 }, current: { system: 120, total: 800 }, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [] },
    contextHeaders: { headers: [{ seq: 4, time: NOW, systemTokens: 110, tools: [{ name: 'Read', tokens: 30, plugin: 'core' }] }] },
  }
  const light = collectContextQuality({ host: hostWith(lightStates, 100), session: 's', required: [] })
  assert.ok(light.degradations.some((note) => note.includes('轻量头')))
  assert.equal(light.signals.relevanceRedundancy.unavailable, undefined)
  const lightEvaluation = evaluateContext(light.signals, 'semantic')
  const relevance = must('相关度分量', lightEvaluation.findings.find((finding) => finding.name === 'relevance_redundancy'))
  assert.equal(relevance.verdict, 'unknown')
  assert.match(relevance.signal, /未加载详情/)

  // 近似重建的真实标记：`archiveFloor`（`:305-306`"Newest gone among retention-dropped archive entries"）。
  // 这份清单的重复项与"哪些已经被移除"都数不全，所以它只能作解释、不作裁剪依据（§27.1）。
  const reconstructedStates = {
    contextTimeline: {
      ok: true,
      current: { system: 120, total: 9000 },
      requests: [{ seq: 40, time: NOW, total: 9000 }],
      events: [{ seq: 41, time: NOW, kind: 'prune', tokens: 900 }],
      nodes: [{ seq: 30, time: NOW, cat: 'tool', tokens: 9000, tool: 'Read' }],
      droppedNodes: 0,
      archive: [{ seq: 20, time: NOW - 1000, cat: 'tool', tokens: 900, gone: 41 }],
      archiveFloor: 12,
    },
  }
  const reconstructed = collectContextQuality({ host: hostWith(reconstructedStates, 100), session: 's', required: [] })
  assert.equal(reconstructed.details.reconstructed, true)
  assert.match(reconstructed.signals.relevanceRedundancy.unavailable ?? '', /近似重建/)
  const reconstructedEvaluation = evaluateContext(reconstructed.signals, 'semantic')
  assert.deepEqual(reconstructedEvaluation.problems.prunableBulk, [])
})

test('retainedRefs：只认已加载详情的引用；只有轻量头时返回空清单', () => {
  // 0.70.0 的 `SurfaceNode`（`lib/index.d.ts:439-457`）与 `ContextEventRecord`（`:487-505`）身份只有 `seq`，
  // 面上没有 `ref`/`id`：保留清单里的引用因此是 `node:<seq>` / `archive:<seq>` / `event:<seq>`，
  // 任务侧要对照的引用由调用方自己映射（适配层不代造稳定引用）。
  const detailed = readProjection<ContextTimelineStateLike>(
    snapshotOnly({
      contextTimeline: {
        ok: true,
        current: { total: 520 },
        requests: [{ seq: 40, time: NOW, total: 520 }],
        events: [{ seq: 3, time: NOW, kind: 'inject', tokens: 20 }],
        nodes: [{ seq: 2, time: NOW, cat: 'tool', tokens: 500 }, { seq: 1, time: NOW, cat: 'user', tokens: 20 }],
        droppedNodes: 0,
        archive: [{ seq: 4, time: NOW, cat: 'tool', tokens: 90, gone: 3 }],
      },
    }),
    {},
    'contextTimeline',
  )
  assert.deepEqual(retainedRefs(detailed), ['archive:4', 'event:3', 'node:1', 'node:2'])
  // 只有轻量头时详情是空占位：不能把"清单里没有"写成"没有保留项"，一律返回空清单由调用方按未知处理。
  const light = readProjection<ContextTimelineStateLike>(snapshotOnly({ contextTimeline: { ok: true, detailRev: 3, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [] } }), {}, 'contextTimeline')
  assert.deepEqual(retainedRefs(light), [])
})

// —— §27.5 第 3、4 条：压缩调用与核对 ——

test('invokeCompaction：非 run_now 不调用，没有入口也不假装压缩（§27.5 第 3 条）', async () => {
  const rig = crew()
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'semantic'))
  const freeze: AssessmentFreeze = { ...recorded.assessment, retentionList: ['ev-1'] }
  const queued = await invokeCompaction({ plan: { kind: 'queue', reason: '会话活跃先排队' }, freeze, session: 'sess-1' })
  assert.equal(queued.called, false)
  assert.equal(queued.status, 'not_run')
  assert.equal(queued.immediateOutcome?.kind, 'declined')
  assert.deepEqual(queued.verifyRefs, ['ev-1'])
  const noPort = await invokeCompaction({ plan: { kind: 'run_now', reason: 'idle 入口空闲' }, freeze, session: 'sess-1' })
  assert.equal(noPort.called, false)
  assert.match(noPort.immediateOutcome?.kind === 'declined' ? noPort.immediateOutcome.detail : '', /不假装已压缩/)
  assert.deepEqual(noPort.verifyRefs, ['ev-1'])
})

test('invokeCompaction：completed 只代表调用返回，busy/changed/refused/抛错各走各的即时结论（§27.5 第 3、4 条）', async () => {
  const rig = crew()
  const signals = baseSignals({ context: { historyBloat: { bloated: true, safeSummaryRange: '旧摘要可合并' } } })
  const recorded = recordOk(rig.state, draftFor(rig.state, signals, 'semantic'))
  const freeze: AssessmentFreeze = { ...recorded.assessment, retentionList: ['ev-1'] }
  const runNow = planActionRun(recorded.assessment, { entry: 'idle_maintenance', sessionActive: false, maintenanceEntryFree: true, calibrationAcknowledged: true })
  assert.equal(recorded.assessment.suggestion, 'compact')
  assert.equal(runNow.kind, 'run_now')
  const completed = await invokeCompaction({
    plan: runNow,
    freeze,
    session: 'sess-1',
    compaction: { compactNow: async () => ({ status: 'completed', detail: '原生压缩完成', reclaimedTokens: 9000 }) },
  })
  assert.equal(completed.called, true)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.immediateOutcome, undefined)
  assert.deepEqual(completed.verifyRefs, ['ev-1'])
  assert.match(completed.verifyHint, /逐项核对/)
  for (const status of ['busy', 'changed'] as const) {
    const result = await invokeCompaction({ plan: runNow, freeze, session: 'sess-1', compaction: { compactNow: async () => ({ status, detail: '原生状态未就绪' }) } })
    assert.equal(result.immediateOutcome?.kind, 'busy')
    const outcome = result.immediateOutcome
    assert.equal(outcome?.kind === 'busy' ? outcome.detail : '', `${status}：原生状态未就绪`)
  }
  const refused = await invokeCompaction({ plan: runNow, freeze, session: 'sess-1', compaction: { compactNow: async () => ({ status: 'refused', detail: '部署禁用压缩' }) } })
  assert.equal(refused.immediateOutcome?.kind, 'declined')
  const port: CompactionPort = {
    compactNow: async () => {
      throw new Error('入口炸了')
    },
  }
  const errored = await invokeCompaction({ plan: runNow, freeze, session: 'sess-1', compaction: port })
  assert.equal(errored.called, true)
  assert.equal(errored.immediateOutcome?.kind, 'failed')
  assert.match(errored.detail, /入口炸了/)
})

test('outcomeAfterVerification：核对通过才 done，缺项走 shortfall，未调用沿用即时结论（§27.5 第 4、5 条）', () => {
  const rig = crew()
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'semantic'))
  const freeze: AssessmentFreeze = { ...recorded.assessment, retentionList: ['ev-1'] }
  const invocation = {
    called: true,
    status: 'completed' as const,
    detail: '原生压缩完成',
    verifyRefs: ['ev-1'],
    verifyHint: '逐项核对',
  }
  const okReport = verifyPostCompaction(freeze, { keptRefs: ['ev-1'], capacityAfter: { requestEstimateTokens: 100, contextWindowTokens: 1000 }, current: freeze })
  const done = outcomeAfterVerification(invocation, okReport)
  assert.equal(done.kind, 'done')
  assert.equal(done.kind === 'done' ? done.effect?.restoredInfo : false, true)
  assert.match(done.kind === 'done' ? done.effect?.costNote ?? '' : '', /压缩后核对通过/)
  const shortReport = verifyPostCompaction(freeze, { keptRefs: [], capacityAfter: { requestEstimateTokens: 100, contextWindowTokens: 1000 }, current: freeze })
  const shortfall = outcomeAfterVerification(invocation, shortReport)
  assert.equal(shortfall.kind, 'shortfall')
  assert.ok(shortfall.kind === 'shortfall' && shortfall.missing.some((item) => item.includes('ev-1')))
  const notRun = outcomeAfterVerification({ called: false, status: 'not_run', detail: '未调用', immediateOutcome: { kind: 'declined', detail: '会话活跃先排队' }, verifyRefs: ['ev-1'], verifyHint: '未调用' }, okReport)
  assert.equal(notRun.kind, 'declined')
})

test('probeDshContext：结构面只给 missing/partial，语义一致留给 liveCheck（§27.1）', () => {
  const missing = probeDshContext({})
  assert.equal(missing.id, 'dsh-context-projections')
  assert.equal(missing.shape, 'missing')
  const partial = probeDshContext(hostWith({}))
  assert.equal(partial.shape, 'partial')
  for (const result of [missing, partial]) {
    assert.ok(result.evidence.includes('0.70.0'))
    assert.match(result.liveCheck, /未加载 \/ 截断 \/ 近似重建 \/ 真实空集合/)
    assert.match(result.degrade, /不用零值回退当健康/)
    assert.notEqual(result.shape, 'ok')
  }
})

// —— 端到端：观测→判定→记录→排队/开跑→调用→核对→收口 ——

test('端到端：一次完整闭环在 commit 链上收口为 done（§27.2、§27.5）', async () => {
  const rig = withClaimedTask()
  const collection = collectContextQuality({
    host: hostWith(fullProjectionStates()),
    session: 'sess-1',
    required: [{ ref: 'obj-1', kind: 'objective', receiptRef: 'rcpt-9', completeness: 'full', acknowledged: true }],
    versionRefs: [{ ref: 'clm-1', kind: 'conclusion', referencedVersion: 2, currentVersion: 2 }],
    nextAction: '继续核对台账',
  })
  const freeze: AssessmentFreeze = { ...freezeFor(rig.state, collection.fingerprint), retentionList: [rig.taskId] }
  const recorded = expectAssessmentOk(assessContext(rig.state, { actorId: 'lead-1', freeze, signals: collection.signals, tier: 'semantic' }, NOW + 1), '评估')
  const id = recorded.assessment.assessmentId
  assert.equal(recorded.assessment.suggestion, 'prune')

  const busy: ActionRunContext = { entry: 'idle_maintenance', sessionActive: true, maintenanceEntryFree: true, calibrationAcknowledged: true }
  const queuePlan = planActionRun(recorded.assessment, busy)
  assert.equal(queuePlan.kind, 'queue')
  const queued = expectTransitionOk(applyRunPlan(recorded.state, id, queuePlan, NOW + 2), '排队')
  const runPlan = planActionRun(recorded.assessment, { entry: 'idle_maintenance', sessionActive: false, maintenanceEntryFree: true, calibrationAcknowledged: true })
  assert.equal(runPlan.kind, 'run_now')
  const running = expectTransitionOk(applyRunPlan(queued.state, id, runPlan, NOW + 3), '开跑')

  const invocation = await invokeCompaction({
    plan: runPlan,
    freeze,
    session: 'sess-1',
    compaction: { compactNow: async () => ({ status: 'completed', detail: '原生压缩完成', reclaimedTokens: 9000 }) },
  })
  assert.equal(invocation.status, 'completed')
  const report = verifyPostCompaction(freeze, { keptRefs: [rig.taskId], capacityAfter: { requestEstimateTokens: 200, contextWindowTokens: 1000 }, current: freeze })
  assert.equal(report.ok, true)
  const done = expectTransitionOk(applyActionOutcome(running.state, id, outcomeAfterVerification(invocation, report), NOW + 4), '收口')
  assert.equal(done.assessment.actionState, 'done')
  assert.match(done.assessment.actionNote ?? '', /核对通过/)
  assert.equal(must('落盘记录', done.state.assessments[id]).actionState, 'done')
  assert.equal(must('事件', done.state.events.at(-1)).kind, 'context/assessment-action')
  assert.equal(validateAssessment(must('落盘记录', done.state.assessments[id])).ok, true)
})
