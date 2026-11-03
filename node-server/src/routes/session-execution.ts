import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  ExecuteSessionRequest,
  OpenSessionRequest,
  SessionExecutionService,
} from '../provenance/session-execution-service';

type Service = Pick<
  SessionExecutionService,
  'open' | 'execute' | 'session' | 'operation'
>;
function failure(reply: FastifyReply, error: unknown) {
  const code =
    error && typeof error === 'object'
      ? (error as { code?: string }).code
      : undefined;
  return reply
    .code(code === 'conflict' ? 409 : code === 'invalid_request' ? 400 : 500)
    .send({
      code: code || 'session_execution_error',
      detail:
        error instanceof Error ? error.message : 'Session execution failed',
    });
}

/** Registered beneath the same authentication hook as ordinary notebook routes. */
export function createSessionExecutionRoutes(service: Service) {
  return async function routes(app: FastifyInstance) {
    for (const [resource, action] of [
      ['execution-sessions', 'open'],
      ['execution-operations', 'execute'],
    ] as const) {
      app.post('/notebook/' + resource, async (request, reply) => {
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || !key)
          return reply
            .code(400)
            .send({ detail: 'Idempotency-Key header is required' });
        try {
          const result =
            action === 'open'
              ? await service.open(request.body as OpenSessionRequest, key)
              : await service.execute(
                  request.body as ExecuteSessionRequest,
                  key,
                );
          return reply
            .code(
              ['opening', 'pending', 'running'].includes(result.status)
                ? 202
                : 200,
            )
            .send(result);
        } catch (error) {
          return failure(reply, error);
        }
      });
    }
    for (const [resource, action] of [
      ['execution-sessions', 'session'],
      ['execution-operations', 'operation'],
    ] as const) {
      app.get('/notebook/' + resource + '/:id', async (request, reply) => {
        try {
          const result = await service[action](
            (request.params as { id: string }).id,
          );
          return result
            ? reply.send(result)
            : reply.code(404).send({ detail: 'Receipt not found' });
        } catch (error) {
          return failure(reply, error);
        }
      });
    }
  };
}

let production: SessionExecutionService | undefined;
export default async function sessionExecutionRoutes(app: FastifyInstance) {
  // Lazily initialize the receipt store on first use, not on every server boot.
  async function service(): Promise<SessionExecutionService> {
    if (!production) {
      const [{ SessionExecutionService }, { fsService }, { kernelService }] =
        await Promise.all([
          import('../provenance/session-execution-service'),
          import('../fs/fs-service'),
          import('./kernel'),
        ]);
      production ??= new SessionExecutionService({
        rootDirectory: fsService.getRootDirectory(),
        kernelService,
      });
    }
    return production;
  }
  await createSessionExecutionRoutes({
    open: async (request, key) => (await service()).open(request, key),
    execute: async (request, key) => (await service()).execute(request, key),
    session: async (id) => (await service()).session(id),
    operation: async (id) => (await service()).operation(id),
  })(app);
}
