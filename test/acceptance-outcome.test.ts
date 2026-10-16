/**
 * 设计稿 §36.2 / §29.1 验收电池：V5-01、V5-02、V5-06、V5-07、V5-12 五条（任务 #41）。
 *
 * 与既有回归集（v05-outcome-integration / v05-records-provenance / v05-environment-governance）
 * 的分工：那三份按模块逐判定分列；这里按设计条的"情形与期望"在**场景层**重走一遍——
 * 每条用例先钉住"该拦的拦下了"，再钉住"该放行的仍能推进"，两侧都断言。
 *
 * 自包含：只从 `test/fixtures.ts` 取通用夹具（mission / actor / task 与命令推进），
 * 其余构造器在本文件内给出"只造合法状态"的最小版本；判定一律调 `src/core/*` 的导出，
 * 状态推进全部经命令面（dispatch → apply），不手拼半截记录。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { missionCompletion } from '../src/core/completion.ts'
import type { MissionControl } from '../src/core/control.ts'
import { criteriaReport, dependencyGates } from '../src/core/discipline.ts'
import type { EvidenceRecord, Mission } from '../src/core/entities.ts'
import type { MechanismInput, MechanismRunInput } from '../src/core/governance.ts'
import {
  BREAKER_FAILURE_STREAK,
  BREAKER_TIMEOUT_STREAK,
  applyBreaker,
  dispositionForMechanism,
  mechanismAvailability,
  mechanismHead,
  proposeMechanism,
  recordMechanismRun,
  recheckAfterCooldown,
  transitionMechanism,
  triggerLayer,
} from '../src/core/governance.ts'
import type { OutcomeContractInput, OutcomeReviewAnswer } from '../src/core/outcome.ts'
import { buildOutcomeReview, commitOutcomeReview, outcomeReviewRequired, registerOutcomeContract } from '../src/core/outcome.ts'
import { claimUsableFor, independenceReport, independentSourceCount, recordClassUse, traceProvenance } from '../src/core/provenance.ts'
import { NOW, apply, checkpointPayload, ctx, draftMission, freshState, req, taskPayload, withClaimedTask } from './fixtures.ts'

/* ─────────────────────────────── 本地构建器（只造合法状态） ─────────────────────────────── */

function addedKey<T>(before: Readonly<Record<string, T>>, after: Readonly<Record<string, T>>): string {
  const key = Object.keys(after).find((candidate) => before[candidate] === undefined)
  if (key === undefined) throw new Error('夹具：命令没有新增记录')
  return key
}

/** 激活 Mission + 登记 Lead（带会话绑定，任务认领需要）；协作形态可按用例覆写（member 登记需要非 solo）。 */
function baseRig(mission: Partial<Mission> = {}): MissionControl {
  let state = freshState()
  state = apply(state, { kind: 'mission.create', requestId: req(), mission: draftMission(mission) })
  state = apply(state, { kind: 'actor.register', requestId: req(), actorId: 'lead-1', role: 'lead', label: 'Lead', sessionId: 'sess-1' })
  return state
}

/** ready 任务：propose + approve。 */
function addReadyTask(state: MissionControl, title: string): { readonly state: MissionControl; readonly taskId: string } {
  const before = state.tasks
  const next = apply(state, { kind: 'task.propose', requestId: req(), task: taskPayload({ title }) })
  const taskId = addedKey(before, next.tasks)
  return { state: apply(next, { kind: 'task.approve', requestId: req(), taskId }, ctx('user', 'human')), taskId }
}

/** ready → claim → checkpoint → submit：验收记录只能挂在 submitted / verifying 上。 */
function driveToSubmitted(state: MissionControl, taskId: string): MissionControl {
  let next = apply(state, { kind: 'task.claim', requestId: req(), taskId }, ctx('lead', 'lead-1'))
  next = apply(next, { kind: 'task.checkpoint', requestId: req(), taskId, checkpoint: checkpointPayload() }, ctx('lead', 'lead-1'))
  return apply(next, { kind: 'task.submit', requestId: req(), taskId, leaseVersion: 1 }, ctx('lead', 'lead-1'))
}

interface EvidenceSeed {
  readonly kind: EvidenceRecord['kind']
  readonly summary: string
  readonly sourceRef: string
  readonly rootRefs?: EvidenceRecord['rootRefs']
  readonly derivation?: EvidenceRecord['derivation']
  readonly contentHash?: string
  readonly environment?: string
  readonly objectTime?: number
}

/** 经命令面登记一条证据；来源链与派生关系按显式声明写入（§32.1、§32.2），记录人按传入的角色上下文。 */
function addEvidence(
  state: MissionControl,
  seed: EvidenceSeed,
  context = ctx('lead', 'lead-1'),
): { readonly state: MissionControl; readonly evidenceId: string } {
  const before = state.evidence
  const evidence = {
    kind: seed.kind,
    summary: seed.summary,
    observedAt: NOW,
    sourceRef: seed.sourceRef,
    ...(seed.rootRefs === undefined ? {} : { rootRefs: seed.rootRefs }),
    ...(seed.derivation === undefined ? {} : { derivation: seed.derivation }),
    ...(seed.contentHash === undefined ? {} : { contentHash: seed.contentHash }),
    ...(seed.environment === undefined ? {} : { environment: seed.environment }),
    ...(seed.objectTime === undefined ? {} : { objectTime: seed.objectTime }),
  }
  const next = apply(state, { kind: 'evidence.record', requestId: req(), evidence }, context)
  return { state: next, evidenceId: addedKey(before, next.evidence) }
}

/** 与 v05-outcome-integration 同口径的目标契约输入（含三条验收例子与一条用户署名硬约束）。 */
function contractInput(overrides: Partial<OutcomeContractInput> = {}): OutcomeContractInput {
  return {
    intendedUse: '分析师在换环境后重复运行同一分析流程',
    desiredOutcome: '流程在干净环境一次跑通并给出可解释输出',
    acceptanceExamples: [
      { kind: 'success', text: '新环境按文档运行得到与基线一致的关键结论' },
      { kind: 'boundary', text: '输入为空时给出明确报错而不是静默输出空表' },
      { kind: 'failure', text: '换机器后需要人工改三处路径才能运行' },
    ],
    metricsAndLimits: [
      { metric: '端到端运行成功率', represents: '流程可重复运行的稳定程度', cannotRepresent: '结论被用户实际采纳的程度' },
    ],
    hardConstraints: [{ text: '不得改动业务仓库', source: '用户 2026-10-14 指令' }],
    preferencesAndTradeoffs: [],
    unresolvedAssumptions: [{ text: '目标环境 Python ≥ 3.11', advanceScope: '先按当前锁定版本推进，发布前提早确认' }],
    ...overrides,
  }
}

/* ─────────────────────────────── V5-01：指标与真实使用例 ─────────────────────────────── */

test('V5-01 目标效用：指标提高却不符真实使用例触发复核；指标与效果一致不制造额外审查', () => {
  const claimed = withClaimedTask()
  const registered = registerOutcomeContract(claimed.state, contractInput(), { actorId: 'lead-1', now: NOW, source: 'agent' })
  assert.equal(registered.ok, true, '先有一份合法生效的契约，后面的复核信号才有对象（§30.1）')
  if (!registered.ok) return

  // 放行侧：指标读数与真实使用例一致 → 复用已生效契约，不制造额外审查（V5-01 后半句）
  const consistent = outcomeReviewRequired(registered.state, { metricVsExperience: 'consistent' })
  assert.equal(consistent.required, false, '指标与效果一致时不制造额外审查（V5-01）')
  assert.deepEqual(consistent.triggers, [], '一致不产生任何触发器')
  assert.ok(consistent.reason.includes('无复核触发器'), '理由要说明是"日常小步骤复用契约"这条路')
  assert.equal(outcomeReviewRequired(registered.state, { metricVsExperience: 'unknown' }).required, false, '指标读数未知不被当作不一致')
  assert.equal(outcomeReviewRequired(registered.state, {}).required, false, '没有变化信号的日常推进同样不触发复核')

  // 拦错侧：指标升了（成功率读数变好）却不符合真实使用例 → 必须触发复核
  const divergent = outcomeReviewRequired(registered.state, { metricVsExperience: 'divergent' })
  assert.equal(divergent.required, true, '指标提高却不符合真实使用例：必须触发复核（V5-01）')
  assert.ok(divergent.triggers.includes('metric_experience_divergence'), '触发器要对上"指标与实际体验不一致"')
  assert.equal(divergent.triggers.includes('no_contract'), false, '契约已在，不该退化成"先整理契约"那一路')

  const answers: readonly OutcomeReviewAnswer[] = [
    { question: 'effect_changed', answer: '端到端成功率升到 97%，但成功使用例仍未成立：换环境后仍需人工改三处路径', evidenceRefs: ['ev_metric_97', 'ev_usecase_fail'] },
    { question: 'metric_evidence', answer: '成功率读数来自端到端脚本 40 次运行的聚合', evidenceRefs: ['ev_metric_97'] },
    { question: 'costs_and_regressions', answer: '维护成本还没有数据', evidenceRefs: [], unknown: true },
    { question: 'route_still_serves', answer: '路线仍服务于原任务，但先修成功使用例失败点', evidenceRefs: ['ev_usecase_fail'] },
  ]
  const built = buildOutcomeReview(
    registered.state,
    { triggers: divergent.triggers, answers, conclusion: 'contract_needs_revision' },
    { actorId: 'lead-1', now: NOW + 1_000 },
  )
  assert.equal(built.ok, true, '四问齐全且证据/unknown 齐备的复核应被接受')
  if (!built.ok) return
  const reviewed = commitOutcomeReview(registered.state, built.record)
  assert.equal(reviewed.revision, registered.state.revision + 1, '复核结论必须落事件流留痕（§30.2）')
  assert.equal(reviewed.events.at(-1)?.kind, 'outcome/reviewed')
  assert.equal(reviewed.events.at(-1)?.detail['conclusion'], 'contract_needs_revision', '事件里要能读到结论本身，而不只是"开过会"')

  // 复核结论为"契约需修订"：由用户发起实质修订（指标不能反推目标）
  const revised = registerOutcomeContract(reviewed, contractInput({ desiredOutcome: '流程在干净环境一次跑通，且换环境后无需人工改路径' }), {
    actorId: 'human',
    now: NOW + 2_000,
    source: 'user',
  })
  assert.equal(revised.ok, true, '复核后由用户收紧目标的实质修订应放行（§30.2）')
  if (!revised.ok) return
  assert.equal(revised.change.kind, 'material')
  assert.equal(revised.state.tasks[claimed.taskId]?.status, 'planned', '实质修订使未完成任务回到 planned，旧派单失效（§6.1）')
})

/* ─────────────────────────────── V5-02：偏好未指定与授权内取舍 ─────────────────────────────── */

test('V5-02 目标效用：偏好未指定不编造用户硬要求；已有授权内的实现取舍继续推进', () => {
  const claimed = withClaimedTask()

  // 放行侧之一：偏好未指定就保持未指定，硬约束只来自署名来源
  const plain = registerOutcomeContract(claimed.state, contractInput(), { actorId: 'lead-1', now: NOW, source: 'agent' })
  assert.equal(plain.ok, true, '偏好未指定不阻止契约登记')
  if (!plain.ok) return
  assert.deepEqual(plain.contract.preferencesAndTradeoffs, [], '偏好未指定就保持未指定：不补默认权重、不发授权（V5-02）')
  assert.deepEqual(
    plain.contract.hardConstraints,
    [{ text: '不得改动业务仓库', source: '用户 2026-10-14 指令' }],
    '硬约束只保留用户署名的来源，不编造用户要求',
  )

  // 拦错侧之一：模型偏好冒充用户硬要求被拒
  const impersonated = registerOutcomeContract(claimed.state, contractInput({ hardConstraints: [{ text: '优先选用我熟悉的框架', source: '模型偏好' }] }), {
    actorId: 'lead-1',
    now: NOW + 1_000,
    source: 'agent',
  })
  assert.equal(impersonated.ok, false, '模型偏好不得冒充用户硬要求（V5-02）')
  if (impersonated.ok) return
  assert.ok(impersonated.problems.some((problem) => problem.includes('模型偏好')), '拒绝理由要指明"来源是模型偏好"')

  // 放行侧之二：用户授权的取舍就位后，agent 在既有授权内的实现取舍（测量实现调整）继续推进
  const withGrant = registerOutcomeContract(
    claimed.state,
    contractInput({ preferencesAndTradeoffs: [{ preference: '先按当前锁定版本推进，发布前提早确认', authorizedBy: 'human-user' }] }),
    { actorId: 'human', now: NOW + 2_000, source: 'user' },
  )
  assert.equal(withGrant.ok, true, '用户署名的偏好取舍应能登记')
  if (!withGrant.ok) return
  const tweak = registerOutcomeContract(
    withGrant.state,
    contractInput({
      preferencesAndTradeoffs: [{ preference: '先按当前锁定版本推进，发布前提早确认', authorizedBy: 'human-user' }],
      metricsAndLimits: [{ metric: '端到端运行成功率', represents: '流程可重复运行的稳定程度', cannotRepresent: '结论被用户实际采纳的程度', mappingPending: true }],
    }),
    { actorId: 'lead-1', now: NOW + 3_000, source: 'agent' },
  )
  assert.equal(tweak.ok, true, '既定授权内的实现取舍由 agent 继续整理，不需要重问用户（V5-02）')
  if (!tweak.ok) return
  assert.equal(tweak.change.kind, 'non_material', '测量实现调整只作记录，不构成实质修订')
  assert.equal(tweak.state.mission.objectiveRevision, withGrant.state.mission.objectiveRevision, '非实质修订不推进目标版本')
  assert.equal(tweak.state.tasks[claimed.taskId]?.status, 'leased', '运行中的任务不被打回：实现取舍继续推进')

  // 拦错侧之二：移除已授权的取舍是实质修订，agent 不能顺带做掉
  const removed = registerOutcomeContract(tweak.state, contractInput({ preferencesAndTradeoffs: [] }), {
    actorId: 'lead-1',
    now: NOW + 4_000,
    source: 'agent',
  })
  assert.equal(removed.ok, false, '移除已授权取舍须由用户或 Supervisor 发起（§30.2）')
  if (removed.ok) return
  assert.ok(
    removed.problems.some((problem) => problem.includes('实质修订') && problem.includes('先按当前锁定版本推进')),
    '拒绝理由要能对回被移除的那条已授权取舍',
  )
})

/* ─────────────────────────────── V5-06：多代理转述与不同条件的新观测 ─────────────────────────────── */

test('V5-06 证据溯源：多代理转述同一次观测不增加独立支持；不同条件的新观测按自身来源保留', () => {
  const sorted = (ids: readonly string[]): string[] => [...ids].sort()
  let state = baseRig({ collaboration: 'team' })
  state = apply(state, { kind: 'actor.register', requestId: req(), actorId: 'member-1', role: 'member', label: 'Member 1' })
  state = apply(state, { kind: 'actor.register', requestId: req(), actorId: 'member-2', role: 'member', label: 'Member 2' })

  // 一次原始观测（根 = 运行回执 operation:run:1@1），三个代理的转述：A、B 直转原稿，C 转 A 的稿
  const origin = addEvidence(state, {
    kind: 'observation',
    summary: '端到端脚本 40 次运行聚合：成功率 0.97（含 3 次超时样本）',
    sourceRef: 'operation:run:1',
    rootRefs: [{ kind: 'operation', ref: 'run:1', version: '1' }],
    contentHash: 'sha256:metric-97',
    environment: 'prod-x86',
  })
  state = origin.state
  const relayA = addEvidence(
    state,
    {
      kind: 'reported',
      summary: '代理 A 转述：成功率 0.97',
      sourceRef: 'report:agent-a',
      derivation: { method: '转述原始运行回执', fromEvidenceIds: [origin.evidenceId] },
    },
    ctx('member', 'member-1'),
  )
  state = relayA.state
  const relayB = addEvidence(
    state,
    {
      kind: 'reported',
      summary: '代理 B 转述：成功率 0.97',
      sourceRef: 'report:agent-b',
      derivation: { method: '转述原始运行回执', fromEvidenceIds: [origin.evidenceId] },
    },
    ctx('member', 'member-2'),
  )
  state = relayB.state
  const relayC = addEvidence(
    state,
    {
      kind: 'reported',
      summary: '代理 C 再转述：抄录 A 的转述稿',
      sourceRef: 'report:agent-c',
      derivation: { method: '再转述（转 A 的稿）', fromEvidenceIds: [relayA.evidenceId] },
    },
    ctx('member', 'member-1'),
  )
  state = relayC.state

  // 溯源链先钉住"同一次观测"：三份转述都落到同一个根 operation:run:1@1
  const chain = traceProvenance(state.evidence, relayC.evidenceId)
  assert.deepEqual(chain.roots, ['operation:run:1@1'], 'A→B→C 的转述链最终都落到同一次观测的根（§32.1）')
  assert.equal(chain.cycle, false)

  // 拦错侧：只数三份转述 → 独立来源是 1，而不是 3（不按代理人数折算）
  const relaysOnly = independenceReport(state.evidence, [relayA.evidenceId, relayB.evidenceId, relayC.evidenceId])
  assert.equal(relaysOnly.independentSources, 1, '多代理转述同一次观测不增加独立支持：三个转述只算一个观测来源（V5-06）')
  assert.equal(independentSourceCount(state.evidence, [relayA.evidenceId, relayB.evidenceId, relayC.evidenceId]), 1)
  assert.equal(relaysOnly.groups.length, 1, '三个转述归并为同一组')
  assert.deepEqual(relaysOnly.groups[0]?.members, sorted([relayA.evidenceId, relayB.evidenceId, relayC.evidenceId]), '组内成员就是这三份转述')
  assert.ok(relaysOnly.reasons.some((line) => line.includes('反复转述同一次观测只算一个观测来源')), '报告要写明归并口径')

  // 加上原观测在内仍是 1 个来源；四类记录的用途判定：转述可读但不算独立支持
  const withOrigin = independenceReport(state.evidence, [origin.evidenceId, relayA.evidenceId, relayB.evidenceId, relayC.evidenceId])
  assert.equal(withOrigin.independentSources, 1, '原观测 + 三份转述仍只有 1 个独立来源')
  assert.equal(withOrigin.groups[0]?.members.length, 4)
  const summaryUse = recordClassUse('summary', 'root_support')
  assert.equal(summaryUse.countsAsIndependent, false, '摘要/转述是派生视图：可供读取，但不计作新增独立证据（§32.1）')
  assert.ok(summaryUse.reason.includes('派生视图'))
  assert.equal(recordClassUse('observation', 'root_support').countsAsIndependent, true, '原始观测才计入独立支持')

  // 放行侧：换 staging 环境、另一批样本的新观测，内容哈希相同也按自身来源保留
  const probe = addEvidence(state, {
    kind: 'observation',
    summary: '换 staging 容器后的新读数：成功率 0.97（另一批独立样本）',
    sourceRef: 'operation:run:2',
    rootRefs: [{ kind: 'operation', ref: 'run:2', version: '1' }],
    contentHash: 'sha256:metric-97',
    environment: 'staging-container',
    objectTime: NOW - 3_600_000,
  })
  state = probe.state
  const mixed = independenceReport(state.evidence, [origin.evidenceId, relayA.evidenceId, relayB.evidenceId, relayC.evidenceId, probe.evidenceId])
  assert.equal(mixed.independentSources, 2, '不同条件的新观测按自身来源保留：与转述组并列计 2 个独立来源（V5-06）')
  assert.ok(
    mixed.groups.some((group) => group.members.includes(probe.evidenceId) && group.origin.includes('operation:run:2@1')),
    '新观测保留自己的根来源 operation:run:2@1，不被并进转述组',
  )
  assert.ok(mixed.notes.some((line) => line.includes('哈希')), '两份记录内容哈希相同：字节相同只提示，不自动并源（§32.2）')
  assert.equal(independentSourceCount(state.evidence, [origin.evidenceId, probe.evidenceId]), 2, '两条不同来源的观测各自计数')
})

/* ─────────────────────────────── V5-07：根验证器失效的传播面 ─────────────────────────────── */

test('V5-07 证据溯源：根验证器失效传播到相关决定；无关证据与任务不全部作废', () => {
  let state = baseRig()
  const taskA = addReadyTask(state, '解析回归验收')
  const taskB = addReadyTask(taskA.state, '无关的文档整理')
  state = driveToSubmitted(taskB.state, taskA.taskId)
  state = driveToSubmitted(state, taskB.taskId)

  const root = addEvidence(state, {
    kind: 'observation',
    summary: '解析器样例集断言结果：关键字段逐一相等',
    sourceRef: 'operation:run:parse-1',
    rootRefs: [{ kind: 'operation', ref: 'run:parse-1', version: '1' }],
  })
  state = root.state

  // 根验证器 v1 取得资格；taskA 的验收决定挂在它上面，taskB 走人工核对、不依赖它
  state = apply(
    state,
    {
      kind: 'validator.qualify',
      requestId: req(),
      validatorId: 'val-1',
      eligible: true,
      validator: {
        name: '解析断言验证器',
        inputType: 'json-report',
        scope: '解析回归',
        assertions: ['关键字段逐一相等'],
        allowedMissing: [],
        codeRef: 'tools/validate-parser@1',
        effectiveSampleIds: ['s1', 's2'],
        counterSampleIds: ['bad-1'],
      },
    },
    ctx('lead', 'lead-1'),
  )
  state = apply(
    state,
    {
      kind: 'task.verify',
      requestId: req(),
      taskId: taskA.taskId,
      criterionId: 'crit_1',
      outcome: 'pass',
      method: '断言集全部通过',
      methodVersion: '1',
      evidenceRefs: [root.evidenceId],
      validatorId: 'val-1',
      checksRun: 12,
    },
    ctx('lead', 'lead-1'),
  )
  state = apply(
    state,
    {
      kind: 'task.verify',
      requestId: req(),
      taskId: taskB.taskId,
      criterionId: 'crit_1',
      outcome: 'pass',
      method: '人工核对清单',
      methodVersion: '1',
      evidenceRefs: [],
      checksRun: 5,
    },
    ctx('lead', 'lead-1'),
  )
  const other = addEvidence(state, {
    kind: 'observation',
    summary: '与解析无关的文档基线快照',
    sourceRef: 'operation:run:doc-1',
    rootRefs: [{ kind: 'operation', ref: 'run:doc-1' }],
  })
  state = other.state

  assert.equal(state.tasks[taskA.taskId]?.status, 'completed', '验证器当时有效：taskA 按当时依据通过')
  assert.equal(criteriaReport(state, state.tasks[taskA.taskId]!).satisfied, true, '验证器有效时相关决定成立')
  assert.equal(criteriaReport(state, state.tasks[taskB.taskId]!).satisfied, true, '无关任务独立通过')

  const depsBefore = state.dependencies
  state = apply(
    state,
    {
      kind: 'dependency.register',
      requestId: req(),
      dependency: { targetKind: 'task', targetId: taskA.taskId, onKind: 'validator', onId: 'val-1', onVersion: 1 },
    },
    ctx('lead', 'lead-1'),
  )
  const validatorDepId = addedKey(depsBefore, state.dependencies)
  assert.equal(dependencyGates(state, state.dependencies[validatorDepId]!).gates, false, '验证器还有效时：这条依赖不阻断相关动作')

  // 根验证器失效：开新版本、撤销资格（同一验证器链上链头一变，旧资格自然失效）
  const basisBefore = state.basisRevision
  state = apply(
    state,
    {
      kind: 'validator.qualify',
      requestId: req(),
      validatorId: 'val-1',
      eligible: false,
      reason: '同版本样例复核发现断言遗漏边界情形，资格暂不可信',
      validator: {
        name: '解析断言验证器',
        inputType: 'json-report',
        scope: '解析回归',
        assertions: ['关键字段逐一相等'],
        allowedMissing: [],
        codeRef: 'tools/validate-parser@2',
        effectiveSampleIds: ['s1', 's2'],
        counterSampleIds: ['bad-1'],
      },
    },
    ctx('lead', 'lead-1'),
  )

  // 读时传播（收口判定路径走 criteriaReport / missionCompletion）：
  // 挂在该验证器上的 pass 不再证明当前判据 → 相关任务的通过不再成立
  const reportAfter = criteriaReport(state, state.tasks[taskA.taskId]!)
  assert.equal(reportAfter.satisfied, false, '根验证器失效传播到相关决定：该任务的通过不再成立（V5-07）')
  const proof = reportAfter.proofs.find((item) => item.criterion.criterionId === 'crit_1')
  assert.equal(proof?.outcome, 'unproven', '依赖该验证器的 pass 翻为 unproven，而不是继续算通过')
  assert.ok((proof?.reason ?? '').includes('验证器'), '理由要点明是验证器资格失效')
  assert.ok(reportAfter.blockers.some((line) => line.includes('验证器资格无效')), '阻断项要能对回根验证器失效')
  assert.equal(state.tasks[taskA.taskId]?.status, 'completed', '任务状态仍是 completed：失效的是"当前还能宣称什么"，不是历史')
  const completion = missionCompletion(state)
  assert.equal(completion.ready, false, '整体收口被相关决定挡住')
  assert.ok(
    completion.missing.some((line) => line.includes(taskA.taskId) && line.includes('验证器资格无效')),
    '收口缺口要指名受影响的任务与原因，而不是笼统一句"有风险"',
  )

  // 无关侧：taskB 与无关证据都不全部作废
  assert.equal(criteriaReport(state, state.tasks[taskB.taskId]!).satisfied, true, '无关任务不全部作废：taskB 的验收仍成立')
  assert.equal(state.tasks[taskB.taskId]?.validity, 'current', '无关任务有效性保持 current')
  assert.equal(state.evidence[other.evidenceId]?.validity, 'current', '无关证据保持当前有效')

  // 命令面传播（§32.3、§22.6 DG-06）：资格从有转无的同一刻，同一次控制提交里递增依据有效性
  // 并沿已声明依赖更新相关条目——不需要外部再调 invalidateDependents 补刀；无关对象一概不动
  assert.equal(state.basisRevision, basisBefore + 1, '资格从有转无：同一次控制提交递增依据有效性（旧票据随之作废）')
  assert.equal(state.dependencies[validatorDepId]?.reviewState, 'invalidated', '沿已声明依赖传播：失效声明了对该验证器依赖的条目')
  assert.equal(state.dependencies[validatorDepId]?.invalidatedBy, 'validator/ineligible val-1@2', '失效原因要对回根验证器失效本身')
  assert.equal(state.tasks[taskA.taskId]?.validity, 'needs_review', '相关任务被标 needs_review，等待按当前依据复核')
  assert.ok(
    state.pendingPropagations.some((item) => item.targetId === taskA.taskId && item.requiredAction === 'reverify_or_reissue'),
    '排队动作是"重验或补发"，不是直接判任务失败',
  )
  const gatesAfter = dependencyGates(state, state.dependencies[validatorDepId]!)
  assert.equal(gatesAfter.gates, true, '相关依赖转为阻断：受管动作需按当前依据复核（§12.1）')
  assert.ok(gatesAfter.reason.includes('失效'), '阻断理由要说明成立条件已失效')

  // 命令面的同类传播：结论被反证后沿已登记依赖更新相关决定（§32.3）
  const taskD = addReadyTask(state, '引用解析结论的集成任务')
  state = apply(taskD.state, { kind: 'task.claim', requestId: req(), taskId: taskD.taskId }, ctx('lead', 'lead-1'))
  const claimProposed = apply(
    state,
    {
      kind: 'claim.propose',
      requestId: req(),
      claim: {
        proposition: '解析流程在 run:1 样例集上稳定复现',
        appliesUnder: ['实现版本 run:1', '样例集 s1/s2'],
        sourceCategory: 'observation',
        status: 'supported',
        supportingEvidenceIds: [root.evidenceId],
        contradictingEvidenceIds: [],
        reentryConditions: ['补做换环境复现'],
      },
    },
    ctx('lead', 'lead-1'),
  )
  const claimId = addedKey(state.claims, claimProposed.claims)
  const depsBefore2 = claimProposed.dependencies
  const withClaimDep = apply(
    claimProposed,
    {
      kind: 'dependency.register',
      requestId: req(),
      dependency: { targetKind: 'task', targetId: taskD.taskId, onKind: 'claim', onId: claimId, onVersion: 1 },
    },
    ctx('lead', 'lead-1'),
  )
  const claimDepId = addedKey(depsBefore2, withClaimDep.dependencies)
  const headBefore = claimProposed.claims[claimId]?.at(-1)
  if (headBefore === undefined) throw new Error('夹具：结论没有链头')
  assert.equal(claimUsableFor(headBefore, 'premise').ok, true, '撤回前：该结论可作为前提使用')

  const revised = apply(
    withClaimDep,
    { kind: 'claim.revise', requestId: req(), claimId, status: 'refuted', retractionReason: '支撑观测被判定为环境特例' },
    ctx('lead', 'lead-1'),
  )
  assert.equal(revised.basisRevision, withClaimDep.basisRevision + 1, '结论撤回推进依据有效性版本（§22.6）')
  assert.equal(revised.dependencies[claimDepId]?.reviewState, 'invalidated', '沿已登记依赖传播：相关决定转 invalidated')
  assert.equal(revised.tasks[taskD.taskId]?.validity, 'needs_review', '依赖该结论的运行中任务需复核')
  assert.ok(
    revised.pendingPropagations.some((item) => item.targetId === taskD.taskId && item.requiredAction === 'reverify_or_reissue'),
    '排队"重验或补发"，不把任务直接判失败',
  )
  const headAfter = revised.claims[claimId]?.at(-1)
  if (headAfter === undefined) throw new Error('夹具：结论没有链头')
  assert.equal(claimUsableFor(headAfter, 'premise').ok, false, '已反证：不能作为生产用途的已证实前提（§32.3）')
  assert.equal(claimUsableFor(headAfter, 'research').ok, true, '研究失效原因仍被允许：研究用途与正式采纳用途不同')
  assert.equal(revised.tasks[taskB.taskId]?.validity, 'current', '第二次传播同样不连坐无关任务')
  assert.equal(revised.tasks[taskA.taskId]?.validity, 'needs_review', 'taskA 仍停在自己的复核队列里')
})

/* ─────────────────────────────── V5-12：治理成本与降级 ─────────────────────────────── */

/** 机制登记输入（§35.1）：只造满足 proposeMechanism 必填项的候选版本。 */
function mechanismInput(overrides: Partial<MechanismInput> = {}): MechanismInput {
  return {
    name: '回归评估器',
    class: 'optional_advisory',
    purpose: '在变化点给出额外评估，不阻断主流程',
    triggers: ['变化事件检查'],
    requiredInputs: ['产物摘要'],
    relevantRevisions: ['criteriaRevision'],
    scope: '评估建议',
    benefitSignal: '建议避免了返工',
    proposedBy: 'lead-1',
    ...overrides,
  }
}

/** 登记一次机制运行；夹具里每一步都必须成功。 */
function recordRun(state: MissionControl, input: MechanismRunInput, now: number): MissionControl {
  const result = recordMechanismRun(state, input, now)
  if (!result.ok) throw new Error(`夹具：机制运行登记被拒：${result.reason ?? '未给理由'}`)
  return result.state
}

/** 从已登记运行推导"连续超时"次数：墙钟超过策略超时才计一次（§35.3）。 */
function timeoutStreak(state: MissionControl, mechanismId: string, timeoutMs: number): number {
  return Object.values(state.mechanismRuns).filter((run) => run.mechanismId === mechanismId && (run.wallClockMs ?? 0) > timeoutMs).length
}

test('V5-12 治理成本：可选评估器反复超时后退到观察；必要验收器失效不自动算通过，诊断入口仍可用', () => {
  const rig = baseRig()

  // —— 可选评估器：申请 → 观察 → 启用 ——
  const proposed = proposeMechanism(rig, mechanismInput({ mechanismId: 'mech_eval', timeoutMs: 30_000 }), NOW)
  assert.equal(proposed.ok, true, '先登记候选机制（版本 1、candidate）')
  if (!proposed.ok) return
  const observing = transitionMechanism(proposed.state, 'mech_eval', 'start_observing', NOW)
  assert.equal(observing.ok, true, '候选先进入观察（§35.1 生命周期）')
  const activated = transitionMechanism(observing.state, 'mech_eval', 'activate', NOW)
  assert.equal(activated.ok, true, '观察无异议后启用')
  let state = activated.state
  assert.equal(mechanismHead(state, 'mech_eval')?.status, 'active')
  assert.equal(mechanismAvailability(state, 'mech_eval').adjudicative, true, '启用后评估器可以出判定（放行侧）')

  // 两次超时：还没到"反复"，不熔断、不预支停用
  state = recordRun(
    state,
    { mechanismId: 'mech_eval', runId: 'mrun_e1', trigger: '变化事件检查', startedAt: NOW, finishedAt: NOW + 45_000, wallClockMs: 45_000, modelCalls: 1, tokens: 800, actualAction: '调用评估模型' },
    NOW + 45_000,
  )
  state = recordRun(
    state,
    { mechanismId: 'mech_eval', runId: 'mrun_e2', trigger: '变化事件检查', startedAt: NOW + 46_000, finishedAt: NOW + 96_000, wallClockMs: 50_000, modelCalls: 1, tokens: 800, actualAction: '调用评估模型' },
    NOW + 96_000,
  )
  assert.equal(timeoutStreak(state, 'mech_eval', 30_000), 2, '两次运行的墙钟都超过策略超时 30000ms')
  const early = applyBreaker(state, 'mech_eval', { timeoutStreak: 2, noChangeStreak: 0, failureStreak: 0 }, NOW + 100_000)
  assert.equal(early.breaker.break, false, '两次超时未达"反复"阈值：不熔断')
  assert.equal(early.state.revision, state.revision, '未达阈值不产生半次状态变更（不预支停用）')
  assert.equal(mechanismAvailability(early.state, 'mech_eval').adjudicative, true, '未反复前评估器仍正常出判定')

  // 第三次超时：达到反复阈值 → 熔断进 cooling
  state = recordRun(
    state,
    { mechanismId: 'mech_eval', runId: 'mrun_e3', trigger: '变化事件检查', startedAt: NOW + 110_000, finishedAt: NOW + 160_000, wallClockMs: 50_000, modelCalls: 1, tokens: 800, actualAction: '调用评估模型' },
    NOW + 160_000,
  )
  const streak = timeoutStreak(state, 'mech_eval', 30_000)
  assert.equal(streak, BREAKER_TIMEOUT_STREAK, '三次墙钟都超过策略超时：达到"反复超时"阈值')
  const broken = applyBreaker(state, 'mech_eval', { timeoutStreak: streak, noChangeStreak: 0, failureStreak: 0 }, NOW + 170_000)
  assert.equal(broken.ok, true)
  assert.equal(broken.breaker.break, true, '可选评估器反复超时 → 熔断（V5-12）')
  assert.equal(broken.breaker.target, 'cooling')
  assert.ok(broken.breaker.reason.includes('连续 3 次超时'), '熔断理由写明连续次数与策略超时')
  assert.equal(broken.breaker.allowsDegradedWrites, false, '不靠"降级模式"继续未登记的写操作（§35.3）')
  const cooling = broken.state
  assert.equal(mechanismHead(cooling, 'mech_eval')?.status, 'cooling', '状态转为 cooling：按范围停用')

  // 退到观察：只剩建议与诊断，不再出判定；有变化事件也不再被调用
  const avail = mechanismAvailability(cooling, 'mech_eval')
  assert.equal(avail.adjudicative, false, '退到观察：不再出判定')
  assert.equal(avail.suggestionOnly, true, '只剩建议')
  assert.equal(avail.disposition?.verdict, 'degrade_or_disable', '可选建议超时：退为观察或停用建议（§35.1）')
  assert.deepEqual(avail.disposition?.keepsAvailable, ['diagnosis', 'data_export'], '可选评估退场也不关闭诊断与数据导出')
  assert.equal(avail.disposition?.expandsExecutionRights, false)
  const evalPolicy = avail.policy
  if (evalPolicy === undefined) throw new Error('夹具：mech_eval 策略缺失')
  const skipped = triggerLayer({
    policy: evalPolicy,
    cacheKey: 'mech_eval@2|target=sub1|rule=1|evidence=1|env=1',
    fieldStateChanged: true,
    relevantRevisionsChanged: true,
    now: NOW + 180_000,
  })
  assert.equal(skipped.layer, 'skip', '冷却期按范围停用：有变化事件也不调用它，不消耗治理预算（§35.3）')

  // 冷却结束只重新检查能力：通过也只回到 observing，不视为故障已修复
  const notFixed = recheckAfterCooldown(cooling, 'mech_eval', { capable: false, note: '同批样例仍然超时' }, NOW + 200_000)
  assert.equal(notFixed.ok, false, '能力检查未通过：继续保持停用')
  assert.equal(mechanismHead(notFixed.state, 'mech_eval')?.status, 'cooling')
  const rechecked = recheckAfterCooldown(cooling, 'mech_eval', { capable: true, note: '超时配置已修正' }, NOW + 210_000)
  assert.equal(rechecked.ok, true)
  assert.equal(rechecked.failureAssumedRepaired, false, '冷却结束≠故障已修复（§35.3）')
  assert.equal(rechecked.autoRestartCancelledTasks, false, '已取消的任务不因冷却结束自动重启')
  assert.equal(mechanismHead(rechecked.state, 'mech_eval')?.status, 'observing', '复审通过只回到 observing 重新积累观察，不直接回 active')
  const availAfter = mechanismAvailability(rechecked.state, 'mech_eval')
  assert.equal(availAfter.adjudicative, false, '观察期仍不出判定')
  assert.equal(availAfter.suggestionOnly, true)

  // —— 必要验收器：连续故障后未验证不算通过，但诊断入口仍可用 ——
  const proposedAcc = proposeMechanism(
    rechecked.state,
    mechanismInput({ mechanismId: 'mech_acc', name: '必需回归验收器', class: 'required_acceptance', purpose: '对发布前交付物做必需回归验收', scope: '发布前回归验收', benefitSignal: '阻止了带缺陷发布' }),
    NOW + 220_000,
  )
  assert.equal(proposedAcc.ok, true)
  if (!proposedAcc.ok) return
  const accObserving = transitionMechanism(proposedAcc.state, 'mech_acc', 'start_observing', NOW + 221_000)
  const accActivated = transitionMechanism(accObserving.state, 'mech_acc', 'activate', NOW + 222_000)
  assert.equal(accActivated.ok, true, '必要验收器同样先观察后启用')
  const accBroken = applyBreaker(
    accActivated.state,
    'mech_acc',
    { timeoutStreak: 0, noChangeStreak: 0, failureStreak: BREAKER_FAILURE_STREAK },
    NOW + 230_000,
  )
  assert.equal(accBroken.breaker.break, true, '必要验收器连续故障 → 熔断')
  assert.equal(accBroken.breaker.target, 'cooling')
  const accState = accBroken.state
  const accAvail = mechanismAvailability(accState, 'mech_acc')
  assert.equal(accAvail.adjudicative, false, '失效的验收器不再出具判定')
  assert.equal(accAvail.disposition?.verdict, 'not_passed', '必要验收器失效：未验证不算通过，不是自动豁免（§35.1、V5-12）')
  assert.notEqual(accAvail.disposition?.verdict, 'degrade_or_disable', '不按可选建议那样"降级了事"：依赖它的验收没有通过口径')
  assert.deepEqual(
    accAvail.disposition?.keepsAvailable,
    ['diagnosis', 'cancel', 'reconcile', 'substitute_approved_method', 'wait'],
    '诊断入口仍可用，还可取消/核对/换已认可方法/等待；允许清单里没有任何"自动通过"通道',
  )
  assert.equal(accAvail.disposition?.expandsExecutionRights, false, '处置不扩大任何执行权限')
  const accDisp = dispositionForMechanism(accState, 'mech_acc', 'error')
  assert.equal(accDisp.verdict, 'not_passed')
  assert.ok(accDisp.reason.includes('不能自动豁免'), '拒绝口径要写明：不得把没验证过的当通过')
  assert.ok(accDisp.keepsAvailable.includes('diagnosis'), '诊断入口保持可用（V5-12 后半句）')
  const accPolicy = accAvail.policy
  if (accPolicy === undefined) throw new Error('夹具：mech_acc 策略缺失')
  const accSkipped = triggerLayer({
    policy: accPolicy,
    cacheKey: 'mech_acc@2|target=rel1|rule=1|evidence=1|env=1',
    fieldStateChanged: true,
    relevantRevisionsChanged: true,
    now: NOW + 240_000,
  })
  assert.equal(accSkipped.layer, 'skip', '停用的验收器同样不被无谓调用')
})
