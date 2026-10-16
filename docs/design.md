# dsh-long-task-continuity

DSH（DeepSeek Harness）插件：长期任务的台账、执行权、检查点、交接与恢复。
实现依据是同目录的 `../DSH长期任务连续性与混合多代理框架_设计稿_v0.5_20261014.md`（1517 行；本文 §n 均指该稿章节）。

**当前版本 0.2.0**（变更记录见 `CHANGELOG.md`）。状态页 `/continuity status` 首行会打印 `插件 v0.2.0`——这是判断真机到底跑的是哪一版的最快入口。

当前状态：已装载到本机 web profile（部署副本 `<DSH_HOME>\plugins\dsh-long-task-continuity`，挂载行 `<DSH_HOME>\profiles\web\cordis.patch.yml:43-69`，web profile 的 `node_modules\dsh-long-task-continuity` 是指向它的 Junction）。本仓库是源码与口径的所在地，部署副本不由本仓库自动同步；改完源码要重新 `npm run build` 并同步过去才在真机生效。src 与部署副本的版本标识必须一致，不一致就是同步漏了。

## 1. 这个插件解决什么

跨周、跨月的长任务会在会话里断掉：换会话、关进程、宿主重启之后，"现在在做什么、谁在做、已经验证了什么、为什么停下、下一步怎么继续"只能靠翻聊天记录重猜（设计稿 §1、§2）。本插件把这五问落成一份持久记录加一组写入与核对入口：

- **台账单一真源**：一个 Mission 一条 `MissionControl` 记录（`src/core/control.ts:165`），任务、执行尝试、检查点、产物、验收、操作、轮换、outbox、预算、事件都在同一条记录里；所有写路径统一走 `kernel.submit` 的读—改—CAS 提交（`src/core/kernel.ts:169`）。
- **执行权租约**：认领任务即签发 `leaseVersion: 1` 的租约并写到期时点（`src/core/commands.ts:1044-1075`）；写检查点、提交结果、登记验收都按当前 Attempt 核对版本（`src/core/lease.ts:16-26`）。
- **租约心跳**：宿主 `agent/status` 给出在跑的会话名单，每 15 秒续一次期，只改时点不推进 revision；会话从非 running 回到 running 的当时还补一次定向续期，不等下一个 tick（第 7 节）。
- **恢复核对**：装载即跑 `bootRecover`，先把每条记录的业务入场关掉，再按核对结论逐个放开（`src/index.ts:634-641`，设计稿 §11.1）；过期租约只进待核对名单，不自动收回（`src/index.ts:1227-1234`）。
- **交接包**：8 段结构（`src/rotation/brief.ts:25-34`）、4096 token 叙述预算与固定截断顺序（`src/rotation/brief.ts:51-52,253`）。
- **换会话判定**：轮换线的三个口径读不到就停在 `observation`，自动侧不换会话（`src/rotation/lines.ts:67-82`）。
- **注册面**：21 个 `continuity_*` 工具（§14）与 `/continuity` 命令组（§15.2），默认都不注册，由设置逐项放开（第 5、6、8 节）。

## 2. 目录与模块清单

`src` 共 41 个 `.ts`、25,124 行（`Get-Content | Measure-Object -Line` 口径，2026-10-15 复审二轮后重算）。分层规则写在 `src/index.ts:1-24`：`src/core`、`src/rotation`、`src/team` 是纯数据，`src/adapter` 与 `src/views` 只接结构化视图，`src/index.ts` 是唯一装配运行时的入口——因此装载之前就能用 `node --test` 跑完全部判定逻辑。**这条规则有一个真实例外**：`src/adapter/tools.ts:18` 直接 `import { defineTool } from '@deepseek-ai/dsh-tools'`，只拿这一个工具构造口，不碰装配；源码头注 `:4-6` 已按这个事实写明，不要再把它读成"只有 `index.ts`  import 宿主"。

### 2.1 `src/core/`（20 个，纯数据）

| 文件 | 行数 | 一行职责（设计稿出处） |
| --- | --- | --- |
| `src/core/entities.ts` | 1297 | 实体与枚举（`src/core/entities.ts:214` Attempt、`:377` Operation）；终态集合 `ATTEMPT_TERMINAL`（`:104`）；心跳/租约候选值常量（`:1296-1297`）（§5.1、§21–22） |
| `src/core/control.ts` | 590 | 聚合记录 `MissionControl`（`:165`）、`ControlEvent` 形状（`:123`）、唯一的 revision+事件提交口 `commit()`（`:361`）、去重表剪枝 `pruneDedupTables`（`:386-405`）、`SCHEMA_VERSION = 3`（`:61`）（§5.2、§5.3） |
| `src/core/kernel.ts` | 430 | 运行时内核：`submit()` 读—改—CAS（`:169`）、`drain()` outbox（`:224`）、`setAdmission()`（`:374`）、`renewLeases()`（`:398`）（§2、§5.2、§5.3、§6.2） |
| `src/core/commands.ts` | 2770 | 全部命令的纯转换与角色白名单；`task.claim` 签发租约（`:1025-1085`）；命令去重指纹 `fingerprint`（`:756-758`）（§5–§14、§21–22、§25–§35） |
| `src/core/queue.ts` | 212 | Host 内唯一的命令队列：按 missionId 串行、并发合并、独占运行锁（§5.2） |
| `src/core/store.ts` | 219 | 存储端口与两个实现；`RevisionConflict`（`:10`）、`SchemaVersionMismatch`（`:34`）拒绝装载旧版本、`assertShape`（§5.2、§5.3） |
| `src/core/lease.ts` | 85 | 租约判定：`leaseVerdict`（`:16`）、迟到写拒绝 `acceptsStateWrite`（`:24`）、`openLease`/`heartbeat`（`:37,47`）、依赖满足与成环检查（§6.2、§6.3） |
| `src/core/budget.ts` | 167 | 预算预留与按回执结算、`canRotate` 每小时保险（§13、§15.1、§22.15） |
| `src/core/completion.ts` | 196 | `missionCompletion`、`closureGaps`：完成只认结构条件（§6.4、§12.3） |
| `src/core/recovery.ts` | 153 | `classifyOperations`、`assess`、`bootRecover`；过期 Attempt 只进 `staleAttempts`（`:64-66`）（§11.1、§11.2） |
| `src/core/discipline.ts` | 550 | 质疑与依据版本漂移、票据当前性判据、承诺与授权核算（§6.4、§12.2、§21–22、§26） |
| `src/core/records.ts` | 932 | 整体工作记录与决策视图：三层读模型、增量订阅与检索回执（§28） |
| `src/core/provenance.ts` | 598 | 记录权威、证据溯源与争议保留（§32） |
| `src/core/context-quality.ts` | 1468 | 上下文质量分层判定（确定性层/语义层）与动作矩阵（§27.2–§27.5） |
| `src/core/experiment.ts` | 1649 | 探索额度、试验契约、条件化失败、猜想分阶段求证（§25、§26、§31） |
| `src/core/environment.ts` | 828 | 环境接续：清单、修订、接续会话与判定（§33） |
| `src/core/governance.ts` | 856 | 机制分类、降级与退出、治理成本（§35） |
| `src/core/integration.ts` | 766 | 整合计划、整体验收回执、团队争议裁决（§34） |
| `src/core/outcome.ts` | 547 | OutcomeContract：交付完成与效果观测分列（§30） |
| `src/core/archive.ts` | 329 | 归档优先裁剪（审阅 R4）：批次信封 `archiveEnvelope`、追加语义 `archiveSink`（同键同哈希=重放成功、异哈希即抛）、`sweepArchive` 只推水位不改 revision、`readArchiveSnapshot` 供 timeline 回读（§5.3、审阅 R4） |

### 2.2 `src/rotation/`（6 个，纯数据）

| 文件 | 行数 | 一行职责 |
| --- | --- | --- |
| `src/rotation/lines.ts` | 149 | 占用率读取与轮换线：`linesFor`（`:50`）、`rotationLine`（`:67`）、五个口径缺失即 `observation`（`:75-82`）；§10.1 |
| `src/rotation/policy.ts` | 234 | 迟滞/边沿/冷却的跨档判定与 `decideRotation`；头注 `:4` 标明移植自 dsh-context-guard；§10.1 |
| `src/rotation/latch.ts` | 141 | 软停闩（只停"领新步骤"，不 cancel 在跑动作）与有界边界等待（`:87`；等待会话可见的 `waitForSession` 在 `:135`）；适配自 dsh-auto-handoff；§10.2 |
| `src/rotation/fsm.ts` | 133 | 轮换阶段表与静默判据 `safeToHandoff`；§10.2–§10.3 |
| `src/rotation/brief.ts` | 305 | 8 段交接包（`:25-34`）、预算 4096（`:51`）、每段最多 24 行（`:52`）、截断顺序（`:253`）、CJK 口径 `estimateTokens`（`:55`）；§9.1、§9.3 |
| `src/rotation/facts.ts` | 237 | `ToolEventLedger` 工具调用配对与证据化事实：原生 `tool/call`/`tool/result` 与 Code-Mode 的 `tool/ptc-dispatch-start`/`tool/ptc-dispatch` 都吃（`:76,96`），参数两种形状统一序列化（`:43`），`programCalls` 数 run_code 程序次数（`:160`），程序内直写文件的盲区由 `inheritedNote` 声明（`:227-236`）；§9.1、第 12 节 |

### 2.3 `src/adapter/`（10 个，接宿主）

> 行数为 2026-10-15 复审二轮后的实测值；行内 `:NNN` 引用仍是**较早一轮**的快照，全量对账未做（见第 11 节）。

| 文件 | 行数 | 一行职责 |
| --- | --- | --- |
| `src/adapter/host-types.ts` | 181 | 宿主服务面的结构化视图，不 import 真类型；§16 |
| `src/adapter/services.ts` | 76 | volatile 引用摊平 `plainConfig`（`:23`）、按 agent 而非只按 host 面解析服务 `forAgent`（`:43`）；§15 |
| `src/adapter/dsh.ts` | 342 | 压力读取、turn 边界对账、seed 投递与送达回执（`confirmSeed` 有界向后翻页，复审 N1）、pre-step 守卫、工具守卫、定时任务迁移；§10.2、§12.1–12.3 |
| `src/adapter/capabilities.ts` | 148 | 能力探针：阻塞项名单 `BLOCKING`（`:25`）、`turn-boundary`（`:128`）、`compaction-coordination`（`:77`）、`gateAutomation`（`:179`）；§16 |
| `src/adapter/tools.ts` | 1364 | 22 个 `continuity_*` 工具定义、名单 `PLUGIN_TOOL_NAMES`（`:1359-1382`）、历史回读工具 `continuityHistoryTool`（`:411`，复审 N4）、模型面 token 预算 `TOOL_TEXT_TOKEN_BUDGET = 5238`（`:1422`）、超时重放防护 `ReplayGuard`（`:117`）；§14、第 12 节 |
| `src/adapter/rotation-runner.ts` | 317 | 把 FSM 阶段推进翻译成宿主动作（建会话、投 seed、迁移、失败退路）；§10.3–§10.5 |
| `src/adapter/dsh-context.ts` | 1358 | dsh-context 投影只读适配与容量口径分离：原生读数 `readNativeBudget`、判定出口 `pressureVerdict`、压缩端口 `CompactionPort`；§27.1–§27.2、§27.5 |
| `src/adapter/agent-teams.ts` | 432 | **原生 Agent Team 只读适配**（复审 G1/G3）：不可信输入收窄 `normalizeNativeTasks`、身份判据 `nativeTeamIdentity`（有队友行才算 Team）、执行态/验收态分离 `acceptanceFromNative`、单卡合并 `mergeTaskView`、依赖风险 `dependencyRisks`、链接重建 `linksFromNativeBoard` |
| `src/adapter/compaction.ts` | 207 | 宿主 `ctx.compaction` → `CompactionPort` 的收窄（复审 G2）：`compactionPort` 的入口形状核对、并发即 busy、`compactNow` 返回 null ⇒ `refused`、`ManualCompactionError.code` 逐项映射 |
| `src/adapter/quality-runner.ts` | 604 | **上下文质量决策链的唯一生产入口**（复审 G2）：`runQualityChain`（观测 → 评估落盘 → 入口计划 → 压缩前清点 → 版本复核 → 原生压缩 → 压缩后核对 → 收口），由 `src/index.ts` 的空闲维护窗口调用 |

### 2.4 `src/team/`（2 个，纯数据）

| 文件 | 行数 | 一行职责 |
| --- | --- | --- |
| `src/team/board-mirror.ts` | 248 | 台账 → 原生任务板的**纯映射**：幂等键写在 description 首行、subject ≤200 / description ≤16384 照抄宿主校验（dsh: `packages/experimental/agent-team/src/validation.ts:12`）、一轮每行最多一个动作；不 import 宿主、不取墙钟 |
| `src/team/board-sync.ts` | 145 | 映射结果落到宿主 `agentTeams` 的写入侧：caller 必须是活体 Lead Agent（隐式 lead 成员身份见 dsh: `packages/experimental/agent-team/src/roster.ts:92-115`）、单飞、只在真变化时写、任何抛错只记一条警告并停本轮 |

### 2.5 入口与视图

| 文件 | 行数 | 一行职责 |
| --- | --- | --- |
| `src/index.ts` | 2113 | 装配入口：设置（`:109-282`）、`normalize()`、存储域打开、冷恢复、事件订阅、空闲维护质量链 `runIdleQuality`（复审 G2，挂 `agent/status` 转空闲）、轮末评估 `evaluateTurnEnd`（含 `leadProtected`，复审 G1）、工具注册（含 `continuityHistoryTool`）、准入守卫、outbox / 租约 / 任务板节拍、`/continuity`（`:1130-1951`） |
| `src/views/export.ts` | 1577 | 只读派生视图（主台账、时间线、JSONL、冷恢复报告、记录视图）：确定性排序、`projectionRevision`、元数据块含 sourceRevision/freshness；`renderTimelineMarkdown(state, limit, archive?)` 按 seq 合并热+冷事件并写明回看窗口（复审 N4）；§5.4、§15.2、§22.18 |
| `src/views/workbench.ts` | 478 | 右侧工作台**只读投影**（设计稿 v0.5 §15）：`WORKBENCH_KIND`（`:24`）、`WORKBENCH_PATH = /api/continuity.workspace`（`:26`）、`missionWorkbench(state, native?)`（`:310`）；复审 G1/G3 后每张任务卡带 `execution`/`acceptance`/`native`/`gateNote` 四个面，原生板读数进 `native: WorkbenchNativeBoard`（`null` = 没尝试读，`phase:'unavailable'` = 读了但读不到）；只派生不判定、缺数据进 `coverage.unavailable` 不显示为 0、顺序按显式 id 稳定 |

### 2.6 根目录文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | `private: true`（`:4`）、`main` 与 `exports`（`:7-16`）、`dsh.client`（`:21-31`）、15 个 peer 且 3 个 optional（`:51-78`）、scripts（`:42-47`） |
| `client.js` | 手写浏览器半（1119 行，不是编译产物，见第 4 节） |
| `cordis.patch.yml` | bundle 补丁层，内容是 `[]`：只声明这一层存在，不带任何设置覆盖 |
| `cordis.patch.example.yml` | 29 个设置键的挂载示例，与 `Settings`（`src/index.ts:285-315`）逐项对齐；**不是安装物** |
| `tsconfig.json` | 基础配置，只出 `.d.ts`（见第 3 节） |
| `tsconfig.check.json` / `tsconfig.check-all.json` / `tsconfig.build.json` | 实际在用的检查与构建配置（见第 3 节） |
| `smoke.mjs` | 零真依赖的模块加载检查：`smoke.mjs:1` 列 21 个、`:13` 再列 2 个，共 23 个 |
| `make-rig.mjs` | 生成 `@deepseek-ai/*` 宽松存根，并**覆写** `tsconfig.check{,-all}.json`（第 1-5 行注释；默认从 `D:/deepseek-harness` 借 `@types/node`） |
| `harness.mjs` | 宿主替身，装载前跑通 `src/index.ts` 的装配路径（三轮：手动全链路 / 口径未声明停在观察 / 声明后走完 FSM） |
| `THIRD_PARTY_NOTICES.md`、`vendor/` | 归属清单与逐字复制件（含许可证原文），见第 10 节 |

## 3. 构建、类型检查与测试的真实口径

命令名以 `package.json:42-47` 为准：

| 命令 | 实际执行 | 配置口径 |
| --- | --- | --- |
| `npm test` | `node --test test/*.test.ts` | node:test 风格，直接跑 `.ts` |
| `npm run typecheck` | `tsc -p tsconfig.check.json` | `src` + `vendor`，`noEmit`（`tsconfig.check.json:18`） |
| `npm run typecheck:all` | `tsc -p tsconfig.check-all.json` | 再加 `test`（`tsconfig.check-all.json:30`），`noEmit` |
| `npm run build` | `tsc -p tsconfig.build.json` | 出 JS |

默认 `tsconfig.json` **不是检查用的配置**：`declaration: true` + `emitDeclarationOnly: true` + `outDir: lib/types`（`tsconfig.json:17-19`），即它只出 `.d.ts`，且不检查 `lib`，也没有 `typeRoots`。仓库里也不存在 `lib/types` 目录——构建走 `tsconfig.build.json`，那里 `declaration` 已关（`tsconfig.build.json:6`）。

构建产物落点：`outDir: "lib"` + `rootDir: "."`（`tsconfig.build.json:9-10`），因此 JS 在 `lib/src/*.js` 与 `lib/vendor/*.js`。`package.json` 的 `main`（`:7`）与 `exports["."]`（`:10`）指向 `./lib/src/index.js`，该文件当前存在。

`typeRoots` 三处一致，都写死宿主仓库路径：`tsconfig.check.json:19-21`、`tsconfig.check-all.json:19-21`、`tsconfig.build.json:11-13`，值为 `["D:/deepseek-harness/node_modules/@types"]`，配套 `"types": ["node"]`。原因是类型依赖（`@types/node`）来自宿主仓库，本仓库的 `node_modules` 只有 `@deepseek-ai/*` 与 `zod`。**换机器或换宿主路径时，这一处三行都要改**；`make-rig.mjs` 会重新生成 check 与 check-all 两个文件，手改会被覆盖。

`node --test` 只剥离类型、不做类型检查，所以 `tsc` 那一步不能省；为此基础配置开 `erasableSyntaxOnly`（`tsconfig.json:13`），type-strip 不支持的语法（如参数属性）在编译期就挡掉。

实测数字（本机 Node v22.20.0，2026-10-15 审阅 R1–R8 落地后全量重跑）：

```
npm test                 # tests 501 / pass 499 / fail 0 / skipped 0 / todo 2
npm run typecheck        # exit 0，无输出
npm run typecheck:all    # exit 0，无输出
node smoke.mjs           # 23 个模块 OK，末行 ALL LOADED
```

测试面：`test/*.test.ts` 35 个文件，另有 `test/fixtures.ts`、`test/discipline-fixtures.ts` 两个共享夹具。`smoke.mjs` 覆盖 `src` 的 22 个模块加 `vendor/redaction.ts`；未覆盖的 16 个是 `src/index.ts`（需要真 peer）与 v0.5、审阅 R1–R8 新增的 `core/archive`、`core/context-quality`、`core/discipline`、`core/environment`、`core/experiment`、`core/governance`、`core/integration`、`core/outcome`、`core/provenance`、`core/records`、`adapter/dsh-context`、`adapter/tools`，加上任务板投影的 `team/board-mirror`、`team/board-sync` 与右侧工作台的 `views/workbench`——`src/index.ts` 由 `harness.mjs` 走装配路径，`views/workbench.ts`（307 行）由 `test/views-workbench.test.ts` 覆盖投影行为（终态与待复核可见、缺数据进 `coverage.unavailable` 不显示为零、同一 revision 两次投影逐字节相同、轮换会话不重复计数）、`test/client-bundle.test.ts` 覆盖它的常量与浏览器半的装载契约（服务缺席守卫、页签两段式注册与失败回滚、只读路由），其余 14 个的覆盖靠 `test/` 里的用例，不靠 smoke。

## 4. 装载契约

服务端半边：

- 入口导出的 `name` 必须与补丁行的 id 一致，都是 `dsh-long-task-continuity`（`src/index.ts:92`）。
- 硬依赖只有两个：`inject = ['storageDomain', 'commands']`（`src/index.ts:98`）；其余服务全部 live reader，每次现读（`src/index.ts:479-492`）。
- 存储域 `continuity` 打不开就整体无操作，不做半挂载（`src/index.ts:494-501`）。

客户端半边（`package.json`）：

- `dsh.client.platform = "web"`（`:22`），`dsh.client.inject` 声明 6 个宿主模块（`:23-30`：connection、locale、ui-renderer、ui-tool、ui-plugin-manager、ui-settings）。
- `exports["./client"] = "./client.js"`（`:12`）；`dsh.bundle.patch` 指向 `./cordis.patch.yml`（`:18-20`）。
- 宿主按 `dsh.client` 扫描并校验 platform/inject/external（宿主仓库 `packages/client/modules/src/client/manifest.ts:157-173`）；声明了 `dsh.client` 却没有 `./client` 导出的包会直接报错（宿主仓库 `packages/client/modules/src/index.ts:847`）。
- 客户端 bundle 由宿主拼成一条 combo URL 提供：`plugins/??…,dsh-long-task-continuity/client.js&rev=…`。`??` 与 `&rev=` 的串法是宿主组的（宿主仓库 `packages/client/modules/src/index.ts:230` 产出 `??${resources}&rev=${rev}`；形状断言见宿主仓库 `apps/web/tests/assembled-boot.ts:91`）。上面三处是宿主仓库路径，不在本仓库内。
- **`client.js` 是手写 JS，不是 TS 编译产物**：`tsconfig.build.json:18` 的 include 只有 `src/**` 与 `vendor/**`；文件头注释也写明 hand-written lazy-CJS、不用打包器、只用 `react` 与 `@deepseek-ai/dsh-client-ui-primitives` 两个平台种子（`client.js:1-14`）。入口是 `window.__ModuleLoader__.load`（`client.js:15`），bundle 内部另声明自己的 `inject = ["slots", "locale"]`（`client.js:36`），挂的是三个 DSH 现成槽位：设置页（`client.js:651`）、工具调用视图（`client.js:1095`）与右侧只读任务页（`sidebar.right.pane.tab` / `.title`，经公开的 `sidebarRightTabs` 两段式注册，`client.js:1040-1083`，装配点 `:1109`），不引入第二套视觉体系。

本机 web profile 的当前挂载值：`enabled: true`、`registerTools: true`、`autoRotationEnabled: true`、`probesAcknowledged: false`、`enforceAdmission: false`（`<DSH_HOME>\profiles\web\cordis.patch.yml:47-52`）。因为 `armed()` 要求探针全过**或**操作者签字（`src/index.ts:621`），`autoAllowed()` 还要再与开关相与（`src/index.ts:622`），所以自动轮换侧当前仍未入场；准入守卫也没注册（`src/index.ts:2044-2077`）。补丁段 `:47-69` 只写了 23 项，第 8 节表里的后 5 项（`acceptMirroredCompactionDefaults`、`teamBoardMirror`、`teamBoardMirrorMs`、`teamBoardMirrorSession`、`replayWindowMs`）在真机上取默认值。

挂载形态与一条已知危险：本插件是靠 `<DSH_HOME>\profiles\web\package.json:22` 的 `"dsh-long-task-continuity": "link:<DSH_HOME>/plugins/dsh-long-task-continuity"` 进来的，`node_modules/dsh-long-task-continuity` 是一条软链。**但 `pnpm-lock.yaml` 里对该包的引用是 0 处**——同目录的 `dsh-purge`、`dsh-test-runner` 都有锁定条目，只有本插件没有（2026-10-15 实测对比）。这意味着一次非 frozen 的 `pnpm install` 可以把它当多余项摘掉软链，并按 2026-09-30 那次事故的机制删掉 `<DSH_HOME>\plugins\dsh-long-task-continuity\node_modules`（里面是 25 个 `@deepseek-ai/*` 作用域包，装载必需），结果就是 `ERR_MODULE_NOT_FOUND` 秒退。补锁定条目要在这份 profile 里跑一次带锁写入的安装，属于会影响现网运行环境的动作，未获批准前不动。这条漂移有现成的只读体检口可复验：`node D:/dsh-legacy-archive/check-profile-lock-drift.mjs`（2026-10-15 实跑输出 `deps=25 lockEntries=24` 并点名 `missing from lock importer: dsh-long-task-continuity`）。同一天的另一台体检 `node D:/dsh-legacy-archive/repair-web-profile.mjs`（doctor 模式只读）给的是 `RESULT: HEALTHY (0 problems)`，即软链与嵌套 `node_modules` 此刻都还在——风险是下一次非 frozen 安装，不是当下故障。

## 5. 注册面之一：22 个模型可见工具

注册条件：`registerTools=true` 且 `tools` 服务可读，逐个注册 `[continuityStatusTool, continuityCheckpointTool, ...commandToolFactories, continuityHistoryTool]`（`src/index.ts:2085`）= 2 + 19 + 1 = **22 个**，与 `PLUGIN_TOOL_NAMES` 的 22 项一致（`src/adapter/tools.ts:1359-1382`）。注册循环里带一条显式对账：`factories.length !== PLUGIN_TOOL_NAMES.length` 时打警告（`src/index.ts:2090`）——"声明了没注册"不再静默（复审 N4 之前正是 22 个名字只注册 21 个、日志还虚报 22）。

> 下表 `:NNN` 为 2026-10-15 二轮实测行号（`src/adapter/tools.ts`）。

| 工具 | 定义行（均指 `src/adapter/tools.ts`） | 一行作用 |
| --- | --- | --- |
| `continuity_status` | `:210` | 只读台账，`aspect` 11 个面：overview/discipline/obligations/authorization/deliveries/validators/work/records/environment/governance/outcome |
| `continuity_checkpoint` | `:288` | 提交检查点：当前步骤、已验收进度、进行中、下一步第一动作、关键决策、阻塞、待确认 |
| `continuity_submit` | `:334` | 提交结果进入验收；租约版本按当前 Attempt 由内核取，不接受自报 |
| `continuity_verify` | `:346` | 登记验收记录；`unknown/error/not_run` 不折算成 `pass` |
| `continuity_evidence` | `:394` | 登记观测证据，来源类别分列（观测/转述/推断/模拟/绑定引用） |
| `continuity_claim` | `:466` | 提出或修订结论（主张命题）；修订产生新版本，撤回要写理由 |
| `continuity_challenge` | `:535` | 提出质疑或裁定质疑 |
| `continuity_search` | `:599` | 登记检索回执；`coverage != complete` 时不得把"没找到"当前提 |
| `continuity_obligation` | `:653` | 登记承诺或推进承诺阶段 |
| `continuity_review` | `:713` | 登记独立审查（自洽性、历史对照、共享证据与独立性说明） |
| `continuity_validator_qualify` | `:758` | 登记并判定程序化验证器资格（需正反样本） |
| `continuity_delivery_confirm` | `:817` | 确认投递阶段与接收方处理状态 |
| `continuity_propose_complete` | `:844` | Lead 提议 Mission 收口，只挂提案不直接置完成 |
| `continuity_experiment` | `:923` | 探索与实验写入口（`action` 多路复用：classifyWork/registerPolicy/preregister/recordTrial/assessRoute/decideStrategy 等） |
| `continuity_conjecture` | `:956` | 猜想写入口（capture/frame/recordProbe/defer/close/assumptionChange 等） |
| `continuity_environment` | `:972` | 环境接续写入口（register/revise/openResume/advanceResume/assessResume） |
| `continuity_mechanism` | `:995` | 机制治理写入口（propose/revise/changeClass/transition/recordRun/recordMisreport） |
| `continuity_outcome` | `:1027` | 目标效用写入口（register/observe/review） |
| `continuity_integration` | `:1041` | 整合写入口（plan/revise/receipt） |
| `continuity_records` | `:1054` | 记录写入口（recordCoverage/recordBrief） |
| `continuity_claim_task` | `:1344` | 领取任务执行权（开工），参数只有 `taskId`；身份取当前会话绑定、不接受自报 `actorId` |
| `continuity_history` | `:411` | **按需回读归档历史**（复审 N4）：按 Mission / 对象 / seq 或时间区间取回热+冷事件与闭合记录正文，带 `nextCursor` 向更旧翻页；覆盖不足时如实回报缺失范围与可信水位，不把"读不到"答成"没有历史" |

`continuity_claim_task` 与 `continuity_claim` 是两件事：那个记主张命题，这个开干，且身份取当前会话绑定（`src/adapter/tools.ts:1065-1070`）；加入它的理由写在预算注释里（`src/adapter/tools.ts:1136-1137`：装载后自动跑批无法自行领取执行权，检查点链路断在一半）。

条数不只靠数，三处断言同时盯着：`test/token-budget.test.ts` 断言"注册表与 22 个工具定义一一对应（顺序也一致）"、`test/client-bundle.test.ts` 断言浏览器侧 `TOOL_META` 的键集合与 `PLUGIN_TOOL_NAMES` **同一集合**（缺一个、多一个、名字写错都在这里失败）、`src/index.ts:2090` 在装配时再对一次长度。两条纪律：名单与工厂只能**尾部追加**，因为工具声明从第 0 个 token 起参与前缀缓存，重排会让整段缓存按未命中价重算（`src/adapter/tools.ts` 名单头注）；模型面文本合计上限 `TOOL_TEXT_TOKEN_BUDGET = 5238`（`src/adapter/tools.ts:1422`，由 `test/token-budget.test.ts` 断言不超），改描述或参数后要重跑该测试并同步数值。同一份名单还被准入守卫用作"只读工具"集合（`src/index.ts:2117`）。

## 6. 注册面之二：`/continuity` 命令组

注册在 `src/index.ts:1946-1951`（`commands.register({ name: 'continuity', … })`），用法串在 `src/index.ts:1104-1110`，两处需同步。动词共 **57 个**：`status`（`:1180`）、`probe`（`:1181`）、`open`（`:1182`）、`recover`（`:1223`）在 switch 之前分支处理，其余走 switch（`:1259-1943` 的 54 个 case）；`status` 在两处都出现（`:1180` 早返回、`:1939` 同文案兜底），行为一致。

| 组 | 动词 |
| --- | --- |
| 台账与诊断 | `status`、`timeline`、`probe`、`board`、`drain`、`recover` |
| Mission | `open`、`revise`、`pause`、`resume`、`cancel`、`propose-complete`、`complete` |
| 任务与执行权 | `task`、`approve`、`claim`、`checkpoint`、`submit`、`verify`、`retry`、`spec`、`depend` |
| 身份与团队 | `join`、`dormant`、`retire`、`bind`、`team`、`message`、`ack` |
| 产物与副作用操作 | `artifact`、`attach`、`publish`、`intent`、`receipt`、`reconcile` |
| 委托与轮换 | `delegate`、`collect`、`rotate`、`resolve`、`resolve-propagation` |
| 证据与纪律 | `evidence`、`assert`、`assert-retract`、`challenge`、`adjudicate`、`search`、`context`、`qualify`、`review`、`incident` |
| 承诺与授权 | `obligate`、`settle`、`grant`、`revoke` |
| 派单与交付 | `dispatch`、`deliver`、`ack-delivery` |

参数分隔口径：竖线分段、逗号成列、分号分验收项、冒号与等号组内拼字段；`<必填>` 缺失即在入口回用法，不把空字段丢给内核换一句 `transition rejected`（`src/index.ts:1110,1244-1258`）。枚举词表在 `src/index.ts:381-397`，与实体的字面联合一一对齐。

`board`（`src/index.ts:1393-1399`）是这组里唯一往宿主写东西的动词：手动跑一次"台账 → 原生任务板"投影（`src/team/board-sync.ts`），要 Mission 已绑定才可用；它只调 `agentTeams` 的 `createTask/updateTask`，**不**提交命令、不写控制记录、不推进 revision，所以 `teamBoardMirror=false`（定时器不写）时仍然可以用它手动刷一次。

身份取法：12 个动词按"用户本人"入账（`USER_ONLY`，`src/index.ts:1127`，判据在 `:1131`）——`revise`/`approve`/`verify`/`pause`/`resume`/`cancel`/`complete`/`adjudicate`/`qualify`/`grant`/`revoke`/`resolve-propagation`；其余按会话绑定的未退役 Actor 取（`:1132-1136`），映射不到落 supervisor 入口（`:1137`）。判据是"这一步由人来决定"，不是"这个命令敏感"（注释在 `src/index.ts:1112-1125`）。

## 7. 租约与心跳

### 7.1 代码口径

- 默认值：`LEASE_HEARTBEAT_MS = 15_000`、`LEASE_EXPIRY_MS = 90_000`（`src/core/entities.ts:1296-1297`），对应设计稿 §15.1 第 507 行的候选值"15 秒/90 秒；到期进入核对，不能直接抢占"。设置项 `leaseHeartbeatMs` 默认 15_000、`leaseExpiryMs` 默认 90_000（`src/index.ts:234-239`，normalize 同值 `:349-350`）。
- 签发：`task.claim` 写 `leaseVersion: 1`、`leaseExpiresAt = now + LEASE_EXPIRY_MS`、`lastHeartbeatAt = now`、`status: 'running'`，并把 Attempt 的 `sessionId` 绑到认领者的会话（`src/core/commands.ts:1044-1075`，到期式在 `:1067`）。
- 节拍：`leaseHeartbeatMs > 0` 时起 `setInterval`（`src/index.ts:2099-2107`），每拍调 `kernel.renewLeases(running, settings.leaseExpiryMs)`（`src/index.ts:2102`），timer `unref()`（`:2107`），卸载时 `clearInterval`（`:2120`）。
- 回活补一次定向续期：`agent/status` 报 `running` 且该 `sessionId` 原本不在活名单时，立刻只对这一个会话调 `renewLeases(new Set([sessionId]), ...)`（`src/index.ts:1978-1995`，补续在 `:1986-1992`）。不补这一下的话，空闲超过 90 秒的会话在重新开口后、下一个 tick 之前最长有 `leaseHeartbeatMs` 的空窗，其间第一次写入会按 §6.3 判过期，只能靠 `retry` 重领并吃一次重试预算。名单仍由 Host 报出，进得来就说明执行进程活着，不构成抢占。
- 活名单来源：`running` 集合在 `src/index.ts:581` 声明；上面的 `agent/status` 监听（`:1978-1995`）里 `status === 'running'` 加入（`:1987`）、其它状态移除（`:1993`）；`agent/disposed`（`:2005-2008`）与 `session/disposed`（`:2009-2012`）都经 `forget()` 移除（`:1997-2003`）。因此本进程重启后集合为空，这个节拍只可能让确实在跑的执行者免于过期，不可能替死掉的进程守租约（注释在 `:2096-2098`）。
- `kernel.renewLeases`（`src/core/kernel.ts:398-421`）的三条边界：① 空名单或 `expiryMs <= 0` 直接返回 0（`:399`）；② 只碰"非终态 Attempt 且 `sessionId` 在活名单"（`:408`；终态集合 `ATTEMPT_TERMINAL = settled/failed/cancelled`，`src/core/entities.ts:104`，判定函数 `src/core/lease.ts:12-14`）；③ 写回只调 `heartbeat()`（`src/core/lease.ts:47-49`：改 `lastHeartbeatAt`、`leaseExpiresAt`、`updatedAt` 三个字段）。
- **不推进 revision、不追加事件**：提交语句是 `store.commit(missionId, current.revision, { ...current, attempts: {...} })`（`src/core/kernel.ts:414`）——CAS 期望值就是读到的原 revision，`events` 数组原样带过。对照正常转换的唯一进度凭证 `commit()`：revision +1、追加事件、刷新 `lastCommittedAt`（`src/core/control.ts:361-384`），`renewLeases` 不经它。理由与后果写在 `src/core/kernel.ts:385-397`：心跳是运维时点而不是控制决策，15 秒记一笔会把归档压力变成常态，也让时间线读不出真实动作（§5.3 第 173 行：`revision` 单调递增、已确认事件可归档）。
- **到期只触发核对，绝不自动抢占**：`leaseVerdict` 过期返回 `expired_needs_reconcile`（`src/core/lease.ts:16-21`）；过期执行者的迟到写被 `acceptsStateWrite` 拒（`:24-26`），文件头注释也写明"过期不证明旧进程已停"（`:4-6`）；`assess` 只把过期非终态 Attempt 列进 `staleAttempts`（`src/core/recovery.ts:64-66`）；`/continuity recover` 明确"过期执行权不会自动收回"，给出后一步是人工 `retry` 再 `claim`（`src/index.ts:1227-1234`）。设计稿出处：§6.3 第 204 行、§11.1 第 395-405 行。

**口径不一致已修（审阅 R8）**：到期时长现在是一条链：装配层在构造内核时把挂载时的声明值注入内核选项 `leaseExpiryMs`（`src/index.ts:575`），内核在每次 `submit()` 里把它放进 `CommandContext`（`src/core/kernel.ts:189`），签发走 `leaseDuration(ctx.leaseExpiryMs)`（`src/core/commands.ts:1067` → `src/core/lease.ts:33`），续租走 `heartbeat(attempt, now, expiryMs)`（`src/core/kernel.ts` 的 `renewLeases` → `src/core/lease.ts:47`）；缺省（未注入时）回退常量 `LEASE_EXPIRY_MS`（`src/core/entities.ts:1291`）。签发与续期因此始终同一个值。**改这个设置要重新装载**：值在挂载时随内核构造与两个续期入口一次性取定，`.volatile()` 的现读不覆盖它（client.js 的字段提示已写明）。

### 7.2 续期实测

时间：2026-10-15，profile：web，Mission `mss_3796513e-5640-4f0e-92a0-195582d43a0a`。部署侧的节拍值与默认一致：`leaseHeartbeatMs: 15000`、`leaseExpiryMs: 90000`、`outboxDrainMs: 0`（`<DSH_HOME>\profiles\web\cordis.patch.yml:67-69`）。

- `/continuity claim` 后，Attempt `att_ee2b7098-1fbe-4ae4-b74e-fa37ee2cb006`（actor `lead-session-8aa152ae-2b69-4515-a109-7f2418730db8`）在台账里是 `running`（时刻 2026-10-14T19:17:30.284Z，事件 `seq 14 attempt/opened`，即 revision 22）。
- 连续四次读台账 `lastHeartbeatAt`/`leaseExpiresAt`，每 15 秒前进一次：`19:19:08.628Z → 19:19:23.638Z → 19:19:38.648Z → 19:19:53.654Z`；这段时间内 `revision` 全程保持 **22**，`events` 长度不变。
- 落盘复核（只读，UTC）：`leaseExpiresAt - lastHeartbeatAt` 恒为 90_000 ms，`status = running`、`leaseVersion = 1`。
- 判定：心跳按 `leaseHeartbeatMs` 推进租约时点、不推进 revision、不追加事件，与 §7.1 的代码口径一致。

空闲后再写入的四组实测（三组只差"空闲秒数"，第四组只差"重启"，web profile，同一 Mission）：

| 场景 | 结果 | 台账证据 |
| --- | --- | --- |
| 领取后空闲 140 秒再写检查点 | **通过** | revision 22→23；事件 `seq 15 checkpoint/written`；写入时刻 19:19:53.718Z = 领取后 143.4 秒 |
| 领取后空闲 573 秒（9 分 33 秒）再写 | **通过** | revision 23→24；`ckp_1f7049ff`；回活后 9 秒内 `leaseExpiresAt` 连跳两格（19:31:12Z → 19:31:27Z） |
| web 重启后**未**走 recover/resume 直接写 | **被拒**：`admission closed: recovery reconciliation has not cleared this mission` | revision 停在 24，`admissionClosed: true`，事件序列无新增 |
| web 重启后 `recover` → `resume` → 直接写检查点（不 `retry`、不 `claim`） | **通过** | revision 24→29（冷恢复两次入场写、`recover` 一次、`resume` 一次，都不追加控制事件）；`admissionClosed: false`，事件 `seq 17 mission/resumed`、`seq 18 checkpoint/written` |

结论的层次要读对：**拦住写入的是"重启后的恢复对账"，不是空闲秒数**。`dispatch()` 先查 `admissionClosed`（`src/core/commands.ts:838`；非特权命令且不在 `ALWAYS_ALLOWED`（`:268-284`，`task.checkpoint` 不在里面）就拒），再查租约（`:1085`）。所以没重启时空闲多久都不需要重新领取；重启后无论空闲多久都要先走 `recover` + `resume`。

另需注意 `retry` 不是免费的：`task.retry` 受 `attemptCount >= maxAttempts`（`src/core/commands.ts:1286`）与 `budget.taskRetries >= maxTaskRetries`（`:1287`）双闸。本机这份记录当前 `attemptCount` 已等于 `maxAttempts`（3），此时 `retry` 会被挡死，而 `recover`→`resume`→`checkpoint` 这条路径不需要 `retry`——这也是接管说明把它写成默认顺序的原因（接管说明 §3b）。

## 8. 配置项全表（29 项）

Schema 定义在 `src/index.ts:109-282`，每一项都带 `.volatile()`；`Settings` 接口在 `:285-315`；`normalize()` 的兜底值在 `:317-356`。`enabled=false` 时不订阅、不写、不注册工具（`:463-466`）。

volatile 的生效范围要分两类，别按"全表改了立即生效"理解：判定入口每次现读（`settingsOf()` 在 `src/index.ts:462`，`.volatile()` 到手是引用不是值，见第 9 节），所以门禁、阈值、注册开关这类"每次动作前读一遍"的项改完即生效；但 `src/index.ts:469` 的 `const settings = settingsOf()` 是一次性快照，**下面这几项要重新装载插件（重挂载）才生效**：`outboxDrainMs`、`leaseHeartbeatMs`、`teamBoardMirrorMs`（拿它当 `setInterval` 周期）、`leaseExpiryMs`（随内核构造与续期入口一次性取定，§7.1 末）、`hostLockPath`（锁只在挂载时获取/释放）；`teamBoardMirror` 这个开关本身每次现读（`runBoardSync` 内判），所以关掉了不必重启、只是节拍不变。client.js 的字段提示对这些项都写了"改动需重新装载插件才生效"。

| 设置项 | 默认 | 作用 | 出处（schema / normalize / 使用点） |
| --- | --- | --- | --- |
| `enabled` | `true` | 总开关；关掉即不订阅事件、不写存储、不注册工具（存储记录保留） | `src/index.ts:110-113`、`:327`、`:463-466` |
| `missionId` | `''` | 本实例绑定的 Mission；留空表示还没开 | `:114-117`、`:328`、`:586-587` |
| `autoRotationEnabled` | `false` | 自动换会话；关闭时只报观察到的轮换线 | `:118-125`、`:329`、`:622` |
| `probesAcknowledged` | `false` | 操作者签字：§16 实测项已在本部署逐项核对；没有它，自动轮换与准入守卫永远无法入场 | `:126-134`、`:330`、`:621` |
| `rotateRatio` | `0.6` | 轮换线 `T = min(floor(p·W), C−M)` 里的 p | `:135-140`、`:331` |
| `handoffMarginTokens` | `8192` | 交接包加首步的余量 M | `:141-145`、`:332` |
| `outputReserveTokens` | `0` | 轮换线里的 R；`0` 读成"未声明"⇒ 停在 observation | `:146-156`、`:333`；`src/rotation/lines.ts:77` |
| `compactionHeadroomTokens` | `0` | 轮换线里的 H；`0` = 未声明 | `:157-165`、`:334`；`src/rotation/lines.ts:79` |
| `compactionRatio` | `0` | 轮换线里的 r；`0` 不等于继承出厂默认 0.8 | `:166-176`、`:335`；`src/rotation/lines.ts:80` |
| `acceptMirroredCompactionDefaults` | `false` | 允许未声明的 H 与 r 改用本包**抄来的** compaction-basic 出厂默认（65536 / 0.8）；打开后轮换线脱离 observation，但台账一律标 `mirrored-default`，生效配置仍以原生为准 | `:177-187`、`:336`；`src/adapter/dsh-context.ts:88`、`:617` |
| `warnRatio` | `0.45` | "该收尾了"的占用率（一律用比率） | `:188-193`、`:337` |
| `hardRatio` | `0.6` | "该换会话了"的占用率，须大于 `warnRatio` | `:194-199`、`:338` |
| `cooldownTurns` | `5` | 跨档后的静默轮数 | `:200-202`、`:339` |
| `minTurnsBetweenRotations` | `8` | 同一 Actor 两次轮换之间的最少轮数 | `:203-205`、`:340` |
| `maxRotationPerHour` | `3` | 每 Actor 每小时轮换保险上限（不是每生命周期） | `:206-208`、`:341` |
| `boundarySlowMs` | `30000` | 静默边界等待多久开始报"慢"，不中止 | `:209-211`、`:342` |
| `boundaryDeadlineMs` | `180000` | 等待边界的硬上限，超时即释放闩 | `:212-214`、`:343` |
| `migrateSchedules` | `true` | 提交轮换前把定时任务迁到新会话 | `:215-217`、`:344` |
| `rearmGoal` | `false` | 在新会话重新装载原生 goal；关 = 只靠启动消息接续 | `:218-220`、`:345` |
| `enforceAdmission` | `false` | 注册 `tools.guard`，无有效准入票据的 Actor 不许受管写入；门禁未放行时不注册（单向拒绝的风险太大） | `:221-227`、`:346`、`:2044-2077` |
| `registerTools` | `false` | 注册第 5 节的 21 个模型可见工具 | `:228-230`、`:347`、`:2016-2042` |
| `outboxDrainMs` | `0` | outbox 消费周期；`0` = 只在 `/continuity drain` 或轮换提交时消费；改节拍要重启（§8 首段） | `:231-233`、`:348`、`:2079-2093` |
| `leaseHeartbeatMs` | `15000` | 租约续期节拍；`> 0` 才起定时器；改节拍要重启（§8 首段） | `:234-236`、`:349`、`:2099-2107` |
| `leaseExpiryMs` | `90000` | 签发与续期**共用**的租约时长：内核经 `CommandContext` 注入签发（`leaseDuration`），续租同值（`heartbeat`）；改值需重新装载（§7.1 末） | `src/index.ts:237-239`、`:350`、`:575`；`src/core/lease.ts:33,47` |
| `hostLockPath` | `''` | 单写者锁文件路径（审阅 R3）；留空=不启用。声明后，拿不到锁（另一进程持有且心跳未死）的宿主整机进入无操作模式；持有期间每 10s 心跳、5 分钟硬过期可被接管；需重新装载 | `src/index.ts:275-281`、`:355`、`:507-519`；`src/core/queue.ts:106` |
| `teamBoardMirror` | `false` | 把台账行投影进宿主 `agentTeams` 任务板（dsh-context 的「编队」页因此就是台账）；开关每次现读，关掉不必重启 | `:240-249`、`:351`、`:1009` |
| `teamBoardMirrorMs` | `30000` | 投影节拍；`> 0` 才起定时器；改节拍要重启（§8 首段） | `:250-254`、`:352`、`:2112-2113` |
| `teamBoardMirrorSession` | `''` | 写任务板时充当 caller 的会话；留空用 Lead Actor 绑定的会话。`createTask/listTasks/updateTask` 都要求 caller 是活体 Lead Agent，Lead 会话已关时这里必须指一个在跑的会话 | `:255-261`、`:353`、`:990` |
| `replayWindowMs` | `120000` | Code-Mode 超时重放防护窗口（第 12 节）：同内容命令在窗口内落地过就退回"先核对"而不是再写一次；`0` = 关闭 | `:262-274`、`:354`、`:2020` |

## 9. 其它关键口径（改代码前先读）

- **轮换线 `C = floor(min(r·W, W−R−H))`、`T = min(floor(p·W), C−M)`**（`src/rotation/lines.ts:50,67`）：W 声明窗口、R 输出预留、H 压缩余量、r 压缩触发占用率、M 交接包加首步余量。其中 R/H/r 三项在 v0.2.1-alpha.1 上没有公开读取口径（生效压缩参数住在 compaction-basic 自己的 volatile config，宿主仓库 `packages/compaction/compaction-basic/src/config.ts:75`，本包 `src/index.ts:22`、`:160-164` 也记了这条），因此改由设置显式声明，且**`0` 一律读成"未声明"**：`rotationLine` 返回 `observation`（`src/rotation/lines.ts:75-82`），自动侧不换会话；手动 `/continuity rotate` 不走这条判定（`src/index.ts:1361`）。把 `0` 当真值会把 C 算大，比不换会话危险。
- **交接包**：8 段（`src/rotation/brief.ts:25-34`）、4096 token（`:51`）、每段最多 24 行（`:52,143`）。超预算时按固定顺序裁半（`:253,277-285`）：`open_questions → artifacts_and_evidence → failed_paths_and_blockers → key_decisions`；未列入的 4 段（目标与约束、已验收进展、当前状态、下一步）不裁，仍超就标 `overBudget`（`:287`）。token 估算口径：CJK 逐字计 1，其余每 4 字符 1（`:55-61`），是估算不是计费。
- **命令去重**：指纹取 `sha256(规范化命令 JSON)`（`src/core/commands.ts:756-758`）；命中即返回原回执、`effect: 'dedup-hit'`（`:840-843`）；写回时只保留压缩后的标识前 16 位，过期条目丢弃但不清空整表（`src/core/control.ts:386-405`，保留窗 `DEDUP_RETENTION_MS` 24 小时 `:67`）。幂等键、重试 ID 与内核自分配的实体 ID 三者不混用（§5.1）。
- **事件与体积**：事件序号按上一条 +1，剪枝保留最近 500 条且序号不重置（`src/core/control.ts:82,361-384`）；正文、会话全文与 token 明细不得嵌入控制记录（`:162`），体积测量口 `controlSize()`（`:349`）。
- **版本不符即拒绝装载**：`schemaVersion` 不符即抛 `SchemaVersionMismatch`，不降级成 `null`、不就地迁移（`src/core/store.ts:34-48`、`src/core/kernel.ts:174-179,235-241,346-351`），当前 `SCHEMA_VERSION = 3`（`src/core/control.ts:61`，本机落盘记录也是 3）。
- **视图只读、确定性、不落盘**：`src/views/export.ts:5-6` 头注两条纪律；排序一律用显式 id 键（`:58-59`），`projectionRevision` 由 `revision + basisRevision` 确定性算出、不引随机数或墙钟（`:82-83`），导出顶部元数据块带 sourceRevision/projectionRevision/freshness（`:100-111`，§22.18）。
- **探针与入场**：`BLOCKING` 七项（`src/adapter/capabilities.ts:25`）；`turn-boundary` 在源码层面只能给 `partial`（`:128`），`compaction-coordination` 恒 `missing`（`:77`）——语义只能在真会话上对账，所以 `gateAutomation`（`:179`）永远给不出全绿，本包把"人来确认已实测"做成显式设置 `probesAcknowledged`，而不是让插件自己宣布通过（`src/index.ts:612-631`）。
- **可选服务一律 live reader**：`ctx.get` 每次现读（`src/index.ts:472-475`），因为 Loader 并发组合兄弟条目，`sessionController` 常在本插件之后才发布；一次性快照会把"部署正常"读成"服务缺席"。
- **"该压缩 / 该在会话内另开一个会话"只是观测**：判定口 `pressureVerdict`（`src/adapter/dsh-context.ts:1009`）是纯函数，只看两条线（`T ≤ pressure < C` ⇒ rotate、`pressure ≥ C` ⇒ compact、缺任一格口径 ⇒ hold 并点名是哪一格，`:1057-1070`），它返回的 `canRotate` 在本包**没有任何动作消费者**——两处调用点（`src/index.ts:921`、`:1042`）都只把它交给 `verdictText()`（`src/index.ts:694`）：前者拼进轮换日志（`:968`），后者拼进 `/continuity status` 文本（`:1049`）。换不换仍由 `decideRotation`（`src/index.ts:927`）加 §16 入场门控（`autoAllowed()`、`safeToHandoff`、预算）决定，与 Mission 是否绑定 Lead 会话无关。这条是显式设计选择：判定依据要先看得见，动作侧才有对账对象（设计稿 §27.3 要求"保存以下分量及其依据"、§27.4 给出动作矩阵；"明确显示判断依据"是接管时的口径）。
- **`.volatile()` 到手是引用不是值**：每次判定前重新 `normalize()`（`src/index.ts:317-356`、`src/adapter/services.ts:4-7`）。

## 10. 参考的开源项目与归属

遵循"有开源比较好的方案就复制其代码并做适配"。归属以仓库内的 `THIRD_PARTY_NOTICES.md` 与 `vendor/README.md` 为准，下表是两者与源码头注合并后的口径；"许可"列写明本仓库内是否留有许可证原文，没有原文的一律标为**许可需在再分发前核实**。

| 项目 | 许可 | 借鉴了什么 | 落在本仓库哪里 |
| --- | --- | --- | --- |
| `qingyou002/dsh-auto-handoff` @0.1.0 | MIT，原文 `vendor/LICENSE.dsh-auto-handoff` | 凭证脱敏规则逐字引用；软停闩 + `agent/pre-step` 决策 + 双边界等待的原始参照；`TokenTracker`、`collectFileChanges`、`waitForSession`、按 agent 解析服务（`forAgent`） | `vendor/redaction.ts`（128 行、无改动）、`vendor/graceful-stop.ts.orig`（`.orig`，不参与编译）；适配版 `src/rotation/latch.ts:1-3,135`、`src/rotation/policy.ts:142-143`、`src/rotation/brief.ts:68`、`src/adapter/services.ts:9-10` |
| `@2jumpsina/dsh-context-guard` @0.3.4 | MIT，原文 `vendor/LICENSE.dsh-context-guard` | 占用率判定：迟滞、跨档边沿、冷却轮数、读不到数据 fail-closed；`readOccupancy` 三字段 last-wins；volatile 配置必须摊平 | `src/rotation/policy.ts:4`、`src/rotation/lines.ts:126`、`src/adapter/services.ts:5`、`src/index.ts:84` |
| `Fei2411/DeepSeek-Bot` | Apache-2.0，原文 `vendor/LICENSE.ds-bot` + `vendor/NOTICE.ds-bot` | 窗口折算（usable/hard 两线）的算法形状、交接段落清单（`NOTE_SECTIONS`）、定时任务迁移 `moveSchedules` | `src/rotation/lines.ts:50`、`src/rotation/brief.ts:5`、`src/adapter/dsh.ts:211`；`NOTICE.ds-bot` 必须随分发保留（Apache-2.0 §4） |
| `qingyou002/dsh-turn-rewind` | 未复制代码；**许可需在再分发前核实** | 只读调研：Change Ledger 的"操作—回执—可回退"三段形状 | `src/core/entities.ts:377` 的 `Operation` 形状、`src/core/records.ts` 的操作与回执面 |
| `qingyou002/dsh-track` | 未复制代码；**许可需在再分发前核实** | 只读调研：决策点协议与状态机表格化 | 事件形状 `src/core/control.ts:91-96`（`kind` + `detail`）与 `src/core/commands.ts` 的事件追加 |
| `dsh-kanban` 一类台账插件 | 未复制代码；**许可需在再分发前核实** | 只读调研：台账可读性——表格排序必须用显式键 | `src/views/export.ts:57` 的确定性排序 |
| `bowenliang123/dsh-context` | 只读集成、未复制代码、**本机已安装**（`<DSH_HOME>\profiles\web\node_modules\dsh-context`，v0.70.0，其 `package.json:3`；许可 **Apache-2.0**，同文件 `:86`）；再分发前需按 Apache-2.0 核实 NOTICE 义务 | 上下文组成/演变/事件观测（设计稿 §27.1、§27.2 的三个投影） | `src/adapter/dsh-context.ts:1-6`（适配头注）、`:632`（宿主直读面分界）、`:1520`（投影探针）。与 `@2jumpsina/dsh-context-guard` 是**不同项目** |
| `knighthongyu/dsh-handoff-compaction` @0.2.0-rc.6 | 调研；**许可需在再分发前核实** | 只取"不虚构 ID"这一条概念 | `src/rotation/brief.ts` 的段落约束（`:143,253`）；未引用其代码 |
| `heartmove/dsh-session-bridge` | 声称 MIT、仓库内无 LICENSE 原文 ⇒ **禁用** | 只用其公开 API 形状作参照 | `src/adapter/host-types.ts` 的 `resolveAgent`/`create` 形状；未复制代码 |
| `basic-memory`（AGPL-3.0）、Phoenix（ELv2）、Zep Community Edition、Roo Code | 许可红线 / 项目停更 | 未使用：不复制代码、不引依赖 | — |
| `dsh-auto-continue`、`dsh-automation`、`dsh-background-agents` | **待核实**：本仓库内查不到归属记录 | **待核实**：`THIRD_PARTY_NOTICES.md`、`vendor/`（只有 3 份 `LICENSE.*` + 2 份复制件 + 1 份 `.orig`）与全部 `src/` 头注都没有这三者的引用痕迹；在本包全部材料里检索这三个名字也无命中 | 这三类行为（任务自动接续、定时/事件自动化、后台执行）在本仓库由 `src/rotation/*` + `src/adapter/rotation-runner.ts` + `src/index.ts:2079-2113` 的三个定时器（outbox / 租约 / 任务板）自行承担；若后续确认存在借鉴，需补 `THIRD_PARTY_NOTICES.md` 行与许可核实 |

`src/adapter/host-types.ts`、`src/views/export.ts` 等文件里出现的 `<DSH 源码>` 路径引用是**宿主本体的 API 口径出处**（设计稿 §16、§20），不是第三方再分发内容。本包自身许可见 `package.json:86`（MIT）。

## 11. 范围与待核实

- 设计稿的运行时验收未开展：该稿自述"第七点的可运行验证集与设计—代码覆盖审计未开展"（`../DSH长期任务连续性与混合多代理框架_设计稿_v0.5_20261014.md:1516`），§29/§36 的正反例是本包的测试依据，但"真机 profile 上的注入故障验收"仍未做。本 README 第 3 节的用例数与第 7.2 节的续期实测是当前仅有的两类证据。
- 审阅 R1–R8 与**新版复审 N1–N4 / G1–G3** 的修复已在源码落地并有回归测试（R1 守卫快照、R2 outbox 领取/确认、R3 存储 CAS、R4 归档、R5 过期重放、R6 镜像默认关、R7 dsh-context 夹具、R8 租约贯穿与版本身份；N1 投递跨页核对、N2 请求派生 ID（阶段 1 内核命令 32 处；阶段 2 v0.5 领域对象 9 处 + 4 处既有幂等键入口，并在 7 个创建类命令上加"派生 ID 已存在即原地退回"守卫）、N3 归档完整性、N4 历史回读与时间线合并；G1 原生 Team 只读适配与 Lead 保护、G2 质量决策链上生产、G3 左右联动数据面）。**已构建并部署**：2026-10-15 21:51 与 21:53 两次同步把 `lib`（与 `src` 逐文件对应）与 `client.js` 覆盖到 `<DSH_HOME>\plugins\dsh-long-task-continuity`，逐文件 SHA256 校验 0 不一致。**生效待启动**：web profile 当前没有在跑的进程（3080 空闲），所以不存在"旧代码还在跑"的残留；下次启动 web profile 即加载新产物。真机端到端验收（轮换 / 压缩 / Team 调度 / 浏览器交互）仍未做。
- 审阅计划第 5/6 步的只读工作台已在源码落地：宿主半是 `src/views/workbench.ts` 投影 + `/api/continuity.workspace`（`src/index.ts:1120`，与 `/api/continuity.ledger` 同一条 GET 栅栏；`workbenchRead` 接受 `?sessionId=`，用它定位要读哪个会话所属 Team 的原生板，复审 G3），浏览器半是 `client.js` 的 `continuity-workbench` 页（筛选、详情、会话跳转、刷新与错误显示、执行态/验收态徽标、原生板只读区，只发这一条 GET，不发写请求；页签从座位标准 prop 取 `sessionId` 拼进查询串）。**同样未部署**：宿主半边要 `npm run build` 产 `lib/src/views/workbench.js` 并覆盖，浏览器半边要覆盖 `client.js`，生效都要重启 web profile；`client.js` 不进构建产物，改动它只需覆盖文件本身。旧任务板镜像（`teamBoardMirror`）已默认关，遗留的镜像行清理见待办。
- 单写者锁 `hostLockPath` 默认留空（不启用）。多实例共用同一 `storageDomain` 的部署必须显式声明锁路径，否则两个进程会并行提交同一条控制记录（命令队列只在一个进程内串行，不构成跨进程锁）。
- `smoke.mjs` 只加载 23 个模块（`src` 的 22 个 + `vendor/redaction.ts`），`src` 余下 16 个不进 smoke 名单（第 3 节列了名单）：其中 14 个的覆盖靠 `test/` 用例，`src/index.ts` 靠 `harness.mjs` 走装配路径，`src/views/workbench.ts` 由 `test/views-workbench.test.ts` 覆盖投影行为、`client.js` 由 `test/client-bundle.test.ts` 从外部驱动（假 `__ModuleLoader__` + 存根 require）。是否把这 15 个也接进 smoke 名单，待拍板。
- 第 12.3 节盲区的补偿只做到了"如实声明"，**取文件全集的那一步没接**：`<工作区>` 已核实是 git 工作树（`git rev-parse --is-inside-work-tree` 返回 true，`git status --porcelain` 当下就有输出），把这份清单并入 checkpoint 交接包是可直接做的改动，但它会改变交接包内容面、需要重跑预算测试，本版本未做。
- **部署记录（2026-10-15 21:51 / 21:53）**：入口是 `lib/src/index.js`（`package.json:7`）；web profile 通过 `<DSH_HOME>\profiles\web\node_modules\dsh-long-task-continuity` 这个 **Junction** 指向 `<DSH_HOME>\plugins\dsh-long-task-continuity`，所以覆盖插件目录即刻对 web profile 生效，不需要改 profile 配置。同步清单 89 项（`lib/**`、`src/**`、`client.js`、`README.md`、`cordis.patch.example.yml`、`package.json` 等），两次共覆盖 54 项，SHA256 校验 0 不一致；**未删除任何文件**——部署副本原有的 `lib/src/index.js.bak-20261015-1350-mirrornoff`（当日关镜像热修）与源码侧的 `.bak` 都原地保留，部署前快照留在 `<DSH_HOME>\.plugin-fix-backup\dsh-long-task-continuity-20261015-215109` 与 `-215317`。**desktop profile 没有引用本插件**（其 `cordis.patch.yml` 与 `package.json` 里都搜不到 `continuity`），桌面端不受本次部署影响。实机加载冒烟：在 `<DSH_HOME>\profiles\web` 下 `import('dsh-long-task-continuity')` 返回 `PROFILE_IMPORT_OK`，peer 依赖链完整（浏览器半 `client.js` 需要 `window.__ModuleLoader__`，在 Node 里报 `window is not defined` 属预期，不是缺陷）。
- 本包没有变更记录文件（`CHANGELOG.md`）：源码改动、构建时间、部署副本热修三类历史目前只散落在 README 与部署目录的文件名里。是否补一份 CHANGELOG，待拍板。
- 第 4 节末的 **`link:` 锁定条目缺失**待批准修复：补齐要在 web profile 里跑一次带锁写入的 `pnpm install`，与"重启/改动现网运行环境需批准"这条约束冲突，因此保持现状（软链在跑、锁里没有）。
- 第 10 节里"许可需在再分发前核实"的五项——`dsh-turn-rewind`、`dsh-track`、`dsh-kanban` 一类、`dsh-handoff-compaction`，加上已核实为 Apache-2.0 但 NOTICE 义务仍未清的 `dsh-context`——以及 `dsh-auto-continue`/`dsh-automation`/`dsh-background-agents` 三项是否存在借鉴，都要在再分发前核实并回填 `THIRD_PARTY_NOTICES.md`。

## 12. PTC / Code-Mode 适配（能不能全程用 PTC）

结论：**可以全程 PTC，本包不需要为此关掉任何功能**。PTC 的收敛发生在**呈现面**而不是**注册面**——工具照常注册、照常带策略与审批、照常返回结构化值，只是模型每轮看到的工具声明被投影成只剩 `run_code`。下面每条都给宿主仓库（`<DSH 源码>` @ v0.2.1-alpha.1）的出处。

### 12.1 呈现面收起、注册面不动的四条证据

- **投影只筛声明**：`mode==='ptc'` 且非嵌套时，`registry.schemas()` 只留 `run_code`（dsh: `packages/core/tools/src/index.ts:1024-1026`），`knownNames` 同集合（`:1024`）；`collapses()` 的判据是 `!nested && mode==='ptc' && name!==RUN_CODE_NAME`（`:1352`）。嵌套调用与被 `run_code` 派发的工具**不折叠**，所以我们的 21 个 `continuity_*` 依然可达。
- **直生命名调用会给出可执行的失败**：`packages/core/tools/src/index.ts:1471` 的报错文本明确告知"改用 `run_code` 调用"。也就是说漏网不是静默无响应，而是带回执的拒绝——台账侧看得见。
- **`run_code` 这个名字被保留**（`:1080-1081`、`:1111-1112`），本包没有也不能占它。
- **系统提示组装的门禁与本包无关**：`packages/core/system-prompt/src/index.ts:223` 会对 `toolOrder` 里未注册的工具名直接抛错；本包不声明 `toolOrder`（全仓库 `grep toolOrder` 命中 0 处），PTC 下 `knownNames` 只剩 `run_code` 这一事实有 `packages/core/tools/tests/ptc.spec.ts:542` 为证，因此这条门禁不会因为换模式被触发。官方 ptc 预设 `packages/bundle/web-app/presets/ptc.patch.yml` 保留 goal、plan-mode、compaction + tool-result-pruner、subagent（spawn/fork、可续跑）、ask-user、todo、web、present、skill、jobs、schedule，只关 tool-workflow、workflow-ptc、tool-ralph、plugin-manager/tools，win32 上另关 tool-bash（改用 pwsh）——本包不依赖被关的这几项。

### 12.2 必须改的四处（都已改，都在本包内）

1. **观测要同时吃两对生命周期**。原生是 `tool/call` + `tool/result`，Code-Mode 的嵌套派发是 `tool/ptc-dispatch-start` + `tool/ptc-dispatch`（dsh: `packages/core/tools/src/ptc.ts:587-599` 与 `:613-619`，字段 `rootCallId/parentCallId/subCallId/name/arguments/isError/error/content`）。只订阅前一对，会在 PTC 会话里把"没观测到"读成"没有工具在跑"——正是设计稿 §27.1 禁止的误读。接线在 `src/index.ts:1959`，配对逻辑在 `src/rotation/facts.ts:76,96`。
2. **`arguments` 有两种形状**。原生 `tool/call` 带**字符串**（dsh: `packages/core/agent-loop/src/tool-calls.ts:264` 的 `block.arguments`），`tool/ptc-dispatch` 带**已解析对象**（`packages/core/tools/src/ptc.ts:187-203` 的 `jsonNormalizeArgs` + `snapshotJsonValue`）。台账统一序列化后再交给 `collectFileChanges` 解析路径（`src/rotation/facts.ts:43`），否则 PTC 下的改动清单会恒空。
3. **结果只结算最早那条未收束的调用**，并且要能处理"只见到 dispatch 没见到 start"（start 事件在装载之前发生）。`src/rotation/facts.ts:96` 起的那支在找不到对应记录时补一条已收束行，`hasUnsettled`（`:137`）因此仍把重试中的第二次调用算成"在跑"。
4. **超时重放防护**：`run_code` 的截止默认 120 秒、上限 600 秒，而且**把嵌套工具调用与审批等待都算在截止里**（dsh: `packages/ptc-runtime/ptc-runtime-node/src/index.ts:55-56`，超时口径见 `packages/core/tools/src/ptc.ts:121`）。官方描述还写明程序**不会被自动回放**、"Earlier effects may already have completed: inspect them before explicitly retrying"（dsh: `packages/core/tools/src/ptc.ts:132` 的 escalationGuidance；`packages/core/tools/README.zh.md:195` 另写明只读调用可并发、**写调用单独跑**）。于是 PTC 下有一条现实路径：run 截止一到就触发 run 级 abort——排队未派发的调用直接作废（dsh: `packages/core/tools/src/ptc.ts:488-491`、`:542`），**已经派发出去的调用会收到这个 signal**（`:409-412` 写明"an in-flight sub-dispatch is aborted (its executor kills on this signal)"），能否停在副作用之前取决于工具自身；跑完才到的结果则被丢弃（`:671`）。我们的写命令是一次内核提交，提交先于 abort 到达时，台账已落地、程序只收到超时错误；而 `requestId` 含**当前修订号**（`src/adapter/tools.ts:177`），落地后修订号已推进，重试看起来是新请求，内核去重（`src/core/commands.ts:827-834`）认不出来，第二次副作用照常写入。补法是提交前拦一次：同内容 + 不同 `requestId` 且落在窗口内 ⇒ 退回"先读台账核对上一次是否已落地"，而不是再写一遍（`src/adapter/tools.ts:103` 的 `ReplayGuard`、`:179-186` 的接线、设置项 `replayWindowMs` 默认 120_000）。内核去重仍是唯一幂等真源，这层只是提前拦；记录丢失或进程重启的后果只是少拦一次。

### 12.3 一个改不掉的盲区，与它的补偿

程序里 `await import('node:fs')` 直接读写文件是**合法的**（沙箱策略允许，见 dsh: `packages/ptc-runtime/ptc-runtime-node/src/index.ts:67-68` 的 executionInstructions），这类改动不经过任何工具生命周期，因此**既不在本包台账的改动清单里，也不在 dsh-context 的 `fileOps` 里**（后者只从"`tool/call` + `tool/result`，或嵌套 `tool/ptc-dispatch`"折算，installed dsh-context `lib/index.d.ts:334-336`，嵌套操作记在父 `run_code` 上）。补偿按设计稿 §27.1 的"如实声明覆盖范围"来做，而不是假装完整：`src/rotation/facts.ts:160` 数出本会话观察到多少次 `run_code` 程序执行，`factsFromLedger` 的 `inheritedNote`（`:227-236`）就把"这部分改动不在本清单内，需要文件全集时以工作区自身为准"写进交接包。工作区自身的口径已核实可用：`<工作区>` 是 git 工作树，checkpoint 时取 `git status --porcelain` 的文件清单并入交接包即可（这一步尚未接进 `continuity_checkpoint`，属第 11 节的待办）。

### 12.4 客户端与呈现不受影响

嵌套子调用走的仍是宿主那个按工具名取槽位的渲染口（dsh: `packages/client/ui-tool/src/client/tool/ToolCallTree.tsx:52`，`renderSlot('tool.call.toolview', owner, { entryKey: toolName, fallback: GenericToolCard })`），本包只挂 `tool.call.toolview`（`client.js:1095`），因此 PTC 下工具卡片照常出；宿主会话面在只收到最终 dispatch 时会补一条已收束子行（`packages/client/ui-chat/src/client/conversation-nodes/tool.ts:196-223`），`ui-plan`、`ui-trajectory`、`ui-tool/todo-history`、`packages/api/session-controller/src/commands.ts:647` 都已认识 ptc 事件。斜杠命令不经过工具呈现，`/continuity` 全组不受模式影响。

### 12.5 换模式的代价与收益（本机真会话日志实测）

口径：`totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`（dsh: `packages/llm/llm-deepseek/src/translate.ts:160`）；改模式或改工具筛除会**从第一个变化 token 起击穿 KV 前缀缓存**（`packages/core/tools/README.zh.md:205-207`）。

| 会话 | 请求数 | prompt 合计 | 均值/请求 | 缓存读占比 | 工具面材料 |
| --- | --- | --- | --- | --- | --- |
| `ea774604…` | 2,936 | 1,350,500,424 | 459,980 | 99.6% | 826,118 est tokens |
| `11678dc5…` | 2,678 | 1,253,456,550 | — | — | 2,004,630 est tokens |

`ea774604…` 上"每次调用把全部工具材料重发给模型"的量是 32,679,049 est tokens；把 N 次独立调用折进一个程序（批量）能消掉的上界是 1,269,237,103 prompt tokens，占该会话 prompt 总量的 **94.0%**。这是**上界**，不是承诺值：真实收益取决于程序内合并掉了多少轮、以及 `run_code` 里返回值仍需上行（只有打印/返回的值进模型，`packages/core/tools/README.zh.md:196`；中间值不可重放且无界，`:235`）。切换的一次性成本是一次前缀重建，量级约等于一个全新前缀（该会话均值 459,980 tokens 的未命中价）。Windows 标准模式下的主要浪费是 pwsh 逐条往返——`11678dc5…` 里 pwsh 调用 1,426 次，正是 PTC 收益最大的那一类；这与"PTC 完成同一个任务比标准模式省更多 token"的口径一致：**不是配额口径，而是同一任务的往返次数口径**。
