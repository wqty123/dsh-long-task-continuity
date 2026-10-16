/**
 * 工作台只读投影（`src/views/workbench.ts`；设计稿 v0.5 §15、审阅实施计划第 5 步）。
 *
 * 第 5 步的验收原文是三条：「所有终态和待复核状态可见，数据缺失不显示为零，
 * 浏览页面不创建原生任务」。本文件把这三条落成断言，另加两条投影纪律——
 * 顺序稳定（同一 sourceRevision 两次投影逐字节相同）与判据版本纪律
 * （旧 `criteriaRevision` 的结论不能替新版本判据背书，§5.1、§22.4）。
 *
 * 会话行的去重口径（`workbench.ts` 内 `sessionPriority`）：一条会话只出现一次，
 * 轮换行优先于绑定、绑定优先于尝试——「换会话」不是多出一个工作者，
 * 同一个 sessionId 更不许既算绑定又算尝试把 `sessionTotal` 翻倍。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { missionWorkbench } from '../src/views/workbench.ts'
import type { MissionControl } from '../src/core/control.ts'
import type { Mission } from '../src/core/entities.ts'
import { apply, checkpointPayload, ctx, draftMission, freshState, req, taskPayload, withClaimedTask } from './fixtures.ts'

function createdState(missionOverrides: Partial<Mission> = {}): MissionControl {
  const state = freshState()
  return apply(state, { kind: 'mission.create', requestId: req(), mission: draftMission(missionOverrides) })
}

/** 推进到"已提交待验收"。 */
function submittedState(): { readonly state: MissionControl, readonly taskId: string } {
  let state = createdState()
  state = apply(state, { kind: 'actor.register', requestId: req(), actorId: 'lead-1', role: 'lead', label: 'Lead', sessionId: 'sess-1' })
  state = apply(state, { kind: 'task.propose', requestId: req(), task: taskPayload() })
  const taskId = Object.keys(state.tasks)[0]!
  state = apply(state, { kind: 'task.approve', requestId: req(), taskId }, ctx('user', 'human'))
  state = apply(state, { kind: 'task.claim', requestId: req(), taskId }, ctx('lead', 'lead-1'))
  state = apply(state, { kind: 'task.checkpoint', requestId: req(), taskId, checkpoint: checkpointPayload() }, ctx('lead', 'lead-1'))
  state = apply(state, { kind: 'artifact.registerVersion', requestId: req(), taskId, uri: 'file:///work/report.md', contentHash: 'b'.repeat(64) }, ctx('lead', 'lead-1'))
  state = apply(state, { kind: 'task.submit', requestId: req(), taskId, leaseVersion: 1 }, ctx('lead', 'lead-1'))
  return { state, taskId }
}

/** 走完整条验收链：任务 completed 且 validity=current。 */
function fullyVerified(): { readonly state: MissionControl, readonly taskId: string } {
  const { state, taskId } = submittedState()
  return {
    state: apply(state, { kind: 'task.verify', requestId: req(), taskId, criterionId: 'crit_1', outcome: 'pass', method: 'node --test', methodVersion: '1', evidenceRefs: ['test/views-workbench.test.ts'] }, ctx('reviewer', 'rev-1')),
    taskId,
  }
}

/** 推进到轮换 COMMITTED：同时产生未收束轮换与一条未投递的启动 outbox。 */
function rotationCommitted(): MissionControl {
  let state = withClaimedTask().state
  const checkpoint = apply(state, { kind: 'continuity.checkpoint', requestId: req(), checkpoint: { actorId: 'lead-1', ...checkpointPayload() } }, ctx('lead', 'lead-1'))
  const checkpointId = checkpoint.checkpointOrder.at(-1)!
  state = apply(checkpoint, { kind: 'continuity.requestRotation', requestId: req(), actorId: 'lead-1', sourceSessionId: 'sess-1', targetSessionId: 'sess-2', checkpointId, trigger: 'manual', seedMessageId: 'seed-1' })
  const rotationId = Object.keys(state.rotations)[0]!
  for (const phase of ['QUIESCING', 'PREPARED', 'TARGET_READY', 'COMMITTED'] as const) {
    state = apply(state, { kind: 'continuity.advanceRotation', requestId: req(), rotationId, phase })
  }
  return state
}

test('工作台投影：终态可见、两次投影逐字节相同、浏览不写回任何状态（第 5 步验收）', () => {
  const { state, taskId } = fullyVerified()
  const before = JSON.stringify(state)
  const first = missionWorkbench(state)
  const second = missionWorkbench(state)
  assert.equal(JSON.stringify(state), before, '投影是只读的：控制记录一个字节都不动')
  assert.equal(JSON.stringify(first), JSON.stringify(second), '同一 revision 两次投影逐字节相同')
  assert.equal(first.sourceRevision, state.revision)
  assert.equal(first.schemaVersion, state.schemaVersion)
  assert.equal(first.generatedAt, state.lastCommittedAt)

  const row = first.tasks.find((item) => item.taskId === taskId)
  assert.ok(row)
  assert.equal(row.status, 'completed')
  assert.equal(row.validity, 'current')
  assert.equal(row.currentAttemptId, '', '完成后不再挂当前尝试')
  assert.equal(row.criteria[0]?.outcome, 'pass')
  assert.equal(row.criteriaSatisfied, true)
  assert.equal(first.counts.taskTotal, 1)
  assert.equal(first.counts.completedNow, 1)
  assert.equal(first.counts.needsReview, 0)
  assert.equal(first.ledger.tasks.some((item) => item.taskId === taskId), true, '台账原样附带')
})

test('工作台投影：待复核状态可见，旧判据版本的结论不替新版本背书（§5.1、R04 正例面）', () => {
  const { state, taskId } = submittedState()
  const halfDone = apply(state, { kind: 'task.verify', requestId: req(), taskId, criterionId: 'crit_1', outcome: 'unknown', method: '一次没跑完的核对', methodVersion: '1', evidenceRefs: [] }, ctx('reviewer', 'rev-1'))
  assert.equal(halfDone.tasks[taskId]?.status, 'verifying')

  const revised = apply(halfDone, { kind: 'task.revise', requestId: req(), taskId, criteria: [{ text: '台账与内核记录逐条一致' }], reason: '判据口径写歪了，改成逐条一致' }, ctx('lead', 'lead-1'))
  const board = missionWorkbench(revised)
  const row = board.tasks.find((item) => item.taskId === taskId)
  assert.ok(row)
  assert.equal(row.status, 'verifying', '修订不改业务状态，只打到需复核')
  assert.equal(row.validity, 'needs_review')
  assert.equal(row.criteriaRevision, 2)
  assert.equal(row.criteria[0]?.outcome, 'missing', 'v1 判据下的验证记录不能证明 v2 判据')
  assert.equal(row.criteriaSatisfied, false)
  assert.equal(board.counts.needsReview, 1)
  assert.equal(board.counts.completedNow, 0)
  assert.ok(board.alerts.some((alert) => alert.code === 'validity_needs_review'), '待复核必须进告警面')
  assert.ok(board.alerts.some((alert) => alert.refs.includes(taskId)))
})

test('工作台投影：读不到的面进 coverage.unavailable 并列原因，不显示为零（第 5 步验收）', () => {
  const board = missionWorkbench(fullyVerified().state)
  assert.deepEqual(board.coverage.unavailable.map((item) => item.face), ['contextOccupancy', 'cost', 'nativeTeamTasks', 'subagentDerivation', 'leaseLapsed'])
  for (const item of board.coverage.unavailable) {
    assert.ok(item.reason.length > 8, `${item.face} 必须写明为什么读不到，而不是留空或给 0`)
  }
  assert.ok(board.coverage.included.includes('tasks'))
  assert.ok(board.coverage.included.includes('rotations'))
  assert.equal(Object.keys(board.counts).some((key) => /cost|occupancy|token/i.test(key)), false, '没有任何来源的成本/占用数不许出现在投影里')
  assert.equal(Object.keys(board).some((key) => /cost|occupancy/i.test(key)), false)
  // 连会话定位都没有 = 没有尝试读取（与"尝试了但读不出来"是两回事，后者见下一条用例）
  assert.equal(board.native, null)
  assert.equal(board.tasks.every((row) => row.execution === '' && row.native === null && row.gateNote === ''), true)
  assert.equal(board.tasks.every((row) => row.acceptance === 'accepted'), true, '验收态只靠插件记录就能算，与原生面读到与否无关')
  assert.equal(board.alerts.some((alert) => alert.code.startsWith('native_')), false, '没尝试读取就不许编出原生告警')
})

test('工作台投影：原生板按链接合并成一张板，执行态与验收态分开记（新版复审 G1/G3）', () => {
  const { state, taskId } = fullyVerified()
  const nativeTasks = [
    { id: 'task-1', revision: 3, subject: '台账投影行', description: `continuity:task ${taskId}\n状态 completed`, status: 'completed', ownerName: 'lead' },
    { id: 'task-2', revision: 1, subject: `Mission ${state.missionId} 状态`, description: `continuity:mission ${state.missionId}\n本行是台账摘要`, status: 'in_progress' },
    { id: 'task-9', revision: 1, subject: '原生自己加的行', description: '与台账无关', status: 'pending' },
  ]
  const board = missionWorkbench(state, { sessionId: 'sess-1', tasks: nativeTasks })
  assert.equal(board.native?.phase, 'read')
  assert.equal(board.native?.readTotal, 3)
  assert.equal(board.native?.linkedTasks, 1, '链接从行自身的映射键重建：只有一行挂得上')
  assert.deepEqual(board.native?.unlinked.map((row) => row.nativeTaskId), ['task-9'], 'Mission 状态行不是"缺映射的工作项"，不进未链接清单')
  assert.ok(board.coverage.included.includes('nativeTeamTasks'))
  assert.equal(board.coverage.unavailable.some((item) => item.face === 'nativeTeamTasks'), false)
  const row = board.tasks.find((item) => item.taskId === taskId)!
  assert.equal(row.execution, 'completed', '执行态从原生 status 折算')
  assert.equal(row.acceptance, 'accepted', '验收态以插件记录为准')
  assert.equal(row.gateNote, '', '两边一致时无话可说')
  assert.equal(row.native?.nativeTaskId, 'task-1')
  assert.equal(row.native?.revision, 3)
  assert.equal(board.alerts.some((alert) => alert.code === 'native_unlinked_tasks'), true)

  // 口径矛盾：插件已验收，原生却还在 pending —— 两套状态不许各自放行
  const drift = missionWorkbench(state, { sessionId: 'sess-1', tasks: [{ ...nativeTasks[0]!, status: 'pending' }] })
  assert.equal(drift.tasks.find((item) => item.taskId === taskId)?.gateNote, '口径矛盾：插件已验收但原生执行未完成，可能依赖方已按原生状态放行，需核对')
})

test('工作台投影：原生板读不出来时进 unavailable 并写原因，不把"读不到"画成空板（G3）', () => {
  const { state, taskId } = fullyVerified()
  const board = missionWorkbench(state, { sessionId: 'sess-1', reason: 'agentTeams 服务未装载，无法取得一次原生读取' })
  assert.equal(board.native?.phase, 'unavailable')
  assert.equal(board.native?.readTotal, 0)
  assert.deepEqual(board.native?.unlinked, [])
  assert.ok(board.coverage.unavailable.some((item) => item.face === 'nativeTeamTasks' && item.reason.includes('agentTeams')))
  assert.equal(board.coverage.included.includes('nativeTeamTasks'), false)
  const alert = board.alerts.find((item) => item.code === 'native_board_unavailable')
  assert.ok(alert && alert.message.includes('不等于原生板为空'))
  const row = board.tasks.find((item) => item.taskId === taskId)!
  assert.equal(row.execution, '', '读失败时执行面是空的，不是 unknown（unknown = 读了但对不上词表）')
  assert.equal(row.native, null)
  assert.equal(row.gateNote, '', '读取失败不给每行编造核对提示')
  assert.equal(row.acceptance, 'accepted')
})

test('工作台投影：依赖只认 completed+current，未放行的依赖与依赖边都看得见（§6.2）', () => {
  let state = createdState()
  state = apply(state, { kind: 'task.propose', requestId: req(), task: taskPayload({ title: '上游任务' }) })
  const upstream = Object.keys(state.tasks)[0]!
  state = apply(state, { kind: 'task.propose', requestId: req(), task: taskPayload({ title: '下游任务', dependsOn: [upstream] }) })
  const downstream = Object.keys(state.tasks).find((id) => id !== upstream)!

  const pending = missionWorkbench(state)
  assert.deepEqual(pending.tasks.find((item) => item.taskId === downstream)?.unmetDependencies, [upstream], '上游还没完成：依赖未放行')
  assert.ok(pending.edges.some((edge) => edge.kind === 'task-depends' && edge.from === upstream && edge.to === downstream))

  const done = apply(state, { kind: 'task.approve', requestId: req(), taskId: upstream }, ctx('user', 'human'))
  const stillPending = missionWorkbench(done)
  assert.deepEqual(stillPending.tasks.find((item) => item.taskId === downstream)?.unmetDependencies, [upstream], 'ready 不算放行：只有 completed+current 才算（§6.2）')

  const verifiedUpstream = submittedState()
  const finished = missionWorkbench(verifiedUpstream.state)
  assert.deepEqual(finished.tasks.find((item) => item.taskId === verifiedUpstream.taskId)?.unmetDependencies, [], '没有依赖的任务行不许凭空生成未放行项')
})

test('工作台投影：轮换算续接不算新工作者，同一会话不因绑定+尝试重复计数', () => {
  const board = missionWorkbench(rotationCommitted())
  // COMMITTED 后绑定已折到 sess-2：一个 Actor、一条会话、一行带续接来源的轮换记录。
  // 去重前这里会出三行（绑定 + 尝试 + 轮换）把 sessionTotal 记成 3。
  assert.equal(board.sessions.length, 1)
  const rotationRow = board.sessions[0]
  assert.ok(rotationRow)
  assert.equal(rotationRow.kind, 'rotation', '轮换行优先于绑定与尝试')
  assert.equal(rotationRow.sessionId, 'sess-2')
  assert.equal(rotationRow.continuationOf, 'sess-1')
  assert.equal(rotationRow.phase, 'COMMITTED')
  assert.equal(board.counts.sessionTotal, 1)
  assert.equal(board.counts.actorTotal, 1, '轮换不产生第二个 Actor')
  assert.ok(board.edges.some((edge) => edge.kind === 'session-continuation' && edge.from === 'sess-1' && edge.to === 'sess-2'), '续接链要能回读前一个会话')
  assert.ok(board.alerts.some((alert) => alert.code === 'rotation_open'), '未收束轮换必须进告警面')
  const codes = board.alerts.map((alert) => alert.code)
  assert.deepEqual(codes, [...codes].sort(), '告警按 code 稳定排序')
})
