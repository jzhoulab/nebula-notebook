/**
 * SLURM implementation of the Scheduler interface.
 *
 * Everything shells out to the standard SLURM client CLIs (sbatch, squeue,
 * scancel, sinfo, sacctmgr, sacct). The Nebula main server runs on the login
 * node where these are available; detection is capability-based.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  Scheduler,
  JobSpec,
  JobStatus,
  JobState,
  StartEstimate,
  Associations,
  QueueLoad,
  PartitionLoad,
  QosLoad,
} from './types';
import { formatWalltime } from './util';
import { normalizeArch } from './arch';

const execFileP = promisify(execFile);

async function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileP(cmd, args, {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

function toInt(v: string | undefined): number {
  const n = parseInt((v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Pull `Key=value` (value up to next space) out of a `scontrol -o` line. */
function scontrolField(line: string, key: string): string | undefined {
  const m = line.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`));
  return m ? m[1] : undefined;
}

/** Map a SLURM state code or name to our normalized JobState. */
function mapState(raw: string): JobState {
  const s = (raw || '').trim().toUpperCase();
  if (s === 'PD' || s === 'PENDING' || s === 'CF' || s === 'CONFIGURING') return 'pending';
  if (s === 'R' || s === 'RUNNING') return 'running';
  if (s === 'CG' || s === 'COMPLETING') return 'completing';
  if (s === 'CD' || s === 'COMPLETED') return 'completed';
  if (s === 'CA' || s === 'CANCELLED' || s.startsWith('CANCELLED')) return 'cancelled';
  if (['F', 'FAILED', 'TO', 'TIMEOUT', 'NF', 'NODE_FAIL', 'OOM', 'OUT_OF_MEMORY', 'BF', 'BOOT_FAIL', 'DL', 'DEADLINE'].includes(s)) {
    return 'failed';
  }
  return 'unknown';
}

async function expandNodes(nodelist: string): Promise<string[]> {
  const nl = (nodelist || '').trim();
  if (!nl || nl === '(null)' || nl === 'None' || nl === 'n/a') return [];
  // Plain single hostname (no ranges/lists) — the common case for 1-node
  // allocations. Don't shell out to scontrol just to echo it back.
  if (!/[\[\],]/.test(nl)) return [nl];
  try {
    const { stdout } = await run('scontrol', ['show', 'hostnames', nl], 5_000);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [nl];
  }
}

export class SlurmScheduler implements Scheduler {
  readonly name = 'slurm';

  /** Cache of per-partition required-QoS (site job-submit filters change rarely). */
  private qosCache = new Map<string, { allowed: string[] | null; at: number }>();

  // Short-TTL caches + in-flight de-duplication so the dashboard's 15s poll, the
  // allocation modal, and manual refresh don't each re-run the (potentially slow)
  // sinfo/scontrol/squeue/sacctmgr queries against the scheduler.
  // 20s: deliberately ABOVE the clients' 15s poll so steady-state polling
  // alternates cache hit/miss instead of missing every time (10s never hit).
  private static readonly LOAD_TTL_MS = 20_000;
  private static readonly ASSOC_TTL_MS = 60_000;
  private loadCache: { data: QueueLoad; at: number } | null = null;
  private loadInflight: Promise<QueueLoad> | null = null;
  private assocCache = new Map<string, { data: Associations; at: number }>();
  private assocInflight = new Map<string, Promise<Associations>>();

  async detect(): Promise<boolean> {
    try {
      await run('sbatch', ['--version'], 5_000);
      await run('squeue', ['--version'], 5_000);
      return true;
    } catch {
      return false;
    }
  }

  async associations(user: string): Promise<Associations> {
    const cached = this.assocCache.get(user);
    if (cached && Date.now() - cached.at < SlurmScheduler.ASSOC_TTL_MS) return cached.data;
    const inflight = this.assocInflight.get(user);
    if (inflight) return inflight;
    const p = this.associationsFresh(user)
      .then((data) => { this.assocCache.set(user, { data, at: Date.now() }); return data; })
      .finally(() => { this.assocInflight.delete(user); });
    this.assocInflight.set(user, p);
    return p;
  }

  private async associationsFresh(user: string): Promise<Associations> {
    let account: string | undefined;
    const partitions = new Set<string>();
    const qoses = new Set<string>();
    let defaultQos: string | undefined;

    try {
      const { stdout } = await run('sacctmgr', [
        '-nP', 'show', 'assoc', `user=${user}`,
        'format=Account,Partition,QOS,DefaultQOS',
      ]);
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const [acct, part, qos, defQos] = line.split('|');
        if (acct && !account) account = acct.trim();
        if (part && part.trim()) partitions.add(part.trim());
        if (qos) qos.split(',').forEach((q) => q.trim() && qoses.add(q.trim()));
        if (defQos && defQos.trim() && !defaultQos) defaultQos = defQos.trim();
      }
    } catch {
      /* sacctmgr may be unavailable / accounting disabled */
    }

    // Account-level associations often leave Partition blank (== not restricted).
    // Fall back to the full partition list so the user can still pick one;
    // an actually-disallowed choice is caught at submit / estimate time.
    if (partitions.size === 0) {
      try {
        const { stdout } = await run('sinfo', ['-h', '-o', '%R']);
        stdout.split('\n').forEach((p) => {
          const t = p.trim();
          if (t) partitions.add(t);
        });
      } catch {
        /* ignore */
      }
    }

    return {
      account,
      partitions: [...partitions],
      qoses: [...qoses],
      defaultQos,
    };
  }

  async load(): Promise<QueueLoad> {
    if (this.loadCache && Date.now() - this.loadCache.at < SlurmScheduler.LOAD_TTL_MS) {
      return this.loadCache.data;
    }
    if (this.loadInflight) return this.loadInflight;
    const p = this.loadFresh()
      .then((data) => { this.loadCache = { data, at: Date.now() }; return data; })
      .finally(() => { this.loadInflight = null; });
    this.loadInflight = p;
    return p;
  }

  private async loadFresh(): Promise<QueueLoad> {
    const partitions = new Map<string, PartitionLoad>();

    // Fire all four scheduler queries concurrently — the wall time is the slowest
    // one, not the sum (scontrol/squeue dominate on big/busy clusters). Each is
    // independent and optional; a failed query just leaves its slice of data empty.
    const [sinfoRes, nodeRes, squeueRes, qosRes] = await Promise.allSettled([
      run('sinfo', ['-h', '-o', '%R|%a|%l|%C|%D|%T']),
      run('scontrol', ['show', 'node', '-o'], 20_000),
      run('squeue', ['-h', '-r', '-o', '%P|%q|%t']),
      run('sacctmgr', ['-nP', 'show', 'qos', 'format=Name,Priority,MaxWall,Preempt']),
    ]);

    // sinfo emits one line per (partition, node-state) group; aggregate per partition.
    if (sinfoRes.status === 'fulfilled') {
      for (const line of sinfoRes.value.stdout.split('\n')) {
        if (!line.trim()) continue;
        const [name, avail, timeLimit, cpus, nodeCount, stateName] = line.split('|');
        const [ca, ci, co, ct] = (cpus || '').split('/').map(toInt);
        let p = partitions.get(name);
        if (!p) {
          p = {
            name,
            up: (avail || '').trim().toLowerCase() === 'up',
            timeLimit: (timeLimit || '').trim(),
            cpus: { alloc: 0, idle: 0, other: 0, total: 0 },
            nodes: { idle: 0, mixed: 0, alloc: 0, down: 0, total: 0 },
            jobs: { pending: 0, running: 0 },
          };
          partitions.set(name, p);
        }
        p.cpus.alloc += ca; p.cpus.idle += ci; p.cpus.other += co; p.cpus.total += ct;
        const nc = toInt(nodeCount);
        p.nodes.total += nc;
        const st = (stateName || '').trim().toLowerCase();
        if (st.startsWith('idle')) p.nodes.idle += nc;
        else if (st.startsWith('mix') || st.startsWith('alloc')) p.nodes.mixed += nc;
        else if (st.startsWith('down') || st.startsWith('drain') || st.startsWith('fail')) p.nodes.down += nc;
      }
    }

    // GPU capacity per partition, from per-node TRES: configured (CfgTRES) vs
    // allocated (AllocTRES) `gres/gpu`, so we can report *idle* (available) GPUs
    // rather than a per-node count. Generic — no site-specific node/gres names.
    // The same per-node dump also carries each node's CPU arch (`Arch=`), which
    // multi-arch clusters (x86_64 login + aarch64 queues) need at submit time.
    if (nodeRes.status === 'fulfilled') {
      const archAgg = new Map<string, Set<string>>();
      for (const line of nodeRes.value.stdout.split('\n')) {
        if (!line.trim()) continue;
        const arch = scontrolField(line, 'Arch');
        const nodeParts = scontrolField(line, 'Partitions');
        if (arch && nodeParts) {
          for (const part of nodeParts.split(',')) {
            (archAgg.get(part) ?? archAgg.set(part, new Set()).get(part)!).add(arch);
          }
        }
      }
      for (const [part, archs] of archAgg) {
        const p = partitions.get(part);
        if (p) p.archs = [...archs].sort();
      }

      // Aggregate per (partition, GPU model) — heterogeneous queues mix cards.
      const agg = new Map<string, Map<string, { total: number; used: number }>>();
      for (const line of nodeRes.value.stdout.split('\n')) {
        if (!line.trim()) continue;
        const cfg = scontrolField(line, 'CfgTRES') || '';
        const cfgGpu = toInt((cfg.match(/gres\/gpu=(\d+)/) || [])[1]);
        if (cfgGpu === 0) continue; // node has no GPUs
        const parts = scontrolField(line, 'Partitions');
        if (!parts) continue;
        const allocGpu = toInt((scontrolField(line, 'AllocTRES')?.match(/gres\/gpu=(\d+)/) || [])[1]);
        const type = (scontrolField(line, 'Gres')?.match(/gpu:([^:(]+)/) || [])[1] || 'gpu';
        for (const part of parts.split(',')) {
          const byType = agg.get(part) ?? new Map<string, { total: number; used: number }>();
          const e = byType.get(type) || { total: 0, used: 0 };
          e.total += cfgGpu; e.used += allocGpu;
          byType.set(type, e);
          agg.set(part, byType);
        }
      }
      for (const [part, byType] of agg) {
        const p = partitions.get(part);
        if (!p) continue;
        const list = [...byType.entries()]
          .filter(([, g]) => g.total > 0)
          .map(([type, g]) => ({ type, total: g.total, idle: Math.max(0, g.total - g.used) }))
          .sort((a, b) => b.total - a.total || a.type.localeCompare(b.type));
        if (list.length) p.gpus = list;
      }
    }

    // Queue depth from squeue, aggregated per partition AND per QoS.
    const qosUsage = new Map<string, { running: number; pending: number }>();
    if (squeueRes.status === 'fulfilled') {
      for (const line of squeueRes.value.stdout.split('\n')) {
        if (!line.trim()) continue;
        const [part, qos, state] = line.split('|');
        const s = (state || '').trim().toUpperCase();
        const p = partitions.get((part || '').trim());
        if (p) {
          if (s === 'PD') p.jobs.pending += 1;
          else if (s === 'R') p.jobs.running += 1;
        }
        const qn = (qos || '').trim();
        if (qn) {
          const u = qosUsage.get(qn) || { running: 0, pending: 0 };
          if (s === 'PD') u.pending += 1;
          else if (s === 'R') u.running += 1;
          qosUsage.set(qn, u);
        }
      }
    }

    // QoS definitions + preemption graph. In SLURM a QoS's `Preempt` column lists
    // the QoS's it can preempt; a QoS is therefore *preemptible* (can be
    // interrupted) exactly when some other QoS lists it as a preempt target.
    // This is derived entirely from the scheduler — no site-specific QoS names.
    const qoses: QosLoad[] = [];
    if (qosRes.status === 'fulfilled') {
      const rows: { name: string; priority: number; maxWall?: string; preempts: string[] }[] = [];
      for (const line of qosRes.value.stdout.split('\n')) {
        if (!line.trim()) continue;
        const [name, priority, maxWall, preempt] = line.split('|');
        rows.push({
          name: (name || '').trim(),
          priority: toInt(priority),
          maxWall: maxWall && maxWall.trim() ? maxWall.trim() : undefined,
          preempts: (preempt || '').split(',').map((s) => s.trim()).filter(Boolean),
        });
      }
      const preemptedBy = new Set<string>();
      for (const r of rows) for (const target of r.preempts) preemptedBy.add(target);
      for (const r of rows) {
        qoses.push({
          name: r.name,
          priority: r.priority,
          maxWall: r.maxWall,
          preemptible: preemptedBy.has(r.name),
          preempts: r.preempts,
          jobs: qosUsage.get(r.name) || { running: 0, pending: 0 },
        });
      }
    }

    return { partitions: [...partitions.values()], qoses, fetchedAt: Date.now() };
  }

  async partitionArch(partition: string): Promise<string | null> {
    try {
      const load = await this.load();
      const archs = load.partitions.find((p) => p.name === partition)?.archs;
      // Mixed-arch partitions have no safe pick — the scheduler decides the
      // node, so treat them as unknown rather than guessing wrong half the time.
      if (!archs || archs.length !== 1) return null;
      return normalizeArch(archs[0]);
    } catch {
      return null;
    }
  }

  async allowedQos(partition: string): Promise<string[] | null> {
    const cached = this.qosCache.get(partition);
    if (cached && Date.now() - cached.at < 300_000) return cached.allowed;
    let allowed: string[] | null = null;
    try {
      // A no-QoS dry run: succeeds when the partition accepts any QoS. A site
      // job-submit filter that requires an explicit QoS rejects it and names the
      // acceptable set in the message ("... Allowed: a, b").
      await run('sbatch', [
        '--test-only',
        `--partition=${partition}`,
        '--cpus-per-task=1', '--mem=1G', '--time=00:10:00', '--wrap=true',
      ], 15_000);
      allowed = null;
    } catch (e: any) {
      const text = String(e?.stderr || e?.message || '');
      const m = text.match(/requires explicit --qos\.?\s*Allowed:\s*([^\n]+)/i);
      allowed = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : null;
    }
    this.qosCache.set(partition, { allowed, at: Date.now() });
    return allowed;
  }

  async estimateStart(spec: JobSpec): Promise<StartEstimate> {
    const args = [
      '--test-only',
      `--partition=${spec.partition}`,
      `--cpus-per-task=${spec.cpus}`,
      `--mem=${spec.memGb}G`,
      `--time=${formatWalltime(spec.walltimeMinutes)}`,
    ];
    if (spec.qos) args.push(`--qos=${spec.qos}`);
    if (spec.account) args.push(`--account=${spec.account}`);
    if (spec.gpus) args.push(`--gres=gpu:${spec.gpuType ? `${spec.gpuType}:` : ''}${spec.gpus}`);
    args.push('--wrap=true');

    // `sbatch --test-only` writes "Job N to start at <time> ... on nodes <n>" to stderr.
    try {
      const { stdout, stderr } = await run('sbatch', args, 15_000);
      const text = `${stderr}\n${stdout}`;
      const m = text.match(/to start at (\S+)(?:.*?on nodes? (\S+))?/i);
      if (m) return { startsAt: m[1], nodes: m[2] ? [m[2]] : undefined };
      return { reason: text.trim() || 'no estimate available' };
    } catch (e: any) {
      const reason = (e?.stderr || e?.message || 'test-only failed').toString().trim();
      return { reason };
    }
  }

  async submit(scriptPath: string): Promise<{ jobId: string }> {
    const { stdout } = await run('sbatch', ['--parsable', scriptPath]);
    const jobId = stdout.trim().split(';')[0].trim();
    if (!/^\d+$/.test(jobId)) {
      throw new Error(`Unexpected sbatch output: ${stdout.trim()}`);
    }
    return { jobId };
  }

  async query(jobId: string): Promise<JobStatus> {
    // Active jobs: squeue.
    try {
      const { stdout } = await run('squeue', ['-h', '-j', jobId, '-o', '%T|%N|%r']);
      const line = stdout.split('\n').find((l) => l.trim());
      if (line) {
        const [state, nodelist, reason] = line.split('|');
        return {
          state: mapState(state),
          nodes: await expandNodes(nodelist),
          reason: reason && reason.trim() && reason.trim() !== 'None' ? reason.trim() : undefined,
        };
      }
    } catch {
      /* fall through to sacct */
    }
    // Finished jobs: sacct.
    try {
      const { stdout } = await run('sacct', ['-nXP', '-j', jobId, '-o', 'State,NodeList']);
      const line = stdout.split('\n').find((l) => l.trim());
      if (line) {
        const [state, nodelist] = line.split('|');
        return { state: mapState(state), nodes: await expandNodes(nodelist) };
      }
    } catch {
      /* ignore */
    }
    return { state: 'unknown', nodes: [] };
  }

  async cancel(jobId: string): Promise<void> {
    await run('scancel', [jobId]);
  }
}
