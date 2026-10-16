/**
 * 派生视图（§5.2–§5.3、§22.18 DG-18）。视图层只读、不落盘，所以用例的核心断言是两类：
 * **确定性**（同一状态两次渲染逐字节相同，排序键显式）与**不许粉饰**（缺口、未决、失效版本必须原样出现）。
 * v0.3 变化：每份视图顶部有 view_meta（sourceRevision/projectionRevision/freshness）；
 * 任务表带 validity/修订三元组；收口缺口只按当前判据版本判定（§6.4），
 * "Mission 验收项无对应记录"移交给 mission.complete（completion.ts），视图不再重复判定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMissionMarkdown, renderRecoveryMarkdown, renderTimelineMarkdown, toJsonl, viewBundle } from '../src/views/export.ts'
import { assess } from '../src/core/recovery.ts'
import type { ArchiveSnapshot } from '../src/core/archive.ts'
import type { ControlEvent, MissionControl } from '../src/core/control.ts'
import type { Mission } from '../src/core/entities.ts'
import { apply, checkpointPayload, ctx, draftMission, freshState, NOW, req, taskPayload, withClaimedTask } from './fixtures.ts'

function createdState(missionOverrides: Partial<Mission> = {}): MissionControl {
  let state = freshState()
  return apply(state, { kind: 'mission.create', requestId: req(), mission: draftMission(missionOverrides) })
}

/** 推进到"已提交待验收"：不写验证记录。 */
function toSubmit(): { readonly state: MissionControl; readonly taskId: string } {
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

/** 走完整条验收链的记录：收口缺口应为零。 */
function fullyVerified(): MissionControl {
  const { state, taskId } = toSubmit()
  // §5.1：验证按 criterionId 登记，判据 ID 由内核在 propose 时盖（crit_1）。
  return apply(state, { kind: 'task.verify', requestId: req(), taskId, criterionId: 'crit_1', outcome: 'pass', method: 'node --test', methodVersion: '1', evidenceRefs: ['test/views-export.test.ts'] }, ctx('reviewer', 'rev-1'))
}

/** 推进到 COMMITTED：同时产生未收束轮换与一条未投递的启动 outbox。 */
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

test('主台账：同一状态两次渲染逐字节相同，视图元数据与关键字段一个不缺', () => {
  const state = withClaimedTask().state
  const first = renderMissionMarkdown(state)
  assert.equal(first, renderMissionMarkdown(state))
  // §22.18 DG-18：视图是投影，顶部必须带 sourceRevision / projectionRevision / freshness。
  assert.match(first, /^# Mission 台账 Mission mss_test\n\n- sourceRevision：\d+（控制记录修订；本文件只是它的投影，不是第二权威）\n/)
  assert.match(first, new RegExp(`^- projectionRevision：r${state.revision}b${state.basisRevision}$`, 'm'))
  assert.match(first, /^- freshness：current（依据修订 0，无待传播项与失效结论）$/m)
  assert.match(first, /^- generatedAt：2023-11-14T22:13:20\.000Z$/m)
  assert.match(first, /^- 状态：active$/m)
  assert.match(first, /- 目标（修订 1）：把连续性台账跑通/)
  assert.match(first, /- 规则快照修订：1；依据有效性修订：0/)
  assert.match(first, /- 协作模式：solo；权限引用：host:default/)
  // §13：预算依据必须署名来源。
  assert.match(first, /- 预算依据：user（用户 2026-10-14 指令）（§13）/)
  assert.match(first, new RegExp(`- 控制记录：修订 ${state.revision}，最后提交 2023-11-14T22:13:20\\.000Z，业务入场 开放`))
  // §5.1：任务行带有效性、任务书/判据修订与判据检查结果，判据显式 crit_1 ID。
  assert.match(first, /\| tsk_\S+ \| leased \| current \| 5 \| 冒烟任务 \| att_\S+ \| 1 \| 1 \| consistent \| crit_1：脚本断言全部通过 \|/)
  assert.match(first, /- 已完成任务：0 条（按当前完成计）/)
  assert.match(first, /- 轮换 0（每 Actor 每小时上限 3）/)
  assert.match(first, /- 治理开销 0 次 \/ 0 token \/ 0\.00 小时（§22\.15 DG-15）/)
  assert.match(first, /- 未结算预留 0 笔/)
})

test('主台账：Actor 行标出未结算的执行权与休眠态，任务按优先级再按 id 排', () => {
  const state = withClaimedTask().state
  const markdown = renderMissionMarkdown(state)
  // §7.3：休眠与退役是 Actor 行的独立列，不许用"可用"一列混写。
  assert.match(markdown, /\| lead-1 \| lead \| sess-1 \| 1 \| 是（持有 \S+） \| 否 \| 否 \| 0 \|/)
  let current = createdState()
  current = apply(current, { kind: 'task.propose', requestId: req(), task: taskPayload({ title: '低优先', priority: 9 }) })
  const lowId = Object.keys(current.tasks)[0]!
  current = apply(current, { kind: 'task.propose', requestId: req(), task: taskPayload({ title: '高优先', priority: 1 }) })
  const highId = Object.keys(current.tasks).find((id) => id !== lowId)!
  const rows = renderMissionMarkdown(current)
  assert.ok(rows.indexOf(highId) < rows.indexOf(lowId), 'priority 小的排前面')
  assert.equal(rows.match(/\| tsk_/g)?.length, 2)
})

test('表格单元格转义：竖线与换行不许破坏 Markdown 表', () => {
  let current = createdState()
  current = apply(current, { kind: 'task.propose', requestId: req(), task: taskPayload({ title: '管道 | 与换行', criteria: [{ text: '一行\n二行' }] }) })
  const row = renderMissionMarkdown(current).split('\n').find((line) => line.includes('管道'))!
  assert.ok(row.includes('管道 \\| 与换行'), `未转义竖线：${row}`)
  assert.ok(row.includes('crit_1：一行 二行'), `判据换行未折叠成空格：${row}`)
  assert.equal((row.match(/(?<!\\)\|/g) ?? []).length, 11, '十个单元格 → 十一个未转义分隔竖线，转义的那个不计')
})

test('主台账：未决事项把外部操作、outbox 与信箱一起列出来', () => {
  let state = withClaimedTask().state
  const taskId = Object.keys(state.tasks)[0]!
  state = apply(state, { kind: 'operation.intent', requestId: req(), taskId, operationKind: 'shell', target: 'npm test', intent: '跑测试', idempotencyKey: 'k1', retryable: true }, ctx('lead', 'lead-1'))
  state = apply(state, { kind: 'team.message', requestId: req(), toActorId: 'lead-1', messageKind: 'finding', body: '一条发现' }, ctx('lead', 'lead-1'))
  const open = renderMissionMarkdown(state).split('## 未决事项')[1]!.split('## 收口缺口')[0]!
  assert.match(open, /操作 op_\S+（shell → npm test）状态 intent/)
  // §7.3：投递状态与处理状态分列，一条都不许省。
  assert.match(open, /信箱 msg_\S+ lead-1→lead-1（finding）投递=pending 处理=unprocessed/)
  assert.match(open, /outbox obx_\S+（mailbox\.deliver）第 0 次/, '消息目标已绑定会话，就会同时排出一条待投递 outbox')

  const plain = renderMissionMarkdown(withClaimedTask().state).split('## 未决事项')[1]!.split('## 收口缺口')[0]!
  assert.equal(plain.trim(), '（无）', '没有未决事项时显式写"（无）"，不留下空段')

  const committed = renderMissionMarkdown(rotationCommitted()).split('## 未决事项')[1]!.split('## 收口缺口')[0]!
  assert.match(committed, /outbox obx_\S+（rotation\.seed）第 0 次/)
})

test('主台账：收口缺口只认当前判据版本的证明，全绿时明确写"无"', () => {
  // §6.4：缺口判定收敛为"已提交/验收/完成任务的判据在当前版本下没被证明"；
  // 未提交的 leased 任务与 Attempt 结算不再由视图重复判定（后者归 mission.complete / 预算视图）。
  const submitted = toSubmit().state
  const gaps = renderMissionMarkdown(submitted).split('## 收口缺口')[1]!
  assert.match(gaps, /tsk_\S+（submitted）：crit_1：无验证记录/, '已提交但判据没有验证记录，必须点名')
  assert.match(renderMissionMarkdown(withClaimedTask().state), /## 收口缺口\n无：判据按当前版本已证明，承诺闭环，结论有效，交付已处理。/, 'leased 任务还没进入验收链，不算缺口')
  assert.match(renderMissionMarkdown(fullyVerified()), /## 收口缺口\n无：判据按当前版本已证明，承诺闭环，结论有效，交付已处理。/)
})

test('时间线：顶部带视图元数据，空记录显式说明，limit 取最近若干条且保留原 seq', () => {
  const empty = renderTimelineMarkdown(freshState())
  assert.match(empty, /^# 控制事件时间线 Mission mss_test\n/)
  assert.ok(empty.endsWith('（尚无控制事件）'))
  const state = withClaimedTask().state
  const all = renderTimelineMarkdown(state).split('\n')
  assert.ok(all[0]!.startsWith('# 控制事件时间线 Mission mss_test'))
  const body = all.slice(-state.events.length)
  assert.equal(body.length, state.events.length)
  for (const line of body) assert.ok(line.startsWith('- 2023-11-14T22:13:20.000Z #'), `事件行应以时间戳+seq 开头：${line}`)
  assert.match(body.at(-1)!, new RegExp(`^- 2023-11-14T22:13:20\\.000Z #${state.events.at(-1)!.seq} \\w+/\\w+`))
  const recent = renderTimelineMarkdown(state, 2).split('\n')
  assert.deepEqual(recent.slice(-2), all.slice(-2), 'limit 只截尾部两条，前缀元数据照常')
  assert.match(recent.at(-2)!, new RegExp(`^- 2023-11-14T22:13:20\\.000Z #${state.events.at(-2)!.seq} \\w+/\\w+`))
})

/* ------------------------------------------------------------- 归档历史回读（复审 N4） */

/** N4 探针用的最小控制事件：正文标记与 seq 一一对应，便于断言"归档正文是否出现"。 */
function auditEvent(seq: number, kind = 'audit-event'): ControlEvent {
  return { seq, at: NOW, kind, detail: { marker: `archived-marker-${seq}` } }
}

/** 用例直接构造快照（不走 archive.ts 读侧实现），只保留时间线合并所需的字段。 */
function auditSnapshot(events: readonly ControlEvent[], unavailable: readonly string[] = []): ArchiveSnapshot {
  return {
    missionId: 'mss_test',
    batches: [
      {
        batchId: `arc_mss_test_events_${events[0]?.seq ?? 0}-${events.at(-1)?.seq ?? 0}`,
        missionId: 'mss_test',
        kind: 'events',
        fromSeq: events[0]?.seq ?? 0,
        toSeq: events.at(-1)?.seq ?? 0,
        count: events.length,
        committedAt: NOW,
        contentHash: 'a'.repeat(64),
        location: 'storageDomain:continuity/archive/arc_mss_test_events',
      },
    ],
    events,
    records: [],
    archivedThroughSeq: events.at(-1)?.seq ?? -1,
    unavailable,
  }
}

test('时间线（N4 翻转）：热 1 条 + 归档 2 条合并展示，归档正文必须出现', () => {
  const state = freshState({ events: [auditEvent(12)] })
  const markdown = renderTimelineMarkdown(state, 200, auditSnapshot([auditEvent(10), auditEvent(11)]))
  // 复审探针正相反：热窗口非空时旧正文被吞掉；修复后归档正文必须随热正文一起显示。
  assert.ok(markdown.includes('archived-marker-10'), `归档正文未出现：\n${markdown}`)
  assert.ok(markdown.includes('archived-marker-11'))
  assert.ok(markdown.includes('archived-marker-12'))
  assert.ok(markdown.indexOf('archived-marker-10') < markdown.indexOf('archived-marker-11'))
  assert.ok(markdown.indexOf('archived-marker-11') < markdown.indexOf('archived-marker-12'), '合并后按 seq 升序')
})

test('时间线：同一 seq 以热为准只显示一次；limit 截断取最近 N 并给出显示区间', () => {
  const state = freshState({ events: [auditEvent(3), auditEvent(12, 'hot-kind')] })
  const markdown = renderTimelineMarkdown(state, 2, auditSnapshot([auditEvent(1), auditEvent(2), auditEvent(12, 'archive-kind')]))
  const eventLines = markdown.split('\n').filter((line) => /^- \S+ #\d+ \S+/.test(line))
  assert.equal(eventLines.length, 2, `limit=2 只显示两条：\n${markdown}`)
  assert.match(eventLines.join('\n'), /#3 audit-event/)
  assert.match(eventLines.join('\n'), /#12 hot-kind/)
  assert.equal(eventLines.join('\n').includes('archive-kind'), false, '同 seq 的归档副本不显示')
  assert.match(markdown, /显示区间 seq 3–12（更早仍有 2 条未显示）/)
})

test('时间线：unavailable 逐条写进窗口说明，归档完全不可用时不写"还没超过窗口"', () => {
  const state = freshState({ events: [auditEvent(12)] })
  const missing = renderTimelineMarkdown(state, 200, auditSnapshot([auditEvent(10), auditEvent(11)], ['归档事件在 seq 0–9 无副本，这段历史不可回读']))
  assert.match(missing, /不可回读：归档事件在 seq 0–9 无副本，这段历史不可回读/, '缺失范围必须可见')

  const unusable: ArchiveSnapshot = { missionId: 'mss_test', batches: [], events: [], records: [], archivedThroughSeq: -1, unavailable: ['全部事件批次内容校验不过，未采信'] }
  const none = renderTimelineMarkdown(state, 200, unusable)
  assert.match(none, /归档台账 0 批 \/ 0 条事件/)
  assert.match(none, /不可回读：全部事件批次内容校验不过，未采信/)
  assert.equal(none.includes('还没超过窗口'), false)

  const noPlane = renderTimelineMarkdown(state)
  assert.match(noPlane, /本部署没有归档读取面，热窗口外的事件不可回读/)
})

test('JSONL：每行一个实体、含 view_meta 与 actor、按显式键排序、行行可解析', () => {
  const state = fullyVerified()
  const lines = toJsonl(state).split('\n')
  // §22.18：JSONL 第一行是视图元数据；Actor 也是实体集合的一员，外部工具才能重建执行权归属。行名用 `collection`。
  assert.deepEqual(lines.map((line) => JSON.parse(line).collection), ['view_meta', 'mission', 'task', 'attempt', 'actor', 'checkpoint', 'artifact', 'verification'])
  for (const line of lines) {
    const row = JSON.parse(line) as { collection: string; id: string; at: number; data: unknown }
    assert.equal(typeof row.id, 'string')
    assert.equal(row.at, NOW, '本批记录都提交在同一时刻')
  }
  assert.equal(JSON.parse(lines[0]!).data.schemaVersion, state.schemaVersion)
  const rotated = toJsonl(rotationCommitted()).split('\n')
  assert.deepEqual(rotated.map((line) => JSON.parse(line).collection), ['view_meta', 'mission', 'task', 'attempt', 'actor', 'checkpoint', 'rotation', 'outbox'])
})

test('viewBundle：五份可重建视图按 Mission 命名，jsonl 以换行收尾', () => {
  const bundle = viewBundle(withClaimedTask().state)
  assert.deepEqual(Object.keys(bundle).sort(), [
    'discipline-mss_test.md',
    'ledger-mss_test.jsonl',
    'mission-mss_test.md',
    'obligations-mss_test.md',
    'timeline-mss_test.md',
  ])
  assert.ok(bundle['ledger-mss_test.jsonl']!.endsWith('\n'))
  assert.ok(bundle['discipline-mss_test.md']!.includes('承诺（§22.7 DG-07）'))
  assert.ok(bundle['obligations-mss_test.md']!.includes('（无）'), '没有承诺时显式占位，不留空表')
  assert.ok(bundle['timeline-mss_test.md']!.endsWith('（尚无控制事件）') === false)
})

test('冷恢复报告：把"能不能重启"讲成人话，核对动作原样带出', () => {
  assert.equal(renderRecoveryMarkdown([]), '冷恢复：没有需要核对的 Mission。')
  const committedState = rotationCommitted()
  const committed = assess(committedState, NOW)
  const report = renderRecoveryMarkdown([committed])
  assert.match(report, new RegExp(`## Mission mss_test（修订 ${committed.revision}）`))
  assert.match(report, /- 是否自动重启：不允许（需显式恢复）/)
  assert.match(report, /- 业务入场：可开放/)
  assert.match(report, /- 在途外部操作：无/)
  assert.match(report, /- 租约过期的尝试：无/, '§11.1：租约过期项单独成行，恢复时先看谁还能续')
  assert.match(report, /- outbox 积压：1/)
  assert.match(report, /轮换 rot_\S+ 停在 COMMITTED\n- outbox/, '未给核对动作时不编造一句')
  assert.match(report, /- 阻塞：\n  - 1 个轮换未收束/)

  const failed = apply(committedState, { kind: 'continuity.failRotation', requestId: req(), rotationId: Object.keys(committedState.rotations)[0]!, reason: '启动消息未确认', nextReconcileAction: '按 rpcId seed-1 复查' })
  const waiting = assess(failed, NOW)
  assert.match(renderRecoveryMarkdown([waiting]), /停在 WAITING_RECOVERY，核对动作：按 rpcId seed-1 复查/)

  const allowed = assess(freshState({ mission: draftMission({ status: 'active', allowAutoResume: true }) }), NOW)
  assert.match(renderRecoveryMarkdown([allowed]), /- 是否自动重启：允许/)
})
