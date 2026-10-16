/**
 * 交接包的事实采集（设计稿 v0.3 §9.1、§9.3 的输入面）。
 *
 * 两条真机限制决定了这里的形状，不是风格选择：
 * 1. 宿主同步读会话事件的方式（`Session.eventAt` / `snapshotEvents` / `ownEvents`，
 *    `packages/core/session/src/index.ts:631/645/662`）在 v0.2.1-alpha.1 全部标了
 *    deprecated 且注释写明 "new calls are prohibited"。所以"改过哪些文件"只能来自本插件
 *    **装载之后**订阅 `session/event` 观察到的工具生命周期：native 模式是
 *    `tool/call` + `tool/result`，Code-Mode（`tools.mode: ptc`）是
 *    `tool/ptc-dispatch-start` + `tool/ptc-dispatch`（`packages/core/tools/src/ptc.ts:587-600`）。
 *    只订阅前一对会在 PTC 下把"没观测到"读成"没有工具在跑"，正是 §27.1 禁止的误读。
 *    装载之前的历史不凭空补，覆盖范围由 `inheritedNote` 如实写进交接包。
 * 2. 未收到 result 的调用一律按"未完成"记（`ok: false`）：`collectFileChanges` 只认成功调用，
 *    因此宁可漏报一个文件，也不把没做完的改动写成新会话的事实。
 */
import type { BriefFacts, ToolCallEvent } from './brief.ts'
import { collectFileChanges } from './brief.ts'
import type { MissionControl } from '../core/control.ts'

/** 宿主 `SessionEvent` 的结构视图：只用 `type`/`seq`/`data` 三个成员。 */
export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

interface CallRecord {
  readonly seq: number
  readonly callId: string
  readonly tool: string
  readonly argumentsJson: string
  /** 收到 `tool/result` 或 `tool/ptc-dispatch` 且 `isError` 不为真才算成功。 */
  ok: boolean
  settled: boolean
}

/**
 * 参数文本：native 的 `tool/call` 带模型原文字符串（`agent-loop/src/tool-calls.ts:264` 直接放
 * `block.arguments`），Code-Mode 的 `tool/ptc-dispatch` 带**已解析对象**（`tools/src/ptc.ts:197`
 * 的 `snapshotJsonValue` 兄弟副本）。按字符串取值会让子调用一律记成空参数，`collectFileChanges`
 * 就再也取不到 `path`——所以两条形态各走各的，不做"看着像就行"的合并。
 */
function argumentsToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || typeof value !== 'object') return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function pushCall(rows: CallRecord[], row: CallRecord, maxPerSession: number): void {
  rows.push(row)
  if (rows.length > maxPerSession) rows.splice(0, rows.length - maxPerSession)
}

/** 每会话的工具调用环形缓冲；装载后开始累积，会话消失即清除。 */
export class ToolEventLedger {
  private readonly calls: Map<string, CallRecord[]>
  private readonly maxPerSession: number

  constructor(maxPerSession = 500) {
    this.calls = new Map()
    this.maxPerSession = maxPerSession
  }

  /**
   * 观察一条会话事件。
   * @param sessionId - 事件所属会话。
   * @param event - 会话事件（`tool/call`、`tool/result`，以及 Code-Mode 的
   *   `tool/ptc-dispatch-start`、`tool/ptc-dispatch` 会被记录）。
   * @returns 是否消费了该事件（用于诊断，不作为判定输入）。
   */
  observe(sessionId: string, event: SessionEventLike): boolean {
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      const data = event.data as { readonly callId?: unknown; readonly subCallId?: unknown; readonly name?: unknown; readonly arguments?: unknown }
      const callId = typeof data.callId === 'string' ? data.callId : typeof data.subCallId === 'string' ? data.subCallId : ''
      const name = typeof data.name === 'string' ? data.name : ''
      if (callId.length === 0 || name.length === 0) return false
      const rows = this.calls.get(sessionId) ?? []
      pushCall(rows, { seq: event.seq, callId, tool: name, argumentsJson: argumentsToText(data.arguments), ok: false, settled: false }, this.maxPerSession)
      this.calls.set(sessionId, rows)
      return true
    }
    if (event.type === 'tool/result') {
      const data = event.data as { readonly message?: { readonly toolCallId?: unknown; readonly isError?: unknown } }
      const callId = typeof data.message?.toolCallId === 'string' ? data.message.toolCallId : ''
      const rows = this.calls.get(sessionId) ?? []
      const record = rows.find((item) => item.callId === callId && !item.settled)
      if (record === undefined) return false
      record.settled = true
      record.ok = data.message?.isError !== true
      return true
    }
    if (event.type === 'tool/ptc-dispatch') {
      const data = event.data as { readonly subCallId?: unknown; readonly name?: unknown; readonly arguments?: unknown; readonly isError?: unknown }
      const callId = typeof data.subCallId === 'string' ? data.subCallId : ''
      if (callId.length === 0) return false
      const rows = this.calls.get(sessionId) ?? []
      const record = rows.find((item) => item.callId === callId && !item.settled)
      // 没对上 start 也要记：订阅可能落在程序执行中途，或环形缓冲把 start 剪掉了。
      // 与宿主呈现子调用的做法一致（`ui-chat/src/client/conversation-nodes/tool.ts:212-220`
      // 在 `index < 0` 时直接插入已结算行），否则会退化成"这个子调用从未发生"。
      if (record === undefined) {
        const name = typeof data.name === 'string' ? data.name : ''
        if (name.length === 0) return false
        pushCall(rows, { seq: event.seq, callId, tool: name, argumentsJson: argumentsToText(data.arguments), ok: data.isError !== true, settled: true }, this.maxPerSession)
        this.calls.set(sessionId, rows)
        return true
      }
      record.settled = true
      record.ok = data.isError !== true
      return true
    }
    return false
  }

  /** 已观察到的调用，按 seq 升序；`ok` 只在对到了非错误 result 后才为真。 */
  changes(sessionId: string): (ToolCallEvent & { seq: number })[] {
    return (this.calls.get(sessionId) ?? []).map((record) => ({ seq: record.seq, tool: record.tool, argumentsJson: record.argumentsJson, ok: record.ok }))
  }

  /** 缓冲覆盖到的最早 seq；没有观察记录即 `undefined`。 */
  observedFrom(sessionId: string): number | undefined {
    const rows = this.calls.get(sessionId)
    if (rows === undefined || rows.length === 0) return undefined
    return rows[0]?.seq
  }

  /**
   * 是否有已观察到、但还没对上 result 的工具调用。
   *
   * 这是"受管工具仍在执行"的可证据化版本：只回答本插件见过的调用，
   * 没见过不等于没发生，因此调用方在**装载后无事件**时要把未知当 `null` 交出去。
   */
  hasUnsettled(sessionId: string): boolean | null {
    const rows = this.calls.get(sessionId)
    if (rows === undefined || rows.length === 0) return null
    return rows.some((record) => !record.settled)
  }

  /** 最近一次观察到的调用，用于"当前状态"段落；无即如实说明。 */
  lastCallSummary(sessionId: string): string {
    const rows = this.calls.get(sessionId) ?? []
    const last = rows[rows.length - 1]
    if (last === undefined) return '本插件装载后未观察到工具调用'
    return `最近一次工具调用 ${last.tool}（seq ${last.seq}，${last.settled ? (last.ok ? '已正常返回' : '返回报错') : '未见结果记录'}）`
  }

  /**
   * 观察到的 `run_code` 程序次数（Code-Mode 下模型发起的调用基本都是它）。
   *
   * 这个数字改变的是清单的**解释**：程序可以 `await import('node:fs')` 直接读写文件
   * （`packages/ptc-runtime/ptc-runtime-node/src/index.ts:67-70`），这类改动既不经工具生命周期，
   * 也不进 dsh-context 的 `fileOps`（`lib/index.d.ts:334-336` 只从 `tool/call`+`tool/result`
   * 或嵌套 `tool/ptc-dispatch` 折）。所以有程序执行时，改动清单必须带上"程序内直接写文件不在
   * 此列"的声明，而不是让新会话把清单当成全集（§27.1：覆盖口径要如实，不合并成"没有异常"）。
   */
  programCalls(sessionId: string): number {
    return (this.calls.get(sessionId) ?? []).filter((record) => record.tool === 'run_code').length
  }

  forget(sessionId: string): void {
    this.calls.delete(sessionId)
  }

  clear(): void {
    this.calls.clear()
  }

  get size(): number {
    return this.calls.size
  }
}

export interface FactsInput {
  readonly state: MissionControl
  readonly ledger: ToolEventLedger
  readonly sessionId: string
  /** 路由标识：模型名 + 推理档；来源以 `capabilities.ts` 的探针结论为准。 */
  readonly route: string
  readonly mode: string
  readonly permission: string
  readonly compacted: boolean
}

/**
 * 把控制记录与会话观察合成 `assembleBrief` 需要的事实层。
 *
 * 只写有证据的东西：文件清单来自已结算的写入型工具调用，失败清单来自已提交的操作状态，
 * 覆盖范围不足时以 `inheritedNote` 声明，而不是让新会话以为拿到了完整历史。
 */
export function factsFromLedger(input: FactsInput): BriefFacts {
  const { state, ledger, sessionId } = input
  const events = ledger.changes(sessionId)
  const fileChanges = collectFileChanges(events)
  const failures = [
    ...Object.values(state.operations)
      .filter((operation) => operation.status === 'failed' || operation.status === 'outcome_unknown')
      .map((operation) => `操作 ${operation.kind} → ${operation.target}：${operation.status}`),
    ...Object.values(state.rotations)
      .filter((rotation) => rotation.phase === 'WAITING_RECOVERY')
      .map((rotation) => `轮换 ${rotation.rotationId} 停在 WAITING_RECOVERY：${rotation.nextReconcileAction ?? '未给核对动作'}`),
  ]
  const from = ledger.observedFrom(sessionId)
  return {
    fileChanges,
    lastStepSummary: ledger.lastCallSummary(sessionId),
    failures,
    route: input.route,
    mode: input.mode,
    permission: input.permission,
    compacted: input.compacted,
    // §9.1：版本与失效依据能从记录确定性读出就填上；读不出的（如票据对当前时刻
    // 是否有效需要 now）留空，交给组装层从 state 直接判定，不在此编造。
    basisRevision: state.basisRevision,
    staleTickets: Object.values(state.dependencies)
      .filter((dependency) => dependency.reviewState === 'stale' || dependency.reviewState === 'invalidated')
      .map((dependency) => `${dependency.targetKind}:${dependency.targetId}=${dependency.reviewState}`),
    openChallenges: Object.values(state.challenges)
      .filter((challenge) => challenge.outcome === 'open')
      .map(
        (challenge) =>
          `${challenge.challengeId} 针对 ${challenge.targetKind} ${challenge.targetId}${challenge.targetRevision === undefined ? '' : `@${challenge.targetRevision}`}（${challenge.severity}）`,
      ),
    inheritedNote: (() => {
      const base =
        from === undefined
          ? '文件改动清单为空：本插件装载后该会话没有可核对的工具事件，更早的历史不在此凭空补。'
          : `文件改动清单覆盖本插件装载后自 seq ${from} 起的 ${events.length} 次工具调用（其中未收到结果的不计为改动）；更早的历史不在此凭空补。`
      const programs = ledger.programCalls(sessionId)
      if (programs === 0) return base
      return `${base}本会话还观察到 ${programs} 次 run_code 程序执行：程序内直接读写文件不经工具生命周期，也不在 dsh-context 的 fileOps 里，因此这部分改动不在本清单内，需要文件全集时以工作区自身（如 git 状态）为准。`
    })(),
  }
}
