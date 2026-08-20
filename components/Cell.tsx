import React, { useState, useCallback, memo, useRef, useEffect, useMemo } from 'react';
import { Cell as ICell, CellType } from '../types';
import { CellOutput } from './CellOutput';
import { CodeEditor } from './CodeEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { computeLineDiff } from '../lib/diffUtils';
import { Play, Trash2, ArrowUp, ArrowDown, Bot, Loader2, FileText, Code as CodeIcon, Plus, GripVertical } from 'lucide-react';
import { agentTerminalService, SendResult } from '../services/agentTerminalService';
import { useNotification } from './NotificationSystem';
import { IndentationConfig, DEFAULT_INDENTATION } from '../utils/indentationDetector';
import { shouldForceInteractiveFeatures } from '../utils/editorPerf';

interface SearchHighlight {
  query: string;
  caseSensitive: boolean;
  useRegex: boolean;
  currentMatch?: { cellId: string; startIndex: number; endIndex: number } | null;
}

type FocusMode = 'cell' | 'editor';

/**
 * Cursor-style inline line diff shown while previewing history: red lines
 * exist in this (old) version but are gone now, green lines were added since.
 * Read-only; long unchanged runs collapse into "⋯ N unchanged lines".
 */
const PreviewLineDiff: React.FC<{ oldContent: string; newContent: string }> = ({ oldContent, newContent }) => {
  const rows = useMemo(() => computeLineDiff(oldContent, newContent), [oldContent, newContent]);
  let removedIdx = 0;
  let addedIdx = 0;
  return (
    <div className="font-mono text-xs leading-5 overflow-x-auto py-1" data-testid="preview-line-diff">
      {rows.map((row, i) => {
        if (row.kind === 'gap') {
          return (
            <div key={i} className="px-3 py-0.5 text-slate-400 bg-slate-50 select-none">
              ⋯ {row.hiddenCount} unchanged line{row.hiddenCount === 1 ? '' : 's'}
            </div>
          );
        }
        const testId =
          row.kind === 'removed' ? `diff-line-removed-${removedIdx++}` :
          row.kind === 'added' ? `diff-line-added-${addedIdx++}` :
          undefined;
        const rowClass =
          row.kind === 'removed' ? 'bg-red-50 text-red-800' :
          row.kind === 'added' ? 'bg-green-50 text-green-800' :
          'text-slate-600';
        const marker = row.kind === 'removed' ? '−' : row.kind === 'added' ? '+' : ' ';
        return (
          <div key={i} data-testid={testId} className={`flex px-3 whitespace-pre ${rowClass}`}>
            <span className="w-4 flex-shrink-0 select-none opacity-60">{marker}</span>
            <span>{row.text || ' '}</span>
          </div>
        );
      })}
    </div>
  );
};

interface Props {
  cell: ICell;
  index: number;
  isActive: boolean;
  isSelected?: boolean; // Part of a multi-cell selection
  isHighlighted?: boolean; // Visual feedback for undo/redo
  agentActive?: boolean; // Agent recently touched this cell (collaborative session presence)
  isLocked?: boolean; // When true, cell is read-only (e.g., during agent session)
  allCellsRef: React.RefObject<ICell[]>; // Ref to avoid holding the entire cells array in fiber props
  cellIndexMapRef: React.RefObject<Map<string, number>>; // cellId → index, updated each render
  onUpdate: (id: string, content: string) => void;
  onAIUpdate?: (id: string, content: string) => void; // For AI edits (tracked in undo history)
  onFlush?: (id: string, content: string) => void; // Flush pending content on blur
  onRun: (id: string) => void;
  onRunAndAdvance: (id: string, focusMode: FocusMode) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, direction: 'up' | 'down') => void;
  onChangeType: (id: string, type: CellType) => void;
  onClick: (id: string, event: React.MouseEvent) => void;
  onActivate: (id: string) => void; // Set as active cell
  onNavigateCell: (direction: 'up' | 'down') => void; // Navigate to adjacent cell (handles virtualization)
  onEditorBoundaryNavigate?: (id: string, direction: 'up' | 'down') => void; // Arrow past first/last line of the editor → adjacent cell
  onReorder?: (draggedId: string, targetId: string, position: 'above' | 'below') => void; // Drag-and-drop cell reorder
  onAddCell: (afterIndex: number) => void;
  onSave?: () => void;
  onSetCellScrolled?: (id: string, scrolled: boolean) => void; // Toggle output scroll/wrap mode
  onSetCellScrolledHeight?: (id: string, height: number) => void; // Set output area height in scroll mode
  onCursorActivity?: (cellId: string, pos: number) => void; // For search navigation relative to cursor
  searchHighlight?: SearchHighlight | null;
  searchCurrentMatch?: { cellId: string; startIndex: number; endIndex: number } | null;
  queuePosition?: number; // Position in execution queue (-1 or undefined = not queued)
  indentConfig?: IndentationConfig; // Detected indentation configuration
  requestedFocusMode?: 'cell' | 'editor' | null; // Focus mode requested by Notebook
  onFocusModeApplied?: () => void; // Callback when focus mode has been applied
  onSearchEscape?: () => boolean; // Close search when open; returns true when handled
  showLineNumbers?: boolean; // Show line numbers in editor
  showCellIds?: boolean; // Show cell IDs in the cell header
  previewDiffStatus?: 'same' | 'modified' | 'deleted'; // For history preview: how this cell differs from current
  previewDiffAgainst?: string; // Current content to line-diff against (preview shows the OLD content); '' for deleted cells
  kernelSessionId?: string; // Kernel session for live completions
}

const CellComponent: React.FC<Props> = ({
  cell,
  index,
  isActive,
  isSelected = false,
  isHighlighted = false,
  agentActive = false,
  isLocked = false,
  allCellsRef,
  cellIndexMapRef,
  onUpdate,
  onAIUpdate,
  onFlush,
  onRun,
  onRunAndAdvance,
  onDelete,
  onMove,
  onChangeType,
  onClick,
  onActivate,
  onNavigateCell,
  onEditorBoundaryNavigate,
  onReorder,
  onAddCell,
  onSave,
  onSetCellScrolled,
  onSetCellScrolledHeight,
  onCursorActivity,
  searchHighlight,
  searchCurrentMatch,
  queuePosition,
  indentConfig = DEFAULT_INDENTATION,
  requestedFocusMode,
  onFocusModeApplied,
  onSearchEscape,
  showLineNumbers = false,
  showCellIds = false,
  previewDiffStatus,
  previewDiffAgainst,
  kernelSessionId,
}) => {
  const { toast } = useNotification();
  const [isAiOpen, setIsAiOpen] = useState(false);
  // Sticky toolbar: true while the toolbar block is pinned to the viewport
  // top (its sentinel has scrolled above it). Drives stuck-only styling —
  // squared corners (no see-through notches over code) and a shadow.
  const [isToolbarStuck, setIsToolbarStuck] = useState(false);
  const stickySentinelRef = useRef<HTMLDivElement>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  // Focus state: 'editor' = editing code, 'cell' = command mode, 'none' = unfocused
  const [focusState, setFocusState] = useState<'none' | 'cell' | 'editor'>('none');

  // ⚠️ PERFORMANCE CRITICAL: All callbacks passed to CodeEditor MUST be stable.
  // CodeEditor rebuilds extensions when onKeyDown/onFocus/onBlur change.
  // Use refs for any value that changes frequently (cell.content, callbacks).
  // If typing becomes laggy, check if any handler dependency changes per-keystroke.
  const onRunRef = useRef(onRun);
  const onRunAndAdvanceRef = useRef(onRunAndAdvance);
  const onSaveRef = useRef(onSave);
  const onFlushRef = useRef(onFlush);
  const onActivateRef = useRef(onActivate);
  const onUpdateRef = useRef(onUpdate);
  const onCursorActivityRef = useRef(onCursorActivity);
  const onSearchEscapeRef = useRef(onSearchEscape);
  const onEditorBoundaryNavigateRef = useRef(onEditorBoundaryNavigate);
  const onReorderRef = useRef(onReorder);
  const cellIdRef = useRef(cell.id);
  const cellContentRef = useRef(cell.content);
  const isLockedRef = useRef(isLocked);

  useEffect(() => {
    onRunRef.current = onRun;
    onRunAndAdvanceRef.current = onRunAndAdvance;
    onSaveRef.current = onSave;
    onFlushRef.current = onFlush;
    onActivateRef.current = onActivate;
    onUpdateRef.current = onUpdate;
    onCursorActivityRef.current = onCursorActivity;
    onSearchEscapeRef.current = onSearchEscape;
    onEditorBoundaryNavigateRef.current = onEditorBoundaryNavigate;
    onReorderRef.current = onReorder;
    cellIdRef.current = cell.id;
    cellContentRef.current = cell.content;
    isLockedRef.current = isLocked;
  });

  // Ref to cell container for focusing in command mode
  const cellRef = useRef<HTMLDivElement>(null);
  // Track if we should focus cell div after blur (e.g., after Escape)
  const focusCellAfterBlurRef = useRef(false);

  // Apply requested focus mode from Notebook (handles virtualization properly)
  useEffect(() => {
    if (requestedFocusMode === 'editor') {
      // Setting focusState triggers CodeEditor's shouldFocus mechanism
      setFocusState('editor');
      // Clear pendingFocus after a tick to avoid re-render cascade
      // (the focus will happen async via CodeEditor's useEffect)
      setTimeout(() => onFocusModeApplied?.(), 0);
    } else if (requestedFocusMode === 'cell') {
      cellRef.current?.focus({ preventScroll: true });
      // For cell mode, focus is synchronous, so clear immediately
      onFocusModeApplied?.();
    }
  }, [requestedFocusMode, onFocusModeApplied]);

  // Handle focus/blur to track focus state
  const handleEditorFocus = useCallback(() => {
    setFocusState('editor');
    onActivateRef.current(cellIdRef.current);
  }, []);

  // ⚠️ CRITICAL: These callbacks MUST be stable (empty deps) to prevent CodeEditor
  // from rebuilding extensions on every render. Use refs to access current values.
  const handleShiftEnter = useCallback(() => {
    if (isLockedRef.current) return;
    onRunAndAdvanceRef.current(cellIdRef.current, 'editor');
  }, []);

  const handleModEnter = useCallback(() => {
    if (isLockedRef.current) return;
    onRunRef.current(cellIdRef.current);
  }, []);

  const handleEditorEscape = useCallback(() => {
    const searchClosed = onSearchEscapeRef.current?.() ?? false;
    if (searchClosed) {
      return true; // Keep editor focus after closing search.
    }
    focusCellAfterBlurRef.current = true;
    return false; // Allow editor to blur into command mode.
  }, []);

  const handleEditorSave = useCallback(() => {
    if (isLockedRef.current) return;
    onSaveRef.current?.();
  }, []);

  // Arrow past the editor's first/last line → move focus to the adjacent cell.
  // Must be stable (empty deps) — CodeEditor rebuilds extensions when they change.
  const handleEditorNavigateUp = useCallback(() => {
    onEditorBoundaryNavigateRef.current?.(cellIdRef.current, 'up');
  }, []);

  const handleEditorNavigateDown = useCallback(() => {
    onEditorBoundaryNavigateRef.current?.(cellIdRef.current, 'down');
  }, []);

  // Stable onChange handler for CodeEditor
  const handleEditorChange = useCallback((value: string) => {
    if (isLockedRef.current) return;
    onUpdateRef.current(cellIdRef.current, value);
  }, []);

  const handleCursorActivity = useCallback((pos: number) => {
    onCursorActivityRef.current?.(cellIdRef.current, pos);
  }, []);

  const handleEditorBlur = useCallback(() => {
    setFocusState('none');
    // Flush pending content on blur (keyframe for undo history)
    if (!isLockedRef.current && onFlushRef.current) {
      onFlushRef.current(cellIdRef.current, cellContentRef.current);
    }
    // Focus cell div if requested (e.g., after Escape key) to enter command mode
    if (focusCellAfterBlurRef.current) {
      focusCellAfterBlurRef.current = false;
      setTimeout(() => cellRef.current?.focus({ preventScroll: true }), 0);
    }
  }, []);

  const handleCellFocus = useCallback((e: React.FocusEvent) => {
    // Only handle if the cell div itself is focused, not a child (like the editor)
    if (e.target === e.currentTarget) {
      setFocusState('cell');
      onActivateRef.current(cellIdRef.current);
    }
  }, []);

  const handleCellBlur = useCallback((e: React.FocusEvent) => {
    // Only handle if focus is leaving the cell div itself
    if (e.target === e.currentTarget) {
      setFocusState('none');
    }
  }, []);

  // Cell AI actions inject prompts into the agent terminal (Claude Code /
  // Codex driving the notebook via MCP) instead of calling a model API.
  const cellNumber = () => (cellIndexMapRef.current?.get(cell.id) ?? index) + 1;

  const reportAgentSend = (result: SendResult) => {
    if (result.ok) {
      // Surface the agent tab so the user sees the prompt land — sends also
      // work while the panel is hidden (the pty connection stays alive).
      agentTerminalService.openPanel();
      toast('Sent to agent — watch the Agent tab below', 'success', 2500);
    } else if (result.reason === 'agent-not-running') {
      toast('No agent is running yet — opened the Agent tab: click "Claude Code" or "Codex" to launch one, then retry', 'info', 6000);
    } else {
      toast('Agent terminal is not connected — opened the Agent tab; wait for it to connect and try again', 'info', 5000);
    }
  };

  const handleAgentPrompt = () => {
    if (isLocked) return;
    const prompt = aiPrompt.trim();
    if (!prompt) return;
    const result = agentTerminalService.sendCellPrompt({
      cellNumber: cellNumber(),
      cellId: cell.id,
      prompt,
    });
    if (result.ok) {
      setAiPrompt('');
      setIsAiOpen(false);
    }
    reportAgentSend(result);
  };

  const handleAgentFix = () => {
    if (isLocked) return;
    const errorOutput = cell.outputs.find(o => o.type === 'error' || o.type === 'stderr');
    if (!errorOutput) return;
    const result = agentTerminalService.sendFixPrompt({
      cellNumber: cellNumber(),
      cellId: cell.id,
      errorContent: errorOutput.content,
    });
    reportAgentSend(result);
  };

  const hasError = cell.outputs.some(o => o.type === 'error');
  const enableInteractiveFeatures = shouldForceInteractiveFeatures() || focusState === 'editor';

  // Lazy CodeMirror: show <pre> until cell enters viewport, then swap to CM.
  // Pin the wrapper at <pre> height during the swap to absorb CM's async
  // measurement oscillation (CM estimates height, then re-measures when lines
  // enter its viewport — causing 500px+ height changes). When CM settles,
  // release the pin. The <pre> → settled CM delta is typically <10px.
  const [editorMounted, setEditorMounted] = useState(false);
  const editorWrapRef = useRef<HTMLDivElement>(null);

  // Stuck detection for the sticky toolbar: the zero-height sentinel sits
  // just above the sticky block; when it leaves through the viewport top the
  // block is pinned. (position:sticky itself has no CSS-observable state.)
  useEffect(() => {
    const el = stickySentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      setIsToolbarStuck(!entry.isIntersecting && entry.boundingClientRect.top < 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (editorMounted) return;
    const el = cellRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          // Lock wrapper at <pre> height BEFORE React swaps to CM
          const wrap = editorWrapRef.current;
          if (wrap) {
            const h = wrap.offsetHeight;
            wrap.style.height = `${h}px`;
            wrap.style.overflow = 'hidden';
          }
          setEditorMounted(true);
          observer.disconnect();
        }
      },
      { rootMargin: '300px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [editorMounted]);

  // After CM mounts: wait for it to settle (stop resizing), then release pin
  useEffect(() => {
    if (!editorMounted) return;
    const wrap = editorWrapRef.current;
    if (!wrap) return;

    // ResizeObserver may not exist in test environments
    if (typeof ResizeObserver === 'undefined') {
      wrap.style.height = '';
      wrap.style.overflow = '';
      return;
    }

    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        wrap.style.height = '';
        wrap.style.overflow = '';
        observer.disconnect();
      }, 150);
    });
    observer.observe(wrap);

    // Fallback release after 1s
    const fallback = setTimeout(() => {
      wrap.style.height = '';
      wrap.style.overflow = '';
      observer.disconnect();
    }, 1000);

    return () => {
      observer.disconnect();
      if (settleTimer) clearTimeout(settleTimer);
      clearTimeout(fallback);
    };
  }, [editorMounted]);

  useEffect(() => {
    if (focusState === 'editor' && !editorMounted) {
      setEditorMounted(true);
    }
  }, [editorMounted, focusState]);

  // Border colors based on focus state:
  // - editor (blue): CodeMirror has focus, handles keyboard
  // - cell (green): cell div has focus, cell-level commands
  // - none (slate): unfocused
  // In preview mode, show diff highlighting
  const getBorderClass = () => {
    if (hasError) return 'border-red-200';
    if (focusState === 'editor') return 'border-blue-400 ring-1 ring-blue-100';
    if (focusState === 'cell') return 'border-green-500 ring-1 ring-green-100';
    // Preview diff highlighting
    if (previewDiffStatus === 'modified') return 'border-orange-400 ring-2 ring-orange-100 bg-orange-50/30';
    if (previewDiffStatus === 'deleted') return 'border-red-400 ring-2 ring-red-100 bg-red-50/30';
    return 'border-slate-200 hover:border-slate-300';
  };

  // Handle topbar click - enter command mode (focus cell div)
  const handleTopbarClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    // Focus the cell div - this will trigger handleCellFocus
    // Use preventScroll to avoid unwanted page scrolling
    cellRef.current?.focus({ preventScroll: true });
  }, []);

  const handleMarkdownPreviewClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClick(cell.id, e);
    cellRef.current?.focus({ preventScroll: true });
  }, [cell.id, onClick]);

  const handleMarkdownPreviewDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClick(cell.id, e);
    if (isLocked) {
      cellRef.current?.focus({ preventScroll: true });
      return;
    }
    setFocusState('editor');
  }, [cell.id, isLocked, onClick]);

  // Handle keyboard shortcuts when cell div has focus (command mode)
  const handleCellKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Only handle when cell div itself has focus (not bubbled from editor)
    // Without this check, Shift+Enter would execute twice (once from CodeMirror, once from here)
    if (focusState !== 'cell') return;

    // Cmd/Ctrl+Shift+Arrow: move cell position (blocked when locked)
    if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isLocked) onMove(cell.id, 'up');
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!isLocked) onMove(cell.id, 'down');
        return;
      }
    }

    // Arrow up/down: navigate between cells (handled by Notebook for virtualization)
    if (e.key === 'ArrowUp' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const cellIdx = cellIndexMapRef.current?.get(cellIdRef.current) ?? -1;
      if (cellIdx > 0) {
        onNavigateCell('up');
      }
      return;
    }
    if (e.key === 'ArrowDown' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const currentCells = allCellsRef.current;
      const cellIdx = cellIndexMapRef.current?.get(cellIdRef.current) ?? -1;
      if (cellIdx >= 0 && cellIdx < currentCells.length - 1) {
        onNavigateCell('down');
      }
      return;
    }

    // Enter: focus editor (enter edit mode) - blocked when locked
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (isLocked) return; // Can't enter edit mode when locked
      // Set state to trigger shouldFocus, which will focus the editor
      setFocusState('editor');
      return;
    }

    // Delete/Backspace: delete cell (blocked when locked)
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (!isLocked) onDelete(cell.id);
      return;
    }

    // Shift+Enter: run and advance (stay in cell mode)
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      if (isLocked) return;
      onRunAndAdvanceRef.current(cell.id, 'cell');
      return;
    }

    // Ctrl/Cmd+Enter: run cell
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (isLocked) return;
      onRunRef.current(cell.id);
      return;
    }
  }, [cell.id, onMove, onDelete, focusState, isLocked]);

  const showsMarkdownPreview = cell.type === 'markdown' && focusState !== 'editor';

  // ── Drag-and-drop reorder ──
  const [dropIndicator, setDropIndicator] = useState<'above' | 'below' | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const CELL_DRAG_MIME = 'application/x-nebula-cell';

  const handleGripDragStart = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    e.dataTransfer.setData(CELL_DRAG_MIME, cellIdRef.current);
    e.dataTransfer.effectAllowed = 'move';
    if (cellRef.current) {
      e.dataTransfer.setDragImage(cellRef.current, 24, 24);
    }
    setIsDragging(true);
  }, []);

  const handleGripDragEnd = useCallback(() => setIsDragging(false), []);

  const handleCellDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(CELL_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const next: 'above' | 'below' = e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
    setDropIndicator(prev => (prev === next ? prev : next));
  }, []);

  const handleCellDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropIndicator(null);
  }, []);

  const handleCellDrop = useCallback((e: React.DragEvent) => {
    const draggedId = e.dataTransfer.getData(CELL_DRAG_MIME);
    setDropIndicator(prev => {
      if (draggedId && draggedId !== cellIdRef.current && prev) {
        onReorderRef.current?.(draggedId, cellIdRef.current, prev);
      }
      return null;
    });
    if (draggedId) e.preventDefault();
  }, []);

  return (
    <div
      ref={cellRef}
      data-cell-id={cell.id}
      onClick={(e) => onClick(cell.id, e)}
      onKeyDown={handleCellKeyDown}
      onFocus={handleCellFocus}
      onBlur={handleCellBlur}
      onDragOver={onReorder ? handleCellDragOver : undefined}
      onDragLeave={onReorder ? handleCellDragLeave : undefined}
      onDrop={onReorder ? handleCellDrop : undefined}
      tabIndex={isActive ? 0 : -1}
      className={`group relative mb-2 rounded-lg border bg-white shadow-sm transition-all hover:shadow-md ${getBorderClass()} ${isHighlighted ? 'cell-highlight-animation' : ''} ${agentActive ? 'ring-2 ring-purple-300 ring-offset-1' : ''} ${isSelected ? 'ring-2 ring-blue-300 border-blue-300 bg-blue-50/40' : ''} ${isDragging ? 'opacity-50' : ''} ${focusState === 'cell' ? 'outline-none' : ''}`}
      style={dropIndicator ? { boxShadow: dropIndicator === 'above' ? 'inset 0 3px 0 0 #3b82f6' : 'inset 0 -3px 0 0 #3b82f6' } : undefined}
    >
      {/* Sticky toolbar block: pins to the viewport top while any part of
          this cell spans it (VS Code / JupyterLab pattern), so Run/AI/etc —
          and the agent prompt bar — stay reachable from the bottom of a long
          cell. The sentinel right above it is how we know we're pinned. */}
      <div ref={stickySentinelRef} data-testid={`cell-sticky-sentinel-${cell.id}`} aria-hidden="true" />
      <div
        data-testid={`cell-sticky-bar-${cell.id}`}
        className={`sticky top-0 z-30 ${isToolbarStuck ? 'shadow-md' : ''}`}
      >
      {/* Top Toolbar - click here to enter command mode */}
      <div
        className={`flex items-center gap-1 px-2 py-1 bg-slate-50 border-b border-slate-100 cursor-pointer ${isToolbarStuck ? '' : 'rounded-t-lg'}`}
        onClick={handleTopbarClick}
      >
        {/* Left: Cell info, Run button, and action buttons */}
        <div className="flex items-center gap-0.5">
          {onReorder && !isLocked && (
            <span
              draggable
              onDragStart={handleGripDragStart}
              onDragEnd={handleGripDragEnd}
              onClick={(e) => e.stopPropagation()}
              className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 -ml-1 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Drag to reorder cell"
              aria-label="Drag to reorder cell"
            >
              <GripVertical className="w-3.5 h-3.5" />
            </span>
          )}
          <span className="text-[0.625rem] font-mono font-bold text-slate-400 min-w-[1.5rem]">
            #{(cellIndexMapRef.current?.get(cell.id) ?? index) + 1}
          </span>
          {showCellIds && (
            <span
              className="text-[0.625rem] font-mono text-slate-400 truncate max-w-[11.25rem]"
              title={cell.id}
            >
              {cell.id}
            </span>
          )}
          {/* Execution feedback: [ ] = never run, [*] = executing/queued, [n] = executed n times */}
          {cell.isExecuting ? (
            <span className="text-[0.625rem] font-mono text-amber-600 animate-pulse" title="Executing...">
              [*]
            </span>
          ) : queuePosition !== undefined && queuePosition >= 0 ? (
            <span className="text-[0.625rem] font-mono text-amber-600 animate-pulse" title={`Queued at position ${queuePosition + 1}`}>
              [*]
            </span>
          ) : cell.executionCount !== undefined ? (
            <span className="text-[0.625rem] font-mono text-green-600">[{cell.executionCount}]</span>
          ) : cell.type === 'code' ? (
            <span className="text-[0.625rem] font-mono text-slate-400" title="Not yet executed">
              [ ]
            </span>
          ) : null}
          <button
            onClick={(e) => { e.stopPropagation(); if (!isLocked) onRun(cell.id); }}
            disabled={isLocked}
            className={`p-1 rounded ${isLocked ? 'text-slate-300 cursor-not-allowed' : 'text-slate-500 hover:text-green-600 hover:bg-green-50'}`}
            title={isLocked ? 'Read-only notebook' : 'Run Cell (Shift+Enter or Ctrl+Enter)'}
          >
            {cell.isExecuting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          </button>

          {/* Action buttons after Run */}
          <button
            onClick={(e) => { e.stopPropagation(); if (!isLocked) setIsAiOpen(!isAiOpen); }}
            disabled={isLocked}
            className={`p-1 rounded transition-colors ${isLocked ? 'text-slate-300 cursor-not-allowed' : isAiOpen ? 'text-purple-600 bg-purple-50' : 'text-slate-400 hover:text-purple-600 hover:bg-purple-50'}`}
            title={isLocked ? 'Read-only notebook: agent editing disabled' : 'AI Assistant'}
          >
            <Bot className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); if (!isLocked) onMove(cell.id, 'up'); }}
            disabled={isLocked}
            className={`p-1 text-slate-400 rounded opacity-0 group-hover:opacity-100 transition-opacity ${isLocked ? 'cursor-not-allowed opacity-50' : 'hover:text-slate-700 hover:bg-slate-100'}`}
            title={isLocked ? 'Read-only notebook: cannot move cell' : 'Move Up'}
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); if (!isLocked) onMove(cell.id, 'down'); }}
            disabled={isLocked}
            className={`p-1 text-slate-400 rounded opacity-0 group-hover:opacity-100 transition-opacity ${isLocked ? 'cursor-not-allowed opacity-50' : 'hover:text-slate-700 hover:bg-slate-100'}`}
            title={isLocked ? 'Read-only notebook: cannot move cell' : 'Move Down'}
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); if (!isLocked) onDelete(cell.id); }}
            disabled={isLocked}
            className={`p-1 text-slate-400 rounded opacity-0 group-hover:opacity-100 transition-opacity ${isLocked ? 'cursor-not-allowed opacity-50' : 'hover:text-red-600 hover:bg-red-50'}`}
            title={isLocked ? 'Read-only notebook: cannot delete cell' : 'Delete Cell'}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); if (!isLocked) { const idx = cellIndexMapRef.current?.get(cell.id) ?? -1; if (idx >= 0) onAddCell(idx); } }}
            disabled={isLocked}
            className={`p-1 text-slate-400 rounded opacity-0 group-hover:opacity-100 transition-opacity ${isLocked ? 'cursor-not-allowed opacity-50' : 'hover:text-blue-600 hover:bg-blue-50'}`}
            title={isLocked ? 'Read-only notebook: cannot add cell' : 'Add Cell Below'}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Center: Error fix button — hands the error to the agent terminal */}
        <div className="flex-1 flex justify-center">
          {hasError && (
            <button
              onClick={(e) => { e.stopPropagation(); if (!isLocked) handleAgentFix(); }}
              disabled={isLocked}
              className="flex items-center gap-1 text-[0.625rem] px-2 py-0.5 bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
              title="Send this cell's error to the agent (Claude Code / Codex) to fix"
            >
              <Bot className="w-3 h-3" />
              Fix with agent
            </button>
          )}
        </div>

        {/* Right: Cell type toggle */}
        <div className="flex gap-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); if (!isLocked) onChangeType(cell.id, 'code'); }}
            disabled={isLocked}
            title={isLocked ? 'Read-only notebook: cannot change cell type' : 'Change to code'}
            className={`text-[0.625rem] px-1.5 py-0.5 rounded flex items-center gap-0.5 ${isLocked ? 'cursor-not-allowed text-slate-300' : cell.type === 'code' ? 'bg-white shadow-sm text-slate-800 font-medium' : 'text-slate-400 hover:text-slate-600'}`}
          >
            <CodeIcon className="w-3 h-3" /> Code
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); if (!isLocked) onChangeType(cell.id, 'markdown'); }}
            disabled={isLocked}
            title={isLocked ? 'Read-only notebook: cannot change cell type' : 'Change to markdown'}
            className={`text-[0.625rem] px-1.5 py-0.5 rounded flex items-center gap-0.5 ${isLocked ? 'cursor-not-allowed text-slate-300' : cell.type === 'markdown' ? 'bg-white shadow-sm text-slate-800 font-medium' : 'text-slate-400 hover:text-slate-600'}`}
          >
            <FileText className="w-3 h-3" /> Text
          </button>
        </div>
      </div>

      {/* Agent Prompt Input — sends a cell-scoped instruction to the agent terminal */}
      {isAiOpen && (
        <div className="px-3 py-2 bg-purple-50 border-b border-purple-100 flex gap-2 items-center">
          <Bot className="w-4 h-4 text-purple-600 flex-shrink-0" />
          <input
            type="text"
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="Ask the agent to edit, debug, or explain this cell…"
            className="flex-grow bg-white border-purple-200 border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            onKeyDown={(e) => e.key === 'Enter' && handleAgentPrompt()}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={(e) => { e.stopPropagation(); handleAgentPrompt(); }}
            className="px-2 py-1 bg-purple-600 text-white text-xs font-medium rounded hover:bg-purple-700"
          >
            Send to agent
          </button>
        </div>
      )}
      </div>

      {/* Editor Area */}
      <div ref={editorWrapRef} onClick={(e) => {
        e.stopPropagation();
        if (!editorMounted && !showsMarkdownPreview) setEditorMounted(true);
        onClick(cell.id, e);
      }}>
        {previewDiffAgainst !== undefined && (previewDiffStatus === 'modified' || previewDiffStatus === 'deleted') ? (
          <PreviewLineDiff oldContent={cell.content} newContent={previewDiffAgainst} />
        ) : showsMarkdownPreview ? (
          <div
            className="cursor-default"
            onClick={handleMarkdownPreviewClick}
            onDoubleClick={handleMarkdownPreviewDoubleClick}
            title={isLocked ? undefined : 'Double-click or press Enter to edit'}
          >
            <MarkdownPreview
              content={cell.content}
              placeholder="## Markdown Title"
            />
          </div>
        ) : editorMounted ? (
          <CodeEditor
            value={cell.content}
            onChange={handleEditorChange}
            language={cell.type === 'code' ? 'python' : 'markdown'}
            enableInteractiveFeatures={enableInteractiveFeatures}
            onShiftEnter={handleShiftEnter}
            onModEnter={handleModEnter}
            onEscape={handleEditorEscape}
            onSave={handleEditorSave}
            onNavigateUp={handleEditorNavigateUp}
            onNavigateDown={handleEditorNavigateDown}
            onFocus={handleEditorFocus}
            onBlur={handleEditorBlur}
            placeholder={cell.type === 'code' ? 'print("Hello World")' : '## Markdown Title'}
            searchHighlight={searchHighlight ? { ...searchHighlight, currentMatch: searchCurrentMatch } : null}
            cellId={cell.id}
            shouldFocus={focusState === 'editor'}
            onCursorActivity={onCursorActivity ? handleCursorActivity : undefined}
            indentConfig={indentConfig}
            allCellsRef={allCellsRef}
            showLineNumbers={cell.type === 'code' && showLineNumbers}
            readOnly={isLocked}
            kernelSessionId={kernelSessionId}
          />
        ) : (
          <pre className="font-mono text-sm px-3 py-2 text-slate-700 whitespace-pre-wrap break-all min-h-[1.5rem]">
            {cell.content || (cell.type === 'code' ? 'print("Hello World")' : '## Markdown Title')}
          </pre>
        )}
      </div>

      {/* Output Area - show if has outputs, is executing, or has execution time */}
      {(cell.outputs.length > 0 || cell.isExecuting || cell.lastExecutionMs !== undefined) && (
         <div id={`cell-output-${cell.id}`} className="scroll-mt-20">
           <CellOutput
             outputs={cell.outputs}
             isUpdating={cell.isExecuting}
             executionMs={cell.lastExecutionMs}
             scrolled={cell.scrolled}
             onScrolledChange={onSetCellScrolled ? (scrolled) => onSetCellScrolled(cell.id, scrolled) : undefined}
             scrolledHeight={cell.scrolledHeight}
             onScrolledHeightChange={onSetCellScrolledHeight ? (height) => onSetCellScrolledHeight(cell.id, height) : undefined}
             kernelSessionId={kernelSessionId}
           />
         </div>
      )}
    </div>
  );
};

// Memoize Cell to prevent re-renders when only allCells changes
// Only compare props that affect rendering - NOT callback functions.
// Callbacks change frequently due to useUndoRedo's pushState dependency on present,
// but cells only need to re-render when their actual data changes.
export const Cell = memo(CellComponent, (prevProps, nextProps) => {
  // Return true if props are equal (skip re-render)
  // Only check visual state - not callbacks which change frequently
  return (
    prevProps.cell === nextProps.cell &&
    // index excluded — CSS counter handles "#N" label, no re-render needed
    prevProps.isActive === nextProps.isActive &&
    prevProps.isHighlighted === nextProps.isHighlighted &&
    prevProps.agentActive === nextProps.agentActive &&
    prevProps.isLocked === nextProps.isLocked &&
    prevProps.searchHighlight === nextProps.searchHighlight &&
    prevProps.searchCurrentMatch === nextProps.searchCurrentMatch &&
    prevProps.queuePosition === nextProps.queuePosition &&
    prevProps.indentConfig === nextProps.indentConfig &&
    prevProps.requestedFocusMode === nextProps.requestedFocusMode &&
    prevProps.previewDiffStatus === nextProps.previewDiffStatus &&
    prevProps.previewDiffAgainst === nextProps.previewDiffAgainst &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.showCellIds === nextProps.showCellIds &&
    // kernelSessionId changes rarely (kernel start/restart) but widget outputs
    // and kernel completions must see the new session, so it must trigger a render.
    prevProps.kernelSessionId === nextProps.kernelSessionId
  );
});
