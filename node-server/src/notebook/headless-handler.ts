/**
 * Headless Operation Handler
 *
 * Handles notebook operations when no UI is connected to Nebula.
 * Mirrors useOperationHandler (React) but operates on files instead of UI state.
 */

import * as fs from 'fs';
import { hashCellContent } from './cell-hash';
import * as path from 'path';
import * as os from 'os';
import { privateTmpDir } from '../private-tmp';
import { v4 as uuidv4 } from 'uuid';
import { getFormatAdapter } from '../fs/notebook-formats/registry';
import { FilesystemService } from '../fs/fs-service';
import { NebulaCell, CellOutput } from '../fs/types';
import { validateMetadataValue } from './cell-metadata';
import { KernelService } from '../kernel/kernel-service';
import {
  getUndoRedoManager,
  HeadlessUndoRedoManager,
  LogOperation,
  UndoableOperation,
  UpdateSummary,
} from './undoRedoManager';
import { getKernelSpec } from '../kernel/kernelspec';
import { isProxiedSession, startRemoteKernel, executeRemoteCode } from '../cluster/kernel-proxy';

function copyCellOutput(output: Partial<CellOutput>): CellOutput {
  return {
    type: (output.type || 'stdout') as CellOutput['type'],
    content: output.content || '',
    ...(output.mimeBundle ? { mimeBundle: output.mimeBundle } : {}),
    ...(output.metadata ? { metadata: output.metadata } : {}),
    ...(output.preferredMimeType ? { preferredMimeType: output.preferredMimeType } : {}),
  };
}

// Output truncation defaults
const OUTPUT_DEFAULT_MAX_LINES = 100;
const OUTPUT_DEFAULT_MAX_CHARS = 10000;
const OUTPUT_DEFAULT_MAX_LINES_ERROR = 200;
const OUTPUT_DEFAULT_MAX_CHARS_ERROR = 20000;

interface NotebookCache {
  cells: NebulaCell[];
  metadata: Record<string, unknown>;
  dirty: boolean;
}

interface OperationResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

interface TruncationMetadata {
  truncated: boolean;
  truncation_reason?: string | null;
  total_lines: number;
  total_chars: number;
  returned_range: {
    start_line: number;
    end_line: number;
    char_count: number;
  };
}

interface AgentLockInfo {
  agentId: string;
  clientName?: string;
  clientVersion?: string;
  expiresAt: number;
  lockedAt: number;
}

interface OperationRouterInterface {
  startAgentSession: (path: string, agentId: string, metadata?: { clientName?: string; clientVersion?: string }) => { success: boolean; error?: string; lock?: AgentLockInfo };
  endAgentSession: (path: string, agentId: string) => { success: boolean; error?: string };
}

export class HeadlessOperationHandler {
  private fsService: FilesystemService;
  private kernelService: KernelService | null;
  private operationRouter: OperationRouterInterface | null;
  private undoRedoManager: HeadlessUndoRedoManager;
  private cache: Map<string, NotebookCache> = new Map();
  private writeLocks: Map<string, Promise<void>> = new Map();

  constructor(
    fsService: FilesystemService,
    operationRouter?: OperationRouterInterface,
    kernelService?: KernelService
  ) {
    this.fsService = fsService;
    this.operationRouter = operationRouter || null;
    this.kernelService = kernelService || null;
    this.undoRedoManager = getUndoRedoManager(this.fsService);
  }

  /**
   * Get notebook from cache, loading from disk if needed.
   */
  private getCachedNotebook(notebookPath: string): NotebookCache {
    if (!this.cache.has(notebookPath)) {
      const result = this.fsService.getNotebookCellsSync(notebookPath);
      this.cache.set(notebookPath, {
        cells: result.cells || [],
        metadata: result.metadata || {},
        dirty: false,
      });
    }
    return this.cache.get(notebookPath)!;
  }

  /** In-flight cache warm-ups per notebook path (single-flight). */
  private warming: Map<string, Promise<void>> = new Map();

  /**
   * Warm the notebook + undo-history caches with non-blocking I/O. The sync
   * fallback in getCachedNotebook blocks the event loop on a cache miss — on
   * a network filesystem a large notebook + history read stalls every
   * in-flight request (kernel completions included) for seconds. Entry points
   * await this first so the sync accessors below are pure in-memory hits.
   */
  private ensureCached(notebookPath: string): Promise<void> {
    if (!notebookPath || this.cache.has(notebookPath)) return Promise.resolve();

    const inflight = this.warming.get(notebookPath);
    if (inflight) return inflight;

    const run = (async () => {
      const result = await this.fsService.getNotebookCells(notebookPath);
      if (!this.cache.has(notebookPath)) {
        this.cache.set(notebookPath, {
          cells: result.cells || [],
          metadata: result.metadata || {},
          dirty: false,
        });
      }
      await this.undoRedoManager.warm(notebookPath, this.cache.get(notebookPath)!.cells);
    })().finally(() => {
      this.warming.delete(notebookPath);
    });
    this.warming.set(notebookPath, run);
    return run;
  }

  private getCells(notebookPath: string): NebulaCell[] {
    return this.getCachedNotebook(notebookPath).cells;
  }

  private getVisibleOutputs(cell: NebulaCell): CellOutput[] {
    if (cell.pendingOutputReset) {
      return [];
    }
    return cell.outputs || [];
  }

  private saveCells(notebookPath: string, cells: NebulaCell[]): void {
    const notebook = this.getCachedNotebook(notebookPath);
    notebook.cells = cells;
    notebook.dirty = true;
  }

  /**
   * Persist dirty notebooks to disk.
   */
  async flush(notebookPath?: string): Promise<void> {
    const paths = notebookPath ? [notebookPath] : Array.from(this.cache.keys());

    for (const p of paths) {
      // A scheduled persist may have already cleared the dirty flag but not
      // finished writing — flush must wait for it, or callers read a stale
      // file. The persist loop keeps writing while dirty, so awaiting the
      // in-flight run covers later mutations too.
      const inFlight = this.persisting.get(p);
      if (inFlight) {
        await inFlight;
      }
      if (this.cache.get(p)?.dirty) {
        await this.asyncPersist(p);
      }
    }
  }

  /** In-flight persist per notebook path (single-flight). */
  private persisting = new Map<string, Promise<void>>();

  private asyncPersist(notebookPath: string): Promise<void> {
    const existing = this.persisting.get(notebookPath);
    if (existing) return existing;

    const run = (async () => {
      const notebook = this.cache.get(notebookPath);
      if (!notebook) return;

      // Keep writing while dirty
      while (notebook.dirty) {
        const cells = JSON.parse(JSON.stringify(notebook.cells));
        notebook.dirty = false;
        const history = this.undoRedoManager.getHistory(notebookPath, cells);
        await this.fsService.saveNotebookBundle(notebookPath, cells, undefined, history);
      }
    })().finally(() => {
      this.persisting.delete(notebookPath);
    });
    this.persisting.set(notebookPath, run);
    return run;
  }

  private schedulePersist(notebookPath: string): void {
    // Schedule async persist
    this.asyncPersist(notebookPath).catch(err => {
      console.error(`[HeadlessHandler] Failed to persist ${notebookPath}:`, err);
    });
  }

  /**
   * Invalidate cache for a notebook.
   */
  invalidate(notebookPath?: string): void {
    if (notebookPath) {
      this.cache.delete(notebookPath);
    } else {
      this.cache.clear();
    }
    // Undo/redo state is derived from the persisted history file; when the
    // notebook may have changed underneath us (UI save, external edit
    // reconciliation), rebuild it from disk on next access.
    this.undoRedoManager.clearState(notebookPath);
  }

  /**
   * Check if notebook has unsaved changes.
   */
  isDirty(notebookPath: string): boolean {
    return this.cache.get(notebookPath)?.dirty || false;
  }

  /**
   * Check if agent has permission to modify this notebook.
   */
  private async checkAgentPermission(notebookPath: string, _operationType: string): Promise<OperationResult | null> {
    const status = await this.fsService.getAgentPermissionStatusAsync(notebookPath);

    // can_agent_modify already encodes the tri-state rule (agent-created notebooks
    // are permitted unless explicitly revoked; user notebooks need permission +
    // history), so an explicit user revoke wins even for agent-created notebooks.
    if (status.can_agent_modify) {
      return null;
    }

    // User-permitted but history not yet enabled (soft, fixable) vs. not permitted.
    if (status.agent_permitted && !status.has_history && !status.agent_created) {
      return {
        success: false,
        error: `Agent cannot modify "${notebookPath}": notebook is user-permitted but history is not enabled. Open the notebook in the UI first to enable history tracking, or the agent can create a new notebook.`,
      };
    }

    return {
      success: false,
      error: `Agent cannot modify "${notebookPath}": notebook is not agent-permitted (agent access may have been revoked). Either open the notebook in Nebula UI and grant agent permission, or the agent can create a new notebook which will be automatically permitted.`,
    };
  }

  /**
   * Compare expectedHash/expectedHashes stamped by the operation router
   * against current cell content. Returns a conflict result, or null to
   * proceed. The conflict message carries the current content so the agent
   * can re-apply its intent without an extra read.
   */
  private checkExpectedHashes(operation: Record<string, unknown>, notebookPath: string): OperationResult | null {
    const expectedHash = operation.expectedHash as string | undefined;
    const expectedHashes = operation.expectedHashes as Record<string, string> | undefined;
    if (!expectedHash && !expectedHashes) return null;
    if (!notebookPath) return null;

    const cells = this.getCells(notebookPath);
    const checks: Array<{ cellId: string; expected: string }> = [];
    if (expectedHash && typeof operation.cellId === 'string') {
      checks.push({ cellId: operation.cellId, expected: expectedHash });
    }
    if (expectedHashes) {
      for (const [cellId, expected] of Object.entries(expectedHashes)) {
        checks.push({ cellId, expected });
      }
    }

    for (const { cellId, expected } of checks) {
      const cell = cells.find(c => c.id === cellId);
      if (!cell) {
        return {
          success: false,
          conflict: true,
          error: `Conflict: cell ${cellId} no longer exists (it changed since you last read it). Re-read the notebook and retry.`,
        };
      }
      const current = hashCellContent(cell.content ?? '');
      if (current !== expected) {
        const preview = (cell.content ?? '').slice(0, 2000);
        return {
          success: false,
          conflict: true,
          error:
            `Conflict: cell ${cellId} was modified (likely by the user) after you last read it. ` +
            `Current content:\n${preview}${(cell.content ?? '').length > 2000 ? '\n…(truncated)' : ''}\n` +
            `Re-apply your intent against this content and retry — your next write to this cell is validated against the content shown above, so no re-read is needed.`,
          currentContent: cell.content,
        };
      }
    }
    return null;
  }

  /**
   * Apply a notebook operation.
   */
  async applyOperation(operation: Record<string, unknown>): Promise<OperationResult> {
    const opType = operation.type as string;
    const notebookPath = (operation.notebookPath as string) || '';

    // Read-only operations
    const readOnlyOps = new Set(['readCell', 'readCellOutput', 'searchCells', 'getUpdatesSince', 'startAgentSession', 'endAgentSession']);
    const permissionExemptOps = new Set(['createNotebook', 'readCell', 'readCellOutput', 'searchCells', 'getUpdatesSince', 'startAgentSession', 'endAgentSession']);

    // Warm the notebook/history caches without blocking the event loop before
    // any sync accessor below runs. createNotebook targets a file that may
    // not exist yet; a failed warm defers to the operation's own error.
    if (notebookPath && opType !== 'createNotebook') {
      try {
        await this.ensureCached(notebookPath);
      } catch {
        // Operation handlers report missing/corrupt notebooks themselves
      }
    }

    // Check permission for write operations
    if (!permissionExemptOps.has(opType) && notebookPath) {
      const permissionError = await this.checkAgentPermission(notebookPath, opType);
      if (permissionError) {
        return permissionError;
      }
    }

    // Optimistic concurrency: collaborative agent sessions stamp destructive
    // writes with the content hash the agent last saw (see operation-router).
    // Verify against current content before applying.
    const occConflict = this.checkExpectedHashes(operation, notebookPath);
    if (occConflict) {
      return occConflict;
    }

    try {
      let result: OperationResult;

      switch (opType) {
        case 'insertCell':
          result = await this.insertCell(operation);
          break;
        case 'deleteCell':
          result = await this.deleteCell(operation);
          break;
        case 'updateContent':
          result = await this.updateContent(operation);
          break;
        case 'updateMetadata':
          result = await this.updateMetadata(operation);
          break;
        case 'moveCell':
          result = await this.moveCell(operation);
          break;
        case 'duplicateCell':
          result = await this.duplicateCell(operation);
          break;
        case 'updateOutputs':
          result = await this.updateOutputs(operation);
          break;
        case 'createNotebook':
          result = await this.createNotebook(operation);
          break;
        case 'readCell':
          result = await this.readCell(operation);
          break;
        case 'readCellOutput':
          result = await this.readCellOutput(operation);
          break;
        case 'clearNotebook':
          result = await this.clearNotebook(operation);
          break;
        case 'deleteCells':
          result = await this.deleteCells(operation);
          break;
        case 'insertCells':
          result = await this.insertCells(operation);
          break;
        case 'searchCells':
          result = await this.searchCells(operation);
          break;
        case 'getUpdatesSince': {
          const sinceTimestamp = (operation.sinceTimestamp as number) || 0;
          const updatesSince = this.getUpdatesSince(notebookPath, sinceTimestamp);
          result = {
            success: true,
            updatesSince,
            serverTimestamp: Date.now(),
          };
          break;
        }
        case 'clearOutputs':
          result = await this.clearOutputs(operation);
          break;
        case 'startKernel':
          result = await this.startKernelOp(operation, notebookPath);
          break;
        case 'shutdownKernel':
          result = await this.shutdownKernelOp(notebookPath);
          break;
        case 'restartKernel':
          result = await this.restartKernelOp(notebookPath);
          break;
        case 'interruptKernel':
          result = await this.interruptKernelOp(notebookPath);
          break;
        case 'executeCell':
          result = await this.executeCell(operation, notebookPath);
          break;
        case 'startAgentSession': {
          const agentId = (operation.agentId as string) || 'unknown';
          const clientName = operation.clientName as string | undefined;
          const clientVersion = operation.clientVersion as string | undefined;
          if (this.operationRouter) {
            result = this.operationRouter.startAgentSession(notebookPath, agentId, { clientName, clientVersion });
          } else {
            result = { success: true, lock: { agentId, clientName, clientVersion, expiresAt: Date.now() + 5 * 60 * 1000, lockedAt: Date.now() } };
          }
          break;
        }
        case 'endAgentSession': {
          const agentId = (operation.agentId as string) || 'unknown';
          if (this.operationRouter) {
            result = this.operationRouter.endAgentSession(notebookPath, agentId);
          } else {
            result = { success: true };
          }
          break;
        }
        case 'undo':
          result = await this.handleUndo(notebookPath);
          break;
        case 'redo':
          result = await this.handleRedo(notebookPath);
          break;
        default:
          return { success: false, error: `Unknown operation type: ${opType}` };
      }

      // Schedule persist for write operations
      if (result.success && !readOnlyOps.has(opType) && notebookPath) {
        this.schedulePersist(notebookPath);
      }

      return result;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Read notebook from cache with optional output truncation.
   */
  async readNotebook(
    notebookPath: string,
    includeOutputs = true,
    maxLines?: number,
    maxChars?: number,
    maxLinesError?: number,
    maxCharsError?: number
  ): Promise<OperationResult> {
    try {
      // Non-blocking cache warm-up; on failure the sync accessor below
      // produces the proper error (e.g. notebook not found).
      try {
        await this.ensureCached(notebookPath);
      } catch {
        // fall through to getCachedNotebook's own error handling
      }
      const notebook = this.getCachedNotebook(notebookPath);
      let cells = notebook.cells;

      if (includeOutputs) {
        const effectiveMaxLines = maxLines ?? OUTPUT_DEFAULT_MAX_LINES;
        const effectiveMaxChars = maxChars ?? OUTPUT_DEFAULT_MAX_CHARS;
        const effectiveMaxLinesError = maxLinesError ?? OUTPUT_DEFAULT_MAX_LINES_ERROR;
        const effectiveMaxCharsError = maxCharsError ?? OUTPUT_DEFAULT_MAX_CHARS_ERROR;
        cells = this.truncateCellOutputs(cells, effectiveMaxLines, effectiveMaxChars, effectiveMaxLinesError, effectiveMaxCharsError);
      } else {
        cells = cells.map(cell => ({ ...cell, outputs: [] }));
      }

      return {
        success: true,
        data: {
          path: notebookPath,
          cells,
          metadata: notebook.metadata,
        },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  private truncateCellOutputs(
    cells: NebulaCell[],
    maxLines: number,
    maxChars: number,
    maxLinesError: number,
    maxCharsError: number
  ): NebulaCell[] {
    return cells.map(cell => ({
      ...cell,
      outputs: (cell.outputs || []).map(output => {
        const outputType = output.type || 'stdout';
        const content = output.content || '';

        let result: CellOutput;
        // Skip truncation for binary/image outputs
        if (outputType === 'image' || outputType === 'html' || outputType === 'display_data') {
          result = {
            ...output,
            type: outputType,
            content,
            is_binary: outputType === 'image',
          } as CellOutput;
        } else {
          // Use separate limits for error outputs
          const linesLimit = outputType === 'error' ? maxLinesError : maxLines;
          const charsLimit = outputType === 'error' ? maxCharsError : maxChars;

          const { truncatedContent, metadata } = this.truncateOutput(content, linesLimit, charsLimit, 0);

          result = {
            ...output,
            type: outputType,
            content: truncatedContent,
            ...metadata,
          } as CellOutput;
        }

        // Strip internal-only fields: `id`/`timestamp` are stamped by convertOutputs
        // for the live UI, but the headless/MCP read contract returns clean outputs
        // (see the "should apply output truncation" test).
        const mutable = result as unknown as Record<string, unknown>;
        delete mutable.id;
        delete mutable.timestamp;
        return result;
      }),
    }));
  }

  private truncateOutput(
    content: string,
    maxLines: number,
    maxChars: number,
    lineOffset = 0
  ): { truncatedContent: string; metadata: TruncationMetadata } {
    const lines = content.split('\n');
    const totalLines = lines.length;
    const totalChars = content.length;

    const offsetLines = lines.slice(lineOffset);
    const startLine = lineOffset;
    let endLine = startLine;
    let charCount = 0;
    let truncated = false;
    let truncationReason: string | null = null;
    const resultLines: string[] = [];

    for (let i = 0; i < offsetLines.length; i++) {
      const line = offsetLines[i];
      const newCharCount = charCount + line.length + (i > 0 ? 1 : 0);

      if (i >= maxLines) {
        truncated = true;
        truncationReason = 'lines';
        break;
      }

      if (newCharCount > maxChars && i > 0) {
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
      truncatedContent,
      metadata: {
        truncated,
        truncation_reason: truncationReason,
        total_lines: totalLines,
        total_chars: totalChars,
        returned_range: {
          start_line: startLine,
          end_line: endLine,
          char_count: truncatedContent.length,
        },
      },
    };
  }

  // Operation implementations

  private async insertCell(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const index = operation.index as number;
    const cellData = operation.cell as Record<string, unknown>;
    const metadata = (cellData.metadata as Record<string, unknown> | undefined) || {};

    const cells = this.getCells(notebookPath);
    let cellId = cellData.id as string;
    const existingIds = new Set(cells.map(c => c.id));
    const originalId = cellId;
    let idModified = false;

    if (existingIds.has(cellId)) {
      let counter = 2;
      while (existingIds.has(`${originalId}-${counter}`)) {
        counter++;
      }
      cellId = `${originalId}-${counter}`;
      idModified = true;
    }

    const newCell: NebulaCell = {
      id: cellId,
      type: (cellData.type as 'code' | 'markdown') || 'code',
      content: (cellData.content as string) || '',
      outputs: [],
      isExecuting: false,
      executionCount: null,
      scrolled: metadata.scrolled as boolean | undefined,
      scrolledHeight: metadata.scrolledHeight as number | undefined,
    };

    let actualIndex: number;
    if (index === -1 || index >= cells.length) {
      cells.push(newCell);
      actualIndex = cells.length - 1;
    } else {
      cells.splice(index, 0, newCell);
      actualIndex = index;
    }

    this.saveCells(notebookPath, cells);

    // Record operation for undo/redo
    this.recordUndoableOperation(notebookPath, {
      type: 'insertCell',
      index: actualIndex,
      cell: newCell,
      source: 'mcp'
    });

    return {
      success: true,
      cellId,
      cellIndex: actualIndex,
      idModified,
      requestedId: idModified ? originalId : null,
      totalCells: cells.length,
    };
  }

  private async deleteCell(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string | undefined;
    const cellIndex = operation.cellIndex as number | undefined;

    const cells = this.getCells(notebookPath);

    let targetIndex: number | null = null;
    if (cellId) {
      targetIndex = cells.findIndex(c => c.id === cellId);
      if (targetIndex === -1) targetIndex = null;
    } else if (cellIndex !== undefined) {
      targetIndex = cellIndex;
    }

    if (targetIndex === null || targetIndex >= cells.length) {
      return { success: false, error: 'Cell not found' };
    }

    // Save the cell for undo before deleting
    const deletedCell = { ...cells[targetIndex] };

    cells.splice(targetIndex, 1);
    this.saveCells(notebookPath, cells);

    // Record operation for undo/redo
    this.recordUndoableOperation(notebookPath, {
      type: 'deleteCell',
      index: targetIndex,
      cell: deletedCell,
      source: 'mcp'
    });

    return {
      success: true,
      cellIndex: targetIndex,
      totalCells: cells.length,
    };
  }

  private async updateContent(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string;
    const content = operation.content as string;

    const cells = this.getCells(notebookPath);
    const targetIndex = cells.findIndex(c => c.id === cellId);

    if (targetIndex === -1) {
      return { success: false, error: `Cell with ID "${cellId}" not found` };
    }

    // Save old content for undo
    const oldContent = cells[targetIndex].content;

    cells[targetIndex].content = content;
    this.saveCells(notebookPath, cells);

    // Record operation for undo/redo (only if content changed)
    if (oldContent !== content) {
      this.recordUndoableOperation(notebookPath, {
        type: 'updateContent',
        cellId,
        oldContent,
        newContent: content,
        source: 'mcp'
      });
    }

    return {
      success: true,
      cellId,
      cellIndex: targetIndex,
    };
  }

  private async updateMetadata(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string;
    const changes = operation.changes as Record<string, unknown>;

    // Validate all changes
    const errors: string[] = [];
    for (const [key, value] of Object.entries(changes)) {
      const validation = validateMetadataValue(key, value);
      if (!validation.valid) {
        errors.push(validation.error || `Invalid field: ${key}`);
      }
    }
    if (errors.length > 0) {
      return { success: false, error: errors.join('; ') };
    }

    const cells = this.getCells(notebookPath);
    const targetIndex = cells.findIndex(c => c.id === cellId);

    if (targetIndex === -1) {
      return { success: false, error: `Cell with ID "${cellId}" not found` };
    }

    const cell = cells[targetIndex];
    const oldValues: Record<string, unknown> = {};

    // Handle ID change specially
    if ('id' in changes) {
      const newId = changes.id as string;
      const existingIds = new Set(cells.map(c => c.id));
      existingIds.delete(cellId);

      let actualNewId = newId;
      let idModified = false;

      if (existingIds.has(newId)) {
        let counter = 2;
        while (existingIds.has(`${newId}-${counter}`)) {
          counter++;
        }
        actualNewId = `${newId}-${counter}`;
        idModified = true;
      }

      oldValues.id = cellId;
      cell.id = actualNewId;
    }

    // Apply other changes
    for (const [key, value] of Object.entries(changes)) {
      if (key === 'id') continue;
      oldValues[key] = (cell as unknown as Record<string, unknown>)[key];
      (cell as unknown as Record<string, unknown>)[key] = value;
    }

    this.saveCells(notebookPath, cells);

    // Record operation for undo/redo
    const metadataChanges: Record<string, { old: unknown; new: unknown }> = {};
    for (const [k, v] of Object.entries(changes)) {
      metadataChanges[k] = { old: oldValues[k], new: v };
    }
    this.recordUndoableOperation(notebookPath, {
      type: 'updateMetadata',
      cellId: cell.id,
      changes: metadataChanges,
      source: 'mcp'
    });

    return {
      success: true,
      cellId: cell.id,
      cellIndex: targetIndex,
      changes: Object.fromEntries(
        Object.entries(changes).map(([k, v]) => [k, { old: oldValues[k], new: v }])
      ),
    };
  }

  private async moveCell(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string | undefined;
    let fromIndex = operation.fromIndex as number | undefined;
    let toIndex = operation.toIndex as number | undefined;
    const afterCellId = operation.afterCellId as string | undefined;

    const cells = this.getCells(notebookPath);

    // Determine source
    if (cellId) {
      fromIndex = cells.findIndex(c => c.id === cellId);
      if (fromIndex === -1) {
        return { success: false, error: `Cell with ID "${cellId}" not found` };
      }
    } else if (fromIndex === undefined) {
      return { success: false, error: 'Must provide cellId or fromIndex' };
    }

    if (fromIndex < 0 || fromIndex >= cells.length) {
      return { success: false, error: 'Invalid fromIndex' };
    }

    // Determine target
    if (afterCellId) {
      const afterIndex = cells.findIndex(c => c.id === afterCellId);
      if (afterIndex === -1) {
        return { success: false, error: `Cell with ID "${afterCellId}" not found` };
      }
      toIndex = afterIndex + 1;
      if (fromIndex < toIndex) {
        toIndex--;
      }
    } else if (toIndex === -1) {
      toIndex = 0;
    } else if (toIndex === undefined) {
      return { success: false, error: 'Must provide afterCellId or toIndex' };
    }

    if (toIndex < 0 || toIndex >= cells.length) {
      return { success: false, error: 'Invalid toIndex' };
    }

    // Perform move
    const [cell] = cells.splice(fromIndex, 1);
    cells.splice(toIndex, 0, cell);
    this.saveCells(notebookPath, cells);

    // Record operation for undo/redo
    this.recordUndoableOperation(notebookPath, {
      type: 'moveCell',
      fromIndex,
      toIndex,
      source: 'mcp'
    });

    return {
      success: true,
      cellId: cell.id,
      fromIndex,
      toIndex,
    };
  }

  private async duplicateCell(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellIndex = operation.cellIndex as number;
    const newCellId = operation.newCellId as string;

    const cells = this.getCells(notebookPath);

    if (cellIndex < 0 || cellIndex >= cells.length) {
      return { success: false, error: 'Invalid cellIndex' };
    }

    const originalCell = cells[cellIndex];
    const existingIds = new Set(cells.map(c => c.id));

    let actualId = newCellId;
    let idModified = false;

    if (existingIds.has(newCellId)) {
      let counter = 2;
      while (existingIds.has(`${newCellId}-${counter}`)) {
        counter++;
      }
      actualId = `${newCellId}-${counter}`;
      idModified = true;
    }

    const newCell: NebulaCell = {
      id: actualId,
      type: originalCell.type,
      content: originalCell.content,
      outputs: [],
      isExecuting: false,
      executionCount: null,
    };

    cells.splice(cellIndex + 1, 0, newCell);
    this.saveCells(notebookPath, cells);

    return {
      success: true,
      cellId: actualId,
      cellIndex: cellIndex + 1,
      idModified,
      totalCells: cells.length,
    };
  }

  private async updateOutputs(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string;
    const outputs = operation.outputs as CellOutput[];
    const executionCount = operation.executionCount as number | undefined;

    const cells = this.getCells(notebookPath);
    const targetIndex = cells.findIndex(c => c.id === cellId);

    if (targetIndex === -1) {
      return { success: false, error: `Cell with ID "${cellId}" not found` };
    }

    cells[targetIndex].outputs = outputs.map(o => copyCellOutput(o));

    if (executionCount !== undefined) {
      cells[targetIndex].executionCount = executionCount;
    }

    this.saveCells(notebookPath, cells);

    return {
      success: true,
      cellId,
      cellIndex: targetIndex,
    };
  }

  private async createNotebook(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const overwrite = (operation.overwrite as boolean) || false;
    const kernelName = (operation.kernelName as string) || 'python3';
    const kernelDisplayName = (operation.kernelDisplayName as string) || 'Python 3';

    const normalizedPath = this.fsService.normalizePath(notebookPath);

    if (fs.existsSync(normalizedPath) && !overwrite) {
      return {
        success: false,
        error: `Notebook already exists: ${notebookPath}. Use overwrite=true to replace.`,
      };
    }

    // Text notebook formats (.py percent / .qmd): create through the format
    // adapter — agent flags live in the file's own metadata like .ipynb.
    const formatAdapter = getFormatAdapter(normalizedPath);
    if (formatAdapter) {
      const dir = path.dirname(normalizedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const metadata: Record<string, unknown> = {
        kernelspec: { name: kernelName, display_name: kernelDisplayName },
        nebula: { agent_created: true, agent_permitted: true },
      };
      if (formatAdapter.name === 'qmd') metadata.__qmd_language = 'python';
      fs.writeFileSync(normalizedPath, formatAdapter.serialize([], metadata), 'utf-8');
      this.invalidate(notebookPath);
      return {
        success: true,
        path: notebookPath,
        mtime: fs.statSync(normalizedPath).mtimeMs / 1000,
      };
    }

    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: {
          name: kernelName,
          display_name: kernelDisplayName,
        },
        language_info: {
          name: 'python',
        },
        nebula: {
          agent_created: true,
          agent_permitted: true,
        },
      },
      cells: [],
    };

    const dir = path.dirname(normalizedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(normalizedPath, JSON.stringify(notebook, null, 2), 'utf-8');

    this.invalidate(notebookPath);

    const mtime = fs.statSync(normalizedPath).mtimeMs / 1000; // Convert to seconds like Python

    return {
      success: true,
      path: notebookPath,
      mtime,
    };
  }

  private async readCell(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string | undefined;
    const cellIndex = operation.cellIndex as number | undefined;

    const cells = this.getCells(notebookPath);

    let targetIndex: number | null = null;
    let cell: NebulaCell | null = null;

    if (cellId) {
      targetIndex = cells.findIndex(c => c.id === cellId);
      if (targetIndex === -1) {
        return { success: false, error: `Cell with ID "${cellId}" not found` };
      }
      cell = cells[targetIndex];
    } else if (cellIndex !== undefined) {
      if (cellIndex < 0 || cellIndex >= cells.length) {
        return { success: false, error: `Cell index ${cellIndex} out of range` };
      }
      targetIndex = cellIndex;
      cell = cells[cellIndex];
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
        content: cell.content || '',
        outputs: (cell.outputs || []).map(o => copyCellOutput(o)),
        executionCount: cell.executionCount,
        metadata: {
          scrolled: cell.scrolled,
          scrolledHeight: cell.scrolledHeight,
        },
      },
    };
  }

  private async readCellOutput(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = (operation.cellId as string | undefined) ?? (operation.cell_id as string | undefined);
    const cellIndex = (operation.cellIndex as number | undefined) ?? (operation.cell_index as number | undefined);
    const maxLines = (operation.max_lines as number) ?? OUTPUT_DEFAULT_MAX_LINES;
    const maxChars = (operation.max_chars as number) ?? OUTPUT_DEFAULT_MAX_CHARS;
    const maxLinesError = (operation.max_lines_error as number) ?? OUTPUT_DEFAULT_MAX_LINES_ERROR;
    const maxCharsError = (operation.max_chars_error as number) ?? OUTPUT_DEFAULT_MAX_CHARS_ERROR;
    const lineOffset = (operation.line_offset as number) ?? 0;
    const saveToFile = (operation.save_to_file as boolean) ?? false;
    const maxWait = ((operation.maxWait as number | undefined) ?? (operation.max_wait as number | undefined) ?? 0); // seconds

    let cells = this.getCells(notebookPath);

    let targetIndex: number | null = null;
    let cell: NebulaCell | null = null;
    let targetCellId: string | null = null;

    if (cellId) {
      targetIndex = cells.findIndex(c => c.id === cellId);
      if (targetIndex === -1) {
        return { success: false, error: `Cell with ID "${cellId}" not found` };
      }
      cell = cells[targetIndex];
      targetCellId = cell.id;
    } else if (cellIndex !== undefined) {
      if (cellIndex < 0 || cellIndex >= cells.length) {
        return { success: false, error: `Cell index ${cellIndex} out of range` };
      }
      targetIndex = cellIndex;
      cell = cells[cellIndex];
      targetCellId = cell.id;
    } else {
      return { success: false, error: 'Must provide cellId or cellIndex' };
    }

    // Poll for new outputs if maxWait > 0
    if (maxWait > 0) {
      let visibleOutputs = this.getVisibleOutputs(cell);
      let baselineOutputCount = visibleOutputs.length;
      let baselineOutputChars = visibleOutputs.reduce((sum, o) => sum + (o.content?.length || 0), 0);
      let baselineExecutionCount = cell.executionCount;
      let wasExecuting = !!cell.isExecuting;
      const startTime = Date.now();
      const pollInterval = 500; // Poll every 500ms like Python

      while ((Date.now() - startTime) < maxWait * 1000) {
        await this.sleep(pollInterval);
        // Re-read cells from cache to detect new outputs
        cells = this.getCells(notebookPath);
        if (targetCellId) {
          targetIndex = cells.findIndex(c => c.id === targetCellId);
          if (targetIndex === -1) {
            return { success: false, error: `Cell with ID "${targetCellId}" not found` };
          }
        }
        cell = cells[targetIndex!];
        if (!cell) {
          return { success: false, error: 'Cell not found' };
        }

        // If execution starts after we began polling (e.g. queued), reset the baseline so we
        // wait for outputs from this run rather than comparing against previous outputs.
        if (!wasExecuting && cell.isExecuting) {
          wasExecuting = true;
          visibleOutputs = this.getVisibleOutputs(cell);
          baselineOutputCount = visibleOutputs.length;
          baselineOutputChars = visibleOutputs.reduce((sum, o) => sum + (o.content?.length || 0), 0);
          baselineExecutionCount = cell.executionCount;
        }
        visibleOutputs = this.getVisibleOutputs(cell);
        const currentOutputCount = visibleOutputs.length;
        const currentOutputChars = visibleOutputs.reduce((sum, o) => sum + (o.content?.length || 0), 0);
        const executionCountChanged = cell.executionCount !== baselineExecutionCount;

        // Check if outputs changed (more outputs or more content)
        if (currentOutputCount > baselineOutputCount || currentOutputChars > baselineOutputChars || executionCountChanged) {
          break; // New output arrived
        }

        // If the cell finished executing but produced no additional output, stop waiting.
        if (wasExecuting && !cell.isExecuting) {
          break;
        }

        // If the cell is already idle, there is no in-flight execution to wait on.
        if (!wasExecuting && !cell.isExecuting) {
          break;
        }
      }
    }

    const processedOutputs: Record<string, unknown>[] = [];
    const tempFiles: string[] = [];

    for (const output of this.getVisibleOutputs(cell)) {
      const outputType = output.type || 'stdout';
      const content = output.content || '';

      // Images are returned as-is
      if (outputType === 'image') {
        processedOutputs.push({
          type: outputType,
          content,
          truncated: false,
          is_binary: true,
        });
        continue;
      }

      // Save to temp file if requested
      let tempFilePath: string | undefined;
      if (saveToFile && content) {
        tempFilePath = this.saveOutputToTempFile(content, cell.id);
        tempFiles.push(tempFilePath);
      }

      // Use separate limits for errors
      const linesLimit = outputType === 'error' ? maxLinesError : maxLines;
      const charsLimit = outputType === 'error' ? maxCharsError : maxChars;

      const { truncatedContent, metadata } = this.truncateOutput(content, linesLimit, charsLimit, lineOffset);

      const processedOutput: Record<string, unknown> = {
        type: outputType,
        content: truncatedContent,
        ...metadata,
      };

      if (tempFilePath) {
        processedOutput.temp_file = tempFilePath;
        processedOutput.temp_file_size = content.length;
      }

      processedOutputs.push(processedOutput);
    }

    return {
      success: true,
      cellId: cell.id,
      cellIndex: targetIndex,
      outputs: processedOutputs,
      executionCount: cell.executionCount,
      executionStatus: cell.isExecuting ? 'busy' : 'idle',
      output_count: processedOutputs.length,
      temp_files: tempFiles.length > 0 ? tempFiles : null,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private saveOutputToTempFile(content: string, cellId: string): string {
    const tempDir = privateTmpDir('outputs');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const filename = `cell_output_${cellId}_${uuidv4().slice(0, 8)}.txt`;
    const filepath = path.join(tempDir, filename);

    fs.writeFileSync(filepath, content, 'utf-8');
    return filepath;
  }

  private async clearNotebook(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;

    const cells = this.getCells(notebookPath);
    const deletedCount = cells.length;

    if (deletedCount === 0) {
      return { success: true, deletedCount: 0 };
    }

    // Delete from end to start to avoid index shifting issues
    for (let i = cells.length - 1; i >= 0; i--) {
      const deletedCell = { ...cells[i] };
      cells.splice(i, 1);
      this.saveCells(notebookPath, cells);

      this.recordUndoableOperation(notebookPath, {
        type: 'deleteCell',
        index: i,
        cell: deletedCell,
        source: 'mcp'
      });
    }

    return {
      success: true,
      deletedCount,
    };
  }

  private async deleteCells(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellIds = (operation.cellIds as string[]) || [];

    if (cellIds.length === 0) {
      return { success: false, error: 'No cell IDs provided' };
    }

    const cells = this.getCells(notebookPath);
    const deletedIds: string[] = [];
    const notFound: string[] = [];

    const indicesToDelete: number[] = [];
    for (const cellId of cellIds) {
      const idx = cells.findIndex(c => c.id === cellId);
      if (idx !== -1) {
        indicesToDelete.push(idx);
        deletedIds.push(cellId);
      } else {
        notFound.push(cellId);
      }
    }

    // Delete in reverse order
    for (const idx of indicesToDelete.sort((a, b) => b - a)) {
      cells.splice(idx, 1);
    }

    this.saveCells(notebookPath, cells);

    return {
      success: true,
      deletedCount: deletedIds.length,
      deletedIds,
      notFound: notFound.length > 0 ? notFound : null,
      totalCells: cells.length,
    };
  }

  private async insertCells(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const position = (operation.position as number) ?? -1;
    const newCells = (operation.cells as Record<string, unknown>[]) || [];

    if (newCells.length === 0) {
      return { success: false, error: 'No cells provided' };
    }

    const cells = this.getCells(notebookPath);
    const insertedCells: NebulaCell[] = [];

    for (let i = 0; i < newCells.length; i++) {
      const cellData = newCells[i];
      const cellId = (cellData.id as string) || `cell-${cells.length + i}-${Date.now()}`;
      insertedCells.push({
        id: cellId,
        type: (cellData.type as 'code' | 'markdown') || 'code',
        content: (cellData.content as string) || '',
        outputs: (cellData.outputs as CellOutput[]) || [],
        isExecuting: false,
        executionCount: (cellData.executionCount as number | null) ?? null,
      });
    }

    let insertIndex: number;
    if (position < 0 || position >= cells.length) {
      insertIndex = cells.length;
      cells.push(...insertedCells);
    } else {
      insertIndex = position;
      cells.splice(position, 0, ...insertedCells);
    }

    this.saveCells(notebookPath, cells);

    return {
      success: true,
      insertedCount: insertedCells.length,
      insertedIds: insertedCells.map(c => c.id),
      startIndex: insertIndex,
      totalCells: cells.length,
    };
  }

  private async searchCells(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const query = (operation.query as string) || '';
    const includeOutputs = (operation.includeOutputs as boolean) ?? false;
    const limit = (operation.limit as number) ?? 10;

    if (!query) {
      return { success: false, error: 'No search query provided' };
    }

    const cells = this.getCells(notebookPath);
    const queryLower = query.toLowerCase();
    const matches: Record<string, unknown>[] = [];

    for (let i = 0; i < cells.length && matches.length < limit; i++) {
      const cell = cells[i];
      const content = cell.content || '';

      // Search in source
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
          matchLine,
          preview: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
        });
      }

      // Search in outputs
      if (includeOutputs) {
        for (let j = 0; j < (cell.outputs || []).length; j++) {
          const output = cell.outputs![j];
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

  private async clearOutputs(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string | undefined;
    const cellIds = (operation.cellIds as string[]) || [];

    // Support both single ID and list
    const targetIds = cellId && cellIds.length === 0 ? [cellId] : cellIds;

    const cells = this.getCells(notebookPath);
    const clearedIds: string[] = [];
    const notFound: string[] = [];

    if (targetIds.length === 0) {
      // Clear all cells
      for (const cell of cells) {
        if (cell.outputs && cell.outputs.length > 0) {
          cell.outputs = [];
          clearedIds.push(cell.id);
        }
      }
    } else {
      // Clear specific cells
      for (const id of targetIds) {
        const cell = cells.find(c => c.id === id);
        if (cell) {
          cell.outputs = [];
          clearedIds.push(id);
        } else {
          notFound.push(id);
        }
      }
    }

    this.saveCells(notebookPath, cells);

    return {
      success: true,
      clearedCount: clearedIds.length,
      clearedIds,
      notFound: notFound.length > 0 ? notFound : null,
    };
  }

  /**
   * Execute a cell using the kernel service.
   * Matches Python headless_handler._execute_cell() behavior.
   */
  private async executeCell(operation: Record<string, unknown>, notebookPath: string): Promise<OperationResult> {
    const cellId = (operation.cellId as string | undefined) ?? (operation.cell_id as string | undefined);
    const cellIndex = (operation.cellIndex as number | undefined) ?? (operation.cell_index as number | undefined);
    const maxWait = ((operation.maxWait as number | undefined) ?? (operation.max_wait as number | undefined) ?? 10);
    const saveOutputs = ((operation.saveOutputs as boolean | undefined) ?? (operation.save_outputs as boolean | undefined) ?? true);

    // Get the cell
    const cells = this.getCells(notebookPath);
    let targetIndex: number;
    let cell: NebulaCell;

    if (cellId) {
      targetIndex = cells.findIndex(c => c.id === cellId);
      if (targetIndex === -1) {
        return { success: false, error: `Cell with ID "${cellId}" not found` };
      }
      cell = cells[targetIndex];
    } else if (cellIndex !== undefined) {
      if (cellIndex < 0 || cellIndex >= cells.length) {
        return { success: false, error: `Cell index ${cellIndex} out of range` };
      }
      targetIndex = cellIndex;
      cell = cells[cellIndex];
    } else {
      return { success: false, error: 'Must provide cellId or cellIndex' };
    }

    const actualCellId = cell.id;

    // Only execute code cells
    if (cell.type !== 'code') {
      return { success: false, error: `Cell ${targetIndex} is not a code cell` };
    }

    const code = cell.content || '';

    // Handle empty cells - just clear outputs
    if (!code.trim()) {
      cell.outputs = [];
      cell.executionCount = null;
      if (saveOutputs) {
        this.saveCells(notebookPath, cells);
      }
      return {
        success: true,
        cellId: actualCellId,
        cellIndex: targetIndex,
        executionStatus: 'idle',
        outputs: [],
        executionCount: null,
      };
    }

    // Check if kernel service is available
    if (!this.kernelService) {
      return {
        success: false,
        error: 'Kernel service not available. Make sure the Node.js server is properly initialized.',
      };
    }

    // Get or create a kernel session for this notebook. A kernel preference
    // with a serverId means the notebook is bound to a cluster peer (compute
    // allocation) — the kernel must live THERE, not on this server: resolving
    // locally would run cells on the login node, and on a cross-arch
    // allocation the local ipykernel probe can't even run the env's python.
    const requestedSessionId = (operation.sessionId as string | undefined) ?? (operation.session_id as string | undefined);
    const kernelPref = this.kernelService.getNotebookKernelPreference(notebookPath);
    const preferredKernelName = kernelPref?.kernelName || 'python3';
    let sessionId: string | null = null;

    if (requestedSessionId && (this.kernelService.hasSession(requestedSessionId) || isProxiedSession(requestedSessionId))) {
      sessionId = requestedSessionId;
    } else {
      sessionId = this.kernelService.getSessionIdForFile(notebookPath);
    }

    if (!sessionId) {
      try {
        sessionId = await this.resolveKernelSession(notebookPath, preferredKernelName, kernelPref?.serverId ?? null);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Failed to start kernel: ${errMsg}` };
      }
    }

    // Preserve previous outputs until fresh output arrives so UI consumers can still
    // render them, but mark them stale so read_output hides them for this new run.
    cell.isExecuting = true;
    cell.pendingOutputReset = true;

    // Execute the cell with periodic output saving
    const runId = uuidv4();
    const startTime = Date.now();
    this.recordLogOperation(notebookPath, {
      type: 'event',
      category: 'execution',
      name: 'runCell',
      target: { cellId: actualCellId, cellIndex: targetIndex },
      runId,
      data: { sessionId },
      source: 'mcp',
    });

    const outputs: CellOutput[] = [];
    let executionCount: number | null = null;
    let executionError: string | null = null;
    let executionComplete = false;
    let queueInfo: { queuePosition: number; queueLength: number } | null = null;

    const publishOutputs = () => {
      if (outputs.length > 0) {
        cell.outputs = [...outputs];
        cell.pendingOutputReset = false;
        return;
      }

      if (executionComplete) {
        cell.outputs = [];
        cell.pendingOutputReset = false;
      }
    };

    const outputCallback = async (output: Partial<CellOutput>) => {
      outputs.push(copyCellOutput(output));
      // Save outputs periodically (every 5 outputs) like Python
      if (saveOutputs && outputs.length % 5 === 0) {
        publishOutputs();
        this.saveCells(notebookPath, cells);
      }
    };

    try {
      // Create execution promise
      const executeTask = async () => {
        try {
          const result = isProxiedSession(sessionId!)
            ? await executeRemoteCode(sessionId!, code, outputCallback, actualCellId)
            : await this.kernelService!.executeCode(sessionId, code, outputCallback, (info) => {
              queueInfo = info;
            }, actualCellId);
          executionCount = result.executionCount;
          if (!queueInfo && result.queuePosition !== undefined && result.queueLength !== undefined) {
            queueInfo = { queuePosition: result.queuePosition, queueLength: result.queueLength };
          }
          if (result.status === 'error') {
            executionError = result.error || 'Unknown error';
          }
        } catch (err) {
          executionError = err instanceof Error ? err.message : String(err);
        } finally {
          executionComplete = true;
        }
      };

      // Start execution
      const executionPromise = executeTask();

      // Wait for completion or timeout
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(resolve, maxWait * 1000);
      });

      await Promise.race([executionPromise, timeoutPromise]);

      const elapsed = Date.now() - startTime;
      const status = executionComplete
        ? (executionError ? 'error' : 'idle')
        : 'busy';

      // Update cell with any fresh outputs from this run.
      publishOutputs();
      if (executionCount !== null) {
        cell.executionCount = executionCount;
      }
      cell.isExecuting = !executionComplete;

      if (saveOutputs) {
        this.saveCells(notebookPath, cells);
      }

      // Cast queueInfo to avoid TS narrowing issues with async closures
      const qi = queueInfo as { queuePosition: number; queueLength: number } | null;

      if (!executionComplete) {
        // Execution continues in background - finalize when promise resolves
        executionPromise.then(() => {
          const finalElapsed = Date.now() - startTime;
          publishOutputs();
          if (executionCount !== null) {
            cell.executionCount = executionCount;
          }
          cell.isExecuting = false;

          if (saveOutputs) {
            this.saveCells(notebookPath, cells);
          }

          const success = !executionError;
          this.recordLogOperation(notebookPath, {
            type: 'event',
            category: 'execution',
            name: 'runCellComplete',
            target: { cellId: actualCellId, cellIndex: targetIndex },
            runId,
            data: { durationMs: finalElapsed, success },
            source: 'mcp',
          });
        }).catch(() => {});

        // Execution is still running
        return {
          success: true,
          executionStatus: 'busy',
          cellId: actualCellId,
          cellIndex: targetIndex,
          outputs: outputs.map(o => copyCellOutput(o)),
          executionTime: elapsed,
          sessionId,
          queuePosition: qi?.queuePosition,
          queueLength: qi?.queueLength,
          message: `Cell still executing after ${maxWait}s. Use read_output with max_wait to poll for results.`,
        };
      }

      const success = !executionError;
      this.recordLogOperation(notebookPath, {
        type: 'event',
        category: 'execution',
        name: 'runCellComplete',
        target: { cellId: actualCellId, cellIndex: targetIndex },
        runId,
        data: { durationMs: elapsed, success },
        source: 'mcp',
      });
      return {
        success: true,
        cellId: actualCellId,
        cellIndex: targetIndex,
        executionStatus: status,
        executionCount,
        outputs: outputs.map(o => copyCellOutput(o)),
        executionTime: elapsed,
        sessionId,
        queuePosition: qi?.queuePosition,
        queueLength: qi?.queueLength,
        error: executionError || undefined,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Execution failed: ${errMsg}` };
    }
  }

  // -------------------------------------------------------------------------
  // Undo/Redo Operations
  // -------------------------------------------------------------------------

  /**
   * Handle undo operation.
   */
  private async handleUndo(notebookPath: string): Promise<OperationResult> {
    const cells = this.getCells(notebookPath);
    const { cells: newCells, result } = this.undoRedoManager.undo(notebookPath, cells);

    if (result.success) {
      this.saveCells(notebookPath, newCells);
    }

    return {
      success: result.success,
      affectedCellIds: result.affectedCellIds,
      operationType: result.operationType,
      error: result.error,
      canUndo: this.undoRedoManager.canUndo(notebookPath, newCells),
      canRedo: this.undoRedoManager.canRedo(notebookPath, newCells),
    };
  }

  /**
   * Handle redo operation.
   */
  private async handleRedo(notebookPath: string): Promise<OperationResult> {
    const cells = this.getCells(notebookPath);
    const { cells: newCells, result } = this.undoRedoManager.redo(notebookPath, cells);

    if (result.success) {
      this.saveCells(notebookPath, newCells);
    }

    return {
      success: result.success,
      affectedCellIds: result.affectedCellIds,
      operationType: result.operationType,
      error: result.error,
      canUndo: this.undoRedoManager.canUndo(notebookPath, newCells),
      canRedo: this.undoRedoManager.canRedo(notebookPath, newCells),
    };
  }

  /**
   * Record an undoable operation (helper method for other operations).
   */
  private recordUndoableOperation(notebookPath: string, op: UndoableOperation): void {
    const cells = this.getCells(notebookPath);
    this.undoRedoManager.recordOperation(notebookPath, cells, op);
  }

  /**
   * Record a non-undoable log operation (helper method for other operations).
   */
  private recordLogOperation(notebookPath: string, op: LogOperation): void {
    const cells = this.getCells(notebookPath);
    this.undoRedoManager.recordLogOperation(notebookPath, cells, op);
  }

  /**
   * Get updates since a timestamp (public method for operation router).
   * Used by startAgentSession to inform agent what changed between sessions.
   */
  getUpdatesSince(notebookPath: string, sinceTimestamp: number): UpdateSummary[] {
    const cells = this.getCells(notebookPath);
    return this.undoRedoManager.getUpdatesSince(notebookPath, cells, sinceTimestamp);
  }

  // -------------------------------------------------------------------------
  // Kernel Operations
  // -------------------------------------------------------------------------

  /**
   * Get-or-create the execution session for a notebook: on its bound cluster
   * server when a binding exists (proxied session id), locally otherwise.
   * A dead binding falls back to a fresh local kernel — allocations end
   * routinely (walltime, cancel), and that fallback is the documented
   * "falls back to a new kernel on next use" behavior.
   */
  private async resolveKernelSession(
    notebookPath: string,
    kernelName: string,
    boundServerId: string | null
  ): Promise<string> {
    if (boundServerId) {
      const remote = await this.startBoundKernel(notebookPath, kernelName, boundServerId);
      if (remote) return remote.sessionId;
    }
    const result = await this.kernelService!.getOrCreateKernel(notebookPath, kernelName);
    return result.sessionId;
  }

  /** Start (get-or-create) a kernel on the bound server; null if it is gone. */
  private async startBoundKernel(
    notebookPath: string,
    kernelName: string,
    serverId: string
  ): Promise<{ sessionId: string; created?: boolean } | null> {
    try {
      return await startRemoteKernel(serverId, kernelName, notebookPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Headless] Bound server ${serverId} unavailable (${msg}) — falling back to a local kernel`);
      return null;
    }
  }

  private async startKernelOp(operation: Record<string, unknown>, notebookPath: string): Promise<OperationResult> {
    if (!this.kernelService) {
      return { success: false, error: 'Kernel service not available' };
    }

    const kernelName = (operation.kernelName as string) || 'python3';

    try {
      // Bound notebooks start their kernel on the bound server, and the
      // binding must survive the preference re-save — dropping serverId here
      // silently unbound notebooks from their allocations.
      const boundServerId = this.kernelService.getNotebookKernelPreference(notebookPath)?.serverId ?? null;
      let sessionId: string;
      let created: boolean | undefined;
      if (boundServerId) {
        const remote = await this.startBoundKernel(notebookPath, kernelName, boundServerId);
        if (remote) {
          sessionId = remote.sessionId;
          created = remote.created;
          this.kernelService.saveNotebookKernelPreference(notebookPath, kernelName, boundServerId);
        } else {
          ({ sessionId, created } = await this.kernelService.getOrCreateKernel(notebookPath, kernelName));
          this.kernelService.saveNotebookKernelPreference(notebookPath, kernelName);
        }
      } else {
        ({ sessionId, created } = await this.kernelService.getOrCreateKernel(notebookPath, kernelName));
        this.kernelService.saveNotebookKernelPreference(notebookPath, kernelName);
      }
      const spec = getKernelSpec(kernelName);
      const metadataResult = await this.fsService.updateNotebookMetadata(notebookPath, {
        kernelspec: {
          name: kernelName,
          display_name: spec?.displayName || (kernelName === 'python3' ? 'Python 3' : kernelName),
          language: spec?.language || 'python',
        },
      });
      if (!metadataResult.success) {
        return { success: false, error: metadataResult.error || `Failed to update kernel metadata for ${notebookPath}` };
      }

      if (created) {
        this.recordLogOperation(notebookPath, {
          type: 'event',
          category: 'kernel',
          name: 'startKernel',
          data: { sessionId, kernelName },
          source: 'mcp',
        });
      }

      return { success: true, sessionId, kernelName };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to start kernel: ${errMsg}` };
    }
  }

  private async shutdownKernelOp(notebookPath: string): Promise<OperationResult> {
    if (!this.kernelService) {
      return { success: false, error: 'Kernel service not available' };
    }

    const sessionId = this.kernelService.getSessionIdForFile(notebookPath);
    if (!sessionId) {
      return { success: false, error: 'No kernel session found for notebook' };
    }

    const success = await this.kernelService.stopKernel(sessionId);
    if (!success) {
      return { success: false, error: 'Failed to shutdown kernel (session not found)' };
    }

    this.recordLogOperation(notebookPath, {
      type: 'event',
      category: 'kernel',
      name: 'shutdownKernel',
      data: { sessionId },
      source: 'mcp',
    });

    return { success: true, sessionId };
  }

  private async restartKernelOp(notebookPath: string): Promise<OperationResult> {
    if (!this.kernelService) {
      return { success: false, error: 'Kernel service not available' };
    }

    const sessionId = this.kernelService.getSessionIdForFile(notebookPath);
    if (!sessionId) {
      return { success: false, error: 'No kernel session found for notebook' };
    }

    const success = await this.kernelService.restartKernel(sessionId);
    if (!success) {
      return { success: false, error: 'Failed to restart kernel (session not found)' };
    }

    this.recordLogOperation(notebookPath, {
      type: 'event',
      category: 'kernel',
      name: 'restartKernel',
      data: { sessionId },
      source: 'mcp',
    });

    return { success: true, sessionId };
  }

  private async interruptKernelOp(notebookPath: string): Promise<OperationResult> {
    if (!this.kernelService) {
      return { success: false, error: 'Kernel service not available' };
    }

    const sessionId = this.kernelService.getSessionIdForFile(notebookPath);
    if (!sessionId) {
      return { success: false, error: 'No kernel session found for notebook' };
    }

    const success = await this.kernelService.interruptKernel(sessionId);
    if (!success) {
      return { success: false, error: 'Failed to interrupt kernel (session not found)' };
    }

    this.recordLogOperation(notebookPath, {
      type: 'event',
      category: 'kernel',
      name: 'interruptKernel',
      data: { sessionId },
      source: 'mcp',
    });

    return { success: true, sessionId };
  }

}
