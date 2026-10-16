/**
 * 轮换执行器（设计稿 v0.3 §10.3–§10.5、§22.6、§23.2 第 1、3 条）：把 FSM 的阶段推进翻译成宿主动作。
 *
 * 分工是刻意的：**内核决定"能不能进"**（`commands.ts` 校验阶段合法性、只在 COMMITTED
 * 那一次原子写里换绑定并写启动 outbox），本文件决定"**做什么副作用**"（静默、建 S2、投信）。
 * 每个阶段推进都单独提交，因此崩溃后控制记录里的 `phase` 就是真实进度，恢复时不需要猜测。
 *
 * 三条不可协商的顺序：
 * 1. 先落 REQUESTED 事实，再动源会话——反过来会出现"会话已静默但台账不知道"；
 * 2. COMMITTED 之前失败 ⇒ 放弃轮换、源会话照常跑（`shouldKeepSource`）；
 *    COMMITTED 之后失败 ⇒ 停在 ACTIVATING 等核对，**不**自动退回 S1（执行权已属 S2）；
 * 3. 启动消息的持久化回执拿不到就不推进 ACTIVE（`confirmSeed` 只作为补救核对）。
 *
 * 第四条是 v0.3 加的：**依据或规则版本在请求之后被改动，就不放行 S2**（§10.2、§23.2 第 1 条）。
 * 重验落在三处——组包前（还没换绑，走 hold 出口：源会话继续跑）、投递启动消息前（投递即唤醒 S2，
 * 旧摘要一条都不进 S2）、推进 ACTIVE 前（放行判定的最后一道闸，goal 装载也在它之后）。
 * 任一处不通过都只挂起这次交接，等按当前依据重出交接包，不让旧摘要把已撤回的结论带回新会话。
 */
import type { ContinuityKernel } from '../core/kernel.ts'
import type { MissionControl } from '../core/control.ts'
import type { CommandContext } from '../core/commands.ts'
import type { Rotation, RotationPhase } from '../core/entities.ts'
import { assembleBrief, type BriefFacts } from '../rotation/brief.ts'
import {
  legalSuccessors,
  missingPhaseFacts,
  reverifyHandoffPackage,
  safeToHandoff,
  shouldKeepSource,
  type QuiescenceProbe,
} from '../rotation/fsm.ts'
import { AWAIT_BRIEF_RECOMPUTE } from '../rotation/policy.ts'
import type { StopLatch } from '../rotation/latch.ts'
import {
  confirmSeed,
  createOrAdoptTarget,
  deliverSeed,
  moveSchedules,
  quiesce,
  reserveSessionId,
  SEED_MARKER,
  type SeedMessageFactory,
} from './dsh.ts'
import type { AgentLike, HostSlice } from './host-types.ts'

export interface RotationRunConfig {
  readonly slowAfterMs: number
  readonly deadlineMs: number
  readonly migrateSchedules: boolean
  readonly rearmGoal: boolean
}

export interface RotationRunDeps {
  readonly kernel: ContinuityKernel
  readonly host: HostSlice
  readonly latch: StopLatch
  readonly makeMessage: SeedMessageFactory
  readonly config: () => RotationRunConfig
  readonly ctxFor: (actorId: string) => CommandContext
  readonly agentOf: (sessionId: string) => AgentLike | undefined
  readonly probe: (sessionId: string) => QuiescenceProbe
  /**
   * 事实层：交接包里"改了哪些文件/最近一步"这类材料只能按会话观察得到，
   * 因此签名带上源会话。检查点本身由 `assembleBrief` 直接取，不在这里绕一道。
   */
  readonly briefFacts: (state: MissionControl, sessionId: string) => BriefFacts
  /**
   * 源会话的工作目录。S2 必须落在同一个 workspace：用 `process.cwd()` 会把新会话
   * 建到宿主进程的目录上，因此这里**要求调用方提供**，取不到就放弃轮换。
   */
  readonly cwdFor: (sessionId: string) => string | undefined
  /**
   * 阶段播报：pre-step 守卫要知道源会话处在提交点**前**还是**后**
   * （前者放弃迁移、后者改道），而执行器是唯一按序推进阶段的人，因此由它带着轮换实体播报。
   */
  readonly onPhase?: (rotation: Rotation, phase: RotationPhase) => void
  /** S2 沿用 S1 的 agent preset：preset 不一致在收养时是硬失败（§10.4）。 */
  readonly presetFor?: (sessionId: string) => string | undefined
  readonly log: (level: 'info' | 'warn', message: string) => void
}

export type RotationRunResult =
  | { readonly ok: true; readonly rotationId: string; readonly phase: RotationPhase; readonly detail: string }
  | { readonly ok: false; readonly rotationId: string | undefined; readonly phase: RotationPhase | undefined; readonly reason: string }

/** 某 Actor 唯一未收束的轮换；没有即 `undefined`（§3.3：一个 Actor 只有一个当前绑定）。 */
function openRotation(state: MissionControl, actorId: string): Rotation | undefined {
  return Object.values(state.rotations)
    .filter((rotation) => rotation.actorId === actorId && rotation.phase !== 'ACTIVE')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

/** 阶段推进；被内核拒绝时把拒绝理由原样带回，不重试、不粉饰。 */
async function advance(
  deps: RotationRunDeps,
  missionId: string,
  rotationId: string,
  phase: RotationPhase,
): Promise<{ readonly state: MissionControl; readonly rotation: Rotation } | { readonly failure: string }> {
  const before = await deps.kernel.read(missionId)
  if (before === null) return { failure: `Mission ${missionId} 记录缺失` }
  const rotation = before.rotations[rotationId]
  if (rotation === undefined) return { failure: `轮换 ${rotationId} 不存在` }
  if (!legalSuccessors(rotation.phase).includes(phase)) {
    return { failure: `阶段 ${rotation.phase} → ${phase} 不合法（合法后继：${legalSuccessors(rotation.phase).join(', ')}）` }
  }
  const result = await deps.kernel.submit(
    missionId,
    { kind: 'continuity.advanceRotation', requestId: `adv:${rotationId}:${phase}`, rotationId, phase },
    deps.ctxFor(rotation.actorId),
  )
  if (!result.applied) return { failure: `推进到 ${phase} 被拒：${result.reason}` }
  const next = result.state.rotations[rotationId]
  if (next === undefined) return { failure: `推进后读不到轮换 ${rotationId}` }
  deps.onPhase?.(next, phase)
  return { state: result.state, rotation: next }
}

/**
 * 放行 S2 之前的版本重验（§10.2、§22.6、§23.2 第 1、3 条）。
 *
 * 返回 `undefined` = 手上的交接包仍代表当前依据，可以放行；返回一句话原因 = 不得放行。
 * 这两个调用点都在提交点之后，执行权已属 S2，因此失败出口只有 fail 一种：
 * 登记 WAITING_RECOVERY，并把"按当前版本重算交接包"写成下一项核对动作，**不**自动退回 S1。
 */
async function reverifyBeforeRelease(
  deps: RotationRunDeps,
  missionId: string,
  rotationId: string,
  where: 'pre-seed' | 'pre-active',
): Promise<{ readonly reason: string } | undefined> {
  const state = await deps.kernel.read(missionId)
  const rotation = state?.rotations[rotationId]
  // 记录读不到时不在这里造第二条诊断：那由随后的 `advance` 明确报"记录缺失"。
  if (state === null || rotation === undefined) return undefined
  const verdict = reverifyHandoffPackage(rotation, state)
  if (verdict.ready) return undefined
  const reason = `${AWAIT_BRIEF_RECOMPUTE}：${verdict.missing.join('；')}`
  const failed = await deps.kernel.submit(
    missionId,
    {
      kind: 'continuity.failRotation',
      requestId: `fail:${rotationId}:revision-drift:${where}`,
      rotationId,
      reason,
      nextReconcileAction: '按当前依据与规则快照重算交接包，再用 continuity.resolveUnknown 决定放行 S2 还是显式换绑',
    },
    deps.ctxFor(rotation.actorId),
  )
  if (!failed.applied) deps.log('warn', `版本重验不通过，但 WAITING_RECOVERY 未登记成功（${failed.reason}）：${reason}`)
  return { reason }
}

/**
 * 执行一次完整轮换。
 *
 * @param deps - 注入的宿主能力（全部可替身，因此本文件可离线测）。
 * @param input - 触发参数；`checkpointId` 必须是已落盘的检查点，执行器不负责造检查点。
 */
export async function runRotation(
  deps: RotationRunDeps,
  input: { readonly missionId: string; readonly actorId: string; readonly sourceSessionId: string; readonly checkpointId: string; readonly trigger: Rotation['trigger'] },
): Promise<RotationRunResult> {
  const state = await deps.kernel.read(input.missionId)
  if (state === null) return { ok: false, rotationId: undefined, phase: undefined, reason: 'mission-not-open' }
  const actor = state.actors[input.actorId]
  if (actor === undefined) return { ok: false, rotationId: undefined, phase: undefined, reason: 'actor-unknown' }
  if (actor.sessionId !== input.sourceSessionId) {
    return { ok: false, rotationId: undefined, phase: undefined, reason: `Actor 当前绑定是 ${String(actor.sessionId)}，与请求的源会话不符` }
  }
  const checkpoint = state.checkpoints[input.checkpointId]
  if (checkpoint === undefined) return { ok: false, rotationId: undefined, phase: undefined, reason: 'checkpoint-not-found' }
  const existing = openRotation(state, input.actorId)
  if (existing !== undefined) {
    return { ok: false, rotationId: existing.rotationId, phase: existing.phase, reason: `已有未收束轮换（${existing.phase}），先核对它` }
  }

  const cwd = deps.cwdFor(input.sourceSessionId)
  if (cwd === undefined || cwd.length === 0) {
    return { ok: false, rotationId: undefined, phase: undefined, reason: '取不到源会话工作目录：不能把新会话建到别的 workspace' }
  }

  const targetSessionId = reserveSessionId()
  const seedMessageId = `seed:${targetSessionId}`
  const requested = await deps.kernel.submit(
    input.missionId,
    {
      kind: 'continuity.requestRotation',
      requestId: `req:${input.actorId}:${targetSessionId}`,
      actorId: input.actorId,
      sourceSessionId: input.sourceSessionId,
      targetSessionId,
      checkpointId: input.checkpointId,
      trigger: input.trigger,
      seedMessageId,
    },
    deps.ctxFor(input.actorId),
  )
  if (!requested.applied) return { ok: false, rotationId: undefined, phase: undefined, reason: `request 被拒：${requested.reason}` }
  const rotation = openRotation(requested.state, input.actorId)
  if (rotation === undefined) return { ok: false, rotationId: undefined, phase: 'REQUESTED', reason: '提交后读不到轮换' }
  const rotationId = rotation.rotationId
  deps.onPhase?.(rotation, 'REQUESTED')
  // 一个会话同一时刻只承载一个 Actor 绑定，因此 sessionId 就是足够的 latch 键，
  // 与 `preStepGuard` 读的是同一个键。
  const latchKey = rotation.sourceSessionId
  const bail = (phase: RotationPhase | undefined, reason: string): RotationRunResult => {
    deps.log('warn', `轮换 ${rotationId} 停在 ${String(phase)}：${reason}`)
    return { ok: false, rotationId, phase, reason }
  }
  const stop = (): void => {
    deps.latch.release(latchKey)
  }

  // —— QUIESCING：软停 + 等边界。绝不 cancel 正在跑的步骤（§7.1）。
  deps.latch.hold(latchKey)
  const agent = deps.agentOf(rotation.sourceSessionId)
  if (agent === undefined) {
    stop()
    return bail(rotation.phase, '源会话没有活动 Agent：无法确认静默，放弃轮换')
  }
  const cfg = deps.config()
  const outcome = await quiesce(agent, {
    slowAfterMs: cfg.slowAfterMs,
    deadlineMs: cfg.deadlineMs,
    isCancelled: () => !deps.latch.isHeld(latchKey),
    onSlow: (elapsed) => deps.log('info', `等待步骤边界已 ${Math.round(elapsed / 1000)} 秒，继续等待`),
  })
  if (outcome !== 'boundary') {
    stop()
    return bail(rotation.phase, `边界等待结果=${outcome}`)
  }
  const quieting = await advance(deps, input.missionId, rotationId, 'QUIESCING')
  if ('failure' in quieting) { stop(); return bail(rotation.phase, quieting.failure) }

  // —— PREPARED：安全核对 + 交接包组装（纯函数，除日志外无副作用）。
  // `now` 用命令上下文里的时钟：票据里的授权期限要按真实时间判，不能让旧提交时间替过期授权说话。
  const verdict = safeToHandoff(quieting.state, actor, deps.probe(rotation.sourceSessionId), deps.ctxFor(rotation.actorId).now)
  if (!verdict.ready) {
    stop()
    return bail('QUIESCING', `静默核对未通过：${verdict.missing.join('、')}`)
  }
  const factsMissing = missingPhaseFacts(quieting.rotation, 'PREPARED')
  if (factsMissing.length > 0) {
    stop()
    return bail('QUIESCING', `PREPARED 事实缺失：${factsMissing.join('、')}`)
  }
  // 第一处版本重验（组包之前，§10.2、§23.2 第 1 条）：请求轮换之后有结论被撤回 / 授权被撤销 /
  // 规则快照被修订时，按旧版本组出来的交接包一放进 S2 就会把撤回的结论恢复成当前依据。
  // 此刻还没换绑，走 hold 出口：源会话继续跑，本 Actor 挂起新工作，等按新版本重出包。
  const packageVerdict = reverifyHandoffPackage(quieting.rotation, quieting.state)
  if (!packageVerdict.ready) {
    stop()
    return bail('QUIESCING', `${AWAIT_BRIEF_RECOMPUTE}（提交点前，未换绑，S1 继续执行）：${packageVerdict.missing.join('；')}`)
  }
  const brief = assembleBrief(quieting.state, checkpoint, deps.briefFacts(quieting.state, rotation.sourceSessionId))
  const prepared = await advance(deps, input.missionId, rotationId, 'PREPARED')
  if ('failure' in prepared) { stop(); return bail('QUIESCING', prepared.failure) }

  // —— TARGET_READY：按预留 ID 建/收养 S2（此刻 S2 只等启动消息，不放业务入场）。
  const preset = deps.presetFor?.(rotation.sourceSessionId)
  const created = await createOrAdoptTarget(
    deps.host,
    { sessionId: targetSessionId, cwd, ...(preset === undefined || preset.length === 0 ? {} : { agentPreset: preset }) },
    false,
  )
  if (!created.ok) {
    stop()
    return bail('PREPARED', `建 S2 失败：${created.reason}（code=${created.code}）`)
  }
  if (cfg.migrateSchedules) {
    const moved = await moveSchedules(deps.host, rotation.sourceSessionId, targetSessionId)
    if (moved.blocked.length > 0) {
      deps.log('warn', `定时任务未能全部迁移：${moved.blocked.join(', ')}；已迁移 ${moved.moved} 条`)
    }
  }
  const ready = await advance(deps, input.missionId, rotationId, 'TARGET_READY')
  if ('failure' in ready) { stop(); return bail('PREPARED', ready.failure) }

  // —— COMMITTED：唯一换执行权的提交；绑定交换 + 启动 outbox 在同一次单记录原子写里。
  const committed = await advance(deps, input.missionId, rotationId, 'COMMITTED')
  if ('failure' in committed) {
    stop()
    return bail('TARGET_READY', `提交失败，按未提交处理：${committed.failure}`)
  }

  // —— ACTIVATING：投递启动消息并核对回执。
  const activating = await advance(deps, input.missionId, rotationId, 'ACTIVATING')
  if ('failure' in activating) return bail('COMMITTED', activating.failure)
  // 第二处版本重验（唤醒 S2 之前）：投递启动消息就等于叫新会话开工，
  // 所以这一版必须仍代表当前依据；不通过就登记 WAITING_RECOVERY，旧摘要一条都不进 S2。
  const preSeed = await reverifyBeforeRelease(deps, input.missionId, rotationId, 'pre-seed')
  if (preSeed !== undefined) {
    stop()
    return bail('ACTIVATING', `${preSeed.reason}（已过提交点：S2 未被唤醒，执行权仍记在 S2 名下）`)
  }
  const receipt = await deliverSeed(deps.host, targetSessionId, brief.markdown, seedMessageId, deps.makeMessage)
  if (!receipt.ok) {
    const confirmed = await confirmSeed(deps.host, targetSessionId, seedMessageId, SEED_MARKER)
    if (confirmed !== 'present') {
      // 已过提交点：保留 WAITING_RECOVERY 事实，不退回 S1，也不谎称已启动。
      await deps.kernel.submit(
        input.missionId,
        { kind: 'continuity.failRotation', requestId: `fail:${rotationId}:seed`, rotationId, reason: `启动消息未确认（${receipt.reason}，核对=${confirmed}）`, nextReconcileAction: `按 rpcId ${seedMessageId} 复查 S2 后再决定重投或换会话` },
        deps.ctxFor(input.actorId),
      )
      stop()
      return bail('ACTIVATING', `启动消息未确认（核对结果=${confirmed}）：${receipt.reason}`)
    }
    deps.log('info', 'flush 未确认，但按 rpcId 查到启动消息已在 S2：继续推进')
  }

  // 直投成功后结掉提交点同批写入的 outbox 意图条目：留着它，积压计数就把"已投"报成"欠投"，
  // 崩溃恢复时也分不清该不该再投一次（投递本身由 `confirmSeed` 兜底去重）。
  const seedEntry = Object.values(committed.state.outbox).find(
    (entry) => entry.kind === 'rotation.seed' && entry.completedAt === undefined && entry.payload.rotationId === rotationId,
  )
  if (seedEntry !== undefined) {
    const closed = await deps.kernel.submit(
      input.missionId,
      { kind: 'outbox.complete', requestId: `obx:${seedEntry.outboxId}:runner`, outboxId: seedEntry.outboxId },
      deps.ctxFor(input.actorId),
    )
    if (!closed.applied) deps.log('warn', `启动条目未能结掉（${closed.reason}）：下次 drain 会按 rpcId 复查后再决定，不重复投递。`)
  }

  // 第三处版本重验（S2 放行之前，§10.2、§23.2 第 1 条）：ACTIVE 是"可执行业务"的门，
  // goal 的重新装载也在同一道门之后——创建 goal 可能同时 arm（§10.3），
  // 因此版本不匹配时既不推进 ACTIVE，也不给 S2 装 goal。
  const preActive = await reverifyBeforeRelease(deps, input.missionId, rotationId, 'pre-active')
  if (preActive !== undefined) {
    stop()
    return bail('ACTIVATING', `${preActive.reason}（S2 未放行：不进 ACTIVE、不装载 goal）`)
  }

  stop()
  if (cfg.rearmGoal) {
    const target = await deps.host.sessionController?.resolveAgent(targetSessionId)
    if (target?.agent !== undefined && deps.host.goals !== undefined) {
      try {
        deps.host.goals.create(target.agent, { objective: committed.state.mission.objective })
        deps.log('info', '已在 S2 重新装载 goal')
      } catch (error) {
        deps.log('warn', `goal 重新装载失败，不影响 ACTIVE 判定：${String(error)}`)
      }
    }
  }
  const active = await advance(deps, input.missionId, rotationId, 'ACTIVE')
  if ('failure' in active) return bail('ACTIVATING', active.failure)
  return {
    ok: true,
    rotationId,
    phase: 'ACTIVE',
    detail: `交接包 ${brief.tokens} token${brief.overBudget ? '（超预算：四个受保护段落没被裁剪，需人工决定口径）' : ''}`,
  }
}

/** 提交点之前放弃轮换；已过提交点必须走显式核对，这里拒绝并说明原因。 */
export async function abandonRotation(deps: RotationRunDeps, missionId: string, rotationId: string, reason: string): Promise<string> {
  const state = await deps.kernel.read(missionId)
  const rotation = state?.rotations[rotationId]
  if (state === null || rotation === undefined) return '轮换不存在'
  if (!shouldKeepSource(rotation)) return '已过提交点：不能自动退回源会话，需显式 continuity.resolveUnknown'
  const result = await deps.kernel.submit(
    missionId,
    { kind: 'continuity.failRotation', requestId: `fail:${rotationId}:${reason.slice(0, 24)}`, rotationId, reason, nextReconcileAction: 'retry from QUIESCING' },
    deps.ctxFor(rotation.actorId),
  )
  return result.applied ? result.effect : result.reason
}
