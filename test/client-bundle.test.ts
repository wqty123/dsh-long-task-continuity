/**
 * 浏览器半（`client.js`）装载契约回归（审阅 R8 / 实施计划第 6 步，#52 只读任务页）。
 *
 * 锚点（本机 `<DSH 源码>` @ v0.2.1-alpha.1，只读引用）：
 * - `packages/client/ui-sidebar-right/src/client/index.ts:203-278`：右侧页签两段式注册——
 *   先 `sidebarRightTabs.register({ id, kind, title, guide })`，再用**定义 id** 作 key
 *   注入 `sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title` 两个键位座位；
 * - `packages/client/ui-sidebar-right/src/client/tab-registry.ts`：重复 id / 重复 guide id
 *   直接抛错（所以守卫与回滚必须自备）；
 * - `packages/client/ui-workspace/src/client/navigation.ts:34-39`：`openSession(SessionTarget)`；
 * - 现网同款写法（`<DSH_HOME>\profiles\web\node_modules\dsh-context\lib\client.js`）：
 *   `ctx.inject` 单依赖守卫 + 注入回调返回清理函数。
 *
 * 本文件只验装载契约，不渲染 React、不触 DOM：用假 `window.__ModuleLoader__` 捕获工厂，
 * 用存根 require 求值整包，再驱动 `apply`。假宿主按「座位已存在」语义同步物化座位工厂，
 * 与服务缺失时的不物化路径分开覆盖。`client.js` 不在 `tsconfig.check-all.json` 的静态面内
 * （浏览器半手写、无类型标注），这里补的就是它的行为面。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PLUGIN_TOOL_NAMES } from '../src/adapter/tools.ts'
import { WORKBENCH_KIND, WORKBENCH_PATH } from '../src/views/workbench.ts'

const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const CLIENT_ID = 'dsh-long-task-continuity'
const CONTINUITY_NS = 'continuity'
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'
const WORKBENCH_ID = 'continuity-workbench'

type Host = Record<string, unknown>

interface GuideEntry {
  readonly id: string
  readonly order?: number
  readonly title?: () => string
  readonly description?: () => string
  readonly icon?: unknown
}

interface TabDefinition {
  readonly id: string
  readonly kind: string
  readonly title: () => string
  readonly guide?: readonly GuideEntry[]
}

interface SlotOptions {
  readonly name: string
  readonly key: string
  readonly locale?: string
}

interface SlotRegistration extends SlotOptions {
  readonly component: unknown
}

interface Bundle {
  readonly name: string
  readonly inject: readonly string[]
  readonly apply: (ctx: unknown) => void
}

interface ServiceInject {
  readonly deps: readonly string[]
  readonly callback: (host: Host) => unknown
}

interface SeatInject {
  readonly seat: string
  readonly create: () => unknown
}

interface HarnessOptions {
  readonly failTabRegistration?: boolean
  readonly failSeat?: string
}

interface SlotService {
  register(spec: SlotOptions, component: unknown): () => void
  inject(seat: string, create: () => unknown): () => void
}

interface Harness {
  readonly bundle: Bundle
  readonly ctx: unknown
  readonly slots: SlotService
  readonly tabs: { register(definition: TabDefinition): () => void }
  readonly registrations: readonly SlotRegistration[]
  readonly disposed: readonly string[]
  readonly tabDefinitions: readonly TabDefinition[]
  readonly serviceInjects: readonly ServiceInject[]
  readonly seatInjects: readonly SeatInject[]
  t(key: string): string
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const registrations: SlotRegistration[] = []
  const disposed: string[] = []
  const tabDefinitions: TabDefinition[] = []
  const serviceInjects: ServiceInject[] = []
  const seatInjects: SeatInject[] = []
  const dictionaries = new Map<string, Record<string, string>>()

  const slots: SlotService = {
    register(spec: SlotOptions, component: unknown): () => void {
      if (options.failSeat === spec.name) throw new Error(`slot seat ${spec.name} rejected`)
      registrations.push({ name: spec.name, key: spec.key, locale: spec.locale, component })
      return () => { disposed.push(`slot:${spec.name}:${spec.key}`) }
    },
    inject(seat: string, create: () => unknown): () => void {
      seatInjects.push({ seat, create })
      // 座位已存在：宿主立即物化，工厂抛错按真实行为向上传播（由调用方守卫）。
      const seatDispose = create()
      return () => { if (typeof seatDispose === 'function') seatDispose() }
    },
  }

  const tabs = {
    register(definition: TabDefinition): () => void {
      if (options.failTabRegistration === true) throw new Error(`tab ${definition.id} rejected`)
      tabDefinitions.push(definition)
      return () => { disposed.push(`tab:${definition.id}`) }
    },
  }

  const locale = {
    register(namespace: string, bundles: Record<string, Record<string, string>>): () => void {
      const zh = bundles['zh']
      if (zh !== undefined) dictionaries.set(namespace, zh)
      return () => { dictionaries.delete(namespace) }
    },
    bind(namespace: string): (key: string) => string {
      return (key) => dictionaries.get(namespace)?.[key] ?? key
    },
  }

  const ctx = {
    effect(callback: () => unknown): unknown { return callback() },
    inject(deps: readonly string[], callback: (host: Host) => unknown): () => void {
      serviceInjects.push({ deps, callback })
      return () => {}
    },
    slots,
    locale,
  }

  let captured: { readonly id: string, readonly factory: (require: (id: string) => unknown) => unknown } | undefined
  const fakeWindow = {
    __ModuleLoader__: {
      load(entry: { readonly id: string, readonly factory: (require: (id: string) => unknown) => unknown }): void {
        captured = entry
      },
    },
  }
  const evaluate = Function('window', CLIENT_SOURCE) as unknown as (scope: unknown) => void
  evaluate(fakeWindow)
  if (captured === undefined) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  const entry = captured
  assert.equal(entry.id, CLIENT_ID)

  const reactStub = {
    createElement: (...args: readonly unknown[]) => ({ args }),
    Fragment: Symbol('react.Fragment'),
    useCallback: (fn: unknown) => fn,
    useEffect: () => {},
    useMemo: (fn: () => unknown) => fn(),
    useState: (value: unknown) => [value, () => {}],
  }
  const primitivesStub = new Proxy({}, { get: () => function PrimitiveStub(): null { return null } })
  const requireStub = (id: string): unknown => {
    if (id === 'react') return reactStub
    if (id === PRIMITIVES) return primitivesStub
    throw new Error(`client.js 请求了未声明的模块：${id}`)
  }

  return {
    bundle: entry.factory(requireStub) as Bundle,
    ctx,
    slots,
    tabs,
    registrations,
    disposed,
    tabDefinitions,
    serviceInjects,
    seatInjects,
    t: (key: string): string => locale.bind(CONTINUITY_NS)(key),
  }
}

function serviceInject(harness: Harness, dependency: string): ServiceInject {
  const entry = harness.serviceInjects.find((row) => row.deps.length === 1 && row.deps[0] === dependency)
  assert.ok(entry, `apply 必须对 ${dependency} 做可选注入`)
  return entry
}

function asDisposer(value: unknown): () => void {
  assert.equal(typeof value, 'function')
  return value as () => void
}

test('浏览器半：无宿主可选服务时 apply 守卫通过，工具行与字典照常注册（#52 不许拖垮既有面）', () => {
  const harness = makeHarness()
  assert.equal(harness.bundle.name, CLIENT_ID)
  assert.deepEqual(harness.bundle.inject, ['slots', 'locale'])
  assert.equal(typeof harness.bundle.apply, 'function')
  assert.doesNotThrow(() => { harness.bundle.apply(harness.ctx) })

  assert.deepEqual(harness.serviceInjects.map((row) => [...row.deps]), [['configForms'], ['uiWorkspace'], ['sidebarRightTabs']])
  assert.equal(harness.tabDefinitions.length, 0, '服务缺席时不许注册页签')

  const toolviewSeats = harness.seatInjects.filter((row) => row.seat === 'tool.call.toolview')
  assert.equal(toolviewSeats.length, PLUGIN_TOOL_NAMES.length, '工具行数须与 src/adapter/tools.ts 的 continuity_* 同数')
  const toolviews = harness.registrations.filter((row) => row.name === 'tool.call.toolview')
  assert.equal(toolviews.length, PLUGIN_TOOL_NAMES.length)
  const keys = toolviews.map((row) => row.key)
  assert.equal(new Set(keys).size, PLUGIN_TOOL_NAMES.length, '键位不许重复')
  // 集合相等（不比顺序）：卡片面缺一个、多一个、或名字写错都必须在这里失败，
  // 否则"注册了 22 个工具但只画 21 张卡"这种半接线会一路静默到界面上。
  assert.deepEqual([...keys].sort(), [...PLUGIN_TOOL_NAMES].sort(), '工具卡片面必须与声明清单同一集合')
  for (const row of toolviews) {
    assert.equal(row.locale, CONTINUITY_NS)
    assert.match(row.key, /^continuity_/)
  }
  assert.ok(keys.includes('continuity_status'))
  assert.ok(keys.includes('continuity_claim_task'))
  assert.equal(harness.t('wb.tab.title'), '任务面板', '字典须在 apply 内注册且默认中文')
})

test('浏览器半：#52 页签走 sidebarRightTabs 两段式注册，座位键=定义 id，清理按逆序释放', () => {
  const harness = makeHarness()
  harness.bundle.apply(harness.ctx)
  const dispose = asDisposer(serviceInject(harness, 'sidebarRightTabs').callback({ sidebarRightTabs: harness.tabs, slots: harness.slots }))

  assert.equal(harness.tabDefinitions.length, 1)
  const definition = harness.tabDefinitions[0]
  assert.ok(definition)
  assert.equal(definition.id, WORKBENCH_KIND)
  assert.equal(definition.kind, WORKBENCH_KIND)
  assert.equal(definition.title(), '任务面板')

  const guide = definition.guide ?? []
  assert.equal(guide.length, 1)
  const head = guide[0]
  assert.ok(head)
  assert.equal(head.id, WORKBENCH_KIND)
  assert.equal(head.order, 40)
  assert.equal(head.title?.(), '任务面板')
  assert.match(head.description?.() ?? '', /^只读工作台/)
  assert.equal(typeof head.icon, 'function')

  const seats = harness.seatInjects.filter((row) => row.seat.startsWith('sidebar.right.pane.tab'))
  assert.deepEqual(seats.map((row) => row.seat), ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
  const keyed = harness.registrations.filter((row) => row.name.startsWith('sidebar.right.pane.tab'))
  assert.equal(keyed.length, 2)
  for (const row of keyed) {
    assert.equal(row.key, WORKBENCH_KIND)
    assert.equal(row.locale, CONTINUITY_NS)
    assert.equal(typeof row.component, 'function')
  }
  assert.notEqual(keyed[0]?.component, keyed[1]?.component, '正文与标题必须是两个组件')

  dispose()
  assert.deepEqual(harness.disposed, [
    `slot:sidebar.right.pane.tab.title:${WORKBENCH_KIND}`,
    `slot:sidebar.right.pane.tab:${WORKBENCH_KIND}`,
    `tab:${WORKBENCH_KIND}`,
  ])
})

test('浏览器半：#52 页签注册抛错时吞掉并回滚已注册的座（tab-registry 重复 id 会抛）', () => {
  const errors: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]): void => { errors.push(args) }
  try {
    const rejectedTab = makeHarness({ failTabRegistration: true })
    rejectedTab.bundle.apply(rejectedTab.ctx)
    const first = serviceInject(rejectedTab, 'sidebarRightTabs')
    let firstResult: unknown = 'unset'
    assert.doesNotThrow(() => { firstResult = first.callback({ sidebarRightTabs: rejectedTab.tabs, slots: rejectedTab.slots }) })
    assert.equal(firstResult, undefined, '失败路径不返回清理函数')
    assert.deepEqual(rejectedTab.seatInjects.filter((row) => row.seat !== 'tool.call.toolview'), [], '页签失败后不再注入座位')
    assert.deepEqual(rejectedTab.registrations.filter((row) => row.name !== 'tool.call.toolview'), [])

    const rejectedSeat = makeHarness({ failSeat: 'sidebar.right.pane.tab' })
    rejectedSeat.bundle.apply(rejectedSeat.ctx)
    const second = serviceInject(rejectedSeat, 'sidebarRightTabs')
    assert.doesNotThrow(() => { second.callback({ sidebarRightTabs: rejectedSeat.tabs, slots: rejectedSeat.slots }) })
    assert.deepEqual(rejectedSeat.disposed, [`tab:${WORKBENCH_KIND}`], '半注册必须回滚已登记的页签')
    assert.deepEqual(rejectedSeat.registrations.filter((row) => row.name !== 'tool.call.toolview'), [])
    const seatRows = rejectedSeat.seatInjects.filter((row) => row.seat.startsWith('sidebar.right.pane.tab'))
    assert.deepEqual(seatRows.map((row) => row.seat), ['sidebar.right.pane.tab'], '第二个座位不再尝试')

    assert.equal(errors.length, 2, '两条失败各记录一次 console.error')
    for (const entry of errors) assert.match(String(entry[0]), /dsh-long-task-continuity\] workbench tab registration failed/)
  } finally {
    console.error = original
  }
})

test('浏览器半：#52 会话跳转只在 uiWorkspace 服务可用时接线', () => {
  const harness = makeHarness()
  harness.bundle.apply(harness.ctx)
  const entry = serviceInject(harness, 'uiWorkspace')

  assert.equal(entry.callback({}), undefined)
  assert.equal(entry.callback({ uiWorkspace: {} }), undefined)
  assert.equal(entry.callback({ uiWorkspace: { openSession: 41 } }), undefined)

  const seen: unknown[] = []
  const dispose = asDisposer(entry.callback({ uiWorkspace: { openSession: (target: unknown) => { seen.push(target) } } }))
  dispose()
  assert.deepEqual(seen, [])
})

test('浏览器半：#52 页面只读——路由与宿主投影同源，且客户端只发这一条 GET', () => {
  assert.equal(WORKBENCH_PATH, '/api/continuity.workspace')
  assert.ok(CLIENT_SOURCE.includes(`"${WORKBENCH_PATH.replace(/^\//, '')}"`), 'client.js 必须以文档相对形式引用同一路由')
  assert.ok(CLIENT_SOURCE.includes(`"${WORKBENCH_ID}"`), 'client.js 页签 id 须与宿主投影的 WORKBENCH_KIND 同字面量')
  assert.equal(/\bmethod\s*:/.test(CLIENT_SOURCE), false, '客户端不得携带写方法')
  // 只读面有两处：工作台投影与纪律投影。断言不再是"只有一处"，
  // 而是"每一处都指向只读投影路由"——比数量更能防住写入型请求混进来。
  const fetches = CLIENT_SOURCE.split('\n').filter((line) => line.includes('fetch('))
  assert.equal(fetches.length, 2, '只读面共两处 fetch：工作台投影与纪律投影')
  for (const line of fetches) {
    assert.ok(
      line.includes('WORKBENCH_PATH') || line.includes('DISCIPLINE_PATH'),
      '每一处 fetch 都必须指向只读投影路由：' + line.trim(),
    )
  }
})
