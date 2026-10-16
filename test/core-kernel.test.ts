/**
 * Supervisor 内核与写链（设计稿 v0.2 §2、§5.2）。
 *
 * 内核是整套东西里唯一必须确定的部分：同键串行、乐观版本核对、失败不假装成功。
 * 这里用可注入的时钟与故障注入存储把三条路径钉住——并发提交、存储报错、outbox 退避。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { OutboxEntry } from '../src/core/entities.ts'
import type { MissionControl } from '../src/core/control.ts'
import type { Command, CommandContext } from '../src/core/commands.ts'
import { draftMission, freshState, req, taskPayload, withClaimedTask } from './fixtures.ts'
import type { ControlStore } from '../src/core/store.ts'
import { MemoryStore, RevisionConflict } from '../src/core/store.ts'
import { CommandQueue, decideTakeover } from '../src/core/queue.ts'
import type { LockRecord } from '../src/core/queue.ts'
import { ContinuityKernel } from '../src/core/kernel.ts'

const SUPERVISOR: CommandContext = { actorId: 'supervisor', role: 'supervisor', now: NOW_OF() }

/** 夹具里的 NOW 与内核时钟都取同一个常量，退避计算才可比。 */
function NOW_OF(): number {
  return 1_700_000_000_000
}

/** 单条 outbox 意图，用于把 drain 路径与真实轮换解耦。 */
function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    outboxId: 'obx_1',
    missionId: 'mss_test',
    kind: 'mailbox.deliver',
    payload: { messageId: 'msg_1', sessionId: 'sess-1', body: '正文' },
    idempotencyKey: 'msg_1',
    attempts: 0,
    availableAt: NOW_OF(),
    ...overrides,
  }
}

function stateWith(entries: readonly OutboxEntry[]): MissionControl {
  return { ...freshState(), outbox: Object.fromEntries(entries.map((item) => [item.outboxId, item])) }
}

/**
 * 故障注入存储：`armConflicts(n)` 让接下来 n 次提交先由"并发写入者"占掉槽位再抛版本冲突；
 * `armCommitError(msg)` 让此后每次提交都抛非版本错误（磁盘级故障）。
 */
class RacyStore implements ControlStore {
  private readonly inner: ControlStore
  private conflicts = 0
  private commitError?: string

  constructor(inner: ControlStore) {
    this.inner = inner
  }

  armConflicts(count: number): void {
    this.conflicts = count
  }

  armCommitError(message?: string): void {
    this.commitError = message
  }

  load(missionId: string): Promise<MissionControl | null> {
    return this.inner.load(missionId)
  }

  create(missionId: string, initial: MissionControl): Promise<void> {
    return this.inner.create(missionId, initial)
  }

  list(): Promise<string[]> {
    return this.inner.list()
  }

  async commit(missionId: string, expectedRevision: number, next: MissionControl): Promise<void> {
    if (this.commitError !== undefined) throw new Error(this.commitError)
    if (this.conflicts > 0) {
      this.conflicts -= 1
      const current = await this.inner.load(missionId)
      if (current === null) throw new Error(`mission ${missionId} 记录缺失`)
      const intruder: MissionControl = {
        ...current,
        revision: current.revision + 1,
        events: [...current.events, { seq: (current.events.at(-1)?.seq ?? -1) + 1, at: current.lastCommittedAt, kind: 'test/concurrent-commit', detail: {} }],
      }
      await this.inner.commit(missionId, expectedRevision, intruder)
      throw new RevisionConflict(missionId, expectedRevision, intruder.revision)
    }
    await this.inner.commit(missionId, expectedRevision, next)
  }
}

interface Rig {
  readonly kernel: ContinuityKernel
  readonly memory: MemoryStore
  readonly queue: CommandQueue
  readonly clock: { now: number }
  readonly store: RacyStore
}

function rig(options: { readonly state?: MissionControl } = {}): Rig {
  const clock = { now: NOW_OF() }
  const memory = new MemoryStore()
  if (options.state !== undefined) void memory.create('mss_test', options.state)
  const store = new RacyStore(memory)
  const queue = new CommandQueue()
  return { kernel: new ContinuityKernel(store, queue, { now: () => clock.now }), memory, queue, clock, store }
}

/** 建 Mission 并激活：`open()` 只落草稿记录，激活仍是一条命令。 */
async function activate(kernel: ContinuityKernel): Promise<void> {
  await kernel.open(draftMission())
  const result = await kernel.submit('mss_test', { kind: 'mission.create', requestId: req('open'), mission: draftMission() }, SUPERVISOR)
  if (!result.applied) throw new Error(`夹具激活被拒：${result.reason}`)
}

test('open 幂等：同一 Mission 第二次打开返回既有记录', async () => {
  const { kernel, memory } = rig()
  const first = await kernel.open(draftMission())
  assert.equal(first.revision, 0)
  assert.equal(first.admissionClosed, true, '冷启动默认扣住业务入场')
  const again = await kernel.open(draftMission())
  assert.equal(again.revision, 0, '重复打开没有产生第二次写入')
  await assert.rejects(() => memory.create('mss_test', first), /already exists/)
})

test('submit 落盘，重放同一 requestId 返回既有结论不再涨修订', async () => {
  const { kernel, memory } = rig()
  await activate(kernel)
  const cmd: Command = { kind: 'task.propose', requestId: 'tp-1', task: taskPayload() }
  const first = await kernel.submit('mss_test', cmd, SUPERVISOR)
  assert.equal(first.applied, true)
  assert.equal(memory.peek('mss_test')?.revision, 2, '激活 + 派单各推进一格')
  assert.equal(Object.keys(memory.peek('mss_test')?.tasks ?? {}).length, 1)

  const replay = await kernel.submit('mss_test', cmd, SUPERVISOR)
  assert.equal(replay.applied, true)
  if (!replay.applied) return
  assert.equal(replay.effect, 'dedup-hit')
  assert.equal(memory.peek('mss_test')?.revision, 2, '重放不产生第二次副作用')
})

test('未打开的 Mission：submit 如实报告读不到记录', async () => {
  const { kernel } = rig()
  const result = await kernel.submit('mss_missing', { kind: 'mission.pause', requestId: req(), reason: '停' }, SUPERVISOR)
  assert.equal(result.applied, false)
  if (result.applied) return
  assert.match(result.reason, /is not open/)
  assert.equal(result.state, null)
})

test('版本冲突后重读重放：并发写入者占槽不丢我们的命令', async () => {
  const { kernel, memory, store } = rig()
  await activate(kernel)
  store.armConflicts(1)
  const result = await kernel.submit('mss_test', { kind: 'mission.pause', requestId: req('pause'), reason: '外部要求暂停' }, SUPERVISOR)
  assert.equal(result.applied, true, '一次冲突应当自愈，而不是把命令丢掉')
  const persisted = memory.peek('mss_test')
  assert.equal(persisted?.mission.status, 'paused')
  assert.equal(persisted?.events.filter((event) => event.kind === 'test/concurrent-commit').length, 1, '并发那一笔也留在同一份记录里')
  assert.equal(persisted?.events.filter((event) => event.kind === 'mission/paused').length, 1)
})

test('冲突用尽后停止重试并报告；非版本错误一次即止', async () => {
  const racing = rig()
  await activate(racing.kernel)
  racing.store.armConflicts(9)
  const abandoned = await racing.kernel.submit('mss_test', { kind: 'mission.pause', requestId: req(), reason: '一直冲突' }, SUPERVISOR)
  assert.equal(abandoned.applied, false)
  if (abandoned.applied) return
  assert.match(abandoned.reason, /commit abandoned after 3 attempts/)
  assert.equal(abandoned.state, null, '放弃时不返回半新状态')
  racing.store.armConflicts(0)

  const broken = rig()
  await activate(broken.kernel)
  broken.store.armCommitError('disk gone')
  const failed = await broken.kernel.submit('mss_test', { kind: 'mission.pause', requestId: req(), reason: '磁盘坏了' }, SUPERVISOR)
  assert.equal(failed.applied, false)
  if (failed.applied) return
  assert.match(failed.reason, /commit failed: disk gone/, '存储级错误不重放')
  assert.equal(broken.memory.peek('mss_test')?.mission.status, 'active', '坏提交没有留下半路状态')
})

test('setAdmission 绕过命令转换，但同样过版本核对', async () => {
  const { kernel, memory } = rig()
  const mission = await kernel.open(draftMission())
  assert.equal(await kernel.setAdmission('mss_test', true), true)
  assert.equal(memory.peek('mss_test')?.admissionClosed, false)
  assert.equal(memory.peek('mss_test')?.revision, mission.revision + 1)
  assert.equal(await kernel.setAdmission('mss_missing', true), false)
})

test('renewLeases：只给活名单里的会话续期，且既不涨修订也不追加事件', async () => {
  const base = withClaimedTask()
  const dead = { ...base.state.attempts[base.attemptId]!, attemptId: 'att_dead', status: 'cancelled' as const }
  const state: MissionControl = { ...base.state, attempts: { ...base.state.attempts, att_dead: dead } }
  const { kernel, memory, clock } = rig({ state })
  // 夹具里的 `create` 没有 await，取基线必须走读链而不是同步的 peek 钩子。
  const before = (await kernel.read('mss_test'))!

  clock.now = NOW_OF() + 10_000
  assert.equal(await kernel.renewLeases(new Set(['sess-1']), 90_000), 1, '终态那个不计入续期')
  const after = memory.peek('mss_test')!
  const renewed = after.attempts[base.attemptId]!
  assert.equal(renewed.lastHeartbeatAt, NOW_OF() + 10_000)
  assert.equal(renewed.leaseExpiresAt, NOW_OF() + 100_000, '续期=再给一个完整 TTL，不是累加')
  assert.equal(after.revision, before.revision, '心跳是运维时点，不是控制决策：不推进修订')
  assert.equal(after.events.length, before.events.length, '心跳不追加控制事件')
  assert.equal(after.attempts.att_dead!.leaseExpiresAt, dead.leaseExpiresAt, '终态 Attempt 不续')

  clock.now = NOW_OF() + 20_000
  assert.equal(await kernel.renewLeases(new Set(['sess-other']), 90_000), 0, '会话不在活名单 ⇒ 不续，到期照旧进核对')
  assert.equal(memory.peek('mss_test')!.attempts[base.attemptId]!.leaseExpiresAt, NOW_OF() + 100_000)
  assert.equal(await kernel.renewLeases(new Set(), 90_000), 0, '进程重启后活名单为空：不许替死进程守租约')
  assert.equal(await kernel.renewLeases(new Set(['sess-1']), 0), 0, 'TTL 非正数时一个字节都不写')
})

test('drain：成功结掉条目，失败只登记退避且到期后重投', async () => {
  const { kernel, memory, clock } = rig({ state: stateWith([entry({ outboxId: 'obx_ok' }), entry({ outboxId: 'obx_bad' })]) })
  const seen: string[] = []
  kernel.registerHandler('mailbox.deliver', async (item) => {
    if (item.outboxId === 'obx_bad' && item.attempts === 0) throw new Error('host 拒绝注入消息')
    seen.push(item.outboxId)
  })

  const first = await kernel.drain()
  assert.equal(first.attempted, 2)
  assert.equal(first.completed, 1)
  assert.equal(first.failed, 1)
  assert.deepEqual(seen, ['obx_ok'])
  let state = memory.peek('mss_test')!
  assert.equal(state.outbox['obx_ok']?.completedAt, NOW_OF())
  assert.equal(state.outbox['obx_bad']?.completedAt, undefined, '失败不标完成：假装成功会让投递变成不可追溯的事实')
  assert.equal(state.outbox['obx_bad']?.attempts, 1)
  assert.equal(state.outbox['obx_bad']?.availableAt, NOW_OF() + 5_000)

  const second = await kernel.drain()
  assert.equal(second.attempted, 0, '退避窗口内不重投')

  clock.now = NOW_OF() + 5_001
  const third = await kernel.drain()
  assert.equal(third.completed, 1)
  state = memory.peek('mss_test')!
  assert.equal(state.outbox['obx_bad']?.completedAt, NOW_OF() + 5_001)
  assert.equal(state.events.filter((event) => event.kind === 'outbox/retry-scheduled').length, 1)
})

test('drain：退避按次数翻倍并封顶十分钟', async () => {
  const { kernel, memory, clock } = rig({ state: stateWith([entry()]) })
  kernel.registerHandler('mailbox.deliver', async () => {
    throw new Error('always failing')
  })
  const gaps: number[] = []
  for (let i = 0; i < 8; i += 1) {
    const before = clock.now
    await kernel.drain()
    const item = memory.peek('mss_test')!.outbox['obx_1']!
    gaps.push(item.availableAt - before)
    clock.now = item.availableAt
  }
  assert.deepEqual(gaps, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000], '翻倍但封顶 600000ms')
  const last = memory.peek('mss_test')!.outbox['obx_1']!
  assert.equal(last.attempts, 8)
  assert.match(last.lastError ?? '', /always failing/)
})

test('drain：没有执行器的 kind 计入 unsupported 并原样留在积压里', async () => {
  const { kernel, memory } = rig({ state: stateWith([entry({ outboxId: 'obx_u', kind: 'rotation.seed' })]) })
  const result = await kernel.drain()
  assert.equal(result.unsupported, 1)
  assert.equal(result.attempted, 0)
  assert.equal(memory.peek('mss_test')?.outbox['obx_u']?.completedAt, undefined)
  assert.equal(memory.peek('mss_test')?.outbox['obx_u']?.attempts, 0, '没有执行器不算尝试过')
})

test('drain 的领取与交还走账本写入：涨修订但不给业务时间线追加事件', async () => {
  const { kernel, memory } = rig({ state: stateWith([entry()]) })
  const before = (await kernel.read('mss_test'))!
  kernel.registerHandler('mailbox.deliver', async () => {})
  const result = await kernel.drain()
  assert.equal(result.completed, 1)
  assert.equal(result.unconfirmed, 0)
  const after = memory.peek('mss_test')!
  assert.equal(after.events.length, before.events.length + 1, '一条投递只留 `outbox/completed` 一笔；领取与交还不能也各记一条')
  assert.equal(after.events.filter((event) => event.kind === 'outbox/completed').length, 1)
  assert.ok(after.revision >= before.revision + 2, '领取/交还是运维记账，仍然要过版本核对，所以修订会涨')
  assert.equal(after.outbox['obx_1']?.claimedBy, undefined)
  assert.equal(after.outbox['obx_1']?.claimedAt, undefined)
})

test('drain 能被中止：中止时已在跑的那条按真实结果记账，剩余条目留队', async () => {
  const controller = new AbortController()
  const { kernel, memory } = rig({ state: stateWith([entry({ outboxId: 'obx_a' }), entry({ outboxId: 'obx_b' })]) })
  let handled = 0
  kernel.registerHandler('mailbox.deliver', async () => {
    handled += 1
    controller.abort()
  })
  const result = await kernel.drain(controller.signal)
  assert.equal(handled, 1, '剩余条目不再入场')
  assert.equal(result.completed, 1, '已经发生的外部动作照常结掉，否则下次会重复投递')
  assert.equal(memory.peek('mss_test')!.outbox['obx_a']?.completedAt, NOW_OF())
  assert.equal(memory.peek('mss_test')!.outbox['obx_b']?.completedAt, undefined)
})

test('并发提交在同一条写链上串行：两个任务都落盘', async () => {
  const { kernel, memory, queue } = rig()
  await activate(kernel)
  const results = await Promise.all([
    kernel.submit('mss_test', { kind: 'task.propose', requestId: req('a'), task: taskPayload({ title: '任务 A' }) }, SUPERVISOR),
    kernel.submit('mss_test', { kind: 'task.propose', requestId: req('b'), task: taskPayload({ title: '任务 B' }) }, SUPERVISOR),
  ])
  assert.deepEqual(results.map((item) => item.applied), [true, true])
  const persisted = memory.peek('mss_test')!
  assert.equal(Object.keys(persisted.tasks).length, 2, '丢了任何一笔就是覆盖式并发')
  assert.equal(persisted.revision, 3)
  assert.equal(queue.depth, 0)
})

test('队列饱和时拒绝新入队而不是无限堆积', async () => {
  const queue = new CommandQueue(1)
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const blocking = queue.enqueue('blocking', async () => {
    await gate
    return 'done'
  })
  // 同步再入队：前一条尚未开始执行，`queued` 仍占额度。
  await assert.rejects(() => queue.enqueue('overflow', async () => 'never'), /saturated at 1/)
  release()
  assert.equal(await blocking, 'done')
  assert.equal(queue.depth, 0)
})

test('接管判定：心跳过期但进程还活着就不抢锁', () => {
  const alive: LockRecord = { hostId: 'host-a', pid: process.pid, stamp: NOW_OF(), storePath: 'x' }
  assert.deepEqual(decideTakeover(alive, NOW_OF(), 10_000, 300_000), { takeover: false, reason: 'fresh-heartbeat' })
  assert.deepEqual(decideTakeover(alive, NOW_OF() + 60_000, 10_000, 300_000), { takeover: false, reason: 'held-alive' }, '进程存活 ⇒ 交给人判定')
  const dead: LockRecord = { ...alive, pid: 2_100_000_000 }
  assert.deepEqual(decideTakeover(dead, NOW_OF() + 30_000, 10_000, 300_000), { takeover: true, reason: 'owner-stamped-away' })
  assert.deepEqual(decideTakeover(dead, NOW_OF() + 300_001, 10_000, 300_000), { takeover: true, reason: 'owner-dead' })
})
