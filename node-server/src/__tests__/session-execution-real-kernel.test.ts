// @vitest-environment node
// Follows replay-seal-real-kernel.test.ts's native kernel setup and cleanup.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KernelService } from '../kernel/kernel-service';
import { SessionStore } from '../kernel/session-store';
import { SessionExecutionService } from '../provenance/session-execution-service';

const python = process.env.NEBULA_REPLAY_TEST_PYTHON;
describe.skipIf(!python)('persistent session real-kernel integration', () => {
  let root: string;
  let kernel: KernelService;
  let service: SessionExecutionService;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nebula-real-session-'));
    kernel = new KernelService(
      { startupTimeoutSeconds: 30 },
      new SessionStore(path.join(root, 'kernels.sqlite')),
    );
    await kernel.initialize();
    service = new SessionExecutionService({
      rootDirectory: root,
      kernelService: kernel,
    });
  }, 40_000);
  afterAll(async () => {
    await kernel?.shutdown();
    service?.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }, 20_000);
  async function settle<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
  ): Promise<T> {
    for (let i = 0; i < 600; i++) {
      const value = await read();
      if (done(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Native session did not reach its receipt checkpoint');
  }
  it('preserves variables, records outputs and never repeats a completed side effect', async () => {
    const opened = await service.open(
      {
        notebook_path: path.join(root, 'analysis.ipynb'),
        kernel_name: `env:${python}`,
        environment_sha256: '1'.repeat(64),
      },
      'native-session',
    );
    const session = await settle(
      () => service.session(opened.session_id),
      (value) => value?.status !== 'opening',
    );
    expect(session?.status, JSON.stringify(session)).toBe('ready');
    const firstRequest = {
      session_id: opened.session_id,
      revision: 0,
      timeout_seconds: 20,
      code: 'from pathlib import Path\nx = 40\nPath("side-effect.txt").write_text("once")\nprint(x)',
    };
    const first = await service.execute(firstRequest, 'native-execution-1');
    const result = await settle(
      () => service.operation(first.operation_id),
      (value) => !['pending', 'running'].includes(value?.status || 'pending'),
    );
    expect(result?.status, JSON.stringify(result)).toBe('completed');
    service.close();
    service = new SessionExecutionService({
      rootDirectory: root,
      kernelService: kernel,
    });
    expect(
      (await service.execute(firstRequest, 'native-execution-1')).receipt,
    ).toEqual(result?.receipt);
    const second = await service.execute(
      {
        session_id: opened.session_id,
        revision: 1,
        timeout_seconds: 20,
        code: 'x += 2\nprint(x)',
      },
      'native-execution-2',
    );
    const finished = await settle(
      () => service.operation(second.operation_id),
      (value) => !['pending', 'running'].includes(value?.status || 'pending'),
    );
    expect(finished?.status, JSON.stringify(finished)).toBe('completed');
    expect(
      finished?.receipt?.outputs.some((o) => o.content.includes('42')),
    ).toBe(true);
    expect(finished?.receipt?.execution_count).toBe(2);
    expect(finished?.receipt?.kernel_id).toBe(result?.receipt?.kernel_id);
    expect(await fs.readFile(path.join(root, 'side-effect.txt'), 'utf8')).toBe(
      'once',
    );
    const notebook = JSON.parse(
      await fs.readFile(path.join(root, 'analysis.ipynb'), 'utf8'),
    );
    expect(notebook.cells).toHaveLength(2);
    expect(notebook.cells[1].outputs[0]).toMatchObject({
      output_type: 'stream',
      name: 'stdout',
      text: ['42\n'],
    });
  }, 60_000);
});
