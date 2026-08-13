/**
 * Allocation service — owns the lifecycle a compute allocation has *before* and
 * *around* the cluster registry: submit a job, follow it through the queue, and
 * correlate the client-server's registration (by one-time token) back to the
 * allocation. Once correlated, the allocation is a normal registered server and
 * kernels run on it through the existing cluster path.
 *
 * Phase-1 MVP: in-memory allocations, direct transport (no SSH tunnel — not
 * needed where compute↔login is directly reachable).
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Scheduler, JobSpec } from './types';
import { renderJobScript, type LaunchContext } from './job-template';
import { pickLaunchContext } from './arch';
import { summarizeLogTail } from './util';
import { serverRegistry } from '../cluster/server-registry';

export type AllocationState =
  | 'pending'   // submitted, waiting in the queue
  | 'running'   // job is running, client-server not yet registered
  | 'active'    // client-server registered — usable for kernels
  | 'ended'     // job finished / walltime hit / cancelled cleanly
  | 'failed'    // job failed
  | 'cancelled';

export interface Allocation {
  id: string;
  jobId?: string;
  token: string;
  spec: JobSpec;
  state: AllocationState;
  serverId?: string;
  nodes?: string[];
  reason?: string;
  createdAt: number;
  walltimeEndsAt?: number;
}

// Adaptive polling: fast only while a transition is imminent (job climbing
// the queue / server booting), slow once allocations are correlated and
// steady (we're only watching for job end), slowest when idle. Each squeue
// poll is a real scheduler hit on a shared login node — don't burn them.
const POLL_FAST_MS = 5_000;    // pending/running/uncorrelated allocations
const POLL_STEADY_MS = 30_000; // all tracked allocations active + correlated
const POLL_IDLE_MS = 60_000;   // nothing non-terminal to watch
const TERMINAL: AllocationState[] = ['ended', 'failed', 'cancelled'];

export class AllocationService {
  private scheduler: Scheduler | null = null;
  private ctx: LaunchContext | null = null;
  private allocations = new Map<string, Allocation>();
  private pollTimer: NodeJS.Timeout | null = null;
  private enabled = false;
  private lastPollAt = 0;
  private lostListenerRegistered = false;

  init(scheduler: Scheduler, ctx: LaunchContext): void {
    this.scheduler = scheduler;
    this.ctx = ctx;
    this.enabled = true;
    fs.mkdirSync(ctx.stateDir, { recursive: true });
    this.loadPersisted();
    this.scheduleNextPoll(POLL_FAST_MS);
    // React instantly when the cluster layer loses contact with a server
    // that belongs to one of our allocations (kernel WS dropped, proxy
    // request refused, heartbeat timeout) — verify against the scheduler
    // NOW instead of waiting out the steady 30s cadence.
    if (!this.lostListenerRegistered) {
      this.lostListenerRegistered = true;
      serverRegistry.onServerLost((server) => {
        const tracked = [...this.allocations.values()].some(
          (a) => !TERMINAL.includes(a.state) &&
            (a.serverId === server.id || (server.allocationToken && a.token === server.allocationToken))
        );
        if (tracked) {
          console.log(`[Scheduler] Lost contact with ${server.id} — checking its allocation now`);
          this.pollNow();
        }
      });
    }
  }

  /** Poll immediately (debounced to 2s so error bursts don't hammer squeue). */
  pollNow(): void {
    if (!this.enabled) return;
    if (Date.now() - this.lastPollAt < 2_000) return;
    this.scheduleNextPoll(0);
  }

  private stateFile(): string | null {
    return this.ctx ? path.join(this.ctx.stateDir, 'allocations.json') : null;
  }

  /**
   * Allocations survive head-server restarts: persisted on every change,
   * reloaded on init. A reloaded 'active' allocation is demoted to 'running'
   * with its serverId cleared — the registry is empty after a restart, and
   * the compute node's client-server re-registers itself (heartbeat -> 404
   * -> re-register with its allocation token) within ~30s, at which point
   * poll() re-correlates and promotes it back to 'active'. The SLURM job
   * itself is re-checked by jobId on the next poll, so jobs that died while
   * we were down are marked ended/failed instead of lingering.
   */
  private persist(): void {
    const file = this.stateFile();
    if (!file) return;
    try {
      const all = [...this.allocations.values()];
      // Cap history so the file can't grow unboundedly: all live ones,
      // plus the 20 most recent terminal ones for the UI's history list.
      const live = all.filter((a) => !TERMINAL.includes(a.state));
      const done = all.filter((a) => TERMINAL.includes(a.state))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...live, ...done]));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('[Scheduler] failed to persist allocations:', err);
    }
  }

  private loadPersisted(): void {
    const file = this.stateFile();
    if (!file || !fs.existsSync(file)) return;
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf-8')) as Allocation[];
      let revived = 0;
      for (const alloc of list) {
        if (!alloc?.id || this.allocations.has(alloc.id)) continue;
        if (!TERMINAL.includes(alloc.state)) {
          if (alloc.state === 'active') alloc.state = 'running';
          alloc.serverId = undefined; // fresh registry — re-correlate via token
          revived++;
        }
        this.allocations.set(alloc.id, alloc);
      }
      if (revived) console.log(`[Scheduler] Recovered ${revived} live allocation(s) from disk`);
    } catch (err) {
      console.error('[Scheduler] failed to load persisted allocations:', err);
    }
  }

  /** Pick the poll cadence from what we're actually waiting for. */
  private nextPollDelay(): number {
    const live = [...this.allocations.values()].filter((a) => !TERMINAL.includes(a.state));
    if (live.length === 0) return POLL_IDLE_MS;
    return live.some((a) => a.state !== 'active' || !a.serverId) ? POLL_FAST_MS : POLL_STEADY_MS;
  }

  private scheduleNextPoll(delay: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      try {
        await this.poll();
      } catch (err) {
        console.error('[Scheduler] poll error:', err);
      }
      if (this.enabled) this.scheduleNextPoll(this.nextPollDelay());
    }, delay);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getScheduler(): Scheduler | null {
    return this.scheduler;
  }

  list(): Allocation[] {
    return [...this.allocations.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Allocation | undefined {
    return this.allocations.get(id);
  }

  async create(spec: JobSpec): Promise<Allocation> {
    if (!this.scheduler || !this.ctx) throw new Error('scheduler not initialized');

    const id = randomUUID().slice(0, 8);
    const token = randomUUID();
    const alloc: Allocation = { id, token, spec, state: 'pending', createdAt: Date.now() };

    // Cross-arch partitions (aarch64 queues under an x86_64 server) launch a
    // per-arch runtime — or refuse HERE, actionably, instead of letting the
    // job die on the node with "Exec format error" in an unread log.
    let targetArch: string | null = null;
    try {
      targetArch = await this.scheduler.partitionArch(spec.partition);
    } catch {
      targetArch = null;
    }
    const launchCtx = pickLaunchContext(this.ctx, targetArch, this.ctx.serverArch);

    const script = renderJobScript(spec, launchCtx, id, token);
    const scriptPath = path.join(this.ctx.stateDir, `${id}.sh`);
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });

    const { jobId } = await this.scheduler.submit(scriptPath);
    alloc.jobId = jobId;
    this.allocations.set(id, alloc);
    this.persist();
    console.log(`[Scheduler] Allocation ${id} submitted as job ${jobId} (${spec.partition}${spec.qos ? '/' + spec.qos : ''})`);
    // Poll now and drop back to the fast cadence — a create can land while
    // the poller is in a slow idle/steady wait.
    this.scheduleNextPoll(0);
    return alloc;
  }

  async cancel(id: string): Promise<boolean> {
    const alloc = this.allocations.get(id);
    if (!alloc) return false;
    if (alloc.jobId && this.scheduler) {
      try {
        await this.scheduler.cancel(alloc.jobId);
      } catch (err) {
        console.error(`[Scheduler] scancel failed for ${alloc.jobId}:`, err);
      }
    }
    if (alloc.serverId) serverRegistry.unregister(alloc.serverId);
    alloc.state = 'cancelled';
    this.persist();
    return true;
  }

  private async poll(): Promise<void> {
    if (!this.scheduler) return;
    this.lastPollAt = Date.now();
    let dirty = false;
    for (const alloc of this.allocations.values()) {
      if (TERMINAL.includes(alloc.state)) continue;

      // Correlate: has the client-server for this allocation registered yet?
      if (!alloc.serverId) {
        const server = serverRegistry.getServerByAllocationToken(alloc.token);
        if (server) {
          alloc.serverId = server.id;
          alloc.state = 'active';
          alloc.nodes = [server.host];
          dirty = true;
          if (!alloc.walltimeEndsAt) {
            alloc.walltimeEndsAt = Date.now() + alloc.spec.walltimeMinutes * 60_000;
          }
          console.log(`[Scheduler] Allocation ${alloc.id} active — registered as ${server.id}`);
        }
      }

      // Follow the job through the scheduler.
      if (!alloc.jobId) continue;
      let status;
      try {
        status = await this.scheduler.query(alloc.jobId);
      } catch {
        continue;
      }

      if (status.state === 'running' && alloc.state === 'pending') {
        alloc.state = 'running';
        dirty = true;
        alloc.nodes = status.nodes.length ? status.nodes : alloc.nodes;
        if (!alloc.walltimeEndsAt) {
          alloc.walltimeEndsAt = Date.now() + alloc.spec.walltimeMinutes * 60_000;
        }
      } else if (['completed', 'cancelled', 'failed'].includes(status.state)) {
        alloc.state = status.state === 'failed' ? 'failed' : status.state === 'cancelled' ? 'cancelled' : 'ended';
        alloc.reason = status.reason;
        // A failure (or an exit that never registered) explains itself in the
        // job log; the scheduler's reason alone ("NonZeroExitCode") does not.
        if (alloc.state === 'failed' || (alloc.state === 'ended' && !alloc.serverId)) {
          const tail = this.readLogTail(alloc.id);
          if (tail) alloc.reason = [status.reason, tail].filter(Boolean).join(' — ');
        }
        dirty = true;
        if (alloc.serverId) serverRegistry.unregister(alloc.serverId);
        console.log(`[Scheduler] Allocation ${alloc.id} ${alloc.state} (job ${alloc.jobId})`);
      }
    }
    if (dirty) this.persist();
  }

  /** Last few lines of an allocation's job log (bounded read), or null. */
  private readLogTail(allocId: string): string | null {
    if (!this.ctx) return null;
    const file = path.join(this.ctx.stateDir, `${allocId}.log`);
    try {
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, 'r');
      try {
        const want = Math.min(size, 4096);
        const buf = Buffer.alloc(want);
        fs.readSync(fd, buf, 0, want, size - want);
        return summarizeLogTail(buf.toString('utf-8'));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  shutdown(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

export const allocationService = new AllocationService();
