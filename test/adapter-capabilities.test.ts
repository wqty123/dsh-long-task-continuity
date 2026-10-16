/**
 * 能力探针（§16 待验证清单 + §7.2 provider 差异）。
 *
 * 这里只测**结构性**判定：成员在不在、缺哪几个、门禁看哪几项。
 * 语义核对（awaited 顺序、reject 是否丢消息、压缩口径、上下文组装、并发输入次序）
 * 探针给不出结论，所以每项必须有 `liveCheck`，且 `turn-boundary` 永远停在 `partial` —— 用例把这条钉死。
 * v0.3 补齐 §16 第 6/8/9 项：context-assembly、workspace-isolation、concurrent-input-routing，
 * 前两者按定义拿不到 `ok`；门禁阻塞项从 5 个扩到 7 个。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BLOCKING, formatReport, gateAutomation, probeAll } from '../src/adapter/capabilities.ts'
import type { ProbeResult } from '../src/adapter/capabilities.ts'
import type { HostSlice } from '../src/adapter/host-types.ts'

const IDS = [
  'pressure-reader',
  'session-create-shape',
  'seed-delivery-receipt',
  'token-measure',
  'compaction-coordination',
  'goal-gate',
  'subagent-settle',
  'history-protection',
  'schedule-migration',
  'turn-boundary',
  'tool-guard-coverage',
  'context-assembly',
  'concurrent-input-routing',
  'workspace-isolation',
] as const

/** 齐配置的宿主：只按探针读到的成员名构造，运行期不调用任何方法。 */
function fullHost(): HostSlice {
  return {
    sessionProjections: { stateOf: () => undefined },
    sessionController: { create: async () => ({}), resolveAgent: () => undefined },
    sessions: { flush: async () => true },
    tokenMeter: { measure: () => 0 },
    goals: { create: async () => ({}) },
    subagents: { start: async () => ({}) },
    schedule: { list: () => [], update: async () => undefined },
    sessionTitle: { rename: async () => undefined },
    tools: { guard: () => () => undefined, register: () => undefined },
  } as unknown as HostSlice
}

function byId(results: readonly ProbeResult[]): Record<string, ProbeResult> {
  return Object.fromEntries(results.map((item) => [item.id, item]))
}

test('空宿主：十四项齐全且全部判缺，七项阻塞进门禁名单', () => {
  const results = probeAll({})
  assert.deepEqual(results.map((item) => item.id), [...IDS], '探针清单的顺序与 ID 就是 §16 的核对表')
  for (const item of results) {
    assert.equal(item.shape, 'missing', `${item.id} 应判缺`)
    assert.ok(item.evidence.length > 0, `${item.id} 缺证据说明`)
    assert.ok(item.liveCheck.length > 8, `${item.id} 必须写清要实测什么`)
    assert.ok(item.degrade.length > 0, `${item.id} 必须写明退化路径`)
  }
  assert.equal(BLOCKING.length, 7, '§16：v0.3 把上下文组装与并发输入路由纳入阻塞项')
  const gate = gateAutomation(results)
  assert.equal(gate.allowed, false)
  assert.deepEqual(gate.blocking, BLOCKING.map((id) => `${id}:missing`))
})

test('成员齐的宿主：结构检查转 ok，压缩口径与轮末边界仍不许冒充已核对', () => {
  const probe = byId(probeAll(fullHost()))
  for (const id of ['pressure-reader', 'session-create-shape', 'seed-delivery-receipt', 'token-measure', 'goal-gate', 'subagent-settle', 'history-protection', 'schedule-migration', 'tool-guard-coverage']) {
    assert.equal(probe[id]?.shape, 'ok', `${id} 结构齐了应判 ok`)
  }
  assert.equal(probe['compaction-coordination']?.shape, 'missing', '本包不持有压缩服务句柄：按定义拿不到 C 的口径')
  assert.equal(probe['turn-boundary']?.shape, 'partial', '字段口径已知，但未与 turn/end 对账，不能算 ok')
  // §16 第 6/8/9 项：静态探测到不了"最终请求里的上下文是不是那一份"，fullHost 也缺 page/get 成员。
  assert.equal(probe['context-assembly']?.shape, 'missing', '读不到 sessionController.page / sessions.get 就只能判缺')
  assert.equal(probe['concurrent-input-routing']?.shape, 'partial', 'resolveAgent 在场只证明能路由，次序仍要实测')
  assert.equal(probe['workspace-isolation']?.shape, 'missing', '拿不到会话头部就比不了 cwd')
})

test('能读回会话页与头部的宿主：三项新探针最多停在 partial，永不 ok', () => {
  const assembled = byId(probeAll({
    sessionController: { create: async () => ({}), resolveAgent: () => undefined, page: () => undefined },
    sessions: { flush: async () => true, get: () => undefined },
  } as unknown as HostSlice))
  assert.equal(assembled['context-assembly']?.shape, 'partial', '成员齐了也只能说"读得到"，同源性靠 liveCheck')
  assert.equal(assembled['workspace-isolation']?.shape, 'partial')
  for (const id of ['context-assembly', 'workspace-isolation', 'concurrent-input-routing']) {
    assert.notEqual(assembled[id]?.shape, 'ok', `${id} 按定义给不出 ok（§16）`)
  }
})

test('部分成员：partial 点名缺谁，一个都没有才判 missing', () => {
  const partial = byId(probeAll({ sessionController: { create: async () => ({}) } } as unknown as HostSlice))
  assert.equal(partial['session-create-shape']?.shape, 'partial')
  assert.match(partial['session-create-shape']?.evidence ?? '', /只有 create，缺 resolveAgent/)
  const none = byId(probeAll({ sessionProjections: {} } as unknown as HostSlice))
  assert.equal(none['pressure-reader']?.shape, 'missing')
  assert.match(none['pressure-reader']?.evidence ?? '', /一个成员都没有（期望 stateOf）/)
})

test('启动消息回执要 sessions.flush 与 sessionController 同时可用', () => {
  const flushOnly = byId(probeAll({ sessions: { flush: async () => true } } as unknown as HostSlice))
  assert.equal(flushOnly['seed-delivery-receipt']?.shape, 'missing', '没有建会话能力就谈不上启动回执')
  assert.match(flushOnly['seed-delivery-receipt']?.evidence ?? '', /成员齐：flush/, '证据行只描述 flush 本身，判缺的理由看 liveCheck')
  assert.match(flushOnly['seed-delivery-receipt']?.degrade ?? '', /不宣称已启动/)
})

test('门禁只看阻塞项：非阻塞探针判缺不拦自动模式', () => {
  const results = probeAll(fullHost()).map((item): ProbeResult =>
    ['turn-boundary', 'context-assembly', 'concurrent-input-routing'].includes(item.id) ? { ...item, shape: 'ok' } : item,
  )
  const before = gateAutomation(probeAll(fullHost()))
  assert.deepEqual(
    before.blocking,
    ['turn-boundary:partial', 'context-assembly:missing', 'concurrent-input-routing:partial'],
    '没签字核对轮末边界、上下文组装与并发输入次序就不许自动轮换',
  )
  const after = gateAutomation(results)
  assert.equal(after.allowed, true)
  assert.deepEqual(after.blocking, [])
})

test('gateAutomation 与 BLOCKING 表自洽：阻塞项一律要 ok', () => {
  const results = probeAll({}).map((item): ProbeResult => (BLOCKING.includes(item.id) ? { ...item, shape: 'partial' } : { ...item, shape: 'ok' }))
  const gate = gateAutomation(results)
  assert.equal(gate.allowed, false)
  assert.deepEqual(gate.blocking, [...BLOCKING].map((id) => `${id}:partial`))
})

test('formatReport：每项三行（形状 / 需实测 / 退化），缺项也读得懂下一步', () => {
  const results = probeAll(fullHost())
  const report = formatReport(results)
  assert.equal(report.split('\n').length, results.length * 3)
  assert.match(report, /^\[OK\] pressure-reader — /)
  assert.match(report, /\[MISSING\] compaction-coordination — 本包不直接依赖 compaction 服务句柄/)
  assert.match(report, /需实测：.*\n.*退化：/)
})
