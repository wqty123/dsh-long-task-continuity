/**
 * 存储端口的版本核对（设计稿 v0.3 §5.2、§5.3；审阅 R3）。
 *
 * 用例只认一件事：**"提交成功"必须等于"存储里的记录就是本次提交的那条"**。
 * 反过来的假成功（返回成功、记录却是别人的）在台账里没有任何痕迹，所以这里按
 * 审阅的复现脚本 `CAS_FALSE_SUCCESS` 反向断言：同一情形必须抛 {@link RevisionConflict}。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { MissionControl } from '../src/core/control.ts'
import { SCHEMA_VERSION } from '../src/core/control.ts'
import type { KvTableLike } from '../src/core/store.ts'
import { DomainStore, MemoryStore, RevisionConflict, SchemaVersionMismatch } from '../src/core/store.ts'
import { draftMission, freshState } from './fixtures.ts'

/**
 * 与宿主 `KvTable.update` 同构的假表：写在单一链上排队，`fn` 在自己的槽位里读到当前值，
 * 返回什么就存什么（宿主实现见 `packages/storage/storage-domain/src/domain.ts:332`）。
 */
class ChainTable implements KvTableLike<MissionControl> {
  private readonly rows = new Map<string, MissionControl>()
  private tail: Promise<unknown> = Promise.resolve()
  /** 测试钩子：置为 false 时 `update` 不调用 `fn` 直接返回旧值（模拟没轮到本次提交）。 */
  invokeFn = true

  constructor(rows: readonly (readonly [string, MissionControl])[]) {
    for (const [key, value] of rows) this.rows.set(key, value)
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job, job)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  get(key: string): MissionControl | undefined {
    return this.rows.get(key)
  }

  put(key: string, value: MissionControl): Promise<void> {
    return this.enqueue(async () => {
      this.rows.set(key, structuredClone(value))
    })
  }

  update(key: string, fn: (current: MissionControl) => MissionControl): Promise<MissionControl> {
    return this.enqueue(async () => {
      const current = this.rows.get(key)
      if (current === undefined) throw new Error(`table '${key}' has no record to update`)
      if (!this.invokeFn) return current
      const next = structuredClone(fn(structuredClone(current)))
      this.rows.set(key, next)
      return structuredClone(next)
    })
  }

  entries(): IterableIterator<[string, MissionControl]> {
    return this.rows.entries()
  }
}

function stored(table: ChainTable): MissionControl {
  return table.get('mss_test')!
}

function atRevision(revision: number, objective: string): MissionControl {
  const mission = draftMission({ objective })
  return { ...freshState({ mission }), revision, missionId: 'mss_test' }
}

test('R3 回归：落后提交者的下一版号正好等于已存版号，也不能判成成功', async () => {
  // 审阅复现 `CAS_FALSE_SUCCESS`：表里已有以 revision 1 为基准、先落地 revision 2 的胜出者；
  // 落后者同样提交 revision 2。旧实现在 update 之后比对版号，两侧都是 2 ⇒ 假成功。
  const table = new ChainTable([['mss_test', atRevision(2, 'winning writer')]])
  const store = new DomainStore(table)
  const loser = atRevision(2, 'losing writer')
  await assert.rejects(
    () => store.commit('mss_test', 1, loser),
    (error: unknown) => error instanceof RevisionConflict && error.expected === 1 && error.actual === 2,
    '版号巧合不是提交成功',
  )
  assert.equal(stored(table).mission.objective, 'winning writer', '被拒的提交不许留下任何痕迹')
})

test('R3 回归：两个都以 revision 1 为基准并发提交 revision 2，只有一个成功', async () => {
  const table = new ChainTable([['mss_test', atRevision(1, '基线')]])
  const store = new DomainStore(table)
  const settled = await Promise.allSettled([
    store.commit('mss_test', 1, atRevision(2, 'writer A')),
    store.commit('mss_test', 1, atRevision(2, 'writer B')),
  ])
  const succeeded = settled.filter((entry) => entry.status === 'fulfilled')
  const conflicted = settled.filter(
    (entry) => entry.status === 'rejected' && entry.reason instanceof RevisionConflict && entry.reason.expected === 1 && entry.reason.actual === 2,
  )
  assert.equal(succeeded.length, 1, '同版本基准只允许一个提交被认成成功')
  assert.equal(conflicted.length, 1, '另一个必须拿到版本冲突而不是假成功')
  // 成功者是谁不可预测（取决于哪条写先排到槽位），但表里必须恰好是那一位的值。
  const winnerObjective = (settled.findIndex((entry) => entry.status === 'fulfilled') === 0 ? 'writer A' : 'writer B')
  assert.equal(stored(table).mission.objective, winnerObjective, '表值必须等于被认成成功的那次提交')
})

test('R3 回归：update 没把本次提交装进去就是冲突，与版号无关', async () => {
  const table = new ChainTable([['mss_test', atRevision(2, 'winning writer')]])
  table.invokeFn = false
  await assert.rejects(
    () => new DomainStore(table).commit('mss_test', 1, atRevision(2, 'losing writer')),
    RevisionConflict,
    '`fn` 没执行过 ⇒ 本次提交没有落地',
  )
  assert.equal(stored(table).mission.objective, 'winning writer')
})

test('正向对照：基准相符的提交确实落地，load 读回本次的值', async () => {
  const table = new ChainTable([['mss_test', atRevision(1, '基线')]])
  const store = new DomainStore(table)
  await store.commit('mss_test', 1, atRevision(2, 'writer A'))
  assert.equal(stored(table).mission.objective, 'writer A')
  assert.equal((await store.load('mss_test'))?.mission.objective, 'writer A')
})

test('两个实现对"已提交"的定义一致：版号巧合时 MemoryStore 与 DomainStore 都抛冲突', async () => {
  const memory = new MemoryStore()
  await memory.create('mss_test', atRevision(2, 'winning writer'))
  await assert.rejects(
    () => memory.commit('mss_test', 1, atRevision(2, 'losing writer')),
    (error: unknown) => error instanceof RevisionConflict && error.expected === 1 && error.actual === 2,
  )
  assert.equal((await memory.load('mss_test'))?.mission.objective, 'winning writer')
})

test('版本闸不变：记录 schemaVersion 不符时拒写、抛 SchemaVersionMismatch，且不改写也不清空', async () => {
  const stale = { ...atRevision(1, '待迁移的记录'), schemaVersion: SCHEMA_VERSION + 1 }
  const table = new ChainTable([['mss_test', stale]])
  const store = new DomainStore(table)
  await assert.rejects(
    () => store.commit('mss_test', 1, atRevision(2, '新写入')),
    (error: unknown) => error instanceof SchemaVersionMismatch && error.found === String(SCHEMA_VERSION + 1) && error.expected === SCHEMA_VERSION,
    '§5.3：不自动迁移也不清空，让维护流程在外面显式完成',
  )
  assert.deepEqual(stored(table), stale, '表里必须还是那条待迁移的记录，一个字节都不动')
  await assert.rejects(() => store.load('mss_test'), SchemaVersionMismatch)
})
