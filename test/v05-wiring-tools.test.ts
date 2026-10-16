/**
 * v0.5 模型面工具接线回归（设计稿 v0.5 §25–§35）。
 *
 * 工具层只做"参数 → 命令"的翻译，本文件盯五件事：
 * 1. **接通**：七个多路复用工具的 37 个 action 各自产出预期 kind，`action` 枚举覆盖全部 action，
 *    `requestId` 由工厂统一替换（空串不会到达内核）；
 * 2. **等价**：`details` 传对象与传 JSON 字符串产出同一条命令（含可选字段的条件展开）；
 * 3. **透传**：代表性字段（preregister 的 draft、revise 的 experimentId、observe 的 next、
 *    transition 的 event、recordBrief 的 brief）原样进命令，工具层不吞不改；
 * 4. **拒绝**：非法 JSON、未知 action、缺 details 各自给出理由，且**不**触达内核提交；
 * 5. **只读面**：`continuity_status` 追加的五个 aspect 在枚举末尾且接到各自渲染函数。
 *
 * 假内核按 `commandTool.execute` 的真实访问面构造（identity → CommandContext、read → 非 null
 * 状态、submit → 记录 (missionId, cmd, ctx) 并回执 execute 读到的字段），不复制内核判定；
 * 字段级校验故意不在工具层测——它住在内核与领域模块里。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  continuityConjectureTool,
  continuityEnvironmentTool,
  continuityExperimentTool,
  continuityIntegrationTool,
  continuityMechanismTool,
  continuityOutcomeTool,
  continuityRecordsTool,
  continuityStatusTool,
} from '../src/adapter/tools.ts'
import type { ToolDeps } from '../src/adapter/tools.ts'
import type { Command, CommandContext } from '../src/core/commands.ts'
import type { MissionControl } from '../src/core/control.ts'
import {
  renderEnvironmentMarkdown,
  renderGovernanceMarkdown,
  renderOutcomeMarkdown,
  renderRecordsMarkdown,
  renderWorkMarkdown,
} from '../src/views/export.ts'
import { NOW, freshState } from './fixtures.ts'

/* ------------------------------------------------------------------ 假内核与工具面 */

/** 多路复用工具用到的最小结构面（宿主桩按原样返回定义）。 */
interface MultiplexTool {
  readonly name: string
  readonly parameters: {
    readonly action: { readonly enum: readonly string[] }
    readonly details: Readonly<Record<string, unknown>>
  }
  execute(
    args: { readonly action: string; readonly details?: unknown },
    execution: { readonly agent?: { readonly id?: unknown } },
  ): Promise<{ readonly applied: boolean; readonly reason: string; readonly revision: number }>
}

/** `continuity_status` 用到的最小结构面。 */
interface StatusTool {
  readonly parameters: { readonly aspect: { readonly enum: readonly string[] } }
  execute(
    args: { readonly missionId?: string; readonly aspect?: string },
    execution: { readonly agent?: { readonly id?: unknown } },
  ): Promise<{ readonly markdown: string; readonly revision: number; readonly blockers: readonly string[] }>
}

interface SubmitCall {
  readonly missionId: string
  readonly cmd: Command
  readonly ctx: CommandContext
}

/**
 * 假内核只补真实 `commandTool.execute` 会读到的面：`read` 供 `requestId` 取修订号（7），
 * `submit` 记录调用并回执"已写入"（`effect` 与 `state.revision` 都会被 execute 读到）。
 */
function makeDeps(): { readonly deps: ToolDeps; readonly calls: SubmitCall[] } {
  const calls: SubmitCall[] = []
  const deps = {
    kernel: {
      read: async () => ({ revision: 7 }) as unknown as MissionControl,
      submit: async (missionId: string, cmd: Command, ctx: CommandContext) => {
        calls.push({ missionId, cmd, ctx })
        return { applied: true, effect: 'fake：已写入', state: { revision: 9 } as unknown as MissionControl }
      },
    },
    identity: async () => ({ actorId: 'lead_1', role: 'lead', now: NOW }),
    defaultMissionId: () => 'm_1',
  } as unknown as ToolDeps
  return { deps, calls }
}

/** 取出命令并钉住 kind：断言失败在本地炸，而不是在远处的字段断言里留下看不懂的差异。 */
function expectKind<K extends Command['kind']>(cmd: Command, kind: K): Extract<Command, { readonly kind: K }> {
  assert.equal(cmd.kind, kind)
  return cmd as Extract<Command, { readonly kind: K }>
}

/* ------------------------------------------------------------------ 37 个 action 的接线表 */

interface Case {
  readonly tool: (deps: ToolDeps) => MultiplexTool
  readonly action: string
  readonly kind: Command['kind']
  /** 覆盖该 action 必填字段的最小 details；字段语义由模块与内核校验，这里只管透传。 */
  readonly details: Readonly<Record<string, unknown>>
}

const CASES: readonly Case[] = [
  { tool: continuityExperimentTool, action: 'classifyWork', kind: 'experiment.classifyWork', details: { taskId: 't_1', workKind: 'explore' } },
  { tool: continuityExperimentTool, action: 'registerPolicy', kind: 'exploration.registerPolicy', details: { registration: { policyId: 'pol_1' } } },
  { tool: continuityExperimentTool, action: 'releaseReservation', kind: 'exploration.release', details: { reason: '本轮不再需要', recheck: '下轮开工前重查' } },
  { tool: continuityExperimentTool, action: 'restoreReservation', kind: 'exploration.restore', details: { reason: '额度已释放' } },
  { tool: continuityExperimentTool, action: 'preregister', kind: 'experiment.preregister', details: { draft: { hypothesis: 'H1', variable: 'v' } } },
  { tool: continuityExperimentTool, action: 'revise', kind: 'experiment.revise', details: { experimentId: 'exp_1', revision: { note: '范围收窄' } } },
  { tool: continuityExperimentTool, action: 'advanceStage', kind: 'experiment.advanceStage', details: { experimentId: 'exp_1', to: 'small_scale_validity', evidence: { summary: '小样本通过' } } },
  { tool: continuityExperimentTool, action: 'recordTrial', kind: 'experiment.recordTrial', details: { draft: { trialId: 'trial_1' } } },
  { tool: continuityExperimentTool, action: 'assessRoute', kind: 'route.assess', details: { input: { routeId: 'route_1' } } },
  { tool: continuityExperimentTool, action: 'decideStrategy', kind: 'strategy.decide', details: { draft: { decisionId: 'str_1' } } },

  { tool: continuityConjectureTool, action: 'capture', kind: 'conjecture.capture', details: { draft: { proposition: 'P1' } } },
  { tool: continuityConjectureTool, action: 'frame', kind: 'conjecture.frame', details: { claimId: 'claim_1', framing: { frame: '可测' } } },
  { tool: continuityConjectureTool, action: 'probeReady', kind: 'conjecture.probeReady', details: { claimId: 'claim_1', nextCheapestAction: '跑最小对照' } },
  { tool: continuityConjectureTool, action: 'recordProbe', kind: 'conjecture.recordProbe', details: { claimId: 'claim_1', trialId: 'trial_1' } },
  { tool: continuityConjectureTool, action: 'pursue', kind: 'conjecture.pursue', details: { claimId: 'claim_1', reason: '证据可及' } },
  { tool: continuityConjectureTool, action: 'defer', kind: 'conjecture.defer', details: { claimId: 'claim_1', deferralReason: 'budget', note: '等预算恢复' } },
  { tool: continuityConjectureTool, action: 'close', kind: 'conjecture.close', details: { claimId: 'claim_1', reason: '已判定' } },
  { tool: continuityConjectureTool, action: 'assumptionChange', kind: 'conjecture.assumptionChange', details: { claimId: 'claim_1', change: { from: 'a', to: 'b' } } },

  { tool: continuityEnvironmentTool, action: 'register', kind: 'environment.register', details: { input: { manifestId: 'env_1' } } },
  { tool: continuityEnvironmentTool, action: 'revise', kind: 'environment.revise', details: { environmentId: 'env_1', patch: { note: '路径更新' } } },
  { tool: continuityEnvironmentTool, action: 'openResume', kind: 'resume.open', details: { input: { resumeId: 'rs_1' } } },
  { tool: continuityEnvironmentTool, action: 'advanceResume', kind: 'resume.advance', details: { resumeId: 'rs_1', event: { kind: 'expected_captured' } } },
  { tool: continuityEnvironmentTool, action: 'assessResume', kind: 'resume.assess', details: { input: { resumeId: 'rs_1' } } },

  { tool: continuityMechanismTool, action: 'propose', kind: 'mechanism.propose', details: { input: { name: '定时核对' } } },
  { tool: continuityMechanismTool, action: 'revise', kind: 'mechanism.revise', details: { mechanismId: 'mech_1', patch: { note: '参数更新' } } },
  { tool: continuityMechanismTool, action: 'changeClass', kind: 'mechanism.changeClass', details: { mechanismId: 'mech_1', nextClass: 'optional_advisory', decision: { reason: '收益不足' } } },
  { tool: continuityMechanismTool, action: 'transition', kind: 'mechanism.transition', details: { mechanismId: 'mech_1', event: 'activate' } },
  { tool: continuityMechanismTool, action: 'recordRun', kind: 'mechanism.recordRun', details: { input: { runId: 'run_1' } } },
  { tool: continuityMechanismTool, action: 'recordMisreport', kind: 'mechanism.recordMisreport', details: { runId: 'run_1', verdict: 'yes', note: '事后补记' } },

  { tool: continuityOutcomeTool, action: 'register', kind: 'outcome.register', details: { input: { objective: '效果目标' } } },
  { tool: continuityOutcomeTool, action: 'observe', kind: 'outcome.observe', details: { next: 'observed' } },
  { tool: continuityOutcomeTool, action: 'review', kind: 'outcome.review', details: { triggers: ['pre_acceptance'], answers: [], conclusion: 'contract_holds' } },

  { tool: continuityIntegrationTool, action: 'plan', kind: 'integration.plan', details: { input: { planId: 'plan_1' } } },
  { tool: continuityIntegrationTool, action: 'revise', kind: 'integration.revise', details: { integrationId: 'int_1', input: { planId: 'plan_1' } } },
  { tool: continuityIntegrationTool, action: 'receipt', kind: 'integration.receipt', details: { input: { receiptId: 'rc_1' } } },

  { tool: continuityRecordsTool, action: 'recordCoverage', kind: 'records.recordCoverage', details: { coverage: { scope: 's' } } },
  { tool: continuityRecordsTool, action: 'recordBrief', kind: 'records.recordBrief', details: { brief: { briefId: 'b_1' } } },
]

/** 写死的 37 个 kind 全集：与 CASES 分开维护，漏一条或抄错一条都会在这里露出来。 */
const EXPECTED_KINDS: readonly string[] = [
  'experiment.classifyWork',
  'exploration.registerPolicy',
  'exploration.release',
  'exploration.restore',
  'experiment.preregister',
  'experiment.revise',
  'experiment.advanceStage',
  'experiment.recordTrial',
  'route.assess',
  'strategy.decide',
  'conjecture.capture',
  'conjecture.frame',
  'conjecture.probeReady',
  'conjecture.recordProbe',
  'conjecture.pursue',
  'conjecture.defer',
  'conjecture.close',
  'conjecture.assumptionChange',
  'environment.register',
  'environment.revise',
  'resume.open',
  'resume.advance',
  'resume.assess',
  'mechanism.propose',
  'mechanism.revise',
  'mechanism.changeClass',
  'mechanism.transition',
  'mechanism.recordRun',
  'mechanism.recordMisreport',
  'outcome.register',
  'outcome.observe',
  'outcome.review',
  'integration.plan',
  'integration.revise',
  'integration.receipt',
  'records.recordCoverage',
  'records.recordBrief',
]

/* ------------------------------------------------------------------ 用例 */

test('37 个 action 各自翻译成预期 kind，requestId 由工厂统一替换', async () => {
  for (const item of CASES) {
    const object = makeDeps()
    const tool = item.tool(object.deps)
    assert.ok(tool.parameters.action.enum.includes(item.action), `${tool.name} 的 action 枚举缺 ${item.action}`)

    const objectResult = await tool.execute({ action: item.action, details: item.details }, {})
    assert.equal(objectResult.applied, true, `${item.action} 应被提交：${objectResult.reason}`)
    assert.equal(objectResult.revision, 9)
    const [objectCall] = object.calls
    assert.ok(objectCall !== undefined, `${item.action} 未到达内核提交`)
    assert.equal(objectCall.missionId, 'm_1')
    assert.equal(objectCall.ctx.actorId, 'lead_1')
    expectKind(objectCall.cmd, item.kind)
    assert.ok(objectCall.cmd.requestId.startsWith(`${tool.name}:lead_1:`), `${item.action} 的 requestId 未被工厂替换：${objectCall.cmd.requestId}`)
    assert.ok(objectCall.cmd.requestId.endsWith(':7'), `${item.action} 的 requestId 未带当前修订号：${objectCall.cmd.requestId}`)

    const json = makeDeps()
    const jsonResult = await item.tool(json.deps).execute({ action: item.action, details: JSON.stringify(item.details) }, {})
    assert.equal(jsonResult.applied, true, `${item.action} 的 JSON 字符串 details 应被提交：${jsonResult.reason}`)
    const [jsonCall] = json.calls
    assert.ok(jsonCall !== undefined, `${item.action} 的 JSON 字符串路径未到达内核`)
    assert.deepEqual(jsonCall.cmd, objectCall.cmd, `${item.action} 的对象与 JSON 字符串 details 应产出同一条命令`)
  }
})

test('37 个 action 的 kind 全集与写死名单一致', () => {
  assert.equal(CASES.length, 37)
  const kinds = CASES.map((item) => item.kind)
  assert.equal(new Set(kinds).size, 37, 'kind 出现重复：有 action 的映射被抄错了')
  assert.deepEqual([...new Set(kinds)].sort(), [...EXPECTED_KINDS].sort())
})

test('details 的代表性字段原样透传，可选字段缺省时不写入', async () => {
  const preregister = makeDeps()
  const draft = { hypothesis: 'H1', variable: 'v', metric: 'm' }
  await continuityExperimentTool(preregister.deps).execute({ action: 'preregister', details: { draft } }, {})
  const preregisterCmd = expectKind(preregister.calls[0]!.cmd, 'experiment.preregister')
  assert.deepEqual(preregisterCmd.draft, draft)

  const revise = makeDeps()
  await continuityExperimentTool(revise.deps).execute({ action: 'revise', details: { experimentId: 'exp_42', revision: { note: 'r' } } }, {})
  const reviseCmd = expectKind(revise.calls[0]!.cmd, 'experiment.revise')
  assert.equal(reviseCmd.experimentId, 'exp_42')
  assert.deepEqual(reviseCmd.revision, { note: 'r' })

  const observe = makeDeps()
  await continuityOutcomeTool(observe.deps).execute({ action: 'observe', details: { next: 'observed' } }, {})
  const observeCmd = expectKind(observe.calls[0]!.cmd, 'outcome.observe')
  assert.equal(observeCmd.next, 'observed')
  assert.equal('note' in observeCmd, false)
  assert.equal('evidenceRefs' in observeCmd, false)

  const transition = makeDeps()
  await continuityMechanismTool(transition.deps).execute({ action: 'transition', details: { mechanismId: 'mech_1', event: 'activate', detail: { reason: '收益达标' } } }, {})
  const transitionCmd = expectKind(transition.calls[0]!.cmd, 'mechanism.transition')
  assert.equal(transitionCmd.event, 'activate')
  assert.deepEqual(transitionCmd.detail, { reason: '收益达标' })

  const record = makeDeps()
  const brief = { briefId: 'b_1', summary: 's' }
  await continuityRecordsTool(record.deps).execute({ action: 'recordBrief', details: { brief } }, {})
  const recordCmd = expectKind(record.calls[0]!.cmd, 'records.recordBrief')
  assert.deepEqual(recordCmd.brief, brief)
})

test('非法 JSON、未知 action、缺 details 各自给理由且不触达内核', async () => {
  const { deps, calls } = makeDeps()
  const tool = continuityExperimentTool(deps)

  const badJson = await tool.execute({ action: 'preregister', details: '{"draft":' }, {})
  assert.equal(badJson.applied, false)
  assert.equal(badJson.revision, 0)
  assert.match(badJson.reason, /details 不是合法 JSON/)

  const scalar = await tool.execute({ action: 'preregister', details: '"draft"' }, {})
  assert.equal(scalar.applied, false)
  assert.match(scalar.reason, /需要 details/)

  const unknown = await tool.execute({ action: 'no_such_action', details: {} }, {})
  assert.equal(unknown.applied, false)
  assert.match(unknown.reason, /未知 action/)

  const missing = await tool.execute({ action: 'preregister' }, {})
  assert.equal(missing.applied, false)
  assert.match(missing.reason, /需要 details/)

  const array = await tool.execute({ action: 'preregister', details: '[1,2]' }, {})
  assert.equal(array.applied, false)
  assert.match(array.reason, /需要 details/)

  assert.equal(calls.length, 0, '拒绝路径不应到达内核提交')
})

test('continuity_status 的 aspect 在枚举末尾追加五个 v0.5 视图', () => {
  const status = continuityStatusTool(makeDeps().deps) as unknown as StatusTool
  assert.deepEqual(
    status.parameters.aspect.enum,
    ['overview', 'discipline', 'obligations', 'authorization', 'deliveries', 'validators', 'work', 'records', 'environment', 'governance', 'outcome'],
  )
})

test('continuity_status 的五个新 aspect 接到对应渲染函数', async () => {
  const state = freshState()
  const deps = {
    kernel: { read: async () => state, submit: async () => { throw new Error('只读工具不应提交命令') } },
    identity: async () => ({ actorId: 'lead_1', role: 'lead', now: NOW }),
    defaultMissionId: () => 'm_1',
  } as unknown as ToolDeps
  const status = continuityStatusTool(deps) as unknown as StatusTool

  const expected: Readonly<Record<string, string>> = {
    work: renderWorkMarkdown(state),
    records: renderRecordsMarkdown(state),
    environment: renderEnvironmentMarkdown(state),
    governance: renderGovernanceMarkdown(state),
    outcome: renderOutcomeMarkdown(state),
  }
  for (const [aspect, markdown] of Object.entries(expected)) {
    const result = await status.execute({ aspect }, {})
    assert.equal(result.markdown, markdown, `aspect=${aspect} 未接到对应渲染函数`)
    assert.equal(result.revision, state.revision)
  }
})
