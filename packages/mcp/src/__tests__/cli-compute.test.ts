/**
 * Integration tests for `nebula compute …` (bin/nebula.js → dist/cli/index.js).
 *
 * Spawns the CLI as a subprocess against the in-process mock Nebula server,
 * whose /api/compute endpoints fabricate a scheduler (allocation lifecycle
 * pending → active on a short timer). Run `npm run build` in packages/mcp first.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { NebulaClient } from '../notebook/client.js';
import { executeToolByName } from '../tools/index.js';
import { startMockNebulaServer, type MockNebulaServer } from './helpers/mock-nebula-server.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(TEST_DIR, '../..');
const CLI_BIN = path.join(PACKAGE_ROOT, 'bin', 'nebula.js');
const CLI_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

describe('nebula compute CLI', () => {
  let mockServer: MockNebulaServer;
  let nebulaUrl: string;
  let stateDir: string;
  let userClient: NebulaClient;

  const uniquePath = (name: string) =>
    `/tmp/nebula-compute-test-${Date.now()}-${Math.random().toString(16).slice(2)}/${name}.ipynb`;

  function runCli(args: string[], opts: { env?: Record<string, string | undefined> } = {}): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_BIN, ...args], {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          NEBULA_URL: nebulaUrl,
          NEBULA_STATE_DIR: stateDir,
          ...opts.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      child.stdin.end();
    });
  }

  async function seedNotebook(nbPath: string) {
    const created = await userClient.createNotebookOp(nbPath, { overwrite: true });
    expect(created.success).toBe(true);
    const inserted = await userClient.insertCellOp(nbPath, -1, {
      id: 'cell-1',
      type: 'code',
      content: 'print("on the cluster")',
    });
    expect(inserted.success).toBe(true);
  }

  /** Allocate via --json (no wait) and return the allocation id. */
  async function allocate(extra: string[] = []): Promise<string> {
    const r = await runCli(['compute', 'alloc', '--partition', 'cpu', '--json', ...extra]);
    expect(r.code).toBe(0);
    const alloc = JSON.parse(r.stdout);
    expect(alloc.id).toBeTruthy();
    return alloc.id as string;
  }

  beforeAll(async () => {
    if (!fs.existsSync(CLI_ENTRY)) {
      throw new Error(`CLI build not found at ${CLI_ENTRY}. Run "npm run build" in packages/mcp first.`);
    }
    mockServer = await startMockNebulaServer();
    nebulaUrl = mockServer.url;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-compute-state-'));
    userClient = new NebulaClient({ baseUrl: nebulaUrl });
  });

  afterAll(async () => {
    await mockServer.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockServer.setComputeEnabled(true);
    mockServer.setComputeActivationDelay(150);
  });

  // ===========================================================================
  // status / queues
  // ===========================================================================

  it('compute status: reports the scheduler when enabled', async () => {
    const r = await runCli(['compute', 'status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('enabled: true');
    expect(r.stdout).toContain('scheduler: mock');
    expect(r.stdout).toContain('hint:');

    const rJson = await runCli(['compute', 'status', '--json']);
    expect(rJson.code).toBe(0);
    expect(JSON.parse(rJson.stdout)).toEqual({ enabled: true, scheduler: 'mock' });
  });

  it('compute queues: prints partitions with idle CPUs/GPUs, backlog, and QoS', async () => {
    const r = await runCli(['compute', 'queues']);
    expect(r.code).toBe(0);
    // partitions with idle/total counts
    expect(r.stdout).toContain('PARTITION');
    // The fixture cluster is heterogeneous (armq below), so an ARCH column
    // appears; partitions whose nodes never reported an arch show '?'.
    expect(r.stdout).toContain('ARCH');
    expect(r.stdout).toMatch(/cpu\s+up\s+\?\s+1-00:00:00\s+236\/512/);
    expect(r.stdout).toMatch(/gpu-a100\s+up\s+\?\s+\S+\s+22\/96\s+3\/8 \(nvidia_a100_80gb\)/);
    expect(r.stdout).toMatch(/armq\s+up\s+aarch64/);
    // backlog columns
    expect(r.stdout).toContain('PENDING');
    expect(r.stdout).toContain('RUNNING');
    // QoS table
    expect(r.stdout).toContain('normal (default)');
    expect(r.stdout).toContain('opportunistic');
    expect(r.stdout).toContain('hint:');
  });

  // ===========================================================================
  // alloc
  // ===========================================================================

  it('compute alloc: exits 2 without --partition', async () => {
    const r = await runCli(['compute', 'alloc']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--partition is required');
  });

  it('compute alloc without --wait: prints id + pending state and a hint', async () => {
    const r = await runCli(['compute', 'alloc', '--partition', 'cpu', '--cpus', '2']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/allocation: alloc-[0-9a-f]+/);
    expect(r.stdout).toContain('state: pending');
    expect(r.stdout).toContain('hint:');
    expect(r.stdout).toContain('nebula compute use');
  });

  it('compute alloc --idle-timeout: sends idleTimeoutMinutes in the POST body', async () => {
    const r = await runCli(['compute', 'alloc', '--partition', 'cpu', '--idle-timeout', '45', '--json']);
    expect(r.code).toBe(0);
    const alloc = JSON.parse(r.stdout);
    // the mock parses the POST body like the real server and echoes the spec
    expect(alloc.spec.idleTimeoutMinutes).toBe(45);
    expect(mockServer.getAllocation(alloc.id)?.spec.idleTimeoutMinutes).toBe(45);

    // omitted → not in the spec
    const bare = await runCli(['compute', 'alloc', '--partition', 'cpu', '--json']);
    expect(bare.code).toBe(0);
    expect(JSON.parse(bare.stdout).spec.idleTimeoutMinutes).toBeUndefined();

    // invalid → usage error
    const bad = await runCli(['compute', 'alloc', '--partition', 'cpu', '--idle-timeout', '0']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--idle-timeout');
  });

  it('compute alloc --wait: follows the allocation through to active', async () => {
    const r = await runCli([
      'compute', 'alloc',
      '--partition', 'cpu',
      '--cpus', '4',
      '--mem', '8',
      '--walltime', '2',
      '--name', 'test-train',
      '--wait',
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('state: active');
    expect(r.stdout).toMatch(/server: compute-server-alloc-[0-9a-f]+/);
    expect(r.stdout).toMatch(/node: node-\d+/);
    expect(r.stdout).toContain('hint:');

    // spec defaults + flags round-trip (walltime hours → minutes)
    const id = r.stdout.match(/allocation: (alloc-[0-9a-f]+)/)?.[1];
    expect(id).toBeTruthy();
    const alloc = mockServer.getAllocation(id!);
    expect(alloc?.spec).toMatchObject({ partition: 'cpu', cpus: 4, memGb: 8, walltimeMinutes: 120, jobName: 'test-train' });

    // appears active in ls
    const ls = await runCli(['compute', 'ls']);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toMatch(new RegExp(`${id}\\s+active\\s+cpu`));
  });

  // ===========================================================================
  // use → for-file carries server_id
  // ===========================================================================

  it('compute use: binds notebook kernels to the allocation server (for-file carries server_id)', async () => {
    const nbPath = uniquePath('bind');
    await seedNotebook(nbPath);

    const id = await allocate(['--name', 'bind-me']);
    // wait for activation
    await new Promise((resolve) => setTimeout(resolve, 400));
    const alloc = mockServer.getAllocation(id);
    expect(alloc?.state).toBe('active');

    const r = await runCli(['compute', 'use', id, nbPath]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`allocation ${id}`);
    expect(r.stdout).toContain(`server ${alloc!.serverId}`);
    expect(r.stdout).toMatch(/session: mock-session-\d+/);

    // the kernel session created by `use` carries the allocation's server_id
    const sessions = await userClient.listSessions();
    expect(sessions.success).toBe(true);
    const bound = (sessions.data ?? []).find((s) => s.file_path === nbPath) as
      | { server_id?: string }
      | undefined;
    expect(bound?.server_id).toBe(alloc!.serverId);

    // a SUBSEQUENT for-file without server_id sticks to the saved preference
    const response = await fetch(`${nebulaUrl}/api/kernels/for-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: nbPath }),
    });
    const body = (await response.json()) as { server_id?: string };
    expect(body.server_id).toBe(alloc!.serverId);

    // and `nebula run` on the bound notebook executes fine
    const run = await runCli(['run', nbPath, 'cell-1']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('on the cluster');
  });

  it('compute use: also resolves allocations by name', async () => {
    const nbPath = uniquePath('by-name');
    await seedNotebook(nbPath);
    const id = await allocate(['--name', 'named-alloc']);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const r = await runCli(['compute', 'use', 'named-alloc', nbPath, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).allocationId).toBe(id);
  });

  it('compute use: clear error when the allocation is not active yet', async () => {
    const nbPath = uniquePath('pending');
    await seedNotebook(nbPath);
    mockServer.setComputeActivationDelay(60_000); // stays pending
    const id = await allocate();

    const r = await runCli(['compute', 'use', id, nbPath]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`allocation ${id} is not active (state: pending)`);
    expect(r.stderr).toContain('hint:');
  });

  it('compute use: allocation not found', async () => {
    const r = await runCli(['compute', 'use', 'no-such-alloc', '/tmp/x.ipynb']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('allocation not found: no-such-alloc');
  });

  // ===========================================================================
  // ls / cancel
  // ===========================================================================

  it('compute cancel: cancels and shows up in ls; unknown id errors', async () => {
    const id = await allocate();
    const r = await runCli(['compute', 'cancel', id]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`cancelled: ${id}`);
    expect(mockServer.getAllocation(id)?.state).toBe('cancelled');

    const ls = await runCli(['compute', 'ls']);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toMatch(new RegExp(`${id}\\s+cancelled`));

    const missing = await runCli(['compute', 'cancel', 'nope']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('allocation not found: nope');
  });

  // ===========================================================================
  // disabled-scheduler path
  // ===========================================================================

  it('reports disabled scheduler clearly (status ok, queues/alloc exit 1)', async () => {
    mockServer.setComputeEnabled(false);

    const status = await runCli(['compute', 'status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('enabled: false');
    expect(status.stdout).toContain('scheduler: -');

    const queues = await runCli(['compute', 'queues']);
    expect(queues.code).toBe(1);
    expect(queues.stderr).toContain('no scheduler on this server');

    const alloc = await runCli(['compute', 'alloc', '--partition', 'cpu']);
    expect(alloc.code).toBe(1);
    expect(alloc.stderr).toContain('no scheduler on this server');
  });

  // ===========================================================================
  // MCP tool parity (same client core as the CLI)
  // ===========================================================================

  describe('MCP compute tools', () => {
    it('compute_status and list_compute_queues mirror the CLI', async () => {
      const status = await executeToolByName('compute_status', {}, userClient);
      expect(status.success).toBe(true);
      expect(status.data).toEqual({ enabled: true, scheduler: 'mock' });

      const queues = await executeToolByName('list_compute_queues', {}, userClient);
      expect(queues.success).toBe(true);
      const data = queues.data as { load: { partitions: Array<{ name: string }> } };
      expect(data.load.partitions.map((p) => p.name)).toContain('gpu-a100');
    });

    it('request_allocation(wait_for_active) → use_allocation → cancel_allocation', async () => {
      const nbPath = uniquePath('mcp-bind');
      await seedNotebook(nbPath);

      const requested = await executeToolByName(
        'request_allocation',
        { partition: 'gpu', gpus: 1, cpus: 2, wait_for_active: true, max_wait: 30 },
        userClient
      );
      expect(requested.success).toBe(true);
      const alloc = requested.data as { id: string; state: string; serverId?: string };
      expect(alloc.state).toBe('active');
      expect(alloc.serverId).toBeTruthy();

      const used = await executeToolByName(
        'use_allocation',
        { allocation_id: alloc.id, path: nbPath },
        userClient
      );
      expect(used.success).toBe(true);
      expect((used.data as { serverId: string }).serverId).toBe(alloc.serverId);

      const listed = await executeToolByName('list_allocations', {}, userClient);
      expect(listed.success).toBe(true);
      const ids = (listed.data as { allocations: Array<{ id: string }> }).allocations.map((a) => a.id);
      expect(ids).toContain(alloc.id);

      const cancelled = await executeToolByName('cancel_allocation', { allocation_id: alloc.id }, userClient);
      expect(cancelled.success).toBe(true);
      expect(mockServer.getAllocation(alloc.id)?.state).toBe('cancelled');
    });

    it('use_allocation refuses a non-active allocation; tools surface the disabled scheduler', async () => {
      mockServer.setComputeActivationDelay(60_000);
      const requested = await executeToolByName('request_allocation', { partition: 'cpu' }, userClient);
      expect(requested.success).toBe(true);
      const alloc = requested.data as { id: string };

      const used = await executeToolByName(
        'use_allocation',
        { allocation_id: alloc.id, path: '/tmp/x.ipynb' },
        userClient
      );
      expect(used.success).toBe(false);
      expect(used.error).toContain('not active');

      mockServer.setComputeEnabled(false);
      const status = await executeToolByName('compute_status', {}, userClient);
      expect(status.success).toBe(true);
      expect((status.data as { enabled: boolean }).enabled).toBe(false);

      const queues = await executeToolByName('list_compute_queues', {}, userClient);
      expect(queues.success).toBe(false);
      expect(queues.error).toContain('No scheduler');

      const denied = await executeToolByName('request_allocation', { partition: 'cpu' }, userClient);
      expect(denied.success).toBe(false);
      expect(denied.error).toContain('No scheduler');
    });
  });
});
