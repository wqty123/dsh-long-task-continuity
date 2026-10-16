/**
 * Host 内唯一的命令队列与独占运行锁（设计稿 v0.3 §5.2）。
 *
 * 单记录原子写只保证一条记录内部的一致；"先查不存在、再 put" 这类跨读写竞争、
 * 以及跨 Mission 的共享资源裁决，必须靠同一条串行链完成。
 */
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
export class CommandQueue {
    tail = Promise.resolve();
    queued = 0;
    active = 0;
    labels = [];
    maxQueueLength;
    // 显式赋值而不是构造参数属性：`erasableSyntaxOnly` 要求语法可擦除，Node 的类型剥离才跑得动本包。
    constructor(maxQueueLength = 256) {
        this.maxQueueLength = maxQueueLength;
    }
    get depth() {
        return this.queued;
    }
    get running() {
        return this.active;
    }
    /** 排队诊断用；不落盘、不作为进展指标。 */
    snapshot() {
        return [...this.labels];
    }
    enqueue(label, run) {
        if (this.queued >= this.maxQueueLength) {
            return Promise.reject(new Error(`command queue saturated at ${this.maxQueueLength}: ${label}`));
        }
        this.queued += 1;
        this.labels.push(label);
        if (this.labels.length > this.maxQueueLength)
            this.labels.shift();
        const settle = () => {
            this.queued -= 1;
            this.active += 1;
            return run().then((value) => {
                this.active -= 1;
                return value;
            }, (error) => {
                this.active -= 1;
                throw error;
            });
        };
        const result = this.tail.then(settle, settle);
        // 失败不能让链断掉：下一位照常入场。
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
}
/** `process.kill(pid, 0)` 只探测存在性，不发送信号。 */
export function isPidAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM 说明进程存在但属于别人。
        return error.code === 'EPERM';
    }
}
/**
 * 接管判定：只看时间戳不够。心跳过期但进程仍在运行 ⇒ 不接管。
 * 进程已不存在 ⇒ 接管；进程存在但心跳长期停滞 ⇒ 交给人判定，不自动接管。
 */
export function decideTakeover(record, now, heartbeatMs, hardStaleMs) {
    if (now - record.stamp > hardStaleMs && !isPidAlive(record.pid))
        return { takeover: true, reason: 'owner-dead' };
    if (now - record.stamp <= heartbeatMs)
        return { takeover: false, reason: 'fresh-heartbeat' };
    if (isPidAlive(record.pid))
        return { takeover: false, reason: 'held-alive' };
    return { takeover: true, reason: 'owner-stamped-away' };
}
export class HostLock {
    timer;
    held = false;
    path;
    hostId;
    heartbeatMs;
    hardStaleMs;
    constructor(path, hostId, heartbeatMs = 10_000, hardStaleMs = 5 * 60_000) {
        this.path = path;
        this.hostId = hostId;
        this.heartbeatMs = heartbeatMs;
        this.hardStaleMs = hardStaleMs;
    }
    get isHeld() {
        return this.held;
    }
    /** 独占获取；已有存活持有者即抛，绝不作为并行写入者启动。 */
    async acquire(now = Date.now) {
        const record = { hostId: this.hostId, pid: process.pid, stamp: now(), storePath: this.path };
        try {
            const handle = await open(this.path, 'wx', 0o600);
            await handle.writeFile(JSON.stringify(record), 'utf8');
            await handle.close();
            this.held = true;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const existing = await this.read();
            if (existing === null)
                throw new Error(`host lock at ${this.path} exists but is unreadable; refusing to start as a second writer`);
            const verdict = decideTakeover(existing, now(), this.heartbeatMs, this.hardStaleMs);
            if (!verdict.takeover) {
                throw new Error(`host lock held by ${existing.hostId} (pid ${existing.pid}): ${verdict.reason}`);
            }
            await this.steal(record);
            this.held = true;
        }
        if (this.held)
            this.beat(now);
    }
    async steal(record) {
        // 先改名再写：避免两个候选者同时判定可接管时互相覆盖。
        const tombstone = `${this.path}.stale-${record.pid}-${record.stamp}`;
        try {
            await rename(this.path, tombstone);
        }
        catch {
            // 已被别人抢走改名权。
            throw new Error(`host lock at ${this.path} changed hands during takeover; retry later`);
        }
        const handle = await open(this.path, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(record), 'utf8');
        await handle.close();
    }
    beat(now) {
        this.timer = setInterval(() => {
            void this.read().then(async (existing) => {
                if (existing === null || existing.hostId !== this.hostId || existing.pid !== process.pid) {
                    this.held = false;
                    if (this.timer !== undefined)
                        clearInterval(this.timer);
                    return;
                }
                await this.write({ ...existing, stamp: now() });
            });
        }, this.heartbeatMs);
        // 心跳不该拖住进程退出。
        if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
            this.timer.unref();
        }
    }
    async release() {
        if (this.timer !== undefined)
            clearInterval(this.timer);
        this.timer = undefined;
        const existing = await this.read();
        if (existing !== null && existing.hostId === this.hostId && existing.pid === process.pid) {
            await this.write({ ...existing, stamp: 0, hostId: `${existing.hostId}#released` });
        }
        this.held = false;
    }
    async read() {
        try {
            return JSON.parse(await readFile(this.path, 'utf8'));
        }
        catch {
            return null;
        }
    }
    async write(record) {
        await writeFile(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
}
/** 路径规范化只在 Windows 上有坑：大小写不敏感、`/` 与 `\\` 混用。 */
export function canonicalPath(path) {
    try {
        return realpathSync.native(path).replace(/\\/g, '/').toLowerCase();
    }
    catch {
        return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }
}
export function parentDir(path) {
    return dirname(path);
}
