/**
 * outbox 投递生命周期（审阅 R2）与落盘通知（审阅 R1）。
 *
 * `OUTBOX_PARALLEL_DRAIN`、`OUTBOX_ACK_FAILURE` 与 `STALE_GUARD_WIRING` 三个探针从
 * `审阅_20261015/reproduce.mjs` 移植，断言按修复后的期望取反：
 * 并发 drain 对同一意图只执行一次；确认写不进存储时记 `unconfirmed` 而不是 `completed`，
 * 条目必须先留下"结果未确认"的记录才可能再入场（重投靠条目自带的 `idempotencyKey` 由接收侧去重）；
 * 守卫拿到的是提交后的快照——取消提交一返回，下一次受管工具调用立即被拒。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { AdmissionTicket, OutboxEntry } from '../src/core/entities.ts'
import type { MissionControl } from '../src/core/control.ts'
import type { CommandContext } from '../src/core/commands.ts'
import type { KernelOptions } from '../src/core/kernel.ts'
import { ContinuityKernel } from '../src/core/kernel.ts'
import { draftMission, freshState, req, withClaimedTask } from './fixtures.ts'
import type { ControlStore } from '../src/core/store.ts'
import { MemoryStore, RevisionConflict } from '../src/core/store.ts'
import { CommandQueue } from '../src/core/queue.ts'
import { toolGuard, type AdmissionSnapshot } from '../src/adapter/dsh.ts'
import { PLUGIN_TOOL_NAMES } from '../src/adapter/tools.ts'

const NOW = 1_700_000_000_000
const SUPERVISOR: CommandContext = { actorId: 'supervisor', role: 'supervisor', now: NOW }

function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    outboxId: 'obx_1',
    missionId: 'mss_test',
    kind: 'mailbox.deliver',
    payload: { messageId: 'msg_1', sessionId: 'sess-1', body: '正文' },
    idempotencyKey: 'msg_1',
    attempts: 0,
    availableAt: NOW,
    ...overrides,
  }
}

function stateWith(entries: readonly OutboxEntry[]): MissionControl {
  return { ...freshState(), outbox: Object.fromEntries(entries.map((item) => [item.outboxId, item])) }
}

/**
 * 选择性故障存储：`rejectWhen` 按待写入状态决定这笔提交是否抛磁盘级错误。
 * 内核只看得到"提交抛错"或"提交没抛"，所以这里注入的失败与真机写失败同形。
 */
class FaultStore implements ControlStore {
  private readonly inner: MemoryStore
  private reject: ((next: MissionControl) => string | undefined) | undefined

  constructor(inner: MemoryStore) {
    this.inner = inner
  }

  rejectWhen(reject: ((next: MissionControl) => string | undefined) | undefined): void {
    this.reject = reject
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
    const reason = this.reject?.(next)
    if (reason !== undefined) throw new Error(reason)
    await this.inner.commit(missionId, expectedRevision, next)
  }
}

/** 所有写都失败的存储：与 reproduce.mjs 的 `failingStore` 同形（连领取都落不了盘）。 */
class BrokenStore implements ControlStore {
  private readonly inner: MemoryStore

  constructor(inner: MemoryStore) {
    this.inner = inner
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

  async commit(_missionId: string, _expectedRevision: number, _next: MissionControl): Promise<void> {
    throw new Error('review: injected disk failure')
  }
}

/**
 * 竞争消费者存储：发现"本内核要写入的领取"时，先让对手把同一条目领走再抛版本冲突。
 * 用来钉住领取失败后的重读重判——没领到的条目绝不能调用执行器。
 */
class RivalStore implements ControlStore {
  private readonly inner: MemoryStore
  private readonly rivalId: string
  private armed = false

  constructor(inner: MemoryStore, rivalId: string) {
    this.inner = inner
    this.rivalId = rivalId
  }

  armOnce(): void {
    this.armed = true
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
    const ours = Object.values(next.outbox).some((item) => item.claimedBy !== undefined && item.claimedBy !== this.rivalId)
    if (this.armed && ours) {
      this.armed = false
      const current = await this.inner.load(missionId)
      if (current === null) throw new Error(`mission ${missionId} 记录缺失`)
      const stolen: MissionControl = {
        ...current,
        revision: current.revision + 1,
        outbox: Object.fromEntries(
          Object.entries(current.outbox).map(([outboxId, item]) => [outboxId, { ...item, claimedAt: NOW, claimedBy: this.rivalId, claimExpiresAt: NOW + 3_600_000 }]),
        ),
      }
      await this.inner.commit(missionId, expectedRevision, stolen)
      throw new RevisionConflict(missionId, expectedRevision, stolen.revision)
    }
    await this.inner.commit(missionId, expectedRevision, next)
  }
}

interface Rig {
  readonly kernel: ContinuityKernel
  readonly memory: MemoryStore
  readonly clock: { now: number }
}

/** 每个内核实例一条自己的队列，与真机一致：并发 drain 用同一套时钟与存储。 */
function rig(options: { readonly state?: MissionControl; readonly store?: ControlStore; readonly kernelOptions?: KernelOptions } = {}): Rig {
  const clock = { now: NOW }
  const memory = new MemoryStore()
  if (options.state !== undefined) void memory.create('mss_test', options.state)
  const store = options.store ?? new FaultStore(memory)
  return { kernel: new ContinuityKernel(store, new CommandQueue(), { now: () => clock.now, ...options.kernelOptions }), memory, clock }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms)
})

// —— R2：并发 drain（OUTBOX_PARALLEL_DRAIN 取反） ——

test('OUTBOX_PARALLEL_DRAIN（取反）：同一进程的两轮并发 drain 对同一意图只执行一次', async () => {
  const { kernel, memory } = rig({ state: stateWith([entry()]) })
  let entered = 0
  kernel.registerHandler('mailbox.deliver', async () => {
    entered += 1
    await sleep(10)
  })

  const drains = await Promise.all([kernel.drain(), kernel.drain()])
  assert.equal(entered, 1, '领取→执行→确认是一条跨读写的生命周期，不能由两轮 drain 各跑一次')
  assert.equal(drains.reduce((sum, item) => sum + item.attempted, 0), 1)
  assert.equal(drains.reduce((sum, item) => sum + item.completed, 0), 1)
  assert.equal(drains.reduce((sum, item) => sum + item.failed + item.unconfirmed, 0), 0)
  const item = memory.peek('mss_test')!.outbox['obx_1']!
  assert.ok(item.completedAt !== undefined, '条目结掉')
  assert.equal(item.claimedBy, undefined, '完成后交还领取')
  assert.equal(item.claimedAt, undefined)
})

test('OUTBOX_PARALLEL_DRAIN（跨消费者）：别人持有未过期领取时本轮一个字节都不碰', async () => {
  const memory = new MemoryStore()
  await memory.create('mss_test', stateWith([entry()]))
  const clock = { now: NOW }
  let holderEntered = 0
  let foreignEntered = 0
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const holder = new ContinuityKernel(new FaultStore(memory), new CommandQueue(), { now: () => clock.now, consumerId: 'holder' })
  const other = new ContinuityKernel(new FaultStore(memory), new CommandQueue(), { now: () => clock.now, consumerId: 'other' })
  holder.registerHandler('mailbox.deliver', async () => {
    holderEntered += 1
    await held
  })
  other.registerHandler('mailbox.deliver', async () => {
    foreignEntered += 1
  })

  const holding = holder.drain()
  // 执行器已入场 ⇒ 持久领取必然已落盘；此后的并发消费者只会看到别人的有效领取。
  await sleep(5)
  const second = await other.drain()
  assert.deepEqual(second, { attempted: 0, completed: 0, failed: 0, unsupported: 0, unconfirmed: 0, blocked: [] })
  assert.equal(foreignEntered, 0, '未过期的他人领取不许抢占：到期只触发核对，不证明旧执行者已停')
  release()
  const first = await holding
  assert.equal(holderEntered, 1)
  assert.equal(first.completed, 1)
  assert.equal(memory.peek('mss_test')!.outbox['obx_1']!.completedAt, NOW)
})

test('领取写入撞上并发消费者：重读后让路，绝不执行没领到的条目', async () => {
  const memory = new MemoryStore()
  await memory.create('mss_test', stateWith([entry()]))
  const store = new RivalStore(memory, 'rival-worker')
  store.armOnce()
  const kernel = new ContinuityKernel(store, new CommandQueue(), { now: () => NOW, consumerId: 'self-worker' })
  let deliveries = 0
  kernel.registerHandler('mailbox.deliver', async () => {
    deliveries += 1
  })

  const result = await kernel.drain()
  assert.deepEqual(result, { attempted: 0, completed: 0, failed: 0, unsupported: 0, unconfirmed: 0, blocked: [] })
  assert.equal(deliveries, 0, '版本冲突后重读重判：条目已被对手领取就跳过')
  assert.equal(memory.peek('mss_test')!.outbox['obx_1']!.claimedBy, 'rival-worker', '对手的领取留在记录里')
})

// —— R2：确认写入失败（OUTBOX_ACK_FAILURE 取反） ——

test('OUTBOX_ACK_FAILURE（取反）：确认写不进去时记 unconfirmed 而非 completed，且不在退避窗口内重投', async () => {
  const memory = new MemoryStore()
  await memory.create('mss_test', stateWith([entry()]))
  const store = new FaultStore(memory)
  // 只拒绝"把条目标成完成"的那笔提交，正是 reproduce 探针注入的 ACK 失败。
  store.rejectWhen((next) => (Object.values(next.outbox).some((item) => item.completedAt !== undefined) ? 'review: ack 写入失败' : undefined))
  const clock = { now: NOW }
  const kernel = new ContinuityKernel(store, new CommandQueue(), { now: () => clock.now })
  let deliveries = 0
  kernel.registerHandler('mailbox.deliver', async () => {
    deliveries += 1
  })

  const first = await kernel.drain()
  assert.equal(first.attempted, 1)
  assert.equal(first.completed, 0, '确认没落盘就不能算完成')
  assert.equal(first.unconfirmed, 1)
  assert.equal(deliveries, 1)
  let item = memory.peek('mss_test')!.outbox['obx_1']!
  assert.equal(item.completedAt, undefined)
  assert.equal(item.sentAt, NOW, '执行器已返回：sentAt 与 completedAt 分开记')
  assert.equal(item.attempts, 1, '跑过一次就要涨次数，否则下一轮的 requestId 与退避都会跟这一轮撞车')
  assert.match(item.lastError ?? '', /未确认.*核对/, 'lastError 必须说明结果未确认并指向台账核对')
  assert.equal(item.claimedBy, undefined, '领取交还，下一轮才可能重新入场')

  const second = await kernel.drain()
  assert.equal(second.attempted, 0)
  assert.equal(deliveries, 1, '退避窗口内不重投：这条不是"没投过"')

  clock.now = NOW + 5_001
  store.rejectWhen(undefined)
  const third = await kernel.drain()
  assert.equal(deliveries, 2, '到期后按同一 idempotencyKey 重投，由接收侧去重')
  assert.equal(third.completed, 1)
  item = memory.peek('mss_test')!.outbox['obx_1']!
  assert.equal(item.completedAt, NOW + 5_001)
})

test('OUTBOX_ACK_FAILURE（存储全写失败）：领取落不了盘时宁可不投递，也不报 completed', async () => {
  const memory = new MemoryStore()
  await memory.create('mss_test', stateWith([entry()]))
  const kernel = new ContinuityKernel(new BrokenStore(memory), new CommandQueue(), { now: () => NOW })
  let deliveries = 0
  kernel.registerHandler('mailbox.deliver', async () => {
    deliveries += 1
  })

  const first = await kernel.drain()
  await kernel.drain()
  assert.equal(first.completed, 0, '探针原来报的 completed=1 就是"失败的确认当成功"')
  assert.equal(first.attempted, 0)
  assert.equal(first.failed, 1)
  assert.equal(deliveries, 0, '没有持久领取就调用执行器，等于把重复投递交给运气')
  assert.equal(memory.peek('mss_test')!.outbox['obx_1']!.completedAt, undefined)
})

// —— R2：崩溃与领取到期 ——

test('崩溃模拟：领取到期先报结果未确认并退避，到期前一步都不执行', async () => {
  const crashed = entry({ outboxId: 'obx_crash', claimedAt: NOW, claimedBy: 'dead-worker', claimExpiresAt: NOW + 60_000 })
  const { kernel, memory, clock } = rig({ state: stateWith([crashed]) })
  let deliveries = 0
  kernel.registerHandler('mailbox.deliver', async () => {
    deliveries += 1
  })

  const live = await kernel.drain()
  assert.deepEqual(live, { attempted: 0, completed: 0, failed: 0, unsupported: 0, unconfirmed: 0, blocked: [] })
  assert.equal(deliveries, 0, '死进程留下的有效领取不能被当成没投过')

  clock.now = NOW + 60_001
  const expired = await kernel.drain()
  assert.equal(expired.unconfirmed, 1)
  assert.equal(expired.attempted, 0, '过期领取只记账，不在本轮假装重放')
  assert.equal(deliveries, 0)
  let item = memory.peek('mss_test')!.outbox['obx_crash']!
  assert.equal(item.attempts, 1)
  assert.equal(item.availableAt, NOW + 60_001 + 5_000, '沿用既有退避基数')
  assert.match(item.lastError ?? '', /未确认.*核对/)
  assert.equal(item.claimedBy, undefined, '过期领取交还，后续消费者才能重新领取')

  clock.now = item.availableAt
  const next = await kernel.drain()
  assert.equal(deliveries, 1, '核对之后的重投靠 idempotencyKey 兜住')
  assert.equal(next.completed, 1)
  item = memory.peek('mss_test')!.outbox['obx_crash']!
  assert.equal(item.completedAt, NOW + 65_001)
})

test('崩溃模拟：本消费者漏下的领取（收尾写入也失败）先记账，再重投一次才结掉', async () => {
  const memory = new MemoryStore()
  await memory.create('mss_test', stateWith([entry()]))
  const store = new FaultStore(memory)
  // 完成确认与"结果未确认"那笔都拒绝：条目只能带着有效领取停在原地。
  store.rejectWhen((next) => {
    const items = Object.values(next.outbox)
    return items.some((item) => item.completedAt !== undefined || item.sentAt !== undefined) ? 'review: 收尾写入失败' : undefined
  })
  const clock = { now: NOW }
  const kernel = new ContinuityKernel(store, new CommandQueue(), { now: () => clock.now, consumerId: 'worker-1' })
  let deliveries = 0
  kernel.registerHandler('mailbox.deliver', async () => {
    deliveries += 1
  })

  const first = await kernel.drain()
  assert.equal(first.attempted, 1)
  assert.equal(first.completed, 0)
  assert.equal(first.unconfirmed, 1)
  let item = memory.peek('mss_test')!.outbox['obx_1']!
  assert.equal(item.claimedBy, 'worker-1', '收尾没落盘：领取仍在')

  store.rejectWhen(undefined)
  const second = await kernel.drain()
  assert.equal(deliveries, 1, '漏下的领取先记账，不在同一轮直接重投')
  assert.equal(second.unconfirmed, 1)
  item = memory.peek('mss_test')!.outbox['obx_1']!
  assert.match(item.lastError ?? '', /未确认/, '必须先留下一条"结果未确认、需与台账核对"的记录')
  assert.equal(item.claimedBy, undefined)
  assert.equal(item.attempts, 1)

  clock.now = item.availableAt
  const third = await kernel.drain()
  assert.equal(deliveries, 2)
  assert.equal(third.completed, 1)
})

// —— R1：落盘通知 ——

test('onCommitted：每一次成功落盘都把新状态交回缓存持有方', async () => {
  const seen: { readonly missionId: string; readonly revision: number; readonly status: string; readonly admissionClosed: boolean }[] = []
  const clock = { now: NOW }
  const memory = new MemoryStore()
  const kernel = new ContinuityKernel(new FaultStore(memory), new CommandQueue(), {
    now: () => clock.now,
    onCommitted: (missionId, state) => {
      seen.push({ missionId, revision: state.revision, status: state.mission.status, admissionClosed: state.admissionClosed })
    },
  })

  await kernel.open(draftMission())
  assert.deepEqual(seen, [{ missionId: 'mss_test', revision: 0, status: 'draft', admissionClosed: true }], 'open 的 create 也要通知')

  await kernel.setAdmission('mss_test', true)
  assert.equal(seen.at(-1)?.revision, 1, 'setAdmission 绕过命令转换，但同样是持久变更')
  assert.equal(seen.at(-1)?.admissionClosed, false)

  // `mission.cancel` 正是 STALE_GUARD_WIRING 的那一笔：提交成功，但缓存守卫读的是提交前的快照。
  const cancelled = await kernel.submit('mss_test', { kind: 'mission.cancel', requestId: req('cancel'), reason: 'review' }, SUPERVISOR)
  assert.equal(cancelled.applied, true)
  assert.equal(seen.at(-1)?.status, 'cancelled', '缓存方拿到的是取消之后的状态')
  assert.equal(seen.at(-1)?.revision, memory.peek('mss_test')!.revision, '通知里的状态与落盘状态同版本')
})

test('onCommitted：租约心跳不涨修订，但同样要刷新缓存', async () => {
  const seen: number[] = []
  const clock = { now: NOW }
  const { kernel, memory } = rig({ state: withClaimedTask().state, kernelOptions: { onCommitted: (_missionId, state) => seen.push(state.revision) } })

  clock.now = NOW + 10_000
  assert.equal(await kernel.renewLeases(new Set(['sess-1']), 90_000), 1)
  assert.equal(seen.length, 1)
  assert.equal(seen[0], memory.peek('mss_test')!.revision, '心跳提交的仍是同一修订，但状态已刷新')
})

// —— R1：准入守卫读的是提交后的快照（STALE_GUARD_WIRING 取反） ——

test('STALE_GUARD_WIRING（取反）：取消提交返回后，下一次受管工具调用立即被拒绝，无需重新装载', async () => {
  const clock = { now: NOW }
  const memory = new MemoryStore()
  const committed = new Map<string, MissionControl>()
  const kernel = new ContinuityKernel(new FaultStore(memory), new CommandQueue(), {
    now: () => clock.now,
    // 与 index.ts 的装配同形：提交通知是这份缓存的唯一更新通道（§12.2）。
    onCommitted: (id, state) => committed.set(id, state),
  })
  await memory.create('mss_test', withClaimedTask().state)
  // 挂载时的装载（index.ts 的 priming）：缓存不空，守卫才有可比对的基准。
  const primed = await kernel.read('mss_test')
  assert.notEqual(primed, null)
  committed.set('mss_test', primed!)

  // 守卫装配与 index.ts 的 snapshot()/identify 同形：票据以 Attempt 为准，租约过期或已结算的都不算。
  const identify = (execution: { readonly agent?: { readonly id?: unknown } }): string | undefined => {
    const sessionId = String(execution.agent?.id ?? '')
    const state = committed.get('mss_test')
    if (state === undefined) return undefined
    return Object.values(state.actors).find((actor) => actor.sessionId === sessionId && !actor.retired)?.actorId
  }
  const snapshot = (): AdmissionSnapshot => {
    const state = committed.get('mss_test') ?? null
    const now = clock.now
    const tickets = new Map<string, AdmissionTicket>()
    if (state !== null) {
      for (const attempt of Object.values(state.attempts)) {
        if (attempt.status !== 'running' && attempt.status !== 'recovering') continue
        if (attempt.leaseExpiresAt < now) continue
        if (attempt.ticket === undefined) continue
        tickets.set(attempt.actorId, attempt.ticket)
      }
    }
    return { closed: state === null || state.admissionClosed, tickets, state, now, readOnlyTools: new Set(PLUGIN_TOOL_NAMES) }
  }
  const guard = toolGuard(snapshot, identify)
  const write = { name: 'write_file', agent: { id: 'sess-1' } }

  assert.equal(guard(write), undefined, '开工后受管写入放行')

  // 这一笔就是 STALE_GUARD_WIRING 的原始剧本：提交成功，但旧装配里守卫读的是提交前的快照。
  const cancelled = await kernel.submit('mss_test', { kind: 'mission.cancel', requestId: req('cancel'), reason: '审阅复现' }, SUPERVISOR)
  assert.equal(cancelled.applied, true)
  assert.match(String(guard(write)), /no live admission ticket/, '取消提交一返回，下一次调用必须立即被拒——不依赖任何重新装载')

  // 再补一笔准入关闭（/continuity cancel 动词紧随提交执行的那一步），仍是同一条通道送达缓存。
  assert.equal(await kernel.setAdmission('mss_test', false), true)
  assert.match(String(guard(write)), /admission closed/)
})

test('onCommitted 抛错不吞：提交失败关闭，但已落盘的状态仍然留档', async () => {
  const clock = { now: NOW }
  const memory = new MemoryStore()
  await memory.create('mss_test', stateWith([]))
  const kernel = new ContinuityKernel(new FaultStore(memory), new CommandQueue(), {
    now: () => clock.now,
    onCommitted: () => {
      throw new Error('缓存刷新失败')
    },
  })

  await assert.rejects(
    () => kernel.submit('mss_test', { kind: 'mission.cancel', requestId: req('cancel'), reason: 'review' }, SUPERVISOR),
    /缓存刷新失败/,
    '刷新被静默丢弃正是陈旧快照缺陷的成因，必须让调用方失败关闭',
  )
  assert.equal(memory.peek('mss_test')!.mission.status, 'cancelled', '写确实落了盘：抛的是刷新，不是存储')
  await assert.rejects(() => kernel.setAdmission('mss_test', true), /缓存刷新失败/)
})
