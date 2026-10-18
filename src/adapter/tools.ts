/**
 * 面向模型的命令入口工具（设计稿 v0.3 §14：所有代理通过工具提交命令，不直接编辑数据库）。
 *
 * 工具只做**参数 → 命令**的翻译：身份取自运行时绑定、权限由内核的 `ROLE_ALLOWED` 判定、
 * 幂等靠 `requestId`，这里一概不复制一套判断——复制了就会有两套口径互相打脸。
 * §14 的接口组按"写命令"逐个开放，读侧统一走 `continuity_status` 的 `aspect` 参数，
 * 避免十个只读工具把上下文税抬起来。
 *
 * ⚠️ 口径来自本机 `<DSH 源码>` @ v0.2.1-alpha.1（`packages/core/tools/src/schema.ts`）：
 * `parameters` 与 `output.schema` 是**声明式 JSON 规格对象**，不是 zod；`render(args, value)`
 * 必须返回 `ContentBlock[]`；`isConcurrencySafe` 是**函数**而不是布尔；
 * `ctx.tools.register()` 在 `output.render` 不是函数时直接抛 TypeError。
 * 装载前本文件只被 `test/token-budget.test.ts` 借宿主桩度量模型面文本，其余测试不覆盖。
 *
 * 模型面瘦身（DS 分词口径）：描述与参数说明是**每请求常驻**的上下文税，这里删掉全部
 * 设计稿引用（§…）与重复表述，规范句一字不减；总量预算由 `test/token-budget.test.ts` 钉住。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { archiveExpectation, type ArchiveExpectation, type ArchiveSnapshot } from '../core/archive.ts'
import type { ContinuityKernel } from '../core/kernel.ts'
import type { Command, CommandContext, MechanismPatch } from '../core/commands.ts'
import { fingerprint } from '../core/commands.ts'
import type { ControlEvent, MissionControl } from '../core/control.ts'
import type { ActorId, AssumptionChange, ClaimId, ClaimStatus, DecisionBrief, DeliveryEntry, EnvironmentId, EvidenceId, ExperimentId, ExperimentStage, HandlingState, IntegrationId, MechanismClass, MechanismId, MechanismRunId, ObligationStage, RecordCoverage, ResumeId, SearchReceipt, SourceCategory, TaskId, TrialId, VerificationOutcome, WorkKind } from '../core/entities.ts'
import type { AssessInput, EnvironmentInput, EnvironmentPatch, ResumeEvent, ResumeInput } from '../core/environment.ts'
import type { ConjectureDraft, ConjectureFraming, DeferralReason, ExperimentDraft, ExperimentRevision, ExplorationRegistration, RouteInput, StageEvidence, StrategyDecisionDraft, TrialDraft } from '../core/experiment.ts'
import type { ClassDecision, MechanismInput, MechanismRunInput, MechanismTransition, TransitionDetail } from '../core/governance.ts'
import type { IntegrationPlanInput, IntegrationReceiptInput } from '../core/integration.ts'
import type { EffectObservationState, OutcomeContractInput, OutcomeReviewAnswer, OutcomeReviewInput, OutcomeReviewTrigger } from '../core/outcome.ts'
import { renderDisciplineMarkdown, renderEnvironmentMarkdown, renderGovernanceMarkdown, renderObligationsMarkdown, renderOutcomeMarkdown, renderRecordsMarkdown, renderWorkMarkdown } from '../views/export.ts'

/**
 * 归档历史回读端口（审阅 N4）：工具不自己找存储，由装配层给出这一组只读面。
 * `snapshot` 返回 null 表示该部署没有归档读取面，工具如实标注"旧历史不可回读"，不假装查过。
 */
export interface HistoryPort {
  /** 当前绑定的 Mission；装配层与 `defaultMissionId` 同口径，两者都可缺省。 */
  currentMissionId(): string | undefined
  load(missionId: string): Promise<MissionControl | null>
  snapshot(missionId: string, expectation?: ArchiveExpectation): Promise<ArchiveSnapshot | null>
}

export interface ToolDeps {
  readonly kernel: ContinuityKernel
  /**
   * 身份从运行时绑定得到；参数里自报的 actorId 一律不采信。
   * 异步：实现要读控制记录才能把 `execution.agent.id`（sessionId）映射到 Actor，
   * 内核是唯一真源，因此这里不另建一份进程内绑定缓存。
   * `sessionId` 必须透传：换绑之后旧会话不再有权写入（§10.3、§12.2），内核靠它辨认。
   */
  identity(execution: { readonly agent?: { readonly id?: unknown } }): Promise<CommandContext | undefined>
  readonly defaultMissionId: () => string | undefined
  /** Code-Mode 超时重放防护；不给即不启用（单测与 rig 走这条）。 */
  readonly replayGuard?: ReplayGuard
  /** 归档历史回读面（N4）；不给时 `continuity_history` 只回热状态并如实标注归档面缺席。 */
  readonly history?: HistoryPort
}

/** 每个写命令工具的公共入参：命令上下文、控制记录与内核时钟。 */
interface CommandEnv {
  readonly ctx: CommandContext
  readonly state: MissionControl | null
  readonly now: number
}

type CommandBuild<A> = (args: A, env: CommandEnv) => { readonly command: Command } | { readonly reason: string }

/** 构造返回体时用这两个包装：直接返回对象字面量会让 TS 推出 `{command; reason?: undefined}` 这类合并形状，判不进判别联合。 */
function built(command: Command): { readonly command: Command } {
  return { command }
}

function missing(reason: string): { readonly reason: string } {
  return { reason }
}

interface CommandToolSpec<A> {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly build: CommandBuild<A>
}

const commandOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    applied: { type: 'boolean', description: '是否写入' },
    reason: { type: 'string', description: '判定原因；未写入时为拒绝理由' },
    revision: { type: 'integer', description: '写入后修订号；未写入为 0' },
  },
} as const

const str = (description: string, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) })
const ints = (description: string, required = false) => ({ type: 'integer', description, ...(required ? { required: true } : {}) })
const bool = (description: string, required = false) => ({ type: 'boolean', description, ...(required ? { required: true } : {}) })
const list = (description: string, required = false) => ({ type: 'array', items: { type: 'string' }, description, ...(required ? { required: true } : {}) })

function rejected(reason: string) {
  return { applied: false, reason, revision: 0 }
}

/**
 * Code-Mode（`tools.mode: ptc`）超时重放防护的记账面。
 *
 * 为什么需要它：`run_code` 的截止时间**包含子调用与审批等待**（`packages/core/tools/src/ptc.ts:121`，
 * 默认 120 s / 上限 600 s，`packages/ptc-runtime/ptc-runtime-node/src/index.ts:55-56`），而已开始的工作
 * 仍会被排空（`packages/core/tools/src/index.ts` `execute()` 的注释：already-started work is still
 * drained），官方描述原文还写明 "Earlier effects may already have completed: inspect them before
 * explicitly retrying. Programs are never replayed automatically"。于是 PTC 下常见一条路径：
 * 命令已经落进台账，程序却只收到超时错误；`requestId` 含修订号，重试时修订号已推进 → 内核去重
 * 认不出这是同一请求，第二次副作用会照常写入。
 *
 * 这里只做"疑似重复"的提前拦截，不是第二套幂等真源：内核 `dedup` 仍是唯一裁决
 * （`src/core/commands.ts:827`）。记录丢失或进程重启的后果只是少拦一次，不会把误判当已确认。
 */
export class ReplayGuard {
  private readonly entries = new Map<string, { requestId: string; at: number }>()
  readonly windowMs: number
  private readonly maxEntries: number

  /**
   * @param windowMs - 拦截窗口；默认对齐 `run_code` 的默认截止时间 120 s。
   *   把 runtime 的 `maxTimeoutMs` 调高时，窗口要一起调宽（窗口 ≈ 程序截止时间 + 一次往返）。
   * @param maxEntries - 记录条数上限，超出按最早时刻剪掉。
   */
  constructor(windowMs = 120_000, maxEntries = 512) {
    this.windowMs = windowMs
    this.maxEntries = maxEntries
  }

  /** 上一次以 `requestId` 提交过同一内容、且仍在窗口内 → 返回说明文本；否则 `undefined`。 */
  suspect(key: string, requestId: string, now: number): string | undefined {
    if (this.windowMs <= 0) return undefined
    const seen = this.entries.get(key)
    if (seen === undefined || seen.requestId === requestId || now - seen.at > this.windowMs) return undefined
    return `疑似超时重放：同内容命令已于 ${now - seen.at} ms 前落地（当时的 requestId=${seen.requestId}，本次 requestId=${requestId}）`
  }

  /** 记下一次**确实落地**的提交（未落地不记，否则正常的立刻重试会被自己拦住）。 */
  note(key: string, requestId: string, now: number): void {
    this.entries.set(key, { requestId, at: now })
    for (const [existing, entry] of this.entries) {
      if (now - entry.at <= this.windowMs) continue
      this.entries.delete(existing)
    }
    if (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest !== undefined) this.entries.delete(oldest[0])
    }
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}

/**
 * 统一的命令入口：解析身份 → 生成幂等 requestId → 重放防护 → 交内核。
 *
 * `requestId` 含**当前修订号**：同一修订下重复提交同一命令会被去重（重试不产生第二次副作用），
 * 而状态一旦推进就换新请求号，避免"改对了却被判成重放"。Code-Mode 的超时重试会让修订号先推进，
 * 那一侧的缺口由 `ReplayGuard` 在提交前拦一次，并把核对动作回给调用方。
 */
function commandTool<A>(deps: ToolDeps, spec: CommandToolSpec<A>) {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: commandOutput,
      render: (_args, value) => [
        { type: 'text', text: value.applied ? `${spec.name} 已提交（修订 ${value.revision}）：${value.reason}` : `${spec.name} 未提交：${value.reason}` },
      ],
    },
    isConcurrencySafe: () => false,
    execute: async (args: A, execution: { readonly agent?: { readonly id?: unknown } }) => {
      const ctx = await deps.identity(execution)
      const missionId = deps.defaultMissionId()
      if (ctx === undefined || missionId === undefined) {
        return rejected('no-bound-actor：当前会话没有绑定到任何 Actor，或没有默认 Mission（§14：身份只认运行时绑定）')
      }
      const state = await deps.kernel.read(missionId)
      const built = spec.build(args, { ctx, state, now: ctx.now })
      if ('reason' in built) return rejected(built.reason)
      const contentFp = fingerprint(built.command).slice(0, 16)
      const requestId = `${spec.name}:${ctx.actorId}:${contentFp}:${state?.revision ?? 0}`
      // 作用域带上会话：同一个 Actor 在两个会话里交替提交同一内容，是两个意图，不是重放。
      const replayKey = `${ctx.sessionId ?? ctx.actorId}|${spec.name}|${contentFp}`
      const suspect = deps.replayGuard?.suspect(replayKey, requestId, ctx.now)
      if (suspect !== undefined) {
        return rejected(`${suspect}；先读台账核对上一次是否已落地（continuity_status aspect=records，或 /continuity status），确认未落地再重试`)
      }
      const withId = { ...built.command, requestId } as Command
      const result = await deps.kernel.submit(missionId, withId, ctx)
      if (result.applied) deps.replayGuard?.note(replayKey, requestId, ctx.now)
      return { applied: result.applied, reason: result.applied ? result.effect : result.reason, revision: result.applied ? result.state.revision : 0 }
    },
  })
}

/** 取该 Actor 在当前任务上最新的非终态 Attempt，用于 submit 的租约版本核对。 */
function liveAttempt(state: MissionControl | null, actorId: string, taskId: string) {
  if (state === null) return undefined
  return Object.values(state.attempts)
    .filter((attempt) => attempt.taskId === taskId && attempt.actorId === actorId && attempt.status !== 'settled' && attempt.status !== 'failed' && attempt.status !== 'cancelled')
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

const statusOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    markdown: { type: 'string', description: '状态摘要（逐行文本）' },
    revision: { type: 'integer', description: '修订号' },
    blockers: { type: 'array', items: { type: 'string' }, description: '阻塞项' },
  },
} as const

export function continuityStatusTool(deps: ToolDeps) {
  return defineTool({
    name: 'continuity_status',
    description: '读取 Mission 控制状态（只读）。aspect=overview（默认）给任务/执行权/预算/待办；discipline 给结论/质疑/依据版本；obligations 给未闭环承诺；authorization 给有效授权与到期；deliveries 给交付箱/处理状态；validators 给验证器资格；work 给工作任务分类与探索额度；records 给记录覆盖与依据包；environment 给环境清单与接续；governance 给机制分类与运行；outcome 给目标效用与效果观测。',
    parameters: {
      missionId: str('留空用当前绑定的 Mission'),
      aspect: { type: 'string', enum: ['overview', 'discipline', 'obligations', 'authorization', 'deliveries', 'validators', 'work', 'records', 'environment', 'governance', 'outcome'], description: '默认 overview' },
    },
    output: {
      schema: statusOutput,
      render: (_args, value) => [{ type: 'text', text: `${value.markdown}\n阻塞：${value.blockers.join(', ') || '无'}` }],
    },
    isConcurrencySafe: () => true,
    execute: async (args: { readonly missionId?: string; readonly aspect?: string }) => {
      const missionId = args.missionId ?? deps.defaultMissionId()
      if (missionId === undefined) return { markdown: '没有绑定的 Mission。', revision: 0, blockers: ['no-mission'] }
      const state = await deps.kernel.read(missionId)
      if (state === null) return { markdown: `Mission ${missionId} 未打开。`, revision: 0, blockers: ['mission-not-open'] }
      const blockers = blockersOf(state)
      const aspect = args.aspect ?? 'overview'
      if (aspect === 'discipline') return { markdown: renderDisciplineMarkdown(state), revision: state.revision, blockers }
      if (aspect === 'obligations') return { markdown: renderObligationsMarkdown(state), revision: state.revision, blockers }
      if (aspect === 'authorization') {
        const now = Date.now()
        const lines = Object.values(state.grants).map((grant) => `${grant.grantId} ${grant.actions.join('/')} 范围=${grant.objectScope.join(',')} 环境=${grant.environment} 用=${grant.usedCount}/${grant.maxUses ?? '∞'} token=${grant.consumedTokens}/${grant.tokenQuota ?? '∞'} ${grant.revokedAt !== undefined ? `已撤销(${grant.revokedReason ?? ''})` : grant.expiresAt !== undefined && grant.expiresAt <= now ? '已过期' : '有效'}`)
        return { markdown: [`授权（只认用户与部署来源，§22.8）：`, ...lines].join('\n'), revision: state.revision, blockers }
      }
      if (aspect === 'deliveries') {
        const lines = Object.values(state.deliveries).map((item) => `${item.deliveryId} → ${item.recipientActorId} 阶段=${item.stage} 处理=${item.handling}${item.failureReason === undefined ? '' : ` 原因=${item.failureReason}`}`)
        return { markdown: [`交付箱（§22.14：阶段与处理分列，registered≠integrated）：`, ...lines].join('\n'), revision: state.revision, blockers }
      }
      if (aspect === 'validators') {
        const lines = Object.values(state.validators).map((chain) => chain.at(-1)).filter((item) => item !== undefined).map((item) => `${item.validatorId}@${item.version} ${item.name} 范围=${item.scope} 正样本=${item.effectiveSampleIds.length} 反样本=${item.counterSampleIds.length} ${item.eligible ? '有资格' : `无资格：${item.qualificationReason ?? '未说明'}`}`)
        return { markdown: [`验证器（§22.10：需正反样本与非恒真断言）：`, ...lines].join('\n'), revision: state.revision, blockers }
      }
      if (aspect === 'work') return { markdown: renderWorkMarkdown(state), revision: state.revision, blockers }
      if (aspect === 'records') return { markdown: renderRecordsMarkdown(state), revision: state.revision, blockers }
      if (aspect === 'environment') return { markdown: renderEnvironmentMarkdown(state), revision: state.revision, blockers }
      if (aspect === 'governance') return { markdown: renderGovernanceMarkdown(state), revision: state.revision, blockers }
      if (aspect === 'outcome') return { markdown: renderOutcomeMarkdown(state), revision: state.revision, blockers }
      const open = Object.values(state.tasks).filter((task) => task.status !== 'completed')
      return {
        markdown: [
          `目标（版本 ${state.mission.objectiveRevision}）：${state.mission.objective}`,
          `状态：${state.mission.status} 政策版本 ${state.mission.policyRevision} 依据版本 ${state.basisRevision} 修订：${state.revision}`,
          `未完成任务 ${open.length} 项：${open.map((task) => `${task.taskId}(${task.status}/${task.validity})`).join(', ') || '无'}`,
          `待办 outbox：${Object.values(state.outbox).filter((entry) => entry.completedAt === undefined).length}`,
          `预算预留未结算：${state.budget.reservations.length} 笔`,
          `未决质疑：${Object.values(state.challenges).filter((item) => item.outcome === 'open').length}`,
        ].join('\n'),
        revision: state.revision,
        blockers,
      }
    },
  })
}

/**
 * "现在挡着什么"：与 `missionCompletion` 的收口缺口分列，这里只取需要有人动手的项。
 * 待传播的失效也列进来——依据撤回后若不重算下游，任务看着正常其实已不可信（§22.6）。
 */
function blockersOf(state: MissionControl): string[] {
  const out: string[] = []
  for (const task of Object.values(state.tasks)) {
    if (task.status === 'blocked') out.push(`${task.taskId} blocked：${task.blockedReason ?? '未说明'}`)
  }
  for (const challenge of Object.values(state.challenges)) {
    if (challenge.outcome === 'open') out.push(`质疑 ${challenge.challengeId} 未裁决（${challenge.severity}）`)
  }
  for (const item of state.pendingPropagations) {
    out.push(`待传播 ${item.propagationId}：${item.targetKind} ${item.targetId} 需 ${item.requiredAction}`)
  }
  for (const delivery of Object.values(state.deliveries)) {
    if (delivery.stage === 'unrouted') out.push(`投递 ${delivery.deliveryId} 无去处：收件人不在当前成员里`)
  }
  return out
}

/* ------------------------------------------------------------------ 归档历史回读（N4） */

/** 历史工具的一条闭合对象引用：热状态与归档记录同形，靠 `source` 区分来源。 */
interface HistoryRecordRef {
  readonly collection: string
  readonly id: string
  readonly value: unknown
  readonly source: 'hot' | 'archive'
}

/** 按 objectId 匹配：`clm_1` 命中全部版本，`clm_1@2` 只命中该版本（链式集合 id 形如 id@version）。 */
function matchesObjectId(id: string, objectId: string): boolean {
  return id === objectId || id.split('@')[0] === objectId
}

/**
 * 热状态的闭合对象版本遍历（N4）：链式集合按 `id@version` 逐版本展开，平表按 id 匹配。
 * 集合清单与 `planClosedRecordDrops` 的裁剪集合对齐——能进归档批次的集合，这里都能找到热内版本。
 */
function hotRecordRefs(state: MissionControl, objectId: string): HistoryRecordRef[] {
  const refs: HistoryRecordRef[] = []
  const flat = (collection: string, record: Readonly<Record<string, unknown>>): void => {
    for (const [key, value] of Object.entries(record)) {
      if (matchesObjectId(key, objectId)) refs.push({ collection, id: key, value, source: 'hot' })
    }
  }
  const chains = (collection: string, record: Readonly<Record<string, readonly { readonly version: number }[]>>): void => {
    for (const [key, versions] of Object.entries(record)) {
      for (const value of versions) {
        const id = `${key}@${value.version}`
        if (matchesObjectId(id, objectId)) refs.push({ collection, id, value, source: 'hot' })
      }
    }
  }
  flat('tasks', state.tasks)
  flat('attempts', state.attempts)
  flat('actors', state.actors)
  flat('teams', state.teams)
  flat('checkpoints', state.checkpoints)
  flat('verifications', state.verifications)
  flat('mailbox', state.mailbox)
  flat('operations', state.operations)
  flat('rotations', state.rotations)
  flat('outbox', state.outbox)
  flat('evidence', state.evidence)
  flat('dependencies', state.dependencies)
  flat('obligations', state.obligations)
  flat('grants', state.grants)
  flat('searches', state.searches)
  flat('contexts', state.contexts)
  flat('challenges', state.challenges)
  flat('incidents', state.incidents)
  flat('reviews', state.reviews)
  flat('deliveries', state.deliveries)
  flat('dispatches', state.dispatches)
  flat('trials', state.trials)
  flat('strategyDecisions', state.strategyDecisions)
  flat('routes', state.routes)
  flat('assessments', state.assessments)
  flat('coverages', state.coverages)
  flat('briefs', state.briefs)
  flat('resumes', state.resumes)
  flat('integrations', state.integrations)
  flat('integrationReceipts', state.integrationReceipts)
  flat('mechanismRuns', state.mechanismRuns)
  chains('claims', state.claims)
  chains('artifacts', state.artifacts)
  chains('validators', state.validators)
  chains('experiments', state.experiments)
  chains('environments', state.environments)
  chains('mechanisms', state.mechanisms)
  chains('rules', state.rules)
  return refs
}

/** 事件时刻：与视图层同口径（ISO 字符串）。 */
function historyStamp(at: number): string {
  return new Date(at).toISOString()
}

/** 紧凑 JSON：超长截断并注明原长度——历史正文有界进上下文，绝不整段倾倒。 */
function compactJson(value: unknown, max = 180): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch (reason) {
    text = `（无法序列化：${reason instanceof Error ? reason.message : String(reason)}）`
  }
  return text.length <= max ? text : `${text.slice(0, max)}…（截断，原 ${text.length} 字符）`
}

const historyOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    markdown: { type: 'string', description: '有界历史页：覆盖说明、事件行、闭合记录与分页游标' },
    revision: { type: 'integer', description: '控制记录修订号；读不到为 0' },
    nextCursor: { type: 'string', description: '下一页游标（取 seq ≤ 游标的更旧事件）；没有更旧内容时为空串' },
  },
} as const

/**
 * 有界历史检索入口（审阅 N4）：热状态与归档台账合并后回读正文，绝不把全部历史塞进上下文。
 *
 * - 事件：热 `state.events` + 快照 `archive.events` 去重（同一 seq 以热为准）→ 过滤 seq/时间区间
 *   与 `cursor`（seq ≤ cursor）→ 取最年轻的 `limit` 条；`nextCursor` = 本页最旧 seq - 1，还有更旧的才有。
 * - 闭合记录：给 `objectId` 时在热状态各集合与 `snapshot.records` 里找全部匹配版本（同名先热后档），
 *   不给 `objectId` 只列归档批次前 `limit` 条并注明。两处都读不到就写明 unknown，不编造。
 */
export const continuityHistoryTool = (deps: ToolDeps) =>
  defineTool({
    name: 'continuity_history',
    description: '读取有界历史（只读）：热状态与归档台账按 seq 合并去重后回读控制事件，并在热集合与归档批次里取闭合对象版本；支持 seq/时间范围与 cursor 分页；缺失范围显式列出，绝不整段倾倒全部历史。',
    parameters: {
      missionId: str('留空用当前绑定的 Mission'),
      objectId: str('闭合对象 id；带版本用 id@version，只给基础 id 则列全部版本'),
      fromSeq: ints('事件 seq 下界（含）'),
      toSeq: ints('事件 seq 上界（含）'),
      fromTime: ints('事件时刻下界（毫秒，含）'),
      toTime: ints('事件时刻上界（毫秒，含）'),
      cursor: str('分页游标：传上一页 nextCursor 取更旧事件（seq ≤ 游标）'),
      limit: ints('本页事件与记录上限，默认 20，上限 50'),
    },
    output: {
      schema: historyOutput,
      render: (_args, value) => [{ type: 'text', text: value.markdown }],
    },
    isConcurrencySafe: () => true,
    execute: async (args: {
      readonly missionId?: string
      readonly objectId?: string
      readonly fromSeq?: number
      readonly toSeq?: number
      readonly fromTime?: number
      readonly toTime?: number
      readonly cursor?: string
      readonly limit?: number
    }) => {
      const history = deps.history
      const missionId = args.missionId ?? history?.currentMissionId() ?? deps.defaultMissionId()
      if (missionId === undefined) {
        return { markdown: '没有绑定的 Mission：continuity_history 需要 missionId 参数或一个已绑定的当前 Mission。', revision: 0, nextCursor: '' }
      }
      let cursor: number | undefined
      if (args.cursor !== undefined) {
        if (!/^-?\d+$/.test(args.cursor)) {
          return { markdown: `cursor「${args.cursor}」不是合法游标：应为 continuity_history 上一页返回的 nextCursor 整数字符串。`, revision: 0, nextCursor: '' }
        }
        cursor = Number(args.cursor)
      }
      const requestedLimit = args.limit ?? 20
      const pageLimit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 20, 50))
      const state = history === undefined ? await deps.kernel.read(missionId) : await history.load(missionId)
      // 控制记录知道的事（已落档水位）带给读侧快照，台账才能核对"最后一批之后"的缺失（N3）；
      // 读不到控制记录就不给预期，避免拿猜测当核对依据。
      const expectation: ArchiveExpectation | undefined = state == null ? undefined : archiveExpectation(state)
      const snapshot = history === undefined ? null : await history.snapshot(missionId, expectation)

      // 事件合并：同一 seq 只信当前提交的热副本；归档只补热窗口没有的部分。
      const bySeq = new Map<number, ControlEvent>()
      for (const event of state?.events ?? []) bySeq.set(event.seq, event)
      for (const event of snapshot?.events ?? []) if (!bySeq.has(event.seq)) bySeq.set(event.seq, event)
      const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
      const inRange = merged.filter(
        (event) =>
          (cursor === undefined || event.seq <= cursor) &&
          (args.fromSeq === undefined || event.seq >= args.fromSeq) &&
          (args.toSeq === undefined || event.seq <= args.toSeq) &&
          (args.fromTime === undefined || event.at >= args.fromTime) &&
          (args.toTime === undefined || event.at <= args.toTime),
      )
      const page = inRange.slice(-pageLimit)
      const nextCursor = inRange.length > page.length ? String(page[0]!.seq - 1) : ''

      // ① 覆盖块：热/档各自口径分开写；缺失范围逐条可见，读不到就 unknown，不编造。
      const coverage: string[] = [`- Mission：${missionId}`]
      coverage.push(
        state === null
          ? '- 热事件区间：unknown（读不到控制记录）'
          : state.events.length === 0
            ? '- 热事件区间：无（0 条）'
            : `- 热事件区间：seq ${state.events[0]!.seq}–${state.events.at(-1)!.seq}（${state.events.length} 条）`,
      )
      if (snapshot === null) {
        coverage.push(
          state === null
            ? '- 归档台账：unknown（本部署没有归档读取面：旧历史不可回读；控制记录也读不到）'
            : '- 归档台账：unknown（本部署没有归档读取面：以下是热状态内容，旧历史不可回读）',
        )
      } else {
        coverage.push(`- 归档台账：${snapshot.batches.length} 批 / ${snapshot.events.length} 条事件，archivedThroughSeq=${snapshot.archivedThroughSeq}`)
        coverage.push(
          snapshot.unavailable.length === 0
            ? '- 缺失与拒绝（unavailable）：无'
            : `- 缺失与拒绝（unavailable）：\n${snapshot.unavailable.map((line) => `  - ${line}`).join('\n')}`,
        )
      }

      // ④ 分页口径：本页是范围内最年轻的 limit 条；cursor 指向更旧一页。
      const paging: string[] = [
        `- 本页事件：${page.length} 条${inRange.length > page.length ? `（请求范围内共 ${inRange.length} 条，更旧的未纳入本页）` : ''}`,
      ]
      if (pageLimit !== requestedLimit) paging.push(`- limit：请求 ${requestedLimit}，按 ${pageLimit} 执行（默认 20，上限 50，超限夹紧）`)
      if (nextCursor !== '') paging.push(`- nextCursor=${nextCursor}（继续取更旧一页：再次调用 continuity_history 并传 cursor=${nextCursor}）`)
      else if (page.length > 0) paging.push('- 分页：请求范围内已没有更旧事件，nextCursor 为空。')
      else paging.push('- 分页：没有匹配的事件。')

      // ② 事件行：seq / 时刻 / kind / 紧凑 detail。
      const eventLines = page.map((event) => `- seq ${event.seq} / ${historyStamp(event.at)} / ${event.kind} / ${compactJson(event.detail)}`)

      // ③ 闭合记录：objectId 命中热与归档的全部版本（同名先热后档）；不给只列归档前 limit 条。
      const recordLines: string[] = []
      if (args.objectId !== undefined) {
        const hotRefs = (state === null ? [] : hotRecordRefs(state, args.objectId)).sort(
          (a, b) => a.collection.localeCompare(b.collection) || a.id.localeCompare(b.id),
        )
        const archivedRefs: HistoryRecordRef[] = (snapshot?.records ?? [])
          .filter((drop) => matchesObjectId(drop.id, args.objectId!))
          .map((drop) => ({ collection: drop.collection, id: drop.id, value: drop.value, source: 'archive' }))
        const hits = [...hotRefs, ...archivedRefs]
        const pageHits = hits.slice(0, pageLimit)
        recordLines.push(...pageHits.map((hit) => `- ${hit.collection} / ${hit.id} / ${hit.source} / ${compactJson(hit.value)}`))
        if (hits.length === 0) {
          const missing = [state === null ? '热状态读不到' : '', snapshot === null ? '归档面缺席' : ''].filter((item) => item !== '').join('、')
          recordLines.push(
            missing === ''
              ? `- 没有匹配 objectId=${args.objectId} 的热状态条目与归档记录。`
              : `- objectId=${args.objectId} 没有命中；但${missing}，不排除存在更早版本。`,
          )
        } else if (hits.length > pageHits.length) {
          recordLines.push(`- objectId=${args.objectId} 命中 ${hits.length} 个版本，只显示前 ${pageLimit} 个（source 标注热/档来源，先热后档）。`)
        } else {
          recordLines.push(`- objectId=${args.objectId} 命中 ${hits.length} 个版本（source 标注热/档来源，先热后档）。`)
        }
      } else if (snapshot === null) {
        recordLines.push('- 未给 objectId：归档面缺席，闭合记录不列；给 objectId 可从热状态查在册版本。')
      } else {
        const records = snapshot.records.slice(0, pageLimit)
        recordLines.push(...records.map((drop) => `- ${drop.collection} / ${drop.id} / archive / ${compactJson(drop.value)}`))
        if (records.length === 0) recordLines.push('- 未给 objectId：归档批次里没有闭合记录条目。')
        else if (snapshot.records.length > records.length) {
          recordLines.push(`- 未给 objectId：只列归档批次前 ${records.length} 条（共 ${snapshot.records.length} 条）；给 objectId 可查热状态与归档的全部匹配版本。`)
        } else {
          recordLines.push(`- 未给 objectId：列出归档批次全部 ${records.length} 条；给 objectId 可查热状态与归档的全部匹配版本。`)
        }
      }

      const markdown = [
        `# 控制事件历史（有界）Mission ${missionId}`,
        '',
        ...coverage,
        '',
        ...paging,
        '',
        `## 事件（本页 ${page.length} 条，seq 升序）`,
        eventLines.length === 0 ? '（无）' : eventLines.join('\n'),
        '',
        '## 闭合记录',
        recordLines.join('\n'),
      ].join('\n')
      return { markdown, revision: state?.revision ?? 0, nextCursor }
    },
  })

export function continuityCheckpointTool(deps: ToolDeps) {
  return commandTool<{
    readonly taskId: string
    readonly step: string
    readonly verifiedProgress?: readonly string[]
    readonly inProgress?: readonly string[]
    readonly nextAction: string
    readonly decisions?: readonly string[]
    readonly blockers?: readonly string[]
    readonly openQuestions?: readonly string[]
    readonly inFlightOperations?: readonly string[]
  }>(deps, {
    name: 'continuity_checkpoint',
    description: '提交检查点：当前步骤、已验收进度、进行中、下一步第一动作、关键决策、阻塞、待确认。不要写无证据支撑的结论；未决质疑与欠账由内核推导，不由你自报。',
    parameters: {
      taskId: str('任务 ID', true),
      step: str('当前步骤一句话', true),
      verifiedProgress: list('已验收进度'),
      inProgress: list('进行中'),
      nextAction: str('下一步第一动作（单一、可执行）', true),
      decisions: list('决策及依据'),
      blockers: list('阻塞及解除条件'),
      openQuestions: list('待确认事项'),
      inFlightOperations: list('在跑的外部操作 ID'),
    },
    build: (args) => ({
      command: {
        kind: 'task.checkpoint',
        requestId: '',
        taskId: args.taskId,
        checkpoint: {
          step: args.step,
          verifiedProgress: args.verifiedProgress ?? [],
          inProgress: args.inProgress ?? [],
          nextAction: args.nextAction,
          decisions: args.decisions ?? [],
          blockers: args.blockers ?? [],
          openQuestions: args.openQuestions ?? [],
          inFlightOperations: args.inFlightOperations ?? [],
          contextRefs: [],
        },
      },
    }),
  })
}

export const continuitySubmitTool = (deps: ToolDeps) =>
  commandTool<{ readonly taskId: string }>(deps, {
    name: 'continuity_submit',
    description: '提交结果进入验收。前提：租约有效、票据未失效、无未决质疑、产物已登记、外部操作已定案。租约版本由内核按当前 Attempt 取，不接受自报。',
    parameters: { taskId: str('任务 ID', true) },
    build: (args, env) => {
      const attempt = liveAttempt(env.state, env.ctx.actorId, args.taskId)
      if (attempt === undefined) return { reason: `在 ${args.taskId} 上没有进行中的 Attempt：先由 Supervisor/Lead 派单并 claim` }
      return { command: { kind: 'task.submit', requestId: '', taskId: args.taskId, leaseVersion: attempt.leaseVersion } }
    },
  })

export const continuityVerifyTool = (deps: ToolDeps) =>
  commandTool<{
    readonly taskId: string
    readonly criterionId: string
    readonly outcome: VerificationOutcome
    readonly method: string
    readonly methodVersion: string
    readonly evidenceRefs: readonly string[]
    readonly artifactId?: string
    readonly validatorId?: string
    readonly applicabilityReason?: string
    readonly detail?: string
    readonly checksRun?: number
  }>(deps, {
    name: 'continuity_verify',
    description: '登记验收记录。unknown/error/not_run 不得折算为 pass；not_applicable 需适用性理由且判据有适用性规则；pass 需证据引用；程序化验证器还需当前资格。',
    parameters: {
      taskId: str('任务 ID', true),
      criterionId: str('判据 ID，如 crit_1（按当前 criteriaRevision）', true),
      outcome: { type: 'string', enum: ['pass', 'fail', 'unknown', 'error', 'not_run', 'not_applicable'], description: '验收结论', required: true },
      method: str('方法名', true),
      methodVersion: str('方法版本', true),
      evidenceRefs: list('证据引用（evidence:* 或 文件+哈希）', true),
      artifactId: str('产物 ID'),
      validatorId: str('验证器 ID'),
      applicabilityReason: str('not_applicable 的适用性理由'),
      detail: str('结论说明'),
      checksRun: ints('执行的检查条数'),
    },
    build: (args) => ({
      command: {
        kind: 'task.verify',
        requestId: '',
        taskId: args.taskId,
        criterionId: args.criterionId,
        outcome: args.outcome,
        method: args.method,
        methodVersion: args.methodVersion,
        evidenceRefs: args.evidenceRefs ?? [],
        ...(args.artifactId === undefined ? {} : { artifactId: args.artifactId }),
        ...(args.validatorId === undefined ? {} : { validatorId: args.validatorId }),
        ...(args.applicabilityReason === undefined ? {} : { applicabilityReason: args.applicabilityReason }),
        ...(args.detail === undefined ? {} : { detail: args.detail }),
        ...(args.checksRun === undefined ? {} : { checksRun: args.checksRun }),
      },
    }),
  })

export const continuityEvidenceTool = (deps: ToolDeps) =>
  commandTool<{
    readonly kind: SourceCategory
    readonly summary: string
    readonly sourceRef: string
    readonly metricId?: string
    readonly value?: string
    readonly unit?: string
    readonly aggregate?: string
    readonly denominator?: string
    readonly precisionNote?: string
    readonly dataScope?: string
    readonly objectTime?: number
    readonly environment?: string
    readonly methodVersion?: string
    readonly contentHash?: string
    readonly taskId?: string
    readonly attemptId?: string
    readonly operationId?: string
    readonly artifactId?: string
  }>(deps, {
    name: 'continuity_evidence',
    description: '登记观测证据。来源类别分列：观测/转述/推断/模拟/绑定引用；模拟不得冒充真实读数；聚合值必须给分子分母与口径，否则不得横比。ID、登记时刻与有效性由内核盖。',
    parameters: {
      kind: { type: 'string', enum: ['observation', 'reported', 'inference', 'simulated', 'reference_bound'], description: '来源类别', required: true },
      summary: str('说明了什么', true),
      sourceRef: str('来源定位：路径+行、URL、会话/消息号', true),
      metricId: str('指标 ID'),
      value: str('读数'),
      unit: str('单位'),
      aggregate: str('聚合定义（分子/分母/算法）'),
      denominator: str('分母口径'),
      precisionNote: str('精度与误差口径'),
      dataScope: str('数据范围'),
      objectTime: ints('对象时刻（与观测时刻分开）'),
      environment: str('环境标识'),
      methodVersion: str('方法版本'),
      contentHash: str('内容哈希'),
      taskId: str('关联任务 ID'),
      attemptId: str('关联 Attempt ID'),
      operationId: str('关联操作 ID'),
      artifactId: str('关联产物 ID'),
    },
    build: (args, env) => ({
      command: {
        kind: 'evidence.record',
        requestId: '',
        evidence: {
          kind: args.kind,
          summary: args.summary,
          sourceRef: args.sourceRef,
          observedAt: env.now,
          ...(args.metricId === undefined ? {} : { metricId: args.metricId }),
          ...(args.value === undefined ? {} : { value: args.value }),
          ...(args.unit === undefined ? {} : { unit: args.unit }),
          ...(args.aggregate === undefined ? {} : { aggregate: args.aggregate }),
          ...(args.denominator === undefined ? {} : { denominator: args.denominator }),
          ...(args.precisionNote === undefined ? {} : { precisionNote: args.precisionNote }),
          ...(args.dataScope === undefined ? {} : { dataScope: args.dataScope }),
          ...(args.objectTime === undefined ? {} : { objectTime: args.objectTime }),
          ...(args.environment === undefined ? {} : { environment: args.environment }),
          ...(args.methodVersion === undefined ? {} : { methodVersion: args.methodVersion }),
          ...(args.contentHash === undefined ? {} : { contentHash: args.contentHash }),
          ...(args.taskId === undefined ? {} : { taskId: args.taskId }),
          ...(args.attemptId === undefined ? {} : { attemptId: args.attemptId }),
          ...(args.operationId === undefined ? {} : { operationId: args.operationId }),
          ...(args.artifactId === undefined ? {} : { artifactId: args.artifactId }),
        },
      },
    }),
  })

export const continuityClaimTool = (deps: ToolDeps) =>
  commandTool<{
    readonly claimId?: string
    readonly proposition?: string
    readonly appliesUnder?: readonly string[]
    readonly sourceCategory?: SourceCategory
    readonly supportingEvidenceIds?: readonly string[]
    readonly contradictingEvidenceIds?: readonly string[]
    readonly subject?: string
    readonly implementationVersion?: string
    readonly inputCondition?: string
    readonly verifiedRange?: string
    readonly reentryConditions?: readonly string[]
    readonly status?: ClaimStatus
    readonly retractionReason?: string
  }>(deps, {
    name: 'continuity_claim',
    description: '提出结论（不给 claimId）或修订（给 claimId）。修订产生新版本，旧版本只证明旧范围；撤回要写清理由，内核据此把依赖它的执行资格降级。否定性结论必须给被测对象、实现版本、输入条件与验证范围。',
    parameters: {
      claimId: str('已有结论 ID；填写即开新版本'),
      proposition: str('结论正文（新提必填）'),
      appliesUnder: list('成立条件/适用范围', true),
      sourceCategory: { type: 'string', enum: ['observation', 'reported', 'inference', 'simulated', 'reference_bound'], description: '证据类型' },
      supportingEvidenceIds: list('支持证据 ID'),
      contradictingEvidenceIds: list('反证 ID'),
      subject: str('被测对象'),
      implementationVersion: str('实现版本'),
      inputCondition: str('输入条件'),
      verifiedRange: str('验证范围'),
      reentryConditions: list('允许重新成立的条件'),
      status: { type: 'string', enum: ['proposed', 'supported', 'unsupported', 'refuted', 'superseded'], description: '修订后状态' },
      retractionReason: str('撤回理由（撤回必填）'),
    },
    build: (args) => {
      if (args.claimId !== undefined) {
        return built({
          kind: 'claim.revise',
          requestId: '',
          claimId: args.claimId,
          ...(args.proposition === undefined ? {} : { proposition: args.proposition }),
          ...(args.appliesUnder === undefined ? {} : { appliesUnder: args.appliesUnder }),
          ...(args.status === undefined ? {} : { status: args.status }),
          ...(args.supportingEvidenceIds === undefined ? {} : { supportingEvidenceIds: args.supportingEvidenceIds }),
          ...(args.contradictingEvidenceIds === undefined ? {} : { contradictingEvidenceIds: args.contradictingEvidenceIds }),
          ...(args.reentryConditions === undefined ? {} : { reentryConditions: args.reentryConditions }),
          ...(args.retractionReason === undefined ? {} : { retractionReason: args.retractionReason }),
        })
      }
      if (args.proposition === undefined || args.appliesUnder === undefined) return missing('新提结论需要 proposition 与 appliesUnder：范围不写清，后续检索与质疑无法定位')
      return built({
        kind: 'claim.propose',
        requestId: '',
        claim: {
          proposition: args.proposition,
          appliesUnder: args.appliesUnder,
          sourceCategory: args.sourceCategory ?? 'inference',
          status: args.status ?? 'proposed',
          supportingEvidenceIds: args.supportingEvidenceIds ?? [],
          contradictingEvidenceIds: args.contradictingEvidenceIds ?? [],
          reentryConditions: args.reentryConditions ?? [],
          ...(args.subject === undefined ? {} : { subject: args.subject }),
          ...(args.implementationVersion === undefined ? {} : { implementationVersion: args.implementationVersion }),
          ...(args.inputCondition === undefined ? {} : { inputCondition: args.inputCondition }),
          ...(args.verifiedRange === undefined ? {} : { verifiedRange: args.verifiedRange }),
        },
      })
    },
  })

export const continuityChallengeTool = (deps: ToolDeps) =>
  commandTool<{
    readonly challengeId?: string
    readonly outcome?: 'upheld' | 'dismissed' | 'merged'
    readonly resolution?: string
    readonly mergedInto?: string
    readonly targetKind?: 'task' | 'criteria' | 'claim' | 'artifact' | 'verification'
    readonly targetId?: string
    readonly targetRevision?: number
    readonly quotedText?: string
    readonly contradictingEvidenceIds?: readonly string[]
    readonly affectedActionIds?: readonly string[]
    readonly adjudicatorActorId?: string
    readonly severity?: 'hard_conflict' | 'semantic_suspicion' | 'under_evidenced'
  }>(deps, {
    name: 'continuity_challenge',
    description: '提出质疑（不给 challengeId）或裁决（给 challengeId+outcome）。质疑要引用原文与反证；无反证按 under_evidenced 记待审，不自动推翻已有充分支持的判据。裁决只允许审查者/Lead/用户。',
    parameters: {
      challengeId: str('已有质疑 ID；填写即裁决'),
      outcome: { type: 'string', enum: ['upheld', 'dismissed', 'merged'], description: '裁决结论' },
      resolution: str('裁决理由'),
      mergedInto: str('并入的质疑 ID'),
      targetKind: { type: 'string', enum: ['task', 'criteria', 'claim', 'artifact', 'verification'], description: '被质疑对象类型' },
      targetId: str('被质疑对象 ID；criteria 用 taskId@criteriaRevision'),
      targetRevision: ints('被质疑对象的版本'),
      quotedText: str('被质疑原文（逐字引用）', true),
      contradictingEvidenceIds: list('反证证据 ID'),
      affectedActionIds: list('受影响动作/操作 ID'),
      adjudicatorActorId: str('裁决人 Actor ID'),
      severity: { type: 'string', enum: ['hard_conflict', 'semantic_suspicion', 'under_evidenced'], description: '冲突强度' },
    },
    build: (args, env) => {
      if (args.challengeId !== undefined) {
        if (args.outcome === undefined || args.resolution === undefined) return { reason: '裁决需要 outcome 与 resolution：只说"这条有问题"不构成裁决' }
        return {
          command: {
            kind: 'challenge.resolve',
            requestId: '',
            challengeId: args.challengeId,
            outcome: args.outcome,
            resolution: args.resolution,
            ...(args.mergedInto === undefined ? {} : { mergedInto: args.mergedInto }),
          },
        }
      }
      if (args.targetKind === undefined || args.targetId === undefined || args.quotedText === undefined) return { reason: '新质疑需要 targetKind/targetId/quotedText：不引原文的质疑无法核对' }
      const evidence = args.contradictingEvidenceIds ?? []
      return {
        command: {
          kind: 'challenge.raise',
          requestId: '',
          targetKind: args.targetKind,
          targetId: args.targetId,
          quotedText: args.quotedText,
          contradictingEvidenceIds: evidence,
          affectedActionIds: args.affectedActionIds ?? [],
          adjudicatorActorId: (args.adjudicatorActorId ?? env.ctx.actorId) as ActorId,
          severity: evidence.length === 0 ? 'under_evidenced' : (args.severity ?? 'semantic_suspicion'),
          ...(args.targetRevision === undefined ? {} : { targetRevision: args.targetRevision }),
        },
      }
    },
  })

export const continuitySearchTool = (deps: ToolDeps) =>
  commandTool<{
    readonly query: string
    readonly mode: 'literal' | 'regex'
    readonly roots: readonly string[]
    readonly outcome: SearchReceipt['outcome']
    readonly coverage: SearchReceipt['coverage']
    readonly filters?: readonly string[]
    readonly synonyms?: readonly string[]
    readonly pagesFetched?: number
    readonly hasMore?: boolean
    readonly truncated?: boolean
    readonly errors?: readonly string[]
    readonly resultRefs?: readonly string[]
  }>(deps, {
    name: 'continuity_search',
    description: '登记检索回执。"没找到"只在 coverage=complete 且无截断无错误时可作存在性前提；否则记 partial/unknown。',
    parameters: {
      query: str('检索词或正则', true),
      mode: { type: 'string', enum: ['literal', 'regex'], description: '检索方式', required: true },
      roots: list('检索根范围', true),
      outcome: { type: 'string', enum: ['found', 'not_found_in_scope', 'incomplete', 'error'], description: '检索结果', required: true },
      coverage: { type: 'string', enum: ['complete', 'partial', 'unknown'], description: '覆盖程度', required: true },
      filters: list('过滤条件'),
      synonyms: list('同义词/别名'),
      pagesFetched: ints('翻页数'),
      hasMore: bool('还有未取回结果'),
      truncated: bool('结果被截断'),
      errors: list('检索错误'),
      resultRefs: list('命中定位引用'),
    },
    build: (args, env) => ({
      command: {
        kind: 'search.record',
        requestId: '',
        search: {
          query: args.query,
          mode: args.mode,
          roots: args.roots,
          filters: args.filters ?? [],
          synonyms: args.synonyms ?? [],
          pagesFetched: args.pagesFetched ?? 0,
          hasMore: args.hasMore ?? false,
          truncated: args.truncated ?? false,
          errors: args.errors ?? [],
          coverage: args.coverage,
          outcome: args.outcome,
          resultRefs: args.resultRefs ?? [],
          observedAt: env.now,
        },
      },
    }),
  })

export const continuityObligationTool = (deps: ToolDeps) =>
  commandTool<{
    readonly obligationId?: string
    readonly stage?: ObligationStage
    readonly statement?: string
    readonly ownerActorId?: string
    readonly taskId?: string
    readonly preconditions?: readonly string[]
    readonly receiptRefs?: readonly string[]
    readonly reason?: string
    readonly decisionSource?: string
    readonly triggerAt?: number
  }>(deps, {
    name: 'continuity_obligation',
    description: '登记承诺（不给 obligationId）或推进阶段（给 obligationId+stage）。承诺必须有责任人；deferred/cancelled 需写明原因与有权决定的来源；"脚本写好了"只算准备完成。',
    parameters: {
      obligationId: str('已有承诺 ID；填写即推进'),
      stage: { type: 'string', enum: ['proposed', 'ready', 'running', 'verified', 'delivered', 'blocked', 'deferred', 'cancelled'], description: '推进到的阶段' },
      statement: str('承诺内容（新登记必填）'),
      ownerActorId: str('责任人 Actor ID；缺省为提交者'),
      taskId: str('关联任务 ID'),
      preconditions: list('前提条件'),
      receiptRefs: list('verified/delivered 的回执引用'),
      reason: str('变更理由；blocked/deferred/cancelled 必填'),
      decisionSource: str('延后/取消决定的来源（用户指令、预算规则等）'),
      triggerAt: ints('触发时刻（毫秒）'),
    },
    build: (args, env) => {
      if (args.obligationId !== undefined) {
        if (args.stage === undefined) return { reason: '推进承诺需要指定 stage：阶段是状态，不是备注' }
        return {
          command: {
            kind: 'obligation.advance',
            requestId: '',
            obligationId: args.obligationId,
            stage: args.stage,
            ...(args.receiptRefs === undefined ? {} : { receiptRefs: args.receiptRefs }),
            ...(args.reason === undefined ? {} : { reason: args.reason }),
            ...(args.decisionSource === undefined ? {} : { decisionSource: args.decisionSource }),
          },
        }
      }
      if (args.statement === undefined) return { reason: '新承诺需要 statement：没有内容就没有可核对的完成条件' }
      return {
        command: {
          kind: 'obligation.propose',
          requestId: '',
          obligation: {
            statement: args.statement,
            ownerActorId: (args.ownerActorId ?? env.ctx.actorId) as ActorId,
            preconditions: args.preconditions ?? [],
            ...(args.taskId === undefined ? {} : { taskId: args.taskId }),
            ...(args.stage === undefined ? {} : { stage: args.stage }),
            ...(args.triggerAt === undefined ? {} : { triggerAt: args.triggerAt }),
          },
        },
      }
    },
  })

export const continuityReviewTool = (deps: ToolDeps) =>
  commandTool<{
    readonly targetKind: 'task' | 'artifact' | 'claim' | 'verification'
    readonly targetId: string
    readonly purpose?: 'dispatch' | 'delivery' | 'integration'
    readonly selfConsistent: VerificationOutcome
    readonly versusHistory: 'consistent' | 'conflict' | 'duplicate' | 'unknown'
    readonly sharedEvidenceIds?: readonly string[]
    readonly sawReferenceAnswer: boolean
    readonly independenceNote: string
    readonly methodRef: string
    readonly novelty?: string
    readonly targetRevision?: number
  }>(deps, {
    name: 'continuity_review',
    description: '登记独立审查。角色不同≠证据独立：与被审对象共用证据要如实填写。审查 ID、审查者与时刻由内核按绑定身份盖。',
    parameters: {
      targetKind: { type: 'string', enum: ['task', 'artifact', 'claim', 'verification'], description: '被审对象类型', required: true },
      targetId: str('被审对象 ID', true),
      targetRevision: ints('被审对象版本'),
      purpose: { type: 'string', enum: ['dispatch', 'delivery', 'integration'], description: '用途，缺省 delivery' },
      selfConsistent: { type: 'string', enum: ['pass', 'fail', 'unknown', 'error', 'not_run', 'not_applicable'], description: '自洽性结论', required: true },
      versusHistory: { type: 'string', enum: ['consistent', 'conflict', 'duplicate', 'unknown'], description: '与历史结果关系', required: true },
      sharedEvidenceIds: list('与被审对象共用的证据'),
      sawReferenceAnswer: bool('看过参考答案/既有结论', true),
      independenceNote: str('独立性说明；共用证据或看过参考答案必填', true),
      methodRef: str('审查方法定位', true),
      novelty: str('新增信息说明'),
    },
    build: (args) => built({
      kind: 'review.record',
      requestId: '',
      review: {
        targetKind: args.targetKind,
        targetId: args.targetId,
        selfConsistent: args.selfConsistent,
        versusHistory: args.versusHistory,
        sharedEvidenceIds: args.sharedEvidenceIds ?? [],
        sawReferenceAnswer: args.sawReferenceAnswer,
        independenceNote: args.independenceNote,
        methodRef: args.methodRef,
        ...(args.purpose === undefined ? {} : { purpose: args.purpose }),
        ...(args.targetRevision === undefined ? {} : { targetRevision: args.targetRevision }),
        ...(args.novelty === undefined ? {} : { novelty: args.novelty }),
      },
    }),
  })

export const continuityValidatorQualifyTool = (deps: ToolDeps) =>
  commandTool<{
    readonly validatorId?: string
    readonly name?: string
    readonly inputType?: string
    readonly scope?: string
    readonly assertions?: readonly string[]
    readonly allowedMissing?: readonly string[]
    readonly toleranceBasis?: string
    readonly codeRef?: string
    readonly effectiveSampleIds?: readonly string[]
    readonly counterSampleIds?: readonly string[]
    readonly criteriaRevision?: number
    readonly eligible?: boolean
    readonly reason?: string
  }>(deps, {
    name: 'continuity_validator_qualify',
    description: '登记并判定程序化验证器资格（限 reviewer/lead/user）。无正反样本、断言恒真（只依赖存在性字段、缺失即全通过）判为无资格；资格只在声明的 scope 与版本内有效。',
    parameters: {
      validatorId: str('已有验证器 ID；填写即重判'),
      name: str('验证器名称（新登记必填）'),
      inputType: str('输入类型'),
      scope: str('适用范围'),
      assertions: list('断言清单'),
      allowedMissing: list('允许缺失字段'),
      toleranceBasis: str('容差依据（dtype/量纲/算法误差）'),
      codeRef: str('实现定位', true),
      effectiveSampleIds: list('正样本 ID', true),
      counterSampleIds: list('反样本 ID', true),
      criteriaRevision: ints('针对的判据版本'),
      eligible: bool('判定有资格'),
      reason: str('判定理由'),
    },
    build: (args) => {
      if (args.name === undefined || args.inputType === undefined || args.scope === undefined || args.codeRef === undefined) {
        return missing('新验证器需要 name/inputType/scope/codeRef：范围与实现定位是资格的前提')
      }
      return built({
        kind: 'validator.qualify',
        requestId: '',
        ...(args.validatorId === undefined ? {} : { validatorId: args.validatorId }),
        eligible: args.eligible ?? true,
        ...(args.reason === undefined ? {} : { reason: args.reason }),
        validator: {
          name: args.name,
          inputType: args.inputType,
          scope: args.scope,
          assertions: args.assertions ?? [],
          allowedMissing: args.allowedMissing ?? [],
          codeRef: args.codeRef,
          effectiveSampleIds: args.effectiveSampleIds ?? [],
          counterSampleIds: args.counterSampleIds ?? [],
          ...(args.criteriaRevision === undefined ? {} : { criteriaRevision: args.criteriaRevision }),
          ...(args.toleranceBasis === undefined ? {} : { toleranceBasis: args.toleranceBasis }),
        },
      })
    },
  })

export const continuityDeliveryConfirmTool = (deps: ToolDeps) =>
  commandTool<{
    readonly deliveryId: string
    readonly stage: DeliveryEntry['stage']
    readonly handling?: HandlingState
    readonly reason?: string
  }>(deps, {
    name: 'continuity_delivery_confirm',
    description: '确认投递的阶段与处理状态。发送成功≠接收≠已整合≠已验收；只有真实取到内容并能引用才算 accepted/integrated；失败要写原因。',
    parameters: {
      deliveryId: str('投递记录 ID', true),
      stage: { type: 'string', enum: ['produced', 'registered', 'dispatched', 'received', 'processed', 'unrouted'], description: '到达阶段', required: true },
      handling: { type: 'string', enum: ['unprocessed', 'accepted', 'integrated', 'rejected'], description: '接收方处理状态' },
      reason: str('判定依据；rejected 必填'),
    },
    build: (args) => ({
      command: {
        kind: 'delivery.confirm',
        requestId: '',
        deliveryId: args.deliveryId,
        stage: args.stage,
        ...(args.handling === undefined ? {} : { handling: args.handling }),
        ...(args.reason === undefined ? {} : { reason: args.reason }),
      },
    }),
  })

export const continuityProposeCompleteTool = (deps: ToolDeps) =>
  commandTool<{ readonly note: string }>(deps, {
    name: 'continuity_propose_complete',
    description: 'Lead 提议 Mission 收口（只挂提案，不直接置为完成）。Supervisor/用户核结构条件后再执行 complete；已验收结果不丢失。',
    parameters: { note: str('收口依据', true) },
    build: (args) => ({ command: { kind: 'mission.proposeComplete', requestId: '', note: args.note } }),
  })

/* ------------------------------------------------------------------ v0.5 多路复用命令入口 */

/**
 * v0.5 的 37 条命令按接口组收敛成 7 个工具：`action` 选命令，`details` 是动作参数。
 * 工具层只做 JSON/形状层检查——字段级校验（必填、枚举、交叉约束）与权限一律留给内核，
 * 这里再抄一份就是两套口径互相打脸，拒绝理由也以内核给出的为准。
 */
type Details = Readonly<Record<string, unknown>>

/**
 * `details` 同时接受对象与 JSON 字符串：字符串走 `JSON.parse`，失败即拒并回传解析器原因；
 * 解析结果必须是对象——null、数组与标量都按"没给参数"处理。
 *
 * 参数 schema 里用 `type: 'json'`：参数 DSL 要求每个属性节点声明 `type` 或 `oneOf`
 * （未声明类型的节点在装载时会被 DSL 直接拒绝），而 `json` 是唯一同时放行对象与字符串的节点。
 */
function readDetails(raw: unknown): { readonly details: Details } | { readonly reason: string } {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown
    } catch (error) {
      return { reason: `details 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { reason: '该 action 需要 details' }
  return { details: value as Details }
}

/** 一个 action 的子构建器：与单命令工具同款，返回命令或拒绝理由。 */
type ActionDispatch = (details: Details) => { readonly command: Command } | { readonly reason: string }

/**
 * 多路复用入口复用的仍是 `commandTool`：身份、修订号幂等 `requestId`、内核提交与输出渲染
 * 走同一条路，这里只多一层 `action → 子构建器` 分发；`action` 枚举取自分发表的键序。
 */
function multiplexCommandTool(
  deps: ToolDeps,
  spec: { readonly name: string; readonly description: string; readonly dispatch: Readonly<Record<string, ActionDispatch>> },
) {
  return commandTool<{ readonly action: string; readonly details?: unknown }>(deps, {
    name: spec.name,
    description: spec.description,
    parameters: {
      action: { type: 'string', enum: Object.keys(spec.dispatch), description: '动作名', required: true },
      details: { type: 'json', description: '动作参数：对象或 JSON 字符串（字符串需为合法 JSON）；需要哪些键见工具描述' },
    },
    build: (args) => {
      const dispatch = spec.dispatch[args.action]
      if (dispatch === undefined) return missing(`未知 action：${args.action}`)
      const read = readDetails(args.details)
      if ('reason' in read) return missing(read.reason)
      return dispatch(read.details)
    },
  })
}

/** 探索与实验：工作分类、探索额度、实验预注册与推进、试验、路线与策略。 */
const experimentDispatch: Readonly<Record<string, ActionDispatch>> = {
  classifyWork: (d) => built({ kind: 'experiment.classifyWork', requestId: '', taskId: d.taskId as TaskId, workKind: d.workKind as WorkKind }),
  registerPolicy: (d) => built({ kind: 'exploration.registerPolicy', requestId: '', registration: d.registration as ExplorationRegistration }),
  releaseReservation: (d) => built({ kind: 'exploration.release', requestId: '', reason: d.reason as string, recheck: d.recheck as string }),
  restoreReservation: (d) => built({ kind: 'exploration.restore', requestId: '', reason: d.reason as string }),
  preregister: (d) => built({ kind: 'experiment.preregister', requestId: '', draft: d.draft as ExperimentDraft }),
  revise: (d) => built({ kind: 'experiment.revise', requestId: '', experimentId: d.experimentId as ExperimentId, revision: d.revision as ExperimentRevision }),
  advanceStage: (d) => built({ kind: 'experiment.advanceStage', requestId: '', experimentId: d.experimentId as ExperimentId, to: d.to as ExperimentStage, evidence: d.evidence as StageEvidence }),
  recordTrial: (d) => built({ kind: 'experiment.recordTrial', requestId: '', draft: d.draft as TrialDraft }),
  assessRoute: (d) => built({ kind: 'route.assess', requestId: '', input: d.input as RouteInput }),
  decideStrategy: (d) => built({ kind: 'strategy.decide', requestId: '', draft: d.draft as StrategyDecisionDraft }),
}

export const continuityExperimentTool = (deps: ToolDeps) =>
  multiplexCommandTool(deps, {
    name: 'continuity_experiment',
    description: '探索与实验写入口；details 可传对象或 JSON 字符串，键随 action：classifyWork{taskId,workKind}；registerPolicy{registration}；releaseReservation{reason,recheck}；restoreReservation{reason}；preregister{draft}；revise{experimentId,revision}；advanceStage{experimentId,to,evidence}；recordTrial{draft}；assessRoute{input}；decideStrategy{draft}。',
    dispatch: experimentDispatch,
  })

/** 猜想：捕获、成型、探针就绪、记录探针、推进、延后、收口、假设变更。 */
const conjectureDispatch: Readonly<Record<string, ActionDispatch>> = {
  capture: (d) => built({ kind: 'conjecture.capture', requestId: '', draft: d.draft as ConjectureDraft }),
  frame: (d) => built({ kind: 'conjecture.frame', requestId: '', claimId: d.claimId as ClaimId, framing: d.framing as ConjectureFraming }),
  probeReady: (d) => built({ kind: 'conjecture.probeReady', requestId: '', claimId: d.claimId as ClaimId, nextCheapestAction: d.nextCheapestAction as string }),
  recordProbe: (d) => built({ kind: 'conjecture.recordProbe', requestId: '', claimId: d.claimId as ClaimId, trialId: d.trialId as TrialId }),
  pursue: (d) => built({ kind: 'conjecture.pursue', requestId: '', claimId: d.claimId as ClaimId, reason: d.reason as string }),
  defer: (d) => built({
    kind: 'conjecture.defer',
    requestId: '',
    claimId: d.claimId as ClaimId,
    deferralReason: d.deferralReason as DeferralReason,
    note: d.note as string,
    ...(d.reentryCondition === undefined ? {} : { reentryCondition: d.reentryCondition as string }),
  }),
  close: (d) => built({
    kind: 'conjecture.close',
    requestId: '',
    claimId: d.claimId as ClaimId,
    reason: d.reason as string,
    ...(d.evidenceRefs === undefined ? {} : { evidenceRefs: d.evidenceRefs as readonly string[] }),
    ...(d.reentryConditions === undefined ? {} : { reentryConditions: d.reentryConditions as readonly string[] }),
  }),
  assumptionChange: (d) => built({ kind: 'conjecture.assumptionChange', requestId: '', claimId: d.claimId as ClaimId, change: d.change as AssumptionChange }),
}

export const continuityConjectureTool = (deps: ToolDeps) =>
  multiplexCommandTool(deps, {
    name: 'continuity_conjecture',
    description: '猜想写入口；details 可传对象或 JSON 字符串，键随 action：capture{draft}；frame{claimId,framing}；probeReady{claimId,nextCheapestAction}；recordProbe{claimId,trialId}；pursue{claimId,reason}；defer{claimId,deferralReason,note,reentryCondition?}；close{claimId,reason,evidenceRefs?,reentryConditions?}；assumptionChange{claimId,change}。',
    dispatch: conjectureDispatch,
  })

/** 环境接续：环境清单登记与修订、重开与推进接续、接续评估。 */
const environmentDispatch: Readonly<Record<string, ActionDispatch>> = {
  register: (d) => built({ kind: 'environment.register', requestId: '', input: d.input as EnvironmentInput }),
  revise: (d) => built({ kind: 'environment.revise', requestId: '', environmentId: d.environmentId as EnvironmentId, patch: d.patch as EnvironmentPatch }),
  openResume: (d) => built({ kind: 'resume.open', requestId: '', input: d.input as ResumeInput }),
  advanceResume: (d) => built({ kind: 'resume.advance', requestId: '', resumeId: d.resumeId as ResumeId, event: d.event as ResumeEvent }),
  assessResume: (d) => built({ kind: 'resume.assess', requestId: '', input: d.input as AssessInput }),
}

export const continuityEnvironmentTool = (deps: ToolDeps) =>
  multiplexCommandTool(deps, {
    name: 'continuity_environment',
    description: '环境接续写入口；details 可传对象或 JSON 字符串，键随 action：register{input}；revise{environmentId,patch}；openResume{input}；advanceResume{resumeId,event}；assessResume{input}。',
    dispatch: environmentDispatch,
  })

/** 机制治理：提案与修订、分类升降、状态迁移、运行记录与误报补记。 */
const mechanismDispatch: Readonly<Record<string, ActionDispatch>> = {
  propose: (d) => built({ kind: 'mechanism.propose', requestId: '', input: d.input as MechanismInput }),
  revise: (d) => built({ kind: 'mechanism.revise', requestId: '', mechanismId: d.mechanismId as MechanismId, patch: d.patch as MechanismPatch }),
  changeClass: (d) => built({ kind: 'mechanism.changeClass', requestId: '', mechanismId: d.mechanismId as MechanismId, nextClass: d.nextClass as MechanismClass, decision: d.decision as ClassDecision }),
  transition: (d) => built({
    kind: 'mechanism.transition',
    requestId: '',
    mechanismId: d.mechanismId as MechanismId,
    event: d.event as MechanismTransition,
    ...(d.detail === undefined ? {} : { detail: d.detail as TransitionDetail }),
  }),
  recordRun: (d) => built({ kind: 'mechanism.recordRun', requestId: '', input: d.input as MechanismRunInput }),
  recordMisreport: (d) => built({ kind: 'mechanism.recordMisreport', requestId: '', runId: d.runId as MechanismRunId, verdict: d.verdict as 'yes' | 'no' | 'unknown', note: d.note as string }),
}

export const continuityMechanismTool = (deps: ToolDeps) =>
  multiplexCommandTool(deps, {
    name: 'continuity_mechanism',
    description: '机制治理写入口；details 可传对象或 JSON 字符串，键随 action：propose{input}；revise{mechanismId,patch}；changeClass{mechanismId,nextClass,decision}；transition{mechanismId,event,detail?}；recordRun{input}；recordMisreport{runId,verdict,note}。',
    dispatch: mechanismDispatch,
  })

/** 目标效用：契约登记、效果观测推进与复核收口。 */
const outcomeDispatch: Readonly<Record<string, ActionDispatch>> = {
  register: (d) => built({
    kind: 'outcome.register',
    requestId: '',
    input: d.input as OutcomeContractInput,
    ...(d.reason === undefined ? {} : { reason: d.reason as string }),
    ...(d.authorizedBy === undefined ? {} : { authorizedBy: d.authorizedBy as ActorId }),
  }),
  observe: (d) => built({
    kind: 'outcome.observe',
    requestId: '',
    next: d.next as EffectObservationState,
    ...(d.note === undefined ? {} : { note: d.note as string }),
    ...(d.evidenceRefs === undefined ? {} : { evidenceRefs: d.evidenceRefs as readonly EvidenceId[] }),
  }),
  review: (d) => built({
    kind: 'outcome.review',
    requestId: '',
    triggers: d.triggers as readonly OutcomeReviewTrigger[],
    answers: d.answers as readonly OutcomeReviewAnswer[],
    conclusion: d.conclusion as OutcomeReviewInput['conclusion'],
  }),
}

export const continuityOutcomeTool = (deps: ToolDeps) =>
  multiplexCommandTool(deps, {
    name: 'continuity_outcome',
    description: '目标效用写入口；details 可传对象或 JSON 字符串，键随 action：register{input,reason?,authorizedBy?}；observe{next,note?,evidenceRefs?}；review{triggers,answers,conclusion}。',
    dispatch: outcomeDispatch,
  })

/** 整合：整合计划登记与修订、整合回执。 */
const integrationDispatch: Readonly<Record<string, ActionDispatch>> = {
  plan: (d) => built({ kind: 'integration.plan', requestId: '', input: d.input as IntegrationPlanInput }),
  revise: (d) => built({ kind: 'integration.revise', requestId: '', integrationId: d.integrationId as IntegrationId, input: d.input as IntegrationPlanInput }),
  receipt: (d) => built({ kind: 'integration.receipt', requestId: '', input: d.input as IntegrationReceiptInput }),
}

export const continuityIntegrationTool = (deps: ToolDeps) =>
  multiplexCommandTool(deps, {
    name: 'continuity_integration',
    description: '整合写入口；details 可传对象或 JSON 字符串，键随 action：plan{input}；revise{integrationId,input}；receipt{input}。',
    dispatch: integrationDispatch,
  })

/** 记录：覆盖记录与依据包（决策简报）。 */
const recordsDispatch: Readonly<Record<string, ActionDispatch>> = {
  recordCoverage: (d) => built({ kind: 'records.recordCoverage', requestId: '', coverage: d.coverage as RecordCoverage }),
  recordBrief: (d) => built({ kind: 'records.recordBrief', requestId: '', brief: d.brief as DecisionBrief }),
}

export const continuityRecordsTool = (deps: ToolDeps) =>
  multiplexCommandTool(deps, {
    name: 'continuity_records',
    description: '记录写入口；details 可传对象或 JSON 字符串，键随 action：recordCoverage{coverage}；recordBrief{brief}。',
    dispatch: recordsDispatch,
  })

/**
 * 领取执行权。与 `continuity_claim`（结论链上的主张）不是一回事：那个记命题，这个开干。
 * 准入条件（任务状态、并发上限、身份休眠、未裁硬冲突）全部由内核判，这里不复制一套。
 */
export const continuityClaimTaskTool = (deps: ToolDeps) =>
  commandTool<{ readonly taskId: string }>(deps, {
    name: 'continuity_claim_task',
    description: '领取任务执行权（开工），拿到租约后才能写检查点与提交。前提：任务已由人 approve 放行。身份取自当前会话绑定，不接受自报 actorId。注意与 continuity_claim 区分：那个记主张命题，这个开干。',
    parameters: { taskId: str('任务 ID', true) },
    build: (args) => built({ kind: 'task.claim', requestId: '', taskId: args.taskId }),
  })

/**
 * 供守卫与注册处共用：这些是插件自己的入口工具，准入守卫不拦它们（内核另有判定）。
 *
 * DS 前缀缓存纪律：工具声明列表从第 0 个 token 起参与前缀复用（DeepSeek 缓存命中要求
 * 与上一请求从第 0 token 起完全一致）。本名单与 `commandToolFactories` 的新增一律**追加在末尾**，
 * 禁止重排或中间插入——重排会改写声明列表，让整段已缓存前缀按未命中价重算（命中价约为其 1/50）。
 */
export const PLUGIN_TOOL_NAMES: readonly string[] = [
  'continuity_status',
  'continuity_checkpoint',
  'continuity_submit',
  'continuity_verify',
  'continuity_evidence',
  'continuity_claim',
  'continuity_challenge',
  'continuity_search',
  'continuity_obligation',
  'continuity_review',
  'continuity_validator_qualify',
  'continuity_delivery_confirm',
  'continuity_propose_complete',
  'continuity_experiment',
  'continuity_conjecture',
  'continuity_environment',
  'continuity_mechanism',
  'continuity_outcome',
  'continuity_integration',
  'continuity_records',
  'continuity_claim_task',
  'continuity_history',
]

/** 注册表：除 `continuity_status` / `continuity_checkpoint` 外的命令入口工具，由 index.ts 逐个注册。 */
export const commandToolFactories = [
  continuitySubmitTool,
  continuityVerifyTool,
  continuityEvidenceTool,
  continuityClaimTool,
  continuityChallengeTool,
  continuitySearchTool,
  continuityObligationTool,
  continuityReviewTool,
  continuityValidatorQualifyTool,
  continuityDeliveryConfirmTool,
  continuityProposeCompleteTool,
  continuityExperimentTool,
  continuityConjectureTool,
  continuityEnvironmentTool,
  continuityMechanismTool,
  continuityOutcomeTool,
  continuityIntegrationTool,
  continuityRecordsTool,
  continuityClaimTaskTool,
]

/**
 * 模型面 token 预算（DS 线格式口径）。
 *
 * 口径来源：本机 `<DSH 源码>` @ v0.2.1-alpha.1，
 * `packages/llm/llm-deepseek/src/serialize.ts:159-166` —— 每请求只上行
 * `name / description / parameters`，output schema 不进模型上下文。
 * 度量用 `rotation/brief.ts` 的 `estimateTokens`，覆盖全部 22 个定义。
 * 2026-10-14 实测 4842：v0.5 追加 7 个多路复用工具计入 1079，`continuity_status` 扩 5 个
 * aspect 后原 13 个定义由 3691 涨到 3763（13 个定义时实测 3691，压缩前 3952）。
 * 2026-10-15 追加 `continuity_claim_task`（装载到 web profile 后实测：会话无法自行领取执行权，
 * 只能由人类键入 `/continuity claim`，检查点链路在自动跑批里断在一半）。
 * 2026-10-15 追加 `continuity_history`（N4：归档历史回读工具）：22 个定义合计实测 5238，
 * 新增定义计 287，其余 21 个不变。
 * 2026-10-18 追加 `continuity_review.purpose`（三处审核按用途分开，复审 P1-1：内核要求
 * `purpose=integration` 但入口不传它，Mission 收不了口）：22 个定义合计实测 5267，
 * 只有 `continuity_review` 变动（+29），其余 21 个逐位不变。
 * 改动描述或参数后先跑 `test/token-budget.test.ts`，按实测同步本值并在此注明日期。
 */
export const TOOL_TEXT_TOKEN_BUDGET = 5267
