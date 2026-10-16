# vendor/

本目录是**逐字复制**的第三方源码，用于避免重复造轮子。每份拷贝都保留原作者版权，许可证原文放在同目录的 `LICENSE.*` / `NOTICE.*` 里。
本目录的文件不属于本项目作者，修改前先确认许可证要求。

| 文件 | 来源 | 许可证 | 用途 | 是否改动 |
|---|---|---|---|---|
| `redaction.ts` | `qingyou002/dsh-auto-handoff` @0.1.0 | MIT（`LICENSE.dsh-auto-handoff`） | 交接包与提示词的凭证脱敏（`sk-`/`ghp_`/`AKIA`/JWT/`KEY=value`/查询串）；`REDACTED` 同时作为幂等标记 | 未改动，逐字引用 |
| `graceful-stop.ts.orig` | `qingyou002/dsh-auto-handoff` @0.1.0 | MIT | 软停 latch + `agent/pre-step` 决策 + 双边界等待的**原始参照** | 未改动；`.orig` 后缀表示不参与编译，其适配版在 `src/rotation/latch.ts` |
| `LICENSE.dsh-context-guard` | `@2jumpsina/dsh-context-guard` @0.3.4 | MIT | 占用率策略（迟滞/边沿/冷却/fail-closed）的许可证依据；代码为 TS 移植，见 `src/rotation/policy.ts` | 仅许可证文本 |
| `LICENSE.ds-bot` / `NOTICE.ds-bot` | `Fei2411/DeepSeek-Bot` | Apache-2.0 | 预算线算法与交接段落清单的依据；代码为移植+改写，见 `src/rotation/lines.ts`、`src/rotation/brief.ts` | 仅许可证与 NOTICE 文本 |

`NOTICE.ds-bot` 必须随分发保留（Apache-2.0 §4 要求）。ds-bot 移植处已按要求注明改动。
