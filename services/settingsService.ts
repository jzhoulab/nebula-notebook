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

/** Installation-wide remote-agent config, as the server reports it. */
export interface RemoteAgentServerConfig {
  port?: number;
  user?: string;
  localSshPort?: number;
  jumpHost?: string;
  localUrl?: string;
}

/**
 * Converge on the server's installation-wide remote-agent config
 * (~/.nebula/remote-agent.json) and mirror it into settings. Local values
 * are offered as claims: the FIRST browser to sync after upgrade donates
 * the setup it already had working (so no re-tunnel, no re-prompt), and
 * afterwards the server's copy wins everywhere. A field the server doesn't
 * know never erases the local one. Offline → keep local, return null.
 */
export const syncRemoteAgentConfig = async (): Promise<RemoteAgentServerConfig | null> => {
  const s = getSettings();
  const claims: Record<string, string> = {};
  if (s.remoteAgentPort && Number.isInteger(s.remoteAgentPort)) claims.claimPort = String(s.remoteAgentPort);
  if (s.remoteAgentUser?.trim()) claims.claimUser = s.remoteAgentUser.trim();
  if (s.remoteAgentLocalSshPort) claims.claimSshPort = String(s.remoteAgentLocalSshPort);
  if (s.remoteAgentJumpHost?.trim()) claims.claimJump = s.remoteAgentJumpHost.trim();
  if (s.remoteAgentLocalUrl?.trim()) claims.claimUrl = s.remoteAgentLocalUrl.trim();
  const q = Object.keys(claims).length ? `?${new URLSearchParams(claims)}` : '';
  try {
    const resp = await fetch(`/api/terminals/agent-config${q}`);
    if (!resp.ok) return null;
    const cfg = (await resp.json()) as RemoteAgentServerConfig;
    const next: Partial<NebulaSettings> = {};
    if (Number.isInteger(cfg.port) && cfg.port !== s.remoteAgentPort) next.remoteAgentPort = cfg.port;
    if (cfg.user && cfg.user !== s.remoteAgentUser) next.remoteAgentUser = cfg.user;
    if (cfg.localSshPort && cfg.localSshPort !== s.remoteAgentLocalSshPort) next.remoteAgentLocalSshPort = cfg.localSshPort;
    if (cfg.jumpHost && cfg.jumpHost !== s.remoteAgentJumpHost) next.remoteAgentJumpHost = cfg.jumpHost;
    if (cfg.localUrl && cfg.localUrl !== s.remoteAgentLocalUrl) next.remoteAgentLocalUrl = cfg.localUrl;
    if (Object.keys(next).length) saveSettings(next);
    return cfg;
  } catch {
    return null;
  }
};

/**
 * Explicit override — persists locally AND server-side so every other
 * browser of this installation follows on its next sync.
 */
export const pushRemoteAgentConfig = async (fields: RemoteAgentServerConfig): Promise<void> => {
  const local: Partial<NebulaSettings> = {};
  if (fields.port !== undefined) local.remoteAgentPort = fields.port;
  if (fields.user !== undefined) local.remoteAgentUser = fields.user;
  if (fields.localSshPort !== undefined) local.remoteAgentLocalSshPort = fields.localSshPort;
  if (fields.jumpHost !== undefined) local.remoteAgentJumpHost = fields.jumpHost;
  if (fields.localUrl !== undefined) local.remoteAgentLocalUrl = fields.localUrl;
  if (Object.keys(local).length) saveSettings(local);
  try {
    await fetch('/api/terminals/agent-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
  } catch { /* offline — the next sync's claim carries it to the server */ }
};

/**
 * Is remote-agent mode configured enough to run? The username is the one
 * thing Nebula cannot discover or guess (it composes the ssh hop back), so
 * it alone decides whether the setup dialog must be shown. Call AFTER
 * syncRemoteAgentConfig() so a browser that simply hasn't synced yet
 * doesn't re-prompt for setup another browser already completed.
 */
export const remoteAgentSetupComplete = (): boolean => !!getSettings().remoteAgentUser?.trim();

/**
 * Ask the server to find the username on the user's machine over the reverse
 * tunnel (`whoami`) instead of demanding it in a form. Returns the login on
 * success and stores it; null means the tunnel didn't answer — which is a
 * real, reportable state, not a silent dead end.
 */
export const discoverRemoteAgentUser = async (): Promise<{ user: string | null; reason?: string }> => {
  try {
    const resp = await fetch('/api/terminals/agent-config/discover-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hint: getSettings().remoteAgentUser?.trim() || undefined }),
    });
    if (!resp.ok) return { user: null };
    const data = await resp.json();
    if (typeof data.user === 'string' && data.user) {
      saveSettings({ remoteAgentUser: data.user });
      return { user: data.user };
    }
    return { user: null, reason: typeof data.reason === 'string' ? data.reason : undefined };
  } catch {
    return { user: null };
  }
};
