/**
 * Agent registry — the server-side ledger of agent sessions (Claude Code /
 * Codex CLIs running inside terminal ptys).
 *
 * Agents are project-scoped (keyed by the working directory they were
 * launched in) and decoupled from notebooks: switching notebooks never kills
 * or switches an agent; the user does, through the agent manager. Records
 * persist to disk so agents survive as *resumable* entities even when their
 * pty dies (browser gone, server restart, user hibernates them): the CLI's
 * own on-disk trajectory (`claude --resume <id>` / `codex resume`) can
 * reconstruct the conversation — the registry just remembers what exists,
 * where, and how to revive it. The client owns launch/revive command
 * construction (it knows about remote-agent mode); the server owns truth
 * about what is live.
 *
 * States: 'live' (pty exists) → 'hibernated' (pty gone, trajectory on disk).
 * All records load as 'hibernated' on boot — ptys never survive a restart.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ptyManager } from './pty-manager';

export interface AgentRecord {
  /** Terminal (pty) id the agent runs in — stable, derived from workdir. */
  terminalId: string;
  kind: 'claude' | 'codex';
  /** Directory the agent was launched in — the project scope. */
  workdir: string;
  /** Where the CLI process runs: this server, or the user's machine over the reverse channel. */
  location: 'server' | 'remote';
  /** Claude --session-id (resume pointer). Codex resumes via its own picker. */
  sessionId?: string;
  /** Notebook that launched it (informational only — agents are not bound to notebooks). */
  launchedFrom?: string;
  /**
   * Pinned workspace-mirror dir slug (`p-<hash>-<name>` under ~/.nebula/agent).
   * Stored at launch so record-driven resumes keep finding the conversation
   * even if the slug derivation ever changes — paths in records don't drift.
   */
  mirrorSlug?: string;
  state: 'live' | 'hibernated';
  createdAt: number;
  lastLaunchAt: number;
}

const STATE_FILE = process.env.NEBULA_AGENTS_FILE || path.join(os.homedir(), '.nebula', 'agents.json');
const MAX_RECORDS = 50; // oldest hibernated records beyond this are dropped

class AgentRegistry {
  private records = new Map<string, AgentRecord>();
  private exitUnsubs = new Map<string, () => void>();
  private loaded = false;

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (fs.existsSync(STATE_FILE)) {
        const list = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as AgentRecord[];
        for (const r of list) {
          if (!r?.terminalId) continue;
          // Ptys never survive a server restart — everything reloads hibernated.
          r.state = 'hibernated';
          this.records.set(r.terminalId, r);
        }
      }
    } catch (err) {
      console.error('[AgentRegistry] failed to load state:', err);
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(STATE_FILE);
      fs.mkdirSync(dir, { recursive: true });
      const all = [...this.records.values()].sort((a, b) => b.lastLaunchAt - a.lastLaunchAt);
      const live = all.filter((r) => r.state === 'live');
      const hibernated = all.filter((r) => r.state !== 'live').slice(0, MAX_RECORDS - live.length);
      const tmp = `${STATE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...live, ...hibernated], null, 2));
      fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
      console.error('[AgentRegistry] failed to persist state:', err);
    }
  }

  /**
   * Register (or re-register on revive) an agent launched in a terminal.
   * MERGE semantics: fields the caller didn't supply NEVER overwrite stored
   * truth — a resume relaunch that doesn't know the sessionId must not erase
   * the registry's copy (that id is the conversation; losing it downgrades
   * every later Continue to a picker).
   */
  register(rec: Omit<AgentRecord, 'state' | 'createdAt' | 'lastLaunchAt'>): AgentRecord {
    this.ensureLoaded();
    const existing = this.records.get(rec.terminalId);
    const record: AgentRecord = {
      ...existing,
      ...rec,
      sessionId: rec.sessionId ?? existing?.sessionId,
      mirrorSlug: rec.mirrorSlug ?? existing?.mirrorSlug,
      launchedFrom: rec.launchedFrom ?? existing?.launchedFrom,
      state: 'live',
      createdAt: existing?.createdAt ?? Date.now(),
      lastLaunchAt: Date.now(),
    };
    this.records.set(rec.terminalId, record);

    // When the pty dies for any reason (user exits the CLI and closes the
    // terminal, hibernate, server-side kill), the agent is not gone — its
    // trajectory is on disk. Mark it hibernated, ready to revive.
    this.exitUnsubs.get(rec.terminalId)?.();
    const unsub = ptyManager.addExitListener(rec.terminalId, () => {
      const r = this.records.get(rec.terminalId);
      if (r && r.state === 'live') {
        r.state = 'hibernated';
        this.persist();
      }
      this.exitUnsubs.delete(rec.terminalId);
    });
    this.exitUnsubs.set(rec.terminalId, unsub);

    // SERVER-SIDE liveness: the pty stream passes through this process, so the
    // agent-alive state machine lives HERE, not in whichever browser happens to
    // be attached. TUI teardown with no re-init within the grace window means
    // the agent exited to the shell — the record flips to 'hibernated' even
    // though the pty lives on (revive types the resume command into it).
    this.watchLiveness(rec.terminalId);
    this.persist();
    return record;
  }

  private static TUI_INIT_RE = /\x1b\[\?(1049|1004|1000|1002|1003)h/;
  private static TUI_TEARDOWN_RE = /\x1b\[\?(1049|1004|1000|1002|1003)l/;
  private dataUnsubs = new Map<string, () => void>();
  private graceTimers = new Map<string, NodeJS.Timeout>();

  private watchLiveness(terminalId: string): void {
    this.dataUnsubs.get(terminalId)?.();
    const unsub = ptyManager.addDataListener(terminalId, (chunk: string) => {
      this.observeOutput(terminalId, chunk);
    });
    if (unsub) this.dataUnsubs.set(terminalId, unsub);
  }

  /** Feed pty output through the liveness machine (public for tests). */
  observeOutput(terminalId: string, chunk: string): void {
    const r = this.records.get(terminalId);
    if (!r) return;
    if (AgentRegistry.TUI_INIT_RE.test(chunk)) {
      const t = this.graceTimers.get(terminalId);
      if (t) { clearTimeout(t); this.graceTimers.delete(terminalId); }
      if (r.state !== 'live') { r.state = 'live'; r.lastLaunchAt = Date.now(); this.persist(); }
      return;
    }
    if (AgentRegistry.TUI_TEARDOWN_RE.test(chunk) && r.state === 'live' && !this.graceTimers.has(terminalId)) {
      this.graceTimers.set(terminalId, setTimeout(() => {
        this.graceTimers.delete(terminalId);
        const rec = this.records.get(terminalId);
        if (rec && rec.state === 'live') {
          rec.state = 'hibernated'; // agent exited; pty may still be a plain shell
          this.persist();
        }
      }, 2000));
    }
  }

  /** List all agents, reconciling 'live' against actual pty existence. */
  list(): AgentRecord[] {
    this.ensureLoaded();
    for (const r of this.records.values()) {
      if (r.state === 'live' && !ptyManager.get(r.terminalId)) {
        r.state = 'hibernated';
      }
    }
    return [...this.records.values()].sort((a, b) => b.lastLaunchAt - a.lastLaunchAt);
  }

  /**
   * list() plus tty-foreground facts for every record whose pty exists:
   * - `busy`: something owns the pty's tty foreground — a TUI, an ssh hop, a
   *   running command. Crucially reported on HIBERNATED records too: the
   *   TUI-stream liveness machine can mis-score (an agent resumed by hand
   *   never re-registers), and a client that trusts 'hibernated' then types a
   *   launch command straight into the running TUI's input box (lab report: a
   *   live codex politely declined to run the pasted ssh line). The tty
   *   foreground is authoritative — and unlike a child-process scan it stays
   *   false while a fresh login shell sources its rc files.
   * - `idleShell` on live records: the inverse — 'live' but the foreground is
   *   a bare shell (a hung-then-dead ssh hop leaves exactly this; a dead
   *   transport emits no teardown, so only the foreground probe can see it).
   * Unknown checks claim nothing.
   */
  listEnriched(): (AgentRecord & { idleShell?: boolean; busy?: boolean })[] {
    return this.list().map((r) => {
      if (!ptyManager.get(r.terminalId)) return r;
      const busy = ptyManager.isBusy(r.terminalId);
      if (busy === null) return r;
      return r.state === 'live'
        ? { ...r, idleShell: !busy, busy }
        : { ...r, busy };
    });
  }

  /** Hibernate: close the pty; the record (and on-disk trajectory) remain. */
  hibernate(terminalId: string): boolean {
    this.ensureLoaded();
    const r = this.records.get(terminalId);
    if (!r) return false;
    if (ptyManager.get(terminalId)) ptyManager.kill(terminalId); // exit listener marks hibernated
    r.state = 'hibernated';
    this.persist();
    return true;
  }

  /** Forget the agent entirely (pty closed; registry record removed). */
  remove(terminalId: string): boolean {
    this.ensureLoaded();
    const r = this.records.get(terminalId);
    if (!r) return false;
    this.exitUnsubs.get(terminalId)?.();
    this.exitUnsubs.delete(terminalId);
    if (ptyManager.get(terminalId)) ptyManager.kill(terminalId);
    this.records.delete(terminalId);
    this.persist();
    return true;
  }
}

export const agentRegistry = new AgentRegistry();
