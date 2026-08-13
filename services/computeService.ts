/**
 * Compute Service
 *
 * Talks to the scheduler-backed compute API (/api/compute/*) for submitting and
 * managing HPC allocations. Each allocation becomes a cluster server once its
 * job starts and the client registers, so kernels then run on it through the
 * normal cluster path.
 */

import { API_BASE } from './kernelService';
import { authService } from './authService';

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
  /** GPU capacity: total configured vs currently idle (available). */
  /** One entry per GPU model in the partition (heterogeneous queues have several). */
  gpus?: { type: string; total: number; idle: number }[];
  nodes: { idle: number; mixed: number; alloc: number; down: number; total: number };
  jobs: { pending: number; running: number };
  /** Distinct CPU arches of the partition's nodes (e.g. 'x86_64', 'aarch64'). */
  archs?: string[];
}

export interface QosLoad {
  name: string;
  priority: number;
  maxWall?: string;
  /** True if some other QoS can preempt this one (jobs may be interrupted). */
  preemptible: boolean;
  /** QoS names this QoS can preempt. */
  preempts: string[];
  /** Live usage under this QoS across the cluster. */
  jobs: { running: number; pending: number };
}

export interface QueueLoad {
  partitions: PartitionLoad[];
  qoses: QosLoad[];
  fetchedAt: number;
}

export interface ComputePartitions {
  enabled: boolean;
  associations: Associations | null;
  load: QueueLoad | null;
}

export interface StartEstimate {
  startsAt?: string;
  nodes?: string[];
  reason?: string;
}

export interface AllocationSpec {
  partition: string;
  qos?: string;
  account?: string;
  cpus: number;
  memGb: number;
  gpus?: number;
  /** Specific GPU model (scheduler gres name); only meaningful when gpus > 0. */
  gpuType?: string;
  walltimeMinutes: number;
  jobName?: string;
  /** Opt-in: auto-end the allocation after this many idle minutes (client self-exit). */
  idleTimeoutMinutes?: number;
}

export type AllocationState =
  | 'pending'
  | 'running'
  | 'active'
  | 'ended'
  | 'failed'
  | 'cancelled';

export interface Allocation {
  id: string;
  jobId?: string;
  spec: AllocationSpec & { jobName: string };
  state: AllocationState;
  serverId?: string;
  nodes?: string[];
  reason?: string;
  createdAt: number;
  walltimeEndsAt?: number;
}

function authHeaders(): Record<string, string> {
  const token = authService.getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function parseError(response: Response, fallback: string): Promise<never> {
  const data = await response.json().catch(() => ({ error: fallback }));
  throw new Error(data.error || `${fallback}: ${response.statusText}`);
}

/** Whether scheduler-backed compute is available on this server. */
export async function getComputeStatus(): Promise<{ enabled: boolean; scheduler: string | null }> {
  const response = await fetch(`${API_BASE}/compute/status`, { headers: authHeaders() });
  if (!response.ok) return { enabled: false, scheduler: null };
  return response.json();
}

/** Allowed partitions/QoS for the current user + a live load snapshot. */
export async function getComputePartitions(): Promise<ComputePartitions> {
  const response = await fetch(`${API_BASE}/compute/partitions`, { headers: authHeaders() });
  if (!response.ok) await parseError(response, 'Failed to load partitions');
  return response.json();
}

/** QoS names a partition will accept, or null when it accepts any. */
export async function getPartitionQos(partition: string): Promise<string[] | null> {
  const response = await fetch(`${API_BASE}/compute/partition-qos?partition=${encodeURIComponent(partition)}`, {
    headers: authHeaders(),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.allowed ?? null;
}

/** Dry-run estimated start time for a prospective allocation. */
export async function estimateStart(spec: AllocationSpec): Promise<StartEstimate> {
  const params = new URLSearchParams({
    partition: spec.partition,
    cpus: String(spec.cpus),
    memGb: String(spec.memGb),
    walltimeMinutes: String(spec.walltimeMinutes),
  });
  if (spec.qos) params.set('qos', spec.qos);
  if (spec.account) params.set('account', spec.account);
  if (spec.gpus) params.set('gpus', String(spec.gpus));
  const response = await fetch(`${API_BASE}/compute/estimate?${params.toString()}`, { headers: authHeaders() });
  if (!response.ok) await parseError(response, 'Failed to estimate start time');
  return response.json();
}

/** List current allocations (pending / running / active / ended). */
export async function listAllocations(): Promise<Allocation[]> {
  const response = await fetch(`${API_BASE}/compute/allocations`, { headers: authHeaders() });
  if (!response.ok) await parseError(response, 'Failed to list allocations');
  const data = await response.json();
  return data.allocations || [];
}

/** Submit a new compute allocation. */
export async function createAllocation(spec: AllocationSpec): Promise<Allocation> {
  const response = await fetch(`${API_BASE}/compute/allocations`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(spec),
  });
  if (!response.ok) await parseError(response, 'Failed to create allocation');
  return response.json();
}

/** Cancel an allocation (scancel + evict its server). */
export async function cancelAllocation(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/compute/allocations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!response.ok) await parseError(response, 'Failed to cancel allocation');
}
