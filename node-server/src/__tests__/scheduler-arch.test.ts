/**
 * Multi-arch compute allocations — an allocation re-launches THIS Nebula
 * install on the compute node, so an x86_64 server submitting to an aarch64
 * partition (CRI ghq/pearsonq) must swap in an arm64 runtime or refuse with
 * an actionable error instead of dying with "Exec format error" in a log
 * nobody reads.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async () => {
  const { promisify } = await import('node:util');
  const execFile: any = () => {
    throw new Error('callback-style execFile not expected in these tests');
  };
  execFile[promisify.custom] = (cmd: string, args: string[], opts: any) => execMock(cmd, args, opts);
  return { execFile, default: { execFile } };
});

import { normalizeArch, archOverridesFromEnv, pickLaunchContext } from '../scheduler/arch';
import { renderJobScript, type LaunchContext } from '../scheduler/job-template';
import { summarizeLogTail } from '../scheduler/util';
import { SlurmScheduler } from '../scheduler/slurm-scheduler';
import { AllocationService } from '../scheduler/allocation-service';
import type { JobSpec, Scheduler } from '../scheduler/types';

const baseCtx = (over: Partial<LaunchContext> = {}): LaunchContext => ({
  mainUrl: 'http://login:3001',
  nodeBin: '/gpfs/x86/node22/bin/node',
  execArgv: ['--watch', '--import', 'tsx'],
  scriptPath: '/gpfs/x86/nebula/node-server/src/index.ts',
  cwd: '/gpfs/x86/nebula/node-server',
  stateDir: '/tmp/alloc-state',
  ...over,
});

const ARM_OVERRIDES = {
  arm64: {
    nodeBin: '/gpfs/arm/node22/bin/node',
    cwd: '/gpfs/arm/nebula/node-server',
    scriptPath: '/gpfs/arm/nebula/node-server/src/index.ts',
  },
};

describe('normalizeArch', () => {
  it('maps SLURM and node arch spellings onto node identifiers', () => {
    expect(normalizeArch('x86_64')).toBe('x64');
    expect(normalizeArch('amd64')).toBe('x64');
    expect(normalizeArch('x64')).toBe('x64');
    expect(normalizeArch('aarch64')).toBe('arm64');
    expect(normalizeArch('arm64')).toBe('arm64');
    expect(normalizeArch('AARCH64')).toBe('arm64');
  });

  it('passes unknown arches through (lowercased) instead of guessing', () => {
    expect(normalizeArch('riscv64')).toBe('riscv64');
  });
});

describe('archOverridesFromEnv', () => {
  it('derives the arm64 runtime from NEBULA_ARM64_NODE_BIN + NEBULA_ARM64_DIR', () => {
    const overrides = archOverridesFromEnv({
      NEBULA_ARM64_NODE_BIN: '/gpfs/arm/node22/bin/node',
      NEBULA_ARM64_DIR: '/gpfs/arm/nebula',
    });
    expect(overrides).toEqual(ARM_OVERRIDES);
  });

  it('requires BOTH vars — half a runtime is no runtime', () => {
    expect(archOverridesFromEnv({ NEBULA_ARM64_NODE_BIN: '/gpfs/arm/node' })).toEqual({});
    expect(archOverridesFromEnv({ NEBULA_ARM64_DIR: '/gpfs/arm/nebula' })).toEqual({});
    expect(archOverridesFromEnv({})).toEqual({});
  });
});

describe('pickLaunchContext', () => {
  it('uses the base context when the target arch is unknown or matches the server', () => {
    const ctx = baseCtx();
    expect(pickLaunchContext(ctx, null, 'x64')).toBe(ctx);
    expect(pickLaunchContext(ctx, 'x86_64', 'x64')).toBe(ctx);
    expect(pickLaunchContext(ctx, 'aarch64', 'arm64')).toBe(ctx);
  });

  it('swaps in the arch override for a cross-arch partition', () => {
    const ctx = baseCtx({ archOverrides: ARM_OVERRIDES });
    const picked = pickLaunchContext(ctx, 'aarch64', 'x64');
    expect(picked.nodeBin).toBe('/gpfs/arm/node22/bin/node');
    expect(picked.cwd).toBe('/gpfs/arm/nebula/node-server');
    expect(picked.scriptPath).toBe('/gpfs/arm/nebula/node-server/src/index.ts');
    // Identity of the install changes; identity of the deployment must not.
    expect(picked.mainUrl).toBe(ctx.mainUrl);
    expect(picked.stateDir).toBe(ctx.stateDir);
  });

  it('drops --watch from the client execArgv (a client restarting mid-job is never wanted)', () => {
    const ctx = baseCtx({ archOverrides: ARM_OVERRIDES });
    const picked = pickLaunchContext(ctx, 'aarch64', 'x64');
    expect(picked.execArgv).toEqual(['--import', 'tsx']);
  });

  it('refuses a cross-arch partition with no configured runtime, naming the fix', () => {
    const ctx = baseCtx();
    expect(() => pickLaunchContext(ctx, 'aarch64', 'x64')).toThrow(/NEBULA_ARM64_NODE_BIN/);
    expect(() => pickLaunchContext(ctx, 'aarch64', 'x64')).toThrow(/aarch64/);
  });

  it('renders a job script that launches the arm runtime', () => {
    const ctx = baseCtx({ archOverrides: ARM_OVERRIDES });
    const picked = pickLaunchContext(ctx, 'aarch64', 'x64');
    const spec: JobSpec = { partition: 'pearsonq', cpus: 1, memGb: 4, walltimeMinutes: 60, jobName: 'nebula-arm' };
    const script = renderJobScript(spec, picked, 'alloc1', 'token1');
    expect(script).toContain('/gpfs/arm/node22/bin/node');
    expect(script).toContain("cd '/gpfs/arm/nebula/node-server'");
    expect(script).not.toContain('--watch');
  });
});

describe('summarizeLogTail', () => {
  it('keeps the last non-empty lines, most recent last', () => {
    const tail = summarizeLogTail('starting\n\nline a\nline b\nExec format error\n');
    expect(tail).toBe('line a | line b | Exec format error');
  });

  it('caps pathological lines while keeping the end (the error is at the end)', () => {
    const tail = summarizeLogTail(`${'x'.repeat(500)}\ncannot execute binary file: Exec format error\n`);
    expect(tail!.length).toBeLessThanOrEqual(301);
    expect(tail).toContain('Exec format error');
  });

  it('returns null for empty content', () => {
    expect(summarizeLogTail('')).toBeNull();
    expect(summarizeLogTail('\n  \n')).toBeNull();
  });
});

describe('SlurmScheduler arch discovery', () => {
  const SINFO = [
    'pearsonq|up|infinite|0/576/0/576|8|idle',
    'ghq|up|infinite|0/144/0/144|2|idle',
    'mixedq|up|7-00:00:00|0/100/0/100|2|idle',
    'cpuq|up|7-00:00:00|0/64/0/64|2|idle',
  ].join('\n');
  const SCONTROL = [
    'NodeName=cn408 Arch=aarch64 CPUTot=72 Partitions=pearsonq State=IDLE',
    'NodeName=cn406 Arch=aarch64 CPUTot=72 Partitions=ghq State=IDLE',
    'NodeName=cn001 Arch=x86_64 CPUTot=32 Partitions=cpuq,mixedq State=IDLE',
    'NodeName=cn002 Arch=aarch64 CPUTot=72 Partitions=mixedq State=IDLE',
    'NodeName=cn003 CPUTot=32 Partitions=cpuq State=DOWN', // never booted: no Arch reported
  ].join('\n');

  const wireSlurm = () => {
    execMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'sinfo') return { stdout: SINFO, stderr: '' };
      if (cmd === 'scontrol') return { stdout: SCONTROL, stderr: '' };
      return { stdout: '', stderr: '' }; // squeue, sacctmgr
    });
  };

  afterEach(() => execMock.mockReset());

  it('reports per-partition arch sets in load()', async () => {
    wireSlurm();
    const load = await new SlurmScheduler().load();
    const by = new Map(load.partitions.map((p) => [p.name, p]));
    expect(by.get('pearsonq')?.archs).toEqual(['aarch64']);
    expect(by.get('mixedq')?.archs).toEqual(['aarch64', 'x86_64']);
    expect(by.get('cpuq')?.archs).toEqual(['x86_64']);
  });

  it('resolves a homogeneous partition to its normalized arch', async () => {
    wireSlurm();
    const sched = new SlurmScheduler();
    expect(await sched.partitionArch('pearsonq')).toBe('arm64');
    expect(await sched.partitionArch('cpuq')).toBe('x64');
  });

  it('answers null for mixed-arch and unknown partitions (no safe pick exists)', async () => {
    wireSlurm();
    const sched = new SlurmScheduler();
    expect(await sched.partitionArch('mixedq')).toBeNull();
    expect(await sched.partitionArch('nosuch')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AllocationService: arch selection at submit + failure log surfacing
// ---------------------------------------------------------------------------

class FakeScheduler implements Scheduler {
  readonly name = 'fake';
  submit = vi.fn(async (_script: string) => ({ jobId: '4242' }));
  query = vi.fn(async (_jobId: string) => ({ state: 'pending' as const, nodes: [] }));
  partitionArch = vi.fn(async (partition: string) => (partition === 'armq' ? 'aarch64' : null));
  async detect() { return true; }
  async associations() { return { partitions: [], qoses: [] }; }
  async load() { return { partitions: [], qoses: [], fetchedAt: 0 }; }
  async allowedQos() { return null; }
  async estimateStart() { return {}; }
  async cancel() {}
}

const spec = (partition: string): JobSpec =>
  ({ partition, cpus: 1, memGb: 1, walltimeMinutes: 10, jobName: `nebula-${partition}` });

describe('AllocationService multi-arch submit', () => {
  let stateDir: string;
  let svc: AllocationService;

  afterEach(() => {
    svc?.shutdown();
    vi.useRealTimers();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const boot = (ctxOver: Partial<LaunchContext> = {}) => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-arch-'));
    svc = new AllocationService();
    const sched = new FakeScheduler();
    // Pin the server arch so cross-arch behavior is exercised on any dev host.
    svc.init(sched, baseCtx({ stateDir, serverArch: 'x64', ...ctxOver }));
    return sched;
  };

  it('refuses an arm partition when no arm runtime is configured — before submitting', async () => {
    const sched = boot();
    await expect(svc.create(spec('armq'))).rejects.toThrow(/NEBULA_ARM64_NODE_BIN/);
    expect(sched.submit).not.toHaveBeenCalled();
    expect(fs.readdirSync(stateDir).filter((f) => f.endsWith('.sh'))).toEqual([]);
  });

  it('submits an arm partition with the arm runtime substituted into the job script', async () => {
    const sched = boot({ archOverrides: ARM_OVERRIDES });
    const alloc = await svc.create(spec('armq'));
    expect(sched.submit).toHaveBeenCalledTimes(1);
    const script = fs.readFileSync(path.join(stateDir, `${alloc.id}.sh`), 'utf-8');
    expect(script).toContain('/gpfs/arm/node22/bin/node');
    expect(script).not.toContain('/gpfs/x86/node22/bin/node');
  });

  it('keeps the native runtime for same-arch partitions', async () => {
    boot({ archOverrides: ARM_OVERRIDES });
    const alloc = await svc.create(spec('cpuq'));
    const script = fs.readFileSync(path.join(stateDir, `${alloc.id}.sh`), 'utf-8');
    expect(script).toContain('/gpfs/x86/node22/bin/node');
  });

  it('surfaces the job log tail as the failure reason', async () => {
    vi.useFakeTimers();
    const sched = boot();
    const alloc = await svc.create(spec('cpuq'));
    fs.writeFileSync(
      path.join(stateDir, `${alloc.id}.log`),
      'starting client\n/gpfs/x86/node22/bin/node: cannot execute binary file: Exec format error\n'
    );
    sched.query.mockResolvedValue({ state: 'failed', nodes: [], reason: 'NonZeroExitCode' } as any);
    await vi.advanceTimersByTimeAsync(10);
    const failed = svc.get(alloc.id)!;
    expect(failed.state).toBe('failed');
    expect(failed.reason).toContain('NonZeroExitCode');
    expect(failed.reason).toContain('Exec format error');
  });
});
