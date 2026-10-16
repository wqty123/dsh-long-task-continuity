import { INITIAL_ACTION_STATE, assessContext, compactionPreflight, coverageFromState, frameDrifts, freezeFrame, freshnessRefsFromState, planActionRun, refResolvable, reuseAssessment, structuralFindingsFromState, unverifiedFactsFromState, verifyPostCompaction, } from '../core/context-quality.js';
import { collectContextQuality, invokeCompaction, observationFingerprint, outcomeAfterVerification, retainedRefs } from './dsh-context.js';
/** 判定层（§27.3）：轮末与 idle 维护走确定性层；语义层由里程碑/纠正后/停滞复核另行触发。 */
const TIER = 'deterministic';
/**
 * 动作状态没走完时的"未通过"报告：只有 `completed` 的调用才需要（也只允许）核对，
 * 其余状态 `outcomeAfterVerification` 会沿用即时结论，这份报告只是占位（不留空口子）。
 */
const NOT_VERIFIED = {
    ok: false,
    missing: ['压缩调用未走到"完成"：没有可核对的观测面，按未通过处理'],
    frameDrifts: [],
    nextStep: 'rebuild_from_authoritative_state',
    notes: [],
};
/**
 * 跑一次质量决策链（§27.2–§27.5）。
 *
 * 顺序即 §27.5 的硬顺序：先持久化依据（评估落盘）→ 再判入口能不能走（`planActionRun`）→
 * 压缩前清点关键对象 → 版本复核 → 调用原生压缩 → 逐项核对 → 记录动作结果。
 * 每一步的结论都写进 `steps`/`notes` 并尽量落盘；落不了盘也照实报告，不做"计划即成功"的等价替换。
 */
export async function runQualityChain(input) {
    const steps = [];
    const notes = [];
    const step = (text) => {
        steps.push(text);
    };
    const note = (text) => {
        notes.push(text);
    };
    let fingerprint = '';
    let degradation = [];
    const report = (extra = {}) => ({
        fingerprint,
        degradation,
        steps,
        notes,
        ...extra,
    });
    // —— 0) 任务不在执行中：整条链跳过（§27.2 第 1 条不变量：unknown ≠ 健康，也不在非执行态任务上做维护） ——
    const missionStatus = input.state.mission.status;
    if (!input.missionActive || missionStatus !== 'active') {
        step(`质量链跳过：${input.missionActive ? `记录里 mission.status=${missionStatus}，以记录为准` : 'missionActive=false'}（§27.5 第 3 条：不在非执行态的任务上做维护）`);
        return report({ skipped: `任务不在执行中（mission=${missionStatus}）：不评估、不压缩、不落任何"已完成"` });
    }
    // —— 1) 观测：任务侧权威输入由状态构造，适配层只观测宿主面（§27.3） ——
    const required = coverageFromState(input.state);
    const versionRefs = freshnessRefsFromState(input.state);
    const structuralFindings = structuralFindingsFromState(input.state);
    const unverifiedFacts = unverifiedFactsFromState(input.state);
    const nextAction = latestCheckpointOf(input.state)?.nextAction;
    const collection = collectContextQuality({
        host: input.host,
        session: input.session,
        ...(input.nativeBudget === undefined ? {} : { nativeBudget: input.nativeBudget }),
        ...(input.readings === undefined ? {} : { readings: input.readings }),
        ...(input.settings === undefined ? {} : { settings: input.settings }),
        required,
        versionRefs,
        structuralFindings,
        unverifiedFacts,
        ...(nextAction === undefined || nextAction.trim().length === 0 ? {} : { nextAction }),
    });
    fingerprint = collection.fingerprint;
    degradation = collection.degradations;
    step(`观测：指纹 ${fingerprint}；必需条件 ${required.length} 项、版本引用 ${versionRefs.length} 项、` +
        `结构化矛盾线索 ${structuralFindings.length} 条、无法核对事实 ${unverifiedFacts.length} 项` +
        `${degradation.length === 0 ? '' : `；观测退化 ${degradation.length} 条（可能读不到，读不到不等于健康）`}`);
    // —— 2) 冻结版本 + 保留清单（§27.5 第 1、2 条） ——
    const retentionList = retentionListFromState(input.state);
    const frame = frameFromReadings(collection.readings, input.state, input.sessionId, collection.fingerprint);
    const freeze = freezeFrame(input.state, {
        requestFingerprint: frame.requestFingerprint,
        sessionId: input.sessionId,
        sessionRevision: frame.sessionRevision,
        criteriaRevision: frame.criteriaRevision,
        retentionList,
    });
    step(`冻结：sessionRevision=${freeze.sessionRevision}、criteriaRevision=${freeze.criteriaRevision}、` +
        `objectiveRevision=${freeze.objectiveRevision}、policyRevision=${freeze.policyRevision}、保留清单 ${retentionList.length} 项`);
    // —— 3) 复用门（§27.3）：同请求同状态版本不重复评估；已执行/已终态的同版本动作不反复压缩 ——
    let assessment;
    let assessmentId;
    let current = input.state;
    const prior = reuseAssessment(input.state, freeze, TIER);
    if (prior !== undefined) {
        const priorState = prior.actionState ?? INITIAL_ACTION_STATE;
        if (priorState === 'running' || priorState === 'done' || priorState === 'failed' || priorState === 'skipped') {
            step(`复用检查：命中 ${prior.assessmentId}@${priorState}——本轮不再压缩、不忙循环重试（§27.3 复用、§27.5 第 3 条）`);
            return report({
                skipped: `同一版本（指纹 ${freeze.requestFingerprint}）下已有评估 ${prior.assessmentId}（actionState=${priorState}）：不重复评估、不反复压缩`,
                assessmentId: prior.assessmentId,
                suggestedAction: prior.suggestion,
                decisionReason: prior.reason,
            });
        }
        // recorded/queued：同版本、同指纹的既有评估仍是当前依据，直接复用，不重复评估（§27.3）。
        assessment = prior;
        assessmentId = prior.assessmentId;
        step(`复用评估 ${prior.assessmentId}（actionState=${priorState}，同版本同指纹，不重复评估；§27.3）`);
    }
    else if (input.commit === undefined) {
        const local = assessContext(input.state, { actorId: input.actorId, freeze, signals: collection.signals, tier: TIER }, input.now);
        step('未提供 commit：只做观测与本地判定，不落盘、不压缩（§27.5 第 1 条：先持久化依据，再谈动作）');
        return report({
            skipped: '未提供 commit（落盘入口）：本轮不落盘、不执行动作、不压缩',
            ...(local.ok ? { suggestedAction: local.assessment.suggestion, decisionReason: local.assessment.reason } : {}),
        });
    }
    else {
        const recorded = await commitAssessment(input, freeze, collection.signals);
        if (!recorded.ok) {
            step(`评估未落盘：${recorded.reason}（§27.5 第 1 条：依据没落盘就不谈动作）`);
            return report({ skipped: `评估未落盘：${recorded.reason}` });
        }
        assessment = recorded.assessment;
        assessmentId = recorded.assessmentId;
        if (recorded.state !== undefined)
            current = recorded.state;
        step(`评估已落盘：建议 ${assessment.suggestion}（${assessment.reason}）`);
        if (assessmentId === undefined) {
            note('落盘后解析不到内核发号的 assessmentId（提交结果不带 state 且未提供/未返回 reload）：为避免拿错的 id 继续提交，本链停在记录建议');
            step('动作未执行：解析不到 assessmentId，不拿本地预览 id 提交（§27.5 第 5 条）');
        }
    }
    const suggested = assessment.suggestion;
    const reason = assessment.reason;
    if (assessmentId === undefined) {
        return report({ skipped: 'assessmentId 未解析：本轮只记录建议，不执行动作', suggestedAction: suggested, decisionReason: reason });
    }
    // —— 4) 入口计划（§27.5 第 3 条）：活跃/被占用/入口不符一律排队或跳过，并**如实落盘** ——
    const plan = planActionRun(assessment, {
        entry: input.entry,
        sessionActive: input.sessionActive,
        maintenanceEntryFree: input.maintenanceEntryFree,
        ...(input.rotationPending === undefined ? {} : { rotationPending: input.rotationPending }),
        ...(input.calibrationAcknowledged === undefined ? {} : { calibrationAcknowledged: input.calibrationAcknowledged }),
    });
    const planned = report({ assessmentId, suggestedAction: suggested, decisionReason: reason, plan });
    if (plan.kind !== 'run_now') {
        const moved = await submitCommand(input, { kind: 'context.applyRunPlan', requestId: `qp:${assessmentId}:${plan.kind}`, assessmentId, plan });
        const occupied = !input.maintenanceEntryFree || input.rotationPending === true;
        step(plan.kind === 'queue'
            ? `压缩未执行：${occupied ? '入口被占用（轮换与压缩共享互斥入口）' : '会话活跃/入口不符'}，按结论排队（${plan.reason}）`
            : `压缩未执行：按结论跳过（${plan.reason}）`);
        if (moved.applied)
            step(`计划已落盘：actionState=${plan.kind === 'queue' ? 'queued' : 'skipped'}（不是执行成功，只是"没执行"的结论）`);
        else
            note(`计划未落盘：${moved.reason}；本轮只留回执`);
        return planned;
    }
    // —— 5) 只有 compress 由本链真正执行；其余建议只记录（§27.4：执行面在别的层） ——
    if (suggested !== 'compact') {
        step(`建议 ${suggested} 已记进评估：本链只执行 compact，${suggested} 的执行与结果由对应层提交（§27.5 第 5 条）`);
        note(`建议 ${suggested} 未执行：${reason}`);
        return planned;
    }
    // —— 6) 压缩前清点（§27.5 第 1 条）：关键对象必须已在权威状态里，缺项就不压 ——
    const preflight = compactionPreflight(current, freeze.retentionList);
    step(`压缩前清点：${preflight.ready ? `通过（${preflight.durable.length} 项已持久化）` : `缺项 ${preflight.missing.length} 条`}`);
    if (!preflight.ready) {
        const shortfallNote = `压缩前清点缺项：${preflight.missing.join('；')}；从权威状态重建任务上下文，必要时安全轮换，不通过反复压缩修复内容缺失（§27.5 第 1、4 条）`;
        const moved = await submitCommand(input, {
            kind: 'context.applyRunPlan',
            requestId: `qp:${assessmentId}:preflight`,
            assessmentId,
            plan: { kind: 'skip', reason: shortfallNote },
        });
        step(`压缩未执行：压缩前清点缺项 ${preflight.missing.length} 条（重建/轮换，不反复压缩）`);
        if (moved.applied)
            step('结论已落盘：actionState=skipped（缺项按短差报告，不是 done）');
        else
            note(`压缩前清点的跳过结论未落盘：${moved.reason}`);
        // 短差返回沿用 `planned`（已带 assessmentId/建议/理由/plan），只追加 outcome：
        // 上游要靠这四字段收口与定位"卡在闸门 6"，返回裸对象等于把凭据丢了。
        return { ...planned, outcome: { kind: 'shortfall', missing: preflight.missing } };
    }
    // —— 7) 压缩前版本复核（§27.5 第 2 条）：冻结之后会话或版本变了就不许按旧版本压 ——
    if (input.refetchFrame === undefined) {
        step('压缩前版本复核：未提供观测入口，改用引擎侧 changed 校验兜底（§27.5 第 2、3 条）');
        note('未提供 refetchFrame：压缩前的版本复核缺席，只由原生 compactNow 的 changed 校验兜底（不宣称版本一致）');
    }
    else {
        let refreshed;
        try {
            refreshed = await input.refetchFrame();
        }
        catch (error) {
            note(`压缩前版本复核读取失败：${messageOf(error)}；按未核对处理（unknown ≠ 健康）`);
        }
        if (refreshed === undefined) {
            step('压缩前版本复核：取不到当前版本，按未核对记录（不宣称版本一致）');
        }
        else {
            const drifts = frameDrifts(freeze, refreshed);
            const blocking = drifts.filter((drift) => drift.blocking);
            if (blocking.length > 0) {
                const detail = blocking.map((drift) => drift.detail).join('；');
                const invalidated = await submitCommand(input, { kind: 'context.invalidateAssessment', requestId: `qi:${assessmentId}`, assessmentId, current: refreshed });
                step(`压缩未执行：压缩前版本复核发现阻断性漂移 —— ${detail}`);
                if (invalidated.applied)
                    note('旧评估已按当前版本标废：重新检查后再谈压缩（§27.5 第 2 条）');
                else
                    note(`旧评估标废未落盘：${invalidated.reason}`);
                return planned;
            }
            step(`压缩前版本复核：无阻断性漂移${drifts.length === 0 ? '' : `（记录水位推进 ${drifts.length} 条，只报告不阻断）`}`);
        }
    }
    // —— 8) 进入执行 + 调用原生压缩（§27.5 第 3 条）：先落盘 run_now，再动宿主 ——
    const started = await submitCommand(input, { kind: 'context.applyRunPlan', requestId: `qp:${assessmentId}:run`, assessmentId, plan });
    if (!started.applied) {
        step(`压缩未执行：计划未落盘（${started.reason}）——不凭未落盘的计划动宿主`);
        note(`进入执行的计划未落盘：${started.reason}`);
        return planned;
    }
    step('进入执行：run_now 已落盘（actionState=running），按互斥入口调用压缩');
    let calls = 0;
    let lastCall;
    const injected = input.compaction;
    const port = injected === undefined
        ? undefined
        : {
            compactNow: async (session) => {
                calls += 1;
                const result = await injected.compactNow(session);
                lastCall = result;
                return result;
            },
        };
    const invocation = await invokeCompaction({ plan, freeze, session: input.session, ...(port === undefined ? {} : { compaction: port }) });
    step(invocation.called
        ? `压缩调用：${invocation.status}${lastCall?.reclaimedTokens === undefined ? '' : `（估算回收 ~${lastCall.reclaimedTokens} token）`}`
        : `压缩未执行：${invocation.detail}`);
    if (!invocation.called)
        note(`未调用压缩：${invocation.detail}`);
    if (calls === 0 && injected !== undefined)
        note('压缩端口已注入但未被调用：按实际状态报告，不记成功（§27.5 第 3 条）');
    // —— 9) 压缩后核对（§27.5 第 4 条）：completed 只代表调用返回，核对才算闭环 ——
    let verification;
    if (invocation.status === 'completed') {
        let observation;
        if (input.verifyObservation === undefined) {
            observation = { keptRefs: [] };
            step('压缩后核对：没有观测入口，保留清单与容量/版本一律照未读处理（缺项进 missing）');
            note('未提供 verifyObservation：压缩后没有核对入口，不得宣称"已恢复"（§27.5 第 4 条）');
        }
        else {
            try {
                observation = await input.verifyObservation();
            }
            catch (error) {
                observation = { keptRefs: [] };
                note(`压缩后核对观测读取失败：${messageOf(error)}；按缺项处理，不宣称通过`);
            }
        }
        verification = verifyPostCompaction(freeze, observation);
        step(verification.ok ? `核对通过：${verification.capacityNote ?? '保留清单、引用可解析、新请求容量与当前版本四项均有证据'}` : `核对缺项：${verification.missing.join('；')}`);
        for (const item of verification.notes)
            note(`核对说明：${item}`);
        for (const item of verification.missing)
            note(`核对缺项：${item}`);
    }
    // —— 10) 结果收口（§27.5 第 5 条）：done/shortfall/busy/failed/declined 都是明确结果，不是"计划" ——
    const base = outcomeAfterVerification(invocation, verification ?? NOT_VERIFIED);
    const outcome = base.kind === 'done' && lastCall?.reclaimedTokens !== undefined
        ? { ...base, effect: { ...base.effect, reclaimedTokens: lastCall.reclaimedTokens } }
        : base;
    const closed = await submitCommand(input, { kind: 'context.applyActionOutcome', requestId: `qo:${assessmentId}:${outcome.kind}`, assessmentId, outcome });
    step(`结果收口：${outcome.kind}${closed.applied ? '（已落盘）' : `（未落盘：${closed.reason}）`}`);
    if (!closed.applied)
        note(`动作结果未落盘：${closed.reason}——本轮结论只在回执里，不吞错误`);
    return report({ assessmentId, suggestedAction: suggested, decisionReason: reason, plan, invocation, ...(verification === undefined ? {} : { verification }), outcome });
}
/**
 * 落一条评估（§27.5 第 1、2 条：先持久化依据，再谈动作）。
 *
 * 本地先按同一份信号算一遍：算得出才提交（本地就通不过的坏记录不往核心里送）；
 * 提交用**新 requestId**（内核的 assessmentId 是 `mintId('cqa')` 发的号，不能靠 requestId 推）；
 * 提交后用"结果带回的 state 差分 / reload() 差分 / 同帧复用命中"三种方式解析真实 id。
 */
async function commitAssessment(input, freeze, signals) {
    const local = assessContext(input.state, { actorId: input.actorId, freeze, signals, tier: TIER }, input.now);
    if (!local.ok)
        return { ok: false, reason: `本地判定被拒：${local.reason}` };
    const commit = input.commit;
    if (commit === undefined)
        return { ok: false, reason: '未提供 commit（落盘入口）' };
    const requestId = `qca:${input.sessionId}:${freeze.requestFingerprint}:${input.state.revision}:${nextAssessSeq()}`;
    let result;
    try {
        result = await commit({ kind: 'context.assess', requestId, input: { actorId: input.actorId, freeze, signals, tier: TIER } });
    }
    catch (error) {
        return { ok: false, reason: `提交抛错：${messageOf(error)}` };
    }
    if (!result.applied)
        return { ok: false, reason: `落盘被拒：${result.reason ?? '未给出原因'}` };
    const after = await resolveState(input, result);
    const assessmentId = after === undefined
        ? undefined
        : addedAssessmentId(input.state, after, freeze) ?? reuseAssessment(after, freeze, TIER)?.assessmentId;
    return { ok: true, assessment: local.assessment, assessmentId, state: after };
}
/** 提交后拿最新记录：优先用提交结果里带回的 state，其次 `reload()`（读失败只记不抛）。 */
async function resolveState(input, result) {
    if (result.state !== undefined && result.state !== null)
        return result.state;
    if (input.reload === undefined)
        return undefined;
    try {
        const reloaded = await input.reload();
        return reloaded ?? undefined;
    }
    catch {
        return undefined;
    }
}
/** 提交前后的差分：新出现的、且与本次冻结帧同帧的评估就是内核刚落盘的那条。 */
function addedAssessmentId(before, after, freeze) {
    const known = new Set(Object.keys(before.assessments));
    return Object.values(after.assessments)
        .filter((item) => !known.has(item.assessmentId))
        .filter((item) => item.requestFingerprint === freeze.requestFingerprint && (item.sessionId ?? '') === (freeze.sessionId ?? ''))
        .sort((a, b) => a.missionRevision - b.missionRevision || (a.assessmentId < b.assessmentId ? -1 : 1))
        .map((item) => item.assessmentId)
        .pop();
}
/** 提交一条命令：抛错/被拒都不抛出，统一成 `{applied:false, reason}`，由调用方写进 notes。 */
async function submitCommand(input, cmd) {
    const commit = input.commit;
    if (commit === undefined)
        return { applied: false, reason: '未提供 commit（落盘入口）' };
    try {
        const result = await commit(cmd);
        return {
            applied: result.applied,
            reason: result.applied ? '' : result.reason ?? '未给出原因',
            ...(result.state === undefined || result.state === null ? {} : { state: result.state }),
        };
    }
    catch (error) {
        return { applied: false, reason: `提交抛错：${messageOf(error)}` };
    }
}
let assessSeq = 0;
function nextAssessSeq() {
    assessSeq += 1;
    return assessSeq;
}
// —— 任务侧输入的派生与组装（导出给调用方复用，保证调用侧与判定侧同一把尺） ——
/**
 * 由观测读数与当前记录拼一帧版本（§27.5 第 2 条）。
 *
 * 调用方实现 `refetchFrame` 时就用它：`frameFromReadings(contextReadingsOf(session, settings), await kernel.read(id), sessionId)`
 * ——基准与判定侧完全一致，`frameDrifts` 才对得上（同一次冻结不许有两套口径）。
 */
export function frameFromReadings(readings, state, sessionId, requestFingerprint) {
    return {
        sessionId,
        sessionRevision: sessionRevisionFrom(readings),
        missionRevision: state.revision,
        objectiveRevision: state.mission.objectiveRevision,
        policyRevision: state.mission.policyRevision,
        criteriaRevision: criteriaRevisionFromState(state),
        requestFingerprint: requestFingerprint ?? observationFingerprint({ budget: readings.budget, timeline: readings.reads.timeline, headers: readings.reads.headers, activity: readings.reads.activity }),
    };
}
/**
 * 会话版本号的读写口径（§27.5 第 2 条）：取观测面上所有能读到的 `seq` 的最大值
 * （`last.seq`、`detailRev`、requests/events/nodes/archive 的 `seq`），这是"会话推进到哪"的单调量；
 * 一个 seq 都读不到时退回计数面（turns+steps），仍读不到就是 0——**明确记 0**，不假装冻结到了某个版本。
 */
export function sessionRevisionFrom(readings) {
    const read = readings.reads.timeline;
    const state = read.availability === 'ok' ? read.state : undefined;
    const seen = [];
    const seek = (value) => {
        if (typeof value === 'number' && Number.isFinite(value))
            seen.push(value);
    };
    const seekAll = (items) => {
        for (const item of items ?? [])
            seek(item?.seq);
    };
    seek(state?.last?.seq);
    seek(state?.detailRev);
    seekAll(state?.requests);
    seekAll(state?.events);
    seekAll(state?.nodes);
    seekAll(state?.archive);
    if (seen.length > 0)
        return Math.max(...seen);
    const turns = typeof state?.counts?.turns === 'number' && Number.isFinite(state.counts.turns) ? state.counts.turns : undefined;
    const steps = typeof state?.counts?.steps === 'number' && Number.isFinite(state.counts.steps) ? state.counts.steps : undefined;
    if (turns === undefined && steps === undefined)
        return 0;
    return (turns ?? 0) + (steps ?? 0);
}
/**
 * 判据版本（§27.5 第 2 条）：取"最新检查点的 criteriaRevision"与"各任务 criteriaRevision 的最大值"
 * 中的较大者——任务书在检查点之后被修订时旧评估必须失效，取 max 才是 fail-safe 的一侧。
 */
export function criteriaRevisionFromState(state) {
    let revision = 0;
    const checkpoint = latestCheckpointOf(state);
    if (checkpoint !== undefined)
        revision = checkpoint.criteriaRevision;
    for (const task of Object.values(state.tasks))
        revision = Math.max(revision, task.criteriaRevision);
    return revision;
}
/**
 * 目标保留清单（§27.5 第 1、2 条）：压缩后逐项核对的**任务侧**引用。
 *
 * 只收权威状态里能解析的对象：最新检查点、非终态操作、结论链头（含其证据引用）、生效规则、
 * 未撤销授权。清单里的每一项都在记录里——压缩不该让它们变得不可解析；会话内容丢了要能靠这些重建。
 */
export function retentionListFromState(state) {
    const refs = new Set();
    const checkpoint = latestCheckpointOf(state);
    if (checkpoint !== undefined)
        refs.add(checkpoint.checkpointId);
    for (const [operationId, operation] of sortedEntries(state.operations)) {
        if (operation.status === 'succeeded' || operation.status === 'failed')
            continue;
        refs.add(operationId);
    }
    for (const chain of sortedChains(state.claims)) {
        const head = chain[chain.length - 1];
        if (head === undefined)
            continue;
        refs.add(head.claimId);
        for (const evidenceId of [...head.supportingEvidenceIds, ...head.contradictingEvidenceIds])
            if (evidenceId.trim().length > 0)
                refs.add(evidenceId);
    }
    for (const [ruleId, chain] of sortedEntries(state.rules)) {
        if (chain[chain.length - 1]?.status === 'active')
            refs.add(ruleId);
    }
    for (const [grantId, grant] of sortedEntries(state.grants)) {
        if (grant.revokedAt === undefined)
            refs.add(grantId);
    }
    return [...refs].sort();
}
/**
 * 压缩后观测面的组装（§27.5 第 4 条）：给主代理在 `verifyObservation` 里直接用。
 *
 * `keptRefs` = 保留清单里仍能在权威状态解析的项 + 投影侧仍在场的服务清单（`retainedRefs` 的
 * `node:/archive:/event:`）；任务侧对象住在聚合记录里，压缩不该让它们消失，这正是清点的意义。
 * 容量与当前版本读不到就不填——`verifyPostCompaction` 会把未读到的项算进缺项，不宣称"已恢复"。
 */
export function postCompactionObservation(input) {
    const kept = new Set();
    for (const ref of input.retentionList)
        if (refResolvable(input.state, ref))
            kept.add(ref);
    if (input.readings !== undefined)
        for (const ref of retainedRefs(input.readings.reads.timeline))
            kept.add(ref);
    const capacityAfter = input.capacityAfter ??
        (input.readings === undefined
            ? undefined
            : {
                ...(input.readings.pressureTokens === null ? {} : { requestEstimateTokens: input.readings.pressureTokens }),
                ...(input.readings.contextWindowTokens === null ? {} : { contextWindowTokens: input.readings.contextWindowTokens }),
            });
    return {
        keptRefs: [...kept].sort(),
        ...(input.unresolvableRefs === undefined || input.unresolvableRefs.length === 0 ? {} : { unresolvableRefs: [...input.unresolvableRefs].sort() }),
        ...(capacityAfter === undefined ? {} : { capacityAfter }),
        ...(input.current === undefined ? {} : { current: input.current }),
    };
}
// —— 工具 ——
function latestCheckpointOf(state) {
    const id = state.checkpointOrder[state.checkpointOrder.length - 1];
    return id === undefined ? undefined : state.checkpoints[id];
}
/** 记录键序无意义：一律显式排序，回执可在不同宿主上复现。 */
function sortedEntries(record) {
    return Object.entries(record).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
function sortedChains(claims) {
    return Object.entries(claims)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map((entry) => entry[1]);
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
