/**
 * 生产接线的存在性回归（一轮复审 G 组 + N4 的注册面）。
 *
 * 这一层拦的是**接线被摘掉**，不是判定算错：判定与投影的行为分别由
 * `test/quality-runner.test.ts`（链的每一步）、`test/agent-teams-adapter.test.ts` +
 * `test/views-workbench.test.ts`（原生板合并与只读投影）、`test/rotation-policy.test.ts`（Lead 保护）、
 * `test/views-history.test.ts`（历史回读工具）负责。本文件用源码窗口断言四件事：
 *
 * 1. §27 质量决策链在生产路径里**只有一个入口**，且挂在空闲维护窗口（`agent/status` 转 idle），
 *    入参把压缩端口、落盘、重读、版本复核、压缩后核对五件都接上（G2）；
 * 2. 自动轮换的入场判定把原生 Team 身份作为参数传进去了（G1）；
 * 3. 工作台路由按会话定位读原生任务板，三种"读不到"分开（G3 左右联动）；
 * 4. 历史回读工具真的注册（名单与注册表逐名对齐），归档快照的两处命令侧读取都带水位预期（N4/N3）。
 *
 * 窗口断言用**唯一的锚点串**取源码片段：锚点改动会直接让本文件报错，这正是它的作用——
 * 接线被改名或被删，测试必须先红，不允许"代码不再调用、测试还全绿"。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { PLUGIN_TOOL_NAMES, commandToolFactories } from '../src/adapter/tools.ts'

const INDEX_SOURCE = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 取 `[startMarker, endMarker)` 之间的源码；任一锚点缺失即失败（不做"读不到就当通过"）。 */
function windowOf(source: string, startMarker: string, endMarker: string, label: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `${label}：起点锚点没找到（${startMarker}）`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(end, -1, `${label}：终点锚点没找到（${endMarker}）`)
  return source.slice(start, end)
}

function countOf(source: string, needle: string): number {
  return source.split(needle).length - 1
}

function assertContains(window: string, needles: readonly string[], label: string): void {
  for (const needle of needles) {
    assert.ok(window.includes(needle), `${label}：接线里缺 ${needle}`)
  }
}

test('G2：§27 质量链在生产路径只有一个入口，且五件依赖全部接上', () => {
  assert.equal(countOf(INDEX_SOURCE, 'runQualityChain({'), 1, '质量链必须只有一个生产调用点：多一个就多一条没有回执的入口')
  const chain = windowOf(INDEX_SOURCE, 'const runIdleQuality = async', 'const evaluateTurnEnd = async', '空闲维护质量链')
  assertContains(
    chain,
    [
      'runQualityChain({',
      // 观测面：宿主投影 + tokenMeter 由 hostSlice 现读；读数带上线口径声明与原生容量。
      'host: hostSlice',
      "service<CompactionEngineLike>('compaction')",
      'compactionPort(engine, agent)',
      'entry: \'idle_maintenance\'',
      'sessionActive: running.has(sessionId)',
      'maintenanceEntryFree:',
      'rotationPending:',
      'missionActive: state.mission.status === \'active\'',
      // 落盘 / 重读 / 压缩前版本复核 / 压缩后核对：四件缺任一条链就只能停在"记了计划"。
      'kernel.submit(',
      'reload:',
      'refetchFrame:',
      'verifyObservation:',
      'postCompactionObservation({',
      'retentionListFromState(',
      'frameFromReadings(',
    ],
    '质量链调用点',
  )
  assert.ok(/report\.steps[\s\S]*logger\.info/.test(chain), 'G2：每一步回执要进日志，否则事后无法核对"到底走到第几步"')
  assert.ok(/report\.notes[\s\S]*logger\.warn/.test(chain), 'G2：降级与失败要按 warn 落日志，不许吞')
})

test('G2：入口挂在空闲维护窗口，不在轮末（轮末调用只会拿到 queue）', () => {
  const status = windowOf(INDEX_SOURCE, "const offAgentStatus = on('agent/status'", 'const forget = (sessionId', 'agent/status 订阅')
  assert.ok(status.includes('void runIdleQuality(sessionId'), 'G2：会话转空闲即空闲维护窗口，链要在这里发起')
  const turnEnd = windowOf(INDEX_SOURCE, 'const evaluateTurnEnd = async', 'let boardSyncResult', '轮末评估')
  assert.ok(!turnEnd.includes('runQualityChain('), 'G2：轮末不发起压缩（那一格会话仍在 running，planActionRun 只会判 queue）')
})

test('G1：自动轮换入场判定带上原生 Team 身份', () => {
  const decision = windowOf(INDEX_SOURCE, 'const decision = decideRotation({', "if (decision.kind === 'rotate')", '轮换入场判定')
  assertContains(decision, ["leadProtected: nativeTeamIdentity(service<NativeTeamRosterLike>('agentTeams'), agents()?.get(sessionId)) !== 'none'"], 'G1：Lead 保护')
})

test('G3：工作台按会话定位读原生任务板，三种"读不到"分开', () => {
  const read = windowOf(INDEX_SOURCE, 'const readNativeBoard = async', 'const workbenchRead = async', '原生板读取')
  assertContains(read, [
    // ① 没有会话定位 ⇒ 连尝试都不做（视图里 `native=null`）
    'if (sessionId === undefined || sessionId.length === 0) return undefined',
    // ② 服务缺席 / 没有活体 Agent ⇒ 尝试了但读不出（视图里 `phase:\'unavailable\'` + 原因）
    "agentTeams 服务未装载",
    'reason: `会话 ${sessionId} 当前没有活体 Agent',
    // ③ 读回来了才归一化成可信行（空板也算读到，视图里 `phase:\'read\'`）
    'tasks: normalizeNativeTasks(',
  ], 'G3：原生板读取')
  const route = windowOf(INDEX_SOURCE, 'const workbenchRead = async', "const connection = service<ConnectionLike>('connection')", '工作台路由')
  assertContains(route, [
    // 不直接读 request.url：部分依赖基线的 @types/node 不带该声明，会让没有 harness typeRoots 的环境类型检查失败。
    "const rawUrl = (request as { readonly url?: string }).url",
    "new URL(rawUrl, 'http://localhost').searchParams.get('sessionId')",
    'state.mission.leadActorId',
    'readNativeBoard(sessionId)',
    'missionWorkbench(state, native)',
  ], 'G3：路由会话定位')
  // 左右联动的客户端一侧：页签的 sessionId 必须真的进查询串，否则服务端只能回落到 Lead 会话。
  const client = windowOf(CLIENT_SOURCE, 'async function readWorkbench(signal, sessionId)', 'function workbenchTaskDetail', '客户端读取')
  assertContains(client, ['"?sessionId=" + encodeURIComponent(sessionId)'], 'G3：客户端会话定位')
  assert.ok(CLIENT_SOURCE.includes('readWorkbench(tab.signal, sessionId)'), 'G3：页签把所属会话传给读取')
})

test('N4：历史回读工具确实注册，且注册面与模型可见名单逐名对齐', () => {
  // 名单与注册表同源对齐：`2 + commandToolFactories.length + 1` 是装配层的实际注册数。
  assert.equal(2 + commandToolFactories.length + 1, PLUGIN_TOOL_NAMES.length, 'N4：注册数与 PLUGIN_TOOL_NAMES 不一致')
  assert.equal(PLUGIN_TOOL_NAMES[PLUGIN_TOOL_NAMES.length - 1], 'continuity_history', 'DS 前缀缓存纪律：新工具只许追加在名单末尾')
  const registration = windowOf(INDEX_SOURCE, 'const deps: ToolDeps = {', '个 continuity_* 工具。', '工具注册')
  assertContains(registration, [
    'history: {',
    'currentMissionId: () => missionId()',
    'load: async (id: string) => await kernel.read(id)',
    'snapshot: async (id: string, expectation?: ArchiveExpectation) => await readArchiveSnapshot(archivePort.reader, id, expectation)',
    // 顺序：status + checkpoint + 命令工具在前，history 追加在末尾（声明列表不能重排）。
    'const factories = [continuityStatusTool, continuityCheckpointTool, ...commandToolFactories, continuityHistoryTool]',
    'factories.length !== PLUGIN_TOOL_NAMES.length',
  ], 'N4：工具注册')
  assert.ok(!registration.includes('PLUGIN_TOOL_NAMES.length} 个 continuity_*'), 'N4：日志报的必须是实际注册数，不能报名单长度')
})

test('N3：命令侧的归档快照读取两处都带控制记录声明的水位预期', () => {
  assert.equal(countOf(INDEX_SOURCE, 'readArchiveSnapshot(archivePort.reader, id, archiveExpectation(state))'), 2, 'N3：timeline 与 archive 两处都要把水位带给读侧')
  assert.equal(countOf(INDEX_SOURCE, 'readArchiveSnapshot(archivePort.reader, id)'), 0, 'N3：不许留下"不核对覆盖面的读侧"')
  const helper = windowOf(INDEX_SOURCE, 'const archiveExpectation = ', 'let sweepingArchive', '水位预期')
  assertContains(helper, ['state.archive === undefined ? undefined : { expectedThroughSeq: state.archive.throughSeq }'], 'N3：预期口径')
  const archiveCase = windowOf(INDEX_SOURCE, "case 'archive': {", "case 'board': {", '归档命令')
  assertContains(archiveCase, ['归档台账没有可采信的批次', '预期水位', '以下区间/批次未采信或缺失'], 'N3：空台账也要报缺失，不当"没有历史"')
})
