/**
 * 控制存储端口与两个实现。
 *
 * `ControlStore` 是内核唯一的写入口（§5.2）。生产实现走 `ctx.storageDomain`；
 * 内存实现用于单测与离线开发，行为契约一致（同键串行写链 + 乐观版本核对）。
 */
import type { MissionControl } from './control.ts'
import { SCHEMA_VERSION } from './control.ts'

export class RevisionConflict extends Error {
  public override readonly name = 'RevisionConflict'
  public readonly missionId: string
  public readonly expected: number
  public readonly actual: number

  constructor(missionId: string, expected: number, actual: number) {
    super(`mission ${missionId}: expected revision ${expected}, found ${actual}`)
    this.missionId = missionId
    this.expected = expected
    this.actual = actual
  }
}

/** 迁移提示：这些串会直接进 `/continuity status`，要说清下一步而不是只报错。 */
export const SCHEMA_GUARD_NOTE =
  '需独占维护：先做一致性快照备份，再迁移，最后校验；内核不自动迁移，也不清空记录（设计稿 v0.3 §5.3）'

/**
 * 版本不符时拒绝装载（§5.3）。
 *
 * 为什么不就地迁移：新旧词表的语义不可还原（例如旧的三值验收结果对不上六值里的哪一种），
 * 静默改写等于把不可信的记录当成当前真值继续自动执行。
 */
export class SchemaVersionMismatch extends Error {
  public override readonly name = 'SchemaVersionMismatch'
  public readonly missionId: string
  public readonly found: string
  public readonly expected: number

  constructor(missionId: string, found: unknown, expected: number) {
    super(
      `mission ${missionId}: unsupported schemaVersion ${String(found)} (want ${expected})；${SCHEMA_GUARD_NOTE}`,
    )
    this.missionId = missionId
    this.found = String(found)
    this.expected = expected
  }
}

/** 记录级版本核对：只造拒绝，不抛——装载路径抛，写路径用它拒写。 */
export function staleSchemaError(record: unknown, missionId: string): SchemaVersionMismatch | undefined {
  if (record === null || typeof record !== 'object') return undefined
  const found = (record as Partial<MissionControl>).schemaVersion
  return found === SCHEMA_VERSION ? undefined : new SchemaVersionMismatch(missionId, found, SCHEMA_VERSION)
}

export interface ControlStore {
  /** 装载；`schemaVersion` 与当前实现不符即抛 {@link SchemaVersionMismatch}，不返回半迁移的壳（§5.3）。 */
  load(missionId: string): Promise<MissionControl | null>
  /**
   * 提交一次转换。`expectedRevision` 是当前读到的版本；不符即抛 {@link RevisionConflict}。
   * 存储层没有原生 CAS，版本核对在实现内部按写链完成（见 `DomainStore` 注释）。
   * "已提交"对两个实现同义：落盘的记录必须是本次的 `next`；否则一律抛错，不允许"返回成功但记录没变"。
   * 成功时不回填存储值——要刷新缓存的调用方按 `missionId` 重新 `load()`。
   */
  commit(missionId: string, expectedRevision: number, next: MissionControl): Promise<void>
  create(missionId: string, initial: MissionControl): Promise<void>
  list(): Promise<string[]>
}

/** 记录级校验：外层信封版本与插件业务版本分开声明（§5.3）。 */
export function assertShape(record: unknown, missionId: string): MissionControl {
  if (record === null || typeof record !== 'object') throw new Error(`mission ${missionId}: control record is not an object`)
  const shape = record as Partial<MissionControl>
  const mismatch = staleSchemaError(shape, missionId)
  if (mismatch !== undefined) throw mismatch
  if (typeof shape.revision !== 'number' || !Number.isSafeInteger(shape.revision) || shape.revision < 0) {
    throw new Error(`mission ${missionId}: malformed revision`)
  }
  if (shape.missionId !== missionId) throw new Error(`mission ${missionId}: record keyed under wrong missionId`)
  return shape as MissionControl
}

export class MemoryStore implements ControlStore {
  private readonly records = new Map<string, MissionControl>()
  private tail: Promise<unknown> = Promise.resolve()

  /** 与 `DomainStore` 同构：同一表的写在单一链上排队。 */
  private chain<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => fn()
    const result = this.tail.then(run, run)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async load(missionId: string): Promise<MissionControl | null> {
    // 读也排在写链之后：否则 `create` 还没 resolve 时读会报"没有这条记录"，
    // 调用方把"排队中"误读成"不存在"（§5.3 的重开一条新记录就来自这种误读）。
    return this.chain(async () => {
      const value = this.records.get(missionId)
      // 读路径也过版本闸：记录即使是旁路塞进来的，也不给它被自动执行的机会（§5.3）。
      return value === undefined ? null : (JSON.parse(JSON.stringify(assertShape(value, missionId))) as MissionControl)
    })
  }

  async create(missionId: string, initial: MissionControl): Promise<void> {
    await this.chain(async () => {
      if (this.records.has(missionId)) throw new Error(`mission ${missionId} already exists`)
      assertShape(initial, missionId)
      this.records.set(missionId, JSON.parse(JSON.stringify(initial)) as MissionControl)
    })
  }

  async commit(missionId: string, expectedRevision: number, next: MissionControl): Promise<void> {
    await this.chain(async () => {
      const current = this.records.get(missionId)
      if (current === undefined) throw new Error(`mission ${missionId} not found`)
      // 拒写旧版本记录：不迁移、不覆盖、不清空，让维护流程在外面显式完成（§5.3）。
      const stale = staleSchemaError(current, missionId)
      if (stale !== undefined) throw stale
      if (current.revision !== expectedRevision) throw new RevisionConflict(missionId, expectedRevision, current.revision)
      assertShape(next, missionId)
      this.records.set(missionId, JSON.parse(JSON.stringify(next)) as MissionControl)
    })
  }

  async list(): Promise<string[]> {
    // 走同一条写链：绕开链的 `list` 会漏掉刚 `create` 出去、还排在队列里的记录，
    // 于是恢复扫描能把一个真实存在的 Mission 读成"不存在"。
    return this.chain(async () => [...this.records.keys()])
  }

  /** 测试钩子：直接观察已落盘的记录。 */
  peek(missionId: string): MissionControl | undefined {
    return this.records.get(missionId)
  }
}

/**
 * `DomainStore` 需要的最小 `KvTable` 形状（与 `@deepseek-ai/dsh-storage-domain` 的
 * `KvTable<K, V>` 结构一致，因此真机可直接传入，无需在本包安装该依赖）。
 */
export interface KvTableLike<V> {
  get(key: string): V | undefined
  put(key: string, value: V): Promise<void>
  update(key: string, fn: (current: V) => V): Promise<V>
  entries(): IterableIterator<[string, V]>
}

/**
 * 生产实现：storageDomain 的单记录 RMW 写链 + `fn` 内版本申报。
 *
 * `KvTable.update(key, fn)` 没有 expected-version 参数，`fn` 也必须是同步纯函数（不能抛）。
 * 所以版本核对这样完成：`fn` 在**自己的排队槽位**读取当前值，版本不符就原样返回（不改写）并
 * 申报"没装进去"；`update` 返回后按这个申报判定，而不是按返回的版号反推——落后者的下一版号
 * 可能正好等于已存版号（审阅 R3）。`MemoryStore` 是写前查版，两者对"已提交"的定义一致：
 * 存储里的记录就是本次提交的记录，否则一律抛 {@link RevisionConflict}。
 * 这不是跨实例锁：`update` 只在单个 Host 进程的写链上串行，另有 `CommandQueue` 与 `HostLock`
 * （`core/queue.ts:106`，落盘独占运行锁）在前置串行化；两个进程共用同一条 storageDomain 并不安全。
 */
export class DomainStore implements ControlStore {
  private readonly table: KvTableLike<MissionControl>
  private readonly clone: (value: MissionControl) => MissionControl

  constructor(table: KvTableLike<MissionControl>, clone: (value: MissionControl) => MissionControl = (value) => value) {
    this.table = table
    this.clone = clone
  }

  async load(missionId: string): Promise<MissionControl | null> {
    const record = this.table.get(missionId)
    if (record === undefined) return null
    return this.clone(assertShape(record, missionId))
  }

  async create(missionId: string, initial: MissionControl): Promise<void> {
    assertShape(initial, missionId)
    if (this.table.get(missionId) !== undefined) throw new Error(`mission ${missionId} already exists`)
    await this.table.put(missionId, initial)
  }

  async commit(missionId: string, expectedRevision: number, next: MissionControl): Promise<void> {
    assertShape(next, missionId)
    // 版本闸写在 `fn` 里而不是写前查：`get` 与 `update` 之间没有锁，只有 `fn` 在自己的
    // 排队槽位里读到的值才算数。旧版本记录原样返回（不迁移、不清空），抛在 update 之后。
    let rejectedVersion: { readonly found: unknown } | undefined
    // 成败只由 `fn` 自己申报：比对 `settled.revision` 与 `next.revision` 会在
    // "落后者提交的下一版号恰好等于已存版号"时判成成功（审阅 R3：CAS 假成功）。
    let installed: boolean | undefined
    const settled = await this.table.update(missionId, (current) => {
      const stale = staleSchemaError(current, missionId)
      if (stale !== undefined) {
        rejectedVersion = { found: current.schemaVersion }
        return current
      }
      if (current.revision !== expectedRevision) {
        installed = false
        return current
      }
      installed = true
      return next
    })
    if (rejectedVersion !== undefined) {
      throw new SchemaVersionMismatch(missionId, rejectedVersion.found, SCHEMA_VERSION)
    }
    if (installed !== true) {
      throw new RevisionConflict(missionId, expectedRevision, settled.revision)
    }
  }

  async list(): Promise<string[]> {
    // 与 MemoryStore 不同：这里没有本地写链可排（排队在 KvTable 内部），所以 `put` 尚未 resolve
    // 时 `list` 可能看不见那条新记录。调用方必须 await 自己的写入——内核的所有落盘路径都满足这一点。
    return [...this.table.entries()].map(([key]) => key)
  }
}
