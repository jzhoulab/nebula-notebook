
import { getPathExtension, stripNotebookExtension, isTextNotebookExtension } from '../utils/notebookFormats';
import React, { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo, startTransition } from 'react';
import { Cell as CellComponent } from './Cell';
import { Cell, CellType, NotebookMetadata } from '../types';
import { kernelService, KernelSpec, PythonEnvironment, KernelProvisionError, envKernelName, isEnvKernelName } from '../services/kernelService';
import { getClusterInfo, ClusterServer, ClusterInfo } from '../services/clusterService';
import { getComputeStatus } from '../services/computeService';
import { setAutocompleteContext, isAiCompletionInFlight } from '../services/aiAutocompleteService';
import ComputeAllocationModal from './ComputeAllocationModal';
import { getSettings, saveSettings, IndentationPreference } from '../services/settingsService';
import { markOnboardingStep } from '../services/onboardingService';
import { Plus, Play, Save, Menu, ChevronDown, RotateCw, Power, Sparkles, Undo2, Redo2, Settings, Square, Cloud, CloudOff, Loader2, Check, AlertCircle, RefreshCw, Download, Cpu, Keyboard, X, CheckCircle, XCircle, Layers, Bot, Shield, ShieldCheck, ShieldOff, Terminal, History, MemoryStick, Server, Clock, Maximize2, Minimize2, FileText, FolderOpen, ScrollText, LockKeyhole, ArrowUpToLine, ArrowDownToLine } from 'lucide-react';
import { CellListHandle } from './VirtualCellList';
import { EditorView } from '@codemirror/view';
import {
  getFiles,
  getFileContentWithMtime,
  getActiveFileId,
  saveActiveFileId,
  updateNotebookMetadata,
  renameFile,
  loadNotebookHistory,
  loadNotebookSession,
  saveNotebookSession,
  saveNotebookCells,
  saveNotebookHistory,
  getAgentPermissionStatus,
  setAgentPermission,
  AgentPermissionStatus,
  getNotebookSettings,
  updateNotebookSettings,
  saveWidgetState,
  OutputLoggingMode,
  seedOutputsBaseline,
  setActiveNotebookPath,
  NotebookAccess,
  downloadFile,
} from '../services/fileService';
import { peekWidgetStateSnapshot } from '../services/widgetManager';
import { listAllocations } from '../services/computeService';
import { FileBrowser } from './FileBrowser';
import { TextFileEditor } from './TextFileEditor';
import { addRecentNotebook } from './Dashboard';
import { TerminalPanel } from './TerminalPanel';
import { agentTerminalService } from '../services/agentTerminalService';
import { HistoryPanel } from './HistoryPanel';
import { RestoreDialog } from './RestoreDialog';
import { VirtualCellList } from './VirtualCellList';
import { ImageModalViewer } from './ImageModalViewer';
import { useUndoRedo, EditSource, Operation } from '../hooks/useUndoRedo';
import { cloneCell } from '../lib/undoRedoCore';
import { useOperationHandler } from '../hooks/useOperationHandler';
import { SettingsModal } from './SettingsModal';
import { KernelManager } from './KernelManager';
import { NotebookSearch } from './NotebookSearch';
import { NotebookBreadcrumb } from './NotebookBreadcrumb';
import { ResourceStatusBar } from './ResourceStatusBar';
import { useAutosave, formatLastSaved } from '../hooks/useAutosave';
import { useNotebookKeyboardShortcuts } from '../hooks/useNotebookKeyboardShortcuts';
import { useNotification } from './NotificationSystem';
import { ModalShell } from './ModalShell';
import { useConflictResolution } from '../hooks/useConflictResolution';
import { detectIndentationFromCells, IndentationConfig, DEFAULT_INDENTATION } from '../utils/indentationDetector';
import { getNotebookAvatar, updateFavicon, resetFavicon } from '../utils/notebookAvatar';
import { playSuccessSound } from '../utils/notificationSound';
import { generateCellId } from '../utils/cellId';
import { reconstructStateAt, HistoryEntry } from '../lib/notebookOperations';

// Initial cell for reset
const INITIAL_CELL: Cell = {
  id: generateCellId(),
  type: 'code',
  content: '',
  outputs: [],
  isExecuting: false
};

// Output limits - shared between execution and loading
const MAX_OUTPUT_LINES = 10000; // Max lines of text output
const MAX_OUTPUT_CHARS = 100000000; // 100MB - generous for images

// Convert user indentation preference to config
function getIndentConfigFromPreference(pref: IndentationPreference): IndentationConfig | null {
  switch (pref) {
    case 'auto': return null; // Use autodetection
    case '2': return { useTabs: false, tabSize: 2, indentSize: 2 };
    case '4': return { useTabs: false, tabSize: 4, indentSize: 4 };
    case '8': return { useTabs: false, tabSize: 8, indentSize: 8 };
    case 'tab': return { useTabs: true, tabSize: 4, indentSize: 1 };
    default: return null;
  }
}

type CellClipboardItem = {
  type: CellType;
  content: string;
  sourceId: string;
  isCut: boolean;
};

// Helper to extract filename from path
function getFilenameFromPath(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || 'Untitled';
}

function getDirectoryFromPath(filePath: string | null): string | undefined {
  if (!filePath) return undefined;
  const idx = filePath.lastIndexOf('/');
  if (idx === -1) return undefined;
  if (idx === 0) return '/';
  return filePath.slice(0, idx);
}

function copyCellOutput(output: Cell['outputs'][number]) {
  return {
    type: output.type,
    content: output.content,
    ...(output.mimeBundle ? { mimeBundle: output.mimeBundle } : {}),
    ...(output.metadata ? { metadata: output.metadata } : {}),
    ...(output.preferredMimeType ? { preferredMimeType: output.preferredMimeType } : {}),
  };
}

// ─── Command Palette (self-contained to avoid Notebook re-renders on typing) ──
// One modal, two modes (VS Code convention): a '>' prefix filters commands,
// plain text searches cells (the original Cell Navigator behavior).
// Cmd/Ctrl+Shift+P opens it in command mode ('>' prefilled); Cmd/Ctrl+P (no
// Shift) opens it in cell-search/spotlight mode (empty query). Either way you
// can toggle modes by typing or deleting a leading '>'.
interface NavigatorItem { cellId: string; index: number; type: string; preview: string; content: string }
export interface PaletteCommand {
  id: string;
  title: string;
  section: string;      // group label shown on the right, e.g. 'Kernel'
  keywords?: string;    // extra lowercase search terms
  shortcut?: string;    // display-only hint, e.g. '⌘S'
  disabled?: boolean;
  run: () => void;
}

const CommandPalette: React.FC<{
  items: NavigatorItem[];
  commands: PaletteCommand[];
  initialQuery?: string;
  onSelect: (cellId: string, index: number) => void;
  onClose: () => void;
}> = ({ items, commands, initialQuery = '', onSelect, onClose }) => {
  const [query, setQuery] = useState(initialQuery);
  const [selection, setSelection] = useState(0);

  const commandMode = query.startsWith('>');

  const cellResults = useMemo(() => {
    if (commandMode) return [];
    if (!query.trim()) return items.map(item => ({ ...item, matchedLine: '' }));
    const q = query.toLowerCase();
    return items
      .filter(item => (
        item.content.includes(q) ||
        item.cellId.toLowerCase().includes(q) ||
        String(item.index + 1).includes(q)
      ))
      .map(item => {
        // Find the first line containing the match to show as context
        const lines = item.content.split('\n');
        const matchedLine = lines.find(line => line.includes(q))?.trim() || '';
        return { ...item, matchedLine };
      });
  }, [items, query, commandMode]);

  const commandResults = useMemo(() => {
    if (!commandMode) return [];
    const q = query.slice(1).trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(cmd => (
      cmd.title.toLowerCase().includes(q) ||
      cmd.section.toLowerCase().includes(q) ||
      (cmd.keywords || '').includes(q)
    ));
  }, [commands, query, commandMode]);

  const resultCount = commandMode ? commandResults.length : cellResults.length;

  useEffect(() => { setSelection(0); }, [query]);

  const runCommand = (cmd: PaletteCommand) => {
    if (cmd.disabled) return;
    // Close first so focus is released before the command opens another modal
    onClose();
    cmd.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/30 backdrop-blur-sm flex items-start justify-center pt-24 px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-3xl bg-white rounded-lg shadow-2xl border border-slate-200 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setSelection(s => Math.min(s + 1, resultCount - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSelection(s => Math.max(s - 1, 0)); }
          else if (e.key === 'Enter') {
            e.preventDefault();
            if (commandMode) {
              const cmd = commandResults[selection];
              if (cmd) runCommand(cmd);
            } else {
              const target = cellResults[selection];
              if (target) { onSelect(target.cellId, target.index); onClose(); }
            }
          }
        }}
      >
        <div className="px-3 py-2 border-b border-slate-200 flex items-center gap-2">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={commandMode ? 'Type a command…' : "Search cells — or type '>' for commands"}
            aria-label={commandMode ? 'Search commands' : 'Search cells'}
            className="w-full text-sm bg-slate-50 border border-slate-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
          <span className="text-[0.625rem] text-slate-400 whitespace-nowrap tabular-nums">
            {commandMode ? `${commandResults.length} commands` : `${cellResults.length} / ${items.length}`}
          </span>
        </div>
        <div className="max-h-[75vh] overflow-y-auto">
          {commandMode ? (
            commandResults.length === 0 ? (
              <div className="px-3 py-5 text-sm text-slate-400 text-center">No matching commands</div>
            ) : (
              commandResults.map((cmd, idx) => (
                <button
                  key={cmd.id}
                  disabled={cmd.disabled}
                  className={`w-full text-left px-3 py-1.5 border-b border-slate-100 transition-colors flex items-center justify-between gap-3 ${
                    cmd.disabled
                      ? 'bg-white text-slate-300 cursor-not-allowed'
                      : idx === selection ? 'bg-blue-50' : 'bg-white hover:bg-slate-50'
                  }`}
                  onClick={() => runCommand(cmd)}
                  onMouseMove={() => { if (!cmd.disabled && idx !== selection) setSelection(idx); }}
                >
                  <span className={`text-[0.8125rem] leading-tight truncate ${cmd.disabled ? '' : 'text-slate-700'}`}>
                    {cmd.title}
                  </span>
                  <span className="flex items-center gap-2 flex-shrink-0">
                    {cmd.shortcut && (
                      <kbd className={`px-1.5 py-0.5 rounded text-[0.625rem] border ${cmd.disabled ? 'bg-slate-50 border-slate-100 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-500'}`}>
                        {cmd.shortcut}
                      </kbd>
                    )}
                    <span className="text-[0.625rem] uppercase tracking-wide text-slate-400">{cmd.section}</span>
                  </span>
                </button>
              ))
            )
          ) : (
            <>
              {cellResults.length === 0 ? (
                <div className="px-3 py-5 text-sm text-slate-400 text-center">No matching cells</div>
              ) : query.trim() ? (
                <div className="px-3 py-1 text-xs text-blue-600 bg-blue-50 border-b border-blue-100">
                  Showing {cellResults.length} matching cells
                </div>
              ) : null}
              {cellResults.map((item, idx) => (
                <button
                  key={`${item.index}-${item.cellId}`}
                  className={`w-full text-left px-3 py-1 border-b border-slate-100 transition-colors ${idx === selection ? 'bg-blue-50' : 'bg-white hover:bg-slate-50'}`}
                  onClick={() => { onSelect(item.cellId, item.index); onClose(); }}
                >
                  <div className="flex items-center justify-between text-[0.6875rem] text-slate-500 leading-tight">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-semibold flex-shrink-0">#{item.index + 1}</span>
                      <span className="text-[0.625rem] text-slate-500 font-medium truncate">{item.cellId}</span>
                    </div>
                    <span className="text-[0.625rem] uppercase tracking-wide text-slate-400 flex-shrink-0">{item.type}</span>
                  </div>
                  <div className="mt-0.5 text-[0.8125rem] text-slate-700 font-mono truncate leading-tight">
                    {query.trim() && item.matchedLine ? item.matchedLine : (item.preview || <span className="text-slate-400 italic">Empty cell</span>)}
                  </div>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

function escapeForAttributeSelector(value: string): string {
  // Prefer the platform escape when available. This is only used in the browser.
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  // Minimal escape for `[attr="..."]` selectors.
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Get initial file ID synchronously to avoid "Untitled" flash
function getInitialFileId(): string | null {
  // Check URL parameter first
  const url = new URL(window.location.href);
  const fileParam = url.searchParams.get('file');
  if (fileParam) return fileParam;

  // Fall back to saved active file
  return getActiveFileId();
}

function getEvidenceLinkForFile(filePath: string): { sealId?: string; cellId?: string } {
  const url = new URL(window.location.href);
  if (url.searchParams.get('file') !== filePath) return {};
  const sealId = url.searchParams.get('seal') || undefined;
  const cellId = url.searchParams.get('cell') || undefined;
  return { sealId, cellId };
}

function encodeReadablePath(filePath: string): string {
  return encodeURIComponent(filePath).replace(/%2F/gi, '/');
}

// Format elapsed time in a compact form (e.g., "1.2s", "1m 23s")
// Leaf component so the 100ms execution tick re-renders ONLY this span —
// as top-level Notebook state it re-rendered the entire 5.7k-line tree
// (and re-ran the full cell map) ten times a second while any cell ran.
const ElapsedTimer: React.FC<{ startRef: React.RefObject<number | null> }> = ({ startRef }) => {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(startRef.current ? Date.now() - startRef.current : 0);
    }, 100);
    return () => clearInterval(id);
  }, [startRef]);
  return <span className="text-gray-400 tabular-nums">{formatElapsedTime(elapsed)}</span>;
};

function formatElapsedTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const tenths = Math.floor((ms % 1000) / 100);

  if (seconds < 60) {
    return `${seconds}.${tenths}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

// Format kernel uptime from createdAt timestamp
function formatKernelUptime(createdAtSeconds: number): string {
  const now = Date.now() / 1000;
  const seconds = Math.floor(now - createdAtSeconds);

  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

export const Notebook: React.FC = () => {
  const { toast, confirm } = useNotification();

  // File System State
  const [files, setFiles] = useState<NotebookMetadata[]>([]);
  const [currentFileId, setCurrentFileId] = useState<string | null>(getInitialFileId);
  const [isLoadingFile, setIsLoadingFile] = useState(!!getInitialFileId());
  const [notebookAccess, setNotebookAccess] = useState<NotebookAccess>({ read_only: false });
  const isSealedReadOnly = notebookAccess.read_only && notebookAccess.reason === 'sealed';
  const evidenceCellHintRef = useRef<string | null>(null);
  const [currentFileMetadata, setCurrentFileMetadata] = useState<NotebookMetadata | null>(null);
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);
  const [textEditorPath, setTextEditorPath] = useState<string | null>(null);
  const [imageViewerPath, setImageViewerPath] = useState<string | null>(null);
  const [isNavigatorOpen, setIsNavigatorOpen] = useState(false);
  // Terminal panel state survives refresh (the server-side ptys do too — the
  // panel reattaches to them by name), so a reload restores the workspace.
  const [isTerminalOpen, setIsTerminalOpen] = useState(() => {
    try { return window.sessionStorage.getItem('nebula-terminal-open') === '1'; } catch { return false; }
  });
  const [terminalTab, setTerminalTab] = useState<'shell' | 'agent'>(() => {
    try { return window.sessionStorage.getItem('nebula-terminal-tab') === 'agent' ? 'agent' : 'shell'; } catch { return 'shell'; }
  });
  // "Get started" checklist: opening any notebook checks the first step.
  useEffect(() => {
    if (currentFileId) markOnboardingStep('openedNotebook');
  }, [currentFileId]);
  useEffect(() => {
    try {
      window.sessionStorage.setItem('nebula-terminal-open', isTerminalOpen ? '1' : '0');
      window.sessionStorage.setItem('nebula-terminal-tab', terminalTab);
    } catch { /* storage unavailable */ }
  }, [isTerminalOpen, terminalTab]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  // History preview - timestamp of the point in history to preview (null = present)
  const [previewTimestamp, setPreviewTimestamp] = useState<number | null>(null);
  // Restore dialog state
  const [restoreDialogTimestamp, setRestoreDialogTimestamp] = useState<number | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isKernelManagerOpen, setIsKernelManagerOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchSeed, setSearchSeed] = useState<string | null>(null);
  const [isKeyboardHelpOpen, setIsKeyboardHelpOpen] = useState(false);
  const [memoryUsage, setMemoryUsage] = useState<{ used: number; total: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState<{
    query: string;
    caseSensitive: boolean;
    useRegex: boolean;
  } | null>(null);

  // Notebook rename state
  const [isRenamingNotebook, setIsRenamingNotebook] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  useEffect(() => {
    if (!isSealedReadOnly) return;
    setIsTerminalOpen(false);
    setPreviewTimestamp(null);
    setRestoreDialogTimestamp(null);
    setIsRenamingNotebook(false);
  }, [isSealedReadOnly]);

  // Conflict detection state
  // IMPORTANT: The ref is the source of truth for mtime during save operations.
  // We DON'T sync ref from state on every render, because that could overwrite
  // a freshly saved mtime with stale state due to React's batched updates.
  // The state is only for triggering re-renders when needed.
  const [lastKnownMtime, setLastKnownMtimeState] = useState<number | null>(null);
  const lastKnownMtimeRef = useRef<number | null>(null);

  // Track whether history has been loaded for this notebook
  // Prevents saving history before it's loaded, and can be used to lock editing
  const [historyReady, setHistoryReady] = useState(false);

  // Helper to update both state AND ref synchronously to prevent race conditions
  const setLastKnownMtime = useCallback((mtime: number | null) => {
    lastKnownMtimeRef.current = mtime;  // Update ref immediately (source of truth)
    setLastKnownMtimeState(mtime);      // Update state for re-render
  }, []);

  // Monotonic adoption for mtimes carried by EVENTS (kernelChanged, settings
  // responses, permission toggles, kernel attach). Events can arrive late or
  // out of order; regressing the baseline below a newer save's mtime would
  // make the next conflict check see our own write as "changed on server".
  // Loads/reloads still use setLastKnownMtime directly (they must override).
  const adoptServerMtime = useCallback((mtime: number | undefined | null) => {
    if (typeof mtime !== 'number') return;
    const current = lastKnownMtimeRef.current;
    if (current !== null && current >= mtime) return;
    lastKnownMtimeRef.current = mtime;
    setLastKnownMtimeState(mtime);
  }, []);
  const [pendingSave, setPendingSave] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    if (!textEditorPath) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [textEditorPath]);

  useEffect(() => {
    if (!isNavigatorOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isNavigatorOpen]);

  // '>' prefilled = command mode by default; deleting it drops into cell search
  const [navigatorInitialQuery, setNavigatorInitialQuery] = useState('>');
  // Bumped on every open so the palette remounts with a fresh query, even when
  // a command (e.g. "Go to cell…") closes and reopens it within the same tick.
  const [navigatorOpenNonce, setNavigatorOpenNonce] = useState(0);

  const openNavigator = useCallback((initialQuery: string = '>') => {
    setNavigatorInitialQuery(initialQuery);
    setNavigatorOpenNonce(n => n + 1);
    setIsNavigatorOpen(true);
  }, []);

  const closeNavigator = useCallback(() => {
    setIsNavigatorOpen(false);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyP') return;
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const hasModifier = isMac ? (event.metaKey || event.ctrlKey) : event.ctrlKey;
      if (!hasModifier) return;
      // Cmd/Ctrl+Shift+P → command mode ('>' prefilled); Cmd/Ctrl+P (no Shift)
      // → cell search/spotlight mode (empty query), VS Code convention.
      const commandMode = event.shiftKey;

      event.preventDefault();
      if (isNavigatorOpen) {
        closeNavigator();
      } else {
        openNavigator(commandMode ? '>' : '');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isNavigatorOpen, closeNavigator, openNavigator]);

  // Kernel State
  const [isKernelMenuOpen, setIsKernelMenuOpen] = useState(false);
  const [isRunMenuOpen, setIsRunMenuOpen] = useState(false);
  const [isExecutionQueueOpen, setIsExecutionQueueOpen] = useState(false);
  const [availableKernels, setAvailableKernels] = useState<KernelSpec[]>([]);
  const [pythonEnvironments, setPythonEnvironments] = useState<PythonEnvironment[]>([]);
  // ipykernel install prompt: env awaiting user confirmation, in-flight flag,
  // and the honest failure (message + manual command) when an install fails.
  const [ipykernelPrompt, setIpykernelPrompt] = useState<PythonEnvironment | null>(null);
  const [isInstallingIpykernel, setIsInstallingIpykernel] = useState(false);
  const [ipykernelInstallError, setIpykernelInstallError] = useState<{ message: string; hint?: string } | null>(null);
  // Live installer output (streamed from the backend) shown in the modal so
  // the user can see exactly what ran and whether it's progressing.
  const [ipykernelInstallOutput, setIpykernelInstallOutput] = useState('');
  const installOutputRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    // Follow the tail as new installer output streams in
    const el = installOutputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ipykernelInstallOutput]);
  // Manual interpreter entry ("Enter interpreter path…") in the kernel picker.
  const [manualPathOpen, setManualPathOpen] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [isProbingPath, setIsProbingPath] = useState(false);
  const [currentKernel, setCurrentKernel] = useState<string>('python3');
  const [kernelSelectionRequired, setKernelSelectionRequired] = useState(false);
  // Publish kernel + filename as autocomplete hints (the ghost-text fetcher reads
  // these globally so we don't thread props through every cell editor).
  useEffect(() => {
    setAutocompleteContext({
      kernelName: currentKernel,
      filename: currentFileId ? getFilenameFromPath(currentFileId) : undefined,
    });
  }, [currentKernel, currentFileId]);
  const [kernelSessionId, setKernelSessionId] = useState<string | null>(null);
  const [kernelStatus, setKernelStatus] = useState<'idle' | 'busy' | 'starting' | 'disconnected' | 'dead'>('disconnected');
  const [kernelCreatedAt, setKernelCreatedAt] = useState<number | null>(null);
  const [isDiscoveringPythons, setIsDiscoveringPythons] = useState(false);

  // Cluster State
  const [clusterInfo, setClusterInfo] = useState<ClusterInfo | null>(null);
  const [computeEnabled, setComputeEnabled] = useState(false);
  const [showComputeModal, setShowComputeModal] = useState(false);
  // Allocation id armed via "Use when ready": watched until it turns active,
  // then kernels switch to it automatically (selecting a still-starting
  // allocation shouldn't require the user to sit in the modal and wait).
  const [pendingAllocSwitch, setPendingAllocSwitch] = useState<string | null>(null);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null); // null = local
  // On a login node, the pending kernel start we're asking the user to confirm
  // (run here vs allocate compute). null = no prompt showing.
  const [loginNodePrompt, setLoginNodePrompt] = useState<{ kernelName: string; serverId?: string | null; keepMenuOpen: boolean; source: EditSource } | null>(null);
  // Resolves once compute (scheduler) detection completes, so kernel-start gates
  // don't race the async detection on cold load (e.g. restoring the last file).
  const computeStatusReadyRef = useRef<Promise<boolean> | null>(null);

  // Agent permission state
  const [agentPermissionStatus, setAgentPermissionStatus] = useState<AgentPermissionStatus | null>(null);

  // Output logging mode for history - 'minimal' logs no output, 'full' logs complete output
  const [outputLoggingMode, setOutputLoggingMode] = useState<OutputLoggingMode>('minimal');
  const [isFullWidth, setIsFullWidth] = useState(false);

  // Undo/Redo & State Management (operation-based)
  const {
    cells,
    setCells,
    insertCell: undoableInsertCell,
    deleteCell: undoableDeleteCell,
    moveCell: undoableMoveCell,
    updateContent,
    updateMetadata,
    changeType,
    setCellScrolled,
    setCellScrolledHeight,
    batch,
    saveCheckpoint,
    flushCell,
    peekUndo,
    peekRedo,
    undo: rawUndo,
    redo: rawRedo,
    canUndo,
    canRedo,
    loadCells,
    initializeNewHistory,
    getFullHistory,
    loadHistory,
    logOperation,
    updateContentAI,
    redoStackLength,
    commitHistoryBeforeKeyframe,
    hasRedoToFlush,
    getUnflushedState,
    setUnflushedState,
    getUpdatesSince,
  } = useUndoRedo([]);  // Start with empty cells

  const logKernelEvent = useCallback((
    name: string,
    data?: Record<string, unknown>,
    source: EditSource = 'user'
  ) => {
    logOperation({
      type: 'event',
      category: 'kernel',
      name,
      data,
      source,
    });
  }, [logOperation]);

  // Compute preview cells when viewing history
  // Reconstruct cells at preview timestamp
  const previewCells = useMemo(() => {
    if (!previewTimestamp) return null;
    const history = getFullHistory();
    // Cast to HistoryEntry[] - types are structurally compatible
    const state = reconstructStateAt(history as unknown as HistoryEntry[], previewTimestamp);
    return state?.cells ?? null;
  }, [previewTimestamp, getFullHistory]);

  const isPreviewMode = previewTimestamp !== null;

  // Map of current cells for O(1) lookup - reused by multiple computations
  const currentCellMap = useMemo(() =>
    new Map(cells.map(c => [c.id, c])),
  [cells]);

  // Set of cell IDs that were executed after the preview timestamp
  // If a cell wasn't re-run, its current outputs are still valid for preview
  const cellsExecutedAfterPreview = useMemo(() => {
    if (!previewTimestamp) return new Set<string>();

    const executed = new Set<string>();
    const history = getFullHistory();

    for (const entry of history) {
      if (entry.timestamp <= previewTimestamp) continue;
      const isRunCell = entry.type === 'runCell' ||
        (entry.type === 'event' && (entry as any).name === 'runCell');
      if (!isRunCell) continue;
      const cellId = entry.type === 'event' ? (entry as any).target?.cellId : (entry as any).cellId;
      if (cellId) executed.add(cellId);
    }
    return executed;
  }, [previewTimestamp, getFullHistory]);

  // Cells to display - preview cells with preserved outputs where possible
  const displayCells = useMemo(() => {
    if (!previewCells) return cells;

    return previewCells.map(previewCell => {
      const currentCell = currentCellMap.get(previewCell.id);

      // Preserve outputs if cell exists and wasn't re-run after preview point
      if (currentCell && !cellsExecutedAfterPreview.has(previewCell.id)) {
        return { ...previewCell, outputs: currentCell.outputs };
      }

      return previewCell;
    });
  }, [previewCells, cells, currentCellMap, cellsExecutedAfterPreview]);

  // Ref for displayCells — avoids holding the entire cells array in Cell fiber props.
  // Cell components read from this ref instead of receiving allCells as a prop.
  const displayCellsRef = useRef<Cell[]>(displayCells);
  displayCellsRef.current = displayCells;

  // Index map: cellId → position. Updated on every render (O(N) but no
  // re-renders). Cells read this ref for the "#N" label and index-dependent
  // operations without needing `index` as a prop.
  const cellIndexMapRef = useRef(new Map<string, number>());
  const nextMap = cellIndexMapRef.current;
  nextMap.clear();
  displayCells.forEach((c, i) => nextMap.set(c.id, i));

  // Compute diff between preview and current for highlighting
  // 'same' = unchanged, 'modified' = content differs, 'deleted' = exists in preview but not current
  type CellDiffStatus = 'same' | 'modified' | 'deleted';
  const previewDiffMap = useMemo(() => {
    const map = new Map<string, CellDiffStatus>();
    if (!previewCells) return map;

    for (const previewCell of previewCells) {
      const currentCell = currentCellMap.get(previewCell.id);
      if (!currentCell) {
        // Cell was deleted after this point in history
        map.set(previewCell.id, 'deleted');
      } else if (currentCell.content !== previewCell.content || currentCell.type !== previewCell.type) {
        // Cell content or type changed
        map.set(previewCell.id, 'modified');
      } else {
        map.set(previewCell.id, 'same');
      }
    }

    return map;
  }, [previewCells, currentCellMap]);

  // Line-diff targets for preview mode: modified cells diff old vs current
  // content, deleted cells diff old vs '' (all lines shown as removed).
  // Toggleable from the preview banner; on by default.
  const [previewLineDiffEnabled, setPreviewLineDiffEnabled] = useState(true);
  const previewDiffAgainstMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!previewCells) return map;
    for (const previewCell of previewCells) {
      const status = previewDiffMap.get(previewCell.id);
      if (status === 'modified') {
        map.set(previewCell.id, currentCellMap.get(previewCell.id)?.content ?? '');
      } else if (status === 'deleted') {
        map.set(previewCell.id, '');
      }
    }
    return map;
  }, [previewCells, previewDiffMap, currentCellMap]);

  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [indentConfig, setIndentConfig] = useState<IndentationConfig>(DEFAULT_INDENTATION);
  const [showLineNumbers, setShowLineNumbers] = useState<boolean>(() => getSettings().showLineNumbers ?? false);
  // Hidden by default: the save-outputs-to-history toolbar toggle is niche and
  // easy to hit by accident — surfaced only when enabled in Settings.
  const [showOutputLoggingToggle, setShowOutputLoggingToggle] = useState<boolean>(() => getSettings().showOutputLoggingToggle ?? false);
  const [showCellIds, setShowCellIds] = useState<boolean>(() => getSettings().showCellIds ?? false);
  const [showResourceMonitor, setShowResourceMonitor] = useState<boolean>(() => getSettings().showResourceMonitor ?? false);
  const [smoothAutoScroll, setSmoothAutoScroll] = useState<boolean>(() => getSettings().smoothAutoScroll ?? true);
  // Jupyter classic keybindings in cell mode (dd delete, z undo, 00 restart, ii interrupt)
  const [jupyterShortcutsEnabled, setJupyterShortcutsEnabled] = useState<boolean>(() => getSettings().jupyterShortcuts ?? false);
  const jupyterShortcutsRef = useRef(jupyterShortcutsEnabled);
  jupyterShortcutsRef.current = jupyterShortcutsEnabled;

  // Conflict resolution hook
  // Note: When loading remote version during conflict, we initialize fresh history
  // since we're discarding local changes
  const {
    conflictDialog,
    resolving: conflictResolving,
    saveWithCheck,
    keepLocal,
    loadRemote,
    dismissDialog: dismissConflictDialog
  } = useConflictResolution(
    setLastKnownMtime,
    initializeNewHistory  // Conflict resolution resets history since local changes are discarded
  );

  // Helper to set cell outputs (for operation sync)
  const setCellOutputs = useCallback((cellId: string, outputs: Cell['outputs'], executionCount?: number) => {
    setCells(prevCells => prevCells.map(c =>
      c.id === cellId
        ? { ...c, outputs, pendingOutputReset: false, executionCount: executionCount ?? c.executionCount }
        : c
    ));
  }, [setCells]);

  // Helper to create notebook (for operation sync)
  const handleCreateNotebook = useCallback(async (
    path: string,
    overwrite: boolean,
    kernelName: string,
    kernelDisplayName?: string
  ): Promise<{ success: boolean; mtime?: number; error?: string }> => {
    try {
      // First check if file exists (if not overwriting)
      if (!overwrite) {
        const checkResponse = await fetch(`/api/fs/read?path=${encodeURIComponent(path)}`);
        if (checkResponse.ok) {
          // File exists
          return {
            success: false,
            error: `Notebook already exists: ${path}. Use overwrite=true to replace.`,
          };
        }
        // 404 means file doesn't exist - that's what we want
      }

      // Create empty notebook structure
      const notebook = {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: {
            name: kernelName,
            display_name: kernelDisplayName ?? (kernelName === 'python3' ? 'Python 3' : kernelName),
          },
          language_info: { name: 'python' },
          // Agent-created notebooks should be agent-permitted by default so the agent can
          // continue modifying the file via headless ops even if no UI is connected.
          nebula: {
            agent_created: true,
            agent_permitted: true,
          },
        },
        cells: [],
      };

      // Write directly via fs API (avoids routing loop)
      const response = await fetch('/api/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path,
          content: JSON.stringify(notebook, null, 2),
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        return { success: false, error: error.detail || 'Failed to create notebook' };
      }

      // Get mtime from the created file
      const mtimeResponse = await fetch(`/api/fs/file-mtime?path=${encodeURIComponent(path)}`);
      let mtime: number | undefined;
      if (mtimeResponse.ok) {
        const data = await mtimeResponse.json();
        mtime = data.mtime;

        // Update our mtime tracking if this is the current file
        if (path === currentFileId) {
          adoptServerMtime(mtime);
        }
      }

      return { success: true, mtime };
    } catch (e) {
      return {
        success: false,
        error: String(e),
      };
    }
  }, [currentFileId, setLastKnownMtime]);

  // Format agent operation for toast notification
  const formatAgentOperation = useCallback((opType: string, result: { success: boolean; cellIndex?: number; error?: string }) => {
    if (!result.success) return `Agent error: ${result.error}`;
    const cellNum = result.cellIndex !== undefined ? ` #${result.cellIndex + 1}` : '';
    switch (opType) {
      case 'insertCell': return `Agent inserted cell${cellNum}`;
      case 'deleteCell': return `Agent deleted cell${cellNum}`;
      case 'updateContent': return `Agent updated cell${cellNum}`;
      case 'updateOutputs': return `Agent updated outputs${cellNum}`;
      case 'moveCell': return `Agent moved cell`;
      case 'duplicateCell': return `Agent duplicated cell${cellNum}`;
      case 'clearNotebook': return `Agent cleared notebook`;
      default: return `Agent: ${opType}`;
    }
  }, []);

  // Execute cell callback for agent operations
  // Uses the same execution queue as UI - just adds timeout wrapper for agent
  const handleAgentExecuteCell = useCallback(async (
    cellId: string,
    options?: {
      sessionId?: string;
      maxWait?: number;
      saveOutputs?: boolean;
    }
  ): Promise<{
    success: boolean;
    executionStatus?: 'idle' | 'busy' | 'error';
    executionCount?: number;
    executionTime?: number;
    outputs?: Array<{ type: string; content: string }>;
    sessionId?: string;
    queuePosition?: number;
    queueLength?: number;
    error?: string;
  }> => {
    // Use ref for current cell state
    const currentCells = cellsRef.current;
    const cellIndex = currentCells.findIndex(c => c.id === cellId);
    const cell = cellIndex >= 0 ? currentCells[cellIndex] : null;

    if (!cell) {
      return { success: false, error: `Cell with ID "${cellId}" not found` };
    }

    if (cell.type !== 'code') {
      return { success: false, error: `Cell ${cellId} is not a code cell` };
    }

    let effectiveSessionId = options?.sessionId || kernelSessionIdRef.current;
    if (options?.sessionId && options.sessionId !== kernelSessionIdRef.current) {
      try {
        const attached = await kernelService.attachToSession(options.sessionId, currentFileId ?? undefined);
        effectiveSessionId = attached.sessionId;
        kernelSessionIdRef.current = attached.sessionId;
        setKernelSessionId(attached.sessionId);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (!effectiveSessionId) {
      return { success: false, error: 'No kernel session available. Start a kernel first.' };
    }

    if (!cell.content.trim()) {
      return {
        success: true,
        executionStatus: 'idle',
        outputs: [],
        executionCount: undefined,
        sessionId: effectiveSessionId,
      };
    }

    const startTime = Date.now();
    const maxWait = (options?.maxWait ?? 10) * 1000; // Convert to ms
    const pollInterval = 100; // Poll every 100ms

    // Agent operations need a completion signal that can't be missed for fast cells.
    // `isExecuting` can flip true->false between polls (especially when the kernel is
    // already warm), so instead we wait for executionCount/lastExecutionMs to change.
    const baselineExecutionCount = cell.executionCount;
    const baselineLastExecutionMs = cell.lastExecutionMs;

    const currentQueue = executionQueueRef.current;
    const existingIndex = currentQueue.indexOf(cellId);
    const queuePosition = existingIndex >= 0 ? existingIndex : currentQueue.length;
    const queueLength = existingIndex >= 0 ? currentQueue.length : currentQueue.length + 1;

    // Add to execution queue - this triggers the existing UI execution logic
    // The useEffect execution processor will handle the actual execution
    // Only add and log if not already in queue (matches queueExecution behavior)
    if (existingIndex < 0) {
      const runId = createRunId();
      executionRunIdsRef.current.set(cellId, runId);
      setExecutionQueue(prev => [...prev, cellId]);
      // Log cell run for history (same as UI queueExecution)
      logOperation({
        type: 'event',
        category: 'execution',
        name: 'runCell',
        target: { cellId, cellIndex },
        runId,
      });
    } else if (!executionRunIdsRef.current.has(cellId)) {
      executionRunIdsRef.current.set(cellId, createRunId());
    }

    // Wait for execution to complete (executionCount/lastExecutionMs changes) or timeout.
    return new Promise((resolve) => {
      const checkCompletion = () => {
        const elapsed = Date.now() - startTime;

        // Get current cell state from ref (not closure) to get live data
        const currentCell = cellsRef.current.find(c => c.id === cellId);

        if (!currentCell) {
          // Cell was deleted during execution
          resolve({
            success: false,
            error: 'Cell was deleted during execution',
            executionTime: elapsed,
            sessionId: effectiveSessionId,
            queuePosition,
            queueLength,
          });
          return;
        }

        const executionCountChanged = currentCell.executionCount !== baselineExecutionCount;
        const lastExecutionChanged = currentCell.lastExecutionMs !== baselineLastExecutionMs;

        // Check if execution completed (execution markers changed)
        if (executionCountChanged || lastExecutionChanged) {
          // Execution complete - read outputs from cell state
          const visibleOutputs = currentCell.pendingOutputReset ? [] : currentCell.outputs;
          const hasError = visibleOutputs.some(o => o.type === 'error');
          resolve({
            success: true,
            executionStatus: hasError ? 'error' : 'idle',
            executionCount: currentCell.executionCount,
            executionTime: elapsed,
            outputs: visibleOutputs.map(copyCellOutput),
            sessionId: effectiveSessionId,
            queuePosition,
            queueLength,
          });
          return;
        }

        // Check timeout
        if (elapsed >= maxWait) {
          // Timeout - return current outputs, execution continues in background
          const visibleOutputs = currentCell.pendingOutputReset ? [] : currentCell.outputs;
          resolve({
            success: true,
            executionStatus: 'busy',
            executionTime: elapsed,
            outputs: visibleOutputs.map(copyCellOutput),
            sessionId: effectiveSessionId,
            queuePosition,
            queueLength,
          });
          return;
        }

        // Still waiting for execution to start or complete, poll again
        setTimeout(checkCompletion, pollInterval);
      };

      // Start polling after a small delay to let execution start
      setTimeout(checkCompletion, pollInterval);
    });
  }, [currentFileId]);

  const kernelOpsRef = useRef<{
    startKernel?: (kernelName?: string, source?: EditSource) => Promise<{ success: boolean; sessionId?: string; kernelName?: string; error?: string }>;
    shutdownKernel?: (source?: EditSource) => Promise<{ success: boolean; sessionId?: string; error?: string }>;
    restartKernel?: (source?: EditSource) => Promise<{ success: boolean; sessionId?: string; error?: string }>;
    interruptKernel?: (source?: EditSource) => Promise<{ success: boolean; sessionId?: string; error?: string }>;
  }>({});

  const startKernelForAgent = useCallback(async (kernelName?: string, source: EditSource = 'mcp') => {
    if (!kernelOpsRef.current.startKernel) {
      return { success: false, error: 'startKernel not initialized' };
    }
    return kernelOpsRef.current.startKernel(kernelName, source);
  }, []);

  const shutdownKernelForAgent = useCallback(async (source: EditSource = 'mcp') => {
    if (!kernelOpsRef.current.shutdownKernel) {
      return { success: false, error: 'shutdownKernel not initialized' };
    }
    return kernelOpsRef.current.shutdownKernel(source);
  }, []);

  const restartKernelForAgent = useCallback(async (source: EditSource = 'mcp') => {
    if (!kernelOpsRef.current.restartKernel) {
      return { success: false, error: 'restartKernel not initialized' };
    }
    return kernelOpsRef.current.restartKernel(source);
  }, []);

  const interruptKernelForAgent = useCallback(async (source: EditSource = 'mcp') => {
    if (!kernelOpsRef.current.interruptKernel) {
      return { success: false, error: 'interruptKernel not initialized' };
    }
    return kernelOpsRef.current.interruptKernel(source);
  }, []);
  const syncKernelFromBackendRef = useRef<((kernelName: string, serverId?: string | null) => Promise<void>) | null>(null);

  // Cells the agent recently touched (collaborative sessions show presence
  // instead of locking the notebook). Entries fade after a few seconds.
  const [agentActiveCellIds, setAgentActiveCellIds] = useState<Set<string>>(new Set());
  const agentActiveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const markAgentActive = useCallback((cellId: string) => {
    setAgentActiveCellIds(prev => {
      if (prev.has(cellId)) return prev;
      const next = new Set(prev);
      next.add(cellId);
      return next;
    });
    const timers = agentActiveTimersRef.current;
    const existing = timers.get(cellId);
    if (existing) clearTimeout(existing);
    timers.set(cellId, setTimeout(() => {
      timers.delete(cellId);
      setAgentActiveCellIds(prev => {
        const next = new Set(prev);
        next.delete(cellId);
        return next;
      });
    }, 5000));
  }, []);

  // Operation handler - receives operations routed from backend OperationRouter
  // Clear all cells as ONE undoable batch — a single Ctrl+Z restores the
  // whole notebook instead of one press per deleted cell.
  const clearNotebookBatch = useCallback((source: EditSource = 'ai'): number => {
    const currentCells = cellsRef.current;
    if (currentCells.length === 0) return 0;
    const ops: Operation[] = currentCells
      .map((cell, index) => ({ cell, index }))
      .reverse() // delete from the highest index down so earlier indices stay valid
      .map(({ cell, index }) => ({ type: 'deleteCell' as const, index, cell: cloneCell(cell), source }));
    batch(ops);
    return currentCells.length;
  }, [batch]);

  // Callable before showUndoRedoFeedback is defined below (same shadow-ref
  // pattern as addCellRef): pulses the "recently updated" highlight on cells.
  const highlightCellsFnRef = useRef<((cellIds: string[]) => void) | null>(null);

  const { activeOperation: agentOperation, agentSession, forceEndAgentSession } = useOperationHandler({
    filePath: currentFileId,
    cells,
    insertCell: undoableInsertCell,
    deleteCell: undoableDeleteCell,
    moveCell: undoableMoveCell,
    clearNotebookBatch,
    updateContent,
    updateContentAI,
    updateMetadata,
    setCellOutputs,
    isCellQueued: (cellId) => executionQueueRef.current.includes(cellId),
    createNotebook: handleCreateNotebook,
    executeCell: handleAgentExecuteCell,
    startKernel: startKernelForAgent,
    shutdownKernel: shutdownKernelForAgent,
    restartKernel: restartKernelForAgent,
    interruptKernel: interruptKernelForAgent,
    onKernelChanged: async (kernelName, serverId, mtime) => {
      // The server persisted kernel metadata into the .ipynb on the agent's
      // behalf — adopt the new mtime so autosave doesn't mistake that write
      // for an external change ("file on disk is newer").
      adoptServerMtime(mtime);
      await syncKernelFromBackendRef.current?.(kernelName, serverId);
    },
    undo: rawUndo,
    redo: rawRedo,
    canUndo,
    canRedo,
    getUpdatesSince,
    onAgentOperation: useCallback((operation, result) => {
      // Presence: mark cells the agent touches (reads included — it shows
      // where the agent is working so the user can steer around it)
      {
        const op = operation as { cellId?: string; cellIds?: string[] };
        const resultIds = result as { cellId?: string };
        const touched = [op.cellId, resultIds.cellId, ...(op.cellIds ?? [])].filter(
          (id): id is string => typeof id === 'string'
        );
        touched.forEach(markAgentActive);
      }

      // Skip read-only operations
      if (operation.type === 'readCell' || operation.type === 'readCellOutput') return;

      // Recently-updated pulse for cells whose CONTENT the agent changed.
      // Outputs/executions churn constantly — the presence ring covers those.
      if (
        operation.type === 'updateContent' || operation.type === 'insertCell' ||
        operation.type === 'insertCells' || operation.type === 'duplicateCell'
      ) {
        const op = operation as { cellId?: string; cellIds?: string[] };
        const res = result as { cellId?: string; cellIds?: string[] };
        const changed = [op.cellId, res.cellId, ...(op.cellIds ?? []), ...(res.cellIds ?? [])].filter(
          (id): id is string => typeof id === 'string'
        );
        if (changed.length > 0) highlightCellsFnRef.current?.(changed);
      }

      // Handle output updates - only show toast when execution completes (has executionCount)
      if (operation.type === 'updateOutputs') {
        if ('executionCount' in operation && operation.executionCount) {
          toast(`Agent executed cell #${(result.cellIndex ?? 0) + 1}`, 'info', 2000);
        }
        return;
      }

      // Handle session operations specially
      if (operation.type === 'startAgentSession') {
        if (result.warning) {
          toast(`⚠️ ${result.warning}`, 'warning', 3000);
        } else {
          toast('🤖 Agent session started', 'info', 2000);
        }
        return;
      }
      if (operation.type === 'endAgentSession') {
        const duration = result.sessionDuration ? ` (${Math.round(result.sessionDuration / 1000)}s)` : '';
        toast(`🤖 Agent session ended${duration}`, 'info', 2000);
        return;
      }

      // Handle executeCell operation
      if (operation.type === 'executeCell') {
        const cellNum = result.cellIndex !== undefined ? ` #${result.cellIndex + 1}` : '';
        if (result.success) {
          if (result.executionStatus === 'busy') {
            toast(`Agent started executing cell${cellNum}`, 'info', 2000);
          } else if (result.executionStatus === 'error') {
            toast(`Agent executed cell${cellNum} (with errors)`, 'warning', 2000);
          } else {
            toast(`Agent executed cell${cellNum}`, 'info', 2000);
          }
        } else {
          toast(`Agent execution failed: ${result.error}`, 'error', 3000);
        }
        return;
      }

      // Handle undo/redo operations
      if (operation.type === 'undo') {
        if (result.success) {
          const affectedCount = result.affectedCellIds?.length ?? 0;
          toast(`Agent undid ${result.operationType || 'operation'} (${affectedCount} cell${affectedCount !== 1 ? 's' : ''})`, 'info', 2000);
        } else {
          toast(result.error || 'Nothing to undo', 'warning', 2000);
        }
        return;
      }
      if (operation.type === 'redo') {
        if (result.success) {
          const affectedCount = result.affectedCellIds?.length ?? 0;
          toast(`Agent redid ${result.operationType || 'operation'} (${affectedCount} cell${affectedCount !== 1 ? 's' : ''})`, 'info', 2000);
        } else {
          toast(result.error || 'Nothing to redo', 'warning', 2000);
        }
        return;
      }

      // OCC conflicts are normal collaboration, not failures: the agent was
      // just handed your newer version and will retry on top of it. Show a
      // brief note instead of the full error (which embeds cell content).
      if (!result.success && (result as { conflict?: boolean }).conflict) {
        toast('Agent edit held off — you changed that cell; it will retry with your version', 'info', 2500);
        return;
      }

      const msg = formatAgentOperation(operation.type, result);
      toast(msg, result.success ? 'info' : 'error', 2000);
    }, [formatAgentOperation, toast]),
  });

  // Clipboard for cut/copy/paste cells (array: multi-cell selections copy as a block)
  const [cellClipboard, setCellClipboard] = useState<CellClipboardItem[] | null>(null);

  // FIFO queue for cells (separate from clipboard) - enqueue with 'e', dequeue with 'd'
  const [cellQueue, setCellQueue] = useState<CellClipboardItem[]>([]);
  const cellQueueRef = useRef<CellClipboardItem[]>([]);
  const executionQueueRef = useRef<string[]>([]);
  const executionRunIdsRef = useRef<Map<string, string>>(new Map());

  const cellsRef = useRef<Cell[]>(cells);
  const activeCellIdRef = useRef<string | null>(activeCellId);
  const cellClipboardRef = useRef<CellClipboardItem[] | null>(cellClipboard);
  const getFullHistoryRef = useRef(getFullHistory);
  const loadFileRef = useRef<(id: string) => void>(() => {});
  const refreshFileListRef = useRef<() => void>(() => {});
  const getCellsRef = useRef<() => Cell[]>(() => cellsRef.current);
  const cellStructureSigRef = useRef<string>('');
  const [cellStats, setCellStats] = useState<{ count: number; codeCount: number; markdownCount: number }>({ count: 0, codeCount: 0, markdownCount: 0 });

  // ⚠️ PERFORMANCE CRITICAL: Refs for renderCell callback stability
  // These allow the memoized renderCell to access current values without recreating
  // Note: Initialized with defaults, updated on each render after state is defined
  const highlightedCellIdsRef = useRef<Set<string>>(new Set());
  const searchQueryRef = useRef<typeof searchQuery>(null);
  const indentConfigRef = useRef<IndentationConfig>(DEFAULT_INDENTATION);
  const pendingFocusRef = useRef<{ cellId: string; mode: 'cell' | 'editor' } | null>(null);
  const isSearchOpenRef = useRef(false);
  const queuePositionMapRef = useRef<Map<string, number>>(new Map());
  const showLineNumbersRef = useRef(showLineNumbers);
  const smoothAutoScrollRef = useRef(smoothAutoScroll);

  cellsRef.current = cells;
  activeCellIdRef.current = activeCellId;
  cellClipboardRef.current = cellClipboard;
  cellQueueRef.current = cellQueue;
  getFullHistoryRef.current = getFullHistory;
  getCellsRef.current = () => cellsRef.current;
  // Note: Other ref updates for renderCell stability are done after their state is defined

  useEffect(() => {
    const signature = cells.map(cell => `${cell.id}:${cell.type}`).join('|');
    if (signature !== cellStructureSigRef.current) {
      cellStructureSigRef.current = signature;
      let codeCount = 0;
      let markdownCount = 0;
      for (const cell of cells) {
        if (cell.type === 'code') {
          codeCount += 1;
        } else if (cell.type === 'markdown') {
          markdownCount += 1;
        }
      }
      setCellStats({ count: cells.length, codeCount, markdownCount });
    }
  }, [cells]);

  // Agent terminal wiring: cell-level "Fix with agent" actions open this
  // panel when no agent is running, and prompts carry the notebook path.
  useEffect(() => {
    agentTerminalService.setPanelOpener(() => {
      setIsTerminalOpen(true);
      setTerminalTab('agent');
    });
    return () => agentTerminalService.setPanelOpener(null);
  }, []);
  useEffect(() => {
    agentTerminalService.setNotebookContext(currentFileId ?? null);
  }, [currentFileId]);

  // When a load finishes, seed the outputs-elision baseline from the loaded
  // cells (identical to the file right now) so even the FIRST autosave elides
  // unchanged outputs instead of shipping the full payload (1.2MB+ on
  // plot-heavy notebooks — many seconds on slow tunnels).
  useEffect(() => {
    if (!isLoadingFile && currentFileId) seedOutputsBaseline(currentFileId, cells);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- baseline seeds on load transitions only, not on every cells change
  }, [isLoadingFile, currentFileId]);
  useEffect(() => {
    // The canonical MCP base_url is the URL Nebula is reached at (dev: vite on
    // :3000 proxying /api; prod: the single :3000 server). This also stays
    // correct when the agent runs on a different machine than the server —
    // unlike the server's internal API port. The bootstrap prompt tells the
    // agent to ask the user if this URL isn't reachable from where it runs
    // (e.g. SSH tunnels).
    agentTerminalService.setServerContext(window.location.origin);
  }, []);

  // Track last-known cursor position so search next/prev can be relative to cursor.
  const cursorAnchorRef = useRef<{ cellId: string; pos: number; ts: number } | null>(null);
  const recordCursorAnchor = useCallback((cellId: string, pos: number) => {
    // Ignore cursor activity triggered by editor mounts while search has focus.
    // Without this, navigating to a search match mounts a cell whose CodeMirror
    // fires cursor-activity at position 0, overriding the search's nav anchor
    // and causing next/prev to loop over the same few matches.
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && active.closest('[data-notebook-search]')) {
      return;
    }
    cursorAnchorRef.current = { cellId, pos, ts: Date.now() };
  }, []);
  const getCursorAnchor = useCallback(() => cursorAnchorRef.current, []);

  // Flush active cell's pending content changes before keyframe operations
  const flushActiveCell = useCallback(() => {
    const activeId = activeCellIdRef.current;
    if (!activeId) return;
    const cell = cellsRef.current.find(c => c.id === activeId);
    if (cell) {
      flushCell(activeId, cell.content);
    }
  }, [flushCell]);

  // Visual feedback for undo/redo
  const [highlightedCellIds, setHighlightedCellIds] = useState<Set<string>>(new Set());
  const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Update refs for renderCell stability (state must be defined before these)
  highlightedCellIdsRef.current = highlightedCellIds;
  searchQueryRef.current = searchQuery;
  indentConfigRef.current = indentConfig;
  isSearchOpenRef.current = isSearchOpen;
  showLineNumbersRef.current = showLineNumbers;
  smoothAutoScrollRef.current = smoothAutoScroll;

  // Track visible cell range for smart scrolling.
  // Keep this in a ref so high-frequency scroll updates don't re-render Notebook.
  const visibleRangeRef = useRef<{ startIndex: number; endIndex: number }>({ startIndex: 0, endIndex: 10 });

  // Memoize range change handler to prevent Virtuoso from resetting scroll.
  // Avoid setState here: this callback can fire on every scroll frame.
  const searchRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleRangeChange = useCallback((range: { startIndex: number; endIndex: number }) => {
    const prev = visibleRangeRef.current;
    visibleRangeRef.current = range;

    // When search is active and visible range changed, trigger a lightweight
    // re-render so newly visible cells pick up search decorations.
    // Only the ~5 newly visible cells will actually re-render (memo check).
    if (searchQueryRef.current && (range.startIndex !== prev.startIndex || range.endIndex !== prev.endIndex)) {
      if (searchRenderTimerRef.current) clearTimeout(searchRenderTimerRef.current);
      searchRenderTimerRef.current = setTimeout(() => {
        startTransition(() => {
          setSearchQuery(prev => prev ? { ...prev } : null);
        });
      }, 150);
    }
  }, []);

  // Virtuoso Handle for programmatic scrolling
  const cellListRef = useRef<CellListHandle>(null);

  // Pending scroll after cell changes (for undo/redo of insert/delete)
  const pendingScrollCellIdRef = useRef<string | null>(null);
  const undoRedoInFlightRef = useRef(false);
  const pendingUndoRedoRef = useRef<(() => void) | null>(null);

  // ═══════════════════════════════════════════════════════════════════════════
  // UNIFIED SCROLL UTILITY
  // All scroll operations should use this to work properly with Virtuoso
  // ═══════════════════════════════════════════════════════════════════════════
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const getDefaultScrollBehavior = useCallback((): 'smooth' | 'auto' => {
    return smoothAutoScrollRef.current ? 'smooth' : 'auto';
  }, []);

  // Unified scroll function - ALL scroll operations should use this
  // ── Simplified scroll (all cells in DOM via content-visibility) ───────────
  const scrollToCell = useCallback((
    index: number,
    options?: {
      behavior?: 'smooth' | 'auto';
      delay?: number;
      retryOnce?: boolean; // unused, kept for API compat
    }
  ) => {
    const { behavior = getDefaultScrollBehavior(), delay = 0 } = options || {};

    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);

    const doScroll = () => {
      // All cells are in the DOM (content-visibility) — just find and scroll.
      const cellEl = document.querySelector(`[data-cell-index="${index}"]`);
      if (cellEl) {
        cellEl.scrollIntoView({ block: 'start', behavior });
        return;
      }
      // Cell not rendered yet (progressive rendering) — use handle to force-render
      cellListRef.current?.scrollToIndex({ index, align: 'start', behavior, offset: -80 });
    };

    if (delay > 0) {
      scrollTimeoutRef.current = setTimeout(doScroll, delay);
    } else {
      doScroll();
    }
  }, [getDefaultScrollBehavior]);

  useEffect(() => {
    return () => { if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current); };
  }, []);

  // Check if a cell is visible in the viewport (simple DOM check)
  const isCellVisibleInViewport = useCallback((cellId: string, _cellIndex: number): boolean => {
    const cellEl = document.querySelector(`[data-cell-id="${escapeForAttributeSelector(cellId)}"]`) as HTMLElement | null;
    if (!cellEl) return false;
    const scrollerEl = cellEl.closest('.overflow-y-auto') as HTMLElement | null;
    const cellRect = cellEl.getBoundingClientRect();
    const viewportRect = scrollerEl
      ? scrollerEl.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight } as DOMRect;
    return cellRect.bottom > viewportRect.top && cellRect.top < viewportRect.bottom;
  }, []);

  // Effect to handle pending scroll after cells change (for undo/redo of insert/delete)
  // Clear the ref BEFORE scrolling to prevent double-scroll in Strict Mode
  useEffect(() => {
    const cellId = pendingScrollCellIdRef.current;
    if (cellId) {
      // Clear immediately to prevent double-invocation in Strict Mode
      pendingScrollCellIdRef.current = null;
      const index = cellsRef.current.findIndex(c => c.id === cellId);
      if (index >= 0) {
        if (!isCellVisibleInViewport(cellId, index)) {
          scrollToCell(index);
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, scrollToCell, isCellVisibleInViewport]); // cells dep triggers the effect; body uses ref to avoid capturing

  // Helper to show visual feedback for undo/redo (highlight only, no scrolling)
  const showUndoRedoFeedback = useCallback((affectedCellIds: string[]) => {
    // Clear any pending highlight timeout
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
    }

    // Set highlighted cells
    setHighlightedCellIds(new Set(affectedCellIds));

    // Clear highlights after animation
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedCellIds(new Set());
    }, 1500); // Match CSS animation duration
  }, []);
  highlightCellsFnRef.current = showUndoRedoFeedback;

  // Helper to apply undo/redo with scroll and feedback
  // - If operation DELETES a cell: scroll first (so user sees the cell), then operate
  // - Otherwise: operate first, then scroll (only if cell not visible) and highlight
  const applyWithScrollFeedback = useCallback((
    peekFn: () => { affectedCellIds: string[]; operationType: string } | null,
    applyFn: () => { affectedCellIds: string[] } | null,
    willDeleteCell: boolean
  ) => {
    const run = () => {
      flushActiveCell();

      const finalize = () => {
        undoRedoInFlightRef.current = false;
        const pending = pendingUndoRedoRef.current;
        if (pending) {
          pendingUndoRedoRef.current = null;
          pending();
        }
      };

      const peek = peekFn();
      if (!peek || peek.affectedCellIds.length === 0) {
        applyFn();
        finalize();
        return;
      }

      const firstCellId = peek.affectedCellIds[0];
      const currentCells = cellsRef.current;
      const cellIndex = currentCells.findIndex(c => c.id === firstCellId);
      const cellExists = cellIndex >= 0;
      // Only scroll if no part of the cell is currently visible
      const needsScroll = cellExists && !isCellVisibleInViewport(firstCellId, cellIndex);

      if (willDeleteCell && needsScroll) {
        // Scroll to cell before deletion, then apply on next frame
        scrollToCell(cellIndex);
        requestAnimationFrame(() => {
          const result = applyFn();
          if (result?.affectedCellIds.length) showUndoRedoFeedback(result.affectedCellIds);
          finalize();
        });
        return;
      }

      // Apply first, then scroll (only if not visible) and highlight
      const result = applyFn();
      if (result?.affectedCellIds.length) {
        showUndoRedoFeedback(result.affectedCellIds);
        // Only schedule scroll if cell is not visible (or is a new cell that needs finding)
        // For operations on existing visible cells (like metadata changes), don't scroll
        const targetId = result.affectedCellIds[0];
        const targetIndex = currentCells.findIndex(c => c.id === targetId);
        if (targetIndex === -1 || !isCellVisibleInViewport(targetId, targetIndex)) {
          pendingScrollCellIdRef.current = targetId;
        }
      }
      finalize();
    };

    if (undoRedoInFlightRef.current) {
      pendingUndoRedoRef.current = run;
      return;
    }
    undoRedoInFlightRef.current = true;
    run();
  }, [flushActiveCell, isCellVisibleInViewport, showUndoRedoFeedback, scrollToCell]);

  // Undo: deleteCell restores a cell, insertCell removes it
  const undo = useCallback(() => {
    const peek = peekUndo();
    const willDelete = peek?.operationType === 'insertCell'; // Undo insert = delete
    applyWithScrollFeedback(peekUndo, rawUndo, willDelete);
  }, [peekUndo, rawUndo, applyWithScrollFeedback]);

  // Redo: insertCell adds a cell, deleteCell removes it
  const redo = useCallback(() => {
    const peek = peekRedo();
    const willDelete = peek?.operationType === 'deleteCell'; // Redo delete = delete
    applyWithScrollFeedback(peekRedo, rawRedo, willDelete);
  }, [peekRedo, rawRedo, applyWithScrollFeedback]);

  // Ref for saveNow to avoid stale closures in keyboard handler
  const saveNowRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // Best-effort flush hook for the ErrorBoundary: before its reload nukes
  // in-memory state, it tries to save whatever autosave hasn't shipped yet.
  useEffect(() => {
    (window as any).__nebulaFlushSave = () => saveNowRef.current?.();
    return () => { delete (window as any).__nebulaFlushSave; };
  }, []);
  // Ref for handleManualSave to avoid stale closures in keyboard handler
  const handleManualSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Autosave hook with conflict detection
  const performSaveToFile = useCallback(async (fileId: string, cellsToSave: Cell[]) => {
    if (isSealedReadOnly) return;
    try {
      // Get history to save alongside notebook
      // IMPORTANT: Skip history if not ready to prevent overwriting persisted history
      // History is ready after loadHistory() or initializeNewHistory() completes
      const history = historyReady ? getFullHistory() : undefined;

      // Use ref for mtime to avoid stale closures causing false conflicts
      const result = await saveWithCheck(
        fileId,
        cellsToSave,
        lastKnownMtimeRef.current,
        currentKernel,
        history,
      );

      if (result.needsResolution) {
        // Conflict detected - dialog is shown, wait for user action
        // The hook will handle mtime updates when resolved
        return;
      }

      if (result.success) {
        // Note: setLastKnownMtime is called by saveWithCheck in the hook,
        // which now updates both state AND ref synchronously
        setPendingSave(false);
        await updateNotebookMetadata(fileId, {});

        // Save session state (unflushed edits and active cell) alongside notebook
        const unflushedState = getUnflushedState(activeCellIdRef.current, cellsToSave);
        await saveNotebookSession(fileId, {
          unflushedEdit: unflushedState ?? undefined,
          activeCellId: activeCellIdRef.current ?? undefined,
        });

        // Persist live ipywidgets state to metadata.widgets so the saved
        // .ipynb renders static widgets in Jupyter/nbviewer. peek… returns
        // null (and we skip, preserving any previously saved state) unless a
        // widget manager was actually created this page-load — so this never
        // pulls the lazy widget chunk on notebooks without widgets.
        if (kernelSessionId && fileId.endsWith('.ipynb')) {
          try {
            const widgetState = await peekWidgetStateSnapshot(kernelSessionId);
            if (widgetState) {
              const res = await saveWidgetState(fileId, widgetState);
              adoptServerMtime(res?.mtime);
            }
          } catch (err) {
            console.warn('Widget state persistence failed (save itself succeeded):', err);
          }
        }
      } else if (result.error) {
        throw new Error(result.error);
      }
    } catch (error) {
      // Network error - mark as pending and will retry when online
      console.warn('Save failed, will retry:', error);
      setPendingSave(true);
      throw error; // Re-throw so autosave knows it failed
    }
  }, [isSealedReadOnly, historyReady, getFullHistory, currentKernel, saveWithCheck, getUnflushedState, kernelSessionId, currentFileId, adoptServerMtime]);

  // Surface save failures loudly — silent autosave loss is the scariest failure
  // mode a notebook can have. Retries are automatic; toast on the first failure
  // and then every 5th consecutive one to avoid spamming during an outage.
  const handleAutosaveError = useCallback((error: Error, info: { isManual: boolean; consecutiveFailures: number }) => {
    if (info.isManual || info.consecutiveFailures === 1 || info.consecutiveFailures % 5 === 0) {
      const detail = error.message && error.message !== 'Failed to fetch' ? ` (${error.message})` : '';
      toast(`Save failed${detail} — your latest changes are not on disk yet. Retrying automatically.`, 'error', 8000);
    }
  }, [toast]);

  const { status: autosaveStatus, saveNow } = useAutosave({
    fileId: currentFileId,
    cells,
    onSave: performSaveToFile,
    loading: isLoadingFile, // baseline seeds when the load FINISHES (not when fileId flips)
    deferWhile: isAiCompletionInFlight, // completions take precedence; saves wait for a true idle
    // Avoid repeated conflict checks / log spam while the conflict modal is
    // open OR while a resolution's force-save is still in flight (resuming
    // early would re-detect the same conflict against the stale mtime).
    enabled: !isSealedReadOnly && !conflictDialog?.show && !conflictResolving,
    hasRedoHistory: canRedo, // Block autosave when redo history exists
    onSaveError: handleAutosaveError,
  });

  // Keep saveNow ref updated synchronously (not in useEffect which runs after render)
  saveNowRef.current = saveNow;

  // Online/offline detection and retry pending saves
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      // Retry pending save when coming back online
      if (pendingSave && currentFileId) {
        saveNow().catch(() => {
          // Save retry failed, will try again next time
        });
      }
    };

    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [pendingSave, currentFileId, saveNow]);

  // Handle kernel WebSocket reconnection
  useEffect(() => {
    const unsubscribeReconnect = kernelService.onReconnect(async (sessionId, filePath) => {
      // Only handle reconnection for current file's kernel
      if (!currentFileId || filePath !== currentFileId) return;

      if (kernelSessionId !== sessionId) {
        console.log(`Kernel session updated for ${filePath}: ${kernelSessionId} -> ${sessionId}`);
        setKernelSessionId(sessionId);
      }

      console.log('Kernel reconnected, checking for file changes...');
      // Don't hardcode 'idle' — the initial WebSocket status message from the
      // server carries the actual kernel state (may be 'busy' if the kernel was
      // mid-execution during a server restart). The onStatus callback handles it.
      setIsKernelReady(true);

      // Trigger save which will check for conflicts via saveWithCheck
      // If there's a conflict, the hook will show the dialog automatically
      try {
        await saveNow();
      } catch (error) {
        console.error('Error saving after reconnect:', error);
      }
    });

    const unsubscribeDisconnect = kernelService.onDisconnect((sessionId) => {
      if (kernelSessionIdRef.current === sessionId) {
        console.log('Kernel disconnected, will attempt reconnection...');
        setKernelStatus('disconnected');
        setIsKernelReady(false);
      }
    });

    // Subscribe to status updates from server.
    // Use kernelSessionIdRef instead of closure-captured kernelSessionId so that
    // the initial status message sent right after WebSocket connect isn't dropped
    // when onReconnect changes the session ID mid-render.
    const unsubscribeStatus = kernelService.onStatus((sessionId, status, cellId) => {
      if (kernelSessionIdRef.current === sessionId) {
        console.log(`Kernel status update: ${status}${cellId ? ` (cell: ${cellId})` : ''}`);
        if (status === 'idle' || status === 'busy') {
          setKernelStatus(status);
          setIsKernelReady(true);
        } else if (status === 'starting') {
          setKernelStatus('starting');
        } else if (status === 'dead') {
          // Kernel process died (crash/OOM). Stop pretending: clear the
          // queue and executing flags, tell the user, point at restart.
          setKernelStatus('dead');
          setIsKernelReady(false);
          executionQueueRef.current = [];
          setExecutionQueue([]);
          setCells(prev => prev.map(c => (c.isExecuting ? { ...c, isExecuting: false } : c)));
          // Diagnose: if the last memory sample was near the allocation
          // limit, this was almost certainly a SLURM cgroup OOM kill.
          if (lastMemPctRef.current != null && lastMemPctRef.current >= 0.8) {
            toast(
              `Kernel died at ~${Math.round(lastMemPctRef.current * 100)}% of the allocation memory limit — almost certainly OOM-killed by SLURM. Re-allocate with more memory for this workload.`,
              'error',
              15000, { label: 'Restart kernel', onClick: () => restartKernelFnRef.current?.() }
            );
          } else {
            toast('Kernel died', 'error', 10000, {
              label: 'Restart kernel',
              onClick: () => restartKernelFnRef.current?.(),
            });
          }
        }
        // If kernel is busy with a specific cell (reconnect scenario),
        // mark that cell as executing so the spinner shows and output streams.
        if (status === 'busy' && cellId) {
          setCells(prev => prev.map(c =>
            c.id === cellId ? { ...c, isExecuting: true } : c
          ));
        }
        // When kernel goes idle, clear isExecuting on all cells
        if (status === 'idle') {
          setCells(prev => {
            const anyExecuting = prev.some(c => c.isExecuting);
            return anyExecuting ? prev.map(c => c.isExecuting ? { ...c, isExecuting: false } : c) : prev;
          });
        }
      }
    });

    return () => {
      unsubscribeReconnect();
      unsubscribeDisconnect();
      unsubscribeStatus();
    };
  }, [currentFileId, kernelSessionId, saveNow]);

  // Execution State
  const [isKernelReady, setIsKernelReady] = useState(false);
  const [executionQueue, setExecutionQueue] = useState<string[]>([]);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);
  const [kernelExecutionCount, setKernelExecutionCount] = useState(0); // Global execution counter
  const executionStartTimeRef = useRef<number | null>(null); // Track when queue execution started

  // Execution indicator state - persists after completion until dismissed
  // (elapsed time lives in the ElapsedTimer leaf, driven by cellExecutionStartRef)
  const [lastExecutionResult, setLastExecutionResult] = useState<{
    cellId: string;
    cellIndex: number;
    status: 'completed' | 'error';
    elapsedMs: number;
  } | null>(null);
  const lastCompletedCellRef = useRef<{ cellId: string; cellIndex: number } | null>(null);
  const cellExecutionStartRef = useRef<number | null>(null); // Track when current cell started

  // Close execution queue dropdown when queue becomes empty
  useEffect(() => {
    if (executionQueue.length === 0) {
      setIsExecutionQueueOpen(false);
    }
  }, [executionQueue.length]);

  // Memoize execution indicator state to avoid O(N) findIndex on every render
  const executionIndicator = useMemo(() => {
    if (executionQueue.length === 0) return null;
    const executingCellId = executionQueue[0];
    const executingCellIndex = cellsRef.current.findIndex(c => c.id === executingCellId);
    return { cellId: executingCellId, cellIndex: executingCellIndex, queueLength: executionQueue.length };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executionQueue, cells]); // cells dep triggers recompute; body uses ref

  // Memoize queue position lookup to avoid O(N) indexOf for each cell during render
  const queuePositionMap = useMemo(() => {
    const map = new Map<string, number>();
    executionQueue.forEach((id, idx) => map.set(id, idx));
    return map;
  }, [executionQueue]);
  executionQueueRef.current = executionQueue;
  queuePositionMapRef.current = queuePositionMap;

  // Cleanup runIds for cells removed from the queue
  useEffect(() => {
    const currentIds = new Set(executionQueue);
    for (const id of executionRunIdsRef.current.keys()) {
      if (!currentIds.has(id)) {
        executionRunIdsRef.current.delete(id);
      }
    }
  }, [executionQueue]);

  // Clear last result when new execution starts
  useEffect(() => {
    if (executionQueue.length > 0 && !isProcessingQueue) {
      setLastExecutionResult(null);
    }
  }, [executionQueue.length, isProcessingQueue]);

  // Dismiss execution result indicator
  const dismissExecutionResult = useCallback(() => {
    setLastExecutionResult(null);
  }, []);

  // Allocation memory limit (bytes) for the kernel's server when it runs on
  // a scheduler allocation; null otherwise. SLURM OOM-kills the kernel the
  // instant it crosses this limit (SIGKILL, no warning), so we warn the user
  // as usage approaches it and diagnose deaths that happen near it.
  const allocationMemLimitRef = useRef<number | null>(null);
  const lastMemPctRef = useRef<number | null>(null);
  const lastMemWarnAtRef = useRef(0);

  // Kernel memory usage tracking (only when tab is visible)
  useEffect(() => {
    if (!kernelSessionId) {
      setMemoryUsage(null);
      allocationMemLimitRef.current = null;
      lastMemPctRef.current = null;
      return;
    }

    // Resolve the allocation memory limit for this kernel's server (if any)
    allocationMemLimitRef.current = null;
    listAllocations()
      .then(allocs => {
        const alloc = allocs.find(a => a.serverId && a.serverId === selectedServerId);
        if (alloc?.spec?.memGb) {
          allocationMemLimitRef.current = alloc.spec.memGb * 1024 * 1024 * 1024;
        }
      })
      .catch(() => { /* compute disabled or transient — no limit tracking */ });

    let notFoundCount = 0;
    const updateMemory = async () => {
      // Skip polling when tab is hidden to reduce load
      if (document.hidden) return;

      try {
        const response = await fetch(`/api/kernels/${kernelSessionId}/status`);
        if (response.ok) {
          notFoundCount = 0; // Reset on success
          const status = await response.json();
          if (status.memory_mb != null) {
            const usedBytes = status.memory_mb * 1024 * 1024;
            const limitBytes = allocationMemLimitRef.current;
            setMemoryUsage({
              used: usedBytes, // bytes for consistent display
              total: limitBytes ?? 0, // allocation limit when known
            });

            if (limitBytes) {
              const pct = usedBytes / limitBytes;
              lastMemPctRef.current = pct;
              const now = Date.now();
              // Warn approaching the cgroup limit — SLURM gives no grace
              if (pct >= 0.85 && now - lastMemWarnAtRef.current > 5 * 60_000) {
                lastMemWarnAtRef.current = now;
                toast(
                  `Kernel memory at ${Math.round(pct * 100)}% of the ${(limitBytes / 1024 ** 3).toFixed(0)} GB allocation limit — SLURM kills the kernel at the limit with no warning. Save your work or allocate more memory.`,
                  'warning',
                  12000
                );
              }
            }
          }
        } else if (response.status === 404) {
          notFoundCount++;
          // A 404 for our own session id is unambiguous (server restarted or
          // session pruned) — act on the first one instead of waiting another
          // 10s poll cycle for a second.
          if (notFoundCount >= 1) {
            console.log('[Notebook] Kernel session not found on server, clearing stale session');
            toast('Kernel session was lost on the server. Reconnect to start a new kernel.', 'warning', 4000);
            setKernelSessionId(null);
            setKernelStatus('disconnected');
            setIsKernelReady(false);
            setMemoryUsage(null);
          }
        }
      } catch {
        // Ignore fetch errors (network issues)
      }
    };
    updateMemory();
    const interval = setInterval(updateMemory, 10000); // Update every 10 seconds (reduced from 5)
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernelSessionId, selectedServerId]);

  // "Use when ready": watch the armed allocation until it registers, then
  // switch kernels to it. Cleared on success, failure, or user re-selection.
  useEffect(() => {
    if (!pendingAllocSwitch) return;
    let cancelled = false;
    const check = async () => {
      let alloc;
      try {
        const allocs = await listAllocations();
        alloc = allocs.find(a => a.id === pendingAllocSwitch);
      } catch {
        return; // transient — keep watching
      }
      if (cancelled) return;
      if (!alloc || ['ended', 'failed', 'cancelled'].includes(alloc.state)) {
        setPendingAllocSwitch(null);
        toast(
          alloc
            ? `Allocation ${alloc.spec.jobName || alloc.id} ${alloc.state} before it became ready`
            : 'The selected allocation is gone',
          'warning',
          6000
        );
        return;
      }
      if (alloc.state === 'active' && alloc.serverId) {
        setPendingAllocSwitch(null);
        switchServer(alloc.serverId);
        setIsKernelMenuOpen(true);
        toast('Allocation is ready — kernels switched. Choose a kernel to start.', 'info', 6000);
      }
    };
    check();
    const id = setInterval(check, 3000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAllocSwitch]);

  // Fetch available kernels and initialize
  // Load Python environments (separate from kernel init for faster startup)
  const loadPythonEnvironments = useCallback(async (refresh: boolean = false, serverId?: string | null, autoSelectKernel = true) => {
    try {
      setIsDiscoveringPythons(true);
      const targetServerId = serverId ?? selectedServerId;
      const data = await kernelService.getPythonEnvironments(refresh, targetServerId);
      setAvailableKernels(data.kernelspecs);
      setPythonEnvironments(data.environments);
      // Only auto-select first kernel if requested (skip during server switch).
      // env: kernels are valid without a kernelspec — never auto-switch away.
      if (autoSelectKernel && data.kernelspecs.length > 0 && !isEnvKernelName(currentKernel) && !data.kernelspecs.some(k => k.name === currentKernel)) {
        setCurrentKernel(data.kernelspecs[0].name);
      }
    } catch (error) {
      console.error('Failed to load Python environments:', error);
    } finally {
      setIsDiscoveringPythons(false);
    }
  }, [selectedServerId, currentKernel]);

  useEffect(() => {
    const initKernels = async () => {
      try {
        // Load cluster info for multi-server support
        let initialServerId: string | null = null;
        try {
          const cluster = await getClusterInfo();
          setClusterInfo(cluster);
          initialServerId = cluster.localServerId;
          // Default to local server
          setSelectedServerId(cluster.localServerId);
        } catch (clusterError) {
          console.error('Failed to load cluster info:', clusterError);
          // Cluster feature is optional, continue without it
        }

        // Just load available kernels on startup, don't start one yet
        // Kernel will be started when a file is loaded
        const kernels = await kernelService.getAvailableKernels(initialServerId);
        setAvailableKernels(kernels);

        // Get saved kernel preference
        const settings = getSettings();
        const preferredKernel = settings.lastKernel || 'python3';
        const kernelExists = kernels.some(k => k.name === preferredKernel);
        setCurrentKernel(kernelExists ? preferredKernel : (kernels[0]?.name || 'python3'));

        // Load Python environments in background (uses cache)
        loadPythonEnvironments(false, initialServerId);
      } catch (error) {
        console.error('Failed to load kernels:', error);
      }
    };

    initKernels();

    // Note: We don't stop the kernel on unmount anymore
    // Kernels are tied to notebook files, not browser tabs
    // The kernel stays running on the server until explicitly stopped
  }, []);

  // Detect scheduler-backed compute (SLURM etc.) — gates the "New compute
  // allocation" entry in the kernel menu. Optional feature; failure is silent.
  useEffect(() => {
    let cancelled = false;
    const p = getComputeStatus()
      .then((s) => { if (!cancelled) setComputeEnabled(!!s.enabled); return !!s.enabled; })
      .catch(() => { if (!cancelled) setComputeEnabled(false); return false; });
    computeStatusReadyRef.current = p;
    return () => { cancelled = true; };
  }, []);

  // Is the local (server) node a scheduler login node? Awaits detection so a
  // cold-load kernel start doesn't race it. Falls back to current state.
  const isLoginNodeReady = useCallback(async (): Promise<boolean> => {
    try { return await (computeStatusReadyRef.current ?? Promise.resolve(computeEnabled)); }
    catch { return computeEnabled; }
  }, [computeEnabled]);

  // Re-fetch cluster membership (e.g. after an allocation registers a new server).
  const refreshClusterInfo = useCallback(async () => {
    try {
      setClusterInfo(await getClusterInfo());
    } catch (err) {
      console.error('Failed to refresh cluster info:', err);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = kernelService.onBufferedOutput((sessionId, output, cellId) => {
      if (kernelSessionId && sessionId !== kernelSessionId) return;
      if (!cellId) return;
      setCells(prev => prev.map(c => {
        if (c.id !== cellId) return c;
        return { ...c, outputs: [...(c.outputs || []), output], pendingOutputReset: false };
      }));
    });
    return unsubscribe;
  }, [kernelSessionId, setCells]);

  // Sync replace effect: on reconnect, server sends complete cell output arrays
  // and which cell is currently executing. We replace outputs and restore isExecuting.
  useEffect(() => {
    const unsubscribe = kernelService.onSyncReplace((sessionId, cellOutputs, executingCellId) => {
      if (kernelSessionId && sessionId !== kernelSessionId) return;
      setCells(prev => prev.map(c => {
        const syncedOutputs = cellOutputs.get(c.id);
        const isExecuting = c.id === executingCellId;
        const nextPendingOutputReset = syncedOutputs !== undefined || !isExecuting
          ? false
          : c.pendingOutputReset;
        if (
          syncedOutputs === undefined &&
          c.isExecuting === isExecuting &&
          c.pendingOutputReset === nextPendingOutputReset
        ) {
          return c;
        }
        return {
          ...c,
          outputs: syncedOutputs ?? c.outputs,
          isExecuting,
          pendingOutputReset: nextPendingOutputReset,
        };
      }));
    });
    return unsubscribe;
  }, [kernelSessionId, setCells]);

  // Load the initial file (currentFileId is already set synchronously from URL/localStorage)
  // Guard against React Strict Mode double-invocation which would fetch the
  // entire notebook twice, doubling memory usage during development.
  const initialLoadDoneRef = useRef(false);
  useEffect(() => {
    if (initialLoadDoneRef.current) return;
    initialLoadDoneRef.current = true;
    if (currentFileId) {
      loadFile(currentFileId);
    } else {
      setIsLoadingFile(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // Update browser tab title, URL, and favicon when file changes
  useEffect(() => {
    if (currentFileId) {
      // Tab title mirrors the in-app header exactly (extension stripped) —
      // "model-prediction", not "model-prediction.ipynb".
      const filename = stripNotebookExtension(getFilenameFromPath(currentFileId));
      document.title = `${filename} - Nebula Notebook`;

      // Keep verified evidence coordinates in the URL. The visual/read-only
      // state still comes exclusively from the server's access classification.
      const baseUrl = window.location.pathname;
      let nextUrl = `${baseUrl}?file=${encodeReadablePath(currentFileId)}`;
      if (isSealedReadOnly) {
        nextUrl += `&mode=sealed&seal=${encodeURIComponent(notebookAccess.seal_id)}`;
        if (evidenceCellHintRef.current) {
          nextUrl += `&cell=${encodeURIComponent(evidenceCellHintRef.current)}`;
        }
      }
      window.history.replaceState({}, '', nextUrl);

      // Update favicon with notebook-specific avatar
      const avatarUrl = getNotebookAvatar(currentFileId);
      updateFavicon(avatarUrl);
    } else {
      document.title = 'Nebula Notebook';
      window.history.replaceState({}, '', window.location.pathname);
      resetFavicon();
    }
  }, [currentFileId, isSealedReadOnly, notebookAccess]);

  // Refs for functions used in keyboard handler (defined later in component)
  const deleteCellRef = useRef<((id: string) => void) | null>(null);
  const addCellRef = useRef<((type: CellType, content?: string, afterIndex?: number, noScroll?: boolean | 'cell' | 'editor') => void) | null>(null);
  const changeCellTypeRef = useRef<((id: string, type: CellType) => void) | null>(null);
  const runAndAdvanceRef = useRef<((id: string, focusMode: 'cell' | 'editor') => void) | null>(null);
  const queueExecutionRef = useRef<((id: string) => void) | null>(null);
  const kernelStatusRef = useRef<string>(kernelStatus);
  const kernelSessionIdRef = useRef<string | null>(kernelSessionId);
  const interruptKernelRef = useRef<(() => void) | null>(null);
  const restartKernelFnRef = useRef<(() => void) | null>(null);
  const undoFnRef = useRef<(() => void) | null>(null);
  const redoFnRef = useRef<(() => void) | null>(null);
  // Track pending focus for next cell - Cell component handles the actual focusing
  const [pendingFocus, setPendingFocus] = useState<{ cellId: string; mode: 'cell' | 'editor' } | null>(null);
  const clearPendingFocus = useCallback(() => setPendingFocus(null), []);
  pendingFocusRef.current = pendingFocus;

  // ── Multi-cell selection (command mode) ──
  // Shift+↑/↓ extends from the focused cell, Shift+click selects a range.
  // Delete/Backspace, C and X then operate on the whole selection.
  const [selectedCellIds, setSelectedCellIds] = useState<Set<string>>(new Set());
  const selectedCellIdsRef = useRef(selectedCellIds);
  selectedCellIdsRef.current = selectedCellIds;
  // Fixed end of a shift-range selection; the focused cell is the moving tip
  const selectionAnchorRef = useRef<string | null>(null);
  const scrollToCellFnRef = useRef<((index: number, opts?: { behavior?: 'smooth' | 'auto'; delay?: number; retryOnce?: boolean }) => void) | null>(null);
  scrollToCellFnRef.current = scrollToCell;
  const pasteClipboardCellsRef = useRef<((items: CellClipboardItem[], insertAt: number) => void) | null>(null);

  const clearCellSelection = useCallback(() => {
    selectionAnchorRef.current = null;
    setSelectedCellIds(prev => (prev.size === 0 ? prev : new Set<string>()));
  }, []);

  // Replace the selection with the contiguous range anchor→target (inclusive)
  const selectCellRange = useCallback((anchorId: string, targetId: string) => {
    const currentCells = cellsRef.current;
    const aIdx = currentCells.findIndex(c => c.id === anchorId);
    const tIdx = currentCells.findIndex(c => c.id === targetId);
    if (aIdx === -1 || tIdx === -1) return;
    selectionAnchorRef.current = anchorId;
    const [lo, hi] = aIdx <= tIdx ? [aIdx, tIdx] : [tIdx, aIdx];
    setSelectedCellIds(new Set(currentCells.slice(lo, hi + 1).map(c => c.id)));
  }, []);

  // Delete every selected cell as ONE undoable action (single Ctrl+Z restores
  // all). If the selection covers the whole notebook, the batch also inserts a
  // fresh empty cell so the notebook is never left cell-less.
  const deleteSelectedCells = useCallback(() => {
    const selected = selectedCellIdsRef.current;
    if (selected.size === 0) return;
    flushActiveCell();

    const currentCells = cellsRef.current;
    const doomed = currentCells
      .map((cell, index) => ({ cell, index }))
      .filter(({ cell }) => selected.has(cell.id));
    if (doomed.length === 0) return;

    const ops: Operation[] = doomed
      .slice()
      .reverse() // delete from the highest index down so earlier indices stay valid
      .map(({ cell, index }) => ({ type: 'deleteCell' as const, index, cell: cloneCell(cell), source: 'user' as EditSource }));

    if (doomed.length === currentCells.length) {
      const replacement: Cell = { id: generateCellId(), type: 'code', content: '', outputs: [], isExecuting: false };
      ops.push({ type: 'insertCell', index: 0, cell: replacement, source: 'user' });
    }
    batch(ops);

    // Focus the cell that takes the selection's place. doomed[0].index is the
    // lowest selected index, so it equals the count of surviving cells above it.
    const remaining = currentCells.filter(c => !selected.has(c.id));
    clearCellSelection();
    const focusTarget = remaining.length > 0
      ? remaining[Math.min(doomed[0].index, remaining.length - 1)]
      : null;
    if (focusTarget) {
      setActiveCellId(focusTarget.id);
      setPendingFocus({ cellId: focusTarget.id, mode: 'cell' });
    }
  }, [flushActiveCell, batch, clearCellSelection]);

  // Copy (or cut) all selected cells to the cell clipboard, in notebook order
  const copySelectedCells = useCallback((cut: boolean) => {
    const selected = selectedCellIdsRef.current;
    if (selected.size === 0) return;
    const items: CellClipboardItem[] = cellsRef.current
      .filter(c => selected.has(c.id))
      .map(c => ({ type: c.type, content: c.content, sourceId: c.id, isCut: cut }));
    if (items.length === 0) return;
    cellClipboardRef.current = items;
    setCellClipboard(items);
    if (cut) {
      deleteSelectedCells();
    }
  }, [deleteSelectedCells]);

  // Paste clipboard cells (1..n) at a position as ONE undoable action
  const pasteClipboardCells = useCallback((items: CellClipboardItem[], insertAt: number) => {
    if (items.length === 0) return;
    flushActiveCell();

    const currentCells = cellsRef.current;
    const existingIds = new Set(currentCells.map(c => c.id));
    const clampedAt = Math.max(0, Math.min(insertAt, currentCells.length));

    const ops: Operation[] = items.map((item, offset) => {
      let newId = generateCellId();
      while (existingIds.has(newId)) newId = generateCellId();
      existingIds.add(newId);
      const newCell: Cell = { id: newId, type: item.type, content: item.content, outputs: [], isExecuting: false };
      return { type: 'insertCell' as const, index: clampedAt + offset, cell: newCell, source: 'user' as EditSource };
    });
    batch(ops);

    // Focus the last pasted cell
    const lastOp = ops[ops.length - 1];
    if (lastOp.type === 'insertCell') {
      setActiveCellId(lastOp.cell.id);
      setPendingFocus({ cellId: lastOp.cell.id, mode: 'cell' });
    }
  }, [flushActiveCell, batch]);
  pasteClipboardCellsRef.current = pasteClipboardCells;

  // Keyboard shortcuts — extracted verbatim to hooks/useNotebookKeyboardShortcuts
  // (first slice of the Notebook decomposition; deps re-snapshot every render
  // so the single capture-phase listener never reads stale closures).
  useNotebookKeyboardShortcuts({
    readOnly: isSealedReadOnly,
    cellsRef, selectedCellIdsRef, selectionAnchorRef, cursorAnchorRef,
    cellClipboardRef, cellQueueRef, jupyterShortcutsRef,
    handleManualSaveRef, addCellRef, deleteCellRef, changeCellTypeRef,
    pasteClipboardCellsRef, undoFnRef, redoFnRef, restartKernelFnRef,
    interruptKernelRef, scrollToCellFnRef,
    selectCellRange, clearCellSelection, deleteSelectedCells, copySelectedCells,
    setActiveCellId, setPendingFocus, setSearchSeed, setIsSearchOpen,
    setIsTerminalOpen, setIsHistoryOpen, setCellClipboard, setCellQueue,
  });

  const refreshFileList = async () => {
    const updatedFiles = await getFiles();
    setFiles(updatedFiles);
    if (currentFileId) {
      const current = updatedFiles.find(f => f.id === currentFileId);
      if (current) setCurrentFileMetadata(current);
    }
  };
  refreshFileListRef.current = refreshFileList;

  // Called when settings are saved - updates local state from settings
  const handleSettingsChange = useCallback(() => {
    refreshFileList();
    const settings = getSettings();
    setShowLineNumbers(settings.showLineNumbers ?? false);
    setShowOutputLoggingToggle(settings.showOutputLoggingToggle ?? false);
    setShowCellIds(settings.showCellIds ?? false);
    setShowResourceMonitor(settings.showResourceMonitor ?? false);
    setSmoothAutoScroll(settings.smoothAutoScroll ?? true);
    setJupyterShortcutsEnabled(settings.jupyterShortcuts ?? false);
  }, []);

  // Get current notebook filename (without extension)
  const currentFilename = currentFileId
    ? stripNotebookExtension(getFilenameFromPath(currentFileId))
    : 'Untitled';

  // Start renaming the notebook
  const startRenameNotebook = () => {
    if (!currentFileId || isSealedReadOnly) return;
    setRenameValue(currentFilename);
    setIsRenamingNotebook(true);
  };

  // Finish renaming the notebook
  const finishRenameNotebook = async () => {
    if (isSealedReadOnly || !currentFileId || !renameValue.trim()) {
      setIsRenamingNotebook(false);
      return;
    }

    const newName = renameValue.trim();
    // If name unchanged, just close the editor
    if (newName === currentFilename) {
      setIsRenamingNotebook(false);
      return;
    }

    // Build new path, preserving the file's actual extension
    const dir = currentFileId.substring(0, currentFileId.lastIndexOf('/'));
    const currentExt = getPathExtension(currentFileId) || '.ipynb';
    const newPath = `${dir}/${newName}${currentExt}`;

    try {
      await renameFile(currentFileId, newPath);
      setCurrentFileId(newPath);
      saveActiveFileId(newPath);
      setIsRenamingNotebook(false);
    } catch (err: any) {
      toast(err.message || 'Failed to rename notebook', 'error');
    }
  };

  // Handle rename keydown
  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishRenameNotebook();
    } else if (e.key === 'Escape') {
      setIsRenamingNotebook(false);
    }
  };

  const loadFileAsync = async (
    id: string,
    content: Cell[],
    notebookKernel?: string,
    requestedId?: string,
    access: NotebookAccess = { read_only: false },
    requestedCellId?: string,
  ) => {
    const sameFileAliases = new Set([id, requestedId].filter((value): value is string => Boolean(value)));
    if (currentFileId && !sameFileAliases.has(currentFileId)) {
      // Keyframe: flush active cell before switching files
      flushActiveCell();
      saveNow(); // Save current file before switching
    }

    // Set indentation based on user preference or autodetect
    const settings = getSettings();
    const userIndent = getIndentConfigFromPreference(settings.indentation || 'auto');
    if (userIndent) {
      setIndentConfig(userIndent);
    } else {
      // Autodetect from file content
      const detectedIndent = detectIndentationFromCells(content);
      setIndentConfig(detectedIndent);
    }

    // Deduplicate cell IDs — notebooks with repeated cells (or corrupt metadata)
    // may have non-unique IDs which break React keys, undo/redo, and search.
    const seenIds = new Set<string>();
    const renamedIds: Array<{ index: number; oldId: string; newId: string }> = [];
    for (let i = 0; i < content.length; i++) {
      if (seenIds.has(content[i].id)) {
        const oldId = content[i].id;
        let newId = generateCellId();
        while (seenIds.has(newId)) newId = generateCellId();
        content[i] = { ...content[i], id: newId };
        renamedIds.push({ index: i, oldId, newId });
      }
      seenIds.add(content[i].id);
    }
    if (renamedIds.length > 0) {
      console.info(`[Load] Deduplicated ${renamedIds.length} cell IDs`);
    }

    // IMPORTANT: History loading flow to prevent data loss
    // 1. Set cells WITHOUT creating a new snapshot (preserves existing history)
    // 2. Load history from file
    // 3. If history exists: call loadHistory() to restore undo/redo stack
    // 4. If no history: call initializeNewHistory() to create initial snapshot
    // 5. Mark history as ready so saves can include history
    setHistoryReady(false);
    loadCells(content);

    // Set UI state immediately - don't block on history loading
    setCurrentFileId(id);
    setNotebookAccess(access);
    saveActiveFileId(id);

    // Track in recently opened notebooks
    const fileName = stripNotebookExtension(id.split('/').pop() || '') || id;
    addRecentNotebook(id, fileName);
    const evidenceTarget = access.read_only && requestedCellId
      ? content.find(cell => cell.id === requestedCellId) ?? null
      : null;
    evidenceCellHintRef.current = evidenceTarget?.id ?? null;
    setActiveCellId(evidenceTarget?.id ?? (content.length > 0 ? content[0].id : null));
    setIsLoadingFile(false);
    if (evidenceTarget) {
      const targetIndex = content.findIndex(cell => cell.id === evidenceTarget.id);
      setPendingFocus({ cellId: evidenceTarget.id, mode: 'cell' });
      setTimeout(() => scrollToCell(targetIndex, { behavior: 'auto', retryOnce: true }), 0);
    }

    // Load persisted history, session state, agent permission, and notebook settings
    Promise.all([
      loadNotebookHistory(id),
      loadNotebookSession(id),
      getAgentPermissionStatus(id),
      getNotebookSettings(id)
    ])
      .then(([savedHistory, savedSession, permissionStatus, notebookSettings]) => {
        // Initialize history appropriately
        if (savedHistory.length > 0) {
          loadHistory(savedHistory);
        } else {
          initializeNewHistory(content);
        }

        // Log ID dedup as metadata changes so they appear in history
        // and get persisted on next save.
        if (renamedIds.length > 0) {
          for (const { newId, oldId } of renamedIds) {
            logOperation({
              type: 'event',
              category: 'system',
              name: 'deduplicateCellId',
              data: { oldId, newId },
              source: 'system',
            });
          }
        }

        // Set agent permission status
        if (permissionStatus) {
          setAgentPermissionStatus(permissionStatus);
        }
        // Set notebook-scoped settings
        setOutputLoggingMode(notebookSettings?.output_logging || 'minimal');
        setIsFullWidth(notebookSettings?.full_width === true);
        // Restore unflushed edit state so undo can capture pending changes
        // Also navigate to the cell with unflushed edits so flushActiveCell works
        if (!evidenceTarget && savedSession.unflushedEdit) {
          setUnflushedState(savedSession.unflushedEdit);
          const cellId = savedSession.unflushedEdit.cellId;
          const cellIndex = content.findIndex(c => c.id === cellId);
          if (cellIndex >= 0) {
            // Enter edit mode - this triggers focus which calls onActivate to set active cell
            // The blur when leaving this cell will flush the unflushed edits
            setPendingFocus({ cellId, mode: 'editor' });
            scrollToCell(cellIndex, { behavior: 'auto' });
          }
        } else if (!evidenceTarget && savedSession.activeCellId) {
          // No unflushed edits, but restore last focused cell position
          const cellId = savedSession.activeCellId;
          const cellIndex = content.findIndex(c => c.id === cellId);
          if (cellIndex >= 0) {
            setActiveCellId(cellId);
            scrollToCell(cellIndex, { behavior: 'auto' });
          }
        }
      })
      .catch((err) => {
        // History/session load failed - initialize new history to allow editing
        console.warn('Failed to load history/session, initializing new:', err);
        initializeNewHistory(content);
      })
      .finally(() => {
        // History is now ready - saves can include history
        setHistoryReady(true);
      });

    const meta = files.find(f => f.id === id);
    if (meta) setCurrentFileMetadata(meta);
    // Base directory for file-path completion (kernel cwd = notebook dir).
    setActiveNotebookPath(id); // file ids are server paths
    // Note: No need to scroll to top - Virtuoso resets when key={currentFileId} changes

    // Sealed evidence is a static rendering target. Do not attach or create a
    // live kernel: execution would produce state that is not part of the seal.
    if (access.read_only) {
      setExecutionQueue([]);
      executionRunIdsRef.current.clear();
      setIsProcessingQueue(false);
      setKernelSessionId(null);
      setKernelStatus('disconnected');
      setIsKernelReady(false);
      return;
    }

    // Resolve kernel/server preference (server is the source of truth)
    let preferredKernel = notebookKernel || currentKernel;
    let preferredServerId = selectedServerId;
    try {
      const preference = await kernelService.getKernelPreference(id);
      if (preference?.kernel_name) {
        preferredKernel = preference.kernel_name;
      }
      if (preference?.server_id) {
        preferredServerId = preference.server_id;
      }
    } catch (error) {
      console.warn('Failed to load kernel preference:', error);
    }

    // Use FRESH cluster info for the checks below. Right after a page refresh
    // the clusterInfo state is often still null (fetched async) — rejecting
    // the preferred server on that race silently sent notebooks back to a
    // local kernel instead of reattaching to their allocation/remote kernel.
    let effectiveClusterInfo = clusterInfo;
    if (!effectiveClusterInfo) {
      try {
        effectiveClusterInfo = await getClusterInfo();
        setClusterInfo(effectiveClusterInfo);
      } catch (error) {
        console.warn('Failed to fetch cluster info for kernel preference check:', error);
      }
    }

    if (preferredServerId) {
      const knownServers = effectiveClusterInfo?.servers ?? [];
      const isPreferredServerKnown =
        preferredServerId === 'local' ||
        preferredServerId === effectiveClusterInfo?.localServerId ||
        knownServers.some(server => server.id === preferredServerId);
      if (!isPreferredServerKnown && effectiveClusterInfo) {
        // Only reject with actual data in hand — the backend re-validates
        // anyway and falls back to a local kernel if the server is truly gone.
        const fallbackServerId = selectedServerId ?? effectiveClusterInfo.localServerId ?? null;
        console.warn(`Ignoring unknown preferred server: ${preferredServerId}`);
        preferredServerId = fallbackServerId;
      }
    }

    let kernelsForCheck = availableKernels;
    if (preferredServerId && preferredServerId !== selectedServerId) {
      setSelectedServerId(preferredServerId);
      try {
        kernelsForCheck = await kernelService.getAvailableKernels(preferredServerId);
        setAvailableKernels(kernelsForCheck);
        // Refresh environments in background for the selected server
        loadPythonEnvironments(false, preferredServerId, false);
      } catch (error) {
        console.error('Failed to load kernels for preferred server:', error);
      }
    }

    // Use preferred kernel and verify it exists. env: kernels don't live in
    // the kernelspec list — the backend validates the interpreter at start.
    let kernelToUse = preferredKernel;
    const kernelExists = isEnvKernelName(kernelToUse) || kernelsForCheck.some(k => k.name === kernelToUse);
    if (!kernelExists && kernelsForCheck.length > 0) {
      // Fall back to first available kernel if the specified one doesn't exist
      kernelToUse = kernelsForCheck[0].name;
    }

    // Update current kernel state to reflect what we're actually using
    if (kernelToUse !== currentKernel) {
      setCurrentKernel(kernelToUse);
    }

    // Login-node guard (see switchKernel): don't silently spin up a kernel on the
    // shared login node when a notebook opens. Ask once; if declined, the notebook
    // opens without a kernel and the user allocates compute when ready.
    {
      const isLocalTarget = !preferredServerId || preferredServerId === effectiveClusterInfo?.localServerId;
      const pref = getSettings().allowLoginNodeKernels;
      if (isLocalTarget && pref !== 'allow' && (computeEnabled || await isLoginNodeReady())) {
        setKernelStatus('disconnected');
        setIsKernelReady(false);
        if (pref !== 'deny') {
          setLoginNodePrompt({ kernelName: kernelToUse, serverId: preferredServerId, keepMenuOpen: true, source: 'user' });
        }
        return;
      }
    }

    // Get or create kernel for this file (one notebook = one kernel)
    try {
      setKernelStatus('starting');
      const { sessionId, created, createdAt, serverId: resolvedServerId, mtime } = await kernelService.getOrCreateKernelForFile(
        id,
        kernelToUse,
        preferredServerId,
      );
      setKernelSessionId(sessionId);
      adoptServerMtime(mtime);
      if (createdAt) setKernelCreatedAt(createdAt);
      if (resolvedServerId && resolvedServerId !== selectedServerId) {
        setSelectedServerId(resolvedServerId);
      }
      if (created) {
        logKernelEvent('startKernel', {
          sessionId,
          kernelName: kernelToUse,
          serverId: resolvedServerId,
          reason: 'auto',
        }, 'system');
      }
      setIsKernelReady(true);
      // Note: Don't set status to 'idle' here - the WebSocket will send the actual status
      // which could be 'busy' if a cell was executing when the page was refreshed

      // Query the kernel's execution count so cell counters continue from where they left off
      // Also get the actual status (could be 'busy' if execution was in progress during refresh)
      const status = await kernelService.getStatus(sessionId);
      if (status) {
        if (status.execution_count != null) {
          setKernelExecutionCount(status.execution_count);
        }
        // Set status from query (WebSocket may also update this, which is fine)
        if (status.status === 'idle' || status.status === 'busy') {
          setKernelStatus(status.status);
        }
      } else {
        // Fallback if status query fails
        setKernelStatus('idle');
      }
    } catch (error) {
      console.error('Failed to get/create kernel for file:', error);
      setKernelStatus('disconnected');
    }
  };

  const loadFile = async (id: string) => {
    setIsLoadingFile(true);
    try {
      const evidenceLink = getEvidenceLinkForFile(id);
      const result = await getFileContentWithMtime(
        id,
        evidenceLink.sealId ? { sealId: evidenceLink.sealId } : {},
      );
      if (result) {
        setLastKnownMtime(result.mtime);
        setPendingSave(false);
        const normalizedId = result.path || id;
        loadFileAsync(
          normalizedId,
          result.cells,
          result.kernelspec,
          id,
          result.access ?? { read_only: false },
          evidenceLink.cellId,
        );
      } else {
        // File doesn't exist or is empty
        setIsLoadingFile(false);
        setCurrentFileId(null);
        setNotebookAccess({ read_only: false });
        evidenceCellHintRef.current = null;
        setLastKnownMtime(null);
        saveActiveFileId('');
      }
    } catch (error) {
      console.error('Failed to load file:', error);
      setIsLoadingFile(false);
      setCurrentFileId(null);
      setNotebookAccess({ read_only: false });
      evidenceCellHintRef.current = null;
      setLastKnownMtime(null);
      saveActiveFileId('');
    }
  };
  loadFileRef.current = loadFile;

  const saveCurrentNotebook = useCallback(async () => {
    // Keyframe: flush active cell before save
    flushActiveCell();
    await saveNow();
    await refreshFileList();
  }, [flushActiveCell, saveNow]);

  // Manual save with confirmation when redo history exists
  // This function is called by both the Save button and Ctrl+S keyboard shortcut
  const handleManualSave = useCallback(async () => {
    if (isSealedReadOnly) return;
    if (canRedo) {
      const confirmed = await confirm({
        title: 'Save will clear redo history',
        message: 'You have undone changes. Saving now will permanently remove your ability to redo those changes.',
        confirmLabel: 'Save Anyway',
        variant: 'warning',
      });
      if (!confirmed) return;
    }

    // Keyframe: flush active cell and commit history before save
    flushActiveCell();
    commitHistoryBeforeKeyframe();
    await saveNow();
    await refreshFileList();
  }, [isSealedReadOnly, canRedo, confirm, flushActiveCell, commitHistoryBeforeKeyframe, saveNow]);

  // Update ref synchronously (useLayoutEffect runs before browser paint and event handlers)
  useLayoutEffect(() => {
    handleManualSaveRef.current = handleManualSave;
  }, [handleManualSave]);

  // --- RESTORE OPERATIONS ---

  // Generate a suggested filename for restored notebook
  const generateRestoredFilename = useCallback((originalPath: string, timestamp: number): string => {
    const date = new Date(timestamp);
    const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = date.toTimeString().slice(0, 5).replace(':', ''); // HHMM

    // Extract directory and filename from path
    const lastSlash = originalPath.lastIndexOf('/');
    const dir = lastSlash >= 0 ? originalPath.slice(0, lastSlash) : '';
    const filename = lastSlash >= 0 ? originalPath.slice(lastSlash + 1) : originalPath;
    const restoreExt = getPathExtension(filename) || '.ipynb';
    const baseName = stripNotebookExtension(filename).replace(/\.py$/i, '');

    return `${dir}/${baseName}_restored_${dateStr}_${timeStr}${restoreExt}`;
  }, []);

  // Handle "Restore Here" - generates new operations to transform current to target state
  const handleRestoreHere = useCallback(async () => {
    if (!restoreDialogTimestamp || !previewCells) return;

    // Flush any pending edits first
    flushActiveCell();
    commitHistoryBeforeKeyframe();

    // Build maps for efficient lookup
    const currentCells = cellsRef.current;
    const currentMap = new Map(currentCells.map((c, i) => [c.id, { cell: c, index: i }]));
    const previewMap = new Map(previewCells.map((c, i) => [c.id, { cell: c, index: i }]));

    // Compute operations needed to transform current → preview
    // Strategy: Use batch of operations to do this atomically

    // 1. Delete cells that don't exist in preview (in reverse order to preserve indices)
    const cellsToDelete: { id: string; index: number }[] = [];
    for (const [id, { index }] of currentMap) {
      if (!previewMap.has(id)) {
        cellsToDelete.push({ id, index });
      }
    }
    // Sort by index descending so we delete from end first
    cellsToDelete.sort((a, b) => b.index - a.index);
    for (const { index } of cellsToDelete) {
      undoableDeleteCell(index);
    }

    // Cells the restore actually changes — pulsed after applying so the user
    // sees where the notebook moved (deleted cells are gone, nothing to pulse).
    const restoredCellIds: string[] = [];

    // 2. Update content for cells that exist in both but have different content
    // Need to re-compute current indices after deletions
    const remainingCells = cellsRef.current.filter(c => previewMap.has(c.id));
    for (const currentCell of remainingCells) {
      const previewData = previewMap.get(currentCell.id);
      if (previewData && (currentCell.content !== previewData.cell.content || currentCell.type !== previewData.cell.type)) {
        restoredCellIds.push(currentCell.id);
        // Update content
        updateContent(currentCell.id, previewData.cell.content);
        // Update type if different
        if (currentCell.type !== previewData.cell.type) {
          changeType(currentCell.id, previewData.cell.type);
        }
      }
    }

    // 3. Insert cells that exist in preview but not in current
    // We need to insert them at the correct positions according to preview order
    const currentCellIds = new Set(cellsRef.current.map(c => c.id));
    const cellsToInsert: { cell: Cell; targetIndex: number }[] = [];
    previewCells.forEach((previewCell, targetIndex) => {
      if (!currentCellIds.has(previewCell.id)) {
        cellsToInsert.push({
          cell: {
            ...previewCell,
            outputs: [], // Don't restore outputs
            isExecuting: false,
          },
          targetIndex
        });
      }
    });

    // Insert in order (adjusting indices as we go)
    let insertionOffset = 0;
    for (const { cell, targetIndex } of cellsToInsert) {
      undoableInsertCell(targetIndex + insertionOffset, cell);
      restoredCellIds.push(cell.id);
      insertionOffset++;
    }

    // Clear preview mode and close dialog
    setPreviewTimestamp(null);
    setRestoreDialogTimestamp(null);

    if (restoredCellIds.length > 0) {
      showUndoRedoFeedback(restoredCellIds);
    }

    toast('Notebook restored to previous state', 'success', 2000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreDialogTimestamp, previewCells, flushActiveCell, commitHistoryBeforeKeyframe, undoableDeleteCell, updateContent, changeType, undoableInsertCell, showUndoRedoFeedback, toast]); // uses cellsRef

  // Handle "Save as New File" - creates new file with truncated history
  const handleSaveAsNew = useCallback(async () => {
    if (!restoreDialogTimestamp || !previewCells || !currentFileId) return;

    try {
      // Generate new filename
      const newPath = generateRestoredFilename(currentFileId, restoreDialogTimestamp);

      // Get truncated history (all entries up to and including target timestamp)
      const fullHistory = getFullHistory();
      const truncatedHistory = fullHistory.filter(entry => entry.timestamp <= restoreDialogTimestamp);

      // Find cells that were executed after restore point - their outputs are stale
      const cellsExecutedAfter = new Set<string>();
      for (const entry of fullHistory) {
        if (entry.timestamp <= restoreDialogTimestamp) continue;
        const isRunCell = entry.type === 'runCell' ||
          (entry.type === 'event' && (entry as any).name === 'runCell');
        if (!isRunCell) continue;
        const cellId = entry.type === 'event' ? (entry as any).target?.cellId : (entry as any).cellId;
        if (cellId) cellsExecutedAfter.add(cellId);
      }

      // Preserve outputs for cells that weren't re-executed after restore point
      const cellsToSave = previewCells.map(cell => {
        const currentCell = currentCellMap.get(cell.id);

        // If cell exists in current state and wasn't re-run, preserve its outputs
        if (currentCell && !cellsExecutedAfter.has(cell.id)) {
          return { ...cell, outputs: currentCell.outputs, isExecuting: false };
        }

        // Otherwise clear outputs (cell was re-run or doesn't exist)
        return { ...cell, outputs: [], isExecuting: false };
      });

      // Save the new notebook with truncated history
      await saveNotebookCells(newPath, cellsToSave, currentKernel || undefined, truncatedHistory);

      // Also save the history file separately (in case the combined save doesn't handle it)
      await saveNotebookHistory(newPath, truncatedHistory);

      // Clear preview mode and close dialog
      setPreviewTimestamp(null);
      setRestoreDialogTimestamp(null);

      // Refresh file list to show new file
      await refreshFileList();

      toast(`Saved restored notebook to ${newPath.split('/').pop()}`, 'success', 3000);
    } catch (error) {
      console.error('Failed to save restored notebook:', error);
      toast('Failed to save restored notebook', 'error');
    }
  }, [restoreDialogTimestamp, previewCells, currentFileId, currentCellMap, generateRestoredFilename, getFullHistory, currentKernel, toast, refreshFileList]);

  const handleResetHistory = useCallback(async () => {
    if (!currentFileId || isSealedReadOnly) return;
    if (!historyReady) {
      toast('History is still loading', 'info', 2000);
      return;
    }

    const confirmed = await confirm({
      title: 'Reset history',
      message: 'This will clear the entire history and undo/redo stack, replacing it with a single snapshot of the current notebook. This cannot be undone.',
      confirmLabel: 'Reset History',
      variant: 'danger',
    });
    if (!confirmed) return;

    // Resetting history invalidates preview/restore contexts.
    setPreviewTimestamp(null);
    setRestoreDialogTimestamp(null);
    setUnflushedState(null);

    // Spread to avoid React bailing out on identical array references.
    initializeNewHistory([...cellsRef.current]);

    const newHistory = getFullHistory();
    const savedHistory = await saveNotebookHistory(currentFileId, newHistory);
    const savedSession = await saveNotebookSession(currentFileId, {
      activeCellId: activeCellIdRef.current ?? undefined,
    });

    if (savedHistory && savedSession) {
      toast('History reset', 'success', 2000);
      return;
    }
    if (!savedHistory) {
      toast('Failed to persist history reset', 'error');
      return;
    }
    toast('History reset, but failed to persist session state', 'warning', 2500);
  }, [
    currentFileId,
    isSealedReadOnly,
    historyReady,
    confirm,
    toast,
    setUnflushedState,
    initializeNewHistory,
    getFullHistory,
  ]);

  // Toggle agent permission for the notebook
  const handleToggleAgentPermission = useCallback(async () => {
    if (!currentFileId || isSealedReadOnly) return;

    const newPermitted = !agentPermissionStatus?.agent_permitted;
    const result = await setAgentPermission(currentFileId, newPermitted);
    if (result) {
      setAgentPermissionStatus(result);
      // The flag was written into the notebook file on the server — adopt
      // the new mtime or the next autosave shows a false conflict dialog.
      adoptServerMtime(result.mtime);
      if (newPermitted && !result.has_history) {
        // Without history there's no undo trail, so agent edits stay blocked
        // until the first human edit initializes it. Say so out loud — this
        // gate used to hide in a tooltip and read as "agent silently broken".
        toast('Agent enabled — it can start editing after your first edit to this notebook (that starts the undo history that makes agent changes reversible)', 'info', 8000);
      } else {
        toast(
          newPermitted ? 'Agent can now modify this notebook' : 'Agent access revoked',
          'info',
          2000
        );
      }
    } else {
      toast('Failed to update agent permission', 'error');
    }
  }, [currentFileId, isSealedReadOnly, agentPermissionStatus, toast]);

  const handleToggleOutputLogging = useCallback(async () => {
    if (!currentFileId || isSealedReadOnly) return;

    const newMode: OutputLoggingMode = outputLoggingMode === 'minimal' ? 'full' : 'minimal';
    const result = await updateNotebookSettings(currentFileId, { output_logging: newMode });
    if (result) {
      setOutputLoggingMode(result.output_logging);
      adoptServerMtime(result.mtime);
      toast(
        newMode === 'full' ? 'Full output logging enabled' : 'Minimal output logging enabled',
        'info',
        2000
      );
    } else {
      toast('Failed to update output logging mode', 'error');
    }
  }, [currentFileId, isSealedReadOnly, outputLoggingMode, toast]);

  const handleToggleFullWidth = useCallback(async () => {
    if (!currentFileId || isSealedReadOnly) return;

    const nextFullWidth = !isFullWidth;
    setIsFullWidth(nextFullWidth);

    const result = await updateNotebookSettings(currentFileId, { full_width: nextFullWidth });
    if (result) {
      setIsFullWidth(result.full_width);
      adoptServerMtime(result.mtime);
      return;
    }

    setIsFullWidth(!nextFullWidth);
    toast('Failed to update notebook width mode', 'error');
  }, [currentFileId, isSealedReadOnly, isFullWidth, toast, setLastKnownMtime]);

  // --- KERNEL OPERATIONS ---

  const switchKernel = async (
    kernelName: string,
    serverId?: string | null,
    keepMenuOpen = false,
    source: EditSource = 'user',
    bypassLoginNodeGate = false
  ): Promise<{ success: boolean; sessionId?: string; kernelName?: string; error?: string; code?: string }> => {
    if (isSealedReadOnly) {
      return { success: false, error: 'Sealed evidence is read-only', code: 'sealed_read_only' };
    }
    // Use provided serverId or fall back to currently selected server
    const targetServerId = serverId !== undefined ? serverId : selectedServerId;

    // Login-node guard: on a scheduler node, a kernel on the shared local (login)
    // server competes with other users' work. Ask once, remember the choice.
    if (!bypassLoginNodeGate) {
      const isLocalTarget = !targetServerId || targetServerId === clusterInfo?.localServerId;
      const pref = getSettings().allowLoginNodeKernels;
      if (isLocalTarget && pref !== 'allow' && (computeEnabled || await isLoginNodeReady())) {
        if (!keepMenuOpen) setIsKernelMenuOpen(false);
        if (pref === 'deny') {
          setShowComputeModal(true);
          toast('This is a login node — allocate compute to run a kernel here.', 'info', 6000);
        } else {
          setLoginNodePrompt({ kernelName, serverId, keepMenuOpen, source });
        }
        return { success: false, error: 'login-node kernel gated' };
      }
    }

    if (!keepMenuOpen) {
      setIsKernelMenuOpen(false);
    }
    setKernelStatus('starting');
    setIsKernelReady(false);
    setCurrentKernel(kernelName); // Update name immediately so UI shows new kernel with "starting" status
    setKernelSelectionRequired(false);

    try {
      let startedSessionId: string | undefined;
      let startedNewKernel = true;
      // Use getOrCreateKernelForFile which handles kernel switching on the backend
      // (it will stop the old kernel if kernel type differs)
      if (currentFileId) {
        const { sessionId: newSessionId, created, createdAt, serverId: resolvedServerId, mtime } = await kernelService.getOrCreateKernelForFile(
          currentFileId,
          kernelName,
          targetServerId
        );
        startedSessionId = newSessionId;
        startedNewKernel = created !== false;
        setKernelSessionId(newSessionId);
        adoptServerMtime(mtime);
        if (createdAt) setKernelCreatedAt(createdAt);
        if (resolvedServerId && resolvedServerId !== selectedServerId) {
          setSelectedServerId(resolvedServerId);
        }
        if (created) {
          logKernelEvent('startKernel', {
            sessionId: newSessionId,
            kernelName,
            serverId: resolvedServerId,
            reason: kernelSessionId ? 'switch' : 'start',
          }, source);
        }
      } else {
        // No file open, just start a standalone kernel
        if (kernelSessionId) {
          await kernelService.stopKernel(kernelSessionId);
        }
        const newSessionId = await kernelService.startKernel(kernelName, undefined, undefined, targetServerId);
        startedSessionId = newSessionId;
        setKernelSessionId(newSessionId);
        logKernelEvent('startKernel', {
          sessionId: newSessionId,
          kernelName,
          serverId: targetServerId,
          reason: kernelSessionId ? 'switch' : 'start',
        }, source);
      }
      setIsKernelReady(true);
      setKernelStatus('idle');
      if (startedNewKernel) {
        // Reset execution counter since it's a new kernel
        setCells(prev => prev.map(c => ({ ...c, executionCount: undefined })));
        setKernelExecutionCount(0);
      } else if (startedSessionId) {
        // Reused the existing kernel (e.g. reselecting the same kernel, or a
        // backend kernelChanged sync after a refresh) — restore its counter
        // instead of wiping it. Jupyter convention: [n] belongs to the kernel
        // and only resets when the kernel itself restarts.
        kernelService.getStatus(startedSessionId)
          .then(s => { if (s && s.execution_count != null) setKernelExecutionCount(s.execution_count); })
          .catch(() => { /* transient — the next execute reports the true count */ });
      }
      saveSettings({ lastKernel: kernelName });
      return { success: true, sessionId: startedSessionId, kernelName: kernelName || undefined, error: undefined };
    } catch (error) {
      console.error('Failed to switch kernel:', error);
      setKernelStatus('disconnected');
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        // Preserve the provisioning code (needs_ipykernel, …) so callers can
        // open the install prompt instead of showing a raw error.
        code: error instanceof KernelProvisionError ? error.code : undefined,
      };
    }
  };
  syncKernelFromBackendRef.current = async (kernelName: string, serverId?: string | null) => {
    // Sync the UI to a kernel the agent/CLI ALREADY started — bypass the login-node
    // allocation gate. That gate is for user-initiated kernel starts; re-applying it on
    // this sync path popped the compute-allocation modal on every agent kernel op (and
    // never let it close), and its early "gated" return also blocked the kernel-name sync.
    await switchKernel(kernelName, serverId, true, 'mcp', true);
  };

  // Select a Python environment as the kernel. Raw launch (VSCode-style):
  // envs with ipykernel start directly via env:<path> — no registration step.
  // A registered kernelspec for the same interpreter is preferred, purely so
  // existing sessions/metadata keep their names. Envs without ipykernel get
  // the install prompt ("requires the ipykernel package → Install").
  const handleEnvClick = async (env: PythonEnvironment, registeredName?: string) => {
    if (registeredName) {
      switchKernel(registeredName);
      return;
    }
    if (!env.has_ipykernel) {
      setIpykernelInstallError(null);
      setIpykernelPrompt(env);
      return;
    }
    const result = await switchKernel(envKernelName(env.path));
    if (result.code === 'needs_ipykernel') {
      // Discovery cache said ipykernel was there but the live preflight
      // disagreed — trust reality: open the install prompt and refresh.
      setIpykernelInstallError(null);
      setIpykernelPrompt({ ...env, has_ipykernel: false });
      loadPythonEnvironments(true, selectedServerId, false);
      return;
    }
    if (!result.success && result.error !== 'login-node kernel gated') {
      toast(`Failed to start kernel: ${result.error}`, 'error', 8000);
    }
  };

  // Probe a manually-entered interpreter path; the backend validates it,
  // remembers it in the discovery cache, and returns the enriched env — then
  // it goes through the same click flow (launch, or install prompt).
  const submitManualPath = async () => {
    const p = manualPath.trim();
    if (!p || isProbingPath) return;
    setIsProbingPath(true);
    try {
      const env = await kernelService.probePythonPath(p, selectedServerId);
      setPythonEnvironments(prev => [env, ...prev.filter(e => e.path !== env.path)]);
      setManualPathOpen(false);
      setManualPath('');
      await handleEnvClick(env);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      toast(`Could not use interpreter: ${detail}`, 'error', 8000);
    } finally {
      setIsProbingPath(false);
    }
  };

  // Install ipykernel via the backend (one installer, chosen there), then
  // launch the env as a kernel. Failure keeps the modal open and shows the
  // installer's actual output plus a copyable manual command — no retries
  // behind the user's back.
  const installIpykernelForEnv = async (env: PythonEnvironment) => {
    setIsInstallingIpykernel(true);
    setIpykernelInstallError(null);
    setIpykernelInstallOutput('');
    try {
      const result = await kernelService.installIpykernel(
        env.path,
        selectedServerId,
        (chunk) => setIpykernelInstallOutput(prev => prev + chunk)
      );
      setIpykernelPrompt(null);
      toast(`ipykernel installed via ${result.installer} — starting kernel…`, 'success', 5000);
      // Refresh the picker's env list in the background; launch right away.
      loadPythonEnvironments(true, selectedServerId, false);
      const switched = await switchKernel(envKernelName(env.path));
      if (!switched.success && switched.error !== 'login-node kernel gated') {
        toast(`ipykernel installed, but the kernel failed to start: ${switched.error}`, 'error', 8000);
      }
    } catch (error) {
      // Failure keeps the modal open: the streamed output above the error box
      // shows exactly what the installer did before it died.
      if (error instanceof KernelProvisionError) {
        setIpykernelInstallError({ message: error.message, hint: error.installHint });
      } else {
        setIpykernelInstallError({ message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      setIsInstallingIpykernel(false);
    }
  };

  // Copy the ecosystem-specific install command for users who prefer to run
  // it themselves (or must — PEP 668 envs, offline nodes). The Install button
  // is the primary path; this is the manual alternative.
  const copyInstallHint = useCallback(async (env: PythonEnvironment) => {
    const hint = env.install_hint || `"${env.path}" -m pip install ipykernel`;
    let copied = false;
    try { await navigator.clipboard.writeText(hint); copied = true; } catch { /* clipboard optional */ }
    toast(
      `${copied ? 'Copied' : 'Run'}: ${hint}  —  then click Refresh and Register.`,
      'info',
      10000
    );
  }, [toast]);

  /**
   * Switch to a different server for kernel execution
   * This loads the available kernels for the new server but does NOT start a kernel.
   * User must manually select a kernel from the menu.
   */
  const switchServer = async (serverId: string) => {
    if (serverId === selectedServerId) return; // No change

    setSelectedServerId(serverId);
    // Clear current kernel selection so user explicitly chooses from new server
    setCurrentKernel('');
    setKernelSelectionRequired(true);
    setKernelStatus('disconnected');
    setIsKernelReady(false);

    try {
      // Load environments without auto-selecting a kernel - user must choose
      loadPythonEnvironments(false, serverId, false);
    } catch (error) {
      console.error('Failed to load kernels for server:', error);
    }

    // Stop the current kernel if it exists (we're switching servers)
    if (kernelSessionId) {
      try {
        await kernelService.stopKernel(kernelSessionId);
        logKernelEvent('shutdownKernel', { sessionId: kernelSessionId, reason: 'switchServer' }, 'user');
      } catch (e) {
        console.error('Failed to stop kernel:', e);
      }
      setKernelSessionId(null);
      setKernelStatus('disconnected');
      setIsKernelReady(false);
    }
    // Menu stays open so user can choose a kernel on the new server
  };

  const isRestartingKernelRef = useRef(false);

  const restartKernel = async (
    source: EditSource = 'user'
  ): Promise<{ success: boolean; sessionId?: string; error?: string }> => {
    setIsKernelMenuOpen(false);
    // Pending flag: rapid clicks would queue overlapping restarts, each
    // killing the other's freshly spawned kernel.
    if (isRestartingKernelRef.current) {
      return { success: false, error: 'Restart already in progress' };
    }
    isRestartingKernelRef.current = true;
    setKernelStatus('starting');

    if (!kernelSessionId) {
      setKernelStatus('disconnected');
      return { success: false, error: 'No kernel session to restart' };
    }

    try {
      await kernelService.restartKernel(kernelSessionId);
      setKernelStatus('idle');
      // Reset execution counter but preserve outputs
      setCells(prev => prev.map(c => ({ ...c, executionCount: undefined })));
      setKernelExecutionCount(0);
      // Log kernel restart for history
      logKernelEvent('restartKernel', kernelSessionId ? { sessionId: kernelSessionId } : undefined, source);
      return { success: true, sessionId: kernelSessionId ?? undefined };
    } catch (error) {
      console.error('Failed to restart kernel:', error);
      // If session not found, start a fresh kernel
      if (error instanceof Error && error.message.includes('Session not found')) {
        console.log('[Notebook] Session not found, starting fresh kernel');
        try {
          // Clear stale session
          setKernelSessionId(null);
          // Start a new kernel (use getOrCreateKernelForFile if file is open)
          const kernelToUse = currentKernel || 'python3';
          let newSessionId: string;
          if (currentFileId) {
            const result = await kernelService.getOrCreateKernelForFile(currentFileId, kernelToUse, selectedServerId);
            newSessionId = result.sessionId;
            adoptServerMtime(result.mtime);
            if (result.createdAt) setKernelCreatedAt(result.createdAt);
            if (result.serverId && result.serverId !== selectedServerId) {
              setSelectedServerId(result.serverId);
            }
          } else {
            newSessionId = await kernelService.startKernel(kernelToUse);
          }
          setKernelSessionId(newSessionId);
          setKernelStatus('idle');
          setIsKernelReady(true);
          setCells(prev => prev.map(c => ({ ...c, executionCount: undefined })));
          setKernelExecutionCount(0);
          logKernelEvent('restartKernel', newSessionId ? { sessionId: newSessionId } : undefined, source);
          return { success: true, sessionId: newSessionId };
        } catch (startError) {
          console.error('Failed to start fresh kernel:', startError);
        }
      }
      setKernelStatus('disconnected');
      const message = error instanceof Error ? error.message : String(error);
      toast(`Kernel restart failed: ${message}`, 'error', 5000);
      return { success: false, error: message };
    } finally {
      isRestartingKernelRef.current = false;
    }
  };

  const shutdownKernel = async (
    source: EditSource = 'user'
  ): Promise<{ success: boolean; sessionId?: string; error?: string }> => {
    setIsKernelMenuOpen(false);
    if (!kernelSessionId) {
      return { success: false, error: 'No kernel session to shutdown' };
    }

    try {
      await kernelService.stopKernel(kernelSessionId);
      logKernelEvent('shutdownKernel', { sessionId: kernelSessionId }, source);
    } catch (error) {
      console.error('Failed to shutdown kernel:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      setKernelSessionId(null);
      setKernelStatus('disconnected');
      setIsKernelReady(false);
      setMemoryUsage(null);
    }
    return { success: true, sessionId: kernelSessionId ?? undefined };
  };

  const interruptKernel = async (
    source: EditSource = 'user'
  ): Promise<{ success: boolean; sessionId?: string; error?: string }> => {
    if (!kernelSessionId) {
      return { success: false, error: 'No kernel session to interrupt' };
    }

    try {
      if (kernelSessionId) {
        await kernelService.interruptKernel(kernelSessionId);
      }
      setExecutionQueue([]);
      setIsProcessingQueue(false);
      setCells(prev => prev.map(c => ({ ...c, isExecuting: false })));
      // Log kernel interrupt for history
      logKernelEvent('interruptKernel', kernelSessionId ? { sessionId: kernelSessionId } : undefined, source);
      return { success: true, sessionId: kernelSessionId ?? undefined };
    } catch (error) {
      console.error('Failed to interrupt kernel:', error);
      const message = error instanceof Error ? error.message : String(error);
      toast(`Kernel interrupt failed: ${message}`, 'error', 4000);
      return { success: false, error: message };
    }
  };

  kernelOpsRef.current = {
    startKernel: async (kernelName?: string, source: EditSource = 'user') => {
      const nameToUse = kernelName || currentKernel || 'python3';
      return switchKernel(nameToUse, undefined, true, source);
    },
    shutdownKernel,
    restartKernel,
    interruptKernel,
  };

  // --- CELL OPERATIONS ---

  const addCell = (type: CellType = 'code', content: string = '', afterIndex?: number, noScroll?: boolean | 'cell' | 'editor') => {
    if (isSealedReadOnly) return;
    // Keyframe: flush active cell before insert
    flushActiveCell();

    const currentCells = cellsRef.current;
    const existingIds = new Set(currentCells.map(c => c.id));
    let newId = generateCellId();
    while (existingIds.has(newId)) {
      newId = generateCellId();
    }

    const newCell: Cell = {
      id: newId,
      type,
      content,
      outputs: [],
      isExecuting: false
    };

    // Calculate insertion index
    const insertIndex = (() => {
      if (afterIndex === undefined) return currentCells.length;
      if (afterIndex < 0) return 0;
      if (afterIndex >= currentCells.length) return currentCells.length;
      return afterIndex + 1;
    })();

    undoableInsertCell(insertIndex, newCell);
    setActiveCellId(newCell.id);

    // Handle focus mode if provided (for Shift+Enter creating new cell)
    const focusMode = typeof noScroll === 'string' ? noScroll : null;
    const shouldScroll = noScroll !== true && typeof noScroll !== 'string';

    if (focusMode) {
      // Set pending focus for the new cell
      setPendingFocus({ cellId: newCell.id, mode: focusMode });
      // Cell-mode focus uses preventScroll; bring the new cell into view only
      // when it isn't visible (same conditional-scroll path as undo/redo).
      if (focusMode === 'cell') {
        pendingScrollCellIdRef.current = newCell.id;
      }
    }

    // Only scroll if not explicitly disabled (e.g., toolbar plus button shouldn't scroll)
    if (shouldScroll) {
      scrollToCell(insertIndex);
    }
  };

  const handleAddCell = (type: CellType) => {
    const index = activeCellId ? cells.findIndex(c => c.id === activeCellId) : -1;
    if (index !== -1) {
      addCell(type, '', index);
    } else {
      addCell(type);
    }
  };

  const handleInsertCode = (code: string, targetIndex?: number) => {
    let indexToInsert = -1;
    if (targetIndex !== undefined) {
      indexToInsert = targetIndex;
    } else if (activeCellId) {
      indexToInsert = cells.findIndex(c => c.id === activeCellId);
    } else {
      indexToInsert = cells.length - 1;
    }

    addCell('code', code, indexToInsert);
  };

  // Text edits - not individually undoable (too many operations)
  // Use setCells directly for per-keystroke updates
  // Note: We previously used startTransition here, but it caused a bug where deferred
  // state updates would overwrite CodeMirror's current content when typing fast.
  // CodeMirror renders synchronously, so we don't need startTransition for perceived performance.
  const handleUpdateCell = useCallback((id: string, content: string) => {
    if (isSealedReadOnly) return;
    // First edit while redo stack is non-empty is a keyframe
    // This commits the redo history before the new edit timeline begins
    if (hasRedoToFlush()) {
      flushCell(id, content);
    }
    setCells(prev => prev.map(c => c.id === id ? { ...c, content } : c));
  }, [isSealedReadOnly, setCells, hasRedoToFlush, flushCell]);

  // AI/bulk update with undo tracking - for AI edits, annotated as AI source
  const handleAIUpdateCell = useCallback((id: string, content: string) => {
    if (isSealedReadOnly) return;
    updateContentAI(id, content);
  }, [isSealedReadOnly, updateContentAI]);

  // Edit cell from copilot sidebar - also AI-generated content
  const handleEditCell = (index: number, newContent: string) => {
    if (index >= 0 && index < cells.length) {
      updateContentAI(cells[index].id, newContent);
    }
  };

  // Handle cell click - set as active cell
  const handleCellClick = useCallback((id: string, event: React.MouseEvent) => {
    // Shift+click — select the contiguous range from the current cell
    if (event.shiftKey && !(event.target as HTMLElement | null)?.closest('.cm-editor')) {
      const anchorId = selectionAnchorRef.current ?? activeCellIdRef.current;
      if (anchorId && anchorId !== id) {
        event.preventDefault();
        selectCellRange(anchorId, id);
        setActiveCellId(id);
        window.getSelection()?.removeAllRanges();
        return;
      }
    }

    // Plain click — clear any multi-cell selection and reset the range anchor
    clearCellSelection();
    selectionAnchorRef.current = id;
    setActiveCellId(id);

    // Clicking outside an editor should clear old DOM text ranges from other cells.
    const clickTarget = event.target as HTMLElement | null;
    if (clickTarget?.closest('.cm-editor')) return;

    const clickedCell = event.currentTarget as HTMLElement | null;
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && selection.toString().length > 0) {
      const selectionRange = selection.getRangeAt(0);
      const selectionIsInsideClickedCell = clickedCell?.contains(selectionRange.commonAncestorContainer) ?? false;
      if (selectionIsInsideClickedCell) {
        return;
      }
      selection.removeAllRanges();
    }
  }, [setActiveCellId, selectCellRange, clearCellSelection]);

  const handleDeleteCellByIndex = async (index: number) => {
    if (index >= 0 && index < cells.length) {
      // Capture cell ID before async operation to avoid race condition
      const cellId = cells[index].id;
      const confirmed = await confirm({
        title: 'Delete Cell',
        message: `Are you sure you want to delete Cell #${index + 1}?`,
        confirmLabel: 'Delete',
        variant: 'danger',
      });
      if (confirmed) {
        deleteCell(cellId);
      }
    }
  };

  const changeCellType = (id: string, type: CellType) => {
    if (isSealedReadOnly) return;
    // Keyframe: flush active cell before type change
    flushActiveCell();
    changeType(id, type);
  };

  const deleteCell = (id: string) => {
    if (isSealedReadOnly) return;
    // Keyframe: flush active cell before delete
    flushActiveCell();

    const currentCells = cellsRef.current;

    // Can't delete the last cell - clear it instead
    if (currentCells.length <= 1) {
      updateContent(currentCells[0].id, '');
      setActiveCellId(currentCells[0].id);
      return;
    }

    const idx = currentCells.findIndex(c => c.id === id);
    if (idx === -1) return;

    // Find the next cell to select after deletion
    const nextCellId = currentCells[Math.min(idx + 1, currentCells.length - 1) === idx
      ? Math.max(idx - 1, 0)
      : Math.min(idx + 1, currentCells.length - 1)]?.id;

    undoableDeleteCell(idx);

    if (nextCellId && nextCellId !== id) {
      setActiveCellId(nextCellId);
    }
  };
  // Update refs for keyboard shortcut handler
  deleteCellRef.current = deleteCell;
  addCellRef.current = addCell;
  changeCellTypeRef.current = changeCellType;
  kernelStatusRef.current = kernelStatus;
  kernelSessionIdRef.current = kernelSessionId;
  interruptKernelRef.current = interruptKernel;
  restartKernelFnRef.current = restartKernel;
  undoFnRef.current = undo;
  redoFnRef.current = redo;

  const moveCell = (id: string, direction: 'up' | 'down') => {
    if (isSealedReadOnly) return;
    // Keyframe: flush active cell before move
    flushActiveCell();

    // Use ref to avoid stale closure — Cell memo doesn't re-render on
    // callback changes, so this function may run with an old cells array.
    const currentCells = cellsRef.current;
    const idx = currentCells.findIndex(c => c.id === id);
    if (idx === -1) return;
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === currentCells.length - 1) return;

    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    undoableMoveCell(idx, targetIdx);

    // Don't auto-scroll for move operations - the cell only moves by one position
    // and typically stays visible. Auto-scrolling causes flickering due to
    // race conditions between state updates and scroll calculations.
    // User can manually scroll if needed.
  };

  // Drag-and-drop reorder: move a cell to an arbitrary position (single undo step)
  const reorderCellTo = useCallback((draggedId: string, targetId: string, position: 'above' | 'below') => {
    if (isSealedReadOnly) return;
    flushActiveCell();

    const currentCells = cellsRef.current;
    const fromIdx = currentCells.findIndex(c => c.id === draggedId);
    const targetIdx = currentCells.findIndex(c => c.id === targetId);
    if (fromIdx === -1 || targetIdx === -1) return;

    let toIdx = position === 'above' ? targetIdx : targetIdx + 1;
    if (fromIdx < toIdx) toIdx -= 1; // removing the dragged cell shifts later indices
    if (toIdx === fromIdx) return;

    undoableMoveCell(fromIdx, toIdx);
    setActiveCellId(draggedId);
  }, [isSealedReadOnly, flushActiveCell, undoableMoveCell]);

  const updateCellOutputs = (id: string, newOutputs: any[], isExec: boolean) => {
    setCells(prev => prev.map(c => c.id === id ? { ...c, outputs: newOutputs, isExecuting: isExec } : c));
  };

  const createRunId = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };

  const queueExecution = (id: string) => {
    if (isSealedReadOnly) return;
    // Keyframe: flush active cell before execution
    flushActiveCell();

    // Check if already in queue (idempotent - safe to call multiple times)
    if (executionQueueRef.current.includes(id)) {
      if (!executionRunIdsRef.current.has(id)) {
        executionRunIdsRef.current.set(id, createRunId());
      }
      return;
    }

    const runId = createRunId();
    executionRunIdsRef.current.set(id, runId);
    setExecutionQueue(prev => [...prev, id]);
    // Log cell run for history
    // Note: content is NOT stored here - it's reconstructed from edit history + snapshot
    const cellIndex = cells.findIndex(c => c.id === id);
    if (cellIndex >= 0) {
      logOperation({
        type: 'event',
        category: 'execution',
        name: 'runCell',
        target: { cellId: id, cellIndex },
        runId,
      });
    }
  };

  const runAndAdvance = (id: string, focusMode: 'cell' | 'editor') => {
    queueExecution(id);
    const currentIndex = cells.findIndex(c => c.id === id);
    if (currentIndex < cells.length - 1) {
      // Move to next cell and scroll to it
      const nextIndex = currentIndex + 1;
      const nextCellId = cells[nextIndex].id;
      setActiveCellId(nextCellId);
      scrollToCell(nextIndex, { delay: 50, retryOnce: true });
      // Set pending focus - will poll for DOM element after virtualization renders
      setPendingFocus({ cellId: nextCellId, mode: focusMode });
    } else {
      // Create new cell at the end with focus mode
      addCell('code', '', currentIndex, focusMode);
    }
  };

  // Update refs for keyboard shortcut handler
  runAndAdvanceRef.current = runAndAdvance;
  queueExecutionRef.current = queueExecution;

  const handleRunAllCells = useCallback(() => {
    if (isSealedReadOnly) return;
    logOperation({
      type: 'event',
      category: 'execution',
      name: 'runAllCells',
      data: { cellCount: cellStats.codeCount },
    });
    cellsRef.current.forEach(c => queueExecution(c.id));
  }, [isSealedReadOnly, cellStats.codeCount, logOperation, queueExecution]);

  // Jupyter-style directional runs relative to the active cell:
  // "above" is exclusive, "and below" includes the active cell.
  const handleRunCellsAbove = useCallback(() => {
    if (isSealedReadOnly) return;
    const currentCells = cellsRef.current;
    const activeIndex = currentCells.findIndex(c => c.id === activeCellIdRef.current);
    if (activeIndex <= 0) return;
    logOperation({
      type: 'event',
      category: 'execution',
      name: 'runCellsAbove',
      data: { cellCount: activeIndex },
    });
    currentCells.slice(0, activeIndex).forEach(c => queueExecution(c.id));
  }, [isSealedReadOnly, logOperation, queueExecution]);

  const handleRunCellsBelow = useCallback(() => {
    if (isSealedReadOnly) return;
    const currentCells = cellsRef.current;
    const activeIndex = currentCells.findIndex(c => c.id === activeCellIdRef.current);
    if (activeIndex === -1) return;
    logOperation({
      type: 'event',
      category: 'execution',
      name: 'runCellsBelow',
      data: { cellCount: currentCells.length - activeIndex },
    });
    currentCells.slice(activeIndex).forEach(c => queueExecution(c.id));
  }, [isSealedReadOnly, logOperation, queueExecution]);

  // Navigate to a specific cell (used by search)
  const navigateToCell = useCallback((_cellIndex: number, cellId: string) => {
    setActiveCellId(cellId);
    // Always scroll to the target cell. Checking isCellVisibleInViewport
    // calls getBoundingClientRect which forces synchronous layout on
    // content-visibility-skipped cells. scrollIntoView is cheap and
    // no-ops if the cell is already visible.
    const currentIndex = cellsRef.current.findIndex(c => c.id === cellId);
    if (currentIndex !== -1) {
      scrollToCell(currentIndex, { behavior: 'auto' });
    }
  }, [scrollToCell]);

  // Navigate to adjacent cell with virtualization support (used by arrow keys in cell mode)
  const navigateCellRelative = useCallback((fromCellId: string, direction: 'up' | 'down') => {
    const currentCells = cellsRef.current;
    const currentIndex = currentCells.findIndex(c => c.id === fromCellId);
    if (currentIndex === -1) return;

    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= currentCells.length) return;

    const targetCellId = currentCells[targetIndex].id;
    clearCellSelection(); // plain arrow navigation collapses any multi-cell selection
    setActiveCellId(targetCellId);
    scrollToCell(targetIndex, { delay: 50, retryOnce: true });
    setPendingFocus({ cellId: targetCellId, mode: 'cell' });
  }, [scrollToCell, clearCellSelection]);

  // Arrow past the first/last line of a cell's editor → continue editing in
  // the adjacent cell (Jupyter behavior). Code cells get editor focus;
  // markdown cells in preview stay rendered and get command-mode focus.
  const handleEditorBoundaryNavigate = useCallback((fromCellId: string, direction: 'up' | 'down') => {
    const currentCells = cellsRef.current;
    const currentIndex = currentCells.findIndex(c => c.id === fromCellId);
    if (currentIndex === -1) return;

    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= currentCells.length) return;

    const targetCell = currentCells[targetIndex];
    setActiveCellId(targetCell.id);
    scrollToCell(targetIndex, { delay: 50, retryOnce: true });
    setPendingFocus({ cellId: targetCell.id, mode: targetCell.type === 'code' ? 'editor' : 'cell' });
  }, [scrollToCell]);

  // Handle search query changes for highlighting
  // ⚠️ PERFORMANCE: Split search state to avoid re-rendering all 700+ cells
  // when navigating between matches (prev/next).
  //
  // searchQuery (query/caseSensitive/useRegex) → changes rarely (typing) → triggers Cell re-render
  // searchCurrentMatch → changes often (next/prev) → only the affected cell re-renders
  //
  // Cell memo compares searchHighlight by reference. By keeping the same
  // searchQuery object when only the current match changes, most cells skip re-render.
  const [searchCurrentMatch, setSearchCurrentMatch] = useState<{
    cellId: string; startIndex: number; endIndex: number;
  } | null>(null);

  // Debounce search query updates to cells. Navigating matches is instant
  // (only 2 cells re-render), but changing the query text triggers a
  // re-render of ALL cells (to rebuild search decorations). Debouncing
  // avoids 700-cell re-renders on every keystroke.
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchChange = useCallback((
    query: string,
    caseSensitive: boolean,
    useRegex: boolean,
    currentMatch: { cellId: string; startIndex: number; endIndex: number } | null
  ) => {
    // Always update current match instantly (only 2 cells re-render)
    setSearchCurrentMatch(currentMatch);

    // Clear pending debounce
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);

    if (!query) {
      setSearchQuery(null);
      return;
    }

    // Check if query/options actually changed
    setSearchQuery(prev => {
      if (prev && prev.query === query && prev.caseSensitive === caseSensitive && prev.useRegex === useRegex) {
        return prev; // same reference — Cell memo skips re-render
      }
      // Query changed — debounce the update so typing doesn't re-render 700 cells per keystroke
      return prev; // return prev for now, debounced update below
    });

    // Debounced + transition: update query after typing stops.
    // startTransition lets React yield between cell renders so the UI stays responsive.
    searchDebounceRef.current = setTimeout(() => {
      startTransition(() => {
        setSearchQuery(prev => {
          if (prev && prev.query === query && prev.caseSensitive === caseSensitive && prev.useRegex === useRegex) {
            return prev;
          }
          return { query, caseSensitive, useRegex };
        });
      });
    }, 150);
  }, []);

  // Handle search close — clear all search state so highlights disappear
  const handleSearchClose = useCallback(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (searchRenderTimerRef.current) clearTimeout(searchRenderTimerRef.current);
    setIsSearchOpen(false);
    setSearchQuery(null);
    setSearchCurrentMatch(null);
  }, []);

  // Stable escape path used by editors: close search if open and keep editor focus.
  const handleEditorEscapeWhenSearchOpen = useCallback(() => {
    if (!isSearchOpenRef.current) return false;
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (searchRenderTimerRef.current) clearTimeout(searchRenderTimerRef.current);
    setIsSearchOpen(false);
    setSearchQuery(null);
    setSearchCurrentMatch(null);
    return true;
  }, []);

  // Replace a single match in a cell
  const handleReplace = useCallback((cellId: string, startIndex: number, endIndex: number, replacement: string) => {
    const cell = cellsRef.current.find(c => c.id === cellId);
    if (!cell) return;

    const newContent = cell.content.slice(0, startIndex) + replacement + cell.content.slice(endIndex);
    updateContent(cellId, newContent);
  }, [updateContent]);

  // Replace all matches in a specific cell
  const handleReplaceAllInCell = useCallback((cellId: string, query: string, replacement: string, caseSensitive: boolean, useRegex: boolean) => {
    const cell = cellsRef.current.find(c => c.id === cellId);
    if (!cell) return;

    const flags = caseSensitive ? 'g' : 'gi';
    const pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(pattern, flags);
    const newContent = cell.content.replace(regex, replacement);

    if (newContent !== cell.content) {
      updateContent(cellId, newContent);
    }
  }, [updateContent]);

  // Replace all matches in the entire notebook
  const handleReplaceAllInNotebook = useCallback((query: string, replacement: string, caseSensitive: boolean, useRegex: boolean) => {
    saveCheckpoint(); // Save undo state before bulk replace

    const flags = caseSensitive ? 'g' : 'gi';
    const pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(pattern, flags);

    setCells(prev => prev.map(cell => {
      const newContent = cell.content.replace(regex, replacement);
      return newContent !== cell.content ? { ...cell, content: newContent } : cell;
    }));
  }, [saveCheckpoint, setCells]);

  // Queue-stall watchdog: cells queued while the kernel isn't ready used to
  // sit silently forever ("I clicked run and nothing happened"). If the
  // stall persists for 10s, tell the user once per episode.
  const stallToastShownRef = useRef(false);
  useEffect(() => {
    const stalled = executionQueue.length > 0 && (!isKernelReady || !kernelSessionId);
    if (!stalled) {
      stallToastShownRef.current = false;
      return;
    }
    if (stallToastShownRef.current) return;
    const timer = setTimeout(() => {
      stallToastShownRef.current = true;
      const reason = !kernelSessionId ? 'no kernel is attached' : `kernel is ${kernelStatusRef.current}`;
      toast(`${executionQueue.length} cell${executionQueue.length === 1 ? '' : 's'} waiting to run, but ${reason} — check the kernel menu`, 'warning', 6000);
    }, 10000);
    return () => clearTimeout(timer);
  }, [executionQueue.length, isKernelReady, kernelSessionId, toast]);

  // Execution Processor
  useEffect(() => {
    if (isProcessingQueue || executionQueue.length === 0 || !isKernelReady || !kernelSessionId) return;

    const processNext = async () => {
      setIsProcessingQueue(true);
      setKernelStatus('busy');
      const cellId = executionQueue[0];
      const currentCells = cellsRef.current;
      const cellIndex = currentCells.findIndex(c => c.id === cellId);
      const cell = cellIndex >= 0 ? currentCells[cellIndex] : null;

      // Start timing for this cell
      const cellStartTime = Date.now();
      cellExecutionStartRef.current = cellStartTime;

      if (cell && cell.type === 'code') {
        let hasError = false;
        const collectedOutputs: string[] = []; // Track outputs for history

        // Output limits (uses module-level constants)
        let totalOutputChars = 0;
        let totalOutputLines = 0;
        let outputLimitReached = false;

        // Accumulate outputs and flush periodically to update UI
        // Key: We never clear this array - each flush replaces cell.outputs entirely
        // This avoids race conditions with React's async state updates
        const allOutputs: typeof cell.outputs = [];
        let lastFlushTime = 0; // Start at 0 so first output flushes immediately
        const FLUSH_INTERVAL_MS = 100; // Flush at most every 100ms
        let pendingFlush: number | null = null;

        const flushToCell = (forceClear = false) => {
          pendingFlush = null;
          if (!forceClear && allOutputs.length === 0) return;
          // Copy current accumulated outputs - don't clear, keep accumulating
          const snapshot = forceClear ? [] : [...allOutputs];
          if (!forceClear) {
            lastFlushTime = Date.now();
          }

          // Replace entire outputs array - this is idempotent and race-condition-free
          setCells(prev => prev.map(c => {
            if (c.id !== cellId) return c;
            return { ...c, outputs: snapshot, pendingOutputReset: false };
          }));
        };

        const scheduleFlush = () => {
          if (pendingFlush !== null) return;
          const timeSinceLastFlush = Date.now() - lastFlushTime;
          if (timeSinceLastFlush >= FLUSH_INTERVAL_MS) {
            // Flush immediately
            flushToCell();
          } else {
            // Schedule flush for later
            pendingFlush = window.setTimeout(flushToCell, FLUSH_INTERVAL_MS - timeSinceLastFlush);
          }
        };

        setCells(prev => prev.map(c => c.id === cellId ? {
          ...c,
          isExecuting: true,
          pendingOutputReset: true,
          lastExecutionMs: undefined,
        } : c));

        // The kernel's own execution_count from the execute round-trip — the
        // authoritative Jupyter [n], which survives refreshes/server restarts.
        let kernelReportedCount: number | null = null;

        try {
          const execResult = await kernelService.executeCode(kernelSessionId, cell.content, (output) => {
            if (output.type === 'error') {
              hasError = true;
            }

            // Check output limits
            if (outputLimitReached) return;

            const outputSize = output.content?.length || 0;
            totalOutputChars += outputSize;

            // Count lines for text outputs
            if (output.type === 'stdout' || output.type === 'stderr' || output.type === 'error') {
              const lineCount = (output.content?.match(/\n/g) || []).length + 1;
              totalOutputLines += lineCount;
              collectedOutputs.push(output.content);
            }

            allOutputs.push(output);

            // Check if we've hit any limit (lines or size)
            if (totalOutputLines >= MAX_OUTPUT_LINES || totalOutputChars >= MAX_OUTPUT_CHARS) {
              outputLimitReached = true;
              allOutputs.push({
                id: `limit-${Date.now()}`,
                type: 'stderr',
                content: `\n⚠️ Output limit reached (${totalOutputLines.toLocaleString()} lines). Additional output not displayed.`,
                timestamp: Date.now(),
              });
              // Cancel any pending flush and flush immediately
              if (pendingFlush !== null) {
                clearTimeout(pendingFlush);
                pendingFlush = null;
              }
              flushToCell();
              return;
            }

            // Schedule a throttled flush to update UI
            scheduleFlush();
          }, cellId);

          markOnboardingStep('ranCell');
          if (execResult && typeof execResult.executionCount === 'number') {
            kernelReportedCount = execResult.executionCount;
          }

          // Cancel any pending flush and do final flush
          if (pendingFlush !== null) {
            clearTimeout(pendingFlush);
            pendingFlush = null;
          }
          flushToCell(allOutputs.length === 0);
        } catch (error) {
          console.error('Execution error:', error);
          hasError = true;
          const errMsg = error instanceof Error ? error.message : String(error);

          // "Session ... not found" = the server no longer has ANY record of
          // this session — the kernel died (e.g. SLURM OOM kill) and its
          // record was cleaned up, or the hosting server restarted without
          // it. Surface it as a dead kernel with a clear next step instead
          // of leaking a raw session id error.
          if (/session .* not found/i.test(errMsg)) {
            setKernelStatus('dead');
            setIsKernelReady(false);
            toast(
              'Kernel session no longer exists on the server — it likely died (e.g. out-of-memory kill) and was cleaned up. Restart it from the kernel menu.',
              'error',
              12000
            );
            allOutputs.push({
              id: `exec-error-${Date.now()}`,
              type: 'error',
              content: 'Kernel session no longer exists on the server (the kernel died and was cleaned up). Restart the kernel and re-run.',
              timestamp: Date.now(),
            });
          } else if (allOutputs.length === 0) {
            // Show the failure in the cell instead of failing silently
            allOutputs.push({
              id: `exec-error-${Date.now()}`,
              type: 'error',
              content: errMsg,
              timestamp: Date.now(),
            });
          }

          // Cancel any pending flush and flush what we have
          if (pendingFlush !== null) {
            clearTimeout(pendingFlush);
            pendingFlush = null;
          }
          flushToCell(allOutputs.length === 0);
        }

        // Log execution completion for history
        const durationMs = Date.now() - cellStartTime;
        // Output logging depends on notebook-level setting:
        // - 'minimal': no output logged (saves space)
        // - 'full': complete output logged (for debugging/replay)
        const fullOutput = collectedOutputs.join('\n');
        const loggedOutput = outputLoggingMode === 'full' ? fullOutput : undefined;

        const runId = executionRunIdsRef.current.get(cellId);
        logOperation({
          type: 'event',
          category: 'execution',
          name: 'runCellComplete',
          target: { cellId, cellIndex },
          runId,
          data: {
            durationMs,
            success: !hasError,
            output: loggedOutput,
          },
        });
        executionRunIdsRef.current.delete(cellId);

        // Assign the cell its [n]. Prefer the kernel's authoritative
        // execution_count (Jupyter convention: the counter belongs to the
        // kernel — it survives page refreshes and server restarts, and only
        // resets when the kernel itself restarts). Fall back to a local
        // increment when the kernel didn't report one (e.g. errors).
        setKernelExecutionCount(prev => {
          const newCount = kernelReportedCount ?? prev + 1;
          setCells(cells => cells.map(c => c.id === cellId ? {
            ...c,
            isExecuting: false,
            pendingOutputReset: false,
            executionCount: newCount,
            lastExecutionMs: durationMs
          } : c));
          return newCount;
        });

        // Handle error: clear queue and show error indicator
        if (hasError) {
          setExecutionQueue([]); // Clear remaining queue on error
          lastCompletedCellRef.current = { cellId, cellIndex };
          setLastExecutionResult({
            cellId,
            cellIndex,
            status: 'error',
            elapsedMs: durationMs
          });
        } else {
          // Use functional update to get current queue state (not stale closure)
          // This ensures cells added during execution aren't lost
          setExecutionQueue(prev => {
            const remainingQueue = prev.slice(1);
            if (remainingQueue.length === 0) {
              // Queue complete - show success indicator
              lastCompletedCellRef.current = { cellId, cellIndex };
              setLastExecutionResult({
                cellId,
                cellIndex,
                status: 'completed',
                elapsedMs: durationMs
              });
            }
            return remainingQueue;
          });
        }
      } else {
        // Non-code cell or cell not found, just mark as done
        if (cellIndex >= 0) {
          lastCompletedCellRef.current = { cellId, cellIndex };
        }
        setCells(prev => prev.map(c => c.id === cellId ? { ...c, isExecuting: false, pendingOutputReset: false } : c));
        setExecutionQueue(prev => prev.slice(1));
      }

      cellExecutionStartRef.current = null;
      setIsProcessingQueue(false);
      setKernelStatus('idle');

      // After execution completes, the executed cell's output may have pushed
      // the active cell (next cell after Shift+Enter) out of view. Scroll it
      // back into view if needed. Use a short delay so the DOM settles.
      const activeCellId = activeCellIdRef.current;
      if (activeCellId && activeCellId !== cellId) {
        setTimeout(() => {
          const activeIndex = cellsRef.current.findIndex(c => c.id === activeCellId);
          if (activeIndex >= 0 && !isCellVisibleInViewport(activeCellId, activeIndex)) {
            scrollToCell(activeIndex, { behavior: 'auto' });
          }
        }, 100);
      }
    };

    processNext();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executionQueue, isProcessingQueue, isKernelReady, kernelSessionId, setCells, logOperation]); // removed cells dep — uses cellsRef

  // Track execution timing for notifications
  const prevQueueLengthRef = useRef(0);
  useEffect(() => {
    const prevLength = prevQueueLengthRef.current;
    const currentLength = executionQueue.length;

    // Queue just became non-empty - start timing
    if (prevLength === 0 && currentLength > 0) {
      executionStartTimeRef.current = Date.now();
    }

    // Queue just became empty after having items - check if we should notify
    if (prevLength > 0 && currentLength === 0 && executionStartTimeRef.current) {
      const elapsedSeconds = (Date.now() - executionStartTimeRef.current) / 1000;
      const settings = getSettings();

      const threshold = settings.notifyThresholdSeconds ?? 60;

      if (elapsedSeconds >= threshold) {
        // Play sound notification if enabled
        if (settings.notifySoundEnabled) {
          playSuccessSound();
        }

        // Send browser notification if enabled
        if (settings.notifyOnLongRun) {
          if (typeof window === 'undefined' || !('Notification' in window)) {
            // Notification API not available in this environment
          } else if (Notification.permission === 'granted') {
            const minutes = Math.floor(elapsedSeconds / 60);
            const seconds = Math.floor(elapsedSeconds % 60);
            const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
            const lastCell = lastCompletedCellRef.current;
            const cellLabel = lastCell && lastCell.cellIndex >= 0
              ? `Cell #${lastCell.cellIndex + 1}`
              : 'Cell completed';
            const notebookLabel = currentFilename || 'Untitled';
            const notification = new Notification('Nebula Notebook', {
              body: `${notebookLabel} - ${cellLabel} - completed in ${timeStr}`,
              icon: '/favicon.svg',
              tag: 'execution-complete', // Prevents duplicate notifications
              renotify: true,
              requireInteraction: true,
            } as NotificationOptions);
            notification.onclick = () => {
              window.focus();
              if (lastCell && lastCell.cellIndex >= 0) {
                setActiveCellId(lastCell.cellId);
                scrollToCell(lastCell.cellIndex, { behavior: 'auto', retryOnce: true });
              }
              notification.close();
            };
          } else if (Notification.permission === 'default') {
            // Request permission for future notifications
            Notification.requestPermission();
          } else {
            // Permission denied - do nothing
          }
        }
      }

      executionStartTimeRef.current = null;
    }

    prevQueueLengthRef.current = currentLength;
  }, [executionQueue.length, currentFilename, scrollToCell]);

  const getKernelDisplayName = () => {
    if (kernelSelectionRequired || !currentKernel) return 'Select kernel';
    if (isEnvKernelName(currentKernel)) {
      const pythonPath = currentKernel.slice('env:'.length);
      const env = pythonEnvironments.find(e => e.path === pythonPath);
      // Friendly label from discovery, else a compact tail of the path
      return env?.display_name || `Python (${pythonPath.split('/').slice(-3).join('/')})`;
    }
    const kernel = availableKernels.find(k => k.name === currentKernel);
    return kernel?.display_name || currentKernel;
  };

  const getStatusColor = () => {
    switch (kernelStatus) {
      case 'idle': return 'bg-green-500';
      case 'busy': return 'bg-amber-500 animate-pulse';
      case 'starting': return 'bg-blue-500 animate-pulse';
      default: return 'bg-red-500';
    }
  };

  const isKernelReconnecting = kernelSessionId !== null && kernelStatus === 'disconnected';

  // Jump to the TOP of a cell (its code) — for "running cell" / queue
  // indicators, where you want to see what the cell IS. Distinct from
  // scrollToCellOutput below, which targets what the cell PRODUCED.
  const jumpToCell = useCallback((cellId: string, cellIndex: number) => {
    setActiveCellId(cellId);
    scrollToCell(cellIndex);
  }, [scrollToCell]);

  const scrollToCellOutput = useCallback((cellId: string, _cellIndex: number) => {
    setActiveCellId(cellId);
    // Scroll directly to the output section. Use the cell wrapper as fallback
    // if the output element doesn't exist yet (content-visibility may need to
    // activate first). Retry a few times to handle lazy rendering.
    // block: 'start' — 'nearest' does nothing when the element is already
    // partially visible, which left the viewport stranded mid-cell.
    const attemptScroll = (attempt: number) => {
      const outputEl = document.getElementById(`cell-output-${cellId}`);
      if (outputEl) {
        outputEl.scrollIntoView({ behavior: getDefaultScrollBehavior(), block: 'start' });
        return;
      }
      // Fall back to the cell wrapper
      const cellEl = document.querySelector(`[data-cell-id="${cellId}"]`);
      if (cellEl) {
        cellEl.scrollIntoView({ behavior: getDefaultScrollBehavior(), block: 'start' });
        return;
      }
      if (attempt < 8) {
        setTimeout(() => attemptScroll(attempt + 1), 100);
      }
    };
    attemptScroll(0);
  }, [getDefaultScrollBehavior]);

  const navigatorItems = useMemo(() => {
    return cells.map((cell, index) => {
      const content = cell.content || '';
      const lines = content.split('\n');
      let preview = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          preview = trimmed;
          break;
        }
      }
      return {
        cellId: cell.id,
        index,
        type: cell.type,
        preview,
        content: content.toLowerCase(), // full content for search (pre-lowercased)
      };
    });
  }, [cells]);

  // Command registry for the palette ('>' mode). Rebuilt per render is fine —
  // the palette is only mounted while open, and typing in it doesn't re-render
  // Notebook (query state lives inside CommandPalette).
  const isMacPlatform = navigator.platform.toLowerCase().includes('mac');
  const modKeyLabel = isMacPlatform ? '⌘' : 'Ctrl+';
  // Directional runs need an anchor cell; index -1 = nothing selected.
  const activeCellIndex = activeCellId ? cells.findIndex(c => c.id === activeCellId) : -1;
  const paletteCommands: PaletteCommand[] = [
    // Run
    { id: 'run-all', title: 'Run all cells', section: 'Run', keywords: 'execute everything', disabled: isSealedReadOnly, run: handleRunAllCells },
    { id: 'run-above', title: 'Run cells above', section: 'Run', keywords: 'execute before upper until here', disabled: isSealedReadOnly || activeCellIndex <= 0, run: handleRunCellsAbove },
    { id: 'run-below', title: 'Run cell and below', section: 'Run', keywords: 'execute after rest from here', disabled: isSealedReadOnly || activeCellIndex === -1, run: handleRunCellsBelow },
    { id: 'interrupt-kernel', title: 'Interrupt kernel', section: 'Kernel', keywords: 'stop cancel execution', disabled: isSealedReadOnly || !kernelSessionId, run: () => { interruptKernel(); } },
    { id: 'restart-kernel', title: 'Restart kernel', section: 'Kernel', keywords: 'reset', disabled: isSealedReadOnly || !kernelSessionId, run: () => { restartKernel(); } },
    { id: 'change-kernel', title: 'Change kernel…', section: 'Kernel', keywords: 'switch select python julia r server', disabled: isSealedReadOnly, run: () => setIsKernelMenuOpen(true) },
    { id: 'manage-kernels', title: 'Manage running kernels…', section: 'Kernel', keywords: 'sessions list', disabled: isSealedReadOnly, run: () => setIsKernelManagerOpen(true) },
    // File
    { id: 'save', title: 'Save notebook', section: 'File', keywords: 'write disk', shortcut: `${modKeyLabel}S`, disabled: isSealedReadOnly, run: () => { handleManualSave(); } },
    { id: 'open-file-browser', title: 'Open file browser', section: 'File', keywords: 'files sidebar explorer open notebook', run: () => setIsFileBrowserOpen(true) },
    { id: 'rename-notebook', title: 'Rename notebook…', section: 'File', keywords: 'title filename', disabled: isSealedReadOnly || !currentFileId, run: startRenameNotebook },
    // Edit
    { id: 'add-code-cell', title: 'Add code cell at end', section: 'Edit', keywords: 'insert new append', disabled: isSealedReadOnly, run: () => handleAddCell('code') },
    { id: 'add-markdown-cell', title: 'Add markdown cell at end', section: 'Edit', keywords: 'insert new append text', disabled: isSealedReadOnly, run: () => handleAddCell('markdown') },
    { id: 'undo', title: 'Undo', section: 'Edit', keywords: 'revert', shortcut: `${modKeyLabel}Z`, disabled: isSealedReadOnly || !canUndo, run: undo },
    { id: 'redo', title: 'Redo', section: 'Edit', keywords: 'repeat', shortcut: `${modKeyLabel}Y`, disabled: isSealedReadOnly || !canRedo, run: redo },
    { id: 'find', title: 'Find & replace…', section: 'Edit', keywords: 'search regex', shortcut: `${modKeyLabel}F`, run: () => setIsSearchOpen(true) },
    { id: 'go-to-cell', title: 'Go to cell…', section: 'Edit', keywords: 'jump navigate search cells spotlight', shortcut: `${isMacPlatform ? '⌘' : 'Ctrl+'}P`, run: () => openNavigator('') },
    // View
    { id: 'toggle-full-width', title: isFullWidth ? 'Exit full width mode' : 'Enter full width mode', section: 'View', keywords: 'wide layout width', disabled: isSealedReadOnly, run: () => { handleToggleFullWidth(); } },
    { id: 'toggle-history', title: isHistoryOpen ? 'Hide history panel' : 'Show history panel', section: 'View', keywords: 'time travel edits undo timeline toggle', shortcut: `${modKeyLabel}⇧H`, run: () => setIsHistoryOpen(open => !open) },
    // A true on/off toggle for the whole panel (whatever tab it is on) — plus
    // explicit "open to this tab" commands. Before, "Show terminal" from the
    // agent tab switched tabs instead of closing, so there was no one-step off.
    { id: 'toggle-terminal', title: isTerminalOpen ? 'Hide terminal panel' : 'Show terminal panel', section: 'View', keywords: 'shell console agent toggle', shortcut: 'Ctrl+`', disabled: isSealedReadOnly, run: () => setIsTerminalOpen(open => !open) },
    { id: 'open-shell', title: 'Open shell terminal', section: 'View', keywords: 'shell console bash zsh', disabled: isSealedReadOnly, run: () => { setIsTerminalOpen(true); setTerminalTab('shell'); } },
    { id: 'open-agent', title: 'Open agent terminal', section: 'View', keywords: 'claude code codex ai assistant', disabled: isSealedReadOnly, run: () => { setIsTerminalOpen(true); setTerminalTab('agent'); } },
    { id: 'open-settings', title: 'Open settings…', section: 'View', keywords: 'preferences options', run: () => setIsSettingsOpen(true) },
    { id: 'keyboard-shortcuts', title: 'Keyboard shortcuts', section: 'Help', keywords: 'keys bindings hotkeys help', run: () => setIsKeyboardHelpOpen(true) },
  ];


  const handleFileBrowserSelect = useCallback((id: string) => {
    loadFileRef.current(id);
  }, []);

  const handleFileBrowserRefresh = useCallback(() => {
    refreshFileListRef.current();
  }, []);

  const handleOpenTextFile = useCallback((path: string) => {
    setTextEditorPath(path);
  }, []);

  const handleOpenImageFile = useCallback((path: string) => {
    setImageViewerPath(path);
  }, []);

  const handleCloseFileBrowser = useCallback(() => {
    setIsFileBrowserOpen(false);
  }, []);

  const fileBrowserInitialPath = useMemo(() => getDirectoryFromPath(currentFileId), [currentFileId]);
  const notebookChromeClass = isFullWidth ? 'w-full min-w-0' : 'max-w-5xl mx-auto w-full min-w-0';
  const notebookContentClass = isFullWidth ? 'w-full min-w-0 px-4' : 'max-w-5xl mx-auto w-full min-w-0 px-4';

  return (
    <div className="flex min-h-screen bg-slate-50 relative overflow-hidden">

      {/* File Browser Sidebar */}
      <FileBrowser
        files={files}
        currentFileId={currentFileId}
        onSelect={handleFileBrowserSelect}
        onOpenTextFile={handleOpenTextFile}
        onOpenImageFile={handleOpenImageFile}
        onRefresh={handleFileBrowserRefresh}
        isOpen={isFileBrowserOpen}
        onClose={handleCloseFileBrowser}
        initialPath={fileBrowserInitialPath}
      />

      {/* Main Content */}
      <div className={`relative flex-1 min-w-0 flex flex-col h-screen transition-all duration-300 ${isFileBrowserOpen ? 'nebula-filebrowser-offset' : ''}`}>

        {imageViewerPath && (
          <ImageModalViewer
            src={`/api/fs/download?path=${encodeURIComponent(imageViewerPath)}`}
            alt="Preview"
            onClose={() => setImageViewerPath(null)}
          />
        )}

        {isNavigatorOpen && (
          <CommandPalette
            key={navigatorOpenNonce}
            items={navigatorItems}
            commands={paletteCommands}
            initialQuery={navigatorInitialQuery}
            onSelect={(cellId, index) => {
              setActiveCellId(cellId);
              scrollToCell(index, { behavior: 'auto', retryOnce: true });
            }}
            onClose={closeNavigator}
          />
        )}

        {textEditorPath && (
          <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-6 overflow-hidden">
            <div className="w-full h-full max-w-5xl max-h-[85vh] bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden">
              <TextFileEditor
                filePath={textEditorPath}
                variant="modal"
                onClose={() => setTextEditorPath(null)}
                onOpenAsNotebook={(p) => {
                  setTextEditorPath(null);
                  handleFileBrowserSelect(p);
                }}
              />
            </div>
          </div>
        )}

        {/* Conflict Dialog */}
        {conflictDialog?.show && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
              <div className="flex items-start gap-3 mb-4">
                <AlertCircle className="w-6 h-6 text-orange-500 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">Notebook Changed on Server</h3>
                  <p className="text-sm text-slate-600 mt-1">
                    The notebook was modified on the server while you were editing.
                    How would you like to proceed?
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => {
                    // Dialog closes immediately; the force-save continues in
                    // the background (can take seconds for large notebooks).
                    keepLocal().then(result => {
                      if (!result.success) {
                        toast('Failed to save your version — will retry via autosave', 'error', 6000);
                      }
                    });
                  }}
                  disabled={conflictResolving}
                  className="w-full px-4 py-2.5 text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-60"
                >
                  Keep My Changes
                  <span className="block text-xs font-normal text-blue-200 mt-0.5">
                    Overwrite server version with your local edits
                  </span>
                </button>
                <button
                  onClick={() => {
                    loadRemote().then(result => {
                      if (!result.success) {
                        toast('Failed to load the server version — try again', 'error', 6000);
                      }
                    });
                  }}
                  disabled={conflictResolving}
                  className="w-full px-4 py-2.5 text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 rounded-lg transition-colors disabled:opacity-60"
                >
                  {conflictResolving ? 'Loading…' : 'Load Server Version'}
                  <span className="block text-xs font-normal text-slate-500 mt-0.5">
                    Discard your changes and reload from server
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}

        <header className="flex-none bg-slate-50/90 backdrop-blur py-3 border-b border-slate-200 px-4 z-20">
            <div className={`flex flex-wrap justify-between items-start gap-3 ${notebookChromeClass}`}>
               <div className="flex min-w-0 flex-1 items-start gap-3">
                 <button
                    onClick={() => setIsFileBrowserOpen(!isFileBrowserOpen)}
                    className="p-2 hover:bg-white hover:shadow-sm rounded-md text-slate-600 transition-all flex-shrink-0"
                 >
                   <Menu className="w-5 h-5" />
                 </button>
                 <div className="min-w-0">
                    <h1 className="text-lg font-bold text-slate-800 flex items-center gap-2 truncate">
                      {isRenamingNotebook ? (
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={finishRenameNotebook}
                          onKeyDown={handleRenameKeyDown}
                          className="text-lg font-bold bg-white border-2 border-blue-400 rounded px-1 py-0 focus:outline-none focus:border-blue-500 leading-normal"
                          style={{ width: `${Math.min(Math.max(renameValue.length + 2, 12), 48)}ch`, maxWidth: '100%' }}
                          autoFocus
                        />
                      ) : isLoadingFile ? (
                        <span className="flex items-center gap-2 text-slate-400">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Loading...
                        </span>
                      ) : (
                        <span
                          onClick={isSealedReadOnly ? undefined : startRenameNotebook}
                          className={isSealedReadOnly ? 'px-1' : 'cursor-pointer hover:bg-slate-100 px-1 rounded transition-colors'}
                          title={isSealedReadOnly ? 'Sealed notebook names cannot be changed' : 'Click to rename'}
                        >
                          {currentFilename || "Untitled"}
                        </span>
                      )}
                      <span
                        className="text-xs font-normal text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200"
                        title={isTextNotebookExtension(getPathExtension(currentFileId || ''))
                          ? 'Text notebook format — outputs are not saved to the file'
                          : undefined}
                      >
                        {getPathExtension(currentFileId || '') || '.ipynb'}
                      </span>
                    </h1>

                    {/* Second row: Kernel Selector + Save Status */}
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      {/* Kernel Selector */}
                      <div className="relative">
                      <button
                        onClick={() => { if (!isSealedReadOnly) setIsKernelMenuOpen(!isKernelMenuOpen); }}
                        disabled={isSealedReadOnly}
                        className={`flex items-center gap-1.5 text-xs px-1.5 py-0.5 rounded -ml-1.5 transition-colors ${isSealedReadOnly ? 'text-indigo-500 cursor-not-allowed' : 'text-slate-600 hover:bg-slate-200/50'}`}
                      >
                         {isSealedReadOnly ? <LockKeyhole className="w-3 h-3" /> : <span className={`w-2 h-2 rounded-full ${getStatusColor()}`}></span>}
                         <span className="font-medium">{isSealedReadOnly ? 'Static snapshot' : getKernelDisplayName()}</span>
                         {!isSealedReadOnly && <ChevronDown className="w-3 h-3 text-slate-400" />}
                      </button>

                      {isKernelMenuOpen && !isSealedReadOnly && (
                        <div
                          className="absolute top-full left-0 mt-1 w-80 bg-white rounded-lg shadow-xl border border-slate-200 py-1 z-50 max-h-[70vh] overflow-hidden flex flex-col"
                          onMouseLeave={() => setIsKernelMenuOpen(false)}
                        >
                          <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
                             <div>
                               <div className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                                 Active Kernel
                                 {kernelCreatedAt && (
                                   <span className="text-[0.625rem] font-normal text-slate-400 flex items-center gap-0.5" title="Kernel uptime">
                                     <Clock className="w-2.5 h-2.5" />
                                     {formatKernelUptime(kernelCreatedAt)}
                                   </span>
                                 )}
                               </div>
                               <div className="text-[0.625rem] text-slate-500">
                                 {getKernelDisplayName()} ({kernelStatus})
                                 {clusterInfo && clusterInfo.servers.length > 1 && selectedServerId && (() => {
                                   const server = clusterInfo.servers.find(s => s.id === selectedServerId);
                                   const displayName = server?.isLocal && server?.resources?.hostname
                                     ? server.resources.hostname
                                     : server?.name || selectedServerId;
                                   return (
                                     <span className="text-blue-500 ml-1">
                                       @ {displayName}
                                     </span>
                                   );
                                 })()}
                               </div>
                             </div>
                             <button
                               onClick={(e) => { e.stopPropagation(); refreshClusterInfo(); loadPythonEnvironments(true, selectedServerId); }}
                               disabled={isDiscoveringPythons}
                               className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors"
                               title="Refresh servers & Python environments"
                             >
                               <RefreshCw className={`w-3.5 h-3.5 ${isDiscoveringPythons ? 'animate-spin' : ''}`} />
                             </button>
                          </div>

                          {/* Kernel Actions */}
                          <div className="border-b border-slate-100 py-1">
                            <button
                              onClick={() => interruptKernel()}
                              disabled={kernelStatus !== 'busy' && !isProcessingQueue && executionQueue.length === 0}
                              className="w-full text-left px-3 py-2 text-xs text-red-600 hover:bg-red-50 flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent"
                            >
                              <Square className="w-3 h-3" /> Interrupt
                            </button>
                            <button
                              onClick={() => restartKernel()}
                              className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                            >
                              <RotateCw className="w-3 h-3" /> Restart Kernel
                            </button>
                            <button
                              onClick={() => shutdownKernel()}
                              disabled={!kernelSessionId}
                              className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent"
                            >
                              <Power className="w-3 h-3" /> Shutdown Kernel
                            </button>
                            <button
                              onClick={() => { setIsKernelMenuOpen(false); setIsKernelManagerOpen(true); }}
                              className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                            >
                              <Cpu className="w-3 h-3" /> Manage All Kernels
                            </button>
                          </div>

                          <div className="overflow-y-auto flex-1">
                            {/* Server Selector (only show if cluster has multiple servers) */}
                            {clusterInfo && clusterInfo.servers.length > 1 && (
                              <>
                                <div className="px-3 py-1.5 text-[0.625rem] font-semibold text-slate-500 uppercase tracking-wide bg-slate-50 flex items-center gap-1">
                                  <Server className="w-3 h-3" />
                                  <span>Server</span>
                                </div>
                                {clusterInfo.servers.filter(server => {
                                  // This list exists to pick where kernels run — a login
                                  // node the user has EXPLICITLY denied kernels on has no
                                  // business here (re-enable lives in Settings). When the
                                  // choice is still undecided, keep it listed with the
                                  // "kernels gated" chip: selecting it asks once.
                                  if (server.isLocal && computeEnabled && getSettings().allowLoginNodeKernels === 'deny') return false;
                                  return true;
                                }).map(server => {
                                  const loginNodeGated = server.isLocal && computeEnabled &&
                                    getSettings().allowLoginNodeKernels !== 'allow';
                                  return (
                                  <button
                                    key={server.id}
                                    onClick={() => switchServer(server.id)}
                                    disabled={server.status !== 'online'}
                                    title={loginNodeGated
                                      ? 'Login node — kernels are gated here (change in Settings, or allocate compute)'
                                      : undefined}
                                    className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex items-center gap-2 ${
                                      server.id === selectedServerId ? 'bg-blue-50 text-blue-700' : 'text-slate-700'
                                    } ${server.status !== 'online' ? 'opacity-50' : ''}`}
                                  >
                                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                                      server.status === 'online' ? 'bg-green-500' : 'bg-red-500'
                                    }`}></span>
                                    <span className="truncate flex-1">
                                      {server.isLocal && server.resources?.hostname
                                        ? server.resources.hostname
                                        : server.name}
                                    </span>
                                    {loginNodeGated && (
                                      <span className="text-[0.625rem] text-amber-600 border border-amber-200 bg-amber-50 rounded px-1">
                                        kernels gated
                                      </span>
                                    )}
                                    {server.isLocal && <span className="text-[0.625rem] text-slate-400">(local)</span>}
                                    {server.status !== 'online' && <span className="text-[0.625rem] text-red-400">offline</span>}
                                  </button>
                                  );
                                })}
                              </>
                            )}

                            {/* Compute allocations (scheduler-backed servers) */}
                            {computeEnabled && (
                              <>
                                <div className="px-3 py-1.5 text-[0.625rem] font-semibold text-slate-500 uppercase tracking-wide bg-slate-50 flex items-center gap-1">
                                  <Cpu className="w-3 h-3" />
                                  <span>Compute</span>
                                </div>
                                <button
                                  onClick={() => { setIsKernelMenuOpen(false); setShowComputeModal(true); }}
                                  className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                                >
                                  <Plus className="w-3 h-3" /> New compute allocation…
                                </button>
                              </>
                            )}

                            {/* Empty-state onboarding: no kernels registered yet */}
                            {availableKernels.length === 0 && (
                              <div className="px-3 py-3 bg-amber-50 border-b border-amber-100">
                                <div className="text-xs font-semibold text-amber-700 flex items-center gap-1.5 mb-1">
                                  <AlertCircle className="w-3.5 h-3.5" /> No Jupyter kernels yet
                                </div>
                                <p className="text-[0.6875rem] leading-relaxed text-slate-600">
                                  To run code, you need a kernel. Click a Python environment below to
                                  start one there directly — no setup needed when{' '}
                                  <code className="px-1 py-0.5 rounded bg-white/70 text-slate-700">ipykernel</code>{' '}
                                  is present (green dot).
                                  {pythonEnvironments.length === 0 && !isDiscoveringPythons && (
                                    <span className="block mt-1 text-slate-500">No Python environments detected — install Python (or uv/conda/pixi), then Refresh.</span>
                                  )}
                                </p>
                              </div>
                            )}

                            {/* Registered Kernels */}
                            <div className="px-3 py-1.5 text-[0.625rem] font-semibold text-slate-500 uppercase tracking-wide bg-slate-50">
                              Jupyter Kernels
                            </div>
                            {availableKernels.map(kernel => {
                              // Match kernel to environment using the actual Python path from kernel.json
                              const matchedEnv = pythonEnvironments.find(env =>
                                env.kernel_name === kernel.name ||
                                (kernel.python_path && env.path && kernel.python_path === env.path)
                              );
                              const envLabel = matchedEnv?.env_name || (matchedEnv && matchedEnv.display_name !== kernel.display_name ? matchedEnv.display_name : null);
                              const isSelected = !kernelSelectionRequired && kernel.name === currentKernel;

                              return (
                                <button
                                  key={kernel.name}
                                  onClick={() => switchKernel(kernel.name)}
                                  className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex items-center gap-2 ${
                                    isSelected ? 'bg-green-50 text-green-700' : 'text-slate-700'
                                  }`}
                                >
                                  <span className="w-2 h-2 rounded-full flex-shrink-0 bg-green-500"></span>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-baseline gap-1.5 min-w-0">
                                      <span className="truncate">{kernel.display_name}</span>
                                      {envLabel && (
                                        <span className="text-[0.625rem] text-slate-400 truncate">
                                          {envLabel}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <span className="text-[0.625rem] text-slate-400">{kernel.language}</span>
                                </button>
                              );
                            })}

                            {/* Discovered Python Environments */}
                            {pythonEnvironments.length > 0 && (
                              <>
                                <div className="px-3 py-1.5 text-[0.625rem] font-semibold text-slate-500 uppercase tracking-wide bg-slate-50 mt-1 flex items-center justify-between">
                                  <span>Python Environments ({pythonEnvironments.length})</span>
                                  {isDiscoveringPythons && <Loader2 className="w-3 h-3 animate-spin" />}
                                </div>
                                {pythonEnvironments.map(env => {
                                  // Prefer a registered kernelspec for the same interpreter
                                  // (keeps existing session/metadata names); otherwise the
                                  // env is launched directly as env:<path> — no registration.
                                  const registeredKernel = availableKernels.find(k =>
                                    (k.python_path && k.python_path === env.path) ||
                                    env.kernel_name === k.name
                                  );
                                  const launchable = !!registeredKernel || env.has_ipykernel;
                                  const isSelected = !kernelSelectionRequired && (
                                    currentKernel === envKernelName(env.path) ||
                                    (!!registeredKernel && currentKernel === registeredKernel.name)
                                  );

                                  return (
                                    <button
                                      key={env.path}
                                      onClick={() => handleEnvClick(env, registeredKernel?.name)}
                                      className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex items-center gap-2 ${
                                        isSelected ? 'bg-green-50 text-green-700' : 'text-slate-600'
                                      }`}
                                      title={launchable
                                        ? 'Start a kernel in this environment'
                                        : 'ipykernel is missing — click to install it'}
                                    >
                                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                                        launchable ? 'bg-green-500' : 'bg-slate-300'
                                      }`}></span>
                                      <div className="flex-1 min-w-0">
                                        <div className="truncate">{env.display_name}</div>
                                        <div className="text-[0.625rem] text-slate-400 truncate">{env.path}</div>
                                      </div>
                                      {!launchable && (
                                        <span className="text-[0.625rem] text-slate-400 flex-shrink-0">needs ipykernel</span>
                                      )}
                                    </button>
                                  );
                                })}
                              </>
                            )}

                            {/* Manual interpreter entry — VSCode's "Enter interpreter path…",
                                for envs discovery can't see (containers, odd mounts, …) */}
                            <div className="border-t border-slate-100">
                              {manualPathOpen ? (
                                <div className="px-3 py-2 flex items-center gap-1.5">
                                  <input
                                    autoFocus
                                    value={manualPath}
                                    onChange={(e) => setManualPath(e.target.value)}
                                    onKeyDown={(e) => {
                                      e.stopPropagation();
                                      if (e.key === 'Enter') submitManualPath();
                                      if (e.key === 'Escape') { setManualPathOpen(false); setManualPath(''); }
                                    }}
                                    placeholder="/path/to/env/bin/python"
                                    disabled={isProbingPath}
                                    className="flex-1 min-w-0 px-2 py-1 text-xs font-mono border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-60"
                                  />
                                  <button
                                    onClick={submitManualPath}
                                    disabled={isProbingPath || !manualPath.trim()}
                                    className="px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 flex items-center gap-1 flex-shrink-0"
                                  >
                                    {isProbingPath ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Use'}
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setManualPathOpen(true)}
                                  className="w-full text-left px-3 py-2 text-xs text-slate-500 hover:bg-slate-50 flex items-center gap-2"
                                >
                                  <Plus className="w-3 h-3" /> Enter interpreter path…
                                </button>
                              )}
                            </div>
                          </div>

                        </div>
                      )}
                      </div>

                      {/* Agent Session Indicator - only shows when session is active */}
                      {agentSession && (() => {
                        const shortId = agentSession.agentId?.slice(0, 8) || '';
                        const displayName = agentSession.clientName || 'Agent';
                        const fullLabel = shortId ? `${displayName} (${shortId})` : displayName;
                        const durationSec = Math.floor((Date.now() - agentSession.startedAt) / 1000);
                        const durationStr = durationSec < 60
                          ? `${durationSec}s`
                          : `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;
                        const tooltipLines = [
                          `🤖 Agent Session Active`,
                          `Client: ${agentSession.clientName || 'Unknown'}${agentSession.clientVersion ? ` v${agentSession.clientVersion}` : ''}`,
                          `Session ID: ${agentSession.agentId || 'N/A'}`,
                          `Duration: ${durationStr}`,
                        ];
                        return (
                          <button
                            onClick={forceEndAgentSession}
                            className="flex items-center gap-1 text-xs mr-2 px-1.5 py-0.5 rounded text-purple-800 bg-purple-200 border border-purple-300 hover:bg-red-100 hover:text-red-700 hover:border-red-300 transition-colors max-w-[15rem]"
                            title={tooltipLines.join('\n') + '\n\nClick to force end session'}
                          >
                            <Bot className="w-3 h-3 animate-pulse flex-shrink-0" />
                            <span className="min-w-0 truncate">
                              {agentOperation
                                ? agentOperation.type.replace(/([A-Z])/g, ' $1').trim()
                                : fullLabel}
                            </span>
                          </button>
                        );
                      })()}

                      {/* Save Status Indicator */}
                      <span className="flex items-center gap-1 text-xs">
                        {currentFileId && isKernelReconnecting && (
                          <span
                            className="flex items-center gap-1 text-amber-600 mr-2"
                            title="Kernel disconnected, attempting to reconnect..."
                          >
                            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
                            <span>Kernel reconnecting</span>
                          </span>
                        )}
                        {!isOnline && (
                          <span className="flex items-center gap-1 text-orange-600 mr-2" title="No internet connection">
                            <CloudOff className="w-3 h-3" />
                            <span>Offline</span>
                          </span>
                        )}
                        {pendingSave && isOnline && (
                          <span className="flex items-center gap-1 text-orange-600 mr-2" title="Saving...">
                            <RefreshCw className="w-3 h-3 animate-spin" />
                            <span>Saving</span>
                          </span>
                        )}
                        {autosaveStatus.status === 'saving' && (
                          <span className="flex items-center gap-1 text-blue-600">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>Saving...</span>
                          </span>
                        )}
                        {autosaveStatus.status === 'saved' && !pendingSave && (
                          <span className="flex items-center gap-1 text-green-600" title={autosaveStatus.lastSaved ? `Last saved ${formatLastSaved(autosaveStatus.lastSaved)}` : ''}>
                            <Check className="w-3 h-3" />
                            <span className="text-slate-400">{formatLastSaved(autosaveStatus.lastSaved)}</span>
                          </span>
                        )}
                        {autosaveStatus.status === 'unsaved' && !pendingSave && !canRedo && (
                          <span className="flex items-center gap-1 text-amber-600" title="Unsaved changes">
                            <Cloud className="w-3 h-3" />
                            <span className="text-slate-400">Unsaved</span>
                          </span>
                        )}
                        {canRedo && (
                          <span className="flex items-center gap-1 text-amber-600" title="Autosave paused while redo history exists. Saving will clear redo history.">
                            <Undo2 className="w-3 h-3" />
                            <span>Autosave paused</span>
                          </span>
                        )}
                        {autosaveStatus.status === 'error' && !pendingSave && (
                          <button
                            onClick={() => { saveNow().catch(() => { /* surfaced via onSaveError */ }); }}
                            className="flex items-center gap-1 text-red-600 hover:text-red-700 hover:underline cursor-pointer"
                            title="Save failed — click to retry now"
                            aria-label="Save failed — retry now"
                          >
                            <AlertCircle className="w-3 h-3" />
                            <span>Save failed — Retry</span>
                          </button>
                        )}
                      </span>

                      {/* Execution Indicator - shows running cell or last result */}
                      {executionIndicator ? (
                          <div className="relative">
                            <div
                              className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 rounded transition-colors cursor-pointer"
                              onClick={() => setIsExecutionQueueOpen(!isExecutionQueueOpen)}
                              title={`Running cell ${executionIndicator.cellIndex + 1}${executionIndicator.queueLength > 1 ? ` (${executionIndicator.queueLength - 1} more queued)` : ''} - Click to manage queue`}
                            >
                              <Loader2 className="w-3 h-3 animate-spin text-amber-500" />
                              <span 
                                className="tabular-nums hover:text-blue-600 cursor-pointer"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (executionIndicator.cellIndex >= 0) {
                                    jumpToCell(executionIndicator.cellId, executionIndicator.cellIndex);
                                  }
                                }}
                                title="Jump to running cell"
                              >
                                #{executionIndicator.cellIndex + 1}
                              </span>
                              <ElapsedTimer startRef={cellExecutionStartRef} />
                              {executionIndicator.queueLength > 1 && (
                                <span className="text-gray-400">+{executionIndicator.queueLength - 1}</span>
                              )}
                            </div>
                            {/* Execution Queue Dropdown - click to toggle */}
                            {isExecutionQueueOpen && executionQueue.length > 0 && (
                              <div 
                                className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl z-50 min-w-[12.5rem] py-1"
                                onMouseLeave={() => setIsExecutionQueueOpen(false)}
                              >
                                {/* Header */}
                                <div className="px-3 py-2 border-b border-slate-100">
                                  <div className="text-xs font-semibold text-slate-900">Execution Queue</div>
                                  <div className="text-[0.625rem] text-slate-500">{executionQueue.length} cell{executionQueue.length > 1 ? 's' : ''} queued</div>
                                </div>
                                
                                {/* Queue Items */}
                                <div className="max-h-[18.75rem] overflow-y-auto">
                                  {executionQueue.map((cellId, queueIndex) => {
                                    const cellIndex = cellsRef.current.findIndex(c => c.id === cellId);
                                    const isExecuting = queueIndex === 0;
                                    const cellContent = (cellsRef.current[cellIndex]?.content || '').split('\n')[0].slice(0, 20) || 'Empty';
                                    return (
                                      <div
                                        key={`${cellId}-${queueIndex}`}
                                        className={`flex items-center justify-between px-3 py-1.5 text-xs ${isExecuting ? 'bg-amber-50' : 'hover:bg-slate-50'}`}
                                      >
                                        <div className="flex items-center gap-2 min-w-0 flex-1">
                                          <span className="w-3 h-3 flex items-center justify-center flex-shrink-0">
                                            {isExecuting ? (
                                              <Loader2 className="w-3 h-3 animate-spin text-amber-500" />
                                            ) : (
                                              <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
                                            )}
                                          </span>
                                          <span
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              if (cellIndex >= 0) {
                                                jumpToCell(cellId, cellIndex);
                                                setIsExecutionQueueOpen(false);
                                              }
                                            }}
                                            className="tabular-nums font-medium text-slate-700 hover:text-blue-600 cursor-pointer"
                                            title="Jump to cell"
                                          >
                                            #{cellIndex + 1}
                                          </span>
                                          <span className="text-slate-400 truncate">{cellContent}</span>
                                        </div>
                                        {!isExecuting && (
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setExecutionQueue(prev => prev.filter((_, idx) => idx !== queueIndex));
                                            }}
                                            className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded flex-shrink-0 ml-1"
                                            title="Remove from queue"
                                          >
                                            <X className="w-3 h-3" />
                                          </button>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                                
                                {/* Clear All Button */}
                                {executionQueue.length > 1 && (
                                  <div className="border-t border-slate-100 py-1">
                                    <button
                                      onClick={() => setExecutionQueue(prev => [prev[0]])}
                                      className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                                    >
                                      <X className="w-3 h-3" />
                                      <span>Clear Queued</span>
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                      ) : lastExecutionResult && (
                          <button
                            onClick={() => {
                              if (lastExecutionResult.cellIndex >= 0) {
                                scrollToCellOutput(lastExecutionResult.cellId, lastExecutionResult.cellIndex);
                              }
                              dismissExecutionResult();
                            }}
                            className={`flex items-center gap-1 px-1.5 py-0.5 text-xs rounded transition-colors ${
                              lastExecutionResult.status === 'error'
                                ? 'text-red-600 hover:text-red-700 hover:bg-red-50'
                                : 'text-green-600 hover:text-green-700 hover:bg-green-50'
                            }`}
                            title={`${lastExecutionResult.status === 'error' ? 'Error in' : 'Completed'} cell ${lastExecutionResult.cellIndex + 1} - Click to jump to its output`}
                          >
                            {lastExecutionResult.status === 'error' ? (
                              <XCircle className="w-3 h-3" />
                            ) : (
                              <CheckCircle className="w-3 h-3" />
                            )}
                            <span className="tabular-nums">#{lastExecutionResult.cellIndex + 1}</span>
                            <span className="tabular-nums opacity-70">{formatElapsedTime(lastExecutionResult.elapsedMs)}</span>
                          </button>
                      )}
                    </div>

                 </div>
               </div>

               <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
                  {/* Undo / Redo Controls */}
                  <div className="flex items-center gap-1 mr-2 border-r border-slate-200 pr-2">
                    <button
                      onClick={undo}
                      disabled={isSealedReadOnly || !canUndo}
                      className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-200 rounded disabled:opacity-30 transition-colors"
                      title="Notebook Undo"
                      aria-label="Notebook undo"
                    >
                      <Undo2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={redo}
                      disabled={isSealedReadOnly || !canRedo}
                      className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-200 rounded disabled:opacity-30 transition-colors"
                      title="Notebook Redo"
                      aria-label="Notebook redo"
                    >
                      <Redo2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Multi-cell selection indicator */}
                  {selectedCellIds.size > 1 && (
                    <div
                      className="flex items-center gap-1 px-2 py-1 text-xs text-blue-600 bg-blue-50 rounded-md border border-blue-200"
                      title="Multi-cell selection — Delete removes all, C copies, X cuts, Esc clears"
                    >
                      <span className="font-medium tabular-nums">{selectedCellIds.size} selected</span>
                    </div>
                  )}

                  {/* Cell Queue Indicator */}
                  {cellQueue.length > 0 && (
                    <div
                      className="flex items-center gap-1 px-2 py-1 text-xs text-indigo-600 bg-indigo-50 rounded-md border border-indigo-200"
                      title={`${cellQueue.length} cell${cellQueue.length > 1 ? 's' : ''} in queue (E to add, D to paste)`}
                    >
                      <Layers className="w-3.5 h-3.5" />
                      <span className="font-medium tabular-nums">{cellQueue.length}</span>
                    </div>
                  )}

                  <button
                    onClick={() => setIsKeyboardHelpOpen(true)}
                    className="btn-secondary flex items-center justify-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-200 text-slate-600 text-xs font-medium transition-colors"
                    title="Keyboard Shortcuts"
                    aria-label="Keyboard shortcuts"
                  >
                    <Keyboard className="w-4 h-4" />
                  </button>
                  {/* Output Logging Mode Toggle — 'full' persists outputs into
                      history (bigger history files; default 'minimal' keeps it
                      lean). Hidden unless enabled in Settings → General. */}
                  {showOutputLoggingToggle && (
                    <button
                      onClick={handleToggleOutputLogging}
                      disabled={isSealedReadOnly}
                      className={`p-1.5 rounded-md transition-colors ${
                        outputLoggingMode === 'full'
                          ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200'
                          : 'hover:bg-slate-200 text-slate-600'
                      }`}
                      title={
                        outputLoggingMode === 'full'
                          ? 'Outputs are saved into notebook history (larger history files) - click for minimal'
                          : 'Outputs are not saved into history - click to log full outputs into history'
                      }
                      aria-label="Toggle output logging in history"
                    >
                      <ScrollText className="w-4 h-4" />
                    </button>
                  )}
                  {/* Agent Permission Toggle */}
                  <button
                    onClick={handleToggleAgentPermission}
                    disabled={isSealedReadOnly || agentSession !== null}
                    className={`btn-secondary flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      agentSession
                        ? 'bg-purple-100 text-purple-600 cursor-not-allowed'
                        : agentPermissionStatus?.can_agent_modify
                          ? 'bg-green-50 text-green-700 hover:bg-green-100 border border-green-200'
                          : 'hover:bg-slate-200 text-slate-600'
                    }`}
                    title={
                      agentSession
                        ? 'Agent session active - cannot change permission'
                        : agentPermissionStatus?.can_agent_modify
                          ? 'Agent can modify this notebook - click to revoke access'
                          : agentPermissionStatus?.agent_permitted && !agentPermissionStatus?.has_history
                            ? 'Agent permitted but history not enabled yet - make an edit first'
                            : 'Click to allow agent modifications'
                    }
                    aria-label={agentPermissionStatus?.can_agent_modify ? 'Revoke agent modification access' : 'Allow agent modifications'}
                  >
                    {agentPermissionStatus?.can_agent_modify ? (
                      <ShieldOff className="w-4 h-4" />
                    ) : agentPermissionStatus?.agent_permitted ? (
                      <Shield className="w-4 h-4 text-amber-500" />
                    ) : (
                      <ShieldCheck className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={handleToggleFullWidth}
                    disabled={isSealedReadOnly}
                    aria-label={isFullWidth ? 'Exit full width mode' : 'Enable full width mode'}
                    className={`btn-secondary flex items-center justify-center px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      isFullWidth
                        ? 'bg-slate-900 text-white hover:bg-slate-700'
                        : 'hover:bg-slate-200 text-slate-600'
                    }`}
                    title={isFullWidth ? 'Exit full width mode' : 'Enable full width mode'}
                  >
                    {isFullWidth ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={() => setIsSettingsOpen(true)}
                    className="btn-secondary flex items-center justify-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-200 text-slate-600 text-xs font-medium transition-colors"
                    title="Settings"
                    aria-label="Settings"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                  <button
                    onClick={handleManualSave}
                    disabled={isSealedReadOnly}
                    aria-label="Save notebook"
                    title={isSealedReadOnly ? 'Sealed evidence is read-only' : 'Save notebook'}
                    className="btn-secondary flex items-center gap-2 px-2 sm:px-3 py-1.5 rounded-md hover:bg-slate-200 text-slate-600 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                      <Save className="w-4 h-4" />
                      <span className="hidden lg:inline">Save</span>
                  </button>
                  <div className="relative flex items-stretch">
                    <button
                      onClick={handleRunAllCells}
                      disabled={isSealedReadOnly}
                      aria-label="Run all cells"
                      title={isSealedReadOnly ? 'Sealed evidence cannot be re-executed' : 'Run all cells'}
                      className="btn-primary flex items-center gap-2 bg-slate-900 text-white px-2 sm:px-3 py-1.5 rounded-l-md hover:bg-slate-700 text-xs font-medium transition-colors shadow-sm disabled:bg-slate-300 disabled:cursor-not-allowed disabled:shadow-none"
                    >
                        <Play className="w-4 h-4" />
                        <span className="hidden md:inline">Run All</span>
                    </button>
                    <button
                      onClick={() => setIsRunMenuOpen(o => !o)}
                      disabled={isSealedReadOnly}
                      aria-label="Run options"
                      aria-haspopup="menu"
                      aria-expanded={isRunMenuOpen}
                      title={isSealedReadOnly ? 'Sealed evidence cannot be re-executed' : 'More run options'}
                      className="btn-primary flex items-center bg-slate-900 text-white px-1 py-1.5 rounded-r-md border-l border-slate-600 hover:bg-slate-700 transition-colors shadow-sm disabled:bg-slate-300 disabled:cursor-not-allowed disabled:shadow-none"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                    {isRunMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setIsRunMenuOpen(false)} />
                        <div role="menu" aria-label="Run options" className="absolute right-0 top-full mt-1 z-50 w-52 bg-white border border-slate-200 rounded-md shadow-lg py-1">
                          <button
                            role="menuitem"
                            disabled={activeCellIndex <= 0}
                            onClick={() => { setIsRunMenuOpen(false); handleRunCellsAbove(); }}
                            title={activeCellIndex === -1 ? 'Select a cell first' : activeCellIndex === 0 ? 'No cells above the selected cell' : undefined}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 disabled:text-slate-300 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                          >
                            <ArrowUpToLine className="w-3.5 h-3.5" />
                            <span>Run cells above</span>
                            {activeCellIndex > 0 && <span className="ml-auto text-slate-400">{activeCellIndex}</span>}
                          </button>
                          <button
                            role="menuitem"
                            disabled={activeCellIndex === -1}
                            onClick={() => { setIsRunMenuOpen(false); handleRunCellsBelow(); }}
                            title={activeCellIndex === -1 ? 'Select a cell first' : undefined}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 disabled:text-slate-300 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                          >
                            <ArrowDownToLine className="w-3.5 h-3.5" />
                            <span>Run cell and below</span>
                            {activeCellIndex !== -1 && <span className="ml-auto text-slate-400">{cells.length - activeCellIndex}</span>}
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  <button
                    onClick={() => {
                      if (!isTerminalOpen) { setIsTerminalOpen(true); setTerminalTab('agent'); }
                      else if (terminalTab === 'agent') setIsTerminalOpen(false);
                      else setTerminalTab('agent');
                    }}
                    disabled={isSealedReadOnly}
                    className={`flex items-center gap-2 px-2 sm:px-3 py-1.5 rounded-md font-medium text-xs transition-all shadow-sm
                      ${isTerminalOpen && terminalTab === 'agent'
                        ? 'bg-purple-600 text-white ring-2 ring-purple-200'
                        : 'bg-white text-slate-700 border border-purple-200 hover:border-purple-300 hover:bg-purple-50'
                      }`}
                    title={isSealedReadOnly ? 'Agent editing is disabled for sealed evidence' : 'Open the agent terminal — drive this notebook with Claude Code or Codex'}
                  >
                    <Bot className={`w-4 h-4 ${isTerminalOpen && terminalTab === 'agent' ? 'text-purple-200' : 'text-purple-600'}`} />
                    <span className="hidden md:inline">Agent</span>
                  </button>

               </div>
            </div>
        </header>

        {notebookAccess.read_only && (
          <div className="flex-none border-b border-indigo-800 bg-indigo-950 px-4 py-2 text-indigo-50" data-testid="sealed-evidence-ribbon">
            <div className={`${notebookChromeClass} flex flex-wrap items-center gap-x-3 gap-y-1`}>
              <span className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
                <LockKeyhole className="h-4 w-4 text-indigo-300" />
                Sealed evidence
              </span>
              <code className="rounded border border-indigo-700 bg-indigo-900/70 px-1.5 py-0.5 text-[0.6875rem] text-indigo-200">
                {notebookAccess.seal_id}
              </code>
              <span className="text-xs text-indigo-200/80">
                Read-only replay snapshot · saved outputs remain available
              </span>
              {currentFileId && (
                <button
                  type="button"
                  onClick={() => {
                    downloadFile(currentFileId, currentFileId.split('/').pop() || 'snapshot.ipynb')
                      .catch(() => toast('Failed to download sealed snapshot', 'error'));
                  }}
                  className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-indigo-100 hover:bg-indigo-900 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  aria-label="Download snapshot"
                >
                  <Download className="h-3.5 w-3.5" /> Download snapshot
                </button>
              )}
            </div>
          </div>
        )}

        {/* Loading progress bar */}
        {isLoadingFile && (
          <div className="h-0.5 bg-slate-100 overflow-hidden">
            <div className="h-full bg-blue-500 animate-loading-bar" />
          </div>
        )}

        {/* Breadcrumb navigation for markdown headers */}
        <NotebookBreadcrumb
          cells={cells}
          activeCellId={activeCellId}
          onNavigate={navigateToCell}
          fullWidth={isFullWidth}
        />

        {/* History Preview Banner */}
        {isPreviewMode && (
          <div className="px-3 py-2 bg-blue-50 border-b border-blue-200 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-blue-700">
              <History className="w-4 h-4" />
              <span>
                Previewing notebook at{' '}
                <span className="font-medium">
                  {new Date(previewTimestamp!).toLocaleString()}
                </span>
              </span>
              <span className="text-blue-500 text-xs">(read-only, outputs shown for cells not re-executed)</span>
              <span className="flex items-center gap-3 ml-4 text-xs">
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded border-2 border-orange-400 bg-orange-50"></span>
                  <span className="text-slate-500">Modified</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded border-2 border-red-400 bg-red-50"></span>
                  <span className="text-slate-500">Deleted</span>
                </span>
                {previewLineDiffEnabled && (
                  <span className="flex items-center gap-1">
                    <span className="w-3 h-3 rounded bg-red-100"></span>
                    <span className="text-slate-500">− then</span>
                    <span className="w-3 h-3 rounded bg-green-100 ml-1"></span>
                    <span className="text-slate-500">+ now</span>
                  </span>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-blue-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={previewLineDiffEnabled}
                  onChange={(e) => setPreviewLineDiffEnabled(e.target.checked)}
                />
                Line diffs
              </label>
              <button
                onClick={() => setPreviewTimestamp(null)}
                className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-100 rounded transition-colors"
              >
                Return to present
              </button>
            </div>
          </div>
        )}

        {/* Virtuoso Scrollable Area */}
        {/* relative: the add-cell pill (and empty-notebook card) anchor to THIS
            area, so they stay visible above the in-flow terminal/history
            panels instead of overlapping them or disappearing behind them */}
        <div className="relative flex-1 min-h-0 pt-2">
            {/* Empty-notebook first-run panel: shown while the notebook is a
                single blank cell (or empty); disappears the moment anything is
                typed or added. Anchored to the cell area, above the pill. */}
            {!isLoadingFile && !isPreviewMode && !isSealedReadOnly && currentFileId && (
              cells.length === 0 ||
              (cells.length === 1 && !cells[0].content.trim() && cells[0].outputs.length === 0)
            ) && (
              <div className="pointer-events-none absolute bottom-24 left-1/2 -translate-x-1/2 z-10 w-max max-w-full px-4">
                <div className="pointer-events-auto bg-white/95 backdrop-blur border border-slate-200 rounded-xl shadow-lg px-5 py-4 max-w-xl">
                  <div className="text-sm font-medium text-slate-700 mb-2">Blank notebook — a few ways to start</div>
                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    <button
                      onClick={() => handleAddCell('markdown')}
                      className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100 flex items-center gap-1.5"
                    >
                      <FileText className="w-3.5 h-3.5" /> Add a markdown cell
                    </button>
                    <button
                      onClick={() => { setIsTerminalOpen(true); setTerminalTab('agent'); }}
                      className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-purple-200 text-purple-700 bg-purple-50 hover:bg-purple-100 flex items-center gap-1.5"
                    >
                      <Bot className="w-3.5 h-3.5" /> Ask an agent to write it
                    </button>
                    <button
                      onClick={() => setIsFileBrowserOpen(true)}
                      className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100 flex items-center gap-1.5"
                    >
                      <FolderOpen className="w-3.5 h-3.5" /> Open another notebook
                    </button>
                  </div>
                  <div className="text-[0.6875rem] text-slate-400">
                    Type in the cell above · <kbd className="px-1 py-0.5 bg-slate-100 rounded">Shift+Enter</kbd> runs it ·{' '}
                    <kbd className="px-1 py-0.5 bg-slate-100 rounded">Cmd/Ctrl+P</kbd> search cells ·{' '}
                    <kbd className="px-1 py-0.5 bg-slate-100 rounded">Cmd/Ctrl+Shift+P</kbd> commands
                  </div>
                </div>
              </div>
            )}
            {/* Add-cell pill — floats over the bottom of the cell area */}
            <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20">
              <div className={`${notebookContentClass} flex justify-center`}>
                <div className={`pointer-events-auto flex gap-4 rounded-full border border-slate-200 bg-white p-2 shadow-lg ${agentSession || isSealedReadOnly ? 'opacity-50' : ''}`}>
                  <button
                    onClick={() => handleAddCell('code')}
                    disabled={isSealedReadOnly || agentSession !== null}
                    className={`flex items-center gap-2 px-4 py-2 rounded-full font-medium transition-colors ${agentSession || isSealedReadOnly ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'}`}
                    title={isSealedReadOnly ? 'Sealed evidence is read-only' : agentSession ? 'Locked during agent session' : 'Add Code Cell'}
                  >
                    <Plus className="w-4 h-4" /> Code
                  </button>
                  <button
                    onClick={() => handleAddCell('markdown')}
                    disabled={isSealedReadOnly || agentSession !== null}
                    className={`flex items-center gap-2 px-4 py-2 rounded-full font-medium transition-colors ${agentSession || isSealedReadOnly ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
                    title={isSealedReadOnly ? 'Sealed evidence is read-only' : agentSession ? 'Locked during agent session' : 'Add Text Cell'}
                  >
                    <Plus className="w-4 h-4" /> Text
                  </button>
                </div>
              </div>
            </div>
            {/* Force remount when file changes to recalculate cell heights */}
            <VirtualCellList
              key={currentFileId || 'empty'}
              cells={displayCells}
              cellListRef={cellListRef}
              className="h-full"
              fullWidth={isFullWidth}
              onRangeChange={handleRangeChange}
              renderKey={`${showLineNumbers ? 'ln' : ''}-${showCellIds ? 'ci' : ''}-${isPreviewMode ? 'pv' : ''}`}
              renderCell={(cell, idx) => (
              <CellComponent
                  key={cell.id}
                  cell={cell}
                  index={idx}
                  isActive={!isPreviewMode && activeCellId === cell.id}
                  isSelected={!isPreviewMode && selectedCellIds.has(cell.id)}
                  isHighlighted={highlightedCellIds.has(cell.id)}
                  agentActive={agentActiveCellIds.has(cell.id)}
                  isLocked={isSealedReadOnly || agentSession?.exclusive === true || isPreviewMode}
                  allCellsRef={displayCellsRef}
                  cellIndexMapRef={cellIndexMapRef}
                  onUpdate={handleUpdateCell}
                  onAIUpdate={handleAIUpdateCell}
                  onFlush={flushCell}
                  onRun={queueExecution}
                  onRunAndAdvance={runAndAdvance}
                  onDelete={deleteCell}
                  onMove={moveCell}
                  onChangeType={changeCellType}
                  onClick={handleCellClick}
                  onActivate={setActiveCellId}
                  onNavigateCell={(direction) => navigateCellRelative(cell.id, direction)}
                  onEditorBoundaryNavigate={handleEditorBoundaryNavigate}
                  onReorder={isPreviewMode || isSealedReadOnly ? undefined : reorderCellTo}
                  onAddCell={(afterIndex) => addCell('code', '', afterIndex, true)}
                  onSave={handleManualSave}
                  onSetCellScrolled={setCellScrolled}
                  onSetCellScrolledHeight={setCellScrolledHeight}
                  onCursorActivity={recordCursorAnchor}
                  searchHighlight={
                    // Only pass search to the cell containing the current match.
                    // All other cells get null → Cell memo skips re-render.
                    searchQuery && searchCurrentMatch?.cellId === cell.id
                      ? searchQuery : null
                  }
                  searchCurrentMatch={searchCurrentMatch?.cellId === cell.id ? searchCurrentMatch : null}
                  queuePosition={queuePositionMap.get(cell.id) ?? -1}
                  indentConfig={indentConfig}
                  requestedFocusMode={pendingFocus?.cellId === cell.id ? pendingFocus?.mode : null}
                  onFocusModeApplied={clearPendingFocus}
                  onSearchEscape={handleEditorEscapeWhenSearchOpen}
                  showLineNumbers={showLineNumbers}
                  showCellIds={showCellIds}
                  previewDiffStatus={isPreviewMode ? previewDiffMap.get(cell.id) : undefined}
                  previewDiffAgainst={isPreviewMode && previewLineDiffEnabled ? previewDiffAgainstMap.get(cell.id) : undefined}
                  kernelSessionId={kernelSessionId ?? undefined}
                />
              )}
            />
        </div>

        {/* Terminal Panel */}
        <TerminalPanel
          isOpen={isTerminalOpen && !isSealedReadOnly}
          onClose={() => setIsTerminalOpen(false)}
          notebookPath={currentFileId}
          activeTab={terminalTab}
          onTabChange={setTerminalTab}
        />

        {/* History Panel - toggle with ?history=true or status bar */}
        <HistoryPanel
          isOpen={isHistoryOpen}
          onClose={() => setIsHistoryOpen(false)}
          history={getFullHistory()}
          onResetHistory={!isSealedReadOnly && currentFileId && historyReady ? handleResetHistory : undefined}
          onPreview={setPreviewTimestamp}
          onExitPreview={() => setPreviewTimestamp(null)}
          previewTimestamp={previewTimestamp}
          onRequestRestore={isSealedReadOnly ? undefined : setRestoreDialogTimestamp}
        />

        {/* Restore Dialog */}
        {restoreDialogTimestamp && previewCells && (
          <RestoreDialog
            isOpen={true}
            onClose={() => setRestoreDialogTimestamp(null)}
            targetTimestamp={restoreDialogTimestamp}
            currentCells={cells}
            previewCells={previewCells}
            onRestoreHere={handleRestoreHere}
            onSaveAsNew={handleSaveAsNew}
            suggestedFilename={currentFileId ? generateRestoredFilename(currentFileId, restoreDialogTimestamp) : undefined}
          />
        )}

        {/* Status Bar */}
        <div className="h-6 flex items-center justify-between px-2 bg-slate-100 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-400 select-none shrink-0 overflow-hidden">
          {/* Left side */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              onClick={() => setIsTerminalOpen(!isTerminalOpen)}
              disabled={isSealedReadOnly}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors ${
                isTerminalOpen
                  ? 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'
                  : 'hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
              title={isSealedReadOnly ? 'Terminal disabled while viewing sealed evidence' : 'Toggle terminal panel (Ctrl+`)'}
            >
              <Terminal className="w-3 h-3" />
              <span>Terminal</span>
            </button>
            <button
              onClick={() => setIsHistoryOpen(!isHistoryOpen)}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors ${
                isHistoryOpen
                  ? 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'
                  : 'hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
              title="Toggle History Panel"
            >
              <History className="w-3 h-3" />
              <span>History</span>
            </button>
          </div>

          {/* Right side — overflow hidden, never wraps */}
          <div className="flex items-center gap-3 overflow-hidden flex-nowrap min-w-0">
            {/* Cell count */}
            <span className="flex items-center gap-1 flex-shrink-0" title={`${cellStats.codeCount} code, ${cellStats.markdownCount} markdown`}>
              <Layers className="w-3 h-3" />
              {cellStats.count} cells
            </span>

            {/* Kernel memory usage */}
            {memoryUsage && (
              <span
                className={`flex items-center gap-1 tabular-nums flex-shrink-0 ${
                  memoryUsage.total > 0 && memoryUsage.used / memoryUsage.total >= 0.95
                    ? 'text-red-600 font-semibold'
                    : memoryUsage.total > 0 && memoryUsage.used / memoryUsage.total >= 0.85
                      ? 'text-amber-600 font-medium'
                      : ''
                }`}
                title={memoryUsage.total > 0
                  ? `Kernel memory (RSS) vs allocation limit — SLURM kills the kernel at the limit`
                  : 'Kernel memory (RSS)'}
              >
                <MemoryStick className="w-3 h-3" />
                {memoryUsage.total > 0
                  ? `${(memoryUsage.used / 1024 ** 3).toFixed(1)} / ${(memoryUsage.total / 1024 ** 3).toFixed(0)} GB`
                  : `${(memoryUsage.used / 1024 / 1024).toFixed(0)} MB`}
              </span>
            )}

            {/* System resources (RAM, GPU) - opt-in to avoid any render overhead */}
            {showResourceMonitor && (
              <div className="border-l border-slate-200 pl-3">
                <ResourceStatusBar serverId={selectedServerId} />
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onRefresh={handleSettingsChange}
        isLoginNode={computeEnabled}
      />

      {/* Kernel Manager Modal */}
      <KernelManager
        isOpen={isKernelManagerOpen}
        onClose={() => setIsKernelManagerOpen(false)}
        currentSessionId={kernelSessionId}
        serverId={selectedServerId}
        onKernelKilled={(sessionId) => {
          // If the killed kernel was our current session, reset state
          if (sessionId === kernelSessionId) {
            setKernelSessionId(null);
            setIsKernelReady(false);
            setKernelStatus('disconnected');
          }
        }}
      />

      {/* Compute Allocation Modal */}
      <ComputeAllocationModal
        isOpen={showComputeModal}
        onClose={() => setShowComputeModal(false)}
        onChanged={refreshClusterInfo}
        onUseForKernels={(serverId) => {
          setPendingAllocSwitch(null);
          switchServer(serverId);
          setIsKernelMenuOpen(true); // guide the user straight to picking a kernel
          toast('Switched to the allocation — choose a kernel to start', 'info', 5000);
        }}
        onUseWhenReady={(allocationId) => {
          setPendingAllocSwitch(allocationId);
          toast('Kernels will switch to the allocation as soon as it is ready', 'info', 5000);
        }}
      />

      {/* Login-node kernel guard: asked once, then remembered */}
      {loginNodePrompt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" onClick={() => setLoginNodePrompt(null)}>
          <div className="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2">
              <Server className="w-4 h-4 text-blue-600" />
              <h3 className="text-sm font-semibold text-slate-900">Run on the login node?</h3>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              This node runs a scheduler, so it's a shared login node. A kernel here competes with
              other users for CPU and memory. For anything heavier than light editing, allocate a
              compute job instead — your kernel then runs on a dedicated compute node.
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => { saveSettings({ allowLoginNodeKernels: 'deny' }); setLoginNodePrompt(null); setShowComputeModal(true); }}
                className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md flex items-center justify-center gap-1.5 transition-colors"
              >
                <Cpu className="w-3.5 h-3.5" /> Allocate compute instead
              </button>
              <button
                onClick={() => { const p = loginNodePrompt; saveSettings({ allowLoginNodeKernels: 'allow' }); setLoginNodePrompt(null); if (p) switchKernel(p.kernelName, p.serverId, p.keepMenuOpen, p.source, true); }}
                className="w-full px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium rounded-md transition-colors"
              >
                Run here anyway
              </button>
            </div>
            <p className="text-[0.7rem] text-slate-400 mt-3 text-center">
              Remembered for next time — change it under Settings → General.
            </p>
          </div>
        </div>
      )}

      {/* ipykernel install prompt (VSCode-style: one Install button, honest failure) */}
      {ipykernelPrompt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" onClick={() => { if (!isInstallingIpykernel) setIpykernelPrompt(null); }}>
          <div className="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2">
              <Download className="w-4 h-4 text-blue-600" />
              <h3 className="text-sm font-semibold text-slate-900">ipykernel required</h3>
            </div>
            <p className="text-sm text-slate-600 mb-1">
              Running cells with <span className="font-medium text-slate-800">{ipykernelPrompt.display_name}</span> requires
              the <code className="px-1 py-0.5 rounded bg-slate-100 text-slate-700">ipykernel</code> package.
            </p>
            <p className="text-[0.7rem] text-slate-400 font-mono truncate mb-3" title={ipykernelPrompt.path}>{ipykernelPrompt.path}</p>

            {ipykernelPrompt.externally_managed && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded p-2 mb-3">
                This Python is externally managed (PEP 668), so Nebula won't install into it.
                Copy the command below to set up ipykernel in an isolated environment, then Refresh.
              </p>
            )}

            {/* Live installer output — streamed from the backend as it runs */}
            {(isInstallingIpykernel || ipykernelInstallOutput) && !ipykernelPrompt.externally_managed && (
              <pre
                ref={installOutputRef}
                className="text-[0.65rem] font-mono whitespace-pre-wrap break-all bg-slate-900 text-slate-200 rounded p-2 mb-3 max-h-40 overflow-y-auto"
              >
                {ipykernelInstallOutput || 'Choosing installer…'}
              </pre>
            )}

            {!ipykernelPrompt.externally_managed && ipykernelInstallError && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-100 rounded p-2 mb-3">
                <div className="font-medium mb-1">Install failed</div>
                <pre className="whitespace-pre-wrap break-all max-h-32 overflow-y-auto font-mono text-[0.65rem]">{ipykernelInstallError.message}</pre>
                {ipykernelInstallError.hint && (
                  <div className="mt-1.5 text-slate-600">
                    Manual alternative: <code className="px-1 py-0.5 rounded bg-white/80 break-all">{ipykernelInstallError.hint}</code>
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col gap-2">
              {!ipykernelPrompt.externally_managed && (
                <button
                  onClick={() => installIpykernelForEnv(ipykernelPrompt)}
                  disabled={isInstallingIpykernel}
                  className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-medium rounded-md flex items-center justify-center gap-1.5 transition-colors"
                >
                  {isInstallingIpykernel
                    ? (<><Loader2 className="w-3.5 h-3.5 animate-spin" /> Installing ipykernel…</>)
                    : (<><Download className="w-3.5 h-3.5" /> {ipykernelInstallError ? 'Retry install' : 'Install ipykernel'}</>)}
                </button>
              )}
              <button
                onClick={() => { copyInstallHint(ipykernelPrompt); }}
                disabled={isInstallingIpykernel}
                className="w-full px-3 py-2 bg-slate-100 hover:bg-slate-200 disabled:opacity-60 text-slate-700 text-sm font-medium rounded-md flex items-center justify-center gap-1.5 transition-colors"
              >
                <Terminal className="w-3.5 h-3.5" /> Copy command to run myself
              </button>
              <button
                onClick={() => setIpykernelPrompt(null)}
                disabled={isInstallingIpykernel}
                className="w-full px-3 py-1.5 text-slate-500 hover:text-slate-700 text-xs transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notebook Search */}
      <NotebookSearch
        cells={cells}
        isOpen={isSearchOpen}
        readOnly={isSealedReadOnly}
        onClose={handleSearchClose}
        onNavigateToCell={navigateToCell}
        getCursorAnchor={getCursorAnchor}
        onSearchChange={handleSearchChange}
        onReplace={isSealedReadOnly ? undefined : handleReplace}
        onReplaceAllInCell={isSealedReadOnly ? undefined : handleReplaceAllInCell}
        onReplaceAllInNotebook={isSealedReadOnly ? undefined : handleReplaceAllInNotebook}
        activeCellId={activeCellId}
        initialQuery={searchSeed !== null ? searchSeed : undefined}
      />

      {/* Keyboard Shortcuts Help Modal */}
      {isKeyboardHelpOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setIsKeyboardHelpOpen(false)}>
          <ModalShell
            onClose={() => setIsKeyboardHelpOpen(false)}
            label="Keyboard shortcuts"
            className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[80vh] overflow-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold text-slate-800">Keyboard Shortcuts</h2>
              <button onClick={() => setIsKeyboardHelpOpen(false)} className="p-1 hover:bg-slate-100 rounded" aria-label="Close keyboard shortcuts">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              {/* Mode explanation */}
              <div className="bg-slate-50 rounded p-3 text-xs text-slate-600">
                <div className="flex items-center gap-2 mb-1">
                  <span className="inline-block w-3 h-3 rounded border-2 border-blue-400"></span>
                  <strong>Edit mode</strong>: Click editor to edit code
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded border-2 border-green-500"></span>
                  <strong>Cell mode</strong>: Click header or press Escape for cell commands
                </div>
              </div>
              <div>
                <h3 className="text-sm font-medium text-slate-600 mb-2">Run (works in both modes)</h3>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-slate-600">Run and advance (preserves mode)</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Shift + Enter</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Run cell</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Ctrl/Cmd + Enter</kbd></div>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-medium text-slate-600 mb-2">Cell Mode (green border)</h3>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-slate-600">Navigate cells</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">↑ / ↓</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Extend cell selection</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Shift + ↑/↓ (or Shift + Click)</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Enter edit mode</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Enter</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Insert cell above / below</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">A / B</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Delete cell</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Delete / Backspace</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Move cell up / down</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Cmd/Ctrl + Shift + ↑/↓</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Cut / Copy / Paste cell</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">X / C / V</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Enqueue / Dequeue cell (FIFO)</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">E / D</kbd></div>
                  <div className="text-[0.6875rem] text-slate-400 mt-1">Jupyter classic keys (enable in Settings): dd delete · z undo · Shift+Z redo · 00 restart kernel · ii interrupt</div>
                  <div className="flex justify-between"><span className="text-slate-600">Convert to Markdown / Code</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">M / Y</kbd></div>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-medium text-slate-600 mb-2">Edit Mode (blue border)</h3>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-slate-600">Exit to cell mode</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Escape</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Move to previous / next cell (at first / last line)</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">↑ / ↓</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Undo / Redo (text only)</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Cmd/Ctrl + Z / Y</kbd></div>
                  <div className="text-[0.6875rem] text-slate-400 mt-2">Editing uses CodeMirror keybindings (most standard editor shortcuts apply).</div>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-medium text-slate-600 mb-2">Global (works everywhere)</h3>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-slate-600">Save</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Cmd/Ctrl + S</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Search</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Cmd/Ctrl + F</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Go to cell / spotlight search</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Cmd/Ctrl + P</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Command Palette (run commands)</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Cmd/Ctrl + Shift + P</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Toggle terminal panel</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Ctrl + `</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Toggle history panel</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Cmd/Ctrl + Shift + H</kbd></div>
                </div>
              </div>
            </div>
          </ModalShell>
        </div>
      )}
    </div>
  );
};
