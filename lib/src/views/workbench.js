import { acceptanceFromNative, dependencyRisks, linksFromNativeBoard, mergeTaskView } from '../adapter/agent-teams.js';
import { missionLedger } from './export.js';
import { MISSION_MARKER, markerKeyOf } from '../team/board-mirror.js';
/** 面板的实现身份，同时是宿主右侧停靠面里这个页签类型的 `kind`。 */
export const WORKBENCH_KIND = 'continuity-workbench';
/** 只读投影路由：与 `/api/continuity.ledger` 同一条鉴权栅栏，浏览器侧去掉前导斜杠使用。 */
export const WORKBENCH_PATH = '/api/continuity.workspace';
const byId = (a, b) => a.taskId.localeCompare(b.taskId);
const byActor = (a, b) => a.actorId.localeCompare(b.actorId);
/** 当前判据版本的最新结论；版本不符或从未验证都回 `missing`，不拿旧版本结论冒充新版本。 */
function criterionOutcome(state, task, criterion) {
    const matching = Object.values(state.verifications)
        .filter((item) => item.taskId === task.taskId && item.criterionId === criterion.criterionId && item.criteriaRevision === task.criteriaRevision)
        .sort((a, b) => a.verificationId.localeCompare(b.verificationId));
    const last = matching[matching.length - 1];
    return last === undefined ? { outcome: 'missing', method: '' } : { outcome: last.outcome, method: last.method };
}
/** 谁在跑这个任务：当前 Attempt 的持有者；没有 Attempt 时是"未领取"，不是"没有人"。 */
function ownerOf(state, task) {
    const attempt = task.currentAttemptId === undefined ? undefined : state.attempts[task.currentAttemptId];
    if (attempt === undefined)
        return { actorId: '', sessionId: '', attemptId: '' };
    const actor = state.actors[attempt.actorId];
    return { actorId: attempt.actorId, sessionId: attempt.sessionId ?? actor?.sessionId ?? '', attemptId: attempt.attemptId };
}
function unmetDependencies(task, tasks) {
    return task.dependsOn.filter((depId) => {
        const dep = tasks[depId];
        return dep === undefined || dep.status !== 'completed' || dep.validity !== 'current';
    });
}
/** 合并一行的原生面：`cards` 里没有这张卡 = 这一面没读，字段按"未知"缺席处理。 */
function nativeFieldsOf(row, card) {
    if (card === undefined) {
        // 没读原生板时执行面是空的（不是 unknown：unknown 表示"读了但状态对不上词表"）；
        // 验收态仍能从插件记录算出来，所以这里只有 `execution` 与 `native` 退场。
        return {
            execution: '',
            acceptance: acceptanceFromNative(undefined, { validity: row.validity, status: row.status, criteriaSatisfied: row.criteriaSatisfied }).acceptance,
            native: null,
            gateNote: '',
        };
    }
    return {
        execution: card.execution,
        acceptance: card.acceptance,
        native: card.native === undefined ? null : {
            nativeTaskId: card.native.nativeTaskId,
            title: card.native.title ?? '',
            status: card.native.status ?? '',
            assignee: card.native.assignee ?? '',
            revision: card.native.revision ?? null,
            ready: card.native.ready ?? null,
            blockedBy: card.native.blockedBy ?? [],
        },
        gateNote: card.gateNote,
    };
}
/**
 * 一次原生读取 → 合并概览 + 卡片索引（`mergeTaskView` 的结果按 taskId 建索引供任务行贴回）。
 *
 * 只在 `tasks` 真的读到时才合并：读取失败时**不**调 `mergeTaskView`，否则每一行都会拿到
 * `mergeTaskView` 的"读了但对不上"的 gateNote，把"没读到"画成"原生板状态可疑"。
 */
function nativeBoardOf(input, rows) {
    const unavailable = (reason) => ({
        board: { sessionId: input.sessionId, phase: 'unavailable', reason, readTotal: 0, linkedTasks: 0, risks: [], unlinked: [] },
        cards: new Map(),
    });
    const tasks = input.tasks;
    if (tasks === undefined)
        return unavailable(input.reason ?? '调用方没有给出原生任务板读取结果');
    const links = input.links ?? linksFromNativeBoard(tasks, input.sessionId);
    const merged = mergeTaskView({
        pluginTasks: rows.map((row) => ({
            taskId: row.taskId,
            title: row.title,
            status: row.status,
            validity: row.validity,
            criteriaSatisfied: row.criteriaSatisfied,
        })),
        nativeTasks: tasks,
        links,
    });
    // Mission 状态行是台账摘要、不是缺映射的工作项，不能混进"未链接"清单里当噪声。
    const missionRowIds = new Set();
    for (const task of tasks) {
        if (task.id === undefined || task.description === undefined)
            continue;
        const key = markerKeyOf(task.description);
        if (key !== undefined && key.startsWith(`${MISSION_MARKER} `))
            missionRowIds.add(task.id);
    }
    const unlinked = merged.unlinked
        .filter((row) => row.nativeTaskId === undefined || !missionRowIds.has(row.nativeTaskId))
        .map((row) => ({
        nativeTaskId: row.nativeTaskId ?? '',
        title: row.title ?? '',
        status: row.status ?? '',
        assignee: row.assignee ?? '',
    }));
    const cards = new Map(merged.tasks.map((card) => [card.taskId, card]));
    return {
        board: {
            sessionId: input.sessionId,
            phase: 'read',
            reason: '',
            readTotal: tasks.length,
            linkedTasks: merged.tasks.filter((card) => card.native !== undefined).length,
            risks: dependencyRisks(merged),
            unlinked,
        },
        cards,
    };
}
export function missionWorkbench(state, native) {
    const ledger = missionLedger(state);
    const tasks = Object.values(state.tasks).sort(byId);
    const actors = Object.values(state.actors).sort(byActor);
    const attempts = Object.values(state.attempts);
    const baseRows = tasks.map((task) => {
        const owner = ownerOf(state, task);
        const report = ledger.tasks.find((row) => row.taskId === task.taskId);
        return {
            taskId: task.taskId,
            title: task.title,
            status: task.status,
            validity: task.validity,
            priority: task.priority,
            workKind: task.workKind ?? '',
            scope: task.scope,
            ownerActorId: owner.actorId,
            ownerSessionId: owner.sessionId,
            currentAttemptId: owner.attemptId,
            attemptCount: task.attemptCount,
            maxAttempts: task.maxAttempts,
            dependsOn: task.dependsOn.slice(),
            unmetDependencies: unmetDependencies(task, state.tasks),
            resourceKeys: task.resourceKeys.slice(),
            blockedReason: task.blockedReason ?? '',
            criteriaCheck: task.criteriaCheck,
            criteriaSatisfied: report?.criteriaSatisfied ?? false,
            criteriaBlockers: report?.criteriaBlockers ?? [],
            criteria: task.criteria.map((criterion) => ({
                criterionId: criterion.criterionId,
                text: criterion.text,
                required: criterion.required,
                ...criterionOutcome(state, task, criterion),
            })),
            objectiveRevision: task.objectiveRevision,
            specRevision: task.specRevision,
            criteriaRevision: task.criteriaRevision,
            updatedAt: task.updatedAt,
        };
    });
    const nativeResult = native === undefined ? undefined : nativeBoardOf(native, baseRows);
    const nativeBoard = nativeResult === undefined ? null : nativeResult.board;
    const cards = nativeResult?.cards ?? new Map();
    const taskRows = baseRows.map((row) => ({ ...row, ...nativeFieldsOf(row, cards.get(row.taskId)) }));
    const actorRows = actors.map((actor) => ({
        actorId: actor.actorId,
        label: actor.label,
        role: actor.role,
        teamId: actor.teamId ?? '',
        sessionId: actor.sessionId ?? '',
        bindingVersion: actor.bindingVersion,
        retired: actor.retired,
        dormant: actor.dormant,
        available: actor.available,
        waitingFor: actor.waitingFor ?? '',
        liveAttemptIds: attempts
            .filter((attempt) => attempt.actorId === actor.actorId && (attempt.status === 'running' || attempt.status === 'recovering'))
            .map((attempt) => attempt.attemptId)
            .sort(),
    }));
    const sessions = [];
    for (const rotation of Object.values(state.rotations).sort((a, b) => a.rotationId.localeCompare(b.rotationId))) {
        sessions.push({
            sessionId: rotation.targetSessionId,
            actorId: rotation.actorId,
            kind: 'rotation',
            continuationOf: rotation.sourceSessionId,
            rotationId: rotation.rotationId,
            phase: rotation.phase,
        });
    }
    for (const actor of actors) {
        if (actor.sessionId !== undefined && actor.sessionId.length > 0) {
            sessions.push({ sessionId: actor.sessionId, actorId: actor.actorId, kind: 'bound', continuationOf: '', rotationId: '', phase: '' });
        }
    }
    for (const attempt of attempts.slice().sort((a, b) => a.attemptId.localeCompare(b.attemptId))) {
        if (attempt.sessionId === undefined || attempt.sessionId.length === 0)
            continue;
        sessions.push({ sessionId: attempt.sessionId, actorId: attempt.actorId, kind: 'attempt', continuationOf: '', rotationId: '', phase: attempt.status });
    }
    const edges = [];
    for (const task of taskRows) {
        for (const depId of task.dependsOn) {
            edges.push({ kind: 'task-depends', from: depId, to: task.taskId, label: state.tasks[depId]?.title ?? depId });
        }
    }
    for (const team of Object.values(state.teams).sort((a, b) => a.teamId.localeCompare(b.teamId))) {
        for (const memberId of team.memberActorIds.slice().sort()) {
            edges.push({ kind: 'team-member', from: team.teamId, to: memberId, label: state.actors[memberId]?.label ?? memberId });
        }
        edges.push({ kind: 'team-lead', from: team.teamId, to: team.leadActorId, label: state.actors[team.leadActorId]?.label ?? team.leadActorId });
    }
    for (const session of sessions) {
        if (session.continuationOf.length > 0) {
            edges.push({ kind: 'session-continuation', from: session.continuationOf, to: session.sessionId, label: session.rotationId });
        }
    }
    const pendingOutbox = Object.values(state.outbox).filter((entry) => entry.completedAt === undefined);
    const inFlightClaims = pendingOutbox.filter((entry) => entry.claimedAt !== undefined && entry.completedAt === undefined);
    const alerts = [];
    if (state.admissionClosed)
        alerts.push({ code: 'admission_closed', severity: 'warning', message: '业务入场关闭：受管写入需要显式恢复或核对通过后才放行', refs: [state.missionId] });
    const blocked = tasks.filter((task) => task.status === 'blocked');
    if (blocked.length > 0)
        alerts.push({ code: 'tasks_blocked', severity: 'warning', message: `${blocked.length} 个任务处于阻塞，原因记在任务行上`, refs: blocked.map((task) => task.taskId) });
    const suspicious = tasks.filter((task) => task.criteriaCheck === 'suspicious');
    if (suspicious.length > 0)
        alerts.push({ code: 'criteria_suspicious', severity: 'warning', message: '任务书互斥检查报告疑点，派单前需人工裁定', refs: suspicious.map((task) => task.taskId) });
    const needsReview = tasks.filter((task) => task.validity === 'needs_review');
    if (needsReview.length > 0)
        alerts.push({ code: 'validity_needs_review', severity: 'warning', message: '依据被撤回过、待复核的完成项', refs: needsReview.map((task) => task.taskId) });
    if (pendingOutbox.length > 0)
        alerts.push({ code: 'outbox_pending', severity: 'info', message: `外发箱待消费 ${pendingOutbox.length} 条`, refs: pendingOutbox.map((entry) => entry.outboxId) });
    if (inFlightClaims.length > 0)
        alerts.push({ code: 'outbox_claimed_in_flight', severity: 'info', message: '已被领取但未确认落盘：结果未知，需按幂等键核对', refs: inFlightClaims.map((entry) => entry.outboxId) });
    const openRotations = Object.values(state.rotations).filter((rotation) => rotation.phase !== 'ACTIVE');
    if (openRotations.length > 0)
        alerts.push({ code: 'rotation_open', severity: 'warning', message: '轮换未收口，交接后的核对还没走完', refs: openRotations.map((rotation) => rotation.rotationId) });
    const unknownOperations = Object.values(state.operations).filter((op) => op.status === 'outcome_unknown');
    if (unknownOperations.length > 0)
        alerts.push({ code: 'operation_outcome_unknown', severity: 'warning', message: '外部操作结果未知：不能重发，要先核对', refs: unknownOperations.map((op) => op.operationId) });
    // 原生面三条各一条汇总（页面按 `code` 做 React key，同类拆成多行会撞 key；逐条明细在 `native` 区里列）。
    if (nativeBoard !== null && nativeBoard.phase === 'unavailable') {
        alerts.push({ code: 'native_board_unavailable', severity: 'warning', message: `原生任务板没读到：${nativeBoard.reason}；执行状态未知，不等于原生板为空`, refs: [nativeBoard.sessionId] });
    }
    if (nativeBoard !== null && nativeBoard.risks.length > 0) {
        alerts.push({ code: 'native_dependency_risk', severity: 'warning', message: `原生依赖与插件验收态对不上 ${nativeBoard.risks.length} 项：以插件记录为准，逐条见原生板区`, refs: [nativeBoard.sessionId] });
    }
    if (nativeBoard !== null && nativeBoard.unlinked.length > 0) {
        alerts.push({ code: 'native_unlinked_tasks', severity: 'info', message: `原生板上 ${nativeBoard.unlinked.length} 行还没有插件任务链接：执行事实只在原生侧，插件不知道它在干什么`, refs: nativeBoard.unlinked.map((row) => row.nativeTaskId).filter((id) => id !== '') });
    }
    alerts.sort((a, b) => a.code.localeCompare(b.code));
    // 一条会话只出现一次，且优先按信息量大的身份显示：轮换 > 绑定 > 尝试。
    // 「换会话」不是多出一个工作者，同一个 sessionId 更不能既算绑定又算尝试而行数翻倍。
    const sessionPriority = (kind) => kind === 'rotation' ? 0 : kind === 'bound' ? 1 : 2;
    const uniqueSessions = new Map();
    for (const session of sessions) {
        const current = uniqueSessions.get(session.sessionId);
        if (current === undefined || sessionPriority(session.kind) < sessionPriority(current.kind)) {
            uniqueSessions.set(session.sessionId, session);
        }
    }
    return {
        missionId: state.missionId,
        sourceRevision: state.revision,
        generatedAt: state.lastCommittedAt,
        schemaVersion: state.schemaVersion,
        status: state.mission.status,
        objective: state.mission.objective,
        nextStep: ledger.nextStep,
        admissionClosed: state.admissionClosed,
        coverage: {
            included: [
                'mission', 'tasks', 'attempts', 'actors', 'teams', 'rotations', 'verifications', 'operations', 'outbox', 'checkpoints', 'resources',
                ...(nativeBoard !== null && nativeBoard.phase === 'read' ? ['nativeTeamTasks'] : []),
            ],
            unavailable: [
                { face: 'contextOccupancy', reason: '上下文占用是会话侧观测，不在控制记录里；由 dsh-context 适配层单独提供，缺读数时页面显示未知' },
                { face: 'cost', reason: '本包不采集 token 用量，没有任何来源可以证明一个成本数' },
                ...(nativeBoard === null
                    ? [{ face: 'nativeTeamTasks', reason: '调用方没有给出会话定位（页签未绑定会话、Mission 也没有 Lead 会话），原生任务板这一面根本没尝试读取；未知不等于空板' }]
                    : nativeBoard.phase === 'read'
                        ? []
                        : [{ face: 'nativeTeamTasks', reason: `${nativeBoard.reason}；原生执行状态未知，不等于原生板为空` }]),
                { face: 'subagentDerivation', reason: '原生子代理父子关系由宿主观测，控制记录只有 Actor 与会话绑定' },
                { face: 'leaseLapsed', reason: '视图层不取墙钟；租约行给出 leaseExpiresAt，由客户端时钟比较' },
            ],
        },
        counts: {
            taskTotal: tasks.length,
            completedNow: taskRows.filter((task) => task.status === 'completed' && task.validity === 'current').length,
            blocked: blocked.length,
            needsReview: needsReview.length,
            submitted: tasks.filter((task) => task.status === 'submitted').length,
            running: attempts.filter((attempt) => attempt.status === 'running').length,
            failed: tasks.filter((task) => task.status === 'failed').length,
            cancelled: tasks.filter((task) => task.status === 'cancelled').length,
            actorTotal: actors.length,
            sessionTotal: uniqueSessions.size,
        },
        tasks: taskRows,
        actors: actorRows,
        sessions: [...uniqueSessions.values()].sort((a, b) => `${a.kind}:${a.actorId}:${a.sessionId}`.localeCompare(`${b.kind}:${b.actorId}:${b.sessionId}`)),
        edges,
        alerts,
        native: nativeBoard,
        ledger,
    };
}
