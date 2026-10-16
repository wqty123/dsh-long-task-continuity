/**
 * 状态模型的逻辑实体（设计稿 v0.3 §5.1、§21–22）。
 *
 * 这里只有类型与状态词表，没有行为：行为在内核的转换函数里。
 * 全部为可擦除语法（`erasableSyntaxOnly`），因此 `node --test` 可以直接跑 `.ts`，不需要先构建。
 *
 * v0.3 相对 v0.2 的变化集中在两层：
 * 1. 词表加宽——Verification 从三值到六值、结果有效性 `validity` 独立于业务状态、
 *    消息的投递状态与处理状态分开、Mission/Task 各自带 policy/spec/criteria 修订号；
 * 2. 证据与纪律面对象——RuleSpec / AuthorityBinding / EvidenceRecord / ClaimRevision /
 *    DecisionDependency / Obligation / AuthorizationGrant / SearchReceipt / ContextReceipt /
 *    Challenge / Incident，另加 §22.9 的 ReviewReceipt、§22.10 的 ValidatorSpec、
 *    §22.14 的 DeliveryEntry 和 §7.1 的 DispatchPlan。
 */
export const MISSION_TERMINAL = ['completed', 'failed', 'cancelled'];
export const TASK_TERMINAL = ['completed', 'failed', 'cancelled'];
export const ATTEMPT_TERMINAL = ['settled', 'failed', 'cancelled'];
/** 只有 pass 代表通过；其余五值各自表达"没通过"的不同原因（§6.4）。 */
export const PASSING_OUTCOMES = ['pass'];
export const INEFFECTIVE_RESULTS = ['needs_review', 'invalid'];
export function mintCriteria(criteria) {
    return criteria.map((item, index) => ({
        criterionId: `crit_${index + 1}`,
        text: item.text,
        required: item.required ?? true,
        ...(item.applicabilityRule === undefined ? {} : { applicabilityRule: item.applicabilityRule }),
    }));
}
export const DEFAULT_BUDGET_LIMITS = {
    maxModelCalls: 4000,
    maxTotalTokens: 40_000_000,
    maxWallClockMs: 120 * 60 * 60 * 1000,
    maxConcurrentActors: 4,
    maxTaskRetries: 3,
    maxRotationPerHour: 3,
    maxMailboxMessages: 600,
};
/** 认领心跳/租约候选值（§15.1）；到期只触发核对，不直接授予新执行权。 */
export const LEASE_HEARTBEAT_MS = 15_000;
export const LEASE_EXPIRY_MS = 90_000;
