/**
 * Compute allocation API — submit and manage scheduler-backed compute.
 *
 * All routes live under /api/compute and are auth-protected like the rest of the
 * API. They are no-ops (return `enabled: false`) when no scheduler is detected.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as os from 'os';
import { allocationService } from '../scheduler/allocation-service';
import type { JobSpec } from '../scheduler/types';
import { buildArmSetupPrompt, gatherArmSetupFacts } from '../scheduler/arm-setup-prompt';

function currentUser(): string {
  return process.env.USER || process.env.LOGNAME || os.userInfo().username;
}

/** Build a JobSpec from request input, applying MVP defaults. */
function parseSpec(x: any): JobSpec {
  const partition = String(x?.partition || '').trim();
  const qos = x?.qos ? String(x.qos).trim() : undefined;
  const account = x?.account ? String(x.account).trim() : undefined;
  const cpus = Math.max(1, Math.floor(Number(x?.cpus) || 1));
  const memGb = Math.max(1, Math.floor(Number(x?.memGb) || 4));
  const gpusRaw = Math.floor(Number(x?.gpus) || 0);
  const gpus = gpusRaw > 0 ? gpusRaw : undefined;
  const gpuType = gpus && x?.gpuType ? String(x.gpuType).trim() || undefined : undefined;
  const walltimeMinutes = Math.max(1, Math.floor(Number(x?.walltimeMinutes) || 120));
  // Opt-in idle auto-release (minutes). Absent/invalid/<=0 = disabled.
  const idleRaw = Math.floor(Number(x?.idleTimeoutMinutes) || 0);
  const idleTimeoutMinutes = idleRaw > 0 ? idleRaw : undefined;
  const jobName = (x?.jobName ? String(x.jobName) : `nebula-${partition || 'compute'}`)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 60) || 'nebula';
  return { partition, qos, account, cpus, memGb, gpus, gpuType, walltimeMinutes, jobName, idleTimeoutMinutes };
}

export default async function computeRoutes(fastify: FastifyInstance) {
  /** Whether scheduler-backed compute is available on this server. */
  fastify.get('/compute/status', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      enabled: allocationService.isEnabled(),
      scheduler: allocationService.getScheduler()?.name ?? null,
    });
  });

  /** Allowed partitions/QoS for the current user + a live load snapshot. */
  fastify.get('/compute/partitions', async (_req: FastifyRequest, reply: FastifyReply) => {
    const sched = allocationService.getScheduler();
    if (!sched) return reply.send({ enabled: false, associations: null, load: null });
    const [associations, load] = await Promise.all([
      sched.associations(currentUser()).catch(() => null),
      sched.load().catch(() => null),
    ]);
    return reply.send({ enabled: true, associations, load });
  });

  /** QoS names a partition will accept (null = any). Drives the modal's QoS filter. */
  fastify.get('/compute/partition-qos', async (req: FastifyRequest, reply: FastifyReply) => {
    const sched = allocationService.getScheduler();
    if (!sched) return reply.send({ allowed: null });
    const partition = String((req.query as any)?.partition || '').trim();
    if (!partition) return reply.send({ allowed: null });
    const allowed = await sched.allowedQos(partition).catch(() => null);
    return reply.send({ allowed });
  });

  /** Dry-run estimated start time for a prospective allocation. */
  fastify.get('/compute/estimate', async (req: FastifyRequest, reply: FastifyReply) => {
    const sched = allocationService.getScheduler();
    if (!sched) return reply.code(400).send({ error: 'scheduler not available' });
    const spec = parseSpec(req.query);
    if (!spec.partition) return reply.code(400).send({ error: 'partition is required' });
    const estimate = await sched.estimateStart(spec);
    return reply.send(estimate);
  });

  /**
   * Agent-executable ARM setup: this installation's facts + a rendered prompt
   * the user pastes to an agent. configured=true means an arm64 runtime is
   * already wired in (the UI then shows nothing).
   */
  fastify.get('/compute/arm-setup', async (_req: FastifyRequest, reply: FastifyReply) => {
    const sched = allocationService.getScheduler();
    const ctx = allocationService.getLaunchContext();
    if (!sched || !ctx) return reply.code(400).send({ error: 'scheduler not available' });
    const facts = await gatherArmSetupFacts(sched, ctx);
    return reply.send({ configured: facts.configured, prompt: buildArmSetupPrompt(facts), facts });
  });

  /** List current allocations (pending / running / active / ended). */
  fastify.get('/compute/allocations', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ allocations: allocationService.list() });
  });

  /** Submit a new compute allocation. */
  fastify.post('/compute/allocations', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!allocationService.isEnabled()) {
      return reply.code(400).send({ error: 'scheduler not available' });
    }
    const spec = parseSpec(req.body);
    if (!spec.partition) return reply.code(400).send({ error: 'partition is required' });
    try {
      const alloc = await allocationService.create(spec);
      return reply.send(alloc);
    } catch (e: any) {
      return reply.code(500).send({ error: e?.message || 'submit failed' });
    }
  });

  /** Cancel an allocation (scancel + evict its server). */
  fastify.delete('/compute/allocations/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const ok = await allocationService.cancel(id);
    if (!ok) return reply.code(404).send({ error: 'allocation not found' });
    return reply.send({ cancelled: true });
  });
}
