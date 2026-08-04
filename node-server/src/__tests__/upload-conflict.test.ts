// @vitest-environment node
/**
 * Upload conflict policies.
 *
 * Lab report: an agent uploaded over an existing file, Nebula silently stored
 * `name_1.py` instead, and the success message claimed the original path was
 * written. The silent rename is RIGHT for browser drag-drop (never clobber on
 * a gesture) and WRONG as the only behavior for an API: callers must be able
 * to say what a name collision means — keep both, replace, or refuse.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FilesystemService } from '../fs/fs-service';

let root: string;
let svc: FilesystemService;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-upload-')));
  svc = new FilesystemService(root);
});

function tmpFileWith(content: string): string {
  const p = path.join(root, `.tmp-src-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, content);
  return p;
}

describe('uploadFile conflict policies', () => {
  it("default 'rename' keeps both and REPORTS the real stored path", async () => {
    fs.writeFileSync(path.join(root, 'train.py'), 'original');
    const info = await svc.uploadFile(root, tmpFileWith('new'), 'train.py');
    expect(info.name).toBe('train_1.py');
    expect(fs.readFileSync(path.join(root, 'train.py'), 'utf-8')).toBe('original');
    expect(fs.readFileSync(path.join(root, 'train_1.py'), 'utf-8')).toBe('new');
  });

  it("'overwrite' replaces the file in place", async () => {
    fs.writeFileSync(path.join(root, 'train.py'), 'original');
    const info = await svc.uploadFile(root, tmpFileWith('new'), 'train.py', 'overwrite');
    expect(info.name).toBe('train.py');
    expect(fs.readFileSync(path.join(root, 'train.py'), 'utf-8')).toBe('new');
    expect(fs.existsSync(path.join(root, 'train_1.py'))).toBe(false);
  });

  it("'fail' refuses loudly, names the path, and writes nothing", async () => {
    fs.writeFileSync(path.join(root, 'train.py'), 'original');
    await expect(svc.uploadFile(root, tmpFileWith('new'), 'train.py', 'fail'))
      .rejects.toThrow(/already exists.*train\.py/);
    expect(fs.readFileSync(path.join(root, 'train.py'), 'utf-8')).toBe('original');
    expect(fs.existsSync(path.join(root, 'train_1.py'))).toBe(false);
  });

  it('all policies behave identically when there is no conflict', async () => {
    for (const policy of ['rename', 'overwrite', 'fail'] as const) {
      const name = `fresh-${policy}.py`;
      const info = await svc.uploadFile(root, tmpFileWith(policy), name, policy);
      expect(info.name).toBe(name);
      expect(fs.readFileSync(path.join(root, name), 'utf-8')).toBe(policy);
    }
  });
});
