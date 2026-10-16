/**
 * PTC（Code-Mode）适配回归（任务 #57）。
 *
 * 锚点（本机 `<DSH 源码>` @ v0.2.1-alpha.1）：
 * - `packages/core/tools/src/index.ts:1024-1026`：PTC 下上行给模型的 schema 只剩 `run_code`；
 * - `packages/core/tools/src/index.ts:1352`：塌陷只作用于**模型直接发起**的调用（`!nested`），
 *   子调用仍走完整策略与审批；
 * - `packages/core/tools/src/ptc.ts:587-600`：子调用落盘为
 *   `tool/ptc-dispatch-start` / `tool/ptc-dispatch`，`arguments` 是**对象**
 *   （`ptc.ts:197` 的 `snapshotJsonValue` 兄弟副本），而 native 的 `tool/call`
 *   带模型原文字符串（`packages/core/agent-loop/src/tool-calls.ts:264` 放 `block.arguments`）；
 * - `packages/core/tools/src/ptc.ts:121` + `packages/ptc-runtime/ptc-runtime-node/src/index.ts:55-56`：
 *   `run_code` 的截止时间含子调用与审批等待，默认 120 s、上限 600 s，且程序不会被自动回放
 *   （`ptc.ts:132`："Earlier effects may already have completed… Programs are never replayed automatically"）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ReplayGuard, commandToolFactories, type ToolDeps } from '../src/adapter/tools.ts'
import { ToolEventLedger, factsFromLedger } from '../src/rotation/facts.ts'
import { collectFileChanges } from '../src/rotation/brief.ts'
import { freshState } from './fixtures.ts'
import type { CommandContext } from '../src/core/commands.ts'

// —— 观测面：Code-Mode 的子调用必须进 ledger ——

test('PTC 子调用配对进 ledger：对象参数被序列化成可解析文本（§27.1 不许把"没观测到"读成空闲）', () => {
  const ledger = new ToolEventLedger()
  const started = ledger.observe('s1', {
    type: 'tool/ptc-dispatch-start',
    seq: 10,
    data: { rootCallId: 'root', parentCallId: 'run-1', subCallId: 'run-1:ptc:1', name: 'write', arguments: { path: 'notes/a.md', content: 'x' } },
  })
  const settled = ledger.observe('s1', {
    type: 'tool/ptc-dispatch',
    seq: 11,
    data: {
      rootCallId: 'root',
      parentCallId: 'run-1',
      subCallId: 'run-1:ptc:1',
      name: 'write',
      arguments: { path: 'notes/a.md', content: 'x' },
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
    },
  })
  assert.equal(started, true)
  assert.equal(settled, true)
  assert.equal(ledger.hasUnsettled('s1'), false)
  const rows = ledger.changes('s1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.tool, 'write')
  assert.equal(rows[0]?.ok, true)
  assert.deepEqual(JSON.parse(rows[0]?.argumentsJson ?? 'null'), { path: 'notes/a.md', content: 'x' })
})

test('未结算的子调用让 managedToolsRunning 读到 true，不是"没有工具在跑"', () => {
  const ledger = new ToolEventLedger()
  ledger.observe('s1', {
    type: 'tool/ptc-dispatch-start',
    seq: 4,
    data: { parentCallId: 'run-1', subCallId: 'run-1:ptc:1', name: 'continuity_evidence', arguments: { kind: 'observation' } },
  })
  assert.equal(ledger.hasUnsettled('s1'), true)
  assert.match(ledger.lastCallSummary('s1'), /未见结果记录/)
})

test('订阅落在程序中途：只有 tool/ptc-dispatch 也要补成已结算记录（与宿主呈现子调用的做法一致）', () => {
  const ledger = new ToolEventLedger()
  const consumed = ledger.observe('s1', {
    type: 'tool/ptc-dispatch',
    seq: 20,
    data: { parentCallId: 'run-9', subCallId: 'run-9:ptc:3', name: 'edit', arguments: { path: 'src/b.ts' }, isError: false },
  })
  assert.equal(consumed, true)
  const rows = ledger.changes('s1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.ok, true)
  assert.equal(ledger.hasUnsettled('s1'), false)
})

test('子调用报错不计为文件改动；错误与成功一样对上同一条 subCallId', () => {
  const ledger = new ToolEventLedger()
  ledger.observe('s1', {
    type: 'tool/ptc-dispatch-start',
    seq: 1,
    data: { parentCallId: 'run-1', subCallId: 'c1', name: 'write', arguments: { path: 'p/c.md' } },
  })
  ledger.observe('s1', {
    type: 'tool/ptc-dispatch',
    seq: 2,
    data: { parentCallId: 'run-1', subCallId: 'c1', name: 'write', arguments: { path: 'p/c.md' }, isError: true },
  })
  assert.deepEqual(collectFileChanges(ledger.changes('s1')), [])
  assert.equal(ledger.hasUnsettled('s1'), false)
})

test('交接包的改动清单在 PTC 会话里取得到路径（批量写文件的往返被折进一次 run_code）', () => {
  const ledger = new ToolEventLedger()
  ledger.observe('s1', { type: 'tool/call', seq: 1, data: { callId: 'run-1', name: 'run_code', arguments: '{"language":"typescript","code":"…"}' } })
  for (const [index, path] of ['x.md', 'y.md'].entries()) {
    ledger.observe('s1', {
      type: 'tool/ptc-dispatch-start',
      seq: 2 + index * 2,
      data: { parentCallId: 'run-1', subCallId: `run-1:ptc:${index + 1}`, name: 'write', arguments: { path, content: 'body' } },
    })
    ledger.observe('s1', {
      type: 'tool/ptc-dispatch',
      seq: 3 + index * 2,
      data: { parentCallId: 'run-1', subCallId: `run-1:ptc:${index + 1}`, name: 'write', arguments: { path, content: 'body' }, isError: false },
    })
  }
  ledger.observe('s1', { type: 'tool/result', seq: 9, data: { message: { toolCallId: 'run-1', isError: false } } })
  assert.deepEqual(
    collectFileChanges(ledger.changes('s1')).map((row) => row.path),
    ['x.md', 'y.md'],
  )
})

test('native 口径不变：字符串参数照常解析，未知事件类型不消费', () => {
  const ledger = new ToolEventLedger()
  assert.equal(
    ledger.observe('s1', { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'write', arguments: '{"path":"n.md","content":"1"}' } }),
    true,
  )
  assert.equal(ledger.observe('s1', { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'c1', isError: false } } }), true)
  assert.deepEqual(
    collectFileChanges(ledger.changes('s1')).map((row) => row.path),
    ['n.md'],
  )
  assert.equal(ledger.observe('s1', { type: 'turn/end', seq: 3, data: {} }), false)
  assert.equal(ledger.observe('s1', { type: 'tool/ptc-dispatch', seq: 4, data: { isError: false } }), false)
  assert.equal(ledger.observe('s1', { type: 'tool/result', seq: 5, data: { message: { toolCallId: 'missing' } } }), false)
})

// —— 幂等面：超时重放防护 ——

test('ReplayGuard：同 requestId 是内核去重的事，不同 requestId 的同内容落地才拦', () => {
  const guard = new ReplayGuard(120_000)
  assert.equal(guard.suspect('k', 'r-1', 1_000), undefined)
  guard.note('k', 'r-1', 1_000)
  assert.equal(guard.suspect('k', 'r-1', 2_000), undefined)
  const held = guard.suspect('k', 'r-2', 62_000)
  assert.ok(held !== undefined, '窗口内的同内容不同请求要拦下')
  assert.match(held, /疑似超时重放/)
  assert.equal(guard.suspect('k', 'r-2', 200_000), undefined)
  assert.equal(guard.suspect('other', 'r-2', 62_000), undefined)
})

test('ReplayGuard：windowMs<=0 就是关闭，同一毫秒内的重放也不拦（设置说明写的是 0=off）', () => {
  const off = new ReplayGuard(0)
  off.note('k', 'r-1', 5_000)
  assert.equal(off.suspect('k', 'r-2', 5_000), undefined)
  assert.equal(off.suspect('k', 'r-2', 60_000), undefined)
})

test('ReplayGuard：窗口内条目按最早时刻剪，条数有上限', () => {
  const guard = new ReplayGuard(10_000, 2)
  guard.note('a', 'ra', 1_000)
  guard.note('b', 'rb', 2_000)
  guard.note('c', 'rc', 3_000)
  assert.ok(guard.size <= 2)
  guard.note('d', 'rd', 60_000)
  assert.equal(guard.size, 1)
})

const ctxAt = (now: number): CommandContext => ({ actorId: 'lead-1', role: 'lead', now, sessionId: 'sess-1' })

function proposeCompleteRig(input: { readonly replayWindowMs?: number | null }) {
  let revision = 7
  let now = 1_000_000
  const submitted: string[] = []
  const deps = {
    kernel: {
      read: async () => ({ revision }),
      submit: async (_mission: string, cmd: { requestId: string }) => {
        submitted.push(cmd.requestId)
        revision += 1
        return { applied: true, effect: '提案已挂起', state: { revision } }
      },
    },
    identity: async () => ctxAt(now),
    defaultMissionId: () => 'mss-1',
    ...(input.replayWindowMs === undefined || input.replayWindowMs === null ? {} : { replayGuard: new ReplayGuard(input.replayWindowMs) }),
  } as unknown as ToolDeps
  const definition = commandToolFactories.map((factory) => factory(deps)).find((item) => item.name === 'continuity_propose_complete')
  assert.ok(definition !== undefined)
  const call = () => definition.execute({ note: '收口提案' } as never, { agent: { id: 'sess-1' } } as never)
  return { call, submitted, advance: (ms: number) => { now += ms } }
}

test('没有防护时，超时重试会二次落地（这正是 PTC 打开的缺口）', async () => {
  const rig = proposeCompleteRig({ replayWindowMs: null })
  const first = await rig.call()
  const retry = await rig.call()
  assert.equal(first.applied, true)
  assert.equal(retry.applied, true)
  assert.equal(rig.submitted.length, 2)
  assert.notEqual(rig.submitted[0], rig.submitted[1])
})

test('开了窗口后，同内容重试被退回"先核对"，不再产生第二次提交；未落地不记账', async () => {
  const rig = proposeCompleteRig({ replayWindowMs: 120_000 })
  const first = await rig.call()
  assert.equal(first.applied, true)
  rig.advance(1_000)
  const retry = await rig.call()
  assert.equal(retry.applied, false)
  assert.match(retry.reason, /疑似超时重放/)
  assert.match(retry.reason, /continuity_status/)
  assert.equal(rig.submitted.length, 1)
  rig.advance(200_000)
  const later = await rig.call()
  assert.equal(later.applied, true)
  assert.equal(rig.submitted.length, 2)
})

test('同一次调用被重复提交（修订号未推进）仍由内核 requestId 去重，窗口不插手', async () => {  let revision = 7
  const submitted: string[] = []
  const deps = {
    kernel: {
      read: async () => ({ revision }),
      submit: async (_mission: string, cmd: { requestId: string }) => {
        submitted.push(cmd.requestId)
        return { applied: true, effect: 'dedup-hit', state: { revision } }
      },
    },
    identity: async () => ctxAt(500_000),
    defaultMissionId: () => 'mss-1',
    replayGuard: new ReplayGuard(120_000),
  } as unknown as ToolDeps
  const definition = commandToolFactories.map((factory) => factory(deps)).find((item) => item.name === 'continuity_propose_complete')
  assert.ok(definition !== undefined)
  const exec = () => definition.execute({ note: '同一提案' } as never, { agent: { id: 'sess-1' } } as never)
  assert.equal((await exec()).applied, true)
  assert.equal((await exec()).applied, true)
  assert.equal(submitted.length, 2)
  assert.equal(submitted[0], submitted[1])
})

// —— 事实面：程序内直接写文件的盲区必须如实声明 ——

test('run_code 程序的直接文件写入不在改动清单里，交接包要写出这条口径', () => {
  const ledger = new ToolEventLedger()
  ledger.observe('s1', { type: 'tool/call', seq: 1, data: { callId: 'run-1', name: 'run_code', arguments: '{}' } })
  ledger.observe('s1', {
    type: 'tool/ptc-dispatch-start',
    seq: 2,
    data: { parentCallId: 'run-1', subCallId: 'run-1:ptc:1', name: 'write', arguments: { path: 'via-tool.md' } },
  })
  ledger.observe('s1', {
    type: 'tool/ptc-dispatch',
    seq: 3,
    data: { parentCallId: 'run-1', subCallId: 'run-1:ptc:1', name: 'write', arguments: { path: 'via-tool.md' }, isError: false },
  })
  ledger.observe('s1', { type: 'tool/result', seq: 4, data: { message: { toolCallId: 'run-1', isError: false } } })
  assert.equal(ledger.programCalls('s1'), 1)

  const facts = factsFromLedger({ state: freshState(), ledger, sessionId: 's1', route: 'r', mode: 'ptc', permission: 'p', compacted: false })
  assert.deepEqual(facts.fileChanges.map((row) => row.path), ['via-tool.md'])
  assert.match(facts.inheritedNote ?? '', /1 次 run_code 程序执行/)
  assert.match(facts.inheritedNote ?? '', /不在本清单内/)

  const native = new ToolEventLedger()
  native.observe('s2', { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'write', arguments: '{"path":"a.md"}' } })
  native.observe('s2', { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'c1', isError: false } } })
  assert.equal(native.programCalls('s2'), 0)
  const nativeFacts = factsFromLedger({ state: freshState(), ledger: native, sessionId: 's2', route: 'r', mode: 'standard', permission: 'p', compacted: false })
  assert.equal(/run_code/.test(nativeFacts.inheritedNote ?? ''), false, 'native 会话不该带上这条声明')
})
