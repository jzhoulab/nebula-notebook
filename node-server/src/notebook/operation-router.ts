/**
 * Notebook Operation Router
 *
 * Routes notebook operations to either:
 * 1. Connected UI via WebSocket (real-time collaboration)
 * 2. Headless notebook manager (file-based when no UI)
 *
 * From the agent's (MCP) perspective, operations look identical regardless of mode.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { WebSocket } from 'ws';
import { HeadlessOperationHandler } from './headless-handler';
import { hashCellContent } from './cell-hash';
import { isTextNotebookPath } from '../fs/notebook-formats/registry';
import type { UpdateSummary } from './undoRedoManager';
import { classifySealedPath } from '../fs/sealed-path';

interface PendingRequest {
  resolve: (value: OperationResult) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

interface UIConnection {
  websocket: WebSocket;
  notebookPath: string;
  pendingRequests: Map<string, PendingRequest>;
  lastActivityAt: number;
}

interface KernelChangedPayload {
  kernelName: string;
  serverId?: string | null;
  // mtime (seconds) of the notebook after kernel metadata was persisted to
  // disk — lets the UI update its lastKnownMtime instead of later mistaking
  // the server-side write for an external change ("file on disk is newer").
  mtime?: number;
}

type Backend = 'ui' | 'headless';

interface OperationResult {
  success: boolean;
  error?: string;
  backend?: Backend;
  [key: string]: unknown;
}

interface AgentLock {
  agentId: string;        // Unique identifier for locking (sessionId)
  clientName?: string;    // Display name (e.g., "claude-code", "cursor")
  clientVersion?: string; // Client version
  expiresAt: number;
  notebookPath: string;
  lockedAt: number;       // When lock was first acquired
  // Collaborative session support:
  // exclusive=true reproduces the legacy behavior (UI fully locked, no OCC).
  // exclusive=false (default) leaves the user free to edit; agent writes are
  // protected by per-cell optimistic concurrency instead of the lock.
  exclusive: boolean;
  // cellId -> hash of the cell content as this agent last saw it. Populated
  // from read results and the agent's own writes; consulted to stamp write
  // operations with expectedHash for compare-and-swap at the applier.
  cellHashes: Map<string, string>;
}

const AGENT_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const UI_STALE_TIMEOUT_MS = 45 * 1000; // 45 seconds
const READ_ONLY_OPERATIONS = new Set(['readCell', 'readCellOutput', 'searchCells', 'readNotebook', 'getUpdatesSince']);

function normalizeNotebookPath(notebookPath: string): string {
  // IMPORTANT: This must match how the kernel service normalizes file paths.
  // If the UI registers `~/foo.ipynb` but the kernel associates the session
  // with `/home/user/foo.ipynb`, `hasUI()` would return false and background
  // tasks (like output persistence) can incorrectly write the file and trigger
  // spurious conflict dialogs.
  return path.resolve(notebookPath.replace(/^~/, os.homedir()));
}

export class OperationRouter {
  private uiConnections: Map<string, UIConnection> = new Map();
  private headlessHandler: HeadlessOperationHandler | null = null;
  private operationTimeout = 30000; // 30 seconds
  private agentLocks: Map<string, AgentLock> = new Map(); // path -> lock
  // Content hashes from reads that happen OUTSIDE a session (agents read to
  // orient themselves before calling start_agent_session). Seeds the session's
  // cellHashes on start so the first write doesn't hit "read it first".
  // Keyed per path — the per-notebook lock already serializes writing agents.
  private preSessionReadHashes: Map<string, Map<string, string>> = new Map();

  setHeadlessHandler(handler: HeadlessOperationHandler): void {
    this.headlessHandler = handler;
  }

  /**
   * Register a UI connection for a notebook path.
   */
  async registerUI(websocket: WebSocket, notebookPath: string): Promise<void> {
    const normalizedPath = normalizeNotebookPath(notebookPath);

    // Close existing connection if any
    if (this.uiConnections.has(normalizedPath)) {
      const oldConn = this.uiConnections.get(normalizedPath)!;
      if (oldConn.websocket !== websocket) {
        for (const [, request] of oldConn.pendingRequests) {
          clearTimeout(request.timeoutId);
          request.reject(new Error('Connection replaced'));
        }
        // Ensure the old connection doesn't later unregister the new one.
        try {
          oldConn.websocket.close(1000, 'Connection replaced');
        } catch {
          // Ignore close errors from already-closed sockets.
        }
      }
    }

    this.uiConnections.set(normalizedPath, {
      websocket,
      notebookPath: normalizedPath,
      pendingRequests: new Map(),
      lastActivityAt: Date.now(),
    });

    // The UI is now the source of truth for this notebook; any headless cache
    // is potentially stale (and would be consulted again if this connection
    // goes stale or closes).
    this.headlessHandler?.invalidate(notebookPath);
    this.headlessHandler?.invalidate(normalizedPath);

    console.log(`[OperationRouter] UI registered for: ${normalizedPath}`);
  }

  /**
   * Unregister a UI connection.
   */
  unregisterUI(websocket: WebSocket, notebookPath: string): void {
    const normalizedPath = normalizeNotebookPath(notebookPath);

    if (this.uiConnections.has(normalizedPath)) {
      const conn = this.uiConnections.get(normalizedPath)!;
      // If we replaced the UI connection and the old one closes later, ignore it.
      if (conn.websocket !== websocket) {
        return;
      }
      for (const [, request] of conn.pendingRequests) {
        clearTimeout(request.timeoutId);
        request.reject(new Error('UI disconnected'));
      }
      this.uiConnections.delete(normalizedPath);
      // Subsequent ops route headless — make sure they reload from disk (which
      // has the UI's autosaves) rather than a cache predating the UI session.
      this.headlessHandler?.invalidate(notebookPath);
      this.headlessHandler?.invalidate(normalizedPath);
      console.log(`[OperationRouter] UI unregistered for: ${normalizedPath}`);
    }
  }

  notifyKernelChanged(notebookPath: string, payload: KernelChangedPayload): void {
    const normalizedPath = normalizeNotebookPath(notebookPath);
    const conn = this.getResponsiveUIConnection(normalizedPath);
    if (!conn) {
      return;
    }

    try {
      conn.websocket.send(JSON.stringify({
        type: 'kernelChanged',
        kernelName: payload.kernelName,
        serverId: payload.serverId ?? null,
        mtime: payload.mtime,
      }));
    } catch (err) {
      console.warn(`[OperationRouter] Failed to notify UI about kernel change for ${normalizedPath}:`, err);
    }
  }

  /**
   * Check if a UI is connected for the notebook.
   */
  hasUI(notebookPath: string): boolean {
    const normalizedPath = normalizeNotebookPath(notebookPath);
    return this.getResponsiveUIConnection(normalizedPath) !== null;
  }

  /**
   * Record UI WebSocket activity so stale connections stop intercepting operations.
   */
  markUIActivity(websocket: WebSocket, notebookPath: string): void {
    const normalizedPath = normalizeNotebookPath(notebookPath);
    const conn = this.uiConnections.get(normalizedPath);
    if (!conn || conn.websocket !== websocket) {
      return;
    }
    conn.lastActivityAt = Date.now();
  }

  /**
   * Start an agent session with locking.
   * Returns success if lock acquired, error if already locked by another agent.
   */
  startAgentSession(
    notebookPath: string,
    agentId: string,
    metadata?: { clientName?: string; clientVersion?: string; exclusive?: boolean }
  ): { success: boolean; error?: string; lock?: AgentLock } {
    const normalizedPath = normalizeNotebookPath(notebookPath);
    try {
      const stat = fs.statSync(normalizedPath);
      if (!stat.isFile()) {
        return { success: false, error: `Notebook not found: ${normalizedPath}` };
      }
    } catch {
      return { success: false, error: `Notebook not found: ${normalizedPath}` };
    }

    // Clean up expired locks first
    this.cleanupExpiredLocks();

    const existingLock = this.agentLocks.get(normalizedPath);
    if (existingLock) {
      if (existingLock.agentId === agentId) {
        // Same agent re-acquiring lock - refresh timeout (and allow it to
        // upgrade/downgrade exclusivity)
        existingLock.expiresAt = Date.now() + AGENT_LOCK_TIMEOUT_MS;
        if (metadata?.exclusive !== undefined) {
          existingLock.exclusive = metadata.exclusive;
        }
        console.log(`[OperationRouter] Agent session refreshed for: ${normalizedPath} (agent: ${agentId})`);
        return { success: true, lock: existingLock };
      } else {
        // Different agent has the lock
        const lockedBy = existingLock.clientName || existingLock.agentId;
        console.log(`[OperationRouter] Agent session BLOCKED for: ${normalizedPath} (requested by: ${agentId}, held by: ${lockedBy})`);
        return {
          success: false,
          error: `Notebook is locked by ${lockedBy}. Lock expires in ${Math.ceil((existingLock.expiresAt - Date.now()) / 1000)}s.`,
          lock: existingLock,
        };
      }
    }

    // Acquire new lock — seeded with hashes from any pre-session reads, so the
    // standard orient-then-edit agent flow doesn't trip "read it first".
    const now = Date.now();
    const newLock: AgentLock = {
      agentId,
      clientName: metadata?.clientName,
      clientVersion: metadata?.clientVersion,
      expiresAt: now + AGENT_LOCK_TIMEOUT_MS,
      notebookPath: normalizedPath,
      lockedAt: now,
      exclusive: metadata?.exclusive === true,
      cellHashes: new Map(this.preSessionReadHashes.get(normalizedPath) ?? []),
    };
    this.agentLocks.set(normalizedPath, newLock);
    console.log(`[OperationRouter] Agent session started for: ${normalizedPath} (agent: ${agentId}, client: ${metadata?.clientName || 'unknown'})`);
    return { success: true, lock: newLock };
  }

  /**
   * End an agent session and release the lock.
   * Only the lock holder can release the lock.
   */
  endAgentSession(notebookPath: string, agentId: string): { success: boolean; error?: string } {
    const normalizedPath = normalizeNotebookPath(notebookPath);

    const existingLock = this.agentLocks.get(normalizedPath);
    if (!existingLock) {
      // No lock exists - that's fine
      return { success: true };
    }

    if (existingLock.agentId !== agentId) {
      console.log(`[OperationRouter] Agent session end REJECTED for: ${normalizedPath} (requested by: ${agentId}, held by: ${existingLock.agentId})`);
      return {
        success: false,
        error: 'Cannot release lock held by another agent'
      };
    }

    this.agentLocks.delete(normalizedPath);
    console.log(`[OperationRouter] Agent session ended for: ${normalizedPath} (agent: ${agentId})`);
    return { success: true };
  }

  /**
   * Check if a notebook is in an agent session.
   */
  isAgentSession(notebookPath: string): boolean {
    const normalizedPath = normalizeNotebookPath(notebookPath);
    const lock = this.agentLocks.get(normalizedPath);
    return lock !== undefined && lock.expiresAt > Date.now();
  }

  /**
   * Get the agent ID holding the lock, if any.
   */
  getAgentLock(notebookPath: string): AgentLock | null {
    const normalizedPath = normalizeNotebookPath(notebookPath);
    const lock = this.agentLocks.get(normalizedPath);
    if (lock && lock.expiresAt > Date.now()) {
      return lock;
    }
    return null;
  }

  /**
   * Refresh lock timeout for an agent operation.
   */
  refreshAgentLock(notebookPath: string, agentId: string): boolean {
    const normalizedPath = normalizeNotebookPath(notebookPath);
    const lock = this.agentLocks.get(normalizedPath);
    if (lock && lock.agentId === agentId) {
      lock.expiresAt = Date.now() + AGENT_LOCK_TIMEOUT_MS;
      return true;
    }
    return false;
  }

  /**
   * Clean up expired locks.
   */
  private cleanupExpiredLocks(): void {
    const now = Date.now();
    for (const [path, lock] of this.agentLocks) {
      if (lock.expiresAt <= now) {
        console.log(`[OperationRouter] Agent lock expired for: ${path} (agent: ${lock.agentId})`);
        this.agentLocks.delete(path);
      }
    }
  }

  /**
   * Get the first available UI connection (for operations that can use any UI).
   */
  private getAnyUIConnection(): { path: string; connection: UIConnection } | null {
    for (const [uiPath, conn] of this.uiConnections) {
      if (this.isUIConnectionResponsive(conn)) {
        return { path: uiPath, connection: conn };
      }
    }
    return null;
  }

  private isUIConnectionResponsive(conn: UIConnection): boolean {
    return conn.websocket.readyState === WebSocket.OPEN && (Date.now() - conn.lastActivityAt) <= UI_STALE_TIMEOUT_MS;
  }

  private getResponsiveUIConnection(notebookPath: string): UIConnection | null {
    const conn = this.uiConnections.get(notebookPath);
    if (!conn) {
      return null;
    }
    if (!this.isUIConnectionResponsive(conn)) {
      return null;
    }
    return conn;
  }

  /**
   * Apply a notebook operation.
   */
  async applyOperation(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = (operation.notebookPath as string) || '';
    const normalizedPath = normalizeNotebookPath(notebookPath);
    const opType = operation.type as string;
    const agentId = operation.agentId as string | undefined;

    const sealInfo = classifySealedPath(normalizedPath);
    if (sealInfo.sealed && !READ_ONLY_OPERATIONS.has(opType)) {
      return {
        success: false,
        error: `Cannot ${opType || 'modify notebook'}: sealed evidence ${sealInfo.sealId} is read-only`,
        code: 'sealed_read_only',
        seal_id: sealInfo.sealId,
        path: sealInfo.canonicalPath,
      };
    }

    // For createNotebook, route to ANY connected UI (not path-specific)
    // This allows the UI to open the new notebook in a new tab.
    // EXCEPT text notebook formats (.py/.qmd): the UI's create handler only
    // builds Jupyter JSON, so those are always created headless through the
    // format adapters.
    const isCreateNotebook = opType === 'createNotebook';
    const isTextFormatCreate = isCreateNotebook && isTextNotebookPath((operation.notebookPath as string) || '');
    const anyUI = isCreateNotebook && !isTextFormatCreate ? this.getAnyUIConnection() : null;
    const hasUI = isCreateNotebook ? (anyUI !== null) : (this.getResponsiveUIConnection(normalizedPath) !== null);
    const backend: Backend = hasUI ? 'ui' : 'headless';

    // Clean up expired locks
    this.cleanupExpiredLocks();

    const lock = this.agentLocks.get(normalizedPath);
    const isLocked = lock !== undefined && lock.expiresAt > Date.now();

    console.log(`[OperationRouter] applyOperation:`);
    console.log(`  op_type: ${opType}`);
    console.log(`  notebook_path: ${notebookPath}`);
    console.log(`  normalized_path: ${normalizedPath}`);
    console.log(`  registered_uis: ${Array.from(this.uiConnections.keys())}`);
    console.log(`  has_ui: ${hasUI}`);
    console.log(`  is_locked: ${isLocked}${lock ? ` (by: ${lock.agentId})` : ''}`);
    console.log(`  request_agent_id: ${agentId || '(none)'}`);

    // Handle startAgentSession/endAgentSession at router level (before forwarding to UI)
    // This ensures server-side lock is always managed regardless of UI connection
    if (opType === 'startAgentSession') {
      const reqAgentId = (operation.agentId as string) || 'unknown';
      const clientName = operation.clientName as string | undefined;
      const clientVersion = operation.clientVersion as string | undefined;
      const lastSessionTimestamp = operation.lastSessionTimestamp as number | undefined;
      const exclusive = operation.exclusive === true;
      const result = this.startAgentSession(notebookPath, reqAgentId, { clientName, clientVersion, exclusive });

      // Also forward to UI for UI state update (badge display)
      if (result.success && hasUI) {
        console.log(`  -> Lock acquired, forwarding to UI for badge update`);
        await this.forwardToUI(normalizedPath, operation);
      }

      // If lastSessionTimestamp provided and we have headless handler, return changes since then
      let updatesSince: UpdateSummary[] | undefined;
      if (result.success && lastSessionTimestamp !== undefined && this.headlessHandler) {
        updatesSince = this.headlessHandler.getUpdatesSince(normalizedPath, lastSessionTimestamp);
        console.log(`  -> Returning ${updatesSince.length} updates since ${new Date(lastSessionTimestamp).toISOString()}`);
      }

      return { ...result, backend, updatesSince };
    }

    if (opType === 'endAgentSession') {
      const reqAgentId = (operation.agentId as string) || 'unknown';
      const result = this.endAgentSession(notebookPath, reqAgentId);

      // Also forward to UI for UI state update (remove badge)
      if (result.success && hasUI) {
        console.log(`  -> Lock released, forwarding to UI for badge update`);
        await this.forwardToUI(normalizedPath, operation);
      }

      return { ...result, backend };
    }

    // Enforce agent session for write operations
    const sessionOps = new Set(['startAgentSession', 'endAgentSession']);
    const creationOps = new Set(['createNotebook']); // Operations that create files (don't require session)
    const isWrite = !READ_ONLY_OPERATIONS.has(opType) && !sessionOps.has(opType) && !creationOps.has(opType);
    if (isWrite) {
      if (!isLocked) {
        console.log(`  -> BLOCKED: Write requires active agent session`);
        return {
          success: false,
          error: 'Agent session required for write operations. Call startAgentSession first.',
          backend,
        };
      }
      if (!agentId) {
        console.log(`  -> BLOCKED: Missing agentId for write operation`);
        return {
          success: false,
          error: 'Agent session required for write operations (missing agentId).',
          backend,
        };
      }
      if (lock && lock.agentId !== agentId) {
        console.log(`  -> BLOCKED: Operation blocked by agent lock`);
        return {
          success: false,
          error: `Notebook is locked by another agent (${lock.agentId}). Lock expires in ${Math.ceil((lock.expiresAt - Date.now()) / 1000)}s.`,
          backend,
        };
      }
    }

    // Refresh lock timeout if this agent holds it
    if (lock && agentId && lock.agentId === agentId) {
      lock.expiresAt = Date.now() + AGENT_LOCK_TIMEOUT_MS;
    }

    // Collaborative sessions: stamp destructive writes with the content hash
    // the agent last saw, to be compared against live content at the applier
    // (the UI when connected — the only place with a freshness-window-free
    // view, since user edits reach the server only on autosave).
    if (isWrite && lock && !lock.exclusive && agentId && lock.agentId === agentId) {
      const occError = this.prepareCollaborativeWrite(lock, operation, opType);
      if (occError) {
        console.log(`  -> BLOCKED (OCC): ${occError}`);
        return { success: false, error: occError, conflict: true, backend };
      }
    }

    let result: OperationResult;
    if (hasUI) {
      // For createNotebook, use any available UI connection
      const uiPath = isCreateNotebook && anyUI ? anyUI.path : normalizedPath;
      console.log(`  -> Routing to UI (via ${uiPath})`);
      result = { ...(await this.forwardToUI(uiPath, operation)), backend: 'ui' as Backend };
    } else {
      console.log(`  -> Routing to HEADLESS`);
      result = { ...(await this.applyHeadless(operation)), backend: 'headless' as Backend };
    }

    // Keep the session's view of cell content fresh from reads and the
    // agent's own successful writes.
    if (result.success) {
      this.recordSessionHashes(normalizedPath, opType, operation, result);
    } else if (result.conflict && typeof result.currentContent === 'string' && typeof operation.cellId === 'string') {
      // Self-healing conflicts: the error hands the agent the current content,
      // so re-baseline the session to the same content. The agent's corrected
      // retry then validates against what it was just told — without this, the
      // stale stored hash rejects every retry until an explicit re-read.
      const lock2 = this.agentLocks.get(normalizedPath);
      const hashes = (lock2 && lock2.expiresAt > Date.now())
        ? lock2.cellHashes
        : this.getPreSessionStore(normalizedPath);
      hashes.set(operation.cellId, hashCellContent(result.currentContent));
    }

    return result;
  }

  /**
   * OCC preparation for a destructive write in a collaborative session.
   * Returns an error string to reject the operation, or null to proceed
   * (with `expectedHash`/`expectedHashes` stamped onto the operation).
   *
   * Policy:
   * - updateContent / updateMetadata / deleteCell / deleteCells: the agent
   *   must have read the cell this session (hash known), and the applier
   *   verifies the content still matches before applying.
   * - executeCell: verified only when the hash is known (running slightly
   *   stale content is recoverable; destroying user edits is not).
   * - clearNotebook: requires an exclusive session.
   * - Index-addressed destructive writes are rejected: user edits shift
   *   indices, so collaborative writes must address cells by id.
   */
  private prepareCollaborativeWrite(
    lock: AgentLock,
    operation: Record<string, unknown>,
    opType: string
  ): string | null {
    const requireHash = (cellId: unknown): string | null => {
      if (typeof cellId !== 'string' || !cellId) {
        return `${opType} in a collaborative session must address the cell by cell_id (indices shift when the user edits). Re-read the notebook and use ids.`;
      }
      const hash = lock.cellHashes.get(cellId);
      if (!hash) {
        return `You haven't read cell ${cellId} in this session — read it first (read_cell), then retry. In collaborative sessions the user may edit while you work.`;
      }
      return null;
    };

    switch (opType) {
      case 'updateContent':
      case 'updateMetadata':
      case 'deleteCell': {
        const cellId = operation.cellId ?? null;
        const err = requireHash(cellId);
        if (err) return err;
        operation.expectedHash = lock.cellHashes.get(cellId as string);
        return null;
      }
      case 'deleteCells': {
        const cellIds = Array.isArray(operation.cellIds) ? operation.cellIds : [];
        const hashes: Record<string, string> = {};
        for (const cellId of cellIds) {
          const err = requireHash(cellId);
          if (err) return err;
          hashes[cellId as string] = lock.cellHashes.get(cellId as string)!;
        }
        operation.expectedHashes = hashes;
        return null;
      }
      case 'executeCell': {
        const cellId = operation.cellId;
        if (typeof cellId === 'string' && lock.cellHashes.has(cellId)) {
          operation.expectedHash = lock.cellHashes.get(cellId);
        }
        return null;
      }
      case 'clearNotebook':
        return 'clearNotebook requires an exclusive session (start_agent_session with exclusive=true) — it would destroy any concurrent user edits.';
      case 'undo':
      case 'redo':
        // Content shifts unpredictably — force re-reads afterwards.
        lock.cellHashes.clear();
        return null;
      default:
        return null; // insert/move/duplicate/outputs/kernel ops: not destructive to user content
    }
  }

  /**
   * Record the session's view of cell content from operation results.
   * Keyed to the notebook's active lock: the lock guarantees a single writing
   * agent per notebook, so reads from any source refreshing it is sound.
   */
  private recordSessionHashes(
    normalizedPath: string,
    opType: string,
    operation: Record<string, unknown>,
    result: OperationResult
  ): void {
    const lock = this.agentLocks.get(normalizedPath);
    const hashes = (lock && lock.expiresAt > Date.now())
      ? lock.cellHashes
      : this.getPreSessionStore(normalizedPath); // pre-session reads arm OCC too

    const record = (cellId: unknown, content: unknown) => {
      if (typeof cellId === 'string' && typeof content === 'string') {
        hashes.set(cellId, hashCellContent(content));
      }
    };

    switch (opType) {
      case 'readCell': {
        const cell = result.cell as { id?: string; content?: string } | undefined;
        record(cell?.id, cell?.content);
        break;
      }
      case 'updateContent':
        record(operation.cellId, operation.content);
        break;
      case 'insertCell': {
        const cell = operation.cell as { content?: string } | undefined;
        record(result.cellId, cell?.content ?? '');
        break;
      }
      case 'insertCells': {
        const cells = operation.cells as Array<{ content?: string }> | undefined;
        const insertedIds = result.cellIds as string[] | undefined;
        if (cells && insertedIds && cells.length === insertedIds.length) {
          insertedIds.forEach((id, i) => record(id, cells[i]?.content ?? ''));
        }
        break;
      }
      case 'deleteCell':
        if (typeof operation.cellId === 'string') hashes.delete(operation.cellId);
        break;
      case 'deleteCells':
        if (Array.isArray(operation.cellIds)) {
          for (const id of operation.cellIds) {
            if (typeof id === 'string') hashes.delete(id);
          }
        }
        break;
      case 'clearNotebook':
        hashes.clear();
        break;
    }
  }

  /**
   * Record hashes for a full-notebook read (used by router.readNotebook,
   * which serves the MCP read_notebook tool outside applyOperation).
   */
  recordNotebookReadHashes(notebookPath: string, cells: Array<{ id?: string; content?: string }>): void {
    const normalizedPath = normalizeNotebookPath(notebookPath);
    const lock = this.agentLocks.get(normalizedPath);
    const target = (lock && lock.expiresAt > Date.now())
      ? lock.cellHashes
      : this.getPreSessionStore(normalizedPath);
    for (const cell of cells) {
      if (typeof cell?.id === 'string' && typeof cell?.content === 'string') {
        target.set(cell.id, hashCellContent(cell.content));
      }
    }
  }

  private getPreSessionStore(normalizedPath: string): Map<string, string> {
    let store = this.preSessionReadHashes.get(normalizedPath);
    if (!store) {
      store = new Map();
      this.preSessionReadHashes.set(normalizedPath, store);
      // Bound total memory: keep at most a handful of notebooks' worth.
      if (this.preSessionReadHashes.size > 16) {
        const oldest = this.preSessionReadHashes.keys().next().value;
        if (oldest && oldest !== normalizedPath) this.preSessionReadHashes.delete(oldest);
      }
    }
    return store;
  }

  private async forwardToUI(notebookPath: string, operation: Record<string, unknown>): Promise<OperationResult> {
    const conn = this.getResponsiveUIConnection(notebookPath);
    if (!conn) {
      return {
        success: false,
        error: 'UI connection is no longer responsive',
      };
    }
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Calculate timeout based on operation type
    const opType = operation.type as string;
    let timeout = this.operationTimeout;

    if (opType === 'executeCell') {
      const maxWait = ((operation.maxWait as number | undefined) ?? (operation.max_wait as number | undefined) ?? 10);
      timeout = (maxWait + 5) * 1000;
    } else if (opType === 'readCellOutput') {
      const maxWait = ((operation.maxWait as number | undefined) ?? (operation.max_wait as number | undefined) ?? 0);
      timeout = Math.max(this.operationTimeout, (maxWait + 5) * 1000);
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        // For executeCell, timeout means the cell is still running - return busy status, not error
        if (opType === 'executeCell') {
          resolve({
            success: true,
            executionStatus: 'busy',
            // Pass through the original cellId/cellIndex from the operation for polling
            cellId: operation.cellId,
            cellIndex: operation.cellIndex,
            outputs: [],
            message: `Cell still executing after ${timeout / 1000}s. Use read_output with max_wait to poll for results.`,
          });
        } else {
          resolve({
            success: false,
            error: `Operation timed out after ${timeout / 1000}s`,
          });
        }
      }, timeout);

      conn.pendingRequests.set(requestId, { resolve, reject, timeoutId });

      // Send operation to UI
      const message = {
        type: 'operation',
        operation,
        requestId,
      };

      try {
        conn.websocket.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timeoutId);
        conn.pendingRequests.delete(requestId);
        resolve({
          success: false,
          error: `Failed to forward operation to UI: ${err}`,
        });
      }
    });
  }

  /**
   * Handle operation response from UI.
   */
  handleUIResponse(notebookPath: string, response: Record<string, unknown>): void {
    const normalizedPath = normalizeNotebookPath(notebookPath);

    if (!this.getResponsiveUIConnection(normalizedPath)) {
      console.log(`[OperationRouter] Received response for unknown notebook: ${notebookPath}`);
      return;
    }

    const conn = this.getResponsiveUIConnection(normalizedPath)!;
    conn.lastActivityAt = Date.now();
    const requestId = response.requestId as string;

    if (requestId && conn.pendingRequests.has(requestId)) {
      const request = conn.pendingRequests.get(requestId)!;
      clearTimeout(request.timeoutId);
      conn.pendingRequests.delete(requestId);

      const result = (response.result as OperationResult) || { success: false, error: 'No result in response' };
      request.resolve(result);
    }
  }

  private async applyHeadless(operation: Record<string, unknown>): Promise<OperationResult> {
    if (!this.headlessHandler) {
      return {
        success: false,
        error: 'Headless manager not configured',
      };
    }

    return await this.headlessHandler.applyOperation(operation);
  }

  /**
   * Read notebook state.
   */
  async readNotebook(
    notebookPath: string,
    includeOutputs = true,
    maxLines?: number,
    maxChars?: number,
    maxLinesError?: number,
    maxCharsError?: number
  ): Promise<OperationResult> {
    const normalizedPath = normalizeNotebookPath(notebookPath);

    if (this.getResponsiveUIConnection(normalizedPath)) {
      const result = await this.readFromUI(normalizedPath);
      if (result.success) {
        const data = result.data as { cells?: Array<{ id?: string; content?: string }> } | undefined;
        if (data?.cells) this.recordNotebookReadHashes(normalizedPath, data.cells);
        const truncated = this.applyOutputTruncation(result, includeOutputs, maxLines, maxChars, maxLinesError, maxCharsError);
        if (!truncated.backend) {
          truncated.backend = 'ui' as Backend;
        }
        return truncated;
      }
      if (!result.backend) {
        result.backend = 'ui' as Backend;
      }
      return result;
    } else {
      const result = await this.readFromFile(notebookPath, includeOutputs, maxLines, maxChars, maxLinesError, maxCharsError);
      if (result.success) {
        const data = result.data as { cells?: Array<{ id?: string; content?: string }> } | undefined;
        if (data?.cells) this.recordNotebookReadHashes(normalizedPath, data.cells);
      }
      if (!result.backend) {
        result.backend = 'headless' as Backend;
      }
      return result;
    }
  }

  private async readFromUI(notebookPath: string): Promise<OperationResult> {
    const conn = this.getResponsiveUIConnection(notebookPath);
    if (!conn) {
      return this.readFromFile(notebookPath);
    }
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        console.log(`[OperationRouter] UI read timeout, falling back to file`);
        this.readFromFile(notebookPath).then(resolve);
      }, this.operationTimeout);

      conn.pendingRequests.set(requestId, {
        resolve,
        reject: (err) => resolve({ success: false, error: String(err) }),
        timeoutId,
      });

      const message = {
        type: 'readNotebook',
        requestId,
      };

      try {
        conn.websocket.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timeoutId);
        conn.pendingRequests.delete(requestId);
        resolve({
          success: false,
          error: `Failed to read from UI: ${err}`,
          backend: 'ui' as Backend,
        });
      }
    });
  }

  private async readFromFile(
    notebookPath: string,
    includeOutputs = true,
    maxLines?: number,
    maxChars?: number,
    maxLinesError?: number,
    maxCharsError?: number
  ): Promise<OperationResult> {
    if (!this.headlessHandler) {
      return {
        success: false,
        error: 'Headless manager not configured',
        backend: 'headless' as Backend,
      };
    }

    const result = await this.headlessHandler.readNotebook(
      notebookPath,
      includeOutputs,
      maxLines,
      maxChars,
      maxLinesError,
      maxCharsError
    );
    if (!result.backend) {
      result.backend = 'headless' as Backend;
    }
    return result;
  }

  private applyOutputTruncation(
    result: OperationResult,
    includeOutputs: boolean,
    maxLines?: number,
    maxChars?: number,
    maxLinesError?: number,
    maxCharsError?: number
  ): OperationResult {
    if (!result.success || !result.data) {
      return result;
    }

    const data = result.data as { cells?: unknown[] };
    const cells = data.cells || [];

    if (!includeOutputs) {
      data.cells = cells.map((cell: unknown) => ({ ...(cell as Record<string, unknown>), outputs: [] }));
      return result;
    }

    // Apply truncation defaults
    const effectiveMaxLines = maxLines ?? 100;
    const effectiveMaxChars = maxChars ?? 10000;
    const effectiveMaxLinesError = maxLinesError ?? 200;
    const effectiveMaxCharsError = maxCharsError ?? 20000;

    data.cells = cells.map((cell: unknown) => {
      const c = cell as Record<string, unknown>;
      const outputs = (c.outputs as unknown[]) || [];

      return {
        ...c,
        outputs: outputs.map((output: unknown) => {
          const o = output as Record<string, unknown>;
          const outputType = (o.type as string) || 'stdout';
          const content = (o.content as string) || '';

          if (outputType === 'image' || outputType === 'html' || outputType === 'display_data') {
            return { ...o, is_binary: outputType === 'image' };
          }

          const linesLimit = outputType === 'error' ? effectiveMaxLinesError : effectiveMaxLines;
          const charsLimit = outputType === 'error' ? effectiveMaxCharsError : effectiveMaxChars;

          const lines = content.split('\n');
          const totalLines = lines.length;
          const totalChars = content.length;

          // Match Python's truncation logic exactly
          let truncated = false;
          let truncationReason: string | null = null;
          const resultLines: string[] = [];
          let charCount = 0;
          const startLine = 0;
          let endLine = 0;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const newCharCount = charCount + line.length + (i > 0 ? 1 : 0); // +1 for newline

            if (i >= linesLimit) {
              truncated = true;
              truncationReason = 'lines';
              break;
            }

            if (newCharCount > charsLimit && i > 0) { // Always include at least 1 line
              truncated = true;
              truncationReason = 'chars';
              break;
            }

            resultLines.push(line);
            charCount = newCharCount;
            endLine = startLine + i + 1;
          }

          const truncatedContent = resultLines.join('\n');

          return {
            type: outputType,
            content: truncatedContent,
            truncated,
            truncation_reason: truncationReason,
            total_lines: totalLines,
            total_chars: totalChars,
            returned_range: {
              start_line: startLine,
              end_line: endLine,
              char_count: truncatedContent.length,
            },
          };
        }),
      };
    });

    return result;
  }
}

// Global router instance
export const operationRouter = new OperationRouter();
