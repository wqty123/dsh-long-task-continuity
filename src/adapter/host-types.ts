/**
 * 宿主运行时的**结构化视图**（不 import 任何 `@deepseek-ai/*`）。
 *
 * 为什么这么写：本包在装载进 DSH 之前必须能独立编译与测试，而内核判定不该依赖宿主类型。
 * 这些视图刻意只声明用到的成员（照 `qingyou002/dsh-auto-handoff` 的 `Raw*` 窄视图做法），
 * 真机上传入真实 `ctx` 即可结构匹配；装载时要逐项核对 `capabilities.ts` 的探针结论。
 *
 * ⚠️ 结构一致 ≠ 语义一致。签名口径来自本机 `D:\deepseek-harness` @ v0.2.1-alpha.1 的源码摘录，
 * 未在运行时组合与故障注入下验证过。
 */

export interface SessionIdLike {
  readonly value: string
}

export interface PromptContentPart {
  readonly type: 'text'
  readonly text: string
}

export interface MessageSource {
  readonly kind: string
  readonly rpcId?: string
  readonly [key: string]: unknown
}

export interface UserMessageLike {
  readonly role: 'user'
  readonly content: readonly PromptContentPart[]
  readonly source?: MessageSource
}

export interface SessionCreateRequest {
  readonly workspaceId?: string
  readonly cwd?: string
  readonly sessionId?: string
  readonly agentPreset?: string
}

export interface SessionCreateValue {
  readonly sessionId: string
  readonly agentPreset?: string
}

export interface AgentLike {
  readonly id?: string
  followup(message: UserMessageLike): unknown
  whenIdle(): Promise<void>
  steer?(reason?: string): void
  cancel?(reason?: string): unknown
  readonly session: SessionHandle
  readonly ctx?: unknown
}

export interface SessionHandle {
  /** 当前路由与窗口；`config` 里含压缩口径（具体字段以探针为准）。 */
  requestHeader?(): { readonly config?: Record<string, unknown> } | undefined
  readonly id?: string
  /**
   * 持久头部（`packages/core/session/src/types.ts:94`）：`cwd` 是绝对工作目录、
   * `agentPreset` 是组合来源。轮换必须按这两个值校验 S2，不能拿 `process.cwd()` 代替。
   */
  readonly header?: { readonly cwd?: string; readonly agentPreset?: string; readonly parentSession?: string }
}

export interface ResolvedAgent {
  readonly agent?: AgentLike
  readonly error?: { readonly code?: string; readonly message?: string }
}

export interface SessionControllerLike {
  create(request: SessionCreateRequest): Promise<SessionCreateValue>
  resolveAgent(sessionId: string): Promise<ResolvedAgent>
  /**
   * 真机契约（`packages/api/session-controller/src/types.ts:471-548`、`src/history.ts:77-111`）：
   * `throughSeq` 必填（-1 = 开放到最新），`beforeSeq` 是**向后**翻页游标（取该 seq 之前的记录），
   * 返回 `{ records, hasMore }`；`hasMore:false` 才代表已扫到日志起点（`src/history.ts:426` 的 `cut > 0`），
   * 每条记录形如 `{ type: 'event', event: { seq, … } }`，`seq` 是密集零起的日志偏移。
   */
  page?(request: Record<string, unknown>, signal?: AbortSignal): Promise<{ readonly records?: readonly unknown[]; readonly hasMore?: boolean }>
}

export interface TokenMeterLike {
  measure(session: unknown): { readonly totalTokens: number } | undefined
}

/**
 * `contextPressure` 的**状态**形状。
 *
 * 关键口径（`packages/llm/token-meter/src/usage-projection.ts:96`）：宿主内
 * `sessionProjections.stateOf(session, 'contextPressure')` 返回的是 state，
 * 里面**没有** `projectedTokens`；那个数字是 wire 边界现算的
 * （`max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)`）。
 * 因此适配层必须自己按同一公式折算，不能假定 host 面给得出投影视图。
 * 另注：官方 README 明确这三个字段是 last-wins、不是原子观测、"not a gating input"，
 * 所以 `lines.ts` 的 `readOccupancy` 保持缺分母即不判定。
 */
export interface ContextPressureStateLike {
  readonly contextWindow?: number
  readonly pressureTokens?: number
  readonly surfaceTokens?: number
  readonly sampledSurfaceTokens?: number
}

/** 折算后的占用视图：与 `ContextPressureProjection`（wire 面）同名同义。 */
export interface ContextPressureProjection {
  readonly projectedTokens?: number
  readonly pressureTokens?: number
  readonly contextWindow?: number
}

export interface ProjectionRegistryLike {
  /** 第一个参数是 Session 对象，不是 sessionId。 */
  stateOf(session: unknown, name: string): unknown
  onChanged?(listener: (session: unknown, projection: unknown) => void): (() => void) | void
}

/** `sessions` 服务用到的两个成员（`packages/core/session/src/index.ts:1190/1223`）。 */
export interface SessionsLike {
  /** 真机签名收 `SessionId`（品牌化 string）；本包按值传递，严格类型装载时需用工厂包一层。 */
  get(id: string): unknown
  flush(session: unknown): Promise<boolean>
}

export interface GuardOutcome {
  readonly deny?: string
}

/**
 * `ToolGuard` 的真实签名（`core/tools/src/index.ts:731`）：同步、只返回拒绝理由字符串。
 * 执行体上有 `name`/`arguments`/`agent`，**没有** actorId —— 身份必须由适配层从
 * `execution.agent.id`（= sessionId）映射到绑定的 Actor。
 */
export interface ToolExecutionLike {
  readonly name: string
  readonly arguments?: unknown
  readonly agent?: { readonly id?: unknown }
}

export type ToolGuardLike = (execution: Readonly<ToolExecutionLike>) => string | undefined | GuardOutcome

export interface ToolsFacadeLike {
  guard(guard: ToolGuardLike): () => void
  register(definition: unknown): () => void
}

export interface GoalsLike {
  create(agent: AgentLike, options: { readonly objective: string }): unknown
  disarm?(agent: AgentLike): unknown
}

export interface SubagentServiceLike {
  start?(request: Record<string, unknown>): Promise<unknown>
  startContinuable?(request: Record<string, unknown>): Promise<unknown>
}

export interface ScheduleEntryLike {
  readonly id: string
  readonly sessionId: string
  readonly address?: unknown
}

export interface ScheduleServiceLike {
  list?(): readonly ScheduleEntryLike[] | Promise<readonly ScheduleEntryLike[]>
  update?(id: string, patch: Record<string, unknown>): unknown
  remove?(id: string): unknown
}

export interface SessionTitleLike {
  rename(session: unknown, title: string): void
}

/** `storageDomain` 的最小面：`open` 是 async 且失败一律 throw。 */
export interface StorageDomainLike {
  open<S>(spec: S): Promise<DomainHandle>
}

export interface DomainHandle {
  table(name: string): {
    get(key: string): unknown
    put(key: string, value: unknown): Promise<void>
    update(key: string, fn: (current: never) => never): Promise<never>
    entries(): IterableIterator<[string, unknown]>
  }
  global: { get(): unknown; set(value: unknown): Promise<void> }
  close(): Promise<void>
}

/**
 * `agents` 服务的最小面（`packages/core/agent/src/index.ts:566/586`）：
 * 按 sessionId 取活体 Agent，取不到即"该会话当前没有执行体"。
 */
export interface AgentsLike {
  get(id: string): AgentLike | undefined
  list(): AgentLike[]
}

/**
 * `connection` 的最小面（`packages/client/connection/src/rpc.ts:137-163`、
 * `rpc-host.ts:96-101,152-169`）：只用精确 GET Fetch 路由这一种读取通道。
 * 注册体按读取方 fiber 绑定生命周期，插件卸载即摘除。
 */
export interface ConnectionFetchRouteLike {
  /** `/api` 下的绝对路径；查询参数仍在 request URL 上可读。 */
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
}

export interface ConnectionLike {
  readonly fetch: { register(route: ConnectionFetchRouteLike): () => Promise<void> }
}

/** 本插件用到的宿主切片；真实 `ctx` 只需结构兼容这几个成员。 */
export interface HostSlice {
  readonly sessionController?: SessionControllerLike
  readonly tokenMeter?: TokenMeterLike
  readonly sessionProjections?: ProjectionRegistryLike
  readonly sessions?: SessionsLike
  readonly goals?: GoalsLike
  readonly subagents?: SubagentServiceLike
  readonly schedule?: ScheduleServiceLike
  readonly sessionTitle?: SessionTitleLike
  readonly storageDomain?: StorageDomainLike
  /** 全局工具面：`guard()` 用于准入守卫，`register()` 用于模型可见工具。 */
  readonly tools?: ToolsFacadeLike
  readonly agentDefaultModel?: { currentSelection?(): unknown }
  readonly logger?: (name: string) => { info(msg: string): void; warn(msg: string): void; error(msg: string): void; debug?(msg: string): void }
}

export function agentTools(agent: AgentLike): ToolsFacadeLike | undefined {
  const ctx = agent.ctx as { readonly tools?: ToolsFacadeLike } | undefined
  return ctx?.tools
}
