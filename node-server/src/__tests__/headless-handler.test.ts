// @vitest-environment node
/**
 * Headless Handler Tests
 *
 * Tests for the HeadlessOperationHandler which handles notebook operations
 * when no UI is connected (file-based mode).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HeadlessOperationHandler } from '../notebook/headless-handler';
import { OperationRouter } from '../notebook/operation-router';
import { FilesystemService } from '../fs/fs-service';

// Kernel proxy is mocked file-wide: these tests assert WHERE execution is
// routed (local kernelService vs the bound allocation server), not the wire
// protocol — that lives in kernel-proxy-execute.test.ts.
const proxyMocks = vi.hoisted(() => ({
  startRemoteKernel: vi.fn(),
  executeRemoteCode: vi.fn(),
}));
vi.mock('../cluster/kernel-proxy', () => ({
  isProxiedSession: (id: string) => id.includes('::'),
  startRemoteKernel: proxyMocks.startRemoteKernel,
  executeRemoteCode: proxyMocks.executeRemoteCode,
}));

describe('HeadlessOperationHandler', () => {
  let handler: HeadlessOperationHandler;
  let fsService: FilesystemService;
  let router: OperationRouter;
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-test-'));
    fsService = new FilesystemService();
    router = new OperationRouter();
    handler = new HeadlessOperationHandler(fsService, router);
  });

  afterEach(async () => {
    vi.useRealTimers();
    // Drain the handler's async persistence BEFORE deleting its directory —
    // in-flight writes racing the teardown are the root of this suite's CI
    // flakes (ENOTEMPTY on rmSync, ENOENT mkdir noise bleeding into the next
    // test's assertions).
    try { await handler.flush(); } catch { /* nothing pending */ }
    if (testDir && fs.existsSync(testDir)) {
      // maxRetries: rmSync intermittently hits ENOTEMPTY on macOS when the
      // suite runs under parallel load (async writes still landing) — retry
      // instead of flaking the whole file.
      fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  // Helper to create a test notebook
  function createTestNotebook(filename: string, cells: any[] = [], agentCreated = true) {
    const notebookPath = path.join(testDir, filename);
    const notebook = {
      cells: cells.map(c => ({
        cell_type: c.type || 'code',
        source: [c.content || ''],
        metadata: { nebula_id: c.id, ...(c.metadata || {}) },
        outputs: (c.outputs || []).map((o: any) => {
          // Convert Nebula format to Jupyter format if needed
          if (o.type === 'stdout' || o.type === 'stderr') {
            return { output_type: 'stream', name: o.type, text: [o.content] };
          }
          if (o.type === 'error') {
            return { output_type: 'error', ename: 'Error', evalue: o.content, traceback: [o.content] };
          }
          return o;
        }),
        execution_count: c.execution_count || null,
      })),
      metadata: {
        kernelspec: { name: 'python3', display_name: 'Python 3' },
        nebula: agentCreated ? { agent_created: true } : {},
      },
      nbformat: 4,
      nbformat_minor: 5,
    };
    fs.writeFileSync(notebookPath, JSON.stringify(notebook));
    return notebookPath;
  }

  describe('insertCell', () => {
    it('should insert a cell at the beginning', async () => {
      const notebookPath = createTestNotebook('insert-begin.ipynb', [
        { id: 'existing-cell', content: 'existing' },
      ]);

      const result = await handler.applyOperation({
        type: 'insertCell',
        notebookPath,
        index: 0,
        cell: { id: 'new-cell', type: 'code', content: 'new content' },
      });

      expect(result.success).toBe(true);
      expect(result.cellId).toBe('new-cell');
      expect(result.cellIndex).toBe(0);

      // Flush to persist changes before reading file
      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells[0].metadata.nebula_id).toBe('new-cell');
      expect(saved.cells[1].metadata.nebula_id).toBe('existing-cell');
    });

    it('should insert a cell at the end', async () => {
      const notebookPath = createTestNotebook('insert-end.ipynb', [
        { id: 'cell-1', content: 'first' },
      ]);

      const result = await handler.applyOperation({
        type: 'insertCell',
        notebookPath,
        index: -1, // Append
        cell: { id: 'new-cell', type: 'markdown', content: '# Header' },
      });

      expect(result.success).toBe(true);
      expect(result.cellId).toBe('new-cell');

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells).toHaveLength(2);
      expect(saved.cells[1].metadata.nebula_id).toBe('new-cell');
      expect(saved.cells[1].cell_type).toBe('markdown');
    });

    it('should insert a cell in the middle', async () => {
      const notebookPath = createTestNotebook('insert-middle.ipynb', [
        { id: 'cell-1', content: 'first' },
        { id: 'cell-2', content: 'second' },
      ]);

      const result = await handler.applyOperation({
        type: 'insertCell',
        notebookPath,
        index: 1,
        cell: { id: 'middle-cell', type: 'code', content: 'middle' },
      });

      expect(result.success).toBe(true);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells).toHaveLength(3);
      expect(saved.cells[0].metadata.nebula_id).toBe('cell-1');
      expect(saved.cells[1].metadata.nebula_id).toBe('middle-cell');
      expect(saved.cells[2].metadata.nebula_id).toBe('cell-2');
    });

    it('should preserve scrolled metadata on insert', async () => {
      const notebookPath = createTestNotebook('insert-metadata.ipynb', [
        { id: 'cell-1', content: 'first' },
      ]);

      const result = await handler.applyOperation({
        type: 'insertCell',
        notebookPath,
        index: 0,
        cell: {
          id: 'new-cell',
          type: 'code',
          content: 'metadata cell',
          metadata: { scrolled: true, scrolledHeight: 120 },
        },
      });

      expect(result.success).toBe(true);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells[0].metadata.scrolled).toBe(true);
      expect(saved.cells[0].metadata.scrolled_height).toBe(120);
    });
  });

  describe('deleteCell', () => {
    it('should delete a cell by ID', async () => {
      const notebookPath = createTestNotebook('delete-by-id.ipynb', [
        { id: 'cell-1', content: 'first' },
        { id: 'cell-2', content: 'second' },
        { id: 'cell-3', content: 'third' },
      ]);

      const result = await handler.applyOperation({
        type: 'deleteCell',
        notebookPath,
        cellId: 'cell-2',
      });

      expect(result.success).toBe(true);
      expect(result.cellIndex).toBe(1);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells).toHaveLength(2);
      expect(saved.cells[0].metadata.nebula_id).toBe('cell-1');
      expect(saved.cells[1].metadata.nebula_id).toBe('cell-3');
    });

    it('should return error for non-existent cell', async () => {
      const notebookPath = createTestNotebook('delete-missing.ipynb', [
        { id: 'cell-1', content: 'first' },
      ]);

      const result = await handler.applyOperation({
        type: 'deleteCell',
        notebookPath,
        cellId: 'non-existent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('updateContent', () => {
    it('should update cell content', async () => {
      const notebookPath = createTestNotebook('update-content.ipynb', [
        { id: 'cell-1', content: 'old content' },
      ]);

      const result = await handler.applyOperation({
        type: 'updateContent',
        notebookPath,
        cellId: 'cell-1',
        content: 'new content',
      });

      expect(result.success).toBe(true);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells[0].source).toEqual(['new content']);
    });

    it('should return error for non-existent cell', async () => {
      const notebookPath = createTestNotebook('update-missing.ipynb', [
        { id: 'cell-1', content: 'content' },
      ]);

      const result = await handler.applyOperation({
        type: 'updateContent',
        notebookPath,
        cellId: 'non-existent',
        content: 'new content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('updateMetadata', () => {
    it('should update cell type', async () => {
      const notebookPath = createTestNotebook('update-type.ipynb', [
        { id: 'cell-1', type: 'code', content: '# comment' },
      ]);

      const result = await handler.applyOperation({
        type: 'updateMetadata',
        notebookPath,
        cellId: 'cell-1',
        changes: { type: 'markdown' },
      });

      expect(result.success).toBe(true);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells[0].cell_type).toBe('markdown');
    });

    it('should update scrolled state', async () => {
      const notebookPath = createTestNotebook('update-scrolled.ipynb', [
        { id: 'cell-1', content: 'x=1' },
      ]);

      const result = await handler.applyOperation({
        type: 'updateMetadata',
        notebookPath,
        cellId: 'cell-1',
        changes: { scrolled: true },
      });

      expect(result.success).toBe(true);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells[0].metadata.scrolled).toBe(true);
    });

    it('should reject non-agent-mutable fields', async () => {
      const notebookPath = createTestNotebook('update-invalid.ipynb', [
        { id: 'cell-1', content: 'x=1' },
      ]);

      const result = await handler.applyOperation({
        type: 'updateMetadata',
        notebookPath,
        cellId: 'cell-1',
        changes: { invalidField: 'value' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown field');
    });

    it('should allow id change with dedupe', async () => {
      const notebookPath = createTestNotebook('update-id.ipynb', [
        { id: 'cell-1', content: 'first' },
        { id: 'cell-2', content: 'second' },
      ]);

      const result = await handler.applyOperation({
        type: 'updateMetadata',
        notebookPath,
        cellId: 'cell-1',
        changes: { id: 'cell-2' },
      });

      expect(result.success).toBe(true);
      expect(result.cellId).toBe('cell-2-2');

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells[0].metadata.nebula_id).toBe('cell-2-2');
    });
  });

  describe('moveCell', () => {
    it('should move cell from beginning to end', async () => {
      const notebookPath = createTestNotebook('move-cell.ipynb', [
        { id: 'cell-1', content: 'first' },
        { id: 'cell-2', content: 'second' },
        { id: 'cell-3', content: 'third' },
      ]);

      const result = await handler.applyOperation({
        type: 'moveCell',
        notebookPath,
        cellId: 'cell-1',
        afterCellId: 'cell-3',
      });

      expect(result.success).toBe(true);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells[0].metadata.nebula_id).toBe('cell-2');
      expect(saved.cells[1].metadata.nebula_id).toBe('cell-3');
      expect(saved.cells[2].metadata.nebula_id).toBe('cell-1');
    });

    it('should move cell to beginning', async () => {
      const notebookPath = createTestNotebook('move-to-begin.ipynb', [
        { id: 'cell-1', content: 'first' },
        { id: 'cell-2', content: 'second' },
        { id: 'cell-3', content: 'third' },
      ]);

      const result = await handler.applyOperation({
        type: 'moveCell',
        notebookPath,
        cellId: 'cell-3',
        toIndex: 0,
      });

      expect(result.success).toBe(true);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells[0].metadata.nebula_id).toBe('cell-3');
      expect(saved.cells[1].metadata.nebula_id).toBe('cell-1');
      expect(saved.cells[2].metadata.nebula_id).toBe('cell-2');
    });
  });

  describe('duplicateCell', () => {
    it('should duplicate a cell', async () => {
      const notebookPath = createTestNotebook('duplicate.ipynb', [
        { id: 'cell-1', content: 'original content' },
      ]);

      const result = await handler.applyOperation({
        type: 'duplicateCell',
        notebookPath,
        cellIndex: 0,
        newCellId: 'cell-1-copy',
      });

      expect(result.success).toBe(true);
      expect(result.cellId).toBeDefined();
      expect(result.cellId).not.toBe('cell-1'); // New ID generated
      expect(result.cellIndex).toBe(1);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells).toHaveLength(2);
    });

    it('should not copy scrolled or custom metadata', async () => {
      const notebookPath = createTestNotebook('duplicate-metadata.ipynb', [
        { id: 'cell-1', content: 'original', metadata: { scrolled: true, custom: 'x' } },
      ]);

      const result = await handler.applyOperation({
        type: 'duplicateCell',
        notebookPath,
        cellIndex: 0,
        newCellId: 'cell-1-copy',
      });

      expect(result.success).toBe(true);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      const newCell = saved.cells.find((cell: any) => cell.metadata.nebula_id === result.cellId);
      expect(newCell).toBeDefined();
      expect(newCell.metadata.scrolled).toBeUndefined();
      expect(newCell.metadata.custom).toBeUndefined();
    });
  });

  describe('readCell', () => {
    it('should read cell by ID', async () => {
      const notebookPath = createTestNotebook('read-cell.ipynb', [
        { id: 'cell-1', content: 'first cell content' },
        { id: 'cell-2', content: 'second cell content' },
      ]);

      const result = await handler.applyOperation({
        type: 'readCell',
        notebookPath,
        cellId: 'cell-2',
      });

      expect(result.success).toBe(true);
      const cell = result.cell as Record<string, unknown>;
      expect(cell.id).toBe('cell-2');
      expect(cell.content).toBe('second cell content');
    });

    it('should read cell by index', async () => {
      const notebookPath = createTestNotebook('read-by-index.ipynb', [
        { id: 'cell-1', content: 'first' },
        { id: 'cell-2', content: 'second' },
      ]);

      const result = await handler.applyOperation({
        type: 'readCell',
        notebookPath,
        cellIndex: 1,
      });

      expect(result.success).toBe(true);
      const cell = result.cell as Record<string, unknown>;
      expect(cell.id).toBe('cell-2');
    });
  });

  describe('clearNotebook', () => {
    it('should clear all cells', async () => {
      const notebookPath = createTestNotebook('clear.ipynb', [
        { id: 'cell-1', content: 'first' },
        { id: 'cell-2', content: 'second' },
        { id: 'cell-3', content: 'third' },
      ]);

      const result = await handler.applyOperation({
        type: 'clearNotebook',
        notebookPath,
      });

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(3);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells).toHaveLength(0);
    });
  });

  describe('deleteCells', () => {
    it('should delete multiple cells by ID', async () => {
      const notebookPath = createTestNotebook('delete-multiple.ipynb', [
        { id: 'cell-1', content: 'first' },
        { id: 'cell-2', content: 'second' },
        { id: 'cell-3', content: 'third' },
        { id: 'cell-4', content: 'fourth' },
      ]);

      const result = await handler.applyOperation({
        type: 'deleteCells',
        notebookPath,
        cellIds: ['cell-2', 'cell-4'],
      });

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(2);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells).toHaveLength(2);
      expect(saved.cells[0].metadata.nebula_id).toBe('cell-1');
      expect(saved.cells[1].metadata.nebula_id).toBe('cell-3');
    });
  });

  describe('insertCells', () => {
    it('should insert multiple cells', async () => {
      const notebookPath = createTestNotebook('insert-multiple.ipynb', [
        { id: 'existing', content: 'existing' },
      ]);

      const result = await handler.applyOperation({
        type: 'insertCells',
        notebookPath,
        position: 0,
        cells: [
          { id: 'new-1', type: 'code', content: 'first new' },
          { id: 'new-2', type: 'markdown', content: '# Second' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.insertedCount).toBe(2);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells).toHaveLength(3);
      expect(saved.cells[0].metadata.nebula_id).toBe('new-1');
      expect(saved.cells[1].metadata.nebula_id).toBe('new-2');
      expect(saved.cells[2].metadata.nebula_id).toBe('existing');
    });
  });

  describe('searchCells', () => {
    it('should search cells by content', async () => {
      const notebookPath = createTestNotebook('search.ipynb', [
        { id: 'cell-1', content: 'hello world' },
        { id: 'cell-2', content: 'goodbye world' },
        { id: 'cell-3', content: 'hello again' },
      ]);

      const result = await handler.applyOperation({
        type: 'searchCells',
        notebookPath,
        query: 'hello',
      });

      expect(result.success).toBe(true);
      const matches = result.matches as Array<Record<string, unknown>>;
      expect(matches).toHaveLength(2);
      expect(matches[0].cellId).toBe('cell-1');
      expect(matches[1].cellId).toBe('cell-3');
    });
  });

  describe('clearOutputs', () => {
    it('should clear outputs from all cells', async () => {
      const notebookPath = createTestNotebook('clear-outputs.ipynb', [
        {
          id: 'cell-1',
          content: 'x=1',
          outputs: [{ type: 'stdout', content: '1\n' }],
        },
        {
          id: 'cell-2',
          content: 'y=2',
          outputs: [{ type: 'stdout', content: '2\n' }],
        },
      ]);

      const result = await handler.applyOperation({
        type: 'clearOutputs',
        notebookPath,
      });

      expect(result.success).toBe(true);
      expect(result.clearedCount).toBe(2);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells[0].outputs).toEqual([]);
      expect(saved.cells[1].outputs).toEqual([]);
    });

    it('should clear outputs from specific cells', async () => {
      const notebookPath = createTestNotebook('clear-specific.ipynb', [
        {
          id: 'cell-1',
          content: 'x=1',
          outputs: [{ type: 'stdout', content: '1\n' }],
        },
        {
          id: 'cell-2',
          content: 'y=2',
          outputs: [{ type: 'stdout', content: '2\n' }],
        },
      ]);

      const result = await handler.applyOperation({
        type: 'clearOutputs',
        notebookPath,
        cellIds: ['cell-1'],
      });

      expect(result.success).toBe(true);
      expect(result.clearedCount).toBe(1);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells[0].outputs).toEqual([]);
      // cell-2 should still have outputs
      expect(saved.cells[1].outputs).not.toEqual([]);
    });

    it('should preserve execution count when clearing outputs', async () => {
      const notebookPath = createTestNotebook('clear-outputs-exec.ipynb', [
        {
          id: 'cell-1',
          content: 'x=1',
          outputs: [{ type: 'stdout', content: '1\n' }],
          execution_count: 7,
        },
      ]);

      const result = await handler.applyOperation({
        type: 'clearOutputs',
        notebookPath,
      });

      expect(result.success).toBe(true);

      await handler.flush(notebookPath);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.cells[0].outputs).toEqual([]);
      expect(saved.cells[0].execution_count).toBe(7);
    });
  });

  describe('createNotebook', () => {
    it('should respect kernel display name', async () => {
      const notebookPath = path.join(testDir, 'create-kernel.ipynb');

      const result = await handler.applyOperation({
        type: 'createNotebook',
        notebookPath,
        overwrite: true,
        kernelName: 'python3',
        kernelDisplayName: 'Custom Kernel',
      });

      expect(result.success).toBe(true);

      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      expect(saved.metadata.kernelspec.name).toBe('python3');
      expect(saved.metadata.kernelspec.display_name).toBe('Custom Kernel');
    });
  });

  describe('readNotebook', () => {
    it('should read full notebook', async () => {
      const notebookPath = createTestNotebook('read-notebook.ipynb', [
        { id: 'cell-1', content: 'first' },
        { id: 'cell-2', content: 'second' },
      ]);

      const result = await handler.readNotebook(notebookPath);

      expect(result.success).toBe(true);
      const data = result.data as { cells: unknown[]; path: string };
      expect(data.cells).toHaveLength(2);
      expect(data.path).toBe(notebookPath);
    });

    it('should apply output truncation', async () => {
      const longOutput = 'x\n'.repeat(200);
      const notebookPath = createTestNotebook('truncate.ipynb', [
        {
          id: 'cell-1',
          content: 'print("x\\n" * 200)',
          outputs: [{ type: 'stdout', content: longOutput }],
        },
      ]);

      const result = await handler.readNotebook(notebookPath, true, 50, 1000);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const cells = data.cells as Array<Record<string, unknown>>;
      const outputs = cells[0].outputs as Array<Record<string, unknown>>;
      const outputContent = outputs[0].content as string;
      // Original is 400 chars (200 * 2), truncated to 50 lines max
      expect(outputContent.length).toBeLessThan(longOutput.length);
      expect(outputs[0].truncated).toBe(true);
      expect(outputs[0].total_lines).toBeGreaterThan(0);
      expect(outputs[0].returned_range).toBeDefined();
      expect('id' in outputs[0]).toBe(false);
      expect('timestamp' in outputs[0]).toBe(false);
    });

    it('should strip outputs when include_outputs is false', async () => {
      const notebookPath = createTestNotebook('no-outputs.ipynb', [
        {
          id: 'cell-1',
          content: 'x=1',
          outputs: [{ type: 'stdout', content: '1\n' }],
        },
      ]);

      const result = await handler.readNotebook(notebookPath, false);

      expect(result.success).toBe(true);
      const data = result.data as { cells: Array<{ outputs: unknown[] }> };
      expect(data.cells[0].outputs).toEqual([]);
    });

    it('should return persisted notebook metadata in headless mode', async () => {
      const notebookPath = createTestNotebook('metadata.ipynb', [
        { id: 'cell-1', content: 'x=1' },
      ]);

      const result = await handler.readNotebook(notebookPath);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.metadata).toEqual({
        kernelspec: { name: 'python3', display_name: 'Python 3' },
        nebula: { agent_created: true },
      });
    });

    it('should honor cell id when nebula_id metadata is missing', async () => {
      const notebookPath = path.join(testDir, 'cell-id.ipynb');
      const notebook = {
        cells: [
          {
            id: 'external-id',
            cell_type: 'code',
            source: ['x=1'],
            metadata: {},
            outputs: [],
            execution_count: null,
          },
        ],
        metadata: {
          kernelspec: { name: 'python3', display_name: 'Python 3' },
        },
        nbformat: 4,
        nbformat_minor: 5,
      };
      fs.writeFileSync(notebookPath, JSON.stringify(notebook));

      const result = await handler.readNotebook(notebookPath);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const cells = data.cells as Array<Record<string, unknown>>;
      expect(cells[0].id).toBe('external-id');
    });

    it('should mark image outputs as binary', async () => {
      const notebookPath = path.join(testDir, 'image-output.ipynb');
      const notebook = {
        cells: [
          {
            cell_type: 'code',
            source: [''],
            metadata: { nebula_id: 'cell-1' },
            outputs: [
              {
                output_type: 'display_data',
                data: { 'image/png': 'abcd' },
                metadata: {},
              },
            ],
            execution_count: null,
          },
        ],
        metadata: {
          kernelspec: { name: 'python3', display_name: 'Python 3' },
        },
        nbformat: 4,
        nbformat_minor: 5,
      };
      fs.writeFileSync(notebookPath, JSON.stringify(notebook));

      const result = await handler.readNotebook(notebookPath);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const cells = data.cells as Array<Record<string, unknown>>;
      const outputs = cells[0].outputs as Array<Record<string, unknown>>;
      expect(outputs[0].is_binary).toBe(true);
    });
  });

  describe('readCellOutput', () => {
    it('should return promptly when the cell is already idle', async () => {
      const notebookPath = createTestNotebook('idle-output.ipynb', [
        {
          id: 'cell-1',
          content: 'print("done")',
          outputs: [{ type: 'stdout', content: 'done' }],
          execution_count: 1,
        },
      ]);

      // Warm the notebook cache with real timers: applyOperation's async
      // warm-up does real fs I/O, which never resolves under fake timers.
      await handler.readNotebook(notebookPath, false);
      vi.useFakeTimers();

      let settled = false;
      const resultPromise = handler.applyOperation({
        type: 'readCellOutput',
        notebookPath,
        cellId: 'cell-1',
        maxWait: 300,
      }).then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(600);

      expect(settled).toBe(true);
      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.outputs).toEqual([
        expect.objectContaining({ type: 'stdout', content: 'done' }),
      ]);
    });

    it('should not drop cached outputs during maxWait polling', async () => {
      const notebookPath = createTestNotebook('polling-output.ipynb', [
        {
          id: 'cell-1',
          content: 'print("old")',
          outputs: [{ type: 'stdout', content: 'old' }],
        },
      ]);

      const saveSpy = vi
        .spyOn(fsService, 'saveNotebookCells')
        .mockImplementation(async () => ({ success: true, mtime: 0 }));

      await handler.applyOperation({
        type: 'updateOutputs',
        notebookPath,
        cellId: 'cell-1',
        outputs: [{ type: 'stdout', content: 'new' }],
      });

      const result = await handler.applyOperation({
        type: 'readCellOutput',
        notebookPath,
        cellId: 'cell-1',
        maxWait: 0.2,
      });

      saveSpy.mockRestore();

      expect(result.success).toBe(true);
      const outputs = result.outputs as Array<Record<string, unknown>>;
      expect(outputs[0].content).toBe('new');
    });

    it('should hide stale outputs from readCellOutput while a new execution is in flight', async () => {
      const notebookPath = createTestNotebook('stale-output-hidden.ipynb', [
        {
          id: 'cell-1',
          content: 'print(\"old\")',
          outputs: [{ type: 'stdout', content: 'old' }],
        },
      ]);

      let resolveExecution: ((value: { status: string; executionCount: number | null }) => void) | null = null;
      const kernelService = {
        hasSession: vi.fn(() => true),
        getSessionIdForFile: vi.fn(() => null),
        getNotebookKernelPreference: vi.fn(() => null),
        getOrCreateKernel: vi.fn(async () => ({ sessionId: 'session-1', created: true })),
        executeCode: vi.fn(async () => (
          await new Promise<{ status: string; executionCount: number | null }>((resolve) => {
            resolveExecution = resolve;
          })
        )),
      };

      handler = new HeadlessOperationHandler(fsService, router, kernelService as unknown as any);

      const executeResult = await handler.applyOperation({
        type: 'executeCell',
        notebookPath,
        cellId: 'cell-1',
        maxWait: 0,
      });

      expect(executeResult.success).toBe(true);
      expect(executeResult.executionStatus).toBe('busy');

      const result = await handler.applyOperation({
        type: 'readCellOutput',
        notebookPath,
        cellId: 'cell-1',
        maxWait: 0,
      });

      expect(result.success).toBe(true);
      expect(result.outputs).toEqual([]);

      resolveExecution?.({ status: 'ok', executionCount: 1 });
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  });

  describe('executeCell', () => {
    it('should use provided sessionId when executing', async () => {
      const notebookPath = createTestNotebook('execute-session.ipynb', [
        { id: 'cell-1', content: 'print("hi")' },
      ]);

      const kernelService = {
        hasSession: vi.fn((sessionId: string) => sessionId === 'session-1'),
        getSessionIdForFile: vi.fn(() => null),
        getNotebookKernelPreference: vi.fn(() => null),
        getOrCreateKernel: vi.fn(async () => ({ sessionId: 'session-auto', created: true })),
        executeCode: vi.fn(async (
          _sessionId: string,
          _code: string,
          onOutput: (entry: any) => Promise<void>,
          onQueueInfo?: (info: { queuePosition: number; queueLength: number }) => void,
          _cellId?: string | null
        ) => {
          onQueueInfo?.({ queuePosition: 0, queueLength: 1 });
          await onOutput({ type: 'stdout', content: 'ok' });
          return { status: 'ok', executionCount: 1, queuePosition: 0, queueLength: 1 };
        }),
      };

      handler = new HeadlessOperationHandler(fsService, router, kernelService as unknown as any);

      const result = await handler.applyOperation({
        type: 'executeCell',
        notebookPath,
        cellId: 'cell-1',
        sessionId: 'session-1',
      });

      expect(result.success).toBe(true);
      expect(result.queuePosition).toBe(0);
      expect(result.queueLength).toBe(1);
      expect(kernelService.getOrCreateKernel).not.toHaveBeenCalled();
      expect(kernelService.executeCode).toHaveBeenCalledWith(
        'session-1',
        'print(\"hi\")',
        expect.any(Function),
        expect.any(Function),
        'cell-1'
      );
    });

    it('falls back to the notebook kernel when a provided sessionId is stale', async () => {
      const notebookPath = createTestNotebook('execute-stale-session.ipynb', [
        { id: 'cell-1', content: 'print("hi")' },
      ]);

      const kernelService = {
        hasSession: vi.fn((sessionId: string) => sessionId === 'session-current'),
        getSessionIdForFile: vi.fn(() => 'session-current'),
        getNotebookKernelPreference: vi.fn(() => ({ kernelName: 'python3', serverId: null, updatedAt: Date.now() })),
        getOrCreateKernel: vi.fn(async () => ({ sessionId: 'session-auto', created: true })),
        executeCode: vi.fn(async (
          _sessionId: string,
          _code: string,
          onOutput: (entry: any) => Promise<void>,
          onQueueInfo?: (info: { queuePosition: number; queueLength: number }) => void,
          _cellId?: string | null
        ) => {
          onQueueInfo?.({ queuePosition: 0, queueLength: 1 });
          await onOutput({ type: 'stdout', content: 'ok' });
          return { status: 'ok', executionCount: 1, queuePosition: 0, queueLength: 1 };
        }),
      };

      handler = new HeadlessOperationHandler(fsService, router, kernelService as unknown as any);

      const result = await handler.applyOperation({
        type: 'executeCell',
        notebookPath,
        cellId: 'cell-1',
        sessionId: 'session-stale',
      });

      expect(result.success).toBe(true);
      expect(kernelService.getSessionIdForFile).toHaveBeenCalledWith(notebookPath);
      expect(kernelService.getOrCreateKernel).not.toHaveBeenCalled();
      expect(kernelService.executeCode).toHaveBeenCalledWith(
        'session-current',
        'print(\"hi\")',
        expect.any(Function),
        expect.any(Function),
        'cell-1'
      );
    });
  });

  describe('Agent Permission Checking', () => {
    it('should allow operations on agent-created notebooks', async () => {
      const notebookPath = createTestNotebook('agent-created.ipynb', [], true);

      const result = await handler.applyOperation({
        type: 'insertCell',
        notebookPath,
        index: 0,
        cell: { id: 'new-cell', type: 'code', content: 'x=1' },
      });

      expect(result.success).toBe(true);
    });

    it('should allow operations immediately after granting permission', async () => {
      const notebookPath = createTestNotebook('granted.ipynb', [], false);

      const permissionResult = await fsService.setAgentPermission(notebookPath, true);
      expect(permissionResult.success).toBe(true);
      expect(permissionResult.status?.can_agent_modify).toBe(true);

      const result = await handler.applyOperation({
        type: 'insertCell',
        notebookPath,
        index: 0,
        cell: { id: 'new-cell', type: 'code', content: 'x=1' },
      });

      expect(result.success).toBe(true);
    });

    it('should deny operations on non-permitted notebooks', async () => {
      const notebookPath = createTestNotebook('not-permitted.ipynb', [], false);

      const result = await handler.applyOperation({
        type: 'insertCell',
        notebookPath,
        index: 0,
        cell: { id: 'new-cell', type: 'code', content: 'x=1' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not agent-permitted');
    });
  });

  describe('Unknown Operation', () => {
    it('should return error for unknown operation type', async () => {
      const notebookPath = createTestNotebook('unknown-op.ipynb', []);

      const result = await handler.applyOperation({
        type: 'unknownOperation',
        notebookPath,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown operation');
    });
  });

  describe('Undo/Redo operations', () => {
    it('should return error for undo when nothing to undo', async () => {
      const notebookPath = createTestNotebook('undo.ipynb', []);

      const result = await handler.applyOperation({
        type: 'undo',
        notebookPath,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Nothing to undo');
    });

    it('should return error for redo when nothing to redo', async () => {
      const notebookPath = createTestNotebook('redo.ipynb', []);

      const result = await handler.applyOperation({
        type: 'redo',
        notebookPath,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Nothing to redo');
    });

    it('should undo an insert operation', async () => {
      const notebookPath = createTestNotebook('undo-insert.ipynb', []);

      // Insert a cell
      await handler.applyOperation({
        type: 'insertCell',
        notebookPath,
        index: 0,
        cell: { id: 'new-cell', type: 'code', content: 'print("test")' },
      });

      // Verify cell was inserted
      let readResult = await handler.readNotebook(notebookPath);
      expect((readResult.data as any).cells).toHaveLength(1);

      // Undo the insert
      const undoResult = await handler.applyOperation({
        type: 'undo',
        notebookPath,
      });

      expect(undoResult.success).toBe(true);
      expect(undoResult.operationType).toBe('insertCell');

      // Verify cell was removed
      readResult = await handler.readNotebook(notebookPath);
      expect((readResult.data as any).cells).toHaveLength(0);
    });

    it('should redo an undone operation', async () => {
      const notebookPath = createTestNotebook('redo-test.ipynb', []);

      // Insert a cell
      await handler.applyOperation({
        type: 'insertCell',
        notebookPath,
        index: 0,
        cell: { id: 'new-cell', type: 'code', content: 'print("test")' },
      });

      // Undo the insert
      await handler.applyOperation({
        type: 'undo',
        notebookPath,
      });

      // Redo the insert
      const redoResult = await handler.applyOperation({
        type: 'redo',
        notebookPath,
      });

      expect(redoResult.success).toBe(true);
      expect(redoResult.operationType).toBe('insertCell');

      // Verify cell was re-inserted
      const readResult = await handler.readNotebook(notebookPath);
      expect((readResult.data as any).cells).toHaveLength(1);
    });

    it('should undo and redo updateContent operations', async () => {
      const notebookPath = createTestNotebook('undo-update-content.ipynb', [
        { id: 'cell-1', content: 'print("a")' },
      ]);

      await handler.applyOperation({
        type: 'updateContent',
        notebookPath,
        cellId: 'cell-1',
        content: 'print("b")',
      });

      let readResult = await handler.readNotebook(notebookPath);
      expect((readResult.data as any).cells[0].content).toBe('print("b")');

      await handler.applyOperation({ type: 'undo', notebookPath });
      readResult = await handler.readNotebook(notebookPath);
      expect((readResult.data as any).cells[0].content).toBe('print("a")');

      await handler.applyOperation({ type: 'redo', notebookPath });
      readResult = await handler.readNotebook(notebookPath);
      expect((readResult.data as any).cells[0].content).toBe('print("b")');
    });

    it('should persist history and allow undo after reloading handler', async () => {
      const notebookPath = createTestNotebook('undo-after-reload.ipynb', []);

      await handler.applyOperation({
        type: 'insertCell',
        notebookPath,
        index: 0,
        cell: { id: 'cell-1', type: 'code', content: 'x=1' },
      });

      await handler.flush(notebookPath);

      const newFsService = new FilesystemService();
      const newRouter = new OperationRouter();
      const newHandler = new HeadlessOperationHandler(newFsService, newRouter);

      const undoResult = await newHandler.applyOperation({ type: 'undo', notebookPath });
      expect(undoResult.success).toBe(true);

      const readResult = await newHandler.readNotebook(notebookPath);
      expect((readResult.data as any).cells).toHaveLength(0);
    });

    it('should support multiple undo/redo sequence', async () => {
      const notebookPath = createTestNotebook('multi-undo-redo.ipynb', [
        { id: 'cell-1', content: 'a' },
      ]);

      await handler.applyOperation({
        type: 'insertCell',
        notebookPath,
        index: 1,
        cell: { id: 'cell-2', type: 'code', content: 'b' },
      });

      await handler.applyOperation({
        type: 'updateContent',
        notebookPath,
        cellId: 'cell-1',
        content: 'a2',
      });

      await handler.applyOperation({
        type: 'insertCell',
        notebookPath,
        index: 2,
        cell: { id: 'cell-3', type: 'code', content: 'c' },
      });

      await handler.applyOperation({ type: 'undo', notebookPath });
      await handler.applyOperation({ type: 'undo', notebookPath });

      let readResult = await handler.readNotebook(notebookPath);
      const cells = (readResult.data as any).cells;
      expect(cells).toHaveLength(2);
      expect(cells[0].content).toBe('a');

      await handler.applyOperation({ type: 'redo', notebookPath });
      await handler.applyOperation({ type: 'redo', notebookPath });

      readResult = await handler.readNotebook(notebookPath);
      const redoneCells = (readResult.data as any).cells;
      expect(redoneCells).toHaveLength(3);
      expect(redoneCells[0].content).toBe('a2');
    });
  });

  describe('Update tracking', () => {
    it('should return updates since timestamp including MCP edits', async () => {
      const notebookPath = createTestNotebook('updates-since.ipynb', []);
      // -1ms: getUpdatesSince filters strictly-after; under full-suite load an
      // op can land in the same millisecond as `start` and get dropped (flake).
      const start = Date.now() - 1;

      await handler.applyOperation({
        type: 'insertCell',
        notebookPath,
        index: 0,
        cell: { id: 'cell-1', type: 'code', content: 'x=1' },
      });

      await handler.applyOperation({
        type: 'updateContent',
        notebookPath,
        cellId: 'cell-1',
        content: 'x=2',
      });

      const updates = handler.getUpdatesSince(notebookPath, start);
      expect(updates.length).toBeGreaterThanOrEqual(2);
      expect(updates.some(update => update.source === 'mcp')).toBe(true);
    });
  });

  describe('OCC expectedHash enforcement', () => {
    it('rejects a stamped write when content changed, returning current content', async () => {
      const notebookPath = createTestNotebook('occ.ipynb', [
        { id: 'c1', content: 'current user content' },
      ]);

      const result = await handler.applyOperation({
        type: 'updateContent',
        notebookPath,
        cellId: 'c1',
        content: 'agent version',
        expectedHash: 'deadbeef', // hash of content the agent saw — stale
      });

      expect(result.success).toBe(false);
      expect(result.conflict).toBe(true);
      expect(result.error).toContain('modified');
      expect(result.error).toContain('current user content');
      expect(result.currentContent).toBe('current user content');

      // content untouched
      const read = await handler.applyOperation({ type: 'readCell', notebookPath, cellId: 'c1' });
      expect((read.cell as any).content).toBe('current user content');
    });

    it('applies a stamped write when the hash matches', async () => {
      const notebookPath = createTestNotebook('occ-ok.ipynb', [
        { id: 'c1', content: 'known content' },
      ]);
      const { hashCellContent } = await import('../notebook/cell-hash');

      const result = await handler.applyOperation({
        type: 'updateContent',
        notebookPath,
        cellId: 'c1',
        content: 'agent update',
        expectedHash: hashCellContent('known content'),
      });

      expect(result.success).toBe(true);
      const read = await handler.applyOperation({ type: 'readCell', notebookPath, cellId: 'c1' });
      expect((read.cell as any).content).toBe('agent update');
    });
  });

  describe('execution on a bound allocation server', () => {
    // `nebula compute use` binds a notebook to an allocation's client server
    // (kernel preference carries serverId). Headless execution must run THERE
    // — resolving locally would run cells on the login node (or, on a
    // cross-arch allocation, fail the local ipykernel probe outright).
    const boundKernelService = () => ({
      hasSession: vi.fn(() => false),
      getSessionIdForFile: vi.fn(() => null),
      getNotebookKernelPreference: vi.fn(() => ({
        kernelName: 'env:/gpfs/envs/arm64-py/bin/python',
        serverId: '10.50.47.89:39549',
        updatedAt: 1,
      })),
      saveNotebookKernelPreference: vi.fn(),
      getOrCreateKernel: vi.fn(async () => ({ sessionId: 'local-oops', created: true })),
      executeCode: vi.fn(async () => ({ status: 'ok', executionCount: 1 })),
    });

    beforeEach(() => {
      proxyMocks.startRemoteKernel.mockReset();
      proxyMocks.executeRemoteCode.mockReset();
    });

    it('executes through the bound server, never starting a local kernel', async () => {
      const notebookPath = createTestNotebook('bound-exec.ipynb', [
        { id: 'cell-1', content: 'import platform; print(platform.machine())' },
      ]);
      const kernelService = boundKernelService();
      proxyMocks.startRemoteKernel.mockResolvedValue({ sessionId: '10.50.47.89:39549::sess-9', created: false });
      proxyMocks.executeRemoteCode.mockImplementation(
        async (_sid: string, _code: string, onOutput: (o: any) => Promise<void>) => {
          await onOutput({ type: 'stdout', content: 'aarch64\n' });
          return { status: 'ok', executionCount: 3 };
        }
      );

      handler = new HeadlessOperationHandler(fsService, router, kernelService as unknown as any);
      const result = await handler.applyOperation({ type: 'executeCell', notebookPath, cellId: 'cell-1' });

      expect(result.success).toBe(true);
      expect(proxyMocks.startRemoteKernel).toHaveBeenCalledWith(
        '10.50.47.89:39549',
        'env:/gpfs/envs/arm64-py/bin/python',
        notebookPath
      );
      expect(proxyMocks.executeRemoteCode).toHaveBeenCalledWith(
        '10.50.47.89:39549::sess-9',
        'import platform; print(platform.machine())',
        expect.any(Function),
        'cell-1'
      );
      expect(kernelService.getOrCreateKernel).not.toHaveBeenCalled();
      expect(kernelService.executeCode).not.toHaveBeenCalled();
      const outputs = result.outputs as Array<Record<string, unknown>>;
      expect(outputs[0].content).toBe('aarch64\n');
    });

    it('falls back to a local kernel when the bound server is gone (allocation ended)', async () => {
      const notebookPath = createTestNotebook('bound-gone.ipynb', [
        { id: 'cell-1', content: 'print(1)' },
      ]);
      const kernelService = boundKernelService();
      proxyMocks.startRemoteKernel.mockRejectedValue(new Error('Server not found: 10.50.47.89:39549'));

      handler = new HeadlessOperationHandler(fsService, router, kernelService as unknown as any);
      const result = await handler.applyOperation({ type: 'executeCell', notebookPath, cellId: 'cell-1' });

      expect(result.success).toBe(true);
      expect(kernelService.getOrCreateKernel).toHaveBeenCalledWith(
        notebookPath,
        'env:/gpfs/envs/arm64-py/bin/python'
      );
      expect(kernelService.executeCode).toHaveBeenCalled();
    });

    it('reuses a proxied session id passed by the caller', async () => {
      const notebookPath = createTestNotebook('bound-sid.ipynb', [
        { id: 'cell-1', content: 'print(1)' },
      ]);
      const kernelService = boundKernelService();
      proxyMocks.executeRemoteCode.mockResolvedValue({ status: 'ok', executionCount: 4 });

      handler = new HeadlessOperationHandler(fsService, router, kernelService as unknown as any);
      const result = await handler.applyOperation({
        type: 'executeCell',
        notebookPath,
        cellId: 'cell-1',
        sessionId: '10.50.47.89:39549::sess-77',
      });

      expect(result.success).toBe(true);
      expect(proxyMocks.startRemoteKernel).not.toHaveBeenCalled();
      expect(proxyMocks.executeRemoteCode).toHaveBeenCalledWith(
        '10.50.47.89:39549::sess-77',
        'print(1)',
        expect.any(Function),
        'cell-1'
      );
    });

    it('startKernel keeps the server binding and starts on the bound server', async () => {
      const notebookPath = createTestNotebook('bound-start.ipynb', [
        { id: 'cell-1', content: 'print(1)' },
      ]);
      const kernelService = boundKernelService();
      proxyMocks.startRemoteKernel.mockResolvedValue({ sessionId: '10.50.47.89:39549::sess-5', created: true });

      handler = new HeadlessOperationHandler(fsService, router, kernelService as unknown as any);
      const result = await handler.applyOperation({
        type: 'startKernel',
        notebookPath,
        kernelName: 'env:/gpfs/envs/arm64-py/bin/python',
      });

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe('10.50.47.89:39549::sess-5');
      expect(proxyMocks.startRemoteKernel).toHaveBeenCalledWith(
        '10.50.47.89:39549',
        'env:/gpfs/envs/arm64-py/bin/python',
        notebookPath
      );
      // The binding must survive the preference re-save — dropping serverId
      // here is what silently unbound notebooks from their allocations.
      expect(kernelService.saveNotebookKernelPreference).toHaveBeenCalledWith(
        notebookPath,
        'env:/gpfs/envs/arm64-py/bin/python',
        '10.50.47.89:39549'
      );
      expect(kernelService.getOrCreateKernel).not.toHaveBeenCalled();
    });
  });

});
