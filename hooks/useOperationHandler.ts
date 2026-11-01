/**
 * Operation Handler Hook - UI-Side Agent Operation Processor
 *
 * This hook is the UI counterpart to HeadlessOperationHandler. When an agent
 * sends operations through NebulaClient, the Operation Router checks if the
 * notebook is open in a browser. If so, operations are forwarded HERE via
 * WebSocket for real-time UI updates.
 *
 * ## Architecture
 *
 * ```
 * Agent → NebulaClient → POST /api/notebook/operation
 *                                    ↓
 *                          ┌─────────────────────┐
 *                          │   Operation Router   │
 *                          └──────────┬──────────┘
 *                                     │
 *              UI Connected?  ────────┼──────── No UI?
 *                     │               │              │
 *                     ▼               │              ▼
 *    ┌─────────────────────────┐      │   ┌──────────────────────┐
 *    │  useOperationHandler    │      │   │ HeadlessOperation    │
 *    │  (this hook via WS)     │      │   │ Handler (file-based) │
 *    └─────────────────────────┘      │   └──────────────────────┘
 *              │                      │
 *              ▼                      │
 *    Apply to React state             │
 *    (insertCell, etc.)               │
 *              │                      │
 *              ▼                      │
 *    Send result back via WS ─────────┘
 * ```
 *
 * ## Responsibilities
 *
 * 1. **WebSocket Connection**: Maintains connection to `/api/notebook/{path}/ws`
 * 2. **Operation Processing**: Receives and applies operations to React state
 * 3. **Result Reporting**: Sends operation results back to router
 * 4. **UI Feedback**: Updates agent session indicator and triggers toasts
 * 5. **Notebook State**: Serves current cell state for read operations
 *
 * ## Agent Sessions
 *
 * When an agent calls `startAgentSession`, this hook:
 * - Sets `agentSession` state (shows purple badge in UI)
 * - Tracks session start time and agent ID
 * - Returns session duration on `endAgentSession`
 *
 * ## Supported Operations
 *
 * Cell: insertCell, deleteCell, updateContent, updateMetadata, moveCell,
 *       duplicateCell, updateOutputs, clearNotebook
 * Notebook: createNotebook, readCell, readCellOutput
 * Session: startAgentSession, endAgentSession
 * History: undo, redo (UI-only - requires notebook open in browser)
 *
 * ## Usage
 *
 * ```tsx
 * const {
 *   isConnected,      // WebSocket connection status
 *   activeOperation,  // Current operation being processed (for UI indicator)
 *   agentSession,     // Active session info (null if no session)
 * } = useOperationHandler({
 *   filePath,
 *   cells,
 *   insertCell,
 *   deleteCell,
 *   // ... other callbacks from useUndoRedo
 *   onAgentOperation: (op, result) => toast(`Agent: ${op.type}`)
 * });
 * ```
 *
 * @see server/headless_handler.py - Headless equivalent
 * @see docs/AGENTIC_ARCHITECTURE.md - Full system documentation
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Cell, CellType } from '../types';
import { hashCellContent } from '../lib/cellHash';
import { validateMetadataValue, CELL_METADATA_SCHEMA } from '../lib/cellMetadata';
import { authService } from '../services/authService';
import { EditSource, UpdateSummary } from './useUndoRedo';
import { withBase } from '../lib/basePath';

// Operation types (matching backend/MCP types)
export interface InsertCellOp {
  type: 'insertCell';
  notebookPath: string;
  index: number;
  cell: {
    id: string;
    type: 'code' | 'markdown';
    content: string;
    metadata?: Record<string, unknown>;
  };
}

export interface DeleteCellOp {
  type: 'deleteCell';
  notebookPath: string;
  cellId?: string;
  cellIndex?: number;
}

export interface UpdateContentOp {
  type: 'updateContent';
  notebookPath: string;
  cellId: string;
  content: string;
}

export interface UpdateMetadataOp {
  type: 'updateMetadata';
  notebookPath: string;
  cellId: string;
  changes: Record<string, unknown>;
}

export interface MoveCellOp {
  type: 'moveCell';
  notebookPath: string;
  fromIndex?: number;
  toIndex?: number;
  cellId?: string;
  afterCellId?: string;
}

export interface DeleteCellsOp {
  type: 'deleteCells';
  notebookPath: string;
  cellIds: string[];
}

export interface InsertCellsOp {
  type: 'insertCells';
  notebookPath: string;
  cells: Array<{
    id?: string;
    type?: 'code' | 'markdown';
    content: string;
  }>;
  position?: number;
}

export interface DuplicateCellOp {
  type: 'duplicateCell';
  notebookPath: string;
  cellIndex: number;
  newCellId: string;
}

export interface UpdateOutputsOp {
  type: 'updateOutputs';
  notebookPath: string;
  cellId: string;
  outputs: Array<{ type: string; content: string }>;
  executionCount?: number;
}

export interface CreateNotebookOp {
  type: 'createNotebook';
  notebookPath: string;
  overwrite?: boolean;
  kernelName?: string;
  kernelDisplayName?: string;
}

export interface ReadCellOp {
  type: 'readCell';
  notebookPath: string;
  cellId?: string;
  cellIndex?: number;
}

export interface ReadCellOutputOp {
  type: 'readCellOutput';
  notebookPath: string;
  cellId?: string;
  cellIndex?: number;
}

export interface SearchCellsOp {
  type: 'searchCells';
  notebookPath: string;
  query: string;
  includeOutputs?: boolean;
  limit?: number;
}

export interface ClearNotebookOp {
  type: 'clearNotebook';
  notebookPath: string;
}

export interface ClearOutputsOp {
  type: 'clearOutputs';
  notebookPath: string;
  cellId?: string;     // Single cell ID (for convenience)
  cellIds?: string[];  // Multiple cell IDs; if neither provided, clears all cells
}

export interface ExecuteCellOp {
  type: 'executeCell';
  notebookPath: string;
  cellId?: string;
  cellIndex?: number;
  sessionId?: string;
  maxWait?: number;
  saveOutputs?: boolean;
}

export interface StartKernelOp {
  type: 'startKernel';
  notebookPath: string;
  kernelName?: string;
}

export interface ShutdownKernelOp {
  type: 'shutdownKernel';
  notebookPath: string;
}

export interface RestartKernelOp {
  type: 'restartKernel';
  notebookPath: string;
}

export interface InterruptKernelOp {
  type: 'interruptKernel';
  notebookPath: string;
}

export interface StartAgentSessionOp {
  type: 'startAgentSession';
  notebookPath: string;
  agentId?: string;  // Optional identifier for the agent
  clientName?: string;  // e.g., "claude-code", "cursor"
  clientVersion?: string;  // Client app version
  force?: boolean;  // Force steal lock even if another session is active (use with user permission only)
}

export interface EndAgentSessionOp {
  type: 'endAgentSession';
  notebookPath: string;
}

export interface UndoOp {
  type: 'undo';
  notebookPath: string;
}

export interface RedoOp {
  type: 'redo';
  notebookPath: string;
}

export interface GetUpdatesSinceOp {
  type: 'getUpdatesSince';
  notebookPath: string;
  sinceTimestamp: number;
}

export type NotebookOperation =
  | InsertCellOp
  | DeleteCellOp
  | StartAgentSessionOp
  | EndAgentSessionOp
  | UpdateContentOp
  | UpdateMetadataOp
  | MoveCellOp
  | DeleteCellsOp
  | InsertCellsOp
  | DuplicateCellOp
  | UpdateOutputsOp
  | CreateNotebookOp
  | ReadCellOp
  | ReadCellOutputOp
  | SearchCellsOp
  | ClearNotebookOp
  | ClearOutputsOp
  | ExecuteCellOp
  | StartKernelOp
  | ShutdownKernelOp
  | RestartKernelOp
  | InterruptKernelOp
  | UndoOp
  | RedoOp
  | GetUpdatesSinceOp;

export interface OperationResult {
  success: boolean;
  cellId?: string;
  cellIndex?: number;
  fromIndex?: number;
  toIndex?: number;
  idModified?: boolean;
  requestedId?: string;
  error?: string;
  path?: string;
  mtime?: number;
  sessionId?: string;
  kernelName?: string;
  // For readCell operation
  cell?: {
    id: string;
    type: 'code' | 'markdown';
    content: string;
    outputs: Array<{ type: string; content: string }>;
    executionCount?: number;
    metadata?: Record<string, unknown>;
  };
  // For readCellOutput operation
  outputs?: Array<{ type: string; content: string }>;
  executionCount?: number;
  // For searchCells operation
  query?: string;
  matchCount?: number;
  matches?: Array<{
    cellId: string;
    cellIndex: number;
    matchLocation: 'source' | 'output';
    matchLine?: number;
    outputIndex?: number;
    outputType?: string;
    preview: string;
  }>;
  hasMore?: boolean;
  // For clearNotebook / deleteCells operations
  deletedCount?: number;
  deletedIds?: string[];
  totalCells?: number;
  // For insertCells operation
  insertedCount?: number;
  insertedIds?: string[];
  startIndex?: number;
  // For clearOutputs operation
  clearedCount?: number;
  clearedIds?: string[];
  notFound?: string[];
  // For session operations
  warning?: string;
  previousSession?: AgentSessionInfo;
  sessionDuration?: number;
  // For executeCell operation
  executionStatus?: 'idle' | 'busy' | 'error';
  executionTime?: number;
  queuePosition?: number;
  queueLength?: number;
  // For undo/redo operations
  affectedCellIds?: string[];
  operationType?: string;
  canUndo?: boolean;
  canRedo?: boolean;
  // For createNotebook operation (popup handling)
  popupBlocked?: boolean;
  popupMessage?: string;
  // For getUpdatesSince operation
  updatesSince?: UpdateSummary[];
  // Server timestamp for tracking (returned with every operation)
  serverTimestamp?: number;
}

interface OperationMessage {
  type: 'operation';
  operation: NotebookOperation;
  requestId: string;
}

interface ReadNotebookMessage {
  type: 'readNotebook';
  requestId: string;
}

interface KernelChangedMessage {
  type: 'kernelChanged';
  kernelName: string;
  serverId?: string | null;
  mtime?: number;
}

type IncomingMessage = OperationMessage | ReadNotebookMessage | KernelChangedMessage | { type: 'pong' };

/** Info about an agent operation for UI display */
export interface AgentOperationInfo {
  type: NotebookOperation['type'];
  cellIndex?: number;
  cellId?: string;
  timestamp: number;
}


/**
 * Optimistic-concurrency check for collaborative agent sessions: the router
 * stamps destructive agent writes with the content hash the agent last saw;
 * we compare against the LIVE cell content (this is the only place without
 * an autosave freshness window). Returns a conflict result or null.
 */
function occConflict(
  operation: unknown,
  cell: { id: string; content: string },
  expectedOverride?: string
): { success: false; conflict: true; error: string; currentContent: string } | null {
  const expected = expectedOverride ?? (operation as { expectedHash?: string }).expectedHash;
  if (!expected) return null;
  const content = cell.content ?? '';
  if (hashCellContent(content) === expected) return null;
  const preview = content.slice(0, 2000);
  return {
    success: false,
    conflict: true,
    error:
      `Conflict: cell ${cell.id} was modified (likely by the user) after you last read it. ` +
      `Current content:\n${preview}${content.length > 2000 ? '\n…(truncated)' : ''}\n` +
      `Re-apply your intent against this content and retry — your next write to this cell is validated against the content shown above, so no re-read is needed.`,
    currentContent: content,
  };
}

/** Info about active agent session */
export interface AgentSessionInfo {
  agentId?: string;
  clientName?: string;
  clientVersion?: string;
  startedAt: number;
  lastActivityAt: number;  // Updated on each operation
  /** true = legacy hard lock (UI read-only); false/undefined = collaborative */
  exclusive?: boolean;
}

/** Session timeout in milliseconds (5 minutes of inactivity) */
const AGENT_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

interface UseOperationHandlerOptions {
  /** Current file path (null if no file open) */
  filePath: string | null;

  /** Current cells state */
  cells: Cell[];

  /** Insert cell callback (from useUndoRedo) */
  insertCell: (index: number, cell: Cell, source?: EditSource) => void;

  /** Delete cell callback (from useUndoRedo) */
  deleteCell: (index: number, source?: EditSource) => Cell | null;

  /**
   * Clear all cells as ONE undoable batch (single Ctrl+Z restores the whole
   * notebook). Optional — without it, clearNotebook falls back to per-cell
   * deletes (N undo steps). Returns the number of cells deleted.
   */
  clearNotebookBatch?: (source?: EditSource) => number;

  /** Move cell callback (from useUndoRedo) */
  moveCell: (fromIndex: number, toIndex: number, source?: EditSource) => void;

  /** Update cell content callback (from useUndoRedo) */
  updateContent: (cellId: string, content: string, source?: EditSource) => void;

  /** Update cell content from AI callback (from useUndoRedo) */
  updateContentAI?: (cellId: string, content: string) => void;

  /** Generic metadata update callback (from useUndoRedo) - schema-driven */
  updateMetadata: (cellId: string, changes: Record<string, { old: unknown; new: unknown }>, source?: EditSource) => void;

  /** Set cell outputs callback */
  setCellOutputs?: (cellId: string, outputs: Cell['outputs'], executionCount?: number) => void;

  /** Whether a cell is queued for execution but has not started yet */
  isCellQueued?: (cellId: string) => boolean;

  /** Create notebook callback - returns promise with mtime */
  createNotebook?: (path: string, overwrite: boolean, kernelName: string, kernelDisplayName?: string) => Promise<{ success: boolean; mtime?: number; error?: string }>;

  /**
   * Execute cell callback - runs a cell and returns results
   * Returns a promise with execution result including outputs
   */
  executeCell?: (cellId: string, options?: {
    sessionId?: string;
    maxWait?: number;
    saveOutputs?: boolean;
  }) => Promise<{
    success: boolean;
    executionStatus?: 'idle' | 'busy' | 'error';
    executionCount?: number;
    executionTime?: number;
    outputs?: Array<{ type: string; content: string }>;
    sessionId?: string;
    queuePosition?: number;
    queueLength?: number;
    error?: string;
  }>;

  /** Start kernel callback (notebook-scoped) */
  startKernel?: (kernelName?: string, source?: EditSource) => Promise<{
    success: boolean;
    sessionId?: string;
    kernelName?: string;
    error?: string;
  }>;

  /** Shutdown kernel callback (notebook-scoped) */
  shutdownKernel?: (source?: EditSource) => Promise<{
    success: boolean;
    sessionId?: string;
    error?: string;
  }>;

  /** Restart kernel callback (notebook-scoped) */
  restartKernel?: (source?: EditSource) => Promise<{
    success: boolean;
    sessionId?: string;
    error?: string;
  }>;

  /** Interrupt kernel callback (notebook-scoped) */
  interruptKernel?: (source?: EditSource) => Promise<{
    success: boolean;
    sessionId?: string;
    error?: string;
  }>;

  /** Callback when backend reports a kernel change initiated outside the UI */
  onKernelChanged?: (kernelName: string, serverId?: string | null, mtime?: number) => Promise<void> | void;

  /** Callback when an agent operation is applied (for toasts/notifications) */
  onAgentOperation?: (operation: NotebookOperation, result: OperationResult) => void;

  /** Undo callback (from useUndoRedo) */
  undo?: () => { affectedCellIds: string[]; operationType: string } | null;

  /** Redo callback (from useUndoRedo) */
  redo?: () => { affectedCellIds: string[]; operationType: string } | null;

  /** Whether undo is available */
  canUndo?: boolean;

  /** Whether redo is available */
  canRedo?: boolean;

  /** Get updates since a timestamp (from useUndoRedo) */
  getUpdatesSince?: (sinceTimestamp: number) => UpdateSummary[];
}

export function useOperationHandler(options: UseOperationHandlerOptions) {
  const {
    filePath,
    cells,
    insertCell,
    deleteCell,
    moveCell,
    updateContent,
    updateContentAI,
    updateMetadata,
    setCellOutputs,
    isCellQueued,
    clearNotebookBatch,
    createNotebook,
    executeCell,
    startKernel,
    shutdownKernel,
    restartKernel,
    interruptKernel,
    onKernelChanged,
    onAgentOperation,
    undo,
    redo,
    canUndo,
    canRedo,
    getUpdatesSince,
  } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const wsEpochRef = useRef(0);
  // True when another window/page-instance took over the live connection.
  const [connectionReplaced, setConnectionReplaced] = useState(false);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const intentionalCloseRef = useRef(false); // Track if we closed intentionally
  const connectionAttemptRef = useRef(0);

  // Use refs for callbacks to avoid reconnecting when callbacks change
  const cellsRef = useRef(cells);
  const insertCellRef = useRef(insertCell);
  const deleteCellRef = useRef(deleteCell);
  const moveCellRef = useRef(moveCell);
  const updateContentRef = useRef(updateContent);
  const updateContentAIRef = useRef(updateContentAI);
  const updateMetadataRef = useRef(updateMetadata);
  const setCellOutputsRef = useRef(setCellOutputs);
  const isCellQueuedRef = useRef(isCellQueued);
  const clearNotebookBatchRef = useRef(clearNotebookBatch);
  const createNotebookRef = useRef(createNotebook);
  const executeCellRef = useRef(executeCell);
  const startKernelRef = useRef(startKernel);
  const shutdownKernelRef = useRef(shutdownKernel);
  const restartKernelRef = useRef(restartKernel);
  const interruptKernelRef = useRef(interruptKernel);
  const onKernelChangedRef = useRef(onKernelChanged);
  const onAgentOperationRef = useRef(onAgentOperation);
  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  const canUndoRef = useRef(canUndo);
  const canRedoRef = useRef(canRedo);
  const getUpdatesSinceRef = useRef(getUpdatesSince);

  // Update refs on each render
  cellsRef.current = cells;
  insertCellRef.current = insertCell;
  deleteCellRef.current = deleteCell;
  moveCellRef.current = moveCell;
  updateContentRef.current = updateContent;
  updateContentAIRef.current = updateContentAI;
  updateMetadataRef.current = updateMetadata;
  setCellOutputsRef.current = setCellOutputs;
  isCellQueuedRef.current = isCellQueued;
  clearNotebookBatchRef.current = clearNotebookBatch;
  createNotebookRef.current = createNotebook;
  executeCellRef.current = executeCell;
  startKernelRef.current = startKernel;
  shutdownKernelRef.current = shutdownKernel;
  restartKernelRef.current = restartKernel;
  interruptKernelRef.current = interruptKernel;
  onKernelChangedRef.current = onKernelChanged;
  onAgentOperationRef.current = onAgentOperation;
  undoRef.current = undo;
  redoRef.current = redo;
  canUndoRef.current = canUndo;
  canRedoRef.current = canRedo;
  getUpdatesSinceRef.current = getUpdatesSince;

  const [isConnected, setIsConnected] = useState(false);
  const [activeOperation, setActiveOperation] = useState<AgentOperationInfo | null>(null);
  const [agentSession, setAgentSessionState] = useState<AgentSessionInfo | null>(null);
  const agentSessionRef = useRef<AgentSessionInfo | null>(null);

  // Helper to update both ref and state for agentSession
  const setAgentSession = useCallback((session: AgentSessionInfo | null) => {
    agentSessionRef.current = session;
    setAgentSessionState(session);
  }, []);

  /**
   * Check if a cell ID is unique
   */
  const isIdUnique = useCallback((id: string): boolean => {
    return !cellsRef.current.some(c => c.id === id);
  }, []);

  /**
   * Generate a unique ID by appending suffix if needed
   */
  const makeUniqueId = useCallback((baseId: string): string => {
    if (isIdUnique(baseId)) return baseId;
    let suffix = 2;
    while (!isIdUnique(`${baseId}-${suffix}`)) suffix++;
    return `${baseId}-${suffix}`;
  }, [isIdUnique]);

  const getVisibleOutputs = useCallback((cell: Cell): Cell['outputs'] => {
    if (cell.pendingOutputReset) {
      return [];
    }
    return cell.outputs;
  }, []);

  /**
   * Apply an operation and return the result
   */
  const applyOperation = useCallback(async (operation: NotebookOperation): Promise<OperationResult> => {
    const currentCells = cellsRef.current;

    try {
      switch (operation.type) {
        case 'insertCell': {
          const { index, cell } = operation;
          let cellId = cell.id;
          let idModified = false;

          // Check for duplicate ID
          if (!isIdUnique(cellId)) {
            const originalId = cellId;
            cellId = makeUniqueId(cellId);
            idModified = true;
          }

          // Create the new cell
          const newCell: Cell = {
            id: cellId,
            type: cell.type,
            content: cell.content,
            outputs: [],
            isExecuting: false,
            scrolled: cell.metadata?.scrolled as boolean | undefined,
            scrolledHeight: cell.metadata?.scrolledHeight as number | undefined,
          };

          // Calculate actual index
          const actualIndex = index === -1 || index >= currentCells.length
            ? currentCells.length
            : index;

          insertCellRef.current(actualIndex, newCell, 'ai');

          // Update cellsRef immediately to avoid stale reads before re-render
          const updatedCells = [...currentCells];
          updatedCells.splice(actualIndex, 0, newCell);
          cellsRef.current = updatedCells;

          return {
            success: true,
            cellId,
            cellIndex: actualIndex,
            idModified,
            requestedId: idModified ? cell.id : undefined,
          };
        }

        case 'deleteCell': {
          const { cellId, cellIndex } = operation;

          let targetIndex: number | undefined;

          if (cellId) {
            targetIndex = currentCells.findIndex(c => c.id === cellId);
            if (targetIndex === -1) {
              return { success: false, error: `Cell with ID "${cellId}" not found` };
            }
          } else if (cellIndex !== undefined) {
            if (cellIndex < 0 || cellIndex >= currentCells.length) {
              return { success: false, error: `Cell index ${cellIndex} out of range` };
            }
            targetIndex = cellIndex;
          } else {
            return { success: false, error: 'Must provide cellId or cellIndex' };
          }

          {
            const conflict = occConflict(operation, currentCells[targetIndex]);
            if (conflict) return conflict;
          }

          deleteCellRef.current(targetIndex, 'ai');

          // Update cellsRef immediately to avoid stale reads before re-render
          cellsRef.current = currentCells.filter((_, i) => i !== targetIndex);

          return { success: true, cellIndex: targetIndex };
        }

        case 'updateContent': {
          const { cellId, content } = operation;

          const cell = currentCells.find(c => c.id === cellId);
          if (!cell) {
            return { success: false, error: `Cell with ID "${cellId}" not found` };
          }

          const conflict = occConflict(operation, cell);
          if (conflict) return conflict;

          // Use AI update function if available (marks operation source)
          if (updateContentAIRef.current) {
            updateContentAIRef.current(cellId, content);
          } else {
            updateContentRef.current(cellId, content);
          }

          return {
            success: true,
            cellId,
            cellIndex: currentCells.findIndex(c => c.id === cellId),
          };
        }

        case 'updateMetadata': {
          const { cellId, changes } = operation;

          const cellIndex = currentCells.findIndex(c => c.id === cellId);
          if (cellIndex === -1) {
            return { success: false, error: `Cell with ID "${cellId}" not found` };
          }

          const cell = currentCells[cellIndex];

          const conflict = occConflict(operation, cell);
          if (conflict) return conflict;

          // Validate all changes against schema before applying any
          const errors: string[] = [];
          for (const [key, value] of Object.entries(changes)) {
            const validation = validateMetadataValue(key, value);
            if (!validation.valid) {
              errors.push(validation.error!);
            }
          }
          if (errors.length > 0) {
            return { success: false, error: errors.join('; ') };
          }

          let actualId = cellId;
          if ('id' in changes) {
            const requestedId = changes.id as string;
            if (requestedId !== cellId) {
              const existingIds = new Set(currentCells.map(c => c.id));
              existingIds.delete(cellId);
              let resolvedId = requestedId;
              if (existingIds.has(resolvedId)) {
                let counter = 2;
                while (existingIds.has(`${resolvedId}-${counter}`)) {
                  counter++;
                }
                resolvedId = `${resolvedId}-${counter}`;
              }
              actualId = resolvedId;
            }
          }

          // Convert operation format { key: value } to MetadataChanges format { key: { old, new } }
          // Schema validation passed, so all keys are valid
          const metadataChanges: Record<string, { old: unknown; new: unknown }> = {};
          for (const [key, newValue] of Object.entries(changes)) {
            const oldValue = (cell as unknown as Record<string, unknown>)[key];
            if (key === 'id') {
              if (actualId !== cellId) {
                metadataChanges[key] = { old: oldValue, new: actualId };
              }
              continue;
            }
            metadataChanges[key] = { old: oldValue, new: newValue };
          }

          // Apply all changes through the generic updateMetadata callback
          if (Object.keys(metadataChanges).length > 0) {
            updateMetadataRef.current(cellId, metadataChanges, 'ai');
          }

          return {
            success: true,
            cellId: actualId,
            cellIndex,
          };
        }

        case 'moveCell': {
          const { fromIndex, toIndex, cellId, afterCellId } = operation;
          let resolvedFrom = fromIndex;
          let resolvedTo = toIndex;

          if (cellId) {
            resolvedFrom = currentCells.findIndex(c => c.id === cellId);
            if (resolvedFrom === -1) {
              return { success: false, error: `Cell with ID "${cellId}" not found` };
            }
          } else if (resolvedFrom === undefined) {
            return { success: false, error: 'Must provide cellId or fromIndex' };
          }

          if (resolvedFrom < 0 || resolvedFrom >= currentCells.length) {
            return { success: false, error: `Source index ${resolvedFrom} out of range` };
          }

          if (afterCellId) {
            const afterIndex = currentCells.findIndex(c => c.id === afterCellId);
            if (afterIndex === -1) {
              return { success: false, error: `Cell with ID "${afterCellId}" not found` };
            }
            resolvedTo = afterIndex + 1;
            if (resolvedFrom < resolvedTo) {
              resolvedTo -= 1;
            }
          } else if (resolvedTo === -1) {
            resolvedTo = 0;
          } else if (resolvedTo === undefined) {
            return { success: false, error: 'Must provide afterCellId or toIndex' };
          }

          if (resolvedTo < 0 || resolvedTo >= currentCells.length) {
            return { success: false, error: `Target index ${resolvedTo} out of range` };
          }

          moveCellRef.current(resolvedFrom, resolvedTo, 'ai');

          return {
            success: true,
            cellId: cellId ?? currentCells[resolvedFrom]?.id,
            fromIndex: resolvedFrom,
            toIndex: resolvedTo,
          };
        }

        case 'deleteCells': {
          const { cellIds } = operation;

          if (!cellIds || cellIds.length === 0) {
            return { success: false, error: 'No cell IDs provided' };
          }

          const deletedIds: string[] = [];
          const notFound: string[] = [];
          const indicesToDelete = new Set<number>();

          for (const cellId of cellIds) {
            const idx = currentCells.findIndex(c => c.id === cellId);
            if (idx !== -1) {
              indicesToDelete.add(idx);
              deletedIds.push(cellId);
            } else {
              notFound.push(cellId);
            }
          }

          // OCC: verify every target cell before deleting any (all-or-nothing)
          const expectedHashes = (operation as unknown as { expectedHashes?: Record<string, string> }).expectedHashes;
          if (expectedHashes) {
            for (const idx of indicesToDelete) {
              const target = currentCells[idx];
              const conflict = occConflict(operation, target, expectedHashes[target.id]);
              if (conflict) return conflict;
            }
          }

          // Delete in reverse order to avoid index shifts
          const sortedIndices = Array.from(indicesToDelete).sort((a, b) => b - a);
          for (const idx of sortedIndices) {
            deleteCellRef.current(idx, 'ai');
          }

          const updatedCells = currentCells.filter((_, i) => !indicesToDelete.has(i));
          cellsRef.current = updatedCells;

          return {
            success: true,
            deletedCount: deletedIds.length,
            deletedIds,
            notFound: notFound.length > 0 ? notFound : undefined,
            totalCells: updatedCells.length,
          };
        }

        case 'insertCells': {
          const { cells: newCells = [], position = -1 } = operation;

          if (!newCells || newCells.length === 0) {
            return { success: false, error: 'No cells provided' };
          }

          const usedIds = new Set(currentCells.map(c => c.id));
          const insertedIds: string[] = [];
          const baseIndex = position < 0 || position >= currentCells.length
            ? currentCells.length
            : position;

          const updatedCells = [...currentCells];

          for (let i = 0; i < newCells.length; i += 1) {
            const cellData = newCells[i];
            const baseId = cellData.id || `cell-${Date.now()}-${i}`;
            let cellId = baseId;
            if (usedIds.has(cellId)) {
              let counter = 2;
              while (usedIds.has(`${cellId}-${counter}`)) {
                counter++;
              }
              cellId = `${cellId}-${counter}`;
            }
            usedIds.add(cellId);
            const newCell: Cell = {
              id: cellId,
              type: (cellData.type || 'code') as 'code' | 'markdown',
              content: cellData.content,
              outputs: [],
              isExecuting: false,
            };

            const insertIndex = baseIndex + i;
            insertCellRef.current(insertIndex, newCell, 'ai');
            updatedCells.splice(insertIndex, 0, newCell);
            insertedIds.push(cellId);
          }

          cellsRef.current = updatedCells;

          return {
            success: true,
            insertedCount: insertedIds.length,
            insertedIds,
            startIndex: baseIndex,
            totalCells: updatedCells.length,
          };
        }

        case 'duplicateCell': {
          const { cellIndex, newCellId } = operation;

          if (cellIndex < 0 || cellIndex >= currentCells.length) {
            return { success: false, error: `Cell index ${cellIndex} out of range` };
          }

          const originalCell = currentCells[cellIndex];
          let actualId = newCellId;
          let idModified = false;

          if (!isIdUnique(actualId)) {
            const originalId = actualId;
            actualId = makeUniqueId(actualId);
            idModified = true;
          }

          const newCell: Cell = {
            id: actualId,
            type: originalCell.type,
            content: originalCell.content,
            outputs: [], // Don't copy outputs
            isExecuting: false,
          };

          insertCellRef.current(cellIndex + 1, newCell);

          return {
            success: true,
            cellId: actualId,
            cellIndex: cellIndex + 1,
            idModified,
            requestedId: idModified ? newCellId : undefined,
          };
        }

        case 'updateOutputs': {
          const { cellId, outputs, executionCount } = operation;

          const cell = currentCells.find(c => c.id === cellId);
          if (!cell) {
            return { success: false, error: `Cell with ID "${cellId}" not found` };
          }

          // Convert output format (add required id and timestamp)
          const cellOutputs: Cell['outputs'] = outputs.map((o, i) => ({
            id: `${cellId}-output-${i}-${Date.now()}`,
            type: o.type as Cell['outputs'][0]['type'],
            content: o.content,
            timestamp: Date.now(),
          }));

          if (setCellOutputsRef.current) {
            setCellOutputsRef.current(cellId, cellOutputs, executionCount);
          }

          return {
            success: true,
            cellId,
            cellIndex: currentCells.findIndex(c => c.id === cellId),
          };
        }

        case 'clearOutputs': {
          const { cellId, cellIds = [] } = operation;

          // Support both single ID and list of IDs
          const targetIds = cellId && cellIds.length === 0 ? [cellId] : cellIds;
          const clearedIds: string[] = [];
          const notFound: string[] = [];

          if (targetIds.length === 0) {
            // Clear all cells if no IDs specified
            for (const cell of currentCells) {
              if (cell.outputs.length > 0 && setCellOutputsRef.current) {
                setCellOutputsRef.current(cell.id, [], undefined);
                clearedIds.push(cell.id);
              }
            }
          } else {
            // Clear specific cells
            for (const cid of targetIds) {
              const cell = currentCells.find(c => c.id === cid);
              if (cell) {
                if (setCellOutputsRef.current) {
                  setCellOutputsRef.current(cid, [], undefined);
                }
                clearedIds.push(cid);
              } else {
                notFound.push(cid);
              }
            }
          }

          return {
            success: true,
            clearedCount: clearedIds.length,
            clearedIds,
            notFound: notFound.length > 0 ? notFound : undefined,
          };
        }

        case 'createNotebook': {
          const {
            notebookPath,
            overwrite = false,
            kernelName = 'python3',
            kernelDisplayName,
          } = operation;

          if (!createNotebookRef.current) {
            return { success: false, error: 'createNotebook callback not provided' };
          }

          const result = await createNotebookRef.current(notebookPath, overwrite, kernelName, kernelDisplayName);

          // If creation succeeded, try to open in a new tab
          let popupBlocked = false;
          let popupMessage: string | undefined;

          if (result.success) {
            const newTabUrl = `${window.location.origin}${withBase(`/?file=${encodeURIComponent(notebookPath)}`)}`;
            const popup = window.open(newTabUrl, '_blank');

            if (!popup || popup.closed || typeof popup.closed === 'undefined') {
              popupBlocked = true;
              popupMessage = `Notebook created at ${notebookPath}. To open it automatically, please allow popups for this site.`;
            }
          }

          return {
            success: result.success,
            path: notebookPath,
            mtime: result.mtime,
            error: result.error,
            popupBlocked,
            popupMessage,
          };
        }

        case 'readCell': {
          const { cellId, cellIndex } = operation;

          let cell: Cell | undefined;
          let targetIndex: number | undefined;

          if (cellId) {
            targetIndex = currentCells.findIndex(c => c.id === cellId);
            if (targetIndex === -1) {
              return { success: false, error: `Cell with ID "${cellId}" not found` };
            }
            cell = currentCells[targetIndex];
          } else if (cellIndex !== undefined) {
            if (cellIndex < 0 || cellIndex >= currentCells.length) {
              return { success: false, error: `Cell index ${cellIndex} out of range` };
            }
            targetIndex = cellIndex;
            cell = currentCells[cellIndex];
          } else {
            return { success: false, error: 'Must provide cellId or cellIndex' };
          }

          return {
            success: true,
            cellId: cell.id,
            cellIndex: targetIndex,
            cell: {
              id: cell.id,
              type: cell.type,
              content: cell.content,
              outputs: cell.outputs.map(o => ({ type: o.type, content: o.content })),
              executionCount: cell.executionCount,
              metadata: {
                scrolled: cell.scrolled,
                scrolledHeight: cell.scrolledHeight,
              },
            },
          };
        }

        case 'readCellOutput': {
          const { cellId, cellIndex } = operation as ReadCellOutputOp;
          const maxWait = (operation as any).maxWait ?? (operation as any).max_wait ?? 0;

          let targetIndex: number | undefined;
          let targetCellId: string | undefined;

          if (cellId) {
            targetIndex = currentCells.findIndex(c => c.id === cellId);
            if (targetIndex === -1) {
              return { success: false, error: `Cell with ID "${cellId}" not found` };
            }
            targetCellId = cellId;
          } else if (cellIndex !== undefined) {
            if (cellIndex < 0 || cellIndex >= currentCells.length) {
              return { success: false, error: `Cell index ${cellIndex} out of range` };
            }
            targetIndex = cellIndex;
            targetCellId = currentCells[cellIndex].id;
          } else {
            return { success: false, error: 'Must provide cellId or cellIndex' };
          }

          // If maxWait > 0, poll for new outputs
          let cell = currentCells[targetIndex];
          if (maxWait > 0) {
            let visibleOutputs = getVisibleOutputs(cell);
            let baselineOutputCount = visibleOutputs.length;
            let baselineOutputChars = visibleOutputs.reduce((sum, o) => sum + o.content.length, 0);
            let baselineExecutionCount = cell.executionCount;
            let baselineLastExecutionMs = cell.lastExecutionMs;
            let wasExecuting = !!cell.isExecuting;
            const startTime = Date.now();
            const pollInterval = 500; // 500ms

            while (Date.now() - startTime < maxWait * 1000) {
              await new Promise(resolve => setTimeout(resolve, pollInterval));
              // Re-read from current ref (cells may have updated)
              const updatedCells = cellsRef.current;
              const idx = targetCellId ? updatedCells.findIndex(c => c.id === targetCellId) : targetIndex;
              if (idx === undefined || idx === -1 || idx >= updatedCells.length) {
                return { success: false, error: `Cell with ID "${targetCellId || '(unknown)'}" not found` };
              }
              targetIndex = idx;
              cell = updatedCells[idx];
              if (!wasExecuting && cell.isExecuting) {
                // Execution started after we began polling (e.g. queued). Reset baseline so we
                // wait for outputs from this run rather than comparing against previous outputs.
                wasExecuting = true;
                visibleOutputs = getVisibleOutputs(cell);
                baselineOutputCount = visibleOutputs.length;
                baselineOutputChars = visibleOutputs.reduce((sum, o) => sum + o.content.length, 0);
                baselineExecutionCount = cell.executionCount;
                baselineLastExecutionMs = cell.lastExecutionMs;
              }
              visibleOutputs = getVisibleOutputs(cell);
              const currentOutputCount = visibleOutputs.length;
              const currentOutputChars = visibleOutputs.reduce((sum, o) => sum + o.content.length, 0);
              const executionCountChanged = cell.executionCount !== baselineExecutionCount;
              const lastExecutionChanged = cell.lastExecutionMs !== baselineLastExecutionMs;
              const isQueued = !!isCellQueuedRef.current?.(cell.id);

              // Check if outputs changed
              if (
                currentOutputCount > baselineOutputCount ||
                currentOutputChars > baselineOutputChars ||
                executionCountChanged ||
                lastExecutionChanged
              ) {
                break; // New output arrived
              }

              if (wasExecuting && !cell.isExecuting) {
                break; // Execution completed without new output
              }

              // If the cell is already idle and not queued, there is nothing left to wait for.
              if (!wasExecuting && !cell.isExecuting && !isQueued) {
                break;
              }
            }
          }

          return {
            success: true,
            cellId: cell.id,
            cellIndex: targetIndex,
            outputs: getVisibleOutputs(cell).map(o => ({ type: o.type, content: o.content })),
            executionCount: cell.executionCount,
          };
        }

        case 'searchCells': {
          const { query, includeOutputs = false, limit = 10 } = operation as SearchCellsOp;

          if (!query) {
            return { success: false, error: 'No search query provided' };
          }

          const queryLower = query.toLowerCase();
          const matches: NonNullable<OperationResult['matches']> = [];

          for (let i = 0; i < currentCells.length && matches.length < limit; i++) {
            const cell = currentCells[i];
            const content = cell.content || '';

            if (content.toLowerCase().includes(queryLower)) {
              const lines = content.split('\n');
              let matchLine: number | null = null;
              for (let j = 0; j < lines.length; j++) {
                if (lines[j].toLowerCase().includes(queryLower)) {
                  matchLine = j;
                  break;
                }
              }

              matches.push({
                cellId: cell.id,
                cellIndex: i,
                matchLocation: 'source',
                matchLine: matchLine ?? undefined,
                preview: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
              });
            }

            if (includeOutputs) {
              for (let j = 0; j < (cell.outputs || []).length; j++) {
                const output = cell.outputs[j];
                const outContent = output.content || '';
                if (outContent.toLowerCase().includes(queryLower)) {
                  matches.push({
                    cellId: cell.id,
                    cellIndex: i,
                    matchLocation: 'output',
                    outputIndex: j,
                    outputType: output.type || 'unknown',
                    preview: outContent.slice(0, 200) + (outContent.length > 200 ? '...' : ''),
                  });
                }
              }
            }
          }

          return {
            success: true,
            query,
            matchCount: matches.length,
            matches: matches.slice(0, limit),
            hasMore: matches.length > limit,
          };
        }

        case 'clearNotebook': {
          const deletedCount = currentCells.length;

          if (deletedCount === 0) {
            return { success: true, deletedCount: 0 };
          }

          if (clearNotebookBatchRef.current) {
            // One undoable batch — a single Ctrl+Z restores the whole notebook
            clearNotebookBatchRef.current('ai');
          } else {
            // Fallback: delete from end to start to avoid index shifting issues
            for (let i = currentCells.length - 1; i >= 0; i--) {
              deleteCellRef.current(i);
            }
          }

          // Update cellsRef immediately to avoid stale reads before re-render
          cellsRef.current = [];

          return { success: true, deletedCount };
        }

        case 'startAgentSession': {
          const { agentId, clientName, clientVersion, force } = operation as StartAgentSessionOp;
          const exclusive = (operation as unknown as { exclusive?: boolean }).exclusive === true;
          const now = Date.now();

          // Check if there's already an active session
          if (agentSessionRef.current) {
            if (force) {
              // Force steal the lock - end previous session and start new one
              console.warn('[OperationHandler] Force-ending previous agent session');
              const previousSession = agentSessionRef.current;
              setAgentSession({
                agentId,
                clientName,
                clientVersion,
                startedAt: now,
                lastActivityAt: now,
                exclusive,
              });
              return {
                success: true,
                warning: `Forcibly ended previous session from ${previousSession.clientName || 'unknown agent'}.`,
              };
            }
            console.warn('[OperationHandler] Starting new agent session without ending previous one');
            return {
              success: true,
              warning: 'Previous session was not ended. Starting new session.',
              previousSession: agentSessionRef.current,
            };
          }

          setAgentSession({
            agentId,
            clientName,
            clientVersion,
            startedAt: now,
            lastActivityAt: now,
            exclusive,
          });

          return { success: true };
        }

        case 'endAgentSession': {
          if (!agentSessionRef.current) {
            return { success: true, warning: 'No active session to end' };
          }

          const sessionDuration = Date.now() - agentSessionRef.current.startedAt;
          setAgentSession(null);

          return { success: true, sessionDuration };
        }

        case 'startKernel': {
          if (!startKernelRef.current) {
            return { success: false, error: 'startKernel callback not provided - UI cannot start kernel' };
          }

          const result = await startKernelRef.current(operation.kernelName, 'mcp');
          return {
            success: result.success,
            sessionId: result.sessionId,
            kernelName: result.kernelName,
            error: result.error,
          };
        }

        case 'shutdownKernel': {
          if (!shutdownKernelRef.current) {
            return { success: false, error: 'shutdownKernel callback not provided - UI cannot shutdown kernel' };
          }

          const result = await shutdownKernelRef.current('mcp');
          return {
            success: result.success,
            sessionId: result.sessionId,
            error: result.error,
          };
        }

        case 'restartKernel': {
          if (!restartKernelRef.current) {
            return { success: false, error: 'restartKernel callback not provided - UI cannot restart kernel' };
          }

          const result = await restartKernelRef.current('mcp');
          return {
            success: result.success,
            sessionId: result.sessionId,
            error: result.error,
          };
        }

        case 'interruptKernel': {
          if (!interruptKernelRef.current) {
            return { success: false, error: 'interruptKernel callback not provided - UI cannot interrupt kernel' };
          }

          const result = await interruptKernelRef.current('mcp');
          return {
            success: result.success,
            sessionId: result.sessionId,
            error: result.error,
          };
        }

        case 'executeCell': {
          const cellId = (operation as any).cellId ?? (operation as any).cell_id;
          const cellIndex = (operation as any).cellIndex ?? (operation as any).cell_index;
          const sessionId = (operation as any).sessionId ?? (operation as any).session_id;
          const maxWait = (operation as any).maxWait ?? (operation as any).max_wait;
          const saveOutputs = (operation as any).saveOutputs ?? (operation as any).save_outputs;

          // Find the cell
          let targetIndex: number | undefined;
          let targetCellId: string | undefined;

          if (cellId) {
            targetIndex = currentCells.findIndex(c => c.id === cellId);
            if (targetIndex === -1) {
              return { success: false, error: `Cell with ID "${cellId}" not found` };
            }
            targetCellId = cellId;
          } else if (cellIndex !== undefined) {
            if (cellIndex < 0 || cellIndex >= currentCells.length) {
              return { success: false, error: `Cell index ${cellIndex} out of range` };
            }
            targetIndex = cellIndex;
            targetCellId = currentCells[cellIndex].id;
          } else {
            return { success: false, error: 'Must provide cellId or cellIndex' };
          }

          {
            const conflict = occConflict(operation, currentCells[targetIndex!]);
            if (conflict) return conflict;
          }

          // Check if executeCell callback is available
          if (!executeCellRef.current) {
            return { success: false, error: 'executeCell callback not provided - UI cannot execute cells' };
          }

          // Execute the cell through the UI's execution mechanism
          const result = await executeCellRef.current(targetCellId!, {
            sessionId,
            maxWait,
            saveOutputs,
          });

          return {
            success: result.success,
            cellId: targetCellId,
            cellIndex: targetIndex,
            executionStatus: result.executionStatus,
            executionCount: result.executionCount,
            executionTime: result.executionTime,
            outputs: result.outputs,
            sessionId: result.sessionId,
            queuePosition: result.queuePosition,
            queueLength: result.queueLength,
            error: result.error,
          };
        }

        case 'undo': {
          if (!undoRef.current) {
            return { success: false, error: 'Undo not available (callback not provided)' };
          }

          const result = undoRef.current();
          if (!result) {
            return {
              success: false,
              error: 'Nothing to undo',
              canUndo: false,
              canRedo: canRedoRef.current ?? false,
            };
          }

          return {
            success: true,
            affectedCellIds: result.affectedCellIds,
            operationType: result.operationType,
            canUndo: canUndoRef.current ?? false,
            canRedo: true, // After undo, redo is always available
          };
        }

        case 'redo': {
          if (!redoRef.current) {
            return { success: false, error: 'Redo not available (callback not provided)' };
          }

          const result = redoRef.current();
          if (!result) {
            return {
              success: false,
              error: 'Nothing to redo',
              canUndo: canUndoRef.current ?? false,
              canRedo: false,
            };
          }

          return {
            success: true,
            affectedCellIds: result.affectedCellIds,
            operationType: result.operationType,
            canUndo: true, // After redo, undo is always available
            canRedo: canRedoRef.current ?? false,
          };
        }

        case 'getUpdatesSince': {
          const { sinceTimestamp } = operation as GetUpdatesSinceOp;

          if (!getUpdatesSinceRef.current) {
            return {
              success: true,
              updatesSince: [],
              serverTimestamp: Date.now(),
            };
          }

          const updates = getUpdatesSinceRef.current(sinceTimestamp);
          return {
            success: true,
            updatesSince: updates,
            serverTimestamp: Date.now(),
          };
        }

        default:
          return { success: false, error: `Unknown operation type: ${(operation as any).type}` };
      }
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }, [getVisibleOutputs, isIdUnique, makeUniqueId]);

  /**
   * Handle incoming WebSocket message
   */
  const handleMessage = useCallback(async (data: IncomingMessage) => {
    if (data.type === 'pong') {
      // Keep-alive response, ignore
      return;
    }

    if (data.type === 'kernelChanged') {
      await onKernelChangedRef.current?.(data.kernelName, data.serverId, (data as { mtime?: number }).mtime);
      return;
    }

    if (data.type === 'operation') {
      const { operation, requestId } = data;

      // Extract cell info for UI display
      const cellIndex = 'cellIndex' in operation ? operation.cellIndex :
                        'index' in operation ? operation.index : undefined;
      const cellId = 'cellId' in operation ? operation.cellId :
                     'cell' in operation ? (operation as InsertCellOp).cell.id : undefined;

      // Skip noisy polling operations from UI indicator (readCellOutput polls repeatedly)
      const isNoisyOperation = operation.type === 'readCellOutput';

      if (!isNoisyOperation) {
        // Set active operation for UI indicator
        setActiveOperation({
          type: operation.type,
          cellIndex,
          cellId,
          timestamp: Date.now(),
        });
      }

      const result = await applyOperation(operation);

      // Update session activity timestamp on operations (keeps session alive)
      // Skip for session management and read-only operations
      const isSessionOp = operation.type === 'startAgentSession' || operation.type === 'endAgentSession';
      const isReadOnlyOp = operation.type === 'readCell' || operation.type === 'readCellOutput' ||
                          operation.type === 'searchCells' || operation.type === 'getUpdatesSince';
      if (agentSessionRef.current && !isSessionOp && !isReadOnlyOp) {
        agentSessionRef.current.lastActivityAt = Date.now();
      }

      // Clear active operation after a brief delay (for visual feedback)
      if (!isNoisyOperation) {
        setTimeout(() => setActiveOperation(null), 300);
      }

      // Call the notification callback if provided
      if (onAgentOperationRef.current) {
        onAgentOperationRef.current(operation, result);
      }

      // Send result back
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'operationResult',
          requestId,
          result,
        }));
      }
    }

    if (data.type === 'readNotebook') {
      const { requestId } = data;

      // Send current notebook state
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'notebookData',
          requestId,
          result: {
            success: true,
            data: {
              path: filePath,
              // Return cells in standardized format (matching headless)
              cells: cellsRef.current.map(c => ({
                id: c.id,
                type: c.type,
                content: c.content,
                // Strip internal fields (id, timestamp) from outputs for API consistency
                outputs: c.outputs.map(o => ({ type: o.type, content: o.content })),
                executionCount: c.executionCount,
                metadata: {
                  scrolled: c.scrolled,
                  scrolledHeight: c.scrolledHeight,
                },
              })),
            },
          },
        }));
      }
    }
  }, [applyOperation, filePath]);

  // Keep latest handler without forcing reconnects on every render
  const handleMessageRef = useRef(handleMessage);
  useEffect(() => {
    handleMessageRef.current = handleMessage;
  }, [handleMessage]);

  /**
   * Connect to WebSocket
   */
  const connect = useCallback(() => {
    if (!filePath) return;
    const connectionAttempt = ++connectionAttemptRef.current;
    // Window-global epoch: dev-mode HMR can leave ghost component trees with
    // live sockets. Only the newest epoch in this window may auto-reclaim the
    // live connection, so stale generations can never steal it back.
    const w = window as unknown as { __nebulaNotebookWsEpoch?: number };
    w.__nebulaNotebookWsEpoch = (w.__nebulaNotebookWsEpoch ?? 0) + 1;
    wsEpochRef.current = w.__nebulaNotebookWsEpoch;

    // Clear any pending reconnect before connecting
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Close existing connection (mark as intentional to prevent reconnect loop)
    if (wsRef.current) {
      intentionalCloseRef.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const encodedPath = encodeURIComponent(filePath);
    const baseWsUrl = `${protocol}//${host}/api/notebook/${encodedPath}/ws`;
    const wsUrl = authService.getAuthenticatedWebSocketUrl(baseWsUrl);

    console.log('[OperationHandler] Connecting to:', baseWsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws || connectionAttempt !== connectionAttemptRef.current) {
        return;
      }

      console.log('[OperationHandler] Connected');
      setIsConnected(true);
      setConnectionReplaced(false);
      intentionalCloseRef.current = false; // Reset flag on successful connect

      // Set up ping interval to keep connection alive
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 10000); // Ping every 10 seconds (helps with SSH tunnels)
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws || connectionAttempt !== connectionAttemptRef.current) {
        return;
      }

      try {
        const data = JSON.parse(event.data);
        handleMessageRef.current(data);
      } catch (e) {
        console.error('[OperationHandler] Failed to parse message:', e);
      }
    };

    ws.onerror = (error) => {
      if (wsRef.current !== ws || connectionAttempt !== connectionAttemptRef.current) {
        return;
      }

      console.error('[OperationHandler] WebSocket error:', error);
    };

    ws.onclose = (event) => {
      if (wsRef.current !== ws || connectionAttempt !== connectionAttemptRef.current) {
        return;
      }

      console.log('[OperationHandler] Disconnected');
      setIsConnected(false);
      wsRef.current = null;

      const replacedByAnotherTab = event.reason === 'Connection replaced';
      if (replacedByAnotherTab) {
        console.log('[OperationHandler] Another window/page instance took over the live notebook connection');
        setConnectionReplaced(true);
      }

      // Clear ping interval
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      // Only auto-reconnect if this was NOT an intentional close
      // (intentional closes happen when connect() replaces the connection)
      if (!intentionalCloseRef.current && !replacedByAnotherTab) {
        reconnectTimeoutRef.current = setTimeout(() => {
          if (filePath) {
            console.log('[OperationHandler] Attempting reconnect...');
            connect();
          }
        }, 1000);
      }
    };
  }, [filePath]);

  /**
   * Reclaim the live connection when this is the page the user is actually
   * looking at. Another window (or, in dev, a stale HMR ghost) may have taken
   * the registration; agent operations apply wherever the live connection
   * lives, so the focused, newest page instance must win or agent edits land
   * in state the user cannot see.
   */
  useEffect(() => {
    if (!connectionReplaced) return;
    const isNewestEpoch = () =>
      wsEpochRef.current === ((window as unknown as { __nebulaNotebookWsEpoch?: number }).__nebulaNotebookWsEpoch ?? 0);

    const reclaim = () => {
      if (!isNewestEpoch()) return; // stale HMR generation — never steal back
      console.log('[OperationHandler] Reclaiming live notebook connection (window active)');
      connect();
    };

    // Already visible and focused (e.g. a same-window ghost stole the
    // registration): reclaim after a short settle delay.
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      const timer = setTimeout(reclaim, 800);
      return () => clearTimeout(timer);
    }

    // Otherwise reclaim when the user returns to this window.
    window.addEventListener('focus', reclaim);
    document.addEventListener('pointerdown', reclaim);
    return () => {
      window.removeEventListener('focus', reclaim);
      document.removeEventListener('pointerdown', reclaim);
    };
  }, [connectionReplaced, connect]);

  /**
   * Disconnect from WebSocket
   */
  const disconnect = useCallback(() => {
    // Clear reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Clear ping interval
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }

    // Close WebSocket (mark as intentional to prevent auto-reconnect)
    if (wsRef.current) {
      intentionalCloseRef.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsConnected(false);
  }, []);

  // Connect when file path changes
  useEffect(() => {
    if (filePath) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [filePath, connect, disconnect]);

  // Auto-expire agent sessions after inactivity
  useEffect(() => {
    const checkExpiration = () => {
      if (agentSessionRef.current) {
        const elapsed = Date.now() - agentSessionRef.current.lastActivityAt;
        if (elapsed > AGENT_SESSION_TIMEOUT_MS) {
          console.log(`[OperationHandler] Agent session expired after ${Math.round(elapsed / 1000)}s of inactivity`);
          setAgentSession(null);
        }
      }
    };

    // Check every 30 seconds
    const interval = setInterval(checkExpiration, 30 * 1000);
    return () => clearInterval(interval);
  }, [setAgentSession]);

  const forceEndAgentSession = useCallback(() => {
    if (agentSessionRef.current) {
      console.log('[OperationHandler] Force ending agent session from UI');
      setAgentSession(null);
    }
  }, [setAgentSession]);

  return {
    isConnected,
    activeOperation,
    agentSession,
    forceEndAgentSession,
    disconnect,
    reconnect: connect,
  };
}
