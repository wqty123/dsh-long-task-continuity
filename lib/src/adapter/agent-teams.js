/**
 * 原生 Agent Team 任务板的**只读接入层**（新版复审报告 G1）：结构化视图，不 import 任何 `@deepseek-ai/*`。
 *
 * 与 `src/team/board-sync.ts` 的写入侧相对：这一层只读——把宿主 `agentTeams.listTasks(caller)` 的
 * 返回归一化成可信行，再把"原生执行状态"与"插件验收状态"按 `(teamRootSessionId, nativeTaskId)`
 * 映射合成一张任务板。G1 的四项缺口在这里落地三项：① 原生任务读取（`normalizeNativeTasks`）；
 * ② 身份映射（`NativeTaskLink`）；③ 生命周期联动与"原生 completed vs 插件验收"的关系定义
 * （`acceptanceFromNative` / `dependencyRisks`）。④ Lead 轮换限制在 `src/rotation/policy.ts`。
 * 真正的接线（读时机、链接落盘、工作台消费）由组合层完成，本文件只有纯函数与类型。
 *
 * 真机字段口径（本机 `<DSH 源码>` @ v0.2.1-alpha.1 源码核对）：
 * - `team/task` 事件的折叠形状是 `{ version: 2; teamId: TeamId; task: TeamTaskSnapshot }`
 *   （dsh: `packages/experimental/agent-team/src/types.ts:234`），任务板唯一数据源就是 Lead
 *   会话日志里的这些事件（dsh: `projection.ts:270-291`、`task-board.ts:66/208`）。
 * - `TeamTaskSnapshot` 字段照抄：`id`、`revision`、`subject`、`description`、
 *   `status`、`ownerId?`、`blockedBy`、`writeScopes`（dsh: `types.ts:74-83`）。
 *   **没有 title/assignee/createdAt/updatedAt 字段**：标题就是 `subject`（`types.ts:78`），
 *   负责人就是 `ownerId`/`ownerName`（`types.ts:80`、`task-view.ts:38-42`），依赖就是 `blockedBy`
 *   （`types.ts:81`）。本层不编造真机上不存在的字段名。
 * - 任务状态词表：`'pending' | 'in_progress' | 'completed' | 'deleted'`（dsh: `types.ts:71`），
 *   领取即 `in_progress` + 写 `ownerId`（`task-board.ts:129-136`），`complete` 只从 `in_progress`
 *   进 `completed`（`task-board.ts:162-166`）；`deleted` 被 `listTasks` 过滤
 *   （dsh: `task-board.ts:90-96`），所以板上读得到的状态只有前三档。
 * - `listTasks(caller)` 返回 `TeamTaskView[]`：在快照之上现算 `ownerName`、`ready`、
 *   `writeScopeWarnings`（dsh: `index.ts:189-190`、`task-view.ts:37-62`）。
 * - 授权门槛：调用者必须是活体成员；根会话（或父会话已不在 Agent 注册表）的活体 Agent 被
 *   `tryMembership` 隐式判为 `role:'lead'`（dsh: `roster.ts:92-117`，Lead 分支在 107/115 行）。
 *   新会话不会自动继承旧 Team——这就是 G1 要求"Lead 优先原会话压缩、轮换受限"的原因。
 *
 * ⚠️ 结构一致 ≠ 语义一致：字段按真源码核对，但未在真实宿主上跑过故障注入；读取一律按不可信输入收窄。
 */
import { TASK_MARKER, markerKeyOf } from '../team/board-mirror.js';
/** 字符串字段：原样保留（含空串，文本域不做意义判断）。 */
function textOf(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}
/** 身份类字段（id/ownerId/ownerName）：空串不构成身份，按缺席处理。 */
function identOf(record, key) {
    const value = record[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
}
/** 版本号：真机是正整数（dsh: `projection.ts:78`）；0/负数/非安全整数都按读不到。 */
function revisionOf(record, key) {
    const value = record[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}
function flagOf(record, key) {
    const value = record[key];
    return typeof value === 'boolean' ? value : undefined;
}
/** 字符串列表（真机 blockedBy/writeScopes/writeScopeWarnings 均为 string[]）：只保留字符串元素。 */
function textListOf(record, key) {
    const value = record[key];
    if (!Array.isArray(value))
        return undefined;
    const result = [];
    for (const item of value) {
        if (typeof item === 'string')
            result.push(item);
    }
    return result;
}
/**
 * 归一化 `listTasks` 的返回（不可信输入）：非对象条目（含 null/数组/原始值）剔除；
 * 对象条目的字段类型对不上就保持 `undefined`——缺面不编造、不折算、不抛。
 * 属性读取可能被 getter 抛，所以整行处理包 try，读抛的行按"无法形成可信条目"剔除
 * （照 `src/team/board-mirror.ts:216-247` 的收窄惯例）。
 * @param raw - 宿主返回值（不可信）。
 * @returns 按宿主顺序排列的容错行。
 */
export function normalizeNativeTasks(raw) {
    if (!Array.isArray(raw))
        return [];
    const result = [];
    for (const item of raw) {
        try {
            if (item === null || typeof item !== 'object' || Array.isArray(item))
                continue;
            const record = item;
            const id = identOf(record, 'id');
            const revision = revisionOf(record, 'revision');
            const subject = textOf(record, 'subject');
            const description = textOf(record, 'description');
            const status = textOf(record, 'status');
            const ownerId = identOf(record, 'ownerId');
            const ownerName = identOf(record, 'ownerName');
            const blockedBy = textListOf(record, 'blockedBy');
            const writeScopes = textListOf(record, 'writeScopes');
            const ready = flagOf(record, 'ready');
            const writeScopeWarnings = textListOf(record, 'writeScopeWarnings');
            result.push({
                ...id === undefined ? {} : { id },
                ...revision === undefined ? {} : { revision },
                ...subject === undefined ? {} : { subject },
                ...description === undefined ? {} : { description },
                ...status === undefined ? {} : { status },
                ...ownerId === undefined ? {} : { ownerId },
                ...ownerName === undefined ? {} : { ownerName },
                ...blockedBy === undefined ? {} : { blockedBy },
                ...writeScopes === undefined ? {} : { writeScopes },
                ...ready === undefined ? {} : { ready },
                ...writeScopeWarnings === undefined ? {} : { writeScopeWarnings },
            });
        }
        catch {
            continue;
        }
    }
    return result;
}
/**
 * 从任务板行自身重建链接（G3 首版只读口径）。
 *
 * 为什么不需要第二张表或"写链接"的命令：台账投影把映射键写在**行自己的** description 首行
 * （`src/team/board-mirror.ts:24` 的 `continuity:task <taskId>`），所以链接是任务板自带的元数据，
 * 每轮从板上读回来的行即可重建（照 `board-mirror.ts:12-13` 的"幂等、插件内存不存第二份状态"口径）。
 * 只读双栏阶段不开放写，因此这里只消费读取结果。
 *
 * 三条收窄：
 * - `id` 读不到的行不参与（无法寻址，留在未链接清单里可见）；
 * - Mission 状态行（`continuity:mission`）不是工作项，不参加链接；
 * - 同一个插件任务被多行引用时只认第一条（原生 id 由宿主按创建顺序分配，首条即最早），
 *   多余的行不吞——它回到 `mergeTaskView` 的 `unlinked`，页面上照样看得见。
 * @param tasks - `normalizeNativeTasks` 的结果（同一 Team 的一次读取）。
 * @param teamRootSessionId - 本次读取所属的根会话；`linkedAt`/`linkedBy` 记录"键来自行自身"这一事实。
 */
export function linksFromNativeBoard(tasks, teamRootSessionId) {
    const links = {};
    for (const task of tasks) {
        if (task.id === undefined || task.description === undefined)
            continue;
        const key = markerKeyOf(task.description);
        if (key === undefined || !key.startsWith(`${TASK_MARKER} `))
            continue;
        const taskId = key.slice(`${TASK_MARKER} `.length);
        if (taskId.length === 0 || links[taskId] !== undefined)
            continue;
        links[taskId] = { teamRootSessionId, nativeTaskId: task.id, linkedAt: 0, linkedBy: 'board-marker' };
    }
    return links;
}
/**
 * 这个会话是否持有**原生 Agent Team 身份**（§G1 的 Lead 保护判据）。
 *
 * 为什么不能只看 `tryMembership` 的 role：dsh 的 `roster.tryMembership` 给每个没有父会话（或父会话
 * 已不在注册表）的活体 Agent 隐式判 `role:'lead'`（dsh: `roster.ts:100/115`），单飞会话也算 Lead——
 * 拿 role 当判据会把所有会话都保护起来，自动轮换直接失效。真判据是名册里**有没有队友行**：
 * `roster.list(membership)` 恒先放一行 `role:'lead'`（dsh: `roster.ts:129-137`），只有真的建过 Team
 * 才追加 `role:'teammate'` 行（同文件 `:138-142`）。队友自己调用时也看得到队友行（它自己是其中一行），
 * 因此"换会话会让原生成员身份失效"这一保护对它同样成立。
 * @returns `'team'` 持有原生身份；`'none'` 本部署没有 Team 面、或只是隐式单飞 Lead（没有队友）；
 *          `'unknown'` 有 Team 面但读不出来（没有活体 Agent、或读取抛）——身份无法核对，按在场处理。
 */
export function nativeTeamIdentity(roster, agent) {
    if (roster === undefined)
        return 'none';
    if (agent === undefined)
        return 'unknown';
    let rows;
    try {
        rows = roster.listMembers(agent);
    }
    catch {
        return 'unknown';
    }
    if (!Array.isArray(rows))
        return 'unknown';
    for (const row of rows) {
        if (row === null || typeof row !== 'object')
            continue;
        if (row.role === 'teammate')
            return 'team';
    }
    return 'none';
}
/**
 * 从一条会话事件里读出原生成员身份。
 * @param event - 候选事件（任意形状，按不可信输入收窄）。
 * @returns 成员身份，或 `undefined` 当它不是一条形状完整的 `team/member`。
 */
export function teamMemberOf(event) {
    if (event === null || typeof event !== 'object')
        return undefined;
    const record = event;
    if (record['type'] !== 'team/member')
        return undefined;
    const data = record['data'];
    if (data === null || typeof data !== 'object')
        return undefined;
    const body = data;
    const teamId = body['teamId'];
    if (typeof teamId !== 'string' || teamId.length === 0)
        return undefined;
    const raw = body['member'];
    if (raw === null || typeof raw !== 'object')
        return undefined;
    const member = raw;
    const id = member['id'];
    const name = member['name'];
    const phase = member['phase'];
    if (typeof id !== 'string' || id.length === 0)
        return undefined;
    if (typeof name !== 'string' || name.length === 0)
        return undefined;
    if (phase !== 'provisioning' && phase !== 'active' && phase !== 'failed')
        return undefined;
    return { teamId, member: { id, name, phase } };
}
/** 原生状态 → 执行状态。只认真机三档（dsh: `types.ts:71`）；`deleted`/词表外不折算成确定态。 */
function executionOf(nativeStatus) {
    if (nativeStatus === 'completed')
        return 'completed';
    if (nativeStatus === 'in_progress')
        return 'running';
    if (nativeStatus === 'pending')
        return 'pending';
    // undefined / 'deleted' / 不认识的新词：不折算（与 `board-mirror.ts:26-30` 同一 fail-closed 口径）。
    return 'unknown';
}
/**
 * 定义"原生执行状态"与"插件验收状态"的关系（§G1 明确要求先定义再接入）。
 *
 * 口径：
 * - `execution` 只从原生 status 折算；原生 `completed` **不等于**验收——验收结论以插件记录为准：
 *   `validity === 'current' && (status === 'completed' || criteriaSatisfied)`。
 *   `criteriaSatisfied` 是台账"按当前判据版本已证明"的结论（`src/views/export.ts:1021`、
 *   `src/core/discipline.ts:49-56`），与 completed 等效可作为验收依据；`validity` 仍是闸门
 *   （完成项依据被撤回后不再计数，`src/core/completion.ts:39`）。
 * - `acceptance` 词表：`accepted`（已验收）/ `needs_review`（记为完成但依据不再 current，
 *   需复核）/ `pending`（已提交或验证中，等验收结论）/ `none`（其余：还没到验收面或终态负结果）。
 * - `gateNote` 分支（顺序即优先级，全部可断言）：
 *   1. 原生 completed 而插件未验收 → `'原生执行已完成，等待插件验收：验收结论以插件记录为准'`；
 *   2. 插件已验收而原生未完成（已知 pending/in_progress）→ `'口径矛盾：插件已验收但原生执行未完成，可能依赖方已按原生状态放行，需核对'`
 *      ——这正是 G1 要防的"两套状态各自放行"；原生状态读不到时不算矛盾，只报未知；
 *   3. 执行状态 unknown（读不到或词表外）→ `'原生任务状态读不到或不在词表：执行状态未知，需核对'`；
 *   4. 其余 `''`（无话可说）。
 * @param nativeStatus - 原生任务状态（读不到给 undefined）。
 * @param plugin - 插件任务的最小状态面（字段出处：`src/core/entities.ts:47-58/77`、`src/core/entities.ts:164-194`）。
 * @returns 执行状态、验收状态与关卡备注；纯函数，无墙钟。
 */
export function acceptanceFromNative(nativeStatus, plugin) {
    const execution = executionOf(nativeStatus);
    const accepted = plugin.validity === 'current'
        && (plugin.status === 'completed' || plugin.criteriaSatisfied === true);
    const acceptance = accepted
        ? 'accepted'
        : plugin.status === 'completed'
            ? 'needs_review'
            : plugin.status === 'submitted' || plugin.status === 'verifying'
                ? 'pending'
                : 'none';
    if (execution === 'completed' && acceptance !== 'accepted') {
        return { execution, acceptance, gateNote: '原生执行已完成，等待插件验收：验收结论以插件记录为准' };
    }
    if (acceptance === 'accepted' && (nativeStatus === 'pending' || nativeStatus === 'in_progress')) {
        return { execution, acceptance, gateNote: '口径矛盾：插件已验收但原生执行未完成，可能依赖方已按原生状态放行，需核对' };
    }
    if (execution === 'unknown') {
        return { execution, acceptance, gateNote: '原生任务状态读不到或不在词表：执行状态未知，需核对' };
    }
    return { execution, acceptance, gateNote: '' };
}
/** 负责人口径：先 `ownerName`（dsh: `task-view.ts:38-42`），退回 `ownerId`（dsh: `types.ts:80`）。 */
function assigneeOf(task) {
    return task.ownerName ?? task.ownerId;
}
function summarize(link, task) {
    const assignee = assigneeOf(task);
    return {
        teamRootSessionId: link.teamRootSessionId,
        nativeTaskId: link.nativeTaskId,
        ...task.subject === undefined ? {} : { title: task.subject },
        ...task.status === undefined ? {} : { status: task.status },
        ...assignee === undefined ? {} : { assignee },
        ...task.revision === undefined ? {} : { revision: task.revision },
        ...task.blockedBy === undefined ? {} : { blockedBy: task.blockedBy },
        ...task.ready === undefined ? {} : { ready: task.ready },
    };
}
/**
 * 把原生任务与插件任务按链接合并成一张板。规则：
 * - 每个插件任务一行卡片（不管有没有链接）；每个已链接的卡片带原生摘要。
 * - **同一任务一张卡**：被卡片引用过的原生任务不再进 `unlinked`；同一原生任务被两条链接引用时，
 *   只由最先出现的那张卡持有执行事实，后到的卡片给核对行（不复制事实）。
 * - 链接指向的原生任务读不到 → `native: undefined`，`gateNote` 固定为
 *   `'链接的原生任务在任务板里读不到：执行状态未知，需核对'`；验收仍按插件记录算。
 * - 没有建立链接的插件任务 → `gateNote` 固定为 `'尚未建立原生任务链接：执行状态未映射，需核对'`
 *   （与"链接了但读不到"分开说，不把没尝试的读法说成读失败）。
 * - 孤立链接（键不在本批插件任务里）不生效：它不引用任何原生行，被指向的原生任务回到 `unlinked`
 *   ——坏链接不能让执行事实消失。
 *
 * 调用方契约：`nativeTasks` 与这批 `links` 必须来自同一 `teamRootSessionId`（原生 id 只在 Team 内唯一，
 * dsh: `task-board.ts:52`）；本层无法从入参核验，只在卡片上原样回显根会话 id 供上游比对。
 * 纯函数、确定性：同一输入两次调用逐字节相同，不取墙钟、不排序（顺序由入参决定）。
 * @param input - 插件任务、原生读取结果与链接记录。
 * @returns 卡片列表与未链接原生任务列表。
 */
export function mergeTaskView(input) {
    const claimed = new Map();
    const cards = [];
    for (const pluginTask of input.pluginTasks) {
        const link = input.links[pluginTask.taskId];
        let native;
        let gateNoteOverride;
        if (link !== undefined) {
            const found = input.nativeTasks.find((task) => task.id === link.nativeTaskId);
            const owner = claimed.get(link.nativeTaskId);
            if (found === undefined) {
                gateNoteOverride = '链接的原生任务在任务板里读不到：执行状态未知，需核对';
            }
            else if (owner !== undefined) {
                gateNoteOverride = `该原生任务（${link.nativeTaskId}）已由插件任务 ${owner} 链接：一份执行事实只挂一张卡，需核对链接`;
            }
            else {
                claimed.set(link.nativeTaskId, pluginTask.taskId);
                native = summarize(link, found);
            }
        }
        else {
            gateNoteOverride = '尚未建立原生任务链接：执行状态未映射，需核对';
        }
        const state = acceptanceFromNative(native?.status, pluginTask);
        cards.push({
            taskId: pluginTask.taskId,
            title: pluginTask.title,
            plugin: { status: pluginTask.status, validity: pluginTask.validity },
            ...native === undefined ? {} : { native },
            execution: state.execution,
            acceptance: state.acceptance,
            gateNote: gateNoteOverride ?? state.gateNote,
        });
    }
    const unlinked = [];
    for (const task of input.nativeTasks) {
        if (task.id !== undefined && claimed.has(task.id))
            continue;
        const assignee = assigneeOf(task);
        unlinked.push({
            ...task.id === undefined ? {} : { nativeTaskId: task.id },
            ...task.subject === undefined ? {} : { title: task.subject },
            ...task.status === undefined ? {} : { status: task.status },
            ...assignee === undefined ? {} : { assignee },
        });
    }
    return { tasks: cards, unlinked };
}
// ────────────────────────────── 依赖风险 ──────────────────────────────
/**
 * 依赖风险清单（§G1："避免原生依赖已放行而插件仍认为前置任务未通过"）。
 *
 * 依赖边取自原生任务条目的 `blockedBy`（dsh: `types.ts:81`）——插件最小视图不带 dependsOn，
 * 依赖评审以**原生 DAG 为骨架**。逐条可断言，顺序 = 卡片顺序 × blockedBy 顺序：
 * 1. 前置原生 completed 但插件侧未验收：有卡片看卡的验收态；没有卡片即"插件没有验收记录"。
 *    —— 原生依赖已放行，而插件下游核对没有对应的验收结论，必须先补映射。
 * 2. 前置插件已验收但原生执行未完成（已知 pending/in_progress）：口径矛盾的另一半——插件侧
 *    可能已按下游放行，而原生还在跑。
 * 3. 前置在本次读取里整个不存在 / 存在但状态读不到：依赖状态未知，需核对（缺面不编造）。
 * @param board - `mergeTaskView` 的输出。
 * @returns 风险描述清单；无风险即空数组。
 */
export function dependencyRisks(board) {
    const cardByNative = new Map();
    const statusByNative = new Map();
    for (const card of board.tasks) {
        if (card.native === undefined)
            continue;
        cardByNative.set(card.native.nativeTaskId, card);
        statusByNative.set(card.native.nativeTaskId, card.native.status);
    }
    for (const unlinked of board.unlinked) {
        if (unlinked.nativeTaskId === undefined)
            continue;
        if (cardByNative.has(unlinked.nativeTaskId))
            continue;
        statusByNative.set(unlinked.nativeTaskId, unlinked.status);
    }
    const risks = [];
    for (const card of board.tasks) {
        const blockedBy = card.native?.blockedBy;
        if (blockedBy === undefined)
            continue;
        for (const blockerId of blockedBy) {
            if (!statusByNative.has(blockerId)) {
                risks.push(`依赖 ${blockerId} 在本次原生任务读取里不存在：依赖状态未知，需核对（依赖方 ${card.taskId}）`);
                continue;
            }
            const blockerStatus = statusByNative.get(blockerId);
            const blockerCard = cardByNative.get(blockerId);
            if (blockerStatus === undefined) {
                risks.push(`依赖 ${blockerId} 的原生状态读不到：依赖状态未知，需核对（依赖方 ${card.taskId}）`);
                continue;
            }
            if (blockerStatus === 'completed' && blockerCard?.acceptance !== 'accepted') {
                risks.push(blockerCard === undefined
                    ? `依赖 ${blockerId} 原生已完成，但任务板里没有对应的插件链接：插件侧没有验收记录，下游 ${card.taskId} 的依赖核对需要映射`
                    : `依赖 ${blockerId}（插件任务 ${blockerCard.taskId}）原生已完成，但插件验收态为 ${blockerCard.acceptance}：原生依赖已放行而插件仍可能拦下游（${card.taskId}），需核对`);
                continue;
            }
            if (blockerCard !== undefined && blockerCard.acceptance === 'accepted'
                && (blockerStatus === 'pending' || blockerStatus === 'in_progress')) {
                risks.push(`依赖 ${blockerId}（插件任务 ${blockerCard.taskId}）插件已验收但原生执行未完成（原生 ${blockerStatus}）：依赖方 ${card.taskId} 可能已按插件状态放行，需核对`);
            }
        }
    }
    return risks;
}
