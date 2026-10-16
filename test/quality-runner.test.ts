/**
 * 上下文质量决策链执行器用例（设计稿 v0.5 §27.2–§27.5；复审 G2 的"决策链闭环"）。
 *
 * 覆盖 `src/adapter/quality-runner.ts` 的 8 条硬流程与两条端到端：
 *  1) missionActive=false 整链跳过（不评估、不压缩、不落 done）；
 *  2) 观测 → 评估 → `context.assess` 按**真实命令形状**落盘（冻结帧、分量、真实内核发号）；
 *  3) 入口被占用 / 入口不符 / 会话活跃 → 排队或跳过并如实落盘，绝不动宿主压缩；
 *  4) 同一版本已有终态评估 → 复用手拒绝反复压缩；
 *  5) 压缩前清点缺项 → 短差收口（重建/轮换），不调用压缩；版本漂移 → 标废旧评估并停；
 *  6) busy/changed → 失败结论且不忙循环重试；没有端口 → declined 且点名"本部署没有压缩入口"；
 *  7) 核对诚实：没有观测入口不得宣称通过（缺项进 missing）；提交失败一律进 notes，不许被吞；
 *  8) 每一步都有回执（观测/冻结/评估/清点/复核/调用/核对/收口）进 `steps`。
 *
 * 夹具只搭宿主投影与内存落盘：`commit` 直接用真实的 `dispatch`（命令面与生产同一条路），
 * 不建会话、不联网、不落盘。宿主投影字段面照 `test/v05-context-quality.test.ts` 的已核实口径。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Command } from '../src/core/commands.ts'
import { dispatch } from '../src/core/commands.ts'
import type { MissionControl } from '../src/core/control.ts'
import type { ActionRunContext, AssessmentFrame, PostCompactionObservation } from '../src/core/context-quality.ts'
import { COMPONENT_ORDER } from '../src/core/context-quality.ts'
import {
  coverageFromState,
  freshnessRefsFromState,
  structuralFindingsFromState,
  unverifiedFactsFromState,
} from '../src/core/context-quality.ts'
import type { CompactionEngineLike } from '../src/adapter/compaction.ts'
import { compactionPort, mapCompactionError } from '../src/adapter/compaction.ts'
import type { ProjectionValueSourceLike } from '../src/adapter/dsh-context.ts'
import { readContextReadings } from '../src/adapter/dsh-context.ts'
import type { HostSlice, ProjectionRegistryLike } from '../src/adapter/host-types.ts'
import type { QualityChainInput, QualityCommitResult, QualityRunReport } from '../src/adapter/quality-runner.ts'
import {
  frameFromReadings,
  postCompactionObservation,
  retentionListFromState,
  runQualityChain,
} from '../src/adapter/quality-runner.ts'
import {
  NOW,
  addedKey,
  apply,
  contextInput,
  ctx,
  must,
  proposeClaim,
  recordEvidence,
  req,
  withClaimedTask,
  withVerifiedArtifact,
} from './discipline-fixtures.ts'

// —— 夹具：假宿主（投影值面）+ 内存落盘（真实 dispatch） ——

type HostStub = Pick<HostSlice, 'sessionProjections' | 'tokenMeter'>

/** 桩注册表：值面（`snapshot`）优先、fold state 兜底，与生产读取顺序一致（dsh-context.ts:390-410）。 */
function registryWith(states: Readonly<Record<string, unknown>>): ProjectionRegistryLike & ProjectionValueSourceLike {
  return {
    snapshot: (_session: unknown, _keys?: readonly string[]) => ({ values: states }),
    stateOf: (_session: unknown, name: string) => states[name],
  }
}

function hostWith(states: Readonly<Record<string, unknown>>): HostStub {
  return { sessionProjections: registryWith(states) }
}

/**
 * 三个投影都可用、详情随值内联的读数（字段面照 v05 用例的已核实口径）：
 * `contextPressure` 决定容量压力分子，`contextTimeline` 给会话版本与占用面。
 */
function hostStates(pressureTokens: number, contextWindow = 1000): Record<string, unknown> {
  return {
    contextTimeline: {
      ok: true,
      model: 'deepseek-chat',
      provider: 'deepseek',
      contextWindow,
      maxOutputTokens: 100,
      current: { system: 120, tools: 60, user: 40, inject: 60, skill: 20, assistant: 50, tool: 3000, total: 3350 },
      counts: { turns: 3, steps: 5, injects: 5, compactions: 0, prunes: 0, skills: 2 },
      last: { seq: 42, total: 3350, prompt: 3300 },
      detailRev: 7,
      requests: [{ turn: 2, step: 1, time: NOW, seq: 42, system: 120, tools: 60, user: 40, inject: 60, assistant: 50, tool: 3000, total: 3350, prompt: 3300 }],
      events: [{ seq: 41, time: NOW + 500, kind: 'inject', sub: 'skill', name: 'pdf-official', tokens: 300, turn: 2, step: 1 }],
      nodes: [{ seq: 30, time: NOW, cat: 'tool', tokens: 3000, tool: 'Bash', err: false }],
      droppedNodes: 0,
      archive: [{ seq: 20, time: NOW - 1000, cat: 'tool', tokens: 800, gone: 41, tool: 'Read' }],
      systems: [{ seq: 5, time: NOW - 2000, tokens: 120 }],
    },
    contextHeaders: {
      headers: [{ seq: 39, time: NOW, systemTokens: 120, tools: [{ name: 'Read', tokens: 30, plugin: 'core' }] }],
    },
    contextActivity: {
      days: { '2026-10-15': { tokens: 90_000, requests: 9 } },
      model: 'deepseek-chat',
      provider: 'deepseek',
    },
    contextPressure: { contextWindow, pressureTokens, surfaceTokens: 0, sampledSurfaceTokens: 0 },
  }
}

/** 会话身份面：本端口/适配层只读 `id`，压缩绑定核对与冻结帧都用它。 */
const SESSION = { id: 'sess-1' }

/** 真机维护上下文的最小形状：`runMaintenance` 在场才算合法入口（compaction.ts:77-88）。 */
const AGENT = { id: 'sess-1', runMaintenance: async (): Promise<void> => {} }

/** 引擎行为的几种真实分支：返回结果 / null（refused）/ undefined（读不出）/ 抛 ManualCompactionError。 */
type EngineBehavior =
  | { readonly kind: 'completed'; readonly reclaimedTokens?: number }
  | { readonly kind: 'refused' }
  | { readonly kind: 'undefined' }
  | { readonly kind: 'throw'; readonly error: unknown }

function engineWith(behavior: EngineBehavior, counter: { calls: number }): CompactionEngineLike {
  return {
    async compactNow(): Promise<unknown> {
      counter.calls += 1
      if (behavior.kind === 'throw') throw behavior.error
      if (behavior.kind === 'refused') return null
      if (behavior.kind === 'undefined') return undefined
      return {
        compactionId: 'cmp-1',
        startSeq: 10,
        summarySeq: 11,
        endSeq: 20,
        summary: [{ type: 'text', text: '压缩摘要：保留目标、检查点与在途操作' }],
        shadowedRange: { start: 10, end: 20 },
        shadowedSeqs: [12, 13],
        shadowedTokenCount: behavior.reclaimedTokens ?? 1234,
      }
    },
  }
}

interface RigOptions {
  readonly state: MissionControl
  readonly pressureTokens?: number
  readonly behavior?: EngineBehavior
  /** true：不注入压缩端口（"本部署没有压缩入口"）。 */
  readonly noPort?: boolean
  /** true：端口拿到的 agent 缺 `runMaintenance`（拒绝调用无效入口）。 */
  readonly agentWithoutMaintenance?: boolean
  readonly entry?: ActionRunContext['entry']
  readonly sessionActive?: boolean
  readonly maintenanceEntryFree?: boolean
  readonly rotationPending?: boolean
  readonly missionActive?: boolean
  /** false：调用方不给 `verifyObservation`；函数：自定义观测面；缺省：由当前记录与读数组装（可过核对）。 */
  readonly verify?: false | (() => Promise<PostCompactionObservation>)
  /** 设了就按该判据版本回帧：`frameDrifts` 视为阻断性漂移。 */
  readonly driftCriteria?: number
  readonly noRefetch?: boolean
  /** 返回原因即让该命令落盘失败（测"提交失败进 notes，不吞"）。 */
  readonly failOn?: (cmd: Command) => string | undefined
}

interface Rig {
  readonly commands: readonly Command[]
  readonly engineCalls: () => number
  readonly state: () => MissionControl
  readonly run: (overrides?: Partial<QualityChainInput>) => Promise<QualityRunReport>
}

function rig(options: RigOptions): Rig {
  let state = options.state
  const commands: Command[] = []
  const counter = { calls: 0 }
  const host = hostWith(hostStates(options.pressureTokens ?? 100))
  const readings = readContextReadings(host, SESSION)
  const engine = engineWith(options.behavior ?? { kind: 'completed' }, counter)
  const port =
    options.noPort === true
      ? undefined
      : compactionPort(engine, options.agentWithoutMaintenance === true ? { id: 'sess-1' } : AGENT)
  const commit = async (cmd: Command): Promise<QualityCommitResult> => {
    commands.push(cmd)
    const fault = options.failOn?.(cmd)
    if (fault !== undefined) return { applied: false, reason: fault }
    const outcome = dispatch(state, cmd, ctx('supervisor', 'lead-1', undefined, NOW))
    if (!outcome.applied) return { applied: false, reason: outcome.reason, state: outcome.state }
    state = outcome.state
    return { applied: true, state }
  }
  const refetchFrame =
    options.noRefetch === true
      ? undefined
      : async (): Promise<AssessmentFrame> => {
          const current = frameFromReadings(readings, state, 'sess-1')
          return options.driftCriteria === undefined ? current : { ...current, criteriaRevision: options.driftCriteria }
        }
  const observation =
    options.verify === false
      ? undefined
      : (options.verify ??
        (async (): Promise<PostCompactionObservation> =>
          postCompactionObservation({
            state,
            retentionList: retentionListFromState(state),
            readings,
            current: frameFromReadings(readings, state, 'sess-1'),
          })))
  const run = (overrides: Partial<QualityChainInput> = {}): Promise<QualityRunReport> =>
    runQualityChain({
      host,
      session: SESSION,
      sessionId: 'sess-1',
      actorId: 'lead-1',
      state,
      now: NOW,
      nativeBudget: readings.budget,
      readings,
      entry: options.entry ?? 'idle_maintenance',
      sessionActive: options.sessionActive ?? false,
      maintenanceEntryFree: options.maintenanceEntryFree ?? true,
      missionActive: options.missionActive ?? true,
      ...(port === undefined ? {} : { compaction: port }),
      commit,
      reload: async () => state,
      ...(refetchFrame === undefined ? {} : { refetchFrame }),
      ...(observation === undefined ? {} : { verifyObservation: observation }),
      ...overrides,
    })
  return { commands, engineCalls: () => counter.calls, state: () => state, run }
}

function findCommand<K extends Command['kind']>(commands: readonly Command[], kind: K): Extract<Command, { readonly kind: K }> {
  const found = commands.find((cmd): cmd is Extract<Command, { readonly kind: K }> => cmd.kind === kind)
  if (found === undefined) throw new Error(`夹具：记录里没有 ${kind} 命令（实际：${commands.map((cmd) => cmd.kind).join('、') || '无'}）`)
  return found
}

/** 步骤回执的**顺序**断言：每段前缀都要在上一段之后出现（§27.5 的硬顺序）。 */
function assertOrderedSteps(steps: readonly string[], prefixes: readonly string[]): void {
  let cursor = 0
  for (const prefix of prefixes) {
    const index = steps.findIndex((step, i) => i >= cursor && step.startsWith(prefix))
    assert.notEqual(index, -1, `步骤回执：在 ${prefix} 之后缺这一步（实际：${steps.join(' | ')}）`)
    cursor = index + 1
  }
}

function assessmentOf(run: Rig, report: QualityRunReport): NonNullable<MissionControl['assessments'][string]> {
  const id = must('assessmentId', report.assessmentId)
  return must('落盘的评估', run.state().assessments[id])
}

// —— 第 1 条：missionActive=false 整链跳过 ——

test('质量链：missionActive=false（或记录里 mission 非 active）不评估、不压缩、不落 done（第 1 条）', async () => {
  const base = withClaimedTask()
  const inactive = rig({ state: base.state, missionActive: false, pressureTokens: 950, behavior: { kind: 'completed' } })
  const skipped = await inactive.run()
  assert.match(skipped.skipped ?? '', /任务不在执行中/)
  assert.equal(skipped.invocation, undefined, '跳过时不该有调用回执')
  assert.equal(skipped.outcome, undefined, '跳过时不该有动作结果（尤其不能有 done）')
  assert.equal(skipped.steps.length, 1)
  assert.equal(inactive.engineCalls(), 0)
  assert.deepEqual(inactive.commands, [], '跳过时一条命令都不许落盘')
  assert.equal(Object.keys(inactive.state().assessments).length, 0)

  // 记录侧与调用侧不一致时以记录为准：mission 已暂停 → 同样整链跳过。
  const paused: MissionControl = { ...base.state, mission: { ...base.state.mission, status: 'paused' } }
  const byRecord = rig({ state: paused, missionActive: true, pressureTokens: 950, behavior: { kind: 'completed' } })
  const report = await byRecord.run()
  assert.match(report.skipped ?? '', /mission=paused/)
  assert.equal(byRecord.engineCalls(), 0)
  assert.deepEqual(byRecord.commands, [])
})

// —— 第 2 条：观测 → 评估 → context.assess 真实命令形状落盘 ——

test('质量链：四份任务侧输入进观测，评估按真实 context.assess 命令形状落盘并解析内核发号（第 2 条）', async () => {
  const base = withClaimedTask()
  const run = rig({ state: base.state, pressureTokens: 100 })
  const report = await run.run()

  assert.match(report.fingerprint, /^[0-9a-f]{16}$/, '观测指纹是观测面的稳定哈希')
  assert.equal(report.degradation.length, 0, '三个投影都可用且详情内联：不该有退化说明')
  assertOrderedSteps(report.steps, ['观测：指纹 ', '冻结：sessionRevision=', '评估已落盘：'])

  const assessed = findCommand(run.commands, 'context.assess')
  assert.match(assessed.requestId, /^qca:sess-1:[0-9a-f]{16}:\d+:\d+$/)
  assert.equal(assessed.input.tier, 'deterministic', '轮末/idle 维护走确定性层（§27.3）')
  assert.equal(assessed.input.actorId, 'lead-1')
  assert.equal(assessed.input.freeze.sessionId, 'sess-1')
  assert.equal(assessed.input.freeze.sessionRevision, 42, '会话版本取观测面 seq 的最大值')
  assert.equal(assessed.input.freeze.requestFingerprint, report.fingerprint)
  assert.deepEqual([...assessed.input.freeze.retentionList], [must('检查点', base.state.checkpointOrder[base.state.checkpointOrder.length - 1])])
  assert.equal(assessed.input.signals.capacity.requestEstimateTokens, 100)

  const id = must('assessmentId', report.assessmentId)
  const stored = must('落盘的评估', run.state().assessments[id])
  assert.equal(stored.deterministic, true)
  assert.equal(stored.requestFingerprint, report.fingerprint)
  assert.equal(stored.sessionRevision, 42)
  assert.equal(stored.components.length, COMPONENT_ORDER.length)
  assert.equal(report.suggestedAction, 'retrieve', '检查点/目标没有送达回执 ⇒ 缺关键条件 ⇒ 补取')
  assert.match(report.decisionReason ?? '', /关键条件缺失/)
})

// —— 第 3 条：入口被占用 / 入口不符 / 会话活跃 ——

test('质量链：入口被占用、入口不符、会话活跃一律排队（如实落盘），宿主压缩一次都不调（第 3 条）', async () => {
  const base = withClaimedTask()

  const occupied = rig({ state: base.state, pressureTokens: 950, maintenanceEntryFree: false, rotationPending: true })
  const occupiedReport = await occupied.run()
  assert.equal(occupiedReport.plan?.kind, 'queue')
  assert.match(occupiedReport.plan?.reason ?? '', /轮换与压缩共享互斥入口/)
  assert.ok(occupiedReport.steps.some((step) => step.startsWith('压缩未执行：入口被占用（轮换与压缩共享互斥入口），按结论排队')))
  assert.equal(occupied.engineCalls(), 0)
  const queued = findCommand(occupied.commands, 'context.applyRunPlan')
  assert.equal(queued.plan.kind, 'queue')
  assert.equal(queued.requestId, `qp:${must('assessmentId', occupiedReport.assessmentId)}:queue`)
  assert.equal(assessmentOf(occupied, occupiedReport).actionState, 'queued', '没执行就要如实记排队，不冒充成功')

  const preStep = rig({ state: base.state, pressureTokens: 950, entry: 'pre_step' })
  const preStepReport = await preStep.run()
  assert.equal(preStepReport.plan?.kind, 'queue')
  assert.match(preStepReport.plan?.reason ?? '', /pre_step/)
  assert.equal(preStep.engineCalls(), 0)

  const active = rig({ state: base.state, pressureTokens: 950, sessionActive: true })
  const activeReport = await active.run()
  assert.equal(activeReport.plan?.kind, 'queue')
  assert.match(activeReport.plan?.reason ?? '', /会话活跃/)
  assert.equal(active.engineCalls(), 0)
  assert.equal(assessmentOf(active, activeReport).actionState, 'queued')

  // 非 compact 建议（retrieve/keep/wait_reconcile）只记录，不占维护入口、不压缩（§27.4、§27.5 第 5 条）。
  const retrieve = rig({ state: base.state, pressureTokens: 100 })
  const retrieveReport = await retrieve.run()
  assert.equal(retrieveReport.suggestedAction, 'retrieve')
  assert.equal(retrieveReport.invocation, undefined, '非 compact 建议不得进入压缩路径')
  assert.equal(retrieve.engineCalls(), 0)
  assert.ok(retrieveReport.steps.some((step) => step.startsWith('建议 retrieve 已记进评估：本链只执行 compact')))
})

// —— 第 4 条：同版本复用，不反复压缩 ——

test('质量链：高占用但同版本已有终态评估 → 复用手拒绝反复压缩（第 4 条）', async () => {
  const base = withClaimedTask()
  const run = rig({ state: base.state, pressureTokens: 950, behavior: { kind: 'completed' } })
  const first = await run.run()
  assert.equal(first.outcome?.kind, 'done')
  assert.equal(run.engineCalls(), 1)
  const commandsAfterFirst = run.commands.length

  const second = await run.run()
  assert.match(second.skipped ?? '', /不重复评估、不反复压缩/)
  assert.equal(second.invocation, undefined, '复用手命中的本轮不该调用压缩')
  assert.equal(second.assessmentId, first.assessmentId)
  assert.equal(run.engineCalls(), 1, 'compactNow 仍然只有第一次那一次调用')
  assert.equal(run.commands.length, commandsAfterFirst, '本轮不落任何新命令')
  assert.equal(assessmentOf(run, first).actionState, 'done')
})

// —— 第 5 条：压缩前清点 / 版本复核 ——

test('质量链：压缩前清点缺项 → 短差收口，不调用压缩、不反复压缩（第 5 条）', async () => {
  const base = withClaimedTask()
  // 约束与来源必须一起持久化：缺来源的记录不该被压进摘要里丢掉依据（§27.5 第 1 条）。
  const broken: MissionControl = { ...base.state, mission: { ...base.state.mission, constraintSources: [] } }
  const run = rig({ state: broken, pressureTokens: 950 })
  const report = await run.run()

  assert.equal(report.plan?.kind, 'run_now', '入口与结论都允许执行，卡在压缩前清点')
  assert.equal(report.invocation, undefined)
  assert.equal(run.engineCalls(), 0, '清点缺项就不许动宿主压缩')
  const skipped = findCommand(run.commands, 'context.applyRunPlan')
  assert.equal(skipped.plan.kind, 'skip')
  assert.equal(skipped.requestId, `qp:${must('assessmentId', report.assessmentId)}:preflight`)
  assert.equal(assessmentOf(run, report).actionState, 'skipped')
  assert.equal(report.outcome?.kind, 'shortfall')
  assert.ok((report.outcome?.kind === 'shortfall' ? report.outcome.missing : []).some((item) => item.includes('约束缺来源')))
  assert.ok(report.steps.some((step) => step.startsWith('压缩未执行：压缩前清点缺项 1 条（重建/轮换，不反复压缩）')))
})

test('质量链：压缩前版本复核发现阻断性漂移 → 标废旧评估并停（第 5 条）', async () => {
  const base = withClaimedTask()
  const run = rig({ state: base.state, pressureTokens: 950, driftCriteria: 99 })
  const report = await run.run()

  assert.equal(run.engineCalls(), 0, '版本已经变了：不许按旧版本压缩')
  assert.ok(report.steps.some((step) => step.startsWith('压缩未执行：压缩前版本复核发现阻断性漂移')))
  const invalidated = findCommand(run.commands, 'context.invalidateAssessment')
  assert.equal(invalidated.requestId, `qi:${must('assessmentId', report.assessmentId)}`)
  assert.equal(invalidated.current.criteriaRevision, 99)
  assert.equal(assessmentOf(run, report).actionState, 'skipped', '未执行的评估按失效转 skipped')
  assert.ok(report.notes.some((note) => note.includes('旧评估已按当前版本标废')))
})

// —— 第 6 条：调用结论 busy/changed/无端口 ——

test('质量链：busy/changed 按失败结论收口且不忙循环重试；没有端口即 declined 并点名（第 6 条）', async () => {
  const base = withClaimedTask()

  const busy = rig({
    state: base.state,
    pressureTokens: 950,
    behavior: { kind: 'throw', error: Object.assign(new Error('入口正被另一次压缩占用'), { name: 'ManualCompactionError', code: 'busy' }) },
  })
  const busyReport = await busy.run()
  assert.equal(busy.engineCalls(), 1, 'busy 不重试：一次调用一个结论')
  assert.equal(busyReport.invocation?.status, 'busy')
  assert.equal(busyReport.outcome?.kind, 'busy')
  assert.equal(assessmentOf(busy, busyReport).actionState, 'failed')
  assert.ok(busyReport.steps.some((step) => step.startsWith('压缩调用：busy')))
  assert.ok((assessmentOf(busy, busyReport).actionNote ?? '').includes('禁止忙循环重试'))

  const changed = rig({
    state: base.state,
    pressureTokens: 950,
    behavior: { kind: 'throw', error: Object.assign(new Error('选中区间已变化'), { name: 'ManualCompactionError', code: 'changed' }) },
  })
  const changedReport = await changed.run()
  assert.equal(changed.engineCalls(), 1)
  assert.equal(changedReport.invocation?.status, 'changed')
  assert.equal(changedReport.outcome?.kind, 'busy', 'changed 与 busy 一样按"实际状态核对"的失败结论收口')
  assert.match(changedReport.outcome?.kind === 'busy' ? changedReport.outcome.detail : '', /changed/)

  const noPort = rig({ state: base.state, pressureTokens: 950, noPort: true })
  const noPortReport = await noPort.run()
  assert.equal(noPort.engineCalls(), 0)
  assert.equal(noPortReport.invocation?.called, false)
  assert.equal(noPortReport.invocation?.detail, '本部署没有可用的压缩入口')
  assert.equal(noPortReport.outcome?.kind, 'declined')
  assert.equal(assessmentOf(noPort, noPortReport).actionState, 'skipped', '没有入口：明确"没执行"，不留 running')
  assert.ok(noPortReport.notes.some((note) => note.includes('本部署没有可用的压缩入口')))
})

// —— 第 7 条：压缩后核对诚实 + 提交失败进 notes ——

test('质量链：没有观测入口不得宣称通过；提交失败进 notes，不许被吞（第 7 条）', async () => {
  const base = withClaimedTask()

  const blind = rig({ state: base.state, pressureTokens: 950, behavior: { kind: 'completed' }, verify: false })
  const blindReport = await blind.run()
  assert.equal(blindReport.invocation?.status, 'completed')
  assert.equal(blindReport.verification?.ok, false, 'completed 只代表调用返回：没有观测面就不许判通过')
  assert.ok((blindReport.verification?.missing ?? []).some((item) => item.startsWith('保留清单缺项：')))
  assert.equal(blindReport.outcome?.kind, 'shortfall')
  assert.equal(assessmentOf(blind, blindReport).actionState, 'failed')
  assert.ok(blindReport.notes.some((note) => note.includes('未提供 verifyObservation')))

  const failing = rig({
    state: base.state,
    pressureTokens: 950,
    behavior: { kind: 'completed' },
    failOn: (cmd) => (cmd.kind === 'context.applyActionOutcome' ? '台账已满：拒绝收口' : undefined),
  })
  const failingReport = await failing.run()
  assert.equal(failingReport.verification?.ok, true, '核对本身通过，失败发生在收口落盘')
  assert.equal(failingReport.outcome?.kind, 'done')
  assert.ok(failingReport.notes.some((note) => note.includes('动作结果未落盘') && note.includes('台账已满：拒绝收口')))
  assert.ok(failingReport.steps.some((step) => step.startsWith('结果收口：done（未落盘：台账已满：拒绝收口）')))
  assert.equal(assessmentOf(failing, failingReport).actionState, 'running', '收口没落盘：状态停在 running，不假装 done')
})

// —— 第 8 条：逐步回执 ——

test('质量链：观测/冻结/评估/清点/复核/调用/核对/收口每一步都进 steps（第 8 条）', async () => {
  const base = withClaimedTask()
  const run = rig({ state: base.state, pressureTokens: 950, behavior: { kind: 'completed', reclaimedTokens: 1234 } })
  const report = await run.run()

  assertOrderedSteps(report.steps, [
    '观测：指纹 ',
    '冻结：sessionRevision=',
    '评估已落盘：建议 compact',
    '压缩前清点：通过',
    '压缩前版本复核：无阻断性漂移（记录水位推进 1 条，只报告不阻断）',
    '进入执行：run_now 已落盘（actionState=running）',
    '压缩调用：completed（估算回收 ~1234 token）',
    '核对通过：',
    '结果收口：done（已落盘）',
  ])
  assert.equal(report.steps.length, 9, '这条链刚好九步：多一步少一步都要在用例里显式改口径')
  for (const step of report.steps) assert.ok(step.trim().length > 0, '步骤回执不许留空')
})

// —— 端到端 ——

test('端到端：低占用 + 覆盖缺口 → 只落 retrieve 建议，压缩零调用（§27.4）', async () => {
  const base = withClaimedTask()
  const run = rig({ state: base.state, pressureTokens: 120 })
  const report = await run.run()

  assert.equal(report.skipped, undefined)
  assert.equal(report.suggestedAction, 'retrieve')
  assert.equal(report.invocation, undefined)
  assert.equal(run.engineCalls(), 0)
  assert.deepEqual(run.commands.map((cmd) => cmd.kind), ['context.assess'], '低占用只记一条评估：不该动计划入口')
  const stored = assessmentOf(run, report)
  assert.equal(stored.suggestion, 'retrieve')
  assert.equal(stored.actionState, 'recorded')
  assert.ok(report.notes.some((note) => note.startsWith('建议 retrieve 未执行：')))
})

test('端到端：高占用 + idle 入口 + 端口就绪 → compactNow 恰好一次，核对通过收口 done（§27.5）', async () => {
  const base = withClaimedTask()
  const run = rig({ state: base.state, pressureTokens: 950, behavior: { kind: 'completed' } })
  const report = await run.run()

  assert.equal(run.engineCalls(), 1)
  assert.equal(report.invocation?.status, 'completed')
  assert.match(report.invocation?.detail ?? '', /^摘要：压缩摘要：保留目标、检查点与在途操作/)
  assert.equal(report.verification?.ok, true)
  assert.equal(report.outcome?.kind, 'done')
  assert.equal(report.outcome?.kind === 'done' ? report.outcome.effect?.reclaimedTokens : undefined, 1234, '效果单列：回收量写进 effect（§27.5 第 5 条）')
  assert.equal(report.outcome?.kind === 'done' ? report.outcome.effect?.restoredInfo : undefined, true)
  assert.deepEqual(run.commands.map((cmd) => cmd.kind), ['context.assess', 'context.applyRunPlan', 'context.applyActionOutcome'])
  const stored = assessmentOf(run, report)
  assert.equal(stored.actionState, 'done')
  assert.match(stored.actionNote ?? '', /必要信息已恢复/)
})

// —— D1 端口单测：真机压缩的错误面必须有明确结论 ——

test('compactionPort：null→refused、undefined→error、完成面读摘要与回收量（§27.5 第 3、4 条）', async () => {
  const counter = { calls: 0 }

  const refused = compactionPort(engineWith({ kind: 'refused' }, counter), AGENT)
  assert.equal((await refused.compactNow(SESSION)).status, 'refused')
  assert.match((await refused.compactNow(SESSION)).detail, /没有可安全压缩的区间/)

  const unreadable = compactionPort(engineWith({ kind: 'undefined' }, counter), AGENT)
  assert.equal((await unreadable.compactNow(SESSION)).status, 'error')
  assert.match((await unreadable.compactNow(SESSION)).detail, /未知 ≠ 成功|读不出压缩结果/)

  const done = compactionPort(engineWith({ kind: 'completed', reclaimedTokens: 4321 }, counter), AGENT)
  const completed = await done.compactNow(SESSION)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.reclaimedTokens, 4321)
  assert.match(completed.detail, /摘要：压缩摘要/)
  assert.equal(counter.calls, 5, '每次调用都真的打到引擎上（refused/undefined/完成各算一次）')

  // agent 缺 runMaintenance：拒绝调用无效入口，引擎一次都不该被打到。
  const before = counter.calls
  const invalid = compactionPort(engineWith({ kind: 'completed' }, counter), { id: 'sess-1' })
  const rejected = await invalid.compactNow(SESSION)
  assert.equal(rejected.status, 'error')
  assert.match(rejected.detail, /runMaintenance/)
  assert.equal(counter.calls, before, '入口不合法就不调用引擎')

  // agent 与观测会话不是同一个：不许把压缩打到别的会话上。
  const other = compactionPort(engineWith({ kind: 'completed' }, counter), { id: 'sess-2', runMaintenance: async (): Promise<void> => {} })
  assert.match((await other.compactNow(SESSION)).detail, /不一致/)
})

test('compactionPort：互斥入口不并发调用，第二次进即 busy（§27.5 第 3 条）', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const counter = { calls: 0 }
  const engine: CompactionEngineLike = {
    async compactNow(): Promise<unknown> {
      counter.calls += 1
      await gate
      return { summary: [{ type: 'text', text: '慢压缩' }], shadowedTokenCount: 7 }
    },
  }
  const port = compactionPort(engine, AGENT)
  const first = port.compactNow(SESSION)
  const concurrent = await port.compactNow(SESSION)
  assert.equal(concurrent.status, 'busy')
  assert.match(concurrent.detail, /不并发调用/)
  release()
  assert.equal((await first).status, 'completed')
  assert.equal(counter.calls, 1, '并发的那次没有打到引擎：只发生一次压缩')
})

test('mapCompactionError：busy/changed 按实际状态核对，cancelled 与其余 code 一律按失败处理（§27.5 第 3 条）', () => {
  assert.equal(mapCompactionError(Object.assign(new Error('忙'), { code: 'busy' })).status, 'busy')
  assert.equal(mapCompactionError(Object.assign(new Error('变了'), { code: 'changed' })).status, 'changed')
  const cancelled = mapCompactionError(Object.assign(new Error('会话侧取消'), { name: 'ManualCompactionError', code: 'cancelled' }))
  assert.equal(cancelled.status, 'error')
  assert.match(cancelled.detail, /cancelled/)
  assert.match(cancelled.detail, /按失败处理，不记成功/)
  const summary = mapCompactionError(Object.assign(new Error('摘要写入失败'), { code: 'summary' }))
  assert.equal(summary.status, 'error')
  assert.match(summary.detail, /code=summary/)
  const bare = mapCompactionError('引擎抛了一个字符串')
  assert.equal(bare.status, 'error')
  assert.match(bare.detail, /引擎抛了一个字符串/)
  const nonError = mapCompactionError({ message: '非 Error 对象' })
  assert.equal(nonError.status, 'error')
  assert.match(nonError.detail, /非 Error 对象/)
})

// —— D2 构造器：任务侧权威输入（§27.3 第 2–4 行、§27.4 第 2、6 行） ——

test('任务侧构造器：覆盖回执回绑、撤销即过期、悬挂依赖与待复核事实如实列出（第 2 条）', () => {
  const base = withClaimedTask()
  const checkpointId = must('检查点', base.state.checkpointOrder[base.state.checkpointOrder.length - 1])
  const evidence = recordEvidence(base.state, { summary: '台账与内核记录一致' })
  const claim = proposeClaim(evidence.state, { supportingEvidenceIds: [evidence.evidenceId] })
  const receipted = apply(
    claim.state,
    { kind: 'context.record', requestId: req(), context: contextInput('lead-1', { inputRefs: [evidence.evidenceId], claimRefs: [claim.claimId] }) },
    ctx('lead', 'lead-1', 'sess-1'),
  )
  const receiptId = addedKey(claim.state.contexts, receipted.contexts)
  const invalidArtifact = withVerifiedArtifact(receipted, { taskId: base.taskId, uri: 'reports/ledger.md', contentHash: 'sha256:cccc', validity: 'invalid' })
  const reviewArtifact = withVerifiedArtifact(invalidArtifact.state, { taskId: base.taskId, uri: 'reports/open.md', contentHash: 'sha256:dddd', validity: 'needs_review' })
  const task = must('任务', reviewArtifact.state.tasks[base.taskId])
  const broken: MissionControl = { ...reviewArtifact.state, tasks: { ...reviewArtifact.state.tasks, [base.taskId]: { ...task, dependsOn: ['tsk_gone'] } } }

  const required = coverageFromState(broken)
  const refs = required.map((item) => item.ref)
  assert.deepEqual(refs, [...refs].sort(), '清单按 ref 排序：回执可在不同宿主上复现')
  assert.deepEqual(refs, ['mss_discipline', checkpointId, evidence.evidenceId].sort())
  const evidenceItem = must('证据清单项', required.find((item) => item.ref === evidence.evidenceId))
  assert.equal(evidenceItem.receiptRef, receiptId, '回执按引用面回绑，绑不上就不填')
  assert.equal(evidenceItem.completeness, 'full')
  assert.equal(must('检查点清单项', required.find((item) => item.ref === checkpointId)).receiptRef, undefined, '没有回执的项不许编"已送达"')

  const fresh = freshnessRefsFromState(broken)
  const heads = must('结论引用', fresh.find((item) => item.ref === claim.claimId))
  assert.equal(heads.kind, 'conclusion')
  assert.equal(heads.currentVersion, 1)
  assert.equal(heads.withdrawn, undefined)
  const artifactRef = must('产物引用', fresh.find((item) => item.ref === 'reports/ledger.md'))
  assert.equal(artifactRef.kind, 'artifact')
  assert.equal(artifactRef.withdrawn, true, 'validity=invalid 的当前版本按已过期报')

  const findings = structuralFindingsFromState(broken)
  assert.deepEqual(findings.map((item) => item.kind), ['dangling_task_dependency'])
  assert.match(findings[0]?.detail ?? '', /tsk_gone/)

  const unverified = unverifiedFactsFromState(broken)
  assert.ok(unverified.some((fact) => fact.includes('reports/open.md') && fact.includes('needs_review')))
  assert.ok(!unverified.some((fact) => fact.includes('reports/ledger.md')), 'invalid 走新鲜度过期面，不重复算"待复核"')
})
