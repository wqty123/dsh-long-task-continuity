// 一次性宿主替身：只为在装载前跑通 src/index.ts 的装配路径（真机 API 口径见各文件的注释）。
// 前置：同目录先跑 `node make-rig.mjs` 生成 @deepseek-ai/* 存根。
//
// 三轮证明的事：
// 1. 手动侧——open/task/approve/claim/checkpoint/submit/verify/drain/recover/rotate 全链路，
//    轮换走到 ACTIVE 且 outbox 的 rotation.seed 有回执。
// 2. 自动侧在 **R/H/r 未声明**时停在观察模式（`rotation-line-observation:outputReserve 不可得`），
//    不换会话；且没有检查点时也不换（§10.3）。
// 3. 声明 R/H/r 后同一条判定进入 active：压力跨 hard 档 + 轮末边界对账通过 → 自动轮换走完 FSM。
//    结论：自动侧要入场必须显式声明这三项口径，本包不替宿主猜。
import { apply } from './src/index.ts'

const records = new Map()
const kv = () => ({
  get: (key) => records.get(key),
  put: async (key, value) => { records.set(key, value) },
  update: async (key, fn) => {
    const current = records.get(key)
    if (current === undefined) throw new Error(`missing key ${key}`)
    const next = fn(current)
    records.set(key, next)
    return next
  },
  entries: () => records.entries(),
})

const pressure = { contextWindow: 500_000, pressureTokens: 120_000, surfaceTokens: 20_000, sampledSurfaceTokens: 20_000 }
let turnCount = 0
let stepSeq = 0

const sessions = new Map()
function ensureSession(id, cwd = 'E:/fake-work') {
  const existing = sessions.get(id)
  if (existing !== undefined) return existing
  const session = { id, header: { cwd, agentPreset: 'default' }, messages: [] }
  sessions.set(id, session)
  return session
}
const agentOf = (id) => {
  const session = ensureSession(id)
  return {
    id,
    session,
    whenIdle: async () => undefined,
    followup: async (message) => { session.messages.push(message) },
  }
}

const listeners = new Map()
const commands = {}
const provided = {}
const logLines = []
const log = (level, msg) => { logLines.push(`${level}: ${msg}`); console.log(`  [${level}] ${String(msg).split('\n').join('\n  [')}`) }

let bootPromise
const services = {
  agents: { get: (id) => (sessions.has(id) ? agentOf(id) : undefined), list: () => [...sessions.keys()].map(agentOf) },
  sessions: { get: (id) => sessions.get(id), flush: async () => true },
  sessionController: {
    create: async (spec) => {
      const existing = sessions.get(spec.sessionId)
      if (existing !== undefined && existing.header.cwd !== spec.cwd) {
        const error = new Error('conflict')
        error.code = 'session/conflict'
        throw error
      }
      ensureSession(spec.sessionId, spec.cwd)
      return { sessionId: spec.sessionId }
    },
    resolveAgent: async (id) => (sessions.has(id) ? { agent: agentOf(id) } : { error: { code: 'session/not-found' } }),
    page: async ({ address }) => ({ messages: sessions.get(address.sessionId)?.messages ?? [] }),
  },
  sessionProjections: {
    stateOf: (session, name) => {
      if (session === null || session === undefined) return null
      if (name === 'contextPressure') return { ...pressure }
      if (name === 'turnBoundary') return { lastTurn: turnBySession.get(session.id) ?? 0, openTurnStartSeq: null, lastStepStartSeq: stepSeq, lastStepBoundary: { kind: 'end', seq: stepSeq } }
      if (name === 'inbox') return { 'next-turn': [], 'next-step': [] }
      return null
    },
  },
  tokenMeter: { measure: () => ({ totalTokens: pressure.pressureTokens, revision: 1 }) },
  goals: { create: () => undefined },
  schedule: { list: async () => [], update: async () => undefined },
  sessionTitle: { rename: async () => undefined },
  tools: { register: (tool) => { (services.tools.registered ??= []).push(tool); return () => {} }, guard: (g) => { (services.tools.guards ??= []).push(g); return () => {} } },
}

const ctx = {
  logger: () => ({ info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m), debug: () => undefined }),
  get: (name) => services[name],
  provide: (name, value) => { provided[name] = value },
  effect: (fn) => { bootPromise = fn() },
  on: (event, listener) => {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
    return () => listeners.set(event, list.filter((item) => item !== listener))
  },
  commands: {
    register: (definition) => { commands[definition.name] = definition; return () => { delete commands[definition.name] } },
  },
  storageDomain: {
    open: async () => ({
      table: (name) => (services.storageTable ??= kv()),
      close: async () => undefined,
    }),
  },
}

const emit = async (event, ...args) => {
  for (const listener of listeners.get(event) ?? []) await listener(...args)
}

// 每个会话各自数自己的轮：投影的 lastTurn 必须与本进程事件侧的 guard.turn 对得上，
// 否则 index.ts 的"轮号对不上"守卫会拒绝自动轮换。
const turnBySession = new Map()
const emitTurn = async (sessionId, seq) => {
  const turn = (turnBySession.get(sessionId) ?? 0) + 1
  turnBySession.set(sessionId, turn)
  await emit('session/event', sessions.get(sessionId), { type: 'turn/end', seq, time: Date.now(), data: { turn } })
}

const config = {
  enabled: true,
  missionId: '',
  autoRotationEnabled: false,
  probesAcknowledged: false,
  registerTools: true,
  enforceAdmission: false,
  outboxDrainMs: 0,
}

console.log('== apply()')
apply(ctx, config)
await bootPromise
const disposer = await bootPromise
console.log(`  注册的命令：${Object.keys(commands).join(', ')}；provide：${Object.keys(provided).join(', ')}；工具：${(services.tools.registered ?? []).map((t) => t.name ?? '?').join(', ')}`)

const run = async (line, agent = agentOf('session-s1')) => {
  console.log(`\n$ /continuity ${line}`)
  const result = await commands.continuity.handler({ agent, rawInput: line })
  console.log(`  => ${result.kind}\n${String(result.text ?? '').split('\n').map((l) => `     ${l}`).join('\n')}`)
  return result
}

await run('status')
await run('open 把连续性台账跑通一次 --auto-resume')
await run('task 冒烟适配层 [| 只读核对 index.ts 的装配 | 命令全部返回;轮换走到 ACTIVE]')
const timeline = await run('timeline')
const taskId = /taskId=(tsk_[0-9a-f-]+)/u.exec(String(timeline.text))?.[1]
console.log(`  解析到 taskId=${String(taskId)}`)
await run(`approve ${String(taskId)}`)
await run(`claim ${String(taskId)}`)
await run('checkpoint 冒烟进行到 claim | 跑一次手动轮换')

await emit('session/event', sessions.get('session-s1'), { type: 'tool/call', seq: 1, time: Date.now(), data: { callId: 'c1', toolName: 'write_file', arguments: { path: 'E:/fake-work/a.md', content: 'x' } } })
await emit('session/event', sessions.get('session-s1'), { type: 'tool/result', seq: 2, time: Date.now(), data: { toolCallId: 'c1', isError: false, content: 'ok' } })
await emit('agent/status', { agent: agentOf('session-s1'), status: 'running' })
await emitTurn('session-s1', 3)
await emit('agent/status', { agent: agentOf('session-s1'), status: 'idle' })

await run(`submit ${String(taskId)}`)
await run(`verify ${String(taskId)} pass 冒烟脚本 a.md:sha256`)
await run('status')
await run('drain')
await run('recover')
await run('rotate')
await run('timeline')

console.log('\n== 轮换后的 Actor 绑定与 S2 启动消息')
const state = await provided.continuity.kernel.read(provided.continuity.missionId())
console.log(`  actors: ${Object.values(state.actors).map((a) => `${a.actorId}→${String(a.sessionId)} v${a.bindingVersion}${a.retired ? ' retired' : ''}`).join(', ')}`)
console.log(`  rotations: ${Object.values(state.rotations).map((r) => `${r.rotationId} ${r.phases.join('>')}`).join(' | ')}`)
console.log(`  S2 消息数：${(sessions.get(Object.values(state.actors)[0]?.sessionId)?.messages ?? []).length}`)
console.log(`  outbox: ${Object.values(state.outbox).map((e) => `${e.kind}#${e.attempts}${e.completedAt === undefined ? ' pending' : ' done'}`).join(', ') || '空'}`)

console.log('\n== 第二轮：自动侧（压力抬高 + 签字，R/H/r 未声明）')
config.probesAcknowledged = true
config.autoRotationEnabled = true
pressure.pressureTokens = 430_000
stepSeq = 9
ensureSession('session-s2b')
await run('join lead-s2b lead', agentOf('session-s2b'))
await emitTurn('session-s2b', 20)
await new Promise((resolve) => setTimeout(resolve, 250))

console.log('\n== 第三轮：声明 R/H/r 后自动轮换入场')
config.outputReserveTokens = 40_000
config.compactionHeadroomTokens = 20_000
config.compactionRatio = 0.8
await run('checkpoint 自动侧冒烟前落盘 | 等新会话接续', agentOf('session-s2b'))
await emitTurn('session-s2b', 21)
await new Promise((resolve) => setTimeout(resolve, 600))
const state2 = await provided.continuity.kernel.read(provided.continuity.missionId())
const rot2 = Object.values(state2.rotations).filter((r) => r.actorId === 'lead-s2b')
console.log(`  lead-s2b 轮换：${rot2.map((r) => `${r.rotationId} ${r.phases.join('>')}`).join(' | ') || '（无）'}`)
console.log(`  状态页线口径：${/线口径声明：.*/u.exec(String((await commands.continuity.handler({ agent: agentOf('session-s2b'), rawInput: 'status' })).text))?.[0] ?? '未渲染'}`)

console.log('\n== pre-step 守卫（轮换进行中收到人类输入）')
const decisions = []
await emit('agent/pre-step', { agent: agentOf('session-s2b'), messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '别换，先停一下' }] }] }, async () => { decisions.push('enter'); return { kind: 'enter', messages: [] } })
console.log(`  决策：${decisions.join(',') || '（被守卫直接返回）'}`)

console.log('\n== dispose')
await disposer()
console.log(`  剩余监听：${[...listeners.entries()].filter(([, list]) => list.length > 0).map(([k, list]) => `${k}(${list.length})`).join(', ') || '无'}`)
console.log(`  注册表：${Object.keys(commands).join(', ') || '已注销'}；工具数：${(services.tools.registered ?? []).length}`)
