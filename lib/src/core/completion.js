import { criteriaReport, openObligations } from './discipline.js';
import { isTerminalAttempt } from './lease.js';
import { integrationReceiptCurrent } from './integration.js';
import { mechanismHead } from './governance.js';
/**
 * Mission 完成：必要验收项齐、放弃项有记录、成员与后台任务已停、预算已结算。
 *
 * `boundary` 区分两种收口，它们的条件不同，不能混为一谈：
 * - `mission`（默认）：整个 Mission 关闭，未结算 Attempt / 外部操作 / 待办 / 预算都算缺口。
 * - `phase`：阶段交付。只看**纳入本阶段的任务**及其证据、依赖与阻断项；
 *   无关的后台工作、独立探索不应妨碍这一阶段交付。
 */
export function missionCompletion(state, optionalTaskIds = [], boundary = 'mission') {
    const missing = [];
    const required = Object.values(state.tasks).filter((task) => !optionalTaskIds.includes(task.taskId));
    const relevantTaskIds = new Set(required.map((task) => task.taskId));
    const incomplete = required.filter((task) => task.status !== 'completed');
    if (incomplete.length > 0) {
        missing.push(`${incomplete.length} 个任务未 completed：${incomplete.map((task) => `${task.taskId}(${task.status})`).join(', ')}`);
    }
    // 已完成 ≠ 当前有效：验收项要按**当前判据版本**成立，且结果有效性仍是 current（§6.1、§6.4）。
    for (const task of required.filter((item) => item.status === 'completed')) {
        const report = criteriaReport(state, task);
        if (!report.satisfied)
            missing.push(`任务 ${task.taskId} 的必需验收项未通过：${report.blockers.join(' / ')}`);
        if (task.validity !== 'current')
            missing.push(`任务 ${task.taskId} 依赖依据已撤回，需复核（validity=${task.validity}）`);
    }
    // 阶段交付只追究本阶段任务名下的进行中工作；Mission 关闭才看全局。
    const inScope = (taskId) => boundary === 'mission' || (taskId !== undefined && relevantTaskIds.has(taskId));
    const live = Object.values(state.attempts).filter((attempt) => !isTerminalAttempt(attempt.status) && inScope(attempt.taskId));
    if (live.length > 0)
        missing.push(`${live.length} 个 Attempt 未结算`);
    const openOps = Object.values(state.operations).filter((op) => (op.status === 'intent' || op.status === 'executing' || op.status === 'outcome_unknown') && inScope(op.taskId));
    if (openOps.length > 0)
        missing.push(`${openOps.length} 个操作结果未确定`);
    const pending = Object.values(state.outbox).filter((entry) => entry.completedAt === undefined);
    if (pending.length > 0)
        missing.push(`${pending.length} 项待办未投递`);
    if (state.budget.reservations.length > 0)
        missing.push(`${state.budget.reservations.length} 笔预算预留未结算`);
    const undecided = Object.values(state.mailbox).filter((message) => message.state === 'undeliverable');
    if (undecided.length > 0)
        missing.push(`${undecided.length} 条消息无接收者，需 Lead 调整`);
    const abandoned = uncoveredMissionCriteria(state);
    if (abandoned.length > 0) {
        missing.push(`验收项无对应记录：${abandoned.map((criterion) => `${criterion.criterionId}「${criterion.text}」`).join(' / ')}（明确放弃需登记）`);
    }
    // 承诺必须落到有责任人的后续动作，不能停在报告末尾的"以后再做"（§22.7、§12.3）。
    const obligations = openObligations(state);
    if (obligations.length > 0) {
        missing.push(`未闭环承诺：${obligations.map((item) => `${item.obligationId} owner=${item.ownerActorId} stage=${item.stage}`).join(' / ')}`);
    }
    // 依据撤回的下游传播没跑完时，当前结论的依据不是当前的（§22.6、§23.2 第 3 条）。
    if (state.pendingPropagations.length > 0) {
        missing.push(`待传播项未完成：${state.pendingPropagations.map((item) => `${item.propagationId} ${item.targetKind}=${item.targetId}→${item.requiredAction}`).join(' / ')}`);
    }
    // 投递成功不等于对方已处理：交付箱里仍在半路的条目都是缺口（§22.14）。
    const unconfirmed = Object.values(state.deliveries).filter((item) => item.stage !== 'processed');
    if (unconfirmed.length > 0) {
        missing.push(`交付未获处理确认：${unconfirmed.map((item) => `${item.deliveryId} stage=${item.stage} handling=${item.handling} recipient=${item.recipientActorId}`).join(' / ')}`);
    }
    // 交付面：R4/R5/R6 共用同一批"已交付任务"作前提，先取一次。
    const delivered = required.filter((task) => task.status === 'submitted' || task.status === 'completed');
    // R4：已交付但**没有独立复核**的任务。三个条件缺一不可：绑定本任务、
    // `versusHistory` 不在 unknown、**审查者不是本任务的执行者**——否则执行者自审
    // 就能消掉这条缺口，而它声称的正是"由另一名成员复核"。
    const executorsOfTask = (taskId) => new Set(Object.values(state.attempts).filter((attempt) => attempt.taskId === taskId).map((attempt) => attempt.actorId));
    const unreviewed = delivered.filter((task) => {
        const executors = executorsOfTask(task.taskId);
        return !Object.values(state.reviews).some((item) => item.targetKind === 'task'
            && item.targetId === task.taskId
            && item.versusHistory !== 'unknown'
            && !executors.has(item.reviewerActorId)
            // 定向失效：审查必须晚于**这一版**任务。任务改过（updatedAt 前移）之后，
            // 旧审查只证明旧版本，自动失效——这比要求人手"记得重审"可靠。
            && item.reviewedAt >= task.updatedAt);
    });
    if (unreviewed.length > 0) {
        missing.push(`${unreviewed.length} 个已交付任务没有独立复核：${unreviewed.map((task) => task.taskId).join(', ')}（需另一名成员核对"是否做过、结论是否冲突"；本任务执行者自己的审查不算）`);
    }
    // R5：本次交付要有一次**覆盖完整**的检索留痕。三种形态都算数：
    // found（查到了）、not_found_in_scope（查过并确认范围内没有）、以及派单前已经做过的复用。
    //
    // 刻意不做的两件事：不按执行者逐个要求（同一范围重复检索是浪费），
    // 也不卡"必须发生在开工之后"（无历史的新任务会被直接堵死，而"范围内确实没有"
    // 本身就是有效结论）。真正不合格的只有两种：从没查过，或者查了但覆盖不完整——
    // 后者才是"假阴性被当成不存在"的来源。
    if (delivered.length > 0) {
        const searches = Object.values(state.searches);
        const solid = (item) => item.coverage === 'complete' && (item.outcome === 'found' || item.outcome === 'not_found_in_scope');
        // 没有回执**不报**：不是每个任务都需要检索，"必须查过一次"本身就是要取消的打卡式要求。
        // 只在"登记了回执、却没有一条覆盖完整"时报——这才是把假阴性当成"范围内没有"的来源。
        if (searches.length > 0 && !searches.some(solid)) {
            missing.push(`${searches.length} 条检索回执都没有覆盖完整：需 coverage=complete 且 outcome 为 found 或 not_found_in_scope（partial/unknown 不能当作"范围内没有"）`);
        }
    }
    // R6：确有交付时，收口前要有 **reviewer 身份**登记、且**晚于最后一次交付**的整体审核。
    // 只要求"存在一条 reviewer 记录"不够——审一条无关旧 claim 也能满足。
    if (delivered.length > 0) {
        const reviews = Object.values(state.reviews);
        const reviewerIds = new Set(Object.values(state.actors).filter((actor) => !actor.retired && actor.role === 'reviewer').map((actor) => actor.actorId));
        const lastDelivery = Math.max(...delivered.map((task) => task.updatedAt));
        if (reviews.length === 0) {
            missing.push('Mission 收口前需由 reviewer 成员登记一次整体审核（当前没有任何审查记录）');
        }
        else if (!reviews.some((item) => reviewerIds.has(item.reviewerActorId) && item.reviewedAt >= lastDelivery)) {
            missing.push('没有任何 reviewer 审查发生在最后一次交付之后：收口前需 reviewer 成员审核本次交付的整体结果');
        }
    }
    const diagnostics = [...archivedDiagnostics(state), ...longHorizonDiagnostics(state)];
    return { ready: missing.length === 0, missing, ...(diagnostics.length === 0 ? {} : { diagnostics }) };
}
/**
 * Mission 级判据里还没有"合格记录"的那些（§6.4）。
 *
 * 只按 `criterionId` 匹配，不看文本是否被抄进别处——同族判据撞名是常态；
 * `unknown/error/not_run/fail` 都不算覆盖，`not_applicable` 必须有适用性规则与理由。
 */
function uncoveredMissionCriteria(state) {
    const records = Object.values(state.verifications).filter((item) => item.taskId === undefined);
    return state.mission.criteria.filter((criterion) => {
        if (!criterion.required)
            return false;
        const latest = latestRecord(records.filter((item) => item.criterionId === criterion.criterionId));
        if (latest === undefined)
            return true;
        if (latest.outcome === 'pass')
            return false;
        if (latest.outcome === 'not_applicable') {
            return !(criterion.applicabilityRule !== undefined && (latest.applicabilityReason ?? '').length > 0);
        }
        return true;
    });
}
function latestRecord(records) {
    let latest;
    for (const item of records) {
        if (latest === undefined || item.verifiedAt > latest.verifiedAt)
            latest = item;
    }
    return latest;
}
/** 剪枝把已闭合条目收敛掉了，报告要如实说明视图不是全量历史（§5.3）。 */
function archivedDiagnostics(state) {
    return Object.entries(state.archivedCounts)
        .filter(([, count]) => count > 0)
        .map(([field, count]) => `${field} 已归档 ${count} 条：视图与判定只覆盖保留部分，历史需另取备份`);
}
/**
 * v0.5 长期面的非阻断诊断（§25–§35）。
 *
 * 这些说明改变的是"还能宣称什么"，不改变收口结构条件：本次交付仍可按原范围完成，
 * 未闭合猜想、待验证的长期效果、停用中的机制与过期的整合回执都不阻断完成（§30.3、§31.3、§34.4、§35.3）。
 */
function longHorizonDiagnostics(state) {
    const lines = [];
    const outcome = state.mission.outcome;
    if (outcome !== undefined && outcome.effectObservation.state === 'outcome_pending') {
        lines.push('效果观测仍为 outcome_pending：本次交付可按原范围完成，但不能宣称长期效果已发生（§30.3）');
    }
    // "未闭合"取非终态：`experiment.CONJECTURE_TRANSITIONS` 里只有 closed_in_scope 没有出口；
    // deferred 仍可按重入条件回到 probe_ready，所以按仍在追踪计（§31.3、§31.4）。
    const tracking = Object.keys(state.claims)
        .sort()
        .filter((claimId) => {
        const stage = state.claims[claimId]?.at(-1)?.probeStage;
        return stage !== undefined && stage !== 'closed_in_scope';
    });
    if (tracking.length > 0)
        lines.push(`${tracking.length} 条猜想仍在追踪：${tracking.join('、')}`);
    const drifted = Object.keys(state.integrationReceipts)
        .sort()
        .filter((receiptId) => !integrationReceiptCurrent(state, receiptId).current);
    if (drifted.length > 0)
        lines.push(`整合回执与当前版本不一致（§34.4）：${drifted.join('、')}`);
    // "需要处理"取最保守集合 {cooling, observe_only}：`governance.LEGAL_TRANSITIONS` 里这两个状态
    // 只能经 demote_to_observing 或 retire 离开，即按范围停用、要重新评估能力；
    // candidate / observing 是正常生命周期前缀，retired 是合法终态，都不列入（§35.3、§35.4）。
    const degraded = Object.keys(state.mechanisms)
        .sort()
        .filter((mechanismId) => {
        const status = mechanismHead(state, mechanismId)?.status;
        return status === 'cooling' || status === 'observe_only';
    });
    if (degraded.length > 0) {
        lines.push(`机制按范围停用需处理：${degraded.join('、')}（cooling / observe_only：冷却结束不等于故障已修复，§35.3）`);
    }
    return lines;
}
export function closureGaps(state, taskId) {
    const task = state.tasks[taskId];
    const attempt = task?.currentAttemptId === undefined ? undefined : state.attempts[task.currentAttemptId];
    const artifacts = Object.values(state.artifacts).flat().filter((item) => item.taskId === taskId);
    return {
        unregisteredArtifacts: artifacts.filter((item) => item.status === 'draft').map((item) => item.uri),
        openOperations: Object.values(state.operations)
            .filter((op) => op.taskId === taskId && (op.status === 'intent' || op.status === 'executing'))
            .map((op) => op.operationId),
        missingCheckpoint: attempt !== undefined && attempt.checkpointId === undefined,
        unverifiedSubmits: Object.values(state.tasks)
            .filter((item) => item.status === 'submitted')
            .map((item) => item.taskId),
        openObligations: openObligations(state, taskId).map((item) => `${item.obligationId} owner=${item.ownerActorId} stage=${item.stage}`),
        openChallenges: Object.values(state.challenges)
            .filter((item) => item.outcome === 'open' && (item.targetId === taskId || item.targetId.startsWith(`${taskId}@`)))
            .map((item) => `${item.challengeId} ${item.targetKind}=${item.targetId} severity=${item.severity}`),
        unconfirmedDeliveries: Object.values(state.deliveries)
            .filter((item) => item.taskId === taskId && item.stage !== 'processed')
            .map((item) => `${item.deliveryId} stage=${item.stage} handling=${item.handling}`),
        staleBasis: state.pendingPropagations.length > 0,
    };
}
