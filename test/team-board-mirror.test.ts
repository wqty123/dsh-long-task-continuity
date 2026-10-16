/**
 * 台账 → 原生 Agent Team 任务板 的投影与写入侧。
 *
 * 断言分三层：
 * 1. **真状态投影**（走 `missionLedger`，不手搓行）：映射键、字符上限、确定性。
 * 2. **纯规划**（`planMirror`）：一步收敛、幂等空转、终态不入板、别人的行不许动。
 * 3. **宿主面**（`boardTasksOf` + 同步器）：恶意/畸形返回逐个丢弃不抛；写失败只停本轮不上抛。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { missionLedger, type MissionLedger, type MissionLedgerTaskRow } from '../src/views/export.ts'
import {
  boardStatusOf,
  boardTasksOf,
  DESCRIPTION_MAX,
  markerKeyOf,
  MISSION_MARKER,
  mirrorRows,
  missionBoardStatus,
  missionMirrorRow,
  planMirror,
  SUBJECT_MAX,
  TASK_MARKER,
  taskMirrorRow,
  type BoardStatus,
  type BoardTaskView,
  type MirrorRow,
} from '../src/team/board-mirror.ts'
import { createTeamBoardSyncer, type TeamBoardLike } from '../src/team/board-sync.ts'
import type { AgentLike } from '../src/adapter/host-types.ts'
import { apply, checkpointPayload, ctx, draftMission, freshState, req, taskPayload } from './fixtures.ts'

// —— 真实状态 → 台账 → 投影行 ——

function ledgerFromKernel(): MissionLedger {
  let state = freshState()
  state = apply(state, { kind: 'mission.create', requestId: req(), mission: draftMission() })
  state = apply(state, { kind: 'actor.register', requestId: req(), actorId: 'lead-1', role: 'lead', label: 'Lead', sessionId: 'sess-1' })
  state = apply(state, { kind: 'task.propose', requestId: req(), task: taskPayload() })
  state = apply(state, { kind: 'task.propose', requestId: req(), task: taskPayload({ title: '第二条\n带   多个\t空格 的 标题' }) })
  const taskId = Object.keys(state.tasks)[0]!
  state = apply(state, { kind: 'task.approve', requestId: req(), taskId })
  state = apply(state, { kind: 'task.claim', requestId: req(), taskId }, ctx('lead', 'lead-1'))
  state = apply(state, { kind: 'task.checkpoint', requestId: req(), taskId, checkpoint: checkpointPayload() }, ctx('lead', 'lead-1'))
  return missionLedger(state)
}

test('真状态投影：每行的键、长度与标记都能回读', () => {
  const ledger = ledgerFromKernel()
  const rows = mirrorRows(ledger)
  assert.equal(rows.length, ledger.tasks.length + 1)
  assert.equal(rows[0]!.key, `${MISSION_MARKER} ${ledger.missionId}`)
  for (const row of rows) {
    assert.ok(row.subject.length <= SUBJECT_MAX, `subject 超上限：${row.subject.length}`)
    assert.ok(row.description.length <= DESCRIPTION_MAX, `description 超上限：${row.description.length}`)
    assert.equal(row.description.split('\n', 1)[0], row.key)
    assert.equal(markerKeyOf(row.description), row.key)
  }
  const taskKeys = rows.slice(1).map((row) => row.key)
  assert.deepEqual(taskKeys, ledger.tasks.map((task) => `${TASK_MARKER} ${task.taskId}`))
  // 标题里的连续空白被折成单空格，任务板行是单行标题（行序由视图决定，不按索引取）。
  assert.ok(rows.some((item) => item.subject === '第二条 带 多个 空格 的 标题'), '多空格/换行标题未折成单行')
  assert.ok(!rows.some((item) => item.subject.includes('\n')), 'subject 不允许含换行')
})

test('台账状态词表 → 任务板三档：终态与失效不进板', () => {
  assert.equal(boardStatusOf('planned', 'current'), 'pending')
  assert.equal(boardStatusOf('ready', 'current'), 'pending')
  assert.equal(boardStatusOf('blocked', 'current'), 'pending')
  assert.equal(boardStatusOf('retry_wait', 'current'), 'pending')
  assert.equal(boardStatusOf('leased', 'current'), 'in_progress')
  assert.equal(boardStatusOf('running', 'current'), 'in_progress')
  assert.equal(boardStatusOf('submitted', 'current'), 'in_progress')
  assert.equal(boardStatusOf('verifying', 'current'), 'in_progress')
  assert.equal(boardStatusOf('completed', 'current'), 'completed')
  // needs_review 仍可看（真值在描述里），invalid 与终态不入工作队列。
  assert.equal(boardStatusOf('completed', 'needs_review'), 'completed')
  assert.equal(boardStatusOf('running', 'needs_review'), 'in_progress')
  assert.equal(boardStatusOf('completed', 'invalid'), null)
  assert.equal(boardStatusOf('failed', 'current'), null)
  assert.equal(boardStatusOf('cancelled', 'current'), null)
  assert.equal(boardStatusOf('made-up-status', 'current'), null)
  assert.equal(missionBoardStatus('active'), 'in_progress')
  assert.equal(missionBoardStatus('waiting'), 'in_progress')
  assert.equal(missionBoardStatus('draft'), 'pending')
  assert.equal(missionBoardStatus('completed'), 'completed')
  assert.equal(missionBoardStatus('cancelled'), 'completed')
})

test('超长文本：subject 截到上限、description 保留首行标记', () => {
  const row = taskMirrorRow(taskRow({ taskId: 'tsk_long', title: 'x'.repeat(600), criteriaBlockers: ['b'.repeat(9000), 'c'.repeat(9000)] }))
  assert.equal(row.subject.length, SUBJECT_MAX)
  assert.ok(row.subject.endsWith('…'))
  assert.ok(row.description.length <= DESCRIPTION_MAX)
  assert.equal(row.description.split('\n', 1)[0], `${TASK_MARKER} tsk_long`)
})

// —— 纯规划 ——

function taskRow(overrides: Partial<MissionLedgerTaskRow> = {}): MissionLedgerTaskRow {
  return {
    taskId: 'tsk_1',
    title: '标题',
    status: 'ready',
    validity: 'current',
    priority: 1,
    criteriaCheck: 'pending',
    workKind: 'improve',
    currentAttemptId: '',
    attemptCount: 0,
    blockedReason: '',
    criteriaSatisfied: false,
    criteriaBlockers: [],
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function row(key: string, status: BoardStatus | null, subject = `S ${key}`, description = `${key}\n正文`): MirrorRow {
  return { key, subject, description, status }
}

function boardTask(id: string, key: string, status: BoardStatus, revision = 1, extra: Partial<BoardTaskView> = {}): BoardTaskView {
  return { id, revision, subject: `S ${key}`, description: `${key}\n正文`, status, ...extra }
}

test('空板：只给该进板的行建任务', () => {
  const rows = [row(`${MISSION_MARKER} m`, 'in_progress'), row(`${TASK_MARKER} a`, 'pending'), row(`${TASK_MARKER} b`, null)]
  const plan = planMirror(rows, [])
  assert.deepEqual(plan.map((op) => op.kind), ['create', 'create'])
  assert.ok(plan.every((op) => op.kind === 'create'))
})

test('一步收敛：每个当前档只推一步', () => {
  const cases: readonly { readonly from: BoardStatus; readonly to: BoardStatus; readonly expect: string }[] = [
    { from: 'pending', to: 'in_progress', expect: 'claim' },
    { from: 'in_progress', to: 'in_progress', expect: 'none' },
    { from: 'completed', to: 'in_progress', expect: 'reopen' },
    { from: 'in_progress', to: 'pending', expect: 'release' },
    { from: 'completed', to: 'pending', expect: 'reopen' },
    { from: 'pending', to: 'completed', expect: 'claim' },
    { from: 'in_progress', to: 'completed', expect: 'complete' },
    { from: 'completed', to: 'completed', expect: 'none' },
  ]
  for (const item of cases) {
    const rows = [row(`${TASK_MARKER} a`, item.to)]
    const board = [boardTask('task-1', `${TASK_MARKER} a`, item.from, 7)]
    const plan = planMirror(rows, board)
    if (item.expect === 'none') {
      // 档位相同时才比文本；本用例的文本一致，所以应空转。
      assert.deepEqual(plan, [], `${item.from}→${item.to}`)
    } else {
      assert.equal(plan.length, 1, `${item.from}→${item.to}`)
      assert.equal(plan[0]!.kind, item.expect, `${item.from}→${item.to}`)
      assert.deepEqual(plan[0], { kind: item.expect, id: 'task-1', expectedRevision: 7 })
    }
  }
})

test('文本漂移才 edit；已一致的行零写入', () => {
  const key = `${TASK_MARKER} a`
  const board = [boardTask('task-1', key, 'pending')]
  assert.deepEqual(planMirror([row(key, 'pending')], board), [])
  const changed = row(key, 'pending', 'S a', `${key}\n正文改了`)
  assert.deepEqual(planMirror([changed], board), [{ kind: 'edit', id: 'task-1', expectedRevision: 1, subject: 'S a', description: `${key}\n正文改了` }])
})

test('终态与失效：在册则 delete，不在册不建', () => {
  const key = `${TASK_MARKER} a`
  assert.deepEqual(planMirror([row(key, null)], [boardTask('task-9', key, 'in_progress', 3)]), [
    { kind: 'delete', id: 'task-9', expectedRevision: 3 },
  ])
  assert.deepEqual(planMirror([row(key, null)], []), [])
})

test('不是台账投影的行一律不动；重复键只建一次', () => {
  const foreign = [{ id: 'task-1', revision: 4, subject: '别人的活', description: '没有标记\n正文', status: 'pending' as const }]
  const rows = [row(`${TASK_MARKER} a`, 'pending'), row(`${TASK_MARKER} a`, 'pending')]
  const plan = planMirror(rows, foreign)
  assert.equal(plan.length, 1)
  assert.ok(plan.every((op) => op.kind === 'create'))
  assert.ok(!plan.some((op) => 'id' in op && op.id === 'task-1'))
})

// —— 宿主面收窄 ——

test('boardTasksOf：畸形条目逐个丢弃，getter 抛错不传染', () => {
  const hostile = [
    null,
    'x',
    1,
    { id: '', revision: 1, subject: 's', description: 'd', status: 'pending' },
    { id: 'task-1', revision: 0, subject: 's', description: 'd', status: 'pending' },
    { id: 'task-1', revision: 1.5, subject: 's', description: 'd', status: 'pending' },
    { id: 'task-2', revision: 1, subject: 5, description: 'd', status: 'pending' },
    { id: 'task-3', revision: 1, subject: 's', description: 'd', status: 'deleted' },
    { id: 'task-4', revision: 2, subject: 's', description: 'd', status: 'in_progress', ownerName: '' },
    {
      get id(): string {
        throw new Error('boom')
      },
    },
  ]
  const narrowed = boardTasksOf(hostile)
  assert.deepEqual(narrowed, [{ id: 'task-4', revision: 2, subject: 's', description: 'd', status: 'in_progress' }])
  assert.equal(boardTasksOf(undefined).length, 0)
  assert.equal(boardTasksOf({}).length, 0)
})

// —— 同步器 ——

interface BoardCall {
  readonly action: string
  readonly detail: string
}

/** 假板内部行：多一个 `deleted` 墓碑和一个 ownerId，与宿主的快照同形。 */
type BoardRow = Omit<BoardTaskView, 'status'> & { status: BoardStatus | 'deleted'; ownerId?: string }

/** 按宿主的规则长出一块假任务板：id 由板分配、revision 递增、delete 只留墓碑。 */
function makeBoard(): { board: TeamBoardLike; calls: BoardCall[]; rows: Map<string, BoardRow> } {
  const rows = new Map<string, BoardRow>()
  const calls: BoardCall[] = []
  let next = 1
  const list = (): BoardTaskView[] =>
    [...rows.values()].flatMap((task): BoardTaskView[] =>
      task.status === 'deleted' ? [] : [{ id: task.id, revision: task.revision, subject: task.subject, description: task.description, ...task.ownerName === undefined ? {} : { ownerName: task.ownerName }, status: task.status as BoardStatus }])
  const board: TeamBoardLike = {
    listTasks: () => list(),
    async createTask(_caller, request) {
      calls.push({ action: 'create', detail: request.subject })
      const id = `task-${next}`
      next += 1
      rows.set(id, { id, revision: 1, subject: request.subject, description: request.description, status: 'pending' })
      return rows.get(id)
    },
    async updateTask(caller, request) {
      calls.push({ action: request.action, detail: request.taskId })
      const current = rows.get(request.taskId)
      if (current === undefined) throw new Error(`team task "${request.taskId}" not found`)
      if (current.revision !== request.expectedRevision) throw new Error('stale team task revision')
      const status: BoardRow['status'] =
        request.action === 'claim' ? 'in_progress'
        : request.action === 'complete' ? 'completed'
        : request.action === 'delete' ? 'deleted'
        : 'pending'
      rows.set(request.taskId, {
        ...current,
        revision: current.revision + 1,
        status,
        ...request.subject === undefined ? {} : { subject: request.subject },
        ...request.description === undefined ? {} : { description: request.description },
        ...(request.action === 'claim' ? { ownerId: caller.id } : {}),
      })
      return rows.get(request.taskId)
    },
  }
  return { board, calls, rows }
}

function ledgerFixture(tasks: readonly MissionLedgerTaskRow[], status = 'active'): MissionLedger {
  return {
    missionId: 'm-1',
    sourceRevision: 9,
    projectionRevision: 'r9b1',
    basisRevision: 1,
    generatedAt: 1_700_000_000_000,
    freshness: 'current',
    freshnessDetail: '无待传播项',
    admissionClosed: false,
    status,
    waitingReason: '',
    objective: '把长期任务做完',
    objectiveRevision: 1,
    policyRevision: 1,
    collaboration: 'supervised',
    leadActorId: 'lead-1',
    nextStep: '继续 tsk_1',
    completedNow: 0,
    completedTotal: 0,
    taskTotal: tasks.length,
    tasks,
    leases: [],
    checkpoints: [],
    resources: [],
    openItems: [],
    gaps: [],
  }
}

const LEAD = { id: 'sess-lead' } as unknown as AgentLike

test('同步器：跨轮收敛（建→领），每步都重读板面', async () => {
  const { board, calls, rows } = makeBoard()
  const ledger = ledgerFixture([taskRow({ taskId: 'tsk_a', status: 'running', validity: 'current' })])
  const syncer = createTeamBoardSyncer(
    { board: () => board, leadAgent: () => LEAD, ledger: async () => ledger },
    { info: () => undefined, warn: (message) => { throw new Error(message) } },
  )
  // 每次投影都含 Mission 状态行 + 1 条任务行，所以一拍两个动作。
  const result = await syncer.run()
  assert.equal(result.reason, 'converged')
  assert.equal(result.ops, 4)
  assert.deepEqual(calls.map((call) => call.action), ['create', 'create', 'claim', 'claim'])
  const mirrored = [...rows.values()]
  assert.equal(mirrored.length, 2)
  const task = mirrored.find((task) => markerKeyOf(task.description) === `${TASK_MARKER} tsk_a`)
  assert.ok(task !== undefined)
  assert.equal(task.status, 'in_progress')
  assert.equal(task.ownerId, 'sess-lead')
})

test('同步器：完成档需要三轮（建→领→收口），不猜宿主分配的 id', async () => {
  const { board, calls } = makeBoard()
  const ledger = ledgerFixture([taskRow({ taskId: 'tsk_b', status: 'completed', criteriaSatisfied: true })])
  const syncer = createTeamBoardSyncer({ board: () => board, leadAgent: () => LEAD, ledger: async () => ledger }, { info: () => undefined, warn: () => undefined })
  const result = await syncer.run()
  assert.equal(result.reason, 'converged')
  assert.deepEqual(calls.map((call) => call.action), ['create', 'create', 'claim', 'claim', 'complete'])
})

test('同步器：缺服务、缺活体 Agent、缺记录都只报告不抛', async () => {
  const { board } = makeBoard()
  const ledger = ledgerFixture([taskRow()])
  const log = { info: () => undefined, warn: () => undefined }
  const noService = await createTeamBoardSyncer({ board: () => undefined, leadAgent: () => LEAD, ledger: async () => ledger }, log).run()
  assert.equal(noService.reason, 'no-agent-teams-service')
  const noAgent = await createTeamBoardSyncer({ board: () => board, leadAgent: () => undefined, ledger: async () => ledger }, log).run()
  assert.equal(noAgent.reason, 'no-live-lead-agent')
  const noRecord = await createTeamBoardSyncer({ board: () => board, leadAgent: () => LEAD, ledger: async () => null }, log).run()
  assert.equal(noRecord.reason, 'no-mission-record')
  const throws = await createTeamBoardSyncer(
    { board: () => board, leadAgent: () => LEAD, ledger: async () => { throw new Error('存储读不到') } },
    log,
  ).run()
  assert.equal(throws.reason, 'op-failed')
})

test('同步器：写入抛错只停本轮，第二拍按新板面重来', async () => {
  const { board } = makeBoard()
  const ledger = ledgerFixture([taskRow({ taskId: 'tsk_c', status: 'running' })])
  let warnCount = 0
  let first = true
  const flaky: TeamBoardLike = {
    listTasks: (caller) => board.listTasks(caller),
    createTask: (caller, request) => board.createTask(caller, request),
    updateTask: (caller, request) => {
      if (first) {
        first = false
        return Promise.reject(new Error('TEAM_TASK_BLOCKED: 别人挂了依赖'))
      }
      return board.updateTask(caller, request)
    },
  }
  const messages: string[] = []
  const syncer = createTeamBoardSyncer(
    { board: () => flaky, leadAgent: () => LEAD, ledger: async () => ledger },
    { info: () => undefined, warn: (message) => { warnCount += 1; messages.push(message) } },
  )
  const failed = await syncer.run()
  assert.equal(failed.reason, 'op-failed')
  assert.equal(failed.ops, 2)
  assert.match(String(failed.detail), /TEAM_TASK_BLOCKED/)
  const retried = await syncer.run()
  assert.equal(retried.reason, 'converged')
  assert.equal(warnCount, 1)
  assert.ok(messages[0]!.includes('op-failed'))
})

test('同步器：同一时刻只跑一轮', async () => {
  const { board } = makeBoard()
  const ledger = ledgerFixture([taskRow({ taskId: 'tsk_d', status: 'running' })])
  // 卡点放在 `leadAgent()`：那是 run() 里的第一个 await，第二拍必然在它返回前就进来。
  // 挂在 createTask 上不安全——release() 可能跑在回调安装之前，用例自己会吊死（审阅 R7）。
  let release = (): void => {}
  const gate = new Promise<AgentLike>((resolve) => { release = () => { resolve(LEAD) } })
  let markEntered = (): void => {}
  const entered = new Promise<void>((resolve) => { markEntered = resolve })
  const syncer = createTeamBoardSyncer(
    {
      board: () => board,
      leadAgent: () => {
        markEntered()
        return gate
      },
      ledger: async () => ledger,
    },
    { info: () => undefined, warn: () => undefined },
  )
  const first = syncer.run()
  await entered
  const second = await syncer.run()
  assert.equal(second.reason, 'already-running')
  release()
  assert.equal((await first).reason, 'converged')
})

test('同步器：maxRounds 兜住两个写入者互相顶牛', async () => {
  const ledger = ledgerFixture([], 'active')
  let revision = 1
  const fighting: TeamBoardLike = {
    listTasks: () => [{ id: 'task-1', revision, subject: 'S', description: `${MISSION_MARKER} m-1\n正文`, status: 'pending' }],
    createTask: async () => {
      throw new Error('不该再建')
    },
    async updateTask() {
      revision += 1
      return { id: 'task-1', revision, subject: 'S', description: `${MISSION_MARKER} m-1\n正文`, status: 'pending' }
    },
  }
  const result = await createTeamBoardSyncer(
    { board: () => fighting, leadAgent: () => LEAD, ledger: async () => ledger },
    { info: () => undefined, warn: () => undefined },
    3,
  ).run()
  assert.equal(result.reason, 'round-limit')
  assert.equal(result.ops, 3)
})

test('Mission 状态行：目标、下一步与缺口都进描述，不含修订号', () => {
  const ledger = ledgerFixture([taskRow()], 'waiting')
  const summary = missionMirrorRow(ledger)
  assert.equal(summary.key, `${MISSION_MARKER} m-1`)
  assert.ok(summary.description.includes('把长期任务做完'))
  assert.ok(summary.description.includes('继续 tsk_1'))
  assert.ok(!summary.description.includes('r9b1'), '视图 revision 每提交就变，不能进任务板文本')
  assert.ok(!summary.description.includes('"sourceRevision"'))
  assert.equal(summary.status, 'in_progress')
})
