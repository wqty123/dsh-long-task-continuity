# 第三方归属（Third Party Notices）

本包**不是**全部原创。按"有开源比较好的方案就复制其代码并做适配"的原则，凡逐字复制的第三方源码放在
`vendor/`，凡移植/改写的在对应文件头部注明来源。下列每一项都对应仓库里实际存在的文件，不是意向清单。

## A. 逐字复制（`vendor/`）

| 文件 | 来源 | 许可证 | 用途 | 改动 |
| --- | --- | --- | --- | --- |
| `vendor/redaction.ts` | `qingyou002/dsh-auto-handoff` @0.1.0 | MIT（`vendor/LICENSE.dsh-auto-handoff`） | 交接包与提示词的凭证脱敏：`sk-`/`ghp_`/`github_pat_`/`xox…-`/`AKIA…`/`AIza…`/JWT/`Authorization:`/`Bearer`/`KEY=value`/查询串凭据，外加 32 位以上十六进制与 base64 大块 | **无**，逐字引用 |
| `vendor/graceful-stop.ts.orig` | `qingyou002/dsh-auto-handoff` @0.1.0 | MIT | 软停闩 + `agent/pre-step` 决策 + 双边界等待的原始参照 | **无**；`.orig` 后缀表示不参与编译，其适配版见下 |

## B. 移植或改写（在源文件头部注明）

| 本包文件 | 来源 | 许可证 | 拿了什么 | 改了什么 |
| --- | --- | --- | --- | --- |
| `src/rotation/latch.ts` | `qingyou002/dsh-auto-handoff`（`vendor/graceful-stop.ts.orig`） | MIT | 闩的键控形状（按 sessionId 持有）、`agent/pre-step` 的三种决策（enter / 改道 / 放弃） | 键改为 Actor 与双会话（源/目标）；加入 `boundarySlowMs`/`boundaryDeadlineMs` 的等待上限；放弃路径接本包的 `continuity.failRotation` |
| `src/rotation/policy.ts` | `@2jumpsina/dsh-context-guard` @0.3.4（`vendor/LICENSE.dsh-context-guard`） | MIT | 占用率判定：迟滞、跨档边沿、冷却轮数、读不到数据时 fail-closed | 从 JS 配置改为 TS 纯函数；`respectCompaction` 与"压缩后回落"接本包的 `compaction/end` 观测；新增 `decideRotation` 的机器可读原因串 |
| `src/rotation/lines.ts` | `Fei2411/DeepSeek-Bot`（`vendor/LICENSE.ds-bot`、`vendor/NOTICE.ds-bot`） | Apache-2.0 | `linesFor` 的窗口折算（usable/hard 两线，硬线取 95%） | 判定比例改为本包口径：`C = floor(min(r·W, W−R−H))`、`T = min(floor(p·W), C−M)`；缺任一口径 ⇒ `observation`，不猜 |
| `src/rotation/brief.ts` | `Fei2411/DeepSeek-Bot` | Apache-2.0 | 交接段落清单与"预算内截断"的思路 | 8 段结构与保护段规则、截断顺序、`estimateTokens` 的 CJK 口径、脱敏调用改指 `vendor/redaction.ts` 均为本包自定 |
| `src/adapter/services.ts` | `qingyou002/dsh-auto-handoff`（`forAgent`） | MIT | 服务解析顺序：先 agent 面再 host 面 | volatile 引用判定改为全局 symbol `Symbol.for('cosmokit.volatile.write')`，不额外依赖 cosmokit |

## C. 只读调研，未复制代码

这些仓库读过、结论影响了本包的数据结构，但**没有**复制任何一行代码；许可证条款不适用，列此以示出处。

| 来源 | 状态 | 影响了什么 |
| --- | --- | --- |
| `qingyou002/dsh-turn-rewind` | 调研 | Change Ledger 的"操作—回执—可回退"三段形状 → `src/core/entities.ts` 的 `Operation` |
| `qingyou002/dsh-track` | 调研 | 决策点协议与状态机表格化 → `core/events` 的 `kind/detail` 事件形状 |
| `dsh-kanban` 一类台账插件 | 调研 | 台账可读性：表格排序必须用显式键 → `src/views/export.ts` 的确定性渲染 |
| `knighthongyu/dsh-handoff-compaction` @0.2.0-rc.6 | 调研；**许可证未核** | 只取"never invent ids"这一条概念 → `src/rotation/brief.ts` 的段落约束；未引用其任何代码 |
| `bowenliang123/dsh-context` | 只读集成（v0.5 §27）；**未复制代码、未安装** | 上下文组成/演变观测的可选数据源 → `src/adapter/dsh-context.ts` 的只读适配器（投影形状识别、缺省降级、零值不当作健康）。注意与 `@2jumpsina/dsh-context-guard` 是**不同项目**：后者只影响 `src/rotation/policy.ts`（见上表 B） |
| DSH 本体 `D:\deepseek-harness` @v0.2.1-alpha.1 | 只读 | 宿主 API 口径（`sessionController.create/resolveAgent`、`sessions.flush`、`sessionProjections.stateOf`、`agent/pre-step`、`tools.guard`、`storageDomain`）；另含 v0.5 §16 的三条只读证据：`compaction/compaction`（`compactNow` 与维护入口）、`session-query`（全会话查询契约）、`context/session-reference`（只读文本快照的边界）。`src/adapter/host-types.ts` 是本包写的结构化视图，非上游代码 |

## D. 明确未使用（许可证红线）

| 来源 | 许可证 | 为什么不用 |
| --- | --- | --- |
| `basic-memory` | AGPL-3.0 | 网络传播条款与本包"不装载进 DSH、只在单机用"的边界冲突，不复制代码也不引依赖 |
| Phoenix | ELv2 | 商业使用限制 |
| Zep Community Edition、Roo Code | 项目已停更 | 无维护价值，且前者的记忆图谱与本包的单记录真源模型不同路 |
| `heartmove/dsh-session-bridge` | 声称 MIT，**仓库内无 LICENSE 文本** | 归属不可证明 ⇒ 禁用。只参考其公开 API 形状（`resolveAgent`/`create`），未复制代码 |

## E. 随分发必须保留的文件

- `vendor/NOTICE.ds-bot`（Apache-2.0 §4 要求 NOTICE 随分发）
- `vendor/LICENSE.ds-bot`、`vendor/LICENSE.dsh-auto-handoff`、`vendor/LICENSE.dsh-context-guard`
- `vendor/README.md`（逐字复制清单与"是否改动"表）

本包自身的许可见 `package.json` 的 `"license": "MIT"`。第三方许可的原文以 `vendor/` 内文件为准；
若将来移除某个 `vendor/` 文件，必须同步删除本表对应行并检查移植痕迹。
