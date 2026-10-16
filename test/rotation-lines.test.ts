/**
 * 轮换线口径（设计稿 v0.2 §10.1）。
 *
 * 这一层是整个自动换会话的地基：**取不到同口径的 W/R/H/r 就必须退回观察模式**，
 * 而不是猜一个窗口把 T 算成负数、制造连续换会话。所以判定的每一条 fail-closed 分支都要断言。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { WindowInput } from '../src/rotation/lines.ts'
import { DEFAULT_WINDOW, linesFor, readOccupancy, rotationLine } from '../src/rotation/lines.ts'

/** 本机默认口径下能算出正数的完整输入。 */
const FULL: WindowInput = {
  contextWindow: 500_000,
  outputReserve: 40_000,
  compactionRatio: 0.8,
  compactionHeadroom: 20_000,
  handoffMargin: 8_192,
  rotateRatio: 0.6,
}

function withInput(overrides: Partial<WindowInput>): WindowInput {
  return { ...FULL, ...overrides }
}

test('窗口折算：可用量、硬线、按比例判定线', () => {
  const { usable, hard, check } = linesFor(500_000, 40_000, 0.8)
  assert.equal(usable, 460_000)
  assert.equal(hard, 437_000)
  assert.equal(check, 368_000)
  assert.ok(check <= hard, '判定线永远不越过硬线')
})

test('窗口折算对畸形输入兜底', () => {
  assert.equal(linesFor(0, 40_000, 0.8).usable, DEFAULT_WINDOW - 40_000, '窗口不可得时退回默认窗口，不返回 0')
  assert.equal(linesFor(-1, 0, 0.8).usable, DEFAULT_WINDOW)
  assert.equal(linesFor(100_000, 90_000, 0.8).usable, 50_000, '预留吃掉的量封顶在一半窗口，否则判定线贴地')
  assert.equal(linesFor(100_000, 10_000, 1.5).check, Math.floor(90_000 * 0.8), '比例越界即取默认 0.8')
})

test('口径齐全时 C 取比例线与余量线的下界，T 再让到交接余量以内', () => {
  const line = rotationLine(FULL)
  assert.equal(line.mode, 'active')
  if (line.mode !== 'active') return
  assert.equal(line.C, 400_000, 'C=min(0.8×W, W−R−H)=min(400000,440000)')
  assert.equal(line.T, 300_000, 'T=min(0.6×W, C−M)=min(300000,391808)')
  assert.equal(line.window, 500_000)
  assert.equal(line.hard, 437_000)
  assert.equal(line.reason, undefined)
})

test('交接余量把 T 压到非正时禁用自动轮换', () => {
  const line = rotationLine(withInput({ handoffMargin: 400_000 }))
  assert.equal(line.mode, 'disabled')
  if (line.mode !== 'disabled') return
  assert.equal(line.C, 400_000)
  assert.equal(line.T, 0)
  assert.match(line.reason, /轮换线 T=0 非正/)
})

test('窗口过小或预留过大把 C 压成非正时禁用', () => {
  const line = rotationLine(withInput({ outputReserve: 200_000, compactionHeadroom: 400_000 }))
  assert.equal(line.mode, 'disabled')
  if (line.mode !== 'disabled') return
  assert.ok(line.C <= 0)
  assert.match(line.reason, /压缩生效线/)
})

test('完整启动请求加运行余量不小于 T：判为上下文配置问题', () => {
  const line = rotationLine(withInput({ startupRequestTokens: 200_000, runtimeSlackTokens: 100_001 }))
  assert.equal(line.mode, 'disabled')
  if (line.mode !== 'disabled') return
  assert.match(line.reason, /不小于 T=300000/)
  assert.equal(line.T, 300_000, '仍然报出 T，供人核对差多少')

  const fits = rotationLine(withInput({ startupRequestTokens: 200_000, runtimeSlackTokens: 99_999 }))
  assert.equal(fits.mode, 'active', '刚好差一块钱也要放行，否则阈值调不参与')
})

test('六项口径任缺其一都进观察模式，且带可断言的原因', () => {
  const cases: readonly { readonly overrides: Partial<WindowInput>; readonly reason: RegExp }[] = [
    { overrides: { contextWindow: null }, reason: /contextWindow 不可得/ },
    { overrides: { contextWindow: 0 }, reason: /contextWindow 不可得/ },
    { overrides: { contextWindow: Number.NaN }, reason: /contextWindow 不可得/ },
    { overrides: { outputReserve: null }, reason: /outputReserve 不可得/ },
    { overrides: { outputReserve: -1 }, reason: /outputReserve 不可得/ },
    { overrides: { compactionHeadroom: 0 }, reason: /compactionHeadroom 不可得/ },
    { overrides: { compactionRatio: 1.2 }, reason: /compactionRatio 不可得或越界/ },
    { overrides: { compactionRatio: 0 }, reason: /compactionRatio 不可得或越界/ },
    { overrides: { handoffMargin: null }, reason: /handoffMargin 不可得/ },
    { overrides: { rotateRatio: 0 }, reason: /rotateRatio 越界/ },
  ]
  for (const item of cases) {
    const line = rotationLine(withInput(item.overrides))
    assert.equal(line.mode, 'observation', JSON.stringify(item.overrides))
    if (line.mode !== 'observation') continue
    assert.match(line.reason, item.reason)
    assert.equal(line.C, null, '观察模式不给任何数字，避免被当成阈值用')
    assert.equal(line.T, null)
  }
})

test('outputReserve 为 0 是合法值，不许被当成不可得', () => {
  const line = rotationLine(withInput({ outputReserve: 0 }))
  assert.equal(line.mode, 'active')
  if (line.mode !== 'active') return
  assert.equal(line.C, 400_000)
})

test('compactionRatio 与 rotateRatio 允许等于 1', () => {
  assert.equal(rotationLine(withInput({ compactionRatio: 1 })).mode, 'active')
  const line = rotationLine(withInput({ rotateRatio: 1 }))
  assert.equal(line.mode, 'active')
  if (line.mode !== 'active') return
  assert.equal(line.T, 391_808, 'p=1 时 T 由交接余量决定')
})

test('占用读取：分母缺失、分子缺失、比例越界都不判定', () => {
  assert.deepEqual(readOccupancy(null).known, false)
  assert.deepEqual(readOccupancy(undefined).known, false)

  const noProjected = readOccupancy({ contextWindow: 500_000, pressureTokens: 1_000 })
  assert.equal(noProjected.known, false)
  assert.equal(noProjected.contextWindow, 500_000, '未知也保留读到的原始字段，报告里要说清缺哪个')
  assert.equal(noProjected.ratio, null)

  const negative = readOccupancy({ projectedTokens: -5, contextWindow: 500_000 })
  assert.equal(negative.known, false)

  const noWindow = readOccupancy({ projectedTokens: 300_000 })
  assert.equal(noWindow.known, false)
  assert.equal(noWindow.projectedTokens, 300_000)
  const zeroWindow = readOccupancy({ projectedTokens: 300_000, contextWindow: 0 })
  assert.equal(zeroWindow.known, false, '分母 0 不判，也不返回 0%')

  const ok = readOccupancy({ projectedTokens: 120_000, contextWindow: 500_000, pressureTokens: 118_000 })
  assert.equal(ok.known, true)
  assert.equal(ok.ratio, 0.24)
  assert.equal(ok.clampMismatch, false)
  assert.equal(ok.pressureTokens, 118_000)

  const stale = readOccupancy({ projectedTokens: 600_000, contextWindow: 100_000 })
  assert.equal(stale.known, true)
  assert.equal(stale.ratioRaw, 6)
  assert.equal(stale.ratio, 1, '切模型后的"新窗口配旧压力"夹到 100%，不出荒谬提示')
  assert.equal(stale.clampMismatch, true)
})
