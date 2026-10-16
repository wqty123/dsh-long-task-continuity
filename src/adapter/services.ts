/**
 * 宿主服务读取的两个坑位处理。
 *
 * 1. `.volatile()` 配置字段：`apply(ctx, config)` 收到的是**引用对象**而不是值，必须 `.get()`。
 *    不摊平不会报错，只会静默按默认值判定（判定 dsh-context-guard 的 `policy.mjs` 注释，MIT）。
 *    这里不 import cosmokit：它的判定就是 `Symbol.for('cosmokit.volatile.write') in value`，
 *    全局 symbol 跨副本同一把钥匙，因此三行等价判定比多挂一个包更稳。
 * 2. `plan-mode` / `compaction-basic` 在 Web 面上被禁用宿主行、挂进每个 agent preset 的
 *    `isolate` realm。因此按 agent 解析服务，不能只认 host 面（照搬 `qingyou002/dsh-auto-handoff`
 *    的 `forAgent`，MIT）。
 */

import type { ArchiveBatch, ArchiveReader, ArchiveSink } from '../core/archive.ts'
import type { KvTableLike } from '../core/store.ts'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

export function isVolatileRef(value: unknown): value is { get(): unknown } {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/** 把 loader 交给插件的配置摊平成普通值；对普通对象是恒等变换。 */
export function plainConfig<T extends object>(raw: T | undefined): Record<string, unknown> {
  if (raw === null || raw === undefined || typeof raw !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    out[key] = isVolatileRef(value) ? value.get() : value
  }
  return out
}

type Getter<T> = (name: string) => T | undefined

/** 组合顺序：先 agent 面，后 host 面；`ctx.inject` 在提供者缺席时不会触发，因此必须两条路都试。 */
export function serviceReader(host: Getter<unknown>, agent?: Getter<unknown>): (name: string) => unknown {
  return (name: string) => {
    const local = agent?.(name)
    if (local !== undefined) return local
    return host(name)
  }
}

export function forAgent<T>(presetsOf: (agent: unknown) => { serviceFor(agent: unknown, name: string): T | undefined } | undefined, agent: unknown, name: string, hostOf: () => T | undefined): T | undefined {
  const preset = presetsOf(agent)
  const scoped = preset?.serviceFor(agent, name)
  if (scoped !== undefined) return scoped
  return hostOf()
}

/** 数字型设置只接受安全整数；老文档里缺字段或写了垃圾值都不能让校验失败。 */
export function safeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

export function safeRatio(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1 ? value : fallback
}

/**
 * 归档落点的宿主表适配。
 *
 * 取表方式与 `DomainStore` 一致（`index.ts` 里 `domain.table('missions')` 那一套）：装配层把
 * `continuity` 域的 `archive` 表按 `KvTableLike` 的最小形状递进来，本文件不碰宿主类型。
 *
 * 端口是**追加**语义，而 `KvTable.put` 是覆盖语义，所以这里把三种情况分开：
 * 缺键才写；同键同哈希当重放成功返回；同键不同哈希即抛——已归档批次一旦能改写，
 * 历史就不再是自证材料，而是可以被事后圆场的说法（§5.3、审阅 R4）。
 */
export function archiveSink(table: KvTableLike<ArchiveBatch>): ArchiveSink {
  return {
    async appendBatch(batch: ArchiveBatch): Promise<void> {
      const existing = table.get(batch.batchId)
      if (existing === undefined) {
        await table.put(batch.batchId, batch)
        return
      }
      if (existing.contentHash === batch.contentHash) return
      throw new Error(`archive batch ${batch.batchId} 已有不同内容，拒绝改写已归档历史`)
    },
  }
}

/** 按 seq 闭区间与 mission 取回批次；重叠判定保守——只要区间有交集就返回。 */
export function archiveReader(table: KvTableLike<ArchiveBatch>): ArchiveReader {
  const all = (missionId: string): ArchiveBatch[] =>
    [...table.entries()]
      .map(([, value]) => value)
      .filter((batch) => batch.missionId === missionId)
  return {
    async batches(missionId: string, fromSeq?: number, toSeq?: number): Promise<readonly ArchiveBatch[]> {
      return all(missionId).filter(
        (batch) => (fromSeq === undefined || batch.toSeq >= fromSeq) && (toSeq === undefined || batch.fromSeq <= toSeq),
      )
    },
    async batch(missionId: string, batchId: string): Promise<ArchiveBatch | null> {
      const found = table.get(batchId)
      return found === undefined || found.missionId !== missionId ? null : found
    },
  }
}
