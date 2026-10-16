/**
 * v0.5 完成判定诊断接线回归（§30.3、§31.3、§34.4、§35.3）。
 *
 * 核心口径：v0.5 长期面的四类容器只产生**非阻断诊断**——它们改变"还能宣称什么"，
 * 不改变收口结构条件；本文件断言四个容器全部就位时 `ready` 仍为 true、`missing` 为空。
 * 容器一律走模块写侧函数搭（与 v05-* 其余用例同一手法），只有过期回执是手挂：
 * 写路径造不出"绑定修订被回退"的历史，读取侧只需展示所需字段。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { MissionControl } from '../src/core/control.ts'
import type { IntegrationReceipt } from '../src/core/entities.ts'
import { missionCompletion } from '../src/core/completion.ts'
import type { ConjectureDraft } from '../src/core/experiment.ts'
import { captureConjecture, closeConjectureInScope } from '../src/core/experiment.ts'
import type { MechanismInput } from '../src/core/governance.ts'
import { proposeMechanism, transitionMechanism } from '../src/core/governance.ts'
import type { OutcomeContractInput } from '../src/core/outcome.ts'
import { registerOutcomeContract } from '../src/core/outcome.ts'
import { NOW, draftMission, freshState } from './fixtures.ts'

/* ------------------------------------------------------------------ 夹具助手 */

/** `Extract` 只对字面量判别联合有效；`MechanismWrite` 这类 `ok: boolean` 接口会推成 never，落空时回退 T。 */
type OkBranch<T> = Extract<T, { readonly ok: true }> extends never ? T : Extract<T, { readonly ok: true }>

function mustOk<T extends { readonly ok: boolean }>(result: T, label: string): OkBranch<T> {
  if (!result.ok) {
    throw new Error(`${label} 被拒：${(result as { readonly reason?: string }).reason ?? '（未给理由）'}`)
  }
  return result as OkBranch<T>
}

function mustApply<T extends { readonly applied: boolean; readonly state: MissionControl }>(result: T, label: string): T & { readonly applied: true } {
  if (!result.applied) {
    throw new Error(`${label} 被拒：${(result as { readonly reason?: string }).reason ?? '（未给理由）'}`)
  }
  return result as T & { readonly applied: true }
}

/** 完成判定的干净基线：无任务、无 Mission 判据 ⇒ ready=true，用来隔离"诊断不阻断"。 */
function base(): MissionControl {
  return freshState({ mission: { ...draftMission(), criteria: [] } })
}

function contractInput(): OutcomeContractInput {
  return {
    intendedUse: '分析师在换环境后重复运行同一分析流程',
    desiredOutcome: '流程在干净环境一次跑通并给出可解释输出',
    acceptanceExamples: [
      { kind: 'success', text: '新环境按文档运行得到与基线一致的关键结论' },
      { kind: 'boundary', text: '输入为空时给出明确报错而不是静默输出空表' },
    ],
    metricsAndLimits: [
      { metric: '端到端运行成功率', represents: '流程可重复运行的稳定程度', cannotRepresent: '结论被用户实际采纳的程度' },
    ],
    hardConstraints: [{ text: '不得改动业务仓库', source: '用户 2026-10-14 指令' }],
    preferencesAndTradeoffs: [],
    unresolvedAssumptions: [{ text: '目标环境 Python ≥ 3.11', advanceScope: '先按当前锁定版本推进，发布前提早确认' }],
    effectObservation: { state: 'outcome_pending', note: '交付完成，等待实际使用效果' },
  }
}

function conjectureDraft(): ConjectureDraft {
  return {
    proposition: '猜想：瓶颈来自表征方式',
    assumptionChange: '直接替换表征层，跳过调参',
    sourceNote: '来源：反常观测——调参收益递减',
    expectedSignals: ['判别器分数上升'],
    competingExplanations: ['样本量增加也能解释'],
    nextCheapestAction: '跑一次小样本对照',
  }
}

function mechanismInput(): MechanismInput {
  return {
    mechanismId: 'mech_c',
    name: '语义质量建议',
    class: 'optional_advisory',
    purpose: '对交付文本做语义质量评分',
    triggers: ['交付前'],
    requiredInputs: ['delivery.ref'],
    relevantRevisions: ['criteriaRevision'],
    scope: 'mission',
    benefitSignal: '发现措辞与判据不一致的次数',
    proposedBy: 'lead-1',
  }
}

function driftedReceipt(): IntegrationReceipt {
  return {
    receiptId: 'irct_ghost',
    missionId: 'mss_test',
    integrationId: 'intg_ghost',
    artifactFingerprint: 'hash-x',
    componentRefs: [],
    // 绑定修订回退一位：当前 objectiveRevision 必然更高，按 §34.4 该回执已不再证明当前整体。
    objectiveRevision: 0,
    criteriaRevision: 0,
    checks: [],
    reusedComponentRefs: [],
    reworkTaskIds: [],
    publishEligible: false,
    decidedBy: 'lead-1',
    createdAt: NOW,
  }
}

/* ------------------------------------------------------------------ 用例 */

test('干净基线：无 v0.5 容器时 ready=true 且不出现长期面诊断', () => {
  const report = missionCompletion(base())
  assert.equal(report.ready, true)
  assert.deepEqual(report.missing, [])
  assert.equal(report.diagnostics, undefined)
})

test('四类长期面诊断逐条出现且不阻断收口', () => {
  let state = mustOk(
    registerOutcomeContract(base(), contractInput(), { actorId: 'sup-1', now: NOW + 1, source: 'supervisor' }),
    '目标契约登记',
  ).state
  const captured = mustApply(captureConjecture(state, conjectureDraft(), NOW + 2, 'lead-1'), '猜想登记')
  state = captured.state
  state = mustOk(proposeMechanism(state, mechanismInput(), NOW + 3), '机制登记').state
  state = mustOk(transitionMechanism(state, 'mech_c', 'start_observing', NOW + 4, { reason: '先观察一个周期再决定是否进入服务' }), '机制进入观察').state
  state = mustOk(
    transitionMechanism(state, 'mech_c', 'enter_cooling', NOW + 5, { reason: '连续两次延迟交付待复核', resumeWhen: '成本与收益重新评估通过后再检查能力' }),
    '机制进入冷却',
  ).state
  state = { ...state, integrationReceipts: { irct_ghost: driftedReceipt() } }

  const report = missionCompletion(state)
  assert.equal(report.ready, true, '长期面容器不得阻断收口结构条件')
  assert.deepEqual(report.missing, [])

  const diagnostics = report.diagnostics ?? []
  assert.equal(diagnostics.length, 4)
  assert.ok(
    diagnostics.some((line) => line.includes('效果观测仍为 outcome_pending')),
    'outcome_pending 要如实提示：可按原范围完成，但不能宣称长期效果已发生',
  )
  assert.ok(diagnostics.some((line) => line.includes(`1 条猜想仍在追踪：${captured.claimId}`)))
  assert.ok(diagnostics.some((line) => line.includes('整合回执与当前版本不一致（§34.4）：irct_ghost')))
  assert.ok(diagnostics.some((line) => line.includes('机制按范围停用需处理：mech_c')))
})

test('按范围关闭的猜想不再计入追踪', () => {
  const captured = mustApply(captureConjecture(base(), conjectureDraft(), NOW + 1, 'lead-1'), '猜想登记')
  const closed = mustApply(
    closeConjectureInScope(captured.state, captured.claimId, { reason: '范围外证据已足：先按当前表征推进' }, NOW + 2, 'lead-1'),
    '猜想关闭',
  )
  const report = missionCompletion(closed.state)
  assert.equal(report.ready, true)
  assert.equal(report.diagnostics, undefined, 'closed_in_scope 是追踪终点，不该再产生诊断')
})
