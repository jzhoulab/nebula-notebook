// @vitest-environment node
/**
 * .ipynb serialization baseline.
 *
 * Locks the exact on-disk Jupyter JSON and parsed cell model for a
 * representative notebook. This is the executable guarantee that the
 * text-notebook-format work (percent .py, Quarto .qmd) leaves the .ipynb
 * code path untouched.
 *
 * RULE: this file must never need editing while adding new notebook formats.
 * If it fails, the .ipynb path changed — stop and find out why.
 *
 * Notes on current (locked) behavior:
 * - convertOutputs stamps outputs with a load-time `timestamp` — normalized
 *   to 0 before snapshotting.
 * - A hand-constructed cell list converges to canonical form after one
 *   save→load round trip; the snapshots capture the converged generation and
 *   the fixpoint is asserted explicitly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FilesystemService } from '../fs/fs-service';
import { NebulaCell } from '../fs/types';

const FIXTURE_CELLS: NebulaCell[] = [
  {
    id: 'abc123',
    type: 'code',
    content: 'import numpy as np\nx = np.arange(10)\nprint(x.sum())',
    outputs: [
      { id: 'o1', type: 'stdout', content: '45\n' },
      {
        id: 'o2',
        type: 'result',
        content: '<mime bundle>',
        mimeBundle: { 'text/plain': '45' },
      } as any,
    ],
    executionCount: 3,
    isExecuting: false,
  },
  {
    id: 'def456',
    type: 'markdown',
    content: '# Analysis\n\nSome *prose* here.',
    outputs: [],
    executionCount: null,
    isExecuting: false,
  },
  {
    id: 'ghi789',
    type: 'code',
    content: '1 / 0',
    outputs: [
      {
        id: 'o3',
        type: 'error',
        content: 'ZeroDivisionError: division by zero',
      },
    ],
    executionCount: 4,
    isExecuting: false,
    scrolled: true,
    scrolledHeight: 240,
    _metadata: { custom_key: { nested: true } },
  } as any,
];

const META = { nebula: { agent_permitted: true, full_width: true } };

function normalizeTimestamps(cells: unknown): unknown {
  return JSON.parse(
    JSON.stringify(cells, (key, value) => (key === 'timestamp' ? 0 : value))
  );
}

describe('ipynb serialization baseline (must never change)', () => {
  let service: FilesystemService;
  let testDir: string;
  let nbPath: string;
  let gen2Json: string;
  let gen2Cells: NebulaCell[];

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-ipynb-baseline-'));
    service = new FilesystemService(testDir);
    nbPath = path.join(testDir, 'baseline.ipynb');
    // Generation 1: hand-built cells → disk → parse (canonicalizes outputs)
    await service.saveNotebookCells(nbPath, FIXTURE_CELLS, 'python3', META);
    const gen1 = await service.getNotebookCells(nbPath);
    // Generation 2: canonical cells → disk → parse (the fixpoint)
    await service.saveNotebookCells(nbPath, gen1.cells as NebulaCell[], 'python3', META);
    gen2Json = fs.readFileSync(nbPath, 'utf-8');
    gen2Cells = (await service.getNotebookCells(nbPath)).cells as NebulaCell[];
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('produces the exact on-disk Jupyter JSON', () => {
    const parsed = JSON.parse(gen2Json);
    expect(parsed).toMatchSnapshot('baseline-jupyter-json');
    // Structural invariants stated explicitly (snapshot-independent):
    expect(parsed.nbformat).toBe(4);
    expect(parsed.nbformat_minor).toBe(5);
    expect(parsed.cells).toHaveLength(3);
    expect(parsed.cells[0].id).toBe('abc123');
    expect(parsed.cells[0].metadata.nebula_id).toBeUndefined();
    expect(parsed.cells[2].metadata.scrolled).toBe(true);
    expect(parsed.cells[2].metadata.custom_key).toEqual({ nested: true });
    expect(parsed.metadata.kernelspec.name).toBe('python3');
    expect(parsed.metadata.nebula.agent_permitted).toBe(true);
  });

  it('parses to the exact cell model', () => {
    expect(normalizeTimestamps(gen2Cells)).toMatchSnapshot('baseline-cell-model');
    expect(gen2Cells.map((c) => c.id)).toEqual(['abc123', 'def456', 'ghi789']);
    expect(gen2Cells[0].executionCount).toBe(3);
    expect(gen2Cells[0].outputs.length).toBeGreaterThan(0);
    expect(gen2Cells[2].scrolled).toBe(true);
    expect((gen2Cells[2] as any)._metadata?.custom_key).toEqual({ nested: true });
  });

  it('save→load→save is a fixpoint (deterministic serializer)', async () => {
    await service.saveNotebookCells(nbPath, gen2Cells, 'python3', META);
    const gen3Json = fs.readFileSync(nbPath, 'utf-8');
    expect(JSON.parse(gen3Json)).toEqual(JSON.parse(gen2Json));
    const gen3Cells = (await service.getNotebookCells(nbPath)).cells;
    expect(normalizeTimestamps(gen3Cells)).toEqual(normalizeTimestamps(gen2Cells));
  });
});
