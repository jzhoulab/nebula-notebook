/**
 * PTY Manager - Manages terminal sessions using node-pty
 */

import * as path from 'path';
import { promises as fsp } from 'fs';
import { execFile } from 'child_process';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { v4 as uuidv4 } from 'uuid';
import {
  TerminalInfo,
  OUTPUT_BUFFER_MAX_SIZE,
  OUTPUT_BUFFER_TRIM_SIZE
} from './types';

// Sticky DEC private modes that turn mouse moves / focus changes into garbage
// *input* when left enabled at a shell prompt (the classic "reconnected terminal
// spews <b;x;yM sequences"). Tracked from the raw pty stream so a reconnect can
// restore the AUTHORITATIVE state even when the enabling/disabling sequence has
// scrolled out of — or been split by — the 100 KB buffer trim. 1000 click /
// 1002 button-drag / 1003 any-motion mouse · 1004 focus events · 1006 SGR
// encoding. (Bracketed paste 2004 is intentionally excluded — the shell prompt
// toggles it itself, so forcing it would fight the shell.)
const TRACKED_INPUT_MODES = [1000, 1002, 1003, 1004, 1006];
// DECSET (…h) / DECRST (…l); params may be ;-separated, e.g. \x1b[?1000;1006h
// eslint-disable-next-line no-control-regex
const DEC_PRIVATE_MODE_RE = /\x1b\[\?([0-9;]+)([hl])/g;

interface TerminalSession {
  id: string;
  pty: pty.IPty;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  created: number;
  lastActivity: number;
  outputBuffer: string;
  activeModes: Set<number>; // tracked sticky input modes (see TRACKED_INPUT_MODES)
  // Listener SETS, not single slots: several websocket clients can mirror one
  // pty (same agent open in multiple notebook tabs), and the agent registry
  // subscribes to exit independently. The old single-callback model meant a
  // second subscriber silently replaced the first.
  dataListeners: Set<(data: string) => void>;
  exitListeners: Set<(code: number) => void>;
}

export class PtyManager {
  private sessions: Map<string, TerminalSession> = new Map();

  /**
   * Get the default shell for the current platform
   */
  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }

  /**
   * Normalize a terminal name to a valid ID
   * - Lowercase
   * - Only alphanumeric, hyphens, underscores
   * - Max 32 chars
   * - Falls back to 'default' if empty/invalid
   */
  normalizeTerminalName(name: string): string {
    const normalized = name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);
    return normalized || 'default';
  }

  /**
   * Create a new terminal session
   */
  create(options?: {
    id?: string;  // Optional custom ID (will be normalized if provided)
    cwd?: string;
    shell?: string;
    cols?: number;
    rows?: number;
  }): TerminalInfo {
    const id = options?.id ? this.normalizeTerminalName(options.id) : uuidv4();
    const shell = options?.shell || this.getDefaultShell();
    const cwd = options?.cwd || process.cwd();
    const cols = options?.cols || 80;
    const rows = options?.rows || 24;

    // Make the `nebula` agent CLI resolvable in every Nebula terminal, and
    // pre-point it at this server. The CLI is a thin layer over the same
    // client the MCP uses (packages/mcp) — agents in the built-in terminal
    // can drive notebooks without any MCP registration.
    const nebulaCliBinDir = path.resolve(__dirname, '..', '..', '..', 'packages', 'mcp', 'bin');

    // Spawn as a LOGIN shell (-l): Nebula terminals must see the same
    // environment as the user's ssh sessions. Non-login shells skip
    // .zprofile/.bash_profile, so env set there (agent auth tokens like
    // CLAUDE_CODE_OAUTH_TOKEN, module inits, PATH) silently vanished from
    // server-side agent launches — Claude then fell back to its stored OAuth
    // session and demanded /login whenever that had expired. Windows shells
    // don't take -l; posix only.
    const shellArgs = process.platform === 'win32' ? [] : ['-l'];
    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        NEBULA_URL: process.env.NEBULA_URL ?? `http://localhost:${process.env.PORT || 3000}`,
        PATH: `${nebulaCliBinDir}:${process.env.PATH ?? ''}`,
      } as { [key: string]: string },
    });

    const session: TerminalSession = {
      id,
      pty: ptyProcess,
      cwd,
      shell,
      cols,
      rows,
      created: Date.now(),
      lastActivity: Date.now(),
      outputBuffer: '',
      activeModes: new Set<number>(),
      dataListeners: new Set(),
      exitListeners: new Set(),
    };

    // Handle PTY output
    ptyProcess.onData((data: string) => {
      session.lastActivity = Date.now();

      // Append to output buffer for reconnection
      session.outputBuffer += data;

      // Track sticky input-mode transitions from the RAW stream (before the
      // trim below can drop or split them) so replay can reassert the true state.
      DEC_PRIVATE_MODE_RE.lastIndex = 0;
      let modeMatch: RegExpExecArray | null;
      while ((modeMatch = DEC_PRIVATE_MODE_RE.exec(data)) !== null) {
        const enable = modeMatch[2] === 'h';
        for (const p of modeMatch[1].split(';')) {
          const n = Number(p);
          if (TRACKED_INPUT_MODES.includes(n)) {
            if (enable) session.activeModes.add(n);
            else session.activeModes.delete(n);
          }
        }
      }

      // Trim buffer if too large
      if (session.outputBuffer.length > OUTPUT_BUFFER_MAX_SIZE) {
        session.outputBuffer = session.outputBuffer.slice(-OUTPUT_BUFFER_TRIM_SIZE);
      }

      // Forward to all listeners (websocket clients, watchers)
      for (const cb of session.dataListeners) {
        try { cb(data); } catch { /* one bad listener must not break the rest */ }
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      for (const cb of session.exitListeners) {
        try { cb(exitCode); } catch { /* see above */ }
      }
      this.sessions.delete(id);
    });

    this.sessions.set(id, session);

    return this.getInfo(session);
  }

  /**
   * Get terminal info from session
   */
  private getInfo(session: TerminalSession): TerminalInfo {
    return {
      id: session.id,
      pid: session.pty.pid,
      cwd: session.cwd,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
      created: session.created,
      lastActivity: session.lastActivity,
    };
  }

  /**
   * Get a terminal session by ID
   */
  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * Whether the pty's shell has any child process — i.e. something (an agent
   * CLI, an ssh hop, a user command) is actually running in it. `false` means
   * a bare idle shell with certainty; `null` means unknown (no such pty, or
   * pgrep unavailable) and callers must not conclude anything from it.
   */
  async hasLiveChild(id: string): Promise<boolean | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    const pid = session.pty.pid;
    // Fast path (Linux): the kernel lists a process's children directly —
    // an O(1) ~3ms read, vs pgrep's O(all processes) table scan (~50ms on a
    // busy shared login node with 1300+ processes). Absent on macOS and on
    // kernels without CONFIG_PROC_CHILDREN — fall back to pgrep there.
    try {
      const children = await fsp.readFile(`/proc/${pid}/task/${pid}/children`, 'utf-8');
      return children.trim().length > 0;
    } catch { /* not Linux (or file gone with the process) — pgrep decides */ }
    return new Promise((resolve) => {
      execFile('pgrep', ['-P', String(pid)], (error) => {
        if (!error) return resolve(true); // exit 0: at least one child
        // pgrep exits 1 for "no processes matched" — that's a definitive no.
        const code = (error as { code?: number | string }).code;
        resolve(code === 1 ? false : null);
      });
    });
  }

  /**
   * Get terminal info by ID
   */
  getTerminalInfo(id: string): TerminalInfo | undefined {
    const session = this.sessions.get(id);
    return session ? this.getInfo(session) : undefined;
  }

  /**
   * List all active terminals
   */
  list(): TerminalInfo[] {
    return Array.from(this.sessions.values()).map((s) => this.getInfo(s));
  }

  /**
   * Write data to a terminal
   */
  write(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.pty.write(data);
    session.lastActivity = Date.now();
    return true;
  }

  /**
   * Resize a terminal
   */
  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    // Skip no-op resizes: TIOCSWINSZ raises SIGWINCH even when the size is
    // unchanged, forcing a full-screen repaint from any running TUI. On a
    // reconnect several resize messages arrive with the SAME dimensions, and
    // that repaint burst is what stalls input after a refresh.
    if (session.cols === cols && session.rows === rows) return true;

    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    session.lastActivity = Date.now();
    return true;
  }

  /**
   * Get or create a terminal by name
   * If a terminal with the normalized name exists, return it
   * Otherwise create a new one with that name
   */
  getOrCreate(name: string, options?: {
    cwd?: string;
    shell?: string;
    cols?: number;
    rows?: number;
  }): TerminalInfo {
    const normalizedId = this.normalizeTerminalName(name);
    const existing = this.sessions.get(normalizedId);

    if (existing) {
      return this.getInfo(existing);
    }

    return this.create({ ...options, id: normalizedId });
  }

  /**
   * Kill a terminal session
   */
  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.pty.kill();
    this.sessions.delete(id);
    return true;
  }

  /**
   * Subscribe to a terminal's output. Returns an unsubscribe function
   * (no-op if the terminal is gone).
   */
  addDataListener(id: string, callback: (data: string) => void): () => void {
    const session = this.sessions.get(id);
    if (!session) return () => {};
    session.dataListeners.add(callback);
    return () => { this.sessions.get(id)?.dataListeners.delete(callback); };
  }

  /**
   * Subscribe to a terminal's exit. Returns an unsubscribe function.
   */
  addExitListener(id: string, callback: (code: number) => void): () => void {
    const session = this.sessions.get(id);
    if (!session) return () => {};
    session.exitListeners.add(callback);
    return () => { this.sessions.get(id)?.exitListeners.delete(callback); };
  }

  /**
   * Get buffered output for reconnection
   */
  getOutputBuffer(id: string): string {
    const session = this.sessions.get(id);
    return session?.outputBuffer || '';
  }

  /**
   * Sequences that reassert the sticky input modes (see TRACKED_INPUT_MODES) to
   * the authoritative state observed on the full pty stream. Appended after the
   * replay buffer so a reconnect never leaves mouse/focus reporting dangling on
   * at the shell: the 100 KB buffer trim can drop or split the app's own
   * mode-reset, and this puts it back deterministically.
   */
  getModeReset(id: string): string {
    const session = this.sessions.get(id);
    if (!session) return '';
    // If the pty's FOREGROUND process is a plain shell, no TUI can be holding
    // the sticky input modes — any tracked "on" state is stale (a TUI died
    // without its teardown bytes reaching the pty, e.g. an agent riding a
    // collapsed reverse tunnel, or a SIGKILL). Reasserting it would turn the
    // user's mouse movements into SGR garbage typed at the prompt, so reset
    // everything OFF instead.
    try {
      const fg = (session.pty.process || '').split('/').pop() || '';
      if (/^-?(bash|zsh|sh|dash|fish|tcsh|ksh)$/.test(fg)) {
        session.activeModes.clear();
      }
    } catch { /* can't inspect foreground — keep tracked state */ }
    return TRACKED_INPUT_MODES
      .map((n) => `\x1b[?${n}${session.activeModes.has(n) ? 'h' : 'l'}`)
      .join('');
  }

  /**
   * Kill all terminal sessions (for cleanup)
   */
  killAll(): void {
    for (const [id] of this.sessions) {
      this.kill(id);
    }
  }
}

// Singleton instance
export const ptyManager = new PtyManager();
