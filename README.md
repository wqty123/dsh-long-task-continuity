<p align="center">
  <img src="https://img.shields.io/github/stars/wqty123/dsh-long-task-continuity?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License">
  <img src="https://img.shields.io/badge/DSH-Plugin-47848F?style=flat" alt="DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/version-0.2.3-4493F8?style=flat-square" alt="version 0.2.3">
</p>

<h3 align="center">DeepSeek Harness 的<b>长期任务连续性台账</b></h3>

<h4 align="center">Mission / Task / Attempt / Actor 四层结构落盘；执行权按 Attempt 签发；会话轮换与压缩在核对后执行。</h4>

## 功能

- **台账落盘**：任务进度、执行权归属、证据引用写入 `storages/continuity/`，可由外部核对，不依赖会话上下文存续。
- **执行权按 Attempt 签发**：租约到期只触发核对，不自动收回或抢占。
- **会话轮换与压缩协调**：压力跨档时先核对已写入内容能否回读，再决定轮换或压缩；同一 Actor 串行协调。
- **原生 Agent Team 接入**：任务板只读合并；成员在 `team/member` 事件出现时自动登记为 Actor，此后其受管写入按身份校验。
- **纪律经提示词层送达**：团队纪律写入 `$DSH_HOME/AGENTS.md`，随每个请求注入。

## 快速开始

### Web 端（`dsh web`）

```sh
dsh plugin --profile web add dsh-long-task-continuity
```

开账顺序：

```
/continuity open <目标>                          → 建 Mission，并把本会话登记为 lead Actor
/continuity task <标题> | <范围> | <验收1;验收2>  → 任务停在 planned
/continuity approve <taskId>                     → 任务进 ready
/continuity claim <taskId>                       → 领取执行权
/continuity checkpoint <步骤> | <下一步>          → 挂到当前 Attempt 上
/continuity submit <taskId>                      → 结果进验收
```

模型侧有 22 个 `continuity_*` 工具。`approve` / `verify` / `resume` 等 12 个动词只在命令面提供。

### 桌面端

当前版本只在 web profile 验证。

## 文档

| 目标 | 入口 |
| --- | --- |
| 22 个工具、命令组、参数写法 | [工具与命令](docs/tools.md) |
| 29 项配置的含义、默认值与生效时机 | [配置项](docs/configuration.md) |
| 每一版的改动与原因 | [CHANGELOG.md](CHANGELOG.md) |
| 第三方归属与许可 | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

## 工具名空间

本插件占用全局 `continuity_*` 名空间（22 个工具）。DSH 的工具注册为全局唯一，工具名以插件前缀开头。

## 更新记录

见 [CHANGELOG.md](CHANGELOG.md)。

## 特别感谢

[DeepSeek Harness 原始仓库](https://github.com/deepseek-ai/deepseek-harness) 提供了本插件所依赖的插件体系、工具运行时与宿主接口。

`vendor/` 内第三方代码的归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可

MIT，见 [package.json](package.json) 的 `license` 字段。
