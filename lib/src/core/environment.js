import { commit, mintId, put } from './control.js';
/** §33.2 表格的机器可读副本（发现 → 处理 → 放行范围）。改表必须先改这里。 */
export const FINDING_ACTIONS = {
    unchanged: { action: '复用引用和原验证', allowedScope: '相关任务继续' },
    changed: { action: '检查影响、更新清单，重验受影响结果', allowedScope: '无关任务不重跑' },
    temp_missing: { action: '按已授权恢复方法重建或从持久产物恢复', allowedScope: '核对结果后继续' },
    job_running: { action: '核实身份并重新关联监视', allowedScope: '不另启重复作业' },
    job_done_no_receipt: { action: '查询真实结果、核对产物并补登记', allowedScope: '不重发原动作' },
    job_unknown: { action: '进入 outcome_unknown', allowedScope: '暂停冲突动作，保留诊断与取消入口' },
    needs_authorization: { action: '提供明确恢复方案，沿用授权或请求必要决定', allowedScope: '已独立满足条件的工作仍可进行' },
};
export const DEFAULT_VALIDITY_POLICY = {
    immutableMs: 6 * 60 * 60 * 1000,
    variableMs: 15 * 60 * 1000,
    inFlightJobMs: 5 * 60 * 1000,
};
export function validityWindowMs(item, policy = DEFAULT_VALIDITY_POLICY) {
    if (item.kind === 'in_flight_job')
        return policy.inFlightJobMs;
    return item.sensitivity === 'immutable' ? policy.immutableMs : policy.variableMs;
}
/**
 * 一次核验的准入时效：取所有核验项里**最短**的窗口。
 *
 * 没有可核验项时窗口为 0——宁可下一步立即重查，也不假装清单覆盖了环境（§33.1）。
 */
export function validUntilFor(items, checkedAt, policy = DEFAULT_VALIDITY_POLICY) {
    if (items.length === 0)
        return checkedAt;
    const windows = items.map((item) => validityWindowMs(item, policy));
    return checkedAt + Math.min(...windows);
}
const ACTION_KEYWORDS = [
    { patterns: ['写', '改', '编辑', 'edit', 'write', 'patch', '重构', 'refactor'], kinds: ['workspace', 'uncommitted_file', 'branch'] },
    { patterns: ['提交', '推送', '合并', '分支', 'commit', 'push', 'merge', 'pull request'], kinds: ['branch', 'workspace'] },
    { patterns: ['运行', '执行', '跑', '测试', '构建', 'run', 'execute', 'test', 'build', 'script'], kinds: ['runtime', 'dependency', 'workspace'] },
    { patterns: ['安装', '依赖', 'install', 'dependency', 'package', '包'], kinds: ['dependency', 'runtime'] },
    { patterns: ['数据', '输入', '读取', 'data', 'input', 'dataset'], kinds: ['input_data'] },
    { patterns: ['配置', '环境变量', 'config', 'env var', '.env'], kinds: ['config_ref'] },
    { patterns: ['远程', '服务', '集群', '上传', 'remote', 'cluster', 'gpu', 'endpoint'], kinds: ['external_resource'] },
    { patterns: ['作业', '异步', '训练', 'job', 'async', 'ci ', 'pipeline'], kinds: ['in_flight_job'] },
    { patterns: ['临时', '缓存', '中间产物', 'temp', 'tmp', 'cache', 'scratch'], kinds: ['temp_artifact'] },
];
const FALLBACK_KINDS = ['workspace', 'runtime', 'dependency', 'input_data'];
export function planChecks(nextAction) {
    const lower = nextAction.toLowerCase();
    const kinds = new Set();
    for (const row of ACTION_KEYWORDS) {
        if (row.patterns.some((pattern) => lower.includes(pattern))) {
            for (const kind of row.kinds)
                kinds.add(kind);
        }
    }
    if (kinds.size === 0) {
        return { kinds: FALLBACK_KINDS, recognized: false, note: '下一步动作无法分类：按保守默认集合检查，不声称覆盖完整（§33.1）' };
    }
    return { kinds: [...kinds], recognized: true, note: `按下一步动作推出 ${kinds.size} 类必须核验的环境项` };
}
export function environmentGaps(manifest) {
    const unknownRefs = manifest.items.filter((item) => item.coverage === 'unknown').map((item) => item.ref).sort(compareRef);
    const covered = new Set(manifest.items.filter((item) => item.coverage === 'covered').map((item) => item.kind));
    const plan = planChecks(manifest.nextAction);
    const missingKinds = plan.kinds.filter((kind) => !covered.has(kind));
    const complete = unknownRefs.length === 0 && missingKinds.length === 0;
    const note = complete
        ? '下一步动作需要的项都已核验；仍不声称快照完整捕捉操作系统与远程环境（§33.1）'
        : `缺口：unknown ${unknownRefs.length} 项、未覆盖种类 ${missingKinds.join('/') || '无'}；清单不完整不算失败，但不能按已核验使用`;
    return { unknownRefs, missingKinds, complete, note };
}
const SECRET_PATTERNS = ['-----begin', 'sk-', 'ghp_', 'akia', 'password=', 'passwd=', 'secret=', 'token=', 'api_key=', 'apikey='];
/** §33.1：只保存与执行有关的配置，凭证保存服务引用，不复制密钥或完整环境变量。 */
function credentialViolation(items) {
    for (const item of items) {
        for (const text of [item.ref, item.expected ?? '']) {
            const lower = text.toLowerCase();
            if (text.length >= 20 && SECRET_PATTERNS.some((pattern) => lower.includes(pattern))) {
                return `${item.ref} 里带着疑似原始凭证内容：只保存服务引用（§33.1）`;
            }
        }
        if (item.observeMethod.trim().length === 0)
            return `${item.ref} 没有写明发现方法（§33.1）`;
        if (item.changeAction.trim().length === 0)
            return `${item.ref} 没有写明变化后动作（§33.1）`;
    }
    return undefined;
}
/** 登记版本 1；`environmentId` 作为重试幂等键，重复登记按失败返回而不是再挂一条链。 */
export function registerEnvironment(state, input, now) {
    const environmentId = input.environmentId ?? mintId('env');
    if (state.environments[environmentId] !== undefined) {
        return { ok: false, state, reason: `环境清单 ${environmentId} 已存在：修订请走 reviseEnvironment（§33.1）` };
    }
    const violation = credentialViolation(input.items);
    if (violation !== undefined)
        return { ok: false, state, reason: violation };
    const environment = {
        environmentId,
        version: 1,
        missionId: state.missionId,
        taskId: input.taskId,
        attemptId: input.attemptId,
        nextAction: input.nextAction,
        items: input.items,
        authorActorId: input.authorActorId,
        createdAt: now,
    };
    const next = commit({ ...state, environments: put(state.environments, environmentId, [environment]) }, 'environment/registered', {
        environmentId,
        version: 1,
        nextAction: input.nextAction,
    }, now);
    return { ok: true, state: next, environment };
}
/** 修订：链上追加版本 N+1，`supersedesVersion` 指回上一版；旧版本留在链里可追溯。 */
export function reviseEnvironment(state, environmentId, patch, now, actorId) {
    const chain = state.environments[environmentId];
    const head = chain?.[chain.length - 1];
    if (chain === undefined || head === undefined) {
        return { ok: false, state, reason: `环境清单 ${environmentId} 不存在：修订不能凭空开始` };
    }
    if (patch.items !== undefined) {
        const violation = credentialViolation(patch.items);
        if (violation !== undefined)
            return { ok: false, state, reason: violation };
    }
    const environment = {
        ...head,
        version: head.version + 1,
        supersedesVersion: head.version,
        nextAction: patch.nextAction ?? head.nextAction,
        taskId: patch.taskId ?? head.taskId,
        attemptId: patch.attemptId ?? head.attemptId,
        items: patch.items ?? head.items,
        authorActorId: actorId,
        createdAt: now,
    };
    const next = commit({ ...state, environments: put(state.environments, environmentId, [...chain, environment]) }, 'environment/revised', {
        environmentId,
        version: environment.version,
        supersedesVersion: head.version,
    }, now);
    return { ok: true, state: next, environment };
}
/**
 * §33.2 的七值判定，顺序即口径：
 *
 * 1. 越权 / 不可逆改动共享资源 ⇒ `needs_authorization`（硬约束先判，fail-closed）；
 * 2. 在途作业类 ⇒ 按身份与状态分流成 running / done_no_receipt / unknown；
 * 3. 临时文件缺失 ⇒ `temp_missing`；
 * 4. 其余按版本与观测比对：版本不一致或未覆盖一律最保守处理，不因"看起来没变"放过。
 */
export function classifyFinding(input) {
    const notes = [];
    const entry = (finding, note) => {
        if (note !== undefined)
            notes.push(note);
        return { ref: input.ref, finding, action: FINDING_ACTIONS[finding].action, allowedScope: FINDING_ACTIONS[finding].allowedScope };
    };
    const coverage = input.coverage ?? 'covered';
    if (input.recoveryRequiresNewAuthorization === true || input.recoveryTouchesSharedResourceIrreversibly === true) {
        return {
            entry: entry('needs_authorization', input.recoveryRequiresNewAuthorization === true
                ? '恢复动作超出现有授权：沿用授权或请求必要决定，恢复旧配置不是修改共享系统的通行证'
                : '恢复会不可逆地修改共享资源：先给方案与授权，已独立满足条件的工作不受影响'),
            notes,
        };
    }
    if (input.job !== undefined || input.kind === 'in_flight_job') {
        const job = input.job;
        if (job === undefined)
            return { entry: entry('job_unknown', '没有作业身份与状态观测：不能证明旧任务已结束'), notes };
        const identity = jobIdentity(job);
        if (job.state === 'running') {
            if (!identity.sufficient)
                return { entry: entry('job_unknown', `作业在运行但${identity.reason}：先核实身份再重新关联监视，不另启重复作业`), notes };
            return { entry: entry('job_running', `按 ${identity.identity} 重新关联监视，不另启重复作业`), notes };
        }
        if (job.state === 'done') {
            if (job.receiptPresent === true)
                return { entry: entry('changed', '作业已完成并带回执：按回执核对产物、更新清单，不重发原动作'), notes };
            return { entry: entry('job_done_no_receipt', '作业已完成但本地缺回执：查真实结果、核对产物并补登记，不重发原动作'), notes };
        }
        return { entry: entry('job_unknown', job.state === 'unreachable' ? '作业服务当前不可达：是否完成无法确认，进入 outcome_unknown' : '作业状态未知：进入 outcome_unknown'), notes };
    }
    if (input.kind === 'temp_artifact' && input.observation === 'missing') {
        return { entry: entry('temp_missing', '临时文件缺失：按已授权恢复方法重建或从持久产物恢复'), notes };
    }
    if (input.expectedVersion !== undefined && input.observedVersion !== undefined && input.expectedVersion !== input.observedVersion) {
        return { entry: entry('changed', `版本或内容校验值不一致（${input.expectedVersion} → ${input.observedVersion}）：更新清单并重验受影响结果`), notes };
    }
    if (input.observation === 'changed' || input.observation === 'missing' || input.observation === 'unobserved') {
        const why = input.observation === 'unobserved' ? '未能观测：按最保守处理，不声称 unchanged' : input.observation === 'missing' ? '预期存在但未观察到' : input.sensitivity === 'immutable' ? '不可变输入的校验值已变化' : '可变输入或依赖发生变化';
        return { entry: entry('changed', `${why}：检查影响、更新清单、只重验受影响结果`), notes };
    }
    if (coverage === 'unknown') {
        return { entry: entry('changed', '清单把该项标为 unknown：未核验项不能按 unchanged 放行，下一步前先补核（§33.1）'), notes };
    }
    if (input.sensitivity === 'immutable') {
        return { entry: entry('unchanged', '不可变输入仍匹配：复用引用与原验证，不重跑相关任务'), notes };
    }
    return { entry: entry('unchanged', '可变项本次核验一致；有效期按波动性设置，过期后重查（§33.3）'), notes };
}
/**
 * §33.2：作业身份用服务 job ID，或主机 / 进程启动身份等可核对组合；
 * 单一 PID、文件名或租约超时**不足以**证明旧任务已结束。
 */
export function jobIdentity(job) {
    if (job.serviceJobId !== undefined && job.serviceJobId.trim().length > 0) {
        return { identity: `service:${job.serviceJobId}`, sufficient: true, reason: '服务 job ID 可核对' };
    }
    const hasProcessIdentity = job.processRef !== undefined && job.processRef.trim().length > 0;
    const hasStart = job.startedAt !== undefined;
    if (job.host !== undefined && job.host.trim().length > 0 && hasStart && (hasProcessIdentity || job.pid !== undefined)) {
        const process = hasProcessIdentity ? job.processRef : `pid:${job.pid ?? ''}`;
        return { identity: `host:${job.host}/proc:${process}@${job.startedAt ?? ''}`, sufficient: true, reason: '主机 + 进程启动身份组合可核对' };
    }
    if (job.pid !== undefined) {
        return { sufficient: false, reason: '只有单一 PID（PID 会被复用），不足以证明旧任务已结束' };
    }
    return { sufficient: false, reason: '没有服务 job ID，也没有主机/进程启动身份组合' };
}
function manifestAt(state, environmentId, version) {
    const chain = state.environments[environmentId];
    if (chain === undefined)
        return undefined;
    return chain.find((item) => item.version === version);
}
/**
 * 开一张恢复评估：起手就是 `capture_expected`，只绑清单与身份，不给任何执行权。
 *
 * 绑定当前 Attempt 与清单修订（§33.3）：尝试已经换人、或清单版本不存在，直接拒开，
 * 免得评估从一条对不上的基线上继续。
 */
export function openResume(state, input, now) {
    const chain = state.environments[input.environmentId];
    const head = chain?.[chain.length - 1];
    if (chain === undefined || head === undefined) {
        return { ok: false, state, reason: `环境清单 ${input.environmentId} 不存在：恢复评估必须引用已登记清单（§33.1）` };
    }
    const environmentVersion = input.environmentVersion ?? head.version;
    if (!chain.some((item) => item.version === environmentVersion)) {
        return { ok: false, state, reason: `清单 ${input.environmentId} 没有版本 ${environmentVersion}` };
    }
    if (input.taskId !== undefined) {
        const task = state.tasks[input.taskId];
        if (task === undefined)
            return { ok: false, state, reason: `任务 ${input.taskId} 不存在` };
        if (input.attemptId !== undefined && task.currentAttemptId !== undefined && task.currentAttemptId !== input.attemptId) {
            return { ok: false, state, reason: `任务 ${input.taskId} 的当前尝试已不是 ${input.attemptId}：评估绑定当前 Attempt（§33.3）` };
        }
    }
    const resumeId = input.resumeId ?? mintId('resume');
    if (state.resumes[resumeId] !== undefined)
        return { ok: false, state, reason: `恢复评估 ${resumeId} 已存在` };
    const resume = {
        resumeId,
        missionId: state.missionId,
        environmentId: input.environmentId,
        environmentVersion,
        taskId: input.taskId,
        attemptId: input.attemptId,
        phase: 'capture_expected',
        findings: [],
        jobIdentity: input.jobIdentity,
        targetIdentity: input.targetIdentity,
        objectVersions: input.objectVersions ?? {},
        checkedAt: now,
        decidedBy: input.decidedBy,
        createdAt: now,
    };
    const next = commit({ ...state, resumes: put(state.resumes, resumeId, resume) }, 'environment/resume_opened', {
        resumeId,
        environmentId: input.environmentId,
        environmentVersion,
        targetIdentity: input.targetIdentity,
    }, now);
    return { ok: true, state: next, resume };
}
const EVENT_FROM = {
    expected_captured: 'capture_expected',
    current_inspected: 'inspect_current',
    drift_classified: 'classify_drift',
    repair_settled: 'repair_or_reconcile',
    revalidation_settled: 'revalidate',
};
/**
 * 阶段机：capture_expected → inspect_current → classify_drift → repair_or_reconcile
 * → revalidate → ready / blocked_scope（§33.3）。
 *
 * 不跳步、不进回头门：错阶段的事件一律拒绝，终态（ready / blocked_scope）不再受理任何事件。
 * 核验时间与对象版本在 `current_inspected` 落盘，`validUntil` 同时按波动性算出来。
 * 身份对不上时不静默继续：写一条 needs_authorization 继续走阶段机（不回落默认账户，§22.13）。
 */
export function advanceResume(state, resumeId, event, now) {
    const resume = state.resumes[resumeId];
    if (resume === undefined)
        return { ok: false, state, reason: `恢复评估 ${resumeId} 不存在` };
    if (EVENT_FROM[event.kind] !== resume.phase) {
        return { ok: false, state, resume, reason: `阶段机不跳步：${resume.phase} 只接受 ${EVENT_FROM[event.kind]} 一类的下一条事件（§33.3）` };
    }
    let next;
    switch (event.kind) {
        case 'expected_captured':
            next = { ...resume, phase: 'inspect_current' };
            break;
        case 'current_inspected': {
            const manifest = manifestAt(state, resume.environmentId, resume.environmentVersion);
            const mismatch = event.targetIdentityObserved !== resume.targetIdentity;
            const identityEntry = {
                ref: 'target_identity',
                finding: 'needs_authorization',
                action: `当前目标身份与预期不一致（观测 ${event.targetIdentityObserved} ≠ 预期 ${resume.targetIdentity}）：不回落默认账户或目录，先给恢复方案与授权（§33.2、§22.13）`,
                allowedScope: FINDING_ACTIONS.needs_authorization.allowedScope,
            };
            next = {
                ...resume,
                phase: 'classify_drift',
                checkedAt: event.observedAt,
                validUntil: manifest === undefined ? resume.validUntil : validUntilFor(manifest.items, event.observedAt),
                objectVersions: { ...resume.objectVersions, ...(event.objectVersionsObserved ?? {}) },
                findings: mismatch ? [...resume.findings, identityEntry] : resume.findings,
            };
            break;
        }
        case 'drift_classified': {
            const drifted = event.findings.some((item) => item.finding !== 'unchanged');
            next = { ...resume, phase: drifted ? 'repair_or_reconcile' : 'revalidate', findings: event.findings };
            break;
        }
        case 'repair_settled':
            next = { ...resume, phase: event.unresolvedRefs.length === 0 ? 'revalidate' : 'blocked_scope' };
            break;
        case 'revalidation_settled':
            next = { ...resume, phase: event.ok ? 'ready' : 'blocked_scope' };
            break;
        default:
            return { ok: false, state, resume, reason: 'unknown resume event' };
    }
    const nextState = commit({ ...state, resumes: put(state.resumes, resumeId, next) }, 'environment/resume_advanced', {
        resumeId,
        from: resume.phase,
        to: next.phase,
        event: event.kind,
    }, now);
    return { ok: true, state: nextState, resume: next };
}
/** 准入时效与并发变化（§33.3）：核验之后资源仍可能变化，所以每次准入前都要重查这几个数。 */
export function resumeIsCurrent(resume, current, now) {
    const verdict = (ok, reason) => ({ ok, reason, grantsExecution: false });
    if (resume.phase !== 'ready')
        return verdict(false, `恢复评估阶段为 ${resume.phase}，不是 ready：先走完阶段机`);
    if (resume.validUntil !== undefined && now > resume.validUntil) {
        return verdict(false, `准入时效已过（validUntil=${resume.validUntil}）：时间有效期按资源波动性设置，需重新检查（§33.3）`);
    }
    if (current.attemptId !== undefined && resume.attemptId !== undefined && current.attemptId !== resume.attemptId) {
        return verdict(false, `评估绑定尝试 ${resume.attemptId}，当前尝试为 ${current.attemptId}：长时间排队或有变化事件时重新检查`);
    }
    if (current.environmentVersion !== undefined && current.environmentVersion !== resume.environmentVersion) {
        return verdict(false, `环境清单已修订到 v${current.environmentVersion}（评估绑定 v${resume.environmentVersion}）：重新检查再录取`);
    }
    const observed = current.objectVersions;
    if (observed !== undefined) {
        for (const [ref, version] of Object.entries(resume.objectVersions)) {
            const latest = observed[ref];
            if (latest === undefined)
                return verdict(false, `评估记录的对象 ${ref} 这次没有观测值：不能确认它没变，重新检查`);
            if (latest !== version)
                return verdict(false, `核验后 ${ref} 从 ${version} 变为 ${latest}：条件写入或再检查阻止覆盖（§33.3）`);
        }
        for (const ref of Object.keys(observed)) {
            if (resume.objectVersions[ref] === undefined)
                return verdict(false, `出现评估未记录的对象 ${ref}：不假装它不影响本次恢复`);
        }
    }
    return verdict(true, '检查仍在时效内且对象版本一致；这不构成执行权，受管动作仍需当前票据（§33.3）');
}
/**
 * 关键写入前的条件检查（§33.3）：预期版本对不上就停下，而不是覆盖。
 *
 * 没有版本条件写入、也没有真实隔离能力时，如实说明"这次核验只是一个时点观察"——
 * 不承诺消除了检查与执行之间的竞态，必要时串行核对。
 */
export function guardedWrite(resume, targetRef, expectedVersion, currentVersion, options = {}) {
    if (resume.phase !== 'ready') {
        return { ok: false, reason: `恢复评估阶段为 ${resume.phase}：未 ready 不能写入受管目标` };
    }
    if (currentVersion !== expectedVersion) {
        return { ok: false, reason: `目标 ${targetRef} 已从 ${expectedVersion} 变为 ${currentVersion}：条件写入 / 再检查阻止覆盖（§33.3）` };
    }
    if (options.conditionalWriteSupported === true || options.isolated === true) {
        return { ok: true, reason: `目标 ${targetRef} 版本一致且具备条件写入/隔离能力；不构成执行权，仍需当前票据` };
    }
    return {
        ok: true,
        reason: `目标 ${targetRef} 版本一致；不构成执行权，仍需当前票据`,
        caveat: '该对象没有版本条件写入与真实隔离能力：本次核验只是一个时点观察，必要时串行核对；不承诺消除检查与执行之间的竞态（§33.3）',
    };
}
/**
 * §33.4：恢复前保留重要候选产物与当前版本；恢复操作本身也走 Operation 回执与预算。
 *
 * 只挑与本次恢复相关（发现或对象版本里点到名）的产物链头，不顺手把整个仓库抄一遍；
 * 恢复不覆盖用户新改动，保留的是"恢复开始时的当前版本"。
 */
export function preservationPlan(state, resume) {
    const relevant = new Set([...resume.findings.map((item) => item.ref), ...Object.keys(resume.objectVersions)]);
    const preserved = [];
    for (const group of Object.values(state.artifacts)) {
        const head = group[group.length - 1];
        if (head === undefined)
            continue;
        if (!relevant.has(head.uri) && !relevant.has(head.artifactId))
            continue;
        preserved.push({ artifactId: head.artifactId, uri: head.uri, version: head.version, contentHash: head.contentHash });
    }
    preserved.sort((a, b) => compareRef(a.artifactId, b.artifactId));
    const operations = resume.findings
        .filter((item) => item.finding !== 'unchanged')
        .map((item) => ({
        kind: 'recovery_operation',
        target: item.ref,
        reason: item.action,
        requiresReceipt: true,
        budgetNote: '恢复操作按 Operation 回执登记并从 Mission 预算扣除（§33.4）',
    }))
        .sort((a, b) => compareRef(a.target, b.target));
    const note = preserved.length === 0
        ? '没有与本次恢复挂上关系的产物版本需要保留；恢复动作仍须走回执与预算'
        : `保留 ${preserved.length} 个当前产物版本（按版本链头取），恢复不覆盖用户新改动；只重验受影响结论，换会话不默认全部无效（§33.4）`;
    return { preserved, operations, note };
}
/** §33.4：只重验受影响的结论与产物；也不能因上下文完整就跳过实际环境核对。 */
export function revalidationPlan(resume) {
    const revalidateRefs = resume.findings
        .filter((item) => item.finding === 'changed' || item.finding === 'temp_missing' || item.finding === 'job_done_no_receipt')
        .map((item) => item.ref);
    const unaffectedRefs = resume.findings.filter((item) => item.finding === 'unchanged').map((item) => item.ref);
    return {
        revalidateRefs: revalidateRefs.sort(compareRef),
        unaffectedRefs: unaffectedRefs.sort(compareRef),
        note: '只重验受影响结论与产物；无关任务不重跑，但上下文完整不能替代实际环境核对（§33.4）',
    };
}
/**
 * 一次完整的恢复评估：capture_expected → … → ready / blocked_scope。
 *
 * 停在 `repair_or_reconcile` 或 `revalidate` 是**正常结果**，不是失败：
 * 核对 / 补登记 / 重建要真的做完（`repairsSettled`）、受影响结果要真的重验（`revalidation`），
 * 本函数不会替调用方宣称这两件事已经发生。
 */
export function assessResume(state, input, now) {
    const opened = openResume(state, input, now);
    if (!opened.ok || opened.resume === undefined)
        return { ok: false, state: opened.state, reason: opened.reason ?? '无法开始恢复评估' };
    let current = opened.state;
    let resume = opened.resume;
    const step = (event) => {
        const advanced = advanceResume(current, resume.resumeId, event, now);
        if (!advanced.ok || advanced.resume === undefined)
            return advanced.reason ?? '阶段推进失败';
        current = advanced.state;
        resume = advanced.resume;
        return undefined;
    };
    const notes = [];
    const missing = step({ kind: 'expected_captured' });
    if (missing !== undefined)
        return { ok: false, state: current, reason: missing };
    const inspected = step({
        kind: 'current_inspected',
        observedAt: now,
        targetIdentityObserved: input.observedTargetIdentity ?? input.targetIdentity,
        objectVersionsObserved: input.objectVersions,
    });
    if (inspected !== undefined)
        return { ok: false, state: current, reason: inspected };
    const manifest = manifestAt(current, resume.environmentId, resume.environmentVersion);
    if (manifest === undefined)
        return { ok: false, state: current, reason: `清单 ${resume.environmentId} v${resume.environmentVersion} 已不可读` };
    const byRef = new Map(input.observations.map((item) => [item.ref, item]));
    const entries = [];
    const uncheckedRefs = [];
    for (const item of manifest.items) {
        const observation = byRef.get(item.ref) ?? {
            kind: item.kind,
            ref: item.ref,
            sensitivity: item.sensitivity,
            coverage: item.coverage,
            observation: 'unobserved',
        };
        const verdict = classifyFinding({ coverage: item.coverage, ...observation });
        entries.push(verdict.entry);
        for (const note of verdict.notes)
            notes.push(`${item.ref}: ${note}`);
        if (item.coverage === 'unknown')
            uncheckedRefs.push(item.ref);
    }
    // 身份不符等前置发现已经在 resume.findings 里，和这次观测的发现合在一起分类。
    const allFindings = [...resume.findings, ...entries];
    const classified = step({ kind: 'drift_classified', findings: allFindings });
    if (classified !== undefined)
        return { ok: false, state: current, reason: classified };
    const plan = planChecks(manifest.nextAction);
    const requiredUnknown = uncheckedRefs.filter((ref) => {
        const item = manifest.items.find((candidate) => candidate.ref === ref);
        return item !== undefined && plan.kinds.includes(item.kind);
    });
    const blockedRefs = allFindings.filter((item) => item.finding === 'job_unknown' || item.finding === 'needs_authorization').map((item) => item.ref);
    const affectedRefs = allFindings
        .filter((item) => item.finding === 'changed' || item.finding === 'temp_missing' || item.finding === 'job_done_no_receipt')
        .map((item) => item.ref);
    const unresolved = [...blockedRefs, ...requiredUnknown];
    if (resume.phase === 'repair_or_reconcile') {
        if (unresolved.length > 0) {
            const settled = step({ kind: 'repair_settled', unresolvedRefs: unresolved.sort(compareRef) });
            if (settled !== undefined)
                return { ok: false, state: current, reason: settled };
        }
        else if (affectedRefs.length > 0 && input.repairsSettled !== true) {
            notes.push('核对 / 补登记 / 重建尚未完成：评估停在 repair_or_reconcile，本函数不替调用方宣称恢复动作已做完（§33.2）');
        }
        else {
            const settled = step({ kind: 'repair_settled', unresolvedRefs: [] });
            if (settled !== undefined)
                return { ok: false, state: current, reason: settled };
        }
    }
    if (resume.phase === 'revalidate') {
        if (input.revalidation !== undefined) {
            const done = step({ kind: 'revalidation_settled', ok: input.revalidation.ok, note: input.revalidation.note });
            if (done !== undefined)
                return { ok: false, state: current, reason: done };
        }
        else if (affectedRefs.length === 0) {
            const done = step({ kind: 'revalidation_settled', ok: true, note: '没有受影响结果需要重验' });
            if (done !== undefined)
                return { ok: false, state: current, reason: done };
        }
        else {
            notes.push('受影响结果尚未重验：评估停在 revalidate，重验通过与否由调用方给出（§33.4）');
        }
    }
    notes.push('ResumeAssessment 只是恢复过程的检查结果，不构成执行权：受管动作仍需当前票据与授权（§33.3）');
    if (requiredUnknown.length > 0) {
        notes.push(`下一步动作依赖的 ${requiredUnknown.sort(compareRef).join(', ')} 未核验：该范围 blocked_scope，已独立满足条件的工作仍可进行（§33.1）`);
    }
    return {
        ok: true,
        state: current,
        resume,
        verdict: {
            ready: resume.phase === 'ready',
            blockedRefs: unresolved.sort(compareRef),
            uncheckedRefs: uncheckedRefs.sort(compareRef),
            uncheckedRequired: requiredUnknown.sort(compareRef),
            revalidateRefs: affectedRefs.sort(compareRef),
            scopeByRef: Object.fromEntries(allFindings.map((item) => [item.ref, item.allowedScope])),
            notes,
            grantsExecution: false,
        },
    };
}
/** 显式 id 键排序：不依赖 locale，也不用对象插入顺序当语义。 */
function compareRef(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
