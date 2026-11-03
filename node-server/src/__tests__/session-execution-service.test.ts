// @vitest-environment node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionExecutionService } from '../provenance/session-execution-service';

describe('durable persistent notebook sessions', () => {
  let root: string;
  let service: SessionExecutionService;
  let kernel: any;
  let count: number;
  let info: any;
  const openRequest = () => ({
    notebook_path: path.join(root, 'work.ipynb'),
    kernel_name: 'python3',
    environment_sha256: 'a'.repeat(64),
  });
  const settle = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const state = await service.operation(id);
      if (state && !['pending', 'running'].includes(state.status)) return state;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('fixture operation did not settle');
  };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nebula-session-'));
    count = 0;
    info = {
      id: 'kernel-1',
      pid: 123,
      createdAt: 7,
      executionCount: 0,
      status: 'idle',
      kernelName: 'python3',
      filePath: path.join(root, 'work.ipynb'),
    };
    kernel = {
      startKernel: vi.fn(async () => 'kernel-1'),
      getSessionStatusFast: vi.fn(() => ({ ...info, executionCount: count })),
      executeCode: vi.fn(async (_id, code, output) => {
        count++;
        await output({ type: 'stdout', content: 'fixture output\n' });
        return { status: 'ok', executionCount: count };
      }),
      interruptKernel: vi.fn(async () => true),
      stopKernel: vi.fn(async () => true),
    };
    service = new SessionExecutionService({
      rootDirectory: root,
      kernelService: kernel,
    });
  });
  afterEach(async () => {
    service.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function opened() {
    const first = await service.open(openRequest(), 'open-fixture');
    for (let i = 0; i < 100; i++) {
      const value = await service.session(first.session_id);
      if (value?.status === 'ready') return value;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('fixture session did not open');
  }
  const request = (session: any, revision = 0) => ({
    session_id: session.session_id,
    revision,
    code: 'x = 2',
    timeout_seconds: 5,
  });

  it('creates one notebook and one kernel for repeated opens', async () => {
    const session = await opened();
    expect(session.protocol).toBe('nebula-session-execution/v1');
    expect((await service.open(openRequest(), 'open-fixture')).session_id).toBe(
      session.session_id,
    );
    expect(kernel.startKernel).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(await fs.readFile(openRequest().notebook_path, 'utf8')).cells,
    ).toEqual([]);
    await expect(
      service.open({ ...openRequest(), kernel_name: 'other' }, 'open-fixture'),
    ).rejects.toThrow(/idempotency/i);
  });
  it('accepts concurrent identical opens without duplicate kernels', async () => {
    const sessions = await Promise.all(
      Array.from({ length: 12 }, () =>
        service.open(openRequest(), 'open-fixture'),
      ),
    );
    expect(new Set(sessions.map((s) => s.session_id)).size).toBe(1);
    await opened();
    expect(kernel.startKernel).toHaveBeenCalledTimes(1);
  });
  it('keeps the same kernel and returns saved results across service recreation', async () => {
    const session = await opened();
    const first = await service.execute(request(session), 'action-1');
    expect((await settle(first.operation_id))?.status).toBe('completed');
    service.close();
    service = new SessionExecutionService({
      rootDirectory: root,
      kernelService: kernel,
    });
    const duplicate = await service.execute(request(session), 'action-1');
    expect(duplicate.status).toBe('completed');
    expect(kernel.executeCode).toHaveBeenCalledTimes(1);
    const second = await service.execute(
      { ...request(session, 1), code: 'print(x)' },
      'action-2',
    );
    expect((await settle(second.operation_id))?.status).toBe('completed');
    expect(kernel.startKernel).toHaveBeenCalledTimes(1);
    const notebook = JSON.parse(
      await fs.readFile(openRequest().notebook_path, 'utf8'),
    );
    expect(notebook.cells.map((c: any) => c.source.join(''))).toEqual([
      'x = 2',
      'print(x)',
    ]);
  });
  it('claims a revision once even under concurrent or differently keyed submission', async () => {
    const session = await opened();
    let release!: () => void;
    kernel.executeCode.mockImplementation(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return { status: 'ok', executionCount: ++count };
    });
    const values = await Promise.all([
      service.execute(request(session), 'action-1'),
      service.execute(request(session), 'action-1'),
    ]);
    expect(values[0].operation_id).toBe(values[1].operation_id);
    await expect(
      service.execute(request(session), 'different-key'),
    ).rejects.toThrow(/revision|in.flight/i);
    await expect(
      service.execute({ ...request(session), code: 'other' }, 'action-1'),
    ).rejects.toThrow(/idempotency/i);
    for (let i = 0; !release && i < 100; i++)
      await new Promise((r) => setTimeout(r, 5));
    release();
    await settle(values[0].operation_id);
    expect(kernel.executeCode).toHaveBeenCalledTimes(1);
  });
  it('does not resubmit an interrupted dispatch and prevents later revisions', async () => {
    const session = await opened();
    kernel.executeCode.mockRejectedValue(
      new Error('connection lost after dispatch'),
    );
    const operation = await service.execute(request(session), 'ambiguous');
    expect((await settle(operation.operation_id))?.status).toBe('ambiguous');
    service.close();
    service = new SessionExecutionService({
      rootDirectory: root,
      kernelService: kernel,
    });
    expect((await service.execute(request(session), 'ambiguous')).status).toBe(
      'ambiguous',
    );
    await expect(service.execute(request(session, 1), 'later')).rejects.toThrow(
      /blocked|ready|revision/i,
    );
    expect(kernel.executeCode).toHaveBeenCalledTimes(1);
  });
  it('rejects external notebook changes before dispatch', async () => {
    const session = await opened();
    await fs.appendFile(openRequest().notebook_path, ' ');
    await expect(
      service.execute(request(session), 'changed-notebook'),
    ).rejects.toThrow(/notebook.*changed/i);
    expect(kernel.executeCode).not.toHaveBeenCalled();
  });
  it('rejects a replaced kernel before dispatch', async () => {
    const session = await opened();
    info.pid++;
    await expect(service.execute(request(session), 'replaced')).rejects.toThrow(
      /kernel.*replaced/i,
    );
    expect(kernel.executeCode).not.toHaveBeenCalled();
  });
  it('a second service observes an in-flight operation without redispatching', async () => {
    const session = await opened();
    let release!: () => void;
    kernel.executeCode.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 'ok', executionCount: ++count };
    });
    const operation = await service.execute(request(session), 'original-owner');
    for (let i = 0; !release && i < 100; i++)
      await new Promise((r) => setTimeout(r, 5));
    const observer = new SessionExecutionService({
      rootDirectory: root,
      kernelService: kernel,
    });
    try {
      expect(
        (await observer.execute(request(session), 'original-owner')).status,
      ).toBe('ambiguous');
      expect((await observer.session(session.session_id))?.status).toBe(
        'blocked',
      );
      release();
      await settle(operation.operation_id);
      expect((await observer.operation(operation.operation_id))?.status).toBe(
        'completed',
      );
      expect(kernel.executeCode).toHaveBeenCalledTimes(1);
    } finally {
      observer.close();
    }
  });
  it('a deadline interrupts once and retains an ambiguous outcome', async () => {
    const session = await opened();
    kernel.executeCode.mockImplementation(() => new Promise(() => {}));
    const body = { ...request(session), timeout_seconds: 1 };
    const operation = await service.execute(body, 'deadline');
    await new Promise((r) => setTimeout(r, 1100));
    expect((await settle(operation.operation_id))?.status).toBe('ambiguous');
    expect((await service.execute(body, 'deadline')).status).toBe('ambiguous');
    expect(kernel.interruptKernel).toHaveBeenCalledTimes(1);
    expect(kernel.executeCode).toHaveBeenCalledTimes(1);
  });
  it('retains code errors as observations, not transport ambiguity', async () => {
    const session = await opened();
    kernel.executeCode.mockImplementation(
      async (_id: string, _code: string, output: any) => {
        await output({ type: 'error', content: 'ValueError: fixture' });
        return {
          status: 'error',
          executionCount: ++count,
          error: 'ValueError: fixture',
        };
      },
    );
    const operation = await service.execute(request(session), 'code-error');
    const result = await settle(operation.operation_id);
    expect(result?.receipt?.protocol).toBe('nebula-session-execution/v1');
    expect(result?.status).toBe('completed');
    expect(result?.receipt?.outputs[0].type).toBe('error');
    expect((await service.session(session.session_id))?.revision).toBe(1);
  });
  it('refuses existing files and paths outside the declared workspace', async () => {
    await fs.writeFile(openRequest().notebook_path, 'user file');
    await expect(service.open(openRequest(), 'existing-file')).rejects.toThrow(
      /exists/i,
    );
    await expect(
      service.open(
        {
          ...openRequest(),
          notebook_path: path.join(root, '..', 'escape.ipynb'),
        },
        'outside',
      ),
    ).rejects.toThrow(/workspace|outside/i);
    expect(await fs.readFile(openRequest().notebook_path, 'utf8')).toBe(
      'user file',
    );
    expect(kernel.startKernel).not.toHaveBeenCalled();
  });
  it('surfaces a failed durable write instead of leaving initialization pending', async () => {
    vi.spyOn(service as any, 'saveSession').mockImplementation(() => {
      throw new Error('fixture disk full');
    });
    const opened = await service.open(openRequest(), 'storage-failure');
    let state = await service.session(opened.session_id);
    for (let i = 0; state?.status === 'opening' && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 5));
      state = await service.session(opened.session_id);
    }
    expect(state?.status).toBe('blocked');
    expect(kernel.startKernel).toHaveBeenCalledTimes(1);
  });
  it('never redispatches code after its completion receipt could not be saved', async () => {
    const session = await opened();
    const save = (service as any).saveSession.bind(service);
    vi.spyOn(service as any, 'saveSession').mockImplementation((value: any) => {
      if (value.status !== 'busy')
        throw new Error('fixture disk full after dispatch');
      return save(value);
    });
    const operation = await service.execute(
      request(session),
      'receipt-write-failed',
    );
    expect((await settle(operation.operation_id))?.status).toBe('ambiguous');
    expect(
      (await service.execute(request(session), 'receipt-write-failed')).status,
    ).toBe('ambiguous');
    expect((await service.session(session.session_id))?.status).toBe('blocked');
    expect(kernel.executeCode).toHaveBeenCalledTimes(1);
  });
});
