/**
 * 纪律回归集（§23.1 R01–R18、§23.2 组合场景）专用夹具。
 *
 * 与 `test/fixtures.ts` 分开放置的原因：那一份由别的改动方同时维护，本回归集需要一套
 * 不随它漂移的构造器。这里只放**构造合法状态**的东西，不放任何判定——判定一律现场调用
 * `src/core/*` 与 `src/rotation/*` 的导出函数，避免测试里有第二套"什么算通过"。
 *
 * 全部命令都靠 `dispatch`/`transition` 直接驱动：不建会话、不落盘、不打桩。
 */
import assert from 'node:assert/strict'

import { dispatch } from '../src/core/commands.ts'
import type {
  ClaimInput,
  Command,
  CommandContext,
  ContextInput,
  DependencyInput,
  DispatchInput,
  EvidenceInput,
  GrantInput,
  IncidentInput,
  MissionDraft,
  ObligationInput,
  ReviewInput,
  RuleInput,
  SearchInput,
  TaskProposal,
  ValidatorInput,
} from '../src/core/commands.ts'
import type { MissionControl } from '../src/core/control.ts'
import { emptyControl } from '../src/core/control.ts'
import type { ActorRole, ArtifactVersion, EvidenceId, Mission, VerificationOutcome } from '../src/core/entities.ts'

export const NOW = 1_700_000_000_000

type CheckpointStep = Extract<Command, { readonly kind: 'task.checkpoint' }>['checkpoint']
type ContinuityCheckpoint = Extract<Command, { readonly kind: 'continuity.checkpoint' }>['checkpoint']

let counter = 0
/** 每条命令都要唯一 requestId：复用会被去重表判成重放，用例就碰不到转换本身。 */
export function req(prefix = 'req'): string {
  counter += 1
  return `${prefix}-${counter}`
}

export function ctx(role: ActorRole, actorId = 'actor-1', sessionId?: string, now: number = NOW): CommandContext {
  return sessionId === undefined ? { actorId, role, now } : { actorId, role, now, sessionId }
}

export function draftMission(overrides: Partial<Mission> = {}): Mission {
  return {
    missionId: 'mss_discipline',
    objective: '把 §22 的 18 项机制逐个跑成正反例',
    constraints: ['不得改动业务仓库'],
    constraintSources: ['用户 2026-10-14 指令'],
    criteria: [{ criterionId: 'mc_1', text: '18 项机制都有正反例', required: true }],
    objectiveRevision: 1,
    policyRevision: 1,
    budgetBasis: { kind: 'deployment', ref: '部署配置 maxTotalTokens=40000000' },
    status: 'draft',
    collaboration: 'team',
    permissionRef: 'host:default',
    allowAutoResume: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/** `mission.create` 的输入形状（ID、版本与时间戳由内核盖），与 `draftMission` 保持一致口径。 */
export function missionDraft(overrides: Partial<MissionDraft> = {}): MissionDraft {
  return {
    objective: '把 §22 的 18 项机制逐个跑成正反例',
    constraints: ['不得改动业务仓库'],
    constraintSources: ['用户 2026-10-14 指令'],
    criteria: [{ text: '18 项机制都有正反例' }],
    budgetBasis: { kind: 'deployment', ref: '部署配置 maxTotalTokens=40000000' },
    collaboration: 'team',
    permissionRef: 'host:default',
    allowAutoResume: false,
    waitingReason: undefined,
    leadActorId: undefined,
    ...overrides,
  }
}

/** `emptyControl` 默认 admissionClosed=true（冷启动先扣住），用例显式放开业务入场。 */
export function freshState(overrides: Partial<MissionControl> = {}): MissionControl {
  return { ...emptyControl('mss_discipline', draftMission(), NOW), admissionClosed: false, ...overrides }
}

/** 应用一条命令；夹具链路上的每一步都必须是合法转换，否则立刻失败并报出原因。 */
export function apply(state: MissionControl, cmd: Command, context: CommandContext = ctx('supervisor')): MissionControl {
  const result = dispatch(state, cmd, context)
  if (!result.applied) throw new Error(`夹具命令 ${cmd.kind} 被拒：${result.reason}`)
  return result.state
}

/**
 * 违例断言的内核形态：转换被拒 **且** 状态没有被改写。
 * 拒绝路径仍会写一条去重凭据，所以"状态不变"按修订号与相关集合判定，不比对对象身份。
 */
export function refused(state: MissionControl, cmd: Command, context: CommandContext, why: string): MissionControl {
  const result = dispatch(state, cmd, context)
  // 放行即失败：用抛出而不是断言，顺带让类型收窄到"已被拒"的那一支。
  if (result.applied) throw new Error(`${why}（命令 ${cmd.kind} 竟被放行）`)
  assert.match(result.reason, /transition rejected|not allowed|admission closed|already used/, `${why}：拒绝理由应来自守卫本身`)
  assert.equal(result.state.revision, state.revision, `${why}：被拒的转换不该推进修订号`)
  return state
}

/** 纯转换形态的违例断言：返回的对象修订号不变。 */
export function refusedByTransition(state: MissionControl, cmd: Command, context: CommandContext, why: string): void {
  const next = dispatch(state, cmd, context)
  assert.equal(next.applied, false, `${why}（命令 ${cmd.kind} 竟被放行）`)
}

/** 取本次命令新增的那条记录的键：ID 由内核分配，用例只能这样拿。 */
export function addedKey<T>(before: Readonly<Record<string, T>>, after: Readonly<Record<string, T>>): string {
  const key = Object.keys(after).find((candidate) => before[candidate] === undefined)
  if (key === undefined) throw new Error('夹具：命令没有新增记录')
  return key
}

// —— 各实体的输入构造器（缺省值都取"该机制默认成立"的形状，测试只覆盖自己要打的那一格）——

export function taskPayload(overrides: Partial<TaskProposal> = {}): TaskProposal {
  return {
    dependsOn: [],
    title: '核对台账口径',
    scope: 'src/core 只读核对',
    exclusions: [],
    inputRefs: [],
    criteria: [{ text: '台账与内核记录一致' }],
    priority: 5,
    resourceKeys: [],
    maxAttempts: 3,
    ...overrides,
  }
}

export function checkpointPayload(overrides: Partial<CheckpointStep> = {}): CheckpointStep {
  return {
    step: '已跑到 claim',
    nextAction: '提交本次结果',
    verifiedProgress: [],
    inProgress: [],
    decisions: [],
    blockers: [],
    inFlightOperations: [],
    openQuestions: [],
    contextRefs: [],
    ...overrides,
  }
}

export function continuityCheckpoint(actorId: string, taskId: string | undefined, overrides: Partial<ContinuityCheckpoint> = {}): ContinuityCheckpoint {
  return {
    actorId,
    taskId,
    attemptId: undefined,
    step: '准备交接',
    nextAction: '换到新会话继续',
    verifiedProgress: [],
    inProgress: [],
    decisions: [],
    blockers: [],
    inFlightOperations: [],
    openQuestions: [],
    contextRefs: [],
    ...overrides,
  }
}

export function evidenceInput(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    kind: 'observation',
    summary: '直接观测到的一次读数',
    metricId: 'accuracy',
    value: '0.81',
    unit: 'ratio',
    aggregate: 'mean',
    denominator: 'n=100',
    dataScope: 'production',
    observedAt: NOW,
    objectTime: NOW,
    environment: 'local',
    methodVersion: 'v1',
    sourceRef: 'run:1',
    ...overrides,
  }
}

export function claimInput(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    proposition: '在当前实现与输入条件下该路径可用',
    appliesUnder: ['实现版本 v1', '输入条件 A'],
    sourceCategory: 'observation',
    status: 'supported',
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    reentryConditions: [],
    ...overrides,
  }
}

export function searchInput(overrides: Partial<SearchInput> = {}): SearchInput {
  return {
    query: 'archive marker',
    mode: 'literal',
    roots: ['repo:src'],
    filters: [],
    synonyms: [],
    pagesFetched: 1,
    hasMore: false,
    truncated: false,
    errors: [],
    coverage: 'complete',
    observedAt: NOW,
    outcome: 'not_found_in_scope',
    resultRefs: [],
    ...overrides,
  }
}

export function contextInput(actorId: string, overrides: Partial<ContextInput> = {}): ContextInput {
  return {
    actorId,
    ruleVersions: { 'rul:dg01': 1 },
    claimRefs: [],
    inputRefs: ['doc:handbook@v3'],
    providedScope: '本任务相关规则与手册章节',
    completeness: 'full',
    gaps: [],
    acknowledged: true,
    ...overrides,
  }
}

export function grantInput(overrides: Partial<GrantInput> = {}): GrantInput {
  return {
    source: 'user',
    sourceRef: '用户 2026-10-14 授权（发布报告目录）',
    actions: ['publish'],
    objectScope: ['reports/a.md'],
    environment: 'local',
    delegatable: false,
    ...overrides,
  }
}

export function obligationInput(ownerActorId: string, overrides: Partial<ObligationInput> = {}): ObligationInput {
  return {
    statement: '补跑缺失的实验分支并登记回执',
    ownerActorId,
    preconditions: [],
    ...overrides,
  }
}

export function dependencyInput(targetKind: DependencyInput['targetKind'], targetId: string, onKind: DependencyInput['onKind'], onId: string, overrides: Partial<DependencyInput> = {}): DependencyInput {
  return {
    targetKind,
    targetId,
    targetRevision: undefined,
    onKind,
    onId,
    onVersion: 1,
    ...overrides,
  }
}

export function validatorInput(overrides: Partial<ValidatorInput> = {}): ValidatorInput {
  return {
    name: '台账一致性检查器',
    inputType: 'mission-control-json',
    scope: 'discipline ledger',
    assertions: ['判据版本与验证记录一致', '每条 pass 都有证据引用'],
    allowedMissing: [],
    toleranceBasis: '按 dtype 与量纲声明，不设全局固定值',
    codeRef: 'test/rules-r01-r18.test.ts#validator',
    effectiveSampleIds: ['sample:good-1'],
    counterSampleIds: ['sample:bad-missing-evidence'],
    ...overrides,
  }
}

export function reviewInput(targetId: string, overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    targetKind: 'task',
    targetId,
    targetRevision: undefined,
    selfConsistent: 'pass',
    versusHistory: 'consistent',
    sharedEvidenceIds: [],
    sawReferenceAnswer: false,
    independenceNote: '',
    methodRef: 'independent reread of raw evidence',
    ...overrides,
  }
}

export function incidentInput(overrides: Partial<IncidentInput> = {}): IncidentInput {
  return {
    failureMode: '把未施加干预的一次失败当成方向性结论',
    triggerCondition: '一次实现失败之后立刻关闭整条方向',
    rootCause: '缺少范围与重入条件字段',
    operationRefs: [],
    impact: '后续可恢复工作被无依据停掉',
    recoveryActions: [],
    candidateRuleIds: [],
    fixKind: 'state_field',
    ...overrides,
  }
}

export function ruleInput(overrides: Partial<RuleInput> = {}): RuleInput {
  return {
    statement: '一次失败不得关闭整条方向',
    origin: ['42 §12'],
    owner: 'maintainer',
    scope: 'mission',
    trigger: 'claim.revise',
    enforcement: 'programmatic',
    disposition: 'deny',
    exceptions: [],
    ...overrides,
  }
}

export function dispatchInput(taskId: string, overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    taskId,
    attemptId: undefined,
    question: '按判据核对台账并给出差异清单',
    scope: 'src/core 只读核对',
    exclusions: [],
    inputRefs: [],
    criteria: [{ text: '差异清单逐条对齐任务判据' }],
    artifactForm: '差异清单 markdown',
    grantIds: [],
    budgetNote: '在已授权额度内',
    deadlineAt: undefined,
    submitTo: 'lead-1',
    cancellationPolicy: '范围变化时回到 planned',
    ruleSnapshot: { 'rul:dg01': 1 },
    confirmedFacts: [],
    assumptions: [],
    premiseEvidenceIds: [],
    searchReceiptIds: [],
    priorResultRefs: [],
    validatorRequirements: [],
    deliveryRecipientActorId: 'lead-1',
    ...overrides,
  }
}

// —— 常用推进链 ——

export interface RigOptions {
  readonly title?: string
  readonly scope?: string
  readonly exclusions?: readonly string[]
  readonly inputRefs?: readonly string[]
  readonly resourceKeys?: readonly string[]
  readonly criteria?: TaskProposal['criteria']
  readonly dependsOn?: readonly string[]
  readonly grantIds?: readonly string[]
  readonly maxAttempts?: number
}

/** 把 options 摊到任务书上：只写用例关心的那几格，其余保持默认。 */
function taskFrom(options: RigOptions): TaskProposal {
  return taskPayload({
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(options.exclusions !== undefined ? { exclusions: options.exclusions } : {}),
    ...(options.inputRefs !== undefined ? { inputRefs: options.inputRefs } : {}),
    ...(options.resourceKeys !== undefined ? { resourceKeys: options.resourceKeys } : {}),
    ...(options.criteria !== undefined ? { criteria: options.criteria } : {}),
    ...(options.dependsOn !== undefined ? { dependsOn: options.dependsOn } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  })
}

export function activeMission(extra: Partial<MissionControl> = {}): MissionControl {
  let state = freshState(extra)
  state = apply(state, { kind: 'mission.create', requestId: req(), mission: missionDraft() })
  return state
}

/** 注册一个带会话绑定的 Actor（会话不传即"无当前绑定"，用于交付失联类用例）。 */
export function registerActor(state: MissionControl, actorId: string, role: ActorRole, sessionId?: string, teamId?: string): MissionControl {
  return apply(
    state,
    { kind: 'actor.register', requestId: req(), actorId, role, label: `${role}:${actorId}`, sessionId, teamId },
    ctx('supervisor'),
  )
}

/** Mission 激活 + Lead（lead-1 / sess-1）+ 成员 + 子代理 + 审查者：多数用例的起点。 */
export function crew(options: { readonly lead?: string; readonly sessionId?: string } = {}): {
  readonly state: MissionControl
  readonly leadId: string
} {
  const leadId = options.lead ?? 'lead-1'
  let state = activeMission()
  state = registerActor(state, leadId, 'lead', options.sessionId ?? 'sess-1')
  state = registerActor(state, 'member-1', 'member', 'sess-2')
  state = registerActor(state, 'sub-1', 'subagent', 'sess-3')
  state = registerActor(state, 'review-1', 'reviewer', 'sess-4')
  state = registerActor(state, 'human', 'user')
  return { state, leadId }
}

/** 只提议任务（不批准）：结构性互斥在 `task.approve` 处才拒绝，违例形态要从这里起手。 */
export function proposeTask(state: MissionControl, options: RigOptions = {}, context: CommandContext = ctx('lead', 'lead-1')): { readonly state: MissionControl; readonly taskId: string } {
  const before = state.tasks
  const next = apply(state, { kind: 'task.propose', requestId: req(), task: taskFrom(options) }, context)
  return { state: next, taskId: addedKey(before, next.tasks) }
}

export function approveTask(state: MissionControl, taskId: string, context: CommandContext = ctx('user', 'human')): MissionControl {
  return apply(state, { kind: 'task.approve', requestId: req(), taskId }, context)
}

/** 提议 + 批准，得到 ready 任务（可在任意已有状态上叠加，供多对象用例复用）。 */
export function readyTask(state: MissionControl, options: RigOptions = {}, context: CommandContext = ctx('lead', 'lead-1')): { readonly state: MissionControl; readonly taskId: string } {
  const proposed = proposeTask(state, options, context)
  return { state: approveTask(proposed.state, proposed.taskId), taskId: proposed.taskId }
}

export function withProposedTask(options: RigOptions = {}): { readonly state: MissionControl; readonly taskId: string } {
  return proposeTask(crew().state, options)
}

/** 提议 + 批准，得到 ready 任务。 */
export function withReadyTask(options: RigOptions = {}): { readonly state: MissionControl; readonly taskId: string } {
  return readyTask(crew().state, options)
}

/** ready → claim → 写好检查点（还没提交）：受管执行链的起点。 */
export function withClaimedTask(options: RigOptions = {}): { readonly state: MissionControl; readonly taskId: string; readonly attemptId: string } {
  const { state, taskId } = withReadyTask(options)
  const claimed = apply(state, claimTask(taskId, options.grantIds), ctx('lead', 'lead-1', 'sess-1'))
  const attemptId = claimed.tasks[taskId]?.currentAttemptId
  if (attemptId === undefined) throw new Error('夹具：认领后没有当前尝试')
  const withCheckpoint = apply(claimed, { kind: 'task.checkpoint', requestId: req(), taskId, checkpoint: checkpointPayload() }, ctx('lead', 'lead-1', 'sess-1'))
  return { state: withCheckpoint, taskId, attemptId }
}

export function claimTask(taskId: string, grantIds?: readonly string[]): Command {
  return grantIds === undefined
    ? { kind: 'task.claim', requestId: req(), taskId }
    : { kind: 'task.claim', requestId: req(), taskId, grantIds }
}

/** 执行者身份：`task.claim` 只认调用方绑定，所以用例里"谁在做"必须由 ctx 显式给出。 */
export interface ActorRef {
  readonly actorId: string
  readonly role: ActorRole
  readonly sessionId?: string
}

export function asLead(sessionId: string = 'sess-1'): ActorRef {
  return { actorId: 'lead-1', role: 'lead', sessionId }
}

export function asMember(sessionId: string = 'sess-2'): ActorRef {
  return { actorId: 'member-1', role: 'member', sessionId }
}

export function of(actorId: string, role: ActorRole, sessionId?: string): ActorRef {
  return sessionId === undefined ? { actorId, role } : { actorId, role, sessionId }
}

/** 取该执行者发命令用的上下文（会话一并带上）。 */
export function actorCtx(actor: ActorRef, now: number = NOW): CommandContext {
  return ctx(actor.role, actor.actorId, actor.sessionId, now)
}

/** 认领：返回新尝试 ID；票据与租约版本都由内核盖（leaseVersion 从 1 起）。 */
export function claimTaskAs(state: MissionControl, taskId: string, actor: ActorRef, grantIds?: readonly string[]): { readonly state: MissionControl; readonly attemptId: string } {
  const next = apply(state, claimTask(taskId, grantIds), actorCtx(actor))
  const attemptId = next.tasks[taskId]?.currentAttemptId
  if (attemptId === undefined) throw new Error(`夹具：${actor.actorId} 认领 ${taskId} 后没有当前尝试`)
  return { state: next, attemptId }
}

export function checkpointTaskAs(state: MissionControl, taskId: string, actor: ActorRef, overrides: Partial<CheckpointStep> = {}): MissionControl {
  return apply(state, { kind: 'task.checkpoint', requestId: req(), taskId, checkpoint: checkpointPayload(overrides) }, actorCtx(actor))
}

export function submitTaskAs(state: MissionControl, taskId: string, actor: ActorRef, leaseVersion: number = 1): MissionControl {
  return apply(state, { kind: 'task.submit', requestId: req(), taskId, leaseVersion }, actorCtx(actor))
}

/** 受管执行到"已提交待验收"：claim → checkpoint → submit。 */
export function submittedTask(state: MissionControl, taskId: string, actor: ActorRef): MissionControl {
  const claimed = claimTaskAs(state, taskId, actor)
  const checked = checkpointTaskAs(claimed.state, taskId, actor)
  return submitTaskAs(checked, taskId, actor)
}

/** 登记一条验收记录并取回验证 ID。 */
export function verifyTask(
  state: MissionControl,
  input: {
    readonly taskId: string
    readonly criterionId: string
    readonly outcome: VerificationOutcome
    readonly method?: string
    readonly methodVersion?: string
    readonly evidenceRefs?: readonly string[]
    readonly artifactId?: string
    readonly validatorId?: string
    readonly checksRun?: number
    readonly applicabilityReason?: string
    readonly detail?: string
  },
  actor: ActorRef = asLead(),
): { readonly state: MissionControl; readonly verificationId: string } {
  const before = state.verifications
  const next = apply(state, {
    kind: 'task.verify',
    requestId: req(),
    taskId: input.taskId,
    criterionId: input.criterionId,
    outcome: input.outcome,
    method: input.method ?? '按判据逐条核对台账',
    methodVersion: input.methodVersion ?? 'v1',
    evidenceRefs: input.evidenceRefs ?? [],
    artifactId: input.artifactId,
    validatorId: input.validatorId,
    checksRun: input.checksRun,
    applicabilityReason: input.applicabilityReason,
    detail: input.detail,
  }, actorCtx(actor))
  return { state: next, verificationId: addedKey(before, next.verifications) }
}

/**
 * 走真实链路拿到"已验收 + 当前有效"的产物：ready → claim → checkpoint → submit →
 * `artifact.registerVersion` → `task.verify` 通过（此时链头被提为 `verified`）。
 */
export function artifactThroughAcceptance(
  state: MissionControl,
  actor: ActorRef,
  options: RigOptions & { readonly uri?: string; readonly contentHash?: string } = {},
): { readonly state: MissionControl; readonly taskId: string; readonly artifactId: string } {
  const ready = readyTask(state, options, actorCtx(actor))
  const claimed = claimTaskAs(ready.state, ready.taskId, actor)
  const checked = checkpointTaskAs(claimed.state, ready.taskId, actor)
  const submitted = submitTaskAs(checked, ready.taskId, actor)
  const registered = registerArtifact(submitted, ready.taskId, options.uri ?? 'reports/final.md', options.contentHash ?? 'sha256:aaaa', actorCtx(actor))
  const done = verifyTask(registered.state, { taskId: ready.taskId, criterionId: 'crit_1', outcome: 'pass', artifactId: registered.artifactId }, actor)
  return { state: done.state, taskId: ready.taskId, artifactId: registered.artifactId }
}

/** 发布一份已验收产物（正例形态用；违例走 `refused`）。 */
export function publishArtifact(state: MissionControl, artifactId: string, version: number, grantId: string, actor: ActorRef = asLead(), targetIdentity?: string): MissionControl {
  return apply(state, {
    kind: 'artifact.requestPublish',
    requestId: req(),
    artifactId,
    version,
    grantId,
    targetIdentity,
  }, actorCtx(actor))
}

/** 受管写操作意图：动作 + 精确对象身份 + 幂等键一次性带上。 */
export function intentCommand(taskId: string, overrides: Partial<Extract<Command, { readonly kind: 'operation.intent' }>> = {}): Extract<Command, { readonly kind: 'operation.intent' }> {
  return {
    kind: 'operation.intent',
    requestId: req(),
    taskId,
    operationKind: 'file_write',
    target: 'reports/final.md',
    intent: '写入核对结论',
    idempotencyKey: req('idem'),
    retryable: false,
    reconcileMethod: '读回文件并按哈希核对',
    ...overrides,
  }
}

/** 认领 + 检查点 + 提交，任务停在 submitted。 */
export function withSubmittedTask(options: RigOptions = {}): { readonly state: MissionControl; readonly taskId: string; readonly attemptId: string } {
  const { state, taskId, attemptId } = withClaimedTask(options)
  const submitted = apply(state, { kind: 'task.submit', requestId: req(), taskId, leaseVersion: 1 }, ctx('lead', 'lead-1', 'sess-1'))
  return { state: submitted, taskId, attemptId }
}

/** 登记证据并取回内核分配的 ID。 */
export function recordEvidence(state: MissionControl, overrides: Partial<EvidenceInput> = {}, context: CommandContext = ctx('lead', 'lead-1')): { readonly state: MissionControl; readonly evidenceId: string } {
  const before = state.evidence
  const next = apply(state, { kind: 'evidence.record', requestId: req(), evidence: evidenceInput(overrides) }, context)
  return { state: next, evidenceId: addedKey(before, next.evidence) }
}

export function proposeClaim(state: MissionControl, overrides: Partial<ClaimInput> = {}, context: CommandContext = ctx('lead', 'lead-1')): { readonly state: MissionControl; readonly claimId: string } {
  const before = state.claims
  const next = apply(state, { kind: 'claim.propose', requestId: req(), claim: claimInput(overrides) }, context)
  return { state: next, claimId: addedKey(before, next.claims) }
}

export function recordSearch(state: MissionControl, overrides: Partial<SearchInput> = {}, context: CommandContext = ctx('lead', 'lead-1')): { readonly state: MissionControl; readonly receiptId: string } {
  const before = state.searches
  const next = apply(state, { kind: 'search.record', requestId: req(), search: searchInput(overrides) }, context)
  return { state: next, receiptId: addedKey(before, next.searches) }
}

export function issueGrant(state: MissionControl, overrides: Partial<GrantInput> = {}, context: CommandContext = ctx('user', 'human')): { readonly state: MissionControl; readonly grantId: string } {
  const before = state.grants
  const next = apply(state, { kind: 'authorization.grant', requestId: req(), grant: grantInput(overrides) }, context)
  return { state: next, grantId: addedKey(before, next.grants) }
}

export function proposeObligation(state: MissionControl, ownerActorId: string, overrides: Partial<ObligationInput> = {}, context: CommandContext = ctx('lead', 'lead-1')): { readonly state: MissionControl; readonly obligationId: string } {
  const before = state.obligations
  const next = apply(state, { kind: 'obligation.propose', requestId: req(), obligation: obligationInput(ownerActorId, overrides) }, context)
  return { state: next, obligationId: addedKey(before, next.obligations) }
}

export function registerArtifact(state: MissionControl, taskId: string, uri: string, contentHash: string, context: CommandContext = ctx('lead', 'lead-1', 'sess-1')): { readonly state: MissionControl; readonly artifactId: string; readonly version: number } {
  const before = state.artifacts[uri] ?? []
  const next = apply(state, { kind: 'artifact.registerVersion', requestId: req(), taskId, uri, contentHash }, context)
  const group = next.artifacts[uri] ?? []
  const record = group[group.length - 1]
  if (record === undefined) throw new Error('夹具：产物版本没有写入')
  return { state: next, artifactId: record.artifactId, version: record.version }
}

/**
 * 登记一条依赖并返回 ID。
 */
export function registerDependency(state: MissionControl, input: DependencyInput, context: CommandContext = ctx('lead', 'lead-1')): { readonly state: MissionControl; readonly dependencyId: string } {
  const before = state.dependencies
  const next = apply(state, { kind: 'dependency.register', requestId: req(), dependency: input }, context)
  return { state: next, dependencyId: addedKey(before, next.dependencies) }
}

/**
 * 注入一个**已验收**的产物版本，用于只打发布闸门本身的用例。
 *
 * 走真实链路（`artifactThroughAcceptance`）也能得到 `verified`：`task.verify` 在整份判据报告
 * 满足时把链头从 `submitted` 提为 `verified`（commands.ts:946–954）。这里保留注入形态，
 * 是因为 R06/R08 一类用例只关心"已验收产物 + 某份授权"这一格，不希望链路上的其他事实
 * （任务已 completed、票据已收敛）一起参与断言。
 */
export function withVerifiedArtifact(
  state: MissionControl,
  input: { readonly taskId: string; readonly uri: string; readonly contentHash: string; readonly actorId?: string; readonly validity?: ArtifactVersion['validity'] },
): { readonly state: MissionControl; readonly artifactId: string } {
  const group = state.artifacts[input.uri] ?? []
  const artifactId = `art_fixture_${group.length + 1}_${input.uri.replace(/[^a-z0-9]/gi, '')}`
  const record: ArtifactVersion = {
    artifactId,
    missionId: state.missionId,
    taskId: input.taskId,
    version: group.length + 1,
    uri: input.uri,
    contentHash: input.contentHash,
    hashAlgorithm: 'sha256',
    createdBy: input.actorId ?? 'lead-1',
    lastModifiedBy: input.actorId ?? 'lead-1',
    registeredBy: input.actorId ?? 'lead-1',
    attribution: 'tool_operation',
    status: 'verified',
    published: false,
    validity: input.validity ?? 'current',
    withdrawalPending: false,
    registeredAt: NOW,
  }
  const next: MissionControl = { ...state, artifacts: { ...state.artifacts, [input.uri]: [...group, record] } }
  return { state: next, artifactId }
}

/** 供证据 ID 数组使用的小工具。 */
export function evidences(...ids: readonly string[]): EvidenceId[] {
  return [...ids]
}

/** `noUncheckedIndexedAccess` 下的取记录助手：夹具链路上的记录必须存在。 */
export function must<T>(label: string, value: T | undefined): T {
  if (value === undefined) throw new Error(`夹具：${label} 不存在`)
  return value
}

/** 断言状态里某集合的条数没变（违例拒绝后"无关工作/记录不受影响"的通用检查）。 */
export function sameEntries<T>(label: string, before: Readonly<Record<string, T>>, after: Readonly<Record<string, T>>): void {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), `${label}：违例被拦下时不该新增或抹掉记录`)
}
