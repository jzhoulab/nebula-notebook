// @vitest-environment node
/**
 * Outputs-unchanged elision (payload diet for slow uplinks): a save may replace
 * a code cell's outputs with OUTPUTS_UNCHANGED_SENTINEL; the server must
 * re-use the outputs already on disk (matched by canonical cell ID), and must
 * demand a full payload (needsFull) whenever it cannot resolve the sentinel.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FilesystemService } from '../fs/fs-service';
import { NebulaCell, OUTPUTS_UNCHANGED_SENTINEL, JupyterNotebook } from '../fs/types';

const cell = (over: Partial<NebulaCell> & { id: string }): NebulaCell => ({
  type: 'code',
  content: '',
  outputs: [],
  executionCount: null,
  isExecuting: false,
  ...over,
});

const sentinelOutputs = OUTPUTS_UNCHANGED_SENTINEL as unknown as NebulaCell['outputs'];

describe('outputs-unchanged sentinel on .ipynb saves', () => {
  let service: FilesystemService;
  let dir: string;
  let nb: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-elide-'));
    service = new FilesystemService(dir);
    nb = path.join(dir, 'elide.ipynb');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const readRaw = (): JupyterNotebook => JSON.parse(fs.readFileSync(nb, 'utf-8'));

  it('re-uses on-disk outputs for sentinel cells', async () => {
    const bigOutput = [{
      type: 'display_data' as const,
      content: '',
      mimeBundle: { 'image/png': 'AAAB64==' },
    }];
    // Full save first
    const first = await service.saveNotebookCells(nb, [
      cell({ id: 'plot', content: 'plot()', outputs: bigOutput as never, executionCount: 1 }),
      cell({ id: 'calc', content: 'x=1' }),
    ]);
    expect(first.success).toBe(true);
    const savedOutputs = readRaw().cells[0].outputs;
    expect(readRaw().cells[0].id).toBe('plot');
    expect(readRaw().cells[0].metadata.nebula_id).toBeUndefined();
    expect(JSON.stringify(savedOutputs)).toContain('AAAB64==');

    // Second save: plot's outputs elided, calc edited
    const second = await service.saveNotebookCells(nb, [
      cell({ id: 'plot', content: 'plot()  # tweaked comment', outputs: sentinelOutputs, executionCount: 1 }),
      cell({ id: 'calc', content: 'x=2' }),
    ]);
    expect(second.success).toBe(true);
    const after = readRaw();
    // Outputs preserved verbatim from disk; content update applied
    expect(after.cells[0].outputs).toEqual(savedOutputs);
    expect(String(after.cells[0].source)).toContain('tweaked comment');
    expect(String(after.cells[1].source)).toContain('x=2');
    // The sentinel string itself never lands in the file
    expect(fs.readFileSync(nb, 'utf-8')).not.toContain(OUTPUTS_UNCHANGED_SENTINEL);
  });

  it('returns needsFull when a sentinel cell id is not on disk', async () => {
    const res = await service.saveNotebookCells(nb, [
      cell({ id: 'brand-new-cell', content: 'y=3', outputs: sentinelOutputs }),
    ]);
    expect(res.success).toBe(false);
    expect(res.needsFull).toBe(true);
  });

  it('returns needsFull when the file does not exist yet', async () => {
    const res = await service.saveNotebookCells(path.join(dir, 'missing.ipynb'), [
      cell({ id: 'a', content: 'z=1', outputs: sentinelOutputs }),
    ]);
    expect(res.success).toBe(false);
    expect(res.needsFull).toBe(true);
  });

  it('matches native IDs before mismatched legacy metadata', async () => {
    fs.writeFileSync(nb, JSON.stringify({
      cells: [{
        id: 'native-id',
        cell_type: 'code',
        source: ['plot()'],
        metadata: { nebula_id: 'stale-legacy-id' },
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['kept\n'] }],
        execution_count: 7,
      }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }));

    const native = await service.saveNotebookCells(nb, [
      cell({ id: 'native-id', content: 'plot()', outputs: sentinelOutputs }),
    ]);
    expect(native.success).toBe(true);
    expect(readRaw().cells[0].outputs?.[0].text).toEqual(['kept\n']);

    fs.writeFileSync(nb, JSON.stringify({
      cells: [{
        id: 'native-id',
        cell_type: 'code',
        source: ['plot()'],
        metadata: { nebula_id: 'stale-legacy-id' },
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['kept\n'] }],
        execution_count: 7,
      }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }));
    const staleLegacy = await service.saveNotebookCells(nb, [
      cell({ id: 'stale-legacy-id', content: 'plot()', outputs: sentinelOutputs }),
    ]);
    expect(staleLegacy).toMatchObject({ success: false, needsFull: true });
  });

  it('falls back to a valid legacy ID when an old notebook has no native ID', async () => {
    fs.writeFileSync(nb, JSON.stringify({
      cells: [{
        cell_type: 'code',
        source: ['legacy()'],
        metadata: { nebula_id: 'legacy-id' },
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['legacy output\n'] }],
        execution_count: 4,
      }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }));

    const result = await service.saveNotebookCells(nb, [
      cell({ id: 'legacy-id', content: 'legacy()', outputs: sentinelOutputs }),
    ]);
    expect(result.success).toBe(true);
    expect(readRaw().cells[0].id).toBe('legacy-id');
    expect(readRaw().cells[0].metadata.nebula_id).toBeUndefined();
    expect(readRaw().cells[0].outputs?.[0].text).toEqual(['legacy output\n']);
  });

  it('uses deterministic duplicate repair for sentinel lookup', async () => {
    fs.writeFileSync(nb, JSON.stringify({
      cells: [
        {
          id: 'duplicate',
          cell_type: 'code',
          source: ['a'],
          metadata: {},
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['first\n'] }],
          execution_count: 1,
        },
        {
          id: 'duplicate',
          cell_type: 'code',
          source: ['b'],
          metadata: {},
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['second\n'] }],
          execution_count: 2,
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }));
    expect((await service.getNotebookCells(nb)).cells.map((item) => item.id)).toEqual([
      'duplicate',
      'cell-1',
    ]);

    const result = await service.saveNotebookCells(nb, [
      cell({ id: 'duplicate', content: 'a', outputs: sentinelOutputs }),
      cell({ id: 'cell-1', content: 'b', outputs: sentinelOutputs }),
    ]);
    expect(result.success).toBe(true);
    expect(readRaw().cells.map((item) => item.outputs?.[0].text)).toEqual([
      ['first\n'],
      ['second\n'],
    ]);
  });

  it('text formats neutralize the sentinel instead of writing it', async () => {
    const qmd = path.join(dir, 'elide.qmd');
    const first = await service.saveNotebookCells(qmd, [cell({ id: 'a', content: 'x=1' })]);
    expect(first.success).toBe(true);
    const second = await service.saveNotebookCells(qmd, [
      cell({ id: 'a', content: 'x=2', outputs: sentinelOutputs }),
    ]);
    expect(second.success).toBe(true);
    expect(fs.readFileSync(qmd, 'utf-8')).not.toContain(OUTPUTS_UNCHANGED_SENTINEL);
  });
});
