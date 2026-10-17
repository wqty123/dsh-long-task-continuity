/**
 * `dsh-long-task-continuity` 宿主入口（设计稿 v0.3 §4、§13、§16）。
 *
 * 包里**唯一**装配运行时的文件是这一份；`src/core`、`src/rotation`、`src/team` 纯数据，`src/adapter`、`src/views` 只接结构化视图。
 * 唯一真 import 宿主的例外是 `src/adapter/tools.ts:18`（只为 `defineTool` 这一个构造口，不碰运行时装配）。
 * 这样切是为了装载之前就能用 `node --test` 跑完全部判定逻辑。
 *
 * 六个刻意的选择，每条都有出处：
 * 1. **可选服务一律 live reader**（`ctx.get` 每次现读），不在 `apply()` 里快照。Loader 并发组合
 *    兄弟条目，注入十个服务的 `sessionController` 常常在本插件之后才发布；一次性快照会把
 *    "部署正常"读成"服务缺席"（`qingyou002/dsh-auto-handoff` 踩过的坑，MIT）。
 * 2. **自动轮换默认关闭，且再受探针门禁**：`gateAutomation` 未通过时即使开关打开也只出观察数据
 *    （§16 的九项待验证里，`compaction-coordination` 这类"无公开读取口径"的项按定义过不了）。
 * 3. **模型可见工具与准入守卫默认不注册**：挂载这个动作本身不该改变会话的上下文税，
 *    也不该因为身份映射猜错而拦掉正常干活。
 * 4. `.volatile()` 字段到手是引用而不是值，所以每次判定前重新 `normalize()`（`adapter/services.ts`）。
 * 5. **静默核对只用能证据化的信号**：本部署给不出的四个前置项（原生子代理结算、外部副作用、
 *    待处理输入、登记队列）一律 `null` 并按未满足处理（`safeToHandoff`）；
 *    唯一的例外是 `managedToolsRunning`，它的 `null` 只表示本部署没有这个观测面，
 *    在跑与否由布尔型的 `stepRunning` 把关。
 * 6. **轮换线的 R/H/r 三项要由设置声明**：v0.2.1-alpha.1 没有公开读取口径（生效压缩参数住在
 *    compaction-basic 自己的 volatile config，`packages/compaction/compaction-basic/src/config.ts:75`），
 *    未声明 ⇒ `observation`，自动侧不换会话（§10.1 fail-closed 规则一）。手动 `/continuity rotate` 不走这条判定。
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import Schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import { SCHEMA_VERSION, mintId, planClosedRecordDrops } from './core/control.js';
import { ContinuityKernel } from './core/kernel.js';
import { CommandQueue, HostLock } from './core/queue.js';
import { DomainStore } from './core/store.js';
import { ARCHIVE_TABLE, archiveExpectation, pendingEventArchive, readArchiveSnapshot, sweepArchive } from './core/archive.js';
import { bootRecover } from './core/recovery.js';
import { canRotate } from './core/budget.js';
import { missionCompletion } from './core/completion.js';
import { revisionDrifts } from './core/discipline.js';
import { isTerminalAttempt } from './core/lease.js';
import { readOccupancy, rotationLine } from './rotation/lines.js';
import { StopLatch } from './rotation/latch.js';
import { SessionWatermark, decideRotation, initialGuardState, nextTurn, reduceGuard, } from './rotation/policy.js';
import { ToolEventLedger, factsFromLedger } from './rotation/facts.js';
import { assembleBrief } from './rotation/brief.js';
import { safeToHandoff } from './rotation/fsm.js';
import { formatReport, gateAutomation, probeAll } from './adapter/capabilities.js';
import { MAIL_MARKER, SEED_MARKER, confirmSeed, deliverSeed, preStepGuard, readPressure, readTurnBoundary, toolGuard, memberCreationGuard, } from './adapter/dsh.js';
import { MIRRORED_COMPACT_HEADROOM_TOKENS, MIRRORED_COMPACT_THRESHOLD_RATIO, pressureVerdict, readContextReadings, } from './adapter/dsh-context.js';
import { archiveReader, archiveSink, plainConfig, safeNumber, safeRatio } from './adapter/services.js';
import { PLUGIN_TOOL_NAMES, ReplayGuard, commandToolFactories, continuityCheckpointTool, continuityHistoryTool, continuityStatusTool } from './adapter/tools.js';
import { abandonRotation, runRotation } from './adapter/rotation-runner.js';
import { normalizeNativeTasks, nativeTeamIdentity, teamMemberOf } from './adapter/agent-teams.js';
import { compactionPort } from './adapter/compaction.js';
import { frameFromReadings, postCompactionObservation, retentionListFromState, runQualityChain } from './adapter/quality-runner.js';
import { missionLedger, renderMissionMarkdown, renderRecoveryMarkdown, renderTimelineMarkdown } from './views/export.js';
import { WORKBENCH_PATH, missionWorkbench } from './views/workbench.js';
import { DISCIPLINE_PATH, disciplineView } from './views/discipline.js';
import { createTeamBoardSyncer } from './team/board-sync.js';
/** Loader 诊断名，与 `cordis.patch.yml` 的行 id 一致。 */
export const name = 'dsh-long-task-continuity';
/** 与 `package.json` 同步维护。状态行要能回答"现在跑的是哪一版、从哪一份文件装载"（审阅 R8）。 */
export const PLUGIN_VERSION = '0.2.7';
/** 只有这两个是硬依赖：没有存储就无所谓台账，没有命令注册表就没有 `/continuity`。 */
export const inject = ['storageDomain', 'commands'];
/** Connection 共享通道上的只读台账路由；浏览器侧用去掉前导斜杠的文档相对形式 `api/continuity.ledger`。 */
export const LEDGER_PATH = '/api/continuity.ledger';
/**
 * 设置项。每个字段都 `.default()` 且 `.volatile()`：
 * `dsh-settings` 用 `volatileForm(schema)` 决定有没有设置页，一个 volatile 字段都没有时宿主直接抛
 * `Plugin entry "<ns>" has no volatile fields`（dsh-context-guard 实测踩过的坑）。
 * `.volatile()` 同时意味着改完立即生效，不需要重启——因此下面所有判定都重新 `normalize()`。
 */
export const Config = Schema.object({
    enabled: Schema.boolean()
        .default(true)
        .description('Master switch. Off = no listeners, no writes, no tools. / 总开关。关掉后不订阅、不写、不注册工具。')
        .volatile(),
    missionId: Schema.string()
        .default('')
        .description('Mission this host instance works on; empty = none until /continuity open. / 本实例绑定的 Mission；留空表示还没开。')
        .volatile(),
    autoRotationEnabled: Schema.boolean()
        .default(false)
        .description('Automatic session rotation. Keep off until the capability probes (§16) pass on this deployment; ' +
        'off means the plugin only reports the observed rotation line. / 自动换会话。§16 探针没在真机过之前保持关闭；' +
        '关闭时只报观察到的轮换线，不动会话。')
        .volatile(),
    probesAcknowledged: Schema.boolean()
        .default(false)
        .description('Operator attestation that the §16 live checks (turn-boundary, pressure reader, create/adopt, seed receipt, guard coverage) ' +
        'were run on THIS deployment. Probes stay partial by design because they cannot be settled statically, so without this ' +
        'switch automatic rotation and the admission guard can never arm. / 操作者确认：§16 的实测项已在本部署逐项核对过。' +
        '探针按定义给不出全绿（语义只能在真会话上核对），没有这个开关，自动轮换与准入守卫永远无法入场。')
        .volatile(),
    rotateRatio: Schema.number()
        .min(0.1)
        .max(0.95)
        .default(0.6)
        .description('p in T = min(floor(p*W), C-M), as a share of the declared window. / 轮换比例 p（占声明窗口 W 的份额）。')
        .volatile(),
    handoffMarginTokens: Schema.number()
        .min(1024)
        .default(8192)
        .description('M: tokens the handoff package plus its first step may occupy. / 交接包加首步的余量 M。')
        .volatile(),
    outputReserveTokens: Schema.number()
        .min(0)
        .default(0)
        .description('R in C = floor(min(r*W, W-R-H)). 0 = not declared: the plugin then reads R from this session\'s own request header (config.maxTokens) ' +
        'and, when dsh-context is loaded, from contextTimeline.maxOutputTokens — both are last-wins envelope readings, not the effective ' +
        'compaction config, so a declared value here always wins. / R：当前请求的输出预留。0=未声明⇒改读本会话 requestHeader 的 ' +
        'config.maxTokens，dsh-context 在装载时再读 contextTimeline.maxOutputTokens；两者都是请求信封的 last-wins 读数、不等于生效配置，' +
        '所以此处声明值优先。三者都给不出时轮换线停在观察模式，不猜。')
        .volatile(),
    compactionHeadroomTokens: Schema.number()
        .min(0)
        .default(0)
        .description('H in the same formula: tokens native compaction keeps free. 0 = not declared (observation): dsh-context does not publish H either, ' +
        'it mirrors compaction-basic\'s factory default. / H：原生压缩保留的余量。0=未声明⇒观察模式：dsh-context 也不发布 H，' +
        '它只是照抄 compaction-basic 的出厂默认。要改用那个镜像值请显式打开 acceptMirroredCompactionDefaults。')
        .volatile(),
    compactionRatio: Schema.number()
        .min(0)
        .max(1)
        .default(0)
        .description('r in the same formula: the occupancy at which native compaction triggers. The shipped default on this host is 0.8, but the effective value ' +
        'lives in compaction-basic\'s own volatile config with no read API, so 0 here means "not declared" rather than inheriting that default. ' +
        '/ r：原生压缩触发占用率。本机出厂默认 0.8，但生效值住在 compaction-basic 自己的 volatile config、没有读取接口，' +
        '因此这里的 0 表示"未声明"，不默认继承 0.8。')
        .volatile(),
    acceptMirroredCompactionDefaults: Schema.boolean()
        .default(false)
        .description('Let H and r fall back to compaction-basic\'s factory defaults (65536 / 0.8) when neither is declared. These are values this package ' +
        'copies, NOT reads: dsh-context copies them the same way, and the effective config still lives in a volatile setting with no read API, ' +
        'so the ledger labels them mirrored-default and the native compaction config remains authoritative. Off by default: automatic rotation ' +
        'stays in observation until the numbers are either declared or explicitly accepted as mirrored. / 允许 H 与 r 在未声明时改用 ' +
        'compaction-basic 的出厂默认（65536 / 0.8）。那是本包抄来的值、不是读来的：dsh-context 也同样是抄，生效配置依旧住在没有读取接口的 ' +
        'volatile config 里，因此台账一律标 mirrored-default，原生压缩配置才是准。默认关：口径未声明也未显式接受时，自动轮换停在观察模式。')
        .volatile(),
    warnRatio: Schema.number()
        .min(0.1)
        .max(0.95)
        .default(0.45)
        .description('Occupancy that means "wrap up". Always a ratio, never absolute tokens. / 「该收尾了」的占用率，一律用比率。')
        .volatile(),
    hardRatio: Schema.number()
        .min(0.1)
        .max(1)
        .default(0.6)
        .description('Occupancy that means "switch session". Must exceed warnRatio. / 「该换会话了」的占用率，须大于 warnRatio。')
        .volatile(),
    cooldownTurns: Schema.number().min(0).max(100).step(1).default(5)
        .description('Turns of silence after a level crossing. / 跨档后的静默轮数。')
        .volatile(),
    minTurnsBetweenRotations: Schema.number().min(1).max(200).step(1).default(8)
        .description('Minimum turns between two rotations of the same actor. / 同一 Actor 两次轮换之间的最少轮数。')
        .volatile(),
    maxRotationPerHour: Schema.number().min(0).max(20).step(1).default(3)
        .description('Rotation insurance per actor per hour (not per lifetime). / 每 Actor 每小时轮换保险上限（不是每生命周期）。')
        .volatile(),
    boundarySlowMs: Schema.number().min(1000).default(30_000)
        .description('When a quiet-boundary wait starts telling the user it is slow. Never aborts. / 等待边界多久开始报"慢"。不中止。')
        .volatile(),
    boundaryDeadlineMs: Schema.number().min(5000).default(180_000)
        .description('Hard backstop for the quiet-boundary wait; gives up and releases the latch. / 等待边界的硬上限，超时即释放闩。')
        .volatile(),
    migrateSchedules: Schema.boolean().default(true)
        .description('Move scheduled tasks to the new session before committing a rotation. / 提交轮换前把定时任务迁到新会话。')
        .volatile(),
    rearmGoal: Schema.boolean().default(false)
        .description('Re-arm the native goal in the new session. Off = the seed message alone drives continuation. / 在新会话重新装载原生 goal。关=只靠启动消息接续。')
        .volatile(),
    enforceAdmission: Schema.boolean().default(false)
        .description('Register a tools.guard that denies managed writes for actors without a live lease. Off by default: ' +
        'a wrong identity mapping would block real work. / 注册 tools.guard，无有效租约的 Actor 不许执行受管写入。默认关：' +
        '身份映射错会误伤正常干活。')
        .volatile(),
    registerTools: Schema.boolean().default(false)
        .description('Register the model-visible continuity_* tools (status / checkpoint / the command entries / history read-back). / ' +
        '注册模型可见的 continuity_* 工具（状态、检查点、命令入口与历史回读）。默认关。')
        .volatile(),
    outboxDrainMs: Schema.number().min(0).default(0)
        .description('Outbox drain interval; 0 = drain only on /continuity drain or rotation commit. / outbox 消费周期，0 表示只在显式动作时消费。')
        .volatile(),
    leaseHeartbeatMs: Schema.number().min(1000).default(15_000)
        .description('Lease heartbeat interval. / 租约续期节拍。')
        .volatile(),
    leaseExpiryMs: Schema.number().min(5000).default(90_000)
        .description('Lease expiry; expiry means "reconcile", never "preempt". / 租约到期口径；到期=需核对，不等于可抢占。')
        .volatile(),
    teamBoardMirror: Schema.boolean().default(false)
        .description('Mirror the ledger onto the native agent-team task board. OFF BY DEFAULT: those board rows are display-only ' +
        'clauses authored by the Lead, so every real executor shows up as Lead-claimed and the native queue cannot ' +
        'see our dependencies (review R6). The Fleet page keeps showing real team tasks; the ledger is read through ' +
        '/api/continuity.ledger instead. / 把台账投影写进原生任务板。默认关：那些行只是"给看的"，caller 统一是 Lead，' +
        '于是所有真实执行都显示成 Lead 领取，且原生队列看不到我们的依赖（审阅 R6）。编队页继续只显示真实团队任务；' +
        '台账改走 /api/continuity.ledger 的只读投影。')
        .volatile(),
    teamBoardMirrorMs: Schema.number().min(0).default(30_000)
        .description('Mirror beat; 0 = only on /continuity board. / 投影节拍，0 表示只在显式命令时收敛。')
        .volatile(),
    teamBoardMirrorSession: Schema.string().default('')
        .description('Session whose live agent authors the board rows. Empty = the Lead actor\'s bound session. ' +
        'Set it to a running session if the Lead session is closed, otherwise the mirror has no caller. ' +
        '/ 写任务板时充当 caller 的会话；留空用 Lead Actor 绑定的会话。Lead 会话已关就把这里指向一个在跑的会话，否则取不到活体 Agent，投影不动。')
        .volatile(),
    replayWindowMs: Schema.number().min(0).default(120_000)
        .description('Suspected-replay window for continuity write commands: a command whose content already landed within this ' +
        'window is held back for reconciliation instead of applied again. Needed because a `run_code` program is ' +
        'never replayed automatically, yet its deadline (default 120s, max 600s) covers nested calls and approval ' +
        'waits — so the write can land while the program only sees a timeout, and the revision-carrying requestId ' +
        'makes the retry look new. 0 = off. Widen it together with ptc-runtime maxTimeoutMs. ' +
        '/ continuity 写命令的疑似重放窗口：同内容命令在窗口内已经落地过，就退回"先核对"而不是再写一次。 ' +
        '需要它是因为 `run_code` 程序不会被自动回放，而它的截止时间（默认 120 秒、上限 600 秒）把子调用与审批等待都算在内' +
        '——命令可能已落进台账、程序却只收到超时，此时含修订号的 requestId 会让重试看起来是新请求。0 表示关闭；' +
        '调高 ptc-runtime 的 maxTimeoutMs 时把这里一起调宽。')
        .volatile(),
    hostLockPath: Schema.string().default('')
        .description('Single-writer lock file path (review R3). Empty = disabled. When set, a host that cannot take the lock mounts ' +
        'in no-op mode instead of writing the same storageDomain as another live process. Takes effect on (re)mount. ' +
        '/ 单写者锁文件路径（审阅 R3）。留空=不启用。声明后，拿不到锁的宿主进入无操作模式，绝不与另一个存活进程并行写同一份存储域。换锁需重新装载。')
        .volatile(),
});
function normalize(raw) {
    const value = plainConfig(raw);
    const bool = (key, fallback) => (typeof value[key] === 'boolean' ? value[key] : fallback);
    const pick = (key, fallback) => safeNumber(value[key], fallback);
    /** 线口径的三项：0 一律读成"未声明"，不当真值用；`r` 允许取到 1（safeRatio 的上界是开区间）。 */
    const declaredRatio = (key) => {
        const raw2 = value[key];
        return typeof raw2 === 'number' && Number.isFinite(raw2) && raw2 > 0 && raw2 <= 1 ? raw2 : 0;
    };
    return {
        enabled: bool('enabled', true),
        missionId: typeof value.missionId === 'string' ? value.missionId.trim() : '',
        autoRotationEnabled: bool('autoRotationEnabled', false),
        probesAcknowledged: bool('probesAcknowledged', false),
        rotateRatio: safeRatio(value.rotateRatio, 0.6),
        handoffMarginTokens: pick('handoffMarginTokens', 8192),
        outputReserveTokens: pick('outputReserveTokens', 0),
        compactionHeadroomTokens: pick('compactionHeadroomTokens', 0),
        compactionRatio: declaredRatio('compactionRatio'),
        acceptMirroredCompactionDefaults: bool('acceptMirroredCompactionDefaults', false),
        warnRatio: safeRatio(value.warnRatio, 0.45),
        hardRatio: safeRatio(value.hardRatio, 0.6),
        cooldownTurns: pick('cooldownTurns', 5),
        minTurnsBetweenRotations: pick('minTurnsBetweenRotations', 8),
        maxRotationPerHour: pick('maxRotationPerHour', 3),
        boundarySlowMs: pick('boundarySlowMs', 30_000),
        boundaryDeadlineMs: pick('boundaryDeadlineMs', 180_000),
        migrateSchedules: bool('migrateSchedules', true),
        rearmGoal: bool('rearmGoal', false),
        enforceAdmission: bool('enforceAdmission', false),
        registerTools: bool('registerTools', false),
        outboxDrainMs: pick('outboxDrainMs', 0),
        leaseHeartbeatMs: pick('leaseHeartbeatMs', 15_000),
        leaseExpiryMs: pick('leaseExpiryMs', 90_000),
        teamBoardMirror: bool('teamBoardMirror', false),
        teamBoardMirrorMs: pick('teamBoardMirrorMs', 30_000),
        teamBoardMirrorSession: typeof value.teamBoardMirrorSession === 'string' ? value.teamBoardMirrorSession.trim() : '',
        replayWindowMs: pick('replayWindowMs', 120_000),
        hostLockPath: typeof value.hostLockPath === 'string' ? value.hostLockPath.trim() : '',
    };
}
/**
 * 记录级 zod 校验只覆盖**信封**（schemaVersion / revision / missionId），
 * 深层结构由 `store.ts` 的 `assertShape` 与内核转换自己保证。
 * 这样 `MissionControl` 加字段不必同步改 zod 树，老记录也不会被误判成非法。
 */
const controlEnvelope = z
    .object({
    schemaVersion: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    missionId: z.string().min(1),
})
    .passthrough();
/**
 * 归档批次的信封校验（审阅 R4）。键与区间决定"是不是同一批"，所以这两组字段必须过闸；
 * `events`/`records` 的内容完整性由批次自带的 `contentHash` 管（`archive.ts` 的 `verifyBatch`），
 * 不在这里逐条展开——归档对象的形状会随事件词表演进，逐条校验会把加字段变成迁移事件。
 */
const archiveEnvelope = z
    .object({
    batchId: z.string().min(1),
    missionId: z.string().min(1),
    kind: z.enum(['events', 'closed-records']),
    fromSeq: z.number().int(),
    toSeq: z.number().int(),
    count: z.number().int().nonnegative(),
    committedAt: z.number().int().nonnegative(),
    contentHash: z.string().min(1),
    location: z.string().min(1),
})
    .passthrough();
const continuityDomain = defineDomain({
    name: 'continuity',
    version: 1,
    layout: 'per-record',
    tables: {
        missions: domainTable(controlEnvelope),
        archive: domainTable(archiveEnvelope),
    },
});
/** 已过提交点的阶段：人类输入这时必须改道到 S2，而不是退回 S1。 */
const AFTER_COMMIT = new Set(['COMMITTED', 'ACTIVATING', 'ACTIVE']);
// 启动消息与普通投递的边界标记定义在适配层（`adapter/dsh.ts`）：`confirmSeed` 按它们反查，
// 轮换运行器与装配层共用同一份字面量，不在两处各写一个。
/**
 * `/continuity` 动词侧的词表（设计 §6–§14、§21–§22）：与实体的字面联合一一对齐，
 * CLI 靠这些常量做 `oneOf` 校验，让非法值停在入口并回用法，而不是把非法枚举丢给内核换一句
 * `transition rejected`。数组即真值来源——加词表项时这里与 `entities.ts` 同步即可。
 */
const SOURCE_CATEGORIES = ['observation', 'reported', 'inference', 'simulated', 'reference_bound'];
const HANDLING_STATES = ['unprocessed', 'accepted', 'integrated', 'rejected'];
const MESSAGE_KINDS = ['clarify_request', 'finding', 'blocker_report', 'result_submit', 'review_request', 'change_proposal', 'rotation_seed', 'challenge', 'correction'];
const CLAIM_STATUSES = ['proposed', 'supported', 'unsupported', 'refuted', 'superseded'];
const CHALLENGE_TARGET_KINDS = ['task', 'criteria', 'claim', 'artifact', 'verification'];
const CHALLENGE_SEVERITIES = ['hard_conflict', 'semantic_suspicion', 'under_evidenced'];
const OBLIGATION_STAGES = ['proposed', 'ready', 'running', 'verified', 'delivered', 'blocked', 'deferred', 'cancelled'];
const GRANT_ACTIONS = ['read', 'write', 'dispatch', 'publish', 'delete', 'external_submit', 'process_stop'];
const DEPENDENCY_TARGET_KINDS = ['task', 'attempt', 'artifact', 'checkpoint', 'dispatch', 'publish', 'verification', 'obligation', 'claim'];
const DEPENDENCY_ON_KINDS = ['claim', 'evidence', 'rule', 'criteria', 'grant'];
const VERIFICATION_OUTCOMES = ['pass', 'fail', 'unknown', 'error', 'not_run', 'not_applicable'];
const EXTERNAL_PHASES = ['accepted', 'processing', 'succeeded', 'failed', 'unknown'];
const FIX_KINDS = ['state_field', 'error_default', 'execution_wrapper', 'reject_counterexample', 'process'];
const ARTIFACT_ATTRIBUTIONS = ['tool_operation', 'native_identity', 'observed', 'reconciled', 'unknown'];
const REVIEW_TARGET_KINDS = ['task', 'artifact', 'claim', 'verification'];
const VERSUS_HISTORY = ['consistent', 'conflict', 'duplicate', 'unknown'];
const DELIVERY_STAGES = ['produced', 'registered', 'dispatched', 'received', 'processed', 'unrouted'];
function sessionIdOf(value) {
    if (value === null || value === undefined || typeof value !== 'object')
        return undefined;
    const record = value;
    const raw = record.id ?? record.session?.id;
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
export function apply(ctx, rawConfig) {
    const logger = ctx.logger(name);
    const settingsOf = () => normalize(rawConfig);
    if (!settingsOf().enabled) {
        logger.info(`${name}: enabled=false，本次挂载不订阅事件、不写存储、不注册工具。`);
        return;
    }
    ctx.effect(async () => {
        const settings = settingsOf();
        // —— live reader：每次现读，不快照。
        const service = (serviceName) => {
            const value = ctx.get(serviceName);
            return value === undefined || value === null ? undefined : value;
        };
        const agents = () => service('agents');
        const sessions = () => service('sessions');
        const tools = () => service('tools');
        const hostSlice = {
            get sessionController() { return service('sessionController'); },
            get tokenMeter() { return service('tokenMeter'); },
            get sessionProjections() { return service('sessionProjections'); },
            get sessions() { return sessions(); },
            get goals() { return service('goals'); },
            get subagents() { return service('subagents'); },
            get schedule() { return service('schedule'); },
            get sessionTitle() { return service('sessionTitle'); },
            get storageDomain() { return service('storageDomain'); },
            get tools() { return tools(); },
            get agentDefaultModel() { return service('agentDefaultModel'); },
            get logger() { return () => logger; },
        };
        // —— 存储域：打不开就整体无操作，不做"半挂载"。
        let domain;
        try {
            domain = await ctx.storageDomain.open(continuityDomain);
        }
        catch (error) {
            logger.error(`${name}: 存储域 'continuity' 打不开，插件进入无操作模式：${String(error)}`);
            return () => undefined;
        }
        // —— 单写者锁（审阅 R3）：命令队列只在一个进程内串行，两个进程共用同一份 storageDomain
        //     时它不构成锁。声明了锁路径就必须拿到才继续；拿不到即进入无操作模式，
        //     绝不作为第二个写入者并行提交同一批记录。
        let hostLock;
        const lockPath = settings.hostLockPath;
        if (lockPath.length > 0) {
            const candidate = new HostLock(lockPath, `${name}:${process.pid}`);
            try {
                const dir = dirname(lockPath);
                if (dir.length > 0)
                    mkdirSync(dir, { recursive: true });
                await candidate.acquire();
                hostLock = candidate;
            }
            catch (error) {
                logger.error(`${name}: 单写者锁 ${lockPath} 未取得，疑似另一宿主进程在跑同一份存储：${String(error)}。本次挂载进入无操作模式（不订阅、不写、不注册工具）。`);
                return () => undefined;
            }
            logger.info(`${name}: 已取得单写者锁 ${lockPath}（hostId=${name}:${process.pid}；10s 心跳，5 分钟硬过期后可被接管）。`);
        }
        const store = new DomainStore(domain.table('missions'), (value) => structuredClone(value));
        const queue = new CommandQueue();
        /**
         * 按 Mission 分开的"最近一次已提交状态"缓存（§12.2，审阅 R1）。
         *
         * 守卫与收口探针都在同步路径上，不能现读存储，只能读这份缓存，所以它的更新通道必须只有一个：
         * 内核每次确认落盘后回调 `noteCommitted`。此前这里是一个共享的 `lastState`，只在轮末评估和
         * 斜杠命令读取时赋值，取消/撤权/轮换/恢复/续租这些写入口不经过它，守卫就会拿旧版本放行。
         */
        const committed = new Map();
        const noteCommitted = (id, state) => { committed.set(id, state); };
        const forgetCommitted = (id) => { committed.delete(id); };
        // —— 归档（审阅 R4）：热记录只留最近窗口，更早的历史必须先写进不可变台账再裁剪。
        //     `archive` 表与 `missions` 同域同版本：表是新增的，`per-record` 布局按记录核版本，
        //     加表不需要也不应该抬域版本（旧记录继续按 v1 被接受）。
        const archiveTable = domain.table(ARCHIVE_TABLE);
        // reader 恒存在（与 sink 同一张表），声明成必选，读侧不必再判空。
        const archivePort = { sink: archiveSink(archiveTable), reader: archiveReader(archiveTable) };
        /**
         * 读侧核对覆盖面用的"预期水位"（N3）：批次列表自己看不出首段/末段缺失，
         * 只有控制记录声明的 `archive.throughSeq` 能回答"本该覆盖到哪儿"。
         * 记录里没有这一格 = 还没裁剪过，不给预期（拿猜测当核对依据会把"没归档过"报成"归档丢了"）。
         */
        const archiveExpectation = (state) => state.archive === undefined ? undefined : { expectedThroughSeq: state.archive.throughSeq };
        let sweepingArchive = false;
        /**
         * 提交后的归档收敛。`trigger` 只做便宜的预检，真正裁剪的对象在队列槽位里**重新装载**——
         * 提交与收敛之间可能夹进别的写，拿旧快照回写水位只会撞版本冲突，白费一批已落台账的批次。
         * 归档是运维动作，回写同一条记录但不推进 revision（同 `renewLeases` 口径），
         * 且跑在命令队列上，与所有命令的读-改-写严格串行。
         */
        const sweepArchiveSoon = (id, trigger) => {
            if (sweepingArchive)
                return;
            if (pendingEventArchive(trigger).length === 0 && planClosedRecordDrops(trigger).drops.length === 0)
                return;
            sweepingArchive = true;
            void queue
                .enqueue('archive.sweep', async () => {
                const current = await store.load(id);
                if (current === null)
                    return;
                if (pendingEventArchive(current).length === 0 && planClosedRecordDrops(current).drops.length === 0)
                    return;
                const swept = await sweepArchive(store, id, current, archivePort, Date.now());
                // 失败时 `swept.state` 就是输入状态：热记录一条未裁，缓存不能比存储更"新"。
                noteCommitted(id, swept.state);
                if (swept.error !== undefined)
                    logger.warn(`${name}: 归档收敛未完成（热记录保持完整）：${swept.error}`);
                else if (swept.batches.length > 0) {
                    logger.info(`${name}: 归档 ${swept.batches.length} 批（${swept.batches.map((batch) => batch.batchId).join('、')}），热水位推进到 seq ${swept.state.archive?.throughSeq ?? '（无）'}。`);
                }
            })
                .catch((error) => logger.warn(`${name}: 归档收敛失败：${String(error)}`))
                .finally(() => { sweepingArchive = false; });
        };
        const kernel = new ContinuityKernel(store, queue, {
            onCommitted: (id, state) => { noteCommitted(id, state); sweepArchiveSoon(id, state); },
            // 消费者标识写进 outbox 领取记录，崩溃重启后能看出上一条投递是哪个进程领的。
            consumerId: `${name}:${process.pid}`,
            // 签发与续租共用一个值（审阅 R8）：两套口径会让"新签的租约"和"续上的租约"寿命不一。
            // 取自挂载时的声明值，与下面的续期节拍同源；改时长须重新装载。
            leaseExpiryMs: settings.leaseExpiryMs,
        });
        const latch = new StopLatch();
        const ledger = new ToolEventLedger();
        const watermark = new SessionWatermark();
        const guards = new Map();
        const running = new Set();
        const compactFlags = new Set();
        const rotationTurn = new Map();
        const activeRotations = new Map();
        /** `/continuity open` 出来的 Mission：先记在内存，用户在设置页保存 `missionId` 后才持久。 */
        let openedMissionId = settings.missionId;
        const missionId = () => (openedMissionId.length === 0 ? undefined : openedMissionId);
        /**
         * 当前 Mission 的已提交快照。读不到就返回 `null`，由调用方按"无法确认"处理（单向拒绝），
         * 同时补一次异步装载自愈：挂载后还没有任何提交时，守卫不该因为缓存空而永远拒绝合法票据。
         */
        const cachedState = () => {
            const id = missionId();
            if (id === undefined)
                return null;
            const hit = committed.get(id);
            if (hit !== undefined)
                return hit;
            void kernel
                .read(id)
                .then((state) => { if (state !== null)
                noteCommitted(id, state);
            else
                forgetCommitted(id); })
                .catch(() => undefined);
            return null;
        };
        const makeMessage = (text, source) => createUserMessage({
            content: [{ type: 'text', text: `${SEED_MARKER}${source.rpcId}${SEED_MARKER}\n${text}` }],
            source: { kind: 'plugin', plugin: name },
        });
        // —— 能力探针：只读，挂载即跑一次，结论进日志；自动侧受它门禁。
        const probes = probeAll(hostSlice);
        const gate = gateAutomation(probes);
        /**
         * 入场条件 = 探针全绿 **或** 操作者逐项核对后签字。
         *
         * `turn-boundary` 一类项目在源码里就只能给 partial（语义要在真会话上对账），
         * 所以只看 `gate.allowed` 的话，`autoRotationEnabled` 与 `enforceAdmission` 两个开关
         * 永远是装饰品。这里把"人来确认已实测"做成显式设置，而不是让插件自己宣布通过。
         */
        const armed = () => gate.allowed || settingsOf().probesAcknowledged;
        const autoAllowed = () => settingsOf().autoRotationEnabled && armed();
        logger.info(`${name}: 探针 ${probes.length} 项，阻塞项 ${gate.blocking.length} 个（${gate.blocking.join(', ') || '无'}）；` +
            `入场=${armed() ? '允许' : '只观察'}，自动轮换=${autoAllowed() ? '启用' : '关闭'}` +
            `${settingsOf().autoRotationEnabled && !armed() ? '（开关已开，但探针未过且未签字）' : ''}。`);
        if (!gate.allowed) {
            logger.warn(`${name}: 探针未全通过，${armed() ? '已按 probesAcknowledged 放行自动侧' : '本次挂载只出观察数据'}。逐项核对：\n${formatReport(probes.filter((item) => item.shape !== 'ok'))}`);
        }
        // —— 冷恢复：先把每条记录的入场都扣住，再按核对结论逐个放开（§5.2 末句、§11.1）。
        //      `admissionClosed` 是持久字段，崩溃前它可能是 false；不先关就会带着未验证的在途状态放行。
        const plan = await bootRecover(store, Date.now());
        for (const report of plan.reports)
            await kernel.setAdmission(report.missionId, false);
        for (const id of plan.admit)
            await kernel.setAdmission(id, true);
        logger[(plan.hold.length > 0 ? 'warn' : 'info')](`${name}: 冷恢复 ${plan.reports.length} 条记录，准入 ${plan.admit.length} 个，扣住 ${plan.hold.length} 个：\n${renderRecoveryMarkdown(plan.reports)}`);
        if (openedMissionId.length === 0 && plan.reports.length === 1)
            openedMissionId = plan.reports[0].missionId;
        // 守卫是同步探针，挂载后若还没有任何提交，缓存就是空的；先装载一次，
        // 免得把"合法持票"拒成"记录读不到"。之后的更新一律走内核的提交通知。
        if (openedMissionId.length > 0) {
            const primed = await kernel.read(openedMissionId);
            if (primed === null)
                forgetCommitted(openedMissionId);
            else
                noteCommitted(openedMissionId, primed);
        }
        const guardConfig = () => {
            const s = settingsOf();
            return { warnRatio: s.warnRatio, hardRatio: s.hardRatio, hysteresisRatio: 0.05, cooldownTurns: s.cooldownTurns, respectCompaction: true, enabled: true };
        };
        /**
         * 轮换线的输入组装（§10.1 的三条 fail-closed 规则之一）。
         *
         * R 现在有三条来源，优先级由 `resolveOutputReserve` 定：操作者声明 > 本会话 `requestHeader()`
         * 的 `config.maxTokens` > `contextTimeline.maxOutputTokens`。H 与 r 仍然读不到——上游 dsh-context
         * 也只是照抄 compaction-basic 的出厂默认，所以只有显式声明或显式打开
         * `acceptMirroredCompactionDefaults` 才给值。缺哪一格就不填哪一格，`rotationLine` 自己停在
         * observation；把缺失当 0 会把 C 算大，那才是真的危险。
         */
        const lineInput = (contextWindow, s, readings) => {
            const slot = (read, declared) => {
                const value = read !== null && read !== undefined ? read : declared > 0 ? declared : null;
                return value === null || !Number.isFinite(value) ? null : value;
            };
            const reserve = slot(readings?.outputReserve?.value, s.outputReserveTokens);
            const headroom = slot(readings?.compactionHeadroom?.value, s.compactionHeadroomTokens);
            const ratio = slot(readings?.compactionRatio?.value, s.compactionRatio);
            const window = contextWindow !== null && contextWindow > 0 ? contextWindow : readings?.contextWindowTokens ?? null;
            return {
                contextWindow: window,
                handoffMargin: s.handoffMarginTokens,
                rotateRatio: s.rotateRatio,
                ...(reserve === null ? {} : { outputReserve: reserve }),
                ...(headroom === null ? {} : { compactionHeadroom: headroom }),
                ...(ratio === null ? {} : { compactionRatio: ratio }),
            };
        };
        /** 采集一次判定读数（投影 + 宿主直读 + 设置声明）；适配层保证不抛，读不到就是 `null`。 */
        const contextReadingsOf = (session, s) => readContextReadings(hostSlice, session, {
            outputReserveTokens: s.outputReserveTokens,
            compactionHeadroomTokens: s.compactionHeadroomTokens,
            compactionRatio: s.compactionRatio,
            acceptMirroredCompactionDefaults: s.acceptMirroredCompactionDefaults,
        });
        /** 「现在该压缩 / 该在会话内另开一个会话 / 都不动」加上线上的数与卡住自动侧的那一格。 */
        const verdictText = (verdict) => {
            const n = verdict.numbers;
            const label = verdict.verdict === 'compact' ? '该压缩' : verdict.verdict === 'rotate' ? '该在会话内另开一个会话' : '都不动';
            const provenance = (read) => (read === null ? '未声明' : `${read.value}（${read.provenance}）`);
            return (`${label}：压力 ${n.pressureTokens ?? '未知'}（${n.pressureSource}）、窗口 ${n.contextWindowTokens ?? '未知'}（${n.contextWindowSource}）` +
                `、R ${provenance(n.outputReserve)}、H ${provenance(n.compactionHeadroom)}、r ${provenance(n.compactionRatio)}` +
                `、C=${n.nativeCompactionLine ?? '未算出'}、T=${n.rotationLine ?? '未算出'}` +
                `、距 C ${n.marginToNativeCompaction ?? '未知'}、距 T ${n.marginToRotationLine ?? '未知'}` +
                `、已压缩 ${n.compactions ?? '未知'} 次/裁剪 ${n.prunes ?? '未知'} 次/回收 ${n.reclaimedTokens ?? '未知'} token` +
                `${verdict.holdingGate === 'none' ? '' : `｜卡住自动侧：${verdict.holdingGate}`}`);
        };
        const sessionObject = (sessionId) => {
            const live = agents()?.get(sessionId);
            if (live !== undefined && live.session !== undefined)
                return live.session;
            return sessions()?.get(sessionId);
        };
        const occupancyOf = (session) => readOccupancy(readPressure(hostSlice, session));
        /**
         * 静默探针：只回答有证据的问题。
         *
         * - `stepRunning` 来自 `agent/status`（`{agent,status}`，status 是 'idle'|'running'）；
         * - `managedToolsRunning` 来自本插件观察到的工具生命周期配对（native 的
         *   `tool/call`/`tool/result`，Code-Mode 的 `tool/ptc-dispatch-start`/`tool/ptc-dispatch`）；
         * - `registerQueueFlushed` 是本包自己的命令队列排空（§5.2 的"登记队列"就是这个队列）；
         * - `nativeSubagentsSettled`：`SubagentRuntime` 只暴露 `list()`（provider 名，不是活体 run，
         *   `packages/subagent/subagent/src/index.ts:541`），因此改用可推导的替代判据——
         *   该会话是否存在仍在 running 的**子会话**（`header.parentSession` 指向它）。子会话不是
         *   从本进程起的（provider 侧）时看不到，此时返回 `null`；
         * - `externalEffectsResolved`：台账里没有 `executing`/`outcome_unknown` 操作即已确定，
         *   用轮末缓存的记录回答，记录缺失即 `null`；
         * - `pendingInputPersisted`：`inbox` 投影为空即"无待处理输入"（vacuous true），非空则无法证明
         *   已持久化 ⇒ `null`。
         */
        const probeFor = (sessionId) => ({
            stepRunning: (id) => running.has(id),
            managedToolsRunning: (id) => ledger.hasUnsettled(id),
            registerQueueFlushed: () => (queue.depth === 0 && queue.running === 0 ? true : false),
            nativeSubagentsSettled: (id) => {
                const runtime = hostSlice.subagents;
                if (runtime === undefined)
                    return true;
                const list = agents()?.list() ?? [];
                const children = list.filter((agent) => (agent.session?.header?.parentSession ?? '') === id);
                if (children.length === 0)
                    return null;
                return children.every((child) => !running.has(String(child.id ?? '')));
            },
            externalEffectsResolved: () => {
                const state = cachedState();
                if (state === null)
                    return null;
                const unsettled = Object.values(state.operations).filter((op) => op.status === 'executing' || op.status === 'outcome_unknown');
                return unsettled.length === 0;
            },
            pendingInputPersisted: (id) => {
                const state = hostSlice.sessionProjections?.stateOf(sessionObject(id), 'inbox');
                if (state === null || state === undefined)
                    return true;
                const record = state;
                const queued = Object.values(record).filter((value) => Array.isArray(value) && value.length > 0);
                return queued.length === 0 ? true : null;
            },
        });
        const sessionCwd = (sessionId) => {
            const fromAgent = agents()?.get(sessionId)?.session?.header?.cwd;
            if (typeof fromAgent === 'string' && fromAgent.length > 0)
                return fromAgent;
            const record = sessions()?.get(sessionId);
            const fromRecord = record?.header?.cwd;
            return typeof fromRecord === 'string' && fromRecord.length > 0 ? fromRecord : undefined;
        };
        const sessionPreset = (sessionId) => agents()?.get(sessionId)?.session?.header?.agentPreset;
        const routeOf = (sessionId) => {
            const header = agents()?.get(sessionId)?.session?.requestHeader?.();
            const config = header?.config;
            const model = config?.['model'] ?? config?.['target'];
            return typeof model === 'string' && model.length > 0 ? model : '未知（requestHeader 的模型字段口径见 §16 token-measure）';
        };
        const rotationDeps = () => ({
            kernel,
            host: hostSlice,
            latch,
            makeMessage,
            config: () => {
                const s = settingsOf();
                return { slowAfterMs: s.boundarySlowMs, deadlineMs: s.boundaryDeadlineMs, migrateSchedules: s.migrateSchedules, rearmGoal: s.rearmGoal };
            },
            ctxFor: (actorId) => ({ actorId, role: 'supervisor', now: Date.now() }),
            agentOf: (sessionId) => agents()?.get(sessionId),
            probe: probeFor,
            briefFacts: (state, sessionId) => factsFromLedger({
                state,
                ledger,
                sessionId,
                route: routeOf(sessionId),
                mode: '未知（run mode 无公开读取口径，§16）',
                permission: state.mission.permissionRef,
                compacted: compactFlags.has(sessionId),
            }),
            cwdFor: sessionCwd,
            presetFor: sessionPreset,
            onPhase: (rotation, phase) => {
                activeRotations.set(rotation.sourceSessionId, {
                    missionId: rotation.missionId,
                    rotationId: rotation.rotationId,
                    actorId: rotation.actorId,
                    sourceSessionId: rotation.sourceSessionId,
                    targetSessionId: rotation.targetSessionId,
                    phase,
                    stage: AFTER_COMMIT.has(phase) ? 'after-commit' : 'before-commit',
                });
            },
            log: (level, message) => logger[level](message),
        });
        /** 把人类输入投进当前绑定会话（轮换提交后的改道路径）。 */
        const deliverToSession = async (sessionId, text) => {
            const controller = hostSlice.sessionController;
            if (controller === undefined)
                throw new Error('sessionController 未装载');
            const found = await controller.resolveAgent(sessionId);
            if (found.error !== undefined)
                throw new Error(`resolveAgent ${sessionId}：${found.error.code ?? 'unknown'} ${found.error.message ?? ''}`);
            const agent = found.agent;
            if (agent === undefined)
                throw new Error(`resolveAgent ${sessionId} 未返回 agent`);
            await agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: name } }));
        };
        /**
         * outbox 执行器。
         *
         * `rotation.seed` 的处理器**不直接重投**：先按稳定消息 ID 查目标会话，查不到才投——
         * 这样"确认丢失"的条目重放不会给 S2 灌两份启动消息（§10.4）。
         * 停在 `WAITING_RECOVERY` 的轮换一律抛错留在积压里，等人工核对，不自动唤醒。
         */
        kernel.registerHandler('mailbox.deliver', async (entry) => {
            const sessionId = typeof entry.payload.sessionId === 'string' ? entry.payload.sessionId : undefined;
            const body = typeof entry.payload.body === 'string' ? entry.payload.body : '';
            if (sessionId === undefined)
                throw new Error(`mailbox.deliver 缺少 sessionId（outbox ${entry.outboxId}）`);
            // 确认丢失后的重放：先按稳定幂等键的完整标记令牌向后翻页核对，查得到就不再投第二次（审阅 R2/N1）。
            // 查不动（unknown，覆盖不足或读不动）按 fail-closed 处理——不敢确认是否已投递时，宁可退避也不能重复。
            const verdict = await confirmSeed(hostSlice, sessionId, entry.idempotencyKey, MAIL_MARKER);
            if (verdict === 'present')
                return;
            if (verdict === 'unknown') {
                throw new Error(`无法核对 ${sessionId} 的历史覆盖：不敢确认 ${entry.idempotencyKey} 是否已投递，本轮不重投`);
            }
            await deliverToSession(sessionId, `${MAIL_MARKER}${entry.idempotencyKey}${MAIL_MARKER}\n${body}`);
        });
        kernel.registerHandler('rotation.seed', async (entry) => {
            const rotationId = typeof entry.payload.rotationId === 'string' ? entry.payload.rotationId : '';
            const sessionId = typeof entry.payload.sessionId === 'string' ? entry.payload.sessionId : undefined;
            const messageId = typeof entry.payload.messageId === 'string' ? entry.payload.messageId : undefined;
            if (sessionId === undefined || messageId === undefined)
                throw new Error(`rotation.seed 缺少 sessionId/messageId（outbox ${entry.outboxId}）`);
            const state = await kernel.read(entry.missionId);
            const rotation = state?.rotations[rotationId];
            if (state === null || rotation === undefined)
                throw new Error(`轮换 ${rotationId} 记录缺失：不投递启动消息`);
            if (rotation.phase === 'WAITING_RECOVERY')
                throw new Error(`轮换 ${rotationId} 停在 WAITING_RECOVERY，需先核对再重投`);
            if ((await confirmSeed(hostSlice, sessionId, messageId, SEED_MARKER)) === 'present')
                return;
            const checkpoint = state.checkpoints[rotation.checkpointId];
            if (checkpoint === undefined)
                throw new Error(`轮换 ${rotationId} 的检查点 ${rotation.checkpointId} 读不到：交接包组不出来`);
            const brief = assembleBrief(state, checkpoint, factsFromLedger({
                state,
                ledger,
                sessionId: rotation.sourceSessionId,
                route: routeOf(rotation.sourceSessionId),
                mode: '未知（run mode 无公开读取口径，§16）',
                permission: state.mission.permissionRef,
                compacted: compactFlags.has(rotation.sourceSessionId),
            }));
            const receipt = await deliverSeed(hostSlice, sessionId, brief.markdown, messageId, makeMessage);
            if (!receipt.ok)
                throw new Error(`启动消息仍未确认：${receipt.reason}`);
        });
        const preStepHostFor = (sessionId) => {
            const info = activeRotations.get(sessionId);
            if (info === undefined)
                return undefined;
            return {
                latch,
                sessionId,
                stage: info.stage,
                reroute: (text) => deliverToSession(info.targetSessionId, text),
                abandonRotation: (reason) => {
                    void abandonRotation(rotationDeps(), info.missionId, info.rotationId, reason).then((report) => logger.info(`${name}: pre-step 放弃轮换 ${info.rotationId}：${report}`), (error) => logger.warn(`${name}: pre-step 放弃轮换失败：${String(error)}`));
                },
                logger,
            };
        };
        const latestCheckpointFor = (state, actor) => {
            for (let index = state.checkpointOrder.length - 1; index >= 0; index -= 1) {
                const checkpoint = state.checkpoints[state.checkpointOrder[index]];
                if (checkpoint !== undefined && checkpoint.actorId === actor.actorId)
                    return checkpoint;
            }
            return undefined;
        };
        const rotate = async (input) => {
            rotationTurn.set(input.sourceSessionId, guards.get(input.sourceSessionId)?.turn ?? 0);
            try {
                const result = await runRotation(rotationDeps(), input);
                return result.ok ? `轮换 ${result.rotationId} 完成：${result.detail}` : `轮换 ${String(result.rotationId ?? '-')} 未执行：${result.reason}`;
            }
            finally {
                activeRotations.delete(input.sourceSessionId);
            }
        };
        /**
         * 空闲维护窗口的质量决策链（设计稿 §27.2–§27.5；复审 G2 要求的"决策链闭环"）。
         *
         * 为什么挂在 `agent/status` 转空闲而不是轮末 `turn/end`：`planActionRun` 只在
         * `entry==='idle_maintenance'` 且会话不活跃、互斥入口空闲时才判 `run_now`
         * （`core/context-quality.ts:1149`）。轮末那一刻本会话仍在 running（下一轮紧接着开始），
         * 在那里调用只会拿到 `queue`——正是 G2 点名不能当成功的"只记了一次计划"。真机 agent
         * 每轮收尾都会转 idle（dsh: `core/agent-loop/src/agent.ts:150`），那一格才是空闲维护窗口。
         *
         * 链内部每一步都进 `steps`/`notes`（提交失败不吞、不抛），这里再包一层只为了保证它
         * **绝不会**把状态维护搞崩——失败只记日志。
         */
        const runIdleQuality = async (sessionId, session, agent) => {
            try {
                const id = missionId();
                if (id === undefined)
                    return;
                const state = await kernel.read(id);
                if (state === null)
                    return;
                const actor = Object.values(state.actors).find((item) => item.sessionId === sessionId && !item.retired);
                if (actor === undefined)
                    return;
                const s = settingsOf();
                const engine = service('compaction');
                const report = await runQualityChain({
                    host: hostSlice,
                    session,
                    sessionId,
                    actorId: actor.actorId,
                    state,
                    now: Date.now(),
                    settings: {
                        outputReserveTokens: s.outputReserveTokens,
                        compactionHeadroomTokens: s.compactionHeadroomTokens,
                        compactionRatio: s.compactionRatio,
                        acceptMirroredCompactionDefaults: s.acceptMirroredCompactionDefaults,
                    },
                    entry: 'idle_maintenance',
                    sessionActive: running.has(sessionId),
                    maintenanceEntryFree: !activeRotations.has(sessionId) && !latch.heldKeys().includes(sessionId),
                    rotationPending: Object.values(state.rotations).some((rotation) => rotation.actorId === actor.actorId && rotation.phase !== 'ACTIVE'),
                    missionActive: state.mission.status === 'active',
                    // 真机压缩入口要两件同时在：引擎服务在场 + 活体 Agent（`compactNow` 的第一个参数必须是
                    // 携带 `runMaintenance` 的维护上下文）。缺任一件就是"本部署没有压缩入口"，链自己如实记缺口。
                    ...(engine === undefined || agent === undefined ? {} : { compaction: compactionPort(engine, agent) }),
                    commit: async (cmd) => {
                        const result = await kernel.submit(id, cmd, { actorId: actor.actorId, role: actor.role, now: Date.now(), sessionId });
                        return result.applied ? { applied: true, state: result.state } : { applied: false, reason: result.reason, state: null };
                    },
                    reload: async () => await kernel.read(id),
                    refetchFrame: async () => frameFromReadings(contextReadingsOf(session, s), (await kernel.read(id)) ?? state, sessionId),
                    verifyObservation: async () => {
                        const after = (await kernel.read(id)) ?? state;
                        const readings = contextReadingsOf(session, s);
                        return postCompactionObservation({
                            state: after,
                            retentionList: retentionListFromState(after),
                            readings,
                            current: frameFromReadings(readings, after, sessionId),
                        });
                    },
                });
                for (const line of report.steps)
                    logger.info(`${name}: 质量链[${sessionId}] ${line}`);
                for (const line of report.notes)
                    logger.warn(`${name}: 质量链[${sessionId}] ${line}`);
            }
            catch (error) {
                logger.warn(`${name}: 空闲维护质量链异常（不影响状态维护）：${String(error)}`);
            }
        };
        /**
         * 原生成员出生 → 自动进台账（复审 G1 的"身份映射与生命周期联动"，本轮补的缺口）。
         *
         * 为什么需要它：成员会话在 `MissionControl.actors` 里没有条目时，`continuity_*`
         * 工具对它一律返回 `no-bound-actor`——成员会干活、能派子代理，但它写的检查点、
         * 证据、验收全都要 Lead 代录，"每个成员遵守同一套纪律"就成了空话。本体已经把成员
         * 的会话身份写进 `team/member` 事件（`TeamMemberSnapshot.id` 就是 `SessionId`），
         * 所以绑定不需要第二张表，也不需要人手跑 `/continuity join`。
         *
         * 三步的顺序不是随意的：内核里那两条命令**互相死锁**——
         * `actor.register` 在 `collaboration === 'solo'` 时拒绝非单人角色（`commands.ts:1381`），
         * 而 `team.configure` 只接受**已在 `actors` 里**的成员、成员为空就整体拒绝
         * （`commands.ts:1441-1442`）。先登记会被前者挡、先组队会被后者挡。
         * 只有 Lead 能同时满足两条，所以由它先把门打开，再放成员进来。
         */
        const onTeamMemberEvent = async (event) => {
            const id = missionId();
            if (id === undefined)
                return;
            const parsed = teamMemberOf(event);
            if (parsed === undefined)
                return;
            const { teamId, member } = parsed;
            // 只有真正活起来的成员才进台账：provisioning 还没有可绑的会话，failed 没有可执行的未来。
            if (member.phase !== 'active')
                return;
            const state = await kernel.read(id);
            if (state === null)
                return;
            const leadActorId = state.mission.leadActorId;
            if (leadActorId === undefined || state.actors[leadActorId] === undefined)
                return;
            // 归属核对（F2）：原生 Team 以根会话组织（`TeamId(id: SessionId)`），而本 Mission 的 Lead
            // 绑定在某个会话上。只有两者是同一个会话，这条成员事件才属于本 Mission。
            // 缺这一步，任何团队发出的 `team/member` 都会写进当前台账——污染成员、团队、
            // 并发配额与后续身份判断。
            const leadSessionId = state.actors[leadActorId]?.sessionId;
            if (leadSessionId === undefined || teamId !== leadSessionId) {
                logger.info(`${name}: 忽略外来成员事件（teamId=${teamId}，本 Mission Lead 会话=${leadSessionId ?? '未绑定'}）`);
                return;
            }
            // 一个会话同一时刻只绑一个未退役 Actor（§3.3）：这个成员会话已经有身份就不动它。
            if (Object.values(state.actors).some((actor) => !actor.retired && actor.sessionId === member.id))
                return;
            // 成员键：优先可读名；同名但不同会话（重建成员、另一批同名）加会话后缀区分。
            // 不能用"键已存在就跳过"——那会让重建出来的成员永远拿不到身份。
            const plainId = `member-${member.name}`;
            const actorId = state.actors[plainId] === undefined ? plainId : `member-${member.name}-${member.id.slice(-8)}`;
            const supervisor = { actorId: 'supervisor', role: 'supervisor', now: Date.now() };
            // 并发上限：`team.configure` 是**整体覆盖**（`commands.ts:1450`），所以已有队伍必须沿用
            // 它自己的口径——成员出生不该把用户用 `/continuity team … <limit>` 设过的配额改掉。
            // 首次建队给 2（Lead + 一名成员），这是"有第二个活体会话"这一事实的最小表达。
            const concurrencyLimit = state.teams[teamId]?.concurrencyLimit ?? 2;
            // ① 先让协作模式跟上事实：有第二个活体会话就是 team，而不是等人喊命令。
            if (state.mission.collaboration === 'solo') {
                const opened = await kernel.submit(id, {
                    kind: 'team.configure',
                    requestId: `tm-team:${teamId}`,
                    teamId,
                    memberActorIds: [leadActorId],
                    concurrencyLimit,
                }, supervisor);
                if (!opened.applied) {
                    logger.warn(`${name}: 成员 ${member.name} 未进台账（协作模式切 team 被拒）：${opened.reason}`);
                    return;
                }
                logger.info(`${name}: Mission 协作模式 solo → team（原生成员 ${member.name} 出现）`);
            }
            // ② 登记成员：身份按会话绑定，它自己的工具调用从此过得了 `no-bound-actor` 这一关。
            const registered = await kernel.submit(id, {
                kind: 'actor.register',
                requestId: `tm-reg:${teamId}:${member.id}`,
                actorId,
                role: 'member',
                label: member.name,
                sessionId: member.id,
            }, supervisor);
            if (!registered.applied) {
                logger.warn(`${name}: 成员 ${member.name} 未进台账：${registered.reason}`);
                return;
            }
            // ③ 纳入团队：并发与讨论配额按队伍算（`runningActors` 看 team 成员表）。
            const joined = await kernel.submit(id, {
                kind: 'team.configure',
                requestId: `tm-join:${teamId}:${member.id}`,
                teamId,
                memberActorIds: [actorId],
                concurrencyLimit,
            }, supervisor);
            logger.info(`${name}: 成员 ${member.name}（会话 ${member.id}）已进台账${joined.applied ? '并纳入团队' : `；纳入团队未成功：${joined.reason}`}（复查 G1 身份映射）`);
        };
        const evaluateTurnEnd = async (sessionId, session, guard) => {
            const id = missionId();
            if (id === undefined)
                return;
            const state = await kernel.read(id);
            if (state === null)
                forgetCommitted(id);
            else
                noteCommitted(id, state);
            if (state === null)
                return;
            const actor = Object.values(state.actors).find((item) => item.sessionId === sessionId && !item.retired);
            if (actor === undefined)
                return;
            const s = settingsOf();
            const occupancy = occupancyOf(session);
            // 线口径来自三路读数（原生投影 / 宿主直读 requestHeader+requestContext / contextTimeline）加设置声明；
            // R 已能读实值，H 与 r 仍需声明或显式接受镜像默认值，缺项时 `rotationLine` 停在 observation。
            const readings = contextReadingsOf(session, s);
            const line = rotationLine(lineInput(occupancy.contextWindow, s, readings));
            // 判定只作观测与记录：换不换仍由 `decideRotation` + §16 入场门控决定（FSM 未改）。
            const verdict = pressureVerdict({ readings, handoffMarginTokens: s.handoffMarginTokens, rotateRatio: s.rotateRatio });
            const lastTurn = rotationTurn.get(sessionId);
            // 交接包算出来之后依据又推进了（撤回、失效、撤销授权）⇒ 不能按旧包换会话，先等重算（§22.6）。
            const awaitingBriefRecompute = Object.values(state.rotations).some((rotation) => rotation.actorId === actor.actorId && rotation.phase !== 'ACTIVE' && revisionDrifts(rotation, state).length > 0);
            const decision = decideRotation({
                occupancy,
                line,
                guard,
                // §G1：原生 Team 身份不会随轮换迁移到新会话（dsh 的 `roster.tryMembership` 以根会话组织 Team），
                // 所以持有原生身份的会话在身份迁移协议经真机验证前不吃自动轮换。判据是**名册里有没有队友行**，
                // 不是 role（每个单飞会话都被隐式判 lead）；读不出来（'unknown'）按在场处理，fail-closed。
                leadProtected: nativeTeamIdentity(service('agentTeams'), agents()?.get(sessionId)) !== 'none',
                actorRetired: actor.retired,
                pendingRotation: Object.values(state.rotations).some((rotation) => rotation.actorId === actor.actorId && rotation.phase !== 'ACTIVE'),
                rotationBudgetLeft: canRotate(actor, Date.now(), state.budgetLimits.maxRotationPerHour).ok,
                turnsSinceLastRotation: lastTurn === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, guard.turn - lastTurn),
                minTurnsBetweenRotations: s.minTurnsBetweenRotations,
                autoRotationEnabled: autoAllowed(),
                atSafeBoundary: safeToHandoff(state, actor, probeFor(sessionId), Date.now()).ready,
                awaitingBriefRecompute,
                config: guardConfig(),
            });
            if (decision.kind === 'rotate') {
                // §10.2：轮末要认的是**真正的 turn 结束**，不是投影里任何一次边界变化。
                // 事件侧计数（guard.turn，由 turn/end 推进）与持久侧 `turnBoundary` 对不上，
                // 说明本进程的事件视图与持久状态已分叉（漏事件、重挂、别的写入者），此时不换会话。
                const boundary = readTurnBoundary(hostSlice, session);
                if (boundary === null) {
                    logger.warn(`${name}: 轮换观察 actor=${actor.actorId}：turnBoundary 投影读不到，放弃本次自动轮换（§16 turn-boundary 未核对）。`);
                    return;
                }
                if (boundary.openTurnStartSeq !== null) {
                    logger.warn(`${name}: 轮换观察 actor=${actor.actorId}：投影显示仍在轮内（openTurnStartSeq=${boundary.openTurnStartSeq}），放弃本次自动轮换。`);
                    return;
                }
                if (Math.abs(boundary.lastTurn - guard.turn) > 1) {
                    logger.warn(`${name}: 轮换观察 actor=${actor.actorId}：轮号对不上（投影 ${boundary.lastTurn} vs 事件 ${guard.turn}），放弃本次自动轮换。`);
                    return;
                }
                const checkpoint = latestCheckpointFor(state, actor);
                if (checkpoint === undefined) {
                    logger.warn(`${name}: 该换会话但 ${actor.actorId} 没有已落盘检查点：先提交检查点再轮换，不换没有依据的会话。`);
                    return;
                }
                logger.info(`${name}: 轮末判定轮换 actor=${actor.actorId} 会话=${sessionId} 检查点=${checkpoint.checkpointId}`);
                logger.info(`${name}: ${(await rotate({ missionId: id, actorId: actor.actorId, sourceSessionId: sessionId, checkpointId: checkpoint.checkpointId, trigger: 'pressure' }))}`);
                return;
            }
            if (decision.reason.startsWith('below-threshold') || decision.reason === 'auto-rotation-disabled')
                return;
            logger.info(`${name}: 轮换观察 actor=${actor.actorId}：${decision.kind}（${decision.reason}）｜${verdictText(verdict)}`);
        };
        /**
         * 台账 → 原生 Agent Team 任务板的投影节拍。
         *
         * 为什么走这条路而不是再开一个页签：dsh-context 的「编队」页渲染的就是宿主 `agentTeams`
         * 的任务板（其 `agentTeam` 投影折叠自 Lead 会话日志里的 `team/task` 事件），
         * 所以台账行写进这块板 = 台账和编队在同一个页面、同一套原生视觉，本插件不再自带 UI。
         *
         * caller 必须是活体 Lead Agent：`roster.tryMembership` 给根会话（或父会话已不在注册表的会话）
         * 的活体 Agent 隐式 `role:'lead'` 成员身份，因此不需要先起队友。取不到活体 Agent 就本轮跳过。
         */
        let boardSyncResult = { ops: 0, reason: 'not-run' };
        const boardSync = createTeamBoardSyncer({
            board: () => service('agentTeams'),
            leadAgent: async () => {
                const id = missionId();
                if (id === undefined)
                    return undefined;
                const state = await kernel.read(id);
                if (state === null)
                    return undefined;
                const declared = settingsOf().teamBoardMirrorSession;
                const lead = state.mission.leadActorId === undefined ? undefined : state.actors[state.mission.leadActorId];
                const sessionId = declared.length > 0 ? declared : lead?.sessionId;
                if (sessionId === undefined || sessionId.length === 0)
                    return undefined;
                return agents()?.get(sessionId);
            },
            ledger: async () => {
                const id = missionId();
                if (id === undefined)
                    return null;
                const state = await kernel.read(id);
                return state === null ? null : missionLedger(state);
            },
        }, {
            info: (message) => logger.info(`${name}: ${message}`),
            warn: (message) => logger.warn(`${name}: ${message}`),
        });
        const runBoardSync = async () => {
            if (!settingsOf().teamBoardMirror)
                return (boardSyncResult = { ops: 0, reason: 'disabled' });
            return (boardSyncResult = await boardSync.run());
        };
        /**
         * 状态页。带 sessionId 时追加"本会话"一行——用户问的第一件事就是
         * "现在离轮换线还差多少"，而这一行只有拿到具体会话才组得出。
         */
        const statusText = async (sessionId) => {
            const id = missionId();
            const state = id === undefined ? null : await kernel.read(id);
            const s = settingsOf();
            const lines = [
                `运行副本：${import.meta.url}｜插件 v${PLUGIN_VERSION}｜控制记录 schema v${SCHEMA_VERSION}`,
                `Mission：${id ?? '（未绑定；/continuity open <目标> 或在设置页填 missionId）'}`,
                `入场：${armed() ? '允许自动侧' : '只观察'}（autoRotationEnabled=${s.autoRotationEnabled ? 'on' : 'off'}、probesAcknowledged=${s.probesAcknowledged ? 'on' : 'off'}；探针阻塞项 ${gate.blocking.join(', ') || '无'}）`,
                `轮换参数：p=${s.rotateRatio}、M=${s.handoffMarginTokens} token、warn=${s.warnRatio}、hard=${s.hardRatio}、每 Actor 每小时 ≤${s.maxRotationPerHour} 次、间隔 ≥${s.minTurnsBetweenRotations} 轮`,
                `线口径声明：R=${s.outputReserveTokens > 0 ? `${s.outputReserveTokens}（operator-setting，优先于读取值）` : '未声明 ⇒ 按会话读 requestHeader.config.maxTokens / contextTimeline.maxOutputTokens'}` +
                    `、H=${s.compactionHeadroomTokens > 0 ? `${s.compactionHeadroomTokens}（operator-setting）` : `未声明（镜像默认值 ${s.acceptMirroredCompactionDefaults ? `已接受：${MIRRORED_COMPACT_HEADROOM_TOKENS}，mirrored-default` : '未接受'}）`}` +
                    `、r=${s.compactionRatio > 0 ? `${s.compactionRatio}（operator-setting）` : `未声明（镜像默认值 ${s.acceptMirroredCompactionDefaults ? `已接受：${MIRRORED_COMPACT_THRESHOLD_RATIO}，mirrored-default` : '未接受'}）`}` +
                    '；任一格三项读数不齐 ⇒ 轮换线停在 observation，自动侧不换会话（手动 /continuity rotate 不受影响）。',
                `命令队列：排队 ${queue.depth}，执行中 ${queue.running}`,
                `闩（正在软停的会话）：${latch.heldKeys().join(', ') || '无'}`,
                `在跑的轮换：${[...activeRotations.values()].map((item) => `${item.rotationId}@${item.phase}`).join(', ') || '无'}`,
                `单写者锁：${hostLock === undefined ? '未启用（hostLockPath 留空）' : `${lockPath}（已持有；未持有锁的宿主进入无操作模式）`}`,
                `任务板投影（编队页）：${boardSyncResult.reason}，最近一轮写入 ${boardSyncResult.ops} 次` +
                    `${boardSyncResult.detail === undefined ? '' : `（${boardSyncResult.detail}）`}｜开关 ${s.teamBoardMirror ? 'on' : 'off'}、节拍 ${s.teamBoardMirrorMs}ms、caller ${s.teamBoardMirrorSession.length > 0 ? s.teamBoardMirrorSession : 'Lead Actor 绑定会话'}`,
            ];
            if (sessionId !== undefined) {
                const session = sessionObject(sessionId);
                const occupancy = occupancyOf(session);
                const readings = contextReadingsOf(session, s);
                const line = rotationLine(lineInput(occupancy.contextWindow, s, readings));
                const verdict = pressureVerdict({ readings, handoffMarginTokens: s.handoffMarginTokens, rotateRatio: s.rotateRatio });
                const guard = guards.get(sessionId);
                lines.push(`本会话 ${sessionId}：占用 ${occupancy.ratio === null ? '未知' : `${(occupancy.ratio * 100).toFixed(1)}%`}` +
                    `（投影 ${occupancy.projectedTokens ?? '未知'} / 窗口 ${occupancy.contextWindow ?? '未知'}）` +
                    `${occupancy.clampMismatch ? ' ⚠ 投影超过声明窗口' : ''}、轮 ${guard?.turn ?? 0}、档 ${guard?.level ?? 'none'}` +
                    `、轮换线 ${line.mode}${line.T === null ? '' : ` T=${line.T}`}${line.reason === undefined ? '' : `（${line.reason}）`}`, `  ${verdictText(verdict)}`, `  投影面：时间线 ${readings.reads.timeline.availability}/${readings.reads.timeline.via ?? '无'}、头 ${readings.reads.headers.availability}、活动 ${readings.reads.activity.availability}` +
                    `；${readings.notes.join('；')}`);
            }
            lines.push(state === null ? '（无控制记录）' : renderMissionMarkdown(state));
            return lines.join('\n');
        };
        const surface = { kernel, settings: settingsOf, missionId, report: () => statusText() };
        ctx.provide('continuity', surface);
        const routeDisposers = [];
        // —— 客户端面板的只读通道：挂在 Connection 的鉴权栅栏里，只投影已有控制记录，不接受任何写参数。
        const noStore = { 'cache-control': 'no-store' };
        const ledgerRead = async () => {
            const id = missionId();
            const state = id === undefined ? null : await kernel.read(id);
            if (state === null)
                return new Response('no mission record', { status: 404, headers: noStore });
            return Response.json(missionLedger(state), { headers: noStore });
        };
        /**
         * 按会话读一次原生任务板（G3 的左右联动数据来源）。
         *
         * 三种"读不到"分开报告，绝不折算成空板：① 没有会话定位 ⇒ 返回 `undefined`，视图里
         * `native=null`；② 服务缺席 / 没有活体 Agent / 读取抛 ⇒ `reason`，视图里 `phase:'unavailable'`；
         * ③ 读到空数组 ⇒ `phase:'read'` + `readTotal:0`，那才是真的"原生板上没有任务"。
         */
        const readNativeBoard = async (sessionId) => {
            if (sessionId === undefined || sessionId.length === 0)
                return undefined;
            const board = service('agentTeams');
            if (board === undefined)
                return { sessionId, reason: 'agentTeams 服务未装载：本部署没有原生任务板的读取入口' };
            const agent = agents()?.get(sessionId);
            if (agent === undefined) {
                return { sessionId, reason: `会话 ${sessionId} 当前没有活体 Agent：listTasks 的授权凭据取不到，原生执行状态这一面没读到（不等于原生板为空）` };
            }
            try {
                return { sessionId, tasks: normalizeNativeTasks(await board.listTasks(agent)) };
            }
            catch (error) {
                return { sessionId, reason: `原生任务板读取抛错：${String(error)}` };
            }
        };
        const workbenchRead = async (request) => {
            const id = missionId();
            const state = id === undefined ? null : await kernel.read(id);
            if (state === null)
                return new Response('no mission record', { status: 404, headers: noStore });
            // 会话定位优先用页签带过来的 `?sessionId=`（右侧面板座椅是会话作用域的，
            // `sidebar.right.pane.tab` 的标准 prop 就是 sessionId），没有则回落到 Mission Lead 的绑定会话。
            // 不直接读 `request.url`：部分依赖基线的 `@types/node` 不带 undici 的 `Request.url` 声明，
            // 会让没有 harness typeRoots 的环境类型检查失败。运行时该属性必然存在（web 标准），
            // 这里按最小形状取，缺失即视为"未指定会话"。
            const rawUrl = request.url;
            const requested = rawUrl === undefined ? null : new URL(rawUrl, 'http://localhost').searchParams.get('sessionId');
            const leadSession = state.mission.leadActorId === undefined ? undefined : state.actors[state.mission.leadActorId]?.sessionId;
            const sessionId = requested === null || requested.length === 0 ? leadSession : requested;
            const native = await readNativeBoard(sessionId);
            return Response.json(missionWorkbench(state, native), { headers: noStore });
        };
        // 纪律面板的数据面：直接读磁盘上的 $DSH_HOME/AGENTS.md，读不出来就如实报"不存在"，
        // 不回落成插件内置文案——那样面板会显示一份没人实际遵守的纪律。
        const disciplineFile = join(process.env['DSH_HOME'] ?? join(homedir(), 'dsh-home'), 'AGENTS.md');
        const disciplineRead = async () => Response.json(disciplineView(disciplineFile, () => {
            try {
                const stat = statSync(disciplineFile);
                if (!stat.isFile())
                    return undefined;
                return { text: readFileSync(disciplineFile, 'utf8'), modifiedAt: stat.mtime.toISOString() };
            }
            catch {
                return undefined;
            }
        }), { headers: noStore });
        const connection = service('connection');
        if (connection === undefined) {
            logger.warn(`${name}: connection 服务未装载，台账面板没有读取通道。`);
        }
        else {
            for (const [path, project, label] of [[LEDGER_PATH, ledgerRead, '台账'], [WORKBENCH_PATH, workbenchRead, '工作台']]) {
                try {
                    routeDisposers.push(connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered', fetch: project }));
                    logger.info(`${name}: 已注册只读${label}路由 ${path}。`);
                }
                catch (error) {
                    logger.warn(`${name}: ${label}路由 ${path} 注册失败：${String(error)}`);
                }
            }
            try {
                routeDisposers.push(connection.fetch.register({ path: DISCIPLINE_PATH, methods: ['GET'], requestBody: 'buffered', fetch: disciplineRead }));
                logger.info(`${name}: 已注册只读纪律路由 ${DISCIPLINE_PATH}。`);
            }
            catch (error) {
                logger.warn(`${name}: 纪律路由 ${DISCIPLINE_PATH} 注册失败：${String(error)}`);
            }
        }
        const ok = (text) => ({ kind: 'success', text });
        const bad = (text) => ({ kind: 'error', text });
        const USAGE = 'status [详情] | open <目标> [--auto-resume] | join <actorId> [角色] | revise <目标> | task <标题> [| 范围 | 验收1;验收2] | approve <taskId> | claim <taskId> | checkpoint <步骤> [| 下一步] | submit <taskId> | verify <taskId> <criterionId> <结果> <方法> <证据1,证据2> | pause <原因> | resume | cancel <原因> | rotate | timeline | archive | board | probe | drain | recover\n' +
            '任务与收口：retry <taskId> | <原因> | spec <taskId> | <改因> [| 范围 | 排除 | 输入 | 验收;… ] | propose-complete <说明> | complete [可选taskId,…] | obligate <负责人> | <说明> [| …] | settle <obligationId> | <阶段> [| 回执 | 决策理由 | 决策来源] | depend <目标类型> | <目标ID> | <依赖类型> | <依赖ID> | <版本>\n' +
            '身份与团队：dormant <actorId> <sleep|wake> [等待说明] | retire <actorId> | bind <actorId> <sessionId> | team <teamId> | <成员,…> | <并发上限> | message <收件人> <类型> <正文> [| 任务 | 因果消息] | ack <messageId> [处理态] [理由]\n' +
            '产物与操作：artifact <taskId> | <uri> | <contentHash> [| 算法 | 来源操作 | 归因] | attach <artifactId> | <版本> | <证据,…> [| 类别 | 摘要] | publish <artifactId> | <版本> | <grantId> [目标身份] | intent <taskId> | <类型> | <目标> | <意图> | <幂等键> | <true|false> [| 核对方法 | 预留t,c | 动作:授权:身份:环境] | receipt <opId> <succeeded|failed> [| 结果 | 阶段 | 用量:i,o,c,n] | reconcile <opId> <executed|not_executed|still_unknown> [结果] | delegate <taskId> [| 原生ID | 子会话 | 派单ID] | collect <taskId> | <结果,…> [| 证据,…]\n' +
            '轮换核对：resolve <rotationId> <activate_target|keep_source> | resolve-propagation [传播ID] [| 目标类型 | 目标ID] | <裁定理由>\n' +
            '证据与纪律：evidence <类别> | <摘要> | <来源引用> [| …] | assert <命题> [| 条件,… | 类别 | 状态 | 支持,… | 反证,… | 再入,… | 主体:版本:输入:范围] | assert-retract <claimId> [| …] | challenge <目标类型> | <目标ID> | <原文> [| 反证 | 动作 | 裁定人 | 严重度 | 修订] | adjudicate <challengeId> <upheld|dismissed|merged> <说明> [并入ID] | search <查询> | <根,…> | <覆盖> | <结果> [| …] | context <actorId> <范围> <完整性> [| 缺失,… | 规则=版本 | …] | qualify <名> <输入类型> <范围> <代码引用> <true|false> [| …] | review <目标类型> <目标ID> <方法引用> <自洽结果> <历史对照> [| …] | incident <故障模式> | <触发条件> | <根因> | <修复类别> [| …] | grant <来源引用> | <动作,…> | <对象范围,…> | <环境> [| 来源 | 可转授 | 最大次数 | 配额 | 到期] | revoke <grantId> <理由> | dispatch <taskId> | <问题> | <去处> | <收件人> [| 范围 | 验收;… | …] | deliver <deliveryId> | <阶段> [| 处理态 | 理由] | ack-delivery <deliveryId> <accepted|integrated|rejected> [理由]\n' +
            '（分隔：竖线分段、逗号成列、分号分验收项、冒号与=组内拼字段；凡 <必填> 缺失即回用法，不会静默提交）';
        /**
         * 命令身份来自运行时绑定：调用会话 → 该会话上未退役的 Actor → 它的角色。
         * 映射不到时按 supervisor 入口（人类自己开的会话还没有 Actor）。
         *
         * 例外是 `USER_ONLY` 这几个动词：键入命令的是用户本人，而不是会话里的代理。
         * Solo 任务里人类与 Lead 共用一个会话，若一律按会话绑定取身份，
         * 人类就永远不能验收自己会话交上来的活——那正是 §6.4 要避免的自证完成。
         *
         * 加入的判据是"这一步由人来决定"，不是"这个命令敏感"：`complete`（收口由人核结构条件）、
         * `adjudicate`（质疑裁定）、`qualify`（验证器资格授予，§22.10）、`grant`/`revoke`
         * （授权只来自用户或可信入口，代理不能自行扩大范围，§22.8）都是人类判断，故按 user 身份入账。
         * `resolve-propagation` 同理：被撤回影响的一方不能自己宣布"这条传播我已经处理完"，
         * 那等于把缺口自己抹掉（§22.6）。
         */
        const USER_ONLY = new Set(['revise', 'approve', 'verify', 'pause', 'resume', 'cancel', 'complete', 'adjudicate', 'qualify', 'grant', 'revoke', 'resolve-propagation']);
        const ctxForInvocation = async (sessionId, id, verb) => {
            const now = Date.now();
            if (USER_ONLY.has(verb))
                return { actorId: `user:${sessionId ?? 'unbound'}`, role: 'user', now };
            if (sessionId !== undefined) {
                const state = await kernel.read(id);
                const actor = state === null ? undefined : Object.values(state.actors).find((item) => item.sessionId === sessionId && !item.retired);
                if (actor !== undefined)
                    return { actorId: actor.actorId, role: actor.role, now };
            }
            return { actorId: 'supervisor', role: 'supervisor', now };
        };
        const submitText = async (id, cmd, ctx2) => {
            const result = await kernel.submit(id, cmd, ctx2);
            return result.applied ? `已提交 ${cmd.kind}（修订 ${result.state.revision}）` : `未提交 ${cmd.kind}：${result.reason}`;
        };
        /** 检查点正文：只填**有出处**的段落，决策与语义进度归模型提交（§9.2），这里不替它编。 */
        const checkpointFields = (state, actorId, step, nextAction) => ({
            actorId,
            step,
            nextAction,
            verifiedProgress: Object.values(state.tasks).filter((task) => task.status === 'completed').map((task) => `${task.taskId} ${task.title}`),
            inProgress: Object.values(state.tasks).filter((task) => ['ready', 'leased', 'running', 'submitted', 'verifying'].includes(task.status)).map((task) => `${task.taskId} ${task.title}（${task.status}）`),
            decisions: [],
            blockers: Object.values(state.tasks).filter((task) => task.status === 'blocked').map((task) => `${task.taskId}：${task.blockedReason ?? '未记原因'}`),
            inFlightOperations: Object.values(state.operations).filter((op) => op.status === 'intent' || op.status === 'executing' || op.status === 'outcome_unknown').map((op) => op.operationId),
            openQuestions: Object.values(state.mailbox).filter((message) => message.kind === 'clarify_request' && message.state !== 'acknowledged').map((message) => `${message.messageId}→${message.toActorId}`),
            contextRefs: [],
        });
        const checkpointCommand = (state, actorId, step, nextAction) => ({
            kind: 'continuity.checkpoint',
            requestId: mintId('req'),
            checkpoint: checkpointFields(state, actorId, step, nextAction),
        });
        /** 挂在 Attempt 上的检查点：`task.submit` 只认这一种作为"有依据的收尾"（§6.3）。 */
        const taskCheckpointCommand = (state, actorId, taskId, step, nextAction) => ({
            kind: 'task.checkpoint',
            requestId: mintId('req'),
            taskId,
            checkpoint: checkpointFields(state, actorId, step, nextAction),
        });
        const runCommand = async (invocation) => {
            const sessionId = sessionIdOf(invocation.agent);
            const raw = invocation.rawInput.trim();
            const verb = (raw.length === 0 ? 'status' : (raw.split(/\s+/u)[0] ?? 'status')).toLowerCase();
            const arg = raw.length > verb.length ? raw.slice(verb.length).trim() : '';
            const id = missionId();
            if (verb === 'status')
                return ok(await statusText(sessionId));
            if (verb === 'probe')
                return ok(formatReport(probes));
            if (verb === 'open') {
                const autoResume = /(?:^|\s)--auto-resume(?:\s|$)/u.test(raw);
                const objective = arg.replace(/--auto-resume/gu, '').trim();
                if (objective.length === 0)
                    return bad('用法：/continuity open <目标> [--auto-resume]');
                const now = Date.now();
                const newId = mintId('mss');
                // 预算依据按"未声明"入账：拿默认限额当作用户给的上限，等于替用户签发额度（§13）。
                const draft = {
                    objective,
                    constraints: [],
                    constraintSources: [],
                    criteria: [],
                    budgetBasis: { kind: 'estimate', ref: '未声明：套用内核默认限额，该部署的真实上限未核对' },
                    collaboration: 'solo',
                    permissionRef: 'host:default',
                    allowAutoResume: autoResume,
                };
                const mission = {
                    ...draft,
                    missionId: newId,
                    criteria: [],
                    objectiveRevision: 1,
                    policyRevision: 1,
                    status: 'draft',
                    createdAt: now,
                    updatedAt: now,
                };
                const sup = { actorId: 'supervisor', role: 'supervisor', now };
                await kernel.open(mission);
                const activated = await submitText(newId, { kind: 'mission.create', requestId: mintId('req'), mission: draft }, sup);
                const registered = sessionId === undefined
                    ? '本会话拿不到 sessionId：没有登记 Actor，后续 claim/checkpoint 无从绑定身份'
                    : await submitText(newId, { kind: 'actor.register', requestId: mintId('req'), actorId: `lead-${sessionId}`, role: 'lead', label: 'lead', sessionId }, sup);
                const previous = openedMissionId;
                openedMissionId = newId;
                return ok(`Mission ${newId}（自动恢复=${autoResume ? '允许' : '需显式 resume'}）\n${activated}\n${registered}\n` +
                    `${previous.length === 0 ? '' : `注意：原绑定 ${previous} 已切走；要回到它请 /continuity recover 后在设置页填回 missionId。\n`}下一步：/continuity task <标题> [| 范围 | 验收1;验收2]`);
            }
            if (verb === 'recover') {
                const recovery = await bootRecover(store, Date.now());
                for (const report of recovery.reports)
                    await kernel.setAdmission(report.missionId, false);
                for (const admitted of recovery.admit)
                    await kernel.setAdmission(admitted, true);
                // 过期租约不会自己变成可认领：Attempt 不是终态，任务就停在 leased，`claim` 只收
                // ready/retry_wait。这里给出确切的后一步，否则接管的人只能对着 transition rejected 猜。
                const stale = recovery.reports.filter((report) => report.staleAttempts.length > 0);
                const hint = stale.length === 0
                    ? ''
                    : `\n过期执行权不会自动收回：核对旧进程确已终止后，对每个受影响任务执行 /continuity retry <taskId> | <放弃原因>，再 /continuity claim <taskId>。涉及：${stale.map((report) => report.staleAttempts.join(', ')).join('；')}`;
                return ok(`${renderRecoveryMarkdown(recovery.reports)}\n准入 ${recovery.admit.length} 个；扣住的原因见上。要强行放开：/continuity resume${hint}`);
            }
            if (id === undefined)
                return bad(`还没有绑定的 Mission（动词 ${verb} 需要它）。先 /continuity open <目标>。`);
            const state = await kernel.read(id);
            if (state === null)
                return bad(`Mission ${id} 记录读不到：可能已被删除，或在另一台 Host 上。/continuity recover 重新核对。`);
            noteCommitted(id, state);
            const invocationCtx = await ctxForInvocation(sessionId, id, verb);
            // 参数解析助手：竖线分段、逗号成列、分号分验收、整数/布尔/枚举校验；非法即在入口回用法，
            // 不把空字段丢给内核换一句看不懂的 `transition rejected`（§4 人类入口薄封装到 §14）。
            const sect = (count) => {
                const parts = arg.split('|').map((part) => part.trim());
                const out = [];
                for (let index = 0; index < count; index += 1)
                    out.push(parts[index] ?? '');
                return out;
            };
            const csv = (value) => value.split(/[,，]/u).map((item) => item.trim()).filter((item) => item.length > 0);
            const semis = (value) => value.split(/[;；]/u).map((item) => item.trim()).filter((item) => item.length > 0);
            const boolArg = (value, fallback) => value.length === 0 ? fallback : value === 'true' ? true : value === 'false' ? false : undefined;
            const intArg = (value) => { if (value.length === 0)
                return undefined; const n = Number(value); return Number.isSafeInteger(n) ? n : undefined; };
            const oneOf = (value, options) => options.includes(value);
            const criteriaOf = (value) => semis(value).map((text) => ({ text }));
            switch (verb) {
                case 'join': {
                    const [actorId, roleArg] = arg.split(/\s+/u);
                    if (actorId === undefined || actorId.length === 0 || sessionId === undefined)
                        return bad('用法：/continuity join <actorId> [lead|member|reviewer|subagent]（且调用方要能解析出 sessionId）');
                    const role = (roleArg ?? 'member');
                    if (!['lead', 'member', 'reviewer', 'subagent', 'user', 'supervisor'].includes(role))
                        return bad(`角色 ${role} 不在词表里`);
                    if (role !== 'lead' && state.mission.collaboration === 'solo')
                        return bad(`Mission 还是 solo 协作：member/reviewer 会被内核拒。先按 §7.5 用 team.configure 建立 Team。`);
                    return ok(await submitText(id, { kind: 'actor.register', requestId: mintId('req'), actorId, role, label: actorId, sessionId }, { actorId: 'supervisor', role: 'supervisor', now: Date.now() }));
                }
                case 'revise': {
                    if (arg.length === 0)
                        return bad('用法：/continuity revise <新目标>');
                    return ok(await submitText(id, { kind: 'mission.revise', requestId: mintId('req'), objective: arg }, invocationCtx));
                }
                case 'task': {
                    const parts = arg.split('|').map((part) => part.trim());
                    const title = parts[0] ?? '';
                    if (title.length === 0)
                        return bad('用法：/continuity task <标题> [| 范围 | 验收1;验收2]');
                    const criteria = (parts[2] ?? '').split(/[;；]/u).map((item) => item.trim()).filter((item) => item.length > 0);
                    // 判据以结构化条目提交：ID、criteriaRevision 与 criteriaCheck 由内核盖，字符串数组会被当成"无判据"。
                    const proposal = {
                        dependsOn: [],
                        title,
                        scope: parts[1] ?? title,
                        exclusions: [],
                        inputRefs: [],
                        criteria: criteria.map((item) => ({ text: item })),
                        priority: 5,
                        resourceKeys: [],
                        maxAttempts: 3,
                    };
                    return ok(`${await submitText(id, { kind: 'task.propose', requestId: mintId('req'), task: proposal }, invocationCtx)}` +
                        `\n新任务停在 planned：要开工需 /continuity approve <taskId>（从 timeline 里取）。`);
                }
                case 'approve':
                case 'claim': {
                    const taskId = arg.trim();
                    if (taskId.length === 0)
                        return bad(`用法：/continuity ${verb} <taskId>`);
                    return ok(await submitText(id, { kind: verb === 'approve' ? 'task.approve' : 'task.claim', requestId: mintId('req'), taskId }, invocationCtx));
                }
                case 'checkpoint': {
                    const [step = '（未提供）', nextAction = '（未提供）'] = arg.split('|').map((part) => part.trim());
                    const next = nextAction === '（未提供）' ? step : nextAction;
                    // 有在跑的 Attempt 就挂到 Attempt 上：任务级检查点才是 submit 与交接的依据，
                    // 只写一条连续性检查点会让"收口"退化成与尝试无关的自述。
                    const live = Object.values(state.attempts)
                        .filter((attempt) => attempt.actorId === invocationCtx.actorId && !isTerminalAttempt(attempt.status))
                        .sort((a, b) => b.createdAt - a.createdAt)[0];
                    const cmd = live === undefined
                        ? checkpointCommand(state, invocationCtx.actorId, step, next)
                        : taskCheckpointCommand(state, invocationCtx.actorId, live.taskId, step, next);
                    const note2 = live === undefined
                        ? '\n这是任务外的连续性检查点：该 Actor 没有进行中的 Attempt 可挂。'
                        : `\n挂在 ${live.attemptId}（任务 ${live.taskId}）上。`;
                    return ok(`${await submitText(id, cmd, invocationCtx)}${note2}`);
                }
                case 'submit': {
                    const taskId = arg.trim();
                    if (taskId.length === 0)
                        return bad('用法：/continuity submit <taskId>');
                    const attempt = Object.values(state.attempts).filter((item) => item.taskId === taskId && item.actorId === invocationCtx.actorId).sort((a, b) => b.createdAt - a.createdAt)[0];
                    if (attempt === undefined)
                        return bad(`${invocationCtx.actorId} 在 ${taskId} 上没有 Attempt：先 /continuity claim ${taskId}`);
                    return ok(await submitText(id, { kind: 'task.submit', requestId: mintId('req'), taskId, leaseVersion: attempt.leaseVersion }, invocationCtx));
                }
                case 'verify': {
                    const [taskId = '', criterionId = '', outcome = '', method = '', evidence = ''] = arg.split(/\s+/u);
                    const outcomes = ['pass', 'fail', 'unknown', 'error', 'not_run', 'not_applicable'];
                    if (taskId.length === 0 || criterionId.length === 0 || method.length === 0 || !outcomes.includes(outcome)) {
                        return bad('用法：/continuity verify <taskId> <criterionId> <pass|fail|unknown|error|not_run|not_applicable> <方法> <证据1,证据2>');
                    }
                    const evidenceRefs = evidence.split(/[,，]/u).map((item) => item.trim()).filter((item) => item.length > 0);
                    if ((outcome === 'pass' || outcome === 'fail') && evidenceRefs.length === 0)
                        return bad(`${outcome} 是对产物的判定，必须带证据引用：没有证据的 pass 就是让模型自报完成（§6.4）`);
                    return ok(await submitText(id, {
                        kind: 'task.verify',
                        requestId: mintId('req'),
                        taskId,
                        criterionId,
                        outcome: outcome,
                        method,
                        methodVersion: 'manual-1',
                        evidenceRefs,
                    }, invocationCtx));
                }
                case 'pause': {
                    if (arg.length === 0)
                        return bad('用法：/continuity pause <原因>');
                    const result = await submitText(id, { kind: 'mission.pause', requestId: mintId('req'), reason: arg }, invocationCtx);
                    await kernel.setAdmission(id, false);
                    return ok(`${result}\n业务入场已关闭：新执行不再放行，在途操作按原路走完。`);
                }
                case 'resume': {
                    const result = await submitText(id, { kind: 'mission.resume', requestId: mintId('req') }, invocationCtx);
                    const opened = await kernel.setAdmission(id, true);
                    return ok(`${result}\n入场 ${opened ? '已开放' : '未能开放（记录读取失败）'}。注意：内核只恢复状态，不会替 Mission 重跑外部动作（§11.1）。`);
                }
                case 'cancel': {
                    if (arg.length === 0)
                        return bad('用法：/continuity cancel <原因>');
                    const result = await submitText(id, { kind: 'mission.cancel', requestId: mintId('req'), reason: arg }, invocationCtx);
                    await kernel.setAdmission(id, false);
                    return ok(`${result}\n终态不复活：要重开请 /continuity open 建新 Mission。`);
                }
                case 'rotate': {
                    if (sessionId === undefined)
                        return bad('拿不到调用会话的 sessionId');
                    const actor = Object.values(state.actors).find((item) => item.sessionId === sessionId && !item.retired);
                    if (actor === undefined)
                        return bad(`本会话未绑定 Actor（先 /continuity open 或 join）：换会话没有身份可换`);
                    let checkpoint = latestCheckpointFor(state, actor);
                    let written = '';
                    if (checkpoint === undefined) {
                        written = await submitText(id, checkpointCommand(state, actor.actorId, '换会话前补写', '按当前台账继续'), invocationCtx);
                        const fresh = await kernel.read(id);
                        checkpoint = fresh === null ? undefined : latestCheckpointFor(fresh, actor);
                    }
                    if (checkpoint === undefined)
                        return bad(`${written}\n检查点没写进去（原因见上），不换没有依据的会话。`);
                    return ok(`${written.length === 0 ? '' : `${written}\n`}等待静默可能要几十秒到几分钟：期间本会话不再领新步骤（软停，不 cancel 在跑的动作）。\n${await rotate({ missionId: id, actorId: actor.actorId, sourceSessionId: sessionId, checkpointId: checkpoint.checkpointId, trigger: 'manual' })}`);
                }
                case 'timeline':
                    // 带归档快照渲染：被裁掉的历史在这里按台账回读，窗口外的 seq 不再显示成"从未发生"（R4）。
                    // 水位（`state.archive.throughSeq`）一起带给读侧：台账自己知道"该覆盖到哪儿"，
                    // 快照才能核对首段/末段缺失，而不是只看批次列表（N3）。
                    return ok(renderTimelineMarkdown(state, 200, await readArchiveSnapshot(archivePort.reader, id, archiveExpectation(state))));
                case 'archive': {
                    const snapshot = await readArchiveSnapshot(archivePort.reader, id, archiveExpectation(state));
                    // 空台账不等于"一切正常"：批次为空但核对报告有缺失时，缺失就是"归档过但读不回来"，必须显式报出（N3）。
                    if (snapshot.batches.length === 0) {
                        const gaps = snapshot.unavailable.length === 0 ? '' : `\n以下区间/批次未采信或缺失（不是"没有历史"，是"读不回来"）：\n${snapshot.unavailable.map((item) => `- ${item}`).join('\n')}`;
                        return ok(snapshot.unavailable.length === 0
                            ? '归档台账为空：热记录还没超过窗口（事件 ≤ 500 条且无可裁剪的闭合记录），没有可归档的内容。'
                            : `归档台账没有可采信的批次，但控制记录声明的水位对不上${gaps}` +
                                `\n预期水位：${state.archive === undefined ? '控制记录未声明（还没有裁剪过）' : `throughSeq ${state.archive.throughSeq}`}`);
                    }
                    return ok(`归档 ${snapshot.batches.length} 批，覆盖到 seq ${snapshot.archivedThroughSeq}，可回读事件 ${snapshot.events.length} 条。\n` +
                        snapshot.batches
                            .map((batch) => `- ${batch.batchId}（${batch.kind}，seq ${batch.fromSeq}–${batch.toSeq}，${batch.count} 项，${batch.location}，${batch.contentHash.slice(0, 12)}…）`)
                            .join('\n') +
                        (snapshot.unavailable.length === 0
                            ? '\n完整性核对：全部批次哈希与计数通过。'
                            : `\n以下批次未采信（只报缺失，不当事后圆场）：\n${snapshot.unavailable.map((item) => `- ${item}`).join('\n')}`));
                }
                case 'board': {
                    const result = await runBoardSync();
                    return ok(`任务板投影：${result.reason}，本轮写入 ${result.ops} 次${result.detail === undefined ? '' : `（${result.detail}）`}\n` +
                        '台账行写在宿主 agentTeams 的任务板上，因此 dsh-context 的「编队」页就是台账——不开新页签、任务板上的改动也不会反向写进控制记录。');
                }
                case 'drain': {
                    const summary = await kernel.drain();
                    const unknown = summary.unconfirmed > 0
                        ? `\nunconfirmed=${summary.unconfirmed}：投递已发出但确认没落盘，条目已记「结果未知」并退避——须与台账核对后再放行重投，不能当成已完成。`
                        : '';
                    const blocked = summary.blocked.length > 0 ? `\nblocked=${summary.blocked.length}：${summary.blocked.join('；')}` : '';
                    return ok(`outbox：attempted=${summary.attempted} completed=${summary.completed} failed=${summary.failed} unsupported=${summary.unsupported} unconfirmed=${summary.unconfirmed}${unknown}${blocked}${summary.unsupported > 0 ? '\nunsupported 的条目没有注册执行器，留在积压里可见，不会被静默丢弃。' : ''}`);
                }
                // —— task.retry / task.revise ——
                case 'retry': {
                    const [taskId = '', reason = ''] = sect(2);
                    if (taskId.length === 0 || reason.length === 0)
                        return bad('用法：/continuity retry <taskId> | <放弃本次尝试的原因>');
                    return ok(await submitText(id, { kind: 'task.retry', requestId: mintId('req'), taskId, reason }, invocationCtx));
                }
                case 'spec': {
                    const [taskId = '', reason = '', scope = '', exclusionsRaw = '', inputRefsRaw = '', criteriaRaw = ''] = sect(6);
                    if (taskId.length === 0 || reason.length === 0)
                        return bad('用法：/continuity spec <taskId> | <改因> [| 新范围 | 排除1,排除2 | 输入1,输入2 | 验收1;验收2]');
                    const exclusions = csv(exclusionsRaw);
                    const inputRefs = csv(inputRefsRaw);
                    const criteria = criteriaOf(criteriaRaw);
                    // 空改动会被内核原样退回（spec/criteria 版本都不动），这里先拦下（§22.4）。
                    if (scope.length === 0 && exclusions.length === 0 && inputRefs.length === 0 && criteria.length === 0)
                        return bad('spec 至少要改动一项（范围/排除/输入/验收），否则等于没改');
                    const task = state.tasks[taskId];
                    if (task === undefined)
                        return bad(`任务 ${taskId} 不存在`);
                    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')
                        return bad(`任务 ${taskId} 已是终态，不能再修订任务书`);
                    return ok(await submitText(id, {
                        kind: 'task.revise', requestId: mintId('req'), taskId, reason,
                        ...(scope.length > 0 ? { scope } : {}), ...(exclusions.length > 0 ? { exclusions } : {}),
                        ...(inputRefs.length > 0 ? { inputRefs } : {}), ...(criteria.length > 0 ? { criteria } : {}),
                    }, invocationCtx));
                }
                // —— mission.proposeComplete / mission.complete ——
                case 'propose-complete': {
                    const note = arg.trim();
                    if (note.length === 0)
                        return bad('用法：/continuity propose-complete <收口说明>');
                    return ok(await submitText(id, { kind: 'mission.proposeComplete', requestId: mintId('req'), note }, invocationCtx));
                }
                case 'complete': {
                    const optionalTaskIds = csv(arg);
                    return ok(await submitText(id, { kind: 'mission.complete', requestId: mintId('req'), ...(optionalTaskIds.length > 0 ? { optionalTaskIds } : {}) }, invocationCtx));
                }
                // —— actor.dormant / actor.retire / actor.bind ——
                case 'dormant': {
                    const [targetActorId = '', mode = '', waitingFor = ''] = sect(3);
                    if (targetActorId.length === 0)
                        return bad('用法：/continuity dormant <actorId> <sleep|wake> [等待说明]');
                    if (mode !== 'sleep' && mode !== 'wake')
                        return bad('dormant 需要 sleep 或 wake');
                    const actor = state.actors[targetActorId];
                    if (actor === undefined)
                        return bad(`Actor ${targetActorId} 不存在`);
                    if (actor.retired)
                        return bad(`Actor ${targetActorId} 已退役，不能再休眠`);
                    const dormant = mode === 'sleep';
                    return ok(await submitText(id, { kind: 'actor.dormant', requestId: mintId('req'), targetActorId, dormant, ...(dormant && waitingFor.length > 0 ? { waitingFor } : {}) }, invocationCtx));
                }
                case 'retire': {
                    const targetActorId = arg.trim();
                    if (targetActorId.length === 0)
                        return bad('用法：/continuity retire <actorId>');
                    if (state.actors[targetActorId] === undefined)
                        return bad(`Actor ${targetActorId} 不存在`);
                    return ok(await submitText(id, { kind: 'actor.retire', requestId: mintId('req'), targetActorId }, invocationCtx));
                }
                case 'bind': {
                    const [targetActorId = '', targetSession = ''] = arg.split(/\s+/u);
                    if (targetActorId.length === 0 || (targetSession ?? '').length === 0)
                        return bad('用法：/continuity bind <actorId> <新 sessionId>');
                    const actor = state.actors[targetActorId];
                    if (actor === undefined)
                        return bad(`Actor ${targetActorId} 不存在`);
                    if (actor.retired)
                        return bad(`Actor ${targetActorId} 已退役，不能再换绑`);
                    return ok(await submitText(id, { kind: 'actor.bind', requestId: mintId('req'), targetActorId, sessionId: targetSession }, invocationCtx));
                }
                // —— team.configure / team.message / team.ack ——
                case 'team': {
                    const [teamId = '', membersRaw = '', limitRaw = ''] = sect(3);
                    const memberActorIds = csv(membersRaw);
                    const concurrencyLimit = intArg(limitRaw);
                    if (teamId.length === 0 || memberActorIds.length === 0 || concurrencyLimit === undefined || concurrencyLimit < 1)
                        return bad('用法：/continuity team <teamId> | <成员1,成员2> | <并发上限≥1>');
                    if (state.mission.leadActorId === undefined)
                        return bad('Mission 还没有 Lead：team.configure 需要已有 leadActorId 才建得了队（§7.5）');
                    const missing = memberActorIds.filter((memberId) => state.actors[memberId] === undefined);
                    if (missing.length > 0)
                        return bad(`成员不存在：${missing.join(', ')}`);
                    return ok(await submitText(id, { kind: 'team.configure', requestId: mintId('req'), teamId, memberActorIds, concurrencyLimit }, invocationCtx));
                }
                case 'message': {
                    const [head = '', taskIdSec = '', causalSec = ''] = sect(3);
                    const [toActorId = '', kind = '', ...bodyParts] = head.split(/\s+/u);
                    const body = bodyParts.join(' ');
                    if (toActorId.length === 0 || kind.length === 0 || body.length === 0)
                        return bad('用法：/continuity message <收件人> <类型> <正文> [| 任务ID | 因果消息ID]');
                    if (!oneOf(kind, MESSAGE_KINDS))
                        return bad('消息类型不在词表：clarify_request|finding|blocker_report|result_submit|review_request|change_proposal|rotation_seed|challenge|correction');
                    if (state.actors[toActorId] === undefined)
                        return bad(`收件人 ${toActorId} 不是本 Mission 的 Actor`);
                    if (taskIdSec.length > 0 && state.tasks[taskIdSec] === undefined)
                        return bad(`任务 ${taskIdSec} 不存在`);
                    // correction 缺被更正的原消息 ID 时内核直接退回（§7.3）。
                    if (kind === 'correction' && causalSec.length === 0)
                        return bad('correction 必须带被更正的原消息 ID，否则更正链断裂、内核退回');
                    return ok(await submitText(id, {
                        kind: 'team.message', requestId: mintId('req'), toActorId, messageKind: kind, body,
                        ...(taskIdSec.length > 0 ? { taskId: taskIdSec } : {}), ...(causalSec.length > 0 ? { causalMessageId: causalSec } : {}),
                    }, invocationCtx));
                }
                case 'ack': {
                    const [messageId = '', handlingRaw = '', reason = ''] = sect(3);
                    if (messageId.length === 0)
                        return bad('用法：/continuity ack <messageId> [accepted|integrated|rejected] [拒绝理由]');
                    if (state.mailbox[messageId] === undefined)
                        return bad(`消息 ${messageId} 不存在`);
                    const handling = handlingRaw.length === 0 ? 'accepted' : handlingRaw;
                    if (!oneOf(handling, HANDLING_STATES))
                        return bad('处理态不在词表：unprocessed|accepted|integrated|rejected');
                    if (handling === 'rejected' && reason.trim().length === 0)
                        return bad('拒绝一条消息必须给理由，否则内核退回（§7.3、§22.14）');
                    return ok(await submitText(id, { kind: 'team.ack', requestId: mintId('req'), messageId, handling: handling, ...(reason.length > 0 ? { reason } : {}) }, invocationCtx));
                }
                // —— artifact.registerVersion / attachEvidence / requestPublish ——
                case 'artifact': {
                    const [taskId = '', uri = '', contentHash = '', hashAlgorithm = '', sourceOperationId = '', attribution = ''] = sect(6);
                    if (taskId.length === 0 || uri.length === 0 || contentHash.trim().length === 0)
                        return bad('用法：/continuity artifact <taskId> | <uri> | <contentHash> [| 哈希算法 | 来源操作ID | 归因]');
                    if (state.tasks[taskId] === undefined)
                        return bad(`任务 ${taskId} 不存在`);
                    if (attribution.length > 0 && !oneOf(attribution, ARTIFACT_ATTRIBUTIONS))
                        return bad('归因不在词表：tool_operation|native_identity|observed|reconciled|unknown');
                    return ok(await submitText(id, {
                        kind: 'artifact.registerVersion', requestId: mintId('req'), taskId, uri, contentHash,
                        ...(hashAlgorithm.length > 0 ? { hashAlgorithm } : {}), ...(sourceOperationId.length > 0 ? { sourceOperationId } : {}),
                        ...(attribution.length > 0 ? { attribution: attribution } : {}),
                    }, invocationCtx));
                }
                case 'attach': {
                    const [artifactId = '', versionRaw = '', refsRaw = '', evidenceKind = '', summary = ''] = sect(5);
                    const evidenceRefs = csv(refsRaw);
                    const version = intArg(versionRaw);
                    if (artifactId.length === 0 || version === undefined || evidenceRefs.length === 0)
                        return bad('用法：/continuity attach <artifactId> | <版本≥1> | <证据引用1,证据引用2> [| 来源类别 | 摘要]');
                    if (evidenceKind.length > 0 && !oneOf(evidenceKind, SOURCE_CATEGORIES))
                        return bad('来源类别不在词表');
                    const found = Object.values(state.artifacts).some((group) => group.some((item) => item.artifactId === artifactId && item.version === version));
                    if (!found)
                        return bad(`产物 ${artifactId} v${version} 不存在`);
                    return ok(await submitText(id, {
                        kind: 'artifact.attachEvidence', requestId: mintId('req'), artifactId, version, evidenceRefs,
                        ...(evidenceKind.length > 0 ? { evidenceKind: evidenceKind } : {}), ...(summary.length > 0 ? { summary } : {}),
                    }, invocationCtx));
                }
                case 'publish': {
                    const [artifactId = '', versionRaw = '', grantId = '', targetIdentity = ''] = sect(4);
                    const version = intArg(versionRaw);
                    if (artifactId.length === 0 || version === undefined || grantId.length === 0)
                        return bad('用法：/continuity publish <artifactId> | <版本> | <grantId> [目标身份]');
                    if (state.grants[grantId] === undefined)
                        return bad(`授权 ${grantId} 不存在`);
                    return ok(await submitText(id, { kind: 'artifact.requestPublish', requestId: mintId('req'), artifactId, version, grantId, ...(targetIdentity.length > 0 ? { targetIdentity } : {}) }, invocationCtx));
                }
                // —— operation.intent / receipt / reconcile ——
                case 'intent': {
                    const [taskId = '', operationKind = '', target = '', intentText = '', idempotencyKey = '', retryableRaw = '', reconcileMethod = '', reserveRaw = '', actionRaw = ''] = sect(9);
                    const retryable = boolArg(retryableRaw, false);
                    if (taskId.length === 0 || operationKind.length === 0 || target.length === 0 || intentText.length === 0 || idempotencyKey.length === 0 || retryable === undefined) {
                        return bad('用法：/continuity intent <taskId> | <操作类型> | <目标> | <意图说明> | <幂等键> | <true|false> [| 核对方法 | 预留tokens,calls | 动作:授权ID:目标身份:环境]');
                    }
                    if (state.tasks[taskId] === undefined)
                        return bad(`任务 ${taskId} 不存在`);
                    const reserve = csv(reserveRaw);
                    const reserveTokens = intArg(reserve[0] ?? '');
                    const reserveCalls = intArg(reserve[1] ?? '');
                    if (reserveRaw.length > 0 && (reserveTokens === undefined || reserveCalls === undefined))
                        return bad('预留 tokens/calls 须为整数');
                    const [actName = '', actGrant = '', actTargetId = '', actEnv = ''] = actionRaw.split(':');
                    if (actionRaw.length > 0) {
                        if (!oneOf(actName, GRANT_ACTIONS))
                            return bad('动作类别不在词表：read|write|dispatch|publish|delete|external_submit|process_stop');
                        if (actGrant.length === 0)
                            return bad('声明动作类别必须带覆盖它的 grantId，否则内核退回（§22.8、§22.13）');
                        if (state.grants[actGrant] === undefined)
                            return bad(`授权 ${actGrant} 不存在`);
                    }
                    return ok(await submitText(id, {
                        kind: 'operation.intent', requestId: mintId('req'), taskId, operationKind, target, intent: intentText, idempotencyKey, retryable,
                        ...(reconcileMethod.length > 0 ? { reconcileMethod } : {}),
                        ...(reserveTokens !== undefined ? { reserveTokens } : {}), ...(reserveCalls !== undefined ? { reserveCalls } : {}),
                        ...(actionRaw.length > 0 ? { action: actName } : {}), ...(actGrant.length > 0 ? { grantId: actGrant } : {}),
                        ...(actTargetId.length > 0 ? { targetIdentity: actTargetId } : {}), ...(actEnv.length > 0 ? { environment: actEnv } : {}),
                    }, invocationCtx));
                }
                case 'receipt': {
                    const [operationId = '', status = '', resultRef = '', externalPhase = '', usageRaw = ''] = sect(5);
                    if (operationId.length === 0)
                        return bad('用法：/continuity receipt <operationId> <succeeded|failed> [| 结果引用 | 外部阶段 | 用量:输入,输出,缓存读,调用]');
                    if (status !== 'succeeded' && status !== 'failed')
                        return bad('回执状态只能是 succeeded 或 failed');
                    if (state.operations[operationId] === undefined)
                        return bad(`操作 ${operationId} 不存在`);
                    if (externalPhase.length > 0 && !oneOf(externalPhase, EXTERNAL_PHASES))
                        return bad('外部阶段不在词表：accepted|processing|succeeded|failed|unknown');
                    const usageParts = csv(usageRaw);
                    const inputTokens = intArg(usageParts[0] ?? '');
                    const outputTokens = intArg(usageParts[1] ?? '');
                    const cacheReadTokens = intArg(usageParts[2] ?? '');
                    const calls = intArg(usageParts[3] ?? '');
                    if (usageRaw.length > 0 && (inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined || calls === undefined))
                        return bad('用量四项须为整数：输入,输出,缓存读,调用');
                    return ok(await submitText(id, {
                        kind: 'operation.receipt', requestId: mintId('req'), operationId, status: status,
                        ...(resultRef.length > 0 ? { resultRef } : {}), ...(externalPhase.length > 0 ? { externalPhase: externalPhase } : {}),
                        ...(inputTokens !== undefined ? { usage: { inputTokens, outputTokens: outputTokens ?? 0, cacheReadTokens: cacheReadTokens ?? 0, calls: calls ?? 0 } } : {}),
                    }, invocationCtx));
                }
                case 'reconcile': {
                    const [operationId = '', verdict = '', resultRef = ''] = arg.split(/\s+/u);
                    if (operationId.length === 0 || !oneOf(verdict, ['executed', 'not_executed', 'still_unknown']))
                        return bad('用法：/continuity reconcile <operationId> <executed|not_executed|still_unknown> [结果引用]');
                    if (state.operations[operationId] === undefined)
                        return bad(`操作 ${operationId} 不存在`);
                    return ok(await submitText(id, { kind: 'operation.reconcile', requestId: mintId('req'), operationId, verdict, ...(resultRef !== undefined && resultRef.length > 0 ? { resultRef } : {}) }, invocationCtx));
                }
                // —— delegate.start / delegate.collect ——
                case 'delegate': {
                    const [taskId = '', nativeRunId = '', childSessionId = '', dispatchId = ''] = sect(4);
                    if (taskId.length === 0)
                        return bad('用法：/continuity delegate <taskId> [| 原生运行ID | 子会话ID | 派单ID]');
                    const task = state.tasks[taskId];
                    if (task === undefined)
                        return bad(`任务 ${taskId} 不存在`);
                    if (task.currentAttemptId === undefined)
                        return bad(`${taskId} 没有进行中的 Attempt：先 claim 才能 delegate.start`);
                    return ok(await submitText(id, {
                        kind: 'delegate.start', requestId: mintId('req'), taskId,
                        ...(nativeRunId.length > 0 ? { nativeRunId } : {}), ...(childSessionId.length > 0 ? { childSessionId } : {}), ...(dispatchId.length > 0 ? { dispatchId } : {}),
                    }, invocationCtx));
                }
                case 'collect': {
                    const [taskId = '', refsRaw = '', evidenceRaw = ''] = sect(3);
                    const resultRefs = csv(refsRaw);
                    const evidenceRefs = csv(evidenceRaw);
                    if (taskId.length === 0 || resultRefs.length === 0)
                        return bad('用法：/continuity collect <taskId> | <结果引用1,结果引用2> [| 证据ID1,证据ID2]');
                    const task = state.tasks[taskId];
                    if (task === undefined)
                        return bad(`任务 ${taskId} 不存在`);
                    if (task.currentAttemptId === undefined)
                        return bad(`${taskId} 没有进行中的 Attempt`);
                    return ok(await submitText(id, { kind: 'delegate.collect', requestId: mintId('req'), taskId, resultRefs, ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}) }, invocationCtx));
                }
                // —— continuity.resolveUnknown ——
                case 'resolve': {
                    const [rotationId = '', decision = ''] = arg.split(/\s+/u);
                    if (rotationId.length === 0 || !oneOf(decision, ['activate_target', 'keep_source']))
                        return bad('用法：/continuity resolve <rotationId> <activate_target|keep_source>');
                    if (state.rotations[rotationId] === undefined)
                        return bad(`轮换 ${rotationId} 不存在`);
                    return ok(await submitText(id, { kind: 'continuity.resolveUnknown', requestId: mintId('req'), rotationId, decision }, invocationCtx));
                }
                // —— propagation.resolve ——
                case 'resolve-propagation': {
                    const [propagationId = '', targetKind = '', targetId = '', reason = ''] = sect(4);
                    if (reason.trim().length === 0)
                        return bad('用法：/continuity resolve-propagation [传播ID] [| 目标类型 | 目标ID] | <裁定理由>（理由必填）');
                    if (propagationId.length === 0 && targetKind.length === 0 && targetId.length === 0) {
                        return bad('resolve-propagation 必须点名到条目或目标：一条命令清空整个积压等于把缺口藏起来（§22.6）');
                    }
                    if (state.pendingPropagations.length === 0)
                        return bad('当前没有待传播项');
                    const matched = state.pendingPropagations.filter((item) => (propagationId.length === 0 || item.propagationId === propagationId)
                        && (targetKind.length === 0 || item.targetKind === targetKind)
                        && (targetId.length === 0 || item.targetId === targetId));
                    if (matched.length === 0) {
                        return bad(`没有匹配的待传播项。现有：${state.pendingPropagations.map((item) => `${item.propagationId}（${item.targetKind}=${item.targetId}）`).join('、')}`);
                    }
                    const result = await submitText(id, {
                        kind: 'propagation.resolve',
                        requestId: mintId('req'),
                        ...(propagationId.length === 0 ? {} : { propagationId }),
                        ...(targetKind.length === 0 ? {} : { targetKind }),
                        ...(targetId.length === 0 ? {} : { targetId }),
                        reason,
                    }, invocationCtx);
                    return ok(`${result}\n注意：这条裁定只收掉待传播项，任务与产物的当前有效性要靠复核拿回来（§22.6）。`);
                }
                // —— evidence.record ——
                case 'evidence': {
                    const [kind = '', summary = '', sourceRef = '', taskId = '', attemptId = '', observedRaw = '', value = '', unit = '', metricId = '', contentHash = '', environment = '', methodVersion = ''] = sect(12);
                    if (!oneOf(kind, SOURCE_CATEGORIES))
                        return bad('用法：/continuity evidence <来源类别> | <摘要> | <来源引用> [| 任务ID | 尝试ID | 观测毫秒 | 值 | 单位 | 指标ID | 内容哈希 | 环境 | 方法版本]（来源类别：observation|reported|inference|simulated|reference_bound）');
                    if (summary.trim().length === 0 || sourceRef.trim().length === 0)
                        return bad('evidence 需要非空摘要与来源引用，否则内核退回（§22.1）');
                    if (taskId.length > 0 && state.tasks[taskId] === undefined)
                        return bad(`任务 ${taskId} 不存在`);
                    if (attemptId.length > 0 && state.attempts[attemptId] === undefined)
                        return bad(`尝试 ${attemptId} 不存在`);
                    const evidence = {
                        kind, summary, sourceRef, observedAt: intArg(observedRaw) ?? invocationCtx.now,
                        ...(taskId.length > 0 ? { taskId } : {}), ...(attemptId.length > 0 ? { attemptId } : {}), ...(value.length > 0 ? { value } : {}),
                        ...(unit.length > 0 ? { unit } : {}), ...(metricId.length > 0 ? { metricId } : {}), ...(contentHash.length > 0 ? { contentHash } : {}),
                        ...(environment.length > 0 ? { environment } : {}), ...(methodVersion.length > 0 ? { methodVersion } : {}),
                    };
                    return ok(await submitText(id, { kind: 'evidence.record', requestId: mintId('req'), evidence }, invocationCtx));
                }
                // —— claim.propose / claim.revise ——
                case 'assert': {
                    const [proposition = '', appliesRaw = '', sourceCategory = '', statusRaw = '', supportRaw = '', contraRaw = '', reentryRaw = '', subjectRaw = ''] = sect(8);
                    if (proposition.trim().length === 0)
                        return bad('用法：/continuity assert <命题> [| 适用条件1,条件2 | 来源类别 | 状态 | 支持证据1,2 | 反证1,2 | 再入条件1,2 | 主体:实现版本:输入条件:验证范围]');
                    if (!oneOf(sourceCategory, SOURCE_CATEGORIES))
                        return bad('assert 需要来源类别（observation|reported|inference|simulated|reference_bound，§22.1）');
                    const status = statusRaw.length === 0 ? 'proposed' : statusRaw;
                    if (!oneOf(status, CLAIM_STATUSES))
                        return bad('主张状态不在词表：proposed|supported|unsupported|refuted|superseded');
                    const [subject = '', implementationVersion = '', inputCondition = '', verifiedRange = ''] = subjectRaw.split(':');
                    const claim = {
                        proposition, sourceCategory, status, appliesUnder: csv(appliesRaw), supportingEvidenceIds: csv(supportRaw), contradictingEvidenceIds: csv(contraRaw), reentryConditions: csv(reentryRaw),
                        ...(subject.length > 0 ? { subject } : {}), ...(implementationVersion.length > 0 ? { implementationVersion } : {}),
                        ...(inputCondition.length > 0 ? { inputCondition } : {}), ...(verifiedRange.length > 0 ? { verifiedRange } : {}),
                    };
                    return ok(await submitText(id, { kind: 'claim.propose', requestId: mintId('req'), claim }, invocationCtx));
                }
                case 'assert-retract': {
                    const [claimId = '', proposition = '', appliesRaw = '', statusRaw = '', supportRaw = '', contraRaw = '', reentryRaw = '', retractionReason = ''] = sect(8);
                    if (claimId.length === 0)
                        return bad('用法：/continuity assert-retract <claimId> [| 新命题 | 适用条件1,2 | 状态 | 支持证据1,2 | 反证1,2 | 再入条件1,2 | 撤回理由]');
                    if (state.claims[claimId] === undefined)
                        return bad(`主张 ${claimId} 不存在：先用 assert 建立链头`);
                    // 有效性与版本由内核按撤回语义盖（§22.6），CLI 不暴露 validity。
                    let status;
                    if (statusRaw.length > 0) {
                        if (!oneOf(statusRaw, CLAIM_STATUSES))
                            return bad('主张状态不在词表');
                        status = statusRaw;
                    }
                    return ok(await submitText(id, {
                        kind: 'claim.revise', requestId: mintId('req'), claimId,
                        ...(proposition.length > 0 ? { proposition } : {}), ...(appliesRaw.length > 0 ? { appliesUnder: csv(appliesRaw) } : {}),
                        ...(status !== undefined ? { status } : {}), ...(supportRaw.length > 0 ? { supportingEvidenceIds: csv(supportRaw) } : {}),
                        ...(contraRaw.length > 0 ? { contradictingEvidenceIds: csv(contraRaw) } : {}), ...(reentryRaw.length > 0 ? { reentryConditions: csv(reentryRaw) } : {}),
                        ...(retractionReason.length > 0 ? { retractionReason } : {}),
                    }, invocationCtx));
                }
                // —— challenge.raise / challenge.resolve ——
                case 'challenge': {
                    const [targetKind = '', targetId = '', quotedText = '', contraRaw = '', affectedRaw = '', adjudicatorRaw = '', severityRaw = '', targetRevRaw = ''] = sect(8);
                    if (!oneOf(targetKind, CHALLENGE_TARGET_KINDS))
                        return bad('用法：/continuity challenge <目标类型> | <目标ID> | <被质疑原文> [| 反证ID1,2 | 受影响动作1,2 | 裁定人actorId | 严重度 | 目标修订]（目标类型：task|criteria|claim|artifact|verification）');
                    if (targetId.length === 0)
                        return bad('challenge 需要目标 ID');
                    if (quotedText.trim().length === 0)
                        return bad('challenge 必须引用被质疑的原文（quotedText），否则内核退回（§7.3）');
                    if (targetKind === 'task' && state.tasks[targetId] === undefined)
                        return bad(`任务 ${targetId} 不存在`);
                    if (targetKind === 'claim' && state.claims[targetId] === undefined)
                        return bad(`主张 ${targetId} 不存在`);
                    if (targetKind === 'criteria' && state.tasks[targetId.split('@')[0] ?? ''] === undefined)
                        return bad(`判据目标 ${targetId} 对应的任务不存在`);
                    if (!oneOf(severityRaw, CHALLENGE_SEVERITIES))
                        return bad('严重度不在词表：hard_conflict|semantic_suspicion|under_evidenced（缺反证的 hard_conflict 会被内核降为 under_evidenced，§22.4）');
                    const adjudicator = adjudicatorRaw.length > 0 ? adjudicatorRaw : (state.mission.leadActorId ?? invocationCtx.actorId);
                    if (adjudicatorRaw.length > 0 && state.actors[adjudicator] === undefined)
                        return bad(`裁定人 ${adjudicator} 不是本 Mission 的 Actor`);
                    const targetRevision = intArg(targetRevRaw);
                    return ok(await submitText(id, {
                        kind: 'challenge.raise', requestId: mintId('req'), targetKind, targetId, quotedText,
                        contradictingEvidenceIds: csv(contraRaw), affectedActionIds: csv(affectedRaw), adjudicatorActorId: adjudicator, severity: severityRaw,
                        ...(targetRevision !== undefined ? { targetRevision } : {}),
                    }, invocationCtx));
                }
                case 'adjudicate': {
                    const [challengeId = '', outcome = '', resolution = '', mergedInto = ''] = sect(4);
                    if (challengeId.length === 0 || !oneOf(outcome, ['upheld', 'dismissed', 'merged']))
                        return bad('用法：/continuity adjudicate <challengeId> <upheld|dismissed|merged> <裁定说明> [合并入challengeId]');
                    if (resolution.trim().length === 0)
                        return bad('裁定必须给出说明（resolution），否则内核退回（§7.3）');
                    const challenge = state.challenges[challengeId];
                    if (challenge === undefined)
                        return bad(`质疑 ${challengeId} 不存在`);
                    if (challenge.outcome !== 'open')
                        return bad(`质疑 ${challengeId} 已裁定（${challenge.outcome}），不重复处理`);
                    if (outcome === 'merged' && (mergedInto.length === 0 || state.challenges[mergedInto] === undefined))
                        return bad('merged 需要指向另一条存在的 challengeId');
                    return ok(await submitText(id, { kind: 'challenge.resolve', requestId: mintId('req'), challengeId, outcome, resolution, ...(outcome === 'merged' ? { mergedInto } : {}) }, invocationCtx));
                }
                // —— search.record ——
                case 'search': {
                    const [query = '', rootsRaw = '', coverage = '', outcome = '', mode = '', pagesRaw = '', flagsRaw = '', filtersRaw = '', synonymsRaw = '', errorsRaw = '', refsRaw = '', observedRaw = ''] = sect(12);
                    const roots = csv(rootsRaw);
                    if (query.trim().length === 0 || roots.length === 0)
                        return bad('用法：/continuity search <查询> | <检索根1,根2> | <覆盖complete|partial|unknown> | <结果found|not_found_in_scope|incomplete|error> [| 模式literal|regex | 取回页数 | 还有更多,是否截断(true,false) | 过滤1,2 | 同义词1,2 | 错误1,2 | 结果引用1,2 | 观测毫秒]');
                    // 覆盖边界是假阴性的出口，缺了它"没找到"就写不成结论（§22.2）。
                    if (!oneOf(coverage, ['complete', 'partial', 'unknown']))
                        return bad('search 必须声明覆盖边界（complete|partial|unknown），否则内核退回（§22.2）');
                    if (!oneOf(outcome, ['found', 'not_found_in_scope', 'incomplete', 'error']))
                        return bad('检索结果不在词表：found|not_found_in_scope|incomplete|error');
                    const modeValue = mode.length === 0 ? 'literal' : mode;
                    if (!oneOf(modeValue, ['literal', 'regex']))
                        return bad('检索模式只能是 literal 或 regex');
                    const flags = csv(flagsRaw);
                    const hasMore = boolArg(flags[0] ?? '', false);
                    const truncated = boolArg(flags[1] ?? '', false);
                    if (hasMore === undefined || truncated === undefined)
                        return bad('还有更多/是否截断须为 true 或 false');
                    const search = {
                        query, mode: modeValue, roots, coverage, outcome, hasMore, truncated,
                        filters: csv(filtersRaw), synonyms: csv(synonymsRaw), errors: csv(errorsRaw), resultRefs: csv(refsRaw),
                        pagesFetched: intArg(pagesRaw) ?? 0, observedAt: intArg(observedRaw) ?? invocationCtx.now,
                    };
                    return ok(await submitText(id, { kind: 'search.record', requestId: mintId('req'), search }, invocationCtx));
                }
                // —— context.record ——
                case 'context': {
                    const [actorId = '', providedScope = '', completeness = '', taskId = '', gapsRaw = '', rulesRaw = '', claimsRaw = '', inputsRaw = '', ackRaw = ''] = sect(9);
                    if (actorId.length === 0 || providedScope.trim().length === 0)
                        return bad('用法：/continuity context <收件actorId> <提供范围说明> <完整性full|partial|unknown> [| 任务ID | 缺失1,缺失2 | 规则ID=版本,规则ID=版本 | claim引用1,2 | 输入引用1,2 | 已确认true|false]');
                    if (state.actors[actorId] === undefined)
                        return bad(`收件人 ${actorId} 不是本 Mission 的 Actor`);
                    if (!oneOf(completeness, ['full', 'partial', 'unknown']))
                        return bad('完整性只能是 full|partial|unknown');
                    const gaps = csv(gapsRaw);
                    // partial 却不列缺口＝空话（§22.3）。
                    if (completeness === 'partial' && gaps.length === 0)
                        return bad('完整性为 partial 时必须列明缺失项，否则内核退回（§22.3）');
                    if (taskId.length > 0 && state.tasks[taskId] === undefined)
                        return bad(`任务 ${taskId} 不存在`);
                    const acknowledged = boolArg(ackRaw, false);
                    if (acknowledged === undefined)
                        return bad('已确认须为 true 或 false');
                    const ruleVersions = {};
                    for (const pair of csv(rulesRaw)) {
                        const separator = pair.indexOf('=');
                        if (separator <= 0)
                            return bad(`规则版本格式应为 规则ID=版本，收到的是 ${pair}`);
                        const version = intArg(pair.slice(separator + 1).trim());
                        if (version === undefined)
                            return bad(`规则 ${pair.slice(0, separator)} 的版本不是整数`);
                        ruleVersions[pair.slice(0, separator).trim()] = version;
                    }
                    const context = {
                        actorId, providedScope, completeness, acknowledged, ruleVersions, gaps,
                        claimRefs: csv(claimsRaw), inputRefs: csv(inputsRaw), ...(taskId.length > 0 ? { taskId } : {}),
                    };
                    return ok(await submitText(id, { kind: 'context.record', requestId: mintId('req'), context }, invocationCtx));
                }
                // —— validator.qualify ——
                case 'qualify': {
                    const [name = '', inputType = '', scope = '', codeRef = '', eligibleRaw = '', validatorId = '', assertionsRaw = '', allowedRaw = '', samplesRaw = '', countersRaw = '', criteriaRevRaw = '', tolerance = '', reason = ''] = sect(13);
                    if (name.trim().length === 0 || inputType.trim().length === 0 || scope.trim().length === 0 || codeRef.trim().length === 0)
                        return bad('用法：/continuity qualify <验证器名> <输入类型> <范围> <代码引用> <true|false> [| 验证器ID | 断言1,断言2 | 允许缺失1,2 | 有效样例1,2 | 反例1,2 | 判据修订 | 容差依据 | 理由]（名/输入类型/范围/代码引用都必填，§22.10）');
                    const eligible = boolArg(eligibleRaw, false);
                    if (eligible === undefined)
                        return bad('eligible 须为 true 或 false');
                    const criteriaRevision = intArg(criteriaRevRaw);
                    const validator = {
                        name, inputType, scope, codeRef, assertions: csv(assertionsRaw), allowedMissing: csv(allowedRaw),
                        effectiveSampleIds: csv(samplesRaw), counterSampleIds: csv(countersRaw),
                        ...(criteriaRevision !== undefined ? { criteriaRevision } : {}), ...(tolerance.length > 0 ? { toleranceBasis: tolerance } : {}),
                    };
                    return ok(await submitText(id, { kind: 'validator.qualify', requestId: mintId('req'), ...(validatorId.length > 0 ? { validatorId } : {}), validator, eligible, ...(reason.length > 0 ? { reason } : {}) }, invocationCtx));
                }
                // —— obligation.propose / obligation.advance ——
                case 'obligate': {
                    const [ownerActorId = '', statement = '', taskId = '', preconditionsRaw = '', triggerRaw = '', stageRaw = ''] = sect(6);
                    if (ownerActorId.length === 0 || statement.trim().length === 0)
                        return bad('用法：/continuity obligate <负责人actorId> | <承诺说明> [| 任务ID | 前置1,前置2 | 触发毫秒 | 阶段]');
                    const owner = state.actors[ownerActorId];
                    if (owner === undefined)
                        return bad(`负责人 ${ownerActorId} 不是本 Mission 的 Actor`);
                    if (owner.retired)
                        return bad(`负责人 ${ownerActorId} 已退役，不能承接承诺`);
                    if (taskId.length > 0 && state.tasks[taskId] === undefined)
                        return bad(`任务 ${taskId} 不存在`);
                    let stage;
                    if (stageRaw.length > 0) {
                        if (!oneOf(stageRaw, OBLIGATION_STAGES))
                            return bad('阶段不在词表');
                        stage = stageRaw;
                    }
                    const triggerAt = intArg(triggerRaw);
                    const obligation = {
                        statement, ownerActorId, preconditions: csv(preconditionsRaw), ...(taskId.length > 0 ? { taskId } : {}),
                        ...(triggerAt !== undefined ? { triggerAt } : {}), ...(stage !== undefined ? { stage } : {}),
                    };
                    return ok(await submitText(id, { kind: 'obligation.propose', requestId: mintId('req'), obligation }, invocationCtx));
                }
                case 'settle': {
                    const [obligationId = '', stageRaw = '', receiptsRaw = '', reason = '', decisionSource = ''] = sect(5);
                    if (obligationId.length === 0)
                        return bad('用法：/continuity settle <obligationId> | <阶段> [| 回执引用1,2 | 决策/阻塞理由 | 决策来源]');
                    if (!oneOf(stageRaw, OBLIGATION_STAGES))
                        return bad('阶段不在词表：proposed|ready|running|verified|delivered|blocked|deferred|cancelled');
                    const obligation = state.obligations[obligationId];
                    if (obligation === undefined)
                        return bad(`承诺 ${obligationId} 不存在`);
                    const stage = stageRaw;
                    const receipts = csv(receiptsRaw);
                    // 各阶段的必填项：内核缺字段就退回，这里先拦（§22.7）。
                    if ((stage === 'verified' || stage === 'delivered') && receipts.length === 0)
                        return bad(`${stage} 需要回执引用（receiptRefs），否则内核退回（§22.7）`);
                    if (stage === 'blocked' && reason.trim().length === 0)
                        return bad('blocked 需要给出阻塞理由');
                    if ((stage === 'deferred' || stage === 'cancelled') && reason.trim().length === 0 && decisionSource.trim().length === 0)
                        return bad('deferred/cancelled 必须带决策理由或有权来源，否则内核退回（§22.7）');
                    return ok(await submitText(id, {
                        kind: 'obligation.advance', requestId: mintId('req'), obligationId, stage,
                        ...(receipts.length > 0 ? { receiptRefs: receipts } : {}), ...(reason.length > 0 ? { reason } : {}), ...(decisionSource.length > 0 ? { decisionSource } : {}),
                    }, invocationCtx));
                }
                // —— authorization.grant / authorization.revoke ——
                case 'grant': {
                    const [sourceRef = '', actionsRaw = '', objectScopeRaw = '', environment = '', sourceRaw = '', delegatableRaw = '', maxUsesRaw = '', tokenQuotaRaw = '', expiresRaw = ''] = sect(9);
                    if (sourceRef.trim().length === 0 || objectScopeRaw.trim().length === 0 || environment.trim().length === 0)
                        return bad('用法：/continuity grant <来源引用> | <动作1,动作2> | <对象范围1,范围2> | <环境> [| 来源user|deployment | 可转授true|false | 最大次数 | token配额 | 到期毫秒]');
                    const actions = csv(actionsRaw);
                    if (actions.length === 0)
                        return bad('授权必须列出动作类别，否则内核退回（§22.8）');
                    for (const action of actions) {
                        if (!oneOf(action, GRANT_ACTIONS))
                            return bad(`动作类别不在词表：${action}（read|write|dispatch|publish|delete|external_submit|process_stop）`);
                    }
                    const source = sourceRaw.length === 0 ? 'user' : sourceRaw;
                    if (source !== 'user' && source !== 'deployment')
                        return bad('授权来源只能是 user 或 deployment（§22.8）');
                    const delegatable = boolArg(delegatableRaw, false);
                    if (delegatable === undefined)
                        return bad('可转授须为 true 或 false');
                    const maxUses = intArg(maxUsesRaw);
                    const tokenQuota = intArg(tokenQuotaRaw);
                    const expiresAt = intArg(expiresRaw);
                    const grant = {
                        source, sourceRef, environment, delegatable, actions: actions, objectScope: csv(objectScopeRaw),
                        ...(maxUses !== undefined ? { maxUses } : {}), ...(tokenQuota !== undefined ? { tokenQuota } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}),
                    };
                    return ok(await submitText(id, { kind: 'authorization.grant', requestId: mintId('req'), grant }, invocationCtx));
                }
                case 'revoke': {
                    const [grantId = '', ...reasonParts] = arg.split(/\s+/u);
                    const reason = reasonParts.join(' ');
                    if (grantId.length === 0 || reason.trim().length === 0)
                        return bad('用法：/continuity revoke <grantId> <撤销理由>');
                    const grant = state.grants[grantId];
                    if (grant === undefined)
                        return bad(`授权 ${grantId} 不存在`);
                    if (grant.revokedAt !== undefined)
                        return bad(`授权 ${grantId} 已撤销（${grant.revokedReason ?? ''}），不重复处理`);
                    return ok(await submitText(id, { kind: 'authorization.revoke', requestId: mintId('req'), grantId, reason }, invocationCtx));
                }
                // —— dependency.register ——
                case 'depend': {
                    const [targetKind = '', targetId = '', onKind = '', onId = '', onVersionRaw = '', targetRevRaw = ''] = sect(6);
                    if (targetId.trim().length === 0 || onId.trim().length === 0)
                        return bad('用法：/continuity depend <目标类型> | <目标ID> | <依赖类型> | <依赖ID> | <依赖版本> [| 目标修订]');
                    if (!oneOf(targetKind, DEPENDENCY_TARGET_KINDS))
                        return bad('目标类型不在词表：task|attempt|artifact|checkpoint|dispatch|publish|verification|obligation|claim');
                    if (!oneOf(onKind, DEPENDENCY_ON_KINDS))
                        return bad('依赖类型不在词表：claim|evidence|rule|criteria|grant');
                    const onVersion = intArg(onVersionRaw);
                    if (onVersion === undefined)
                        return bad('依赖版本须为整数');
                    const targetRevision = intArg(targetRevRaw);
                    const dependency = {
                        targetKind: targetKind, targetId, onKind: onKind, onId, onVersion,
                        ...(targetRevision !== undefined ? { targetRevision } : {}),
                    };
                    return ok(await submitText(id, { kind: 'dependency.register', requestId: mintId('req'), dependency }, invocationCtx));
                }
                // —— dispatch.plan ——
                case 'dispatch': {
                    const [taskId = '', question = '', submitTo = '', recipient = '', scope = '', criteriaRaw = '', artifactForm = '', budgetNote = '', cancellationPolicy = '', exclusionsRaw = '', inputRefsRaw = '', grantIdsRaw = '', confirmedFactsRaw = '', assumptionsRaw = '', premiseRaw = '', searchesRaw = '', priorRaw = '', validatorsRaw = '', deadlineRaw = '', challengeEntry = '', contextReceiptId = ''] = sect(21);
                    if (taskId.length === 0 || question.trim().length === 0 || submitTo.trim().length === 0 || recipient.length === 0)
                        return bad('用法：/continuity dispatch <taskId> | <问题> | <提交去处> | <交付收件actorId> [| 范围 | 验收1;验收2 | 产物形态 | 预算说明 | 取消策略 | 排除,… | 输入引用,… | 授权ID,… | 已确认事实,… | 假设,… | 前提证据,… | 检索回执,… | 历史结果,… | 验证器,… | 期限毫秒 | 质疑入口 | 上下文回执ID]');
                    if (state.tasks[taskId] === undefined)
                        return bad(`任务 ${taskId} 不存在`);
                    const target = state.actors[recipient];
                    if (target === undefined)
                        return bad(`交付收件人 ${recipient} 不是本 Mission 的 Actor`);
                    if (target.retired)
                        return bad(`交付收件人 ${recipient} 已退役`);
                    const premiseEvidenceIds = csv(premiseRaw);
                    const searchReceiptIds = csv(searchesRaw);
                    // 派单的前提证据与检索回执必须已登记且仍有效，否则内核静默退回（§22.2、§22.6）。
                    const badPremise = premiseEvidenceIds.find((evidenceId) => state.evidence[evidenceId] === undefined);
                    if (badPremise !== undefined)
                        return bad(`前提证据 ${badPremise} 未登记`);
                    const badSearch = searchReceiptIds.find((receiptId) => state.searches[receiptId] === undefined);
                    if (badSearch !== undefined)
                        return bad(`检索回执 ${badSearch} 未登记`);
                    const ruleSnapshot = {};
                    const deadlineAt = intArg(deadlineRaw);
                    const dispatch = {
                        taskId, question, submitTo, deliveryRecipientActorId: recipient,
                        scope, criteria: criteriaOf(criteriaRaw), artifactForm, budgetNote, cancellationPolicy,
                        exclusions: csv(exclusionsRaw), inputRefs: csv(inputRefsRaw), grantIds: csv(grantIdsRaw),
                        confirmedFacts: csv(confirmedFactsRaw), assumptions: csv(assumptionsRaw), premiseEvidenceIds, searchReceiptIds,
                        priorResultRefs: csv(priorRaw), validatorRequirements: csv(validatorsRaw), ruleSnapshot,
                        ...(deadlineAt !== undefined ? { deadlineAt } : {}), ...(challengeEntry.length > 0 ? { challengeEntry } : {}), ...(contextReceiptId.length > 0 ? { contextReceiptId } : {}),
                    };
                    return ok(await submitText(id, { kind: 'dispatch.plan', requestId: mintId('req'), dispatch }, invocationCtx));
                }
                // —— review.record ——
                case 'review': {
                    const [targetKind = '', targetId = '', methodRef = '', selfConsistent = '', versusHistory = '', targetRevRaw = '', sharedRaw = '', sawRefRaw = '', independenceNote = '', novelty = ''] = sect(10);
                    if (targetId.trim().length === 0 || methodRef.trim().length === 0)
                        return bad('用法：/continuity review <目标类型> <目标ID> <方法引用> <自洽结果pass|fail|unknown|error|not_run|not_applicable> <历史对照consistent|conflict|duplicate|unknown> [| 目标修订 | 共享证据,… | 见过参考答案true|false | 独立性说明 | 新意]（目标类型：task|artifact|claim|verification；方法引用与目标 ID 必填，§22.9）');
                    if (!oneOf(targetKind, REVIEW_TARGET_KINDS))
                        return bad('审查目标类型不在词表：task|artifact|claim|verification');
                    if (!oneOf(selfConsistent, VERIFICATION_OUTCOMES))
                        return bad('自洽结果不在验收词表：pass|fail|unknown|error|not_run|not_applicable');
                    if (!oneOf(versusHistory, VERSUS_HISTORY))
                        return bad('历史对照不在词表：consistent|conflict|duplicate|unknown');
                    const sharedEvidenceIds = csv(sharedRaw);
                    const sawReferenceAnswer = boolArg(sawRefRaw, false);
                    if (sawReferenceAnswer === undefined)
                        return bad('见过参考答案须为 true 或 false');
                    // 共用证据或见过参考答案＝非独立，必须说明独立性（§22.9）。
                    if ((sharedEvidenceIds.length > 0 || sawReferenceAnswer) && independenceNote.trim().length === 0)
                        return bad('共用证据或见过参考答案时必须写明独立性说明，否则内核退回（§22.9）');
                    const targetRevision = intArg(targetRevRaw);
                    const review = {
                        targetKind, targetId, selfConsistent, versusHistory, methodRef, sawReferenceAnswer,
                        independenceNote, sharedEvidenceIds, ...(targetRevision !== undefined ? { targetRevision } : {}), ...(novelty.length > 0 ? { novelty } : {}),
                    };
                    return ok(await submitText(id, { kind: 'review.record', requestId: mintId('req'), review }, invocationCtx));
                }
                // —— incident.record ——
                case 'incident': {
                    const [failureMode = '', triggerCondition = '', rootCause = '', fixKind = '', impact = '', operationsRaw = '', recoveryRaw = '', regressionCaseId = ''] = sect(8);
                    if (failureMode.trim().length === 0 || triggerCondition.trim().length === 0 || rootCause.trim().length === 0)
                        return bad('用法：/continuity incident <故障模式> | <触发条件> | <根因> | <修复类别state_field|error_default|execution_wrapper|reject_counterexample|process> [| 影响 | 操作引用,… | 恢复动作,… | 回归用例ID]');
                    if (!oneOf(fixKind, FIX_KINDS))
                        return bad('修复类别不在词表：state_field|error_default|execution_wrapper|reject_counterexample|process');
                    const incident = {
                        failureMode, triggerCondition, rootCause, fixKind, impact,
                        operationRefs: csv(operationsRaw), recoveryActions: csv(recoveryRaw), candidateRuleIds: [],
                        ...(regressionCaseId.length > 0 ? { regressionCaseId } : {}),
                    };
                    return ok(await submitText(id, { kind: 'incident.record', requestId: mintId('req'), incident }, invocationCtx));
                }
                // —— delivery.confirm ——
                case 'deliver': {
                    const [deliveryId = '', stage = '', handlingRaw = '', reason = ''] = sect(4);
                    if (deliveryId.length === 0)
                        return bad('用法：/continuity deliver <deliveryId> | <阶段produced|registered|dispatched|received|processed|unrouted> [| 处理态 | 理由]');
                    if (!oneOf(stage, DELIVERY_STAGES))
                        return bad('交付阶段不在词表：produced|registered|dispatched|received|processed|unrouted');
                    if (state.deliveries[deliveryId] === undefined)
                        return bad(`交付 ${deliveryId} 不存在`);
                    let handling;
                    if (handlingRaw.length > 0) {
                        if (!oneOf(handlingRaw, HANDLING_STATES))
                            return bad('处理态不在词表');
                        handling = handlingRaw;
                    }
                    if (handling === 'rejected' && reason.trim().length === 0)
                        return bad('rejected 必须给理由，否则内核退回（§22.14）');
                    return ok(await submitText(id, { kind: 'delivery.confirm', requestId: mintId('req'), deliveryId, stage, ...(handling !== undefined ? { handling } : {}), ...(reason.length > 0 ? { reason } : {}) }, invocationCtx));
                }
                case 'ack-delivery': {
                    const [deliveryId = '', handling = '', reason = ''] = sect(3);
                    if (deliveryId.length === 0 || !oneOf(handling, ['accepted', 'integrated', 'rejected']))
                        return bad('用法：/continuity ack-delivery <deliveryId> <accepted|integrated|rejected> [理由]');
                    if (state.deliveries[deliveryId] === undefined)
                        return bad(`交付 ${deliveryId} 不存在`);
                    if (handling === 'rejected' && reason.trim().length === 0)
                        return bad('rejected 必须给理由，否则内核退回（§22.14）');
                    // 收件方的处理回执固定推进到 processed；阶段流转与未路由改派用 /continuity deliver（§22.14）。
                    return ok(await submitText(id, { kind: 'delivery.confirm', requestId: mintId('req'), deliveryId, stage: 'processed', handling, ...(reason.length > 0 ? { reason } : {}) }, invocationCtx));
                }
                case 'status':
                    return ok(await statusText(sessionId));
                default:
                    return bad(`未知动词 ${verb}。用法：${USAGE}`);
            }
        };
        const offCommand = ctx.commands.register({
            name: 'continuity',
            description: '长期任务连续性台账：状态、开/改/暂停/恢复/取消/收口 Mission、任务与检查点、重试与任务书修订、身份与团队、产物与证据链（证据/主张/质疑/检索/上下文/验证器资格/承诺/授权/依赖/派单/审查/事故/交付）、操作意图与核对、委托、手动换会话与未决轮换裁定、能力探针、outbox、冷恢复核对。',
            input: { hint: USAGE },
            handler: runCommand,
        });
        const on = (event, listener) => ctx.on(event, listener);
        const offSessionEvents = on('session/event', (session, event) => {
            const sessionId = sessionIdOf(session);
            if (sessionId === undefined)
                return undefined;
            if (event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch')
                ledger.observe(sessionId, event);
            if (event.type === 'compaction/end')
                compactFlags.add(sessionId);
            // 原生成员出生即入台账：不阻塞事件流，失败只记日志（成员没进台账不该拖垮宿主）。
            if (event.type === 'team/member') {
                void onTeamMemberEvent(event).catch((error) => logger.warn(`${name}: 成员入台账失败：${String(error)}`));
                return undefined;
            }
            if (event.type !== 'turn/end')
                return undefined;
            // 同一日志位置只评估一次：`session/event` 每次持久追加都会触发。
            if (!watermark.observe(sessionId, event.seq))
                return undefined;
            const advanced = nextTurn(guards.get(sessionId) ?? initialGuardState());
            const occupancy = occupancyOf(session);
            const justCompacted = compactFlags.delete(sessionId);
            const reduced = reduceGuard(advanced, occupancy, { config: guardConfig(), atTurnBoundary: true, justCompacted });
            guards.set(sessionId, reduced.state);
            const signal = reduced.signal;
            if (signal !== null) {
                const pct = signal.ratio === null ? '未知' : `${(signal.ratio * 100).toFixed(1)}%`;
                logger.info(`${name}: 压力${signal.kind === 'enter' ? '跨档' : '升档'} 档=${signal.level} 占用=${pct} 投影=${signal.projectedTokens ?? '无'} 窗口=${signal.contextWindow ?? '无'} 轮=${signal.turn}${signal.compactionDrop ? '（压缩后回落）' : ''}`);
            }
            void evaluateTurnEnd(sessionId, session, guards.get(sessionId) ?? advanced).catch((error) => logger.warn(`${name}: 轮末评估失败：${String(error)}`));
            return undefined;
        });
        const offAgentStatus = on('agent/status', (payload) => {
            const sessionId = sessionIdOf(payload.agent);
            if (sessionId === undefined)
                return undefined;
            if (payload.status === 'running') {
                // 会话刚开口就补一次定向续期，不等下一个节拍：空闲过 90 秒后，租约已经在数据库里过期，
                // 而模型的第一次写入可能早于最近的一次心跳 tick（最长差 leaseHeartbeatMs）。
                // 那种情况下同一会话的正常继续会被判成过期，只能靠 retry 重新领取，还要吃一次重试预算（§5.3）。
                // 活名单由 Host 报出，进得来就说明执行进程在本进程里活着，不构成抢占（§6.3）。
                const revived = !running.has(sessionId);
                running.add(sessionId);
                if (revived) {
                    void kernel.renewLeases(new Set([sessionId]), settings.leaseExpiryMs).catch((error) => {
                        logger.warn(`${name}: 会话回活时的租约续期失败：${String(error)}`);
                    });
                }
            }
            else {
                running.delete(sessionId);
                // 转空闲即空闲维护窗口：质量链只有在这里才可能真的执行压缩（§27.5 第 3 条、复审 G2）。
                void runIdleQuality(sessionId, sessionObject(sessionId), payload.agent);
            }
            return undefined;
        });
        const forget = (sessionId) => {
            if (sessionId === undefined)
                return;
            running.delete(sessionId);
            guards.delete(sessionId);
            compactFlags.delete(sessionId);
            watermark.reset(sessionId);
            ledger.forget(sessionId);
        };
        const offAgentDisposed = on('agent/disposed', (payload) => {
            forget(sessionIdOf(payload.agent));
            return undefined;
        });
        const offSessionDisposed = on('session/disposed', (session) => {
            forget(sessionIdOf(session));
            return undefined;
        });
        const offPreStep = on('agent/pre-step', preStepGuard(preStepHostFor, (agent) => sessionIdOf(agent)));
        const extraDisposers = [];
        if (settings.registerTools) {
            const registry = tools();
            if (registry === undefined)
                logger.warn(`${name}: registerTools=true 但 tools 服务未装载，跳过注册。`);
            else {
                const replayGuard = new ReplayGuard(settings.replayWindowMs);
                const deps = {
                    kernel,
                    defaultMissionId: missionId,
                    replayGuard,
                    identity: async (execution) => {
                        const id = missionId();
                        const boundSession = execution.agent === undefined ? undefined : String(execution.agent.id);
                        if (id === undefined || boundSession === undefined)
                            return undefined;
                        const state = await kernel.read(id);
                        if (state === null)
                            return undefined;
                        const actor = Object.values(state.actors).find((item) => item.sessionId === boundSession && !item.retired);
                        // sessionId 透传给内核：换绑后旧会话的写入要被 `fromBoundSession` 挡下（§10.3）。
                        return actor === undefined ? undefined : { actorId: actor.actorId, role: actor.role, now: Date.now(), sessionId: boundSession };
                    },
                    // 归档历史回读面（复审 N4）：工具只认这一组只读口，不碰存储句柄。
                    // 水位核对（N3）由工具侧从控制记录算出预期再传进来，本端口只负责转发。
                    history: {
                        currentMissionId: () => missionId(),
                        load: async (id) => await kernel.read(id),
                        snapshot: async (id, expectation) => await readArchiveSnapshot(archivePort.reader, id, expectation),
                    },
                };
                // 顺序即 DS 前缀缓存纪律：`continuity_history` 追加在末尾，前 21 个声明逐字节不变
                // （强制对齐的断言在 test/token-budget.test.ts）。
                const factories = [continuityStatusTool, continuityCheckpointTool, ...commandToolFactories, continuityHistoryTool];
                for (const factory of factories) {
                    extraDisposers.push(registry.register(factory(deps)));
                }
                extraDisposers.push(() => replayGuard.clear());
                if (factories.length !== PLUGIN_TOOL_NAMES.length) {
                    logger.warn(`${name}: 注册面 ${factories.length} 个与 PLUGIN_TOOL_NAMES 的 ${PLUGIN_TOOL_NAMES.length} 个不一致：声明列表与注册表已脱节。`);
                }
                logger.info(`${name}: 已注册 ${factories.length} 个 continuity_* 工具。`);
            }
        }
        if (settings.enforceAdmission) {
            if (!armed()) {
                logger.warn(`${name}: enforceAdmission=true 但能力门禁未放行（tool-guard-coverage 未过且未签字）；guard 会单向拒绝受管写入，本次不注册（§12.2）。`);
            }
            else {
                const registry = tools();
                if (registry === undefined)
                    logger.warn(`${name}: tools 服务未装载，准入守卫无法注册。`);
                else {
                    const snapshot = () => {
                        const state = cachedState();
                        const now = Date.now();
                        const tickets = new Map();
                        // 票据以 Attempt 为准：租约过期或已结算的都不算持有入场权（§12.2）。
                        if (state !== null) {
                            for (const attempt of Object.values(state.attempts)) {
                                if (attempt.status !== 'running' && attempt.status !== 'recovering')
                                    continue;
                                if (attempt.leaseExpiresAt < now)
                                    continue;
                                if (attempt.ticket === undefined)
                                    continue;
                                tickets.set(attempt.actorId, attempt.ticket);
                            }
                        }
                        return { closed: state === null || state.admissionClosed, tickets, state, now, readOnlyTools: new Set(PLUGIN_TOOL_NAMES) };
                    };
                    extraDisposers.push(registry.guard(toolGuard(snapshot, (execution) => {
                        const sessionId = sessionIdOf(execution.agent);
                        if (sessionId === undefined)
                            return undefined;
                        const state = cachedState();
                        if (state === null)
                            return undefined;
                        return Object.values(state.actors).find((item) => item.sessionId === sessionId && !item.retired)?.actorId;
                    })));
                    logger.info(`${name}: 已注册 tools.guard（受管写入需要未失效的准入票据）。`);
                }
            }
        }
        // 成员创建只允许由 Lead 发起（R1）。独立于 enforceAdmission 注册：那条管写入准入票据，
        // 这条管身份权限，两者不是一件事；enforceAdmission 默认 false，不能让它连坐。
        {
            const guardRegistry = tools();
            if (guardRegistry === undefined) {
                logger.warn(`${name}: tools 服务未装载，成员创建守卫无法注册（只有 Lead 能创建成员这条约束本次不生效）。`);
            }
            else {
                extraDisposers.push(guardRegistry.guard(memberCreationGuard((sessionId) => {
                    const state = cachedState();
                    if (state === null)
                        return undefined;
                    return Object.values(state.actors).find((item) => item.sessionId === sessionId && !item.retired);
                }, sessionIdOf)));
                logger.info(`${name}: 已注册 tools.guard（成员创建仅限 Lead）。`);
            }
        }
        let timer;
        if (settings.outboxDrainMs > 0) {
            timer = setInterval(() => {
                void kernel.drain().then((summary) => {
                    if (summary.unconfirmed > 0) {
                        logger.warn(`${name}: outbox attempted=${summary.attempted} completed=${summary.completed} failed=${summary.failed} unsupported=${summary.unsupported} unconfirmed=${summary.unconfirmed}——有投递结果未确认，须与台账核对后再放行重投。`);
                    }
                    else if (summary.attempted + summary.unsupported > 0) {
                        logger.info(`${name}: outbox attempted=${summary.attempted} completed=${summary.completed} failed=${summary.failed} unsupported=${summary.unsupported} unconfirmed=0`);
                    }
                    for (const message of summary.blocked)
                        logger.warn(`${name}: outbox 有条目被跳过：${message}`);
                }, (error) => logger.warn(`${name}: outbox 消费失败：${String(error)}`));
            }, settings.outboxDrainMs);
            timer.unref();
        }
        // 租约续期节拍（§6.2 / §12）：liveness 直接取 Host 的 `agent/status`——`running` 里有的会话才算活着，
        // agent/disposed 与 session/disposed 会把它抹掉，本进程重启后也是空的。
        // 因此这个节拍只可能让"确实在跑的执行者"免于 90 秒过期，不可能替死掉的进程守租约。
        let leaseTimer;
        if (settings.leaseHeartbeatMs > 0) {
            leaseTimer = setInterval(() => {
                void kernel.renewLeases(running, settings.leaseExpiryMs).then((count) => { if (count > 0)
                    logger.debug?.(`${name}: 租约续期 ${count} 个 Attempt`); }, (error) => logger.warn(`${name}: 租约续期失败：${String(error)}`));
            }, settings.leaseHeartbeatMs);
            leaseTimer.unref();
        }
        // 台账 → 任务板的投影节拍：开关每次现读（`.volatile()`），关掉后这一拍自然变成空转。
        let boardTimer;
        if (settings.teamBoardMirrorMs > 0) {
            boardTimer = setInterval(() => { void runBoardSync(); }, settings.teamBoardMirrorMs);
            boardTimer.unref();
        }
        void runBoardSync();
        return () => {
            if (timer !== undefined)
                clearInterval(timer);
            if (leaseTimer !== undefined)
                clearInterval(leaseTimer);
            if (boardTimer !== undefined)
                clearInterval(boardTimer);
            for (const dispose of extraDisposers)
                dispose();
            for (const dispose of routeDisposers)
                void dispose();
            offPreStep();
            offSessionDisposed();
            offAgentDisposed();
            offAgentStatus();
            offSessionEvents();
            offCommand();
            latch.clear();
            guards.clear();
            committed.clear();
            ledger.clear();
            watermark.clear();
            activeRotations.clear();
            // 先放锁再关域：放锁失败（比如文件已被手动清掉）不能挡住存储域关闭。
            if (hostLock !== undefined)
                void hostLock.release().catch((error) => logger.warn(`${name}: 单写者锁释放失败：${String(error)}`));
            void domain.close().catch((error) => logger.warn(`${name}: 存储域关闭失败：${String(error)}`));
        };
    }, `${name}: boot`);
}
