/**
 * 压力迟滞与轮换入场判定（设计稿 v0.2 §10.2、§10.3）。
 *
 * 自动换会话最怕两件事：读数抖动导致反复触发，以及在不安静的边界上硬切。
 * 这里把"边沿触发 + 迟滞回差 + 冷却 + 遮蔽 + 判定顺序"逐条钉住。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Occupancy, RotationLine } from '../src/rotation/lines.ts'
import { readOccupancy, rotationLine } from '../src/rotation/lines.ts'
import type { GuardConfig, GuardState, RotationGateInput } from '../src/rotation/policy.ts'
import { DEFAULT_GUARD_CONFIG, SessionWatermark, AWAIT_BRIEF_RECOMPUTE, decideRotation, inCooldown, initialGuardState, nextTurn, reduceGuard, resetArming, targetTooLarge } from '../src/rotation/policy.ts'

const WINDOW = 500_000

function occ(ratio: number): Occupancy {
  return readOccupancy({ projectedTokens: Math.round(ratio * WINDOW), contextWindow: WINDOW, pressureTokens: Math.round(ratio * WINDOW) })
}

/** 口径齐全、可判定的活动线：C=400000、T=300000（占比 0.6）。 */
const FULLISH = { contextWindow: WINDOW, outputReserve: 40_000, compactionRatio: 0.8, compactionHeadroom: 20_000, handoffMargin: 8_192, rotateRatio: 0.6 }

const ACTIVE: RotationLine = rotationLine(FULLISH)

function gate(overrides: Partial<RotationGateInput> = {}): RotationGateInput {
  return {
    occupancy: occ(0.62),
    line: ACTIVE,
    guard: initialGuardState(),
    actorRetired: false,
    pendingRotation: false,
    rotationBudgetLeft: true,
    turnsSinceLastRotation: 10,
    minTurnsBetweenRotations: 3,
    autoRotationEnabled: true,
    atSafeBoundary: true,
    config: DEFAULT_GUARD_CONFIG,
    ...overrides,
  }
}

test('读数不可得：状态机原地不动，也不清既有档位', () => {
  const armed: GuardState = { level: 'hard', armed: true, turn: 4, cooldown: 2, compactionDrop: false, occupancy: occ(0.7) }
  const { state, signal } = reduceGuard(armed, readOccupancy(null))
  assert.equal(signal, null)
  assert.equal(state.level, 'hard', '一次投影缺席不能把已确认的压力抹掉')
  assert.equal(state.armed, true)
  assert.deepEqual(state.occupancy, armed.occupancy)
})

test('跨档只出声一次：边沿触发、升档再出声', () => {
  const first = reduceGuard(initialGuardState(), occ(0.5))
  assert.equal(first.signal?.kind, 'enter')
  assert.equal(first.signal?.level, 'warn')
  assert.equal(first.state.armed, true)
  assert.equal(first.state.level, 'warn')
  assert.equal(first.state.cooldown, DEFAULT_GUARD_CONFIG.cooldownTurns)

  const same = reduceGuard(first.state, occ(0.55))
  assert.equal(same.signal, null, '同档重复不重复提示')
  assert.equal(same.state.level, 'warn')

  const up = reduceGuard(same.state, occ(0.62))
  assert.equal(up.signal?.kind, 'escalate')
  assert.equal(up.signal?.level, 'hard')
  assert.equal(up.state.level, 'hard')

  const flat = reduceGuard(up.state, occ(0.9))
  assert.equal(flat.signal, null)
  assert.equal(flat.state.level, 'hard', '已经是最高档，不再制造噪音')
})

test('迟滞回差：跌回 warn−hysteresis 以下才重新武装', () => {
  const hard: GuardState = { level: 'hard', armed: true, turn: 9, cooldown: 0, compactionDrop: false, occupancy: occ(0.7) }
  const inBand = reduceGuard(hard, occ(0.42))
  assert.equal(inBand.signal, null)
  assert.equal(inBand.state.level, 'hard', '还在迟滞带里就不降档，否则读数抖动会来回切')
  assert.equal(inBand.state.compactionDrop, false)

  const dropped = reduceGuard(hard, occ(0.3))
  assert.equal(dropped.state.level, 'none')
  assert.equal(dropped.state.armed, false)
  assert.equal(dropped.state.compactionDrop, true, '从高档掉下来要立旗，供压缩遮蔽判定')

  const again = reduceGuard(dropped.state, occ(0.62))
  assert.equal(again.signal?.kind, 'enter', '重新武装后再次跨档才允许新一次提示')
  assert.equal(again.signal?.level, 'hard')
})

test('compaction 遮蔽：轮末刚压缩完不提示，但档位与武装照常推进', () => {
  const suppressed = reduceGuard(initialGuardState(), occ(0.7), { atTurnBoundary: true, justCompacted: true })
  assert.equal(suppressed.signal, null)
  assert.equal(suppressed.state.armed, true)
  assert.equal(suppressed.state.level, 'hard')

  const later = reduceGuard(suppressed.state, occ(0.8), { atTurnBoundary: true, justCompacted: false })
  assert.equal(later.signal, null, '已经武装过就不补发被遮蔽的那次提示')

  const ignoresFlag = reduceGuard(initialGuardState(), occ(0.7), {
    config: { ...DEFAULT_GUARD_CONFIG, respectCompaction: false },
    atTurnBoundary: true,
    justCompacted: true,
  })
  assert.equal(ignoresFlag.signal?.kind, 'enter', '关掉尊重压缩开关后必须照常提示')
})

test('轮末推进：冷却递减、临时旗标清除，重置武装清空迟滞', () => {
  const armed = reduceGuard(initialGuardState(), occ(0.7)).state
  assert.equal(armed.cooldown, 5)
  assert.equal(inCooldown(armed), true)
  const after = nextTurn(armed)
  assert.equal(after.turn, 1)
  assert.equal(after.cooldown, 4)
  assert.equal(after.compactionDrop, false)
  let cursor: GuardState = armed
  for (let i = 0; i < 5; i += 1) cursor = nextTurn(cursor)
  assert.equal(cursor.cooldown, 0)
  assert.equal(inCooldown(cursor), false)

  const reset = resetArming(after)
  assert.deepEqual({ level: reset.level, armed: reset.armed, cooldown: reset.cooldown }, { level: 'none', armed: false, cooldown: 0 }, '换模型即换窗口，旧迟滞没有意义')
  assert.equal(reset.turn, after.turn, '轮次要继续累计')
})

test('夹到 100% 的异常读数仍然按 hard 处理', () => {
  const stale = readOccupancy({ projectedTokens: 900_000, contextWindow: WINDOW })
  assert.equal(stale.clampMismatch, true)
  const { signal } = reduceGuard(initialGuardState(), stale)
  assert.equal(signal?.level, 'hard')
  assert.equal(signal?.ratio, 1)
})

test('水位：同一日志位置不重复评估', () => {
  const marks = new SessionWatermark()
  assert.equal(marks.observe('s1', 0), true)
  assert.equal(marks.observe('s1', 0), false, '重复事件不评估第二次')
  assert.equal(marks.observe('s1', 3), true)
  assert.equal(marks.observe('s1', 2), false, '回退的位置忽略')
  assert.equal(marks.watermark('s1'), 3)
  assert.equal(marks.watermark('s2'), -1)
  assert.equal(marks.observe('s2', 5), true)
  assert.equal(marks.size, 2)
  marks.reset('s1')
  assert.equal(marks.watermark('s1'), -1)
  marks.clear()
  assert.equal(marks.size, 0)
})

test('入场判定顺序：退役、无读数、未启用、线不可用先于一切业务判断', () => {
  assert.deepEqual(decideRotation(gate({ actorRetired: true })), { kind: 'none', reason: 'actor-retired' })
  assert.deepEqual(decideRotation(gate({ occupancy: readOccupancy(null) })), { kind: 'observe', reason: 'reading-unavailable' })
  assert.deepEqual(decideRotation(gate({ autoRotationEnabled: false })), { kind: 'none', reason: 'auto-rotation-disabled' })

  const observation = rotationLine({ contextWindow: null })
  assert.equal(decideRotation(gate({ line: observation })).reason, 'rotation-line-observation:contextWindow 不可得或不为正')
  const disabled = rotationLine({ ...FULLISH, handoffMargin: 400_000 })
  assert.equal(disabled.mode, 'disabled')
  assert.match(decideRotation(gate({ line: disabled })).reason ?? '', /^rotation-line-disabled:/)
})

test('入场判定顺序：在飞轮换与频率保险先于迟滞与冷却', () => {
  assert.deepEqual(decideRotation(gate({ pendingRotation: true })), { kind: 'none', reason: 'rotation-in-flight' })
  assert.deepEqual(decideRotation(gate({ rotationBudgetLeft: false })), { kind: 'none', reason: 'rotation-insurance-exhausted' })
  assert.deepEqual(decideRotation(gate({ turnsSinceLastRotation: 1, minTurnsBetweenRotations: 3 })), { kind: 'none', reason: 'cooldown-1/3' })
})

test('入场判定：未达阈值不给换，达到但边界不安全即排队', () => {
  const below = decideRotation(gate({ occupancy: occ(0.5) }))
  assert.equal(below.kind, 'none')
  assert.match(below.reason, /^below-threshold-50\.0%$/)

  const unsafe = decideRotation(gate({ occupancy: occ(0.62), atSafeBoundary: false }))
  assert.deepEqual(unsafe, { kind: 'none', reason: 'pending-until-boundary' })

  assert.deepEqual(decideRotation(gate()), { kind: 'rotate', reason: 'pressure-boundary' })
})

test('入场判定：绝对线更晚时迟滞先到也能触发', () => {
  // p=0.8 的合法口径把 T 抬到 C−M=391808（占比 0.78），此时 0.62 还没过绝对线，但已过 hardRatio。
  const late: RotationLine = rotationLine({ ...FULLISH, rotateRatio: 0.8 })
  assert.equal(late.mode, 'active')
  if (late.mode !== 'active') return
  assert.equal(late.T, 391_808)
  const decision = decideRotation(gate({ line: late, occupancy: occ(0.62) }))
  assert.deepEqual(decision, { kind: 'rotate', reason: 'pressure-boundary' })

  const notEvenGuardDue = decideRotation(gate({ line: late, occupancy: occ(0.5) }))
  assert.equal(notEvenGuardDue.kind, 'none')
})

test('新会话入场体积过大判为配置问题', () => {
  assert.equal(targetTooLarge(occ(0.4), ACTIVE), true, '0.4×W=200000 ≥ T/2=150000')
  assert.equal(targetTooLarge(occ(0.2), ACTIVE), false)
  assert.equal(targetTooLarge(occ(0.9), rotationLine({ contextWindow: null })), false, '观察模式不做该判定')
  assert.equal(targetTooLarge(readOccupancy(null), ACTIVE), false)
})

// —— §G1：原生 Team Lead 的自动轮换受限 ——

test('G1：其他条件全部满足时应换会话，但 leadProtected 时只观测并给出受限原因', () => {
  const decision = decideRotation(gate({ leadProtected: true }))
  assert.equal(decision.kind, 'observe', '这是"拦截/观测"，不是"不需要换"')
  assert.match(decision.reason, /^lead-rotation-restricted:/)
  assert.equal(decision.reason, 'lead-rotation-restricted: 原生 Team Lead 的自动轮换在身份迁移协议经真机验证前受限，优先原会话压缩（§G1）')
})

test('G1：leadProtected 缺省或 false 与既有行为逐字节一致', () => {
  assert.deepEqual(decideRotation(gate()), { kind: 'rotate', reason: 'pressure-boundary' })
  assert.deepEqual(decideRotation(gate({ leadProtected: false })), decideRotation(gate()), 'false 与缺省必须完全同路')
  assert.deepEqual(
    decideRotation(gate({ occupancy: occ(0.5), leadProtected: false })),
    decideRotation(gate({ occupancy: occ(0.5) })),
  )
})

test('G1：优先级更高的既有原因仍然先于 leadProtected 返回', () => {
  assert.deepEqual(decideRotation(gate({ pendingRotation: true, leadProtected: true })), { kind: 'none', reason: 'rotation-in-flight' })
  assert.deepEqual(decideRotation(gate({ awaitingBriefRecompute: true, leadProtected: true })), { kind: 'observe', reason: AWAIT_BRIEF_RECOMPUTE })
  assert.deepEqual(decideRotation(gate({ actorRetired: true, leadProtected: true })), { kind: 'none', reason: 'actor-retired' })
})
