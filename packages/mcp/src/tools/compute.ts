/**
 * Compute Tools
 *
 * Scheduler-backed compute allocations (HPC clusters). Mirrors the
 * `nebula compute` CLI over the same NebulaClient methods. The feature is
 * detection-gated server-side: on servers without a scheduler, compute_status
 * reports enabled=false and the other tools fail with a clear message.
 */

import type { Tool, MCPContent, ToolResult } from './types.js';
import type {
  ComputeAllocation,
  ComputePartitions,
  ComputeStatus,
  ComputeSpec,
  NebulaClient,
} from '../notebook/client.js';

const TERMINAL_STATES = new Set(['ended', 'failed', 'cancelled']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeAllocation(a: ComputeAllocation): string {
  const gpus = a.spec.gpus ? `, ${a.spec.gpus} GPU${a.spec.gpus > 1 ? 's' : ''}${a.spec.gpuType ? ` (${a.spec.gpuType})` : ''}` : '';
  const where = a.serverId ? ` server=${a.serverId}` : '';
  const nodes = a.nodes?.length ? ` node=${a.nodes.join(',')}` : '';
  const idle = a.spec.idleTimeoutMinutes ? `, auto-ends after ${a.spec.idleTimeoutMinutes}min idle` : '';
  return `${a.id} [${a.state}] ${a.spec.partition}${a.spec.qos ? `/${a.spec.qos}` : ''} — ${a.spec.cpus} CPU, ${a.spec.memGb}G${gpus}, ${a.spec.walltimeMinutes}min walltime${idle}${where}${nodes}`;
}

async function findAllocation(
  client: NebulaClient,
  idOrName: string
): Promise<ToolResult<ComputeAllocation>> {
  const list = await client.listAllocations();
  if (!list.success) return { success: false, error: list.error };
  const found =
    list.data!.find((a) => a.id === idOrName) ??
    list.data!.find((a) => a.spec.jobName === idOrName);
  if (!found) {
    return { success: false, error: `Allocation not found: ${idOrName}. Use list_allocations to see current allocations.` };
  }
  return { success: true, data: found };
}

// =============================================================================
// compute_status
// =============================================================================

export interface ComputeStatusParams {}

export const computeStatusTool: Tool<ComputeStatusParams, ComputeStatus> = {
  definition: {
    name: 'compute_status',
    description:
      'Check whether scheduler-backed cluster compute (allocations) is available on this Nebula server. Returns enabled + scheduler name. Call this before any other compute tool — the feature is absent on servers without a scheduler (e.g. laptops).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: { readOnlyHint: true },
  },

  async execute(_params, client) {
    return client.computeStatus();
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { enabled, scheduler } = result.data!;
    return [{
      type: 'text',
      text: enabled
        ? `Cluster compute enabled (scheduler: ${scheduler}). See queues with list_compute_queues.`
        : 'No scheduler on this server — compute allocations unavailable; kernels run directly on the server.',
    }];
  },
};

// =============================================================================
// list_compute_queues
// =============================================================================

export interface ListComputeQueuesParams {}

export const listComputeQueuesTool: Tool<ListComputeQueuesParams, ComputePartitions> = {
  definition: {
    name: 'list_compute_queues',
    description:
      'List cluster partitions and QoS with live load: idle/total CPUs, idle GPUs by type, queue backlog (pending/running jobs), and which partitions/QoS the user may submit to. Use it to pick a partition before request_allocation.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: { readOnlyHint: true },
  },

  async execute(_params, client) {
    const result = await client.listPartitions();
    if (!result.success) return { success: false, error: result.error };
    if (!result.data!.enabled) {
      return { success: false, error: 'No scheduler on this server — compute allocations unavailable.' };
    }
    return { success: true, data: result.data! };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const data = result.data!;
    const lines: string[] = [];
    const allowed = new Set(data.associations?.partitions ?? []);
    lines.push('Partitions:');
    for (const p of data.load?.partitions ?? []) {
      const gpus = p.gpus?.length
        ? `, GPUs ${p.gpus.map((g) => `${g.idle}/${g.total} idle (${g.type})`).join(', ')}`
        : '';
      // Non-x86 queues need matching-arch runtimes/envs — agents must know.
      const arch = p.archs?.some((a) => a !== 'x86_64') ? `, arch ${p.archs!.join('+')}` : '';
      const restricted = allowed.size > 0 && !allowed.has(p.name) ? ' [not allowed for you]' : '';
      lines.push(
        `  - ${p.name}: ${p.up ? 'up' : 'down'}, limit ${p.timeLimit}${arch}, CPUs ${p.cpus.idle}/${p.cpus.total} idle${gpus}, backlog ${p.jobs.pending} pending / ${p.jobs.running} running${restricted}`
      );
    }
    lines.push('QoS:');
    for (const q of data.load?.qoses ?? []) {
      const bits = [
        `priority ${q.priority}`,
        q.maxWall ? `max wall ${q.maxWall}` : null,
        q.preemptible ? 'preemptible' : null,
        q.name === data.associations?.defaultQos ? 'default' : null,
      ].filter(Boolean);
      lines.push(`  - ${q.name}: ${bits.join(', ')} — ${q.jobs.pending} pending / ${q.jobs.running} running`);
    }
    if (data.associations?.account) {
      lines.push(`Account: ${data.associations.account}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
};

// =============================================================================
// request_allocation
// =============================================================================

export interface RequestAllocationParams {
  partition: string;
  qos?: string;
  cpus?: number;
  mem_gb?: number;
  gpus?: number;
  gpu_type?: string;
  walltime_minutes?: number;
  name?: string;
  idle_timeout_minutes?: number;
  wait_for_active?: boolean;
  max_wait?: number;
}

export const requestAllocationTool: Tool<RequestAllocationParams, ComputeAllocation> = {
  definition: {
    name: 'request_allocation',
    description:
      'Request a compute allocation from the cluster scheduler. Allocations consume REAL cluster resources — only request one when the user\'s task actually needs it, request modest sizes, and cancel_allocation when done. Set wait_for_active=true to block until the allocation is usable (state=active), then bind a notebook with use_allocation.',
    inputSchema: {
      type: 'object',
      properties: {
        partition: { type: 'string', description: 'Partition (queue) to submit to — see list_compute_queues' },
        qos: { type: 'string', description: 'QoS to submit under (some partitions require one)' },
        cpus: { type: 'number', description: 'CPU cores (default 1)' },
        mem_gb: { type: 'number', description: 'Memory in GB (default 4)' },
        gpus: { type: 'number', description: 'Number of GPUs (default 0)' },
        gpu_type: { type: 'string', description: 'Specific GPU model (only with gpus > 0)' },
        walltime_minutes: { type: 'number', description: 'Walltime in minutes (default 120)' },
        name: { type: 'string', description: 'Job name (default nebula-<partition>)' },
        idle_timeout_minutes: { type: 'number', description: 'Auto-end the allocation after this many minutes with no kernel/terminal activity (recommended: 60) — a safety net against forgotten allocations' },
        wait_for_active: { type: 'boolean', description: 'Block until the allocation is active or fails (default false)' },
        max_wait: { type: 'number', description: 'Max seconds to wait when wait_for_active=true (default 300); returns the current state on expiry' },
      },
      required: ['partition'],
    },
    annotations: { destructiveHint: false },
  },

  async execute(params, client) {
    const spec: ComputeSpec = { partition: params.partition };
    if (params.qos !== undefined) spec.qos = params.qos;
    if (params.cpus !== undefined) spec.cpus = params.cpus;
    if (params.mem_gb !== undefined) spec.memGb = params.mem_gb;
    if (params.gpus !== undefined) spec.gpus = params.gpus;
    if (params.gpu_type !== undefined) spec.gpuType = params.gpu_type;
    if (params.walltime_minutes !== undefined) spec.walltimeMinutes = params.walltime_minutes;
    if (params.name !== undefined) spec.jobName = params.name;
    if (params.idle_timeout_minutes !== undefined) spec.idleTimeoutMinutes = params.idle_timeout_minutes;

    const status = await client.computeStatus();
    if (status.success && !status.data!.enabled) {
      return { success: false, error: 'No scheduler on this server — compute allocations unavailable.' };
    }

    const created = await client.createAllocation(spec);
    if (!created.success) return { success: false, error: created.error };
    let alloc = created.data!;

    if (params.wait_for_active) {
      const maxWait = params.max_wait && params.max_wait > 0 ? params.max_wait : 300;
      const deadline = Date.now() + maxWait * 1000;
      let pollMs = 1000;
      while (alloc.state !== 'active' && !TERMINAL_STATES.has(alloc.state) && Date.now() < deadline) {
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
        pollMs = Math.min(pollMs * 1.5, 5000);
        const list = await client.listAllocations();
        if (list.success) {
          const found = list.data!.find((a) => a.id === alloc.id);
          if (found) alloc = found;
        }
      }
      if (TERMINAL_STATES.has(alloc.state)) {
        return {
          success: false,
          error: `Allocation ${alloc.id} ${alloc.state}${alloc.reason ? ` (${alloc.reason})` : ''}`,
        };
      }
    }

    return { success: true, data: alloc };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const alloc = result.data!;
    const next =
      alloc.state === 'active'
        ? `Bind a notebook to it with use_allocation(allocation_id="${alloc.id}", path=...). Cancel it with cancel_allocation when the task is done.`
        : `Still ${alloc.state} — check progress with list_allocations; it must be active before use_allocation.`;
    return [{ type: 'text', text: `Allocation requested:\n  ${describeAllocation(alloc)}\n${next}` }];
  },
};

// =============================================================================
// list_allocations
// =============================================================================

export interface ListAllocationsParams {}

export const listAllocationsTool: Tool<ListAllocationsParams, { allocations: ComputeAllocation[] }> = {
  definition: {
    name: 'list_allocations',
    description:
      'List compute allocations on the server with state (pending/running/active/ended/failed/cancelled), resources, and the serverId/node once active.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: { readOnlyHint: true },
  },

  async execute(_params, client) {
    const result = await client.listAllocations();
    if (!result.success) return { success: false, error: result.error };
    return { success: true, data: { allocations: result.data! } };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { allocations } = result.data!;
    if (allocations.length === 0) {
      return [{ type: 'text', text: 'No compute allocations.' }];
    }
    const lines = allocations.map((a) => `  - ${describeAllocation(a)}`);
    return [{ type: 'text', text: `Allocations:\n${lines.join('\n')}` }];
  },
};

// =============================================================================
// cancel_allocation
// =============================================================================

export interface CancelAllocationParams {
  allocation_id: string;
}

export const cancelAllocationTool: Tool<CancelAllocationParams, { cancelled: boolean; id: string }> = {
  definition: {
    name: 'cancel_allocation',
    description:
      'Cancel a compute allocation and free its cluster nodes. Cancel allocations you created once the task completes; never cancel allocations you did not create.',
    inputSchema: {
      type: 'object',
      properties: {
        allocation_id: { type: 'string', description: 'Allocation id (from request_allocation / list_allocations)' },
      },
      required: ['allocation_id'],
    },
    annotations: { destructiveHint: true },
  },

  async execute(params, client) {
    const result = await client.cancelAllocation(params.allocation_id);
    if (!result.success) return { success: false, error: result.error };
    return { success: true, data: { cancelled: true, id: params.allocation_id } };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    return [{ type: 'text', text: `Allocation ${result.data!.id} cancelled.` }];
  },
};

// =============================================================================
// use_allocation
// =============================================================================

export interface UseAllocationParams {
  allocation_id: string;
  path: string;
  kernel_name?: string;
}

export interface UseAllocationResult {
  allocationId: string;
  serverId: string;
  sessionId: string;
  kernelName: string;
  path: string;
}

export const useAllocationTool: Tool<UseAllocationParams, UseAllocationResult> = {
  definition: {
    name: 'use_allocation',
    description:
      'Bind a notebook\'s kernels to an active compute allocation: starts (or reuses) the notebook\'s kernel on the allocation\'s server and saves it as the notebook\'s kernel preference. After this, execute_cell on that notebook runs on the allocation. Requires the allocation to be state=active.',
    inputSchema: {
      type: 'object',
      properties: {
        allocation_id: { type: 'string', description: 'Allocation id or job name (must be active)' },
        path: { type: 'string', description: 'Notebook path on the server' },
        kernel_name: { type: 'string', description: 'Kernel name (default python3)' },
      },
      required: ['allocation_id', 'path'],
    },
    annotations: { destructiveHint: false },
  },

  async execute(params, client) {
    const found = await findAllocation(client, params.allocation_id);
    if (!found.success) return { success: false, error: found.error };
    const alloc = found.data!;
    if (alloc.state !== 'active' || !alloc.serverId) {
      return {
        success: false,
        error: `Allocation ${alloc.id} is not active (state: ${alloc.state}) — kernels need an active allocation. Check list_allocations, or request one with request_allocation(wait_for_active=true).`,
      };
    }
    const bound = await client.getOrCreateKernelForFile(params.path, params.kernel_name, alloc.serverId);
    if (!bound.success) return { success: false, error: bound.error };
    return {
      success: true,
      data: {
        allocationId: alloc.id,
        serverId: alloc.serverId,
        sessionId: bound.data!.sessionId,
        kernelName: bound.data!.kernelName,
        path: params.path,
      },
    };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const d = result.data!;
    return [{
      type: 'text',
      text: `Notebook ${d.path} bound to allocation ${d.allocationId} (server ${d.serverId}); kernel session ${d.sessionId} (${d.kernelName}). execute_cell on this notebook now runs on the allocation. Cancel the allocation with cancel_allocation when the task is done.`,
    }];
  },
};

// =============================================================================
// Export all compute tools
// =============================================================================

export const computeTools = [
  computeStatusTool,
  listComputeQueuesTool,
  requestAllocationTool,
  listAllocationsTool,
  cancelAllocationTool,
  useAllocationTool,
];
