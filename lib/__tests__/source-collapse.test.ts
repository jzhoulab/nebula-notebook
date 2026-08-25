// @vitest-environment node
/**
 * Source (code) collapse: long code cells get the same fixed-height,
 * adjustable, persisted treatment outputs already have. Lab report: "output
 * can be collapsed to fixed adjustable height but code cell still cannot."
 *
 * Persistence mirrors the output pair (scrolled / scrolled_height) with
 * source_collapsed / source_height in cell metadata, so a collapsed cell
 * stays collapsed across reloads and for other tools reading the .ipynb.
 */

import { describe, it, expect } from 'vitest';
import { UndoRedoManager } from '../undoRedoCore';
import { CELL_METADATA_SCHEMA, isAgentMutableField, validateMetadataValue } from '../cellMetadata';
import type { Cell } from '../../types';

const cells = (): Cell[] => ([
  { id: 'c1', type: 'code', content: 'x = 1\n'.repeat(200), outputs: [], isExecuting: false },
]);

describe('source collapse metadata', () => {
  it('is declared in the shared schema, agent-mutable and validated', () => {
    expect(CELL_METADATA_SCHEMA.sourceCollapsed.type).toBe('boolean');
    expect(CELL_METADATA_SCHEMA.sourceHeight.type).toBe('number');
    expect(isAgentMutableField('sourceCollapsed')).toBe(true);
    expect(validateMetadataValue('sourceCollapsed', true).valid).toBe(true);
    expect(validateMetadataValue('sourceCollapsed', 'yes').valid).toBe(false);
    expect(validateMetadataValue('sourceHeight', 240).valid).toBe(true);
  });

  it('collapse and height changes are undoable operations', () => {
    const h = new UndoRedoManager(cells());
    h.setCellSourceCollapsed('c1', true);
    expect(h.getCells()[0].sourceCollapsed).toBe(true);
    h.setCellSourceHeight('c1', 320);
    expect(h.getCells()[0].sourceHeight).toBe(320);

    h.undo();
    expect(h.getCells()[0].sourceHeight).toBeUndefined();
    h.undo();
    expect(h.getCells()[0].sourceCollapsed).toBe(false);
    h.redo();
    expect(h.getCells()[0].sourceCollapsed).toBe(true);
  });

  it('no-op changes do not create history entries', () => {
    const h = new UndoRedoManager(cells());
    h.setCellSourceCollapsed('c1', false); // already effectively false
    expect(h.canUndo()).toBe(false);
    h.setCellSourceCollapsed('c1', true);
    h.setCellSourceCollapsed('c1', true); // same value again
    h.undo();
    expect(h.getCells()[0].sourceCollapsed).toBe(false);
    expect(h.canUndo()).toBe(false);
  });
});
