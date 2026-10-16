/**
 * 复审反转回归（N1–N4）：把 `复审_20261015/reproduce.mjs` 的七个探针逐条翻转。
 *
 * 原探针的断言用来"刻画缺陷"（通过 = 缺陷存在）；本文件用同一构造、相反的断言，
 * 要求修复后的行为成立。每个用例头部标注原探针名，便于逐条对账。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEventBatch, batchContentHash, readArchiveSnapshot } from '../src/core/archive.ts'
import type { ArchiveBatch } from '../src/core/archive.ts'
import { confirmSeed } from '../src/adapter/dsh.ts'
import { dispatch } from '../src/core/commands.ts'
import { DEDUP_RETENTION_MS, DEDUP_TOMBSTONE_RETENTION_MS, MAX_DEDUP_TOMBSTONES, pruneDedupTables } from '../src/core/control.ts'
import { mintCriteria } from '../src/core/entities.ts'
import { renderTimelineMarkdown } from '../src/views/export.ts'
import { freshState, taskPayload, NOW } from './fixtures.ts'

const reader = (batches: readonly ArchiveBatch[]) => ({
  batches: async () => batches,
  batch: async (_missionId: string, id: string) => batches.find((item) => item.batchId === id) ?? null,
})
const event = (seq: number) => ({ seq, at: NOW, kind: 'audit-event', detail: { marker: `archived-marker-${seq}` } })

test('MAIL_HISTORY_WINDOW：旧形状（无 records 面）不得判成 absent，只许 unknown', async () => {
  const key = 'mail-receipt-123'
  const history = [{ content: `[[continuity-mail]]${key}[[continuity-mail]]` }, ...Array.from({ length: 50 }, (_, i) => ({ content: `later-${i}` }))]
  let pages = 0
  const host = {
    sessionController: {
      page: async () => {
        pages += 1
        // 原探针刻意模拟旧实现只认的 `messages` 面；修复后没有 `records` 面即为覆盖不足。
        return { messages: history.slice(-50), hasMore: true }
      },
    },
  }
  const verdict = await confirmSeed(host as never, 'session-1', key, '[[continuity-mail]]')
  assert.equal(verdict, 'unknown', '面不匹配不是"未投递"的证据，不许触发重投')
  assert.equal(pages, 1)
})

test('ARCHIVE_MISSING_PREFIX：第一批之前没有副本必须报前缀缺失', async () => {
  const valid = buildEventBatch('mss_test', [event(10), event(11)], NOW)
  const snapshot = await readArchiveSnapshot(reader([valid]), 'mss_test')
  assert.deepEqual(snapshot.events.map((item) => item.seq), [10, 11], '批次自身合法，正文照常可读')
  assert.equal(snapshot.unavailable.length, 1, '前缀缺失必须被点名')
  assert.match(snapshot.unavailable[0]!, /seq 0–9 无副本（前缀缺失）/)
})

test('ARCHIVE_REJECTED_BUT_USED：计数不符的批次必须整批拒收，正文不得再被返回', async () => {
  const valid = buildEventBatch('mss_test', [event(10), event(11)], NOW)
  const wrongCount = await readArchiveSnapshot(reader([{ ...valid, count: 99 }]), 'mss_test')
  assert.match(wrongCount.unavailable.join(), /未采信/)
  assert.equal(wrongCount.events.length, 0, '被拒批次不得冒充历史')
  assert.equal(wrongCount.archivedThroughSeq, -1, '被拒批次不得冒充已核验水位')
  assert.equal(wrongCount.batches.length, 1, '读者要能看到"台账里存在这批、但不可采信"')
})

test('ARCHIVE_CORRUPT_RECORD_UNCHECKED：闭合记录批次的哈希与结构也要核对', async () => {
  const valid = buildEventBatch('mss_test', [event(10), event(11)], NOW)
  const corruptRecord: ArchiveBatch = {
    ...valid,
    batchId: 'corrupt-record',
    kind: 'closed-records',
    fromSeq: 10,
    toSeq: 11,
    events: [],
    records: [{ collection: 'claims', id: 'claim-old', value: { proposition: 'changed' } }],
    count: 1,
    // 头部哈希按"空正文"算：与真实正文对不上，必须整批拒。
    contentHash: batchContentHash([], []),
  }
  const snapshot = await readArchiveSnapshot(reader([corruptRecord]), 'mss_test')
  assert.equal(snapshot.unavailable.length > 0, true, '损坏的闭合记录批次必须被拒收并说明原因')
  assert.match(snapshot.unavailable.join(), /未采信/)
  assert.equal(snapshot.records.length, 0, '不可信记录不得冒充台账')
})

test('ARCHIVE_TIMELINE_NOT_RETRIEVED：时间线必须并回归档事件', async () => {
  const valid = buildEventBatch('mss_test', [event(10), event(11)], NOW)
  const snapshot = await readArchiveSnapshot(reader([valid]), 'mss_test')
  const timeline = renderTimelineMarkdown(freshState({ events: [event(12)] }), 200, snapshot)
  assert.equal(timeline.includes('archived-marker-10'), true, '归档批次里的旧事件要出现在报告里')
  assert.equal(timeline.includes('archived-marker-12'), true, '热事件不丢')
  assert.match(timeline, /归档台账 1 批 \/ 2 条事件（仅采信，seq ≤ 11）/)
})

test('EXPIRED_TOMBSTONE_REPLAY：31 天后重放原请求不得再创建任务', () => {
  const original = { kind: 'task.propose', requestId: 'old-original', task: taskPayload() } as const
  const context = { actorId: 'supervisor', role: 'supervisor' as const, now: NOW }
  const proposed = dispatch(freshState(), original, context)
  assert.equal(proposed.applied, true)
  const late = { ...context, now: NOW + DEDUP_RETENTION_MS + DEDUP_TOMBSTONE_RETENTION_MS + 1 }
  const intervening = dispatch(proposed.state, { ...original, requestId: 'later-command' }, late)
  assert.equal(intervening.applied, true)
  assert.equal(Object.keys(intervening.state.tasks).length, 2)
  const replayed = dispatch(intervening.state, original, late)
  assert.equal(replayed.applied, false, '凭据与墓碑都清掉后，派生 ID 仍必须挡住重放')
  assert.equal(Object.keys(replayed.state.tasks).length, 2, '任务数不得增长')
})

test('N2 阶段 2：experiment.preregister 同 requestId 重放不追加第二条契约', () => {
  const supervisor = { actorId: 'supervisor', role: 'supervisor' as const, now: NOW }
  const cmd = {
    kind: 'experiment.preregister',
    requestId: 'exp-once',
    draft: {
      routeFamilyId: 'route:rep',
      problem: '表征方式是否限制效果',
      userUtility: '减少返工',
      candidateMechanism: '换表征',
      differenceFromCurrent: '替换输入表示而非调参',
      testedHypothesis: '新表征在下游指标上更好',
      observable: '判别器分数',
      decisionImpact: '若无效则回退调参路线',
      baselineRef: 'baseline:v0',
      baselineVersion: 'v0',
      treatmentNote: '仅替换表征层',
      validatorRefs: ['val_1'],
      criteria: mintCriteria([{ text: '指标不低于基线' }]),
      budgetCapNote: '一次 20 次调用',
      minViableTrial: '一次小样本对照',
      stopConditions: ['两次负结果即停'],
      riskBoundary: '不影响已验收版本',
      isolation: 'sandbox',
    },
  } as const
  const first = dispatch(freshState(), cmd, supervisor)
  assert.equal(first.applied, true, first.applied ? '' : first.reason)
  const ids = Object.keys(first.state.experiments)
  assert.equal(ids.length, 1)
  assert.match(ids[0]!, /^exp_[0-9a-f]{8}-/, '契约 ID 由 requestId 派生')
  const again = dispatch(first.state, cmd, supervisor)
  assert.equal(Object.keys(again.state.experiments).length, 1, '同 requestId 重放不得新增试验链')
  assert.equal(again.state.experiments[ids[0]!]!.length, 1, '链长不变：不是静默追加版本 2')
  const fresh = dispatch(first.state, { ...cmd, requestId: 'exp-next' }, supervisor)
  assert.equal(Object.keys(fresh.state.experiments).length, 2, '新 requestId = 新意图，照常建出新的契约')
})

test('N2 阶段 2：conjecture.capture 同 requestId 重放不产生第二版结论', () => {
  const supervisor = { actorId: 'supervisor', role: 'supervisor' as const, now: NOW }
  const cmd = {
    kind: 'conjecture.capture',
    requestId: 'cjt-once',
    draft: { proposition: '猜想：换掉表征会有跃升', assumptionChange: '替换表征层而不是继续调参', sourceNote: '来源：主动构想' },
  } as const
  const first = dispatch(freshState(), cmd, supervisor)
  assert.equal(first.applied, true, first.applied ? '' : first.reason)
  const ids = Object.keys(first.state.claims)
  assert.equal(ids.length, 1)
  assert.match(ids[0]!, /^clm_[0-9a-f]{8}-/, '结论 ID 由 requestId 派生（与 claim 命令同前缀但 requestId 不同，不冲突）')
  const again = dispatch(first.state, cmd, supervisor)
  assert.equal(Object.keys(again.state.claims).length, 1, '同 requestId 重放不得新增结论')
  assert.equal(again.state.claims[ids[0]!]!.length, 1, '版本链长度不变：不是静默追加版本 2')
  const fresh = dispatch(first.state, { ...cmd, requestId: 'cjt-next' }, supervisor)
  assert.equal(Object.keys(fresh.state.claims).length, 2, '新 requestId = 新意图')
})
test('N2 阶段 2：environment.register / mechanism.propose 的幂等键由 requestId 派生，重放不再造第二份对象', () => {
  const items = [{ kind: 'workspace', ref: 'env:ws', expected: '分支 main', observeMethod: 'git status --short', sensitivity: 'variable', changeAction: '更新清单并重验', coverage: 'covered' }] as const
  const supervisor = { actorId: 'supervisor', role: 'supervisor' as const, now: NOW }

  const register = { kind: 'environment.register', requestId: 'env-once', input: { nextAction: '按清单重新绑端口', items, authorActorId: 'supervisor' } } as const
  const first = dispatch(freshState(), register, supervisor)
  assert.equal(first.applied, true)
  const ids = Object.keys(first.state.environments)
  assert.equal(ids.length, 1)
  assert.match(ids[0]!, /^env_[0-9a-f]{8}-[0-9a-f]{4}-/, '幂等键由 requestId 派生（前缀 + UUID 形状，避免被脱敏规则当成凭证）')

  const replayed = dispatch(first.state, register, supervisor)
  assert.equal(Object.keys(replayed.state.environments).length, 1, '同一 requestId 重放命中同一个派生 ID：不新增清单')
  const second = dispatch(first.state, { ...register, requestId: 'env-second' }, supervisor)
  assert.equal(Object.keys(second.state.environments).length, 2, '新意图（新 requestId）照常拿到新的有效请求键')

  const mechanism = {
    kind: 'mechanism.propose',
    requestId: 'mech-once',
    input: {
      name: '工作区写入门',
      class: 'core_invariant',
      purpose: '避免误删工作区文件',
      triggers: ['写文件'],
      requiredInputs: ['目标路径'],
      relevantRevisions: ['policyRevision'],
      scope: '本任务',
      benefitSignal: '误删事件为 0',
      proposedBy: 'supervisor',
    },
  } as const
  const proposed = dispatch(second.state, mechanism, supervisor)
  assert.equal(proposed.applied, true)
  assert.equal(Object.keys(proposed.state.mechanisms).length, 1)
  const proposedAgain = dispatch(proposed.state, mechanism, supervisor)
  assert.equal(Object.keys(proposedAgain.state.mechanisms).length, 1, '同一 requestId 重放不得新增机制')
})

test('TOMBSTONE_CAP_REPLAY：容量闸清老后重放原请求不得再创建任务', () => {
  const original = { kind: 'task.propose', requestId: 'old-original', task: taskPayload() } as const
  const context = { actorId: 'supervisor', role: 'supervisor' as const, now: NOW }
  const proposed = dispatch(freshState(), original, context)
  assert.equal(proposed.applied, true)

  const receipts = { ...proposed.state.dedup }
  for (let i = 0; i < MAX_DEDUP_TOMBSTONES; i += 1) {
    receipts[`extra-${i}`] = { ...receipts['old-original']!, requestId: `extra-${i}`, appliedAt: NOW + i + 1 }
  }
  const at25h = { ...context, now: NOW + 25 * 60 * 60 * 1000 }
  const pruned = pruneDedupTables(receipts, {}, at25h.now)
  assert.equal(pruned.tombstones['old-original'], undefined, '前置条件：original 已被容量闸挤掉')

  const cappedReplay = dispatch({ ...proposed.state, dedup: pruned.dedup, dedupTombstones: pruned.tombstones }, original, at25h)
  assert.equal(cappedReplay.applied, false, '容量淘汰不得让旧请求再次生效')
  assert.equal(Object.keys(cappedReplay.state.tasks).length, 1, '任务数不得增长')
})
