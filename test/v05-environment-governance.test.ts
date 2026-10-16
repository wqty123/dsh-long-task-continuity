/**
 * v0.5 环境接续与治理（设计稿 §33、§35）的单元用例。
 *
 * 每个判定都配正反例：表格里说放行的一侧必须放行，说拦住的一侧必须拦住，
 * 而且拦的方向要 fail-closed（未知 / 未覆盖 / 身份不足一律不当作"没问题"）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ArtifactVersion, MechanismPolicy, MechanismRun } from '../src/core/entities.ts'
import type { MissionControl } from '../src/core/control.ts'
import { availability } from '../src/core/budget.ts'
import { NOW, freshState, withClaimedTask } from './fixtures.ts'
import type { AssessInput, EnvironmentItem, FindingInput, JobObservation, PreservationPlan } from '../src/core/environment.ts'
import {
  DEFAULT_VALIDITY_POLICY,
  FINDING_ACTIONS,
  advanceResume,
  assessResume,
  classifyFinding,
  environmentGaps,
  guardedWrite,
  jobIdentity,
  openResume,
  planChecks,
  preservationPlan,
  registerEnvironment,
  resumeIsCurrent,
  revalidationPlan,
  reviseEnvironment,
  validUntilFor,
  validityWindowMs,
} from '../src/core/environment.ts'
import type { MechanismInput } from '../src/core/governance.ts'
import {
  BREAKER_NO_CHANGE_STREAK,
  BREAKER_TIMEOUT_STREAK,
  MIN_BENEFIT_OBSERVATIONS,
  applyBreaker,
  assessBenefit,
  breakerFor,
  changeMechanismClass,
  dispositionFor,
  dispositionForMechanism,
  exitVerdict,
  governanceCacheKey,
  governanceCostOf,
  mechanismAvailability,
  mechanismHead,
  mechanismSpend,
  proposeMechanism,
  recordMechanismRun,
  recordMisreport,
  recheckAfterCooldown,
  reviseMechanism,
  transitionMechanism,
  triggerLayer,
} from '../src/core/governance.ts'

/* ------------------------------------------------------------------ 夹具 */

function item(overrides: Partial<EnvironmentItem> = {}): EnvironmentItem {
  return {
    kind: 'workspace',
    ref: 'env:ws',
    expected: '分支 main',
    observeMethod: 'git status --short',
    sensitivity: 'variable',
    changeAction: '更新清单并重验受影响结果',
    coverage: 'covered',
    ...overrides,
  }
}

function observation(overrides: Partial<FindingInput> = {}): FindingInput {
  return { kind: 'workspace', ref: 'env:ws', sensitivity: 'variable', observation: 'match', ...overrides }
}

function job(overrides: Partial<JobObservation> = {}): JobObservation {
  return { state: 'running', ...overrides }
}

function artifact(overrides: Partial<ArtifactVersion> = {}): ArtifactVersion {
  return {
    artifactId: 'art_1',
    missionId: 'mss_test',
    version: 1,
    uri: 'file:///tmp/report.md',
    contentHash: 'hash-1',
    hashAlgorithm: 'sha256',
    createdBy: 'lead-1',
    registeredBy: 'lead-1',
    attribution: 'tool_operation',
    status: 'draft',
    published: false,
    validity: 'current',
    withdrawalPending: false,
    registeredAt: NOW,
    ...overrides,
  }
}

function mech(overrides: Partial<MechanismInput> = {}): MechanismInput {
  return {
    name: '语义质量建议',
    class: 'optional_advisory',
    purpose: '对交付文本做语义质量评分',
    triggers: ['交付前'],
    requiredInputs: ['delivery.ref'],
    relevantRevisions: ['criteriaRevision'],
    scope: 'mission',
    benefitSignal: '发现措辞与判据不一致的次数',
    proposedBy: 'lead-1',
    ...overrides,
  }
}

function run(overrides: Partial<MechanismRun> = {}): MechanismRun {
  return {
    runId: 'mrun_1',
    missionId: 'mss_test',
    mechanismId: 'mech_1',
    mechanismVersion: 1,
    trigger: 'delivery',
    startedAt: NOW,
    outputNote: '',
    actualAction: 'checked',
    ...overrides,
  }
}

/** 建一个已登记清单且评估就绪的环境，供后续判定复用。 */
function withEnvironment(items: readonly EnvironmentItem[], nextAction = '运行测试脚本'): { readonly state: MissionControl; readonly environmentId: string } {
  const registered = registerEnvironment(freshState(), {
    nextAction,
    items,
    authorActorId: 'lead-1',
  }, NOW)
  assert.equal(registered.ok, true)
  return { state: registered.state, environmentId: registered.environment?.environmentId ?? '' }
}

function assess(
  state: MissionControl,
  environmentId: string,
  observations: readonly FindingInput[],
  extra: Partial<AssessInput> = {},
): ReturnType<typeof assessResume> {
  return assessResume(state, {
    environmentId,
    targetIdentity: 'acct:default',
    decidedBy: 'supervisor',
    observations,
    ...extra,
  }, NOW + 1_000)
}

/* ------------------------------------------------- §33.1 清单与检查范围 */

test('planChecks：由下一步需要什么决定检查什么；认不出时退回保守集合', () => {
  const runPlan = planChecks('运行测试脚本并检查依赖')
  assert.equal(runPlan.recognized, true)
  for (const kind of ['runtime', 'dependency', 'workspace'] as const) {
    assert.equal(runPlan.kinds.includes(kind), true, `下一步要跑测试，必须查 ${kind}`)
  }
  const unknownPlan = planChecks('随便看看')
  assert.equal(unknownPlan.recognized, false, '认不出动作时不能假装推出了检查范围')
  assert.deepEqual([...unknownPlan.kinds], ['workspace', 'runtime', 'dependency', 'input_data'])
  assert.match(unknownPlan.note, /保守/)
})

test('registerEnvironment：登记版本 1；凭证内容 / 缺核验方法 / 重复登记被拒', () => {
  const ok = registerEnvironment(freshState(), { nextAction: '运行测试脚本', items: [item()], authorActorId: 'lead-1' }, NOW)
  assert.equal(ok.ok, true)
  assert.equal(ok.environment?.version, 1)
  assert.equal(ok.environment?.supersedesVersion, undefined)
  assert.equal(ok.state.revision, 1, '登记经 commit() 推进修订')

  const secretRef = item({ ref: 'config:api_key', expected: 'token=abcdefghijklmnopqrstuvwxyz', coverage: 'covered' })
  const secret = registerEnvironment(freshState(), { nextAction: '调用远程', items: [secretRef], authorActorId: 'lead-1' }, NOW)
  assert.equal(secret.ok, false, '密钥不能复制进清单，只保存服务引用（§33.1）')
  assert.match(secret.reason ?? '', /服务引用/)

  const noMethod = registerEnvironment(freshState(), { nextAction: '运行测试', items: [item({ observeMethod: ' ' })], authorActorId: 'lead-1' }, NOW)
  assert.equal(noMethod.ok, false)
  assert.match(noMethod.reason ?? '', /发现方法/)

  const first = registerEnvironment(freshState(), { environmentId: 'env_x', nextAction: '运行测试', items: [item()], authorActorId: 'lead-1' }, NOW)
  const again = registerEnvironment(first.state, { environmentId: 'env_x', nextAction: '运行测试', items: [item()], authorActorId: 'lead-1' }, NOW)
  assert.equal(again.ok, false, '同一幂等键重放不产生第二条链')
  assert.match(again.reason ?? '', /已存在/)
})

test('reviseEnvironment：链上追加版本并指回上一版；未知清单与违规项被拒', () => {
  const first = registerEnvironment(freshState(), { nextAction: '运行测试脚本', items: [item()], authorActorId: 'lead-1' }, NOW)
  const environmentId = first.environment?.environmentId ?? ''
  const revised = reviseEnvironment(first.state, environmentId, { nextAction: '提交到远程分支', items: [item({ ref: 'env:branch', kind: 'branch' })] }, NOW + 10, 'lead-1')
  assert.equal(revised.ok, true)
  assert.equal(revised.environment?.version, 2)
  assert.equal(revised.environment?.supersedesVersion, 1)
  assert.equal(revised.state.environments[environmentId]?.length, 2, '旧版本留在链里可追溯')
  assert.equal(revised.environment?.environmentId, environmentId)

  const missing = reviseEnvironment(revised.state, 'env_missing', { nextAction: '别的' }, NOW + 20, 'lead-1')
  assert.equal(missing.ok, false)
  const badItems = reviseEnvironment(revised.state, environmentId, { items: [item({ ref: 'x', expected: 'secret=abcdefghijklmnopqrstuvwx' })] }, NOW + 30, 'lead-1')
  assert.equal(badItems.ok, false)
  assert.equal(badItems.state.environments[environmentId]?.length, 2, '被拒的修订不落链')
})

test('environmentGaps：unknown 项与下一步未覆盖的种类显式列出', () => {
  const { state, environmentId } = withEnvironment([
    item({ kind: 'workspace', ref: 'env:ws' }),
    item({ kind: 'input_data', ref: 'env:data', coverage: 'unknown' }),
  ])
  const manifest = state.environments[environmentId]?.[0]
  assert.notEqual(manifest, undefined)
  const gaps = environmentGaps(manifest!)
  assert.deepEqual([...gaps.unknownRefs], ['env:data'])
  assert.deepEqual([...gaps.missingKinds], ['runtime', 'dependency'])
  assert.equal(gaps.complete, false)

  const covered = withEnvironment([
    item({ kind: 'workspace', ref: 'env:ws' }),
    item({ kind: 'runtime', ref: 'env:py' }),
    item({ kind: 'dependency', ref: 'env:req' }),
  ])
  const complete = environmentGaps(covered.state.environments[covered.environmentId]?.[0]!)
  assert.equal(complete.complete, true)
  assert.match(complete.note, /不声称快照完整/)
})

/* -------------------------------------------------- §33.2 七值发现判定 */

test('classifyFinding：不变 / 变化两行——immutable 复用原验证，variable 只重验受影响结果', () => {
  const unchanged = classifyFinding(observation({ sensitivity: 'immutable' }))
  assert.equal(unchanged.entry.finding, 'unchanged')
  assert.equal(unchanged.entry.allowedScope, '相关任务继续')
  assert.equal(unchanged.entry.action, FINDING_ACTIONS.unchanged.action)

  const changed = classifyFinding(observation({ observation: 'changed' }))
  assert.equal(changed.entry.finding, 'changed')
  assert.equal(changed.entry.allowedScope, '无关任务不重跑')

  // 反例：观测说"一致"但版本校验值不一致——版本说话，不因观测措辞放过。
  const versionDrift = classifyFinding(observation({ expectedVersion: 'v1', observedVersion: 'v2' }))
  assert.equal(versionDrift.entry.finding, 'changed')
  assert.match(versionDrift.notes.join(' '), /不一致/)
})

test('classifyFinding：未覆盖项不能声称 unchanged（反例）', () => {
  const verdict = classifyFinding(observation({ coverage: 'unknown' }))
  assert.equal(verdict.entry.finding, 'changed', '清单标 unknown 的项即使这次看起来一致也不能按 unchanged 放行')
  assert.match(verdict.notes.join(' '), /unknown/)
})

test('classifyFinding：临时文件缺失 / 越权恢复两行', () => {
  const temp = classifyFinding(observation({ kind: 'temp_artifact', ref: 'tmp:cache', observation: 'missing' }))
  assert.equal(temp.entry.finding, 'temp_missing')
  assert.equal(temp.entry.allowedScope, '核对结果后继续')

  const needsAuth = classifyFinding(observation({ recoveryRequiresNewAuthorization: true }))
  assert.equal(needsAuth.entry.finding, 'needs_authorization', '越权恢复是硬约束，先于版本比对判定')
  assert.equal(needsAuth.entry.allowedScope, '已独立满足条件的工作仍可进行')

  const irreversible = classifyFinding(observation({ recoveryTouchesSharedResourceIrreversibly: true }))
  assert.equal(irreversible.entry.finding, 'needs_authorization')
})

test('classifyFinding：在途作业四行——running / done_no_receipt / done_with_receipt / unknown', () => {
  const running = classifyFinding(observation({ kind: 'in_flight_job', ref: 'job:train', observation: 'unobserved', job: job({ serviceJobId: 'svc-77' }) }))
  assert.equal(running.entry.finding, 'job_running')
  assert.equal(running.entry.allowedScope, '不另启重复作业')

  const noReceipt = classifyFinding(observation({ kind: 'in_flight_job', ref: 'job:train', observation: 'unobserved', job: job({ serviceJobId: 'svc-77', state: 'done', receiptPresent: false }) }))
  assert.equal(noReceipt.entry.finding, 'job_done_no_receipt')
  assert.equal(noReceipt.entry.allowedScope, '不重发原动作')

  const withReceipt = classifyFinding(observation({ kind: 'in_flight_job', ref: 'job:train', observation: 'unobserved', job: job({ serviceJobId: 'svc-77', state: 'done', receiptPresent: true }) }))
  assert.equal(withReceipt.entry.finding, 'changed', '已完成且带回执：核对产物并更新清单，不重发')

  const unreachable = classifyFinding(observation({ kind: 'in_flight_job', ref: 'job:train', observation: 'unobserved', job: job({ serviceJobId: 'svc-77', state: 'unreachable' }) }))
  assert.equal(unreachable.entry.finding, 'job_unknown')
  assert.equal(unreachable.entry.allowedScope, '暂停冲突动作，保留诊断与取消入口')

  const noObservation = classifyFinding(observation({ kind: 'in_flight_job', ref: 'job:train', observation: 'unobserved' }))
  assert.equal(noObservation.entry.finding, 'job_unknown', '没有作业证据不能证明旧任务已结束')
})

test('jobIdentity：服务 job ID 或主机/进程启动身份组合；单一 PID 不够（反例）', () => {
  const byService = jobIdentity(job({ serviceJobId: 'svc-77' }))
  assert.equal(byService.sufficient, true)
  assert.equal(byService.identity, 'service:svc-77')

  const byProcess = jobIdentity(job({ host: 'build-01', processRef: 'run:42', startedAt: 1234 }))
  assert.equal(byProcess.sufficient, true)
  assert.equal(byProcess.identity, 'host:build-01/proc:run:42@1234')

  const pidOnly = jobIdentity(job({ pid: 4242 }))
  assert.equal(pidOnly.sufficient, false)
  assert.match(pidOnly.reason, /PID/)

  const runningPidOnly = classifyFinding(observation({ kind: 'in_flight_job', ref: 'job:train', observation: 'unobserved', job: job({ pid: 4242 }) }))
  assert.equal(runningPidOnly.entry.finding, 'job_unknown', '身份不足时不能声称"还是那个作业在跑"')
})

/* ------------------------------------------------ §33.3 评估阶段机 */

test('openResume：绑定清单修订与当前 Attempt；错绑定 / 错版本被拒', () => {
  const { state, environmentId } = withEnvironment([item()])
  const opened = openResume(state, { environmentId, targetIdentity: 'acct:default', decidedBy: 'supervisor' }, NOW)
  assert.equal(opened.ok, true)
  assert.equal(opened.resume?.phase, 'capture_expected')
  assert.equal(opened.resume?.environmentVersion, 1)
  assert.equal(opened.state.revision, state.revision + 1)

  const missing = openResume(state, { environmentId: 'env_none', targetIdentity: 'acct:default', decidedBy: 'supervisor' }, NOW)
  assert.equal(missing.ok, false)

  const wrongVersion = openResume(state, { environmentId, environmentVersion: 99, targetIdentity: 'acct:default', decidedBy: 'supervisor' }, NOW)
  assert.equal(wrongVersion.ok, false)

  const claimed = withClaimedTask()
  const bound = registerEnvironment(claimed.state, { nextAction: '改代码', items: [item()], authorActorId: 'lead-1', taskId: claimed.taskId, attemptId: claimed.attemptId }, NOW)
  const mismatched = openResume(bound.state, {
    environmentId: bound.environment?.environmentId ?? '',
    taskId: claimed.taskId,
    attemptId: 'att_other',
    targetIdentity: 'acct:default',
    decidedBy: 'supervisor',
  }, NOW)
  assert.equal(mismatched.ok, false, '评估必须绑定当前 Attempt（§33.3）')
  assert.match(mismatched.reason ?? '', /当前尝试/)
})

test('advanceResume：阶段机不跳步，身份对不上时写 needs_authorization 继续走', () => {
  const { state, environmentId } = withEnvironment([item()])
  const opened = openResume(state, { environmentId, targetIdentity: 'acct:default', decidedBy: 'supervisor' }, NOW)
  const resumeId = opened.resume?.resumeId ?? ''
  let current = opened.state

  const skip = advanceResume(current, resumeId, { kind: 'revalidation_settled', ok: true, note: '跳过阶段' }, NOW)
  assert.equal(skip.ok, false)
  assert.match(skip.reason ?? '', /不跳步/)

  const captured = advanceResume(current, resumeId, { kind: 'expected_captured' }, NOW)
  assert.equal(captured.ok, true)
  current = captured.state
  const again = advanceResume(current, resumeId, { kind: 'expected_captured' }, NOW)
  assert.equal(again.ok, false)

  const inspected = advanceResume(current, resumeId, {
    kind: 'current_inspected',
    observedAt: NOW + 5,
    targetIdentityObserved: 'acct:other',
  }, NOW + 6)
  assert.equal(inspected.resume?.phase, 'classify_drift')
  assert.equal(inspected.resume?.findings[0]?.ref, 'target_identity')
  assert.equal(inspected.resume?.findings[0]?.finding, 'needs_authorization', '身份不一致不回落默认账户（§22.13）')
  assert.equal(inspected.resume?.checkedAt, NOW + 5)
  assert.equal(inspected.resume?.validUntil, NOW + 5 + DEFAULT_VALIDITY_POLICY.variableMs, '有效期按波动性算，不是统一小时数')

  const drift = advanceResume(inspected.state, resumeId, {
    kind: 'drift_classified',
    findings: [classifyFinding(observation({ observation: 'changed' })).entry],
  }, NOW + 7)
  assert.equal(drift.resume?.phase, 'repair_or_reconcile')

  const blocked = advanceResume(drift.state, resumeId, { kind: 'repair_settled', unresolvedRefs: ['env:ws'] }, NOW + 8)
  assert.equal(blocked.resume?.phase, 'blocked_scope')
  const afterTerminal = advanceResume(blocked.state, resumeId, { kind: 'repair_settled', unresolvedRefs: [] }, NOW + 9)
  assert.equal(afterTerminal.ok, false, '终态不再受理事件')

  const ready = advanceResume(drift.state, resumeId, { kind: 'repair_settled', unresolvedRefs: [] }, NOW + 8)
  assert.equal(ready.resume?.phase, 'revalidate')
  const notOk = advanceResume(ready.state, resumeId, { kind: 'revalidation_settled', ok: false, note: '受影响结果未通过重验' }, NOW + 9)
  assert.equal(notOk.resume?.phase, 'blocked_scope')
})

/* -------------------------------------------- §33.3 / §33.4 时效与恢复 */

test('validUntilFor：有效期取最短窗口，在途作业比不可变输入短得多', () => {
  const mixed = validUntilFor([item({ sensitivity: 'immutable' }), item({ ref: 'env:dep', sensitivity: 'variable' })], NOW)
  assert.equal(mixed, NOW + DEFAULT_VALIDITY_POLICY.variableMs)
  const immutableOnly = validUntilFor([item({ sensitivity: 'immutable' })], NOW)
  assert.equal(immutableOnly, NOW + DEFAULT_VALIDITY_POLICY.immutableMs)
  const jobItem = item({ kind: 'in_flight_job', ref: 'job:train', sensitivity: 'immutable' })
  assert.equal(validityWindowMs(jobItem), DEFAULT_VALIDITY_POLICY.inFlightJobMs)
  assert.equal(validUntilFor([], NOW), NOW, '没有核验项时有效期为 0，宁可立即重查')
})

test('resumeIsCurrent / guardedWrite：时效与并发变化挡住覆盖，放行合法写入', () => {
  const { state, environmentId } = withEnvironment([item({ sensitivity: 'immutable' })])
  const done = assess(state, environmentId, [observation({ sensitivity: 'immutable' })])
  assert.equal(done.ok, true)
  if (!done.ok) return
  const resume = done.resume
  assert.equal(resume.phase, 'ready')

  const current = resumeIsCurrent(resume, { environmentVersion: 1 }, NOW + 2_000)
  assert.equal(current.ok, true)
  assert.equal(current.grantsExecution, false, '检查有效不等于执行权（§33.3）')
  assert.match(current.reason, /不构成执行权/)

  const stale = resumeIsCurrent(resume, { environmentVersion: 1 }, NOW + 1_000 + DEFAULT_VALIDITY_POLICY.immutableMs + 1)
  assert.equal(stale.ok, false)
  assert.match(stale.reason, /时段|时效/)

  const revised = resumeIsCurrent(resume, { environmentVersion: 2 }, NOW + 2_000)
  assert.equal(revised.ok, false)
  const changedObject = resumeIsCurrent({ ...resume, objectVersions: { 'file:///x': 'v1' } }, { objectVersions: { 'file:///x': 'v2' } }, NOW + 2_000)
  assert.equal(changedObject.ok, false)
  assert.match(changedObject.reason, /条件写入|再检查/)
  const unknownObject = resumeIsCurrent(resume, { objectVersions: { 'file:///x': 'v1' } }, NOW + 2_000)
  assert.equal(unknownObject.ok, false, '出现评估未记录的对象时不能假装它不影响本次恢复')

  const guarded = guardedWrite(resume, 'file:///x', 'v1', 'v1', { conditionalWriteSupported: true })
  assert.equal(guarded.ok, true)
  assert.equal(guarded.caveat, undefined)
  const conflict = guardedWrite(resume, 'file:///x', 'v1', 'v2', { conditionalWriteSupported: true })
  assert.equal(conflict.ok, false)
  assert.match(conflict.reason, /阻止覆盖/)
  const pointInTime = guardedWrite(resume, 'file:///x', 'v1', 'v1')
  assert.equal(pointInTime.ok, true)
  assert.match(pointInTime.caveat ?? '', /时点观察/)

  const notReady = openResume(state, { environmentId, targetIdentity: 'acct:default', decidedBy: 'supervisor' }, NOW)
  const early = guardedWrite(notReady.resume!, 'file:///x', 'v1', 'v1')
  assert.equal(early.ok, false)
})

test('preservationPlan / revalidationPlan：保留当前版本，只重验受影响范围', () => {
  const base = withEnvironment([
    item({ ref: 'file:///tmp/report.md', sensitivity: 'variable' }),
    item({ kind: 'runtime', ref: 'env:py', sensitivity: 'immutable' }),
    item({ kind: 'dependency', ref: 'env:req', sensitivity: 'immutable' }),
  ], '运行测试')
  const state: MissionControl = {
    ...base.state,
    artifacts: {
      'file:///tmp/report.md': [artifact()],
      'file:///tmp/unrelated.md': [artifact({ artifactId: 'art_2', uri: 'file:///tmp/unrelated.md', contentHash: 'hash-2' })],
    },
  }
  const done = assess(state, base.environmentId, [
    observation({ ref: 'file:///tmp/report.md', observation: 'changed' }),
    observation({ kind: 'runtime', ref: 'env:py', sensitivity: 'immutable' }),
    observation({ kind: 'dependency', ref: 'env:req', sensitivity: 'immutable' }),
  ], { repairsSettled: true, revalidation: { ok: true, note: '受影响结果已重验' } })
  assert.equal(done.ok, true)
  if (!done.ok) return
  assert.equal(done.resume.phase, 'ready')

  const plan: PreservationPlan = preservationPlan(state, done.resume)
  assert.deepEqual(plan.preserved.map((entry) => entry.artifactId), ['art_1'], '只保留与恢复相关的产物版本')
  assert.equal(plan.operations.length, 1)
  assert.equal(plan.operations[0]?.requiresReceipt, true, '恢复操作本身也走 Operation 回执与预算（§33.4）')
  assert.match(plan.note, /保留 1 个当前产物版本/)

  const revalidation = revalidationPlan(done.resume)
  assert.deepEqual([...revalidation.revalidateRefs], ['file:///tmp/report.md'])
  assert.deepEqual([...revalidation.unaffectedRefs], ['env:py', 'env:req'], '无关项不重跑')
})

test('assessResume：一致即可继续；漂移需先核对重验；越权与未核验必需项被挡', () => {
  const clean = withEnvironment([item({ kind: 'runtime', ref: 'env:py' }), item({ kind: 'dependency', ref: 'env:req' }), item({ kind: 'workspace', ref: 'env:ws' })])
  const readyResult = assess(clean.state, clean.environmentId, [
    observation({ kind: 'runtime', ref: 'env:py' }),
    observation({ kind: 'dependency', ref: 'env:req' }),
    observation({ kind: 'workspace', ref: 'env:ws' }),
  ])
  assert.equal(readyResult.ok, true)
  if (!readyResult.ok) return
  assert.equal(readyResult.resume.phase, 'ready')
  assert.equal(readyResult.verdict.ready, true)
  assert.equal(readyResult.verdict.grantsExecution, false)
  assert.match(readyResult.verdict.notes.join(' '), /不构成执行权/)
  assert.equal(readyResult.verdict.scopeByRef['env:ws'], '相关任务继续')

  const drifted = assess(clean.state, clean.environmentId, [
    observation({ kind: 'runtime', ref: 'env:py' }),
    observation({ kind: 'dependency', ref: 'env:req', observation: 'changed' }),
    observation({ kind: 'workspace', ref: 'env:ws' }),
  ])
  assert.equal(drifted.ok, true)
  if (!drifted.ok) return
  assert.equal(drifted.resume.phase, 'repair_or_reconcile', '有漂移时核对没做完就停下，不替调用方宣称恢复完成')
  assert.equal(drifted.verdict.ready, false)
  assert.match(drifted.verdict.notes.join(' '), /repair_or_reconcile/)

  const repaired = assess(clean.state, clean.environmentId, [
    observation({ kind: 'runtime', ref: 'env:py' }),
    observation({ kind: 'dependency', ref: 'env:req', observation: 'changed' }),
    observation({ kind: 'workspace', ref: 'env:ws' }),
  ], { repairsSettled: true, revalidation: { ok: true, note: '受影响结论已重验' } })
  assert.equal(repaired.ok, true)
  if (!repaired.ok) return
  assert.equal(repaired.resume.phase, 'ready')
  assert.deepEqual([...repaired.verdict.revalidateRefs], ['env:req'])
  assert.equal(repaired.verdict.scopeByRef['env:req'], '无关任务不重跑')

  const failedRevalidation = assess(clean.state, clean.environmentId, [
    observation({ kind: 'runtime', ref: 'env:py' }),
    observation({ kind: 'dependency', ref: 'env:req', observation: 'changed' }),
    observation({ kind: 'workspace', ref: 'env:ws' }),
  ], { repairsSettled: true, revalidation: { ok: false, note: '重验未通过' } })
  assert.equal(failedRevalidation.ok, true)
  if (!failedRevalidation.ok) return
  assert.equal(failedRevalidation.resume.phase, 'blocked_scope')

  const needsAuth = assess(clean.state, clean.environmentId, [
    observation({ kind: 'runtime', ref: 'env:py' }),
    observation({ kind: 'dependency', ref: 'env:req', recoveryRequiresNewAuthorization: true }),
    observation({ kind: 'workspace', ref: 'env:ws' }),
  ])
  assert.equal(needsAuth.ok, true)
  if (!needsAuth.ok) return
  assert.equal(needsAuth.resume.phase, 'blocked_scope')
  assert.deepEqual([...needsAuth.verdict.blockedRefs], ['env:req'])

  const unknownEnvironment = withEnvironment([
    item({ kind: 'runtime', ref: 'env:py', coverage: 'unknown' }),
    item({ kind: 'dependency', ref: 'env:req', sensitivity: 'immutable' }),
    item({ kind: 'workspace', ref: 'env:ws', sensitivity: 'immutable' }),
  ])
  const uncheckedRequired = assess(unknownEnvironment.state, unknownEnvironment.environmentId, [
    observation({ kind: 'runtime', ref: 'env:py' }),
    observation({ kind: 'dependency', ref: 'env:req', sensitivity: 'immutable' }),
    observation({ kind: 'workspace', ref: 'env:ws', sensitivity: 'immutable' }),
  ])
  assert.equal(uncheckedRequired.ok, true)
  if (!uncheckedRequired.ok) return
  assert.deepEqual([...uncheckedRequired.verdict.uncheckedRequired], ['env:py'])
  assert.equal(uncheckedRequired.resume.phase, 'blocked_scope', '下一步必需项没核验就不能按可继续放行')

  const identityMismatch = assess(clean.state, clean.environmentId, [
    observation({ kind: 'runtime', ref: 'env:py' }),
    observation({ kind: 'dependency', ref: 'env:req' }),
    observation({ kind: 'workspace', ref: 'env:ws' }),
  ], { observedTargetIdentity: 'acct:someone-else' })
  assert.equal(identityMismatch.ok, true)
  if (!identityMismatch.ok) return
  assert.deepEqual([...identityMismatch.verdict.blockedRefs], ['target_identity'])
})

/* -------------------------------------------------- §35.1 策略与生命周期 */

test('proposeMechanism / reviseMechanism：版本链；分类不能被修订顺带改掉', () => {
  const first = proposeMechanism(freshState(), mech({ mechanismId: 'mech_1', class: 'core_invariant' }), NOW)
  assert.equal(first.ok, true)
  assert.equal(first.mechanism?.version, 1)
  assert.equal(first.mechanism?.status, 'candidate')

  const duplicate = proposeMechanism(first.state, mech({ mechanismId: 'mech_1' }), NOW)
  assert.equal(duplicate.ok, false)

  const noSignal = proposeMechanism(freshState(), mech({ benefitSignal: ' ' }), NOW)
  assert.equal(noSignal.ok, false, '没有收益信号就无法事后判断该不该留（§35.4）')

  const revised = reviseMechanism(first.state, 'mech_1', { purpose: '改为登记写操作' }, NOW + 1, 'lead-1')
  assert.equal(revised.ok, true)
  assert.equal(revised.mechanism?.version, 2)
  assert.equal(revised.state.mechanisms['mech_1']?.length, 2)

  const smuggled = { purpose: '想顺手降级', class: 'optional_advisory' } as unknown as Parameters<typeof reviseMechanism>[2]
  const smuggledResult = reviseMechanism(first.state, 'mech_1', smuggled, NOW + 2, 'lead-1')
  assert.equal(smuggledResult.mechanism?.class, 'core_invariant', '修订不能把必需改可选')
})

test('changeMechanismClass：模型自行升降级被拒；规则所有者可以', () => {
  const proposal = proposeMechanism(freshState(), mech({ mechanismId: 'mech_1', class: 'required_acceptance' }), NOW)
  const byModel = changeMechanismClass(proposal.state, 'mech_1', 'optional_advisory', { actorId: 'lead-1', basis: 'model' }, NOW + 1)
  assert.equal(byModel.ok, false)
  assert.match(byModel.reason ?? '', /不能自行/)

  const byOwner = changeMechanismClass(proposal.state, 'mech_1', 'optional_advisory', { actorId: 'rule-owner', basis: 'rule_owner', authorizationRef: 'rule:R07' }, NOW + 2)
  assert.equal(byOwner.ok, true)
  assert.equal(byOwner.mechanism?.class, 'optional_advisory')
  assert.equal(byOwner.state.mechanisms['mech_1']?.length, 2)
  assert.match(byOwner.mechanism?.statusReason ?? '', /rule_owner/)

  const same = changeMechanismClass(byOwner.state, 'mech_1', 'optional_advisory', { actorId: 'user', basis: 'user' }, NOW + 3)
  assert.equal(same.ok, false)
})

test('transitionMechanism：与 RuleSpec 同构的生命周期；冷却 / 退役要理由', () => {
  const proposal = proposeMechanism(freshState(), mech({ mechanismId: 'mech_opt' }), NOW)
  const skip = transitionMechanism(proposal.state, 'mech_opt', 'activate', NOW + 1)
  assert.equal(skip.ok, false, 'candidate 不能直接 active')
  const observing = transitionMechanism(proposal.state, 'mech_opt', 'start_observing', NOW + 1)
  assert.equal(observing.mechanism?.status, 'observing')
  const active = transitionMechanism(observing.state, 'mech_opt', 'activate', NOW + 2)
  assert.equal(active.mechanism?.status, 'active')

  const coolingNoReason = transitionMechanism(active.state, 'mech_opt', 'enter_cooling', NOW + 3)
  assert.equal(coolingNoReason.ok, false)
  const cooling = transitionMechanism(active.state, 'mech_opt', 'enter_cooling', NOW + 3, { reason: '连续超时', resumeWhen: '能力复核通过后' })
  assert.equal(cooling.mechanism?.status, 'cooling')
  assert.equal(cooling.mechanism?.statusReason, '连续超时')

  const retireNoReason = transitionMechanism(cooling.state, 'mech_opt', 'retire', NOW + 4)
  assert.equal(retireNoReason.ok, false)
  const retired = transitionMechanism(cooling.state, 'mech_opt', 'retire', NOW + 4, { reason: '长期低收益' })
  assert.equal(retired.mechanism?.status, 'retired')
  assert.equal(retired.mechanism?.retiredAt, NOW + 4)
  assert.equal(retired.mechanism?.retirementReason, '长期低收益')
  const afterRetire = transitionMechanism(retired.state, 'mech_opt', 'activate', NOW + 5)
  assert.equal(afterRetire.ok, false, '退役是终态')

  const required = proposeMechanism(freshState(), mech({ mechanismId: 'mech_core', class: 'core_invariant' }), NOW)
  const modelRetire = transitionMechanism(required.state, 'mech_core', 'retire', NOW + 1, { reason: '看起来没用', basis: 'model' })
  assert.equal(modelRetire.ok, false, '必需规则的更改要由规则所有者或已有授权决定（§35.4）')
  const ownerRetire = transitionMechanism(required.state, 'mech_core', 'retire', NOW + 2, { reason: '被更简单的不变量覆盖', basis: 'rule_owner' })
  assert.equal(ownerRetire.ok, true)
})

test('dispositionFor / mechanismAvailability：分类决定缺失与故障时的处置', () => {
  const core = dispositionFor('core_invariant')
  assert.equal(core.verdict, 'block_dependent')
  assert.equal(core.expandsExecutionRights, false)
  assert.equal(core.keepsAvailable.includes('diagnosis'), true, '诊断 / 取消 / 核对保留（§35.3）')
  assert.equal(dispositionFor('required_acceptance', 'timeout').verdict, 'not_passed', '必要验收失效不自动算通过')
  assert.equal(dispositionFor('optional_advisory', 'over_cost').verdict, 'degrade_or_disable')

  const state = freshState()
  const unknown = mechanismAvailability(state, 'mech_none')
  assert.equal(unknown.present, false)
  assert.equal(unknown.disposition?.verdict, 'block_dependent', '没有策略记录时按最保守处理')
  assert.equal(dispositionForMechanism(state, 'mech_none', 'error').verdict, 'block_dependent')

  const proposal = proposeMechanism(state, mech({ mechanismId: 'mech_opt' }), NOW)
  const candidate = mechanismAvailability(proposal.state, 'mech_opt')
  assert.equal(candidate.adjudicative, false, '候选未取得判定资格')
  const active = transitionMechanism(transitionMechanism(proposal.state, 'mech_opt', 'start_observing', NOW + 1).state, 'mech_opt', 'activate', NOW + 2)
  assert.equal(mechanismAvailability(active.state, 'mech_opt').adjudicative, true)
  const cooling = transitionMechanism(active.state, 'mech_opt', 'enter_cooling', NOW + 3, { reason: '超时' })
  const coolingView = mechanismAvailability(cooling.state, 'mech_opt')
  assert.equal(coolingView.adjudicative, false)
  assert.equal(coolingView.suggestionOnly, true)
  assert.match(coolingView.reason, /停用/)
  const retired = transitionMechanism(cooling.state, 'mech_opt', 'retire', NOW + 4, { reason: '不再需要' })
  const retiredView = mechanismAvailability(retired.state, 'mech_opt')
  assert.equal(retiredView.adjudicative, false)
  assert.equal(retiredView.disposition, undefined)
  assert.match(retiredView.reason, /不得作为验收依据/)
  assert.equal(dispositionForMechanism(retired.state, 'mech_opt').verdict, 'degrade_or_disable')
})

/* -------------------------------------------------- §35.2 成本与分层触发 */

test('recordMechanismRun：成本仍从 Mission 总账扣除，不可观测的费用标 unknown', () => {
  const proposal = proposeMechanism(freshState(), mech({ mechanismId: 'mech_opt' }), NOW)
  const before = availability(proposal.state)
  const recorded = recordMechanismRun(proposal.state, {
    mechanismId: 'mech_opt',
    trigger: 'delivery',
    modelCalls: 2,
    tokens: 1_000,
    wallClockMs: 500,
    blockedWaitMs: 250,
    actualAction: '评分交付文本',
    outputNote: '发现 1 处措辞不一致',
  }, NOW + 100)
  assert.equal(recorded.ok, true)
  assert.equal(recorded.costLevel, 'observed')
  assert.equal(recorded.billedToMission, true)
  const after = availability(recorded.state)
  assert.equal(before.callsAvailable - after.callsAvailable, 2, '治理调用与本体调用同一口池子')
  assert.equal(before.tokensAvailable - after.tokensAvailable, 1_000)
  assert.equal(recorded.state.budget.governanceWallClockMs, 750, '阻断等待也算治理开销')

  const unknown = recordMechanismRun(proposal.state, {
    mechanismId: 'mech_opt',
    trigger: 'delivery',
    costUnknown: true,
    actualAction: '走外部服务评分',
  }, NOW + 200)
  assert.equal(unknown.costLevel, 'unknown')
  assert.equal(unknown.run?.costUnknown, true)
  assert.match(governanceCostOf(unknown.run!).note, /unknown/)

  const partial = recordMechanismRun(proposal.state, { mechanismId: 'mech_opt', trigger: 'delivery', tokens: 500, actualAction: '只看输入量' }, NOW + 300)
  assert.equal(partial.costLevel, 'lower_bound', '部分可观测只能当下界')

  const negative = recordMechanismRun(proposal.state, { mechanismId: 'mech_opt', trigger: 'delivery', modelCalls: -5, tokens: -1, actualAction: '乱填' }, NOW + 400)
  assert.equal(negative.state.budget.governanceCalls, 0, '负数不能把已有开销抹掉')
  assert.equal(negative.state.budget.governanceTokens, 0)

  const unregistered = recordMechanismRun(proposal.state, { mechanismId: 'mech_none', trigger: 'delivery', actualAction: 'x' }, NOW + 500)
  assert.equal(unregistered.ok, false)

  const reversed = recordMechanismRun(proposal.state, { mechanismId: 'mech_opt', trigger: 'delivery', startedAt: NOW + 10, finishedAt: NOW, actualAction: 'x' }, NOW + 600)
  assert.equal(reversed.ok, false)
  assert.equal(reversed.state.revision, proposal.state.revision, '被拒的运行不落库')

  const misreport = recordMisreport(recorded.state, recorded.run!.runId, 'yes', '该建议是误报', NOW + 700)
  assert.equal(misreport.ok, true)
  assert.equal(misreport.run?.misreport, 'yes')
  const missingRun = recordMisreport(recorded.state, 'mrun_none', 'no', '', NOW + 800)
  assert.equal(missingRun.ok, false)

  const spend = mechanismSpend(recorded.state, 'mech_opt')
  assert.equal(spend.runs, 1)
  assert.equal(spend.tokens, 1_000)
})

test('breakerFor / applyBreaker / recheckAfterCooldown：熔断与恢复的边界', () => {
  const proposal = proposeMechanism(freshState(), mech({ mechanismId: 'mech_opt', costCap: { tokens: 10_000, calls: 100 }, resumeWhen: '成本与收益重估后' }), NOW)
  const active = transitionMechanism(transitionMechanism(proposal.state, 'mech_opt', 'start_observing', NOW + 1).state, 'mech_opt', 'activate', NOW + 2)
  const policy = mechanismHead(active.state, 'mech_opt')!

  const calm = breakerFor(policy, { timeoutStreak: 1, noChangeStreak: 1, failureStreak: 0 }, mechanismSpend(active.state, 'mech_opt'))
  assert.equal(calm.break, false)
  assert.equal(calm.allowsDegradedWrites, false)

  const timeouts = breakerFor(policy, { timeoutStreak: BREAKER_TIMEOUT_STREAK, noChangeStreak: 0, failureStreak: 0 }, mechanismSpend(active.state, 'mech_opt'))
  assert.equal(timeouts.break, true)
  assert.equal(timeouts.target, 'cooling')

  const noChange = breakerFor(policy, { timeoutStreak: 0, noChangeStreak: BREAKER_NO_CHANGE_STREAK, failureStreak: 0 }, mechanismSpend(active.state, 'mech_opt'))
  assert.equal(noChange.target, 'observe_only', '反复无变化的建议退为仅观察（§35.2、§35.3）')

  const overCap = breakerFor(policy, { timeoutStreak: 0, noChangeStreak: 0, failureStreak: 0 }, { runs: 3, calls: 200, tokens: 20_000, wallClockMs: 0, blockedWaitMs: 0, unknownRuns: 0 })
  assert.equal(overCap.break, true)
  assert.match(overCap.reason, /上限/)

  const applied = applyBreaker(active.state, 'mech_opt', { timeoutStreak: BREAKER_TIMEOUT_STREAK, noChangeStreak: 0, failureStreak: 0 }, NOW + 3)
  assert.equal(applied.ok, true)
  assert.equal(applied.mechanism?.status, 'cooling')
  assert.match(applied.mechanism?.statusReason ?? '', /超时/)
  assert.match(applied.mechanism?.resumeWhen ?? '', /能力/)

  const notCapable = recheckAfterCooldown(applied.state, 'mech_opt', { capable: false, note: '依赖服务仍不可用' }, NOW + 4)
  assert.equal(notCapable.ok, false)
  assert.equal(notCapable.mechanism?.status, 'cooling', '能力未通过就继续停用')
  assert.equal(notCapable.failureAssumedRepaired, false)

  const capable = recheckAfterCooldown(applied.state, 'mech_opt', { capable: true, note: '依赖服务恢复' }, NOW + 5)
  assert.equal(capable.ok, true)
  assert.equal(capable.mechanism?.status, 'observing', '冷却结束只回到观察，不直接 active')
  assert.equal(capable.failureAssumedRepaired, false)
  assert.equal(capable.autoRestartCancelledTasks, false)
  assert.match(capable.mechanism?.statusReason ?? '', /未视为已修复/)

  const wrongPhase = recheckAfterCooldown(active.state, 'mech_opt', { capable: true, note: 'x' }, NOW + 6)
  assert.equal(wrongPhase.ok, false)

  const unknownMechanism = applyBreaker(active.state, 'mech_none', { timeoutStreak: 9, noChangeStreak: 0, failureStreak: 0 }, NOW + 7)
  assert.equal(unknownMechanism.ok, false)
})

test('governanceCacheKey / triggerLayer：缓存键含相关版本，分层触发只在需要时上调', () => {
  const baseKey = governanceCacheKey({ mechanismId: 'mech_opt', mechanismVersion: 1, target: 'task:t1', ruleRevision: 3, evidenceRevision: 'b7', environmentVersion: 2 })
  const otherEnv = governanceCacheKey({ mechanismId: 'mech_opt', mechanismVersion: 1, target: 'task:t1', ruleRevision: 3, evidenceRevision: 'b7', environmentVersion: 3 })
  assert.notEqual(baseKey, otherEnv, '环境相关版本变了，缓存键必须变')

  const proposal = proposeMechanism(freshState(), mech({ mechanismId: 'mech_opt' }), NOW)
  const active = transitionMechanism(transitionMechanism(proposal.state, 'mech_opt', 'start_observing', NOW + 1).state, 'mech_opt', 'activate', NOW + 2)
  const policy = mechanismHead(active.state, 'mech_opt')!

  const hit = triggerLayer({
    policy,
    cacheKey: baseKey,
    cached: { key: baseKey, at: NOW, ttlMs: 60_000 },
    fieldStateChanged: false,
    relevantRevisionsChanged: false,
    now: NOW + 100,
  })
  assert.equal(hit.layer, 'skip')
  assert.match(hit.reason, /命中缓存/)

  const substantial = triggerLayer({ policy, cacheKey: baseKey, fieldStateChanged: false, relevantRevisionsChanged: false, semanticMagnitude: 'substantial', now: NOW + 100 })
  assert.equal(substantial.layer, 'semantic')

  const field = triggerLayer({ policy, cacheKey: baseKey, fieldStateChanged: true, relevantRevisionsChanged: false, now: NOW + 100 })
  assert.equal(field.layer, 'field_state')

  const quiet = triggerLayer({ policy, cacheKey: baseKey, fieldStateChanged: false, relevantRevisionsChanged: false, now: NOW + 100 })
  assert.equal(quiet.layer, 'skip')
  assert.match(quiet.reason, /没有变化/)

  const expired = triggerLayer({
    policy,
    cacheKey: baseKey,
    cached: { key: baseKey, at: NOW, ttlMs: 1_000 },
    fieldStateChanged: false,
    relevantRevisionsChanged: false,
    now: NOW + 2_000,
  })
  assert.equal(expired.layer, 'field_state', '缓存过期不能继续复用旧判断')
  assert.match(expired.reason, /过期/)

  const stopped = transitionMechanism(active.state, 'mech_opt', 'enter_cooling', NOW + 3, { reason: '超时' })
  const coolingPolicy = mechanismHead(stopped.state, 'mech_opt')!
  assert.equal(triggerLayer({ policy: coolingPolicy, cacheKey: baseKey, fieldStateChanged: true, relevantRevisionsChanged: true, now: NOW + 4 }).layer, 'skip')

  const retired = transitionMechanism(stopped.state, 'mech_opt', 'retire', NOW + 5, { reason: '被更简单机制覆盖' })
  assert.equal(triggerLayer({ policy: mechanismHead(retired.state, 'mech_opt')!, cacheKey: baseKey, fieldStateChanged: true, relevantRevisionsChanged: true, now: NOW + 6 }).layer, 'skip')
})

/* -------------------------------------------------- §35.4 收益与退出条件 */

test('assessBenefit / exitVerdict：拦截次数不算收益，退出要分必需与可选', () => {
  const proposal = proposeMechanism(freshState(), mech({ mechanismId: 'mech_opt' }), NOW)
  const policy: MechanismPolicy = mechanismHead(proposal.state, 'mech_opt')!

  const single = assessBenefit(policy, [run({ runId: 'mrun_1' })], [{ runId: 'mrun_1', attribution: 'clear', found: ['措辞不一致'] }])
  assert.equal(single.verdict, 'insufficient_evidence', `归因清楚的观察至少 ${MIN_BENEFIT_OBSERVATIONS} 次才算证据`)
  assert.equal(exitVerdict(policy, single).action, 'keep')

  const beneficial = assessBenefit(
    policy,
    [run({ runId: 'mrun_1' }), run({ runId: 'mrun_2' })],
    [
      { runId: 'mrun_1', attribution: 'clear', found: ['措辞不一致'], recoverySucceeded: true },
      { runId: 'mrun_2', attribution: 'clear', avoided: ['误发旧结论'] },
    ],
  )
  assert.equal(beneficial.verdict, 'beneficial')
  assert.equal(exitVerdict(policy, beneficial).action, 'keep')

  const lowBenefit = assessBenefit(
    policy,
    [run({ runId: 'mrun_1' }), run({ runId: 'mrun_2' })],
    [
      { runId: 'mrun_1', attribution: 'clear', delayMs: 5_000 },
      { runId: 'mrun_2', attribution: 'clear', delayMs: 3_000 },
    ],
  )
  assert.equal(lowBenefit.verdict, 'low_benefit', '什么都没有避免或发现，拦截次数不算成绩')
  assert.equal(exitVerdict(policy, lowBenefit).action, 'step_down_to_observing', '可选机制先退观察再退役')
  assert.equal(exitVerdict(policy, lowBenefit, { alreadyInObserveOnly: true }).action, 'retire')
  assert.equal(exitVerdict(policy, lowBenefit, { coveredBySimplerMechanism: true }).action, 'retire')

  const misreported = assessBenefit(
    policy,
    [run({ runId: 'mrun_1', misreport: 'yes' }), run({ runId: 'mrun_2', misreport: 'yes' })],
    [
      { runId: 'mrun_1', attribution: 'clear', found: ['x'] },
      { runId: 'mrun_2', attribution: 'clear', found: ['y'] },
    ],
  )
  assert.equal(misreported.verdict, 'low_benefit', '误报延迟超过收益就不算有收益')

  const unclear = assessBenefit(policy, [run({ runId: 'mrun_1' })], [{ runId: 'mrun_1', attribution: 'unclear', found: ['x'] }])
  assert.equal(unclear.verdict, 'insufficient_evidence', '归因不清保留不确定（§35.4）')

  const requiredPolicy: MechanismPolicy = { ...policy, class: 'required_acceptance' }
  assert.equal(exitVerdict(requiredPolicy, lowBenefit).action, 'requires_rule_owner', '必需规则改动由规则所有者决定')
})
