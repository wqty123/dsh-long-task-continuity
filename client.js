/*
 * dsh-long-task-continuity — browser half.
 *
 * Hand-written lazy-CJS bundle (same shape as the installed dsh-purge client):
 * no bundler, only the platform seed words `react` and
 * `@deepseek-ai/dsh-client-ui-primitives`. Every visual is DSH-native: colors
 * and radii come from `--dsw-alias-*` / `--dsw-radius-*` tokens, controls come
 * from ui-primitives, and the surfaces are the stock keyed slots
 * (`tool.call.toolview` by wire tool name, `plugins.bundle.config` by bundle
 * package name, `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title`
 * under the tab type's own id — registered through the public two-stage
 * `sidebarRightTabs` path, the same one ui-sidebar-documentpreview uses). No
 * second visual system is introduced.
 */
window.__ModuleLoader__.load({ id: "dsh-long-task-continuity", factory: (require) => {

	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

	const react = require("react");
	const h = react.createElement;
	const { useCallback, useEffect, useMemo, useState } = react;
	const {
		DisclosureRow, TextShimmer, MarkdownText, SettingsForm, SettingsValueField,
		SettingsFormModel, settingsNumberField, settingsTextField, Switch,
		IconGoalOutlineRegular, IconChecklistOutlineRegular, IconClockOutlineRegular,
		IconRefreshOutlineRegular, IconDatabaseOutlineRegular, IconUsersOutlineRegular,
		IconSearchOutlineRegular, IconWarningTriangleOutlineRegular,
		IconInspectOutlineRegular, IconCheckCircleOutlineRegular,
	} = require("@deepseek-ai/dsh-client-ui-primitives");

	const PKG = "dsh-long-task-continuity";
	const NS = "continuity";
	const name = PKG;
	const inject = ["slots", "locale"];

	/* ---------------------------------------------------------------- copy -- */

	const zh = {
		"row.preparing": "准备写入连续性台账",
		"row.running": "正在写入连续性台账",
		"row.failed": "连续性台账写入失败",
		"row.stopped": "连续性台账写入已中止",
		"row.input": "调用参数",
		"row.output": "台账输出",
		"row.inspect": "查看",
		"tool.status": "任务状态",
		"tool.checkpoint": "检查点",
		"tool.submit": "提交结果",
		"tool.verify": "核验",
		"tool.evidence": "证据",
		"tool.claim": "主张",
		"tool.claim_task": "领取执行权",
		"tool.challenge": "提出质疑",
		"tool.search": "检索台账",
		"tool.obligation": "义务",
		"tool.review": "复核",
		"tool.validator_qualify": "校验方资格",
		"tool.delivery_confirm": "交付确认",
		"tool.propose_complete": "完成提案",
		"tool.experiment": "实验",
		"tool.conjecture": "猜想",
		"tool.environment": "环境",
		"tool.mechanism": "机制",
		"tool.outcome": "结果",
		"tool.integration": "集成",
		"tool.records": "台账记录",
		"group.mission": "任务控制",
		"group.proof": "证据与核验",
		"group.exploration": "探索分层",
		"group.environment": "环境与集成",
		"config.summary": "长期任务连续性：任务状态、执行权、检查点、交接与恢复。",
		"config.copy": "复制",
		"config.copied": "已复制",
		"config.codeBlock": "代码",
		"config.wrap": "自动换行",
		"config.unwrap": "保留列宽",
		"config.footnotes": "脚注",
		"config.save": "保存",
		"config.saving": "正在保存",
		"config.saveFailed": "保存未生效",
		"config.unavailable": "该命名空间当前未对本客户端提供服务。",
		"config.readOnly": "文档为只读，暂时无法保存。",
		"config.overridden": "已覆盖",
		"config.reset": "恢复继承",
		"config.invalid": "该值不符合此字段的取值要求。",
		"config.section.switch": "开关与门禁",
		"config.section.rotation": "轮换阈值",
		"config.section.boundary": "交接与边界",
		"config.section.lease": "执行权租约",
		"config.section.lock": "单写者锁",
		"config.section.replay": "重放防护",
		"config.field.enabled": "总开关",
		"config.field.enabledHint": "关闭时插件不注册工具、不接管命令，也不检测轮换。",
		"config.field.missionId": "当前任务标识",
		"config.field.missionIdHint": "留空表示由 /continuity open 建立；填写后本会话直接接管该任务。",
		"config.field.autoRotationEnabled": "允许自动轮换",
		"config.field.autoRotationEnabledHint": "仍须显式声明 R/H/r 且已签署探针确认才会真正触发。",
		"config.field.probesAcknowledged": "人工签署探针确认",
		"config.field.probesAcknowledgedHint": "轮换预算的签字位；未签署时自动侧保持观察。",
		"config.field.enforceAdmission": "强制开工准入",
		"config.field.enforceAdmissionHint": "开启后未通过的开工请求会被拦下。改动需重新装载插件才生效。",
		"config.field.registerTools": "注册模型侧工具",
		"config.field.registerToolsHint": "关闭后只用 /continuity 命令面，不给模型加工具。改动需重新装载插件才生效。",
		"config.field.rotateRatio": "轮换触发比例",
		"config.field.rotateRatioHint": "上下文占用达到窗口比例后进入轮换评估。",
		"config.field.handoffMarginTokens": "交接余量 token",
		"config.field.handoffMarginTokensHint": "交接包之外预留的余量。",
		"config.field.warnRatio": "预警比例",
		"config.field.warnRatioHint": "达到该比例时在台账里留下预警。",
		"config.field.hardRatio": "硬阈值比例",
		"config.field.hardRatioHint": "超过该比例视为必须换会话。",
		"config.field.cooldownTurns": "轮换冷却回合",
		"config.field.cooldownTurnsHint": "轮换后至少间隔多少回合才允许下一次。",
		"config.field.minTurnsBetweenRotations": "两次轮换最少回合",
		"config.field.minTurnsBetweenRotationsHint": "回合数下限守卫。",
		"config.field.maxRotationPerHour": "每小时最多轮换",
		"config.field.maxRotationPerHourHint": "频率上限守卫。",
		"config.field.outputReserveTokens": "输出预留 token",
		"config.field.outputReserveTokensHint": "0 表示未声明：改用会话读数（requestHeader.config.maxTokens / contextTimeline.maxOutputTokens）。两处都读不到时轮换线停在 observation，不会退回任何默认值。",
		"config.field.compactionHeadroomTokens": "压缩余量 token",
		"config.field.compactionHeadroomTokensHint": "0 表示未声明；只有打开「接受镜像压缩默认值」才会用镜像值，否则该项按未声明处理。",
		"config.field.compactionRatio": "压缩比例",
		"config.field.compactionRatioHint": "0 表示未声明；口径同上。",
		"config.field.acceptMirroredCompactionDefaults": "接受镜像压缩默认值",
		"config.field.acceptMirroredCompactionDefaultsHint": "H/r 自己读不到时，是否改用镜像值（H=65536、r=0.8，照抄 compaction-basic 出厂默认）参与轮换线计算。不勾选则按未声明处理，轮换线停在 observation，自动侧不换会话。",
		"config.field.boundarySlowMs": "边界慢阈值毫秒",
		"config.field.boundarySlowMsHint": "超过该耗时记为慢边界。",
		"config.field.boundaryDeadlineMs": "边界截止毫秒",
		"config.field.boundaryDeadlineMsHint": "超过该耗时判定边界超时。",
		"config.field.migrateSchedules": "迁移定时任务",
		"config.field.migrateSchedulesHint": "轮换时把定时挂到新会话。",
		"config.field.rearmGoal": "重新武装目标",
		"config.field.rearmGoalHint": "轮换后是否重新声明原生目标。",
		"config.field.outboxDrainMs": "外发箱排空毫秒",
		"config.field.outboxDrainMsHint": "0 表示不启动定时排空：外发条目只会积着，要手工执行 /continuity drain 才消费；>0 才按该节拍起定时器。改动需重新装载插件才生效。",
		"config.field.leaseHeartbeatMs": "执行权心跳毫秒",
		"config.field.leaseHeartbeatMsHint": "持有者续租节拍；0 表示不起续租定时器。改动需重新装载插件才生效。",
		"config.field.leaseExpiryMs": "执行权过期毫秒",
		"config.field.leaseExpiryMsHint": "超过该时间未续租即视为失效，签发与续租共用这一个值。",
		"config.field.hostLockPath": "锁文件路径",
		"config.field.hostLockPathHint": "留空=不启用。声明后，拿不到锁的宿主进入无操作模式，绝不与另一个进程并行写同一份存储域。改动需重新装载插件才生效。",
		"config.field.replayWindowMs": "疑似重放窗口毫秒",
		"config.field.replayWindowMsHint": "同内容写命令在窗口内已落地过，就退回「先核对」而不是再写一次。Code-Mode 的程序不会被自动回放，但截止时间含子调用与审批等待，命令可能已落地而程序只收到超时；默认 120000 对齐 run_code 默认截止时间，调高 ptc-runtime maxTimeoutMs 时一起调宽。0 表示关闭。",
		"wb.tab.title": "任务面板",
		"wb.tab.description": "只读工作台：任务、执行权、告警与未观测面",
		"wb.loading": "正在读取工作台投影",
		"wb.empty": "本机还没有控制记录；用 /continuity open 建立任务后这里才有投影",
		"wb.failed": "读取失败",
		"wb.refresh": "刷新",
		"wb.unknown": "未知",
		"wb.none": "该筛选下没有任务",
		"wb.objective": "目标",
		"wb.nextStep": "下一步",
		"wb.waitingReason": "等待原因",
		"wb.admissionClosed": "入场已关闭",
		"wb.generatedAt": "生成于",
		"wb.revision": "版本",
		"wb.jump": "在会话面打开",
		"wb.filter.attention": "待处理",
		"wb.filter.all": "全部",
		"wb.filter.active": "进行中",
		"wb.filter.review": "待验收",
		"wb.filter.blocked": "阻塞",
		"wb.filter.completed": "完成",
		"wb.filter.failed": "失败",
		"wb.filter.cancelled": "取消",
		"wb.filter.needsReview": "待复核",
		"wb.group.alerts": "告警",
		"wb.group.leases": "执行权",
		"wb.group.tasks": "任务",
		"wb.group.actors": "工作者",
		"wb.group.sessions": "会话接续",
		"wb.group.coverage": "观测面",
		"wb.group.discipline": "纪律（当前生效）",
		"wb.group.injection": "注入确认",
		"disc.source": "来源",
		"disc.sha": "指纹",
		"disc.bytes": "字节",
		"disc.modified": "修改于",
		"disc.missing": "读不到 $DSH_HOME/AGENTS.md：面板如实报缺失，不回落成内置文案",
		"disc.evidence": "证据",
		"disc.measured": "实测",
		"disc.inferred": "同路径未单独实测",
		"disc.edit": "编辑",
		"disc.save": "保存",
		"disc.saving": "写入中",
		"disc.cancel": "取消",
		"disc.editHint": "写回 $DSH_HOME/AGENTS.md（落盘前自动备份）。新会话生效；当前会话沿用已加载的那一版。",
		"wb.group.context": "上下文读数",
		"ctx.unavailable": "没有会话定位",
		"ctx.ratio": "占用",
		"ctx.projected": "投影",
		"ctx.window": "窗口",
		"ctx.verdict.compact": "该压缩",
		"ctx.verdict.rotate": "该在会话内另开一个会话",
		"ctx.verdict.hold": "都不动",
		"ctx.gate": "卡住自动侧",
		"ctx.gate.none": "无（判决已算出）",
		"ctx.line": "轮换线",
		"wb.count.taskTotal": "任务",
		"wb.count.completedNow": "完成",
		"wb.count.blocked": "阻塞",
		"wb.count.needsReview": "待复核",
		"wb.count.submitted": "待验收",
		"wb.count.running": "运行中",
		"wb.count.failed": "失败",
		"wb.count.cancelled": "取消",
		"wb.count.actorTotal": "工作者",
		"wb.count.sessionTotal": "会话",
		"wb.owner": "执行者",
		"wb.unassigned": "未领取",
		"wb.attempts": "尝试",
		"wb.priority": "优先级",
		"wb.dependsOn": "依赖",
		"wb.unmet": "未满足依赖",
		"wb.blockedReason": "阻塞原因",
		"wb.criteria": "判据",
		"wb.criteriaCheck": "互斥检查",
		"wb.revisions": "版本号",
		"wb.resources": "资源",
		"wb.updatedAt": "更新于",
		"wb.lease.remaining": "剩余",
		"wb.lease.expired": "已过期",
		"wb.lease.heartbeat": "心跳于",
		"wb.lease.ticket": "准入票",
		"wb.available": "可派",
		"wb.dormant": "休眠",
		"wb.retired": "已退役",
		"wb.waitingFor": "等待",
		"wb.liveAttempts": "在跑",
		"wb.session.continuationOf": "续接",
		"wb.coverage.included": "已包含",
		"wb.coverage.unavailable": "未观测面",
		"wb.group.native": "原生任务板",
		"wb.nativeSession": "定位会话",
		"wb.nativeNoSession": "未定位会话",
		"wb.nativeRead": "已读到",
		"wb.nativeUnavailable": "未读到",
		"wb.nativeRows": "原生行",
		"wb.nativeLinked": "已链接任务",
		"wb.nativeRisks": "依赖风险",
		"wb.nativeUnlinked": "未链接的原生行",
		"wb.execution": "执行",
		"wb.acceptance": "验收",
		"wb.gateNote": "关卡备注",
		"wb.nativeTask": "原生任务",
		"wb.nativeStatus": "原生状态",
		"wb.nativeAssignee": "原生负责人",
		"wb.nativeRevision": "原生版本",
		"wb.nativeReady": "可领取",
		"wb.nativeBlockedBy": "原生依赖",
		"wb.nativeNone": "无",
		"wb.yes": "是",
		"wb.no": "否",
	};

	const en = {
		"row.preparing": "Preparing to write the continuity ledger",
		"row.running": "Writing the continuity ledger",
		"row.failed": "Continuity ledger write failed",
		"row.stopped": "Continuity ledger write stopped",
		"row.input": "Call arguments",
		"row.output": "Ledger output",
		"row.inspect": "Inspect",
		"tool.status": "Mission status",
		"tool.checkpoint": "Checkpoint",
		"tool.submit": "Submit result",
		"tool.verify": "Verify",
		"tool.evidence": "Evidence",
		"tool.claim": "Claim (proposition)",
		"tool.claim_task": "Claim execution right",
		"tool.challenge": "Raise challenge",
		"tool.search": "Search ledger",
		"tool.obligation": "Obligation",
		"tool.review": "Review",
		"tool.validator_qualify": "Validator qualification",
		"tool.delivery_confirm": "Delivery confirmation",
		"tool.propose_complete": "Completion proposal",
		"tool.experiment": "Experiment",
		"tool.conjecture": "Conjecture",
		"tool.environment": "Environment",
		"tool.mechanism": "Mechanism",
		"tool.outcome": "Outcome",
		"tool.integration": "Integration",
		"tool.records": "Ledger records",
		"group.mission": "Mission control",
		"group.proof": "Proof and verification",
		"group.exploration": "Exploration tiers",
		"group.environment": "Environment and integration",
		"config.summary": "Long-task continuity: mission state, execution rights, checkpoints, handoff and recovery.",
		"config.copy": "Copy",
		"config.copied": "Copied",
		"config.codeBlock": "code",
		"config.wrap": "Wrap",
		"config.unwrap": "Preserve columns",
		"config.footnotes": "Footnotes",
		"config.save": "Save",
		"config.saving": "Saving",
		"config.saveFailed": "The Host did not accept the save.",
		"config.unavailable": "This namespace is not served to the current client.",
		"config.readOnly": "The document is read-only; saving is unavailable.",
		"config.overridden": "overridden",
		"config.reset": "Reset",
		"config.invalid": "This value is not accepted by the field.",
		"config.section.switch": "Switches and gates",
		"config.section.rotation": "Rotation thresholds",
		"config.section.boundary": "Handoff and boundaries",
		"config.section.lease": "Execution leases",
		"config.section.lock": "Single-writer lock",
		"config.section.replay": "Replay guard",
		"config.field.enabled": "Master switch",
		"config.field.enabledHint": "When off the plugin registers no tools, claims no command, and detects no rotation.",
		"config.field.missionId": "Mission id",
		"config.field.missionIdHint": "Empty means `/continuity open` creates one; set it to adopt this mission in the session.",
		"config.field.autoRotationEnabled": "Allow automatic rotation",
		"config.field.autoRotationEnabledHint": "Still requires declared R/H/r plus the signed probe acknowledgement.",
		"config.field.probesAcknowledged": "Human probe acknowledgement",
		"config.field.probesAcknowledgedHint": "Signature slot for the rotation budget; unsigned keeps the automatic side observing.",
		"config.field.enforceAdmission": "Enforce admission",
		"config.field.enforceAdmissionHint": "Blocks work requests that have not passed admission.",
		"config.field.registerTools": "Register model-facing tools",
		"config.field.registerToolsHint": "Off keeps only the `/continuity` command surface.",
		"config.field.rotateRatio": "Rotation ratio",
		"config.field.rotateRatioHint": "Context occupancy that starts rotation evaluation.",
		"config.field.handoffMarginTokens": "Handoff margin tokens",
		"config.field.handoffMarginTokensHint": "Reserve kept outside the handoff bundle.",
		"config.field.warnRatio": "Warning ratio",
		"config.field.warnRatioHint": "Occupancy that records a warning in the ledger.",
		"config.field.hardRatio": "Hard ratio",
		"config.field.hardRatioHint": "Occupancy that requires a new session.",
		"config.field.cooldownTurns": "Rotation cooldown turns",
		"config.field.cooldownTurnsHint": "Turns to wait before the next rotation.",
		"config.field.minTurnsBetweenRotations": "Minimum turns between rotations",
		"config.field.minTurnsBetweenRotationsHint": "Turn-count guard.",
		"config.field.maxRotationPerHour": "Maximum rotations per hour",
		"config.field.maxRotationPerHourHint": "Rate guard.",
		"config.field.outputReserveTokens": "Output reserve tokens",
		"config.field.outputReserveTokensHint": "0 means undeclared: read from the session instead (requestHeader.config.maxTokens / contextTimeline.maxOutputTokens). If neither is readable the rotation line stays in observation — no default is assumed.",
		"config.field.compactionHeadroomTokens": "Compaction headroom tokens",
		"config.field.compactionHeadroomTokensHint": "0 means undeclared; the mirrored default applies only when \"Accept mirrored compaction defaults\" is on.",
		"config.field.compactionRatio": "Compaction ratio",
		"config.field.compactionRatioHint": "0 means undeclared; same rule as headroom.",
		"config.field.acceptMirroredCompactionDefaults": "Accept mirrored compaction defaults",
		"config.field.acceptMirroredCompactionDefaultsHint": "When H/r cannot be read from the session, whether to fall back to the mirrored values (H=65536, r=0.8, copied from compaction-basic's factory defaults) for the rotation line. Left off, they stay undeclared, the line stops in observation and the automatic side never rotates.",
		"config.field.boundarySlowMs": "Boundary slow ms",
		"config.field.boundarySlowMsHint": "Above this the boundary is recorded as slow.",
		"config.field.boundaryDeadlineMs": "Boundary deadline ms",
		"config.field.boundaryDeadlineMsHint": "Above this the boundary times out.",
		"config.field.migrateSchedules": "Migrate schedules",
		"config.field.migrateSchedulesHint": "Moves timers onto the new session at rotation.",
		"config.field.rearmGoal": "Rearm goal",
		"config.field.rearmGoalHint": "Re-declares the native goal after a rotation.",
		"config.field.outboxDrainMs": "Outbox drain ms",
		"config.field.outboxDrainMsHint": "0 starts no drain timer: entries pile up until /continuity drain runs by hand. Anything above 0 arms a timer at that cadence. Changing it needs the plugin to be re-mounted.",
		"config.field.leaseHeartbeatMs": "Lease heartbeat ms",
		"config.field.leaseHeartbeatMsHint": "Renewal cadence for the holder; 0 starts no renewal timer. Needs a re-mount to take effect.",
		"config.field.leaseExpiryMs": "Lease expiry ms",
		"config.field.leaseExpiryMsHint": "A lease unrenewed past this is dead; issuance and renewal share this single value.",
		"config.field.hostLockPath": "Lock file path",
		"config.field.hostLockPathHint": "Empty = disabled. When set, a host that cannot take the lock mounts in no-op mode instead of writing the same storageDomain alongside another process. Needs a re-mount to take effect.",
		"config.field.replayWindowMs": "Suspected-replay window ms",
		"config.field.replayWindowMsHint": "A write command whose content already landed inside this window is held for reconciliation instead of applied again. A run_code program is never replayed automatically, yet its deadline covers nested calls and approval waits — so the command can land while the program only sees a timeout. Default 120000 matches the run_code default deadline; widen it together with ptc-runtime maxTimeoutMs. 0 disables.",
		"wb.tab.title": "Task panel",
		"wb.tab.description": "Read-only workbench: tasks, leases, alerts and unobserved faces",
		"wb.loading": "Reading the workbench projection",
		"wb.empty": "No control record on this host yet; /continuity open creates one",
		"wb.failed": "Read failed",
		"wb.refresh": "Refresh",
		"wb.unknown": "unknown",
		"wb.none": "No task matches this filter",
		"wb.objective": "Objective",
		"wb.nextStep": "Next step",
		"wb.waitingReason": "Waiting for",
		"wb.admissionClosed": "Admission closed",
		"wb.generatedAt": "generated at",
		"wb.revision": "rev",
		"wb.jump": "Open in the conversation surface",
		"wb.filter.attention": "Attention",
		"wb.filter.all": "All",
		"wb.filter.active": "Active",
		"wb.filter.review": "To review",
		"wb.filter.blocked": "Blocked",
		"wb.filter.completed": "Completed",
		"wb.filter.failed": "Failed",
		"wb.filter.cancelled": "Cancelled",
		"wb.filter.needsReview": "Re-check",
		"wb.group.alerts": "Alerts",
		"wb.group.leases": "Execution leases",
		"wb.group.tasks": "Tasks",
		"wb.group.actors": "Actors",
		"wb.group.sessions": "Session continuity",
		"wb.group.coverage": "Observation faces",
		"wb.group.discipline": "Discipline (in force)",
		"wb.group.injection": "Injection check",
		"disc.source": "Source",
		"disc.sha": "SHA-256",
		"disc.bytes": "bytes",
		"disc.modified": "modified",
		"disc.missing": "Cannot read $DSH_HOME/AGENTS.md: the panel reports the gap instead of falling back to built-in copy",
		"disc.evidence": "Evidence",
		"disc.measured": "measured",
		"disc.inferred": "same path, not separately measured",
		"disc.edit": "Edit",
		"disc.save": "Save",
		"disc.saving": "Saving",
		"disc.cancel": "Cancel",
		"disc.editHint": "Writes back to $DSH_HOME/AGENTS.md (backed up first). New sessions pick it up; the current session keeps the baseline it already loaded.",
		"wb.group.context": "Context readings",
		"ctx.unavailable": "No session anchor",
		"ctx.ratio": "Usage",
		"ctx.projected": "projected",
		"ctx.window": "window",
		"ctx.verdict.compact": "should compact",
		"ctx.verdict.rotate": "should rotate into a new session",
		"ctx.verdict.hold": "hold",
		"ctx.gate": "auto side held by",
		"ctx.gate.none": "none (verdict computed)",
		"ctx.line": "rotation line",
		"wb.count.taskTotal": "tasks",
		"wb.count.completedNow": "done",
		"wb.count.blocked": "blocked",
		"wb.count.needsReview": "re-check",
		"wb.count.submitted": "to review",
		"wb.count.running": "running",
		"wb.count.failed": "failed",
		"wb.count.cancelled": "cancelled",
		"wb.count.actorTotal": "actors",
		"wb.count.sessionTotal": "sessions",
		"wb.owner": "Owner",
		"wb.unassigned": "unclaimed",
		"wb.attempts": "Attempts",
		"wb.priority": "Priority",
		"wb.dependsOn": "Depends on",
		"wb.unmet": "Unmet dependencies",
		"wb.blockedReason": "Blocked reason",
		"wb.criteria": "Criteria",
		"wb.criteriaCheck": "Mutual-exclusion check",
		"wb.revisions": "Revisions",
		"wb.resources": "Resources",
		"wb.updatedAt": "Updated at",
		"wb.lease.remaining": "left",
		"wb.lease.expired": "expired",
		"wb.lease.heartbeat": "heartbeat at",
		"wb.lease.ticket": "admission ticket",
		"wb.available": "available",
		"wb.dormant": "dormant",
		"wb.retired": "retired",
		"wb.waitingFor": "waiting for",
		"wb.liveAttempts": "live",
		"wb.session.continuationOf": "continues",
		"wb.coverage.included": "Included",
		"wb.coverage.unavailable": "Unobserved faces",
		"wb.group.native": "Native task board",
		"wb.nativeSession": "session",
		"wb.nativeNoSession": "no session",
		"wb.nativeRead": "read",
		"wb.nativeUnavailable": "not read",
		"wb.nativeRows": "native rows",
		"wb.nativeLinked": "linked tasks",
		"wb.nativeRisks": "dependency risks",
		"wb.nativeUnlinked": "unlinked native rows",
		"wb.execution": "execution",
		"wb.acceptance": "acceptance",
		"wb.gateNote": "gate note",
		"wb.nativeTask": "Native task",
		"wb.nativeStatus": "native status",
		"wb.nativeAssignee": "native assignee",
		"wb.nativeRevision": "native revision",
		"wb.nativeReady": "claimable",
		"wb.nativeBlockedBy": "native deps",
		"wb.nativeNone": "none",
		"wb.yes": "yes",
		"wb.no": "no",
	};

	/* --------------------------------------------------------------- styles -- */

	// Appended synchronously: the module system claims styles created while the
	// factory runs and drops them on reload. Colors and radii are token-only.
	const CSS = [
		".ltc-card{display:flex;flex-direction:column;}",
		".ltc-root{display:flex;flex-direction:column;}",
		".ltc-visuallyHidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}",
		".ltc-lead{position:relative;flex:none;width:calc(16px + var(--dsh-content-font-delta, 0px));height:calc(16px + var(--dsh-content-font-delta, 0px));display:inline-flex;align-items:center;justify-content:center;margin-right:6px;color:inherit;}",
		".ltc-lead svg{width:calc(14px + var(--dsh-content-font-delta, 0px));height:calc(14px + var(--dsh-content-font-delta, 0px));}",
		".ltc-sep{flex:none;width:2px;height:2px;border-radius:1px;margin:0 8px;background:var(--dsw-alias-label-caption);}",
		".ltc-summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary, 13px);line-height:calc(24px + var(--dsh-content-font-delta, 0px));}",
		".ltc-summary[data-tone=error]{color:var(--dsw-alias-state-error-primary);}",
		".ltc-summary[data-tone=stopped]{color:var(--dsw-alias-state-warn-label);}",
		".ltc-body{display:flex;flex-direction:column;}",
		".ltc-ioCard{display:flex;flex-direction:column;max-height:320px;margin:4px 0 4px 4px;overflow:auto;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);}",
		".ltc-ioLabel{flex:none;padding:8px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-markdown-code-block-banner);font-size:11px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-caption);text-transform:uppercase;letter-spacing:0.04em;}",
		".ltc-ioBody{min-height:0;padding:10px 12px 12px;overflow:auto;}",
		".ltc-inspect{display:inline-flex;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer;opacity:0;transition:opacity 100ms ease;}",
		".ltc-root:hover .ltc-inspect,.ltc-inspect:focus-visible{opacity:1;}",
		".ltc-preparing{display:flex;align-items:center;height:calc(24px + var(--dsh-content-font-delta, 0px));color:var(--dsw-alias-label-tertiary);}",
		".ltc-groupTitle{margin:16px 0 6px;font-size:var(--dsw-font-sm-13, 13px);font-weight:500;color:var(--dsw-alias-label-secondary);}",
		".ltc-groupTitle:first-child{margin-top:0;}",
		".ltc-switchRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;}",
		".ltc-switchText{display:flex;flex-direction:column;min-width:0;}",
		".ltc-switchLabel{font-size:var(--dsw-font-sm-13, 13px);color:var(--dsw-alias-label-primary);}",
		".ltc-switchHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}",
		".ltc-wbRoot{display:flex;flex-direction:column;gap:10px;height:100%;box-sizing:border-box;padding:10px 12px 16px;overflow:auto;}",
		".ltc-wbHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}",
		".ltc-wbMission{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsw-font-sm-13, 13px);font-weight:500;color:var(--dsw-alias-label-primary);}",
		".ltc-wbSpacer{flex:1 1 auto;}",
		".ltc-wbChip{display:inline-flex;flex:none;align-items:center;gap:4px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-base);font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);}",
		".ltc-wbChip[data-tone=warn]{color:var(--dsw-alias-state-warn-label);}",
		".ltc-wbChip[data-tone=error]{color:var(--dsw-alias-state-error-primary);}",
		".ltc-wbChip[data-tone=muted]{color:var(--dsw-alias-label-tertiary);}",
		".ltc-wbCounts{display:flex;flex-wrap:wrap;gap:6px;}",
		".ltc-wbList{display:flex;flex-direction:column;gap:4px;min-width:0;}",
		".ltc-wbRow{display:flex;flex-direction:column;gap:4px;min-width:0;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);}",
		".ltc-wbRowHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;}",
		".ltc-wbTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsw-font-sm-13, 13px);color:var(--dsw-alias-label-primary);}",
		".ltc-wbMuted{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-word;}",
		".ltc-wbText{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;}",
		".ltc-wbLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);}",
		".ltc-wbKV{display:grid;grid-template-columns:max-content minmax(0, 1fr);gap:2px 10px;margin:0;font-size:12px;line-height:18px;}",
		".ltc-wbKV dt{color:var(--dsw-alias-label-tertiary);}",
		".ltc-wbKV dd{margin:0;min-width:0;color:var(--dsw-alias-label-secondary);word-break:break-word;}",
		".ltc-wbAlert{display:flex;flex-direction:column;gap:2px;min-width:0;padding:6px 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);}",
		".ltc-wbAlertText{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word;}",
		".ltc-wbCriteria{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;}",
		".ltc-wbCriterion{display:flex;align-items:flex-start;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}",
		".ltc-wbCriterionText{min-width:0;flex:1 1 auto;word-break:break-word;}",
		".ltc-wbNote{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}",
		".ltc-wbNote[data-tone=error]{color:var(--dsw-alias-state-error-primary);}",
		".ltc-wbBody{display:flex;flex-direction:column;gap:4px;min-width:0;}",
		".ltc-wbFilters{display:flex;flex-wrap:wrap;gap:4px;}",
		".ltc-wbFilter{padding:0 8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;corner-shape:round;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;cursor:pointer;}",
		".ltc-wbFilter:hover{color:var(--dsw-alias-label-primary);}",
		".ltc-wbFilter[data-active=true]{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-markdown-code-block-banner);color:var(--dsw-alias-label-primary);}",
		".ltc-wbRefresh{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer;}",
		".ltc-wbRefresh:hover{color:var(--dsw-alias-label-primary);}",
		".ltc-wbJump{display:inline-flex;align-self:flex-start;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;cursor:pointer;}",
		".ltc-wbJump:hover{color:var(--dsw-alias-label-primary);}",
		"@media (prefers-reduced-motion: reduce){.ltc-card *{transition:none !important;}}",
	].join("\n");

	function installStyles() {
		if (typeof document === "undefined") return;
		if (document.querySelector('style[data-plugin-css="dsh-long-task-continuity/client"]')) return;
		const tag = document.createElement("style");
		tag.setAttribute("data-plugin-css", "dsh-long-task-continuity/client");
		tag.textContent = CSS;
		document.head.appendChild(tag);
	}
	installStyles();

	/* ------------------------------------------------------------ tool rows -- */

	/** Wire tool name -> { group, icon } for the keyed toolview rows. */
	const TOOL_META = {
		continuity_status: { group: "mission", icon: IconGoalOutlineRegular },
		continuity_checkpoint: { group: "mission", icon: IconChecklistOutlineRegular },
		continuity_submit: { group: "mission", icon: IconRefreshOutlineRegular },
		continuity_claim: { group: "mission", icon: IconUsersOutlineRegular },
		continuity_obligation: { group: "mission", icon: IconClockOutlineRegular },
		continuity_propose_complete: { group: "mission", icon: IconCheckCircleOutlineRegular },
		continuity_verify: { group: "proof", icon: IconCheckCircleOutlineRegular },
		continuity_evidence: { group: "proof", icon: IconDatabaseOutlineRegular },
		continuity_challenge: { group: "proof", icon: IconWarningTriangleOutlineRegular },
		continuity_review: { group: "proof", icon: IconInspectOutlineRegular },
		continuity_validator_qualify: { group: "proof", icon: IconUsersOutlineRegular },
		continuity_delivery_confirm: { group: "proof", icon: IconCheckCircleOutlineRegular },
		continuity_search: { group: "proof", icon: IconSearchOutlineRegular },
		continuity_records: { group: "proof", icon: IconDatabaseOutlineRegular },
		continuity_experiment: { group: "exploration", icon: IconRefreshOutlineRegular },
		continuity_conjecture: { group: "exploration", icon: IconGoalOutlineRegular },
		continuity_outcome: { group: "exploration", icon: IconChecklistOutlineRegular },
		continuity_environment: { group: "environment", icon: IconDatabaseOutlineRegular },
		continuity_mechanism: { group: "environment", icon: IconRefreshOutlineRegular },
		continuity_integration: { group: "environment", icon: IconCheckCircleOutlineRegular },
		continuity_claim_task: { group: "mission", icon: IconRefreshOutlineRegular },
		// 追加在末尾：声明列表的前缀缓存纪律同样适用于这里的渲染顺序（复审 N4 的 continuity_history）。
		continuity_history: { group: "proof", icon: IconClockOutlineRegular },
	};

	const TOOL_NAMES = Object.keys(TOOL_META);

	/** Argument keys the compact row prefers, in display order: human text first, ids last. */
	const ARG_KEYS = ["goal", "title", "target", "step", "proposition", "statement", "summary", "query", "objective", "description", "detail", "reason", "outcome", "kind", "action", "missionId", "actorId", "taskId", "recordId", "claim", "status"];

	function firstLine(text) {
		const i = String(text).indexOf("\n");
		return i === -1 ? String(text) : String(text).slice(0, i);
	}

	/** Salient call argument; streaming may expose a truncated JSON prefix. */
	function argSummary(argsRaw, callId) {
		let parsed;
		try {
			parsed = JSON.parse(argsRaw);
		} catch {
			return argsRaw === "" ? callId : firstLine(argsRaw);
		}
		if (typeof parsed !== "object" || parsed === null) return firstLine(String(argsRaw)) || callId;
		for (const key of ARG_KEYS) {
			const value = parsed[key];
			if (typeof value === "string" && value !== "") return firstLine(value);
			if (typeof value === "number" || typeof value === "boolean") return `${key}=${String(value)}`;
		}
		for (const key of Object.keys(parsed)) {
			const value = parsed[key];
			if (typeof value === "string" && value !== "") return firstLine(value);
		}
		return callId;
	}

	/** Flatten durable result blocks under the generic Tool-row text contract. */
	function resultText(block) {
		if (!("kind" in block)) return null;
		const parts = [];
		for (const item of block.content || []) {
			parts.push(item.type === "text" ? item.text : JSON.stringify(item, null, 2));
		}
		if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`);
		return parts.join("\n") || null;
	}

	function rowModel(toolName, block) {
		const settled = "kind" in block;
		const argsRaw = (settled ? block.call && block.call.argsRaw : block.argsRaw) || "";
		const state = !settled ? "running" : block.error && block.error.code === "interrupted" ? "stopped" : block.isError ? "error" : "ok";
		const output = resultText(block);
		return {
			state,
			argsRaw: argsRaw === "" ? null : argsRaw,
			output,
			summary: state === "stopped" ? "stopped" : (state === "error" && output !== null ? firstLine(output) : argSummary(argsRaw, block.callId)),
			titleKey: `tool.${(TOOL_META[toolName] ? toolName.replace(/^continuity_/, "") : "status")}`,
		};
	}

	function markdownLabels(t) {
		return {
			code: {
				copyLabel: t("config.copy"), copiedLabel: t("config.copied"),
				toolbarLabels: { codeLabel: t("config.codeBlock"), wrapLabel: t("config.wrap"), unwrapLabel: t("config.unwrap") },
			},
			footnotes: t("config.footnotes"),
		};
	}

	function ContinuityToolRow(props) {
		const t = props.t;
		if (props.phase === "preparing") {
			return h("div", { className: "ltc-card", "data-tool": props.toolName, "data-state": "preparing" },
				h("div", { className: "ltc-preparing" },
					h("span", { className: "ltc-lead" }, h((TOOL_META[props.toolName] || { icon: IconDatabaseOutlineRegular }).icon, null)),
					h(TextShimmer, { active: true }, t("row.preparing")),
				),
			);
		}
		const meta = TOOL_META[props.toolName] || { group: "mission", icon: IconDatabaseOutlineRegular };
		const model = rowModel(props.toolName, props.block);
		// Native disclosure seat: open state resets with the enclosing Turn.
		const { expanded, toggle: toggleExpand } = props.useDisclosure();
		const argsRaw = model.argsRaw;
		const expandable = model.state !== "preparing" && (argsRaw !== null || model.output !== null);
		const open = expanded && expandable;
		const running = model.state === "running";
		const labels = useMemo(() => markdownLabels(t), [t]);
		const tone = model.state === "error" ? "error" : model.state === "stopped" ? "stopped" : undefined;
		// Native parity: the lifecycle is announced to screen readers apart from the visible summary.
		const status = model.state === "running" ? t("row.running") : model.state === "error" ? t("row.failed") : model.state === "stopped" ? t("row.stopped") : null;
		return h("div", { className: "ltc-root", "data-variant": "others", "data-tool": props.toolName, "data-state": model.state },
			status !== null ? h("span", { className: "ltc-visuallyHidden" }, status) : null,
			h(DisclosureRow, {
				icon: h(meta.icon, null),
				title: t(model.titleKey),
				running,
				open,
				expandable,
				expandOnRowClick: true,
				keepContentWhenOpen: true,
				onToggle: toggleExpand,
				collapsedContent: model.summary === "" ? null : h(react.Fragment, null,
					h("span", { className: "ltc-sep", "data-shimmer-decoration": true, "aria-hidden": true }),
					h("span", { className: "ltc-summary", "data-tone": tone },
						h(TextShimmer, null, model.summary),
					),
				),
			},
				open ? h("div", { className: "ltc-body" },
					argsRaw !== null ? h("div", { className: "ltc-ioCard" },
						h("span", { className: "ltc-ioLabel" }, t("row.input")),
						h("div", { className: "ltc-ioBody" }, h(MarkdownText, { text: `\`\`\`json\n${argsRaw}\n\`\`\``, labels, variant: "compact" })),
					) : null,
					model.output !== null ? h("div", { className: "ltc-ioCard" },
						h("span", { className: "ltc-ioLabel" }, t("row.output")),
						h("div", { className: "ltc-ioBody" }, h(MarkdownText, { text: model.output, labels, variant: "compact" })),
					) : null,
					props.inspect !== undefined && model.state === "ok" ? h("button", {
						className: "ltc-inspect", type: "button", onClick: props.inspect,
					}, h(IconInspectOutlineRegular, { size: 14 }), t("row.inspect")) : null,
				) : null,
			),
		);
	}

	/* ---------------------------------------------------------- config card -- */

	const BOOLEAN = {
		enabled: true, autoRotationEnabled: true, probesAcknowledged: true,
		enforceAdmission: true, registerTools: true, migrateSchedules: true, rearmGoal: true,
		acceptMirroredCompactionDefaults: true,
	};
	const SECTIONS = [
		{ key: "switch", fields: ["enabled", "missionId", "registerTools", "enforceAdmission", "autoRotationEnabled", "probesAcknowledged"] },
		{ key: "rotation", fields: ["rotateRatio", "warnRatio", "hardRatio", "handoffMarginTokens", "outputReserveTokens", "compactionHeadroomTokens", "compactionRatio", "acceptMirroredCompactionDefaults", "cooldownTurns", "minTurnsBetweenRotations", "maxRotationPerHour"] },
		{ key: "boundary", fields: ["boundarySlowMs", "boundaryDeadlineMs", "migrateSchedules", "rearmGoal", "outboxDrainMs"] },
		{ key: "lease", fields: ["leaseHeartbeatMs", "leaseExpiryMs"] },
		{ key: "lock", fields: ["hostLockPath"] },
		{ key: "replay", fields: ["replayWindowMs"] },
	];
	const ALL_FIELDS = SECTIONS.reduce((acc, section) => acc.concat(section.fields), []);

	function booleanField(field) {
		return {
			field,
			format: value => typeof value === "boolean" ? (value ? "true" : "false") : "",
			parse: (text) => {
				const trimmed = text.trim();
				if (trimmed === "true") return { kind: "set", value: true };
				if (trimmed === "false") return { kind: "set", value: false };
				return undefined;
			},
		};
	}

	function installConfigCard(ctx) {
		ctx.inject(["configForms"], (host) => {
			const form = host.configForms.get(PKG);
			const TEXT = { missionId: true, hostLockPath: true };
			const specs = ALL_FIELDS.map(field => BOOLEAN[field] ? booleanField(field) : TEXT[field] ? settingsTextField(field) : settingsNumberField(field));
			const model = new SettingsFormModel(form, specs);
			const store = model.bind(() => {
				const projection = Object.assign({}, model.shell());
				for (const field of ALL_FIELDS) projection[field] = model.field(field);
				return projection;
			});
			ctx.effect(() => () => { model.dispose(); }, "dsh-long-task-continuity: config form");
			ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: PKG,
				locale: NS,
				inject: () => Object.assign({ hooks: { continuityForm: store } }, model.actions()),
			}, ContinuityConfigCard));
		});
	}

	function ContinuityConfigCard(props) {
		const t = props.t;
		if (props.view === "summary") return t("config.summary");
		const state = props.useContinuityForm(snapshot => snapshot);
		const disabled = !state.writable;
		const labels = {
			unavailable: t("config.unavailable"), readOnly: t("config.readOnly"),
			saveFailed: t("config.saveFailed"), save: t("config.save"), saving: t("config.saving"),
		};
		const children = [];
		for (const section of SECTIONS) {
			children.push(h("div", { key: section.key, className: "ltc-groupTitle" }, t("config.section." + section.key)));
			for (const field of section.fields) {
				const value = state[field] || { text: "", overridden: false, invalid: false };
				if (BOOLEAN[field]) {
					children.push(h("div", { key: field, className: "ltc-switchRow" },
						h("div", { className: "ltc-switchText" },
							h("span", { className: "ltc-switchLabel" }, t("config.field." + field)),
							h("span", { className: "ltc-switchHint" }, t("config.field." + field + "Hint")),
						),
						h(Switch, {
							label: t("config.field." + field),
							checked: value.text === "true",
							disabled,
							onChange: (next) => { props.edit(field, next ? "true" : "false"); },
						}),
					));
					continue;
				}
				children.push(h(SettingsValueField, {
					key: field,
					id: `plugin-config-continuity-${field}`,
					label: t("config.field." + field),
					hint: t("config.field." + field + "Hint"),
					text: value.text,
					overridden: value.overridden,
					invalid: value.invalid,
					overriddenLabel: t("config.overridden"),
					resetLabel: t("config.reset"),
					invalidLabel: t("config.invalid"),
					numeric: field !== "missionId",
					disabled,
					onEdit: (text) => { props.edit(field, text); },
					onReset: () => { props.resetField(field); },
				}));
			}
		}
		return h(SettingsForm, { labels, state, onSave: props.save, onDiscard: props.discard }, children);
	}

	/* -------------------------------------------------------- workbench tab -- */

	// 右侧停靠面的只读任务页签，两段式注册走 ui-sidebar-right 的公开路径：
	// 类型定义进 `sidebarRightTabs`，正文与页签标题进 `sidebar.right.pane.tab` /
	// `sidebar.right.pane.tab.title` 的同 id 键。数据只取宿主
	// `src/views/workbench.ts` 的 `WORKBENCH_PATH` 投影；本文件不写任何控制记录，
	// 租约是否过期按客户端时钟比较（视图层不判定），缺数据的面显示"未知"而不是 0。
	const WORKBENCH_ID = "continuity-workbench";
	/** 与宿主 `WORKBENCH_PATH` 同字符串；浏览器侧去掉前导斜杠做文档相对解析。 */
	const WORKBENCH_PATH = "api/continuity.workspace";
	// 纪律面板：读磁盘上的 $DSH_HOME/AGENTS.md（服务端现读现算指纹），不是插件内副本。
	const DISCIPLINE_PATH = "api/continuity.discipline";
	// 上下文读数：占用 / 轮换线 / 判决 / 卡住的闸门。
	const CONTEXT_PATH = "api/continuity.context";
	const WORKBENCH_POLL_MS = 15000;
	const TASK_FILTERS = ["attention", "all", "active", "review", "blocked", "completed", "failed", "cancelled", "needsReview"];
	const ACTIVE_STATUSES = ["planned", "ready", "leased", "running", "retry_wait"];

	/** 会话跳转：`uiWorkspace` 未装载时保持 null，行上退化为纯文本，不摆按不动的按钮。 */
	let openWorkspaceSession = null;

	function formatClock(ms) {
		if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
		const date = new Date(ms);
		if (Number.isNaN(date.getTime())) return "";
		const pad = (value) => String(value).padStart(2, "0");
		return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
	}

	function formatSpan(ms) {
		const seconds = Math.max(0, Math.round(ms / 1000));
		if (seconds < 60) return seconds + "s";
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return minutes + "m";
		const hours = Math.floor(minutes / 60);
		if (hours < 48) return hours + "h" + (minutes % 60) + "m";
		return Math.floor(hours / 24) + "d" + (hours % 24) + "h";
	}

	/** 行色调只表达"要不要看一眼"，不改写任何协议字段。 */
	function taskTone(row) {
		if (row.status === "blocked" || row.status === "failed") return "error";
		if (row.status === "cancelled") return "muted";
		if (row.validity === "needs_review" || row.status === "submitted" || row.status === "verifying" || row.criteriaCheck === "suspicious") return "warn";
		return "neutral";
	}

	function criterionTone(outcome) {
		if (outcome === "fail" || outcome === "error") return "error";
		if (outcome === "missing" || outcome === "not_applicable") return "muted";
		if (outcome === "pass") return "neutral";
		return "warn";
	}

	function taskMatchesFilter(row, filter) {
		if (filter === "all") return true;
		if (filter === "active") return ACTIVE_STATUSES.indexOf(row.status) !== -1;
		if (filter === "review") return row.status === "submitted" || row.status === "verifying";
		if (filter === "blocked") return row.status === "blocked";
		if (filter === "completed") return row.status === "completed";
		if (filter === "failed") return row.status === "failed";
		if (filter === "cancelled") return row.status === "cancelled";
		if (filter === "needsReview") return row.validity === "needs_review";
		return taskMatchesFilter(row, "active") || taskMatchesFilter(row, "review") || row.status === "blocked" || row.validity === "needs_review";
	}

	/**
	 * 只读投影路由；404 是"本机还没有控制记录"，不是错误。
	 * `sessionId` = 本页签所属会话（G3 左右联动）：服务端按它读该会话所属 Team 的原生任务板；
	 * 传空串即不指定，服务端回落到 Mission Lead 的绑定会话。
	 */
	async function readWorkbench(signal, sessionId) {
		const query = sessionId === undefined || sessionId === "" ? "" : "?sessionId=" + encodeURIComponent(sessionId);
		const response = await fetch(WORKBENCH_PATH + query, { signal, cache: "no-store", headers: { accept: "application/json" } });
		if (response.status === 404) return { kind: "empty" };
		if (!response.ok) throw new Error("HTTP " + response.status);
		return { kind: "ready", data: await response.json() };
	}

	async function readDiscipline(signal) {
		const response = await fetch(DISCIPLINE_PATH, { signal, cache: "no-store", headers: { accept: "application/json" } });
		if (!response.ok) throw new Error("HTTP " + response.status);
		return await response.json();
	}

	async function readContext(signal, sessionId) {
		const query = sessionId === undefined || sessionId === "" ? "" : "?sessionId=" + encodeURIComponent(sessionId);
		const response = await fetch(CONTEXT_PATH + query, { signal, cache: "no-store", headers: { accept: "application/json" } });
		if (!response.ok) throw new Error("HTTP " + response.status);
		return await response.json();
	}

	// 写回纪律：带上读到的 sha256，服务端据此拒掉"基于旧版本"的保存，避免覆盖别人的改动。
	async function writeDiscipline(text, expectedSha256) {
		const response = await fetch(DISCIPLINE_PATH, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ text, expectedSha256 }),
		});
		return await response.json();
	}

	function wbChip(label, tone, key) {
		return h("span", { key, className: "ltc-wbChip", "data-tone": tone }, label);
	}

	function kvList(pairs) {
		const items = [];
		for (let index = 0; index < pairs.length; index += 1) {
			items.push(h("dt", { key: "k" + index }, pairs[index][0]));
			items.push(h("dd", { key: "d" + index }, pairs[index][1]));
		}
		return h("dl", { className: "ltc-wbKV" }, items);
	}

	function workbenchTaskDetail(t, row, sessionChip) {
		const owner = row.ownerActorId === "" ? t("wb.unassigned") : h("span", null,
			row.ownerActorId,
			row.ownerSessionId === "" ? null : h("span", null, " · ", sessionChip(row.ownerSessionId, "ownerSession")),
		);
		const pairs = [
			[t("wb.owner"), owner],
			[t("wb.attempts"), row.attemptCount + "/" + row.maxAttempts + (row.currentAttemptId === "" ? "" : " · " + row.currentAttemptId)],
			[t("wb.priority"), String(row.priority) + (row.workKind === "" ? "" : " · " + row.workKind) + (row.scope === "" ? "" : " · " + row.scope)],
		];
		if (row.dependsOn.length > 0) pairs.push([t("wb.dependsOn"), row.dependsOn.join(", ")]);
		if (row.unmetDependencies.length > 0) pairs.push([t("wb.unmet"), row.unmetDependencies.join(", ")]);
		if (row.blockedReason !== "") pairs.push([t("wb.blockedReason"), row.blockedReason]);
		pairs.push([t("wb.criteriaCheck"), row.criteriaCheck + (row.criteriaBlockers.length === 0 ? "" : " · " + row.criteriaBlockers.join(", "))]);
		pairs.push([t("wb.revisions"), row.objectiveRevision + " / " + row.specRevision + " / " + row.criteriaRevision]);
		pairs.push([t("wb.updatedAt"), formatClock(row.updatedAt)]);
		const criteria = row.criteria.length === 0 ? null : h("ul", { className: "ltc-wbCriteria" },
			row.criteria.map((criterion) => h("li", { key: criterion.criterionId, className: "ltc-wbCriterion" },
				wbChip(criterion.outcome, criterionTone(criterion.outcome), undefined),
				h("span", { className: "ltc-wbCriterionText" }, criterion.text + (criterion.method === "" ? "" : " · " + criterion.method)),
			)));
		// 原生侧摘要：链接解析到哪一行就读哪一行，字段缺席即"未知"，绝不拿插件状态顶替（G1）。
		const native = row.native === null ? null : kvList([
			[t("wb.nativeTask"), row.native.nativeTaskId === "" ? t("wb.unknown") : row.native.nativeTaskId],
			[t("wb.nativeStatus"), row.native.status === "" ? t("wb.unknown") : row.native.status],
			[t("wb.nativeAssignee"), row.native.assignee === "" ? t("wb.unassigned") : row.native.assignee],
			[t("wb.nativeRevision"), row.native.revision === null ? t("wb.unknown") : String(row.native.revision)],
			[t("wb.nativeReady"), row.native.ready === null ? t("wb.unknown") : row.native.ready ? t("wb.yes") : t("wb.no")],
			[t("wb.nativeBlockedBy"), row.native.blockedBy.length === 0 ? t("wb.nativeNone") : row.native.blockedBy.join(", ")],
		]);
		return h("div", { className: "ltc-wbBody" },
			kvList(pairs),
			criteria === null ? null : h("div", { className: "ltc-wbLabel" }, t("wb.criteria")),
			criteria,
			row.resourceKeys.length === 0 ? null : h("div", { className: "ltc-wbMuted" }, t("wb.resources") + " " + row.resourceKeys.join(", ")),
			// 关卡备注是 G1 定义的可断言警示句（原生完成但未验收、口径矛盾、链接缺失），全文放这里。
			row.gateNote === "" ? null : h("div", { className: "ltc-wbNote", "data-tone": "warn" }, row.gateNote),
			native === null ? null : h("div", { className: "ltc-wbLabel" }, t("wb.nativeTask")),
			native,
		);
	}

	function ContinuityWorkbenchView(props) {
		const t = props.t;
		const tab = props.useTabInfo().tab;
		// 座位标准 prop：`sidebar.right.pane.tab` 是**会话作用域**，所以左栏选中哪个会话，
		// 右栏就把该会话带给服务端，读它所属 Team 的原生任务板（G3 左右联动的第一半）。
		// 拿不到就是空串 = 不指定，由服务端回落到 Mission Lead 绑定会话，绝不自造一个会话。
		const sessionId = props.sessionId === undefined || props.sessionId === null ? "" : String(props.sessionId);
		const [read, setRead] = useState({ phase: "loading", data: null, error: "" });
		// 纪律面板独立于台账：没有 Mission 时也要能看出"纪律从哪来、有没有进上下文"。
		const [discipline, setDiscipline] = useState(null);
		// 上下文读数：跟会话走，页签切换会话就重读。
		const [context, setContext] = useState(null);
		// 编辑态：草稿 + 写入中 + 错误/回执。写入要带 sha256，服务端据此拒掉基于旧版本的保存。
		const [editing, setEditing] = useState(false);
		const [draft, setDraft] = useState("");
		const [saving, setSaving] = useState(false);
		const [saveError, setSaveError] = useState("");
		const [savedNotice, setSavedNotice] = useState("");
		const [filter, setFilter] = useState("attention");
		const [openRows, setOpenRows] = useState({});
		const [now, setNow] = useState(() => Date.now());

		const reload = useCallback(() => {
			readWorkbench(tab.signal, sessionId).then((result) => {
				if (tab.signal.aborted) return;
				setRead(result.kind === "ready"
					? { phase: "ready", data: result.data, error: "" }
					: { phase: "empty", data: null, error: "" });
			}).catch((error) => {
				if (tab.signal.aborted || (error !== null && typeof error === "object" && error.name === "AbortError")) return;
				setRead({ phase: "error", data: null, error: String((error && error.message) || error) });
			});
		}, [tab.signal, sessionId]);

		useEffect(() => { reload(); }, [reload]);
		// 租约倒计时只在页签可见时走针：隐藏页签一次 setState 都不产生。
		useEffect(() => {
			if (!tab.visible) return undefined;
			setNow(Date.now());
			const clock = setInterval(() => { setNow(Date.now()); }, 1000);
			return () => { clearInterval(clock); };
		}, [tab.visible]);
		useEffect(() => {
			const poll = setInterval(() => { if (tab.visible) reload(); }, WORKBENCH_POLL_MS);
			return () => { clearInterval(poll); };
		}, [reload, tab.visible]);

		useEffect(() => {
			readDiscipline(tab.signal).then((value) => {
				if (tab.signal.aborted) return;
				setDiscipline(value);
			}).catch(() => { /* 读不到就保持空态，不把错误塞进台账区 */ });
		}, [tab.signal]);

		useEffect(() => {
			readContext(tab.signal, sessionId).then((value) => {
				if (tab.signal.aborted) return;
				setContext(value);
			}).catch(() => { /* 读不到保持空态 */ });
		}, [tab.signal, sessionId]);

		const data = read.phase === "ready" ? read.data : null;
		const jump = (sessionId) => { if (openWorkspaceSession !== null) openWorkspaceSession(sessionId); };
		const sessionChip = (sessionId, key) => sessionId === ""
			? null
			: openWorkspaceSession === null
				? h("span", { key, className: "ltc-wbMuted" }, sessionId)
				: h("button", { key, className: "ltc-wbJump", type: "button", title: t("wb.jump"), onClick: () => { jump(sessionId); } }, sessionId);

		const header = h("div", { className: "ltc-wbHead" },
			h("span", { className: "ltc-wbMission" }, data === null ? t("wb.tab.title") : data.missionId),
			data === null ? null : wbChip(data.status, "neutral", "mission-status"),
			data === null || !data.admissionClosed ? null : wbChip(t("wb.admissionClosed"), "warn", "admission"),
			data === null ? null : wbChip(data.ledger.freshness, data.ledger.freshness === "current" ? "neutral" : data.ledger.freshness === "stale" ? "warn" : "muted", "freshness"),
			h("span", { className: "ltc-wbSpacer" }),
			data === null ? null : h("span", { className: "ltc-wbMuted" }, t("wb.revision") + " " + data.sourceRevision + " · " + t("wb.generatedAt") + " " + formatClock(data.generatedAt)),
			h("button", { className: "ltc-wbRefresh", type: "button", onClick: reload },
				h(IconRefreshOutlineRegular, { size: 14 }), t("wb.refresh")),
		);

		const section = (key, node, count) => node === null ? null : h(react.Fragment, null,
			h("div", { className: "ltc-groupTitle" }, t("wb.group." + key) + (count === undefined ? "" : " (" + count + ")")),
			node,
		);

		let body;
		if (read.phase === "loading") {
			body = h("div", { className: "ltc-preparing" },
				h("span", { className: "ltc-lead" }, h(IconChecklistOutlineRegular, null)),
				h(TextShimmer, { active: true }, t("wb.loading")),
			);
		} else if (read.phase === "error") {
			body = h("div", { className: "ltc-wbNote", "data-tone": "error" }, t("wb.failed") + "：" + read.error);
		} else if (read.phase === "empty") {
			body = h("div", { className: "ltc-wbNote" }, t("wb.empty"));
		} else {
			const countKeys = ["taskTotal", "completedNow", "blocked", "needsReview", "submitted", "running", "failed", "cancelled", "actorTotal", "sessionTotal"];
			const warnWhenPositive = { blocked: true, needsReview: true, failed: true };
			const counts = h("div", { className: "ltc-wbCounts" },
				countKeys.map((key) => wbChip(
					t("wb.count." + key) + " " + data.counts[key],
					warnWhenPositive[key] === true && data.counts[key] > 0 ? "warn" : "neutral",
					key,
				)));

			const alerts = data.alerts.length === 0 ? null : h("div", { className: "ltc-wbList" },
				data.alerts.map((alert) => h("div", { key: alert.code, className: "ltc-wbAlert" },
					h("div", { className: "ltc-wbRowHead" },
						wbChip(alert.code, alert.severity === "warning" ? "warn" : "muted", "code"),
						alert.refs.length === 0 ? null : h("span", { className: "ltc-wbMuted" }, alert.refs.join(" ")),
					),
					h("span", { className: "ltc-wbAlertText" }, alert.message),
				)));

			const brief = h("div", { className: "ltc-wbBody" },
				h("div", { className: "ltc-wbLabel" }, t("wb.objective")),
				h("div", { className: "ltc-wbText" }, data.objective === "" ? t("wb.unknown") : data.objective),
				h("div", { className: "ltc-wbLabel" }, t("wb.nextStep")),
				h("div", { className: "ltc-wbText" }, data.nextStep === "" ? t("wb.unknown") : data.nextStep),
				data.ledger.waitingReason === "" ? null : h("div", { className: "ltc-wbLabel" }, t("wb.waitingReason")),
				data.ledger.waitingReason === "" ? null : h("div", { className: "ltc-wbText" }, data.ledger.waitingReason),
			);

			const leases = data.ledger.leases.length === 0 ? null : h("div", { className: "ltc-wbList" },
				data.ledger.leases.map((lease) => {
					const delta = lease.leaseExpiresAt - now;
					const expired = delta < 0;
					return h("div", { key: lease.attemptId, className: "ltc-wbRow" },
						h("div", { className: "ltc-wbRowHead" },
							h("span", { className: "ltc-wbTitle" }, lease.actorId + " · " + lease.taskId),
							wbChip(lease.status, "neutral", "status"),
							wbChip(t(expired ? "wb.lease.expired" : "wb.lease.remaining") + " " + formatSpan(expired ? -delta : delta), expired ? "error" : "neutral", "expiry"),
						),
						h("div", { className: "ltc-wbMuted" },
							lease.attemptId + " · " + t("wb.lease.heartbeat") + " " + formatClock(lease.lastHeartbeatAt) + (lease.hasTicket ? " · " + t("wb.lease.ticket") : "")),
					);
				}));

			const rows = data.tasks.filter((row) => taskMatchesFilter(row, filter));
			const tasks = h("div", { className: "ltc-wbList" },
				rows.length === 0 ? h("div", { className: "ltc-wbMuted" }, t("wb.none")) : rows.map((row) => {
					const expanded = openRows[row.taskId] === true;
					return h("div", { key: row.taskId, className: "ltc-root", "data-tool": "continuity-workbench" },
						h(DisclosureRow, {
							icon: h(IconChecklistOutlineRegular, null),
							title: row.title === "" ? row.taskId : row.title,
							running: row.status === "running",
							open: expanded,
							expandable: true,
							expandOnRowClick: true,
							keepContentWhenOpen: true,
							onToggle: () => {
								setOpenRows((previous) => {
									const next = Object.assign({}, previous);
									next[row.taskId] = !expanded;
									return next;
								});
							},
							collapsedContent: h(react.Fragment, null,
								wbChip(row.status, taskTone(row), "status"),
								row.validity === "current" ? null : wbChip(row.validity, row.validity === "invalid" ? "error" : "warn", "validity"),
								row.ownerActorId === "" ? h("span", { className: "ltc-wbMuted" }, t("wb.unassigned")) : h("span", { className: "ltc-wbMuted" }, row.ownerActorId),
								row.unmetDependencies.length === 0 ? null : wbChip(t("wb.unmet") + " " + row.unmetDependencies.length, "warn", "unmet"),
								// 执行态与验收态**分开**显示，两套状态谁也不冒充谁（G1）。execution 空串 = 这一面
								// 根本没读（没给会话定位或原生板读失败），显示"未知"而不是"没有"。
								wbChip(t("wb.execution") + " " + (row.execution === "" ? t("wb.unknown") : row.execution), row.execution === "completed" || row.execution === "running" ? "neutral" : "muted", "execution"),
								wbChip(t("wb.acceptance") + " " + row.acceptance, row.acceptance === "accepted" ? "neutral" : row.acceptance === "needs_review" ? "warn" : "muted", "acceptance"),
								row.gateNote === "" ? null : wbChip(t("wb.gateNote"), "warn", "gate"),
							),
						},
							expanded ? workbenchTaskDetail(t, row, sessionChip) : null,
						),
					);
				}));

			const actors = data.actors.length === 0 ? null : h("div", { className: "ltc-wbList" },
				data.actors.map((actor) => {
					const head = [h("span", { key: "label", className: "ltc-wbTitle" }, actor.label), wbChip(actor.role, "neutral", "role")];
					if (actor.retired) head.push(wbChip(t("wb.retired"), "muted", "retired"));
					if (actor.dormant) head.push(wbChip(t("wb.dormant"), "muted", "dormant"));
					if (actor.available) head.push(wbChip(t("wb.available"), "neutral", "available"));
					return h("div", { key: actor.actorId, className: "ltc-wbRow" },
						h("div", { className: "ltc-wbRowHead" }, head),
						sessionChip(actor.sessionId, "session"),
						h("div", { className: "ltc-wbMuted" },
							actor.actorId + (actor.teamId === "" ? "" : " · " + actor.teamId) +
							(actor.waitingFor === "" ? "" : " · " + t("wb.waitingFor") + " " + actor.waitingFor) +
							(actor.liveAttemptIds.length === 0 ? "" : " · " + t("wb.liveAttempts") + " " + actor.liveAttemptIds.join(", "))),
					);
				}));

			const sessions = data.sessions.length === 0 ? null : h("div", { className: "ltc-wbList" },
				data.sessions.map((session) => h("div", { key: session.kind + ":" + session.actorId + ":" + session.sessionId, className: "ltc-wbRow" },
					h("div", { className: "ltc-wbRowHead" },
						sessionChip(session.sessionId, "id"),
						wbChip(session.kind, "neutral", "kind"),
						session.phase === "" ? null : wbChip(session.phase, "neutral", "phase"),
					),
					h("div", { className: "ltc-wbMuted" },
						session.actorId +
						(session.continuationOf === "" ? "" : " · " + t("wb.session.continuationOf") + " " + session.continuationOf + (session.rotationId === "" ? "" : " (" + session.rotationId + ")"))),
				)));

			const coverage = h("div", { className: "ltc-wbBody" },
				h("div", { className: "ltc-wbMuted" }, t("wb.coverage.included") + " " + data.coverage.included.join(", ")),
				h("div", { className: "ltc-wbList" },
					data.coverage.unavailable.map((face) => h("div", { key: face.face, className: "ltc-wbRow" },
						h("div", { className: "ltc-wbRowHead" },
							h("span", { className: "ltc-wbTitle" }, face.face),
							wbChip(t("wb.unknown"), "muted", "unknown"),
						),
						h("div", { className: "ltc-wbMuted" }, face.reason),
					))),
			);

			// 原生任务板（G1/G3）：只读双栏的右栏。`native === null` = 调用方连会话定位都没给，
			// 这一面**没有尝试读取**；`phase === "unavailable"` = 尝试了但读不出来，原因在 reason 里。
			// 两种情况都显示"未知"，但绝不显示成"0 项"——读不到不是空。
			const native = data.native === null ? null : h("div", { className: "ltc-wbBody" },
				h("div", { className: "ltc-wbRowHead" },
					wbChip(t("wb.nativeSession") + " " + (data.native.sessionId === "" ? t("wb.nativeNoSession") : data.native.sessionId), "muted", "nativeSession"),
					wbChip(t(data.native.phase === "read" ? "wb.nativeRead" : "wb.nativeUnavailable"), data.native.phase === "read" ? "neutral" : "muted", "nativePhase"),
					data.native.phase !== "read" ? null : wbChip(t("wb.nativeRows") + " " + data.native.readTotal, "neutral", "nativeRows"),
					data.native.phase !== "read" ? null : wbChip(t("wb.nativeLinked") + " " + data.native.linkedTasks, "neutral", "nativeLinked"),
				),
				data.native.reason === "" ? null : h("div", { className: "ltc-wbMuted" }, data.native.reason),
				data.native.risks.length === 0 ? null : h("div", { className: "ltc-wbList" },
					data.native.risks.map((risk, index) => h("div", { key: "native-risk-" + index, className: "ltc-wbAlert" },
						h("div", { className: "ltc-wbRowHead" }, wbChip(t("wb.nativeRisks"), "warn", "risks")),
						h("span", { className: "ltc-wbAlertText" }, risk),
					))),
				data.native.unlinked.length === 0 ? null : h("div", { className: "ltc-wbLabel" }, t("wb.nativeUnlinked")),
				data.native.unlinked.length === 0 ? null : h("div", { className: "ltc-wbList" },
					data.native.unlinked.map((row, index) => h("div", { key: "native-unlinked-" + index, className: "ltc-wbRow" },
						h("div", { className: "ltc-wbRowHead" },
							h("span", { className: "ltc-wbTitle" }, row.title === "" ? (row.nativeTaskId === "" ? t("wb.unknown") : row.nativeTaskId) : row.title),
							wbChip(row.status === "" ? t("wb.unknown") : row.status, "muted", "nativeStatus"),
							row.assignee === "" ? null : h("span", { className: "ltc-wbMuted" }, row.assignee),
						)))),
			);

			const filterBar = h("div", { className: "ltc-wbFilters" },
				TASK_FILTERS.map((key) => h("button", {
					key,
					type: "button",
					className: "ltc-wbFilter",
					"data-active": filter === key ? "true" : "false",
					onClick: () => { setFilter(key); },
				}, t("wb.filter." + key))));

			body = h(react.Fragment, null,
				counts,
				filterBar,
				section("alerts", alerts, data.alerts.length),
				brief,
				section("leases", leases, data.ledger.leases.length),
				section("tasks", tasks, rows.length + "/" + data.tasks.length),
				section("native", native, data.native === null || data.native.phase !== "read" ? undefined : data.native.readTotal),
				section("actors", actors, data.actors.length),
				section("sessions", sessions, data.sessions.length),
				section("coverage", coverage, undefined),
			);
		}

		const saveDiscipline = useCallback(() => {
			if (discipline === null) return;
			setSaving(true);
			setSaveError("");
			writeDiscipline(draft, discipline.sha256).then((out) => {
				if (out === null || typeof out !== "object" || out.ok !== true) {
					setSaveError(String((out && out.reason) || "写入失败"));
					return undefined;
				}
				return readDiscipline(tab.signal).then((fresh) => {
					setDiscipline(fresh);
					setEditing(false);
					setSavedNotice(t("disc.editHint"));
				});
			}).catch((error) => {
				setSaveError(String((error && error.message) || error));
			}).finally(() => {
				setSaving(false);
			});
		}, [discipline, draft, tab.signal, t]);

		// —— 两块纪律面板 ——
		// 面板一「纪律（当前生效）」：磁盘原文 + 指纹，可核对，不是插件内副本。
		// 面板二「注入确认」：三类身份各自走哪条链路、是否实测过；推断不写成事实。
		const disciplineView = discipline === null ? null : h(react.Fragment, null,
			h("div", { className: "ltc-wbBody" },
				h("div", { className: "ltc-wbRowHead" },
					wbChip(t("wb.group.discipline"), "neutral", "discipline"),
					h("span", { className: "ltc-wbSpacer" }),
					editing
						? h(react.Fragment, null,
							h("button", { key: "save", className: "ltc-wbRefresh", type: "button", disabled: saving, onClick: () => { saveDiscipline(); } },
								saving ? t("disc.saving") : t("disc.save")),
							h("button", { key: "cancel", className: "ltc-wbRefresh", type: "button", disabled: saving, onClick: () => { setEditing(false); setSaveError(""); } },
								t("disc.cancel")))
						: h("button", {
							key: "edit",
							className: "ltc-wbRefresh",
							type: "button",
							disabled: !discipline.present,
							onClick: () => { setDraft(discipline.text); setEditing(true); setSaveError(""); setSavedNotice(""); },
						}, t("disc.edit"))),
				h("div", { className: "ltc-wbMuted" }, t("disc.source") + " " + discipline.sourcePath),
				h("div", { className: "ltc-wbMuted" }, discipline.present
					? t("disc.sha") + " " + discipline.sha256.slice(0, 16) + " · " + t("disc.bytes") + " " + discipline.bytes + " · " + t("disc.modified") + " " + discipline.modifiedAt
					: t("disc.missing")),
				editing
					? h("textarea", {
						key: "editor",
						value: draft,
						spellCheck: false,
						onChange: (event) => { setDraft(event.target.value); },
						style: { width: "100%", minHeight: "320px", fontFamily: "ui-monospace, monospace", fontSize: "12px", lineHeight: "1.5" },
					})
					: (discipline.present ? h("div", { className: "ltc-wbList" }, discipline.sections.map((item) =>
						h("div", { key: item.title, className: "ltc-wbRow" },
							h("div", { className: "ltc-wbRowHead" }, wbChip(item.title, "neutral", "sec")),
							h("div", { className: "ltc-wbMuted" }, item.lines.join(" · "))))) : null),
				editing ? h("div", { className: "ltc-wbMuted" }, t("disc.editHint")) : null,
				saveError === "" ? null : h("div", { className: "ltc-wbMuted" }, saveError),
				savedNotice === "" ? null : h("div", { className: "ltc-wbMuted" }, savedNotice),
			),
			h("div", { className: "ltc-wbBody" },
				h("div", { className: "ltc-wbRowHead" }, wbChip(t("wb.group.injection"), "neutral", "injection")),
				h("div", { className: "ltc-wbMuted" }, discipline.mechanism),
				h("div", { className: "ltc-wbList" }, discipline.identities.map((row) =>
					h("div", { key: row.id, className: "ltc-wbRow" },
						h("div", { className: "ltc-wbRowHead" },
							wbChip(row.label, "neutral", "who"),
							wbChip(row.evidence === "measured" ? t("disc.measured") : t("disc.inferred"), row.evidence === "measured" ? "neutral" : "muted", "ev")),
						h("div", { className: "ltc-wbMuted" }, row.mechanism + " · " + row.evidenceNote)))),
				h("div", { className: "ltc-wbMuted" }, discipline.notes.join(" · ")),
			),
		);

		// —— 上下文读数面板 ——
		// 面板存在的意义是回答"现在该不该压缩/轮换、卡在哪"，而不是显示一串数字。
		const contextView = context === null ? null : h("div", { className: "ltc-wbBody" },
			h("div", { className: "ltc-wbRowHead" }, wbChip(t("wb.group.context"), "neutral", "context")),
			context.available !== true
				? h("div", { className: "ltc-wbMuted" }, String(context.reason || t("ctx.unavailable")))
				: h(react.Fragment, null,
					h("div", { className: "ltc-wbMuted" },
						t("ctx.ratio") + " " + (context.ratio === null || context.ratio === undefined ? t("wb.unknown") : (context.ratio * 100).toFixed(1) + "%") +
						" · " + t("ctx.projected") + " " + (context.projectedTokens === null || context.projectedTokens === undefined ? t("wb.unknown") : context.projectedTokens) +
						" / " + t("ctx.window") + " " + (context.contextWindow === null || context.contextWindow === undefined ? t("wb.unknown") : context.contextWindow) +
						(context.clampMismatch === true ? " ⚠ 投影超过声明窗口" : "")),
					h("div", { className: "ltc-wbRowHead" },
						wbChip(
							context.verdict && context.verdict.kind === "compact" ? t("ctx.verdict.compact")
								: context.verdict && context.verdict.kind === "rotate" ? t("ctx.verdict.rotate")
									: t("ctx.verdict.hold"),
							context.verdict && (context.verdict.kind === "compact" || context.verdict.kind === "rotate") ? "warn" : "muted",
							"verdict")),
					h("div", { className: "ltc-wbMuted" },
						t("ctx.gate") + " " + (context.verdict && context.verdict.holdingGate && context.verdict.holdingGate !== "none" ? context.verdict.holdingGate : t("ctx.gate.none"))),
					h("div", { className: "ltc-wbMuted" },
						t("ctx.line") + " " + String((context.rotationLine && context.rotationLine.mode) || "?") +
						(context.rotationLine && context.rotationLine.T !== null && context.rotationLine.T !== undefined ? " T=" + context.rotationLine.T : "")),
				),
		);

		return h("div", { className: "ltc-wbRoot" }, header, body, contextView, disciplineView);
	}

	function ContinuityWorkbenchTitle(props) {
		return h(react.Fragment, null,
			h("span", { className: "ltc-lead" }, h(IconChecklistOutlineRegular, null)),
			props.t("wb.tab.title"),
		);
	}

	/**
	 * 注册只读任务页签，外加会话跳转服务。两个依赖都是可选的：缺哪一个，
	 * 对应的能力就不出现（照 dsh-context 的写法，用 `ctx.inject` 的单依赖守卫）。
	 */
	function installWorkbenchTab(ctx) {
		ctx.inject(["uiWorkspace"], (host) => {
			const service = host.uiWorkspace;
			if (service === undefined || typeof service.openSession !== "function") return;
			openWorkspaceSession = (sessionId) => { service.openSession(sessionId); };
			return () => { openWorkspaceSession = null; };
		});
		ctx.inject(["sidebarRightTabs"], (host) => {
			const tabs = host.sidebarRightTabs;
			if (tabs === undefined || typeof tabs.register !== "function") return;
			const t = ctx.locale.bind(NS);
			const disposers = [];
			const track = (dispose) => { if (typeof dispose === "function") disposers.push(dispose); };
			try {
				track(tabs.register({
					id: WORKBENCH_ID,
					kind: WORKBENCH_ID,
					title: () => t("wb.tab.title"),
					guide: [{
						id: WORKBENCH_ID,
						order: 40,
						title: () => t("wb.tab.title"),
						description: () => t("wb.tab.description"),
						icon: IconChecklistOutlineRegular,
					}],
				}));
				track(host.slots.inject("sidebar.right.pane.tab", () => host.slots.register({
					name: "sidebar.right.pane.tab",
					key: WORKBENCH_ID,
					locale: NS,
				}, ContinuityWorkbenchView)));
				track(host.slots.inject("sidebar.right.pane.tab.title", () => host.slots.register({
					name: "sidebar.right.pane.tab.title",
					key: WORKBENCH_ID,
					locale: NS,
				}, ContinuityWorkbenchTitle)));
			} catch (error) {
				console.error("[dsh-long-task-continuity] workbench tab registration failed:", error);
				for (const dispose of disposers.reverse()) { try { dispose(); } catch {} }
				return;
			}
			return () => { for (const dispose of disposers.reverse()) { try { dispose(); } catch {} } };
		});
	}

	/* ----------------------------------------------------------------- body -- */

	/**
	 * Client plugin body: dictionaries, the 21 keyed toolviews, the bundle
	 * configuration page, and the read-only workbench tab.
	 * @param ctx - client root context.
	 */
	function apply(ctx) {
		ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-long-task-continuity: dictionaries");
		for (const toolName of TOOL_NAMES) {
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: toolName,
				locale: NS,
			}, ContinuityToolRow));
		}
		// Optional services must not kill the rows above: everything reaching
		// past the declared `inject` list is guarded and guarded again inside.
		try {
			installConfigCard(ctx);
		} catch (error) {
			console.error('[dsh-long-task-continuity] config card unavailable:', error);
		}
		try {
			installWorkbenchTab(ctx);
		} catch (error) {
			console.error('[dsh-long-task-continuity] workbench tab unavailable:', error);
		}
	}

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
} });
