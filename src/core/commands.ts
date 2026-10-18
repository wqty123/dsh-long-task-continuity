/**
 * 内核命令与转换（设计稿 v0.3 §5–§14）。
 *
 * 四条硬规矩，全部在这一文件里可检查：
 * 1. 调用身份来自运行时绑定（`CommandContext.actorId`），**不**采信参数里自报的 actorId；
 * 2. 一次转换 = 聚合记录的一次更新，状态变更与待执行 outbox 同批提交；
 * 3. 转换函数只处理数据，不在里面建会话、调模型或写外部文件；
 * 4. 授权、规则、结论的版本变动只追加不改写历史，撤回靠 `basisRevision` 使旧票据失效。
 */
import { createHash } from 'node:crypto'
import type {
  AdmissionTicket,
  Actor,
  ActorId,
  ActorRole,
  ArtifactId,
  ArtifactStatus,
  ArtifactVersion,
  Attempt,
  AuthorizationGrant,
  Challenge,
  ChallengeId,
  Checkpoint,
  ClaimId,
  ClaimRevision,
  ContextReceipt,
  ContradictionFinding,
  Criterion,
  CriterionId,
  CriterionInput,
  DecisionDependency,
  DeliveryEntry,
  DeliveryId,
  DispatchId,
  DispatchPlan,
  EvidenceId,
  EvidenceRecord,
  GrantAction,
  GrantId,
  HandlingState,
  Incident,
  MailboxMessage,
  Mission,
  Obligation,
  ObligationId,
  ObligationStage,
  Operation,
  OperationId,
  OutboxEntry,
  ReviewReceipt,
  Rotation,
  RotationPhase,
  RuleSpec,
  RuleStatus,
  SearchReceipt,
  SearchReceiptId,
  SourceCategory,
  Task,
  Team,
  TeamId,
  ValidatorId,
  ValidatorSpec,
  Verification,
  VerificationOutcome,
} from './entities.ts'
import { MISSION_TERMINAL, mintCriteria } from './entities.ts'
import type { MissionControl } from './control.ts'
import type { CommandReceipt } from './control.ts'
import { commit, compactClosedRecords, controlSize, DEDUP_RETENTION_MS, DEDUP_UNKNOWN_NOTE, MAX_CONTROL_BYTES, mintId, derivedId, pruneDedupTables } from './control.ts'
import { acceptsStateWrite, dependenciesSatisfied, findCycle, isTerminalAttempt, leaseDuration, leaseVerdict } from './lease.ts'
import { canReserve, canRotate, noteRotation, releaseReservation, reserve, settle } from './budget.ts'
import {
  blockingChallenge,
  criteriaReport,
  detectContradictions,
  dischargePropagations,
  affectedSession,
  grantCovers,
  invalidateDependents,
  isStructural,
  latestClaim,
  openChallengeIds,
  openObligations,
  revisionDrifts,
  supportsAbsenceClaim,
  ticketIsCurrent,
  validatorEligible,
} from './discipline.ts'
import type { PropagationItem } from './discipline.ts'
import { missionCompletion } from './completion.ts'
// —— v0.5 §25/§26/§31 探索与猜想接口（experiment.ts）——
import {
  addAssumptionChange,
  advanceExperimentStage,
  captureConjecture,
  classifyTaskWork,
  closeConjectureInScope,
  deferConjecture,
  frameConjecture,
  preregisterExperiment,
  probeReadyConjecture,
  pursueConjecture,
  recordConjectureProbe,
  recordTrial,
  registerExplorationPolicy,
  registerStrategyDecision,
  releaseExplorationReservation,
  restoreExplorationReservation,
  reviseExperiment,
  upsertRouteAssessment,
} from './experiment.ts'
import type {
  ConjectureDraft,
  ConjectureFraming,
  DeferralReason,
  ExperimentDraft,
  ExperimentRevision,
  ExplorationRegistration,
  RouteInput,
  StageEvidence,
  StrategyDecisionDraft,
  TrialDraft,
} from './experiment.ts'
// —— v0.5 §27 上下文质量接口（context-quality.ts）——
import { applyActionOutcome, applyRunPlan, assessContext, invalidateAssessment, transitionAction } from './context-quality.ts'
import type { ActionOutcomeInput, ActionRunPlan, ActionState, AssessContextInput, AssessmentFrame } from './context-quality.ts'
// —— v0.5 §33 环境接续接口（environment.ts）——
import { advanceResume, assessResume, openResume, registerEnvironment, reviseEnvironment } from './environment.ts'
import type { AssessInput, EnvironmentInput, EnvironmentPatch, ResumeEvent, ResumeInput } from './environment.ts'
// —— v0.5 §35 治理接口（governance.ts）——
import { changeMechanismClass, proposeMechanism, recordMechanismRun, recordMisreport, reviseMechanism, transitionMechanism } from './governance.ts'
import type { ClassDecision, MechanismInput, MechanismRunInput, MechanismTransition, TransitionDetail } from './governance.ts'
// —— v0.5 §30 目标效用接口（outcome.ts）——
import { buildOutcomeReview, commitOutcomeReview, registerOutcomeContract, updateEffectObservation } from './outcome.ts'
import type { EffectObservationState, OutcomeContractInput, OutcomeReviewAnswer, OutcomeReviewInput, OutcomeReviewTrigger } from './outcome.ts'
// —— v0.5 §34 整合接口（integration.ts）——
import { assembleIntegrationReceipt, registerIntegrationPlan, reviseIntegrationPlan } from './integration.ts'
import type { IntegrationPlanInput, IntegrationReceiptInput } from './integration.ts'
// —— v0.5 §28 记录接口（records.ts）——
import { recordBrief, recordCoverage } from './records.ts'
// —— v0.5 逻辑对象类型（entities.ts，§5.1）——
import type {
  AssessmentId,
  AssumptionChange,
  DecisionBrief,
  EnvironmentId,
  ExperimentId,
  ExperimentStage,
  IntegrationId,
  MechanismClass,
  MechanismId,
  MechanismRunId,
  RecordCoverage,
  ResumeId,
  TaskId,
  TrialId,
  WorkKind,
} from './entities.ts'

export type CommandKind =
  | 'mission.create'
  | 'mission.revise'
  | 'mission.pause'
  | 'mission.resume'
  | 'mission.cancel'
  | 'mission.proposeComplete'
  | 'mission.complete'
  | 'task.propose'
  | 'task.approve'
  | 'task.claim'
  | 'task.checkpoint'
  | 'task.submit'
  | 'task.verify'
  | 'task.retry'
  | 'task.revise'
  | 'actor.register'
  | 'actor.bind'
  | 'actor.retire'
  | 'actor.dormant'
  | 'team.configure'
  | 'team.message'
  | 'team.ack'
  | 'artifact.registerVersion'
  | 'artifact.attachEvidence'
  | 'artifact.requestPublish'
  | 'operation.intent'
  | 'operation.receipt'
  | 'operation.reconcile'
  | 'delegate.start'
  | 'delegate.collect'
  | 'continuity.checkpoint'
  | 'continuity.requestRotation'
  | 'continuity.advanceRotation'
  | 'continuity.failRotation'
  | 'continuity.resolveUnknown'
  | 'outbox.complete'
  | 'outbox.retry'
  // —— v0.3 §14 Evidence & Discipline 接口组 ——
  | 'evidence.record'
  | 'claim.propose'
  | 'claim.revise'
  | 'challenge.raise'
  | 'challenge.resolve'
  | 'search.record'
  | 'context.record'
  | 'validator.qualify'
  | 'obligation.propose'
  | 'obligation.advance'
  | 'authorization.grant'
  | 'authorization.revoke'
  | 'dependency.register'
  | 'dispatch.plan'
  | 'review.record'
  | 'review.recordBatch'
  | 'incident.record'
  | 'delivery.confirm'
  | 'propagation.resolve'
  // —— v0.5 §25/§26/§31 探索与猜想接口组 ——
  | 'experiment.classifyWork'
  | 'exploration.registerPolicy'
  | 'exploration.release'
  | 'exploration.restore'
  | 'experiment.preregister'
  | 'experiment.revise'
  | 'experiment.advanceStage'
  | 'experiment.recordTrial'
  | 'route.assess'
  | 'strategy.decide'
  | 'conjecture.capture'
  | 'conjecture.frame'
  | 'conjecture.probeReady'
  | 'conjecture.recordProbe'
  | 'conjecture.pursue'
  | 'conjecture.defer'
  | 'conjecture.close'
  | 'conjecture.assumptionChange'
  // —— v0.5 §27 上下文质量接口组（插件机制自驱动，本轮只开给 supervisor） ——
  | 'context.assess'
  | 'context.invalidateAssessment'
  | 'context.transitionAction'
  | 'context.applyRunPlan'
  | 'context.applyActionOutcome'
  // —— v0.5 §33 环境接续接口组 ——
  | 'environment.register'
  | 'environment.revise'
  | 'resume.open'
  | 'resume.advance'
  | 'resume.assess'
  // —— v0.5 §35 治理接口组 ——
  | 'mechanism.propose'
  | 'mechanism.revise'
  | 'mechanism.changeClass'
  | 'mechanism.transition'
  | 'mechanism.recordRun'
  | 'mechanism.recordMisreport'
  // —— v0.5 §30 目标效用接口组 ——
  | 'outcome.register'
  | 'outcome.observe'
  | 'outcome.review'
  // —— v0.5 §34 整合接口组 ——
  | 'integration.plan'
  | 'integration.revise'
  | 'integration.receipt'
  // —— v0.5 §28 记录接口组 ——
  | 'records.recordCoverage'
  | 'records.recordBrief'

/** 只读与收拾状态的动作在准入关闭时仍可执行（§12.1）。 */
const ALWAYS_ALLOWED: ReadonlySet<CommandKind> = new Set<CommandKind>([
  'operation.reconcile',
  'continuity.resolveUnknown',
  'continuity.advanceRotation',
  'continuity.failRotation',
  'mission.pause',
  'mission.cancel',
  'outbox.complete',
  'outbox.retry',
  // 被暂停/恢复核对中的任务照样要能登记证据、检索回执、事故与质疑（§21、§22.17）。
  'evidence.record',
  'search.record',
  'incident.record',
  'challenge.raise',
  // 撤回传播的收尾不能等恢复：崩溃后就是靠这一项把积压清完（§22.6、§23.2 第 3 条）。
  'propagation.resolve',
])

/** 权限表：普通 worker 不能降低验收标准、增加预算、重写约束或给自己签发新执行权。 */
const ROLE_ALLOWED: Readonly<Record<ActorRole, ReadonlySet<CommandKind>>> = {
  supervisor: new Set<CommandKind>([
    'mission.create',
    'mission.revise',
    'mission.pause',
    'mission.resume',
    'mission.cancel',
    'mission.proposeComplete',
    'mission.complete',
    'task.propose',
    'task.approve',
    'task.verify',
    'task.revise',
    'actor.register',
    'actor.bind',
    'actor.retire',
    'actor.dormant',
    'team.configure',
    'continuity.requestRotation',
    'continuity.advanceRotation',
    'continuity.failRotation',
    'continuity.resolveUnknown',
    'operation.reconcile',
    'outbox.complete',
    'outbox.retry',
    'evidence.record',
    'claim.propose',
    'claim.revise',
    'challenge.raise',
    'challenge.resolve',
    'search.record',
    'context.record',
    'validator.qualify',
    'obligation.propose',
    'obligation.advance',
    'authorization.grant',
    'authorization.revoke',
    'dependency.register',
    'dispatch.plan',
    'review.record',
    'review.recordBatch',
    'incident.record',
    'delivery.confirm',
    'propagation.resolve',
    'artifact.requestPublish',
    'artifact.attachEvidence',
    'operation.intent',
    'operation.receipt',
    'delegate.start',
    'delegate.collect',
    'continuity.checkpoint',
    'task.claim',
    'task.checkpoint',
    'task.submit',
    'task.retry',
    'team.message',
    'team.ack',
    'artifact.registerVersion',
    // —— v0.5 §25–§35：Supervisor 是全部接口的准入方（探索、猜想、环境、治理、目标效用与整合）。 ——
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
    'context.assess',
    'context.invalidateAssessment',
    'context.transitionAction',
    'context.applyRunPlan',
    'context.applyActionOutcome',
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
  ]),
  user: new Set<CommandKind>([
    'mission.revise',
    'mission.pause',
    'mission.resume',
    'mission.cancel',
    'mission.complete',
    'task.approve',
    'task.verify',
    'task.revise',
    'continuity.requestRotation',
    'continuity.resolveUnknown',
    'team.message',
    // 授权只来自用户或可信入口，代理不能自行扩大范围（§22.8）。
    'authorization.grant',
    'authorization.revoke',
    'challenge.resolve',
    'evidence.record',
    'search.record',
    'validator.qualify',
    // 承诺作废要有用户裁定这一入口，否则"明确取消范围"无从发生（§22.7 DG-07）。
    'obligation.advance',
    // 用户可以裁定"这条传播已经处理完"；代理不行——它会给自己清空缺口（§22.6）。
    'propagation.resolve',
    // —— v0.5 §25/§26/§35/§30：用户能登记探索策略与路线判断、治理机制与目标契约并做效用复核。 ——
    'exploration.registerPolicy',
    'route.assess',
    'mechanism.propose',
    'mechanism.revise',
    'mechanism.changeClass',
    'mechanism.transition',
    'mechanism.recordMisreport',
    'outcome.register',
    'outcome.review',
  ]),
  lead: new Set<CommandKind>([
    'mission.revise',
    'mission.proposeComplete',
    'task.propose',
    'task.approve',
    'task.claim',
    'task.checkpoint',
    'task.submit',
    'task.retry',
    'task.revise',
    'task.verify',
    'actor.bind',
    'team.configure',
    'team.message',
    'team.ack',
    'artifact.registerVersion',
    'artifact.attachEvidence',
    'artifact.requestPublish',
    'operation.intent',
    'operation.receipt',
    // 执行者本人要能核对未定案的结果；reconcile 是状态校正，不新开权限（§22.13、§11）。
    'operation.reconcile',
    'delegate.start',
    'delegate.collect',
    'continuity.checkpoint',
    'continuity.requestRotation',
    'evidence.record',
    'claim.propose',
    'claim.revise',
    'challenge.raise',
    'challenge.resolve',
    'search.record',
    'context.record',
    'validator.qualify',
    'obligation.propose',
    'obligation.advance',
    'dependency.register',
    'dispatch.plan',
    'review.record',
    'review.recordBatch',
    'incident.record',
    'delivery.confirm',
    'actor.dormant',
    // —— v0.5 §25/§26/§31/§33：Lead 主导探索、猜想与环境接续，并登记目标契约与整合结果。 ——
    'experiment.classifyWork',
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
    // 机制只能"提议"与"记账"：升降级与停用留给用户/规则所有者（§35.1）。
    'mechanism.propose',
    'mechanism.recordRun',
    'outcome.register',
    'outcome.observe',
    'outcome.review',
    'integration.plan',
    'integration.revise',
    'integration.receipt',
    'records.recordCoverage',
    'records.recordBrief',
    // —— F1：质量链由插件机制自驱动，但调用者仍是 Actor 身份（不是 supervisor）。
    // 归属校验在各自转换里：只能评估/操作**自己会话**的评估对象。 ——
    'context.assess',
    'context.invalidateAssessment',
    'context.applyRunPlan',
    'context.applyActionOutcome',
  ]),
  member: new Set<CommandKind>([
    'task.claim',
    'task.checkpoint',
    'task.submit',
    'task.retry',
    'team.message',
    'team.ack',
    'artifact.registerVersion',
    'artifact.attachEvidence',
    'operation.intent',
    'operation.receipt',
    'delegate.start',
    'delegate.collect',
    'continuity.checkpoint',
    'evidence.record',
    'claim.propose',
    'claim.revise',
    'challenge.raise',
    'search.record',
    'context.record',
    'obligation.propose',
    'obligation.advance',
    'dependency.register',
    'dispatch.plan',
    'review.record',
    'review.recordBatch',
    'incident.record',
    'delivery.confirm',
    'actor.dormant',
    // —— v0.5 §25/§31/§33：成员按预登记契约记试验、走猜想生命周期、登记自己看到的环境。 ——
    'experiment.recordTrial',
    'conjecture.capture',
    'conjecture.frame',
    'conjecture.probeReady',
    'conjecture.recordProbe',
    'conjecture.pursue',
    'conjecture.defer',
    'conjecture.close',
    'environment.register',
    'environment.revise',
    // —— F1：同 lead，成员也只能操作自己会话的评估对象。 ——
    'context.assess',
    'context.invalidateAssessment',
    'context.applyRunPlan',
    'context.applyActionOutcome',
  ]),
  subagent: new Set<CommandKind>([
    'task.checkpoint',
    'task.submit',
    'artifact.registerVersion',
    'operation.intent',
    'operation.receipt',
    'continuity.checkpoint',
    'evidence.record',
    'claim.propose',
    'challenge.raise',
    'search.record',
    'context.record',
    'incident.record',
    'delivery.confirm',
    'dependency.register',
    // —— v0.5 §25/§33：子代理只做最窄的写入——记试验结果与登记执行环境。 ——
    'experiment.recordTrial',
    'environment.register',
    'environment.revise',
  ]),
  reviewer: new Set<CommandKind>([
    'task.verify',
    'team.message',
    'artifact.attachEvidence',
    'review.record',
    'review.recordBatch',
    'evidence.record',
    'claim.propose',
    'challenge.raise',
    'search.record',
    'validator.qualify',
    'incident.record',
    // —— v0.5 §28/§35：审查者核整体记录（覆盖/依据包），并事后补记机制误报（§35.4）。 ——
    'records.recordCoverage',
    'records.recordBrief',
    'mechanism.recordMisreport',
  ]),
}

export interface CommandContext {
  readonly actorId: ActorId
  readonly role: ActorRole
  readonly now: number
  /** 受管调用的运行时绑定；票据版本核对用它取当前 Attempt（§12.2）。 */
  readonly sessionId?: string
  /**
   * 租约时长（§6.2、审阅 R8）：内核把装配层的声明值随上下文注入，签发新 Attempt 时用它，
   * 缺省回退 `LEASE_EXPIRY_MS`。与心跳续租必须共用同一个值，不允许两套口径。
   */
  readonly leaseExpiryMs?: number
}

/** `task.propose` 的任务书输入：ID、版本与状态一律由内核盖（§5.1）。 */
export type TaskProposal = Omit<
  Task,
  'taskId' | 'missionId' | 'status' | 'validity' | 'criteria' | 'criteriaRevision' | 'specRevision' | 'criteriaCheck' | 'objectiveRevision' | 'currentAttemptId' | 'attemptCount' | 'createdAt' | 'updatedAt'
> & { readonly criteria: readonly CriterionInput[] }

/** `mission.create` 的目标输入，同上。 */
export type MissionDraft = Omit<Mission, 'missionId' | 'status' | 'criteria' | 'objectiveRevision' | 'policyRevision' | 'createdAt' | 'updatedAt' | 'completionProposal'> & {
  readonly criteria: readonly CriterionInput[]
}

/** 下面这些输入类型是命令侧的"去身份"版本：ID、版本、时间戳、登记者一律由内核盖。 */
export type EvidenceInput = Omit<EvidenceRecord, 'evidenceId' | 'missionId' | 'validity' | 'recordedBy'>
export type ClaimInput = Omit<ClaimRevision, 'claimId' | 'version' | 'supersedesVersion' | 'retractedAt' | 'retractionReason' | 'authorActorId' | 'validity' | 'createdAt'>
export type SearchInput = Omit<SearchReceipt, 'receiptId' | 'missionId' | 'recordedBy'>
export type ContextInput = Omit<ContextReceipt, 'receiptId' | 'missionId' | 'createdAt'>
export type ObligationInput = Omit<Obligation, 'obligationId' | 'missionId' | 'stage' | 'receiptRefs' | 'proposedBy' | 'createdAt' | 'updatedAt'> & { readonly stage?: ObligationStage }
export type GrantInput = Omit<AuthorizationGrant, 'grantId' | 'missionId' | 'usedCount' | 'consumedTokens' | 'revokedAt' | 'revokedReason' | 'createdAt'>
export type DependencyInput = Omit<DecisionDependency, 'dependencyId' | 'missionId' | 'reviewState' | 'invalidatedBy' | 'checkedAt'>
export type IncidentInput = Omit<Incident, 'incidentId' | 'missionId' | 'recordedBy' | 'createdAt'>
export type ReviewInput = Omit<ReviewReceipt, 'reviewId' | 'missionId' | 'reviewerActorId' | 'reviewedAt'>
export type RuleInput = Omit<RuleSpec, 'ruleId' | 'version' | 'status' | 'stats' | 'proposedBy' | 'activatedAt' | 'retiredAt' | 'retirementReason' | 'createdAt'> & {
  readonly status?: RuleStatus
}
/** 验证器 ID 与版本由命令层给（ID 是自然键，版本按链头递增），调用方不再自报版本。 */
export type ValidatorInput = Omit<ValidatorSpec, 'missionId' | 'validatorId' | 'version' | 'eligible' | 'qualificationReason' | 'qualifiedBy' | 'qualifiedAt' | 'createdAt'>
export type DispatchInput = Omit<
  DispatchPlan,
  'dispatchId' | 'missionId' | 'issuerActorId' | 'objectiveRevision' | 'specRevision' | 'criteriaRevision' | 'criteria' | 'contradictionFindings' | 'createdAt'
> & { readonly criteria: readonly CriterionInput[] }

/**
 * `mechanism.revise` 的补丁（v0.5 §35.1）：与 `reviseMechanism` 的 patch 形参一致——
 * 身份、提议者与分类不在补丁里：分类升降走 `mechanism.changeClass` 的专用口径。
 */
export type MechanismPatch = Partial<Omit<MechanismInput, 'mechanismId' | 'proposedBy' | 'class'>>

export type ChallengeTargetKind = 'task' | 'criteria' | 'claim' | 'artifact' | 'verification'

export type Command =
  | { readonly kind: 'mission.create'; readonly requestId: string; readonly mission: MissionDraft }
  | { readonly kind: 'mission.revise'; readonly requestId: string; readonly objective?: string; readonly constraints?: readonly string[]; readonly constraintSource?: string; readonly criteria?: readonly CriterionInput[] }
  | { readonly kind: 'mission.pause'; readonly requestId: string; readonly reason: string }
  | { readonly kind: 'mission.resume'; readonly requestId: string }
  | { readonly kind: 'mission.cancel'; readonly requestId: string; readonly reason: string }
  | { readonly kind: 'mission.proposeComplete'; readonly requestId: string; readonly note: string }
  /** Lead 提议、Supervisor/用户核结构条件后落地（§6.4）；需要人工判断的项沿用任务已有授权。 */
  | { readonly kind: 'mission.complete'; readonly requestId: string; readonly optionalTaskIds?: readonly string[] }
  | { readonly kind: 'task.propose'; readonly requestId: string; readonly task: TaskProposal }
  | { readonly kind: 'task.approve'; readonly requestId: string; readonly taskId: string }
  | { readonly kind: 'task.claim'; readonly requestId: string; readonly taskId: string; readonly grantIds?: readonly GrantId[]; readonly targetIdentity?: string }
  | { readonly kind: 'task.checkpoint'; readonly requestId: string; readonly taskId: string; readonly checkpoint: Omit<Checkpoint, 'checkpointId' | 'missionId' | 'writtenAt' | 'sourceRevision' | 'attemptId' | 'actorId' | 'taskId' | 'objectiveRevision' | 'policyRevision' | 'criteriaRevision' | 'basisRevision' | 'openChallengeIds' | 'openObligationIds'> & { readonly attemptId?: string } }
  | { readonly kind: 'task.submit'; readonly requestId: string; readonly taskId: string; readonly leaseVersion: number }
  | { readonly kind: 'task.verify'; readonly requestId: string; readonly taskId: string; readonly criterionId: CriterionId; readonly outcome: VerificationOutcome; readonly method: string; readonly methodVersion: string; readonly evidenceRefs: readonly string[]; readonly artifactId?: ArtifactId; readonly validatorId?: ValidatorId; readonly applicabilityReason?: string; readonly detail?: string; readonly checksRun?: number; readonly optionalTaskIds?: readonly string[] }
  | { readonly kind: 'task.retry'; readonly requestId: string; readonly taskId: string; readonly reason: string }
  /** 任务书/判据修订：spec 与 criteria 各自递增版本，旧验证与旧票据只证明旧版本（§22.4）。 */
  | { readonly kind: 'task.revise'; readonly requestId: string; readonly taskId: string; readonly scope?: string; readonly exclusions?: readonly string[]; readonly inputRefs?: readonly string[]; readonly criteria?: readonly CriterionInput[]; readonly reason: string }
  | { readonly kind: 'actor.register'; readonly requestId: string; readonly actorId: ActorId; readonly role: ActorRole; readonly label: string; readonly sessionId?: string; readonly teamId?: TeamId }
  | { readonly kind: 'actor.bind'; readonly requestId: string; readonly targetActorId: ActorId; readonly sessionId: string }
  | { readonly kind: 'actor.retire'; readonly requestId: string; readonly targetActorId: ActorId }
  /** 挂起等待消息时释放可运行槽位，但身份、待处理消息与历史保留（§7.3）。 */
  | { readonly kind: 'actor.dormant'; readonly requestId: string; readonly targetActorId: ActorId; readonly dormant: boolean; readonly waitingFor?: string }
  | { readonly kind: 'team.configure'; readonly requestId: string; readonly teamId: string; readonly memberActorIds: readonly ActorId[]; readonly concurrencyLimit: number }
  | { readonly kind: 'team.message'; readonly requestId: string; readonly toActorId: ActorId; readonly taskId?: string; readonly messageKind: MailboxMessage['kind']; readonly body: string; readonly causalMessageId?: string; readonly targetKind?: ChallengeTargetKind; readonly targetId?: string; readonly targetRevision?: number; readonly deadlineAt?: number; readonly deadlineSource?: string }
  | { readonly kind: 'team.ack'; readonly requestId: string; readonly messageId: string; readonly handling?: HandlingState; readonly reason?: string }
  | { readonly kind: 'artifact.registerVersion'; readonly requestId: string; readonly taskId: string; readonly uri: string; readonly contentHash: string; readonly hashAlgorithm?: string; readonly sourceOperationId?: OperationId; readonly discoveredBy?: ActorId; readonly attribution?: ArtifactVersion['attribution'] }
  | { readonly kind: 'artifact.attachEvidence'; readonly requestId: string; readonly artifactId: ArtifactId; readonly version: number; readonly evidenceRefs: readonly string[]; readonly evidenceKind?: SourceCategory; readonly summary?: string }
  /** 发布不是登记成功：需要覆盖 `publish` 动作的有效授权（§8、§22.8）。 */
  | { readonly kind: 'artifact.requestPublish'; readonly requestId: string; readonly artifactId: ArtifactId; readonly version: number; readonly grantId: GrantId; readonly targetIdentity?: string }
  | { readonly kind: 'operation.intent'; readonly requestId: string; readonly taskId: string; readonly operationKind: string; readonly target: string; readonly intent: string; readonly idempotencyKey: string; readonly retryable: boolean; readonly reconcileMethod?: string; readonly reserveTokens?: number; readonly reserveCalls?: number; readonly action?: GrantAction; readonly grantId?: GrantId; readonly targetIdentity?: string; readonly environment?: string }
  | { readonly kind: 'operation.receipt'; readonly requestId: string; readonly operationId: OperationId; readonly status: 'succeeded' | 'failed'; readonly resultRef?: string; readonly externalPhase?: Operation['externalPhase']; readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly calls: number } }
  | { readonly kind: 'operation.reconcile'; readonly requestId: string; readonly operationId: OperationId; readonly verdict: 'executed' | 'not_executed' | 'still_unknown'; readonly resultRef?: string }
  | { readonly kind: 'delegate.start'; readonly requestId: string; readonly taskId: string; readonly nativeRunId?: string; readonly childSessionId?: string; readonly dispatchId?: DispatchId }
  | { readonly kind: 'delegate.collect'; readonly requestId: string; readonly taskId: string; readonly resultRefs: readonly string[]; readonly evidenceRefs?: readonly EvidenceId[] }
  | { readonly kind: 'continuity.checkpoint'; readonly requestId: string; readonly checkpoint: Omit<Checkpoint, 'checkpointId' | 'missionId' | 'writtenAt' | 'sourceRevision' | 'objectiveRevision' | 'policyRevision' | 'criteriaRevision' | 'basisRevision' | 'openChallengeIds' | 'openObligationIds'> }
  | { readonly kind: 'continuity.requestRotation'; readonly requestId: string; readonly actorId: ActorId; readonly sourceSessionId: string; readonly targetSessionId: string; readonly checkpointId: string; readonly trigger: Rotation['trigger']; readonly seedMessageId: string }
  | { readonly kind: 'continuity.advanceRotation'; readonly requestId: string; readonly rotationId: string; readonly phase: RotationPhase; readonly bindingVersionAfter?: number }
  | { readonly kind: 'continuity.failRotation'; readonly requestId: string; readonly rotationId: string; readonly reason: string; readonly nextReconcileAction: string }
  | { readonly kind: 'continuity.resolveUnknown'; readonly requestId: string; readonly rotationId: string; readonly decision: 'activate_target' | 'keep_source' }
  | { readonly kind: 'outbox.complete'; readonly requestId: string; readonly outboxId: string; readonly error?: string }
  | { readonly kind: 'outbox.retry'; readonly requestId: string; readonly outboxId: string; readonly error: string; readonly availableAt: number }
  // —— v0.3 §14 Evidence & Discipline 接口组 ——
  | { readonly kind: 'evidence.record'; readonly requestId: string; readonly evidence: EvidenceInput }
  | { readonly kind: 'claim.propose'; readonly requestId: string; readonly claim: ClaimInput }
  | { readonly kind: 'claim.revise'; readonly requestId: string; readonly claimId: ClaimId; readonly proposition?: string; readonly appliesUnder?: readonly string[]; readonly status?: ClaimRevision['status']; readonly validity?: ClaimRevision['validity']; readonly supportingEvidenceIds?: readonly EvidenceId[]; readonly contradictingEvidenceIds?: readonly EvidenceId[]; readonly reentryConditions?: readonly string[]; readonly retractionReason?: string }
  | { readonly kind: 'challenge.raise'; readonly requestId: string; readonly targetKind: ChallengeTargetKind; readonly targetId: string; readonly targetRevision?: number; readonly quotedText: string; readonly contradictingEvidenceIds: readonly EvidenceId[]; readonly affectedActionIds: readonly string[]; readonly adjudicatorActorId: ActorId; readonly severity: Challenge['severity'] }
  | { readonly kind: 'challenge.resolve'; readonly requestId: string; readonly challengeId: ChallengeId; readonly outcome: 'upheld' | 'dismissed' | 'merged'; readonly resolution: string; readonly mergedInto?: ChallengeId }
  | { readonly kind: 'search.record'; readonly requestId: string; readonly search: SearchInput }
  | { readonly kind: 'context.record'; readonly requestId: string; readonly context: ContextInput }
  | { readonly kind: 'validator.qualify'; readonly requestId: string; readonly validatorId?: ValidatorId; readonly validator: ValidatorInput; readonly eligible: boolean; readonly reason?: string }
  | { readonly kind: 'obligation.propose'; readonly requestId: string; readonly obligation: ObligationInput }
  | { readonly kind: 'obligation.advance'; readonly requestId: string; readonly obligationId: ObligationId; readonly stage: ObligationStage; readonly receiptRefs?: readonly string[]; readonly reason?: string; readonly decisionSource?: string }
  | { readonly kind: 'authorization.grant'; readonly requestId: string; readonly grant: GrantInput }
  | { readonly kind: 'authorization.revoke'; readonly requestId: string; readonly grantId: GrantId; readonly reason: string }
  | { readonly kind: 'dependency.register'; readonly requestId: string; readonly dependency: DependencyInput }
  | { readonly kind: 'dispatch.plan'; readonly requestId: string; readonly dispatch: DispatchInput }
  | { readonly kind: 'review.record'; readonly requestId: string; readonly review: ReviewInput }
  /** 批审：一次请求登记多条审查。校验口径与逐条 `review.record` 完全一致，只是省掉往返。 */
  | { readonly kind: 'review.recordBatch'; readonly requestId: string; readonly reviews: readonly ReviewInput[] }
  | { readonly kind: 'incident.record'; readonly requestId: string; readonly incident: IncidentInput; readonly ruleCandidate?: RuleInput }
  | { readonly kind: 'delivery.confirm'; readonly requestId: string; readonly deliveryId: DeliveryId; readonly stage: DeliveryEntry['stage']; readonly handling?: HandlingState; readonly reason?: string }
  /** 传播积压的人工收尾（§22.6）：核对完成后按 id 或目标裁定，理由必填、事件留痕。 */
  | { readonly kind: 'propagation.resolve'; readonly requestId: string; readonly propagationId?: string; readonly targetKind?: string; readonly targetId?: string; readonly reason: string }
  // —— v0.5 §25/§26/§31 探索与猜想接口组 ——
  /** 任务分类只影响调度与额度，不改任务状态机（§25.2）。 */
  | { readonly kind: 'experiment.classifyWork'; readonly requestId: string; readonly taskId: TaskId; readonly workKind: WorkKind }
  | { readonly kind: 'exploration.registerPolicy'; readonly requestId: string; readonly registration: ExplorationRegistration }
  | { readonly kind: 'exploration.release'; readonly requestId: string; readonly reason: string; readonly recheck: string }
  | { readonly kind: 'exploration.restore'; readonly requestId: string; readonly reason: string }
  | { readonly kind: 'experiment.preregister'; readonly requestId: string; readonly draft: ExperimentDraft }
  | { readonly kind: 'experiment.revise'; readonly requestId: string; readonly experimentId: ExperimentId; readonly revision: ExperimentRevision }
  | { readonly kind: 'experiment.advanceStage'; readonly requestId: string; readonly experimentId: ExperimentId; readonly to: ExperimentStage; readonly evidence: StageEvidence }
  | { readonly kind: 'experiment.recordTrial'; readonly requestId: string; readonly draft: TrialDraft }
  | { readonly kind: 'route.assess'; readonly requestId: string; readonly input: RouteInput }
  | { readonly kind: 'strategy.decide'; readonly requestId: string; readonly draft: StrategyDecisionDraft }
  | { readonly kind: 'conjecture.capture'; readonly requestId: string; readonly draft: ConjectureDraft }
  | { readonly kind: 'conjecture.frame'; readonly requestId: string; readonly claimId: ClaimId; readonly framing: ConjectureFraming }
  | { readonly kind: 'conjecture.probeReady'; readonly requestId: string; readonly claimId: ClaimId; readonly nextCheapestAction: string }
  | { readonly kind: 'conjecture.recordProbe'; readonly requestId: string; readonly claimId: ClaimId; readonly trialId: TrialId }
  | { readonly kind: 'conjecture.pursue'; readonly requestId: string; readonly claimId: ClaimId; readonly reason: string }
  | { readonly kind: 'conjecture.defer'; readonly requestId: string; readonly claimId: ClaimId; readonly deferralReason: DeferralReason; readonly note: string; readonly reentryCondition?: string }
  | { readonly kind: 'conjecture.close'; readonly requestId: string; readonly claimId: ClaimId; readonly reason: string; readonly evidenceRefs?: readonly string[]; readonly reentryConditions?: readonly string[] }
  | { readonly kind: 'conjecture.assumptionChange'; readonly requestId: string; readonly claimId: ClaimId; readonly change: AssumptionChange }
  // —— v0.5 §27 上下文质量接口组（插件机制自驱动，本轮只开给 supervisor） ——
  | { readonly kind: 'context.assess'; readonly requestId: string; readonly input: AssessContextInput }
  | { readonly kind: 'context.invalidateAssessment'; readonly requestId: string; readonly assessmentId: AssessmentId; readonly current: AssessmentFrame }
  | { readonly kind: 'context.transitionAction'; readonly requestId: string; readonly assessmentId: AssessmentId; readonly next: ActionState; readonly note: string }
  | { readonly kind: 'context.applyRunPlan'; readonly requestId: string; readonly assessmentId: AssessmentId; readonly plan: ActionRunPlan }
  | { readonly kind: 'context.applyActionOutcome'; readonly requestId: string; readonly assessmentId: AssessmentId; readonly outcome: ActionOutcomeInput }
  // —— v0.5 §33 环境接续接口组 ——
  | { readonly kind: 'environment.register'; readonly requestId: string; readonly input: EnvironmentInput }
  | { readonly kind: 'environment.revise'; readonly requestId: string; readonly environmentId: EnvironmentId; readonly patch: EnvironmentPatch }
  | { readonly kind: 'resume.open'; readonly requestId: string; readonly input: ResumeInput }
  | { readonly kind: 'resume.advance'; readonly requestId: string; readonly resumeId: ResumeId; readonly event: ResumeEvent }
  | { readonly kind: 'resume.assess'; readonly requestId: string; readonly input: AssessInput }
  // —— v0.5 §35 治理接口组 ——
  | { readonly kind: 'mechanism.propose'; readonly requestId: string; readonly input: MechanismInput }
  | { readonly kind: 'mechanism.revise'; readonly requestId: string; readonly mechanismId: MechanismId; readonly patch: MechanismPatch }
  | { readonly kind: 'mechanism.changeClass'; readonly requestId: string; readonly mechanismId: MechanismId; readonly nextClass: MechanismClass; readonly decision: ClassDecision }
  | { readonly kind: 'mechanism.transition'; readonly requestId: string; readonly mechanismId: MechanismId; readonly event: MechanismTransition; readonly detail?: TransitionDetail }
  | { readonly kind: 'mechanism.recordRun'; readonly requestId: string; readonly input: MechanismRunInput }
  | { readonly kind: 'mechanism.recordMisreport'; readonly requestId: string; readonly runId: MechanismRunId; readonly verdict: 'yes' | 'no' | 'unknown'; readonly note: string }
  // —— v0.5 §30 目标效用接口组 ——
  /** 实质修订只有 user/supervisor 能发起：`source` 由调用身份派生，参数不能自报（§30.1、§30.2）。 */
  | { readonly kind: 'outcome.register'; readonly requestId: string; readonly input: OutcomeContractInput; readonly reason?: string; readonly authorizedBy?: ActorId }
  | { readonly kind: 'outcome.observe'; readonly requestId: string; readonly next: EffectObservationState; readonly note?: string; readonly evidenceRefs?: readonly EvidenceId[] }
  | { readonly kind: 'outcome.review'; readonly requestId: string; readonly triggers: readonly OutcomeReviewTrigger[]; readonly answers: readonly OutcomeReviewAnswer[]; readonly conclusion: OutcomeReviewInput['conclusion'] }
  // —— v0.5 §34 整合接口组 ——
  | { readonly kind: 'integration.plan'; readonly requestId: string; readonly input: IntegrationPlanInput }
  | { readonly kind: 'integration.revise'; readonly requestId: string; readonly integrationId: IntegrationId; readonly input: IntegrationPlanInput }
  | { readonly kind: 'integration.receipt'; readonly requestId: string; readonly input: IntegrationReceiptInput }
  // —— v0.5 §28 记录接口组 ——
  | { readonly kind: 'records.recordCoverage'; readonly requestId: string; readonly coverage: RecordCoverage }
  | { readonly kind: 'records.recordBrief'; readonly requestId: string; readonly brief: DecisionBrief }

/** `CommandKind` 与 `Command` 的 kind 必须一一对应：漏一条就是"权限表里有条目却没有转换"。 */
type _KindDrift = Exclude<Command['kind'], CommandKind> | Exclude<CommandKind, Command['kind']>
const _kindAlign: _KindDrift extends never ? true : { ERROR: 'CommandKind and Command kinds drifted' } = true

export type Outcome =
  | { readonly applied: true; readonly state: MissionControl; readonly effect: string }
  | { readonly applied: false; readonly reason: string; readonly state: MissionControl }

/**
 * 命令指纹：先按字典序重排键（同一语义的命令即使字段顺序不同也得到同一结果），
 * 再取 sha256。只截 JSON 前缀会让同族命令撞在一起——`mission.create` 与
 * `mission.pause` 的前 16 个字符完全相同，换语义复用同一 requestId 就会被判成重放。
 */
export function fingerprint(cmd: Command): string {
  return createHash('sha256').update(canonicalJson(cmd)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return value === undefined ? 'null' : JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Readonly<Record<string, unknown>>
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

export function rejected(state: MissionControl, reason: string): Outcome {
  return { applied: false, reason, state }
}

function accepted(state: MissionControl, effect: string): Outcome {
  return { applied: true, state, effect }
}

function touch(mission: Mission, now: number): Mission {
  return { ...mission, updatedAt: now }
}

function withOutbox(state: MissionControl, entries: readonly OutboxEntry[]): MissionControl {
  if (entries.length === 0) return state
  const outbox = { ...state.outbox }
  for (const entry of entries) outbox[entry.outboxId] = entry
  return { ...state, outbox }
}

/**
 * outbox 条目不派生身份：条目只由**已带派生守卫的创建/推进命令**在受控路径写入，
 * 命令重放会被守卫挡住；条目自身的投递重复由 `idempotencyKey` + 接收侧 `confirmSeed`
 * 核对兜底（审阅 N1/R2）。同键条目允许并存的情形（如传播通知按因果+会话重排队）
 * 因此保持既有语义，不被派生身份意外合并。
 */
function outboxEntry(missionId: string, kind: string, payload: Record<string, unknown>, idempotencyKey: string, now: number): OutboxEntry {
  return { outboxId: mintId('obx'), missionId, kind, payload, idempotencyKey, attempts: 0, availableAt: now }
}

/**
 * 依据撤回后给受影响的一方排队复核通知（§22.6"通过 outbox 更新视图与通知"）。
 *
 * 每个会话一条，幂等键按 因果 + 会话：同一因果重放不会再发第二份。
 * 找不到绑定会话时**不**造条目——没有执行者能投的积压会把完成判定永久钉住，
 * 而权威的工作项本来就是 `pendingPropagations`，视图、状态与交接包都会带上它。
 */
function propagationNotices(missionId: string, cause: string, queued: readonly PropagationItem[], state: MissionControl, now: number): OutboxEntry[] {
  const bySession = new Map<string, PropagationItem[]>()
  for (const item of queued) {
    const sessionId = affectedSession(state, item)
    if (sessionId === undefined) continue
    bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), item])
  }
  const entries: OutboxEntry[] = []
  for (const [sessionId, items] of bySession) {
    const body =
      `依据撤回传播（因果 ${cause}）：${items.map((item) => `${item.targetKind} ${item.targetId} → ${item.requiredAction}`).join('；')}。\n` +
      '这张票据绑定的依据已经不是当前版本，旧结论不能继续用。请按当前判据与当前依据复核后再领新步骤（§22.6）。'
    entries.push(outboxEntry(missionId, 'mailbox.deliver', { sessionId, body, cause }, `propagation:${cause}:${sessionId}`, now))
  }
  return entries
}

/**
 * 一次成功的转换：修订号 +1、写入事件、刷新提交时刻。
 *
 * `dispatch()` 用 `revision` 是否增长来区分"改了状态"与"原样退回"，所以这条递增是
 * 全内核的唯一进度凭证；漏掉它会让每个命令都被判为未提交。
 * 实现落在 `control.commit`，领域模块与命令转换共用同一条提交路径。
 */
function note(state: MissionControl, kind: string, detail: Record<string, unknown>, now: number): MissionControl {
  return commit(state, kind, detail, now)
}

/**
 * 幂等入口：先查去重记录，再执行转换。
 *
 * 完整凭据在 `DEDUP_RETENTION_MS` 内原样复用既有结论；到期后降为墓碑，命中墓碑只能回答
 * "结果未知"——把过期重放当新请求执行会重造业务对象（审阅 R5），而凭据不足时宣称既有结论
 * 也不可信。两条路径都不产生第二次业务副作用，也不清空整表。
 */
export function dispatch(state: MissionControl, cmd: Command, ctx: CommandContext): Outcome {
  const seen = state.dedup[cmd.requestId]
  if (seen !== undefined) {
    if (seen.fingerprint !== fingerprint(cmd).slice(0, 16)) {
      return rejected(state, `requestId ${cmd.requestId} already used for a different command`)
    }
    // 重放同一请求：返回既有结论，不再产生第二次业务副作用（§10.4）。
    return seen.outcome === 'applied'
      ? { applied: true, state, effect: 'dedup-hit' }
      : { applied: false, reason: seen.reason ?? 'duplicate request', state }
  }
  const tombstone = state.dedupTombstones?.[cmd.requestId]
  if (tombstone !== undefined) {
    return rejected(state, `requestId ${cmd.requestId} 的完整凭据已过 ${DEDUP_RETENTION_MS / 3_600_000}h 保留期：${DEDUP_UNKNOWN_NOTE}（不按新请求执行，§5.3）`)
  }
  const privileged = ctx.role === 'supervisor' || ctx.role === 'user'
  if (!privileged && !ALWAYS_ALLOWED.has(cmd.kind) && state.admissionClosed) {
    return rejected(state, 'admission closed: recovery reconciliation has not cleared this mission')
  }
  const allowed = ROLE_ALLOWED[ctx.role]
  if (allowed === undefined || !allowed.has(cmd.kind)) {
    return rejected(state, `role ${ctx.role} is not allowed to issue ${cmd.kind}`)
  }
  const result = compactClosedRecords(transition(state, cmd, ctx))
  const progressed = result.revision > state.revision
  if (!progressed && controlSize(result) > MAX_CONTROL_BYTES) {
    return rejected(state, `control record exceeds ${MAX_CONTROL_BYTES} bytes: run the archive sweep (core/archive.sweepArchive) before retrying`)
  }
  if (progressed && controlSize(result) > MAX_CONTROL_BYTES) {
    return rejected(state, `control record would exceed ${MAX_CONTROL_BYTES} bytes: new work is not enqueued until the archive sweep has landed a batch`)
  }
  const receipt: CommandReceipt = {
    requestId: cmd.requestId,
    fingerprint: fingerprint(cmd).slice(0, 16),
    appliedAt: ctx.now,
    outcome: progressed ? 'applied' : 'rejected',
    reason: progressed ? undefined : 'transition rejected',
    revision: result.revision,
  }
  const pruned = pruneDedupTables({ ...result.dedup, [cmd.requestId]: receipt }, result.dedupTombstones, ctx.now)
  const withReceipt: MissionControl = { ...result, dedup: pruned.dedup, dedupTombstones: pruned.tombstones }
  return progressed ? accepted(withReceipt, cmd.kind) : rejected(withReceipt, 'transition rejected')
}

/** 纯转换：只碰数据。 */
export function transition(state: MissionControl, cmd: Command, ctx: CommandContext): MissionControl {
  const now = ctx.now
  const base = { ...state, mission: touch(state.mission, now) }

  switch (cmd.kind) {
    case 'mission.create': {
      // 记录由 `kernel.open()` 以 `draft` 落盘；这里的职责只有一次身份迁移：
      // draft → active 并开放业务入场。重复提交（已 active）不产生第二个 Mission。
      if (base.mission.status !== 'draft') return base
      const draft = cmd.mission
      // 目标/规则版本与 createdAt 沿用草稿记录：create 是同一目标的激活，不是新目标（§6.1）。
      const mission: Mission = {
        ...base.mission,
        objective: draft.objective,
        constraints: draft.constraints,
        constraintSources: draft.constraintSources,
        criteria: mintCriteria(draft.criteria),
        budgetBasis: draft.budgetBasis,
        collaboration: draft.collaboration,
        permissionRef: draft.permissionRef,
        allowAutoResume: draft.allowAutoResume,
        waitingReason: draft.waitingReason,
        leadActorId: draft.leadActorId,
        status: 'active',
        updatedAt: now,
      }
      return note(
        { ...base, mission, admissionClosed: false },
        'mission/activated',
        { objectiveRevision: mission.objectiveRevision, policyRevision: mission.policyRevision, criteria: mission.criteria.length },
        now,
      )
    }

    case 'mission.revise': {
      const constraintSource = cmd.constraintSource?.trim() ?? ''
      // 约束必须连同来源一起进来：缺来源就拒绝，不留"默认用户要求"的伪造口（§22.15 DG-15）。
      if (cmd.constraints !== undefined && constraintSource.length === 0) return base
      const mission: Mission = {
        ...base.mission,
        objective: cmd.objective ?? base.mission.objective,
        constraints: cmd.constraints ?? base.mission.constraints,
        constraintSources: cmd.constraints === undefined ? base.mission.constraintSources : base.mission.constraintSources.concat(constraintSource),
        // 判据整体替换并重新盖 ID：旧验证记录只证明旧判据（§5.1）。
        criteria: cmd.criteria === undefined ? base.mission.criteria : mintCriteria(cmd.criteria),
        objectiveRevision: base.mission.objectiveRevision + 1,
      }
      // 目标修订使未完成任务回到 planned：旧交接包与旧派单对新目标失效（§6.1）。
      const affected = Object.values(base.tasks).filter((task) => !isTerminalTask(task.status))
      const attempts = mapValues(base.attempts, (attempt) =>
        affected.some((task) => task.taskId === attempt.taskId) && !isTerminalAttempt(attempt.status)
          ? { ...attempt, status: 'cancelled' as const, updatedAt: now }
          : attempt,
      )
      const tasks = mapValues(base.tasks, (task) =>
        isTerminalTask(task.status)
          ? { ...task, objectiveRevision: mission.objectiveRevision }
          : { ...task, objectiveRevision: mission.objectiveRevision, status: 'planned' as const, currentAttemptId: undefined },
      )
      return note({ ...base, mission, tasks, attempts }, 'mission/revised', { objectiveRevision: mission.objectiveRevision, invalidatedTasks: affected.length }, now)
    }

    case 'mission.pause':
      return note({ ...base, mission: { ...base.mission, status: 'paused', waitingReason: undefined } }, 'mission/paused', { reason: cmd.reason }, now)

    case 'mission.resume': {
      if (MISSION_TERMINAL.includes(base.mission.status)) return base
      return note({ ...base, mission: { ...base.mission, status: 'active', waitingReason: undefined } }, 'mission/resumed', {}, now)
    }

    case 'mission.cancel': {
      const tasks = mapValues(base.tasks, (task) => (isTerminalTask(task.status) ? task : { ...task, status: 'cancelled' as const, updatedAt: now }))
      const attempts = mapValues(base.attempts, (attempt) => (isTerminalAttempt(attempt.status) ? attempt : { ...attempt, status: 'cancelled' as const, updatedAt: now }))
      return note({ ...base, mission: { ...base.mission, status: 'cancelled', waitingReason: cmd.reason }, tasks, attempts }, 'mission/cancelled', { reason: cmd.reason }, now)
    }

    case 'mission.proposeComplete': {
      if (MISSION_TERMINAL.includes(base.mission.status)) return base
      if (cmd.note.trim().length === 0) return base
      // 提议只是把收口意图挂在 Mission 上：完成与否由 Supervisor/用户核结构条件（§6.4）。
      const mission: Mission = { ...base.mission, completionProposal: { proposedBy: ctx.actorId, at: now, note: cmd.note } }
      return note({ ...base, mission }, 'mission/completion-proposed', { proposedBy: ctx.actorId, note: cmd.note }, now)
    }

    case 'mission.complete': {
      if (MISSION_TERMINAL.includes(base.mission.status)) return base
      if (ctx.role !== 'supervisor' && ctx.role !== 'user') return base
      const report = missionCompletion(base, cmd.optionalTaskIds ?? [])
      if (!report.ready) return base
      const mission: Mission = { ...base.mission, status: 'completed', waitingReason: undefined, completionProposal: undefined, updatedAt: now }
      return note(
        { ...base, mission },
        'mission/completed',
        { optionalTaskIds: cmd.optionalTaskIds ?? [], proposal: base.mission.completionProposal?.proposedBy ?? null },
        now,
      )
    }

    case 'task.propose': {
      // 身份由 requestId 确定派生（审阅 N2）：去重凭据淘汰后同一请求重放只会落到同一个 ID，
      // 见到已存在即原地退回（无进展 = rejected），不重造任务。以下所有创建类命令同此口径。
      const taskId = derivedId('tsk', cmd.requestId)
      if (base.tasks[taskId] !== undefined) return base
      const criteria = mintCriteria(cmd.task.criteria)
      const findings = contradictionsOf({
        scope: cmd.task.scope,
        exclusions: cmd.task.exclusions,
        inputRefs: cmd.task.inputRefs,
        resourceKeys: cmd.task.resourceKeys,
        criteria,
      })
      const task: Task = {
        ...cmd.task,
        taskId,
        missionId: base.missionId,
        criteria,
        status: 'planned',
        validity: 'current',
        objectiveRevision: base.mission.objectiveRevision,
        specRevision: 1,
        criteriaRevision: 1,
        // 互斥扫描只是标记疑点：结构性互斥在 approve 处拒绝，语义疑点走 Challenge（§7.1）。
        criteriaCheck: findings.length === 0 ? 'consistent' : 'suspicious',
        currentAttemptId: undefined,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      }
      const cycle = findCycle(Object.values(base.tasks), task)
      if (cycle.length > 0) return base
      if (controlSize(base) > MAX_CONTROL_BYTES * 0.9) return base
      return note(
        { ...base, tasks: { ...base.tasks, [taskId]: task } },
        'task/proposed',
        { taskId, title: task.title, criteriaCheck: task.criteriaCheck, criteria: criteria.length, findings: findings.map((item) => item.kind) },
        now,
      )
    }

    case 'task.approve': {
      const task = base.tasks[cmd.taskId]
      if (task === undefined || task.status !== 'planned') return base
      // 可识别的硬互斥不许进 ready：错误任务书只会逼出白工（§7.1、§22.4）。
      if (contradictionsOf(task).some(isStructural)) return base
      // 指向当前任务/判据的未裁定硬冲突先挡住放行（§22.4）。
      if (blockingChallenge(base, task.taskId) !== undefined) return base
      if (!dependenciesSatisfied(task, base.tasks)) return base
      return note({ ...base, tasks: { ...base.tasks, [cmd.taskId]: { ...task, status: 'ready', updatedAt: now } } }, 'task/approved', { taskId: task.taskId, criteriaRevision: task.criteriaRevision }, now)
    }

    case 'task.claim': {
      const task = base.tasks[cmd.taskId]
      if (task === undefined) return base
      if (task.status !== 'ready' && task.status !== 'retry_wait') return base
      if (!dependenciesSatisfied(task, base.tasks)) return base
      if (task.currentAttemptId !== undefined) {
        const live = base.attempts[task.currentAttemptId]
        if (live !== undefined && !isTerminalAttempt(live.status)) return base
      }
      if (runningActors(base) >= base.budgetLimits.maxConcurrentActors) return base
      // 认领身份 = 调用方绑定，忽略任何自报 actorId。
      const actor = base.actors[ctx.actorId]
      if (actor === undefined || actor.retired || actor.sessionId === undefined) return base
      // 入场检查（§12.1、§12.2）：上一张票据仍与当前版本对得上时算续租，靠票据放行；
      // 首次入场没有票据可查，改查未裁定的硬冲突与休眠身份。
      const carried = task.currentAttemptId === undefined ? undefined : base.attempts[task.currentAttemptId]?.ticket
      const renewing = carried !== undefined && carried.actorId === actor.actorId && ticketIsCurrent(base, carried, now).ok
      if (!renewing) {
        if (actor.dormant) return base
        if (blockingChallenge(base, task.taskId) !== undefined) return base
      }
      const attemptId = derivedId('att', cmd.requestId)
      if (base.attempts[attemptId] !== undefined) return base
      const ticket: AdmissionTicket = {
        taskId: task.taskId,
        attemptId,
        actorId: actor.actorId,
        leaseVersion: 1,
        objectiveRevision: task.objectiveRevision,
        policyRevision: base.mission.policyRevision,
        criteriaRevision: task.criteriaRevision,
        basisRevision: base.basisRevision,
        grantIds: cmd.grantIds ?? [],
        targetIdentity: cmd.targetIdentity ?? task.scope,
        issuedAt: now,
      }
      const attempt: Attempt = {
        attemptId,
        taskId: task.taskId,
        missionId: base.missionId,
        actorId: actor.actorId,
        sessionId: actor.sessionId,
        leaseVersion: 1,
        leaseExpiresAt: now + leaseDuration(ctx.leaseExpiryMs),
        lastHeartbeatAt: now,
        status: 'running',
        operationIds: [],
        resultRefs: [],
        ticket,
        createdAt: now,
        updatedAt: now,
      }
      const tasks = { ...base.tasks, [task.taskId]: { ...task, status: 'leased' as const, currentAttemptId: attemptId, attemptCount: task.attemptCount + 1, updatedAt: now } }
      const opened: MissionControl = { ...base, tasks, attempts: { ...base.attempts, [attemptId]: attempt } }
      // 新票据带的是当前 basisRevision：这一步就是 R06 要的"复核后发新票据"，该任务名下的待传播项收到这里。
      const discharge = dischargePropagations(opened, (item) => item.targetKind === 'task' && item.targetId === task.taskId)
      return note(
        discharge.state,
        'attempt/opened',
        { taskId: task.taskId, attemptId, actorId: actor.actorId, leaseVersion: 1, renewing, grantIds: ticket.grantIds, targetIdentity: ticket.targetIdentity, propagatedClosed: discharge.discharged.map((item) => item.propagationId) },
        now,
      )
    }

    case 'task.checkpoint': {
      const task = base.tasks[cmd.taskId]
      if (task === undefined || task.currentAttemptId === undefined) return base
      const attempt = base.attempts[task.currentAttemptId]
      if (attempt === undefined) return base
      if (!fromBoundSession(ctx, attempt)) return base
      if (!acceptsStateWrite(attempt, attempt.leaseVersion, now)) return base
      const checkpointId = derivedId('ckp', cmd.requestId)
      if (base.checkpoints[checkpointId] !== undefined) return base
      const checkpoint: Checkpoint = {
        ...cmd.checkpoint,
        checkpointId,
        missionId: base.missionId,
        attemptId: attempt.attemptId,
        actorId: attempt.actorId,
        taskId: task.taskId,
        sourceRevision: base.revision + 1,
        // 检查点携带它成立时的版本，恢复/换会话时按这些重校验，不只恢复摘要文字（§9.1）。
        objectiveRevision: task.objectiveRevision,
        policyRevision: base.mission.policyRevision,
        criteriaRevision: task.criteriaRevision,
        basisRevision: base.basisRevision,
        // 未决项由记录推导，不采信调用方自报：否则一句"没有待办"就能把质疑与欠账写没。
        openChallengeIds: openChallengeIds(base, task.taskId),
        openObligationIds: openObligations(base, task.taskId).map((item) => item.obligationId),
        writtenAt: now,
      }
      const cap = [...base.checkpointOrder, checkpointId].slice(-64)
      return note(
        {
          ...base,
          checkpoints: { ...base.checkpoints, [checkpointId]: checkpoint },
          checkpointOrder: cap,
          attempts: { ...base.attempts, [attempt.attemptId]: { ...attempt, checkpointId, updatedAt: now } },
          tasks: { ...base.tasks, [task.taskId]: { ...task, status: 'running' as const, updatedAt: now } },
        },
        'checkpoint/written',
        { checkpointId, taskId: task.taskId },
        now,
      )
    }

    case 'continuity.checkpoint': {
      const checkpointId = derivedId('ckp', cmd.requestId)
      if (base.checkpoints[checkpointId] !== undefined) return base
      const linked = cmd.checkpoint.taskId === undefined ? undefined : base.tasks[cmd.checkpoint.taskId]
      const checkpoint: Checkpoint = {
        ...cmd.checkpoint,
        checkpointId,
        missionId: base.missionId,
        sourceRevision: base.revision + 1,
        objectiveRevision: base.mission.objectiveRevision,
        policyRevision: base.mission.policyRevision,
        // 无任务归属的连续性检查点不绑定判据版本，用 0 表示"不针对某版判据"。
        criteriaRevision: linked?.criteriaRevision ?? 0,
        basisRevision: base.basisRevision,
        openChallengeIds: openChallengeIds(base, linked?.taskId),
        openObligationIds: openObligations(base, linked?.taskId).map((item) => item.obligationId),
        writtenAt: now,
      }
      return note(
        { ...base, checkpoints: { ...base.checkpoints, [checkpointId]: checkpoint }, checkpointOrder: [...base.checkpointOrder, checkpointId].slice(-64) },
        'checkpoint/written',
        { checkpointId, scope: 'continuity', basisRevision: base.basisRevision },
        now,
      )
    }

    case 'task.submit': {
      const task = base.tasks[cmd.taskId]
      if (task === undefined || task.currentAttemptId === undefined) return base
      const attempt = base.attempts[task.currentAttemptId]
      if (attempt === undefined) return base
      if (!fromBoundSession(ctx, attempt)) return base
      const verdict = leaseVerdict(attempt, cmd.leaseVersion, now)
      // 版本不匹配 = 旧执行者的迟到结果：只落一条待审证据事件，任务与 Attempt 状态一概不动（§6.3）。
      if (verdict === 'superseded') return note(base, 'attempt/late-result', { attemptId: attempt.attemptId, verdict, taskId: task.taskId }, now)
      if (verdict !== 'valid') return base
      // 提交也是受管动作：没有票据、或票据因依据撤回/授权撤销/任务书修订而失效时不接（§12.2）。
      if (attempt.ticket === undefined) return base
      const ticketCheck = ticketIsCurrent(base, attempt.ticket, now)
      if (!ticketCheck.ok) return base
      if (blockingChallenge(base, task.taskId) !== undefined) return base
      const unregistered = Object.values(base.artifacts).flat().filter((item) => item.taskId === task.taskId && item.status === 'draft')
      if (unregistered.length > 0) return base
      const openOps = Object.values(base.operations).filter((op) => op.taskId === task.taskId && (op.status === 'intent' || op.status === 'executing' || op.status === 'outcome_unknown'))
      if (openOps.length > 0) return base
      if (task.currentAttemptId === attempt.attemptId && attempt.checkpointId === undefined) return base
      // R4/R5 的复核要求不在这里拦：它们属于交付与收口这一层，挂在 `missionCompletion` 的缺口
      // 清单上（§完成判定）。把硬拒绝放在 submit/claim 上会让每个正常流程断在半路——
      // 本插件对自己的 guard 有过判断：不误伤正常干活（见 `adapter/capabilities.ts:141`）。
      return note({ ...base, tasks: { ...base.tasks, [task.taskId]: { ...task, status: 'submitted' as const, updatedAt: now } } }, 'task/submitted', { taskId: task.taskId, attemptId: attempt.attemptId, leaseVersion: attempt.leaseVersion }, now)
    }

    case 'task.verify': {
      const task = base.tasks[cmd.taskId]
      if (task === undefined) return base
      // 已 completed 但依据被撤回（validity≠current）的任务必须还能重验，
      // 否则 R06 要的"复核"在状态机上根本没有入口（§22.6）。
      const reverify = task.status === 'completed' && task.validity !== 'current'
      if (task.status !== 'submitted' && task.status !== 'verifying' && !reverify) return base
      // 判定按 criterionId + 当前 criteriaRevision：判据不在这版任务书里就不许登记（§5.1）。
      const criterion = task.criteria.find((item) => item.criterionId === cmd.criterionId)
      if (criterion === undefined) return base
      // not_applicable 必须有适用性规则与被豁免理由，不能为绕过失败临时改成不适用（§6.4）。
      if (cmd.outcome === 'not_applicable' && (criterion.applicabilityRule === undefined || (cmd.applicabilityReason ?? '').trim().length === 0)) return base
      const artifact = latestArtifactVersion(base, cmd.artifactId)
      const verificationId = derivedId('vrf', cmd.requestId)
      if (base.verifications[verificationId] !== undefined) return base
      const verification: Verification = {
        verificationId,
        missionId: base.missionId,
        taskId: task.taskId,
        criterionId: criterion.criterionId,
        criteriaRevision: task.criteriaRevision,
        criterion: criterion.text,
        method: cmd.method,
        methodVersion: cmd.methodVersion,
        validatorId: cmd.validatorId,
        outcome: cmd.outcome,
        applicabilityReason: cmd.applicabilityReason,
        detail: cmd.detail,
        checksRun: cmd.checksRun,
        evidenceRefs: cmd.evidenceRefs,
        verifier: ctx.actorId,
        artifactId: artifact?.artifactId,
        artifactVersion: artifact?.version,
        contentHashAtVerification: artifact?.contentHash,
        verifiedAt: now,
      }
      // 验证记录属于历史，一律保留；状态是否推进取决于它是否代表"当前"版本（§6.1、§6.3）。
      const withRecord: MissionControl = { ...base, verifications: { ...base.verifications, [verificationId]: verification } }
      const attempt = task.currentAttemptId === undefined ? undefined : base.attempts[task.currentAttemptId]
      const ticket = attempt?.ticket
      if (ticket !== undefined) {
        const freshness = ticketIsCurrent(base, ticket, now)
        if (!freshness.ok) {
          return note(withRecord, 'task/verified-late', { taskId: task.taskId, verificationId, outcome: cmd.outcome, reason: freshness.reason }, now)
        }
      }
      const report = criteriaReport(withRecord, task)
      if (report.satisfied) {
        const tasks = {
          ...base.tasks,
          [task.taskId]: { ...task, status: 'completed' as const, validity: 'current' as const, blockedReason: undefined, currentAttemptId: undefined, updatedAt: now },
        }
        const attempts = attempt === undefined ? base.attempts : { ...base.attempts, [attempt.attemptId]: { ...attempt, status: 'settled' as const, updatedAt: now } }
        // 完成即闭环该任务名下欠着的承诺，回执引用用本次验证记录（§6.4、§22.7）。
        const obligations = { ...base.obligations }
        for (const obligation of openObligations(base, task.taskId)) {
          obligations[obligation.obligationId] = {
            ...obligation,
            stage: 'delivered' as const,
            receiptRefs: [...new Set([...obligation.receiptRefs, `verification:${verificationId}`])],
            updatedAt: now,
          }
        }
        // `draft → submitted → verified → published`：这一格只能由通过的验收填，否则发布永远无门（§8）。
        let artifacts = withRecord.artifacts
        const chain = cmd.artifactId === undefined ? undefined : findArtifact(withRecord, cmd.artifactId)
        const head = chain?.group.at(-1)
        if (chain !== undefined && head !== undefined && head.status === 'submitted') {
          artifacts = {
            ...withRecord.artifacts,
            [chain.uri]: chain.group.map((item) => (item.artifactId === head.artifactId ? { ...item, status: 'verified' as ArtifactStatus } : item)),
          }
        }
        const satisfiedState = { ...withRecord, tasks, attempts, obligations, artifacts }
        // 按当前判据复核通过：该任务名下待传播项就地收敛（§22.6、R06）。
        const discharge = dischargePropagations(satisfiedState, (item) => item.targetKind === 'task' && item.targetId === task.taskId)
        return note(
          discharge.state,
          'task/verified',
          { taskId: task.taskId, outcome: cmd.outcome, criteriaRevision: task.criteriaRevision, closedObligations: openObligations(base, task.taskId).length, artifactVerified: head?.artifactId ?? '', propagatedClosed: discharge.discharged.map((item) => item.propagationId) },
          now,
        )
      }
      if (cmd.outcome === 'fail') {
        const obligationId = derivedId('obl', cmd.requestId)
        const owner = attempt?.actorId ?? base.mission.leadActorId ?? ctx.actorId
        const obligation: Obligation = {
          obligationId,
          missionId: base.missionId,
          statement: `返工 ${criterion.criterionId}「${criterion.text}」：按 ${cmd.method}@${cmd.methodVersion} 判为不通过。${cmd.detail ?? ''}`.trim(),
          ownerActorId: owner,
          taskId: task.taskId,
          preconditions: [],
          stage: 'ready',
          receiptRefs: [],
          proposedBy: ctx.actorId,
          createdAt: now,
          updatedAt: now,
        }
        const tasks = {
          ...base.tasks,
          [task.taskId]: { ...task, status: 'blocked' as const, blockedReason: `验收不通过：${criterion.criterionId}（${cmd.method}）`, updatedAt: now },
        }
        // 保留原提交与验证记录，返工项变成有负责人的承诺，而不是停在报告末尾（§6.2、§22.7）。
        return note(
          { ...withRecord, tasks, obligations: { ...base.obligations, [obligationId]: obligation } },
          'task/verified',
          { taskId: task.taskId, outcome: cmd.outcome, obligationId, owner, blockers: report.blockers },
          now,
        )
      }
      const tasks = { ...base.tasks, [task.taskId]: { ...task, status: 'verifying' as const, updatedAt: now } }
      // unknown/error/not_run/未豁免的 not_applicable 都不折算成通过：停在 verifying 等补证（§6.4）。
      return note({ ...withRecord, tasks }, 'task/verified', { taskId: task.taskId, outcome: cmd.outcome, blockers: report.blockers }, now)
    }

    case 'task.retry': {
      const task = base.tasks[cmd.taskId]
      if (task === undefined) return base
      if (task.attemptCount >= task.maxAttempts) return base
      if (state.budget.taskRetries >= state.budgetLimits.maxTaskRetries) return base
      // 重试放弃本次尝试：在跑的 Attempt 先结算掉，否则 retry_wait 永远认领不了（§6.3）。
      const live = task.currentAttemptId === undefined ? undefined : base.attempts[task.currentAttemptId]
      const attempts = live === undefined || isTerminalAttempt(live.status) ? base.attempts : { ...base.attempts, [live.attemptId]: { ...live, status: 'cancelled' as const, updatedAt: now } }
      return note(
        {
          ...base,
          attempts,
          budget: { ...base.budget, taskRetries: base.budget.taskRetries + 1 },
          tasks: { ...base.tasks, [task.taskId]: { ...task, status: 'retry_wait' as const, blockedReason: cmd.reason, updatedAt: now } },
        },
        'task/retry-granted',
        { taskId: task.taskId, reason: cmd.reason, attemptCancelled: attempts !== base.attempts },
        now,
      )
    }

    case 'task.revise': {
      const task = base.tasks[cmd.taskId]
      if (task === undefined || isTerminalTask(task.status)) return base
      if (task.currentAttemptId !== undefined && task.status !== 'submitted' && task.status !== 'verifying') {
        // 正在执行的尝试不被就地改写：先到检查点结束原 Attempt，再发新版本（§7.5）。
        const live = base.attempts[task.currentAttemptId]
        if (live !== undefined && !isTerminalAttempt(live.status)) return base
      }
      const scope = cmd.scope ?? task.scope
      const exclusions = cmd.exclusions ?? task.exclusions
      const inputRefs = cmd.inputRefs ?? task.inputRefs
      const specChanged = scope !== task.scope || exclusions !== task.exclusions || inputRefs !== task.inputRefs
      const criteriaChanged = cmd.criteria !== undefined
      if (!specChanged && !criteriaChanged) return base
      const criteria = criteriaChanged ? mintCriteria(cmd.criteria ?? []) : task.criteria
      const revised: Task = {
        ...task,
        scope,
        exclusions,
        inputRefs,
        criteria,
        specRevision: specChanged ? task.specRevision + 1 : task.specRevision,
        criteriaRevision: criteriaChanged ? task.criteriaRevision + 1 : task.criteriaRevision,
        criteriaCheck: criteriaChanged ? (contradictionsOf({ ...task, scope, exclusions, inputRefs, criteria }).length === 0 ? 'consistent' : 'suspicious') : task.criteriaCheck,
        // 修订不重写业务状态，只把当前有效性打到需复核：历史完成记录保留（§6.1）。
        validity: 'needs_review',
        updatedAt: now,
      }
      const withTask: MissionControl = { ...base, tasks: { ...base.tasks, [task.taskId]: revised } }
      // 判据版本变了：旧票据与旧验证只证明旧版本，下游已登记依赖同批失效（§22.4、§22.6）。
      const propagation = invalidateDependents(withTask, 'criteria', task.taskId, `task/revised ${task.taskId}`, now)
      return withOutbox(
        note(
          propagation.state,
          'task/revised',
          {
            taskId: task.taskId,
            specRevision: revised.specRevision,
            criteriaRevision: revised.criteriaRevision,
            criteriaCheck: revised.criteriaCheck,
            reason: cmd.reason,
            invalidated: propagation.invalidatedDependencies.length,
            dependentsMarked: propagation.tasksMarked,
            queued: propagation.queuedPropagations.length,
          },
          now,
        ),
        propagationNotices(base.missionId, `task/revised ${task.taskId}`, propagation.queuedPropagations, propagation.state, now),
      )
    }

    case 'actor.register': {
      if (MISSION_TERMINAL.includes(base.mission.status)) return base
      if (cmd.actorId.length === 0 || cmd.label.length === 0) return base
      if (base.actors[cmd.actorId] !== undefined) return base
      if (base.mission.collaboration === 'solo' && cmd.role !== 'lead' && cmd.role !== 'user' && cmd.role !== 'supervisor') return base
      // 一个会话同一时刻只承载一个未退役 Actor 的绑定：工具调用 → Actor 的身份映射
      // 只有在这一条成立时才可信（§3.3）。
      if (cmd.sessionId !== undefined) {
        const clash = Object.values(base.actors).some((other) => !other.retired && other.sessionId === cmd.sessionId)
        if (clash) return base
      }
      const actor: Actor = {
        actorId: cmd.actorId,
        missionId: base.missionId,
        role: cmd.role,
        teamId: cmd.teamId,
        label: cmd.label,
        sessionId: cmd.sessionId,
        bindingVersion: cmd.sessionId === undefined ? 0 : 1,
        available: true,
        dormant: false,
        waitingFor: undefined,
        retired: false,
        rotationsLastHour: [],
        createdAt: now,
        updatedAt: now,
      }
      const mission = cmd.role === 'lead' && base.mission.leadActorId === undefined
        ? { ...base.mission, leadActorId: actor.actorId, updatedAt: now }
        : base.mission
      return note({ ...base, actors: { ...base.actors, [actor.actorId]: actor }, mission }, 'actor/registered', { actorId: actor.actorId, role: actor.role, sessionId: actor.sessionId ?? '' }, now)
    }

    case 'actor.bind': {
      const actor = base.actors[cmd.targetActorId]
      if (actor === undefined || actor.retired) return base
      const bound: Actor = { ...actor, sessionId: cmd.sessionId, bindingVersion: actor.bindingVersion + 1, updatedAt: now }
      return note({ ...base, actors: { ...base.actors, [bound.actorId]: bound } }, 'actor/bound', { actorId: bound.actorId, sessionId: cmd.sessionId, bindingVersion: bound.bindingVersion }, now)
    }

    case 'actor.retire': {
      const actor = base.actors[cmd.targetActorId]
      if (actor === undefined) return base
      const retiredActor: Actor = { ...actor, retired: true, available: false, dormant: false, waitingFor: undefined, updatedAt: now }
      // 退役成员的执行权一并收回：任务退回 ready，未结算的 Attempt 记为已取消，槽位随之释放。
      const tasks = mapValues(base.tasks, (task) => task.currentAttemptId === undefined ? task : (base.attempts[task.currentAttemptId]?.actorId === actor.actorId ? { ...task, status: 'ready' as const, currentAttemptId: undefined, updatedAt: now } : task))
      const attempts = mapValues(base.attempts, (attempt) =>
        attempt.actorId === actor.actorId && !isTerminalAttempt(attempt.status) ? { ...attempt, status: 'cancelled' as const, updatedAt: now } : attempt,
      )
      return note({ ...base, actors: { ...base.actors, [retiredActor.actorId]: retiredActor }, tasks, attempts }, 'actor/retired', { actorId: actor.actorId }, now)
    }

    case 'actor.dormant': {
      const actor = base.actors[cmd.targetActorId]
      if (actor === undefined || actor.retired) return base
      // 挂起等待消息只释放可运行槽位（`runningActors` 跳过 dormant），身份、绑定与待处理消息保留（§7.3）。
      const dormant: Actor = { ...actor, dormant: cmd.dormant, waitingFor: cmd.dormant ? cmd.waitingFor : undefined, updatedAt: now }
      return note({ ...base, actors: { ...base.actors, [dormant.actorId]: dormant } }, 'actor/dormant', { actorId: dormant.actorId, dormant: dormant.dormant, waitingFor: dormant.waitingFor ?? '' }, now)
    }

    case 'team.configure': {
      const teamId = cmd.teamId
      const lead = base.mission.leadActorId
      if (lead === undefined) return base
      const members = cmd.memberActorIds.filter((id) => base.actors[id] !== undefined)
      if (members.length === 0) return base
      const team = base.teams[teamId]
      const next: Team = {
        teamId,
        missionId: base.missionId,
        memberActorIds: team === undefined ? members : [...new Set([...team.memberActorIds, ...members])],
        leadActorId: team?.leadActorId ?? lead,
        leadershipVersion: (team?.leadershipVersion ?? 0) + 1,
        concurrencyLimit: cmd.concurrencyLimit,
        discussionTurnLimit: team?.discussionTurnLimit ?? 4,
        retiredMemberIds: team?.retiredMemberIds ?? [],
      }
      const actors = mapValues(base.actors, (actor) => (members.includes(actor.actorId) ? { ...actor, teamId } : actor))
      const mission: Mission = base.mission.collaboration === 'solo' ? { ...base.mission, collaboration: 'team' } : base.mission
      return note({ ...base, mission, teams: { ...base.teams, [teamId]: next }, actors }, 'team/configured', { teamId, members: next.memberActorIds.length, leadershipVersion: next.leadershipVersion }, now)
    }

    case 'team.message': {
      const to = base.actors[cmd.toActorId]
      if (to === undefined) return base
      // correction 必须指向被纠正的原消息，否则更正链断掉（§7.3）。
      if (cmd.messageKind === 'correction' && cmd.causalMessageId === undefined) return base
      if (base.budget.mailboxMessages >= base.budgetLimits.maxMailboxMessages) return base
      // 收件人已退役或没有当前绑定会话：消息不静默丢弃，进可见待处理队列并生成有负责人的承诺（§7.3）。
      const unroutable = to.retired || to.sessionId === undefined
      const messageId = derivedId('msg', cmd.requestId)
      if (base.mailbox[messageId] !== undefined) return base
      const targetKind = cmd.targetKind
      const targetId = cmd.targetId
      const lead = base.mission.leadActorId
      const challengeId = cmd.messageKind === 'challenge' && targetKind !== undefined && targetId !== undefined && lead !== undefined ? derivedId('chl', cmd.requestId) : undefined
      const message: MailboxMessage = {
        messageId,
        missionId: base.missionId,
        fromActorId: ctx.actorId,
        toActorId: to.actorId,
        taskId: cmd.taskId,
        kind: cmd.messageKind,
        body: cmd.body,
        causalMessageId: cmd.causalMessageId,
        objectiveRevision: base.mission.objectiveRevision,
        policyRevision: base.mission.policyRevision,
        criteriaRevision: cmd.taskId === undefined ? undefined : base.tasks[cmd.taskId]?.criteriaRevision,
        targetKind,
        targetId,
        targetRevision: cmd.targetRevision,
        challengeId,
        deadlineAt: cmd.deadlineAt,
        deadlineSource: cmd.deadlineSource,
        state: unroutable ? 'undeliverable' : 'pending',
        handling: 'unprocessed',
        attempts: 0,
      }
      let next: MissionControl = {
        ...base,
        mailbox: { ...base.mailbox, [messageId]: message },
        budget: { ...base.budget, mailboxMessages: base.budget.mailboxMessages + 1 },
      }
      if (challengeId !== undefined && targetKind !== undefined && targetId !== undefined && lead !== undefined) {
        const challenge: Challenge = {
          challengeId,
          missionId: base.missionId,
          targetKind,
          targetId,
          targetRevision: cmd.targetRevision,
          quotedText: cmd.body,
          contradictingEvidenceIds: [],
          affectedActionIds: cmd.taskId === undefined ? [] : [cmd.taskId],
          adjudicatorActorId: lead,
          raisedByActorId: ctx.actorId,
          outcome: 'open',
          // 消息通道不带反证 ID，经此登记的质疑只能先作为待审意见（§22.4）。
          severity: 'under_evidenced',
          createdAt: now,
        }
        next = { ...next, challenges: { ...next.challenges, [challengeId]: challenge } }
      }
      if (unroutable) {
        const obligationId = derivedId('obl', cmd.requestId)
        const deliveryId = derivedId('dlv', cmd.requestId)
        const delivery: DeliveryEntry = {
          deliveryId,
          missionId: base.missionId,
          messageId,
          taskId: cmd.taskId,
          attemptId: undefined,
          senderActorId: ctx.actorId,
          recipientActorId: to.actorId,
          artifactRefs: [],
          evidenceRefs: [],
          stage: 'unrouted',
          handling: 'unprocessed',
          failureReason: to.retired ? `接收者 ${to.actorId} 已退役` : `接收者 ${to.actorId} 没有当前绑定会话`,
          obligationId,
          queuedAt: now,
          updatedAt: now,
        }
        const obligation: Obligation = {
          obligationId,
          missionId: base.missionId,
          statement: `消息 ${messageId}（${message.kind}）没有可用接收者 ${to.actorId}：请 Lead 指定新的接收方或改派任务`,
          ownerActorId: lead ?? ctx.actorId,
          taskId: cmd.taskId,
          deliveryId,
          preconditions: [],
          stage: 'ready',
          receiptRefs: [],
          proposedBy: ctx.actorId,
          createdAt: now,
          updatedAt: now,
        }
        next = { ...next, deliveries: { ...next.deliveries, [deliveryId]: delivery }, obligations: { ...next.obligations, [obligationId]: obligation } }
      }
      // 投递给当前绑定的会话；未绑定则留在待处理队列 + 交付箱，不丢弃。
      const entries = unroutable ? [] : [outboxEntry(base.missionId, 'mailbox.deliver', { messageId, sessionId: to.sessionId, body: message.body }, messageId, now)]
      return withOutbox(
        note(next, 'mailbox/queued', { messageId, to: to.actorId, state: message.state, challengeId: challengeId ?? null, unroutable }, now),
        entries,
      )
    }

    case 'team.ack': {
      const message = base.mailbox[cmd.messageId]
      if (message === undefined) return base
      // 投递确认与处理确认分两步：`acknowledged` 不等于已整合，拒绝必须给理由（§7.3、§22.14）。
      const handling: HandlingState = cmd.handling ?? 'accepted'
      if (handling === 'rejected' && (cmd.reason ?? '').trim().length === 0) return base
      const acknowledged: MailboxMessage = { ...message, state: 'acknowledged', handling, handlingReason: cmd.reason, acknowledgedAt: now, handledAt: now }
      const deliveries = { ...base.deliveries }
      for (const entry of Object.values(base.deliveries)) {
        if (entry.messageId !== message.messageId) continue
        deliveries[entry.deliveryId] = { ...entry, stage: 'processed', handling, updatedAt: now }
      }
      return note({ ...base, mailbox: { ...base.mailbox, [cmd.messageId]: acknowledged }, deliveries }, 'mailbox/acked', { messageId: message.messageId, handling }, now)
    }

    case 'artifact.registerVersion': {
      const task = base.tasks[cmd.taskId]
      if (task === undefined) return base
      if (cmd.contentHash.trim().length === 0) return base
      const group = base.artifacts[cmd.uri] ?? []
      const version = group.length + 1
      const artifactId = derivedId('art', cmd.requestId)
      // 重放的同一条登记命令会在同一 uri 组里命中同一个派生 ID：退回，不再推进 superseded 版本链。
      if (group.some((item) => item.artifactId === artifactId)) return base
      const record: ArtifactVersion = {
        artifactId,
        missionId: base.missionId,
        taskId: task.taskId,
        version,
        uri: cmd.uri,
        contentHash: cmd.contentHash,
        // 身份基于版本 + 明确的哈希算法，比较时才带得上口径（§22.12 DG-12）。
        hashAlgorithm: cmd.hashAlgorithm ?? 'sha256',
        createdBy: ctx.actorId,
        lastModifiedBy: ctx.actorId,
        registeredBy: ctx.actorId,
        discoveredBy: cmd.discoveredBy,
        // 归因优先取成功工具操作；读取事件不能用作作者证明（§8）。
        attribution: cmd.attribution ?? 'tool_operation',
        sourceOperationId: cmd.sourceOperationId,
        grantId: undefined,
        status: 'submitted' as ArtifactStatus,
        published: false,
        validity: 'current',
        withdrawalPending: false,
        registeredAt: now,
      }
      // 同 uri 的旧版本被取代，不能继续代表当前产物。
      const superseded = group.map((item) => ({ ...item, status: 'superseded' as ArtifactStatus }))
      const registered: MissionControl = { ...base, artifacts: { ...base.artifacts, [cmd.uri]: [...superseded, record] } }
      // 登记新版本就是"补证重发"的落地：旧版本的复核类待传播项收到这里。
      // 已发布版本的撤回/更正**不**在这里收掉——登记只是候选，没发布就不算更正（§22.6"不静默撤回"）。
      const replacedIds = new Set(group.map((item) => item.artifactId))
      const discharge = dischargePropagations(registered, (item) =>
        item.targetKind === 'artifact' && replacedIds.has(item.targetId) && item.requiredAction === 'reverify_or_reissue')
      return note(
        discharge.state,
        'artifact/registered',
        { artifactId, uri: cmd.uri, version, hash: cmd.contentHash, hashAlgorithm: record.hashAlgorithm, attribution: record.attribution, propagatedClosed: discharge.discharged.map((item) => item.propagationId) },
        now,
      )
    }

    case 'artifact.attachEvidence': {
      const uri = Object.keys(base.artifacts).find((candidate) => base.artifacts[candidate]?.some((item) => item.artifactId === cmd.artifactId && item.version === cmd.version))
      const group = uri === undefined ? undefined : base.artifacts[uri]
      const target = group?.find((item) => item.artifactId === cmd.artifactId && item.version === cmd.version)
      if (target === undefined || group === undefined || cmd.evidenceRefs.length === 0) return base
      // 附证据只是登记"这条来源与这个产物版本有关"：不改产物状态，也不伪造通过验证（§22.7、§22.18）。
      const evidence = { ...base.evidence }
      const anchorEvidenceId = derivedId('evd', cmd.requestId, 'ref:0')
      if (evidence[anchorEvidenceId] !== undefined) return base
      for (const [index, ref] of cmd.evidenceRefs.entries()) {
        const evidenceId = derivedId('evd', cmd.requestId, `ref:${index}`)
        evidence[evidenceId] = {
          evidenceId,
          missionId: base.missionId,
          kind: cmd.evidenceKind ?? 'reported',
          summary: cmd.summary ?? `产物 ${target.uri} v${target.version} 引用的证据线索`,
          observedAt: now,
          sourceRef: ref,
          taskId: target.taskId,
          artifactId: target.artifactId,
          validity: 'current',
          recordedBy: ctx.actorId,
        }
      }
      return note({ ...base, evidence }, 'evidence/attached', { artifactId: target.artifactId, version: target.version, refs: cmd.evidenceRefs.length, kind: cmd.evidenceKind ?? 'reported' }, now)
    }

    case 'artifact.requestPublish': {
      const found = findArtifact(base, cmd.artifactId, cmd.version)
      if (found === undefined) return base
      const artifact = found.record
      // 登记成功 ≠ 正式成果：只有已验收且当前有效的版本才谈得上发布（§8）。
      if (artifact.status !== 'verified' || artifact.validity !== 'current') return base
      const grant = base.grants[cmd.grantId]
      if (grant === undefined) return base
      const scope = cmd.targetIdentity ?? artifact.uri
      if (!grantCovers(grant, 'publish', scope, 'local', now).ok) return base
      const updated = found.group.map((item) => {
        if (item.artifactId === artifact.artifactId && item.version === artifact.version) return { ...item, published: true, status: 'published' as ArtifactStatus }
        // 更正版发布出去了，同一 uri 上挂着的撤回待办才算办完；旧版本内容不动、不删（§22.6）。
        if (item.withdrawalPending) return { ...item, withdrawalPending: false }
        return item
      })
      const used: AuthorizationGrant = { ...grant, usedCount: grant.usedCount + 1 }
      const publishedState: MissionControl = { ...base, artifacts: { ...base.artifacts, [found.uri]: updated }, grants: { ...base.grants, [grant.grantId]: used } }
      const publishedIds = new Set(found.group.map((item) => item.artifactId))
      const discharge = dischargePropagations(publishedState, (item) => item.targetKind === 'artifact' && publishedIds.has(item.targetId))
      return note(
        discharge.state,
        'artifact/published',
        { artifactId: artifact.artifactId, version: artifact.version, grantId: grant.grantId, targetIdentity: scope, propagatedClosed: discharge.discharged.map((item) => item.propagationId) },
        now,
      )
    }

    case 'operation.intent': {
      const task = base.tasks[cmd.taskId]
      if (task === undefined) return base
      if (Object.values(base.operations).some((op) => op.idempotencyKey === cmd.idempotencyKey)) return base
      // 结果未明的写操作还挂在这条任务上时，换个幂等键也不能再写一次（§22.13 DG-13）。
      if (cmd.action === 'write' && Object.values(base.operations).some((op) => op.taskId === task.taskId && op.action === 'write' && op.status === 'outcome_unknown')) return base
      if (task.currentAttemptId !== undefined) {
        const attempt = base.attempts[task.currentAttemptId]
        if (attempt !== undefined && !fromBoundSession(ctx, attempt)) return base
      }
      // 声明了动作类别就必须落在一份覆盖"动作 + 对象 + 环境"的有效授权上（§22.8、§22.13）。
      let grant: AuthorizationGrant | undefined
      if (cmd.action !== undefined) {
        const scope = cmd.targetIdentity ?? cmd.target
        if (scope.length === 0) return base
        grant = cmd.grantId === undefined ? undefined : base.grants[cmd.grantId]
        if (grant === undefined) return base
        if (!grantCovers(grant, cmd.action, scope, cmd.environment ?? 'local', now).ok) return base
      }
      const operationId = derivedId('op', cmd.requestId)
      if (base.operations[operationId] !== undefined) return base
      const operation = mkOperation(base.missionId, operationId, task.taskId, {
        kind: cmd.operationKind,
        target: cmd.target,
        intent: cmd.intent,
        idempotencyKey: cmd.idempotencyKey,
        retryable: cmd.retryable,
        reconcileMethod: cmd.reconcileMethod,
        grantId: cmd.grantId,
        targetIdentity: cmd.targetIdentity,
        action: cmd.action,
      }, now)
      if (cmd.reserveTokens === undefined && cmd.reserveCalls === undefined) {
        return note({ ...base, operations: { ...base.operations, [operationId]: operation } }, 'operation/intent', { operationId, kind: cmd.operationKind, grantId: grant?.grantId ?? '' }, now)
      }
      const want = { tokens: cmd.reserveTokens ?? 0, calls: cmd.reserveCalls ?? 0 }
      if (!canReserve(base, want)) return base
      const reserved = reserve(base.budget, base.budgetLimits, operationId, want, now)
      if (!reserved.ok) return base
      return note({ ...base, budget: reserved.budget, operations: { ...base.operations, [operationId]: operation } }, 'operation/intent', { operationId, kind: cmd.operationKind, reserved: want, grantId: grant?.grantId ?? '' }, now)
    }

    case 'operation.receipt': {
      const op = base.operations[cmd.operationId]
      if (op === undefined || (op.status !== 'intent' && op.status !== 'executing')) return base
      // 外部服务自报的阶段与内核状态分列：HTTP 成功只对应某个阶段（§22.13 DG-13）。
      const settledOp: Operation = {
        ...op,
        status: cmd.status,
        externalPhase: cmd.externalPhase ?? op.externalPhase,
        resultRef: cmd.resultRef ?? op.resultRef,
        finishedAt: now,
      }
      const budget = cmd.usage === undefined ? releaseReservation(base.budget, op.operationId, true) : settle(base.budget, op.operationId, cmd.usage)
      let grants = base.grants
      if (cmd.status === 'succeeded' && op.grantId !== undefined) {
        const grant = base.grants[op.grantId]
        if (grant !== undefined) {
          const usage = cmd.usage
          const tokens = usage === undefined ? 0 : usage.inputTokens + usage.outputTokens + usage.cacheReadTokens
          grants = { ...grants, [grant.grantId]: { ...grant, usedCount: grant.usedCount + 1, consumedTokens: grant.consumedTokens + tokens } }
        }
      }
      return note({ ...base, budget, grants, operations: { ...base.operations, [op.operationId]: settledOp } }, 'operation/settled', { operationId: op.operationId, status: cmd.status, externalPhase: settledOp.externalPhase ?? '', grantId: op.grantId ?? '' }, now)
    }

    case 'operation.reconcile': {
      const op = base.operations[cmd.operationId]
      if (op === undefined) return base
      if (cmd.verdict === 'still_unknown') {
        return note({ ...base, operations: { ...base.operations, [op.operationId]: { ...op, status: 'outcome_unknown' as const, externalPhase: 'unknown' as const } } }, 'operation/unknown', { operationId: op.operationId }, now)
      }
      const status = cmd.verdict === 'executed' ? ('succeeded' as const) : ('failed' as const)
      const budget = cmd.verdict === 'executed' ? releaseReservation(base.budget, op.operationId, false) : releaseReservation(base.budget, op.operationId, true)
      return note({ ...base, budget, operations: { ...base.operations, [op.operationId]: { ...op, status, externalPhase: status === 'succeeded' ? ('succeeded' as const) : ('failed' as const), resultRef: cmd.resultRef ?? op.resultRef, finishedAt: now } } }, 'operation/reconciled', { operationId: op.operationId, verdict: cmd.verdict }, now)
    }

    case 'delegate.start': {
      const task = base.tasks[cmd.taskId]
      if (task === undefined || task.currentAttemptId === undefined) return base
      const attempt = base.attempts[task.currentAttemptId]
      if (attempt === undefined) return base
      // 派单成功后才记录真实原生标识；不用模型自述的"已派单"文字代替运行事实（§7.1）。
      const refs = [...attempt.resultRefs]
      if (cmd.nativeRunId !== undefined) refs.push(`native:${cmd.nativeRunId}`)
      if (cmd.dispatchId !== undefined) refs.push(`dispatch:${cmd.dispatchId}`)
      const withRun: Attempt = { ...attempt, resultRefs: refs, updatedAt: now }
      const operationId = derivedId('op', cmd.requestId)
      if (base.operations[operationId] !== undefined) return base
      const op = mkOperation(base.missionId, operationId, task.taskId, {
        kind: 'delegate.start',
        target: cmd.childSessionId ?? 'subagent',
        intent: `delegate task ${task.taskId}`,
        idempotencyKey: `delegate:${task.taskId}:${attempt.attemptId}`,
        retryable: false,
        reconcileMethod: 'query native subagent run by id',
      }, now)
      return note(
        { ...base, attempts: { ...base.attempts, [attempt.attemptId]: withRun }, operations: { ...base.operations, [operationId]: op } },
        'delegate/started',
        { taskId: task.taskId, nativeRunId: cmd.nativeRunId, dispatchId: cmd.dispatchId ?? '', operationId },
        now,
      )
    }

    case 'delegate.collect': {
      const task = base.tasks[cmd.taskId]
      if (task === undefined || task.currentAttemptId === undefined) return base
      const attempt = base.attempts[task.currentAttemptId]
      if (attempt === undefined) return base
      const merged: Attempt = { ...attempt, resultRefs: [...new Set([...attempt.resultRefs, ...cmd.resultRefs])], updatedAt: now }
      // 子代理返回 ≠ 任务完成，也 ≠ 父代理已读到：结果先落交付箱，投递与处理各自回执（§22.14）。
      const plan = latestDispatchPlan(base, task.taskId)
      const recipientId = plan?.deliveryRecipientActorId ?? base.mission.leadActorId ?? attempt.actorId
      const recipient = base.actors[recipientId]
      const unreachable = recipient === undefined || recipient.retired || recipient.sessionId === undefined
      const deliveryId = derivedId('dlv', cmd.requestId)
      if (base.deliveries[deliveryId] !== undefined) return base
      const obligationId = unreachable ? derivedId('obl', cmd.requestId) : undefined
      const delivery: DeliveryEntry = {
        deliveryId,
        missionId: base.missionId,
        messageId: undefined,
        taskId: task.taskId,
        attemptId: attempt.attemptId,
        senderActorId: ctx.actorId,
        recipientActorId: recipientId,
        artifactRefs: [],
        evidenceRefs: cmd.evidenceRefs ?? [],
        stage: unreachable ? 'unrouted' : 'registered',
        handling: 'unprocessed',
        failureReason: unreachable ? `收件人 ${recipientId} 不可达，结果留在交付箱` : undefined,
        obligationId,
        queuedAt: now,
        updatedAt: now,
      }
      let next: MissionControl = { ...base, attempts: { ...base.attempts, [attempt.attemptId]: merged }, deliveries: { ...base.deliveries, [deliveryId]: delivery } }
      if (obligationId !== undefined) {
        const obligation: Obligation = {
          obligationId,
          missionId: base.missionId,
          statement: `子代理结果（${task.taskId} / ${attempt.attemptId}）无法交付给 ${recipientId}：请 Lead 指定新的接收方并整合结果`,
          ownerActorId: base.mission.leadActorId ?? ctx.actorId,
          taskId: task.taskId,
          deliveryId,
          preconditions: [],
          stage: 'ready',
          receiptRefs: [],
          proposedBy: ctx.actorId,
          createdAt: now,
          updatedAt: now,
        }
        next = { ...next, obligations: { ...next.obligations, [obligationId]: obligation } }
      }
      // 状态仍由 task.submit/verify 决定：这里只推进交付链，不改动 Task。
      return note(next, 'delegate/collected', { taskId: task.taskId, results: cmd.resultRefs.length, deliveryId, unreachable }, now)
    }

    case 'continuity.requestRotation': {
      const actor = base.actors[cmd.actorId]
      if (actor === undefined) return base
      const gate = canRotate(actor, now, base.budgetLimits.maxRotationPerHour)
      if (!gate.ok) return base
      // 同 Actor 只允许一个未结束轮换（§10.3 REQUESTED）。
      if (Object.values(base.rotations).some((r) => r.actorId === actor.actorId && r.phase !== 'ACTIVE' && r.phase !== 'WAITING_RECOVERY')) return base
      if (base.checkpoints[cmd.checkpointId] === undefined) return base
      const rotationId = derivedId('rot', cmd.requestId)
      if (base.rotations[rotationId] !== undefined) return base
      const rotation: Rotation = {
        rotationId,
        missionId: base.missionId,
        actorId: actor.actorId,
        sourceSessionId: cmd.sourceSessionId,
        targetSessionId: cmd.targetSessionId,
        targetMessageId: cmd.seedMessageId,
        phase: 'REQUESTED',
        bindingVersionBefore: actor.bindingVersion,
        bindingVersionAfter: actor.bindingVersion + 1,
        checkpointId: cmd.checkpointId,
        trigger: cmd.trigger,
        // 携带请求时的规则/依据版本：恢复后据此重验，不假设旧结论在新会话仍然成立（§23.2）。
        basisRevisionAtRequest: base.basisRevision,
        policyRevisionAtRequest: base.mission.policyRevision,
        phases: ['REQUESTED'],
        startedAt: now,
        updatedAt: now,
      }
      const actors = { ...base.actors, [actor.actorId]: noteRotation(actor, now) }
      return note({ ...base, actors, rotations: { ...base.rotations, [rotationId]: rotation } }, 'rotation/requested', { rotationId, actorId: actor.actorId }, now)
    }

    case 'continuity.advanceRotation': {
      const rotation = base.rotations[cmd.rotationId]
      if (rotation === undefined) return base
      if (!isLegalPhaseStep(rotation.phase, cmd.phase)) return base
      const actor = base.actors[rotation.actorId]
      if (actor === undefined) return base
      if (cmd.phase === 'COMMITTED') {
        // 提交点=单次更新：换绑 S2、绑定版本递增、启动 outbox 同批写入（§10.3）。
        // S1 的退役靠这里的绑定版本 + 入口守卫，不靠 goals.disarm（那只是附加关闭）。
        if (actor.sessionId !== rotation.sourceSessionId) return base
        if (actor.bindingVersion !== rotation.bindingVersionBefore) return base
        // 提交点自己拒绝携带旧依据的交接包（§22.6、§23.2 第 1 条）。执行器里的重验只是提前给出
        // 更好的诊断；闸门放在这里，崩溃恢复路径与别的调用方才绕不过去。
        if (revisionDrifts(rotation, base).length > 0) return base
        const bound: Actor = { ...actor, sessionId: rotation.targetSessionId, bindingVersion: rotation.bindingVersionAfter, updatedAt: now }
        const committed: Rotation = { ...rotation, phase: 'COMMITTED', phases: [...rotation.phases, 'COMMITTED'], updatedAt: now }
        const attempts = mapValues(base.attempts, (attempt) =>
          attempt.actorId === actor.actorId && attempt.sessionId === rotation.sourceSessionId && !isTerminalAttempt(attempt.status)
            ? { ...attempt, sessionId: rotation.targetSessionId, leaseVersion: attempt.leaseVersion + 1, updatedAt: now }
            : attempt,
        )
        return withOutbox(
          note(
            { ...base, actors: { ...base.actors, [bound.actorId]: bound }, attempts, rotations: { ...base.rotations, [committed.rotationId]: committed } },
            'rotation/committed',
            { rotationId: committed.rotationId, actorId: bound.actorId, bindingVersion: bound.bindingVersion, leaseVersionBumped: true },
            now,
          ),
          [outboxEntry(base.missionId, 'rotation.seed', { rotationId: committed.rotationId, sessionId: committed.targetSessionId, messageId: committed.targetMessageId, checkpointId: committed.checkpointId }, committed.targetMessageId, now)],
        )
      }
      const next: Rotation = { ...rotation, phase: cmd.phase, phases: [...rotation.phases, cmd.phase], updatedAt: now }
      return note({ ...base, rotations: { ...base.rotations, [next.rotationId]: next } }, 'rotation/advanced', { rotationId: next.rotationId, phase: cmd.phase }, now)
    }

    case 'continuity.failRotation': {
      const rotation = base.rotations[cmd.rotationId]
      if (rotation === undefined) return base
      // 提交点之后失败：执行权已属于 S2，保留事实等待核对，不自动退回 S1。
      const failed: Rotation = { ...rotation, phase: 'WAITING_RECOVERY', failurePhase: rotation.phase, nextReconcileAction: cmd.nextReconcileAction, phases: [...rotation.phases, 'WAITING_RECOVERY'], updatedAt: now }
      return note({ ...base, rotations: { ...base.rotations, [failed.rotationId]: failed } }, 'rotation/waiting-recovery', { rotationId: failed.rotationId, failurePhase: failed.failurePhase, reason: cmd.reason }, now)
    }

    case 'continuity.resolveUnknown': {
      const rotation = base.rotations[cmd.rotationId]
      if (rotation === undefined) return base
      if (cmd.decision === 'keep_source') {
        const actor = base.actors[rotation.actorId]
        if (actor === undefined) return base
        const restored: Actor = { ...actor, sessionId: rotation.sourceSessionId, bindingVersion: actor.bindingVersion + 1, retired: false, updatedAt: now }
        const resolved: Rotation = { ...rotation, phase: 'WAITING_RECOVERY', nextReconcileAction: undefined, phases: [...rotation.phases], updatedAt: now }
        return note({ ...base, actors: { ...base.actors, [restored.actorId]: restored }, rotations: { ...base.rotations, [resolved.rotationId]: resolved } }, 'rotation/kept-source', { rotationId: resolved.rotationId }, now)
      }
      const resumed: Rotation = { ...rotation, phase: rotation.failurePhase ?? 'COMMITTED', nextReconcileAction: undefined, updatedAt: now }
      return note({ ...base, rotations: { ...base.rotations, [resumed.rotationId]: resumed } }, 'rotation/resumed', { rotationId: resumed.rotationId, phase: resumed.phase }, now)
    }

    case 'outbox.complete': {
      const entry = base.outbox[cmd.outboxId]
      if (entry === undefined) return base
      const done: OutboxEntry = { ...entry, completedAt: now, attempts: entry.attempts + 1, lastError: cmd.error }
      return note({ ...base, outbox: { ...base.outbox, [cmd.outboxId]: done } }, 'outbox/completed', { outboxId: entry.outboxId, kind: entry.kind, error: cmd.error }, now)
    }

    case 'outbox.retry': {
      // 失败不等于完成：条目留在积压里、按退避再入场，否则一次投递失败就把动作丢了。
      const entry = base.outbox[cmd.outboxId]
      if (entry === undefined) return base
      const retried: OutboxEntry = { ...entry, attempts: entry.attempts + 1, lastError: cmd.error, availableAt: cmd.availableAt }
      return note({ ...base, outbox: { ...base.outbox, [cmd.outboxId]: retried } }, 'outbox/retry-scheduled', { outboxId: entry.outboxId, kind: entry.kind, attempts: retried.attempts, availableAt: retried.availableAt, error: cmd.error }, now)
    }

    case 'evidence.record': {
      const input = cmd.evidence
      if (input.summary.trim().length === 0 || input.sourceRef.trim().length === 0) return base
      if (input.taskId !== undefined && base.tasks[input.taskId] === undefined) return base
      if (input.attemptId !== undefined && base.attempts[input.attemptId] === undefined) return base
      const evidenceId = derivedId('evd', cmd.requestId)
      if (base.evidence[evidenceId] !== undefined) return base
      const record: EvidenceRecord = { ...input, evidenceId, missionId: base.missionId, validity: 'current', recordedBy: ctx.actorId }
      return note({ ...base, evidence: { ...base.evidence, [evidenceId]: record } }, 'evidence/recorded', { evidenceId, kind: record.kind, sourceRef: record.sourceRef, metricId: record.metricId ?? '' }, now)
    }

    case 'claim.propose': {
      if (cmd.claim.proposition.trim().length === 0) return base
      // 否定结论必须带被测对象、实现版本、输入条件与验证范围，否则只是无条件判死（§22.11 DG-11）。
      if (cmd.claim.status === 'refuted' || cmd.claim.status === 'unsupported') {
        const baseline = [cmd.claim.subject, cmd.claim.implementationVersion, cmd.claim.inputCondition, cmd.claim.verifiedRange]
        if (baseline.some((field) => field === undefined || field.trim().length === 0)) return base
      }
      // 支撑证据要与结论声明的来源类别一致：模拟读数不能当观测结论的支撑（§22.1 DG-01）。
      for (const evidenceId of cmd.claim.supportingEvidenceIds) {
        const evidence = base.evidence[evidenceId]
        if (evidence === undefined) return base
        if (evidence.kind !== cmd.claim.sourceCategory) return base
      }
      const claimId = derivedId('clm', cmd.requestId)
      if (base.claims[claimId] !== undefined) return base
      const record: ClaimRevision = { ...cmd.claim, claimId, version: 1, supersedesVersion: undefined, retractedAt: undefined, retractionReason: undefined, authorActorId: ctx.actorId, validity: 'current', createdAt: now }
      return note({ ...base, claims: { ...base.claims, [claimId]: [record] } }, 'claim/proposed', { claimId, version: 1, sourceCategory: record.sourceCategory, status: record.status }, now)
    }

    case 'claim.revise': {
      const chain = base.claims[cmd.claimId]
      const head = chain === undefined ? undefined : chain[chain.length - 1]
      if (chain === undefined || head === undefined) return base
      const status = cmd.status ?? head.status
      // 被反证/无支持/被替代与显式撤回同等对待：都要使下游执行资格失效（§22.5、§22.6）。
      const retracted = status === 'refuted' || status === 'unsupported' || status === 'superseded' || cmd.retractionReason !== undefined
      const record: ClaimRevision = {
        ...head,
        claimId: cmd.claimId,
        version: head.version + 1,
        supersedesVersion: head.version,
        proposition: cmd.proposition ?? head.proposition,
        appliesUnder: cmd.appliesUnder ?? head.appliesUnder,
        status,
        validity: cmd.validity ?? (retracted ? 'invalid' : head.validity),
        supportingEvidenceIds: cmd.supportingEvidenceIds ?? head.supportingEvidenceIds,
        contradictingEvidenceIds: cmd.contradictingEvidenceIds ?? head.contradictingEvidenceIds,
        reentryConditions: cmd.reentryConditions ?? head.reentryConditions,
        retractedAt: retracted ? now : undefined,
        retractionReason: retracted ? cmd.retractionReason ?? `状态改为 ${status}` : undefined,
        authorActorId: ctx.actorId,
        createdAt: now,
      }
      let next: MissionControl = { ...base, claims: { ...base.claims, [cmd.claimId]: [...chain, record] } }
      let invalidated = 0
      let notices: OutboxEntry[] = []
      if (retracted) {
        // 同一次提交里递增依据有效性并传播下游失效：旧票据与旧结论缓存随之作废（§22.6）。
        const cause = `claim/retracted ${cmd.claimId}@${record.version}`
        const propagation = invalidateDependents({ ...next, basisRevision: next.basisRevision + 1 }, 'claim', cmd.claimId, cause, now)
        next = propagation.state
        invalidated = propagation.invalidatedDependencies.length
        notices = propagationNotices(base.missionId, cause, propagation.queuedPropagations, next, now)
      }
      return withOutbox(note(next, 'claim/revised', { claimId: cmd.claimId, version: record.version, status, retracted, basisRevision: next.basisRevision, invalidated }, now), notices)
    }

    case 'challenge.raise': {
      if (cmd.quotedText.trim().length === 0) return base
      if (cmd.targetKind === 'task' && base.tasks[cmd.targetId] === undefined) return base
      if (cmd.targetKind === 'criteria' && !criteriaTargetExists(base, cmd.targetId)) return base
      if (cmd.targetKind === 'claim' && latestClaim(base, cmd.targetId) === undefined) return base
      // 原发布者不能靠提起一个质疑来给自己裁定通过，也不能用质疑代替裁定（§7.3）。
      if (cmd.adjudicatorActorId === ctx.actorId && authorOf(base, cmd.targetKind, cmd.targetId) === ctx.actorId) return base
      const challengeId = derivedId('chl', cmd.requestId)
      if (base.challenges[challengeId] !== undefined) return base
      // 声称硬冲突却没带反证 → 降为待审意见，不自动推翻已有充分支持的判据（§22.4）。
      const severity: Challenge['severity'] = cmd.severity === 'hard_conflict' && cmd.contradictingEvidenceIds.length === 0 ? 'under_evidenced' : cmd.severity
      const challenge: Challenge = {
        challengeId,
        missionId: base.missionId,
        targetKind: cmd.targetKind,
        targetId: cmd.targetId,
        targetRevision: cmd.targetRevision,
        quotedText: cmd.quotedText,
        contradictingEvidenceIds: cmd.contradictingEvidenceIds,
        affectedActionIds: cmd.affectedActionIds,
        adjudicatorActorId: cmd.adjudicatorActorId,
        raisedByActorId: ctx.actorId,
        outcome: 'open',
        severity,
        createdAt: now,
      }
      return note({ ...base, challenges: { ...base.challenges, [challengeId]: challenge } }, 'challenge/raised', { challengeId, targetKind: cmd.targetKind, targetId: cmd.targetId, severity }, now)
    }

    case 'challenge.resolve': {
      const challenge = base.challenges[cmd.challengeId]
      if (challenge === undefined || challenge.outcome !== 'open') return base
      if (ctx.role !== 'supervisor' && ctx.role !== 'user' && ctx.actorId !== challenge.adjudicatorActorId) return base
      if (cmd.resolution.trim().length === 0) return base
      // 被质疑对象的原作者不能靠重复原意见消除冲突（§7.3）。
      if (cmd.outcome === 'dismissed' && authorOf(base, challenge.targetKind, challenge.targetId) === ctx.actorId) return base
      if (cmd.outcome === 'merged') {
        const mergedInto = cmd.mergedInto
        if (mergedInto === undefined || mergedInto === challenge.challengeId || base.challenges[mergedInto] === undefined) return base
      }
      const resolved: Challenge = {
        ...challenge,
        outcome: cmd.outcome,
        resolution: cmd.resolution,
        mergedInto: cmd.outcome === 'merged' ? cmd.mergedInto : undefined,
        resolvedAt: now,
      }
      let next: MissionControl = { ...base, challenges: { ...base.challenges, [challenge.challengeId]: resolved } }
      let propagation = { invalidated: 0, marked: [] as string[], queued: [] as PropagationItem[] }
      if (cmd.outcome === 'upheld') {
        // 冲突成立即递增依据有效性；v1 只对已登记依赖保证传播（§22.6）。
        next = { ...next, basisRevision: next.basisRevision + 1 }
        const cause = `challenge/upheld ${challenge.challengeId}`
        if (challenge.targetKind === 'claim') {
          const result = invalidateDependents(next, 'claim', challenge.targetId, cause, now)
          next = result.state
          propagation = { invalidated: result.invalidatedDependencies.length, marked: result.tasksMarked, queued: result.queuedPropagations }
        } else if (challenge.targetKind === 'task' || challenge.targetKind === 'criteria') {
          const result = invalidateDependents(next, 'criteria', challenge.targetId, cause, now)
          next = result.state
          propagation = { invalidated: result.invalidatedDependencies.length, marked: result.tasksMarked, queued: result.queuedPropagations }
        }
      }
      return withOutbox(
        note(next, 'challenge/resolved', { challengeId: challenge.challengeId, outcome: cmd.outcome, severity: challenge.severity, basisRevision: next.basisRevision, invalidated: propagation.invalidated, marked: propagation.marked }, now),
        propagationNotices(base.missionId, `challenge/upheld ${challenge.challengeId}`, propagation.queued, next, now),
      )
    }

    case 'search.record': {
      const input = cmd.search
      if (input.query.trim().length === 0 || input.roots.length === 0) return base
      const receiptId = derivedId('srh', cmd.requestId)
      if (base.searches[receiptId] !== undefined) return base
      const record: SearchReceipt = { ...input, receiptId, missionId: base.missionId, recordedBy: ctx.actorId }
      // 覆盖边界与结果一并登记：检索假阴性不能被写成"不存在"（§22.2）。
      const absence = supportsAbsenceClaim(record)
      return note({ ...base, searches: { ...base.searches, [receiptId]: record } }, 'search/recorded', { receiptId, outcome: record.outcome, coverage: record.coverage, usableAsAbsencePremise: absence.ok, reason: absence.reason }, now)
    }

    case 'context.record': {
      const input = cmd.context
      if (base.actors[input.actorId] === undefined) return base
      if (input.providedScope.trim().length === 0) return base
      // partial 必须列明缺什么，否则"已送达"只是空话；full 又不能同时列缺项，自相矛盾（§22.3）。
      if (input.completeness === 'partial' && input.gaps.length === 0) return base
      if (input.completeness === 'full' && input.gaps.length > 0) return base
      const receiptId = derivedId('ctxr', cmd.requestId)
      if (base.contexts[receiptId] !== undefined) return base
      const record: ContextReceipt = { ...input, receiptId, missionId: base.missionId, createdAt: now }
      return note({ ...base, contexts: { ...base.contexts, [receiptId]: record } }, 'context/recorded', { receiptId, actorId: record.actorId, completeness: record.completeness, gaps: record.gaps.length, acknowledged: record.acknowledged }, now)
    }

    case 'validator.qualify': {
      // 给了 validatorId 就是对既有验证器开新版本；没给则新建一条链，ID 由内核按请求派生（审阅 N2）。
      const validatorId = (cmd.validatorId ?? derivedId('val', cmd.requestId)).trim()
      if (validatorId.length === 0) return base
      // 仅"新建链"这条路径可被派生守卫：重放若命中已有链，说明首次执行已建过，原地退回。
      // 显式 validatorId 的版本追加属于对既有对象的修订（同 `claim.revise` 一档），不进此守卫。
      if (cmd.validatorId === undefined && base.validators[validatorId] !== undefined) return base
      if (cmd.validator.name.trim().length === 0 || cmd.validator.codeRef.trim().length === 0) return base
      const chain = base.validators[validatorId] ?? []
      const head = chain[chain.length - 1]
      if (chain.length === 0 && cmd.validator.scope.trim().length === 0) return base
      if (head !== undefined && cmd.validator.scope.length > 0 && head.scope !== cmd.validator.scope) return base
      const assertions = cmd.validator.assertions
      const samples = cmd.validator.effectiveSampleIds
      const counters = cmd.validator.counterSampleIds
      // 恒真断言 / 有效样例为零 / 没有反例都不能算资格（§22.10）。
      const gateOk = assertions.length >= 1 && samples.length >= 1 && counters.length >= 1
      const eligible = cmd.eligible && gateOk
      const qualificationReason = eligible
        ? cmd.reason ?? '有效样例与已知反例齐备；资格只针对该版本、范围与样例'
        : cmd.eligible
          ? '缺有效样例或已知坏样例，不能授予资格（§22.10：恒真断言与零检查不算资格）'
          : cmd.reason ?? '未授予资格'
      const record: ValidatorSpec = {
        ...cmd.validator,
        validatorId,
        // 版本由内核按链头递增；换版本后旧资格自然失效（validatorEligible 只认链头）。
        version: head === undefined ? 1 : head.version + 1,
        eligible,
        qualificationReason,
        qualifiedBy: ctx.actorId,
        qualifiedAt: now,
        createdAt: now,
      }
      const qualified: MissionControl = { ...base, validators: { ...base.validators, [validatorId]: [...chain, record] } }
      if (!record.eligible && head?.eligible === true) {
        // 资格从有转无（复核发现遗漏或换版本使旧资格过期）：同一次控制提交里递增依据有效性，
        // 沿已声明依赖传播失效——下游任务转待复核、旧票据随之作废（§32.3、§22.6）。
        const cause = `validator/ineligible ${validatorId}@${record.version}`
        const propagation = invalidateDependents({ ...qualified, basisRevision: qualified.basisRevision + 1 }, 'validator', validatorId, cause, now)
        return withOutbox(
          note(
            propagation.state,
            'validator/qualified',
            { validatorId, version: record.version, eligible, reason: qualificationReason, basisRevision: propagation.state.basisRevision, invalidated: propagation.invalidatedDependencies.length },
            now,
          ),
          propagationNotices(base.missionId, cause, propagation.queuedPropagations, propagation.state, now),
        )
      }
      return note(qualified, 'validator/qualified', { validatorId, version: record.version, eligible, reason: qualificationReason }, now)
    }

    case 'obligation.propose': {
      const input = cmd.obligation
      const owner = base.actors[input.ownerActorId]
      if (owner === undefined || owner.retired) return base
      if (input.statement.trim().length === 0) return base
      if (input.taskId !== undefined && base.tasks[input.taskId] === undefined) return base
      const obligationId = derivedId('obl', cmd.requestId)
      if (base.obligations[obligationId] !== undefined) return base
      const obligation: Obligation = { ...input, obligationId, missionId: base.missionId, stage: input.stage ?? 'proposed', receiptRefs: [], proposedBy: ctx.actorId, createdAt: now, updatedAt: now }
      return note({ ...base, obligations: { ...base.obligations, [obligationId]: obligation } }, 'obligation/proposed', { obligationId, owner: owner.actorId, stage: obligation.stage, taskId: obligation.taskId ?? '' }, now)
    }

    case 'obligation.advance': {
      const obligation = base.obligations[cmd.obligationId]
      if (obligation === undefined) return base
      if (!isLegalObligationStep(obligation.stage, cmd.stage)) return base
      const needsReceipt = cmd.stage === 'verified' || cmd.stage === 'delivered'
      if (needsReceipt && (cmd.receiptRefs?.length ?? 0) === 0) return base
      const needsDecision = cmd.stage === 'deferred' || cmd.stage === 'cancelled'
      if (needsDecision && (cmd.reason ?? '').trim().length === 0 && (cmd.decisionSource ?? '').trim().length === 0) return base
      if (cmd.stage === 'blocked' && (cmd.reason ?? '').trim().length === 0) return base
      const receiptRefs = cmd.receiptRefs === undefined ? obligation.receiptRefs : [...new Set([...obligation.receiptRefs, ...cmd.receiptRefs])]
      const next: Obligation = {
        ...obligation,
        stage: cmd.stage,
        receiptRefs,
        // blocked 的解除条件写进 releaseCondition，避免"阻塞"变成没有出口的挂起。
        blockedReason: cmd.stage === 'blocked' ? cmd.reason : undefined,
        releaseCondition: cmd.stage === 'blocked' ? cmd.decisionSource ?? obligation.releaseCondition : obligation.releaseCondition,
        decisionReason: needsDecision ? cmd.reason : obligation.decisionReason,
        decisionSource: needsDecision ? cmd.decisionSource ?? `role:${ctx.role}` : obligation.decisionSource,
        updatedAt: now,
      }
      return note({ ...base, obligations: { ...base.obligations, [obligation.obligationId]: next } }, 'obligation/advanced', { obligationId: next.obligationId, from: obligation.stage, to: cmd.stage, receipts: receiptRefs.length }, now)
    }

    case 'authorization.grant': {
      const input = cmd.grant
      if (input.sourceRef.trim().length === 0) return base
      if (input.actions.length === 0 || input.objectScope.length === 0) return base
      if (input.environment.trim().length === 0) return base
      const grantId = derivedId('grt', cmd.requestId)
      if (base.grants[grantId] !== undefined) return base
      const grant: AuthorizationGrant = { ...input, grantId, missionId: base.missionId, usedCount: 0, consumedTokens: 0, revokedAt: undefined, revokedReason: undefined, createdAt: now }
      return note({ ...base, grants: { ...base.grants, [grantId]: grant } }, 'grant/issued', { grantId, source: grant.source, actions: grant.actions, environment: grant.environment, maxUses: grant.maxUses ?? null, tokenQuota: grant.tokenQuota ?? null }, now)
    }

    case 'authorization.revoke': {
      const grant = base.grants[cmd.grantId]
      if (grant === undefined) return base
      if (grant.revokedAt !== undefined) return base
      if (cmd.reason.trim().length === 0) return base
      const revoked: AuthorizationGrant = { ...grant, revokedAt: now, revokedReason: cmd.reason }
      const propagation = invalidateDependents({ ...base, basisRevision: base.basisRevision + 1, grants: { ...base.grants, [grant.grantId]: revoked } }, 'grant', grant.grantId, `grant/revoked ${grant.grantId}`, now)
      return withOutbox(
        note(
          propagation.state,
          'grant/revoked',
          { grantId: grant.grantId, reason: cmd.reason, basisRevision: propagation.state.basisRevision, invalidated: propagation.invalidatedDependencies.length, withdrawalNeeded: propagation.withdrawalNeeded },
          now,
        ),
        propagationNotices(base.missionId, `grant/revoked ${grant.grantId}`, propagation.queuedPropagations, propagation.state, now),
      )
    }

    case 'dependency.register': {
      const input = cmd.dependency
      if (input.targetId.trim().length === 0 || input.onId.trim().length === 0) return base
      const dependencyId = derivedId('dep', cmd.requestId)
      if (base.dependencies[dependencyId] !== undefined) return base
      // 登记时就核对 on-target 当前有效性：链头已失效的结论直接标 stale，不等下一次入场（§6.1、§22.6）。
      let reviewState: DecisionDependency['reviewState'] = 'ok'
      if (input.onKind === 'claim') {
        const head = latestClaim(base, input.onId)
        if (head === undefined || head.validity !== 'current') reviewState = 'stale'
      }
      const dependency: DecisionDependency = { ...input, dependencyId, missionId: base.missionId, reviewState, invalidatedBy: undefined, checkedAt: now }
      return note({ ...base, dependencies: { ...base.dependencies, [dependencyId]: dependency } }, 'dependency/registered', { dependencyId, targetKind: dependency.targetKind, onKind: dependency.onKind, onId: dependency.onId, reviewState }, now)
    }

    case 'dispatch.plan': {
      const task = base.tasks[cmd.dispatch.taskId]
      if (task === undefined) return base
      const dispatchId = derivedId('dsp', cmd.requestId)
      if (base.dispatches[dispatchId] !== undefined) return base
      const criteria = mintCriteria(cmd.dispatch.criteria)
      const findings = contradictionsOf({ scope: cmd.dispatch.scope, exclusions: cmd.dispatch.exclusions, inputRefs: cmd.dispatch.inputRefs, resourceKeys: task.resourceKeys, criteria })
      // 派单前先拒可识别互斥；语义疑点随派单包带走，交给 Challenge 裁定（§7.1、§22.4）。
      if (findings.some(isStructural)) return base
      const absence = checkSearchReceipts(base, cmd.dispatch.searchReceiptIds)
      if (!absence.ok) return base
      const premise = checkPremiseEvidence(base, cmd.dispatch.premiseEvidenceIds)
      if (!premise.ok) return base
      const recipient = base.actors[cmd.dispatch.deliveryRecipientActorId]
      if (recipient === undefined || recipient.retired) return base
      if (cmd.dispatch.question.trim().length === 0 || cmd.dispatch.submitTo.trim().length === 0) return base
      const plan: DispatchPlan = {
        ...cmd.dispatch,
        dispatchId,
        missionId: base.missionId,
        issuerActorId: ctx.actorId,
        objectiveRevision: base.mission.objectiveRevision,
        specRevision: task.specRevision,
        criteriaRevision: task.criteriaRevision,
        criteria,
        contradictionFindings: findings.filter((item) => !isStructural(item)),
        createdAt: now,
      }
      const dependencies = { ...base.dependencies }
      for (const [index, evidenceId] of cmd.dispatch.premiseEvidenceIds.entries()) {
        const dependencyId = derivedId('dep', cmd.requestId, `premise:${index}`)
        dependencies[dependencyId] = {
          dependencyId,
          missionId: base.missionId,
          targetKind: 'dispatch',
          targetId: dispatchId,
          targetRevision: undefined,
          // EvidenceRecord 不分版本链，onVersion 用证据的观测时点代表其具体版本（§22.6）。
          onKind: 'evidence',
          onId: evidenceId,
          onVersion: base.evidence[evidenceId]?.observedAt ?? 1,
          reviewState: 'ok',
          invalidatedBy: undefined,
          checkedAt: now,
        }
      }
      return note(
        { ...base, dispatches: { ...base.dispatches, [dispatchId]: plan }, dependencies },
        'dispatch/planned',
        { dispatchId, taskId: task.taskId, criteria: criteria.length, suspicions: plan.contradictionFindings.map((item) => item.kind), premises: cmd.dispatch.premiseEvidenceIds.length, recipient: recipient.actorId },
        now,
      )
    }

    case 'review.record': {
      const input = cmd.review
      if (input.targetId.trim().length === 0 || input.methodRef.trim().length === 0) return base
      // 角色不同不等于证据独立：共用证据或见过参考答案必须说明独立性（§22.9）。
      const notIndependent = input.sharedEvidenceIds.length > 0 || input.sawReferenceAnswer
      if (notIndependent && input.independenceNote.trim().length === 0) return base
      const reviewId = derivedId('rvw', cmd.requestId)
      if (base.reviews[reviewId] !== undefined) return base
      const record: ReviewReceipt = { ...input, reviewId, missionId: base.missionId, reviewerActorId: ctx.actorId, reviewedAt: now }
      return note({ ...base, reviews: { ...base.reviews, [reviewId]: record } }, 'review/recorded', { reviewId, targetKind: record.targetKind, targetId: record.targetId, selfConsistent: record.selfConsistent, versusHistory: record.versusHistory }, now)
    }

    case 'review.recordBatch': {
      // 批审的语义与逐条 `review.record` **完全相同**：同校验、同独立性口径、同 id 派生规则。
      // 唯一差别是一次往返。**任一条不合法就整批不写**——半批写入会让调用方以为整批成了，
      // 而缺的那几条恰恰是它最需要知道的。
      if (cmd.reviews.length === 0) return base
      const batch: Record<string, ReviewReceipt> = { ...base.reviews }
      for (let index = 0; index < cmd.reviews.length; index += 1) {
        const input = cmd.reviews[index]
        if (input === undefined) return base
        if (input.targetId.trim().length === 0 || input.methodRef.trim().length === 0) return base
        const notIndependent = input.sharedEvidenceIds.length > 0 || input.sawReferenceAnswer
        if (notIndependent && input.independenceNote.trim().length === 0) return base
        const reviewId = derivedId('rvw', `${cmd.requestId}:${index}`)
        if (batch[reviewId] !== undefined) return base
        batch[reviewId] = { ...input, reviewId, missionId: base.missionId, reviewerActorId: ctx.actorId, reviewedAt: now }
      }
      return note({ ...base, reviews: batch }, 'review/recorded-batch', { count: cmd.reviews.length }, now)
    }

    case 'incident.record': {
      const input = cmd.incident
      if (input.failureMode.trim().length === 0 || input.triggerCondition.trim().length === 0 || input.rootCause.trim().length === 0) return base
      const incidentId = derivedId('inc', cmd.requestId)
      if (base.incidents[incidentId] !== undefined) return base
      let rules = base.rules
      let candidateRuleIds = input.candidateRuleIds
      if (cmd.ruleCandidate !== undefined) {
        const ruleId = derivedId('rul', cmd.requestId)
        const chain = base.rules[ruleId] ?? []
        const head = chain[chain.length - 1]
        const record: RuleSpec = {
          ...cmd.ruleCandidate,
          ruleId,
          // 自动总结只能生成候选：激活硬门要走观察与统计，不在这里发生（§22.17、§21.4）。
          version: head === undefined ? 1 : head.version + 1,
          status: 'candidate',
          stats: { hits: 0, misfires: 0, misses: 0, costTokens: 0 },
          proposedBy: ctx.actorId,
          activatedAt: undefined,
          retiredAt: undefined,
          retirementReason: undefined,
          createdAt: now,
        }
        rules = { ...base.rules, [ruleId]: [...chain, record] }
        candidateRuleIds = [...input.candidateRuleIds, ruleId]
      }
      const incident: Incident = { ...input, candidateRuleIds, incidentId, missionId: base.missionId, recordedBy: ctx.actorId, createdAt: now }
      return note({ ...base, incidents: { ...base.incidents, [incidentId]: incident }, rules }, 'incident/recorded', { incidentId, failureMode: incident.failureMode, candidateRules: candidateRuleIds.length, fixKind: incident.fixKind }, now)
    }

    case 'delivery.confirm': {
      const delivery = base.deliveries[cmd.deliveryId]
      if (delivery === undefined) return base
      const handling: HandlingState = cmd.handling ?? delivery.handling
      if (handling === 'rejected' && (cmd.reason ?? '').trim().length === 0) return base
      const next: DeliveryEntry = {
        ...delivery,
        stage: cmd.stage,
        handling,
        failureReason: cmd.stage === 'unrouted' ? cmd.reason ?? delivery.failureReason : delivery.failureReason,
        updatedAt: now,
      }
      let obligations = base.obligations
      if (cmd.stage === 'processed' && (handling === 'accepted' || handling === 'integrated')) {
        const obligationId = delivery.obligationId
        const obligation = obligationId === undefined ? undefined : base.obligations[obligationId]
        if (obligation !== undefined && obligation.stage !== 'delivered' && obligation.stage !== 'cancelled') {
          obligations = {
            ...base.obligations,
            [obligation.obligationId]: {
              ...obligation,
              stage: 'delivered',
              receiptRefs: [...new Set([...obligation.receiptRefs, `delivery:${delivery.deliveryId}`, `handling:${handling}`])],
              updatedAt: now,
            },
          }
        }
      }
      return note({ ...base, deliveries: { ...base.deliveries, [delivery.deliveryId]: next }, obligations }, 'delivery/confirmed', { deliveryId: delivery.deliveryId, stage: cmd.stage, handling, obligationClosed: obligations !== base.obligations }, now)
    }

    case 'propagation.resolve': {
      if (cmd.reason.trim().length === 0) return base
      // 必须点名：一条命令清空整个积压等于把缺口藏起来（§22.6）。
      if (cmd.propagationId === undefined && cmd.targetKind === undefined && cmd.targetId === undefined) return base
      const discharge = dischargePropagations(base, (item) => {
        if (cmd.propagationId !== undefined && item.propagationId !== cmd.propagationId) return false
        if (cmd.targetKind !== undefined && item.targetKind !== cmd.targetKind) return false
        if (cmd.targetId !== undefined && item.targetId !== cmd.targetId) return false
        return true
      })
      if (discharge.discharged.length === 0) return base
      // 只收积压项，不改 `validity`：有效性要靠当前判据复核拿回来，裁定不能代替复核。
      return note(
        discharge.state,
        'propagation/resolved',
        { closed: discharge.discharged.map((item) => `${item.propagationId} ${item.targetKind}=${item.targetId}`), by: `${ctx.role}:${ctx.actorId}`, reason: cmd.reason, remaining: discharge.state.pendingPropagations.length },
        now,
      )
    }

    // —— v0.5 §25/§26/§31 探索与猜想接口组：薄转发，判定与提交都在领域模块（§25.2 起） ——

    case 'experiment.classifyWork': {
      const result = classifyTaskWork(base, cmd.taskId, cmd.workKind, now)
      return result.applied ? result.state : base
    }

    case 'exploration.registerPolicy': {
      const result = registerExplorationPolicy(base, cmd.registration, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'exploration.release': {
      const result = releaseExplorationReservation(base, { reason: cmd.reason, recheck: cmd.recheck }, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'exploration.restore': {
      const result = restoreExplorationReservation(base, { reason: cmd.reason }, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'experiment.preregister': {
      // 幂等键由 requestId 派生（复审 N2 阶段 2）：同一条请求重放——含去重凭据与墓碑都被过期或
      // 容量淘汰之后——落到同一个 experimentId 上。这里原地退回（返回 base = 无变化），
      // 不让它变成"同一份对象的第二版"；换 requestId 才代表新意图。
      const experimentId = cmd.draft.experimentId ?? derivedId('exp', cmd.requestId)
      if (base.experiments[experimentId] !== undefined) return base
      const result = preregisterExperiment(base, { ...cmd.draft, experimentId }, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'experiment.revise': {
      const result = reviseExperiment(base, cmd.experimentId, cmd.revision, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'experiment.advanceStage': {
      const result = advanceExperimentStage(base, cmd.experimentId, cmd.to, cmd.evidence, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'experiment.recordTrial': {
      // 幂等键由 requestId 派生（复审 N2 阶段 2）：同一条请求重放——含去重凭据与墓碑都被过期或
      // 容量淘汰之后——落到同一个 trialId 上。这里原地退回（返回 base = 无变化），
      // 不让它变成"同一份对象的第二版"；换 requestId 才代表新意图。
      const trialId = cmd.draft.trialId ?? derivedId('tri', cmd.requestId)
      if (base.trials[trialId] !== undefined) return base
      const result = recordTrial(base, { ...cmd.draft, trialId }, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'route.assess': {
      const result = upsertRouteAssessment(base, cmd.input, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'strategy.decide': {
      // 幂等键由 requestId 派生（复审 N2 阶段 2）：同一条请求重放——含去重凭据与墓碑都被过期或
      // 容量淘汰之后——落到同一个 decisionId 上。这里原地退回（返回 base = 无变化），
      // 不让它变成"同一份对象的第二版"；换 requestId 才代表新意图。
      const decisionId = cmd.draft.decisionId ?? derivedId('str', cmd.requestId)
      if (base.strategyDecisions[decisionId] !== undefined) return base
      const result = registerStrategyDecision(base, { ...cmd.draft, decisionId }, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'conjecture.capture': {
      // 幂等键由 requestId 派生（复审 N2 阶段 2）：同一条请求重放——含去重凭据与墓碑都被过期或
      // 容量淘汰之后——落到同一个 claimId 上。这里原地退回（返回 base = 无变化），
      // 不让它变成"同一份对象的第二版"；换 requestId 才代表新意图。
      const claimId = cmd.draft.claimId ?? derivedId('clm', cmd.requestId)
      if (base.claims[claimId] !== undefined) return base
      const result = captureConjecture(base, { ...cmd.draft, claimId }, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'conjecture.frame': {
      const result = frameConjecture(base, cmd.claimId, cmd.framing, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'conjecture.probeReady': {
      const result = probeReadyConjecture(base, cmd.claimId, { nextCheapestAction: cmd.nextCheapestAction }, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'conjecture.recordProbe': {
      const result = recordConjectureProbe(base, cmd.claimId, { trialId: cmd.trialId }, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'conjecture.pursue': {
      const result = pursueConjecture(base, cmd.claimId, { reason: cmd.reason }, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'conjecture.defer': {
      const result = deferConjecture(base, cmd.claimId, { deferralReason: cmd.deferralReason, note: cmd.note, ...(cmd.reentryCondition === undefined ? {} : { reentryCondition: cmd.reentryCondition }) }, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'conjecture.close': {
      const result = closeConjectureInScope(base, cmd.claimId, { reason: cmd.reason, ...(cmd.evidenceRefs === undefined ? {} : { evidenceRefs: cmd.evidenceRefs }), ...(cmd.reentryConditions === undefined ? {} : { reentryConditions: cmd.reentryConditions }) }, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    case 'conjecture.assumptionChange': {
      const result = addAssumptionChange(base, cmd.claimId, cmd.change, now, ctx.actorId)
      return result.applied ? result.state : base
    }

    // —— v0.5 §27 上下文质量接口组：动作状态与失效判定在模块里，命令层只转发 ——

    case 'context.assess': {
      // F1：非特权身份只能评估**自己会话**的上下文。评估对象是会话，跨会话评估既无意义，
      // 也不该借这条命令改别人的账。特权身份（supervisor/user）不受此限。
      if (ctx.role !== 'supervisor' && ctx.role !== 'user') {
        const target = cmd.input.freeze.sessionId
        if (target === undefined || target !== ctx.sessionId) return base
      }
      // 幂等键由 requestId 派生（复审 N2 阶段 2）：同一条请求重放——含去重凭据与墓碑都被过期或
      // 容量淘汰之后——落到同一个 assessmentId 上。这里原地退回（返回 base = 无变化），
      // 不让它变成"同一份对象的第二版"；换 requestId 才代表新意图。
      const assessmentId = cmd.input.assessmentId ?? derivedId('cqa', cmd.requestId)
      if (base.assessments[assessmentId] !== undefined) return base
      const result = assessContext(base, { ...cmd.input, assessmentId }, now)
      return result.ok ? result.state : base
    }

    case 'context.invalidateAssessment': {
      // F1：非特权身份只能操作自己的评估记录（评估的 actorId 就是它的归属）。
      if (ctx.role !== 'supervisor' && ctx.role !== 'user' && base.assessments[cmd.assessmentId]?.actorId !== ctx.actorId) return base
      const result = invalidateAssessment(base, cmd.assessmentId, cmd.current, now)
      return result.ok ? result.state : base
    }

    case 'context.transitionAction': {
      const result = transitionAction(base, cmd.assessmentId, cmd.next, cmd.note, now)
      return result.ok ? result.state : base
    }

    case 'context.applyRunPlan': {
      // F1：非特权身份只能操作自己的评估记录（评估的 actorId 就是它的归属）。
      if (ctx.role !== 'supervisor' && ctx.role !== 'user' && base.assessments[cmd.assessmentId]?.actorId !== ctx.actorId) return base
      const result = applyRunPlan(base, cmd.assessmentId, cmd.plan, now)
      return result.ok ? result.state : base
    }

    case 'context.applyActionOutcome': {
      // F1：非特权身份只能操作自己的评估记录（评估的 actorId 就是它的归属）。
      if (ctx.role !== 'supervisor' && ctx.role !== 'user' && base.assessments[cmd.assessmentId]?.actorId !== ctx.actorId) return base
      const result = applyActionOutcome(base, cmd.assessmentId, cmd.outcome, now)
      return result.ok ? result.state : base
    }

    // —— v0.5 §33 环境接续接口组：清单 / 恢复评估的状态变更都由模块判定并提交 ——

    case 'environment.register': {
      // 幂等键由 requestId 派生（复审 N2 第二阶段）：同一条请求重放——含墓碑被过期或容量挤掉之后——
      // 落到同一个 environmentId 上，命中模块自己的"清单已存在，请走 revise"，而不是再造一份（§5.1、§33.1）。
      const result = registerEnvironment(base, { ...cmd.input, environmentId: cmd.input.environmentId ?? derivedId('env', cmd.requestId) }, now)
      return result.ok ? result.state : base
    }

    case 'environment.revise': {
      const result = reviseEnvironment(base, cmd.environmentId, cmd.patch, now, ctx.actorId)
      return result.ok ? result.state : base
    }

    case 'resume.open': {
      // 同上：恢复会话的幂等键也从 requestId 派生（§33.2）。
      const result = openResume(base, { ...cmd.input, resumeId: cmd.input.resumeId ?? derivedId('resume', cmd.requestId) }, now)
      return result.ok ? result.state : base
    }

    case 'resume.advance': {
      const result = advanceResume(base, cmd.resumeId, cmd.event, now)
      return result.ok ? result.state : base
    }

    case 'resume.assess': {
      const result = assessResume(base, cmd.input, now)
      return result.ok ? result.state : base
    }

    // —— v0.5 §35 治理接口组：分类升降与状态迁移由模块按规则所有者口径核验 ——

    case 'mechanism.propose': {
      // 同上：机制的幂等键从 requestId 派生（§35.1）。
      const result = proposeMechanism(base, { ...cmd.input, mechanismId: cmd.input.mechanismId ?? derivedId('mech', cmd.requestId) }, now)
      return result.ok ? result.state : base
    }

    case 'mechanism.revise': {
      const result = reviseMechanism(base, cmd.mechanismId, cmd.patch, now, ctx.actorId)
      return result.ok ? result.state : base
    }

    case 'mechanism.changeClass': {
      const result = changeMechanismClass(base, cmd.mechanismId, cmd.nextClass, cmd.decision, now)
      return result.ok ? result.state : base
    }

    case 'mechanism.transition': {
      const result = transitionMechanism(base, cmd.mechanismId, cmd.event, now, cmd.detail ?? {})
      return result.ok ? result.state : base
    }

    case 'mechanism.recordRun': {
      // 同上：运行记录的幂等键从 requestId 派生（§35.2）。
      const result = recordMechanismRun(base, { ...cmd.input, runId: cmd.input.runId ?? derivedId('mrun', cmd.requestId) }, now)
      return result.ok ? result.state : base
    }

    case 'mechanism.recordMisreport': {
      const result = recordMisreport(base, cmd.runId, cmd.verdict, cmd.note, now)
      return result.ok ? result.state : base
    }

    // —— v0.5 §30 目标效用接口组 ——

    case 'outcome.register': {
      // source 从调用身份派生：实质修订只有 user/supervisor 能发起，参数自报不算数（§30.1、§30.2）。
      const source: ActorRole | 'agent' = ctx.role === 'user' ? 'user' : ctx.role === 'supervisor' ? 'supervisor' : 'agent'
      const options = {
        actorId: ctx.actorId,
        now,
        source,
        ...(cmd.reason === undefined ? {} : { reason: cmd.reason }),
        ...(cmd.authorizedBy === undefined ? {} : { authorizedBy: cmd.authorizedBy }),
      }
      const result = registerOutcomeContract(base, cmd.input, options)
      return result.ok ? result.state : base
    }

    case 'outcome.observe': {
      const result = updateEffectObservation(base, cmd.next, {
        actorId: ctx.actorId,
        now,
        ...(cmd.note === undefined ? {} : { note: cmd.note }),
        ...(cmd.evidenceRefs === undefined ? {} : { evidenceRefs: cmd.evidenceRefs }),
      })
      return result.ok ? result.state : base
    }

    case 'outcome.review': {
      const built = buildOutcomeReview(base, { triggers: cmd.triggers, answers: cmd.answers, conclusion: cmd.conclusion }, { actorId: ctx.actorId, now })
      if (!built.ok) return base
      // `commitOutcomeReview` 直接返回已提交的 MissionControl（复核记录进事件流，§30.2）。
      return commitOutcomeReview(base, built.record)
    }

    // —— v0.5 §34 整合接口组：资格判定（publishEligible）由模块给，调用方不能自报 ——

    case 'integration.plan': {
      // 幂等键由 requestId 派生（复审 N2 阶段 2）：同一条请求重放——含去重凭据与墓碑都被过期或
      // 容量淘汰之后——落到同一个 integrationId 上。这里原地退回（返回 base = 无变化），
      // 不让它变成"同一份对象的第二版"；换 requestId 才代表新意图。
      const integrationId = cmd.input.integrationId ?? derivedId('intg', cmd.requestId)
      if (base.integrations[integrationId] !== undefined) return base
      const result = registerIntegrationPlan(base, { ...cmd.input, integrationId }, { actorId: ctx.actorId, now })
      return result.ok ? result.state : base
    }

    case 'integration.revise': {
      const result = reviseIntegrationPlan(base, cmd.integrationId, cmd.input, { actorId: ctx.actorId, now })
      return result.ok ? result.state : base
    }

    case 'integration.receipt': {
      // 幂等键由 requestId 派生（复审 N2 阶段 2）：同一条请求重放——含去重凭据与墓碑都被过期或
      // 容量淘汰之后——落到同一个 receiptId 上。这里原地退回（返回 base = 无变化），
      // 不让它变成"同一份对象的第二版"；换 requestId 才代表新意图。
      const receiptId = cmd.input.receiptId ?? derivedId('irct', cmd.requestId)
      if (base.integrationReceipts[receiptId] !== undefined) return base
      const result = assembleIntegrationReceipt(base, { ...cmd.input, receiptId }, { actorId: ctx.actorId, now })
      return result.ok ? result.state : base
    }

    // —— v0.5 §28 记录接口组：覆盖回执与依据包只追加，校验在模块里 ——

    case 'records.recordCoverage': {
      // 幂等键由 requestId 派生（复审 N2 阶段 2）：同一条请求重放——含去重凭据与墓碑都被过期或
      // 容量淘汰之后——落到同一个 coverageId 上。这里原地退回（返回 base = 无变化），
      // 不让它变成"同一份对象的第二版"；换 requestId 才代表新意图。
      const coverageId = cmd.coverage.coverageId ?? derivedId('cvr', cmd.requestId)
      if (base.coverages[coverageId] !== undefined) return base
      const result = recordCoverage(base, { ...cmd.coverage, coverageId }, now)
      return result.ok ? result.state : base
    }

    case 'records.recordBrief': {
      // 同上：依据包的幂等键也从 requestId 派生（§28.4）。回执与结论链头都按 id 寻址，
      // 重放造出第二个 briefId 会让"同一份依据"出现两个版本，收口判定挑中哪个变成随机。
      const briefId = cmd.brief.briefId ?? derivedId('brf', cmd.requestId)
      if (base.briefs[briefId] !== undefined) return base
      const result = recordBrief(base, { ...cmd.brief, briefId }, now)
      return result.ok ? result.state : base
    }

    default:
      return base
  }
}

interface IntentLike {
  readonly kind: string
  readonly target: string
  readonly intent: string
  readonly idempotencyKey: string
  readonly retryable: boolean
  readonly reconcileMethod?: string
  readonly grantId?: GrantId
  readonly targetIdentity?: string
  readonly action?: GrantAction
}

function mkOperation(missionId: string, operationId: string, taskId: string, cmd: IntentLike, now: number): Operation {
  return {
    operationId,
    missionId,
    taskId,
    attemptId: undefined,
    idempotencyKey: cmd.idempotencyKey,
    kind: cmd.kind,
    target: cmd.target,
    targetIdentity: cmd.targetIdentity,
    grantId: cmd.grantId,
    action: cmd.action,
    intent: cmd.intent,
    status: 'intent',
    retryable: cmd.retryable,
    reconcileMethod: cmd.reconcileMethod,
    startedAt: now,
  }
}

const PHASE_ORDER: readonly RotationPhase[] = ['REQUESTED', 'QUIESCING', 'PREPARED', 'TARGET_READY', 'COMMITTED', 'ACTIVATING', 'ACTIVE']

export function isLegalPhaseStep(from: RotationPhase, to: RotationPhase): boolean {
  if (from === 'WAITING_RECOVERY') return to === 'COMMITTED' || to === 'ACTIVATING' || to === 'ACTIVE' || to === 'QUIESCING'
  if (to === 'WAITING_RECOVERY') return true
  const index = PHASE_ORDER.indexOf(from)
  const target = PHASE_ORDER.indexOf(to)
  if (index < 0 || target < 0) return false
  return target === index + 1
}

export function runningActors(state: MissionControl): number {
  const ids = new Set<string>()
  for (const attempt of Object.values(state.attempts)) {
    if (attempt.status === 'running' && attempt.actorId !== undefined) ids.add(attempt.actorId)
  }
  // 休眠成员（挂起等待消息）释放可运行槽位，身份与待处理消息保留（§6.3、§7.3）。
  let count = 0
  for (const actorId of ids) {
    if (state.actors[actorId]?.dormant === true) continue
    count += 1
  }
  return count
}

function isTerminalTask(status: Task['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/**
 * 写入方必须仍是该 Attempt 的当前绑定会话。
 *
 * 轮换将 Actor 换绑到 S2 之后，旧 S1 里残存的执行体若还能写检查点或提交，就会把
 * 已被交接包替代的状态又覆盖回去（§10.3、§12.2）。未绑定会话的调用方（监督命令、
 * CLI）与尚未记录绑定的 Attempt 无法判定，保持放行——拒绝它们会误伤恢复与人工收口。
 */
function fromBoundSession(ctx: CommandContext, attempt: Attempt): boolean {
  if (ctx.sessionId === undefined || attempt.sessionId === undefined) return true
  return ctx.sessionId === attempt.sessionId
}

function mapValues<V>(record: Readonly<Record<string, V>>, fn: (value: V) => V): Record<string, V> {
  const next: Record<string, V> = {}
  for (const [key, value] of Object.entries(record)) next[key] = fn(value)
  return next
}

/** 判据互斥的结构化输入：任务与派单共用同一组可比字段（§7.1）。 */
function contradictionsOf(source: {
  readonly scope: string
  readonly exclusions: readonly string[]
  readonly inputRefs: readonly string[]
  readonly resourceKeys: readonly string[]
  readonly criteria: readonly Criterion[]
}): ContradictionFinding[] {
  return detectContradictions({ ...source })
}

/** 同一 uri 的最新版本：验证只证明它当时所绑定的那一版内容（§8）。 */
function latestArtifactVersion(state: MissionControl, artifactId: ArtifactId | undefined): ArtifactVersion | undefined {
  if (artifactId === undefined) return undefined
  const found = findArtifact(state, artifactId)
  if (found === undefined) return undefined
  return found.group[found.group.length - 1]
}

/** 按 artifactId（可选版本）定位产物与其所在版本链：路径只是位置，身份靠版本（§22.12）。 */
function findArtifact(state: MissionControl, artifactId: ArtifactId, version?: number): { readonly uri: string; readonly group: readonly ArtifactVersion[]; readonly record: ArtifactVersion } | undefined {
  for (const uri of Object.keys(state.artifacts)) {
    const group = state.artifacts[uri]
    if (group === undefined) continue
    const record = group.find((item) => item.artifactId === artifactId && (version === undefined || item.version === version))
    if (record !== undefined) return { uri, group, record }
  }
  return undefined
}

function latestDispatchPlan(state: MissionControl, taskId: string): DispatchPlan | undefined {
  let latest: DispatchPlan | undefined
  for (const plan of Object.values(state.dispatches)) {
    if (plan.taskId !== taskId) continue
    if (latest === undefined || plan.createdAt >= latest.createdAt) latest = plan
  }
  return latest
}

/** 被质疑对象的作者：claim 取链头，task/criteria 取当前 Attempt 执行者，artifact/verification 取登记者与验证者（§7.3）。 */
function authorOf(state: MissionControl, targetKind: ChallengeTargetKind, targetId: string): ActorId | undefined {
  if (targetKind === 'claim') return latestClaim(state, targetId)?.authorActorId
  if (targetKind === 'task' || targetKind === 'criteria') {
    const taskId = targetId.split('@')[0] ?? ''
    const attemptId = state.tasks[taskId]?.currentAttemptId
    return attemptId === undefined ? undefined : state.attempts[attemptId]?.actorId
  }
  if (targetKind === 'artifact') {
    const separator = targetId.indexOf('@')
    if (separator < 0) return undefined
    return findArtifact(state, targetId.slice(0, separator), Number(targetId.slice(separator + 1)))?.record.createdBy
  }
  return state.verifications[targetId]?.verifier
}

/** `criteria` 质疑的目标既可以是任务 ID，也可以是 `taskId@criteriaRevision`。 */
function criteriaTargetExists(state: MissionControl, targetId: string): boolean {
  const separator = targetId.indexOf('@')
  const taskId = separator < 0 ? targetId : targetId.slice(0, separator)
  const task = state.tasks[taskId]
  if (task === undefined) return false
  return separator < 0 || Number(targetId.slice(separator + 1)) === task.criteriaRevision
}

function isLegalObligationStep(from: ObligationStage, to: ObligationStage): boolean {
  if (from === 'delivered' || from === 'cancelled') return false
  if (to === 'blocked' || to === 'deferred' || to === 'cancelled') return from !== to
  if (to === 'verified') return from === 'running'
  if (to === 'delivered') return from === 'verified' || from === 'running'
  const index = OBLIGATION_FLOW.indexOf(from)
  const target = OBLIGATION_FLOW.indexOf(to)
  if (index < 0 || target < 0) return false
  return target === index + 1
}

const OBLIGATION_FLOW: readonly ObligationStage[] = ['proposed', 'ready', 'running', 'verified', 'delivered']

/** "没找到"要成为存在性前提，必须由覆盖完整的检索回执承载（§22.2）。 */
function checkSearchReceipts(state: MissionControl, receiptIds: readonly SearchReceiptId[]): { readonly ok: boolean; readonly reason: string } {
  for (const receiptId of receiptIds) {
    const receipt = state.searches[receiptId]
    if (receipt === undefined) return { ok: false, reason: `检索回执 ${receiptId} 不存在` }
    const verdict = supportsAbsenceClaim(receipt)
    if (!verdict.ok) return { ok: false, reason: `检索回执 ${receiptId} 不能承载"没找到"：${verdict.reason}` }
  }
  return { ok: true, reason: '' }
}

/** 派单前提必须已登记且仍为当前有效证据（§22.6）。 */
function checkPremiseEvidence(state: MissionControl, evidenceIds: readonly EvidenceId[]): { readonly ok: boolean; readonly reason: string } {
  for (const evidenceId of evidenceIds) {
    const record = state.evidence[evidenceId]
    if (record === undefined) return { ok: false, reason: `前提证据 ${evidenceId} 未登记` }
    if (record.validity !== 'current') return { ok: false, reason: `前提证据 ${evidenceId} 有效性为 ${record.validity}，不能继续支撑派单` }
  }
  return { ok: true, reason: '' }
}
