import { INEFFECTIVE_RESULTS } from './entities.js';
/**
 * 判据是否按**当前版本**通过。
 *
 * 三条口径来自设计稿：`unknown/error/not_run` 不折算成 pass（§6.4）；
 * `not_applicable` 必须有适用性规则与理由（§6.4）；验证后产物内容变了，
 * 旧验证不能继续证明新版本（§8）。
 */
export function criteriaReport(state, task) {
    const proofs = [];
    const blockers = [];
    for (const criterion of task.criteria) {
        if (!criterion.required)
            continue;
        const records = Object.values(state.verifications)
            .filter((item) => item.taskId === task.taskId && item.criterionId === criterion.criterionId && item.criteriaRevision === task.criteriaRevision)
            .sort((a, b) => b.verifiedAt - a.verifiedAt);
        const latest = records[0];
        if (latest === undefined) {
            proofs.push({ criterion, outcome: 'no_record', reason: '该判据在当前判据版本下没有验证记录' });
            blockers.push(`${criterion.criterionId}：无验证记录`);
            continue;
        }
        if (latest.outcome === 'pass') {
            if (latest.artifactId !== undefined && artifactChanged(state, latest)) {
                proofs.push({ criterion, outcome: 'stale_artifact', reason: `产物在验证后变化，${latest.verificationId} 不再证明当前版本`, verification: latest });
                blockers.push(`${criterion.criterionId}：产物已变化需重验`);
                continue;
            }
            if (latest.validatorId !== undefined && validatorEligible(state, latest.validatorId, latest) === undefined) {
                proofs.push({ criterion, outcome: 'unproven', reason: `验证器 ${latest.validatorId} 在当前范围与版本上没有有效资格`, verification: latest });
                blockers.push(`${criterion.criterionId}：验证器资格无效`);
                continue;
            }
            // 单列零检查：没有跑过任何断言的 pass 与恒真断言同类，不构成资格（§22.10 DG-10）。
            if (latest.checksRun === 0) {
                proofs.push({ criterion, outcome: 'unproven', reason: '零检查（checksRun=0）的通过不构成证明', verification: latest });
                blockers.push(`${criterion.criterionId}：零检查`);
                continue;
            }
            proofs.push({ criterion, outcome: 'passed', reason: `${latest.method} 通过`, verification: latest });
            continue;
        }
        if (latest.outcome === 'fail') {
            proofs.push({ criterion, outcome: 'failed', reason: latest.detail ?? `按 ${latest.method} 判为不通过`, verification: latest });
            blockers.push(`${criterion.criterionId}：判为不通过`);
            continue;
        }
        if (latest.outcome === 'not_applicable') {
            const allowed = criterion.applicabilityRule !== undefined && (latest.applicabilityReason ?? '').length > 0;
            if (!allowed) {
                proofs.push({ criterion, outcome: 'unproven', reason: '缺适用性规则或豁免理由，不能按不适用绕过失败', verification: latest });
                blockers.push(`${criterion.criterionId}：不适用无依据`);
                continue;
            }
            proofs.push({ criterion, outcome: 'not_applicable', reason: `${criterion.applicabilityRule}：${latest.applicabilityReason}`, verification: latest });
            continue;
        }
        proofs.push({ criterion, outcome: 'unproven', reason: `${latest.outcome} 不折算成通过`, verification: latest });
        blockers.push(`${criterion.criterionId}：${latest.outcome}`);
    }
    return { proofs, satisfied: blockers.length === 0, blockers };
}
function artifactChanged(state, verification) {
    const groups = Object.values(state.artifacts);
    for (const group of groups) {
        const bound = group.some((item) => item.artifactId === verification.artifactId);
        if (!bound)
            continue;
        const current = group[group.length - 1];
        if (current === undefined)
            return false;
        // 绑定版本被同 uri 的新版本取代：旧 pass 只能证明旧版本，不再证明当前链头（§22.12 DG-12）。
        if (current.artifactId !== verification.artifactId)
            return true;
        return verification.contentHashAtVerification !== undefined && current.contentHash !== verification.contentHashAtVerification;
    }
    return false;
}
/** 资格只对已测版本、范围与样例成立；换了判据版本或范围就失效（§22.10）。 */
export function validatorEligible(state, validatorId, verification) {
    const chain = state.validators[validatorId];
    if (chain === undefined)
        return undefined;
    const head = chain[chain.length - 1];
    if (head === undefined || !head.eligible)
        return undefined;
    if (head.criteriaRevision !== undefined && verification.criteriaRevision !== head.criteriaRevision)
        return undefined;
    return head.qualifiedAt <= verification.verifiedAt ? head : undefined;
}
/**
 * 派单前的可识别互斥（§7.1）。
 *
 * 四类里只有 `mutate_and_freeze` 与 `scope_mismatch` 落在结构化字段上（资源键 / 输入引用 /
 * 排除项同时出现在判据文本里），可以作为拒绝依据；另两类靠关键词，属于疑点，
 * 进 Challenge 而不宣称为形式证明。
 */
export const STRUCTURAL_CONTRADICTIONS = ['mutate_and_freeze', 'scope_mismatch'];
const FREEZE_PATTERNS = ['不得改动', '不要改动', '保持不变', '不得修改', '不可变', '哈希不变', 'frozen', 'unchanged', 'must not change', 'hash stays'];
const ADD_FIELD_PATTERNS = ['新增字段', '增加字段', '加字段', 'add field'];
const FULL_HASH_PATTERNS = ['完整内容哈希', '内容哈希保持', '哈希保持', 'full content hash'];
const ADD_MEMBER_PATTERNS = ['新增枚举成员', '增加枚举成员', '加成员', 'add member', 'add enum member'];
const CLOSED_SET_PATTERNS = ['成员集合固定', '不得新增成员', '枚举集合不变', 'closed set', 'set is fixed'];
export function detectContradictions(input) {
    const findings = [];
    const texts = input.criteria.map((criterion) => `${criterion.criterionId}「${criterion.text}」`);
    for (const key of input.resourceKeys) {
        if (key.length === 0)
            continue;
        for (const text of texts) {
            const lower = text.toLowerCase();
            if (lower.includes(key.toLowerCase()) && FREEZE_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()))) {
                findings.push({ kind: 'mutate_and_freeze', detail: `要修改的对象同时被要求冻结：${key} ↔ ${text}` });
            }
        }
    }
    for (const text of texts) {
        const lower = text.toLowerCase();
        if (ADD_FIELD_PATTERNS.some((p) => lower.includes(p.toLowerCase())) && FULL_HASH_PATTERNS.some((p) => lower.includes(p.toLowerCase()))) {
            findings.push({ kind: 'add_field_and_full_hash', detail: `同时要求新增字段与完整内容哈希不变：${text}` });
        }
        if (ADD_MEMBER_PATTERNS.some((p) => lower.includes(p.toLowerCase())) && CLOSED_SET_PATTERNS.some((p) => lower.includes(p.toLowerCase()))) {
            findings.push({ kind: 'add_enum_and_closed_set', detail: `同时要求新增成员与成员集合封闭：${text}` });
        }
    }
    for (const exclusion of input.exclusions) {
        if (exclusion.length === 0)
            continue;
        const hit = input.inputRefs.filter((ref) => ref.includes(exclusion));
        if (hit.length > 0)
            findings.push({ kind: 'scope_mismatch', detail: `排除项 ${exclusion} 同时出现在输入引用里：${hit.join(', ')}` });
        const resourceHit = input.resourceKeys.filter((key) => key.includes(exclusion));
        if (resourceHit.length > 0)
            findings.push({ kind: 'scope_mismatch', detail: `排除项 ${exclusion} 同时被登记为要占用的资源：${resourceHit.join(', ')}` });
    }
    const unique = new Map();
    for (const finding of findings)
        unique.set(`${finding.kind}:${finding.detail}`, finding);
    return [...unique.values()];
}
export function isStructural(finding) {
    return STRUCTURAL_CONTRADICTIONS.includes(finding.kind);
}
/** 授权判定（§22.8）：动作、对象范围、环境、额度、期限、撤销逐一过，不靠"之前给过凭据"。 */
export function grantCovers(grant, action, objectRef, environment, now) {
    if (grant.revokedAt !== undefined)
        return { ok: false, reason: `授权 ${grant.grantId} 已撤销` };
    if (grant.expiresAt !== undefined && now > grant.expiresAt)
        return { ok: false, reason: `授权 ${grant.grantId} 已过期限` };
    if (!grant.actions.includes(action))
        return { ok: false, reason: `授权 ${grant.grantId} 不含动作 ${action}` };
    if (grant.environment !== 'any' && grant.environment !== environment)
        return { ok: false, reason: `授权 ${grant.grantId} 环境为 ${grant.environment}，不是 ${environment}` };
    if (grant.maxUses !== undefined && grant.usedCount >= grant.maxUses)
        return { ok: false, reason: `授权 ${grant.grantId} 次数额度用尽` };
    if (!objectInScope(grant.objectScope, objectRef))
        return { ok: false, reason: `对象 ${objectRef} 不在授权 ${grant.grantId} 的范围内` };
    return { ok: true, reason: `授权 ${grant.grantId} 覆盖 ${action} ${objectRef}` };
}
function objectInScope(scope, objectRef) {
    if (scope.length === 0)
        return false;
    return scope.some((entry) => entry === '*' || entry === objectRef || (entry.endsWith('*') && objectRef.startsWith(entry.slice(0, -1))));
}
/** 票据是否仍然对得上当前版本（§12.2、§22.6）。 */
export function ticketIsCurrent(state, ticket, now) {
    const task = state.tasks[ticket.taskId];
    if (task === undefined)
        return { ok: false, reason: '票据指向的任务已不存在' };
    if (task.currentAttemptId !== ticket.attemptId)
        return { ok: false, reason: '该任务的当前尝试已不是票据所属尝试' };
    if (task.objectiveRevision !== ticket.objectiveRevision || state.mission.objectiveRevision !== ticket.objectiveRevision) {
        return { ok: false, reason: `目标已修订（${ticket.objectiveRevision}→${state.mission.objectiveRevision}）` };
    }
    if (state.mission.policyRevision !== ticket.policyRevision)
        return { ok: false, reason: `规则快照已修订（${ticket.policyRevision}→${state.mission.policyRevision}）` };
    if (task.criteriaRevision !== ticket.criteriaRevision)
        return { ok: false, reason: `任务书或判据已修订（${ticket.criteriaRevision}→${task.criteriaRevision}）` };
    if (state.basisRevision !== ticket.basisRevision)
        return { ok: false, reason: `依据有效性已变化（${ticket.basisRevision}→${state.basisRevision}）` };
    for (const grantId of ticket.grantIds) {
        const grant = state.grants[grantId];
        if (grant === undefined)
            return { ok: false, reason: `授权 ${grantId} 已不在记录中` };
        if (grant.revokedAt !== undefined)
            return { ok: false, reason: `授权 ${grantId} 已被撤销` };
        if (grant.expiresAt !== undefined && now > grant.expiresAt)
            return { ok: false, reason: `授权 ${grantId} 已过期限` };
    }
    return { ok: true, reason: '票据与当前版本一致' };
}
/**
 * 版本重验：把轮换请求时冻结的快照与当前记录比对（§10.2、§23.2 第 1、3 条）。
 *
 * 只比这两个数，不做语义判断——语义级"这条结论还在不在"由下面的依赖传播负责，
 * 这里只保证携带旧版本的交接包不会绕过那次传播。放在 core 是因为提交点（COMMITTED）
 * 自己必须拒绝旧包：闸门只写在执行器里时，崩溃恢复路径与别的调用方都能绕过。
 */
export function revisionDrifts(rotation, state) {
    const drifts = [];
    if (rotation.basisRevisionAtRequest !== state.basisRevision) {
        drifts.push({
            kind: 'basis',
            atRequest: rotation.basisRevisionAtRequest,
            current: state.basisRevision,
            detail: `依据有效性版本已从请求时的 ${rotation.basisRevisionAtRequest} 推进到 ${state.basisRevision}：请求轮换之后有结论被撤回、证据失效或授权被撤销，旧交接包里的结论不能带进 S2`,
        });
    }
    if (rotation.policyRevisionAtRequest !== state.mission.policyRevision) {
        drifts.push({
            kind: 'policy',
            atRequest: rotation.policyRevisionAtRequest,
            current: state.mission.policyRevision,
            detail: `规则快照版本已从请求时的 ${rotation.policyRevisionAtRequest} 推进到 ${state.mission.policyRevision}：旧交接包里的规则段不代表当前生效规则`,
        });
    }
    return drifts;
}
/** 未闭环承诺：`verified/delivered/cancelled` 之外都算欠着（§22.7、§6.4）。 */
export function openObligations(state, taskId) {
    return Object.values(state.obligations).filter((item) => (taskId === undefined || item.taskId === taskId) && item.stage !== 'verified' && item.stage !== 'delivered' && item.stage !== 'cancelled');
}
/** 结论有效性检查：needs_review/invalid 的前提不能再支撑关键动作（§6.1、§22.6）。 */
export function ineffectiveClaimRefs(state) {
    const bad = [];
    for (const chain of Object.values(state.claims)) {
        const head = chain[chain.length - 1];
        if (head !== undefined && INEFFECTIVE_RESULTS.includes(head.validity))
            bad.push(`${head.claimId}@${head.version}=${head.validity}`);
    }
    return bad;
}
export function latestClaim(state, claimId) {
    const chain = state.claims[claimId];
    return chain === undefined ? undefined : chain[chain.length - 1];
}
/**
 * 检查点应当带走的未决质疑（§9.1、§22.4）。
 *
 * 给全量 open 项而不只是阻断项：交接包要让人看见"还有什么没裁"，
 * 是否挡入场仍由 `blockingChallenge` 单独判，两者不合并口径。
 * 带 `taskId` 时只列与该任务及其判据相关的；不带则是 Mission 级全列。
 */
export function openChallengeIds(state, taskId) {
    const ids = [];
    for (const challenge of Object.values(state.challenges)) {
        if (challenge.outcome !== 'open')
            continue;
        if (taskId !== undefined) {
            const owner = challenge.targetKind === 'criteria' ? challenge.targetId.split('@')[0] ?? '' : challenge.targetId;
            if (owner !== taskId && !challenge.targetId.startsWith(`${taskId}@`))
                continue;
        }
        ids.push(challenge.challengeId);
    }
    return ids.sort();
}
/**
 * 质疑的阻断范围（§22.4）：只有指向当前任务/判据的硬冲突才挡住入场，
 * 语义疑点与证据不足的质疑转成待审，不停掉整个团队。
 */
export function blockingChallenge(state, taskId) {
    for (const challenge of Object.values(state.challenges)) {
        if (challenge.outcome !== 'open')
            continue;
        if (challenge.severity === 'hard_conflict' && (challenge.targetId === taskId || challenge.targetId.startsWith(`${taskId}@`)))
            return challenge.challengeId;
        if (challenge.severity === 'hard_conflict' && challenge.targetKind === 'criteria' && state.tasks[challenge.targetId.split('@')[0] ?? '']?.taskId === taskId)
            return challenge.challengeId;
    }
    return undefined;
}
/**
 * §12.1：依赖缺省按最保守的 `required_condition` 处理——
 * 旧记录没有区分时，依据失效继续阻断动作，而不是被当成可以带着反证开工的假设。
 */
export function conditionOf(dependency) {
    return dependency.condition ?? 'required_condition';
}
export function invalidateDependents(state, onKind, onId, cause, now) {
    const invalidatedDependencies = [];
    const tasksMarked = [];
    const artifactsMarked = [];
    const withdrawalNeeded = [];
    const hypothesisReviews = [];
    const assumptionImpacts = [];
    const dependencies = { ...state.dependencies };
    for (const [id, dependency] of Object.entries(dependencies)) {
        if (dependency.onKind !== onKind)
            continue;
        if (dependency.onId !== onId && !dependency.onId.startsWith(`${onId}@`))
            continue;
        if (dependency.reviewState === 'invalidated')
            continue;
        const condition = conditionOf(dependency);
        dependencies[id] = { ...dependency, reviewState: 'invalidated', invalidatedBy: cause, checkedAt: now };
        invalidatedDependencies.push(id);
        // 待检验假设与探索假设失效不冻结任务：它们要的是更新试验设计、标出适用性影响（§12.1、§31.5）。
        if (condition === 'tested_hypothesis') {
            if (dependency.targetKind === 'task' && !hypothesisReviews.includes(dependency.targetId))
                hypothesisReviews.push(dependency.targetId);
            continue;
        }
        if (condition === 'exploratory_assumption') {
            if (dependency.targetKind === 'task' && !assumptionImpacts.includes(dependency.targetId))
                assumptionImpacts.push(dependency.targetId);
            continue;
        }
        if (dependency.targetKind === 'task') {
            const task = state.tasks[dependency.targetId];
            if (task !== undefined && task.validity === 'current') {
                tasksMarked.push(task.taskId);
            }
        }
        if (dependency.targetKind === 'artifact') {
            for (const group of Object.values(state.artifacts)) {
                const target = group.find((item) => item.artifactId === dependency.targetId);
                if (target === undefined)
                    continue;
                if (target.validity === 'current')
                    artifactsMarked.push(target.artifactId);
                if (target.published)
                    withdrawalNeeded.push(target.artifactId);
            }
        }
    }
    const tasks = { ...state.tasks };
    for (const taskId of tasksMarked) {
        const task = tasks[taskId];
        if (task !== undefined)
            tasks[taskId] = { ...task, validity: 'needs_review', updatedAt: now };
    }
    const artifacts = {};
    const marked = new Set(artifactsMarked);
    const withdrawing = new Set(withdrawalNeeded);
    for (const [uri, group] of Object.entries(state.artifacts)) {
        artifacts[uri] = group.map((item) => marked.has(item.artifactId) || withdrawing.has(item.artifactId)
            ? { ...item, validity: 'needs_review', withdrawalPending: item.published ? true : item.withdrawalPending }
            : item);
    }
    const queued = invalidatedDependencies.map((dependencyId, index) => {
        const dependency = dependencies[dependencyId];
        const condition = dependency === undefined ? 'required_condition' : conditionOf(dependency);
        const action = condition === 'tested_hypothesis'
            ? 'update_trial_design'
            : condition === 'exploratory_assumption'
                ? 'note_applicability_impact'
                : dependency?.targetKind === 'artifact' && withdrawing.has(dependency?.targetId ?? '')
                    ? 'withdraw_or_publish_correction'
                    : 'reverify_or_reissue';
        return {
            propagationId: `${cause}:prop_${index + 1}`,
            cause,
            targetKind: dependency?.targetKind ?? 'unknown',
            targetId: dependency?.targetId ?? '',
            requiredAction: action,
            queuedAt: now,
        };
    });
    return {
        state: { ...state, dependencies, tasks, artifacts, pendingPropagations: [...state.pendingPropagations, ...queued] },
        invalidatedDependencies,
        tasksMarked,
        artifactsMarked,
        withdrawalNeeded,
        queuedPropagations: queued,
        hypothesisReviews,
        assumptionImpacts,
    };
}
/**
 * §12.1：这条依赖现在是否阻挡受管动作。
 *
 * 只有"成立条件"（含缺省）在失效/待复核时阻挡；待检验假设被反证要去更新试验设计，
 * 探索假设要去标出适用性影响——它们都不是失败判词，不能把探索任务冻结在原地。
 */
export function dependencyGates(state, dependency) {
    if (conditionOf(dependency) !== 'required_condition') {
        return { gates: false, reason: `${conditionOf(dependency)} 失效只更新试验设计与适用性说明，不阻断执行（§12.1）` };
    }
    if (dependency.reviewState === 'invalidated' || dependency.reviewState === 'stale') {
        return { gates: true, reason: `成立条件已失效（${dependency.invalidatedBy ?? dependency.reviewState}），依赖它的动作要按当前依据复核（§12.1）` };
    }
    if (dependency.reviewState === 'pending_review')
        return { gates: true, reason: '成立条件待复核，先核对再执行' };
    if (dependency.targetKind === 'task') {
        const task = state.tasks[dependency.targetId];
        if (task !== undefined && task.validity !== 'current')
            return { gates: true, reason: `目标任务 ${task.taskId} 的依据有效性为 ${task.validity}` };
    }
    return { gates: false, reason: '依赖版本一致' };
}
/** 某个任务上此刻阻挡受管动作的成立条件（按依赖 id 列出，供准入守卫与视图复用）。 */
export function requiredConditionBlockers(state, taskId) {
    const blockers = [];
    for (const [dependencyId, dependency] of Object.entries(state.dependencies)) {
        if (taskId !== undefined && dependency.targetId !== taskId)
            continue;
        const verdict = dependencyGates(state, dependency);
        if (verdict.gates)
            blockers.push({ dependencyId, reason: verdict.reason });
    }
    return blockers;
}
/**
 * 传播项的收敛（§22.6、R06）：下游目标在新依据下复核或补发之后，把对应积压项移走。
 *
 * 只删列表项，不动 `validity`——有效性由 `task.verify` 的当前判据报告恢复，
 * 清掉积压不等于把结论重新认定为当前有效。移除的条目由调用方写进事件流留痕。
 */
export function dischargePropagations(state, matches) {
    const discharged = [];
    const kept = [];
    for (const item of state.pendingPropagations) {
        if (matches(item))
            discharged.push(item);
        else
            kept.push(item);
    }
    if (discharged.length === 0)
        return { state, discharged };
    return { state: { ...state, pendingPropagations: kept }, discharged };
}
/** 按目标任务找当前绑定会话，用于给受影响的一方排队复核通知；找不到会话就只留工作项。 */
export function affectedSession(state, item) {
    let taskId;
    if (item.targetKind === 'task')
        taskId = item.targetId;
    if (taskId === undefined) {
        for (const group of Object.values(state.artifacts)) {
            const owner = group.find((artifact) => artifact.artifactId === item.targetId);
            if (owner === undefined)
                continue;
            taskId = owner.taskId;
            break;
        }
    }
    const attempt = taskId === undefined ? undefined : state.tasks[taskId]?.currentAttemptId;
    const sessionId = attempt === undefined ? undefined : state.attempts[attempt]?.sessionId;
    if (sessionId === undefined || sessionId.length === 0)
        return undefined;
    return sessionId;
}
/**
 * "没找到"能不能当作不存在前提（§22.2 DG-02）。
 *
 * 只有覆盖完整、无错误、且确实报 not_found_in_scope 的回执才允许承载存在性前提；
 * 分页未取完或截断时明确拒绝，避免把检索假阴性写成事实。
 */
export function supportsAbsenceClaim(receipt) {
    if (receipt.outcome === 'error')
        return { ok: false, reason: `检索出错：${receipt.errors.join(' / ') || '未记录错误详情'}` };
    if (receipt.outcome === 'incomplete')
        return { ok: false, reason: '检索未完成，不能作为任何存在性前提' };
    if (receipt.hasMore || receipt.truncated)
        return { ok: false, reason: '结果被分页或截断，只取到部分材料' };
    if (receipt.coverage !== 'complete')
        return { ok: false, reason: `覆盖范围为 ${receipt.coverage}，未声明查完` };
    if (receipt.outcome === 'found')
        return { ok: true, reason: '命中即存在，按结果引用使用' };
    return { ok: true, reason: `在 ${receipt.roots.join(' / ')} 范围内未找到（仅此范围有效）` };
}
/** 交付是否算"对方已处理"（§22.14 DG-14）：投递成功与处理确认分两步。 */
export function deliveryIsProcessed(delivery) {
    return delivery.stage === 'processed' && (delivery.handling === 'accepted' || delivery.handling === 'integrated');
}
/** 证据口径能不能横比（§22.1 DG-01）：对象、指标、单位、分母、范围、时点口径一致才可比。 */
export function comparable(a, b) {
    if (a.kind !== b.kind)
        return { ok: false, reason: `来源类别不同（${a.kind} vs ${b.kind}），模拟结果不得写进真实执行栏` };
    if (a.metricId !== b.metricId)
        return { ok: false, reason: `指标不同（${a.metricId ?? '未标注'} vs ${b.metricId ?? '未标注'}）` };
    if (a.unit !== b.unit)
        return { ok: false, reason: `单位不同（${a.unit ?? '未标注'} vs ${b.unit ?? '未标注'}）` };
    if (a.denominator !== b.denominator || a.aggregate !== b.aggregate)
        return { ok: false, reason: '聚合口径或分母不同' };
    if (a.dataScope !== b.dataScope)
        return { ok: false, reason: `数据范围不同（${a.dataScope ?? '未标注'} vs ${b.dataScope ?? '未标注'}）` };
    if (a.objectTime !== undefined && b.objectTime !== undefined && a.objectTime !== b.objectTime)
        return { ok: false, reason: '对象时点不同，历史读数按当时版本保留' };
    return { ok: true, reason: '口径一致，可比较' };
}
