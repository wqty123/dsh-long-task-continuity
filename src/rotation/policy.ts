/**
 * 上下文压力检测与轮换判定（设计稿 v0.3 §10.1）。
 *
 * 迟滞状态机移植自 dsh-context-guard 的 `policy.mjs`（MIT）：双档 warn/hard、
 * 回落到 warn−hysteresis 才重新武装、边沿触发（只在跨档那一刻出声）、冷却 N 轮、
 * compaction 遮蔽后数字掉下来即清旗、数据缺席一律 fail-closed。
 *
 * 判定顺序照 `qingyou002/dsh-auto-handoff` 的 `decideAutoAction`（MIT）搬骨架，
 * 但**把口径从"累计绝对 token"换成"占窗口比例"**：绝对阈值在换模型即换窗口时会失效，
 * 而本框架的触发条件（§10.1 的 `T = min(floor(p × W), C − M)`）必须是比率；
 * C/T 的算式与观察模式收敛在 `lines.ts`，这里只消费它的结果。
 *
 * v0.3 在这里多留一个出口：交接包因依据/规则被修订而需要重算时，判定是"观察等待"，
 * 不是"不换"——见 `RotationGateInput.awaitingBriefRecompute`。
 */
import type { Occupancy } from './lines.ts'
import type { RotationLine } from './lines.ts'

export type GuardLevel = 'none' | 'warn' | 'hard'

export interface GuardConfig {
  readonly warnRatio: number
  readonly hardRatio: number
  readonly hysteresisRatio: number
  readonly cooldownTurns: number
  readonly respectCompaction: boolean
  readonly enabled: boolean
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  warnRatio: 0.45,
  hardRatio: 0.6,
  hysteresisRatio: 0.05,
  cooldownTurns: 5,
  respectCompaction: true,
  enabled: true,
}

export interface GuardState {
  readonly level: GuardLevel
  readonly armed: boolean
  readonly turn: number
  readonly cooldown: number
  readonly compactionDrop: boolean
  readonly occupancy: Occupancy | null
}

export function initialGuardState(): GuardState {
  return { level: 'none', armed: false, turn: 0, cooldown: 0, compactionDrop: false, occupancy: null }
}

export interface PressureSignal {
  readonly kind: 'enter' | 'escalate'
  readonly level: GuardLevel
  readonly ratio: number | null
  readonly projectedTokens: number | null
  readonly contextWindow: number | null
  readonly turn: number
  readonly compactionDrop: boolean
}

export interface ReduceOptions {
  readonly config?: GuardConfig
  readonly atTurnBoundary?: boolean
  readonly justCompacted?: boolean
}

const LEVEL_RANK: Readonly<Record<GuardLevel, number>> = { none: 0, warn: 1, hard: 2 }

/** `GuardState` 对外是只读快照，状态机内部推进用这个可变视图。 */
type MutableGuardState = { -readonly [K in keyof GuardState]: GuardState[K] }

export function reduceGuard(state: GuardState, occupancy: Occupancy, options: ReduceOptions = {}): { readonly state: GuardState; readonly signal: PressureSignal | null } {
  const cfg = options.config ?? DEFAULT_GUARD_CONFIG
  // fail-closed：无分母不动状态机，也不清除既有档位。
  if (!occupancy.known || occupancy.ratio === null) return { state: { ...state }, signal: null }

  const ratio = occupancy.ratio
  const hysteresis = Math.max(0, cfg.hysteresisRatio)
  const rearmBelow = Math.max(0, cfg.warnRatio - hysteresis)
  const wasLevel = state.level
  const next: MutableGuardState = { ...state, occupancy: { ...occupancy } }

  if (ratio < rearmBelow) {
    if (wasLevel !== 'none') next.compactionDrop = true
    next.level = 'none'
    next.armed = false
  } else if (ratio < cfg.warnRatio) {
    next.compactionDrop = false
  }
  if (ratio < cfg.warnRatio) return { state: next, signal: null }

  const level: GuardLevel = ratio >= cfg.hardRatio ? 'hard' : 'warn'
  if (!next.armed) {
    next.armed = true
    next.level = level
    next.cooldown = Math.max(0, cfg.cooldownTurns)
    const suppressed = cfg.respectCompaction && options.atTurnBoundary === true && options.justCompacted === true
    if (suppressed) return { state: next, signal: null }
    return { state: next, signal: signalOf('enter', level, next) }
  }
  if (LEVEL_RANK[level] > LEVEL_RANK[wasLevel]) {
    next.level = level
    return { state: next, signal: signalOf('escalate', level, next) }
  }
  next.level = LEVEL_RANK[level] > LEVEL_RANK[wasLevel] ? level : wasLevel
  return { state: next, signal: null }
}

function signalOf(kind: PressureSignal['kind'], level: GuardLevel, state: GuardState): PressureSignal {
  return {
    kind,
    level,
    ratio: state.occupancy?.ratio ?? null,
    projectedTokens: state.occupancy?.projectedTokens ?? null,
    contextWindow: state.occupancy?.contextWindow ?? null,
    turn: state.turn,
    compactionDrop: state.compactionDrop,
  }
}

/** 一轮结束：判定与提示只在轮末，绝不 mid-turn（那轮已经发出去了）。 */
export function nextTurn(state: GuardState): GuardState {
  return { ...state, turn: state.turn + 1, cooldown: Math.max(0, state.cooldown - 1), compactionDrop: false }
}

export function inCooldown(state: GuardState): boolean {
  return state.cooldown > 0
}

/** 路由或目标模型变化时清空武装：旧窗口的迟滞对新窗口没有意义。 */
export function resetArming(state: GuardState): GuardState {
  return { ...state, armed: false, level: 'none', cooldown: 0 }
}

/**
 * 每会话日志水位。
 *
 * `session/event` 每次持久追加都会触发；同一日志位置不能评估两次
 * （移植自 dsh-auto-handoff 的 `TokenTracker`，MIT）。
 */
export class SessionWatermark {
  private readonly marks = new Map<string, number>()

  observe(sessionId: string, seq: number): boolean {
    const previous = this.marks.get(sessionId)
    if (previous !== undefined && seq <= previous) return false
    this.marks.set(sessionId, seq)
    return true
  }

  watermark(sessionId: string): number {
    return this.marks.get(sessionId) ?? -1
  }

  reset(sessionId: string): void {
    this.marks.delete(sessionId)
  }

  clear(): void {
    this.marks.clear()
  }

  get size(): number {
    return this.marks.size
  }
}

export type RotationDecision =
  | { readonly kind: 'rotate'; readonly reason: 'pressure-boundary' }
  | { readonly kind: 'observe'; readonly reason: string }
  | { readonly kind: 'none'; readonly reason: string }

/**
 * "等待重算交接包"这个出口的机器可读标记（§10.2、§23.2 第 1 条）。
 * 词表沿用既有 `observe`：既不是"继续换"（rotate），也不是"这条线不需要换"（none），
 * 而是"该换，但手上这份材料已经不代表当前依据，先重算再放行"。
 */
export const AWAIT_BRIEF_RECOMPUTE = 'await-brief-recompute'

export interface RotationGateInput {
  readonly occupancy: Occupancy
  readonly line: RotationLine
  readonly guard: GuardState
  readonly actorRetired: boolean
  readonly pendingRotation: boolean
  readonly rotationBudgetLeft: boolean
  readonly turnsSinceLastRotation: number
  readonly minTurnsBetweenRotations: number
  readonly autoRotationEnabled: boolean
  readonly atSafeBoundary: boolean
  /**
   * 依据/规则版本在请求轮换之后被改动，尚未重算出可用的交接包（`fsm.revisionDrifts` 的结论）。
   * 做成可选字段是为了不改既有调用方的签名；缺省即"没有在等的重算"。
   */
  readonly awaitingBriefRecompute?: boolean
  /**
   * 调用方判定当前 Actor 是**原生 Agent Team 的 Lead**（§G1）：原生 Team 身份迁移协议
   * 未经真机验证前，自动轮换不得让 Lead 失去团队身份——原生 `roster.tryMembership` 以根会话
   * 组织 Team（dsh: `packages/experimental/agent-team/src/roster.ts:92-117`），新会话不会继承
   * 旧 Team，轮换应当明确受限、优先原会话压缩。做成可选字段是为了不改既有调用方的签名
   * （照 `awaitingBriefRecompute` 的既有先例）；缺省即"调用方没有表明这是 Lead"。
   */
  readonly leadProtected?: boolean
  readonly config: GuardConfig
}

/**
 * 轮换入场判定。返回**机器可读的原因**，每条都可断言。
 *
 * 顺序即优先级：退役 / 无数据 / 未启用 / 线不可用 先于一切业务判断；
 * 未结束轮换与待重算交接包、频率保险先于迟滞与冷却；
 * 边界条件最后检查——前面每一道都放行时才轮到它排队，否则排队没有意义。
 */
export function decideRotation(input: RotationGateInput): RotationDecision {
  if (input.actorRetired) return { kind: 'none', reason: 'actor-retired' }
  if (!input.occupancy.known || input.occupancy.ratio === null) return { kind: 'observe', reason: 'reading-unavailable' }
  if (!input.autoRotationEnabled) return { kind: 'none', reason: 'auto-rotation-disabled' }
  if (input.line.mode !== 'active') {
    return { kind: 'observe', reason: `rotation-line-${input.line.mode}:${input.line.reason ?? 'unknown'}` }
  }
  if (input.pendingRotation) return { kind: 'none', reason: 'rotation-in-flight' }
  // §23.2 第 1 条：撤回与轮换交错时旧摘要不能恢复已撤回结论，重算之前不再起新一轮。
  if (input.awaitingBriefRecompute === true) return { kind: 'observe', reason: AWAIT_BRIEF_RECOMPUTE }
  // §G1：这是"观测/拦截"而不是"不需要换"——压力依据可能成立，但原生 Team Lead 的自动轮换
  // 在身份迁移协议经真机验证前受限，优先原会话压缩（observe 留给状态页一个可读的原因）。
  if (input.leadProtected === true) return { kind: 'observe', reason: 'lead-rotation-restricted: 原生 Team Lead 的自动轮换在身份迁移协议经真机验证前受限，优先原会话压缩（§G1）' }
  if (!input.rotationBudgetLeft) return { kind: 'none', reason: 'rotation-insurance-exhausted' }
  if (input.turnsSinceLastRotation < input.minTurnsBetweenRotations) {
    return { kind: 'none', reason: `cooldown-${input.turnsSinceLastRotation}/${input.minTurnsBetweenRotations}` }
  }
  const ratio = input.occupancy.ratio
  const absoluteDue = ratio >= input.line.T / input.line.window
  const guardDue = ratio >= input.config.hardRatio
  if (!absoluteDue && !guardDue) return { kind: 'none', reason: `below-threshold-${(ratio * 100).toFixed(1)}%` }
  if (!input.atSafeBoundary) return { kind: 'none', reason: 'pending-until-boundary' }
  return { kind: 'rotate', reason: 'pressure-boundary' }
}

/** 新会话入场占用必须低于阈值一半，否则判为上下文配置问题而不是继续换会话。 */
export function targetTooLarge(targetOccupancy: Occupancy, line: RotationLine): boolean {
  if (line.mode !== 'active') return false
  if (!targetOccupancy.known || targetOccupancy.ratio === null) return false
  return targetOccupancy.ratio * line.window >= line.T * 0.5
}
