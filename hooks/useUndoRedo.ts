/**
 * NOTEBOOK-LEVEL UNDO/REDO SYSTEM
 *
 * This hook manages the structural history of the notebook - operations that
 * affect the notebook as a whole rather than individual text edits.
 *
 * ## Dual Undo Architecture
 *
 * The notebook uses two complementary undo systems:
 *
 * 1. **CodeMirror (keyboard Ctrl/Cmd+Z)**: Fine-grained per-cell text history
 *    - Character-level undo for each cell's content
 *    - Each cell has independent undo stacks
 *    - Optimal for typos and local text editing
 *
 * 2. **This hook (toolbar buttons)**: Coarse-grained notebook operations
 *    - Structural: insertCell, deleteCell, moveCell, changeType
 *    - Content: updateContentPatch (batched at keyframe boundaries, stored as patches)
 *    - Batch: compound operations as single undo step
 *
 * This separation is intentional - users get fine-grained text editing via
 * keyboard and structural notebook changes via toolbar, each at the appropriate
 * granularity level.
 *
 * ## Patch-in-Memory Architecture
 *
 * Content changes are stored as patches (diffs) immediately, not full content:
 * - Memory scales with edit size, not content size
 * - Consistent format: memory = disk = loaded (no conversion needed on save)
 * - Better scalability for long editing sessions
 *
 * The `updateContent` type is kept for backwards compatibility with old history
 * files, but new operations always use `updateContentPatch`.
 *
 * ## Keyframe Pattern
 *
 * Content changes are NOT tracked on every keystroke. Instead, we use "keyframes":
 * - Before structural operations (add/delete/move cell)
 * - Before execution (run cell)
 * - On save
 * - On explicit flush calls
 *
 * Call `flushCell(cellId, content)` before keyframe operations to capture
 * pending content changes.
 *
 * ## Full History
 *
 * Beyond undo/redo, this hook maintains a complete timestamped operation log
 * (fullHistoryRef) for session replay, AI training data, and debugging.
 */

import { useState, useCallback, useRef } from 'react';
import { Cell, CellType } from '../types';
import { createDiff, diffToPatch, hashText } from '../lib/diffUtils';

// Re-export types from core library for backwards compatibility
export type {
  EditSource,
  MetadataChanges,
  UndoableOperation,
  LogOperation,
  SnapshotOperation,
  TimestampedOperation,
  Operation,
  UndoRedoResult,
  UnflushedState,
  UpdateSummary,
} from '../lib/undoRedoCore';

// Import types and pure functions from core library
import {
  EditSource,
  MetadataChanges,
  UndoableOperation,
  LogOperation,
  TimestampedOperation,
  Operation,
  UndoRedoResult,
  UnflushedState,
  UpdateSummary,
  EventCategory,
  EventTarget,
  cloneCell,
  stripCellOutputs,
  applyOperation,
  reverseOperation,
  getAffectedCellIds,
  convertToCompactFormat,
  rebuildUndoStack,
} from '../lib/undoRedoCore';

interface UseUndoRedoResult {
  cells: Cell[];
  setCells: (newCells: Cell[] | ((prev: Cell[]) => Cell[])) => void;
  // Operation dispatchers
  insertCell: (index: number, cell: Cell) => void;
  deleteCell: (index: number) => Cell | null;
  moveCell: (fromIndex: number, toIndex: number) => void;
  updateContent: (cellId: string, newContent: string, source?: EditSource) => void;
  updateContentAI: (cellId: string, newContent: string) => void; // Convenience for AI edits
  // Generic metadata update - stable API that never needs to change
  updateMetadata: (cellId: string, changes: MetadataChanges) => void;
  // Convenience wrappers (call updateMetadata internally)
  changeType: (cellId: string, newType: CellType) => void;
  setCellScrolled: (cellId: string, scrolled: boolean) => void;
  setCellScrolledHeight: (cellId: string, height: number) => void;
  setCellSourceCollapsed: (cellId: string, collapsed: boolean) => void;
  setCellSourceHeight: (cellId: string, height: number) => void;
  // Batch operations (for compound actions)
  batch: (operations: Operation[]) => void;
  // Flush pending content for a single cell (O(1) - call before keyframe operations)
  flushCell: (cellId: string, currentContent: string) => void;
  // Peek at next undo/redo without applying (for scroll-before-apply)
  peekUndo: () => UndoRedoResult | null;
  peekRedo: () => UndoRedoResult | null;
  // Undo/Redo - returns affected cells for visual feedback
  undo: () => UndoRedoResult | null;
  redo: () => UndoRedoResult | null;
  canUndo: boolean;
  canRedo: boolean;
  // Load cells when opening a notebook (history loaded separately via loadHistory)
  loadCells: (cells: Cell[]) => void;
  // Initialize new history with snapshot (ONLY for new notebooks without existing history)
  initializeNewHistory: (cells: Cell[]) => void;
  // Legacy support - for operations that don't fit the model
  saveCheckpoint: () => void;
  // History access for persistence
  getFullHistory: () => TimestampedOperation[];
  loadHistory: (history: TimestampedOperation[]) => void;
  // Log non-undoable operations (for history tracking)
  logOperation: (op: LogOperation) => void;
  // New for autosave integration
  redoStackLength: number;
  commitHistoryBeforeKeyframe: () => void;
  // Check if editing should trigger a keyframe (redo stack non-empty)
  // Uses ref for immediate reads after state updates
  hasRedoToFlush: () => boolean;
  // Session state for unflushed edits
  getUnflushedState: (activeCellId: string | null, cells: Cell[]) => UnflushedState | null;
  setUnflushedState: (state: UnflushedState | null) => void;
  // Update tracking for agent awareness
  getUpdatesSince: (sinceTimestamp: number) => UpdateSummary[];
}

// Note: cloneCell, applyOperation, reverseOperation, getAffectedCellIds
// are now imported from lib/undoRedoCore.ts

export const useUndoRedo = (initialCells: Cell[]): UseUndoRedoResult => {
  // Current state
  const [cells, setCellsState] = useState<Cell[]>(initialCells);

  // Ref to track current cells for synchronous reads (avoids stale closures and Strict Mode issues)
  const cellsRef = useRef<Cell[]>(initialCells);

  // Wrapper that updates both state and ref for cells
  const setCellsInternal = useCallback((update: Cell[] | ((prev: Cell[]) => Cell[])) => {
    if (typeof update === 'function') {
      setCellsState(prev => {
        const newCells = update(prev);
        cellsRef.current = newCells;
        return newCells;
      });
    } else {
      cellsRef.current = update;
      setCellsState(update);
    }
  }, []);

  // Operation history stacks - stored in refs for O(1) mutations
  // Only boolean state triggers re-renders (for undo/redo button enabled state)
  const undoStackRef = useRef<Operation[]>([]);
  const redoStackRef = useRef<Operation[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Track last content per cell for updateContent operations
  const lastContentRef = useRef<Map<string, string>>(new Map());

  // Full timestamped history for persistence (includes both undoable and log operations)
  const fullHistoryRef = useRef<TimestampedOperation[]>([]);

  // Track redo stack length for keyframe detection (first undo, first edit after undo)
  const prevRedoLengthRef = useRef<number>(0);

  // Helper to add operation to full history
  // Returns the generated operationId for linking undo ops
  const addToFullHistory = useCallback((op: UndoableOperation | LogOperation): string => {
    const operationId = crypto.randomUUID();
    const timestampedOp: TimestampedOperation = {
      ...op,
      timestamp: Date.now(),
      operationId,
    };
    fullHistoryRef.current.push(timestampedOp);
    return operationId;
  }, []);

  // Convert redo stack entries to undo ops in history (for keyframe events)
  // This records the undo steps in history while keeping history append-only
  const convertRedoStackToHistory = useCallback((redoOps: Operation[]) => {
    redoOps.forEach(op => {
      const reversedOp = reverseOperation(op);
      const timestampedOp: TimestampedOperation = {
        ...reversedOp,
        timestamp: Date.now(),
        operationId: crypto.randomUUID(),
        isUndo: true,
        undoesOperationId: (op as any).operationId,
      };
      fullHistoryRef.current.push(timestampedOp);
    });
  }, []);

  // Execute an operation and push to undo stack
  // Apply against the latest ref state to avoid stale updates under rapid undo/redo.
  const executeOperation = useCallback((op: Operation) => {
    const newCells = applyOperation(cellsRef.current, op);
    setCellsInternal(newCells);
    // Keyframe: first edit after undo - convert redo stack to history before clearing
    if (redoStackRef.current.length > 0) {
      convertRedoStackToHistory(redoStackRef.current);
      redoStackRef.current.length = 0; // O(1) clear
      setCanRedo(false);
    }
    // Add to history first to get the operationId
    const operationId = addToFullHistory(op);
    // Store operationId on the op for later linking when it moves to redo stack
    const opWithId = { ...op, operationId } as unknown as Operation;
    undoStackRef.current.push(opWithId); // O(1) push
    setCanUndo(true);
  }, [addToFullHistory, convertRedoStackToHistory]);

  // Insert a cell at index
  const insertCell = useCallback((index: number, cell: Cell, source: EditSource = 'user') => {
    const snapshot = cloneCell(cell);
    // Initialize content tracking for the new cell
    lastContentRef.current.set(snapshot.id, snapshot.content);
    executeOperation({ type: 'insertCell', index, cell: snapshot, source });
  }, [executeOperation]);

  // Delete a cell at index, returns the deleted cell
  const deleteCell = useCallback((index: number, source: EditSource = 'user'): Cell | null => {
    const cellToDelete = cells[index];
    if (!cellToDelete) return null;
    const snapshot = cloneCell(cellToDelete);
    executeOperation({ type: 'deleteCell', index, cell: snapshot, source });
    return snapshot;
  }, [cells, executeOperation]);

  // Move a cell from one index to another
  const moveCell = useCallback((fromIndex: number, toIndex: number, source: EditSource = 'user') => {
    if (fromIndex === toIndex) return;
    executeOperation({ type: 'moveCell', fromIndex, toIndex, source });
  }, [executeOperation]);

  // Update cell content - tracks old content for undo
  // source: 'user' (default) or 'ai' for AI-generated edits
  // Uses patches for memory efficiency - stores only the diff, not full content
  const updateContent = useCallback((cellId: string, newContent: string, source: EditSource = 'user') => {
    setCellsInternal(prev => {
      const cell = prev.find(c => c.id === cellId);
      if (!cell) return prev;

      const oldContent = lastContentRef.current.get(cellId) ?? cell.content;

      // Only create operation if content actually changed
      if (oldContent !== newContent) {
        // Update last known content
        lastContentRef.current.set(cellId, newContent);

        // Keyframe: first edit after undo - convert redo stack to history before clearing
        if (redoStackRef.current.length > 0) {
          convertRedoStackToHistory(redoStackRef.current);
          redoStackRef.current.length = 0; // O(1) clear
          setCanRedo(false);
        }

        // Compute patch immediately for memory efficiency
        const diff = createDiff(oldContent, newContent);
        const patch = diffToPatch(oldContent, diff);

        const op: Operation = {
          type: 'updateContentPatch',
          cellId,
          patch,
          oldHash: hashText(oldContent),
          newHash: hashText(newContent),
          source
        };

        // Add to history first to get the operationId
        const operationId = addToFullHistory(op);
        // Store operationId on the op for later linking
        const opWithId = { ...op, operationId } as Operation;
        undoStackRef.current.push(opWithId); // O(1) push
        setCanUndo(true);
      }

      return prev.map(c => c.id === cellId ? { ...c, content: newContent } : c);
    });
  }, [addToFullHistory, convertRedoStackToHistory]);

  // Convenience function for AI edits - automatically marks source as 'ai'
  const updateContentAI = useCallback((cellId: string, newContent: string) => {
    updateContent(cellId, newContent, 'ai');
  }, [updateContent]);

  // Change cell type
  // Generic metadata update - the stable core that never needs to change
  // New cell properties just need to be passed in the changes object
  const updateMetadata = useCallback((cellId: string, changes: MetadataChanges, source: EditSource = 'user') => {
    // Read current cells to compute changes (this is a synchronous read, not inside a state updater)
    const currentCells = cellsRef.current;
    const cell = currentCells.find(c => c.id === cellId);
    if (!cell) return;

    // Build the actual changes, filtering out no-ops
    const actualChanges: MetadataChanges = {};
    let hasChanges = false;
    for (const [key, change] of Object.entries(changes)) {
      const currentValue = (cell as unknown as Record<string, unknown>)[key];
      // Use nullish coalescing for properties that default to a value
      const effectiveOld = currentValue ?? change.old;
      if (effectiveOld !== change.new) {
        actualChanges[key] = { old: effectiveOld, new: change.new };
        hasChanges = true;
      }
    }
    if (!hasChanges) return;

    // Keyframe: first edit after undo - convert redo stack to history before clearing
    if (redoStackRef.current.length > 0) {
      convertRedoStackToHistory(redoStackRef.current);
      redoStackRef.current.length = 0; // O(1) clear
      setCanRedo(false);
    }

    const op: Operation = {
      type: 'updateMetadata',
      cellId,
      changes: actualChanges,
      source
    };

    // Add to history first to get the operationId (side effect, but only runs once per call)
    const operationId = addToFullHistory(op);
    // Store operationId on the op for later linking
    const opWithId = { ...op, operationId } as Operation;
    undoStackRef.current.push(opWithId); // O(1) push
    setCanUndo(true);

    // Apply the changes - pure state updater
    setCellsInternal(prev => {
      return prev.map(c => {
        if (c.id !== cellId) return c;
        const updated = { ...c };
        for (const [key, change] of Object.entries(actualChanges)) {
          (updated as Record<string, unknown>)[key] = change.new;
        }
        return updated as Cell;
      });
    });
  }, [addToFullHistory, convertRedoStackToHistory]);

  // Convenience wrapper: change cell type (code/markdown)
  const changeType = useCallback((cellId: string, newType: CellType) => {
    const cell = cells.find(c => c.id === cellId);
    if (!cell) return;
    updateMetadata(cellId, { type: { old: cell.type, new: newType } });
  }, [cells, updateMetadata]);

  // Convenience wrapper: set cell scrolled state (Jupyter standard: collapsed output)
  const setCellScrolled = useCallback((cellId: string, scrolled: boolean) => {
    const cell = cells.find(c => c.id === cellId);
    if (!cell) return;
    // Default scrolled to false if undefined (expanded by default)
    const oldScrolled = cell.scrolled ?? false;
    if (oldScrolled === scrolled) return; // No-op guard
    updateMetadata(cellId, { scrolled: { old: oldScrolled, new: scrolled } });
  }, [cells, updateMetadata]);

  // Convenience wrapper: set cell scrolled height (output area height in scroll mode)
  const setCellScrolledHeight = useCallback((cellId: string, height: number) => {
    const cell = cells.find(c => c.id === cellId);
    if (!cell) return;
    const oldHeight = cell.scrolledHeight;
    if (oldHeight === height) return; // No-op guard
    updateMetadata(cellId, { scrolledHeight: { old: oldHeight, new: height } });
  }, [cells, updateMetadata]);

  // Convenience wrappers: collapse the cell SOURCE to a fixed height, and
  // set that height (mirrors the output-collapse pair above).
  const setCellSourceCollapsed = useCallback((cellId: string, collapsed: boolean) => {
    const cell = cells.find(c => c.id === cellId);
    if (!cell) return;
    const oldCollapsed = cell.sourceCollapsed ?? false;
    if (oldCollapsed === collapsed) return;
    updateMetadata(cellId, { sourceCollapsed: { old: oldCollapsed, new: collapsed } });
  }, [cells, updateMetadata]);

  const setCellSourceHeight = useCallback((cellId: string, height: number) => {
    const cell = cells.find(c => c.id === cellId);
    if (!cell) return;
    const oldHeight = cell.sourceHeight;
    if (oldHeight === height) return;
    updateMetadata(cellId, { sourceHeight: { old: oldHeight, new: height } });
  }, [cells, updateMetadata]);

  // Execute a batch of operations as a single undoable action
  const batch = useCallback((operations: Operation[]) => {
    if (operations.length === 0) return;
    if (operations.length === 1) {
      executeOperation(operations[0]);
    } else {
      executeOperation({ type: 'batch', operations });
    }
  }, [executeOperation]);

  // Flush pending content for a single cell - O(1)
  // Call this before keyframe operations (undo, insert, delete, move, run, save)
  // Uses patches for memory efficiency - stores only the diff, not full content
  const flushCell = useCallback((cellId: string, currentContent: string) => {
    const oldContent = lastContentRef.current.get(cellId);
    // Only record if content actually changed
    if (oldContent === undefined || oldContent === currentContent) return;

    // Keyframe: first edit after undo (redo stack about to become empty)
    // Convert redo stack to history before clearing
    if (redoStackRef.current.length > 0) {
      convertRedoStackToHistory(redoStackRef.current);
      redoStackRef.current.length = 0; // O(1) clear
      setCanRedo(false);
    }

    // Compute patch immediately for memory efficiency
    const diff = createDiff(oldContent, currentContent);
    const patch = diffToPatch(oldContent, diff);

    const op: Operation = {
      type: 'updateContentPatch',
      cellId,
      patch,
      oldHash: hashText(oldContent),
      newHash: hashText(currentContent),
      source: 'user'
    };
    // Update tracking
    lastContentRef.current.set(cellId, currentContent);
    // Add to history first to get operationId
    const operationId = addToFullHistory(op);
    // Store operationId on the op for later linking
    const opWithId = { ...op, operationId } as Operation;
    undoStackRef.current.push(opWithId); // O(1) push
    setCanUndo(true);
  }, [addToFullHistory, convertRedoStackToHistory]);

  // Helper to update lastContentRef after undoing an operation
  // For updateContentPatch, we need to reconstruct the old content by reverse-applying to current
  const updateContentTrackingAfterUndo = useCallback((op: Operation) => {
    if (op.type === 'updateContent') {
      // Legacy: full content stored (backwards compatibility)
      lastContentRef.current.set(op.cellId, op.oldContent);
    } else if (op.type === 'updateContentPatch') {
      // After undo, the cell content is what it was before the patch
      // We need to get the current content from cells and apply reverse patch
      const cell = cellsRef.current.find(c => c.id === op.cellId);
      if (cell) {
        lastContentRef.current.set(op.cellId, cell.content);
      }
    } else if (op.type === 'insertCell') {
      // Undoing an insert means the cell is removed
      lastContentRef.current.delete(op.cell.id);
    } else if (op.type === 'deleteCell') {
      // Undoing a delete means the cell is restored
      lastContentRef.current.set(op.cell.id, op.cell.content);
    } else if (op.type === 'batch') {
      // Undo batch in reverse order
      for (let i = op.operations.length - 1; i >= 0; i--) {
        updateContentTrackingAfterUndo(op.operations[i]);
      }
    }
  }, []);

  // Helper to update lastContentRef after applying an operation
  const updateContentTrackingAfterOp = useCallback((op: Operation) => {
    if (op.type === 'updateContent') {
      // Legacy: full content stored (backwards compatibility)
      lastContentRef.current.set(op.cellId, op.newContent);
    } else if (op.type === 'updateContentPatch') {
      // After redo, the cell content is the result of applying the patch
      // We need to get the current content from cells after the operation was applied
      const cell = cellsRef.current.find(c => c.id === op.cellId);
      if (cell) {
        lastContentRef.current.set(op.cellId, cell.content);
      }
    } else if (op.type === 'insertCell') {
      // When redoing an insert, initialize content tracking for the cell
      lastContentRef.current.set(op.cell.id, op.cell.content);
    } else if (op.type === 'deleteCell') {
      // When redoing a delete, remove from content tracking
      lastContentRef.current.delete(op.cell.id);
    } else if (op.type === 'batch') {
      for (const subOp of op.operations) {
        updateContentTrackingAfterOp(subOp);
      }
    }
  }, []);

  // Peek at what the next undo would affect (without applying)
  // Uses ref instead of state for immediate reads after flushCell writes
  const peekUndo = useCallback((): UndoRedoResult | null => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return null;
    const op = stack[stack.length - 1];
    const reversedOp = reverseOperation(op);
    // For moveCell, we need to simulate where the cell will be after undo
    // The reversed op's toIndex is where the cell will end up
    return {
      affectedCellIds: getAffectedCellIds(reversedOp, cells),
      operationType: op.type
    };
  }, [cells]);

  // Peek at what the next redo would affect (without applying)
  const peekRedo = useCallback((): UndoRedoResult | null => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return null;
    const op = stack[stack.length - 1];
    // For moveCell, op.toIndex is where the cell will end up after redo
    return {
      affectedCellIds: getAffectedCellIds(op, cells),
      operationType: op.type
    };
  }, [cells]);

  // Undo last operation
  // Note: Caller should call flushCell(activeCellId, content) before undo
  // to capture any pending content changes in the active cell
  // Returns affected cell IDs for visual feedback
  // Uses ref instead of state for immediate reads after flushCell writes
  const undo = useCallback((): UndoRedoResult | null => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return null;

    const op = stack.pop()!; // O(1) pop
    setCanUndo(stack.length > 0);

    const reversedOp = reverseOperation(op);

    const newCells = applyOperation(cellsRef.current, reversedOp);
    setCellsInternal(newCells);

    redoStackRef.current.push(op); // O(1) push
    setCanRedo(true);

    // Update content tracking after undo
    updateContentTrackingAfterUndo(op);

    // Return affected cells for visual feedback (use newCells for moveCell lookup)
    return {
      affectedCellIds: getAffectedCellIds(reversedOp, newCells),
      operationType: op.type
    };
  }, [updateContentTrackingAfterUndo]);

  // Redo last undone operation
  // Returns affected cell IDs for visual feedback
  const redo = useCallback((): UndoRedoResult | null => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return null;

    const op = stack.pop()!; // O(1) pop
    setCanRedo(stack.length > 0);

    const newCells = applyOperation(cellsRef.current, op);
    setCellsInternal(newCells);

    undoStackRef.current.push(op); // O(1) push
    setCanUndo(true);

    // Update content tracking
    updateContentTrackingAfterOp(op);

    // Return affected cells for visual feedback (use newCells for moveCell lookup)
    return {
      affectedCellIds: getAffectedCellIds(op, newCells),
      operationType: op.type
    };
  }, [updateContentTrackingAfterOp]);

  // Direct setCells for non-undoable changes (like execution outputs)
  const setCells = useCallback((newCells: Cell[] | ((prev: Cell[]) => Cell[])) => {
    setCellsInternal(newCells);
  }, []);

  // Load cells when opening a notebook (clears stacks since we're switching notebooks)
  // Call this, then loadHistory() to restore history and rebuild undo stack
  // The stack clearing is needed because we're switching notebooks - loadHistory will rebuild
  const loadCells = useCallback((newCells: Cell[]) => {
    setCellsInternal(newCells);
    // Clear stacks from previous notebook - loadHistory will rebuild for this notebook
    undoStackRef.current.length = 0;
    redoStackRef.current.length = 0;
    setCanUndo(false);
    setCanRedo(false);
    // Initialize content tracking for updateContent operations
    lastContentRef.current.clear();
    newCells.forEach(c => lastContentRef.current.set(c.id, c.content));
    // Note: fullHistoryRef is NOT modified here - loadHistory() will set it
  }, []);

  // Initialize new history with a snapshot (ONLY for NEW notebooks without existing history)
  // WARNING: This overwrites any existing history! Only call when creating a new notebook
  // or when the notebook has no history file.
  const initializeNewHistory = useCallback((newCells: Cell[]) => {
    setCellsInternal(newCells);
    undoStackRef.current.length = 0; // O(1) clear
    redoStackRef.current.length = 0; // O(1) clear
    setCanUndo(false);
    setCanRedo(false);
    lastContentRef.current.clear();
    // Initialize content tracking
    newCells.forEach(c => lastContentRef.current.set(c.id, c.content));

    // Start fresh history with a snapshot (required for trajectory reconstruction).
    // Strip outputs from the snapshot — they are large (base64 images) and not
    // needed for history replay.  convertToCompactFormat already strips them
    // when persisting, so keeping them here just wastes memory.
    fullHistoryRef.current = [{
      type: 'snapshot',
      cells: newCells.map(stripCellOutputs),
      timestamp: Date.now()
    }];
  }, []);

  // Legacy: saveCheckpoint does nothing in operation-based system
  // Content changes are automatically tracked
  const saveCheckpoint = useCallback(() => {
    // No-op - operations are tracked automatically
  }, []);

  // Note: stripCellOutputs and convertToCompactFormat are now imported from lib/undoRedoCore.ts

  // Get full history for persistence (converts to compact patch format)
  const getFullHistory = useCallback((): TimestampedOperation[] => {
    return fullHistoryRef.current.map(convertToCompactFormat);
  }, []);

  // Load history from persistence (e.g., when loading a notebook)
  // Rebuilds undoStack from loaded operations so undo works
  // Filters out undo ops and their canceled counterparts (history remains append-only)
  const loadHistory = useCallback((history: TimestampedOperation[]) => {
    // If loaded history starts with a snapshot, use it entirely
    if (history.length > 0 && history[0].type === 'snapshot') {
      fullHistoryRef.current = [...history];
    } else if (history.length > 0) {
      // Loaded history has no snapshot - append to current (which has the snapshot)
      const currentSnapshot = fullHistoryRef.current.find(op => op.type === 'snapshot');
      if (currentSnapshot) {
        fullHistoryRef.current = [currentSnapshot, ...history];
      } else {
        fullHistoryRef.current = [...history];
      }
    }

    // Rebuild undoStack using the imported function from core library
    const undoableOps = rebuildUndoStack(fullHistoryRef.current);
    undoStackRef.current = undoableOps;
    redoStackRef.current = [];
    setCanUndo(undoableOps.length > 0);
    setCanRedo(false);
  }, []);

  // Log a non-undoable operation (for history tracking)
  const logOperation = useCallback((op: LogOperation) => {
    addToFullHistory(op);
  }, [addToFullHistory]);

  // Commit history before keyframe events (e.g., save)
  // Converts redo stack to undo ops in history and clears redo stack
  const commitHistoryBeforeKeyframe = useCallback(() => {
    if (redoStackRef.current.length > 0) {
      convertRedoStackToHistory(redoStackRef.current);
      redoStackRef.current.length = 0; // O(1) clear
      setCanRedo(false);
    }
  }, [convertRedoStackToHistory]);

  // Get unflushed state for session persistence
  // Returns the active cell's unflushed edit state if there are pending changes
  const getUnflushedState = useCallback((activeCellId: string | null, currentCells: Cell[]): UnflushedState | null => {
    if (!activeCellId) return null;

    const cell = currentCells.find(c => c.id === activeCellId);
    if (!cell) return null;

    const lastFlushedContent = lastContentRef.current.get(activeCellId);
    if (lastFlushedContent === undefined) return null;

    // Only return state if there are actual unflushed changes
    if (lastFlushedContent === cell.content) return null;

    return {
      cellId: activeCellId,
      lastFlushedContent
    };
  }, []);

  // Restore unflushed state from session persistence
  // Sets the lastContentRef for a cell to recreate the unflushed edit boundary
  const setUnflushedState = useCallback((state: UnflushedState | null) => {
    if (!state) return;
    lastContentRef.current.set(state.cellId, state.lastFlushedContent);
  }, []);

  // Check if editing should trigger a keyframe (redo stack non-empty)
  // Uses ref for immediate reads - first edit after undo should flush
  const hasRedoToFlush = useCallback(() => {
    return redoStackRef.current.length > 0;
  }, []);

  // Get updates since a timestamp (for agent awareness)
  // Returns summaries of edits and events (no source filtering)
  const getUpdatesSince = useCallback((sinceTimestamp: number): UpdateSummary[] => {
    const currentCells = cellsRef.current;
    const summaries: UpdateSummary[] = [];

    const describeEvent = (event: {
      category: EventCategory;
      name: string;
      target?: EventTarget;
      data?: Record<string, unknown>;
      runId?: string;
      source?: EditSource;
    }, timestamp: number): void => {
      const cellId = event.target?.cellId;
      const cellIndex = event.target?.cellIndex;
      const data = event.data ? { ...event.data } : undefined;
      if (data && event.name === 'runCellComplete' && 'output' in data) {
        delete (data as Record<string, unknown>).output;
      }

      let description = '';
      switch (event.name) {
        case 'runCell': {
          description = `Ran cell${cellIndex !== undefined ? ` #${cellIndex + 1}` : ''}`;
          break;
        }
        case 'runAllCells': {
          const count = typeof data?.cellCount === 'number'
            ? data.cellCount
            : (Array.isArray(data?.cellIds) ? data.cellIds.length : undefined);
          description = `Ran all cells${count !== undefined ? ` (${count})` : ''}`;
          break;
        }
        case 'runCellComplete': {
          const durationMs = typeof data?.durationMs === 'number' ? data.durationMs : undefined;
          const success = typeof data?.success === 'boolean' ? data.success : undefined;
          const status = success === undefined ? 'complete' : (success ? 'success' : 'failed');
          description = `Run complete${cellIndex !== undefined ? ` for cell #${cellIndex + 1}` : ''}${durationMs !== undefined ? ` (${durationMs}ms)` : ''} • ${status}`;
          break;
        }
        case 'interruptKernel':
          description = 'Kernel interrupted';
          break;
        case 'restartKernel':
          description = 'Kernel restarted';
          break;
        case 'startKernel': {
          const kernelName = typeof data?.kernelName === 'string' ? data.kernelName : undefined;
          description = `Kernel started${kernelName ? ` (${kernelName})` : ''}`;
          break;
        }
        case 'shutdownKernel':
          description = 'Kernel shutdown';
          break;
        default:
          description = `Event: ${event.name}`;
      }

      summaries.push({
        kind: 'event',
        type: event.name,
        category: event.category,
        name: event.name,
        cellId,
        cellIndex,
        timestamp,
        description,
        source: event.source,
        runId: event.runId,
        data,
      });
    };

    const toEvent = (op: TimestampedOperation): {
      category: EventCategory;
      name: string;
      target?: EventTarget;
      data?: Record<string, unknown>;
      runId?: string;
      source?: EditSource;
    } | null => {
      if (op.type === 'event') {
        return {
          category: op.category,
          name: op.name,
          target: op.target,
          data: op.data as Record<string, unknown> | undefined,
          runId: op.runId,
          source: op.source,
        };
      }

      switch (op.type) {
        case 'runCell':
          return {
            category: 'execution',
            name: 'runCell',
            target: { cellId: op.cellId, cellIndex: op.cellIndex },
            runId: (op as any).runId,
          };
        case 'runAllCells':
          return {
            category: 'execution',
            name: 'runAllCells',
            data: {
              cellCount: (op as any).cellCount,
              cellIds: (op as any).cellIds,
            },
          };
        case 'runCellComplete':
          return {
            category: 'execution',
            name: 'runCellComplete',
            target: { cellId: op.cellId, cellIndex: op.cellIndex },
            data: {
              durationMs: (op as any).durationMs,
              success: (op as any).success,
              output: (op as any).output,
            },
            runId: (op as any).runId,
          };
        case 'interruptKernel':
        case 'restartKernel':
          return {
            category: 'kernel',
            name: op.type,
          };
        default:
          return null;
      }
    };

    for (const op of fullHistoryRef.current) {
      // Skip operations before the timestamp
      if (op.timestamp <= sinceTimestamp) continue;
      // Skip undo operations
      if ((op as any).isUndo) continue;
      if (op.type === 'snapshot') continue;

      const event = toEvent(op);
      if (event) {
        describeEvent(event, op.timestamp);
        continue;
      }

      let description = '';
      let cellId: string | undefined;
      let cellIndex: number | undefined;

      switch (op.type) {
        case 'insertCell':
          cellId = op.cell.id;
          cellIndex = op.index;
          description = `Inserted ${op.cell.type} cell at #${op.index + 1}`;
          break;
        case 'deleteCell':
          cellId = op.cell.id;
          cellIndex = op.index;
          description = `Deleted cell #${op.index + 1}`;
          break;
        case 'moveCell':
          if (op.toIndex >= 0 && op.toIndex < currentCells.length) {
            cellId = currentCells[op.toIndex].id;
          }
          description = `Moved cell from #${op.fromIndex + 1} to #${op.toIndex + 1}`;
          break;
        case 'updateContent': {
          cellId = op.cellId;
          cellIndex = currentCells.findIndex(c => c.id === op.cellId);
          if (cellIndex === -1) cellIndex = undefined;
          const preview = op.newContent.slice(0, 50).replace(/\n/g, ' ');
          description = `Edited cell${cellIndex !== undefined ? ` #${cellIndex + 1}` : ''}: "${preview}${preview.length >= 50 ? '...' : ''}"`;
          break;
        }
        case 'updateContentPatch': {
          cellId = op.cellId;
          cellIndex = currentCells.findIndex(c => c.id === op.cellId);
          if (cellIndex === -1) cellIndex = undefined;
          description = `Edited cell${cellIndex !== undefined ? ` #${cellIndex + 1}` : ''}: "[content updated]"`;
          break;
        }
        case 'updateMetadata':
          cellId = op.cellId;
          cellIndex = currentCells.findIndex(c => c.id === op.cellId);
          if (cellIndex === -1) cellIndex = undefined;
          const changes = Object.keys(op.changes).join(', ');
          description = `Changed ${changes} on cell${cellIndex !== undefined ? ` #${cellIndex + 1}` : ''}`;
          break;
        case 'batch':
          description = `Batch operation (${op.operations.length} changes)`;
          break;
        default:
          description = `Operation: ${(op as TimestampedOperation).type}`;
      }

      summaries.push({
        kind: 'edit',
        type: (op as TimestampedOperation).type,
        cellId,
        cellIndex,
        timestamp: (op as TimestampedOperation).timestamp,
        description,
        source: (op as any).source as EditSource | undefined,
      });
    }

    return summaries;
  }, []);

  return {
    cells,
    setCells,
    insertCell,
    deleteCell,
    moveCell,
    updateContent,
    updateContentAI,
    updateMetadata,
    changeType,
    setCellScrolled,
    setCellScrolledHeight,
    setCellSourceCollapsed,
    setCellSourceHeight,
    batch,
    flushCell,
    peekUndo,
    peekRedo,
    undo,
    redo,
    canUndo,
    canRedo,
    loadCells,
    initializeNewHistory,
    saveCheckpoint,
    getFullHistory,
    loadHistory,
    logOperation,
    // New exports for autosave integration
    redoStackLength: redoStackRef.current.length,
    commitHistoryBeforeKeyframe,
    hasRedoToFlush,
    // Session state for unflushed edits
    getUnflushedState,
    setUnflushedState,
    // Update tracking for agent awareness
    getUpdatesSince,
  };
};
