/**
 * 内核转换与权限（设计稿 v0.3 §5.3、§6、§14）。
 *
 * 这三条是"第二个月还能相信这份台账"的地基：修订号只由真实转换推进、
 * 同一 requestId 不产生第二次副作用、身份表把越权命令挡在写盘之前。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { dispatch } from '../src/core/commands.ts'
import type { CommandContext } from '../src/core/commands.ts'
import { MAX_CONTROL_BYTES } from '../src/core/control.ts'
import { checkpointPayload, ctx, draftMission, freshState, req, taskPayload, withClaimedTask } from './fixtures.ts'

test('成功的转换把修订号推进一格并留下事件', () => {
  const state = freshState()
  const result = dispatch(state, { kind: 'mission.create', requestId: req(), mission: draftMission() }, ctx('supervisor'))
  assert.equal(result.applied, true)
  if (!result.applied) return
  assert.equal(result.state.revision, state.revision + 1)
  assert.equal(result.state.mission.status, 'active')
  assert.equal(result.state.admissionClosed, false, '激活即开放业务入场')
  assert.equal(result.state.events.at(-1)?.kind, 'mission/activated')
})

test('原样退回的转换不算进度：修订号不动、判为未提交', () => {
  let state = freshState()
  const first = dispatch(state, { kind: 'mission.create', requestId: 'mc-1', mission: draftMission() }, ctx('supervisor'))
  assert.equal(first.applied, true)
  if (!first.applied) return
  state = first.state
  const again = dispatch(state, { kind: 'mission.create', requestId: 'mc-2', mission: draftMission() }, ctx('supervisor'))
  assert.equal(again.applied, false)
  if (again.applied) return
  assert.equal(again.reason, 'transition rejected')
  assert.equal(again.state.revision, state.revision, '重复激活不该推进修订')
})

test('同一 requestId 重放不产生第二次副作用，换语义复用则拒绝', () => {
  const state = freshState()
  const cmd = { kind: 'mission.create', requestId: 'same-id', mission: draftMission() } as const
  const first = dispatch(state, cmd, ctx('supervisor'))
  assert.equal(first.applied, true)
  if (!first.applied) return
  const replay = dispatch(first.state, cmd, ctx('supervisor'))
  assert.equal(replay.applied, true)
  if (!replay.applied) return
  assert.equal(replay.effect, 'dedup-hit')
  assert.equal(replay.state.revision, first.state.revision, '重放不能再涨修订')

  const hijack = dispatch(first.state, { kind: 'mission.pause', requestId: 'same-id', reason: '换一个语义复用同一 ID' }, ctx('supervisor'))
  assert.equal(hijack.applied, false)
  if (hijack.applied) return
  assert.match(hijack.reason, /already used/)
})

test('准入关闭时普通 worker 被挡，只读与收拾状态的动作仍可执行', () => {
  const closed = freshState({ admissionClosed: true })
  const blocked = dispatch(closed, { kind: 'task.propose', requestId: req(), task: taskPayload() }, ctx('member', 'member-1'))
  assert.equal(blocked.applied, false)
  if (blocked.applied) return
  assert.match(blocked.reason, /admission closed/)

  const allowed = dispatch(closed, { kind: 'mission.pause', requestId: req(), reason: '核对未完成' }, ctx('supervisor'))
  assert.equal(allowed.applied, true, 'supervisor 是运行时驱动身份，不受业务准入限制')
})

test('角色表把越权命令挡在写盘之前', () => {
  const { state } = withClaimedTask()
  const cases: readonly { readonly role: 'lead' | 'member' | 'subagent' | 'reviewer'; readonly cmd: Parameters<typeof dispatch>[1]; readonly why: string }[] = [
    // §6.4：v0.3 里 task.verify 进了 Lead 权限表——签字独立性改由 review.record 的 notIndependent 判定，
    // 越权示例换成"Lead 只能提议收口，确认结构条件要 Supervisor/用户"。
    { role: 'lead', cmd: { kind: 'mission.complete', requestId: req() }, why: 'Lead 不能自己给自己收口' },
    { role: 'member', cmd: { kind: 'mission.revise', requestId: req(), objective: '改目标' }, why: '成员不能重写约束' },
    { role: 'subagent', cmd: { kind: 'task.claim', requestId: req(), taskId: 'x' }, why: '子代理不能给自己派单' },
    { role: 'reviewer', cmd: { kind: 'task.checkpoint', requestId: req(), taskId: 'x', checkpoint: checkpointPayload() }, why: '审查者不写执行进度' },
  ]
  for (const item of cases) {
    const result = dispatch(state, item.cmd, ctx(item.role, `${item.role}-1`))
    assert.equal(result.applied, false, item.why)
    if (result.applied) continue
    assert.match(result.reason, /not allowed to issue/)
  }
})

test('solo 模式只允许 lead/user/supervisor 三种 Actor', () => {
  const state = freshState()
  const activated = dispatch(state, { kind: 'mission.create', requestId: req(), mission: draftMission() }, ctx('supervisor'))
  assert.equal(activated.applied, true)
  if (!activated.applied) return
  const member = dispatch(activated.state, { kind: 'actor.register', requestId: req(), actorId: 'm-1', role: 'member', label: '成员' }, ctx('supervisor'))
  assert.equal(member.applied, false, 'solo 下注册 member 应被拒')
  const lead = dispatch(activated.state, { kind: 'actor.register', requestId: req(), actorId: 'l-1', role: 'lead', label: 'Lead', sessionId: 'sess-1' }, ctx('supervisor'))
  assert.equal(lead.applied, true)
  if (lead.applied) assert.equal(lead.state.mission.leadActorId, 'l-1', '第一个 Lead 写进 Mission')
})

test('一个会话同一时刻只能承载一个未退役 Actor', () => {
  let state = freshState()
  state = dispatch(state, { kind: 'mission.create', requestId: req(), mission: draftMission() }, ctx('supervisor')).state ?? state
  const first = dispatch(state, { kind: 'actor.register', requestId: req(), actorId: 'a-1', role: 'lead', label: 'Lead', sessionId: 'sess-1' }, ctx('supervisor'))
  assert.equal(first.applied, true)
  if (!first.applied) return
  state = first.state
  const clash = dispatch(state, { kind: 'actor.register', requestId: req(), actorId: 'a-2', role: 'user', label: '用户', sessionId: 'sess-1' }, ctx('supervisor'))
  assert.equal(clash.applied, false, '身份映射唯一，否则工具调用属于谁判不出来')
})

test('检查点挂在 Attempt 上，submit 才认它作依据', () => {
  const { state, taskId, attemptId } = withClaimedTask()
  const attempt = state.attempts[attemptId]
  assert.equal(attempt?.checkpointId, undefined)

  const withoutCheckpoint = dispatch(state, { kind: 'task.submit', requestId: req(), taskId, leaseVersion: attempt!.leaseVersion }, ctx('lead', 'lead-1'))
  assert.equal(withoutCheckpoint.applied, false, '没有检查点的提交就是让模型自报完成')

  const written = dispatch(state, { kind: 'task.checkpoint', requestId: req(), taskId, checkpoint: checkpointPayload() }, ctx('lead', 'lead-1'))
  assert.equal(written.applied, true)
  if (!written.applied) return
  const checkpointId = written.state.tasks[taskId]?.currentAttemptId
  assert.equal(written.state.attempts[checkpointId!]?.checkpointId !== undefined, true, 'Attempt 必须指回自己的检查点')

  const submitted = dispatch(written.state, { kind: 'task.submit', requestId: req(), taskId, leaseVersion: attempt!.leaseVersion }, ctx('lead', 'lead-1'))
  assert.equal(submitted.applied, true)
  if (submitted.applied) assert.equal(submitted.state.tasks[taskId]?.status, 'submitted')
})

test('租约版本不匹配的提交只留待审证据，不改任务状态', () => {
  const { state, taskId, attemptId } = withClaimedTask()
  const written = dispatch(state, { kind: 'task.checkpoint', requestId: req(), taskId, checkpoint: checkpointPayload() }, ctx('lead', 'lead-1'))
  assert.equal(written.applied, true)
  if (!written.applied) return
  const stale = dispatch(written.state, { kind: 'task.submit', requestId: req(), taskId, leaseVersion: 99 }, ctx('lead', 'lead-1'))
  assert.equal(stale.applied, true, '迟到结果要能被记下来，否则旧执行者的输出无处可查')
  if (stale.applied) {
    assert.equal(stale.state.tasks[taskId]?.status, 'running', '迟到的提交不能把任务推成 submitted')
    assert.equal(stale.state.attempts[attemptId]?.status, 'running', '更不能收束还在跑的 Attempt')
    assert.equal(stale.state.events.at(-1)?.kind, 'attempt/late-result')
  }
})

test('租约过期后提交被拒：过期只触发核对，不证明旧进程已停', () => {
  const { state, taskId } = withClaimedTask()
  const written = dispatch(state, { kind: 'task.checkpoint', requestId: req(), taskId, checkpoint: checkpointPayload() }, ctx('lead', 'lead-1'))
  assert.equal(written.applied, true)
  if (!written.applied) return
  const attempt = written.state.attempts[written.state.tasks[taskId]!.currentAttemptId!]!
  const expiredCtx: CommandContext = { actorId: 'lead-1', role: 'lead', now: attempt.leaseExpiresAt + 1 }
  const late = dispatch(written.state, { kind: 'task.submit', requestId: req(), taskId, leaseVersion: attempt.leaseVersion }, expiredCtx)
  assert.equal(late.applied, false, '过期租约的写入一律挡下，等外部核对')
  if (late.applied) return
  assert.equal(late.reason, 'transition rejected')
})

test('验收必须有证据引用，pass 之后 Attempt 收束', () => {
  const { state, taskId } = withClaimedTask()
  let current = dispatch(state, { kind: 'task.checkpoint', requestId: req(), taskId, checkpoint: checkpointPayload() }, ctx('lead', 'lead-1')).state ?? state
  current = dispatch(current, { kind: 'task.submit', requestId: req(), taskId, leaseVersion: 1 }, ctx('lead', 'lead-1')).state ?? current
  const verified = dispatch(current, { kind: 'task.verify', requestId: req(), taskId, criterionId: 'crit_1', outcome: 'pass', method: 'node --test', methodVersion: '1', evidenceRefs: ['test/core-commands.test.ts'] }, ctx('user', 'human'))
  assert.equal(verified.applied, true)
  if (!verified.applied) return
  assert.equal(verified.state.tasks[taskId]?.status, 'completed')
  const attemptId = Object.keys(verified.state.attempts)[0]!
  assert.equal(verified.state.attempts[attemptId]?.status, 'settled')
  assert.equal(Object.values(verified.state.verifications).length, 1)
})

test('目标修订使未完成任务退回 planned 并作废在跑 Attempt', () => {
  const { state, taskId } = withClaimedTask()
  const revised = dispatch(state, { kind: 'mission.revise', requestId: req(), objective: '换成只做只读核对' }, ctx('user', 'human'))
  assert.equal(revised.applied, true)
  if (!revised.applied) return
  assert.equal(revised.state.mission.objectiveRevision, 2)
  assert.equal(revised.state.tasks[taskId]?.status, 'planned')
  const attemptId = Object.keys(revised.state.attempts)[0]!
  assert.equal(revised.state.attempts[attemptId]?.status, 'cancelled')
})

test('轮换阶段只能按合法顺序推进，COMMITTED 一次写完成换绑与启动条目', () => {
  let state = freshState()
  state = dispatch(state, { kind: 'mission.create', requestId: req(), mission: draftMission() }, ctx('supervisor')).state ?? state
  state = dispatch(state, { kind: 'actor.register', requestId: req(), actorId: 'lead-1', role: 'lead', label: 'Lead', sessionId: 'sess-1' }, ctx('supervisor')).state ?? state
  state = dispatch(state, { kind: 'continuity.checkpoint', requestId: req(), checkpoint: { actorId: 'lead-1', ...checkpointPayload() } }, ctx('lead', 'lead-1')).state ?? state
  const checkpointId = state.checkpointOrder[0]!

  const requested = dispatch(state, { kind: 'continuity.requestRotation', requestId: req(), actorId: 'lead-1', sourceSessionId: 'sess-1', targetSessionId: 'sess-2', checkpointId, trigger: 'manual', seedMessageId: 'seed:sess-2' }, ctx('supervisor'))
  assert.equal(requested.applied, true)
  if (!requested.applied) return
  const rotationId = requested.state.rotations[Object.keys(requested.state.rotations)[0]!]!.rotationId

  const skipped = dispatch(requested.state, { kind: 'continuity.advanceRotation', requestId: req(), rotationId, phase: 'COMMITTED' }, ctx('supervisor'))
  assert.equal(skipped.applied, false, 'REQUESTED 不能直接跳 COMMITTED')

  let current = requested.state
  for (const phase of ['QUIESCING', 'PREPARED', 'TARGET_READY'] as const) {
    const next = dispatch(current, { kind: 'continuity.advanceRotation', requestId: `adv-${phase}`, rotationId, phase }, ctx('supervisor'))
    assert.equal(next.applied, true, phase)
    if (next.applied) current = next.state
  }
  const committed = dispatch(current, { kind: 'continuity.advanceRotation', requestId: req(), rotationId, phase: 'COMMITTED' }, ctx('supervisor'))
  assert.equal(committed.applied, true)
  if (!committed.applied) return
  assert.equal(committed.state.actors['lead-1']?.sessionId, 'sess-2', '提交点换绑到新会话')
  assert.equal(committed.state.actors['lead-1']?.bindingVersion, 2)
  const entries = Object.values(committed.state.outbox).filter((entry) => entry.kind === 'rotation.seed')
  assert.equal(entries.length, 1, '启动消息与换绑在同一次更新里入队')
  assert.equal(entries[0]?.payload.sessionId, 'sess-2')
})

test('提交点之后失败停在 WAITING_RECOVERY，不自动退回源会话', () => {
  const state = freshState()
  const rotation = {
    rotationId: 'rot-1',
    missionId: 'mss_test',
    actorId: 'lead-1',
    sourceSessionId: 'sess-1',
    targetSessionId: 'sess-2',
    targetMessageId: 'seed:sess-2',
    phase: 'ACTIVATING' as const,
    bindingVersionBefore: 1,
    bindingVersionAfter: 2,
    checkpointId: 'ckp-1',
    trigger: 'manual' as const,
    // §23.2 第 1 条：轮换请求当场冻结依据/规则版本，恢复后按这两个数重验交接包。
    basisRevisionAtRequest: 0,
    policyRevisionAtRequest: 1,
    phases: ['REQUESTED', 'QUIESCING', 'PREPARED', 'TARGET_READY', 'COMMITTED', 'ACTIVATING'] as const,
    startedAt: NOW_OF(),
    updatedAt: NOW_OF(),
  }
  const withRotation = { ...state, rotations: { 'rot-1': rotation }, actors: { 'lead-1': { ...leadActor(), sessionId: 'sess-2' } } }
  const failed = dispatch(withRotation, { kind: 'continuity.failRotation', requestId: req(), rotationId: 'rot-1', reason: '启动消息未确认', nextReconcileAction: '按 rpcId 复查' }, ctx('supervisor'))
  assert.equal(failed.applied, true)
  if (!failed.applied) return
  assert.equal(failed.state.rotations['rot-1']?.phase, 'WAITING_RECOVERY')
  assert.equal(failed.state.rotations['rot-1']?.failurePhase, 'ACTIVATING')
  assert.equal(failed.state.actors['lead-1']?.sessionId, 'sess-2', '执行权仍归 S2，不悄悄退回')

  const kept = dispatch(failed.state, { kind: 'continuity.resolveUnknown', requestId: req(), rotationId: 'rot-1', decision: 'keep_source' }, ctx('supervisor'))
  assert.equal(kept.applied, true)
  if (kept.applied) assert.equal(kept.state.actors['lead-1']?.sessionId, 'sess-1', '回退必须是显式决定并再次递增版本')
})

test('控制记录超出体积上限时拒绝新增工作，而不是删掉恢复所需信息', () => {
  const state = freshState()
  const fat = { ...state, events: [{ seq: 0, at: NOW_OF(), kind: 'pad', detail: { blob: 'x'.repeat(MAX_CONTROL_BYTES) } }] }
  const result = dispatch(fat, { kind: 'task.propose', requestId: req(), task: taskPayload() }, ctx('lead', 'lead-1'))
  assert.equal(result.applied, false)
  if (result.applied) return
  assert.match(result.reason, /exceed/)
})

function NOW_OF(): number {
  return 1_700_000_000_000
}

function leadActor() {
  return {
    actorId: 'lead-1',
    missionId: 'mss_test',
    role: 'lead' as const,
    label: 'Lead',
    sessionId: 'sess-1',
    bindingVersion: 1,
    available: true,
    dormant: false,
    retired: false,
    rotationsLastHour: [],
    createdAt: NOW_OF(),
    updatedAt: NOW_OF(),
  }
}
