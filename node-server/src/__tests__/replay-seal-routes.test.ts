// @vitest-environment node

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReplaySealRoutes } from '../routes/replay-seal';

const sealRequest = {
  notebook_path: '/workspace/analysis.ipynb',
  run_id: 'run-42',
  task_id: 'task-hypothermia',
  source_id: 'kosmos',
  source_notebook_sha256: '9'.repeat(64),
  artifacts: [{
    path: '/workspace/result.csv',
    sha256: 'a'.repeat(64),
    size_bytes: 42,
  }],
  kernel_name: 'python3',
  input_manifest: {
    dataset: {
      path: '/workspace/data.csv',
      sha256: '1'.repeat(64),
    },
  },
  environment_manifest: {
    python: '3.12',
  },
};

const completedManifest = {
  schema_version: 1,
  hash_profile: 'nebula-canonical-hash-v1',
  seal_id: 'seal-123',
  notebook: {
    path: '/workspace/.nebula/seals/seal-123/notebook.ipynb',
    sha256: '2'.repeat(64),
  },
  input_manifest_sha256: '3'.repeat(64),
  environment_manifest_sha256: '4'.repeat(64),
  event_chain_head_sha256: '5'.repeat(64),
  cells: [
    {
      cell_id: 'analysis-1',
      source_sha256: '6'.repeat(64),
      outputs_sha256: '7'.repeat(64),
      execution_id: 'execution-1',
      execution_count: 1,
      status: 'completed',
    },
  ],
  artifacts: [],
  manifest_sha256: '8'.repeat(64),
};

type SealStatus =
  | { seal_id: string; status: 'pending' | 'running' }
  | { seal_id: string; status: 'completed'; manifest: typeof completedManifest }
  | { seal_id: string; status: 'failed'; error: string };

interface FakeReplaySealService {
  submit: ReturnType<typeof vi.fn<(request: typeof sealRequest, idempotencyKey: string) => Promise<SealStatus>>>;
  getStatus: ReturnType<typeof vi.fn<(sealId: string) => Promise<SealStatus | null>>>;
}

describe('KOSMOS replay-seal HTTP contract', () => {
  let app: FastifyInstance;
  let service: FakeReplaySealService;

  beforeEach(async () => {
    service = {
      submit: vi.fn(),
      getStatus: vi.fn(),
    };

    app = Fastify();
    await app.register(createReplaySealRoutes(service as never), { prefix: '/api' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires an Idempotency-Key before submitting work', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/notebook/replay-seal',
      payload: sealRequest,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      detail: expect.stringMatching(/Idempotency-Key/i),
    });
    expect(service.submit).not.toHaveBeenCalled();
  });

  it('accepts a new replay job with the exact KOSMOS request body', async () => {
    service.submit.mockResolvedValue({ seal_id: 'seal-123', status: 'pending' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/notebook/replay-seal',
      headers: { 'idempotency-key': 'kosmos-run-42' },
      payload: sealRequest,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ seal_id: 'seal-123', status: 'pending' });
    expect(service.submit).toHaveBeenCalledOnce();
    expect(service.submit).toHaveBeenCalledWith(sealRequest, 'kosmos-run-42');
  });

  it('returns 200 when a duplicate submission has already completed', async () => {
    service.submit
      .mockResolvedValueOnce({ seal_id: 'seal-123', status: 'pending' })
      .mockResolvedValueOnce({
        seal_id: 'seal-123',
        status: 'completed',
        manifest: completedManifest,
      });

    const request = {
      method: 'POST' as const,
      url: '/api/notebook/replay-seal',
      headers: { 'idempotency-key': 'kosmos-run-42' },
      payload: sealRequest,
    };

    expect((await app.inject(request)).statusCode).toBe(202);

    const duplicate = await app.inject(request);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({
      seal_id: 'seal-123',
      status: 'completed',
      manifest: completedManifest,
    });
  });

  it('returns the completed status and manifest from the polling endpoint', async () => {
    service.getStatus.mockResolvedValue({
      seal_id: 'seal-123',
      status: 'completed',
      manifest: completedManifest,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/notebook/replay-seal/seal-123',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      seal_id: 'seal-123',
      status: 'completed',
      manifest: completedManifest,
    });
    expect(service.getStatus).toHaveBeenCalledWith('seal-123');
  });

  it('returns 404 for an unknown seal id', async () => {
    service.getStatus.mockResolvedValue(null);

    const response = await app.inject({
      method: 'GET',
      url: '/api/notebook/replay-seal/missing-seal',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ detail: expect.any(String) });
  });

  it('maps an idempotency-key request conflict to 409', async () => {
    const conflict = Object.assign(
      new Error('Idempotency-Key was already used with a different request'),
      {
        name: 'ReplaySealConflictError',
        code: 'IDEMPOTENCY_CONFLICT',
      },
    );
    service.submit.mockRejectedValue(conflict);

    const response = await app.inject({
      method: 'POST',
      url: '/api/notebook/replay-seal',
      headers: { 'idempotency-key': 'kosmos-run-42' },
      payload: { ...sealRequest, task_id: 'different-task' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      detail: expect.stringMatching(/different request|Idempotency-Key/i),
    });
  });
});
