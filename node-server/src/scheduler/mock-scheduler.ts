/**
 * MockScheduler — a fake batch scheduler for demos and tests, with no real
 * cluster behind it. Enabled with `NEBULA_SCHEDULER=mock`.
 *
 * It implements the full `Scheduler` interface with fabricated (but plausibly
 * shaped) partition / QoS / load data, so the real compute UI — allocation modal,
 * cluster-load panel, server list — renders exactly as it would against a live
 * cluster. The names here are generic on purpose (no real site's queues, hosts,
 * accounts, or GPU SKUs) so nothing site-specific leaks into screenshots or the repo.
 *
 * `submit()` runs the *real* rendered client-launch script locally (via `bash`)
 * instead of `sbatch`, so the allocation still registers, flips to an online
 * server, and runs real kernels — the only thing faked is the scheduler itself.
 */

import { spawn, type ChildProcess } from 'child_process';
import type {
  Scheduler, Associations, QueueLoad, JobStatus, StartEstimate, PartitionLoad, QosLoad,
} from './types';

interface MockJob {
  child: ChildProcess | null;
  startedAt: number;
  spawnAt: number;      // when the "queued" job should actually launch
  cancelled: boolean;
  exited: boolean;
  node?: string;        // fabricated compute-node name
}

// A visible queue wait before the job "starts", so the UI shows "Queued · waiting…"
// before flipping to online. Tunable for capture.
const QUEUE_DELAY_MS = Number(process.env.NEBULA_MOCK_QUEUE_MS ?? 5_000);

// Generic, non-identifying cluster shape. Two idle CPU queues, a couple of GPU
// queues with different cards, a big-memory queue, and a preemptible lab queue.
function partitions(): PartitionLoad[] {
  const p = (
    name: string, total: number, idle: number, timeLimit: string,
    jobs: { pending: number; running: number },
    gpus?: { type: string; total: number; idle: number }[],
    nodes?: { idle: number; mixed: number; alloc: number; down: number; total: number },
  ): PartitionLoad => ({
    name, up: true, timeLimit,
    cpus: { idle, alloc: total - idle - 0, other: 0, total },
    gpus,
    nodes: nodes ?? { idle: Math.round(idle / 32), mixed: 4, alloc: 3, down: 0, total: Math.round(total / 32) },
    jobs,
  });
  return [
    p('cpu',      512, 236, '1-00:00:00', { pending: 5,  running: 44 }),
    p('cpu-long', 256, 14,  '7-00:00:00', { pending: 71, running: 58 }),
    // Heterogeneous GPU queue — two card models, shown as separate rows.
    p('gpu',      128, 46,  '1-00:00:00', { pending: 3,  running: 12 }, [
      { type: 'nvidia_l40s',     total: 16, idle: 7 },
      { type: 'nvidia_rtx_6000', total: 8,  idle: 2 },
    ]),
    p('gpu-a100', 96,  22,  '1-00:00:00', { pending: 6,  running: 9  }, [{ type: 'nvidia_a100_80gb', total: 8,  idle: 3 }]),
    p('bigmem',   192, 104, '2-00:00:00', { pending: 1,  running: 6  }),
    p('lab',      64,  28,  '30-00:00:00',{ pending: 0,  running: 3  }, [{ type: 'nvidia_h100_80gb', total: 8,  idle: 5 }]),
  ];
}

function qoses(): QosLoad[] {
  return [
    { name: 'normal',        priority: 100,  preemptible: false, preempts: [],                jobs: { running: 58, pending: 40 } },
    { name: 'priority',      priority: 1000, preemptible: false, preempts: ['opportunistic'], maxWall: '12:00:00', jobs: { running: 9,  pending: 2 } },
    { name: 'opportunistic', priority: 1,    preemptible: true,  preempts: [],                jobs: { running: 27, pending: 14 } },
  ];
}

export class MockScheduler implements Scheduler {
  readonly name = 'mock';
  private jobs = new Map<string, MockJob>();
  private nextJobId = 480217;

  async detect(): Promise<boolean> {
    return true;
  }

  async associations(_user: string): Promise<Associations> {
    return {
      account: 'demo-lab',
      partitions: ['cpu', 'cpu-long', 'gpu', 'gpu-a100', 'bigmem', 'lab'],
      qoses: ['normal', 'priority', 'opportunistic'],
      defaultQos: 'normal',
    };
  }

  async load(): Promise<QueueLoad> {
    return { partitions: partitions(), qoses: qoses(), fetchedAt: Date.now() };
  }

  async allowedQos(partition: string): Promise<string[] | null> {
    // The lab-owned queues require an explicit QoS; the open queues accept any.
    if (partition === 'lab' || partition === 'gpu-a100') return ['priority', 'opportunistic'];
    return null;
  }

  async partitionArch(_partition: string): Promise<string | null> {
    return null; // mock cluster is arch-homogeneous
  }

  async estimateStart(): Promise<StartEstimate> {
    // The launcher uses capacity-based availability, not this dry-run estimate.
    return {};
  }

  async submit(scriptPath: string): Promise<{ jobId: string }> {
    const jobId = String(this.nextJobId++);
    const now = Date.now();
    const job: MockJob = { child: null, startedAt: now, spawnAt: now + QUEUE_DELAY_MS, cancelled: false, exited: false };
    this.jobs.set(jobId, job);
    // After a short "queue wait", run the real client-launch script locally so the
    // allocation registers and becomes a usable online server. Advertise a generic
    // NEBULA_HOST so the (real, local) machine's hostname never surfaces in the UI —
    // the whole allocation reads as a fabricated compute node.
    const nodeName = `node-${String(this.nextJobId % 90 + 10)}`;
    setTimeout(() => {
      if (job.cancelled) return;
      const child = spawn('bash', [scriptPath], {
        stdio: 'ignore',
        env: { ...process.env, NEBULA_HOST: nodeName },
      });
      job.child = child;
      job.node = nodeName;
      child.on('exit', () => { job.exited = true; });
      child.on('error', () => { job.exited = true; });
    }, QUEUE_DELAY_MS);
    return { jobId };
  }

  async query(jobId: string): Promise<JobStatus> {
    const job = this.jobs.get(jobId);
    if (!job) return { state: 'unknown', nodes: [] };
    if (job.cancelled) return { state: 'cancelled', nodes: [] };
    if (job.exited) return { state: 'completed', nodes: [] };
    if (Date.now() < job.spawnAt) return { state: 'pending', nodes: [], reason: 'Resources' };
    return { state: 'running', nodes: job.node ? [job.node] : [] };
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.cancelled = true;
    if (job.child && job.child.exitCode === null) job.child.kill('SIGTERM');
  }
}
