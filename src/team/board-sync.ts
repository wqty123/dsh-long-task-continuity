/**
 * 台账 → 原生 Agent Team 任务板 的写入侧（宿主面收窄 + 单飞 + 只在真变化时写事件）。
 *
 * 权威只有控制记录：这一层不发命令、不判定，只把 `views/export.ts:missionLedger` 的投影
 * 收敛到任务板上；任务板被用户或别的代理改乱也不会反过来污染台账（下一轮按台账重算）。
 *
 * 依赖面（dsh: `packages/experimental/agent-team/src/index.ts:170/189/199`）：
 * `createTask(caller, …)` / `listTasks(caller)` / `updateTask(caller, …)` 都要求 **caller 是活体
 * Lead Agent**——`roster.tryMembership` 对没有父会话（或父会话已不在 Agent 注册表）的活体 Agent
 * 直接给出 `role:'lead'` 的隐式成员身份（dsh: `packages/experimental/agent-team/src/roster.ts:92-115`），
 * 所以插件不必先 `spawn_teammate` 就能建板；会话正在运行时才有活体 Agent，取不到就本轮跳过。
 *
 * 失败口径：任何一次抛错都只记一条警告并停止本轮，不重试、不抛给宿主——任务板是派生视图，
 * 写失败不能把台账的事件循环或轮换带崩。
 */
import type { AgentLike } from '../adapter/host-types.ts'
import type { MissionLedger } from '../views/export.ts'
import { boardTasksOf, mirrorRows, planMirror, type BoardTaskView, type MirrorOp } from './board-mirror.ts'

/** 宿主 `agentTeams` 服务里本层用到的三个方法（形状收窄，全部按不可信读取）。 */
export interface TeamBoardLike {
  listTasks(caller: AgentLike): readonly unknown[]
  createTask(caller: AgentLike, request: { readonly subject: string; readonly description: string }): Promise<unknown>
  updateTask(
    caller: AgentLike,
    request: {
      readonly taskId: string
      readonly expectedRevision: number
      readonly action: string
      readonly subject?: string
      readonly description?: string
    },
  ): Promise<unknown>
}

/** 同步器要现读的三件事：服务、活体 Lead Agent、台账投影。每次调用都重新取，不快照。 */
export interface BoardSyncSources {
  board(): TeamBoardLike | undefined
  /**
   * 活体 Lead Agent。允许异步：宿主侧要先读控制记录才知道 Lead 绑在哪个会话，
   * 而 `agents().get()` 只在会话真的在跑时才给得出对象。
   */
  leadAgent(): AgentLike | undefined | Promise<AgentLike | undefined>
  ledger(): Promise<MissionLedger | null>
}

/** 同步器的日志出口（与插件 `ctx.logger` 同形，只用到 info/warn）。 */
export interface BoardSyncLog {
  info(message: string): void
  warn(message: string): void
}

/** 一轮同步的结论，供状态页与日志使用。 */
export interface BoardSyncResult {
  readonly ops: number
  readonly reason: string
  readonly detail?: string
}

/**
 * 把动作打到任务板上。
 * @param board - 宿主 `agentTeams` 服务面。
 * @param caller - 活体 Lead Agent（授权凭据）。
 * @param op - 规划出的单个写入动作。
 * @returns 宿主提交后的任务视图（本层不使用，只保证 await 到落盘）。
 */
async function applyOp(board: TeamBoardLike, caller: AgentLike, op: MirrorOp): Promise<unknown> {
  if (op.kind === 'create') return await board.createTask(caller, { subject: op.subject, description: op.description })
  if (op.kind === 'edit') {
    return await board.updateTask(caller, {
      taskId: op.id,
      expectedRevision: op.expectedRevision,
      action: 'edit',
      subject: op.subject,
      description: op.description,
    })
  }
  return await board.updateTask(caller, { taskId: op.id, expectedRevision: op.expectedRevision, action: op.kind })
}

/**
 * 建一个任务板同步器：单飞（同一时刻只跑一轮）+ 同一原因只报一次（30 秒节拍不刷屏）。
 * @param sources - 现读的服务 / 活体 Lead Agent / 台账投影。
 * @param log - 日志出口。
 * @param maxRounds - 单轮最多重规划几次，防止两个写入者互相顶牛时无限写事件。
 * @returns 带 `run()` 的同步器；`run()` 永远不抛。
 */
export function createTeamBoardSyncer(
  sources: BoardSyncSources,
  log: BoardSyncLog,
  maxRounds = 6,
): { run(): Promise<BoardSyncResult> } {
  let running = false
  let lastReason = ''
  const report = (result: BoardSyncResult): BoardSyncResult => {
    // 空转且原因没变时不出声：30 秒一拍的"没有活体 Agent"不该把日志淹掉。
    if (result.ops === 0 && result.reason === lastReason) return result
    lastReason = result.reason
    const line = `任务板同步：${result.reason}，写入 ${result.ops} 次${result.detail === undefined ? '' : `（${result.detail}）`}`
    if (result.reason === 'converged') log.info(line)
    else log.warn(line)
    return result
  }
  return {
    async run(): Promise<BoardSyncResult> {
      if (running) return report({ ops: 0, reason: 'already-running' })
      running = true
      let ops = 0
      try {
        const board = sources.board()
        if (board === undefined) return report({ ops, reason: 'no-agent-teams-service' })
        const caller = await sources.leadAgent()
        if (caller === undefined) return report({ ops, reason: 'no-live-lead-agent' })
        const ledger = await sources.ledger()
        if (ledger === null) return report({ ops, reason: 'no-mission-record' })
        const rows = mirrorRows(ledger)
        for (let round = 0; round < maxRounds; round += 1) {
          let current: BoardTaskView[]
          try {
            current = boardTasksOf(board.listTasks(caller))
          } catch (error: unknown) {
            return report({ ops, reason: 'list-failed', detail: String(error) })
          }
          const plan = planMirror(rows, current)
          if (plan.length === 0) return report({ ops, reason: 'converged' })
          for (const op of plan) {
            try {
              await applyOp(board, caller, op)
              ops += 1
            } catch (error: unknown) {
              // 一次抛错就停：revision 冲突说明别的写入者正在改，下一轮按最新板面重算。
              return report({ ops, reason: 'op-failed', detail: `${op.kind}: ${String(error)}` })
            }
          }
        }
        return report({ ops, reason: 'round-limit' })
      } catch (error: unknown) {
        // 台账读取等外围失败也不能上抛：调用方是节拍器，不是任务板的下游。
        return report({ ops, reason: 'op-failed', detail: String(error) })
      } finally {
        running = false
      }
    },
  }
}
