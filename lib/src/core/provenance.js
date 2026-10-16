/**
 * 记录权威、证据溯源与争议保留（设计稿 v0.5 §32 全节；验收情形 V5-06、V5-07 的溯源面）。
 *
 * 这一层只做机械判定与计数，不做语义裁决：
 * - 四类记录（原始观测/解释猜想/决策/摘要转述）不得相互冒充，各类"可以证明什么"是判定
 *   表而不是建议（§32.1）；
 * - 派生关系靠引用列表与索引实现，声明性派生链不得循环；导入材料出现循环时标记，不从
 *   循环推导支持度（§32.2）；
 * - 独立来源计数按**显式**来源链与共同依赖保守归并：三个代理反复转述同一次实验只算一个
 *   观测来源；共用数据处理/实现/验证器的记录不构成相互独立的支持；无法确认独立性时标
 *   unknown，不用代理人数计算置信度（§32.2）；
 * - 结论更新的使用限制：已反证的只能研究失效原因，不能作为生产用途前提；摘要保留原始
 *   历史但必须携带新有效性，且不得删除适用条件（§32.3）。
 *
 * 强度分层（§32.4）：普通笔记允许缺项，只记警告；进入重要决定、验收、路线关闭或正式交付
 * 的命题按 `decision_grade` 校验，缺项即拦截。校验函数以"能拦住错误"为正例标准（DG-10）：
 * 每条判定都配已知坏样例测试，坏样例被放行即为缺陷。
 *
 * v1 的保守口径：只按显式声明的 `rootRefs`/`derivation`/`commonDeps` 归并与标记；内容哈希
 * 相同只说明字节相同，不自动合并，来源不同也不自动判独立（§32.2）。
 */
import { INEFFECTIVE_RESULTS } from './entities.js';
/** 来源类别 → 记录类别的机械映射（§32.1 表）。 */
export function recordClassOf(sourceCategory) {
    switch (sourceCategory) {
        case 'observation':
            return 'observation';
        case 'reported':
            return 'summary';
        case 'inference':
        case 'conjecture':
        case 'simulated':
            return 'interpretation';
        case 'reference_bound':
            // 绑定权威来源的读数按观测类处理；相应记录必须带权威绑定引用（§22.8 DG-08）。
            return 'observation';
    }
}
/**
 * §32.1 "可以证明什么"一列的机械判定：把某类记录放进"独立支持证据"的位置上检查。
 * 坏样例：用解释/猜想或决策记录当事实支持、把摘要当新增独立证据——都必须被拦下或降级。
 */
export function recordClassUse(recordClass, use) {
    if (use === 'context') {
        return { ok: true, countsAsIndependent: false, reason: `${recordClass} 只作上下文转述，不进入支持计数` };
    }
    switch (recordClass) {
        case 'observation':
            return {
                ok: true,
                countsAsIndependent: true,
                reason: '原始观测可以证明当次记录所覆盖的事件或结果；完整性仍需按覆盖回执核对（§32.1、§28.4）',
            };
        case 'summary':
            return {
                ok: true,
                countsAsIndependent: false,
                reason: '摘要/转述是派生视图，不是新增独立证据：它指向的原观测最多计一次（§32.1、§32.2）',
            };
        case 'interpretation':
            return {
                ok: false,
                countsAsIndependent: false,
                reason: '解释/猜想只证明代理提出过该解释，不证明原因成立：不能当事实支持（§32.1）',
            };
        case 'decision':
            return {
                ok: false,
                countsAsIndependent: false,
                reason: '决策只证明当时的选择与权限范围，不证明选项优劣：不能当事实支持（§32.1）',
            };
    }
}
const PROVENANCE_KINDS = ['evidence', 'artifact', 'operation', 'session', 'external', 'report', 'none'];
/** 原始证据层的来源（§28.2）：观测类记录至少要落在其中一个上。 */
const ROOT_REF_KINDS = ['evidence', 'artifact', 'operation', 'session', 'external'];
/** 单条来源引用的格式与自洽校验（§32.1）：none 只表示 provenance_unknown，不能带地址或版本。 */
export function checkProvenanceRef(ref) {
    if (!PROVENANCE_KINDS.includes(ref.kind))
        return { ok: false, reason: `来源引用种类 ${String(ref.kind)} 不在词表内` };
    if (ref.kind === 'none') {
        if (ref.ref.trim().length > 0) {
            return { ok: false, reason: 'provenance_unknown（none）必须不带具体引用：要么给出来源，要么如实标无法追溯（§32.1）' };
        }
        if (ref.version !== undefined)
            return { ok: false, reason: '无法追溯的旧材料没有版本：none 不得带版本（§32.1）' };
        return { ok: true, reason: 'provenance_unknown：如实标记无法追溯，不得据此伪造引用，也不得当作独立证据（§32.1）' };
    }
    if (ref.ref.trim().length === 0)
        return { ok: false, reason: `来源引用 ${ref.kind} 缺引用地址` };
    if (ref.version !== undefined && ref.version.trim().length === 0) {
        return { ok: false, reason: `来源引用 ${ref.kind}:${ref.ref} 的版本为空串：留空与"未标版本"不同` };
    }
    return { ok: true, reason: `${ref.kind} 引用格式有效` };
}
/**
 * 溯源链完整性评估（§32.1、§32.2、§32.3）。
 *
 * 硬错（任何强度都拦）：坏引用、同一条记录同时声称"无法追溯"与具体来源、观测类只有转述
 * 引用或标 none、观测类带派生关系（确定性不得超过被引用记录）、派生链成环；
 * 缺口（decision_grade 拦）：观测类缺根引用、转述/解释类既无引用也无派生、引用的来源不在
 * 记录中——普通笔记按 §32.4 只记警告，不制造官僚负担。
 */
export function assessProvenance(subject, sources, strength = 'ordinary') {
    const recordClass = recordClassOf(subject.sourceCategory);
    const findings = [];
    const hard = (kind, detail) => {
        findings.push({ kind, severity: 'hard', detail });
    };
    const gap = (kind, detail) => {
        findings.push({ kind, severity: 'gap', detail });
    };
    const note = (kind, detail) => {
        findings.push({ kind, severity: 'note', detail });
    };
    const refs = subject.rootRefs ?? [];
    for (const ref of refs) {
        const verdict = checkProvenanceRef(ref);
        if (!verdict.ok)
            hard('invalid_ref', verdict.reason);
    }
    const noneRefs = refs.filter((ref) => ref.kind === 'none');
    const traceableRefs = refs.filter((ref) => ref.kind !== 'none');
    const rootRefs = refs.filter((ref) => ROOT_REF_KINDS.includes(ref.kind));
    const reportRefs = refs.filter((ref) => ref.kind === 'report');
    if (noneRefs.length > 0 && traceableRefs.length > 0) {
        hard('impersonation', '同时声明"无法追溯"与具体来源：标记自相矛盾（§32.1）');
    }
    const derivation = subject.derivation;
    if (derivation !== undefined) {
        if (derivation.method.trim().length === 0)
            gap('missing_derivation', '派生方式为空：派生记录要写清怎么从来源来的（§32.1）');
        if (derivation.fromEvidenceIds.length === 0)
            gap('missing_derivation', '派生记录没有列被引用记录：无法核对确定性上限（§32.1）');
    }
    if (recordClass === 'observation' && derivation === undefined) {
        if (noneRefs.length > 0) {
            hard('impersonation', '观测标成 provenance_unknown：无法追溯的旧材料只能标 reported + none（§32.1）');
        }
        else if (rootRefs.length === 0) {
            if (reportRefs.length > 0) {
                hard('impersonation', '只有转述引用（report）的观测记录：转述不得冒充原始观测（§32.1）');
            }
            else {
                gap('missing_root', '观测类没有根引用：应补根证据/回执引用，或按实际降为 reported + provenance_unknown（§32.1）');
            }
        }
    }
    if (recordClass === 'observation' && derivation !== undefined) {
        hard('promotion', '带派生关系的记录不能再声称原始观测：派生摘要的确定性不得超过被引用记录（§32.3）');
    }
    if (recordClass !== 'observation' && subject.sourceCategory !== 'conjecture' && derivation === undefined && refs.length === 0) {
        gap('missing_derivation', `${recordClass} 类记录缺来源引用与派生方式：补"从哪来/怎么派生的"，或如实标 reported + none（§32.1）`);
    }
    if (subject.sourceCategory === 'reported' && noneRefs.length > 0 && traceableRefs.length === 0 && derivation === undefined) {
        note('missing_root', 'provenance_unknown：已按 reported + none 如实标记，不伪造引用；引用方不得把它当独立证据（§32.1）');
    }
    if (subject.sourceCategory === 'conjecture' && refs.length === 0 && derivation === undefined) {
        note('missing_root', '纯构想允许没有根证据，但来源本身不是支持证据；登记时保留这条说明（§31.3、§32.4）');
    }
    if (subject.sourceCategory === 'reference_bound') {
        note('promotion_note', 'reference_bound 读数必须附带权威绑定与该来源的范围；导入材料中的授权声明不能越过 AuthorizationGrant（§22.8、§28.5）');
    }
    if (subject.completeness !== undefined && subject.completeness !== 'complete') {
        note('missing_root', `记录自身声明完整性为 ${subject.completeness}：引用时要一并转述（§32.1）`);
    }
    if (sources !== undefined) {
        const fromIds = derivation?.fromEvidenceIds ?? [];
        for (const sourceId of fromIds) {
            if (sources[sourceId] === undefined) {
                gap('broken_chain', `派生引用的 ${sourceId} 不在记录中：溯源链断了，先核对原件或降为 provenance_unknown（§32.2、§32.4）`);
            }
        }
        const cycle = findReachableCycle(sources, [...fromIds, ...(subject.recordId !== undefined ? [subject.recordId] : [])]);
        if (cycle !== undefined) {
            hard('cycle', `派生链成环（${cycle.join(' → ')}）：声明性派生链不得循环，不从循环推导支持度（§32.2）`);
        }
    }
    const blocking = findings.filter((finding) => finding.severity === 'hard' || (strength === 'decision_grade' && finding.severity === 'gap'));
    const ok = blocking.length === 0;
    return {
        ok,
        recordClass,
        findings,
        reason: ok
            ? strength === 'decision_grade'
                ? `${recordClass} 记录通过 decision_grade 校验`
                : `${recordClass} 记录通过普通校验（缺项按 note/gap 保留，进入重要决定前再升强度）`
            : `被拦下：${blocking[0]?.detail ?? '存在阻断项'}`,
    };
}
/** 对既有证据记录的便捷包装（§32.1）：把实体摊成 `ProvenanceSubject` 再校验。 */
export function assessEvidenceProvenance(evidence, sources, strength = 'ordinary') {
    return assessProvenance({
        sourceCategory: evidence.kind,
        recordId: evidence.evidenceId,
        rootRefs: evidence.rootRefs,
        derivation: evidence.derivation,
        completeness: evidence.completeness,
    }, sources, strength);
}
function findReachableCycle(evidence, starts) {
    const visiting = new Set();
    const done = new Set();
    const stack = [];
    const walk = (id) => {
        if (done.has(id))
            return undefined;
        if (visiting.has(id)) {
            const start = stack.indexOf(id);
            return [...stack.slice(start), id];
        }
        visiting.add(id);
        stack.push(id);
        for (const next of evidence[id]?.derivation?.fromEvidenceIds ?? []) {
            const hit = walk(next);
            if (hit !== undefined)
                return hit;
        }
        stack.pop();
        visiting.delete(id);
        done.add(id);
        return undefined;
    };
    for (const start of starts) {
        const hit = walk(start);
        if (hit !== undefined)
            return hit;
    }
    return undefined;
}
/** 全图派生环扫描（§32.2）：导入材料的声明性派生链成环时标记，不从循环推导支持度。 */
export function findDerivationCycles(evidence) {
    const cycles = new Map();
    const visiting = new Set();
    const done = new Set();
    const stack = [];
    const walk = (id) => {
        if (done.has(id))
            return;
        if (visiting.has(id)) {
            const start = stack.indexOf(id);
            const cycle = [...stack.slice(start)].sort();
            const key = cycle.join('>');
            if (!cycles.has(key))
                cycles.set(key, cycle);
            return;
        }
        visiting.add(id);
        stack.push(id);
        for (const next of evidence[id]?.derivation?.fromEvidenceIds ?? [])
            walk(next);
        stack.pop();
        visiting.delete(id);
        done.add(id);
    };
    for (const id of Object.keys(evidence).sort())
        walk(id);
    return [...cycles.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, cycle]) => cycle);
}
function refIdentity(ref) {
    return `${ref.kind}:${ref.ref}${ref.version !== undefined ? `@${ref.version}` : ''}`;
}
/**
 * 溯源链追踪（§32.1、§32.2）：沿 `derivation.fromEvidenceIds` 递归到根引用或纯构想。
 * 成环、缺节点、既无来源又无引用都标出并且**不**产出虚假的根。
 */
export function traceProvenance(evidence, evidenceId) {
    const reasons = [];
    const chain = [];
    const roots = new Set();
    const visited = new Set();
    let cycle = false;
    let unknown = false;
    const walk = (id) => {
        if (visited.has(id)) {
            cycle = true;
            reasons.push(`派生链在 ${id} 处成环：声明性派生链不得循环，不从循环推导支持度（§32.2）`);
            return;
        }
        visited.add(id);
        chain.push(id);
        const record = evidence[id];
        if (record === undefined) {
            unknown = true;
            reasons.push(`链上引用 ${id} 不在记录中：链路不完整，按无法确认处理`);
            return;
        }
        const derived = record.derivation?.fromEvidenceIds ?? [];
        if (derived.length > 0) {
            for (const next of [...derived].sort())
                walk(next);
            return;
        }
        const refs = (record.rootRefs ?? []).filter((ref) => ref.kind !== 'none');
        if (refs.length > 0) {
            for (const ref of refs)
                roots.add(refIdentity(ref));
            return;
        }
        if (record.kind === 'conjecture') {
            reasons.push(`${id} 是纯构想：允许没有根证据，来源本身不是支持证据（§31.3）`);
            return;
        }
        unknown = true;
        reasons.push(`${id} 既没有派生来源也没有根引用：provenance_unknown，不得当作独立证据（§32.1）`);
    };
    walk(evidenceId);
    return { evidenceId, chain, roots: [...roots].sort(), cycle, unknown, reasons };
}
/**
 * 独立来源报告（§32.2）：
 * - 同一来源链（如三个代理转述同一次实验）归并为一组，只算一个观测来源；
 * - 共用显式 `commonDeps`（数据处理/实现/验证器）的记录保守归并，并单独列出共因；
 * - 无来源链或成环的记录标 unknown，不计入独立数；
 * - 内容哈希相同不自动合并，来源不同也不自动判独立——v1 只认显式声明。
 */
export function independenceReport(evidence, ids) {
    const requested = [...new Set(ids)].sort();
    const reasons = [];
    const notes = [];
    const unknown = [];
    const cycles = [];
    const origins = new Map();
    for (const id of requested) {
        const trace = traceProvenance(evidence, id);
        if (trace.cycle) {
            cycles.push(id);
            unknown.push(id);
            reasons.push(`${id}：溯源链成环，不从循环推导支持度，不计入独立来源数（§32.2）`);
            continue;
        }
        if (trace.unknown || trace.roots.length === 0) {
            unknown.push(id);
            reasons.push(`${id}：无法确认来源（${trace.reasons[0] ?? '缺来源链'}），不计入独立来源数（§32.2）`);
            continue;
        }
        origins.set(id, trace.roots);
    }
    const parent = new Map();
    const find = (id) => {
        let root = id;
        while (parent.get(root) !== root)
            root = parent.get(root) ?? root;
        let cursor = id;
        while (parent.get(cursor) !== cursor) {
            const next = parent.get(cursor) ?? cursor;
            parent.set(cursor, root);
            cursor = next;
        }
        return root;
    };
    const union = (a, b) => {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB)
            parent.set(rootB, rootA);
    };
    for (const id of origins.keys())
        parent.set(id, id);
    const byOrigin = new Map();
    for (const [id, roots] of origins) {
        const key = roots.join('|');
        byOrigin.set(key, [...(byOrigin.get(key) ?? []), id]);
    }
    for (const members of byOrigin.values()) {
        for (const member of members.slice(1))
            union(members[0] ?? member, member);
    }
    const depMembers = new Map();
    for (const id of origins.keys()) {
        const record = evidence[id];
        for (const dep of record?.commonDeps ?? []) {
            depMembers.set(dep, [...(depMembers.get(dep) ?? []), id]);
        }
    }
    const sharedDeps = [];
    for (const [dep, members] of [...depMembers.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (members.length < 2)
            continue;
        sharedDeps.push({ dep, members: [...members].sort() });
        for (const member of members.slice(1))
            union(members[0] ?? member, member);
    }
    const groupMembers = new Map();
    for (const id of origins.keys()) {
        const root = find(id);
        groupMembers.set(root, [...(groupMembers.get(root) ?? []), id]);
    }
    const groups = [];
    for (const [root, members] of [...groupMembers.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const sortedMembers = [...members].sort();
        const originKeys = new Set();
        for (const member of sortedMembers)
            for (const key of origins.get(member) ?? [])
                originKeys.add(key);
        const viaDeps = sharedDeps.filter((entry) => entry.members.filter((member) => sortedMembers.includes(member)).length >= 2).map((entry) => entry.dep);
        groups.push({ origin: [...originKeys].sort().join('|'), members: sortedMembers, viaDeps: viaDeps.sort() });
        if (sortedMembers.length > 1) {
            reasons.push(viaDeps.length > 0
                ? `${sortedMembers.length} 项记录（${sortedMembers.join(', ')}）因共用依赖（${viaDeps.join(', ')}）归并：只算一个来源的多次解释，不构成相互独立的支持（§32.2）`
                : `${sortedMembers.length} 项记录（${sortedMembers.join(', ')}）源自同一来源（${[...originKeys].sort().join('|')}）：反复转述同一次观测只算一个观测来源（§32.2）`);
        }
    }
    for (const entry of sharedDeps) {
        reasons.push(`共用依赖 ${entry.dep} 的记录（${entry.members.join(', ')}）：共同数据处理/实现/验证器是共因风险，不构成相互独立的支持（§32.2）`);
    }
    const hashes = new Map();
    for (const id of requested) {
        const hash = evidence[id]?.contentHash;
        if (hash === undefined || hash.length === 0)
            continue;
        hashes.set(hash, [...(hashes.get(hash) ?? []), id]);
    }
    if ([...hashes.values()].some((members) => members.length > 1)) {
        notes.push('存在内容哈希相同的记录：字节相同不自动证明观测同源，来源不同也不自动证明独立——按显式来源链与共同依赖判定（§32.2）');
    }
    if (cycles.length > 0)
        notes.push(`成环记录：${cycles.join(', ')}；不从循环推导支持度（§32.2）`);
    notes.push('v1 只检测显式来源链与共同依赖；未声明的关系不猜测，无法确认独立性时以 unknown 输出（§32.2）');
    return { requested, independentSources: groups.length, groups, unknown, sharedDeps, notes, reasons };
}
/** 独立来源数（§32.2）：unknown 不计入——不能确认独立性就不给"多来源"的假象。 */
export function independentSourceCount(evidence, ids) {
    return independenceReport(evidence, ids).independentSources;
}
/** 同一条记录的研究用途与正式采纳用途不同（§32.3）：已反证可用于研究失效原因，不能当已证实前提。 */
export function claimUsableFor(claim, use) {
    const ref = `${claim.claimId}@${claim.version}`;
    if (use === 'research') {
        return {
            ok: true,
            reason: `${ref} 可用于研究其成立或失效原因；研究用途不把结论当已证实前提（§32.1、§32.3）`,
            requiredConditions: [],
        };
    }
    if (claim.retractedAt !== undefined) {
        return {
            ok: false,
            reason: `${ref} 已撤回（${claim.retractionReason ?? '未写原因'}）：只能研究失效原因，不能作为生产用途前提（§32.3）`,
            requiredConditions: [],
        };
    }
    if (INEFFECTIVE_RESULTS.includes(claim.validity)) {
        return { ok: false, reason: `${ref} 依据有效性为 ${claim.validity}：先按当前依据复核再使用（§32.3）`, requiredConditions: [] };
    }
    if (claim.status === 'refuted') {
        return {
            ok: false,
            reason: `${ref} 已被反证：只能研究失效原因，不能作为生产用途的已证实前提（§32.3）`,
            requiredConditions: [],
        };
    }
    if (claim.status === 'unsupported') {
        return { ok: false, reason: `${ref} 目前不支持：不得当已证实前提；补证据或降低断言强度（§32.3）`, requiredConditions: [] };
    }
    if (claim.status === 'proposed') {
        return { ok: false, reason: `${ref} 尚未调查/未评估（proposed）：先做判别动作再引用（§32.3）`, requiredConditions: [] };
    }
    if (claim.status === 'superseded') {
        return { ok: false, reason: `${ref} 已被替代：引用当前版本，旧版本只留历史（§32.3）`, requiredConditions: [] };
    }
    if (claim.contradictingEvidenceIds.length > 0) {
        return {
            ok: false,
            reason: `${ref} 存在反证（${claim.contradictingEvidenceIds.join(', ')}）：争议未裁决前只能按"在范围 X 下暂用"处理（§34.2）`,
            requiredConditions: claim.appliesUnder,
        };
    }
    return {
        ok: true,
        reason: `${ref} 在其适用条件下可作为前提使用；摘要必须同时带上条件（§32.3）`,
        requiredConditions: claim.appliesUnder,
    };
}
/**
 * §32.3：支持某个条件下的结论，摘要不得删除条件——机械比对结构化字段。
 * 自然语言是否扩大结论仍是可出错的语义检查，本条不宣称防止（§32.3）。
 */
export function conditionsRetained(source, derivedConditions) {
    const missing = source.appliesUnder.filter((condition) => !derivedConditions.includes(condition));
    if (missing.length === 0) {
        return { ok: true, missing, reason: `派生视图保留了 ${source.claimId}@${source.version} 的全部适用条件` };
    }
    return {
        ok: false,
        missing,
        reason: `派生视图删除了适用条件：${missing.join(' / ')}；语义扩写仍是可出错的语义检查，本条不宣称绝对防止（§32.3）`,
    };
}
