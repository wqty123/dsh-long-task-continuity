/**
 * 执行权与预算（设计稿 v0.3 §6.2、§13、§15.1、§22.15）。
 *
 * 这两件事在第二个月的典型故障里最贵：租约判错 ⇒ 两个执行者同时写同一个任务；
 * 预算算错 ⇒ 要么超支继续跑，要么把已经花掉的钱当成没花。因此这里逐条钉住判定表。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Actor, Attempt, BudgetLedger, BudgetLimits } from '../src/core/entities.ts'
import { DEFAULT_BUDGET_LIMITS, LEASE_EXPIRY_MS } from '../src/core/entities.ts'
import { acceptsStateWrite, findCycle, heartbeat, leaseVerdict, openLease } from '../src/core/lease.ts'
import { dependenciesSatisfied } from '../src/core/lease.ts'
import type { Task } from '../src/core/entities.ts'
import { freshState, NOW } from './fixtures.ts'
import { availability, canReserve, canRotate, consumedTokens, hasProgress, noteRotation, recentRotations, releaseReservation, reserve, reservedTokens, settle } from '../src/core/budget.ts'

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    attemptId: 'att_1',
    taskId: 'tsk_1',
    missionId: 'mss_test',
    actorId: 'lead-1',
    sessionId: 'sess-1',
    leaseVersion: 3,
    leaseExpiresAt: NOW + LEASE_EXPIRY_MS,
    lastHeartbeatAt: NOW,
    status: 'running',
    operationIds: [],
    resultRefs: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    actorId: 'lead-1',
    missionId: 'mss_test',
    role: 'lead',
    label: 'Lead',
    sessionId: 'sess-1',
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

function ledger(overrides: Partial<BudgetLedger> = {}): BudgetLedger {
  return {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    wallClockMs: 0,
    taskRetries: 0,
    rotations: 0,
    mailboxMessages: 0,
    // §22.15 DG-15：治理开销单列但必填——没有"0"就分不清"没治理"与"没记账"。
    governanceCalls: 0,
    governanceTokens: 0,
    governanceWallClockMs: 0,
    reservations: [],
    ...overrides,
  }
}

function limits(overrides: Partial<BudgetLimits> = {}): BudgetLimits {
  return { ...DEFAULT_BUDGET_LIMITS, ...overrides }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'tsk_1',
    missionId: 'mss_test',
    dependsOn: [],
    title: '任务',
    scope: '',
    exclusions: [],
    inputRefs: [],
    criteria: [],
    priority: 5,
    status: 'ready',
    // §6.1：validity 与业务状态分列；§5.1 的 spec/criteria 修订号与派单前互斥检查都由内核盖。
    validity: 'current',
    objectiveRevision: 1,
    specRevision: 1,
    criteriaRevision: 1,
    criteriaCheck: 'consistent',
    resourceKeys: [],
    maxAttempts: 3,
    attemptCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

test('租约判定表：版本不符即视为迟到，过期只触发核对', () => {
  assert.equal(leaseVerdict(attempt(), 3, NOW), 'valid')
  assert.equal(leaseVerdict(attempt(), 2, NOW), 'superseded', '旧持有者的版本号')
  assert.equal(leaseVerdict(attempt(), 4, NOW), 'superseded', '版本号只认相等：更大同样不是当前持有者')
  assert.equal(leaseVerdict(attempt(), 3, NOW + LEASE_EXPIRY_MS + 1), 'expired_needs_reconcile')
  assert.equal(leaseVerdict(attempt({ status: 'settled' }), 3, NOW), 'terminal', '已收束的 Attempt 排在水位线之前判')
  assert.equal(acceptsStateWrite(attempt(), 3, NOW), true)
  assert.equal(acceptsStateWrite(attempt(), 3, NOW + LEASE_EXPIRY_MS + 1), false, '过期后不许再写状态')
})

test('续租把到期时刻顺延，但不改版本号', () => {
  const opened = openLease(attempt({ status: 'recovering', leaseExpiresAt: NOW - 1 }), NOW)
  assert.equal(opened.status, 'running')
  assert.equal(opened.leaseExpiresAt, NOW + LEASE_EXPIRY_MS)
  const beaten = heartbeat(opened, NOW + 10_000)
  assert.equal(beaten.leaseExpiresAt, NOW + 10_000 + LEASE_EXPIRY_MS)
  assert.equal(beaten.lastHeartbeatAt, NOW + 10_000)
  assert.equal(beaten.leaseVersion, 3, '续租不换主人：版本号必须由转移/接管才递增')
})

test('依赖要"验收完成且当前有效"才算满足', () => {
  // §6.2：submitted/verifying 还没验收；completed 但 validity 非 current 是依据被撤回后的
  // 历史完成——事件保留，但不再支撑下游执行资格。claim/evidence 级依赖的失效传播在
  // discipline.invalidateDependents（把下游记录标成 invalid/needs_review），与此判定分列。
  const target = task({ dependsOn: ['tsk_a', 'tsk_b'] })
  const submitted = { ...task({ taskId: 'tsk_a' }), status: 'submitted' as const }
  const completed = { ...task({ taskId: 'tsk_b' }), status: 'completed' as const }
  assert.equal(dependenciesSatisfied(target, { tsk_a: submitted, tsk_b: completed }), false, 'submitted 还没验收，不算满足')
  assert.equal(dependenciesSatisfied(target, { tsk_a: { ...submitted, status: 'completed' }, tsk_b: completed }), true)
  assert.equal(dependenciesSatisfied(target, { tsk_a: { ...submitted, status: 'completed' }, tsk_b: { ...completed, validity: 'invalid' as const } }), false, '依赖已完成但结果已被判无效，不满足')
  assert.equal(dependenciesSatisfied(target, { tsk_a: { ...submitted, status: 'completed' }, tsk_b: { ...completed, validity: 'needs_review' as const } }), false, '待复核的依据也不能继续支撑下游')
  assert.equal(dependenciesSatisfied(target, { tsk_b: completed }), false, '依赖记录缺失一律不满足')
})

test('建任务时挡住依赖环', () => {
  const tasks = [
    task({ taskId: 'tsk_a', dependsOn: ['tsk_b'] }),
    task({ taskId: 'tsk_b', dependsOn: ['tsk_c'] }),
    task({ taskId: 'tsk_c', dependsOn: [] }),
    task({ taskId: 'tsk_free', dependsOn: [] }),
  ]
  assert.deepEqual(findCycle(tasks, task({ taskId: 'tsk_d', dependsOn: ['tsk_a'] })), [], '接到链尾不构成环')
  assert.deepEqual(findCycle(tasks, task({ taskId: 'tsk_a', dependsOn: ['tsk_c'] })), [], 'a 依赖已在链上的 c，但 c 不依赖 a')
  const selfLoop = findCycle(tasks, task({ taskId: 'tsk_a', dependsOn: ['tsk_a'] }))
  assert.ok(selfLoop.length > 0, '自依赖必须报环')
  assert.equal(selfLoop[0], 'tsk_a')
  assert.equal(selfLoop.at(-1), 'tsk_a', '环路径要首尾同点，日志里才看得清')
  const cyclic = [
    task({ taskId: 'tsk_a', dependsOn: ['tsk_b'] }),
    task({ taskId: 'tsk_b', dependsOn: ['tsk_c'] }),
    task({ taskId: 'tsk_c', dependsOn: ['tsk_a'] }),
  ]
  const transitive = findCycle(cyclic, task({ taskId: 'tsk_a', dependsOn: ['tsk_b'] }))
  assert.ok(transitive.length > 0, 'a→b→c→a 是环')
  assert.equal(transitive[0], 'tsk_a')
  assert.equal(transitive.at(-1), 'tsk_a')
})

test('预留占据可用额度：可用量随预留与消耗一起下降', () => {
  const state = freshState({
    budgetLimits: limits({ maxTotalTokens: 1_000, maxModelCalls: 2, maxTaskRetries: 0, maxMailboxMessages: 0 }),
    budget: ledger({ inputTokens: 300, outputTokens: 100, modelCalls: 1 }),
  })
  const before = availability(state)
  assert.equal(consumedTokens(state.budget), 400)
  assert.equal(before.tokensAvailable, 600)
  assert.equal(before.callsAvailable, 1)
  assert.deepEqual(before.blockedBy, ['retries', 'mailbox'], '重试与信箱额度用尽要单独点名，不能只报总量')

  const reserved = reserve(state.budget, state.budgetLimits, 'op_1', { tokens: 600, calls: 1 }, NOW)
  assert.equal(reserved.ok, true)
  if (!reserved.ok) return
  const after = availability({ ...state, budget: reserved.budget })
  assert.equal(reservedTokens(reserved.budget), 600)
  assert.equal(after.tokensAvailable, 0)
  assert.equal(after.callsAvailable, 0)
  assert.deepEqual(after.blockedBy, ['tokens', 'calls', 'retries', 'mailbox'])
  assert.equal(canReserve({ ...state, budget: reserved.budget }, { tokens: 1, calls: 0 }), false, '预留之后不许再预留')
  assert.equal(canReserve(state, { tokens: 600, calls: 1 }), true)
})

test('预留拒绝畸形数量并给出缺口', () => {
  const state = freshState({ budgetLimits: limits({ maxTotalTokens: 100, maxModelCalls: 1 }) })
  for (const want of [{ tokens: 1.5, calls: 0 }, { tokens: -1, calls: 0 }, { tokens: Number.MAX_SAFE_INTEGER, calls: 0 }]) {
    assert.equal(reserve(state.budget, state.budgetLimits, 'op_x', want, NOW).ok, false, `畸形数量 ${JSON.stringify(want)} 必须拒绝`)
  }
  const short = reserve(state.budget, state.budgetLimits, 'op_x', { tokens: 150, calls: 0 }, NOW)
  assert.equal(short.ok, false)
  if (short.ok) return
  assert.match(short.reason ?? '', /token pool short by 50/)
  const callShort = reserve(state.budget, state.budgetLimits, 'op_x', { tokens: 10, calls: 2 }, NOW)
  assert.equal(callShort.ok, false)
  if (callShort.ok) return
  assert.match(callShort.reason ?? '', /call pool short by 1/)
})

test('结算按回执入账并只摘掉本次预留', () => {
  let budget = ledger()
  const first = reserve(budget, limits({ maxTotalTokens: 1_000, maxModelCalls: 10 }), 'op_1', { tokens: 400, calls: 2 }, NOW)
  assert.equal(first.ok, true)
  if (!first.ok) return
  const second = reserve(first.budget, limits({ maxTotalTokens: 1_000, maxModelCalls: 10 }), 'op_2', { tokens: 200, calls: 1 }, NOW)
  assert.equal(second.ok, true)
  if (!second.ok) return
  budget = second.budget
  const settled = settle(budget, 'op_1', { inputTokens: 350, outputTokens: 20, cacheReadTokens: 30, calls: 2 })
  assert.equal(consumedTokens(settled), 400, '回执合计入账，预留同时消失')
  assert.equal(settled.modelCalls, 2)
  assert.equal(settled.reservations.length, 1, '另一笔在途预留不受影响')
  assert.equal(settled.reservations[0]?.operationId, 'op_2')
})

test('无回执时预留留在账上：只有核对确认未执行才释放', () => {
  const state = freshState({ budgetLimits: limits({ maxTotalTokens: 500, maxModelCalls: 5 }) })
  const reserved = reserve(state.budget, state.budgetLimits, 'op_1', { tokens: 500, calls: 1 }, NOW)
  assert.equal(reserved.ok, true)
  if (!reserved.ok) return
  assert.equal(releaseReservation(reserved.budget, 'op_1', false).reservations.length, 1, '回执不确定时退回额度就是允许重复消费')
  const released = releaseReservation(reserved.budget, 'op_1', true)
  assert.equal(released.reservations.length, 0)
  assert.equal(released.modelCalls, 0, '释放不等于结算：没发生的调用不入账')
})

test('轮换保险按每 Actor 每小时滚动计数', () => {
  const hourAgo = NOW - 60 * 60 * 1_000
  const seeded = actor({ rotationsLastHour: [hourAgo - 1, hourAgo + 1, NOW - 60_000, NOW - 30_000] })
  assert.equal(recentRotations(seeded, NOW).length, 3, '刚好落在窗口外的不再计入')
  assert.equal(canRotate(seeded, NOW, 3).ok, false)
  assert.equal(canRotate(seeded, NOW, 4).ok, true)
  assert.equal(canRotate(seeded, NOW + 30_000, 3).ok, true, '满一小时的那笔滑出窗口即放行：这是滚动窗口，不是一生计数')
  assert.equal(canRotate(seeded, NOW, 3).reason, 'rotation-insurance-exhausted')

  const retired = actor({ retired: true })
  assert.equal(canRotate(retired, NOW, 3).reason, 'actor-retired')
  assert.equal(canRotate(actor({ available: false }), NOW, 3).reason, 'actor-unavailable')

  const noted = noteRotation(actor({ rotationsLastHour: [hourAgo - 1, NOW - 1000] }), NOW)
  assert.deepEqual(noted.rotationsLastHour, [NOW - 1000, NOW], '登记时顺带剪掉窗口外的旧值，Actor 记录不会无限增长')
})

test('进展只认验收项、已解决阻塞与有据决策', () => {
  assert.equal(hasProgress({ completedCriteria: 0, resolvedBlockers: 0, evidencedDecisions: 0 }), false)
  assert.equal(hasProgress({ completedCriteria: 0, resolvedBlockers: 1, evidencedDecisions: 0 }), true)
  assert.equal(hasProgress({ completedCriteria: 0, resolvedBlockers: 0, evidencedDecisions: 1 }), true)
  assert.equal(hasProgress({ completedCriteria: 2, resolvedBlockers: 0, evidencedDecisions: 0 }), true)
})
