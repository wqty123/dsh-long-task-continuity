/**
 * 设计稿 v0.5 §29.1 团队连续性与混合多代理验收条目（V4-13 … V4-18）的电池。
 *
 * 每条 V 编号一个 `test()`，标题以编号开头；条目含两个分句时两侧分别断言：
 * - 拦错侧：把"单页/缺成员当全量、旧票据继续用、代理人数当独立证据数、故障当健康、
 *   依赖 UI 才调度"这些坏样例留住，放行即缺陷（DG-10 口径）；
 * - 放行侧：按记录如实声明范围、无关任务与无关结论照常推进、原生容量兜底仍可用。
 *
 * 本文件自包含：底座用 `test/fixtures.ts` 的通用夹具，链上与记录面构建器（覆盖回执、
 * 纯输入证据/结论）按 `test/v05-records-provenance.test.ts` 的本地构建器复制在本文件里，
 * 全部判定现场调用 `src/core/*` 与 `src/adapter/*` 的导出函数，不引入第二套判定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { dispatch } from '../src/core/commands.ts'
import type { ClaimInput, CommandContext, EvidenceInput } from '../src/core/commands.ts'
import type { MissionControl } from '../src/core/control.ts'
import { grantCovers, ticketIsCurrent } from '../src/core/discipline.ts'
import type { ActorRole, ClaimRevision, EvidenceRecord, RecordCoverage } from '../src/core/entities.ts'
import {
  assessBriefFreshness,
  buildCoverage,
  classifyClaim,
  prepareBrief,
  recordBrief,
  recordCoverage,
  recordsOverview,
  recordsQuery,
} from '../src/core/records.ts'
import type { CoverageInput } from '../src/core/records.ts'
import { claimUsableFor, independenceReport, independentSourceCount } from '../src/core/provenance.ts'
import {
  DEFAULT_MAX_SEMANTIC_RUNS_PER_WINDOW,
  DEFAULT_SEMANTIC_COOLDOWN_MS,
  NATIVE_FALLBACK_MARK,
  evaluateContext,
  isNativeFallback,
  planChecks,
  selectAction,
} from '../src/core/context-quality.ts'
import { collectContextQuality, probeDshContext, readNativeBudget } from '../src/adapter/dsh-context.ts'
import type { HostSlice, ProjectionRegistryLike } from '../src/adapter/host-types.ts'
import { NOW, apply, checkpointPayload, ctx, draftMission, freshState, req, taskPayload, withClaimedTask } from './fixtures.ts'

// ─────────────────────────────── 夹具（本文件自包含） ───────────────────────────────

interface MemberRef {
  readonly actorId: string
  readonly role: ActorRole
  readonly sessionId: string
}

const MEMBER_1: MemberRef = { actorId: 'member-1', role: 'member', sessionId: 'sess-2' }
const MEMBER_2: MemberRef = { actorId: 'member-2', role: 'member', sessionId: 'sess-3' }
const MEMBER_3: MemberRef = { actorId: 'member-3', role: 'member', sessionId: 'sess-4' }

function actorCtx(member: MemberRef): CommandContext {
  return { actorId: member.actorId, role: member.role, sessionId: member.sessionId, now: NOW }
}

/** 取本次命令新增的那条记录的键：ID 由内核分配，用例只能这样拿。 */
function addedKey<T>(before: Readonly<Record<string, T>>, after: Readonly<Record<string, T>>): string {
  const key = Object.keys(after).find((candidate) => before[candidate] === undefined)
  if (key === undefined) throw new Error('夹具：本次命令没有新增记录')
  return key
}

function must<T>(label: string, value: T | undefined): T {
  if (value === undefined) throw new Error(`夹具：${label} 不存在`)
  return value
}

/** Mission 激活（team）+ Lead + 三名成员：V4-13/V4-14/V4-15/V4-16 的共用起点。 */
function teamState(): MissionControl {
  let state = freshState()
  state = apply(state, { kind: 'mission.create', requestId: req(), mission: draftMission({ collaboration: 'team' }) })
  state = apply(state, { kind: 'actor.register', requestId: req(), actorId: 'lead-1', role: 'lead', label: 'Lead', sessionId: 'sess-1' })
  state = apply(state, { kind: 'actor.register', requestId: req(), actorId: MEMBER_1.actorId, role: 'member', label: '成员一', sessionId: MEMBER_1.sessionId })
  state = apply(state, { kind: 'actor.register', requestId: req(), actorId: MEMBER_2.actorId, role: 'member', label: '成员二', sessionId: MEMBER_2.sessionId })
  state = apply(state, { kind: 'actor.register', requestId: req(), actorId: MEMBER_3.actorId, role: 'member', label: '成员三', sessionId: MEMBER_3.sessionId })
  state = apply(state, { kind: 'actor.register', requestId: req(), actorId: 'human', role: 'user', label: '用户' })
  return state
}

/** 提议 + 批准，得到 ready 任务。 */
function readyTask(state: MissionControl, title: string): { readonly state: MissionControl; readonly taskId: string } {
  const before = state.tasks
  let next = apply(state, { kind: 'task.propose', requestId: req(), task: taskPayload({ title }) }, ctx('lead', 'lead-1'))
  const taskId = addedKey(before, next.tasks)
  next = apply(next, { kind: 'task.approve', requestId: req(), taskId }, ctx('user', 'human'))
  return { state: next, taskId }
}

function claimAs(state: MissionControl, taskId: string, member: MemberRef, grantIds?: readonly string[]): { readonly state: MissionControl; readonly attemptId: string } {
  const cmd = grantIds === undefined
    ? ({ kind: 'task.claim', requestId: req(), taskId } as const)
    : ({ kind: 'task.claim', requestId: req(), taskId, grantIds } as const)
  const next = apply(state, cmd, actorCtx(member))
  const attemptId = next.tasks[taskId]?.currentAttemptId
  if (attemptId === undefined) throw new Error(`夹具：${member.actorId} 认领 ${taskId} 后没有当前尝试`)
  return { state: next, attemptId }
}

function checkpointAs(state: MissionControl, taskId: string, member: MemberRef): MissionControl {
  return apply(state, { kind: 'task.checkpoint', requestId: req(), taskId, checkpoint: checkpointPayload() }, actorCtx(member))
}

function submitAs(state: MissionControl, taskId: string, member: MemberRef): MissionControl {
  return apply(state, { kind: 'task.submit', requestId: req(), taskId, leaseVersion: 1 }, actorCtx(member))
}

/** 验收通过（criterionId 由 mintCriteria 盖成 crit_1）：任务收口为 completed。 */
function verifyPassAs(state: MissionControl, taskId: string, verifier: CommandContext, evidenceRefs: readonly string[] = []): MissionControl {
  return apply(
    state,
    { kind: 'task.verify', requestId: req(), taskId, criterionId: 'crit_1', outcome: 'pass', method: '按判据核对台账', methodVersion: 'v1', evidenceRefs },
    verifier,
  )
}

/** 登记一条证据（归属执行者），返回内核分配的 ID。 */
function recordEvidenceAs(state: MissionControl, member: MemberRef, overrides: Partial<EvidenceInput> = {}): { readonly state: MissionControl; readonly evidenceId: string } {
  const before = state.evidence
  const evidence: EvidenceInput = {
    kind: 'observation',
    summary: `${member.actorId} 的观测`,
    observedAt: NOW,
    sourceRef: `run:${member.actorId}`,
    ...overrides,
  }
  const next = apply(state, { kind: 'evidence.record', requestId: req(), evidence }, actorCtx(member))
  return { state: next, evidenceId: addedKey(before, next.evidence) }
}

/** 提议一条结论（命令侧 ClaimInput；ID、版本、作者由内核盖）。 */
function proposeClaimAs(
  state: MissionControl,
  member: MemberRef,
  overrides: Partial<ClaimInput> = {},
): { readonly state: MissionControl; readonly claimId: string } {
  const before = state.claims
  const next = apply(
    state,
    {
      kind: 'claim.propose',
      requestId: req(),
      claim: {
        proposition: '在当前实现与输入条件下该路径可用',
        appliesUnder: ['实现版本 v1', '输入条件 A'],
        sourceCategory: 'observation',
        status: 'supported',
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        reentryConditions: [],
        ...overrides,
      },
    },
    actorCtx(member),
  )
  return { state: next, claimId: addedKey(before, next.claims) }
}

/** 完整覆盖回执（§28.4 正例形态），供依据包用例复用。 */
function okCoverage(state: MissionControl, patch: Partial<CoverageInput> = {}, now: number = NOW): RecordCoverage {
  const built = buildCoverage(
    state,
    {
      sourceCuts: [{ source: 'session:sess-1', watermark: 'seq:9', durability: 'durable' }],
      completeness: 'complete_within_scope',
      ...patch,
    },
    now,
  )
  if (!built.ok) throw new Error(`夹具：覆盖回执组装被拒：${built.reason}`)
  return built.coverage
}

function withRecordedCoverage(state: MissionControl, patch: Partial<CoverageInput> = {}, now: number = NOW): { readonly state: MissionControl; readonly coverage: RecordCoverage } {
  const coverage = okCoverage(state, patch, now)
  const recorded = recordCoverage(state, coverage, now)
  if (!recorded.ok) throw new Error(`夹具：覆盖回执登记被拒：${recorded.reason}`)
  return { state: recorded.state, coverage }
}

/** 纯输入形态的证据记录（溯源模块只吃映射，不需要走命令链）。 */
function evd(id: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    evidenceId: id,
    missionId: 'mss_test',
    kind: 'observation',
    summary: `观测 ${id}`,
    observedAt: NOW,
    sourceRef: `run:${id}`,
    recordedBy: 'lead-1',
    validity: 'current',
    ...overrides,
  }
}

function headOf(state: MissionControl, claimId: string): ClaimRevision {
  return must(`结论 ${claimId}`, state.claims[claimId]?.at(-1))
}

/** 宿主投影桩：按投影名回值，可选给 tokenMeter 一个总量读数。 */
function hostWith(states: Readonly<Record<string, unknown>>, measured?: number): Pick<HostSlice, 'sessionProjections' | 'tokenMeter'> {
  const registry: ProjectionRegistryLike = { stateOf: (_session, name) => states[name] }
  return measured === undefined
    ? { sessionProjections: registry }
    : { sessionProjections: registry, tokenMeter: { measure: () => ({ totalTokens: measured }) } }
}

// ─────────────────────────────── V4-13 ───────────────────────────────

test('V4-13 Lead 轮换后其他成员仍运行：新 Lead 经逻辑记录获知运行状态与结果，不重复派发', () => {
  let state = teamState()
  const taskA = readyTask(state, '台账核对 A')
  state = taskA.state
  const taskB = readyTask(state, '台账核对 B')
  state = taskB.state

  // member-1 仍在跑 A（认领 + 检查点），member-2 的 B 已出结果并验收通过
  const claimA = claimAs(state, taskA.taskId, MEMBER_1)
  state = checkpointAs(claimA.state, taskA.taskId, MEMBER_1)
  const evidenceA = recordEvidenceAs(state, MEMBER_1, { taskId: taskA.taskId, summary: 'A 任务中间观测：差异待复核' })
  state = evidenceA.state
  const claimB = claimAs(state, taskB.taskId, MEMBER_2)
  state = checkpointAs(claimB.state, taskB.taskId, MEMBER_2)
  state = submitAs(state, taskB.taskId, MEMBER_2)
  const resultB = recordEvidenceAs(state, MEMBER_2, { taskId: taskB.taskId, summary: 'B 任务核对结果：差异 0 条，清单已归档' })
  state = resultB.state
  state = verifyPassAs(state, taskB.taskId, ctx('lead', 'lead-1'), [`evidence:${resultB.evidenceId}`])

  // Lead 轮换：连续性检查点 → REQUESTED → … → COMMITTED（提交点把 Lead 换绑到新会话）
  const checkpointsBefore = state.checkpoints
  state = apply(
    state,
    { kind: 'continuity.checkpoint', requestId: req(), checkpoint: { actorId: 'lead-1', ...checkpointPayload() } },
    actorCtx({ actorId: 'lead-1', role: 'lead', sessionId: 'sess-1' }),
  )
  const checkpointId = addedKey(checkpointsBefore, state.checkpoints)
  state = apply(
    state,
    { kind: 'continuity.requestRotation', requestId: req(), actorId: 'lead-1', sourceSessionId: 'sess-1', targetSessionId: 'sess-9', checkpointId, trigger: 'manual', seedMessageId: 'seed:sess-9' },
    ctx('supervisor'),
  )
  const rotationId = must('轮换记录', Object.values(state.rotations).at(-1)?.rotationId)
  for (const phase of ['QUIESCING', 'PREPARED', 'TARGET_READY', 'COMMITTED'] as const) {
    state = apply(state, { kind: 'continuity.advanceRotation', requestId: req(), rotationId, phase }, ctx('supervisor'))
  }
  assert.equal(state.actors['lead-1']?.sessionId, 'sess-9', '提交点把 Lead 换绑到新会话（§10.3）')
  assert.equal(state.actors['lead-1']?.bindingVersion, 2, '换绑即递增绑定版本')

  // 放行侧前半句：轮换只换 Lead，其他成员的在跑尝试不受影响
  assert.equal(state.tasks[taskA.taskId]?.status, 'running', '成员一的任务在 Lead 轮换后仍在运行（V4-13 前半句）')
  assert.equal(state.attempts[claimA.attemptId]?.status, 'running', '轮换未取消成员的在跑尝试')
  assert.equal(state.attempts[claimA.attemptId]?.actorId, 'member-1', '执行权仍归原成员')

  // 新 Lead 通过逻辑 Mission 记录获知运行状态与结果
  const overview = recordsOverview(state, { role: 'lead', actorId: 'lead-1' })
  assert.equal(overview.tasks.find((task) => task.taskId === taskA.taskId)?.status, 'running', '新 Lead 从概览读到 A 仍在运行——据此不重复派发')
  assert.equal(overview.tasks.find((task) => task.taskId === taskB.taskId)?.status, 'completed', 'B 的结果收口在同一份记录里')
  const page = recordsQuery(state, { text: '核对结果' })
  assert.ok(page.items.some((item) => item.ref === `evidence:${resultB.evidenceId}`), '新 Lead 能按记录查询取到成员的结果，不靠换会话前的记忆')

  // 拦错侧：在跑任务被重复派发/重复认领一律被拒
  const reClaim = dispatch(state, { kind: 'task.claim', requestId: req(), taskId: taskA.taskId }, actorCtx(MEMBER_3))
  assert.equal(reClaim.applied, false, 'A 已有在跑尝试：重复派发给第三名成员必须被拒')
  assert.equal(reClaim.state.revision, state.revision, '被拒的重复派发不推进修订号')
  assert.equal(reClaim.state.tasks[taskA.taskId]?.currentAttemptId, claimA.attemptId, '原尝试仍是唯一执行权持有者')
})

// ─────────────────────────────── V4-14 ───────────────────────────────

test('V4-14 查询只返回一页或少一个成员的记录：明示覆盖不足，不能宣布"全团队均未尝试"', () => {
  let seed = teamState()
  const taskA = readyTask(seed, '成员一的尝试核对')
  seed = taskA.state
  const claimA = claimAs(seed, taskA.taskId, MEMBER_1)
  seed = checkpointAs(claimA.state, taskA.taskId, MEMBER_1)
  const evA = recordEvidenceAs(seed, MEMBER_1, { taskId: taskA.taskId, summary: '成员一的尝试：已跑一轮核对，暂未见差异' })
  seed = evA.state
  const taskB = readyTask(seed, '成员二的尝试核对')
  seed = taskB.state
  const claimB = claimAs(seed, taskB.taskId, MEMBER_2)
  seed = checkpointAs(claimB.state, taskB.taskId, MEMBER_2)
  const evB = recordEvidenceAs(seed, MEMBER_2, { taskId: taskB.taskId, summary: '成员二的尝试：已跑一轮核对，暂未见差异' })
  seed = evB.state
  const taskC = readyTask(seed, '成员三的尝试核对')
  seed = taskC.state
  const claimC = claimAs(seed, taskC.taskId, MEMBER_3)
  seed = checkpointAs(claimC.state, taskC.taskId, MEMBER_3)
  const evC = recordEvidenceAs(seed, MEMBER_3, { taskId: taskC.taskId, summary: '成员三的尝试：已跑一轮核对，暂未见差异' })
  const state = evC.state

  // 拦错侧之一：只返回一页时要明示还有未取回条目
  const first = recordsQuery(state, { text: '尝试', limit: 2 })
  assert.equal(first.receipt.matched, 3, '三名成员各有一条"尝试"记录（夹具前提）')
  assert.equal(first.items.length, 2, 'limit=2 只应返回一页')
  assert.equal(first.receipt.hasMore, true, '分页未取完：回执必须标 hasMore')
  assert.ok(first.receipt.nextCursor !== undefined, '未取完必须给出可续的游标')
  assert.ok(first.receipt.note.includes('不得把当前页当作'), '拿这一页宣布"全团队均未尝试"就是拿部分当全量（§22.2 DG-02 口径）')
  const second = recordsQuery(state, { text: '尝试', limit: 2, cursor: must('下一页游标', first.receipt.nextCursor) })
  assert.equal(second.receipt.hasMore, false)
  assert.equal(first.items.length + second.items.length, 3, '分页取回全部命中项后才是完整视图')
  assert.ok(second.receipt.note.includes('已取回全部命中项'), '取回完整时回执如实收口')

  // 拦错侧之二：范围少一个成员时，回执要写明限定范围
  const scoped = recordsQuery(state, { text: '尝试', scope: { taskRefs: [taskA.taskId, taskB.taskId] } })
  assert.equal(scoped.receipt.matched, 2, '限定范围里少了成员三的记录')
  assert.ok(scoped.receipt.scopeNote.includes('限定范围'), '少一个成员的范围必须写进回执，不能当全团队结论')
  assert.ok(scoped.items.every((item) => item.taskId !== taskC.taskId), '范围外记录不得混入这一页')

  // 拦错侧之三：覆盖不足（partial）要在视图与依据包里明示
  const partial = withRecordedCoverage(state, { completeness: 'partial' })
  const overview = recordsOverview(partial.state, { role: 'lead' })
  assert.equal(overview.coverage?.completeness, 'partial', '概览要带出最近覆盖回执的完整度')
  assert.ok(overview.notes.some((line) => line.includes('只对已读范围成立')), '视图要明示"没读到"不等于"没有"（§28.4）')
  const brief = prepareBrief(partial.state, { kind: 'dispatch', targetRefs: [], preparedBy: 'lead-1' }, NOW)
  assert.ok(brief.ok)
  if (!brief.ok) return
  assert.ok(brief.brief.blockers.some((line) => line.includes('覆盖不完整')), 'partial 覆盖下不得宣布"全团队均未尝试"，阻断随包转述（§28.4）')
  assert.ok(brief.brief.blockers.some((line) => line.includes('明示不足')), '全局性断言必须明示不足（§28.4）')

  // 放行侧：补一份 complete_within_scope 的覆盖后，覆盖不足阻断消失
  const full = withRecordedCoverage(partial.state, {}, NOW + 1000)
  const clean = prepareBrief(full.state, { kind: 'dispatch', targetRefs: [], preparedBy: 'lead-1' }, NOW + 1000)
  assert.ok(clean.ok)
  if (clean.ok) {
    assert.ok(!clean.brief.blockers.some((line) => line.includes('覆盖不完整')), '如实声明完整覆盖后不再有覆盖不足阻断')
    assert.equal(clean.brief.coverageId, full.coverage.coverageId, '依据包绑定到最新的完整覆盖回执')
  }
})

// ─────────────────────────────── V4-15 ───────────────────────────────

test('V4-15 决策依据生成后用户撤销授权：准入校验拒绝旧票据，无关未受影响任务照常推进', () => {
  let state = teamState()
  // 用户授予发布授权：受影响任务的票据绑定该授权（票据就是那次决定的准入凭证）
  const grantsBefore = state.grants
  state = apply(
    state,
    {
      kind: 'authorization.grant',
      requestId: req(),
      grant: { source: 'user', sourceRef: '用户 2026-10-14 授权（发布报告目录）', actions: ['publish'], objectScope: ['reports/'], environment: 'local', delegatable: false },
    },
    ctx('user', 'human'),
  )
  const grantId = addedKey(grantsBefore, state.grants)
  const taskA = readyTask(state, '受影响：按授权发布报告')
  state = taskA.state
  const taskB = readyTask(state, '无关：只读核对台账')
  state = taskB.state
  const claimA = claimAs(state, taskA.taskId, MEMBER_1, [grantId])
  state = checkpointAs(claimA.state, taskA.taskId, MEMBER_1)
  const carriedTicket = must('A 的准入票据', state.attempts[claimA.attemptId]?.ticket)
  assert.deepEqual([...carriedTicket.grantIds], [grantId], '票据绑定该授权（§12.1、§12.2）')

  // 用户撤销授权
  state = apply(state, { kind: 'authorization.revoke', requestId: req(), grantId, reason: '用户撤销发布授权' }, ctx('user', 'human'))
  assert.ok(state.grants[grantId]?.revokedAt !== undefined, '撤销落进记录')

  // 拦错侧之一：授权面校验拒绝已撤销的旧决定
  const cover = grantCovers(must('授权', state.grants[grantId]), 'publish', 'reports/final.md', 'local', NOW)
  assert.equal(cover.ok, false, '准入授权校验：已撤销的授权不再覆盖任何动作（§22.8）')
  assert.ok(cover.reason.includes('已撤销'), '拒绝理由要能对回"已撤销"')

  // 拦错侧之二：票据绑定依据版本，撤销使旧票据失效——续租判定与提交入口都拒绝
  const check = ticketIsCurrent(state, carriedTicket, NOW)
  assert.equal(check.ok, false, '旧票据不再算续租（commands.ts:1032 的续租判定）')
  assert.ok(check.reason.includes('依据有效性已变化'), '撤销授权递增依据版本：票据读到的依据已不是签发时版本（§22.6）')
  const submit = dispatch(state, { kind: 'task.submit', requestId: req(), taskId: taskA.taskId, leaseVersion: 1 }, actorCtx(MEMBER_1))
  assert.equal(submit.applied, false, '持旧票据的提交被准入校验拒绝（§12.2）')
  assert.equal(submit.state.revision, state.revision, '被拒的提交不推进修订号')
  assert.equal(submit.state.tasks[taskA.taskId]?.status, 'running', '任务状态不被旧票据推进')

  // 放行侧：无关未受影响任务照常 claim → 检查点 → 提交 → 验收（新票据按当前依据版本签发）
  const claimB = claimAs(state, taskB.taskId, MEMBER_2)
  state = checkpointAs(claimB.state, taskB.taskId, MEMBER_2)
  state = submitAs(state, taskB.taskId, MEMBER_2)
  assert.equal(state.tasks[taskB.taskId]?.status, 'submitted', '撤销授权不连坐无关任务（§12.2）')
  state = verifyPassAs(state, taskB.taskId, ctx('lead', 'lead-1'))
  assert.equal(state.tasks[taskB.taskId]?.status, 'completed', '无关任务照常验收通过')
})

// ─────────────────────────────── V4-16 ───────────────────────────────

test('V4-16 多代理引用同一错误验证器：识别共因、修订关联结论；代理人数不当成独立证据数', () => {
  // 三名成员各登记一条证据：前两条共用同一个验证器
  let seed = teamState()
  const eA = recordEvidenceAs(seed, MEMBER_1, { rootRefs: [{ kind: 'operation', ref: 'op_a' }], commonDeps: ['validator:val_x'], summary: '成员一汇报：路径 A 经验证器 X 判通过' })
  seed = eA.state
  const eB = recordEvidenceAs(seed, MEMBER_2, { rootRefs: [{ kind: 'operation', ref: 'op_b' }], commonDeps: ['validator:val_x'], summary: '成员二汇报：路径 A 经同一个验证器 X 判通过' })
  seed = eB.state
  const eC = recordEvidenceAs(seed, MEMBER_3, { rootRefs: [{ kind: 'operation', ref: 'op_c' }], summary: '成员三独立抽样：路径 C 的读数' })
  seed = eC.state
  const cA = proposeClaimAs(seed, MEMBER_1, { proposition: '路径 A 可用', supportingEvidenceIds: [eA.evidenceId] })
  seed = cA.state
  const cB = proposeClaimAs(seed, MEMBER_2, { proposition: '路径 A 可用（第二份汇报）', supportingEvidenceIds: [eB.evidenceId] })
  seed = cB.state
  const cC = proposeClaimAs(seed, MEMBER_3, { proposition: '路径 C 读数正常', supportingEvidenceIds: [eC.evidenceId] })
  const state = cC.state
  const allEvidence = [eA.evidenceId, eB.evidenceId, eC.evidenceId]

  // 识别共因：共用验证器的两份"支持"归并为一条来源，代理人数不当成独立证据数
  const report = independenceReport(state.evidence, allEvidence)
  assert.equal(report.independentSources, 2, '三名代理只算两个独立来源：代理人数不当成独立证据数（§32.2）')
  assert.deepEqual(report.sharedDeps, [{ dep: 'validator:val_x', members: [eA.evidenceId, eB.evidenceId].sort() }], '共因以共用依赖单独列出')
  assert.ok(report.reasons.some((line) => line.includes('共因')), '归并原因要写明共因（§32.2）')
  assert.ok(report.groups.some((group) => group.members.includes(eA.evidenceId) && group.members.includes(eB.evidenceId)), 'a/b 两条记录归入同一组')
  assert.equal(independentSourceCount(state.evidence, allEvidence), 2)
  // 对照：没有显式声明的共用依赖就不猜（§32.2 v1 口径）
  const cleanMap = { evd_a: evd('evd_a', { rootRefs: [{ kind: 'operation', ref: 'op_a' }] }), evd_b: evd('evd_b', { rootRefs: [{ kind: 'operation', ref: 'op_b' }] }) }
  assert.equal(independenceReport(cleanMap, ['evd_a', 'evd_b']).independentSources, 2, '未声明的关系不猜测')

  // 先摆一份只引用无关结论 cC 的决定依据（供"不连坐"检查）
  const covered = withRecordedCoverage(state)
  const prepared = prepareBrief(covered.state, { kind: 'dispatch', targetRefs: [`claim:${cC.claimId}`], preparedBy: 'lead-1' }, NOW)
  assert.ok(prepared.ok)
  if (!prepared.ok) return
  const recorded = recordBrief(covered.state, prepared.brief, NOW)
  assert.ok(recorded.ok)
  if (!recorded.ok) return

  // 修订关联结论：共因复核后把 cA 撤回（版本 +1，历史保留）
  const revised = apply(
    recorded.state,
    { kind: 'claim.revise', requestId: req(), claimId: cA.claimId, status: 'refuted', retractionReason: '共因复核：验证器 X 出错，撤回对路径 A 的结论' },
    ctx('supervisor'),
  )
  const headA = headOf(revised, cA.claimId)
  assert.equal(headA.version, 2, '修订保留历史：版本递增')
  assert.equal(headA.status, 'refuted')
  const verdictA = classifyClaim(revised, headA)
  assert.equal(verdictA.stance, 'unresolved', '修订撤回的关联结论单独落"已撤回"：带撤回时间的反证不进普通 contradicted，不冒充有反证')
  assert.ok(verdictA.blocker?.includes('已撤回'), '关联结论不能再作依据，阻断语随分拣给出（§32.3）')
  assert.equal(claimUsableFor(headA, 'premise').ok, false, '已撤回的关联结论不能当生产前提（§32.3）')
  assert.equal(claimUsableFor(headA, 'research').ok, true, '研究失效原因仍允许（§32.3）')

  // 不连坐：无关结论 cC 不受影响，引用它的依据包仍可用
  const headC = headOf(revised, cC.claimId)
  assert.equal(classifyClaim(revised, headC).stance, 'supported', '无关结论不因别处的共因修订被连坐')
  assert.equal(claimUsableFor(headC, 'premise').ok, true, '无关结论仍可作前提')
  const freshness = assessBriefFreshness(revised, prepared.brief)
  assert.equal(freshness.verdict, 'behind_unrelated', '只引用 cC 的依据包按"无关进展"处理')
  assert.equal(freshness.usable, true, '无关进展不使提案反复失效（§28.4）')
})

// ─────────────────────────────── V4-17 ───────────────────────────────

test('V4-17 质量评价器故障或反复建议压缩：限次、冷却、unknown 状态；原生容量兜底仍可用', () => {
  // 拦错侧之一：语义检查受冷却与窗口限次约束，反复建议压缩拿不到无限次执行
  const cooling = planChecks('milestone', { budget: { now: NOW + 1000, lastSemanticAt: NOW, semanticRunsInWindow: 0 } })
  assert.deepEqual([...cooling.tiers], ['deterministic'], '冷却中语义层不跑（§27.3）')
  assert.ok(cooling.deferredReason?.includes('冷却'), '延后原因要写明冷却')
  assert.equal(cooling.nativeFallbackPriority, false)
  const capped = planChecks('before_compaction', {
    budget: { now: NOW + 10 * DEFAULT_SEMANTIC_COOLDOWN_MS, lastSemanticAt: NOW, semanticRunsInWindow: DEFAULT_MAX_SEMANTIC_RUNS_PER_WINDOW },
  })
  assert.deepEqual([...capped.tiers], ['deterministic'], '窗口内语义检查已达上限：限次生效（§27.3）')
  assert.ok(capped.deferredReason?.includes('上限'))
  const within = planChecks('milestone', { budget: { now: NOW + 10 * DEFAULT_SEMANTIC_COOLDOWN_MS, lastSemanticAt: NOW, semanticRunsInWindow: 1 } })
  assert.deepEqual([...within.tiers], ['deterministic', 'semantic'], '预算内的语义检查照常放行')

  // 拦错侧之二：评价器故障（观测面全缺席）→ 分量一律 unknown，不按健康或 0 回退
  const broken = collectContextQuality({ host: {}, session: {}, required: [] })
  assert.ok(broken.signals.capacity.unavailable !== undefined, '适配面缺席：容量分量标 unavailable，绝不回退成 0 或"健康"（§27.1）')
  assert.ok(broken.degradations.length > 0, '缺口要进退化说明')
  const evaluation = evaluateContext(broken.signals, 'deterministic')
  assert.equal(evaluation.findings.find((finding) => finding.name === 'capacity')?.verdict, 'unknown', '故障时容量判定是 unknown')
  assert.ok(evaluation.problems.unknownComponents.includes('capacity'))
  const onFailure = selectAction(evaluation.problems, { tier: 'deterministic' })
  assert.equal(onFailure.action, 'keep', '故障不推导压缩：unknown 不等于健康也不等于要压（§27.1）')
  assert.ok(onFailure.notes.some((line) => line.includes('unknown 不等于健康')), 'unknown 分量如实进备注')
  assert.equal(isNativeFallback(onFailure), false, '故障本身不产生原生兜底动作')

  // 放行侧：原生容量兜底仍可用——不受冷却与 unknown 阻挡
  const nearHardSignals = { ...broken.signals, capacity: { requestEstimateTokens: 9500, contextWindowTokens: 10000, estimateSource: 'native_meter' as const } }
  const nearHard = evaluateContext(nearHardSignals, 'deterministic')
  assert.equal(nearHard.problems.nearHardLimit, true, '接近硬上限要进结构化问题集合')
  const fallback = selectAction(nearHard.problems, { tier: 'deterministic' })
  assert.equal(fallback.action, 'compact', '原生容量兜底优先（§27.4 末段）')
  assert.ok(fallback.reason.includes(NATIVE_FALLBACK_MARK), '兜底动作要带原生标记')
  assert.equal(isNativeFallback(fallback), true)
  const planFallback = planChecks('admission', { budget: { now: NOW, lastSemanticAt: NOW, semanticRunsInWindow: 9 }, nearHardLimit: true })
  assert.equal(planFallback.nativeFallbackPriority, true, '接近硬容量时不受普通冷却与限次阻止（§27.4 末段）')
  assert.deepEqual([...planFallback.tiers], ['deterministic'], '确定性层照跑；语义层的冷却只被记录')
})

// ─────────────────────────────── V4-18 ───────────────────────────────

test('V4-18 未安装 dsh-context 或关闭浏览器：Host 原生测量与内核仍可工作；明确缺少增强信号，不依赖 UI 打开才调度', () => {
  // 拦错侧：未安装（或浏览器关闭）时结构探针判缺、增强信号如实缺席，不冒充健康
  const probe = probeDshContext({})
  assert.equal(probe.shape, 'missing', '没有投影注册表就判缺，不宣称增强能力可用')
  assert.ok(probe.evidence.includes('投影注册表未装载'))
  const noAdapter = collectContextQuality({ host: {}, session: {}, required: [] })
  assert.equal(noAdapter.reads.timeline.availability, 'missing', '三个增强投影读不到即 missing，不合并成"没有异常"（§27.1）')
  assert.ok(noAdapter.degradations.some((line) => line.includes('投影注册表未装载')), '明确缺少增强信号，缺口进退化说明')
  const noAdapterEval = evaluateContext(noAdapter.signals, 'deterministic')
  assert.equal(noAdapterEval.findings.find((finding) => finding.name === 'capacity')?.verdict, 'unknown', '没有原生读数时容量是 unknown')
  assert.ok(noAdapterEval.problems.unknownComponents.length >= 5, '增强面缺席：分量成片 unknown，而不是"健康"')

  // 放行侧之一：Host 原生测量仍可工作（不依赖 dsh-context 的界面投影）
  const measured = readNativeBudget({ tokenMeter: { measure: () => ({ totalTokens: 1234 }) } }, {})
  assert.equal(measured.requestEstimateTokens, 1234, '只有 tokenMeter 时原生测量值照常取出，不按零值回退（§27.2）')
  assert.equal(measured.source, 'native_meter')
  assert.equal(measured.status, 'unavailable', '缺上下文窗口分母：缺字段显示未知（§27.1）')
  const hostNative = hostWith({ contextPressure: { contextWindow: 10000, pressureTokens: 9500, surfaceTokens: 0, sampledSurfaceTokens: 0 } })
  const nativeBudget = readNativeBudget(hostNative, {})
  assert.equal(nativeBudget.status, 'ok', '原生压力投影在，容量读数可用')
  assert.equal(nativeBudget.requestEstimateTokens, 9500)
  const nativeSignals = collectContextQuality({ host: hostNative, session: {}, required: [] })
  const nativeDecision = selectAction(evaluateContext(nativeSignals.signals, 'deterministic').problems, { tier: 'deterministic' })
  assert.equal(nativeDecision.action, 'compact', '未安装 dsh-context 时原生容量兜底照常生效')
  assert.ok(isNativeFallback(nativeDecision))

  // 放行侧之二：内核不依赖适配器与 UI——同一"没有增强面"的环境里状态机与调度读模型照常工作
  const claimed = withClaimedTask()
  // 夹具只推进到认领：按内核路径补一条 task.checkpoint（与 test/core-commands.test.ts 同法）
  const running = apply(claimed.state, { kind: 'task.checkpoint', requestId: req(), taskId: claimed.taskId, checkpoint: checkpointPayload() }, ctx('lead', 'lead-1'))
  assert.equal(running.tasks[claimed.taskId]?.status, 'running', '内核照常写下检查点，不依赖 UI 或 dsh-context')
  const submitted = apply(running, { kind: 'task.submit', requestId: req(), taskId: claimed.taskId, leaseVersion: 1 }, ctx('lead', 'lead-1'))
  assert.equal(submitted.tasks[claimed.taskId]?.status, 'submitted', '内核照常受理提交')
  const overview = recordsOverview(submitted, { role: 'supervisor' })
  assert.ok(overview.tasks.some((task) => task.taskId === claimed.taskId && task.status === 'submitted'), '调度读模型照常工作：不依赖 UI 或 dsh-context 打开（§27.2）')
})
