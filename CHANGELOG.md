# 变更记录

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

新版复审（`E:/ds 维护以及插件制作/复审_20261015/新版复审报告_20261015.md`）的 N1–N4 与 G1–G3 全部落地，并把"已写好但没接进生产链"的模块接通。

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
- 部署：`E:/ds 维护以及插件制作/dsh-long-task-continuity` → `<DSH_HOME>/plugins/dsh-long-task-continuity`（web profile 经 Junction 指向它），逐文件 SHA256 校验 0 不一致。

## 0.1.0 — 2026-10-14

首个可用版本：任务状态、执行权、检查点、交接与恢复；审阅 R1–R8 的修复。
