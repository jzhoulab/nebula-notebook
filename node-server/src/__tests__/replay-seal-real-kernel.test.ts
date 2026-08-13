// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KernelService } from '../kernel/kernel-service';
import { SessionStore } from '../kernel/session-store';
import { sha256Canonical, sha256Hex } from '../provenance/canonical-json';
import { ProvenanceStore } from '../provenance/provenance-store';
import {
  ReplaySealService,
  type ReplaySealStatusResponse,
} from '../provenance/replay-seal-service';

const python = process.env.NEBULA_REPLAY_TEST_PYTHON;

describe.skipIf(!python)('ReplaySealService real-kernel integration', () => {
  let testDir: string;
  let kernelService: KernelService;
  let service: ReplaySealService;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-real-replay-'));
    const sessionStore = new SessionStore(path.join(testDir, 'sessions.db'));
    kernelService = new KernelService({ startupTimeoutSeconds: 30 }, sessionStore);
    await kernelService.initialize();
    service = new ReplaySealService({
      rootDirectory: testDir,
      kernelService,
      provenanceStore: new ProvenanceStore({ durable: false }),
      durable: false,
    });
  }, 40_000);

  afterAll(async () => {
    await kernelService?.shutdown();
    const makeWritable = (current: string): void => {
      if (!fs.existsSync(current)) return;
      const stat = fs.lstatSync(current);
      if (stat.isDirectory()) {
        fs.chmodSync(current, 0o700);
        for (const entry of fs.readdirSync(current)) makeWritable(path.join(current, entry));
      } else if (!stat.isSymbolicLink()) {
        fs.chmodSync(current, 0o600);
      }
    };
    makeWritable(testDir);
    fs.rmSync(testDir, { recursive: true, force: true });
  }, 20_000);

  it('replays in the selected interpreter without probe-count pollution and seals artifacts', async () => {
    const notebookPath = path.join(testDir, 'analysis.ipynb');
    const artifactPath = path.join(testDir, 'result.csv');
    const packageDirectory = path.join(testDir, '.kosmos-packages');
    fs.mkdirSync(packageDirectory);
    fs.writeFileSync(artifactPath, 'value\n1\n');
    const source = [
      'from pathlib import Path',
      'Path("result.csv").write_text("value\\n1\\n")',
      'print("sealed-real")',
    ].join('\n');
    fs.writeFileSync(notebookPath, JSON.stringify({
      cells: [{
        id: 'real-cell',
        cell_type: 'code',
        source: [source],
        metadata: {},
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['sealed-real\n'] }],
        execution_count: 1,
      }],
      metadata: {
        kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    }));

    const submitted = await service.submit({
      notebook_path: notebookPath,
      source_notebook_sha256: sha256Hex(fs.readFileSync(notebookPath)),
      run_id: 'real-run',
      task_id: 'real-task',
      source_id: 'real-source',
      artifacts: [{
        path: artifactPath,
        sha256: sha256Hex(fs.readFileSync(artifactPath)),
        size_bytes: fs.statSync(artifactPath).size,
      }],
      kernel_name: `env:${python}`,
      input_manifest: {},
      environment_manifest: {
        base: {
          inspection: 'complete',
          python_binary_target: fs.realpathSync(python!),
        },
        task_local: {
          package_directory: packageDirectory,
          packages: {},
          packages_sha256: sha256Canonical({}),
        },
      },
    }, 'real-kernel-replay');

    let status: ReplaySealStatusResponse | null = submitted;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      status = await service.getStatus(submitted.seal_id);
      if (status && (status.status === 'completed' || status.status === 'failed')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (!status || status.status !== 'completed') {
      throw new Error((status?.status === 'failed' && status.error) || 'seal did not complete');
    }
    expect(status).toMatchObject({ status: 'completed' });
    expect(status.manifest.cells[0]).toMatchObject({
      execution_count: 1,
      outputs_match_exploratory: true,
    });
    expect(status.manifest.runtime_environment.python.executable_realpath)
      .toBe(fs.realpathSync(python!));
    expect(status.manifest.runtime_environment.python_no_user_site).toBe(true);
    expect(status.manifest.artifacts.map((item) => item.source_path))
      .toEqual([notebookPath, artifactPath]);
    expect(fs.readFileSync(status.manifest.artifacts[1].path, 'utf8')).toBe('value\n1\n');
  }, 60_000);
});
