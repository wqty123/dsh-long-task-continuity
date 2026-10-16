/**
 * 审阅 N2 回归：请求去重记录（完整凭据 24h → 墓碑 30d → 淘汰）不能成为
 * "旧请求再次创建业务对象"的窗口。
 *
 * 修复方向（复审报告原文）："把幂等索引外置并按业务对象唯一键核对。不能仅延长保留时间。"
 * 落地方案：创建类命令的对象 ID 由 requestId 确定性派生（`derivedId`），且派生 ID
 * 命中已有对象时直接拒绝该命令——对象身份即幂等索引，去重记录淘汰后依然不重复创建。
 *
 * 对应 `复审_20261015/reproduce.mjs` 的两个探针（此处断言翻转后的期望）：
 * - EXPIRED_TOMBSTONE_REPLAY：墓碑过期（31 天）+ 中途插入其他命令后重放原请求。
 * - TOMBSTONE_CAP_REPLAY：墓碑候选超 2048 条容量闸后清老，再重放原请求。
 *
 * 时间轴注意：dispatch 的去重判定以 `appliedAt` 与"当前 now"之差为准，修剪只在
 * "命令推进了状态"的那次提交里发生；所以要把一条凭据推出去，必须在更晚的时刻
 * 再提交至少两条推进命令（先降为墓碑，再清出墓碑）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { DEDUP_RETENTION_MS, DEDUP_TOMBSTONE_RETENTION_MS, derivedId, MAX_DEDUP_TOMBSTONES } from '../src/core/control.ts'
import type { CommandReceipt } from '../src/core/control.ts'
import { dispatch } from '../src/core/commands.ts'
import type { Command } from '../src/core/commands.ts'
import type { MissionControl } from '../src/core/control.ts'
import { ctx, draftMission, freshState, req, taskPayload } from './fixtures.ts'
import { NOW } from './fixtures.ts'

const DAY = 24 * 60 * 60 * 1000

/** 应用一条命令并要求被接受（探针场景里中途插入的命令都必须是合法转换）。 */
function accept(state: MissionControl, cmd: Command, context = ctx('supervisor')): MissionControl {
  const result = dispatch(state, cmd, context)
  if (!result.applied) throw new Error(`命令 ${cmd.kind} 意外被拒：${result.reason}`)
  return result.state
}

/** 一次推进命令，用来在更晚的时刻触发去重表修剪（solo 协作下只允许 lead/user/supervisor 登记）。 */
function registration(requestId: string, label: string): Command {
  return { kind: 'actor.register', requestId, actorId: `actor-${label}`, role: 'lead', label, sessionId: `sess-${label}` }
}

/**
 * 建一条原任务，并把它的凭据/墓碑全部推出两张表（越过 24h 凭据期与 30 天墓碑期），
 * 返回 [{state, now}, ...] 以支持后续在"当前 now"上继续操作。
 */
function pushOriginalOutOfEveryTable(original: Command) {
  let state = freshState()
  state = accept(state, { kind: 'mission.create', requestId: req(), mission: draftMission() })
  state = accept(state, original)
  // 跨过完整凭据保留期（24h）→ original 的凭据降为墓碑。
  const afterRetention = NOW + DEDUP_RETENTION_MS + 1
  state = accept(state, registration(req(), '旁观1'), { actorId: 'actor-1', role: 'supervisor', now: afterRetention })
  assert.equal(Object.keys(state.dedupTombstones ?? {}).length > 0, true, '前置条件：凭据已降为墓碑')
  // 再跨过墓碑期（30 天）→ 清老。
  const afterTombstone = afterRetention + DEDUP_TOMBSTONE_RETENTION_MS + 1
  state = accept(state, registration(req(), '旁观2'), { actorId: 'actor-1', role: 'supervisor', now: afterTombstone })
  return { state, now: afterTombstone }
}

test('N2 过期淘汰：墓碑清老后重放原请求不重复创建业务对象', () => {
  const original: Command = { kind: 'task.propose', requestId: 'old-original', task: taskPayload() }
  const { state, now } = pushOriginalOutOfEveryTable(original)
  const before = Object.keys(state.tasks).length
  assert.equal(before, 1, '前置条件：原请求确实创建过一条任务')
  assert.equal(state.dedup['old-original'], undefined, '前置条件：完整凭据已过期')
  assert.equal(state.dedupTombstones?.['old-original'], undefined, '前置条件：墓碑已被清出')

  // 修复前：两张表都已清掉，重放被当新请求执行 → applied=true 且任务数变 2。
  // 修复后：派生 ID 已存在于记录 → 命中既有对象，命令按"无进展"被拒。
  const replayed = dispatch(state, original, { actorId: 'actor-1', role: 'supervisor', now })
  assert.equal(replayed.applied, false, '过期淘汰不得让旧请求再次生效')
  assert.equal(Object.keys(replayed.state.tasks).length, before, '不得重复创建业务对象')
  // 同一请求再放一次：第一条拒绝已被记为凭据，这条走 dedup 命中，同样无副作用。
  const again = dispatch(replayed.state, original, { actorId: 'actor-1', role: 'supervisor', now })
  assert.equal(again.applied, false)
  assert.equal(Object.keys(again.state.tasks).length, before)
})

test('N2 容量淘汰：墓碑候选超容量闸清老后重放原请求不重复创建业务对象', () => {
  const original: Command = { kind: 'task.propose', requestId: 'cap-original', task: taskPayload() }
  let state = freshState()
  state = accept(state, { kind: 'mission.create', requestId: req(), mission: draftMission() })
  state = accept(state, original)
  assert.equal(Object.keys(state.tasks).length, 1)

  // 先把 original 真实推入墓碑（与 EXPIRED 用例同一条真路径）。
  const afterRetention = NOW + DEDUP_RETENTION_MS + 1
  state = accept(state, registration(req(), '旁观1'), { actorId: 'actor-1', role: 'supervisor', now: afterRetention })
  assert.notEqual(state.dedupTombstones?.['cap-original'], undefined, '前置条件：original 的凭据已降为墓碑')

  // 容量闸需要 >2048 条候选。用真实命令填 2048 条会先撞上 512KB 记录体积闸
  //（这本身就是内核的保护，见 dispatch 的 controlSize 检查），所以这里按真实
  // `CommandReceipt` 格式直接把候选放进去重表：清老换算仍由真实的 pruneDedupTables 完成。
  const replayAt = afterRetention + DEDUP_RETENTION_MS + 1
  const fillers: Record<string, CommandReceipt> = {}
  for (let i = 0; i < 2048; i += 1) {
    fillers[`filler-${i}`] = { requestId: `filler-${i}`, fingerprint: '0'.repeat(16), appliedAt: afterRetention, outcome: 'applied', revision: 1 }
  }
  state = { ...state, dedup: { ...state.dedup, ...fillers } }
  // 一条真实命令在 replayAt 提交：2048 条填充凭据同时到期压成墓碑 → 候选 2050 条，
  // original 的 expiredAt 最老 → 被容量闸挤掉（fills 的陈旧凭据则全部转墓碑保留）。
  state = accept(state, registration(req(), '探头'), { actorId: 'actor-1', role: 'supervisor', now: replayAt })
  assert.equal(state.dedupTombstones?.['cap-original'], undefined, '前置条件：original 的墓碑已被容量闸清出')
  assert.equal(Object.keys(state.dedupTombstones ?? {}).length, MAX_DEDUP_TOMBSTONES, '墓碑表按上限收敛')

  const before = Object.keys(state.tasks).length
  const replayed = dispatch(state, original, { actorId: 'actor-1', role: 'supervisor', now: replayAt })
  assert.equal(replayed.applied, false, '容量淘汰不得让旧请求再次生效')
  assert.equal(Object.keys(replayed.state.tasks).length, before, '不得重复创建业务对象')
})

test('N2 对照：新意图（新 requestId）在同样时间线后仍获得有效请求键', () => {
  const original: Command = { kind: 'task.propose', requestId: 'old-original', task: taskPayload() }
  const { state, now } = pushOriginalOutOfEveryTable(original)
  const fresh: Command = { kind: 'task.propose', requestId: 'brand-new-intent', task: taskPayload({ title: '新任务' }) }
  const appliedTo = dispatch(state, fresh, { actorId: 'actor-1', role: 'supervisor', now })
  assert.equal(appliedTo.applied, true, '新意图必须能拿到新的有效请求键')
  assert.equal(Object.keys(appliedTo.state.tasks).length, 2)
})

test('N2 换载荷不换键：同一 requestId 在淘汰后带不同载荷 => 拒绝且不覆盖既有对象', () => {
  const original: Command = { kind: 'task.propose', requestId: 'same-key', task: taskPayload() }
  const { state, now } = pushOriginalOutOfEveryTable(original)
  const [taskId] = Object.keys(state.tasks)
  const titleBefore = state.tasks[taskId!]!.title

  const different: Command = {
    kind: 'task.propose',
    requestId: 'same-key',
    task: taskPayload({ title: '被换过的标题', scope: '别的范围' }),
  }
  const result = dispatch(state, different, { actorId: 'actor-1', role: 'supervisor', now })
  assert.equal(result.applied, false, '同键不同载荷必须被拒，防止静默改语义')
  assert.equal(Object.keys(result.state.tasks).length, 1)
  assert.equal(result.state.tasks[taskId!]!.title, titleBefore, '既有对象不得被覆盖')
})

test('N2 派生确定性：同 requestId 同前缀 => 同 ID；不同 requestId / 前缀 / 判别位 => 不同 ID', () => {
  assert.equal(derivedId('tsk', 'req-1'), derivedId('tsk', 'req-1'))
  assert.equal(derivedId('tsk', 'req-1', 'ref:0'), derivedId('tsk', 'req-1', 'ref:0'))
  assert.notEqual(derivedId('tsk', 'req-1'), derivedId('tsk', 'req-2'))
  assert.notEqual(derivedId('tsk', 'req-1'), derivedId('msg', 'req-1'))
  assert.notEqual(derivedId('tsk', 'req-1'), derivedId('tsk', 'req-1', 'a'))
  // 连字符分段：整串里不能出现 32+ 位裸十六进制，否则会被脱敏器当成凭证（HEX_BLOB）。
  assert.match(derivedId('tsk', 'req-1'), /^tsk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

test('N2 覆盖面抽查：team.message 的对象身份派生，且淘汰后重放不产生第二条消息', () => {
  let state = freshState()
  state = accept(state, { kind: 'mission.create', requestId: req(), mission: draftMission() })
  state = accept(state, { kind: 'actor.register', requestId: req(), actorId: 'lead-1', role: 'lead', label: 'Lead', sessionId: 'sess-1' })
  const msgCmd: Command = {
    kind: 'team.message',
    requestId: 'msg-key',
    toActorId: 'lead-1',
    messageKind: 'finding',
    body: '第一条发现',
  }
  state = accept(state, msgCmd)
  const expectMsgId = derivedId('msg', 'msg-key')
  assert.equal(state.mailbox[expectMsgId]?.body, '第一条发现', '消息身份必须由 requestId 派生')

  // 凭据期内重放：dedup 命中既有结论，不产生第二条消息。
  const withinRetention = dispatch(state, msgCmd, { actorId: 'actor-1', role: 'supervisor', now: NOW + DEDUP_RETENTION_MS + 1 })
  assert.ok(withinRetention.applied)
  assert.equal(withinRetention.effect, 'dedup-hit')
  assert.equal(Object.keys(withinRetention.state.mailbox).length, 1)

  // 把凭据/墓碑都推出去后重放：转换侧的派生 ID 重合必须挡住第二次创建。
  const afterRetention = NOW + DEDUP_RETENTION_MS + 1
  state = accept(state, registration(req(), '旁观1'), { actorId: 'actor-1', role: 'supervisor', now: afterRetention })
  const afterTombstone = afterRetention + DEDUP_TOMBSTONE_RETENTION_MS + 1
  state = accept(state, registration(req(), '旁观2'), { actorId: 'actor-1', role: 'supervisor', now: afterTombstone })
  assert.equal(state.dedup['msg-key'], undefined)
  assert.equal(state.dedupTombstones?.['msg-key'], undefined)
  const evictedReplay = dispatch(state, msgCmd, { actorId: 'actor-1', role: 'supervisor', now: afterTombstone })
  assert.equal(evictedReplay.applied, false, '淘汰后重放不得再发一条消息')
  assert.equal(Object.keys(evictedReplay.state.mailbox).length, 1)
})

test('N2 覆盖面抽查：evidence.record 的对象身份同样由 requestId 派生', () => {
  let state = freshState()
  state = accept(state, { kind: 'mission.create', requestId: req(), mission: draftMission() })
  const evdCmd: Command = {
    kind: 'evidence.record',
    requestId: 'evd-key',
    evidence: { kind: 'observation', summary: '观察到 X', sourceRef: 'src/a.ts', observedAt: NOW },
  }
  state = accept(state, evdCmd)
  assert.deepEqual(Object.keys(state.evidence), [derivedId('evd', 'evd-key')])
})
