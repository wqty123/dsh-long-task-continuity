<p align="center">
  <img src="https://img.shields.io/github/stars/wqty123/dsh-long-task-continuity?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License">
  <img src="https://img.shields.io/badge/DSH-Plugin-47848F?style=flat" alt="DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/version-0.2.3-4493F8?style=flat-square" alt="version 0.2.3">
</p>

<h3 align="center">为 DeepSeek Harness 生态打造的<b>长期任务连续性台账</b></h3>

<h4 align="center">把长期任务的状态从"模型记得"搬到"台账可查"——身份、执行权、证据、复核，每一样都有出处。</h4>

## 这是什么

`dsh-long-task-continuity` 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供长期任务的连续性内核：

- **台账而不是记忆**：Mission / Task / Attempt / Actor 四层结构落到磁盘，任务进度、执行权归属、证据引用都能被外部核对，不依赖模型上下文还在不在；
- **执行权按 Attempt 签发**：租约到期**只触发核对，绝不自动收回或抢占**——过期不等于对方已经停了，这是长期任务最容易出问题的一条；
- **会话轮换与压缩协调**：压力跨档时先做"已写入内容能否回读"的核对，再决定轮换还是压缩；同一 Actor 串行协调，不重复建会话；
- **原生 Agent Team 接入**：任务板只读合并、成员出生即入台账。成员在 `MissionControl.actors` 里没有条目时，一切受管写入都会被 `no-bound-actor` 挡回——这一步是"每个成员遵守同一套纪律"能不能成立的分水岭；
- **纪律在提示词层**：团队纪律写进 `$DSH_HOME/AGENTS.md`，随每个请求注入，不靠谁记得去读某份文档。

一句话：**安装插件 = 长期任务有一本可以被别人翻的账。**

### 它不做的事

- **不替模型判断语义**：一条判据过没过、一个结论该不该信，留给 Lead 与验收证据；内核只认结构条件；
- **不在日常路径上硬拦**：交付与收口面的复核要求只列缺口，不阻断正常干活——纪律不是关卡；
- **不自动替你决定收口**：判据只列"还差什么"，放行与否是人或 Lead 的决定。

## 快速开始

### Web 端（`dsh web`）

```sh
dsh plugin --profile web add dsh-long-task-continuity
```

装完在对话里开账：

```
/continuity open <目标>                          → 建 Mission，并把本会话登记为 lead Actor
/continuity task <标题> | <范围> | <验收1;验收2>  → 任务停在 planned
/continuity approve <taskId>                     → 人放行（模型不能替你做这一步）
/continuity claim <taskId>                       → 领取执行权
/continuity checkpoint <步骤> | <下一步>          → 挂到当前 Attempt 上
/continuity submit <taskId>                      → 结果进验收
```

模型侧另有 22 个 `continuity_*` 工具；`approve` / `verify` / `resume` 只在人这一侧，模型没有对应工具——"人放行"这件事刻意不让模型代做。

### 桌面端

当前版本**只在 web profile 验证过**，未在桌面端装载。

## 文档

| 目标 | 入口 |
| --- | --- |
| 22 个工具、人侧命令组、参数写法 | [工具与命令](docs/tools.md) |
| 29 项配置的含义、默认值与生效时机 | [配置项](docs/configuration.md) |
| 每一版的改动与原因 | [CHANGELOG.md](CHANGELOG.md) |
| 第三方归属与许可 | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

> README 只做入口，细节在下面这几篇里，不在这里重复。

## 工具名空间

本插件占用全局 **`continuity_*`** 名空间（22 个工具，全部以插件名开头）。DSH 的工具注册是全局且不允许重名的，加前缀让一次撞名只影响一个名字。

## 更新记录

见 [CHANGELOG.md](CHANGELOG.md)。

## 特别感谢

特别感谢 [DeepSeek Harness 原始仓库](https://github.com/deepseek-ai/deepseek-harness) 与 DeepSeek AI 团队：本插件的插件体系、工具运行时与宿主接口都建立在这个项目之上。

`vendor/` 下保留了少量授权代码与许可原件，归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可

MIT，见 [package.json](package.json) 的 `license` 字段。
