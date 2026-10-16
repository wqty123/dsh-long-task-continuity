/**
 * 静默核对、阶段合法后继与软停（设计稿 v0.2 §10.2、§10.3）。
 *
 * `turnBoundary` 变化只是候选信号：轮末不等于团队空闲。因此"能不能交接"由这里的
 * 七条核对决定，并且**任何一项判不出都按未满足处理**；软停那边则有一条反向红线：
 * 人类提示绝不能被停止闸门吞掉。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Actor, Attempt, Operation, Rotation, RotationPhase } from '../src/core/entities.ts'
import type { MissionControl } from '../src/core/control.ts'
import { freshState, NOW } from './fixtures.ts'
import type { QuiescenceProbe } from '../src/rotation/fsm.ts'
import { PHASES, legalSuccessors, missingPhaseFacts, pastCommit, safeToHandoff, shouldKeepSource } from '../src/rotation/fsm.ts'
import type { BoundaryWaitOptions } from '../src/rotation/latch.ts'
import { StopLatch, decidePreStep, waitForBoundary, waitForSession, isHumanPrompt } from '../src/rotation/latch.ts'

const SESSION = 'sess-1'

function lead(overrides: Partial<Actor> = {}): Actor {
  return {
    actorId: 'lead-1',
    missionId: 'mss_test',
    role: 'lead',
    label: 'Lead',
    sessionId: SESSION,
    bindingVersion: 1,
    available: true,
    dormant: false,
    retired: false,
    rotationsLastHour: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    attemptId: 'att_1',
    taskId: 'tsk_1',
    missionId: 'mss_test',
    actorId: 'lead-1',
    sessionId: SESSION,
    leaseVersion: 1,
    leaseExpiresAt: NOW + 90_000,
    lastHeartbeatAt: NOW,
    status: 'running',
    operationIds: [],
    resultRefs: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    operationId: 'op_1',
    missionId: 'mss_test',
    taskId: 'tsk_1',
    attemptId: 'att_1',
    idempotencyKey: 'op-key-1',
    kind: 'external.submit',
    target: 'https://example.invalid/api',
    intent: '提交一次评分请求',
    status: 'executing',
    retryable: false,
    startedAt: NOW,
    ...overrides,
  }
}

/** 全绿探针，用例按需改成 false/null。 */
function probe(overrides: Partial<Record<keyof QuiescenceProbe, unknown>> = {}): QuiescenceProbe {
  const values: Record<string, unknown> = {
    stepRunning: false,
    managedToolsRunning: false,
    registerQueueFlushed: true,
    nativeSubagentsSettled: true,
    externalEffectsResolved: true,
    pendingInputPersisted: true,
    ...overrides,
  }
  return {
    stepRunning: () => values.stepRunning as boolean,
    managedToolsRunning: () => values.managedToolsRunning as boolean | null,
    registerQueueFlushed: () => values.registerQueueFlushed as boolean | null,
    nativeSubagentsSettled: () => values.nativeSubagentsSettled as boolean | null,
    externalEffectsResolved: () => values.externalEffectsResolved as boolean | null,
    pendingInputPersisted: () => values.pendingInputPersisted as boolean | null,
  }
}

function stateWith(overrides: Partial<MissionControl> = {}): MissionControl {
  return { ...freshState(), ...overrides }
}

function rotation(overrides: Partial<Rotation> = {}): Rotation {
  return {
    rotationId: 'rot_1',
    missionId: 'mss_test',
    actorId: 'lead-1',
    sourceSessionId: SESSION,
    targetSessionId: 'sess-2',
    targetMessageId: 'msg_seed',
    phase: 'REQUESTED',
    bindingVersionBefore: 1,
    bindingVersionAfter: 2,
    checkpointId: 'ckp_1',
    trigger: 'manual',
    // §23.2 第 1 条：REQUESTED 当场冻结依据/规则版本，放行 S2 前按这两个数重验交接包。
    basisRevisionAtRequest: 0,
    policyRevisionAtRequest: 1,
    phases: ['REQUESTED'],
    startedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

test('七条核对全绿才算安全', () => {
  const verdict = safeToHandoff(stateWith(), lead(), probe())
  assert.deepEqual(verdict, { ready: true, missing: [], pending: false })
})

test('没有会话绑定不是"等待边界"，而是直接不安全', () => {
  const verdict = safeToHandoff(stateWith(), lead({ sessionId: undefined }), probe())
  assert.equal(verdict.ready, false)
  assert.deepEqual(verdict.missing, ['actor 无当前会话绑定'])
  assert.equal(verdict.pending, false, '无绑定没有可等的边界')
})

test('四个前置型探针返回 null 按未满足处理；受管工具探针只在 true 时拦', () => {
  const prerequisite: readonly (keyof QuiescenceProbe)[] = ['registerQueueFlushed', 'nativeSubagentsSettled', 'externalEffectsResolved', 'pendingInputPersisted']
  for (const key of prerequisite) {
    const verdict = safeToHandoff(stateWith(), lead(), probe({ [key]: null }))
    assert.equal(verdict.ready, false, key)
    assert.equal(verdict.pending, true, `${key} 判不出 ⇒ 排队等边界，不放弃轮换`)
    assert.ok(verdict.missing.length > 0)
  }
  assert.equal(safeToHandoff(stateWith(), lead(), probe({ managedToolsRunning: null })).ready, true, '本部署没有这个观测面时不拦：在跑与否由 stepRunning 把关')
  assert.equal(safeToHandoff(stateWith(), lead(), probe({ managedToolsRunning: true })).ready, false, '真看到未收束的工具调用必须拦下')
})

test('逐项点名缺哪条，便于人直接对着修', () => {
  const busy = safeToHandoff(stateWith(), lead(), probe({ stepRunning: true }))
  assert.deepEqual(busy.missing, ['正在执行模型步骤'])
  const tools = safeToHandoff(stateWith(), lead(), probe({ managedToolsRunning: true }))
  assert.deepEqual(tools.missing, ['受管工具仍在执行'])
  const both = safeToHandoff(stateWith(), lead(), probe({ stepRunning: true, pendingInputPersisted: false }))
  assert.deepEqual(both.missing, ['正在执行模型步骤', '待处理用户输入未持久化'])
})

test('在跑 Attempt 没有检查点就不许交接，已收束的不算', () => {
  const noCheckpoint = safeToHandoff(stateWith({ attempts: { att_1: attempt() } }), lead(), probe())
  assert.ok(noCheckpoint.missing.includes('无有效检查点'))
  const withCheckpoint = safeToHandoff(stateWith({ attempts: { att_1: attempt({ checkpointId: 'ckp_1' }) } }), lead(), probe())
  assert.equal(withCheckpoint.ready, true)
  const mixed = safeToHandoff(
    stateWith({ attempts: { att_1: attempt({ checkpointId: 'ckp_1' }), att_2: attempt({ attemptId: 'att_2' }) } }),
    lead(),
    probe(),
  )
  assert.equal(mixed.ready, true, '只要有一个在跑 Attempt 带检查点就够，缺检查点的那个不阻塞')
  const settled = safeToHandoff(stateWith({ attempts: { att_1: attempt({ status: 'settled' }) } }), lead(), probe())
  assert.equal(settled.ready, true, '终态 Attempt 不参与核对')
})

test('结果不确定的外部操作按数量报出', () => {
  const state = stateWith({
    attempts: { att_1: attempt({ checkpointId: 'ckp_1' }) },
    operations: {
      op_1: operation({ status: 'outcome_unknown' }),
      op_2: operation({ operationId: 'op_2', status: 'outcome_unknown' }),
      op_3: operation({ operationId: 'op_3', status: 'succeeded' }),
    },
  })
  const verdict = safeToHandoff(state, lead(), probe())
  assert.deepEqual(verdict.missing, ['2 项外部操作结果不确定'])
  const otherAttempt = stateWith({
    attempts: { att_1: attempt({ checkpointId: 'ckp_1' }) },
    operations: { op_1: operation({ attemptId: 'att_other', status: 'outcome_unknown' }) },
  })
  assert.equal(safeToHandoff(otherAttempt, lead(), probe()).ready, true, '不属于本人 Attempt 的操作不拦本次交接')
})

test('阶段后继：正常单向前进，任一阶段可转 WAITING_RECOVERY，恢复态可回到提交点后阶段', () => {
  assert.deepEqual(legalSuccessors('REQUESTED'), ['QUIESCING', 'WAITING_RECOVERY'])
  assert.deepEqual(legalSuccessors('QUIESCING'), ['PREPARED', 'WAITING_RECOVERY'])
  assert.deepEqual(legalSuccessors('TARGET_READY'), ['COMMITTED', 'WAITING_RECOVERY'])
  assert.deepEqual(legalSuccessors('ACTIVATING'), ['ACTIVE', 'WAITING_RECOVERY'])
  assert.deepEqual(legalSuccessors('ACTIVE'), ['WAITING_RECOVERY'], '终态之后只允许故障恢复登记')
  assert.deepEqual(legalSuccessors('WAITING_RECOVERY'), ['QUIESCING', 'COMMITTED', 'ACTIVATING', 'ACTIVE'])
  assert.deepEqual(PHASES, ['REQUESTED', 'QUIESCING', 'PREPARED', 'TARGET_READY', 'COMMITTED', 'ACTIVATING', 'ACTIVE'])
})

test('提交点之后不退回源会话', () => {
  assert.equal(pastCommit(rotation({ phases: ['REQUESTED', 'QUIESCING'] })), false)
  assert.equal(shouldKeepSource(rotation({ phases: ['REQUESTED', 'QUIESCING'] })), true)
  const committed = rotation({ phase: 'ACTIVATING', phases: ['REQUESTED', 'QUIESCING', 'PREPARED', 'TARGET_READY', 'COMMITTED', 'ACTIVATING'] })
  assert.equal(pastCommit(committed), true)
  assert.equal(shouldKeepSource(committed), false, '执行权已交给 S2，退回源会话等于两个执行者')
})

test('PREPARED 事实核对：缺字段就停在 QUIESCING', () => {
  const hollow = { ...rotation(), checkpointId: undefined, targetSessionId: undefined, targetMessageId: undefined } as unknown as Rotation
  assert.deepEqual(missingPhaseFacts(hollow, 'PREPARED'), ['checkpointId', 'targetSessionId', 'targetMessageId'])
  assert.deepEqual(missingPhaseFacts(rotation({ phase: 'QUIESCING' }), 'QUIESCING'), [])
  assert.deepEqual(missingPhaseFacts(rotation({ phase: 'QUIESCING', phases: [] }), 'QUIESCING'), ['phases'], '空数组算缺项：阶段轨迹为空说明这条记录不可信')
})

test('软停闸门：人类提示优先，闸门只在没有人类输入时挡模型步', () => {
  assert.deepEqual(decidePreStep({ stopRequested: false, messages: [] }), { reject: false, humanPrompt: false, reason: 'latch-clear' })
  assert.deepEqual(decidePreStep({ stopRequested: true, messages: [{ source: { kind: 'user' } }] }), { reject: false, humanPrompt: true, reason: 'human-prompt' })
  assert.deepEqual(decidePreStep({ stopRequested: true, messages: [{ source: { kind: 'goal' } }] }), { reject: true, humanPrompt: false, reason: 'latch-held' })
  assert.deepEqual(decidePreStep({ stopRequested: true, messages: [{ source: { kind: 'goal' } }, { source: { kind: 'user' } }] }), { reject: false, humanPrompt: true, reason: 'human-prompt' })
  assert.equal(isHumanPrompt({}), false, '没有 source 一律不算人类输入')
})

test('闩：按键持有与释放，释放后闸门立刻放行', () => {
  const latch = new StopLatch()
  latch.hold('sess-1')
  latch.hold('sess-2')
  assert.equal(latch.isHeld('sess-1'), true)
  assert.deepEqual(latch.heldKeys().sort(), ['sess-1', 'sess-2'])
  latch.release('sess-1')
  assert.equal(latch.isHeld('sess-1'), false)
  assert.equal(latch.size, 1)
  latch.clear()
  assert.equal(latch.size, 0)
})

function waitOptions(overrides: Partial<BoundaryWaitOptions> = {}): BoundaryWaitOptions {
  return { slowAfterMs: 5_000, deadlineMs: 60_000, isCancelled: () => false, onSlow: () => {}, tickMs: 1, ...overrides }
}

/**
 * 轮询用的定时器是 `unref()` 的（闩等待不该拖住宿主退出），
 * 所以用例必须自己留一根 ref 定时器，否则事件循环提前空掉、Promise 永远不 resume。
 */
async function withKeepAlive<T>(run: () => Promise<T>): Promise<T> {
  const keep = setInterval(() => {}, 5)
  try {
    return await run()
  } finally {
    clearInterval(keep)
  }
}

test('边界等待：空闲与失败轮都算边界到达', async () => {
  assert.equal(await waitForBoundary({ whenIdle: async () => {} }, waitOptions()), 'boundary')
  assert.equal(
    await waitForBoundary({
      whenIdle: async () => {
        throw new Error('会话被销毁')
      },
    }, waitOptions()),
    'boundary',
    'whenIdle 失败说明没有后续工作，同样按边界处理',
  )
})

test('边界等待：isCancelled 与 signal 都立刻中止，超时按 deadline 放弃', async () => {
  const neverIdle = { whenIdle: () => new Promise<void>(() => {}) }
  await withKeepAlive(async () => {
    assert.equal(await waitForBoundary(neverIdle, waitOptions({ isCancelled: () => true })), 'cancelled')

    const preAborted = new AbortController()
    preAborted.abort()
    assert.equal(await waitForBoundary(neverIdle, waitOptions({ signal: preAborted.signal })), 'cancelled')

    const controller = new AbortController()
    const aborted = waitForBoundary(neverIdle, waitOptions({ signal: controller.signal }))
    setTimeout(() => controller.abort(), 5)
    assert.equal(await aborted, 'cancelled')

    let clock = 0
    const outcome = await waitForBoundary(neverIdle, waitOptions({ deadlineMs: 10, slowAfterMs: 6, tickMs: 1, now: () => (clock += 6) }))
    assert.equal(outcome, 'deadline', '过了后停就放弃，不无限期扣住会话')
  })
})

test('慢回报只报一次，之后继续等', async () => {
  const reports: number[] = []
  let clock = 0
  let calls = 0
  const outcome = await withKeepAlive(() =>
    waitForBoundary(
      { whenIdle: () => new Promise<void>(() => {}) },
      waitOptions({
        slowAfterMs: 2,
        deadlineMs: 1_000_000,
        tickMs: 1,
        now: () => {
          calls += 1
          clock += 1
          return clock
        },
        onSlow: (elapsed) => reports.push(elapsed),
        isCancelled: () => calls > 8,
      }),
    ),
  )
  assert.equal(outcome, 'cancelled')
  assert.equal(reports.length, 1, `慢回报应当只发一次，实际 ${reports.join(',')} 次`)
  assert.equal(reports[0], 2)
})

test('会话可见性有界等待：不无限轮询', async () => {
  const seen = new Set<string>()
  const outcome = await withKeepAlive(async () => {
    const missing = await waitForSession('s1', (id) => seen.has(id), 2, 1)
    let calls = 0
    const found = await waitForSession(
      's1',
      () => {
        calls += 1
        return calls >= 3
      },
      10,
      1,
    )
    return { missing, found, calls }
  })
  assert.equal(outcome.missing, false, '等不到就如实报等不到')
  assert.equal(outcome.found, true)
  assert.equal(outcome.calls, 3)
})
