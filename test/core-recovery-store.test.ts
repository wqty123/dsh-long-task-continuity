/**
 * 崩溃恢复与存储端口（§11.1、§11.2、§5.3）。
 *
 * 这里的用例只认一条原则：**没证据就按住**。恢复阶段产出的名单决定"能不能开始干活"，
 * 所以每个 blocker 都要能被单独触发、单独断言，而不是只看总体 `readyForAdmission`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assess, bootRecover, classifyOperations } from '../src/core/recovery.ts'
import { DomainStore, MemoryStore, RevisionConflict, assertShape } from '../src/core/store.ts'
import type { KvTableLike } from '../src/core/store.ts'
import type { ControlStore } from '../src/core/store.ts'
import type { MissionControl } from '../src/core/control.ts'
import { SCHEMA_VERSION } from '../src/core/control.ts'
import type { Mission } from '../src/core/entities.ts'
import { LEASE_EXPIRY_MS } from '../src/core/entities.ts'
import { apply, checkpointPayload, ctx, draftMission, freshState, NOW, req, withClaimedTask } from './fixtures.ts'

function storedState(missionId: string, missionOverrides: Partial<Mission> = {}, stateOverrides: Partial<MissionControl> = {}): MissionControl {
  return { ...freshState(stateOverrides), missionId, mission: draftMission({ missionId, ...missionOverrides }) }
}

/** 带一项"结果不确定"外部操作的记录：命令链走真的，只有创建期字段（allowAutoResume）事后补。 */
function hungMission(missionId = 'mss_test'): MissionControl {
  let state = withClaimedTask().state
  const taskId = Object.keys(state.tasks)[0]!
  state = apply(state, { kind: 'operation.intent', requestId: req(), taskId, operationKind: 'upload', target: 'oss://x', intent: '传产物', idempotencyKey: 'k9', retryable: false }, ctx('lead', 'lead-1'))
  const operationId = Object.keys(state.operations)[0]!
  state = apply(state, { kind: 'operation.reconcile', requestId: req(), operationId, verdict: 'still_unknown' })
  return { ...state, missionId, mission: { ...state.mission, missionId, allowAutoResume: true } }
}

/** 推进到 COMMITTED 的轮换：真实走一遍阶段链，顺带产生未收束轮换与启动 outbox 两项事实。 */
function committedRotation(): MissionControl {
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

class FakeTable implements KvTableLike<MissionControl> {
  private readonly records: Record<string, MissionControl> = {}
  private intruder?: MissionControl

  armIntruder(record: MissionControl): void {
    this.intruder = record
  }

  get(key: string): MissionControl | undefined {
    return this.records[key]
  }

  async put(key: string, value: MissionControl): Promise<void> {
    this.records[key] = value
  }

  async update(key: string, fn: (current: MissionControl) => MissionControl): Promise<MissionControl> {
    if (this.intruder !== undefined && this.intruder.missionId === key) this.records[key] = this.intruder
    this.records[key] = fn(this.records[key]!)
    return this.records[key]!
  }

  *entries(): IterableIterator<[string, MissionControl]> {
    yield* Object.entries(this.records)
  }
}

/** 记录在 `list()` 里但读不出来的存储：恢复流程必须跳过而不是崩。 */
class SparseStore implements ControlStore {
  private readonly inner: MemoryStore
  private readonly unreadable: string[]

  constructor(inner: MemoryStore, unreadable: readonly string[] = []) {
    this.inner = inner
    this.unreadable = [...unreadable]
  }

  load(missionId: string): Promise<MissionControl | null> {
    return this.unreadable.includes(missionId) ? Promise.resolve(null) : this.inner.load(missionId)
  }

  commit(missionId: string, expectedRevision: number, next: MissionControl): Promise<void> {
    return this.inner.commit(missionId, expectedRevision, next)
  }

  create(missionId: string, initial: MissionControl): Promise<void> {
    return this.inner.create(missionId, initial)
  }

  list(): Promise<string[]> {
    return this.inner.list()
  }
}

// ---------------------------------------------------------------- 记录校验与存储

test('assertShape：版本、修订号、归属键任一不符即拒绝', () => {
  const good = freshState()
  assert.equal(assertShape(good, 'mss_test'), good)
  assert.throws(() => assertShape(null, 'mss_test'), /not an object/)
  assert.throws(() => assertShape({ ...good, schemaVersion: SCHEMA_VERSION + 1 }, 'mss_test'), new RegExp(`unsupported schemaVersion ${SCHEMA_VERSION + 1} \\(want ${SCHEMA_VERSION}\\)`), '§5.3：v0.3 词表下旧记录语义不可还原，装载即拒绝并提示备份-迁移-校验')
  assert.throws(() => assertShape({ ...good, revision: -1 }, 'mss_test'), /malformed revision/)
  assert.throws(() => assertShape({ ...good, revision: 1.5 }, 'mss_test'), /malformed revision/)
  assert.throws(() => assertShape({ ...good, missionId: 'mss_other' }, 'mss_test'), /wrong missionId/)
})

test('MemoryStore：读写深拷贝，改回来的对象污染不了记录', async () => {
  const store = new MemoryStore()
  await store.create('mss_test', freshState())
  const loaded = (await store.load('mss_test')) as unknown as { mission: { objective: string }; revision: number }
  loaded.mission.objective = '被改坏了'
  loaded.revision = 999
  const again = (await store.load('mss_test'))!
  assert.equal(again.mission.objective, '把连续性台账跑通')
  assert.equal(again.revision, freshState().revision)
})

test('MemoryStore：重复 create 与未创建即 commit 都报错', async () => {
  const store = new MemoryStore()
  await store.create('mss_test', freshState())
  await assert.rejects(() => store.create('mss_test', freshState()), /already exists/)
  await assert.rejects(() => store.commit('mss_missing', 0, freshState()), /not found/)
  assert.deepEqual(await store.list(), ['mss_test'])
})

test('MemoryStore：版本不符抛 RevisionConflict 并带上两个版本号', async () => {
  const store = new MemoryStore()
  const stored = freshState()
  await store.create('mss_test', stored)
  await assert.rejects(
    () => store.commit('mss_test', 99, { ...stored, revision: 7 }),
    (error: unknown) => error instanceof RevisionConflict && error.expected === 99 && error.actual === stored.revision && error.missionId === 'mss_test',
  )
  assert.equal((await store.load('mss_test'))?.revision, stored.revision, '冲突提交不许留下任何痕迹')
})

test('DomainStore：同版本提交落地，list 与 load 走表', async () => {
  const table = new FakeTable()
  const store = new DomainStore(table)
  const base = freshState()
  await store.create('mss_test', base)
  const next = { ...base, revision: base.revision + 1 }
  await store.commit('mss_test', base.revision, next)
  assert.equal((await store.load('mss_test'))?.revision, next.revision)
  assert.deepEqual(await store.list(), ['mss_test'])
  await assert.rejects(() => store.create('mss_test', base), /already exists/)
})

test('DomainStore：并发插入者占了槽位就抛冲突，表里保留插入者的记录', async () => {
  const table = new FakeTable()
  const store = new DomainStore(table)
  const base = freshState()
  await store.create('mss_test', base)
  const intruder = { ...base, revision: base.revision + 10, mission: draftMission({ missionId: 'mss_test', objective: '别人先提交了' }) }
  table.armIntruder(intruder)
  await assert.rejects(
    () => store.commit('mss_test', base.revision, { ...base, revision: base.revision + 1 }),
    (error: unknown) => error instanceof RevisionConflict && error.actual === intruder.revision,
  )
  assert.equal((await store.load('mss_test'))?.mission.objective, '别人先提交了')
})

test('DomainStore：clone 钩子决定读出的对象是否独立', async () => {
  const table = new FakeTable()
  const store = new DomainStore(table, (value) => structuredClone(value))
  const base = freshState()
  await store.create('mss_test', base)
  const loaded = (await store.load('mss_test')) as unknown as { budget: { modelCalls: number } }
  loaded.budget.modelCalls = 42
  assert.equal((await store.load('mss_test'))?.budget.modelCalls, base.budget.modelCalls)
})

// ---------------------------------------------------------------- 操作归类

test('classifyOperations：按状态与可重试性给出 retry / reconcile / await', () => {
  let state = withClaimedTask().state
  const taskId = Object.keys(state.tasks)[0]!
  const intent = (key: string, kind: string, retryable: boolean, reconcileMethod?: string) =>
    apply(state, { kind: 'operation.intent', requestId: req(), taskId, operationKind: kind, target: `t-${key}`, intent: 'x', idempotencyKey: key, retryable, ...(reconcileMethod === undefined ? {} : { reconcileMethod }) }, ctx('lead', 'lead-1'))
  state = intent('k1', 'shell', true)
  state = intent('k2', 'upload', false)
  state = intent('k3', 'push', false, '查远端 HEAD')
  state = intent('k4', 'notify', true)
  state = intent('k5', 'deploy', false)
  const ids = Object.keys(state.operations)
  state = apply(state, { kind: 'operation.receipt', requestId: req(), operationId: ids[3]!, status: 'succeeded' }, ctx('lead', 'lead-1'))
  state = apply(state, { kind: 'operation.reconcile', requestId: req(), operationId: ids[4]!, verdict: 'still_unknown' })
  assert.deepEqual(
    classifyOperations(state).map((item) => `${item.kind}:${item.action}`).sort(),
    ['deploy:reconcile', 'push:reconcile', 'shell:retry', 'upload:await'],
    '已结算的操作不进恢复计划',
  )
})

// ---------------------------------------------------------------- assess

test('assess：暂停/取消/终态各给一条不可自动恢复的理由', () => {
  for (const [status, reason] of [
    ['paused', '用户暂停，需显式恢复'],
    ['cancelled', '任务已取消，不复活；需要重开请建新 Mission'],
    ['completed', 'Mission 处于终态 completed'],
  ] as const) {
    const report = assess(storedState('mss_test', { status, allowAutoResume: true }), NOW)
    assert.deepEqual(report.blockers, [reason])
    assert.equal(report.autoResumeAllowed, false)
    assert.equal(report.readyForAdmission, false, `${status} 不放业务入场`)
  }
  assert.equal(assess(storedState('mss_test', { status: 'waiting' }), NOW).readyForAdmission, true)
})

test('assess：预算受阻把维度名一起报出来', () => {
  const state = storedState('mss_test', { status: 'active' }, {
    budgetLimits: { ...freshState().budgetLimits, maxTotalTokens: 0, maxModelCalls: 0, maxTaskRetries: 0, maxMailboxMessages: 0 },
  })
  const report = assess(state, NOW)
  assert.deepEqual(report.blockers, ['预算受阻：tokens/calls/retries/mailbox'])
})

test('assess：未收束轮换与启动 outbox 积压都来自真实推进', () => {
  const state = committedRotation()
  const report = assess(state, NOW)
  assert.equal(report.openRotations.length, 1)
  assert.equal(report.openRotations[0]?.phase, 'COMMITTED')
  assert.equal(report.outboxBacklog, 1)
  assert.match(report.blockers.join('\n'), /1 个轮换未收束/)
  assert.equal(report.autoResumeAllowed, false)
})

test('assess：租约过期的 Attempt 进 staleAttempts，已收束的不算', () => {
  let state = withClaimedTask().state
  const taskId = Object.keys(state.tasks)[0]!
  state = apply(state, { kind: 'task.checkpoint', requestId: req(), taskId, checkpoint: checkpointPayload() }, ctx('lead', 'lead-1'))
  state = apply(state, { kind: 'task.submit', requestId: req(), taskId, leaseVersion: 1 }, ctx('lead', 'lead-1'))
  const running = assess(state, NOW + LEASE_EXPIRY_MS + 1)
  assert.equal(running.staleAttempts.length, 1, 'submitted 还没验收，Attempt 仍未收束')
  const verified = apply(state, { kind: 'task.verify', requestId: req(), taskId, criterionId: 'crit_1', outcome: 'pass', method: 'node --test', methodVersion: '1', evidenceRefs: ['e'] }, ctx('reviewer', 'rev-1'))
  assert.deepEqual(assess(verified, NOW + LEASE_EXPIRY_MS + 1).staleAttempts, [], 'settled 是终态，不该被当成悬挂执行权')
})

test('assess：投递三次以上仍未确认的消息才转阻塞', () => {
  let state = withClaimedTask().state
  state = apply(state, { kind: 'team.message', requestId: req(), toActorId: 'lead-1', messageKind: 'finding', body: '一条发现' }, ctx('lead', 'lead-1'))
  const messageId = Object.keys(state.mailbox)[0]!
  assert.deepEqual(assess(state, NOW).blockers, [], '刚发出的消息不算阻塞')
  const bumped = { ...state, mailbox: { ...state.mailbox, [messageId]: { ...state.mailbox[messageId]!, attempts: 3 } } }
  assert.match(assess(bumped, NOW).blockers.join('\n'), /1 条消息投递失败，转待处理队列/)
})

test('assess：autoResumeAllowed 只在"活动 + 用户允许 + 零阻塞"时成立', () => {
  assert.equal(assess(storedState('mss_test', { status: 'active' }), NOW).autoResumeAllowed, false, 'allowAutoResume 默认关')
  const allowed = storedState('mss_test', { status: 'active', allowAutoResume: true })
  assert.equal(assess(allowed, NOW).autoResumeAllowed, true)
  assert.equal(assess(allowed, NOW).revision, allowed.revision)
  const hung = hungMission()
  assert.equal(assess(hung, NOW).autoResumeAllowed, false, '外部操作结果没核对完就不许自动续')
  assert.deepEqual(assess(hung, NOW).inFlightOperations, ['upload:reconcile'])
  assert.match(assess(hung, NOW).blockers.join('\n'), /1 项外部操作结果不确定，先核对/)
})

// ---------------------------------------------------------------- bootRecover

test('bootRecover：admit/hold 分名单，读不出来的记录跳过', async () => {
  const store = new MemoryStore()
  const ok = storedState('mss_ok', { status: 'active', allowAutoResume: true })
  const paused = storedState('mss_paused', { status: 'paused', allowAutoResume: true })
  const hung = hungMission('mss_hung')
  await store.create('mss_ok', ok)
  await store.create('mss_paused', paused)
  await store.create('mss_hung', hung)
  await store.create('mss_ghost', storedState('mss_ghost', { status: 'active' }))
  const plan = await bootRecover(new SparseStore(store, ['mss_ghost']), NOW)
  assert.equal(plan.reports.length, 3, '读不出来的记录不进报告')
  assert.deepEqual(plan.admit, ['mss_ok'])
  assert.equal(plan.hold.length, 2)
  assert.deepEqual(plan.hold.find((item) => item.missionId === 'mss_paused')?.why, ['用户暂停，需显式恢复'])
  assert.match(plan.hold.find((item) => item.missionId === 'mss_hung')?.why.join('\n') ?? '', /1 项外部操作结果不确定/)
})
