# 工具与命令

插件有两个面：模型侧的 22 个 `continuity_*` 工具，和人侧的 `/continuity` 命令组。

## 模型侧：22 个工具

| 工具 | 作用 |
| --- | --- |
| `continuity_status` | 只读台账。`aspect` 选面：overview / discipline / obligations / authorization / deliveries / validators / work / records / environment / governance / outcome |
| `continuity_checkpoint` | 提交检查点：当前步骤、已验收进度、进行中、下一步第一动作、关键决策、阻塞、待确认 |
| `continuity_submit` | 提交结果进入验收。租约版本由内核按当前 Attempt 取，不接受自报 |
| `continuity_verify` | 登记验收记录。`unknown` / `error` / `not_run` 不折算成 `pass` |
| `continuity_evidence` | 登记观测证据，来源类别分列（观测 / 转述 / 推断 / 模拟 / 绑定引用） |
| `continuity_claim` | 提出或修订结论（主张命题）。修订产生新版本，撤回要写理由 |
| `continuity_challenge` | 提出质疑，或裁定已有质疑 |
| `continuity_search` | 登记检索回执。覆盖不完整时不得把"没找到"当存在性前提 |
| `continuity_obligation` | 登记承诺，或推进承诺阶段 |
| `continuity_review` | 登记独立审查：自洽性、与历史结果的关系、共享证据与独立性说明 |
| `continuity_validator_qualify` | 登记并判定程序化验证器资格（需要正反样本） |
| `continuity_delivery_confirm` | 确认投递所处阶段与接收方的处理状态 |
| `continuity_propose_complete` | Lead 提议 Mission 收口。只挂提案，不直接置为完成 |
| `continuity_experiment` | 探索与实验写入口：分类工作 / 登记策略 / 预注册 / 记录试验 / 评估路线 / 决策 |
| `continuity_conjecture` | 猜想写入口：登记 / 设框 / 记录探测 / 推进 / 推迟 / 收口 / 假设变更 |
| `continuity_environment` | 环境接续写入口：登记 / 修订 / 开接续 / 推进 / 评估 |
| `continuity_mechanism` | 机制治理写入口：提议 / 修订 / 改分类 / 状态迁移 / 记运行 / 记误报 |
| `continuity_outcome` | 目标效用写入口：登记 / 观测 / 复查 |
| `continuity_integration` | 整合写入口：方案 / 修订 / 回执 |
| `continuity_records` | 记录写入口：覆盖记录 / 依据包 |
| `continuity_claim_task` | 领取任务执行权（开工）。身份取当前会话绑定，不接受自报 `actorId` |
| `continuity_history` | 按需回读归档历史：按 Mission / 对象 / seq 或时间区间取回热与冷事件、闭合记录正文，带游标向更旧翻页。覆盖不足时如实回报缺失范围，不把"读不到"答成"没有历史" |

`continuity_claim` 与 `continuity_claim_task` 是两件事：前者记主张命题，后者开干。

## 人侧：`/continuity` 命令组

| 组 | 动词 |
| --- | --- |
| 台账与诊断 | `status` `timeline` `probe` `board` `drain` `recover` |
| Mission | `open` `revise` `pause` `resume` `cancel` `propose-complete` `complete` |
| 任务与执行权 | `task` `approve` `claim` `checkpoint` `submit` `verify` `retry` `spec` `depend` |
| 身份与团队 | `join` `dormant` `retire` `bind` `team` `message` `ack` |
| 产物与副作用操作 | `artifact` `attach` `operation` `publish` `intent` `receipt` `reconcile` |
| 委托与轮换 | `delegate` `collect` `rotate` `resolve` `resolve-propagation` |
| 证据与纪律 | `evidence` `assert` `assert-retract` `challenge` `adjudicate` `search` `context` `qualify` `review` `incident` |
| 承诺与授权 | `obligate` `settle` `grant` `revoke` |
| 派单与交付 | `dispatch` `deliver` `ack-delivery` |

参数写法：竖线分段、逗号成列、分号分验收项、冒号与等号拼组内字段；`<必填>` 缺失时在入口就回用法，不把空字段丢给内核换一句 `transition rejected`。

**有些动词刻意只在人这一侧**：`approve` / `verify` / `resume` / `grant` / `revoke` 等 12 个没有对应的模型工具。判据是"这一步该由人来决定"，不是"这个命令敏感"。
