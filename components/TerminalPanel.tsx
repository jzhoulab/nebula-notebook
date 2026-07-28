/**
 * TerminalPanel - Single terminal per notebook
 *
 * Terminal is created lazily when first opened and closed when notebook changes.
 * This is better suited for agentic use where each notebook has its own terminal context.
 */

import React, { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import {
  Terminal,
  X,
  AlertCircle,
  Bot,
  ListTree,
} from 'lucide-react';
import { TerminalInstance } from './TerminalInstance';
import {
  getOrCreateNamedTerminal,
  listTerminals,
  getTerminalServerInfo,
  checkReverseTunnel,
  getTerminalBinding,
  setTerminalBinding,
  closeTerminal,
  TerminalBindingInfo,
  TerminalBindingScope,
  TerminalInfo,
} from '../services/terminalService';
import { agentTerminalService } from '../services/agentTerminalService';
import { useNotification } from './NotificationSystem';
import { getSettings, saveSettings, ensureRemoteAgentPort } from '../services/settingsService';
import { fetchEnvironment, serverIsRemote } from '../services/environmentService';
import { probeRemoteBins } from '../services/aiAutocompleteService';
import { RemoteAgentSetupModal } from './RemoteAgentSetupModal';
import {
  AgentRecord, agentTerminalNameFor, deleteAgent, getActiveAgentId,
  hibernateAgent, listAgents, notebookDirOf, probeTerminalBusy, registerAgent,
  setActiveAgentId,
} from '../services/agentRegistryService';

/**
 * Stable per-notebook terminal name, so a page refresh reattaches to the SAME
 * server-side pty (with scrollback replay and any running process — e.g. an
 * agent — intact) instead of leaking the old pty and creating a fresh one.
 * The server normalizes names to [a-z0-9_-] and caps at 32 chars, so we lead
 * with a short hash of the full path to keep distinct notebooks distinct.
 */
function terminalNameFor(notebookPath: string | null | undefined, role: 'shell' | 'agent'): string {
  const path = notebookPath || 'scratch';
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
  const slug = (path.split('/').pop() || 'nb').replace(/\.ipynb$/i, '');
  return `nb-${hex}-${role}-${slug}`;
}

/**
 * Mirror of the server's terminal-name → id normalization (pty-manager), so we
 * can recognize this notebook's surviving ptys in the terminal list after a
 * refresh without a per-name round trip.
 */
function normalizeTerminalName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return normalized || 'default';
}

export type TerminalPanelTab = 'shell' | 'agent';

interface TerminalPanelProps {
  isOpen: boolean;
  onClose: () => void;
  notebookPath?: string | null; // Current notebook path for cwd
  defaultHeight?: number;
  /** Controlled tab (Notebook lifts this so toolbar buttons can target a tab). */
  activeTab?: TerminalPanelTab;
  onTabChange?: (tab: TerminalPanelTab) => void;
}

const MIN_HEIGHT = 100;
const MAX_HEIGHT = 800;
const DEFAULT_HEIGHT = 300;

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  isOpen,
  onClose,
  notebookPath,
  defaultHeight = DEFAULT_HEIGHT,
  activeTab,
  onTabChange,
}) => {
  const [height, setHeight] = useState(defaultHeight);
  // Two independent ptys per notebook: a plain shell, and the agent's terminal.
  // Keeping them separate preserves normal terminal use while an agent runs.
  const [shellTerm, setShellTerm] = useState<TerminalInfo | null>(null);
  const [agentTerm, setAgentTerm] = useState<TerminalInfo | null>(null);
  const [internalTab, setInternalTab] = useState<TerminalPanelTab>('shell');
  const tab = activeTab ?? internalTab;
  const setTab = onTabChange ?? setInternalTab;
  const [isResizing, setIsResizing] = useState(false);
  const [serverAvailable, setServerAvailable] = useState<boolean | null>(null);
  const [serverHostInfo, setServerHostInfo] = useState<{ hostname: string | null; port: number | null }>({ hostname: null, port: null });
  // Remote-agent mode: reverse channel status. null = not applicable / unknown.
  // ready = listener up AND nothing said "not ssh" (banner unknown counts as OK).
  const [reverseTunnel, setReverseTunnel] = useState<{ up: boolean; ssh: boolean | null } | null>(null);
  const reverseTunnelUp = reverseTunnel === null ? null : (reverseTunnel.up && reverseTunnel.ssh !== false);
  // Sticky "the remote agent's ssh transport is dead" flag: a dropped tunnel
  // freezes the TUI with no teardown output, so status stays 'running' and the
  // launch bar never returns. Set while the tunnel is observed down with a
  // running remote agent; sticky because the OLD connection stays dead even
  // after the tunnel reconnects. Cleared when the agent state resets.
  const [agentConnLost, setAgentConnLost] = useState(false);
  // Bumped when this panel changes agent settings, so remoteAgentCfg recomputes.
  const [, setSettingsNonce] = useState(0);
  // Is the Nebula server remote from the user? Only then does "run the agent on
  // this server vs. my machine" mean anything; on a local install the server IS
  // your machine, so the whole where-choice collapses away. Defaults to false
  // (local) until the environment is known.
  const [serverRemote, setServerRemote] = useState<boolean>(serverIsRemote());
  useEffect(() => { fetchEnvironment().then((env) => setServerRemote(serverIsRemote(env))); }, []);
  // Remote-agent setup dialog (connection details for the reverse channel).
  const [showRemoteSetup, setShowRemoteSetup] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // Delayed visibility for the "opening terminal" overlay: after a refresh the
  // panel almost always REATTACHES to the surviving pty (not create a new one),
  // and a fast reattach shouldn't flash a "Creating…" spinner.
  const [showPendingOverlay, setShowPendingOverlay] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    if (isOpen) setEverOpened(true);
  }, [isOpen]);

  // ---- Project-scoped agents (decoupled from notebooks) ----
  // The Agent tab attaches to the browser's ACTIVE agent wherever it lives;
  // notebooks never auto-switch it. No active agent -> a fresh one scoped to
  // this notebook's directory (workdir editable before launch).
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [activeAgentId, setActiveAgent] = useState<string | null>(() => getActiveAgentId());
  const [workdirOverride, setWorkdirOverride] = useState<string | null>(null);
  const [showAgentManager, setShowAgentManager] = useState(false);
  const [showWorkdirMenu, setShowWorkdirMenu] = useState(false);
  // Menu anchor rects captured at open: menus render position:fixed from
  // these so the panel's overflow-hidden can never clip them.
  const [workdirMenuRect, setWorkdirMenuRect] = useState<DOMRect | null>(null);
  const [moreMenuRect, setMoreMenuRect] = useState<DOMRect | null>(null);
  const [shellMenuRect, setShellMenuRect] = useState<DOMRect | null>(null);
  const { promptText } = useNotification();
  const notebookDir = notebookDirOf(notebookPath);
  // Agent-plane binding: the scope this notebook's Agent tab targets. The
  // binding decides the agent terminal's IDENTITY (records key on it too);
  // 'project' derives it from the chosen workdir (legacy-compatible).
  const [agentBinding, setAgentBinding] = useState<TerminalBindingInfo | null>(null);
  useEffect(() => {
    if (!isOpen || !notebookPath) return;
    getTerminalBinding(notebookPath, 'agent').then(setAgentBinding).catch(() => setAgentBinding(null));
  }, [isOpen, notebookPath]);
  const agentScope = agentBinding?.scope ?? 'project';
  const agentWorkdir = workdirOverride ?? (agentScope === 'server' ? '~' : notebookDir) ?? '~';
  const boundAgentName = (agentScope === 'project' || !agentBinding?.name)
    ? agentTerminalNameFor(agentWorkdir)
    : agentBinding.name;
  const activeAgentRecord = activeAgentId ? agents.find((a) => a.terminalId === activeAgentId) ?? null : null;

  const refreshAgents = useCallback(async () => {
    setAgents(await listAgents());
  }, []);
  const refreshManagerTerms = useCallback(() => {
    listTerminals().then(setManagerTerms).catch(() => { /* section stays as-is */ });
  }, []);
  useEffect(() => {
    if (!isOpen || tab !== 'agent') return;
    refreshAgents();
  }, [isOpen, tab, refreshAgents]);

  const selectAgent = useCallback((id: string | null) => {
    setActiveAgentId(id);
    setActiveAgent(id);
    setAgentTerm(null); // re-resolve the pty to the newly selected agent
  }, []);


  const panelRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const currentNotebookRef = useRef<string | null>(null);

  // Agent state: this panel's terminal doubles as the agent terminal.
  const agentState = useSyncExternalStore(
    useCallback((cb) => agentTerminalService.subscribe(cb), []),
    () => agentTerminalService.getState()
  );
  const agentConnected = useSyncExternalStore(
    useCallback((cb) => agentTerminalService.subscribe(cb), []),
    () => agentTerminalService.isConnected()
  );

  // One-click continue: select the record's pty, then fire the launch as soon
  // as the terminal connects (the sender isn't registered until WS open).
  const [showAgentMoreMenu, setShowAgentMoreMenu] = useState(false);
  // Non-agent ptys shown in the manager's Terminals section.
  const [managerTerms, setManagerTerms] = useState<TerminalInfo[]>([]);
  // Parked: agent tab with no pty and no launch requested (instant, no spinner).
  const [agentParked, setAgentParked] = useState(false);
  // Bumped when a launch is requested from the parked state, so the resolve
  // effect re-runs even though agentTerm is already null.
  const [agentLaunchNonce, setAgentLaunchNonce] = useState(0);

  // Change the agent-plane binding scope; persists server-side per notebook.
  const rebindAgent = useCallback(async (scope: TerminalBindingScope, name?: string) => {
    setShowWorkdirMenu(false);
    try {
      const b = await setTerminalBinding(notebookPath || 'scratch', 'agent', scope, name);
      setAgentBinding(b);
      setWorkdirOverride(null);
      if (!getActiveAgentId()) { setAgentParked(false); setAgentTerm(null); setAgentLaunchNonce((n) => n + 1); }
    } catch (e) {
      console.error('[TerminalPanel] Failed to rebind agent scope:', e);
    }
  }, [notebookPath]);

  // Never type a launch command into a pty that already hosts a running
  // process: records can mis-score liveness (an agent resumed BY HAND never
  // re-registers, so its record stays 'hibernated'), and a live TUI eats the
  // typed launch line as a chat prompt — a lab user's resumed codex politely
  // declined to run the pasted ssh command while the bar said "didn't start".
  // The process table is the authority; probe the pty right before typing.
  // Busy ⇒ adopt what's running (kind from the record when known) and attach.
  const guardedAgentLaunch = useCallback(async (kind: 'claude' | 'codex', opts: {
    resume?: boolean; continueProject?: boolean; workdir?: string | null; mirrorSlug?: string | null; legacyRealCwd?: string | null;
  }) => {
    const targetId = agentTerminalService.getState().terminalId;
    if (targetId) {
      const busy = await probeTerminalBusy(targetId);
      if (busy === true) {
        const recs = await listAgents();
        const rec = recs.find((a) => a.terminalId === targetId);
        agentTerminalService.adoptRunningState(
          rec?.kind === 'codex' ? 'codex' : rec?.kind === 'claude' ? 'claude' : 'manual'
        );
        setAgents(recs);
        return;
      }
    }
    agentTerminalService.launchAgent(kind, opts);
  }, []);

  // Route a launch through the pty-resolution effect when nothing is attached
  // yet: create the pty first, then the pending launch fires on WS connect.
  const requestAgentLaunch = useCallback((kind: 'claude' | 'codex', opts: {
    resume?: boolean; continueProject?: boolean; workdir?: string; mirrorSlug?: string; legacyRealCwd?: string;
  }) => {
    if (agentTerminalService.isConnected()) {
      void guardedAgentLaunch(kind, opts);
      return;
    }
    pendingAgentLaunchRef.current = { kind, opts };
    setAgentParked(false);
    setAgentTerm(null);
    setAgentLaunchNonce((n) => n + 1);
  }, [guardedAgentLaunch]);
  const pendingAgentLaunchRef = useRef<{
    kind: 'claude' | 'codex';
    opts: { resume?: boolean; continueProject?: boolean; workdir?: string };
  } | null>(null);

  const continueAgentRecord = useCallback((rec: AgentRecord) => {
    const kind: 'claude' | 'codex' = rec.kind === 'codex' ? 'codex' : 'claude';
    // Exact resume when we have the conversation id; otherwise the CLI's own
    // cwd-scoped picker. Always the record's OWN workdir — the conversation
    // lives in that dir (claude keys sessions by cwd).
    // LEGACY-COMPAT(2026-07, self-expiring): records without a pinned slug
    // predate the mirror-cwd change; their conversations are keyed to the
    // REAL workdir. Registry caps at 50 records and every relaunch re-pins,
    // so delete this (and legacyRealCwd plumbing in agentTerminalService)
    // once agents.json shows no slug-less server records.
    const legacyRealCwd = !rec.mirrorSlug && (rec.location ?? 'server') === 'server' ? rec.workdir : undefined;
    // Direct resume whenever it's unambiguous: an exact session id, OR no id
    // but an EXCLUSIVE mirror cwd (one agent per mirror ⇒ `--continue`'s
    // "most recent in cwd" is exactly this agent's last conversation). Only
    // legacy shared real dirs without an id need the interactive picker.
    const direct = kind === 'claude' && (!!rec.sessionId || !legacyRealCwd);
    const opts = direct
      ? { resume: true, workdir: rec.workdir, mirrorSlug: rec.mirrorSlug, legacyRealCwd }
      : { continueProject: true, workdir: rec.workdir, mirrorSlug: rec.mirrorSlug, legacyRealCwd };
    if (rec.terminalId === (agentTerm?.id ?? null) && agentConnected) {
      void guardedAgentLaunch(kind, opts);
      return;
    }
    pendingAgentLaunchRef.current = { kind, opts };
    setAgentParked(false);
    setAgentLaunchNonce((n) => n + 1);
    selectAgent(rec.terminalId);
  }, [agentTerm, agentConnected, selectAgent, guardedAgentLaunch]);

  // When the agent pty connects: fire a pending continue, and adopt "running"
  // from a record the server knows is live (cross-browser attach — the
  // sessionStorage running-flag is per-browser, the record is not).
  useEffect(() => {
    if (!agentConnected || !agentTerm) return;
    const pending = pendingAgentLaunchRef.current;
    if (pending) {
      pendingAgentLaunchRef.current = null;
      // The just-attached pty may be PRE-EXISTING with an agent already in it
      // (the reported failure attached to a live codex) — guard, never assume.
      void guardedAgentLaunch(pending.kind, pending.opts);
      return;
    }
    const rec = agents.find((a) => a.terminalId === agentTerm.id);
    // idleShell: the server saw a bare shell in that pty — 'live' is a pty
    // fact, not an agent fact. Adopting would freeze the tab on nothing.
    const occupied = rec && ((rec.state === 'live' && !rec.idleShell) || rec.busy === true);
    if (occupied && (rec.kind === 'claude' || rec.kind === 'codex') && agentState.status !== 'running') {
      agentTerminalService.adoptRunningState(rec.kind);
    }
  }, [agentConnected, agentTerm, agents, agentState.status, guardedAgentLaunch]);

  // Only the Agent tab's pty receives injected prompts — the shell stays a
  // plain terminal.
  useEffect(() => {
    agentTerminalService.setAgentTerminal(agentTerm?.id ?? null);
  }, [agentTerm]);

  // On notebook switch, DETACH from the old notebook's shell (each notebook
  // keeps its own persistent shell pty under a stable name) but NEVER touch
  // the agent: agents are project-scoped and the user decides when to switch
  // them (agent manager / "new agent here" chip). With an active agent the
  // same pty stays attached across notebooks — that's the point. Without one,
  // re-resolve so the launch card targets the new notebook's directory.
  useEffect(() => {
    const prevNotebook = currentNotebookRef.current;
    currentNotebookRef.current = notebookPath ?? null;
    if (prevNotebook && prevNotebook !== notebookPath) {
      setShellTerm(null);
      setWorkdirOverride(null);
      if (!getActiveAgentId()) setAgentTerm(null);
    }
  }, [notebookPath]);

  // Check server availability when panel opens (also learns the server's
  // Nebula repo path for the path-qualified MCP setup command, and its
  // hostname/port for the remote-agent tunnel command)
  useEffect(() => {
    if (!isOpen) return;

    const checkServer = async () => {
      const info = await getTerminalServerInfo();
      setServerAvailable(info.available);
      setServerHostInfo({ hostname: info.hostname, port: info.port });
      agentTerminalService.setRepoRoot(info.repoRoot);
    };

    checkServer();
  }, [isOpen]);

  // Remote-agent mode: watch whether the user's reverse SSH channel is up so
  // the launch chips can target their machine (or guide them to connect it).
  // Gate remote-agent mode on the server actually being remote: a local install
  // never shows tunnel UI or the "my machine" option (it IS your machine).
  const remoteAgentCfg = serverRemote ? agentTerminalService.getRemoteAgentConfig() : null;
  const remoteAgentPort = remoteAgentCfg?.port ?? null;
  useEffect(() => {
    if (!isOpen || tab !== 'agent' || !remoteAgentPort) {
      setReverseTunnel(null);
      return;
    }
    let stopped = false;
    const check = async () => {
      const status = await checkReverseTunnel(remoteAgentPort);
      if (!stopped) setReverseTunnel(status);
    };
    check();
    const interval = setInterval(check, 5000);
    return () => { stopped = true; clearInterval(interval); };
  }, [isOpen, tab, remoteAgentPort]);

  // Arm / clear the sticky connection-lost flag (see its declaration).
  useEffect(() => {
    if (agentState.status !== 'running') {
      setAgentConnLost(false);
    } else if (remoteAgentCfg && reverseTunnelUp === false) {
      setAgentConnLost(true);
    }
  }, [agentState.status, remoteAgentCfg, reverseTunnelUp]);

  // Lazily create the active tab's terminal when the panel is open
  const activeTerm = tab === 'agent' ? agentTerm : shellTerm;
  // Overlay ONLY when there is truly nothing to show — a parked agent tab has
  // its own placeholder, and an attached terminal shows its content.
  const pendingTerm = isOpen && serverAvailable === true && !activeTerm && !(tab === 'agent' && agentParked);
  useEffect(() => {
    if (!pendingTerm) { setShowPendingOverlay(false); return; }
    const t = setTimeout(() => setShowPendingOverlay(true), 250);
    return () => clearTimeout(t);
  }, [pendingTerm]);
  /**
   * Resolve which pty name the shell plane binds to. Binding rules:
   *   - a stored binding wins;
   *   - LEGACY-COMPAT(2026-07, self-expiring): a still-live legacy
   *     per-notebook shell is grandfathered — ptys don't survive server
   *     restarts, so this branch is dead once post-binding servers cycle;
   *     remove the legacy-name check (and the old-server fallback below)
   *     in the next release
   *     (running jobs must not be orphaned by the shared-default rollout);
   *   - otherwise the default: the server-shared terminal (srv-main).
   * cwd is only meaningful at CREATE time (get-or-create ignores it for live
   * ptys) and only set for notebook/project scopes — attaching a notebook to
   * the shared shell must never cd it out from under other notebooks.
   */
  const resolveShellTerminal = useCallback(async (
    existingIds?: Set<string>
  ): Promise<{ name: string; cwd?: string; binding: TerminalBindingInfo }> => {
    const filePath = notebookPath || 'scratch';
    let binding: TerminalBindingInfo;
    try {
      binding = await getTerminalBinding(filePath, 'shell');
    } catch {
      // Binding endpoint unavailable (old server) — behave like before.
      binding = { plane: 'shell', scope: 'notebook', name: terminalNameFor(notebookPath, 'shell'), custom_name: null, stored: false };
    }
    if (!binding.stored && binding.scope === 'server') {
      const legacyName = normalizeTerminalName(terminalNameFor(notebookPath, 'shell'));
      const ids = existingIds ?? new Set((await listTerminals()).map((t) => t.id));
      if (ids.has(legacyName)) {
        binding = { ...binding, scope: 'notebook', name: legacyName };
      }
    }
    const scopedCwd = (binding.scope === 'notebook' || binding.scope === 'project') ? notebookDir ?? undefined : undefined;
    return { name: binding.name || terminalNameFor(notebookPath, 'shell'), cwd: scopedCwd, binding };
  }, [notebookPath, notebookDir]);

  const [shellBinding, setShellBinding] = useState<TerminalBindingInfo | null>(null);
  const [showShellBindingMenu, setShowShellBindingMenu] = useState(false);

  useEffect(() => {
    if (!isOpen || !serverAvailable || activeTerm || isLoading) return;

    const createNewTerminal = async () => {
      setIsLoading(true);
      try {
        // Named get-or-create: after a refresh this reattaches to the existing
        // pty (server replays scrollback) instead of spawning a new one.
        // Shell: via the notebook's binding (default: server-shared). Agent:
        // the ACTIVE agent's pty wherever it lives, else a fresh pty scoped
        // to the chosen workdir.
        if (tab === 'agent') {
          const active = getActiveAgentId();
          const record = active ? (await listAgents()).find((a) => a.terminalId === active) : null;
          const name = record ? record.terminalId : boundAgentName;
          const agentCwd = record ? record.workdir : agentWorkdir;
          // NEVER auto-create an agent pty: attach if one exists, otherwise
          // PARK instantly (placeholder + launch bar, zero round trips —
          // hibernate lands here immediately). A pty is created only when a
          // launch was actually requested (pendingAgentLaunchRef).
          if (!pendingAgentLaunchRef.current) {
            const existing = new Set((await listTerminals()).map((t) => t.id));
            if (!existing.has(normalizeTerminalName(name))) {
              setAgentParked(true);
              return;
            }
          }
          setAgentParked(false);
          const newTerminal = await getOrCreateNamedTerminal(name, { cwd: agentCwd });
          // Hand this browser the resume pointer recorded server-side, so
          // "Resume" works even if the agent was launched from another browser.
          if (record?.sessionId) agentTerminalService.adoptSessionId(newTerminal.id, record.sessionId);
          setAgentTerm(newTerminal);
        } else {
          const resolved = await resolveShellTerminal();
          setShellBinding(resolved.binding);
          const newTerminal = await getOrCreateNamedTerminal(resolved.name, resolved.cwd ? { cwd: resolved.cwd } : {});
          setShellTerm(newTerminal);
        }
      } catch (error) {
        console.error('[TerminalPanel] Failed to create terminal:', error);
      } finally {
        setIsLoading(false);
      }
    };

    createNewTerminal();
  }, [isOpen, serverAvailable, activeTerm, isLoading, notebookPath, tab, agentWorkdir, resolveShellTerminal, agentLaunchNonce]);

  // Rebind the shell plane and re-resolve. The old pty is left alone (it may
  // hold running jobs and remains reachable via the manager / ?terminal=).
  const rebindShell = async (scope: TerminalBindingScope, name?: string) => {
    setShowShellBindingMenu(false);
    try {
      const binding = await setTerminalBinding(notebookPath || 'scratch', 'shell', scope, name);
      setShellBinding(binding);
      eagerReattachKeyRef.current = null;
      setShellTerm(null); // re-resolve on next effect pass
    } catch (error) {
      console.error('[TerminalPanel] Failed to rebind terminal:', error);
    }
  };

  // After a refresh (or switching back to a notebook), reattach BOTH of this
  // notebook's surviving ptys eagerly — not just the visible tab's. Reattachment
  // used to be lazy (on tab switch), which is invisible on a local server but on
  // a remote one puts the whole create→WS→replay round trip at the moment you
  // switch tabs ("Opening terminal…", then a settle delay). Only ptys that
  // already exist server-side are reattached; nothing is created eagerly, so
  // never-opened tabs still cost nothing.
  const eagerReattachKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || !serverAvailable) return;
    const key = notebookPath ?? 'scratch';
    if (eagerReattachKeyRef.current === key) return;
    eagerReattachKeyRef.current = key;
    let cancelled = false;
    (async () => {
      try {
        const existing = new Set((await listTerminals()).map((t) => t.id));
        const resolved = await resolveShellTerminal(existing);
        if (cancelled) return;
        setShellBinding(resolved.binding);
        if (existing.has(normalizeTerminalName(resolved.name))) {
          const info = await getOrCreateNamedTerminal(resolved.name, {});
          if (cancelled) return;
          // Keep whichever instance the lazy path may have set in the meantime.
          setShellTerm((prev) => prev ?? info);
        }
        // Agent: reattach the active agent's pty if it survived (project-
        // scoped — same pty regardless of which notebook we're in).
        const active = getActiveAgentId();
        const agentName = active ?? boundAgentName;
        if (existing.has(normalizeTerminalName(agentName))) {
          const info = await getOrCreateNamedTerminal(agentName, {});
          if (cancelled) return;
          setAgentTerm((prev) => prev ?? info);
        }
      } catch { /* best-effort: the lazy path still covers the active tab */ }
    })();
    return () => { cancelled = true; };
  }, [isOpen, serverAvailable, notebookPath]);

  // Handle terminal exit — clear so a new one can be created on demand
  const handleShellExit = useCallback((_code: number) => setShellTerm(null), []);
  const handleAgentExit = useCallback((_code: number) => {
    // The pty itself died, so the agent is definitively gone — clear the
    // persisted running flag before dropping the terminal designation.
    agentTerminalService.markStopped();
    setAgentTerm(null);
  }, []);

  // Trigger terminal resize (all mounted ptys; hidden ones no-op safely)
  const triggerTerminalResize = useCallback(() => {
    if (panelRef.current) {
      panelRef.current.querySelectorAll('[data-terminal-container]').forEach((container) => {
        if ((container as any).__terminalResize) {
          (container as any).__terminalResize();
        }
      });
    }
  }, []);

  const scheduleTerminalResize = useCallback(() => {
    if (resizeRafRef.current !== null) return;
    if (typeof window === 'undefined') return;
    resizeRafRef.current = window.requestAnimationFrame(() => {
      resizeRafRef.current = null;
      triggerTerminalResize();
    });
  }, [triggerTerminalResize]);

  // Trigger terminal resize when height changes (after React updates DOM)
  useEffect(() => {
    if (!isOpen) return;
    scheduleTerminalResize();
  }, [height, isOpen, scheduleTerminalResize]);

  // Resize handling
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const startY = e.clientY;
    const startHeight = height;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = startY - moveEvent.clientY;
      const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + deltaY));
      setHeight(newHeight);
      scheduleTerminalResize();
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      resizeCleanupRef.current = null;
      scheduleTerminalResize();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    resizeCleanupRef.current = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [height, triggerTerminalResize]);

  // Cleanup resize listeners on unmount
  useEffect(() => {
    return () => {
      if (resizeCleanupRef.current) {
        resizeCleanupRef.current();
      }
      if (resizeRafRef.current !== null) {
        window.cancelAnimationFrame(resizeRafRef.current);
      }
    };
  }, []);

  // After the first open, stay mounted (hidden) when closed: the terminal
  // WebSockets stay alive, so a running agent keeps receiving injected
  // prompts and its status isn't lost on close/reopen.
  if (!isOpen && !everOpened) return null;

  // Get notebook name for display
  const notebookName = notebookPath
    ? notebookPath.split('/').pop()?.replace(/\.(ipynb|qmd)$/i, '') || 'Terminal'
    : 'Terminal';

  return (
    <div
      ref={panelRef}
      data-testid="terminal-panel"
      className={`flex-none flex flex-col bg-transparent overflow-hidden ${isOpen ? '' : 'hidden'}`}
      style={{ height: `${height}px` }}
    >
      {/* Resize Handle - transparent hit area, cursor indicates draggable */}
      <div
        data-testid="terminal-resize-handle"
        className="h-2 cursor-ns-resize flex-shrink-0 bg-slate-200/30 hover:bg-slate-300/50 transition-colors"
        onMouseDown={handleResizeStart}
      />

      {/* Compact Header — Shell / Agent tabs; empty area click closes */}
      <div
        className="flex items-center justify-between px-2 py-0.5 bg-slate-100 border-b border-slate-200 flex-shrink-0 cursor-pointer hover:bg-slate-200 transition-colors"
        onClick={onClose}
      >
        <div className="flex items-center gap-1 text-xs font-medium text-slate-600">
          <button
            onClick={(e) => { e.stopPropagation(); setTab('shell'); }}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors ${
              tab === 'shell' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'
            }`}
            title={`Plain terminal for ${notebookName}`}
          >
            <Terminal className="w-3 h-3" />
            <span>{notebookName}</span>
          </button>
          {tab === 'shell' && shellBinding && (
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={(e) => { setShellMenuRect(e.currentTarget.getBoundingClientRect()); setShowShellBindingMenu((v) => !v); }}
                className="px-1.5 py-0.5 rounded text-[0.6875rem] text-slate-400 hover:text-slate-600 hover:bg-white transition-colors font-mono"
                title={`This notebook's terminal binding: ${shellBinding.name || ''} — click to change. Attach is always deterministic; rebinding never kills the old terminal.`}
              >
                {shellBinding.scope === 'server' ? 'shared ▾'
                  : shellBinding.scope === 'project' ? 'project ▾'
                  : shellBinding.scope === 'notebook' ? 'this notebook ▾'
                  : `${shellBinding.custom_name || shellBinding.name} ▾`}
              </button>
              {showShellBindingMenu && (
                <div
                  className="fixed z-[80] bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[15rem] text-xs overflow-y-auto"
                  style={shellMenuRect ? { top: shellMenuRect.bottom + 4, left: Math.min(shellMenuRect.left, window.innerWidth - 260), maxHeight: window.innerHeight - shellMenuRect.bottom - 16 } : undefined}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-3 py-1 text-[0.625rem] uppercase tracking-wide text-slate-400">Terminal for this notebook</div>
                  <button
                    onClick={() => rebindShell('server')}
                    className={`w-full text-left px-3 py-1.5 hover:bg-slate-50 ${shellBinding.scope === 'server' ? 'text-slate-800 font-medium' : 'text-slate-600'}`}
                  >
                    Shared on this server{shellBinding.scope === 'server' ? ' ✓' : ''}
                    <div className="text-[0.625rem] text-slate-400">One terminal for all notebooks (default)</div>
                  </button>
                  <button
                    onClick={() => rebindShell('project')}
                    className={`w-full text-left px-3 py-1.5 hover:bg-slate-50 ${shellBinding.scope === 'project' ? 'text-slate-800 font-medium' : 'text-slate-600'}`}
                  >
                    This project{shellBinding.scope === 'project' ? ' ✓' : ''}
                    <div className="text-[0.625rem] text-slate-400 truncate">Shared by notebooks in {notebookDir?.split('/').pop() || 'this folder'}/</div>
                  </button>
                  <button
                    onClick={() => rebindShell('notebook')}
                    className={`w-full text-left px-3 py-1.5 hover:bg-slate-50 ${shellBinding.scope === 'notebook' ? 'text-slate-800 font-medium' : 'text-slate-600'}`}
                  >
                    Private to this notebook{shellBinding.scope === 'notebook' ? ' ✓' : ''}
                    <div className="text-[0.625rem] text-slate-400">Own terminal, starts in the notebook's folder</div>
                  </button>
                  <button
                    onClick={() => {
                      const name = window.prompt('Terminal name (shared by anything bound to the same name):', shellBinding.custom_name || '');
                      if (name && name.trim()) rebindShell('named', name.trim());
                      else setShowShellBindingMenu(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 hover:bg-slate-50 ${shellBinding.scope === 'named' ? 'text-slate-800 font-medium' : 'text-slate-600'}`}
                  >
                    Named…{shellBinding.scope === 'named' ? ` (${shellBinding.custom_name || shellBinding.name}) ✓` : ''}
                    <div className="text-[0.625rem] text-slate-400">Pick or create a named terminal</div>
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setTab('agent'); }}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors ${
              tab === 'agent' ? 'bg-white shadow-sm text-purple-700' : 'text-slate-500 hover:text-purple-600'
            }`}
            title="Agent terminal — Claude Code / Codex driving this notebook"
          >
            <Bot className="w-3 h-3" />
            <span>Agent</span>
            {agentState.status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>}
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Manager toggle — a CONTROL, not a tab: bordered chip on the right,
              away from the tab group it used to be mistaken for. */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowAgentManager((v) => !v);
              refreshAgents();
              listTerminals().then(setManagerTerms).catch(() => { /* section just stays empty */ });
            }}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[0.6875rem] transition-colors ${
              showAgentManager
                ? 'border-purple-300 bg-purple-50 text-purple-700'
                : 'border-slate-200 bg-white text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }`}
            title="Terminals & agents — every pty and agent on this server, live or hibernated. Nothing here is auto-killed."
          >
            <ListTree className="w-3 h-3" />
            <span>manage</span>
            {agents.filter((a) => a.state === 'live').length > 0 && (
              <span
                className="px-1 rounded-full bg-purple-100 text-purple-700 text-[0.625rem] leading-4"
                title={`${agents.filter((a) => a.state === 'live').length} live agent${agents.filter((a) => a.state === 'live').length === 1 ? '' : 's'}`}
              >
                {agents.filter((a) => a.state === 'live').length}
              </span>
            )}
          </button>
          <button
            onClick={onClose}
            className="p-0.5 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded transition-colors"
            title="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Agent manager — the ledger of agents; nothing here is auto-killed */}
      {showAgentManager && (
        <div className="border-b border-slate-200 bg-slate-50 flex-shrink-0 max-h-40 overflow-y-auto text-xs">
          {agents.length === 0 ? (
            <div className="px-3 py-2 text-slate-400">No agents yet — launch one from the Agent tab. Agents persist (hibernated ones can be revived) until you delete them.</div>
          ) : (
            agents.map((a) => {
              const isActive = a.terminalId === activeAgentId;
              const dirName = a.workdir.split('/').pop() || a.workdir;
              return (
                <div key={a.terminalId} className={`flex items-center gap-2 px-3 py-1 border-b border-slate-100 last:border-b-0 ${isActive ? 'bg-purple-50' : ''}`}>
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${a.state === 'live' ? 'bg-green-500' : 'bg-slate-300'}`} title={a.state} />
                  <span className="font-medium text-slate-700 flex-shrink-0">{a.kind}</span>
                  <span className="text-slate-500 truncate" title={a.workdir}>{dirName}</span>
                  {a.location === 'remote' && <span className="px-1 rounded bg-blue-100 text-blue-700 text-[0.625rem] flex-shrink-0">your machine</span>}
                  {isActive && <span className="px-1 rounded bg-purple-100 text-purple-700 text-[0.625rem] flex-shrink-0">attached</span>}
                  <span className="flex-1" />
                  {!isActive && (() => {
                    // idleShell: pty alive but nothing running in it — the
                    // agent is gone; offer continue (resume), not attach.
                    const attachable = (a.state === 'live' && !a.idleShell) || a.busy === true;
                    // Reviving a your-machine agent needs the reverse tunnel —
                    // disable with the reason instead of failing after launch.
                    const tunnelBlocked = !attachable && a.location === 'remote' && reverseTunnelUp === false;
                    return (
                      <button
                        onClick={() => {
                          if (tunnelBlocked) return;
                          setShowAgentManager(false);
                          setTab('agent'); // manager is reachable from both tabs now
                          if (attachable) selectAgent(a.terminalId);
                          else continueAgentRecord(a);
                        }}
                        disabled={tunnelBlocked}
                        className="px-1.5 py-0.5 rounded border border-purple-200 bg-white text-purple-700 hover:bg-purple-100 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                        title={tunnelBlocked
                          ? 'This agent runs on YOUR machine — connect the reverse tunnel (Burrow/ssh) first'
                          : attachable ? 'Attach this tab to the running agent' : 'Reopen this agent’s conversation where it left off'}
                      >
                        {attachable ? 'attach' : 'continue'}
                      </button>
                    );
                  })()}
                  {a.state === 'live' && (
                    <button
                      onClick={async () => {
                        await hibernateAgent(a.terminalId);
                        // Detach based on the ATTACHED pty, not the selected id —
                        // auto-attach (workdir resolution) attaches without selecting,
                        // and leaving a killed pty mounted reconnect-loops forever.
                        if (agentTerm?.id === a.terminalId) { setAgentParked(true); setAgentTerm(null); }
                        if (isActive) selectAgent(null);
                        refreshAgents();
                        refreshManagerTerms();
                      }}
                      className="px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 flex-shrink-0"
                      title="Stop the process but keep the conversation on disk — revive it any time with Resume"
                    >
                      hibernate
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      await deleteAgent(a.terminalId);
                      if (agentTerm?.id === a.terminalId) { setAgentParked(true); setAgentTerm(null); } // same stale-pty hazard as hibernate
                      if (isActive) selectAgent(null);
                      refreshAgents();
                      refreshManagerTerms();
                    }}
                    className="px-1.5 py-0.5 rounded border border-red-100 bg-white text-red-500 hover:bg-red-50 flex-shrink-0"
                    title="Kill the process and forget this agent (its CLI transcript remains on disk)"
                  >
                    delete
                  </button>
                </div>
              );
            })
          )}
          {/* Terminals: every non-agent pty on this server, with its binding role */}
          {managerTerms.filter((t) => !agents.some((a) => a.terminalId === t.id)).length > 0 && (
            <>
              <div className="px-3 py-1 text-[0.625rem] uppercase tracking-wide text-slate-400 bg-slate-100">Terminals</div>
              {managerTerms.filter((t) => !agents.some((a) => a.terminalId === t.id)).map((t) => {
                // Pty ids are namespaced identities (srv-/proj-/nb- prefixes keep
                // scopes collision-free) — show the human meaning, keep the raw
                // id in the tooltip for anyone who needs ?terminal=<id>.
                const hashSlug = (id: string) => id.split('-').slice(2).join('-');
                const { label, role } = t.id === 'srv-main'
                  ? { label: 'Shared terminal', role: 'this server' }
                  : t.id.startsWith('agent-')
                  ? { label: t.id === 'agent-srv' ? 'Shared agent' : t.id.replace(/^agent-([0-9a-f]{6}-)?/, ''), role: 'agent · orphaned' }
                  : t.id.startsWith('proj-')
                  ? { label: `${hashSlug(t.id)}/`, role: 'project' }
                  : t.id.startsWith('nb-')
                  ? { label: hashSlug(t.id).replace(/^(shell|agent)-/, ''), role: 'notebook' }
                  : t.id.length > 32
                  ? { label: t.id.slice(0, 8) + '…', role: 'session' }
                  : { label: t.id, role: 'named' };
                return (
                  <div key={t.id} className="flex items-center gap-2 px-3 py-1 border-b border-slate-100 last:border-b-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" title="live pty" />
                    <span className="text-slate-700 truncate" title={t.id}>{label}</span>
                    <span className="px-1 rounded bg-slate-200 text-slate-500 text-[0.625rem] flex-shrink-0">{role}</span>
                    <span className="text-slate-400 truncate" title={t.cwd}>{t.cwd.split('/').pop() || t.cwd}</span>
                    <span className="flex-1" />
                    <button
                      onClick={() => window.open(`/?terminal=${encodeURIComponent(t.id)}`, '_blank')}
                      className="px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 flex-shrink-0"
                      title="Open full-screen in a new tab"
                    >
                      open
                    </button>
                    <button
                      onClick={async () => {
                        try { await closeTerminal(t.id); } catch { /* already gone */ }
                        try { setManagerTerms(await listTerminals()); } catch { /* refresh best-effort */ }
                      }}
                      className="px-1.5 py-0.5 rounded border border-red-100 bg-white text-red-500 hover:bg-red-50 flex-shrink-0"
                      title="Kill this terminal (anything running in it stops)"
                    >
                      kill
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* Working elsewhere chip — the agent follows YOU, not the notebook.
          Only offer (never force) a project-local agent when dirs differ. */}
      {tab === 'agent' && !showAgentManager && activeAgentRecord && notebookDir && activeAgentRecord.workdir !== notebookDir && (
        <div className="flex items-center gap-2 px-2 py-1 bg-indigo-50 border-b border-indigo-100 flex-shrink-0 text-xs">
          <Bot className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" />
          <span className="text-indigo-800 truncate">
            This agent works in <span className="font-mono" title={activeAgentRecord.workdir}>{activeAgentRecord.workdir.split('/').pop()}</span> — this notebook lives elsewhere. It can still read and edit it.
          </span>
          <span className="flex-1" />
          <button
            onClick={() => { selectAgent(null); setWorkdirOverride(null); }}
            className="px-1.5 py-0.5 rounded border border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-100 flex-shrink-0"
            title="Detach and set up a fresh agent scoped to this notebook's directory (the current agent keeps running — find it under agents)"
          >
            new agent here
          </button>
        </div>
      )}

      {/* Remote-agent tunnel guide — reverse channel not connected yet */}
      {tab === 'agent' && (agentTerm || agentParked) && agentState.status !== 'running' && remoteAgentCfg && reverseTunnelUp === false && (
        <div className="flex items-center gap-2 px-2 py-1 bg-amber-50 border-b border-amber-200 flex-shrink-0 text-xs">
          <Bot className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
          <span className="text-amber-800 font-medium flex-shrink-0">
            {reverseTunnel?.up && reverseTunnel.ssh === false
              ? <>Tunnel is up, but nothing answered SSH on your machine — enable Remote Login (macOS: System Settings → Sharing).</>
              : <>Waiting for your machine (reverse port {remoteAgentCfg.port}) — connect the tunnel:</>}
          </span>
          <button
            onClick={async () => {
              try { await navigator.clipboard.writeText(agentTerminalService.buildBurrowCommand(serverHostInfo.hostname, serverHostInfo.port)); } catch { /* clipboard optional */ }
            }}
            className="px-1.5 py-0.5 rounded bg-amber-600 text-white font-medium hover:bg-amber-700 flex-shrink-0"
            title={`Using Burrow (recommended — supervised, auto-reconnect): run once on your machine, then connect from the menu bar.\n${agentTerminalService.buildBurrowCommand(serverHostInfo.hostname, serverHostInfo.port)}`}
          >
            copy Burrow command
          </button>
          <button
            onClick={async () => {
              try { await navigator.clipboard.writeText(agentTerminalService.buildTunnelCommand(serverHostInfo.hostname, serverHostInfo.port)); } catch { /* clipboard optional */ }
          }}
            className="text-amber-700 hover:text-amber-900 underline decoration-dotted flex-shrink-0"
            title={`Plain ssh alternative (replaces your usual port-forward):\n${agentTerminalService.buildTunnelCommand(serverHostInfo.hostname, serverHostInfo.port)}`}
          >
            copy ssh command
          </button>
          <button
            onClick={() => setShowRemoteSetup(true)}
            className="text-amber-700 hover:text-amber-900 underline decoration-dotted flex-shrink-0"
            title="Ports, username, jump host, and the full setup guide"
          >
            setup…
          </button>
          <span className="ml-auto text-amber-500 flex-shrink-0 hidden sm:inline">auto-detects · rechecking every 5s</span>
          <button
            onClick={() => { saveSettings({ remoteAgentEnabled: false }); setSettingsNonce(n => n + 1); }}
            className="text-amber-600 hover:text-amber-800 underline decoration-dotted flex-shrink-0"
            title="Run the agent on this server instead"
          >
            use this server
          </button>
        </div>
      )}

      {/* Remote agent frozen — the tunnel dropped under a running agent, so the
          TUI is dead but no exit ever fires. Offer recovery without a trip to
          the manage tab (previously the only way out was deleting the records). */}
      {tab === 'agent' && agentConnLost && agentState.status === 'running' && remoteAgentCfg && (() => {
        const boundId = normalizeTerminalName(boundAgentName);
        const rec = agents
          .filter((a) => a.terminalId === boundId && (a.location ?? 'server') === 'remote')
          .sort((a, b) => (b.lastLaunchAt ?? 0) - (a.lastLaunchAt ?? 0))[0] ?? null;
        const kind: 'claude' | 'codex' = rec?.kind === 'codex' ? 'codex' : 'claude';
        const breakThen = (next: () => void) => {
          agentTerminalService.breakRemoteConnection();
          setAgentConnLost(false);
          // Give ssh a beat to die and the shell prompt to return before typing.
          window.setTimeout(next, 700);
        };
        return (
          <div data-testid="agent-conn-lost-bar" className="flex items-center gap-2 px-2 py-1 bg-amber-50 border-b border-amber-200 flex-shrink-0 text-xs">
            <Bot className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
            <span className="text-amber-800 font-medium truncate">
              {reverseTunnelUp === false
                ? <>Connection to your machine lost — this agent session is frozen. Reconnect the tunnel, then:</>
                : <>Tunnel is back, but this agent session died with the old connection:</>}
            </span>
            <button
              onClick={() => breakThen(() => {
                if (rec) continueAgentRecord(rec);
                else requestAgentLaunch(kind, { resume: true, workdir: agentWorkdir });
              })}
              className="px-2 py-0.5 rounded bg-amber-600 text-white font-medium hover:bg-amber-700 flex-shrink-0"
              title="End the dead ssh hop, then reopen this conversation where it left off"
            >
              ⟳ Restart & continue
            </button>
            <button
              onClick={() => breakThen(() => requestAgentLaunch(kind, { workdir: agentWorkdir }))}
              className="px-2 py-0.5 rounded border border-amber-400 bg-white text-amber-700 font-medium hover:bg-amber-100 flex-shrink-0"
              title="End the dead ssh hop and start a brand-new agent session"
            >
              start new agent
            </button>
            {reverseTunnelUp === false && (
              <button
                onClick={async () => {
                  try { await navigator.clipboard.writeText(agentTerminalService.buildBurrowCommand(serverHostInfo.hostname, serverHostInfo.port)); } catch { /* clipboard optional */ }
                }}
                className="text-amber-700 hover:text-amber-900 underline decoration-dotted flex-shrink-0"
                title={`Reconnect with Burrow:\n${agentTerminalService.buildBurrowCommand(serverHostInfo.hostname, serverHostInfo.port)}`}
              >
                copy Burrow command
              </button>
            )}
          </div>
        );
      })()}

      {/* Launch failed — show the shell error, keep the launch buttons for retry */}
      {tab === 'agent' && agentTerm && agentState.status === 'failed' && (
        <div className="flex items-start gap-2 px-2 py-1 bg-red-50 border-b border-red-100 flex-shrink-0 text-xs text-red-700">
          <span className="flex-shrink-0">⚠</span>
          <span className="min-w-0">
            Agent didn’t start: <span className="font-mono break-all">{agentState.launchError || 'unknown error'}</span>
            {/(not found|not recognized|no such file|permission denied|cannot execute)/i.test(agentState.launchError || '') && (
              <> — check it’s installed{remoteAgentCfg ? ' on your machine' : ' on this server'} and on PATH, then try again.</>
            )}
          </span>
          {/* Escape hatch AT the wrong verdict: detection is inference and can
              mis-score — let the user assert the truth right here instead of
              hunting for it in the more▾ menu. markRunning re-verifies against
              the process table, so a wrong assertion can't type into a bare
              shell. copy-prompt covers "I'll paste the context myself". */}
          <button
            onClick={() => { void agentTerminalService.markRunning(); }}
            className="ml-auto flex-shrink-0 px-2 py-0.5 rounded border border-red-300 bg-white text-red-700 font-medium hover:bg-red-100 whitespace-nowrap"
            title="The agent IS running in the terminal below — mark it active and send it the notebook context"
          >
            it IS running
          </button>
          <button
            onClick={async () => { try { await navigator.clipboard.writeText(agentTerminalService.buildBootstrapPrompt()); } catch { /* clipboard optional */ } }}
            className="flex-shrink-0 px-2 py-0.5 rounded text-red-600 underline decoration-dotted hover:text-red-800 whitespace-nowrap"
            title="Copy the notebook-context prompt to paste into the agent yourself"
          >
            copy context
          </button>
        </div>
      )}

      {/* Agent guidance bar — the on-ramp for driving the notebook with an agent */}
      {tab === 'agent' && (agentTerm || agentParked) && agentState.status !== 'running' && !(remoteAgentCfg && reverseTunnelUp === false) && (
        <div className="flex items-center gap-2 px-2 py-1 bg-purple-50 border-b border-purple-100 flex-shrink-0 text-xs">
          <Bot className="w-3.5 h-3.5 text-purple-600 flex-shrink-0" />
          <span className="text-purple-800 font-medium truncate min-w-0 max-w-[9rem] md:max-w-[14rem]" title={notebookName}>
            <span className="hidden md:inline">Drive </span>
            <span className="font-semibold">{notebookName}</span>
            <span className="hidden md:inline"> with</span>
          </span>
          {(() => {
            // Primary-button state machine: ONE obvious action derived from
            // the server-side agent records for this workdir + location;
            // alternatives live in the "more" menu.
            const loc = remoteAgentCfg ? 'remote' : 'server';
            const byRecency = (a: AgentRecord, b: AgentRecord) => (b.lastLaunchAt ?? 0) - (a.lastLaunchAt ?? 0);
            const boundId = normalizeTerminalName(boundAgentName);
            const hereRecord = agents
              .filter((a) => a.terminalId === boundId && (a.location ?? 'server') === loc)
              .sort(byRecency)[0] ?? null;
            const elsewhereRecord = !hereRecord ? (agents
              .filter((a) => a.terminalId === boundId && (a.location ?? 'server') !== loc)
              .sort(byRecency)[0] ?? null) : null;

            const startFresh = (kind: 'claude' | 'codex') => {
              setShowAgentMoreMenu(false);
              requestAgentLaunch(kind, { workdir: agentWorkdir });
            };
            const pickSession = (kind: 'claude' | 'codex') => {
              setShowAgentMoreMenu(false);
              requestAgentLaunch(kind, { continueProject: true, workdir: agentWorkdir });
            };

            return (
              <>
                {hereRecord && ((hereRecord.state === 'live' && !hereRecord.idleShell) || hereRecord.busy === true) ? (
                  <button
                    onClick={() => selectAgent(hereRecord.terminalId)}
                    className="px-2 py-0.5 whitespace-nowrap flex-shrink-0 rounded bg-purple-700 text-white font-medium hover:bg-purple-800 transition-colors"
                    title={`A ${hereRecord.kind} agent is already running for this project — attach to it`}
                  >
                    Attach agent
                  </button>
                ) : hereRecord ? (
                  <button
                    onClick={() => continueAgentRecord(hereRecord)}
                    disabled={!agentConnected && !agentParked && activeAgentId === hereRecord.terminalId}
                    className="px-2 py-0.5 whitespace-nowrap flex-shrink-0 rounded bg-purple-700 text-white font-medium hover:bg-purple-800 disabled:opacity-40 transition-colors"
                    title={hereRecord.kind === 'claude' && hereRecord.sessionId
                      ? 'Reopen this project’s conversation exactly where it left off (claude --resume <id>)'
                      : 'Reopen this project’s sessions (interactive picker)'}
                  >
                    ⟳ Continue session
                  </button>
                ) : (
                  <button
                    onClick={() => startFresh('claude')}
                    disabled={!agentConnected && !agentParked}
                    className="px-2 py-0.5 whitespace-nowrap flex-shrink-0 rounded bg-purple-600 text-white font-medium hover:bg-purple-700 disabled:opacity-40 transition-colors"
                    title={remoteAgentCfg ? 'Start Claude Code on YOUR machine (over the reverse tunnel) and drive this notebook' : 'Start Claude Code in its agent workspace and drive this notebook'}
                  >
                    Claude Code
                  </button>
                )}
                {!hereRecord && (
                  <button
                    onClick={() => startFresh('codex')}
                    disabled={!agentConnected && !agentParked}
                    className="px-2 py-0.5 whitespace-nowrap flex-shrink-0 rounded bg-purple-600 text-white font-medium hover:bg-purple-700 disabled:opacity-40 transition-colors"
                    title={remoteAgentCfg ? 'Start Codex on YOUR machine (over the reverse tunnel)' : 'Start Codex in its agent workspace'}
                  >
                    Codex
                  </button>
                )}
                {elsewhereRecord && (
                  <span
                    className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-600 text-[0.6875rem] flex-shrink-0"
                    title={`This project has a ${elsewhereRecord.kind} session ${elsewhereRecord.location === 'remote' ? 'on your machine' : 'on the server'} — conversations can't move between machines. Switch the agent location (settings) to continue it there.`}
                  >
                    session {elsewhereRecord.location === 'remote' ? 'on your machine' : 'on server'} ↗
                  </span>
                )}
                <div className="relative flex-shrink-0">
                  <button
                    onClick={(e) => { setMoreMenuRect(e.currentTarget.getBoundingClientRect()); setShowAgentMoreMenu((v) => !v); }}
                    disabled={!agentConnected && !agentParked}
                    className="px-1.5 py-0.5 rounded border border-purple-300 bg-white text-purple-700 font-medium hover:bg-purple-100 disabled:opacity-40 transition-colors"
                    title="More ways to start: fresh session, session picker, other agent"
                  >
                    more ▾
                  </button>
                  {showAgentMoreMenu && (
                    <div
                      className="fixed z-[80] bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[15rem] max-w-[20rem] text-xs overflow-y-auto"
                      style={moreMenuRect ? { bottom: window.innerHeight - moreMenuRect.top + 4, right: Math.max(8, window.innerWidth - moreMenuRect.right), maxHeight: Math.min(360, moreMenuRect.top - 16) } : undefined}
                    >
                      <button onClick={() => startFresh('claude')} className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-purple-50">
                        New Claude session
                      </button>
                      <button onClick={() => startFresh('codex')} className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-purple-50">
                        New Codex session
                      </button>
                      <button onClick={() => pickSession('claude')} className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-purple-50">
                        Pick a Claude session…
                        <div className="text-[0.625rem] text-slate-400">This project's Nebula agent conversations</div>
                      </button>
                      <button onClick={() => pickSession('codex')} className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-purple-50">
                        Pick a Codex session…
                      </button>
                      <div className="border-t border-slate-100 my-1" />
                      <button
                        onClick={() => { setShowAgentMoreMenu(false); void agentTerminalService.markRunning(); }}
                        className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-purple-50"
                        title="I already started an agent in this terminal myself"
                      >
                        Already running here
                        <div className="text-[0.625rem] text-slate-400">Mark this terminal's agent as active</div>
                      </button>
                      <button
                        onClick={async () => { setShowAgentMoreMenu(false); try { await navigator.clipboard.writeText(agentTerminalService.buildBootstrapPrompt()); } catch { /* clipboard optional */ } }}
                        className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-purple-50"
                        title="Copy the orientation prompt (server URL + notebook) for an agent running anywhere"
                      >
                        Copy context prompt
                      </button>
                      <button
                        onClick={async () => { setShowAgentMoreMenu(false); try { await navigator.clipboard.writeText(agentTerminalService.buildSetupSkillCommand()); } catch { /* clipboard optional */ } }}
                        className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-purple-50"
                        title={`Drive Nebula from an agent on another machine — copies the CLI skill setup command. Prefer MCP? ${agentTerminalService.buildSetupMcpCommand()}`}
                      >
                        Copy CLI setup (other machine)
                      </button>
                    </div>
                  )}
                </div>
              </>
            );
          })()}
          <div className="relative flex-shrink-0">
            <button
              onClick={(e) => { setWorkdirMenuRect(e.currentTarget.getBoundingClientRect()); setShowWorkdirMenu((v) => !v); }}
              className="px-1.5 py-0.5 rounded border border-purple-200 bg-white text-purple-700 hover:bg-purple-100 font-mono max-w-[6.5rem] md:max-w-[10rem] truncate flex-shrink-0"
              title={`Project scope: ${agentWorkdir} (the agent itself runs in a mirrored ~/.nebula/agent workspace${remoteAgentCfg ? ' on your machine' : ''}) — click to change`}
            >
              {agentScope === 'server' ? 'shared agent ▾'
                : agentScope === 'notebook' ? 'this notebook ▾'
                : agentScope === 'named' ? `${agentBinding?.custom_name || 'named'} ▾`
                : `in ${agentWorkdir.split('/').pop() || agentWorkdir} ▾`}
            </button>
            {showWorkdirMenu && (
              <div
                className="fixed z-[80] bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[14rem] max-w-[22rem] text-xs overflow-y-auto"
                style={workdirMenuRect ? { bottom: window.innerHeight - workdirMenuRect.top + 4, left: Math.min(workdirMenuRect.left, window.innerWidth - 360), maxHeight: Math.min(360, workdirMenuRect.top - 16) } : undefined}
              >
                <div className="px-3 py-1 text-[0.625rem] uppercase tracking-wide text-slate-400">Agent scope</div>
                <button onClick={() => rebindAgent('project')} className={`w-full text-left px-3 py-1 hover:bg-purple-50 ${agentScope === 'project' ? 'text-purple-700 font-medium' : 'text-slate-700'}`}>
                  This project{agentScope === 'project' ? ' ✓' : ''}
                  <div className="text-[0.625rem] text-slate-400">One agent per folder (default) — folder below</div>
                </button>
                <button onClick={() => rebindAgent('server')} className={`w-full text-left px-3 py-1 hover:bg-purple-50 ${agentScope === 'server' ? 'text-purple-700 font-medium' : 'text-slate-700'}`}>
                  Shared on this server{agentScope === 'server' ? ' ✓' : ''}
                  <div className="text-[0.625rem] text-slate-400">One agent for all notebooks — messages are tagged per notebook</div>
                </button>
                <button onClick={() => rebindAgent('notebook')} className={`w-full text-left px-3 py-1 hover:bg-purple-50 ${agentScope === 'notebook' ? 'text-purple-700 font-medium' : 'text-slate-700'}`}>
                  Private to this notebook{agentScope === 'notebook' ? ' ✓' : ''}
                  <div className="text-[0.625rem] text-slate-400">Own agent even when notebooks share a folder</div>
                </button>
                <button
                  onClick={async () => {
                    setShowWorkdirMenu(false);
                    const name = await promptText({
                      title: 'Named agent',
                      message: 'Notebooks bound to the same name share this agent (e.g. paper-writer).',
                      placeholder: 'paper-writer',
                      defaultValue: agentBinding?.custom_name || '',
                      confirmLabel: 'Use name',
                    });
                    if (name && name.trim()) rebindAgent('named', name.trim());
                  }}
                  className={`w-full text-left px-3 py-1 hover:bg-purple-50 ${agentScope === 'named' ? 'text-purple-700 font-medium' : 'text-slate-700'}`}
                >
                  Named…{agentScope === 'named' ? ` (${agentBinding?.custom_name || agentBinding?.name}) ✓` : ''}
                  <div className="text-[0.625rem] text-slate-400">A deliberately shared agent, picked by name</div>
                </button>
                <div className="border-t border-slate-100 my-1" />
                <div className="px-3 py-1 text-[0.625rem] uppercase tracking-wide text-slate-400">Agent project folder</div>
                {notebookDir && (
                  <button
                    onClick={() => { setWorkdirOverride(null); setShowWorkdirMenu(false); if (!getActiveAgentId()) setAgentTerm(null); }}
                    className={`w-full text-left px-3 py-1 hover:bg-purple-50 ${agentWorkdir === notebookDir ? 'text-purple-700 font-medium' : 'text-slate-700'}`}
                  >
                    <div>This notebook’s folder{agentWorkdir === notebookDir ? ' ✓' : ''}</div>
                    <div className="font-mono text-slate-400 truncate">{notebookDir}</div>
                  </button>
                )}
                {[...new Set(agents.map((a) => a.workdir))]
                  .filter((d) => d && d !== notebookDir)
                  .slice(0, 6)
                  .map((d) => (
                    <button
                      key={d}
                      onClick={() => { setWorkdirOverride(d); setShowWorkdirMenu(false); if (!getActiveAgentId()) setAgentTerm(null); }}
                      className={`w-full text-left px-3 py-1 hover:bg-purple-50 ${agentWorkdir === d ? 'text-purple-700 font-medium' : 'text-slate-700'}`}
                    >
                      <div>{d.split('/').pop()}{agentWorkdir === d ? ' ✓' : ''} <span className="text-slate-400">(existing agent)</span></div>
                      <div className="font-mono text-slate-400 truncate">{d}</div>
                    </button>
                  ))}
                <button
                  onClick={async () => {
                    setShowWorkdirMenu(false);
                    const dir = await promptText({
                      title: 'Agent project folder',
                      message: remoteAgentCfg
                        ? 'Server path that defines this agent’s project scope (the agent itself runs in a mirrored folder on your machine).'
                        : 'Directory that defines this agent’s project scope (the agent itself runs in a mirrored ~/.nebula/agent folder).',
                      placeholder: notebookDir || '/path/to/project',
                      defaultValue: agentWorkdir,
                      confirmLabel: 'Use folder',
                    });
                    if (dir) { setWorkdirOverride(dir); if (!getActiveAgentId()) setAgentTerm(null); }
                  }}
                  className="w-full text-left px-3 py-1 text-slate-700 hover:bg-purple-50 border-t border-slate-100"
                >
                  Other folder…
                </button>
              </div>
            )}
          </div>
          {/* Where the agent runs is only a question when the server is remote.
              On a local install the server IS your machine — no selector. */}
          {serverRemote && (
            <>
              <span className="text-purple-600 flex-shrink-0 hidden md:inline">on</span>
              <select
                value={remoteAgentCfg ? 'mine' : 'server'}
                onChange={(e) => {
                  if (e.target.value === 'mine') {
                    const s = getSettings();
                    const port = s.remoteAgentPort ?? ensureRemoteAgentPort();
                    // One where-choice drives BOTH the agent terminal and
                    // autocomplete: agentRunsOn is what the autocomplete transport
                    // reads (see aiAutocompleteService).
                    saveSettings({ remoteAgentEnabled: true, remoteAgentPort: port, agentRunsOn: 'mine' });
                    // Missing username → the mode can't compose the ssh-back line;
                    // open the setup dialog to finish configuration.
                    if (!s.remoteAgentUser?.trim()) setShowRemoteSetup(true);
                    else probeRemoteBins(); // discover the user's claude/codex for autocomplete
                  } else {
                    saveSettings({ remoteAgentEnabled: false, agentRunsOn: 'server' });
                  }
                  setSettingsNonce(n => n + 1);
                }}
                className="px-1 py-0.5 rounded border border-purple-300 bg-white text-purple-800 font-medium cursor-pointer focus:outline-none focus:ring-1 focus:ring-purple-400"
                title="Where the agent process runs. 'my machine' hops back over your SSH tunnel — the agent uses your computer's memory and network but lives in this panel."
              >
                <option value="server">This server</option>
                <option value="mine">Local machine</option>
              </select>
            </>
          )}
          {remoteAgentCfg && reverseTunnelUp && (
            <button
              onClick={() => setShowRemoteSetup(true)}
              className="flex items-center gap-1 flex-shrink-0 text-green-600 hover:text-green-800"
              title={`Reverse tunnel connected (port ${remoteAgentCfg.port}) — click for setup details`}
            >
              <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
              <span className="hidden lg:inline">tunnel</span>
            </button>
          )}
        </div>
      )}
      {tab === 'agent' && agentTerm && agentState.status === 'running' && (
        agentConnected ? (
          <div className="flex items-center gap-2 px-2 py-1 bg-green-50 border-b border-green-100 flex-shrink-0 text-xs">
            <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0"></span>
            <span className="text-green-800 truncate">
              Agent active{agentState.agentKind && agentState.agentKind !== 'manual' ? ` (${agentState.agentKind})` : ''} · driving <span className="font-semibold">{notebookName}</span> — type instructions here, or use “Fix with agent” on a failing cell
            </span>
            <button
              onClick={() => agentTerminalService.markStopped()}
              className="ml-auto text-green-600 hover:text-green-800 underline decoration-dotted flex-shrink-0"
              title="The agent exited — show launch options again"
            >
              agent exited?
            </button>
          </div>
        ) : (
          // Connection to the pty dropped (network blip / tunnel flap). The
          // agent keeps running server-side; the terminal auto-reconnects.
          <div className="flex items-center gap-2 px-2 py-1 bg-amber-50 border-b border-amber-100 flex-shrink-0 text-xs">
            <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse flex-shrink-0"></span>
            <span className="text-amber-800 truncate">
              Connection lost — reconnecting to the agent terminal… the agent keeps running; prompts resume when reconnected
            </span>
            <button
              onClick={() => agentTerminalService.markStopped()}
              className="ml-auto text-amber-600 hover:text-amber-800 underline decoration-dotted flex-shrink-0"
              title="Give up on this agent session — show launch options again"
            >
              reset
            </button>
          </div>
        )
      )}

      {/* Terminal Content */}
      <div className="flex-1 min-h-0 relative bg-slate-50">
        {serverAvailable === false && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-50">
            <div className="text-center text-slate-500">
              <AlertCircle className="w-8 h-8 mx-auto mb-2 text-amber-500" />
              <p className="text-sm font-medium">Terminal server not available</p>
              <p className="text-xs mt-1">
                Run <code className="bg-slate-200 px-1.5 py-0.5 rounded">npm run terminal</code> to start
              </p>
            </div>
          </div>
        )}

        {showPendingOverlay && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-50">
            <div className="text-center text-slate-500">
              <Terminal className="w-8 h-8 mx-auto mb-2" />
              <p className="text-sm">Opening {tab === 'agent' ? 'agent ' : ''}terminal…</p>
            </div>
          </div>
        )}

        {tab === 'agent' && agentParked && !agentTerm && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-50">
            <div className="text-center text-slate-500">
              <Bot className="w-8 h-8 mx-auto mb-2 text-purple-300" />
              <p className="text-sm">No agent terminal running</p>
              <p className="text-xs mt-1">Start or continue an agent above — its terminal appears when needed.</p>
            </div>
          </div>
        )}

        {/* Both ptys stay mounted once created; tabs just switch visibility */}
        {shellTerm && (
          <div data-terminal-container className={`absolute inset-0 ${tab === 'shell' ? '' : 'hidden'}`}>
            <TerminalInstance
              terminalId={shellTerm.id}
              isActive={tab === 'shell'}
              onExit={handleShellExit}
              cwd={shellTerm.cwd}
            />
          </div>
        )}
        {agentTerm && (
          <div data-terminal-container className={`absolute inset-0 ${tab === 'agent' ? '' : 'hidden'}`}>
            <TerminalInstance
              terminalId={agentTerm.id}
              isActive={tab === 'agent'}
              onExit={handleAgentExit}
              cwd={agentTerm.cwd}
              // Remote-agent mode: this pty is on the USER'S machine, so a
              // Nebula file-browser path is a DIFFERENT filesystem's path.
              runsOnUserMachine={!!remoteAgentCfg}
            />
          </div>
        )}
      </div>

      {showRemoteSetup && (
        <RemoteAgentSetupModal
          onClose={() => { setShowRemoteSetup(false); setSettingsNonce(n => n + 1); }}
        />
      )}
    </div>
  );
};
