import React, { useState, useEffect, useCallback } from 'react';
import { X, Folder, Palette, Bell, Volume2, AlignLeft, Hash, Settings, Cpu, MousePointerClick, Keyboard, Sparkles, Laptop, Server, Play, Stethoscope, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import {
  getSettings,
  saveSettings,
  ensureRemoteAgentPort,
  syncRemoteAgentPort,
  NebulaSettings,
  IndentationPreference,
} from '../services/settingsService';
import { getRootDirectory, setRootDirectory } from '../services/fileService';
import { notifySettingsChanged, fetchServerBackends, probeRemoteBins, runDiagnostics, testCompletion, type Diagnostics } from '../services/aiAutocompleteService';
import { fetchEnvironment, serverIsRemote, environmentLabel, environmentNeedsUserChoice, type EnvironmentInfo } from '../services/environmentService';
import { RemoteAgentSetupModal } from './RemoteAgentSetupModal';
import { checkReverseTunnel } from '../services/terminalService';
import { useNotification } from './NotificationSystem';
import { useModalA11y } from '../hooks/useModalA11y';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => void;
  /** True when the server is a scheduler (login) node — shows the login-node kernel toggle. */
  isLoginNode?: boolean;
}

type SettingsTab = 'general' | 'ai' | 'appearance' | 'notifications';

export const SettingsModal: React.FC<Props> = (props) => {
  // Mount the panel only while open so useModalA11y attaches/cleans up per open.
  if (!props.isOpen) return null;
  return <SettingsModalContent {...props} />;
};

const SettingsModalContent: React.FC<Props> = ({ isOpen, onClose, onRefresh, isLoginNode = false }) => {
  const [settings, setSettings] = useState<NebulaSettings>(getSettings());
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [serverRoot, setServerRoot] = useState<string | null>(null);
  // Environment awareness for the "where do the CLIs run" choice. Only when the
  // server is remote is that a real question; locally the server IS your machine.
  const [serverRemote, setServerRemote] = useState<boolean>(serverIsRemote());
  const [envInfo, setEnvInfo] = useState<EnvironmentInfo | null>(null);
  const [serverBackends, setServerBackends] = useState<{ claude: boolean; codex: boolean } | null>(null);
  // AI tab: tunnel setup modal + diagnostics + test-completion state.
  const [showRemoteSetup, setShowRemoteSetup] = useState(false);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string; ranOn: string; ms?: number; fromCache?: boolean; error?: string } | null>(null);
  // Model picker: true while "Custom…" is selected so the free-text field stays
  // visible even before the user has typed anything into it.
  const [modelCustom, setModelCustom] = useState(false);
  const [testRunning, setTestRunning] = useState(false);
  // Live reverse-tunnel status for the AI tab's "Local machine" section — same
  // checker the terminal toolbar uses. null = not applicable / not yet checked.
  const [tunnel, setTunnel] = useState<{ up: boolean; ssh: boolean | null } | null>(null);
  const { toast } = useNotification();
  const modalRef = useModalA11y<HTMLDivElement>(onClose);

  const persistSettings = useCallback((next: Partial<NebulaSettings>) => {
    setSettings(prev => ({ ...prev, ...next }));
    saveSettings(next);
  }, []);

  /** Set (or clear) the user's environment override and re-derive the UI mode. */
  const chooseEnvironment = useCallback((choice: 'local' | 'remote' | undefined) => {
    persistSettings({ environmentOverride: choice });
    notifySettingsChanged();
    fetchEnvironment().then((env) => setServerRemote(serverIsRemote(env)));
  }, [persistSettings]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('nebula-settings');
      if (!stored) {
        saveSettings({ notifyOnLongRun: false });
        setSettings(prev => ({ ...prev, notifyOnLongRun: false }));
        return;
      }

      const parsed = JSON.parse(stored) as Partial<NebulaSettings> | null;
      if (parsed && parsed.notifyOnLongRun === undefined) {
        saveSettings({ notifyOnLongRun: false });
        setSettings(prev => ({ ...prev, notifyOnLongRun: false }));
      }
    } catch (error) {
      console.warn('Failed to apply default notification setting:', error);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    fetchEnvironment().then((env) => { setEnvInfo(env); setServerRemote(serverIsRemote(env)); });
    fetchServerBackends().then((b) => { if (b) setServerBackends(b); });
  }, [isOpen]);

  // Poll the reverse tunnel while the AI tab is open in Local-machine mode, so
  // the status chip turns green the moment the user's tunnel connects.
  useEffect(() => {
    const port = settings.remoteAgentPort;
    const mine = serverRemote && (settings.agentRunsOn ?? 'server') === 'mine';
    if (!isOpen || activeTab !== 'ai' || !mine || !port) { setTunnel(null); return; }
    let stopped = false;
    const check = async () => { const s = await checkReverseTunnel(port); if (!stopped) setTunnel(s); };
    check();
    const id = setInterval(check, 4000);
    return () => { stopped = true; clearInterval(id); };
  }, [isOpen, activeTab, serverRemote, settings.remoteAgentPort, settings.agentRunsOn]);

  useEffect(() => {
    if (isOpen) {
      setSettings(getSettings());
      getRootDirectory()
        .then((root) => {
          setServerRoot(root);
          setSettings(prev => ({ ...prev, rootDirectory: root }));
          saveSettings({ rootDirectory: root });
        })
        .catch(() => {
          // Ignore root fetch errors
        });
    }
  }, [isOpen]);

  const handleSave = async () => {
    setIsSaving(true);
    let resolvedRoot = serverRoot;
    if (settings.rootDirectory && settings.rootDirectory !== serverRoot) {
      try {
        const updated = await setRootDirectory(settings.rootDirectory);
        resolvedRoot = updated;
        setServerRoot(updated);
        setSettings(prev => ({ ...prev, rootDirectory: updated }));
        saveSettings({ rootDirectory: updated });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update root directory';
        toast(message, 'error');
        setIsSaving(false);
        return;
      }
    }
    const finalSettings = {
      ...settings,
      rootDirectory: resolvedRoot || settings.rootDirectory
    };
    saveSettings(finalSettings);
    setTimeout(() => {
      setIsSaving(false);
      onRefresh();
      onClose();
    }, 300);
  };

  const handleToggleLongRunNotifications = async () => {
    const nextEnabled = !settings.notifyOnLongRun;

    if (nextEnabled) {
      if (typeof window === 'undefined' || !('Notification' in window)) {
        toast('Browser notifications are not supported in this environment.', 'warning');
        persistSettings({ notifyOnLongRun: false });
        return;
      }

      if (Notification.permission === 'default') {
        try {
          const permission = await Notification.requestPermission();
          if (permission === 'granted') {
            toast('Browser notifications enabled.', 'success', 3000);
          } else {
            toast('Browser notifications were not granted. Enable them in your browser settings.', 'warning', 5000);
          }
        } catch (error) {
          console.warn('Failed to request notification permission:', error);
          toast('Could not request notification permission.', 'error', 5000);
        }
      } else if (Notification.permission === 'denied') {
        toast('Browser notifications are blocked in your browser settings.', 'warning', 5000);
      }
    }

    persistSettings({ notifyOnLongRun: nextEnabled });
  };

  if (!isOpen) return null;

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'general', label: 'General', icon: <Settings className="w-4 h-4" /> },
    { id: 'ai', label: 'AI', icon: <Sparkles className="w-4 h-4" /> },
    { id: 'appearance', label: 'Appearance', icon: <Palette className="w-4 h-4" /> },
    { id: 'notifications', label: 'Notifications', icon: <Bell className="w-4 h-4" /> },
  ];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          tabIndex={-1}
          className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
            <h2 className="text-lg font-semibold text-slate-900">Settings</h2>
            <button
              onClick={onClose}
              aria-label="Close settings"
              className="p-1 hover:bg-slate-100 rounded-md transition-colors"
            >
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-slate-200 px-4">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="px-6 py-4 space-y-5 min-h-[20rem] max-h-[60vh] overflow-y-auto">
            {/* General Tab */}
            {activeTab === 'general' && (
              <>
                {/* Root Directory */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Folder className="w-4 h-4" />
                    Root Directory
                  </label>
                  <input
                    type="text"
                    value={settings.rootDirectory}
                    onChange={(e) => setSettings({ ...settings, rootDirectory: e.target.value })}
                    placeholder="/Users/username or ~"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Sets the server root directory (used by file browser and terminals). Use ~ for home directory.
                  </p>
                </div>

                {/* Indentation */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <AlignLeft className="w-4 h-4" />
                    Indentation
                  </label>
                  <select
                    value={settings.indentation || 'auto'}
                    onChange={(e) => setSettings({ ...settings, indentation: e.target.value as IndentationPreference })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                  >
                    <option value="auto">Auto-detect</option>
                    <option value="2">2 spaces</option>
                    <option value="4">4 spaces</option>
                    <option value="8">8 spaces</option>
                    <option value="tab">Tabs</option>
                  </select>
                  <p className="mt-1 text-xs text-slate-500">
                    Auto-detect analyzes file content. Default is 4 spaces when content is ambiguous.
                  </p>
                </div>

                {/* Line Numbers */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Hash className="w-4 h-4" />
                    Line Numbers
                  </label>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm text-slate-700">Show Line Numbers</p>
                      <p className="text-xs text-slate-500">
                        Display line numbers in code cells
                      </p>
                    </div>
                    <button
                      onClick={() => setSettings({ ...settings, showLineNumbers: !settings.showLineNumbers })}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings.showLineNumbers ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          settings.showLineNumbers ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Output logging toggle visibility */}
                <div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm text-slate-700">Show "Save outputs to history" button</p>
                      <p className="text-xs text-slate-500">
                        Adds a toolbar toggle that logs full cell outputs into notebook history (larger history files)
                      </p>
                    </div>
                    <button
                      onClick={() => setSettings({ ...settings, showOutputLoggingToggle: !settings.showOutputLoggingToggle })}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings.showOutputLoggingToggle ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          settings.showOutputLoggingToggle ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Cell IDs */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Hash className="w-4 h-4" />
                    Cell IDs
                  </label>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm text-slate-700">Show Cell IDs</p>
                      <p className="text-xs text-slate-500">
                        Display cell IDs in the header (advanced)
                      </p>
                    </div>
                    <button
                      onClick={() => setSettings({ ...settings, showCellIds: !settings.showCellIds })}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings.showCellIds ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          settings.showCellIds ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Jupyter classic keybindings */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Keyboard className="w-4 h-4" />
                    Keyboard
                  </label>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm text-slate-700">Jupyter classic shortcuts</p>
                      <p className="text-xs text-slate-500">
                        In cell mode: dd deletes, 00 restarts the kernel, ii interrupts.
                        (Suspends the D dequeue key while on. Z undo / Shift+Z redo are always active.)
                      </p>
                    </div>
                    <button
                      onClick={() => setSettings({ ...settings, jupyterShortcuts: !settings.jupyterShortcuts })}
                      aria-label="Toggle Jupyter classic shortcuts"
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings.jupyterShortcuts ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          settings.jupyterShortcuts ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Login-node kernels — only relevant on a scheduler (login) node */}
                {isLoginNode && (
                  <div>
                    <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                      <Cpu className="w-4 h-4" />
                      Login-node kernels
                    </label>
                    <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                      <div className="flex-1 pr-3">
                        <p className="text-sm text-slate-700">Allow kernels on the login node</p>
                        <p className="text-xs text-slate-500">
                          This node runs a scheduler. When off, starting a kernel prompts you to
                          allocate compute instead of running on the shared login node.
                        </p>
                      </div>
                      <button
                        onClick={() => setSettings({ ...settings, allowLoginNodeKernels: settings.allowLoginNodeKernels === 'allow' ? 'deny' : 'allow' })}
                        className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
                          settings.allowLoginNodeKernels === 'allow' ? 'bg-blue-600' : 'bg-slate-300'
                        }`}
                      >
                        <span
                          className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                            settings.allowLoginNodeKernels === 'allow' ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                )}

                {/* Resource Monitor */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Cpu className="w-4 h-4" />
                    Resource Monitor
                  </label>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm text-slate-700">Show Resource Monitor</p>
                      <p className="text-xs text-slate-500">
                        Display RAM/GPU usage in notebook status bar
                      </p>
                    </div>
                    <button
                      onClick={() => setSettings({ ...settings, showResourceMonitor: !settings.showResourceMonitor })}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings.showResourceMonitor ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          settings.showResourceMonitor ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Auto-Scroll Animation */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <MousePointerClick className="w-4 h-4" />
                    Auto-Scroll Animation
                  </label>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm text-slate-700">Smooth Notebook Auto-Scroll</p>
                      <p className="text-xs text-slate-500">
                        Animate jumps triggered by notebook actions like run-and-advance
                      </p>
                    </div>
                    <button
                      onClick={() => setSettings({ ...settings, smoothAutoScroll: !(settings.smoothAutoScroll ?? true) })}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        (settings.smoothAutoScroll ?? true) ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          (settings.smoothAutoScroll ?? true) ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* AI Tab */}
            {activeTab === 'ai' && (() => {
              const backend = settings.aiAutocompleteBackend ?? 'claude';
              const runsOn: 'server' | 'mine' = !serverRemote ? 'server' : (settings.agentRunsOn ?? 'server');
              const tunnelConfigured = !!(settings.remoteAgentUser?.trim() && settings.remoteAgentPort);
              const setRunsOn = (where: 'server' | 'mine') => {
                const s = getSettings();
                if (where === 'mine') {
                  const port = s.remoteAgentPort ?? ensureRemoteAgentPort();
                  persistSettings({ agentRunsOn: 'mine', remoteAgentEnabled: true, remoteAgentPort: port });
                  // Converge on the installation-wide port (claiming ours if
                  // the server has none) so all browsers probe the same one.
                  void syncRemoteAgentPort().then(() => notifySettingsChanged());
                  notifySettingsChanged();
                  if (!s.remoteAgentUser?.trim()) setShowRemoteSetup(true);
                  else probeRemoteBins().then((r) => {
                    if (r && !r.reachable) toast('Could not reach your machine over the tunnel — connect it, then run diagnostics.', 'warning');
                  });
                } else {
                  persistSettings({ agentRunsOn: 'server', remoteAgentEnabled: false });
                  notifySettingsChanged();
                }
                setTestResult(null); setDiag(null);
              };
              const doDiagnose = async () => {
                setDiagRunning(true); setDiag(null);
                const d = await runDiagnostics();
                setDiag(d);
                setDiagRunning(false);
                if (!d) toast('Diagnostics failed to reach the server.', 'warning');
              };
              const doTest = async () => {
                setTestRunning(true); setTestResult(null);
                const r = await testCompletion();
                setTestResult(r);
                setTestRunning(false);
              };
              const Row = ({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) => (
                <div className="flex items-start gap-2 text-xs">
                  {ok === null
                    ? <span className="w-3.5 h-3.5 mt-0.5 rounded-full bg-slate-300 flex-shrink-0" />
                    : ok
                      ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-emerald-600 flex-shrink-0" />
                      : <XCircle className="w-3.5 h-3.5 mt-0.5 text-red-500 flex-shrink-0" />}
                  <span className="text-slate-700">{label}{detail ? <span className="text-slate-400"> — {detail}</span> : null}</span>
                </div>
              );
              return (
                <>
                  {/* Shared: where the agent AND autocomplete run. Never gated on
                      the autocomplete toggle — this is agent infrastructure too. */}
                  <div>
                    <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                      <Server className="w-4 h-4" />
                      Where AI runs
                    </label>
                    <div className="p-3 bg-slate-50 rounded-lg space-y-3">
                      <p className="text-xs text-slate-500">
                        Applies to <span className="font-medium text-slate-600">both</span> the agent terminal and AI autocomplete.
                      </p>
                      {/* Where does this server run? Detection is silent when
                          confident; asks ONCE when genuinely ambiguous; always
                          correctable via the override select. */}
                      <div className="space-y-1.5">
                        {environmentNeedsUserChoice(envInfo) ? (
                          <div className="rounded-md border border-amber-300 bg-amber-50 p-2.5 space-y-1.5">
                            <p className="text-xs font-medium text-amber-800">Where does this Nebula server run?</p>
                            <p className="text-xs text-amber-700">
                              Nebula couldn't tell ({envInfo?.reason || 'no clear signal'}). This decides whether you
                              see options to run the agent and autocomplete on your own computer over an SSH tunnel —
                              pointless if this <em>is</em> your computer, essential if it's a box you connect to.
                            </p>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => chooseEnvironment('local')}
                                className="px-3 py-1 text-xs rounded-md border bg-white text-slate-700 border-slate-300 hover:border-blue-400 inline-flex items-center gap-1"
                              >
                                <Laptop className="w-3 h-3" /> This computer
                              </button>
                              <button
                                onClick={() => chooseEnvironment('remote')}
                                className="px-3 py-1 text-xs rounded-md border bg-white text-slate-700 border-slate-300 hover:border-blue-400 inline-flex items-center gap-1"
                              >
                                <Server className="w-3 h-3" /> A remote machine I connect to
                              </button>
                            </div>
                          </div>
                        ) : (
                          // One plain sentence; detection detail lives in the
                          // tooltip. (Was: "Server environment: this machine —
                          // macOS — a personal machine" + a second line saying
                          // the same thing — em-dash soup for a first-time user.)
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            <span
                              className="flex-1"
                              title={envInfo?.reason ? `How Nebula decided: ${envInfo.reason}${settings.environmentOverride ? ' (currently overridden by you)' : ''}` : undefined}
                            >
                              {serverRemote ? (
                                <>Nebula is running on <span className="text-slate-700 font-medium">{envInfo?.hostname || 'a remote machine'}</span>, which you connect to remotely.</>
                              ) : (
                                <>Nebula is running on <span className="text-slate-700 font-medium">this {envInfo?.platform === 'darwin' ? 'Mac' : 'computer'}</span>, so everything runs locally.</>
                              )}
                              <span className="text-slate-400"> {settings.environmentOverride ? '· set by you' : '· detected'}</span>
                            </span>
                            <select
                              value={settings.environmentOverride ?? ''}
                              onChange={(e) => chooseEnvironment(e.target.value === '' ? undefined : (e.target.value as 'local' | 'remote'))}
                              className="text-xs border border-slate-300 rounded-md px-1.5 py-0.5 bg-white text-slate-600"
                              title="Wrong? Tell Nebula where this server really runs — it decides whether the run-on-your-own-computer options appear."
                            >
                              <optgroup label="Where does this Nebula server run?">
                                <option value="">Detect automatically</option>
                                <option value="local">On this computer</option>
                                <option value="remote">On a remote machine I connect to</option>
                              </optgroup>
                            </select>
                          </div>
                        )}
                      </div>
                      {/* Runs on — only a real choice when the server is remote. */}
                      <div className="space-y-1.5">
                          {serverRemote ? (
                            <>
                              <div className="flex items-center gap-2">
                                <p className="text-xs text-slate-500 flex-1">Agent &amp; autocomplete run on</p>
                                <button
                                  onClick={() => setRunsOn('server')}
                                  className={`px-3 py-1 text-xs rounded-md border inline-flex items-center gap-1 transition-colors ${runsOn === 'server' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400'}`}
                                >
                                  <Server className="w-3 h-3" /> This server
                                </button>
                                <button
                                  onClick={() => setRunsOn('mine')}
                                  className={`px-3 py-1 text-xs rounded-md border inline-flex items-center gap-1 transition-colors ${runsOn === 'mine' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400'}`}
                                >
                                  <Laptop className="w-3 h-3" /> Local machine
                                </button>
                              </div>
                              {runsOn === 'mine' && (() => {
                                // Honest states: green ONLY when a real SSH banner
                                // came back (a live sshd behind the tunnel). A port
                                // that accepts TCP but never greets (ssh===null) is a
                                // stale/dead -R socket — show it as unconfirmed, not
                                // connected, since that's exactly when autocomplete
                                // silently can't reach your machine.
                                const state: 'checking' | 'live' | 'stale' | 'nologin' | 'down' =
                                  tunnel === null ? 'checking'
                                    : !tunnel.up ? 'down'
                                    : tunnel.ssh === true ? 'live'
                                    : tunnel.ssh === false ? 'nologin'
                                    : 'stale';
                                const chip = {
                                  checking: { cls: 'bg-slate-100 text-slate-500', txt: 'checking tunnel…' },
                                  live: { cls: 'bg-green-100 text-green-700', txt: '✓ tunnel connected' },
                                  stale: { cls: 'bg-amber-100 text-amber-700', txt: 'port open, no SSH response — reconnect the tunnel' },
                                  nologin: { cls: 'bg-amber-100 text-amber-700', txt: 'tunnel up — Remote Login off?' },
                                  down: { cls: 'bg-amber-100 text-amber-700', txt: 'tunnel not detected' },
                                }[state];
                                return (
                                  <div className="space-y-1.5">
                                    <div className="flex items-center justify-between gap-2">
                                      <p className="text-xs text-slate-500">
                                        Runs on your computer over the reverse SSH tunnel, using your own subscription.
                                      </p>
                                      <button
                                        onClick={() => setShowRemoteSetup(true)}
                                        className="px-2 py-1 text-xs rounded-md border border-purple-300 text-purple-700 hover:bg-purple-50 flex-shrink-0 whitespace-nowrap"
                                      >
                                        {tunnelConfigured ? 'Edit connection…' : 'Set up connection…'}
                                      </button>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <span className={`text-xs px-1.5 py-0.5 rounded-full ${chip.cls}`}>{chip.txt}</span>
                                      {settings.remoteAgentPort && (
                                        <span className="text-xs text-slate-400">reverse port {settings.remoteAgentPort}</span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })()}
                            </>
                          ) : null /* local server: the sentence above already says everything runs here */}
                        </div>
                    </div>
                  </div>

                  {/* AI inline autocomplete */}
                  <div>
                    <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                      <Sparkles className="w-4 h-4" />
                      AI Autocomplete
                    </label>
                    <div className="p-3 bg-slate-50 rounded-lg space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 pr-3">
                          <p className="text-sm text-slate-700">Inline code suggestions</p>
                          <p className="text-xs text-slate-500">
                            Ghost-text completions in code cells while you pause typing, powered by a
                            Claude Code or Codex subscription. Tab accepts, Escape dismisses.
                          </p>
                        </div>
                        <button
                          onClick={() => {
                            const next = !settings.aiAutocomplete;
                            setSettings({ ...settings, aiAutocomplete: next });
                            persistSettings({ aiAutocomplete: next });
                            notifySettingsChanged();
                          }}
                          aria-label="Toggle AI autocomplete"
                          className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${settings.aiAutocomplete ? 'bg-blue-600' : 'bg-slate-300'}`}
                        >
                          <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${settings.aiAutocomplete ? 'translate-x-5' : 'translate-x-0'}`} />
                        </button>
                      </div>

                      {settings.aiAutocomplete && (
                        <div className="flex items-center gap-2">
                          <p className="text-xs text-slate-500 flex-1">Suggestion engine</p>
                          {(['claude', 'codex'] as const).map((b) => (
                            <button
                              key={b}
                              onClick={() => { setSettings({ ...settings, aiAutocompleteBackend: b }); persistSettings({ aiAutocompleteBackend: b }); notifySettingsChanged(); setTestResult(null); }}
                              className={`px-3 py-1 text-xs rounded-md border transition-colors ${backend === b ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400'}`}
                            >
                              {b === 'claude' ? 'Claude Code' : 'Codex'}
                            </button>
                          ))}
                        </div>
                      )}

                      {settings.aiAutocomplete && (
                        <details className="group">
                          <summary className="text-xs text-slate-500 cursor-pointer select-none hover:text-slate-700">
                            Advanced — quality ↔ speed <span className="text-slate-400">(experimental: help us tune the defaults)</span>
                          </summary>
                          <div className="mt-2 space-y-2">
                            {backend === 'claude' && (
                              <div className="flex items-center gap-2">
                                <p className="text-xs text-slate-500 flex-1" title="Any model alias your claude CLI accepts. Benchmarked: sonnet (default) is only ~100ms slower to first character than haiku but eliminates its hallucination failures; haiku = cheapest quota; thinking budgets measured as not worth it.">Model</p>
                                <select
                                  value={modelCustom || (settings.aiAutocompleteModel && !['haiku', 'sonnet', 'opus'].includes(settings.aiAutocompleteModel)) ? 'custom' : (settings.aiAutocompleteModel ?? '')}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    if (v === 'custom') { setModelCustom(true); return; }
                                    setModelCustom(false);
                                    persistSettings({ aiAutocompleteModel: v || undefined }); notifySettingsChanged(); setTestResult(null);
                                  }}
                                  className="w-32 text-xs border border-slate-300 rounded-md px-1.5 py-0.5 bg-white text-slate-600"
                                >
                                  <option value="">sonnet (default)</option>
                                  <option value="haiku">haiku — cheapest</option>
                                  <option value="sonnet">sonnet</option>
                                  <option value="opus">opus</option>
                                  <option value="custom">custom…</option>
                                </select>
                                {(modelCustom || (settings.aiAutocompleteModel && !['haiku', 'sonnet', 'opus'].includes(settings.aiAutocompleteModel))) && (
                                  <input
                                    type="text" placeholder="model alias" autoFocus={modelCustom}
                                    value={settings.aiAutocompleteModel ?? ''}
                                    onChange={(e) => { persistSettings({ aiAutocompleteModel: e.target.value.trim() || undefined }); notifySettingsChanged(); setTestResult(null); }}
                                    className="w-28 text-xs border border-slate-300 rounded-md px-1.5 py-0.5 bg-white text-slate-600"
                                  />
                                )}
                              </div>
                            )}
                            <div className="flex items-center gap-2">
                              <p className="text-xs text-slate-500 flex-1" title="Characters of OTHER cells included in the prompt, nearest cells first (oversized neighbors are truncated to fit). The default covers the whole notebook in most cases; latency is nearly unaffected by size at these scales. 0 disables cross-cell context.">Notebook context (chars of other cells)</p>
                              <input
                                type="number" min={0} max={100000} step={1000}
                                value={settings.aiAutocompleteContextChars ?? 20000}
                                onChange={(e) => { persistSettings({ aiAutocompleteContextChars: Math.max(0, Math.min(100000, Number(e.target.value) || 0)) }); notifySettingsChanged(); }}
                                className="w-20 text-xs border border-slate-300 rounded-md px-1.5 py-0.5 bg-white text-slate-600"
                              />
                            </div>
                            <div className="flex items-center gap-2">
                              <p className="text-xs text-slate-500 flex-1" title="Cap on how many lines a suggestion may span (1-20).">Suggestion length (lines)</p>
                              <input
                                type="number" min={1} max={40} step={1}
                                value={settings.aiAutocompleteMaxLines ?? 10}
                                onChange={(e) => { persistSettings({ aiAutocompleteMaxLines: Math.max(1, Math.min(40, Number(e.target.value) || 10)) }); notifySettingsChanged(); }}
                                className="w-20 text-xs border border-slate-300 rounded-md px-1.5 py-0.5 bg-white text-slate-600"
                              />
                            </div>
                            <div className="flex items-center gap-2">
                              <p className="text-xs text-slate-500 flex-1" title="How long after you stop typing before a suggestion is requested (100-2000ms). Longer = fewer wasted requests; shorter = snappier.">Trigger delay (ms)</p>
                              <input
                                type="number" min={100} max={2000} step={50}
                                value={settings.aiAutocompleteDebounceMs ?? 300}
                                onChange={(e) => { persistSettings({ aiAutocompleteDebounceMs: Math.max(100, Math.min(2000, Number(e.target.value) || 300)) }); notifySettingsChanged(); }}
                                className="w-20 text-xs border border-slate-300 rounded-md px-1.5 py-0.5 bg-white text-slate-600"
                              />
                            </div>
                            {backend === 'claude' && (
                              <div className="flex items-center gap-2">
                                <p className="text-xs text-slate-500 flex-1" title="Thinking-token budget. Nothing streams while the model thinks, so the first character arrives later — but tricky completions can come out better. 0 = off.">Thinking tokens (0 = off)</p>
                                <input
                                  type="number" min={0} max={16000} step={512}
                                  value={settings.aiAutocompleteThinkingTokens ?? 0}
                                  onChange={(e) => { persistSettings({ aiAutocompleteThinkingTokens: Math.max(0, Math.min(16000, Number(e.target.value) || 0)) }); notifySettingsChanged(); }}
                                  className="w-20 text-xs border border-slate-300 rounded-md px-1.5 py-0.5 bg-white text-slate-600"
                                />
                              </div>
                            )}
                            <p className="text-[11px] text-slate-400">
                              Changes apply to new suggestions (trigger delay: to newly focused cells). The browser
                              console logs each completion's timing breakdown — filter for [ai-autocomplete] when tuning.
                            </p>
                          </div>
                        </details>
                      )}


                    </div>
                  </div>

                  {/* Diagnostics & test — infrastructure checks; useful for the
                      agent path even with autocomplete off. */}
                  {(
                    <div>
                      <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                        <Stethoscope className="w-4 h-4" />
                        Diagnostics &amp; test
                      </label>
                      <div className="p-3 bg-slate-50 rounded-lg space-y-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={doDiagnose}
                            disabled={diagRunning}
                            className="px-3 py-1.5 text-xs rounded-md bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5"
                          >
                            {diagRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Stethoscope className="w-3.5 h-3.5" />}
                            Run diagnostics
                          </button>
                          <button
                            onClick={doTest}
                            disabled={testRunning}
                            className="px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                          >
                            {testRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                            Test completion
                          </button>
                        </div>

                        {diag && (
                          <div className="space-y-1.5 border-t border-slate-200 pt-2">
                            <Row ok={null} label={`Nebula server: ${environmentLabel({ kind: diag.environment.kind as 'local' | 'cluster' | 'server', confidence: 'high', reason: '', hostname: diag.environment.hostname, platform: diag.environment.platform, scheduler: diag.environment.scheduler })}`} />
                            <Row ok={diag.server.claude.usable} label={`This server · Claude Code`} detail={diag.server.claude.detail} />
                            <Row ok={diag.server.codex.usable} label={`This server · Codex`} detail={diag.server.codex.detail} />
                            {diag.tunnel && (
                              <>
                                <Row ok={diag.tunnel.reachable} label="Local machine · tunnel" detail={diag.tunnel.reachable ? 'reachable' : 'not reachable — is the tunnel connected?'} />
                                <Row ok={!!diag.tunnel.claude} label="Local machine · Claude Code" detail={diag.tunnel.claude ?? 'not found'} />
                                <Row ok={!!diag.tunnel.codex} label="Local machine · Codex" detail={diag.tunnel.codex ?? 'not found'} />
                              </>
                            )}
                            {!diag.tunnel && serverRemote && (
                              <p className="text-xs text-slate-400">Configure the Local machine connection to diagnose the tunnel.</p>
                            )}
                          </div>
                        )}

                        {testResult && (
                          <div className="border-t border-slate-200 pt-2 text-xs">
                            {testResult.ok ? (
                              <div className="space-y-1">
                                <p className="text-emerald-700 font-medium">✓ Completion ran on {testResult.ranOn} · {testResult.ms}ms{testResult.fromCache ? ' (cached)' : ''}</p>
                                <pre className="bg-slate-800 text-slate-100 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap">{testResult.text || '(empty)'}</pre>
                              </div>
                            ) : (
                              <p className="text-red-600">✗ Test failed ({testResult.ranOn}): {testResult.error}</p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}

            {/* Appearance Tab */}
            {activeTab === 'appearance' && (
              <>
                {/* Notebook Icons */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Palette className="w-4 h-4" />
                    Notebook Icons
                  </label>
                  <div className="p-3 bg-slate-50 rounded-lg">
                    <p className="text-sm text-slate-700">Deterministic Avatars</p>
                    <p className="text-xs text-slate-500 mt-1">
                      Each notebook gets a unique, colorful icon generated from its name.
                      Icons are consistent across sessions with no API calls required.
                    </p>
                  </div>
                </div>
              </>
            )}

            {/* Notifications Tab */}
            {activeTab === 'notifications' && (
              <>
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Bell className="w-4 h-4" />
                    Long-Running Job Alerts
                  </label>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm text-slate-700">Browser Notifications</p>
                      <p className="text-xs text-slate-500">
                        Notify when queued cells finish after threshold
                      </p>
                    </div>
                    <button
                      onClick={handleToggleLongRunNotifications}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings.notifyOnLongRun ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          settings.notifyOnLongRun ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                  {settings.notifyOnLongRun && (
                    <div className="mt-2 flex items-center gap-2">
                      <label className="text-xs text-slate-600">Threshold:</label>
                      <input
                        type="number"
                        min="1"
                        max="600"
                        step="1"
                        value={settings.notifyThresholdSeconds ?? 60}
                        onChange={(e) => {
                          const nextValue = parseInt(e.target.value, 10);
                          persistSettings({ notifyThresholdSeconds: Number.isFinite(nextValue) ? nextValue : 60 });
                        }}
                        className="w-20 px-2 py-1 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <span className="text-xs text-slate-500">seconds</span>
                    </div>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex items-center gap-2">
                      <Volume2 className="w-4 h-4 text-slate-500" />
                      <div>
                        <p className="text-sm text-slate-700">Sound Alert</p>
                        <p className="text-xs text-slate-500">Play sound when job completes</p>
                      </div>
                    </div>
                    <button
                      onClick={() => persistSettings({ notifySoundEnabled: !settings.notifySoundEnabled })}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings.notifySoundEnabled ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          settings.notifySoundEnabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200 bg-slate-50">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isSaving ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Settings'
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Local-machine connection setup (reverse tunnel) — reused from the agent bar. */}
      {showRemoteSetup && (
        <RemoteAgentSetupModal onClose={() => { setShowRemoteSetup(false); setSettings(getSettings()); }} />
      )}
    </>
  );
};
