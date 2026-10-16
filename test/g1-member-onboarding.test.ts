/**
 * G1 成员入台账：原生成员出生 → 自动 `actor.register`（本轮补的缺口）。
 *
 * 两条判据：
 * 1. `teamMemberOf` 按不可信输入收窄，形状不全就不认（未知 ≠ 可以登记）；
 * 2. 内核里那对命令**本来是死锁的**——`actor.register` 在 solo 时拒绝非单人角色
 *    （`src/core/commands.ts:1381`），而 `team.configure` 只接受已在 `actors` 里的成员、
 *    成员为空整体拒绝（`:1441-1442`）。本用例把死锁钉住，再证明"先拿 Lead 组队、再登记成员"
 *    这条路径能走通——这正是 `src/index.ts` 的 `onTeamMemberEvent` 实现的三步顺序。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { teamMemberOf } from '../src/adapter/agent-teams.ts'
import { dispatch } from '../src/core/commands.ts'
import { freshState, NOW } from './fixtures.ts'

const supervisor = { actorId: 'supervisor', role: 'supervisor' as const, now: NOW }

test('G1 teamMemberOf：只认形状完整的 team/member，字段不全一律不认', () => {
  const good = { type: 'team/member', data: { version: 2, teamId: 'sess-root', member: { id: 'sess-m1', name: 'researcher', phase: 'active' } } }
  assert.deepEqual(teamMemberOf(good), { teamId: 'sess-root', member: { id: 'sess-m1', name: 'researcher', phase: 'active' } })

  assert.equal(teamMemberOf(null), undefined)
  assert.equal(teamMemberOf({ type: 'team/task', data: good.data }), undefined, '别的类型不认')
  assert.equal(teamMemberOf({ type: 'team/member' }), undefined, '没有 data 不认')
  assert.equal(teamMemberOf({ type: 'team/member', data: { version: 2, member: { id: 's', name: 'n', phase: 'active' } } }), undefined, '缺 teamId 不认')
  assert.equal(teamMemberOf({ type: 'team/member', data: { version: 2, teamId: 't', member: { name: 'n', phase: 'active' } } }), undefined, '缺会话身份不认（绑不上 Actor）')
  assert.equal(teamMemberOf({ type: 'team/member', data: { version: 2, teamId: 't', member: { id: 's', name: '', phase: 'active' } } }), undefined, '空名不认')
  assert.equal(teamMemberOf({ type: 'team/member', data: { version: 2, teamId: 't', member: { id: 's', name: 'n', phase: 'zombie' } } }), undefined, '词表外的 phase 不认')
})

test('G1 成员入台账：solo 时直接登记会被拒，先组队再登记才走得通（内核里那对命令的死锁）', () => {
  // 基线：Mission 是 solo，Lead 已登记（等同于 /continuity open 之后的现场）。
  const opened = dispatch(freshState(), {
    kind: 'actor.register', requestId: 'r-lead', actorId: 'lead-1', role: 'lead', label: 'lead', sessionId: 'sess-lead',
  }, supervisor)
  assert.equal(opened.applied, true)
  assert.equal(opened.state.mission.collaboration, 'solo')

  // 死锁的另一半：solo 下成员登记必须被拒 —— 这就是"两步人工操作"的由来。
  const direct = dispatch(opened.state, {
    kind: 'actor.register', requestId: 'r-direct', actorId: 'member-a', role: 'member', label: 'a', sessionId: 'sess-a',
  }, supervisor)
  assert.equal(direct.applied, false, 'solo 时不允许直接登记成员（commands.ts:1381）')

  // 死锁的这一半：成员为空时 team.configure 也拒绝（commands.ts:1442）。
  const empty = dispatch(opened.state, {
    kind: 'team.configure', requestId: 'r-empty', teamId: 'sess-lead', memberActorIds: [], concurrencyLimit: 2,
  }, supervisor)
  assert.equal(empty.applied, false, '没有成员可归队时整体拒绝（commands.ts:1442）')

  // 解法第一步：用**已在 actors 里**的 Lead 自己把协作模式推上去。
  const configured = dispatch(opened.state, {
    kind: 'team.configure', requestId: 'r-team', teamId: 'sess-lead', memberActorIds: ['lead-1'], concurrencyLimit: 2,
  }, supervisor)
  assert.equal(configured.applied, true)
  assert.equal(configured.state.mission.collaboration, 'team', '有第二个活体会话就是 team，由事实推动模式')

  // 解法第二步：现在成员登记通过，身份落到会话上。
  const registered = dispatch(configured.state, {
    kind: 'actor.register', requestId: 'r-reg', actorId: 'member-a', role: 'member', label: 'a', sessionId: 'sess-a',
  }, supervisor)
  assert.equal(registered.applied, true)
  assert.equal(registered.state.actors['member-a']?.sessionId, 'sess-a')

  // 判据：成员会话从此查得到 Actor —— 这正是 src/adapter/tools.ts 的 identity() 的查法，
  // 也是它不再返回 no-bound-actor 的唯一前提。
  const bound = Object.values(registered.state.actors).find((actor) => !actor.retired && actor.sessionId === 'sess-a')
  assert.ok(bound, '成员会话已绑定 Actor')
  assert.equal(bound.role, 'member')

  // 解法第三步：把成员纳入队伍（并发与讨论配额按队伍算）。
  const joined = dispatch(registered.state, {
    kind: 'team.configure', requestId: 'r-join', teamId: 'sess-lead', memberActorIds: ['member-a'], concurrencyLimit: 2,
  }, supervisor)
  assert.equal(joined.applied, true)
  assert.deepEqual([...joined.state.teams['sess-lead']!.memberActorIds].sort(), ['lead-1', 'member-a'], '成员是追加进队伍的，不覆盖已有成员')

  // 一个会话同一时刻只绑一个未退役 Actor（§3.3）：再拿同一会话登记另一个身份必须被拒。
  const clash = dispatch(joined.state, {
    kind: 'actor.register', requestId: 'r-clash', actorId: 'member-b', role: 'member', label: 'b', sessionId: 'sess-a',
  }, supervisor)
  assert.equal(clash.applied, false, '同一会话不能挂两个未退役身份')
})
