// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { canonicalJson, sha256Canonical, sha256Hex } from '../provenance/canonical-json';
import { ProvenanceStore } from '../provenance/provenance-store';
import {
  ReplaySealConflictError,
  ReplaySealService,
  ReplaySealValidationError,
  normalizeNotebookOutputsForComparison,
  type ReplayKernelService,
  type ReplaySealRequest,
  type ReplaySealManifest,
  type ReplaySealStatusResponse,
} from '../provenance/replay-seal-service';
import type {
  ExecutionQueueInfo,
  ExecutionResult,
  InternalExecutionOptions,
  KernelOutput,
  StartKernelOptions,
} from '../kernel/types';

interface FakeExecution {
  sessionId: string;
  code: string;
  cellId?: string | null;
}

class FakeKernelService implements ReplayKernelService {
  readonly starts: StartKernelOptions[] = [];
  readonly executions: FakeExecution[] = [];
  readonly stops: string[] = [];
  private executionCount = 0;
  readonly execute = vi.fn(async (
    sessionId: string,
    code: string,
    onOutput: (output: KernelOutput, cellId?: string | null) => Promise<void>,
    _onQueueInfo?: (info: ExecutionQueueInfo) => void,
    cellId?: string | null,
    internalOptions?: InternalExecutionOptions,
  ): Promise<ExecutionResult> => {
    this.executions.push({ sessionId, code, cellId });
    if (internalOptions?.storeHistory !== false) this.executionCount += 1;
    const executionCount = this.executionCount;
    if (code.includes('__NEBULA_RUNTIME_ENV_BEGIN__')) {
      const value = code.includes('distributions(path=[')
        ? { local_package: '1.0.0' }
        : {
            executable: '/rich/bin/python',
            executable_realpath: '/rich/bin/python',
            implementation: 'CPython',
            version: '3.12.4',
            platform: 'test-platform',
            base_packages: {},
          };
      await onOutput({
        type: 'stdout',
        content: `__NEBULA_RUNTIME_ENV_BEGIN__${JSON.stringify(value)}__NEBULA_RUNTIME_ENV_END__\n`,
      }, cellId);
      return { status: 'ok', executionCount };
    }
    if (code.includes('FAIL')) {
      await onOutput({ type: 'error', content: 'ValueError: deliberate failure' }, cellId);
      return { status: 'error', executionCount, error: 'ValueError: deliberate failure' };
    }
    if (code.includes('display(4)')) {
      await onOutput({
        type: 'display_data',
        content: '4',
        mimeBundle: { 'text/plain': '4' },
        metadata: {},
        jupyterOutputType: 'execute_result',
        jupyterExecutionCount: executionCount,
      }, cellId);
    } else {
      await onOutput({ type: 'stdout', content: `${code}\n` }, cellId);
    }
    return { status: 'ok', executionCount };
  });

  async startKernel(options: StartKernelOptions = {}): Promise<string> {
    this.starts.push({ ...options });
    return `fresh-session-${this.starts.length}`;
  }

  async executeCode(
    sessionId: string,
    code: string,
    onOutput: (output: KernelOutput, cellId?: string | null) => Promise<void>,
    onQueueInfo?: (info: ExecutionQueueInfo) => void,
    cellId?: string | null,
    internalOptions?: InternalExecutionOptions,
  ): Promise<ExecutionResult> {
    return this.execute(sessionId, code, onOutput, onQueueInfo, cellId, internalOptions);
  }

  async stopKernel(sessionId: string): Promise<boolean> {
    this.stops.push(sessionId);
    return true;
  }
}

function writeNotebook(
  notebookPath: string,
  cells: Array<Record<string, unknown>>,
): void {
  fs.writeFileSync(notebookPath, JSON.stringify({
    cells,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 2));
}

function codeCell(id: string, source: string): Record<string, unknown> {
  return {
    id,
    cell_type: 'code',
    source: source.split(/(?<=\n)/),
    metadata: {},
    outputs: [{ output_type: 'stream', name: 'stdout', text: 'stale output\n' }],
    execution_count: 99,
  };
}

function requestFor(notebookPath: string): ReplaySealRequest {
  return {
    notebook_path: notebookPath,
    run_id: 'run-1',
    task_id: 'task-1',
    source_id: 'kosmos-rollout-1',
    source_notebook_sha256: sha256Hex(fs.readFileSync(notebookPath)),
    artifacts: [],
    kernel_name: 'python-rich',
    input_manifest: { dataset: { sha256: sha256Hex('dataset') } },
    environment_manifest: { python: '3.12', packages: ['numpy==2.1.0'] },
  };
}

function artifactDescriptor(filePath: string): ReplaySealRequest['artifacts'][number] {
  const bytes = fs.readFileSync(filePath);
  return {
    path: filePath,
    sha256: sha256Hex(bytes),
    size_bytes: bytes.length,
  };
}

/**
 * Terminal states flattened for assertions: a completed seal has `manifest`,
 * a failed one has `error` — tests probe both fields on either outcome
 * (e.g. `expect(completed.error).toBeUndefined()`), which the discriminated
 * ReplaySealStatusResponse union rightly forbids at compile time.
 */
type TerminalSealStatus = {
  seal_id: string;
  status: 'completed' | 'failed';
  manifest?: ReplaySealManifest;
  error?: string;
};

async function waitForTerminal(
  service: ReplaySealService,
  sealId: string,
): Promise<TerminalSealStatus> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await service.getStatus(sealId);
    if (status && (status.status === 'completed' || status.status === 'failed')) {
      return status as TerminalSealStatus;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`seal ${sealId} did not finish`);
}

describe('ReplaySealService', () => {
  let testDir: string;
  let notebookPath: string;
  let kernel: FakeKernelService;
  let store: ProvenanceStore;
  let service: ReplaySealService;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-replay-seal-'));
    notebookPath = path.join(testDir, 'analysis.ipynb');
    kernel = new FakeKernelService();
    store = new ProvenanceStore({ durable: false });
    service = new ReplaySealService({
      rootDirectory: testDir,
      kernelService: kernel,
      provenanceStore: store,
      durable: false,
    });
  });

  afterEach(() => {
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
  });

  it('freezes, replays, seals, and hash-binds a notebook in one fresh dedicated kernel', async () => {
    const figurePath = path.join(testDir, 'figures', 'effect.png');
    fs.mkdirSync(path.dirname(figurePath));
    fs.writeFileSync(figurePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeNotebook(notebookPath, [
      codeCell('load-data', 'print("alpha")'),
      { id: 'explanation', cell_type: 'markdown', source: ['# Result'], metadata: {} },
      codeCell('estimate', 'display(4)'),
    ]);
    const originalBytes = fs.readFileSync(notebookPath);

    const request = { ...requestFor(notebookPath), artifacts: [artifactDescriptor(figurePath)] };
    const submitted = await service.submit(request, 'seal-request-1');
    expect(submitted.status).toMatch(/^(pending|running)$/);

    const completed = await waitForTerminal(service, submitted.seal_id);
    expect(completed.error).toBeUndefined();
    expect(completed).toMatchObject({ status: 'completed' });
    expect(completed.manifest).toBeDefined();

    expect(kernel.starts).toEqual([{
      kernelName: 'python-rich',
      cwd: testDir,
      internalEnv: { PYTHONNOUSERSITE: '1' },
    }]);
    expect(kernel.executions
      .filter(({ cellId }) => cellId !== null)
      .map(({ sessionId, code, cellId }) => ({ sessionId, code, cellId })))
      .toEqual([
        { sessionId: 'fresh-session-1', code: 'print("alpha")', cellId: 'load-data' },
        { sessionId: 'fresh-session-1', code: 'display(4)', cellId: 'estimate' },
      ]);
    expect(kernel.stops).toEqual(['fresh-session-1']);
    expect(fs.readFileSync(notebookPath)).toEqual(originalBytes);

    const manifest = completed.manifest!;
    expect(manifest).toMatchObject({
      schema_version: 1,
      hash_profile: 'nebula-canonical-hash-v1',
      seal_id: submitted.seal_id,
      input_manifest_sha256: sha256Canonical(requestFor(notebookPath).input_manifest),
      environment_manifest_sha256: sha256Canonical(requestFor(notebookPath).environment_manifest),
      isolation: {
        fresh_kernel: true,
        network_isolated: false,
        filesystem_isolated: false,
      },
    });
    expect(path.isAbsolute(manifest.notebook.path)).toBe(true);
    expect(manifest.notebook.path).toBe(
      path.join(fs.realpathSync(testDir), '.nebula', 'seals', submitted.seal_id, 'notebook.ipynb'),
    );
    expect(manifest.notebook.sha256).toBe(sha256Hex(fs.readFileSync(manifest.notebook.path)));
    expect(manifest.cells).toHaveLength(2);
    expect(manifest.cells.map((cell) => cell.cell_id)).toEqual(['load-data', 'estimate']);
    expect(manifest.cells.map((cell) => cell.execution_count)).toEqual([1, 2]);
    expect(new Set(manifest.cells.map((cell) => cell.execution_id)).size).toBe(2);
    expect(manifest.cells[0]).toMatchObject({
      source_sha256: sha256Hex('print("alpha")'),
      exploratory_outputs_sha256: sha256Canonical([
        { output_type: 'stream', name: 'stdout', text: 'stale output\n' },
      ]),
      outputs_match_exploratory: false,
      exploratory_execution_count: 99,
      status: 'completed',
    });
    expect(manifest.cells[0].outputs_sha256).toBe(sha256Canonical([
      { output_type: 'stream', name: 'stdout', text: 'print("alpha")\n' },
    ]));
    expect(manifest.cells[0].replay_comparison_outputs_sha256)
      .toBe(manifest.cells[0].outputs_sha256);
    const sealedDocument = JSON.parse(fs.readFileSync(manifest.notebook.path, 'utf8'));
    expect(sealedDocument.cells[2].outputs[0]).toMatchObject({
      output_type: 'execute_result',
      execution_count: 2,
      data: { 'text/plain': '4' },
    });
    expect(manifest.artifacts).toEqual([
      {
        source_path: notebookPath,
        path: manifest.notebook.path,
        sha256: manifest.notebook.sha256,
        size_bytes: fs.statSync(manifest.notebook.path).size,
      },
      {
        source_path: figurePath,
        path: path.join(
          fs.realpathSync(testDir),
          '.nebula',
          'seals',
          submitted.seal_id,
          'artifacts',
          'figures',
          'effect.png',
        ),
        sha256: sha256Hex(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
        size_bytes: 4,
      },
    ]);
    expect(fs.readFileSync(manifest.artifacts[1].path)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(fs.statSync(manifest.artifacts[1].path).mode & 0o222).toBe(0);

    const { manifest_sha256: _manifestHash, ...unsignedManifest } = manifest;
    expect(manifest.manifest_sha256).toBe(sha256Canonical(unsignedManifest));
    expect(fs.readFileSync(path.join(path.dirname(manifest.notebook.path), 'manifest.json'), 'utf8'))
      .toBe(`${canonicalJson(manifest)}\n`);
    expect(fs.statSync(manifest.notebook.path).mode & 0o222).toBe(0);
    expect(fs.statSync(path.join(path.dirname(manifest.notebook.path), 'manifest.json')).mode & 0o222)
      .toBe(0);

    const events = await store.read(notebookPath);
    expect(events.map((event) => event.type)).toEqual([
      'seal.started',
      'seal.environment.probed',
      'seal.cell.completed',
      'seal.cell.completed',
      'seal.completed',
    ]);
    expect(events[0].payload).toMatchObject({
      artifacts: [{
        path: figurePath,
        sha256: sha256Hex(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
        sizeBytes: 4,
      }],
    });
    expect(events.at(-1)?.eventHash).toBe(manifest.event_chain_head_sha256);
    expect(events.at(-1)?.payload).toMatchObject({
      hashProfile: 'nebula-canonical-hash-v1',
    });
    const ledgerBytes = fs.readFileSync(manifest.event_ledger.path)
      .subarray(0, manifest.event_ledger.prefix_size_bytes);
    expect(ledgerBytes.at(-1)).toBe(0x0a);
    expect(sha256Hex(ledgerBytes)).toBe(manifest.event_ledger.prefix_sha256);
    expect(manifest.event_ledger).toMatchObject({
      head_sha256: manifest.event_chain_head_sha256,
      head_seq: events.at(-1)?.seq,
    });
    expect(events[2]).toMatchObject({
      runId: 'run-1',
      taskId: 'task-1',
      sourceId: 'kosmos-rollout-1',
      executionId: manifest.cells[0].execution_id,
      inputManifestSha256: manifest.input_manifest_sha256,
      environmentManifestSha256: manifest.environment_manifest_sha256,
      payload: {
        cellId: 'load-data',
        sourceSha256: manifest.cells[0].source_sha256,
        outputsSha256: manifest.cells[0].outputs_sha256,
        executionCount: 1,
        status: 'completed',
      },
    });
    expect((await store.verifyBlob(notebookPath, manifest.input_manifest_sha256)).valid).toBe(true);
    expect((await store.verifyBlob(notebookPath, manifest.environment_manifest_sha256)).valid)
      .toBe(true);
  });

  it('bootstraps the declared task-local package directory before evidence cells and records it', async () => {
    const packageDirectory = path.join(testDir, '.kosmos-packages');
    fs.mkdirSync(packageDirectory);
    writeNotebook(notebookPath, [codeCell('evidence', 'import local_package')]);
    const request = requestFor(notebookPath);
    request.environment_manifest = {
      ...request.environment_manifest,
      task_local: {
        package_directory: packageDirectory,
        packages: { local_package: '1.0.0' },
      },
    };

    const submitted = await service.submit(request, 'package-bootstrap');
    const completed = await waitForTerminal(service, submitted.seal_id);

    expect(completed.status).toBe('completed');
    expect(kernel.executions).toHaveLength(3);
    expect(kernel.executions[0]).toMatchObject({
      sessionId: 'fresh-session-1',
      cellId: null,
    });
    expect(kernel.executions[1].code).toContain(JSON.stringify(packageDirectory));
    expect(kernel.executions[1].code).toContain('sys.path.insert');
    expect(kernel.executions[2]).toMatchObject({
      code: 'import local_package',
      cellId: 'evidence',
    });
    expect(completed.manifest!.cells[0].execution_count).toBe(1);
    expect(completed.manifest!.bootstrap).toMatchObject({
      package_directory: packageDirectory,
      source_sha256: sha256Hex(kernel.executions[1].code),
      status: 'completed',
    });
    expect((await store.read(notebookPath)).map((event) => event.type)).toEqual([
      'seal.started',
      'seal.environment.probed',
      'seal.bootstrap.completed',
      'seal.cell.completed',
      'seal.completed',
    ]);
  });

  it('executes the frozen snapshot even when the exploratory notebook changes after submission', async () => {
    writeNotebook(notebookPath, [codeCell('frozen-cell', 'ORIGINAL')]);
    let releaseExecution!: () => void;
    const executionBlocked = new Promise<void>((resolve) => { releaseExecution = resolve; });
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => { executionStarted = resolve; });
    kernel.execute.mockImplementation(async (
      sessionId: string,
      code: string,
      onOutput: (output: KernelOutput, cellId?: string | null) => Promise<void>,
      _onQueueInfo?: (info: ExecutionQueueInfo) => void,
      cellId?: string | null,
    ) => {
      kernel.executions.push({ sessionId, code, cellId });
      if (code.includes('__NEBULA_RUNTIME_ENV_BEGIN__')) {
        await onOutput({
          type: 'stdout',
          content: '__NEBULA_RUNTIME_ENV_BEGIN__'
            + JSON.stringify({
              executable: '/rich/bin/python',
              executable_realpath: '/rich/bin/python',
              implementation: 'CPython',
              version: '3.12.4',
              platform: 'test-platform',
              base_packages: {},
            })
            + '__NEBULA_RUNTIME_ENV_END__\n',
        }, cellId);
        return { status: 'ok', executionCount: 0 };
      }
      executionStarted();
      await executionBlocked;
      await onOutput({ type: 'stdout', content: 'original output\n' }, cellId);
      return { status: 'ok', executionCount: 1 };
    });

    const submitted = await service.submit(requestFor(notebookPath), 'freeze-request');
    await started;
    writeNotebook(notebookPath, [codeCell('frozen-cell', 'CHANGED')]);
    releaseExecution();

    const completed = await waitForTerminal(service, submitted.seal_id);
    expect(completed.status).toBe('completed');
    expect(kernel.executions[1].code).toBe('ORIGINAL');
    const sealed = JSON.parse(await fsp.readFile(completed.manifest!.notebook.path, 'utf8'));
    expect(sealed.cells[0].source).toEqual(['ORIGINAL']);
  });

  it('stops in finally, records failure, and never executes later cells after an error output', async () => {
    writeNotebook(notebookPath, [
      codeCell('before', 'OK'),
      codeCell('broken', 'FAIL'),
      codeCell('after', 'NEVER'),
    ]);

    const submitted = await service.submit(requestFor(notebookPath), 'failing-request');
    const failed = await waitForTerminal(service, submitted.seal_id);

    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/deliberate failure/i);
    expect(failed.manifest).toBeUndefined();
    expect(kernel.executions.map((item) => item.cellId)).toEqual([null, 'before', 'broken']);
    expect(kernel.stops).toEqual(['fresh-session-1']);
    expect(fs.existsSync(path.join(
      testDir,
      '.nebula',
      'seals',
      submitted.seal_id,
      'manifest.json',
    ))).toBe(false);

    const events = await store.read(notebookPath);
    expect(events.map((event) => event.type)).toEqual([
      'seal.started',
      'seal.environment.probed',
      'seal.cell.completed',
      'seal.failed',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({ sealId: submitted.seal_id });
  });

  it('deduplicates submissions, rejects conflicting key reuse, and reloads completed status after restart', async () => {
    writeNotebook(notebookPath, [codeCell('only-cell', 'ONE')]);
    const request = requestFor(notebookPath);
    const first = await service.submit(request, 'restart-safe-key');
    const completed = await waitForTerminal(service, first.seal_id);
    expect(completed.status).toBe('completed');

    const repeated = await service.submit(request, 'restart-safe-key');
    expect(repeated).toEqual(completed);
    expect(kernel.executions).toHaveLength(2);

    await expect(service.submit(
      { ...request, task_id: 'different-task' },
      'restart-safe-key',
    )).rejects.toBeInstanceOf(ReplaySealConflictError);

    const restartedKernel = new FakeKernelService();
    const restartedService = new ReplaySealService({
      rootDirectory: testDir,
      kernelService: restartedKernel,
      provenanceStore: new ProvenanceStore({ durable: false }),
      durable: false,
    });
    expect(await restartedService.getStatus(first.seal_id)).toEqual(completed);
    expect(await restartedService.submit(request, 'restart-safe-key')).toEqual(completed);
    expect(restartedKernel.executions).toHaveLength(0);
  });

  it('persists interrupted status but refuses unsafe automatic code re-execution after restart', async () => {
    writeNotebook(notebookPath, [codeCell('side-effecting-cell', 'SIDE_EFFECT')]);
    let kernelStartObserved!: () => void;
    const kernelStart = new Promise<void>((resolve) => { kernelStartObserved = resolve; });
    vi.spyOn(kernel, 'startKernel').mockImplementation(async () => {
      kernelStartObserved();
      return new Promise<string>(() => undefined);
    });

    const submitted = await service.submit(requestFor(notebookPath), 'interrupted-replay');
    await kernelStart;

    const restartedKernel = new FakeKernelService();
    const restartedService = new ReplaySealService({
      rootDirectory: testDir,
      kernelService: restartedKernel,
      provenanceStore: new ProvenanceStore({ durable: false }),
      durable: false,
    });
    const interrupted = await restartedService.getStatus(submitted.seal_id);

    expect(interrupted).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/restarted.*automatic re-execution is refused/i),
    });
    expect(restartedKernel.starts).toHaveLength(0);
    expect(restartedKernel.executions).toHaveLength(0);
    expect((await store.read(notebookPath)).map((event) => event.type)).toEqual([
      'seal.started',
      'seal.failed',
    ]);
  });

  it('reports matching exploratory and replay output after nbformat text normalization', async () => {
    writeNotebook(notebookPath, [{
      id: 'stable-output',
      cell_type: 'code',
      source: ['MATCH'],
      metadata: {},
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['MATCH', '\n'] }],
      execution_count: 4,
    }]);

    const submitted = await service.submit(requestFor(notebookPath), 'matching-output');
    const completed = await waitForTerminal(service, submitted.seal_id);

    expect(completed.status).toBe('completed');
    expect(completed.manifest!.cells[0]).toMatchObject({
      outputs_match_exploratory: true,
      exploratory_execution_count: 4,
    });
    expect(completed.manifest!.cells[0].exploratory_outputs_sha256)
      .toBe(completed.manifest!.cells[0].replay_comparison_outputs_sha256);
  });

  it('fails closed on source TOCTOU, environment mismatch, and unsafe seal directories', async () => {
    writeNotebook(notebookPath, [codeCell('only-cell', 'ONE')]);
    const wrongSource = requestFor(notebookPath);
    wrongSource.source_notebook_sha256 = sha256Hex('different notebook');
    await expect(service.submit(wrongSource, 'wrong-source'))
      .rejects.toThrow(/source_notebook_sha256 mismatch/i);

    const environmentMismatch = requestFor(notebookPath);
    environmentMismatch.environment_manifest = {
      base: {
        inspection: 'complete',
        python_binary_target: '/a/different/python',
      },
    };
    const mismatch = await service.submit(environmentMismatch, 'environment-mismatch');
    expect((await waitForTerminal(service, mismatch.seal_id)).error)
      .toMatch(/environment mismatch.*python_binary_target/i);

    const unsafeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-unsafe-seal-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-seal-outside-'));
    try {
      const unsafeNotebook = path.join(unsafeRoot, 'analysis.ipynb');
      writeNotebook(unsafeNotebook, [codeCell('unsafe-cell', 'ONE')]);
      fs.symlinkSync(outside, path.join(unsafeRoot, '.nebula'));
      const unsafeService = new ReplaySealService({
        rootDirectory: unsafeRoot,
        kernelService: new FakeKernelService(),
        provenanceStore: new ProvenanceStore({ durable: false }),
        durable: false,
      });
      await expect(unsafeService.submit(requestFor(unsafeNotebook), 'unsafe-directory'))
        .rejects.toThrow(/unsafe directory/i);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.unlinkSync(path.join(unsafeRoot, '.nebula'));
      fs.rmSync(unsafeRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('verifies immutable files and the captured ledger prefix on every completed read', async () => {
    writeNotebook(notebookPath, [codeCell('verified-cell', 'ONE')]);
    const submitted = await service.submit(requestFor(notebookPath), 'verified-seal');
    const completed = await waitForTerminal(service, submitted.seal_id);
    expect(completed.status).toBe('completed');

    await store.append(notebookPath, {
      type: 'later.unrelated.event',
      actor: { kind: 'system' },
      payload: { later: true },
    });
    expect((await service.getStatus(submitted.seal_id))?.status).toBe('completed');

    fs.chmodSync(completed.manifest!.notebook.path, 0o600);
    fs.appendFileSync(completed.manifest!.notebook.path, 'tampered');
    const tampered = await service.getStatus(submitted.seal_id);
    expect(tampered).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/integrity verification failed.*notebook hash mismatch/i),
    });
  });

  it('rejects notebooks that cannot produce unambiguous KOSMOS cell provenance', async () => {
    writeNotebook(notebookPath, [
      { cell_type: 'code', source: ['print(1)'], metadata: {}, outputs: [], execution_count: null },
    ]);
    await expect(service.submit(requestFor(notebookPath), 'missing-id'))
      .rejects.toBeInstanceOf(ReplaySealValidationError);

    writeNotebook(notebookPath, [codeCell('duplicate', 'A'), codeCell('duplicate', 'B')]);
    await expect(service.submit(requestFor(notebookPath), 'duplicate-id'))
      .rejects.toThrow(/duplicate/i);

    writeNotebook(notebookPath, [
      { id: 'only-markdown', cell_type: 'markdown', source: ['# no code'], metadata: {} },
    ]);
    await expect(service.submit(requestFor(notebookPath), 'no-code'))
      .rejects.toThrow(/at least one code cell/i);
  });

  it('rejects invalid package directories and preflights artifact descriptors before execution', async () => {
    writeNotebook(notebookPath, [codeCell('only-cell', 'ONE')]);
    const invalidPackageRequest = requestFor(notebookPath);
    invalidPackageRequest.environment_manifest = {
      task_local: { package_directory: path.join(testDir, 'missing-packages') },
    };
    await expect(service.submit(invalidPackageRequest, 'invalid-packages'))
      .rejects.toThrow(/package_directory.*directory/i);

    const outsidePackageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-packages-'));
    try {
      const outsidePackageRequest = requestFor(notebookPath);
      outsidePackageRequest.environment_manifest = {
        task_local: { package_directory: outsidePackageDirectory },
      };
      await expect(service.submit(outsidePackageRequest, 'outside-packages'))
        .rejects.toThrow(/inside.*workspace/i);
    } finally {
      fs.rmSync(outsidePackageDirectory, { recursive: true, force: true });
    }

    const missingArtifactRequest = {
      ...requestFor(notebookPath),
      artifacts: [{
        path: path.join(testDir, 'missing.csv'),
        sha256: sha256Hex('missing'),
        size_bytes: 7,
      }],
    };
    await expect(service.submit(missingArtifactRequest, 'missing-artifact'))
      .rejects.toThrow(/artifact.*missing/i);

    const targetPath = path.join(testDir, 'target.csv');
    const symlinkPath = path.join(testDir, 'linked.csv');
    fs.writeFileSync(targetPath, 'data');
    fs.symlinkSync(targetPath, symlinkPath);
    const symlinkArtifactRequest = {
      ...requestFor(notebookPath),
      artifacts: [{
        path: symlinkPath,
        sha256: sha256Hex('data'),
        size_bytes: 4,
      }],
    };
    await expect(service.submit(symlinkArtifactRequest, 'symlink-artifact'))
      .rejects.toThrow(/symbolic link/i);

    const mismatchedPath = path.join(testDir, 'mismatched.csv');
    fs.writeFileSync(mismatchedPath, 'actual');
    await expect(service.submit({
      ...requestFor(notebookPath),
      artifacts: [{
        path: mismatchedPath,
        sha256: sha256Hex('claimed'),
        size_bytes: 6,
      }],
    }, 'mismatched-artifact')).rejects.toThrow(/artifact.*sha256 mismatch/i);
    expect(kernel.starts).toHaveLength(0);
  });

  it('fails the seal if replay changes an artifact away from its predeclared hash', async () => {
    writeNotebook(notebookPath, [codeCell('produces-artifact', 'REPLAY')]);
    const artifactPath = path.join(testDir, 'result.txt');
    fs.writeFileSync(artifactPath, 'before');
    const descriptor = artifactDescriptor(artifactPath);
    let releaseExecution!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseExecution = resolve; });
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => { executionStarted = resolve; });
    kernel.execute.mockImplementation(async (
      _sessionId: string,
      code: string,
      onOutput: (output: KernelOutput, cellId?: string | null) => Promise<void>,
      _onQueueInfo?: (info: ExecutionQueueInfo) => void,
      cellId?: string | null,
    ) => {
      if (code.includes('__NEBULA_RUNTIME_ENV_BEGIN__')) {
        await onOutput({
          type: 'stdout',
          content: '__NEBULA_RUNTIME_ENV_BEGIN__'
            + JSON.stringify({
              executable: '/rich/bin/python',
              executable_realpath: '/rich/bin/python',
              implementation: 'CPython',
              version: '3.12.4',
              platform: 'test-platform',
              base_packages: {},
            })
            + '__NEBULA_RUNTIME_ENV_END__\n',
        }, cellId);
        return { status: 'ok', executionCount: 0 };
      }
      executionStarted();
      await blocked;
      await onOutput({ type: 'stdout', content: 'done\n' }, cellId);
      return { status: 'ok', executionCount: 1 };
    });

    const submitted = await service.submit({
      ...requestFor(notebookPath),
      artifacts: [descriptor],
    }, 'mutated-artifact');
    await started;
    fs.writeFileSync(artifactPath, 'after!');
    releaseExecution();

    const failed = await waitForTerminal(service, submitted.seal_id);
    expect(failed).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/artifact.*sha256 mismatch/i),
    });
  });
});

describe('normalizeNotebookOutputsForComparison', () => {
  it('equates nbformat string-list text encodings while preserving non-text arrays', () => {
    const stringEncoded = [{
      output_type: 'display_data',
      data: {
        'text/plain': 'alpha\nbeta',
        'application/javascript': 'one();two();',
        'image/svg+xml': '<svg></svg>',
        'image/png': ['binary', 'chunks'],
      },
      metadata: {},
    }, { output_type: 'stream', name: 'stdout', text: 'hello\n' }];
    const listEncoded = [{
      output_type: 'display_data',
      data: {
        'text/plain': ['alpha\n', 'beta'],
        'application/javascript': ['one();', 'two();'],
        'image/svg+xml': ['<svg>', '</svg>'],
        'image/png': ['binary', 'chunks'],
      },
      metadata: {},
    }, { output_type: 'stream', name: 'stdout', text: ['hello', '\n'] }];

    expect(sha256Canonical(normalizeNotebookOutputsForComparison(stringEncoded)))
      .toBe(sha256Canonical(normalizeNotebookOutputsForComparison(listEncoded)));
    expect(normalizeNotebookOutputsForComparison(listEncoded)[0]).toMatchObject({
      data: { 'image/png': ['binary', 'chunks'] },
    });
    expect(sha256Canonical(normalizeNotebookOutputsForComparison(listEncoded)))
      .not.toBe(sha256Canonical(normalizeNotebookOutputsForComparison([
        { ...listEncoded[0], data: { ...listEncoded[0].data, 'text/plain': ['different'] } },
        listEncoded[1],
      ])));
  });
});
