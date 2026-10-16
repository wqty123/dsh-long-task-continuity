/**
 * 目标效用：把验收连接到用户实际用途（v0.5 §30）。
 *
 * 这一层只做契约的判定、登记与修订计算，写状态一律经 `control.commit`。
 * **不另建目标版本存储**：契约住在 `Mission.outcome`，版本身份沿用
 * `Mission.objectiveRevision`（§30.1）。Mission 是 readonly，登记/修订要重建
 * mission 对象再提交，因此这里补了冻结命令面缺的那条路径（`mission.revise`
 * 不携带 `outcome` 字段）：
 *
 * - **实质修订**（intendedUse / desiredOutcome / 硬约束变化 / 验收例子被移除 /
 *   效果观测降级）只允许用户或 Supervisor 发起，并像 `mission.revise` 一样推进
 *   objectiveRevision、把未完成任务打回 planned（§6.1、§30.1）——旧派单与旧票据
 *   随之失效，V5-01 的"复核后修订"走的就是这条路；
 * - **非实质修订**（测量口径、假设澄清）与效果观测生命周期只更新契约对象本身，
 *   用 `revisedAt/revisedBy` 与事件留痕，不推进 objectiveRevision：交付完成与
 *   效果观测分开，后期观测不能反过来作废按版本绑定的整体验收（§30.3）。
 *
 * 三个关键不变量：
 * 1. 效果观测只能 not_required → outcome_pending → observed 推进；observed 必须
 *    带实际观测证据，不得假报（§30.3）；
 * 2. 硬约束来源必须署名，模型偏好不得冒充用户要求；偏好未指定就保持未指定（§30.1）；
 * 3. 复核回答问题要有证据引用或明确标 unknown，不接受无证据的效用分数（§30.2）。
 */
import type {
  ActorId,
  ActorRole,
  Attempt,
  EvidenceId,
  Mission,
  OutcomeContract,
  Task,
} from './entities.ts'
import { TASK_TERMINAL } from './entities.ts'
import type { MissionControl } from './control.ts'
import { commit } from './control.ts'
import { isTerminalAttempt } from './lease.ts'

export type EffectObservationState = 'not_required' | 'outcome_pending' | 'observed'
export type EffectObservation = OutcomeContract['effectObservation']

const EFFECT_RANK: Readonly<Record<EffectObservationState, number>> = {
  not_required: 0,
  outcome_pending: 1,
  observed: 2,
}

/** 登记输入：`revisedAt/revisedBy` 由本层盖；效果观测可省略（沿用现值/默认未要求）。 */
export type OutcomeContractInput = Omit<OutcomeContract, 'revisedAt' | 'revisedBy' | 'effectObservation'> & {
  readonly effectObservation?: EffectObservation
}

export interface OutcomeValidation {
  readonly problems: readonly string[]
  readonly warnings: readonly string[]
}

// —— §30.1 契约校验 ——

/** 用户侧来源标记：出现这些词说明来源不是模型自造的偏好。 */
const USER_SOURCE_MARKERS = ['用户', 'user', '部署', 'deployment', '平台', 'platform', '规则', 'rule', '授权', 'authorization', '指令']
/** 模型侧来源标记：只写这些而不带用户来源的硬约束是模型偏好冒充（§30.1"模型偏好不得冒充"）。 */
const MODEL_SOURCE_MARKERS = ['模型', 'model', '代理', 'agent', 'assistant', 'llm', '偏好', 'preference']

function isModelPreference(source: string): boolean {
  const lower = source.toLowerCase()
  const modelish = MODEL_SOURCE_MARKERS.some((marker) => lower.includes(marker))
  const userish = USER_SOURCE_MARKERS.some((marker) => lower.includes(marker))
  return modelish && !userish
}

export function validateOutcomeContract(input: OutcomeContractInput): OutcomeValidation {
  const problems: string[] = []
  const warnings: string[] = []
  const observation: EffectObservation = input.effectObservation ?? { state: 'not_required' }

  if (input.intendedUse.trim().length === 0) problems.push('intendedUse 不能为空：契约要写清谁在什么场景使用什么成果（§30.1）')
  if (input.desiredOutcome.trim().length === 0) problems.push('desiredOutcome 不能为空：期望的实际改变不能由代理指标反推（§30.1）')

  // 验收例子三态：success 必备（有例子时），boundary/failure 建议补齐但不强迫填满表单（§30.1）。
  const seenExamples = new Set<string>()
  for (const [index, example] of input.acceptanceExamples.entries()) {
    if (example.text.trim().length === 0) problems.push(`acceptanceExamples[${index}] 文本为空`)
    const key = `${example.kind}:${example.text.trim()}`
    if (seenExamples.has(key)) problems.push(`验收例子重复：${example.kind}「${example.text.trim()}」`)
    seenExamples.add(key)
  }
  if (input.acceptanceExamples.length === 0) {
    warnings.push('未提供效用验收例：简单任务可直接沿用原验收，不强迫填满表单（§30.1）')
  } else {
    if (!input.acceptanceExamples.some((example) => example.kind === 'success')) {
      problems.push('acceptanceExamples 至少要有一条 success 成功使用例：验收要连接到真实用途（§30.1）')
    }
    if (!input.acceptanceExamples.some((example) => example.kind === 'boundary')) warnings.push('缺少 boundary 边界例：建议补一条关键边界情形')
    if (!input.acceptanceExamples.some((example) => example.kind === 'failure')) warnings.push('缺少 failure 不成功例：建议给出明显不成功的使用情形')
  }

  // 指标映射："衡量哪个效果、无法代表什么"必填；mappingPending 表示映射本身尚待验证，不假装已校准（§30.1）。
  for (const [index, metric] of input.metricsAndLimits.entries()) {
    if (metric.metric.trim().length === 0) problems.push(`metricsAndLimits[${index}] 缺少指标名（metric）`)
    if (metric.represents.trim().length === 0) problems.push(`metricsAndLimits[${index}]「${metric.metric}」必须写明衡量哪个效果（represents）`)
    if (metric.cannotRepresent.trim().length === 0) problems.push(`metricsAndLimits[${index}]「${metric.metric}」必须写明无法代表什么：指标不能冒充用户效果`)
    if (metric.mappingPending === true && observation.state === 'observed') {
      warnings.push(`指标「${metric.metric}」映射尚待验证，但契约已标 observed：效果结论只能标暂定（§30.1、§30.2）`)
    }
  }

  // 硬约束必须有来源且来源不能是模型偏好；模型偏好不得冒充用户/部署/平台要求（§30.1）。
  for (const [index, entry] of input.hardConstraints.entries()) {
    if (entry.text.trim().length === 0) problems.push(`hardConstraints[${index}] 文本为空`)
    if (entry.source.trim().length === 0) problems.push(`hardConstraints[${index}]「${entry.text}」缺少来源（source）`)
    else if (isModelPreference(entry.source)) problems.push(`hardConstraints[${index}] 来源「${entry.source}」是模型偏好：硬约束必须绑定当前用户/部署/平台来源（§30.1、V5-02）`)
  }

  // 偏好未指定就保持未指定：只校验非空，不编造权重与授权（§30.1）。
  for (const [index, entry] of input.preferencesAndTradeoffs.entries()) {
    if (entry.preference.trim().length === 0) problems.push(`preferencesAndTradeoffs[${index}] 偏好文本为空`)
  }

  // 未确认假设要写明可先推进的范围，以及何时必须澄清（§30.1）。
  for (const [index, entry] of input.unresolvedAssumptions.entries()) {
    if (entry.text.trim().length === 0) problems.push(`unresolvedAssumptions[${index}] 文本为空`)
    if (entry.advanceScope.trim().length === 0) problems.push(`unresolvedAssumptions[${index}]「${entry.text}」缺少可先推进的范围（advanceScope）`)
  }

  // 效果观测：observed 必须有实际观测证据与说明，不能假报已经发生（§30.3）。
  if (observation.state === 'observed') {
    if ((observation.evidenceRefs ?? []).length === 0) problems.push('effectObservation=observed 必须带实际观测证据（evidenceRefs）：不得假报长期效果已经发生（§30.3）')
    if ((observation.note ?? '').trim().length === 0) problems.push('effectObservation=observed 必须写明观测到了什么（note）')
  }
  if (observation.state === 'outcome_pending' && (observation.note ?? '').trim().length === 0) {
    warnings.push('effectObservation=outcome_pending 建议写明等待什么使用场景来验证效果')
  }

  return { problems, warnings }
}

// —— §30.1/§30.2 变更分类与登记 ——

export type OutcomeChangeKind = 'initial' | 'non_material' | 'material'

export interface OutcomeChangeReport {
  readonly kind: OutcomeChangeKind
  readonly materialChanges: readonly string[]
  readonly recordedDeltas: readonly string[]
}

/**
 * 变更分类（§30.1、§30.2）。
 *
 * 实质变更 = 改变用户想要的成果、范围或硬约束：修改 intendedUse/desiredOutcome、
 * 增删硬约束、移除验收例子（削弱验收）、降级效果观测、移除已授权取舍。
 * 测量口径与假设澄清只作记录："在既定范围内调整测量实现则记录修订和新旧可比性"，
 * 不得借机降低验收（§30.2）。
 */
export function classifyOutcomeChange(before: OutcomeContract | undefined, after: OutcomeContract): OutcomeChangeReport {
  if (before === undefined) return { kind: 'initial', materialChanges: [], recordedDeltas: ['首次登记目标契约'] }
  const materialChanges: string[] = []
  const recordedDeltas: string[] = []
  if (before.intendedUse !== after.intendedUse) materialChanges.push(`intendedUse：「${before.intendedUse}」→「${after.intendedUse}」`)
  if (before.desiredOutcome !== after.desiredOutcome) materialChanges.push(`desiredOutcome：「${before.desiredOutcome}」→「${after.desiredOutcome}」`)
  for (const example of before.acceptanceExamples) {
    if (!after.acceptanceExamples.some((candidate) => candidate.kind === example.kind && candidate.text === example.text)) {
      materialChanges.push(`移除验收例子（${example.kind}）：「${example.text}」`)
    }
  }
  for (const entry of before.hardConstraints) {
    if (!after.hardConstraints.some((candidate) => candidate.text === entry.text && candidate.source === entry.source)) {
      materialChanges.push(`硬约束变化或移除：「${entry.text}」（原来源 ${entry.source}）`)
    }
  }
  for (const entry of after.hardConstraints) {
    if (!before.hardConstraints.some((candidate) => candidate.text === entry.text && candidate.source === entry.source)) {
      materialChanges.push(`新增硬约束：「${entry.text}」（来源 ${entry.source}）`)
    }
  }
  for (const entry of before.preferencesAndTradeoffs) {
    if (entry.authorizedBy !== undefined && !after.preferencesAndTradeoffs.some((candidate) => candidate.preference === entry.preference)) {
      materialChanges.push(`移除已授权取舍：「${entry.preference}」（授权 ${entry.authorizedBy}）`)
    }
  }
  if (EFFECT_RANK[after.effectObservation.state] < EFFECT_RANK[before.effectObservation.state]) {
    materialChanges.push(`effectObservation 降级：${before.effectObservation.state}→${after.effectObservation.state}`)
  }
  if (JSON.stringify(before.metricsAndLimits) !== JSON.stringify(after.metricsAndLimits)) {
    recordedDeltas.push('metricsAndLimits 修订：测量口径调整需记录修订与新旧可比性（§30.2）')
  }
  if (JSON.stringify(before.unresolvedAssumptions) !== JSON.stringify(after.unresolvedAssumptions)) recordedDeltas.push('unresolvedAssumptions 修订')
  if (JSON.stringify(before.preferencesAndTradeoffs) !== JSON.stringify(after.preferencesAndTradeoffs)) recordedDeltas.push('preferencesAndTradeoffs 修订')
  if (materialChanges.length === 0 && recordedDeltas.length === 0) recordedDeltas.push('原样重新登记（无字段变化）')
  return { kind: materialChanges.length > 0 ? 'material' : 'non_material', materialChanges, recordedDeltas }
}

export interface OutcomeRevisionOptions {
  readonly actorId: ActorId
  readonly now: number
  /** 谁发起本次登记/修订；只有用户与 Supervisor 能做实质变更（§30.1、§30.2）。 */
  readonly source: ActorRole | 'agent'
  readonly reason?: string
  /** 降级 effectObservation 等受限修订需要点名的授权主体（§30.2）。 */
  readonly authorizedBy?: ActorId
}

export type OutcomeRegistration =
  | {
      readonly ok: true
      readonly state: MissionControl
      readonly contract: OutcomeContract
      readonly change: OutcomeChangeReport
      readonly objectiveRevision: number
      readonly warnings: readonly string[]
    }
  | { readonly ok: false; readonly problems: readonly string[] }

/** 实质变更被允许的发起方：改变用户目标、硬约束或重大取舍由对应授权主体决定（§30.2）。 */
const AUTHORIZED_SOURCES: readonly string[] = ['user', 'supervisor']

export function registerOutcomeContract(
  state: MissionControl,
  input: OutcomeContractInput,
  options: OutcomeRevisionOptions,
): OutcomeRegistration {
  const before = state.mission.outcome
  const problems: string[] = []
  const observation: EffectObservation = input.effectObservation ?? before?.effectObservation ?? { state: 'not_required' }

  // 效果观测只允许沿 not_required → outcome_pending → observed 推进（§30.3）。
  const transition = transitionEffectObservation(before?.effectObservation ?? { state: 'not_required' }, observation.state, {
    ...(observation.evidenceRefs === undefined ? {} : { evidenceRefs: observation.evidenceRefs }),
    ...(observation.note === undefined ? {} : { note: observation.note }),
    ...(options.authorizedBy === undefined ? {} : { authorizedBy: options.authorizedBy }),
  })
  problems.push(...transition.problems)

  const validation = validateOutcomeContract({ ...input, effectObservation: observation })
  problems.push(...validation.problems)

  const contract = buildContract(input, observation, options.actorId, options.now)
  const change = classifyOutcomeChange(before, contract)
  if (change.kind === 'material' && !AUTHORIZED_SOURCES.includes(options.source)) {
    problems.push(
      `实质修订需由用户或 Supervisor 发起（本次 source=${options.source}），agent 只能整理与记录：${change.materialChanges.join('；')}（§30.1、§30.2）`,
    )
  }
  if (problems.length > 0) return { ok: false, problems }

  const material = change.kind === 'material'
  const objectiveRevision = material ? state.mission.objectiveRevision + 1 : state.mission.objectiveRevision
  const mission: Mission = { ...state.mission, outcome: contract, objectiveRevision, updatedAt: options.now }
  let next: MissionControl = { ...state, mission }
  if (material) {
    // 与 `mission.revise` 同语义：目标版本推进使旧派单与旧票失效，未完成任务回到 planned（§6.1）。
    const affected = Object.values(state.tasks).filter((task) => !TASK_TERMINAL.includes(task.status))
    const tasks: Record<string, Task> = {}
    for (const [id, task] of Object.entries(state.tasks)) {
      tasks[id] = TASK_TERMINAL.includes(task.status)
        ? { ...task, objectiveRevision }
        : { ...task, objectiveRevision, status: 'planned', currentAttemptId: undefined }
    }
    const attempts: Record<string, Attempt> = {}
    for (const [id, attempt] of Object.entries(state.attempts)) {
      const hit = affected.some((task) => task.taskId === attempt.taskId)
      attempts[id] = hit && !isTerminalAttempt(attempt.status) ? { ...attempt, status: 'cancelled', updatedAt: options.now } : attempt
    }
    next = { ...next, tasks, attempts }
  }
  const committed = commit(
    next,
    material ? 'outcome/revised' : 'outcome/registered',
    {
      change: change.kind,
      material: change.materialChanges,
      recorded: change.recordedDeltas,
      objectiveRevision,
      source: options.source,
      reason: options.reason ?? '',
    },
    options.now,
  )
  return { ok: true, state: committed, contract, change, objectiveRevision, warnings: validation.warnings }
}

function buildContract(input: OutcomeContractInput, observation: EffectObservation, actorId: ActorId, now: number): OutcomeContract {
  return {
    intendedUse: input.intendedUse.trim(),
    desiredOutcome: input.desiredOutcome.trim(),
    acceptanceExamples: input.acceptanceExamples.map((example) => ({ kind: example.kind, text: example.text.trim() })),
    metricsAndLimits: input.metricsAndLimits.map((metric) => ({
      metric: metric.metric.trim(),
      represents: metric.represents.trim(),
      cannotRepresent: metric.cannotRepresent.trim(),
      ...(metric.mappingPending === undefined ? {} : { mappingPending: metric.mappingPending }),
    })),
    hardConstraints: input.hardConstraints.map((entry) => ({ text: entry.text.trim(), source: entry.source.trim() })),
    preferencesAndTradeoffs: input.preferencesAndTradeoffs.map((entry) => ({
      preference: entry.preference.trim(),
      ...(entry.authorizedBy === undefined ? {} : { authorizedBy: entry.authorizedBy }),
    })),
    unresolvedAssumptions: input.unresolvedAssumptions.map((entry) => ({
      text: entry.text.trim(),
      advanceScope: entry.advanceScope.trim(),
      ...(entry.clarifyBy === undefined ? {} : { clarifyBy: entry.clarifyBy }),
    })),
    effectObservation: {
      state: observation.state,
      ...(observation.note === undefined ? {} : { note: observation.note.trim() }),
      ...(observation.evidenceRefs === undefined ? {} : { evidenceRefs: [...observation.evidenceRefs] }),
    },
    revisedAt: now,
    revisedBy: actorId,
  }
}

// —— §30.3 完成与效果观测分开 ——

export interface EffectTransitionOptions {
  readonly evidenceRefs?: readonly EvidenceId[]
  readonly note?: string
  /** 降级（含推翻已观测结论）必须点名授权主体，不能在原路径上静默改写（§30.2）。 */
  readonly authorizedBy?: ActorId
}

export interface EffectTransition {
  readonly ok: boolean
  readonly problems: readonly string[]
}

/**
 * 效果观测三态迁移（§30.3）：
 * - 只允许 not_required → outcome_pending → observed 逐级升格；
 * - observed 必须带实际观测证据与说明，不得假报"长期效果已经发生"；
 * - 降级（含 observed 被推翻）需要授权主体，不能看过结果后悄悄降级（§30.2）。
 */
export function transitionEffectObservation(
  current: EffectObservation,
  next: EffectObservationState,
  options: EffectTransitionOptions = {},
): EffectTransition {
  if (next === current.state) return { ok: true, problems: [] }
  const problems: string[] = []
  if (EFFECT_RANK[next] < EFFECT_RANK[current.state]) {
    if ((options.authorizedBy ?? '').trim().length === 0) {
      problems.push(`effectObservation 从 ${current.state} 降到 ${next} 需要授权主体（authorizedBy）：不得看过结果后偷偷降低验收（§30.2）`)
    }
    return { ok: problems.length === 0, problems }
  }
  if (current.state === 'not_required' && next === 'observed') {
    problems.push('不能从 not_required 直接跳到 observed：需要未来实际使用才能验证的效果先标 outcome_pending，交付完成与效果观测分开（§30.3）')
    return { ok: false, problems }
  }
  if (current.state === 'outcome_pending' && next === 'observed') {
    if ((options.evidenceRefs ?? []).length === 0) problems.push('observed 必须带实际观测证据（evidenceRefs）：不得假报长期效果已经发生（§30.3）')
    if ((options.note ?? '').trim().length === 0) problems.push('observed 必须写明观测到了什么（note）')
  }
  return { ok: problems.length === 0, problems }
}

export interface EffectUpdateOptions extends EffectTransitionOptions {
  readonly actorId: ActorId
  readonly now: number
}

export type EffectObservationUpdate =
  | { readonly ok: true; readonly state: MissionControl; readonly contract: OutcomeContract }
  | { readonly ok: false; readonly problems: readonly string[] }

/**
 * 交付后的效果观测更新。
 *
 * 不推进 objectiveRevision：观测是交付之外的独立生命周期（§30.3），
 * 不能让按版本绑定的 IntegrationReceipt 因一次观测而失效。
 */
export function updateEffectObservation(
  state: MissionControl,
  next: EffectObservationState,
  options: EffectUpdateOptions,
): EffectObservationUpdate {
  const current = state.mission.outcome
  if (current === undefined) return { ok: false, problems: ['尚未登记 OutcomeContract：先整理目标契约再谈效果观测（§30.1）'] }
  const transition = transitionEffectObservation(current.effectObservation, next, options)
  if (!transition.ok) return { ok: false, problems: transition.problems }
  const observation: EffectObservation = {
    state: next,
    ...(options.note === undefined ? {} : { note: options.note.trim() }),
    ...(options.evidenceRefs === undefined ? {} : { evidenceRefs: [...options.evidenceRefs] }),
  }
  const contract: OutcomeContract = { ...current, effectObservation: observation, revisedAt: options.now, revisedBy: options.actorId }
  const mission: Mission = { ...state.mission, outcome: contract, updatedAt: options.now }
  const committed = commit(
    { ...state, mission },
    `outcome/effect-${next}`,
    { from: current.effectObservation.state, to: next, evidenceRefs: observation.evidenceRefs?.length ?? 0, note: observation.note ?? '' },
    options.now,
  )
  return { ok: true, state: committed, contract }
}

// —— §30.2 何时复核目标效用 ——

export type OutcomeReviewTrigger =
  | 'no_contract'
  | 'milestone'
  | 'route_change'
  | 'metric_experience_divergence'
  | 'user_correction'
  | 'pre_acceptance'

export interface OutcomeReviewSignals {
  /** 关键里程碑（阶段目标达成或转入下一阶段）。 */
  readonly milestoneReached?: boolean
  /** 拟更换主要路线。 */
  readonly routeChangePlanned?: boolean
  /** 指标读数与实际体验：'consistent' 不制造额外审查（V5-01），'unknown' 不当作不一致。 */
  readonly metricVsExperience?: 'consistent' | 'divergent' | 'unknown'
  /** 用户纠正。 */
  readonly userCorrection?: boolean
  /** 整体验收前。 */
  readonly beforeOverallAcceptance?: boolean
}

export interface OutcomeReviewRequirement {
  readonly required: boolean
  readonly triggers: readonly OutcomeReviewTrigger[]
  readonly reason: string
}

/**
 * 复核触发器（§30.2）：关键里程碑、拟更换主要路线、指标与实际体验不一致、
 * 用户纠正、整体验收前。日常小步骤复用已生效契约，不每轮重新解释用户目标；
 * 指标与效果一致时不制造额外审查（V5-01）。
 */
export function outcomeReviewRequired(state: MissionControl, signals: OutcomeReviewSignals = {}): OutcomeReviewRequirement {
  const triggers: OutcomeReviewTrigger[] = []
  if (signals.milestoneReached === true) triggers.push('milestone')
  if (signals.routeChangePlanned === true) triggers.push('route_change')
  if (signals.metricVsExperience === 'divergent') triggers.push('metric_experience_divergence')
  if (signals.userCorrection === true) triggers.push('user_correction')
  if (signals.beforeOverallAcceptance === true) triggers.push('pre_acceptance')
  // 要复核却没有契约：先按已有指令自动整理一份，再回答四个问题（§30.1）。
  if (triggers.length > 0 && state.mission.outcome === undefined) triggers.unshift('no_contract')
  const required = triggers.length > 0
  const reason = required
    ? `${triggers.join(' / ')} 触发目标效用复核（§30.2）：回答四个问题并留下证据引用`
    : '无复核触发器：日常小步骤复用已生效契约，不每轮重新解释用户目标（§30.2）'
  return { required, triggers, reason }
}

export const OUTCOME_REVIEW_QUESTIONS = ['effect_changed', 'metric_evidence', 'costs_and_regressions', 'route_still_serves'] as const
export type OutcomeReviewQuestion = (typeof OUTCOME_REVIEW_QUESTIONS)[number]

export interface OutcomeReviewAnswer {
  readonly question: OutcomeReviewQuestion
  /** 本阶段改变了哪项用户效果 / 指标证据 / 代价与退步 / 路线是否仍服务于原任务。 */
  readonly answer: string
  readonly evidenceRefs: readonly string[]
  /** 未知项保留未知：没有证据时标 unknown，而不是编造结论或分数（§30.2）。 */
  readonly unknown?: boolean
}

export interface OutcomeReviewInput {
  readonly triggers: readonly OutcomeReviewTrigger[]
  readonly answers: readonly OutcomeReviewAnswer[]
  readonly conclusion: 'contract_holds' | 'contract_needs_revision' | 'needs_user_decision'
}

export interface OutcomeReviewRecord {
  readonly missionId: string
  readonly triggers: readonly OutcomeReviewTrigger[]
  readonly answers: readonly OutcomeReviewAnswer[]
  readonly conclusion: OutcomeReviewInput['conclusion']
  readonly decidedBy: ActorId
  readonly createdAt: number
}

/** 无证据的效用分数是虚构：回答里出现这些词且没有证据引用时拒绝（§30.2）。 */
const SCORE_MARKERS = ['效用分数', '效用评分', 'utility score', 'utility:']

function claimsUnsupportedScore(answer: OutcomeReviewAnswer): boolean {
  if (answer.unknown === true || answer.evidenceRefs.length > 0) return false
  const lower = answer.answer.toLowerCase()
  return SCORE_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))
}

export type OutcomeReviewBuild =
  | { readonly ok: true; readonly record: OutcomeReviewRecord }
  | { readonly ok: false; readonly problems: readonly string[] }

/**
 * 复核结论短记录（§30.2）：四个问题都要回答；每个回答要么带证据引用、
 * 要么明确标 unknown；结论不能只是"要求模型回答是否"。未知项保留未知，
 * 不要求给出虚构效用分数。
 */
export function buildOutcomeReview(
  state: MissionControl,
  input: OutcomeReviewInput,
  options: { readonly actorId: ActorId; readonly now: number },
): OutcomeReviewBuild {
  const problems: string[] = []
  if (input.triggers.length === 0) {
    problems.push('复核要写明触发原因：里程碑/换路线/指标与实际不一致/用户纠正/整体验收前（§30.2）')
  }
  const counts = new Map<OutcomeReviewQuestion, number>()
  for (const answer of input.answers) {
    counts.set(answer.question, (counts.get(answer.question) ?? 0) + 1)
    if (answer.answer.trim().length === 0) problems.push(`复核回答「${answer.question}」为空：结论不能只是让模型回答"是"（§30.2）`)
    if (answer.evidenceRefs.length === 0 && answer.unknown !== true) {
      problems.push(`复核回答「${answer.question}」既没有证据引用也未标 unknown：未知项保留未知，不能编造（§30.2）`)
    }
    if (claimsUnsupportedScore(answer)) problems.push(`复核回答「${answer.question}」给出效用分数却没有证据引用：不得虚构效用分数（§30.2）`)
  }
  for (const question of OUTCOME_REVIEW_QUESTIONS) {
    const count = counts.get(question) ?? 0
    if (count === 0) problems.push(`复核缺少问题「${question}」：四个问题都要回答（改变了哪项用户效果；指标证据；代价与退步；路线是否仍服务于原任务）`)
    if (count > 1) problems.push(`问题「${question}」重复回答`)
  }
  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    record: {
      missionId: state.missionId,
      triggers: [...input.triggers],
      answers: input.answers.map((answer) => ({ ...answer })),
      conclusion: input.conclusion,
      decidedBy: options.actorId,
      createdAt: options.now,
    },
  }
}

/** 复核记录进事件流留痕：短记录 + 证据引用数，不另建容器（§5.1 末段）。 */
export function commitOutcomeReview(state: MissionControl, record: OutcomeReviewRecord): MissionControl {
  return commit(
    state,
    'outcome/reviewed',
    {
      triggers: record.triggers,
      conclusion: record.conclusion,
      decidedBy: record.decidedBy,
      answers: record.answers.map((answer) => ({
        question: answer.question,
        unknown: answer.unknown === true,
        evidenceRefs: answer.evidenceRefs.length,
        summary: answer.answer,
      })),
    },
    record.createdAt,
  )
}
