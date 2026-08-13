import { randomUUID } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { canonicalJson, sha256Canonical, sha256Hex } from './canonical-json';
import type {
  ProvenanceActor,
  ProvenanceAppendResult,
  ProvenanceBlobReference,
  ProvenanceBlobVerification,
  ProvenanceEvent,
  ProvenanceEventInput,
  ProvenanceVerification,
} from './types';

const SHA256_RE = /^[a-f0-9]{64}$/;

export class ProvenanceIntegrityError extends Error {
  readonly code = 'PROVENANCE_INTEGRITY_ERROR';
  readonly failedLine?: number;

  constructor(message: string, failedLine?: number) {
    super(message);
    this.name = 'ProvenanceIntegrityError';
    this.failedLine = failedLine;
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(key: string) {
    super(`Idempotency key "${key}" was already used with different provenance input`);
    this.name = 'IdempotencyConflictError';
  }
}

export class BlobIntegrityError extends Error {
  readonly code = 'PROVENANCE_BLOB_INTEGRITY_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'BlobIntegrityError';
  }
}

export interface ProvenanceStoreOptions {
  /** fsync ledger/blob writes. Defaults to true. */
  durable?: boolean;
  /** Test seam; production events always use the server clock. */
  clock?: () => Date;
  /** Test seam; production events use cryptographically random UUIDs. */
  idFactory?: () => string;
}

/**
 * Server-owned append-only scientific provenance storage.
 *
 * Undo/redo history remains a separate, client-replaceable projection. This
 * store writes one canonical event per JSONL line and binds every event to the
 * previous event hash. All mutations for a notebook are serialized in-process.
 */
export class ProvenanceStore {
  private static readonly writeQueues = new Map<string, Promise<void>>();

  private readonly durable: boolean;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;

  constructor(options: ProvenanceStoreOptions = {}) {
    this.durable = options.durable !== false;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  getLedgerPath(notebookPath: string): string {
    const normalizedPath = this.normalizeNotebookPath(notebookPath);
    return path.join(
      path.dirname(normalizedPath),
      '.nebula',
      `${path.basename(normalizedPath)}.provenance.jsonl`,
    );
  }

  getBlobPath(notebookPath: string, sha256: string): string {
    this.assertSha256(sha256, 'blob sha256');
    const normalizedPath = this.normalizeNotebookPath(notebookPath);
    return path.join(
      path.dirname(normalizedPath),
      '.nebula',
      'provenance',
      'blobs',
      'sha256',
      sha256.slice(0, 2),
      sha256,
    );
  }

  async append(notebookPath: string, input: ProvenanceEventInput): Promise<ProvenanceAppendResult> {
    const normalizedPath = this.normalizeNotebookPath(notebookPath);
    const normalizedInput = this.normalizeInput(input);
    const ledgerPath = this.getLedgerPath(normalizedPath);

    return this.runSerialized(`ledger:${ledgerPath}`, async () => {
      const events = await this.readVerified(normalizedPath);
      const requestHash = this.hashRequest(normalizedPath, normalizedInput);

      if (normalizedInput.idempotencyKey) {
        const existing = events.find(
          (event) => event.idempotencyKey === normalizedInput.idempotencyKey,
        );
        if (existing) {
          if (existing.idempotencyRequestHash !== requestHash) {
            throw new IdempotencyConflictError(normalizedInput.idempotencyKey);
          }
          return { event: existing, appended: false };
        }
      }

      const eventId = this.idFactory();
      if (typeof eventId !== 'string' || eventId.length === 0) {
        throw new TypeError('Provenance event id must be a non-empty string');
      }
      if (events.some((event) => event.eventId === eventId)) {
        throw new ProvenanceIntegrityError(`Duplicate provenance event id: ${eventId}`);
      }

      const timestamp = this.clock().toISOString();
      const previous = events.at(-1);
      const unsignedEvent: Omit<ProvenanceEvent, 'eventHash'> = {
        schemaVersion: 1,
        eventId,
        seq: (previous?.seq ?? 0) + 1,
        timestamp,
        notebookPath: normalizedPath,
        type: normalizedInput.type,
        actor: normalizedInput.actor,
        payload: normalizedInput.payload ?? null,
        ...(normalizedInput.runId !== undefined ? { runId: normalizedInput.runId } : {}),
        ...(normalizedInput.taskId !== undefined ? { taskId: normalizedInput.taskId } : {}),
        ...(normalizedInput.sourceId !== undefined ? { sourceId: normalizedInput.sourceId } : {}),
        ...(normalizedInput.executionId !== undefined ? { executionId: normalizedInput.executionId } : {}),
        ...(normalizedInput.inputManifestSha256 !== undefined
          ? { inputManifestSha256: normalizedInput.inputManifestSha256 }
          : {}),
        ...(normalizedInput.environmentManifestSha256 !== undefined
          ? { environmentManifestSha256: normalizedInput.environmentManifestSha256 }
          : {}),
        ...(normalizedInput.idempotencyKey !== undefined
          ? {
              idempotencyKey: normalizedInput.idempotencyKey,
              idempotencyRequestHash: requestHash,
            }
          : {}),
        prevHash: previous?.eventHash ?? null,
      };
      const event: ProvenanceEvent = {
        ...unsignedEvent,
        eventHash: sha256Canonical(unsignedEvent),
      };

      await this.appendLine(ledgerPath, `${canonicalJson(event)}\n`);
      return { event, appended: true };
    });
  }

  async read(notebookPath: string): Promise<ProvenanceEvent[]> {
    return this.readVerified(this.normalizeNotebookPath(notebookPath));
  }

  async verify(notebookPath: string): Promise<ProvenanceVerification> {
    const normalizedPath = this.normalizeNotebookPath(notebookPath);
    try {
      const events = await this.readVerified(normalizedPath);
      const last = events.at(-1);
      return {
        valid: true,
        eventCount: events.length,
        lastSeq: last?.seq ?? 0,
        headHash: last?.eventHash ?? null,
      };
    } catch (error) {
      const integrityError = error instanceof ProvenanceIntegrityError
        ? error
        : new ProvenanceIntegrityError(error instanceof Error ? error.message : String(error));
      return {
        valid: false,
        eventCount: 0,
        lastSeq: 0,
        headHash: null,
        error: integrityError.message,
        ...(integrityError.failedLine !== undefined
          ? { failedLine: integrityError.failedLine }
          : {}),
      };
    }
  }

  async findByIdempotencyKey(
    notebookPath: string,
    idempotencyKey: string,
  ): Promise<ProvenanceEvent | null> {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new TypeError('Idempotency key must be a non-empty string');
    }
    const events = await this.read(notebookPath);
    return events.find((event) => event.idempotencyKey === idempotencyKey) ?? null;
  }

  async putBlob(
    notebookPath: string,
    value: string | Buffer | Uint8Array,
  ): Promise<ProvenanceBlobReference> {
    const bytes = this.toBuffer(value);
    const sha256 = sha256Hex(bytes);
    const blobPath = this.getBlobPath(notebookPath, sha256);

    return this.runSerialized(`blob:${blobPath}`, async () => {
      const existing = await this.readIfExists(blobPath);
      if (existing) {
        this.assertBlobBytes(existing, sha256, blobPath);
        return { sha256, sizeBytes: existing.length };
      }

      const directory = path.dirname(blobPath);
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      const tempPath = path.join(
        directory,
        `.${sha256}.${process.pid}.${randomUUID()}.tmp`,
      );

      try {
        const handle = await fsp.open(tempPath, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          if (this.durable) await handle.sync();
        } finally {
          await handle.close();
        }

        try {
          // A fully-written temp file becomes visible atomically. link() is
          // create-only, so a competing writer can never overwrite content.
          await fsp.link(tempPath, blobPath);
          if (this.durable) await this.syncDirectory(directory);
        } catch (error) {
          if (!this.isNodeError(error, 'EEXIST')) throw error;
          const winner = await fsp.readFile(blobPath);
          this.assertBlobBytes(winner, sha256, blobPath);
        }
      } finally {
        await fsp.unlink(tempPath).catch(() => undefined);
      }

      return { sha256, sizeBytes: bytes.length };
    });
  }

  async readBlob(notebookPath: string, sha256: string): Promise<Buffer> {
    const blobPath = this.getBlobPath(notebookPath, sha256);
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(blobPath);
    } catch (error) {
      if (this.isNodeError(error, 'ENOENT')) {
        throw new BlobIntegrityError(`Provenance blob not found: ${sha256}`);
      }
      throw error;
    }
    this.assertBlobBytes(bytes, sha256, blobPath);
    return bytes;
  }

  async verifyBlob(notebookPath: string, sha256: string): Promise<ProvenanceBlobVerification> {
    const blobPath = this.getBlobPath(notebookPath, sha256);
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(blobPath);
    } catch (error) {
      if (this.isNodeError(error, 'ENOENT')) {
        return {
          valid: false,
          expectedSha256: sha256,
          error: `Provenance blob not found: ${sha256}`,
        };
      }
      return {
        valid: false,
        expectedSha256: sha256,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const actualSha256 = sha256Hex(bytes);
    return {
      valid: actualSha256 === sha256,
      expectedSha256: sha256,
      actualSha256,
      sizeBytes: bytes.length,
      ...(actualSha256 === sha256
        ? {}
        : { error: `Provenance blob hash mismatch: expected ${sha256}, got ${actualSha256}` }),
    };
  }

  private normalizeNotebookPath(notebookPath: string): string {
    if (typeof notebookPath !== 'string' || notebookPath.trim().length === 0) {
      throw new TypeError('Notebook path must be a non-empty string');
    }
    return path.resolve(notebookPath);
  }

  private normalizeInput(input: ProvenanceEventInput): ProvenanceEventInput {
    if (!input || typeof input !== 'object') {
      throw new TypeError('Provenance event input must be an object');
    }
    if (typeof input.type !== 'string' || input.type.trim().length === 0) {
      throw new TypeError('Provenance event type must be a non-empty string');
    }
    if (!input.actor || typeof input.actor !== 'object') {
      throw new TypeError('Provenance actor is required');
    }
    if (typeof input.actor.kind !== 'string' || input.actor.kind.trim().length === 0) {
      throw new TypeError('Provenance actor kind must be a non-empty string');
    }
    if (input.idempotencyKey !== undefined && input.idempotencyKey.length === 0) {
      throw new TypeError('Idempotency key must be a non-empty string');
    }
    if (input.inputManifestSha256 !== undefined) {
      this.assertSha256(input.inputManifestSha256, 'input manifest sha256');
    }
    if (input.environmentManifestSha256 !== undefined) {
      this.assertSha256(input.environmentManifestSha256, 'environment manifest sha256');
    }

    // Canonical round-tripping both validates the full input as JSON and
    // detaches it from caller-owned mutable objects before any await point.
    const actor = this.canonicalClone(input.actor) as ProvenanceActor;
    const payload = input.payload === undefined
      ? undefined
      : this.canonicalClone(input.payload);
    const normalized: ProvenanceEventInput = {
      type: input.type,
      actor,
      ...(payload !== undefined ? { payload } : {}),
    };
    for (const key of [
      'runId',
      'taskId',
      'sourceId',
      'executionId',
      'inputManifestSha256',
      'environmentManifestSha256',
      'idempotencyKey',
    ] as const) {
      const value = input[key];
      if (value !== undefined) {
        if (typeof value !== 'string') {
          throw new TypeError(`${key} must be a string`);
        }
        normalized[key] = value;
      }
    }
    return normalized;
  }

  private canonicalClone<T>(value: T): T {
    return JSON.parse(canonicalJson(value)) as T;
  }

  private hashRequest(notebookPath: string, input: ProvenanceEventInput): string {
    return sha256Canonical(this.requestEnvelope(notebookPath, input));
  }

  private requestEnvelope(
    notebookPath: string,
    input: ProvenanceEventInput,
  ): Record<string, unknown> {
    return {
      notebookPath,
      type: input.type,
      actor: input.actor,
      payload: input.payload ?? null,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
      ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
      ...(input.inputManifestSha256 !== undefined
        ? { inputManifestSha256: input.inputManifestSha256 }
        : {}),
      ...(input.environmentManifestSha256 !== undefined
        ? { environmentManifestSha256: input.environmentManifestSha256 }
        : {}),
    };
  }

  private inputFromEvent(event: ProvenanceEvent): ProvenanceEventInput {
    return {
      type: event.type,
      actor: event.actor,
      payload: event.payload,
      ...(event.runId !== undefined ? { runId: event.runId } : {}),
      ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
      ...(event.sourceId !== undefined ? { sourceId: event.sourceId } : {}),
      ...(event.executionId !== undefined ? { executionId: event.executionId } : {}),
      ...(event.inputManifestSha256 !== undefined
        ? { inputManifestSha256: event.inputManifestSha256 }
        : {}),
      ...(event.environmentManifestSha256 !== undefined
        ? { environmentManifestSha256: event.environmentManifestSha256 }
        : {}),
      ...(event.idempotencyKey !== undefined ? { idempotencyKey: event.idempotencyKey } : {}),
    };
  }

  private async readVerified(notebookPath: string): Promise<ProvenanceEvent[]> {
    const ledgerPath = this.getLedgerPath(notebookPath);
    let raw: string;
    try {
      raw = await fsp.readFile(ledgerPath, 'utf8');
    } catch (error) {
      if (this.isNodeError(error, 'ENOENT')) return [];
      throw error;
    }
    if (raw.length === 0) return [];

    const lines = raw.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const events: ProvenanceEvent[] = [];
    const eventIds = new Set<string>();
    const idempotencyKeys = new Set<string>();

    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = lines[index];
      if (line.trim().length === 0) {
        throw new ProvenanceIntegrityError('Blank line in provenance ledger', lineNumber);
      }

      let record: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('event is not an object');
        }
        record = parsed as Record<string, unknown>;
      } catch (error) {
        throw new ProvenanceIntegrityError(
          `Invalid provenance JSON at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
          lineNumber,
        );
      }

      const event = record as unknown as ProvenanceEvent;
      this.validateEventShape(event, notebookPath, lineNumber);

      const expectedSeq = index + 1;
      if (event.seq !== expectedSeq) {
        throw new ProvenanceIntegrityError(
          `Invalid provenance sequence at line ${lineNumber}: expected ${expectedSeq}, got ${event.seq}`,
          lineNumber,
        );
      }
      const expectedPrevHash = events.at(-1)?.eventHash ?? null;
      if (event.prevHash !== expectedPrevHash) {
        throw new ProvenanceIntegrityError(
          `Invalid previous event hash at line ${lineNumber}`,
          lineNumber,
        );
      }

      const { eventHash, ...unsignedEvent } = record;
      let actualEventHash: string;
      try {
        actualEventHash = sha256Canonical(unsignedEvent);
      } catch (error) {
        throw new ProvenanceIntegrityError(
          `Invalid canonical event at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
          lineNumber,
        );
      }
      if (actualEventHash !== eventHash) {
        throw new ProvenanceIntegrityError(
          `Invalid event hash at line ${lineNumber}: expected ${String(eventHash)}, got ${actualEventHash}`,
          lineNumber,
        );
      }

      if (eventIds.has(event.eventId)) {
        throw new ProvenanceIntegrityError(
          `Duplicate provenance event id at line ${lineNumber}: ${event.eventId}`,
          lineNumber,
        );
      }
      eventIds.add(event.eventId);

      if (event.idempotencyKey !== undefined) {
        if (idempotencyKeys.has(event.idempotencyKey)) {
          throw new ProvenanceIntegrityError(
            `Duplicate idempotency key at line ${lineNumber}: ${event.idempotencyKey}`,
            lineNumber,
          );
        }
        idempotencyKeys.add(event.idempotencyKey);
        const requestHash = this.hashRequest(notebookPath, this.inputFromEvent(event));
        if (event.idempotencyRequestHash !== requestHash) {
          throw new ProvenanceIntegrityError(
            `Invalid idempotency request hash at line ${lineNumber}`,
            lineNumber,
          );
        }
      } else if (event.idempotencyRequestHash !== undefined) {
        throw new ProvenanceIntegrityError(
          `Idempotency request hash has no key at line ${lineNumber}`,
          lineNumber,
        );
      }

      events.push(event);
    }
    return events;
  }

  private validateEventShape(
    event: ProvenanceEvent,
    notebookPath: string,
    lineNumber: number,
  ): void {
    const fail = (message: string): never => {
      throw new ProvenanceIntegrityError(`${message} at line ${lineNumber}`, lineNumber);
    };
    if (event.schemaVersion !== 1) fail('Unsupported provenance schema version');
    if (typeof event.eventId !== 'string' || event.eventId.length === 0) fail('Invalid event id');
    if (!Number.isSafeInteger(event.seq) || event.seq < 1) fail('Invalid event sequence');
    if (typeof event.timestamp !== 'string' || Number.isNaN(Date.parse(event.timestamp))) fail('Invalid event timestamp');
    if (event.notebookPath !== notebookPath) fail('Provenance notebook path mismatch');
    if (typeof event.type !== 'string' || event.type.length === 0) fail('Invalid event type');
    if (!event.actor || typeof event.actor !== 'object' || typeof event.actor.kind !== 'string' || event.actor.kind.length === 0) {
      fail('Invalid provenance actor');
    }
    if (!('payload' in event)) fail('Missing event payload');
    if (event.prevHash !== null && !SHA256_RE.test(event.prevHash)) fail('Invalid previous event hash');
    if (typeof event.eventHash !== 'string' || !SHA256_RE.test(event.eventHash)) fail('Invalid event hash');
    if (event.inputManifestSha256 !== undefined && !SHA256_RE.test(event.inputManifestSha256)) {
      fail('Invalid input manifest hash');
    }
    if (event.environmentManifestSha256 !== undefined && !SHA256_RE.test(event.environmentManifestSha256)) {
      fail('Invalid environment manifest hash');
    }
    if (event.idempotencyKey !== undefined && (typeof event.idempotencyKey !== 'string' || event.idempotencyKey.length === 0)) {
      fail('Invalid idempotency key');
    }
    if (event.idempotencyRequestHash !== undefined && !SHA256_RE.test(event.idempotencyRequestHash)) {
      fail('Invalid idempotency request hash');
    }
  }

  private async appendLine(ledgerPath: string, line: string): Promise<void> {
    const directory = path.dirname(ledgerPath);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    // A complete final JSON value without a trailing newline is valid JSONL.
    // Preserve append-only semantics while restoring the separator before the
    // next event; otherwise two individually valid events would concatenate.
    const prefix = await this.ledgerNeedsNewline(ledgerPath) ? '\n' : '';
    const handle = await fsp.open(ledgerPath, 'a', 0o600);
    try {
      await handle.appendFile(`${prefix}${line}`, 'utf8');
      if (this.durable) await handle.sync();
    } finally {
      await handle.close();
    }
    if (this.durable) await this.syncDirectory(directory);
  }

  private async ledgerNeedsNewline(ledgerPath: string): Promise<boolean> {
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(ledgerPath, 'r');
    } catch (error) {
      if (this.isNodeError(error, 'ENOENT')) return false;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (stat.size === 0) return false;
      const lastByte = Buffer.alloc(1);
      const { bytesRead } = await handle.read(lastByte, 0, 1, stat.size - 1);
      return bytesRead === 1 && lastByte[0] !== 0x0a;
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    try {
      const handle = await fsp.open(directory, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Directory fsync is unsupported on some filesystems/platforms. The
      // file itself has still been fsynced.
    }
  }

  private async readIfExists(filePath: string): Promise<Buffer | null> {
    try {
      return await fsp.readFile(filePath);
    } catch (error) {
      if (this.isNodeError(error, 'ENOENT')) return null;
      throw error;
    }
  }

  private assertBlobBytes(bytes: Buffer, expectedSha256: string, blobPath: string): void {
    const actualSha256 = sha256Hex(bytes);
    if (actualSha256 !== expectedSha256) {
      throw new BlobIntegrityError(
        `Provenance blob hash mismatch at ${blobPath}: expected ${expectedSha256}, got ${actualSha256}`,
      );
    }
  }

  private toBuffer(value: string | Buffer | Uint8Array): Buffer {
    if (typeof value === 'string') return Buffer.from(value, 'utf8');
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof Uint8Array) return Buffer.from(value);
    throw new TypeError('Provenance blob must be a string, Buffer, or Uint8Array');
  }

  private assertSha256(value: string, label: string): void {
    if (typeof value !== 'string' || !SHA256_RE.test(value)) {
      throw new TypeError(`${label} must be a lowercase 64-character SHA-256 hex digest`);
    }
  }

  private runSerialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = ProvenanceStore.writeQueues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    ProvenanceStore.writeQueues.set(key, tail);
    return run.finally(() => {
      if (ProvenanceStore.writeQueues.get(key) === tail) {
        ProvenanceStore.writeQueues.delete(key);
      }
    });
  }

  private isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
  }
}

export type {
  ProvenanceActor,
  ProvenanceAppendResult,
  ProvenanceBlobReference,
  ProvenanceBlobVerification,
  ProvenanceEvent,
  ProvenanceEventInput,
  ProvenanceVerification,
} from './types';
