// @vitest-environment node
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { createSessionExecutionRoutes } from '../routes/session-execution';

it('requires idempotency keys and distinguishes pending, completed, unknown and conflicting requests', async () => {
  const service = {
    open: vi.fn(async () => ({ session_id: 'fixture', status: 'opening' })),
    session: vi.fn(async () => null),
    execute: vi.fn(async () => ({
      operation_id: 'fixture',
      status: 'pending',
    })),
    operation: vi.fn(async () => ({
      operation_id: 'fixture',
      status: 'completed',
      receipt: { fixture: true },
    })),
  };
  const app = Fastify();
  await app.register(createSessionExecutionRoutes(service as never), {
    prefix: '/api',
  });
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/notebook/execution-sessions',
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(service.open).not.toHaveBeenCalled();
    const post = {
      method: 'POST' as const,
      url: '/api/notebook/execution-operations',
      headers: { 'idempotency-key': 'fixture' },
      payload: { code: 'x' },
    };
    expect((await app.inject(post)).statusCode).toBe(202);
    expect(service.execute).toHaveBeenCalledWith({ code: 'x' }, 'fixture');
    expect(
      (await app.inject('/api/notebook/execution-operations/fixture')).json()
        .status,
    ).toBe('completed');
    expect(
      (await app.inject('/api/notebook/execution-sessions/missing')).statusCode,
    ).toBe(404);
    service.execute.mockRejectedValueOnce(
      Object.assign(new Error('different request'), { code: 'conflict' }),
    );
    expect((await app.inject(post)).statusCode).toBe(409);
  } finally {
    await app.close();
  }
});
