# 配置项

全部 29 项，在 DSH 设置的插件页里改（插件 → dsh-long-task-continuity）。

**多数项改完即生效**；下面这几项在装载时取成一次性快照，**需要重新装载插件**才生效：
`outboxDrainMs`、`leaseHeartbeatMs`、`teamBoardMirrorMs`、`leaseExpiryMs`、`hostLockPath`。

| 设置项 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉即不订阅事件、不写存储、不注册工具（已有记录保留） |
| `registerTools` | `false` | 注册 22 个模型可见工具 |
| `missionId` | 空 | 本实例绑定的 Mission；留空表示还没开 |
| `autoRotationEnabled` | `false` | 自动换会话。关闭时只报观察到的轮换线，不动手 |
| `probesAcknowledged` | `false` | 操作者签字：实测项已在本部署逐项核对。没有它，自动轮换与准入守卫无法入场 |
| `rotateRatio` | `0.6` | 轮换线里的占用比例 |
| `handoffMarginTokens` | `8192` | 交接包加首步的余量 |
| `outputReserveTokens` | `0` | 轮换线里的输出预留；`0` 读成"未声明"，停在 observation |
| `compactionHeadroomTokens` | `0` | 轮换线里的压缩余量；`0` = 未声明 |
| `compactionRatio` | `0` | 轮换线里的压缩比；`0` 不等于继承出厂默认 0.8 |
| `acceptMirroredCompactionDefaults` | `false` | 允许未声明的余量与压缩比改用本包抄来的出厂默认（65536 / 0.8）。打开后台账一律标 `mirrored-default`，生效配置仍以宿主原生为准 |
| `warnRatio` | `0.45` | "该收尾了"的占用率 |
| `hardRatio` | `0.6` | "该换会话了"的占用率，须大于 `warnRatio` |
| `cooldownTurns` | `5` | 跨档后的静默轮数 |
| `minTurnsBetweenRotations` | `8` | 同一 Actor 两次轮换之间的最少轮数 |
| `maxRotationPerHour` | `3` | 每 Actor 每小时的轮换保险上限（不是每生命周期） |
| `boundarySlowMs` | `30000` | 静默边界等多久开始报"慢"（不中止） |
| `boundaryDeadlineMs` | `180000` | 等待边界的硬上限，超时即释放闩 |
| `migrateSchedules` | `true` | 提交轮换前把定时任务迁到新会话 |
| `rearmGoal` | `false` | 在新会话重新装载原生 goal。关掉则只靠启动消息接续 |
| `enforceAdmission` | `false` | 注册工具守卫：无有效准入票据的 Actor 不许受管写入 |
| `outboxDrainMs` | `0` | 投递箱消费周期。`0` = 只在 `/continuity drain` 或轮换提交时消费 |
| `leaseHeartbeatMs` | `15000` | 租约续期节拍。`> 0` 才起定时器 |
| `leaseExpiryMs` | `90000` | 租约时长（签发与续期共用） |
| `hostLockPath` | 空 | 单写者锁文件路径。留空 = 不启用。声明后，拿不到锁的宿主整机进入无操作模式 |
| `teamBoardMirror` | `false` | 把台账行投影进宿主的原生任务板（「编队」页因此就是台账）。开关每次现读，关掉不必重启 |
| `teamBoardMirrorMs` | `30000` | 投影节拍。`> 0` 才起定时器 |
| `teamBoardMirrorSession` | 空 | 写任务板时充当 caller 的会话；留空用 Lead Actor 绑定的会话 |
| `replayWindowMs` | `120000` | 超时重放的防护窗口：同内容命令在窗口内落地过就退回"先核对"，不重复写。`0` = 关闭 |
