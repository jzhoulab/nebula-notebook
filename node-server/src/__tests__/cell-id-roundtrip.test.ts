// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FilesystemService } from '../fs/fs-service';
import type { NebulaCell } from '../fs/types';

const notebook = (cells: Record<string, unknown>[]) => ({
  cells,
  metadata: {
    kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
  },
  nbformat: 4,
  nbformat_minor: 5,
});

const jupyterCell = (
  source: string,
  options: { id?: unknown; legacyId?: unknown; metadata?: Record<string, unknown> } = {},
) => ({
  ...(options.id === undefined ? {} : { id: options.id }),
  cell_type: 'code',
  source: [source],
  metadata: {
    ...(options.legacyId === undefined ? {} : { nebula_id: options.legacyId }),
    ...(options.metadata || {}),
  },
  outputs: [],
  execution_count: null,
});

const nebulaCell = (id: string): NebulaCell => ({
  id,
  type: 'code',
  content: 'x = 1',
  outputs: [],
  isExecuting: false,
  executionCount: null,
});

describe('canonical Jupyter cell IDs', () => {
  let dir: string;
  let notebookPath: string;
  let service: FilesystemService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-cell-id-'));
    notebookPath = path.join(dir, 'ids.ipynb');
    service = new FilesystemService(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads native IDs first, migrates legacy fallbacks, and saves only top-level IDs', async () => {
    fs.writeFileSync(notebookPath, JSON.stringify(notebook([
      jupyterCell('native', {
        id: 'native-id',
        legacyId: 'stale-legacy-id',
        metadata: { custom: 'preserved' },
      }),
      jupyterCell('invalid native', { id: 'contains spaces', legacyId: 'legacy-valid' }),
      jupyterCell('legacy only', { legacyId: 'legacy-only' }),
      jupyterCell('missing'),
    ])));

    const loaded = await service.getNotebookCells(notebookPath);
    expect(loaded.cells.map((cell) => cell.id)).toEqual([
      'native-id',
      'legacy-valid',
      'legacy-only',
      'cell-3',
    ]);
    expect(loaded.cells[0]._metadata).toEqual({ custom: 'preserved' });

    await service.saveNotebookCells(notebookPath, loaded.cells, loaded.kernelspec, loaded.metadata);
    const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
    expect(saved.nbformat_minor).toBe(5);
    expect(saved.cells.map((cell: Record<string, unknown>) => cell.id)).toEqual([
      'native-id',
      'legacy-valid',
      'legacy-only',
      'cell-3',
    ]);
    expect(saved.cells[0].metadata.custom).toBe('preserved');
    expect(saved.cells.every((cell: { metadata: Record<string, unknown> }) => (
      !Object.prototype.hasOwnProperty.call(cell.metadata, 'nebula_id')
    ))).toBe(true);

    const reloaded = await service.getNotebookCells(notebookPath);
    expect(reloaded.cells.map((cell) => cell.id)).toEqual(loaded.cells.map((cell) => cell.id));
  });

  it('repairs collisions deterministically without stealing later native IDs', async () => {
    fs.writeFileSync(notebookPath, JSON.stringify(notebook([
      jupyterCell('first', { id: 'duplicate', legacyId: 'ignored-first-legacy' }),
      jupyterCell('second', { id: 'duplicate', legacyId: 'second-legacy' }),
      jupyterCell('third', { id: 'second-legacy' }),
      jupyterCell('occupies generated base', { id: 'cell-4' }),
      jupyterCell('missing'),
      jupyterCell('legacy would steal later native', { legacyId: 'later-native' }),
      jupyterCell('native owner', { id: 'later-native' }),
    ])));

    const firstRead = await service.getNotebookCells(notebookPath);
    const secondRead = service.getNotebookCellsSync(notebookPath);
    const expected = [
      'duplicate',
      'cell-1',
      'second-legacy',
      'cell-4',
      'cell-4-1',
      'cell-5',
      'later-native',
    ];
    expect(firstRead.cells.map((cell) => cell.id)).toEqual(expected);
    expect(secondRead.cells.map((cell) => cell.id)).toEqual(expected);
    expect(new Set(expected).size).toBe(expected.length);
  });

  it('validates internal IDs before saving and rejects duplicate IDs', async () => {
    const valid64 = 'a'.repeat(64);
    await expect(service.saveNotebookCells(notebookPath, [nebulaCell(valid64)]))
      .resolves.toMatchObject({ success: true });

    for (const invalid of ['', 'contains spaces', 'unicode-雪', 'a'.repeat(65)]) {
      await expect(service.saveNotebookCells(notebookPath, [nebulaCell(invalid)]))
        .rejects.toThrow(/invalid Jupyter cell ID/i);
    }
    await expect(service.saveNotebookCells(notebookPath, [
      nebulaCell('same-id'),
      nebulaCell('same-id'),
    ])).rejects.toThrow(/duplicate Jupyter cell ID/i);
  });

  it('strips a caller-supplied legacy ID while preserving unrelated metadata', async () => {
    const cell = {
      ...nebulaCell('canonical'),
      _metadata: { nebula_id: 'legacy', custom: { keep: true } },
    };
    await service.saveNotebookCells(notebookPath, [cell]);

    const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
    expect(saved.cells[0].id).toBe('canonical');
    expect(saved.cells[0].metadata).toEqual({ custom: { keep: true } });
  });
});
