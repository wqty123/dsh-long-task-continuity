/**
 * 真机压缩端口（设计稿 v0.5 §27.5 第 3、4 条）：把宿主 `ctx.compaction` 收窄成
 * `adapter/dsh-context.ts:1405-1407` 定义的 `CompactionPort`，供 `invokeCompaction` 调用。
 *
 * 三条**按上游源码核实**的硬事实（本文件不 import 任何 `@deepseek-ai/*`：一律结构化读取，
 * 读不到即 `undefined`——未知 ≠ 成功，也不许拿它当"压缩过"）：
 * 1. `compactNow(agent, signal, sourceCommandId?)` 要求 agent 是 `ManualCompactAgentContext`
 *    ——必须携带 `runMaintenance`（compaction src/index.ts:77-88），并会**返回 null** 表示
 *    "没有可安全压缩的有用区间"（同文件 :162-171）。null 不是成功也不是失败，映射成 `refused`
 *    （§27.5 第 3 条：不假装已压缩）。
 * 2. 预期失败按 `ManualCompactionError.code` 抛出，取值
 *    `busy|cancelled|changed|summary|commit|persistence`（同文件 :48-64）：
 *    busy = 入口被占 / agent 不空闲、changed = 选中区间或版本已变、cancelled = 会话侧取消。
 *    三者都要有**明确结果**：busy/changed 只给结论、禁忙循环重试；cancelled 按失败处理并点名。
 * 3. 成功返回 `CompactionResult`：`summary: ContentBlock[]`、`shadowedTokenCount` 是估算回收量、
 *    `shadowedSeqs/startSeq/endSeq/summarySeq/compactionId` 是账目（compaction src/types.ts:94-120）。
 *    本端口只把摘要文本与回收量带回；"是否真的恢复"由 `verifyPostCompaction` 按观测另判
 *    （§27.5 第 4 条：completed 只代表调用返回）。
 *
 * 手动命令入口的调用样例见 compaction/command-compact/src/index.ts:67（agent/signal/commandId 三件）；
 * 本插件没有对应用户命令身份，因此**不传** `sourceCommandId`。
 */
import type { CompactionCallResult, CompactionPort } from './dsh-context.ts'

/**
 * 宿主压缩引擎的窄口径：只认 `compactNow` 一个方法，参数形状由结构化读取兜住，
 * 因此本文件不需要（也不允许）把宿主内部类型带进来。
 */
export interface CompactionEngineLike {
  compactNow(agent: unknown, signal: AbortSignal, sourceCommandId?: unknown): Promise<unknown>
}

export interface MappedCompactionError {
  readonly status: 'busy' | 'changed' | 'error'
  readonly detail: string
}

/**
 * 预期失败 → 压缩状态（§27.5 第 3 条：busy/changed 按实际状态核对，禁止忙循环重试）。
 *
 * `cancelled` 与其余 code 一样落 `error`，但明细里必须点名 cancelled：
 * "任务被取消"要有明确结果，不能被记成一次成功压缩。`detail` 一律带上 code 与原始 message，
 * 读不到 code 时带上错误名——判据可以缺，事实不许编。
 */
export function mapCompactionError(error: unknown): MappedCompactionError {
  const code = fieldString(error, 'code')
  const text = errorText(error)
  if (code === 'busy') {
    return { status: 'busy', detail: `压缩入口被占用（code=busy）：${text}；按实际状态核对，禁止忙循环重试（§27.5 第 3 条）` }
  }
  if (code === 'changed') {
    return { status: 'changed', detail: `会话版本或选中区间已变化（code=changed）：${text}；旧评估不再适用，先重新检查（§27.5 第 2、3 条）` }
  }
  if (code === 'cancelled') {
    return { status: 'error', detail: `压缩被取消（code=cancelled）：${text}；按失败处理，不记成功（§27.5 第 3 条）` }
  }
  if (code !== undefined) return { status: 'error', detail: `压缩失败（code=${code}）：${text}` }
  return { status: 'error', detail: `压缩抛错（${errorLabel(error)}，未携带可识别的 ManualCompactionError code）：${text}` }
}

/**
 * 把真机引擎包成 `CompactionPort`（§27.5 第 3、4 条）。
 *
 * 三条刻意的选择：
 * 1. **agent 入口先核形状**：`compactNow` 的第一个参数必须是带 `runMaintenance` 的维护上下文；
 *    拿不到就不调用（不静默调用无效入口），直接给 `error` 并写明原因。
 * 2. **并发即 busy**：互斥入口同一时刻只允许一次调用；上一次未返回就再进，
 *    不并发调用引擎（也避免把"两次压缩"记成一次）。
 * 3. **信号由本端口自己发**：引擎要求 `AbortSignal`，我们把内部 `AbortController` 的 signal 交给它；
 *    本端口没有对外取消面，因此会话侧取消（`code=cancelled`）是唯一会真正到达的取消形态。
 */
export function compactionPort(engine: CompactionEngineLike, agent: unknown): CompactionPort {
  let inflight: AbortController | undefined
  return {
    async compactNow(session: unknown): Promise<CompactionCallResult> {
      if (!hasMaintenance(agent)) {
        return {
          status: 'error',
          detail:
            'agent 缺少可读的 runMaintenance：不满足 ManualCompactAgentContext（compaction src/index.ts:77-88），拒绝调用无效入口；' +
            '本次压缩未发生，按未执行处理（§27.5 第 3 条）',
        }
      }
      if (inflight !== undefined) {
        return { status: 'busy', detail: '上一次压缩调用尚未返回：互斥入口不并发调用（§27.5 第 3 条）' }
      }
      const target = sessionOf(agent, session)
      if (target.error !== undefined) return { status: 'error', detail: target.error }
      const controller = new AbortController()
      inflight = controller
      try {
        const raw = await engine.compactNow(agent, controller.signal)
        if (raw === null) return { status: 'refused', detail: '引擎报告没有可安全压缩的区间（compactNow 返回 null）' }
        if (raw === undefined) {
          return { status: 'error', detail: 'compactNow 返回 undefined：读不出压缩结果，按失败处理（未知 ≠ 成功，§27.5 第 4 条）' }
        }
        const summary = readCompactionSummary(raw)
        const reclaimed = fieldNumber(raw, 'shadowedTokenCount')
        const shadowed = arrayLength(raw, 'shadowedSeqs')
        if (summary === undefined && reclaimed === undefined && shadowed === undefined) {
          return {
            status: 'error',
            detail:
              'compactNow 返回的对象读不出 CompactionResult 的任何可核对面（summary/shadowedTokenCount/shadowedSeqs 全缺）：' +
              '按失败处理，未知 ≠ 成功（§27.5 第 4 条）',
          }
        }
        return {
          status: 'completed',
          detail: completionDetail(summary, shadowed, reclaimed),
          ...(reclaimed === undefined ? {} : { reclaimedTokens: reclaimed }),
        }
      } catch (error) {
        return mapCompactionError(error)
      } finally {
        if (inflight === controller) inflight = undefined
      }
    },
  }
}

/**
 * `CompactionResult.summary` 的文本面（`ContentBlock[]` 里所有可读的 `text`）；
 * 读不到就返回 `undefined`——摘要文本缺失不能让调用被记成"完成且内容已在"。
 */
export function readCompactionSummary(result: unknown): string | undefined {
  const blocks = fieldArray(result, 'summary')
  if (blocks === undefined) return undefined
  const texts: string[] = []
  for (const block of blocks) {
    const text = fieldString(block, 'text')
    if (text !== undefined) texts.push(text)
  }
  return texts.length === 0 ? undefined : texts.join('\n')
}

/** 交付回执的明细：摘要文本优先；文本读不到时如实说明"调用已发生、成效未核对"。 */
function completionDetail(summary: string | undefined, shadowed: number | undefined, reclaimed: number | undefined): string {
  const accounting: string[] = []
  if (shadowed !== undefined) accounting.push(`shadowedSeqs ${shadowed} 条`)
  if (reclaimed !== undefined) accounting.push(`估算回收 ~${reclaimed} token`)
  const tail = accounting.length === 0 ? '' : `（${accounting.join('，')}）`
  if (summary === undefined) {
    return `compactNow 返回完成，但摘要文本读不到：按"调用已发生、成效未核对"处理${tail}；随后必须走压缩后核对，不得直接记 done（§27.5 第 4 条）`
  }
  return `摘要：${summary}${tail}`
}

/**
 * 压缩目标核对（§27.5 第 3 条）：引擎只会压 `agent` 自己绑定的那个会话，所以必须先确认
 * 它就是做评估的那个会话，否则一次"压缩"会打到别的会话上去。
 *
 * 身份口径按真机：公开类型 `Agent` 只有 `readonly id: SessionId`
 * （dsh: `packages/core/agent/src/types.ts:15-19`，另见 `tool-cordis/src/api-catalog.ts:4485` 的同形声明），
 * 运行时面再用声明合并补上 `session`/`inbox`/`status`（dsh: `packages/core/agent/src/runtime-types.ts:164-172`），
 * 所以这里依次尝试 `agent.id` → `agent.sessionId` → `agent.session.id`，取第一个读得出的身份。
 * 旧写法**只**读 `agent.session.id`：拿不到就是 `undefined`，而函数把 `undefined` 当"跳过核对"放行，
 * 等于这条守卫从来没生效过（fail-open）。现在任一侧读不出都拒绝调用（无法核对目标 = 不压；未知 ≠ 可以压）。
 */
function sessionOf(agent: unknown, session: unknown): { readonly error?: string } {
  const agentSession = agentIdentity(agent)
  const observed = sessionIdentity(session)
  if (agentSession === undefined) {
    return { error: '读不出 agent 绑定的会话身份（id / sessionId / session.id 三格都空）：无法核对压缩目标，本次压缩未发生（§27.5 第 3 条）' }
  }
  if (observed === undefined) {
    return { error: `读不出观测会话身份：无法核对压缩目标（agent 绑定 ${agentSession}），本次压缩未发生（§27.5 第 3 条）` }
  }
  if (agentSession === observed) return {}
  return { error: `agent 绑定会话 ${agentSession} 与观测会话 ${observed} 不一致：拒绝把压缩打到别的会话上` }
}

/** agent 侧的会话身份：真机是 `agent.id`，另外容忍 `sessionId` 与旧的 `session.id` 形状。 */
function agentIdentity(agent: unknown): string | undefined {
  const self = sessionIdentity(agent)
  if (self !== undefined) return self
  return sessionIdentity(agentField(agent, 'session'))
}

function sessionIdentity(value: unknown): string | undefined {
  const direct = fieldString(value, 'id')
  if (direct !== undefined) return direct
  return fieldString(value, 'sessionId')
}

function agentField(agent: unknown, key: string): unknown {
  const record = asObject(agent)
  return record === undefined ? undefined : record[key]
}

function hasMaintenance(agent: unknown): boolean {
  const record = asObject(agent)
  return record !== undefined && typeof record['runMaintenance'] === 'function'
}

// —— 结构化读取（读不到即 undefined；未知绝不回退成 0/空/成功） ——

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function fieldString(value: unknown, key: string): string | undefined {
  const record = asObject(value)
  if (record === undefined) return undefined
  const field = record[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function fieldNumber(value: unknown, key: string): number | undefined {
  const record = asObject(value)
  if (record === undefined) return undefined
  const field = record[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

function fieldArray(value: unknown, key: string): readonly unknown[] | undefined {
  const record = asObject(value)
  if (record === undefined) return undefined
  const field = record[key]
  return Array.isArray(field) ? field : undefined
}

/** 数组形态读得出就给长度：`CompactionResult.shadowedSeqs` 存在即是可核对的账目。 */
function arrayLength(value: unknown, key: string): number | undefined {
  return fieldArray(value, key)?.length
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  const message = fieldString(error, 'message')
  if (message !== undefined) return message
  return typeof error === 'string' && error.length > 0 ? error : '非 Error 抛出物（读不出 message）'
}

function errorLabel(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name
  return fieldString(error, 'name') ?? 'unknown-error'
}
