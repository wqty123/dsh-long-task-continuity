/**
 * Supervisor 运行时内核：把命令队列、控制存储与幂等转换串起来（设计稿 v0.3 §2、§5.2、§5.3）。
 *
 * 模型负责规划与判断，这一层只负责执行权、存储与恢复，因此它是**确定性**的：
 * 同一状态 + 同一命令 + 同一上下文 ⇒ 同一结果，不调模型、不建会话、不写外部文件。
 */
import type { Attempt, Mission, OutboxEntry } from './entities.ts'
import type { MissionControl } from './control.ts'
import { SCHEMA_VERSION, emptyControl, mintId } from './control.ts'
import type { ControlStore } from './store.ts'
import { RevisionConflict, SchemaVersionMismatch } from './store.ts'
import type { CommandQueue } from './queue.ts'
import { heartbeat, isTerminalAttempt } from './lease.ts'
import type { Command, CommandContext, Outcome } from './commands.ts'
import { dispatch } from './commands.ts'

export interface OutboxHandler {
  (entry: OutboxEntry, signal?: AbortSignal): Promise<void>
}

export interface KernelOptions {
  readonly maxCommitAttempts?: number
  readonly now?: () => number
  /** 投递消费者身份，写进 outbox 的领取记录；缺省每个内核实例一个。 */
  readonly consumerId?: string
  /** 领取有效期；到期即按"上一次执行结果未知"处理，不直接重投。 */
  readonly claimTtlMs?: number
  /**
   * 签发与续租共用的租约时长（审阅 R8）。只在这里声明一次：转换层（`task.claim`）与心跳
   * 都取同一个值，否则设置里的时长会在"新签租约"与"续租"之间劈成两套口径；缺省
   * `LEASE_EXPIRY_MS`。
   */
  readonly leaseExpiryMs?: number
  /**
   * 每次成功落盘后把新状态交给缓存持有方（宿主的准入守卫读的是缓存快照，只在轮末刷新就会读到旧状态）。
   * 监听器异常**一律不吞**：刷新失败必须让提交方失败关闭——静默丢弃正是这次陈旧快照缺陷的成因（审阅 R1）。
   */
  readonly onCommitted?: (missionId: string, state: MissionControl) => void
}

/** `drain()` 的记账结果。`unconfirmed` 是"执行器跑过但结果没能确认落盘"的条目数（审阅 R2）。 */
export interface DrainSummary {
  readonly attempted: number
  readonly completed: number
  readonly failed: number
  readonly unsupported: number
  readonly unconfirmed: number
  readonly blocked: readonly string[]
}

const COMMIT_ATTEMPTS = 3
/** outbox 退避：5 秒起翻倍，封顶 10 分钟；积压由 `/continuity status` 与 drain 计数暴露。 */
const OUTBOX_BACKOFF_BASE_MS = 5_000
const OUTBOX_BACKOFF_MAX_MS = 10 * 60_000
/** 领取过期只触发核对，不证明旧执行者已停：与租约同一口径（§6.3）。 */
const OUTBOX_CLAIM_TTL_MS = 5 * 60_000
/** 这两条串会进 `/continuity status` 与条目 `lastError`，要说清下一步而不是只报错。 */
const FOREIGN_CLAIM_ERROR = '投递结果未确认：条目由其他消费者领取且到期前没有回报，须与台账核对后再放行重投'
const CLAIMED_ENTRY_ERROR = '投递结果未确认：本消费者此前领取的条目没有回报，须与台账核对后再放行重投'

/** 领取：条目必须完全没有领取记录才写得进去；版本冲突后由 `patchOutbox` 重读重判。 */
function beginClaim(entry: OutboxEntry, consumerId: string, now: number, ttlMs: number): OutboxEntry | undefined {
  if (entry.completedAt !== undefined || entry.claimedAt !== undefined || entry.claimedBy !== undefined) return undefined
  return { ...entry, claimedAt: now, claimedBy: consumerId, claimExpiresAt: now + ttlMs }
}

/** 交还本次投递的领取；领取不属于本消费者时不写（过期领取由 {@link recoverStaleClaim} 处理）。 */
function releaseClaim(entry: OutboxEntry, consumerId: string): OutboxEntry | undefined {
  if (entry.claimedAt === undefined && entry.claimedBy === undefined && entry.claimExpiresAt === undefined) return undefined
  if (entry.claimedBy !== undefined && entry.claimedBy !== consumerId) return undefined
  return { ...entry, claimedAt: undefined, claimedBy: undefined, claimExpiresAt: undefined }
}

/** 带任一领取字段即视为已被领取过；畸形领取（没有到期时点）按他人持有处理，不当成没投过。 */
function hasClaim(entry: OutboxEntry): boolean {
  return entry.claimedAt !== undefined || entry.claimedBy !== undefined || entry.claimExpiresAt !== undefined
}

/** 结果未知：涨尝试次数、按既有退避改期，并把核对要求写进 `lastError`。 */
function markOutcomeUnknown(entry: OutboxEntry, error: string, at: number): OutboxEntry {
  return {
    ...entry,
    attempts: entry.attempts + 1,
    availableAt: at + Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** entry.attempts, OUTBOX_BACKOFF_MAX_MS),
    lastError: error,
  }
}

/**
 * 崩溃/到期恢复：领取过期或本消费者漏下的领取才交还——
 * 别人未过期的领取一个字节都不动（到期只触发核对，不证明旧执行者已停，§6.3）。
 */
function recoverStaleClaim(entry: OutboxEntry, consumerId: string, now: number, error: string): OutboxEntry | undefined {
  if (entry.completedAt !== undefined || !hasClaim(entry)) return undefined
  if (entry.claimedBy !== undefined && entry.claimedBy !== consumerId && entry.claimExpiresAt !== undefined && entry.claimExpiresAt > now) return undefined
  return markOutcomeUnknown({ ...entry, claimedAt: undefined, claimedBy: undefined, claimExpiresAt: undefined }, error, now)
}

/** 确认丢失：`sentAt` 说明执行器已返回（投递大概已发生），其余按结果未知处理。 */
function markUnclaimedDelivery(entry: OutboxEntry, error: string, consumerId: string, at: number): OutboxEntry | undefined {
  const released = releaseClaim(entry, consumerId)
  return released === undefined ? undefined : { ...markOutcomeUnknown(released, error, at), sentAt: at }
}

/** `submit` 可能连记录都读不到，因此状态允许为 `null`。 */
export type SubmitResult = Outcome | { readonly applied: false; readonly reason: string; readonly state: null }

/** 记账写入的三态：落盘 / 条目已不归本轮管（跳过） / 写不进去。 */
type BookkeepingVerdict = 'applied' | 'skipped' | 'failed'

export class ContinuityKernel {
  private readonly handlers = new Map<string, OutboxHandler>()
  /** 本进程正在跑 claim→执行→ack 的条目；`CommandQueue` 只串行单次读写，管不了这条跨读写的生命周期。 */
  private readonly inflight = new Set<string>()
  private readonly store: ControlStore
  private readonly queue: CommandQueue
  private readonly now: () => number
  private readonly maxCommitAttempts: number
  private readonly consumerId: string
  private readonly claimTtlMs: number
  private readonly leaseExpiryMs: number | undefined
  private readonly notify: ((missionId: string, state: MissionControl) => void) | undefined

  constructor(store: ControlStore, queue: CommandQueue, options: KernelOptions = {}) {
    this.store = store
    this.queue = queue
    this.now = options.now ?? Date.now
    this.maxCommitAttempts = options.maxCommitAttempts ?? COMMIT_ATTEMPTS
    this.consumerId = options.consumerId ?? mintId('consumer')
    this.claimTtlMs = options.claimTtlMs ?? OUTBOX_CLAIM_TTL_MS
    this.leaseExpiryMs = options.leaseExpiryMs
    this.notify = options.onCommitted
  }

  /** `kind` 对应 OutboxEntry.kind；未注册的种类留在队列里可见，不静默丢弃。 */
  registerHandler(kind: string, handler: OutboxHandler): void {
    this.handlers.set(kind, handler)
  }

  /**
   * 只读装载。`null` 的含义**只有**"没有这条记录"；
   * 版本不符时按 §5.3 抛 {@link SchemaVersionMismatch}，不降级成 null，免得调用方把
   * "需要迁移"读成"mission 不存在"进而重开一条新记录。
   */
  async read(missionId: string): Promise<MissionControl | null> {
    return this.store.load(missionId)
  }

  /** 创建 Mission：必须走同一条队列，避免"先查不存在、再 put"的竞争。 */
  async open(mission: Mission): Promise<MissionControl> {
    return this.queue.enqueue('mission.open', async () => {
      // 已有记录版本不符时这里就抛出：不覆盖、不迁移，等独占维护流程处理（§5.3）。
      const existing = await this.store.load(mission.missionId)
      if (existing !== null) return existing
      const initial: MissionControl = {
        ...emptyControl(mission.missionId, mission, this.now()),
        schemaVersion: SCHEMA_VERSION,
      }
      await this.store.create(mission.missionId, initial)
      this.notifyCommitted(mission.missionId, initial)
      return initial
    })
  }

  /**
   * 提交一条命令。读-改-写在同一条 Host 队列上串行；
   * 版本冲突时重读并重放转换，最多 `maxCommitAttempts` 次后如实报告。
   */
  async submit(missionId: string, cmd: Command, ctx: CommandContext): Promise<SubmitResult> {
    return this.queue.enqueue(`command:${cmd.kind}`, async () => {
      let lastError = 'control record missing'
      for (let attempt = 0; attempt < this.maxCommitAttempts; attempt += 1) {
        let current: MissionControl | null
        try {
          current = await this.store.load(missionId)
        } catch (error) {
          // 装载被版本闸拒绝不是重试能解决的事，把维护步骤原样交回调用方（§5.3）。
          if (error instanceof SchemaVersionMismatch) return { applied: false, reason: error.message, state: null }
          throw error
        }
        if (current === null) return { applied: false, reason: `mission ${missionId} is not open`, state: null }
        // 上下文逐项重建而不是 `{ ...ctx }`：`now` 一律取内核时钟（否则去重与租约会跟着外部时钟漂），
        // 而 `sessionId` 这类运行时绑定必须透传给转换层——票据核对要靠它认出当前 Attempt（§12.2）。
        const runtime: CommandContext = {
          actorId: ctx.actorId,
          role: ctx.role,
          now: this.now(),
          ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
          ...(this.leaseExpiryMs === undefined ? {} : { leaseExpiryMs: this.leaseExpiryMs }),
        }
        const result = dispatch(current, cmd, runtime)
        if (!result.applied) return result
        try {
          await this.store.commit(missionId, current.revision, result.state)
        } catch (error) {
          // 取 `message` 而不是 `String(error)`：这些串会直接出现在 `/continuity status` 与日志里，
          // 前缀 "Error: " 只是噪声，还会把真正的存储故障挤到行尾。
          lastError = error instanceof Error ? error.message : String(error)
          if (!(error instanceof RevisionConflict)) return { applied: false, reason: `commit failed: ${lastError}`, state: current }
          continue
        }
        // 监听器异常不在这里兜：写已经落盘，缓存刷不回就是让守卫读旧快照，必须让调用方失败关闭（审阅 R1）。
        this.notifyCommitted(missionId, result.state)
        return result
      }
      return { applied: false, reason: `commit abandoned after ${this.maxCommitAttempts} attempts: ${lastError}`, state: null }
    })
  }

  /**
   * 消费 outbox。执行器把结果再提交回内核；失败的条目按退避重试，
   * 未知错误**不**标记完成——宁可积压并报告，也不假装成功。
   *
   * `blocked` 里是本轮被拒绝装载的 Mission 及原因：一条待迁移的旧记录不能拖垮整个投递，
   * 但也不能静默跳过——理由要随计数一起回到视图（§5.3）。
   *
   * `unconfirmed` 是"执行器已经跑过、但结果没能确认落盘"的条目数（审阅 R2）：领取到期、
   * 上一轮领取没回报、完成确认写不进存储都归到这里。这些条目按退避退回积压，由接收侧
   * 用条目自带的稳定 `idempotencyKey` 去重后重投；内核不猜它到底成功没有。
   *
   * 领取（claim）是跨读写的生命周期，队列只串行单次读写，所以本进程用 `inflight` 串行、
   * 跨进程用存储里的持久领取记录 + CAS 裁决：没领到的条目绝不执行。
   */
  async drain(signal?: AbortSignal): Promise<DrainSummary> {
    const ids = await this.queue.enqueue('outbox.scan', () => this.store.list())
    let attempted = 0
    let completed = 0
    let failed = 0
    let unsupported = 0
    let unconfirmed = 0
    const blocked: string[] = []
    for (const missionId of ids) {
      if (signal?.aborted) break
      let state: MissionControl | null
      try {
        state = await this.store.load(missionId)
      } catch (error) {
        if (error instanceof SchemaVersionMismatch) {
          blocked.push(error.message)
          continue
        }
        throw error
      }
      if (state === null) continue
      const now = this.now()
      const pending = Object.values(state.outbox).filter(
        (entry) => entry.completedAt === undefined && entry.availableAt <= now && !this.holdsForeignClaim(entry, now),
      )
      for (const entry of pending) {
        if (signal?.aborted) break
        const handler = this.handlers.get(entry.kind)
        if (handler === undefined) {
          unsupported += 1
          continue
        }
        const key = `${missionId}/${entry.outboxId}`
        // 本进程另一轮 drain 正在跑这条：跳过它，不排队重复投递。
        if (this.inflight.has(key)) continue
        // 有条目带领取记录却没有回报（过期或被自己漏下）：先记一笔结果未知并退避，本轮不碰执行器。
        if (hasClaim(entry)) {
          const outcome = await this.patchOutbox(missionId, entry.outboxId, (item, at) =>
            recoverStaleClaim(item, this.consumerId, at, item.claimedBy === this.consumerId ? CLAIMED_ENTRY_ERROR : FOREIGN_CLAIM_ERROR),
          )
          if (outcome === 'applied') unconfirmed += 1
          else if (outcome === 'failed') failed += 1
          continue
        }
        // 领取必须在任何 await 之前登记，否则两个并发 drain 都会认为自己拿到了同一条。
        this.inflight.add(key)
        try {
          const claimed = await this.patchOutbox(missionId, entry.outboxId, (item, at) => beginClaim(item, this.consumerId, at, this.claimTtlMs))
          // `skipped`：重读后条目已完成或已被他人领取 ⇒ 本轮不执行；写不进去是 `failed`，没有持久领取就不投递。
          if (claimed === 'failed') failed += 1
          else if (claimed === 'applied') {
            attempted += 1
            let handlerError: unknown
            try {
              await handler(entry, signal)
            } catch (error) {
              handlerError = error
            }
            if (handlerError === undefined) {
              const ack = await this.submit(missionId, { kind: 'outbox.complete', requestId: `obx:${entry.outboxId}:${entry.attempts}`, outboxId: entry.outboxId }, { actorId: 'supervisor', role: 'supervisor', now: this.now() })
              if (ack.applied) {
                completed += 1
                await this.release(missionId, entry.outboxId)
              } else {
                // 执行器已返回但确认没落盘：这条投递只能算"结果未知"，绝不能记成 completed。
                unconfirmed += 1
                const message = `投递结果未确认：完成确认没有写入存储（${ack.reason}），须与台账核对后再放行重投`
                await this.patchOutbox(missionId, entry.outboxId, (item, at) => markUnclaimedDelivery(item, message, this.consumerId, at))
              }
            } else {
              failed += 1
              // 只登记重试与退避，不标完成：假装成功会让"投递过"变成不可追溯的事实。
              const backoffMs = Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** entry.attempts, OUTBOX_BACKOFF_MAX_MS)
              await this.submit(
                missionId,
                {
                  kind: 'outbox.retry',
                  requestId: `obx:${entry.outboxId}:fail:${entry.attempts}`,
                  outboxId: entry.outboxId,
                  error: handlerError instanceof Error ? handlerError.message : String(handlerError),
                  availableAt: this.now() + backoffMs,
                },
                { actorId: 'supervisor', role: 'supervisor', now: this.now() },
              )
              await this.release(missionId, entry.outboxId)
            }
          }
        } finally {
          this.inflight.delete(key)
        }
      }
    }
    return { attempted, completed, failed, unsupported, unconfirmed, blocked }
  }

  /** 别的消费者还持有领取（含没有到期时点的畸形领取）⇒ 这一轮不看它。 */
  private holdsForeignClaim(entry: OutboxEntry, now: number): boolean {
    if (entry.claimedBy === undefined || entry.claimedBy === this.consumerId) return false
    return entry.claimExpiresAt === undefined || entry.claimExpiresAt > now
  }

  /** 投递收尾后交还领取：完成与失败都要还，否则下一轮只能等领取自己过期。 */
  private async release(missionId: string, outboxId: string): Promise<void> {
    await this.patchOutbox(missionId, outboxId, (entry) => releaseClaim(entry, this.consumerId))
  }

  /**
   * outbox 的账本写入（领取 / 交还 / 结果登记）。
   *
   * 这些是投递流水而不是业务决策，所以直接构造 next 走 CAS、不经过 `dispatch()`：
   * 命令层会给每个条目多追加一条控制事件并占用命令去重表，把业务时间线读成投递日志。
   * 版本冲突后重读并重跑 `patch` 再判一次——`patch` 返回 `undefined` 即条目已不归本轮管，
   * 于是跳过而不执行，绝不在没领到的条目上调用执行器（审阅 R2）。
   */
  private async patchOutbox(
    missionId: string,
    outboxId: string,
    patch: (entry: OutboxEntry, now: number) => OutboxEntry | undefined,
  ): Promise<BookkeepingVerdict> {
    return this.queue.enqueue('outbox.claim', async () => {
      for (let attempt = 0; attempt < this.maxCommitAttempts; attempt += 1) {
        let current: MissionControl | null
        try {
          current = await this.store.load(missionId)
        } catch (error) {
          if (error instanceof SchemaVersionMismatch) return 'skipped'
          throw error
        }
        if (current === null) return 'skipped'
        const entry = current.outbox[outboxId]
        if (entry === undefined) return 'skipped'
        const at = this.now()
        const patched = patch(entry, at)
        if (patched === undefined) return 'skipped'
        const next: MissionControl = { ...current, revision: current.revision + 1, outbox: { ...current.outbox, [outboxId]: patched } }
        try {
          await this.store.commit(missionId, current.revision, next)
        } catch (error) {
          // 只认存储层抛出的版本冲突；不比对修订号判断"我这笔是否生效"。
          if (!(error instanceof RevisionConflict)) return 'failed'
          continue
        }
        this.notifyCommitted(missionId, next)
        return 'applied'
      }
      return 'failed'
    })
  }

  /** 打开/关闭业务入场；恢复核对完成前保持关闭。 */
  async setAdmission(missionId: string, open: boolean): Promise<boolean> {
    return this.queue.enqueue('admission', async () => {
      const current = await this.store.load(missionId)
      if (current === null) return false
      const next: MissionControl = { ...current, admissionClosed: !open, revision: current.revision + 1 }
      await this.store.commit(missionId, current.revision, next)
      this.notifyCommitted(missionId, next)
      return true
    })
  }

  /**
   * 续期在跑的执行权租约（§6.2 心跳；§12「租约在 Host 内结合单调时钟与心跳判断，持久 UTC 时点
   * 用于审计和重启核对」）。设计稿给的候选节拍是 15 秒续 / 90 秒过期。
   *
   * 三条边界，缺一条这个续期就变成"永不失效"：
   * ① 只碰调用方确认**活着**的会话——liveness 来自 Host 的 `agent/status`，进程一停 `alive` 就空，
   *    所以下一次核对仍然按 §6.3 走"到期=要核对"，不是"到期=可抢占"；
   * ② 不推进 `revision`、不追加控制事件：心跳是运维时点而不是控制决策，
   *    15 秒记一笔会把归档压力变成常态，也让 `status` 的时间线读不出真实动作；
   * ③ 终态 Attempt 不动，避免给已取消/已结算的尝试续一个永远不到的期。
   *
   * @returns 本次实际续期的 Attempt 数（跨全部 mission）。
   */
  async renewLeases(aliveSessionIds: ReadonlySet<string>, expiryMs: number): Promise<number> {
    if (aliveSessionIds.size === 0 || expiryMs <= 0) return 0
    let total = 0
    for (const missionId of await this.store.list()) {
      const renewed = await this.queue.enqueue('lease.heartbeat', async () => {
        const current = await this.store.load(missionId)
        if (current === null) return 0
        const now = this.now()
        const touched: Record<string, Attempt> = {}
        for (const [attemptId, attempt] of Object.entries(current.attempts)) {
          if (isTerminalAttempt(attempt.status) || attempt.sessionId === undefined || !aliveSessionIds.has(attempt.sessionId)) continue
          touched[attemptId] = heartbeat(attempt, now, expiryMs)
        }
        const count = Object.keys(touched).length
        if (count === 0) return 0
        const next: MissionControl = { ...current, attempts: { ...current.attempts, ...touched } }
        await this.store.commit(missionId, current.revision, next)
        this.notifyCommitted(missionId, next)
        return count
      })
      total += renewed
    }
    return total
  }

  /**
   * 落盘后唯一的缓存刷新出口：漏一条路径就会让宿主的准入守卫停在旧快照上（审阅 R1）。
   * 不 try/catch——刷新失败要沿调用栈抛回去，让这一笔提交失败关闭，而不是继续放行。
   */
  private notifyCommitted(missionId: string, state: MissionControl): void {
    this.notify?.(missionId, state)
  }
}
