/**
 * 控制事件与已闭合记录的归档台账（设计稿 v0.3 §5.3；审阅 R4）。
 *
 * 一条原则：**热状态里少掉的任何东西，都必须先在台账里有不可改写的副本**。
 * 用例按审阅复现 `HISTORY_WINDOW` 反向断言——提交 501 条事件后，第一条要么还在热窗口，
 * 要么能在台账里读回来，两者都不成立就是丢失。
 * N3（新版复审 2026-10-15）起读侧快照还要核对**预期覆盖**：前缀/中段/末段/全缺失都要进
 * `unavailable`，两类批次的校验失败都不许再进可信历史。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ArchiveBatch, ArchiveReader } from '../src/core/archive.ts'
import {
  archiveClosedRecordWindow,
  archiveEventWindow,
  archiveExpectation,
  batchContentHash,
  buildEventBatch,
  eventBatchId,
  locationOf,
  readArchiveSnapshot,
  sweepArchive,
  verifyBatch,
} from '../src/core/archive.ts'
import type { ClosedRecordPlan, ControlEvent, MissionControl } from '../src/core/control.ts'
import { MAX_CLOSED_CLAIMS, MAX_RECENT_EVENTS, commit, compactClosedRecords, planClosedRecordDrops } from '../src/core/control.ts'
import type { KvTableLike } from '../src/core/store.ts'
import { MemoryStore } from '../src/core/store.ts'
import { archiveReader, archiveSink } from '../src/adapter/services.ts'
import type { ClaimRevision, ClaimStatus } from '../src/core/entities.ts'
import { freshState, NOW } from './fixtures.ts'
import { renderTimelineMarkdown, toJsonl } from '../src/views/export.ts'

const MISSION = 'mss_test'

/** 与宿主 per-record 表同形的最小假表：归档批次按 batchId 存，可被测试改写以模拟台账损坏。 */
class MapTable<V> implements KvTableLike<V> {
  private readonly rows = new Map<string, V>()

  get(key: string): V | undefined {
    return this.rows.get(key)
  }

  async put(key: string, value: V): Promise<void> {
    this.rows.set(key, structuredClone(value))
  }

  async update(key: string, fn: (current: V) => V): Promise<V> {
    const current = this.rows.get(key)
    if (current === undefined) throw new Error(`table has no record '${key}' to update`)
    const next = structuredClone(fn(structuredClone(current)))
    this.rows.set(key, next)
    return structuredClone(next)
  }

  entries(): IterableIterator<[string, V]> {
    return this.rows.entries()
  }
}

function claimRevision(claimId: string, version: number, status: ClaimStatus, extra: Partial<ClaimRevision> = {}): ClaimRevision {
  return {
    claimId,
    version,
    proposition: `${claimId} 的第 ${version} 版表述`,
    appliesUnder: ['默认窗口'],
    sourceCategory: 'observation',
    status,
    validity: 'current',
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    reentryConditions: [],
    authorActorId: 'lead-1',
    createdAt: NOW + version,
    ...extra,
  }
}

/** 提交出超过热窗口的历史：`count` 条事件，seq 从 0 起。 */
function eventHistory(count: number): MissionControl {
  let state = freshState()
  for (let index = 0; index < count; index += 1) state = commit(state, 'review-event', { index }, NOW + index)
  return state
}

test('R4 回归：提交 501 条事件不静默丢头，落档后第一条仍能从台账读回', async () => {
  const history = eventHistory(MAX_RECENT_EVENTS + 1)
  assert.equal(history.events.length, MAX_RECENT_EVENTS + 1, '未落档前一条都不许减')
  assert.equal(history.events[0]!.seq, 0, '首条事件仍在热窗口里')

  const table = new MapTable<ArchiveBatch>()
  const { state, batch } = await archiveEventWindow(history, archiveSink(table), NOW + MAX_RECENT_EVENTS + 1)
  assert.ok(batch !== null)
  assert.equal(batch.count, 1)
  assert.equal(state.events.length, MAX_RECENT_EVENTS)
  assert.equal(state.archive?.throughSeq, 0)
  assert.equal(state.events[0]!.seq, 1)

  const snapshot = await readArchiveSnapshot(archiveReader(table), MISSION)
  assert.deepEqual(snapshot.events[0], history.events[0], '被裁掉的首条事件必须原样可读回')
  assert.deepEqual(snapshot.unavailable, [], '区间连续且哈希对得上，就不该报缺失')
  const storedBatch = await archiveReader(table).batch(MISSION, batch.batchId)
  assert.ok(storedBatch !== null && verifyBatch(storedBatch), '回读的批次自证通过')
})

test('水位生效后的 commit 只裁已落档的部分', async () => {
  const history = eventHistory(MAX_RECENT_EVENTS + 1)
  const table = new MapTable<ArchiveBatch>()
  const { state } = await archiveEventWindow(history, archiveSink(table), NOW + MAX_RECENT_EVENTS + 1)
  const next = commit(state, 'review-event', { index: MAX_RECENT_EVENTS + 1 }, NOW + MAX_RECENT_EVENTS + 2)
  assert.equal(next.events[0]!.seq, 1, '水位之前已落档的事件不再回到热状态')
  assert.ok(!next.events.some((event) => event.seq === 0), 'seq 0 只在台账里有一份副本')
  assert.equal(next.events.length, MAX_RECENT_EVENTS + 1, '未落档的部分即使超窗也全部保留，等下一次收敛')
})

test('归档写入失败 ⇒ 热窗口一条不减（直接落档与提交后收敛两条入口都是）', async () => {
  const history = eventHistory(MAX_RECENT_EVENTS + 1)
  const failing = {
    appendBatch: async (): Promise<void> => {
      throw new Error('review: injected archive failure')
    },
  }
  await assert.rejects(() => archiveEventWindow(history, failing, NOW), /injected archive failure/)

  const store = new MemoryStore()
  await store.create(MISSION, history)
  const swept = await sweepArchive(store, MISSION, history, { sink: failing }, NOW)
  assert.equal(swept.state, history, '落档失败时交回的就是原状态')
  assert.match(swept.error ?? '', /事件未归档，热窗口保持完整/)
  assert.deepEqual(swept.batches, [])
  const stored = await store.load(MISSION)
  assert.equal(stored?.events.length, MAX_RECENT_EVENTS + 1, '存储里的热窗口没有被裁短')
  assert.equal(stored?.archive, undefined, '失败不能留下半个水位')
})

test('sweepArchive：落档后回写水位，不推进 revision', async () => {
  const history = eventHistory(MAX_RECENT_EVENTS + 1)
  const store = new MemoryStore()
  await store.create(MISSION, history)
  const table = new MapTable<ArchiveBatch>()
  const reader = archiveReader(table)
  const swept = await sweepArchive(store, MISSION, history, { sink: archiveSink(table), reader }, NOW)
  assert.equal(swept.error, undefined)
  assert.equal(swept.batches.length, 1)
  const stored = (await store.load(MISSION))!
  assert.equal(stored.events.length, MAX_RECENT_EVENTS)
  assert.equal(stored.revision, history.revision, '归档是运维动作，不是控制决策')
  assert.equal(stored.archive?.throughSeq, 0)
  const snapshot = await readArchiveSnapshot(reader, MISSION)
  assert.equal(snapshot.events[0]!.seq, 0, '首条事件的 durable 副本在台账里')
})

test('未落档时 compactClosedRecords 不裁：201 条已闭合结论原样留着', () => {
  const claims: Record<string, ClaimRevision[]> = {}
  for (let index = 0; index < MAX_CLOSED_CLAIMS + 1; index += 1) {
    const claimId = `clm_${index}`
    claims[claimId] = [claimRevision(claimId, 1, 'supported'), claimRevision(claimId, 2, 'superseded')]
  }
  const state = freshState({ claims })
  const plan: ClosedRecordPlan = planClosedRecordDrops(state)
  assert.equal(plan.drops.length, 1, '按上限应当裁掉最旧的一条')
  assert.equal(compactClosedRecords(state), state, '台账里没有它就不能删')
  assert.equal(Object.keys(compactClosedRecords(state).claims).length, MAX_CLOSED_CLAIMS + 1)
  assert.equal(compactClosedRecords(state).archivedCounts.claims, undefined)
})

test('落档之后才裁，且 archivedCounts 只认这批真正落档的对象', async () => {
  const claims: Record<string, ClaimRevision[]> = {}
  for (let index = 0; index < MAX_CLOSED_CLAIMS + 1; index += 1) {
    const claimId = `clm_${index}`
    claims[claimId] = [claimRevision(claimId, 1, 'supported'), claimRevision(claimId, 2, 'superseded')]
  }
  const state = freshState({ claims })
  const table = new MapTable<ArchiveBatch>()
  const { state: trimmed, batch } = await archiveClosedRecordWindow(state, archiveSink(table), NOW)
  assert.ok(batch !== null)
  assert.equal(batch.kind, 'closed-records')
  assert.equal(batch.count, 1)
  assert.equal(Object.keys(trimmed.claims).length, MAX_CLOSED_CLAIMS)
  assert.equal(trimmed.archivedCounts.claims, 1)
  assert.equal(trimmed.recordArchive?.batchId, batch.batchId)
  assert.equal(trimmed.recordArchive?.contentHash, batch.contentHash)
  const again = compactClosedRecords(trimmed)
  assert.equal(again, trimmed, '已裁掉的条目不该被再算一次归档计数')
  assert.equal(again.archivedCounts.claims, 1)
})

test('更正与撤回链在台账里保持完整：读者分得出哪条结论不再是当前', async () => {
  const retractedId = 'clm_retracted'
  const claims: Record<string, ClaimRevision[]> = {
    // 插入序第一条：被裁掉的就是它——v1 曾是支持结论，v2 更正并撤回，摘要引用的正是 v1。
    [retractedId]: [
      claimRevision(retractedId, 1, 'supported'),
      claimRevision(retractedId, 2, 'superseded', { supersedesVersion: 1, retractedAt: NOW + 5, retractionReason: '判据口径变更，原证据不再支持' }),
    ],
  }
  for (let index = 0; index < MAX_CLOSED_CLAIMS; index += 1) {
    const claimId = `clm_keep_${index}`
    claims[claimId] = [claimRevision(claimId, 1, 'supported'), claimRevision(claimId, 2, 'superseded')]
  }
  const state = freshState({ claims })
  const table = new MapTable<ArchiveBatch>()
  const { state: trimmed, batch } = await archiveClosedRecordWindow(state, archiveSink(table), NOW)
  assert.ok(batch !== null)
  assert.equal(trimmed.claims[retractedId], undefined, '热状态里已被裁掉')

  const readBack = await archiveReader(table).batch(MISSION, batch.batchId)
  assert.ok(readBack !== null && verifyBatch(readBack))
  const archived = readBack.records.find((record) => record.id === retractedId)?.value as ClaimRevision[]
  assert.equal(archived.length, 2, '撤回不改写历史：整条版本链都还在台账里')
  assert.equal(archived[0]!.status, 'supported')
  assert.equal(archived[1]!.status, 'superseded')
  assert.equal(archived[1]!.supersedesVersion, 1)
  assert.ok(archived[1]!.retractedAt !== undefined, '读者据此判断：摘要引用的 v1 已被更正，当前结论不在这条链上')
})

test('批次被改写就不冒充历史：校验不过的批次只报缺失', async () => {
  const history = eventHistory(MAX_RECENT_EVENTS + 1)
  const table = new MapTable<ArchiveBatch>()
  const { batch } = await archiveEventWindow(history, archiveSink(table), NOW)
  assert.ok(batch !== null)
  const corrupted: ArchiveBatch = { ...batch, events: batch.events.map((event) => ({ ...event, kind: '被事后改过' })), count: batch.events.length }
  await table.put(batch.batchId, corrupted)

  const snapshot = await readArchiveSnapshot(archiveReader(table), MISSION)
  assert.equal(snapshot.events.length, 0, '内容对不上哈希的批次不进事件历史')
  assert.match(snapshot.unavailable.join('；'), /内容校验不过/)

  const ledger = toJsonl(history, snapshot).split('\n').map((line) => JSON.parse(line) as { collection: string; data: { coverage?: { unavailable?: string[] } } })
  assert.deepEqual([...new Set(ledger.map((row) => row.collection))], ['view_meta', 'archive_batch', 'event', 'mission'], '事件行退回热窗口那部分，台账那部分不采信')
  assert.ok(ledger[0]!.data.coverage?.unavailable?.some((line) => line.includes('内容校验不过')))
})

test('宿主表适配是追加语义：同内容重放算成功，不同内容拒绝改写', async () => {
  const history = eventHistory(MAX_RECENT_EVENTS + 1)
  const table = new MapTable<ArchiveBatch>()
  const sink = archiveSink(table)
  const { batch } = await archiveEventWindow(history, sink, NOW)
  assert.ok(batch !== null)
  await sink.appendBatch(batch)
  assert.equal([...table.entries()].length, 1, '重放同一批不产生第二个落点')
  await assert.rejects(() => sink.appendBatch({ ...batch, contentHash: '被替换过的内容' }), /拒绝改写已归档历史/)
  assert.equal(eventBatchId(MISSION, 0, 0), batch.batchId)
})

test('导出口径：未接台账时明说没有事件历史，接了台账时事件行以台账为准', async () => {
  const history = eventHistory(MAX_RECENT_EVENTS + 1)
  const table = new MapTable<ArchiveBatch>()
  const reader = archiveReader(table)
  const { state: trimmed } = await archiveEventWindow(history, archiveSink(table), NOW)

  const bare = toJsonl(trimmed).split('\n').map((line) => JSON.parse(line) as { collection: string; data: Record<string, unknown> })
  assert.deepEqual(bare.map((row) => row.collection), ['view_meta', 'mission'])
  const bareCoverage = bare[0]!.data.coverage as { eventRowsIncluded: boolean; unavailable: string[]; exportedSeqFrom: number | null }
  assert.equal(bareCoverage.eventRowsIncluded, false)
  assert.equal(bareCoverage.exportedSeqFrom, 1)
  assert.ok(bareCoverage.unavailable.some((line) => line.includes('未接入归档台账')), '不接台账就得说清这份文件没有事件历史')

  const snapshot = await readArchiveSnapshot(reader, MISSION)
  const rows = toJsonl(trimmed, snapshot).split('\n').map((line) => JSON.parse(line) as { collection: string; id: string; data: Record<string, unknown> })
  assert.deepEqual([...new Set(rows.map((row) => row.collection))], ['view_meta', 'archive_batch', 'event', 'mission'])
  const eventRows = rows.filter((row) => row.collection === 'event')
  assert.equal(eventRows[0]!.id, `${MISSION}#0`, '首条来自台账，而不是热窗口')
  assert.equal(eventRows.length, MAX_RECENT_EVENTS + 1, '台账 + 热窗口合起来覆盖全部 501 条')
  const coverage = rows[0]!.data.coverage as { exportedSeqFrom: number; exportedSeqTo: number; archivedThroughSeq: number }
  assert.deepEqual([coverage.exportedSeqFrom, coverage.exportedSeqTo, coverage.archivedThroughSeq], [0, MAX_RECENT_EVENTS, 0])

  const timeline = renderTimelineMarkdown(trimmed, 200, snapshot)
  assert.match(timeline, /归档台账 \d+ 批 \/ \d+ 条事件/)
  assert.match(timeline, /不可回读：无/)
})

// —— N3（新版复审 2026-10-15 §N3）：快照必须核对"预期覆盖"，被拒批次不许进可信历史 ——

/** 复审探针（reproduce.mjs）同形的台账桩：只按批次 id 检索，不做过滤与排序——排序是读侧的职责。 */
function readerOf(batches: readonly ArchiveBatch[]): ArchiveReader {
  return {
    batches: async () => batches,
    batch: async (_missionId: string, batchId: string) => batches.find((batch) => batch.batchId === batchId) ?? null,
  }
}

/** 复审探针同形的归档事件：seq 是唯一轴，marker 便于按正文内容断言。 */
function event(seq: number): ControlEvent {
  return { seq, at: NOW, kind: 'audit-event', detail: { marker: `archived-marker-${seq}` } }
}

test('N3 前缀缺失：批次从 seq 10 起时 0–9 也要报缺口（不传 expectation 按起点 0 核对）', async () => {
  const valid = buildEventBatch(MISSION, [event(10), event(11)], NOW)
  const snapshot = await readArchiveSnapshot(readerOf([valid]), MISSION)
  assert.deepEqual(snapshot.events.map((item) => item.seq), [10, 11], '采信事件仍原样返回')
  assert.ok(snapshot.unavailable.some((line) => line.includes('0–9') && line.includes('前缀缺失')), snapshot.unavailable.join('；'))
  assert.equal(snapshot.archivedThroughSeq, 11)
  assert.deepEqual(snapshot.records, [], '事件批次不往 records 里塞东西')
})

test('N3 计数不符＝整批拒用：不再"警告了却照样采信"', async () => {
  const valid = buildEventBatch(MISSION, [event(10), event(11)], NOW)
  const snapshot = await readArchiveSnapshot(readerOf([{ ...valid, count: 99 }]), MISSION)
  assert.equal(snapshot.events.length, 0, '被警告的批次不能同时被当历史用')
  assert.ok(snapshot.unavailable.join('；').includes('未采信'), snapshot.unavailable.join('；'))
  assert.equal(snapshot.archivedThroughSeq, -1, '被拒批次不能推进已核验水位')
  assert.equal(snapshot.batches.length, 1, '被拒批次头保留在 batches 里')
})

test('N3 损坏闭合记录被识别：改坏正文的 closed-records 批次不进 records', async () => {
  const valid = buildEventBatch(MISSION, [event(10), event(11)], NOW)
  const corruptRecord: ArchiveBatch = {
    ...valid,
    batchId: 'corrupt-record',
    kind: 'closed-records',
    events: [],
    records: [{ collection: 'claims', id: 'claim-old', value: { proposition: 'changed' } }],
    count: 1,
    contentHash: batchContentHash([], []),
  }
  const snapshot = await readArchiveSnapshot(readerOf([corruptRecord]), MISSION)
  assert.equal(snapshot.records.length, 0, '哈希对不上的闭合记录条目不能冒充历史')
  assert.ok(snapshot.unavailable.length > 0, '旧实现这里返回空 unavailable，等于误报通过')
  assert.ok(snapshot.unavailable.join('；').includes('内容校验不过'), snapshot.unavailable.join('；'))
})

test('N3 头部范围与正文不符：整批拒绝，头仍留在 batches 里', async () => {
  const valid = buildEventBatch(MISSION, [event(10), event(11)], NOW)
  const snapshot = await readArchiveSnapshot(readerOf([{ ...valid, toSeq: 99 }]), MISSION)
  assert.equal(snapshot.events.length, 0)
  assert.equal(snapshot.batches.length, 1)
  assert.ok(snapshot.unavailable.some((line) => line.includes('头部范围 10–99 与正文 10–11 不一致')), snapshot.unavailable.join('；'))
  assert.equal(snapshot.archivedThroughSeq, -1)
})

test('N3 末批缺失：控制记录水位高于台账覆盖时报出尾部区间', async () => {
  const valid = buildEventBatch(MISSION, [event(10), event(11)], NOW)
  const snapshot = await readArchiveSnapshot(readerOf([valid]), MISSION, { expectedFromSeq: 10, expectedThroughSeq: 14 })
  assert.equal(snapshot.archivedThroughSeq, 11)
  assert.ok(snapshot.unavailable.some((line) => line.includes('12–14') && line.includes('末段缺失')), snapshot.unavailable.join('；'))
  assert.ok(!snapshot.unavailable.some((line) => line.includes('前缀缺失')), '起点 10 与批次起点一致，不该误报前缀')
})

test('N3 中段缺失：批间空洞沿用 missingSeqRanges，措辞带中段标记', async () => {
  const first = buildEventBatch(MISSION, [event(10), event(11)], NOW)
  const second = buildEventBatch(MISSION, [event(14), event(15)], NOW)
  const snapshot = await readArchiveSnapshot(readerOf([first, second]), MISSION, { expectedFromSeq: 10, expectedThroughSeq: 15 })
  assert.deepEqual(snapshot.events.map((item) => item.seq), [10, 11, 14, 15])
  assert.ok(snapshot.unavailable.some((line) => line.includes('12–13') && line.includes('中段缺失')), snapshot.unavailable.join('；'))
})

test('N3 全部批次被删（只剩拒绝批次）：按预期全区间报告，不许静默', async () => {
  const valid = buildEventBatch(MISSION, [event(10), event(11)], NOW)
  const snapshot = await readArchiveSnapshot(readerOf([{ ...valid, count: 99 }]), MISSION, { expectedThroughSeq: 11 })
  assert.equal(snapshot.events.length, 0)
  assert.equal(snapshot.archivedThroughSeq, -1)
  assert.ok(snapshot.unavailable.some((line) => line.includes('0–11') && line.includes('全部缺失')), snapshot.unavailable.join('；'))
})

test('N3 台账为空但调用方声明了覆盖水位：不许静默，明说全区间不可回读', async () => {
  // 声明过水位却读不到任何批次 = 归档全丢（复审 N3 的"完全丢失"这一档）。
  const snapshot = await readArchiveSnapshot(readerOf([]), MISSION, { expectedThroughSeq: 11 })
  assert.deepEqual(snapshot.batches, [])
  assert.equal(snapshot.events.length, 0)
  assert.equal(snapshot.archivedThroughSeq, -1)
  assert.ok(snapshot.unavailable.some((line) => line.includes('0–11') && line.includes('全部缺失')), snapshot.unavailable.join('；'))
})

test('N3 台账为空且没有水位声明：是"没归档过"，不许报成"归档丢了"', async () => {
  // 控制记录没有 `state.archive`（从没裁剪过）时，读不到批次是正常的：命令侧据此输出
  // "热记录还没超过窗口"。这里若照样报"全部历史不可回读"，正常部署上每次 /continuity timeline
  // 都会亮红灯——把"没有归档"说成"归档丢了"和把"归档全丢"说成"还没超过窗口"一样是错。
  const snapshot = await readArchiveSnapshot(readerOf([]), MISSION)
  assert.deepEqual(snapshot.batches, [])
  assert.equal(snapshot.archivedThroughSeq, -1)
  assert.deepEqual(snapshot.unavailable, [], '没有水位声明 + 没有批次 ⇒ 正常空台账')
  // 命令侧判"还没超过窗口"的依据正是这一对条件（src/index.ts 的 case 'archive'）。
  assert.ok(snapshot.batches.length === 0 && snapshot.unavailable.length === 0)
})

test('N3 批次全被拒且没有水位声明：仍是"读不回来"，同样不许静默', async () => {
  const valid = buildEventBatch(MISSION, [event(10), event(11)], NOW)
  const snapshot = await readArchiveSnapshot(readerOf([{ ...valid, count: 99 }]), MISSION)
  assert.equal(snapshot.events.length, 0)
  assert.ok(snapshot.unavailable.some((line) => line.includes('全部不可采信')), snapshot.unavailable.join('；'))
})

test('N3 预期口径由控制记录算出：有水位才要求覆盖，没水位不伪造要求', () => {
  assert.equal(archiveExpectation({}), undefined, '没有 archive 字段 ⇒ 从没裁剪过，不声明覆盖要求')
  assert.equal(archiveExpectation({ archive: undefined }), undefined)
  const watermark = { throughSeq: 11 } as NonNullable<MissionControl['archive']>
  assert.deepEqual(archiveExpectation({ archive: watermark }), { expectedFromSeq: 0, expectedThroughSeq: 11 }, '事件 seq 轴起点固定 0')
  const bad = { throughSeq: -1 } as NonNullable<MissionControl['archive']>
  assert.equal(archiveExpectation({ archive: bad }), undefined, '负数水位不是有效声明')
})

test('N3 采信闭合记录进 records；被拒事件批次不进 archivedThroughSeq', async () => {
  const accepted = buildEventBatch(MISSION, [event(10), event(11)], NOW)
  const rejected = { ...buildEventBatch(MISSION, [event(98), event(99)], NOW), count: 5 }
  const drops = [{ collection: 'claims', id: 'claim-old', value: { proposition: '归档前的表述' } }]
  const recordBatch: ArchiveBatch = {
    batchId: 'arc_test_records_kept',
    missionId: MISSION,
    kind: 'closed-records',
    fromSeq: 10,
    toSeq: 11,
    count: drops.length,
    committedAt: NOW,
    contentHash: batchContentHash([], drops),
    location: locationOf('arc_test_records_kept'),
    events: [],
    records: drops,
  }
  const snapshot = await readArchiveSnapshot(readerOf([accepted, rejected, recordBatch]), MISSION, { expectedFromSeq: 10, expectedThroughSeq: 11 })
  assert.deepEqual(snapshot.records, drops, '采信闭合记录批次的原样条目可被读出')
  assert.deepEqual(snapshot.events.map((item) => item.seq), [10, 11])
  assert.equal(snapshot.archivedThroughSeq, 11, '被拒批次哪怕写着 toSeq=99 也不能代表已核验水位')
  assert.ok(snapshot.unavailable.some((line) => line.includes('未采信')), snapshot.unavailable.join('；'))
})
