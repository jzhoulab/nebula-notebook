import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fsService } from '../fs/fs-service';
import {
  ReplaySealConflictError,
  ReplaySealService,
  ReplaySealValidationError,
  type ReplaySealRequest,
  type ReplaySealStatusResponse,
} from '../provenance/replay-seal-service';
import { ProvenanceStore } from '../provenance/provenance-store';
import { kernelService } from './kernel';

export interface ReplaySealRouteService {
  submit(request: ReplaySealRequest, idempotencyKey: string): Promise<ReplaySealStatusResponse>;
  getStatus(sealId: string): Promise<ReplaySealStatusResponse | null>;
}

let productionService: ReplaySealService | undefined;

function getProductionService(): ReplaySealService {
  productionService ??= new ReplaySealService({
    rootDirectory: fsService.getRootDirectory(),
    kernelService,
    provenanceStore: new ProvenanceStore(),
  });
  return productionService;
}

function errorResponse(reply: FastifyReply, error: unknown): FastifyReply {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (error instanceof ReplaySealConflictError || code === 'IDEMPOTENCY_CONFLICT') {
    return reply.code(409).send({ detail: message, code: 'idempotency_conflict' });
  }
  if (error instanceof ReplaySealValidationError || code === 'REPLAY_SEAL_VALIDATION_ERROR') {
    return reply.code(400).send({ detail: message, code: 'invalid_replay_seal_request' });
  }
  return reply.code(500).send({ detail: message });
}

/** Build the protected KOSMOS replay/seal routes with an injectable service. */
export function createReplaySealRoutes(service: ReplaySealRouteService) {
  return async function replaySealRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.post(
      '/notebook/replay-seal',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const header = request.headers['idempotency-key'];
        const idempotencyKey = Array.isArray(header) ? header[0] : header;
        if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
          return reply.code(400).send({ detail: 'Idempotency-Key header is required' });
        }
        try {
          const status = await service.submit(request.body as ReplaySealRequest, idempotencyKey);
          return reply.code(status.status === 'pending' || status.status === 'running' ? 202 : 200)
            .send(status);
        } catch (error) {
          return errorResponse(reply, error);
        }
      },
    );

    fastify.get(
      '/notebook/replay-seal/:sealId',
      async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const sealId = (request.params as { sealId?: unknown }).sealId;
          if (typeof sealId !== 'string' || sealId.length === 0) {
            return reply.code(400).send({ detail: 'sealId is required' });
          }
          const status = await service.getStatus(sealId);
          if (!status) return reply.code(404).send({ detail: `Replay seal not found: ${sealId}` });
          return reply.send(status);
        } catch (error) {
          return errorResponse(reply, error);
        }
      },
    );
  };
}

export default async function replaySealRoutes(fastify: FastifyInstance): Promise<void> {
  await createReplaySealRoutes(getProductionService())(fastify);
}
