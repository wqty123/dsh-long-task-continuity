import { commit, mintId, put } from './control.js';
/** 显式 id 键排序：不依赖对象遍历顺序与本地化规则。 */
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** 版本引用接受 `版本号`、`contentHash` 或 `artifactId@版本号` 三种写法。 */
function versionMatches(item, versionRef) {
    const trimmed = versionRef.trim();
    if (trimmed.length === 0)
        return false;
    return trimmed === String(item.version) || trimmed === item.contentHash || trimmed === `${item.artifactId}@${item.version}`;
}
function resolveComponent(state, ref, versionRef) {
    for (const group of Object.values(state.artifacts)) {
        for (const item of group) {
            if (item.artifactId !== ref && item.uri !== ref)
                continue;
            if (!versionMatches(item, versionRef))
                continue;
            const head = group[group.length - 1];
            return { artifact: item, head, superseded: head !== undefined && head.artifactId !== item.artifactId };
        }
    }
    return undefined;
}
/** 不带版本的引用解析：优先链头，其次历史版本。 */
function findComponentByRef(state, ref) {
    for (const group of Object.values(state.artifacts)) {
        const head = group[group.length - 1];
        if (head !== undefined && (head.artifactId === ref || head.uri === ref))
            return { artifact: head, head, superseded: false };
    }
    for (const group of Object.values(state.artifacts)) {
        for (const item of group) {
            if (item.artifactId !== ref && item.uri !== ref)
                continue;
            const head = group[group.length - 1];
            return { artifact: item, head, superseded: head !== undefined && head.artifactId !== item.artifactId };
        }
    }
    return undefined;
}
function findVersionById(state, artifactId) {
    for (const group of Object.values(state.artifacts)) {
        const item = group.find((candidate) => candidate.artifactId === artifactId);
        if (item !== undefined)
            return { group, item };
    }
    return undefined;
}
function fingerprintMatches(state, fingerprint) {
    const trimmed = fingerprint.trim();
    const matches = [];
    if (trimmed.length === 0)
        return matches;
    for (const group of Object.values(state.artifacts)) {
        for (const item of group) {
            if (item.contentHash === trimmed || `${item.artifactId}@${item.version}` === trimmed)
                matches.push(item);
        }
    }
    return matches;
}
function assessPlan(state, input, excludeIntegrationId) {
    const problems = [];
    const warnings = [];
    const task = state.tasks[input.integrationTaskId];
    if (task === undefined)
        problems.push(`整合任务 ${input.integrationTaskId} 未登记：拆分工作时就要指定唯一整合任务（§34.3）`);
    else if (task.status === 'failed' || task.status === 'cancelled')
        problems.push(`整合任务 ${input.integrationTaskId} 已是终态（${task.status}）`);
    if (input.ownerActorId.trim().length === 0)
        problems.push('ownerActorId 不能为空：整合计划必须指定唯一整合 owner（§34.3）');
    else if (state.actors[input.ownerActorId] === undefined)
        problems.push(`整合 owner ${input.ownerActorId} 未登记身份`);
    // 唯一整合任务：同一整合任务不能出现在两份计划里（否则等于给了两个 owner）。
    for (const [id, plan] of Object.entries(state.integrations)) {
        if (id === excludeIntegrationId)
            continue;
        if (plan.integrationTaskId === input.integrationTaskId) {
            problems.push(`整合任务 ${input.integrationTaskId} 已被计划 ${id}（owner ${plan.ownerActorId}）占用：整合任务 owner 必须唯一（§34.3）`);
        }
    }
    if (input.componentRefs.length === 0)
        problems.push('componentRefs 不能为空：至少声明一个组件的输入输出与确切版本（§34.3）');
    const componentKeys = new Set();
    for (const [index, component] of input.componentRefs.entries()) {
        const label = `componentRefs[${index}]`;
        if (component.taskId === undefined && component.artifactId === undefined)
            problems.push(`${label} 必须给出 taskId 或 artifactId`);
        if (component.taskId !== undefined && component.taskId === input.integrationTaskId)
            problems.push(`${label} 不能把整合任务本身列为组件`);
        if (component.taskId !== undefined && state.tasks[component.taskId] === undefined)
            problems.push(`${label} 的组件任务 ${component.taskId} 未登记`);
        if (component.expectedVersion.trim().length === 0)
            problems.push(`${label} 缺少 expectedVersion：计划要引用确切候选版本（§34.3）`);
        if (component.inputOutput.trim().length === 0)
            problems.push(`${label} 缺少 inputOutput（组件输入输出）`);
        if (component.versionsUnitsFormats.trim().length === 0)
            problems.push(`${label} 缺少 versionsUnitsFormats（版本/单位/格式）`);
        const key = `${component.taskId ?? ''}|${component.artifactId ?? ''}`;
        if (componentKeys.has(key))
            problems.push(`${label} 组件重复声明（${key}）`);
        componentKeys.add(key);
        if (component.artifactId !== undefined) {
            const found = findVersionById(state, component.artifactId);
            if (found === undefined) {
                problems.push(`${label} 的产物 ${component.artifactId} 未在台账登记：产物 ID 由内核分配，计划不能预引不存在的版本（§34.3）`);
            }
            else {
                const head = found.group[found.group.length - 1];
                if (head === undefined || head.artifactId !== component.artifactId) {
                    problems.push(`${label} 的产物 ${component.artifactId} 已被同 uri 的新版本取代：计划要引用当前链头版本（§34.3）`);
                }
                else if (!versionMatches(found.item, component.expectedVersion)) {
                    problems.push(`${label} 声明的版本 ${component.expectedVersion} 与当前链头 v${found.item.version}（${found.item.contentHash}）不一致`);
                }
            }
        }
    }
    if (input.interfaces.length === 0)
        problems.push('interfaces 不能为空：拆分时要声明组件接口与消费者（§34.3）');
    const interfaceNames = new Set();
    for (const [index, iface] of input.interfaces.entries()) {
        if (iface.name.trim().length === 0)
            problems.push(`interfaces[${index}] 缺少 name`);
        else if (interfaceNames.has(iface.name))
            problems.push(`接口名重复：${iface.name}`);
        interfaceNames.add(iface.name);
        if (iface.contract.trim().length === 0)
            problems.push(`接口「${iface.name}」缺少 contract（输入输出约定）`);
        if (iface.consumers.length === 0)
            problems.push(`接口「${iface.name}」必须声明消费者：接口变动要通知受影响任务（§34.3）`);
        else if (iface.consumers.some((consumer) => consumer.trim().length === 0))
            problems.push(`接口「${iface.name}」的消费者不能是空串`);
    }
    if (input.userFlow.trim().length === 0)
        problems.push('userFlow（整体使用例）不能为空：整合成果要按用户实际流程检验（§34.3）');
    if (input.candidateRefs.some((ref) => ref.trim().length === 0))
        problems.push('candidateRefs 不能包含空引用');
    if (input.sharedAssumptions.length === 0)
        warnings.push('未声明共享假设：跨组件假设不一致是整合失败的常见来源（§34.3）');
    return { problems, warnings };
}
/** 登记整合计划（§34.3）：拆分时就声明接口与整体使用例，绑定确切候选版本与唯一 owner。 */
export function registerIntegrationPlan(state, input, options) {
    const assessment = assessPlan(state, input);
    if (assessment.problems.length > 0)
        return { ok: false, problems: assessment.problems };
    const plan = { ...input, integrationId: input.integrationId ?? mintId('intg'), missionId: state.missionId, createdAt: options.now };
    const next = commit({ ...state, integrations: put(state.integrations, plan.integrationId, plan) }, 'integration/planned', { integrationId: plan.integrationId, integrationTaskId: plan.integrationTaskId, ownerActorId: plan.ownerActorId, components: plan.componentRefs.length, interfaces: plan.interfaces.length }, options.now);
    return { ok: true, state: next, plan, warnings: assessment.warnings };
}
/**
 * 修订整合计划（§34.3）：接口变动通知受影响任务并更新计划，不要求所有成员同步停止。
 * 返回受影响的组件任务与消费者任务 id，供调用方排通知；记录只替换当前计划、保留登记时间。
 */
export function reviseIntegrationPlan(state, integrationId, input, options) {
    const existing = state.integrations[integrationId];
    if (existing === undefined)
        return { ok: false, problems: [`整合计划 ${integrationId} 未登记`] };
    const assessment = assessPlan(state, input, integrationId);
    if (assessment.problems.length > 0)
        return { ok: false, problems: assessment.problems };
    const plan = { ...input, integrationId, missionId: existing.missionId, createdAt: existing.createdAt };
    const changed = planDeltas(existing, plan);
    const affectedTaskIds = affectedTasks(state, existing, plan);
    const next = commit({ ...state, integrations: put(state.integrations, integrationId, plan) }, 'integration/revised', { integrationId, changed, affectedTaskIds }, options.now);
    return { ok: true, state: next, plan, affectedTaskIds, changed, warnings: assessment.warnings };
}
function planDeltas(before, after) {
    const changed = [];
    if (before.integrationTaskId !== after.integrationTaskId)
        changed.push(`integrationTaskId：${before.integrationTaskId}→${after.integrationTaskId}`);
    if (before.ownerActorId !== after.ownerActorId)
        changed.push(`owner：「${before.ownerActorId}」→「${after.ownerActorId}」`);
    if (before.userFlow !== after.userFlow)
        changed.push('userFlow（整体使用例）修订');
    const componentKey = (component) => `${component.taskId ?? ''}|${component.artifactId ?? ''}`;
    const beforeComponents = new Map(before.componentRefs.map((component) => [componentKey(component), component]));
    for (const component of after.componentRefs) {
        const key = componentKey(component);
        const previous = beforeComponents.get(key);
        if (previous === undefined)
            changed.push(`新增组件 ${key}（${component.expectedVersion}）`);
        else if (previous.expectedVersion !== component.expectedVersion)
            changed.push(`组件 ${key} 版本：${previous.expectedVersion}→${component.expectedVersion}`);
        else if (previous.inputOutput !== component.inputOutput || previous.versionsUnitsFormats !== component.versionsUnitsFormats)
            changed.push(`组件 ${key} 接口说明修订`);
    }
    const afterKeys = new Set(after.componentRefs.map(componentKey));
    for (const key of beforeComponents.keys())
        if (!afterKeys.has(key))
            changed.push(`移除组件 ${key}`);
    const beforeIfaces = new Map(before.interfaces.map((iface) => [iface.name, iface]));
    for (const iface of after.interfaces) {
        const previous = beforeIfaces.get(iface.name);
        if (previous === undefined)
            changed.push(`新增接口「${iface.name}」`);
        else if (previous.contract !== iface.contract)
            changed.push(`接口「${iface.name}」契约修订`);
        else if (JSON.stringify(previous.consumers) !== JSON.stringify(iface.consumers))
            changed.push(`接口「${iface.name}」消费者变化`);
    }
    return changed;
}
function affectedTasks(state, before, after) {
    const affected = new Set();
    for (const plan of [before, after]) {
        for (const component of plan.componentRefs)
            if (component.taskId !== undefined)
                affected.add(component.taskId);
        for (const iface of plan.interfaces)
            for (const consumer of iface.consumers)
                if (state.tasks[consumer] !== undefined)
                    affected.add(consumer);
    }
    return [...affected].sort(byId);
}
/**
 * 发布资格判定（§34.4）：只看整合后的整体检查与返工状态。
 * 成员各自通过不在输入里——通过的成员数量不能投票变成整体通过；
 * fail/unknown 不折算成通过（§6.4），存在局部返工时不发发布资格。
 */
export function evaluateIntegrationEligibility(input) {
    const blockers = [];
    if (input.checks.length === 0)
        blockers.push('没有整体使用例检查：成员各自通过不能投票变成整体通过（§34.4）');
    for (const check of input.checks) {
        if (check.result === 'fail')
            blockers.push(`整体检查「${check.kind}」判为 fail：${check.note}`);
        else if (check.result === 'unknown')
            blockers.push(`整体检查「${check.kind}」结果 unknown：不折算成通过（§6.4）`);
    }
    if (input.reworkTaskIds.length > 0) {
        blockers.push(`存在局部返工任务（${[...input.reworkTaskIds].sort(byId).join(', ')}）：发布资格依赖最终整体结果（§34.4）`);
    }
    return { eligible: blockers.length === 0, blockers };
}
/**
 * 组装整合回执（§34.4）。
 *
 * 结构问题（指纹不绑定、组件清单缺项、版本漂移、返工任务不存在）直接拒绝；
 * 整体检查 fail/unknown 仍然落盘——失败的整合结果本身是要保留的记录，
 * 只是 `publishEligible=false`。`publishEligible` 由本层计算，调用方不能自报。
 */
export function assembleIntegrationReceipt(state, input, options) {
    const problems = [];
    const warnings = [];
    const plan = state.integrations[input.integrationId];
    if (plan === undefined) {
        return { ok: false, problems: [`整合计划 ${input.integrationId} 未登记：整体验收要对着计划声明的接口与使用例（§34.3）`] };
    }
    if (input.artifactFingerprint.trim().length === 0)
        problems.push('artifactFingerprint 不能为空：回执必须绑定整合后产物（§34.4）');
    // 组件清单：每个引用必须解析到已登记的版本，且与计划声明的确切版本一致。
    if (input.componentRefs.length === 0 && plan.componentRefs.some((component) => component.artifactId !== undefined)) {
        problems.push('组件清单为空：回执要绑定每个已声明组件的确切版本（§34.4）');
    }
    for (const [index, component] of input.componentRefs.entries()) {
        if (component.ref.trim().length === 0)
            problems.push(`componentRefs[${index}] 缺少 ref`);
        const resolved = resolveComponent(state, component.ref, component.version);
        if (resolved === undefined) {
            problems.push(`组件 ${component.ref}@${component.version} 在产物台账找不到对应版本：不能凭未登记的版本通过整体验收`);
            continue;
        }
        if (resolved.superseded) {
            problems.push(`组件 ${component.ref} 引用的 v${resolved.artifact.version} 已被链头 v${resolved.head?.version ?? '?'} 取代：整合后内容已改变，旧证据只能按适用范围复用（§34.4）`);
        }
        const declared = planComponentMatching(plan, resolved.artifact);
        if (declared === undefined)
            problems.push(`组件 ${component.ref} 未在整合计划中声明：整体清单只包含计划内的确切组件（§34.3）`);
        else if (declared.artifactId !== undefined && !versionMatches(resolved.artifact, declared.expectedVersion)) {
            problems.push(`组件 ${component.ref} 回执版本 ${component.version} 与计划声明的 ${declared.expectedVersion} 不一致：先修订计划或纠正回执（§34.3）`);
        }
    }
    for (const component of plan.componentRefs) {
        if (component.artifactId === undefined)
            continue;
        const covered = input.componentRefs.some((entry) => {
            const resolved = resolveComponent(state, entry.ref, entry.version);
            return resolved !== undefined && resolved.artifact.artifactId === component.artifactId;
        });
        if (!covered)
            problems.push(`组件清单缺少计划内的组件 ${component.artifactId}：整合要检验接口吻合、语义一致与用户实际流程（§34.3）`);
    }
    // 指纹必须绑定到整合任务产物、计划候选或回执组件之一。
    if (input.artifactFingerprint.trim().length > 0 && fingerprintBindingCount(state, plan, input) === 0) {
        problems.push(`产物指纹 ${input.artifactFingerprint} 未绑定到整合产物/计划候选/回执组件：指纹必须对应整合后的确切产物（§34.4）`);
    }
    // 局部返工：任务要真实存在；与复用结果互斥。
    const rework = [...input.reworkTaskIds].sort(byId);
    if (new Set(rework).size !== rework.length)
        problems.push('reworkTaskIds 有重复项');
    for (const taskId of rework) {
        if (state.tasks[taskId] === undefined)
            problems.push(`返工任务 ${taskId} 未登记：局部返工要落在实际任务上（§34.4）`);
        if (taskId === plan.integrationTaskId)
            problems.push('整合任务本身不能被列为局部返工任务');
    }
    const receiptRefKeys = new Set(input.componentRefs.map((entry) => entry.ref));
    for (const reused of input.reusedComponentRefs) {
        const resolved = findComponentByRef(state, reused);
        const inReceipt = receiptRefKeys.has(reused);
        const declared = plan.componentRefs.some((component) => component.artifactId === reused || component.taskId === reused);
        if (!inReceipt && !declared && resolved === undefined)
            problems.push(`reusedComponentRefs 中的 ${reused} 不在组件清单或计划里`);
        const ownerTaskId = resolved?.artifact.taskId;
        if (ownerTaskId !== undefined && input.reworkTaskIds.includes(ownerTaskId)) {
            problems.push(`组件 ${reused} 同时列入复用与局部返工（${ownerTaskId}）：返工说明该组件结果不能原样复用（§34.4）`);
        }
    }
    for (const [index, check] of input.checks.entries()) {
        if (check.kind.trim().length === 0)
            problems.push(`checks[${index}] 缺少 kind`);
        if (check.note.trim().length === 0)
            problems.push(`checks[${index}] 缺少 note：检查结果要写清依据`);
    }
    if (problems.length > 0)
        return { ok: false, problems };
    if (input.reusedComponentRefs.length > 0)
        warnings.push('复用组件结果按适用范围生效：旧部件的通过证据不能证明新整体（§34.4）');
    const integrationTask = state.tasks[plan.integrationTaskId];
    const verdict = evaluateIntegrationEligibility(input);
    const receipt = {
        receiptId: input.receiptId ?? mintId('irct'),
        missionId: state.missionId,
        integrationId: plan.integrationId,
        artifactFingerprint: input.artifactFingerprint,
        componentRefs: input.componentRefs.map((component) => ({ ref: component.ref, version: component.version })),
        ...(input.environment === undefined ? {} : { environment: input.environment }),
        // OutcomeContract 版本即 mission.objectiveRevision（§30.1）；整体判据版本取整合任务的 criteriaRevision（§34.4）。
        objectiveRevision: state.mission.objectiveRevision,
        criteriaRevision: integrationTask?.criteriaRevision ?? 0,
        checks: input.checks.map((check) => ({ kind: check.kind, result: check.result, note: check.note })),
        reusedComponentRefs: [...input.reusedComponentRefs],
        reworkTaskIds: rework,
        publishEligible: verdict.eligible,
        decidedBy: options.actorId,
        createdAt: options.now,
    };
    const next = commit({ ...state, integrationReceipts: put(state.integrationReceipts, receipt.receiptId, receipt) }, 'integration/receipt-assembled', {
        receiptId: receipt.receiptId,
        integrationId: plan.integrationId,
        publishEligible: receipt.publishEligible,
        blockers: verdict.blockers,
        checks: receipt.checks.length,
        rework: receipt.reworkTaskIds.length,
    }, options.now);
    return { ok: true, state: next, receipt, blockers: verdict.blockers, warnings };
}
function planComponentMatching(plan, artifact) {
    return plan.componentRefs.find((component) => component.artifactId === artifact.artifactId ||
        (component.artifactId === undefined && component.taskId !== undefined && component.taskId === artifact.taskId));
}
function fingerprintBindingCount(state, plan, input) {
    return fingerprintMatches(state, input.artifactFingerprint).filter((item) => item.taskId === plan.integrationTaskId ||
        plan.candidateRefs.some((ref) => ref === item.artifactId || ref === item.uri || ref === `${item.artifactId}@${item.version}`) ||
        input.componentRefs.some((entry) => entry.ref === item.artifactId || entry.ref === item.uri)).length;
}
/**
 * 计划声明的组件版本是否仍与产物台账链头一致（§34.3）：任何不一致都要先修订计划。
 * 漂移列表为空表示计划引用的确切版本仍然有效。
 */
export function integrationComponentDrift(state, integrationId) {
    const plan = state.integrations[integrationId];
    if (plan === undefined)
        return [`整合计划 ${integrationId} 未登记`];
    const drift = [];
    for (const component of plan.componentRefs) {
        if (component.artifactId === undefined)
            continue;
        const found = findVersionById(state, component.artifactId);
        if (found === undefined) {
            drift.push(`组件 ${component.artifactId} 已不在产物台账（计划声明 ${component.expectedVersion}）`);
            continue;
        }
        const head = found.group[found.group.length - 1];
        if (head === undefined || head.artifactId !== component.artifactId) {
            drift.push(`组件 ${component.artifactId}（计划声明 ${component.expectedVersion}）已被链头 v${head?.version ?? '?'} 取代：先修订计划再整合`);
        }
        else if (!versionMatches(found.item, component.expectedVersion)) {
            drift.push(`组件 ${component.artifactId} 计划声明 ${component.expectedVersion}，当前链头 v${found.item.version}（${found.item.contentHash}）`);
        }
    }
    return drift;
}
/**
 * 旧回执还能不能证明当前整体（§34.4）：整合后内容改变、OutcomeContract 或
 * 整体判据版本修订后，旧回执只能按适用范围复用，不能继续支撑发布。
 */
export function integrationReceiptCurrent(state, receiptId) {
    const receipt = state.integrationReceipts[receiptId];
    if (receipt === undefined)
        return { current: false, changes: [`回执 ${receiptId} 不存在`] };
    const changes = [];
    if (receipt.objectiveRevision !== state.mission.objectiveRevision) {
        changes.push(`OutcomeContract 版本已修订：回执绑定 objectiveRevision ${receipt.objectiveRevision}，当前 ${state.mission.objectiveRevision}（§34.4）`);
    }
    const plan = state.integrations[receipt.integrationId];
    const integrationTask = plan === undefined ? undefined : state.tasks[plan.integrationTaskId];
    if (integrationTask !== undefined && integrationTask.criteriaRevision !== receipt.criteriaRevision) {
        changes.push(`整体判据版本已修订：回执绑定 criteriaRevision ${receipt.criteriaRevision}，当前 ${integrationTask.criteriaRevision}（§34.4）`);
    }
    for (const component of receipt.componentRefs) {
        const resolved = resolveComponent(state, component.ref, component.version);
        if (resolved === undefined) {
            changes.push(`组件 ${component.ref}@${component.version} 已不在产物台账`);
            continue;
        }
        if (resolved.superseded) {
            changes.push(`组件 ${component.ref} 已从 v${resolved.artifact.version} 变为链头 v${resolved.head?.version ?? '?'}：旧部件证据只能按适用范围复用（§34.4）`);
        }
    }
    return { current: changes.length === 0, changes };
}
/** 按被质疑对象定位整合计划：组件、候选、接口名或整合任务本身（§34.1、§34.3）。 */
export function findIntegrationForRef(state, ref) {
    if (ref.trim().length === 0)
        return undefined;
    const plans = Object.entries(state.integrations)
        .sort(([a], [b]) => byId(a, b))
        .map(([, plan]) => plan);
    const direct = plans.find((plan) => plan.integrationTaskId === ref);
    if (direct !== undefined)
        return direct;
    return plans.find((plan) => plan.componentRefs.some((component) => component.taskId === ref || component.artifactId === ref) ||
        plan.candidateRefs.some((candidate) => candidate === ref) ||
        plan.interfaces.some((iface) => iface.name === ref || iface.consumers.includes(ref)));
}
/**
 * 先分清争议类型（§34.1）。五类各有负责人：权限/硬约束/执行身份 → Supervisor；
 * 事实/方法 → Challenge 裁定者核对或判别试验；路线与资源取舍 → Lead；
 * 用户目标不清楚 → 汇总差异后提问；组件接口/版本/整合责任 → 整合者按计划协调。
 */
export function classifyDispute(signals, state) {
    const concern = signals.concern;
    switch (concern) {
        case 'permission':
        case 'hard_constraint':
        case 'execution_identity':
            return {
                concern,
                kind: 'authority_block',
                handler: 'supervisor',
                handling: 'Supervisor 按有效规则阻断对应动作；只有有权主体可修改约束',
                blocking: 'authority_related_actions',
            };
        case 'fact':
        case 'method':
            return {
                concern,
                kind: 'evidence_dispute',
                handler: 'challenge_adjudicator',
                handling: 'Challenge 指向双方条件与证据，指定已有角色核对或做判别试验；低成本判别优先于讨论轮数（§34.2）',
                blocking: 'evidence_premises',
            };
        case 'route_priority':
        case 'resource_tradeoff':
            return {
                concern,
                kind: 'route_priority',
                handler: 'lead',
                handling: 'Lead 在已有授权范围作有期限、可修订的选择',
                blocking: 'none',
            };
        case 'user_goal':
            return {
                concern,
                kind: 'user_decision',
                handler: 'user',
                handling: '汇总具体差异及影响，向用户提出必要问题',
                blocking: 'none',
            };
        case 'component_interface':
        case 'integration_responsibility':
        case 'version_conflict': {
            const targetRef = signals.targetRef ?? '';
            const plan = state === undefined ? undefined : findIntegrationForRef(state, targetRef);
            return {
                concern,
                kind: 'integration_conflict',
                handler: 'integration_owner',
                handling: plan === undefined
                    ? '先登记 IntegrationPlan 并指定整合者，再按计划协调；共享产物不允许多人同时改（§34.1、§34.3）'
                    : `由整合者 ${plan.ownerActorId} 依据计划 ${plan.integrationId} 协调；共享产物不允许多人同时改（§34.1）`,
                blocking: 'none',
                ...(plan === undefined ? {} : { integrationId: plan.integrationId, ownerActorId: plan.ownerActorId }),
            };
        }
    }
}
/**
 * 争议的阻断范围（§34.2）：必要前提冲突只阻断相关动作，普通方法争论不能冻结全队。
 * 结果只能落在 `challenge.affectedActionIds` 上，永不返回"全队/全 Mission"范围。
 */
export function disputeBlockingScope(challenge, cls) {
    if (cls.blocking === 'none')
        return { blocks: false, scope: [], reason: '普通方法或取舍争论不冻结执行范围（§34.2）' };
    if (cls.blocking === 'authority_related_actions') {
        const scope = [...challenge.affectedActionIds].sort(byId);
        return { blocks: scope.length > 0, scope, reason: '权限/硬约束冲突只阻断受影响的动作，其他工作继续（§34.1）' };
    }
    // 证据争议：只有指向当前必要前提的硬冲突才阻断；其余是待审意见（§22.4、§34.2）。
    if (challenge.severity !== 'hard_conflict') {
        return { blocks: false, scope: [], reason: `${challenge.severity} 是待审意见：保留记录但不阻断执行（§22.4、§34.2）` };
    }
    const scope = [...challenge.affectedActionIds].sort(byId);
    return { blocks: scope.length > 0, scope, reason: '必要前提冲突只阻断相关动作，不冻结全队（§34.2）' };
}
/**
 * 裁决第一步：双方是否在比较同一条件、版本和问题（§34.2）。
 *
 * 条件/版本不同 → 保留各自成立范围，不把两个结论当成同一条件的矛盾；
 * 条件相同但共用验证器/数据处理 → 不是独立支持，先核对验证方法与共同依赖（§32.2、§34.2）。
 */
export function compareDisputeSides(a, b) {
    const differing = [];
    const conditionsA = new Set(a.conditions.map((entry) => entry.trim()).filter((entry) => entry.length > 0));
    const conditionsB = new Set(b.conditions.map((entry) => entry.trim()).filter((entry) => entry.length > 0));
    for (const condition of conditionsA)
        if (!conditionsB.has(condition))
            differing.push(`条件仅 ${a.label} 声明：${condition}`);
    for (const condition of conditionsB)
        if (!conditionsA.has(condition))
            differing.push(`条件仅 ${b.label} 声明：${condition}`);
    const versionKeys = new Set([...Object.keys(a.versions), ...Object.keys(b.versions)]);
    for (const key of [...versionKeys].sort(byId)) {
        const left = a.versions[key];
        const right = b.versions[key];
        if (left !== undefined && right !== undefined && left !== right)
            differing.push(`版本 ${key}：${a.label}=${left} vs ${b.label}=${right}`);
        else if (left !== undefined && right === undefined)
            differing.push(`版本 ${key} 仅 ${a.label} 声明为 ${left}`);
        else if (right !== undefined && left === undefined)
            differing.push(`版本 ${key} 仅 ${b.label} 声明为 ${right}`);
    }
    const sharedDeps = new Set();
    const depsA = new Set((a.commonDeps ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0));
    for (const dep of b.commonDeps ?? [])
        if (depsA.has(dep.trim()))
            sharedDeps.add(dep.trim());
    const methodsA = new Set(a.methodRefs.map((entry) => entry.trim()).filter((entry) => entry.length > 0));
    for (const method of b.methodRefs)
        if (methodsA.has(method.trim()))
            sharedDeps.add(method.trim());
    const sameCondition = differing.length === 0;
    const note = !sameCondition
        ? '条件或版本不同：保留各自成立范围，不把两个结论当成同一条件的矛盾（§34.2）'
        : sharedDeps.size > 0
            ? '同一条件下比较，但双方共用验证器/数据处理：不是独立支持，先核对验证方法与共同依赖（§32.2、§34.2）'
            : '条件与版本一致：进入来源链与验证方法核对（§34.2）';
    return { sameCondition, differing, sharedDeps: [...sharedDeps].sort(byId), note };
}
/** 裁决结论由流程推出：条件不同 → 各自保留；有判别证据 → 测试决定；否则临时选择。 */
export function adjudicationVerdict(input) {
    if (!input.comparison.sameCondition)
        return 'both_scopes_retained';
    if ((input.resolvingEvidenceIds ?? []).length > 0)
        return 'decided_by_test';
    return 'temporary_choice';
}
/** 无判别证据时不许写"证明/证实"：不能把负责人胜出包装成事实证明（§34.2）。 */
const PROOF_PATTERN = /证明|证实|proven/i;
/**
 * 有界裁决记录的校验（§34.2）：争议范围、证据、暂时选择、负责者、剩余预算、
 * 重开条件和影响范围缺一不可；讨论用尽预算后必须形成操作性决定，
 * 未排除的一方要写明，不能包装成事实证明。
 */
export function validateAdjudication(input) {
    const problems = [];
    const verdict = adjudicationVerdict(input);
    if (input.scope.trim().length === 0)
        problems.push('缺少争议范围（scope）');
    if (input.evidenceRefs.length === 0)
        problems.push('缺少证据引用：裁决记录要绑定双方证据（§34.2）');
    if (input.temporaryChoice.trim().length === 0)
        problems.push('缺少操作性决定（temporaryChoice）：讨论用尽预算后必须给出"在范围 X 下暂用 A"（§34.2）');
    if (input.ownerActorId.trim().length === 0)
        problems.push('缺少负责者（ownerActorId）');
    if (input.remainingBudgetNote.trim().length === 0)
        problems.push('缺少剩余预算说明（remainingBudgetNote）');
    if (input.reopenConditions.length === 0)
        problems.push('缺少重开条件：新证据可重开争议（§34.2）');
    else if (input.reopenConditions.some((condition) => condition.trim().length === 0))
        problems.push('重开条件不能是空串');
    if (input.impactScope.trim().length === 0)
        problems.push('缺少影响范围（impactScope）');
    if (verdict !== 'decided_by_test') {
        if ((input.retainedAlternative ?? '').trim().length === 0) {
            problems.push('没有判别证据时必须写明未排除的另一方（retainedAlternative），例如"B 未排除"（§34.2）');
        }
        const claims = `${input.scope}；${input.temporaryChoice}；${input.retainedAlternative ?? ''}`;
        if (PROOF_PATTERN.test(claims))
            problems.push('没有判别证据时不能把一方写成已被证明/证实：负责人胜出不等于事实证明（§34.2）');
    }
    return { ok: problems.length === 0, verdict, problems };
}
/** 渲染成 `Challenge.resolution` 文本，交既有 `challenge.resolve` 落盘，不新造容器。 */
export function renderAdjudicationResolution(input) {
    const parts = [
        `裁决类型：${adjudicationVerdict(input)}`,
        `争议范围：${input.scope}`,
        `证据：${input.evidenceRefs.join(' / ')}`,
        `暂时选择：${input.temporaryChoice}`,
        ...((input.retainedAlternative ?? '').trim().length === 0 ? [] : [`未排除：${input.retainedAlternative}`]),
        `负责者：${input.ownerActorId}`,
        `剩余预算：${input.remainingBudgetNote}`,
        `重开条件：${input.reopenConditions.join(' / ')}`,
        `影响范围：${input.impactScope}`,
        ...((input.resolvingEvidenceIds ?? []).length === 0 ? [] : [`判别证据：${(input.resolvingEvidenceIds ?? []).join(' / ')}`]),
    ];
    return parts.join('；');
}
