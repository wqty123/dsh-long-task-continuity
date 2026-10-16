/**
 * 整体工作记录与决策视图（设计稿 v0.5 §28 全节；验收情形 V4-13/V4-14 的记录面）。
 *
 * 三层读模型（§28.2）在本模块的落点：
 * - 原始证据层：`readEvidence()` 只返回内核里的索引摘要与来源指针——正文与大日志不塞进
 *   MissionControl（§5.3、§28.2），原始片段在来源侧按 ref 复核；
 * - 结构化状态层：`recordsOverview()` 直接投影 MissionControl 的确定性字段（任务、预算、
 *   水位、阻断），Scheduler/Supervisor 依据这些字段工作，不靠自行读懂自然语言日志（§28.3）；
 * - 决策视图层：`prepareBrief()` / `recordsQuery()` 输出有界、可追溯的支持/反证/未决分拣，
 *   每条视图都带覆盖回执与水位，随时可核回原始记录（§28.2、§28.4）。
 *
 * 三条不变量：
 * 1. 全局边界先于读取（§28.1）：读取永远限定在当前 Mission 的已登记记录里，"没找到"只对
 *    已覆盖范围成立，不声称磁盘全历史、用户其他任务或不存在的外部记录；
 * 2. 不同会话分别读出的快照不声称跨会话原子性（§28.4）：覆盖回执逐来源带水位与持久性，
 *    新鲜度检查只按"与该决定有关的版本"重新校验，无关进展不使提案反复失效；
 * 3. 状态写入一律经 `control.commit()`（§5.2）：本模块只做组装与校验，修订号与事件流由内核
 *    统一推进，不直接改 `revision` / `events`。
 */

import { commit, mintId, put } from './control.ts'
import type { MissionControl } from './control.ts'
import { blockingChallenge, ineffectiveClaimRefs, openObligations } from './discipline.ts'
import type {
  ActorId,
  ActorRole,
  ClaimId,
  ClaimRevision,
  CoverageId,
  DecisionBrief,
  EvidenceId,
  EvidenceRecord,
  MissionId,
  MissionStatus,
  RecordCoverage,
  TaskId,
  Validity,
} from './entities.ts'
import { INEFFECTIVE_RESULTS } from './entities.ts'

/** §28.1 全局边界声明：视图、增量与读取回执都要带这句话，不能静默地把范围当全量。 */
export const GLOBAL_BOUNDARY_NOTE =
  '读取范围只覆盖当前 Mission 的已登记记录（不含磁盘其余文件、用户其他任务与不存在的外部记录）；接入前的工作只按实际找到的证据标记覆盖（§28.1）'

// ────────────────────────────── 覆盖回执（§28.4）──────────────────────────────

export type SourceDurability = 'durable' | 'session_only' | 'volatile'
export type CoverageCompleteness = 'complete_within_scope' | 'partial' | 'unavailable'

const DURABILITIES: readonly SourceDurability[] = ['durable', 'session_only', 'volatile']
const COMPLETENESS_VALUES: readonly CoverageCompleteness[] = ['complete_within_scope', 'partial', 'unavailable']

/** 覆盖回执的构造输入：id 与缺省水位由本模块补齐，来源切面由读取方如实提供。 */
export interface CoverageInput {
  /** 幂等键（可选）：命令层由 requestId 派生注入；缺省由模块发号（复审 N2 阶段 2）。 */
  readonly coverageId?: CoverageId
  readonly sourceCuts: readonly { readonly source: string; readonly watermark: string; readonly durability: SourceDurability }[]
  readonly completeness: CoverageCompleteness
  readonly asOfMissionRevision?: number
  readonly filters?: readonly string[]
  readonly pages?: number
  readonly truncated?: boolean
  readonly errors?: readonly string[]
  readonly unresolvedConflicts?: readonly string[]
}

export interface CoverageAssessment {
  readonly ok: boolean
  /** 阻断项：回执本身自相矛盾或越界，不能采信。 */
  readonly blockers: readonly string[]
  /** 非阻断边界：采信这份回执时必须一起转述的事实（持久性、截断、跨会话非原子等）。 */
  readonly caveats: readonly string[]
  readonly reason: string
}

/**
 * 覆盖回执的校验（§28.4）。
 *
 * 正例标准是"能拦住错误"（DG-10 口径）：声称 `complete_within_scope` 却带截断、查询错误、
 * 未解决冲突或空来源清单的，一律拦下——"查完了"的说法必须与事实上可核的字段一致。
 */
export function assessCoverage(coverage: RecordCoverage, state?: MissionControl): CoverageAssessment {
  const blockers: string[] = []
  const caveats: string[] = []
  if (coverage.coverageId.trim().length === 0) blockers.push('覆盖回执缺少 coverageId')
  if (!COMPLETENESS_VALUES.includes(coverage.completeness)) {
    blockers.push(`completeness 值 ${String(coverage.completeness)} 不在三值（complete_within_scope/partial/unavailable）内（§28.4）`)
  }
  const seenSources = new Map<string, number>()
  for (const cut of coverage.sourceCuts) {
    if (cut.source.trim().length === 0) blockers.push('sourceCuts 存在空来源名')
    if (cut.watermark.trim().length === 0) blockers.push(`来源 ${cut.source} 缺水位：只报"读过"不能复核，水位是锚点（§28.4）`)
    if (!DURABILITIES.includes(cut.durability)) {
      blockers.push(`来源 ${cut.source} 的持久性 ${String(cut.durability)} 不在 durable/session_only/volatile 三值内`)
    }
    const count = (seenSources.get(cut.source) ?? 0) + 1
    seenSources.set(cut.source, count)
    if (count === 2) blockers.push(`来源 ${cut.source} 出现多个水位：同一来源的切面必须唯一`)
    if (cut.durability !== 'durable') {
      caveats.push(`来源 ${cut.source} 持久性为 ${cut.durability}：重启或会话结束后不可再核对，引用时要保留这条边界`)
    }
  }
  if (coverage.pages !== undefined && (!Number.isInteger(coverage.pages) || coverage.pages < 0)) {
    blockers.push(`pages=${String(coverage.pages)} 不是非负整数`)
  }
  if (coverage.completeness === 'complete_within_scope') {
    if (coverage.truncated) blockers.push('声称 complete_within_scope 却带截断标志：查完的说法不成立（§28.4）')
    if (coverage.errors.length > 0) blockers.push(`声称 complete_within_scope 却带查询错误：${coverage.errors.join(' / ')}`)
    if (coverage.unresolvedConflicts.length > 0) {
      blockers.push(`声称 complete_within_scope 却带未解决冲突：${coverage.unresolvedConflicts.join(' / ')}`)
    }
    if (coverage.sourceCuts.length === 0) blockers.push('没有任何来源水位就不能声称 complete_within_scope（§28.1：边界先于结论）')
  } else if (coverage.completeness === 'unavailable') {
    caveats.push('读取不可用：相关全局性断言按证据不足标记，只有不依赖缺失记录的动作可继续（§28.4）')
  } else {
    caveats.push('读取只覆盖部分范围：对外断言必须转述这条限制，不能当作全团队/全历史结论（§28.4）')
  }
  if (coverage.truncated) caveats.push('结果被截断：只取到部分材料，不能据此宣布"没有"（§22.2 DG-02 口径）')
  if (coverage.errors.length > 0) caveats.push(`存在查询错误：${coverage.errors.join(' / ')}`)
  if (coverage.filters.length > 0) caveats.push(`应用了过滤条件：${coverage.filters.join(' / ')}`)
  if (coverage.unresolvedConflicts.length > 0) {
    caveats.push(`存在未解决冲突：读模型须同时呈现支持与反证，不制造一致意见（§32.3、§34.2）`)
  }
  caveats.push(`本轮按 ${coverage.sourceCuts.length} 个来源切面分别读取，不声称跨会话原子性（§28.4）`)
  if (state !== undefined) {
    if (coverage.missionId !== state.missionId) {
      blockers.push(`覆盖回执属于 ${coverage.missionId}，不是当前 Mission ${state.missionId}`)
    }
    if (coverage.asOfMissionRevision > state.revision) {
      blockers.push(`水位 ${coverage.asOfMissionRevision} 晚于当前修订 ${state.revision}：记录不一致，按被污染处理`)
    } else if (coverage.asOfMissionRevision < state.revision) {
      caveats.push(`回执记录于修订 ${coverage.asOfMissionRevision}，之后又有 ${state.revision - coverage.asOfMissionRevision} 次提交：读取只到该水位`)
    }
  }
  const ok = blockers.length === 0
  return {
    ok,
    blockers,
    caveats,
    reason: ok
      ? `覆盖回执可用（${coverage.completeness}，${coverage.sourceCuts.length} 个来源切面）`
      : `覆盖回执被拦下：${blockers[0] ?? '存在阻断项'}`,
  }
}

export type CoverageBuildResult =
  | { readonly ok: true; readonly coverage: RecordCoverage; readonly caveats: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly blockers: readonly string[] }

/** 组装覆盖回执：id 由 `mintId` 发，缺省水位取当前修订（§5.1、§28.4）。 */
export function buildCoverage(state: MissionControl, input: CoverageInput, now: number): CoverageBuildResult {
  const coverage: RecordCoverage = {
    coverageId: input.coverageId ?? mintId('cvr'),
    missionId: state.missionId,
    asOfMissionRevision: input.asOfMissionRevision ?? state.revision,
    sourceCuts: input.sourceCuts,
    filters: input.filters ?? [],
    pages: input.pages,
    truncated: input.truncated ?? false,
    errors: input.errors ?? [],
    unresolvedConflicts: input.unresolvedConflicts ?? [],
    completeness: input.completeness,
    createdAt: now,
  }
  const assessment = assessCoverage(coverage, state)
  return assessment.ok
    ? { ok: true, coverage, caveats: assessment.caveats }
    : { ok: false, reason: assessment.reason, blockers: assessment.blockers }
}

export type CoverageRecordResult =
  | { readonly ok: true; readonly state: MissionControl; readonly coverage: RecordCoverage }
  | { readonly ok: false; readonly reason: string; readonly blockers: readonly string[] }

/** 登记覆盖回执：只追加不覆盖，状态变更经 `commit()` 提交（§5.2、§28.4）。 */
export function recordCoverage(state: MissionControl, coverage: RecordCoverage, now: number): CoverageRecordResult {
  if (state.coverages[coverage.coverageId] !== undefined) {
    return { ok: false, reason: `覆盖回执 ${coverage.coverageId} 已存在：记录只追加，不覆盖已有回执`, blockers: [] }
  }
  const assessment = assessCoverage(coverage, state)
  if (!assessment.ok) return { ok: false, reason: assessment.reason, blockers: assessment.blockers }
  const next = commit(
    { ...state, coverages: put(state.coverages, coverage.coverageId, coverage) },
    'records/coverage-recorded',
    {
      coverageId: coverage.coverageId,
      completeness: coverage.completeness,
      sources: coverage.sourceCuts.map((cut) => `${cut.source}@${cut.watermark}`).join(','),
      truncated: coverage.truncated,
      asOfMissionRevision: coverage.asOfMissionRevision,
    },
    now,
  )
  return { ok: true, state: next, coverage }
}

// ────────────────────────────── 决定依据包（§28.4、§28.5）──────────────────────────────

/** 结论在决定视图里的姿态（§32.3）：有反证 / 目前不支持 / 尚未调查 / 存在争议分别落格。 */
export type ClaimStance = 'supported' | 'contradicted' | 'unresolved'

export interface ClaimClassification {
  readonly stance: ClaimStance
  readonly reason: string
  /** 该结论能否继续作为当前依据；不能时给出可转述的阻断语（§32.3）。 */
  readonly blocker?: string
}

/**
 * 结论分拣的机械口径：状态 + 证据有效性 + 撤回/争议标记，不做语义判断。
 *
 * 口径说明：`refuted` 是"有反证"；支持与反证并存是"存在争议"，落 `unresolved`，
 * 不能假装一致（§32.3、§34.2）。
 */
export function classifyClaim(state: MissionControl, claim: ClaimRevision): ClaimClassification {
  const ref = `${claim.claimId}@${claim.version}`
  if (claim.retractedAt !== undefined) {
    return {
      stance: 'unresolved',
      reason: `${ref} 已撤回（${claim.retractionReason ?? '未写原因'}）`,
      blocker: `结论 ${ref} 已撤回：不能作为当前依据，沿已声明依赖更新后再用（§32.3）`,
    }
  }
  if (INEFFECTIVE_RESULTS.includes(claim.validity)) {
    return {
      stance: 'unresolved',
      reason: `${ref} 依据有效性为 ${claim.validity}`,
      blocker: `结论 ${ref} 有效性为 ${claim.validity}：先复核再使用（§32.3）`,
    }
  }
  if (claim.status === 'supported') {
    const staleSupport = claim.supportingEvidenceIds.filter((id) => {
      const evidence = state.evidence[id]
      return evidence === undefined || INEFFECTIVE_RESULTS.includes(evidence.validity)
    })
    if (staleSupport.length > 0) {
      return {
        stance: 'unresolved',
        reason: `${ref} 的支撑证据失效或缺失：${staleSupport.join(', ')}`,
        blocker: `结论 ${ref} 的支撑证据已失效，不得作为当前依据（§32.3）`,
      }
    }
    if (claim.contradictingEvidenceIds.length > 0) {
      return {
        stance: 'unresolved',
        reason: `${ref} 支持与反证并存（存在争议）：按裁决流程处理，不制造一致意见（§34.2）`,
      }
    }
    return { stance: 'supported', reason: `${ref} 的支持证据在当前版本下有效` }
  }
  if (claim.status === 'refuted') {
    return {
      stance: 'contradicted',
      reason: `${ref} 已被反证`,
      blocker: `目标结论 ${ref} 有反证：决定不能建立在它之上（§32.1、§32.3）`,
    }
  }
  if (claim.status === 'proposed') return { stance: 'unresolved', reason: `${ref} 尚未评估（proposed）` }
  return { stance: 'unresolved', reason: `${ref} 目前不支持（${claim.status}）` }
}

/** `decisions.prepare` 的组装输入（§28.5）：targetRefs 里 `claim:<id>` 前缀项会自动并入结论分拣。 */
export interface BriefInput {
  /** 幂等键（可选）：命令层由 requestId 派生注入；缺省由模块发号（复审 N2 阶段 2）。 */
  readonly briefId?: DecisionBrief['briefId']
  readonly kind: DecisionBrief['kind']
  readonly targetRefs: readonly string[]
  readonly preparedBy: ActorId
  readonly claimRefs?: readonly ClaimId[]
  readonly criteriaRefs?: readonly string[]
  readonly coverageId?: CoverageId
  readonly asOfMissionRevision?: number
  readonly extraBlockers?: readonly string[]
}

export type BriefPrepareResult = { readonly ok: true; readonly brief: DecisionBrief } | { readonly ok: false; readonly reason: string }

/**
 * 组装决定依据包（§28.4、§28.5）。
 *
 * 覆盖回执：显式绑定优先，缺省取该 Mission 最新一份；一份都没有时仍产出依据包，但在
 * `blockers` 里明示"缺覆盖"且 `coverageId` 留空——这样的包不能登记为放行依据（见
 * `recordBrief`），只能用来展示还缺什么。
 */
export function prepareBrief(state: MissionControl, input: BriefInput, now: number): BriefPrepareResult {
  if (input.preparedBy.trim().length === 0) return { ok: false, reason: '决定依据包必须有 preparedBy：谁组装的要署名（§28.3）' }
  const blockers: string[] = []
  const supportedRefs: string[] = []
  const contradictedRefs: string[] = []
  const unresolvedRefs: string[] = []
  const claimVersions: Record<ClaimId, number> = {}

  let coverageId: CoverageId = ''
  const coverage = resolveCoverage(state, input.coverageId, blockers)
  if (coverage !== undefined) {
    coverageId = coverage.coverageId
    if (coverage.missionId !== state.missionId) {
      blockers.push(`覆盖回执 ${coverage.coverageId} 属于 ${coverage.missionId}，不是当前 Mission`)
    }
    if (coverage.completeness === 'unavailable') {
      blockers.push(`覆盖范围不可用（${coverage.coverageId}）：依赖缺失记录的动作不得放行（§28.4）`)
    } else if (coverage.completeness === 'partial') {
      blockers.push(`覆盖不完整（partial，${coverage.coverageId}）：决定只对已读范围成立，全局性断言必须明示不足（§28.4）`)
    }
    if (coverage.truncated) blockers.push(`读取被截断（${coverage.coverageId}）：不能把"没读到"当作"不存在"（§22.2 DG-02 口径）`)
    if (coverage.errors.length > 0) blockers.push(`查询错误未清（${coverage.coverageId}）：${coverage.errors.join(' / ')}`)
    if (coverage.unresolvedConflicts.length > 0) {
      blockers.push(`存在未解决冲突（${coverage.coverageId}）：${coverage.unresolvedConflicts.join(' / ')}`)
    }
  }

  for (const claimId of collectClaimRefs(input)) {
    const chain = state.claims[claimId]
    const head = chain?.[chain.length - 1]
    if (head === undefined) {
      unresolvedRefs.push(`${claimId}@?`)
      blockers.push(`引用了未登记的结论 ${claimId}：引用编号本身不是依据`)
      continue
    }
    claimVersions[claimId] = head.version
    const classification = classifyClaim(state, head)
    const ref = `${claimId}@${head.version}`
    if (classification.stance === 'supported') supportedRefs.push(ref)
    else if (classification.stance === 'contradicted') contradictedRefs.push(ref)
    else unresolvedRefs.push(ref)
    if (classification.blocker !== undefined) blockers.push(classification.blocker)
  }
  for (const extra of input.extraBlockers ?? []) blockers.push(extra)

  const brief: DecisionBrief = {
    briefId: input.briefId ?? mintId('brf'),
    missionId: state.missionId,
    kind: input.kind,
    targetRefs: [...input.targetRefs],
    asOfMissionRevision: input.asOfMissionRevision ?? state.revision,
    policyRevision: state.mission.policyRevision,
    claimVersions,
    criteriaRefs: [...(input.criteriaRefs ?? [])].sort(),
    coverageId,
    supportedRefs,
    contradictedRefs,
    unresolvedRefs,
    blockers,
    preparedBy: input.preparedBy,
    createdAt: now,
  }
  return { ok: true, brief }
}

function collectClaimRefs(input: BriefInput): ClaimId[] {
  const ids = new Set<ClaimId>(input.claimRefs ?? [])
  for (const ref of input.targetRefs) {
    if (!ref.startsWith('claim:')) continue
    const id = ref.slice('claim:'.length).split('@')[0] ?? ''
    if (id.trim().length > 0) ids.add(id.trim())
  }
  return [...ids].sort()
}

function resolveCoverage(state: MissionControl, wanted: CoverageId | undefined, blockers: string[]): RecordCoverage | undefined {
  if (wanted !== undefined) {
    const found = state.coverages[wanted]
    if (found === undefined) blockers.push(`显式绑定的覆盖回执 ${wanted} 不在记录中：先补齐再签发（§28.4）`)
    return found
  }
  const latest = latestMissionCoverage(state)
  if (latest === undefined) blockers.push('没有可绑定的覆盖回执：重要决定不得在不知道覆盖范围的情况下签发（§28.4）')
  return latest
}

export type BriefVerdict = 'current' | 'behind_unrelated' | 'stale'

export interface BriefFreshness {
  readonly verdict: BriefVerdict
  /** `stale` 才不可用；`behind_unrelated` 按 §28.4"无关进展不必使提案反复失效"继续可用。 */
  readonly usable: boolean
  /** 与决定有关的版本漂移（规则快照、结论水位、覆盖回执、记录一致性）。 */
  readonly drifts: readonly string[]
  readonly reasons: readonly string[]
}

/**
 * 依据包的新鲜度检查（§28.4）。
 *
 * 重要路线关闭、发布和重新派单执行前都要跑：只按"与该决定有关的版本"重新校验；
 * 水位落后但相关版本全未变化时给 `behind_unrelated`（可用），不反复失效所有提案；
 * 规则快照、结论水位/有效性或覆盖回执发生变化即 `stale`，先刷新再决策。
 */
export function assessBriefFreshness(state: MissionControl, brief: DecisionBrief): BriefFreshness {
  const drifts: string[] = []
  const reasons: string[] = []
  if (brief.missionId !== state.missionId) drifts.push(`依据包属于 ${brief.missionId}，当前 Mission 是 ${state.missionId}`)
  if (brief.coverageId.length === 0) {
    drifts.push('依据包没有绑定覆盖回执：登记前必须补一份覆盖读取（§28.4）')
  } else if (state.coverages[brief.coverageId] === undefined) {
    drifts.push(`覆盖回执 ${brief.coverageId} 已不在记录中`)
  }
  if (brief.policyRevision !== state.mission.policyRevision) {
    drifts.push(`规则快照 ${brief.policyRevision}→${state.mission.policyRevision}：旧依据包代表的生效规则已变化`)
  }
  for (const claimId of Object.keys(brief.claimVersions).sort()) {
    const cited = brief.claimVersions[claimId]
    const chain = state.claims[claimId]
    const head = chain?.[chain.length - 1]
    if (cited === undefined || chain === undefined || head === undefined) {
      drifts.push(`结论 ${claimId} 已不在记录中`)
      continue
    }
    const record = chain.find((item) => item.version === cited)
    if (record === undefined) {
      drifts.push(`结论 ${claimId}@${cited} 版本不存在`)
      continue
    }
    if (head.version !== cited) {
      drifts.push(`结论 ${claimId} 水位 ${cited}→${head.version}：引用之后又有修订`)
      continue
    }
    if (record.retractedAt !== undefined) {
      drifts.push(`结论 ${claimId}@${cited} 已被撤回`)
      continue
    }
    if (INEFFECTIVE_RESULTS.includes(record.validity)) drifts.push(`结论 ${claimId}@${cited} 有效性已变化（${record.validity}）`)
  }
  if (brief.asOfMissionRevision > state.revision) {
    drifts.push(`记录水位 ${brief.asOfMissionRevision} 晚于当前修订 ${state.revision}：记录不一致，按被污染处理`)
  }
  if (drifts.length > 0) {
    reasons.push('与决定有关的版本或水位发生变化：按当前记录刷新依据包后再决策（§28.4）')
    return { verdict: 'stale', usable: false, drifts, reasons }
  }
  if (brief.asOfMissionRevision < state.revision) {
    reasons.push(`登记后又有 ${state.revision - brief.asOfMissionRevision} 次提交，但与本决定有关的版本没有变化：无关进展不使提案反复失效（§28.4）`)
    return { verdict: 'behind_unrelated', usable: true, drifts, reasons }
  }
  reasons.push('水位与相关版本均为当前值')
  return { verdict: 'current', usable: true, drifts, reasons }
}

export type BriefRecordResult =
  | { readonly ok: true; readonly state: MissionControl; readonly freshness: BriefFreshness }
  | { readonly ok: false; readonly reason: string; readonly drifts: readonly string[] }

/** 登记依据包：已失效或缺覆盖的包不得登记为放行依据（§28.4）。 */
export function recordBrief(state: MissionControl, brief: DecisionBrief, now: number): BriefRecordResult {
  // 无论拒绝理由先算新鲜度：登记被拒时要能对回具体漂移（含"已存在"时的相关版本变化）。
  const freshness = assessBriefFreshness(state, brief)
  if (state.briefs[brief.briefId] !== undefined) {
    return { ok: false, reason: `依据包 ${brief.briefId} 已存在：只追加不覆盖`, drifts: freshness.drifts }
  }
  if (brief.preparedBy.trim().length === 0) return { ok: false, reason: '依据包必须有 preparedBy', drifts: freshness.drifts }
  if (!freshness.usable) {
    return { ok: false, reason: '依据包在登记时已失效：按当前版本刷新后再登记（§28.4）', drifts: freshness.drifts }
  }
  const next = commit(
    { ...state, briefs: put(state.briefs, brief.briefId, brief) },
    'records/brief-recorded',
    {
      briefId: brief.briefId,
      kind: brief.kind,
      coverageId: brief.coverageId,
      supported: brief.supportedRefs.length,
      contradicted: brief.contradictedRefs.length,
      unresolved: brief.unresolvedRefs.length,
      blockers: brief.blockers.length,
    },
    now,
  )
  return { ok: true, state: next, freshness }
}

// ────────────────────────────── 三层读模型查询（§28.2、§28.5）──────────────────────────────

export interface OverviewRequest {
  readonly role: ActorRole
  readonly actorId?: ActorId
  readonly sinceRevision?: number
  /** Teammate/Subagent 的自身任务范围；缺省时按该 actorId 的尝试绑定推导。 */
  readonly taskRefs?: readonly TaskId[]
}

export interface OverviewTask {
  readonly taskId: TaskId
  readonly title: string
  readonly scope: string
  readonly status: string
  readonly validity: Validity
  readonly workKind?: string
}

export interface OverviewBudget {
  readonly limits: { readonly maxTotalTokens: number; readonly maxModelCalls: number }
  readonly used: { readonly inputTokens: number; readonly outputTokens: number; readonly modelCalls: number }
}

export interface OverviewCoverage {
  readonly coverageId: CoverageId
  readonly asOfMissionRevision: number
  readonly completeness: CoverageCompleteness
  readonly truncated: boolean
  readonly errorCount: number
  readonly conflictCount: number
  readonly sourceCount: number
}

export interface RecordsOverview {
  readonly missionId: MissionId
  readonly role: ActorRole
  readonly scope: 'mission' | 'own_tasks'
  readonly revision: number
  readonly status: MissionStatus
  readonly objective: string
  readonly watermarks: { readonly objectiveRevision: number; readonly policyRevision: number; readonly basisRevision: number }
  readonly sharedConstraints: readonly string[]
  readonly tasks: readonly OverviewTask[]
  readonly budget?: OverviewBudget
  readonly coverage?: OverviewCoverage
  readonly blockers: readonly string[]
  readonly corrections: readonly {
    readonly propagationId: string
    readonly cause: string
    readonly targetKind: string
    readonly targetId: string
    readonly requiredAction: string
  }[]
  readonly delta: {
    readonly sinceRevision?: number
    readonly events: readonly { readonly seq: number; readonly at: number; readonly kind: string }[]
    readonly omitted: number
    readonly truncated: boolean
    readonly note: string
  }
  readonly notes: readonly string[]
}

/** 只拿自身任务明细的角色（§28.3 Teammate/Subagent）；其余角色读全局投影。 */
const BOUNDED_ROLES: readonly ActorRole[] = ['member', 'subagent']
/** 可见资源/预算的角色（§28.3）。 */
const BUDGET_ROLES: readonly ActorRole[] = ['supervisor', 'lead', 'user']

function actorTaskIds(state: MissionControl, request: OverviewRequest): Set<TaskId> {
  const ids = new Set<TaskId>(request.taskRefs ?? [])
  if (request.actorId !== undefined) {
    for (const attempt of Object.values(state.attempts)) {
      if (attempt.actorId === request.actorId) ids.add(attempt.taskId)
    }
  }
  return ids
}

/**
 * `records.overview(missionId, role, sinceRevision)` 的落实（§28.5）：
 * 当前概览 + 增量 + 覆盖信息，按 §28.3 的角色可见范围裁剪。
 */
export function recordsOverview(state: MissionControl, request: OverviewRequest): RecordsOverview {
  const bounded = BOUNDED_ROLES.includes(request.role)
  const own = bounded ? actorTaskIds(state, request) : undefined
  const allTasks = Object.values(state.tasks).sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0))
  const tasks = own === undefined ? allTasks : allTasks.filter((task) => own.has(task.taskId))
  const notes: string[] = [GLOBAL_BOUNDARY_NOTE]

  const blockers: string[] = []
  for (const obligation of openObligations(state)) {
    if (own !== undefined && (obligation.taskId === undefined || !own.has(obligation.taskId))) continue
    blockers.push(`未闭环承诺 ${obligation.obligationId}：${obligation.statement}`)
  }
  for (const task of tasks) {
    const challengeId = blockingChallenge(state, task.taskId)
    if (challengeId !== undefined) blockers.push(`任务 ${task.taskId} 被硬冲突质疑 ${challengeId} 阻断`)
  }
  if (own === undefined) {
    for (const ref of ineffectiveClaimRefs(state)) blockers.push(`结论有效性不足 ${ref}：准入与投影都要按当前版本复核`)
  }

  const corrections = state.pendingPropagations
    .filter((item) => own === undefined || (item.targetKind === 'task' && own.has(item.targetId)))
    .map((item) => ({
      propagationId: item.propagationId,
      cause: item.cause,
      targetKind: item.targetKind,
      targetId: item.targetId,
      requiredAction: item.requiredAction,
    }))

  const latestCoverage = latestMissionCoverage(state)
  const coverage: OverviewCoverage | undefined =
    latestCoverage === undefined
      ? undefined
      : {
          coverageId: latestCoverage.coverageId,
          asOfMissionRevision: latestCoverage.asOfMissionRevision,
          completeness: latestCoverage.completeness,
          truncated: latestCoverage.truncated,
          errorCount: latestCoverage.errors.length,
          conflictCount: latestCoverage.unresolvedConflicts.length,
          sourceCount: latestCoverage.sourceCuts.length,
        }
  if (latestCoverage === undefined) {
    notes.push('尚无覆盖回执：全局性断言按证据不足标记，先做一次覆盖读取再签发重要决定（§28.4）')
  } else if (latestCoverage.completeness !== 'complete_within_scope') {
    notes.push(`最近覆盖回执为 ${latestCoverage.completeness}：视图只对已读范围成立（${latestCoverage.coverageId}）`)
  }

  const delta = buildDelta(state, request, own)
  notes.push(...delta.notes)

  if (bounded) {
    notes.push('默认给紧凑概览与自身任务相关记录；全量历史每轮注入会加重重复、陈旧和费用（§28.3）')
    if (request.role === 'subagent') notes.push('记录查询范围有限：不足时申请补充，不冒充全知（§28.3）')
  }
  if (request.role === 'supervisor') notes.push('Scheduler/Supervisor 只按结构化字段与回执工作，不自行解读自然语言日志（§28.3）')
  if (request.role === 'lead') notes.push('重要决定前用 decisions.prepare 组装依据包，并在执行前按相关版本复核（§28.4）')
  if (request.role === 'reviewer') {
    const pending = allTasks.filter((task) => task.status === 'submitted' || task.status === 'verifying').length
    notes.push(`待验收任务 ${pending} 个；按独立性要求可选盲审或事后对照，避免提前暴露预期答案（§28.3）`)
  }

  const budget: OverviewBudget | undefined = BUDGET_ROLES.includes(request.role)
    ? {
        limits: { maxTotalTokens: state.budgetLimits.maxTotalTokens, maxModelCalls: state.budgetLimits.maxModelCalls },
        used: { inputTokens: state.budget.inputTokens, outputTokens: state.budget.outputTokens, modelCalls: state.budget.modelCalls },
      }
    : undefined

  return {
    missionId: state.missionId,
    role: request.role,
    scope: bounded ? 'own_tasks' : 'mission',
    revision: state.revision,
    status: state.mission.status,
    objective: state.mission.objective,
    watermarks: {
      objectiveRevision: state.mission.objectiveRevision,
      policyRevision: state.mission.policyRevision,
      basisRevision: state.basisRevision,
    },
    sharedConstraints: state.mission.constraints,
    tasks: tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      scope: task.scope,
      status: task.status,
      validity: task.validity,
      workKind: task.workKind,
    })),
    budget,
    coverage,
    blockers,
    corrections,
    delta: { sinceRevision: request.sinceRevision, events: delta.events, omitted: delta.omitted, truncated: delta.truncated, note: delta.note },
    notes,
  }
}

/**
 * 取该 Mission 最新一份覆盖回执：按 createdAt 取最大；同毫秒并列时以登记顺序为准
 * （覆盖记录只追加，后登记的一份才是更新的；不拿随机 ID 排序掷硬币）。
 */
function latestMissionCoverage(state: MissionControl): RecordCoverage | undefined {
  let latest: RecordCoverage | undefined
  for (const coverage of Object.values(state.coverages)) {
    if (coverage.missionId !== state.missionId) continue
    if (latest === undefined || coverage.createdAt >= latest.createdAt) latest = coverage
  }
  return latest
}

function buildDelta(
  state: MissionControl,
  request: OverviewRequest,
  own: ReadonlySet<TaskId> | undefined,
): { events: readonly { seq: number; at: number; kind: string }[]; omitted: number; truncated: boolean; note: string; notes: readonly string[] } {
  const notes: string[] = []
  const since = request.sinceRevision
  // 事件 seq 与修订号同步推进：第 r 次提交产生 revision=r 与 seq=r-1，所以增量取 seq >= since。
  const candidates = since === undefined ? state.events : state.events.filter((event) => event.seq >= since)
  if (since === undefined) {
    notes.push('未指定 sinceRevision：给出保留窗口内的最近事件，需要精确增量时带上水位重查（§28.5）')
  } else if (since > state.revision) {
    notes.push(`sinceRevision=${since} 晚于当前修订 ${state.revision}：没有可展示的增量（水位来自未来）`)
  }
  let omitted = 0
  const kept: { seq: number; at: number; kind: string }[] = []
  for (const event of candidates) {
    if (own !== undefined) {
      const detail = JSON.stringify(event.detail)
      const related = [...own].some((taskId) => detail.includes(taskId))
      if (!related) {
        omitted += 1
        continue
      }
    }
    kept.push({ seq: event.seq, at: event.at, kind: event.kind })
  }
  const oldest = state.events[0]
  const truncated = since !== undefined && oldest !== undefined && since < oldest.seq
  if (truncated) notes.push(`事件窗口只保留最近 ${state.events.length} 条：更早的变更要从快照或原始日志核对，增量不完整（§28.2）`)
  if (omitted > 0) notes.push(`${omitted} 条其他成员的记录按自身范围裁剪，需要时依任务范围检索（§28.3）`)
  return {
    events: kept,
    omitted,
    truncated,
    notes,
    note: truncated ? '增量不完整：窗口外的提交未列出' : `按 seq ≥ ${since ?? '窗口起点'} 取的增量`,
  }
}

export type QueryItemKind = 'evidence' | 'claim'

export interface QueryScope {
  readonly taskRefs?: readonly TaskId[]
  readonly evidenceIds?: readonly EvidenceId[]
  readonly claimIds?: readonly ClaimId[]
}

export interface QueryRequest {
  readonly text?: string
  readonly kinds?: readonly QueryItemKind[]
  readonly scope?: QueryScope
  readonly limit?: number
  readonly cursor?: string
  /** 子代理的有界查询：必须给 scope.taskRefs，且不返回未获准的结论（§28.3）。 */
  readonly role?: ActorRole
}

export interface QueryItem {
  readonly ref: string
  readonly kind: QueryItemKind
  readonly summary: string
  readonly stance?: ClaimStance
  readonly validity: Validity
  readonly taskId?: TaskId
  readonly recordedBy: ActorId
  readonly at: number
}

export interface QueryReceipt {
  readonly filters: readonly string[]
  readonly scopeNote: string
  readonly matched: number
  readonly returned: number
  readonly nextCursor?: string
  readonly hasMore: boolean
  readonly errors: readonly string[]
  readonly note: string
}

export interface QueryPage {
  readonly items: readonly QueryItem[]
  readonly receipt: QueryReceipt
}

/**
 * `records.query(missionId, filter, scope, cursor)` 的落实（§28.5）：证据引用、支持与反证、
 * 分页及检索回执。v1 是确定性的字面匹配（全文排名依赖具体后端，不在此承诺，§28.2）；
 * 排序按显式 ref 键，分页未取完时回执必须说明，不能把当前页当作"没有"（§22.2 DG-02）。
 */
export function recordsQuery(state: MissionControl, request: QueryRequest = {}): QueryPage {
  const kinds = request.kinds ?? ['evidence', 'claim']
  const text = request.text?.trim().toLowerCase() ?? ''
  const taskRefs = request.scope?.taskRefs
  const evidenceAllow = request.scope?.evidenceIds
  const claimAllow = request.scope?.claimIds
  const subagent = request.role === 'subagent'
  const errors: string[] = []
  if (subagent && taskRefs === undefined) errors.push('subagent 的有界查询必须带 scope.taskRefs（§28.3）')

  let offset = 0
  if (request.cursor !== undefined) {
    const parsed = Number.parseInt(request.cursor, 10)
    if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== request.cursor.trim()) {
      errors.push(`cursor=${request.cursor} 不可解析：请从上一页 receipt.nextCursor 继续`)
    } else {
      offset = parsed
    }
  }

  const items: QueryItem[] = []
  if (errors.length === 0) {
    if (kinds.includes('evidence')) {
      for (const evidence of Object.values(state.evidence)) {
        if (taskRefs !== undefined && (evidence.taskId === undefined || !taskRefs.includes(evidence.taskId))) continue
        if (evidenceAllow !== undefined && !evidenceAllow.includes(evidence.evidenceId)) continue
        if (text.length > 0 && !evidenceHaystack(evidence).includes(text)) continue
        items.push({
          ref: `evidence:${evidence.evidenceId}`,
          kind: 'evidence',
          summary: evidence.summary,
          validity: evidence.validity,
          taskId: evidence.taskId,
          recordedBy: evidence.recordedBy,
          at: evidence.observedAt,
        })
      }
    }
    if (kinds.includes('claim')) {
      for (const chain of Object.values(state.claims)) {
        const head = chain[chain.length - 1]
        if (head === undefined) continue
        if (claimAllow !== undefined && !claimAllow.includes(head.claimId)) continue
        // 结论没有任务直连（Mission 级对象）：子代理只拿显式获准的结论。
        if (subagent && (claimAllow === undefined || !claimAllow.includes(head.claimId))) continue
        if (text.length > 0 && !claimHaystack(state, head).includes(text)) continue
        const classification = classifyClaim(state, head)
        items.push({
          ref: `claim:${head.claimId}@${head.version}`,
          kind: 'claim',
          summary: head.proposition,
          stance: classification.stance,
          validity: head.validity,
          recordedBy: head.authorActorId,
          at: head.createdAt,
        })
      }
    }
  }
  items.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))

  const rawLimit = request.limit ?? 20
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), 200) : 20
  const page = errors.length === 0 ? items.slice(offset, offset + limit) : []
  const nextOffset = offset + limit
  const nextCursor = errors.length === 0 && nextOffset < items.length ? String(nextOffset) : undefined

  const scopeParts: string[] = []
  if (taskRefs !== undefined) scopeParts.push(`tasks=${taskRefs.join(',')}`)
  if (evidenceAllow !== undefined) scopeParts.push(`evidenceIds=${evidenceAllow.length}`)
  if (claimAllow !== undefined) scopeParts.push(`claimIds=${claimAllow.length}`)

  const receipt: QueryReceipt = {
    filters: [text.length > 0 ? `text~${request.text ?? ''}` : 'text=*', `kinds=${kinds.join('|')}`, `limit=${limit}`, `cursor=${request.cursor ?? 'start'}`],
    scopeNote: scopeParts.length > 0 ? `限定范围：${scopeParts.join('；')}` : '范围：当前 Mission 全部已登记记录（§28.1 边界内）',
    matched: items.length,
    returned: page.length,
    nextCursor,
    hasMore: nextCursor !== undefined,
    errors,
    note:
      errors.length > 0
        ? '查询被拦下：先修回执里的错误项'
        : nextCursor !== undefined
          ? '还有未取回条目：分页未取完时不得把当前页当作"没有"（§22.2 DG-02 口径、§28.4）'
          : '已取回全部命中项（限当前 Mission 已登记记录，结论与证据未含其他范围）',
  }
  return { items: page, receipt }
}

function evidenceHaystack(evidence: EvidenceRecord): string {
  return [evidence.evidenceId, evidence.summary, evidence.metricId ?? '', evidence.value ?? '', evidence.dataScope ?? '', evidence.sourceRef]
    .join(' ')
    .toLowerCase()
}

/**
 * 结论的可检索文本：自身命题与适用/否定条件（§22.5 DG-05），外加被引用证据的摘要与 ID。
 * 这样"按证据文本查支持与反证"与"按结论文本查"落在同一查询契约里（§28.5）。
 */
function claimHaystack(state: MissionControl, claim: ClaimRevision): string {
  const linked: string[] = []
  for (const evidenceId of [...claim.supportingEvidenceIds, ...claim.contradictingEvidenceIds]) {
    const evidence = state.evidence[evidenceId]
    if (evidence !== undefined) linked.push(evidence.evidenceId, evidence.summary)
  }
  return [
    claim.claimId,
    claim.proposition,
    claim.appliesUnder.join(' '),
    claim.reentryConditions.join(' '),
    claim.subject ?? '',
    claim.implementationVersion ?? '',
    claim.inputCondition ?? '',
    claim.verifiedRange ?? '',
    ...linked,
  ]
    .join(' ')
    .toLowerCase()
}

/** `records.readEvidence(ref, range)` 的读取请求（§28.5）：权限按角色裁剪，range 在来源侧执行。 */
export interface EvidenceReadRequest {
  readonly role?: ActorRole
  readonly taskRefs?: readonly TaskId[]
  readonly range?: { readonly from?: number; readonly to?: number }
}

export interface EvidenceIntegrity {
  /** 完整性标识：读取方必须一起转述的边界（§28.4、§32.1）。 */
  readonly flags: readonly string[]
  /** 内核只存索引摘要；原始正文/大日志不在这里（§28.2）。 */
  readonly rawTextInKernel: false
  readonly sourceRef: string
}

export interface EvidenceReadResult {
  readonly ok: boolean
  readonly reason: string
  readonly evidence?: EvidenceRecord
  readonly integrity?: EvidenceIntegrity
}

/**
 * `records.readEvidence(ref, range)` 的落实（§28.5）：在权限内读取原始证据的**索引条目**与
 * 完整性标识。本机内核不存原始大日志（§28.2），所以这里只做定位与边界标注，片段读取在
 * 来源侧按 `sourceRef` 执行；找不到记录不等于原件不存在，相关措辞必须如实。
 */
export function readEvidence(state: MissionControl, evidenceRef: string, request: EvidenceReadRequest = {}): EvidenceReadResult {
  const evidenceId = evidenceRef.startsWith('evidence:') ? evidenceRef.slice('evidence:'.length) : evidenceRef
  const evidence = state.evidence[evidenceId]
  if (evidence === undefined) {
    return {
      ok: false,
      reason: `证据 ${evidenceId} 不在当前 Mission 记录中；这不等于原件不存在——内核只登记已覆盖的记录（§28.1），需要时在来源侧复核`,
    }
  }
  if (request.role === 'subagent') {
    const scope = request.taskRefs ?? []
    if (evidence.taskId === undefined || !scope.includes(evidence.taskId)) {
      return { ok: false, reason: `证据 ${evidenceId} 超出子代理的有限范围：不足时申请补充或调整派单范围（§28.3）` }
    }
  }
  const flags: string[] = []
  if (evidence.completeness !== undefined && evidence.completeness !== 'complete') {
    flags.push(`来源完整性为 ${evidence.completeness}：完整性仍需核对，不能按全量采信（§32.1）`)
  }
  if (evidence.validity !== 'current') flags.push(`有效性为 ${evidence.validity}：已不是当前有效版本（§6.1）`)
  if (evidence.kind === 'reported') flags.push('转述材料：派生视图不是新增独立证据（§32.1）')
  if (evidence.kind === 'conjecture') flags.push('纯构想：允许没有根证据，但不得当作观测或已证实事实（§31.3、§32.1）')
  if (evidence.kind === 'reference_bound') flags.push('绑定权威来源的读数：必须带权威绑定与该来源的范围（§22.8 DG-08）')
  if (evidence.derivation !== undefined) flags.push('派生记录：确定性不得超过被引用记录（§32.3）')
  if (request.range !== undefined) flags.push('range 需在来源侧原件上执行；这里返回的是索引摘要（§28.2）')
  return {
    ok: true,
    reason: `按来源 ${evidence.sourceRef} 定位复核（内核仅存索引摘要，原始片段在来源侧读取）`,
    evidence,
    integrity: { flags, rawTextInKernel: false, sourceRef: evidence.sourceRef },
  }
}
