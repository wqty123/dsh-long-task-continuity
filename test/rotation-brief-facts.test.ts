/**
 * 交接包与事实层（§9.3）：这一层是纯结构、零 LLM 的，所以用例全部按"字面值得原样出现"来断言。
 *
 * 三条不变量决定用例怎么写：
 * 1. 每一行都过 `redactText`：凭证不能第二次离开本机；同时可检索的字面值（12 位哈希前缀、
 *    文件路径、seq）必须活下来——所以产物行用前缀而不是全哈希，用例把这个选择钉住。
 * 2. 四节（目标与约束、已验收进度、当前状态、下一步）不参与裁剪：放不下就以 `overBudget`
 *    交回调用方进入等待，而不是静默丢掉新会话唯一能接续的信息。
 * 3. 事实层只说观察到的：没收到 result 的调用不算改动，装载前的历史由 `inheritedNote` 声明。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BRIEF_MAX_LINES_PER_SECTION,
  BRIEF_SECTIONS,
  BRIEF_TOKEN_BUDGET,
  EMPTY_SECTION,
  assembleBrief,
  collectFileChanges,
  estimateTokens,
} from '../src/rotation/brief.ts'
import type { BriefFacts, ToolCallEvent } from '../src/rotation/brief.ts'
import { ToolEventLedger, factsFromLedger } from '../src/rotation/facts.ts'
import type { SessionEventLike } from '../src/rotation/facts.ts'
import type { MissionControl } from '../src/core/control.ts'
import type { Checkpoint } from '../src/core/entities.ts'
import { mintCriteria } from '../src/core/entities.ts'
import { REDACTED } from '../vendor/redaction.ts'
import { apply, checkpointPayload, ctx, draftMission, freshState, req, withClaimedTask } from './fixtures.ts'

type CheckpointPayload = Partial<ReturnType<typeof checkpointPayload>>

function facts(overrides: Partial<BriefFacts> = {}): BriefFacts {
  return {
    fileChanges: [],
    lastStepSummary: '本插件装载后未观察到工具调用',
    failures: [],
    route: 'deepseek-v4/pro',
    mode: 'agent',
    permission: 'host:default',
    compacted: false,
    inheritedNote: '文件改动清单为空：本插件装载后该会话没有可核对的工具事件。',
    ...overrides,
  }
}

function evt(seq: number, tool: string, args: unknown, ok = true): ToolCallEvent & { readonly seq: number } {
  return { seq, tool, ok, argumentsJson: typeof args === 'string' ? args : JSON.stringify(args) }
}

/** 宿主 `session/event` 的真实形状：`arguments` 到手就是字符串，result 只有 `message.toolCallId`。 */
function call(seq: number, callId: string, tool: string, args: unknown): SessionEventLike {
  return { type: 'tool/call', seq, data: { callId, name: tool, arguments: JSON.stringify(args) } }
}

function result(seq: number, callId: string, isError = false): SessionEventLike {
  return { type: 'tool/result', seq, data: { message: { toolCallId: callId, isError } } }
}

/** 写一条连续性检查点并把记录取回来：交接包的每个字段都来自已提交状态，用例因此走真命令而不是造对象。 */
function withCheckpoint(state: MissionControl, payload: CheckpointPayload = {}): { readonly state: MissionControl; readonly checkpoint: Checkpoint } {
  const next = apply(state, { kind: 'continuity.checkpoint', requestId: req(), checkpoint: { actorId: 'lead-1', ...checkpointPayload(payload) } }, ctx('lead', 'lead-1'))
  return { state: next, checkpoint: next.checkpoints[next.checkpointOrder[next.checkpointOrder.length - 1]!]! }
}

function writeCheckpoint(state: MissionControl, payload: CheckpointPayload = {}): Checkpoint {
  return withCheckpoint(state, payload).checkpoint
}

function bullets(section: string): string[] {
  return section === EMPTY_SECTION ? [] : section.split('\n')
}

// ---------------------------------------------------------------- estimateTokens

test('token 估算：中日韩逐字计，其余按 4 字符折 1；全角标点算"其余"', () => {
  assert.equal(estimateTokens('一二三'), 3)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2, '不足 4 字符也占一格')
  assert.equal(estimateTokens('一二 abcdef'), 4, '2 个汉字 + 7 个其他字符 → 2 + 2')
  assert.equal(estimateTokens('あい'), 2, '假名在同一张表内')
  assert.equal(estimateTokens('，。'), 1, '全角标点落在 \\u3400-\\u9fff 之外，只能按字符折算')
  assert.equal(estimateTokens(''), 0)
})

// ---------------------------------------------------------------- collectFileChanges

test('只有写入型且成功的调用才算改动', () => {
  const rows = collectFileChanges([
    evt(1, 'read_file', { path: 'a.md' }),
    evt(2, 'Write', { path: 'b.md' }),
    evt(3, 'Edit', { path: 'c.md' }, false),
    evt(4, 'str_replace_editor', { path: 'd.md' }),
  ])
  assert.deepEqual(rows.map((row) => row.path), ['b.md', 'd.md'])
  assert.equal(rows[1]?.tools.join(), 'str_replace_editor')
})

test('路径键按命名表轮询，认不出路径就不记账', () => {
  const rows = collectFileChanges([
    evt(1, 'Write', { path: '/x/a.ts', file_path: '/ignored.ts' }),
    evt(2, 'NotebookEdit', { notebook_path: '/x/nb.ipynb' }),
    evt(3, 'move', { to: '/x/moved.ts' }),
    evt(4, 'Write', { path: '   ' }),
    evt(5, 'Write', '这不是 JSON'),
    evt(6, 'Write', 'null'),
    evt(7, 'Edit', { file_path: '/x/c.ts' }),
    evt(8, 'Write', [1, 2]),
  ])
  assert.deepEqual(rows.map((row) => row.path), ['/x/a.ts', '/x/nb.ipynb', '/x/moved.ts', '/x/c.ts'])
})

test('首次触及顺序与工具名去重：同一文件被多次改动只留一行', () => {
  const rows = collectFileChanges([
    evt(5, 'Write', { path: 'a.ts' }),
    evt(7, 'Edit', { path: 'b.ts' }),
    evt(9, 'Edit', { path: 'a.ts' }),
    evt(11, 'Write', { path: 'a.ts' }),
  ])
  assert.deepEqual(rows.map((row) => row.path), ['a.ts', 'b.ts'], '排序依据是首次触及的 seq，不是最后一次')
  assert.equal(rows[0]?.firstTouchedSeq, 5)
  assert.deepEqual(rows[0]?.tools, ['Write', 'Edit'])
})

// ---------------------------------------------------------------- ToolEventLedger

test('配对成功：tool/call 先建档，tool/result 才把 ok 定为真', () => {
  const ledger = new ToolEventLedger()
  assert.equal(ledger.observe('s1', call(3, 'c1', 'Write', { path: 'a.ts' })), true)
  assert.equal(ledger.changes('s1')[0]?.ok, false, '没有 result 之前不能把改动写成已完成')
  assert.equal(ledger.observe('s1', result(4, 'c1')), true)
  const row = ledger.changes('s1')[0]!
  assert.equal(row.ok, true)
  assert.equal(row.tool, 'Write')
  assert.equal(row.seq, 3)
})

test('残缺事件一律不消费也不建档', () => {
  const ledger = new ToolEventLedger()
  assert.equal(ledger.observe('s1', { type: 'session/status', seq: 1, data: {} }), false)
  assert.equal(ledger.observe('s1', { type: 'tool/call', seq: 2, data: { name: 'Write', arguments: '{}' } }), false, '缺 callId')
  assert.equal(ledger.observe('s1', { type: 'tool/call', seq: 3, data: { callId: 'c', arguments: '{}' } }), false, '缺 name')
  assert.equal(ledger.observe('s1', { type: 'tool/result', seq: 4, data: { message: { toolCallId: 'nope' } } }), false)
  assert.equal(ledger.size, 0)
  assert.deepEqual(ledger.changes('s1'), [])
})

test('arguments 带对象时序列化成可解析文本（Code-Mode 的子调用就是这个形状），非对象仍存空串', () => {
  const ledger = new ToolEventLedger()
  ledger.observe('s1', { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'Write', arguments: { path: 'a.ts' } } })
  ledger.observe('s1', result(2, 'c1'))
  assert.equal(ledger.changes('s1')[0]?.argumentsJson, '{"path":"a.ts"}')
  assert.deepEqual(
    collectFileChanges(ledger.changes('s1')).map((row) => row.path),
    ['a.ts'],
  )
  const junk = new ToolEventLedger()
  junk.observe('s2', { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'Write', arguments: 7 } })
  junk.observe('s2', { type: 'tool/call', seq: 2, data: { callId: 'c2', name: 'Write' } })
  assert.deepEqual(
    junk.changes('s2').map((row) => row.argumentsJson),
    ['', ''],
  )
})

test('同一 callId 重试：result 只结算最早那条未收束的调用', () => {
  const ledger = new ToolEventLedger()
  ledger.observe('s1', call(1, 'c1', 'Write', { path: 'a.ts' }))
  ledger.observe('s1', call(2, 'c1', 'Write', { path: 'a.ts' }))
  ledger.observe('s1', result(3, 'c1', true))
  const rows = ledger.changes('s1')
  assert.equal(rows[0]?.ok, false)
  assert.equal(ledger.hasUnsettled('s1'), true, '第二条还没对上结果，仍算在执行中')
})

test('环形缓冲只留最近若干条，覆盖范围随 observedFrom 前移', () => {
  const ledger = new ToolEventLedger(3)
  for (let seq = 1; seq <= 5; seq += 1) ledger.observe('s1', call(seq, `c${seq}`, 'Write', { path: `${seq}.ts` }))
  assert.deepEqual(ledger.changes('s1').map((row) => row.seq), [3, 4, 5])
  assert.equal(ledger.observedFrom('s1'), 3, '被挤掉的调用不能再声称覆盖')
})

test('hasUnsettled 的三态：没见过是 null，不是 false', () => {
  const ledger = new ToolEventLedger()
  assert.equal(ledger.hasUnsettled('s1'), null)
  ledger.observe('s1', call(1, 'c1', 'Bash', { command: 'x' }))
  assert.equal(ledger.hasUnsettled('s1'), true)
  ledger.observe('s1', result(2, 'c1'))
  assert.equal(ledger.hasUnsettled('s1'), false)
  ledger.forget('s1')
  assert.equal(ledger.hasUnsettled('s1'), null)
})

test('lastCallSummary 将三种结算状态说清楚', () => {
  const ledger = new ToolEventLedger()
  assert.equal(ledger.lastCallSummary('s1'), '本插件装载后未观察到工具调用')
  ledger.observe('s1', call(7, 'c1', 'Edit', { path: 'a.ts' }))
  assert.match(ledger.lastCallSummary('s1'), /Edit（seq 7，未见结果记录）/)
  ledger.observe('s1', result(8, 'c1'))
  assert.match(ledger.lastCallSummary('s1'), /已正常返回/)
  ledger.observe('s1', call(9, 'c2', 'Edit', { path: 'b.ts' }))
  ledger.observe('s1', result(10, 'c2', true))
  assert.match(ledger.lastCallSummary('s1'), /返回报错/)
  ledger.observe('s2', call(1, 'c3', 'Write', { path: 'c.ts' }))
  assert.equal(ledger.size, 2, '缓冲按会话分隔')
  ledger.clear()
  assert.equal(ledger.size, 0)
})

// ---------------------------------------------------------------- factsFromLedger

test('事实层把工具观察转成文件清单，并如实声明覆盖范围', () => {
  const ledger = new ToolEventLedger()
  ledger.observe('s1', call(5, 'c1', 'Write', { path: 'src/a.ts' }))
  ledger.observe('s1', result(6, 'c1'))
  ledger.observe('s1', call(7, 'c2', 'Read', { path: 'src/a.ts' }))
  ledger.observe('s1', result(8, 'c2'))
  ledger.observe('s1', call(9, 'c3', 'Edit', { path: 'src/b.ts' }))
  const observed = factsFromLedger({ state: freshState(), ledger, sessionId: 's1', route: 'r', mode: 'm', permission: 'p', compacted: false })
  assert.deepEqual(observed.fileChanges.map((row) => row.path), ['src/a.ts'], 'Read 不写入，未收到结果的 Edit 不算改动')
  assert.match(observed.inheritedNote ?? '', /自 seq 5 起的 3 次工具调用/)
  assert.match(observed.lastStepSummary, /未见结果记录/)

  const empty = factsFromLedger({ state: freshState(), ledger, sessionId: 'sX', route: 'r', mode: 'm', permission: 'p', compacted: false })
  assert.deepEqual(empty.fileChanges, [])
  assert.match(empty.inheritedNote ?? '', /清单为空/)
})

test('失败清单来自已提交状态：失败操作、未知结局操作、停在 WAITING_RECOVERY 的轮换', () => {
  let state = withClaimedTask().state
  const taskId = Object.keys(state.tasks)[0]!
  state = apply(state, { kind: 'operation.intent', requestId: req(), taskId, operationKind: 'shell', target: 'npm test', intent: '跑测试', idempotencyKey: 'k1', retryable: true }, ctx('lead', 'lead-1'))
  const firstOp = Object.keys(state.operations)[0]!
  state = apply(state, { kind: 'operation.receipt', requestId: req(), operationId: firstOp, status: 'failed' }, ctx('lead', 'lead-1'))
  state = apply(state, { kind: 'operation.intent', requestId: req(), taskId, operationKind: 'upload', target: 'oss://bucket/x', intent: '传产物', idempotencyKey: 'k2', retryable: false }, ctx('lead', 'lead-1'))
  const secondOp = Object.keys(state.operations).find((id) => id !== firstOp)!
  state = apply(state, { kind: 'operation.reconcile', requestId: req(), operationId: secondOp, verdict: 'still_unknown' }, ctx('supervisor'))
  const prepared = withCheckpoint(state, {})
  state = apply(prepared.state, { kind: 'continuity.requestRotation', requestId: req(), actorId: 'lead-1', sourceSessionId: 'sess-1', targetSessionId: 'sess-2', checkpointId: prepared.checkpoint.checkpointId, trigger: 'manual', seedMessageId: 'seed-1' })
  const rotationId = Object.keys(state.rotations)[0]!
  state = apply(state, { kind: 'continuity.failRotation', requestId: req(), rotationId, reason: '启动消息未确认', nextReconcileAction: '按 rpcId seed-1 复查' })
  const built = factsFromLedger({ state, ledger: new ToolEventLedger(), sessionId: 'sess-1', route: 'r', mode: 'm', permission: 'p', compacted: false })
  assert.equal(built.failures.length, 3)
  assert.match(built.failures.join('\n'), /操作 shell → npm test：failed/)
  assert.match(built.failures.join('\n'), /操作 upload → oss:\/\/bucket\/x：outcome_unknown/)
  assert.match(built.failures.join('\n'), /停在 WAITING_RECOVERY：按 rpcId seed-1 复查/)
})

// ---------------------------------------------------------------- assembleBrief

test('最小交接包：八节齐全、顺序即契约、空节显式写"（无）"', () => {
  const state = freshState()
  const checkpoint = writeCheckpoint(state, {})
  const brief = assembleBrief(state, checkpoint, facts())
  assert.deepEqual(Object.keys(brief.sections), [...BRIEF_SECTIONS])
  assert.deepEqual([...BRIEF_SECTIONS], [
    'objective_and_constraints',
    'verified_progress',
    'current_state',
    'next_action',
    'key_decisions',
    'artifacts_and_evidence',
    'failed_paths_and_blockers',
    'open_questions',
  ])
  assert.equal(brief.sections.key_decisions, EMPTY_SECTION)
  // §22.6：待确认事项一节现在恒带一行 basisRevision 基线，"无待确认"不再等于空节。
  assert.equal(brief.sections.open_questions, `- 依据有效性版本 basisRevision 0：与当前记录不一致时，先重验再执行`)
  assert.equal(brief.overBudget, false)
  assert.equal(brief.truncatedFrom.length, 0)
  assert.equal(brief.tokens, estimateTokens(brief.markdown))
  assert.match(brief.markdown, /\[交接 · 由 dsh-long-task-continuity 生成\]/)
  assert.match(brief.markdown, /本消息不是用户的新指令/)
  assert.match(brief.markdown, new RegExp(`Mission ${state.missionId} · objectiveRevision 1 / policyRevision 1 / basisRevision 0 · 检查点 ${checkpoint.checkpointId}（源状态修订 ${checkpoint.sourceRevision}）`), '§9.1/§23.2：交接包头必须带三个版本数，S2 放行前据此重验')
  assert.match(brief.markdown, /## 给新会话的指令/)
})

test('进度与证据来自记录本身：已验收任务、产物哈希前缀、验证行', () => {
  const { state: claimed, taskId } = withClaimedTask()
  let state = apply(claimed, { kind: 'task.checkpoint', requestId: req(), taskId, checkpoint: checkpointPayload() }, ctx('lead', 'lead-1'))
  state = apply(state, { kind: 'artifact.registerVersion', requestId: req(), taskId, uri: 'file:///work/report.md', contentHash: 'a'.repeat(64) }, ctx('lead', 'lead-1'))
  state = apply(state, { kind: 'task.submit', requestId: req(), taskId, leaseVersion: 1 }, ctx('lead', 'lead-1'))
  state = apply(state, { kind: 'task.verify', requestId: req(), taskId, criterionId: 'crit_1', outcome: 'pass', method: 'node --test', methodVersion: '1', evidenceRefs: ['test/core-commands.test.ts'] }, ctx('reviewer', 'rev-1'))
  const checkpoint = writeCheckpoint(state, {})
  const brief = assembleBrief(
    state,
    checkpoint,
    facts({ fileChanges: [{ path: 'src/a.ts', tools: ['Write', 'Edit'], firstTouchedSeq: 12 }], inheritedNote: '覆盖自 seq 3' }),
  )
  // §5.1/§6.4：验收行按 criterionId@criteriaRevision 判定，文本只是展示用。
  assert.match(brief.sections.verified_progress, new RegExp(`${taskId} 冒烟任务：已验收（crit_1@rev1；判据按当前版本仍全部成立）`))
  assert.match(brief.sections.verified_progress, /crit_1@rev1 脚本断言全部通过 → pass（方法 node --test；证据 test\/core-commands\.test\.ts）/, '检查点没写已验收进度时用验证记录补齐')
  assert.match(brief.sections.artifacts_and_evidence, /file:\/\/\/work\/report\.md v1 a{12} \[submitted\]/)
  assert.equal(brief.sections.artifacts_and_evidence.includes(REDACTED), false, '截到 12 位才不会被十六进制规则当成凭证抹掉')
  assert.match(brief.sections.artifacts_and_evidence, /改动文件 src\/a\.ts（工具 Write\/Edit，首次 seq 12）/)
})

test('当前状态段把路由、模式、权限、压缩与待处理消息写在一起', () => {
  const { state: claimed, taskId } = withClaimedTask()
  const state = apply(claimed, { kind: 'team.message', requestId: req(), toActorId: 'lead-1', taskId, messageKind: 'clarify_request', body: '范围确认' }, ctx('lead', 'lead-1'))
  const checkpoint = writeCheckpoint(state, { inProgress: ['正在写轮换用例'], step: '跑到 PREPARED' })
  const brief = assembleBrief(state, checkpoint, facts({ compacted: true, lastStepSummary: '最近一次工具调用 Edit（seq 42，已正常返回）' }))
  // §23.2 第 1 条：当前状态段第一行是版本基线（放行前重验），检查点 step 紧随其后。
  const stateLines = brief.sections.current_state.split('\n')
  assert.match(stateLines[0]!, /^- 版本基线（放行前重验）：objectiveRevision 1 \/ policyRevision 1 \/ basisRevision 0$/)
  assert.equal(stateLines[1], '- 跑到 PREPARED')
  assert.match(brief.sections.current_state, /正在写轮换用例/)
  assert.match(brief.sections.current_state, /路由 deepseek-v4\/pro \/ 模式 agent \/ 权限 host:default \/ 经历过压缩 是/)
  assert.match(brief.sections.current_state, /待处理消息 msg_\S+（clarify_request → lead-1）/)
  assert.match(brief.sections.current_state, /最近一次工具调用 Edit/)
  assert.match(brief.sections.next_action, /手动轮换一次/)
})

test('目标与约束保留原话并标注来源，验收项按判据 ID 逐条列出', () => {
  const state = freshState({
    mission: draftMission({ constraints: ['不得改动业务仓库', '每天只提交一次'], constraintSources: ['用户 2026-10-14 指令'], criteria: mintCriteria([{ text: '台账可导出' }]) }),
  })
  const brief = assembleBrief(state, writeCheckpoint(state, {}), facts())
  // §5.1：验收项展示带 criterionId，判定不靠文本。
  assert.match(brief.sections.objective_and_constraints, /把连续性台账跑通（objectiveRevision 1 \/ policyRevision 1）/)
  assert.match(brief.sections.objective_and_constraints, /不得改动业务仓库（来源：用户 2026-10-14 指令）/)
  assert.match(brief.sections.objective_and_constraints, /每天只提交一次（来源：unknown）/, '来源缺失要显式写 unknown，不假装知道')
  assert.match(brief.sections.objective_and_constraints, /验收项 crit_1：台账可导出/)
})

test('每节最多 24 行：再多也折得平', () => {
  const state = freshState()
  // §22.6：待确认事项一节自带一行 basisRevision 基线，22 条问题 + 基线 + 引用恰好 24 行。
  const many = Array.from({ length: BRIEF_MAX_LINES_PER_SECTION - 2 }, (_unused, index) => `问题 ${index}`)
  const checkpoint = writeCheckpoint(state, { openQuestions: many, contextRefs: ['sess-1'] })
  const brief = assembleBrief(state, checkpoint, facts())
  assert.equal(bullets(brief.sections.open_questions).length, BRIEF_MAX_LINES_PER_SECTION)
  assert.match(brief.sections.open_questions, /引用：sess-1/)
})

test('超预算先裁"待确认事项"，四节保护内容一字不动', () => {
  const state = freshState()
  const row = '待确认事项'.repeat(40)
  const checkpoint = writeCheckpoint(state, { openQuestions: Array.from({ length: 30 }, () => row), decisions: ['决定 A'] })
  const brief = assembleBrief(state, checkpoint, facts())
  assert.deepEqual(brief.truncatedFrom, ['open_questions'])
  assert.equal(brief.overBudget, false)
  assert.ok(brief.tokens <= BRIEF_TOKEN_BUDGET, `裁剪后应落回预算内，实际 ${brief.tokens}`)
  assert.equal(bullets(brief.sections.open_questions).length, 16, '15 条 + 1 行裁剪说明')
  // 30 条问题之外还有一行 basisRevision 基线（§22.6），参与截断口径的计数。
  assert.match(brief.sections.open_questions, /（本节按截断顺序裁剪：原 31 条保留 15 条）/)
  assert.equal(brief.sections.next_action, `- ${checkpoint.nextAction}`)
  assert.match(brief.sections.current_state, new RegExp(checkpoint.step))
  assert.match(brief.markdown, /## 关键决策及依据\n- 决定 A/, '预算够用时不该动到关键决策')
})

test('目标本身放不下时不裁剪它：宁可 overBudget 交回调用方', () => {
  const state = freshState({ mission: draftMission({ objective: '长期任务连续性框架'.repeat(600) }) })
  const checkpoint = writeCheckpoint(state, {})
  const brief = assembleBrief(state, checkpoint, facts())
  assert.equal(brief.overBudget, true)
  assert.deepEqual(brief.truncatedFrom, [], '其余四节没有可裁内容时不做无效裁剪')
  assert.ok(brief.sections.objective_and_constraints.length > 5000, '目标必须逐字保留，截断等于撒谎')
  assert.ok(brief.tokens > BRIEF_TOKEN_BUDGET)
})

test('裁无可裁时仍然超预算，但保护节内容保持完整', () => {
  const state = freshState({ mission: draftMission({ objective: '目标'.repeat(2500) }) })
  const checkpoint = writeCheckpoint(state, { openQuestions: Array.from({ length: 30 }, () => '待确认事项'.repeat(40)) })
  const brief = assembleBrief(state, checkpoint, facts())
  assert.deepEqual(brief.truncatedFrom, ['open_questions'], '先按顺序裁可裁的')
  assert.equal(brief.overBudget, true, '裁完仍超预算就如实报告')
  assert.match(brief.sections.objective_and_constraints, /目标目标目标/)
})

test('凭证在任何一节都留不下来：模型密钥、GitHub 令牌与 KEY=值 全部替换', () => {
  const state = freshState({ mission: draftMission({ objective: '部署脚本 sk-ABCDEFGHIJKLMNOP 需要轮换' }) })
  const checkpoint = writeCheckpoint(state, {
    decisions: ['用 password=hunter2 登录过构建机'],
    blockers: ['令牌 ghp_AAAAAAAAAAAAAAAA 已失效'],
    openQuestions: ['确认 token: abcdefghijklmnop 归属'],
  })
  const brief = assembleBrief(state, checkpoint, facts({ lastStepSummary: '调用 Bash（seq 3，已正常返回），参数含 API_KEY=zzzzzzzzzz' }))
  for (const needle of ['sk-ABCDEFGHIJKLMNOP', 'hunter2', 'ghp_AAAAAAAAAAAAAAAA', 'abcdefghijkl', 'zzzzzzzzzz']) {
    assert.equal(brief.markdown.includes(needle), false, `泄漏：${needle}`)
  }
  assert.ok(brief.markdown.includes(REDACTED))
  assert.match(brief.markdown, /部署脚本 \[已脱敏\] 需要轮换/)
})

test('目标里的凭证同样被抹：objective 单独过一次 redactText', () => {
  const state = freshState({ mission: draftMission({ objective: 'Bearer abcdefghijklmnop 请检查' }) })
  const brief = assembleBrief(state, writeCheckpoint(state, {}), facts())
  assert.equal(brief.markdown.includes('abcdefghijklmnop'), false)
})
