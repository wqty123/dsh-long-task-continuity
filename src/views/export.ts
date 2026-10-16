/**
 * 派生视图（设计稿 v0.3 §5.2–§5.3、§15.2、§22.18 DG-18：视图是投影，不是第二权威）。
 *
 * 约束：
 * 1. **只读派生**：这里没有写路径，控制记录是唯一真源；视图删了可重建，重建不出新事实。
 * 2. **确定性**：排序一律用显式 id 键；projectionRevision 由 `revision + basisRevision` 确定性地
 *    派生，时间只单独作为 generatedAt 显示（取记录自带的 lastCommittedAt，不取墙钟），
 *    因此同一状态两次渲染逐字节相同，且不会出现"同样状态渲染出不同视图 revision"。
 * 3. **不判定**：freshness、判据证明、承诺闭环、交付处理、检索范围限定语等全部调用
 *    `discipline.ts` 的现成函数，视图只负责排版输出。
 * 4. **不写盘**：本模块返回"文件名 → 内容"，落不落、落到哪由适配层按设置决定。
 * 5. **失效版本不冒充当前状态**（§22.18）：`validity !== 'current'` 的任务/产物/结论显式标注，
 *    并从"当前已完成"计数剔除；历史事件仍可回看。技术细节按 §15.2 收进诊断页，用户视图只放标识。
 * 6. **贴合 DSH 原生呈现**（用户 2026-10-14 约束）：本模块只产 CommonMark 纯文本，不嵌 HTML/CSS/ANSI，
 *    颜色与版式一律交给 DSH 自己的 Markdown 渲染管线——不造第二套视觉。后续若做 Web 客户端界面
 *    （独立 client 包）：颜色只用 ui-theme 语义 token（`--dsw-alias-*`），组件先复用 ui-primitives，
 *    工具卡片经 `tool.call.toolview` keyed slot 注册，命令面经 `ctx.commandUi` 注册；规范书为本机
 *    `D:\deepseek-harness\docs\web-styling.zh.md` 与 `docs\ui-radius.zh.md`（v0.2.1-alpha.1 已核）。
 */
import type { ControlEvent, MissionControl } from '../core/control.ts'
import type { ArchiveSnapshot } from '../core/archive.ts'
import type { RecoveryReport } from '../core/recovery.ts'
import type { Criterion, MailboxMessage, SourceCategory, Task, Validity } from '../core/entities.ts'
import { ATTEMPT_TERMINAL } from '../core/entities.ts'
import { recentRotations } from '../core/budget.ts'
import {
  criteriaReport,
  deliveryIsProcessed,
  ineffectiveClaimRefs,
  latestClaim,
  openObligations,
  supportsAbsenceClaim,
} from '../core/discipline.ts'
// v0.5 §25–§35 读侧：本视图只调用各模块的现成读函数拼版式，不复制判断逻辑。
import { conjectureView, experimentHead, explorationEntitlement, explorationPulse, taskWorkKind } from '../core/experiment.ts'
import { environmentGaps, resumeIsCurrent, validUntilFor } from '../core/environment.ts'
import { assessBenefit, breakerFor, exitVerdict, governanceCostOf, mechanismHead, mechanismSpend } from '../core/governance.ts'
import type { AssessmentFrame } from '../core/context-quality.ts'
import { assessmentIsCurrent, validateAssessment } from '../core/context-quality.ts'
import { outcomeReviewRequired } from '../core/outcome.ts'
import { integrationReceiptCurrent } from '../core/integration.ts'
import { assessBriefFreshness, assessCoverage } from '../core/records.ts'

const PLACEHOLDER = '（无）'

function stamp(value: number): string {
  return new Date(value).toISOString()
}

function maybeStamp(value: number | undefined): string {
  return value === undefined ? '' : stamp(value)
}

function list(items: readonly string[]): string {
  return items.length === 0 ? PLACEHOLDER : items.map((item) => `- ${item}`).join('\n')
}

/** 确定性排序：不依赖对象插入顺序，保证同一状态逐字节一致。 */
function sortedValues<T>(record: Readonly<Record<string, T>>, idOf: (value: T) => string): T[] {
  return Object.values(record).sort((a, b) => idOf(a).localeCompare(idOf(b)))
}

/** Markdown 表格单元格：竖线与换行会破坏表格结构。 */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return PLACEHOLDER
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n')
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`
}

// —— 视图元数据（§22.18 DG-18）——

function projectionRevisionOf(state: MissionControl): string {
  // 用 revision+basisRevision 组合出确定性的投影标识；不引入随机数或墙钟。
  return `r${state.revision}b${state.basisRevision}`
}

function freshnessOf(state: MissionControl): { readonly label: 'current' | 'stale' | 'unknown'; readonly detail: string } {
  // 待传播项未收敛时不猜新旧：失效还在扩散，视图既不是 current 也谈不上最终 stale。
  if (state.pendingPropagations.length > 0) {
    return { label: 'unknown', detail: `${state.pendingPropagations.length} 项失效待传播，视图尚未收敛` }
  }
  // 结论链头存在 needs_review/invalid ⇒ basisRevision 已变，视图忠于的状态本身已过期。
  const ineffective = ineffectiveClaimRefs(state)
  if (ineffective.length > 0) {
    return { label: 'stale', detail: `依据修订 ${state.basisRevision} 已变，失效结论：${ineffective.join('、')}` }
  }
  return { label: 'current', detail: `依据修订 ${state.basisRevision}，无待传播项与失效结论` }
}

/** 每份导出顶部的元数据块（DG-18：视图保存 sourceRevision / projectionRevision / freshness）。 */
function viewHeader(state: MissionControl, title: string): string[] {
  const freshness = freshnessOf(state)
  const openOutbox = Object.values(state.outbox).filter((entry) => entry.completedAt === undefined).length
  const archived = Object.entries(state.archivedCounts).sort((a, b) => a[0].localeCompare(b[0]))
  const archivedTotal = archived.reduce((sum, [, count]) => sum + count, 0)
  return [
    `# ${title} Mission ${state.missionId}`,
    '',
    `- sourceRevision：${state.revision}（控制记录修订；本文件只是它的投影，不是第二权威）`,
    `- projectionRevision：${projectionRevisionOf(state)}`,
    `- freshness：${freshness.label}（${freshness.detail}）`,
    `- generatedAt：${stamp(state.lastCommittedAt)}`,
    ...(archivedTotal === 0
      ? []
      : [`- 收敛说明：本视图已收敛 ${archivedTotal} 条已闭合记录，不是全量历史（§5.3）：${archived.map(([name, count]) => `${name}=${count}`).join('、')}`]),
    ...archiveCoverageLines(state),
    ...(openOutbox === 0 ? [] : [`- 更新中：outbox 积压 ${openOutbox} 项未结算，视图可能滞后，请回读内核（§22.18）`]),
    '',
  ]
}

/**
 * 归档水位与落档凭据（审阅 R4）：说清"少掉的这部分在台账的哪里"，
 * 而不是只报一个收敛计数——计数证明不了历史还在。
 */
function archiveCoverageLines(state: MissionControl): string[] {
  const lines: string[] = []
  const watermark = state.archive
  if (watermark !== undefined && watermark.batchCount > 0) {
    lines.push(
      `- 事件归档水位：seq ≤ ${watermark.throughSeq} 已落档 ${watermark.batchCount} 批（最新 ${watermark.lastBatchId}，内容 ${watermark.lastContentHash.slice(0, 16)}，位置 ${watermark.lastLocation}）`,
    )
  }
  const receipt = state.recordArchive
  if (receipt !== undefined) {
    const counted = Object.entries(receipt.counts)
      .filter(([, count]) => count > 0)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => `${name}=${count}`)
      .join('、')
    lines.push(`- 记录落档凭据：批次 ${receipt.batchId}（${counted}，位置 ${receipt.location}）——只有这批对象被移出热状态`)
  }
  return lines
}

/** 失效版本不得冒充当前状态（§22.18）：表里显式标注，历史引用仍可回看。 */
function validityMark(validity: Validity): string {
  return validity === 'current' ? 'current' : `${validity}（已从当前状态剔除）`
}

function criteriaTable(criteria: readonly Criterion[]): string {
  return table(
    ['判据', '文本', '必需', '适用性规则'],
    criteria.map((criterion) => [criterion.criterionId, criterion.text, criterion.required ? '必需' : '可选', criterion.applicabilityRule ?? '']),
  )
}

function criteriaText(task: Task): string {
  return task.criteria.map((criterion) => `${criterion.criterionId}：${criterion.text}${criterion.required ? '' : '（可选）'}`).join('；')
}

/** 确定性任务顺序：优先级升序，同优先级按 id。 */
function orderedTasks(state: MissionControl): Task[] {
  return sortedValues(state.tasks, (task) => task.taskId).sort((a, b) => a.priority - b.priority || a.taskId.localeCompare(b.taskId))
}

function reportRows(state: MissionControl): readonly { readonly task: Task; readonly report: ReturnType<typeof criteriaReport> }[] {
  return orderedTasks(state).map((task) => ({ task, report: criteriaReport(state, task) }))
}

/** 未决事项：在途操作、outbox 积压、未投递/未处理的信箱与交付（§22.14）。 */
function openItemLines(state: MissionControl): string[] {
  const unsettledOps = Object.values(state.operations).filter((op) => op.status === 'intent' || op.status === 'executing' || op.status === 'outcome_unknown')
  const openOutbox = Object.values(state.outbox).filter((entry) => entry.completedAt === undefined)
  const unprocessedDeliveries = sortedValues(state.deliveries, (d) => d.deliveryId).filter((d) => !deliveryIsProcessed(d))
  return [
    ...unsettledOps.map((op) => `操作 ${op.operationId}（${op.kind} → ${op.target}）状态 ${op.status}`),
    ...openOutbox.map((entry) => `outbox ${entry.outboxId}（${entry.kind}）第 ${entry.attempts} 次${entry.lastError === undefined ? '' : `：${entry.lastError}`}`),
    ...sortedValues(state.mailbox, (m) => m.messageId)
      .filter((m) => m.state === 'pending' || m.state === 'undeliverable' || m.handling === 'unprocessed')
      .map(mailboxLine),
    ...unprocessedDeliveries.map(
      (d) =>
        `交付 ${d.deliveryId} ${d.senderActorId}→${d.recipientActorId} stage=${d.stage} handling=${d.handling} 待处理（§22.14）${d.failureReason === undefined ? '' : `：${d.failureReason}`}`,
    ),
  ]
}

/** 收口缺口：判据未证明、有效性剔除、承诺未闭环、失效结论与待传播项。 */
function gapLines(state: MissionControl, reports: readonly { readonly task: Task; readonly report: ReturnType<typeof criteriaReport> }[]): string[] {
  const gaps: string[] = []
  for (const { task, report } of reports) {
    if (task.status === 'submitted' || task.status === 'verifying' || task.status === 'completed') {
      if (!report.satisfied) gaps.push(`${task.taskId}（${task.status}）：${report.blockers.join('；')}`)
    }
    if (task.status === 'completed' && task.validity !== 'current') {
      gaps.push(`${task.taskId} 状态为 completed 但有效性 ${task.validity}，已从当前完成计数剔除（§22.18）`)
    }
  }
  const openOb = openObligations(state)
  if (openOb.length > 0) gaps.push(`${openOb.length} 条承诺未闭环：${openOb.map((o) => `${o.obligationId}(${o.stage})`).join('、')}`)
  const ineffective = ineffectiveClaimRefs(state)
  if (ineffective.length > 0) gaps.push(`失效结论不得支撑收口：${ineffective.join('、')}`)
  if (state.pendingPropagations.length > 0) {
    gaps.push(`${state.pendingPropagations.length} 项失效待传播：${state.pendingPropagations.map((p) => `${p.propagationId}→${p.targetKind}:${p.targetId}`).join('、')}`)
  }
  const unprocessedDeliveries = sortedValues(state.deliveries, (d) => d.deliveryId).filter((d) => !deliveryIsProcessed(d))
  if (unprocessedDeliveries.length > 0) gaps.push(`${unprocessedDeliveries.length} 件交付未处理（§22.14）：${unprocessedDeliveries.map((d) => d.deliveryId).join('、')}`)
  const withdrawalPending = Object.values(state.artifacts).flat().filter((item) => item.withdrawalPending)
  if (withdrawalPending.length > 0) gaps.push(`已发布产物待撤回：${withdrawalPending.map((a) => `${a.artifactId}@${a.version}`).join('、')}（§22.6）`)
  return gaps
}

// —— 主台账（Mission 概览）——

export function renderMissionMarkdown(state: MissionControl): string {
  const tasks = orderedTasks(state)
  const reports = reportRows(state)
  const completed = tasks.filter((task) => task.status === 'completed')
  const completedNow = completed.filter((task) => task.validity === 'current')
  const gaps = gapLines(state, reports)

  return [
    ...viewHeader(state, 'Mission 台账'),
    `- 状态：${state.mission.status}${state.mission.waitingReason === undefined ? '' : `（${state.mission.waitingReason}）`}`,
    `- 下一步：${nextStepLine(state)}`,
    `- 目标（修订 ${state.mission.objectiveRevision}）：${state.mission.objective}`,
    ...(state.mission.outcome === undefined
      ? []
      : [`- 目标效用：${state.mission.outcome.intendedUse}；效果观测：${state.mission.outcome.effectObservation.state}`]),
    `- 规则快照修订：${state.mission.policyRevision}；依据有效性修订：${state.basisRevision}`,
    `- 协作模式：${state.mission.collaboration}；权限引用：${state.mission.permissionRef}`,
    `- 预算依据：${state.mission.budgetBasis.kind}（${state.mission.budgetBasis.ref}）（§13）`,
    `- 控制记录：修订 ${state.revision}，最后提交 ${stamp(state.lastCommittedAt)}，业务入场 ${state.admissionClosed ? '关闭' : '开放'}`,
    `- 已完成任务：${completedNow.length} 条（按当前完成计${completed.length > completedNow.length ? `，已剔除 ${completed.length - completedNow.length} 条 validity 非 current，历史仍可回看，§22.18` : ''}）`,
    '',
    '## 约束',
    list(state.mission.constraints),
    '',
    '## 约束来源',
    list(state.mission.constraintSources),
    '',
    '## 完成判据',
    criteriaTable(state.mission.criteria),
    '',
    '## 任务',
    table(
      ['任务', '状态', '有效性', '优先级', '标题', '当前尝试', '任务书修订', '判据修订', '判据检查', '验收判据'],
      tasks.map((task) => [
        task.taskId,
        task.status,
        validityMark(task.validity),
        String(task.priority),
        task.title,
        task.currentAttemptId ?? '',
        String(task.specRevision),
        String(task.criteriaRevision),
        task.criteriaCheck,
        criteriaText(task),
      ]),
    ),
    '',
    '## 判据当前证明',
    list(reports.flatMap(({ task, report }) => report.proofs.map((proof) => `${task.taskId} ${proof.criterion.criterionId}：${proof.outcome}——${proof.reason}`))),
    '',
    '## 尝试与票据',
    // §15.2：用户视图只放 taskId/attemptId/leaseVersion/basisRevision，票据其余字段进诊断页。
    table(
      ['尝试', '任务', 'Actor', '状态', '租约版本', '租约到期', '票据依据修订'],
      sortedValues(state.attempts, (attempt) => attempt.attemptId).map((attempt) => [
        attempt.attemptId,
        attempt.taskId,
        attempt.actorId,
        attempt.status,
        String(attempt.leaseVersion),
        stamp(attempt.leaseExpiresAt),
        attempt.ticket === undefined ? '无票据' : String(attempt.ticket.basisRevision),
      ]),
    ),
    '',
    '## 预算',
    [
      `- 模型调用 ${state.budget.modelCalls} / ${state.budgetLimits.maxModelCalls}`,
      `- token ${state.budget.inputTokens + state.budget.outputTokens + state.budget.cacheReadTokens} / ${state.budgetLimits.maxTotalTokens}`,
      `- 墙钟 ${(state.budget.wallClockMs / 3600_000).toFixed(2)} 小时`,
      `- 任务重试 ${state.budget.taskRetries} / ${state.budgetLimits.maxTaskRetries}`,
      `- 轮换 ${state.budget.rotations}（每 Actor 每小时上限 ${state.budgetLimits.maxRotationPerHour}）`,
      `- 信箱消息 ${state.budget.mailboxMessages} / ${state.budgetLimits.maxMailboxMessages}`,
      `- 治理开销 ${state.budget.governanceCalls} 次 / ${state.budget.governanceTokens} token / ${(state.budget.governanceWallClockMs / 3600_000).toFixed(2)} 小时（§22.15 DG-15）`,
      `- 未结算预留 ${state.budget.reservations.length} 笔`,
    ].join('\n'),
    '',
    '## 执行权',
    renderActorRows(state),
    '',
    '## 未决事项',
    list(openItemLines(state)),
    '',
    '## 收口缺口',
    gaps.length === 0 ? '无：判据按当前版本已证明，承诺闭环，结论有效，交付已处理。' : list(gaps),
  ].join('\n')
}

/**
 * §15.2 任务页"下一步"：确定性来源优先级为
 * (a) 最新的非空 nextAction 检查点；(b) 优先级最高的 blocked 任务；(c) mission.waitingReason；
 * (d) 都没有就写"（无记录）"。只投影记录内容，找不到来源不编造。
 */
function nextStepLine(state: MissionControl): string {
  const checkpoints = sortedValues(state.checkpoints, (item) => item.checkpointId)
    .filter((item) => item.nextAction.trim().length > 0)
    .sort((a, b) => b.writtenAt - a.writtenAt || a.checkpointId.localeCompare(b.checkpointId))
  const latest = checkpoints[0]
  if (latest !== undefined) {
    return `${latest.nextAction}（${latest.taskId === undefined ? '' : `${latest.taskId} `}检查点 ${stamp(latest.writtenAt)}）`
  }
  const blocked = sortedValues(state.tasks, (task) => task.taskId)
    .filter((task) => task.status === 'blocked')
    .sort((a, b) => a.priority - b.priority || a.taskId.localeCompare(b.taskId))
  const first = blocked[0]
  if (first !== undefined) return `解除 ${first.taskId} 阻塞：${first.blockedReason ?? '未记录原因（§7.1）'}`
  if (state.mission.waitingReason !== undefined) return `等待（${state.mission.waitingReason}）`
  return '（无记录）'
}

/** 信箱行：投递状态与处理状态分列（§7.3），期限只显真实来源。 */
function mailboxLine(message: MailboxMessage): string {
  const target = message.targetKind === undefined ? '' : ` 目标=${message.targetKind}:${message.targetId}${message.targetRevision === undefined ? '' : `@${message.targetRevision}`}`
  const deadline = message.deadlineAt === undefined ? '' : ` 期限=${stamp(message.deadlineAt)}${message.deadlineSource === undefined ? '（来源未记录）' : `（来源 ${message.deadlineSource}）`}`
  return `信箱 ${message.messageId} ${message.fromActorId}→${message.toActorId}（${message.kind}）投递=${message.state} 处理=${message.handling}${target}${deadline}${message.handlingReason === undefined ? '' : `：${message.handlingReason}`}`
}

function renderActorRows(state: MissionControl): string {
  const actors = sortedValues(state.actors, (actor) => actor.actorId)
  if (actors.length === 0) return PLACEHOLDER
  return [
    '| Actor | 角色 | 绑定会话 | 绑定版本 | 可用 | 休眠 | 退役 | 近一小时轮换 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...actors.map((actor) => {
      const live = Object.values(state.attempts).filter((attempt) => attempt.actorId === actor.actorId && !ATTEMPT_TERMINAL.includes(attempt.status))
      return `| ${actor.actorId} | ${actor.role} | ${actor.sessionId ?? PLACEHOLDER} | ${actor.bindingVersion} | ${actor.available ? '是' : '否'}${live.length > 0 ? `（持有 ${live.map((a) => a.attemptId).join(', ')}）` : ''} | ${actor.dormant ? '是' : '否'} | ${actor.retired ? '是' : '否'} | ${recentRotations(actor, state.lastCommittedAt).length} |`
    }),
  ].join('\n')
}

/**
 * 交接时间线：热事件与归档事件按 seq 合并去重后，取最近 `limit` 条（默认 200）。
 *
 * 旧口径只在热数组完全为空时才用归档补位（复审 N4）：热窗口只要有一条记录，归档正文就永远进不了输出。
 * 现在统一合并展示，同一 seq 以热为准——热状态是当前提交的即时副本，归档批次是落档当时的快照。
 * 窗口说明如实给出热/档数量、显示区间与台账缺失范围；归档面缺席或完全不可用时绝不写"还没超过窗口"。
 */
export function renderTimelineMarkdown(state: MissionControl, limit = 200, archive?: ArchiveSnapshot): string {
  const bySeq = new Map<number, ControlEvent>()
  for (const event of state.events) bySeq.set(event.seq, event)
  for (const event of archive?.events ?? []) {
    if (!bySeq.has(event.seq)) bySeq.set(event.seq, event)
  }
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  const events = merged.slice(-limit)
  const body =
    events.length === 0
      ? '（尚无控制事件）'
      : events.map((event) => `- ${stamp(event.at)} #${event.seq} ${event.kind}${Object.entries(event.detail).map(([key, value]) => ` ${key}=${String(value)}`).join('')}`).join('\n')
  const interval =
    events.length === 0
      ? '显示区间：无事件'
      : `显示区间 seq ${events[0]!.seq}–${events.at(-1)!.seq}${merged.length > events.length ? `（更早仍有 ${merged.length - events.length} 条未显示）` : ''}`
  const windowNote =
    archive === undefined
      ? `回看窗口：热状态 ${state.events.length} 条（展示最近 ${events.length} 条）；${interval}；本部署没有归档读取面，热窗口外的事件不可回读。`
      : `回看窗口：热状态 ${state.events.length} 条（展示最近 ${events.length} 条），归档台账 ${archive.batches.length} 批 / ${archive.events.length} 条事件（仅采信，seq ≤ ${archive.archivedThroughSeq}）；${interval}；不可回读：${archive.unavailable.length === 0 ? '无' : archive.unavailable.join('；')}。`
  return [...viewHeader(state, '控制事件时间线'), windowNote, '', body].join('\n')
}

// —— v0.3 纪律与证据面视图（§5.1、§21–22 全集）——

export function renderDisciplineMarkdown(state: MissionControl): string {
  return [
    ...viewHeader(state, '纪律与证据视图'),
    section('承诺（§22.7 DG-07）：责任人、阶段、回执、阻塞原因与解除条件', obligationsBody(state)),
    '',
    section('质疑（§22.4 DG-04）：目标与版本、严重度、裁定者、裁定结果', challengesBody(state)),
    '',
    section('授权（§22.8 DG-08）：动作集合、对象范围、环境、额度与已消耗、撤销状态', grantsBody(state)),
    '',
    section('结论（§22.5–22.6 DG-05/06）：链头版本、状态、有效性与重入条件', claimsBody(state)),
    '',
    section('证据（§22.1 DG-01）：按来源类别显式分组', evidenceBody(state)),
    '',
    section('检索回执（§22.2 DG-02）：覆盖、分页、截断与结论边界', searchesBody(state)),
    '',
    section('上下文送达回执（§22.3 DG-03）：只证明送达与覆盖，不证明已理解', contextsBody(state)),
    '',
    section('验证器资格（§22.10 DG-10）：只针对已测版本、范围与样例', validatorsBody(state)),
    '',
    section('独立审查（§22.9 DG-09）：自洽、历史对照、增量与独立性限制', reviewsBody(state)),
    '',
    section('交付箱（§22.14 DG-14）：阶段与处理状态，未处理的显式列为待处理', deliveriesBody(state)),
    '',
    section('派单（§7.1）：版本三元组、范围、验收与矛盾发现', dispatchesBody(state)),
    '',
    section('事故与规则候选（§22.17 DG-17）：按触发条件与根因归类', incidentsBody(state)),
    '',
    section('规则（§21）：版本、强度、作用域、状态与收益统计', rulesBody(state)),
    '',
    section('产物（§22.6 DG-06）：版本链与有效性', artifactsBody(state)),
    '',
    section('依赖（§22.6 DG-06）：on-target 与被失效项', dependenciesBody(state)),
    '',
    section('待传播项（§22.6 DG-06）：还没收敛的下游工作项', propagationsBody(state)),
  ].join('\n')
}

/** 承诺单独成页：这是"欠着什么、谁负责、何时解除"的第一入口。 */
export function renderObligationsMarkdown(state: MissionControl): string {
  return [...viewHeader(state, '承诺清单视图'), section('承诺（§22.7 DG-07）', obligationsBody(state))].join('\n')
}

function obligationsBody(state: MissionControl): string {
  return table(
    ['承诺', '内容', '责任人', '阶段', '关联任务', '关联交付', '回执', '阻塞原因', '解除条件', '延后/取消依据'],
    sortedValues(state.obligations, (o) => o.obligationId).map((o) => [
      o.obligationId,
      o.statement,
      `${o.ownerActorId}（提出：${o.proposedBy}）`,
      o.stage,
      o.taskId ?? '',
      o.deliveryId ?? '',
      o.receiptRefs.join('；'),
      o.blockedReason ?? '',
      o.releaseCondition ?? '',
      o.stage === 'deferred' || o.stage === 'cancelled' ? `${o.decisionReason ?? '未记录原因'}（来源：${o.decisionSource ?? '未记录'}）` : '',
    ]),
  )
}

function challengesBody(state: MissionControl): string {
  return table(
    ['质疑', '目标', '目标修订', '引用文本', '严重度', '提出者', '裁定者', '结果', '裁定说明', '反证', '并入'],
    sortedValues(state.challenges, (c) => c.challengeId).map((c) => [
      c.challengeId,
      `${c.targetKind}:${c.targetId}`,
      c.targetRevision === undefined ? '' : String(c.targetRevision),
      c.quotedText,
      c.severity,
      c.raisedByActorId,
      c.adjudicatorActorId,
      c.outcome,
      c.resolution ?? '',
      c.contradictingEvidenceIds.join('；'),
      c.mergedInto ?? '',
    ]),
  )
}

function grantsBody(state: MissionControl): string {
  return table(
    ['授权', '来源', '动作集合', '对象范围', '环境', '可转授', '已用/额度（次）', '已耗/额度（token）', '到期', '撤销状态'],
    sortedValues(state.grants, (g) => g.grantId).map((g) => [
      g.grantId,
      `${g.source}（${g.sourceRef}）`,
      g.actions.join('、'),
      g.objectScope.join('；'),
      g.environment,
      g.delegatable ? '是' : '否',
      `${g.usedCount}${g.maxUses === undefined ? ' / 未设' : ` / ${g.maxUses}`}`,
      `${g.consumedTokens}${g.tokenQuota === undefined ? ' / 未设' : ` / ${g.tokenQuota}`}`,
      maybeStamp(g.expiresAt),
      g.revokedAt === undefined ? '未撤销' : `revoked@${stamp(g.revokedAt)}（${g.revokedReason ?? '原因未记录'}）`,
    ]),
  )
}

function claimsBody(state: MissionControl): string {
  const rows: string[][] = []
  for (const claimId of Object.keys(state.claims).sort()) {
    const chain = state.claims[claimId]
    if (chain === undefined) continue
    const head = latestClaim(state, claimId)
    if (head === undefined) continue
    rows.push([
      `${head.claimId}@${head.version}${chain.length > 1 ? `（链长 ${chain.length}，历史版本可回看）` : ''}`,
      head.proposition,
      head.status,
      validityMark(head.validity),
      head.sourceCategory,
      head.appliesUnder.join('；'),
      head.reentryConditions.join('；'),
      head.subject === undefined ? '' : `对象=${head.subject}${head.implementationVersion === undefined ? '' : `；版本=${head.implementationVersion}`}${head.inputCondition === undefined ? '' : `；输入=${head.inputCondition}`}${head.verifiedRange === undefined ? '' : `；范围=${head.verifiedRange}`}`,
      head.supportingEvidenceIds.join('；'),
      head.contradictingEvidenceIds.join('；'),
      head.retractedAt === undefined ? '' : `撤回于 ${stamp(head.retractedAt)}：${head.retractionReason ?? '原因未记录'}`,
    ])
  }
  return table(['结论', '命题', '状态', '有效性', '来源类别', '适用条件', '重入条件', '被测对象', '支持证据', '反证', '撤回'], rows)
}

const EVIDENCE_KIND_ORDER: readonly SourceCategory[] = ['observation', 'reported', 'inference', 'simulated', 'reference_bound', 'conjecture']
const EVIDENCE_KIND_LABEL: Readonly<Record<SourceCategory, string>> = {
  observation: 'observation（直接观测：真实执行结果栏）',
  reported: 'reported（执行者自报）',
  inference: 'inference（推断）',
  simulated: 'simulated（模拟/代理：绝不与真实执行结果同栏，§22.1 DG-01）',
  reference_bound: 'reference_bound（绑定引用来源）',
  conjecture: 'conjecture（猜想：允许缺支持证据，§22.8、§31）',
}

function evidenceBody(state: MissionControl): string {
  const items = sortedValues(state.evidence, (e) => e.evidenceId)
  if (items.length === 0) return PLACEHOLDER
  const blocks: string[] = []
  for (const kind of EVIDENCE_KIND_ORDER) {
    const members = items.filter((item) => item.kind === kind)
    if (members.length === 0) continue
    blocks.push(
      [
        `### 来源类别：${EVIDENCE_KIND_LABEL[kind]}`,
        '',
        table(
          ['证据', '摘要', '值', '指标', '单位', '聚合口径', '分母', '数据范围', '对象时点', '观测时点', '有效性', '来源'],
          members.map((e) => [
            e.evidenceId,
            e.summary,
            e.value ?? '',
            e.metricId ?? '',
            e.unit ?? '',
            e.aggregate ?? '',
            e.denominator ?? '',
            e.dataScope ?? '',
            e.objectTime === undefined ? '' : stamp(e.objectTime),
            stamp(e.observedAt),
            validityMark(e.validity),
            e.sourceRef,
          ]),
        ),
      ].join('\n'),
    )
  }
  return blocks.join('\n\n')
}

function searchesBody(state: MissionControl): string {
  return table(
    ['回执', '查询', '模式', '根路径', '覆盖', '已取页数', '还有更多', '被截断', '结果', '结论边界（现成判定）', '错误'],
    sortedValues(state.searches, (r) => r.receiptId).map((r) => [
      r.receiptId,
      r.query,
      r.mode,
      r.roots.join('；'),
      r.coverage,
      String(r.pagesFetched),
      r.hasMore ? '是' : '否',
      r.truncated ? '是' : '否',
      r.outcome,
      supportsAbsenceClaim(r).reason,
      r.errors.join('；'),
    ]),
  )
}

function contextsBody(state: MissionControl): string {
  const body = table(
    ['回执', 'Actor', '任务', '提供范围', '完整性', '缺口', '送达确认', '规则版本'],
    sortedValues(state.contexts, (r) => r.receiptId).map((r) => [
      r.receiptId,
      r.actorId,
      r.taskId ?? '',
      r.providedScope,
      r.completeness,
      r.gaps.join('；'),
      r.acknowledged ? '已确认送达（不等于已理解）' : '未确认',
      Object.entries(r.ruleVersions)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([ruleId, version]) => `${ruleId}@${version}`)
        .join('、'),
    ]),
  )
  return `${body}\n\n> 本节只证明送达与覆盖版本；"已确认"不等于"已理解"，"full" 也不证明语义被消化（§22.3 DG-03）。`
}

function validatorsBody(state: MissionControl): string {
  const rows: string[][] = []
  for (const validatorId of Object.keys(state.validators).sort()) {
    const chain = state.validators[validatorId]
    if (chain === undefined) continue
    const head = chain[chain.length - 1]
    if (head === undefined) continue
    rows.push([
      `${head.validatorId}@${head.version}`,
      head.name,
      head.inputType,
      head.scope,
      head.criteriaRevision === undefined ? '' : String(head.criteriaRevision),
      String(head.effectiveSampleIds.length),
      String(head.counterSampleIds.length),
      head.eligible ? '合格' : `不合格${head.qualificationReason === undefined ? '' : `：${head.qualificationReason}`}`,
      head.toleranceBasis ?? '',
      head.codeRef,
    ])
  }
  return `${table(['验证器', '名称', '输入类型', '范围', '判据版本', '正例样例数', '反例样例数', '资格状态', '容差依据', '代码引用'], rows)}\n\n> 资格只针对已测版本、范围与样例；换了判据版本或范围即失效（§22.10 DG-10）。`
}

function reviewsBody(state: MissionControl): string {
  return table(
    ['审查', '目标', '目标修订', '自洽性', '历史对照', '增量价值', '共享证据', '看过参考答案', '独立性限制', '审查者', '方法'],
    sortedValues(state.reviews, (r) => r.reviewId).map((r) => [
      r.reviewId,
      `${r.targetKind}:${r.targetId}`,
      r.targetRevision === undefined ? '' : String(r.targetRevision),
      r.selfConsistent,
      r.versusHistory,
      r.novelty ?? '',
      r.sharedEvidenceIds.join('；'),
      r.sawReferenceAnswer ? '是（独立性受限）' : '否',
      r.independenceNote,
      r.reviewerActorId,
      r.methodRef,
    ]),
  )
}

function deliveriesBody(state: MissionControl): string {
  // 待处理项排前面：这是收件方欠着的动作（§22.14 DG-14）。
  const items = sortedValues(state.deliveries, (d) => d.deliveryId).sort((a, b) => Number(deliveryIsProcessed(b)) - Number(deliveryIsProcessed(a)))
  return table(
    ['交付', '任务', '尝试', '发件方', '收件方', '阶段', '处理状态', '是否已处理', '失败原因', '产物', '证据'],
    items.map((d) => [
      d.deliveryId,
      d.taskId ?? '',
      d.attemptId ?? '',
      d.senderActorId,
      d.recipientActorId,
      d.stage,
      d.handling,
      deliveryIsProcessed(d) ? '已处理' : '待处理',
      d.failureReason ?? '',
      d.artifactRefs.join('；'),
      d.evidenceRefs.join('；'),
    ]),
  )
}

function dispatchesBody(state: MissionControl): string {
  return table(
    ['派单', '任务', '尝试', '派发者', '目标修订', '任务书修订', '判据修订', '问题', '范围', '排除项', '产物形态', '判据数', '授权引用', '前提证据/检索回执', '期限', '提交对象', '收件人', '矛盾发现'],
    sortedValues(state.dispatches, (d) => d.dispatchId).map((d) => [
      d.dispatchId,
      d.taskId,
      d.attemptId ?? '',
      d.issuerActorId,
      String(d.objectiveRevision),
      String(d.specRevision),
      String(d.criteriaRevision),
      d.question,
      d.scope,
      d.exclusions.join('；'),
      d.artifactForm,
      String(d.criteria.length),
      `${d.grantIds.length} 项（明细见诊断页，§15.2）`,
      `${d.premiseEvidenceIds.length} / ${d.searchReceiptIds.length}`,
      maybeStamp(d.deadlineAt),
      d.submitTo,
      d.deliveryRecipientActorId,
      d.contradictionFindings.map((f) => `${f.kind}：${f.detail}`).join('；'),
    ]),
  )
}

function incidentsBody(state: MissionControl): string {
  return table(
    ['事故', '失效模式', '触发条件', '根因', '候选规则', '修复类型', '影响', '恢复动作', '关联操作'],
    sortedValues(state.incidents, (i) => i.incidentId).map((i) => [
      i.incidentId,
      i.failureMode,
      i.triggerCondition,
      i.rootCause,
      i.candidateRuleIds.join('；'),
      i.fixKind,
      i.impact,
      i.recoveryActions.join('；'),
      i.operationRefs.join('；'),
    ]),
  )
}

const RULE_STATUS_LABEL: Readonly<Record<string, string>> = {
  candidate: 'candidate（候选，未生效，§21）',
  observing: 'observing（观察中，未生效，§21）',
  active: 'active（生效）',
  retired: 'retired（已退役）',
}

function rulesBody(state: MissionControl): string {
  const rows: string[][] = []
  for (const ruleId of Object.keys(state.rules).sort()) {
    const chain = state.rules[ruleId]
    if (chain === undefined) continue
    const head = chain[chain.length - 1]
    if (head === undefined) continue
    rows.push([
      `${head.ruleId}@${head.version}`,
      head.statement,
      RULE_STATUS_LABEL[head.status] ?? head.status,
      `${head.enforcement}${head.enforcement === 'advisory' ? '（仅提示，不能硬拒绝）' : head.disposition === 'deny' ? '（可硬拒绝）' : ''}`,
      head.scope,
      head.trigger,
      head.owner,
      `${head.stats.hits} 命中 / ${head.stats.misfires} 误报 / ${head.stats.misses} 漏报 / ${head.stats.costTokens} token`,
      head.supersedesVersion === undefined ? '' : String(head.supersedesVersion),
      head.retirementReason ?? '',
    ])
  }
  return `${table(['规则', '表述', '状态', '强度（处置）', '作用域', '触发', '责任人', '收益统计', '取代版本', '退役原因'], rows)}\n\n> candidate 与 observing 不进入生效快照；规则只按已证收益保留，数量不是可靠性（§21.4）。`
}

function artifactsBody(state: MissionControl): string {
  const items = Object.values(state.artifacts)
    .flat()
    .sort((a, b) => a.artifactId.localeCompare(b.artifactId) || a.version - b.version)
  const ineffectiveCount = items.filter((item) => item.validity !== 'current').length
  const body = table(
    ['产物', '版本', 'URI', '状态', '有效性', '已发布', '待撤回', '归属', '登记者', '内容哈希'],
    items.map((a) => [
      a.artifactId,
      String(a.version),
      a.uri,
      a.status,
      validityMark(a.validity),
      a.published ? '是' : '否',
      a.withdrawalPending ? '待撤回' : '',
      a.attribution,
      a.registeredBy,
      a.contentHash,
    ]),
  )
  return `${body}${ineffectiveCount === 0 ? '' : `\n\n> 其中 ${ineffectiveCount} 个版本有效性非 current，已剔除出当前状态；历史版本仍可回看（§22.18）。`}`
}

function dependenciesBody(state: MissionControl): string {
  // 被失效/待审的先排：这是需要动作的边（§22.6 DG-06）。
  const items = sortedValues(state.dependencies, (d) => d.dependencyId).sort(
    (a, b) => Number(b.reviewState !== 'ok') - Number(a.reviewState !== 'ok'),
  )
  const invalidated = items.filter((d) => d.reviewState === 'invalidated').length
  const body = table(
    ['依赖', 'target', '目标修订', 'on（依据）', '依据版本', '复核状态', '失效来源', '核对时间'],
    items.map((d) => [
      d.dependencyId,
      `${d.targetKind}:${d.targetId}`,
      d.targetRevision === undefined ? '' : String(d.targetRevision),
      `${d.onKind}:${d.onId}`,
      String(d.onVersion),
      d.reviewState,
      d.invalidatedBy ?? '',
      stamp(d.checkedAt),
    ]),
  )
  return `${body}${invalidated === 0 ? '' : `\n\n> ${invalidated} 条依赖已被失效，其下游需重验或重发（§22.6）。`}`
}

/** 待传播项（§22.6 DG-06）：撤回之后还没收敛的下游工作项，也是完成判定的硬缺口。 */
function propagationsBody(state: MissionControl): string {
  if (state.pendingPropagations.length === 0) return '无待传播项：已撤回依据的下游都复核或补发完了。'
  const items = state.pendingPropagations.slice().sort((a, b) => a.propagationId.localeCompare(b.propagationId))
  const body = table(
    ['传播项', '因果', '目标', '要求的动作', '排队时间'],
    items.map((item) => [item.propagationId, item.cause, `${item.targetKind}:${item.targetId}`, item.requiredAction, stamp(item.queuedAt)]),
  )
  return `${body}\n\n> 收敛口径：任务按当前判据复核通过、或在新依据下重新领票据，会自动收掉任务类条目；`
    + '产物登记新版本收掉"补证重发"，发布更正版收掉"撤回或发布更正"；'
    + '其余目标（检查点、派单、发布动作等）由 Supervisor 或用户按条裁定，代理不能自己抹平。'
}

// —— JSONL 与视图包 ——

interface JsonlRow {
  readonly collection: string
  readonly id: string
  readonly at: number
  readonly data: unknown
}

/** 事件行以归档为准：同一 seq 上台账优先，热窗口只补台账没有的部分。 */
function exportedEvents(state: MissionControl, archive: ArchiveSnapshot | undefined): readonly ControlEvent[] {
  if (archive === undefined) return []
  const bySeq = new Map<number, ControlEvent>()
  for (const event of archive.events) bySeq.set(event.seq, event)
  for (const event of state.events) if (!bySeq.has(event.seq)) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/** 导出覆盖面：本次导出的 seq 区间 + 热窗口区间 + 明确说不出来的部分。 */
function coverageOf(state: MissionControl, archive: ArchiveSnapshot | undefined, events: readonly ControlEvent[]) {
  const hotFrom = state.events[0]?.seq
  const hotTo = state.events.at(-1)?.seq
  const through = archive?.archivedThroughSeq ?? state.archive?.throughSeq ?? -1
  const unavailable: string[] = []
  if (archive === undefined) {
    unavailable.push('本次未接入归档台账：文件里没有控制事件历史，热窗口外的事件与已收敛记录需从归档表回读')
  } else {
    unavailable.push(...archive.unavailable)
  }
  if (hotFrom !== undefined && through + 1 < hotFrom) {
    unavailable.push(`事件 seq ${through + 1}–${hotFrom - 1} 既不在热窗口也没有可信归档`)
  }
  unavailable.push('实体行是当前聚合的收敛结果，不是各集合的全量历史')
  return {
    exportedSeqFrom: events[0]?.seq ?? hotFrom ?? null,
    exportedSeqTo: events.at(-1)?.seq ?? hotTo ?? null,
    hotSeqFrom: hotFrom ?? null,
    hotSeqTo: hotTo ?? null,
    archivedThroughSeq: through,
    archivedEventCount: archive?.events.length ?? 0,
    archivedBatchCount: state.archive?.batchCount ?? 0,
    eventRowsIncluded: archive !== undefined,
    unavailable,
  }
}

/** JSONL：每行一个实体（含 `collection` 字段），供外部工具（表格、审计脚本）消费。
 *
 * 覆盖面按 R4 如实声明，不再让"当前聚合"冒充全量历史：实体行是收敛后的**当前状态**；
 * 传入 `archive`（从归档台账读回的快照）时事件与批次行以台账为准，热窗口里剩下的补在后面。
 */
export function toJsonl(state: MissionControl, archive?: ArchiveSnapshot): string {
  const rows: JsonlRow[] = []
  const freshness = freshnessOf(state)
  const events = exportedEvents(state, archive)
  rows.push({
    collection: 'view_meta',
    id: state.missionId,
    at: state.lastCommittedAt,
    data: {
      sourceRevision: state.revision,
      projectionRevision: projectionRevisionOf(state),
      freshness: `${freshness.label}（${freshness.detail}）`,
      schemaVersion: state.schemaVersion,
      basisRevision: state.basisRevision,
      archivedCounts: state.archivedCounts,
      coverage: coverageOf(state, archive, events),
    },
  })
  if (archive !== undefined) {
    for (const batch of archive.batches) {
      rows.push({ collection: 'archive_batch', id: batch.batchId, at: batch.committedAt, data: batch })
    }
    for (const event of events) {
      rows.push({ collection: 'event', id: `${state.missionId}#${event.seq}`, at: event.at, data: event })
    }
  }
  rows.push({ collection: 'mission', id: state.missionId, at: state.mission.updatedAt, data: state.mission })
  for (const task of sortedValues(state.tasks, (t) => t.taskId)) rows.push({ collection: 'task', id: task.taskId, at: task.updatedAt, data: task })
  for (const attempt of sortedValues(state.attempts, (a) => a.attemptId)) rows.push({ collection: 'attempt', id: attempt.attemptId, at: attempt.updatedAt, data: attempt })
  for (const actor of sortedValues(state.actors, (a) => a.actorId)) rows.push({ collection: 'actor', id: actor.actorId, at: actor.updatedAt, data: actor })
  for (const team of sortedValues(state.teams, (t) => t.teamId)) rows.push({ collection: 'team', id: team.teamId, at: state.lastCommittedAt, data: team })
  for (const checkpoint of state.checkpointOrder.map((id) => state.checkpoints[id]).filter((item) => item !== undefined)) {
    rows.push({ collection: 'checkpoint', id: checkpoint.checkpointId, at: checkpoint.writtenAt, data: checkpoint })
  }
  for (const artifact of Object.values(state.artifacts).flat().sort((a, b) => a.artifactId.localeCompare(b.artifactId) || a.version - b.version)) {
    rows.push({ collection: 'artifact', id: `${artifact.artifactId}@${artifact.version}`, at: artifact.registeredAt, data: artifact })
  }
  for (const verification of sortedValues(state.verifications, (v) => v.verificationId)) rows.push({ collection: 'verification', id: verification.verificationId, at: verification.verifiedAt, data: verification })
  for (const message of sortedValues(state.mailbox, (m) => m.messageId)) {
    rows.push({ collection: 'mailbox', id: message.messageId, at: message.handledAt ?? message.acknowledgedAt ?? message.deliveredAt ?? state.lastCommittedAt, data: message })
  }
  for (const operation of Object.values(state.operations).sort((a, b) => a.operationId.localeCompare(b.operationId))) rows.push({ collection: 'operation', id: operation.operationId, at: operation.startedAt, data: operation })
  for (const rotation of Object.values(state.rotations).sort((a, b) => a.rotationId.localeCompare(b.rotationId))) rows.push({ collection: 'rotation', id: rotation.rotationId, at: rotation.updatedAt, data: rotation })
  for (const entry of sortedValues(state.outbox, (e) => e.outboxId)) rows.push({ collection: 'outbox', id: entry.outboxId, at: entry.completedAt ?? entry.availableAt, data: entry })
  for (const lease of state.resources.slice().sort((a, b) => a.key.localeCompare(b.key))) rows.push({ collection: 'resource', id: `${lease.key}#${lease.attemptId}`, at: lease.acquiredAt, data: lease })
  for (const rule of Object.values(state.rules).flat().sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.version - b.version)) {
    rows.push({ collection: 'rule', id: `${rule.ruleId}@${rule.version}`, at: rule.createdAt, data: rule })
  }
  for (const authority of sortedValues(state.authorities, (a) => a.bindingId)) rows.push({ collection: 'authority', id: authority.bindingId, at: authority.validFrom, data: authority })
  for (const evidence of sortedValues(state.evidence, (e) => e.evidenceId)) rows.push({ collection: 'evidence', id: evidence.evidenceId, at: evidence.observedAt, data: evidence })
  for (const claim of Object.values(state.claims).flat().sort((a, b) => a.claimId.localeCompare(b.claimId) || a.version - b.version)) {
    rows.push({ collection: 'claim', id: `${claim.claimId}@${claim.version}`, at: claim.createdAt, data: claim })
  }
  for (const dependency of sortedValues(state.dependencies, (d) => d.dependencyId)) rows.push({ collection: 'dependency', id: dependency.dependencyId, at: dependency.checkedAt, data: dependency })
  for (const obligation of sortedValues(state.obligations, (o) => o.obligationId)) rows.push({ collection: 'obligation', id: obligation.obligationId, at: obligation.updatedAt, data: obligation })
  for (const grant of sortedValues(state.grants, (g) => g.grantId)) rows.push({ collection: 'grant', id: grant.grantId, at: grant.createdAt, data: grant })
  for (const search of sortedValues(state.searches, (r) => r.receiptId)) rows.push({ collection: 'search', id: search.receiptId, at: search.observedAt, data: search })
  for (const context of sortedValues(state.contexts, (r) => r.receiptId)) rows.push({ collection: 'context', id: context.receiptId, at: context.createdAt, data: context })
  for (const challenge of sortedValues(state.challenges, (c) => c.challengeId)) rows.push({ collection: 'challenge', id: challenge.challengeId, at: challenge.createdAt, data: challenge })
  for (const incident of sortedValues(state.incidents, (i) => i.incidentId)) rows.push({ collection: 'incident', id: incident.incidentId, at: incident.createdAt, data: incident })
  for (const validator of Object.values(state.validators).flat().sort((a, b) => a.validatorId.localeCompare(b.validatorId) || a.version - b.version)) {
    rows.push({ collection: 'validator', id: `${validator.validatorId}@${validator.version}`, at: validator.createdAt, data: validator })
  }
  for (const review of sortedValues(state.reviews, (r) => r.reviewId)) rows.push({ collection: 'review', id: review.reviewId, at: review.reviewedAt, data: review })
  for (const delivery of sortedValues(state.deliveries, (d) => d.deliveryId)) rows.push({ collection: 'delivery', id: delivery.deliveryId, at: delivery.updatedAt, data: delivery })
  for (const dispatch of sortedValues(state.dispatches, (d) => d.dispatchId)) rows.push({ collection: 'dispatch', id: dispatch.dispatchId, at: dispatch.createdAt, data: dispatch })
  for (const propagation of state.pendingPropagations.slice().sort((a, b) => a.propagationId.localeCompare(b.propagationId))) {
    rows.push({ collection: 'propagation', id: propagation.propagationId, at: propagation.queuedAt, data: propagation })
  }
  return rows.map((row) => JSON.stringify(row)).join('\n')
}

/** 一个 Mission 的完整可重建视图包；`archive` 为从归档台账读回的快照，缺省时按热状态出并如实标注覆盖面。 */
export function viewBundle(state: MissionControl, archive?: ArchiveSnapshot): Readonly<Record<string, string>> {
  return {
    [`mission-${state.missionId}.md`]: renderMissionMarkdown(state),
    [`timeline-${state.missionId}.md`]: renderTimelineMarkdown(state, 200, archive),
    [`obligations-${state.missionId}.md`]: renderObligationsMarkdown(state),
    [`discipline-${state.missionId}.md`]: renderDisciplineMarkdown(state),
    [`ledger-${state.missionId}.jsonl`]: `${toJsonl(state, archive)}\n`,
  }
}

// —— Web 台账面板的结构化投影（同一真源、同一判定，只换成可 JSON 化的行）——

export interface MissionLedgerTaskRow {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly validity: string
  readonly priority: number
  readonly criteriaCheck: string
  readonly workKind: string
  readonly currentAttemptId: string
  readonly attemptCount: number
  readonly blockedReason: string
  readonly criteriaSatisfied: boolean
  readonly criteriaBlockers: readonly string[]
  readonly updatedAt: number
}

export interface MissionLedgerLeaseRow {
  readonly attemptId: string
  readonly taskId: string
  readonly actorId: string
  readonly actorRole: string
  readonly sessionId: string
  readonly status: string
  readonly leaseVersion: number
  /** 过期判定交给客户端的时钟：视图层不取墙钟（§22.18 DG-18）。 */
  readonly leaseExpiresAt: number
  readonly lastHeartbeatAt: number
  readonly hasTicket: boolean
  readonly retired: boolean
  readonly available: boolean
}

export interface MissionLedgerCheckpointRow {
  readonly checkpointId: string
  readonly taskId: string
  readonly actorId: string
  readonly step: string
  readonly nextAction: string
  readonly writtenAt: number
  readonly blockers: readonly string[]
  readonly openQuestions: readonly string[]
}

export interface MissionLedgerResourceRow {
  readonly key: string
  readonly taskId: string
  readonly attemptId: string
  readonly mode: string
  readonly acquiredAt: number
}

export interface MissionLedger {
  readonly missionId: string
  readonly sourceRevision: number
  readonly projectionRevision: string
  readonly basisRevision: number
  readonly generatedAt: number
  readonly freshness: 'current' | 'stale' | 'unknown'
  readonly freshnessDetail: string
  readonly admissionClosed: boolean
  readonly status: string
  readonly waitingReason: string
  readonly objective: string
  readonly objectiveRevision: number
  readonly policyRevision: number
  readonly collaboration: string
  readonly leadActorId: string
  readonly nextStep: string
  readonly completedNow: number
  readonly completedTotal: number
  readonly taskTotal: number
  readonly tasks: readonly MissionLedgerTaskRow[]
  readonly leases: readonly MissionLedgerLeaseRow[]
  readonly checkpoints: readonly MissionLedgerCheckpointRow[]
  readonly resources: readonly MissionLedgerResourceRow[]
  readonly openItems: readonly string[]
  readonly gaps: readonly string[]
}

/** 台账面板的一次读取投影：与 `renderMissionMarkdown` 共用同一批判定，不新增权威。 */
export function missionLedger(state: MissionControl, checkpointLimit = 6): MissionLedger {
  const tasks = orderedTasks(state)
  const reports = reportRows(state)
  const reportOf = new Map(reports.map(({ task, report }) => [task.taskId, report]))
  const completed = tasks.filter((task) => task.status === 'completed')
  const completedNow = completed.filter((task) => task.validity === 'current')
  const freshness = freshnessOf(state)
  const actors = sortedValues(state.actors, (actor) => actor.actorId)
  const actorOf = (actorId: string) => actors.find((actor) => actor.actorId === actorId)

  return {
    missionId: state.missionId,
    sourceRevision: state.revision,
    projectionRevision: projectionRevisionOf(state),
    basisRevision: state.basisRevision,
    generatedAt: state.lastCommittedAt,
    freshness: freshness.label,
    freshnessDetail: freshness.detail,
    admissionClosed: state.admissionClosed,
    status: state.mission.status,
    waitingReason: state.mission.waitingReason ?? '',
    objective: state.mission.objective,
    objectiveRevision: state.mission.objectiveRevision,
    policyRevision: state.mission.policyRevision,
    collaboration: state.mission.collaboration,
    leadActorId: state.mission.leadActorId ?? '',
    nextStep: nextStepLine(state),
    completedNow: completedNow.length,
    completedTotal: completed.length,
    taskTotal: tasks.length,
    tasks: tasks.map((task) => {
      const report = reportOf.get(task.taskId)
      return {
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        validity: task.validity,
        priority: task.priority,
        criteriaCheck: task.criteriaCheck,
        workKind: task.workKind ?? '',
        currentAttemptId: task.currentAttemptId ?? '',
        attemptCount: task.attemptCount,
        blockedReason: task.blockedReason ?? '',
        criteriaSatisfied: report === undefined ? false : report.satisfied,
        criteriaBlockers: report === undefined ? [] : report.blockers,
        updatedAt: task.updatedAt,
      }
    }),
    leases: sortedValues(state.attempts, (attempt) => attempt.attemptId)
      .filter((attempt) => !ATTEMPT_TERMINAL.includes(attempt.status))
      .map((attempt) => {
        const actor = actorOf(attempt.actorId)
        return {
          attemptId: attempt.attemptId,
          taskId: attempt.taskId,
          actorId: attempt.actorId,
          actorRole: actor === undefined ? '' : actor.role,
          sessionId: attempt.sessionId ?? actor?.sessionId ?? '',
          status: attempt.status,
          leaseVersion: attempt.leaseVersion,
          leaseExpiresAt: attempt.leaseExpiresAt,
          lastHeartbeatAt: attempt.lastHeartbeatAt,
          hasTicket: attempt.ticket !== undefined,
          retired: actor === undefined ? false : actor.retired,
          available: actor === undefined ? false : actor.available,
        }
      }),
    checkpoints: sortedValues(state.checkpoints, (item) => item.checkpointId)
      .sort((a, b) => b.writtenAt - a.writtenAt || a.checkpointId.localeCompare(b.checkpointId))
      .slice(0, checkpointLimit)
      .map((item) => ({
        checkpointId: item.checkpointId,
        taskId: item.taskId ?? '',
        actorId: item.actorId,
        step: item.step,
        nextAction: item.nextAction,
        writtenAt: item.writtenAt,
        blockers: item.blockers,
        openQuestions: item.openQuestions,
      })),
    resources: state.resources
      .slice()
      .sort((a, b) => a.key.localeCompare(b.key) || a.attemptId.localeCompare(b.attemptId))
      .map((lease) => ({ key: lease.key, taskId: lease.taskId, attemptId: lease.attemptId, mode: lease.mode, acquiredAt: lease.acquiredAt })),
    openItems: openItemLines(state),
    gaps: gapLines(state, reports),
  }
}

/** 冷恢复报告：把"哪些操作需要核对、哪些会话被扣住"讲成人话（§11.1）。 */
export function renderRecoveryMarkdown(reports: readonly RecoveryReport[]): string {
  if (reports.length === 0) return '冷恢复：没有需要核对的 Mission。'
  return reports
    .map((report) =>
      [
        `## Mission ${report.missionId}（修订 ${report.revision}）`,
        `- 是否自动重启：${report.autoResumeAllowed ? '允许' : '不允许（需显式恢复）'}`,
        `- 业务入场：${report.readyForAdmission ? '可开放' : '保持关闭'}`,
        `- 在途外部操作：${report.inFlightOperations.length === 0 ? '无' : report.inFlightOperations.join(', ')}`,
        `- 租约过期的尝试：${report.staleAttempts.length === 0 ? '无' : report.staleAttempts.join(', ')}`,
        ...report.openRotations.map((rotation) => `- 轮换 ${rotation.rotationId} 停在 ${rotation.phase}${rotation.nextReconcileAction === undefined ? '' : `，核对动作：${rotation.nextReconcileAction}`}`),
        `- outbox 积压：${report.outboxBacklog}`,
        ...(report.blockers.length === 0 ? [] : ['- 阻塞：', ...report.blockers.map((blocker) => `  - ${blocker}`)]),
      ].join('\n'),
    )
    .join('\n\n')
}

// ————————————————————————————————————————————————————————————————
// v0.5 §25–§35 面视图：工作与探索、记录、环境、治理、效用与整合。
//
// 与既有页同一套约束：只读派生、显式 id 排序、失效版本显式标注、不判定。
// 本区的每一项判定都调用各模块的读侧函数（assessCoverage / assessBriefFreshness /
// environmentGaps / resumeIsCurrent / mechanismSpend / assessBenefit / exitVerdict / breakerFor /
// validateAssessment / assessmentIsCurrent / integrationReceiptCurrent /
// outcomeReviewRequired / conjectureView / explorationPulse / taskWorkKind），视图层只负责排版。
// 与墙钟有关的读函数（explorationPulse / resumeIsCurrent）统一以 `lastCommittedAt` 为基准，
// 保证同一状态两次渲染逐字节相同（约束 2）。
// ————————————————————————————————————————————————————————————————

const WORK_KIND_ORDER: readonly string[] = ['improve', 'explore', 'validate', 'deliver']

/** §25.2 任务工作分类：只影响调度与额度，不改任务状态机。 */
function workKindsBody(state: MissionControl): string {
  const tasks = sortedValues(state.tasks, (task) => task.taskId)
  const counts: Record<string, number> = { improve: 0, explore: 0, validate: 0, deliver: 0, 未分类: 0 }
  const rows = tasks.map((task) => {
    const kind = taskWorkKind(state, task.taskId)
    counts[kind ?? '未分类'] = (counts[kind ?? '未分类'] ?? 0) + 1
    const quota = explorationEntitlement(state, task.taskId)
    return [task.taskId, task.status, kind ?? '未分类', quota.drawsOnReservation ? '占探索预留（§25.2）' : '常规预算']
  })
  const summary = [...WORK_KIND_ORDER, '未分类'].map((kind) => `${kind}=${counts[kind] ?? 0}`).join('、')
  return `${table(['任务', '状态', '工作分类', '额度口径'], rows)}\n\n> 分类只服务调度与额度，不创建新的执行状态机（§25.2）。合计：${summary}`
}

/** §25.2、§31.4 探索策略：预留份额、止损点、释放记录与 wildcard 使用情况。 */
function explorationBody(state: MissionControl): string {
  const pulse = explorationPulse(state, state.lastCommittedAt)
  const wildcard = pulse.wildcardAllowance
  return list([
    `探索预留：${pulse.configured ? `已启用（reserveShare=${pulse.reserveShare ?? '未设'}）` : '未启用（缺省即无预留，一次性修复不强迫为创新再试一条路线，§25.2）'}`,
    `预留状态：${pulse.configured ? (pulse.released ? `已释放${pulse.releasedAt === undefined ? '' : `@${stamp(pulse.releasedAt)}`}（${pulse.releaseReason ?? '未写理由'}）；复核条件：${pulse.releaseRecheck ?? '未写'}` : '有效') : '不适用'}`,
    `截止时间：${pulse.deadlineAt === undefined ? '未设' : `${stamp(pulse.deadlineAt)}${pulse.deadlinePassed ? '（已过：复核继续 / 释放 / 收尾）' : ''}`}`,
    `复核触发器：${pulse.reviewTriggers.length === 0 ? '未设' : pulse.reviewTriggers.join('；')}`,
    `wildcard 探测机会：${wildcard === undefined ? '未设额度' : `${wildcard.tokens ?? '—'} token / ${wildcard.calls ?? '—'} 调用（${wildcard.note}）`}；已用：${pulse.wildcardExperimentIds.length === 0 ? '无' : pulse.wildcardExperimentIds.join('、')}`,
    `复核结论：${pulse.reason}`,
  ])
}

/** §25.3 试验契约：当前版本阶段、版本数、wildcard 标记与停止条件数。 */
function experimentsBody(state: MissionControl): string {
  const rows: string[][] = []
  for (const experimentId of Object.keys(state.experiments).sort()) {
    const chain = state.experiments[experimentId] ?? []
    const head = experimentHead(state, experimentId)
    if (head === undefined) continue
    rows.push([
      `${head.experimentId}@${head.version}`,
      String(chain.length),
      head.stage,
      head.wildcard === true ? '是（走 wildcardProbeAllowance，§31.4）' : '否',
      String(head.stopConditions.length),
      head.taskId ?? '',
      head.routeFamilyId,
      head.isolation,
      stamp(head.preregisteredAt),
    ])
  }
  return table(['试验', '版本数', '当前阶段', 'wildcard', '停止条件数', '任务', '路线族', '隔离', '预登记时间'], rows)
}

/** §26.1 四层结果分别记录：执行 / 干预 / 评价 / 观测，不许合并成一句"成功/失败"。 */
function trialsBody(state: MissionControl): string {
  const items = sortedValues(state.trials, (trial) => trial.trialId)
  const body = table(
    [
      '试验结果',
      '试验契约',
      '契约版本',
      '① 执行（execution）',
      '② 干预是否生效（treatmentApplied）',
      '③ 评价有效性（evaluationValidity）',
      '④ 观测（observed）',
      '观测说明',
      '结论引用',
      '混杂',
      '未知',
      '记录者',
    ],
    items.map((trial) => [
      trial.trialId,
      trial.experimentId,
      String(trial.experimentVersion),
      trial.execution,
      trial.treatmentApplied,
      trial.evaluationValidity,
      trial.observed,
      trial.observedNote ?? '',
      trial.claimRefs.join('；'),
      trial.confounders.join('；'),
      trial.unknowns.join('；'),
      trial.recordedBy,
    ]),
  )
  return `${body}\n\n> 四层结果分别记录（§26.1）：执行是否完成 ≠ 干预真的发生 ≠ 评价足以比较 ≠ 观测到方向性结果；后一层不能替前一层背书。`
}

/** 路线依据（basis）只在状态迁移事件里；事件窗口收敛后如实标"未记录"，不猜。 */
function routeBasisOf(state: MissionControl, routeFamilyId: string): string {
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index]
    if (event === undefined || event.kind !== 'experiment/route.assessed') continue
    if (event.detail.routeFamilyId === routeFamilyId) return String(event.detail.basis ?? '未记录')
  }
  return '未记录（事件已收敛）'
}

/** §26.2 路线状态：有作用域的当前视图，不取代 ClaimRevision。 */
function routesBody(state: MissionControl): string {
  const items = sortedValues(state.routes, (route) => route.routeFamilyId)
  return table(
    ['路线族', '状态', '作用域', '依据', '理由', '证据引用', '重入条件', '更新者', '更新时间'],
    items.map((route) => [
      route.routeFamilyId,
      route.state,
      route.scope,
      routeBasisOf(state, route.routeFamilyId),
      route.reason,
      route.evidenceRefs.join('；'),
      route.reentryConditions.join('；'),
      route.updatedBy,
      stamp(route.updatedAt),
    ]),
  )
}

/** §25.4 策略决定：证据、未选理由、成本与复核触发器；不报告隐性思维链。 */
function strategyDecisionsBody(state: MissionControl): string {
  const items = sortedValues(state.strategyDecisions, (decision) => decision.decisionId)
  return table(
    ['决定', '类别', '触发器', '窗口（可比较试验 / 资源口径）', '当前证据', '选中候选', '未选理由', '成本', '复核触发器', '依据水位', '责任人'],
    items.map((decision) => [
      decision.decisionId,
      decision.kind,
      decision.trigger,
      `${decision.window.comparableTrials} 次 / ${decision.window.resourceNote}`,
      decision.currentEvidence.join('；'),
      decision.candidates.filter((candidate) => candidate.chosen).map((candidate) => `${candidate.option}（${candidate.routeFamilyId}）`).join('；'),
      decision.candidates.filter((candidate) => !candidate.chosen).map((candidate) => `${candidate.option}：${candidate.rejectedReason ?? '未写理由'}`).join('；'),
      decision.costNote,
      decision.reviewTrigger,
      String(decision.asOfMissionRevision),
      decision.ownerActorId,
    ]),
  )
}

/** §31.3 猜想：阶段、允许的下一步与探测线索；pursued 不等于为真。 */
function conjecturesBody(state: MissionControl): string {
  const blocks: string[] = []
  for (const claimId of Object.keys(state.claims).sort()) {
    const view = conjectureView(state, claimId)
    if (!view.ok) continue
    const postHoc = view.assumptionChanges.filter((change) => change.postHoc === true).length
    blocks.push(
      [
        `- ${claimId}@${view.version ?? '?'}：阶段 ${view.stage ?? '?'}；证据状态 ${view.status ?? '未记录'}；命题：${view.proposition ?? '（未记录）'}`,
        `  - 允许的下一步：${view.allowedTransitions.length === 0 ? '无（已按范围关闭）' : view.allowedTransitions.join('、')}`,
        `  - 探测线索：最低成本下一动作=${view.nextCheapestAction ?? '未写'}；预期信号=${view.expectedSignals.length === 0 ? '无' : view.expectedSignals.join('；')}`,
        `  - 竞争解释：${view.competingExplanations.length === 0 ? '无' : view.competingExplanations.join('；')}；假设变化 ${view.assumptionChanges.length} 条${postHoc === 0 ? '' : `（其中事后形成 ${postHoc} 条，§31.6）`}`,
        `  - 已探测试验：${view.probedTrialIds.length === 0 ? '无' : view.probedTrialIds.join('、')}`,
      ].join('\n'),
    )
  }
  if (blocks.length === 0) return PLACEHOLDER
  return `${blocks.join('\n')}\n\n> 猜想阶段与证据状态分开：pursued 不等于为真，未闭合猜想在收口诊断里单列（§31.3）。`
}

/** §25/§26/§31 工作与探索面视图。 */
export function renderWorkMarkdown(state: MissionControl): string {
  return [
    ...viewHeader(state, '工作与探索视图'),
    section('任务工作分类（§25.2）：improve / explore / validate / deliver', workKindsBody(state)),
    '',
    section('探索策略与预留（§25.2、§31.4）：止损点、释放与 wildcard', explorationBody(state)),
    '',
    section('试验契约（§25.3）：阶段目标、停止条件与版本', experimentsBody(state)),
    '',
    section('试验结果（§26.1）：执行 / 干预 / 评价 / 观测四层', trialsBody(state)),
    '',
    section('路线状态（§26.2）：作用域内的当前建议', routesBody(state)),
    '',
    section('策略决定（§25.4）：证据、未选理由与复核触发器', strategyDecisionsBody(state)),
    '',
    section('猜想（§31.3）：阶段与探测线索', conjecturesBody(state)),
  ].join('\n')
}

// —— §28/§32 记录面 ——

/** §28.4 覆盖回执：完整性、缺失项，以及"没找到"的覆盖前提。 */
function coveragesBody(state: MissionControl): string {
  const items = sortedValues(state.coverages, (coverage) => coverage.coverageId)
  return table(
    ['覆盖回执', '完整性', '水位修订', '来源切面（水位 / 持久性）', '被截断', '查询错误', '未解决冲突', '"没找到"前提', '缺失项（现成判定：阻断项 / 边界）'],
    items.map((coverage) => {
      const assessment = assessCoverage(coverage, state)
      // 只是两个记录字段与现成校验的组合：完整性为 complete_within_scope 且无阻断项时，
      // "已读范围内没找到"才有覆盖前提（§22.2 DG-02 口径、§28.4）；不在这里做语义判断。
      const absence = coverage.completeness === 'complete_within_scope' && assessment.ok
      return [
        coverage.coverageId,
        coverage.completeness,
        String(coverage.asOfMissionRevision),
        coverage.sourceCuts.length === 0 ? '无' : coverage.sourceCuts.map((cut) => `${cut.source}@${cut.watermark}（${cut.durability}）`).join('；'),
        coverage.truncated ? '是' : '否',
        String(coverage.errors.length),
        String(coverage.unresolvedConflicts.length),
        absence ? '满足（限已读范围）' : '不满足',
        [...assessment.blockers, ...assessment.caveats].join('；'),
      ]
    }),
  )
}

/** §28.4、§28.5 决定依据包：与决定有关的版本水位与新鲜度。 */
function briefsBody(state: MissionControl): string {
  const items = sortedValues(state.briefs, (brief) => brief.briefId)
  return table(
    ['依据包', '用途', '目标引用', '水位修订', '规则修订', '覆盖回执', '支持/反证/未决', '阻断项', '新鲜度（assessBriefFreshness）'],
    items.map((brief) => {
      const freshness = assessBriefFreshness(state, brief)
      return [
        brief.briefId,
        brief.kind,
        brief.targetRefs.join('；'),
        String(brief.asOfMissionRevision),
        String(brief.policyRevision),
        brief.coverageId === '' ? '未绑定' : brief.coverageId,
        `${brief.supportedRefs.length} / ${brief.contradictedRefs.length} / ${brief.unresolvedRefs.length}`,
        brief.blockers.join('；'),
        `${freshness.verdict}${freshness.usable ? '' : '（不可用）'}：${[...freshness.reasons, ...freshness.drifts].join('；')}`,
      ]
    }),
  )
}

/** §5.3：口径与 `completion.archivedDiagnostics` 一致——视图不是全量历史。 */
function recordsScopeNote(state: MissionControl): string {
  const archived = Object.entries(state.archivedCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
  if (archived.length === 0) {
    return '> 视图不是全量历史：本页只覆盖保留记录，更早的变更与已闭合条目需另取备份（§5.3）。'
  }
  return `> 视图不是全量历史：${archived.map(([field, count]) => `${field} 已归档 ${count} 条`).join('；')}——视图与判定只覆盖保留部分，历史需另取备份（§5.3）。`
}

/** §28/§32 记录面视图。 */
export function renderRecordsMarkdown(state: MissionControl): string {
  return [
    ...viewHeader(state, '记录面视图'),
    section('覆盖回执（§28.4）：完整性、截断与"没找到"的覆盖前提', coveragesBody(state)),
    '',
    section('决定依据包（§28.4、§28.5）：与决定有关的版本水位与新鲜度', briefsBody(state)),
    '',
    recordsScopeNote(state),
  ].join('\n')
}

// —— §33 环境接续面 ——

function manifestsBody(state: MissionControl): string {
  const rows: string[][] = []
  for (const environmentId of Object.keys(state.environments).sort()) {
    const chain = state.environments[environmentId] ?? []
    const head = chain.at(-1)
    if (head === undefined) continue
    const gaps = environmentGaps(head)
    const unknown = head.items.filter((item) => item.coverage === 'unknown').length
    const unverified = head.items.filter((item) => item.lastCheckedAt === undefined).length
    rows.push([
      `${head.environmentId}@${head.version}`,
      String(chain.length),
      head.nextAction,
      head.taskId === undefined ? '' : `${head.taskId}${head.attemptId === undefined ? '' : ` / ${head.attemptId}`}`,
      `${head.items.length} 项（coverage=unknown ${unknown}；缺核验时间 ${unverified}）`,
      stamp(validUntilFor(head.items, head.createdAt)),
      gaps.complete
        ? '无（未知项与未覆盖种类均为零）'
        : `unknown ${gaps.unknownRefs.length} 项${gaps.unknownRefs.length === 0 ? '' : `（${gaps.unknownRefs.join('、')}）`}；未覆盖种类 ${gaps.missingKinds.join('/') || '无'}`,
      gaps.note,
    ])
  }
  return table(['环境', '版本数', '下一步（nextAction）', '任务归属', 'items', '准入时效（validUntilFor）', '缺口（environmentGaps）', '口径说明'], rows)
}

function resumesBody(state: MissionControl): string {
  const items = sortedValues(state.resumes, (resume) => resume.resumeId)
  return table(
    ['恢复评估', '环境（绑定版本）', '任务 / 尝试', '阶段', '货币性（resumeIsCurrent）', '阻塞范围（findings）', '准入时效 validUntil', '核对时间', '决定者'],
    items.map((resume) => {
      const head = (state.environments[resume.environmentId] ?? []).at(-1)
      const currentAttemptId = resume.taskId === undefined ? undefined : state.tasks[resume.taskId]?.currentAttemptId
      const verdict = resumeIsCurrent(
        resume,
        {
          ...(head === undefined ? {} : { environmentVersion: head.version }),
          ...(currentAttemptId === undefined ? {} : { attemptId: currentAttemptId }),
        },
        state.lastCommittedAt,
      )
      const blocking = resume.findings.filter((finding) => finding.finding !== 'unchanged')
      return [
        resume.resumeId,
        `${resume.environmentId}@${resume.environmentVersion}`,
        `${resume.taskId ?? '未绑定任务'}${resume.attemptId === undefined ? '' : ` / ${resume.attemptId}`}`,
        resume.phase,
        `${verdict.ok ? 'current' : 'not current'}：${verdict.reason}`,
        blocking.length === 0 ? '无（findings 全部 unchanged）' : blocking.map((finding) => `${finding.ref}：${finding.finding}→${finding.allowedScope}`).join('；'),
        resume.validUntil === undefined ? '未设' : stamp(resume.validUntil),
        stamp(resume.checkedAt),
        resume.decidedBy,
      ]
    }),
  )
}

/** §33 环境接续视图：清单缺口与恢复评估的货币性结论。 */
export function renderEnvironmentMarkdown(state: MissionControl): string {
  return [
    ...viewHeader(state, '环境接续视图'),
    section('环境清单（§33.1）：版本链头、下一步动作与缺口', manifestsBody(state)),
    '',
    section('恢复评估（§33.3）：阶段、货币性结论与阻塞范围', resumesBody(state)),
    '',
    '> 货币性只按记录可核的绑定清单版本与当前尝试判定（对象的最新观测值由调用方提供）；即使显示 current 也不构成执行权，受管动作仍需当前票据与授权（§33.3）。',
  ].join('\n')
}

// —— §35 治理面 ——

const MECHANISM_STATUS_LABEL: Readonly<Record<string, string>> = {
  candidate: 'candidate（尚未进入服务：不产生判定）',
  observing: 'observing（观察中：尚无判定资格）',
  active: 'active（可出判定）',
  cooling: 'cooling（冷却：按范围停用）',
  observe_only: 'observe_only（仅观察：只剩建议与观察）',
  retired: 'retired（已退役：判定不得作为验收依据，§35.4）',
}

function mechanismsBody(state: MissionControl): string {
  const blocks: string[] = []
  for (const mechanismId of Object.keys(state.mechanisms).sort()) {
    const policy = mechanismHead(state, mechanismId)
    if (policy === undefined) continue
    const spend = mechanismSpend(state, mechanismId)
    const runs = Object.values(state.mechanismRuns)
      .filter((run) => run.mechanismId === mechanismId)
      .sort((a, b) => a.runId.localeCompare(b.runId))
    // 收益观察记录不在控制记录里：按空观察集评估，只说明"证据不足"，不据此退役或加码（§35.4）。
    const benefit = assessBenefit(policy, runs, [])
    const exit = exitVerdict(policy, benefit)
    // 熔断只看记录可核的成本信号；超时 / 故障 / 无变化连击数由运行信号提供，视图不猜（§35.3）。
    const breaker = breakerFor(policy, { timeoutStreak: 0, noChangeStreak: 0, failureStreak: 0 }, spend)
    const cap = policy.costCap
    blocks.push(
      [
        `### ${mechanismId}@${policy.version} ${policy.name}`,
        `- 分类与状态：${policy.class}；${MECHANISM_STATUS_LABEL[policy.status] ?? policy.status}${policy.statusReason === undefined ? '' : `（${policy.statusReason}）`}`,
        `- 成本策略：${cap === undefined ? '未设上限' : `tokens≤${cap.tokens ?? '—'} / calls≤${cap.calls ?? '—'} / wallClockMs≤${cap.wallClockMs ?? '—'}${policy.timeoutMs === undefined ? '' : `；超时 ${policy.timeoutMs}ms`}`}`,
        `- 滚动成本（机制累计；墙钟是成本口径，不是会话已过时间）：runs=${spend.runs} calls=${spend.calls} tokens=${spend.tokens} wallClockMs=${spend.wallClockMs} blockedWaitMs=${spend.blockedWaitMs}；费用不可观测运行 ${spend.unknownRuns} 次`,
        `- 熔断信号（记录可核的成本部分）：${breaker.break ? `${breaker.target ?? '停用'}——${breaker.reason}` : breaker.reason}；重新评估条件：${breaker.resumeWhen}`,
        `- 收益评估：${benefit.verdict}（${benefit.reason}）`,
        `- 退出建议：${exit.action}——${exit.reason}`,
      ].join('\n'),
    )
  }
  if (blocks.length === 0) return PLACEHOLDER
  return `${blocks.join('\n\n')}\n\n> 收益观察不在控制记录里（由调用方提供）：未登记观察时只报"证据不足"，不凭拦截次数宣称有收益、也不据此退役（§35.4）。`
}

/** 机制运行：成本口径与误报标记。 */
function mechanismRunsBody(state: MissionControl): string {
  const items = sortedValues(state.mechanismRuns, (run) => run.runId).sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId))
  return table(
    ['运行', '机制', '策略版本', 'Actor', '任务', '触发', '开始', '结束', '成本 calls / tokens / wallClockMs / blockedWaitMs', '费用口径', '误报', '实际动作', '输出'],
    items.map((run) => {
      const cost = governanceCostOf(run)
      return [
        run.runId,
        run.mechanismId,
        String(run.mechanismVersion),
        run.actorId ?? '',
        run.taskId ?? '',
        run.trigger,
        stamp(run.startedAt),
        run.finishedAt === undefined ? '未结束' : stamp(run.finishedAt),
        `${cost.calls} / ${cost.tokens} / ${cost.wallClockMs} / ${cost.blockedWaitMs}`,
        cost.level,
        run.misreport === undefined ? '未标' : `${run.misreport}${run.misreportNote === undefined ? '' : `（${run.misreportNote}）`}`,
        run.actualAction,
        run.outputNote,
      ]
    }),
  )
}

/** §27.3 上下文分量评估：分量结论、动作状态与当前性。 */
function assessmentsBody(state: MissionControl): string {
  const items = sortedValues(state.assessments, (assessment) => assessment.assessmentId)
  const body = table(
    ['评估', 'Actor', '请求指纹', '会话', '分量结论', '未知分量（缺什么）', '建议', '动作状态', '记录校验（validateAssessment）', '当前性（assessmentIsCurrent）'],
    items.map((assessment) => {
      const validation = validateAssessment(assessment)
      // 会话、判据与请求指纹的当前值不在控制记录里（由适配层提供）：帧里这几项按记录自身取值，
      // 因此这里的 current 只表示"目标 / 规则版本未变"，不冒领会话层核对（§27.5 第 2 条）。
      const frame: AssessmentFrame = {
        requestFingerprint: assessment.requestFingerprint,
        ...(assessment.sessionId === undefined ? {} : { sessionId: assessment.sessionId }),
        sessionRevision: assessment.sessionRevision,
        missionRevision: state.revision,
        objectiveRevision: state.mission.objectiveRevision,
        policyRevision: state.mission.policyRevision,
        criteriaRevision: assessment.criteriaRevision,
      }
      const current = assessmentIsCurrent(assessment, frame)
      return [
        assessment.assessmentId,
        assessment.actorId,
        assessment.requestFingerprint,
        assessment.sessionId ?? '',
        assessment.components.map((component) => `${component.name}=${component.signal}`).join('；'),
        assessment.components.filter((component) => component.unknown === true).map((component) => `${component.name}（${component.limitNote ?? '未写缺什么'}）`).join('；'),
        assessment.suggestion,
        assessment.actionState ?? '',
        validation.ok ? '合格' : `不合格：${validation.problems.join('；')}`,
        current.ok ? 'current（限记录可核对的目标 / 规则版本）' : `失效：${current.blocking.map((drift) => drift.detail).join('；')}`,
      ]
    }),
  )
  return `${body}\n\n> 会话与判据层的当前值不在控制记录里：显示 current 只说明记录可核对的目标 / 规则版本未变；会话变化后旧评估失效由适配层按 §27.5 第 2 条判定。`
}

/** §35 治理面视图：机制、运行成本与上下文评估。 */
export function renderGovernanceMarkdown(state: MissionControl): string {
  return [
    ...viewHeader(state, '治理面视图'),
    section('机制（§35.1–35.4）：分类、状态、成本与退出建议', mechanismsBody(state)),
    '',
    section('机制运行（§35.2）：成本与误报标记', mechanismRunsBody(state)),
    '',
    section('上下文评估（§27.3、§27.5）：分量结论、动作状态与当前性', assessmentsBody(state)),
  ].join('\n')
}

// —— §30/§34 效用与整合面 ——

function outcomeContractBody(state: MissionControl): string {
  const contract = state.mission.outcome
  if (contract === undefined) {
    return '未登记目标契约：视图不代替用户解释目标，也不把验收例子写进运行记录；关键里程碑、路线变更或整体验收前先整理契约（§30.1、§30.2）。'
  }
  const examples = contract.acceptanceExamples
  const kinds = (kind: string): number => examples.filter((example) => example.kind === kind).length
  return list([
    `预期用途（intendedUse）：${contract.intendedUse}`,
    `期望结果（desiredOutcome）：${contract.desiredOutcome}`,
    `验收例子：success ${kinds('success')} 条 / boundary ${kinds('boundary')} 条 / failure ${kinds('failure')} 条`,
    `指标与局限：${contract.metricsAndLimits.length === 0 ? '未登记' : contract.metricsAndLimits.map((metric) => `${metric.metric}（代表：${metric.represents}；不能代表：${metric.cannotRepresent}${metric.mappingPending === true ? '；映射待验证' : ''}）`).join('；')}`,
    `硬约束（含来源）：${contract.hardConstraints.length === 0 ? '未登记' : contract.hardConstraints.map((item) => `${item.text}（来源：${item.source}）`).join('；')}`,
    `偏好与取舍：${contract.preferencesAndTradeoffs.length === 0 ? '未登记' : contract.preferencesAndTradeoffs.map((item) => `${item.preference}${item.authorizedBy === undefined ? '' : `（授权：${item.authorizedBy}）`}`).join('；')}`,
    `未决假设（可先推进范围）：${contract.unresolvedAssumptions.length === 0 ? '未登记' : contract.unresolvedAssumptions.map((item) => `${item.text}（${item.advanceScope}）`).join('；')}`,
    `效果观测：${contract.effectObservation.state}${contract.effectObservation.note === undefined ? '' : `（${contract.effectObservation.note}）`}；证据 ${contract.effectObservation.evidenceRefs?.length ?? 0} 条${contract.effectObservation.state === 'outcome_pending' ? '——需要未来实际使用才能验证，不假报已发生（§30.3）' : ''}`,
    `契约修订：${stamp(contract.revisedAt)}，修订者 ${contract.revisedBy}`,
  ])
}

/** §30.2 复核结论：不传触发信号就不报触发，不编造复核需要（日常小步骤复用已生效契约）。 */
function outcomeReviewBody(state: MissionControl): string {
  const review = outcomeReviewRequired(state)
  return `- 当前复核结论：${review.required ? `需要复核（${review.triggers.join(' / ')}）` : '不需要复核'}——${review.reason}`
}

/** §34.3 整合计划：组件与目标版本、接口与唯一 owner。 */
function integrationPlansBody(state: MissionControl): string {
  const items = sortedValues(state.integrations, (plan) => plan.integrationId)
  return table(
    ['整合计划', '整合任务', '组件（目标版本）', '接口（消费者）', '共享假设', '候选引用', '整体使用例', 'owner'],
    items.map((plan) => [
      plan.integrationId,
      plan.integrationTaskId,
      plan.componentRefs.map((component) => `${component.artifactId ?? component.taskId ?? '未绑定'}@${component.expectedVersion}`).join('；'),
      plan.interfaces.map((iface) => `${iface.name}（${iface.consumers.join('、')}）`).join('；'),
      plan.sharedAssumptions.join('；'),
      plan.candidateRefs.join('；'),
      plan.userFlow,
      plan.ownerActorId,
    ]),
  )
}

/** §34.4 整合回执：发布资格、整体检查与版本漂移。 */
function integrationReceiptsBody(state: MissionControl): string {
  const items = sortedValues(state.integrationReceipts, (receipt) => receipt.receiptId)
  const body = table(
    ['回执', '整合计划', '发布资格', '整体检查', '复用组件', '局部返工', '绑定修订（目标 / 判据）', '当前性（integrationReceiptCurrent）'],
    items.map((receipt) => {
      const currency = integrationReceiptCurrent(state, receipt.receiptId)
      // 回执回指的就是计划 ID 本身：直接按主键取——`findIntegrationForRef` 是给质疑对象按组件/接口反查用的，
      // 拿 integrationId 去查它必然落空，会让在册计划被误标"计划不在记录中"。
      const plan = state.integrations[receipt.integrationId]
      return [
        receipt.receiptId,
        `${receipt.integrationId}${plan === undefined ? '（计划不在记录中）' : ''}`,
        receipt.publishEligible ? '具备' : '不具备',
        receipt.checks.length === 0 ? '无' : receipt.checks.map((check) => `${check.kind}=${check.result}`).join('；'),
        receipt.reusedComponentRefs.join('；'),
        receipt.reworkTaskIds.join('；'),
        `${receipt.objectiveRevision} / ${receipt.criteriaRevision}`,
        currency.current ? 'current：组件与绑定版本未被取代' : `漂移：${currency.changes.join('；')}`,
      ]
    }),
  )
  return `${body}\n\n> 发布资格由整体检查与局部返工决定：成员各自通过不能投票变成整体通过，fail / unknown 不折算成通过（§34.4）。`
}

/** §30/§34 效用与整合面视图。 */
export function renderOutcomeMarkdown(state: MissionControl): string {
  return [
    ...viewHeader(state, '效用与整合视图'),
    section('目标契约（§30.1）：预期用途、期望结果与效果观测', outcomeContractBody(state)),
    '',
    section('复核结论（§30.2）：只看当前记录，不编造触发', outcomeReviewBody(state)),
    '',
    section('整合计划（§34.3）：组件、目标版本与接口', integrationPlansBody(state)),
    '',
    section('整合回执（§34.4）：发布资格、整体检查与漂移', integrationReceiptsBody(state)),
  ].join('\n')
}
