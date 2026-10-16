/**
 * MissionControl 聚合记录（设计稿 v0.3 §5.2）。
 *
 * 为什么是一个聚合记录而不是每实体一条：本机 `storageDomain` 的 `KvTable.update` 只提供
 * **单条记录的原子 read-modify-write**，原生 SQLite 后端也不对外暴露跨记录事务。
 * 于是一次状态转换能一起提交的东西必须住在同一条记录里——v0.3 新增的承诺、授权消耗、
 * 判据/规则/证据有效性版本因此全部进这一条记录，而不是另开表。
 */
import { createHash, randomUUID } from 'node:crypto'
import type {
  Actor,
  ArtifactVersion,
  Attempt,
  AuthorizationGrant,
  BudgetLedger,
  BudgetLimits,
  Challenge,
  Checkpoint,
  ClaimRevision,
  ContextAssessment,
  ContextReceipt,
  DecisionBrief,
  DecisionDependency,
  DeliveryEntry,
  DispatchPlan,
  EnvironmentManifest,
  EvidenceRecord,
  ExperimentSpec,
  Incident,
  IntegrationPlan,
  IntegrationReceipt,
  MailboxMessage,
  MechanismPolicy,
  MechanismRun,
  Mission,
  Obligation,
  Operation,
  OutboxId,
  OutboxEntry,
  RecordCoverage,
  ResourceLease,
  ResumeAssessment,
  ReviewReceipt,
  RouteAssessment,
  RuleSpec,
  SearchReceipt,
  StrategyDecision,
  Task,
  Team,
  TrialOutcome,
  ValidatorSpec,
  Verification,
} from './entities.ts'
import { DEFAULT_BUDGET_LIMITS } from './entities.ts'

/**
 * v3：v0.5 §5.1 的实验/记录/环境/整合/治理逻辑对象，以及三类前提（§12.1）、
 * 猜想来源类别（§22.8）与证据溯源字段（§32）。旧记录同样不自动迁移：
 * 这些字段改变的是"什么算有效依据"的判定，`schemaVersion` 不符即拒绝装载（§5.3）。
 */
export const SCHEMA_VERSION = 3

/**
 * 命令去重记录的保留期；过期请求必须被拒绝，不能清空记录后当作新请求执行（§5.3）。
 * 这一层保留**完整凭据**（含结论与原因），到期后降为 {@link DedupTombstone}，见 R5。
 */
export const DEDUP_RETENTION_MS = 24 * 60 * 60 * 1000
/**
 * 墓碑凭据的保留期 = 完整凭据的 30 倍（30 天）。
 *
 * 依据：本包的重试节拍都在天内尺度——outbox 退避封顶 10 分钟、会话恢复与人工补发按天计，
 * 30 天覆盖"隔天/隔周再放一次同请求"的现实窗口。**超出窗口不等于"已被核对"**（审阅 N2）：
 * 凭据层只负责回答"这条请求的结论是什么"，它被淘汰后"不重造业务对象"的责任由
 * {@link derivedId} 的结构幂等承担——对象身份由 requestId 确定派生，重放只会落到同一 ID，
 * 转换函数见到存在即原地退回（回收进 rejected），不依赖任何保留期。
 */
export const DEDUP_TOMBSTONE_RETENTION_MS = 30 * DEDUP_RETENTION_MS
/** 墓碑表体积闸：只按 `expiredAt` 保留最近若干条，防止长期 Mission 的去重面无限增长。 */
export const MAX_DEDUP_TOMBSTONES = 2048
/** 墓碑命中时的固定判定：结果未知就必须先核对，不能当新请求执行（§5.3、审阅 R5）。 */
export const DEDUP_UNKNOWN_NOTE = '结果未知，需先核对台账'
/** 聚合记录软上限：超过就限制新任务入队并给出诊断，而不是删掉恢复所需的信息。 */
export const MAX_CONTROL_BYTES = 512 * 1024
/** 已确认事件的可归档窗口：热状态**目标**保留条数，超出部分要先落档才能裁（§5.3、审阅 R4）。 */
export const MAX_RECENT_EVENTS = 500
/** 每个集合里"仍在途"的条目全保留；已闭合条目按下面几个上限收敛。 */
export const MAX_CLOSED_CLAIMS = 200
export const MAX_CLOSED_EVIDENCE = 400
export const MAX_CLOSED_RECEIPTS = 200
export const MAX_CLOSED_DELIVERIES = 200
export const MAX_CHALLENGES = 200
/** v0.5 §5.3：实验、评估、依据包与机制运行同样按"在途全留、已闭合收敛"处理。 */
export const MAX_TRIALS = 200
export const MAX_ASSESSMENTS = 200
export const MAX_BRIEFS = 200
export const MAX_COVERAGES = 200
export const MAX_MECHANISM_RUNS = 200

export interface CommandReceipt {
  readonly requestId: string
  readonly fingerprint: string
  readonly appliedAt: number
  readonly outcome: 'applied' | 'rejected'
  readonly reason?: string
  readonly revision: number
}

/**
 * 完整凭据到期后留下的紧凑墓碑：只够认出"这个 requestId 见过"，不足以断言结论。
 *
 * 保留 `outcome` 是为了诊断（能说明当时是否推进过 revision），但命中时一律回
 * {@link DEDUP_UNKNOWN_NOTE} —— 跨天的重放可能落在与当时不同的状态上，
 * 把旧结论当作当前结论继续用，等于用凭据猜事实（审阅 R5）。
 * 两层窗口都是定义的而非隐含的：完整凭据自 `appliedAt` 起保留 {@link DEDUP_RETENTION_MS}，
 * 墓碑自 `expiredAt` 起再保留 {@link DEDUP_TOMBSTONE_RETENTION_MS}，并由条数上限封顶。
 */
export interface DedupTombstone {
  readonly requestId: string
  readonly fingerprint: string
  readonly appliedAt: number
  /** 完整凭据失效的时刻（`appliedAt + DEDUP_RETENTION_MS`），即墓碑自己保留期的起点。 */
  readonly expiredAt: number
  readonly outcome: CommandReceipt['outcome']
}

export interface ControlEvent {
  readonly seq: number
  readonly at: number
  readonly kind: string
  readonly detail: Readonly<Record<string, unknown>>
}

/**
 * 热事件窗口的落档水位（审阅 R4）。
 *
 * `throughSeq` 是**已在归档台账确认**的最大 seq：`seq <= throughSeq` 的事件才允许离开聚合记录，
 * 所以裁剪由水位闸控，而不是由"数组超长了"直接决定。缺省表示这条记录还没落过档，
 * 事件只增不减——记录变大是可诊断的，静默丢失不是。
 */
export interface EventArchiveWatermark {
  readonly throughSeq: number
  readonly batchCount: number
  readonly lastBatchId: string
  readonly lastContentHash: string
  readonly lastLocation: string
  readonly lastArchivedAt: number
}

/**
 * 已闭合记录裁剪的落档凭据（审阅 R4）。
 *
 * 凭据按裁剪计划指纹对齐：热状态只有在"当前计划指纹 == 已落档指纹"时才执行裁剪，
 * 因此任何一次删除都有对应的不可变对象批次在台账里，`archivedCounts` 也只统计真正落档的那批。
 */
export interface RecordArchiveReceipt {
  readonly planFingerprint: string
  readonly batchId: string
  readonly contentHash: string
  readonly location: string
  readonly archivedAt: number
  readonly counts: Readonly<Record<string, number>>
}

/**
 * 一个 Mission 的全部控制状态。正文、会话全文与 token 明细不得嵌入本记录（§5.3）：
 * 大段内容走对象存储，这里只放引用。
 */
export interface MissionControl {
  readonly schemaVersion: number
  /** 单调递增；每个成功提交的转换 +1。 */
  readonly revision: number
  readonly missionId: string
  readonly mission: Mission
  readonly tasks: Readonly<Record<string, Task>>
  readonly attempts: Readonly<Record<string, Attempt>>
  readonly actors: Readonly<Record<string, Actor>>
  readonly teams: Readonly<Record<string, Team>>
  readonly checkpoints: Readonly<Record<string, Checkpoint>>
  /** 检查点按写入顺序，供交接包与时间线取最近有效项。 */
  readonly checkpointOrder: readonly string[]
  readonly artifacts: Readonly<Record<string, ArtifactVersion[]>>
  readonly verifications: Readonly<Record<string, Verification>>
  readonly mailbox: Readonly<Record<string, MailboxMessage>>
  readonly operations: Readonly<Record<string, Operation>>
  readonly rotations: Readonly<Record<string, RotationRecord>>
  readonly outbox: Readonly<Record<OutboxId, OutboxEntry>>
  readonly resources: readonly ResourceLease[]
  readonly budgetLimits: BudgetLimits
  readonly budget: BudgetLedger
  readonly dedup: Readonly<Record<string, CommandReceipt>>
  /**
   * 完整凭据到期后的墓碑表（审阅 R5）。可选字段：v3 记录缺它按空表读——老记录既不迁移也不清空（§5.3），
   * 而首次到期起就会写墓碑，行为与新记录一致。
   */
  readonly dedupTombstones?: Readonly<Record<string, DedupTombstone>>
  readonly events: readonly ControlEvent[]
  /** 事件裁剪的水位闸；缺省 = 本记录尚未落档，热窗口只增不减（R4）。 */
  readonly archive?: EventArchiveWatermark
  /** 已闭合记录裁剪的落档凭据；缺省 = 尚无已确认的裁剪批次（R4）。 */
  readonly recordArchive?: RecordArchiveReceipt
  /** 用户暂停/取消/预算耗尽不因 Host 重启而复活（§11.1）。 */
  readonly admissionClosed: boolean
  readonly lastCommittedAt: number

  // —— v0.3 §5.1 证据与纪律面 ——
  /** 规则按 id 存版本链；`mission.policyRevision` 指向当前生效快照。 */
  readonly rules: Readonly<Record<string, RuleSpec[]>>
  readonly authorities: Readonly<Record<string, import('./entities.ts').AuthorityBinding>>
  readonly evidence: Readonly<Record<string, EvidenceRecord>>
  /** 结论按 id 存版本链，撤回只追加新状态，不改写历史（§22.5–22.6）。 */
  readonly claims: Readonly<Record<string, ClaimRevision[]>>
  readonly dependencies: Readonly<Record<string, DecisionDependency>>
  readonly obligations: Readonly<Record<string, Obligation>>
  readonly grants: Readonly<Record<string, AuthorizationGrant>>
  readonly searches: Readonly<Record<string, SearchReceipt>>
  readonly contexts: Readonly<Record<string, ContextReceipt>>
  readonly challenges: Readonly<Record<string, Challenge>>
  readonly incidents: Readonly<Record<string, Incident>>
  readonly validators: Readonly<Record<string, ValidatorSpec[]>>
  readonly reviews: Readonly<Record<string, ReviewReceipt>>
  readonly deliveries: Readonly<Record<string, DeliveryEntry>>
  readonly dispatches: Readonly<Record<string, DispatchPlan>>
  /**
   * 依据有效性版本（§22.6）：结论撤回/证据失效/授权撤销时递增。
   * 准入票据与缓存键都要带上它，"文件名没变"不能继续命中旧结论。
   */
  readonly basisRevision: number
  /** 因依据撤回而产生的待传播项；崩溃后从这里继续（§23.2 第 3 条）。 */
  readonly pendingPropagations: readonly {
    readonly propagationId: string
    readonly cause: string
    readonly targetKind: string
    readonly targetId: string
    readonly requiredAction: string
    readonly queuedAt: number
  }[]
  /** 已闭合条目的收敛计数，用于说明视图不是全量历史（§5.3）；只累计真正进了归档批次的那部分。 */
  readonly archivedCounts: Readonly<Record<string, number>>

  // —— v0.5 §5.1 实验、记录、环境、整合与治理面 ——
  /** 试验契约按版本链存：阶段目标与停止条件先定，调整留版本（§25.3）。 */
  readonly experiments: Readonly<Record<string, ExperimentSpec[]>>
  readonly trials: Readonly<Record<string, TrialOutcome>>
  readonly strategyDecisions: Readonly<Record<string, StrategyDecision>>
  /** 路线建议状态是当前视图；历史负结果留在 ClaimRevision 里，不在这里删除（§26.2）。 */
  readonly routes: Readonly<Record<string, RouteAssessment>>
  readonly assessments: Readonly<Record<string, ContextAssessment>>
  readonly coverages: Readonly<Record<string, RecordCoverage>>
  readonly briefs: Readonly<Record<string, DecisionBrief>>
  /** 环境清单按版本链存，恢复评估引用具体版本（§33.1、§33.3）。 */
  readonly environments: Readonly<Record<string, EnvironmentManifest[]>>
  readonly resumes: Readonly<Record<string, ResumeAssessment>>
  readonly integrations: Readonly<Record<string, IntegrationPlan>>
  readonly integrationReceipts: Readonly<Record<string, IntegrationReceipt>>
  /** 机制策略版本链，生命周期与 RuleSpec 一致（§35.1）。 */
  readonly mechanisms: Readonly<Record<string, MechanismPolicy[]>>
  readonly mechanismRuns: Readonly<Record<string, MechanismRun>>
}

/** `Rotation` 单独导出，避免与实体里的 `RotationPhase` 循环命名混淆。 */
export type RotationRecord = import('./entities.ts').Rotation

export function emptyControl(missionId: string, mission: Mission, now: number): MissionControl {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    missionId,
    mission,
    tasks: {},
    attempts: {},
    actors: {},
    teams: {},
    checkpoints: {},
    checkpointOrder: [],
    artifacts: {},
    verifications: {},
    mailbox: {},
    operations: {},
    rotations: {},
    outbox: {},
    resources: [],
    budgetLimits: DEFAULT_BUDGET_LIMITS,
    budget: {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      wallClockMs: 0,
      taskRetries: 0,
      rotations: 0,
      mailboxMessages: 0,
      governanceCalls: 0,
      governanceTokens: 0,
      governanceWallClockMs: 0,
      reservations: [],
    },
    dedup: {},
    dedupTombstones: {},
    events: [],
    admissionClosed: true,
    lastCommittedAt: now,
    rules: {},
    authorities: {},
    evidence: {},
    claims: {},
    dependencies: {},
    obligations: {},
    grants: {},
    searches: {},
    contexts: {},
    challenges: {},
    incidents: {},
    validators: {},
    reviews: {},
    deliveries: {},
    dispatches: {},
    basisRevision: 0,
    pendingPropagations: [],
    archivedCounts: {},
    experiments: {},
    trials: {},
    strategyDecisions: {},
    routes: {},
    assessments: {},
    coverages: {},
    briefs: {},
    environments: {},
    resumes: {},
    integrations: {},
    integrationReceipts: {},
    mechanisms: {},
    mechanismRuns: {},
  }
}

/** 内核统一分配 ID；调用方为重试传入稳定幂等键，三者不混用（§5.1）。 */
export function mintId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

/**
 * 由稳定幂等键派生对象身份（审阅 N2）：业务对象的 ID 是 `requestId` 的确定性函数。
 *
 * 为什么需要它：去重凭据与墓碑都是有界存储，过期或被 2048 条上限挤出后，同一 `requestId`
 * 在入口处与真正的新请求无法区分（`reproduce.mjs` 的 EXPIRED_TOMBSTONE_REPLAY /
 * TOMBSTONE_CAP_REPLAY 两条路径）。把身份本身做成派生值后，即使去重层已经忘了这条请求，
 * 重放也只能落到**同一个 ID** 上；转换函数见到该 ID 已存在就原地退回（无进展 = rejected），
 * 既不重造对象、也不覆盖既有对象。进程重启、跨天、去重表清空都不影响该性质——
 * 它不依赖任何存储的保留期。
 *
 * 与 `mintId` 的分工：`mintId` 是"新请求"的发号器，只用在没有稳定幂等键的地方
 * （如 outbox 条目自身）；同一条创建命令的重试**必须**携带同一 `requestId`（§5.1 三者不混用）。
 * `discriminator` 用于一次命令创建多个同类对象时按序号/键区分（如批量证据、派单前提依赖）。
 *
 * 边界：派生只覆盖"创建"——对既有对象的修订类命令（如 `claim.revise`）不产生新身份，
 * 其重放防护仍以凭据/墓碑的保留期为限。
 */
export function derivedId(prefix: string, requestId: string, discriminator = ''): string {
  const stem = discriminator.length === 0 ? `${prefix}:${requestId}` : `${prefix}:${requestId}:${discriminator}`
  const hex = createHash('sha256').update(stem).digest('hex').slice(0, 32)
  // 按 UUID 的分段格式输出：连字符打断纯十六进制串，交接包与视图的脱敏规则
  //（`vendor/redaction.ts` 的 HEX_BLOB 会整段抹掉 32+ 位裸十六进制）就不会把对象 ID 当成凭证。
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function put<K extends string, V>(map: Readonly<Record<K, V>>, key: K, value: V): Record<K, V> {
  return { ...map, [key]: value }
}

export function drop<K extends string, V>(map: Readonly<Record<K, V>>, key: K): Record<K, V> {
  const next: Record<string, V> = { ...map }
  delete next[key]
  return next
}

/** 近似序列化体积，用于容量守卫（§5.3）。 */
export function controlSize(state: MissionControl): number {
  return JSON.stringify(state).length
}

/**
 * 一次成功的转换：修订号 +1、追加事件、刷新提交时刻。
 *
 * 这是内核唯一的进度凭证——`dispatch()` 用 `revision` 是否增长来区分"改了状态"与
 * "原样退回"，各领域模块（实验、记录、环境、整合、治理）都必须经它提交，不能各自改 revision。
 * 事件序号按上一条 +1 且不重置；剪枝由落档水位闸控（见 {@link dropDurableEvents}），
 * `MAX_RECENT_EVENTS` 只是"落档后应保留多少条"的目标窗口，不是删除许可。
 */
export function commit(state: MissionControl, kind: string, detail: Record<string, unknown>, now: number): MissionControl {
  const seq = (state.events.at(-1)?.seq ?? -1) + 1
  const appended: ControlEvent[] = [...state.events, { seq, at: now, kind, detail }]
  return { ...state, revision: state.revision + 1, lastCommittedAt: now, events: dropDurableEvents(state, appended) }
}

/**
 * 热窗口只删台账里已有副本的事件。
 *
 * 未落档时宁可让记录变大：变大由体积守卫报出来，丢失报不出来（审阅 R4）。
 */
function dropDurableEvents(state: MissionControl, events: readonly ControlEvent[]): readonly ControlEvent[] {
  const watermark = state.archive
  if (watermark === undefined || watermark.batchCount === 0) return events
  const kept = events.filter((event) => event.seq > watermark.throughSeq)
  return kept.length === events.length ? events : kept
}

/**
 * 去重表的两层保留期收敛（审阅 R5）。
 *
 * 完整凭据到期**不**直接删除：降为墓碑，`dispatch()` 命中墓碑只能回答"结果未知"，
 * 不能回答"没见过这个请求"。墓碑另按自己的保留期与条数上限收敛，体积有界。
 * 未到期条目的处理与旧版一致（保留并截短指纹），同 requestId 的新请求 dedup 语义不变。
 */
export function pruneDedupTables(
  dedup: Readonly<Record<string, CommandReceipt>>,
  tombstones: Readonly<Record<string, DedupTombstone>> | undefined,
  now: number,
): { readonly dedup: Record<string, CommandReceipt>; readonly tombstones: Record<string, DedupTombstone> } {
  const cutoff = now - DEDUP_RETENTION_MS
  const tombstoneCutoff = now - DEDUP_TOMBSTONE_RETENTION_MS
  const next: Record<string, CommandReceipt> = {}
  const carried: Record<string, DedupTombstone> = {}
  for (const [key, value] of Object.entries(dedup)) {
    if (value.appliedAt >= cutoff) {
      next[key] = { ...value, fingerprint: value.fingerprint.slice(0, 16) }
      continue
    }
    const expiredAt = value.appliedAt + DEDUP_RETENTION_MS
    if (expiredAt >= tombstoneCutoff) carried[key] = { requestId: key, fingerprint: value.fingerprint.slice(0, 16), appliedAt: value.appliedAt, expiredAt, outcome: value.outcome }
  }
  for (const [key, value] of Object.entries(tombstones ?? {})) {
    if (key in carried) continue
    if (value.expiredAt >= tombstoneCutoff) carried[key] = value
  }
  const kept = capTombstones(carried)
  return { dedup: next, tombstones: kept }
}

/** 体积闸：按到期时刻从新到旧保留 `MAX_DEDUP_TOMBSTONES` 条，同刻按 requestId 定序保持确定性。 */
function capTombstones(tombstones: Record<string, DedupTombstone>): Record<string, DedupTombstone> {
  const items = Object.values(tombstones)
  if (items.length <= MAX_DEDUP_TOMBSTONES) return tombstones
  const kept = items
    .sort((a, b) => b.expiredAt - a.expiredAt || a.requestId.localeCompare(b.requestId))
    .slice(0, MAX_DEDUP_TOMBSTONES)
  const next: Record<string, DedupTombstone> = {}
  for (const item of kept) next[item.requestId] = item
  return next
}

/**
 * 一条要被移出热状态的不可变对象：`collection` + `id` 定位，`value` 是原样对象（不改写）。
 * 归档批次装的就是这些条目，所以读侧能拿回与当时逐字节一致的东西（§5.3、R4）。
 */
export interface ClosedRecordDrop {
  readonly collection: string
  readonly id: string
  readonly value: unknown
}

/** 一次裁剪计划：会删什么、各集合删几条、删完是什么样子，全部由当前状态确定。 */
export interface ClosedRecordPlan {
  readonly fingerprint: string
  readonly drops: readonly ClosedRecordDrop[]
  readonly counts: Readonly<Record<string, number>>
  readonly trimmed: MissionControl
}

interface TrimTally {
  readonly drops: ClosedRecordDrop[]
  readonly counts: Record<string, number>
}

/** 裁剪计划指纹：只按"会删掉哪些条目"计算，与条目内容无关——内容进归档批次的哈希。 */
export function closedRecordPlanFingerprint(drops: readonly ClosedRecordDrop[]): string {
  const canon = drops.map((drop) => `${drop.collection}:${drop.id}`).sort().join('|')
  return createHash('sha256').update(canon).digest('hex')
}

/** 算出"如果允许裁剪会删掉什么"，供落档流程先把对象写进台账再裁（R4 的硬顺序）。 */
export function planClosedRecordDrops(state: MissionControl): ClosedRecordPlan {
  const tally: TrimTally = { drops: [], counts: {} }
  const isClosedChain = (chain: readonly ClaimRevision[]): boolean => {
    const head = chain[chain.length - 1]
    return head !== undefined && (head.status === 'superseded' || head.retractedAt !== undefined)
  }
  const isClosedExperiment = (chain: readonly ExperimentSpec[]): boolean => {
    // 试验契约的版本只在被后继版本取代后才算闭合；最后一版即使在途也必须保留。
    return chain.length > 1
  }
  const isClosedMechanism = (chain: readonly MechanismPolicy[]): boolean => {
    const head = chain[chain.length - 1]
    return head !== undefined && head.status === 'retired' && chain.length > 1
  }
  const evidence = trimClosed(state.evidence, MAX_CLOSED_EVIDENCE, (record) => record.validity === 'invalid', tally, 'evidence')
  const claims = trimClosed(state.claims, MAX_CLOSED_CLAIMS, isClosedChain, tally, 'claims')
  const searches = trimClosed(state.searches, MAX_CLOSED_RECEIPTS, (record) => record.outcome !== 'incomplete', tally, 'searches')
  const contexts = trimClosed(state.contexts, MAX_CLOSED_RECEIPTS, (record) => record.acknowledged, tally, 'contexts')
  const deliveries = trimClosed(state.deliveries, MAX_CLOSED_DELIVERIES, (record) => record.stage === 'processed', tally, 'deliveries')
  const challenges = trimClosed(state.challenges, MAX_CHALLENGES, (record) => record.outcome !== 'open', tally, 'challenges')
  const trials = trimClosed(state.trials, MAX_TRIALS, (record) => record.claimRefs.length > 0, tally, 'trials')
  const assessments = trimClosed(state.assessments, MAX_ASSESSMENTS, (record) => record.actionState !== undefined && record.actionState !== 'queued' && record.actionState !== 'running', tally, 'assessments')
  const briefs = trimClosed(state.briefs, MAX_BRIEFS, () => true, tally, 'briefs')
  const coverages = trimClosed(state.coverages, MAX_COVERAGES, (record) => record.completeness !== 'unavailable', tally, 'coverages')
  const mechanismRuns = trimClosed(state.mechanismRuns, MAX_MECHANISM_RUNS, (record) => record.finishedAt !== undefined, tally, 'mechanismRuns')
  const experiments = trimChains(state.experiments, isClosedExperiment, tally, 'experiments', (key, spec) => `${key}@${spec.version}`)
  const mechanisms = trimChains(state.mechanisms, isClosedMechanism, tally, 'mechanisms', (key, policy) => `${key}@${policy.version}`)
  const trimmed: MissionControl = {
    ...state,
    ...(evidence.changed ? { evidence: evidence.next } : {}),
    ...(claims.changed ? { claims: claims.next } : {}),
    ...(searches.changed ? { searches: searches.next } : {}),
    ...(contexts.changed ? { contexts: contexts.next } : {}),
    ...(deliveries.changed ? { deliveries: deliveries.next } : {}),
    ...(challenges.changed ? { challenges: challenges.next } : {}),
    ...(trials.changed ? { trials: trials.next } : {}),
    ...(assessments.changed ? { assessments: assessments.next } : {}),
    ...(briefs.changed ? { briefs: briefs.next } : {}),
    ...(coverages.changed ? { coverages: coverages.next } : {}),
    ...(mechanismRuns.changed ? { mechanismRuns: mechanismRuns.next } : {}),
    ...(experiments.changed ? { experiments: experiments.next } : {}),
    ...(mechanisms.changed ? { mechanisms: mechanisms.next } : {}),
  }
  return {
    fingerprint: closedRecordPlanFingerprint(tally.drops),
    drops: tally.drops,
    counts: tally.counts,
    trimmed,
  }
}

/**
 * 收敛已闭合条目，保住体积而不丢恢复所需信息（§5.3）。
 *
 * 顺序是硬要求（R4）：先由 `archive.ts` 把 {@link planClosedRecordDrops} 算出的不可变对象批次
 * 写进归档台账并留下 {@link RecordArchiveReceipt}，这里才允许裁。凭据与当前计划不一致就原样返回——
 * 在途项、未闭环承诺、待传播项、未确认 outbox 本来就一律不裁，落档失败则一条都不裁。
 * `archivedCounts` 只累加真正落档的条目，视图据此说明自己不是全量历史。
 */
export function compactClosedRecords(state: MissionControl): MissionControl {
  const plan = planClosedRecordDrops(state)
  if (plan.drops.length === 0) return state
  const receipt = state.recordArchive
  if (receipt === undefined || receipt.planFingerprint !== plan.fingerprint) return state
  return applyClosedRecordPlan(state, plan)
}

/** 执行一份已确认落档的计划：删除 + 归档计数在同一次纯转换里完成。 */
export function applyClosedRecordPlan(state: MissionControl, plan: ClosedRecordPlan): MissionControl {
  const archivedCounts: Record<string, number> = { ...state.archivedCounts }
  for (const [field, count] of Object.entries(plan.counts)) {
    if (count > 0) archivedCounts[field] = (archivedCounts[field] ?? 0) + count
  }
  return { ...plan.trimmed, archivedCounts }
}

/** 把落档凭据与裁剪放在同一次转换里：先裁后记会让中途失败变成"删了但没有台账"。 */
export function withRecordArchiveReceipt(state: MissionControl, plan: ClosedRecordPlan, receipt: Omit<RecordArchiveReceipt, 'planFingerprint'>): MissionControl {
  const recordArchive: RecordArchiveReceipt = { ...receipt, planFingerprint: plan.fingerprint }
  return { ...applyClosedRecordPlan(state, plan), recordArchive }
}

/**
 * 版本链的收敛：只裁"已被后继版本取代"的旧版本，最新一版永不裁。
 *
 * 与 {@link trimClosed} 的差别是它按 id 成组——一个 id 的历史版本即使很多，
 * 裁到只剩最新版也不丢失"当前是什么"这一恢复所需信息；被裁的每一版都进裁剪计划，
 * 因此也进归档批次，计数照旧只认落档的部分。
 */
function trimChains<V>(
  chains: Readonly<Record<string, V[]>>,
  closed: (chain: readonly V[]) => boolean,
  tally: TrimTally,
  field: string,
  idOf: (key: string, value: V) => string,
): { readonly next: Readonly<Record<string, V[]>>; readonly changed: boolean } {
  let changed = false
  const next: Record<string, V[]> = {}
  for (const [key, chain] of Object.entries(chains)) {
    const head = chain[chain.length - 1]
    if (chain.length > 1 && head !== undefined && closed(chain)) {
      next[key] = [head]
      changed = true
      tally.counts[field] = (tally.counts[field] ?? 0) + chain.length - 1
      for (const value of chain.slice(0, -1)) tally.drops.push({ collection: field, id: idOf(key, value), value })
    } else {
      next[key] = chain
    }
  }
  return { next: changed ? next : chains, changed }
}

/**
 * 从一张引用表里裁掉超出上限的已闭合项，返回保留下来的部分并把裁掉的条目登记进 tally。
 *
 * 保留顺序按插入序（`Object.entries`），先裁最旧的已闭合项；未闭合项永不裁剪，
 * 所以总量可以在极端情况下仍高于 `limit`——此时由上层的体积守卫拒绝新工作并提示归档。
 */
function trimClosed<V>(
  records: Readonly<Record<string, V>>,
  limit: number,
  closed: (value: V) => boolean,
  tally: TrimTally,
  field: string,
): { readonly next: Readonly<Record<string, V>>; readonly changed: boolean } {
  const entries = Object.entries(records)
  if (entries.length <= limit) return { next: records, changed: false }
  const droppable = entries.filter(([, value]) => closed(value))
  const room = Math.max(0, limit - (entries.length - droppable.length))
  const dropped = droppable.slice(0, Math.max(0, droppable.length - room))
  if (dropped.length === 0) return { next: records, changed: false }
  tally.counts[field] = (tally.counts[field] ?? 0) + dropped.length
  const droppedIds = new Set(dropped.map(([key]) => key))
  for (const [key, value] of dropped) tally.drops.push({ collection: field, id: key, value })
  const next: Record<string, V> = {}
  for (const [key, value] of entries) if (!droppedIds.has(key)) next[key] = value
  return { next, changed: true }
}
