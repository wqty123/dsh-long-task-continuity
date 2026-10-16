/**
 * 宿主运行时的**结构化视图**（不 import 任何 `@deepseek-ai/*`）。
 *
 * 为什么这么写：本包在装载进 DSH 之前必须能独立编译与测试，而内核判定不该依赖宿主类型。
 * 这些视图刻意只声明用到的成员（照 `qingyou002/dsh-auto-handoff` 的 `Raw*` 窄视图做法），
 * 真机上传入真实 `ctx` 即可结构匹配；装载时要逐项核对 `capabilities.ts` 的探针结论。
 *
 * ⚠️ 结构一致 ≠ 语义一致。签名口径来自本机 `<DSH 源码>` @ v0.2.1-alpha.1 的源码摘录，
 * 未在运行时组合与故障注入下验证过。
 */
export function agentTools(agent) {
    const ctx = agent.ctx;
    return ctx?.tools;
}
