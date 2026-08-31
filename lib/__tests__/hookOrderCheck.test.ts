/**
 * The hooks-after-early-return guard, and the codebase-wide assertion it
 * powers. See lib/hookOrderCheck.ts for why this lives in the test suite.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { findHookOrderViolations } from '../hookOrderCheck';

describe('findHookOrderViolations', () => {
  it('flags a hook placed after an early return (the shipped bug)', () => {
    const code = `
      export default function Modal({ isOpen }: { isOpen: boolean }) {
        const [a, setA] = useState(false);
        if (!isOpen) return null;
        useEffect(() => { setA(true); }, []);
        return <div>{String(a)}</div>;
      }
    `;
    const v = findHookOrderViolations('Modal.tsx', code);
    expect(v).toHaveLength(1);
    expect(v[0].hook).toBe('useEffect');
  });

  it('accepts hooks that all run before the early return', () => {
    const code = `
      export default function Modal({ isOpen }: { isOpen: boolean }) {
        const [a] = useState(false);
        useEffect(() => {}, []);
        if (!isOpen) return null;
        return <div>{String(a)}</div>;
      }
    `;
    expect(findHookOrderViolations('Modal.tsx', code)).toEqual([]);
  });

  it('ignores plain helper functions that return early and never call hooks', () => {
    const code = `
      function limitMinutes(s: string): number | null {
        if (!s) return null;
        return parseInt(s, 10);
      }
      export function useThing() {
        const [a] = useState(1);
        return a;
      }
    `;
    expect(findHookOrderViolations('helpers.ts', code)).toEqual([]);
  });

  it('does not mistake hooks inside callbacks for top-level hooks', () => {
    const code = `
      export default function C({ isOpen }: { isOpen: boolean }) {
        const cb = useCallback(() => { const x = useless(); return x; }, []);
        if (!isOpen) return null;
        return <div onClick={cb} />;
      }
    `;
    expect(findHookOrderViolations('C.tsx', code)).toEqual([]);
  });
});

describe('no component in this repo calls a hook after an early return', () => {
  const roots = ['components', 'hooks', 'services', 'lib'];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r);

  it(`scans every source file (${files.length} found) and finds none`, () => {
    expect(files.length).toBeGreaterThan(20); // the walk actually found sources
    const all = files.flatMap((f) => findHookOrderViolations(f, fs.readFileSync(f, 'utf-8')));
    const readable = all.map((v) => `${v.file}:${v.line} ${v.hook}() runs after the early return on line ${v.returnLine}`);
    expect(readable).toEqual([]);
  });
});
