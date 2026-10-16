/**
 * 状态模型的逻辑实体（设计稿 v0.3 §5.1、§21–22）。
 *
 * 这里只有类型与状态词表，没有行为：行为在内核的转换函数里。
 * 全部为可擦除语法（`erasableSyntaxOnly`），因此 `node --test` 可以直接跑 `.ts`，不需要先构建。
 *
 * v0.3 相对 v0.2 的变化集中在两层：
 * 1. 词表加宽——Verification 从三值到六值、结果有效性 `validity` 独立于业务状态、
 *    消息的投递状态与处理状态分开、Mission/Task 各自带 policy/spec/criteria 修订号；
 * 2. 证据与纪律面对象——RuleSpec / AuthorityBinding / EvidenceRecord / ClaimRevision /
 *    DecisionDependency / Obligation / AuthorizationGrant / SearchReceipt / ContextReceipt /
 *    Challenge / Incident，另加 §22.9 的 ReviewReceipt、§22.10 的 ValidatorSpec、
 *    §22.14 的 DeliveryEntry 和 §7.1 的 DispatchPlan。
 */

export type MissionId = string
export type TaskId = string
export type AttemptId = string
export type ActorId = string
export type TeamId = string
export type SessionId = string
export type CheckpointId = string
export type ArtifactId = string
export type VerificationId = string
export type MessageId = string
export type OperationId = string
export type RotationId = string
export type OutboxId = string
export type CriterionId = string
export type RuleId = string
export type ClaimId = string
export type EvidenceId = string
export type ObligationId = string
export type GrantId = string
export type DependencyId = string
export type ChallengeId = string
export type IncidentId = string
export type SearchReceiptId = string
export type ContextReceiptId = string
export type ValidatorId = string
export type ReviewId = string
export type DeliveryId = string
export type DispatchId = string
export type BindingId = string

export type MissionStatus = 'draft' | 'active' | 'paused' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export type TaskStatus =
  | 'planned'
  | 'ready'
  | 'leased'
  | 'running'
  | 'submitted'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'retry_wait'
  | 'failed'
  | 'cancelled'
export type AttemptStatus = 'reserved' | 'running' | 'recovering' | 'settled' | 'failed' | 'cancelled'
export type RotationPhase =
  | 'REQUESTED'
  | 'QUIESCING'
  | 'PREPARED'
  | 'TARGET_READY'
  | 'COMMITTED'
  | 'ACTIVATING'
  | 'ACTIVE'
  | 'WAITING_RECOVERY'
export type ArtifactStatus = 'draft' | 'submitted' | 'verified' | 'published' | 'rejected' | 'superseded'
export type OperationStatus = 'intent' | 'executing' | 'succeeded' | 'failed' | 'outcome_unknown'
export type MailboxState = 'pending' | 'delivered' | 'acknowledged' | 'undeliverable'

/**
 * 结果有效性（§6.1）。与业务状态分列：`completed` 说的是当时做完了，
 * `needs_review` / `invalid` 说的是现在还能不能当作当前有效结果用。
 */
export type Validity = 'current' | 'needs_review' | 'invalid'

/**
 * 验收结果词表（§6.4）。`unknown/error/not_run` 不得折算成 pass；
 * `not_applicable` 必须有适用性规则与理由，不能为绕过失败临时改成本值。
 */
export type VerificationOutcome = 'pass' | 'fail' | 'unknown' | 'error' | 'not_run' | 'not_applicable'

/** 来源类别（§22.1 DG-01）：模拟/代理结果与直接观测分列，台账不允许写进同一栏。`conjecture` 允许缺支持证据，unsupported 不等于已被证明错误（§22.8、§31）。 */
export type SourceCategory = 'observation' | 'reported' | 'inference' | 'simulated' | 'reference_bound' | 'conjecture'

/** 处理确认（§7.3）：`acknowledged` 不等于已整合，更不等于已验收。 */
export type HandlingState = 'unprocessed' | 'accepted' | 'integrated' | 'rejected'

/** 角色决定命令权限（§14：不信任模型自报的 actorId，身份取自运行时绑定）。 */
export type ActorRole = 'lead' | 'member' | 'subagent' | 'reviewer' | 'user' | 'supervisor'

/** 限额与预算的依据来源（§13：估算的困难不能写成用户禁止）。 */
export type BasisKind = 'user' | 'deployment' | 'platform' | 'estimate'

export interface Basis {
  readonly kind: BasisKind
  readonly ref: string
}

export const MISSION_TERMINAL: readonly MissionStatus[] = ['completed', 'failed', 'cancelled']
export const TASK_TERMINAL: readonly TaskStatus[] = ['completed', 'failed', 'cancelled']
export const ATTEMPT_TERMINAL: readonly AttemptStatus[] = ['settled', 'failed', 'cancelled']
/** 只有 pass 代表通过；其余五值各自表达"没通过"的不同原因（§6.4）。 */
export const PASSING_OUTCOMES: readonly VerificationOutcome[] = ['pass']
export const INEFFECTIVE_RESULTS: readonly Validity[] = ['needs_review', 'invalid']

/** 验收项：文本可读，判定靠 `criterionId` + 所属任务的 `criteriaRevision`。 */
export interface Criterion {
  readonly criterionId: CriterionId
  readonly text: string
  readonly required: boolean
  /** 允许判 `not_applicable` 的适用性规则；缺失时该判据不适用需人工裁定。 */
  readonly applicabilityRule?: string
}

/** 派单/登记时由调用方给出的判据输入，ID 由内核分配（§5.1）。 */
export interface CriterionInput {
  readonly text: string
  readonly required?: boolean
  readonly applicabilityRule?: string
}

export function mintCriteria(criteria: readonly CriterionInput[]): Criterion[] {
  return criteria.map((item, index) => ({
    criterionId: `crit_${index + 1}`,
    text: item.text,
    required: item.required ?? true,
    ...(item.applicabilityRule === undefined ? {} : { applicabilityRule: item.applicabilityRule }),
  }))
}

export interface Mission {
  readonly missionId: MissionId
  readonly objective: string
  readonly constraints: readonly string[]
  readonly constraintSources: readonly string[]
  readonly criteria: readonly Criterion[]
  /** 目标修订号：用户新指令递增，受影响的派单与验证据此判定失效（§6.1）。 */
  readonly objectiveRevision: number
  /** 规则/策略快照版本：规则集变化使旧派单与旧票据失效（§5.1、§21）。 */
  readonly policyRevision: number
  /** §13：预算与限额的来源，未指定就标未指定，不拿平台实际上限当无限。 */
  readonly budgetBasis: Basis
  /** §30.1：目标效应用例与指标局限；随 objectiveRevision/criteriaRevision 版本管理，不另建版本。 */
  readonly outcome?: OutcomeContract
  /** §25.2：探索额度与复核触发器等策略；缺省表示未启用探索预留。 */
  readonly exploration?: ExplorationPolicy
  readonly status: MissionStatus
  /** `waiting` 必须带原因（等待输入 / 等待外部系统 / 预算不足 / 结果不确定）。 */
  readonly waitingReason?: string
  readonly leadActorId?: ActorId
  readonly collaboration: 'solo' | 'delegated' | 'team' | 'hybrid'
  /** 兼容字段：细粒度授权住在 `AuthorizationGrant` 里，这里只是部署侧的引用说明。 */
  readonly permissionRef: string
  readonly allowAutoResume: boolean
  /** Lead 提议收口后、Supervisor 结构校验前挂在这里（§6.4、§14 propose_complete）。 */
  readonly completionProposal?: { readonly proposedBy: ActorId; readonly at: number; readonly note: string }
  readonly createdAt: number
  readonly updatedAt: number
}

export interface Task {
  readonly taskId: TaskId
  readonly missionId: MissionId
  readonly parentTaskId?: TaskId
  readonly dependsOn: readonly TaskId[]
  readonly title: string
  readonly scope: string
  readonly exclusions: readonly string[]
  readonly inputRefs: readonly string[]
  readonly criteria: readonly Criterion[]
  readonly priority: number
  readonly status: TaskStatus
  /** 结果有效性，与 `status` 分列（§6.1）。 */
  readonly validity: Validity
  readonly blockedReason?: string
  readonly objectiveRevision: number
  /** 任务书版本：范围/排除项/输入引用变化递增（§22.4 DG-04）。 */
  readonly specRevision: number
  /** 判据版本：验收项集合变化递增，旧验证记录只证明旧版本（§5.1）。 */
  readonly criteriaRevision: number
  /** 派单前可识别互斥的检查状态；语义疑点走 Challenge，不当作形式证明（§7.1）。 */
  readonly criteriaCheck: 'unchecked' | 'consistent' | 'suspicious'
  /** §25.2：improve/explore/validate/deliver 只是分类，不创建新的执行状态机；缺省表示未分类。 */
  readonly workKind?: WorkKind
  readonly currentAttemptId?: AttemptId
  readonly resourceKeys: readonly string[]
  readonly maxAttempts: number
  readonly attemptCount: number
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * 准入票据（§12.2）：受管调用入场时捕获的版本集合。
 * 依据撤回、授权撤销、任务书修订后旧票据失效，下一次受管调用与提交/发布前重查。
 */
export interface AdmissionTicket {
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly actorId: ActorId
  readonly leaseVersion: number
  readonly objectiveRevision: number
  readonly policyRevision: number
  readonly criteriaRevision: number
  readonly basisRevision: number
  readonly grantIds: readonly GrantId[]
  readonly targetIdentity: string
  readonly issuedAt: number
}

export interface Attempt {
  readonly attemptId: AttemptId
  readonly taskId: TaskId
  readonly missionId: MissionId
  readonly actorId: ActorId
  readonly sessionId?: SessionId
  /** 每次续租/转移递增；所有提交入口都要核对版本（§6.3）。 */
  readonly leaseVersion: number
  readonly leaseExpiresAt: number
  readonly lastHeartbeatAt: number
  readonly status: AttemptStatus
  readonly checkpointId?: CheckpointId
  readonly operationIds: readonly OperationId[]
  readonly resultRefs: readonly string[]
  readonly ticket?: AdmissionTicket
  readonly createdAt: number
  readonly updatedAt: number
}

export interface Actor {
  readonly actorId: ActorId
  readonly missionId: MissionId
  readonly role: ActorRole
  readonly teamId?: TeamId
  readonly label: string
  /** 一个 Actor 只有一个当前可执行绑定（§3.3）。 */
  readonly sessionId?: SessionId
  readonly bindingVersion: number
  readonly available: boolean
  /** 休眠：挂起等消息时释放可运行槽位，但身份与待处理消息保留（§7.3）。 */
  readonly dormant: boolean
  readonly waitingFor?: string
  readonly retired: boolean
  readonly rotationsLastHour: readonly number[]
  readonly createdAt: number
  readonly updatedAt: number
}

export interface Team {
  readonly teamId: TeamId
  readonly missionId: MissionId
  readonly memberActorIds: readonly ActorId[]
  readonly leadActorId: ActorId
  readonly leadershipVersion: number
  readonly concurrencyLimit: number
  readonly discussionTurnLimit: number
  readonly retiredMemberIds: readonly ActorId[]
}

export interface Checkpoint {
  readonly checkpointId: CheckpointId
  readonly missionId: MissionId
  readonly taskId?: TaskId
  readonly attemptId?: AttemptId
  readonly actorId: ActorId
  readonly sourceRevision: number
  readonly objectiveRevision: number
  readonly policyRevision: number
  readonly criteriaRevision: number
  readonly basisRevision: number
  readonly step: string
  readonly verifiedProgress: readonly string[]
  readonly inProgress: readonly string[]
  readonly nextAction: string
  readonly decisions: readonly string[]
  readonly blockers: readonly string[]
  readonly inFlightOperations: readonly OperationId[]
  readonly openQuestions: readonly string[]
  readonly openChallengeIds: readonly ChallengeId[]
  readonly openObligationIds: readonly ObligationId[]
  readonly contextRefs: readonly string[]
  readonly writtenAt: number
}

export interface ArtifactVersion {
  readonly artifactId: ArtifactId
  readonly missionId: MissionId
  readonly taskId?: TaskId
  readonly version: number
  readonly uri: string
  readonly contentHash: string
  readonly hashAlgorithm: string
  readonly createdBy: ActorId
  readonly lastModifiedBy?: ActorId
  readonly registeredBy: ActorId
  readonly verifiedBy?: ActorId
  /** 发现者不等于作者：读取事件不能用作作者证明（§8）。 */
  readonly discoveredBy?: ActorId
  readonly attribution: 'tool_operation' | 'native_identity' | 'observed' | 'reconciled' | 'unknown'
  readonly sourceOperationId?: OperationId
  readonly grantId?: GrantId
  readonly status: ArtifactStatus
  readonly published: boolean
  readonly validity: Validity
  /** 已对外发布的产物被撤回时只登记待处理动作，不静默删除（§22.6）。 */
  readonly withdrawalPending: boolean
  readonly registeredAt: number
}

export interface Verification {
  readonly verificationId: VerificationId
  readonly missionId: MissionId
  readonly taskId?: TaskId
  readonly criterionId: CriterionId
  readonly criteriaRevision: number
  /** 展示用文本；判定一律走 `criterionId` + `criteriaRevision`。 */
  readonly criterion: string
  readonly method: string
  readonly methodVersion: string
  readonly validatorId?: ValidatorId
  readonly eligibilityId?: string
  readonly outcome: VerificationOutcome
  /** `not_applicable` 必填：适用性规则与被豁免的理由（§6.4）。 */
  readonly applicabilityReason?: string
  readonly detail?: string
  /** 实际执行的检查条数；恒真断言与零检查要能被识别（§22.10）。 */
  readonly checksRun?: number
  readonly evidenceRefs: readonly string[]
  readonly verifier: ActorId
  readonly artifactId?: ArtifactId
  readonly artifactVersion?: number
  readonly contentHashAtVerification?: string
  readonly verifiedAt: number
}

export interface MailboxMessage {
  readonly messageId: MessageId
  readonly missionId: MissionId
  readonly fromActorId: ActorId
  readonly toActorId: ActorId
  readonly taskId?: TaskId
  readonly kind:
    | 'clarify_request'
    | 'finding'
    | 'blocker_report'
    | 'result_submit'
    | 'review_request'
    | 'change_proposal'
    | 'rotation_seed'
    | 'challenge'
    | 'correction'
  readonly body: string
  readonly causalMessageId?: MessageId
  readonly objectiveRevision: number
  readonly policyRevision: number
  readonly criteriaRevision?: number
  /** 指向被质疑的具体版本与证据（§7.3）。 */
  readonly targetKind?: 'task' | 'criteria' | 'claim' | 'artifact' | 'verification'
  readonly targetId?: string
  readonly targetRevision?: number
  readonly challengeId?: ChallengeId
  /** 期限的真实来源；无期限就留空，不编造截止时间（§5.1）。 */
  readonly deadlineAt?: number
  readonly deadlineSource?: string
  readonly state: MailboxState
  readonly handling: HandlingState
  readonly handlingReason?: string
  readonly deliveredAt?: number
  readonly acknowledgedAt?: number
  readonly handledAt?: number
  readonly attempts: number
}

export interface Operation {
  readonly operationId: OperationId
  readonly missionId: MissionId
  readonly taskId?: TaskId
  readonly attemptId?: AttemptId
  readonly idempotencyKey: string
  readonly kind: string
  readonly target: string
  /** 目标身份不明时不得回落到默认账户/项目/目录（§22.13 DG-13）。 */
  readonly targetIdentity?: string
  readonly grantId?: GrantId
  /** 授权动作类别：结果未明的写操作阻止同一任务再写，删除核对也按它分流（§22.13 DG-13）。 */
  readonly action?: GrantAction
  /** 意图先落盘，再执行外部动作（§2「先持久化意图，再做外部动作」）。 */
  readonly intent: string
  readonly status: OperationStatus
  /** 外部服务自报的阶段，与内核状态分列：HTTP 成功只对应某个阶段（§22.13）。 */
  readonly externalPhase?: 'accepted' | 'processing' | 'succeeded' | 'failed' | 'unknown'
  readonly resultRef?: string
  readonly retryable: boolean
  readonly reconcileMethod?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

export interface Rotation {
  readonly rotationId: RotationId
  readonly missionId: MissionId
  readonly actorId: ActorId
  readonly sourceSessionId: SessionId
  readonly targetSessionId: SessionId
  readonly targetMessageId: MessageId
  readonly phase: RotationPhase
  readonly bindingVersionBefore: number
  readonly bindingVersionAfter: number
  readonly checkpointId: CheckpointId
  readonly trigger: 'pressure' | 'manual' | 'recovery'
  readonly failurePhase?: RotationPhase
  readonly nextReconcileAction?: string
  /** 轮换时携带的版本，恢复后需重验规则与结论（§23.2 第 1、3 条）。 */
  readonly basisRevisionAtRequest: number
  readonly policyRevisionAtRequest: number
  readonly phases: readonly RotationPhase[]
  readonly startedAt: number
  readonly updatedAt: number
}

export interface OutboxEntry {
  readonly outboxId: OutboxId
  readonly missionId: MissionId
  readonly kind: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly idempotencyKey: string
  readonly attempts: number
  readonly availableAt: number
  /** 领取时点与被谁领取；确认落盘前一直是"结果未知"，不能当成已完成（审阅 R2）。 */
  readonly claimedAt?: number
  readonly claimedBy?: string
  readonly claimExpiresAt?: number
  /** 执行器已返回、尚未确认写入存储：与 `completedAt` 分开记，崩溃后据此核对是否重复投递。 */
  readonly sentAt?: number
  readonly completedAt?: number
  readonly lastError?: string
}

export interface ResourceLease {
  readonly key: string
  readonly missionId: MissionId
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly mode: 'read' | 'write'
  /** 基础版本/哈希：不一致时停止自动合入（§8）。 */
  readonly baseHash?: string
  readonly acquiredAt: number
}

/** 规则强制强度（§21.1）：只有 programmatic 可以做硬拒绝，语义判定不能伪装成已证明。 */
export type RuleEnforcement = 'programmatic' | 'guarded_semantic' | 'advisory'
export type RuleStatus = 'candidate' | 'observing' | 'active' | 'retired'

export interface RuleSpec {
  readonly ruleId: RuleId
  readonly version: number
  readonly statement: string
  /** 原始出处：材料编号与位置；历史经验不自动升级成全局硬禁令（§21）。 */
  readonly origin: readonly string[]
  readonly owner: string
  /** 作用域：Mission / 任务类型 / 目录，默认不全局。 */
  readonly scope: string
  readonly trigger: string
  readonly enforcement: RuleEnforcement
  readonly disposition: 'deny' | 'flag' | 'observe'
  readonly checkRef?: string
  readonly exceptions: readonly string[]
  readonly supersedesVersion?: number
  readonly status: RuleStatus
  /** §21.4 反规则膨胀：没有证明收益就降级，不靠规则数量衡量可靠性。 */
  readonly stats: { readonly hits: number; readonly misfires: number; readonly misses: number; readonly costTokens: number }
  readonly proposedBy: ActorId
  readonly activatedAt?: number
  readonly retiredAt?: number
  readonly retirementReason?: string
  readonly createdAt: number
}

export interface AuthorityBinding {
  readonly bindingId: BindingId
  readonly missionId: MissionId
  readonly factType: string
  readonly authority: string
  readonly dataScope: string
  readonly validFrom: number
  readonly validTo?: number
  readonly conflict: 'query_source' | 'newest_observation' | 'manual_adjudication'
  /** 同一绑定分别约束数据、指令和政策，不互相推导（§5.1）。 */
  readonly governs: 'data' | 'instruction' | 'policy'
  readonly notes?: string
}

export interface EvidenceRecord {
  readonly evidenceId: EvidenceId
  readonly missionId: MissionId
  readonly kind: SourceCategory
  readonly summary: string
  readonly metricId?: string
  readonly value?: string
  readonly unit?: string
  /** 分子/分母或聚合定义与精度口径；口径不同的数值禁止直接横比（§22.1 DG-01）。 */
  readonly aggregate?: string
  readonly denominator?: string
  readonly precisionNote?: string
  readonly dataScope?: string
  readonly observedAt: number
  /** 观测时间与对象时间分列：今天的读数不等于今天的状态（§22.1）。 */
  readonly objectTime?: number
  readonly environment?: string
  readonly methodVersion?: string
  readonly sourceRef: string
  readonly contentHash?: string
  /** §32.1：根证据引用；纯构想可没有根证据，但须标 conjecture（`kind`）。 */
  readonly rootRefs?: readonly ProvenanceRef[]
  /** §32.1：派生方式与所引用版本；派生摘要的确定性不得超过被引用记录。 */
  readonly derivation?: { readonly method: string; readonly fromEvidenceIds: readonly EvidenceId[] }
  /** §32.2：共同数据处理/实现/验证器依赖；共用不等于同源，人数不当成独立证据数。 */
  readonly commonDeps?: readonly string[]
  /** §32.1：完整性仍需核对；无法追溯的旧材料标 reported + unknown，不伪造引用。 */
  readonly completeness?: 'complete' | 'partial' | 'unknown'
  readonly taskId?: TaskId
  readonly attemptId?: AttemptId
  readonly operationId?: OperationId
  readonly artifactId?: ArtifactId
  readonly validity: Validity
  readonly recordedBy: ActorId
}

export type ClaimStatus = 'proposed' | 'supported' | 'unsupported' | 'refuted' | 'superseded'

export interface ClaimRevision {
  readonly claimId: ClaimId
  readonly version: number
  readonly proposition: string
  /** 适用条件；范围扩大需要新证据（§22.5 DG-05）。 */
  readonly appliesUnder: readonly string[]
  /** 否定结论必须指明被测对象、实现版本、输入条件与验证范围。 */
  readonly subject?: string
  readonly implementationVersion?: string
  readonly inputCondition?: string
  readonly verifiedRange?: string
  readonly sourceCategory: SourceCategory
  readonly status: ClaimStatus
  readonly validity: Validity
  readonly supportingEvidenceIds: readonly EvidenceId[]
  readonly contradictingEvidenceIds: readonly EvidenceId[]
  readonly reentryConditions: readonly string[]
  /** §31.3：猜想的处理阶段与 Claim 证据状态分开；pursued 不等于为真。 */
  readonly probeStage?: ConjectureStage
  /** §31.3：与任务效用的关系、假设变化、预期可见现象、竞争解释与最低成本下一动作。 */
  readonly assumptionChanges?: readonly AssumptionChange[]
  readonly expectedSignals?: readonly string[]
  readonly competingExplanations?: readonly string[]
  readonly nextCheapestAction?: string
  /** §32.4：来源可以是类比、反常观测或主动构想；来源本身不是支持证据。 */
  readonly sourceNote?: string
  readonly supersedesVersion?: number
  readonly retractedAt?: number
  readonly retractionReason?: string
  readonly authorActorId: ActorId
  readonly createdAt: number
}

export type DependencyTargetKind =
  | 'task' | 'attempt' | 'artifact' | 'checkpoint' | 'dispatch' | 'publish' | 'verification' | 'obligation' | 'claim'
  // v0.5 §28.4、§33.2、§34.4：被绑定修订的对象不再只有任务与产物。
  | 'experiment' | 'trial' | 'route' | 'strategy' | 'environment' | 'resume' | 'integration' | 'brief' | 'mechanism' | 'outcome'
export type DependencyOnKind =
  | 'claim' | 'evidence' | 'rule' | 'criteria' | 'grant'
  // §32.2 共同错误来源（验证器）与 §33 环境依赖。
  | 'validator' | 'environment'

export interface DecisionDependency {
  readonly dependencyId: DependencyId
  readonly missionId: MissionId
  readonly targetKind: DependencyTargetKind
  readonly targetId: string
  readonly targetRevision?: number
  readonly onKind: DependencyOnKind
  readonly onId: string
  readonly onVersion: number
  /**
   * §12.1：缺省按最保守的 `required_condition` 处理——旧记录没有区分时，
   * 依据失效继续阻断动作，而不是被当成可以带着反证开工的假设。
   */
  readonly condition?: ConditionKind
  readonly reviewState: 'ok' | 'stale' | 'pending_review' | 'invalidated'
  readonly invalidatedBy?: string
  readonly checkedAt: number
}

export type ObligationStage =
  | 'proposed'
  | 'ready'
  | 'running'
  | 'verified'
  | 'delivered'
  | 'blocked'
  | 'deferred'
  | 'cancelled'

/** §22.7 DG-07：承诺必须变成有责任人的后续动作，"脚本写好了"只算准备完成。 */
export interface Obligation {
  readonly obligationId: ObligationId
  readonly missionId: MissionId
  readonly statement: string
  readonly ownerActorId: ActorId
  readonly taskId?: TaskId
  readonly operationId?: OperationId
  readonly deliveryId?: DeliveryId
  readonly preconditions: readonly string[]
  readonly triggerAt?: number
  readonly stage: ObligationStage
  readonly receiptRefs: readonly string[]
  readonly blockedReason?: string
  readonly releaseCondition?: string
  /** `deferred` / `cancelled` 必填原因与有权作出该决定的来源（§22.7）。 */
  readonly decisionReason?: string
  readonly decisionSource?: string
  readonly proposedBy: ActorId
  readonly createdAt: number
  readonly updatedAt: number
}

/** 授权动作类别（§22.8 DG-08）：查询/修改/派单/发布/删除/外部提交/进程终止分别判定。 */
export type GrantAction = 'read' | 'write' | 'dispatch' | 'publish' | 'delete' | 'external_submit' | 'process_stop'

export interface AuthorizationGrant {
  readonly grantId: GrantId
  readonly missionId: MissionId
  /** 来源只认用户或可信授权入口；历史文档里的转述不生成 Grant（§22.8）。 */
  readonly source: 'user' | 'deployment'
  readonly sourceRef: string
  readonly actions: readonly GrantAction[]
  readonly objectScope: readonly string[]
  readonly environment: string
  readonly delegatable: boolean
  readonly maxUses?: number
  readonly tokenQuota?: number
  readonly expiresAt?: number
  readonly usedCount: number
  readonly consumedTokens: number
  readonly revokedAt?: number
  readonly revokedReason?: string
  readonly createdAt: number
}

/** 检索回执（§22.2 DG-02）："没找到"是有覆盖边界的观测，不是事实不存在。 */
export interface SearchReceipt {
  readonly receiptId: SearchReceiptId
  readonly missionId: MissionId
  readonly query: string
  readonly mode: 'literal' | 'regex'
  readonly roots: readonly string[]
  readonly filters: readonly string[]
  readonly synonyms: readonly string[]
  readonly pagesFetched: number
  readonly hasMore: boolean
  readonly truncated: boolean
  readonly errors: readonly string[]
  readonly coverage: 'complete' | 'partial' | 'unknown'
  readonly observedAt: number
  readonly outcome: 'found' | 'not_found_in_scope' | 'incomplete' | 'error'
  readonly resultRefs: readonly string[]
  readonly recordedBy: ActorId
}

/** 上下文送达回执（§22.3 DG-03）：只证明送到了、覆盖了哪些版本，不宣称模型已理解。 */
export interface ContextReceipt {
  readonly receiptId: ContextReceiptId
  readonly missionId: MissionId
  readonly taskId?: TaskId
  readonly actorId: ActorId
  readonly ruleVersions: Readonly<Record<RuleId, number>>
  readonly claimRefs: readonly string[]
  readonly inputRefs: readonly string[]
  readonly providedScope: string
  readonly completeness: 'full' | 'partial' | 'unknown'
  readonly gaps: readonly string[]
  readonly acknowledged: boolean
  readonly createdAt: number
}

/** §7.1 派单前可识别的硬互斥类型；自然语言矛盾只作为疑点。 */
export type ContradictionKind = 'mutate_and_freeze' | 'add_field_and_full_hash' | 'add_enum_and_closed_set' | 'scope_mismatch'

export interface ContradictionFinding {
  readonly kind: ContradictionKind
  readonly detail: string
}

/** 统一派单内容（§7.1）：已确认与推测分栏，规则与依据带版本。 */
export interface DispatchPlan {
  readonly dispatchId: DispatchId
  readonly missionId: MissionId
  readonly taskId: TaskId
  readonly attemptId?: AttemptId
  readonly issuerActorId: ActorId
  readonly objectiveRevision: number
  readonly specRevision: number
  readonly criteriaRevision: number
  readonly question: string
  readonly scope: string
  readonly exclusions: readonly string[]
  readonly inputRefs: readonly string[]
  readonly artifactForm: string
  readonly criteria: readonly Criterion[]
  readonly grantIds: readonly GrantId[]
  readonly budgetNote: string
  readonly deadlineAt?: number
  readonly submitTo: string
  readonly cancellationPolicy: string
  readonly ruleSnapshot: Readonly<Record<RuleId, number>>
  readonly confirmedFacts: readonly EvidenceId[]
  readonly assumptions: readonly string[]
  readonly premiseEvidenceIds: readonly EvidenceId[]
  readonly searchReceiptIds: readonly SearchReceiptId[]
  readonly priorResultRefs: readonly string[]
  readonly validatorRequirements: readonly ValidatorId[]
  readonly challengeEntry?: string
  readonly deliveryRecipientActorId: ActorId
  readonly contradictionFindings: readonly ContradictionFinding[]
  readonly contextReceiptId?: ContextReceiptId
  readonly createdAt: number
}

export interface Challenge {
  readonly challengeId: ChallengeId
  readonly missionId: MissionId
  readonly targetKind: 'task' | 'criteria' | 'claim' | 'artifact' | 'verification'
  readonly targetId: string
  readonly targetRevision?: number
  readonly quotedText: string
  readonly contradictingEvidenceIds: readonly EvidenceId[]
  readonly affectedActionIds: readonly string[]
  readonly adjudicatorActorId: ActorId
  readonly raisedByActorId: ActorId
  readonly outcome: 'open' | 'upheld' | 'dismissed' | 'merged'
  readonly resolution?: string
  /** 缺证据的质疑是待审意见，不自动推翻已有充分支持的判据（§22.4）。 */
  readonly severity: 'hard_conflict' | 'semantic_suspicion' | 'under_evidenced'
  readonly mergedInto?: ChallengeId
  readonly createdAt: number
  readonly resolvedAt?: number
}

/** 规则候选与事故记录（§22.17 DG-17）：按触发条件与根因归类，不按代理名字归罪。 */
export interface Incident {
  readonly incidentId: IncidentId
  readonly missionId: MissionId
  readonly failureMode: string
  readonly triggerCondition: string
  readonly rootCause: string
  readonly operationRefs: readonly string[]
  readonly impact: string
  readonly recoveryActions: readonly string[]
  readonly candidateRuleIds: readonly RuleId[]
  readonly regressionCaseId?: string
  readonly fixKind: 'state_field' | 'error_default' | 'execution_wrapper' | 'reject_counterexample' | 'process'
  readonly recordedBy: ActorId
  readonly createdAt: number
}

/** 验证器资格（§22.10 DG-10）：资格只针对已测版本、范围与样例。 */
export interface ValidatorSpec {
  readonly validatorId: ValidatorId
  readonly version: number
  readonly name: string
  readonly inputType: string
  readonly scope: string
  readonly criteriaRevision?: number
  readonly assertions: readonly string[]
  readonly allowedMissing: readonly string[]
  /** 容差按 dtype/量纲/算法误差声明，不设全局固定值（§22.10）。 */
  readonly toleranceBasis?: string
  readonly codeRef: string
  readonly effectiveSampleIds: readonly string[]
  readonly counterSampleIds: readonly string[]
  readonly eligible: boolean
  readonly qualificationReason?: string
  readonly qualifiedBy: ActorId
  readonly qualifiedAt: number
  readonly createdAt: number
}

/** 独立审查记录（§22.9 DG-09）：自洽、历史对照、增量分别记，角色不同不等于证据独立。 */
export interface ReviewReceipt {
  readonly reviewId: ReviewId
  readonly missionId: MissionId
  readonly targetKind: 'task' | 'artifact' | 'claim' | 'verification'
  readonly targetId: string
  readonly targetRevision?: number
  readonly selfConsistent: VerificationOutcome
  readonly versusHistory: 'consistent' | 'conflict' | 'duplicate' | 'unknown'
  readonly novelty?: string
  readonly sharedEvidenceIds: readonly EvidenceId[]
  readonly sawReferenceAnswer: boolean
  readonly independenceNote: string
  readonly reviewerActorId: ActorId
  readonly methodRef: string
  readonly reviewedAt: number
}

/** 交付箱（§22.14 DG-14）：产出/登记/投递/收件/处理分步，父会话失联时结果不丢。 */
export interface DeliveryEntry {
  readonly deliveryId: DeliveryId
  readonly missionId: MissionId
  readonly messageId?: MessageId
  readonly taskId?: TaskId
  readonly attemptId?: AttemptId
  readonly senderActorId: ActorId
  readonly recipientActorId: ActorId
  readonly artifactRefs: readonly ArtifactId[]
  readonly evidenceRefs: readonly EvidenceId[]
  readonly stage: 'produced' | 'registered' | 'dispatched' | 'received' | 'processed' | 'unrouted'
  readonly handling: HandlingState
  readonly failureReason?: string
  readonly obligationId?: ObligationId
  readonly queuedAt: number
  readonly updatedAt: number
}

export interface BudgetLimits {
  readonly maxModelCalls: number
  readonly maxTotalTokens: number
  readonly maxWallClockMs: number
  readonly maxConcurrentActors: number
  readonly maxTaskRetries: number
  readonly maxRotationPerHour: number
  readonly maxMailboxMessages: number
}

export interface BudgetLedger {
  readonly modelCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly wallClockMs: number
  readonly taskRetries: number
  readonly rotations: number
  readonly mailboxMessages: number
  /** §22.15 DG-15：治理开销单独计，规则执行不能耗尽本体工作预算。 */
  readonly governanceCalls: number
  readonly governanceTokens: number
  readonly governanceWallClockMs: number
  readonly reservations: readonly { readonly operationId: OperationId; readonly tokens: number; readonly calls: number; readonly reservedAt: number }[]
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxModelCalls: 4000,
  maxTotalTokens: 40_000_000,
  maxWallClockMs: 120 * 60 * 60 * 1000,
  maxConcurrentActors: 4,
  maxTaskRetries: 3,
  maxRotationPerHour: 3,
  maxMailboxMessages: 600,
}

// ————————————————————————————————————————————————————————————————
// v0.5 §5.1 新增逻辑对象：实验、记录、环境、整合与治理。
//
// 这些是逻辑对象，不新增独立服务或每对象一张表：大记录作为不可变对象引用，
// 控制聚合只存必要修订、引用与有效性摘要（§5.1 末段）。猜想复用 ClaimRevision、
// 争议复用 Challenge、整合复用 Task/Artifact/Verification，因此这里不重复定义它们。
// ————————————————————————————————————————————————————————————————

export type ExperimentId = string
export type TrialId = string
export type StrategyDecisionId = string
export type AssessmentId = string
export type CoverageId = string
export type BriefId = string
export type EnvironmentId = string
export type ResumeId = string
export type IntegrationId = string
export type IntegrationReceiptId = string
export type MechanismId = string
export type MechanismRunId = string

/** 任务分类只用于调度与额度，不改任务状态机（§25.2）。 */
export type WorkKind = 'improve' | 'explore' | 'validate' | 'deliver'

/**
 * 前提的三类身份（§12.1、§31.5）：成立条件失效阻断动作；待检验假设被反证只更新试验设计；
 * 探索假设必须标出对结论适用性的影响。三者不能混成一种"依赖"。
 */
export type ConditionKind = 'required_condition' | 'tested_hypothesis' | 'exploratory_assumption'

/** 路线建议状态（§26.2）：有作用域的决策视图，不取代 ClaimRevision 或任务运行状态。 */
export type RouteState = 'eligible' | 'needs_diagnosis' | 'deferred' | 'disfavored_in_scope' | 'closed_in_scope'

/** 猜想的处理阶段（§31.3）：与证据状态分开，pursued 不等于为真。 */
export type ConjectureStage = 'captured' | 'framed' | 'probe_ready' | 'probed' | 'pursued' | 'deferred' | 'closed_in_scope'

/** 四层失败结果的最底层（§26.1）：本次操作实际有没有完成。 */
export type ExecutionOutcomeKind = 'completed' | 'dependency_missing' | 'process_crash' | 'outcome_unknown'
/** 第二层：评价是否足以支持比较（§26.1）。 */
export type EvaluationValidity = 'valid' | 'input_misaligned' | 'validator_invalid' | 'baseline_incomparable' | 'unknown'
/** 第三层：在该条件下观察到了什么（§26.1）。 */
export type ObservedResultKind = 'target_met' | 'no_reliable_difference' | 'partial_improvement' | 'resource_exceeded' | 'lower_than_baseline' | 'not_measured'

/** 试验的逐级投入阶段（§25.3）：早期原型不在最终值上被永久淘汰，也不能无限用"不成熟"解释失败。 */
export type ExperimentStage = 'executable' | 'small_scale_validity' | 'comparable_baseline' | 'robustness_integration' | 'publish'

/** 上下文分量（§27.3）与动作（§27.4）。 */
export type ContextComponent = 'capacity' | 'coverage' | 'freshness' | 'consistency' | 'relevance_redundancy' | 'continuity' | 'behavior_regression'
export type ContextAction = 'retrieve' | 'refresh' | 'prune' | 'compact' | 'rotate' | 'wait_reconcile' | 'keep'

/** 治理机制分类（§35.1）：缺失或故障时的处置由分类决定，模型不能自行升降级。 */
export type MechanismClass = 'core_invariant' | 'required_acceptance' | 'optional_advisory'
export type MechanismStatus = 'candidate' | 'observing' | 'active' | 'cooling' | 'observe_only' | 'retired'

/** 恢复检查发现（§33.2 表格逐行）。 */
export type ResumeFinding =
  | 'unchanged' | 'changed' | 'temp_missing' | 'job_running' | 'job_done_no_receipt' | 'job_unknown' | 'needs_authorization'

/** 环境项种类（§33.1）：只保存与执行有关的配置，凭证保存服务引用。 */
export type EnvironmentItemKind =
  | 'workspace' | 'branch' | 'uncommitted_file' | 'runtime' | 'dependency' | 'input_data' | 'config_ref' | 'external_resource' | 'in_flight_job' | 'temp_artifact'

/** 溯源引用（§32.1）：每项派生记录保留根证据或来源引用、派生方式与所引用版本。 */
export interface ProvenanceRef {
  readonly kind: 'evidence' | 'artifact' | 'operation' | 'session' | 'external' | 'report' | 'none'
  readonly ref: string
  readonly version?: string
}

/** 待区分解释（§31.6）：结果意外时允许产生新猜想，但新解释必须标为事后形成。 */
export interface AssumptionChange {
  readonly text: string
  /** 事后形成：不能反向修改原预测使其"始终正确"。 */
  readonly postHoc?: boolean
}

/** 探索策略（§25.2）：额度来自 Mission 既有授权与总预算，不另开无限探索账。 */
export interface ExplorationPolicy {
  /** 份额只是待校准候选（§25.2 提到可从 20% 起步），不写死为普适常数。 */
  readonly reserveShare?: number
  readonly reserveReleasedAt?: number
  readonly releaseReason?: string
  readonly releaseRecheck?: string
  readonly maxTrialCost?: { readonly tokens?: number; readonly calls?: number; readonly note: string }
  /** 最小可辨别试验：低于它的动作不足以支持"学到/没学到"的判断（§25.2、§25.3）。 */
  readonly minDiscernibleTrial?: string
  readonly reviewTriggers: readonly string[]
  readonly deadlineAt?: number
  readonly utilityConstraint?: string
  /** §31.4：为新颖但证据薄弱的猜想保留的有界机会，不增加总预算。 */
  readonly wildcardProbeAllowance?: { readonly tokens?: number; readonly calls?: number; readonly note: string }
  readonly updatedBy?: ActorId
  readonly updatedAt?: number
}

/** 试验契约（§25.3）：阶段目标、比较成本与停止条件应在看到结果前确定，调整留版本。 */
export interface ExperimentSpec {
  readonly experimentId: ExperimentId
  readonly version: number
  readonly missionId: MissionId
  readonly taskId?: TaskId
  readonly routeFamilyId: string
  readonly problem: string
  readonly userUtility: string
  readonly candidateMechanism: string
  /** 与现路线的实质差异；只改名称不算新路线（§25.3）。 */
  readonly differenceFromCurrent: string
  readonly testedHypothesis: string
  readonly observable: string
  readonly unknowns: readonly string[]
  /** 什么结果会改变后续选择；信息价值是有依据的预期（§25.3）。 */
  readonly decisionImpact: string
  readonly baselineRef?: string
  readonly baselineVersion?: string
  readonly inputRefs: readonly string[]
  readonly dataSplit?: string
  readonly environment?: string
  readonly codeParamsNote?: string
  readonly treatmentNote: string
  readonly validatorRefs: readonly ValidatorId[]
  readonly criteria: readonly Criterion[]
  readonly requiredConditions: readonly string[]
  readonly exploratoryAssumptions: readonly string[]
  readonly budgetCapNote: string
  readonly minViableTrial: string
  readonly stopConditions: readonly string[]
  readonly riskBoundary: string
  readonly isolation: 'none' | 'separate_workspace' | 'separate_branch' | 'sandbox'
  readonly stage: ExperimentStage
  /** 由 wildcardProbeAllowance 提供机会的探测；不要求先排在预计收益第一名（§31.4）。 */
  readonly wildcard?: boolean
  readonly preregisteredAt: number
  readonly authorActorId: ActorId
  readonly createdAt: number
  readonly supersedesVersion?: number
}

/** 试验结果（§25.3、§26.1）：四层结果分别记录，实际处理是否生效单独核对。 */
export interface TrialOutcome {
  readonly trialId: TrialId
  readonly missionId: MissionId
  readonly experimentId: ExperimentId
  readonly experimentVersion: number
  readonly taskId?: TaskId
  readonly attemptId?: AttemptId
  readonly operationRefs: readonly OperationId[]
  readonly execution: ExecutionOutcomeKind
  /** §22.11 DG-11：先确认干预真的发生，再解释成败。 */
  readonly treatmentApplied: 'yes' | 'no' | 'unknown'
  readonly evaluationValidity: EvaluationValidity
  readonly observed: ObservedResultKind
  readonly observedNote?: string
  readonly criticalDownstreamActions?: readonly string[]
  readonly claimRefs: readonly ClaimId[]
  readonly evidenceRefs: readonly EvidenceId[]
  readonly environment?: string
  readonly inputVersions: readonly string[]
  readonly codeVersions: readonly string[]
  readonly validatorRefs: readonly ValidatorId[]
  readonly baselineRef?: string
  readonly budgetSpentNote?: string
  readonly confounders: readonly string[]
  readonly unknowns: readonly string[]
  readonly recordedBy: ActorId
  readonly createdAt: number
}

/** 策略决定（§25.4）：写明当前证据、未选理由、成本与复核触发器，不报告隐性思维链。 */
export interface StrategyDecision {
  readonly decisionId: StrategyDecisionId
  readonly missionId: MissionId
  readonly kind: 'strategy_review' | 'resource_allocation' | 'route_choice' | 'stop_exploration' | 'wildcard_allocation'
  readonly trigger: 'stagnation_window' | 'milestone' | 'counterexample' | 'user' | 'budget'
  /** 停滞复核窗口按可比较试验与资源投入定义，不按聊天消息条数（§25.4）。 */
  readonly window: { readonly comparableTrials: number; readonly resourceNote: string; readonly from: number; readonly to: number }
  readonly currentEvidence: readonly string[]
  readonly candidates: readonly {
    readonly routeFamilyId: string
    readonly option: string
    readonly expectedInfoValue: string
    readonly costNote: string
    readonly chosen: boolean
    readonly rejectedReason?: string
  }[]
  readonly costNote: string
  readonly reviewTrigger: string
  /** 决定所依据的记录水位，过期前提不能继续放行（§28.4）。 */
  readonly asOfMissionRevision: number
  readonly ownerActorId: ActorId
  readonly createdAt: number
}

/** 路线状态（§26.2）：closed_in_scope 需要关闭理由、证据与重新评估条件。 */
export interface RouteAssessment {
  readonly routeFamilyId: string
  readonly missionId: MissionId
  readonly scope: string
  readonly state: RouteState
  readonly reason: string
  readonly evidenceRefs: readonly string[]
  readonly reentryConditions: readonly string[]
  readonly updatedBy: ActorId
  readonly updatedAt: number
}

/** 上下文评估（§27.3）：保存分量及其依据，不要求先合成为总分。 */
export interface ContextAssessment {
  readonly assessmentId: AssessmentId
  readonly missionId: MissionId
  readonly actorId: ActorId
  readonly sessionId?: SessionId
  readonly requestFingerprint: string
  readonly sessionRevision: number
  /** 会话变化时旧评估失效：这些版本一起冻结（§27.5 第 2 条）。 */
  readonly missionRevision: number
  readonly objectiveRevision: number
  readonly policyRevision: number
  readonly criteriaRevision: number
  readonly components: readonly { readonly name: ContextComponent; readonly signal: string; readonly limitNote?: string; readonly unknown?: boolean }[]
  readonly suggestion: ContextAction
  readonly reason: string
  /** 确定性检查每次重要准入执行；较贵语义检查放里程碑与拟压缩时（§27.3）。 */
  readonly deterministic: boolean
  readonly costNote?: string
  readonly actionState?: 'recorded' | 'queued' | 'running' | 'done' | 'failed' | 'skipped'
  readonly actionNote?: string
  readonly createdAt: number
}

/** 覆盖与新鲜度回执（§28.4）：不同会话分别读出的快照不声称跨会话原子性。 */
export interface RecordCoverage {
  readonly coverageId: CoverageId
  readonly missionId: MissionId
  readonly asOfMissionRevision: number
  readonly sourceCuts: readonly {
    readonly source: string
    readonly watermark: string
    readonly durability: 'durable' | 'session_only' | 'volatile'
  }[]
  readonly filters: readonly string[]
  readonly pages?: number
  readonly truncated: boolean
  readonly errors: readonly string[]
  readonly unresolvedConflicts: readonly string[]
  readonly completeness: 'complete_within_scope' | 'partial' | 'unavailable'
  readonly createdAt: number
}

/** 决定依据包（§28.4、§28.5）：重要派单与路线决定绑定它，缺覆盖就明示不足。 */
export interface DecisionBrief {
  readonly briefId: BriefId
  readonly missionId: MissionId
  readonly kind: 'strategy' | 'dispatch' | 'publish' | 'close_route' | 'overall_acceptance'
  readonly targetRefs: readonly string[]
  readonly asOfMissionRevision: number
  readonly policyRevision: number
  readonly claimVersions: Readonly<Record<ClaimId, number>>
  readonly criteriaRefs: readonly string[]
  readonly coverageId: CoverageId
  readonly supportedRefs: readonly string[]
  readonly contradictedRefs: readonly string[]
  readonly unresolvedRefs: readonly string[]
  readonly blockers: readonly string[]
  readonly preparedBy: ActorId
  readonly createdAt: number
}

/** 目标契约（§30.1）：随 Mission 版本管理，不另建一套目标版本。 */
export interface OutcomeContract {
  readonly intendedUse: string
  readonly desiredOutcome: string
  readonly acceptanceExamples: readonly { readonly kind: 'success' | 'boundary' | 'failure'; readonly text: string }[]
  readonly metricsAndLimits: readonly {
    readonly metric: string
    readonly represents: string
    readonly cannotRepresent: string
    /** 指标映射本身也可以尚待验证，不假装已经校准（§30.1）。 */
    readonly mappingPending?: boolean
  }[]
  readonly hardConstraints: readonly { readonly text: string; readonly source: string }[]
  readonly preferencesAndTradeoffs: readonly { readonly preference: string; readonly authorizedBy?: string }[]
  /** 写明可先推进的范围及何时必须澄清（§30.1）。 */
  readonly unresolvedAssumptions: readonly { readonly text: string; readonly advanceScope: string; readonly clarifyBy?: string }[]
  /** §30.3：需要未来实际使用才能验证的效果标 outcome_pending，不假报已经发生。 */
  readonly effectObservation: {
    readonly state: 'not_required' | 'outcome_pending' | 'observed'
    readonly note?: string
    readonly evidenceRefs?: readonly EvidenceId[]
  }
  readonly revisedAt: number
  readonly revisedBy: ActorId
}

/** 环境清单（§33.1）：由下一步需要什么决定检查什么，未覆盖项显式标 unknown。 */
export interface EnvironmentManifest {
  readonly environmentId: EnvironmentId
  readonly version: number
  readonly missionId: MissionId
  readonly taskId?: TaskId
  readonly attemptId?: AttemptId
  readonly nextAction: string
  readonly items: readonly {
    readonly kind: EnvironmentItemKind
    readonly ref: string
    readonly expected?: string
    readonly observeMethod: string
    readonly lastCheckedAt?: number
    /** immutable 输入复用时可直接复用原验证；variable 变化时只重验受影响结果（§33.2）。 */
    readonly sensitivity: 'immutable' | 'variable'
    readonly changeAction: string
    readonly coverage: 'covered' | 'unknown'
  }[]
  readonly authorActorId: ActorId
  readonly createdAt: number
  readonly supersedesVersion?: number
}

/** 恢复评估（§33.3）：capture_expected→…→ready/blocked_scope，不独立赋予执行权。 */
export interface ResumeAssessment {
  readonly resumeId: ResumeId
  readonly missionId: MissionId
  readonly environmentId: EnvironmentId
  readonly environmentVersion: number
  readonly taskId?: TaskId
  readonly attemptId?: AttemptId
  readonly phase: 'capture_expected' | 'inspect_current' | 'classify_drift' | 'repair_or_reconcile' | 'revalidate' | 'ready' | 'blocked_scope'
  readonly findings: readonly {
    readonly ref: string
    readonly finding: ResumeFinding
    readonly action: string
    readonly allowedScope: string
  }[]
  /** 作业身份：服务 job ID 或主机/进程启动身份组合；单一 PID 不足以证明旧任务已结束（§33.2）。 */
  readonly jobIdentity?: string
  readonly targetIdentity: string
  readonly objectVersions: Readonly<Record<string, string | number>>
  readonly checkedAt: number
  readonly validUntil?: number
  readonly decidedBy: ActorId
  readonly createdAt: number
}

/** 整合计划（§34.3）：拆分工作时就声明接口与整体使用例，唯一整合任务 owner。 */
export interface IntegrationPlan {
  readonly integrationId: IntegrationId
  readonly missionId: MissionId
  readonly integrationTaskId: TaskId
  readonly componentRefs: readonly {
    readonly taskId?: TaskId
    readonly artifactId?: ArtifactId
    readonly expectedVersion: string
    readonly inputOutput: string
    readonly versionsUnitsFormats: string
  }[]
  readonly interfaces: readonly { readonly name: string; readonly contract: string; readonly consumers: readonly string[] }[]
  readonly sharedAssumptions: readonly string[]
  readonly baselineRef?: string
  readonly candidateRefs: readonly string[]
  readonly userFlow: string
  readonly ownerActorId: ActorId
  readonly createdAt: number
}

/** 整合回执（§34.4）：绑定整合后产物指纹与确切版本，成员通过不能投票变成整体通过。 */
export interface IntegrationReceipt {
  readonly receiptId: IntegrationReceiptId
  readonly missionId: MissionId
  readonly integrationId: IntegrationId
  readonly artifactFingerprint: string
  readonly componentRefs: readonly { readonly ref: string; readonly version: string }[]
  readonly environment?: string
  readonly objectiveRevision: number
  readonly criteriaRevision: number
  readonly checks: readonly {
    readonly kind: string
    readonly result: 'pass' | 'fail' | 'unknown'
    readonly note: string
  }[]
  readonly reusedComponentRefs: readonly string[]
  readonly reworkTaskIds: readonly TaskId[]
  readonly publishEligible: boolean
  readonly decidedBy: ActorId
  readonly createdAt: number
}

/** 机制策略（§35.1）：复用 RuleSpec 的生命周期，分类决定缺失/故障时的处置。 */
export interface MechanismPolicy {
  readonly mechanismId: MechanismId
  readonly version: number
  readonly missionId: MissionId
  readonly name: string
  readonly class: MechanismClass
  readonly purpose: string
  readonly triggers: readonly string[]
  readonly requiredInputs: readonly string[]
  readonly relevantRevisions: readonly string[]
  readonly scope: string
  readonly benefitSignal: string
  readonly costCap?: { readonly tokens?: number; readonly calls?: number; readonly wallClockMs?: number }
  readonly timeoutMs?: number
  readonly status: MechanismStatus
  /** 冷却结束只重新检查能力，不视为故障已经修复（§35.3）。 */
  readonly statusReason?: string
  readonly resumeWhen?: string
  readonly retiredAt?: number
  readonly retirementReason?: string
  readonly proposedBy: ActorId
  readonly createdAt: number
}

/** 机制运行记录（§35.2）：总成本仍从 Mission 预算扣除；不可观测的费用显示 unknown。 */
export interface MechanismRun {
  readonly runId: MechanismRunId
  readonly missionId: MissionId
  readonly mechanismId: MechanismId
  readonly mechanismVersion: number
  readonly actorId?: ActorId
  readonly taskId?: TaskId
  readonly trigger: string
  readonly startedAt: number
  readonly finishedAt?: number
  readonly modelCalls?: number
  readonly tokens?: number
  readonly wallClockMs?: number
  readonly blockedWaitMs?: number
  readonly costUnknown?: boolean
  readonly outputNote: string
  readonly actualAction: string
  /** 后来是否发现误报；归因不清时保留不确定（§35.4）。 */
  readonly misreport?: 'yes' | 'no' | 'unknown'
  readonly misreportNote?: string
}

/** 认领心跳/租约候选值（§15.1）；到期只触发核对，不直接授予新执行权。 */
export const LEASE_HEARTBEAT_MS = 15_000
export const LEASE_EXPIRY_MS = 90_000
