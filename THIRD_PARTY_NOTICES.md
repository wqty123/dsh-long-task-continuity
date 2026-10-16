# 第三方归属（Third Party Notices）

本包的第三方源码分布在两处：逐字复制的在 `vendor/`，移植或改写的在对应源文件头部注明。

## A. 逐字复制（`vendor/`）

| 文件 | 来源 | 许可证 | 用途 | 改动 |
| --- | --- | --- | --- | --- |
| `vendor/redaction.ts` | `qingyou002/dsh-auto-handoff` @0.1.0 | MIT（`vendor/LICENSE.dsh-auto-handoff`） | 交接包与提示词的凭证脱敏：`sk-`/`ghp_`/`github_pat_`/`xox…-`/`AKIA…`/`AIza…`/`JWT`/`Authorization:`/`Bearer`/`KEY=value`/查询串凭据，外加 32 位以上十六进制与 base64 大块 | **无**，逐字引用 |
| `vendor/graceful-stop.ts.orig` | `qingyou002/dsh-auto-handoff` @0.1.0 | MIT | 软停闩 + `agent/pre-step` 决策 + 双边界等待的原始参照 | **无**；`.orig` 后缀表示不参与编译，其适配版见下 |

## B. 移植或改写（在源文件头部注明）

| 本包文件 | 来源 | 许可证 | 拿了什么 | 改了什么 |
| --- | --- | --- | --- | --- |
| `src/rotation/latch.ts` | `qingyou002/dsh-auto-handoff`（`vendor/graceful-stop.ts.orig`） | MIT | 闩的键控形状（按 sessionId 持有）、`agent/pre-step` 的三种决策（enter / 改道 / 放弃） | 键改为 Actor 与双会话（源/目标）；加入 `boundarySlowMs`/`boundaryDeadlineMs` 的等待上限；放弃路径接本包的 `continuity.failRotation` |
| `src/rotation/policy.ts` | `@2jumpsina/dsh-context-guard` @0.3.4（`vendor/LICENSE.dsh-context-guard`） | MIT | 占用率判定：迟滞、跨档边沿、冷却轮数、读不到数据时 fail-closed | 从 JS 配置改为 TS 纯函数；`respectCompaction` 与"压缩后回落"接本包的 `compaction/end` 观测；新增 `decideRotation` 的机器可读原因串 |
| `src/rotation/lines.ts` | `Fei2411/DeepSeek-Bot`（`vendor/LICENSE.ds-bot`、`vendor/NOTICE.ds-bot`） | Apache-2.0 | `linesFor` 的窗口折算（usable/hard 两线，硬线取 95%） | 判定比例改为本包口径：`C = floor(min(r·W, W−R−H))`、`T = min(floor(p·W), C−M)`；缺任一口径 ⇒ `observation` |
| `src/rotation/brief.ts` | `Fei2411/DeepSeek-Bot` | Apache-2.0 | 交接段落清单与"预算内截断"的思路 | 8 段结构与保护段规则、截断顺序、`estimateTokens` 的 CJK 口径、脱敏调用改指 `vendor/redaction.ts` |
| `src/adapter/services.ts` | `qingyou002/dsh-auto-handoff`（`forAgent`） | MIT | 服务解析顺序：先 agent 面再 host 面 | volatile 引用判定改为全局 symbol `Symbol.for('cosmokit.volatile.write')` |

## C. 设计参考

下列项目的数据结构或约束影响了本包的设计。

| 来源 | 影响了什么 |
| --- | --- |
| `qingyou002/dsh-turn-rewind` | Change Ledger 的"操作—回执—可回退"三段形状 → `src/core/entities.ts` 的 `Operation` |
| `qingyou002/dsh-track` | 决策点协议与状态机表格化 → `core/events` 的 `kind/detail` 事件形状 |
| `dsh-kanban` 一类台账插件 | 台账可读性：表格排序用显式键 → `src/views/export.ts` 的确定性渲染 |
| `knighthongyu/dsh-handoff-compaction` @0.2.0-rc.6 | "never invent ids" → `src/rotation/brief.ts` 的段落约束 |
| `bowenliang123/dsh-context` | 上下文组成与演变观测的数据源 → `src/adapter/dsh-context.ts` 的只读适配器（投影形状识别、缺省降级、零值不当作健康） |
| DeepSeek Harness 本体 | 宿主 API 口径：`sessionController.create/resolveAgent`、`sessions.flush`、`sessionProjections.stateOf`、`agent/pre-step`、`tools.guard`、`storageDomain`；以及 `compaction/compaction`、`session-query`、`context/session-reference` 的只读边界。`src/adapter/host-types.ts` 是本包写的结构化视图 |

## D. 随分发必须保留的文件

- `vendor/NOTICE.ds-bot`（Apache-2.0 §4 要求 NOTICE 随分发）
- `vendor/LICENSE.ds-bot`、`vendor/LICENSE.dsh-auto-handoff`、`vendor/LICENSE.dsh-context-guard`
- `vendor/README.md`（逐字复制清单与改动说明）

本包自身的许可见 `package.json` 的 `"license": "MIT"`。第三方许可原文以 `vendor/` 内文件为准。
