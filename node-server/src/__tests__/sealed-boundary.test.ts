// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FilesystemService } from '../fs/fs-service';
import { classifySealedPath, SealedPathLockedError } from '../fs/sealed-path';
import notebookRoutes, { headlessHandler } from '../routes/notebook';
import fsRoutes from '../routes/fs';

function notebook(cells: unknown[] = []) {
  return JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 });
}

describe('sealed filesystem boundary', () => {
  let testDir: string;
  let service: FilesystemService;
  let sealDir: string;
  let sealedNotebook: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-sealed-boundary-'));
    sealDir = path.join(testDir, 'workspace', '.nebula', 'seals', 'seal-123');
    sealedNotebook = path.join(sealDir, 'notebook.ipynb');
    fs.mkdirSync(sealDir, { recursive: true });
    fs.writeFileSync(sealedNotebook, notebook());
    service = new FilesystemService(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('derives seal identity from normalized and symlink-resolved paths', () => {
    expect(classifySealedPath(path.join(sealDir, '..', 'seal-123', 'notebook.ipynb'))).toMatchObject({
      sealed: true,
      sealId: 'seal-123',
      sealedRoot: sealDir,
    });

    const alias = path.join(testDir, 'sealed-alias');
    fs.symlinkSync(sealDir, alias, 'dir');
    expect(classifySealedPath(path.join(alias, 'notebook.ipynb'))).toMatchObject({
      sealed: true,
      sealId: 'seal-123',
      sealedRoot: fs.realpathSync.native(sealDir),
    });
  });

  it('rejects every public filesystem/notebook mutation with a typed lock error', async () => {
    const assertLocked = async (operation: () => unknown | Promise<unknown>) => {
      await expect(Promise.resolve().then(operation)).rejects.toMatchObject({
        name: 'SealedPathLockedError',
        code: 'sealed_read_only',
        statusCode: 403,
        sealId: 'seal-123',
      });
    };

    await assertLocked(() => service.writeFile(sealedNotebook, notebook(), 'text'));
    await assertLocked(() => service.createFile(path.join(sealDir, 'new.txt')));
    await assertLocked(() => service.deleteFile(sealedNotebook));
    await assertLocked(() => service.renameFile(sealedNotebook, path.join(testDir, 'escaped.ipynb')));
    await assertLocked(() => service.renameFile(path.join(testDir, 'ordinary.txt'), path.join(sealDir, 'moved.txt')));
    await assertLocked(() => service.duplicateFile(sealedNotebook));

    const upload = path.join(testDir, 'upload.tmp');
    fs.writeFileSync(upload, 'upload');
    await assertLocked(() => service.uploadFile(sealDir, upload, 'uploaded.txt'));

    await assertLocked(() => service.saveNotebookCells(sealedNotebook, []));
    await assertLocked(() => service.saveNotebookBundle(sealedNotebook, []));
    await assertLocked(() => service.updateNotebookMetadata(sealedNotebook, { nebula: { full_width: true } }));
    await assertLocked(() => service.setAgentPermission(sealedNotebook, true));
    await assertLocked(() => service.saveHistory(sealedNotebook, []));
    await assertLocked(() => service.saveSession(sealedNotebook, {}));
  });

  it('blocks destructive changes to an ancestor that contains seals', () => {
    const workspace = path.join(testDir, 'workspace');
    expect(() => service.deleteFile(workspace)).toThrow(SealedPathLockedError);
    expect(() => service.renameFile(workspace, path.join(testDir, 'renamed-workspace'))).toThrow(SealedPathLockedError);
    expect(fs.existsSync(sealedNotebook)).toBe(true);
  });

  it('locks scientific ledgers, replay registries, and provenance blobs', async () => {
    const workspace = path.join(testDir, 'workspace');
    const ledger = path.join(workspace, '.nebula', 'analysis.ipynb.provenance.jsonl');
    const registry = path.join(testDir, '.nebula', 'replay-seal-jobs', 'seal-job.json');
    const blob = path.join(workspace, '.nebula', 'provenance', 'blobs', 'sha256', 'aa', 'digest');
    for (const target of [ledger, registry, blob]) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'server-owned');
      await expect(Promise.resolve().then(() => service.writeFile(target, 'tampered')))
        .rejects.toMatchObject({ code: 'sealed_read_only', statusCode: 403 });
      expect(fs.readFileSync(target, 'utf8')).toBe('server-owned');
    }

    expect(() => service.deleteFile(path.join(workspace, '.nebula')))
      .toThrow(SealedPathLockedError);
    expect(fs.existsSync(ledger)).toBe(true);
  });

  it('does not reconcile text-notebook history while reading a seal', async () => {
    const textNotebook = path.join(sealDir, 'snapshot.py');
    fs.writeFileSync(textNotebook, "# %%\nprint('new')\n");
    const [cell] = service.getNotebookCellsSync(textNotebook).cells;
    const sidecarDir = path.join(sealDir, '.nebula');
    const historyPath = path.join(sidecarDir, 'snapshot.py.history.json');
    const lastSavePath = path.join(sidecarDir, 'snapshot.py.lastsave.json');
    const originalHistory = [{ type: 'snapshot', cells: [], timestamp: 1 }];
    fs.mkdirSync(sidecarDir, { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify(originalHistory));
    fs.writeFileSync(lastSavePath, JSON.stringify({
      cells: [{ id: cell.id, type: 'code', content: "print('old')" }],
    }));

    expect(await service.loadHistory(textNotebook)).toEqual(originalHistory);
    expect(JSON.parse(fs.readFileSync(historyPath, 'utf-8'))).toEqual(originalHistory);
    expect(JSON.parse(fs.readFileSync(lastSavePath, 'utf-8'))).toEqual({
      cells: [{ id: cell.id, type: 'code', content: "print('old')" }],
    });
  });

  it('does not lock an ordinary path merely because a caller says sealed', () => {
    const ordinary = path.join(testDir, 'ordinary.txt');
    service.writeFile(ordinary, 'before');
    service.writeFile(ordinary, 'after');
    expect(fs.readFileSync(ordinary, 'utf-8')).toBe('after');
    expect(classifySealedPath(ordinary)).toEqual({ sealed: false });
  });
});

describe('sealed notebook HTTP contract', () => {
  let app: FastifyInstance;
  let testDir: string;
  let sealedNotebook: string;
  let ordinaryNotebook: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-sealed-routes-'));
    const sealDir = path.join(testDir, '.nebula', 'seals', 'seal-route');
    sealedNotebook = path.join(sealDir, 'notebook.ipynb');
    ordinaryNotebook = path.join(testDir, 'ordinary.ipynb');
    fs.mkdirSync(sealDir, { recursive: true });
    fs.writeFileSync(sealedNotebook, notebook([{
      id: 'canonical-cell', cell_type: 'code', source: ['1 + 1'], metadata: {}, outputs: [], execution_count: 1,
    }]));
    fs.writeFileSync(ordinaryNotebook, notebook());
    app = Fastify();
    await app.register(notebookRoutes, { prefix: '/api' });
    await app.register(fsRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterEach(async () => {
    await headlessHandler.flush();
    await app.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('reports server-derived sealed access even without a mode query', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/notebook/cells?path=${encodeURIComponent(sealedNotebook)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().access).toEqual({
      read_only: true,
      reason: 'sealed',
      seal_id: 'seal-route',
    });
  });

  it('ignores mode=sealed as authority for an ordinary notebook', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/notebook/cells?path=${encodeURIComponent(ordinaryNotebook)}&mode=sealed`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().access).toEqual({ read_only: false });
  });

  it('rejects a deep-link seal hint that does not match the canonical path', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/notebook/cells?path=${encodeURIComponent(sealedNotebook)}&seal=${encodeURIComponent('wrong-seal')}`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'seal_mismatch' });
  });

  it('returns a typed 403 for REST saves and notebook operations', async () => {
    const save = await app.inject({
      method: 'POST',
      url: '/api/notebook/save',
      payload: { path: sealedNotebook, cells: [] },
    });
    expect(save.statusCode).toBe(403);
    expect(save.json()).toMatchObject({ code: 'sealed_read_only', seal_id: 'seal-route' });

    const operation = await app.inject({
      method: 'POST',
      url: '/api/notebook/operation',
      payload: { operation: { type: 'executeCell', notebookPath: sealedNotebook, cellId: 'canonical-cell' } },
    });
    expect(operation.statusCode).toBe(403);
    expect(operation.json()).toMatchObject({ code: 'sealed_read_only', seal_id: 'seal-route' });
  });

  it('returns the same typed 403 from public filesystem mutations', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/fs/write',
      payload: { path: sealedNotebook, content: 'tampered', file_type: 'text' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'sealed_read_only', seal_id: 'seal-route' });
    expect(JSON.parse(fs.readFileSync(sealedNotebook, 'utf-8')).cells[0].id).toBe('canonical-cell');
  });
});
