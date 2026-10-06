/** Persistent exploratory kernels with at-most-once dispatch, not a sandbox.
 *
 * Requests are claimed in SQLite before kernel dispatch. Unknown outcomes never
 * replay. The notebook and receipts retain completed source and outputs; neither
 * claims independent scientific validity or protects against same-user code.
 */
import Database from 'better-sqlite3';
import { constants, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ExecutionResult,
  KernelOutput,
  SessionInfo,
  StartKernelOptions,
} from '../kernel/types';
import { canonicalJson, sha256Hex } from './canonical-json';
import { assertPathMutable } from '../fs/sealed-path';

export interface SessionKernel {
  startKernel(options: StartKernelOptions): Promise<string>;
  getSessionStatusFast(id: string): SessionInfo | null;
  executeCode(
    id: string,
    code: string,
    output: (value: KernelOutput) => Promise<void>,
    queue?: undefined,
    cellId?: string,
  ): Promise<ExecutionResult>;
  interruptKernel(id: string): Promise<boolean>;
  stopKernel(id: string): Promise<boolean>;
}
export interface OpenSessionRequest {
  notebook_path: string;
  kernel_name: string;
  environment_sha256: string;
}
export interface ExecuteSessionRequest {
  session_id: string;
  revision: number;
  code: string;
  timeout_seconds: number;
}
type SessionStatus = 'opening' | 'ready' | 'busy' | 'blocked' | 'closed';
type OperationStatus = 'pending' | 'running' | 'completed' | 'ambiguous';
export const SESSION_EXECUTION_PROTOCOL =
  'nebula-session-execution/v1' as const;
interface SessionRecord {
  protocol: typeof SESSION_EXECUTION_PROTOCOL;
  session_id: string;
  request: OpenSessionRequest;
  status: SessionStatus;
  owner: string;
  revision: number;
  kernel_id: string | null;
  kernel_pid: number | null;
  kernel_created_at: number | null;
  execution_count: number;
  notebook_sha256: string;
  error?: string;
}
export interface ExecutionReceipt {
  protocol: typeof SESSION_EXECUTION_PROTOCOL;
  session_id: string;
  operation_id: string;
  revision_before: number;
  revision_after: number;
  request_sha256: string;
  source_sha256: string;
  environment_sha256: string;
  notebook_path: string;
  notebook_sha256: string;
  cell_id: string;
  kernel_id: string;
  execution_count: number;
  outputs: KernelOutput[];
  result: ExecutionResult;
  security_sandbox: false;
}
interface OperationRecord {
  protocol: typeof SESSION_EXECUTION_PROTOCOL;
  operation_id: string;
  request: ExecuteSessionRequest;
  status: OperationStatus;
  owner: string;
  receipt?: ExecutionReceipt;
  error?: string;
}
export class SessionExecutionError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_request' | 'conflict' = 'invalid_request',
  ) {
    super(message);
  }
}
const HASH = /^[a-f0-9]{64}$/;
const SESSION = /^session-[a-f0-9]{64}$/;
const OPERATION = /^execution-[a-f0-9]{64}$/;
const MAX_OUTPUT = 4 * 1024 * 1024;
function requireValue(
  condition: unknown,
  message: string,
  conflict = false,
): asserts condition {
  if (!condition)
    throw new SessionExecutionError(
      message,
      conflict ? 'conflict' : 'invalid_request',
    );
}
function object(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  requireValue(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === keys.sort().join(','),
    'Request has missing or unknown fields',
  );
}
function identity(key: string, prefix: string): string {
  requireValue(
    typeof key === 'string' && key.length > 0 && key.length <= 512,
    'Idempotency-Key must be nonempty text of at most 512 characters',
  );
  return prefix + sha256Hex(key);
}
function hash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
function copy<T>(value: T): T {
  return JSON.parse(canonicalJson(value));
}

export class SessionExecutionService {
  private readonly root: string;
  private readonly database: Database.Database;
  private readonly owner = randomUUID();
  private readonly kernel: SessionKernel;
  private readonly jobs = new Set<string>();
  // A failed durable write must surface within this process too. After restart,
  // the retained pending claim belongs to another owner and already fails closed.
  private readonly failedSessions = new Set<string>();
  private readonly failedOperations = new Set<string>();
  private closing = false;

  constructor(options: {
    rootDirectory: string;
    kernelService: SessionKernel;
  }) {
    this.root = path.resolve(options.rootDirectory);
    requireValue(
      realpathSync(this.root) === this.root &&
        lstatSync(this.root).isDirectory(),
      'Session workspace must be a real directory, not a symlink',
    );
    this.kernel = options.kernelService;
    for (const directory of [
      path.join(this.root, '.nebula'),
      path.join(this.root, '.nebula', 'session-execution'),
    ]) {
      try {
        mkdirSync(directory, { mode: 0o750 });
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
      }
      requireValue(
        lstatSync(directory).isDirectory() &&
          !lstatSync(directory).isSymbolicLink(),
        'Session receipt directory must not be a symlink',
      );
    }
    const databasePath = path.join(
      this.root,
      '.nebula',
      'session-execution',
      'receipts.sqlite',
    );
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        const stat = lstatSync(databasePath + suffix);
        requireValue(
          stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
          'Unsafe session receipt database',
        );
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    this.database = new Database(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = FULL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS execution_sessions (id TEXT PRIMARY KEY, notebook_path TEXT UNIQUE NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_operations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL, UNIQUE(session_id, revision));
    `);
  }
  close(): void {
    requireValue(
      this.jobs.size === 0,
      'Cannot close a session service while operations are running',
      true,
    );
    this.closing = true;
    this.database.close();
  }
  private load<T>(
    table: 'execution_sessions' | 'execution_operations',
    id: string,
  ): T | null {
    const row = this.database
      .prepare(`SELECT record FROM ${table} WHERE id = ?`)
      .get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) : null;
  }
  private saveSession(record: SessionRecord): void {
    this.database
      .prepare('UPDATE execution_sessions SET record = ? WHERE id = ?')
      .run(canonicalJson(record), record.session_id);
  }
  private saveOperation(record: OperationRecord): void {
    this.database
      .prepare('UPDATE execution_operations SET record = ? WHERE id = ?')
      .run(canonicalJson(record), record.operation_id);
  }
  private async checkedPath(notebook: string): Promise<void> {
    requireValue(
      typeof notebook === 'string' &&
        path.isAbsolute(notebook) &&
        path.normalize(notebook) === notebook &&
        notebook.endsWith('.ipynb'),
      'Notebook path must be normalized, absolute and end in .ipynb',
    );
    const relative = path.relative(this.root, notebook);
    requireValue(
      relative !== '' &&
        !relative.startsWith('..' + path.sep) &&
        relative !== '..' &&
        !path.isAbsolute(relative),
      'Notebook is outside the session workspace',
    );
    assertPathMutable(notebook, { operation: 'persistent session execution' });
    let current = this.root;
    for (const part of path
      .dirname(relative)
      .split(path.sep)
      .filter((p) => p !== '.')) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      requireValue(
        stat.isDirectory() && !stat.isSymbolicLink(),
        'Notebook parent must be an existing real directory',
      );
    }
  }
  private async readNotebook(
    record: SessionRecord,
  ): Promise<{ bytes: Buffer; value: any }> {
    await this.checkedPath(record.request.notebook_path);
    const file = await fs.open(
      record.request.notebook_path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      requireValue(
        stat.isFile() && stat.nlink === 1 && stat.size <= 64 * 1024 * 1024,
        'Invalid session notebook file',
      );
      const bytes = await file.readFile();
      requireValue(
        sha256Hex(bytes) === record.notebook_sha256,
        'Session notebook has changed outside its execution receipts',
        true,
      );
      return { bytes, value: JSON.parse(bytes.toString('utf8')) };
    } finally {
      await file.close();
    }
  }
  private live(record: SessionRecord): SessionInfo {
    const info =
      record.kernel_id && this.kernel.getSessionStatusFast(record.kernel_id);
    requireValue(
      info &&
        info.status === 'idle' &&
        info.pid === record.kernel_pid &&
        info.createdAt === record.kernel_created_at &&
        info.executionCount === record.execution_count &&
        info.kernelName === record.request.kernel_name &&
        info.filePath === record.request.notebook_path,
      'Session kernel is missing, busy, replaced or changed outside its receipts',
      true,
    );
    return info;
  }
  async session(id: string): Promise<SessionRecord | null> {
    requireValue(SESSION.test(id), 'Invalid session ID');
    const record = this.load<SessionRecord>('execution_sessions', id);
    if (
      record &&
      ['opening', 'busy'].includes(record.status) &&
      (record.owner !== this.owner || this.failedSessions.has(id))
    ) {
      return {
        ...record,
        status: 'blocked',
        error:
          'Dispatch or its durable write is uncertain. Recover the original receipt; do not rerun it.',
      };
    }
    return copy(record);
  }
  async operation(id: string): Promise<OperationRecord | null> {
    requireValue(OPERATION.test(id), 'Invalid execution ID');
    const record = this.load<OperationRecord>('execution_operations', id);
    if (
      record &&
      ['pending', 'running'].includes(record.status) &&
      (record.owner !== this.owner || this.failedOperations.has(id))
    ) {
      return {
        ...record,
        status: 'ambiguous',
        error:
          'Dispatch or its durable write is uncertain; no automatic replay.',
      };
    }
    return copy(record);
  }
  async open(raw: OpenSessionRequest, key: string): Promise<SessionRecord> {
    requireValue(!this.closing, 'Session service is closed');
    object(raw, ['notebook_path', 'kernel_name', 'environment_sha256']);
    const request = copy(raw);
    requireValue(
      typeof request.kernel_name === 'string' &&
        request.kernel_name.length > 0 &&
        request.kernel_name.length <= 4096 &&
        HASH.test(request.environment_sha256),
      'Invalid kernel or environment hash',
    );
    const id = identity(key, 'session-');
    const prior = this.load<SessionRecord>('execution_sessions', id);
    if (prior) {
      requireValue(
        canonicalJson(prior.request) === canonicalJson(request),
        'Idempotency key conflicts with the original session request',
        true,
      );
      return (await this.session(id))!;
    }
    await this.checkedPath(request.notebook_path);
    try {
      await fs.lstat(request.notebook_path);
      // Another identical opener may have claimed and created it during lstat.
      const concurrent = this.load<SessionRecord>('execution_sessions', id);
      if (concurrent) {
        requireValue(
          canonicalJson(concurrent.request) === canonicalJson(request),
          'Idempotency conflict',
          true,
        );
        return (await this.session(id))!;
      }
      throw new SessionExecutionError(
        'Notebook already exists; session opening never overwrites it',
        'conflict',
      );
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
    const notebook = Buffer.from(
      JSON.stringify(
        {
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {
            kernelspec: {
              name: request.kernel_name,
              display_name: request.kernel_name,
            },
            nebula_harness_session: id,
          },
          cells: [],
        },
        null,
        2,
      ) + '\n',
    );
    const record: SessionRecord = {
      protocol: SESSION_EXECUTION_PROTOCOL,
      session_id: id,
      request,
      owner: this.owner,
      status: 'opening',
      revision: 0,
      kernel_id: null,
      kernel_pid: null,
      kernel_created_at: null,
      execution_count: 0,
      notebook_sha256: sha256Hex(notebook),
    };
    const claimed = this.database.transaction(() => {
      const existing = this.load<SessionRecord>('execution_sessions', id);
      if (existing) {
        requireValue(
          canonicalJson(existing.request) === canonicalJson(request),
          'Idempotency conflict',
          true,
        );
        return false;
      }
      requireValue(
        !this.database
          .prepare('SELECT id FROM execution_sessions WHERE notebook_path = ?')
          .get(request.notebook_path),
        'Notebook is already claimed by a session',
        true,
      );
      this.database
        .prepare('INSERT INTO execution_sessions VALUES (?, ?, ?)')
        .run(id, request.notebook_path, canonicalJson(record));
      return true;
    })();
    if (claimed) {
      this.jobs.add(id);
      void this.openKernel(record, notebook)
        .catch(() => {
          this.failedSessions.add(id);
        })
        .finally(() => this.jobs.delete(id));
    }
    return (await this.session(id))!;
  }
  private async openKernel(
    record: SessionRecord,
    notebook: Buffer,
  ): Promise<void> {
    try {
      await this.checkedPath(record.request.notebook_path);
      const file = await fs.open(
        record.request.notebook_path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o640,
      );
      try {
        await file.writeFile(notebook);
        await file.sync();
      } finally {
        await file.close();
      }
      record.kernel_id = await this.kernel.startKernel({
        kernelName: record.request.kernel_name,
        cwd: path.dirname(record.request.notebook_path),
        filePath: record.request.notebook_path,
      });
      const info = this.kernel.getSessionStatusFast(record.kernel_id);
      requireValue(
        info &&
          info.status === 'idle' &&
          info.executionCount === 0 &&
          info.pid !== null,
        'New session kernel was not ready and unused',
      );
      record.kernel_pid = info.pid;
      record.kernel_created_at = info.createdAt;
      record.status = 'ready';
    } catch (error) {
      record.status = 'blocked';
      record.error =
        error instanceof Error
          ? error.message
          : 'Session initialization failed';
    }
    this.saveSession(record);
  }
  async execute(
    raw: ExecuteSessionRequest,
    key: string,
  ): Promise<OperationRecord> {
    requireValue(!this.closing, 'Session service is closed');
    object(raw, ['session_id', 'revision', 'code', 'timeout_seconds']);
    const request = copy(raw);
    requireValue(
      SESSION.test(request.session_id) &&
        Number.isSafeInteger(request.revision) &&
        request.revision >= 0 &&
        typeof request.code === 'string' &&
        request.code.trim().length > 0 &&
        Buffer.byteLength(request.code) <= 1024 * 1024 &&
        Number.isSafeInteger(request.timeout_seconds) &&
        request.timeout_seconds > 0 &&
        request.timeout_seconds <= 3600,
      'Invalid execution request',
    );
    const id = identity(key, 'execution-');
    const prior = this.load<OperationRecord>('execution_operations', id);
    if (prior) {
      requireValue(
        canonicalJson(prior.request) === canonicalJson(request),
        'Idempotency key conflicts with the original execution request',
        true,
      );
      return (await this.operation(id))!;
    }
    const record = this.load<SessionRecord>(
      'execution_sessions',
      request.session_id,
    );
    requireValue(
      record &&
        record.status === 'ready' &&
        record.revision === request.revision,
      'Session is not ready, blocked, or has a different revision',
      true,
    );
    this.live(record);
    await this.readNotebook(record);
    const operation: OperationRecord = {
      protocol: SESSION_EXECUTION_PROTOCOL,
      operation_id: id,
      request,
      status: 'pending',
      owner: this.owner,
    };
    const claimed = this.database.transaction(() => {
      const previous = this.load<OperationRecord>('execution_operations', id);
      if (previous) {
        requireValue(
          canonicalJson(previous.request) === canonicalJson(request),
          'Idempotency conflict',
          true,
        );
        return false;
      }
      const latest = this.load<SessionRecord>(
        'execution_sessions',
        request.session_id,
      );
      requireValue(
        latest &&
          latest.status === 'ready' &&
          latest.revision === request.revision &&
          !this.database
            .prepare(
              'SELECT id FROM execution_operations WHERE session_id = ? AND revision = ?',
            )
            .get(request.session_id, request.revision),
        'Session revision already has an in-flight or retained operation',
        true,
      );
      this.database
        .prepare('INSERT INTO execution_operations VALUES (?, ?, ?, ?)')
        .run(
          id,
          request.session_id,
          request.revision,
          canonicalJson(operation),
        );
      this.saveSession({ ...record, status: 'busy', owner: this.owner });
      return true;
    })();
    if (claimed) {
      this.jobs.add(id);
      void this.dispatch(record, operation)
        .catch(() => {
          this.failedSessions.add(record.session_id);
          this.failedOperations.add(id);
        })
        .finally(() => this.jobs.delete(id));
    }
    return (await this.operation(id))!;
  }
  private async dispatch(
    session: SessionRecord,
    operation: OperationRecord,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let temporary: string | undefined;
    try {
      this.live(session);
      const notebook = (await this.readNotebook(session)).value;
      operation.status = 'running';
      this.saveOperation(operation); // Durable before the only code-dispatch call.
      const outputs: KernelOutput[] = [];
      let outputBytes = 0;
      let overflow = false;
      const cellId = 'harness-' + operation.operation_id.slice(-48);
      const execution = this.kernel.executeCode(
        session.kernel_id!,
        operation.request.code,
        async (item) => {
          outputBytes += Buffer.byteLength(canonicalJson(item));
          if (outputBytes > MAX_OUTPUT) {
            overflow = true;
            return;
          }
          outputs.push(copy(item));
        },
        undefined,
        cellId,
      );
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void this.kernel
            .interruptKernel(session.kernel_id!)
            .catch(() => false);
          reject(
            new Error(
              'Execution deadline exceeded; namespace state is uncertain',
            ),
          );
        }, operation.request.timeout_seconds * 1000);
      });
      const result = await Promise.race([execution, deadline]);
      clearTimeout(timer);
      requireValue(
        !overflow,
        'Execution output exceeded its retained receipt limit',
      );
      requireValue(
        result.executionCount === session.execution_count + 1,
        'Execution count changed or no complete kernel result was received',
      );
      const info = this.kernel.getSessionStatusFast(session.kernel_id!);
      requireValue(
        info &&
          info.pid === session.kernel_pid &&
          info.createdAt === session.kernel_created_at,
        'Kernel identity changed during execution',
      );
      notebook.cells.push({
        id: cellId,
        cell_type: 'code',
        metadata: {
          nebula_id: cellId,
          harness_operation_id: operation.operation_id,
        },
        source: [operation.request.code],
        execution_count: result.executionCount,
        outputs: outputs.map(notebookOutput),
      });
      const bytes = Buffer.from(JSON.stringify(notebook, null, 2) + '\n');
      requireValue(
        bytes.length <= 64 * 1024 * 1024,
        'Session notebook exceeds receipt size limit',
      );
      await this.readNotebook(session); // Refuse to replace concurrent user edits.
      temporary = session.request.notebook_path + '.harness-' + randomUUID();
      const file = await fs.open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o640,
      );
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await this.checkedPath(session.request.notebook_path);
      await this.readNotebook(session);
      await fs.rename(temporary, session.request.notebook_path);
      temporary = undefined;
      const parent = await fs.open(
        path.dirname(session.request.notebook_path),
        constants.O_RDONLY,
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      const receipt: ExecutionReceipt = {
        protocol: SESSION_EXECUTION_PROTOCOL,
        session_id: session.session_id,
        operation_id: operation.operation_id,
        revision_before: session.revision,
        revision_after: session.revision + 1,
        request_sha256: hash(operation.request),
        source_sha256: sha256Hex(operation.request.code),
        environment_sha256: session.request.environment_sha256,
        notebook_path: session.request.notebook_path,
        notebook_sha256: sha256Hex(bytes),
        cell_id: cellId,
        kernel_id: session.kernel_id!,
        execution_count: result.executionCount!,
        outputs,
        result: copy(result),
        security_sandbox: false,
      };
      this.database.transaction(() => {
        this.saveOperation({ ...operation, status: 'completed', receipt });
        this.saveSession({
          ...session,
          status: 'ready',
          owner: this.owner,
          revision: session.revision + 1,
          execution_count: result.executionCount!,
          notebook_sha256: receipt.notebook_sha256,
        });
      })();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown execution outcome';
      this.database.transaction(() => {
        this.saveOperation({
          ...operation,
          status: 'ambiguous',
          error: message,
        });
        this.saveSession({
          ...session,
          status: 'blocked',
          owner: this.owner,
          error: message,
        });
      })();
    } finally {
      if (timer) clearTimeout(timer);
      if (temporary) await fs.unlink(temporary).catch(() => undefined);
    }
  }
}

function notebookOutput(value: KernelOutput): Record<string, unknown> {
  if (value.type === 'stdout' || value.type === 'stderr')
    return { output_type: 'stream', name: value.type, text: [value.content] };
  if (value.type === 'error')
    return {
      output_type: 'error',
      ename: 'KernelError',
      evalue: value.content,
      traceback: [value.content],
    };
  const data = value.mimeBundle || {
    [value.type === 'html'
      ? 'text/html'
      : value.type === 'image'
        ? 'image/png'
        : 'text/plain']: value.content,
  };
  return {
    output_type: value.jupyterOutputType || 'display_data',
    data,
    metadata: value.metadata || {},
    ...(value.jupyterOutputType === 'execute_result'
      ? { execution_count: value.jupyterExecutionCount ?? null }
      : {}),
  };
}
