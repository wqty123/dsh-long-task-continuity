/**
 * 设计稿 v0.5 §29.1 验收电池（V4-07 … V4-12），上下文与轮换串行侧。
 *
 * 每条 V 编号一个 test()：先钉"拦错侧"（坏形态必须被标未知/被拦下/不得抢跑），
 * 再钉"放行侧"（按预期处理完成后允许继续）。断言一律走模块函数与返回结构：
 * 信号 → evaluate/selectAction/planActionRun/transitionAction；
 * 观测 → `adapter/dsh-context.ts`（split head、缺详情、不兼容零值）；
 * 线口径 → `rotation/lines.ts`；串行协调与版本复核 → `rotation/policy.ts` / `rotation/fsm.ts`。
 * 夹具只搭状态与信号，判定由被验模块自己做（不从测试里代算结论）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { HostSlice, ProjectionRegistryLike } from '../src/adapter/host-types.ts'
import type { CompactionInvocation, ProjectionValueSourceLike } from '../src/adapter/dsh-context.ts'
import {
  collectContextQuality,
  invokeCompaction,
  outcomeAfterVerification,
  readDshContext,
  readNativeBudget,
  timelineDetails,
} from '../src/adapter/dsh-context.ts'
import { dispatch } from '../src/core/commands.ts'
import type { MissionControl } from '../src/core/control.ts'
import type { ActionRunContext, ActionState, ActionTransition, AssessmentDraft, AssessmentFreeze, CheckTier, ContextEvaluation, CoverageItem, QualitySignals } from '../src/core/context-quality.ts'
import {
  ACTION_MATRIX,
  NATIVE_FALLBACK_MARK,
  applyActionOutcome,
  compactionPreflight,
  evaluateCapacity,
  evaluateContext,
  freezeFrame,
  invalidateAssessment,
  isNativeFallback,
  planActionRun,
  planChecks,
  recordAssessment,
  selectAction,
  transitionAction,
  verifyPostCompaction,
} from '../src/core/context-quality.ts'
import type { ContextAssessment } from '../src/core/entities.ts'
import { reverifyHandoffPackage } from '../src/rotation/fsm.ts'
import type { WindowInput } from '../src/rotation/lines.ts'
import { readOccupancy, rotationLine } from '../src/rotation/lines.ts'
import type { RotationGateInput } from '../src/rotation/policy.ts'
import { AWAIT_BRIEF_RECOMPUTE, DEFAULT_GUARD_CONFIG, decideRotation, initialGuardState } from '../src/rotation/policy.ts'
import { NOW, apply, checkpointPayload, ctx, req, withClaimedTask } from './fixtures.ts'

// —— 夹具（只搭状态与信号，不放判定；口径与 v05-context-quality.test.ts 一致） ——

/** 缺省信号：容量 10%（健康档）、清单/引用为空（未知）、无结构化矛盾——分量判定按各自缺口展开。 */
function baseSignals(overrides: {
  readonly capacity?: QualitySignals['capacity']
  readonly coverage?: QualitySignals['coverage']
  readonly freshness?: QualitySignals['freshness']
  readonly consistency?: QualitySignals['consistency']
  readonly relevanceRedundancy?: QualitySignals['relevanceRedundancy']
  readonly continuity?: QualitySignals['continuity']
  readonly behaviorRegression?: QualitySignals['behaviorRegression']
  readonly context?: QualitySignals['context']
} = {}): QualitySignals {
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

function freezeFor(state: MissionControl, fingerprint: string): AssessmentFreeze {
  return freezeFrame(state, { requestFingerprint: fingerprint, sessionId: 'sess-1', sessionRevision: 1, criteriaRevision: 1, retentionList: [] })
}

interface DraftBundle {
  readonly draft: AssessmentDraft
  readonly evaluation: ContextEvaluation
  readonly decision: ReturnType<typeof selectAction>
}

function draftFor(state: MissionControl, signals: QualitySignals, tier: CheckTier, fingerprint = 'fp-acc-1'): DraftBundle {
  const evaluation = evaluateContext(signals, tier)
  const decision = selectAction(evaluation.problems, { tier })
  const draft: AssessmentDraft = { actorId: 'lead-1', freeze: freezeFor(state, fingerprint), evaluation, decision, tier }
  return { draft, evaluation, decision }
}

function recordOk(state: MissionControl, bundle: DraftBundle, now = NOW + 1): { state: MissionControl; assessment: ContextAssessment } {
  const outcome = recordAssessment(state, bundle.draft, now)
  if (!outcome.ok) throw new Error(`夹具：评估应被接受，却被拒（${outcome.reason}）`)
  return { state: outcome.state, assessment: outcome.assessment }
}

function stepOk(state: MissionControl, assessmentId: string, to: ActionState, note = '测试迁移', now = NOW + 2): { state: MissionControl; assessment: ContextAssessment } {
  const moved = transitionAction(state, assessmentId, to, note, now)
  if (!moved.ok) throw new Error(`夹具：迁移到 ${to} 应合法，却被拒（${moved.reason}）`)
  return { state: moved.state, assessment: moved.assessment }
}

function expectTransitionOk(moved: ActionTransition, label: string): Extract<ActionTransition, { readonly ok: true }> {
  if (!moved.ok) throw new Error(`${label}：迁移应合法，却被拒（${moved.reason}）`)
  return moved
}

function expectTransitionRejected(moved: ActionTransition, label: string): string {
  if (moved.ok) throw new Error(`${label}：非法迁移应被拒，状态却到了 ${moved.assessment.actionState ?? 'recorded'}`)
  return moved.reason
}

type HostStub = Pick<HostSlice, 'sessionProjections' | 'tokenMeter'>

/**
 * 桩注册表：两个读取面都给（口径与 v05-context-quality.test.ts 的 `registryWith` 一致）。
 *
 * `snapshot()` 是 0.70.0 的**投影响应值**公开面（`packages/session/session-projection/src/index.ts:338`），
 * 值面就是 `<DSH_HOME>\profiles\web\node_modules\dsh-context\lib\index.d.ts` 的 `Snapshot`（`:244-312`）/
 * `HeadersState`（`:37-39`）/ `ActivityState`（`:7-18`）；`stateOf()` 给的是 fold state（另一张面，
 * `src/host/foldState.ts:21-63`）。适配层优先读值面（`src/adapter/dsh-context.ts:390-410`），
 * 而轻量头（slim head）只在值面上成立（`via === 'state'` 的 fold state 本来就是全集，
 * `src/adapter/dsh-context.ts:508-514`），所以 V4-09/V4-10 的投影夹具一律走值面。
 */
function registryWith(states: Readonly<Record<string, unknown>>): ProjectionRegistryLike & ProjectionValueSourceLike {
  return {
    snapshot: (_session: unknown, _keys?: readonly string[]) => ({ values: states }),
    stateOf: (_session: unknown, name: string) => states[name],
  }
}

/** 宿主投影桩：按投影名回值，可选给 tokenMeter 一个总量读数。 */
function hostWith(states: Readonly<Record<string, unknown>>, measured?: number): HostStub {
  const registry = registryWith(states)
  return measured === undefined ? { sessionProjections: registry } : { sessionProjections: registry, tokenMeter: { measure: () => ({ totalTokens: measured }) } }
}

/**
 * 0.70.0 的 `Snapshot` 轻量头（slim head）：`detailRev` 是拆分代次头部字段
 * （`lib/index.d.ts:280-284`"present exactly when the host serves the slim head"），
 * `requests`/`events`/`nodes`/`archive`/`droppedNodes` 一律是**空占位**（`:285-302`
 * "The slim head serves these EMPTY"），详情走 `/api/dsh-context/detail` 按需通道。
 * 面上没有 `loaded`/`heads` 这两项：是否加载由适配层的 `availability` 表达。
 */
function slimHeadTimeline(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ok: true,
    model: 'deepseek-chat',
    provider: 'deepseek',
    contextWindow: 100_000,
    maxOutputTokens: 20_000,
    current: { system: 1_100, tools: 900, user: 3_000, inject: 1_800, skill: 600, assistant: 2_400, tool: 10_200, total: 20_000 },
    counts: { turns: 12, steps: 30, injects: 9, compactions: 1, prunes: 2, skills: 3 },
    last: { seq: 88, total: 20_000, prompt: 19_000 },
    detailRev: 4,
    requests: [],
    events: [],
    nodes: [],
    archive: [],
    droppedNodes: 0,
    ...overrides,
  }
}

/** 内联值（缓存行把全集带回来的那一侧）：`detailRev` 仍在场，但四个集合非空 ⇒ 不是 slim head。 */
function inlineTimeline(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return slimHeadTimeline({
    detailRev: 9,
    requests: [
      { turn: 1, step: 1, time: NOW, seq: 87, system: 1_100, tools: 900, user: 3_000, inject: 1_800, assistant: 2_400, tool: 9_000, total: 18_200, prompt: 17_000, cacheRead: 12_000, output: 1_200 },
      { turn: 2, step: 1, time: NOW + 1_000, seq: 88, system: 1_100, tools: 900, user: 3_000, inject: 1_800, assistant: 2_400, tool: 10_200, total: 20_000, prompt: 19_000, cacheRead: 14_000, output: 1_000 },
    ],
    events: [{ seq: 88, time: NOW + 1_000, kind: 'compaction', form: 'auto', tokens: 9_000, count: 6, turn: 2, step: 1 }],
    // `SurfaceNode`（`lib/index.d.ts:439-457`）只给 `seq`/`time`/`cat`/`tokens`/`tool`/`name`/`skill`/`gone` 等，
    // 没有持久副本与工具调用配对 ⇒ 长输出候选按不可剪处理（§27.4），但"详情已内联"这一判据成立。
    nodes: [
      { seq: 60, time: NOW, cat: 'tool', tokens: 9_000, tool: 'Read', err: false },
      { seq: 61, time: NOW + 500, cat: 'inject', tokens: 1_800, name: 'available-skills' },
    ],
    archive: [{ seq: 20, time: NOW - 1_000, cat: 'tool', tokens: 800, gone: 41, tool: 'Bash' }],
    ...overrides,
  })
}

/** `HeadersState`（`lib/index.d.ts:37-39`）：**只有** epoch 列表；没有窗口、也没有任何压缩预留。 */
function headerStates(systemTokens: number): Record<string, unknown> {
  return {
    headers: [
      { seq: 12, time: NOW - 2_000, systemTokens, tools: [{ name: 'Read', tokens: 320, plugin: 'core' }, { name: 'Bash', tokens: 260, plugin: 'core' }] },
      { seq: 41, time: NOW, systemTokens, tools: [{ name: 'Read', tokens: 320, plugin: 'core' }, { name: 'TodoWrite', tokens: 320, plugin: 'core' }] },
    ],
  }
}

/** `ActivityState`（`lib/index.d.ts:7-18`）：按本地日键的用量台账；面上没有在途项与待交接项。 */
function activityStates(): Record<string, unknown> {
  return {
    // 两日各载入一个不同的 skill（`ActivityDay.skills`，`:195-199`）：放行侧不应从用量台账里推出
    // "复读已做工作"的线索——重复载入次数按 skill 名跨日累加，同名才算（`src/adapter/dsh-context.ts:1327-1333`）。
    days: {
      '2026-10-14': { tokens: 40_000, requests: 6, skills: { 'pdf-official': { n: 1, last: NOW - 86_400_000 } } },
      '2026-10-15': { tokens: 90_000, requests: 9, skills: { 'docx-official': { n: 1, last: NOW } } },
    },
    model: 'deepseek-chat',
    provider: 'deepseek',
  }
}

// —— V4-07 ——

test('V4-07 低占用却漏掉用户最近纠正：刷新有效条件并核验送达，不先压缩', () => {
  // 拦错侧一：占用仅 10%，但"用户最近纠正"没有送达回执——必须走补取，不得直接压缩/继续。
  const missed = baseSignals({
    capacity: { requestEstimateTokens: 1000, contextWindowTokens: 10000 },
    coverage: { required: [{ ref: '用户纠正 2026-10-14：先跑类型检查', kind: 'rule' }] },
  })
  const missedEval = evaluateContext(missed, 'deterministic')
  assert.equal(missedEval.findings.find((item) => item.name === 'capacity')?.verdict, 'ok', '低占用（10%）时容量判定应为 ok，问题不在容量')
  assert.equal(missedEval.problems.missingKeyConditions.length, 1, '没有送达回执的用户纠正必须记为缺关键条件（漏掉）')
  const missedDecision = selectAction(missedEval.problems, { tier: 'deterministic' })
  assert.equal(missedDecision.action, 'retrieve', '漏掉用户最近纠正时首选动作是补取（retrieve），不是压缩')
  assert.equal(missedDecision.notDerivable, ACTION_MATRIX.retrieve.notDerivable, 'retrieve 行的"不能直接推导"应逐字取自动作矩阵（不得推导"压缩会变好"）')
  assert.ok(missedDecision.reason.includes('关键条件缺失'), `补取理由应点明关键条件缺失，实际：${missedDecision.reason}`)

  // 拦错侧二：旧条件仍被引用（用户纠正改变了当前版本）——走刷新，不得先压缩。
  const stale = baseSignals({
    coverage: { required: [{ ref: '目标：先跑类型检查再提交', kind: 'objective', receiptRef: 'rcpt-u1', completeness: 'full', acknowledged: true }] },
    freshness: { refs: [{ ref: 'objective', kind: 'objective', referencedVersion: 1, currentVersion: 2 }] },
  })
  const staleEval = evaluateContext(stale, 'deterministic')
  assert.equal(staleEval.problems.staleReferences.length, 1, '引用版本落后于用户纠正后的当前版本，必须记为过期引用')
  const staleDecision = selectAction(staleEval.problems, { tier: 'deterministic' })
  assert.equal(staleDecision.action, 'refresh', '有效条件过期时首选动作是刷新（refresh）')
  assert.equal(staleDecision.notDerivable, ACTION_MATRIX.refresh.notDerivable, 'refresh 行的"不能直接推导"应逐字取自动作矩阵')

  // 拦错侧三：即便历史膨胀且给了安全摘要范围（语义层），也不得抢在补取前面压缩。
  const bloatBehind = { ...missed, context: { historyBloat: { bloated: true, safeSummaryRange: '旧摘要可合并' } } }
  const bloatEval = evaluateContext(bloatBehind, 'semantic')
  assert.equal(bloatEval.problems.bloatedWithSafeSummaryRange, true, '语义层下"膨胀 + 安全摘要范围"本可构成压缩问题')
  const bloatDecision = selectAction(bloatEval.problems, { tier: 'semantic' })
  assert.equal(bloatDecision.action, 'retrieve', '缺关键条件优先于压缩：这一轮不先压缩')
  assert.equal(bloatDecision.deferredAction, undefined, 'retrieve 属确定性动作，不该被阶段门延后')

  // 放行侧：刷新有效条件并核验送达（回执 full + 已确认，版本一致）后允许继续，不压缩。
  const repaired = baseSignals({
    capacity: { requestEstimateTokens: 1000, contextWindowTokens: 10000 },
    coverage: { required: [{ ref: '用户纠正 2026-10-14：先跑类型检查', kind: 'rule', receiptRef: 'rcpt-u2', completeness: 'full', acknowledged: true }] },
    freshness: { refs: [{ ref: 'objective', kind: 'objective', referencedVersion: 2, currentVersion: 2 }] },
    context: { progressContinues: true },
  })
  const repairedEval = evaluateContext(repaired, 'deterministic')
  assert.equal(repairedEval.problems.missingKeyConditions.length, 0, '核验送达后不应再有缺关键条件')
  assert.equal(repairedEval.problems.staleReferences.length, 0, '版本刷新一致后不应再有过期引用')
  const repairedDecision = selectAction(repairedEval.problems, { tier: 'deterministic' })
  assert.equal(repairedDecision.action, 'keep', '送达核验通过后允许继续（keep）')
  assert.equal(repairedDecision.notDerivable, ACTION_MATRIX.keep.notDerivable, 'keep 行的"不能直接推导"应逐字取自动作矩阵（不因任意占用比例强制压缩）')
})

// —— V4-08 ——

test('V4-08 上下文较大但关键细节齐全且容量足够：允许继续，不以固定占用比例强制压缩', () => {
  // 拦错侧：占用 85%（提醒档、未到硬档）——只记录 attention，不产出容量压力，更不据此压缩。
  const big = baseSignals({
    capacity: { requestEstimateTokens: 8500, contextWindowTokens: 10000 },
    coverage: { required: [{ ref: 'reports/final.md 关键段', kind: 'evidence', receiptRef: 'rcpt-1', completeness: 'full', acknowledged: true }] },
    freshness: { refs: [{ ref: 'objective', kind: 'objective', referencedVersion: 1, currentVersion: 1 }] },
    context: { progressContinues: true },
  })
  const capacityEval = evaluateCapacity(big.capacity)
  assert.equal(capacityEval.finding.verdict, 'attention', '85% 落在提醒档：只记录 attention，不等于硬档')
  assert.deepEqual(capacityEval.problems, [], '提醒档不得产出 capacity_pressure（占用比例本身不是压缩依据）')
  const bigEval = evaluateContext(big, 'deterministic')
  assert.equal(bigEval.problems.capacityRatio, 0.85, '问题集合里的占用比例应如实为 0.85，供记录使用')
  assert.equal(bigEval.problems.nearHardLimit, false, '85% 未接近硬容量：不构成原生兜底压缩')
  const keepDecision = selectAction(bigEval.problems, { tier: 'deterministic' })
  assert.equal(keepDecision.action, 'keep', '关键细节齐全且容量足够时允许继续（keep）')
  assert.equal(keepDecision.notDerivable, ACTION_MATRIX.keep.notDerivable, 'keep 行的"不能直接推导"应逐字取自动作矩阵（"达到某个任意占用比例就必须压缩"）')

  // 拦错侧补强：即便历史膨胀（没有安全摘要范围），也不按占用比例自行压缩。
  const bloated = { ...big, context: { historyBloat: { bloated: true } } }
  const bloatedDecision = selectAction(evaluateContext(bloated, 'semantic').problems, { tier: 'semantic' })
  assert.equal(bloatedDecision.action, 'keep', '没有可判定的安全摘要范围时只记录，不因占用比例压缩')
  assert.ok(bloatedDecision.reason.includes('不因占用比例自行压缩'), `keep 理由应写明不因占用比例自行压缩，实际：${bloatedDecision.reason}`)

  // 对照（原生的那一侧）：只有接近硬容量才走原生兜底压缩，与被修订的"固定比例"无关。
  const nearHard = evaluateContext(baseSignals({ capacity: { requestEstimateTokens: 9200, contextWindowTokens: 10000 } }), 'deterministic')
  assert.equal(nearHard.problems.nearHardLimit, true, '92% 接近硬档（0.9）：构成原生兜底前提')
  const fallback = selectAction(nearHard.problems, { tier: 'deterministic' })
  assert.equal(fallback.action, 'compact', '接近硬容量时压缩成立')
  assert.ok(fallback.reason.includes(NATIVE_FALLBACK_MARK), `压缩理由应带原生兜底标记 ${NATIVE_FALLBACK_MARK}，实际：${fallback.reason}`)
  assert.equal(isNativeFallback(fallback), true, '该压缩应被识别为原生兜底，而不是质量判断驱动的压缩')
})

// —— V4-09 ——

test('V4-09 dsh-context 返回 split head/缺详情/不兼容零值：标记未知或补取；不得当作完整健康上下文', () => {
  const required: readonly CoverageItem[] = [{ ref: '用户纠正：先跑类型检查', kind: 'rule' }]

  // 拦错侧一：slim head——拆分代次头部字段在场、四个详情集合都是空占位：占用/冗余类判定必须降级为未知。
  // 判别标记全在真实值面上：`detailRev`（`lib/index.d.ts:280-284`）+ 空集合（`:285-302`"The slim head
  // serves these EMPTY"）；0.70.0 的面上**没有** `loaded`/`heads` 这两项，"是否加载"由适配层的
  // `availability` + `timelineDetails` 表达（`src/adapter/dsh-context.ts:485-527`）。
  const splitHost = hostWith({
    contextTimeline: slimHeadTimeline({}),
    contextPressure: { contextWindow: 100_000, pressureTokens: 20_000 },
  })
  const splitCollection = collectContextQuality({ host: splitHost, session: 'sess-1', required })
  assert.equal(splitCollection.reads.timeline.availability, 'ok', '轻量头是合法读值：形态齐全、值可读，不能读成读取失败')
  assert.equal(splitCollection.reads.timeline.via, 'snapshot', '值面优先：这一条判据只在投影响应值上成立')
  const splitDetails = timelineDetails(splitCollection.reads.timeline)
  assert.equal(splitDetails.split, true, 'detailRev 在场而 requests/events/nodes 全是空占位：判为 slim head')
  assert.equal(splitDetails.loaded, false, '有轻量头但没有 events/nodes/requests 集合：必须判为详情未加载（split head）')
  assert.ok(splitDetails.note.includes('不能把"没有详情"读成"没有事件"'), `详情视图说明必须点明"读不到不等于没有"，实际：${splitDetails.note}`)
  assert.ok(splitCollection.degradations.some((line) => line.includes('时间线只有轻量头')), `降级说明必须如实报告轻量头形态，实际：${splitCollection.degradations.join(' / ')}`)
  assert.notEqual(splitCollection.signals.relevanceRedundancy.detailIncomplete, undefined, '详情未加载时占用/冗余类信号必须标 detailIncomplete，不得读成"没有冗余"')
  const splitEval = evaluateContext(splitCollection.signals, 'semantic')
  assert.equal(splitEval.findings.find((item) => item.name === 'relevance_redundancy')?.verdict, 'unknown', 'split head 下相关性/冗余必须标 unknown，不得当作已判定')
  assert.ok(splitEval.problems.unknownComponents.includes('relevance_redundancy'), '未知分量要如实进入问题集合（unknown ≠ 健康）')
  const splitDecision = selectAction(splitEval.problems, { tier: 'semantic' })
  assert.equal(splitDecision.action, 'retrieve', '缺送达的纠正 + 观测面不完整：首选补取，不得当作完整健康上下文继续')

  // 拦错侧二：不兼容零值——宿主低于上游基线时真实门槛记录是 timeline 值上的 `unsupported{current,minimum}`
  // （`lib/index.d.ts:246-251`），同批三个投影一起换成兜底单元（`src/host/index.ts:55-62`、
  // `src/host/fallback.ts:56-75`），而 `{headers: []}`/`{days: {}}` 与真实空集合在面上**不可区分**，
  // 门槛只写在 timeline 上：适配层据此把同批三项一并标 incompatible（`src/adapter/dsh-context.ts:449-465`）。
  // `contextPressure` 是宿主 token-meter 的自有投影（`packages/llm/token-meter/src/usage-projection.ts:96-106`
  // 的 strict schema 里没有任何门槛字段），它的不兼容写法只能按同名显式标记 `incompatibleVersion` 采信。
  const brokenHost = hostWith({
    contextTimeline: { ok: false, unsupported: { current: '0.69.0', minimum: '0.70.0' } },
    contextHeaders: { headers: [] },
    contextActivity: { days: {} },
    contextPressure: { incompatibleVersion: true, contextWindow: 0, pressureTokens: 0, surfaceTokens: 0, sampledSurfaceTokens: 0 },
  })
  const reads = readDshContext(brokenHost, 'sess-1')
  for (const [name, read] of Object.entries(reads)) {
    assert.equal(read.availability, 'incompatible', `${name} 版本不兼容时必须整项标 incompatible，不能按 0 回退`)
  }
  assert.ok(reads.timeline.note.includes('零值回退不能解释为健康或零压力'), `不兼容读数说明必须写明零值不作健康解释，实际：${reads.timeline.note}`)
  assert.equal(readNativeBudget(brokenHost, 'sess-1').status, 'incompatible', '原生容量读数遇到不兼容投影同样必须标 incompatible')
  const brokenCollection = collectContextQuality({ host: brokenHost, session: 'sess-1', required })
  assert.notEqual(brokenCollection.signals.capacity.unavailable, undefined, '容量观测面不可用时必须标 unavailable，不得回退成 0 占用')
  assert.equal(brokenCollection.details.zeroed, true, '低于基线的零值兜底要单独记 `zeroed`：它与轻量头/截断/近似重建是不同形态（§27.1）')
  assert.equal(brokenCollection.details.split, false, '零值兜底不是 slim head：不能因为集合是空数组就判成"只有轻量头"')
  assert.ok(brokenCollection.degradations.length >= 4, `三个投影 + 原生容量都不可用应至少 4 条降级说明，实际 ${brokenCollection.degradations.length} 条`)
  const brokenEval = evaluateContext(brokenCollection.signals, 'deterministic')
  assert.equal(brokenEval.findings.find((item) => item.name === 'capacity')?.verdict, 'unknown', '不兼容零值不得当作健康：capacity 必须 unknown')
  assert.ok(brokenEval.problems.unknownComponents.includes('capacity'), '未判定的容量分量必须进 unknownComponents')
  const brokenDecision = selectAction(brokenEval.problems, { tier: 'deterministic' })
  assert.equal(brokenDecision.action, 'retrieve', '观测面不可用且有缺送达条件：先补取，不得宣布健康')
  assert.ok(brokenDecision.notes.some((line) => line.includes('unknown 不等于健康')), `notes 必须写明 unknown 不等于健康，实际：${brokenDecision.notes.join(' / ')}`)

  // 拦错侧三：兼容但分母为零的读数同样不可用（缺分母即未知，不按 0% 回退）。
  const zeroDenominator = readNativeBudget(hostWith({ contextPressure: { contextWindow: 0, pressureTokens: 0 } }), 'sess-1')
  assert.equal(zeroDenominator.status, 'unavailable', '窗口为 0 的兼容读数同样不可用（缺分母即未知）')
  assert.ok(zeroDenominator.note.includes('不按 0 或健康回退'), `不可用说明必须点明不按 0 或健康回退，实际：${zeroDenominator.note}`)

  // 放行侧：补取详情并核验送达（详情随值内联 + 回执 full + 已确认）后，各分量恢复可判定并允许继续。
  // 内联值那一侧的判据同样是真实字段：`detailRev` 仍在场（缓存行也带拆分代次），但
  // `requests`/`events`/`nodes`/`archive` 非空、`droppedNodes: 0` 且三个裁剪下限都不在场
  // （`lib/index.d.ts:285-309`）⇒ 不是轻量头、没被截断、也不是近似重建。
  const fixedHost = hostWith({
    contextTimeline: inlineTimeline(),
    contextHeaders: headerStates(1_100),
    contextActivity: activityStates(),
    contextPressure: { contextWindow: 100_000, pressureTokens: 20_000 },
  })
  const fixedRequired: readonly CoverageItem[] = [{ ref: '用户纠正：先跑类型检查', kind: 'rule', receiptRef: 'rcpt-u1', completeness: 'full', acknowledged: true }]
  const fixedCollection = collectContextQuality({ host: fixedHost, session: 'sess-1', required: fixedRequired })
  assert.equal(fixedCollection.details.loaded, true, '补取详情后 split head 形态解除')
  assert.equal(fixedCollection.details.truncated, false, 'droppedNodes 为 0：这一份读数没有被截断')
  assert.equal(fixedCollection.details.reconstructed, false, 'surfaceFloor/archiveFloor/fileOpsFloor 三个裁剪下限都不在场：历史段落不是近似重建')
  assert.equal(fixedCollection.details.note, '轻量头与详情均已加载', '全集内联时说明必须如实写"都已加载"，不得留一条含糊的降级口径')
  const fixedEval = evaluateContext(fixedCollection.signals, 'semantic')
  assert.equal(fixedEval.findings.find((item) => item.name === 'relevance_redundancy')?.verdict, 'ok', '详情加载且无可剪候选时相关性/冗余不再标未知')
  assert.equal(fixedEval.problems.missingKeyConditions.length, 0, '送达回执齐备后不应再有缺关键条件')
  const fixedDecision = selectAction(fixedEval.problems, { tier: 'semantic' })
  assert.equal(fixedDecision.action, 'keep', '补取详情并核验送达后允许继续（keep）')
})

// —— V4-10 ——

test('V4-10 UI 默认压缩预留与部署配置不同：采用实际请求预算；取不到时停止质量自动动作、保留原生保护', () => {
  const windowTokens = 100_000
  const uiMirrorDefault = 25_000 // 界面镜像的原生默认压缩预留
  const deployed: WindowInput = { contextWindow: windowTokens, outputReserve: 20_000, compactionHeadroom: 8_000, compactionRatio: 0.8, handoffMargin: 8_000, rotateRatio: 0.65 }

  // 拦错侧：轮换线必须用部署实际值算 C，不得拿 UI 镜像的默认预留替换。
  const line = rotationLine(deployed)
  if (line.mode !== 'active') throw new Error(`部署声明齐备时轮换线应为 active，实际 ${line.mode}：${line.reason ?? ''}`)
  assert.equal(line.C, 72_000, 'C 必须用部署实际值算：min(0.8×W, W−R−H)=min(80000, 72000)')
  assert.notEqual(line.C, windowTokens - 20_000 - uiMirrorDefault, '不得用界面镜像的默认预留（25000）替换部署配置值')

  // 容量侧：0.70.0 的 `contextHeaders` 值面**只有** epoch 列表（`lib/index.d.ts:37-39`），既没有
  // `contextWindow` 也没有任何压缩预留——设计稿阶段猜的 `reservedForCompaction`/`requestCount` 已被源码否证，
  // 所以界面镜像的默认预留（25000）在这条读取路径上根本进不来。预留的分类只能落在真实字段上：
  // 优先操作者声明 > 宿主直读 requestHeader 的 config.maxTokens > `contextTimeline.maxOutputTokens`
  // （`lib/index.d.ts:257`、`src/host/fold.ts:317-324`；优先级链见 `src/adapter/dsh-context.ts:548-568`），
  // 三个都取不到即 `null` ⇒ 轮换线停在 observation，不猜。执行阈值另取实际请求预算（原生读数）。
  const host = hostWith({
    contextTimeline: inlineTimeline({ maxOutputTokens: 20_000, contextWindow: windowTokens }),
    contextHeaders: headerStates(1_100),
    contextActivity: activityStates(),
    contextPressure: { contextWindow: windowTokens, pressureTokens: 30_000, surfaceTokens: 5_000, sampledSurfaceTokens: 0 },
  })
  const budget = readNativeBudget(host, 'sess-1')
  assert.equal(budget.status, 'ok', '原生请求压力可读时应给出 ok 读数')
  assert.equal(budget.requestEstimateTokens, 35_000, '实际请求预算按 wire 口径折算：30000+5000−0')
  const collection = collectContextQuality({ host, session: 'sess-1', required: [] })
  assert.equal(collection.reads.headers.availability, 'ok', '真实 HeadersState 形态可读：它是 epoch 列表，不是预留来源')
  assert.equal(collection.signals.capacity.requestEstimateTokens, 35_000, '容量信号必须取实际请求预算（35000），与 UI 预留值无关')
  assert.equal(collection.signals.capacity.contextWindowTokens, windowTokens, '容量分母取实际路由窗口')
  assert.equal(collection.readings.outputReserve?.value, 20_000, '输出预留 R 取真实字段（maxOutputTokens），不是界面镜像默认值')
  assert.equal(collection.readings.outputReserve?.provenance, 'dsh-context:contextTimeline', 'R 的出处要如实标注：这一份是投影读来的，不是操作者声明也不是宿主直读')
  assert.notEqual(collection.signals.capacity.outputReserveTokens, uiMirrorDefault, '界面镜像默认预留（25000）不得进入容量信号')
  assert.ok((collection.signals.capacity.caveats ?? []).some((line) => line.includes('界面值只作解释，不作执行阈值')), '容量 caveat 必须写明 dsh-context 界面值不作执行阈值')
  const keepEval = evaluateContext(collection.signals, 'deterministic')
  assert.equal(keepEval.findings.find((item) => item.name === 'capacity')?.verdict, 'ok', '35% 按实际请求预算判为容量正常（放行侧）')

  // 取不到部署实际值（0=未声明）⇒ observation：不给 C/T 数字，自动侧停。
  const undeclared = rotationLine({ ...deployed, compactionHeadroom: 0 })
  if (undeclared.mode !== 'observation') throw new Error(`compactionHeadroom 未声明时应停在 observation，实际 ${undeclared.mode}`)
  assert.equal(undeclared.C, null, '观察模式不给 C：避免被当成阈值用')
  assert.equal(undeclared.T, null, '观察模式不给 T')
  assert.ok(undeclared.reason.includes('compactionHeadroom 不可得'), `观察原因应点明取不到哪一项，实际：${undeclared.reason}`)

  // 质量侧取不到实际预算（缺分母）：标未知、不产出压缩建议，不得回退成"0 压力"。
  const noWindowHost = hostWith({ contextPressure: { pressureTokens: 30_000 } })
  assert.equal(readNativeBudget(noWindowHost, 'sess-1').status, 'unavailable', '缺分母 ⇒ 不可用（unknown），不得按 0 或健康回退')
  const noWindowEval = evaluateContext(collectContextQuality({ host: noWindowHost, session: 'sess-1', required: [] }).signals, 'deterministic')
  assert.equal(noWindowEval.findings.find((item) => item.name === 'capacity')?.verdict, 'unknown', '取不到预算时容量必须标 unknown，不得当作 0 压力')
  const noWindowDecision = selectAction(noWindowEval.problems, { tier: 'deterministic' })
  assert.equal(noWindowDecision.action, 'keep', '取不到实际预算时停止质量自动动作：不当场压缩/轮换')
  assert.ok(noWindowDecision.notes.some((line) => line.includes('也不禁用原生容量保护')), `notes 必须保留原生容量保护口径，实际：${noWindowDecision.notes.join(' / ')}`)

  // 放行侧（原生保护仍在）：可读到的接近硬容量读数照走原生兜底，冷却与质量数据缺席都不阻止。
  assert.equal(planChecks('admission', { nearHardLimit: true }).nativeFallbackPriority, true, '接近硬容量时原生兜底优先，冷却不阻止（§27.4 末段）')
  const hardEval = evaluateContext(baseSignals({ capacity: { requestEstimateTokens: 9500, contextWindowTokens: 10_000 } }), 'deterministic')
  const hardDecision = selectAction(hardEval.problems, { tier: 'deterministic' })
  assert.equal(hardDecision.action, 'compact', '实际读数接近硬容量时原生兜底压缩照常成立')
  assert.ok(hardDecision.reason.includes(NATIVE_FALLBACK_MARK), `原生兜底理由应带 ${NATIVE_FALLBACK_MARK} 标记，实际：${hardDecision.reason}`)
})

// —— V4-11 ——

test('V4-11 自动压缩与轮换同时到达：同一 Actor 串行协调、版本复核；不重复创建会话或压缩', async () => {
  const rig = withClaimedTask()
  const idle: ActionRunContext = { entry: 'idle_maintenance', sessionActive: false, maintenanceEntryFree: true }

  // 自动压缩已在案（接近硬容量的原生兜底）。
  const fallback = recordOk(rig.state, draftFor(rig.state, baseSignals({ capacity: { requestEstimateTokens: 9500, contextWindowTokens: 10_000 } }), 'deterministic'))
  assert.equal(fallback.assessment.suggestion, 'compact', '接近硬容量：压缩建议成立')

  // 拦错侧：轮换同时到达——互斥入口被占用 / 轮换在途，压缩只能排队，不得并发。
  const entryBusy = planActionRun(fallback.assessment, { ...idle, maintenanceEntryFree: false })
  assert.equal(entryBusy.kind, 'queue', '压缩与轮换共享互斥入口：被占用时必须排队')
  assert.ok(entryBusy.reason.includes('共享互斥入口'), `排队理由应点明共享互斥入口，实际：${entryBusy.reason}`)
  const rotationAhead = planActionRun(fallback.assessment, { ...idle, rotationPending: true })
  assert.equal(rotationAhead.kind, 'queue', '轮换在途时压缩排队，不并发')
  assert.ok(rotationAhead.reason.includes('轮换在途'), `排队理由应点明轮换在途，实际：${rotationAhead.reason}`)
  // 放行侧：互斥入口空闲、会话 idle 时才 run_now。
  assert.equal(planActionRun(fallback.assessment, idle).kind, 'run_now', '互斥入口空闲且会话 idle 时压缩方可开跑')

  // 版本复核：记录之后目标被修订 ⇒ 旧评估不许进 running（先重新检查）。
  const revised = apply(fallback.state, { kind: 'mission.revise', requestId: req() }, ctx('supervisor'))
  assert.match(expectTransitionRejected(transitionAction(revised, fallback.assessment.assessmentId, 'running', '直接开跑', NOW + 3), '目标修订后开跑'), /执行前版本核对失败/, '版本核对失败必须拦在 running 之前')

  // 不重复压缩：已开跑的动作不再被调度；重复迁移被拒；非 run_now 不调用压缩入口。
  const queued = stepOk(fallback.state, fallback.assessment.assessmentId, 'queued', '队列等 idle')
  const running = stepOk(queued.state, fallback.assessment.assessmentId, 'running', 'idle 入口空闲开跑')
  assert.match(planActionRun(running.assessment, idle).reason, /不再调度/, '已在执行的动作不得被再次调度（不重复压缩）')
  assert.match(expectTransitionRejected(transitionAction(running.state, fallback.assessment.assessmentId, 'running', '又开一次', NOW + 4), '重复开跑'), /已经是 running/, '重复开跑必须被拒')
  const notRun = await invokeCompaction({ plan: rotationAhead, freeze: freezeFor(rig.state, 'fp-acc-11'), session: 'sess-1' })
  assert.equal(notRun.called, false, 'plan 不是 run_now：不得调用压缩入口（不重复压缩）')
  assert.equal(notRun.status, 'not_run', '未调用的压缩状态应为 not_run')
  assert.equal(notRun.immediateOutcome?.kind, 'declined', '排队计划给 declined 即时结论，而不是再发一次压缩')

  // 轮换侧：同一 Actor 已有未收束轮换 ⇒ 第二个请求被内核拒绝（不重复创建会话）。
  const checkpointed = apply(rig.state, { kind: 'task.checkpoint', requestId: req(), taskId: rig.taskId, checkpoint: checkpointPayload() }, ctx('lead', 'lead-1'))
  const checkpointId = Object.keys(checkpointed.checkpoints)[0]!
  const first = dispatch(checkpointed, { kind: 'continuity.requestRotation', requestId: req(), actorId: 'lead-1', sourceSessionId: 'sess-1', targetSessionId: 'sess-9', checkpointId, trigger: 'pressure', seedMessageId: 'seed:sess-9' }, ctx('supervisor'))
  assert.equal(first.applied, true, '首个轮换请求应成立')
  assert.equal(Object.values(first.state.rotations).filter((item) => item.actorId === 'lead-1' && item.phase !== 'ACTIVE').length, 1, '同一 Actor 只应有一个未收束轮换')
  const second = dispatch(first.state, { kind: 'continuity.requestRotation', requestId: req(), actorId: 'lead-1', sourceSessionId: 'sess-1', targetSessionId: 'sess-10', checkpointId, trigger: 'pressure', seedMessageId: 'seed:sess-10' }, ctx('supervisor'))
  assert.equal(second.applied, false, '同一 Actor 只允许一个未收束轮换：第二个请求必须被拒（不重复创建会话）')
  assert.equal(Object.values(second.state.rotations).length, 1, '被拒请求不得多出轮换记录（不得多建目标会话）')
  assert.equal(second.state.actors['lead-1']?.sessionId, 'sess-1', '被拒请求不得改换 Actor 绑定')

  // 版本复核（轮换侧）：请求后依据版本推进 ⇒ 旧交接包不得放行。
  const rotation = Object.values(first.state.rotations)[0]!
  assert.equal(reverifyHandoffPackage(rotation, first.state).ready, true, '版本一致时交接包可用（放行侧）')
  const basisMoved = { ...first.state, basisRevision: first.state.basisRevision + 1 }
  const basisVerdict = reverifyHandoffPackage(rotation, basisMoved)
  assert.equal(basisVerdict.ready, false, '依据版本推进后旧交接包不得放行（版本复核）')
  assert.ok(basisVerdict.missing.some((line) => line.includes('依据有效性版本已从请求时')), `重验说明应点明依据版本漂移，实际：${basisVerdict.missing.join(' / ')}`)

  // 串行协调的机器可读判定：轮换在途 / 等待重算时不起新轮换；全部清朗才 rotate。
  const occupancy = readOccupancy({ projectedTokens: 60_000, contextWindow: 100_000 })
  const activeLine = rotationLine({ contextWindow: 100_000, outputReserve: 20_000, compactionHeadroom: 8_000, compactionRatio: 0.8, handoffMargin: 8_000, rotateRatio: 0.5 })
  if (activeLine.mode !== 'active') throw new Error(`夹具轮换线应为 active，实际 ${activeLine.mode}`)
  const gate: RotationGateInput = { occupancy, line: activeLine, guard: initialGuardState(), actorRetired: false, pendingRotation: true, rotationBudgetLeft: true, turnsSinceLastRotation: 9, minTurnsBetweenRotations: 3, autoRotationEnabled: true, atSafeBoundary: true, config: DEFAULT_GUARD_CONFIG }
  const inFlight = decideRotation(gate)
  assert.equal(inFlight.kind, 'none', '轮换在途：本轮不换')
  assert.equal(inFlight.kind === 'none' ? inFlight.reason : '', 'rotation-in-flight', '原因必须是 rotation-in-flight（不重复创建会话）')
  const awaiting = decideRotation({ ...gate, pendingRotation: false, awaitingBriefRecompute: true })
  assert.equal(awaiting.kind, 'observe', '等待重算交接包：观察等待，不是再起一轮')
  assert.equal(awaiting.kind === 'observe' ? awaiting.reason : '', AWAIT_BRIEF_RECOMPUTE, '原因必须是 await-brief-recompute（版本复核未过不换）')
  const go = decideRotation({ ...gate, pendingRotation: false })
  assert.equal(go.kind, 'rotate', '放行侧：无在途轮换、无需重算且到线到边界时允许轮换')
  assert.equal(go.kind === 'rotate' ? go.reason : '', 'pressure-boundary', '放行原因为 pressure-boundary')
})

// —— V4-12 ——

test('V4-12 压缩后丢失失败条件或在途操作：从持久依据重建并验证；不继续依据错误摘要执行', () => {
  // 拦错侧一：压缩前清点——没有可恢复的下一步、在途操作结果不明且无核对路径 ⇒ 不许压缩。
  const rig = withClaimedTask()
  const bare = compactionPreflight(rig.state, [rig.taskId])
  assert.equal(bare.ready, false, '没有持久下一步时压缩前清点必须拦下')
  assert.ok(bare.missing.some((line) => line.includes('没有记录可恢复的下一步')), `缺项说明应点明没有可恢复的下一步，实际：${bare.missing.join(' / ')}`)
  const intent = apply(rig.state, { kind: 'operation.intent', requestId: req(), taskId: rig.taskId, operationKind: 'file_write', target: 'reports/final.md', intent: '写入核对结论', idempotencyKey: req('idem'), retryable: false }, ctx('lead', 'lead-1'))
  const operationId = Object.keys(intent.operations)[0]!
  const unknownOp = apply(intent, { kind: 'operation.reconcile', requestId: req(), operationId, verdict: 'still_unknown' }, ctx('lead', 'lead-1'))
  assert.equal(unknownOp.operations[operationId]!.status, 'outcome_unknown', '夹具：核对结论为 still_unknown 的在途操作状态应为 outcome_unknown')
  const withUnknown = compactionPreflight(unknownOp, [rig.taskId])
  assert.equal(withUnknown.ready, false, '在途操作结果不明且没有核对方法：不许带着缺口压缩')
  assert.ok(withUnknown.missing.some((line) => line.includes('先定核对路径')), `缺项说明应点明先定核对路径，实际：${withUnknown.missing.join(' / ')}`)

  // 拦错侧二：压缩后核对缺项 ⇒ 不得宣称恢复；结论是重建/轮换，不是再压一次。
  const freeze12: AssessmentFreeze = { ...freezeFor(rig.state, 'fp-acc-12'), retentionList: [rig.taskId, 'clm-失败条件'] }
  const shortReport = verifyPostCompaction(freeze12, { keptRefs: [rig.taskId], capacityAfter: { requestEstimateTokens: 200, contextWindowTokens: 1000 }, current: freeze12 })
  assert.equal(shortReport.ok, false, '保留清单缺项：压缩后核对不得通过')
  assert.equal(shortReport.nextStep, 'rebuild_from_authoritative_state', '容量不高时的缺项走"从权威状态重建"')
  assert.ok(shortReport.missing.some((line) => line.includes('保留清单缺项：clm-失败条件')), `缺项应逐项列出丢失的失败条件，实际：${shortReport.missing.join(' / ')}`)
  const invocation: CompactionInvocation = { called: true, status: 'completed', detail: '原生压缩返回 completed', verifyRefs: [...freeze12.retentionList], verifyHint: '调用返回后逐项核对保留清单、引用、容量与版本' }
  const outcome = outcomeAfterVerification(invocation, shortReport)
  assert.equal(outcome.kind, 'shortfall', '核对缺项应给 shortfall，而不是 done')
  // 收口到状态机：failed，并写明从权威状态重建；不继续依据错误摘要执行。
  const recorded = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'semantic'))
  const running = stepOk(recorded.state, recorded.assessment.assessmentId, 'running', '开始压缩')
  const failed = expectTransitionOk(applyActionOutcome(running.state, recorded.assessment.assessmentId, outcome, NOW + 4), '缺项收口')
  assert.equal(failed.assessment.actionState, 'failed', '缺项收口必须落在 failed，不是 done')
  assert.ok((failed.assessment.actionNote ?? '').includes('从权威状态重建任务上下文'), `收口说明应写明从权威状态重建，实际：${failed.assessment.actionNote ?? ''}`)
  assert.ok((failed.assessment.actionNote ?? '').includes('不通过反复压缩修复内容缺失'), '收口说明应写明不得反复压缩修复内容缺失')

  // 拦错侧三：基线版本变化后旧评估转 skipped、不再被调度（不继续依据错误摘要执行）。
  const second = recordOk(rig.state, draftFor(rig.state, baseSignals(), 'semantic', 'fp-acc-12b'))
  const revised = apply(second.state, { kind: 'mission.revise', requestId: req() }, ctx('supervisor'))
  const invalidated = invalidateAssessment(revised, second.assessment.assessmentId, freezeFrame(revised, { requestFingerprint: 'fp-acc-12b', sessionId: 'sess-1', sessionRevision: 1, criteriaRevision: 1, retentionList: [] }), NOW + 5)
  if (!invalidated.ok) throw new Error(`目标修订后旧评估应能标废，却被拒（${invalidated.reason}）`)
  assert.equal(invalidated.assessment.actionState, 'skipped', '未执行的旧评估转 skipped：不继续按旧摘要执行')
  assert.match(planActionRun(invalidated.assessment, { entry: 'idle_maintenance', sessionActive: false, maintenanceEntryFree: true }).reason, /不再调度/, '标废后的评估不得再被调度')

  // 放行侧：从持久依据重建（补检查点、在途操作写明核对路径）后清点通过；核对通过才 done。
  const rig2 = withClaimedTask()
  const rebuilt = apply(rig2.state, { kind: 'task.checkpoint', requestId: req(), taskId: rig2.taskId, checkpoint: checkpointPayload({ nextAction: '把核对结论写入 reports/final.md 后提交' }) }, ctx('lead', 'lead-1'))
  const intent2 = apply(rebuilt, { kind: 'operation.intent', requestId: req(), taskId: rig2.taskId, operationKind: 'file_write', target: 'reports/final.md', intent: '写入核对结论', idempotencyKey: req('idem'), retryable: false, reconcileMethod: '读回文件并按哈希核对' }, ctx('lead', 'lead-1'))
  const operationId2 = Object.keys(intent2.operations)[0]!
  const unknownOp2 = apply(intent2, { kind: 'operation.reconcile', requestId: req(), operationId: operationId2, verdict: 'still_unknown' }, ctx('lead', 'lead-1'))
  const ready = compactionPreflight(unknownOp2, [rig2.taskId])
  assert.equal(ready.ready, true, '从持久依据重建后（下一步 + 在途操作核对路径齐备）清点应通过')
  assert.ok(ready.durable.some((line) => line.includes('结果不明的均可核对')), `清点摘要应确认在途操作可核对，实际：${ready.durable.join(' / ')}`)
  assert.ok(ready.durable.some((line) => line.includes('把核对结论写入 reports/final.md 后提交')), '清点摘要应带出持久化的下一步')
  const freeze13: AssessmentFreeze = { ...freezeFor(rig2.state, 'fp-acc-12c'), retentionList: [rig2.taskId] }
  const okReport = verifyPostCompaction(freeze13, { keptRefs: [rig2.taskId], capacityAfter: { requestEstimateTokens: 200, contextWindowTokens: 1000 }, current: freeze13 })
  assert.equal(okReport.ok, true, '保留清单齐、引用可解析、容量与版本取到：核对通过')
  assert.equal(okReport.nextStep, 'none', '核对通过时无需重建/轮换')
  const doneOutcome = outcomeAfterVerification({ ...invocation, verifyRefs: [rig2.taskId] }, okReport)
  assert.equal(doneOutcome.kind, 'done', '核对通过才收口为 done')
  assert.equal(doneOutcome.kind === 'done' ? doneOutcome.effect?.restoredInfo : undefined, true, 'done 必须记录"必要信息已恢复"')
})
