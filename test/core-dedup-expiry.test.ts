/**
 * 命令去重的两层保留期（设计稿 v0.3 §5.3、§10.4；审阅 R5）。
 *
 * 幂等的前提是"见过这个 requestId"这件事本身活得比重试窗口长。旧实现把到期条目整条删掉，
 * 于是 24 小时后再放一次同样的请求会被当成新工作——审阅复现 `EXPIRED_REQUEST_REPLAY`
 * 里任务数从 2 变 3。下面按反向断言钉住：过期重放只能拿到"结果未知，需先核对台账"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { CommandReceipt, MissionControl } from '../src/core/control.ts'
import {
  DEDUP_RETENTION_MS,
  DEDUP_TOMBSTONE_RETENTION_MS,
  DEDUP_UNKNOWN_NOTE,
  MAX_DEDUP_TOMBSTONES,
  pruneDedupTables,
} from '../src/core/control.ts'
import type { Command } from '../src/core/commands.ts'
import { dispatch } from '../src/core/commands.ts'
import { ctx, freshState, NOW, taskPayload } from './fixtures.ts'

const SUPERVISOR = { actorId: 'supervisor', role: 'supervisor' as const, now: NOW }
const ORIGINAL: Command = { kind: 'task.propose', requestId: 'original', task: taskPayload() }

/** 审阅复现的第 1–3 步：建任务 → 推进 25h → 再来一条命令把去重表剪一遍。 */
function afterInterveningReplay(): { readonly state: MissionControl; readonly tasks: number } {
  const proposed = dispatch(freshState(), ORIGINAL, SUPERVISOR)
  assert.equal(proposed.applied, true)
  const later = { ...SUPERVISOR, now: NOW + 25 * 60 * 60 * 1000 }
  const intervening = dispatch(proposed.state, { ...ORIGINAL, requestId: 'intervening' }, later)
  assert.equal(intervening.applied, true)
  if (!intervening.applied) throw new Error('夹具命令必须推进')
  return { state: intervening.state, tasks: Object.keys(intervening.state.tasks).length }
}

test('R5 回归：过期重放不再重造业务对象，只回"结果未知，需先核对台账"', () => {
  const { state, tasks } = afterInterveningReplay()
  assert.equal(tasks, 2, '前置：中间那条命令确实新建了一个任务')
  assert.equal(state.dedup.original, undefined, '完整凭据已过 24h 保留期')
  assert.ok(state.dedupTombstones?.original, '到期后必须留下墓碑而不是删除')
  const before = Object.keys(state.tasks).length
  const replayed = dispatch(state, ORIGINAL, { ...SUPERVISOR, now: NOW + 26 * 60 * 60 * 1000 })
  assert.equal(replayed.applied, false, '墓碑命中不能算新工作')
  assert.match(replayed.reason, new RegExp(DEDUP_UNKNOWN_NOTE))
  assert.equal(Object.keys(replayed.state.tasks).length, before, '任务数一个都不许多出来')
  assert.equal(replayed.state, state, '非应用结果不许改状态，也不许顺手写新凭据')
})

test('两层保留期分界：24h 内仍按既有结论复用，语义与旧版一致', () => {
  const proposed = dispatch(freshState(), ORIGINAL, SUPERVISOR)
  assert.equal(proposed.applied, true)
  const state = proposed.state
  const within = { ...SUPERVISOR, now: NOW + DEDUP_RETENTION_MS - 1 }
  const replay = dispatch(state, ORIGINAL, within)
  assert.equal(replay.applied, true, '完整凭据未到期时仍按既有结论复用')
  assert.equal(replay.effect, 'dedup-hit')
  assert.equal(Object.keys(replay.state.tasks).length, Object.keys(state.tasks).length)
  const sameKeyOtherCommand = dispatch(state, { ...ORIGINAL, task: taskPayload({ title: '换了语义' }) }, within)
  assert.equal(sameKeyOtherCommand.applied, false)
  assert.match(sameKeyOtherCommand.reason, /already used for a different command/, '同 requestId 换语义仍然拒绝')
})

test('墓碑保留期是定义的：到期起 30 天内保留，超出即清（体积有界）', () => {
  const receipt: CommandReceipt = { requestId: 'r-1', fingerprint: 'aaaaaaaaaaaaaaaa', appliedAt: NOW, outcome: 'applied', revision: 1 }
  const expiredAt = NOW + DEDUP_RETENTION_MS
  const stillHeld = pruneDedupTables({ 'r-1': receipt }, {}, expiredAt + DEDUP_TOMBSTONE_RETENTION_MS)
  assert.ok(stillHeld.tombstones['r-1'], '墓碑刚到期一刻仍保留')
  assert.equal(stillHeld.dedup['r-1'], undefined, '完整凭据这一层已经收敛掉')
  const purged = pruneDedupTables({ 'r-1': receipt }, {}, expiredAt + DEDUP_TOMBSTONE_RETENTION_MS + 1)
  assert.deepEqual(purged.tombstones, {}, '超出墓碑保留期按"台账已被核对"处理，体积不许无限增长')
})

test('墓碑命中不依赖指纹：同键换语义同样回"需核对"，不去猜当年结论', () => {
  const receipt: CommandReceipt = { requestId: 'r-2', fingerprint: 'bbbbbbbbbbbbbbbb', appliedAt: NOW, outcome: 'applied', revision: 4 }
  const pruned = pruneDedupTables({ 'r-2': receipt }, {}, NOW + DEDUP_RETENTION_MS + 1)
  const state = freshState({ dedup: pruned.dedup, dedupTombstones: pruned.tombstones })
  const replayed = dispatch(state, { kind: 'task.propose', requestId: 'r-2', task: taskPayload({ title: '换了语义' }) }, { ...SUPERVISOR, now: NOW + DEDUP_RETENTION_MS + 2 })
  assert.equal(replayed.applied, false)
  if (replayed.applied) throw new Error('墓碑命中必须是非应用结果')
  assert.match(replayed.reason, new RegExp(DEDUP_UNKNOWN_NOTE))
  assert.equal(Object.keys(replayed.state.tasks).length, Object.keys(state.tasks).length)
})

test('既有行为不变：未到期条目仍原样保留并截短指纹', () => {
  const receipt: CommandReceipt = { requestId: 'r-3', fingerprint: 'c'.repeat(64), appliedAt: NOW, outcome: 'rejected', reason: '权限不足', revision: 9 }
  const pruned = pruneDedupTables({ 'r-3': receipt }, {}, NOW + 1000)
  const kept = pruned.dedup['r-3']!
  assert.equal(kept.fingerprint, 'c'.repeat(16))
  assert.equal(kept.reason, '权限不足')
  assert.equal(kept.outcome, 'rejected')
  assert.deepEqual(pruned.tombstones, {})
})

test('墓碑体积闸：一次剪枝也不会留下超过上限的墓碑，被挤出的是最早到期的', () => {
  const dedup: Record<string, CommandReceipt> = {}
  const total = MAX_DEDUP_TOMBSTONES + 64
  for (let index = 0; index < total; index += 1) {
    const key = `req-${index}`
    // 越大的 index 越旧：全部已过完整凭据保留期、但仍在墓碑保留期内。
    dedup[key] = { requestId: key, fingerprint: key.padEnd(16, '0').slice(0, 16), appliedAt: NOW - DEDUP_RETENTION_MS - (index + 1) * 1000, outcome: 'applied', revision: index }
  }
  const pruned = pruneDedupTables(dedup, {}, NOW)
  assert.equal(Object.keys(pruned.dedup).length, 0, '这批完整凭据全部过期')
  assert.equal(Object.keys(pruned.tombstones).length, MAX_DEDUP_TOMBSTONES, '墓碑总量必须封顶')
  assert.ok(pruned.tombstones['req-0'], '最新到期的那条必须还在')
  assert.equal(pruned.tombstones[`req-${total - 1}`], undefined, '最旧的那些先被挤出')
})
