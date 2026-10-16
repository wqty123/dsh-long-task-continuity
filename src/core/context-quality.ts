/**
 * 上下文质量策略（设计稿 v0.5 §27.2–§27.5；身份与能力边界见 §27.1）。
 *
 * 本模块只做**纯判定 + 经 `commit()` 的转换**，不碰宿主、不取墙钟（`now` 一律作参数传入）：
 * 观测（组成/演变/事件）由适配层 `adapter/dsh-context.ts` 收集，压缩与轮换的执行在别的层，
 * 这里回答四件事——分量现在是什么状态、首选哪个最小有效动作、动作此刻能不能走、走完是否闭环。
 *
 * 六条不变量，每条都对应设计稿里的一句硬话：
 * 1. **不以一个总分决定压缩**：判定输入是结构化问题集合（`ProblemSet`），全程没有任何聚合分数；
 *    动作由"哪些问题存在"决定，不看占用比例之外的任何加权值（§27.3 首句、§27.4 末段）。
 * 2. **unknown ≠ 健康**：观测面缺席或口径不明一律标 `unknown`，既不当作质量良好，
 *    也不阻止原生容量保护——接近硬容量时原生兜底优先，不受普通冷却或"语义健康"阻止（§27.1、§27.2、§27.4 末段）。
 * 3. **分层执行**：确定性检查每次重要准入；较贵的语义检查只在里程碑/纠正后/停滞复核/拟压缩时，
 *    并受冷却、窗口次数与成本上限约束；相同请求与状态版本复用旧结果（§27.3）。
 * 4. **压缩与轮换共享互斥入口**：只从支持的 idle 维护入口发起，活跃则排队；原生 busy/changed
 *    按实际状态核对，禁止忙循环重试；压缩后缺项从权威状态重建或安全轮换，不反复压缩（§27.5 第 3、4 条）。
 * 5. **版本一起冻结**：`sessionRevision/requestFingerprint/missionRevision/objectiveRevision/policyRevision/criteriaRevision`
 *    随评估固定；会话有变化即旧评估失效、重新检查（§27.5 第 2 条）。
 * 6. **分阶段开放**：第一阶段只记录建议与依据；确定性动作（补取/刷新）先开放，
 *    压缩/轮换/裁剪要等校准（`ACTION_ROLLOUT`），本模块用 `deferredAction` 把被阶段门延后的动作留在记录里（§27.5 末段）。
 *
 * 状态写入一律经 `control.commit()`：本文件不直接改 `revision`/`events`，id 用 `mintId`，
 * 列表排序用显式 id 键，`assessments` 容器在 `control.ts:172`。
 */
import { commit, mintId, put } from './control.ts'
import type { MissionControl } from './control.ts'
import { openObligations } from './discipline.ts'
import type {
  ActorId,
  ArtifactVersion,
  AssessmentId,
  Checkpoint,
  ClaimRevision,
  ContextAction,
  ContextAssessment,
  ContextComponent,
  ContextReceipt,
  SessionId,
} from './entities.ts'

// —— §27.3 分层检查 ——

export type CheckTier = 'deterministic' | 'semantic'

/** 分量在**哪一层**才得到完整判定（§27.3：确定性每次准入，语义放里程碑与拟压缩时）。 */
export const COMPONENT_TIERS: Readonly<Record<ContextComponent, CheckTier>> = {
  capacity: 'deterministic',
  coverage: 'deterministic',
  freshness: 'deterministic',
  consistency: 'semantic',
  relevance_redundancy: 'semantic',
  continuity: 'deterministic',
  behavior_regression: 'deterministic',
}

/**
 * 分量顺序显式列死：报告、校验与测试都按它，不依赖对象键序（§27.3 表格顺序）。
 * 语义层才完整的两项在确定性层仍有结构化筛查，缺项一律记 `unknown`，不当作合格。
 */
export const COMPONENT_ORDER: readonly ContextComponent[] = [
  'capacity',
  'coverage',
  'freshness',
  'consistency',
  'relevance_redundancy',
  'continuity',
  'behavior_regression',
]

export type CheckTrigger = 'admission' | 'milestone' | 'after_correction' | 'stall_review' | 'before_compaction'

/** §27.3：较贵的语义检查只出现在里程碑、纠正之后、停滞复核与拟压缩时。 */
export const SEMANTIC_TRIGGERS: readonly CheckTrigger[] = ['milestone', 'after_correction', 'stall_review', 'before_compaction']

/** 语义检查的冷却与窗口上限起步候选，待校准（§27.3"设置成本上限和冷却"）。 */
export const DEFAULT_SEMANTIC_COOLDOWN_MS = 5 * 60 * 1000
export const DEFAULT_MAX_SEMANTIC_RUNS_PER_WINDOW = 3

export interface CheckBudget {
  readonly now: number
  /** 窗口内已执行的语义检查次数（由调用方按状态版本计数；本模块不取墙钟）。 */
  readonly semanticRunsInWindow?: number
  readonly lastSemanticAt?: number
  readonly cooldownMs?: number
  readonly maxSemanticRunsPerWindow?: number
  /** 本次语义检查的预估成本与窗口成本上限（估算 token）。 */
  readonly estimatedCostTokens?: number
  readonly costCapTokens?: number
}

export interface CheckPlan {
  readonly tiers: readonly CheckTier[]
  readonly reason: string
  readonly deferredReason?: string
  /** 接近硬容量：原生兜底优先，不受普通冷却与语义结果阻止（§27.4 末段）。 */
  readonly nativeFallbackPriority: boolean
}

/**
 * 本轮该跑哪些层（§27.3）。
 *
 * 确定性层**每次准入都跑**，冷却与成本上限只约束语义层——质量监控本身不能占满上下文，
 * 但也不能因为省钱而放弃容量与版本核对。`nearHardLimit` 为真时冷却不阻止原生兜底动作。
 */
export function planChecks(trigger: CheckTrigger, options: { readonly budget?: CheckBudget; readonly nearHardLimit?: boolean } = {}): CheckPlan {
  const nativeFallbackPriority = options.nearHardLimit === true
  if (!SEMANTIC_TRIGGERS.includes(trigger)) {
    return {
      tiers: ['deterministic'],
      reason: `${trigger}：确定性检查每次执行（容量、覆盖、新鲜度、连续性、结构化矛盾、行为线索）（§27.3）`,
      nativeFallbackPriority,
    }
  }
  const budget = options.budget
  if (budget === undefined) {
    return {
      tiers: ['deterministic', 'semantic'],
      reason: `${trigger}：语义检查允许（里程碑/纠正后/停滞复核/拟压缩），成本与冷却由调用方未提供预算时自行记账（§27.3）`,
      nativeFallbackPriority,
    }
  }
  const cooldown = budget.cooldownMs ?? DEFAULT_SEMANTIC_COOLDOWN_MS
  const cap = budget.maxSemanticRunsPerWindow ?? DEFAULT_MAX_SEMANTIC_RUNS_PER_WINDOW
  const runs = budget.semanticRunsInWindow ?? 0
  const defer = (why: string): CheckPlan => ({
    tiers: ['deterministic'],
    reason: `${trigger}：本轮只跑确定性层（§27.3）`,
    deferredReason: why,
    nativeFallbackPriority,
  })
  if (budget.lastSemanticAt !== undefined && budget.now - budget.lastSemanticAt < cooldown) {
    return defer(`语义检查在冷却中（距上次 ${budget.now - budget.lastSemanticAt}ms < ${cooldown}ms）：避免质量监控占满上下文`)
  }
  if (runs >= cap) return defer(`窗口内语义检查已达上限 ${cap} 次：延后到下一窗口`)
  if (budget.costCapTokens !== undefined && (budget.estimatedCostTokens ?? 0) > budget.costCapTokens) {
    return defer(`本次语义检查预估成本 ${budget.estimatedCostTokens ?? 0} 超过窗口上限 ${budget.costCapTokens}`)
  }
  return {
    tiers: ['deterministic', 'semantic'],
    reason: `${trigger}：语义检查在预算内（窗口内已跑 ${runs}/${cap}）（§27.3）`,
    nativeFallbackPriority,
  }
}

// —— §27.3 分量信号（由适配层收集；core 只判定） ——

/** 观测面通用口径：不可用原因与备注随分量一起进 `limitNote`，绝不回退成 0 或"健康"。 */
export interface SignalAvailability {
  /** 观测面缺席/不兼容的原因；有值即该分量一律 unknown（§27.1 兼容边界、§27.2）。 */
  readonly unavailable?: string
  /** 截断、近似重建、轻量头未加载详情等口径备注（§27.1）。 */
  readonly caveats?: readonly string[]
}

/** 容量信号（§27.3 第 1 行）：同路由的实际请求估计、输出预留、工具定义与新增输入。 */
export interface CapacitySignals extends SignalAvailability {
  readonly requestEstimateTokens?: number
  readonly outputReserveTokens?: number
  readonly toolDefinitionTokens?: number
  readonly addedInputTokens?: number
  readonly contextWindowTokens?: number
  readonly estimateSource?: 'native_meter' | 'request_budget' | 'projection' | 'estimated'
}

/** 缺口类别对应 §27.3 第 2 行列举的关键对象。 */
export type CoverageItemKind = 'objective' | 'rule' | 'authorization' | 'next_step' | 'open_operation' | 'evidence'

export interface CoverageItem {
  readonly ref: string
  readonly kind: CoverageItemKind
  /** 持久 `ContextReceipt` 的编号；缺它即"无法断定已进入本次请求"（§27.3 限制栏）。 */
  readonly receiptRef?: string
  readonly completeness?: 'full' | 'partial' | 'unknown'
  readonly acknowledged?: boolean
}

export interface CoverageSignals extends SignalAvailability {
  readonly required: readonly CoverageItem[]
}

export type FreshnessRefKind = 'objective' | 'conclusion' | 'authorization' | 'artifact' | 'rule'

export interface FreshnessRef {
  readonly ref: string
  readonly kind: FreshnessRefKind
  /** 当前引用里携带的版本。 */
  readonly referencedVersion?: string | number
  /** 权威状态里的当前版本；缺它就不能承诺发现全部旧前提（§27.3 限制栏）。 */
  readonly currentVersion?: string | number
  readonly withdrawn?: boolean
  readonly supersededBy?: string
}

export interface FreshnessSignals extends SignalAvailability {
  readonly refs: readonly FreshnessRef[]
}

export interface FreshnessClaimSide {
  readonly claimRef: string
  readonly hasSupport: boolean
  readonly hasCounter: boolean
}

export interface ConsistencySignals extends SignalAvailability {
  /** 可确定判定的结构化矛盾（派单/记录层筛出）。 */
  readonly structural?: readonly { readonly kind: string; readonly detail: string }[]
  /** 支持与反证是否缺一侧（§27.3 第 4 行）。 */
  readonly claimSides?: readonly FreshnessClaimSide[]
  /** 自然语言矛盾是语义判断、可能误报：只记录进信号，不作动作依据（§27.3 限制栏）。 */
  readonly semanticFindings?: readonly string[]
}

export interface BulkyOutputSignal {
  readonly ref: string
  readonly approxTokens?: number
  /** 工具调用配对是否完好；未标即按"不可剪"处理（§27.4 不能直接推导栏）。 */
  readonly toolCallPaired?: boolean
  /** 原件是否已持久保留；未标即按"不可剪"处理。 */
  readonly persistedCopy?: boolean
}

export interface RepeatedSignal {
  readonly ref: string
  readonly kind: 'summary' | 'rule' | 'evidence' | 'unknown'
  readonly count: number
  /** 相似文本可能有独立证据意义，不按相似度自动删除（§27.3 限制栏）。 */
  readonly independentEvidence?: boolean
}

export interface RelevanceRedundancySignals extends SignalAvailability {
  /** 详情未加载（只有轻量头）：占用类判断只能说"不能判断"，不能读成"没有冗余"（§27.1）。 */
  readonly detailIncomplete?: string
  readonly bulkyOutputs?: readonly BulkyOutputSignal[]
  readonly repeats?: readonly RepeatedSignal[]
  /** 与当前任务无关的长内容（语义判定）。 */
  readonly unrelated?: readonly string[]
}

export interface InFlightSignal {
  readonly ref: string
  readonly kind: string
  readonly status: string
  readonly receiptRef?: string
  /** 回执存在但结果不明，需要核对。 */
  readonly needsReconcile?: boolean
}

export interface ContinuitySignals extends SignalAvailability {
  readonly inFlight?: readonly InFlightSignal[]
  /** 缺回执的项：先核对，不能靠摘要补写事实（§27.3 限制栏）。 */
  readonly missingReceipts?: readonly string[]
  /** 无法核对的关键事实/操作结果（§27.4 第 6 行）：只阻断依赖该事实的动作。 */
  readonly unverifiedFacts?: readonly string[]
  readonly pendingHandoffs?: readonly string[]
  readonly nextAction?: string
}

export interface BehaviorRegressionSignals extends SignalAvailability {
  readonly repeatedDoneWork?: readonly string[]
  readonly repeatedQuestions?: readonly string[]
  /** 重复采用已撤销结论（§27.3 第 7 行）。 */
  readonly revokedReuse?: readonly string[]
}

/** 非分量观测（任务侧/调度侧判定输入），参与动作矩阵但不冒充分量信号。 */
export interface HistoryBloatSignal {
  readonly bloated: boolean
  /** 存在可安全摘要的范围说明；缺它时压缩建议不成立（§27.4 第 4 行）。 */
  readonly safeSummaryRange?: string
}

export interface TaskSwitchSignal {
  readonly switched: boolean
  readonly staleInterference: boolean
  readonly repairsIneffective: boolean
}

export interface QualityContextSignals {
  readonly historyBloat?: HistoryBloatSignal
  readonly taskSwitch?: TaskSwitchSignal
  readonly progressContinues?: boolean
  /** 正在处理唯一可辨别的复杂细节：容量允许时可以保留（§27.4 末段）。 */
  readonly uniqueComplexDetail?: boolean
}

export interface QualitySignals {
  readonly capacity: CapacitySignals
  readonly coverage: CoverageSignals
  readonly freshness: FreshnessSignals
  readonly consistency: ConsistencySignals
  readonly relevanceRedundancy: RelevanceRedundancySignals
  readonly continuity: ContinuitySignals
  readonly behaviorRegression: BehaviorRegressionSignals
  readonly context?: QualityContextSignals
}

// —— 分量判定 ——

export interface CapacityThresholds {
  /** 接近硬容量：原生兜底优先（§27.4 末段）。只是判定档，执行阈值必须取当前有效 DSH 配置与请求预算（§27.1）。 */
  readonly hardRatio: number
  readonly warnRatio: number
}

export const DEFAULT_CAPACITY_THRESHOLDS: CapacityThresholds = { hardRatio: 0.9, warnRatio: 0.75 }

export interface CapacityReading {
  readonly ratio: number | null
  readonly projectedTokens: number | null
  readonly contextWindow: number | null
}

/** 缺分母即未知（不返回 0%，也不当作健康）：与 `rotation/lines.ts` 的读数口径一致。 */
export function readCapacity(signals: CapacitySignals): CapacityReading {
  const estimate = finite(signals.requestEstimateTokens)
  const window = finite(signals.contextWindowTokens)
  if (estimate === null || window === null || window <= 0) return { ratio: null, projectedTokens: estimate, contextWindow: window }
  const projected = estimate + (finite(signals.outputReserveTokens) ?? 0) + (finite(signals.toolDefinitionTokens) ?? 0) + (finite(signals.addedInputTokens) ?? 0)
  return { ratio: projected / window, projectedTokens: projected, contextWindow: window }
}

export type ProblemKind =
  | 'capacity_pressure'
  | 'missing_key_condition'
  | 'missing_counter_side'
  | 'stale_reference'
  | 'structural_conflict'
  | 'prunable_bulk'
  | 'unverifiable_fact'
  | 'behavior_regression'

export interface DetectedProblem {
  readonly kind: ProblemKind
  readonly detail: string
}

export type ComponentVerdict = 'ok' | 'attention' | 'unknown'

export interface ComponentFinding {
  readonly name: ContextComponent
  readonly signal: string
  readonly limitNote?: string
  readonly verdict: ComponentVerdict
}

export interface ComponentEvaluation {
  readonly finding: ComponentFinding
  /** 该分量暴露出的结构化问题；动作矩阵只消费它们，不做任何加权（§27.3 首句）。 */
  readonly problems: readonly DetectedProblem[]
}

export function evaluateCapacity(signals: CapacitySignals, thresholds: CapacityThresholds = DEFAULT_CAPACITY_THRESHOLDS): ComponentEvaluation {
  if (signals.unavailable !== undefined) return unavailable('capacity', signals, '容量观测面不可用时不按 0 或"健康"回退')
  const reading = readCapacity(signals)
  if (reading.ratio === null || reading.contextWindow === null) {
    return {
      finding: {
        name: 'capacity',
        signal: '未知：缺少请求估计或上下文窗口（缺字段显示未知）',
        limitNote: withCaveats('可估计不等于提供商实际精确计量；缺字段不能回退成 0 或健康（§27.3、§27.1）', signals),
        verdict: 'unknown',
      },
      problems: [],
    }
  }
  const source = signals.estimateSource ?? 'estimated'
  const base = `估计 ${reading.projectedTokens}/${reading.contextWindow}（${percent(reading.ratio)}，来源 ${source}）`
  const limitNote = withCaveats('可估计，不等于提供商实际精确计量；执行阈值必须从当前有效 DSH 配置与请求预算取得（§27.1）', signals)
  if (reading.ratio >= thresholds.hardRatio) {
    return {
      finding: { name: 'capacity', signal: `接近硬容量：${base} ≥ 硬档 ${percent(thresholds.hardRatio)}`, limitNote, verdict: 'attention' },
      problems: [{ kind: 'capacity_pressure', detail: `接近硬容量（${percent(reading.ratio)}）：原生兜底优先（§27.4 末段）` }],
    }
  }
  if (reading.ratio >= thresholds.warnRatio) {
    return { finding: { name: 'capacity', signal: `占用提醒档：${base} ≥ 提醒档 ${percent(thresholds.warnRatio)}`, limitNote, verdict: 'attention' }, problems: [] }
  }
  return { finding: { name: 'capacity', signal: `容量正常：${base}`, limitNote, verdict: 'ok' }, problems: [] }
}

export function evaluateCoverage(signals: CoverageSignals): ComponentEvaluation {
  if (signals.unavailable !== undefined) return unavailable('coverage', signals, '缺回执就无法断定关键条件是否进入本次请求')
  const required = signals.required ?? []
  if (required.length === 0) {
    return {
      finding: {
        name: 'coverage',
        signal: '未知：没有必需的覆盖清单可比对',
        limitNote: withCaveats('未提供清单时不能承诺发现全部缺项；包含也不代表理解（§27.3 限制栏）', signals),
        verdict: 'unknown',
      },
      problems: [],
    }
  }
  const problems: DetectedProblem[] = []
  const unacknowledged: string[] = []
  for (const item of required) {
    const receipt = item.receiptRef === undefined ? '' : item.receiptRef.trim()
    if (receipt.length === 0) {
      problems.push({ kind: 'missing_key_condition', detail: `${item.kind} ${item.ref} 没有送达回执` })
      continue
    }
    if (item.completeness === 'partial') {
      problems.push({ kind: 'missing_key_condition', detail: `${item.kind} ${item.ref} 的回执为 partial：部分内容未进入本次请求` })
    } else if (item.completeness !== 'full') {
      problems.push({ kind: 'missing_key_condition', detail: `${item.kind} ${item.ref} 的回执完整度未知，不能算已覆盖` })
    }
    if (item.acknowledged !== true) unacknowledged.push(item.ref)
  }
  const signal =
    problems.length > 0
      ? `${required.length - problems.length}/${required.length} 项有完整送达回执；缺口 ${problems.length} 项：${problems.map((item) => item.detail).join('；')}`
      : `${required.length} 项必需条件均有完整送达回执${unacknowledged.length > 0 ? `（${unacknowledged.length} 项未确认送达，不宣称已理解）` : ''}`
  return {
    finding: {
      name: 'coverage',
      signal,
      limitNote: withCaveats('回执只证明送到了以及覆盖哪些版本，不宣称模型已理解（§22.3、§27.3）', signals),
      verdict: problems.length > 0 ? 'attention' : 'ok',
    },
    problems,
  }
}

export function evaluateFreshness(signals: FreshnessSignals): ComponentEvaluation {
  if (signals.unavailable !== undefined) return unavailable('freshness', signals, '版本引用观测面不可用时不承诺发现全部旧前提')
  const refs = signals.refs ?? []
  if (refs.length === 0) {
    return {
      finding: {
        name: 'freshness',
        signal: '未知：没有可核对的引用版本',
        limitNote: withCaveats('依赖声明不全时不能承诺发现全部旧前提（§27.3 限制栏）', signals),
        verdict: 'unknown',
      },
      problems: [],
    }
  }
  const problems: DetectedProblem[] = []
  const uncomparable: string[] = []
  for (const ref of refs) {
    if (ref.withdrawn === true) {
      problems.push({ kind: 'stale_reference', detail: `${ref.kind} ${ref.ref} 已撤销但仍被引用` })
      continue
    }
    if (ref.supersededBy !== undefined) {
      problems.push({ kind: 'stale_reference', detail: `${ref.kind} ${ref.ref} 已被 ${ref.supersededBy} 取代但仍在引用` })
      continue
    }
    const referenced = versionText(ref.referencedVersion)
    const current = versionText(ref.currentVersion)
    if (referenced === null || current === null) {
      uncomparable.push(ref.ref)
      continue
    }
    if (referenced !== current) problems.push({ kind: 'stale_reference', detail: `${ref.kind} ${ref.ref} 引用版本 ${referenced} ≠ 当前 ${current}` })
  }
  const limitNote = withCaveats('依赖声明不全时不能承诺发现全部旧前提（§27.3 限制栏）', signals)
  if (problems.length > 0) {
    return {
      finding: { name: 'freshness', signal: `过期引用 ${problems.length} 项：${problems.map((item) => item.detail).join('；')}`, limitNote, verdict: 'attention' },
      problems,
    }
  }
  if (uncomparable.length === refs.length) {
    return { finding: { name: 'freshness', signal: '未知：没有一项能与权威当前版本比对', limitNote, verdict: 'unknown' }, problems: [] }
  }
  return {
    finding: {
      name: 'freshness',
      signal: `${refs.length} 项引用版本与权威当前版本一致${uncomparable.length > 0 ? `（${uncomparable.length} 项没有当前版本可比对：${uncomparable.join('、')}）` : ''}`,
      limitNote,
      verdict: 'ok',
    },
    problems: [],
  }
}

export function evaluateConsistency(signals: ConsistencySignals, tier: CheckTier): ComponentEvaluation {
  if (signals.unavailable !== undefined) return unavailable('consistency', signals, '一致性观测面不可用时不声称"一致"')
  const structural = signals.structural ?? []
  const missingSides = (signals.claimSides ?? []).filter((side) => !(side.hasSupport && side.hasCounter))
  const problems: DetectedProblem[] = [
    ...structural.map((item) => ({ kind: 'structural_conflict' as const, detail: `${item.kind}：${item.detail}` })),
    ...missingSides.map((side) => ({
      kind: 'missing_counter_side' as const,
      detail: `结论 ${side.claimRef} ${side.hasSupport ? '缺反证一侧' : '缺支持一侧'}：重大决定要取得相关反例（§26.4）`,
    })),
  ]
  const semantic = signals.semanticFindings
  const semanticNote =
    tier === 'deterministic'
      ? '本轮为确定性层：只筛结构化矛盾，自然语言矛盾未检查'
      : semantic === undefined
        ? '语义层未给出结论（可能被冷却或成本上限延后）：不能声称"一致"'
        : `语义层疑点 ${semantic.length} 项（可能误报，只记录不作动作依据）`
  const limitNote = withCaveats(`任意自然语言矛盾是语义判断，可能误报（§27.3 限制栏）；${semanticNote}`, signals)
  const semanticText = semantic === undefined || semantic.length === 0 ? '' : `；语义疑点：${semantic.join('；')}`
  if (problems.length > 0) {
    return {
      finding: { name: 'consistency', signal: `已知不一致 ${problems.length} 项：${problems.map((item) => item.detail).join('；')}${semanticText}`, limitNote, verdict: 'attention' },
      problems,
    }
  }
  if (semantic === undefined) {
    return { finding: { name: 'consistency', signal: `未知：${semanticNote}`, limitNote, verdict: 'unknown' }, problems: [] }
  }
  return { finding: { name: 'consistency', signal: `未发现结构化矛盾与缺侧结论${semanticText}`, limitNote, verdict: 'ok' }, problems: [] }
}

export function evaluateRelevanceRedundancy(signals: RelevanceRedundancySignals, tier: CheckTier): ComponentEvaluation {
  if (signals.unavailable !== undefined) return unavailable('relevance_redundancy', signals, '相似判断不可用时一律不剪除')
  if (tier === 'deterministic') {
    return {
      finding: {
        name: 'relevance_redundancy',
        signal: '未知：本轮为确定性检查层，相关性与冗余是较贵的语义判断（§27.3）',
        limitNote: withCaveats('相似文本可能有独立证据意义，不按相似度自动删除；未判定不等于健康', signals),
        verdict: 'unknown',
      },
      problems: [],
    }
  }
  if (signals.detailIncomplete !== undefined) {
    return {
      finding: {
        name: 'relevance_redundancy',
        signal: `未知：${signals.detailIncomplete}（未判定不等于健康）`,
        limitNote: withCaveats('相似文本可能有独立证据意义，不按相似度自动删除；未加载不等于没有长输出（§27.1、§27.3）', signals),
        verdict: 'unknown',
      },
      problems: [],
    }
  }
  const bulky = signals.bulkyOutputs ?? []
  const prunable = bulky.filter((item) => item.persistedCopy === true && item.toolCallPaired === true)
  const blocked = bulky.filter((item) => !(item.persistedCopy === true && item.toolCallPaired === true))
  const repeats = (signals.repeats ?? []).filter((item) => item.count > 1 && item.independentEvidence !== true)
  const independent = (signals.repeats ?? []).filter((item) => item.count > 1 && item.independentEvidence === true)
  const unrelated = signals.unrelated ?? []
  const problems: DetectedProblem[] = [
    ...prunable.map((item) => ({
      kind: 'prunable_bulk' as const,
      detail: `${item.ref} 长输出约 ${item.approxTokens ?? '未知'} token：已持久保留、调用配对完好，可走受支持的裁剪/引用路径，原件不删`,
    })),
    ...repeats.map((item) => ({ kind: 'prunable_bulk' as const, detail: `${item.kind} ${item.ref} 重复 ${item.count} 份：走引用路径，保留独立证据` })),
    ...unrelated.map((item) => ({ kind: 'prunable_bulk' as const, detail: `与当前任务无关（语义判定）：${item}` })),
  ]
  const notes: string[] = []
  if (blocked.length > 0) notes.push(`不可剪 ${blocked.length} 项（未持久化或调用配对不完整）：不得删除唯一证据或破坏工具调用配对（§27.4）`)
  if (independent.length > 0) notes.push(`独立证据意义的重复 ${independent.length} 项：不按相似度自动删除`)
  const limitNote = withCaveats(`相似文本可能有独立证据意义，不按相似度自动删除（§27.3 限制栏）${notes.length > 0 ? `；${notes.join('；')}` : ''}`, signals)
  if (problems.length > 0) {
    return {
      finding: { name: 'relevance_redundancy', signal: `可剪除候选 ${problems.length} 项：${problems.map((item) => item.detail).join('；')}`, limitNote, verdict: 'attention' },
      problems,
    }
  }
  return { finding: { name: 'relevance_redundancy', signal: `语义层未发现可安全剪除的冗余${notes.length > 0 ? `；${notes.join('；')}` : ''}`, limitNote, verdict: 'ok' }, problems: [] }
}

export function evaluateContinuity(signals: ContinuitySignals): ComponentEvaluation {
  if (signals.unavailable !== undefined) return unavailable('continuity', signals, '缺回执先核对，不能靠摘要补写事实')
  const inFlight = signals.inFlight ?? []
  const missingReceipts = signals.missingReceipts ?? []
  const unverifiedFacts = signals.unverifiedFacts ?? []
  const pendingHandoffs = signals.pendingHandoffs ?? []
  const problems: DetectedProblem[] = []
  for (const item of inFlight) {
    if (item.receiptRef === undefined && item.needsReconcile !== true) {
      problems.push({ kind: 'unverifiable_fact', detail: `${item.kind} ${item.ref} 状态 ${item.status} 但无可核对回执` })
      continue
    }
    if (item.needsReconcile === true) problems.push({ kind: 'unverifiable_fact', detail: `${item.kind} ${item.ref} 结果不明，需要核对` })
  }
  for (const ref of missingReceipts) problems.push({ kind: 'unverifiable_fact', detail: `${ref} 缺回执，先核对再继续` })
  for (const fact of unverifiedFacts) problems.push({ kind: 'unverifiable_fact', detail: `${fact} 无法核对，先确认再继续` })
  for (const ref of pendingHandoffs) problems.push({ kind: 'unverifiable_fact', detail: `交接待确认项 ${ref} 未收到回执` })
  const nextStep = signals.nextAction === undefined || signals.nextAction.trim().length === 0 ? '未记录下一步' : '有可恢复的下一步'
  const limitNote = withCaveats('缺回执先核对，不能靠摘要补写事实（§27.3 限制栏）', signals)
  if (problems.length > 0) {
    return {
      finding: { name: 'continuity', signal: `待核对的在途项 ${problems.length} 项：${problems.map((item) => item.detail).join('；')}`, limitNote, verdict: 'attention' },
      problems,
    }
  }
  return {
    finding: { name: 'continuity', signal: `在途 ${inFlight.length} 项均可恢复（${nextStep}）`, limitNote, verdict: 'ok' },
    problems: [],
  }
}

export function evaluateBehaviorRegression(signals: BehaviorRegressionSignals): ComponentEvaluation {
  if (signals.unavailable !== undefined) return unavailable('behavior_regression', signals, '无行为线索时不声称没有退化')
  const hits: DetectedProblem[] = [
    ...(signals.repeatedDoneWork ?? []).map((item) => ({ kind: 'behavior_regression' as const, detail: `复读已做工作：${item}` })),
    ...(signals.repeatedQuestions ?? []).map((item) => ({ kind: 'behavior_regression' as const, detail: `反复询问已确认事项：${item}` })),
    ...(signals.revokedReuse ?? []).map((item) => ({ kind: 'behavior_regression' as const, detail: `重复采用已撤销结论：${item}` })),
  ]
  const limitNote = withCaveats('触发检查，不直接证明上下文是根因（§27.3 限制栏）', signals)
  if (hits.length > 0) {
    return {
      finding: { name: 'behavior_regression', signal: `行为退化线索 ${hits.length} 项：${hits.map((item) => item.detail).join('；')}`, limitNote, verdict: 'attention' },
      problems: hits,
    }
  }
  return { finding: { name: 'behavior_regression', signal: '未观察到复读/重复询问/采用已撤销结论的线索', limitNote, verdict: 'ok' }, problems: [] }
}

// —— 结构化问题集合（动作矩阵的唯一输入；没有总分） ——

export interface ProblemSet {
  readonly missingKeyConditions: readonly string[]
  readonly missingCounterSides: readonly string[]
  readonly staleReferences: readonly string[]
  readonly structuralConflicts: readonly string[]
  readonly prunableBulk: readonly string[]
  readonly unverifiableFacts: readonly string[]
  readonly behaviorRegressionSignals: readonly string[]
  readonly capacityRatio: number | null
  readonly nearHardLimit: boolean
  readonly bloatedWithSafeSummaryRange: boolean
  readonly bloatedWithoutSafeRange: boolean
  readonly taskSwitchedWithIneffectiveRepair: boolean
  readonly progressContinues: boolean
  readonly uniqueComplexDetail: boolean
  /** 本轮未判定的分量：unknown 不等于健康，也不禁用原生容量保护（§27.1、§27.2）。 */
  readonly unknownComponents: readonly ContextComponent[]
}

export interface ContextEvaluation {
  readonly findings: readonly ComponentFinding[]
  readonly problems: ProblemSet
}

/**
 * 一次分层评估（§27.3）。
 *
 * 分量判定与问题集合都从同一份信号推出，调用方不需要（也不能）先算一个总分：
 * 矩阵消费 `problems`，`findings` 只进记录供人看依据。
 */
export function evaluateContext(signals: QualitySignals, tier: CheckTier, thresholds: CapacityThresholds = DEFAULT_CAPACITY_THRESHOLDS): ContextEvaluation {
  const evaluations: readonly ComponentEvaluation[] = [
    evaluateCapacity(signals.capacity, thresholds),
    evaluateCoverage(signals.coverage),
    evaluateFreshness(signals.freshness),
    evaluateConsistency(signals.consistency, tier),
    evaluateRelevanceRedundancy(signals.relevanceRedundancy, tier),
    evaluateContinuity(signals.continuity),
    evaluateBehaviorRegression(signals.behaviorRegression),
  ]
  const findings = evaluations.map((item) => item.finding)
  const detected = evaluations.flatMap((item) => item.problems)
  const reading = readCapacity(signals.capacity)
  const bloat = signals.context?.historyBloat
  const unique = signals.context?.uniqueComplexDetail === true
  const bloated = bloat?.bloated === true
  const safeRange = bloat?.safeSummaryRange !== undefined && bloat.safeSummaryRange.trim().length > 0
  const bloatedWithSafe = tier === 'semantic' && bloated && safeRange && !unique
  const taskSwitch = signals.context?.taskSwitch
  const problems: ProblemSet = {
    missingKeyConditions: details(detected, 'missing_key_condition'),
    missingCounterSides: details(detected, 'missing_counter_side'),
    staleReferences: details(detected, 'stale_reference'),
    structuralConflicts: details(detected, 'structural_conflict'),
    prunableBulk: details(detected, 'prunable_bulk'),
    unverifiableFacts: details(detected, 'unverifiable_fact'),
    behaviorRegressionSignals: details(detected, 'behavior_regression'),
    capacityRatio: reading.ratio,
    nearHardLimit: reading.ratio !== null && reading.ratio >= thresholds.hardRatio,
    bloatedWithSafeSummaryRange: bloatedWithSafe,
    bloatedWithoutSafeRange: bloated && !bloatedWithSafe,
    taskSwitchedWithIneffectiveRepair:
      taskSwitch?.switched === true && taskSwitch.staleInterference === true && taskSwitch.repairsIneffective === true,
    progressContinues: signals.context?.progressContinues === true,
    uniqueComplexDetail: unique,
    unknownComponents: findings.filter((item) => item.verdict === 'unknown').map((item) => item.name),
  }
  return { findings, problems }
}

// —— §27.4 动作矩阵 ——

/** §27.4 表格逐行：问题类别与"不能直接推导"。 */
export const ACTION_MATRIX: Readonly<Record<ContextAction, { readonly problem: string; readonly notDerivable: string }>> = {
  retrieve: { problem: '信息少但关键条件缺失', notDerivable: '压缩会变好' },
  refresh: { problem: '旧结论或规则冲突', notDerivable: '多加一段新摘要就能消除旧前提影响' },
  prune: { problem: '长工具输出重复占用', notDerivable: '可以删除唯一证据或破坏工具调用配对' },
  compact: { problem: '历史膨胀且有可安全摘要范围', notDerivable: '压缩成功就等于任务恢复正确' },
  rotate: { problem: '任务已切换、旧内容持续干扰且修复无效', notDerivable: '换会话会自动纠正错误摘要' },
  wait_reconcile: { problem: '存在无法核对的关键事实或操作结果', notDerivable: '所有成员都必须停工（只阻断依赖该事实的动作）' },
  keep: { problem: '数据健康、任务继续有进展', notDerivable: '达到某个任意占用比例就必须压缩' },
}

/** §27.5 末段的分阶段口径：第一阶段只记录；补取/刷新先开放，压缩/轮换/裁剪要等校准。 */
export const ACTION_ROLLOUT: Readonly<Record<ContextAction, 'deterministic' | 'needs_calibration'>> = {
  retrieve: 'deterministic',
  refresh: 'deterministic',
  wait_reconcile: 'deterministic',
  keep: 'deterministic',
  prune: 'needs_calibration',
  compact: 'needs_calibration',
  rotate: 'needs_calibration',
}

/** 原生兜底标记：接近硬容量时的压缩不是"质量建议"，不受校准阶段门与冷却限制（§27.4 末段）。 */
export const NATIVE_FALLBACK_MARK = 'native-fallback'

export interface ActionDecision {
  readonly action: ContextAction
  readonly reason: string
  readonly notDerivable: string
  /** 该动作属"经校准后才开放"的一类（§27.5 末段）。 */
  readonly gated: boolean
  /** 被阶段门延后的更强动作：仍写进记录，只是不建议在本阶段执行。 */
  readonly deferredAction?: ContextAction
  /** 只记录、不推导动作的项（未知分量、行为线索等）。 */
  readonly notes: readonly string[]
}

export interface SelectActionOptions {
  readonly tier: CheckTier
}

/**
 * 首选动作（§27.4）。
 *
 * 顺序即优先级：接近硬容量 → 原生兜底；无法核对的事实 → 只阻断依赖它的动作；
 * 缺关键条件 → 补取；旧结论/规则冲突 → 刷新；任务已切换且修复无效 → 轮换；
 * 可安全剪除的冗余 → 裁剪；膨胀且有安全摘要范围 → 压缩；否则保留。
 * 不要求每次都从 retrieve 跑到 rotate——按问题取最小有效动作。
 */
export function selectAction(problems: ProblemSet, options: SelectActionOptions = { tier: 'deterministic' }): ActionDecision {
  const tier = options.tier
  const notes: string[] = []
  if (problems.unknownComponents.length > 0) {
    notes.push(`未判定分量：${problems.unknownComponents.join('、')}（unknown 不等于健康，也不禁用原生容量保护）`)
  }
  if (problems.behaviorRegressionSignals.length > 0) {
    notes.push(`行为退化线索 ${problems.behaviorRegressionSignals.length} 项：只触发检查，不直接推导动作（§27.3 限制栏）`)
  }
  if (problems.nearHardLimit) {
    return decide('compact', tier, `${NATIVE_FALLBACK_MARK}：容量占用 ${percent(problems.capacityRatio)} 接近硬上限，原生兜底优先，不受普通冷却或语义是否健康阻止（§27.4 末段）`, notes)
  }
  if (problems.unverifiableFacts.length > 0) {
    return decide('wait_reconcile', tier, `存在无法核对的关键事实/操作结果：${problems.unverifiableFacts.join('；')}；只阻断依赖该事实的动作，其余工作继续（§27.4 第 6 行）`, notes)
  }
  if (problems.missingKeyConditions.length > 0 || problems.missingCounterSides.length > 0) {
    return decide('retrieve', tier, `关键条件缺失：${[...problems.missingKeyConditions, ...problems.missingCounterSides].join('；')}`, notes)
  }
  if (problems.staleReferences.length > 0 || problems.structuralConflicts.length > 0) {
    return decide('refresh', tier, `旧结论或规则冲突：${[...problems.staleReferences, ...problems.structuralConflicts].join('；')}`, notes)
  }
  if (problems.taskSwitchedWithIneffectiveRepair) {
    return decide('rotate', tier, '任务已切换、旧内容持续干扰且修复无效', notes)
  }
  if (problems.prunableBulk.length > 0) {
    return decide('prune', tier, `长工具输出重复占用且可安全裁剪：${problems.prunableBulk.join('；')}`, notes)
  }
  if (problems.bloatedWithSafeSummaryRange) {
    return decide('compact', tier, '历史膨胀且有可安全摘要范围：在安全入口调用原生压缩，之后验证保留项（§27.4 第 4 行）', notes)
  }
  if (problems.bloatedWithoutSafeRange) {
    return decide(
      'keep',
      tier,
      problems.uniqueComplexDetail
        ? '历史膨胀但正在处理唯一可辨别的复杂细节：容量允许时保留（§27.4 末段）'
        : '历史膨胀但没有可判定的安全摘要范围：先记录，不因占用比例自行压缩（§27.4 末段）',
      notes,
    )
  }
  if (problems.progressContinues) return decide('keep', tier, '数据健康、任务继续有进展（§27.4 第 7 行）', notes)
  return decide('keep', tier, '没有可判定的缺口：只记录建议与依据（§27.5 末段）', notes)
}

function decide(action: ContextAction, tier: CheckTier, reason: string, notes: readonly string[]): ActionDecision {
  const gated = ACTION_ROLLOUT[action] === 'needs_calibration'
  if (tier === 'deterministic' && gated && action !== 'compact') {
    return {
      action: 'keep',
      reason: `${reason}；但该动作属"经校准后才开放"的一类，本轮（确定性层）只记录不执行（§27.5 末段）`,
      notDerivable: ACTION_MATRIX[action].notDerivable,
      gated: false,
      deferredAction: action,
      notes,
    }
  }
  return {
    action,
    reason,
    notDerivable: ACTION_MATRIX[action].notDerivable,
    gated,
    notes,
  }
}

// —— 评估的生成 / 校验 / 失效（§27.5 第 2 条） ——

export interface AssessmentFrame {
  readonly sessionId?: SessionId
  readonly sessionRevision: number
  readonly missionRevision: number
  readonly objectiveRevision: number
  readonly policyRevision: number
  readonly criteriaRevision: number
  /** 请求指纹：同请求/同状态版本复用结果用（§27.3）。 */
  readonly requestFingerprint: string
}

export interface AssessmentFreeze extends AssessmentFrame {
  /** 目标保留清单：压缩后逐项核对（§27.5 第 2 条）。 */
  readonly retentionList: readonly string[]
}

/**
 * 冻结本次评估依据的版本（§27.5 第 2 条）。
 *
 * `missionRevision` 取计算时的 `state.revision`——它随本评估自身的提交自然 +1，
 * 所以 `frameDrifts` 把它当**非阻断**的记录水位报告，语义版本的相等性由其余四个字段负责。
 */
export function freezeFrame(
  state: MissionControl,
  input: {
    readonly requestFingerprint: string
    readonly sessionId?: SessionId
    readonly sessionRevision: number
    readonly criteriaRevision: number
    readonly retentionList: readonly string[]
  },
): AssessmentFreeze {
  return {
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    sessionRevision: input.sessionRevision,
    missionRevision: state.revision,
    objectiveRevision: state.mission.objectiveRevision,
    policyRevision: state.mission.policyRevision,
    criteriaRevision: input.criteriaRevision,
    requestFingerprint: input.requestFingerprint,
    retentionList: [...input.retentionList],
  }
}

export interface FrameDrift {
  readonly field: 'sessionId' | 'sessionRevision' | 'requestFingerprint' | 'missionRevision' | 'objectiveRevision' | 'policyRevision' | 'criteriaRevision'
  readonly detail: string
  /** 阻断性漂移即旧评估失效；记录水位推进只报告（§27.5 第 2 条）。 */
  readonly blocking: boolean
}

/** 会话有变化即失效：`sessionId/sessionRevision` 与四个版本号一起比（§27.5 第 2 条）。 */
export function frameDrifts(at: AssessmentFrame, current: AssessmentFrame): FrameDrift[] {
  const drifts: FrameDrift[] = []
  const sessionAt = at.sessionId ?? ''
  const sessionNow = current.sessionId ?? ''
  if (sessionAt !== sessionNow) {
    drifts.push({ field: 'sessionId', detail: `评估会话 ${sessionAt || '未绑定'} → 当前 ${sessionNow || '未绑定'}：会话已变化`, blocking: true })
  }
  if (at.sessionRevision !== current.sessionRevision) {
    drifts.push({ field: 'sessionRevision', detail: `sessionRevision ${at.sessionRevision} → ${current.sessionRevision}`, blocking: true })
  }
  if (at.requestFingerprint !== current.requestFingerprint) {
    drifts.push({ field: 'requestFingerprint', detail: `请求指纹 ${at.requestFingerprint || '无'} → ${current.requestFingerprint || '无'}：不是同一份请求`, blocking: true })
  }
  if (at.objectiveRevision !== current.objectiveRevision) {
    drifts.push({ field: 'objectiveRevision', detail: `目标已修订（${at.objectiveRevision} → ${current.objectiveRevision}）`, blocking: true })
  }
  if (at.policyRevision !== current.policyRevision) {
    drifts.push({ field: 'policyRevision', detail: `规则快照已修订（${at.policyRevision} → ${current.policyRevision}）`, blocking: true })
  }
  if (at.criteriaRevision !== current.criteriaRevision) {
    drifts.push({ field: 'criteriaRevision', detail: `判据已修订（${at.criteriaRevision} → ${current.criteriaRevision}）`, blocking: true })
  }
  if (current.missionRevision > at.missionRevision) {
    drifts.push({
      field: 'missionRevision',
      detail: `记录水位从 ${at.missionRevision} 推进到 ${current.missionRevision}：评估之后又有提交，按需重查`,
      blocking: false,
    })
  }
  return drifts
}

export function assessmentIsCurrent(assessment: ContextAssessment, current: AssessmentFrame): { readonly ok: boolean; readonly blocking: readonly FrameDrift[] } {
  const blocking = frameDrifts(assessment, current).filter((drift) => drift.blocking)
  return { ok: blocking.length === 0, blocking }
}

/** 只凭记录就能核对的版本门（会话与判据由调用方提供当前值，见 `frameDrifts`）。 */
export function recordDrifts(assessment: ContextAssessment, state: MissionControl): string[] {
  const drifts: string[] = []
  if (assessment.objectiveRevision !== state.mission.objectiveRevision) {
    drifts.push(`目标已修订（${assessment.objectiveRevision}→${state.mission.objectiveRevision}）`)
  }
  if (assessment.policyRevision !== state.mission.policyRevision) {
    drifts.push(`规则快照已修订（${assessment.policyRevision}→${state.mission.policyRevision}）`)
  }
  return drifts
}

export type AssessmentComponent = ContextAssessment['components'][number]

/** 把判定结果落成实体分量（`unknown` 标在实体字段上，信号与限制说明原样保留）。 */
export function toAssessmentComponents(findings: readonly ComponentFinding[]): AssessmentComponent[] {
  return findings.map((finding) => ({
    name: finding.name,
    signal: finding.signal,
    ...(finding.limitNote === undefined ? {} : { limitNote: finding.limitNote }),
    ...(finding.verdict === 'unknown' ? { unknown: true } : {}),
  }))
}

export interface AssessmentDraft {
  /** 幂等键（可选）：命令层由 requestId 派生注入；缺省由模块发号（复审 N2 阶段 2）。 */
  readonly assessmentId?: ContextAssessment['assessmentId']
  readonly actorId: ActorId
  readonly freeze: AssessmentFreeze
  readonly evaluation: ContextEvaluation
  readonly decision: ActionDecision
  readonly tier: CheckTier
  readonly costNote?: string
}

export type AssessmentOutcome =
  | { readonly ok: true; readonly state: MissionControl; readonly assessment: ContextAssessment }
  | { readonly ok: false; readonly reason: string }

/**
 * 记录一条评估（§27.5 第 1、2 条：先持久化依据，再谈动作）。
 *
 * 校验不通过即拒绝写入（分量不齐、未知缺说明、确定性层宣布压缩却不是原生兜底），
 * 因为一条"看起来通过"的坏记录比没有记录更危险。
 */
export function recordAssessment(state: MissionControl, draft: AssessmentDraft, now: number): AssessmentOutcome {
  const invalid = invalidDraftReason(draft)
  if (invalid !== undefined) return { ok: false, reason: invalid }
  const reason = [`${draft.decision.reason}`, `不能直接推导：${draft.decision.notDerivable}`, ...draft.decision.notes].join('；')
  const assessment: ContextAssessment = {
    assessmentId: draft.assessmentId ?? mintId('cqa'),
    missionId: state.missionId,
    actorId: draft.actorId,
    ...(draft.freeze.sessionId === undefined ? {} : { sessionId: draft.freeze.sessionId }),
    requestFingerprint: draft.freeze.requestFingerprint,
    sessionRevision: draft.freeze.sessionRevision,
    missionRevision: draft.freeze.missionRevision,
    objectiveRevision: draft.freeze.objectiveRevision,
    policyRevision: draft.freeze.policyRevision,
    criteriaRevision: draft.freeze.criteriaRevision,
    components: toAssessmentComponents(draft.evaluation.findings),
    suggestion: draft.decision.action,
    reason,
    deterministic: draft.tier === 'deterministic',
    ...(draft.costNote === undefined ? {} : { costNote: draft.costNote }),
    actionState: 'recorded',
    actionNote: draft.decision.deferredAction === undefined
      ? '已记录建议与依据；执行需经互斥维护入口（§27.5 第 3 条）'
      : `已记录建议与依据；${draft.decision.deferredAction} 属经校准后才开放的动作（§27.5 末段）`,
    createdAt: now,
  }
  const next = commit(
    { ...state, assessments: put(state.assessments, assessment.assessmentId, assessment) },
    'context/assessment-recorded',
    {
      assessmentId: assessment.assessmentId,
      actorId: assessment.actorId,
      suggestion: assessment.suggestion,
      deterministic: assessment.deterministic,
      unknownComponents: draft.evaluation.problems.unknownComponents.length,
      requestFingerprint: assessment.requestFingerprint,
      missionRevision: assessment.missionRevision,
    },
    now,
  )
  return { ok: true, state: next, assessment }
}

function invalidDraftReason(draft: AssessmentDraft): string | undefined {
  const findings = draft.evaluation.findings
  const names = findings.map((item) => item.name)
  const missing = COMPONENT_ORDER.filter((name) => !names.includes(name))
  const extra = names.filter((name) => !COMPONENT_ORDER.includes(name))
  if (missing.length > 0) return `分量不齐，缺少：${missing.join('、')}`
  if (extra.length > 0) return `出现未知分量：${extra.join('、')}`
  if (names.length !== COMPONENT_ORDER.length) return `分量重复：${names.join('、')}`
  for (const finding of findings) {
    if (finding.signal.trim().length === 0) return `分量 ${finding.name} 的信号为空：空信号不能当依据`
    if (finding.verdict === 'unknown' && (finding.limitNote ?? '').trim().length === 0) {
      return `分量 ${finding.name} 标为未知但没有 limitNote：未知必须写明缺什么`
    }
  }
  if (draft.freeze.requestFingerprint.trim().length === 0) return 'requestFingerprint 为空：没有它就无法判断"相同请求/状态版本复用"（§27.3）'
  if (draft.tier === 'deterministic' && draft.decision.action === 'compact' && !draft.decision.reason.includes(NATIVE_FALLBACK_MARK)) {
    return '确定性层不得因质量判断宣布压缩：只有接近硬容量的原生兜底可以（§27.4 末段、§27.5 末段）'
  }
  if (draft.tier === 'deterministic' && (draft.decision.action === 'rotate' || draft.decision.action === 'prune')) {
    return '确定性层不得宣布轮换/裁剪：这些动作要等校准（§27.5 末段）'
  }
  return undefined
}

export interface AssessmentValidation {
  readonly ok: boolean
  readonly problems: readonly string[]
}

/** 记录校验：分量齐全、未知有说明、建议与阶段门一致（§27.3、§27.5 末段）。 */
export function validateAssessment(assessment: ContextAssessment): AssessmentValidation {
  const problems: string[] = []
  const names = assessment.components.map((item) => item.name)
  const missing = COMPONENT_ORDER.filter((name) => !names.includes(name))
  if (missing.length > 0) problems.push(`分量不齐：${missing.join('、')}`)
  if (new Set(names).size !== names.length) problems.push('分量重复')
  for (const component of assessment.components) {
    if (component.signal.trim().length === 0) problems.push(`分量 ${component.name} 信号为空`)
    if (component.unknown === true && (component.limitNote ?? '').trim().length === 0) problems.push(`分量 ${component.name} 未知缺 limitNote`)
  }
  if (assessment.reason.trim().length === 0) problems.push('reason 为空')
  if (assessment.requestFingerprint.trim().length === 0) problems.push('requestFingerprint 为空')
  if (assessment.actionState !== undefined && !ACTION_STATES.includes(assessment.actionState)) problems.push(`未知动作状态 ${assessment.actionState}`)
  if (assessment.deterministic && assessment.suggestion === 'compact' && !assessment.reason.includes(NATIVE_FALLBACK_MARK)) {
    problems.push('确定性层出现非原生兜底的压缩建议')
  }
  if (assessment.deterministic && (assessment.suggestion === 'rotate' || assessment.suggestion === 'prune')) {
    problems.push('确定性层出现轮换/裁剪建议')
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 相同请求/状态版本复用结果（§27.3）。
 *
 * 只比语义版本与指纹：`missionRevision` 每次提交都会推进（包括本评估自己的提交），
 * 参与比较就会让复用资格当场作废。`tier` 不同不复用——确定性层的结果不能冒充语义层结论。
 */
export function reuseAssessment(state: MissionControl, frame: AssessmentFrame, tier: CheckTier): ContextAssessment | undefined {
  const wanted = tier === 'deterministic'
  const matches = Object.values(state.assessments)
    .filter((item) => item.deterministic === wanted)
    .filter((item) => item.requestFingerprint === frame.requestFingerprint)
    .filter((item) => (item.sessionId ?? '') === (frame.sessionId ?? ''))
    .filter(
      (item) =>
        item.sessionRevision === frame.sessionRevision &&
        item.objectiveRevision === frame.objectiveRevision &&
        item.policyRevision === frame.policyRevision &&
        item.criteriaRevision === frame.criteriaRevision,
    )
    .sort((a, b) => a.missionRevision - b.missionRevision || (a.assessmentId < b.assessmentId ? -1 : 1))
  return matches[matches.length - 1]
}

export type InvalidationOutcome =
  | { readonly ok: true; readonly state: MissionControl; readonly assessment: ContextAssessment; readonly drifts: readonly FrameDrift[] }
  | { readonly ok: false; readonly reason: string }

/**
 * 会话/版本变化后把旧评估标废（§27.5 第 2 条）。
 *
 * 还没执行的评估（recorded/queued）转 `skipped`，防止在旧版本上继续压缩或轮换；
 * 已终态或正在执行的保留原状，只追加事件留痕——在途动作靠压缩后核对收口，不靠改写历史。
 */
export function invalidateAssessment(state: MissionControl, assessmentId: AssessmentId, current: AssessmentFrame, now: number): InvalidationOutcome {
  const assessment = state.assessments[assessmentId]
  if (assessment === undefined) return { ok: false, reason: `评估 ${assessmentId} 不在记录中` }
  const drifts = frameDrifts(assessment, current)
  const blocking = drifts.filter((drift) => drift.blocking)
  if (blocking.length === 0) return { ok: false, reason: `未发现失效：冻结版本与当前一致（评估 ${assessmentId}）` }
  const detail = blocking.map((drift) => drift.detail).join('；')
  const from: ActionState = assessment.actionState ?? INITIAL_ACTION_STATE
  if (from === 'recorded' || from === 'queued') {
    const moved = transitionAction(state, assessmentId, 'skipped', `评估已失效（${detail}）：重新检查后再排动作（§27.5 第 2 条）`, now)
    if (!moved.ok) return { ok: false, reason: moved.reason }
    return { ok: true, state: moved.state, assessment: moved.assessment, drifts }
  }
  const next = commit(state, 'context/assessment-invalidated', { assessmentId, actionState: from, drifts: blocking.map((drift) => drift.field) }, now)
  return { ok: true, state: next, assessment, drifts }
}

// —— §27.5 压缩前后闭环：状态机、入口、结果 ——

export type ActionState = NonNullable<ContextAssessment['actionState']>

export const ACTION_STATES: readonly ActionState[] = ['recorded', 'queued', 'running', 'done', 'failed', 'skipped']

export const INITIAL_ACTION_STATE: ActionState = 'recorded'

/** 合法迁移（§27.5 第 3–5 条）：不跳级、不倒回（busy 不重排队 = 不忙循环重试）、终态不可再动。 */
export const ACTION_TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = {
  recorded: ['queued', 'running', 'skipped'],
  queued: ['running', 'skipped'],
  running: ['done', 'failed', 'skipped'],
  done: [],
  failed: [],
  skipped: [],
}

export function legalActionStep(from: ActionState, to: ActionState): boolean {
  return ACTION_TRANSITIONS[from].includes(to)
}

export interface ActionRunContext {
  /** 入口类别：只从支持的 idle 维护入口发起，pre-step 不能冒充 idle（§27.5 第 3 条）。 */
  readonly entry: 'idle_maintenance' | 'pre_step' | 'admission' | 'other'
  readonly sessionActive: boolean
  /** 轮换与压缩共享互斥入口（§27.5 第 3 条）。 */
  readonly maintenanceEntryFree: boolean
  readonly rotationPending?: boolean
  /** §27.5 末段：经校准后才开放的动作需要显式标记。 */
  readonly calibrationAcknowledged?: boolean
}

export type ActionRunPlan =
  | { readonly kind: 'run_now'; readonly reason: string }
  | { readonly kind: 'queue'; readonly reason: string }
  | { readonly kind: 'skip'; readonly reason: string }

/** `planActionRun` 的结论到动作状态的唯一映射。 */
export const PLAN_STATE: Readonly<Record<ActionRunPlan['kind'], ActionState>> = {
  run_now: 'running',
  queue: 'queued',
  skip: 'skipped',
}

/** 原生兜底的压缩（接近硬容量）：不受校准阶段门限制（§27.4 末段）。 */
export function isNativeFallback(source: { readonly reason: string }): boolean {
  return source.reason.includes(NATIVE_FALLBACK_MARK)
}

/** 动作现在能不能走（§27.5 第 3 条）：活跃则排队，忙碌/占用的入口一律排队，不冒充 idle。 */
export function planActionRun(assessment: ContextAssessment, context: ActionRunContext): ActionRunPlan {
  const state: ActionState = assessment.actionState ?? INITIAL_ACTION_STATE
  if (state !== 'recorded' && state !== 'queued') {
    return { kind: 'skip', reason: `动作状态为 ${state}：不再调度（终态或已在执行）（§27.5 第 3 条）` }
  }
  const action = assessment.suggestion
  if (action === 'keep') return { kind: 'skip', reason: 'keep：只记录不占用维护入口（§27.4 第 7 行）' }
  if (action === 'wait_reconcile') {
    return { kind: 'skip', reason: 'wait/reconcile 只阻断依赖该事实的动作，由守卫按依赖实施，不占用维护入口（§27.4 第 6 行）' }
  }
  if (ACTION_ROLLOUT[action] === 'needs_calibration' && context.calibrationAcknowledged !== true) {
    if (!(action === 'compact' && isNativeFallback(assessment))) {
      return { kind: 'skip', reason: `动作 ${action} 需校准后才开放执行（§27.5 末段）` }
    }
  }
  if (!context.maintenanceEntryFree) {
    return { kind: 'queue', reason: '轮换与压缩共享互斥入口，当前被占用：排队（§27.5 第 3 条）' }
  }
  if (context.rotationPending === true) {
    return { kind: 'queue', reason: '轮换在途：同一互斥入口排队，不并发（§27.5 第 3 条）' }
  }
  if (context.entry !== 'idle_maintenance') {
    return { kind: 'queue', reason: `入口为 ${context.entry}：只从支持的 idle 维护入口发起，不从运行中 pre-step 直接冒充 idle（§27.5 第 3 条）` }
  }
  if (context.sessionActive) {
    return { kind: 'queue', reason: '会话活跃：排队等 idle，之后再走（§27.5 第 3 条）' }
  }
  return { kind: 'run_now', reason: `idle 维护入口空闲，可执行 ${action}（§27.5 第 3 条）` }
}

export type ActionTransition =
  | { readonly ok: true; readonly state: MissionControl; readonly assessment: ContextAssessment }
  | { readonly ok: false; readonly reason: string }

/**
 * 动作状态迁移（经 `commit()` 落盘）。
 *
 * 进入 `running` 之前先核对记录里的版本门：目标或规则快照已经修订时，旧评估不许继续执行
 * （会话与判据版本无法只凭记录核对，由调用方先跑 `frameDrifts`）。
 */
export function transitionAction(state: MissionControl, assessmentId: AssessmentId, next: ActionState, note: string, now: number): ActionTransition {
  const assessment = state.assessments[assessmentId]
  if (assessment === undefined) return { ok: false, reason: `评估 ${assessmentId} 不在记录中` }
  const from: ActionState = assessment.actionState ?? INITIAL_ACTION_STATE
  if (from === next) return { ok: false, reason: `动作状态已经是 ${next}：重复迁移被拒（不重复执行）` }
  if (!legalActionStep(from, next)) {
    return { ok: false, reason: `${from} → ${next} 不是合法迁移：不跳级、不倒回、不忙循环重试（§27.5 第 3 条）` }
  }
  if (note.trim().length === 0) return { ok: false, reason: '动作迁移必须写明依据/结果说明（§27.5 第 5 条）' }
  if (next === 'running') {
    const drifts = recordDrifts(assessment, state)
    if (drifts.length > 0) return { ok: false, reason: `执行前版本核对失败：${drifts.join('；')}，先重新检查（§27.5 第 2 条）` }
  }
  const updated: ContextAssessment = { ...assessment, actionState: next, actionNote: note }
  const committed = commit({ ...state, assessments: put(state.assessments, assessmentId, updated) }, 'context/assessment-action', { assessmentId, from, to: next, note }, now)
  return { ok: true, state: committed, assessment: updated }
}

/** 按 `planActionRun` 的结论落盘：唯一允许的"计划 → 状态"通道。 */
export function applyRunPlan(state: MissionControl, assessmentId: AssessmentId, plan: ActionRunPlan, now: number): ActionTransition {
  return transitionAction(state, assessmentId, PLAN_STATE[plan.kind], plan.reason, now)
}

/** §27.5 第 5 条：效果记录；token 减少量单独不作为成功标准。 */
export interface ActionEffect {
  readonly reclaimedTokens?: number
  readonly restoredInfo?: boolean
  readonly behaviorImproved?: boolean
  readonly costNote?: string
}

export type ActionOutcomeInput =
  | { readonly kind: 'done'; readonly effect?: ActionEffect }
  | { readonly kind: 'shortfall'; readonly missing: readonly string[] }
  | { readonly kind: 'busy'; readonly detail: string }
  | { readonly kind: 'failed'; readonly detail: string }
  | { readonly kind: 'declined'; readonly detail: string }

/**
 * 动作结果收口（§27.5 第 3–5 条）。
 *
 * `shortfall` 是"压缩走完了但核对缺项"：标 failed 并写清从权威状态重建/安全轮换，
 * **不**允许再压一次来补内容。`busy` 是原生 busy/changed：按实际状态核对，不忙循环重试。
 */
export function applyActionOutcome(state: MissionControl, assessmentId: AssessmentId, outcome: ActionOutcomeInput, now: number): ActionTransition {
  switch (outcome.kind) {
    case 'done':
      return transitionAction(state, assessmentId, 'done', effectNote(outcome.effect), now)
    case 'shortfall':
      return transitionAction(
        state,
        assessmentId,
        'failed',
        `压缩后核对缺项：${outcome.missing.join('；')}；从权威状态重建任务上下文，必要时安全轮换，不通过反复压缩修复内容缺失（§27.5 第 4 条）`,
        now,
      )
    case 'busy':
      return transitionAction(state, assessmentId, 'failed', `原生返回 busy/changed：${outcome.detail}；按实际状态核对，禁止忙循环重试（§27.5 第 3 条）`, now)
    case 'failed':
      return transitionAction(state, assessmentId, 'failed', `执行失败：${outcome.detail}；按实际状态核对，不忙循环重试（§27.5 第 3 条）`, now)
    case 'declined':
      return transitionAction(state, assessmentId, 'skipped', `本次不执行：${outcome.detail}（§27.5 第 3 条）`, now)
  }
}

function effectNote(effect: ActionEffect | undefined): string {
  if (effect === undefined) return '动作已完成，但未记录效果：本次不判定是否恢复（§27.5 第 5 条）'
  const parts: string[] = []
  if (effect.restoredInfo === true) parts.push('必要信息已恢复')
  else if (effect.restoredInfo === false) parts.push('必要信息未恢复')
  if (effect.behaviorImproved === true) parts.push('后续行为改善')
  else if (effect.behaviorImproved === false) parts.push('后续行为未改善')
  if (effect.reclaimedTokens !== undefined) {
    const amount = `回收约 ${effect.reclaimedTokens} token`
    const counts = effect.restoredInfo === true || effect.behaviorImproved === true
    parts.push(counts ? amount : `${amount}（仅记账：token 减少量单独不作为成功标准）`)
  }
  if (effect.costNote !== undefined && effect.costNote.trim().length > 0) parts.push(`成本：${effect.costNote}`)
  return parts.length === 0 ? '动作已完成，但效果记录为空：不声称恢复正确（§27.5 第 5 条）' : parts.join('；')
}

// —— §27.5 第 1 条：压缩前先把关键对象持久化 ——

export interface PreflightReport {
  readonly ready: boolean
  readonly durable: readonly string[]
  readonly missing: readonly string[]
}

/** 压缩前清点：目标/约束/授权、有效与撤销结论、反证、未完成事项、在途操作、下一步、证据引用（§27.5 第 1 条）。 */
export function compactionPreflight(state: MissionControl, retentionList: readonly string[]): PreflightReport {
  const durable: string[] = []
  const missing: string[] = []
  if (state.mission.objective.trim().length === 0) missing.push('目标为空：先把当前目标写进权威状态')
  else durable.push(`目标：${state.mission.objective}`)
  if (state.mission.constraints.length === 0) durable.push('约束：无额外约束')
  else if (state.mission.constraintSources.length === 0) missing.push('约束缺来源：约束与来源必须一起持久化')
  else durable.push(`约束 ${state.mission.constraints.length} 项（含来源）`)

  const grants = Object.values(state.grants)
  const badGrants = grants.filter((grant) => grant.revokedAt !== undefined && (grant.revokedReason ?? '').trim().length === 0)
  if (badGrants.length > 0) missing.push(`${badGrants.length} 项授权已撤销但缺撤销理由：撤销与替代记录要显式携带（§27.4 第 2 行）`)
  else durable.push(`授权 ${grants.length} 项（已撤销 ${grants.filter((grant) => grant.revokedAt !== undefined).length} 项，撤销理由齐）`)

  const claims = Object.values(state.claims).map((chain) => chain[chain.length - 1]).filter((head): head is NonNullable<typeof head> => head !== undefined)
  const badClaims = claims.filter((head) => head.retractedAt !== undefined && (head.retractionReason ?? '').trim().length === 0)
  const badSupersede = claims.filter((head) => head.status === 'superseded' && head.supersedesVersion === undefined)
  if (badClaims.length > 0) missing.push(`${badClaims.length} 条结论已撤回但缺撤回理由`)
  else if (badSupersede.length > 0) missing.push(`${badSupersede.length} 条结论在被取代状态但缺被取代版本`)
  else durable.push(`有效与撤销结论 ${claims.length} 条（链头齐）`)

  let counterRefs = 0
  let brokenCounter = 0
  for (const head of claims) {
    for (const evidenceId of head.contradictingEvidenceIds) {
      counterRefs += 1
      if (state.evidence[evidenceId] === undefined) brokenCounter += 1
    }
    for (const evidenceId of head.supportingEvidenceIds) {
      if (state.evidence[evidenceId] === undefined) brokenCounter += 1
    }
  }
  if (brokenCounter > 0) missing.push(`${brokenCounter} 条证据引用无法解析：反证与支持证据都要先能回溯`)
  else durable.push(`反证引用 ${counterRefs} 条可解析`)

  const obligations = openObligations(state)
  const strandedObligations = obligations.filter((item) => {
    const owner = state.actors[item.ownerActorId]
    return item.ownerActorId.trim().length === 0 || owner === undefined || owner.retired || owner.dormant
  })
  if (strandedObligations.length > 0) missing.push(`${strandedObligations.length} 项未完成事项的责任人已退役/休眠或不存在：换人接手前不压`)
  else durable.push(`未完成事项 ${obligations.length} 项（责任人在岗）`)

  const inFlight = Object.values(state.operations).filter((op) => op.status === 'intent' || op.status === 'executing' || op.status === 'outcome_unknown')
  const unknownOps = inFlight.filter((op) => op.status === 'outcome_unknown' && (op.reconcileMethod ?? '').trim().length === 0)
  if (unknownOps.length > 0) missing.push(`${unknownOps.length} 项在途操作结果不明且没有核对方法：先定核对路径（§27.5 第 1 条）`)
  else durable.push(`在途操作 ${inFlight.length} 项（结果不明的均可核对）`)

  const lastCheckpointId = state.checkpointOrder[state.checkpointOrder.length - 1]
  const lastCheckpoint = lastCheckpointId === undefined ? undefined : state.checkpoints[lastCheckpointId]
  if (lastCheckpoint === undefined || lastCheckpoint.nextAction.trim().length === 0) missing.push('没有记录可恢复的下一步（检查点缺 nextAction）')
  else durable.push(`下一步：${lastCheckpoint.nextAction}`)

  const unresolvedRefs = retentionList.filter((ref) => !refResolvable(state, ref))
  if (unresolvedRefs.length > 0) missing.push(`保留清单 ${unresolvedRefs.length} 项无法在权威状态中解析：${unresolvedRefs.join('、')}`)
  else durable.push(`保留清单 ${retentionList.length} 项均可解析`)

  return { ready: missing.length === 0, durable, missing }
}

/**
 * 引用能否在权威状态里解析（保留清单、压缩前清点与压缩后核对其用一把尺）。
 *
 * 只认记录里真正存在的对象；产物按 id 或 uri 认。**不**把"投影里见过"当解析成功——
 * 投影是会话侧观测，压缩后能否重建只能看权威记录。
 */
export function refResolvable(state: MissionControl, ref: string): boolean {
  if (ref.trim().length === 0) return false
  if (state.evidence[ref] !== undefined) return true
  if (state.claims[ref] !== undefined) return true
  if (state.rules[ref] !== undefined) return true
  if (state.operations[ref] !== undefined) return true
  if (state.tasks[ref] !== undefined) return true
  if (state.grants[ref] !== undefined) return true
  if (state.obligations[ref] !== undefined) return true
  if (state.checkpoints[ref] !== undefined) return true
  if (state.contexts[ref] !== undefined) return true
  if (state.searches[ref] !== undefined) return true
  for (const group of Object.values(state.artifacts)) {
    if (group.some((artifact) => artifact.artifactId === ref || artifact.uri === ref)) return true
  }
  return false
}

// —— §27.5 第 4 条：压缩后核对 ——

export interface PostCompactionObservation {
  /** 目标保留清单里实际保留的引用。 */
  readonly keptRefs: readonly string[]
  /** 关键引用可解析性核对结果（解析不到的项）。 */
  readonly unresolvableRefs?: readonly string[]
  /** 新请求容量（压缩后实测）；缺它就不宣称已恢复。 */
  readonly capacityAfter?: { readonly requestEstimateTokens?: number; readonly contextWindowTokens?: number }
  /** 压缩期间当前有效版本；缺省即"没取到"，不按无变化处理。 */
  readonly current?: AssessmentFrame
}

export interface PostCompactionReport {
  readonly ok: boolean
  /** 缺项与无法核对的项（二者都不许算通过）。 */
  readonly missing: readonly string[]
  readonly frameDrifts: readonly FrameDrift[]
  readonly nextStep: 'none' | 'rebuild_from_authoritative_state' | 'safe_rotation'
  readonly capacityNote?: string
  readonly notes: readonly string[]
}

/**
 * 压缩后核对（§27.5 第 4 条）：保留清单、关键引用可解析性、新请求容量、当前有效版本。
 * 缺项时从权威状态重建，必要时安全轮换；**不**通过反复压缩修复内容缺失。
 *
 * 四项里任一项**取不到**都不算通过：拿不到容量或当前版本就宣称"已恢复"，
 * 等于把 unknown 当健康（本模块第 2 条不变量），所以未取到的项进 `missing`，
 * `ok` 只在四项都有证据时成立。
 */
export function verifyPostCompaction(
  frame: AssessmentFreeze,
  observation: PostCompactionObservation,
  thresholds: CapacityThresholds = DEFAULT_CAPACITY_THRESHOLDS,
): PostCompactionReport {
  const kept = new Set(observation.keptRefs)
  const missing = frame.retentionList.filter((ref) => !kept.has(ref))
  const unresolved = observation.unresolvableRefs ?? []
  const notes: string[] = []
  const unverified: string[] = []
  if (observation.current === undefined) unverified.push('压缩期间的有效版本未取到：不按"无变化"处理，也不能宣称版本一致（§27.5 第 4 条）')
  const drifts = observation.current === undefined ? [] : frameDrifts(frame, observation.current)
  for (const drift of drifts) if (drift.blocking) notes.push(`压缩期间${drift.detail}：本次评估失效，重新检查（§27.5 第 2 条）`)

  const reading = readCapacity({ requestEstimateTokens: observation.capacityAfter?.requestEstimateTokens, contextWindowTokens: observation.capacityAfter?.contextWindowTokens })
  let capacityNote: string | undefined
  let capacityStillHigh = false
  if (reading.ratio === null) {
    capacityNote = '新请求容量未取到（缺字段即未知）：不宣称已恢复'
    unverified.push('压缩后新请求容量未取到：不宣称已恢复（§27.5 第 4 条）')
  } else {
    capacityStillHigh = reading.ratio >= thresholds.hardRatio
    capacityNote = `压缩后新请求容量 ${percent(reading.ratio)}`
    if (capacityStillHigh) notes.push('压缩后仍接近硬容量：按实际状态核对，禁止忙循环重试或反复压缩（§27.5 第 3 条）')
  }

  const shortfall = [...missing.map((ref) => `保留清单缺项：${ref}`), ...unresolved.map((ref) => `关键引用不可解析：${ref}`), ...unverified]
  const blockingDrift = drifts.some((drift) => drift.blocking)
  const ok = shortfall.length === 0 && !blockingDrift
  return {
    ok,
    missing: shortfall,
    frameDrifts: drifts,
    nextStep: ok ? 'none' : capacityStillHigh ? 'safe_rotation' : 'rebuild_from_authoritative_state',
    ...(capacityNote === undefined ? {} : { capacityNote }),
    notes: [
      ...notes,
      ...unverified,
      ...(shortfall.length > 0 ? ['缺项时从权威状态重建任务上下文，必要时安全轮换；不通过反复压缩修复内容缺失（§27.5 第 4 条）'] : []),
    ],
  }
}

/** 便捷入口：收集好的信号 → 判定 → 记录（§27.3–§27.5 一条链）。 */
export interface AssessContextInput {
  /** 幂等键（可选）：命令层由 requestId 派生注入；缺省由模块发号（复审 N2 阶段 2）。 */
  readonly assessmentId?: ContextAssessment['assessmentId']
  readonly actorId: ActorId
  readonly freeze: AssessmentFreeze
  readonly signals: QualitySignals
  readonly tier: CheckTier
  readonly thresholds?: CapacityThresholds
  readonly costNote?: string
}

export function assessContext(state: MissionControl, input: AssessContextInput, now: number): AssessmentOutcome {
  const evaluation = evaluateContext(input.signals, input.tier, input.thresholds ?? DEFAULT_CAPACITY_THRESHOLDS)
  const decision = selectAction(evaluation.problems, { tier: input.tier })
  return recordAssessment(
    state,
    {
      actorId: input.actorId,
      freeze: input.freeze,
      evaluation,
      decision,
      tier: input.tier,
      ...(input.assessmentId === undefined ? {} : { assessmentId: input.assessmentId }),
      ...(input.costNote === undefined ? {} : { costNote: input.costNote }),
    },
    now,
  )
}

// —— 工具 ——

function unavailable(name: ContextComponent, signals: SignalAvailability, why: string): ComponentEvaluation {
  return {
    finding: {
      name,
      signal: `未知：${signals.unavailable ?? '观测面缺席'}`,
      limitNote: `${why}；未知既不等于质量良好，也不禁用原生容量保护（§27.1、§27.2）`,
      verdict: 'unknown',
    },
    problems: [],
  }
}

function withCaveats(limitNote: string, signals: SignalAvailability): string {
  const caveats = signals.caveats ?? []
  return caveats.length === 0 ? limitNote : `${limitNote}；${caveats.join('；')}`
}

function details(problems: readonly DetectedProblem[], kind: ProblemKind): string[] {
  return problems.filter((item) => item.kind === kind).map((item) => item.detail)
}

function percent(ratio: number | null): string {
  return ratio === null ? '未知' : `${(ratio * 100).toFixed(1)}%`
}

function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function versionText(value: string | number | undefined): string | null {
  if (value === undefined) return null
  const text = typeof value === 'string' ? value.trim() : String(value)
  return text.length === 0 ? null : text
}

// —— §27.3 第 2–4 行、§27.4 第 2、6 行：任务侧权威输入构造器（纯函数，不碰宿主、不取墙钟） ——

/**
 * 必需条件清单（`ContextQualityInput.required` 的权威来源，§27.3 第 2 行）。
 *
 * 只列**权威记录里确实存在**的关键对象：目标、生效中规则（链头 `active`）、未撤销授权、
 * 最新检查点的下一步、非终态操作（intent/executing/outcome_unknown）、结论链头引用的证据。
 * 送达回执（`ContextReceipt`）按引用面回绑：回执的 `ruleVersions` 键、`claimRefs`、`inputRefs`
 * （含所属任务）里出现该引用才绑上 `receiptRef`；绑不上就**不填**——"无法断定已进入本次请求"
 * 由覆盖分量如实报缺，适配层不替观测面宣布已覆盖（§27.3 限制栏）。
 * 排序按 `ref` 后接 `kind`，与记录键序无关。
 */
export function coverageFromState(state: MissionControl): readonly CoverageItem[] {
  const byRef = receiptIndex(state)
  const items = new Map<string, CoverageItem>()
  const add = (ref: string, kind: CoverageItemKind): void => {
    const trimmed = ref.trim()
    if (trimmed.length === 0) return
    const key = `${kind}:${trimmed}`
    if (!items.has(key)) items.set(key, coverageItem(byRef, trimmed, kind))
  }
  add(state.mission.missionId, 'objective')
  for (const [ruleId, chain] of sortedEntries(state.rules)) {
    if (chain[chain.length - 1]?.status === 'active') add(ruleId, 'rule')
  }
  for (const [grantId, grant] of sortedEntries(state.grants)) {
    if (grant.revokedAt === undefined) add(grantId, 'authorization')
  }
  const checkpoint = latestCheckpointOf(state)
  if (checkpoint !== undefined) add(checkpoint.checkpointId, 'next_step')
  for (const [operationId, operation] of sortedEntries(state.operations)) {
    if (operation.status === 'succeeded' || operation.status === 'failed') continue
    add(operationId, 'open_operation')
  }
  for (const chain of sortedChains(state.claims)) {
    const head = chain[chain.length - 1]
    if (head === undefined) continue
    for (const evidenceId of [...head.supportingEvidenceIds, ...head.contradictingEvidenceIds]) add(evidenceId, 'evidence')
  }
  return [...items.values()].sort((a, b) => (a.ref !== b.ref ? (a.ref < b.ref ? -1 : 1) : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
}

/**
 * 版本引用对照（`ContextQualityInput.versionRefs` 的任务侧来源，§27.3 第 3 行）。
 *
 * 三组：结论链头（`claimId` + 当前版本号）、生效规则、当前产物版本。
 * 这里只能给**权威侧的当前版本**与"已撤销/已被取代"的事实：引用里携带的版本、
 * "是否仍被引用"属于会话观测，由调用方补 `referencedVersion` 或由行为退化线索补（§27.3 限制栏）；
 * 本函数不替观测侧断言"仍在引用"，也读不到就不编（`supersededBy` 只在能点名后继时给出）。
 */
export function freshnessRefsFromState(state: MissionControl): readonly FreshnessRef[] {
  const refs = new Map<string, FreshnessRef>()
  const add = (item: FreshnessRef): void => {
    const ref = item.ref.trim()
    if (ref.length === 0) return
    const key = `${item.kind}:${ref}`
    if (!refs.has(key)) refs.set(key, { ...item, ref })
  }
  for (const chain of sortedChains(state.claims)) {
    const head = chain[chain.length - 1]
    if (head === undefined) continue
    add({
      ref: head.claimId,
      kind: 'conclusion',
      currentVersion: head.version,
      ...(head.retractedAt === undefined && head.status !== 'superseded' ? {} : { withdrawn: true }),
    })
  }
  for (const [ruleId, chain] of sortedEntries(state.rules)) {
    const head = chain[chain.length - 1]
    if (head === undefined || head.status !== 'active') continue
    add({ ref: ruleId, kind: 'rule', currentVersion: head.version })
  }
  for (const [artifactId, versions] of sortedEntries(state.artifacts)) {
    const head = latestVersion(versions)
    if (head === undefined || head.status === 'rejected' || head.status === 'superseded') continue
    add({ ref: artifactId, kind: 'artifact', currentVersion: head.version, ...(head.validity === 'invalid' ? { withdrawn: true } : {}) })
  }
  return [...refs.values()].sort((a, b) => (a.ref !== b.ref ? (a.ref < b.ref ? -1 : 1) : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
}

/**
 * 结构化矛盾（`ContextQualityInput.structuralFindings`；§27.3 第 4 行、§27.4 第 2 行）。
 *
 * 三类只认记录能证明的形态：任务依赖悬挂（依赖缺失/已取消/已失败）、已撤销但仍被引用
 * （在途操作引用缺失或已撤销的授权、待传播项指向已撤回结论或已撤销授权）、证据引用断裂
 * （结论链头引用的证据缺失或有效性非 current）。判不出的一律不写——留白由语义层处理。
 */
export function structuralFindingsFromState(state: MissionControl): readonly { readonly kind: string; readonly detail: string }[] {
  const findings: { kind: string; detail: string }[] = []
  for (const [taskId, task] of sortedEntries(state.tasks)) {
    for (const dependency of [...task.dependsOn].sort()) {
      const target = state.tasks[dependency]
      if (target === undefined) findings.push({ kind: 'dangling_task_dependency', detail: `任务 ${taskId} 依赖 ${dependency}，但该任务不在记录中` })
      else if (target.status === 'cancelled') findings.push({ kind: 'dangling_task_dependency', detail: `任务 ${taskId} 依赖已取消的 ${dependency}：换依赖或重排后再推进` })
      else if (target.status === 'failed') findings.push({ kind: 'dangling_task_dependency', detail: `任务 ${taskId} 依赖已失败的 ${dependency}：按当前状态决定重排还是换依赖` })
    }
  }
  for (const [operationId, operation] of sortedEntries(state.operations)) {
    if (operation.status === 'succeeded' || operation.status === 'failed') continue
    if (operation.grantId === undefined) continue
    const grant = state.grants[operation.grantId]
    if (grant === undefined) {
      findings.push({ kind: 'revoked_but_referenced', detail: `在途操作 ${operationId} 引用的授权 ${operation.grantId} 不在记录中` })
    } else if (grant.revokedAt !== undefined) {
      findings.push({
        kind: 'revoked_but_referenced',
        detail: `在途操作 ${operationId}（${operation.kind}）引用已撤销授权 ${operation.grantId}：先核对是否该继续`,
      })
    }
  }
  for (const propagation of [...state.pendingPropagations].sort((a, b) => (a.propagationId < b.propagationId ? -1 : 1))) {
    const reason = revokedTargetReason(state, propagation.targetKind, propagation.targetId)
    if (reason === undefined) continue
    findings.push({ kind: 'revoked_but_referenced', detail: `待传播项 ${propagation.propagationId}（${propagation.cause}）指向${reason}：先按当前依据重算再传播` })
  }
  for (const chain of sortedChains(state.claims)) {
    const head = chain[chain.length - 1]
    if (head === undefined) continue
    for (const evidenceId of [...head.supportingEvidenceIds, ...head.contradictingEvidenceIds].sort()) {
      const record = state.evidence[evidenceId]
      if (record === undefined) findings.push({ kind: 'broken_evidence_ref', detail: `结论 ${head.claimId} 引用的证据 ${evidenceId} 不在记录中` })
      else if (record.validity !== 'current') {
        findings.push({ kind: 'broken_evidence_ref', detail: `结论 ${head.claimId} 引用的证据 ${evidenceId} 有效性为 ${record.validity}：不能当当前依据（§27.4 第 2 行）` })
      }
    }
  }
  return findings
}

/**
 * 无法核对的关键事实/操作结果（`ContextQualityInput.unverifiedFacts`；§27.4 第 6 行）。
 *
 * 两类：结果不明（`outcome_unknown`）的在途操作——带上已记录的核对路径；
 * 已完成/已生效但 `validity=needs_review` 的项（任务、结论、产物、证据）——
 * "当时做完了"不等于"现在还能当当前结果用"（§6.1）。只阻断依赖该事实的动作，不要求全体停工。
 */
export function unverifiedFactsFromState(state: MissionControl): readonly string[] {
  const facts: string[] = []
  const operations: string[] = []
  for (const [operationId, operation] of sortedEntries(state.operations)) {
    if (operation.status !== 'outcome_unknown') continue
    const method = (operation.reconcileMethod ?? '').trim()
    operations.push(
      method.length === 0
        ? `操作 ${operationId}（${operation.kind} → ${operation.target}）结果不明且未记录核对路径：先定核对路径`
        : `操作 ${operationId}（${operation.kind} → ${operation.target}）结果不明：按核对路径「${method}」先核对`,
    )
  }
  facts.push(...operations)
  const tasks: string[] = []
  for (const [taskId, task] of sortedEntries(state.tasks)) {
    if (task.status === 'completed' && task.validity === 'needs_review') tasks.push(`任务 ${taskId} 已完成但结果待复核（validity=needs_review）`)
  }
  facts.push(...tasks)
  const claims: string[] = []
  for (const chain of sortedChains(state.claims)) {
    const head = chain[chain.length - 1]
    if (head === undefined || head.retractedAt !== undefined) continue
    if (head.validity === 'needs_review') claims.push(`结论 ${head.claimId} 待复核（validity=needs_review）`)
  }
  facts.push(...claims)
  const artifacts: string[] = []
  for (const [artifactId, versions] of sortedEntries(state.artifacts)) {
    const head = latestVersion(versions)
    if (head === undefined || head.validity !== 'needs_review') continue
    artifacts.push(`产物 ${artifactId} v${head.version} 待复核（validity=needs_review）`)
  }
  facts.push(...artifacts)
  const evidence: string[] = []
  for (const [evidenceId, record] of sortedEntries(state.evidence)) {
    if (record.validity === 'needs_review') evidence.push(`证据 ${evidenceId} 待复核（validity=needs_review）`)
  }
  facts.push(...evidence)
  return facts
}

/** 记录键序无意义：所有构造器一律显式排序，产物在不同宿主上可复现。 */
function sortedEntries<T>(record: Readonly<Record<string, T>>): readonly (readonly [string, T])[] {
  return Object.entries(record).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/** 结论链按链头 id 排序（链内保持版本顺序）。 */
function sortedChains(claims: Readonly<Record<string, readonly ClaimRevision[]>>): readonly (readonly ClaimRevision[])[] {
  return Object.entries(claims)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((entry) => entry[1])
}

function latestCheckpointOf(state: MissionControl): Checkpoint | undefined {
  const id = state.checkpointOrder[state.checkpointOrder.length - 1]
  return id === undefined ? undefined : state.checkpoints[id]
}

function latestVersion(versions: readonly ArtifactVersion[] | undefined): ArtifactVersion | undefined {
  let head: ArtifactVersion | undefined
  for (const version of versions ?? []) if (head === undefined || version.version > head.version) head = version
  return head
}

/** 已撤销对象被引用时的说明；引用面解析不出"被撤销"就返回 `undefined`（不编判据）。 */
function revokedTargetReason(state: MissionControl, targetKind: string, targetId: string): string | undefined {
  if (targetKind === 'claim') {
    const chain = state.claims[targetId]
    const head = chain?.[chain.length - 1]
    if (head === undefined) return undefined
    if (head.retractedAt !== undefined) return `已撤回结论 ${targetId}`
    if (head.status === 'superseded') return `已被取代的结论 ${targetId}`
    return undefined
  }
  if (targetKind === 'grant' || targetKind === 'authorization') {
    const grant = state.grants[targetId]
    if (grant === undefined) return undefined
    return grant.revokedAt === undefined ? undefined : `已撤销授权 ${targetId}`
  }
  return undefined
}

/** 引用 → 最新一份提到它的送达回执（`ContextReceipt`；同刻按回执 id 定序，保证可复现）。 */
function receiptIndex(state: MissionControl): ReadonlyMap<string, ContextReceipt> {
  const index = new Map<string, ContextReceipt>()
  for (const [receiptId, receipt] of sortedEntries(state.contexts)) {
    const refs = new Set<string>([...Object.keys(receipt.ruleVersions), ...receipt.claimRefs, ...receipt.inputRefs])
    if (receipt.taskId !== undefined) refs.add(receipt.taskId)
    for (const ref of refs) {
      const prior = index.get(ref)
      if (prior === undefined || receipt.createdAt >= prior.createdAt) index.set(ref, { ...receipt, receiptId })
    }
  }
  return index
}

function coverageItem(byRef: ReadonlyMap<string, ContextReceipt>, ref: string, kind: CoverageItemKind): CoverageItem {
  const receipt = byRef.get(ref)
  if (receipt === undefined) return { ref, kind }
  return { ref, kind, receiptRef: receipt.receiptId, completeness: receipt.completeness, acknowledged: receipt.acknowledged }
}
