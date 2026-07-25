/**
 * Dashboard - Landing page with file browser and running sessions
 *
 * Uses FileBrowser component in inline mode for file browsing.
 */

import { stripNotebookExtension } from '../utils/notebookFormats';
import React, { useState, useEffect, useCallback } from 'react';
import {
  Terminal,
  Play,
  ExternalLink,
  ChevronRight,
  ChevronLeft,
  Plus,
  Book,
  Bot,
  Cpu,
  Lightbulb,
  History,
  AlertTriangle,
  Server,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { writeFile, getFileMtime } from '../services/fileService';
import { useNotification } from './NotificationSystem';
import { listTerminals, TerminalInfo } from '../services/terminalService';
import { getDeadKernelSessions, cleanupDeadKernelSessions, DeadSession } from '../services/kernelService';
import { getClusterInfo } from '../services/clusterService';
import { FileBrowser } from './FileBrowser';
import { ResourcePanel } from './ResourcePanel';
import ComputeDashboardCard from './ComputeDashboardCard';
import { KernelManager } from './KernelManager';
import { TerminalManager } from './TerminalManager';
import { GetStartedCard } from './GetStartedCard';
import { isAiAutocompleteDecided, setAiAutocomplete, notifySettingsChanged } from '../services/aiAutocompleteService';
import { fetchEnvironment, type EnvironmentInfo } from '../services/environmentService';
import { getSettings, saveSettings } from '../services/settingsService';

// Kernel session from API
interface KernelSession {
  id: string;
  kernel_name: string;
  file_path: string | null;
  status: 'idle' | 'busy' | 'starting';
  execution_count: number;
  memory_mb: number | null;
  pid: number | null;
}

// Tips for Jupyter users (including hidden settings)
const TIPS = [
  { text: <>Open any notebook → <strong>Agent</strong> tab → one-click launch <strong>Claude Code</strong> or <strong>Codex</strong>, pre-briefed on your notebook</> },
  { text: <>Agents can also drive notebooks via the <code className="bg-slate-200 px-1 rounded">nebula</code> CLI or MCP — <code className="bg-slate-200 px-1 rounded">npx nebula-notebook-mcp setup-mcp</code></> },
  { text: <>Running an agent <strong>on your machine</strong>? It needs Node.js ≥ 20 there — the agent uses <code className="bg-slate-200 px-1 rounded">npx -p nebula-notebook-mcp nebula</code> (or install with <code className="bg-slate-200 px-1 rounded">npm i -g nebula-notebook-mcp</code>)</> },
  { text: <>On a cluster login node, the kernel menu can allocate a compute-node job — no <code className="bg-slate-200 px-1 rounded">sbatch</code> needed</> },
  { text: <>Run several cells back-to-back — they queue up; the header chip shows the queue and jumps to what's running</> },
  { text: <><code className="bg-slate-200 px-1 rounded">Ctrl+`</code> toggles the integrated terminal</> },
  { text: <><code className="bg-slate-200 px-1 rounded">?terminal=name</code> in URL for persistent named terminals</> },
  { text: <>Click notebook name to rename inline</> },
  { text: <>History panel shows full edit timeline with restore</> },
  { text: <>Enable <strong>Show Line Numbers</strong> in settings for code cells</> },
  { text: <>Enable <strong>Show Cell IDs</strong> in settings to see cell identifiers</> },
  { text: <>Enable <strong>Notify on Long Run</strong> to get browser notifications when cells finish</> },
  { text: <>Enable <strong>Sound Notifications</strong> to hear when jobs complete</> },
  { text: <>Each notebook gets a unique <strong>colorful icon</strong> generated from its name</> },
  { text: <>Press <code className="bg-slate-200 px-1 rounded">Esc</code> to enter cell mode, then <code className="bg-slate-200 px-1 rounded">Ctrl/Cmd+Shift+↑/↓</code> to move cells</> },
  { text: <>Press <code className="bg-slate-200 px-1 rounded">Esc</code> to enter cell mode, then <code className="bg-slate-200 px-1 rounded">Delete</code> or <code className="bg-slate-200 px-1 rounded">Backspace</code> to delete cells</> },
];

// Recently opened notebooks storage key
const RECENT_NOTEBOOKS_KEY = 'nebula-recent-notebooks';
const MAX_RECENT = 5;

// First-run welcome card
const WELCOME_DISMISSED_KEY = 'nebula-welcome-dismissed';
const SAMPLE_NOTEBOOK_NAME = 'nebula-welcome.ipynb';

/**
 * Build the self-contained sample notebook (nbformat 4.5).
 * Stdlib-only so it runs on a bare ipykernel with nothing to install.
 */
function buildWelcomeNotebook(): object {
  const md = (id: string, source: string) => ({
    id,
    cell_type: 'markdown',
    metadata: {},
    source,
  });
  const code = (id: string, source: string) => ({
    id,
    cell_type: 'code',
    metadata: {},
    execution_count: null,
    outputs: [],
    source,
  });

  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python' },
    },
    cells: [
      md(
        'welcome-intro',
        '# Welcome to Nebula 🌌\n\n' +
          'This is a tiny tour notebook — **run it top to bottom**. The fastest way: hit **Run All** in the toolbar and watch the cells light up.\n\n' +
          'Everything here uses only Python’s standard library, so it runs on a bare kernel with nothing to install.'
      ),
      code(
        'welcome-hello',
        'import sys, platform\n\n' +
          'print("Hello from Nebula! 👋")\n' +
          'print(f"You\'re running Python {sys.version.split()[0]} on {platform.system()}.")'
      ),
      code(
        'welcome-plot',
        '# No matplotlib needed — here\'s a plot in pure Python.\n' +
          'observations = {"Mon": 3, "Tue": 7, "Wed": 5, "Thu": 9, "Fri": 6, "Sat": 2, "Sun": 4}\n\n' +
          'print("Meteors spotted this week\\n")\n' +
          'for day, count in observations.items():\n' +
          '    print(f"{day}  {\'█\' * count:<10} {count}")'
      ),
      code(
        'welcome-table',
        '# ...and a table, no pandas required.\n' +
          'planets = [\n' +
          '    ("Mercury", 0.39, 88),\n' +
          '    ("Venus", 0.72, 225),\n' +
          '    ("Earth", 1.00, 365),\n' +
          '    ("Mars", 1.52, 687),\n' +
          ']\n\n' +
          'print(f"{\'Planet\':<10}{\'AU\':>6}{\'Year (days)\':>14}")\n' +
          'print("-" * 30)\n' +
          'for name, au, days in planets:\n' +
          '    print(f"{name:<10}{au:>6.2f}{days:>14}")'
      ),
      md(
        'welcome-agent',
        '## Bring in an AI agent 🤖\n\n' +
          'Open the terminal panel’s **Agent** tab (the **Agent** button in the toolbar) and click **Claude Code**. ' +
          'It launches pre-briefed on this notebook — it can read these cells, run them, and fix anything that breaks. ' +
          'Try asking it to *"add a cell that shows the meteor counts as percentages"*.'
      ),
      md(
        'welcome-next',
        '## Where to go next\n\n' +
          '- **⌘K** — the command palette: every action, one keystroke away\n' +
          '- **⌘F** — search across all cells and outputs\n' +
          '- **History panel** — a full edit timeline of this notebook, with one-click restore\n\n' +
          'That’s the tour. Make something stellar ✨'
      ),
    ],
  };
}

interface RecentNotebook {
  path: string;
  name: string;
  openedAt: number;
}

// Get recently opened notebooks from localStorage
function getRecentNotebooks(): RecentNotebook[] {
  try {
    const stored = localStorage.getItem(RECENT_NOTEBOOKS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

// Add a notebook to recent list
export function addRecentNotebook(path: string, name: string): void {
  const recent = getRecentNotebooks();
  // Remove if already exists
  const filtered = recent.filter(r => r.path !== path);
  // Add to front
  filtered.unshift({ path, name, openedAt: Date.now() });
  // Keep only MAX_RECENT
  const trimmed = filtered.slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_NOTEBOOKS_KEY, JSON.stringify(trimmed));
}

/**
 * Fetch server's working directory from health endpoint
 */
interface ServerUpdateInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
}

async function getServerHealth(): Promise<{ cwd: string; update: ServerUpdateInfo | null }> {
  try {
    const response = await fetch('/api/health');
    if (response.ok) {
      const data = await response.json();
      return { cwd: data.cwd || '~', update: data.update ?? null };
    }
  } catch {
    // Fall back to home
  }
  return { cwd: '~', update: null };
}

/**
 * Fetch active kernel sessions
 */
async function getKernelSessions(): Promise<KernelSession[]> {
  try {
    const response = await fetch('/api/kernels/sessions');
    if (response.ok) {
      const data = await response.json();
      return data.sessions || [];
    }
  } catch {
    // Ignore errors
  }
  return [];
}

// Get filename from path
function getFilename(path: string): string {
  return path.split('/').pop() || path;
}

export const Dashboard: React.FC = () => {
  const { toast, promptText } = useNotification();

  // Server working directory
  const [serverCwd, setServerCwd] = useState<string>('~');
  const [updateInfo, setUpdateInfo] = useState<ServerUpdateInfo | null>(null);
  const [browsedPath, setBrowsedPath] = useState<string>('~');

  // First-run welcome card: shown until dismissed, and only while there is
  // no notebook history yet. Opening/creating things naturally hides it on the
  // next visit (recents become non-empty) but never sets the dismissed flag.
  const [showWelcome, setShowWelcome] = useState(() => {
    try {
      return !localStorage.getItem(WELCOME_DISMISSED_KEY) && getRecentNotebooks().length === 0;
    } catch {
      return false;
    }
  });
  const [isCreatingSample, setIsCreatingSample] = useState(false);

  // First-run AI autocomplete choice — asked once (undefined = undecided),
  // changeable later in Settings → AI.
  const [aiChoiceDecided, setAiChoiceDecided] = useState(() => isAiAutocompleteDecided());
  const chooseAiAutocomplete = (enabled: boolean, backend?: 'claude' | 'codex') => {
    setAiAutocomplete(enabled, backend);
    setAiChoiceDecided(true);
  };

  // First-run environment confirmation — detection only SUGGESTS (a scheduler
  // can exist on a laptop; a Mac can be a remote server); the user confirms
  // once and the answer is stored as an explicit override. Changeable anytime
  // in Settings → AI.
  const [envDecided, setEnvDecided] = useState(() => {
    const o = getSettings().environmentOverride;
    return o === 'local' || o === 'remote';
  });
  const [detectedEnv, setDetectedEnv] = useState<EnvironmentInfo | null>(null);
  useEffect(() => {
    if (!envDecided) fetchEnvironment().then(setDetectedEnv);
  }, [envDecided]);
  const chooseEnvironment = (choice: 'local' | 'remote') => {
    saveSettings({ environmentOverride: choice });
    notifySettingsChanged();
    setEnvDecided(true);
  };
  const suggestedEnv: 'local' | 'remote' | null =
    detectedEnv ? (detectedEnv.kind === 'local' ? 'local' : 'remote') : null;

  // Sessions state
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [kernelSessions, setKernelSessions] = useState<KernelSession[]>([]);
  const [isKernelManagerOpen, setIsKernelManagerOpen] = useState(false);
  const [isTerminalManagerOpen, setIsTerminalManagerOpen] = useState(false);

  // Tips carousel state (random initial index)
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * TIPS.length));

  // Recently opened notebooks
  const [recentNotebooks, setRecentNotebooks] = useState<RecentNotebook[]>([]);

  // Dead kernel sessions (orphaned/terminated)
  const [deadSessionsByServer, setDeadSessionsByServer] = useState<Array<{
    serverId: string;
    serverName: string;
    sessions: DeadSession[];
  }>>([]);
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const [cleanupDismissed, setCleanupDismissed] = useState(false);
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);

  // Dummy refresh counter (to pass to FileBrowser)
  const [refreshCounter, setRefreshCounter] = useState(0);

  const totalDeadSessions = deadSessionsByServer.reduce((sum, entry) => sum + entry.sessions.length, 0);
  const deadServersCount = deadSessionsByServer.length;

  // Load sessions (terminals + kernels)
  const loadSessions = useCallback(async () => {
    const [terms, kernels] = await Promise.all([
      listTerminals().catch(() => []),
      getKernelSessions(),
    ]);
    setTerminals(terms);
    setKernelSessions(kernels);
  }, []);

  // Check for dead sessions
  const checkDeadSessions = useCallback(async (): Promise<DeadSession[] | null> => {
    try {
      const cluster = await getClusterInfo().catch(() => null);

      if (!cluster || !cluster.servers || cluster.servers.length === 0) {
        const dead = await getDeadKernelSessions();
        if (dead.length > 0) {
          setDeadSessionsByServer([
            { serverId: 'local', serverName: 'Local', sessions: dead },
          ]);
        } else {
          setDeadSessionsByServer([]);
        }
        return dead;
      }

      const entries = await Promise.all(cluster.servers.map(async (server) => {
        try {
          const sessions = await getDeadKernelSessions(server.id);
          const displayName = server.isLocal && server.resources?.hostname
            ? server.resources.hostname
            : server.name;
          return { serverId: server.id, serverName: displayName, sessions };
        } catch {
          return { serverId: server.id, serverName: server.name, sessions: [] };
        }
      }));

      const nonEmpty = entries.filter(entry => entry.sessions.length > 0);
      setDeadSessionsByServer(nonEmpty);
      return nonEmpty.flatMap(entry => entry.sessions);
    } catch {
      // Ignore errors - older servers might not have this endpoint
      return null;
    }
  }, []);

  // Cleanup dead sessions
  const handleCleanupDeadSessions = useCallback(async () => {
    setIsCleaningUp(true);
    setCleanupNotice(null);
    try {
      await Promise.all(
        deadSessionsByServer.map(entry => cleanupDeadKernelSessions(undefined, entry.serverId))
      );
      const remaining = await checkDeadSessions();
      if (remaining && remaining.length > 0) {
        setCleanupNotice(
          `${remaining.length} kernel${remaining.length === 1 ? '' : 's'} could not be terminated. You may need to stop them manually.`
        );
      }
    } catch {
      // Ignore errors
    } finally {
      setIsCleaningUp(false);
    }
  }, [checkDeadSessions, deadSessionsByServer]);

  // Initial load
  useEffect(() => {
    const init = async () => {
      const { cwd, update } = await getServerHealth();
      setServerCwd(cwd);
      setUpdateInfo(update);
      loadSessions();
      setRecentNotebooks(getRecentNotebooks());
      checkDeadSessions();
    };
    init();
  }, [loadSessions, checkDeadSessions]);

  // Poll sessions every 5 seconds
  useEffect(() => {
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  // Open a notebook
  const handleOpenNotebook = (path: string) => {
    const name = stripNotebookExtension(getFilename(path));
    addRecentNotebook(path, name);
    window.location.href = `/?file=${encodeURIComponent(path)}`;
  };

  // Open notebook in new tab
  const handleOpenNotebookNewTab = (path: string) => {
    const name = stripNotebookExtension(getFilename(path));
    addRecentNotebook(path, name);
    setRecentNotebooks(getRecentNotebooks());
    window.open(`/?file=${encodeURIComponent(path)}`, '_blank');
  };

  // Open a terminal
  const handleOpenTerminal = (name: string) => {
    window.open(`/?terminal=${encodeURIComponent(name)}`, '_blank');
  };

  // Create new notebook - handled by FileBrowser
  const handleNewNotebook = async () => {
    const name = await promptText({ title: 'New notebook', placeholder: 'notebook name' });
    if (name) {
      // Open a placeholder tab SYNCHRONOUSLY inside the user gesture — a
      // window.open after the await is popup-blocked and the action looks
      // broken (notebook created, nothing happens). Blocked anyway (null)
      // -> navigate this tab instead of failing silently.
      const tab = window.open('', '_blank');
      import('../services/fileService').then(({ createNotebook }) => {
        createNotebook(name, [{ id: `cell-${Date.now()}`, type: 'code', content: '', outputs: [], isExecuting: false }], browsedPath || serverCwd)
          .then((notebook) => {
            const url = `/?file=${encodeURIComponent(notebook.id)}`;
            if (tab) tab.location.href = url; else window.location.href = url;
            setRefreshCounter(c => c + 1);
          })
          .catch((err) => {
            tab?.close();
            toast(err.message || 'Failed to create notebook', 'error');
          });
      });
    }
  };

  // Dismiss the welcome card permanently (only the X / "don't show again"
  // set the flag — opening notebooks merely hides it via the recents check).
  const dismissWelcome = () => {
    try {
      localStorage.setItem(WELCOME_DISMISSED_KEY, '1');
    } catch {
      // Storage unavailable — hide for this session only
    }
    setShowWelcome(false);
  };

  // Create (if needed) and open the sample notebook. With `withAgent`, also
  // deep-link the notebook's terminal panel to the Agent tab — Notebook.tsx
  // restores panel state from these sessionStorage keys on load, and the
  // same-tab navigation below carries sessionStorage over.
  const handleOpenSample = async (withAgent: boolean) => {
    if (isCreatingSample) return;
    setIsCreatingSample(true);
    try {
      const dir = (serverCwd || '~').replace(/\/+$/, '');
      const samplePath = `${dir}/${SAMPLE_NOTEBOOK_NAME}`;
      // Don't clobber an existing copy the user may have edited
      const exists = await getFileMtime(samplePath).then(() => true).catch(() => false);
      if (!exists) {
        await writeFile(samplePath, buildWelcomeNotebook(), 'notebook');
      }
      if (withAgent) {
        try {
          window.sessionStorage.setItem('nebula-terminal-open', '1');
          window.sessionStorage.setItem('nebula-terminal-tab', 'agent');
        } catch {
          // Storage unavailable — the sample's markdown cell covers the Agent tab
        }
      }
      handleOpenNotebook(samplePath);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to create the sample notebook', 'error');
    } finally {
      setIsCreatingSample(false);
    }
  };

  // Tip navigation
  const nextTip = () => setTipIndex((i) => (i + 1) % TIPS.length);
  const prevTip = () => setTipIndex((i) => (i - 1 + TIPS.length) % TIPS.length);

  // Active notebooks (kernels with file paths)
  const activeNotebooks = kernelSessions.filter(s => s.file_path);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header - matches Notebook header style */}
      <header className="bg-slate-50/90 backdrop-blur border-b border-slate-200 px-4 py-3 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Nebula logo */}
            <svg className="w-9 h-9" viewBox="0 0 32 32">
              <defs>
                <linearGradient id="nebula-logo-bg" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" style={{ stopColor: '#8b5cf6' }} />
                  <stop offset="50%" style={{ stopColor: '#6366f1' }} />
                  <stop offset="100%" style={{ stopColor: '#3b82f6' }} />
                </linearGradient>
              </defs>
              <rect width="32" height="32" rx="6" fill="url(#nebula-logo-bg)" />
              <path d="M8 10h16M8 16h12M8 22h14" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <div>
              <h1 className="text-lg font-bold text-slate-800">Nebula Notebook</h1>
              <p className="text-xs text-slate-500">AI-native Interactive Computing Environment</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsTerminalManagerOpen(true)}
              className="flex items-center gap-2 px-3 py-2 text-slate-600 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors"
            >
              <Terminal className="w-4 h-4" />
              <span className="hidden sm:inline">Terminals</span>
            </button>
            <button
              onClick={() => setIsKernelManagerOpen(true)}
              className="flex items-center gap-2 px-3 py-2 text-slate-600 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors"
              title="Manage kernels"
            >
              <Cpu className="w-4 h-4" />
              <span className="hidden sm:inline">Kernels</span>
            </button>
            <button
              onClick={handleNewNotebook}
              className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">New Notebook</span>
            </button>
          </div>
        </div>
      </header>

      <KernelManager
        isOpen={isKernelManagerOpen}
        onClose={() => setIsKernelManagerOpen(false)}
        currentSessionId={null}
        onKernelKilled={() => loadSessions()}
      />
      <TerminalManager
        isOpen={isTerminalManagerOpen}
        onClose={() => setIsTerminalManagerOpen(false)}
        onTerminalClosed={() => loadSessions()}
      />

      {/* Dead Sessions Cleanup Banner */}
      {totalDeadSessions > 0 && !cleanupDismissed && (
        <div className="bg-amber-50 border-b border-amber-200">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 text-sm text-amber-800">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <div className="flex flex-col gap-0.5">
                <span>
                  Found <strong>{totalDeadSessions}</strong> orphaned kernel session{totalDeadSessions !== 1 ? 's' : ''} across{' '}
                  <strong>{deadServersCount}</strong> server{deadServersCount !== 1 ? 's' : ''} from a previous run
                </span>
                {cleanupNotice && (
                  <span className="text-[0.6875rem] text-amber-700">{cleanupNotice}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCleanupDeadSessions}
                disabled={isCleaningUp}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-medium transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {isCleaningUp ? 'Cleaning...' : 'Clean Up'}
              </button>
              <button
                onClick={() => setCleanupDismissed(true)}
                className="p-1.5 text-amber-600 hover:bg-amber-100 rounded transition-colors"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* Notify-only update pill (server checks npm daily; NEBULA_NO_UPDATE_CHECK disables) */}
        {updateInfo?.update_available && (
          <div className="flex items-center gap-2 mb-4 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm">
            <Sparkles className="w-4 h-4 text-blue-600 flex-shrink-0" />
            <span className="text-blue-800">
              Nebula <span className="font-semibold">v{updateInfo.latest}</span> is available (you're on v{updateInfo.current}) —{' '}
              restart with <code className="bg-blue-100 px-1 rounded">npx nebula-notebook@latest</code>, or <code className="bg-blue-100 px-1 rounded">git pull</code> for source installs.
            </span>
            <a
              href="https://github.com/jzhoulab/nebula-notebook/releases"
              target="_blank"
              rel="noreferrer"
              className="ml-auto text-blue-600 hover:text-blue-800 underline decoration-dotted flex-shrink-0"
            >
              release notes
            </a>
          </div>
        )}

        {/* Event-driven "Get started" checklist (welcome card takes precedence on true first run) */}
        {!showWelcome && <GetStartedCard />}

        {/* First-run welcome card */}
        {showWelcome && (
          <div
            data-testid="welcome-card"
            className="relative mb-6 bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm"
          >
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-violet-500 via-indigo-500 to-blue-500" />
            <div className="p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-indigo-500" />
                    Welcome to Nebula
                  </h2>
                  <p className="text-sm text-slate-500 mt-1">
                    A notebook for you and your AI — here's the 2-minute tour.
                  </p>
                </div>
                <button
                  onClick={dismissWelcome}
                  aria-label="Dismiss welcome"
                  title="Dismiss"
                  className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors flex-shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
                <button
                  onClick={() => handleOpenSample(false)}
                  disabled={isCreatingSample}
                  className="group text-left p-4 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/60 transition-colors disabled:opacity-60 disabled:cursor-wait"
                >
                  <Book className="w-5 h-5 text-indigo-500 mb-2" />
                  <div className="text-sm font-semibold text-slate-800">Open the sample notebook</div>
                  <div className="text-xs text-slate-500 mt-1">
                    {isCreatingSample ? 'Setting things up…' : 'A short, runnable tour — just hit Run All.'}
                  </div>
                </button>
                <button
                  onClick={handleNewNotebook}
                  className="group text-left p-4 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50/60 transition-colors"
                >
                  <Plus className="w-5 h-5 text-blue-500 mb-2" />
                  <div className="text-sm font-semibold text-slate-800">Start with your own notebook</div>
                  <div className="text-xs text-slate-500 mt-1">A blank canvas with a Python kernel ready.</div>
                </button>
                <button
                  onClick={() => handleOpenSample(true)}
                  disabled={isCreatingSample}
                  className="group text-left p-4 rounded-lg border border-slate-200 hover:border-purple-300 hover:bg-purple-50/60 transition-colors disabled:opacity-60 disabled:cursor-wait"
                >
                  <Bot className="w-5 h-5 text-purple-500 mb-2" />
                  <div className="text-sm font-semibold text-slate-800">See what agents can do</div>
                  <div className="text-xs text-slate-500 mt-1">Opens the sample with the Agent panel ready.</div>
                </button>
              </div>

              {/* One-time AI autocomplete opt-in (also in Settings → AI) */}
              {!envDecided && (
                <div
                  data-testid="environment-choice"
                  className="mt-4 p-4 rounded-lg border border-slate-200 bg-slate-50/70"
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <Server className="w-4 h-4 text-slate-500" />
                    Where does this Nebula server run?
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    {detectedEnv
                      ? <>Looks like <span className="font-medium text-slate-700">{detectedEnv.kind === 'local' ? 'this computer' : 'a remote machine'}</span> ({detectedEnv.reason}) — confirm or correct.</>
                      : 'Checking…'}{' '}
                    This decides whether you get options to run the agent and autocomplete on your own
                    computer over an SSH tunnel. Changeable anytime in Settings → AI.
                  </p>
                  <div className="flex flex-wrap gap-2 mt-3">
                    <button
                      onClick={() => chooseEnvironment('local')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${suggestedEnv === 'local' ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-white text-slate-700 border border-slate-300 hover:border-indigo-400'}`}
                    >
                      This computer{suggestedEnv === 'local' ? ' (detected)' : ''}
                    </button>
                    <button
                      onClick={() => chooseEnvironment('remote')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${suggestedEnv === 'remote' ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-white text-slate-700 border border-slate-300 hover:border-indigo-400'}`}
                    >
                      A remote machine I connect to{suggestedEnv === 'remote' ? ' (detected)' : ''}
                    </button>
                  </div>
                </div>
              )}

              {!aiChoiceDecided && (
                <div
                  data-testid="ai-autocomplete-choice"
                  className="mt-4 p-4 rounded-lg border border-indigo-200 bg-indigo-50/50"
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <Sparkles className="w-4 h-4 text-indigo-500" />
                    AI autocomplete in code cells
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Inline ghost-text suggestions while you type, powered by your own Claude Code or
                    Codex subscription running on this machine. Tab accepts. You can change this
                    anytime in Settings.
                  </p>
                  <div className="flex flex-wrap gap-2 mt-3">
                    <button
                      onClick={() => chooseAiAutocomplete(true, 'claude')}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                    >
                      Enable with Claude Code
                    </button>
                    <button
                      onClick={() => chooseAiAutocomplete(true, 'codex')}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-white text-indigo-700 border border-indigo-300 hover:bg-indigo-50 transition-colors"
                    >
                      Enable with Codex
                    </button>
                    <button
                      onClick={() => chooseAiAutocomplete(false)}
                      className="px-3 py-1.5 text-xs rounded-md text-slate-500 hover:text-slate-700 transition-colors"
                    >
                      Not now
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={dismissWelcome}
                className="mt-3 text-xs text-slate-400 hover:text-slate-600 underline underline-offset-2 transition-colors"
              >
                Don't show this again
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start lg:items-stretch">
          {/* File Browser + Resources - Takes 3 columns */}
          <div className="lg:col-span-3 space-y-4">
            <FileBrowser
              files={[]}
              currentFileId={null}
              onSelect={handleOpenNotebook}
              onRefresh={() => setRefreshCounter(c => c + 1)}
              variant="inline"
              initialPath={serverCwd}
              onPathChange={setBrowsedPath}
              maxHeight="55vh"
            />
            {/* System Resources - aligned with file browser */}
            <ResourcePanel />
          </div>

          {/* Sidebar - fills vertical space */}
          <div className="flex flex-col gap-4">
            {/* Compute allocations + queue monitor (only when a scheduler is detected) */}
            <ComputeDashboardCard />

            {/* Quick Stats */}
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Overview</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-50 rounded-lg p-3">
                  <div className="flex items-center gap-2 text-slate-500 mb-1">
                    <Cpu className="w-4 h-4" />
                    <span className="text-xs">Kernels</span>
                  </div>
                  <div className="text-2xl font-bold text-slate-800">{kernelSessions.length}</div>
                </div>
                <div className="bg-slate-50 rounded-lg p-3">
                  <div className="flex items-center gap-2 text-slate-500 mb-1">
                    <Terminal className="w-4 h-4" />
                    <span className="text-xs">Terminals</span>
                  </div>
                  <div className="text-2xl font-bold text-slate-800">{terminals.length}</div>
                </div>
              </div>
            </div>


            {/* Recently Opened */}
            {recentNotebooks.length > 0 && (
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                  <History className="w-4 h-4 text-slate-500" />
                  <h3 className="text-sm font-medium text-slate-700">Recently Opened</h3>
                </div>
                <div className="divide-y divide-slate-100 max-h-[9.375rem] overflow-y-auto">
                  {recentNotebooks.map((notebook) => (
                    <div
                      key={notebook.path}
                      className="group w-full px-4 py-2.5 flex items-center gap-2 hover:bg-slate-50"
                    >
                      <button
                        onClick={() => handleOpenNotebook(notebook.path)}
                        className="min-w-0 flex-1 flex items-center gap-3 text-left"
                      >
                        <Book className="w-4 h-4 text-orange-500 flex-shrink-0" />
                        <span className="text-sm text-slate-700 truncate">{notebook.name}</span>
                      </button>
                      <button
                        onClick={() => handleOpenNotebookNewTab(notebook.path)}
                        title="Open in new tab"
                        aria-label={`Open ${notebook.name} in new tab`}
                        className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded hover:bg-slate-200 text-slate-500 transition-opacity"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Active Notebooks */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                <Book className="w-4 h-4 text-orange-500" />
                <h3 className="text-sm font-medium text-slate-700">Active Notebooks</h3>
              </div>
              <div className="divide-y divide-slate-100 max-h-[12.5rem] overflow-y-auto">
                {activeNotebooks.length === 0 ? (
                  <div className="px-4 py-4 text-center text-xs text-slate-400">
                    No active notebooks
                  </div>
                ) : (
                  activeNotebooks.map((session) => (
                    <button
                      key={session.id}
                      onClick={() => handleOpenNotebookNewTab(session.file_path!)}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-50 text-left"
                    >
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        session.status === 'busy' ? 'bg-amber-500 animate-pulse' : 'bg-green-500'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-slate-700 truncate">
                          {stripNotebookExtension(getFilename(session.file_path!))}
                        </div>
                        <div className="text-xs text-slate-400 flex gap-2">
                          <span>{session.kernel_name}</span>
                          {session.memory_mb && <span>· {Math.round(session.memory_mb)}MB</span>}
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Terminals */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-slate-500" />
                  <h3 className="text-sm font-medium text-slate-700">Terminals</h3>
                </div>
                <button
                  onClick={() => handleOpenTerminal(`term-${Date.now()}`)}
                  className="p-1 hover:bg-slate-100 rounded text-slate-500"
                  title="New Terminal"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              <div className="divide-y divide-slate-100 max-h-[12.5rem] overflow-y-auto">
                {terminals.length === 0 ? (
                  <div className="px-4 py-4 text-center text-xs text-slate-400">
                    No active terminals
                  </div>
                ) : (
                  terminals.map((term) => (
                    <button
                      key={term.id}
                      onClick={() => handleOpenTerminal(term.id)}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-50 text-left"
                    >
                      <Play className="w-4 h-4 text-green-500" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-slate-700 truncate">{term.id}</div>
                        <div className="text-xs text-slate-400">PID: {term.pid}</div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Tips Carousel - pushed to bottom */}
            <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 mt-auto">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Lightbulb className="w-4 h-4 text-amber-500" />
                  <span className="text-xs font-medium text-slate-700">Pro Tip</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={prevTip}
                    className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-slate-600"
                    title="Previous tip"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-[0.625rem] text-slate-400 w-8 text-center">
                    {tipIndex + 1}/{TIPS.length}
                  </span>
                  <button
                    onClick={nextTip}
                    className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-slate-600"
                    title="Next tip"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="text-xs text-slate-600 min-h-[2.5rem]">
                {TIPS[tipIndex].text}
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
};
