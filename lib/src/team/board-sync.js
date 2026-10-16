import { boardTasksOf, mirrorRows, planMirror } from './board-mirror.js';
/**
 * 把动作打到任务板上。
 * @param board - 宿主 `agentTeams` 服务面。
 * @param caller - 活体 Lead Agent（授权凭据）。
 * @param op - 规划出的单个写入动作。
 * @returns 宿主提交后的任务视图（本层不使用，只保证 await 到落盘）。
 */
async function applyOp(board, caller, op) {
    if (op.kind === 'create')
        return await board.createTask(caller, { subject: op.subject, description: op.description });
    if (op.kind === 'edit') {
        return await board.updateTask(caller, {
            taskId: op.id,
            expectedRevision: op.expectedRevision,
            action: 'edit',
            subject: op.subject,
            description: op.description,
        });
    }
    return await board.updateTask(caller, { taskId: op.id, expectedRevision: op.expectedRevision, action: op.kind });
}
/**
 * 建一个任务板同步器：单飞（同一时刻只跑一轮）+ 同一原因只报一次（30 秒节拍不刷屏）。
 * @param sources - 现读的服务 / 活体 Lead Agent / 台账投影。
 * @param log - 日志出口。
 * @param maxRounds - 单轮最多重规划几次，防止两个写入者互相顶牛时无限写事件。
 * @returns 带 `run()` 的同步器；`run()` 永远不抛。
 */
export function createTeamBoardSyncer(sources, log, maxRounds = 6) {
    let running = false;
    let lastReason = '';
    const report = (result) => {
        // 空转且原因没变时不出声：30 秒一拍的"没有活体 Agent"不该把日志淹掉。
        if (result.ops === 0 && result.reason === lastReason)
            return result;
        lastReason = result.reason;
        const line = `任务板同步：${result.reason}，写入 ${result.ops} 次${result.detail === undefined ? '' : `（${result.detail}）`}`;
        if (result.reason === 'converged')
            log.info(line);
        else
            log.warn(line);
        return result;
    };
    return {
        async run() {
            if (running)
                return report({ ops: 0, reason: 'already-running' });
            running = true;
            let ops = 0;
            try {
                const board = sources.board();
                if (board === undefined)
                    return report({ ops, reason: 'no-agent-teams-service' });
                const caller = await sources.leadAgent();
                if (caller === undefined)
                    return report({ ops, reason: 'no-live-lead-agent' });
                const ledger = await sources.ledger();
                if (ledger === null)
                    return report({ ops, reason: 'no-mission-record' });
                const rows = mirrorRows(ledger);
                for (let round = 0; round < maxRounds; round += 1) {
                    let current;
                    try {
                        current = boardTasksOf(board.listTasks(caller));
                    }
                    catch (error) {
                        return report({ ops, reason: 'list-failed', detail: String(error) });
                    }
                    const plan = planMirror(rows, current);
                    if (plan.length === 0)
                        return report({ ops, reason: 'converged' });
                    for (const op of plan) {
                        try {
                            await applyOp(board, caller, op);
                            ops += 1;
                        }
                        catch (error) {
                            // 一次抛错就停：revision 冲突说明别的写入者正在改，下一轮按最新板面重算。
                            return report({ ops, reason: 'op-failed', detail: `${op.kind}: ${String(error)}` });
                        }
                    }
                }
                return report({ ops, reason: 'round-limit' });
            }
            catch (error) {
                // 台账读取等外围失败也不能上抛：调用方是节拍器，不是任务板的下游。
                return report({ ops, reason: 'op-failed', detail: String(error) });
            }
            finally {
                running = false;
            }
        },
    };
}
