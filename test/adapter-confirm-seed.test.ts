/**
 * 投递确认的分页核对（审阅 N1 修复；复审脚本 的 MAIL_HISTORY_WINDOW 取反）。
 *
 * 旧缺陷：只查最近一页 50 条，标记落在更旧位置就报 `absent`，恢复流程据此重投，投递可能重复。
 * 修复后的三条判据：
 * - 命中**完整标记令牌**才算 `present`——普通文本提到同一个键、或别的标记包着同一个键，都不算回执；
 * - 只有真机契约允许的"扫尽且 `hasMore === false`"才允许 `absent`（`hasMore:false` 证明确实扫到日志开头）；
 * - 其余情况（面缺失、无覆盖声明、游标不前进、超页数上限、读取出错、记录形状不认识）一律 `unknown`——
 *   覆盖不足不是重发许可，调用方按"不确定"处理（复审验收：结果未知的重试不重投）。
 *
 * 假页与真机 `packages/api/session-controller/src/history.ts:77-111` 同口径：
 * `throughSeq: -1` 开放到最新，`beforeSeq` 排他取更旧，`hasMore = 被截掉的头段 > 0`。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { confirmSeed, MAIL_MARKER, SEED_MARKER } from '../src/adapter/dsh.ts'
import type { HostSlice } from '../src/adapter/host-types.ts'

const NOW = 1_700_000_000_000

/** 真机会话历史的一行：`{ type:'event', event:{ seq, time, data } }`（session-controller types.ts:426-428）。 */
function record(seq: number, text: string): unknown {
  return {
    type: 'event',
    event: { seq, time: NOW + seq, data: { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text }] } },
  }
}

const filler = (from: number, count: number): { readonly seq: number; readonly text: string }[] =>
  Array.from({ length: count }, (_, index) => ({ seq: from + index, text: `later-${index}` }))

interface PageOptions {
  /** 强制固定 hasMore（真机由截掉的头段推出，这里用于模拟"永远说还有"的坏面）。 */
  readonly hasMore?: boolean
  /** 旧口径 mock：只给 `messages` 不给 `records`。 */
  readonly dropRecords?: boolean
  readonly throwError?: boolean
  /** 无视 beforeSeq 恒返回同一窗口（模拟游标不前进）。 */
  readonly ignoreBefore?: boolean
}

function fakeHost(entries: readonly { readonly seq: number; readonly text: string }[], options: PageOptions = {}): { readonly host: HostSlice; readonly calls: readonly Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = []
  const host: HostSlice = {
    sessionController: {
      create: async () => {
        throw new Error('unused')
      },
      resolveAgent: async () => ({ error: { code: 'unused' } }),
      page: async (request) => {
        calls.push(request)
        if (options.throwError === true) throw new Error('history read failed')
        if (options.dropRecords === true) return { hasMore: true }
        const before = typeof request.beforeSeq === 'number' ? request.beforeSeq : undefined
        const eligible = options.ignoreBefore === true ? [...entries] : entries.filter((item) => before === undefined || item.seq < before)
        const max = typeof request.maxMessages === 'number' && request.maxMessages > 0 ? request.maxMessages : eligible.length
        const windowed = eligible.slice(Math.max(0, eligible.length - max))
        const cut = eligible.length - windowed.length
        const hasMore = options.hasMore ?? cut > 0
        return { records: windowed.map((item) => record(item.seq, item.text)), hasMore }
      },
    },
  }
  return { host, calls }
}

// —— MAIL_HISTORY_WINDOW 取反：标记在旧窗口之外 ——

test('MAIL_HISTORY_WINDOW（取反）：标记落在第 50 条窗口之外，翻页后仍确认为 present', async () => {
  // 与 reproduce.mjs 同形：51 条历史，标记在**最旧**一条（旧实现只看最新 50 条 ⇒ 误报 absent）。
  const entries = [{ seq: 0, text: `${MAIL_MARKER}mail-receipt-123${MAIL_MARKER}` }, ...filler(1, 50)]
  const { host, calls } = fakeHost(entries)

  const verdict = await confirmSeed(host, 'session-1', 'mail-receipt-123', MAIL_MARKER)

  assert.equal(verdict, 'present', '历史里真的存在这条投递，核对必须翻到它，而不是"最近一页没有=没投过"')
  assert.equal(calls.length, 2, '第一页未命中、hasMore 为真 ⇒ 必须向后翻页')
  assert.deepEqual(calls[0]?.address, { kind: 'session', sessionId: 'session-1' })
  assert.equal(calls[0]?.throughSeq, -1, '开放到最新（真机契约）')
  assert.equal(calls[0]?.maxMessages, 50)
  assert.equal(calls[0]?.beforeSeq, undefined, '首页不带游标')
  assert.equal(calls[1]?.beforeSeq, 1, '第二页从第一页最旧的 seq 起向前取（排他）')
})

test('SEED_MARKER 同理：轮换启动消息的核对走同一套分页逻辑', async () => {
  const entries = [...filler(0, 60), { seq: 60, text: `${SEED_MARKER}rot-seed-9${SEED_MARKER}` }]
  const { host, calls } = fakeHost(entries)

  assert.equal(await confirmSeed(host, 's2', 'rot-seed-9', SEED_MARKER), 'present')
  assert.equal(calls.length, 1, '最新一页就命中，不多翻')
})

// —— 精确匹配：普通引用不算回执 ——

test('普通文本提到同一个键、或别的标记包着同一个键，都不算回执（扫尽 ⇒ absent）', async () => {
  const entries = [
    { seq: 0, text: '讨论里提到了 mail-receipt-123 这个编号，但没人投递过它' },
    { seq: 1, text: `${SEED_MARKER}mail-receipt-123${SEED_MARKER}` },
  ]
  const { host, calls } = fakeHost(entries)

  const verdict = await confirmSeed(host, 'session-1', 'mail-receipt-123', MAIL_MARKER)

  assert.equal(verdict, 'absent', '回执必须以成对标记为凭据：裸键名或异类标记都不是投递证据')
  assert.equal(calls.length, 1)
})

// —— 覆盖不可证明 ⇒ unknown（不许当 absent 重投） ——

test('hasMore 恒真且游标不前进：承认覆盖不足（unknown），不死循环也不误报 absent', async () => {
  const entries = [{ seq: 0, text: 'nothing' }, ...filler(1, 50)]
  const { host, calls } = fakeHost(entries, { ignoreBefore: true, hasMore: true })

  const verdict = await confirmSeed(host, 'session-1', 'mail-receipt-123', MAIL_MARKER)

  assert.equal(verdict, 'unknown')
  assert.equal(calls.length, 2, '游标没前进就停：第二页发现 oldest 没变小，不再翻')
})

test('超过页数上限仍未扫尽：报 unknown，绝不把"没翻到"说成"没投过"', async () => {
  const entries = filler(0, 1200) // 20 页 × 50 条 = 1000 条，扫不到最早 200 条
  const { host, calls } = fakeHost(entries)

  const verdict = await confirmSeed(host, 'session-1', 'mail-receipt-123', MAIL_MARKER)

  assert.equal(verdict, 'unknown')
  assert.equal(calls.length, 20, '有界扫描：页数上限到顶就收敛为未知')
})

test('旧口径 mock（只有 messages 没有 records）：unknown——覆盖声明对不上时按未确认处理', async () => {
  const { host, calls } = fakeHost([], { dropRecords: true })

  assert.equal(await confirmSeed(host, 'session-1', 'mail-receipt-123', MAIL_MARKER), 'unknown')
  assert.equal(calls.length, 1)
})

test('读取出错：unknown（异常不外泄、不判定）', async () => {
  const { host } = fakeHost(filler(0, 3), { throwError: true })
  assert.equal(await confirmSeed(host, 'session-1', 'mail-receipt-123', MAIL_MARKER), 'unknown')
})

test('记录形状不认识（无 seq 又有 hasMore）：unknown', async () => {
  const circular: Record<string, unknown> = { content: 'garbage' }
  circular.self = circular
  const host: HostSlice = {
    sessionController: {
      create: async () => {
        throw new Error('unused')
      },
      resolveAgent: async () => ({ error: { code: 'unused' } }),
      page: async () => ({ records: [circular], hasMore: true }),
    },
  }
  assert.equal(await confirmSeed(host, 'session-1', 'mail-receipt-123', MAIL_MARKER), 'unknown', '连游标都取不到就没有覆盖率可言')
})

test('没有 page 面 / 没有 sessionController：unknown', async () => {
  const noPage: HostSlice = {
    sessionController: {
      create: async () => {
        throw new Error('unused')
      },
      resolveAgent: async () => ({ error: { code: 'unused' } }),
    },
  }
  assert.equal(await confirmSeed(noPage, 'session-1', 'mail-receipt-123', MAIL_MARKER), 'unknown')
  assert.equal(await confirmSeed({}, 'session-1', 'mail-receipt-123', MAIL_MARKER), 'unknown')
})

// —— 可证明的 absent 只有一条路：扫尽且 hasMore 明确为 false ——

test('扫尽且 hasMore:false（证明扫到日志开头）才允许 absent', async () => {
  const { host, calls } = fakeHost(filler(0, 3))

  const verdict = await confirmSeed(host, 'session-1', 'mail-receipt-123', MAIL_MARKER)

  assert.equal(verdict, 'absent')
  assert.equal(calls.length, 1, '一页扫尽：hasMore:false 直接给出可证明的结论')
})

test('多页扫尽后仍无命中：absent（每一页 hasMore 都是真，直到最后一页为假）', async () => {
  const { host } = fakeHost(filler(0, 120)) // 3 页：50 + 50 + 20
  assert.equal(await confirmSeed(host, 'session-1', 'mail-receipt-123', MAIL_MARKER), 'absent')
})
