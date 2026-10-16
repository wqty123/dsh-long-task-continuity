/**
 * 控制记录历史的归档端口（设计稿 v0.3 §5.3；审阅 R4）。
 *
 * 热聚合记录只保留最近 `MAX_RECENT_EVENTS` 条事件与收敛后的闭合记录，因此"更早的历史"必须有一个
 * 独立的、追加写的落点，否则裁剪等于丢失。三条硬约束：
 * 1. **先落档，后裁剪**：批次写成功之前，热状态一条不减；写失败即原样返回并带错误串（宁可变大，不可静默丢）。
 * 2. **批次不可变**：`batchId` 由内容范围确定性推出，同一批重放得到同一个键，落点只允许追加不允许改写。
 * 3. **可核对**：`contentHash` 覆盖批次内容，读侧按它判定完整性，校验不过的批次只报缺失不当事后。
 */
import { createHash } from 'node:crypto';
import { MAX_RECENT_EVENTS, planClosedRecordDrops, withRecordArchiveReceipt } from './control.js';
/** 归档表的逻辑名：与 `continuity` 存储域里声明的表一致，`location` 按它拼出可读位置。 */
export const ARCHIVE_TABLE = 'archive';
export function locationOf(batchId) {
    return `storageDomain:continuity/${ARCHIVE_TABLE}/${batchId}`;
}
/** 事件批次的键：由 mission 与闭区间唯一决定，重放同区间不会造出第二个落点。 */
export function eventBatchId(missionId, fromSeq, toSeq) {
    return `arc_${missionId}_events_${fromSeq}-${toSeq}`;
}
/** 闭合记录批次的键：由裁剪计划指纹决定，同一计划重放只会写同一个批次。 */
export function recordBatchId(missionId, planFingerprint) {
    return `arc_${missionId}_records_${planFingerprint.slice(0, 16)}`;
}
/** 键序固定的序列化：同一批次两次哈希一致，跨进程重放才核对得出"是不是同一批"。 */
function stableJson(value) {
    if (value === null || typeof value !== 'object')
        return value === undefined ? 'null' : JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    const record = value;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
export function batchContentHash(events, records) {
    return createHash('sha256').update(stableJson({ events, records })).digest('hex');
}
/** 批次自证：内容与哈希对不上就是被改过或写坏过，不能当成历史真相读出去。 */
export function verifyBatch(batch) {
    return batch.contentHash === batchContentHash(batch.events, batch.records);
}
export function buildEventBatch(missionId, events, committedAt) {
    const first = events[0];
    const last = events[events.length - 1];
    const contentHash = batchContentHash(events, []);
    const batchId = eventBatchId(missionId, first.seq, last.seq);
    return {
        batchId,
        missionId,
        kind: 'events',
        fromSeq: first.seq,
        toSeq: last.seq,
        count: events.length,
        committedAt,
        contentHash,
        location: locationOf(batchId),
        events,
        records: [],
    };
}
export function buildRecordBatch(missionId, plan, records, committedAt, state) {
    const through = state.archive?.throughSeq ?? 0;
    const fromSeq = state.events[0]?.seq ?? through;
    const toSeq = state.events.at(-1)?.seq ?? through;
    const contentHash = batchContentHash([], records);
    const batchId = recordBatchId(missionId, plan.fingerprint);
    return {
        batchId,
        missionId,
        kind: 'closed-records',
        fromSeq,
        toSeq,
        count: records.length,
        committedAt,
        contentHash,
        location: locationOf(batchId),
        events: [],
        records,
    };
}
/**
 * 热窗口里必须离开但还没有台账副本的事件：超出目标窗口 `MAX_RECENT_EVENTS` 的最旧前缀。
 *
 * 只在 `state.events` 上算，不看水位——水位管的是"能不能删"，这里管的是"该归档谁"。
 */
export function pendingEventArchive(state, limit = MAX_RECENT_EVENTS) {
    const overflow = state.events.length - limit;
    if (overflow <= 0)
        return [];
    return state.events.slice(0, overflow);
}
/** 落档成功后的水位推进：水位只前进不后退，热状态按新水位裁剪。 */
export function applyEventArchive(state, batch) {
    const current = state.archive;
    const throughSeq = Math.max(current?.throughSeq ?? -1, batch.toSeq);
    const watermark = {
        throughSeq,
        batchCount: (current?.batchCount ?? 0) + 1,
        lastBatchId: batch.batchId,
        lastContentHash: batch.contentHash,
        lastLocation: batch.location,
        lastArchivedAt: batch.committedAt,
    };
    return { ...state, archive: watermark, events: state.events.filter((event) => event.seq > throughSeq) };
}
/** 事件落档：写失败即抛，调用方保留完整热窗口（R4 的"不静默丢失"）。 */
export async function archiveEventWindow(state, sink, now, limit = MAX_RECENT_EVENTS) {
    const pending = pendingEventArchive(state, limit);
    if (pending.length === 0)
        return { state, batch: null };
    const batch = buildEventBatch(state.missionId, pending, now);
    await sink.appendBatch(batch);
    return { state: applyEventArchive(state, batch), batch };
}
/** 已闭合记录落档：先把不可变对象写进台账，再执行同一份计划并只累计这批的归档计数。 */
export async function archiveClosedRecordWindow(state, sink, now) {
    const plan = planClosedRecordDrops(state);
    if (plan.drops.length === 0)
        return { state, batch: null };
    const batch = buildRecordBatch(state.missionId, plan, plan.drops, now, state);
    await sink.appendBatch(batch);
    const next = withRecordArchiveReceipt(state, plan, {
        batchId: batch.batchId,
        contentHash: batch.contentHash,
        location: batch.location,
        archivedAt: now,
        counts: plan.counts,
    });
    return { state: next, batch };
}
/**
 * 提交后的收敛入口，装配层与内核的唯一调用点。
 *
 * 事件与闭合记录都落档后，把新水位与凭据**回写同一条控制记录**（不推进 revision：归档是运维动作，
 * 不是控制决策，见 `kernel.renewLeases` 同口径）。任何一步失败都不裁对应的东西；已经成功的部分照常
 * 落库，错误串原样带回，由视图如实说明"这批还没归档"。
 */
export async function sweepArchive(store, missionId, state, archive, now) {
    const head = (batch) => ({
        batchId: batch.batchId,
        missionId: batch.missionId,
        kind: batch.kind,
        fromSeq: batch.fromSeq,
        toSeq: batch.toSeq,
        count: batch.count,
        committedAt: batch.committedAt,
        contentHash: batch.contentHash,
        location: batch.location,
    });
    const note = (prefix, reason) => `${prefix}：${reason instanceof Error ? reason.message : String(reason)}`;
    const batches = [];
    const errors = [];
    let afterEvents = null;
    try {
        const events = await archiveEventWindow(state, archive.sink, now);
        if (events.batch !== null) {
            afterEvents = events.state;
            batches.push(head(events.batch));
        }
    }
    catch (reason) {
        errors.push(note('事件未归档，热窗口保持完整', reason));
    }
    let afterRecords = null;
    try {
        const records = await archiveClosedRecordWindow(afterEvents ?? state, archive.sink, now);
        if (records.batch !== null) {
            afterRecords = records.state;
            batches.push(head(records.batch));
        }
    }
    catch (reason) {
        errors.push(note('已闭合记录未归档，裁剪不执行', reason));
    }
    const settled = afterRecords ?? afterEvents;
    if (settled === null)
        return { state, batches, ...(errors.length === 0 ? {} : { error: errors.join('；') }) };
    try {
        await store.commit(missionId, state.revision, settled);
    }
    catch (reason) {
        // 回写失败就交回原状态：批次已经在台账里且键可重放，重复追加无害；热状态一条不减。
        errors.push(note('归档水位回写失败，热窗口保持完整', reason));
        return { state, batches, error: errors.join('；') };
    }
    return { state: settled, batches, ...(errors.length === 0 ? {} : { error: errors.join('；') }) };
}
/**
 * 由控制记录算出读侧的预期口径（N3 的调用侧入口）。
 *
 * `state.archive` 是**已经落档过**的证据，两种情形必须分开：
 * - 有水位 ⇒ 水位之前的区间台账都该覆盖到，末段缺失要能被点名；
 * - 没有水位 ⇒ 从来没裁剪过，"台账里读不到批次"是正常的，**不能**伪造一个覆盖要求
 *   （否则每次 `/continuity timeline` 都会在还没归档时报"全部历史不可回读"）。
 *
 * 起点固定 0：事件 seq 轴从 0 起（`control.ts` 的 `commit()`：(last?.seq ?? -1) + 1）。
 */
export function archiveExpectation(state) {
    const through = state.archive?.throughSeq;
    if (through === undefined || !Number.isSafeInteger(through) || through < 0)
        return undefined;
    return { expectedFromSeq: 0, expectedThroughSeq: through };
}
/** 事件批次采信前的三道自证（N3）：计数、内容哈希、头部范围与正文一致。任一不过整批拒用。 */
function eventBatchFaults(batch) {
    const faults = [];
    if (batch.count !== batch.events.length) {
        faults.push(`批次 ${batch.batchId} 计数 ${batch.count} 与事件数 ${batch.events.length} 不符，未采信`);
    }
    if (!verifyBatch(batch)) {
        faults.push(`批次 ${batch.batchId}（事件 ${batch.fromSeq}–${batch.toSeq}）内容校验不过，未采信`);
    }
    if (batch.events.length === 0) {
        // 合法的事件批次至少装一条（archiveEventWindow 先判空才建批），空正文配非空头范围只能是写坏或被改。
        faults.push(`批次 ${batch.batchId} 头部范围 ${batch.fromSeq}–${batch.toSeq} 与正文为空不一致，未采信`);
        return faults;
    }
    const seqs = batch.events.map((item) => item.seq);
    let min = seqs[0];
    let max = seqs[0];
    let increasing = true;
    for (let index = 0; index < seqs.length; index += 1) {
        const seq = seqs[index];
        if (seq < min)
            min = seq;
        if (seq > max)
            max = seq;
        if (index > 0 && seq <= seqs[index - 1])
            increasing = false;
    }
    if (min !== batch.fromSeq || max !== batch.toSeq) {
        faults.push(`批次 ${batch.batchId} 头部范围 ${batch.fromSeq}–${batch.toSeq} 与正文 ${min}–${max} 不一致，未采信`);
    }
    if (!increasing) {
        faults.push(`批次 ${batch.batchId} 正文 seq 未严格递增或重复，未采信`);
    }
    return faults;
}
/** 条目必须能定位且原样可回读：`collection`/`id` 非空、`value` 存在（`undefined` 是缺对象，不是空对象）。 */
function dropShapeOk(drop) {
    if (drop === null || typeof drop !== 'object')
        return false;
    const candidate = drop;
    return (typeof candidate.collection === 'string' &&
        candidate.collection.length > 0 &&
        typeof candidate.id === 'string' &&
        candidate.id.length > 0 &&
        candidate.value !== undefined);
}
/**
 * 闭合记录批次采信前的自证（N3）：计数、内容哈希、条目结构。
 * 头部的 `fromSeq`/`toSeq` 是归档时热事件窗口的时间锚点，不是记录自身的区间，因此不做范围核对。
 */
function recordBatchFaults(batch) {
    const faults = [];
    if (batch.count !== batch.records.length) {
        faults.push(`批次 ${batch.batchId} 计数 ${batch.count} 与条目数 ${batch.records.length} 不符，未采信`);
    }
    if (!verifyBatch(batch)) {
        faults.push(`批次 ${batch.batchId}（记录 ${batch.fromSeq}–${batch.toSeq}）内容校验不过，未采信`);
    }
    const malformed = batch.records.findIndex((drop) => !dropShapeOk(drop));
    if (malformed >= 0) {
        faults.push(`批次 ${batch.batchId}（记录 ${batch.fromSeq}–${batch.toSeq}）第 ${malformed + 1} 条结构不完整（collection/id 须为非空字符串且 value 存在），未采信`);
    }
    return faults;
}
export async function readArchiveSnapshot(reader, missionId, expectation) {
    const batches = [...(await reader.batches(missionId))]
        .sort((a, b) => a.fromSeq - b.fromSeq || a.batchId.localeCompare(b.batchId));
    const events = [];
    const records = [];
    const headers = [];
    const unavailable = [];
    let archivedThroughSeq = -1;
    for (const batch of batches) {
        const header = {
            batchId: batch.batchId,
            missionId: batch.missionId,
            kind: batch.kind,
            fromSeq: batch.fromSeq,
            toSeq: batch.toSeq,
            count: batch.count,
            committedAt: batch.committedAt,
            contentHash: batch.contentHash,
            location: batch.location,
        };
        headers.push(header);
        // 两类批次都过校验：被拒批次只进 batches 与 unavailable，不冒充历史（N3 第 2、3、4 条）。
        const faults = batch.kind === 'events' ? eventBatchFaults(batch) : recordBatchFaults(batch);
        if (faults.length > 0) {
            unavailable.push(...faults);
            continue;
        }
        if (batch.kind === 'events') {
            events.push(...batch.events);
            archivedThroughSeq = Math.max(archivedThroughSeq, batch.toSeq);
        }
        else {
            records.push(...batch.records);
        }
    }
    events.sort((a, b) => a.seq - b.seq);
    // 覆盖报告（N3 第 1 条）：现存事件之间的空洞只是缺失的一半。"第一批之前"与"最后一批之后"
    // 只有对照预期区间才能核对；缺省起点 0 与 commit() 的 seq 轴起点一致，不传 expectation 也报前缀缺失。
    const start = expectation?.expectedFromSeq ?? 0;
    const through = expectation?.expectedThroughSeq;
    const seqs = events.map((item) => item.seq);
    if (seqs.length === 0) {
        // 一条采信事件都没有：空 `unavailable` 会把"归档全丢"读成"还没超过窗口"，所以要分类说清。
        if (through !== undefined && through >= start) {
            unavailable.push(`归档事件 seq ${start}–${through} 无副本（全部缺失），这段历史不可回读`);
        }
        else if (batches.length > 0) {
            // 台账里**有**批次却一条都没采信：这是"归档过但读不回来"，不是"没有历史"。
            unavailable.push(`归档 ${batches.length} 个批次全部不可采信（正文校验不过或结构不完整），这段历史不可回读`);
        }
        else if (expectation !== undefined) {
            // 调用方给了预期（声明过覆盖要求）却一个批次都没有：同样不许当成"还没超过窗口"。
            unavailable.push(`调用方声明了归档覆盖预期（起点 seq ${start}${through === undefined ? '' : `、水位 ${through}`}），台账里却没有可用批次：这段历史不可回读`);
        }
        // else：既没有水位声明、也没有任何批次 = 从来没裁剪过。这里**不** push ——
        // "读不到批次"在这种情形下不是缺失，命令侧按"热记录还没超过窗口"如实说明即可。
        // 两个方向都禁止："没有归档"不许报成"归档丢了"（假阳性），"归档全丢"也不许说成"还没超过窗口"（假阴性）。
    }
    else {
        const min = seqs[0];
        const max = seqs[seqs.length - 1];
        if (min > start)
            unavailable.push(`归档事件 seq ${start}–${min - 1} 无副本（前缀缺失），这段历史不可回读`);
        for (const gap of missingSeqRanges(seqs)) {
            unavailable.push(`归档事件 seq ${gap[0]}–${gap[1]} 无副本（中段缺失），这段历史不可回读`);
        }
        if (through !== undefined && max < through)
            unavailable.push(`归档事件 seq ${max + 1}–${through} 无副本（末段缺失），这段历史不可回读`);
    }
    return {
        missionId,
        batches: headers,
        events,
        records,
        archivedThroughSeq,
        unavailable,
    };
}
/** 已归档事件 seq 之间的空洞：水位说过"落档了"但批次里没有，就是缺失。 */
export function missingSeqRanges(seqs) {
    const present = new Set(seqs);
    const gaps = [];
    if (present.size === 0)
        return gaps;
    const sorted = [...present].sort((a, b) => a - b);
    let cursor = sorted[0];
    for (const seq of sorted) {
        if (seq > cursor)
            gaps.push([cursor, seq - 1]);
        cursor = seq + 1;
    }
    return gaps;
}
