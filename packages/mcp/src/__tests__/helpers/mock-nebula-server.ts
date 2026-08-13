/**
 * In-process mock of the Nebula server HTTP API.
 *
 * Implements the endpoints used by NebulaClient (operation router,
 * notebook read, kernels, fs) against an in-memory notebook store so the
 * MCP integration tests can run without a live Nebula server.
 *
 * Set NEBULA_URL to run the integration tests against a real server instead.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  CellOutput,
  NotebookCell,
  NotebookOperation,
  OperationResult,
} from '../../types.js';

interface StoredNotebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  mtime: number;
}

interface MockAgentSession {
  agentId?: string;
  startedAt: number;
  exclusive?: boolean;
  /** Content hash the agent last saw per cell — mirrors the real router's OCC store. */
  cellHashes: Map<string, string>;
}

interface MockKernelSession {
  id: string;
  kernel_name: string;
  status: string;
  file_path?: string;
  execution_count: number;
  created_at: number;
  /** Server the kernel runs on (set when for-file carries server_id, or via preference). */
  server_id?: string;
}

/** Mirrors node-server's Allocation shape (scheduler/allocation-service.ts). */
interface MockAllocation {
  id: string;
  jobId: string;
  spec: {
    partition: string;
    qos?: string;
    account?: string;
    cpus: number;
    memGb: number;
    gpus?: number;
    gpuType?: string;
    walltimeMinutes: number;
    jobName: string;
    idleTimeoutMinutes?: number;
  };
  state: 'pending' | 'running' | 'active' | 'ended' | 'failed' | 'cancelled';
  serverId?: string;
  nodes?: string[];
  reason?: string;
  createdAt: number;
  walltimeEndsAt?: number;
}

export interface MockNebulaServer {
  /** Base URL of the mock server, e.g. http://127.0.0.1:54321 */
  url: string;
  /** Stop the server */
  close(): Promise<void>;
  /** Clear all in-memory state */
  reset(): void;
  /** Toggle the fake scheduler (compute API answers enabled:false when off). */
  setComputeEnabled(enabled: boolean): void;
  /** How long a new allocation stays pending before flipping to active (ms). */
  setComputeActivationDelay(ms: number): void;
  /** Peek at an allocation (test assertions). */
  getAllocation(id: string): MockAllocation | undefined;
}

export async function startMockNebulaServer(): Promise<MockNebulaServer> {
  const notebooks = new Map<string, StoredNotebook>();
  const textFiles = new Map<string, string>();
  const kernelSessions = new Map<string, MockKernelSession>();
  const agentSessions = new Map<string, MockAgentSession>();
  let sessionCounter = 0;
  let executionCounter = 0;

  // --- Compute allocation state (fabricated scheduler, mirrors mock-scheduler.ts) ---
  const allocations = new Map<string, MockAllocation>();
  /** notebook path → preferred server id (saved by POST kernels/for-file with server_id). */
  const kernelServerPreference = new Map<string, string>();
  const allocationTimers = new Set<NodeJS.Timeout>();
  let computeEnabled = true;
  let activationDelayMs = 150;
  let allocCounter = 0;
  let nextJobId = 480217;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const err = (error: string): OperationResult => ({ success: false, error });

  const ok = (fields: Omit<OperationResult, 'success'> = {}): OperationResult => ({
    success: true,
    backend: 'headless',
    serverTimestamp: Date.now(),
    ...fields,
  });

  function uniqueId(nb: StoredNotebook, requested: string): { id: string; modified: boolean } {
    if (!nb.cells.some((c) => c.id === requested)) {
      return { id: requested, modified: false };
    }
    let n = 1;
    let candidate = `${requested}-${n}`;
    while (nb.cells.some((c) => c.id === candidate)) {
      n += 1;
      candidate = `${requested}-${n}`;
    }
    return { id: candidate, modified: true };
  }

  function resolveCellIndex(
    nb: StoredNotebook,
    options: { cellId?: string; cellIndex?: number }
  ): { index: number } | { error: string } {
    if (options.cellId !== undefined && options.cellId !== null) {
      const index = nb.cells.findIndex((c) => c.id === options.cellId);
      if (index === -1) {
        return { error: `Cell not found: ${options.cellId}` };
      }
      return { index };
    }
    if (options.cellIndex !== undefined && options.cellIndex !== null) {
      if (options.cellIndex < 0 || options.cellIndex >= nb.cells.length) {
        return {
          error: `Cell index ${options.cellIndex} out of range (notebook has ${nb.cells.length} cells)`,
        };
      }
      return { index: options.cellIndex };
    }
    return { error: 'Must provide cellId or cellIndex' };
  }

  /** FNV-1a content hash — MUST match node-server/src/notebook/cell-hash.ts. */
  function hashCellContent(content: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < content.length; i++) {
      hash ^= content.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /** Record the content an agent session last saw for a cell (reads + own writes). */
  function recordSessionHash(path: string, cellId: string, content: string): void {
    const session = agentSessions.get(path);
    if (session) {
      session.cellHashes.set(cellId, hashCellContent(content));
    }
  }

  /**
   * Optimistic concurrency check for destructive writes in collaborative
   * sessions (lenient variant of the real router: only enforced when the
   * op comes from the session's agent and a hash was recorded for the cell).
   * Returns a conflict result, or null to proceed.
   */
  function occCheck(
    path: string,
    op: { agentId?: string },
    cell: NotebookCell
  ): OperationResult | null {
    const session = agentSessions.get(path);
    if (!session || session.exclusive) return null;
    if (!op.agentId || op.agentId !== session.agentId) return null;
    const expected = session.cellHashes.get(cell.id);
    if (!expected) return null;
    const current = hashCellContent(cell.content);
    if (current === expected) return null;
    // Self-healing: re-baseline to the content we hand back, like the real router.
    session.cellHashes.set(cell.id, current);
    const preview = cell.content.slice(0, 2000);
    return {
      success: false,
      conflict: true,
      currentContent: cell.content,
      error:
        `Conflict: cell ${cell.id} was modified (likely by the user) after you last read it. ` +
        `Current content:\n${preview}${cell.content.length > 2000 ? '\n…(truncated)' : ''}\n` +
        `Re-apply your intent against this content and retry.`,
    };
  }

  /** Naive "execution": emits one stdout output per print("...") call. */
  function fakeExecute(content: string): CellOutput[] {
    const outputs: CellOutput[] = [];
    const printRe = /print\((["'])([\s\S]*?)\1\)/g;
    let match: RegExpExecArray | null;
    while ((match = printRe.exec(content)) !== null) {
      outputs.push({ type: 'stdout', content: `${match[2]}\n` });
    }
    return outputs;
  }

  function loadNotebookFromJson(path: string, content: string): boolean {
    try {
      const parsed = JSON.parse(content) as {
        cells?: Array<{
          id?: string;
          cell_type?: string;
          source?: string | string[];
          metadata?: Record<string, unknown>;
        }>;
        metadata?: Record<string, unknown>;
        nbformat?: number;
      };
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cells)) {
        return false;
      }
      let anon = 0;
      const cells: NotebookCell[] = parsed.cells.map((c) => ({
        id: c.id ?? (c.metadata?.id as string | undefined) ?? `cell-${++anon}`,
        type: c.cell_type === 'markdown' ? 'markdown' : 'code',
        content: Array.isArray(c.source) ? c.source.join('') : c.source ?? '',
      }));
      notebooks.set(path, { cells, metadata: parsed.metadata ?? {}, mtime: Date.now() });
      return true;
    } catch {
      return false;
    }
  }

  function createSession(kernelName: string, filePath?: string, serverId?: string): MockKernelSession {
    const session: MockKernelSession = {
      id: `mock-session-${++sessionCounter}`,
      kernel_name: kernelName || 'python3',
      status: 'idle',
      file_path: filePath,
      execution_count: 0,
      created_at: Date.now(),
      server_id: serverId,
    };
    kernelSessions.set(session.id, session);
    return session;
  }

  // ---------------------------------------------------------------------------
  // Compute allocations (fabricated data mirroring node-server's mock-scheduler)
  // ---------------------------------------------------------------------------

  function computeLoad() {
    return {
      partitions: [
        {
          name: 'cpu', up: true, timeLimit: '1-00:00:00',
          cpus: { alloc: 276, idle: 236, other: 0, total: 512 },
          nodes: { idle: 7, mixed: 4, alloc: 3, down: 0, total: 16 },
          jobs: { pending: 5, running: 44 },
        },
        {
          name: 'gpu', up: true, timeLimit: '1-00:00:00',
          cpus: { alloc: 82, idle: 46, other: 0, total: 128 },
          gpus: [{ type: 'nvidia_l40s', total: 16, idle: 7 }],
          nodes: { idle: 1, mixed: 4, alloc: 3, down: 0, total: 4 },
          jobs: { pending: 3, running: 12 },
        },
        {
          name: 'gpu-a100', up: true, timeLimit: '1-00:00:00',
          cpus: { alloc: 74, idle: 22, other: 0, total: 96 },
          gpus: [{ type: 'nvidia_a100_80gb', total: 8, idle: 3 }],
          nodes: { idle: 1, mixed: 4, alloc: 3, down: 0, total: 3 },
          jobs: { pending: 6, running: 9 },
        },
        {
          name: 'bigmem', up: true, timeLimit: '2-00:00:00',
          cpus: { alloc: 88, idle: 104, other: 0, total: 192 },
          nodes: { idle: 3, mixed: 4, alloc: 3, down: 0, total: 6 },
          jobs: { pending: 1, running: 6 },
        },
        {
          name: 'armq', up: true, timeLimit: '7-00:00:00',
          cpus: { alloc: 0, idle: 576, other: 0, total: 576 },
          nodes: { idle: 8, mixed: 0, alloc: 0, down: 0, total: 8 },
          jobs: { pending: 0, running: 0 },
          archs: ['aarch64'],
        },
      ],
      qoses: [
        { name: 'normal', priority: 100, preemptible: false, preempts: [], jobs: { running: 58, pending: 40 } },
        { name: 'priority', priority: 1000, preemptible: false, preempts: ['opportunistic'], maxWall: '12:00:00', jobs: { running: 9, pending: 2 } },
        { name: 'opportunistic', priority: 1, preemptible: true, preempts: [], jobs: { running: 27, pending: 14 } },
      ],
      fetchedAt: Date.now(),
    };
  }

  /** Same defaulting rules as node-server routes/compute.ts parseSpec. */
  function parseComputeSpec(x: Record<string, unknown>): MockAllocation['spec'] {
    const partition = String(x?.partition ?? '').trim();
    const qos = x?.qos ? String(x.qos).trim() : undefined;
    const account = x?.account ? String(x.account).trim() : undefined;
    const cpus = Math.max(1, Math.floor(Number(x?.cpus) || 1));
    const memGb = Math.max(1, Math.floor(Number(x?.memGb) || 4));
    const gpusRaw = Math.floor(Number(x?.gpus) || 0);
    const gpus = gpusRaw > 0 ? gpusRaw : undefined;
    const gpuType = gpus && x?.gpuType ? String(x.gpuType).trim() || undefined : undefined;
    const walltimeMinutes = Math.max(1, Math.floor(Number(x?.walltimeMinutes) || 120));
    const idleRaw = Math.floor(Number(x?.idleTimeoutMinutes) || 0);
    const idleTimeoutMinutes = idleRaw > 0 ? idleRaw : undefined;
    const jobName = (x?.jobName ? String(x.jobName) : `nebula-${partition || 'compute'}`)
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 60) || 'nebula';
    return { partition, qos, account, cpus, memGb, gpus, gpuType, walltimeMinutes, jobName, idleTimeoutMinutes };
  }

  function createAllocation(spec: MockAllocation['spec']): MockAllocation {
    const id = `alloc-${(++allocCounter).toString(16).padStart(4, '0')}`;
    const alloc: MockAllocation = {
      id,
      jobId: String(nextJobId++),
      spec,
      state: 'pending',
      reason: 'Resources',
      createdAt: Date.now(),
    };
    allocations.set(id, alloc);
    // pending → active on a short timer, like the real allocation lifecycle
    // (job starts, client-server registers, allocation correlates).
    const timer = setTimeout(() => {
      allocationTimers.delete(timer);
      const current = allocations.get(id);
      if (!current || current.state !== 'pending') return;
      current.state = 'active';
      current.serverId = `compute-server-${id}`;
      current.nodes = [`node-${(allocCounter % 90) + 10}`];
      current.reason = undefined;
      current.walltimeEndsAt = Date.now() + spec.walltimeMinutes * 60_000;
    }, activationDelayMs);
    timer.unref?.();
    allocationTimers.add(timer);
    return alloc;
  }

  function clearAllocationTimers(): void {
    for (const timer of allocationTimers) clearTimeout(timer);
    allocationTimers.clear();
  }

  // ---------------------------------------------------------------------------
  // Operation router
  // ---------------------------------------------------------------------------

  function applyOperation(op: NotebookOperation): OperationResult {
    const path = op.notebookPath;

    if (op.type === 'createNotebook') {
      if (notebooks.has(path) && !op.overwrite) {
        return err(`Notebook already exists: ${path}`);
      }
      const nb: StoredNotebook = {
        cells: [],
        metadata: {
          kernelspec: {
            name: op.kernelName ?? 'python3',
            display_name: op.kernelDisplayName ?? 'Python 3',
          },
        },
        mtime: Date.now(),
      };
      notebooks.set(path, nb);
      return ok({ path, mtime: nb.mtime });
    }

    const nb = notebooks.get(path);
    if (!nb) {
      return err(`Notebook not found: ${path}`);
    }
    nb.mtime = Date.now();

    switch (op.type) {
      case 'insertCell': {
        const { id, modified } = uniqueId(nb, op.cell.id);
        const cell: NotebookCell = {
          id,
          type: op.cell.type,
          content: op.cell.content,
          metadata: op.cell.metadata,
        };
        let index = op.index;
        if (index < 0 || index > nb.cells.length) {
          index = nb.cells.length;
        }
        nb.cells.splice(index, 0, cell);
        {
          const session = agentSessions.get(path);
          if (session && op.agentId && op.agentId === session.agentId) {
            recordSessionHash(path, cell.id, cell.content);
          }
        }
        return ok({
          cellId: id,
          cellIndex: index,
          idModified: modified || undefined,
          requestedId: modified ? op.cell.id : undefined,
          metadata: { totalCells: nb.cells.length },
        });
      }

      case 'insertCells': {
        let position = op.position ?? -1;
        if (position < 0 || position > nb.cells.length) {
          position = nb.cells.length;
        }
        const insertedIds: string[] = [];
        let offset = 0;
        for (const c of op.cells) {
          const requested = c.id ?? `cell-${Date.now()}-${offset}`;
          const { id } = uniqueId(nb, requested);
          nb.cells.splice(position + offset, 0, {
            id,
            type: c.type ?? 'code',
            content: c.content,
          });
          insertedIds.push(id);
          offset += 1;
        }
        return ok({
          insertedCount: insertedIds.length,
          insertedIds,
          startIndex: position,
          totalCells: nb.cells.length,
        });
      }

      case 'deleteCell': {
        const resolved = resolveCellIndex(nb, { cellId: op.cellId, cellIndex: op.cellIndex });
        if ('error' in resolved) return err(resolved.error);
        if (op.cellId) {
          const conflictResult = occCheck(path, op, nb.cells[resolved.index]);
          if (conflictResult) return conflictResult;
        }
        const [removed] = nb.cells.splice(resolved.index, 1);
        agentSessions.get(path)?.cellHashes.delete(removed.id);
        return ok({
          cellId: removed.id,
          cellIndex: resolved.index,
          metadata: { totalCells: nb.cells.length },
        });
      }

      case 'deleteCells': {
        const deletedIds: string[] = [];
        const notFound: string[] = [];
        for (const cellId of op.cellIds) {
          const index = nb.cells.findIndex((c) => c.id === cellId);
          if (index === -1) {
            notFound.push(cellId);
          } else {
            nb.cells.splice(index, 1);
            deletedIds.push(cellId);
          }
        }
        return ok({
          deletedCount: deletedIds.length,
          deletedIds,
          notFound: notFound.length > 0 ? notFound : undefined,
          totalCells: nb.cells.length,
        });
      }

      case 'updateContent': {
        const cell = nb.cells.find((c) => c.id === op.cellId);
        if (!cell) return err(`Cell not found: ${op.cellId}`);
        const conflictResult = occCheck(path, op, cell);
        if (conflictResult) return conflictResult;
        cell.content = op.content;
        const session = agentSessions.get(path);
        if (session && op.agentId && op.agentId === session.agentId) {
          recordSessionHash(path, cell.id, cell.content);
        }
        return ok({ cellId: cell.id, cellIndex: nb.cells.indexOf(cell) });
      }

      case 'updateMetadata': {
        const cell = nb.cells.find((c) => c.id === op.cellId);
        if (!cell) return err(`Cell not found: ${op.cellId}`);
        for (const [key, value] of Object.entries(op.changes)) {
          if (key === 'type') {
            if (value !== 'code' && value !== 'markdown') {
              return err(`Invalid cell type: ${String(value)}`);
            }
            cell.type = value;
          } else if (key === 'id') {
            const requested = String(value);
            if (nb.cells.some((c) => c.id === requested && c !== cell)) {
              return err(`Cell ID already exists: ${requested}`);
            }
            cell.id = requested;
          } else {
            cell.metadata = { ...(cell.metadata ?? {}), [key]: value };
          }
        }
        return ok({ cellId: cell.id, cellIndex: nb.cells.indexOf(cell) });
      }

      case 'moveCell': {
        let from: number;
        if (op.cellId) {
          const index = nb.cells.findIndex((c) => c.id === op.cellId);
          if (index === -1) return err(`Cell not found: ${op.cellId}`);
          from = index;
        } else {
          if (op.fromIndex === undefined || op.fromIndex < 0 || op.fromIndex >= nb.cells.length) {
            return err(`Cell index ${op.fromIndex ?? -1} out of range (notebook has ${nb.cells.length} cells)`);
          }
          from = op.fromIndex;
        }
        const [moved] = nb.cells.splice(from, 1);
        let to: number;
        if (op.afterCellId) {
          const afterIndex = nb.cells.findIndex((c) => c.id === op.afterCellId);
          if (afterIndex === -1) {
            nb.cells.splice(from, 0, moved); // restore
            return err(`Cell not found: ${op.afterCellId}`);
          }
          to = afterIndex + 1;
        } else {
          to = op.toIndex ?? 0;
          if (to < 0) to = 0;
          if (to > nb.cells.length) to = nb.cells.length;
        }
        nb.cells.splice(to, 0, moved);
        return ok({ cellId: moved.id, fromIndex: from, toIndex: to });
      }

      case 'duplicateCell': {
        if (op.cellIndex < 0 || op.cellIndex >= nb.cells.length) {
          return err(`Cell index ${op.cellIndex} out of range (notebook has ${nb.cells.length} cells)`);
        }
        const original = nb.cells[op.cellIndex];
        const { id } = uniqueId(nb, op.newCellId);
        const copy: NotebookCell = {
          ...original,
          id,
          outputs: original.outputs ? [...original.outputs] : undefined,
        };
        nb.cells.splice(op.cellIndex + 1, 0, copy);
        return ok({
          cellId: id,
          cellIndex: op.cellIndex + 1,
          metadata: { totalCells: nb.cells.length },
        });
      }

      case 'updateOutputs': {
        const cell = nb.cells.find((c) => c.id === op.cellId);
        if (!cell) return err(`Cell not found: ${op.cellId}`);
        cell.outputs = [...op.outputs];
        if (op.executionCount !== undefined) {
          cell.executionCount = op.executionCount;
        }
        return ok({ cellId: cell.id, cellIndex: nb.cells.indexOf(cell) });
      }

      case 'readCell': {
        const resolved = resolveCellIndex(nb, { cellId: op.cellId, cellIndex: op.cellIndex });
        if ('error' in resolved) return err(resolved.error);
        const cell = nb.cells[resolved.index];
        recordSessionHash(path, cell.id, cell.content);
        return ok({ cell, cellIndex: resolved.index });
      }

      case 'readCellOutput': {
        const resolved = resolveCellIndex(nb, { cellId: op.cellId, cellIndex: op.cellIndex });
        if ('error' in resolved) return err(resolved.error);
        const cell = nb.cells[resolved.index];
        return ok({
          cellId: cell.id,
          cellIndex: resolved.index,
          outputs: cell.outputs ? [...cell.outputs] : [],
          executionCount: cell.executionCount,
          executionStatus: 'idle',
        });
      }

      case 'clearNotebook': {
        const deletedCount = nb.cells.length;
        nb.cells = [];
        return ok({ deletedCount, metadata: { totalCells: 0 } });
      }

      case 'clearOutputs': {
        const targets =
          op.cellIds && op.cellIds.length > 0
            ? op.cellIds
            : op.cellId
              ? [op.cellId]
              : nb.cells.filter((c) => c.type === 'code').map((c) => c.id);
        const clearedIds: string[] = [];
        const notFound: string[] = [];
        for (const cellId of targets) {
          const cell = nb.cells.find((c) => c.id === cellId);
          if (!cell) {
            notFound.push(cellId);
            continue;
          }
          cell.outputs = [];
          clearedIds.push(cellId);
        }
        return ok({
          clearedCount: clearedIds.length,
          clearedIds,
          notFound: notFound.length > 0 ? notFound : undefined,
        });
      }

      case 'searchCells': {
        const query = op.query.toLowerCase();
        const limit = op.limit ?? 10;
        const matches: NonNullable<OperationResult['matches']> = [];
        let matchCount = 0;
        nb.cells.forEach((cell, cellIndex) => {
          const lines = cell.content.split('\n');
          lines.forEach((line, lineIndex) => {
            if (line.toLowerCase().includes(query)) {
              matchCount += 1;
              if (matches.length < limit) {
                matches.push({
                  cellId: cell.id,
                  cellIndex,
                  matchLocation: 'source',
                  matchLine: lineIndex,
                  preview: line.trim().slice(0, 100),
                });
              }
            }
          });
          if (op.includeOutputs && cell.outputs) {
            cell.outputs.forEach((output, outputIndex) => {
              if (output.content.toLowerCase().includes(query)) {
                matchCount += 1;
                if (matches.length < limit) {
                  matches.push({
                    cellId: cell.id,
                    cellIndex,
                    matchLocation: 'output',
                    outputIndex,
                    outputType: output.type,
                    preview: output.content.trim().slice(0, 100),
                  });
                }
              }
            });
          }
        });
        return ok({
          query: op.query,
          matchCount,
          matches,
          hasMore: matchCount > matches.length,
        });
      }

      case 'executeCell': {
        const resolved = resolveCellIndex(nb, { cellId: op.cellId, cellIndex: op.cellIndex });
        if ('error' in resolved) return err(resolved.error);
        const cell = nb.cells[resolved.index];
        const outputs = fakeExecute(cell.content);
        const executionCount = ++executionCounter;
        if (op.saveOutputs !== false) {
          cell.outputs = [...outputs];
          cell.executionCount = executionCount;
        }
        return ok({
          cellId: cell.id,
          cellIndex: resolved.index,
          executionStatus: 'idle',
          executionCount,
          outputs,
          executionTime: 1,
          sessionId: op.sessionId,
        });
      }

      case 'startAgentSession': {
        agentSessions.set(path, {
          agentId: op.agentId,
          startedAt: Date.now(),
          exclusive: op.exclusive,
          cellHashes: new Map(),
        });
        return ok({});
      }

      case 'endAgentSession': {
        const session = agentSessions.get(path);
        agentSessions.delete(path);
        return ok({ sessionDuration: session ? Date.now() - session.startedAt : 0 });
      }

      case 'getUpdatesSince': {
        return ok({ updatesSince: [], serverTimestamp: Date.now() });
      }

      case 'startKernel': {
        const session = createSession(op.kernelName ?? 'python3', path);
        return ok({ sessionId: session.id, kernelName: session.kernel_name });
      }

      case 'shutdownKernel':
      case 'restartKernel':
      case 'interruptKernel': {
        return ok({});
      }

      default: {
        const type = (op as { type: string }).type;
        return err(`Unsupported operation: ${type}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP server
  // ---------------------------------------------------------------------------

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const { pathname } = url;
      const method = req.method ?? 'GET';

      // --- Operation router ---
      if (method === 'POST' && pathname === '/api/notebook/operation') {
        const body = await readBody(req);
        let operation: NotebookOperation;
        try {
          operation = (JSON.parse(body) as { operation: NotebookOperation }).operation;
        } catch {
          sendJson(res, 400, { success: false, error: 'Invalid JSON body' });
          return;
        }
        sendJson(res, 200, applyOperation(operation));
        return;
      }

      if (method === 'GET' && pathname === '/api/notebook/read') {
        const path = url.searchParams.get('path') ?? '';
        const includeOutputs = url.searchParams.get('include_outputs') === 'true';
        const nb = notebooks.get(path);
        if (!nb) {
          sendJson(res, 200, { success: false, error: `Notebook not found: ${path}` });
          return;
        }
        // Full-notebook reads arm OCC for the active agent session,
        // mirroring the real router's recordNotebookReadHashes.
        for (const c of nb.cells) {
          recordSessionHash(path, c.id, c.content);
        }
        const cells = nb.cells.map((c) => (includeOutputs ? c : { ...c, outputs: undefined }));
        sendJson(res, 200, {
          success: true,
          backend: 'headless',
          data: { path, cells, metadata: nb.metadata },
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/notebook/has-ui') {
        sendJson(res, 200, { hasUI: false });
        return;
      }

      // --- Kernels ---
      if (method === 'GET' && pathname === '/api/kernels') {
        sendJson(res, 200, {
          kernels: [{ name: 'python3', display_name: 'Python 3 (mock)', language: 'python' }],
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/kernels/sessions') {
        sendJson(res, 200, { sessions: Array.from(kernelSessions.values()) });
        return;
      }

      if (method === 'POST' && pathname === '/api/kernels/start') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          kernel_name?: string;
          file_path?: string;
        };
        const session = createSession(body.kernel_name ?? 'python3', body.file_path);
        sendJson(res, 200, { session_id: session.id, kernel_name: session.kernel_name });
        return;
      }

      if (method === 'POST' && pathname === '/api/kernels/for-file') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          file_path?: string;
          kernel_name?: string;
          server_id?: string;
        };
        // Mirror the real route: explicit server_id wins and is saved as the
        // notebook's kernel preference; otherwise the saved preference applies.
        const effectiveServerId =
          body.server_id ?? (body.file_path ? kernelServerPreference.get(body.file_path) : undefined);
        if (body.server_id && body.file_path) {
          kernelServerPreference.set(body.file_path, body.server_id);
        }
        const existing = Array.from(kernelSessions.values()).find(
          (s) => s.file_path === body.file_path && s.server_id === effectiveServerId
        );
        const session =
          existing ?? createSession(body.kernel_name ?? 'python3', body.file_path, effectiveServerId);
        sendJson(res, 200, {
          session_id: session.id,
          kernel_name: session.kernel_name,
          file_path: session.file_path,
          server_id: session.server_id ?? 'mock-local',
        });
        return;
      }

      // --- Compute allocations (fake scheduler) ---
      if (method === 'GET' && pathname === '/api/compute/status') {
        sendJson(res, 200, { enabled: computeEnabled, scheduler: computeEnabled ? 'mock' : null });
        return;
      }

      if (method === 'GET' && pathname === '/api/compute/partitions') {
        if (!computeEnabled) {
          sendJson(res, 200, { enabled: false, associations: null, load: null });
          return;
        }
        sendJson(res, 200, {
          enabled: true,
          associations: {
            account: 'demo-lab',
            partitions: ['cpu', 'gpu', 'gpu-a100', 'bigmem', 'armq'],
            qoses: ['normal', 'priority', 'opportunistic'],
            defaultQos: 'normal',
          },
          load: computeLoad(),
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/compute/partition-qos') {
        if (!computeEnabled) {
          sendJson(res, 200, { allowed: null });
          return;
        }
        const partition = url.searchParams.get('partition') ?? '';
        sendJson(res, 200, { allowed: partition === 'gpu-a100' ? ['priority', 'opportunistic'] : null });
        return;
      }

      if (method === 'GET' && pathname === '/api/compute/estimate') {
        if (!computeEnabled) {
          sendJson(res, 400, { error: 'scheduler not available' });
          return;
        }
        sendJson(res, 200, {});
        return;
      }

      if (method === 'GET' && pathname === '/api/compute/allocations') {
        sendJson(res, 200, {
          allocations: [...allocations.values()].sort((a, b) => b.createdAt - a.createdAt),
        });
        return;
      }

      if (method === 'POST' && pathname === '/api/compute/allocations') {
        const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
        if (!computeEnabled) {
          sendJson(res, 400, { error: 'scheduler not available' });
          return;
        }
        const spec = parseComputeSpec(body);
        if (!spec.partition) {
          sendJson(res, 400, { error: 'partition is required' });
          return;
        }
        sendJson(res, 200, createAllocation(spec));
        return;
      }

      const allocMatch = pathname.match(/^\/api\/compute\/allocations\/([^/]+)$/);
      if (method === 'DELETE' && allocMatch) {
        const alloc = allocations.get(allocMatch[1]);
        if (!alloc) {
          sendJson(res, 404, { error: 'allocation not found' });
          return;
        }
        alloc.state = 'cancelled';
        alloc.serverId = undefined;
        sendJson(res, 200, { cancelled: true });
        return;
      }

      const sessionAction = pathname.match(/^\/api\/kernels\/([^/]+)\/(restart|interrupt|execute)$/);
      if (method === 'POST' && sessionAction) {
        const session = kernelSessions.get(sessionAction[1]);
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Session not found');
          return;
        }
        await readBody(req);
        if (sessionAction[2] === 'execute') {
          sendJson(res, 200, { outputs: [], success: true });
        } else {
          sendJson(res, 200, {});
        }
        return;
      }

      const sessionMatch = pathname.match(/^\/api\/kernels\/([^/]+)$/);
      if (method === 'DELETE' && sessionMatch) {
        if (!kernelSessions.delete(sessionMatch[1])) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Session not found');
          return;
        }
        sendJson(res, 200, {});
        return;
      }

      // --- File system ---
      if (method === 'POST' && pathname === '/api/fs/write') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          path?: string;
          content?: string;
        };
        const path = body.path ?? '';
        const content = body.content ?? '';
        if (!loadNotebookFromJson(path, content)) {
          textFiles.set(path, content);
        }
        sendJson(res, 200, {});
        return;
      }

      if (method === 'GET' && pathname === '/api/fs/read') {
        const path = url.searchParams.get('path') ?? '';
        if (textFiles.has(path)) {
          sendJson(res, 200, { content: textFiles.get(path), file_type: 'text' });
          return;
        }
        const nb = notebooks.get(path);
        if (nb) {
          sendJson(res, 200, { content: nb, file_type: 'notebook' });
          return;
        }
        sendJson(res, 404, { error: `File not found: ${path}` });
        return;
      }

      if (method === 'DELETE' && pathname === '/api/fs/delete') {
        const path = url.searchParams.get('path') ?? '';
        notebooks.delete(path);
        textFiles.delete(path);
        sendJson(res, 200, {});
        return;
      }

      if (method === 'GET' && pathname === '/api/fs/list') {
        sendJson(res, 200, { path: url.searchParams.get('path') ?? '.', parent: null, mtime: Date.now(), items: [] });
        return;
      }

      if (method === 'POST' && pathname === '/api/fs/rename') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          old_path?: string;
          new_path?: string;
        };
        if (body.old_path && body.new_path) {
          const nb = notebooks.get(body.old_path);
          if (nb) {
            notebooks.delete(body.old_path);
            notebooks.set(body.new_path, nb);
          }
          const text = textFiles.get(body.old_path);
          if (text !== undefined) {
            textFiles.delete(body.old_path);
            textFiles.set(body.new_path, text);
          }
        }
        sendJson(res, 200, {});
        return;
      }

      sendJson(res, 404, { error: `Unknown endpoint: ${method} ${pathname}` });
    })().catch((e: unknown) => {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      clearAllocationTimers();
      return new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    },
    reset: () => {
      notebooks.clear();
      textFiles.clear();
      kernelSessions.clear();
      agentSessions.clear();
      clearAllocationTimers();
      allocations.clear();
      kernelServerPreference.clear();
      computeEnabled = true;
      activationDelayMs = 150;
    },
    setComputeEnabled: (enabled: boolean) => {
      computeEnabled = enabled;
    },
    setComputeActivationDelay: (ms: number) => {
      activationDelayMs = ms;
    },
    getAllocation: (id: string) => allocations.get(id),
  };
}
