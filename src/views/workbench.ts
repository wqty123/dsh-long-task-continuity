/**
 * 工作台只读投影（设计稿 v0.5 §15、审阅计划第 5 步）。
 *
 * 三条从审阅里学到的约束：
 * 1. **只派生，不判定**：本文件不调模型、不取墙钟、不写存储。视图层拿到的每个数都能指回控制记录的某个字段，
 *    过期与否交给客户端时钟比较（§22.18 DG-18，与 `missionLedger` 的租约行同一口径）。
 * 2. **缺数据不显示为零**：读不到的面进 `coverage.unavailable` 并列明原因，
 *    页面据此显示"未知"，不能把"没有观测面"画成"占用 0%"或"成本 0"。
 * 3. **顺序稳定**：所有集合按显式 id 排序，同一个 `sourceRevision` 两次投影逐字节相同，
 *    页面才不会因为数组顺序变化闪一下、或者把排序差当成新事件。
 * 4. **原生侧只对照、不抢真值**（新版复审 G1/G3）：调用方把**一次原生任务板读取**作参数递进来，
 *    本文件不取服务、不取墙钟；读到就按链接合并成一张板（验收结论仍以插件记录为准），
 *    没读到就把这一面写进 `coverage.unavailable`，绝不把"读不到"画成"原生板是空的"。
 */
import type { MissionControl } from '../core/control.ts'
import type { Attempt, Criterion, Task } from '../core/entities.ts'
import type { MergedTaskCard, NativeTaskLink, NativeTeamTaskView } from '../adapter/agent-teams.ts'
import { acceptanceFromNative, dependencyRisks, linksFromNativeBoard, mergeTaskView } from '../adapter/agent-teams.ts'
import type { MissionLedger } from './export.ts'
import { missionLedger } from './export.ts'
import { MISSION_MARKER, markerKeyOf } from '../team/board-mirror.ts'

/** 面板的实现身份，同时是宿主右侧停靠面里这个页签类型的 `kind`。 */
export const WORKBENCH_KIND = 'continuity-workbench'
/** 只读投影路由：与 `/api/continuity.ledger` 同一条鉴权栅栏，浏览器侧去掉前导斜杠使用。 */
export const WORKBENCH_PATH = '/api/continuity.workspace'

export interface WorkbenchCriterionRow {
  readonly criterionId: string
  readonly text: string
  readonly required: boolean
  /** 只认与当前 `criteriaRevision` 同号的最新验证；对不上号的一律 `missing`，旧结论不能替新版本判据背书。 */
  readonly outcome: string
  readonly method: string
}

export interface WorkbenchTaskRow {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly validity: string
  readonly priority: number
  readonly workKind: string
  readonly scope: string
  readonly ownerActorId: string
  readonly ownerSessionId: string
  readonly currentAttemptId: string
  readonly attemptCount: number
  readonly maxAttempts: number
  readonly dependsOn: readonly string[]
  /** 依赖当前是否真的放行：`completed` 且 `validity=current` 才算（§6.2，`submitted` 不算）。 */
  readonly unmetDependencies: readonly string[]
  readonly resourceKeys: readonly string[]
  readonly blockedReason: string
  readonly criteriaCheck: string
  readonly criteriaSatisfied: boolean
  readonly criteriaBlockers: readonly string[]
  readonly criteria: readonly WorkbenchCriterionRow[]
  readonly objectiveRevision: number
  readonly specRevision: number
  readonly criteriaRevision: number
  readonly updatedAt: number
  /**
   * 原生执行状态（`pending`/`running`/`completed`/`unknown`），由 `mergeTaskView` 按链接折算；
   * 空串 = 这一面根本没读（调用方没给会话定位，或原生板读取失败），页面显示"未知"而不是"没有"。
   */
  readonly execution: string
  /** 插件验收态（`none`/`pending`/`accepted`/`needs_review`）；与 `execution` 分开记，两套状态不互相冒充。 */
  readonly acceptance: string
  /** 链接解析到的原生行摘要；没有链接、或链接的行读不到时为 `null`（不编造）。 */
  readonly native: WorkbenchNativeTaskRef | null
  /** 关卡备注：`''` = 无话可说；其余为 G1 定义的警示句（原生完成但未验收、口径矛盾、链接缺失等）。 */
  readonly gateNote: string
}

/** 任务行上的原生侧摘要（字段全部来自 `MergedTaskCard.native`，缺面即字段缺席）。 */
export interface WorkbenchNativeTaskRef {
  readonly nativeTaskId: string
  readonly title: string
  readonly status: string
  readonly assignee: string
  /** 原生快照版本；读不到为 `null`，不折算成 0。 */
  readonly revision: number | null
  readonly ready: boolean | null
  readonly blockedBy: readonly string[]
}

/**
 * 调用方递进来的一次原生读取（G3 的"左右联动"数据面：左栏选中哪个会话，右栏就读那个会话的 Team）。
 *
 * `tasks` 缺席表示没读到，此时 `reason` 必须写清为什么——"未读取"与"读到的空板"是两回事，
 * 前者进 `coverage.unavailable`，后者是 `phase='read'` 且 `readTotal=0`。
 */
export interface WorkbenchNativeInput {
  /** 本次定位所用的会话（`?sessionId=`，或由组合层回落到 Mission Lead 的绑定会话）。 */
  readonly sessionId: string
  /** `normalizeNativeTasks` 的结果：一次读取、同一个 Team。 */
  readonly tasks?: readonly NativeTeamTaskView[]
  /** 没读到的原因（给了 `tasks` 时忽略）。 */
  readonly reason?: string
  /** 插件 taskId → 原生任务链接；由组合层从任务板自身的映射键重建（`linksFromNativeBoard`）。 */
  readonly links?: Readonly<Record<string, NativeTaskLink>>
}

/** 未建立链接的原生行（执行事实只出现一次：已经挂上卡片的不在这里）。 */
export interface WorkbenchNativeTaskRow {
  readonly nativeTaskId: string
  readonly title: string
  readonly status: string
  readonly assignee: string
}

/** 合并后的原生板概览。 */
export interface WorkbenchNativeBoard {
  readonly sessionId: string
  /** `read` = 读到了（空板也算读到）；`unavailable` = 没读到，`reason` 给出原因。 */
  readonly phase: 'read' | 'unavailable'
  readonly reason: string
  /** 本次读到的原生行数；`unavailable` 时固定 0，页面按 `phase` 显示"未知"而不是"0 项"。 */
  readonly readTotal: number
  /** 挂上了原生摘要的插件任务卡数。 */
  readonly linkedTasks: number
  /** 原生依赖 DAG 与插件验收态对不上的可断言清单（`dependencyRisks`）。 */
  readonly risks: readonly string[]
  readonly unlinked: readonly WorkbenchNativeTaskRow[]
}

export interface WorkbenchActorRow {
  readonly actorId: string
  readonly label: string
  readonly role: string
  readonly teamId: string
  readonly sessionId: string
  readonly bindingVersion: number
  readonly retired: boolean
  readonly dormant: boolean
  readonly available: boolean
  readonly waitingFor: string
  /** 该 Actor 手上还在跑/待核对的 Attempt，页面据此把"逻辑工作者"与"会话实例"分开画。 */
  readonly liveAttemptIds: readonly string[]
}

export interface WorkbenchSessionRow {
  readonly sessionId: string
  readonly actorId: string
  readonly kind: 'bound' | 'attempt' | 'rotation'
  /** 轮换续接：`continuationOf` 指向前一个会话，同一个 Actor 不因换会话而多出一个工作者。 */
  readonly continuationOf: string
  readonly rotationId: string
  readonly phase: string
}

export type WorkbenchEdgeKind = 'task-depends' | 'team-member' | 'team-lead' | 'session-continuation'

export interface WorkbenchEdgeRow {
  readonly kind: WorkbenchEdgeKind
  readonly from: string
  readonly to: string
  readonly label: string
}

export interface WorkbenchAlertRow {
  readonly code: string
  readonly severity: 'info' | 'warning'
  readonly message: string
  readonly refs: readonly string[]
}

export interface MissionWorkbench {
  readonly missionId: string
  readonly sourceRevision: number
  readonly generatedAt: number
  readonly schemaVersion: number
  readonly status: string
  readonly objective: string
  readonly nextStep: string
  readonly admissionClosed: boolean
  readonly coverage: { readonly included: readonly string[]; readonly unavailable: readonly { readonly face: string; readonly reason: string }[] }
  readonly counts: { readonly taskTotal: number; readonly completedNow: number; readonly blocked: number; readonly needsReview: number; readonly submitted: number; readonly running: number; readonly failed: number; readonly cancelled: number; readonly actorTotal: number; readonly sessionTotal: number }
  readonly tasks: readonly WorkbenchTaskRow[]
  readonly actors: readonly WorkbenchActorRow[]
  readonly sessions: readonly WorkbenchSessionRow[]
  readonly edges: readonly WorkbenchEdgeRow[]
  readonly alerts: readonly WorkbenchAlertRow[]
  /**
   * 原生侧合并概览（G3 只读双栏）。`null` = 调用方连会话定位都没给，这一面**没有尝试读取**；
   * 与 `phase:'unavailable'`（尝试了但读不出来）分开，页面两种情况都显示"未知"但原因不同。
   */
  readonly native: WorkbenchNativeBoard | null
  /** 既有台账原样带上：任务行以外的检查点、资源、缺口与新鲜度仍按 `missionLedger` 口径读。 */
  readonly ledger: MissionLedger
}

const byId = (a: { readonly taskId: string }, b: { readonly taskId: string }): number => a.taskId.localeCompare(b.taskId)
const byActor = (a: { readonly actorId: string }, b: { readonly actorId: string }): number => a.actorId.localeCompare(b.actorId)

/** 当前判据版本的最新结论；版本不符或从未验证都回 `missing`，不拿旧版本结论冒充新版本。 */
function criterionOutcome(state: MissionControl, task: Task, criterion: Criterion): { readonly outcome: string; readonly method: string } {
  const matching = Object.values(state.verifications)
    .filter((item) => item.taskId === task.taskId && item.criterionId === criterion.criterionId && item.criteriaRevision === task.criteriaRevision)
    .sort((a, b) => a.verificationId.localeCompare(b.verificationId))
  const last = matching[matching.length - 1]
  return last === undefined ? { outcome: 'missing', method: '' } : { outcome: last.outcome, method: last.method }
}

/** 谁在跑这个任务：当前 Attempt 的持有者；没有 Attempt 时是"未领取"，不是"没有人"。 */
function ownerOf(state: MissionControl, task: Task): { readonly actorId: string; readonly sessionId: string; readonly attemptId: string } {
  const attempt: Attempt | undefined = task.currentAttemptId === undefined ? undefined : state.attempts[task.currentAttemptId]
  if (attempt === undefined) return { actorId: '', sessionId: '', attemptId: '' }
  const actor = state.actors[attempt.actorId]
  return { actorId: attempt.actorId, sessionId: attempt.sessionId ?? actor?.sessionId ?? '', attemptId: attempt.attemptId }
}

function unmetDependencies(task: Task, tasks: Readonly<Record<string, Task>>): string[] {
  return task.dependsOn.filter((depId) => {
    const dep = tasks[depId]
    return dep === undefined || dep.status !== 'completed' || dep.validity !== 'current'
  })
}

/** 任务行的插件侧底座：原生面（执行/验收/链接/备注）由第二段再贴上去。 */
type TaskRowBase = Omit<WorkbenchTaskRow, 'execution' | 'acceptance' | 'native' | 'gateNote'>

/** 合并一行的原生面：`cards` 里没有这张卡 = 这一面没读，字段按"未知"缺席处理。 */
function nativeFieldsOf(row: TaskRowBase, card: MergedTaskCard | undefined) {
  if (card === undefined) {
    // 没读原生板时执行面是空的（不是 unknown：unknown 表示"读了但状态对不上词表"）；
    // 验收态仍能从插件记录算出来，所以这里只有 `execution` 与 `native` 退场。
    return {
      execution: '',
      acceptance: acceptanceFromNative(undefined, { validity: row.validity, status: row.status, criteriaSatisfied: row.criteriaSatisfied }).acceptance,
      native: null,
      gateNote: '',
    }
  }
  return {
    execution: card.execution,
    acceptance: card.acceptance,
    native: card.native === undefined ? null : {
      nativeTaskId: card.native.nativeTaskId,
      title: card.native.title ?? '',
      status: card.native.status ?? '',
      assignee: card.native.assignee ?? '',
      revision: card.native.revision ?? null,
      ready: card.native.ready ?? null,
      blockedBy: card.native.blockedBy ?? [],
    },
    gateNote: card.gateNote,
  }
}

/**
 * 一次原生读取 → 合并概览 + 卡片索引（`mergeTaskView` 的结果按 taskId 建索引供任务行贴回）。
 *
 * 只在 `tasks` 真的读到时才合并：读取失败时**不**调 `mergeTaskView`，否则每一行都会拿到
 * `mergeTaskView` 的"读了但对不上"的 gateNote，把"没读到"画成"原生板状态可疑"。
 */
function nativeBoardOf(
  input: WorkbenchNativeInput,
  rows: readonly TaskRowBase[],
): { readonly board: WorkbenchNativeBoard; readonly cards: Map<string, MergedTaskCard> } {
  const unavailable = (reason: string): { board: WorkbenchNativeBoard; cards: Map<string, MergedTaskCard> } => ({
    board: { sessionId: input.sessionId, phase: 'unavailable', reason, readTotal: 0, linkedTasks: 0, risks: [], unlinked: [] },
    cards: new Map<string, MergedTaskCard>(),
  })
  const tasks = input.tasks
  if (tasks === undefined) return unavailable(input.reason ?? '调用方没有给出原生任务板读取结果')
  const links = input.links ?? linksFromNativeBoard(tasks, input.sessionId)
  const merged = mergeTaskView({
    pluginTasks: rows.map((row) => ({
      taskId: row.taskId,
      title: row.title,
      status: row.status,
      validity: row.validity,
      criteriaSatisfied: row.criteriaSatisfied,
    })),
    nativeTasks: tasks,
    links,
  })
  // Mission 状态行是台账摘要、不是缺映射的工作项，不能混进"未链接"清单里当噪声。
  const missionRowIds = new Set<string>()
  for (const task of tasks) {
    if (task.id === undefined || task.description === undefined) continue
    const key = markerKeyOf(task.description)
    if (key !== undefined && key.startsWith(`${MISSION_MARKER} `)) missionRowIds.add(task.id)
  }
  const unlinked = merged.unlinked
    .filter((row) => row.nativeTaskId === undefined || !missionRowIds.has(row.nativeTaskId))
    .map((row) => ({
      nativeTaskId: row.nativeTaskId ?? '',
      title: row.title ?? '',
      status: row.status ?? '',
      assignee: row.assignee ?? '',
    }))
  const cards = new Map(merged.tasks.map((card) => [card.taskId, card]))
  return {
    board: {
      sessionId: input.sessionId,
      phase: 'read',
      reason: '',
      readTotal: tasks.length,
      linkedTasks: merged.tasks.filter((card) => card.native !== undefined).length,
      risks: dependencyRisks(merged),
      unlinked,
    },
    cards,
  }
}

export function missionWorkbench(state: MissionControl, native?: WorkbenchNativeInput): MissionWorkbench {
  const ledger = missionLedger(state)
  const tasks = Object.values(state.tasks).sort(byId)
  const actors = Object.values(state.actors).sort(byActor)
  const attempts = Object.values(state.attempts)

  const baseRows: TaskRowBase[] = tasks.map((task) => {
    const owner = ownerOf(state, task)
    const report = ledger.tasks.find((row) => row.taskId === task.taskId)
    return {
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      validity: task.validity,
      priority: task.priority,
      workKind: task.workKind ?? '',
      scope: task.scope,
      ownerActorId: owner.actorId,
      ownerSessionId: owner.sessionId,
      currentAttemptId: owner.attemptId,
      attemptCount: task.attemptCount,
      maxAttempts: task.maxAttempts,
      dependsOn: task.dependsOn.slice(),
      unmetDependencies: unmetDependencies(task, state.tasks),
      resourceKeys: task.resourceKeys.slice(),
      blockedReason: task.blockedReason ?? '',
      criteriaCheck: task.criteriaCheck,
      criteriaSatisfied: report?.criteriaSatisfied ?? false,
      criteriaBlockers: report?.criteriaBlockers ?? [],
      criteria: task.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        text: criterion.text,
        required: criterion.required,
        ...criterionOutcome(state, task, criterion),
      })),
      objectiveRevision: task.objectiveRevision,
      specRevision: task.specRevision,
      criteriaRevision: task.criteriaRevision,
      updatedAt: task.updatedAt,
    }
  })

  const nativeResult = native === undefined ? undefined : nativeBoardOf(native, baseRows)
  const nativeBoard: WorkbenchNativeBoard | null = nativeResult === undefined ? null : nativeResult.board
  const cards = nativeResult?.cards ?? new Map<string, MergedTaskCard>()
  const taskRows = baseRows.map((row) => ({ ...row, ...nativeFieldsOf(row, cards.get(row.taskId)) }))

  const actorRows = actors.map((actor) => ({
    actorId: actor.actorId,
    label: actor.label,
    role: actor.role,
    teamId: actor.teamId ?? '',
    sessionId: actor.sessionId ?? '',
    bindingVersion: actor.bindingVersion,
    retired: actor.retired,
    dormant: actor.dormant,
    available: actor.available,
    waitingFor: actor.waitingFor ?? '',
    liveAttemptIds: attempts
      .filter((attempt) => attempt.actorId === actor.actorId && (attempt.status === 'running' || attempt.status === 'recovering'))
      .map((attempt) => attempt.attemptId)
      .sort(),
  }))

  const sessions: WorkbenchSessionRow[] = []
  for (const rotation of Object.values(state.rotations).sort((a, b) => a.rotationId.localeCompare(b.rotationId))) {
    sessions.push({
      sessionId: rotation.targetSessionId,
      actorId: rotation.actorId,
      kind: 'rotation',
      continuationOf: rotation.sourceSessionId,
      rotationId: rotation.rotationId,
      phase: rotation.phase,
    })
  }
  for (const actor of actors) {
    if (actor.sessionId !== undefined && actor.sessionId.length > 0) {
      sessions.push({ sessionId: actor.sessionId, actorId: actor.actorId, kind: 'bound', continuationOf: '', rotationId: '', phase: '' })
    }
  }
  for (const attempt of attempts.slice().sort((a, b) => a.attemptId.localeCompare(b.attemptId))) {
    if (attempt.sessionId === undefined || attempt.sessionId.length === 0) continue
    sessions.push({ sessionId: attempt.sessionId, actorId: attempt.actorId, kind: 'attempt', continuationOf: '', rotationId: '', phase: attempt.status })
  }

  const edges: WorkbenchEdgeRow[] = []
  for (const task of taskRows) {
    for (const depId of task.dependsOn) {
      edges.push({ kind: 'task-depends', from: depId, to: task.taskId, label: state.tasks[depId]?.title ?? depId })
    }
  }
  for (const team of Object.values(state.teams).sort((a, b) => a.teamId.localeCompare(b.teamId))) {
    for (const memberId of team.memberActorIds.slice().sort()) {
      edges.push({ kind: 'team-member', from: team.teamId, to: memberId, label: state.actors[memberId]?.label ?? memberId })
    }
    edges.push({ kind: 'team-lead', from: team.teamId, to: team.leadActorId, label: state.actors[team.leadActorId]?.label ?? team.leadActorId })
  }
  for (const session of sessions) {
    if (session.continuationOf.length > 0) {
      edges.push({ kind: 'session-continuation', from: session.continuationOf, to: session.sessionId, label: session.rotationId })
    }
  }

  const pendingOutbox = Object.values(state.outbox).filter((entry) => entry.completedAt === undefined)
  const inFlightClaims = pendingOutbox.filter((entry) => entry.claimedAt !== undefined && entry.completedAt === undefined)
  const alerts: WorkbenchAlertRow[] = []
  if (state.admissionClosed) alerts.push({ code: 'admission_closed', severity: 'warning', message: '业务入场关闭：受管写入需要显式恢复或核对通过后才放行', refs: [state.missionId] })
  const blocked = tasks.filter((task) => task.status === 'blocked')
  if (blocked.length > 0) alerts.push({ code: 'tasks_blocked', severity: 'warning', message: `${blocked.length} 个任务处于阻塞，原因记在任务行上`, refs: blocked.map((task) => task.taskId) })
  const suspicious = tasks.filter((task) => task.criteriaCheck === 'suspicious')
  if (suspicious.length > 0) alerts.push({ code: 'criteria_suspicious', severity: 'warning', message: '任务书互斥检查报告疑点，派单前需人工裁定', refs: suspicious.map((task) => task.taskId) })
  const needsReview = tasks.filter((task) => task.validity === 'needs_review')
  if (needsReview.length > 0) alerts.push({ code: 'validity_needs_review', severity: 'warning', message: '依据被撤回过、待复核的完成项', refs: needsReview.map((task) => task.taskId) })
  if (pendingOutbox.length > 0) alerts.push({ code: 'outbox_pending', severity: 'info', message: `外发箱待消费 ${pendingOutbox.length} 条`, refs: pendingOutbox.map((entry) => entry.outboxId) })
  if (inFlightClaims.length > 0) alerts.push({ code: 'outbox_claimed_in_flight', severity: 'info', message: '已被领取但未确认落盘：结果未知，需按幂等键核对', refs: inFlightClaims.map((entry) => entry.outboxId) })
  const openRotations = Object.values(state.rotations).filter((rotation) => rotation.phase !== 'ACTIVE')
  if (openRotations.length > 0) alerts.push({ code: 'rotation_open', severity: 'warning', message: '轮换未收口，交接后的核对还没走完', refs: openRotations.map((rotation) => rotation.rotationId) })
  const unknownOperations = Object.values(state.operations).filter((op) => op.status === 'outcome_unknown')
  if (unknownOperations.length > 0) alerts.push({ code: 'operation_outcome_unknown', severity: 'warning', message: '外部操作结果未知：不能重发，要先核对', refs: unknownOperations.map((op) => op.operationId) })
  // 原生面三条各一条汇总（页面按 `code` 做 React key，同类拆成多行会撞 key；逐条明细在 `native` 区里列）。
  if (nativeBoard !== null && nativeBoard.phase === 'unavailable') {
    alerts.push({ code: 'native_board_unavailable', severity: 'warning', message: `原生任务板没读到：${nativeBoard.reason}；执行状态未知，不等于原生板为空`, refs: [nativeBoard.sessionId] })
  }
  if (nativeBoard !== null && nativeBoard.risks.length > 0) {
    alerts.push({ code: 'native_dependency_risk', severity: 'warning', message: `原生依赖与插件验收态对不上 ${nativeBoard.risks.length} 项：以插件记录为准，逐条见原生板区`, refs: [nativeBoard.sessionId] })
  }
  if (nativeBoard !== null && nativeBoard.unlinked.length > 0) {
    alerts.push({ code: 'native_unlinked_tasks', severity: 'info', message: `原生板上 ${nativeBoard.unlinked.length} 行还没有插件任务链接：执行事实只在原生侧，插件不知道它在干什么`, refs: nativeBoard.unlinked.map((row) => row.nativeTaskId).filter((id) => id !== '') })
  }
  alerts.sort((a, b) => a.code.localeCompare(b.code))

  // 一条会话只出现一次，且优先按信息量大的身份显示：轮换 > 绑定 > 尝试。
  // 「换会话」不是多出一个工作者，同一个 sessionId 更不能既算绑定又算尝试而行数翻倍。
  const sessionPriority = (kind: WorkbenchSessionRow['kind']): number => kind === 'rotation' ? 0 : kind === 'bound' ? 1 : 2
  const uniqueSessions = new Map<string, WorkbenchSessionRow>()
  for (const session of sessions) {
    const current = uniqueSessions.get(session.sessionId)
    if (current === undefined || sessionPriority(session.kind) < sessionPriority(current.kind)) {
      uniqueSessions.set(session.sessionId, session)
    }
  }

  return {
    missionId: state.missionId,
    sourceRevision: state.revision,
    generatedAt: state.lastCommittedAt,
    schemaVersion: state.schemaVersion,
    status: state.mission.status,
    objective: state.mission.objective,
    nextStep: ledger.nextStep,
    admissionClosed: state.admissionClosed,
    coverage: {
      included: [
        'mission', 'tasks', 'attempts', 'actors', 'teams', 'rotations', 'verifications', 'operations', 'outbox', 'checkpoints', 'resources',
        ...(nativeBoard !== null && nativeBoard.phase === 'read' ? ['nativeTeamTasks'] : []),
      ],
      unavailable: [
        { face: 'contextOccupancy', reason: '上下文占用是会话侧观测，不在控制记录里；由 dsh-context 适配层单独提供，缺读数时页面显示未知' },
        { face: 'cost', reason: '本包不采集 token 用量，没有任何来源可以证明一个成本数' },
        ...(nativeBoard === null
          ? [{ face: 'nativeTeamTasks', reason: '调用方没有给出会话定位（页签未绑定会话、Mission 也没有 Lead 会话），原生任务板这一面根本没尝试读取；未知不等于空板' }]
          : nativeBoard.phase === 'read'
            ? []
            : [{ face: 'nativeTeamTasks', reason: `${nativeBoard.reason}；原生执行状态未知，不等于原生板为空` }]),
        { face: 'subagentDerivation', reason: '原生子代理父子关系由宿主观测，控制记录只有 Actor 与会话绑定' },
        { face: 'leaseLapsed', reason: '视图层不取墙钟；租约行给出 leaseExpiresAt，由客户端时钟比较' },
      ],
    },
    counts: {
      taskTotal: tasks.length,
      completedNow: taskRows.filter((task) => task.status === 'completed' && task.validity === 'current').length,
      blocked: blocked.length,
      needsReview: needsReview.length,
      submitted: tasks.filter((task) => task.status === 'submitted').length,
      running: attempts.filter((attempt) => attempt.status === 'running').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
      cancelled: tasks.filter((task) => task.status === 'cancelled').length,
      actorTotal: actors.length,
      sessionTotal: uniqueSessions.size,
    },
    tasks: taskRows,
    actors: actorRows,
    sessions: [...uniqueSessions.values()].sort((a, b) => `${a.kind}:${a.actorId}:${a.sessionId}`.localeCompare(`${b.kind}:${b.actorId}:${b.sessionId}`)),
    edges,
    alerts,
    native: nativeBoard,
    ledger,
  }
}
