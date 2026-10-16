import { INEFFECTIVE_RESULTS, TASK_TERMINAL } from './entities.js';
import { commit, mintId, put } from './control.js';
function refused(state, reason) {
    return { applied: false, state, reason };
}
function blank(text) {
    return text === undefined || text.trim().length === 0;
}
/** 某引用是否能落到一条可核对的记录上（证据 / 结论 / 试验 / 契约）。 */
function resolvedRef(state, ref) {
    return (state.evidence[ref] !== undefined ||
        state.claims[ref] !== undefined ||
        state.trials[ref] !== undefined ||
        state.experiments[ref] !== undefined);
}
function claimHead(state, claimId) {
    return state.claims[claimId]?.at(-1);
}
/** 试验契约版本链的当前版本；没有登记过返回 undefined。 */
export function experimentHead(state, experimentId) {
    return state.experiments[experimentId]?.at(-1);
}
// ————————————————————————————————————————————————————————————————
// §25.2 双轨工作与探索额度：workKind 只是调度分类，不创建新的执行状态机。
// ————————————————————————————————————————————————————————————————
export function taskWorkKind(state, taskId) {
    return state.tasks[taskId]?.workKind;
}
/**
 * 标注任务的工作分类（§25.2）。
 *
 * 只写 `workKind` 与 `updatedAt`：任务状态、判定有效性、任务书/判据版本一律不动——
 * 分类服务调度与额度，不参与状态机。终态任务不再被调度，回写分类只制造台账噪声。
 */
export function classifyTaskWork(state, taskId, workKind, now) {
    const task = state.tasks[taskId];
    if (task === undefined)
        return refused(state, `任务 ${taskId} 不在记录里，无法标注工作分类`);
    if (TASK_TERMINAL.includes(task.status))
        return refused(state, `任务 ${taskId} 已处于终态（${task.status}）：分类只服务于调度与额度，不再回写终态任务（§25.2）`);
    if (task.workKind === workKind)
        return refused(state, `任务 ${taskId} 已是 ${workKind}：重复标注不产生进展`);
    const tasks = put(state.tasks, taskId, { ...task, workKind, updatedAt: now });
    return {
        applied: true,
        state: commit({ ...state, tasks }, 'experiment/work_kind', { taskId, workKind }, now),
        reason: `任务 ${taskId} 标注为 ${workKind}（只影响调度与额度，不改任务状态机，§25.2）`,
    };
}
export function explorationEntitlement(state, taskId) {
    const task = state.tasks[taskId];
    const policy = state.mission.exploration;
    const enabled = policy !== undefined;
    const released = policy?.reserveReleasedAt !== undefined;
    if (task === undefined) {
        return { ok: false, drawsOnReservation: false, reservationEnabled: enabled, reservationReleased: released, reason: `任务 ${taskId} 不在记录里` };
    }
    const draws = task.workKind === 'explore' || task.workKind === 'improve';
    if (task.workKind === undefined) {
        return { ok: true, drawsOnReservation: false, reservationEnabled: enabled, reservationReleased: released, reason: '任务未分类：按常规预算调度，不占用探索预留（§25.2）' };
    }
    if (!draws) {
        return {
            ok: true,
            workKind: task.workKind,
            drawsOnReservation: false,
            reservationEnabled: enabled,
            reservationReleased: released,
            reason: `${task.workKind} 不走探索预留：低成本试验与高影响发布/验收分开记账（§25.2）`,
        };
    }
    if (!enabled) {
        return { ok: true, workKind: task.workKind, drawsOnReservation: true, reservationEnabled: false, reservationReleased: false, reason: '未启用探索预留：探索任务按既有授权执行，不另开额度（§25.2）' };
    }
    if (released) {
        return {
            ok: true,
            workKind: task.workKind,
            drawsOnReservation: true,
            reservationEnabled: true,
            reservationReleased: true,
            reason: `探索预留已释放（${policy?.releaseReason ?? '未写理由'}）：按 releaseRecheck 的条件在里程碑复核（§25.2）`,
        };
    }
    return { ok: true, workKind: task.workKind, drawsOnReservation: true, reservationEnabled: true, reservationReleased: false, reason: `可占用探索预留（reserveShare=${policy?.reserveShare ?? '未设定'}）` };
}
/** 登记（或校准）探索策略；只改 Mission 上的策略字段，不动总预算。 */
export function registerExplorationPolicy(state, registration, now, actorId) {
    const share = registration.reserveShare;
    if (!Number.isFinite(share) || share <= 0 || share > 1) {
        return refused(state, `探索份额要在 (0, 1] 内（收到 ${share}）：额度来自 Mission 既有授权与总预算，不能另开无限探索账（§25.2）`);
    }
    if (blank(registration.minDiscernibleTrial)) {
        return refused(state, '缺最小可辨别试验：低于它的动作不足以支持"学到/没学到"的判断（§25.2）');
    }
    if (registration.maxTrialCost === undefined || blank(registration.maxTrialCost.note)) {
        return refused(state, '缺最高试验成本口径：登记探索策略要能核对单次试验上限（§25.2）');
    }
    if (registration.maxTrialCost.tokens === undefined && registration.maxTrialCost.calls === undefined) {
        return refused(state, '最高试验成本要有 tokens 或 calls 至少一维，不能只是一句承诺（§25.2）');
    }
    if (registration.reviewTriggers.length === 0) {
        return refused(state, '缺复核触发器：探索预留必须有预先声明的复核条件（§25.2）');
    }
    if (registration.deadlineAt !== undefined && registration.deadlineAt <= now) {
        return refused(state, `截止时间 ${registration.deadlineAt} 不晚于当前 ${now}：登记后要留出可执行窗口（§25.2）`);
    }
    const wildcard = registration.wildcardProbeAllowance;
    if (wildcard !== undefined) {
        if (blank(wildcard.note))
            return refused(state, 'wildcard 探测额度要写口径备注（§31.4）');
        if (wildcard.tokens === undefined && wildcard.calls === undefined) {
            return refused(state, 'wildcard 探测额度要有 tokens 或 calls 至少一维：有界额度不能只是一句承诺（§31.4）');
        }
    }
    const previous = state.mission.exploration;
    const policy = {
        reserveShare: share,
        maxTrialCost: registration.maxTrialCost,
        minDiscernibleTrial: registration.minDiscernibleTrial,
        reviewTriggers: registration.reviewTriggers,
        deadlineAt: registration.deadlineAt,
        utilityConstraint: registration.utilityConstraint,
        wildcardProbeAllowance: wildcard,
        // 重新登记不抹掉上一次释放记录：释放的理由与复核条件继续可见。
        reserveReleasedAt: previous?.reserveReleasedAt,
        releaseReason: previous?.releaseReason,
        releaseRecheck: previous?.releaseRecheck,
        updatedBy: actorId,
        updatedAt: now,
    };
    const mission = { ...state.mission, exploration: policy, updatedAt: now };
    return {
        applied: true,
        state: commit({ ...state, mission }, 'experiment/exploration.registered', { reserveShare: share, wildcard: wildcard !== undefined, deadlineAt: registration.deadlineAt ?? null }, now),
        reason: '探索策略已登记：额度在既有总预算内，单次试验按 maxTrialCost 核对（§25.2）',
    };
}
/**
 * 释放探索预留（§25.2）：资源短缺、交付临近或没有合格候选时允许释放，
 * 但必须记录理由与复核条件——释放不是"以后不再看"。
 */
export function releaseExplorationReservation(state, input, now, actorId) {
    const policy = state.mission.exploration;
    if (policy === undefined)
        return refused(state, '尚未登记探索策略：没有预留可释放（§25.2）');
    if (policy.reserveReleasedAt !== undefined) {
        return refused(state, `预留已于 ${policy.reserveReleasedAt} 释放（理由：${policy.releaseReason ?? '未写'}）：重复释放只留台账噪声`);
    }
    if (blank(input.reason))
        return refused(state, '释放预留要写明理由（资源短缺 / 交付临近 / 没有合格候选）（§25.2）');
    if (blank(input.recheck))
        return refused(state, '释放预留要写明复核条件：什么时候在里程碑重看预留（§25.2）');
    const next = { ...policy, reserveReleasedAt: now, releaseReason: input.reason, releaseRecheck: input.recheck, updatedBy: actorId, updatedAt: now };
    const mission = { ...state.mission, exploration: next, updatedAt: now };
    return {
        applied: true,
        state: commit({ ...state, mission }, 'experiment/exploration.released', { reason: input.reason, recheck: input.recheck }, now),
        reason: '探索预留已释放：理由与复核条件都已记录（§25.2）',
    };
}
/**
 * 复核结论是"预留仍可用"时重新占用（§25.2）。释放记录本身不丢：
 * 旧值保留在事件流里，当前视图回到未释放。
 */
export function restoreExplorationReservation(state, input, now, actorId) {
    const policy = state.mission.exploration;
    if (policy === undefined)
        return refused(state, '尚未登记探索策略：没有预留可恢复（§25.2）');
    if (policy.reserveReleasedAt === undefined)
        return refused(state, '预留未被释放，无需恢复');
    if (blank(input.reason))
        return refused(state, '恢复预留要写明复核结论：按 releaseRecheck 的条件核对到了什么（§25.2）');
    const next = {
        reserveShare: policy.reserveShare,
        maxTrialCost: policy.maxTrialCost,
        minDiscernibleTrial: policy.minDiscernibleTrial,
        reviewTriggers: policy.reviewTriggers,
        deadlineAt: policy.deadlineAt,
        utilityConstraint: policy.utilityConstraint,
        wildcardProbeAllowance: policy.wildcardProbeAllowance,
        updatedBy: actorId,
        updatedAt: now,
    };
    const mission = { ...state.mission, exploration: next, updatedAt: now };
    return {
        applied: true,
        state: commit({ ...state, mission }, 'experiment/exploration.restored', { reason: input.reason, previousRelease: policy.releaseReason ?? null, previousRecheck: policy.releaseRecheck ?? null }, now),
        reason: '探索预留已重新占用：复核结论记录在案（§25.2）',
    };
}
export function explorationPulse(state, now) {
    const policy = state.mission.exploration;
    const wildcardExperimentIds = Object.values(state.experiments)
        .map((chain) => chain.at(-1))
        .filter((spec) => spec !== undefined && spec.wildcard === true)
        .map((spec) => spec.experimentId)
        .sort();
    if (policy === undefined) {
        return {
            configured: false,
            released: false,
            deadlinePassed: false,
            reviewTriggers: [],
            wildcardExperimentIds,
            due: false,
            reason: '未启用探索预留（缺省即无预留）：一次性修复任务不强迫"为了创新再试一条路线"（§25.2）',
        };
    }
    const deadlinePassed = policy.deadlineAt !== undefined && now >= policy.deadlineAt;
    const released = policy.reserveReleasedAt !== undefined;
    const reason = deadlinePassed
        ? `已过截止时间 ${policy.deadlineAt}：复核继续 / 释放 / 收尾（§25.2）`
        : released
            ? `预留已释放（${policy.releaseReason ?? '未写理由'}）：按复核条件重看（§25.2）`
            : `预留有效：按 reviewTriggers 触发复核（${policy.reviewTriggers.join(' / ')}）（§25.2）`;
    return {
        configured: true,
        reserveShare: policy.reserveShare,
        released,
        releasedAt: policy.reserveReleasedAt,
        releaseReason: policy.releaseReason,
        releaseRecheck: policy.releaseRecheck,
        deadlineAt: policy.deadlineAt,
        deadlinePassed,
        reviewTriggers: policy.reviewTriggers,
        wildcardAllowance: policy.wildcardProbeAllowance,
        wildcardExperimentIds,
        due: deadlinePassed || released,
        reason,
    };
}
/**
 * §31.4：wildcard 探测必须落在 `wildcardProbeAllowance` 内，不增加总预算。
 * 额度按任务授权与资源配置；新颖不是追加预算的充分理由。
 */
export function wildcardProbeAllowanceCheck(state, plannedCost) {
    const policy = state.mission.exploration;
    if (policy === undefined)
        return { ok: false, reason: '未启用探索预留：wildcard 探测没有额度来源（§31.4）' };
    if (policy.reserveReleasedAt !== undefined) {
        return { ok: false, reason: `探索预留已释放（${policy.releaseReason ?? '未写理由'}）：wildcard 探测无可用额度，先复核预留（§25.2、§31.4）` };
    }
    const allowance = policy.wildcardProbeAllowance;
    if (allowance === undefined)
        return { ok: false, reason: '策略没有 wildcardProbeAllowance：新颖猜想要先有有界机会才能探测（§31.4）' };
    if (allowance.tokens === undefined && allowance.calls === undefined) {
        return { ok: false, reason: 'wildcard 额度没有 tokens/calls 量纲，无法核对"有界"（§31.4）' };
    }
    const comparable = (allowance.tokens !== undefined && plannedCost.tokens !== undefined) || (allowance.calls !== undefined && plannedCost.calls !== undefined);
    if (!comparable)
        return { ok: false, reason: '预估成本与 wildcard 额度口径对不上（tokens/calls 至少要有一维可比），先补齐口径（§31.4）' };
    if (allowance.tokens !== undefined && plannedCost.tokens !== undefined && plannedCost.tokens > allowance.tokens) {
        return { ok: false, reason: `预估 tokens ${plannedCost.tokens} 超过 wildcard 额度 ${allowance.tokens}：不允许从总预算里补齐（§31.4）` };
    }
    if (allowance.calls !== undefined && plannedCost.calls !== undefined && plannedCost.calls > allowance.calls) {
        return { ok: false, reason: `预估 calls ${plannedCost.calls} 超过 wildcard 额度 ${allowance.calls}：有界额度不追加预算（§31.4）` };
    }
    return { ok: true, reason: `在有界额度内（${allowance.note}）：不增加总预算（§31.4）` };
}
// ————————————————————————————————————————————————————————————————
// §25.3 试验契约：阶段目标 / 比较成本 / 停止条件先定，调整留版本。
// ————————————————————————————————————————————————————————————————
/** 逐级增加投入的阶段（§25.3）：早期原型不在最终值上被永久淘汰，也不能无限用"不成熟"解释失败。 */
export const EXPERIMENT_STAGES = ['executable', 'small_scale_validity', 'comparable_baseline', 'robustness_integration', 'publish'];
/**
 * 预登记试验契约 v1（§25.3）：先定阶段目标、比较口径与停止条件，再开跑。
 * 常规试验必须有比较基线；证据薄弱的新颖猜想走 wildcard 探测才可豁免基线（§31.4）。
 */
export function preregisterExperiment(state, draft, now, actorId) {
    if (blank(draft.routeFamilyId))
        return refused(state, '缺路线族 ID：只改名称不算新路线，先写清候选属于哪个路线族（§25.3）');
    if (blank(draft.problem))
        return refused(state, '缺问题定义：试验要回答什么（§25.3）');
    if (blank(draft.userUtility))
        return refused(state, '缺用户效用：试验与任务效用的关系不能空着（§25.3）');
    if (blank(draft.candidateMechanism))
        return refused(state, '缺候选机制（§25.3）');
    if (blank(draft.differenceFromCurrent))
        return refused(state, '缺与现路线的实质差异：只改名称不算新路线（§25.3）');
    if (draft.candidateMechanism.trim() === draft.differenceFromCurrent.trim()) {
        return refused(state, '差异字段与候选机制同名：只改名称不算新路线（§25.3）');
    }
    if (blank(draft.testedHypothesis))
        return refused(state, '缺可检验假设（§25.3）');
    if (blank(draft.observable))
        return refused(state, '缺可观察的假设：探测要求能获得某种可解释观测（§25.3、§31.1）');
    if (blank(draft.decisionImpact))
        return refused(state, '缺决策影响：要写明什么结果会改变后续选择（§25.3）');
    if (draft.stopConditions.length === 0)
        return refused(state, '缺停止条件：阶段目标与停止条件要在看到结果前确定（§25.3）');
    if (blank(draft.budgetCapNote))
        return refused(state, '缺预算上限：试验要能对照探索策略里的 maxTrialCost（§25.3）');
    if (blank(draft.minViableTrial))
        return refused(state, '缺最小有效试验：低于它不足以支持"学到/没学到"（§25.3）');
    if (blank(draft.riskBoundary))
        return refused(state, '缺风险边界（§25.3）');
    if (blank(draft.treatmentNote))
        return refused(state, '缺实际处理说明：DG-11 要求先写清这次到底施加了什么（§22.11）');
    if (draft.criteria.length === 0)
        return refused(state, '缺主要判据：比较要在事先声明的判据下进行（§25.3）');
    if (draft.validatorRefs.length === 0)
        return refused(state, '缺验证器引用：可比基准要有验证器版本（§25.3）');
    const wildcard = draft.wildcard === true;
    if (!wildcard && blank(draft.baselineRef))
        return refused(state, '缺比较基线及版本：常规试验要与现路线同口径比较（§25.3）');
    if (draft.taskId !== undefined) {
        const host = state.tasks[draft.taskId];
        if (host === undefined)
            return refused(state, `任务 ${draft.taskId} 不在记录里，不能作试验宿主`);
        if (host.workKind === 'deliver')
            return refused(state, `任务 ${draft.taskId} 分类为 deliver：交付任务不是试验宿主，先改分类或换宿主（§25.2）`);
    }
    const policy = state.mission.exploration;
    const planned = draft.plannedCost;
    if (policy?.maxTrialCost !== undefined && planned === undefined) {
        return refused(state, '已登记探索策略：试验要先报预估成本，才能与 maxTrialCost 对照（§25.2）');
    }
    if (policy?.maxTrialCost !== undefined && planned !== undefined) {
        const cap = policy.maxTrialCost;
        if (cap.tokens !== undefined && planned.tokens !== undefined && planned.tokens > cap.tokens) {
            return refused(state, `预估 tokens ${planned.tokens} 超过最高试验成本 ${cap.tokens}（${cap.note}）（§25.2）`);
        }
        if (cap.calls !== undefined && planned.calls !== undefined && planned.calls > cap.calls) {
            return refused(state, `预估 calls ${planned.calls} 超过最高试验成本 ${cap.calls}（${cap.note}）（§25.2）`);
        }
    }
    if (wildcard) {
        const verdict = wildcardProbeAllowanceCheck(state, planned ?? {});
        if (!verdict.ok)
            return refused(state, `wildcard 探测被拒：${verdict.reason}`);
    }
    const experimentId = draft.experimentId ?? mintId('exp');
    const spec = {
        experimentId,
        version: 1,
        missionId: state.missionId,
        taskId: draft.taskId,
        routeFamilyId: draft.routeFamilyId,
        problem: draft.problem,
        userUtility: draft.userUtility,
        candidateMechanism: draft.candidateMechanism,
        differenceFromCurrent: draft.differenceFromCurrent,
        testedHypothesis: draft.testedHypothesis,
        observable: draft.observable,
        unknowns: draft.unknowns ?? [],
        decisionImpact: draft.decisionImpact,
        baselineRef: draft.baselineRef,
        baselineVersion: draft.baselineVersion,
        inputRefs: draft.inputRefs ?? [],
        dataSplit: draft.dataSplit,
        environment: draft.environment,
        codeParamsNote: draft.codeParamsNote,
        treatmentNote: draft.treatmentNote,
        validatorRefs: draft.validatorRefs,
        criteria: draft.criteria,
        requiredConditions: draft.requiredConditions ?? [],
        exploratoryAssumptions: draft.exploratoryAssumptions ?? [],
        budgetCapNote: draft.budgetCapNote,
        minViableTrial: draft.minViableTrial,
        stopConditions: draft.stopConditions,
        riskBoundary: draft.riskBoundary,
        isolation: draft.isolation,
        stage: 'executable',
        wildcard: wildcard ? true : undefined,
        preregisteredAt: now,
        authorActorId: actorId,
        createdAt: now,
    };
    const experiments = put(state.experiments, experimentId, [spec]);
    return {
        applied: true,
        state: commit({ ...state, experiments }, 'experiment/preregistered', { experimentId, routeFamilyId: draft.routeFamilyId, wildcard, stage: 'executable', version: 1 }, now),
        reason: `试验契约 v1 已预登记（stage=executable；阶段目标与停止条件已先定）（§25.3）`,
        experimentId,
        version: 1,
        wildcard,
    };
}
/**
 * 修订试验契约（§25.3）：追加新版本并保留旧版本，理由必填。
 * 结果登记之后的修订允许，但回执会标 `postResults`——不能靠悄悄改停止条件把试验"改成成功"。
 */
export function reviseExperiment(state, experimentId, revision, now, actorId) {
    const chain = state.experiments[experimentId];
    const head = chain?.at(-1);
    if (chain === undefined || head === undefined)
        return refused(state, `试验 ${experimentId} 不在记录里`);
    if (blank(revision.reason))
        return refused(state, '修订要写明理由并在时间线上留版本：阶段目标 / 成本 / 停止条件的调整不能悄悄改（§25.3）');
    if (head.stage === 'publish')
        return refused(state, `试验 ${experimentId} 已到 publish 阶段：发布过的契约不原地修订，另开新试验（§25.3）`);
    const blanks = [
        ['problem', revision.problem],
        ['userUtility', revision.userUtility],
        ['candidateMechanism', revision.candidateMechanism],
        ['differenceFromCurrent', revision.differenceFromCurrent],
        ['testedHypothesis', revision.testedHypothesis],
        ['observable', revision.observable],
        ['decisionImpact', revision.decisionImpact],
        ['treatmentNote', revision.treatmentNote],
        ['budgetCapNote', revision.budgetCapNote],
        ['minViableTrial', revision.minViableTrial],
        ['riskBoundary', revision.riskBoundary],
    ].find(([, value]) => value !== undefined && blank(value));
    if (blanks !== undefined)
        return refused(state, `修订把 ${blanks[0]} 改成空值：先写清内容再留版本（§25.3）`);
    if (revision.stopConditions !== undefined && revision.stopConditions.length === 0)
        return refused(state, '修订不能清空停止条件：看到结果后把停止条件拿掉等于取消预登记（§25.3）');
    if (revision.criteria !== undefined && revision.criteria.length === 0)
        return refused(state, '修订不能清空主要判据（§25.3）');
    if (revision.validatorRefs !== undefined && revision.validatorRefs.length === 0)
        return refused(state, '修订不能清空验证器引用：比较口径要有验证器版本（§25.3）');
    const merged = {
        ...head,
        ...(revision.problem === undefined ? {} : { problem: revision.problem }),
        ...(revision.userUtility === undefined ? {} : { userUtility: revision.userUtility }),
        ...(revision.candidateMechanism === undefined ? {} : { candidateMechanism: revision.candidateMechanism }),
        ...(revision.differenceFromCurrent === undefined ? {} : { differenceFromCurrent: revision.differenceFromCurrent }),
        ...(revision.testedHypothesis === undefined ? {} : { testedHypothesis: revision.testedHypothesis }),
        ...(revision.observable === undefined ? {} : { observable: revision.observable }),
        ...(revision.unknowns === undefined ? {} : { unknowns: revision.unknowns }),
        ...(revision.decisionImpact === undefined ? {} : { decisionImpact: revision.decisionImpact }),
        ...(revision.baselineRef === undefined ? {} : { baselineRef: revision.baselineRef }),
        ...(revision.baselineVersion === undefined ? {} : { baselineVersion: revision.baselineVersion }),
        ...(revision.inputRefs === undefined ? {} : { inputRefs: revision.inputRefs }),
        ...(revision.dataSplit === undefined ? {} : { dataSplit: revision.dataSplit }),
        ...(revision.environment === undefined ? {} : { environment: revision.environment }),
        ...(revision.codeParamsNote === undefined ? {} : { codeParamsNote: revision.codeParamsNote }),
        ...(revision.treatmentNote === undefined ? {} : { treatmentNote: revision.treatmentNote }),
        ...(revision.validatorRefs === undefined ? {} : { validatorRefs: revision.validatorRefs }),
        ...(revision.criteria === undefined ? {} : { criteria: revision.criteria }),
        ...(revision.requiredConditions === undefined ? {} : { requiredConditions: revision.requiredConditions }),
        ...(revision.exploratoryAssumptions === undefined ? {} : { exploratoryAssumptions: revision.exploratoryAssumptions }),
        ...(revision.budgetCapNote === undefined ? {} : { budgetCapNote: revision.budgetCapNote }),
        ...(revision.minViableTrial === undefined ? {} : { minViableTrial: revision.minViableTrial }),
        ...(revision.stopConditions === undefined ? {} : { stopConditions: revision.stopConditions }),
        ...(revision.riskBoundary === undefined ? {} : { riskBoundary: revision.riskBoundary }),
        ...(revision.isolation === undefined ? {} : { isolation: revision.isolation }),
        version: head.version + 1,
        supersedesVersion: head.version,
        createdAt: now,
        authorActorId: actorId,
    };
    const postResults = Object.values(state.trials).some((trial) => trial.experimentId === experimentId);
    const experiments = put(state.experiments, experimentId, [...chain, merged]);
    return {
        applied: true,
        state: commit({ ...state, experiments }, 'experiment/revised', { experimentId, version: merged.version, supersedesVersion: head.version, reason: revision.reason, postResults }, now),
        reason: `试验契约推进到 v${merged.version}（${postResults ? '结果已登记，修订按事后视角复核' : '结果登记前的调整'}）（§25.3）`,
        version: merged.version,
        postResults,
    };
}
function stageGate(head, to, trials) {
    const has = (predicate) => trials.some(predicate);
    if (to === 'small_scale_validity') {
        if (!has((trial) => trial.execution === 'completed' && trial.treatmentApplied === 'yes')) {
            return { ok: false, reason: '先跑通一次执行完成且实际处理生效的试验：未施加干预不算可执行（DG-11）' };
        }
        return { ok: true, reason: '' };
    }
    if (to === 'comparable_baseline') {
        if (blank(head.baselineRef))
            return { ok: false, reason: '契约缺比较基线：基线不可比的试验进不了可比基准（§25.3）' };
        if (!has((trial) => trial.execution === 'completed' && trial.treatmentApplied === 'yes' && trial.evaluationValidity === 'valid')) {
            return { ok: false, reason: '没有一次评价有效的试验：评价无效不足以支持比较（§26.1）' };
        }
        return { ok: true, reason: '' };
    }
    if (to === 'robustness_integration') {
        if (!has((trial) => trial.evaluationValidity === 'valid' && trial.treatmentApplied === 'yes' && (trial.observed === 'target_met' || trial.observed === 'partial_improvement'))) {
            return { ok: false, reason: '扩大投入要有阶段证据：先出现一次有效评价下的目标达成或局部改善（§31.1）' };
        }
        return { ok: true, reason: '' };
    }
    if (head.criteria.length === 0)
        return { ok: false, reason: '发布要有对应验收：契约缺主要判据（§31.1）' };
    if (!has((trial) => trial.treatmentApplied === 'yes' && trial.evaluationValidity === 'valid' && trial.observed === 'target_met')) {
        return { ok: false, reason: '发布要在有效评价下达到目标；授权仍由命令边界核对（§31.1、§31.6）' };
    }
    return { ok: true, reason: '' };
}
/** 阶段推进（§25.3）：逐级增加投入，跳级与证据不足都拒绝。 */
export function advanceExperimentStage(state, experimentId, to, evidence, now, actorId) {
    const chain = state.experiments[experimentId];
    const head = chain?.at(-1);
    if (chain === undefined || head === undefined)
        return refused(state, `试验 ${experimentId} 不在记录里`);
    const index = EXPERIMENT_STAGES.indexOf(head.stage);
    const next = index < 0 ? undefined : EXPERIMENT_STAGES[index + 1];
    if (next === undefined)
        return refused(state, `试验 ${experimentId} 已在 ${head.stage}：没有后续阶段，发布后的变更另开试验（§25.3）`);
    if (to !== next)
        return refused(state, `阶段要逐级推进：${head.stage} 的下一级是 ${next}，不能跳到 ${to}（§25.3）`);
    if (blank(evidence.note))
        return refused(state, '阶段推进要写明依据：扩大投入要求阶段证据（§31.1）');
    let pool = Object.values(state.trials).filter((trial) => trial.experimentId === experimentId);
    if (evidence.witnessTrialIds !== undefined) {
        const witnesses = [];
        for (const trialId of evidence.witnessTrialIds) {
            const trial = state.trials[trialId];
            if (trial === undefined)
                return refused(state, `阶段证据引用 ${trialId} 不在记录里：不能拿未登记的结果当门槛证据（§25.3）`);
            if (trial.experimentId !== experimentId)
                return refused(state, `试验 ${trialId} 属于 ${trial.experimentId}，不是本试验的阶段证据`);
            witnesses.push(trial);
        }
        if (witnesses.length === 0)
            return refused(state, 'witnessTrialIds 是空列表：要么列出具体试验，要么不传、按全部记录核对');
        pool = witnesses;
    }
    const gate = stageGate(head, to, pool);
    if (!gate.ok)
        return refused(state, `${head.stage} → ${to} 被拒：${gate.reason}`);
    const merged = { ...head, stage: to, version: head.version + 1, supersedesVersion: head.version, createdAt: now, authorActorId: actorId };
    const experiments = put(state.experiments, experimentId, [...chain, merged]);
    return {
        applied: true,
        state: commit({ ...state, experiments }, 'experiment/stage_advanced', { experimentId, from: head.stage, to, witnessTrialIds: evidence.witnessTrialIds ?? [], note: evidence.note }, now),
        reason: `阶段推进 ${head.stage} → ${to}（§25.3）`,
        version: merged.version,
        from: head.stage,
        stage: to,
    };
}
/**
 * 登记试验结果（§26.1）：四层（执行 / 评价 / 观测 / 结论线索）分开存，
 * 引用要能落到真实记录上；"未施加干预却有方向性观测"在登记层就拒绝（DG-11）。
 */
export function recordTrial(state, draft, now, actorId) {
    const chain = state.experiments[draft.experimentId];
    if (chain === undefined)
        return refused(state, `试验 ${draft.experimentId} 不在记录里：结果必须挂在已预登记的契约上（§25.3）`);
    if (!chain.some((spec) => spec.version === draft.experimentVersion)) {
        return refused(state, `契约版本 v${draft.experimentVersion} 不在版本链里：结果要绑定它实际运行时的契约版本（§25.3）`);
    }
    if (draft.taskId !== undefined && state.tasks[draft.taskId] === undefined) {
        return refused(state, `任务 ${draft.taskId} 不在记录里，试验结果不能挂到不存在的宿主上`);
    }
    if (draft.treatmentApplied === 'no' && (draft.observed === 'target_met' || draft.observed === 'partial_improvement' || draft.observed === 'lower_than_baseline')) {
        return refused(state, `treatmentApplied=no 却观测到方向性结果（${draft.observed}）：先核对实际处理与混杂；机制未进入输出不能算机制证据（DG-11）`);
    }
    for (const ref of draft.operationRefs ?? []) {
        if (state.operations[ref] === undefined)
            return refused(state, `操作回执 ${ref} 不在记录里：失败记录要绑定真实回执，不能编造引用（§26.1）`);
    }
    for (const ref of draft.evidenceRefs ?? []) {
        if (state.evidence[ref] === undefined)
            return refused(state, `证据 ${ref} 不在记录里：结果要绑定已登记的证据（§26.1）`);
    }
    for (const ref of draft.claimRefs ?? []) {
        if (state.claims[ref] === undefined)
            return refused(state, `结论 ${ref} 不在记录里：结果引用的结论要先登记（§26.1）`);
    }
    const trialId = draft.trialId ?? mintId('tri');
    const trial = {
        trialId,
        missionId: state.missionId,
        experimentId: draft.experimentId,
        experimentVersion: draft.experimentVersion,
        taskId: draft.taskId,
        attemptId: draft.attemptId,
        operationRefs: draft.operationRefs ?? [],
        execution: draft.execution,
        treatmentApplied: draft.treatmentApplied,
        evaluationValidity: draft.evaluationValidity,
        observed: draft.observed,
        observedNote: draft.observedNote,
        criticalDownstreamActions: draft.criticalDownstreamActions,
        claimRefs: draft.claimRefs ?? [],
        evidenceRefs: draft.evidenceRefs ?? [],
        environment: draft.environment,
        inputVersions: draft.inputVersions ?? [],
        codeVersions: draft.codeVersions ?? [],
        validatorRefs: draft.validatorRefs ?? [],
        baselineRef: draft.baselineRef,
        budgetSpentNote: draft.budgetSpentNote,
        confounders: draft.confounders ?? [],
        unknowns: draft.unknowns ?? [],
        recordedBy: actorId,
        createdAt: now,
    };
    const trials = put(state.trials, trialId, trial);
    return {
        applied: true,
        state: commit({ ...state, trials }, 'experiment/trial.recorded', {
            trialId,
            experimentId: draft.experimentId,
            version: draft.experimentVersion,
            execution: draft.execution,
            treatmentApplied: draft.treatmentApplied,
            evaluationValidity: draft.evaluationValidity,
            observed: draft.observed,
        }, now),
        reason: '四层结果已分别登记（§26.1）',
        trialId,
    };
}
/** 该试验能不能支撑比较（§26.1）：执行完成、评价有效、干预生效三者缺一不可。 */
export function trialCanSupportComparison(state, trialId) {
    const trial = state.trials[trialId];
    if (trial === undefined)
        return { ok: false, reason: `试验 ${trialId} 不在记录里` };
    if (trial.execution !== 'completed')
        return { ok: false, reason: `执行层为 ${trial.execution}：工具未正常完成只证明本次执行没做完（§26.1）` };
    if (trial.evaluationValidity !== 'valid')
        return { ok: false, reason: `评价层为 ${trial.evaluationValidity}：评价不足以支持比较（§26.1）` };
    if (trial.treatmentApplied !== 'yes')
        return { ok: false, reason: `实际处理为 ${trial.treatmentApplied}：机制未进入输出，不能当机制证据（DG-11）` };
    return { ok: true, reason: '执行完成、评价有效、干预已生效：可支撑当次条件下的比较' };
}
export function conclusionScope(state, trialId) {
    const trial = state.trials[trialId];
    if (trial === undefined) {
        return { ok: false, reason: `试验 ${trialId} 不在记录里`, statement: '', implementationVersions: [], confounders: [], unknowns: [], limitation: '' };
    }
    const comparability = trialCanSupportComparison(state, trialId);
    const environment = trial.environment ?? '未标注环境';
    const implementation = trial.codeVersions.length === 0 ? '未标注实现版本' : trial.codeVersions.join(' / ');
    const budget = trial.budgetSpentNote ?? '未记录预算';
    const confound = trial.confounders.length === 0 ? '未记录混杂' : `仍存在混杂：${trial.confounders.join(' / ')}`;
    return {
        ok: comparability.ok,
        reason: comparability.reason,
        statement: `本次在环境 ${environment}、实现 ${implementation}、预算 ${budget} 下观测到 ${trial.observed}；${confound}（§26.1）`,
        environment: trial.environment,
        implementationVersions: trial.codeVersions,
        budgetNote: trial.budgetSpentNote,
        confounders: trial.confounders,
        unknowns: trial.unknowns,
        limitation: comparability.ok
            ? '结论只约束当次条件；更广的否定需要覆盖关键条件的重复检验或明确前提下的逻辑反证（§26.1）'
            : `本次结果不足以支撑比较（${comparability.reason}），只能记录执行 / 评价层事实（§26.1）`,
    };
}
/**
 * 防过早否定（§26.2、R05）：不允许用"未生效 / 评价无效 / 单次负结果"关闭方向。
 * `proposedScope='route'` 时额外要求：至少两次可比较试验且无未排除混杂。
 */
export function prematureNegationCheck(state, input) {
    const trial = state.trials[input.trialId];
    if (trial === undefined)
        return { blocked: true, reason: `试验 ${input.trialId} 不在记录里：不能拿不存在的记录做否定结论` };
    if (trial.observed !== 'lower_than_baseline' && trial.observed !== 'no_reliable_difference') {
        return { blocked: false, reason: `本次观测（${trial.observed}）本身不是负结论（§26.2）` };
    }
    const comparability = trialCanSupportComparison(state, input.trialId);
    if (!comparability.ok)
        return { blocked: true, reason: `不能据此否定方向：${comparability.reason}（§26.2）` };
    if (input.proposedScope === 'trial')
        return { blocked: false, reason: '单次负结果可以按当次条件登记；更广结论需要额外证据（§26.1）' };
    const comparableCount = Object.values(state.trials).filter((candidate) => candidate.experimentId === trial.experimentId && trialCanSupportComparison(state, candidate.trialId).ok).length;
    if (comparableCount < 2) {
        return { blocked: true, reason: '单次有效负结果只约束当次条件：关闭 / 降低整条路线需要覆盖关键条件的重复检验（§26.1、R05）' };
    }
    if (trial.confounders.length > 0) {
        return { blocked: true, reason: `存在未排除混杂（${trial.confounders.join(' / ')}）：路线级否定要先限定适用前提或补证据（§26.1、§26.2）` };
    }
    return { blocked: false, reason: '有覆盖关键条件的可比较负结果：路线级决定与证据范围相符（§26.1）' };
}
export const FAILURE_ATTRIBUTIONS = ['environment_issue', 'implementation_issue', 'evaluation_issue', 'unknown'];
/**
 * 防无限开脱（§26.2）：错误归因也要有证据；同一类执行失败反复出现时，
 * 没有修复动作的重试就是借"环境不行"无限消耗预算。
 */
export function unlimitedExcuseCheck(state, input) {
    const experiment = state.experiments[input.experimentId];
    if (experiment === undefined)
        return { blocked: true, recordOnly: false, reason: `试验 ${input.experimentId} 不在记录里` };
    if (input.attribution === 'unknown') {
        return { blocked: false, recordOnly: true, reason: '未知原因记录为 unknown / confounded 可以，但不能替换为"方法有效只是环境不行"，也不构成重试依据（§26.2）' };
    }
    const refs = input.evidenceRefs ?? [];
    if (refs.length === 0) {
        return { blocked: true, recordOnly: false, reason: '错误归因也要有证据：例如日志显示依赖不兼容、实际处理未生效、评价器正反例失败（§26.2）' };
    }
    const unresolved = refs.filter((ref) => state.evidence[ref] === undefined);
    if (unresolved.length > 0) {
        return { blocked: true, recordOnly: false, reason: `归因证据引用 ${unresolved.join(' / ')} 不在记录里：归因要挂在可核对的证据上（§26.2）` };
    }
    const fixes = input.fixes ?? [];
    if (fixes.length === 0) {
        return { blocked: false, recordOnly: true, reason: '归因有证据；但修复动作未列出：直接重试会落在同一条件下，先列修复动作再重评（§26.3）' };
    }
    const failureClass = Object.values(state.trials).filter((trial) => trial.experimentId === input.experimentId && (trial.execution === 'dependency_missing' || trial.execution === 'process_crash'));
    if (failureClass.length >= state.budgetLimits.maxTaskRetries) {
        return {
            blocked: true,
            recordOnly: false,
            reason: `同类执行失败已累计 ${failureClass.length} 次（上限 maxTaskRetries=${state.budgetLimits.maxTaskRetries}）：不能借"环境不行"无限开脱，先做最小复现或缩小范围（§26.2）`,
        };
    }
    return { blocked: false, recordOnly: false, reason: '归因有证据且修复动作已列出：可按新条件重新评估（§26.3）' };
}
// ————————————————————————————————————————————————————————————————
// §26.2 路线建议状态：五态视图，closed 要理由 + 证据 + 重入条件；
// §26.4 重大路线决定要取得相关反例与失效记录。
// ————————————————————————————————————————————————————————————————
export const ROUTE_BASES = ['evidence', 'budget_pause', 'external_delay', 'priority'];
/**
 * 更新路线建议状态（§26.2）：有作用域的当前视图，不取代 ClaimRevision，也不删除历史负结果。
 * 预算耗尽 / 外部延迟最多到 deferred 或 needs_diagnosis——任务暂停不等于方法被证伪。
 */
export function upsertRouteAssessment(state, input, now, actorId) {
    if (blank(input.routeFamilyId))
        return refused(state, '路线状态要有路线族 ID（§25.3）');
    if (blank(input.scope))
        return refused(state, '路线建议是有作用域的决策视图：scope 不能为空（§26.2）');
    if (blank(input.reason))
        return refused(state, '路线状态迁移要写明理由（§26.2）');
    const evidenceRefs = input.evidenceRefs ?? [];
    const reentry = input.reentryConditions ?? [];
    if ((input.state === 'disfavored_in_scope' || input.state === 'closed_in_scope') && (input.basis === 'budget_pause' || input.basis === 'external_delay')) {
        return refused(state, '预算耗尽或外部延迟只能到 deferred / needs_diagnosis：任务暂停不等于方法被证伪（§26.2）');
    }
    if (input.state === 'closed_in_scope' && evidenceRefs.length === 0) {
        return refused(state, 'closed_in_scope 需要关闭理由、证据与重新评估条件：证据引用为空（§26.2）');
    }
    if (input.state === 'closed_in_scope' && reentry.length === 0) {
        return refused(state, 'closed_in_scope 需要重新评估条件：未来满足什么才能重开（§26.2）');
    }
    if ((input.state === 'disfavored_in_scope' || input.state === 'closed_in_scope') && evidenceRefs.length === 0) {
        return refused(state, `${input.state} 要有证据引用：历史负结果保留在 ClaimRevision 里，降级决定要能指向它们（§26.2）`);
    }
    if (input.basis === 'evidence' && evidenceRefs.length === 0) {
        return refused(state, 'basis=evidence 却没有任何引用：证据口径要列具体记录（§26.2）');
    }
    const unresolved = evidenceRefs.filter((ref) => !resolvedRef(state, ref));
    if (evidenceRefs.length > 0 && unresolved.length === evidenceRefs.length) {
        return refused(state, `证据引用全部无法解析（${unresolved.join(', ')}）：路线决定要挂在可核对的反例 / 失效记录上（§26.4）`);
    }
    // §26.4：支持证据、反证与失效记录要同时进入当前决定。
    let coverage = { ok: true, missing: [] };
    if (input.relatedClaimIds !== undefined && input.relatedClaimIds.length > 0) {
        coverage = counterexampleCoverage(state, { claimIds: input.relatedClaimIds, consultedRefs: [...evidenceRefs, ...(input.consultedRefs ?? [])] });
        if (!coverage.ok && (input.state === 'disfavored_in_scope' || input.state === 'closed_in_scope')) {
            return refused(state, `路线降级 / 关闭要先取得相关反例与失效记录：${coverage.missing.join('；')}（§26.4）`);
        }
    }
    const previous = state.routes[input.routeFamilyId]?.state;
    const assessment = {
        routeFamilyId: input.routeFamilyId,
        missionId: state.missionId,
        scope: input.scope,
        state: input.state,
        reason: input.reason,
        evidenceRefs,
        reentryConditions: reentry,
        updatedBy: actorId,
        updatedAt: now,
    };
    const routes = put(state.routes, input.routeFamilyId, assessment);
    return {
        applied: true,
        state: commit({ ...state, routes }, 'experiment/route.assessed', { routeFamilyId: input.routeFamilyId, state: input.state, previous: previous ?? null, basis: input.basis, evidenceRefs: evidenceRefs.length, relatedClaims: input.relatedClaimIds?.length ?? 0 }, now),
        reason: `路线 ${input.routeFamilyId} 置为 ${input.state}（当前视图；历史负结果不在这里删除，§26.2）`,
        routeFamilyId: input.routeFamilyId,
        previous,
        coverage,
    };
}
/**
 * §26.4 反例进入当前决策：检索不能只按"成功"排序。
 * 对每条相关结论：有支持证据就要取到，有反证就要取到，已失效 / 已反证的记录本身也要被引用。
 */
export function counterexampleCoverage(state, input) {
    const consulted = new Set(input.consultedRefs);
    const missing = [];
    const used = (ids) => ids.length === 0 || ids.some((id) => consulted.has(id));
    for (const claimId of input.claimIds) {
        const chain = state.claims[claimId];
        const head = chain?.at(-1);
        if (chain === undefined || head === undefined) {
            missing.push(`结论 ${claimId} 不在记录里：重大路线决定要引用真实结论（§26.4）`);
            continue;
        }
        if (!used(head.supportingEvidenceIds))
            missing.push(`结论 ${claimId} 的支持证据未进入决定（${head.supportingEvidenceIds.join(', ')}）`);
        if (!used(head.contradictingEvidenceIds))
            missing.push(`结论 ${claimId} 的反证未进入决定（${head.contradictingEvidenceIds.join(', ')}）`);
        if (INEFFECTIVE_RESULTS.includes(head.validity) && !consulted.has(claimId)) {
            missing.push(`结论 ${claimId} 当前有效为 ${head.validity}：失效记录本身要进入决定（§26.4）`);
        }
        if (head.status === 'refuted' && !consulted.has(claimId)) {
            missing.push(`结论 ${claimId} 已被反证：历史误判要保留在决定里（§26.4）`);
        }
    }
    if (missing.length > 0) {
        return { ok: false, missing, reason: '支持证据、反证与失效记录要同时进入决定，检索不能只按"成功"或语义最相近排序（§26.4）' };
    }
    return { ok: true, missing: [], reason: '相关支持证据、反证与失效记录都已进入决定（§26.4）' };
}
// ————————————————————————————————————————————————————————————————
// §26.3 重试需要明确差异；§25.4 停滞复核。
// ————————————————————————————————————————————————————————————————
export const RETRY_TRIGGERS = ['environment_fixed', 'implementation_fixed', 'new_evidence', 'constraint_change', 'prior_evaluation_invalid', 'scope_mismatch'];
/** 只改随机种子、措辞或文件名不自动构成新证据（§26.3）。 */
export const TRIVIAL_CHANGE_PATTERNS = ['种子', 'seed', '措辞', 'wording', '文件名', 'filename', '重命名', '改名', 'rename'];
function trivialChange(change) {
    const lower = change.toLowerCase();
    return TRIVIAL_CHANGE_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}
function sameCondition(a, b) {
    return a.environment === b.environment && a.inputVersions.join('|') === b.inputVersions.join('|');
}
/** 重试判定（§26.3）：无实质差异又无预声明重复目的的，推迟；同条件反证充分时封顶。 */
export function evaluateRetry(state, input) {
    const chain = state.experiments[input.experimentId];
    if (chain === undefined)
        return { ok: false, reason: `试验 ${input.experimentId} 不在记录里`, materiality: 'none', sameConditionTrials: 0 };
    const material = input.changes.filter((change) => !trivialChange(change));
    const materiality = input.changes.length === 0 ? 'none' : material.length === 0 ? 'trivial_only' : 'material';
    const trials = Object.values(state.trials)
        .filter((trial) => trial.experimentId === input.experimentId)
        .sort((a, b) => a.createdAt - b.createdAt || (a.trialId < b.trialId ? -1 : 1));
    const last = input.lastTrialId === undefined ? trials.at(-1) : state.trials[input.lastTrialId];
    if (input.lastTrialId !== undefined && last === undefined) {
        return { ok: false, reason: `上次试验 ${input.lastTrialId} 不在记录里`, materiality, sameConditionTrials: 0 };
    }
    if (input.trigger === 'new_evidence') {
        const refs = input.newEvidenceRefs ?? [];
        if (refs.length === 0)
            return { ok: false, reason: 'trigger=new_evidence 但没有新证据引用：新证据出现才构成重评触发（§26.3）', materiality, sameConditionTrials: 0 };
        const unresolved = refs.filter((ref) => state.evidence[ref] === undefined);
        if (unresolved.length > 0)
            return { ok: false, reason: `新证据引用 ${unresolved.join(' / ')} 不在记录里（§26.3）`, materiality, sameConditionTrials: 0 };
    }
    if (input.trigger === 'prior_evaluation_invalid') {
        if (last === undefined)
            return { ok: false, reason: '没有上次试验记录：无法核对"先前评价无效"', materiality, sameConditionTrials: 0 };
        if (last.evaluationValidity === 'valid')
            return { ok: false, reason: '上次评价是有效的，不能用"先前评价无效"作为重评触发（§26.3）', materiality, sameConditionTrials: 0 };
    }
    const sameConditionCount = last === undefined ? 0 : trials.filter((trial) => sameCondition(trial, last)).length;
    // 同条件反证充分又没有实质差异时封顶（§26.2）：这条比"没有实质差异"更硬，先判。
    const cap = state.budgetLimits.maxTaskRetries;
    const hasComparableNegative = last !== undefined && trials.some((trial) => sameCondition(trial, last) && trialCanSupportComparison(state, trial.trialId).ok && (trial.observed === 'lower_than_baseline' || trial.observed === 'no_reliable_difference'));
    if (materiality !== 'material' && sameConditionCount >= cap && hasComparableNegative) {
        return {
            ok: false,
            reason: `同条件试验已 ${sameConditionCount} 次（上限 maxTaskRetries=${cap}）且有可比较的负结果：不能借"永远不能证明失败"无限消耗预算，要新条件或收尾（§26.2、§26.3）`,
            materiality,
            sameConditionTrials: sameConditionCount,
        };
    }
    if (materiality !== 'material' && input.purpose !== 'repeat_measurement') {
        return {
            ok: false,
            reason: '重试要写明与上次的实质差异：只改随机种子 / 措辞 / 文件名不自动构成新证据；没有合理变化又没有重复测量目的的重试应推迟（§26.3）',
            materiality,
            sameConditionTrials: sameConditionCount,
        };
    }
    if (input.purpose === 'repeat_measurement' && input.repeatDesignPredeclared !== true) {
        return {
            ok: false,
            reason: '重复测量要在预登记设计里先声明：不能靠多试几次挑最好一次（§25.5、§26.3）',
            materiality,
            sameConditionTrials: sameConditionCount,
        };
    }
    return {
        ok: true,
        reason: input.purpose === 'repeat_measurement'
            ? '按预登记的重复测量设计允许重试（§26.3）'
            : `实质变化已写明（${material.join(' / ')}），按 ${input.trigger} 重新评估（§26.3）`,
        materiality,
        sameConditionTrials: sameConditionCount,
    };
}
export function stagnationWindow(state, input) {
    const blankReport = (reason) => ({
        ok: false,
        reason,
        window: { comparableTrials: 0, resourceNote: `窗口 ${input.from}–${input.to} 没有可用试验`, from: input.from, to: input.to },
        lowGainTrials: 0,
        stagnant: false,
        trialIds: [],
        excluded: [],
    });
    if (!Number.isFinite(input.from) || !Number.isFinite(input.to) || input.from > input.to)
        return blankReport('窗口区间无效：from 要早于 to（§25.4）');
    if (input.preset.minComparableTrials < 1)
        return blankReport('minComparableTrials 至少为 1：窗口按可比较试验定义（§25.4）');
    if (input.preset.maxLowGainShare <= 0 || input.preset.maxLowGainShare > 1)
        return blankReport('maxLowGainShare 要在 (0, 1] 内（§25.4）');
    const family = new Set(Object.values(state.experiments)
        .map((chain) => chain.at(-1))
        .filter((spec) => spec !== undefined && spec.routeFamilyId === input.routeFamilyId)
        .map((spec) => spec.experimentId));
    const inWindow = Object.values(state.trials)
        .filter((trial) => family.has(trial.experimentId) && trial.createdAt >= input.from && trial.createdAt <= input.to)
        .sort((a, b) => (a.trialId < b.trialId ? -1 : 1));
    const comparable = [];
    const excluded = [];
    for (const trial of inWindow) {
        const verdict = trialCanSupportComparison(state, trial.trialId);
        if (verdict.ok)
            comparable.push(trial);
        else
            excluded.push({ trialId: trial.trialId, reason: verdict.reason });
    }
    const lowGain = comparable.filter((trial) => trial.observed === 'no_reliable_difference' || trial.observed === 'lower_than_baseline');
    const operations = comparable.reduce((sum, trial) => sum + trial.operationRefs.length, 0);
    const withBudget = comparable.filter((trial) => !blank(trial.budgetSpentNote)).length;
    const resourceNote = `${comparable.length} 次可比较试验、${lowGain.length} 次边际收益低、操作回执 ${operations} 条、含预算记录 ${withBudget} 条（窗口 ${input.from}–${input.to}）`;
    const stagnant = comparable.length >= input.preset.minComparableTrials && lowGain.length / comparable.length >= input.preset.maxLowGainShare;
    const reason = stagnant
        ? `同族投入持续高（${comparable.length} 次可比较试验）且经有效评估的边际收益低（${lowGain.length} 次）：生成一次 StrategyReview（§25.4）`
        : comparable.length === 0
            ? '窗口内没有可比较试验：等待长实验与外部依赖延迟不计入窗口，不按聊天条数判停滞（§25.4）'
            : `未构成停滞：可比较 ${comparable.length} 次、低收益 ${lowGain.length} 次，未达预设窗口（${input.preset.minComparableTrials} 次 / 份额 ${input.preset.maxLowGainShare}）（§25.4）`;
    return { ok: true, reason, window: { comparableTrials: comparable.length, resourceNote, from: input.from, to: input.to }, lowGainTrials: lowGain.length, stagnant, trialIds: comparable.map((trial) => trial.trialId), excluded };
}
/** "可能掉分"这类只表达偏好、不表达依据的未选理由（§25.4）。 */
export const DISMISSIVE_PATTERNS = ['可能掉分', '会掉分', '掉分', '风险太大', '太新', '不成熟', '可能不稳定', '不稳', '没必要', '不划算'];
function dismissiveOnly(text) {
    let rest = text;
    for (const pattern of DISMISSIVE_PATTERNS)
        rest = rest.split(pattern).join('');
    rest = rest.replace(/[\s，。、,.;；:：!！?？"'“”‘’()（）\-—]/g, '');
    return rest.length < 2;
}
/**
 * 登记策略决定（§25.4）：写明当前证据、未选理由、成本与复核触发器。
 * 停滞触发的决定必须与按记录重算的窗口一致——自报"50 条消息"这类窗口直接拒绝。
 */
export function registerStrategyDecision(state, draft, now, actorId) {
    if (draft.currentEvidence.length === 0)
        return refused(state, '决定要写明当前证据：不要求隐性思维链，但依据不能空着（§25.4）');
    if (blank(draft.costNote))
        return refused(state, '决定要写明成本（§25.4）');
    if (blank(draft.reviewTrigger))
        return refused(state, '决定要写明复核触发器（§25.4）');
    if (!Number.isFinite(draft.window.from) || !Number.isFinite(draft.window.to) || draft.window.from > draft.window.to) {
        return refused(state, '决定的比较窗口区间无效：from 要早于 to（§25.4）');
    }
    if (blank(draft.window.resourceNote))
        return refused(state, '决定的窗口要写明资源投入口径（§25.4）');
    let storedWindow = draft.window;
    let stagnant = false;
    if (draft.trigger === 'stagnation_window') {
        if (draft.stagnationCheck === undefined) {
            return refused(state, '停滞复核必须按可比较试验与资源投入重算窗口（§25.4）');
        }
        const report = stagnationWindow(state, { routeFamilyId: draft.stagnationCheck.routeFamilyId, from: draft.window.from, to: draft.window.to, preset: draft.stagnationCheck.preset });
        if (!report.ok)
            return refused(state, `停滞窗口核对失败：${report.reason}`);
        if (!report.stagnant)
            return refused(state, `窗口未构成停滞：${report.reason}`);
        if (draft.window.comparableTrials !== report.window.comparableTrials) {
            return refused(state, `自报窗口与记录不符（自报 ${draft.window.comparableTrials} 次 vs 记录 ${report.window.comparableTrials} 次）：停滞窗口以可比较试验与资源投入定义，不按消息条数（§25.4）`);
        }
        storedWindow = report.window;
        stagnant = true;
    }
    if (draft.candidates.length === 0)
        return refused(state, '决定要列候选与未选理由：候选为空不成决定（不为凑数强迫三个方案，但至少要有被选中的路线）（§25.4）');
    for (const candidate of draft.candidates) {
        if (blank(candidate.routeFamilyId) || blank(candidate.option))
            return refused(state, '候选要写明路线族与选项（§25.4）');
        if (blank(candidate.expectedInfoValue))
            return refused(state, '候选要写明有依据的信息价值预期：不能事后宣称"学到了东西"（§25.3、§25.4）');
        if (blank(candidate.costNote))
            return refused(state, '候选要写明成本（§25.4）');
        if (!candidate.chosen && blank(candidate.rejectedReason))
            return refused(state, `未选候选「${candidate.option}」要写明未选理由（§25.4）`);
        if (!candidate.chosen && candidate.rejectedReason !== undefined && dismissiveOnly(candidate.rejectedReason)) {
            return refused(state, `未选理由「${candidate.rejectedReason}」只表达偏好：连续采用同一路线可以，但要写明当前证据与取舍（§25.4）`);
        }
    }
    if (!draft.candidates.some((candidate) => candidate.chosen))
        return refused(state, '决定至少要选中一个候选（§25.4）');
    if (draft.relatedClaimIds !== undefined && draft.relatedClaimIds.length > 0) {
        const coverage = counterexampleCoverage(state, { claimIds: draft.relatedClaimIds, consultedRefs: draft.currentEvidence });
        if (!coverage.ok)
            return refused(state, `重大路线决定要取得相关反例与失效记录：${coverage.missing.join('；')}（§26.4）`);
    }
    const decision = {
        decisionId: draft.decisionId ?? mintId('str'),
        missionId: state.missionId,
        kind: draft.kind,
        trigger: draft.trigger,
        window: storedWindow,
        currentEvidence: draft.currentEvidence,
        candidates: draft.candidates.map((candidate) => ({
            routeFamilyId: candidate.routeFamilyId,
            option: candidate.option,
            expectedInfoValue: candidate.expectedInfoValue,
            costNote: candidate.costNote,
            chosen: candidate.chosen,
            ...(candidate.rejectedReason === undefined ? {} : { rejectedReason: candidate.rejectedReason }),
        })),
        costNote: draft.costNote,
        reviewTrigger: draft.reviewTrigger,
        // 决定所依据的记录水位取登记时刻的修订号：调用方不能自报一个"未来水位"（§28.4）。
        asOfMissionRevision: state.revision,
        ownerActorId: actorId,
        createdAt: now,
    };
    const strategyDecisions = put(state.strategyDecisions, decision.decisionId, decision);
    return {
        applied: true,
        state: commit({ ...state, strategyDecisions }, 'experiment/strategy.decided', { decisionId: decision.decisionId, kind: draft.kind, trigger: draft.trigger, candidates: draft.candidates.length, chosen: draft.candidates.filter((candidate) => candidate.chosen).length }, now),
        reason: `策略决定已登记（${draft.kind} / ${draft.trigger}）`,
        decisionId: decision.decisionId,
        stagnant,
    };
}
/** 决定引用的结论版本是否还一致（§26.4）：依据修订后决定要复核，不能继续放行。 */
export function strategyDecisionCurrent(state, decision) {
    for (const ref of decision.currentEvidence) {
        const match = /^(clm_[^@]+)@(\d+)$/.exec(ref);
        if (match === null)
            continue;
        const claimId = match[1] ?? '';
        const version = Number(match[2]);
        const chain = state.claims[claimId];
        const head = chain?.at(-1);
        if (chain === undefined || head === undefined)
            return { ok: false, reason: `决定引用的结论 ${claimId} 已不在记录里，要按当前记录复核（§26.4）` };
        if (head.retractedAt !== undefined)
            return { ok: false, reason: `结论 ${claimId} 已撤回：决定不能继续引用（§26.4）` };
        if (head.version > version)
            return { ok: false, reason: `结论 ${claimId} 已从 v${version} 修订到 v${head.version}：决定依据已过期（§26.4）` };
        if (INEFFECTIVE_RESULTS.includes(head.validity))
            return { ok: false, reason: `结论 ${claimId} 当前有效为 ${head.validity}：先复核再放行（§26.4、§22.6）` };
    }
    return { ok: true, reason: '决定引用的结论版本仍然一致' };
}
// ————————————————————————————————————————————————————————————————
// §31.3 猜想生命周期；§31.4 延后与重看；§31.6 事后解释标 postHoc。
// 冻结契约里没有 kind 字段：猜想身份由 `probeStage` 是否存在承载。
// ————————————————————————————————————————————————————————————————
/** 猜想处理阶段（§31.3）：不覆盖 Claim 的 proposed/supported/refuted 证据状态。 */
export const CONJECTURE_TRANSITIONS = {
    captured: ['framed', 'deferred', 'closed_in_scope'],
    framed: ['probe_ready', 'deferred', 'closed_in_scope'],
    probe_ready: ['probed', 'deferred', 'closed_in_scope'],
    probed: ['pursued', 'deferred', 'closed_in_scope'],
    pursued: ['closed_in_scope'],
    deferred: ['framed', 'probe_ready', 'closed_in_scope'],
    closed_in_scope: [],
};
export const DEFERRAL_REASONS = ['not_discernible', 'insufficient_resources', 'same_condition_covered', 'irrelevant_to_goal', 'execution_constraint_violated'];
/** 观测已经发生（任何一次探测或引用该猜想的试验）——此后新解释必须标 postHoc（§31.6）。 */
function resultsObserved(state, claimId, chain) {
    if (chain.some((revision) => revision.probeStage === 'probed' || revision.probeStage === 'pursued'))
        return true;
    return Object.values(state.trials).some((trial) => trial.claimRefs.includes(claimId));
}
function appendNote(note, addition) {
    if (blank(addition))
        return note;
    if (blank(note))
        return addition;
    return `${note}；${addition}`;
}
function advanceConjecture(state, claimId, to, patch, now, actorId, detail) {
    const chain = state.claims[claimId] ?? [];
    const head = chain.at(-1);
    if (head === undefined)
        return state;
    const next = { ...head, ...patch, version: head.version + 1, supersedesVersion: head.version, probeStage: to, createdAt: now, authorActorId: actorId };
    const claims = put(state.claims, claimId, [...chain, next]);
    return commit({ ...state, claims }, `conjecture/${to}`, { claimId, from: head.probeStage ?? null, to, ...detail }, now);
}
/** 登记猜想（§31.3）：复用 ClaimRevision，status=proposed——提出猜想不要求证据，也不声称已实测。 */
export function captureConjecture(state, draft, now, actorId) {
    if (blank(draft.proposition))
        return refused(state, '猜想要有明确命题；表达可以有力，但必须保留"猜想"身份（§31.1）');
    if (blank(draft.assumptionChange))
        return refused(state, '候选初始只需"猜想 + 相对当前路线改变了什么"：assumptionChange 不能为空（§31.2）');
    if (blank(draft.sourceNote))
        return refused(state, '来源可以是类比、反常观测或主动构想；来源本身不是支持证据，但要记录（§31.3、§32.4）');
    const claimId = draft.claimId ?? mintId('clm');
    const revision = {
        claimId,
        version: 1,
        proposition: draft.proposition,
        appliesUnder: draft.appliesUnder ?? [],
        sourceCategory: 'conjecture',
        status: 'proposed',
        validity: 'current',
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        reentryConditions: [],
        probeStage: 'captured',
        assumptionChanges: [{ text: draft.assumptionChange }],
        expectedSignals: draft.expectedSignals ?? [],
        competingExplanations: draft.competingExplanations ?? [],
        nextCheapestAction: draft.nextCheapestAction,
        sourceNote: draft.sourceNote,
        authorActorId: actorId,
        createdAt: now,
    };
    const claims = put(state.claims, claimId, [revision]);
    return {
        applied: true,
        state: commit({ ...state, claims }, 'conjecture/captured', { claimId, stage: 'captured', status: 'proposed' }, now),
        reason: '猜想已登记（probeStage=captured；status=proposed，不声称已实测成功）',
        claimId,
        version: 1,
    };
}
/**
 * framing（§31.3）：产出可观察预测或"当前不可检验的原因"，并可做有界 framing Task。
 * 冻结契约没有专门字段，不可检验原因追加进 `sourceNote`，同时进事件流。
 */
export function frameConjecture(state, claimId, framing, now, actorId) {
    const chain = state.claims[claimId];
    const head = chain?.at(-1);
    if (chain === undefined || head === undefined)
        return refused(state, `结论 ${claimId} 不在记录里`);
    if (head.probeStage === undefined)
        return refused(state, `结论 ${claimId} 不是猜想（没有 probeStage）：framing 只用于猜想生命周期（§31.3）`);
    if (head.probeStage !== 'captured' && head.probeStage !== 'framed') {
        return refused(state, `猜想已在 ${head.probeStage} 阶段：framing 只发生在 captured / framed（§31.3）`);
    }
    const signals = framing.expectedSignals ?? [];
    const newChanges = blank(framing.assumptionChange) ? [] : [{ text: framing.assumptionChange ?? '' }];
    if (signals.length === 0 && blank(framing.notTestableReason)) {
        return refused(state, 'framing 要产出可观察预测或当前不可检验的原因：反复空想没有产出不得无限延长（§31.3、V5-05）');
    }
    if (head.probeStage === 'framed' && signals.length === 0 && newChanges.length === 0) {
        return refused(state, '这次 framing 没有新增预测或假设变化：反复空想没有产出不得无限延长（§31.3、V5-05）');
    }
    const sourceNote = blank(framing.notTestableReason) ? head.sourceNote : appendNote(head.sourceNote, `framing：当前不可检验的原因——${framing.notTestableReason ?? ''}`);
    const nextAction = framing.nextCheapestAction === undefined ? head.nextCheapestAction : framing.nextCheapestAction;
    const state2 = advanceConjecture(state, claimId, 'framed', {
        assumptionChanges: [...(head.assumptionChanges ?? []), ...newChanges],
        expectedSignals: [...(head.expectedSignals ?? []), ...signals],
        competingExplanations: [...(head.competingExplanations ?? []), ...(framing.competingExplanations ?? [])],
        nextCheapestAction: nextAction,
        sourceNote,
    }, now, actorId, { expectedSignals: [...(head.expectedSignals ?? []), ...signals].length, notTestable: !blank(framing.notTestableReason) });
    return { applied: true, state: state2, reason: '猜想已完成 framing：可观察预测或不可检验原因已记录（§31.3）', version: (state.claims[claimId]?.at(-1)?.version ?? 0) + 1, stage: 'framed' };
}
/** probe_ready（§31.3）：探测要求能获得某种可解释观测，并写明最低成本下一动作。 */
export function probeReadyConjecture(state, claimId, input, now, actorId) {
    const chain = state.claims[claimId];
    const head = chain?.at(-1);
    if (chain === undefined || head === undefined)
        return refused(state, `结论 ${claimId} 不在记录里`);
    if (head.probeStage === undefined)
        return refused(state, `结论 ${claimId} 不是猜想（没有 probeStage）（§31.3）`);
    if (head.probeStage !== 'framed' && head.probeStage !== 'deferred') {
        return refused(state, `猜想处于 ${head.probeStage}：先 framing（framed）或在里程碑重看（deferred）后才能进入 probe_ready（§31.3、§31.4）`);
    }
    if ((head.expectedSignals ?? []).length === 0) {
        return refused(state, 'probe_ready 要有可观察预测：探测要求能获得某种可解释观测（§31.1、§31.3）');
    }
    if (blank(input.nextCheapestAction))
        return refused(state, 'probe_ready 要写明最低成本下一动作（§31.3）');
    const state2 = advanceConjecture(state, claimId, 'probe_ready', { nextCheapestAction: input.nextCheapestAction }, now, actorId, { nextCheapestAction: input.nextCheapestAction });
    return { applied: true, state: state2, reason: '猜想进入 probe_ready：小规模探测只需对当前决策有辨别力（§31.6）', version: (state.claims[claimId]?.at(-1)?.version ?? 0) + 1, stage: 'probe_ready' };
}
/**
 * 已探测（§31.3）：探测要把试验挂回猜想的 claimRefs，并要求执行完成、评价有效、干预生效。
 * probe 的阶段目标达成不等于整个猜想被证明：`status` 一律不动。
 */
export function recordConjectureProbe(state, claimId, input, now, actorId) {
    const chain = state.claims[claimId];
    const head = chain?.at(-1);
    if (chain === undefined || head === undefined)
        return refused(state, `结论 ${claimId} 不在记录里`);
    if (head.probeStage === undefined)
        return refused(state, `结论 ${claimId} 不是猜想（没有 probeStage）（§31.3）`);
    if (head.probeStage !== 'probe_ready' && head.probeStage !== 'probed') {
        return refused(state, `猜想处于 ${head.probeStage}：探测要先 probe_ready（deferred 的候选要按重入条件回到 probe_ready）（§31.3、§31.4）`);
    }
    const trial = state.trials[input.trialId];
    if (trial === undefined)
        return refused(state, `试验 ${input.trialId} 不在记录里：探测要绑定已登记的结果（§31.3）`);
    if (!trial.claimRefs.includes(claimId)) {
        return refused(state, `试验 ${input.trialId} 的 claimRefs 没有引用该猜想：探测与猜想要可对应（§31.3）`);
    }
    const comparability = trialCanSupportComparison(state, input.trialId);
    if (!comparability.ok)
        return refused(state, `这次不能算已探测：${comparability.reason}（§31.1、DG-11）`);
    if (trial.observed === 'not_measured')
        return refused(state, '没有观测结果不能算探测：探测要求能获得某种可解释观测（§31.1）');
    const state2 = advanceConjecture(state, claimId, 'probed', {}, now, actorId, { trialId: input.trialId, observed: trial.observed, note: 'probe 阶段目标达成不等于猜想被证明' });
    return { applied: true, state: state2, reason: '已记录一次探测（probeStage=probed；证据状态 status 不动，§31.3）', version: (state.claims[claimId]?.at(-1)?.version ?? 0) + 1, stage: 'probed' };
}
/** pursued（§31.3、§31.6）：扩大投入前明确替代解释；被选择 pursued 不等于猜想为真。 */
export function pursueConjecture(state, claimId, input, now, actorId) {
    const chain = state.claims[claimId];
    const head = chain?.at(-1);
    if (chain === undefined || head === undefined)
        return refused(state, `结论 ${claimId} 不在记录里`);
    if (head.probeStage === undefined)
        return refused(state, `结论 ${claimId} 不是猜想（没有 probeStage）（§31.3）`);
    if (head.probeStage !== 'probed')
        return refused(state, `猜想处于 ${head.probeStage}：先完成一次有效探测（probed）再决定是否 pursued（§31.3）`);
    if (blank(input.reason))
        return refused(state, '选择 pursued 要写明理由：哪些证据支持继续投入（§25.4、§31.3）');
    if ((head.competingExplanations ?? []).length === 0) {
        return refused(state, '扩大投入前要明确竞争解释：只写支持的观测不算求证（§31.6）');
    }
    const state2 = advanceConjecture(state, claimId, 'pursued', {}, now, actorId, { reason: input.reason, note: 'pursued 不等于猜想为真' });
    return { applied: true, state: state2, reason: '猜想转为 pursued：被选择不等于为真，结论范围仍由证据决定（§31.3）', version: (state.claims[claimId]?.at(-1)?.version ?? 0) + 1, stage: 'pursued' };
}
/** deferred（§31.4）：记录被延后的理由，可在里程碑重看，不因未执行被标为错误。 */
export function deferConjecture(state, claimId, input, now, actorId) {
    const chain = state.claims[claimId];
    const head = chain?.at(-1);
    if (chain === undefined || head === undefined)
        return refused(state, `结论 ${claimId} 不在记录里`);
    if (head.probeStage === undefined)
        return refused(state, `结论 ${claimId} 不是猜想（没有 probeStage）（§31.3）`);
    if (!DEFERRAL_REASONS.includes(input.deferralReason)) {
        return refused(state, '延后理由要落在 §31.4 的清单里：尚不可辨别 / 资源不足 / 已覆盖同条件 / 与目标无关 / 违反执行约束');
    }
    if ((CONJECTURE_TRANSITIONS[head.probeStage] ?? []).includes('deferred') === false && head.probeStage !== 'deferred') {
        return refused(state, `猜想处于 ${head.probeStage}：该阶段没有"延后"出口（§31.3）`);
    }
    if (blank(input.note))
        return refused(state, '记录被延后的理由不能只填枚举：要写说明（§31.4）');
    const sourceNote = appendNote(head.sourceNote, `延后（${input.deferralReason}）：${input.note}`);
    const state2 = advanceConjecture(state, claimId, 'deferred', {
        sourceNote,
        ...(blank(input.reentryCondition) ? {} : { reentryConditions: [...head.reentryConditions, input.reentryCondition ?? ''] }),
    }, now, actorId, { deferralReason: input.deferralReason, note: input.note, reentryCondition: input.reentryCondition ?? null });
    return { applied: true, state: state2, reason: '候选已延后并记录理由：可在里程碑重看，不代表被封存（§31.4）', version: (state.claims[claimId]?.at(-1)?.version ?? 0) + 1, stage: 'deferred' };
}
/** closed_in_scope（§31.3）：无后续动作的灵感可以归档；有探测历史的关闭要带证据与重入条件。 */
export function closeConjectureInScope(state, claimId, input, now, actorId) {
    const chain = state.claims[claimId];
    const head = chain?.at(-1);
    if (chain === undefined || head === undefined)
        return refused(state, `结论 ${claimId} 不在记录里`);
    if (head.probeStage === undefined)
        return refused(state, `结论 ${claimId} 不是猜想（没有 probeStage）（§31.3）`);
    if (head.probeStage === 'closed_in_scope')
        return refused(state, `猜想 ${claimId} 已归档：closed_in_scope 是终态（§31.3）`);
    if (blank(input.reason))
        return refused(state, '归档 / 关闭要写明理由（§31.3）');
    const evidenceRefs = input.evidenceRefs ?? [];
    const observed = resultsObserved(state, claimId, chain);
    if (observed) {
        if (evidenceRefs.length === 0)
            return refused(state, '有探测历史的猜想关闭时要带证据引用：保留观测、实际处理、基线与反例（§31.6）');
        const resolved = evidenceRefs.filter((ref) => resolvedRef(state, ref));
        if (resolved.length === 0)
            return refused(state, `证据引用 ${evidenceRefs.join(' / ')} 都解析不到记录：关闭要挂在可核对的结果上（§31.6）`);
        if ((input.reentryConditions ?? []).length === 0 && head.reentryConditions.length === 0) {
            return refused(state, '有探测历史的关闭要保留重新评估条件：结论只约束当次范围（§26.1、§31.6）');
        }
    }
    const reentry = [...head.reentryConditions, ...(input.reentryConditions ?? [])];
    const state2 = advanceConjecture(state, claimId, 'closed_in_scope', { reentryConditions: reentry }, now, actorId, { reason: input.reason, evidenceRefs, observed });
    return { applied: true, state: state2, reason: '猜想已按范围关闭 / 归档（§31.3）', version: (state.claims[claimId]?.at(-1)?.version ?? 0) + 1, stage: 'closed_in_scope' };
}
/**
 * 事后解释标 postHoc（§31.6）：结果意外时允许产生新解释，但不能反向修改原预测。
 * 观测已经发生而新记录未标 `postHoc` 时拒绝——历史版本原样保留，改的只是当前链头。
 */
export function addAssumptionChange(state, claimId, change, now, actorId) {
    const chain = state.claims[claimId];
    const head = chain?.at(-1);
    if (chain === undefined || head === undefined)
        return refused(state, `结论 ${claimId} 不在记录里`);
    if (head.probeStage === undefined)
        return refused(state, `结论 ${claimId} 不是猜想（没有 probeStage）：假设变化记录挂在猜想链上（§31.3）`);
    if (blank(change.text))
        return refused(state, '假设变化要写内容（§31.3）');
    const observed = resultsObserved(state, claimId, chain);
    if (observed && change.postHoc !== true) {
        return refused(state, '结果已观测：新解释必须标为事后形成（postHoc=true），不能反向修改原预测使其"始终正确"（§31.6）');
    }
    const state2 = advanceConjecture(state, claimId, head.probeStage, { assumptionChanges: [...(head.assumptionChanges ?? []), change] }, now, actorId, { postHoc: change.postHoc === true, observed });
    return { applied: true, state: state2, reason: change.postHoc === true ? '事后解释已按 postHoc 记录：原预测保持原样，用后续观测检验（§31.6）' : '假设变化已记录（结果观测前）（§31.3）', version: (state.claims[claimId]?.at(-1)?.version ?? 0) + 1, postHoc: change.postHoc === true };
}
export function conjectureView(state, claimId) {
    const chain = state.claims[claimId];
    const head = chain?.at(-1);
    if (chain === undefined || head === undefined) {
        return { ok: false, reason: `结论 ${claimId} 不在记录里`, claimId, expectedSignals: [], competingExplanations: [], assumptionChanges: [], allowedTransitions: [], probedTrialIds: [] };
    }
    if (head.probeStage === undefined) {
        return { ok: false, reason: `结论 ${claimId} 不是猜想（没有 probeStage）`, claimId, version: head.version, status: head.status, expectedSignals: [], competingExplanations: [], assumptionChanges: [], allowedTransitions: [], probedTrialIds: [] };
    }
    const probedTrialIds = Object.values(state.trials)
        .filter((trial) => trial.claimRefs.includes(claimId))
        .map((trial) => trial.trialId)
        .sort();
    return {
        ok: true,
        reason: '猜想阶段与证据状态分开：pursued 不等于为真（§31.3）',
        claimId,
        version: head.version,
        stage: head.probeStage,
        status: head.status,
        proposition: head.proposition,
        expectedSignals: head.expectedSignals ?? [],
        competingExplanations: head.competingExplanations ?? [],
        nextCheapestAction: head.nextCheapestAction,
        assumptionChanges: head.assumptionChanges ?? [],
        allowedTransitions: CONJECTURE_TRANSITIONS[head.probeStage] ?? [],
        probedTrialIds,
    };
}
