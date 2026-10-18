/**
 * 批审（`review.recordBatch`）的判据。
 *
 * 批审唯一新增的语义是"一次往返办多条"，所以判据只有两条：
 * 全部合格时整批写入；任一条不合格时**整批不写**——半批写入会让调用方
 * 以为整批成了，而缺的那几条恰恰是它最需要知道的。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { dispatch } from '../src/core/commands.ts'
import type { ReviewInput } from '../src/core/commands.ts'
import { NOW, ctx, freshState, req } from './fixtures.ts'

const SUP = ctx('supervisor', 'sup-1')

function reviewInput(targetId: string, overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    targetKind: 'task',
    targetId,
    purpose: 'delivery',
    selfConsistent: 'pass',
    versusHistory: 'consistent',
    sharedEvidenceIds: [],
    sawReferenceAnswer: false,
    independenceNote: '夹具：另一名成员复核',
    methodRef: '夹具',
    ...overrides,
  }
}

test('批审：全部合格时整批写入', () => {
  const state = freshState()
  const result = dispatch(state, {
    kind: 'review.recordBatch',
    requestId: req(),
    reviews: [reviewInput('tsk_a'), reviewInput('tsk_b'), reviewInput('tsk_c')],
  }, SUP)
  assert.equal(result.applied, true)
  if (!result.applied) return
  assert.equal(Object.keys(result.state.reviews).length, 3)
  // id 由 requestId + 序号派生，三条必须各不相同
  assert.equal(new Set(Object.values(result.state.reviews).map((item) => item.targetId)).size, 3)
})

test('批审：任一条缺少 targetId 时整批不写', () => {
  const state = freshState()
  const result = dispatch(state, {
    kind: 'review.recordBatch',
    requestId: req(),
    reviews: [reviewInput('tsk_a'), reviewInput('  '), reviewInput('tsk_c')],
  }, SUP)
  assert.equal(result.applied, false, '第 2 条不合法，整批都不能写')
  if (result.applied) return
  assert.equal(Object.keys(result.state.reviews).length, 0, '不得留下半批')
  assert.equal(result.state.revision, state.revision, '被拒时修订号不动')
})

test('批审：共用证据却未写独立性说明时整批不写', () => {
  const state = freshState()
  const result = dispatch(state, {
    kind: 'review.recordBatch',
    requestId: req(),
    reviews: [reviewInput('tsk_a'), reviewInput('tsk_b', { sawReferenceAnswer: true, independenceNote: '' })],
  }, SUP)
  assert.equal(result.applied, false)
  if (result.applied) return
  assert.equal(Object.keys(result.state.reviews).length, 0, '独立性口径与逐条登记一致')
})

test('批审：空列表不产生任何写入', () => {
  const state = freshState()
  const result = dispatch(state, { kind: 'review.recordBatch', requestId: req(), reviews: [] }, SUP)
  assert.equal(result.applied, false)
})
