// @vitest-environment node
/**
 * Agent registry: server-side liveness + merge-register.
 *
 * The registry is the source of truth for "is the agent alive" — derived from
 * the pty stream ON THE SERVER (browser-independent). E2E-found loopholes:
 *  - record stayed 'live' after the agent exited to the shell (pty alive)
 *  - a resume re-register erased the stored sessionId (client didn't send it)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

process.env.NEBULA_AGENTS_FILE = path.join(
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-areg-'))),
  'agents.json'
);
// The registry consults ptyManager for reconciliation ('live' requires a pty)
// and subscribes listeners — stub it so unit tests need no real ptys.
let stubHasLiveChild: boolean | null = true;
vi.mock('../terminal/pty-manager', () => ({
  ptyManager: {
    get: () => ({ id: 'stub' }),
    getTerminalInfo: () => null,
    addExitListener: () => () => {},
    addDataListener: () => () => {},
    kill: () => true,
    hasLiveChild: async () => stubHasLiveChild,
  },
}));
const { agentRegistry } = await import('../terminal/agent-registry');

const base = {
  terminalId: 'agent-abc123-proj',
  kind: 'claude' as const,
  workdir: '/w/proj',
  location: 'server' as const,
};

describe('agent registry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    agentRegistry.remove(base.terminalId);
    stubHasLiveChild = true;
  });
  afterEach(() => vi.useRealTimers());

  it('merge-register: missing fields never erase stored truth', () => {
    agentRegistry.register({ ...base, sessionId: 'sess-1', mirrorSlug: 'p-x-proj' });
    // Resume relaunch from a browser that doesn't know the session id:
    const after = agentRegistry.register({ ...base });
    expect(after.sessionId).toBe('sess-1');
    expect(after.mirrorSlug).toBe('p-x-proj');
    // But explicit values DO update:
    expect(agentRegistry.register({ ...base, sessionId: 'sess-2' }).sessionId).toBe('sess-2');
  });

  it('agent exit to shell (TUI teardown, pty alive) flips the record to hibernated', () => {
    agentRegistry.register({ ...base, sessionId: 's' });
    agentRegistry.observeOutput(base.terminalId, 'boot \x1b[?1049h');
    agentRegistry.observeOutput(base.terminalId, 'bye \x1b[?1049l');
    vi.advanceTimersByTime(2100);
    const rec = agentRegistry.list().find(r => r.terminalId === base.terminalId);
    expect(rec?.state).toBe('hibernated');
    expect(rec?.sessionId).toBe('s'); // conversation survives
  });

  it('screen transitions (teardown then re-init within grace) stay live', () => {
    agentRegistry.register({ ...base });
    agentRegistry.observeOutput(base.terminalId, '\x1b[?1049h');
    agentRegistry.observeOutput(base.terminalId, '\x1b[?1049l'); // picker closes
    vi.advanceTimersByTime(800);
    agentRegistry.observeOutput(base.terminalId, '\x1b[?1049h'); // session TUI up
    vi.advanceTimersByTime(5000);
    expect(agentRegistry.list().find(r => r.terminalId === base.terminalId)?.state).toBe('live');
  });

  it('listEnriched marks a live record idleShell when its pty shell has no child', async () => {
    // A dead ssh hop (or an agent that died without TUI teardown) leaves the
    // pty at a bare shell while the record still says 'live' — the enriched
    // list exposes that so clients don't adopt a phantom running agent.
    agentRegistry.register({ ...base });
    stubHasLiveChild = false;
    const idle = await agentRegistry.listEnriched();
    expect(idle.find(r => r.terminalId === base.terminalId)?.idleShell).toBe(true);

    stubHasLiveChild = true; // something is running in the pty — not idle
    const busy = await agentRegistry.listEnriched();
    expect(busy.find(r => r.terminalId === base.terminalId)?.idleShell).toBe(false);

    stubHasLiveChild = null; // unknown (pgrep unavailable) — claim nothing
    const unknown = await agentRegistry.listEnriched();
    expect(unknown.find(r => r.terminalId === base.terminalId)?.idleShell).toBeUndefined();
  });

  it('a manual relaunch in the same pty revives the record (init after hibernated)', () => {
    agentRegistry.register({ ...base });
    agentRegistry.observeOutput(base.terminalId, '\x1b[?1049l');
    vi.advanceTimersByTime(2100);
    expect(agentRegistry.list().find(r => r.terminalId === base.terminalId)?.state).toBe('hibernated');
    // User types `claude` by hand in that shell — TUI comes back up:
    agentRegistry.observeOutput(base.terminalId, '\x1b[?1004h');
    expect(agentRegistry.list().find(r => r.terminalId === base.terminalId)?.state).toBe('live');
  });
});

describe('busy enrichment (lab report: launch line typed into a live TUI)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    agentRegistry.remove(base.terminalId);
    stubHasLiveChild = true;
  });
  afterEach(() => vi.useRealTimers());

  // A HIBERNATED record whose pty still hosts a running process: the liveness
  // machine mis-scored (or the agent was resumed by hand, never re-registered).
  // The record must carry the process-table fact so no client types a launch
  // command into whatever is running there.
  it('reports busy on a hibernated record whose pty has a live child', async () => {
    agentRegistry.register(base);
    // teardown with no re-init → hibernated (existing machinery)
    agentRegistry.observeOutput(base.terminalId, '\x1b[?1049l');
    await vi.advanceTimersByTimeAsync(2100);
    const rec = (await agentRegistry.listEnriched()).find((r) => r.terminalId === base.terminalId)!;
    expect(rec.state).toBe('hibernated');
    expect(rec.busy).toBe(true);
  });

  it('reports busy=false when the shell is bare, and claims nothing when unknown', async () => {
    agentRegistry.register(base);
    stubHasLiveChild = false;
    let rec = (await agentRegistry.listEnriched()).find((r) => r.terminalId === base.terminalId)!;
    expect(rec.busy).toBe(false);
    expect(rec.idleShell).toBe(true); // live record keeps the existing field
    stubHasLiveChild = null; // pgrep unavailable — claim nothing
    rec = (await agentRegistry.listEnriched()).find((r) => r.terminalId === base.terminalId)!;
    expect(rec.busy).toBeUndefined();
  });
});
