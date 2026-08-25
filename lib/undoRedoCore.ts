/**
 * UNDO/REDO CORE LIBRARY
 *
 * Framework-agnostic core for notebook undo/redo operations.
 * Used by both the React UI (via useUndoRedo hook) and headless backend.
 *
 * ## Architecture
 *
 * This library provides:
 * - Type definitions for all operations
 * - Pure functions for operation application and reversal
 * - UndoRedoManager class for stateful management
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
 */

import { Cell, CellType } from '../types';
import { createDiff, diffToPatch, applyPatch, reversePatch, hashText, Patch } from './diffUtils';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Base operation data shared by all operations */
export interface BaseOperation {
  timestamp: number; // Unix timestamp in milliseconds
  operationId?: string; // Unique ID for pairing undo ops with original ops
  isUndo?: boolean; // True if this is an undo-generated op (for history filtering)
  undoesOperationId?: string; // ID of the operation being undone (for pairing)
}

/** Source of content edit (for tracking AI vs user/system edits) */
export type EditSource = 'user' | 'ai' | 'mcp' | 'system' | 'error';

/**
 * Generic metadata change - each key maps to old/new values
 * This is intentionally typed as unknown to be maximally extensible.
 * The operation system never needs to change when new cell properties are added.
 */
export type MetadataChanges = Record<string, { old: unknown; new: unknown }>;

/** Undoable operations - can be reversed */
export type UndoableOperation =
  | { type: 'insertCell'; index: number; cell: Cell; source?: EditSource }
  | { type: 'deleteCell'; index: number; cell: Cell; source?: EditSource }
  | { type: 'moveCell'; fromIndex: number; toIndex: number; source?: EditSource }
  | { type: 'updateContent'; cellId: string; oldContent: string; newContent: string; source?: EditSource }
  | { type: 'updateContentPatch'; cellId: string; patch: Patch; oldHash: string; newHash: string; source?: EditSource }
  | { type: 'updateMetadata'; cellId: string; changes: MetadataChanges; source?: EditSource }
  | { type: 'batch'; operations: UndoableOperation[]; source?: EditSource };

/** Non-undoable operations - for tracking/logging only */
export type EventCategory = 'execution' | 'kernel' | 'system' | 'ui';

export type EventTarget = {
  cellId?: string;
  cellIndex?: number;
};

export type EventOperation = {
  type: 'event';
  category: EventCategory;
  name: string;
  target?: EventTarget;
  runId?: string; // Pairs runCell/runCellComplete
  data?: Record<string, unknown>;
  source?: EditSource;
};

// Legacy log operations (kept for backwards compatibility with persisted history)
export type LegacyLogOperation =
  | { type: 'runCell'; cellId: string; cellIndex: number; runId?: string }
  | { type: 'runAllCells'; cellCount?: number; cellIds?: string[] }
  | { type: 'interruptKernel' }
  | { type: 'restartKernel' }
  | {
      type: 'runCellComplete';
      cellId: string;
      cellIndex: number;
      durationMs: number;
      success: boolean;
      output?: string;
      runId?: string;
    };

export type LogOperation = EventOperation | LegacyLogOperation;

/** Snapshot of notebook state at a point in time (for reconstruction) */
export interface SnapshotOperation {
  type: 'snapshot';
  cells: Cell[];
}

/** Combined operation type with timestamp */
export type TimestampedOperation = BaseOperation & (UndoableOperation | LogOperation | SnapshotOperation);

/** Legacy Operation type for backwards compatibility with undo/redo logic */
export type Operation = UndoableOperation;

/** Result from undo/redo operations for visual feedback */
export interface UndoRedoResult {
  affectedCellIds: string[];  // Cell IDs that were modified
  operationType: string;       // Type of operation (for potential animation variants)
}

/** Unflushed edit state for session persistence */
export interface UnflushedState {
  cellId: string;
  lastFlushedContent: string;
}

/** Summary of an update (edit or event) for agent awareness */
export interface UpdateSummary {
  kind: 'edit' | 'event';
  type: string;
  category?: EventCategory;
  name?: string;
  cellId?: string;
  cellIndex?: number;
  timestamp: number;
  description: string;
  source?: EditSource;
  runId?: string;
  data?: Record<string, unknown>;
}

// ============================================================================
// PURE FUNCTIONS
// ============================================================================

/** Deep clone a cell (including outputs) */
export function cloneCell(cell: Cell): Cell {
  return {
    ...cell,
    outputs: cell.outputs.map(output => ({ ...output }))
  };
}

/** Strip outputs from cell for compact storage (outputs can be huge - images, dataframes) */
export function stripCellOutputs(cell: Cell): Cell {
  return {
    ...cell,
    outputs: [],
    isExecuting: false
  };
}

/** Apply an operation to cells (forward) - pure function */
export function applyOperation(cells: Cell[], op: Operation): Cell[] {
  switch (op.type) {
    case 'insertCell': {
      const newCells = [...cells];
      // Create new object to ensure React memo comparisons detect the change
      newCells.splice(op.index, 0, cloneCell(op.cell));
      return newCells;
    }
    case 'deleteCell': {
      return cells.filter((_, i) => i !== op.index);
    }
    case 'moveCell': {
      const newCells = [...cells];
      const [moved] = newCells.splice(op.fromIndex, 1);
      newCells.splice(op.toIndex, 0, moved);
      return newCells;
    }
    case 'updateContent': {
      return cells.map(c =>
        c.id === op.cellId ? { ...c, content: op.newContent } : c
      );
    }
    case 'updateContentPatch': {
      return cells.map(c => {
        if (c.id !== op.cellId) return c;
        const { result, success } = applyPatch(c.content, op.patch);
        if (!success) {
          console.warn(`Failed to apply patch to cell ${c.id}, keeping original content`);
          return c;
        }
        return { ...c, content: result };
      });
    }
    case 'updateMetadata': {
      return cells.map(c => {
        if (c.id !== op.cellId) return c;
        const updated = { ...c };
        for (const [key, change] of Object.entries(op.changes)) {
          (updated as Record<string, unknown>)[key] = change.new;
        }
        return updated as Cell;
      });
    }
    case 'batch': {
      return op.operations.reduce((acc, subOp) => applyOperation(acc, subOp), cells);
    }
    default:
      return cells;
  }
}

/** Reverse an operation (for undo) - pure function */
export function reverseOperation(op: Operation): Operation {
  switch (op.type) {
    case 'insertCell':
      return { type: 'deleteCell', index: op.index, cell: op.cell };
    case 'deleteCell':
      return { type: 'insertCell', index: op.index, cell: op.cell };
    case 'moveCell':
      return { type: 'moveCell', fromIndex: op.toIndex, toIndex: op.fromIndex };
    case 'updateContent':
      return {
        type: 'updateContent',
        cellId: op.cellId,
        oldContent: op.newContent,
        newContent: op.oldContent
      };
    case 'updateContentPatch':
      return {
        type: 'updateContentPatch',
        cellId: op.cellId,
        patch: reversePatch(op.patch),
        oldHash: op.newHash,
        newHash: op.oldHash
      };
    case 'updateMetadata': {
      const reversed: MetadataChanges = {};
      for (const [key, change] of Object.entries(op.changes)) {
        reversed[key] = { old: change.new, new: change.old };
      }
      return { type: 'updateMetadata', cellId: op.cellId, changes: reversed };
    }
    case 'batch':
      return {
        type: 'batch',
        operations: op.operations.map(reverseOperation).reverse()
      };
    default:
      return op;
  }
}

/** Extract affected cell IDs from an operation - pure function */
export function getAffectedCellIds(op: Operation, cells?: Cell[]): string[] {
  switch (op.type) {
    case 'insertCell':
    case 'deleteCell':
      return [op.cell.id];
    case 'moveCell':
      if (cells && op.toIndex >= 0 && op.toIndex < cells.length) {
        return [cells[op.toIndex].id];
      }
      return [];
    case 'updateContent':
    case 'updateContentPatch':
    case 'updateMetadata':
      return [op.cellId];
    case 'batch': {
      const ids = new Set<string>();
      for (const subOp of op.operations) {
        for (const id of getAffectedCellIds(subOp, cells)) {
          ids.add(id);
        }
      }
      return Array.from(ids);
    }
    default:
      return [];
  }
}

/** Convert operation to compact format for storage (strips outputs, converts legacy updateContent) */
export function convertToCompactFormat(op: TimestampedOperation): TimestampedOperation {
  if (op.type === 'snapshot') {
    return {
      ...op,
      cells: op.cells.map(stripCellOutputs)
    };
  }
  if (op.type === 'updateContent') {
    // Legacy conversion for backwards compatibility
    const diff = createDiff(op.oldContent, op.newContent);
    const patch = diffToPatch(op.oldContent, diff);
    return {
      type: 'updateContentPatch',
      cellId: op.cellId,
      patch,
      oldHash: hashText(op.oldContent),
      newHash: hashText(op.newContent),
      timestamp: op.timestamp,
      ...(op.source && { source: op.source }),
      ...(op.operationId && { operationId: op.operationId }),
      ...(op.isUndo && { isUndo: op.isUndo }),
      ...(op.undoesOperationId && { undoesOperationId: op.undoesOperationId }),
    };
  }
  if (op.type === 'insertCell') {
    return { ...op, cell: stripCellOutputs(op.cell) };
  }
  if (op.type === 'deleteCell') {
    return { ...op, cell: stripCellOutputs(op.cell) };
  }
  if (op.type === 'batch') {
    return {
      ...op,
      operations: op.operations.map(subOp =>
        convertToCompactFormat({ ...subOp, timestamp: op.timestamp }) as UndoableOperation
      )
    };
  }
  return op;
}

/** Rebuild undo stack from history, filtering out undone operations */
export function rebuildUndoStack(history: TimestampedOperation[]): Operation[] {
  // Build set of operation IDs that have been undone
  const undoneIds = new Set<string>();
  for (const op of history) {
    if ((op as any).isUndo && (op as any).undoesOperationId) {
      undoneIds.add((op as any).undoesOperationId);
    }
  }

  // Filter out: undo ops (isUndo=true) and their canceled counterparts (undoneIds)
  const undoableOps: Operation[] = [];
  for (const op of history) {
    if ((op as any).isUndo) continue;
    if ((op as any).operationId && undoneIds.has((op as any).operationId)) continue;

    if (op.type === 'insertCell' || op.type === 'deleteCell' ||
        op.type === 'moveCell' || op.type === 'updateContent' ||
        op.type === 'updateContentPatch' || op.type === 'updateMetadata' || op.type === 'batch') {
      const { timestamp, operationId, isUndo, undoesOperationId, ...operation } = op as any;
      undoableOps.push(operation as Operation);
    }
  }
  return undoableOps;
}

/** Filter history to remove undone operations (for compaction) */
export function filterUndoneOperations(history: TimestampedOperation[]): TimestampedOperation[] {
  const undoneIds = new Set<string>();
  for (const op of history) {
    if ((op as any).isUndo && (op as any).undoesOperationId) {
      undoneIds.add((op as any).undoesOperationId);
    }
  }

  return history.filter(op => {
    if ((op as any).isUndo) return false;
    if ((op as any).operationId && undoneIds.has((op as any).operationId)) return false;
    return true;
  });
}

// ============================================================================
// UNDO/REDO MANAGER CLASS
// ============================================================================

/** UUID generator - works in both browser and Node.js */
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Stateful manager for undo/redo operations.
 * Framework-agnostic - used by both React hook and headless backend.
 */
export class UndoRedoManager {
  private cells: Cell[];
  private undoStack: Operation[] = [];
  private redoStack: Operation[] = [];
  private fullHistory: TimestampedOperation[] = [];
  private lastContent: Map<string, string> = new Map();

  /** Callback to notify when cells change (for React state updates) */
  public onCellsChange?: (cells: Cell[]) => void;

  /** Callback to notify when canUndo/canRedo changes */
  public onStackChange?: (canUndo: boolean, canRedo: boolean) => void;

  constructor(initialCells: Cell[]) {
    this.cells = initialCells;
    this.initializeContentTracking(initialCells);
  }

  // -------------------------------------------------------------------------
  // State accessors
  // -------------------------------------------------------------------------

  getCells(): Cell[] {
    return this.cells;
  }

  setCells(cells: Cell[]): void {
    this.cells = cells;
    this.onCellsChange?.(cells);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  getRedoStackLength(): number {
    return this.redoStack.length;
  }

  // -------------------------------------------------------------------------
  // Content tracking
  // -------------------------------------------------------------------------

  private initializeContentTracking(cells: Cell[]): void {
    this.lastContent.clear();
    cells.forEach(c => this.lastContent.set(c.id, c.content));
  }

  private updateContentTrackingAfterUndo(op: Operation): void {
    if (op.type === 'updateContent') {
      this.lastContent.set(op.cellId, op.oldContent);
    } else if (op.type === 'updateContentPatch') {
      const cell = this.cells.find(c => c.id === op.cellId);
      if (cell) {
        this.lastContent.set(op.cellId, cell.content);
      }
    } else if (op.type === 'insertCell') {
      this.lastContent.delete(op.cell.id);
    } else if (op.type === 'deleteCell') {
      this.lastContent.set(op.cell.id, op.cell.content);
    } else if (op.type === 'batch') {
      for (let i = op.operations.length - 1; i >= 0; i--) {
        this.updateContentTrackingAfterUndo(op.operations[i]);
      }
    }
  }

  private updateContentTrackingAfterOp(op: Operation): void {
    if (op.type === 'updateContent') {
      this.lastContent.set(op.cellId, op.newContent);
    } else if (op.type === 'updateContentPatch') {
      const cell = this.cells.find(c => c.id === op.cellId);
      if (cell) {
        this.lastContent.set(op.cellId, cell.content);
      }
    } else if (op.type === 'insertCell') {
      this.lastContent.set(op.cell.id, op.cell.content);
    } else if (op.type === 'deleteCell') {
      this.lastContent.delete(op.cell.id);
    } else if (op.type === 'batch') {
      for (const subOp of op.operations) {
        this.updateContentTrackingAfterOp(subOp);
      }
    }
  }

  // -------------------------------------------------------------------------
  // History management
  // -------------------------------------------------------------------------

  private addToFullHistory(op: UndoableOperation | LogOperation): string {
    const operationId = generateUUID();
    const timestampedOp: TimestampedOperation = {
      ...op,
      timestamp: Date.now(),
      operationId,
    };
    this.fullHistory.push(timestampedOp);
    return operationId;
  }

  private convertRedoStackToHistory(): void {
    for (const op of this.redoStack) {
      const reversedOp = reverseOperation(op);
      const timestampedOp: TimestampedOperation = {
        ...reversedOp,
        timestamp: Date.now(),
        operationId: generateUUID(),
        isUndo: true,
        undoesOperationId: (op as any).operationId,
      };
      this.fullHistory.push(timestampedOp);
    }
  }

  private clearRedoStack(): void {
    if (this.redoStack.length > 0) {
      this.convertRedoStackToHistory();
      this.redoStack.length = 0;
      this.onStackChange?.(this.undoStack.length > 0, false);
    }
  }

  // -------------------------------------------------------------------------
  // Operation execution
  // -------------------------------------------------------------------------

  private executeOperation(op: Operation): void {
    this.cells = applyOperation(this.cells, op);
    this.onCellsChange?.(this.cells);

    this.clearRedoStack();

    const operationId = this.addToFullHistory(op);
    const opWithId = { ...op, operationId } as unknown as Operation;
    this.undoStack.push(opWithId);
    this.onStackChange?.(true, false);
  }

  // -------------------------------------------------------------------------
  // Cell operations
  // -------------------------------------------------------------------------

  insertCell(index: number, cell: Cell, source: EditSource = 'user'): void {
    const snapshot = cloneCell(cell);
    this.lastContent.set(snapshot.id, snapshot.content);
    this.executeOperation({ type: 'insertCell', index, cell: snapshot, source });
  }

  deleteCell(index: number, source: EditSource = 'user'): Cell | null {
    const cellToDelete = this.cells[index];
    if (!cellToDelete) return null;
    const snapshot = cloneCell(cellToDelete);
    this.executeOperation({ type: 'deleteCell', index, cell: snapshot, source });
    return snapshot;
  }

  moveCell(fromIndex: number, toIndex: number, source: EditSource = 'user'): void {
    if (fromIndex === toIndex) return;
    this.executeOperation({ type: 'moveCell', fromIndex, toIndex, source });
  }

  updateContent(cellId: string, newContent: string, source: EditSource = 'user'): void {
    const cell = this.cells.find(c => c.id === cellId);
    if (!cell) return;

    const oldContent = this.lastContent.get(cellId) ?? cell.content;
    if (oldContent === newContent) return;

    this.lastContent.set(cellId, newContent);
    this.clearRedoStack();

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

    const operationId = this.addToFullHistory(op);
    const opWithId = { ...op, operationId } as Operation;
    this.undoStack.push(opWithId);
    this.onStackChange?.(true, false);

    // Update cells state directly (patch already computed, no need to apply)
    this.cells = this.cells.map(c => c.id === cellId ? { ...c, content: newContent } : c);
    this.onCellsChange?.(this.cells);
  }

  updateMetadata(cellId: string, changes: MetadataChanges, source: EditSource = 'user'): void {
    const cell = this.cells.find(c => c.id === cellId);
    if (!cell) return;

    // Build actual changes, filtering out no-ops
    const actualChanges: MetadataChanges = {};
    let hasChanges = false;
    for (const [key, change] of Object.entries(changes)) {
      const currentValue = (cell as unknown as Record<string, unknown>)[key];
      const effectiveOld = currentValue ?? change.old;
      if (effectiveOld !== change.new) {
        actualChanges[key] = { old: effectiveOld, new: change.new };
        hasChanges = true;
      }
    }
    if (!hasChanges) return;

    this.clearRedoStack();

    const op: Operation = {
      type: 'updateMetadata',
      cellId,
      changes: actualChanges,
      source
    };

    const operationId = this.addToFullHistory(op);
    const opWithId = { ...op, operationId } as Operation;
    this.undoStack.push(opWithId);
    this.onStackChange?.(true, false);

    // Apply changes
    this.cells = this.cells.map(c => {
      if (c.id !== cellId) return c;
      const updated = { ...c };
      for (const [key, change] of Object.entries(actualChanges)) {
        (updated as Record<string, unknown>)[key] = change.new;
      }
      return updated as Cell;
    });
    this.onCellsChange?.(this.cells);
  }

  batch(operations: Operation[]): void {
    if (operations.length === 0) return;
    if (operations.length === 1) {
      this.executeOperation(operations[0]);
    } else {
      this.executeOperation({ type: 'batch', operations });
    }
  }

  flushCell(cellId: string, currentContent: string): void {
    const oldContent = this.lastContent.get(cellId);
    if (oldContent === undefined || oldContent === currentContent) return;

    this.clearRedoStack();

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

    this.lastContent.set(cellId, currentContent);
    const operationId = this.addToFullHistory(op);
    const opWithId = { ...op, operationId } as Operation;
    this.undoStack.push(opWithId);
    this.onStackChange?.(true, false);
  }

  // -------------------------------------------------------------------------
  // Convenience wrappers
  // -------------------------------------------------------------------------

  changeType(cellId: string, newType: CellType): void {
    const cell = this.cells.find(c => c.id === cellId);
    if (!cell) return;
    this.updateMetadata(cellId, { type: { old: cell.type, new: newType } });
  }

  setCellScrolled(cellId: string, scrolled: boolean): void {
    const cell = this.cells.find(c => c.id === cellId);
    if (!cell) return;
    const oldScrolled = cell.scrolled ?? false;
    if (oldScrolled === scrolled) return;
    this.updateMetadata(cellId, { scrolled: { old: oldScrolled, new: scrolled } });
  }

  setCellScrolledHeight(cellId: string, height: number): void {
    const cell = this.cells.find(c => c.id === cellId);
    if (!cell) return;
    const oldHeight = cell.scrolledHeight;
    if (oldHeight === height) return;
    this.updateMetadata(cellId, { scrolledHeight: { old: oldHeight, new: height } });
  }

  setCellSourceCollapsed(cellId: string, collapsed: boolean): void {
    const cell = this.cells.find(c => c.id === cellId);
    if (!cell) return;
    const oldCollapsed = cell.sourceCollapsed ?? false;
    if (oldCollapsed === collapsed) return;
    this.updateMetadata(cellId, { sourceCollapsed: { old: oldCollapsed, new: collapsed } });
  }

  setCellSourceHeight(cellId: string, height: number): void {
    const cell = this.cells.find(c => c.id === cellId);
    if (!cell) return;
    const oldHeight = cell.sourceHeight;
    if (oldHeight === height) return;
    this.updateMetadata(cellId, { sourceHeight: { old: oldHeight, new: height } });
  }

  // -------------------------------------------------------------------------
  // Undo/Redo
  // -------------------------------------------------------------------------

  peekUndo(): UndoRedoResult | null {
    if (this.undoStack.length === 0) return null;
    const op = this.undoStack[this.undoStack.length - 1];
    const reversedOp = reverseOperation(op);
    return {
      affectedCellIds: getAffectedCellIds(reversedOp, this.cells),
      operationType: op.type
    };
  }

  peekRedo(): UndoRedoResult | null {
    if (this.redoStack.length === 0) return null;
    const op = this.redoStack[this.redoStack.length - 1];
    return {
      affectedCellIds: getAffectedCellIds(op, this.cells),
      operationType: op.type
    };
  }

  undo(): UndoRedoResult | null {
    if (this.undoStack.length === 0) return null;

    const op = this.undoStack.pop()!;
    const reversedOp = reverseOperation(op);

    this.cells = applyOperation(this.cells, reversedOp);
    this.onCellsChange?.(this.cells);

    this.redoStack.push(op);
    this.onStackChange?.(this.undoStack.length > 0, true);

    this.updateContentTrackingAfterUndo(op);

    return {
      affectedCellIds: getAffectedCellIds(reversedOp, this.cells),
      operationType: op.type
    };
  }

  redo(): UndoRedoResult | null {
    if (this.redoStack.length === 0) return null;

    const op = this.redoStack.pop()!;

    this.cells = applyOperation(this.cells, op);
    this.onCellsChange?.(this.cells);

    this.undoStack.push(op);
    this.onStackChange?.(true, this.redoStack.length > 0);

    this.updateContentTrackingAfterOp(op);

    return {
      affectedCellIds: getAffectedCellIds(op, this.cells),
      operationType: op.type
    };
  }

  // -------------------------------------------------------------------------
  // History persistence
  // -------------------------------------------------------------------------

  getFullHistory(): TimestampedOperation[] {
    return this.fullHistory.map(convertToCompactFormat);
  }

  loadHistory(history: TimestampedOperation[]): void {
    if (history.length > 0 && history[0].type === 'snapshot') {
      this.fullHistory = [...history];
    } else if (history.length > 0) {
      const currentSnapshot = this.fullHistory.find(op => op.type === 'snapshot');
      if (currentSnapshot) {
        this.fullHistory = [currentSnapshot, ...history];
      } else {
        this.fullHistory = [...history];
      }
    }

    this.undoStack = rebuildUndoStack(this.fullHistory);
    this.redoStack = [];
    this.onStackChange?.(this.undoStack.length > 0, false);
  }

  loadCells(newCells: Cell[]): void {
    this.cells = newCells;
    this.onCellsChange?.(this.cells);
    this.undoStack = [];
    this.redoStack = [];
    this.onStackChange?.(false, false);
    this.initializeContentTracking(newCells);
  }

  initializeNewHistory(newCells: Cell[]): void {
    this.cells = newCells;
    this.onCellsChange?.(this.cells);
    this.undoStack = [];
    this.redoStack = [];
    this.onStackChange?.(false, false);
    this.initializeContentTracking(newCells);

    this.fullHistory = [{
      type: 'snapshot',
      cells: newCells.map(stripCellOutputs),
      timestamp: Date.now()
    }];
  }

  logOperation(op: LogOperation): void {
    this.addToFullHistory(op);
  }

  commitHistoryBeforeKeyframe(): void {
    this.clearRedoStack();
  }

  hasRedoToFlush(): boolean {
    return this.redoStack.length > 0;
  }

  // -------------------------------------------------------------------------
  // Session state
  // -------------------------------------------------------------------------

  getUnflushedState(activeCellId: string | null): UnflushedState | null {
    if (!activeCellId) return null;

    const cell = this.cells.find(c => c.id === activeCellId);
    if (!cell) return null;

    const lastFlushedContent = this.lastContent.get(activeCellId);
    if (lastFlushedContent === undefined) return null;
    if (lastFlushedContent === cell.content) return null;

    return {
      cellId: activeCellId,
      lastFlushedContent
    };
  }

  setUnflushedState(state: UnflushedState | null): void {
    if (!state) return;
    this.lastContent.set(state.cellId, state.lastFlushedContent);
  }

  // -------------------------------------------------------------------------
  // Update tracking for agent awareness
  // -------------------------------------------------------------------------

  getUpdatesSince(sinceTimestamp: number): UpdateSummary[] {
    const summaries: UpdateSummary[] = [];
    const cells = this.cells;

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

    for (const op of this.fullHistory) {
      if (op.timestamp <= sinceTimestamp) continue;
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
          if (op.toIndex >= 0 && op.toIndex < cells.length) {
            cellId = cells[op.toIndex].id;
          }
          description = `Moved cell from #${op.fromIndex + 1} to #${op.toIndex + 1}`;
          break;
        case 'updateContent': {
          cellId = op.cellId;
          cellIndex = cells.findIndex(c => c.id === op.cellId);
          if (cellIndex === -1) cellIndex = undefined;
          const preview = op.newContent.slice(0, 50).replace(/\n/g, ' ');
          description = `Edited cell${cellIndex !== undefined ? ` #${cellIndex + 1}` : ''}: "${preview}${preview.length >= 50 ? '...' : ''}"`;
          break;
        }
        case 'updateContentPatch': {
          cellId = op.cellId;
          cellIndex = cells.findIndex(c => c.id === op.cellId);
          if (cellIndex === -1) cellIndex = undefined;
          description = `Edited cell${cellIndex !== undefined ? ` #${cellIndex + 1}` : ''}: "[content updated]"`;
          break;
        }
        case 'updateMetadata': {
          cellId = op.cellId;
          cellIndex = cells.findIndex(c => c.id === op.cellId);
          if (cellIndex === -1) cellIndex = undefined;
          const changes = Object.keys(op.changes).join(', ');
          description = `Changed ${changes} on cell${cellIndex !== undefined ? ` #${cellIndex + 1}` : ''}`;
          break;
        }
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
  }
}
