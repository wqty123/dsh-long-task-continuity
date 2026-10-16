/**
 * 归档历史回读工具 `continuity_history`（复审 N4）。
 *
 * 工具面是"有界检索"：热状态与归档台账合并后只回本页最年轻的一批，游标翻旧页；
 * 闭合对象按 objectId 在热集合与归档批次里取全部版本并标注来源。本文件盯五件事：
 * 1. 分页：limit 截断最年轻 N 条，nextCursor 能翻到更旧一页；
 * 2. objectId：热与归档两个版本都能取回，且先热后档；
 * 3. 覆盖：unavailable 的缺失范围必须出现在输出里；
 * 4. 缺席：没有归档面时明说"本部署没有归档读取面"，不假装查过；
 * 5. 夹紧：limit 超上限夹到 50，并写明夹紧事实。
 *
 * 工具的调用与结果读取沿用 `test/v05-wiring-tools.test.ts` 的假端口写法；
 * 快照直接构造（不走 archive.ts 读侧），只保留本工具合并所需的字段。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { continuityHistoryTool } from '../src/adapter/tools.ts'
import type { HistoryPort, ToolDeps } from '../src/adapter/tools.ts'
import type { ArchiveExpectation, ArchiveSnapshot } from '../src/core/archive.ts'
import type { ClosedRecordDrop, ControlEvent, MissionControl } from '../src/core/control.ts'
import { commit } from '../src/core/control.ts'
import type { ClaimRevision } from '../src/core/entities.ts'
import { NOW, freshState } from './fixtures.ts'

/* ------------------------------------------------------------------ 假端口与夹具 */

/** 宿主桩按原样返回定义，这里只留本工具实际用到的面。 */
interface HistoryTool {
  readonly name: string
  execute(
    args: {
      readonly missionId?: string
      readonly objectId?: string
      readonly fromSeq?: number
      readonly toSeq?: number
      readonly fromTime?: number
      readonly toTime?: number
      readonly cursor?: string
      readonly limit?: number
    },
    execution: { readonly agent?: { readonly id?: unknown } },
  ): Promise<{ readonly markdown: string; readonly revision: number; readonly nextCursor: string }>
}

/** 复审 N4 探针正相反：热 1 条(seq 12) + 归档 2 条(seq 10、11)、limit 200，旧正文原本完全不出现。 */
function auditEvent(seq: number): ControlEvent {
  return { seq, at: NOW + seq, kind: 'audit-event', detail: { marker: `archived-marker-${seq}` } }
}

function claimRevision(claimId: string, version: number, proposition: string): ClaimRevision {
  return {
    claimId,
    version,
    proposition,
    appliesUnder: ['默认窗口'],
    sourceCategory: 'observation',
    status: version === 1 ? 'superseded' : 'supported',
    validity: 'current',
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    reentryConditions: [],
    authorActorId: 'lead-1',
    createdAt: NOW + version,
  }
}

/** 归档快照：事件批次头 + 采信事件 + 闭合记录条目 + unavailable 原样列举。 */
function snapshotOf(events: readonly ControlEvent[], records: readonly ClosedRecordDrop[], unavailable: readonly string[] = []): ArchiveSnapshot {
  return {
    missionId: 'mss_test',
    batches: [
      {
        batchId: 'arc_mss_test_events_10-11',
        missionId: 'mss_test',
        kind: 'events',
        fromSeq: 10,
        toSeq: 11,
        count: 2,
        committedAt: NOW,
        contentHash: 'a'.repeat(64),
        location: 'storageDomain:continuity/archive/arc_mss_test_events_10-11',
      },
    ],
    events,
    records,
    archivedThroughSeq: 11,
    unavailable,
  }
}

/** 假装配：history 缺省给出；`withHistory: false` 模拟整个归档面缺席。 */
function makeTool(options: {
  readonly state: MissionControl | null
  readonly snapshot: ArchiveSnapshot | null
  readonly withHistory?: boolean
  /** 记录快照调用时带去的预期（N3：控制记录声明的水位）；缺省丢弃。 */
  readonly expectationSink?: (expectation: ArchiveExpectation | undefined) => void
}): HistoryTool {
  const port: HistoryPort = {
    currentMissionId: () => 'mss_test',
    load: async () => options.state,
    snapshot: async (_missionId, expectation) => {
      options.expectationSink?.(expectation)
      return options.snapshot
    },
  }
  const deps = {
    kernel: { read: async () => options.state, submit: async () => { throw new Error('只读工具不应提交命令') } },
    identity: async () => undefined,
    defaultMissionId: () => 'mss_test',
    ...(options.withHistory === false ? {} : { history: port }),
  } as unknown as ToolDeps
  return continuityHistoryTool(deps) as unknown as HistoryTool
}

/* ------------------------------------------------------------------ 用例 */

test('分页：最年轻 limit 条 + nextCursor 能翻到更旧一页，缺失范围可见', async () => {
  const tool = makeTool({
    state: freshState({ events: [auditEvent(12)] }),
    snapshot: snapshotOf([auditEvent(10), auditEvent(11)], [], ['归档事件在 seq 0–9 无副本，这段历史不可回读']),
  })
  const first = await tool.execute({ limit: 2 }, {})
  assert.equal(first.nextCursor, '10', '本页最旧 seq 11 → 游标 10')
  assert.match(first.markdown, /nextCursor=10/)
  assert.ok(first.markdown.includes('archived-marker-11'), '归档正文必须进本页')
  assert.ok(first.markdown.includes('archived-marker-12'), '热正文必须进本页')
  assert.equal(first.markdown.includes('archived-marker-10'), false, 'limit=2 时更旧的 10 不进本页')
  assert.match(first.markdown, /归档事件在 seq 0–9 无副本，这段历史不可回读/, '缺失范围必须出现在输出里')

  const second = await tool.execute({ limit: 2, cursor: first.nextCursor }, {})
  assert.equal(second.nextCursor, '', '已到最早可回读处，无更旧页')
  assert.ok(second.markdown.includes('archived-marker-10'))
  assert.equal(second.markdown.includes('archived-marker-11'), false)
  assert.match(second.markdown, /已没有更旧事件/)
})

test('objectId：热与归档两个版本都取回，标注 source 且先热后档', async () => {
  const tool = makeTool({
    state: freshState({ events: [auditEvent(12)], claims: { clm_1: [claimRevision('clm_1', 2, '现行结论')] } }),
    snapshot: snapshotOf([], [{ collection: 'claims', id: 'clm_1@1', value: claimRevision('clm_1', 1, '被取代的旧结论') }]),
  })
  const result = await tool.execute({ objectId: 'clm_1' }, {})
  assert.match(result.markdown, /claims \/ clm_1@2 \/ hot \//)
  assert.match(result.markdown, /claims \/ clm_1@1 \/ archive \//)
  assert.ok(result.markdown.indexOf('clm_1@2 / hot') < result.markdown.indexOf('clm_1@1 / archive'), '同名先热后档')
  assert.match(result.markdown, /被取代的旧结论/)

  const versionOnly = await tool.execute({ objectId: 'clm_1@1' }, {})
  assert.ok(versionOnly.markdown.includes('clm_1@1 / archive'), '带版本号命中归档版本')
  assert.equal(versionOnly.markdown.includes('clm_1@2'), false, '带版本号只命中该版本')
})

test('归档面缺席：明说没有归档读取面，只给热状态内容', async () => {
  const tool = makeTool({ state: freshState({ events: [auditEvent(12)] }), snapshot: null })
  const result = await tool.execute({}, {})
  assert.match(result.markdown, /本部署没有归档读取面：以下是热状态内容，旧历史不可回读/)
  assert.ok(result.markdown.includes('archived-marker-12'))
  assert.match(result.markdown, /未给 objectId：归档面缺席，闭合记录不列/)

  const bare = makeTool({ state: freshState({ events: [auditEvent(12)] }), snapshot: null, withHistory: false })
  const without = await bare.execute({}, {})
  assert.match(without.markdown, /本部署没有归档读取面/)
})

test('limit 夹紧：默认 20、超上限按 50 执行并写明夹紧事实', async () => {
  let state = freshState()
  for (let index = 0; index < 60; index += 1) state = commit(state, 'audit-event', { index }, NOW + index)
  const tool = makeTool({ state, snapshot: null })

  const clamped = await tool.execute({ limit: 200 }, {})
  const clampedLines = clamped.markdown.split('\n').filter((line) => /^- seq \d+ \/ /.test(line))
  assert.equal(clampedLines.length, 50, '超上限夹紧到 50')
  assert.match(clampedLines[0]!, /^- seq 10 \/ /, '取最年轻的 50 条')
  assert.match(clamped.markdown, /limit：请求 200，按 50 执行/)
  assert.equal(clamped.nextCursor, '9', '更旧还有 10 条，游标指向 seq ≤ 9')

  const fallback = await tool.execute({}, {})
  assert.equal(fallback.markdown.split('\n').filter((line) => /^- seq \d+ \/ /.test(line)).length, 20, '缺省 20 条')
})

test('读不到控制记录时写 unknown，不编造热状态内容', async () => {
  const tool = makeTool({ state: null, snapshot: null })
  const result = await tool.execute({}, {})
  assert.match(result.markdown, /热事件区间：unknown（读不到控制记录）/)
  assert.match(result.markdown, /控制记录也读不到/)
  assert.equal(result.revision, 0)
})

test('快照调用带上控制记录声明的归档水位（N3/N4 核对末批缺失）', async () => {
  const expectations: (ArchiveExpectation | undefined)[] = []
  const watermark = { throughSeq: 11, batchCount: 1, lastBatchId: 'arc_x', lastContentHash: 'a'.repeat(64), lastLocation: 'storageDomain:continuity/archive/arc_x', lastArchivedAt: NOW }
  const tool = makeTool({
    state: freshState({ events: [auditEvent(12)], archive: watermark }),
    snapshot: snapshotOf([auditEvent(11)], []),
    expectationSink: (expectation) => expectations.push(expectation),
  })
  await tool.execute({}, {})
  // 轴起点一并显式声明：事件 seq 从 0 起（src/core/control.ts 的 commit()），
  // 前缀缺失与末段缺失都要能核；不依赖读侧 expectedFromSeq ?? 0 的默认值（默认改了就静默漂移）。
  assert.deepEqual(expectations, [{ expectedFromSeq: 0, expectedThroughSeq: 11 }], '控制记录的水位与轴起点要带给读侧核对')

  const noExpectation: (ArchiveExpectation | undefined)[] = []
  const plain = makeTool({ state: freshState({ events: [auditEvent(12)] }), snapshot: null, expectationSink: (expectation) => noExpectation.push(expectation) })
  await plain.execute({}, {})
  assert.deepEqual(noExpectation, [undefined], '没有水位声明（或读不到记录）就不给预期')
})
