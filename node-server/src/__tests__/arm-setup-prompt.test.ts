// @vitest-environment node
/**
 * Agent-executable ARM setup: the server contributes FACTS (its own install
 * paths, node version, detected aarch64 partitions and their required QOS,
 * the env var names) and renders a verification-first prompt the user pastes
 * to an agent. Lab report: the docs were "instructions to perform and still
 * hard to act on" — a generic guide is not; a prompt with this cluster's
 * real values is.
 */

import { describe, it, expect } from 'vitest';
import { gatherArmSetupFacts, buildArmSetupPrompt, type ArmSetupFacts } from '../scheduler/arm-setup-prompt';
import type { Scheduler } from '../scheduler/types';

const fakeScheduler = (partitions: any[], qosByPartition: Record<string, string[] | null>): Scheduler => ({
  name: 'fake',
  detect: async () => true,
  associations: async () => ({ partitions: [], qoses: [] }),
  load: async () => ({ partitions, qoses: [], fetchedAt: 0 }),
  allowedQos: async (p: string) => qosByPartition[p] ?? null,
  partitionArch: async () => null,
  estimateStart: async () => ({}),
  submit: async () => ({ jobId: '1' }),
  query: async () => ({ state: 'pending' as const, nodes: [] }),
  cancel: async () => {},
});

const CTX = {
  mainUrl: 'http://login:3001',
  nodeBin: '/gpfs/lab/node22/bin/node',
  execArgv: [],
  scriptPath: '/gpfs/lab/tools/nebula-notebook/node-server/src/index.ts',
  cwd: '/gpfs/lab/tools/nebula-notebook/node-server',
  stateDir: '/tmp/state',
} as any;

describe('gatherArmSetupFacts', () => {
  it('collects cross-arch partitions with their required QOS, and install facts', async () => {
    const sched = fakeScheduler(
      [
        { name: 'pearsonq', archs: ['aarch64'] },
        { name: 'ghq', archs: ['aarch64'] },
        { name: 'cpuq', archs: ['x86_64'] },
        { name: 'mixedq', archs: ['aarch64', 'x86_64'] },
        { name: 'unknownq' },
      ],
      { pearsonq: ['pearson_priority', 'opportunistic'], ghq: null }
    );
    const facts = await gatherArmSetupFacts(sched, CTX, 'x64');
    expect(facts.armPartitions).toEqual([
      { name: 'pearsonq', qos: ['pearson_priority', 'opportunistic'] },
      { name: 'ghq', qos: null },
    ]);
    expect(facts.installDir).toBe('/gpfs/lab/tools/nebula-notebook');
    expect(facts.nodeBin).toBe('/gpfs/lab/node22/bin/node');
    expect(facts.configured).toBe(false);
    expect(facts.suggestedArmDir).toBe('/gpfs/lab/tools/nebula-notebook-arm64');
    expect(facts.suggestedArmNodeDir).toBe('/gpfs/lab/node22-arm64');
  });

  it('reports configured=true when an arm64 override exists', async () => {
    const ctx = { ...CTX, archOverrides: { arm64: { nodeBin: '/x', cwd: '/y', scriptPath: '/z' } } };
    const facts = await gatherArmSetupFacts(fakeScheduler([], {}), ctx, 'x64');
    expect(facts.configured).toBe(true);
  });
});

describe('buildArmSetupPrompt', () => {
  const facts: ArmSetupFacts = {
    configured: false,
    serverArch: 'x64',
    nodeVersion: 'v22.14.0',
    nodeBin: '/gpfs/lab/node22/bin/node',
    installDir: '/gpfs/lab/tools/nebula-notebook',
    suggestedArmDir: '/gpfs/lab/tools/nebula-notebook-arm64',
    suggestedArmNodeDir: '/gpfs/lab/node22-arm64',
    armPartitions: [{ name: 'pearsonq', qos: ['pearson_priority', 'opportunistic'] }],
  };
  const p = buildArmSetupPrompt(facts);

  it('embeds the real facts — paths, node version, partition, QOS', () => {
    expect(p).toContain('/gpfs/lab/tools/nebula-notebook');
    expect(p).toContain('/gpfs/lab/tools/nebula-notebook-arm64');
    expect(p).toContain('v22.14.0');
    expect(p).toContain('linux-arm64');
    expect(p).toContain('pearsonq');
    expect(p).toContain('opportunistic');
  });

  it('names both env vars and demands end-to-end verification', () => {
    expect(p).toContain('NEBULA_ARM64_NODE_BIN');
    expect(p).toContain('NEBULA_ARM64_DIR');
    expect(p).toMatch(/verify/i);
    expect(p).toMatch(/active/); // allocation must reach active state
    expect(p).toContain('srun'); // native deps installed ON an arm node
    expect(p).toMatch(/ipykernel/); // kernels need an aarch64 python too
  });

  it('degrades to placeholders instead of lying when no arm partition was detected', () => {
    const q = buildArmSetupPrompt({ ...facts, armPartitions: [] });
    expect(q).toContain('<arm-partition>');
    expect(q).not.toContain('undefined');
    expect(q).not.toContain('null');
  });
});
