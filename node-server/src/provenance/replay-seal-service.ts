import { createHash, randomUUID } from 'crypto';
import {
  constants as fsConstants,
  lstatSync,
  realpathSync,
  type Stats,
} from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type {
  ExecutionQueueInfo,
  ExecutionResult,
  InternalExecutionOptions,
  KernelOutput,
  StartKernelOptions,
} from '../kernel/types';
import {
  CANONICAL_HASH_PROFILE,
  canonicalJson,
  hashCanonicalJson,
  sha256Canonical,
  sha256Hex,
  type CanonicalJsonValue,
} from './canonical-json';
import { ProvenanceStore } from './provenance-store';
import type { ProvenanceActor, ProvenanceEventInput } from './types';

const SHA256_RE = /^[a-f0-9]{64}$/;
const CELL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEAL_ID_RE = /^seal-[a-f0-9]{32}$/;
const PROBE_BEGIN = '__NEBULA_RUNTIME_ENV_BEGIN__';
const PROBE_END = '__NEBULA_RUNTIME_ENV_END__';
const OUTPUT_LIMIT_MARKER = 'Output limit reached';

export type ReplaySealState = 'pending' | 'running' | 'completed' | 'failed';

export interface ReplaySealArtifactRequest {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface ReplaySealRequest {
  notebook_path: string;
  run_id: string;
  task_id: string;
  source_id: string;
  source_notebook_sha256: string;
  artifacts: ReplaySealArtifactRequest[];
  kernel_name?: string;
  input_manifest: Record<string, CanonicalJsonValue>;
  environment_manifest: Record<string, CanonicalJsonValue>;
}

export interface SealCellManifest {
  cell_id: string;
  source_sha256: string;
  exploratory_outputs_sha256: string;
  outputs_sha256: string;
  replay_comparison_outputs_sha256: string;
  outputs_match_exploratory: boolean;
  exploratory_execution_count: number | null;
  execution_id: string;
  execution_count: number;
  status: 'completed';
}

export interface SealArtifactManifest {
  source_path: string;
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface RuntimeEnvironment {
  schema_version: 1;
  python: {
    executable: string;
    executable_realpath: string;
    implementation: string;
    version: string;
    platform: string;
  };
  python_no_user_site: true;
  base_packages: Record<string, string>;
  base_packages_sha256: string;
  task_local: {
    package_directory: string;
    packages: Record<string, string>;
    packages_sha256: string;
  } | null;
}

export interface ReplaySealManifest {
  schema_version: 1;
  hash_profile: typeof CANONICAL_HASH_PROFILE;
  seal_id: string;
  source_notebook: { path: string; sha256: string };
  notebook: { path: string; sha256: string };
  input_manifest_sha256: string;
  environment_manifest_sha256: string;
  runtime_environment: RuntimeEnvironment;
  runtime_environment_sha256: string;
  event_chain_head_sha256: string;
  event_ledger: {
    path: string;
    prefix_size_bytes: number;
    prefix_sha256: string;
    head_sha256: string;
    head_seq: number;
  };
  cells: SealCellManifest[];
  artifacts: SealArtifactManifest[];
  isolation: {
    fresh_kernel: true;
    network_isolated: false;
    filesystem_isolated: false;
  };
  bootstrap?: {
    package_directory: string;
    source_sha256: string;
    outputs_sha256: string;
    execution_id: string;
    execution_count: number;
    status: 'completed';
  };
  manifest_sha256: string;
}

export type ReplaySealStatusResponse =
  | { seal_id: string; status: 'pending' | 'running' }
  | { seal_id: string; status: 'completed'; manifest: ReplaySealManifest }
  | { seal_id: string; status: 'failed'; error: string };

export interface ReplayKernelService {
  startKernel(options?: StartKernelOptions): Promise<string>;
  executeCode(
    sessionId: string,
    code: string,
    onOutput: (output: KernelOutput, cellId?: string | null) => Promise<void>,
    onQueueInfo?: (info: ExecutionQueueInfo) => void,
    cellId?: string | null,
    internalOptions?: InternalExecutionOptions,
  ): Promise<ExecutionResult>;
  stopKernel(sessionId: string): Promise<boolean>;
}

export interface ReplaySealServiceOptions {
  rootDirectory: string;
  kernelService: ReplayKernelService;
  provenanceStore?: ProvenanceStore;
  durable?: boolean;
  idFactory?: () => string;
  clock?: () => Date;
}

interface JupyterCell extends Record<string, unknown> {
  id?: unknown;
  cell_type?: unknown;
  source?: unknown;
  metadata?: unknown;
  outputs?: unknown;
  execution_count?: unknown;
}

interface JupyterNotebook extends Record<string, unknown> {
  cells: JupyterCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

interface FrozenCodeCell {
  index: number;
  id: string;
  source: string;
  exploratoryOutputsSha256: string;
  exploratoryExecutionCount: number | null;
}

interface FrozenNotebook {
  notebook: JupyterNotebook;
  codeCells: FrozenCodeCell[];
  kernelName: string;
}

interface StoredSealJob {
  schemaVersion: 1;
  sealId: string;
  status: ReplaySealState;
  requestFingerprint: string;
  request: ReplaySealRequest;
  sourceNotebookSha256: string;
  frozenNotebookPath: string;
  sealDirectory: string;
  processInstanceId: string;
  createdAt: string;
  updatedAt: string;
  manifest?: ReplaySealManifest;
  error?: string;
}

interface ExecutedCell {
  index: number;
  manifest: SealCellManifest;
  outputs: CanonicalJsonValue[];
}

interface ExecutionRecord {
  executionId: string;
  executionCount: number;
  sourceSha256: string;
  outputsSha256: string;
  comparisonOutputsSha256: string;
  outputs: CanonicalJsonValue[];
}

export class ReplaySealValidationError extends Error {
  readonly code = 'REPLAY_SEAL_VALIDATION_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'ReplaySealValidationError';
  }
}

export class ReplaySealConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor() {
    super('Idempotency-Key was already used with a different replay-seal request');
    this.name = 'ReplaySealConflictError';
  }
}

/**
 * Normalize only nbformat's equivalent text encodings for replay comparison.
 *
 * - stream.text: an array of strings is joined, a string is unchanged;
 * - data values for text/*, application/javascript, and image/svg+xml use the
 *   same array-to-string join;
 * - every other JSON value, including binary MIME arrays and traceback, is
 *   preserved exactly.
 *
 * This is intentionally separate from outputs_sha256, which hashes the exact
 * output JSON written to the immutable executed notebook.
 */
export function normalizeNotebookOutputsForComparison(value: unknown): CanonicalJsonValue[] {
  if (!Array.isArray(value)) {
    throw new ReplaySealValidationError('Notebook outputs must be an array');
  }
  const cloned = JSON.parse(canonicalJson(value)) as CanonicalJsonValue[];
  for (const rawOutput of cloned) {
    if (!rawOutput || typeof rawOutput !== 'object' || Array.isArray(rawOutput)) continue;
    const output = rawOutput as Record<string, CanonicalJsonValue>;
    if (output.output_type === 'stream' && 'text' in output) {
      output.text = joinTextArray(output.text, 'stream.text');
    }
    const data = output.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [mimeType, mimeValue] of Object.entries(data)) {
        if (
          mimeType.startsWith('text/')
          || mimeType === 'application/javascript'
          || mimeType === 'image/svg+xml'
        ) {
          data[mimeType] = joinTextArray(mimeValue, `data.${mimeType}`);
        }
      }
    }
  }
  return cloned;
}

function joinTextArray(value: CanonicalJsonValue, field: string): CanonicalJsonValue {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join('');
  }
  throw new ReplaySealValidationError(`${field} must be a string or an array of strings`);
}

/**
 * Fresh-kernel, top-to-bottom replay and immutable evidence sealing.
 *
 * The service deliberately makes no network/filesystem-isolation claim. A
 * dedicated kernel prevents state inheritance from an exploratory session;
 * the immutable copies, hashes, and server-authored event prefix bind what ran.
 */
export class ReplaySealService {
  private static readonly queues = new Map<string, Promise<void>>();

  private readonly rootDirectory: string;
  private readonly registryDirectory: string;
  private readonly kernelService: ReplayKernelService;
  private readonly provenanceStore: ProvenanceStore;
  private readonly durable: boolean;
  private readonly idFactory: () => string;
  private readonly clock: () => Date;
  private readonly processInstanceId = randomUUID();
  private readonly activeJobs = new Map<string, Promise<void>>();
  private readonly attemptedJobs = new Set<string>();

  constructor(options: ReplaySealServiceOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('ReplaySealService options are required');
    }
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.registryDirectory = path.join(this.rootDirectory, '.nebula', 'replay-seal-jobs');
    this.kernelService = options.kernelService;
    this.provenanceStore = options.provenanceStore ?? new ProvenanceStore();
    this.durable = options.durable !== false;
    this.idFactory = options.idFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
  }

  async submit(rawRequest: ReplaySealRequest, idempotencyKey: string): Promise<ReplaySealStatusResponse> {
    const request = this.normalizeRequest(rawRequest);
    this.validateIdempotencyKey(idempotencyKey);
    await this.ensureRegistryDirectory();
    const sealId = `seal-${sha256Hex(idempotencyKey).slice(0, 32)}`;
    const requestFingerprint = sha256Canonical(request);
    const registryPath = this.registryPath(sealId);

    const job = await this.runSerialized(`seal:${registryPath}`, async () => {
      const existing = await this.readJob(registryPath);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new ReplaySealConflictError();
        }
        return existing;
      }

      const sourceBytes = await this.readNotebookSource(request.notebook_path);
      const sourceSha256 = sha256Hex(sourceBytes);
      if (sourceSha256 !== request.source_notebook_sha256) {
        throw new ReplaySealValidationError(
          `source_notebook_sha256 mismatch: expected ${request.source_notebook_sha256}, got ${sourceSha256}`,
        );
      }
      const frozen = this.parseFrozenNotebook(sourceBytes, request.kernel_name);
      this.validateEnvironmentDeclaration(request.environment_manifest, path.dirname(request.notebook_path));
      await this.preflightArtifacts(request);

      const sealDirectory = await this.createSafeSealDirectory(
        path.dirname(request.notebook_path),
        sealId,
      );
      const frozenNotebookPath = path.join(sealDirectory, 'source.ipynb');
      await this.writeImmutable(frozenNotebookPath, sourceBytes);

      const now = this.clock().toISOString();
      const created: StoredSealJob = {
        schemaVersion: 1,
        sealId,
        status: 'pending',
        requestFingerprint,
        request,
        sourceNotebookSha256: sourceSha256,
        frozenNotebookPath,
        sealDirectory,
        processInstanceId: this.processInstanceId,
        createdAt: now,
        updatedAt: now,
      };
      await this.persistJob(created);
      return created;
    });

    if (job.status === 'pending' || job.status === 'running') {
      if (job.processInstanceId !== this.processInstanceId) {
        await this.failJob(
          job,
          new Error('Nebula restarted during replay; automatic re-execution is refused because notebook code may have external side effects'),
        );
        const interrupted = await this.readJob(registryPath);
        if (!interrupted) throw new Error(`Interrupted replay job disappeared: ${sealId}`);
        return this.verifiedResponseFor(interrupted);
      }
      this.ensureRunning(job);
    }
    return this.verifiedResponseFor(job);
  }

  async getStatus(sealId: string): Promise<ReplaySealStatusResponse | null> {
    if (!SEAL_ID_RE.test(sealId)) return null;
    await this.ensureRegistryDirectory();
    const job = await this.readJob(this.registryPath(sealId));
    if (!job) return null;
    if (job.status === 'pending' || job.status === 'running') {
      if (job.processInstanceId !== this.processInstanceId) {
        await this.failJob(
          job,
          new Error('Nebula restarted during replay; automatic re-execution is refused because notebook code may have external side effects'),
        );
        const interrupted = await this.readJob(this.registryPath(sealId));
        return interrupted ? this.responseFor(interrupted) : null;
      }
      this.ensureRunning(job);
    }
    return this.verifiedResponseFor(job);
  }

  private ensureRunning(job: StoredSealJob): void {
    if (this.activeJobs.has(job.sealId) || this.attemptedJobs.has(job.sealId)) return;
    this.attemptedJobs.add(job.sealId);
    const run = this.runJob(job).catch(async (error) => {
      await this.failJob(job, error).catch(() => undefined);
    }).finally(() => {
      if (this.activeJobs.get(job.sealId) === run) this.activeJobs.delete(job.sealId);
    });
    this.activeJobs.set(job.sealId, run);
  }

  private async runJob(initialJob: StoredSealJob): Promise<void> {
    let job = await this.updateJob(initialJob, { status: 'running', error: undefined });
    const request = job.request;
    const actor: ProvenanceActor = { kind: 'agent', id: request.source_id, name: 'kosmos' };
    const inputManifestSha256 = sha256Canonical(request.input_manifest);
    const environmentManifestSha256 = sha256Canonical(request.environment_manifest);
    await this.provenanceStore.putBlob(
      request.notebook_path,
      hashCanonicalJson(request.input_manifest),
    );
    await this.provenanceStore.putBlob(
      request.notebook_path,
      hashCanonicalJson(request.environment_manifest),
    );

    const frozenBytes = await fsp.readFile(job.frozenNotebookPath);
    if (sha256Hex(frozenBytes) !== job.sourceNotebookSha256) {
      throw new Error('Frozen source notebook failed hash verification');
    }
    const frozen = this.parseFrozenNotebook(frozenBytes, request.kernel_name);
    const commonEvent = {
      actor,
      runId: request.run_id,
      taskId: request.task_id,
      sourceId: request.source_id,
      inputManifestSha256,
      environmentManifestSha256,
    } as const;
    await this.provenanceStore.append(request.notebook_path, {
      ...commonEvent,
      type: 'seal.started',
      idempotencyKey: this.sealRequestEventKey(job.sealId),
      payload: {
        schemaVersion: 1,
        sealId: job.sealId,
        sourceNotebook: {
          path: request.notebook_path,
          sha256: job.sourceNotebookSha256,
        },
        kernelName: frozen.kernelName,
        artifacts: request.artifacts.map((artifact) => ({
          path: artifact.path,
          sha256: artifact.sha256,
          sizeBytes: artifact.size_bytes,
        })),
        isolation: {
          freshKernel: true,
          networkIsolated: false,
          filesystemIsolated: false,
        },
      },
    });

    let sessionId: string | undefined;
    let executionError: unknown;
    let stopError: unknown;
    let runtimeEnvironment: RuntimeEnvironment | undefined;
    let bootstrapManifest: ReplaySealManifest['bootstrap'];
    const executedCells: ExecutedCell[] = [];
    try {
      sessionId = await this.kernelService.startKernel({
        kernelName: frozen.kernelName,
        cwd: path.dirname(request.notebook_path),
        internalEnv: { PYTHONNOUSERSITE: '1' },
      });

      const baseProbe = await this.executeServerCode(
        sessionId,
        this.baseEnvironmentProbeSource(),
      );
      const probed = this.parseBaseEnvironmentProbe(baseProbe.rawStdout);
      this.compareBaseEnvironment(probed, request.environment_manifest);
      await this.appendExecutionEvent(request.notebook_path, commonEvent, {
        type: 'seal.environment.probed',
        executionId: baseProbe.executionId,
        payload: {
          schemaVersion: 1,
          sourceSha256: baseProbe.sourceSha256,
          outputsSha256: baseProbe.outputsSha256,
          executionCount: baseProbe.executionCount,
          basePackagesSha256: probed.base_packages_sha256,
          executableRealpath: probed.python.executable_realpath,
          pythonNoUserSite: true,
          status: 'completed',
        },
      });

      const taskLocal = this.taskLocalDeclaration(
        request.environment_manifest,
        path.dirname(request.notebook_path),
      );
      let actualTaskLocal: RuntimeEnvironment['task_local'] = null;
      if (taskLocal) {
        const bootstrap = await this.executeServerCode(
          sessionId,
          this.taskLocalBootstrapSource(
            taskLocal.packageDirectory,
            taskLocal.canonicalPackageDirectory,
          ),
        );
        const packages = this.parseTaskLocalProbe(bootstrap.rawStdout);
        const packagesSha256 = sha256Canonical(packages);
        this.compareTaskLocalEnvironment(packages, packagesSha256, taskLocal.declaration);
        actualTaskLocal = {
          package_directory: taskLocal.packageDirectory,
          packages,
          packages_sha256: packagesSha256,
        };
        bootstrapManifest = {
          package_directory: taskLocal.packageDirectory,
          source_sha256: bootstrap.sourceSha256,
          outputs_sha256: bootstrap.outputsSha256,
          execution_id: bootstrap.executionId,
          execution_count: bootstrap.executionCount,
          status: 'completed',
        };
        await this.appendExecutionEvent(request.notebook_path, commonEvent, {
          type: 'seal.bootstrap.completed',
          executionId: bootstrap.executionId,
          payload: {
            schemaVersion: 1,
            packageDirectory: taskLocal.packageDirectory,
            packagesSha256,
            sourceSha256: bootstrap.sourceSha256,
            outputsSha256: bootstrap.outputsSha256,
            executionCount: bootstrap.executionCount,
            status: 'completed',
          },
        });
      }
      runtimeEnvironment = { ...probed, task_local: actualTaskLocal };

      for (const cell of frozen.codeCells) {
        const execution = await this.executeNotebookCell(sessionId, cell);
        const manifest: SealCellManifest = {
          cell_id: cell.id,
          source_sha256: execution.sourceSha256,
          exploratory_outputs_sha256: cell.exploratoryOutputsSha256,
          outputs_sha256: execution.outputsSha256,
          replay_comparison_outputs_sha256: execution.comparisonOutputsSha256,
          outputs_match_exploratory: cell.exploratoryOutputsSha256 === execution.comparisonOutputsSha256,
          exploratory_execution_count: cell.exploratoryExecutionCount,
          execution_id: execution.executionId,
          execution_count: execution.executionCount,
          status: 'completed',
        };
        executedCells.push({ index: cell.index, manifest, outputs: execution.outputs });
        await this.appendExecutionEvent(request.notebook_path, commonEvent, {
          type: 'seal.cell.completed',
          executionId: execution.executionId,
          payload: {
            schemaVersion: 1,
            sealId: job.sealId,
            cellId: cell.id,
            sourceSha256: execution.sourceSha256,
            exploratoryOutputsSha256: cell.exploratoryOutputsSha256,
            outputsSha256: execution.outputsSha256,
            replayComparisonOutputsSha256: execution.comparisonOutputsSha256,
            outputsMatchExploratory: cell.exploratoryOutputsSha256 === execution.comparisonOutputsSha256,
            exploratoryExecutionCount: cell.exploratoryExecutionCount,
            executionCount: execution.executionCount,
            status: 'completed',
          },
        });
      }
    } catch (error) {
      executionError = error;
    } finally {
      if (sessionId !== undefined) {
        try {
          const stopped = await this.kernelService.stopKernel(sessionId);
          if (!stopped) stopError = new Error('Fresh replay kernel could not be stopped');
        } catch (error) {
          stopError = error;
        }
      }
    }
    if (executionError) throw executionError;
    if (stopError) throw stopError;
    if (!runtimeEnvironment) throw new Error('Fresh kernel produced no environment attestation');

    const sealedNotebook = this.buildSealedNotebook(frozen.notebook, executedCells);
    const sealedBytes = Buffer.from(`${canonicalJson(sealedNotebook)}\n`, 'utf8');
    const sealedNotebookPath = path.join(job.sealDirectory, 'notebook.ipynb');
    await this.writeImmutable(sealedNotebookPath, sealedBytes);
    const notebookSha256 = sha256Hex(sealedBytes);
    const artifacts = await this.sealArtifacts(
      request,
      job.sealDirectory,
      sealedNotebookPath,
      notebookSha256,
      sealedBytes.length,
    );
    const runtimeEnvironmentSha256 = sha256Canonical(runtimeEnvironment);
    await this.provenanceStore.putBlob(
      request.notebook_path,
      hashCanonicalJson(runtimeEnvironment),
    );

    const completion = await this.provenanceStore.append(request.notebook_path, {
      ...commonEvent,
      type: 'seal.completed',
      payload: {
        schemaVersion: 1,
        hashProfile: CANONICAL_HASH_PROFILE,
        sealId: job.sealId,
        sourceNotebook: {
          path: request.notebook_path,
          sha256: job.sourceNotebookSha256,
        },
        notebook: { path: sealedNotebookPath, sha256: notebookSha256 },
        inputManifestSha256,
        environmentManifestSha256,
        runtimeEnvironmentSha256,
        cells: executedCells.map(({ manifest }) => ({
          cellId: manifest.cell_id,
          sourceSha256: manifest.source_sha256,
          exploratoryOutputsSha256: manifest.exploratory_outputs_sha256,
          outputsSha256: manifest.outputs_sha256,
          replayComparisonOutputsSha256: manifest.replay_comparison_outputs_sha256,
          outputsMatchExploratory: manifest.outputs_match_exploratory,
          exploratoryExecutionCount: manifest.exploratory_execution_count,
          executionId: manifest.execution_id,
          executionCount: manifest.execution_count,
          status: manifest.status,
        })),
        artifacts: artifacts.map((artifact) => ({
          sourcePath: artifact.source_path,
          path: artifact.path,
          sha256: artifact.sha256,
          sizeBytes: artifact.size_bytes,
        })),
        isolation: {
          freshKernel: true,
          networkIsolated: false,
          filesystemIsolated: false,
        },
      },
    });
    const eventLedger = await this.captureLedgerPrefix(
      request.notebook_path,
      completion.event.eventHash,
      completion.event.seq,
    );
    const unsignedManifest: Omit<ReplaySealManifest, 'manifest_sha256'> = {
      schema_version: 1,
      hash_profile: CANONICAL_HASH_PROFILE,
      seal_id: job.sealId,
      source_notebook: {
        path: request.notebook_path,
        sha256: job.sourceNotebookSha256,
      },
      notebook: { path: sealedNotebookPath, sha256: notebookSha256 },
      input_manifest_sha256: inputManifestSha256,
      environment_manifest_sha256: environmentManifestSha256,
      runtime_environment: runtimeEnvironment,
      runtime_environment_sha256: runtimeEnvironmentSha256,
      event_chain_head_sha256: completion.event.eventHash,
      event_ledger: eventLedger,
      cells: executedCells.map(({ manifest }) => manifest),
      artifacts,
      isolation: {
        fresh_kernel: true,
        network_isolated: false,
        filesystem_isolated: false,
      },
      ...(bootstrapManifest ? { bootstrap: bootstrapManifest } : {}),
    };
    const manifest: ReplaySealManifest = {
      ...unsignedManifest,
      manifest_sha256: sha256Canonical(unsignedManifest),
    };
    await this.writeImmutable(
      path.join(job.sealDirectory, 'manifest.json'),
      Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8'),
    );
    job = await this.updateJob(job, { status: 'completed', manifest, error: undefined });
    await this.hardenSealDirectory(job.sealDirectory);
  }

  private async failJob(job: StoredSealJob, error: unknown): Promise<void> {
    const message = this.errorMessage(error);
    const request = job.request;
    const common = {
      actor: { kind: 'agent', id: request.source_id, name: 'kosmos' },
      runId: request.run_id,
      taskId: request.task_id,
      sourceId: request.source_id,
      inputManifestSha256: sha256Canonical(request.input_manifest),
      environmentManifestSha256: sha256Canonical(request.environment_manifest),
    } as const;
    await this.provenanceStore.append(request.notebook_path, {
      ...common,
      type: 'seal.failed',
      payload: {
        schemaVersion: 1,
        hashProfile: CANONICAL_HASH_PROFILE,
        sealId: job.sealId,
        error: message,
      },
    }).catch(() => undefined);
    await this.updateJob(job, { status: 'failed', error: message, manifest: undefined });
  }

  private async executeNotebookCell(
    sessionId: string,
    cell: FrozenCodeCell,
  ): Promise<ExecutionRecord> {
    return this.executeAndCapture(sessionId, cell.source, cell.id);
  }

  private async executeServerCode(sessionId: string, source: string): Promise<ExecutionRecord & { rawStdout: string }> {
    return this.executeAndCapture(sessionId, source, null, { storeHistory: false });
  }

  private async executeAndCapture(
    sessionId: string,
    source: string,
    cellId: string | null,
    internalOptions?: InternalExecutionOptions,
  ): Promise<ExecutionRecord & { rawStdout: string }> {
    const executionId = this.idFactory();
    const kernelOutputs: KernelOutput[] = [];
    const result = await this.kernelService.executeCode(
      sessionId,
      source,
      async (output) => { kernelOutputs.push(this.cloneJson(output) as unknown as KernelOutput); },
      undefined,
      cellId,
      internalOptions,
    );
    const errorOutput = kernelOutputs.find((output) => output.type === 'error');
    if (result.status !== 'ok' || errorOutput) {
      throw new Error(result.error || errorOutput?.content || `Execution failed for ${cellId ?? 'server bootstrap'}`);
    }
    if (!Number.isSafeInteger(result.executionCount) || (result.executionCount ?? -1) < 0) {
      throw new Error(`Kernel returned no valid execution count for ${cellId ?? 'server bootstrap'}`);
    }
    if (kernelOutputs.some((output) => output.content.includes(OUTPUT_LIMIT_MARKER))) {
      throw new Error(`Kernel output was truncated for ${cellId ?? 'server bootstrap'}`);
    }
    const outputs = kernelOutputs.map((output) => this.toJupyterOutput(output));
    return {
      executionId,
      executionCount: result.executionCount!,
      sourceSha256: sha256Hex(source),
      outputsSha256: sha256Canonical(outputs),
      comparisonOutputsSha256: sha256Canonical(normalizeNotebookOutputsForComparison(outputs)),
      outputs,
      rawStdout: kernelOutputs
        .filter((output) => output.type === 'stdout')
        .map((output) => output.content)
        .join(''),
    };
  }

  private async appendExecutionEvent(
    notebookPath: string,
    common: Omit<ProvenanceEventInput, 'type' | 'payload' | 'executionId'>,
    details: Pick<ProvenanceEventInput, 'type' | 'payload' | 'executionId'>,
  ): Promise<void> {
    await this.provenanceStore.append(notebookPath, { ...common, ...details });
  }

  private buildSealedNotebook(notebook: JupyterNotebook, executed: ExecutedCell[]): JupyterNotebook {
    const sealed = this.cloneJson(notebook) as unknown as JupyterNotebook;
    for (const item of executed) {
      const cell = sealed.cells[item.index];
      cell.outputs = item.outputs;
      cell.execution_count = item.manifest.execution_count;
    }
    return sealed;
  }

  private async preflightArtifacts(request: ReplaySealRequest): Promise<void> {
    const workspace = path.dirname(request.notebook_path);
    for (const descriptor of request.artifacts) {
      try {
        await this.assertNoSymlinkComponents(workspace, descriptor.path);
        const actual = await this.hashRegularFile(descriptor.path);
        if (actual.size_bytes !== descriptor.size_bytes) {
          throw new ReplaySealValidationError(
            `Requested artifact size mismatch: ${descriptor.path}; expected ${descriptor.size_bytes}, got ${actual.size_bytes}`,
          );
        }
        if (actual.sha256 !== descriptor.sha256) {
          throw new ReplaySealValidationError(
            `Requested artifact sha256 mismatch: ${descriptor.path}; expected ${descriptor.sha256}, got ${actual.sha256}`,
          );
        }
      } catch (error) {
        if (error instanceof ReplaySealValidationError) throw error;
        throw new ReplaySealValidationError(this.errorMessage(error));
      }
    }
  }

  private async sealArtifacts(
    request: ReplaySealRequest,
    sealDirectory: string,
    sealedNotebookPath: string,
    notebookSha256: string,
    notebookSize: number,
  ): Promise<SealArtifactManifest[]> {
    const artifacts: SealArtifactManifest[] = [{
      source_path: request.notebook_path,
      path: sealedNotebookPath,
      sha256: notebookSha256,
      size_bytes: notebookSize,
    }];
    const workspace = path.dirname(request.notebook_path);
    for (const descriptor of request.artifacts) {
      const sourcePath = descriptor.path;
      const relative = this.relativeInside(workspace, sourcePath, 'artifact path');
      if (relative.split(path.sep)[0] === '.nebula') {
        throw new Error(`Requested artifact must not be inside .nebula: ${sourcePath}`);
      }
      await this.assertNoSymlinkComponents(workspace, sourcePath);
      const components = relative.split(path.sep);
      const filename = components.pop();
      if (!filename) throw new Error(`Requested artifact has no filename: ${sourcePath}`);
      const destinationDirectory = await this.ensureSafeDirectoryChain(
        sealDirectory,
        ['artifacts', ...components],
      );
      const destination = path.join(destinationDirectory, filename);
      const copied = await this.copyRegularFileImmutable(sourcePath, destination, descriptor);
      artifacts.push({ source_path: sourcePath, path: destination, ...copied });
    }
    return artifacts;
  }

  private async copyRegularFileImmutable(
    sourcePath: string,
    destination: string,
    expected: ReplaySealArtifactRequest,
  ): Promise<{ sha256: string; size_bytes: number }> {
    let source: fsp.FileHandle;
    try {
      source = await fsp.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (this.isNodeError(error, 'ENOENT')) throw new Error(`Requested artifact is missing: ${sourcePath}`);
      if (this.isNodeError(error, 'ELOOP')) throw new Error(`Requested artifact is a symbolic link: ${sourcePath}`);
      throw error;
    }
    const directory = path.dirname(destination);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    let destinationHandle: fsp.FileHandle | undefined;
    try {
      const before = await source.stat();
      if (!before.isFile()) throw new Error(`Requested artifact is not a regular file: ${sourcePath}`);
      destinationHandle = await fsp.open(temporary, 'wx', 0o400);
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let sizeBytes = 0;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await destinationHandle.write(chunk);
        sizeBytes += bytesRead;
      }
      if (this.durable) await destinationHandle.sync();
      const after = await source.stat();
      if (
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || after.size !== sizeBytes
      ) {
        throw new Error(`Requested artifact changed while it was sealed: ${sourcePath}`);
      }
      const sha256 = hash.digest('hex');
      if (sizeBytes !== expected.size_bytes) {
        throw new Error(
          `Requested artifact size mismatch after replay: ${sourcePath}; expected ${expected.size_bytes}, got ${sizeBytes}`,
        );
      }
      if (sha256 !== expected.sha256) {
        throw new Error(
          `Requested artifact sha256 mismatch after replay: ${sourcePath}; expected ${expected.sha256}, got ${sha256}`,
        );
      }
      await destinationHandle.close();
      destinationHandle = undefined;
      try {
        await fsp.link(temporary, destination);
      } catch (error) {
        if (this.isNodeError(error, 'EEXIST')) {
          throw new Error(`Immutable artifact destination already exists: ${destination}`);
        }
        throw error;
      }
      await fsp.chmod(destination, 0o400);
      if (this.durable) await this.syncDirectory(directory);
      return { sha256, size_bytes: sizeBytes };
    } finally {
      await source.close().catch(() => undefined);
      await destinationHandle?.close().catch(() => undefined);
      await fsp.unlink(temporary).catch(() => undefined);
    }
  }

  private baseEnvironmentProbeSource(): string {
    return [
      'def __nebula_server_environment_probe__():',
      '    import importlib.metadata as metadata',
      '    import json',
      '    import os',
      '    import platform',
      '    import sys',
      '    packages = {}',
      '    for distribution in metadata.distributions():',
      '        name = distribution.metadata.get("Name")',
      '        if name:',
      '            packages[str(name).lower()] = str(distribution.version)',
      '    value = {',
      '        "executable": sys.executable,',
      '        "executable_realpath": os.path.realpath(sys.executable),',
      '        "implementation": platform.python_implementation(),',
      '        "version": platform.python_version(),',
      '        "platform": platform.platform(),',
      '        "base_packages": dict(sorted(packages.items())),',
      '    }',
      `    print(${JSON.stringify(PROBE_BEGIN)} + json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + ${JSON.stringify(PROBE_END)})`,
      '__nebula_server_environment_probe__()',
      'del __nebula_server_environment_probe__',
    ].join('\n');
  }

  private taskLocalBootstrapSource(
    packageDirectory: string,
    canonicalPackageDirectory: string,
  ): string {
    return [
      'def __nebula_server_task_local_bootstrap__():',
      '    import importlib.metadata as metadata',
      '    import json',
      '    import os',
      '    import sys',
      `    package_directory = ${JSON.stringify(packageDirectory)}`,
      `    expected_realpath = ${JSON.stringify(canonicalPackageDirectory)}`,
      '    if os.path.realpath(package_directory) != expected_realpath or not os.path.isdir(package_directory):',
      '        raise RuntimeError("task-local package directory changed after server validation")',
      '    packages = {}',
      '    for distribution in metadata.distributions(path=[package_directory]):',
      '        name = distribution.metadata.get("Name")',
      '        if name:',
      '            packages[str(name).lower()] = str(distribution.version)',
      '    if package_directory not in sys.path:',
      '        sys.path.insert(0, package_directory)',
      `    print(${JSON.stringify(PROBE_BEGIN)} + json.dumps(dict(sorted(packages.items())), ensure_ascii=False, sort_keys=True, separators=(",", ":")) + ${JSON.stringify(PROBE_END)})`,
      '__nebula_server_task_local_bootstrap__()',
      'del __nebula_server_task_local_bootstrap__',
    ].join('\n');
  }

  private parseBaseEnvironmentProbe(stdout: string): Omit<RuntimeEnvironment, 'task_local'> {
    const raw = this.markerPayload(stdout, 'environment probe');
    const value = this.parseObject(raw, 'environment probe');
    const packages = this.stringMap(value.base_packages, 'environment probe base_packages');
    const python = {
      executable: this.nonempty(value.executable, 'environment probe executable'),
      executable_realpath: this.nonempty(value.executable_realpath, 'environment probe executable_realpath'),
      implementation: this.nonempty(value.implementation, 'environment probe implementation'),
      version: this.nonempty(value.version, 'environment probe version'),
      platform: this.nonempty(value.platform, 'environment probe platform'),
    };
    if (!path.isAbsolute(python.executable) || !path.isAbsolute(python.executable_realpath)) {
      throw new Error('Fresh kernel environment probe returned a non-absolute executable');
    }
    return {
      schema_version: 1,
      python,
      python_no_user_site: true,
      base_packages: packages,
      base_packages_sha256: sha256Canonical(packages),
    };
  }

  private parseTaskLocalProbe(stdout: string): Record<string, string> {
    return this.stringMap(
      this.parseObject(this.markerPayload(stdout, 'task-local bootstrap'), 'task-local bootstrap'),
      'task-local packages',
    );
  }

  private compareBaseEnvironment(
    actual: Omit<RuntimeEnvironment, 'task_local'>,
    declaration: Record<string, CanonicalJsonValue>,
  ): void {
    const base = this.optionalRecord(declaration.base, 'environment_manifest.base');
    if (!base || base.inspection === 'not_configured') return;
    const comparisons: Array<[string, unknown, unknown]> = [
      ['python_binary_target', base.python_binary_target, actual.python.executable_realpath],
      ['implementation', base.implementation, actual.python.implementation],
      ['python_version', base.python_version, actual.python.version],
      ['platform', base.platform, actual.python.platform],
      ['base_packages_sha256', base.base_packages_sha256, actual.base_packages_sha256],
    ];
    for (const [name, expected, observed] of comparisons) {
      if (expected !== undefined && expected !== null && expected !== observed) {
        throw new Error(`Fresh kernel environment mismatch for ${name}: expected ${String(expected)}, got ${String(observed)}`);
      }
    }
    if (base.base_packages !== undefined) {
      const expectedPackages = this.stringMap(base.base_packages, 'environment_manifest.base.base_packages');
      if (sha256Canonical(expectedPackages) !== actual.base_packages_sha256) {
        throw new Error('Fresh kernel environment mismatch for base_packages');
      }
    }
  }

  private compareTaskLocalEnvironment(
    packages: Record<string, string>,
    packagesSha256: string,
    declaration: Record<string, unknown>,
  ): void {
    if (declaration.packages_sha256 !== undefined && declaration.packages_sha256 !== packagesSha256) {
      throw new Error(`Task-local package hash mismatch: expected ${String(declaration.packages_sha256)}, got ${packagesSha256}`);
    }
    if (declaration.packages !== undefined) {
      const expected = this.stringMap(declaration.packages, 'environment_manifest.task_local.packages');
      if (sha256Canonical(expected) !== sha256Canonical(packages)) {
        throw new Error('Task-local package distribution map mismatch');
      }
    }
  }

  private taskLocalDeclaration(
    environment: Record<string, CanonicalJsonValue>,
    workspace: string,
  ): {
    packageDirectory: string;
    canonicalPackageDirectory: string;
    declaration: Record<string, unknown>;
  } | null {
    const taskLocal = this.optionalRecord(environment.task_local, 'environment_manifest.task_local');
    if (!taskLocal || taskLocal.package_directory === null || taskLocal.package_directory === undefined) return null;
    const packageDirectory = this.nonempty(taskLocal.package_directory, 'environment_manifest.task_local.package_directory');
    if (!path.isAbsolute(packageDirectory)) {
      throw new ReplaySealValidationError('environment_manifest.task_local.package_directory must be absolute');
    }
    this.relativeInside(workspace, packageDirectory, 'task-local package_directory');
    let stat: Stats;
    try {
      stat = lstatSync(packageDirectory);
    } catch {
      throw new ReplaySealValidationError('task-local package_directory must be an existing directory');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ReplaySealValidationError('task-local package_directory must be a real directory, not a symbolic link');
    }
    const realWorkspace = realpathSync(workspace);
    const realPackageDirectory = realpathSync(packageDirectory);
    this.relativeInside(realWorkspace, realPackageDirectory, 'task-local package_directory');
    this.assertNoSymlinkComponentsSync(path.resolve(workspace), path.resolve(packageDirectory));
    return {
      packageDirectory,
      canonicalPackageDirectory: realPackageDirectory,
      declaration: taskLocal,
    };
  }

  private validateEnvironmentDeclaration(
    environment: Record<string, CanonicalJsonValue>,
    workspace: string,
  ): void {
    this.taskLocalDeclaration(environment, workspace);
  }

  private parseFrozenNotebook(bytes: Buffer, requestedKernelName?: string): FrozenNotebook {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new ReplaySealValidationError(`Notebook is not valid JSON: ${this.errorMessage(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ReplaySealValidationError('Notebook must be a JSON object');
    }
    const notebook = parsed as JupyterNotebook;
    if (!Array.isArray(notebook.cells) || notebook.nbformat !== 4) {
      throw new ReplaySealValidationError('Replay sealing requires a Jupyter nbformat 4 notebook');
    }
    if (!notebook.metadata || typeof notebook.metadata !== 'object' || Array.isArray(notebook.metadata)) {
      throw new ReplaySealValidationError('Notebook metadata must be an object');
    }
    const seen = new Set<string>();
    const codeCells: FrozenCodeCell[] = [];
    notebook.cells.forEach((cell, index) => {
      if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
        throw new ReplaySealValidationError(`Notebook cell ${index + 1} must be an object`);
      }
      if (typeof cell.id !== 'string' || !CELL_ID_RE.test(cell.id)) {
        throw new ReplaySealValidationError(`Notebook cell ${index + 1} requires a canonical top-level Jupyter cell id`);
      }
      if (seen.has(cell.id)) {
        throw new ReplaySealValidationError(`Notebook has duplicate cell id ${cell.id}`);
      }
      seen.add(cell.id);
      if (cell.cell_type === 'code') {
        const source = this.cellSource(cell.source, index);
        const exploratoryOutputs = cell.outputs === undefined ? [] : cell.outputs;
        if (!Array.isArray(exploratoryOutputs)) {
          throw new ReplaySealValidationError(`Notebook code cell ${index + 1} has invalid outputs`);
        }
        canonicalJson(exploratoryOutputs);
        const exploratoryExecutionCount = cell.execution_count === null
          || cell.execution_count === undefined
          ? null
          : cell.execution_count;
        if (
          exploratoryExecutionCount !== null
          && (!Number.isSafeInteger(exploratoryExecutionCount) || (exploratoryExecutionCount as number) < 0)
        ) {
          throw new ReplaySealValidationError(`Notebook code cell ${index + 1} has invalid execution_count`);
        }
        codeCells.push({
          index,
          id: cell.id,
          source,
          exploratoryOutputsSha256: sha256Canonical(
            normalizeNotebookOutputsForComparison(exploratoryOutputs),
          ),
          exploratoryExecutionCount: exploratoryExecutionCount as number | null,
        });
      }
    });
    if (codeCells.length === 0) {
      throw new ReplaySealValidationError('Notebook must contain at least one code cell');
    }
    let kernelName = requestedKernelName;
    if (!kernelName) {
      const kernelspec = this.optionalRecord(notebook.metadata.kernelspec, 'notebook metadata.kernelspec');
      kernelName = typeof kernelspec?.name === 'string' && kernelspec.name.trim()
        ? kernelspec.name
        : 'python3';
    }
    return { notebook: this.cloneJson(notebook) as unknown as JupyterNotebook, codeCells, kernelName };
  }

  private normalizeRequest(raw: ReplaySealRequest): ReplaySealRequest {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ReplaySealValidationError('Replay-seal request body must be an object');
    }
    const allowedKeys = new Set([
      'notebook_path',
      'run_id',
      'task_id',
      'source_id',
      'source_notebook_sha256',
      'artifacts',
      'kernel_name',
      'input_manifest',
      'environment_manifest',
    ]);
    const unknownKeys = Object.keys(raw).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
      throw new ReplaySealValidationError(`Replay-seal request has unsupported field: ${unknownKeys[0]}`);
    }
    const notebookPath = this.nonempty(raw.notebook_path, 'notebook_path');
    if (!path.isAbsolute(notebookPath) || path.extname(notebookPath).toLowerCase() !== '.ipynb') {
      throw new ReplaySealValidationError('notebook_path must be an absolute .ipynb path');
    }
    if (path.normalize(notebookPath) !== notebookPath) {
      throw new ReplaySealValidationError('notebook_path must be normalized without dot segments');
    }
    const sourceSha256 = this.nonempty(raw.source_notebook_sha256, 'source_notebook_sha256');
    if (!SHA256_RE.test(sourceSha256)) {
      throw new ReplaySealValidationError('source_notebook_sha256 must be a lowercase SHA-256 digest');
    }
    const artifactDescriptors = raw.artifacts;
    if (!Array.isArray(artifactDescriptors)) {
      throw new ReplaySealValidationError('artifacts must be an array');
    }
    const workspace = path.dirname(notebookPath);
    const normalizedArtifacts: ReplaySealArtifactRequest[] = [];
    for (const [index, value] of artifactDescriptors.entries()) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ReplaySealValidationError(`artifacts item ${index + 1} must be an object`);
      }
      const descriptor = value as unknown as Record<string, unknown>;
      const descriptorKeys = Object.keys(descriptor);
      const unknownDescriptorKey = descriptorKeys.find(
        (key) => key !== 'path' && key !== 'sha256' && key !== 'size_bytes',
      );
      if (unknownDescriptorKey) {
        throw new ReplaySealValidationError(
          `artifacts item ${index + 1} has unsupported field: ${unknownDescriptorKey}`,
        );
      }
      const artifactPath = this.nonempty(descriptor.path, `artifacts item ${index + 1} path`);
      if (!path.isAbsolute(artifactPath)) {
        throw new ReplaySealValidationError(`artifacts item ${index + 1} path must be absolute`);
      }
      if (path.normalize(artifactPath) !== artifactPath) {
        throw new ReplaySealValidationError(`artifacts item ${index + 1} path must be normalized without dot segments`);
      }
      const relative = this.relativeInside(workspace, artifactPath, `artifacts item ${index + 1} path`);
      if (relative.split(path.sep)[0] === '.nebula') {
        throw new ReplaySealValidationError(`artifacts item ${index + 1} must not be inside .nebula`);
      }
      if (artifactPath === notebookPath) {
        throw new ReplaySealValidationError('artifacts must not repeat notebook_path');
      }
      if (normalizedArtifacts.some((artifact) => artifact.path === artifactPath)) {
        throw new ReplaySealValidationError(`artifacts repeats ${artifactPath}`);
      }
      const sha256 = this.nonempty(descriptor.sha256, `artifacts item ${index + 1} sha256`);
      if (!SHA256_RE.test(sha256)) {
        throw new ReplaySealValidationError(
          `artifacts item ${index + 1} sha256 must be a lowercase SHA-256 digest`,
        );
      }
      const sizeBytes = descriptor.size_bytes;
      if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0) {
        throw new ReplaySealValidationError(
          `artifacts item ${index + 1} size_bytes must be a non-negative safe integer`,
        );
      }
      normalizedArtifacts.push({
        path: path.normalize(artifactPath),
        sha256,
        size_bytes: sizeBytes as number,
      });
    }
    let inputManifest: Record<string, unknown>;
    let environmentManifest: Record<string, unknown>;
    try {
      inputManifest = this.plainRecord(raw.input_manifest, 'input_manifest');
      environmentManifest = this.plainRecord(raw.environment_manifest, 'environment_manifest');
    } catch (error) {
      if (error instanceof ReplaySealValidationError) throw error;
      throw new ReplaySealValidationError(this.errorMessage(error));
    }
    let kernelName: string | undefined;
    if (raw.kernel_name !== undefined) {
      kernelName = this.nonempty(raw.kernel_name, 'kernel_name');
      if (kernelName.startsWith('env:') && !path.isAbsolute(kernelName.slice(4))) {
        throw new ReplaySealValidationError('env: kernel_name must contain an absolute Python interpreter path');
      }
    }
    const request: ReplaySealRequest = {
      notebook_path: path.normalize(notebookPath),
      run_id: this.nonempty(raw.run_id, 'run_id'),
      task_id: this.nonempty(raw.task_id, 'task_id'),
      source_id: this.nonempty(raw.source_id, 'source_id'),
      source_notebook_sha256: sourceSha256,
      artifacts: normalizedArtifacts,
      input_manifest: inputManifest as Record<string, CanonicalJsonValue>,
      environment_manifest: environmentManifest as Record<string, CanonicalJsonValue>,
      ...(kernelName !== undefined ? { kernel_name: kernelName } : {}),
    };
    return this.cloneJson(request) as unknown as ReplaySealRequest;
  }

  private validateIdempotencyKey(value: string): void {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new ReplaySealValidationError('Idempotency-Key must be 1-512 characters without control characters');
    }
  }

  private responseFor(job: StoredSealJob): ReplaySealStatusResponse {
    if (job.status === 'completed' && job.manifest) {
      return { seal_id: job.sealId, status: 'completed', manifest: job.manifest };
    }
    if (job.status === 'failed') {
      return { seal_id: job.sealId, status: 'failed', error: job.error || 'Replay seal failed' };
    }
    if (job.status === 'completed') {
      throw new Error(`Completed replay seal ${job.sealId} has no manifest`);
    }
    return { seal_id: job.sealId, status: job.status };
  }

  private async verifiedResponseFor(job: StoredSealJob): Promise<ReplaySealStatusResponse> {
    if (job.status !== 'completed') return this.responseFor(job);
    try {
      const manifest = await this.verifyCompletedSeal(job);
      return { seal_id: job.sealId, status: 'completed', manifest };
    } catch (error) {
      return {
        seal_id: job.sealId,
        status: 'failed',
        error: `Seal integrity verification failed: ${this.errorMessage(error)}`,
      };
    }
  }

  private async verifyCompletedSeal(job: StoredSealJob): Promise<ReplaySealManifest> {
    if (!job.manifest) throw new Error('completed job has no manifest');
    if (job.requestFingerprint !== sha256Canonical(job.request)) {
      throw new Error('persisted request fingerprint mismatch');
    }
    const sealDirectory = await fsp.realpath(job.sealDirectory);
    if (sealDirectory !== job.sealDirectory) throw new Error('seal directory path is not canonical');
    const expectedFrozenPath = path.join(sealDirectory, 'source.ipynb');
    if (job.frozenNotebookPath !== expectedFrozenPath) throw new Error('frozen notebook path mismatch');

    const manifestPath = path.join(sealDirectory, 'manifest.json');
    const manifestStat = await fsp.lstat(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      throw new Error('manifest is not a regular immutable file');
    }
    const manifestBytes = await fsp.readFile(manifestPath);
    let parsed: unknown;
    try { parsed = JSON.parse(manifestBytes.toString('utf8')); } catch {
      throw new Error('manifest contains invalid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('manifest is not an object');
    }
    const manifest = parsed as ReplaySealManifest;
    if (manifestBytes.toString('utf8') !== `${canonicalJson(manifest)}\n`) {
      throw new Error('manifest is not canonical JSON');
    }
    const { manifest_sha256: claimedManifestSha256, ...unsignedManifest } = manifest;
    if (!SHA256_RE.test(claimedManifestSha256) || sha256Canonical(unsignedManifest) !== claimedManifestSha256) {
      throw new Error('manifest_sha256 mismatch');
    }
    if (canonicalJson(manifest) !== canonicalJson(job.manifest)) {
      throw new Error('job state and immutable manifest disagree');
    }
    if (
      manifest.schema_version !== 1
      || manifest.hash_profile !== CANONICAL_HASH_PROFILE
      || manifest.seal_id !== job.sealId
    ) {
      throw new Error('manifest identity mismatch');
    }
    if (
      manifest.source_notebook.path !== job.request.notebook_path
      || manifest.source_notebook.sha256 !== job.sourceNotebookSha256
      || manifest.source_notebook.sha256 !== job.request.source_notebook_sha256
    ) {
      throw new Error('source notebook attestation mismatch');
    }
    const frozen = await this.hashRegularFile(expectedFrozenPath);
    if (frozen.sha256 !== job.sourceNotebookSha256) throw new Error('frozen source notebook hash mismatch');

    const expectedNotebookPath = path.join(sealDirectory, 'notebook.ipynb');
    if (manifest.notebook.path !== expectedNotebookPath) throw new Error('sealed notebook path mismatch');
    const notebook = await this.hashRegularFile(expectedNotebookPath);
    if (notebook.sha256 !== manifest.notebook.sha256) throw new Error('sealed notebook hash mismatch');
    if (!Array.isArray(manifest.cells) || manifest.cells.length === 0) {
      throw new Error('manifest contains no executed cells');
    }
    await this.verifyManifestCells(expectedFrozenPath, expectedNotebookPath, manifest.cells);
    if (sha256Canonical(manifest.runtime_environment) !== manifest.runtime_environment_sha256) {
      throw new Error('runtime environment hash mismatch');
    }
    if (sha256Canonical(job.request.input_manifest) !== manifest.input_manifest_sha256) {
      throw new Error('input manifest hash mismatch');
    }
    if (sha256Canonical(job.request.environment_manifest) !== manifest.environment_manifest_sha256) {
      throw new Error('environment manifest hash mismatch');
    }
    if (!(await this.provenanceStore.verifyBlob(job.request.notebook_path, manifest.input_manifest_sha256)).valid) {
      throw new Error('input manifest blob verification failed');
    }
    if (!(await this.provenanceStore.verifyBlob(job.request.notebook_path, manifest.environment_manifest_sha256)).valid) {
      throw new Error('environment manifest blob verification failed');
    }
    if (!(await this.provenanceStore.verifyBlob(job.request.notebook_path, manifest.runtime_environment_sha256)).valid) {
      throw new Error('runtime environment blob verification failed');
    }

    const expectedArtifactSources = [
      job.request.notebook_path,
      ...job.request.artifacts.map((artifact) => artifact.path),
    ];
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== expectedArtifactSources.length) {
      throw new Error('artifact attestation count mismatch');
    }
    for (let index = 0; index < manifest.artifacts.length; index += 1) {
      const artifact = manifest.artifacts[index];
      if (artifact.source_path !== expectedArtifactSources[index]) {
        throw new Error(`artifact ${index + 1} source path mismatch`);
      }
      const artifactRealPath = await fsp.realpath(artifact.path);
      this.relativeInside(sealDirectory, artifactRealPath, `artifact ${index + 1} sealed path`);
      const actual = await this.hashRegularFile(artifact.path);
      if (actual.sha256 !== artifact.sha256 || actual.size_bytes !== artifact.size_bytes) {
        throw new Error(`artifact ${index + 1} hash or size mismatch`);
      }
      const requested = job.request.artifacts[index - 1];
      if (requested && (
        artifact.sha256 !== requested.sha256
        || artifact.size_bytes !== requested.size_bytes
      )) {
        throw new Error(`artifact ${index + 1} does not match its predeclared descriptor`);
      }
    }
    if (
      manifest.artifacts[0].path !== manifest.notebook.path
      || manifest.artifacts[0].sha256 !== manifest.notebook.sha256
    ) {
      throw new Error('notebook artifact does not match the sealed notebook');
    }

    const ledger = manifest.event_ledger;
    if (
      ledger.path !== this.provenanceStore.getLedgerPath(job.request.notebook_path)
      || ledger.head_sha256 !== manifest.event_chain_head_sha256
      || ledger.prefix_size_bytes < 1
      || !Number.isSafeInteger(ledger.head_seq)
      || ledger.head_seq < 1
    ) {
      throw new Error('event ledger metadata mismatch');
    }
    const ledgerBytes = await fsp.readFile(ledger.path);
    if (ledger.prefix_size_bytes > ledgerBytes.length) throw new Error('event ledger prefix exceeds file');
    const prefix = ledgerBytes.subarray(0, ledger.prefix_size_bytes);
    if (prefix.at(-1) !== 0x0a || sha256Hex(prefix) !== ledger.prefix_sha256) {
      throw new Error('event ledger prefix hash or boundary mismatch');
    }
    const head = this.verifyLedgerPrefix(prefix, job.request.notebook_path);
    if (
      head.eventHash !== ledger.head_sha256
      || head.seq !== ledger.head_seq
      || head.type !== 'seal.completed'
    ) {
      throw new Error('event ledger head mismatch');
    }
    const headPayload = this.plainRecord(head.payload, 'completed event payload');
    if (
      canonicalJson(head.record.actor) !== canonicalJson({
        kind: 'agent',
        id: job.request.source_id,
        name: 'kosmos',
      })
      || head.record.runId !== job.request.run_id
      || head.record.taskId !== job.request.task_id
      || head.record.sourceId !== job.request.source_id
      || head.record.inputManifestSha256 !== manifest.input_manifest_sha256
      || head.record.environmentManifestSha256 !== manifest.environment_manifest_sha256
    ) {
      throw new Error('completed event actor or request identity mismatch');
    }
    const expectedEventCells = manifest.cells.map((item) => ({
      cellId: item.cell_id,
      sourceSha256: item.source_sha256,
      exploratoryOutputsSha256: item.exploratory_outputs_sha256,
      outputsSha256: item.outputs_sha256,
      replayComparisonOutputsSha256: item.replay_comparison_outputs_sha256,
      outputsMatchExploratory: item.outputs_match_exploratory,
      exploratoryExecutionCount: item.exploratory_execution_count,
      executionId: item.execution_id,
      executionCount: item.execution_count,
      status: item.status,
    }));
    const expectedEventArtifacts = manifest.artifacts.map((item) => ({
      sourcePath: item.source_path,
      path: item.path,
      sha256: item.sha256,
      sizeBytes: item.size_bytes,
    }));
    if (
      headPayload.sealId !== job.sealId
      || headPayload.hashProfile !== CANONICAL_HASH_PROFILE
      || canonicalJson(headPayload.sourceNotebook) !== canonicalJson(manifest.source_notebook)
      || canonicalJson(headPayload.notebook) !== canonicalJson(manifest.notebook)
      || headPayload.inputManifestSha256 !== manifest.input_manifest_sha256
      || headPayload.environmentManifestSha256 !== manifest.environment_manifest_sha256
      || headPayload.runtimeEnvironmentSha256 !== manifest.runtime_environment_sha256
      || canonicalJson(headPayload.cells) !== canonicalJson(expectedEventCells)
      || canonicalJson(headPayload.artifacts) !== canonicalJson(expectedEventArtifacts)
      || canonicalJson(headPayload.isolation) !== canonicalJson({
        freshKernel: true,
        networkIsolated: false,
        filesystemIsolated: false,
      })
    ) {
      throw new Error('completed event does not attest this seal');
    }
    return manifest;
  }

  private verifyLedgerPrefix(
    prefix: Buffer,
    notebookPath: string,
  ): { eventHash: string; seq: number; type: string; payload: unknown; record: Record<string, unknown> } {
    const lines = prefix.toString('utf8').split('\n');
    if (lines.at(-1) !== '') throw new Error('ledger prefix lacks final newline');
    lines.pop();
    let previousHash: string | null = null;
    let head: {
      eventHash: string;
      seq: number;
      type: string;
      payload: unknown;
      record: Record<string, unknown>;
    } | undefined;
    for (let index = 0; index < lines.length; index += 1) {
      const record = this.parseObject(lines[index], `ledger event ${index + 1}`);
      const eventHash = record.eventHash;
      if (typeof eventHash !== 'string' || !SHA256_RE.test(eventHash)) {
        throw new Error(`ledger event ${index + 1} has an invalid hash`);
      }
      const { eventHash: _eventHash, ...unsigned } = record;
      if (
        sha256Canonical(unsigned) !== eventHash
        || record.seq !== index + 1
        || record.prevHash !== previousHash
        || record.notebookPath !== notebookPath
      ) {
        throw new Error(`ledger event ${index + 1} failed chain verification`);
      }
      if (typeof record.type !== 'string') throw new Error(`ledger event ${index + 1} has no type`);
      head = {
        eventHash,
        seq: index + 1,
        type: record.type,
        payload: record.payload,
        record,
      };
      previousHash = eventHash;
    }
    if (!head) throw new Error('ledger prefix contains no events');
    return head;
  }

  private async verifyManifestCells(
    sourceNotebookPath: string,
    sealedNotebookPath: string,
    cells: SealCellManifest[],
  ): Promise<void> {
    const readNotebook = async (filePath: string): Promise<JupyterNotebook> => {
      const raw = JSON.parse(await fsp.readFile(filePath, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray((raw as JupyterNotebook).cells)) {
        throw new Error(`Invalid notebook JSON during seal verification: ${filePath}`);
      }
      return raw as JupyterNotebook;
    };
    const source = await readNotebook(sourceNotebookPath);
    const sealed = await readNotebook(sealedNotebookPath);
    const sourceCodeCells = source.cells.filter((cell) => cell.cell_type === 'code');
    const sealedCodeCells = sealed.cells.filter((cell) => cell.cell_type === 'code');
    if (sourceCodeCells.length !== cells.length || sealedCodeCells.length !== cells.length) {
      throw new Error('manifest executed-cell count does not match notebook code cells');
    }
    for (let index = 0; index < cells.length; index += 1) {
      const record = cells[index];
      const original = sourceCodeCells[index];
      const replayed = sealedCodeCells[index];
      const originalSource = this.cellSource(original.source, index);
      const replayedSource = this.cellSource(replayed.source, index);
      const originalOutputs = original.outputs ?? [];
      const replayedOutputs = replayed.outputs ?? [];
      if (!Array.isArray(originalOutputs) || !Array.isArray(replayedOutputs)) {
        throw new Error(`Invalid notebook outputs for cell ${record.cell_id}`);
      }
      const exploratoryDigest = sha256Canonical(
        normalizeNotebookOutputsForComparison(originalOutputs),
      );
      const replayComparisonDigest = sha256Canonical(
        normalizeNotebookOutputsForComparison(replayedOutputs),
      );
      if (
        original.id !== record.cell_id
        || replayed.id !== record.cell_id
        || originalSource !== replayedSource
        || sha256Hex(replayedSource) !== record.source_sha256
        || sha256Canonical(replayedOutputs) !== record.outputs_sha256
        || exploratoryDigest !== record.exploratory_outputs_sha256
        || replayComparisonDigest !== record.replay_comparison_outputs_sha256
        || record.outputs_match_exploratory !== (exploratoryDigest === replayComparisonDigest)
        || (original.execution_count ?? null) !== record.exploratory_execution_count
        || replayed.execution_count !== record.execution_count
        || record.status !== 'completed'
      ) {
        throw new Error(`manifest cell attestation mismatch for ${record.cell_id}`);
      }
    }
  }

  private async hashRegularFile(filePath: string): Promise<{ sha256: string; size_bytes: number }> {
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (this.isNodeError(error, 'ELOOP')) throw new Error(`File is a symbolic link: ${filePath}`);
      throw error;
    }
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error(`Not a regular file: ${filePath}`);
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let sizeBytes = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        sizeBytes += bytesRead;
      }
      const after = await handle.stat();
      if (
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || after.size !== sizeBytes
      ) {
        throw new Error(`File changed during verification: ${filePath}`);
      }
      return { sha256: hash.digest('hex'), size_bytes: sizeBytes };
    } finally {
      await handle.close();
    }
  }

  private registryPath(sealId: string): string {
    return path.join(this.registryDirectory, `${sealId}.json`);
  }

  private async ensureRegistryDirectory(): Promise<void> {
    await this.ensureSafeDirectoryChain(this.rootDirectory, ['.nebula', 'replay-seal-jobs']);
  }

  private async createSafeSealDirectory(workspace: string, sealId: string): Promise<string> {
    const sealsDirectory = await this.ensureSafeDirectoryChain(workspace, ['.nebula', 'seals']);
    const sealDirectory = path.join(sealsDirectory, sealId);
    try {
      await fsp.mkdir(sealDirectory, { mode: 0o700 });
      if (this.durable) await this.syncDirectory(sealsDirectory);
    } catch (error) {
      if (!this.isNodeError(error, 'EEXIST')) throw error;
      const stat = await fsp.lstat(sealDirectory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ReplaySealValidationError('Seal path is not a real directory');
      }
      // An indexed job is handled before this method. An unindexed directory
      // is ambiguous crash/attacker state and must never be adopted silently.
      throw new ReplaySealValidationError(
        `Seal directory already exists without authoritative job state: ${sealDirectory}`,
      );
    }
    return await fsp.realpath(sealDirectory);
  }

  private async ensureSafeDirectoryChain(base: string, components: string[]): Promise<string> {
    let current = await fsp.realpath(base);
    const baseStat = await fsp.lstat(current);
    if (!baseStat.isDirectory()) throw new Error(`Directory root is not a directory: ${base}`);
    for (const component of components) {
      if (!component || component === '.' || component === '..' || component.includes(path.sep)) {
        throw new Error(`Unsafe directory component: ${component}`);
      }
      const candidate = path.join(current, component);
      try {
        await fsp.mkdir(candidate, { mode: 0o700 });
        if (this.durable) await this.syncDirectory(current);
      } catch (error) {
        if (!this.isNodeError(error, 'EEXIST')) throw error;
      }
      const stat = await fsp.lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ReplaySealValidationError(`Refusing unsafe directory in seal path: ${candidate}`);
      }
      const realCandidate = await fsp.realpath(candidate);
      if (path.dirname(realCandidate) !== current) {
        throw new ReplaySealValidationError(`Seal directory escapes its parent: ${candidate}`);
      }
      current = realCandidate;
    }
    return current;
  }

  private async hardenSealDirectory(directory: string): Promise<void> {
    const visit = async (current: string): Promise<void> => {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Seal contains a symbolic link: ${current}`);
      if (!stat.isDirectory()) {
        if (!stat.isFile()) throw new Error(`Seal contains a non-regular entry: ${current}`);
        await fsp.chmod(current, 0o400);
        return;
      }
      const entries = await fsp.readdir(current);
      for (const entry of entries) await visit(path.join(current, entry));
      await fsp.chmod(current, 0o500);
    };
    await visit(directory);
  }

  private sealRequestEventKey(sealId: string): string {
    return `replay-seal:${sealId}`;
  }

  private async persistJob(job: StoredSealJob): Promise<void> {
    await Promise.all([
      this.writeJsonAtomic(this.registryPath(job.sealId), job),
      this.writeJsonAtomic(path.join(job.sealDirectory, 'job.json'), job),
    ]);
  }

  private async updateJob(
    job: StoredSealJob,
    patch: Partial<Pick<StoredSealJob, 'status' | 'manifest' | 'error'>>,
  ): Promise<StoredSealJob> {
    const updated: StoredSealJob = {
      ...job,
      ...patch,
      updatedAt: this.clock().toISOString(),
    };
    if (patch.manifest === undefined) delete updated.manifest;
    if (patch.error === undefined) delete updated.error;
    await this.persistJob(updated);
    return updated;
  }

  private async readJob(filePath: string): Promise<StoredSealJob | null> {
    let raw: string;
    try {
      const stat = await fsp.lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Replay-seal job state must be a regular file: ${filePath}`);
      }
      raw = await fsp.readFile(filePath, 'utf8');
    } catch (error) {
      if (this.isNodeError(error, 'ENOENT')) return null;
      throw error;
    }
    const parsed = JSON.parse(raw) as StoredSealJob;
    if (!parsed || parsed.schemaVersion !== 1 || !SEAL_ID_RE.test(parsed.sealId)) {
      throw new Error(`Invalid replay-seal job state: ${filePath}`);
    }
    return parsed;
  }

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fsp.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8');
      if (this.durable) await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temporary, filePath);
  }

  private async writeImmutable(filePath: string, bytes: Buffer): Promise<void> {
    const directory = path.dirname(filePath);
    const temporary = path.join(
      directory,
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      const handle = await fsp.open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o400,
      );
      try {
        await handle.writeFile(bytes);
        if (this.durable) await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fsp.link(temporary, filePath);
      } catch (error) {
        if (!this.isNodeError(error, 'EEXIST')) throw error;
        const stat = await fsp.lstat(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`Immutable seal target is not a regular file: ${filePath}`);
        }
        const existing = await fsp.readFile(filePath);
        if (!existing.equals(bytes)) {
          throw new Error(`Immutable seal file already exists with different content: ${filePath}`);
        }
      }
      await fsp.chmod(filePath, 0o400);
      if (this.durable) await this.syncDirectory(directory);
    } finally {
      await fsp.unlink(temporary).catch(() => undefined);
    }
  }

  private async readNotebookSource(notebookPath: string): Promise<Buffer> {
    let lexicalStat;
    try {
      lexicalStat = await fsp.lstat(notebookPath);
    } catch (error) {
      if (this.isNodeError(error, 'ENOENT')) throw new ReplaySealValidationError(`Notebook not found: ${notebookPath}`);
      throw error;
    }
    if (lexicalStat.isSymbolicLink() || !lexicalStat.isFile()) {
      throw new ReplaySealValidationError('notebook_path must be a regular file, not a symbolic link');
    }
    const rootRealPath = await fsp.realpath(this.rootDirectory);
    const notebookRealPath = await fsp.realpath(notebookPath);
    this.relativeInside(rootRealPath, notebookRealPath, 'notebook_path');
    await this.assertNoSymlinkComponents(
      path.resolve(this.rootDirectory),
      path.resolve(notebookPath),
    );
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(notebookPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (this.isNodeError(error, 'ELOOP')) {
        throw new ReplaySealValidationError('notebook_path became a symbolic link during preflight');
      }
      throw error;
    }
    try {
      const before = await handle.stat();
      if (
        !before.isFile()
        || before.dev !== lexicalStat.dev
        || before.ino !== lexicalStat.ino
      ) {
        throw new ReplaySealValidationError('notebook_path changed during preflight');
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size
      ) {
        throw new ReplaySealValidationError('notebook_path changed while it was frozen');
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  private async captureLedgerPrefix(
    notebookPath: string,
    headHash: string,
    headSeq: number,
  ): Promise<ReplaySealManifest['event_ledger']> {
    const ledgerPath = this.provenanceStore.getLedgerPath(notebookPath);
    const bytes = await fsp.readFile(ledgerPath);
    let offset = 0;
    let foundEnd = -1;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline < 0) throw new Error('Provenance ledger does not end on an event boundary');
      const line = bytes.subarray(offset, newline).toString('utf8');
      const event = JSON.parse(line) as { eventHash?: unknown; seq?: unknown };
      if (event.eventHash === headHash && event.seq === headSeq) {
        foundEnd = newline + 1;
        break;
      }
      offset = newline + 1;
    }
    if (foundEnd < 0) throw new Error('Completed seal event is missing from provenance ledger');
    const prefix = bytes.subarray(0, foundEnd);
    return {
      path: ledgerPath,
      prefix_size_bytes: prefix.length,
      prefix_sha256: sha256Hex(prefix),
      head_sha256: headHash,
      head_seq: headSeq,
    };
  }

  private toJupyterOutput(output: KernelOutput): CanonicalJsonValue {
    switch (output.type) {
      case 'stdout':
      case 'stderr':
        return { output_type: 'stream', name: output.type, text: output.content };
      case 'error':
        return {
          output_type: 'error',
          ename: 'Error',
          evalue: output.content,
          traceback: output.content.split('\n'),
        };
      case 'image':
        return { output_type: 'display_data', data: { 'image/png': output.content }, metadata: output.metadata ?? {} };
      case 'html':
        return { output_type: 'display_data', data: { 'text/html': output.content }, metadata: output.metadata ?? {} };
      case 'display_data':
        if (output.jupyterOutputType === 'execute_result') {
          return {
            output_type: 'execute_result',
            data: output.mimeBundle ?? { 'text/plain': output.content },
            metadata: output.metadata ?? {},
            execution_count: output.jupyterExecutionCount ?? null,
          };
        }
        return {
          output_type: 'display_data',
          data: output.mimeBundle ?? { 'text/plain': output.content },
          metadata: output.metadata ?? {},
        };
    }
  }

  private markerPayload(stdout: string, context: string): string {
    const begin = stdout.lastIndexOf(PROBE_BEGIN);
    const end = stdout.indexOf(PROBE_END, begin + PROBE_BEGIN.length);
    if (begin < 0 || end < 0) throw new Error(`Fresh kernel ${context} returned no attestation payload`);
    return stdout.slice(begin + PROBE_BEGIN.length, end);
  }

  private parseObject(raw: string, context: string): Record<string, unknown> {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`Fresh kernel ${context} returned invalid JSON`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Fresh kernel ${context} returned a non-object payload`);
    }
    return parsed as Record<string, unknown>;
  }

  private stringMap(value: unknown, context: string): Record<string, string> {
    const record = this.plainRecord(value, context);
    const result: Record<string, string> = {};
    for (const key of Object.keys(record).sort()) {
      if (typeof record[key] !== 'string') throw new Error(`${context} values must be strings`);
      result[key] = record[key] as string;
    }
    return result;
  }

  private plainRecord(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ReplaySealValidationError(`${name} must be an object`);
    }
    canonicalJson(value);
    return this.cloneJson(value) as Record<string, unknown>;
  }

  private optionalRecord(value: unknown, name: string): Record<string, unknown> | null {
    if (value === undefined || value === null) return null;
    return this.plainRecord(value, name);
  }

  private nonempty(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.trim().length === 0 || /\u0000/.test(value)) {
      throw new ReplaySealValidationError(`${name} must be non-empty text`);
    }
    return value;
  }

  private cellSource(value: unknown, index: number): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join('');
    throw new ReplaySealValidationError(`Notebook code cell ${index + 1} has invalid source`);
  }

  private relativeInside(root: string, target: string, name: string): string {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ReplaySealValidationError(`${name} must be a distinct path inside the notebook workspace`);
    }
    return relative;
  }

  private async assertNoSymlinkComponents(root: string, target: string): Promise<void> {
    const relative = this.relativeInside(root, target, 'artifact path');
    let current = path.resolve(root);
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      let stat;
      try { stat = await fsp.lstat(current); } catch (error) {
        if (this.isNodeError(error, 'ENOENT')) throw new Error(`Requested artifact is missing: ${target}`);
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error(`Requested artifact path contains a symbolic link: ${target}`);
    }
    const real = await fsp.realpath(target);
    const realRoot = await fsp.realpath(root);
    this.relativeInside(realRoot, real, 'resolved artifact path');
  }

  private assertNoSymlinkComponentsSync(root: string, target: string): void {
    const relative = this.relativeInside(root, target, 'path');
    let current = path.resolve(root);
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      let stat: Stats;
      try { stat = lstatSync(current); } catch {
        throw new ReplaySealValidationError(`Path component does not exist: ${current}`);
      }
      if (stat.isSymbolicLink()) {
        throw new ReplaySealValidationError(`Path contains a symbolic link: ${current}`);
      }
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    try {
      const handle = await fsp.open(directory, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    } catch {
      // Some filesystems do not support directory fsync. File data remains
      // fsynced and create/rename operations still retain atomicity.
    }
  }

  private cloneJson<T>(value: T): T {
    return JSON.parse(canonicalJson(value)) as T;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isNodeError(error: unknown, code: string): boolean {
    return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code;
  }

  private runSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = ReplaySealService.queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const settled = result.then(() => undefined, () => undefined);
    ReplaySealService.queues.set(key, settled);
    settled.finally(() => {
      if (ReplaySealService.queues.get(key) === settled) ReplaySealService.queues.delete(key);
    });
    return result;
  }
}
