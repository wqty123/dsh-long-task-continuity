/**
 * v0.5 §28 整体工作记录/决定依据包 + §32 记录权威与证据溯源：正反例成对回归集。
 *
 * 用例口径与 `rules-r01-r18.test.ts` 一致：每个判定函数至少配一个**已知坏样例**，
 * 坏样例被放行即为缺陷（DG-10"能拦住错误"）；正例同时点明"具体记下了什么边界"。
 * 设计稿节号锚点散落在各断言消息里，便于逐条对回 §28/§32 与 §36.2 的 V5-06/V5-07。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GLOBAL_BOUNDARY_NOTE,
  assessBriefFreshness,
  buildCoverage,
  classifyClaim,
  prepareBrief,
  readEvidence,
  recordBrief,
  recordCoverage,
  recordsOverview,
  recordsQuery,
} from '../src/core/records.ts'
import type { BriefInput, CoverageInput } from '../src/core/records.ts'
import {
  assessProvenance,
  checkProvenanceRef,
  claimUsableFor,
  conditionsRetained,
  findDerivationCycles,
  independenceReport,
  independentSourceCount,
  recordClassOf,
  recordClassUse,
  traceProvenance,
} from '../src/core/provenance.ts'
import type { ProvenanceSubject } from '../src/core/provenance.ts'
import type { MissionControl } from '../src/core/control.ts'
import type { ClaimRevision, EvidenceRecord, ProvenanceRef, RecordCoverage } from '../src/core/entities.ts'
import {
  NOW,
  apply,
  asMember,
  claimTaskAs,
  crew,
  ctx,
  evidences,
  must,
  proposeClaim,
  proposeObligation,
  readyTask,
  recordEvidence,
  req,
} from './discipline-fixtures.ts'

// ─────────────────────────────── 夹具 ───────────────────────────────

function okCoverage(state: MissionControl, patch: Partial<CoverageInput> = {}): RecordCoverage {
  const built = buildCoverage(
    state,
    {
      sourceCuts: [{ source: 'session:sess-1', watermark: 'seq:9', durability: 'durable' }],
      completeness: 'complete_within_scope',
      ...patch,
    },
    NOW,
  )
  if (!built.ok) throw new Error(`夹具：覆盖回执组装被拒：${built.reason}`)
  return built.coverage
}

function withRecordedCoverage(state: MissionControl, patch: Partial<CoverageInput> = {}): { state: MissionControl; coverage: RecordCoverage } {
  const coverage = okCoverage(state, patch)
  const recorded = recordCoverage(state, coverage, NOW)
  if (!recorded.ok) throw new Error(`夹具：覆盖回执登记被拒：${recorded.reason}`)
  return { state: recorded.state, coverage }
}

/** 纯输入形态的证据记录（溯源模块只吃映射，不需要走命令链）。 */
function evd(id: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    evidenceId: id,
    missionId: 'mss_discipline',
    kind: 'observation',
    summary: `观测 ${id}`,
    observedAt: NOW,
    sourceRef: `run:${id}`,
    recordedBy: 'lead-1',
    validity: 'current',
    ...overrides,
  }
}

function claimRecord(overrides: Partial<ClaimRevision> = {}): ClaimRevision {
  return {
    claimId: 'clm_test',
    version: 1,
    proposition: '测试结论',
    appliesUnder: [],
    sourceCategory: 'observation',
    status: 'supported',
    validity: 'current',
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    reentryConditions: [],
    authorActorId: 'lead-1',
    createdAt: NOW,
    ...overrides,
  }
}

/** 一桌"有证据、有结论"的状态：支持/反证/未评估各一条，供依据包与分拣用例复用。 */
interface ClaimRig {
  readonly state: MissionControl
  readonly supported: string
  readonly refuted: string
  readonly proposed: string
  readonly evidenceId: string
}

function claimRig(): ClaimRig {
  let { state } = crew()
  const evidence = recordEvidence(state, {}, ctx('lead', 'lead-1'))
  state = evidence.state
  const supported = proposeClaim(
    state,
    { sourceCategory: 'observation', status: 'supported', supportingEvidenceIds: evidences(evidence.evidenceId) },
    ctx('lead', 'lead-1'),
  )
  state = supported.state
  const refuted = proposeClaim(
    state,
    {
      sourceCategory: 'observation',
      status: 'refuted',
      subject: '路径 P',
      implementationVersion: 'v1',
      inputCondition: '输入 A',
      verifiedRange: '样例 n=3',
      contradictingEvidenceIds: evidences(evidence.evidenceId),
    },
    ctx('lead', 'lead-1'),
  )
  state = refuted.state
  const proposed = proposeClaim(state, { sourceCategory: 'inference', status: 'proposed', supportingEvidenceIds: [] }, ctx('lead', 'lead-1'))
  state = proposed.state
  return { state, supported: supported.claimId, refuted: refuted.claimId, proposed: proposed.claimId, evidenceId: evidence.evidenceId }
}

function targetAll(rig: ClaimRig): string[] {
  return [`claim:${rig.supported}`, `claim:${rig.refuted}`, `claim:${rig.proposed}`]
}

function briefInput(rig: ClaimRig, overrides: Partial<BriefInput> = {}): BriefInput {
  return { kind: 'dispatch', targetRefs: targetAll(rig), preparedBy: 'lead-1', ...overrides }
}

// ─────────────────────────────── 覆盖回执（§28.4）───────────────────────────────

test('覆盖回执：完整读取组装通过，水位绑定当前修订，持久性边界随回执转述', () => {
  const { state } = crew()
  const built = buildCoverage(
    state,
    {
      sourceCuts: [
        { source: 'session:sess-1', watermark: 'seq:42', durability: 'durable' },
        { source: 'session:sess-2', watermark: 'seq:7', durability: 'session_only' },
      ],
      completeness: 'complete_within_scope',
      filters: ['mission=mss_discipline'],
      pages: 3,
    },
    NOW,
  )
  assert.equal(built.ok, true, '两个来源切面、无截断无错误的完整回执应当通过')
  if (!built.ok) return
  assert.match(built.coverage.coverageId, /^cvr_/, 'id 由内核 mintId 分配')
  assert.equal(built.coverage.asOfMissionRevision, state.revision)
  assert.equal(built.coverage.truncated, false)
  assert.ok(built.caveats.some((line) => line.includes('session_only')), '非持久来源的边界要随回执转述（§28.4）')
  assert.ok(built.caveats.some((line) => line.includes('不声称跨会话原子性')), '§28.4：不同会话读出的快照不声称跨会话原子性')

  const recorded = recordCoverage(state, built.coverage, NOW)
  assert.equal(recorded.ok, true)
  if (!recorded.ok) return
  assert.equal(recorded.state.revision, state.revision + 1, '状态变更经 commit()：修订号 +1')
  assert.equal(recorded.state.coverages[built.coverage.coverageId]?.completeness, 'complete_within_scope')
  assert.equal(recorded.state.events.at(-1)?.kind, 'records/coverage-recorded')
})

test('覆盖回执（DG-10）：自称 complete_within_scope 却带截断/错误/冲突/空来源的全部被拦下', () => {
  const { state } = crew()
  const base: CoverageInput = {
    sourceCuts: [{ source: 'session:sess-1', watermark: 'seq:1', durability: 'durable' }],
    completeness: 'complete_within_scope',
  }
  const badSamples: readonly [string, Partial<CoverageInput>][] = [
    ['截断', { truncated: true }],
    ['查询错误', { errors: ['后端超时'] }],
    ['未解决冲突', { unresolvedConflicts: ['两名成员结论相反'] }],
    ['空来源', { sourceCuts: [] }],
  ]
  for (const [label, patch] of badSamples) {
    const built = buildCoverage(state, { ...base, ...patch }, NOW)
    assert.equal(built.ok, false, `${label}：自称查完就必须没有截断/错误/冲突/空来源，坏样例应被拦住`)
    if (built.ok) continue
    assert.ok(built.blockers.length > 0, `${label}：拦截要给出可转述的阻断项`)
  }
  // 对照正例：同样的内容按 partial 如实声明 → 放行，但限制进 caveats
  const honest = buildCoverage(state, { ...base, completeness: 'partial', truncated: true }, NOW)
  assert.equal(honest.ok, true, '如实标 partial 的读取应放行')
  if (honest.ok) assert.ok(honest.caveats.some((line) => line.includes('截断')))
})

test('覆盖回执：坏持久性词、重复水位、未来水位、非法 pages 都被拦下（DG-10）', () => {
  const { state } = crew()
  const badDurability = buildCoverage(state, {
    sourceCuts: [{ source: 's', watermark: 'w1', durability: 'forever' as CoverageInput['sourceCuts'][number]['durability'] }],
    completeness: 'partial',
  }, NOW)
  assert.equal(badDurability.ok, false)
  const dupWatermark = buildCoverage(state, {
    sourceCuts: [
      { source: 's', watermark: 'w1', durability: 'durable' },
      { source: 's', watermark: 'w2', durability: 'durable' },
    ],
    completeness: 'partial',
  }, NOW)
  assert.equal(dupWatermark.ok, false)
  const future = buildCoverage(state, { sourceCuts: [], completeness: 'unavailable', asOfMissionRevision: state.revision + 1 }, NOW)
  assert.equal(future.ok, false, '水位晚于当前修订即记录不一致')
  const pages = buildCoverage(state, {
    sourceCuts: [{ source: 's', watermark: 'w1', durability: 'durable' }],
    completeness: 'partial',
    pages: -1,
  }, NOW)
  assert.equal(pages.ok, false)
})

test('覆盖回执：只追加不覆盖，重复登记同一 id 被拒', () => {
  const { state } = crew()
  const coverage = okCoverage(state)
  const first = recordCoverage(state, coverage, NOW)
  assert.equal(first.ok, true)
  if (!first.ok) return
  const again = recordCoverage(first.state, coverage, NOW)
  assert.equal(again.ok, false)
  assert.ok(again.reason.includes('只追加'), '重复回执不能覆盖既有覆盖证据')
})

// ─────────────────────────────── 决定依据包（§28.4、§28.5）───────────────────────────────

test('决定依据包：绑定覆盖、claimVersions 水位、支持/反证/未决分拣与阻断齐备', () => {
  const rig = claimRig()
  const covered = withRecordedCoverage(rig.state)
  const prepared = prepareBrief(covered.state, briefInput(rig), NOW)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const brief = prepared.brief
  assert.match(brief.briefId, /^brf_/)
  assert.equal(brief.coverageId, covered.coverage.coverageId, '缺省绑定该 Mission 最新一份覆盖回执')
  assert.deepEqual(Object.keys(brief.claimVersions).sort(), [rig.supported, rig.refuted, rig.proposed].sort(), 'targetRefs 的 `claim:` 前缀项进入水位绑定')
  assert.deepEqual(brief.supportedRefs, [`${rig.supported}@1`])
  assert.deepEqual(brief.contradictedRefs, [`${rig.refuted}@1`])
  assert.deepEqual(brief.unresolvedRefs, [`${rig.proposed}@1`])
  assert.ok(brief.blockers.some((line) => line.includes('有反证')), '反证项要成为阻断，转述给决策者')
  assert.ok(!brief.blockers.some((line) => line.includes(rig.supported)), '有效支持项不应产生阻断')
  assert.equal(brief.asOfMissionRevision, covered.state.revision)
  assert.equal(brief.policyRevision, covered.state.mission.policyRevision)

  const recorded = recordBrief(covered.state, brief, NOW)
  assert.equal(recorded.ok, true)
  if (!recorded.ok) return
  assert.equal(recorded.freshness.verdict, 'current')
  assert.equal(recorded.state.revision, covered.state.revision + 1)
  assert.ok(recorded.state.briefs[brief.briefId] !== undefined)
  // 自登记后的水位差：相关版本未动 → behind_unrelated 且可用（§28.4 无关进展不反复失效）
  const after = assessBriefFreshness(recorded.state, brief)
  assert.equal(after.verdict, 'behind_unrelated')
  assert.equal(after.usable, true)
})

test('依据包新鲜度：无关进展不失效；被引用结论修订后即失效且登记被拒（§28.4）', () => {
  const rig = claimRig()
  const covered = withRecordedCoverage(rig.state)
  const prepared = prepareBrief(covered.state, briefInput(rig), NOW)
  assert.ok(prepared.ok)
  if (!prepared.ok) return
  const recorded = recordBrief(covered.state, prepared.brief, NOW)
  assert.ok(recorded.ok)
  if (!recorded.ok) return
  const brief = prepared.brief

  // 无关进展：登记一条与本决定无关的承诺 → 仍可用
  const unrelated = proposeObligation(recorded.state, 'lead-1', {}, ctx('lead', 'lead-1')).state
  const verdictUnrelated = assessBriefFreshness(unrelated, brief)
  assert.equal(verdictUnrelated.verdict, 'behind_unrelated')
  assert.equal(verdictUnrelated.usable, true, '无关进展不必导致所有提案反复失效（§28.4）')

  // 相关失效：被引用的结论被修订（撤回传播同时推进 basisRevision，V5-07）
  const revised = apply(
    unrelated,
    { kind: 'claim.revise', requestId: req(), claimId: rig.supported, status: 'refuted', retractionReason: '根证据失效' },
    ctx('supervisor'),
  )
  assert.ok(revised.basisRevision > unrelated.basisRevision, '结论撤回要推进依据有效性版本')
  const verdictStale = assessBriefFreshness(revised, brief)
  assert.equal(verdictStale.verdict, 'stale')
  assert.equal(verdictStale.usable, false)
  assert.ok(verdictStale.drifts.some((line) => line.includes(rig.supported) && line.includes('水位')), '漂移原因要能对回具体结论')

  const refused = recordBrief(revised, brief, NOW)
  assert.equal(refused.ok, false, '已失效的依据包不得再登记为放行依据')
  assert.ok(refused.drifts.length > 0)
})

test('依据包：缺覆盖明示不足且不能登记；显现截断的覆盖可登记但阻断随包转述', () => {
  const rig = claimRig()
  // 没有任何覆盖回执：组装仍产出依据包，但明示不足、coverageId 留空
  const noCoverage = prepareBrief(rig.state, briefInput(rig), NOW)
  assert.ok(noCoverage.ok)
  if (!noCoverage.ok) return
  assert.equal(noCoverage.brief.coverageId, '')
  assert.ok(noCoverage.brief.blockers.some((line) => line.includes('没有可绑定的覆盖回执')))
  const refused = recordBrief(rig.state, noCoverage.brief, NOW)
  assert.equal(refused.ok, false, '缺覆盖的包不能登记为放行依据（§28.4）')
  assert.ok(refused.drifts.some((line) => line.includes('覆盖回执')))
  // 显式绑定一个不存在的回执：同样明示问题
  const dangling = prepareBrief(rig.state, briefInput(rig, { coverageId: 'cvr_missing' }), NOW)
  assert.ok(dangling.ok)
  if (dangling.ok) assert.ok(dangling.brief.blockers.some((line) => line.includes('不在记录中')))

  // 截断的覆盖：如实登记可以，但"不能宣布没有"的阻断必须随包
  const truncated = withRecordedCoverage(rig.state, { completeness: 'partial', truncated: true })
  const prepared = prepareBrief(truncated.state, briefInput(rig), NOW)
  assert.ok(prepared.ok)
  if (!prepared.ok) return
  assert.ok(prepared.brief.blockers.some((line) => line.includes('截断')))
  assert.ok(prepared.brief.blockers.some((line) => line.includes('覆盖不完整')))
  const recorded = recordBrief(truncated.state, prepared.brief, NOW)
  assert.equal(recorded.ok, true)
})

test('依据包缺省覆盖：同毫秒并列时绑定后登记的一份，不按随机 ID 字典序掷硬币', () => {
  let { state } = crew()
  const cuts: CoverageInput['sourceCuts'] = [{ source: 'session:sess-1', watermark: 'seq:9', durability: 'durable' }]
  const partialBuilt = buildCoverage(state, { sourceCuts: cuts, completeness: 'partial' }, NOW)
  if (!partialBuilt.ok) throw new Error(`夹具：覆盖回执组装被拒：${partialBuilt.reason}`)
  // 固定 ID 让对照组可判：按 ID 字典序取"最小"会绑到先登记的 partial（cvr_aaa），务必挂在这条断言上
  const first = recordCoverage(state, { ...partialBuilt.coverage, coverageId: 'cvr_aaa' }, NOW)
  if (!first.ok) throw new Error(`夹具：覆盖回执登记被拒：${first.reason}`)
  const fullBuilt = buildCoverage(first.state, { sourceCuts: cuts, completeness: 'complete_within_scope' }, NOW)
  if (!fullBuilt.ok) throw new Error(`夹具：覆盖回执组装被拒：${fullBuilt.reason}`)
  const second = recordCoverage(first.state, { ...fullBuilt.coverage, coverageId: 'cvr_zzz' }, NOW)
  if (!second.ok) throw new Error(`夹具：覆盖回执登记被拒：${second.reason}`)
  const brief = prepareBrief(second.state, { kind: 'dispatch', targetRefs: [], preparedBy: 'lead-1' }, NOW)
  assert.ok(brief.ok)
  if (!brief.ok) return
  assert.equal(brief.brief.coverageId, 'cvr_zzz', 'createdAt 并列时以登记顺序为准：后登记的一份胜出，与 ID 字典序无关')
  assert.ok(!brief.brief.blockers.some((line) => line.includes('覆盖不完整')), '不能绑定到先登记的 partial 回执')
})

test('结论分拣：supported 的支撑证据失效后降为未决并阻断（§32.3）', () => {
  const rig = claimRig()
  const original = must('证据', rig.state.evidence[rig.evidenceId])
  const broken: MissionControl = {
    ...rig.state,
    evidence: { ...rig.state.evidence, [rig.evidenceId]: { ...original, validity: 'invalid' } },
  }
  const head = must('结论', broken.claims[rig.supported]?.at(-1))
  const verdict = classifyClaim(broken, head)
  assert.equal(verdict.stance, 'unresolved', '支撑失效后不能再按 supported 呈现')
  assert.ok(verdict.blocker?.includes('支撑证据已失效'))
})

// ─────────────────────────────── 三层读模型查询（§28.2、§28.3、§28.5）───────────────────────────────

test('records.overview：Scheduler 读全局结构化字段，成员只看自身任务（§28.3）', () => {
  let { state } = crew()
  const taskA = readyTask(state, { title: 'A 任务' }, ctx('lead', 'lead-1'))
  state = taskA.state
  const taskB = readyTask(state, { title: 'B 任务' }, ctx('lead', 'lead-1'))
  state = taskB.state
  state = claimTaskAs(state, taskB.taskId, asMember()).state
  state = proposeObligation(state, 'lead-1', {}, ctx('lead', 'lead-1')).state
  const covered = withRecordedCoverage(state)
  state = covered.state

  const scheduler = recordsOverview(state, { role: 'supervisor' })
  assert.equal(scheduler.scope, 'mission')
  assert.equal(scheduler.revision, state.revision)
  assert.equal(scheduler.watermarks.policyRevision, state.mission.policyRevision)
  assert.ok(scheduler.budget !== undefined, 'Scheduler 要能读资源/预算')
  assert.ok(scheduler.blockers.some((line) => line.includes('未闭环承诺')))
  assert.equal(scheduler.coverage?.coverageId, covered.coverage.coverageId)
  assert.ok(scheduler.notes.includes(GLOBAL_BOUNDARY_NOTE), '全局边界声明要随概览转述（§28.1）')

  const member = recordsOverview(state, { role: 'member', actorId: 'member-1' })
  assert.equal(member.scope, 'own_tasks')
  assert.deepEqual(member.tasks.map((task) => task.taskId), [taskB.taskId], '成员只拿自身任务明细')
  assert.equal(member.budget, undefined, '成员不暴露全局预算账')
  assert.ok(!member.tasks.some((task) => task.taskId === taskA.taskId))
  assert.ok(member.notes.some((line) => line.includes('紧凑概览')), '默认紧凑概览 + 相关记录，不整包注入（§28.3）')

  const subagent = recordsOverview(state, { role: 'subagent', taskRefs: [taskB.taskId] })
  assert.equal(subagent.scope, 'own_tasks')
  assert.deepEqual(subagent.tasks.map((task) => task.taskId), [taskB.taskId])
  assert.ok(subagent.notes.some((line) => line.includes('申请补充')), '子代理不冒充全知（§28.3）')
})

test('records.overview：增量按 sinceRevision 取事件，未来水位与范围裁剪都如实标注（§28.4）', () => {
  let { state } = crew()
  const snapshot = state.revision
  const task = readyTask(state, {}, ctx('lead', 'lead-1'))
  state = task.state
  state = claimTaskAs(state, task.taskId, asMember()).state

  const overview = recordsOverview(state, { role: 'lead', sinceRevision: snapshot })
  assert.equal(overview.delta.events.length, state.revision - snapshot, '每次提交一条事件，增量应逐条对上')
  assert.ok(overview.delta.events.every((event) => event.seq >= snapshot))
  assert.equal(overview.delta.truncated, false)

  const quiet = recordsOverview(state, { role: 'lead', sinceRevision: state.revision })
  assert.equal(quiet.delta.events.length, 0, '水位等于当前修订：没有增量')

  const future = recordsOverview(state, { role: 'lead', sinceRevision: state.revision + 5 })
  assert.equal(future.delta.events.length, 0)
  assert.ok(future.notes.some((line) => line.includes('晚于当前修订')))

  // 追加一条与 member-1 无关的任务：其事件必须被成员范围裁剪掉
  const other = readyTask(state, { title: 'B 任务' }, ctx('lead', 'lead-1'))
  const member = recordsOverview(other.state, { role: 'member', actorId: 'member-1', sinceRevision: snapshot })
  assert.equal(member.delta.events.length, state.revision - snapshot, '成员增量保留自身任务事件')
  assert.ok(member.delta.omitted >= 2, '成员增量只列自身任务相关事件，其余按范围裁剪')
  assert.ok(member.notes.some((line) => line.includes('按自身范围裁剪')))
})

test('records.query：字面过滤、稳定分页回执与结论姿态分拣（§28.5）', () => {
  let { state } = crew()
  const e1 = recordEvidence(state, { summary: '解析器在样例 A 上的成功率 0.81' })
  state = e1.state
  const e2 = recordEvidence(state, { summary: '解析器在样例 B 上的成功率 0.55' })
  state = e2.state
  const e3 = recordEvidence(state, { summary: '缓存命中率提升', metricId: 'cache_hit' })
  state = e3.state
  const c1 = proposeClaim(state, { sourceCategory: 'observation', status: 'supported', supportingEvidenceIds: evidences(e1.evidenceId) })
  state = c1.state
  const c2 = proposeClaim(state, {
    sourceCategory: 'observation',
    status: 'refuted',
    subject: '解析器样例 B',
    implementationVersion: 'v1',
    inputCondition: '输入 B',
    verifiedRange: 'n=3',
    contradictingEvidenceIds: evidences(e2.evidenceId),
  })
  state = c2.state

  const page = recordsQuery(state, { text: '解析器', limit: 2 })
  assert.equal(page.receipt.matched, 4, '命中 2 条证据 + 2 条结论')
  assert.equal(page.items.length, 2)
  assert.equal(page.receipt.hasMore, true)
  assert.ok(page.receipt.nextCursor !== undefined)
  assert.ok(page.receipt.note.includes('不得把当前页当作'), '分页未取完必须写进回执（§22.2 DG-02 口径）')
  const second = recordsQuery(state, { text: '解析器', limit: 2, cursor: page.receipt.nextCursor })
  assert.equal(second.receipt.returned, 2)
  assert.equal(second.receipt.hasMore, false)
  const refs = [...page.items, ...second.items].map((item) => item.ref)
  assert.deepEqual(refs, [...refs].sort(), '排序用显式 ref 键，分页可复现')
  const refutedItem = [...page.items, ...second.items].find((item) => item.ref.startsWith(`claim:${c2.claimId}`))
  assert.equal(refutedItem?.stance, 'contradicted', '结论按当前状态给出姿态')

  const badCursor = recordsQuery(state, { cursor: 'next-page' })
  assert.ok(badCursor.receipt.errors.some((line) => line.includes('cursor')), '坏游标要被拦下而不是静默从头发')
  assert.equal(badCursor.items.length, 0)
})

test('records.query：子代理有界查询必须带任务范围，只拿获准的结论（§28.3）', () => {
  let { state } = crew()
  const task = readyTask(state, {}, ctx('lead', 'lead-1'))
  state = task.state
  const bound = recordEvidence(state, { taskId: task.taskId, summary: '任务内观测' })
  state = bound.state
  const unbound = recordEvidence(state, { summary: '任务外观测' })
  state = unbound.state
  const claim = proposeClaim(state, { sourceCategory: 'observation', status: 'supported', supportingEvidenceIds: evidences(bound.evidenceId) })
  state = claim.state

  const unbounded = recordsQuery(state, { role: 'subagent' })
  assert.ok(unbounded.receipt.errors.some((line) => line.includes('scope.taskRefs')), '子代理无范围查询应被拦下')
  assert.equal(unbounded.items.length, 0)

  const bounded = recordsQuery(state, { role: 'subagent', scope: { taskRefs: [task.taskId] } })
  const refs = bounded.items.map((item) => item.ref)
  assert.deepEqual(refs, [`evidence:${bound.evidenceId}`], '只返回任务范围内的证据；结论需显式获准')
  assert.ok(!refs.some((ref) => ref.startsWith('claim:')))
})

test('records.readEvidence：返回索引条目与完整性标识，原件在来源侧（§28.2、§28.5）', () => {
  let { state } = crew()
  const recorded = recordEvidence(state, { kind: 'reported', summary: '转述的读数', completeness: 'partial' })
  state = recorded.state
  const read = readEvidence(state, `evidence:${recorded.evidenceId}`)
  assert.equal(read.ok, true)
  assert.equal(read.evidence?.evidenceId, recorded.evidenceId)
  assert.equal(read.integrity?.rawTextInKernel, false, '内核只存索引摘要，原始片段不在这里（§28.2）')
  assert.ok(read.integrity?.flags.some((line) => line.includes('转述')), '转述不是新增独立证据（§32.1）')
  assert.ok(read.integrity?.flags.some((line) => line.includes('partial')), '完整性标识随读取返回')
  assert.ok(read.reason.includes('按来源'), '定位与复核路径要写清')

  const missing = readEvidence(state, 'evidence:evd_nope')
  assert.equal(missing.ok, false)
  assert.ok(missing.reason.includes('不等于原件不存在'), '找不到记录不等于原件不存在（§28.1 边界）')
})

test('records.readEvidence：子代理超范围读取被拒，任务内可读（§28.3）', () => {
  let { state } = crew()
  const task = readyTask(state, {}, ctx('lead', 'lead-1'))
  state = task.state
  const bound = recordEvidence(state, { taskId: task.taskId })
  state = bound.state
  const unbound = recordEvidence(state, {})
  state = unbound.state

  const outside = readEvidence(state, unbound.evidenceId, { role: 'subagent', taskRefs: [task.taskId] })
  assert.equal(outside.ok, false)
  assert.ok(outside.reason.includes('有限范围'), '超范围读取要申请补充，不能悄悄放行')
  const inside = readEvidence(state, bound.evidenceId, { role: 'subagent', taskRefs: [task.taskId] })
  assert.equal(inside.ok, true)
})

// ─────────────────────────────── 溯源校验（§32.1、DG-10）───────────────────────────────

test('溯源引用校验：none 只表示 provenance_unknown，不得带地址或版本（§32.1）', () => {
  assert.equal(checkProvenanceRef({ kind: 'operation', ref: 'op_1', version: '3' }).ok, true)
  assert.equal(checkProvenanceRef({ kind: 'evidence', ref: '   ' }).ok, false, '坏样例：空地址')
  assert.equal(checkProvenanceRef({ kind: 'none', ref: '' }).ok, true)
  assert.equal(checkProvenanceRef({ kind: 'none', ref: 'rpt:legacy' }).ok, false, '坏样例：none 带地址是伪造引用')
  assert.equal(checkProvenanceRef({ kind: 'none', ref: '', version: '1' }).ok, false, '坏样例：none 带版本')
  assert.equal(checkProvenanceRef({ kind: 'mystery' as ProvenanceRef['kind'], ref: 'x' }).ok, false, '坏样例：词表外种类')
})

test('四类记录不得冒充：猜想/决策不能当事实支持，摘要不新增独立来源（§32.1）', () => {
  assert.equal(recordClassOf('observation'), 'observation')
  assert.equal(recordClassOf('reported'), 'summary')
  assert.equal(recordClassOf('inference'), 'interpretation')
  assert.equal(recordClassOf('conjecture'), 'interpretation')
  assert.equal(recordClassOf('simulated'), 'interpretation')
  assert.equal(recordClassOf('reference_bound'), 'observation')

  const observation = recordClassUse('observation', 'root_support')
  assert.equal(observation.ok, true)
  assert.equal(observation.countsAsIndependent, true)
  const summary = recordClassUse('summary', 'root_support')
  assert.equal(summary.ok, true)
  assert.equal(summary.countsAsIndependent, false, '摘要指向的还是原观测：不能重复计数（§32.2）')
  assert.equal(recordClassUse('interpretation', 'root_support').ok, false, '坏样例：猜想当事实支持')
  assert.equal(recordClassUse('decision', 'root_support').ok, false, '坏样例：决策证明选择，不证明选项优劣')
  assert.equal(recordClassUse('decision', 'context').ok, true)
})

test('溯源评估：观测必须有根引用，转述不能冒充观测，派生的确定性不得超来源（DG-10）', () => {
  const good: ProvenanceSubject = { sourceCategory: 'observation', recordId: 'evd_a', rootRefs: [{ kind: 'operation', ref: 'op_1' }] }
  assert.equal(assessProvenance(good).ok, true)

  const reportOnly: ProvenanceSubject = { sourceCategory: 'observation', recordId: 'evd_r', rootRefs: [{ kind: 'report', ref: 'rpt:1' }] }
  const impersonation = assessProvenance(reportOnly)
  assert.equal(impersonation.ok, false, '坏样例：只有转述引用的"观测"')
  assert.ok(impersonation.findings.some((finding) => finding.kind === 'impersonation'))

  const noneObservation: ProvenanceSubject = { sourceCategory: 'observation', recordId: 'evd_n', rootRefs: [{ kind: 'none', ref: '' }] }
  assert.equal(assessProvenance(noneObservation).ok, false, '坏样例：观测标 provenance_unknown，应降为 reported')

  const promoted: ProvenanceSubject = {
    sourceCategory: 'observation',
    recordId: 'evd_p',
    derivation: { method: '汇总', fromEvidenceIds: ['evd_a'] },
  }
  const promotion = assessProvenance(promoted, { evd_a: evd('evd_a', { rootRefs: [{ kind: 'operation', ref: 'op_1' }] }) })
  assert.equal(promotion.ok, false, '坏样例：带派生的"观测"超出被引用记录的确定性（§32.3）')
  assert.ok(promotion.findings.some((finding) => finding.kind === 'promotion'))

  const mixed: ProvenanceSubject = {
    sourceCategory: 'reported',
    recordId: 'evd_m',
    rootRefs: [{ kind: 'none', ref: '' }, { kind: 'report', ref: 'rpt:1' }],
  }
  assert.equal(assessProvenance(mixed).ok, false, '坏样例：同时声称无法追溯与具体来源是自相矛盾')

  const legacy: ProvenanceSubject = { sourceCategory: 'reported', recordId: 'evd_l', rootRefs: [{ kind: 'none', ref: '' }] }
  const legacyReport = assessProvenance(legacy)
  assert.equal(legacyReport.ok, true, '正例：无法追溯的旧材料按 reported + none 如实标记（§32.1）')
  assert.ok(legacyReport.findings.some((finding) => finding.kind === 'missing_root' && finding.severity === 'note'))
})

test('溯源评估强度分层：普通笔记放行缺项，重要决定拦下缺项（§32.4）', () => {
  const bare: ProvenanceSubject = { sourceCategory: 'observation', recordId: 'evd_x' }
  assert.equal(assessProvenance(bare, undefined, 'ordinary').ok, true, '普通笔记不要求全面证据图')
  const strict = assessProvenance(bare, undefined, 'decision_grade')
  assert.equal(strict.ok, false, '进入重要决定的命题按对应强度拦截（§32.4）')
  assert.ok(strict.findings.some((finding) => finding.severity === 'gap'))

  const idea: ProvenanceSubject = { sourceCategory: 'conjecture', recordId: 'evd_c' }
  assert.equal(assessProvenance(idea, undefined, 'ordinary').ok, true)
  assert.equal(assessProvenance(idea, undefined, 'decision_grade').ok, true, '纯构想允许没有根证据（§31.3）')

  const dangling: ProvenanceSubject = {
    sourceCategory: 'reported',
    recordId: 'evd_d',
    derivation: { method: '转述', fromEvidenceIds: ['evd_gone'] },
  }
  assert.equal(assessProvenance(dangling, {}).ok, true)
  const danglingStrict = assessProvenance(dangling, {}, 'decision_grade')
  assert.equal(danglingStrict.ok, false, '坏样例：引用不存在的来源，重要决定必须拦下')
  assert.ok(danglingStrict.findings.some((finding) => finding.kind === 'broken_chain'))
})

test('派生链成环：标记且不从循环推导支持度（§32.2）', () => {
  const map = {
    evd_a: evd('evd_a', { derivation: { method: 'x', fromEvidenceIds: ['evd_b'] } }),
    evd_b: evd('evd_b', { derivation: { method: 'y', fromEvidenceIds: ['evd_a'] } }),
  }
  assert.deepEqual(findDerivationCycles(map), [['evd_a', 'evd_b']], '导入材料的环要被找到')
  assert.deepEqual(findDerivationCycles({ evd_ok: evd('evd_ok', { rootRefs: [{ kind: 'operation', ref: 'op_1' }] }) }), [])
  assert.deepEqual(findDerivationCycles({ evd_self: evd('evd_self', { derivation: { method: 'x', fromEvidenceIds: ['evd_self'] } }) }), [['evd_self']])

  const report = assessProvenance({ sourceCategory: 'reported', recordId: 'evd_a', derivation: { method: 'x', fromEvidenceIds: ['evd_b'] } }, map)
  assert.equal(report.ok, false)
  assert.ok(report.findings.some((finding) => finding.kind === 'cycle'))
  const trace = traceProvenance(map, 'evd_a')
  assert.equal(trace.cycle, true)
  assert.deepEqual(trace.roots, [], '成环时不产出虚假的根')
})

test('溯源链追踪：多级转述落到同一根来源，缺失节点标 unknown（§32.1、§32.2）', () => {
  const map = {
    evd_orig: evd('evd_orig', { rootRefs: [{ kind: 'operation', ref: 'op_1', version: '2' }] }),
    evd_t1: evd('evd_t1', { kind: 'reported', derivation: { method: '转述', fromEvidenceIds: ['evd_orig'] } }),
    evd_t2: evd('evd_t2', { kind: 'reported', derivation: { method: '再转述', fromEvidenceIds: ['evd_t1'] } }),
  }
  const trace = traceProvenance(map, 'evd_t2')
  assert.deepEqual(trace.chain, ['evd_t2', 'evd_t1', 'evd_orig'])
  assert.deepEqual(trace.roots, ['operation:op_1@2'])
  assert.equal(trace.cycle, false)
  assert.equal(trace.unknown, false)
  const ghost = traceProvenance(map, 'evd_ghost')
  assert.equal(ghost.unknown, true)
  assert.deepEqual(ghost.roots, [])
})

// ─────────────────────────────── 独立来源计数（§32.2、V5-06、V4-16）───────────────────────────────

test('独立来源：三次转述同一观测只算一个来源，不同观测按自身来源保留（V5-06）', () => {
  const records = [
    evd('evd_orig', { rootRefs: [{ kind: 'operation', ref: 'op_1' }] }),
    evd('evd_t1', { kind: 'reported', derivation: { method: '转述', fromEvidenceIds: ['evd_orig'] } }),
    evd('evd_t2', { kind: 'reported', derivation: { method: '转述', fromEvidenceIds: ['evd_orig'] } }),
    evd('evd_t3', { kind: 'reported', derivation: { method: '转述', fromEvidenceIds: ['evd_t1'] } }),
    evd('evd_other', { rootRefs: [{ kind: 'operation', ref: 'op_2' }] }),
  ]
  const map = Object.fromEntries(records.map((record) => [record.evidenceId, record]))
  const report = independenceReport(map, ['evd_t1', 'evd_t2', 'evd_t3', 'evd_orig', 'evd_other'])
  assert.equal(report.independentSources, 2, '多代理转述同一次观测不增加独立支持')
  assert.ok(report.groups.some((group) => group.members.length === 4 && group.origin.includes('operation:op_1')))
  assert.ok(report.reasons.some((line) => line.includes('只算一个观测来源')))
  assert.equal(independentSourceCount(map, ['evd_t1', 'evd_t2', 'evd_t3']), 1, '只数转述：归并为 1，而不是 3')
})

test('独立来源：共用验证器的多代理"支持"按共因归并（V4-16）', () => {
  const a = evd('evd_a', { rootRefs: [{ kind: 'operation', ref: 'op_a' }], commonDeps: ['validator:val_x'] })
  const b = evd('evd_b', { rootRefs: [{ kind: 'operation', ref: 'op_b' }], commonDeps: ['validator:val_x'] })
  const c = evd('evd_c', { rootRefs: [{ kind: 'operation', ref: 'op_c' }] })
  const report = independenceReport({ evd_a: a, evd_b: b, evd_c: c }, ['evd_a', 'evd_b', 'evd_c'])
  assert.equal(report.independentSources, 2, '代理人数不当成独立证据数')
  assert.deepEqual(report.sharedDeps, [{ dep: 'validator:val_x', members: ['evd_a', 'evd_b'] }])
  assert.ok(report.reasons.some((line) => line.includes('共因')))
  // 对照：没有显式声明的依赖就不猜——三个来源各自独立
  const clean = independenceReport(
    { evd_a: { ...a, commonDeps: [] }, evd_b: { ...b, commonDeps: [] }, evd_c: c },
    ['evd_a', 'evd_b', 'evd_c'],
  )
  assert.equal(clean.independentSources, 3, '未声明的关系不猜测（§32.2 v1 口径）')
})

test('独立来源：无法确认的标 unknown 不计数；内容哈希相同不自动合并（§32.2）', () => {
  const map = {
    evd_opaque: evd('evd_opaque', { kind: 'reported' }),
    evd_h1: evd('evd_h1', { rootRefs: [{ kind: 'operation', ref: 'op_1' }], contentHash: 'sha256:same' }),
    evd_h2: evd('evd_h2', { rootRefs: [{ kind: 'operation', ref: 'op_2' }], contentHash: 'sha256:same' }),
  }
  const report = independenceReport(map, ['evd_opaque', 'evd_h1', 'evd_h2'])
  assert.equal(report.independentSources, 2)
  assert.deepEqual(report.unknown, ['evd_opaque'], '缺来源链的记录不计入独立数')
  assert.ok(report.notes.some((line) => line.includes('哈希')), '字节相同既要提示，也不能自动并源')
})

// ─────────────────────────────── 结论更新的使用限制（§32.3）───────────────────────────────

test('结论使用限制：已反证可研究失效原因，不能作为生产前提（DG-10）', () => {
  const refuted = claimRecord({ status: 'refuted', validity: 'invalid', retractedAt: NOW, retractionReason: '状态改为 refuted' })
  assert.equal(claimUsableFor(refuted, 'research').ok, true, '研究用途：允许研究失效原因')
  const premise = claimUsableFor(refuted, 'premise')
  assert.equal(premise.ok, false, '坏样例：拿已反证的结论当生产前提')
  assert.ok(premise.reason.includes('不能作为生产用途'))

  const supported = claimRecord({ appliesUnder: ['实现版本 v1', '输入条件 A'] })
  const usable = claimUsableFor(supported, 'premise')
  assert.equal(usable.ok, true)
  assert.deepEqual(usable.requiredConditions, ['实现版本 v1', '输入条件 A'], '作为前提必须携带适用条件')

  assert.equal(claimUsableFor(claimRecord({ status: 'supported', contradictingEvidenceIds: ['evd_x'] }), 'premise').ok, false, '存在争议时先裁决（§34.2）')
  assert.equal(claimUsableFor(claimRecord({ validity: 'needs_review' }), 'premise').ok, false)
})

test('摘要不得删除适用条件：机械比对结构化字段（§32.3）', () => {
  const source = claimRecord({ appliesUnder: ['实现版本 v1', '输入条件 A'] })
  assert.equal(conditionsRetained(source, ['实现版本 v1', '输入条件 A']).ok, true)
  const dropped = conditionsRetained(source, ['实现版本 v1'])
  assert.equal(dropped.ok, false, '坏样例：派生摘要删掉了适用条件')
  assert.deepEqual(dropped.missing, ['输入条件 A'])
})
