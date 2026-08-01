/**
 * App settings storage (localStorage).
 *
 * Extracted from the former llmService when direct-API AI features were
 * removed — these are general app settings, unrelated to any model provider.
 * The storage key is unchanged for backwards compatibility; stale AI fields
 * (llmProvider, llmModel, apiKeys) in previously-saved JSON are simply ignored.
 */

const SETTINGS_KEY = 'nebula-settings';

export type IndentationPreference = 'auto' | '2' | '4' | '8' | 'tab';

export interface NebulaSettings {
  rootDirectory: string;
  lastKernel: string;
  notifyOnLongRun?: boolean; // Send browser notification when long-running jobs complete
  notifyThresholdSeconds?: number; // Threshold in seconds for "long-running" (default 60)
  notifySoundEnabled?: boolean; // Play sound when long-running jobs complete
  indentation?: IndentationPreference; // Indentation style: 'auto' (detect), '2', '4', '8', or 'tab'
  showLineNumbers?: boolean; // Show line numbers in code cells
  showCellIds?: boolean; // Show cell IDs in the cell header
  showResourceMonitor?: boolean; // Show RAM/GPU usage in notebook status bar (disabled by default for typing perf)
  showOutputLoggingToggle?: boolean; // Show the save-outputs-to-history toolbar toggle (hidden by default — niche, and easy to hit by accident)
  smoothAutoScroll?: boolean; // Animate notebook-driven auto-scroll actions
  jupyterShortcuts?: boolean; // Jupyter classic double-key cell-mode bindings: dd delete, 00 restart, ii interrupt (z / Shift+Z undo/redo are always on)
  // On a scheduler login node, whether to run kernels directly on this (shared) node.
  // undefined = undecided → the user is asked once, on first login-node kernel start.
  allowLoginNodeKernels?: 'allow' | 'deny';
  // Remote-agent mode: run the coding agent on the USER'S machine (its RAM,
  // its network) while its terminal lives in the Nebula page — over a reverse
  // SSH channel (-R <port>:localhost:22) carried by the user's own tunnel.
  remoteAgentEnabled?: boolean;
  remoteAgentPort?: number;     // reverse-channel port on the server host; random per user to avoid collisions on shared login nodes
  remoteAgentUser?: string;     // username on the user's machine (for ssh back)
  remoteAgentLocalSshPort?: number; // sshd port on the user's machine (the -R forward target); default 22. Some setups (e.g. macOS policy blocking 22) run sshd on 2222.
  remoteAgentLocalUrl?: string; // Nebula URL as seen FROM the user's machine (their -L forward), default http://localhost:3000
  remoteAgentJumpHost?: string; // optional ProxyJump host for the displayed tunnel command
  // AI inline autocomplete (ghost text) in code cells, powered by the
  // Claude Code / Codex CLI using the user's own subscription.
  // undefined = undecided → the first-run welcome card asks once.
  aiAutocomplete?: boolean;
  aiAutocompleteBackend?: 'claude' | 'codex'; // default 'claude'
  // Where the agent + autocomplete CLIs run, when the server is remote:
  // 'server' = on the Nebula host (cluster); 'mine' = on the user's machine
  // over the reverse tunnel. Ignored when the environment is local (server IS
  // your machine) — see environmentService. undefined = use the env default.
  agentRunsOn?: 'server' | 'mine';
  // Absolute paths to the user's own claude/codex, discovered over the reverse
  // tunnel (POST /api/autocomplete/probe-remote). Needed to run autocomplete on
  // the user's machine — a non-interactive ssh has no PATH, so the abs path is
  // required. Empty string = probed but not found.
  remoteClaudeBin?: string;
  remoteCodexBin?: string;
  // Override for the auto-detected server environment (environmentService),
  // for cases the heuristic gets wrong (headless local Linux; a cloud VM you
  // tunnel to). undefined = trust detection.
  environmentOverride?: 'local' | 'remote';
  // --- AI autocomplete: Advanced tuning (quality <-> speed) ---
  aiAutocompleteModel?: string;          // model id (haiku | sonnet | opus | any alias your CLI accepts)
  aiAutocompleteContextChars?: number;   // cross-cell context budget in characters (0 = none)
  aiAutocompleteMaxLines?: number;       // suggestion length cap in lines
  aiAutocompleteDebounceMs?: number;     // idle time before a fetch, ms
  aiAutocompleteThinkingTokens?: number; // thinking-token budget (0 = off)
}

export const getSettings = (): NebulaSettings => {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }

  // Default settings
  return {
    rootDirectory: '~',
    lastKernel: 'python3',
    notifyOnLongRun: true,
    notifySoundEnabled: true,
    notifyThresholdSeconds: 60,
    indentation: 'auto',
    showCellIds: false,
    smoothAutoScroll: true,
  };
};

export const saveSettings = (settings: Partial<NebulaSettings>): void => {
  const current = getSettings();
  const updated = { ...current, ...settings };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
};

/**
 * Reverse-channel port for remote-agent mode — local fallback generator
 * (random in 20000-59999 so users on a shared login node don't collide).
 * The AUTHORITY is the server's installation-wide value: call
 * syncRemoteAgentPort() wherever the port is about to matter, and this
 * local value is only a seed/offline stand-in. Per-browser-only ports
 * orphaned users' tunnels whenever a new browser profile minted its own.
 */
export const ensureRemoteAgentPort = (): number => {
  const s = getSettings();
  if (s.remoteAgentPort && Number.isInteger(s.remoteAgentPort)) return s.remoteAgentPort;
  const port = 20000 + Math.floor(Math.random() * 40000);
  saveSettings({ remoteAgentPort: port });
  return port;
};

/**
 * Converge on the server's installation-wide reverse-channel port
 * (~/.nebula/remote-agent.json). A locally stored port is offered as a
 * claim: the first browser to sync after upgrade keeps the port its user
 * already built a tunnel for; afterwards the server value wins everywhere.
 * Offline/unreachable → keep the local value. Returns the effective port.
 */
export const syncRemoteAgentPort = async (): Promise<number | null> => {
  const local = getSettings().remoteAgentPort;
  try {
    const q = local && Number.isInteger(local) ? `?claim=${local}` : '';
    const resp = await fetch(`/api/terminals/agent-port${q}`);
    if (!resp.ok) return local ?? null;
    const data = await resp.json();
    if (!Number.isInteger(data.port)) return local ?? null;
    if (data.port !== local) saveSettings({ remoteAgentPort: data.port });
    return data.port;
  } catch {
    return local ?? null;
  }
};

/** Explicit port override — persists locally AND server-side (all browsers follow). */
export const setRemoteAgentPort = async (port: number): Promise<void> => {
  saveSettings({ remoteAgentPort: port });
  try {
    await fetch('/api/terminals/agent-port', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
    });
  } catch { /* offline — the next sync's claim carries it to the server */ }
};
