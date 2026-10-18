/**
 * 纪律视图（编队界面的「纪律」与「注入确认」两块面板的数据面）。
 *
 * 三件事刻意分开，因为它们的可信度不同：
 * 1. **源**：磁盘上那份文件的实际内容、字节数与 sha256 —— 可核对，不是插件里另存的副本。
 * 2. **机制**：这份文件靠什么进入上下文（`dsh-agent-instructions` 的 session baseline）。
 * 3. **证据**：每类身份到底确认过没有。确认过的标"实测"，没确认的标"同路径未单独实测"，
 *    不把推断写成事实。
 *
 * 纪律是**部署环境的事实**，不属于 Mission 状态，所以不塞进台账。
 */
import { createHash } from 'node:crypto';
export const DISCIPLINE_PATH = '/api/continuity.discipline';
/** 把 markdown 按二级标题切成小节；第一条 `#` 标题当作整体标题，不单列。 */
export function splitSections(text) {
    const sections = [];
    let current;
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('## ')) {
            current = { title: line.slice(3).trim(), lines: [] };
            sections.push(current);
            continue;
        }
        if (current === undefined)
            continue;
        if (line.trim().length === 0)
            continue;
        current.lines.push(line);
    }
    return sections;
}
/**
 * 三类身份的注入口径。
 *
 * 事实依据（DSH 侧）：`dsh-agent-instructions` 在**每个 session** 首次请求前把
 * `$DSH_HOME/AGENTS.md` 作为 baseline 消息写进 durable context。leader、成员
 * （`spawn_teammate` 起的是独立 session）、子代理都各自是 session，所以拿到的是**同一份**。
 */
export function disciplineIdentities() {
    return [
        {
            id: 'leader',
            label: 'Leader',
            source: '$DSH_HOME/AGENTS.md',
            mechanism: '当前会话的 baseline 消息（agent-instructions）',
            evidence: 'measured',
            evidenceNote: '2026-10-17 核实：上下文可见且标题与工作包条目一致。这是当时的静态结论，不是每次会话重新探测',
        },
        {
            id: 'member',
            label: '成员',
            source: '$DSH_HOME/AGENTS.md',
            mechanism: '成员是独立 session（spawn_teammate），启动时走同一条 baseline',
            evidence: 'inferred',
            evidenceNote: '与子代理同一条链路，但没有单独起成员验过；标推断不标实测',
        },
        {
            id: 'subagent',
            label: '子代理',
            source: '$DSH_HOME/AGENTS.md',
            mechanism: '子代理同样是独立 session，走同一条 baseline',
            evidence: 'measured',
            evidenceNote: '2026-10-17 实测：子代理原样回引本文件标题与「派单按工作包」条目。是当时的结论，不是实时探测',
        },
    ];
}
/** `readSource` 由装配层注入：返回磁盘上的原文与 mtime，或 undefined 表示文件不存在。 */
export function disciplineView(sourcePath, readSource) {
    const facts = readSource();
    const text = facts?.text ?? '';
    return {
        generatedAt: Date.now(),
        sourcePath,
        present: facts !== undefined,
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: text.length === 0 ? '' : createHash('sha256').update(text, 'utf8').digest('hex'),
        modifiedAt: facts?.modifiedAt ?? '',
        text,
        sections: splitSections(text),
        identities: disciplineIdentities(),
        mechanism: 'dsh-agent-instructions 在建会话首个请求前，把 $DSH_HOME/AGENTS.md 作为 baseline 消息写进 durable context；主 agent、成员、子代理各是独立 session，因此各自都会拿到。',
        notes: [
            '面板显示的是磁盘原文与指纹，不是插件内副本，避免两边漂移。',
            '改这份文件后，**新会话**生效；已在跑的会话沿用其 baseline，需要下一轮或新会话才更新。',
            '纪律只有一份：三类身份共用，差别只在哪个 session 加载它。',
            '「实测」是某次核实的静态结论，不是每次会话重新探测——要确认当下是否生效，看新会话的首轮行为。',
        ],
    };
}
/* ------------------------------------------------------------------ 写回 */
/**
 * 写回纪律文件的校验（纯判断，落盘交给装配层）。
 *
 * 三道闸，缺一不可：
 * 1. **并发保护**：请求必须带上它读到的那一版的 sha256；不匹配就拒——否则两个人同时编辑，
 *    后保存的会静默吃掉前一个人的改动。
 * 2. **不许写空**：空文件等于把纪律删了，而它每轮注入，删了没人会发现。
 * 3. **必须能对照**：当前文件读不到就不让写（否则会凭空造出一份没人核对过的纪律）。
 *
 * 落盘前装配层还要备份；备份路径回给调用方，出问题能拿回来。
 */
export function validateDisciplineWrite(current, request) {
    if (current === undefined) {
        return { ok: false, reason: '当前读不到纪律文件：先确认 $DSH_HOME/AGENTS.md 存在，再谈写回' };
    }
    const text = typeof request.text === 'string' ? request.text : '';
    if (text.trim().length === 0) {
        return { ok: false, reason: '纪律不能写成空：它每轮注入，写空等于静默删掉整份纪律' };
    }
    const expected = typeof request.expectedSha256 === 'string' ? request.expectedSha256 : '';
    if (expected.length === 0) {
        return { ok: false, reason: '缺少 expectedSha256：没有它就无法判断这次写回是否覆盖了别人的改动' };
    }
    const actual = createHash('sha256').update(current.text, 'utf8').digest('hex');
    if (actual !== expected) {
        return {
            ok: false,
            reason: `文件已被改动（磁盘现在是 ${actual.slice(0, 12)}，请求基于 ${expected.slice(0, 12)}）：刷新面板后重试，避免覆盖别人的修改`,
        };
    }
    return { ok: true, text };
}
/** 备份文件名：同目录下按时间戳排，不用随机名，便于人工按时间找。 */
export function disciplineBackupName(now) {
    const pad = (n) => String(n).padStart(2, '0');
    return `AGENTS.${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.md`;
}
