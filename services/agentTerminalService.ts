/**
 * Agent Terminal Service
 *
 * Bridges notebook UI affordances ("Fix with agent", per-cell prompts) to an
 * agentic CLI (Claude Code / Codex) running inside the notebook's terminal.
 *
 * Design notes (robustness):
 * - Prompts are injected into the terminal pty via the SAME WebSocket the
 *   terminal UI already uses (`{type:'input'}` messages), so there is no new
 *   backend surface and the user sees exactly what was sent.
 * - We never inject a prompt unless an agent CLI was explicitly launched (or
 *   the user marked it running). Injecting into a bare shell would execute the
 *   prompt as a shell command.
 * - Prompts are collapsed to a single line: raw newlines in pty stdin would
 *   submit a TUI prompt early. The text is written first, then Enter ("\r")
 *   after a short delay, which matches how interactive TUIs expect input.
 * - All failures return a typed reason so the UI can guide the user instead of
 *   failing silently.
 */

import { getSettings, pushRemoteAgentToken } from './settingsService';
import { probeTerminalBusy, registerAgent, setActiveAgentId } from './agentRegistryService';
import { markOnboardingStep } from './onboardingService';

// Optimistic 'running' on launch; flips to 'failed' if the post-launch output
// watcher sees a "command not found"-style failure (agent never started).
export type AgentStatus = 'none' | 'running' | 'failed';
export type AgentKind = 'claude' | 'codex' | 'manual';

export interface SendResult {
  ok: boolean;
  reason?: 'no-terminal' | 'not-connected' | 'agent-not-running';
}

type Sender = (data: string) => boolean;

interface AgentState {
  terminalId: string | null;
  status: AgentStatus;
  agentKind: AgentKind | null;
  launchError?: string; // set when status === 'failed'
}

const ENTER_DELAY_MS = 150;
const MAX_ERROR_EXCERPT_CHARS = 280;
// Positive launch check: after sending the launch command, wait this long for
// the agent's TUI to appear. Both Claude and Codex render essentially instantly
// (<1s); the window is generous to tolerate a slow reverse-ssh hop before we
// declare the launch dead.
const LAUNCH_WATCH_MS = 10000;
/** Window in which an identical launch line for the same pty is a duplicate. */
const LAUNCH_DEDUPE_MS = 5000;
// A full-screen TUI (Claude, Codex) sets these private terminal modes when it
// starts and resets them when it exits back to the shell. Verified by capturing
// both agents' raw pty output AND the zsh prompt's: focus-events (?1004) is set
// by both agents and by neither shell, so it's the universal, shell-safe signal;
// alt-screen (?1049) and mouse (?100x) are extra Claude confirmation. Bracketed
// paste (?2004) is deliberately excluded — the shell prompt toggles it too.
// eslint-disable-next-line no-control-regex
const TUI_INIT_RE = /\x1b\[\?(1049|1004|1000|1002|1003)h/;     // agent came up
// eslint-disable-next-line no-control-regex
const TUI_TEARDOWN_RE = /\x1b\[\?(1049|1004|1000|1002|1003)l/; // agent exited to shell
// Explicit error signatures — a faster, more specific fail than the no-TUI
// timeout: shell/OS "not found", ssh-level failures (remote launch), and a
// resume whose transcript is gone.
const LAUNCH_FAILURE_RE =
  /command not found|not found|no such file or directory|is not recognized|permission denied|cannot execute|No such file|connection refused|connection timed out|could not resolve hostname|no route to host|ssh: connect to host|no conversation found/i;

// Persisted "agent launched" flag, keyed by terminal id. Terminal ids are
// stable (named per notebook), so after a page refresh reattaches to the same
// pty we can restore agent status instead of asking the user to relaunch.
// sessionStorage scope: survives refresh, not shared across browser tabs.
const AGENT_FLAG_PREFIX = 'nebula-agent-running:';

function readAgentFlag(terminalId: string): AgentKind | null {
  try {
    const v = window.sessionStorage.getItem(AGENT_FLAG_PREFIX + terminalId);
    return v === 'claude' || v === 'codex' || v === 'manual' ? v : null;
  } catch { return null; }
}

function writeAgentFlag(terminalId: string, kind: AgentKind | null): void {
  try {
    if (kind) window.sessionStorage.setItem(AGENT_FLAG_PREFIX + terminalId, kind);
    else window.sessionStorage.removeItem(AGENT_FLAG_PREFIX + terminalId);
  } catch { /* storage unavailable — degrade to in-memory only */ }
}

// Stable Claude session id per (agent terminal, run location). Claude keys each
// conversation by working directory, so two notebooks that share a cwd would
// cross-resume with plain `--continue`; a caller-chosen `--session-id` gives
// each notebook its own thread, resumed with `--resume <id>`. localStorage
// (not sessionStorage): the on-disk transcript is durable, so the resume
// pointer should survive a browser restart too. Keyed by location because a
// server-run and a laptop-run conversation live on different machines (and
// different ~/.claude), so their ids must not be confused.
const AGENT_SESSION_PREFIX = 'nebula-agent-session:';

function readAgentSessionId(key: string): string | null {
  try { return window.localStorage.getItem(AGENT_SESSION_PREFIX + key) || null; }
  catch { return null; }
}

function writeAgentSessionId(key: string, id: string | null): void {
  try {
    if (id) window.localStorage.setItem(AGENT_SESSION_PREFIX + key, id);
    else window.localStorage.removeItem(AGENT_SESSION_PREFIX + key);
  } catch { /* storage unavailable — resume just won't persist */ }
}

/** Deterministic, shell-safe mirror-dir name for a project dir — the
 *  `~/.nebula/agent/p-…` agent-workspace convention shared by remote AND
 *  local launches (the agent process always runs in its workspace dir,
 *  never in the real project dir). */
function remoteMirrorSlug(workdir: string): string {
  let hash = 0;
  for (let i = 0; i < workdir.length; i++) hash = ((hash << 5) - hash + workdir.charCodeAt(i)) | 0;
  const hex = (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
  const base = (workdir.split('/').pop() || 'project').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24);
  return `p-${hex}-${base}`;
}

function newSessionUuid(): string {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); }
  catch { /* not a secure context — fall through */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

class AgentTerminalService {
  private senders = new Map<string, Sender>();
  private state: AgentState = { terminalId: null, status: 'none', agentKind: null };
  private listeners = new Set<() => void>();
  private panelOpener: (() => void) | null = null;
  private notebookPath: string | null = null;
  // Last notebook the live agent was told about (origin tagging for shared agents).
  private lastTaggedNotebook: string | null = null;
  // Pending "TUI tore down" verdict — cancelled if a new TUI appears in time.
  private teardownGraceTimer: ReturnType<typeof setTimeout> | null = null;
  // Kind of the most recent launch — used when a late TUI proves a launch we
  // had already written off actually succeeded.
  private lastLaunchKind: 'claude' | 'codex' | null = null;
  /** Last launch line actually typed, for duplicate suppression. */
  private lastLaunchSent: { terminalId: string | null; line: string; at: number } | null = null;
  private serverBaseUrl: string | null = null;
  private repoRoot: string | null = null;
  // Output watcher over the agent terminal. phase 'launch' = confirming the TUI
  // came up (positive) or an error/timeout means it didn't; phase 'run' = the
  // agent is up, watching for it exiting back to the shell (the pty stays alive,
  // so no exit event fires). `raw` keeps the last bytes UNstripped so the private
  // mode sequences survive to be matched.
  private launchWatch:
    | { terminalId: string; kind: AgentKind; phase: 'launch' | 'run'; raw: string; timer: ReturnType<typeof setTimeout> | null }
    | null = null;

  // --- registration (called by TerminalInstance / TerminalPanel / Notebook) ---

  registerSender(terminalId: string, sender: Sender): void {
    this.senders.set(terminalId, sender);
    // Reconnection to the designated agent terminal (panel reopened, page
    // refreshed): the pty — and any agent in it — survived, so restore the
    // persisted status. setAgentTerminal can't do this when the id is
    // unchanged (it early-returns).
    if (terminalId === this.state.terminalId && this.state.status === 'none') {
      const restored = readAgentFlag(terminalId);
      if (restored) {
        this.state = { ...this.state, status: 'running', agentKind: restored };
        this.armExitWatch(terminalId, restored); // re-arm exit detection
      }
    }
    this.notify();
  }

  unregisterSender(terminalId: string): void {
    this.senders.delete(terminalId);
    // Only the WebSocket dropped — the pty (and any agent running in it)
    // survives server-side, and TerminalInstance auto-reconnects. Keep the
    // running status so the UI doesn't flap to the launch chips mid-outage;
    // isConnected() goes false, which gates prompt injection and lets the
    // panel show a "reconnecting" state. Real agent exits arrive as the
    // pty 'exit' event (markStopped), and a dead server surfaces as the
    // terminal's "session no longer exists" message.
    this.notify();
  }

  /** Designate which terminal is the agent terminal (the notebook panel's). */
  setAgentTerminal(terminalId: string | null): void {
    if (this.state.terminalId === terminalId) return;
    // A different pty is a different launch context — never let the previous
    // terminal's line suppress a launch here.
    this.lastLaunchSent = null;
    // Switching notebooks (or restoring across a refresh): the named pty survives
    // and an agent launched earlier is still running in it. Detach the old
    // watch; re-arm exit detection on the newly-current terminal if it's running.
    this.clearWatch();
    const restored = terminalId ? readAgentFlag(terminalId) : null;
    this.state = restored
      ? { terminalId, status: 'running', agentKind: restored }
      : { terminalId, status: 'none', agentKind: null };
    if (terminalId && restored) this.armExitWatch(terminalId, restored);
    this.notify();
  }

  setPanelOpener(opener: (() => void) | null): void {
    this.panelOpener = opener;
  }

  setNotebookContext(path: string | null): void {
    const prev = this.notebookPath;
    this.notebookPath = path;
    // Shared-agent origin tagging: when the driving notebook changes while an
    // agent is live, prefill the TUI input with a context tag (NO newline —
    // it becomes the prefix of the user's next message and is easy to delete;
    // sending \r here would submit a message and burn a turn).
    if (
      path && prev && path !== prev &&
      this.state.status === 'running' &&
      this.lastTaggedNotebook !== path
    ) {
      const sender = this.state.terminalId ? this.senders.get(this.state.terminalId) : undefined;
      if (sender && sender(`[now driving: ${path}] `)) {
        this.lastTaggedNotebook = path;
      }
    }
  }

  /**
   * Base URL the agent should pass to the MCP's connect_server. The agent CLI
   * runs in a pty ON the server machine, so http://localhost:<server-port> is
   * correct in every topology — browser-visible hostnames or SSH-tunnel ports
   * would be wrong from the pty's perspective.
   */
  setServerContext(baseUrl: string | null): void {
    this.serverBaseUrl = baseUrl;
  }

  /** Nebula repo location on the server, for a path-qualified setup command. */
  setRepoRoot(repoRoot: string | null): void {
    this.repoRoot = repoRoot;
  }

  /**
   * Command that registers the Nebula MCP with the agent CLIs. The npx form
   * works on any machine with Node (no repo checkout, no paths) — the
   * nebula-notebook-mcp package is published exactly for this.
   */
  buildSetupMcpCommand(): string {
    return 'npx nebula-notebook-mcp setup-mcp';
  }

  /**
   * Command that installs the `nebula` CLI as a Claude Code skill — the
   * preferred way to teach an EXTERNAL agent (not launched from a Nebula
   * terminal) how to drive notebooks. Lighter than the MCP: no server process,
   * no per-session connect, and every command is scoped to a notebook path.
   */
  buildSetupSkillCommand(): string {
    return 'npx -p nebula-notebook-mcp nebula setup-skill';
  }

  // --- remote-agent mode (run the agent on the user's machine) ---

  /**
   * Remote-agent settings, when the mode is enabled and complete. The agent
   * CLI then runs on the USER'S machine — its RAM and its network (for when
   * the server host is memory-tight or blocks the agent's API) — while its
   * terminal lives in this panel via an `ssh -R` reverse channel carried by
   * the user's own tunnel.
   */
  getRemoteAgentConfig(): { port: number; user: string; localUrl: string } | null {
    const s = getSettings();
    if (!s.remoteAgentEnabled || !s.remoteAgentPort || !s.remoteAgentUser?.trim()) return null;
    return {
      port: s.remoteAgentPort,
      user: s.remoteAgentUser.trim(),
      localUrl: (s.remoteAgentLocalUrl || 'http://localhost:3000').replace(/\/$/, ''),
    };
  }

  /**
   * The tunnel command the user runs ON THEIR machine: their usual -L forward
   * plus the -R reverse channel that lets a Nebula terminal ssh back. It must
   * terminate on the server's host so the pty can reach 127.0.0.1:<port>.
   */
  buildTunnelCommand(serverHost: string | null, serverPort: number | null): string {
    const s = getSettings();
    let localPort = '3000';
    try { localPort = new URL(s.remoteAgentLocalUrl || 'http://localhost:3000').port || '80'; } catch { /* keep default */ }
    const jump = s.remoteAgentJumpHost?.trim() ? ` -J ${s.remoteAgentJumpHost.trim()}` : '';
    const sshPort = s.remoteAgentLocalSshPort ?? 22;
    return `ssh${jump} -L ${localPort}:localhost:${serverPort ?? 3000} -R ${s.remoteAgentPort ?? '<port>'}:localhost:${sshPort} ${serverHost || '<server-host>'}`;
  }

  /**
   * Same tunnel as buildTunnelCommand, but as a Burrow definition — Burrow
   * (macOS menu-bar SSH tunnel manager) then supervises it: auto-connect,
   * auto-reconnect, status dot. One-time add; connect from the menu bar.
   */
  buildBurrowCommand(serverHost: string | null, serverPort: number | null): string {
    const s = getSettings();
    let localPort = '3000';
    try { localPort = new URL(s.remoteAgentLocalUrl || 'http://localhost:3000').port || '80'; } catch { /* keep default */ }
    const jump = s.remoteAgentJumpHost?.trim() ? ` --jump ${s.remoteAgentJumpHost.trim()}` : '';
    const sshPort = s.remoteAgentLocalSshPort ?? 22;
    return `burrow add --name nebula-agent --host ${serverHost || '<server-host>'}${jump} ` +
      `--local ${localPort}:localhost:${serverPort ?? 3000} --remote ${s.remoteAgentPort ?? '<port>'}:localhost:${sshPort}`;
  }

  /**
   * The whole remote-agent setup, written for an AGENT running on the user's
   * own machine to carry out. Most people would rather hand this to their
   * agent than follow a page of instructions — so the text carries THIS
   * installation's real values (host, ports, jump host), both ways to build
   * the tunnel, the step everyone forgets (Remote Login), and how to check
   * the result. It never invents a hostname: unknown values stay as visible
   * placeholders the user can fill in.
   */
  buildRemoteSetupAgentPrompt(serverHost: string | null, serverPort: number | null): string {
    const s = getSettings();
    const host = serverHost || '<server-host>';
    const port = s.remoteAgentPort ?? '<port>';
    const sshPort = s.remoteAgentLocalSshPort ?? 22;
    let localPort = '3000';
    try { localPort = new URL(s.remoteAgentLocalUrl || 'http://localhost:3000').port || '80'; } catch { /* keep default */ }
    const jumpNote = s.remoteAgentJumpHost?.trim()
      ? `\n  The server is reachable only through the jump host \`${s.remoteAgentJumpHost.trim()}\` (already in the commands below).`
      : `\n  If \`${host}\` is not reachable directly from my machine, add a jump host (\`-J <bastion>\` / \`--jump <bastion>\`) and tell me what you used.`;
    return [
      'Please set up "Nebula agent on my machine" for me. I am on macOS; you are running ON my machine.',
      `Nebula runs on the server \`${host}\`. The goal: an SSH tunnel that (a) forwards the Nebula UI to my machine and (b) lets the server reach my machine's sshd on port ${sshPort}, so Nebula can start agents here.`,
      '',
      'Step 1 — create the tunnel. Prefer Burrow (macOS menu-bar SSH manager: supervised, auto-reconnect) if `burrow` is on PATH:',
      `    ${this.buildBurrowCommand(serverHost, serverPort)}`,
      '  then connect it from the Burrow menu bar. If Burrow is not installed, use plain ssh in a terminal that stays open:',
      `    ${this.buildTunnelCommand(serverHost, serverPort)}`,
      jumpNote,
      '',
      `Step 2 — let the server ssh back in. Turn on Remote Login (System Settings → General → Sharing → Remote Login), or \`sudo systemsetup -setremotelogin on\`. Confirm my sshd really listens on port ${sshPort} (\`sudo lsof -iTCP:${sshPort} -sTCP:LISTEN\`); if it does not, tell me — Nebula must be pointed at the real port.`,
      '',
      'Step 3 — authorize the server. The server needs key access to my machine, so it can start agents without a password. This one runs ON THE SERVER, so give me the exact line to paste there once the tunnel is up:',
      `    ssh-copy-id -o ProxyCommand=none -p ${port} $(whoami)@localhost`,
      '',
      'Step 4 — install the Nebula tooling here, so agents on my machine can drive notebooks:',
      `    ${this.buildSetupSkillCommand()}`,
      `    ${this.buildSetupMcpCommand()}`,
      '',
      `Finally, verify and report: the tunnel is connected, \`curl -sf http://localhost:${localPort}/api/health\` answers from my machine, and \`ssh -p ${sshPort} localhost whoami\` works locally. Tell me my username on this machine — Nebula needs it, and it is what \`whoami\` prints. If any step fails, say which one and what the error was rather than working around it.`,
    ].join('\n');
  }

  /**
   * The agent invocation itself. Fresh Claude launches pin a caller-chosen
   * `--session-id` (this notebook's own uuid) so the conversation is
   * independently resumable even when several notebooks share a working
   * directory; resume launches reopen exactly that thread with `--resume <id>`
   * (`--continue` as a fallback if no id is stored) plus a short reorientation
   * prompt. Codex has no equivalent flag; it relaunches fresh.
   *
   * `accessFlags` (pre-quoted, leading-space) grant the real project dir to an
   * agent whose cwd is its workspace mirror; `workdir` rides into the local
   * bootstrap prompt so the agent knows where the project actually lives.
   */
  private buildAgentCommand(kind: 'claude' | 'codex', resume: boolean, envPrefix = '', sessionId?: string, continueProject = false, accessFlags = '', workdir?: string | null): string {
    if (continueProject) {
      // "Pick a session": both open the CLI's own cwd-scoped INTERACTIVE
      // picker (claude --resume with no id; codex resume) — finding every
      // trajectory this project's agents created, including outside Nebula.
      // Deliberately NOT `claude --continue`: that silently grabs the most
      // recent thread, which in a shared cwd may not be yours.
      return kind === 'claude' ? `${envPrefix}claude${accessFlags} --resume` : `${envPrefix}codex resume${accessFlags}`;
    }
    if (resume && kind === 'claude') {
      const reorient = sanitizePromptText(
        'We were disconnected — this is the same Nebula notebook session as before. ' +
        (this.notebookPath ? `Still driving ${this.notebookPath}. ` : '') +
        'Re-read the notebook if you need to re-orient, then continue where you left off.'
      );
      const flag = sessionId ? `--resume ${sessionId}` : '--continue';
      return `${envPrefix}claude${accessFlags} ${flag} ${shellSingleQuote(reorient)}`;
    }
    const bootstrap = shellSingleQuote(this.buildBootstrapPrompt(envPrefix !== '', workdir));
    if (kind === 'claude' && sessionId) {
      return `${envPrefix}claude${accessFlags} --session-id ${sessionId} ${bootstrap}`;
    }
    return `${envPrefix}${kind}${accessFlags} ${bootstrap}`;
  }

  /**
   * The line typed into the Nebula terminal to start the agent on the user's
   * machine: ssh back over the reverse channel, set NEBULA_URL as seen from
   * there, run the agent with the bootstrap prompt as its first argument.
   * accept-new pins the host key on first use without an interactive prompt.
   */
  buildRemoteLaunchCommand(kind: 'claude' | 'codex', resume = false, sessionId?: string, continueProject = false, workdir?: string | null, mirrorSlug?: string | null): string | null {
    const cfg = this.getRemoteAgentConfig();
    if (!cfg) return null;
    // The project lives on the SERVER, so its folder doesn't exist on the
    // user's machine — mirror it: each server project gets its own stable
    // scratch dir there (`~/.nebula/agent/p-<hash>-<name>`), derived
    // deterministically from the server workdir. That makes remote agents
    // behave like local ones for project/context management: per-project
    // trajectories, `--continue` scoped to the project, hibernate/revive.
    // (Legacy fallback: the old shared dir when no workdir is known.)
    // A record-pinned slug wins over re-derivation — stored paths don't drift.
    const slug = mirrorSlug || (workdir ? remoteMirrorSlug(workdir) : null);
    const cwd = slug ? `"$HOME/.nebula/agent/${slug}"` : '"$HOME/.nebula/agent"';
    // Nebula-scoped sign-in token: the setup dialog has users store the token
    // as CLAUDE_CODE_OAUTH_TOKEN_NEBULA so their OWN interactive claude
    // sessions keep using their normal login; only this launch maps it to the
    // real variable, and only when set (legacy plain-var setups untouched).
    const tokenMap = kind === 'claude'
      ? '[ -z "$CLAUDE_CODE_OAUTH_TOKEN_NEBULA" ] || export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN_NEBULA"; '
      : '';
    const agentCmd = tokenMap + `mkdir -p ${cwd} && cd ${cwd} && ` +
      this.buildAgentCommand(kind, resume, `NEBULA_URL=${cfg.localUrl} `, sessionId, continueProject);
    // `ssh host cmd` runs a non-login, non-interactive shell on the user's
    // machine — PATH additions from .zprofile/.zshrc (homebrew, nvm, npm -g)
    // are absent and the agent CLI isn't found. Re-enter the user's own shell
    // as login+interactive so their PATH is what their terminals see.
    const remoteCmd = `exec "$SHELL" -l -i -c ${shellSingleQuote(agentCmd)}`;
    // ProxyCommand=none: IPA/SSSD-managed clusters wrap ALL ssh in
    // sss_ssh_knownhostsproxy via the system ssh_config, which breaks a plain
    // loopback hop — this connection must go straight to 127.0.0.1:<port>.
    // ServerAlive*: a tunnel that dies without a TCP reset would otherwise
    // leave this hop hung FOREVER (frozen TUI, no exit for the liveness
    // machinery to see); keepalives turn that into a clean exit within ~60s.
    return `ssh -t -p ${cfg.port} -o ProxyCommand=none -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=4 ${cfg.user}@localhost ${shellSingleQuote(remoteCmd)}`;
  }

  /**
   * The line typed into the terminal to start the agent ON THIS SERVER — the
   * same placement rule as remote launches: the agent process runs in its own
   * workspace dir (`~/.nebula/agent/p-<hash>-<name>`), never in the real
   * project dir. The CLIs key their conversation history to their cwd, so
   * agent chats launched in real project dirs would pollute those projects'
   * own trajectory history. Project access is granted explicitly instead:
   * `--add-dir` for claude, a sandbox writable-roots override for codex.
   * Resume/continue also run from the mirror — that's where the sessions
   * live. (Legacy fallback: the old shared dir when no workdir is known.)
   */
  buildLocalLaunchCommand(kind: 'claude' | 'codex', resume = false, sessionId?: string, continueProject = false, workdir?: string | null, mirrorSlug?: string | null, legacyRealCwd?: string | null): string {
    // LEGACY-COMPAT(2026-07): remove with TerminalPanel's legacyRealCwd.
    // Records from before the mirror-cwd change hold
    // conversations keyed to the REAL project dir — resume them from there
    // (moving transcripts inside ~/.claude would be invasive and could sweep
    // up the user's own CLI sessions). New sessions always use the mirror,
    // so legacy placements age out on their own.
    const slug = legacyRealCwd ? null : (mirrorSlug || (workdir ? remoteMirrorSlug(workdir) : null));
    const cwd = legacyRealCwd
      ? `"${legacyRealCwd.replace(/"/g, '\\"')}"`
      : slug ? `"$HOME/.nebula/agent/${slug}"` : '"$HOME/.nebula/agent"';
    // Only absolute paths can be granted verbatim ('~' would pass literally
    // inside quotes); non-absolute scopes just fall back to the CLIs' own
    // ask/deny rules for paths outside the cwd.
    const accessFlags = workdir?.startsWith('/')
      ? (kind === 'claude'
        ? ` --add-dir ${shellSingleQuote(workdir)}`
        : ` -c ${shellSingleQuote(`sandbox_workspace_write.writable_roots=[${JSON.stringify(workdir)}]`)}`)
      : '';
    const inner = `mkdir -p ${cwd} && cd ${cwd} && ` +
      this.buildAgentCommand(kind, resume, '', sessionId, continueProject, accessFlags, workdir);
    // Re-enter the user's login+interactive shell AT LAUNCH TIME (same wrapper
    // remote launches use): a pty's env is frozen when its shell starts, so a
    // long-lived pty predating an env change (agent auth tokens, PATH) would
    // launch agents with stale env forever — the "Continue needs /login but
    // hibernate+continue doesn't" mystery. Runs as a child (no exec): the
    // original shell survives the agent's exit.
    return `"$SHELL" -l -i -c ${shellSingleQuote(inner)}`;
  }

  /**
   * Orientation prompt handed to a freshly started agent: which server to
   * connect_server to (the MCP intentionally ignores env config and requires
   * an explicit base_url per session) and which notebook this tab is driving.
   * `remote` = the agent runs on the user's machine (remote-agent mode), so
   * URLs must be the ones visible from THERE (the -L forward), and `nebula`
   * may not be on PATH. `scratchWorkdir` = the real project dir when a local
   * launch parked the agent's shell in its workspace mirror, so the prompt
   * can point back at the project.
   */
  buildBootstrapPrompt(remote = false, scratchWorkdir?: string | null): string {
    const cfg = remote ? this.getRemoteAgentConfig() : null;
    const baseUrl = remote ? (cfg?.localUrl || 'http://localhost:3000') : this.serverBaseUrl;
    const parts: string[] = ['You are driving a Nebula notebook.'];
    // CLI-first: Nebula terminals have the `nebula` CLI on PATH with
    // NEBULA_URL pre-set — cheaper and more composable for shell-capable
    // agents than loading the MCP toolset. MCP remains the fallback.
    parts.push(
      (remote
        ? `PREFERRED: use the \`nebula\` CLI (NEBULA_URL is already set to ${baseUrl}, your SSH-forwarded Nebula server; notebook paths are paths on the SERVER, not this machine). ` +
          'Your shell here runs in a scratch dir on your own machine — the notebook and its data files live on the server, reachable only through nebula. ' +
          'If `nebula` is not on PATH, use `npx -p nebula-notebook-mcp nebula …`. '
        : 'PREFERRED: use the `nebula` CLI available in this terminal (NEBULA_URL is already set). ' +
          (scratchWorkdir
            ? `The project lives at ${scratchWorkdir}; your shell is in a scratch workspace, not the project dir — use absolute paths (or the nebula CLI) to work with its files. `
            : '')) +
      'Start with `nebula --help`; key commands: `nebula nb read <path>` (list cells), ' +
      '`nebula run <path> <cell-id>` (execute AND get output in one call), ' +
      '`nebula nb edit <path> <cell-id> -` (content from stdin; or --content \'…\'), `nebula nb search <path> <query>`, ' +
      '`nebula kernel status|restart|interrupt <path>`. ' +
      // Without this, a REMOTE-mode agent (running on the user's machine) that
      // receives a server path reaches for its own Read/cat tool, which fails:
      // the file is on the Nebula server, not its filesystem.
      'For NON-notebook files on the server (data, logs, scripts): `nebula fs ls|cat|download|upload <path>` — ' +
      'a path that starts at the server root is on the SERVER; do not assume your local filesystem has it. ' +
      // Observed failure: an agent's first write was rejected for lack of a
      // session, costing a confused retry. Name the requirement up front.
      'Before your first notebook WRITE, run `nebula session start <path>` (takes the agent lock; the ' +
      'browser shows an "agent session" badge) and `nebula session end <path>` when done. ' +
      'To REPLACE an existing server file, `nebula fs write` overwrites; `nebula fs upload` refuses a name ' +
      'collision unless you pass --overwrite (or --rename to keep both). ' +
      'Exit code 9 = edit conflict (the current content is printed — retry against it). ' +
      // Observed failure: an agent believed notebook cell source lived only
      // "inside Nebula" and tried to ferry edited source back through the
      // KERNEL — base64-chunked through stdout, one chunk per run — looping
      // ~20 executions without ever writing the cell. State the invariant.
      'IMPORTANT — cell source is plain data in the notebook file: `nebula nb read` returns it and ' +
      '`nebula nb edit` writes it directly. NEVER move cell content through the kernel (no printing/' +
      'base64/chunked transfer of source, no helper cells that emit code): to change a cell, just call ' +
      '`nebula nb edit`. Executing a cell repeatedly without an intervening edit makes no progress — ' +
      'if a command did not do what you expected, re-read its --help instead of re-running it. ' +
      'For long-running cells: `nebula run` blocks until the cell finishes — launch it as a background shell task ' +
      '(`--max-wait 0` = no time limit) and the process exit is your completion signal; never poll.'
    );
    parts.push(
      `FALLBACK (only if the nebula CLI is missing): use the nebula-notebook MCP tools — register with ` +
      `${this.buildSetupMcpCommand()} and restart this CLI` +
      (!remote && this.repoRoot ? ` (the server's Nebula repo is at ${this.repoRoot} if you need the source)` : '') +
      (baseUrl
        ? `, then call connect_server with base_url ${baseUrl}; if that URL is not reachable from this machine, ask the user for the correct Nebula server URL.`
        : ', then call connect_server with this Nebula server’s base_url (ask the user for it).')
    );
    if (this.notebookPath) {
      parts.push(`This session is for the notebook ${this.notebookPath} — operate on that notebook unless told otherwise.`);
      parts.push('Read it now (nebula nb read) to get oriented, then confirm you are ready.');
    } else {
      parts.push('No notebook is open yet; confirm you are ready and wait for instructions.');
    }
    // Shared agents serve several notebooks from one conversation: the UI
    // tags messages when the driving notebook changes.
    parts.push(
      'If a message begins with "[now driving: <path>]", the user has switched notebooks — ' +
      'operate on that notebook from then on (nebula commands always take explicit paths).'
    );
    return sanitizePromptText(parts.join(' '));
  }

  // --- state / subscription (for React UIs) ---

  getState(): Readonly<AgentState> {
    return this.state;
  }

  /** Where the agent runs — server-side, or the user's machine over the tunnel. */
  private where(): 'mine' | 'server' {
    return this.getRemoteAgentConfig() ? 'mine' : 'server';
  }

  /** Storage key for this notebook's Claude session id at the current location. */
  private sessionKey(terminalId: string): string {
    return `${terminalId}:${this.where()}`;
  }

  /** Adopt a resume pointer from the server-side agent record, so "Resume"
   *  works in a browser that never launched this agent. */
  adoptSessionId(terminalId: string, sessionId: string): void {
    writeAgentSessionId(`${terminalId}:${this.where()}`, sessionId);
  }

  /** 'claude' when this notebook has a stored session to resume at this location. */
  getResumableKind(): 'claude' | null {
    return this.state.terminalId && readAgentSessionId(this.sessionKey(this.state.terminalId)) ? 'claude' : null;
  }

  isConnected(): boolean {
    return !!(this.state.terminalId && this.senders.has(this.state.terminalId));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  // --- actions ---

  openPanel(): void {
    this.panelOpener?.();
  }

  /**
   * Type the agent launch command into the terminal on the user's behalf.
   * The bootstrap context (server URL + notebook path) rides along as the
   * CLI's initial prompt argument, so the agent starts by connecting to the
   * right server and reading the right notebook — no guessing across tabs.
   */
  launchAgent(kind: 'claude' | 'codex', opts: { resume?: boolean; continueProject?: boolean; workdir?: string | null; mirrorSlug?: string | null; legacyRealCwd?: string | null } = {}): SendResult {
    const send = this.getAgentSender();
    if (!send.ok) return send;
    this.lastLaunchKind = kind;
    const resume = !!opts.resume;
    const continueProject = !!opts.continueProject;
    // Per-notebook Claude session id: a fresh launch mints and stores a new one;
    // resume reuses the stored one. Keyed by run location (server vs. the user's
    // machine) since those conversations live on different hosts.
    let sessionId: string | undefined;
    if (kind === 'claude' && this.state.terminalId && !continueProject) {
      const key = this.sessionKey(this.state.terminalId);
      if (resume) {
        sessionId = readAgentSessionId(key) ?? undefined;
      } else {
        sessionId = newSessionUuid();
        writeAgentSessionId(key, sessionId);
      }
    }
    // Remote-agent mode: the launch line hops back to the user's machine over
    // the reverse SSH channel and runs the agent there instead. Either way the
    // agent process itself runs in its `~/.nebula/agent/p-…` workspace mirror,
    // never in the real project dir.
    const remoteLine = this.buildRemoteLaunchCommand(kind, resume, sessionId, continueProject, opts.workdir, opts.mirrorSlug);
    const launchLine = remoteLine ?? this.buildLocalLaunchCommand(kind, resume, sessionId, continueProject, opts.workdir, opts.mirrorSlug, opts.legacyRealCwd);
    // Type a given launch line ONCE per pty per window. A second copy is never
    // useful: it lands inside the TUI the first one just opened (becoming a
    // chat message), or starts a second agent in the same terminal. Guards
    // every double-fire source at once — a re-run effect, a double click, two
    // attach paths racing on connect — instead of chasing them individually.
    const now = Date.now();
    const dup = this.lastLaunchSent;
    if (dup && dup.terminalId === this.state.terminalId && dup.line === launchLine &&
        now - dup.at < LAUNCH_DEDUPE_MS) {
      return { ok: true };
    }
    this.lastLaunchSent = { terminalId: this.state.terminalId, line: launchLine, at: now };
    // Remote launches: hand the user's machine a credential first, so the
    // agent's CLI authenticates regardless of where its tunnel terminates.
    // Best-effort — the launch line is typed either way (the CLI still has
    // the loopback piggyback when the topology allows it).
    if (remoteLine) void pushRemoteAgentToken();
    send.sender(`${launchLine}\r`);
    markOnboardingStep('launchedAgent');
    // Project-scoped agent ledger: tell the server what launched where, and
    // make this the browser's active agent (agents are decoupled from
    // notebooks; the active pointer is what the Agent tab attaches to).
    if (this.state.terminalId) {
      setActiveAgentId(this.state.terminalId);
      void registerAgent({
        terminalId: this.state.terminalId,
        kind,
        workdir: opts.workdir || '~',
        location: this.getRemoteAgentConfig() ? 'remote' : 'server',
        sessionId,
        launchedFrom: this.notebookPath ?? undefined,
        // Pin the mirror slug: record-driven resumes must keep finding this
        // conversation even if the slug derivation changes in a future build.
        // Legacy resumes keep the record slug-less so they KEEP resuming from
        // the real dir where their conversation lives.
        mirrorSlug: opts.legacyRealCwd ? undefined : (opts.workdir ? remoteMirrorSlug(opts.workdir) : undefined),
      });
    }
    // Report 'running' optimistically, then confirm via the output watcher: it
    // flips to 'failed' if the TUI never appears (or a known error prints), and
    // later to stopped when the agent exits back to the shell.
    this.state = { ...this.state, status: 'running', agentKind: kind, launchError: undefined };
    if (this.state.terminalId) writeAgentFlag(this.state.terminalId, kind);
    // The bootstrap/reorient prompt already names the current notebook.
    this.lastTaggedNotebook = this.notebookPath;
    this.startLaunchWatch(kind);
    this.notify();
    return { ok: true };
  }

  private clearWatch(): void {
    if (this.launchWatch?.timer) clearTimeout(this.launchWatch.timer);
    this.launchWatch = null;
    if (this.teardownGraceTimer) { clearTimeout(this.teardownGraceTimer); this.teardownGraceTimer = null; }
  }

  /** Watch a just-launched agent: confirm its TUI comes up, else fail it. */
  private startLaunchWatch(kind: AgentKind): void {
    this.clearWatch();
    const terminalId = this.state.terminalId;
    if (!terminalId) return;
    // Positive check: no TUI within the window ⇒ the agent never came up (a
    // silent failure the error-regex didn't name). More reliable than only
    // watching for known error strings. BUT escape-inference has blind spots
    // (a TUI that was already drawn emits no new init; boot escapes scroll out
    // of replay), so before declaring death, ask the tty foreground: a busy pty
    // means something IS running — adopt it instead of failing (lab report:
    // a live resumed codex was declared "didn't start", then fed a launch line).
    const timer = setTimeout(() => {
      if (this.launchWatch?.phase !== 'launch') return;
      void probeTerminalBusy(terminalId).then((busy) => {
        const w = this.launchWatch;
        if (w?.phase !== 'launch') return; // resolved meanwhile
        if (busy === true) {
          // Confirmed up by the foreground probe (status is already 'running'
          // optimistically) — switch to exit-watching like a seen TUI-init.
          if (w.timer) { clearTimeout(w.timer); w.timer = null; }
          w.phase = 'run';
          w.raw = '';
        } else {
          this.markLaunchFailed('the agent did not start (no interface appeared)');
        }
      });
    }, LAUNCH_WATCH_MS);
    this.launchWatch = { terminalId, kind, phase: 'launch', raw: '', timer };
  }

  /** Watch an already-running agent (restored after refresh/switch) for exit. */
  private armExitWatch(terminalId: string, kind: AgentKind): void {
    this.clearWatch();
    this.launchWatch = { terminalId, kind, phase: 'run', raw: '', timer: null };
  }

  /**
   * Fed every PTY output chunk by the terminal view. In 'launch' phase: confirm
   * the agent's TUI appeared (positive) or catch an explicit error. Once up, in
   * 'run' phase: detect the TUI tearing down = the agent quit back to the shell
   * (the pty lives on, so no exit event fires) so the UI stops showing "active"
   * and offers Resume.
   */
  observeOutput(terminalId: string, data: string): void {
    // Self-healing invariant: a TUI initializing on the DESIGNATED agent pty
    // means an agent is up — whatever we believed. Recovers from a premature
    // no-TUI verdict (remote launches: ssh handshake + login shell + CLI boot
    // can outrun the watch window, and 'failed' used to be terminal), and
    // from agents started by hand in the pty.
    if (
      terminalId === this.state.terminalId &&
      this.state.status !== 'running' &&
      TUI_INIT_RE.test(data)
    ) {
      this.adoptRunningState(this.lastLaunchKind === 'codex' ? 'codex' : 'claude');
      return;
    }
    const w = this.launchWatch;
    if (!w || this.state.status !== 'running' || w.terminalId !== terminalId) return;
    // Keep the tail UNstripped — the private-mode escapes are the signal.
    w.raw = (w.raw + data).slice(-4000);
    if (w.phase === 'launch') {
      const stripped = w.raw.replace(ANSI_RE, '');
      const failMatch = stripped.match(LAUNCH_FAILURE_RE);
      if (failMatch) {
        // Excerpt FROM the match, not the whole line: the rolling buffer can
        // slice an escape sequence at its edge, leaving fragments ("78No
        // conversation found…") that ANSI stripping can't recognize.
        const from = stripped.slice(stripped.indexOf(failMatch[0]));
        const line = (from.split('\n')[0] || '').trim();
        // `--continue` with no prior conversation is NOT an install problem —
        // the CLI ran fine and said so. Route to the accurate next step.
        if (/no conversation found/i.test(line)) {
          this.markLaunchFailed('no previous conversation in this directory — start a fresh agent instead (Claude Code / Codex)');
          return;
        }
        this.markLaunchFailed(line.slice(0, MAX_ERROR_EXCERPT_CHARS) || 'launch failed');
        return;
      }
      if (TUI_INIT_RE.test(w.raw)) {
        // Confirmed up. Keep watching (no timer) for a later exit-to-shell.
        if (w.timer) { clearTimeout(w.timer); w.timer = null; }
        w.phase = 'run';
        w.raw = '';
      }
      return;
    }
    // phase 'run': a teardown only counts as an exit if no TUI re-appears
    // shortly after. Screen TRANSITIONS also emit teardown+init pairs — the
    // `claude --resume` session picker tearing down before the chosen session's
    // TUI starts was read as "exited to shell", leaving resumed agents in
    // limbo until the user clicked "already running".
    if (TUI_INIT_RE.test(w.raw)) {
      if (this.teardownGraceTimer) { clearTimeout(this.teardownGraceTimer); this.teardownGraceTimer = null; }
      w.raw = '';
      return;
    }
    if (TUI_TEARDOWN_RE.test(w.raw)) {
      w.raw = '';
      if (this.teardownGraceTimer) return; // already counting down
      this.teardownGraceTimer = setTimeout(() => {
        this.teardownGraceTimer = null;
        this.markStopped();
      }, 2000);
    }
  }

  private markLaunchFailed(reason: string): void {
    this.clearWatch();
    if (this.state.terminalId) writeAgentFlag(this.state.terminalId, null);
    this.state = { ...this.state, status: 'failed', agentKind: null, launchError: reason };
    this.notify();
  }

  /**
   * User already started an agent in the terminal by hand. Inject the same
   * bootstrap context the launch chips provide, so a manually started agent
   * still learns which server and notebook this tab is driving.
   */
  /**
   * Adopt "running" from a server-side agent record (state==='live') when
   * attaching in a browser that never launched this agent — the sessionStorage
   * running-flag is per-browser, but the record knows the pty hosts a live
   * agent, so the launch bar must not render over its TUI.
   */
  adoptRunningState(kind: AgentKind): void {
    if (this.state.status === 'running') return;
    if (this.state.terminalId) this.armExitWatch(this.state.terminalId, kind);
    this.state = { ...this.state, status: 'running', agentKind: kind, launchError: undefined };
    if (this.state.terminalId) writeAgentFlag(this.state.terminalId, kind);
    this.lastTaggedNotebook = this.notebookPath;
    this.notify();
  }

  async markRunning(): Promise<void> {
    // User-asserted ground truth ("my agent IS running here") — but verify
    // against the tty foreground first: busy === false is DEFINITIVE (the
    // foreground is a bare shell), and injecting the bootstrap into a bare
    // shell would EXECUTE it as shell commands. Unknown (null) trusts the user.
    const terminalId = this.state.terminalId;
    if (terminalId) {
      const busy = await probeTerminalBusy(terminalId);
      if (busy === false) {
        this.state = {
          ...this.state, status: 'failed', agentKind: null,
          launchError: 'nothing is running in this terminal — start the agent below first, then mark it active',
        };
        this.notify();
        return;
      }
    }
    markOnboardingStep('launchedAgent');
    // Manually started: assume it's up and watch for it exiting to the shell.
    if (this.state.terminalId) this.armExitWatch(this.state.terminalId, 'manual');
    this.state = { ...this.state, status: 'running', agentKind: 'manual', launchError: undefined };
    if (this.state.terminalId) writeAgentFlag(this.state.terminalId, 'manual');
    this.notify();
    this.sendPrompt(this.buildBootstrapPrompt());
  }

  /**
   * Escape hatch for a remote agent whose ssh transport hung (tunnel dropped
   * without a TCP reset): the TUI freezes, no teardown sequence ever arrives,
   * and the status stays 'running' forever. Types ssh's client-side escape
   * (`~.` at line start — honored even when the connection is dead) to kill
   * the hop, then resets state so the launch bar comes back.
   */
  breakRemoteConnection(): void {
    const sender = this.state.terminalId ? this.senders.get(this.state.terminalId) : undefined;
    if (sender) sender('\r~.');
    this.markStopped();
  }

  /** Agent exited (user quit it, or terminal process ended). */
  markStopped(): void {
    this.clearWatch();
    // Clear the "running" flag; the resume pointer (the stored session id)
    // deliberately persists so the stopped conversation stays resumable.
    if (this.state.terminalId) writeAgentFlag(this.state.terminalId, null);
    if (this.state.status === 'none') return;
    this.state = { ...this.state, status: 'none', agentKind: null, launchError: undefined };
    this.notify();
  }

  /**
   * Inject a prompt into the running agent. Sanitizes to a single line, writes
   * the text, then submits with Enter after a short delay.
   */
  sendPrompt(rawPrompt: string): SendResult {
    if (this.state.status !== 'running') {
      this.openPanel();
      return { ok: false, reason: 'agent-not-running' };
    }
    const send = this.getAgentSender();
    if (!send.ok) return send;

    const prompt = sanitizePromptText(rawPrompt);
    if (!prompt) return { ok: true }; // nothing to send

    send.sender(prompt);
    const terminalId = this.state.terminalId;
    setTimeout(() => {
      // Re-resolve at submit time: terminal may have closed in the interim.
      const sender = terminalId ? this.senders.get(terminalId) : undefined;
      sender?.('\r');
    }, ENTER_DELAY_MS);
    return { ok: true };
  }

  /** Compose + send a "fix this cell's error" prompt. */
  sendFixPrompt(args: { cellNumber: number; cellId: string; errorContent: string }): SendResult {
    const excerpt = sanitizeErrorExcerpt(args.errorContent);
    const where = this.notebookPath ? `notebook ${this.notebookPath}` : 'the open notebook';
    return this.sendPrompt(
      `In ${where}, cell ${args.cellNumber} (id ${args.cellId}) failed with: ${excerpt} — ` +
      `use the nebula CLI (nebula nb read / nebula run <path> <cell-id>; fall back to the ` +
      `nebula-notebook MCP tools only if the CLI is unavailable) to read the cell and its full ` +
      `error output, fix the cell, and re-run it to verify the fix.`
    );
  }

  /** Compose + send a free-form per-cell prompt. */
  sendCellPrompt(args: { cellNumber: number; cellId: string; prompt: string }): SendResult {
    const where = this.notebookPath ? `notebook ${this.notebookPath}` : 'the open notebook';
    return this.sendPrompt(
      `In ${where}, regarding cell ${args.cellNumber} (id ${args.cellId}): ${args.prompt} — ` +
      `use the nebula CLI (nebula nb read / nebula nb edit / nebula run; fall back to the ` +
      `nebula-notebook MCP tools only if the CLI is unavailable) to read and edit the notebook; ` +
      `re-run the cell if you change it.`
    );
  }

  private getAgentSender(): { ok: true; sender: Sender } | { ok: false; reason: 'no-terminal' | 'not-connected' } {
    const id = this.state.terminalId;
    if (!id) {
      this.openPanel();
      return { ok: false, reason: 'no-terminal' };
    }
    const sender = this.senders.get(id);
    if (!sender) {
      this.openPanel();
      return { ok: false, reason: 'not-connected' };
    }
    // Wrap so a closed WS reports not-connected instead of silently dropping.
    return {
      ok: true,
      sender: (data: string) => sender(data),
    };
  }
}

/** POSIX single-quote: safe for paths/URLs with spaces or shell metacharacters. */
export function shellSingleQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Collapse to one line: raw newlines in pty stdin submit TUI prompts early. */
export function sanitizePromptText(text: string): string {
  return text
    .replace(ANSI_RE, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** First meaningful line of an error (ANSI-stripped), truncated. */
export function sanitizeErrorExcerpt(errorContent: string): string {
  const cleaned = (errorContent || '').replace(ANSI_RE, '');
  // Prefer the last non-empty line: for Python tracebacks that's the
  // `ExceptionType: message` line, the most informative single line.
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
  const last = lines.length > 0 ? lines[lines.length - 1] : '';
  const oneLine = sanitizePromptText(last || cleaned);
  return oneLine.length > MAX_ERROR_EXCERPT_CHARS
    ? `${oneLine.slice(0, MAX_ERROR_EXCERPT_CHARS)}…`
    : oneLine;
}

export const agentTerminalService = new AgentTerminalService();

// Vite HMR: this module holds live singleton state (registered pty senders,
// agent status). Without self-accept, editing any importer chain re-instantiates
// the service mid-session — components end up talking to a fresh instance with
// no senders ("no agent running" despite a live agent). Self-accepting keeps
// the existing instance until a full reload.
if ((import.meta as { hot?: { accept: () => void } }).hot) {
  (import.meta as unknown as { hot: { accept: () => void } }).hot.accept();
}
