/**
 * dsh-context 插件对接适配（设计稿 v0.5 §27.1、§27.2；闭环入口见 §27.5 第 3、4 条）。
 *
 * 适配层是**唯一允许对宿主产生副作用**的一层（与 `adapter/dsh.ts` 同规矩）；本文件只读投影、
 * 折算读数、收集信号，把结构化结果交给 `core/context-quality.ts` 判定——core 保持纯函数。
 *
 * 字段面（field face）逐个按**本机安装的 dsh-context 0.70.0** 核实：`lib/index.d.ts` 的声明 +
 * `lib/index.js` 的编译产物（下面引用的行号都取这两份文件，可复核）；上游没给得出的字段一律不代造，
 * 因为 §27.1 要求的"未加载 / 被截断 / 历史近似重建 / 真实空集合"四态必须都能表达，
 * 而 0.70.0 的值面只用其中一部分标记：
 * - `dsh-context` 0.70.0 与本包装在同一 web profile，通过宿主的 `sessionProjections` 注册
 *   `contextTimeline` / `contextHeaders` / `contextActivity` 三个投影（`lib/index.js:3641-3644`；
 *   三个键在 `lib/index.d.ts:143-157` 声明，注释写明 "key absence = the host half is not composed"）；
 * - 读**值**走公开面 `sessionProjections.snapshot(session, keys)`
 *   （`packages/session/session-projection/src/index.ts:338`，`values` 只含已注册且 `wire` 存在的键）；
 *   `stateOf`（同一文件 `:319`）拿的是 fold state（`lib/index.d.ts:42-139` 的 `TimelineState`），
 *   与投影响应值不是同一面，只作回退路径并如实标注；
 * - `contextTimeline` 给得出宿主自己不公开的 `contextWindow` 与 `maxOutputTokens`
 *   （`lib/index.js:771-772`；`lib/index.d.ts:254-257` 注明后者就是最近一次 `request/header` 的
 *   输出上限，即轮换线要的**输出预留 R**），这两条宿主直读面本包也直读（`readSessionEnvelope`）；
 * - H（压缩 headroom）与 r（触发比例）**没有**被 dsh-context 解决：它自己也是照抄
 *   `@deepseek-ai/dsh-compaction-basic` 的出厂默认 65536 / 0.8，而非读宿主
 *   （上游 `packages/compaction/compaction-basic/src/config.ts:75` 的 `config.headroomTokens ?? 65_536`
 *   与 `:20` 的 `DEFAULT_THRESHOLD_RATIO = 0.8`；本机安装的 0.70.0 里同一对常量可在
 *   `dsh-context/lib/client.js:14` 核对：`let Ct=65536` 与 `Math.floor(e*.8)`）。
 *   因此本包只在操作者显式打开 `acceptMirroredCompactionDefaults` 时才用这两个镜像值，
 *   来源一律标 `mirrored-default`；
 * - 读数的退化形态各有真实标记，绝不合并成"没有异常"。标记只可能来自这三处（本机 0.70.0 的编译产物）：
 *   `unsupported{current,minimum}` 即宿主低于上游基线（`lib/index.js:2938` 的 `BASELINE_DSH_VERSION =
 *   "0.1.7-rc.2"`），此时**三个投影一起**换成兜底单元，值全是零（`lib/index.js:3074-3103`、
 *   `:3633-3637`）；`detailRev` 在场即 `buildTimelineHead` 产的轻量头（`lib/index.js:847-877`，
 *   它的 requests/events/nodes/archive 恒为空占位、`droppedNodes` 恒为 0，见 `lib/index.js:788-792`）；
 *   被截断只看 `droppedNodes` > 0（`lib/index.js:817-827`，同一读数里上游必然也给 `surfaceFloor`）；
 *   历史近似重建只看 `archiveFloor`/`fileOpsFloor`（`lib/index.d.ts:305-309`）。
 *   0.70.0 的 `contextTimelineSchema` 是 `.strict()`（`lib/index.js:1755-1784`）：本机安装面只服得出上面
 *   这些真实字段。`heads`（别年代的"只有头"清单，接轻量头判据）与 `truncated`/`hasMore`/`reconstructed`
 *   因此只作**别年代值面的容错读法**：出现即按同名语义采信（分别接截断与近似重建判据），缺席不作任何假设；
 *   每一态最终都要在 `TimelineDetailView` 里各自成立，所以这个读法不会把缺标记的读数洗成"没有异常"。
 *   `incompatibleVersion` 同理：`unsupported` 门槛的同义布尔写法，本机服不出（严格面），
 *   只作对外部构建的采信，不参与任何数值判定。
 *
 * 未验证存在"上下文质量分数"或自动决策 API，所以本模块不产生任何分数，只产出 §27.3 的分量信号与
 * §10.1 线口径的压缩/换会话判定；未知或不兼容的零值回退**不能**解释为健康或零压力，拿不到就标 `unknown`（§27.2）。
 *
 * 本文件需要的宿主接口在**本文件内**定义（`ProjectionValueSourceLike`、`SessionEnvelopeLike` 是宿主
 * 公开面的窄视图；三个投影状态形状、读数结构与压缩入口 `CompactionPort` 都是本文件新增的结构化
 * interface，不改 host-types.ts）。
 */
import { createHash } from 'node:crypto'
import type { ContextPressureStateLike, HostSlice } from './host-types.ts'
import type { ProbeResult, Shape } from './capabilities.ts'
import type { RotationLine, WindowInput } from '../rotation/lines.ts'
import { rotationLine } from '../rotation/lines.ts'
import type {
  ActionOutcomeInput,
  ActionRunPlan,
  AssessmentFreeze,
  BehaviorRegressionSignals,
  BulkyOutputSignal,
  CapacitySignals,
  ConsistencySignals,
  ContinuitySignals,
  CoverageItem,
  CoverageSignals,
  FreshnessRef,
  FreshnessSignals,
  HistoryBloatSignal,
  InFlightSignal,
  PostCompactionReport,
  QualitySignals,
  RelevanceRedundancySignals,
  RepeatedSignal,
  TaskSwitchSignal,
} from '../core/context-quality.ts'

/** §27.1：上游 Host 入口注册的投影名。只有这三个，不猜别的。 */
export const DSH_CONTEXT_PROJECTIONS = {
  timeline: 'contextTimeline',
  headers: 'contextHeaders',
  activity: 'contextActivity',
} as const

// —— 镜像的出厂默认（不是读取值） ——

/** `@deepseek-ai/dsh-compaction-basic` 的默认压缩 headroom：镜像值，来源上游
 * `packages/compaction/compaction-basic/src/config.ts:75`（`config.headroomTokens ?? 65_536`），
 * 本机安装面在 `dsh-context/lib/client.js:14` 的 `let Ct=65536` 同值可核对。 */
export const MIRRORED_COMPACT_HEADROOM_TOKENS = 65_536

/** 同上，默认触发比例：上游 `packages/compaction/compaction-basic/src/config.ts:20`
 * 的 `DEFAULT_THRESHOLD_RATIO = 0.8`，本机安装面同文件 `client.js:14` 的 `Math.floor(e*.8)`。 */
export const MIRRORED_COMPACT_THRESHOLD_RATIO = 0.8

// —— 投影读数 ——

/**
 * 投影读数（§27.1）。
 *
 * `availability` 与 `state` 必须分开看：`not_loaded` 表示投影还没挂上或该会话还没数据，
 * 真实空集合是 `ok` + 空数组——两者在质量判定里意义完全不同，绝不能合并成"没有异常"。
 */
export type ProjectionAvailability = 'ok' | 'missing' | 'not_loaded' | 'incompatible' | 'error'

/** 读数来自哪条公开面：`snapshot` 是投影响应值（wire 面），`state` 是 fold state（面不同，见 `timelineDetails`）。 */
export type ProjectionVia = 'snapshot' | 'state'

export interface ProjectionRead<T> {
  readonly availability: ProjectionAvailability
  readonly state?: T
  readonly via?: ProjectionVia
  readonly note: string
}

// —— 三个投影的真实字段面 ——

/** `contextTimeline.current`：按类别的当前占用（`lib/index.d.ts:258-267`，
 * 由 `lib/index.js:773-782` 从 fold state 的 `systemTokens`/`toolsTokens`/`sums` 汇出）。 */
export interface TimelineCurrentLike {
  readonly system?: number
  readonly tools?: number
  readonly user?: number
  readonly inject?: number
  readonly skill?: number
  readonly assistant?: number
  readonly tool?: number
  readonly total?: number
}

/** 统计板的预计算计数（`lib/index.d.ts:170-179`）：**只在轻量头上出现**（`lib/index.js:861-868`），
 * 是折叠时对**已保留**的 requests/events 现算的，演变台账的入口。 */
export interface TimelineCountsLike {
  readonly turns?: number
  readonly steps?: number
  readonly injects?: number
  readonly compactions?: number
  readonly prunes?: number
  readonly skills?: number
}

/** 最新一条请求的计费摘要（`lib/index.d.ts:181-185`；同样只在轻量头上，`lib/index.js:869-874`）。 */
export interface TimelineLastLike {
  readonly seq?: number
  readonly total?: number
  readonly prompt?: number
}

/** 低于上游基线时的门槛记录（`lib/index.d.ts:246-251`；兜底单元的构造见 `lib/index.js:3074-3097`）。 */
export interface TimelineUnsupportedLike {
  readonly current?: string
  readonly minimum?: string
}

/** 活动系统提示节点（`lib/index.d.ts:164-168`）。 */
export interface SystemPromptNodeLike {
  readonly seq?: number
  readonly time?: number
  readonly tokens?: number
}

/**
 * 模型可见表面节点（`lib/index.d.ts:439-457`，wire 面 `lib/index.js:1588-1608` 是 `.strict()`）。
 * 身份**只有 `seq`**：面上没有 `ref`/`id`/`persisted`/`toolCallId`，配对与持久副本上游不投影，
 * 所以长输出的"可剪"判据在这条路径上一律落不到 `true`（见 `deriveRelevance`、§27.4 不能直接推导栏）。
 */
export interface SurfaceNodeLike {
  readonly seq?: number
  readonly time?: number
  readonly cat?: 'user' | 'inject' | 'skill' | 'assistant' | 'tool'
  readonly tokens?: number
  readonly imgs?: number
  /** 仅 `archive` 项有：把它顶掉的那次事件 seq（`lib/index.d.ts:300-302`）。 */
  readonly gone?: number
  readonly form?: string
  readonly name?: string
  readonly text?: string
  readonly tool?: string
  readonly err?: boolean
  readonly skill?: string
  readonly calls?: readonly string[]
}

/**
 * 演变事件（`lib/index.d.ts:487-505`，wire 面 `lib/index.js:1633-1655` 是 `.strict()`）。
 * `kind==='compaction'|'prune'` 时 `tokens` 是被顶掉的 token 量，是回收量而不是带符号差值。
 * `turn`/`step`/`fromTurn`/`fromStep` 由 `lib/index.js:829-844` 在服务详情时补齐（轻量头上没有）。
 */
export interface TimelineEventLike {
  readonly seq?: number
  readonly time?: number
  readonly kind?: 'compaction' | 'prune' | 'inject' | 'model' | 'mode'
  readonly form?: string
  readonly tokens?: number
  readonly count?: number
  readonly sub?: string
  readonly name?: string
  readonly detail?: string
  readonly from?: string
  readonly to?: string
  readonly fromTurn?: number
  readonly fromStep?: number
  readonly turn?: number
  readonly step?: number
}

/** 单次已结算请求的分项占用（`lib/index.d.ts:459-486`，wire 面 `lib/index.js:1614-1632` 是 `.strict()`）。 */
export interface TimelineRequestLike {
  readonly turn?: number
  readonly step?: number
  readonly time?: number
  readonly seq?: number
  readonly system?: number
  readonly tools?: number
  readonly user?: number
  readonly inject?: number
  readonly skill?: number
  readonly assistant?: number
  readonly tool?: number
  readonly total?: number
  readonly prompt?: number
  readonly cacheRead?: number
  readonly output?: number
  readonly activeMs?: number
  /** `stepCount`/`net` 由 Client 侧聚合写入，宿主投影面从不设置（`lib/index.d.ts:482-485`）。 */
  readonly stepCount?: number
  readonly net?: number
}

/** 文件操作台账（`lib/index.d.ts:337-367`，wire 面 `lib/index.js:1656-1682` 是 `.strict()`）。
 * `gone` 是 Client 侧连接的存档标记，宿主服务的面上不出现（`:365-366`）。 */
export interface FileOpRecordLike {
  readonly seq?: number
  readonly path?: string
  readonly kind?: 'read' | 'write' | 'search'
  readonly tool?: string
  readonly time?: number
  readonly err?: boolean
  readonly added?: number
  readonly removed?: number
  readonly detail?: string
  readonly hits?: number
  readonly parent?: number
  readonly program?: string
  /** `path` 是被搜的模式而不是文件（`lib/index.d.ts:363-364`）。 */
  readonly pattern?: true
}

/** 时间条的一块时间片（`lib/index.d.ts:370-378`）。 */
export interface TimingSpanLike {
  readonly kind?: 'ttft' | 'reasoning' | 'text' | 'toolarg' | 'tools' | 'other'
  readonly start?: number
  readonly end?: number
}

/** 轻量头清单的一项（别年代值面的 `heads`，0.70.0 服不出）：只作"只有头"的在场判据与摘要去重。 */
export interface TimelineHeadLike {
  readonly id?: string
  readonly kind?: string
  readonly summary?: string
  readonly tokens?: number
  readonly seq?: number
}

/**
 * `contextTimeline` 的值面（`lib/index.d.ts:244-312` 的 `Snapshot`）。
 * 同一条目有两种形态，判别字段是唯一的（`lib/index.js:765-890`）：
 * - **轻量头**（`buildTimelineHead`）：带 `detailRev`（恒有，缺省 0）与 `counts`/`last`，
 *   `requests`/`events`/`nodes`/`archive` 恒是空占位、`droppedNodes` 恒是 0（`:788-792`）；
 * - **内联值**（`buildTimelineView`）：`headFieldsOf` 的空占位被 `detailCollectionsOf` 覆盖成真集合，
 *   并且**永不**带 `detailRev`/`counts`/`last`。
 * `rev`/`head` 只属于按需详情载荷 `ContextTimelineDetail`（`lib/index.d.ts:313-333`），
 * 它由 `/api/dsh-context/detail` 给出（`lib/index.js:2845-2933`），投影注册表面给不出；
 * 本包不读那条路由，只在 `timelineDetails` 里承认这个形状。
 * 末尾几项（`heads`/`truncated`/`hasMore`/`reconstructed`）是别的值面/别年代的退化标记：
 * 出现即按同名语义采信，缺席不作假设；`incompatibleVersion` 同理，本机严格面服不出，不参与数值判定。
 */
export interface ContextTimelineStateLike {
  readonly ok?: boolean
  readonly unsupported?: TimelineUnsupportedLike
  /** 别年代值面上的不兼容标记：与 `unsupported` 同一意义（§27.1 零值回退不作健康解释）。 */
  readonly incompatibleVersion?: boolean
  readonly model?: string
  readonly provider?: string
  readonly contextWindow?: number
  /** 路由请求的输出上限：自动压缩在窗口尾部扣掉的那一段，即 §10.1 的 R。 */
  readonly maxOutputTokens?: number
  readonly current?: TimelineCurrentLike
  readonly images?: number
  readonly toolCalls?: number
  readonly humanInputs?: number
  readonly answers?: number
  readonly lastUser?: string
  readonly counts?: TimelineCountsLike
  readonly last?: TimelineLastLike
  readonly detailRev?: number
  readonly requests?: readonly TimelineRequestLike[]
  readonly events?: readonly TimelineEventLike[]
  readonly cost?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly systems?: readonly SystemPromptNodeLike[]
  readonly nodes?: readonly SurfaceNodeLike[]
  readonly droppedNodes?: number
  readonly archive?: readonly SurfaceNodeLike[]
  readonly surfaceFloor?: number
  readonly archiveFloor?: number
  readonly fileOps?: Readonly<Record<string, unknown>>[]
  readonly fileOpsFloor?: number
  /** 轻量头清单（重复摘要/重复规则的来源）：0.70.0 的服务值不给这一项，给得出才数重复。 */
  readonly heads?: readonly TimelineHeadLike[]
  /** 显式截断标记（与 `droppedNodes`/裁剪下限同一意义，出现即按截断处理）。 */
  readonly truncated?: boolean
  /** 同上：还有未随值服务的内容。 */
  readonly hasMore?: boolean
  /** 显式的"历史近似重建"标记（与裁剪下限同一意义：可作解释，不作精确判定依据）。 */
  readonly reconstructed?: boolean
}

/** 一个工具的形状开销（`src/host/headers.ts:68-72`、`src/shared/types.ts:487-493`）。 */
export interface HeaderToolLike {
  readonly name?: string
  readonly tokens?: number
  readonly plugin?: string
}

/** 一次请求头 epoch 的元数据（`src/host/headers.ts:74-82`、`src/shared/types.ts:498-504`）。 */
export interface HeaderRecordLike {
  readonly seq?: number
  readonly time?: number
  readonly systemTokens?: number
  readonly tools?: readonly HeaderToolLike[]
}

/**
 * `contextHeaders` 的值面：只有 epoch 列表。
 * 它**不含** `contextWindow`、也不含任何压缩预留——那两项在设计稿阶段是猜的（§27.1 已由源码否证）。
 */
export interface ContextHeadersStateLike {
  readonly headers?: readonly HeaderRecordLike[]
}

/** 一天的用量（`src/host/activity.ts:53-58`、`src/shared/types.ts:61-72`）。 */
export interface ActivityDayLike {
  readonly tokens?: number
  readonly requests?: number
  readonly cost?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly skills?: Readonly<Record<string, { readonly n?: number; readonly last?: number }>>
}

/**
 * `contextActivity` 的值面：按本地日键的用量台账（`src/host/activity.ts:60-62`）。
 * 它**不含** `repeatedActions`/`inFlight`/`pendingHandoffs`：在途与交接只认任务侧记录。
 */
export interface ContextActivityStateLike {
  readonly days?: Readonly<Record<string, ActivityDayLike>>
}

// —— 投影读取 ——

/**
 * 投影注册表的读取面（窄视图）：`snapshot` 给投影响应值，`stateOf` 给 fold state。
 * 两者都是宿主的公开方法（`packages/session/session-projection/src/index.ts:319/338`），
 * 这里声明成可选成员，好让 `ProjectionRegistryLike` 直接结构兼容。
 */
export interface ProjectionValueSourceLike {
  readonly snapshot?: (session: unknown, keys?: readonly string[]) => { readonly values?: Readonly<Record<string, unknown>> } | undefined
  readonly stateOf?: (session: unknown, name: string) => unknown
}

/** fold state 里的 timeline 面（`src/host/foldState.ts:21-63`）：只用于回退路径的归一化。 */
interface TimelineFoldStateLike {
  readonly surface?: readonly SurfaceNodeLike[]
  readonly archived?: readonly SurfaceNodeLike[]
  readonly sums?: { readonly user?: number; readonly inject?: number; readonly skill?: number; readonly assistant?: number; readonly tool?: number }
  readonly systemTokens?: number
  readonly toolsTokens?: number
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly requests?: readonly TimelineRequestLike[]
  readonly events?: readonly TimelineEventLike[]
  readonly detailRev?: number
}

function isGateUnsupported(value: Readonly<Record<string, unknown>>): boolean {
  const gate = value['unsupported']
  if (gate === null || typeof gate !== 'object') return false
  const record = gate as Record<string, unknown>
  return typeof record['current'] === 'string' && typeof record['minimum'] === 'string'
}

/** fold state → 值面的最小归一化：只搬判定要用的字段，其余一律不假造。 */
function timelineFromFoldState(state: TimelineFoldStateLike): ContextTimelineStateLike {
  const sums = state.sums ?? {}
  const system = num(state.systemTokens) ?? 0
  const tools = num(state.toolsTokens) ?? 0
  const surface = objects(state.surface).reduce((total, node) => total + (num(node.tokens) ?? 0), 0)
  return {
    ok: true,
    ...(num(state.contextWindow) === undefined ? {} : { contextWindow: state.contextWindow }),
    ...(num(state.maxOutputTokens) === undefined ? {} : { maxOutputTokens: state.maxOutputTokens }),
    current: {
      system: num(state.systemTokens) ?? 0,
      tools: num(state.toolsTokens) ?? 0,
      user: num(sums.user) ?? 0,
      inject: num(sums.inject) ?? 0,
      skill: num(sums.skill) ?? 0,
      assistant: num(sums.assistant) ?? 0,
      tool: num(sums.tool) ?? 0,
      total: system + tools + surface,
    },
    ...(state.detailRev === undefined ? {} : { detailRev: state.detailRev }),
    ...(state.requests === undefined ? {} : { requests: state.requests }),
    ...(state.events === undefined ? {} : { events: state.events }),
    ...(state.surface === undefined ? {} : { nodes: state.surface }),
    ...(state.archived === undefined ? {} : { archive: state.archived }),
  }
}

/** 只读探测：任何异常都收敛成 availability，不向上抛（适配层的失败要可诊断）。 */
export function readProjection<T>(registry: ProjectionValueSourceLike | undefined, session: unknown, name: string): ProjectionRead<T> {
  if (registry === null || registry === undefined || typeof registry !== 'object') {
    return { availability: 'missing', note: `投影注册表未装载：读不到 ${name}` }
  }
  const hasSnapshot = typeof registry.snapshot === 'function'
  const hasStateOf = typeof registry.stateOf === 'function'
  if (!hasSnapshot && !hasStateOf) {
    return { availability: 'missing', note: `投影注册表没有公开读取面（snapshot/stateOf 都缺）：读不到 ${name}` }
  }
  if (hasSnapshot) {
    try {
      const cut = registry.snapshot?.(session, [name])
      const value = cut?.values?.[name]
      if (value !== undefined && value !== null) return finishRead<T>(name, value, 'snapshot')
    } catch (error) {
      return { availability: 'error', note: `读取 ${name} 的投影值抛错：${message(error)}；按不可用处理，不按 0 回退（§27.1）` }
    }
  }
  if (!hasStateOf) return { availability: 'not_loaded', note: `${name} 无值可读：未加载 ≠ 空集合，不能读成"零压力"（§27.1）` }
  let state: unknown
  try {
    state = registry.stateOf?.(session, name)
  } catch (error) {
    return { availability: 'error', note: `读取 ${name} 的 fold state 抛错：${message(error)}；按不可用处理，不按 0 回退（§27.1）` }
  }
  if (state === undefined || state === null) {
    return { availability: 'not_loaded', note: `${name} 未注册或该会话尚无此投影：未加载 ≠ 空集合，不能读成"零压力"（§27.1）` }
  }
  return finishRead<T>(name, state, 'state')
}

function finishRead<T>(name: string, value: unknown, via: ProjectionVia): ProjectionRead<T> {
  if (typeof value !== 'object') {
    return { availability: 'error', note: `${name} 读数不是对象（${typeof value}）：形态不明，按不可用处理（§27.1）` }
  }
  const record = value as Readonly<Record<string, unknown>>
  if (isGateUnsupported(record)) {
    return {
      availability: 'incompatible',
      via,
      state: value as T,
      note: `${name} 带 unsupported 门槛记录：宿主低于上游基线，兜底单元折叠为零值，零值回退不能解释为健康或零压力（§27.1）`,
    }
  }
  // 不兼容的另一写法：`ContextTimelineStateLike.incompatibleVersion`（本文件声明的同名可选标记，
  // 面上有就认）。它与 `unsupported` 同一意义——低于基线时宿主折叠为零值，读数一律按门槛处理，
  // 不能因为"值为 0 且形态合法"就落回 ok/unavailable 而被读成健康（§27.1）。
  if (record['incompatibleVersion'] === true) {
    return {
      availability: 'incompatible',
      via,
      state: value as T,
      note: `${name} 带 incompatibleVersion 门槛标记（与 unsupported 同一判据的别年代写法，出现即按同名语义采信）：零值回退不能解释为健康或零压力（§27.1）`,
    }
  }
  return { availability: 'ok', via, state: value as T, note: `${name} 已加载（${via === 'snapshot' ? '投影响应值' : 'fold state 回退'}）` }
}

export interface DshContextReads {
  readonly timeline: ProjectionRead<ContextTimelineStateLike>
  readonly headers: ProjectionRead<ContextHeadersStateLike>
  readonly activity: ProjectionRead<ContextActivityStateLike>
}

/**
 * 读三个投影。低于基线时上游把**三个**投影一起换成兜底单元（`src/host/index.ts:55-62`、
 * `src/host/fallback.ts:56-75`），而 `contextHeaders`/`contextActivity` 的兜底值
 * （`{headers:[]}` / `{days:{}}`）与真实空集合在面上不可区分——门槛记录只写在 timeline 上。
 * 因此 timeline 报 `incompatible` 时，另两项一并标 `incompatible`：这是读出来的门槛，不是猜的。
 */
export function readDshContext(host: Pick<HostSlice, 'sessionProjections'>, session: unknown): DshContextReads {
  const registry = host.sessionProjections as ProjectionValueSourceLike | undefined
  const timeline = normalizeTimelineRead(readProjection<TimelineFoldStateLike>(registry, session, DSH_CONTEXT_PROJECTIONS.timeline))
  const headers = readProjection<ContextHeadersStateLike>(registry, session, DSH_CONTEXT_PROJECTIONS.headers)
  const activity = readProjection<ContextActivityStateLike>(registry, session, DSH_CONTEXT_PROJECTIONS.activity)
  if (timeline.availability !== 'incompatible') return { timeline, headers, activity }
  const extend = <T>(read: ProjectionRead<T>): ProjectionRead<T> =>
    read.availability === 'ok'
      ? { ...read, availability: 'incompatible', note: `${read.note}；同批注册的兜底单元（宿主低于上游基线）：这份读数不能解释为健康（§27.1）` }
      : read
  return { timeline, headers: extend(headers), activity: extend(activity) }
}

/**
 * `via === 'state'` 读到的是 fold state（`src/host/foldState.ts:21-63`），占用是 `sums` + `surface`
 * 的分摊面，不是投影响应值里的 `current`（`src/host/timeline.ts:126-135`）：不折算就按 `current`
 * 取值会把有数读成 0。这里只做最小搬运，face 上没有的字段一律留空而不是补一个看着合理的数。
 */
function normalizeTimelineRead(read: ProjectionRead<TimelineFoldStateLike>): ProjectionRead<ContextTimelineStateLike> {
  if (read.availability !== 'ok' || read.via !== 'state' || read.state === undefined) {
    return read as ProjectionRead<ContextTimelineStateLike>
  }
  return { ...read, state: timelineFromFoldState(read.state) }
}

/**
 * 详情形态（§27.1）：slim head / inline、被截断、历史近似重建、低于基线的零值兜底**分开**记，
 * 绝不合并成"没有异常"。判别标记全部来自真实字段（`lib/index.d.ts:244-312` 的 Snapshot），
 * 别年代值面上的同名显式标记（`truncated`/`hasMore`/`reconstructed`）出现即按同名语义采信。
 */
export interface TimelineDetailView {
  /** 集合是否随值内联（fold state 回退路径同样算内联：state 里就是全集）。 */
  readonly loaded: boolean
  /** slim head：`detailRev` 在场，值里的 events/nodes/requests 是空占位，详情在按需通道里。 */
  readonly split: boolean
  /** 被截断：随值服务的清单少了内容——`droppedNodes` > 0（`lib/index.d.ts:298-299`），
   * 或别年代值面上的 `truncated`/`hasMore` 显式标记。它限制覆盖核对的口径，不作裁剪依据。 */
  readonly truncated: boolean
  /** 历史近似重建：值面带来裁剪下限（`surfaceFloor`/`archiveFloor`/`fileOpsFloor`，
   * `lib/index.d.ts:303-309`），早于下限的那段只能按近似重建看待；或别年代值面的 `reconstructed` 标记。
   * 与 `truncated` 各自成立：`droppedNodes` > 0 时上游必然也给 `surfaceFloor`，那条读数两态同真。 */
  readonly reconstructed: boolean
  /** 低于基线的零值兜底。 */
  readonly zeroed: boolean
  readonly note: string
}

export function timelineDetails(read: ProjectionRead<ContextTimelineStateLike>): TimelineDetailView {
  const state = read.state
  if (read.availability !== 'ok' || state === undefined) {
    return { loaded: false, split: false, truncated: false, reconstructed: false, zeroed: read.availability === 'incompatible', note: `${read.availability}：${read.note}` }
  }
  const dropped = num(state.droppedNodes) ?? 0
  // 轻量头在场：`detailRev` 是拆分代次头部字段（`lib/index.d.ts:280-284`"present exactly when the host
  // serves the slim head"），`heads` 清单是别年代值面上的同一形式；详情集合是否随值在场要逐个看
  // （`lib/index.d.ts:285-297`"The slim head serves these EMPTY"）。缓存行会把全集带回来，那时集合在场
  // 就是内联值；fold state 面上本来就是全集——两者都不能只凭头字段判成未加载（§27.1）。
  const headServed = num(state.detailRev) !== undefined || objects(state.heads).length > 0
  const detailServed = objects(state.requests).length > 0 || objects(state.events).length > 0 || objects(state.nodes).length > 0
  const split = read.via !== 'state' && headServed && !detailServed
  const truncated = dropped > 0 || state.truncated === true || state.hasMore === true
  const reconstructed =
    num(state.surfaceFloor) !== undefined || num(state.archiveFloor) !== undefined || num(state.fileOpsFloor) !== undefined || state.reconstructed === true
  const parts: string[] = []
  if (split) parts.push('只有轻量头：detailRev 在场而 requests/events/nodes 都是空占位，详情要走 /api/dsh-context/detail 按需通道；不能把"没有详情"读成"没有事件"')
  if (truncated) parts.push(dropped > 0 ? `服务清单被截断：${dropped} 个活节点未随值服务${num(state.surfaceFloor) !== undefined ? `（surfaceFloor=${state.surfaceFloor}）` : ''}` : '值面带来截断标记：还有内容未随值服务')
  if (reconstructed) parts.push('历史段落近似重建：裁剪下限之前的已移除节点/档案/文件操作可能缺失，早于下限的步骤只能按近似重建解释')
  return { loaded: !split, split, truncated, reconstructed, zeroed: false, note: parts.length === 0 ? '轻量头与详情均已加载' : parts.join('；') }
}

// —— 线口径的读取来源（provenance） ——

/** 一个线口径数字从哪来：宿主直读、dsh-context 投影、操作者声明、或上游出厂默认的镜像值。 */
export type ReadingProvenance = 'host-direct' | 'dsh-context:contextTimeline' | 'operator-setting' | 'mirrored-default'

export interface DeclaredReading {
  readonly value: number
  readonly provenance: ReadingProvenance
  readonly note: string
}

/** 设置侧的线口径声明：0 与缺省同样表示"未声明"，与 `index.ts` 的 `normalize()` 口径一致。 */
export interface DeclaredSettings {
  readonly outputReserveTokens?: number
  readonly compactionHeadroomTokens?: number
  readonly compactionRatio?: number
  readonly acceptMirroredCompactionDefaults?: boolean
}

function declared(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 输出预留 R：操作者声明 > 宿主直读 `request/header` 的 `config.maxTokens` >
 * `contextTimeline.maxOutputTokens`。三者都拿不到即 `null`——不猜（§10.1 fail-closed 规则一）。
 */
export function resolveOutputReserve(input: {
  readonly operatorTokens?: number
  readonly hostDirectTokens?: number | null
  readonly timelineTokens?: number | null
}): DeclaredReading | null {
  const operator = declared(input.operatorTokens)
  if (operator !== null) return { value: operator, provenance: 'operator-setting', note: 'R 取操作者声明值：设置优先于读取值（§10.1）' }
  const host = declared(input.hostDirectTokens)
  if (host !== null) {
    return { value: host, provenance: 'host-direct', note: 'R 直读会话 requestHeader 的 config.maxTokens（packages/core/session/src/index.ts:784）' }
  }
  const timeline = declared(input.timelineTokens)
  if (timeline !== null) {
    return { value: timeline, provenance: 'dsh-context:contextTimeline', note: 'R 读自 contextTimeline.maxOutputTokens，上游同样源自 request/header 的 config.maxTokens（lib/index.d.ts:255-257 的字段说明）' }
  }
  return null
}

/**
 * H 与 r：只有操作者声明，或操作者显式接受上游出厂默认的镜像值，两条路。
 * 默认两者都是 `null` ⇒ 轮换线停在 observation；镜像值一律标 `mirrored-default`，不冒充读取值。
 */
export function resolveCompactionPolicy(input: {
  readonly operatorHeadroomTokens?: number
  readonly operatorRatio?: number
  readonly acceptMirroredCompactionDefaults?: boolean
}): { readonly headroom: DeclaredReading | null; readonly ratio: DeclaredReading | null } {
  const mirror = input.acceptMirroredCompactionDefaults === true
  const headroomValue = declared(input.operatorHeadroomTokens)
  const headroom =
    headroomValue !== null
      ? { value: headroomValue, provenance: 'operator-setting' as ReadingProvenance, note: 'H 取操作者声明值（§10.1）' }
      : mirror
        ? { value: MIRRORED_COMPACT_HEADROOM_TOKENS, provenance: 'mirrored-default' as ReadingProvenance, note: `H 取 dsh-compaction-basic 出厂默认 ${MIRRORED_COMPACT_HEADROOM_TOKENS}：镜像值，不是读取值（compaction-basic src/config.ts:75；本机安装面 dsh-context/lib/client.js:14）` }
        : null
  const ratioValue =
    typeof input.operatorRatio === 'number' && Number.isFinite(input.operatorRatio) && input.operatorRatio > 0 && input.operatorRatio <= 1
      ? input.operatorRatio
      : null
  const ratio =
    ratioValue !== null
      ? { value: ratioValue, provenance: 'operator-setting' as ReadingProvenance, note: 'r 取操作者声明值（§10.1）' }
      : mirror
        ? { value: MIRRORED_COMPACT_THRESHOLD_RATIO, provenance: 'mirrored-default' as ReadingProvenance, note: `r 取出厂默认 ${MIRRORED_COMPACT_THRESHOLD_RATIO}：镜像值，不是读取值（compaction-basic src/config.ts:20；本机安装面 dsh-context/lib/client.js:14）` }
        : null
  return { headroom, ratio }
}

// —— 宿主直读面（不经 dsh-context） ——

/** `Session` 的两个公开访问器（packages/core/session/src/index.ts:784/805）。 */
export interface SessionEnvelopeLike {
  readonly requestHeader?: () => { readonly config?: Readonly<Record<string, unknown>> } | undefined
  readonly requestContext?: () => { readonly contextWindow?: number; readonly model?: string; readonly provider?: string } | undefined
}

export interface SessionEnvelopeRead {
  readonly outputReserveTokens: number | null
  readonly contextWindowTokens: number | null
  readonly model: string | null
  readonly note: string
}

/** 直读会话的请求信封：读不到或抛错一律回 null，不抛给判定层。 */
export function readSessionEnvelope(session: unknown): SessionEnvelopeRead {
  const none: SessionEnvelopeRead = { outputReserveTokens: null, contextWindowTokens: null, model: null, note: '会话对象给不出 requestHeader/requestContext：线口径只能靠投影值或操作者声明' }
  if (session === null || typeof session !== 'object') return none
  const handle = session as SessionEnvelopeLike
  let config: Readonly<Record<string, unknown>> | undefined
  try {
    config = handle.requestHeader?.()?.config
  } catch {
    config = undefined
  }
  let window: number | undefined
  let model: string | undefined
  try {
    const context = handle.requestContext?.()
    window = num(context?.contextWindow)
    model = typeof context?.model === 'string' && context.model.length > 0 ? context.model : undefined
  } catch {
    window = undefined
  }
  const cap = num(config?.['maxTokens'])
  const parts: string[] = []
  if (cap !== undefined && cap > 0) parts.push(`R 直读 requestHeader.config.maxTokens=${cap}`)
  if (window !== undefined && window > 0) parts.push(`窗口直读 requestContext.contextWindow=${window}`)
  return {
    outputReserveTokens: cap !== undefined && cap > 0 ? cap : null,
    contextWindowTokens: window !== undefined && window > 0 ? window : null,
    model: model ?? null,
    note: parts.length === 0 ? none.note : `宿主直读可用：${parts.join('、')}`,
  }
}

// —— 原生容量读数（§27.2：容量压力归 DSH 原生，界面折算值另作解释） ——

export interface NativeBudgetRead {
  readonly status: 'ok' | 'unavailable' | 'incompatible'
  readonly note: string
  readonly requestEstimateTokens?: number
  readonly contextWindowTokens?: number
  /** 宿主直读到的输出预留（未做优先级合并；合并见 `resolveOutputReserve`）。 */
  readonly hostOutputReserveTokens?: number
  readonly source?: 'native_meter' | 'request_budget' | 'projection' | 'estimated'
}

/**
 * 折算原生请求压力。
 *
 * 折算公式照 `host-types.ts` 里记的 wire 边界口径：`max(0, pressureTokens + surfaceTokens − sampledSurfaceTokens)`；
 * 分母缺失即 unknown（缺字段显示未知，不按 0 或健康回退，§27.1）。三个字段是 last-wins、不是原子观测。
 * 分子是 prompt 侧压力（input + cache read + cache write，无输出，`packages/llm/token-meter/src/usage-projection.ts:77-79`），
 * 所以可以且只可以和 C = min(r·W, W−R−H) 直接比——R 已经在 C 里扣过，判定侧不得再加一次。
 */
export function readNativeBudget(host: Pick<HostSlice, 'sessionProjections' | 'tokenMeter'>, session: unknown): NativeBudgetRead {
  const read = readProjection<ContextPressureStateLike>(host.sessionProjections as ProjectionValueSourceLike | undefined, session, 'contextPressure')
  if (read.availability === 'incompatible') return { status: 'incompatible', note: read.note }
  let measured: number | undefined
  try {
    measured = num(host.tokenMeter?.measure(session)?.totalTokens)
  } catch {
    measured = undefined
  }
  const state = read.state
  const window = num(state?.contextWindow)
  const base = num(state?.pressureTokens) ?? measured
  if (base === undefined) {
    return { status: 'unavailable', note: '拿不到请求估计（pressureTokens 与 tokenMeter.measure 都缺）：缺字段显示未知，不按 0 回退（§27.1）' }
  }
  const projected = Math.max(0, base + (num(state?.surfaceTokens) ?? 0) - (num(state?.sampledSurfaceTokens) ?? 0))
  const source = num(state?.pressureTokens) !== undefined ? 'projection' : 'native_meter'
  const envelope = readSessionEnvelope(session)
  const reserve = num(envelope.outputReserveTokens)
  if (window === undefined || window <= 0) {
    return {
      status: 'unavailable',
      note: '拿不到上下文窗口：缺分母即未知，不按 0 或健康回退（§27.1）',
      requestEstimateTokens: projected,
      source,
      ...(reserve === undefined ? {} : { hostOutputReserveTokens: reserve }),
    }
  }
  return {
    status: 'ok',
    note: `原生读数：估计 ${projected}/${window}（${source}）；执行阈值以当前有效 DSH 配置与请求预算为准（§27.1）`,
    requestEstimateTokens: projected,
    contextWindowTokens: window,
    source,
    ...(reserve === undefined ? {} : { hostOutputReserveTokens: reserve }),
  }
}

// —— 线口径判定：该压缩、该在会话内另开一个会话、还是都不动 ——

/** 按类别的当前占用；投影缺席时各项为 null（不是 0）。 */
export interface TimelineOccupancy {
  readonly system: number | null
  readonly tools: number | null
  readonly user: number | null
  readonly inject: number | null
  readonly skill: number | null
  readonly assistant: number | null
  readonly tool: number | null
  readonly total: number | null
}

/** 压缩/裁剪事件台账（`counts` + 事件明细），判定"压缩还管用吗"的证据面。 */
export interface CompactionLedger {
  readonly compactions: number | null
  readonly prunes: number | null
  /** 已回收的 token 量合计（各 compaction 事件 `tokens` 之和）；slim head 不内联 events ⇒ null。 */
  readonly reclaimedTokens: number | null
  /** 最近一次 compaction 事件的 seq；没有即 null。 */
  readonly lastCompactionSeq: number | null
  /** 事件明细是否随值可读（slim head ⇒ false）。 */
  readonly eventsInline: boolean
}

/** 一次判定的全部读数；纯数据，可由 `readContextReadings` 采集，也可由调用方直接构造。 */
export interface ContextReadings {
  readonly reads: DshContextReads
  readonly details: TimelineDetailView
  readonly budget: NativeBudgetRead
  /** 与窗口同侧的压力分子；优先原生投影值，其次投影占用估算。 */
  readonly pressureTokens: number | null
  readonly pressureSource: 'projection' | 'native_meter' | 'timeline_estimate' | 'unknown'
  readonly contextWindowTokens: number | null
  readonly contextWindowSource: 'native_meter' | 'host-direct' | 'dsh-context:contextTimeline' | 'unknown'
  readonly occupancy: TimelineOccupancy
  readonly ledger: CompactionLedger
  readonly route: { readonly model: string | null; readonly provider: string | null }
  readonly outputReserve: DeclaredReading | null
  readonly compactionHeadroom: DeclaredReading | null
  readonly compactionRatio: DeclaredReading | null
  readonly mirroredDefaultsAccepted: boolean
  /** 两个窗口口径不一致：既不是同一模型也不是同一请求口径，判定必须停下（§10.1 fail-closed 规则一）。 */
  readonly windowMismatch: { readonly native: number; readonly timeline: number } | null
  readonly notes: readonly string[]
}

function occupancyOf(state: ContextTimelineStateLike | undefined): TimelineOccupancy {
  const current = state?.current
  return {
    system: num(current?.system) ?? null,
    tools: num(current?.tools) ?? null,
    user: num(current?.user) ?? null,
    inject: num(current?.inject) ?? null,
    skill: num(current?.skill) ?? null,
    assistant: num(current?.assistant) ?? null,
    tool: num(current?.tool) ?? null,
    total: num(current?.total) ?? null,
  }
}

function ledgerOf(read: ProjectionRead<ContextTimelineStateLike>, details: TimelineDetailView): CompactionLedger {
  const state = read.availability === 'ok' ? read.state : undefined
  const counts = state?.counts
  const events = objects(state?.events)
  const inline = Array.isArray(state?.events)
  let reclaimed: number | null = null
  let lastSeq: number | null = null
  if (inline) {
    let sum = 0
    for (const event of events) {
      if (event.kind !== 'compaction') continue
      sum += num(event.tokens) ?? 0
      const seq = num(event.seq)
      if (seq !== undefined && (lastSeq === null || seq > lastSeq)) lastSeq = seq
    }
    reclaimed = sum
  }
  return {
    // slim head 的 events 是空占位，数出来 0 次会读成"从没压缩过"：次数只在集合确实内联时才从明细推。
    compactions: num(counts?.compactions) ?? (inline && !details.split ? events.filter((event) => event.kind === 'compaction').length : null),
    prunes: num(counts?.prunes) ?? (inline && !details.split ? events.filter((event) => event.kind === 'prune').length : null),
    reclaimedTokens: details.split ? null : reclaimed,
    lastCompactionSeq: details.split ? null : lastSeq,
    eventsInline: inline,
  }
}

/** 把三路读数合并成一次判定输入；纯函数，不碰宿主。 */
export function buildReadings(input: {
  readonly reads: DshContextReads
  readonly budget: NativeBudgetRead
  readonly settings?: DeclaredSettings
  readonly envelope?: SessionEnvelopeRead
}): ContextReadings {
  const settings = input.settings ?? {}
  const timelineRead = input.reads.timeline
  const timeline = timelineRead.availability === 'ok' ? timelineRead.state : undefined
  const details = timelineDetails(timelineRead)
  const occupancy = occupancyOf(timeline)
  const envelope = input.envelope ?? readSessionEnvelope(undefined)
  const policy = resolveCompactionPolicy({
    operatorHeadroomTokens: settings.compactionHeadroomTokens,
    operatorRatio: settings.compactionRatio,
    acceptMirroredCompactionDefaults: settings.acceptMirroredCompactionDefaults,
  })
  const reserve = resolveOutputReserve({
    operatorTokens: settings.outputReserveTokens,
    hostDirectTokens: num(input.budget.hostOutputReserveTokens) ?? envelope.outputReserveTokens,
    timelineTokens: num(timeline?.maxOutputTokens),
  })
  const positive = (value: number | null | undefined): number | null => (value !== null && value !== undefined && value > 0 ? value : null)
  const nativeWindow = positive(num(input.budget.contextWindowTokens))
  const timelineWindow = positive(num(timeline?.contextWindow))
  const envelopeWindow = positive(num(envelope.contextWindowTokens))
  const windowMismatch =
    nativeWindow !== null && timelineWindow !== null && nativeWindow !== timelineWindow
      ? { native: nativeWindow, timeline: timelineWindow }
      : null
  const notes: string[] = []
  if (timelineRead.availability === 'ok' && timelineRead.via === 'state') notes.push('contextTimeline 只能读 fold state：counts/last/unsupported 不在这一面上，压缩次数改由 events 明细计数，门槛只能按未知处理')
  if (reserve === null) notes.push('输出预留 R 未声明且读不到：轮换线停在 observation（§10.1）')
  else notes.push(`R=${reserve.value}（${reserve.provenance}）：${reserve.note}`)
  if (policy.headroom === null) notes.push('压缩 headroom H 未声明且未接受镜像默认值：轮换线停在 observation（§10.1）')
  if (policy.ratio === null) notes.push('触发比例 r 未声明且未接受镜像默认值：轮换线停在 observation（§10.1）')
  if (windowMismatch !== null) notes.push(`窗口口径不一致：原生 ${windowMismatch.native} vs 投影 ${windowMismatch.timeline}：last-wins 读数不同源，本次不判定（§10.1）`)
  if (details.split) notes.push('时间线只有轻量头（slim head）：占用总量与线口径仍可读，长输出/事件明细要走 /api/dsh-context/detail 按需通道')
  // 被截断与近似重建各自如实记录：部分服务的清单只能限制覆盖口径，不能当完整台账用（§27.1）。
  if (details.truncated || details.reconstructed) notes.push(`服务清单覆盖不全：${details.note}`)
  return {
    reads: input.reads,
    details,
    budget: input.budget,
    pressureTokens: num(input.budget.requestEstimateTokens) ?? occupancy.total,
    pressureSource:
      num(input.budget.requestEstimateTokens) !== undefined
        ? input.budget.source === 'native_meter'
          ? 'native_meter'
          : 'projection'
        : occupancy.total !== null
          ? 'timeline_estimate'
          : 'unknown',
    contextWindowTokens:
      nativeWindow ?? envelopeWindow ?? timelineWindow ?? null,
    contextWindowSource:
      nativeWindow !== null
        ? 'native_meter'
        : envelopeWindow !== null
          ? 'host-direct'
          : timelineWindow !== null
            ? 'dsh-context:contextTimeline'
            : 'unknown',
    occupancy,
    ledger: ledgerOf(timelineRead, details),
    route: { model: str(timeline?.model) ?? envelope.model, provider: str(timeline?.provider) },
    outputReserve: reserve,
    compactionHeadroom: policy.headroom,
    compactionRatio: policy.ratio,
    mirroredDefaultsAccepted: settings.acceptMirroredCompactionDefaults === true,
    windowMismatch,
    notes,
  }
}

/** 采集一次判定读数：本文件里唯一碰宿主面的一侧。 */
export function readContextReadings(
  host: Pick<HostSlice, 'sessionProjections' | 'tokenMeter'>,
  session: unknown,
  settings: DeclaredSettings = {},
): ContextReadings {
  const reads = readDshContext(host, session)
  const budget = readNativeBudget(host, session)
  return buildReadings({ reads, budget, settings, envelope: readSessionEnvelope(session) })
}

/** §10.1 换算 C/T 所需的本包自有口径（不是投影读到的值）。 */
export interface PressureVerdictInput {
  readonly readings: ContextReadings
  /** 交接包 + 首步余量 M。 */
  readonly handoffMarginTokens?: number | null
  /** 期望轮换比例 p。 */
  readonly rotateRatio?: number | null
  readonly startupRequestTokens?: number | null
  readonly runtimeSlackTokens?: number | null
}

export type PressureVerdictKind = 'compact' | 'rotate' | 'hold'

/** 卡住自动侧的那一格；`none` 表示口径齐备。 */
export type PressureGate =
  | 'none'
  | 'contextWindow'
  | 'outputReserve'
  | 'compactionHeadroom'
  | 'compactionRatio'
  | 'handoffMargin'
  | 'rotateRatio'
  | 'startupRequest'
  | 'pressureTokens'
  | 'windowMismatch'

export interface PressureVerdictNumbers {
  readonly pressureTokens: number | null
  readonly pressureSource: ContextReadings['pressureSource']
  readonly contextWindowTokens: number | null
  readonly contextWindowSource: ContextReadings['contextWindowSource']
  readonly outputReserve: DeclaredReading | null
  readonly compactionHeadroom: DeclaredReading | null
  readonly compactionRatio: DeclaredReading | null
  /** 原生压缩实际生效线 C = floor(min(r·W, W−R−H))。 */
  readonly nativeCompactionLine: number | null
  /** 本包的换会话线 T = min(floor(p·W), C−M)。 */
  readonly rotationLine: number | null
  readonly rotationLineMode: RotationLine['mode'] | 'unknown'
  readonly rotationLineReason: string | null
  /** C − pressure：还剩多少才撞到原生压缩。 */
  readonly marginToNativeCompaction: number | null
  /** T − pressure：还剩多少才到换会话线。 */
  readonly marginToRotationLine: number | null
  readonly compactions: number | null
  readonly prunes: number | null
  readonly reclaimedTokens: number | null
  readonly mirroredDefaultsAccepted: boolean
}

export interface PressureVerdict {
  readonly verdict: PressureVerdictKind
  /** 自动侧此刻是否允许换会话（口径齐备且落在 T≤pressure<C 区间）。 */
  readonly canRotate: boolean
  readonly holdingGate: PressureGate
  readonly numbers: PressureVerdictNumbers
  readonly reasons: readonly string[]
  readonly note: string
}

function gateFor(readings: ContextReadings, input: PressureVerdictInput): PressureGate | null {
  if (readings.windowMismatch !== null) return 'windowMismatch'
  const window = num(readings.contextWindowTokens)
  if (window === undefined || window <= 0) return 'contextWindow'
  if (readings.outputReserve === null) return 'outputReserve'
  if (readings.compactionHeadroom === null) return 'compactionHeadroom'
  if (readings.compactionRatio === null) return 'compactionRatio'
  const margin = num(input.handoffMarginTokens)
  if (margin === undefined || margin <= 0) return 'handoffMargin'
  const rotate = input.rotateRatio
  if (typeof rotate !== 'number' || !Number.isFinite(rotate) || rotate <= 0 || rotate > 1) return 'rotateRatio'
  return null
}

function lineWindow(readings: ContextReadings, input: PressureVerdictInput): WindowInput {
  const window = readings.contextWindowTokens
  return {
    contextWindow: window,
    handoffMargin: input.handoffMarginTokens ?? null,
    rotateRatio: input.rotateRatio ?? null,
    ...(readings.outputReserve === null ? {} : { outputReserve: readings.outputReserve.value }),
    ...(readings.compactionHeadroom === null ? {} : { compactionHeadroom: readings.compactionHeadroom.value }),
    ...(readings.compactionRatio === null ? {} : { compactionRatio: readings.compactionRatio.value }),
    ...(input.startupRequestTokens === null || input.startupRequestTokens === undefined ? {} : { startupRequestTokens: input.startupRequestTokens }),
    ...(input.runtimeSlackTokens === null || input.runtimeSlackTokens === undefined ? {} : { runtimeSlackTokens: input.runtimeSlackTokens }),
  }
}

/**
 * 现在该压缩、该在会话内另开一个会话，还是都不动（§10.1、§27.4）。
 *
 * 判据只看两条线，不看任何加权分数：`T ≤ pressure < C` ⇒ 换会话（本包要早于原生压缩换）；
 * `pressure ≥ C` ⇒ 压缩（已经撞到原生生效线，换会话来不及留在原地）；其余 ⇒ 都不动。
 * 任一格口径缺失即 `hold` 并点名是哪一格卡住自动侧；`windowMismatch` 与投影缺席同样只拦自动侧，
 * 不动原生压缩保护（§27.2）。纯函数：不读宿主、不取墙钟。
 */
export function pressureVerdict(input: PressureVerdictInput): PressureVerdict {
  const readings = input.readings
  const line = rotationLine(lineWindow(readings, input))
  const mode = line.mode
  const C = line.C
  const T = line.T
  const pressure = num(readings.pressureTokens) ?? null
  const marginToC = pressure !== null && C !== null ? C - pressure : null
  const marginToT = pressure !== null && T !== null ? T - pressure : null
  const numbers: PressureVerdictNumbers = {
    pressureTokens: pressure,
    pressureSource: readings.pressureSource,
    contextWindowTokens: num(readings.contextWindowTokens) ?? null,
    contextWindowSource: readings.contextWindowSource,
    outputReserve: readings.outputReserve,
    compactionHeadroom: readings.compactionHeadroom,
    compactionRatio: readings.compactionRatio,
    nativeCompactionLine: C,
    rotationLine: T,
    rotationLineMode: mode,
    rotationLineReason: line.reason ?? null,
    marginToNativeCompaction: marginToC,
    marginToRotationLine: marginToT,
    compactions: readings.ledger.compactions,
    prunes: readings.ledger.prunes,
    reclaimedTokens: readings.ledger.reclaimedTokens,
    mirroredDefaultsAccepted: readings.mirroredDefaultsAccepted,
  }
  const reasons: string[] = [...readings.notes]
  if (readings.mirroredDefaultsAccepted && (readings.compactionHeadroom?.provenance === 'mirrored-default' || readings.compactionRatio?.provenance === 'mirrored-default')) {
    reasons.push('H/r 用的是镜像出厂默认值：与当前有效配置不一致时以原生配置为准（§27.1）')
  }
  if (readings.ledger.compactions !== null && readings.ledger.compactions > 0) {
    reasons.push(`本会话已发生 ${readings.ledger.compactions} 次压缩、${readings.ledger.prunes ?? 0} 次裁剪，累计回收 ${readings.ledger.reclaimedTokens ?? '未知'} token`)
  }
  if (readings.details.split) reasons.push('事件台账不在值里（slim head）：压缩/裁剪次数只取 counts，回收量未知')

  const build = (verdict: PressureVerdictKind, canRotate: boolean, holdingGate: PressureGate, extra: readonly string[]): PressureVerdict => {
    const all = [...reasons, ...extra]
    const label =
      verdict === 'compact'
        ? `该压缩：占用 ${pressure} 已到原生生效线 C=${C}`
        : verdict === 'rotate'
          ? `该在会话内另开一个会话：占用 ${pressure} 已过换会话线 T=${T}、尚未撞到原生生效线 C=${C}`
          : `都不动${line.reason === null || mode === 'active' ? '' : `：${line.reason}`}`
    return { verdict, canRotate, holdingGate, numbers, reasons: all, note: `${label}（${all[all.length - 1] ?? '口径齐备'}）` }
  }

  const gate = gateFor(readings, input)
  if (gate !== null) return build('hold', false, gate, [`第 ${gate} 格口径缺失：停在观察，自动侧不动会话，原生压缩保护不受影响（§10.1、§27.2）`])
  if (pressure === null) return build('hold', false, 'pressureTokens', ['压力读数缺失：缺分子即未知，不按 0 或健康回退（§27.1）'])
  if (mode === 'observation') return build('hold', false, 'contextWindow', [`轮换线停在 observation：${line.reason ?? '原因未给出'}`])
  if (C === null) return build('hold', false, 'compactionRatio', ['原生生效线 C 未算出：不给阈值，不判定'])

  if (pressure >= C) {
    if (mode === 'disabled') return build('hold', false, disabledGate(line, input), [`已撞到 C=${C} 但自动侧被禁用：${line.reason ?? '原因未给出'}；压缩仍由原生执行，本包不替它决定`])
    return build('compact', false, 'none', [`已到原生生效线 C=${C}：换会话已来不及留在原地，走原生压缩并在调用返回后逐项核对（§27.5 第 3、4 条）`])
  }
  if (mode === 'disabled') return build('hold', false, disabledGate(line, input), [`自动侧被禁用：${line.reason ?? '原因未给出'}，不换会话（§10.1 fail-closed 规则二、三）`])
  if (T === null) return build('hold', false, 'handoffMargin', ['换会话线 T 未算出：不给阈值，不判定'])
  if (pressure >= T) return build('rotate', true, 'none', [`已过换会话线 T=${T}、距原生生效线 C=${C} 还差 ${C - pressure} token：早于压缩换会话（§10.1）`])
  return build('hold', false, 'none', [`距换会话线 T=${T} 还差 ${T - pressure} token、距原生生效线 C=${C} 还差 ${C - pressure} token：都不动`])
}

/** 把 `rotationLine` 的 disabled 结论归到具体一格；口径与 `lines.ts:90-98` 一致。 */
function disabledGate(line: RotationLine, input: PressureVerdictInput): PressureGate {
  if (line.C !== null && line.C <= 0) return 'outputReserve'
  if (line.T !== null && line.T <= 0) return 'handoffMargin'
  const startup = (input.startupRequestTokens ?? 0) + (input.runtimeSlackTokens ?? 0)
  if (line.T !== null && startup >= line.T) return 'startupRequest'
  return 'handoffMargin'
}

// —— 请求指纹（只用于"相同请求/状态版本复用结果"，不冒充观测证据） ——

export interface FingerprintInput {
  readonly budget: NativeBudgetRead
  readonly timeline?: ProjectionRead<ContextTimelineStateLike>
  readonly headers?: ProjectionRead<ContextHeadersStateLike>
  readonly activity?: ProjectionRead<ContextActivityStateLike>
}

/**
 * 观测指纹（§27.3"相同请求/状态版本复用结果"）。
 *
 * 取自原生读数与投影的修订/计数面，**不**依赖 dsh-context 是否可用：投影缺席时照样给出稳定指纹
 * （否则 §27.2 的"可缺省"就会把评估记录一起挡掉）。
 */
export function observationFingerprint(input: FingerprintInput): string {
  const timeline = input.timeline?.state
  const headers = objects(input.headers?.state?.headers)
  const newestHeader = headers.length === 0 ? undefined : headers[headers.length - 1]
  const days = Object.entries(input.activity?.state?.days ?? {})
    .map(([key, day]) => `${key}:${num(day?.requests) ?? 0}:${num(day?.tokens) ?? 0}`)
    .sort()
  const material = JSON.stringify({
    window: input.budget.contextWindowTokens ?? 'na',
    estimate: input.budget.requestEstimateTokens ?? 'na',
    reserve: input.budget.hostOutputReserveTokens ?? 'na',
    detailRev: timeline?.detailRev ?? 'na',
    currentTotal: timeline?.current?.total ?? 'na',
    counts: timeline?.counts ?? 'na',
    last: timeline?.last ?? 'na',
    droppedNodes: timeline?.droppedNodes ?? 'na',
    surfaceFloor: timeline?.surfaceFloor ?? 'na',
    archiveFloor: timeline?.archiveFloor ?? 'na',
    headerEpoch: `${newestHeader?.seq ?? 'na'}/${newestHeader?.systemTokens ?? 'na'}/${(newestHeader?.tools ?? []).length}`,
    days,
    availability: `${input.timeline?.availability ?? 'na'}/${input.headers?.availability ?? 'na'}/${input.activity?.availability ?? 'na'}`,
  })
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

// —— 信号收集（观测 → §27.3 分量输入） ——

export interface ContextQualityInput {
  readonly host: Pick<HostSlice, 'sessionProjections' | 'tokenMeter'>
  /** 会话对象（投影注册表按 Session 对象寻址，不是 sessionId）。 */
  readonly session: unknown
  /** 原生容量读数；缺省时本函数自行折算。 */
  readonly nativeBudget?: NativeBudgetRead
  /** 已采集好的判定读数；缺省时按 `host`/`session` 现读一次。 */
  readonly readings?: ContextReadings
  /** 设置侧的线口径声明（0=未声明）。 */
  readonly settings?: DeclaredSettings
  /** 必需条件清单：来自任务侧权威状态，适配层不编造"已经覆盖"。 */
  readonly required: readonly CoverageItem[]
  /** 版本引用对照（引用版本 vs 权威当前版本），来自任务侧。 */
  readonly versionRefs?: readonly FreshnessRef[]
  readonly structuralFindings?: readonly { readonly kind: string; readonly detail: string }[]
  readonly claimSides?: readonly { readonly claimRef: string; readonly hasSupport: boolean; readonly hasCounter: boolean }[]
  /** 无法核对的关键事实/操作结果（§27.4 第 6 行）。 */
  readonly unverifiedFacts?: readonly string[]
  readonly nextAction?: string
  readonly historyBloat?: HistoryBloatSignal
  readonly taskSwitch?: TaskSwitchSignal
  readonly progressContinues?: boolean
  readonly uniqueComplexDetail?: boolean
  /** 长输出候选阈值（估算 token）：只在详情已内联时用于挑候选，不用于删除。 */
  readonly bulkyOutputThreshold?: number
}

export interface ContextQualityCollection {
  readonly signals: QualitySignals
  /** 观测面缺口与退化说明：进日志与视图，绝不把"没看到"写成"没有问题"（§27.2）。 */
  readonly degradations: readonly string[]
  readonly fingerprint: string
  readonly reads: DshContextReads
  readonly details: TimelineDetailView
  readonly readings: ContextReadings
}

/** 长输出候选的起步阈值，待校准（§27.3 的语义层判断本就允许调参）。 */
export const DEFAULT_BULKY_OUTPUT_THRESHOLD = 2000

/**
 * 收集一次上下文质量信号（§27.3 表格逐行）。
 *
 * 任务侧权威输入（必需清单、版本引用、结构化矛盾）由调用方传入——适配层只观测宿主面，
 * 不替任务侧编造"这个已送达/这个还有效"。dsh-context 缺席时：各分量标 `unavailable/未知`，
 * 覆盖不足如实报告，容量仍走原生读数（§27.2）。
 */
export function collectContextQuality(input: ContextQualityInput): ContextQualityCollection {
  const reads = readDshContext(input.host, input.session)
  const budget = input.nativeBudget ?? readNativeBudget(input.host, input.session)
  const readings =
    input.readings ??
    buildReadings({ reads, budget, settings: input.settings, envelope: readSessionEnvelope(input.session) })
  const details = readings.details
  const degradations: string[] = []
  pushDegradation(degradations, reads.timeline)
  pushDegradation(degradations, reads.headers)
  pushDegradation(degradations, reads.activity)
  if (budget.status !== 'ok') degradations.push(`原生容量读数不可用：${budget.note}`)
  if (reads.timeline.availability === 'ok' && !details.loaded) degradations.push('时间线只有轻量头：占用分量可读，长输出与事件明细要走 /api/dsh-context/detail 按需通道；未加载不等于没有')

  const capacityCaveats = [
    // 界面侧的压缩预留/触发比例（上游 client 的展示值与出厂默认）在本包的面上根本读不到：
    // `contextHeaders` 只有 epoch 列表（`lib/index.d.ts:37-39`），没有任何预留字段。
    '容量压力的执行阈值取当前有效 DSH 配置与请求预算；dsh-context 的折算值与界面值只作解释，不作执行阈值，镜像的出厂默认同样不作执行阈值（§27.1、§27.2）',
    `按类别占用：系统 ${readings.occupancy.system ?? '未知'}、工具 ${readings.occupancy.tools ?? '未知'}、用户 ${readings.occupancy.user ?? '未知'}、注入 ${readings.occupancy.inject ?? '未知'}、技能 ${readings.occupancy.skill ?? '未知'}、助手 ${readings.occupancy.assistant ?? '未知'}、工具结果 ${readings.occupancy.tool ?? '未知'}、合计 ${readings.occupancy.total ?? '未知'}（contextTimeline.current）`,
  ]
  if (readings.outputReserve !== null) capacityCaveats.push(`输出预留 R=${readings.outputReserve.value} 来源=${readings.outputReserve.provenance}`)
  if (readings.windowMismatch !== null) capacityCaveats.push(`窗口口径不一致：原生 ${readings.windowMismatch.native} vs 投影 ${readings.windowMismatch.timeline}`)
  const capacity: CapacitySignals =
    budget.status === 'ok'
      ? {
          requestEstimateTokens: budget.requestEstimateTokens,
          ...(readings.outputReserve === null ? {} : { outputReserveTokens: readings.outputReserve.value }),
          ...(readings.contextWindowTokens === null ? {} : { contextWindowTokens: readings.contextWindowTokens }),
          ...(budget.source === undefined ? {} : { estimateSource: budget.source }),
          caveats: capacityCaveats,
        }
      : { unavailable: `原生容量读数不可用：${budget.note}` }

  const coverageCaveats: string[] = ['回执来自任务侧 ContextReceipt；适配层不代替它判断"已理解"（§22.3）']
  if (reads.timeline.availability !== 'ok') coverageCaveats.push(`时间线不可用（${reads.timeline.availability}）：无法从观测面复核关键依据是否进入本次请求`)
  // 轻量头 / 被截断 / 近似重建三种部分服务形态各自限制覆盖口径：都不能算"清单已看全"（§27.1）。
  else if (details.split || details.truncated || details.reconstructed) coverageCaveats.push(`时间线服务清单不完整（${details.note}）：覆盖核对只依赖送达回执`)
  const coverage: CoverageSignals = { required: input.required, caveats: coverageCaveats }

  const freshnessCaveats: string[] = []
  if (reads.timeline.availability !== 'ok') freshnessCaveats.push(`时间线不可用（${reads.timeline.availability}）：新鲜度只按任务侧版本引用核对`)
  else if (details.split || details.truncated || details.reconstructed || details.zeroed) freshnessCaveats.push(details.note)
  const freshness: FreshnessSignals = { refs: input.versionRefs ?? [], caveats: freshnessCaveats }

  const consistency: ConsistencySignals = {
    structural: input.structuralFindings ?? [],
    claimSides: input.claimSides ?? [],
    caveats: ['自然语言矛盾是语义判断：本适配层不做模型调用，语义层由调用方在里程碑/拟压缩时触发（§27.3）'],
  }

  const relevance = deriveRelevance(reads.timeline, details, input.bulkyOutputThreshold ?? DEFAULT_BULKY_OUTPUT_THRESHOLD)

  const continuity = deriveContinuity(reads, input)

  const behaviorRegression = deriveBehaviorRegression(reads)

  const signals: QualitySignals = {
    capacity,
    coverage,
    freshness,
    consistency,
    relevanceRedundancy: relevance,
    continuity,
    behaviorRegression,
    context: {
      ...(input.historyBloat === undefined ? {} : { historyBloat: input.historyBloat }),
      ...(input.taskSwitch === undefined ? {} : { taskSwitch: input.taskSwitch }),
      progressContinues: input.progressContinues === true,
      uniqueComplexDetail: input.uniqueComplexDetail === true,
    },
  }
  return {
    signals,
    degradations,
    fingerprint: observationFingerprint({ budget, timeline: reads.timeline, headers: reads.headers, activity: reads.activity }),
    reads,
    details,
    readings,
  }
}

/** 节点身份只到 `seq`（投影面上没有 ref/persisted/toolCallId）。 */
function nodeRef(node: SurfaceNodeLike): string {
  return `node:${node.seq ?? 'unknown'}`
}

/** 注入/技能节点的可读标签：生产者身份优先，其次形态与工具名。 */
function nodeLabel(node: SurfaceNodeLike): string {
  const label = str(node.name) ?? str(node.skill) ?? str(node.form) ?? str(node.tool) ?? ''
  return `${node.cat ?? 'unknown'}:${label}`
}

function deriveRelevance(
  read: ProjectionRead<ContextTimelineStateLike>,
  details: TimelineDetailView,
  threshold: number,
): RelevanceRedundancySignals {
  if (read.availability !== 'ok') {
    return { unavailable: `相关性与冗余观测面不可用（${read.availability}）：${read.note}` }
  }
  if (details.zeroed) return { unavailable: '时间线是低于基线的零值兜底：不作为裁剪依据（§27.1）' }
  if (!details.loaded) {
    // slim head：占用分量仍可读，长输出/重复类判断降级为未知，不把"没看到详情"写成"没有长输出"（§27.1）。
    return {
      detailIncomplete: `时间线只有轻量头（detailRev 在场、requests/events/nodes 是空占位），未加载详情：不能判断长工具输出占用与重复（§27.1）`,
      caveats: ['详情走 /api/dsh-context/detail 按需通道：读不到不等于没有'],
    }
  }
  // 历史近似重建：裁剪下限之前的已移除节点/档案/文件操作可能缺失，重复项与"哪些已经不在场"都数不全，
  // 因此这份清单可作解释但不作裁剪依据（§27.1 要求它与"被截断"分开处理，也不得退化成"没有异常"）。
  if (details.reconstructed) {
    return {
      unavailable: `时间线的历史段落近似重建，清单数不全：${details.note}；不作为裁剪依据，未判定不等于健康（§27.1）`,
    }
  }
  const state = read.state ?? {}
  const nodes = objects(state.nodes)
  const caveats: string[] = []
  const bulkyOutputs: BulkyOutputSignal[] = nodes
    .filter((node) => (num(node.tokens) ?? 0) >= threshold)
    .map((node) => ({
      ref: nodeRef(node),
      approxTokens: num(node.tokens),
      // 投影面上没有持久副本与调用配对标记：一律留空，由 core 按"不可剪"处理（§27.4 不能直接推导栏）。
      toolCallPaired: undefined,
      persistedCopy: undefined,
    }))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
  if (bulkyOutputs.length > 0) caveats.push('contextTimeline 的节点面不给持久副本与工具调用配对：长输出候选一律按不可剪处理（§27.4）')
  const buckets = new Map<string, number>()
  for (const node of nodes) {
    if (node.cat !== 'inject' && node.cat !== 'skill') continue
    const label = nodeLabel(node)
    if (label.endsWith(':')) continue
    buckets.set(label, (buckets.get(label) ?? 0) + 1)
  }
  const repeats: RepeatedSignal[] = [...buckets.entries()]
    .filter(([, count]) => count > 1)
    .map(([label, count]) => ({ ref: label, kind: 'unknown' as const, count }))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
  caveats.push('重复项是否具有独立证据意义需语义裁决：裁剪只走受支持的引用路径，原件不删（§27.3）')
  // 被截断（`droppedNodes` > 0）：未服务的是**非固定**的较早活节点，注入/技能节点按上游口径始终随值服务
  // （`lib/index.d.ts:295-299`），所以重复项数得全、长输出候选只是被少数；如实限制覆盖口径即可，
  // 不能把"没在清单里看到"写成"没有"（§27.1）。
  if (details.truncated) caveats.push(`服务清单被截断：候选只覆盖已服务部分（${details.note}）`)
  return { bulkyOutputs, repeats, caveats }
}

/**
 * 连续性分量。
 *
 * `contextActivity` 是按日的用量台账（`src/host/activity.ts:60-62`），面上没有在途项与待交接项，
 * 所以在途只能按任务侧记录核对；适配层不替它编造 `inFlight`（§27.3 限制栏）。
 */
function deriveContinuity(reads: DshContextReads, input: ContextQualityInput): ContinuitySignals {
  const unverifiedFacts = input.unverifiedFacts ?? []
  const read = reads.activity
  const caveats: string[] = []
  const inFlight: InFlightSignal[] = []
  if (read.availability !== 'ok') {
    caveats.push(`活动投影不可用（${read.availability}）：在途项只按任务侧记录核对，不等于没有未决项`)
  } else {
    caveats.push('contextActivity 是按日用量台账，不含在途项与待交接项：在途只按任务侧记录核对，投影缺席不等于没有未决项（§27.3）')
  }
  const days = read.state?.days ?? {}
  const keys = Object.keys(days).sort()
  if (keys.length > 0) {
    const newest = days[keys[keys.length - 1]!] ?? {}
    caveats.push(`台账最近一日 ${keys[keys.length - 1]}：请求 ${num(newest.requests) ?? 0} 次、计费 ${num(newest.tokens) ?? 0} token（用量面，不是占用面）`)
  }
  return {
    inFlight,
    ...(unverifiedFacts.length === 0 ? {} : { unverifiedFacts }),
    ...(input.nextAction === undefined ? {} : { nextAction: input.nextAction }),
    caveats,
  }
}

/**
 * 行为线索分量。
 *
 * 真实面上唯一可推出的重复线索是同一 skill 在台账里被反复载入（`ActivityDay.skills`，
 * `src/shared/types.ts:70-71`）；`repeatedQuestions`/`revokedReuse` 面上不存在，一律不产出。
 */
function deriveBehaviorRegression(reads: DshContextReads): BehaviorRegressionSignals {
  const read = reads.activity
  if (read.availability !== 'ok') return { unavailable: `行为线索观测面不可用（${read.availability}）：${read.note}` }
  const days = read.state?.days ?? {}
  const loads = new Map<string, number>()
  for (const day of Object.values(days)) {
    for (const [name, tally] of Object.entries(day?.skills ?? {})) loads.set(name, (loads.get(name) ?? 0) + (num(tally?.n) ?? 0))
  }
  const repeated = [...loads.entries()]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => `skill:${name} 载入 ${count} 次`)
    .sort()
  return {
    ...(repeated.length === 0 ? {} : { repeatedDoneWork: repeated }),
    caveats: ['用量台账只给得出同一 skill 的重复载入次数：是否重复做同一件工作需语义裁决，不作根因结论（§27.3）'],
  }
}

/**
 * 压缩后保留清单的观测来源：只认已内联的服务清单，读不到就返回空清单（由调用方按"未知"处理）。
 * 身份是投影给的 `node:<seq>` / `archive:<seq>` / `event:<seq>`；任务侧引用由调用方自行对照。
 */
export function retainedRefs(read: ProjectionRead<ContextTimelineStateLike>): string[] {
  const view = timelineDetails(read)
  if (!view.loaded) return []
  const state = read.state ?? {}
  const refs = new Set<string>()
  for (const node of objects(state.nodes)) if (num(node.seq) !== undefined) refs.add(nodeRef(node))
  for (const node of objects(state.archive)) if (num(node.seq) !== undefined) refs.add(`archive:${node.seq}`)
  for (const event of objects(state.events)) if (num(event.seq) !== undefined) refs.add(`event:${event.seq}`)
  return [...refs].sort()
}

// —— §27.5 第 3、4 条：压缩入口与"调用后核对再落盘" ——

export type CompactionStatus = 'completed' | 'busy' | 'changed' | 'refused' | 'error'

export interface CompactionCallResult {
  readonly status: CompactionStatus
  readonly detail: string
  readonly reclaimedTokens?: number
}

/**
 * 原生压缩入口的窄接口（本文件内定义，不改 host-types.ts）。
 *
 * §27.5 末段的硬事实：本机 `compactNow` 会直接提交摘要，本次未确认存在"提交前自定义摘要验收"钩子，
 * 因此本接口**不**提供"先审后提交"的语义验收；调用后一律走 `verifyPostCompaction` 核对。
 * 只能从支持的 idle 维护入口调用（由 `planActionRun` 把关），并遵守轮换共享的互斥入口。
 */
export interface CompactionPort {
  compactNow(session: unknown): Promise<CompactionCallResult>
}

export interface CompactionInvocation {
  readonly called: boolean
  readonly status: CompactionStatus | 'not_run'
  readonly detail: string
  /** busy/changed/refused/error/not_run 的即时结论；completed 必须先核对再定论（§27.5 第 4 条）。 */
  readonly immediateOutcome?: ActionOutcomeInput
  readonly verifyRefs: readonly string[]
  readonly verifyHint: string
}

/**
 * 按 `planActionRun` 的结论调用压缩入口（§27.5 第 3 条）。
 *
 * 计划不是 `run_now` 就**不调用**；没有入口就不假装压缩；busy/changed 映射成"按实际状态核对、
 * 禁止忙循环重试"的失败结论，而不是重新排队。`completed` 只代表调用返回，闭环由核对决定。
 */
export async function invokeCompaction(input: {
  readonly plan: ActionRunPlan
  readonly freeze: AssessmentFreeze
  readonly session: unknown
  readonly compaction?: CompactionPort
}): Promise<CompactionInvocation> {
  const verifyRefs = [...input.freeze.retentionList]
  const verifyHint = '调用返回后逐项核对：目标保留清单、关键引用可解析性、新请求容量与当前有效版本；缺项从权威状态重建，必要时安全轮换（§27.5 第 4 条）'
  if (input.plan.kind !== 'run_now') {
    return {
      called: false,
      status: 'not_run',
      detail: input.plan.reason,
      immediateOutcome: { kind: 'declined', detail: input.plan.reason },
      verifyRefs,
      verifyHint: '未调用压缩：按 planActionRun 的结论排队或跳过（§27.5 第 3 条）',
    }
  }
  if (input.compaction === undefined) {
    return {
      called: false,
      status: 'not_run',
      detail: '本部署没有可用的压缩入口',
      immediateOutcome: { kind: 'declined', detail: '本部署没有可用的压缩入口：不假装已压缩，保留原生容量保护（§27.2）' },
      verifyRefs,
      verifyHint,
    }
  }
  let result: CompactionCallResult
  try {
    result = await input.compaction.compactNow(input.session)
  } catch (error) {
    return {
      called: true,
      status: 'error',
      detail: `compactNow 抛错：${message(error)}`,
      immediateOutcome: { kind: 'failed', detail: `compactNow 抛错：${message(error)}` },
      verifyRefs,
      verifyHint,
    }
  }
  if (result.status === 'completed') {
    return { called: true, status: 'completed', detail: result.detail, verifyRefs, verifyHint }
  }
  if (result.status === 'busy' || result.status === 'changed') {
    return {
      called: true,
      status: result.status,
      detail: result.detail,
      immediateOutcome: { kind: 'busy', detail: `${result.status}：${result.detail}` },
      verifyRefs,
      verifyHint,
    }
  }
  return {
    called: true,
    status: result.status,
    detail: result.detail,
    immediateOutcome: { kind: 'declined', detail: `${result.status}：${result.detail}` },
    verifyRefs,
    verifyHint,
  }
}

/**
 * 压缩后核对的结论 → 动作结果（§27.5 第 4、5 条）。
 *
 * `completed` 才算"待核对"：核对通过才 done，缺项走 shortfall（重建/轮换，不反复压缩）；
 * 未调用或失败的直接给即时结论，不产生 done。
 */
export function outcomeAfterVerification(invocation: CompactionInvocation, report: PostCompactionReport): ActionOutcomeInput {
  if (invocation.status !== 'completed') {
    return invocation.immediateOutcome ?? { kind: 'declined', detail: invocation.detail }
  }
  if (!report.ok) {
    const missing = report.missing.length > 0 ? report.missing : ['压缩后核对未通过但未列出缺项：按不可通过处理']
    return { kind: 'shortfall', missing }
  }
  return {
    kind: 'done',
    effect: {
      restoredInfo: true,
      costNote: report.capacityNote === undefined ? '压缩后核对通过：保留清单、引用可解析、版本一致' : `压缩后核对通过；${report.capacityNote}`,
    },
  }
}

// —— 能力探测（结构一致 ≠ 语义一致，与 adapter/capabilities.ts 同一口径） ——

/**
 * dsh-context 投影探测（§27.1 已核实能力的结构面）。
 *
 * 只查"投影注册表在不在、三个投影名能不能按上游源码核实的字段读"；"读数是否与原生压缩口径一致"
 * 属于真机联网核对，必须写在 `liveCheck` 里，不能因为结构对上了就宣布能力可用。
 */
export function probeDshContext(host: Pick<HostSlice, 'sessionProjections'>): ProbeResult {
  const registry = host.sessionProjections as ProjectionValueSourceLike | undefined
  const shape: Shape =
    registry === undefined || typeof registry !== 'object'
      ? 'missing'
      : typeof registry.snapshot === 'function'
        ? 'partial'
        : typeof registry.stateOf === 'function'
          ? 'partial'
          : 'missing'
  const valueRead = typeof registry?.snapshot === 'function'
  return {
    id: 'dsh-context-projections',
    shape,
    evidence:
      `${registry === undefined || typeof registry !== 'object' ? '投影注册表未装载' : valueRead ? '投影注册表可按 snapshot() 读投影响应值' : '只有 stateOf()：读到的是 fold state，面不同'}；` +
      `按源码核实只认 ${DSH_CONTEXT_PROJECTIONS.timeline}/${DSH_CONTEXT_PROJECTIONS.headers}/${DSH_CONTEXT_PROJECTIONS.activity} 三个投影名（dsh-context src/host/index.ts:68-70），` +
      '不通过截图或抓取 UI 取调度数据，也不导入未公开内部文件；已安装 0.70.0，源码快照是 0.71.0（同族，timeline stateVersion 28 一致）',
    liveCheck:
      '在部署 profile 上核对：三个投影名可读且随会话推进更新；contextTimeline 的 contextWindow/maxOutputTokens 与 requestContext/requestHeader 的直读值同源；' +
      '四种退化形态要分开核对且不得合并成"没有异常"：未加载 / 截断 / 近似重建 / 真实空集合——轻量头与内联值的判据是 detailRev（或 heads 清单）在场' +
      '且 requests/events/nodes 全是空占位，缓存行把全集带回来时 detailRev 也在场但那是内联值；截断看 droppedNodes，近似重建看 surfaceFloor/archiveFloor/fileOpsFloor' +
      '（`lib/index.d.ts:280-309`）；H 与 r 无读取路径，未打开 acceptMirroredCompactionDefaults 时轮换线必须停在 observation（§27.1）',
    degrade:
      '读不到即分量标 unknown 并报告覆盖不足；保留原生容量保护，不用零值回退当健康，也不阻止接近硬容量时的原生兜底（§27.2、§27.4）',
  }
}

// —— 工具 ——

function pushDegradation(target: string[], read: ProjectionRead<unknown>): void {
  if (read.availability !== 'ok') target.push(read.note)
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 集合面逐个过一遍形态：宿主投影是 last-wins 的公开值，形态外条目只能跳过，不能读成 0。 */
function objects<T>(items: readonly T[] | undefined): readonly T[] {
  return Array.isArray(items) ? items.filter((item) => item !== null && typeof item === 'object') : []
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
