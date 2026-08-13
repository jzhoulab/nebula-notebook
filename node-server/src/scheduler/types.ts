/**
 * Scheduler abstraction — a thin interface over an HPC batch scheduler.
 *
 * SLURM is the first implementation; PBS/LSF can implement the same interface
 * later without touching the allocation service or routes.
 */

export type JobState =
  | 'pending'
  | 'running'
  | 'completing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

/** The resource request for one compute allocation. */
export interface JobSpec {
  partition: string;
  qos?: string;
  account?: string;
  cpus: number;
  memGb: number;
  gpus?: number;
  /** Specific GPU model to request (e.g. from the scheduler's gres names). Optional. */
  gpuType?: string;
  walltimeMinutes: number;
  jobName: string;
  /**
   * Opt-in idle auto-release: the client server on the compute node exits its
   * own process after this many minutes without kernel/terminal activity, so
   * the batch job completes and the allocation ends naturally. Omitted = never.
   */
  idleTimeoutMinutes?: number;
}

export interface JobStatus {
  state: JobState;
  nodes: string[];
  reason?: string;
}

/** Result of a dry-run start-time estimate (SLURM `sbatch --test-only`). */
export interface StartEstimate {
  startsAt?: string;
  nodes?: string[];
  reason?: string;
}

/** What a given user is allowed to submit to. */
export interface Associations {
  account?: string;
  partitions: string[];
  qoses: string[];
  defaultQos?: string;
}

export interface PartitionLoad {
  name: string;
  up: boolean;
  timeLimit: string;
  cpus: { alloc: number; idle: number; other: number; total: number };
  /** GPU capacity for the partition, one entry per GPU model (heterogeneous
   *  queues carry several): total configured vs currently idle (available). */
  gpus?: { type: string; total: number; idle: number }[];
  nodes: { idle: number; mixed: number; alloc: number; down: number; total: number };
  jobs: { pending: number; running: number };
  /** Distinct CPU arches of the partition's nodes, SLURM spelling (e.g.
   *  'x86_64', 'aarch64'), sorted. Absent when no node reported one. */
  archs?: string[];
}

export interface QosLoad {
  name: string;
  priority: number;
  maxWall?: string;
  /** True if some other QoS is configured to preempt this one (jobs may be interrupted). */
  preemptible: boolean;
  /** QoS names this QoS can preempt (empty for most). */
  preempts: string[];
  /** Live usage under this QoS across the cluster. */
  jobs: { running: number; pending: number };
}

/** A point-in-time snapshot of cluster busyness for the launcher's load monitor. */
export interface QueueLoad {
  partitions: PartitionLoad[];
  qoses: QosLoad[];
  fetchedAt: number;
}

export interface Scheduler {
  readonly name: string;
  /** Is this scheduler available on this host (are its CLIs present)? */
  detect(): Promise<boolean>;
  /** Partitions/QoS the user may submit to, and their default QoS. */
  associations(user: string): Promise<Associations>;
  /** Per-partition / per-QoS busyness snapshot. */
  load(): Promise<QueueLoad>;
  /**
   * QoS names a partition will actually accept, or null when it accepts any
   * (no explicit-QoS requirement). Lets the UI avoid offering a QoS the
   * scheduler would reject. Discovered from the scheduler, not configured.
   */
  allowedQos(partition: string): Promise<string[] | null>;
  /**
   * The partition's CPU arch as a node process.arch identifier ('x64',
   * 'arm64'), or null when unknown or mixed — null means "assume the
   * server's own arch", preserving pre-multi-arch behavior.
   */
  partitionArch(partition: string): Promise<string | null>;
  /** Dry-run estimated start time for a spec, without submitting. */
  estimateStart(spec: JobSpec): Promise<StartEstimate>;
  /** Submit a rendered job script; returns the scheduler job id. */
  submit(scriptPath: string): Promise<{ jobId: string }>;
  /** Current state of a submitted job. */
  query(jobId: string): Promise<JobStatus>;
  /** Cancel a submitted job. */
  cancel(jobId: string): Promise<void>;
}
