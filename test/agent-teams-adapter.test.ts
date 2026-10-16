/**
 * 原生 Agent Team 只读接入层（`src/adapter/agent-teams.ts`，§G1）。
 *
 * 假数据按真机字段形状构造（本机 `D:\deepseek-harness` @ v0.2.1-alpha.1）：
 * - 任务条目 = `TeamTaskView`（dsh: `packages/experimental/agent-team/src/types.ts:86-97`）：
 *   id/revision/subject/description/status/blockedBy/writeScopes/ownerName?/ready/writeScopeWarnings。
 *   真机**没有** title/assignee/createdAt/updatedAt 字段：标题是 `subject`（types.ts:78），
 *   负责人是 `ownerName`/`ownerId`（task-view.ts:38-42、types.ts:80），依赖是 `blockedBy`（types.ts:81）。
 * - status 词表 `pending|in_progress|completed`（`deleted` 被 listTasks 过滤，
 *   dsh: `types.ts:71`、`task-board.ts:93-95`）。
 *
 * 覆盖：链接命中合并、"同一任务一张卡"、未链接进 unlinked、坏/重复/孤立链接、
 * 双向口径矛盾 gateNote、dependencyRisks、normalizeNativeTasks 对畸形输入不编造、确定性。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  acceptanceFromNative,
  dependencyRisks,
  linksFromNativeBoard,
  mergeTaskView,
  nativeTeamIdentity,
  normalizeNativeTasks,
  type NativeTaskLink,
  type NativeTeamRosterLike,
  type NativeTeamTaskView,
  type PluginTaskLike,
} from '../src/adapter/agent-teams.ts'

/** Team 根会话 id（`roster.tryMembership` 以它组织 Team，dsh: roster.ts:92-117）。 */
const ROOT = 'sess-root-1'

/** 一条任务板行：字段形状照 `TeamTaskView`（dsh: types.ts:86-97），默认值只是让用例短。 */
function nativeTask(overrides: Partial<NativeTeamTaskView> = {}): NativeTeamTaskView {
  return {
    id: 'task-1',
    revision: 1,
    subject: '把索引重建脚本跑通',
    description: '口径按任务书',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ownerName: 'lead',
    ready: true,
    writeScopeWarnings: [],
    ...overrides,
  }
}

/** 一条插件台账任务的最小结构（`src/core/entities.ts:164-194`、`src/views/export.ts:909/1021`）。 */
function pluginTask(overrides: Partial<PluginTaskLike> = {}): PluginTaskLike {
  return { taskId: 'T-001', title: '把索引重建脚本跑通', status: 'running', validity: 'current', ...overrides }
}

/** 一条链接（`linkedAt` 由调用方给，本层不取墙钟）。 */
function link(nativeTaskId: string, overrides: Partial<NativeTaskLink> = {}): NativeTaskLink {
  return { teamRootSessionId: ROOT, nativeTaskId, linkedAt: 1_700_000_000_000, linkedBy: 'lead-1', ...overrides }
}

// ────────────────────── ②″ 原生 Team 身份判据（§G1 Lead 保护） ──────────────────────

/** 名册替身：只实现本层用到的 `listMembers`；传函数即以抛错驱动"读不出来"那一档。 */
function rosterOf(rows: readonly unknown[] | (() => readonly unknown[])): NativeTeamRosterLike {
  return { listMembers: () => (typeof rows === 'function' ? rows() : rows) }
}

/** 只带指定字段的行（缺字段就是真的缺，不用 undefined 顶替）。 */
function rowOf(id: string | undefined, description: string | undefined): NativeTeamTaskView {
  return { subject: '行', ...(id === undefined ? {} : { id }), ...(description === undefined ? {} : { description }) }
}

test('G1 nativeTeamIdentity：判据是名册里有队友行，不是 role（单飞会话也被隐式判 lead）', () => {
  const agent = { id: 'sess-root-1' }
  assert.equal(nativeTeamIdentity(undefined, agent), 'none', '本部署没有 Team 面 ⇒ 不保护，自动轮换照常')
  assert.equal(nativeTeamIdentity(rosterOf([]), agent), 'none', '空名册 = 单飞')
  assert.equal(nativeTeamIdentity(rosterOf([{ role: 'lead', name: 'lead' }]), agent), 'none', '只有 lead 行 = 隐式单飞，不算持有 Team 身份（拿 role 当判据会把所有会话都保护起来）')
  assert.equal(nativeTeamIdentity(rosterOf([{ role: 'lead' }, { role: 'teammate' }]), agent), 'team', '有队友行才算持有原生身份')
  assert.equal(nativeTeamIdentity(rosterOf([{ role: 'teammate' }]), agent), 'team', '队友自己调用时也看得到队友行，保护对它同样成立')
})

test('G1 nativeTeamIdentity：读不出来一律 unknown（按在场处理，fail-closed）', () => {
  const agent = { id: 'sess-root-1' }
  assert.equal(nativeTeamIdentity(rosterOf([{ role: 'lead' }]), undefined), 'unknown', '没有活体 Agent ⇒ 身份无法核对')
  assert.equal(nativeTeamIdentity(rosterOf(() => { throw new Error('roster down') }), agent), 'unknown', '读取抛错 ⇒ 不当作"没有身份"')
  assert.equal(nativeTeamIdentity({ listMembers: () => 'nope' as unknown as readonly unknown[] }, agent), 'unknown', '读回来的不是数组 ⇒ unknown')
  assert.equal(nativeTeamIdentity(rosterOf([null, 1, 'x', { role: 'lead' }]), agent), 'none', '坏行跳过；没有队友行仍是单飞')
})

// ────────────────────── ③″ G3 链接重建（不新增表、不新增写命令） ──────────────────────

test('G3 linksFromNativeBoard：链接来自行自身首行的 continuity:task 标记', () => {
  const links = linksFromNativeBoard([
    rowOf('task-1', 'continuity:task T-001\n口径按任务书'),
    rowOf('task-2', 'continuity:mission mss_x'),
    rowOf('task-3', '没有标记的普通行'),
    rowOf('task-4', 'continuity:task T-002'),
  ], ROOT)
  assert.deepEqual(Object.keys(links).sort(), ['T-001', 'T-002'], '只认工作项标记：Mission 状态行与普通行都不进链接')
  assert.deepEqual(links['T-001'], { teamRootSessionId: ROOT, nativeTaskId: 'task-1', linkedAt: 0, linkedBy: 'board-marker' }, '链接记下"键来自行自身"这一事实')
})

test('G3 linksFromNativeBoard：同一任务多行只认首条；寻址不了的行不参与', () => {
  const links = linksFromNativeBoard([
    rowOf('task-1', 'continuity:task T-001'),
    rowOf('task-2', 'continuity:task T-001'),
    rowOf(undefined, 'continuity:task T-002'),
    rowOf('task-3', undefined),
    rowOf('task-4', 'continuity:task'),
  ], ROOT)
  assert.equal(links['T-001']?.nativeTaskId, 'task-1', '重复引用只认第一条（原生 id 按创建顺序分配，首条即最早）')
  assert.equal(links['T-002'], undefined, '缺 id 的行无法寻址，不建链接（它留在未链接清单里可见）')
  assert.equal(Object.keys(links).length, 1, '缺 description、或标记后没有任务 id 的行都不产生链接')
})


test('normalizeNativeTasks：真机 TeamTaskView 形状逐字段收窄', () => {
  const rows = normalizeNativeTasks([
    {
      id: 'task-7',
      revision: 3,
      subject: '重建索引',
      description: '全部字段照真机（dsh: types.ts:86-97）',
      status: 'in_progress',
      ownerName: 'builder',
      blockedBy: ['task-2'],
      writeScopes: ['src/'],
      ready: false,
      writeScopeWarnings: ['write scopes overlap with task-1'],
    },
    // 字段类型对不上：id 空串、subject 非字符串、revision 0、blockedBy 混入非字符串、
    // writeScopes 不是数组、ready 非布尔、ownerName 空串 —— 全部保持 undefined/剔除，不折算。
    { id: '', subject: 42, status: 'claimed', revision: 0, blockedBy: ['task-1', 7], writeScopes: 'x', ready: 'yes', ownerName: '' },
    // 容错读取：ownerId 只在快照面出现（dsh: types.ts:80），碰见就收下。
    { id: 'task-8', status: 'pending', ownerId: 'sess-tm-8' },
  ])
  assert.deepEqual(rows[0], {
    id: 'task-7',
    revision: 3,
    subject: '重建索引',
    description: '全部字段照真机（dsh: types.ts:86-97）',
    status: 'in_progress',
    ownerName: 'builder',
    blockedBy: ['task-2'],
    writeScopes: ['src/'],
    ready: false,
    writeScopeWarnings: ['write scopes overlap with task-1'],
  })
  assert.deepEqual(rows[1], { status: 'claimed', blockedBy: ['task-1'] }, '词表外的 status 原样保留，由 acceptanceFromNative 折算 unknown')
  assert.equal(rows[2]!.ownerId, 'sess-tm-8')
})

test('normalizeNativeTasks：非对象/数组/读抛的条目剔除，缺字段保持 undefined，非数组整体为空', () => {
  const thrower: Record<string, unknown> = {}
  Object.defineProperty(thrower, 'id', {
    get() { throw new Error('宿主 getter 抛错') },
    enumerable: true,
  })
  const rows = normalizeNativeTasks([null, 42, 'task-3', ['task-4'], undefined, thrower, {}])
  assert.deepEqual(rows, [{}], '对象条目连一个字段都没有也保留为"全缺席"，但不猜身份')
  assert.deepEqual(normalizeNativeTasks(undefined as unknown as readonly unknown[]), [])
})

test('链接命中：卡片带原生摘要；同一任务一张卡，未被引用的原生行进 unlinked', () => {
  const input = {
    pluginTasks: [pluginTask({ taskId: 'T-001', title: '重建索引', status: 'running', validity: 'current' })],
    nativeTasks: normalizeNativeTasks([
      nativeTask({ id: 'task-2', subject: '重建索引', status: 'in_progress', ownerName: 'builder' }),
      nativeTask({ id: 'task-3', subject: '清理缓存', status: 'pending', ownerName: undefined }),
      nativeTask({ id: 'task-4', subject: '发布快照', status: 'completed' }),
    ]),
    links: { 'T-001': link('task-2') },
  }
  const board = mergeTaskView(input)
  assert.equal(board.tasks.length, 1)
  const card = board.tasks[0]!
  assert.equal(card.taskId, 'T-001')
  assert.equal(card.title, '重建索引')
  assert.deepEqual(card.plugin, { status: 'running', validity: 'current' })
  assert.deepEqual(card.native, {
    teamRootSessionId: ROOT,
    nativeTaskId: 'task-2',
    title: '重建索引',
    status: 'in_progress',
    assignee: 'builder',
    revision: 1,
    blockedBy: [],
    ready: true,
  })
  assert.equal(card.execution, 'running')
  assert.equal(card.acceptance, 'none')
  assert.equal(card.gateNote, '')
  // 一份执行事实只出现一次：进了卡片的不再进 unlinked。
  assert.deepEqual(board.unlinked, [
    { nativeTaskId: 'task-3', title: '清理缓存', status: 'pending' },
    { nativeTaskId: 'task-4', title: '发布快照', status: 'completed', assignee: 'lead' },
  ])
  assert.deepEqual(mergeTaskView(input), board, '同一输入两次合并逐字节相同')
})

test('链接指向的原生任务读不到：native 缺席、执行未知、gateNote 固定，验收仍以插件记录为准', () => {
  const board = mergeTaskView({
    pluginTasks: [pluginTask({ taskId: 'T-009', status: 'completed', validity: 'current' })],
    nativeTasks: normalizeNativeTasks([nativeTask({ id: 'task-1' })]),
    links: { 'T-009': link('task-99') },
  })
  const card = board.tasks[0]!
  assert.equal(card.native, undefined)
  assert.equal(card.execution, 'unknown')
  assert.equal(card.acceptance, 'accepted')
  assert.equal(card.gateNote, '链接的原生任务在任务板里读不到：执行状态未知，需核对')
})

test('原生 completed 不等于验收；插件已验收而原生未完成则报口径矛盾', () => {
  const waiting = mergeTaskView({
    pluginTasks: [pluginTask({ taskId: 'T-001', status: 'verifying', validity: 'current' })],
    nativeTasks: normalizeNativeTasks([nativeTask({ id: 'task-1', status: 'completed' })]),
    links: { 'T-001': link('task-1') },
  }).tasks[0]!
  assert.equal(waiting.execution, 'completed')
  assert.equal(waiting.acceptance, 'pending')
  assert.equal(waiting.gateNote, '原生执行已完成，等待插件验收：验收结论以插件记录为准')

  const contradiction = mergeTaskView({
    pluginTasks: [pluginTask({ taskId: 'T-002', status: 'completed', validity: 'current', criteriaSatisfied: true })],
    nativeTasks: normalizeNativeTasks([nativeTask({ id: 'task-2', status: 'in_progress' })]),
    links: { 'T-002': link('task-2') },
  }).tasks[0]!
  assert.equal(contradiction.execution, 'running')
  assert.equal(contradiction.acceptance, 'accepted')
  assert.equal(contradiction.gateNote, '口径矛盾：插件已验收但原生执行未完成，可能依赖方已按原生状态放行，需核对')
})

test('acceptanceFromNative：原生词表折算失败即 unknown，插件验收词表逐档', () => {
  assert.deepEqual(acceptanceFromNative(undefined, { validity: 'current', status: 'running' }), {
    execution: 'unknown',
    acceptance: 'none',
    gateNote: '原生任务状态读不到或不在词表：执行状态未知，需核对',
  })
  assert.equal(acceptanceFromNative('deleted', { validity: 'current', status: 'running' }).execution, 'unknown', 'deleted 不在任务板词表里（listTasks 已过滤），不折算')
  assert.equal(acceptanceFromNative('completed', { validity: 'current', status: 'completed' }).gateNote, '')
  assert.equal(
    acceptanceFromNative('completed', { validity: 'current', status: 'running', criteriaSatisfied: true }).acceptance,
    'accepted',
    'criteriaSatisfied 是"按当前判据版本已证明"，与 completed 等效作为验收结论',
  )
  const stale = acceptanceFromNative('completed', { validity: 'needs_review', status: 'completed' })
  assert.equal(stale.acceptance, 'needs_review', '完成项依据被撤回过：需复核')
  assert.equal(stale.gateNote, '原生执行已完成，等待插件验收：验收结论以插件记录为准')
  assert.equal(acceptanceFromNative('in_progress', { validity: 'current', status: 'verifying' }).acceptance, 'pending')
  assert.equal(acceptanceFromNative('in_progress', { validity: 'current', status: 'failed' }).acceptance, 'none')
  assert.equal(acceptanceFromNative('pending', { validity: 'current', status: 'planned' }).gateNote, '')
  assert.equal(acceptanceFromNative('in_progress', { validity: 'invalid', status: 'running' }).acceptance, 'none')
})

test('dependencyRisks：原生已放行而插件未验收、插件已验收而原生未完成，逐条描述', () => {
  const board = mergeTaskView({
    pluginTasks: [
      pluginTask({ taskId: 'T-010', title: '前置 A', status: 'verifying', validity: 'current' }),
      pluginTask({ taskId: 'T-011', title: '任务 B', status: 'running', validity: 'current' }),
      pluginTask({ taskId: 'T-012', title: '前置 C', status: 'completed', validity: 'current' }),
      pluginTask({ taskId: 'T-013', title: '任务 D', status: 'running', validity: 'current' }),
    ],
    nativeTasks: normalizeNativeTasks([
      nativeTask({ id: 'task-10', subject: '前置 A', status: 'completed' }),
      nativeTask({ id: 'task-11', subject: '任务 B', status: 'in_progress', blockedBy: ['task-10'] }),
      nativeTask({ id: 'task-12', subject: '前置 C', status: 'in_progress' }),
      nativeTask({ id: 'task-13', subject: '任务 D', status: 'in_progress', blockedBy: ['task-12'] }),
    ]),
    links: { 'T-010': link('task-10'), 'T-011': link('task-11'), 'T-012': link('task-12'), 'T-013': link('task-13') },
  })
  assert.deepEqual(dependencyRisks(board), [
    '依赖 task-10（插件任务 T-010）原生已完成，但插件验收态为 pending：原生依赖已放行而插件仍可能拦下游（T-011），需核对',
    '依赖 task-12（插件任务 T-012）插件已验收但原生执行未完成（原生 in_progress）：依赖方 T-013 可能已按插件状态放行，需核对',
  ])
})

test('dependencyRisks：没有映射的前置与读不到的前置各给一条兜底', () => {
  const board = mergeTaskView({
    pluginTasks: [pluginTask({ taskId: 'T-020', title: '任务 E', status: 'running', validity: 'current' })],
    nativeTasks: normalizeNativeTasks([
      nativeTask({ id: 'task-20', subject: '任务 E', status: 'in_progress', blockedBy: ['task-21', 'task-22', 'task-23'] }),
      nativeTask({ id: 'task-21', subject: '无映射前置', status: 'completed', ownerName: undefined }),
      nativeTask({ id: 'task-22', subject: '状态读不到的前置', status: undefined }),
    ]),
    links: { 'T-020': link('task-20') },
  })
  assert.deepEqual(dependencyRisks(board), [
    '依赖 task-21 原生已完成，但任务板里没有对应的插件链接：插件侧没有验收记录，下游 T-020 的依赖核对需要映射',
    '依赖 task-22 的原生状态读不到：依赖状态未知，需核对（依赖方 T-020）',
    '依赖 task-23 在本次原生任务读取里不存在：依赖状态未知，需核对（依赖方 T-020）',
  ])
  assert.deepEqual(dependencyRisks({ tasks: [], unlinked: [] }), [])
})

test('链接卫生：重复链接只由先到卡片持有事实；孤立链接不吞执行事实；未链接卡片单独说明', () => {
  const board = mergeTaskView({
    pluginTasks: [
      pluginTask({ taskId: 'T-030', status: 'running', validity: 'current' }),
      pluginTask({ taskId: 'T-031', status: 'running', validity: 'current' }),
      pluginTask({ taskId: 'T-032', status: 'running', validity: 'current' }),
    ],
    nativeTasks: normalizeNativeTasks([
      nativeTask({ id: 'task-30', status: 'in_progress' }),
      nativeTask({ id: 'task-31', status: 'in_progress' }),
    ]),
    links: {
      'T-030': link('task-30'),
      'T-031': link('task-30'), // 重复引用同一原生任务：第二张卡不再复制执行事实
      'T-404': link('task-31'), // 孤立链接：键不是本批任何插件任务，不生效
    },
  })
  assert.equal(board.tasks[0]!.native?.nativeTaskId, 'task-30')
  assert.equal(board.tasks[1]!.native, undefined)
  assert.equal(board.tasks[1]!.gateNote, '该原生任务（task-30）已由插件任务 T-030 链接：一份执行事实只挂一张卡，需核对链接')
  assert.equal(board.tasks[2]!.gateNote, '尚未建立原生任务链接：执行状态未映射，需核对')
  assert.equal(board.tasks[2]!.execution, 'unknown')
  assert.deepEqual(board.unlinked.map((row) => row.nativeTaskId), ['task-31'], '坏链接不能让执行事实消失')
})

test('id 读不到的原生行：无法参与链接，仍列进 unlinked（缺面不编造、不隐藏事实）', () => {
  const board = mergeTaskView({
    pluginTasks: [],
    nativeTasks: normalizeNativeTasks([nativeTask({ id: undefined, ownerName: undefined, subject: '没有 id 的一行' })]),
    links: {},
  })
  assert.deepEqual(board.tasks, [])
  assert.deepEqual(board.unlinked, [{ title: '没有 id 的一行', status: 'pending' }])
})
