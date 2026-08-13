/**
 * Kernel Service
 *
 * Manages Jupyter kernel sessions - spawning, execution, and lifecycle.
 * Uses ZeroMQ for kernel communication following the Jupyter messaging protocol.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as net from 'net';
import { v4 as uuidv4 } from 'uuid';
import { spawn, exec, ChildProcess } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import {
  KernelSession,
  KernelOutput,
  ExecutionResult,
  ExecutionQueueInfo,
  InternalExecutionOptions,
  StartKernelOptions,
  SessionInfo,
  KernelServiceConfig,
  PersistedSession,
  ConnectionConfig,
  DEFAULT_CONFIG,
} from './types';
import { buildDisplayOutput } from '../output/display-data';
import {
  MAX_OUTPUT_LINES,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_LINES_ERROR,
  MAX_OUTPUT_CHARS_ERROR,
} from '../config/output-limits';
import { SessionStore } from './session-store';
import { privateTmpDir } from '../private-tmp';
import {
  discoverKernelSpecs,
  getKernelSpec,
  envKernelPythonPath,
  makeEnvKernelSpec,
  KernelSpec,
} from './kernelspec';
import { pythonDiscovery } from '../discovery/discovery-service';
import { KernelProvisionError } from '../discovery/types';

// ZeroMQ types - imported dynamically to handle missing native bindings
type ZmqSocket = {
  connect: (endpoint: string) => void;
  close: () => void;
  send: (data: Buffer | Buffer[]) => Promise<void>;
  receive: () => Promise<Buffer[]>;
  subscribe: (topic: string) => void;
};

type ZmqModule = {
  Dealer: new () => ZmqSocket;
  Subscriber: new () => ZmqSocket;
};

/** A parsed iopub message routed through the unified per-session reader. */
interface ParsedIopubMessage {
  msgType: string;
  content: Record<string, unknown>;
  parentMsgId: string;
  buffers: Buffer[];
}

/** Shell replies share the same parsed wire shape as iopub messages. */
type ParsedShellMessage = ParsedIopubMessage;

/** Kernel-originated comm event surfaced to onComm listeners. */
export interface CommEvent {
  msgType: 'comm_open' | 'comm_msg' | 'comm_close';
  commId: string;
  targetName?: string;
  data: Record<string, unknown>;
  /** Binary buffer frames, base64-encoded. Present only when non-empty. */
  buffers?: string[];
}

/** Resolved by BoundedAsyncQueue.next() when the queue has been closed. */
export const IOPUB_QUEUE_CLOSED: unique symbol = Symbol('iopub-queue-closed');
/** Resolved by BoundedAsyncQueue.next(timeoutMs) when the wait timed out. */
export const IOPUB_QUEUE_TIMEOUT: unique symbol = Symbol('iopub-queue-timeout');

// Back-pressure bounds for the unified iopub reader. Parent-keyed queues carry
// full execution output streams, so they get a generous bound; drop-oldest
// keeps the terminal `status: idle` reachable so executions can't hang.
const MAX_PARENT_QUEUE_MESSAGES = 5000;
const MAX_CATCHALL_QUEUE_MESSAGES = 500;
// Light v1 comm-state store bound (late-joiner replay of open widget comms).
const MAX_TRACKED_COMMS_PER_SESSION = 512;

/**
 * Bounded producer/consumer queue used to fan iopub messages out from the
 * single reader loop. Never blocks the producer: when full, the oldest item
 * is dropped (newest wins, so terminal status messages still arrive).
 */
class BoundedAsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(value: T | typeof IOPUB_QUEUE_CLOSED) => void> = [];
  private closed = false;
  private dropped = 0;

  constructor(private readonly maxSize: number) {}

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    if (this.items.length >= this.maxSize) {
      this.items.shift();
      this.dropped++;
      if (this.dropped === 1 || this.dropped % 1000 === 0) {
        console.warn(`[Kernel] iopub queue overflow: dropped ${this.dropped} message(s)`);
      }
    }
    this.items.push(item);
  }

  /**
   * Take the next item. Resolves IOPUB_QUEUE_CLOSED once the queue is closed
   * and drained. With timeoutMs, resolves IOPUB_QUEUE_TIMEOUT if nothing
   * arrives in time — the waiter is deregistered on timeout so no message can
   * be lost to an abandoned waiter.
   */
  next(timeoutMs?: number): Promise<T | typeof IOPUB_QUEUE_CLOSED | typeof IOPUB_QUEUE_TIMEOUT> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift()!);
    }
    if (this.closed) {
      return Promise.resolve(IOPUB_QUEUE_CLOSED);
    }
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const waiter = (value: T | typeof IOPUB_QUEUE_CLOSED) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      this.waiters.push(waiter);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) {
            this.waiters.splice(idx, 1);
            resolve(IOPUB_QUEUE_TIMEOUT);
          }
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.items = [];
    for (const waiter of this.waiters.splice(0)) {
      waiter(IOPUB_QUEUE_CLOSED);
    }
  }
}

/**
 * Polyfill IPython-style `!command` lines for kernels whose language lacks
 * them, by rewriting each such line into the language's own shell-call idiom
 * before the code reaches the kernel. Because the rewritten code still runs
 * in the kernel process, cwd, environment (conda env, loaded modules), and
 * machine (allocation node) are all the kernel's — the same guarantees
 * IPython's native `!` gives Python users.
 *
 * Python kernels are deliberately untouched: IPython's `!` is richer than a
 * plain shell call (output capture `x = !ls`, `{var}` interpolation,
 * streaming output) and a rewrite would break it.
 *
 * Only whole lines that start with `!` are rewritten. Known limits (v1):
 * a line inside a multi-line string that happens to start with `!` would be
 * rewritten too, and R's intern=TRUE buffers output until the command exits.
 */
export function rewriteShellLines(code: string, language: string | undefined): string {
  const lang = (language || '').toLowerCase();
  if (lang !== 'r') return code; // python: native support; others: no safe idiom mapped yet
  if (!/^[ \t]*!/m.test(code)) return code;
  return code
    .split('\n')
    .map((line) => {
      const m = line.match(/^([ \t]*)!(.+)$/);
      if (!m) return line;
      // Merge stderr at the shell level — intern=TRUE captures only stdout.
      const cmd = `${m[2].trim()} 2>&1`;
      const rString = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${m[1]}cat(system("${rString}", intern = TRUE), sep = "\\n")`;
    })
    .join('\n');
}

export class KernelService {
  private sessions: Map<string, KernelSession> = new Map();
  private fileToSession: Map<string, string> = new Map();
  private kernelProcesses: Map<string, ChildProcess> = new Map();
  private processLifecycleHandlers: WeakMap<ChildProcess, {
    onError: (err: Error) => void;
    onExit: (code: number | null) => void;
  }> = new WeakMap();
  private zmqSockets: Map<string, { shell: ZmqSocket; iopub: ZmqSocket }> = new Map();
  private sessionStore: SessionStore;
  private config: Required<KernelServiceConfig>;
  private kernelSpecsCache: KernelSpec[] | null = null;
  private ready: boolean = false;
  private zmq: ZmqModule | null = null;
  private executionQueues: Map<string, Promise<unknown>> = new Map();
  private executionQueueSizes: Map<string, number> = new Map();
  private shellRequestQueues: Map<string, Promise<unknown>> = new Map();
  private reattachInProgress = false;
  private serverId: string;
  private serverInstanceId: string;
  private legacyCleanupWarned: Set<string> = new Set();
  // Cell-indexed output buffer: sessionId -> cellId -> outputs
  private cellOutputBuffers: Map<string, Map<string, KernelOutput[]>> = new Map();
  // Per-cell truncation tracking: sessionId -> cellId -> tracking state
  private cellOutputTracking: Map<string, Map<string, { lines: number; chars: number; truncated: boolean }>> = new Map();
  private executingCellIds: Map<string, string | null> = new Map();
  // ---- Unified iopub reader state ----
  // One long-lived reader loop per session owns ALL iopub .receive() calls.
  // Consumers (execute loop, busy monitor) subscribe to bounded queues.
  private iopubReaders: Map<string, { stopped: boolean }> = new Map();
  // sessionId -> parent msg_id -> queue (execute-parented message routing)
  private iopubParentSubscribers: Map<string, Map<string, BoundedAsyncQueue<ParsedIopubMessage>>> = new Map();
  // sessionId -> catch-all queues (busy monitor and other any-parent consumers)
  private iopubCatchAllSubscribers: Map<string, Set<BoundedAsyncQueue<ParsedIopubMessage>>> = new Map();
  // Comm-state store for late joiners: sessionId -> comm_id -> open info
  private commStates: Map<string, Map<string, { targetName: string; openData: Record<string, unknown> }>> = new Map();
  // ---- Unified shell reply reader state ----
  // One long-lived reader loop per session owns ALL shell .receive() calls.
  // Replies are dispatched by parent msg_id to one-shot waiters; a reply with
  // no registered waiter (e.g. execute_reply — executions are iopub-driven —
  // or a reply whose waiter already timed out) is dropped. This means a
  // timed-out request can never hold the socket or eat a later reply.
  private shellReaders: Map<string, { stopped: boolean }> = new Map();
  // sessionId -> request msg_id -> one-shot resolver
  private shellReplyWaiters: Map<string, Map<string, (msg: ParsedShellMessage | 'closed') => void>> = new Map();

  constructor(config?: KernelServiceConfig, sessionStore?: SessionStore) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionStore = sessionStore || new SessionStore();
    this.serverId = process.env.NEBULA_SERVER_ID || 'local';
    this.serverInstanceId = process.env.NEBULA_SERVER_INSTANCE_ID || uuidv4();
    this.startLivenessSweep();
  }

  // ---- Kernel death notification --------------------------------------
  // Process exit/error handlers (and the liveness sweep below) notify
  // listeners so the route layer can broadcast status to WebSocket clients.
  // Without this, a crashed kernel leaves every client showing 'busy'.
  private deadListeners: Array<(sessionId: string) => void> = [];

  onSessionDead(cb: (sessionId: string) => void): void {
    this.deadListeners.push(cb);
  }

  private notifySessionDead(sessionId: string): void {
    for (const cb of this.deadListeners) {
      try {
        cb(sessionId);
      } catch (err) {
        console.error('[Kernel] onSessionDead listener failed:', err);
      }
    }
  }

  // ---- Comm message notification (ipywidgets et al.) -------------------
  // The unified iopub reader demuxes comm_open/comm_msg/comm_close messages
  // (regardless of parent — including idle-time traffic from widget
  // observers) to these listeners so the route layer can broadcast them.
  private commListeners: Array<(sessionId: string, comm: CommEvent) => void> = [];

  onComm(cb: (sessionId: string, comm: CommEvent) => void): void {
    this.commListeners.push(cb);
  }

  private notifyComm(sessionId: string, comm: CommEvent): void {
    for (const cb of this.commListeners) {
      try {
        cb(sessionId, comm);
      } catch (err) {
        console.error('[Kernel] onComm listener failed:', err);
      }
    }
  }

  // ---- Liveness sweep ---------------------------------------------------
  // ChildProcess handles get 'exit' events, but REATTACHED sessions only
  // have a PID — nothing fires when that process dies. Sweep PIDs so a dead
  // reattached kernel is noticed within ~15s instead of at the next execute.
  private livenessTimer: NodeJS.Timeout | null = null;

  private startLivenessSweep(): void {
    this.livenessTimer = setInterval(() => this.sweepLiveness(), 15000);
    // Never keep the process alive just for the sweep
    this.livenessTimer.unref?.();
  }

  /** One liveness pass (exposed for tests; normally driven by the timer). */
  sweepLiveness(): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.status === 'dead') continue;
      // Sessions with a live ChildProcess handle are covered by 'exit'
      if (this.kernelProcesses.has(sessionId)) continue;
      if (!session.pid) continue;
      try {
        process.kill(session.pid, 0);
      } catch {
        console.log(`[Kernel] Liveness sweep: reattached kernel ${sessionId} (pid ${session.pid}) is gone`);
        session.status = 'dead';
        this.cleanupKernelResources(sessionId);
        this.notifySessionDead(sessionId);
      }
    }
  }

  setServerIdentity(serverId: string, serverInstanceId?: string): void {
    this.serverId = serverId;
    if (serverInstanceId) {
      this.serverInstanceId = serverInstanceId;
    }
  }

  /**
   * Check if a PID is still alive.
   */
  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private attachProcessLifecycle(sessionId: string, proc: ChildProcess, session: KernelSession): void {
    const onError = (err: Error) => {
      if (this.kernelProcesses.get(sessionId) !== proc) {
        return;
      }
      console.error(`Kernel ${sessionId} error:`, err);
      session.status = 'dead';
      this.notifySessionDead(sessionId);
    };

    const onExit = (code: number | null) => {
      if (this.kernelProcesses.get(sessionId) !== proc) {
        return;
      }
      console.log(`Kernel ${sessionId} exited with code ${code}`);
      session.status = 'dead';
      this.cleanupKernelResources(sessionId);
      this.notifySessionDead(sessionId);
    };

    this.processLifecycleHandlers.set(proc, { onError, onExit });
    proc.on('error', onError);
    proc.on('exit', onExit);
  }

  private detachProcessLifecycle(proc: ChildProcess | null | undefined): void {
    if (!proc) {
      return;
    }

    const handlers = this.processLifecycleHandlers.get(proc);
    if (!handlers) {
      return;
    }

    proc.off('error', handlers.onError);
    proc.off('exit', handlers.onExit);
    this.processLifecycleHandlers.delete(proc);
  }

  /**
   * Load a Jupyter connection file.
   */
  private loadConnectionFile(connFile: string): ConnectionConfig | null {
    try {
      if (!connFile || !fs.existsSync(connFile)) {
        return null;
      }
      const raw = JSON.parse(fs.readFileSync(connFile, 'utf-8')) as Record<string, unknown>;
      return {
        ip: raw.ip as string,
        transport: raw.transport as string,
        signatureScheme: raw.signature_scheme as string,
        key: raw.key as string,
        shellPort: raw.shell_port as number,
        stdinPort: raw.stdin_port as number,
        controlPort: raw.control_port as number,
        iopubPort: raw.iopub_port as number,
        hbPort: raw.hb_port as number,
      };
    } catch {
      return null;
    }
  }

  /**
   * Initialize the service (lazy load ZeroMQ and discover kernels)
   */
  async initialize(): Promise<void> {
    if (this.ready) return;

    // Try to load ZeroMQ
    try {
      this.zmq = await import('zeromq') as unknown as ZmqModule;
    } catch (err) {
      console.warn('ZeroMQ not available, kernel execution will be limited:', err);
    }

    // Discover kernels in background
    this.kernelSpecsCache = discoverKernelSpecs();
    this.ready = true;
    console.log(`Kernel service initialized. Found ${this.kernelSpecsCache.length} kernels.`);
  }

  /**
   * Attempt to reattach to orphaned kernel sessions from a previous server run.
   */
  async reattachOrphanedSessions(): Promise<{ attempted: number; reattached: number; failed: number; skipped: number }> {
    if (this.reattachInProgress) {
      return { attempted: 0, reattached: 0, failed: 0, skipped: 0 };
    }
    this.reattachInProgress = true;
    try {
      await this.initialize();

      // Mark any previously active sessions (for this server) as orphaned
      this.sessionStore.markAllOrphaned(this.serverId, this.serverInstanceId);
      const orphanedSessions = this.sessionStore.getOrphanedSessions(this.serverId);

      if (orphanedSessions.length === 0) {
        return { attempted: 0, reattached: 0, failed: 0, skipped: 0 };
      }

      let reattached = 0;
      let failed = 0;
      let skipped = 0;

      for (const session of orphanedSessions) {
        const sessionId = session.sessionId;

        // Check if kernel process is still alive and matches recorded start time (if available)
        if (session.kernelPid) {
          if (!this.isPidAlive(session.kernelPid)) {
            this.sessionStore.updateStatus(sessionId, 'terminated');
            skipped++;
            continue;
          }
          if (session.kernelStartTime) {
            const currentStartTime = await this.getProcessStartTime(session.kernelPid);
            if (!currentStartTime || currentStartTime !== session.kernelStartTime) {
              this.sessionStore.updateStatus(sessionId, 'terminated');
              skipped++;
              continue;
            }
          }
        }

        // Try to get connection config: from file first, then from DB
        let connectionConfig: ConnectionConfig | null = null;
        if (session.connectionFile) {
          connectionConfig = this.loadConnectionFile(session.connectionFile);
        }
        // Fall back to DB-stored config if file is missing (e.g., temp cleanup)
        if (!connectionConfig && session.connectionConfig) {
          try {
            connectionConfig = JSON.parse(session.connectionConfig);
          } catch {
            // Invalid JSON in DB
          }
        }
        if (!connectionConfig) {
          console.log(`[Kernel] Skipping session ${sessionId}: no connection config available`);
          this.sessionStore.updateStatus(sessionId, 'terminated');
          skipped++;
          continue;
        }

        const normalizedFilePath = session.filePath ? this.normalizePath(session.filePath) : null;
        const now = Date.now() / 1000;
        const kernelSession: KernelSession = {
          id: sessionId,
          kernelName: session.kernelName,
          filePath: normalizedFilePath,
          status: 'starting',
          executionCount: 0,
          pid: session.kernelPid ?? null,
          connectionFile: session.connectionFile,
          connectionConfig,
          createdAt: session.createdAt,
          lastActivity: now,
        };

        this.sessions.set(sessionId, kernelSession);
        if (normalizedFilePath) {
          this.fileToSession.set(normalizedFilePath, sessionId);
        }

        try {
          // Use shorter timeout for reattach — kernel should already be running.
          // Pass PID so waitForReady can distinguish "busy" from "dead" on timeout.
          const detectedStatus = await this.waitForReady(sessionId, 10, session.kernelPid);
          kernelSession.status = detectedStatus;

          if (detectedStatus === 'busy') {
            // Kernel is alive but mid-execution. Monitor iopub in background
            // so we can flip to 'idle' when the execution finishes.
            this.monitorBusyKernel(sessionId);
          }

          const kernelStartTime = session.kernelStartTime
            ?? (session.kernelPid ? await this.getProcessStartTime(session.kernelPid) : null);
          this.sessionStore.saveSession({
            sessionId,
            kernelName: session.kernelName,
            filePath: normalizedFilePath,
            kernelPid: session.kernelPid ?? null,
            serverId: this.serverId,
            serverInstanceId: this.serverInstanceId,
            kernelStartTime,
            status: 'active',
            createdAt: session.createdAt,
            lastHeartbeat: now,
            connectionFile: session.connectionFile,
            connectionConfig: JSON.stringify(connectionConfig),
          });
          reattached++;
          console.log(`[Kernel] Reattached session ${sessionId} for ${normalizedFilePath || 'no file'}`);
        } catch (err) {
          failed++;
          kernelSession.status = 'dead';
          this.cleanupInMemorySession(sessionId);
          this.sessionStore.updateStatus(sessionId, 'terminated');
          console.log(`[Kernel] Failed to reattach session ${sessionId}: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Rows just marked terminated (process gone) are pure bookkeeping —
      // remove them now so they never surface as "orphaned" in the UI.
      await this.autoCleanupDeadSessions().catch((err) =>
        console.warn('[Kernel] Auto-cleanup after reattach failed:', err)
      );

      return {
        attempted: orphanedSessions.length,
        reattached,
        failed,
        skipped,
      };
    } finally {
      this.reattachInProgress = false;
    }
  }

  /**
   * Check if service is ready
   */
  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Get available kernelspecs
   */
  getAvailableKernels(): KernelSpec[] {
    if (this.kernelSpecsCache) {
      return this.kernelSpecsCache;
    }
    return discoverKernelSpecs();
  }

  /**
   * Re-run kernelspec discovery and refresh the in-memory cache.
   *
   * `getAvailableKernels()` caches once at startup and never expires, so a kernel
   * registered while the server is running would otherwise stay invisible until a
   * restart. Call this after registering/installing a kernel.
   */
  refreshKernelSpecs(): KernelSpec[] {
    this.kernelSpecsCache = discoverKernelSpecs(true);
    return this.kernelSpecsCache;
  }

  /**
   * Normalize file path for consistent lookup
   */
  private normalizePath(filePath: string): string {
    return path.resolve(filePath.replace(/^~/, os.homedir()));
  }

  /**
   * Normalize notebook path for external callers (e.g., routes).
   */
  normalizeNotebookPath(filePath: string): string {
    return this.normalizePath(filePath);
  }

  /**
   * Save kernel preference for a notebook file.
   */
  saveNotebookKernelPreference(filePath: string, kernelName: string, serverId?: string | null): void {
    const normalizedPath = this.normalizePath(filePath);
    this.sessionStore.saveNotebookKernelPreference(normalizedPath, kernelName, serverId);
  }

  /**
   * Get kernel preference for a notebook file.
   */
  getNotebookKernelPreference(filePath: string): { kernelName: string; serverId: string | null; updatedAt: number } | null {
    const normalizedPath = this.normalizePath(filePath);
    return this.sessionStore.getNotebookKernelPreference(normalizedPath);
  }

  /**
   * Generate a connection file for the kernel
   */
  private async allocateEphemeralPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          server.close(() => reject(new Error('Failed to allocate ephemeral port')));
          return;
        }
        const port = addr.port;
        server.close(() => resolve(port));
      });
    });
  }

  private async generateConnectionFile(sessionId: string): Promise<{ config: ConnectionConfig; filePath: string }> {
    // Avoid random collisions by asking the OS for currently-free ephemeral ports.
    // There's still a small TOCTOU window between close() and kernel bind, but this
    // is far more reliable than picking random ports blindly.
    const ports: number[] = [];
    const seen = new Set<number>();
    while (ports.length < 5) {
      const port = await this.allocateEphemeralPort();
      if (seen.has(port)) continue;
      seen.add(port);
      ports.push(port);
    }
    const [shellPort, stdinPort, controlPort, iopubPort, hbPort] = ports;

    const config: ConnectionConfig = {
      ip: '127.0.0.1',
      transport: 'tcp',
      signatureScheme: 'hmac-sha256',
      key: crypto.randomBytes(16).toString('hex'),
      shellPort,
      stdinPort,
      controlPort,
      iopubPort,
      hbPort,
    };

    // Write connection file
    // Per-user private dir (0700): connection files carry the HMAC key —
    // world-readable means arbitrary code execution as this user.
    const connDir = privateTmpDir('kernels');

    const connFile = path.join(connDir, `kernel-${sessionId}.json`);
    const connData = {
      ip: config.ip,
      transport: config.transport,
      signature_scheme: config.signatureScheme,
      key: config.key,
      shell_port: config.shellPort,
      stdin_port: config.stdinPort,
      control_port: config.controlPort,
      iopub_port: config.iopubPort,
      hb_port: config.hbPort,
    };

    fs.writeFileSync(connFile, JSON.stringify(connData, null, 2), { mode: 0o600 });

    return { config, filePath: connFile };
  }

  /**
   * Start a new kernel session
   */
  async startKernel(options: StartKernelOptions = {}): Promise<string> {
    const kernelName = options.kernelName || 'python3';
    if (
      options.internalEnv
      && (
        Object.keys(options.internalEnv).some((key) => key !== 'PYTHONNOUSERSITE')
        || (
          options.internalEnv.PYTHONNOUSERSITE !== undefined
          && options.internalEnv.PYTHONNOUSERSITE !== '1'
        )
      )
    ) {
      throw new Error('Unsupported internal kernel environment override');
    }

    // env:<pythonPath> kernels raw-launch a Python environment directly
    // (VSCode-style) — no kernelspec registration involved. Preflight here so
    // callers get a crisp, coded error instead of a spawn failure + ready
    // timeout: python_not_found for a dead path, needs_ipykernel (with an
    // ecosystem-appropriate install hint) when the env can't host a kernel yet.
    const envPython = envKernelPythonPath(kernelName);
    let spec: KernelSpec | null;
    if (envPython) {
      if (!fs.existsSync(envPython)) {
        throw new KernelProvisionError(`Python not found: ${envPython}`, 'python_not_found');
      }
      const probe = await pythonDiscovery.probeForKernel(envPython);
      if (!probe.hasIpykernel) {
        throw new KernelProvisionError(
          `ipykernel is not installed in ${envPython}`,
          'needs_ipykernel',
          probe.installHint || undefined
        );
      }
      const cached = pythonDiscovery.getFromCache()?.[envPython];
      spec = makeEnvKernelSpec(envPython, cached?.displayName);
    } else {
      spec = getKernelSpec(kernelName);
    }

    if (!spec) {
      throw new Error(`Kernel '${kernelName}' not found`);
    }

    const sessionId = uuidv4();
    const normalizedFilePath = options.filePath ? this.normalizePath(options.filePath) : null;


    // Generate connection file
    const { config: connConfig, filePath: connFile } = await this.generateConnectionFile(sessionId);

    // Build kernel command
    const argv = (spec.argv || []).map(arg =>
      arg.replace('{connection_file}', connFile)
    );

    if (argv.length === 0) {
      throw new Error(`Kernel '${kernelName}' has no argv defined`);
    }

    // Spawn the kernel process
    const cwd = options.cwd || (normalizedFilePath ? path.dirname(normalizedFilePath) : process.cwd());

    const proc = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...spec.env, ...options.internalEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Log kernel stdout/stderr for debugging
    proc.stdout?.on('data', (data) => {
      console.log(`[Kernel ${sessionId.slice(0, 8)}] stdout: ${data.toString().trim()}`);
    });
    proc.stderr?.on('data', (data) => {
      console.error(`[Kernel ${sessionId.slice(0, 8)}] stderr: ${data.toString().trim()}`);
    });

    const now = Date.now() / 1000;
    const session: KernelSession = {
      id: sessionId,
      kernelName,
      filePath: normalizedFilePath,
      status: 'starting',
      executionCount: 0,
      pid: proc.pid || null,
      connectionFile: connFile,
      connectionConfig: connConfig,
      createdAt: now,
      lastActivity: now,
    };

    this.sessions.set(sessionId, session);
    this.kernelProcesses.set(sessionId, proc);

    if (normalizedFilePath) {
      this.fileToSession.set(normalizedFilePath, sessionId);
    }

    // Handle process events
    this.attachProcessLifecycle(sessionId, proc, session);

    // Wait for kernel to be ready. If startup fails, clean up aggressively so we
    // don't leave behind orphaned sessions/processes/connection files.
    try {
      await this.waitForReady(sessionId);
    } catch (err) {
      await this.stopKernel(sessionId).catch(() => undefined);
      throw err;
    }

    const kernelStartTime = proc.pid ? await this.getProcessStartTime(proc.pid) : null;

    // Save to persistence store (include connection config for reattach if file is deleted)
    this.sessionStore.saveSession({
      sessionId,
      kernelName,
      filePath: normalizedFilePath,
      kernelPid: proc.pid || null,
      serverId: this.serverId,
      serverInstanceId: this.serverInstanceId,
      kernelStartTime,
      status: 'active',
      createdAt: now,
      lastHeartbeat: now,
      connectionFile: connFile,
      connectionConfig: JSON.stringify(session.connectionConfig),
    });

    session.status = 'idle';
    return sessionId;
  }

  /**
   * Wait for kernel to be ready by connecting to ZeroMQ channels.
   *
   * Returns the detected kernel execution state:
   * - 'idle': kernel responded to kernel_info_request (ready for work)
   * - 'busy': kernel PID is alive but shell channel is blocked (mid-execution)
   *
   * @param timeoutSeconds Optional override for startup timeout (default: use config)
   * @param pid Optional kernel PID — used to distinguish "busy" from "dead" on timeout
   */
  private async waitForReady(sessionId: string, timeoutSeconds?: number, pid?: number | null): Promise<'idle' | 'busy'> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.connectionConfig) {
      throw new Error('Session or connection config not found');
    }

    if (!this.zmq) {
      // No ZeroMQ available, just wait a bit and hope the kernel starts
      await this.sleep(1000);
      return 'idle';
    }

    const config = session.connectionConfig;
    const shellEndpoint = `tcp://${config.ip}:${config.shellPort}`;
    const iopubEndpoint = `tcp://${config.ip}:${config.iopubPort}`;

    // Create ZeroMQ sockets
    const shell = new this.zmq.Dealer();
    const iopub = new this.zmq.Subscriber();

    shell.connect(shellEndpoint);
    iopub.connect(iopubEndpoint);
    iopub.subscribe('');

    this.zmqSockets.set(sessionId, { shell, iopub });

    // Start the unified readers: from here on, these loops own every
    // iopub.receive()/shell.receive() for the session. The shell reader must
    // be live before the kernel_info probing below, which awaits its reply
    // through the waiter mechanism.
    this.startIopubReader(sessionId, iopub);
    this.startShellReader(sessionId, shell);

    // Send kernel_info_request to verify connectivity
    const startTime = Date.now();
    const actualTimeout = timeoutSeconds ?? this.config.startupTimeoutSeconds;
    const timeout = actualTimeout * 1000;

    while (Date.now() - startTime < timeout) {
      try {
        await this.sendKernelInfoRequest(sessionId);
        // If we get here without error, kernel is ready
        return 'idle';
      } catch {
        await this.sleep(100);
      }
    }

    // Shell channel didn't respond within timeout.
    // If the kernel PID is alive, it's likely busy executing code
    // (shell requests queue behind the current execution in Jupyter protocol).
    if (pid && this.isPidAlive(pid)) {
      return 'busy';
    }

    throw new Error(`Kernel did not start within ${actualTimeout} seconds`);
  }

  // ---- Unified iopub reader ---------------------------------------------
  // Exactly one loop per session calls iopub.receive(). It demuxes:
  //   - comm_open/comm_msg/comm_close (any parent) -> comm store + onComm
  //   - everything else -> the parent-keyed queue (if a consumer registered
  //     for that parent msg_id) AND every catch-all queue (busy monitor).
  // The loop never spins: receive() blocks until a message arrives, and a
  // socket close (stop/restart/cleanup) rejects the pending receive, which
  // exits the loop and closes all subscriber queues.

  private startIopubReader(sessionId: string, iopub: ZmqSocket): void {
    // Never allow two loops for one session (e.g. restart replaces sockets).
    this.stopIopubReader(sessionId);

    const reader = { stopped: false };
    this.iopubReaders.set(sessionId, reader);

    void (async () => {
      try {
        while (!reader.stopped) {
          let frames: Buffer[];
          try {
            frames = await iopub.receive();
          } catch {
            // Socket closed or errored (kernel stop/restart/cleanup) — exit.
            break;
          }
          if (reader.stopped) break;
          try {
            const parsed = this.parseJupyterMessage(frames);
            this.dispatchIopubMessage(sessionId, parsed);
          } catch (err) {
            console.warn(`[Kernel] Dropping unparseable iopub message for ${sessionId}:`, err);
          }
        }
      } finally {
        // Only tear down if we're still the current reader — on restart a new
        // reader (with fresh subscriber queues) may already have taken over.
        if (this.iopubReaders.get(sessionId) === reader) {
          this.iopubReaders.delete(sessionId);
          this.closeIopubSubscribers(sessionId);
        }
      }
    })();
  }

  private stopIopubReader(sessionId: string): void {
    const reader = this.iopubReaders.get(sessionId);
    if (reader) {
      reader.stopped = true;
      this.iopubReaders.delete(sessionId);
    }
    this.closeIopubSubscribers(sessionId);
  }

  private closeIopubSubscribers(sessionId: string): void {
    const parents = this.iopubParentSubscribers.get(sessionId);
    if (parents) {
      for (const queue of parents.values()) queue.close();
      this.iopubParentSubscribers.delete(sessionId);
    }
    const catchAll = this.iopubCatchAllSubscribers.get(sessionId);
    if (catchAll) {
      for (const queue of catchAll) queue.close();
      this.iopubCatchAllSubscribers.delete(sessionId);
    }
  }

  private dispatchIopubMessage(sessionId: string, msg: ParsedIopubMessage): void {
    if (msg.msgType === 'comm_open' || msg.msgType === 'comm_msg' || msg.msgType === 'comm_close') {
      this.handleKernelCommMessage(sessionId, msg);
      return;
    }

    if (msg.parentMsgId) {
      this.iopubParentSubscribers.get(sessionId)?.get(msg.parentMsgId)?.push(msg);
    }
    const catchAll = this.iopubCatchAllSubscribers.get(sessionId);
    if (catchAll) {
      for (const queue of catchAll) queue.push(msg);
    }
  }

  /**
   * Subscribe to iopub messages parented by a specific msg_id. Must be called
   * BEFORE sending the request so no reply can slip past the demux. Callers
   * must unsubscribe in a finally block.
   */
  private subscribeIopubParent(sessionId: string, parentMsgId: string): BoundedAsyncQueue<ParsedIopubMessage> {
    let parents = this.iopubParentSubscribers.get(sessionId);
    if (!parents) {
      parents = new Map();
      this.iopubParentSubscribers.set(sessionId, parents);
    }
    const queue = new BoundedAsyncQueue<ParsedIopubMessage>(MAX_PARENT_QUEUE_MESSAGES);
    parents.set(parentMsgId, queue);
    // If no reader loop is alive (it crashed or was never started), close the
    // queue immediately so consumers fail fast instead of hanging forever.
    if (!this.iopubReaders.has(sessionId)) {
      queue.close();
    }
    return queue;
  }

  private unsubscribeIopubParent(sessionId: string, parentMsgId: string): void {
    const parents = this.iopubParentSubscribers.get(sessionId);
    const queue = parents?.get(parentMsgId);
    if (!parents || !queue) return;
    queue.close();
    parents.delete(parentMsgId);
    if (parents.size === 0) {
      this.iopubParentSubscribers.delete(sessionId);
    }
  }

  /** Subscribe to ALL iopub messages for a session (any parent). */
  private subscribeIopubCatchAll(sessionId: string): BoundedAsyncQueue<ParsedIopubMessage> {
    let queues = this.iopubCatchAllSubscribers.get(sessionId);
    if (!queues) {
      queues = new Set();
      this.iopubCatchAllSubscribers.set(sessionId, queues);
    }
    const queue = new BoundedAsyncQueue<ParsedIopubMessage>(MAX_CATCHALL_QUEUE_MESSAGES);
    queues.add(queue);
    if (!this.iopubReaders.has(sessionId)) {
      queue.close();
    }
    return queue;
  }

  private unsubscribeIopubCatchAll(sessionId: string, queue: BoundedAsyncQueue<ParsedIopubMessage>): void {
    queue.close();
    const queues = this.iopubCatchAllSubscribers.get(sessionId);
    if (!queues) return;
    queues.delete(queue);
    if (queues.size === 0) {
      this.iopubCatchAllSubscribers.delete(sessionId);
    }
  }

  // ---- Unified shell reply reader -----------------------------------------
  // Mirrors the iopub reader: exactly one loop per session calls
  // shell.receive(). Consumers register a one-shot waiter keyed by their
  // request msg_id BEFORE sending, then await the reply with a timeout. A
  // timeout only deregisters the waiter — the reader keeps owning the socket,
  // so a slow reply (e.g. complete_request against a busy kernel) can never
  // block or swallow a later request's reply.

  private startShellReader(sessionId: string, shell: ZmqSocket): void {
    // Never allow two loops for one session (e.g. restart replaces sockets).
    this.stopShellReader(sessionId);

    const reader = { stopped: false };
    this.shellReaders.set(sessionId, reader);

    void (async () => {
      try {
        while (!reader.stopped) {
          let frames: Buffer[];
          try {
            frames = await shell.receive();
          } catch {
            // Socket closed or errored (kernel stop/restart/cleanup) — exit.
            break;
          }
          if (reader.stopped) break;
          try {
            const parsed = this.parseJupyterMessage(frames);
            const waiters = this.shellReplyWaiters.get(sessionId);
            const waiter = parsed.parentMsgId ? waiters?.get(parsed.parentMsgId) : undefined;
            if (waiters && waiter) {
              waiters.delete(parsed.parentMsgId);
              if (waiters.size === 0) this.shellReplyWaiters.delete(sessionId);
              waiter(parsed);
            } else {
              // No waiter: execute_reply (executions are iopub-driven), or the
              // waiter timed out and deregistered. Drop it.
              console.debug(`[Kernel] Dropping unclaimed shell ${parsed.msgType} for ${sessionId}`);
            }
          } catch (err) {
            console.warn(`[Kernel] Dropping unparseable shell message for ${sessionId}:`, err);
          }
        }
      } finally {
        // Only tear down if we're still the current reader — on restart a new
        // reader (with fresh waiters) may already have taken over.
        if (this.shellReaders.get(sessionId) === reader) {
          this.shellReaders.delete(sessionId);
          this.closeShellReplyWaiters(sessionId);
        }
      }
    })();
  }

  private stopShellReader(sessionId: string): void {
    const reader = this.shellReaders.get(sessionId);
    if (reader) {
      reader.stopped = true;
      this.shellReaders.delete(sessionId);
    }
    this.closeShellReplyWaiters(sessionId);
  }

  private closeShellReplyWaiters(sessionId: string): void {
    const waiters = this.shellReplyWaiters.get(sessionId);
    if (!waiters) return;
    this.shellReplyWaiters.delete(sessionId);
    for (const resolve of waiters.values()) {
      resolve('closed');
    }
  }

  /**
   * Register a one-shot waiter for the shell reply parented by msgId. Must be
   * called BEFORE sending the request so the reply cannot slip past the
   * dispatch. Resolves 'closed' immediately if no reader loop is alive, or
   * later when the reader stops (kernel stop/restart/cleanup).
   */
  private registerShellReplyWaiter(sessionId: string, msgId: string): Promise<ParsedShellMessage | 'closed'> {
    if (!this.shellReaders.has(sessionId)) {
      return Promise.resolve('closed');
    }
    let waiters = this.shellReplyWaiters.get(sessionId);
    if (!waiters) {
      waiters = new Map();
      this.shellReplyWaiters.set(sessionId, waiters);
    }
    const map = waiters;
    return new Promise((resolve) => {
      map.set(msgId, resolve);
    });
  }

  private removeShellReplyWaiter(sessionId: string, msgId: string): void {
    const waiters = this.shellReplyWaiters.get(sessionId);
    if (!waiters) return;
    waiters.delete(msgId);
    if (waiters.size === 0) {
      this.shellReplyWaiters.delete(sessionId);
    }
  }

  /**
   * Await a previously registered shell reply with a timeout. The waiter is
   * always deregistered on the way out (timeout, reply, or error), so a late
   * reply is dropped by the reader instead of leaking a waiter.
   */
  private async waitForShellReply(
    sessionId: string,
    msgId: string,
    replyPromise: Promise<ParsedShellMessage | 'closed'>,
    timeoutMs: number
  ): Promise<ParsedShellMessage | 'timeout' | 'closed'> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      (timer as NodeJS.Timeout).unref?.();
    });
    try {
      return await Promise.race([replyPromise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      this.removeShellReplyWaiter(sessionId, msgId);
    }
  }

  // ---- Comm handling ------------------------------------------------------

  private handleKernelCommMessage(sessionId: string, msg: ParsedIopubMessage): void {
    const commId = typeof msg.content.comm_id === 'string' ? msg.content.comm_id : null;
    if (!commId) return;

    const data = (msg.content.data && typeof msg.content.data === 'object')
      ? (msg.content.data as Record<string, unknown>)
      : {};
    const targetName = typeof msg.content.target_name === 'string' ? msg.content.target_name : undefined;

    // Maintain the comm-state store so late-joining clients can discover
    // open comms (comm_info) after the fact.
    if (msg.msgType === 'comm_open') {
      this.rememberOpenComm(sessionId, commId, targetName ?? '', data);
    } else if (msg.msgType === 'comm_close') {
      this.commStates.get(sessionId)?.delete(commId);
    }

    const comm: CommEvent = {
      msgType: msg.msgType as CommEvent['msgType'],
      commId,
      data,
    };
    if (targetName !== undefined) {
      comm.targetName = targetName;
    }
    if (msg.buffers.length > 0) {
      comm.buffers = msg.buffers.map((b) => b.toString('base64'));
    }
    this.notifyComm(sessionId, comm);
  }

  private rememberOpenComm(
    sessionId: string,
    commId: string,
    targetName: string,
    openData: Record<string, unknown>
  ): void {
    let comms = this.commStates.get(sessionId);
    if (!comms) {
      comms = new Map();
      this.commStates.set(sessionId, comms);
    }
    // Bounded store: evict the oldest tracked comm when full (light v1).
    if (!comms.has(commId) && comms.size >= MAX_TRACKED_COMMS_PER_SESSION) {
      const oldest = comms.keys().next().value;
      if (oldest !== undefined) {
        comms.delete(oldest);
      }
    }
    comms.set(commId, { targetName, openData });
  }

  /**
   * Open comms known for a session (for late-joining clients).
   * Returns comm_id -> { targetName, openData } where openData is the last
   * state-carrying comm_open payload observed for that comm.
   */
  getOpenComms(sessionId: string): Record<string, { targetName: string; openData: Record<string, unknown> }> {
    const comms = this.commStates.get(sessionId);
    const result: Record<string, { targetName: string; openData: Record<string, unknown> }> = {};
    if (!comms) return result;
    for (const [commId, info] of comms) {
      result[commId] = { targetName: info.targetName, openData: info.openData };
    }
    return result;
  }

  /**
   * Send a comm message (comm_open / comm_msg / comm_close) to the kernel on
   * the shell channel. Comm messages produce NO shell reply, so the queued
   * slot releases as soon as the send completes — we never block waiting for
   * a reply that will not come.
   *
   * @param buffers Optional binary buffer frames, base64-encoded.
   */
  async sendCommMessage(
    sessionId: string,
    msgType: 'comm_open' | 'comm_msg' | 'comm_close',
    content: Record<string, unknown>,
    buffers?: string[]
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.connectionConfig) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (!this.zmq || !this.zmqSockets.has(sessionId)) {
      throw new Error('ZeroMQ not available for kernel communication');
    }

    const binaryBuffers = (buffers ?? []).map((b64) => Buffer.from(b64, 'base64'));
    const header = {
      msg_id: uuidv4(),
      session: sessionId,
      username: 'nebula',
      msg_type: msgType,
      version: '5.3',
      date: new Date().toISOString(),
    };
    const message = this.createJupyterMessage(
      header,
      {},
      content,
      session.connectionConfig.key,
      binaryBuffers
    );

    // Track client-opened comms too, so comm_info reflects both directions.
    const commId = typeof content.comm_id === 'string' ? content.comm_id : null;
    if (commId) {
      if (msgType === 'comm_open') {
        const targetName = typeof content.target_name === 'string' ? content.target_name : '';
        const data = (content.data && typeof content.data === 'object')
          ? (content.data as Record<string, unknown>)
          : {};
        this.rememberOpenComm(sessionId, commId, targetName, data);
      } else if (msgType === 'comm_close') {
        this.commStates.get(sessionId)?.delete(commId);
      }
    }

    // Route through the shell queue so we never interleave with an in-flight
    // request/reply pair on the Dealer socket. Send-only: no receive() here.
    await this.enqueueShellRequest(sessionId, async () => {
      const sockets = this.zmqSockets.get(sessionId);
      if (!sockets) {
        throw new Error(`Session ${sessionId} sockets are gone (kernel stopped?)`);
      }
      await sockets.shell.send(message);
    });
  }

  /**
   * Monitor a busy reattached kernel on iopub. When its current execution
   * finishes (status: idle on iopub), verify shell connectivity and update
   * the in-memory session status.
   */
  private monitorBusyKernel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !this.zmqSockets.has(sessionId)) return;

    console.log(`[Kernel] Monitoring busy kernel ${sessionId} for idle transition...`);

    // Consume from the unified reader's catch-all channel — the monitor cares
    // about status messages from executions we did not initiate (any parent).
    const channel = this.subscribeIopubCatchAll(sessionId);

    const poll = async () => {
      try {
        while (session.status === 'busy') {
          const msg = await channel.next(5000);

          if (msg === IOPUB_QUEUE_TIMEOUT) {
            // Periodic liveness check
            if (session.pid && !this.isPidAlive(session.pid)) {
              console.log(`[Kernel] Busy kernel ${sessionId} PID ${session.pid} died`);
              session.status = 'dead';
              return;
            }
            continue;
          }

          if (msg === IOPUB_QUEUE_CLOSED) {
            // Kernel stopped/restarted while monitoring — nothing more to do.
            return;
          }

          if (msg.msgType === 'status' && msg.content.execution_state === 'idle') {
            break;
          }
        }

        // Prior execution finished — verify shell connectivity
        try {
          await this.sendKernelInfoRequest(sessionId);
        } catch {
          // Non-fatal; next executeCode will detect issues
        }
        session.status = 'idle';
        session.lastActivity = Date.now() / 1000;
        console.log(`[Kernel] Busy kernel ${sessionId} is now idle`);
      } catch (err) {
        console.error(`[Kernel] Error monitoring busy kernel ${sessionId}:`, err);
        session.status = 'idle'; // Assume idle — next operation will detect real issues
      } finally {
        this.unsubscribeIopubCatchAll(sessionId, channel);
      }
    };

    void poll();
  }

  /**
   * Send kernel_info_request and wait for reply to verify kernel is ready
   * Throws if no reply received within timeout
   */
  private async sendKernelInfoRequest(sessionId: string): Promise<void> {
    const sockets = this.zmqSockets.get(sessionId);
    const session = this.sessions.get(sessionId);

    if (!sockets || !session) {
      throw new Error('Session or sockets not found');
    }

    const msgId = uuidv4();
    const header = {
      msg_id: msgId,
      session: sessionId,
      username: 'nebula',
      msg_type: 'kernel_info_request',
      version: '5.3',
      date: new Date().toISOString(),
    };

    const message = this.createJupyterMessage(
      header,
      {},
      {},
      session.connectionConfig!.key
    );

    // Register the waiter before sending so the reply cannot race the
    // dispatch, then wait for kernel_info_reply with timeout.
    const replyPromise = this.registerShellReplyWaiter(sessionId, msgId);
    try {
      await this.enqueueShellRequest(sessionId, () => sockets.shell.send(message));
    } catch (err) {
      this.removeShellReplyWaiter(sessionId, msgId);
      throw err;
    }

    const reply = await this.waitForShellReply(sessionId, msgId, replyPromise, 1000);
    if (reply === 'timeout' || reply === 'closed') {
      throw new Error('Kernel not responding');
    }
    if (reply.msgType !== 'kernel_info_reply') {
      throw new Error(`Unexpected message type: ${reply.msgType}`);
    }
    // Kernel is ready!
  }

  /**
   * Create a Jupyter protocol message
   */
  private createJupyterMessage(
    header: Record<string, unknown>,
    parentHeader: Record<string, unknown>,
    content: Record<string, unknown>,
    key: string,
    buffers: Buffer[] = []
  ): Buffer[] {
    const headerJson = JSON.stringify(header);
    const parentHeaderJson = JSON.stringify(parentHeader);
    const metadataJson = JSON.stringify({});
    const contentJson = JSON.stringify(content);

    // Create HMAC signature (buffers are NOT part of the signature per the
    // Jupyter wire protocol — only header/parent_header/metadata/content).
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(headerJson);
    hmac.update(parentHeaderJson);
    hmac.update(metadataJson);
    hmac.update(contentJson);
    const signature = hmac.digest('hex');

    // Build multipart message; binary buffer frames follow content
    return [
      Buffer.from('<IDS|MSG>'),
      Buffer.from(signature),
      Buffer.from(headerJson),
      Buffer.from(parentHeaderJson),
      Buffer.from(metadataJson),
      Buffer.from(contentJson),
      ...buffers,
    ];
  }

  /**
   * Get or create kernel for a file (one notebook = one kernel).
   * Returns whether a new session was created.
   */
  /** In-flight create/attach per normalized file path (single-flight).
   *  Without this, two near-simultaneous requests (UI re-render + agent op,
   *  double-click) both miss the fileToSession check and spawn TWO kernel
   *  processes — the second overwrites the mapping and the first leaks. */
  private inflightKernelCreates = new Map<string, Promise<{ sessionId: string; created: boolean }>>();

  async getOrCreateKernel(filePath: string, kernelName: string = 'python3'): Promise<{ sessionId: string; created: boolean }> {
    const key = this.normalizePath(filePath);
    const inflight = this.inflightKernelCreates.get(key);
    if (inflight) {
      return inflight;
    }
    const run = this.getOrCreateKernelInternal(key, kernelName).finally(() => {
      this.inflightKernelCreates.delete(key);
    });
    this.inflightKernelCreates.set(key, run);
    return run;
  }

  private async getOrCreateKernelInternal(filePath: string, kernelName: string): Promise<{ sessionId: string; created: boolean }> {
    const normalizedPath = this.normalizePath(filePath);

    // Check for existing session in fileToSession map
    let existingSessionId = this.fileToSession.get(normalizedPath);

    // Fallback: search all sessions for matching filePath (handles race after server restart)
    if (!existingSessionId) {
      for (const [sessionId, session] of this.sessions.entries()) {
        if (session.filePath === normalizedPath && session.status !== 'dead') {
          console.log(`[Kernel] Found orphaned session ${sessionId} for ${normalizedPath}, restoring fileToSession mapping`);
          this.fileToSession.set(normalizedPath, sessionId);
          existingSessionId = sessionId;
          break;
        }
      }
    }

    if (existingSessionId) {
      const session = this.sessions.get(existingSessionId);
      if (session && session.status !== 'dead') {
        // If session is stuck in 'starting' for too long, treat as dead
        if (session.status === 'starting') {
          const startingDuration = Date.now() / 1000 - session.lastActivity;
          // Allow a longer grace period for slow environments before declaring it stuck
          if (startingDuration > 120) {
            console.log(`[Kernel] Session ${existingSessionId} stuck in 'starting' for ${Math.round(startingDuration)}s, restarting`);
            await this.stopKernel(existingSessionId);
          } else {
            // Wait a bit and check if it becomes ready
            for (let i = 0; i < 20; i++) {
              await this.sleep(500);
              const updated = this.sessions.get(existingSessionId);
              if (!updated || updated.status === 'dead') break;
              if (updated.status === 'idle' || updated.status === 'busy') {
                if (updated.kernelName === kernelName) {
                  return { sessionId: existingSessionId, created: false };
                }
                break;
              }
            }
            // Still starting after wait; keep it rather than restarting unless it exceeds grace
            const stillStarting = this.sessions.get(existingSessionId);
            if (stillStarting?.status === 'starting') {
              console.log(`[Kernel] Session ${existingSessionId} still starting after wait; keeping it alive`);
              return { sessionId: existingSessionId, created: false };
            }
          }
        } else {
          // Session is idle or busy
          if (session.kernelName === kernelName) {
            return { sessionId: existingSessionId, created: false };
          }
          // Kernel type changed, stop old and start new
          await this.stopKernel(existingSessionId);
        }
      }
    }

    // Start new kernel
    const sessionId = await this.startKernel({
      kernelName,
      filePath: normalizedPath,
      cwd: path.dirname(normalizedPath),
    });
    return { sessionId, created: true };
  }

  /**
   * Get existing kernel session ID for a notebook file (if any).
   * Returns null if no live session is associated with the file.
   */
  getSessionIdForFile(filePath: string): string | null {
    const normalizedPath = this.normalizePath(filePath);

    let existingSessionId = this.fileToSession.get(normalizedPath);
    if (existingSessionId) {
      const session = this.sessions.get(existingSessionId);
      if (session && session.status !== 'dead') {
        return existingSessionId;
      }
    }

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.filePath === normalizedPath && session.status !== 'dead') {
        this.fileToSession.set(normalizedPath, sessionId);
        existingSessionId = sessionId;
        break;
      }
    }

    return existingSessionId || null;
  }

  /**
   * Check if a kernel session exists.
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get the notebook file path associated with a session (if any).
   * Used for output persistence when no UI is connected.
   */
  getSessionFilePath(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.filePath ?? null;
  }

  /**
   * Get the kernel name associated with a session (if any).
   */
  getSessionKernelName(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.kernelName ?? null;
  }

  /**
   * Execute code in a kernel session
   */
  async executeCode(
    sessionId: string,
    code: string,
    onOutput: (output: KernelOutput, cellId?: string | null) => Promise<void>,
    onQueueInfo?: (info: ExecutionQueueInfo) => void,
    cellId?: string | null,
    internalOptions?: InternalExecutionOptions,
  ): Promise<ExecutionResult> {
    // Polyfill `!command` lines for kernels whose language lacks them (see
    // rewriteShellLines) — rewritten code still runs IN the kernel process,
    // so cwd/env/node are the kernel's, exactly like IPython's native `!`.
    {
      const kernelName = this.sessions.get(sessionId)?.kernelName;
      const spec = kernelName ? getKernelSpec(kernelName) : null;
      code = rewriteShellLines(code, spec?.language);
    }
    const queueInfo = this.reserveExecutionSlot(sessionId);
    if (onQueueInfo) {
      onQueueInfo(queueInfo);
    }
    return this.enqueueExecution(sessionId, async () => {
      // Clear previous outputs for this cell before starting new execution
      if (cellId) {
        this.clearCellOutputs(sessionId, cellId);
      }
      this.executingCellIds.set(sessionId, cellId ?? null);
      try {
        const result = await this.executeCodeInternal(sessionId, code, async (output) => {
          const stored = this.bufferOutput(sessionId, output, cellId);
          for (const o of stored) {
            await onOutput(o, cellId);
          }
        }, internalOptions?.storeHistory !== false);
        return { ...result, ...queueInfo };
      } catch (err) {
        const errorMsg = this.formatExecutionError(err);
        const stored = this.bufferOutput(sessionId, { type: 'error', content: errorMsg }, cellId);
        for (const o of stored) {
          await onOutput(o, cellId);
        }
        return { status: 'error', executionCount: null, error: errorMsg, ...queueInfo };
      } finally {
        this.executingCellIds.delete(sessionId);
        this.releaseExecutionSlot(sessionId);
      }
    });
  }

  private enqueueExecution<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.executionQueues.get(sessionId) || Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const chain = run.catch(() => undefined);
    this.executionQueues.set(sessionId, chain);
    chain.finally(() => {
      if (this.executionQueues.get(sessionId) === chain) {
        this.executionQueues.delete(sessionId);
      }
    });
    return run;
  }

  /**
   * Serialize shell socket SENDS. Receives are owned by the unified shell
   * reader, so tasks queued here must be send-only and release the slot as
   * soon as the send completes (register any reply waiter BEFORE enqueueing,
   * await the reply AFTER the slot is released). Holding the slot across a
   * reply wait would let one slow request delay every later send.
   */
  private enqueueShellRequest<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.shellRequestQueues.get(sessionId) || Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const chain = run.catch(() => undefined);
    this.shellRequestQueues.set(sessionId, chain);
    chain.finally(() => {
      if (this.shellRequestQueues.get(sessionId) === chain) {
        this.shellRequestQueues.delete(sessionId);
      }
    });
    return run;
  }

  private reserveExecutionSlot(sessionId: string): ExecutionQueueInfo {
    const currentSize = this.executionQueueSizes.get(sessionId) ?? 0;
    const info = {
      queuePosition: currentSize,
      queueLength: currentSize + 1,
    };
    this.executionQueueSizes.set(sessionId, currentSize + 1);
    return info;
  }

  private releaseExecutionSlot(sessionId: string): void {
    const currentSize = this.executionQueueSizes.get(sessionId) ?? 0;
    if (currentSize <= 1) {
      this.executionQueueSizes.delete(sessionId);
    } else {
      this.executionQueueSizes.set(sessionId, currentSize - 1);
    }
  }

  private formatExecutionError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Socket is busy reading')) {
      return 'Kernel output stream is busy because another execution is running. Wait for it to finish or poll with read_output before starting a new execute_cell.';
    }
    return message;
  }

  private async executeCodeInternal(
    sessionId: string,
    code: string,
    onOutput: (output: KernelOutput) => Promise<void>,
    storeHistory = true,
  ): Promise<ExecutionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!this.zmq || !this.zmqSockets.has(sessionId)) {
      // Fallback: no ZeroMQ, cannot execute
      const errorMsg = 'ZeroMQ not available for kernel communication';
      await onOutput({ type: 'error', content: errorMsg });
      return { status: 'error', executionCount: null, error: errorMsg };
    }

    session.status = 'busy';
    const sockets = this.zmqSockets.get(sessionId)!;
    let execCount: number | null = null;

    // Subscribe to iopub messages for this execution BEFORE sending the
    // request so the unified reader can't demux replies into the void.
    const msgId = uuidv4();
    const channel = this.subscribeIopubParent(sessionId, msgId);

    try {
      // Create execute_request message
      const header = {
        msg_id: msgId,
        session: sessionId,
        username: 'nebula',
        msg_type: 'execute_request',
        version: '5.3',
        date: new Date().toISOString(),
      };

      const content = {
        code,
        silent: false,
        store_history: storeHistory,
        user_expressions: {},
        allow_stdin: false,
        stop_on_error: true,
      };

      const message = this.createJupyterMessage(
        header,
        {},
        content,
        session.connectionConfig!.key
      );

      // Serialize the send with other shell sends; no shell reply waiter —
      // execution progress and completion are driven entirely by iopub
      // (execute_reply is dropped by the shell reader as unclaimed).
      await this.enqueueShellRequest(sessionId, () => sockets.shell.send(message));

      // Process iopub messages for our execution (already parent-filtered by
      // the unified reader; comm messages are demuxed to onComm separately)
      while (true) {
        const msg = await channel.next();
        if (typeof msg === 'symbol') {
          // Queue closed: kernel stopped/restarted mid-execution. Surface the
          // same way a socket-close used to — via the catch block below.
          throw new Error('Kernel iopub stream closed during execution');
        }
        const { msgType, content: msgContent } = msg;

        // Handle different message types
        if (msgType === 'execute_input') {
          execCount = msgContent.execution_count as number;
        } else if (msgType === 'stream') {
          const streamName = msgContent.name as string;
          await onOutput({
            type: streamName === 'stderr' ? 'stderr' : 'stdout',
            content: msgContent.text as string,
          });
        } else if (msgType === 'execute_result' || msgType === 'display_data') {
          const output = this.formatDisplayData(
            (msgContent.data as Record<string, unknown>) || {},
            (msgContent.metadata as Record<string, unknown>) || undefined,
          );
          if (output) {
            output.jupyterOutputType = msgType;
            if (msgType === 'execute_result' && Number.isSafeInteger(msgContent.execution_count)) {
              output.jupyterExecutionCount = msgContent.execution_count as number;
            }
            await onOutput(output);
          }
        } else if (msgType === 'error') {
          const traceback = (msgContent.traceback as string[]) || [];
          const cleanTb = traceback.map(line => this.stripAnsi(line)).join('\n');
          await onOutput({ type: 'error', content: cleanTb });
        } else if (msgType === 'status') {
          if (msgContent.execution_state === 'idle') {
            break;
          }
        }
      }

      session.executionCount = execCount || session.executionCount;
      session.status = 'idle';
      session.lastActivity = Date.now() / 1000;

      return { status: 'ok', executionCount: execCount };
    } catch (err) {
      // A restart closes the old sockets while we may be mid-receive: surface
      // that as a clean cancellation, and never clobber 'starting'/'dead'
      // status set concurrently by the restart/exit paths (re-read through
      // the map — TS narrowing can't see cross-async mutation).
      const currentStatus = this.sessions.get(sessionId)?.status;
      if (currentStatus === 'starting' || currentStatus === 'dead') {
        const msg = currentStatus === 'dead' ? 'Kernel died during execution' : 'Kernel was restarted — execution cancelled';
        await onOutput({ type: 'error', content: msg });
        return { status: 'error', executionCount: null, error: msg };
      }
      session.status = 'idle';
      const errorMsg = this.formatExecutionError(err);
      await onOutput({ type: 'error', content: errorMsg });
      return { status: 'error', executionCount: null, error: errorMsg };
    } finally {
      this.unsubscribeIopubParent(sessionId, msgId);
    }
  }

  /**
   * Request code completion from the kernel
   * Uses a separate queue for shell socket operations to avoid "socket busy" errors
   */
  async complete(
    sessionId: string,
    code: string,
    cursorPos: number
  ): Promise<{ status: string; matches: string[]; cursor_start: number; cursor_end: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { status: 'error', matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    }

    if (!this.zmq || !this.zmqSockets.has(sessionId)) {
      return { status: 'error', matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    }

    return this.completeInternal(sessionId, code, cursorPos);
  }

  /**
   * Internal completion implementation. The send is serialized through the
   * shell queue; the reply is awaited via the unified shell reader, so a
   * timeout here simply drops the waiter and can never block or swallow a
   * later request's reply.
   */
  private async completeInternal(
    sessionId: string,
    code: string,
    cursorPos: number
  ): Promise<{ status: string; matches: string[]; cursor_start: number; cursor_end: number }> {
    const session = this.sessions.get(sessionId);
    const sockets = this.zmqSockets.get(sessionId);

    if (!session || !sockets) {
      return { status: 'error', matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    }

    try {
      // Create complete_request message
      const msgId = uuidv4();
      const header = {
        msg_id: msgId,
        session: sessionId,
        username: 'nebula',
        msg_type: 'complete_request',
        version: '5.3',
        date: new Date().toISOString(),
      };

      const content = {
        code,
        cursor_pos: cursorPos,
      };

      const message = this.createJupyterMessage(
        header,
        {},
        content,
        session.connectionConfig!.key
      );

      // Register the waiter before sending so the reply cannot race the
      // dispatch, then wait for complete_reply with timeout.
      const replyPromise = this.registerShellReplyWaiter(sessionId, msgId);
      try {
        await this.enqueueShellRequest(sessionId, () => sockets.shell.send(message));
      } catch (err) {
        this.removeShellReplyWaiter(sessionId, msgId);
        throw err;
      }

      const reply = await this.waitForShellReply(sessionId, msgId, replyPromise, 3000);

      if (reply === 'timeout') {
        return { status: 'timeout', matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
      }
      if (reply === 'closed' || reply.msgType !== 'complete_reply') {
        return { status: 'error', matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
      }

      const msgContent = reply.content;
      return {
        status: (msgContent.status as string) || 'ok',
        matches: (msgContent.matches as string[]) || [],
        cursor_start: (msgContent.cursor_start as number) ?? cursorPos,
        cursor_end: (msgContent.cursor_end as number) ?? cursorPos,
      };
    } catch (err) {
      console.error('[KernelService] Completion error:', err);
      return { status: 'error', matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    }
  }

  /**
   * Parse a Jupyter protocol message
   */
  private parseJupyterMessage(frames: Buffer[]): {
    msgType: string;
    content: Record<string, unknown>;
    parentMsgId: string;
    buffers: Buffer[];
  } {
    // Find delimiter
    let delimIdx = -1;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].toString() === '<IDS|MSG>') {
        delimIdx = i;
        break;
      }
    }

    if (delimIdx === -1) {
      throw new Error('Invalid Jupyter message: no delimiter found');
    }

    // Parse message parts after delimiter
    const signature = frames[delimIdx + 1].toString();
    const header = JSON.parse(frames[delimIdx + 2].toString());
    const parentHeader = JSON.parse(frames[delimIdx + 3].toString());
    const metadata = JSON.parse(frames[delimIdx + 4].toString());
    const content = JSON.parse(frames[delimIdx + 5].toString());

    // Any frames after content are binary buffers (e.g. ipywidgets comm data)
    const buffers = frames.slice(delimIdx + 6);

    return {
      msgType: header.msg_type,
      content,
      parentMsgId: parentHeader.msg_id || '',
      buffers,
    };
  }

  /**
   * Format display data for output
   */
  private formatDisplayData(
    data: Record<string, unknown>,
    metadata?: Record<string, unknown>,
  ): KernelOutput | null {
    const normalizedOutput = buildDisplayOutput(data, metadata);
    if (!normalizedOutput) {
      return null;
    }

    return {
      type: normalizedOutput.type,
      content: normalizedOutput.content,
      mimeBundle: normalizedOutput.mimeBundle,
      metadata: normalizedOutput.metadata,
      preferredMimeType: normalizedOutput.preferredMimeType,
    };
  }

  /**
   * Strip ANSI escape codes from text
   */
  private stripAnsi(text: string): string {
    return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  }

  private getOutputStats(output: KernelOutput): { lines: number; chars: number; isError: boolean } {
    const isError = output.type === 'error';
    const chars = output.content?.length || 0;
      const lines = output.type === 'image' || output.type === 'html' || output.type === 'display_data'
        ? 0
        : (output.content?.match(/\n/g) || []).length + 1;
    return { lines, chars, isError };
  }

  private ensureCellBuffers(sessionId: string): Map<string, KernelOutput[]> {
    let buffers = this.cellOutputBuffers.get(sessionId);
    if (!buffers) {
      buffers = new Map();
      this.cellOutputBuffers.set(sessionId, buffers);
    }
    return buffers;
  }

  private ensureCellTracking(sessionId: string, cellId: string): { lines: number; chars: number; truncated: boolean } {
    let tracking = this.cellOutputTracking.get(sessionId);
    if (!tracking) {
      tracking = new Map();
      this.cellOutputTracking.set(sessionId, tracking);
    }
    let cellTrack = tracking.get(cellId);
    if (!cellTrack) {
      cellTrack = { lines: 0, chars: 0, truncated: false };
      tracking.set(cellId, cellTrack);
    }
    return cellTrack;
  }

  /**
   * Buffer an output for a cell. Returns the outputs actually stored (0 if truncated, 1 normally).
   */
  bufferOutput(
    sessionId: string,
    output: KernelOutput,
    cellId?: string | null
  ): KernelOutput[] {
    const effectiveCellId = cellId ?? '__unknown__';
    const buffers = this.ensureCellBuffers(sessionId);
    const cellTrack = this.ensureCellTracking(sessionId, effectiveCellId);

    const stats = this.getOutputStats(output);

    if (cellTrack.lines + stats.lines > MAX_OUTPUT_LINES || cellTrack.chars + stats.chars > MAX_OUTPUT_CHARS) {
      if (!cellTrack.truncated) {
        cellTrack.truncated = true;
        const warning: KernelOutput = {
          type: 'stderr',
          content: `\n⚠️ Output limit reached. Additional output not displayed.`,
        };
        let arr = buffers.get(effectiveCellId);
        if (!arr) { arr = []; buffers.set(effectiveCellId, arr); }
        arr.push(warning);
        return [warning];
      }
      return [];
    }

    cellTrack.lines += stats.lines;
    cellTrack.chars += stats.chars;

    let arr = buffers.get(effectiveCellId);
    if (!arr) { arr = []; buffers.set(effectiveCellId, arr); }
    arr.push(output);
    return [output];
  }

  /**
   * Clear outputs for a specific cell (called on re-execute).
   */
  clearCellOutputs(sessionId: string, cellId: string): void {
    this.cellOutputBuffers.get(sessionId)?.delete(cellId);
    this.cellOutputTracking.get(sessionId)?.delete(cellId);
  }

  /**
   * Get all cell outputs for a session, grouped by cellId.
   */
  getAllCellOutputs(sessionId: string): Map<string, KernelOutput[]> {
    return this.cellOutputBuffers.get(sessionId) || new Map();
  }

  getExecutingCellId(sessionId: string): string | null {
    return this.executingCellIds.get(sessionId) ?? null;
  }


  /**
   * Stop a kernel session
   */
  async stopKernel(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    // Close ZeroMQ sockets
    const sockets = this.zmqSockets.get(sessionId);
    if (sockets) {
      try {
        sockets.shell.close();
        sockets.iopub.close();
      } catch {
        // Ignore close errors
      }
      this.zmqSockets.delete(sessionId);
    }

    // Kill kernel process
    const proc = this.kernelProcesses.get(sessionId);
    if (proc) {
      this.detachProcessLifecycle(proc);
      try {
        proc.kill('SIGTERM');
        // Wait for graceful shutdown
        await this.sleep(1000);
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch {
        // Ignore kill errors
      }
      this.kernelProcesses.delete(sessionId);
    } else if (session.pid) {
      try {
        process.kill(session.pid, 'SIGTERM');
        await this.sleep(1000);
        if (this.isPidAlive(session.pid)) {
          process.kill(session.pid, 'SIGKILL');
        }
      } catch {
        // Ignore kill errors
      }
    }

    // Cleanup resources
    this.cleanupKernelResources(sessionId);

    return true;
  }

  /**
   * Check command line for a PID (best-effort).
   */
  private async getPidCommand(pid: number): Promise<string | null> {
    try {
      if (process.platform === 'linux') {
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
        const cmdline = raw.toString('utf8').replace(/\0/g, ' ').trim();
        return cmdline || null;
      }
      const { stdout } = await execAsync(`ps -o command= -p ${pid}`, { timeout: 500 });
      const cmd = stdout.trim();
      return cmd.length > 0 ? cmd : null;
    } catch {
      return null;
    }
  }

  /**
   * Get process start time (best-effort), used to prevent PID reuse mistakes.
   */
  private async getProcessStartTime(pid: number): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`ps -o lstart= -p ${pid}`, { timeout: 500 });
      const startTime = stdout.trim();
      return startTime.length > 0 ? startTime : null;
    } catch {
      return null;
    }
  }

  /**
   * Best-effort check to ensure the PID is a kernel process we started.
   */
  private async isExpectedKernelProcess(
    pid: number,
    connectionFile: string | null,
    expectedStartTime?: string | null
  ): Promise<boolean> {
    if (expectedStartTime) {
      const currentStartTime = await this.getProcessStartTime(pid);
      if (currentStartTime && currentStartTime === expectedStartTime) {
        return true;
      }
      return false;
    }
    const cmd = await this.getPidCommand(pid);
    if (!cmd) return false;
    if (connectionFile && cmd.includes(connectionFile)) {
      return true;
    }
    // Fallback: ensure it's an ipykernel process before killing
    return cmd.includes('ipykernel_launcher') || cmd.includes('ipykernel');
  }

  /**
   * Attempt to terminate a PID gracefully, then force kill.
   */
  private async terminatePid(pid: number): Promise<boolean> {
    if (!this.isPidAlive(pid)) return true;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Ignore kill errors
    }
    await this.sleep(500);
    if (this.isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Ignore kill errors
      }
    }
    await this.sleep(200);
    return !this.isPidAlive(pid);
  }

  private cleanupPersistedSessionArtifacts(session: PersistedSession): void {
    if (session.connectionFile && fs.existsSync(session.connectionFile)) {
      try {
        fs.unlinkSync(session.connectionFile);
      } catch {
        // Ignore delete errors
      }
    }
  }

  /**
   * Cleanup kernel resources
   */
  private cleanupKernelResources(sessionId: string): void {
    // stopKernel() already handles these, but unexpected process exits and failed startups
    // may call cleanup directly. Ensure we don't leak sockets or stale ChildProcess handles.
    this.detachProcessLifecycle(this.kernelProcesses.get(sessionId));

    // Stop the unified readers and release any waiting consumers
    this.stopIopubReader(sessionId);
    this.stopShellReader(sessionId);
    this.commStates.delete(sessionId);

    const sockets = this.zmqSockets.get(sessionId);
    if (sockets) {
      try {
        sockets.shell.close();
        sockets.iopub.close();
      } catch {
        // Ignore close errors
      }
      this.zmqSockets.delete(sessionId);
    }

    this.kernelProcesses.delete(sessionId);

    const session = this.sessions.get(sessionId);
    if (session) {
      // Remove file mapping
      if (session.filePath) {
        this.fileToSession.delete(session.filePath);
      }

      // Delete connection file
      if (session.connectionFile && fs.existsSync(session.connectionFile)) {
        try {
          fs.unlinkSync(session.connectionFile);
        } catch {
          // Ignore delete errors
        }
      }

      // Remove from sessions
      this.sessions.delete(sessionId);

      // Update persistence store
      this.sessionStore.deleteSession(sessionId);
    }

    this.executionQueues.delete(sessionId);
    this.executionQueueSizes.delete(sessionId);
    this.shellRequestQueues.delete(sessionId);
    this.cellOutputBuffers.delete(sessionId);
    this.cellOutputTracking.delete(sessionId);
    this.executingCellIds.delete(sessionId);
  }

  /**
   * Cleanup only in-memory tracking for a session (keeps connection file and session store).
   */
  private cleanupInMemorySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.filePath) {
      this.fileToSession.delete(session.filePath);
    }

    this.detachProcessLifecycle(this.kernelProcesses.get(sessionId));

    this.stopIopubReader(sessionId);
    this.stopShellReader(sessionId);
    this.commStates.delete(sessionId);

    const sockets = this.zmqSockets.get(sessionId);
    if (sockets) {
      try {
        sockets.shell.close();
        sockets.iopub.close();
      } catch {
        // Ignore close errors
      }
      this.zmqSockets.delete(sessionId);
    }

    this.sessions.delete(sessionId);
    this.kernelProcesses.delete(sessionId);
    this.executionQueues.delete(sessionId);
    this.executionQueueSizes.delete(sessionId);
    this.shellRequestQueues.delete(sessionId);
  }

  /**
   * Interrupt kernel execution
   */
  async interruptKernel(sessionId: string): Promise<boolean> {
    const proc = this.kernelProcesses.get(sessionId);
    if (proc) {
      try {
        proc.kill('SIGINT');
        return true;
      } catch {
        return false;
      }
    }

    const session = this.sessions.get(sessionId);
    const pid = session?.pid ?? null;
    if (!pid) return false;

    try {
      // Best-effort: validate PID still matches the kernel we started/reattached to.
      // This matters when a server restarts and we no longer have a ChildProcess handle.
      const persisted = this.sessionStore.getSession(sessionId);
      const expectedStartTime = persisted?.kernelStartTime ?? null;
      const connectionFile = session?.connectionFile ?? persisted?.connectionFile ?? null;
      const ok = await this.isExpectedKernelProcess(pid, connectionFile, expectedStartTime);
      if (!ok) {
        console.warn(`[Kernel] Refusing to interrupt PID ${pid} for session ${sessionId}: unexpected process`);
        return false;
      }

      process.kill(pid, 'SIGINT');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Restart a kernel (in-place, preserving session ID like Python)
   */
  async restartKernel(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    const { kernelName, filePath, connectionFile: oldConnFile } = session;

    // Set status to restarting
    session.status = 'starting';

    // Restart hygiene: drop buffered outputs from the old process (otherwise
    // stale outputs resurface on the next sync), and reset execution queues
    // so nothing chains onto promises from the old kernel. In-flight executes
    // fail when the old sockets close below; executeCode surfaces that as a
    // clean 'Kernel was restarted' error because status is 'starting'.
    this.cellOutputBuffers.delete(sessionId);
    this.cellOutputTracking.delete(sessionId);
    this.executionQueues.delete(sessionId);
    this.shellRequestQueues.delete(sessionId);

    // Stop the old kernel's readers and drop its comm state — widget
    // comms do not survive a restart. In-flight executes see their queues
    // close and fail with a clean 'Kernel was restarted' error; pending
    // shell reply waiters resolve 'closed'.
    this.stopIopubReader(sessionId);
    this.stopShellReader(sessionId);
    this.commStates.delete(sessionId);

    // Close ZeroMQ sockets
    const sockets = this.zmqSockets.get(sessionId);
    if (sockets) {
      try {
        sockets.shell.close();
        sockets.iopub.close();
      } catch {
        // Ignore close errors
      }
      this.zmqSockets.delete(sessionId);
    }

    // Kill existing kernel process
    const proc = this.kernelProcesses.get(sessionId);
    if (proc) {
      this.detachProcessLifecycle(proc);
      try {
        proc.kill('SIGTERM');
        await this.sleep(500);
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch {
        // Ignore kill errors
      }
      this.kernelProcesses.delete(sessionId);
    } else if (session.pid) {
      // Reattached session: no ChildProcess handle, but we may still have a PID.
      // Validate before terminating to avoid PID reuse mistakes.
      const persisted = this.sessionStore.getSession(sessionId);
      const expectedStartTime = persisted?.kernelStartTime ?? null;
      const connectionFile = oldConnFile ?? persisted?.connectionFile ?? null;
      const ok = await this.isExpectedKernelProcess(session.pid, connectionFile, expectedStartTime);
      if (!ok) {
        console.warn(`[Kernel] Refusing to restart PID ${session.pid} for session ${sessionId}: unexpected process`);
        session.status = 'dead';
        return false;
      }

      await this.terminatePid(session.pid);
      session.pid = null;
    }

    // Delete old connection file
    if (oldConnFile && fs.existsSync(oldConnFile)) {
      try {
        fs.unlinkSync(oldConnFile);
      } catch {
        // Ignore delete errors
      }
    }

    // Get kernel spec
    const spec = getKernelSpec(kernelName);
    if (!spec) {
      session.status = 'dead';
      return false;
    }

    try {
      // Generate new connection file (reusing same session ID)
      const { config: connConfig, filePath: connFile } = await this.generateConnectionFile(sessionId);

      // Build kernel command
      const argv = (spec.argv || []).map(arg =>
        arg.replace('{connection_file}', connFile)
      );

      // Spawn new kernel process
      const cwd = filePath ? path.dirname(filePath) : process.cwd();
      const newProc = spawn(argv[0], argv.slice(1), {
        cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Log kernel stdout/stderr
      newProc.stdout?.on('data', (data) => {
        console.log(`[Kernel ${sessionId.slice(0, 8)}] stdout: ${data.toString().trim()}`);
      });
      newProc.stderr?.on('data', (data) => {
        console.error(`[Kernel ${sessionId.slice(0, 8)}] stderr: ${data.toString().trim()}`);
      });

      // Update session in-place
      session.connectionFile = connFile;
      session.connectionConfig = connConfig;
      session.pid = newProc.pid || null;
      session.executionCount = 0;
      session.lastActivity = Date.now() / 1000;

      this.kernelProcesses.set(sessionId, newProc);

      // Handle process events
      this.attachProcessLifecycle(sessionId, newProc, session);

      // Wait for kernel to be ready
      await this.waitForReady(sessionId);

      const kernelStartTime = newProc.pid ? await this.getProcessStartTime(newProc.pid) : null;

      // Update persistence store
      this.sessionStore.saveSession({
        sessionId,
        kernelName,
        filePath,
        kernelPid: newProc.pid || null,
        serverId: this.serverId,
        serverInstanceId: this.serverInstanceId,
        kernelStartTime,
        status: 'active',
        createdAt: session.createdAt,
        lastHeartbeat: Date.now() / 1000,
        connectionFile: connFile,
        connectionConfig: JSON.stringify(session.connectionConfig),
      });

      session.status = 'idle';
      return true;
    } catch (err) {
      console.error(`Failed to restart kernel ${sessionId}:`, err);
      await this.stopKernel(sessionId).catch(() => undefined);
      return false;
    }
  }

  /**
   * Get session status
   */
  getSessionStatusFast(sessionId: string): SessionInfo | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    return {
      id: session.id,
      kernelName: session.kernelName,
      filePath: session.filePath,
      status: session.status,
      executionCount: session.executionCount,
      memoryMb: null,
      pid: session.pid,
      createdAt: session.createdAt,
    };
  }

  async getSessionStatus(sessionId: string): Promise<SessionInfo | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const memoryMap = session.pid ? await this.getProcessMemoryMap([session.pid]) : new Map();

    return {
      id: session.id,
      kernelName: session.kernelName,
      filePath: session.filePath,
      status: session.status,
      executionCount: session.executionCount,
      pid: session.pid,
      memoryMb: session.pid ? (memoryMap.get(session.pid) ?? null) : null,
      createdAt: session.createdAt,
    };
  }

  /**
   * Activity snapshot for the idle auto-release monitor (client mode):
   * whether any kernel is busy/starting, and the most recent kernel activity
   * across sessions in ms since epoch (sessions track it in seconds).
   */
  getIdleSnapshot(): { anyBusy: boolean; lastActivityMs: number | null } {
    let anyBusy = false;
    let lastActivityMs: number | null = null;
    for (const session of this.sessions.values()) {
      if (session.status === 'busy' || session.status === 'starting') anyBusy = true;
      const ms = session.lastActivity * 1000;
      if (lastActivityMs === null || ms > lastActivityMs) lastActivityMs = ms;
    }
    return { anyBusy, lastActivityMs };
  }

  /**
   * Get all sessions
   */
  async getAllSessions(): Promise<SessionInfo[]> {
    // Collect all PIDs for batch memory lookup
    const pids: number[] = [];
    for (const session of this.sessions.values()) {
      if (session.pid) pids.push(session.pid);
    }

    // Single ps call for all PIDs
    const memoryMap = await this.getProcessMemoryMap(pids);

    const sessions: SessionInfo[] = [];
    for (const [_, session] of this.sessions) {
      sessions.push({
        id: session.id,
        kernelName: session.kernelName,
        filePath: session.filePath,
        status: session.status,
        executionCount: session.executionCount,
        pid: session.pid,
        memoryMb: session.pid ? (memoryMap.get(session.pid) ?? null) : null,
        createdAt: session.createdAt,
      });
    }

    return sessions;
  }

  /**
   * Get dead sessions (orphaned or terminated) that can be cleaned up
   */
  getDeadSessions(): { sessionId: string; kernelName: string; filePath: string | null; status: string; lastHeartbeat: number }[] {
    const deadSessions = this.sessionStore.getDeadSessions(this.serverId);
    return deadSessions
      // A session that is live in memory is NOT dead — e.g. it was
      // successfully reattached (or is mid-reattach) after a server restart
      // and the DB 'orphaned' status is stale or racing the reattach loop.
      // Only sessions with no live entry (or a dead one) are true orphans.
      .filter(s => {
        const live = this.sessions.get(s.sessionId);
        return !live || live.status === 'dead';
      })
      .map(s => ({
        sessionId: s.sessionId,
        kernelName: s.kernelName,
        filePath: s.filePath,
        status: s.status,
        lastHeartbeat: s.lastHeartbeat,
      }));
  }

  /**
   * Auto-delete dead session rows whose kernel process is CONFIRMED gone
   * (no PID, PID not running, or PID reused by another process). These are
   * pure bookkeeping — nothing to kill, nothing to lose — so they need no
   * user confirmation. Rows whose PID is still alive are kept for the
   * explicit "Clean Up" flow (killing a process should stay a user action,
   * and legacy rows without a start-time fingerprint can't be verified).
   */
  async autoCleanupDeadSessions(): Promise<number> {
    const dead = this.sessionStore.getDeadSessions(this.serverId).filter(s => {
      const live = this.sessions.get(s.sessionId);
      return !live || live.status === 'dead';
    });

    const deletable: string[] = [];
    for (const s of dead) {
      if (!s.kernelPid || !this.isPidAlive(s.kernelPid)) {
        deletable.push(s.sessionId);
        continue;
      }
      if (s.kernelStartTime) {
        const currentStartTime = await this.getProcessStartTime(s.kernelPid);
        if (!currentStartTime || currentStartTime !== s.kernelStartTime) {
          // PID reused by an unrelated process — the kernel itself is gone
          deletable.push(s.sessionId);
        }
      }
    }

    if (deletable.length > 0) {
      this.sessionStore.deleteSessions(deletable);
      console.log(`[Kernel] Auto-cleaned ${deletable.length} dead session record(s) (process gone)`);
    }
    return deletable.length;
  }

  /**
   * Cleanup dead sessions by deleting them from the database
   */
  async cleanupDeadSessions(sessionIds?: string[]): Promise<number> {
    // Same live-session guard as getDeadSessions: never clean up a session
    // that is currently live in memory (e.g. reattached after a restart while
    // its DB row still says 'orphaned').
    const deadSessions = this.sessionStore.getDeadSessions(this.serverId).filter(s => {
      const live = this.sessions.get(s.sessionId);
      return !live || live.status === 'dead';
    });
    const targets = sessionIds && sessionIds.length > 0
      ? deadSessions.filter(s => sessionIds.includes(s.sessionId))
      : deadSessions;
    const deletableIds: string[] = [];

    for (const session of targets) {
      let canDelete = true;
      if (session.kernelPid && this.isPidAlive(session.kernelPid)) {
        if (!session.kernelStartTime && !this.legacyCleanupWarned.has(session.sessionId)) {
          console.warn(
            `[Kernel] Deprecated cleanup fallback for session ${session.sessionId}: kernel_start_time missing. ` +
              'This fallback will be removed after legacy sessions are cleaned up.'
          );
          this.legacyCleanupWarned.add(session.sessionId);
        }
        const expected = await this.isExpectedKernelProcess(
          session.kernelPid,
          session.connectionFile,
          session.kernelStartTime
        );
        if (!expected) {
          canDelete = false;
        } else {
          const killed = await this.terminatePid(session.kernelPid);
          if (!killed) {
            canDelete = false;
          }
        }
      }

      if (canDelete) {
        this.cleanupPersistedSessionArtifacts(session);
        deletableIds.push(session.sessionId);
      }
    }

    if (deletableIds.length === 0) {
      return 0;
    }

    return this.sessionStore.deleteSessions(deletableIds);
  }

  /**
   * Cleanup all sessions
   */
  async cleanup(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      await this.stopKernel(sessionId);
    }
    this.sessionStore.close();
  }

  /**
   * Shutdown kernel service.
   * If preserveKernels is true, keep kernel processes running and close the session store.
   */
  async shutdown(options?: { preserveKernels?: boolean }): Promise<void> {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    if (options?.preserveKernels) {
      try {
        this.sessionStore.markAllOrphaned(this.serverId, this.serverInstanceId);
      } catch {
        // Ignore errors marking orphaned
      }
      this.sessionStore.close();
      return;
    }
    await this.cleanup();
  }

  /**
   * Helper: sleep for ms milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get memory usage (RSS) for multiple processes in MB
   * Returns a map of pid -> memoryMb
   * Cross-platform: uses /proc on Linux, ps on macOS
   */
  private async getProcessMemoryMap(pids: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (pids.length === 0) return result;

    const isLinux = process.platform === 'linux';

    if (isLinux) {
      // On Linux, read directly from /proc/{pid}/statm (more reliable)
      // statm format: size resident shared text lib data dt (all in pages)
      // resident (2nd field) * page_size = RSS in bytes
      const pageSize = 4096; // Standard page size, could use os.constants.POSIX.PAGE_SIZE
      const fs = await import('fs/promises');

      await Promise.all(pids.map(async (pid) => {
        try {
          const statm = await fs.readFile(`/proc/${pid}/statm`, 'utf8');
          const fields = statm.trim().split(/\s+/);
          if (fields.length >= 2) {
            const residentPages = parseInt(fields[1], 10);
            if (!isNaN(residentPages)) {
              const rssBytes = residentPages * pageSize;
              result.set(pid, Math.round(rssBytes / 1024 / 1024 * 10) / 10);
            }
          }
        } catch {
          // Process may have exited or permission denied
        }
      }));
    } else {
      // macOS/BSD: use ps command with comma-separated PIDs
      try {
        const pidList = pids.join(',');
        const { stdout } = await execAsync(`ps -o pid=,rss= -p ${pidList}`, { timeout: 500 });

        for (const line of stdout.trim().split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) {
            const pid = parseInt(parts[0], 10);
            const rssKb = parseInt(parts[1], 10);
            if (!isNaN(pid) && !isNaN(rssKb)) {
              result.set(pid, Math.round(rssKb / 1024 * 10) / 10);
            }
          }
        }
      } catch {
        // ps command failed or timed out
      }
    }

    return result;
  }
}

// Global instance
export const kernelService = new KernelService();
