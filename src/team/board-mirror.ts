/**
 * 台账 → 原生 Agent Team 任务板 的纯映射（任务板是投影，不是第二权威，§22.18 DG-18）。
 *
 * 为什么走任务板而不是再开一个页签：dsh-context 的「编队」页把宿主 experimental agent-team 的
 * `agentTeam` 投影直接读成"成员 + 任务板"（dsh-context `src/client/fleetTeam.ts`、
 * `src/client/components/taskBoard.tsx`），而那份投影的数据源就是 Lead 会话日志里的 `team/task`
 * 事件（dsh: `packages/experimental/agent-team/src/task-board.ts:44`、`projection.ts:342`）。
 * 因此台账行写进任务板就会出现在编队页上——不 fork 它的 UI、不加页签、不写第二套视觉。
 *
 * 约束：
 * 1. **纯函数**：不 import 宿主、不取墙钟、不写盘；同一输入两次规划逐字节相同。
 * 2. **幂等**：映射键写在 description 首行的机器可读标记里（不写进 subject——subject 要截到 200 字），
 *    每轮都从任务板自身重建，插件内存里不保存第二份状态。
 * 3. **一轮每行最多一个动作**：`createTask` 的任务 id 由宿主分配（`task-N`），本轮拿不到就不猜，
 *    状态靠下一轮收敛。
 * 4. **文本面照抄宿主校验**：subject ≤200、description ≤16384、去空白后非空
 *    （dsh: `packages/experimental/agent-team/src/validation.ts:12`）。
 * 5. **不冒充**：原生任务板没有 failed/cancelled 档，也不区分 needs_review；这类行不进任务板
 *    （已从工作队列摘除），真值仍只在台账里，编队页只是"接下来能干的活"。
 */
import type { MissionLedger, MissionLedgerTaskRow } from '../views/export.ts'

/** 台账任务行在任务板上的映射键（写在 description 首行）。 */
export const TASK_MARKER = 'continuity:task'
/** Mission 状态行在任务板上的映射键。 */
export const MISSION_MARKER = 'continuity:mission'
/** 宿主对 subject 的硬上限。 */
export const SUBJECT_MAX = 200
/** 宿主对 description 的硬上限。 */
export const DESCRIPTION_MAX = 16_384

/** 原生任务板的三档（`deleted` 只作规划目标，不出现在 `listTasks` 结果里）。 */
export type BoardStatus = 'pending' | 'in_progress' | 'completed'

/** 任务板上一行的可读视图（宿主 `TeamTaskView` 的可信子集）。 */
export interface BoardTaskView {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: BoardStatus
  readonly ownerName?: string
}

/** 规划输入：一行台账该长成什么样。 */
export interface MirrorRow {
  readonly key: string
  readonly subject: string
  readonly description: string
  /** `null` = 不进任务板（已终态或已失效），在册则删除。 */
  readonly status: BoardStatus | null
}

/** 规划输出：一次任务板写入动作。`id` 为 `null` 表示本轮新建。 */
export type MirrorOp =
  | { readonly kind: 'create'; readonly subject: string; readonly description: string }
  | {
      readonly kind: 'claim' | 'release' | 'reopen' | 'complete' | 'delete'
      readonly id: string
      readonly expectedRevision: number
    }
  | {
      readonly kind: 'edit'
      readonly id: string
      readonly expectedRevision: number
      readonly subject: string
      readonly description: string
    }

/** 折掉换行与多余空白：subject 是单行标题。 */
function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/** subject 截断：宿主只按字符数拒绝，不按字符数省略，所以自己截。 */
function subjectOf(value: string, fallback: string): string {
  const text = oneLine(value) === '' ? fallback : oneLine(value)
  return text.length <= SUBJECT_MAX ? text : `${text.slice(0, SUBJECT_MAX - 1)}…`
}

/** description 截断：保留首行标记，否则映射键会被自己截丢。 */
function descriptionOf(lines: readonly string[]): string {
  const body = lines.join('\n')
  if (body.length <= DESCRIPTION_MAX) return body
  const head = lines[0] ?? ''
  const tail = '\n…（台账正文过长，已截断；全文回读 /continuity status 或 api/continuity.ledger）'
  const room = Math.max(0, DESCRIPTION_MAX - head.length - tail.length)
  return `${head}${tail.slice(0, room)}`
}

/** 台账任务状态 → 原生任务板三档。 */
export function boardStatusOf(status: string, validity: string): BoardStatus | null {
  if (validity === 'invalid') return null
  if (status === 'completed') return 'completed'
  if (status === 'leased' || status === 'running' || status === 'submitted' || status === 'verifying') return 'in_progress'
  if (status === 'planned' || status === 'ready' || status === 'blocked' || status === 'retry_wait') return 'pending'
  // failed / cancelled 与词表外的新状态：不写进工作队列，真值留在台账。
  return null
}

/** Mission 状态 → 状态行的档位；终态归到已完成，不是"还有活"。 */
export function missionBoardStatus(status: string): BoardStatus {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return 'completed'
  if (status === 'draft') return 'pending'
  return 'in_progress'
}

/** 一行台账任务 → 任务板行。 */
export function taskMirrorRow(row: MissionLedgerTaskRow): MirrorRow {
  const key = `${TASK_MARKER} ${row.taskId}`
  return {
    key,
    subject: subjectOf(row.title, row.taskId),
    description: descriptionOf([
      key,
      `状态 ${row.status}｜判据 ${row.criteriaCheck}｜验收 ${row.criteriaSatisfied ? '已按当前判据证明' : '未证明'}`,
      `有效性 ${row.validity}｜优先级 ${row.priority}｜工作分类 ${oneLine(row.workKind) === '' ? '未分类' : row.workKind}｜已尝试 ${row.attemptCount} 次`,
      `当前尝试 ${row.currentAttemptId === '' ? '无' : row.currentAttemptId}`,
      `阻塞 ${row.blockedReason === '' ? '无' : row.blockedReason}`,
      `未证明判据 ${row.criteriaBlockers.length === 0 ? '无' : row.criteriaBlockers.map(oneLine).join('；')}`,
      '（本行由台账投影生成，不要在此领用或收口；改状态走 /continuity）',
    ]),
    status: boardStatusOf(row.status, row.validity),
  }
}

/** 台账任务行全集 → 任务板行全集（顺序沿用视图的确定性排序）。 */
export function taskMirrorRows(ledger: MissionLedger): MirrorRow[] {
  return ledger.tasks.map(taskMirrorRow)
}

/** Mission 概览 → 一条常驻状态行（下一步、未决事项与收口缺口）。 */
export function missionMirrorRow(ledger: MissionLedger): MirrorRow {
  const key = `${MISSION_MARKER} ${ledger.missionId}`
  return {
    key,
    subject: subjectOf(`Mission ${ledger.missionId} 状态`, key),
    description: descriptionOf([
      key,
      `Mission ${ledger.status}${ledger.waitingReason === '' ? '' : `（${ledger.waitingReason}）`}｜协作 ${ledger.collaboration}｜负责人 ${ledger.leadActorId === '' ? '未定' : ledger.leadActorId}`,
      `目标（修订 ${ledger.objectiveRevision}）：${oneLine(ledger.objective)}`,
      `下一步：${oneLine(ledger.nextStep)}`,
      `已完成 ${ledger.completedNow} / ${ledger.taskTotal}（按当前有效性计，validity 非 current 的不算）`,
      `业务入场 ${ledger.admissionClosed ? '关闭（需 /continuity recover）' : '开放'}｜视图新鲜度 ${ledger.freshness}：${ledger.freshnessDetail}`,
      `未决事项 ${ledger.openItems.length === 0 ? '无' : ledger.openItems.map(oneLine).join('；')}`,
      `收口缺口 ${ledger.gaps.length === 0 ? '无' : ledger.gaps.map(oneLine).join('；')}`,
      '（本行是台账摘要，不是可领取的工作项）',
    ]),
    status: missionBoardStatus(ledger.status),
  }
}

/** 全量规划输入：Mission 状态行 + 任务行。 */
export function mirrorRows(ledger: MissionLedger): MirrorRow[] {
  return [missionMirrorRow(ledger), ...taskMirrorRows(ledger)]
}

/** 从任务板行的 description 取回映射键；不是台账投影的行返回 undefined。 */
export function markerKeyOf(description: string): string | undefined {
  const first = description.split('\n', 1)[0] ?? ''
  const task = /^continuity:task (\S+)$/u.exec(first)
  if (task !== null) return `continuity:task ${task[1]}`
  const mission = /^continuity:mission (\S+)$/u.exec(first)
  if (mission !== null) return `continuity:mission ${mission[1]}`
  return undefined
}

/** 只在已存在的行上做状态推进（`create`/`edit` 由 `planMirror` 自己决定）。 */
type BoardStep = 'claim' | 'release' | 'reopen' | 'complete' | 'delete'

/** 向目标档位推进一步；已在目标档时返回 undefined（两档之间没有直达边的，先退回再进）。 */
function stepTo(current: BoardStatus, target: BoardStatus): BoardStep | undefined {
  if (current === target) return undefined
  // target === 'in_progress'：pending 直接领用，completed 先重开（下一轮再领）。
  if (target === 'in_progress') return current === 'pending' ? 'claim' : 'reopen'
  if (target === 'pending') return current === 'in_progress' ? 'release' : 'reopen'
  // target === 'completed'：pending 先领用，in_progress 才收口。
  return current === 'pending' ? 'claim' : 'complete'
}

/**
 * 比较任务板现状与目标，产出至多"每行一个"的写入动作。
 * 已一致的行不产出动作，因此空转轮次零事件写入。
 * @param rows - 规划输入（`mirrorRows` 的结果）。
 * @param board - 任务板现状（`listTasks` 收窄后的行）。
 * @returns 按 `rows` 顺序排列的动作列表。
 */
export function planMirror(rows: readonly MirrorRow[], board: readonly BoardTaskView[]): MirrorOp[] {
  const ops: MirrorOp[] = []
  const claimed = new Set<string>()
  for (const row of rows) {
    const found = board.find((task) => markerKeyOf(task.description) === row.key)
    if (found === undefined) {
      if (row.status === null || claimed.has(row.key)) continue
      claimed.add(row.key)
      ops.push({ kind: 'create', subject: row.subject, description: row.description })
      continue
    }
    if (row.status === null) {
      ops.push({ kind: 'delete', id: found.id, expectedRevision: found.revision })
      continue
    }
    const step = stepTo(found.status, row.status)
    if (step !== undefined) {
      ops.push({ kind: step, id: found.id, expectedRevision: found.revision })
      continue
    }
    if (found.subject !== row.subject || found.description !== row.description) {
      ops.push({ kind: 'edit', id: found.id, expectedRevision: found.revision, subject: row.subject, description: row.description })
    }
  }
  return ops
}

/**
 * 收窄宿主 `listTasks` 的返回：非数组整体丢弃、单行形状不合即跳过（不抛）。
 * 任务板是宿主对象，属性读取本身也可能被 getter 抛，因此整段包 try。
 * @param value - 宿主返回值（不可信）。
 * @returns 形状可信的 rows，顺序保持宿主顺序。
 */
export function boardTasksOf(value: unknown): BoardTaskView[] {
  if (!Array.isArray(value)) return []
  const result: BoardTaskView[] = []
  for (const item of value) {
    try {
      if (item === null || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (typeof record.id !== 'string' || record.id === '') continue
      if (typeof record.subject !== 'string') continue
      if (typeof record.description !== 'string') continue
      if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 1) continue
      const status = record.status
      if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
      const owner = record.ownerName
      result.push({
        id: record.id,
        revision: record.revision,
        subject: record.subject,
        description: record.description,
        status,
        ...typeof owner === 'string' && owner !== '' ? { ownerName: owner } : {},
      })
    } catch {
      continue
    }
  }
  return result
}
