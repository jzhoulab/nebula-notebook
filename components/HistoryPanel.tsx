/**
 * HistoryPanel - Timeline of notebook operations with preview and restore
 *
 * Features:
 * - View full edit history grouped by time
 * - Click any operation to preview notebook at that point
 * - Restore to any previous state (undoable) or save as new file
 *
 * Toggle via status bar "History" button.
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  History,
  X,
  Plus,
  Minus,
  ArrowUpDown,
  Edit3,
  Settings,
  Layers,
  Play,
  CheckCircle,
  XCircle,
  Square,
  RotateCcw,
  Camera,
  Filter,
  ChevronDown,
  ChevronRight,
  Sparkles,
  User,
  Eye,
  RotateCw,
  Power,
} from 'lucide-react';
import { TimestampedOperation } from '../hooks/useUndoRedo';
import { useModalA11y } from '../hooks/useModalA11y';

interface HistoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  history: TimestampedOperation[];
  defaultHeight?: number;
  onResetHistory?: () => void;
  // Preview functionality
  onPreview?: (timestamp: number) => void;
  onExitPreview?: () => void;
  previewTimestamp?: number | null;
  // Restore functionality
  onRequestRestore?: (timestamp: number) => void;
}

const MIN_HEIGHT = 150;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 250;

// Operation type metadata for display
const OPERATION_META: Record<string, { icon: React.FC<{ className?: string }>; color: string; label: string }> = {
  snapshot: { icon: Camera, color: 'text-slate-400', label: 'Snapshot' },
  insertCell: { icon: Plus, color: 'text-green-600', label: 'Insert Cell' },
  deleteCell: { icon: Minus, color: 'text-red-500', label: 'Delete Cell' },
  moveCell: { icon: ArrowUpDown, color: 'text-blue-500', label: 'Move Cell' },
  updateContent: { icon: Edit3, color: 'text-orange-500', label: 'Edit' },
  updateContentPatch: { icon: Edit3, color: 'text-orange-500', label: 'Edit' },
  updateMetadata: { icon: Settings, color: 'text-purple-500', label: 'Metadata' },
  batch: { icon: Layers, color: 'text-cyan-500', label: 'Batch' },
  runCell: { icon: Play, color: 'text-green-600', label: 'Run Cell' },
  runAllCells: { icon: Play, color: 'text-green-600', label: 'Run All' },
  runCellsAbove: { icon: Play, color: 'text-green-600', label: 'Run Above' },
  runCellsBelow: { icon: Play, color: 'text-green-600', label: 'Run Below' },
  runCellComplete: { icon: CheckCircle, color: 'text-green-600', label: 'Run Complete' },
  startKernel: { icon: Play, color: 'text-emerald-600', label: 'Kernel Start' },
  shutdownKernel: { icon: Power, color: 'text-amber-600', label: 'Kernel Shutdown' },
  interruptKernel: { icon: Square, color: 'text-amber-500', label: 'Interrupt' },
  restartKernel: { icon: RotateCcw, color: 'text-amber-500', label: 'Restart' },
};

type EventInfo = {
  category: string;
  name: string;
  target?: { cellId?: string; cellIndex?: number };
  data?: Record<string, unknown>;
  runId?: string;
};

function getEventInfo(op: TimestampedOperation): EventInfo | null {
  if (op.type === 'event') {
    return {
      category: (op as any).category,
      name: (op as any).name,
      target: (op as any).target,
      data: (op as any).data,
      runId: (op as any).runId,
    };
  }

  switch (op.type) {
    case 'runCell':
      return {
        category: 'execution',
        name: 'runCell',
        target: { cellId: (op as any).cellId, cellIndex: (op as any).cellIndex },
        runId: (op as any).runId,
      };
    case 'runAllCells':
      return {
        category: 'execution',
        name: 'runAllCells',
        data: {
          cellCount: (op as any).cellCount,
          cellIds: (op as any).cellIds,
        },
      };
    case 'runCellComplete':
      return {
        category: 'execution',
        name: 'runCellComplete',
        target: { cellId: (op as any).cellId, cellIndex: (op as any).cellIndex },
        data: {
          durationMs: (op as any).durationMs,
          success: (op as any).success,
          output: (op as any).output,
        },
        runId: (op as any).runId,
      };
    case 'interruptKernel':
    case 'restartKernel':
      return {
        category: 'kernel',
        name: op.type,
      };
    default:
      return null;
  }
}

function getOperationMeta(op: TimestampedOperation): { icon: React.FC<{ className?: string }>; color: string; label: string } {
  const event = getEventInfo(op);
  if (event) {
    return OPERATION_META[event.name] || { icon: Edit3, color: 'text-slate-400', label: event.name };
  }
  return OPERATION_META[op.type] || { icon: Edit3, color: 'text-slate-400', label: op.type };
}

// Format timestamp for display
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Format relative time (e.g., "2m ago")
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// Threshold for sub-grouping (if more than this, create sub-groups)
const SUB_GROUP_THRESHOLD = 15;

// Hierarchical group structure
interface OperationGroup {
  id: string;           // Unique ID for collapse state
  label: string;        // Display label
  level: number;        // Nesting level (0 = top, 1 = sub-group)
  operations: TimestampedOperation[];
  subGroups?: OperationGroup[];  // Optional sub-groups
}

// Format hour for display (e.g., "2:00 PM - 3:00 PM")
function formatHourRange(hour: number): string {
  const start = hour % 12 || 12;
  const end = (hour + 1) % 12 || 12;
  const startPeriod = hour < 12 ? 'AM' : 'PM';
  const endPeriod = (hour + 1) < 12 || (hour + 1) === 24 ? 'AM' : 'PM';
  return `${start}:00 ${startPeriod}`;
}

// Format date for display
function formatDayLabel(date: Date): string {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === now.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// Group operations by hour within a day
function groupByHour(operations: TimestampedOperation[], dayLabel: string): OperationGroup[] {
  const hourGroups = new Map<number, TimestampedOperation[]>();

  for (const op of operations) {
    const hour = new Date(op.timestamp).getHours();
    if (!hourGroups.has(hour)) {
      hourGroups.set(hour, []);
    }
    hourGroups.get(hour)!.push(op);
  }

  // Sort hours descending (most recent first)
  const sortedHours = Array.from(hourGroups.keys()).sort((a, b) => b - a);

  return sortedHours.map(hour => ({
    id: `${dayLabel}-${hour}`,
    label: formatHourRange(hour),
    level: 1,
    operations: hourGroups.get(hour)!,
  }));
}

// Group operations by day
function groupByDay(operations: TimestampedOperation[], periodLabel: string): OperationGroup[] {
  const dayGroups = new Map<string, TimestampedOperation[]>();

  for (const op of operations) {
    const date = new Date(op.timestamp);
    const dayKey = date.toDateString();
    if (!dayGroups.has(dayKey)) {
      dayGroups.set(dayKey, []);
    }
    dayGroups.get(dayKey)!.push(op);
  }

  // Sort days descending (most recent first)
  const sortedDays = Array.from(dayGroups.keys()).sort((a, b) =>
    new Date(b).getTime() - new Date(a).getTime()
  );

  return sortedDays.map(dayKey => {
    const ops = dayGroups.get(dayKey)!;
    const date = new Date(dayKey);
    const dayLabel = formatDayLabel(date);

    // If many ops in a day, sub-group by hour
    if (ops.length > SUB_GROUP_THRESHOLD) {
      return {
        id: `${periodLabel}-${dayKey}`,
        label: dayLabel,
        level: 1,
        operations: ops,
        subGroups: groupByHour(ops, dayKey),
      };
    }

    return {
      id: `${periodLabel}-${dayKey}`,
      label: dayLabel,
      level: 1,
      operations: ops,
    };
  });
}

function groupOperationsByTime(operations: TimestampedOperation[]): OperationGroup[] {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  // Categorize into top-level periods
  const justNow: TimestampedOperation[] = [];
  const today: TimestampedOperation[] = [];
  const yesterdayOps: TimestampedOperation[] = [];
  const thisWeek: TimestampedOperation[] = [];
  const older: TimestampedOperation[] = [];

  for (const op of operations) {
    const date = new Date(op.timestamp);
    const diffMs = now.getTime() - op.timestamp;
    const diffMins = diffMs / 60000;
    const diffDays = diffMs / 86400000;

    if (diffMins < 5) {
      justNow.push(op);
    } else if (date.toDateString() === now.toDateString()) {
      today.push(op);
    } else if (date.toDateString() === yesterday.toDateString()) {
      yesterdayOps.push(op);
    } else if (diffDays < 7) {
      thisWeek.push(op);
    } else {
      older.push(op);
    }
  }

  const result: OperationGroup[] = [];

  // Just Now - never sub-group
  if (justNow.length > 0) {
    result.push({
      id: 'just-now',
      label: 'Just Now',
      level: 0,
      operations: justNow,
    });
  }

  // Today - sub-group by hour if many
  if (today.length > 0) {
    if (today.length > SUB_GROUP_THRESHOLD) {
      result.push({
        id: 'today',
        label: 'Today',
        level: 0,
        operations: today,
        subGroups: groupByHour(today, 'today'),
      });
    } else {
      result.push({
        id: 'today',
        label: 'Today',
        level: 0,
        operations: today,
      });
    }
  }

  // Yesterday - sub-group by hour if many
  if (yesterdayOps.length > 0) {
    if (yesterdayOps.length > SUB_GROUP_THRESHOLD) {
      result.push({
        id: 'yesterday',
        label: 'Yesterday',
        level: 0,
        operations: yesterdayOps,
        subGroups: groupByHour(yesterdayOps, 'yesterday'),
      });
    } else {
      result.push({
        id: 'yesterday',
        label: 'Yesterday',
        level: 0,
        operations: yesterdayOps,
      });
    }
  }

  // This Week - sub-group by day
  if (thisWeek.length > 0) {
    result.push({
      id: 'this-week',
      label: 'This Week',
      level: 0,
      operations: thisWeek,
      subGroups: groupByDay(thisWeek, 'this-week'),
    });
  }

  // Older - sub-group by day
  if (older.length > 0) {
    result.push({
      id: 'older',
      label: 'Older',
      level: 0,
      operations: older,
      subGroups: groupByDay(older, 'older'),
    });
  }

  return result;
}

// Get description for an operation
function getOperationDescription(op: TimestampedOperation): string {
  const event = getEventInfo(op);
  if (event) {
    switch (event.name) {
      case 'runCell':
        return event.target?.cellIndex !== undefined ? `cell ${event.target.cellIndex + 1}` : '';
      case 'runAllCells':
      case 'runCellsAbove':
      case 'runCellsBelow': {
        const cellCount = event.data?.cellCount;
        const cellIds = event.data?.cellIds;
        const count = typeof cellCount === 'number'
          ? cellCount
          : (Array.isArray(cellIds) ? cellIds.length : undefined);
        return count !== undefined ? `${count} cells` : '';
      }
      case 'runCellComplete': {
        const successValue = event.data?.success;
        const durationValue = event.data?.durationMs;
        const success = typeof successValue === 'boolean' ? successValue : undefined;
        const durationMs = typeof durationValue === 'number' ? durationValue : undefined;
        if (success === undefined && durationMs === undefined) return '';
        if (success === undefined) return `${durationMs}ms`;
        return success ? `${durationMs ?? ''}ms`.trim() : 'failed';
      }
      case 'interruptKernel':
      case 'restartKernel':
        return '';
      default:
        return '';
    }
  }

  switch (op.type) {
    case 'snapshot':
      return `${op.cells?.length || 0} cells`;
    case 'insertCell':
      return `at position ${op.index + 1}`;
    case 'deleteCell':
      return `from position ${op.index + 1}`;
    case 'moveCell':
      return `${op.fromIndex + 1} → ${op.toIndex + 1}`;
    case 'updateContent':
    case 'updateContentPatch':
      return op.cellId?.slice(0, 6) || '';
    case 'updateMetadata': {
      const keys = Object.keys(op.changes || {});
      return keys.join(', ');
    }
    case 'batch':
      return `${op.operations?.length || 0} ops`;
    default:
      return '';
  }
}

// Check if operation is from AI
function isAIOperation(op: TimestampedOperation): boolean {
  return (op as any).source === 'ai';
}

// Filter options
type FilterType = 'all' | 'edits' | 'structure' | 'execution';

const FILTERS: { value: FilterType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'edits', label: 'Edits' },
  { value: 'structure', label: 'Structure' },
  { value: 'execution', label: 'Execution' },
];

function matchesFilter(op: TimestampedOperation, filter: FilterType): boolean {
  if (filter === 'all') return true;
  if (filter === 'edits') {
    return ['updateContent', 'updateContentPatch', 'updateMetadata'].includes(op.type);
  }
  if (filter === 'structure') {
    return ['insertCell', 'deleteCell', 'moveCell', 'batch', 'snapshot'].includes(op.type);
  }
  if (filter === 'execution') {
    const event = getEventInfo(op);
    if (event) {
      return event.category === 'execution' || event.category === 'kernel';
    }
    return false;
  }
  return true;
}

/**
 * Root element of the open panel. Lives in its own component — mounted only
 * while the panel is open — so useModalA11y binds on mount and its Escape
 * handling is only active while the panel is visible (HistoryPanel itself
 * stays mounted, rendering null, when closed). Non-modal side panel: no focus
 * trap and no focus grab, so the notebook content stays usable.
 */
const HistoryPanelShell: React.FC<{
  onClose: () => void;
  height: number;
  children: React.ReactNode;
}> = ({ onClose, height, children }) => {
  const panelRef = useModalA11y<HTMLDivElement>(onClose, { trapFocus: false, skipInitialFocus: true });
  return (
    <div
      ref={panelRef}
      data-testid="history-panel"
      role="complementary"
      aria-label="Edit history"
      tabIndex={-1}
      className="flex-none flex flex-col bg-transparent overflow-hidden"
      style={{ height: `${height}px` }}
    >
      {children}
    </div>
  );
};

export const HistoryPanel: React.FC<HistoryPanelProps> = ({
  isOpen,
  onClose,
  history,
  defaultHeight = DEFAULT_HEIGHT,
  onResetHistory,
  onPreview,
  onExitPreview,
  previewTimestamp,
  onRequestRestore,
}) => {
  const [height, setHeight] = useState(defaultHeight);
  const [isResizing, setIsResizing] = useState(false);
  const [filter, setFilter] = useState<FilterType>('all');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [expandedOps, setExpandedOps] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const listRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  // Filter and reverse history (most recent first)
  const filteredHistory = useMemo(() => {
    return history
      .filter(op => matchesFilter(op, filter))
      .reverse();
  }, [history, filter]);

  // Group operations by time period
  const groupedHistory = useMemo(() => {
    return groupOperationsByTime(filteredHistory);
  }, [filteredHistory]);

  // Toggle group collapse
  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  // Auto-scroll to top (most recent) when new operations arrive
  useEffect(() => {
    if (listRef.current && isOpen) {
      listRef.current.scrollTop = 0;
    }
  }, [history.length, isOpen]);

  // Toggle expanded state for an operation
  const toggleExpanded = useCallback((opId: string) => {
    setExpandedOps(prev => {
      const next = new Set(prev);
      if (next.has(opId)) {
        next.delete(opId);
      } else {
        next.add(opId);
      }
      return next;
    });
  }, []);

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
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      resizeCleanupRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    resizeCleanupRef.current = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [height]);

  // Cleanup resize listeners on unmount
  useEffect(() => {
    return () => {
      if (resizeCleanupRef.current) {
        resizeCleanupRef.current();
      }
    };
  }, []);

  if (!isOpen) return null;

  return (
    <HistoryPanelShell onClose={onClose} height={height}>
      {/* Resize Handle */}
      <div
        data-testid="history-resize-handle"
        className="h-2 cursor-ns-resize flex-shrink-0 bg-slate-200/30 hover:bg-slate-300/50 transition-colors"
        onMouseDown={handleResizeStart}
      />

      {/* Header */}
      <div
        className="flex items-center justify-between px-2 py-0.5 bg-slate-100 border-b border-slate-200 flex-shrink-0"
      >
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
          <History className="w-3 h-3" />
          <span>History</span>
          <span className="text-slate-400">({filteredHistory.length})</span>
        </div>

        <div className="flex items-center gap-1">
          {/* Filter dropdown */}
          <div className="relative">
            <button
              onClick={() => setIsFilterOpen(!isFilterOpen)}
              className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-200 rounded transition-colors"
              title="Filter operations"
            >
              <Filter className="w-3 h-3" />
              <span>{FILTERS.find(f => f.value === filter)?.label}</span>
              <ChevronDown className="w-3 h-3" />
            </button>

            {isFilterOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setIsFilterOpen(false)}
                />
                <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded shadow-lg z-20 py-1 min-w-[6.25rem]">
                  {FILTERS.map(f => (
                    <button
                      key={f.value}
                      onClick={() => {
                        setFilter(f.value);
                        setIsFilterOpen(false);
                      }}
                      className={`w-full px-3 py-1 text-xs text-left hover:bg-slate-100 ${
                        filter === f.value ? 'text-blue-600 font-medium' : 'text-slate-600'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {onResetHistory && (
            <button
              data-testid="history-reset"
              onClick={onResetHistory}
              className="p-0.5 text-slate-400 hover:text-amber-700 hover:bg-amber-100 rounded transition-colors"
              title="Reset history (clears undo/redo)"
              aria-label="Reset history (clears undo/redo)"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Close button */}
          <button
            onClick={onClose}
            className="p-0.5 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded transition-colors"
            title="Close"
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Preview banner */}
      {previewTimestamp && onExitPreview && (
        <div className="px-2 py-1.5 bg-blue-50 border-b border-blue-200 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-blue-700">
            <Eye className="w-3.5 h-3.5" />
            <span>Previewing: {formatTime(previewTimestamp)}</span>
            <span className="text-blue-500">(outputs preserved if not re-executed)</span>
          </div>
          <div className="flex items-center gap-2">
            {onRequestRestore && (
              <button
                onClick={() => onRequestRestore(previewTimestamp)}
                className="flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                Restore...
              </button>
            )}
            <button
              onClick={onExitPreview}
              className="flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-100 rounded transition-colors"
            >
              <RotateCw className="w-3 h-3" />
              Return to present
            </button>
          </div>
        </div>
      )}

      {/* Operation List */}
      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto bg-white"
      >
        {filteredHistory.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-400 text-sm">
            No operations yet
          </div>
        ) : (
          <div>
            {groupedHistory.map((group) => (
              <GroupSection
                key={group.id}
                group={group}
                collapsedGroups={collapsedGroups}
                toggleGroup={toggleGroup}
                expandedOps={expandedOps}
                toggleExpanded={toggleExpanded}
                onPreview={onPreview}
                onExitPreview={onExitPreview}
                previewTimestamp={previewTimestamp}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer with stats */}
      <div className="px-2 py-1 bg-slate-50 border-t border-slate-200 text-[0.625rem] text-slate-400 flex items-center justify-between">
        <span>
          {history.length} total operations
        </span>
        {history.length > 0 && (
          <span>
            Session started {formatRelativeTime(history[0]?.timestamp || Date.now())}
          </span>
        )}
      </div>
    </HistoryPanelShell>
  );
};

// ============================================================================
// GroupSection Component - Recursive rendering of groups and sub-groups
// ============================================================================

interface GroupSectionProps {
  group: OperationGroup;
  collapsedGroups: Set<string>;
  toggleGroup: (groupId: string) => void;
  expandedOps: Set<string>;
  toggleExpanded: (opId: string) => void;
  onPreview?: (timestamp: number) => void;
  onExitPreview?: () => void;
  previewTimestamp?: number | null;
}

const GroupSection: React.FC<GroupSectionProps> = ({
  group,
  collapsedGroups,
  toggleGroup,
  expandedOps,
  toggleExpanded,
  onPreview,
  onExitPreview,
  previewTimestamp,
}) => {
  const isCollapsed = collapsedGroups.has(group.id);
  const hasSubGroups = group.subGroups && group.subGroups.length > 0;
  const indentClass = group.level === 0 ? '' : 'ml-3';

  // Different styling for different levels
  const headerClass = group.level === 0
    ? 'sticky top-0 z-10 px-2 py-1 bg-slate-50 border-b border-slate-200'
    : 'px-2 py-0.5 bg-slate-50/50 border-b border-slate-100';

  const textClass = group.level === 0
    ? 'text-xs font-medium text-slate-600'
    : 'text-[0.6875rem] font-medium text-slate-500';

  return (
    <div className={indentClass}>
      {/* Group Header */}
      <div
        className={`${headerClass} flex items-center justify-between cursor-pointer hover:bg-slate-100`}
        onClick={() => toggleGroup(group.id)}
      >
        <div className={`flex items-center gap-2 ${textClass}`}>
          {isCollapsed ? (
            <ChevronRight className="w-3 h-3" />
          ) : (
            <ChevronDown className="w-3 h-3" />
          )}
          <span>{group.label}</span>
          <span className="text-slate-400 font-normal">({group.operations.length})</span>
        </div>
      </div>

      {/* Group Content */}
      {!isCollapsed && (
        <>
          {/* Render sub-groups if present */}
          {hasSubGroups ? (
            <div>
              {group.subGroups!.map((subGroup) => (
                <GroupSection
                  key={subGroup.id}
                  group={subGroup}
                  collapsedGroups={collapsedGroups}
                  toggleGroup={toggleGroup}
                  expandedOps={expandedOps}
                  toggleExpanded={toggleExpanded}
                  onPreview={onPreview}
                  onExitPreview={onExitPreview}
                  previewTimestamp={previewTimestamp}
                />
              ))}
            </div>
          ) : (
            /* Render operations directly */
            <div className="divide-y divide-slate-100">
              {group.operations.map((op, index) => {
              const meta = getOperationMeta(op);
              const Icon = meta.icon;
              const opId = op.operationId || `${op.timestamp}-${index}`;
              const isExpanded = expandedOps.has(opId);
              const isAI = isAIOperation(op);
              const isUndo = (op as any).isUndo;

              // Check if execution failed
              const event = getEventInfo(op);
              const eventDurationMs = typeof event?.data?.durationMs === 'number' ? (event.data.durationMs as number) : undefined;
              const eventSuccess = typeof event?.data?.success === 'boolean' ? (event.data.success as boolean) : undefined;
              const isFailed = event?.name === 'runCellComplete' && eventSuccess === false;
              const iconColor = isFailed ? 'text-red-500' : meta.color;
              const FailIcon = isFailed ? XCircle : meta.icon;
              const DisplayIcon = isFailed ? FailIcon : Icon;

              // Check if this operation is currently being previewed
              const isPreviewing = previewTimestamp === op.timestamp;

              return (
                <div
                  key={opId}
                  className={`group px-2 py-1.5 hover:bg-slate-50 transition-colors cursor-pointer ${
                    isUndo ? 'opacity-60' : ''
                  } ${isPreviewing ? 'bg-blue-50 border-l-2 border-blue-500' : ''}`}
                  onClick={() => {
                    // Click row to preview (or exit if already previewing this one)
                    if (onPreview) {
                      if (isPreviewing) {
                        onExitPreview?.();
                      } else {
                        onPreview(op.timestamp);
                      }
                    }
                  }}
                >
                  <div className="flex items-center gap-2">
                    {/* Expand/collapse indicator - click to toggle details */}
                    <button
                      className="w-4 h-4 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded"
                      onClick={(e) => {
                        e.stopPropagation(); // Don't trigger preview
                        toggleExpanded(opId);
                      }}
                      title="Show details"
                      aria-label="Show details"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                    </button>

                    {/* Operation icon */}
                    <DisplayIcon className={`w-3.5 h-3.5 flex-shrink-0 ${iconColor}`} />

                    {/* Operation label */}
                    <span className="text-xs font-medium text-slate-700 flex-shrink-0">
                      {meta.label}
                      {isUndo && <span className="text-slate-400 ml-1">(undo)</span>}
                    </span>

                    {/* AI badge */}
                    {isAI && (
                      <span className="flex items-center gap-0.5 px-1 py-0.5 bg-purple-100 text-purple-600 rounded text-[0.625rem] font-medium">
                        <Sparkles className="w-2.5 h-2.5" />
                        AI
                      </span>
                    )}

                    {/* Description */}
                    <span className="text-xs text-slate-500 truncate flex-1">
                      {getOperationDescription(op)}
                    </span>

                    {/* Timestamp */}
                    <span
                      className="text-[0.625rem] text-slate-400 flex-shrink-0"
                      title={formatTime(op.timestamp)}
                    >
                      {formatRelativeTime(op.timestamp)}
                    </span>

                    {/* Preview indicator */}
                    {isPreviewing && (
                      <Eye className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                    )}
                  </div>

                  {/* Expanded content */}
                  {isExpanded && (
                    <div className="ml-6 mt-1 pl-2 border-l-2 border-slate-200">
                      {/* Batch operations */}
                      {op.type === 'batch' && (op as any).operations && (
                        <>
                          {((op as any).operations as TimestampedOperation[]).map((subOp, subIndex) => {
                            const subMeta = getOperationMeta(subOp as TimestampedOperation);
                            const SubIcon = subMeta.icon;
                            return (
                              <div key={subIndex} className="flex items-center gap-2 py-0.5">
                                <SubIcon className={`w-3 h-3 ${subMeta.color}`} />
                                <span className="text-[0.6875rem] text-slate-600">{subMeta.label}</span>
                                <span className="text-[0.6875rem] text-slate-400">
                                  {getOperationDescription(subOp as TimestampedOperation)}
                                </span>
                              </div>
                            );
                          })}
                        </>
                      )}

                      {/* Content edit - show old/new */}
                      {op.type === 'updateContent' && (
                        <div className="text-[0.6875rem] space-y-1 py-1">
                          <div className="text-slate-500">Cell: <span className="font-mono text-slate-600">{(op as any).cellId}</span></div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <div className="text-red-500 font-medium mb-0.5">Before:</div>
                              <pre className="bg-red-50 text-red-700 p-1.5 rounded text-[0.625rem] overflow-x-auto max-h-24 overflow-y-auto whitespace-pre-wrap break-all">
                                {((op as any).oldContent || '').slice(0, 500)}{((op as any).oldContent || '').length > 500 ? '...' : ''}
                              </pre>
                            </div>
                            <div>
                              <div className="text-green-600 font-medium mb-0.5">After:</div>
                              <pre className="bg-green-50 text-green-700 p-1.5 rounded text-[0.625rem] overflow-x-auto max-h-24 overflow-y-auto whitespace-pre-wrap break-all">
                                {((op as any).newContent || '').slice(0, 500)}{((op as any).newContent || '').length > 500 ? '...' : ''}
                              </pre>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Patch-based content edit */}
                      {op.type === 'updateContentPatch' && (
                        <div className="text-[0.6875rem] py-1">
                          <div className="text-slate-500">Cell: <span className="font-mono text-slate-600">{(op as any).cellId}</span></div>
                          <div className="text-slate-400 mt-1">
                            Hash: {(op as any).oldHash?.slice(0, 8)} → {(op as any).newHash?.slice(0, 8)}
                          </div>
                        </div>
                      )}

                      {/* Insert/Delete cell */}
                      {(op.type === 'insertCell' || op.type === 'deleteCell') && (
                        <div className="text-[0.6875rem] space-y-1 py-1">
                          <div className="text-slate-500">
                            Position: <span className="text-slate-600">{(op as any).index + 1}</span>
                          </div>
                          <div className="text-slate-500">
                            Type: <span className="text-slate-600">{(op as any).cell?.type}</span>
                          </div>
                          {(op as any).cell?.content && (
                            <div>
                              <div className="text-slate-500 mb-0.5">Content:</div>
                              <pre className="bg-slate-50 text-slate-600 p-1.5 rounded text-[0.625rem] overflow-x-auto max-h-20 overflow-y-auto whitespace-pre-wrap break-all">
                                {((op as any).cell.content || '').slice(0, 300)}{((op as any).cell.content || '').length > 300 ? '...' : ''}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Move cell */}
                      {op.type === 'moveCell' && (
                        <div className="text-[0.6875rem] py-1 text-slate-500">
                          Moved from position <span className="text-slate-600">{(op as any).fromIndex + 1}</span> to <span className="text-slate-600">{(op as any).toIndex + 1}</span>
                        </div>
                      )}

                      {/* Metadata change */}
                      {op.type === 'updateMetadata' && (
                        <div className="text-[0.6875rem] py-1">
                          <div className="text-slate-500">Cell: <span className="font-mono text-slate-600">{(op as any).cellId}</span></div>
                          {Object.entries((op as any).changes || {}).map(([key, change]: [string, any]) => (
                            <div key={key} className="text-slate-500 mt-0.5">
                              {key}: <span className="text-red-500">{JSON.stringify(change.old)}</span> → <span className="text-green-600">{JSON.stringify(change.new)}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Run cell */}
                      {event?.name === 'runCell' && (
                        <div className="text-[0.6875rem] py-1 text-slate-500">
                          Executed cell{event.target?.cellIndex !== undefined ? (
                            <> at position <span className="text-slate-600">{event.target.cellIndex + 1}</span></>
                          ) : null}
                          {event.target?.cellId && (
                            <div className="font-mono text-slate-400 mt-0.5">ID: {event.target.cellId}</div>
                          )}
                        </div>
                      )}

                      {/* Run complete */}
                      {event?.name === 'runCellComplete' && (
                        <div className="text-[0.6875rem] py-1">
                          <div className="text-slate-500">
                            {event.target?.cellIndex !== undefined && (
                              <>Cell <span className="text-slate-600">{event.target.cellIndex + 1}</span> • </>
                            )}
                            {typeof eventDurationMs === 'number' && (
                              <>Duration: <span className="text-slate-600">{eventDurationMs}ms</span> • </>
                            )}
                            {typeof eventSuccess === 'boolean' && (
                              <>Status: <span className={eventSuccess ? 'text-green-600' : 'text-red-500'}>{eventSuccess ? 'Success' : 'Failed'}</span></>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Snapshot */}
                      {op.type === 'snapshot' && (
                        <div className="text-[0.6875rem] py-1 text-slate-500">
                          Snapshot with <span className="text-slate-600">{(op as any).cells?.length || 0}</span> cells
                        </div>
                      )}

                      {/* Timestamp */}
                      <div className="text-[0.625rem] text-slate-400 mt-1 pt-1 border-t border-slate-100">
                        {formatTime(op.timestamp)}
                      </div>
                    </div>
                  )}
                </div>
              );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};
