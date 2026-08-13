// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  CANONICAL_HASH_PROFILE,
  canonicalJson,
  canonicalizeForHash,
  hashCanonicalJson,
  sha256Canonical,
  sha256Hex,
} from '../provenance/canonical-json';
import {
  BlobIntegrityError,
  IdempotencyConflictError,
  ProvenanceIntegrityError,
  ProvenanceStore,
} from '../provenance/provenance-store';

describe('canonical provenance hashing', () => {
  it('canonicalizes nested objects while preserving array order', () => {
    const left = {
      z: 2,
      a: { y: true, x: ['second', { b: null, a: 1 }] },
    };
    const right = {
      a: { x: ['second', { a: 1, b: null }], y: true },
      z: 2,
    };

    expect(canonicalJson(left)).toBe(
      '{"a":{"x":["second",{"a":1,"b":null}],"y":true},"z":2}',
    );
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(sha256Canonical(left)).toBe(sha256Canonical(right));
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('rejects values that do not have an unambiguous JSON representation', () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/i);
    expect(() => canonicalJson({ number: Number.POSITIVE_INFINITY })).toThrow(/finite/i);
    expect(() => canonicalJson(new Date())).toThrow(/plain object/i);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/i);
  });

  it('uses the documented cross-runtime typed hash profile', () => {
    expect(CANONICAL_HASH_PROFILE).toBe('nebula-canonical-hash-v1');
    expect(hashCanonicalJson(null)).toBe(
      '["nebula-canonical-hash-v1",["null"]]',
    );
    expect(sha256Canonical(null)).toBe(
      'd5c3437d5b7d0d2124359304dea956669a5003b06b3307b712a610f1308d8907',
    );

    const numbers = {
      small: 1e-7,
      threshold: 1e-6,
      large: 1e20,
      negativeZero: -0,
      integer: 42,
    };
    expect(hashCanonicalJson(numbers)).toBe(
      '["nebula-canonical-hash-v1",["object",[["integer",["integer",42]],["large",["float64","4415af1d78b58c40"]],["negativeZero",["float64","8000000000000000"]],["small",["float64","3e7ad7f29abcaf48"]],["threshold",["float64","3eb0c6f7a0b5ed8d"]]]]]',
    );
    expect(sha256Canonical(numbers)).toBe(
      '7bff2700cf69ef536d981bf5dc1d177946e4d1939ab99143b60f057509b2cff5',
    );

    const arrayVector = [false, true, 'snowman ☃', 0.1, Number.MIN_VALUE];
    expect(sha256Canonical(arrayVector)).toBe(
      '6eddba7a96acf4fda063c70d98bb2947415518a800bae38965a7c93741a0d9ec',
    );
  });

  it('sorts hash-profile object keys by Unicode code point, not UTF-16 code unit', () => {
    const value = {
      '\u{10000}': 'astral',
      '\uE000': 'bmp',
      A: 'latin',
      '\u0001': 'control',
    };

    expect(canonicalizeForHash(value)).toEqual([
      'nebula-canonical-hash-v1',
      ['object', [
        ['\u0001', ['string', 'control']],
        ['A', ['string', 'latin']],
        ['\uE000', ['string', 'bmp']],
        ['\u{10000}', ['string', 'astral']],
      ]],
    ]);
    expect(sha256Canonical(value)).toBe(
      '4abf4e94052f813fa584b0e1dfba4985b57ad5f82e8195a31becd34d7f1497a5',
    );
  });

  it('keeps the typed hash encoding injective and rejects invalid Unicode scalars', () => {
    expect(sha256Canonical(0.5)).not.toBe(
      sha256Canonical({ float64: '3fe0000000000000' }),
    );
    expect(sha256Canonical(1)).toBe(sha256Canonical(1.0));
    expect(sha256Canonical(-0)).not.toBe(sha256Canonical(0));
    expect(() => sha256Canonical('\uD800')).toThrow(/unicode scalar/i);
    expect(() => sha256Canonical({ '\uDC00': 'invalid key' })).toThrow(/unicode scalar/i);
  });
});

describe('ProvenanceStore', () => {
  let testDir: string;
  let notebookPath: string;
  let nextId: number;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-provenance-'));
    notebookPath = path.join(testDir, 'analysis.ipynb');
    nextId = 0;
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const makeStore = () => new ProvenanceStore({
    durable: false,
    clock: () => new Date('2026-08-12T12:00:00.000Z'),
    idFactory: () => `event-${++nextId}`,
  });

  it('appends canonical JSONL events with a monotonic hash chain', async () => {
    const store = makeStore();
    const first = await store.append(notebookPath, {
      type: 'notebook.created',
      actor: { kind: 'system', id: 'nebula' },
      payload: { kernel: 'python3' },
    });
    const second = await store.append(notebookPath, {
      type: 'cell.executed',
      actor: { kind: 'agent', id: 'kosmos-rollout-1' },
      runId: 'run-1',
      taskId: 'task-1',
      sourceId: 'source-1',
      executionId: 'execution-1',
      inputManifestSha256: sha256Hex('inputs'),
      environmentManifestSha256: sha256Hex('environment'),
      payload: {
        sourceSha256: sha256Hex('print(1)'),
        outputsSha256: sha256Canonical([{ type: 'stdout', content: '1\n' }]),
      },
    });

    expect(first.appended).toBe(true);
    expect(first.event).toMatchObject({
      schemaVersion: 1,
      eventId: 'event-1',
      seq: 1,
      notebookPath,
      prevHash: null,
    });
    expect(first.event.eventHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.event.seq).toBe(2);
    expect(second.event.prevHash).toBe(first.event.eventHash);

    const lines = fs.readFileSync(store.getLedgerPath(notebookPath), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(canonicalJson(JSON.parse(lines[0])));

    const verification = await store.verify(notebookPath);
    expect(verification).toEqual({
      valid: true,
      eventCount: 2,
      lastSeq: 2,
      headHash: second.event.eventHash,
    });
    expect(await store.read(notebookPath)).toEqual([first.event, second.event]);
  });

  it('continues the sequence after constructing a new store', async () => {
    const firstStore = makeStore();
    const first = await firstStore.append(notebookPath, {
      type: 'first',
      actor: { kind: 'system' },
    });

    const secondStore = makeStore();
    const second = await secondStore.append(notebookPath, {
      type: 'second',
      actor: { kind: 'system' },
    });

    expect(second.event.seq).toBe(2);
    expect(second.event.prevHash).toBe(first.event.eventHash);
  });

  it('repairs a complete JSONL tail that is missing only its final newline', async () => {
    const store = makeStore();
    await store.append(notebookPath, {
      type: 'first',
      actor: { kind: 'system' },
    });
    const ledgerPath = store.getLedgerPath(notebookPath);
    fs.writeFileSync(ledgerPath, fs.readFileSync(ledgerPath, 'utf8').trimEnd());

    await store.append(notebookPath, {
      type: 'second',
      actor: { kind: 'system' },
    });

    expect((await store.read(notebookPath)).map((event) => event.seq)).toEqual([1, 2]);
    expect(fs.readFileSync(ledgerPath, 'utf8')).toMatch(/\n$/);
  });

  it('serializes concurrent appends without duplicate or skipped sequences', async () => {
    const store = makeStore();
    await Promise.all(
      Array.from({ length: 40 }, (_, index) => store.append(notebookPath, {
        type: 'concurrent.event',
        actor: { kind: 'agent', id: `agent-${index}` },
        payload: { index },
      })),
    );

    const events = await store.read(notebookPath);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index].prevHash).toBe(events[index - 1].eventHash);
    }
    expect((await store.verify(notebookPath)).valid).toBe(true);
  });

  it('detects semantic tampering and refuses to extend a corrupt chain', async () => {
    const store = makeStore();
    await store.append(notebookPath, {
      type: 'cell.executed',
      actor: { kind: 'agent', id: 'kosmos' },
      payload: { result: 1 },
    });

    const ledgerPath = store.getLedgerPath(notebookPath);
    const tampered = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    tampered.payload.result = 2;
    fs.writeFileSync(ledgerPath, `${JSON.stringify(tampered)}\n`);

    const verification = await store.verify(notebookPath);
    expect(verification.valid).toBe(false);
    expect(verification.error).toMatch(/event hash/i);
    await expect(store.read(notebookPath)).rejects.toBeInstanceOf(ProvenanceIntegrityError);
    await expect(store.append(notebookPath, {
      type: 'must-not-append',
      actor: { kind: 'system' },
    })).rejects.toBeInstanceOf(ProvenanceIntegrityError);
    expect(fs.readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('deduplicates identical idempotent appends and rejects key reuse with different input', async () => {
    const store = makeStore();
    const input = {
      type: 'seal.started',
      actor: { kind: 'agent', id: 'kosmos' },
      runId: 'run-1',
      payload: { notebookSha256: sha256Hex('notebook') },
      idempotencyKey: 'seal:run-1',
    } as const;

    const first = await store.append(notebookPath, input);
    const repeated = await store.append(notebookPath, input);

    expect(repeated.appended).toBe(false);
    expect(repeated.event).toEqual(first.event);
    expect(await store.findByIdempotencyKey(notebookPath, 'seal:run-1')).toEqual(first.event);
    expect(await store.read(notebookPath)).toHaveLength(1);

    await expect(store.append(notebookPath, {
      ...input,
      payload: { notebookSha256: sha256Hex('different notebook') },
    })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('stores blobs by content hash, deduplicates them, and verifies reads', async () => {
    const store = makeStore();
    const content = Buffer.from('complete rich output\n', 'utf8');

    const first = await store.putBlob(notebookPath, content);
    const repeated = await store.putBlob(notebookPath, new Uint8Array(content));

    expect(first).toEqual({ sha256: sha256Hex(content), sizeBytes: content.length });
    expect(repeated).toEqual(first);
    expect(await store.readBlob(notebookPath, first.sha256)).toEqual(content);
    expect(await store.verifyBlob(notebookPath, first.sha256)).toEqual({
      valid: true,
      expectedSha256: first.sha256,
      actualSha256: first.sha256,
      sizeBytes: content.length,
    });

    await fsp.writeFile(store.getBlobPath(notebookPath, first.sha256), 'tampered');
    const corrupt = await store.verifyBlob(notebookPath, first.sha256);
    expect(corrupt.valid).toBe(false);
    expect(corrupt.actualSha256).toBe(sha256Hex('tampered'));
    await expect(store.readBlob(notebookPath, first.sha256)).rejects.toBeInstanceOf(BlobIntegrityError);
    await expect(store.putBlob(notebookPath, content)).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it('reports missing ledgers and blobs without manufacturing state', async () => {
    const store = makeStore();
    expect(await store.read(notebookPath)).toEqual([]);
    expect(await store.verify(notebookPath)).toEqual({
      valid: true,
      eventCount: 0,
      lastSeq: 0,
      headHash: null,
    });
    expect(await store.findByIdempotencyKey(notebookPath, 'missing')).toBeNull();

    const missingHash = sha256Hex('missing');
    expect(await store.verifyBlob(notebookPath, missingHash)).toMatchObject({
      valid: false,
      expectedSha256: missingHash,
      error: expect.stringMatching(/not found/i),
    });
    await expect(store.readBlob(notebookPath, missingHash)).rejects.toBeInstanceOf(BlobIntegrityError);
  });
});
