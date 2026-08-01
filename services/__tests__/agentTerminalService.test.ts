import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  agentTerminalService,
  sanitizePromptText,
  sanitizeErrorExcerpt,
  shellSingleQuote,
} from '../agentTerminalService';

// Process-table probe stub: null = unknown (claims nothing) so existing tests
// keep their behavior; individual tests flip it to true to simulate a pty
// that actually hosts a running process.
let busyStub: boolean | null = null;
vi.mock('../agentRegistryService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agentRegistryService')>()),
  registerAgent: vi.fn(async () => {}),
  probeTerminalBusy: vi.fn(async () => busyStub),
}));

/** Invert the launch-time login-shell wrapper ("$SHELL" -l -i -c '…') so
 *  tests keep asserting the inner command contract without escaping noise. */
const unwrapLogin = (line: string): string => {
  const body = line.endsWith('\r') ? line.slice(0, -1) : line;
  const m = body.match(/^"\$SHELL" -l -i -c '([\s\S]*)'$/);
  return (m ? m[1].replace(/'\\''/g, "'") : body) + (line.endsWith('\r') ? '\r' : '');
};

describe('sanitizePromptText', () => {
  it('collapses newlines and tabs to single spaces (raw \\n would submit a TUI prompt early)', () => {
    expect(sanitizePromptText('fix\nthis\r\nerror\tnow')).toBe('fix this error now');
  });

  it('strips ANSI escape sequences', () => {
    expect(sanitizePromptText('\x1b[31mNameError\x1b[0m: x is not defined')).toBe(
      'NameError: x is not defined'
    );
  });

  it('collapses repeated spaces and trims', () => {
    expect(sanitizePromptText('  a   b  ')).toBe('a b');
  });
});

describe('sanitizeErrorExcerpt', () => {
  it('takes the last non-empty line of a traceback (the ExceptionType: message line)', () => {
    const tb = 'Traceback (most recent call last):\n  File "x.py", line 1\n    foo()\nNameError: name \'foo\' is not defined\n';
    expect(sanitizeErrorExcerpt(tb)).toBe("NameError: name 'foo' is not defined");
  });

  it('strips ANSI codes from kernel error output', () => {
    const tb = 'line1\n\x1b[0;31mZeroDivisionError\x1b[0m: division by zero';
    expect(sanitizeErrorExcerpt(tb)).toBe('ZeroDivisionError: division by zero');
  });

  it('truncates very long error lines', () => {
    const excerpt = sanitizeErrorExcerpt('E: ' + 'x'.repeat(1000));
    expect(excerpt.length).toBeLessThanOrEqual(281); // cap + ellipsis
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('handles empty input', () => {
    expect(sanitizeErrorExcerpt('')).toBe('');
  });
});

describe('shellSingleQuote', () => {
  it('wraps in single quotes and escapes embedded single quotes', () => {
    expect(shellSingleQuote("it's a $TEST `with` stuff")).toBe("'it'\\''s a $TEST `with` stuff'");
  });
});

describe('agentTerminalService prompt injection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    agentTerminalService.setAgentTerminal('t1');
  });

  afterEach(() => {
    vi.useRealTimers();
    agentTerminalService.unregisterSender('t1');
    agentTerminalService.setAgentTerminal(null);
    agentTerminalService.setNotebookContext(null);
    agentTerminalService.setServerContext(null);
    agentTerminalService.setRepoRoot(null);
    agentTerminalService.setPanelOpener(null);
    window.sessionStorage.clear();
  });

  it('uses the machine-agnostic npx setup command, with server repo path as context', () => {
    agentTerminalService.setRepoRoot('/srv/my nebula');
    expect(agentTerminalService.buildSetupMcpCommand()).toBe('npx nebula-notebook-mcp setup-mcp');
    const prompt = agentTerminalService.buildBootstrapPrompt();
    expect(prompt).toContain('npx nebula-notebook-mcp setup-mcp');
    expect(prompt).toContain('/srv/my nebula');
  });

  it('restores running status when the sender re-registers (panel closed and reopened)', () => {
    agentTerminalService.registerSender('t1', () => true);
    agentTerminalService.launchAgent('claude');

    // Panel closes: WS drops — status survives (pty is alive server-side).
    agentTerminalService.unregisterSender('t1');
    expect(agentTerminalService.getState().status).toBe('running');

    // Panel reopens: sender re-registers for the still-designated terminal.
    agentTerminalService.registerSender('t1', () => true);
    expect(agentTerminalService.getState().status).toBe('running');
    expect(agentTerminalService.getState().agentKind).toBe('claude');
  });

  it('restores running status after a refresh (same named terminal, new page)', () => {
    agentTerminalService.registerSender('t1', () => true);
    agentTerminalService.launchAgent('claude');
    expect(agentTerminalService.getState().status).toBe('running');

    // Simulate refresh: WS closes, designation drops, then the new page
    // reattaches to the SAME named terminal id.
    agentTerminalService.unregisterSender('t1');
    agentTerminalService.setAgentTerminal(null);
    agentTerminalService.setAgentTerminal('t1');

    expect(agentTerminalService.getState().status).toBe('running');
    expect(agentTerminalService.getState().agentKind).toBe('claude');
  });

  it('does not restore after an explicit stop (flag cleared)', () => {
    agentTerminalService.registerSender('t1', () => true);
    agentTerminalService.launchAgent('codex');
    agentTerminalService.markStopped();

    agentTerminalService.setAgentTerminal(null);
    agentTerminalService.setAgentTerminal('t1');
    expect(agentTerminalService.getState().status).toBe('none');
  });

  it('refuses to inject when no agent was launched (would type into a bare shell)', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });

    const result = agentTerminalService.sendPrompt('echo pwned');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('agent-not-running');
    expect(sent).toHaveLength(0);
  });

  it('opens the panel when asked to send with no agent running', () => {
    const opener = vi.fn();
    agentTerminalService.setPanelOpener(opener);
    agentTerminalService.sendPrompt('hello');
    expect(opener).toHaveBeenCalled();
  });

  it('"pick a session" opens the interactive picker (claude --resume), never --continue', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });
    agentTerminalService.launchAgent('claude', { continueProject: true });
    expect(sent[0]).toContain('claude');
    expect(sent[0]).toContain('--resume');
    expect(sent[0]).not.toContain('--continue');
  });

  it('tags the driving notebook when it changes while an agent is live, once per switch', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });
    agentTerminalService.setNotebookContext('/a/nb1.ipynb');
    agentTerminalService.launchAgent('claude');
    const launchCount = sent.length;

    agentTerminalService.setNotebookContext('/a/nb2.ipynb');
    expect(sent[launchCount]).toBe('[now driving: /a/nb2.ipynb] ');
    expect(sent[launchCount].endsWith('\r')).toBe(false); // prefill, not submit

    // Same notebook again — no duplicate tag
    agentTerminalService.setNotebookContext('/a/nb2.ipynb');
    expect(sent).toHaveLength(launchCount + 1);
  });

  it('does not tag when no agent is running', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });
    agentTerminalService.setNotebookContext('/a/nb1.ipynb');
    agentTerminalService.setNotebookContext('/a/nb2.ipynb');
    expect(sent).toHaveLength(0);
  });

  it('legacy records (no pinned mirror slug) resume from their REAL workdir', () => {
    const line = agentTerminalService.buildLocalLaunchCommand(
      'claude', true, 'sess-123', false, '/home/u/real proj', null, '/home/u/real proj'
    );
    expect(line).toContain('cd "/home/u/real proj"');
    expect(line).not.toContain('.nebula/agent/p-');
    expect(line).toContain('--resume sess-123');
  });

  it('resume without a stored id continues the mirror cwd directly (no picker)', () => {
    // One agent per mirror dir ⇒ --continue's "most recent here" is exact.
    const line = agentTerminalService.buildLocalLaunchCommand(
      'claude', true, undefined, false, '/w/proj', 'p-abc123-proj'
    );
    expect(line).toContain('--continue');
    expect(line).not.toContain('--resume');
    expect(line).toContain('.nebula/agent/p-abc123-proj');
  });

  it('records with a pinned slug resume from the pinned mirror dir', () => {
    const line = agentTerminalService.buildLocalLaunchCommand(
      'claude', true, 'sess-123', false, '/home/u/proj', 'p-cafe01-proj'
    );
    expect(line).toContain('.nebula/agent/p-cafe01-proj');
  });

  it('bootstrap prompt explains the [now driving:] convention', () => {
    expect(agentTerminalService.buildBootstrapPrompt()).toContain('now driving');
  });

  it('adoptRunningState marks a record-live agent as running (cross-browser attach)', () => {
    agentTerminalService.registerSender('t1', () => true);
    expect(agentTerminalService.getState().status).toBe('none');
    agentTerminalService.adoptRunningState('claude');
    expect(agentTerminalService.getState().status).toBe('running');
    expect(agentTerminalService.getState().agentKind).toBe('claude');
  });

  it('sends sanitized text first, then Enter after a delay', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });
    agentTerminalService.launchAgent('claude');
    expect(sent).toHaveLength(1);

    const result = agentTerminalService.sendPrompt('fix\nthe error');
    expect(result.ok).toBe(true);
    expect(sent[1]).toBe('fix the error');

    vi.advanceTimersByTime(200);
    expect(sent[2]).toBe('\r');
  });

  it('launch command carries server URL + notebook path as a quoted bootstrap prompt', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });
    agentTerminalService.setServerContext('http://localhost:8000');
    agentTerminalService.setNotebookContext("/tmp/my analysis's.ipynb");

    agentTerminalService.launchAgent('claude');
    expect(sent[0]).toMatch(/^"\$SHELL" -l -i -c '/); // login shell at LAUNCH time — env never stale
    const cmd = unwrapLogin(sent[0]);
    // Local launches run the agent from its workspace dir (legacy shared dir
    // when no workdir is known), then a fresh Claude launch pins this
    // notebook's own session id, then the prompt.
    expect(cmd).toMatch(/^mkdir -p "\$HOME\/\.nebula\/agent" && cd "\$HOME\/\.nebula\/agent" && claude --session-id [0-9a-f-]{36} /);
    expect(cmd.endsWith('\r')).toBe(true);
    expect(cmd).toContain('connect_server');
    expect(cmd).toContain('http://localhost:8000');
    // teaches the agent how to get the MCP if it's missing
    expect(cmd).toContain('setup-mcp');
    // and to ask the user when the URL isn't reachable from its machine
    expect(cmd).toContain('not reachable');
    // single quote in path is shell-escaped, so the arg can't break out
    expect(cmd).toContain("my analysis'\\''s.ipynb");
    expect(cmd).not.toContain('\n');
  });

  it('confirms launch when the TUI appears, then detects exit back to the shell', () => {
    agentTerminalService.registerSender('t1', () => true);
    agentTerminalService.launchAgent('claude');
    expect(agentTerminalService.getState().status).toBe('running');
    // Focus-events set (?1004h) = the agent UI came up — survives the no-UI timeout.
    agentTerminalService.observeOutput('t1', 'welcome \x1b[?1004h');
    vi.advanceTimersByTime(20000);
    expect(agentTerminalService.getState().status).toBe('running');
    // Later the agent quits: focus-events reset (?1004l) = exited to the shell.
    // The verdict lands after a short grace window (screen transitions also
    // emit teardown — see the picker test below).
    agentTerminalService.observeOutput('t1', 'goodbye \x1b[?1004l');
    expect(agentTerminalService.getState().status).toBe('running');
    vi.advanceTimersByTime(2100);
    expect(agentTerminalService.getState().status).toBe('none');
    // …and the conversation stays resumable (session id persists).
    expect(agentTerminalService.getResumableKind()).toBe('claude');
  });

  it('recovers from a premature no-TUI verdict when the TUI shows up late (remote launches)', async () => {
    agentTerminalService.registerSender('t1', () => true);
    agentTerminalService.launchAgent('claude');
    // The launch watch gives up before the slow remote chain finishes booting…
    await vi.advanceTimersByTimeAsync(60000);
    expect(agentTerminalService.getState().status).toBe('failed');
    // …then the TUI appears anyway: the agent IS up — recover, don't stay red.
    agentTerminalService.observeOutput('t1', '\x1b[?1049h\x1b[?1004h');
    expect(agentTerminalService.getState().status).toBe('running');
    expect(agentTerminalService.getState().agentKind).toBe('claude');
  });

  it('survives picker→session screen transitions (teardown followed by a new TUI)', () => {
    agentTerminalService.registerSender('t1', () => true);
    agentTerminalService.launchAgent('claude', { continueProject: true });
    // The --resume session picker draws its own TUI…
    agentTerminalService.observeOutput('t1', 'pick a session \x1b[?1049h');
    expect(agentTerminalService.getState().status).toBe('running');
    // …the user picks one: picker tears down, chosen session's TUI comes up.
    agentTerminalService.observeOutput('t1', '\x1b[?1049l');
    vi.advanceTimersByTime(800); // within the grace window
    agentTerminalService.observeOutput('t1', '\x1b[?1049h\x1b[?1004h');
    vi.advanceTimersByTime(5000);
    // No limbo: still running, no bootstrap re-injection needed.
    expect(agentTerminalService.getState().status).toBe('running');
  });

  it('fails the launch if no interface ever appears (positive check)', async () => {
    agentTerminalService.registerSender('t1', () => true);
    agentTerminalService.launchAgent('claude');
    await vi.advanceTimersByTimeAsync(11000);
    const s = agentTerminalService.getState();
    expect(s.status).toBe('failed');
    expect(s.launchError).toMatch(/did not start|no interface/i);
  });

  // Lab report: a resumed codex was live in the pty, but the window declared
  // "Agent didn't start (no interface appeared)" — the TUI's boot escapes had
  // long scrolled out of replay, and an already-drawn TUI emits no new init.
  // Before declaring death, ask the process table: a busy pty = something IS
  // running — adopt it instead of failing.
  it('adopts instead of failing when the timeout fires but the pty is busy', async () => {
    busyStub = true;
    try {
      agentTerminalService.registerSender('t1', () => true);
      agentTerminalService.launchAgent('codex');
      await vi.advanceTimersByTimeAsync(11000);
      const s = agentTerminalService.getState();
      expect(s.status).toBe('running');
      expect(s.agentKind).toBe('codex');
      expect(s.launchError).toBeUndefined();
    } finally {
      busyStub = null;
    }
  });

  it('fails fast on an explicit error, before the no-UI timeout', () => {
    agentTerminalService.registerSender('t1', () => true);
    agentTerminalService.launchAgent('claude');
    agentTerminalService.observeOutput('t1', 'zsh: command not found: claude\n');
    expect(agentTerminalService.getState().status).toBe('failed');
    expect(agentTerminalService.getState().launchError).toMatch(/command not found/i);
  });

  it('markRunning injects the bootstrap context into a manually started agent', async () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });
    agentTerminalService.setServerContext('http://localhost:8000');
    agentTerminalService.setNotebookContext('/tmp/demo.ipynb');

    await agentTerminalService.markRunning(); // busy unknown (null) → trust the user
    expect(sent[0]).toContain('connect_server');
    expect(sent[0]).toContain('http://localhost:8000');
    expect(sent[0]).toContain('/tmp/demo.ipynb');
    vi.advanceTimersByTime(200);
    expect(sent[1]).toBe('\r');
  });

  // "Mark as active" is user-asserted truth, but busy === false is DEFINITIVE
  // (the shell has no child): injecting the bootstrap there would execute it
  // as shell commands. Refuse with a reason instead.
  it('markRunning refuses on a provably bare shell — nothing gets typed', async () => {
    busyStub = false;
    try {
      const sent: string[] = [];
      agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });
      await agentTerminalService.markRunning();
      expect(sent).toHaveLength(0);
      expect(agentTerminalService.getState().status).toBe('failed');
      expect(agentTerminalService.getState().launchError).toMatch(/nothing is running/i);
    } finally {
      busyStub = null;
    }
  });

  it('markRunning proceeds when the process table confirms something is running', async () => {
    busyStub = true;
    try {
      const sent: string[] = [];
      agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });
      await agentTerminalService.markRunning();
      expect(agentTerminalService.getState().status).toBe('running');
      expect(sent[0]).toContain('connect_server');
    } finally {
      busyStub = null;
    }
  });

  it('composes fix prompts with notebook path, cell ref, and error excerpt', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });
    agentTerminalService.launchAgent('claude');
    agentTerminalService.setNotebookContext('/tmp/demo.ipynb');

    agentTerminalService.sendFixPrompt({
      cellNumber: 3,
      cellId: 'abc',
      errorContent: 'Traceback...\nNameError: x is not defined',
    });
    const prompt = sent[1];
    expect(prompt).toContain('/tmp/demo.ipynb');
    expect(prompt).toContain('cell 3 (id abc)');
    expect(prompt).toContain('NameError: x is not defined');
    expect(prompt).toContain('nebula-notebook MCP');
    expect(prompt).not.toContain('\n');
  });

  it('keeps agent status through a dropped connection (pty survives; terminal auto-reconnects)', () => {
    agentTerminalService.registerSender('t1', () => true);
    agentTerminalService.launchAgent('codex');
    expect(agentTerminalService.getState().status).toBe('running');

    agentTerminalService.unregisterSender('t1');
    // Status survives the WS drop, but injection is gated until reconnect.
    expect(agentTerminalService.getState().status).toBe('running');
    expect(agentTerminalService.isConnected()).toBe(false);
    const result = agentTerminalService.sendPrompt('hi');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-connected');

    // Reconnect: sender re-registers, everything works again.
    agentTerminalService.registerSender('t1', () => true);
    expect(agentTerminalService.isConnected()).toBe(true);
    expect(agentTerminalService.getState().status).toBe('running');

    // A real exit still clears the state.
    agentTerminalService.markStopped();
    expect(agentTerminalService.getState().status).toBe('none');
  });
});

describe('remote-agent mode (agent on the user machine)', () => {
  const SETTINGS_KEY = 'nebula-settings';

  beforeEach(() => {
    agentTerminalService.setAgentTerminal('t9');
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      remoteAgentEnabled: true,
      remoteAgentPort: 34567,
      remoteAgentUser: 'jane',
      remoteAgentLocalUrl: 'http://localhost:3000',
      remoteAgentJumpHost: 'bastion',
    }));
  });

  afterEach(() => {
    agentTerminalService.unregisterSender('t9');
    agentTerminalService.setAgentTerminal(null);
    agentTerminalService.setNotebookContext(null);
    window.localStorage.removeItem(SETTINGS_KEY);
    window.sessionStorage.clear();
  });

  it('is inert unless enabled AND user is set', () => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ remoteAgentEnabled: true, remoteAgentPort: 34567 }));
    expect(agentTerminalService.getRemoteAgentConfig()).toBeNull();
    expect(agentTerminalService.buildRemoteLaunchCommand('claude')).toBeNull();
  });

  it('composes the tunnel command with jump host, forward, and reverse port', () => {
    const cmd = agentTerminalService.buildTunnelCommand('login-node-01', 3000);
    expect(cmd).toBe('ssh -J bastion -L 3000:localhost:3000 -R 34567:localhost:22 login-node-01');
  });

  it('launchAgent types an ssh-back line that survives nested quoting', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t9', (d) => { sent.push(d); return true; });
    agentTerminalService.setNotebookContext('/data/proj/nb.ipynb');
    agentTerminalService.launchAgent('claude');

    const line = sent[0];
    expect(line).toMatch(/^ssh -t -p 34567 -o ProxyCommand=none -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=4 jane@localhost '/);
    // Keepalives make a hung transport self-terminate (~60s) instead of
    // freezing the pty forever — the liveness machinery then sees a clean
    // exit-to-shell it can act on.
    expect(line).toContain('NEBULA_URL=http://localhost:3000 claude ');
    expect(line).toContain('exec "$SHELL" -l -i -c ');
    // no tmux/daemons: resume rides `claude --continue` instead
    expect(line).not.toContain('tmux');
    // bootstrap rides inside: server paths + local-URL guidance, single line
    expect(line).toContain('/data/proj/nb.ipynb');
    expect(line).toContain('paths on the SERVER');
    expect(line).not.toContain('\n');
    expect(agentTerminalService.getState().agentKind).toBe('claude');
  });

  it('maps the Nebula-scoped OAuth token to claude, leaving the user\'s own var alone', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t9', (d) => { sent.push(d); return true; });
    agentTerminalService.setNotebookContext('/data/proj/nb.ipynb');
    agentTerminalService.launchAgent('claude');

    const line = sent[0];
    // The launched shell exports CLAUDE_CODE_OAUTH_TOKEN from the NEBULA-scoped
    // var, only when that is set — so the user's interactive claude sessions
    // never see a Nebula-injected token, and legacy plain-var setups still work.
    expect(line).toContain('CLAUDE_CODE_OAUTH_TOKEN_NEBULA');
    expect(line).toMatch(/\[ -z "\$CLAUDE_CODE_OAUTH_TOKEN_NEBULA" \] \|\| export CLAUDE_CODE_OAUTH_TOKEN="\$CLAUDE_CODE_OAUTH_TOKEN_NEBULA"/);
  });

  it('does not inject the OAuth token mapping for codex (file-based credentials)', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t9', (d) => { sent.push(d); return true; });
    agentTerminalService.launchAgent('codex');
    expect(sent[0]).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('resume reopens this notebook\'s own session id with a short reorientation prompt', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t9', (d) => { sent.push(d); return true; });
    agentTerminalService.setNotebookContext('/data/proj/nb.ipynb');
    // Fresh launch mints + stores this notebook's session id...
    agentTerminalService.launchAgent('claude');
    const sessionId = sent[0].match(/--session-id ([0-9a-f-]{36})/)?.[1];
    expect(sessionId).toBeTruthy();
    agentTerminalService.markStopped();
    sent.length = 0;
    // ...and resume reopens exactly that id (not a cwd-shared --continue).
    agentTerminalService.launchAgent('claude', { resume: true });
    const line = sent[0];
    expect(line).toContain(`claude --resume ${sessionId} `);
    expect(line).toContain('/data/proj/nb.ipynb');
    expect(line).not.toContain('PREFERRED: use the `nebula` CLI'); // short prompt, not the full bootstrap
  });

  it('breakRemoteConnection types the ssh escape and resets agent state', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t9', (d) => { sent.push(d); return true; });
    agentTerminalService.setNotebookContext('/data/proj/nb.ipynb');
    agentTerminalService.launchAgent('claude');
    expect(agentTerminalService.getState().status).toBe('running');
    sent.length = 0;

    agentTerminalService.breakRemoteConnection();

    // "\r~." — newline puts ssh at line start, where ~. force-closes the
    // client even when the transport hangs (frozen tunnel).
    expect(sent).toContain('\r~.');
    expect(agentTerminalService.getState().status).toBe('none');
  });

  it('breakRemoteConnection is a no-op with no attached terminal', () => {
    agentTerminalService.setAgentTerminal(null);
    expect(() => agentTerminalService.breakRemoteConnection()).not.toThrow();
  });

  it('local launch (mode disabled) runs in the agent workspace with no ssh hop', () => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ remoteAgentEnabled: false }));
    const sent: string[] = [];
    agentTerminalService.registerSender('t9', (d) => { sent.push(d); return true; });
    agentTerminalService.launchAgent('codex');
    expect(sent[0]).toMatch(/^"\$SHELL" -l -i -c '/);
    expect(sent[0]).toMatch(/mkdir -p "\$HOME\/\.nebula\/agent" && cd "\$HOME\/\.nebula\/agent" && codex /);
    expect(sent[0]).not.toContain('ssh');
  });
});

describe('local launch placement (agent workspace mirror)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    agentTerminalService.setAgentTerminal('t2');
  });

  afterEach(() => {
    vi.useRealTimers();
    agentTerminalService.unregisterSender('t2');
    agentTerminalService.setAgentTerminal(null);
    agentTerminalService.setNotebookContext(null);
    agentTerminalService.setServerContext(null);
    window.sessionStorage.clear();
  });

  const MIRROR_RE = /^mkdir -p "\$HOME\/\.nebula\/agent\/p-[0-9a-f]{6}-proj" && cd "\$HOME\/\.nebula\/agent\/p-[0-9a-f]{6}-proj" && /;

  it('launches claude in the workdir mirror with --add-dir back to the project', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t2', (d) => { sent.push(d); return true; });
    agentTerminalService.launchAgent('claude', { workdir: '/data/proj' });
    const line = unwrapLogin(sent[0]);
    // Agent chats are keyed to their cwd — run from the mirror so real project
    // dirs never accumulate Nebula agent trajectories…
    expect(line).toMatch(MIRROR_RE);
    // …while --add-dir keeps read/write access to the real project…
    expect(line).toContain("claude --add-dir '/data/proj' --session-id ");
    // …and the bootstrap tells the agent where the project actually lives.
    expect(line).toContain('The project lives at /data/proj');
    expect(line).not.toContain('ssh');
  });

  it('gives codex write access to the project from the mirror cwd', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t2', (d) => { sent.push(d); return true; });
    agentTerminalService.launchAgent('codex', { workdir: '/data/proj' });
    expect(unwrapLogin(sent[0])).toMatch(MIRROR_RE);
    expect(unwrapLogin(sent[0])).toContain(`codex -c 'sandbox_workspace_write.writable_roots=["/data/proj"]' '`);
  });

  it('resume and continue-project also run from the mirror (claude keys sessions by cwd)', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t2', (d) => { sent.push(d); return true; });
    agentTerminalService.launchAgent('claude', { workdir: '/data/proj' });
    const sessionId = sent[0].match(/--session-id ([0-9a-f-]{36})/)?.[1];
    agentTerminalService.markStopped();
    sent.length = 0;

    agentTerminalService.launchAgent('claude', { resume: true, workdir: '/data/proj' });
    expect(unwrapLogin(sent[0])).toMatch(MIRROR_RE);
    expect(unwrapLogin(sent[0])).toContain(`claude --add-dir '/data/proj' --resume ${sessionId} '`);
    agentTerminalService.markStopped();
    sent.length = 0;

    agentTerminalService.launchAgent('codex', { continueProject: true, workdir: '/data/proj' });
    expect(unwrapLogin(sent[0])).toMatch(MIRROR_RE);
    expect(unwrapLogin(sent[0])).toContain(`codex resume -c 'sandbox_workspace_write.writable_roots=["/data/proj"]'`);
  });
});

describe('launch idempotency (lab report: continue session typed the command twice)', () => {
  let sent: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    agentTerminalService.setAgentTerminal('t1');
    agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });
  });
  afterEach(() => {
    vi.useRealTimers();
    agentTerminalService.unregisterSender('t1');
    agentTerminalService.setAgentTerminal(null);
    window.sessionStorage.clear();
  });

  // Whatever double-fires it (a re-run effect, a double click, two attach
  // paths racing on connect), typing the launch line twice is never right:
  // the second copy lands in the TUI the first one just opened, becoming a
  // chat message — or starts a second agent in the same pty.
  it('sends one launch line when the same launch is requested twice in a row', () => {
    agentTerminalService.launchAgent('claude', { resume: true, workdir: '/w/proj' });
    agentTerminalService.launchAgent('claude', { resume: true, workdir: '/w/proj' });
    expect(sent.length).toBe(1);
  });

  it('still allows a genuine relaunch once the dedupe window has passed', () => {
    agentTerminalService.launchAgent('claude', { resume: true, workdir: '/w/proj' });
    vi.setSystemTime(new Date(Date.now() + 6000)); // dedupe reads the wall clock
    agentTerminalService.launchAgent('claude', { resume: true, workdir: '/w/proj' });
    expect(sent.length).toBe(2);
  });

  it('does not suppress a DIFFERENT launch (switching kind or workdir)', () => {
    agentTerminalService.launchAgent('claude', { resume: true, workdir: '/w/proj' });
    agentTerminalService.launchAgent('codex', { resume: true, workdir: '/w/proj' });
    expect(sent.length).toBe(2);
  });

  it('does not suppress a relaunch in a different terminal', () => {
    const other: string[] = [];
    agentTerminalService.launchAgent('claude', { workdir: '/w/proj' });
    agentTerminalService.setAgentTerminal('t2');
    agentTerminalService.registerSender('t2', (d) => { other.push(d); return true; });
    agentTerminalService.launchAgent('claude', { workdir: '/w/proj' });
    expect(other.length).toBe(1);
    agentTerminalService.unregisterSender('t2');
  });
});

describe('buildRemoteSetupAgentPrompt (hand the whole setup to an agent)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('nebula-settings', JSON.stringify({
      remoteAgentPort: 31703, remoteAgentLocalSshPort: 2222, remoteAgentJumpHost: 'randi',
    }));
  });
  afterEach(() => window.localStorage.clear());

  it('names every step the user would otherwise do by hand, with real values', () => {
    const p = agentTerminalService.buildRemoteSetupAgentPrompt('cri22in002', 3001);
    // The tunnel, with THIS installation's actual ports and host — not a template.
    expect(p).toContain('31703');
    expect(p).toContain('cri22in002');
    expect(p).toContain('2222');
    // Both ways to make the tunnel, so the agent can pick what's installed.
    expect(p).toMatch(/burrow add --name nebula-agent/);
    expect(p).toMatch(/ssh .*-R 31703:localhost:2222/);
    // Remote Login is the step people miss: the tunnel comes up and nothing answers.
    expect(p.toLowerCase()).toContain('remote login');
    // Skill + MCP install, which is why an agent is doing this at all.
    expect(p).toContain('nebula setup-skill');
    expect(p).toContain('setup-mcp');
  });

  it('tells the agent how to verify, not just what to run', () => {
    const p = agentTerminalService.buildRemoteSetupAgentPrompt('cri22in002', 3001);
    expect(p.toLowerCase()).toMatch(/verify|check|confirm/);
  });

  it('degrades to placeholders instead of lying when the host is unknown', () => {
    const p = agentTerminalService.buildRemoteSetupAgentPrompt(null, null);
    expect(p).toContain('<server-host>');
    expect(p).not.toContain('null');
  });
});
