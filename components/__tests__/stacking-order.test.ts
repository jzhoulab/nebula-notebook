// @vitest-environment node
/**
 * App chrome must paint above cell chrome.
 *
 * The notebook header is a flex item with a z-index, and it also carries
 * `backdrop-blur` — either one makes it a stacking context, so everything
 * inside it, including the kernel menu's `z-50` dropdown, is clamped to the
 * header's own layer. The cell toolbar is `position: sticky` with its own
 * z-index in the root context. When the header's layer sat below the cell
 * toolbar's, the sticky toolbar painted straight over the open dropdown
 * (reported 2026-10-05: cell #55's header covering "Active Kernel", hiding
 * Interrupt).
 *
 * The invariant: the header is explicitly positioned (so its z-index applies
 * no matter what its parent's display is) AND outranks the cell toolbar.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8');

/** z-index of the sticky cell toolbar in Cell.tsx. */
function cellToolbarZ(): number {
  const m = read('components/Cell.tsx').match(/sticky top-0 z-(\d+)/);
  if (!m) throw new Error('Cell.tsx: no `sticky top-0 z-N` toolbar found');
  return Number(m[1]);
}

/** The notebook header's class string (the backdrop-blurred bar above the cells). */
function headerClasses(): string {
  const m = read('components/Notebook.tsx').match(/className="([^"]*backdrop-blur[^"]*border-b[^"]*)"/);
  if (!m) throw new Error('Notebook.tsx: notebook header (backdrop-blur + border-b) not found');
  return m[1];
}

describe('stacking order: app chrome over cell chrome', () => {
  it('the notebook header is positioned, so its z-index actually applies', () => {
    expect(headerClasses()).toMatch(/\b(relative|sticky|absolute|fixed)\b/);
  });

  it('the header outranks the sticky cell toolbar', () => {
    const header = headerClasses().match(/\bz-(\d+)\b/);
    expect(header, 'header has no z-index').not.toBeNull();
    expect(Number(header![1])).toBeGreaterThan(cellToolbarZ());
  });

  it('the cell toolbar still clears the output-area controls below it', () => {
    const outputs = read('components/CellOutput.tsx');
    const zs = [...outputs.matchAll(/\bz-(\d+)\b/g)].map((m) => Number(m[1]));
    expect(zs.length).toBeGreaterThan(0);
    expect(cellToolbarZ()).toBeGreaterThan(Math.max(...zs));
  });
});
