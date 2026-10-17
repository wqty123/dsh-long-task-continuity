/**
 * 生效审计（0.2.4）F4 的判据：复核缺口不能被反例消掉。
 *
 * 审计方用真实 `dispatch(review.record)` 证明了旧判据的漏洞：
 * ① 任务执行者自己审查该任务（`versusHistory=conflict`）；
 * ② reviewer 审查一个无关旧 claim。
 * 两条都能让"缺少独立复核"与"缺少整体审核"的缺口消失。这里把这两个反例钉住。
 *
 * 构造用最小手工记录（字段超出判据用到的部分不参与断言），目标是让 `missionCompletion`
 * 在**只有反例**的输入下仍然报缺口。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { missionCompletion } from '../src/core/completion.ts'
import type { MissionControl } from '../src/core/control.ts'
import type { Actor, Attempt, ReviewReceipt, Task } from '../src/core/entities.ts'
import { NOW, freshState } from './fixtures.ts'

const TASK_ID = 'tsk_delivered'

function deliveredState(): MissionControl {
  const base = freshState()
  const task = {
    taskId: TASK_ID, missionId: 'mss_test', dependsOn: [], title: '已交付任务', scope: '范围',
    exclusions: [], inputRefs: [], criteria: [], priority: 5, status: 'completed', validity: 'current',
    objectiveRevision: 1, specRevision: 1, criteriaRevision: 1, criteriaCheck: 'consistent',
    resourceKeys: [], maxAttempts: 3, attemptCount: 1, createdAt: NOW, updatedAt: NOW,
  } as unknown as Task
  const attempt = {
    attemptId: 'att_1', taskId: TASK_ID, missionId: 'mss_test', actorId: 'member-a',
    leaseVersion: 1, leaseExpiresAt: NOW, lastHeartbeatAt: NOW, status: 'settled',
    operationIds: [], resultRefs: [], createdAt: NOW, updatedAt: NOW,
  } as unknown as Attempt
  const reviewer = {
    actorId: 'reviewer-1', missionId: 'mss_test', role: 'reviewer', label: '审查者',
    bindingVersion: 1, available: true, dormant: false, retired: false,
    rotationsLastHour: [], createdAt: NOW, updatedAt: NOW,
  } as unknown as Actor
  return {
    ...base,
    tasks: { [TASK_ID]: task },
    attempts: { att_1: attempt },
    actors: { ...base.actors, 'member-a': { ...reviewer, actorId: 'member-a', role: 'member', label: '执行者' } as Actor, 'reviewer-1': reviewer },
    reviews: {},
  } as MissionControl
}

function review(overrides: Partial<ReviewReceipt>): ReviewReceipt {
  return {
    reviewId: 'rev_x', missionId: 'mss_test', targetKind: 'task', targetId: TASK_ID,
    selfConsistent: 'pass', versusHistory: 'consistent', sharedEvidenceIds: [],
    sawReferenceAnswer: false, independenceNote: '夹具', reviewerActorId: 'reviewer-1',
    methodRef: '夹具', reviewedAt: NOW + 10,
    ...overrides,
  } as ReviewReceipt
}

test('F4 反例①：执行者自审不能消掉「没有独立复核」', () => {
  const state = deliveredState()
  const selfReviewed = { ...state, reviews: { rev_self: review({ reviewerActorId: 'member-a', versusHistory: 'conflict' }) } } as MissionControl
  const report = missionCompletion(selfReviewed)
  assert.ok(
    report.missing.some((m) => m.includes('没有独立复核')),
    '执行者自己的审查不算独立复核，缺口必须还在',
  )
})

test('F4 正例：另一名成员的审查可以消掉该缺口', () => {
  const state = deliveredState()
  const peerReviewed = { ...state, reviews: { rev_peer: review({}) } } as MissionControl
  const report = missionCompletion(peerReviewed)
  assert.ok(
    !report.missing.some((m) => m.includes('没有独立复核')),
    '独立的另一成员审查应满足 R4',
  )
})

test('F4 反例③：任务改版之后，旧审查自动失效（定向失效）', () => {
  const state = deliveredState()
  // 审查发生在 NOW+10；把任务 updatedAt 推到 NOW+20，等于交付之后又改过。
  const task = state.tasks[TASK_ID] as unknown as { updatedAt: number }
  const bumped = {
    ...state,
    tasks: { ...state.tasks, [TASK_ID]: { ...state.tasks[TASK_ID], updatedAt: NOW + 20 } },
  } as MissionControl
  const report = missionCompletion(bumped)
  assert.ok(task.updatedAt === NOW, '夹具前提：原任务 updatedAt 是 NOW')
  assert.ok(
    report.missing.some((m) => m.includes('没有独立复核')),
    '任务改版后旧审查只证明旧版本，缺口必须回来',
  )
})

test('F4 反例②：晚于交付之前的 reviewer 记录不能顶替本次整体审核', () => {
  const state = deliveredState()
  // 任务 updatedAt = NOW；把 reviewer 审查放在 NOW-1，即"交付之前审的旧东西"
  const stale = { ...state, reviews: { rev_old: review({ reviewedAt: NOW - 1 }) } } as MissionControl
  const report = missionCompletion(stale)
  assert.ok(
    report.missing.some((m) => m.includes('最后一次交付之后')),
    '交付前的旧审查不能顶替本次整体审核',
  )
})
