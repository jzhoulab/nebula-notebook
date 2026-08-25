import { useEffect, useRef, useCallback, useState } from 'react';
import { Cell } from '../types';
import {
  AutosaveState,
  AutosaveEvent,
  AutosaveEffect,
  autosaveReducer,
  getInitialState,
} from './autosaveStateMachine';

export interface AutosaveStatus {
  status: 'saved' | 'saving' | 'unsaved' | 'error';
  lastSaved: number | null;
}

export interface UseAutosaveOptions {
  fileId: string | null;
  cells: Cell[];
  onSave: (fileId: string, cells: Cell[]) => Promise<void>;
  enabled?: boolean;
  /**
   * True while the notebook is being (re)loaded from disk. The saved-state
   * baseline seeds when loading FINISHES — seeding on fileId change alone
   * races the async load (fileId flips before cells arrive), which made every
   * loaded cell look dirty and fired a pointless full autosave on page load.
   */
  loading?: boolean;
  /**
   * When this returns true at save time, the (auto)save politely steps aside
   * and retries shortly. Used to give in-flight AI completions priority:
   * both fire on the same typing pause, and the save's serialize+gzip+upload
   * otherwise lands inside the completion's latency window. Bounded — after
   * ~8s of deferrals the save proceeds regardless. Manual saves never defer.
   */
  deferWhile?: () => boolean;
  hasRedoHistory?: boolean; // Block autosave when redo history exists (user has undone)
  // Called when a save attempt fails. Retries are scheduled automatically by
  // the state machine — this exists so the UI can surface the failure loudly
  // (toast, banner) instead of just a status flag.
  onSaveError?: (error: Error, info: { isManual: boolean; consecutiveFailures: number }) => void;
}

interface CellSnapshot {
  type: Cell['type'];
  content: string;
  scrolled?: boolean;
  scrolledHeight?: number;
  sourceCollapsed?: boolean;
  sourceHeight?: number;
  metadataRef?: Cell['_metadata'];
  outputsRef?: Cell['outputs'];
}

export function useAutosave({ fileId, cells, onSave, enabled = true, loading = false, hasRedoHistory = false, deferWhile, onSaveError }: UseAutosaveOptions) {
  // UI status (derived from machine state)
  const [uiStatus, setUiStatus] = useState<AutosaveStatus>({
    status: 'saved',
    lastSaved: null,
  });

  // State machine state
  const [machineState, setMachineState] = useState<AutosaveState>(getInitialState);

  // Refs for timers and content tracking
  const checkTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const cellsRef = useRef(cells);
  const lastSavedSnapshotRef = useRef<Map<string, CellSnapshot>>(new Map());
  const lastSavedOrderRef = useRef<string[]>([]);
  const lastSavedSizeRef = useRef(0);
  const dirtyCellsRef = useRef<Set<string>>(new Set());
  const dirtyOrderRef = useRef(false);

  // Ref for executeEffect to avoid stale closure in dispatch
  const executeEffectRef = useRef<(effect: AutosaveEffect) => void>(() => {});
  // Ref so deferred-save timers always call the latest performSave
  const performSaveRef = useRef<(() => Promise<void>) | null>(null);

  // Track if current save is manual (show "Saving..." only for manual saves)
  const isManualSaveRef = useRef(false);

  // Guard against concurrent saves - prevents race conditions with mtime updates
  const saveInProgressRef = useRef(false);

  // Consecutive failed save attempts (reset on success) — lets the UI decide
  // how loudly to surface repeated failures without spamming on every retry.
  const consecutiveFailuresRef = useRef(0);

  // Keep the latest onSaveError without re-creating performSave
  const onSaveErrorRef = useRef(onSaveError);
  onSaveErrorRef.current = onSaveError;

  const buildSnapshot = useCallback((cell: Cell): CellSnapshot => ({
    type: cell.type,
    content: cell.content,
    scrolled: cell.scrolled,
    scrolledHeight: cell.scrolledHeight,
    sourceCollapsed: cell.sourceCollapsed,
    sourceHeight: cell.sourceHeight,
    metadataRef: cell._metadata,
    outputsRef: cell.outputs,
  }), []);

  const cellMatchesSnapshot = useCallback((cell: Cell, snapshot: CellSnapshot): boolean => (
    cell.type === snapshot.type &&
    cell.content === snapshot.content &&
    cell.scrolled === snapshot.scrolled &&
    cell.scrolledHeight === snapshot.scrolledHeight &&
    cell.sourceCollapsed === snapshot.sourceCollapsed &&
    cell.sourceHeight === snapshot.sourceHeight &&
    cell._metadata === snapshot.metadataRef &&
    cell.outputs === snapshot.outputsRef
  ), []);

  const estimateCellsSize = useCallback((cellsToMeasure: Cell[]): number => {
    let size = 0;
    for (const cell of cellsToMeasure) {
      size += (cell.content || '').length;
      for (const output of cell.outputs) {
        size += (output.content || '').length;
      }
    }
    // String.length gives character count. V8 uses 1-byte Latin-1 encoding
    // for ASCII-only content (code, base64), so length ≈ byte size.
    return size;
  }, []);

  const refreshDirtyState = useCallback((currentCells: Cell[]): boolean => {
    const nextDirty = new Set<string>();
    const nextIds = new Set<string>();
    const lastSavedSnapshot = lastSavedSnapshotRef.current;
    const lastOrder = lastSavedOrderRef.current;
    let orderChanged = currentCells.length !== lastOrder.length;

    for (let i = 0; i < currentCells.length; i += 1) {
      const cell = currentCells[i];
      nextIds.add(cell.id);
      if (!orderChanged && lastOrder[i] !== cell.id) {
        orderChanged = true;
      }

      const snapshot = lastSavedSnapshot.get(cell.id);
      if (!snapshot || !cellMatchesSnapshot(cell, snapshot)) {
        nextDirty.add(cell.id);
      }
    }

    if (lastSavedSnapshot.size !== currentCells.length) {
      for (const id of lastSavedSnapshot.keys()) {
        if (!nextIds.has(id)) {
          nextDirty.add(id);
          orderChanged = true;
        }
      }
    }

    dirtyCellsRef.current = nextDirty;
    dirtyOrderRef.current = orderChanged;
    return nextDirty.size > 0 || orderChanged;
  }, [cellMatchesSnapshot]);

  const updateSavedState = useCallback((savedCells: Cell[]) => {
    const snapshot = new Map<string, CellSnapshot>();
    for (const cell of savedCells) {
      snapshot.set(cell.id, buildSnapshot(cell));
    }
    lastSavedSnapshotRef.current = snapshot;
    lastSavedOrderRef.current = savedCells.map(cell => cell.id);
    dirtyCellsRef.current = new Set();
    dirtyOrderRef.current = false;
    lastSavedSizeRef.current = estimateCellsSize(savedCells);
  }, [buildSnapshot, estimateCellsSize]);

  // Check if there are unsaved changes
  const hasUnsavedChanges = useCallback(() => (
    dirtyOrderRef.current ||
    dirtyCellsRef.current.size > 0 ||
    saveInProgressRef.current
  ), []);

  // Cancel all pending operations
  const cancelPendingOperations = useCallback(() => {
    if (checkTimeoutRef.current) {
      clearTimeout(checkTimeoutRef.current);
      checkTimeoutRef.current = null;
    }
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (deferTimerRef.current) {
      clearTimeout(deferTimerRef.current);
      deferTimerRef.current = null;
    }
  }, []);

  // Dispatch an event to the state machine and execute effects
  const dispatch = useCallback((event: AutosaveEvent) => {
    setMachineState(currentState => {
      const { state: newState, effects } = autosaveReducer(currentState, event);

      // Execute effects (scheduled in next tick to avoid state update conflicts)
      // Use ref to avoid stale closure - executeEffectRef always has the latest version
      if (effects.length > 0) {
        setTimeout(() => {
          effects.forEach(effect => executeEffectRef.current(effect));
        }, 0);
      }

      return newState;
    });
  }, []);

  // Deferral bookkeeping for completion-priority (see deferWhile).
  const deferCountRef = useRef(0);
  const deferTimerRef = useRef<NodeJS.Timeout | null>(null);
  const DEFER_RETRY_MS = 1200;
  const DEFER_MAX = 7; // ~8.4s worst case, then save anyway

  // Perform the actual save operation
  const performSave = useCallback(async () => {
    if (!fileId || !enabled) {
      dispatch({ type: 'SAVE_SUCCESS' }); // No-op success
      return;
    }

    // AI completion in flight? Step aside briefly — autocomplete latency is
    // user-facing; the save can wait a beat. Never defer manual saves, and
    // never starve (bounded retries).
    if (!isManualSaveRef.current && deferWhile?.() && deferCountRef.current < DEFER_MAX) {
      deferCountRef.current += 1;
      if (deferTimerRef.current) clearTimeout(deferTimerRef.current);
      deferTimerRef.current = setTimeout(() => { performSaveRef.current?.(); }, DEFER_RETRY_MS);
      return;
    }
    deferCountRef.current = 0;

    // Guard against concurrent saves - wait for current save to complete
    // This prevents race conditions where multiple saves could cause false conflicts
    if (saveInProgressRef.current) {
      dispatch({ type: 'SAVE_SUCCESS' }); // Treat as success, will re-trigger if still dirty
      return;
    }

    const hasChanges = dirtyOrderRef.current || dirtyCellsRef.current.size > 0;
    if (!hasChanges) {
      dispatch({ type: 'SAVE_SUCCESS' }); // No actual changes
      return;
    }

    // For large notebooks, increase debounce to reduce save frequency.
    // The dirty check above already prevents saves when nothing changed.

    // Only show "Saving..." for manual saves - autosave is silent
    if (isManualSaveRef.current) {
      setUiStatus(prev => ({ status: 'saving', lastSaved: prev.lastSaved }));
    }

    saveInProgressRef.current = true;
    try {
      console.info(`[Autosave] Saving notebook (manual=${isManualSaveRef.current})`);
      await onSave(fileId, cells);
      updateSavedState(cells);
      consecutiveFailuresRef.current = 0;
      const savedAt = Date.now();
      const hasDirtyChanges = refreshDirtyState(cellsRef.current);
      setUiStatus({ status: hasDirtyChanges ? 'unsaved' : 'saved', lastSaved: savedAt });
      dispatch({ type: 'SAVE_SUCCESS' });
    } catch (error) {
      console.error('Autosave failed:', error);
      const err = error instanceof Error ? error : new Error(String(error));
      consecutiveFailuresRef.current += 1;
      setUiStatus(prev => ({ status: 'error', lastSaved: prev.lastSaved }));
      onSaveErrorRef.current?.(err, {
        isManual: isManualSaveRef.current,
        consecutiveFailures: consecutiveFailuresRef.current,
      });
      dispatch({ type: 'SAVE_ERROR', error: err });
    } finally {
      // Reset flags
      saveInProgressRef.current = false;
      isManualSaveRef.current = false;
    }
  }, [fileId, cells, enabled, onSave, deferWhile, dispatch, updateSavedState, refreshDirtyState]);
  performSaveRef.current = performSave;

  // Check for changes and report to state machine
  const checkForChanges = useCallback(() => {
    const hasChanges = dirtyOrderRef.current || dirtyCellsRef.current.size > 0;
    const contentSize = hasChanges ? lastSavedSizeRef.current : 0;

    if (!hasChanges) {
      setUiStatus(prev => prev.status === 'unsaved' ? { ...prev, status: 'saved' } : prev);
    }

    dispatch({ type: 'CHECK_COMPLETE', hasChanges, contentSize });
  }, [dispatch]);

  // Execute a single effect
  const executeEffect = useCallback((effect: AutosaveEffect) => {
    switch (effect.type) {
      case 'SCHEDULE_CHECK':
        checkTimeoutRef.current = setTimeout(() => {
          checkForChanges();
        }, effect.delay);
        break;

      case 'SCHEDULE_SAVE':
        saveTimeoutRef.current = setTimeout(() => {
          dispatch({ type: 'TIMEOUT_FIRED' });
        }, effect.delay);
        break;

      case 'SCHEDULE_RETRY':
        retryTimeoutRef.current = setTimeout(() => {
          dispatch({ type: 'RETRY' });
        }, effect.delay);
        break;

      case 'CANCEL_PENDING_OPERATIONS':
        cancelPendingOperations();
        break;

      case 'PERFORM_SAVE':
        performSave();
        break;

      case 'UPDATE_SAVED_CONTENT':
        // Content already updated in performSave
        break;
    }
  }, [checkForChanges, cancelPendingOperations, performSave, dispatch]);

  // Keep executeEffect ref in sync to avoid stale closures
  executeEffectRef.current = executeEffect;

  // Track which fileId has had its saved-state initialized.
  // The cells-change effect fires BEFORE the fileId-init effect (React runs
  // effects in definition order).  Without this guard, loading a new file
  // makes every cell appear "dirty" (no snapshot yet) and triggers an
  // immediate autosave of the entire notebook — for a 500 MB file this
  // allocates ~1.5 GB of temporary strings and freezes the main thread.
  const initializedFileIdRef = useRef<string | null>(null);

  // React to cells changes
  useEffect(() => {
    // `loading` also guards same-file reloads (external-change refresh):
    // disk state arriving must never read as user edits.
    if (!fileId || !enabled || loading) return;

    // Skip when fileId just changed — the fileId-init effect below will
    // set the snapshot.  We detect this by comparing against the last
    // fileId we initialized.
    if (fileId !== initializedFileIdRef.current) return;

    // Quick reference check - if cells array reference hasn't changed, skip
    if (cells === cellsRef.current) return;
    cellsRef.current = cells;

    const hasChanges = refreshDirtyState(cells);
    setUiStatus(prev => {
      if (hasChanges) {
        return prev.status === 'unsaved' ? prev : { ...prev, status: 'unsaved' };
      }
      return prev.status === 'unsaved' ? { ...prev, status: 'saved' } : prev;
    });

    // Block autosave when redo history exists (user has undone)
    if (hasRedoHistory) return;

    // Dispatch cells changed event
    dispatch({ type: 'CELLS_CHANGED' });
  }, [cells, fileId, enabled, loading, hasRedoHistory, dispatch, refreshDirtyState]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelPendingOperations();
    };
  }, [cancelPendingOperations]);

  // Save immediately (for manual save)
  const saveNow = useCallback(async () => {
    cancelPendingOperations();

    // Check if there are actual changes to save
    const hasChanges = refreshDirtyState(cells);
    if (!hasChanges) {
      // No changes, but still refresh the timestamp to give visual feedback
      setUiStatus({ status: 'saved', lastSaved: Date.now() });
      return;
    }

    // Mark as manual save to show "Saving..." indicator
    isManualSaveRef.current = true;
    dispatch({ type: 'MANUAL_SAVE' });
  }, [cancelPendingOperations, cells, dispatch, refreshDirtyState]);

  // Initialize the saved-state baseline when a load COMPLETES (fileId set and
  // no longer loading). Keying on fileId alone raced the async load: fileId
  // flips before the fetched cells land, so the baseline was seeded from the
  // previous file's cells and the loaded cells all read as dirty → a full,
  // pointless autosave on every page load / notebook switch.
  useEffect(() => {
    if (fileId && !loading) {
      updateSavedState(cells);
      initializedFileIdRef.current = fileId;
      cellsRef.current = cells;
      setUiStatus({ status: 'saved', lastSaved: Date.now() });
      setMachineState(getInitialState());
    }
  }, [fileId, loading]); // Not cells: re-seed only on load transitions

  // Warn before unload if there are unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges()) {
        e.preventDefault();
        e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
        return e.returnValue;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  // Save on visibility change (tab switch)
  // Block when redo history exists to avoid losing redo on tab switch
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && hasUnsavedChanges() && !hasRedoHistory) {
        dispatch({ type: 'MANUAL_SAVE' });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [hasUnsavedChanges, hasRedoHistory, dispatch]);

  return {
    status: uiStatus,
    saveNow,
    hasUnsavedChanges,
  };
}

// Format relative time
export function formatLastSaved(timestamp: number | null): string {
  if (!timestamp) return '';

  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return new Date(timestamp).toLocaleDateString();
}
