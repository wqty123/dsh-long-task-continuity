export const BLOCKING = ['pressure-reader', 'session-create-shape', 'seed-delivery-receipt', 'turn-boundary', 'tool-guard-coverage', 'context-assembly', 'concurrent-input-routing'];
function shapeOf(value, members) {
    if (value === null || value === undefined)
        return { shape: 'missing', evidence: '服务未装载' };
    const record = value;
    const present = members.filter((member) => record[member] !== undefined);
    if (present.length === members.length)
        return { shape: 'ok', evidence: `成员齐：${present.join(', ')}` };
    if (present.length === 0)
        return { shape: 'missing', evidence: `一个成员都没有（期望 ${members.join(', ')}）` };
    return { shape: 'partial', evidence: `只有 ${present.join(', ')}，缺 ${members.filter((m) => !present.includes(m)).join(', ')}` };
}
export function probeAll(host) {
    const results = [];
    const pressure = shapeOf(host.sessionProjections, ['stateOf']);
    results.push({
        id: 'pressure-reader',
        shape: pressure.shape,
        evidence: `${pressure.evidence}；投影名 'contextPressure' 的字段口径需实测`,
        liveCheck: '在同一会话里读 contextPressure 的 projectedTokens/contextWindow，与 tokenMeter.measure 对账，确认三者是否同源同刻',
        degrade: '读不到即进入观察模式，自动轮换不启用，原生压缩保持可用（§10.1）',
    });
    const create = shapeOf(host.sessionController, ['create', 'resolveAgent']);
    results.push({
        id: 'session-create-shape',
        shape: create.shape,
        evidence: `${create.evidence}；预留 sessionId 的收养语义需实测（cwd/preset 冲突为硬失败、无 cwd 记录不可收养）`,
        liveCheck: '预留 ID 建会话→进程强杀→按同一 ID 再建，确认复用而不产生第二个会话',
        degrade: '不支持预留 ID 时改用一次性新建 + 记录真实 ID，恢复窗口内禁止自动轮换',
    });
    const flush = shapeOf(host.sessions, ['flush']);
    results.push({
        id: 'seed-delivery-receipt',
        shape: flush.shape === 'ok' && host.sessionController !== undefined ? 'ok' : 'missing',
        evidence: `${flush.evidence}；followup 与 sessions.flush 之间的回执口径需实测`,
        liveCheck: '投递启动消息后断开持久化，确认 flush 返回 false 而非 true，并被上层当作未落盘处理',
        degrade: '无回执 ⇒ 轮换停在 ACTIVATING/WAITING_RECOVERY，不宣称已启动',
    });
    const meter = shapeOf(host.tokenMeter, ['measure']);
    results.push({
        id: 'token-measure',
        shape: meter.shape,
        evidence: meter.evidence,
        liveCheck: '确认 measure 是否包含缓存读写桶，以及切换模型后是否立即反映新窗口',
        degrade: '缺 measure ⇒ 只信投影，判为 estimated 并在 UI 标注',
    });
    const compaction = { shape: 'missing', evidence: '本包不直接依赖 compaction 服务句柄' };
    results.push({
        id: 'compaction-coordination',
        shape: compaction.shape,
        evidence: compaction.evidence,
        liveCheck: '读取当前生效压缩口径（ratio/headroom/outputReserve）的公开路径；无公开路径即无法算 C',
        degrade: '算不出 C ⇒ 观察模式；轮换与压缩同时命中时先收口再兜底，记录本次未先轮换的原因（§10.2）',
    });
    const goals = shapeOf(host.goals, ['create']);
    results.push({
        id: 'goal-gate',
        shape: goals.shape,
        evidence: `${goals.evidence}；create 会同时 arm，disarm 是进程内状态`,
        liveCheck: 'TARGET_READY 阶段用预留 S2 调 goals.create，确认业务续跑没有提前入场',
        degrade: '无法把 goal 纳管 ⇒ S2 建好但不注入 goal，只投启动消息',
    });
    const subagents = shapeOf(host.subagents, ['start']);
    results.push({
        id: 'subagent-settle',
        shape: subagents.shape,
        evidence: `${subagents.evidence}；startContinuable 的可用性按 provider 不同，不能假定一致`,
        liveCheck: '分 provider 验证一次性子代理的取消、结算与冷恢复；确认父会话轮换前置条件可满足',
        degrade: '判定不了是否已停 ⇒ 延后父会话轮换，不伪造迁移（§7.2）',
    });
    const title = shapeOf(host.sessionTitle, ['rename']);
    results.push({
        id: 'history-protection',
        shape: title.shape,
        evidence: `${title.evidence}；rename 会向会话追加 session/title 事件，即"算改会话"`,
        liveCheck: '确认退役 S1 的只读投影不会触发任何 append；重开旧会话时展示当前执行位置',
        degrade: '保护不了就只对 S2 改名，S1 一律不写（§10.5）',
    });
    const schedule = shapeOf(host.schedule, ['list', 'update']);
    results.push({
        id: 'schedule-migration',
        shape: schedule.shape,
        evidence: `${schedule.evidence}；按 sessionId 寻址的既有任务需迁移或停用`,
        liveCheck: '把一条定时任务从 S1 迁到 S2，确认到期解析的是新的当前绑定',
        degrade: '未能安全处理 ⇒ 阻止该会话自动轮换',
    });
    // 字段口径已由本机源码确认（`core/agent/src/types.ts:78` `TurnBoundaryProjection`：
    // `openTurnStartSeq / lastStepStartSeq / lastStepBoundary{kind,seq} / lastTurn`）。
    // 仍判 partial 的原因不是"不知道字段"，而是 §10.2 的两条运行事实只能在真会话上核对：
    // 读到的是否为**当前**状态、以及 `lastTurn` 与 `turn/end` 事件是否同刻一致。
    const turnBoundary = host.sessionProjections === undefined
        ? { shape: 'missing', evidence: 'sessionProjections 未装载，读不到 turnBoundary' }
        : { shape: 'partial', evidence: "stateOf 可用；'turnBoundary' 字段口径已确认（lastTurn/openTurnStartSeq/lastStepBoundary），但未在真会话上与 turn/end 对账" };
    results.push({
        id: 'turn-boundary',
        shape: turnBoundary.shape,
        evidence: turnBoundary.evidence,
        liveCheck: '读 stateOf(session,\'turnBoundary\').lastTurn，与轮末观察到的 turn/end 序号对账；注意 step/start|step/end 也会动 lastStepBoundary，轮次只用 lastTurn',
        degrade: '核对不了 ⇒ 轮换只在显式 /continuity rotate 时执行，自动侧只出观察数据（§10.1）；确认核对过可由操作者打开 probesAcknowledged',
    });
    const toolGuardShape = shapeOf(host.tools, ['guard']);
    results.push({
        id: 'tool-guard-coverage',
        shape: toolGuardShape.shape,
        evidence: `${toolGuardShape.evidence}；guard 是同步单向拒绝，覆盖不到异步准备，且受管工具集合需实测`,
        liveCheck: '注册一个恒拒绝的 guard，确认它拦得住写文件/终端而不拦只读诊断与 cancel',
        degrade: '覆盖不明 ⇒ enforceAdmission 保持关闭，准入只体现在会话闸门与台账，不用 guard 误伤正常干活（§12.2）',
    });
    // §16 待验证第 6 项：交接包与插件注入的上下文，最终是不是会话真正看到的那一份。
    // 结构面能查的只有"能不能读回会话的消息页与 preset"；三处是否同源只能实测。
    const page = shapeOf(host.sessionController, ['page']);
    const record = shapeOf(host.sessions, ['get']);
    results.push({
        id: 'context-assembly',
        shape: page.shape === 'ok' && record.shape === 'ok' ? 'partial' : 'missing',
        evidence: `sessionController.page ${page.evidence}；sessions.get ${record.evidence}；系统提示由 preset 组装、插件上下文走启动消息，两条路是否都进最终请求需实测`,
        liveCheck: '轮换后读回 S2 的消息页与 system prompt 组装结果，确认交接包只出现一次、且内容与发出的那份一致（不漏段、不重复、不带旧版本）',
        degrade: '核对不了 ⇒ 交接包只按"已投递"记账，不宣称模型已理解；context.record 的 completeness 一律按 partial 登记（§22.3 DG-03）',
    });
    // §16 待验证第 9 项：人类输入、目标修订与轮换提交三者并发时的路由与顺序。
    results.push({
        id: 'concurrent-input-routing',
        shape: host.sessionController?.resolveAgent === undefined ? 'missing' : 'partial',
        evidence: 'pre-step 钩子与 latch 在同一进程内串行，但 `mission.revise` 与 `rotation COMMITTED` 之间的先后取决于命令队列与宿主事件次序，静态查不出来',
        liveCheck: '在等待边界期间改目标并向 S1 输入：确认修订后旧票据失效、输入改道到 S2、且没有一条步骤在旧目标下继续执行',
        degrade: '顺序不可证 ⇒ 轮换只在无未裁修订时提交（safeToHandoff 的票据核对），人类输入遇提交点一律转 S2 并在台账留痕（§7.3、§10.5）',
    });
    // §16 待验证第 8 项：同一存储域被两个 Host 写、或 S2 落到别的 workspace。
    // 结构面只查得到"能不能读到会话的 cwd"；独占锁与路径规范化只能在真机核对。
    results.push({
        id: 'workspace-isolation',
        shape: record.shape === 'ok' ? 'partial' : 'missing',
        evidence: `会话头部可读（sessions.get ${record.shape}），cwd 取自持久 header 而非 process.cwd()；Windows 独占运行锁与路径规范化口径未在本包验证`,
        liveCheck: '同机起两个 Host 指向同一 DSH_HOME 写同一存储域，确认不会互相覆盖；再验证 S2 的 cwd 与 S1 逐字一致（含大小写与分隔符）',
        degrade: '取不到或比不上 ⇒ 该会话不换（runRotation 在 cwd 缺失时直接返回失败），多实例部署由操作者保证单写（§5.2、§10.5）',
    });
    return results;
}
/** 自动执行模式的能力门禁。 */
export function gateAutomation(results) {
    const blocking = results.filter((item) => BLOCKING.includes(item.id) && item.shape !== 'ok').map((item) => `${item.id}:${item.shape}`);
    return { allowed: blocking.length === 0, blocking };
}
export function formatReport(results) {
    return results.map((item) => `[${item.shape.toUpperCase()}] ${item.id} — ${item.evidence}\n  需实测：${item.liveCheck}\n  退化：${item.degrade}`).join('\n');
}
