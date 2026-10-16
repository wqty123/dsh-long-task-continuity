/**
 * 测试夹具：所有用例共用的最小合法记录与推进助手（设计稿 v0.3 §5.1）。
 *
 * 文件名不匹配 `*.test.ts`，因此 `node --test test/*.test.ts` 不会把它当作用例执行。
 *
 * v0.3 的关键变化：`completionCriteria` 词表退役，实体侧用 `criteria: readonly Criterion[]`
 * （ID 由内核 `mintCriteria` 盖），命令侧用 `CriterionInput[]`；Mission 增加 `budgetBasis`
 * 与 `policyRevision`（§13：限额依据必须署名来源，不拿平台上限当无限）。
 */
import { dispatch } from '../src/core/commands.ts'
import type { Command, CommandContext, TaskProposal } from '../src/core/commands.ts'
import type { MissionControl } from '../src/core/control.ts'
import { emptyControl } from '../src/core/control.ts'
import type { ActorRole, Checkpoint, CriterionInput, Mission, Task } from '../src/core/entities.ts'
import { mintCriteria } from '../src/core/entities.ts'

export const NOW = 1_700_000_000_000

export function draftMission(overrides: Partial<Mission> = {}): Mission {
  return {
    missionId: 'mss_test',
    objective: '把连续性台账跑通',
    constraints: ['不得改动业务仓库'],
    constraintSources: ['用户 2026-10-14 指令'],
    criteria: mintCriteria([{ text: '命令全部返回' }, { text: '轮换走到 ACTIVE' }]),
    objectiveRevision: 1,
    policyRevision: 1,
    budgetBasis: { kind: 'user', ref: '用户 2026-10-14 指令' },
    status: 'draft',
    collaboration: 'solo',
    permissionRef: 'host:default',
    allowAutoResume: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/** `emptyControl` 的 admissionClosed 是 true：冷启动默认扣住，用例要显式放开业务入场。 */
export function freshState(overrides: Partial<MissionControl> = {}): MissionControl {
  return { ...emptyControl('mss_test', draftMission(), NOW), admissionClosed: false, ...overrides }
}

export function ctx(role: ActorRole, actorId = 'actor-1'): CommandContext {
  return { actorId, role, now: NOW }
}

let counter = 0
/** 每个请求需要唯一 ID；复用会被去重表判成重放，用例就测不到转换本身。 */
export function req(prefix = 'req'): string {
  counter += 1
  return `${prefix}-${counter}`
}

/** 任务书输入 = 命令侧 `TaskProposal`：ID、状态、validity、各修订号一律由内核盖（§5.1）。 */
export type TaskPayload = TaskProposal

export function taskPayload(overrides: Partial<TaskPayload> = {}): TaskPayload {
  return {
    dependsOn: [],
    title: '冒烟任务',
    scope: '只读核对装配',
    exclusions: [],
    inputRefs: [],
    criteria: [{ text: '脚本断言全部通过' }] satisfies readonly CriterionInput[],
    priority: 5,
    resourceKeys: [],
    maxAttempts: 3,
    ...overrides,
  }
}

/**
 * `task.checkpoint` 命令侧载荷（src/core/commands.ts:394）：
 * objectiveRevision/policyRevision/criteriaRevision/basisRevision/openChallengeIds/openObligationIds
 * 全部由内核从记录推导，调用方自报的"没有待办"不作数（§9.1、§22.4）。
 */
type CheckpointPayload = Omit<
  Checkpoint,
  | 'checkpointId' | 'missionId' | 'writtenAt' | 'sourceRevision' | 'attemptId' | 'actorId' | 'taskId'
  | 'objectiveRevision' | 'policyRevision' | 'criteriaRevision' | 'basisRevision' | 'openChallengeIds' | 'openObligationIds'
> & { readonly attemptId?: string }

export function checkpointPayload(overrides: Partial<CheckpointPayload> = {}): CheckpointPayload {
  return {
    step: '已跑到 claim',
    nextAction: '手动轮换一次',
    verifiedProgress: [],
    inProgress: [],
    decisions: [],
    blockers: [],
    inFlightOperations: [],
    openQuestions: [],
    contextRefs: [],
    ...overrides,
  }
}

/** 应用一条命令并在被拒时直接失败：夹具里的每一步都必须是合法转换。 */
export function apply(state: MissionControl, cmd: Command, context: CommandContext = ctx('supervisor')): MissionControl {
  const result = dispatch(state, cmd, context)
  if (!result.applied) throw new Error(`夹具命令 ${cmd.kind} 被拒：${result.reason}`)
  return result.state
}

/** 推进到"Lead 已认领任务并写好检查点"，供轮换与收口相关用例复用。 */
export function withClaimedTask(): { readonly state: MissionControl; readonly taskId: string; readonly attemptId: string } {
  let state = freshState()
  state = apply(state, { kind: 'mission.create', requestId: req(), mission: draftMission() })
  state = apply(state, { kind: 'actor.register', requestId: req(), actorId: 'lead-1', role: 'lead', label: 'Lead', sessionId: 'sess-1' })
  state = apply(state, { kind: 'task.propose', requestId: req(), task: taskPayload() })
  const taskId = Object.keys(state.tasks)[0]!
  state = apply(state, { kind: 'task.approve', requestId: req(), taskId }, ctx('user', 'human'))
  state = apply(state, { kind: 'task.claim', requestId: req(), taskId }, ctx('lead', 'lead-1'))
  const attemptId = state.tasks[taskId]!.currentAttemptId!
  return { state, taskId, attemptId }
}
