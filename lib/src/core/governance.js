import { commit, mintId, put } from './control.js';
import { noteGovernance } from './budget.js';
/** 熔断阈值（候选配置，可被调用方按机制覆写）：连续几次才算"反复"（§35.3）。 */
export const BREAKER_TIMEOUT_STREAK = 3;
export const BREAKER_FAILURE_STREAK = 3;
export const BREAKER_NO_CHANGE_STREAK = 3;
/** §35.4：不凭单次观察宣称有收益——归因清楚的观察至少要有两次。 */
export const MIN_BENEFIT_OBSERVATIONS = 2;
/**
 * §35.1 表格逐行：类别决定缺失 / 故障时的处置。
 *
 * 注意三行都**不**给出"绕过"：核心不变量故障时受管业务动作被阻断，诊断 / 取消 / 核对保留；
 * 必需验收器失效时未验证不算通过，可以换已认可方法或等待，不能自动豁免；
 * 可选建议超时或低收益时退为观察 / 停用建议。
 */
export function dispositionFor(cls, failure = 'missing') {
    if (cls === 'core_invariant') {
        return {
            verdict: 'block_dependent',
            keepsAvailable: ['diagnosis', 'cancel', 'reconcile', 'data_export', 'stop'],
            expandsExecutionRights: false,
            reason: `核心不变量${failureText(failure)}：阻断依赖它的受管业务动作，只读诊断/取消/核对保留（§35.1、§35.3）`,
        };
    }
    if (cls === 'required_acceptance') {
        return {
            verdict: 'not_passed',
            keepsAvailable: ['diagnosis', 'cancel', 'reconcile', 'substitute_approved_method', 'wait'],
            expandsExecutionRights: false,
            reason: `必需验收${failureText(failure)}：未验证不算通过，可换已认可方法或等待，不能自动豁免（§35.1）`,
        };
    }
    return {
        verdict: 'degrade_or_disable',
        keepsAvailable: ['diagnosis', 'data_export'],
        expandsExecutionRights: false,
        reason: `可选建议${failureText(failure)}：退为观察或停用建议，不扩大执行权限（§35.1）`,
    };
}
function failureText(failure) {
    const table = {
        missing: '缺失',
        timeout: '超时',
        error: '故障',
        repeated_no_change: '反复无变化',
        over_cost: '成本超限',
        low_benefit: '低收益',
    };
    return table[failure];
}
export function mechanismHead(state, mechanismId) {
    const chain = state.mechanisms[mechanismId];
    return chain?.[chain.length - 1];
}
/**
 * 机制当前能干什么。
 *
 * 没有策略记录时按**最保守**处理（与 `discipline.conditionOf` 的缺省口径一致）：
 * 不假装它是可选建议，而是要求按核心不变量阻断依赖它的动作。
 */
export function mechanismAvailability(state, mechanismId) {
    const policy = mechanismHead(state, mechanismId);
    if (policy === undefined) {
        return {
            present: false,
            adjudicative: false,
            suggestionOnly: false,
            disposition: dispositionFor('core_invariant', 'missing'),
            reason: '没有机制策略记录：按最保守处理，缺失期间不声称该机制缺席无害（§35.1）',
        };
    }
    if (policy.status === 'active') {
        return { present: true, policy, adjudicative: true, suggestionOnly: false, reason: '机制在 active，可出判定' };
    }
    if (policy.status === 'retired') {
        return { present: true, policy, adjudicative: false, suggestionOnly: false, reason: '机制已退役：其判定不得作为验收依据（§35.4）' };
    }
    if (policy.status === 'cooling' || policy.status === 'observe_only') {
        return {
            present: true,
            policy,
            adjudicative: false,
            suggestionOnly: true,
            disposition: dispositionFor(policy.class, 'error'),
            reason: `机制处于 ${policy.status}：按范围停用，只剩建议与观察（§35.3）`,
        };
    }
    return { present: true, policy, adjudicative: false, suggestionOnly: true, reason: `机制处于 ${policy.status}：尚未取得判定资格（§35.1 生命周期）` };
}
export function dispositionForMechanism(state, mechanismId, failure = 'missing') {
    const availability = mechanismAvailability(state, mechanismId);
    if (availability.policy === undefined)
        return dispositionFor('core_invariant', failure);
    if (availability.policy.status === 'retired') {
        return {
            verdict: availability.policy.class === 'optional_advisory' ? 'degrade_or_disable' : 'not_passed',
            keepsAvailable: ['diagnosis', 'data_export'],
            expandsExecutionRights: false,
            reason: `机制已退役（${availability.policy.retirementReason ?? '未记理由'}）：${availability.policy.class} 的验收不能由它出具，也不能自动算通过（§35.4）`,
        };
    }
    return dispositionFor(availability.policy.class, failure);
}
/** 登记候选机制：版本 1 且状态 candidate，先观察再启用（§35.1）。 */
export function proposeMechanism(state, input, now) {
    const mechanismId = input.mechanismId ?? mintId('mech');
    if (state.mechanisms[mechanismId] !== undefined) {
        return { ok: false, state, reason: `机制 ${mechanismId} 已存在：修订请走 reviseMechanism（§35.1）` };
    }
    if (input.purpose.trim().length === 0 || input.benefitSignal.trim().length === 0) {
        return { ok: false, state, reason: '机制必须写明用途与预期收益信号，否则无法事后判断它是否值得留（§35.1、§35.4）' };
    }
    const mechanism = {
        mechanismId,
        version: 1,
        missionId: state.missionId,
        name: input.name,
        class: input.class,
        purpose: input.purpose,
        triggers: input.triggers,
        requiredInputs: input.requiredInputs,
        relevantRevisions: input.relevantRevisions,
        scope: input.scope,
        benefitSignal: input.benefitSignal,
        costCap: input.costCap,
        timeoutMs: input.timeoutMs,
        status: 'candidate',
        resumeWhen: input.resumeWhen,
        proposedBy: input.proposedBy,
        createdAt: now,
    };
    const next = commit({ ...state, mechanisms: put(state.mechanisms, mechanismId, [mechanism]) }, 'mechanism/proposed', {
        mechanismId,
        class: mechanism.class,
        scope: mechanism.scope,
    }, now);
    return { ok: true, state: next, mechanism };
}
/** 修订：链上追加版本；**分类不许顺带改**，它有自己的入口（§35.1）。 */
export function reviseMechanism(state, mechanismId, patch, now, actorId) {
    const chain = state.mechanisms[mechanismId];
    const head = chain?.[chain.length - 1];
    if (chain === undefined || head === undefined)
        return { ok: false, state, reason: `机制 ${mechanismId} 不存在` };
    const mechanism = {
        ...head,
        version: head.version + 1,
        name: patch.name ?? head.name,
        purpose: patch.purpose ?? head.purpose,
        triggers: patch.triggers ?? head.triggers,
        requiredInputs: patch.requiredInputs ?? head.requiredInputs,
        relevantRevisions: patch.relevantRevisions ?? head.relevantRevisions,
        scope: patch.scope ?? head.scope,
        benefitSignal: patch.benefitSignal ?? head.benefitSignal,
        costCap: patch.costCap ?? head.costCap,
        timeoutMs: patch.timeoutMs ?? head.timeoutMs,
        resumeWhen: patch.resumeWhen ?? head.resumeWhen,
        proposedBy: actorId,
        createdAt: now,
    };
    const next = commit({ ...state, mechanisms: put(state.mechanisms, mechanismId, [...chain, mechanism]) }, 'mechanism/revised', {
        mechanismId,
        version: mechanism.version,
    }, now);
    return { ok: true, state: next, mechanism };
}
/**
 * 分类变更的唯一入口（§35.1）：模型不能为通过检查把"必需"改成"可选"，
 * 也不能把建议都升级成核心不变量；只有规则所有者或已有授权能升降。
 */
export function changeMechanismClass(state, mechanismId, nextClass, decision, now) {
    const chain = state.mechanisms[mechanismId];
    const head = chain?.[chain.length - 1];
    if (chain === undefined || head === undefined)
        return { ok: false, state, reason: `机制 ${mechanismId} 不存在` };
    if (decision.basis === 'model') {
        return { ok: false, state, reason: `模型不能自行把 ${head.class} 改成 ${nextClass}：分类来自有效规则与任务契约（§35.1）` };
    }
    if (head.class === nextClass)
        return { ok: false, state, reason: `机制 ${mechanismId} 已经是 ${nextClass}` };
    const mechanism = {
        ...head,
        version: head.version + 1,
        class: nextClass,
        statusReason: `分类由 ${decision.basis}（${decision.actorId}${decision.authorizationRef === undefined ? '' : `，依据 ${decision.authorizationRef}`}）从 ${head.class} 调整为 ${nextClass}`,
        proposedBy: decision.actorId,
        createdAt: now,
    };
    const next = commit({ ...state, mechanisms: put(state.mechanisms, mechanismId, [...chain, mechanism]) }, 'mechanism/class_changed', {
        mechanismId,
        version: mechanism.version,
        from: head.class,
        to: nextClass,
        basis: decision.basis,
    }, now);
    return { ok: true, state: next, mechanism };
}
const TRANSITION_TARGET = {
    start_observing: 'observing',
    activate: 'active',
    enter_cooling: 'cooling',
    enter_observe_only: 'observe_only',
    demote_to_observing: 'observing',
    retire: 'retired',
};
/**
 * 与 RuleSpec 生命周期同构：candidate→observing→active→cooling/observe_only→retired（§35.1）。
 *
 * cooling / observe_only 只有一个出口——`demote_to_observing`（由 `recheckAfterCooldown`
 * 在能力复核通过后调用）与 `retire`；**没有**直接回 active 的边，冷却结束不等于故障已修复。
 */
const LEGAL_TRANSITIONS = {
    candidate: ['start_observing', 'retire'],
    observing: ['activate', 'enter_cooling', 'enter_observe_only', 'retire'],
    active: ['enter_cooling', 'enter_observe_only', 'demote_to_observing', 'retire'],
    cooling: ['demote_to_observing', 'retire'],
    observe_only: ['demote_to_observing', 'retire'],
    retired: [],
};
/**
 * 状态迁移：冷却 / 仅观察 / 退役都要求记录原因与重新评估条件；
 * 必需规则的退役必须由规则所有者或已有授权决定，模型说了不算（§35.3、§35.4）。
 */
export function transitionMechanism(state, mechanismId, event, now, detail = {}) {
    const chain = state.mechanisms[mechanismId];
    const head = chain?.[chain.length - 1];
    if (chain === undefined || head === undefined)
        return { ok: false, state, reason: `机制 ${mechanismId} 不存在` };
    if (!LEGAL_TRANSITIONS[head.status].includes(event)) {
        return { ok: false, state, reason: `从 ${head.status} 不能执行 ${event}（生命周期与 RuleSpec 同构，§35.1）` };
    }
    const target = TRANSITION_TARGET[event];
    const explicitReason = (detail.reason ?? '').trim();
    // 停用类的迁移必须自带理由：默认填充的"按某某调整状态"不足以支撑事后判断（§35.3）。
    if ((target === 'cooling' || target === 'observe_only' || target === 'retired') && explicitReason.length === 0) {
        return { ok: false, state, reason: '冷却 / 降级 / 退役必须记录原因，否则事后无法判断能否恢复（§35.3）' };
    }
    const reason = explicitReason.length > 0 ? explicitReason : `按 ${event} 调整状态`;
    if (target === 'retired' && head.class !== 'optional_advisory' && (detail.basis ?? 'model') === 'model') {
        return { ok: false, state, reason: `必需规则（${head.class}）的更改必须由规则所有者或已有授权决定，不能由模型退役（§35.4）` };
    }
    const mechanism = {
        ...head,
        version: head.version + 1,
        status: target,
        statusReason: reason,
        resumeWhen: detail.resumeWhen ?? head.resumeWhen,
        retiredAt: target === 'retired' ? now : head.retiredAt,
        retirementReason: target === 'retired' ? reason : head.retirementReason,
        proposedBy: detail.actorId ?? head.proposedBy,
        createdAt: now,
    };
    const next = commit({ ...state, mechanisms: put(state.mechanisms, mechanismId, [...chain, mechanism]) }, 'mechanism/status_changed', {
        mechanismId,
        version: mechanism.version,
        from: head.status,
        to: target,
        event,
        reason,
    }, now);
    return { ok: true, state: next, mechanism };
}
/**
 * 某机制累计消耗。墙钟栏是**成本口径**的累加，不是会话已过时间——
 * 并行时墙钟时间不能简单相加（§35.2），需要"已经等了多久"请另取时间线，别拿这个数当 elapsed。
 */
export function mechanismSpend(state, mechanismId) {
    const spend = { runs: 0, calls: 0, tokens: 0, wallClockMs: 0, blockedWaitMs: 0, unknownRuns: 0 };
    const runs = Object.values(state.mechanismRuns)
        .filter((run) => run.mechanismId === mechanismId)
        .sort((a, b) => compareId(a.runId, b.runId));
    for (const run of runs) {
        spend.runs += 1;
        spend.calls += run.modelCalls ?? 0;
        spend.tokens += run.tokens ?? 0;
        spend.wallClockMs += run.wallClockMs ?? 0;
        spend.blockedWaitMs += run.blockedWaitMs ?? 0;
        if (run.costUnknown === true)
            spend.unknownRuns += 1;
    }
    return spend;
}
/** 单次运行的成本读数：不可观测的费用显示 unknown，部分可观测的只能当下界（§35.2）。 */
export function governanceCostOf(run) {
    const calls = run.modelCalls ?? 0;
    const tokens = run.tokens ?? 0;
    const wallClockMs = run.wallClockMs ?? 0;
    const blockedWaitMs = run.blockedWaitMs ?? 0;
    const missing = run.modelCalls === undefined || run.tokens === undefined || run.wallClockMs === undefined;
    const level = run.costUnknown === true ? 'unknown' : missing ? (run.modelCalls === undefined && run.tokens === undefined && run.wallClockMs === undefined ? 'unknown' : 'lower_bound') : 'observed';
    const note = level === 'observed'
        ? '模型/工具消耗、运行时延与阻断等待均已记录'
        : level === 'lower_bound'
            ? '部分费用不可观测：记录值只是下界，展示时不能当成完整成本（§35.2）'
            : '费用不可观测：总成本扣除仍从 Mission 预算走，但这笔的量显示 unknown（§35.2）';
    return { calls, tokens, wallClockMs, blockedWaitMs, level, note };
}
function amount(value) {
    return value === undefined || !Number.isFinite(value) || value <= 0 ? 0 : value;
}
/**
 * 记一次机制运行：成本仍从 Mission 预算扣除（治理栏单列，占总账不另开额度）。
 *
 * 不可观测的量按 0 入账但把 `costUnknown` 标出来——写 0 而不标未知，会让人以为
 * "这次治理不要钱"，那正是 §35.2 要避免的假读数。
 */
export function recordMechanismRun(state, input, now) {
    const policy = mechanismHead(state, input.mechanismId);
    if (policy === undefined) {
        return { ok: false, state, reason: `机制 ${input.mechanismId} 未登记：没有成本策略的运行不能挂账（§35.1）`, costLevel: 'unknown', billedToMission: true };
    }
    if (state.mechanismRuns[input.runId ?? ''] !== undefined) {
        return { ok: false, state, reason: `运行记录 ${input.runId ?? ''} 已存在`, costLevel: 'unknown', billedToMission: true };
    }
    const startedAt = input.startedAt ?? now;
    const finishedAt = input.finishedAt ?? now;
    if (finishedAt < startedAt) {
        return { ok: false, state, reason: '回执时间早于开始时间：这不是一次可结算的运行', costLevel: 'unknown', billedToMission: true };
    }
    const unobservable = input.costUnknown === true || (input.modelCalls === undefined && input.tokens === undefined && input.wallClockMs === undefined);
    const runId = input.runId ?? mintId('mrun');
    const run = {
        runId,
        missionId: state.missionId,
        mechanismId: input.mechanismId,
        mechanismVersion: policy.version,
        actorId: input.actorId,
        taskId: input.taskId,
        trigger: input.trigger,
        startedAt,
        finishedAt,
        modelCalls: input.modelCalls,
        tokens: input.tokens,
        wallClockMs: input.wallClockMs,
        blockedWaitMs: input.blockedWaitMs,
        costUnknown: unobservable ? true : undefined,
        outputNote: input.outputNote ?? '',
        actualAction: input.actualAction,
        misreport: input.misreport,
        misreportNote: input.misreportNote,
    };
    const cost = governanceCostOf(run);
    const budget = noteGovernance(state.budget, {
        calls: amount(input.modelCalls),
        tokens: amount(input.tokens),
        wallClockMs: amount(input.wallClockMs) + amount(input.blockedWaitMs),
    });
    const next = commit({ ...state, mechanismRuns: put(state.mechanismRuns, runId, run), budget }, 'mechanism/run', { runId, mechanismId: input.mechanismId, mechanismVersion: policy.version, trigger: input.trigger, costLevel: cost.level }, now);
    return { ok: true, state: next, run, costLevel: cost.level, billedToMission: true };
}
/** 事后补记误报（§35.4）：收益评估要看"误报导致的延迟"，所以这一天必须能后补。 */
export function recordMisreport(state, runId, verdict, note, now) {
    const run = state.mechanismRuns[runId];
    if (run === undefined)
        return { ok: false, state, reason: `运行记录 ${runId} 不存在` };
    const updated = { ...run, misreport: verdict, misreportNote: note };
    const next = commit({ ...state, mechanismRuns: put(state.mechanismRuns, runId, updated) }, 'mechanism/misreport', { runId, verdict }, now);
    return { ok: true, state: next, run: updated };
}
/** 熔断判定：连续超时 / 反复无变化的建议 / 成本超过策略上限 ⇒ cooling / observe_only（§35.3）。 */
export function breakerFor(policy, signals, spend) {
    const cap = policy.costCap;
    const overCap = (cap?.tokens !== undefined && spend.tokens > cap.tokens) ||
        (cap?.calls !== undefined && spend.calls > cap.calls) ||
        (cap?.wallClockMs !== undefined && spend.wallClockMs > cap.wallClockMs);
    if (overCap) {
        return {
            break: true,
            target: 'cooling',
            reason: `机制成本 ${spend.tokens} token / ${spend.calls} 调用 / ${spend.wallClockMs}ms 超过策略上限（§35.2、§35.3）`,
            resumeWhen: '冷却结束只重新检查能力；回到 active 需要成本与收益重新评估，且不自动重启已取消的任务',
            allowsDegradedWrites: false,
        };
    }
    if (signals.timeoutStreak >= BREAKER_TIMEOUT_STREAK) {
        return {
            break: true,
            target: 'cooling',
            reason: `连续 ${signals.timeoutStreak} 次超时（策略超时 ${policy.timeoutMs ?? '未设'}ms）`,
            resumeWhen: '冷却结束复核能力与超时配置，不视为故障已修复（§35.3）',
            allowsDegradedWrites: false,
        };
    }
    if (signals.failureStreak >= BREAKER_FAILURE_STREAK) {
        return {
            break: true,
            target: 'cooling',
            reason: `连续 ${signals.failureStreak} 次故障`,
            resumeWhen: '冷却结束复核能力；核心不变量故障期间依赖它的受管动作保持阻断（§35.3）',
            allowsDegradedWrites: false,
        };
    }
    if (signals.noChangeStreak >= BREAKER_NO_CHANGE_STREAK) {
        return {
            break: true,
            target: 'observe_only',
            reason: `连续 ${signals.noChangeStreak} 次无变化的建议：先减少无效重复，不先削探索预算与必要持久化（§35.2）`,
            resumeWhen: '有实质变化事件或成本下降后再重新检查能力',
            allowsDegradedWrites: false,
        };
    }
    return { break: false, reason: '未达熔断条件', resumeWhen: policy.resumeWhen ?? '持续观察成本与收益信号', allowsDegradedWrites: false };
}
/** 把熔断判定落成状态迁移；不达条件时原样返回，不产生半次变更。 */
export function applyBreaker(state, mechanismId, signals, now, detail = {}) {
    const policy = mechanismHead(state, mechanismId);
    if (policy === undefined) {
        const verdict = { break: false, reason: `机制 ${mechanismId} 不存在`, resumeWhen: '', allowsDegradedWrites: false };
        return { ok: false, state, breaker: verdict, reason: verdict.reason };
    }
    const breaker = breakerFor(policy, signals, mechanismSpend(state, mechanismId));
    if (!breaker.break || breaker.target === undefined)
        return { ok: true, state, mechanism: policy, breaker };
    const moved = transitionMechanism(state, mechanismId, breaker.target === 'cooling' ? 'enter_cooling' : 'enter_observe_only', now, {
        reason: breaker.reason,
        resumeWhen: breaker.resumeWhen,
        actorId: detail.actorId,
        basis: detail.basis,
    });
    if (!moved.ok)
        return { ok: false, state, mechanism: moved.mechanism, breaker, reason: moved.reason };
    return { ok: true, state: moved.state, mechanism: moved.mechanism, breaker };
}
/**
 * 冷却 / 仅观察结束后的重新检查（§35.3）。
 *
 * 通过只回到 `observing`——重新积累观察，不直接恢复 active；不通过就继续停用。
 * 重启或换会话都不能清除已持久化的成本与故障状态，这里也不提供任何"清状态"的捷径。
 */
export function recheckAfterCooldown(state, mechanismId, capability, now, actorId) {
    const policy = mechanismHead(state, mechanismId);
    if (policy === undefined) {
        return { ok: false, state, failureAssumedRepaired: false, autoRestartCancelledTasks: false, reason: `机制 ${mechanismId} 不存在` };
    }
    if (policy.status !== 'cooling' && policy.status !== 'observe_only') {
        return { ok: false, state, mechanism: policy, failureAssumedRepaired: false, autoRestartCancelledTasks: false, reason: `机制 ${mechanismId} 不在 cooling / observe_only，无需重新检查` };
    }
    if (!capability.capable) {
        return {
            ok: false,
            state,
            mechanism: policy,
            failureAssumedRepaired: false,
            autoRestartCancelledTasks: false,
            reason: `能力检查未通过（${capability.note}）：继续保持停用，不视为故障已修复`,
        };
    }
    const moved = transitionMechanism(state, mechanismId, 'demote_to_observing', now, {
        reason: `冷却结束：仅重新核对了能力（${capability.note}），故障未视为已修复，不回 active；已取消的任务不自动重启（§35.3）`,
        actorId,
    });
    if (!moved.ok) {
        return { ok: false, state, mechanism: moved.mechanism, failureAssumedRepaired: false, autoRestartCancelledTasks: false, reason: moved.reason ?? '状态迁移失败' };
    }
    return {
        ok: true,
        state: moved.state,
        mechanism: moved.mechanism,
        failureAssumedRepaired: false,
        autoRestartCancelledTasks: false,
        reason: '回到 observing 重新积累观察；重启或换会话不清除已持久化的成本与故障状态（§35.3）',
    };
}
/** 缓存键含目标、规则、证据与环境中与该机制有关的版本（§35.2）：任一变化即失效。 */
export function governanceCacheKey(input) {
    return [
        `${input.mechanismId}@${input.mechanismVersion}`,
        `target=${input.target}`,
        `rule=${String(input.ruleRevision)}`,
        `evidence=${String(input.evidenceRevision)}`,
        `env=${String(input.environmentVersion)}`,
    ].join('|');
}
/**
 * 分层触发（§35.2）：日常按字段和状态检查，语义分析只在有实质变化时调用。
 *
 * 停用 / 退役的机制直接不调用；命中缓存且未过期的跳过；缓存过期不等于可以继续用旧判断，
 * 而是回落到最便宜的字段层重算。
 */
export function triggerLayer(input) {
    const decide = (layer, reason) => ({ layer, reason, cacheKey: input.cacheKey });
    if (input.policy.status === 'retired')
        return decide('skip', '机制已退役：不再调用（§35.4）');
    if (input.policy.status === 'cooling' || input.policy.status === 'observe_only')
        return decide('skip', `机制处于 ${input.policy.status}：按范围停用，不消耗治理预算（§35.3）`);
    if (input.policy.status === 'candidate')
        return decide('skip', '候选机制尚未进入服务：不产生判定（§35.1）');
    const cached = input.cached;
    const fresh = cached !== undefined && cached.key === input.cacheKey && (cached.ttlMs === undefined || input.now - cached.at <= cached.ttlMs);
    if (fresh && input.previousVerdictStale !== true) {
        return decide('skip', '命中缓存：目标 / 规则 / 证据 / 环境相关版本都未变（§35.2）');
    }
    const expired = cached !== undefined && cached.key === input.cacheKey && !fresh;
    if ((input.semanticMagnitude ?? 'none') === 'substantial') {
        return decide('semantic', '有实质变化：调用语义分析，其余情况只做字段与状态检查（§35.1、§35.2）');
    }
    if (input.fieldStateChanged || input.relevantRevisionsChanged || expired || input.previousVerdictStale === true) {
        return decide('field_state', expired ? '缓存已过期：不能长期复用旧判断，回落字段层重算（§35.2）' : '字段或状态变化：先做便宜的增量检查（§35.2）');
    }
    return decide('skip', '没有变化事件：不重算，也不因每条无关消息变化而全部重算（§35.2）');
}
/**
 * 收益评估（§35.4）：看实际避免或发现了什么、误报导致的延迟、恢复是否成功——
 * **不**把拦截次数直接当成功；归因不清的观察只计入不确定，不参与结论；
 * 归因清楚的观察不到两次就保留"证据不足"。
 */
export function assessBenefit(policy, runs, observations) {
    const byRun = new Map(runs.map((run) => [run.runId, run]));
    const clear = observations.filter((item) => item.attribution === 'clear' && byRun.has(item.runId));
    const unclearRuns = observations.filter((item) => item.attribution === 'unclear').length;
    const found = clear.reduce((sum, item) => sum + (item.found?.length ?? 0), 0);
    const avoided = clear.reduce((sum, item) => sum + (item.avoided?.length ?? 0), 0);
    const delayMs = clear.reduce((sum, item) => sum + (item.delayMs ?? 0), 0);
    const misreports = runs.filter((run) => run.misreport === 'yes').length;
    const base = { attributedRuns: clear.length, unclearRuns, found, avoided, misreports, delayMs };
    if (clear.length < MIN_BENEFIT_OBSERVATIONS) {
        return {
            ...base,
            verdict: 'insufficient_evidence',
            reason: `归因清楚的观察只有 ${clear.length} 次（另有 ${unclearRuns} 次归因不清）：不凭单次观察宣称有收益，也不凭它退役（§35.4）`,
        };
    }
    if (found + avoided === 0) {
        return {
            ...base,
            verdict: 'low_benefit',
            reason: `在 ${clear.length} 次归因清楚的观察里没有避免或发现任何东西；拦截次数本身不算收益（§35.4）`,
        };
    }
    if (misreports >= clear.length) {
        return {
            ...base,
            verdict: 'low_benefit',
            reason: `误报 ${misreports} 次不少于有效观察 ${clear.length} 次：误报导致的延迟已超过收益（§35.4）`,
        };
    }
    return {
        ...base,
        verdict: 'beneficial',
        reason: `在 ${clear.length} 次归因清楚的观察里避免了 ${avoided} 项、发现 ${found} 项（收益信号：${policy.benefitSignal}）`,
    };
}
/** 退出条件（§35.4）：可选机制先退观察、再退役；必需规则要动必须由规则所有者或已有授权决定。 */
export function exitVerdict(policy, benefit, input = {}) {
    if (benefit.verdict === 'insufficient_evidence') {
        return { action: 'keep', reason: '证据不足：保留不确定，不凭单次观察升格或退役（§35.4）' };
    }
    if (benefit.verdict === 'beneficial') {
        return { action: 'keep', reason: `${policy.name} 有归因清楚的收益，维持现状；不因拦截次数多而加码纪律` };
    }
    if (policy.class !== 'optional_advisory') {
        return {
            action: 'requires_rule_owner',
            reason: `${policy.class} 属于必需纪律：长期低收益也不由模型自动退役，必须由规则所有者或已有授权决定，并保留版本与退役理由（§35.4）`,
        };
    }
    if (input.coveredBySimplerMechanism === true) {
        return { action: 'retire', reason: '可选机制已被更简单的机制覆盖：可直接退役，保留版本与理由，派生上下文同步更新（§35.4）' };
    }
    if (input.alreadyInObserveOnly === true || policy.status === 'observe_only') {
        return { action: 'retire', reason: '可选机制在观察期仍无收益：可退役；保留版本与退役理由，防止旧摘要再次启用已撤销纪律（§35.4）' };
    }
    return { action: 'step_down_to_observing', reason: '可选机制长期低收益 / 高重复：先退到观察，再退役（§35.4）' };
}
function compareId(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
