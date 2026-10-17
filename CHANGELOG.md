# 变更记录

## 0.2.8 — 2026-10-17

### 第 1 项 · 统一事实来源与术语（README）

新增「边界」一节，把四处口径写定，避免 README、适配层与判定逻辑各说一套：

- **执行事实与验收事实分开**：原生 Agent Team 负责任务领取、租约与完成；插件只记录审计与验收结论（`submitted` / `accepted` / `changes_requested`），不建第二套执行队列。原生 `completed` 只是执行结束，不等于验收通过。
- **按工作包审核，不按步骤**：包内方法选择、实现调整、子代理安排、路线试验由执行者自主；只有目标改变、资源或预算扩大、新增未授权外部操作才重审。
- **阶段交付与 Mission 关闭是两种边界**。
- **成员内部的子代理不升级为 Actor**。

同时修掉 README 徽章的过期版本号（`0.2.3` → `0.2.7`）。

**迁移旧 Attempt/租约**：当前不触发。`SCHEMA_VERSION = 3` 未变，`entities.ts` / `control.ts` / `store.ts` / `kernel.ts` 在本轮改动中零 diff，没有需要迁移的对象。

### 第 3 项 · 定向失效（部分完成）

`ReviewReceipt` 的完成判据加"审查必须晚于**本版**任务"：任务改过（`updatedAt` 前移）之后，旧审查自动失效。

这比要求人手"记得重审"可靠，也比给实体加 `targetRevision` 字段安全——后者要升 `SCHEMA_VERSION`，而版本不符是**直接拒绝装载**（`SchemaVersionMismatch`），现有台账会读不出来。

判据：`test/audit-f4.test.ts` 增加反例③（任务改版后旧审查不能消掉缺口）。

### 未做

- **第 3 项其余**：批审命令、审核绑定用途/对象版本/产出物。它们要改 `ReviewReceipt` 与 `Command` 联合类型，即改存储结构；必须先有迁移层，否则升级会拒载现有台账。下一轮的第一件事是**先写迁移，再加字段**。
- **第 2 项** 自动采集 audit（复用子代理最终答复、重启对账）。
- **第 7 项** 上下文行动与 UI 接通。
- **第 8 项** 真实任务的行为验收与成本对照。

### 判据

全量 **606 用例 / 604 通过 / 0 失败**；`tsc -p tsconfig.check-all.json` 0 错。

## 0.2.7 — 2026-10-17

### 编队界面新增两块面板：「纪律（当前生效）」与「注入确认」

右侧编队页签末尾新增两块，都**独立于台账数据**——没有 Mission 时也要能看出纪律从哪来。

**纪律（当前生效）**：直接从 `$DSH_HOME/AGENTS.md` 现读，显示路径、sha256 前 16、字节数、修改时间，以及按 `##` 切开的小节正文。**不在插件里存副本**——存副本会让面板显示的与实际执行的两边悄悄漂移。文件读不到时如实报缺失，不回落成任何内置文案。

**注入确认**：三类身份各自走哪条链路，证据分「实测」与「同路径未单独实测」两档：

| 身份 | 源 | 证据 | 依据 |
| --- | --- | --- | --- |
| Leader | `$DSH_HOME/AGENTS.md` | 实测 | 本会话上下文可见 |
| 成员 | 同一份 | 同路径未单独实测 | `spawn_teammate` 起的是独立 session，与子代理同链路 |
| 子代理 | 同一份 | 实测 | 见下 |

### 注入实证

起一个 fresh 子代理，只让它回答"上下文里有没有以「# 团队纪律（leader 与成员共用）」开头的段落"。它原样回引了该标题，以及「## 派单按工作包，不按步骤」下的第一条要点。

**结论**：`dsh-agent-instructions` 在**每个 session** 首个请求前把该文件作为 baseline 写进 durable context；leader、成员、子代理各是独立 session，因此各自拿到**同一份**。差别只在哪个 session 加载它，不在内容。

成员那一档刻意标 `inferred`：链路上与子代理相同，但本轮没有单独起成员验过，面板不把推断写成事实。

### 实现

- 新增 `src/views/discipline.ts`：分节、指纹、身份口径
- `src/index.ts` 注册只读路由 `/api/continuity.discipline`（GET）；读盘失败即报缺失
- `client.js`：两块面板 + 中英文案 + 独立 `fetch`（跟着 `tab.signal` 取消）
- 判据：新增 `test/discipline-view.test.ts`（切节 / 缺失不回落 / 指纹随内容变 / 三身份同源）；`client-bundle.test.ts` 的"只有一处 fetch"改为"每处 fetch 都必须指向只读投影路由"，比数量更能防住写入型请求混进来

### 判据

全量 **605 用例 / 603 通过 / 0 失败**；`tsc -p tsconfig.check-all.json` 0 错；`node --check client.js` 通过。

### 生效条件

本版改的是服务端路由与客户端 bundle，**需要重启 `dsh web` 才装载**。当前运行的实例早于本次部署，面板在重启后才可见。

## 0.2.6 — 2026-10-17

按《整体简化与具体修改方案》修掉三处会把模型往保守和打卡上推的设计。本次只做方案 §7 的第 4、5、6 项，其余见文末。

### 第 4 项 · 检索门槛（`core/completion.ts`）

旧判据要求"每个执行者都有一条 `coverage=complete` + `outcome=found`、且时刻晚于自己开工"的检索回执。三处都过重：**强制 must-find**（新任务或范围内确实没有时永远过不了）、**按人重复**（同一范围每人重查）、**卡开工时间**（派单前查过的不能复用）。

现在改成**验质量而非验存在**：不强制必须有回执；只有"登记了回执、却没有一条覆盖完整"时才报缺口。合格形态含 `found` 与 `not_found_in_scope`。`partial` / `unknown` 仍不能当作"范围内没有"——那才是假阴性的来源。

### 第 5 项 · 阶段交付与 Mission 关闭分开（`core/completion.ts`）

`missionCompletion` 增加 `boundary: 'mission' | 'phase'`：

- `mission`（默认，`mission.complete` 在用）：未结算 Attempt / 未定操作 / 待办 / 预算全局计入。
- `phase`：只追究**纳入本阶段的任务**名下的进行中工作（`Attempt.taskId`、`Operation.taskId`），无关后台工作不妨碍交付。

命令层尚无独立的"阶段交付"入口，故 `mission.complete` 保持 `mission` 语义——不擅自改动"关闭整个 Mission"的含义。`phase` 作为库能力备好，等入口定下来再接。

### 第 6 项 · 纪律精简（`$DSH_HOME/AGENTS.md`）

1028 → 1142 字符，**替换而非追加**：

- 删掉"（硬要求，不是建议）"这类绝对化表述。
- 新增「派单按工作包，不按步骤」：一次派单给完整工作包，包内方法选择、实现调整、子代理安排、路线试验由执行者自主；只有目标改变、资源/预算扩大、新增未授权外部操作才重审。试验失败与推翻猜想属于正常负结果。
- 检索条款改为"覆盖 complete 且结果明确（含范围内没有）即为有效回执；同一范围已查过的直接复用"。
- 「纪律的演化」加分类：违纪 / 工具或环境故障 / 正常负结果，只有违纪才加纪律；修改已有条款优先于追加。
- 复核条款加"共用同一份证据，只审本次新增与差异"。

### 判据

全量 **601 用例 / 599 通过 / 0 失败**；`tsc -p tsconfig.check-all.json` 0 错。

### 未做

- **第 1 项** 统一事实来源与术语（README、agent-teams 适配、迁移旧 Attempt/租约）。
- **第 2 项** 自动采集 audit、复用子代理最终答复、重启对账。
- **第 3 项** 审核包复用、批审、定向失效与补审。
- **第 7 项** 上下文行动与 UI 接通。
- **第 8 项** 行为验收与成本对照——需要真实任务，单测替代不了。

## 0.2.5 — 2026-10-17

### 修复生效审计（0.2.4）的四个已复现问题

审计来源：`功能生效审计_0.2.4_20261017.md`（F1–F4 与类型基线）。

**F1 · 质量链被权限挡死**。`context.assess` / `context.invalidateAssessment` / `context.applyRunPlan` / `context.applyActionOutcome` 原先只列在 supervisor 权限集，而质量链由插件机制以 **Lead/Member 身份**自驱动，每次评估必然停在 `role lead is not allowed to issue context.assess`。
修法不是把请求升成 supervisor，而是**放开给 Actor 并加归属校验**：`assess` 要求 `freeze.sessionId === ctx.sessionId`；其余三个要求 `state.assessments[id].actorId === ctx.actorId`。跨会话与未绑定会话一律挡回。

**F2 · 成员事件串账**。全局 `session/event` 收到任何 `team/member` 都写进"当前 Mission"，没核对来源。现在先验归属：`teamId` 必须等于本 Mission Lead 绑定的会话 id（原生 Team 以根会话组织），否则只记一条日志后返回。同时修掉成员键的稳定性——不再"`member-<name>` 已存在就跳过"，同名但不同会话加会话后缀，重建成员才拿得到身份。

**F3 · 守卫范围过大**。`memberCreationGuard` 原先对"未绑定 Actor"一律拒绝，等于把"用原生 Team"的前提扩大成"所有会话都必须先被本插件纳管"。现在只在**已纳管但身份不是 Lead** 时拒绝；会话未知或未纳管一律放行，交给宿主自己的校验。

**F4 · 复核判据只验"存在一条记录"**。
- R4 排除**本任务的执行者**：自审不再能消掉"没有独立复核"。
- R5 要求检索回执**晚于该任务第一次 attempt 开始**且 `coverage=complete` + `outcome=found`；"曾检索过一次"不算合格。
- R6 要求 reviewer 记录**晚于最后一次交付**；审一条无关旧对象不再满足整体审核。

**F5 · `Request.url` 类型依赖**。工作台路由原先直接读 `request.url`，在缺少 harness `typeRoots` 的依赖基线里类型检查失败。改为按最小形状取（`(request as { url?: string }).url`），缺失视为"未指定会话"。运行时不依赖该属性存在，行为不变。

### 判据

- 新增 `test/audit-f4.test.ts`：自审无效 / 独立审查有效 / 交付前旧审查无效，三条都直接打在 `missionCompletion` 上。
- `test/v05-wiring-commands.test.ts` 增加 F1 判据：评估自己会话允许、跨会话挡回、未绑定会话挡回。
- 更新 `test/r1-lead-only-spawn.test.ts` 与权限表用例到新语义。
- 全量：**601 用例 / 599 通过 / 0 失败**；`tsc -p tsconfig.check-all.json` **0 错**。

### 未完成（诚实记录）

- **F2 没有单测**：`onTeamMemberEvent` 在组合层的闭包里，直接可测的只有 `teamMemberOf`（已有）。归属判据需按审计 §6.2 用生产入口验证：两个无关团队不能串账。
- **G1–G4 未动**（原生 Team 唯一执行来源、语义判断与行动闭环、主动触发、纪律可移植性）——它们不属于本次"已复现问题"。
- **真实模型回合、压缩与轮换仍未验收**。

## 0.2.4 — 2026-10-17

### 适配 DSH `0.2.1-rc.1`（宿主 `dsh-v0.2.1-alpha.1` → `dsh-v0.2.1-rc.1`）

逐项核对本包依赖的宿主面，**代码零改动**：

| 本包依赖面 | rc.1 里的变化 | 结论 |
| --- | --- | --- |
| `defineTool`（`@deepseek-ai/dsh-tools`） | 未变 | 无需改 |
| `tools.guard` / `tools.register` / `guardReason` | 未变（该文件在版本走廊内对这几个符号零 diff） | 无需改 |
| agent 钩子：`agent/pre-step`、`agent/status`、`session/event` | 未变 | 无需改 |
| `@deepseek-ai/dsh-storage-domain` 的 `domainTable` / `defineDomain` | 未变 | 无需改 |
| `sessionProjections.register()` 的清理函数 | 由 `() => void dispose()` 改为 `return dispose`（语义等价） | 无需改 |

**装载实测**（web profile，rc.1 实例 PID 16084，2026-10-17 18:01:05 启动）：`continuity_status` 返回真实台账（Mission 已绑定、修订 38），22 个工具可用。

**判据**：`tsc -p tsconfig.check-all.json` 0 错；**597 用例 / 595 通过 / 0 失败**。

### 一处刻意不动

包内 7 处 `v0.2.1-alpha.1` 注释是**口径来源标注**，保留原样——改成 rc.1 会变成没有逐条核过的表述。rc.1 的核对结论集中在本节。

## 0.2.3 — 2026-10-16

### 新增：交付与收口面的三条复核判据（R4 / R5 / R6）

三条都挂在 `missionCompletion` 的缺口清单上（`src/core/completion.ts`），**不在日常路径上硬拦**：

- **R4**：已交付（`submitted` / `completed`）却没有独立复核的任务。成员把一摊活交给 Lead 之前，要有人核过"这件事之前是否做过、结论与之前是否冲突"——`ReviewReceipt.versusHistory` 停在 `unknown` 等于没核（字段本身就分这三档：`consistent` / `conflict` / `duplicate`）。
- **R5**：接了单却从没登记过检索回执的执行者。"派单是**基于 audit** 的安排"这句话要有落点——接收方自己核过，才算复核过这个安排（`SearchReceipt.recordedBy`）。
- **R6**：**确有交付时**，收口前要有 **reviewer 身份**登记的审查记录。这跟逐任务的验收不是一回事：逐条判据属于 `criteriaReport`，这里要的是有人从整体上看过一遍。空基线不要求——干净清白的 Mission 不欠谁一次审核。

### 一次被自己原则纠正的设计

R4/R5 最初做成了 `task.submit` / `task.claim` 的**硬拒绝**，结果 45 条既有用例断在半路。本插件对自己的 guard 早有判断（`src/adapter/capabilities.ts:141`：*"覆盖不明 ⇒ …不用 guard 误伤正常干活"*）——把复核做成日常路径上的门，等于让每个正常流程都过不去。已改挂收口面：**日常干活不打折，收口时必须清零**。

### 判据

- 全量：**597 用例 / 595 通过 / 0 失败 / 2 TODO**；`tsc -p tsconfig.check-all.json` **0 错**。
- 夹具补前提：`test/acceptance-experiment.test.ts` 的 `satisfiedTask` 补上 reviewer 身份与审查记录，使该用例只测它自己那条判据（探索预留是否阻断完成判定）。

## 0.2.2 — 2026-10-16

### 新增：成员创建只允许由 Lead 发起（R1）

- `src/adapter/dsh.ts` 新增 `memberCreationGuard`：拦本体工具 `spawn_teammate`，要求调用者是**已入台账的 Lead**；非目标工具一律放行，避免误伤全部工具调用。
- `src/index.ts` 注册该守卫，**独立于 `enforceAdmission`**。那条管的是"受管写入有没有未失效的准入票据"，这条管的是**身份权限**，两者不是一件事；而 `enforceAdmission` 默认 `false`（且要过能力门禁才注册），并进去等于这条权限约束永远不上岗。
- **覆盖面已核源码**：`tools` 服务的 guard 在**普通 ctx** 上注册即全局生效（dsh: `packages/core/tools/src/index.ts:1127-1130`：*"A plain-context guard applies globally"*），单调、任何 guard 都无法放开别家的拒绝（`:724-726`），所以**本体工具** `spawn_teammate` 同样在拦截范围内。
- 三种拒绝各自说清原因：会话未知 / 未绑定 Actor / 身份不是 Lead。正常路径静默放行。

### 判据

- 新增 `test/r1-lead-only-spawn.test.ts`：五个分支（非目标工具放行、会话未知、未入台账、非 Lead、Lead 放行）。
- 全量：**597 用例 / 595 通过 / 0 失败 / 2 TODO**；`tsc -p tsconfig.check-all.json` **0 错**。

### 同期落地（不在本插件内）

- `<DSH_HOME>\AGENTS.md`（892 字符）：团队纪律写入 `$DSH_HOME` 的指令注入层。`dsh-agent-instructions` 在**下一个请求**就把它注入成 durable baseline（本机实测当场生效）——纪律从此不靠"谁记得去读文档"，而是每轮都在上下文里。

## 0.2.1 — 2026-10-15

### 新增：原生成员出生即进台账（复审 G1 的最后一环）

- `src/adapter/agent-teams.ts` 新增 `teamMemberOf`：从 Lead 会话的 `team/member` 事件读出成员身份（本体把成员的 `SessionId` 写在这条事件里：`TeamMemberSnapshot.id`，dsh `types.ts:47-55`），按不可信输入收窄。
- `src/index.ts` 的 `session/event` 捕获 `team/member` → `onTeamMemberEvent` 自动走三步：**solo→team 组队**、`actor.register` 绑定会话身份、纳入团队。
  三步顺序不是随意的：内核里 `actor.register` 在 solo 时拒绝非单人角色（`commands.ts:1381`），而 `team.configure` 只接受**已在 `actors` 里**的成员、成员为空就整体拒绝（`:1441-1442`）——两条命令**互相死锁**，只有 Lead 能同时满足它们。
- 效果：成员不再被 `no-bound-actor` 挡在门外；它自己的检查点、证据、验收都记在它自己的身份上，"每个成员遵守同一套纪律"由口号变成机制。

### 审批边界同步收窄（委托人 2026-10-15 当场修正）

- 现行边界：**只有「会变成 Actor 的」子代理需要 Lead 批准**（`spawn_teammate`）；成员为自己那摊活派出的干活型 `subagent` 不需要——那属于成员内部执行。
- 规则落点：本机纪律表新增的 `五·43` 与 `§7`（并把 `五·42` 标为已被收窄）。
- 实现与边界一致（已核对）：`subagent` 包对 `team/member` **零命中**，唯一发射点是 `agent-team/roster.ts:277`（teammate 出生）⇒ 干活型子代理不产生该事件、自然不进 Actor、也不进审批面。

### 判据

- 新增 `test/g1-member-onboarding.test.ts`：钉住内核那对命令的死锁（solo 下直接登记成员必须被拒；成员为空时 `team.configure` 也拒绝），再证明"先组队 → 再登记 → 后归队"三步走得通，且同一会话挂两个未退役身份仍被拒。
- 全量：**592 用例 / 590 通过 / 0 失败 / 2 TODO**；`tsc -p tsconfig.check-all.json` **0 错**。

## 0.2.0 — 2026-10-15

一轮复审的 N1–N4 与 G1–G3 全部落地，并把"已写好但没接进生产链"的模块接通。

### 修复（N 系列）

- **N1 投递跨页**：`confirmSeed` 改有界向后翻页（50 条 × 20 页）；只有翻到会话起点（`hasMore:false`）才判 `absent`，中途停住、面不匹配、游标不前进一律 `unknown`（不重发）。投递凭据由"键子串"收紧为成对标记令牌。
- **N2 请求去重**：创建类对象 ID 由 `requestId` 派生（`derivedId`）——内核命令 32 处、v0.5 领域对象 9 处、既有幂等键入口 4 处；另有 7 个创建类命令执行"派生 ID 已存在即原地退回"守卫。墓碑过期或容量淘汰后重放旧请求不再造第二份对象。
- **N3 归档完整性**：`readArchiveSnapshot` 引入预期覆盖口径，事件与闭合记录两类批次都过校验；被拒批次只进 `batches` + `unavailable`，绝不进可信历史；前缀/中段/末段/全缺失分类报告；`archivedThroughSeq` 只从被采信批次推进。同时修掉"台账为空且控制记录没声明水位"被误报成"全部历史不可回读"的假阳性。
- **N4 历史回读**：新增 `continuity_history` 工具（按 Mission / 对象 / seq 区间回读热+冷事件与闭合记录，带 `nextCursor` 向更旧翻页）；`renderTimelineMarkdown` 按 seq 合并热/冷事件并写明回看窗口。

### 接入（G 系列）

- **G1 原生 Agent Team 只读接入**：`src/adapter/agent-teams.ts` 收窄原生任务、执行态与验收态分列、单卡合并、依赖风险清单；Lead 保护判据接入 `decideRotation`（名册里有队友行才算持有原生身份，读不出来按在场处理）。
- **G2 上下文质量决策链上生产**：`runQualityChain` 由 `agent/status` 转空闲时的空闲维护窗口调用——轮末会话仍活，压缩只会被排队，那正是"记了一次计划当成功"的形态。真机压缩入口为 `compactionPort`，缺引擎或缺活体 Agent 时如实记缺口。
- **G3 左右联动**：`/api/continuity.workspace` 接受 `?sessionId=`，按该会话读所属 Team 的原生任务板；右侧面板任务卡新增执行态/验收态徽标、关卡备注与原生板只读区（`phase`/`risks`/`unlinked`）；页签从座位标准 prop 取 `sessionId`。

### 其它

- 浏览器半补齐 `continuity_history` 的工具卡片；卡片面与 `PLUGIN_TOOL_NAMES` 现在按**集合相等**断言，缺一个/多一个/写错名都会红。
- `README.md` 事实面同步（模块清单 41 个 .ts、工具数 22、token 预算 5238、交付与部署状态）。
- 口径收敛：`tools.ts` 与 `index.ts` 各自的水位算法统一到 `core/archive.ts` 的 `archiveExpectation`。

### 验收基线

- `node --test test/*.test.ts` → 590 用例 / 588 通过 / 0 失败 / 2 TODO。
- `npx tsc -p tsconfig.check-all.json` → 0 错。
- 部署：复审报告 → `<DSH_HOME>/plugins/dsh-long-task-continuity`（web profile 经 Junction 指向它），逐文件 SHA256 校验 0 不一致。

## 0.1.0 — 2026-10-14

首个可用版本：任务状态、执行权、检查点、交接与恢复；审阅 R1–R8 的修复。
