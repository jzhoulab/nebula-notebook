/**
 * Notebook-level keyboard shortcuts, extracted verbatim from Notebook.tsx
 * (first slice of the planned decomposition).
 *
 * All collaborators arrive through a deps object that is re-snapshotted every
 * render into a ref, so the single window listener (registered once, capture
 * phase) can never go stale — the same guarantee the original inline effect
 * got from its shadow-ref pattern, without each caller wiring its own refs.
 *
 * Dual undo/redo architecture note (preserved from the original site):
 * keyboard Ctrl/Cmd+Z goes to CodeMirror's per-cell text history; the
 * toolbar (and cell-mode 'z' / Shift+Z) drives the notebook-level
 * structural history. This split is intentional.
 */
import { useEffect, useRef } from 'react';
import { EditorView } from '@codemirror/view';

type CellType = 'code' | 'markdown';

export interface ShortcutClipboardItem {
  type: CellType;
  content: string;
  sourceId: string;
  isCut: boolean;
}

interface ShortcutCell {
  id: string;
  type: CellType;
  content: string;
}

export interface NotebookShortcutDeps {
  readOnly?: boolean;
  // Live notebook state (shadow refs owned by Notebook)
  cellsRef: React.RefObject<ShortcutCell[]>;
  selectedCellIdsRef: React.RefObject<Set<string>>;
  selectionAnchorRef: React.RefObject<string | null>;
  cursorAnchorRef: React.RefObject<{ cellId: string; pos: number; ts: number } | null>;
  cellClipboardRef: React.RefObject<ShortcutClipboardItem[] | null>;
  cellQueueRef: React.RefObject<ShortcutClipboardItem[]>;
  jupyterShortcutsRef: React.RefObject<boolean>;

  // Operations (refs where Notebook already maintains them, else stable fns)
  handleManualSaveRef: React.RefObject<() => Promise<void>>;
  addCellRef: React.RefObject<((type: CellType, content: string, afterIndex?: number, focus?: boolean | 'cell' | 'editor') => void) | null>;
  deleteCellRef: React.RefObject<((cellId: string) => void) | null>;
  changeCellTypeRef: React.RefObject<((cellId: string, type: CellType) => void) | null>;
  pasteClipboardCellsRef: React.RefObject<((items: ShortcutClipboardItem[], insertAt: number) => void) | null>;
  undoFnRef: React.RefObject<(() => void) | null>;
  redoFnRef: React.RefObject<(() => void) | null>;
  restartKernelFnRef: React.RefObject<(() => void) | null>;
  interruptKernelRef: React.RefObject<(() => void) | null>;
  scrollToCellFnRef: React.RefObject<((index: number, opts?: { behavior?: 'smooth' | 'auto'; delay?: number; retryOnce?: boolean }) => void) | null>;

  selectCellRange: (anchorId: string, headId: string) => void;
  clearCellSelection: () => void;
  deleteSelectedCells: () => void;
  copySelectedCells: (cut: boolean) => void;

  // State setters (stable per React)
  setActiveCellId: (id: string) => void;
  setPendingFocus: (v: { cellId: string; mode: 'cell' | 'editor' }) => void;
  setSearchSeed: (v: string) => void;
  setIsSearchOpen: (v: boolean) => void;
  setIsTerminalOpen: (updater: (prev: boolean) => boolean) => void;
  setIsHistoryOpen: (updater: (prev: boolean) => boolean) => void;
  setCellClipboard: (items: ShortcutClipboardItem[]) => void;
  setCellQueue: (updater: (prev: ShortcutClipboardItem[]) => ShortcutClipboardItem[]) => void;
}

export function useNotebookKeyboardShortcuts(deps: NotebookShortcutDeps): void {
  // Re-snapshot every render; the listener reads through this ref.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  // Double-key sequence state ('dd', '00', 'ii') is private to the shortcuts.
  const lastKeyRef = useRef<{ key: string; time: number } | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const d = depsRef.current;
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      // Chrome fires synthetic keydown events with key === undefined when an
      // option is picked from a <datalist> (e.g. the model field in Settings).
      if (typeof e.key !== 'string') return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      // Ctrl+S: Save (works everywhere) - uses handleManualSave for redo confirmation
      if ((e.metaKey || e.ctrlKey) && key === 's') {
        e.preventDefault();
        if (d.readOnly) return;
        d.handleManualSaveRef.current().catch(err => {
          console.error('Save failed:', err);
        });
        return;
      }

      // Note: Cmd/Ctrl+C is intentionally NOT used for kernel interrupt.
      // It conflicts with copy and causes accidental interrupts.
      // Use the toolbar Interrupt button or kernel menu instead.

      // Ctrl+F: Search (works everywhere)
      if ((e.metaKey || e.ctrlKey) && key === 'f') {
        e.preventDefault();
        let selectedText = '';
        let anchorFromSelection: { cellId: string; pos: number } | null = null;

        // Prefer CodeMirror state when available so we can preserve exact text and
        // anchor initial search at the selected occurrence.
        const editorHost = target.closest?.('.cm-editor');
        if (editorHost instanceof HTMLElement) {
          const view = EditorView.findFromDOM(editorHost);
          const selectedCellId = target.closest?.('[data-cell-id]')?.getAttribute('data-cell-id') ?? null;

          if (view) {
            const sel = view.state.selection.main;
            if (!sel.empty) {
              selectedText = view.state.sliceDoc(sel.from, sel.to);
            }
            if (selectedCellId) {
              anchorFromSelection = { cellId: selectedCellId, pos: sel.from };
            }
          }
        }

        if (!selectedText && target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
          const input = target as HTMLInputElement | HTMLTextAreaElement;
          if (input.selectionStart != null && input.selectionEnd != null && input.selectionStart !== input.selectionEnd) {
            const inputSelection = input.value.slice(input.selectionStart, input.selectionEnd);
            if (inputSelection.trim().length > 0) {
              selectedText = inputSelection;
            }
          }
        }

        if (anchorFromSelection) {
          d.cursorAnchorRef.current = { ...anchorFromSelection, ts: Date.now() };
        }

        // Empty string intentionally clears any previous seeded query.
        d.setSearchSeed(selectedText.trim().length > 0 ? selectedText : '');
        d.setIsSearchOpen(true);
        return;
      }

      // Ctrl+`: Toggle terminal (works everywhere)
      if ((e.metaKey || e.ctrlKey) && key === '`') {
        e.preventDefault();
        if (d.readOnly) return;
        d.setIsTerminalOpen(prev => !prev);
        return;
      }

      // Cmd/Ctrl+Shift+H: Toggle the history panel (works everywhere; the
      // panel is read-only viewing, so it stays available on sealed notebooks).
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && key.toLowerCase() === 'h') {
        e.preventDefault();
        d.setIsHistoryOpen(prev => !prev);
        return;
      }

      // Determine focus context:
      // - Edit mode: CodeMirror editor is focused (let CM handle shortcuts)
      // - Cell mode: Cell div is focused (Notebook handles Jupyter-style shortcuts)
      const isInEditor = target.closest?.('.cm-editor') !== null;
      const focusedCellId = target.getAttribute?.('data-cell-id') ?? null;

      if (d.readOnly) {
        const attemptsMutation =
          ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) ||
          e.key === 'Enter' || e.key === 'Delete' || e.key === 'Backspace' ||
          ['a', 'b', 'm', 'y', 'x', 'v', 'e', 'd', 'z', '0', 'i'].includes(key);
        if (attemptsMutation) {
          e.preventDefault();
          return;
        }
      }

      // Skip if typing in input fields or editing in CodeMirror
      if (isInput || isInEditor) return;

      // Jupyter-style shortcuts (cell mode only - when cell div itself is focused)
      if (!focusedCellId) return;

      // Shift+↑/↓ — extend the multi-cell selection from the focused cell
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const currentCellsNow = d.cellsRef.current;
        const curIdx = currentCellsNow.findIndex(c => c.id === focusedCellId);
        if (curIdx === -1) return;
        const anchorId = d.selectionAnchorRef.current ?? focusedCellId;
        const nextIdx = e.key === 'ArrowUp'
          ? Math.max(0, curIdx - 1)
          : Math.min(currentCellsNow.length - 1, curIdx + 1);
        const nextId = currentCellsNow[nextIdx].id;
        d.selectCellRange(anchorId, nextId);
        d.setActiveCellId(nextId);
        d.setPendingFocus({ cellId: nextId, mode: 'cell' });
        d.scrollToCellFnRef.current?.(nextIdx, { delay: 50, retryOnce: true });
        return;
      }

      // Escape — clear the multi-cell selection
      if (e.key === 'Escape' && d.selectedCellIdsRef.current.size > 0) {
        d.clearCellSelection();
        return;
      }

      // Skip single-letter shortcuts when Cmd/Ctrl is pressed
      // This allows Cmd+C to work as native copy instead of cell copy
      // Note: Shift is allowed for Shift+V (paste above)
      if (e.metaKey || e.ctrlKey) return;

      // Multi-cell selection operations (only when the focused cell is part of it)
      const multiSelection = d.selectedCellIdsRef.current;
      if (multiSelection.size > 1 && multiSelection.has(focusedCellId)) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          d.deleteSelectedCells();
          return;
        }
        if (key === 'c') {
          e.preventDefault();
          d.copySelectedCells(false);
          return;
        }
        if (key === 'x') {
          e.preventDefault();
          d.copySelectedCells(true);
          return;
        }
      }

      // Z / Shift+Z — undo / redo notebook-level cell operations. Always on
      // (Jupyter default): unlike the classic double-key bindings below, 'z'
      // conflicts with nothing in the default cell-mode keymap.
      if (key === 'z' && !e.altKey) {
        e.preventDefault();
        lastKeyRef.current = null;
        if (e.shiftKey) d.redoFnRef.current?.(); else d.undoFnRef.current?.();
        return;
      }

      // Jupyter classic keybindings (opt-in via Settings): dd delete,
      // 00 restart kernel, ii interrupt.
      // While enabled, single 'd' is consumed (the FIFO dequeue key is
      // suspended) so 'dd' can't accidentally paste a queued cell first.
      if (d.jupyterShortcutsRef.current && !e.altKey) {
        const doubleKeys = ['d', '0', 'i'];
        if (doubleKeys.includes(key)) {
          e.preventDefault();
          if (e.repeat) return; // holding the key must not fire the double action
          const now = Date.now();
          const doubled = lastKeyRef.current !== null &&
            lastKeyRef.current.key === key &&
            now - lastKeyRef.current.time < 800;
          if (!doubled) {
            lastKeyRef.current = { key, time: now };
            return;
          }
          lastKeyRef.current = null;
          if (key === 'd') {
            const selection = d.selectedCellIdsRef.current;
            if (selection.size > 1 && selection.has(focusedCellId)) {
              d.deleteSelectedCells();
            } else {
              d.deleteCellRef.current?.(focusedCellId);
            }
          } else if (key === '0') {
            d.restartKernelFnRef.current?.();
          } else if (key === 'i') {
            d.interruptKernelRef.current?.();
          }
          return;
        }
        // Any other key breaks a pending double-key sequence
        lastKeyRef.current = null;
      }

      const currentCells = d.cellsRef.current;
      const currentIndex = currentCells.findIndex(c => c.id === focusedCellId);

      // A - Insert cell above, selecting the new cell (Jupyter behavior)
      if (key === 'a' && d.addCellRef.current) {
        e.preventDefault();
        // Insert above = insert after (currentIndex - 1), so new cell appears at currentIndex
        const afterIdx = currentIndex === -1 ? undefined : currentIndex - 1;
        d.addCellRef.current('code', '', afterIdx, 'cell');
        return;
      }

      // B - Insert cell below, selecting the new cell (Jupyter behavior)
      if (key === 'b' && d.addCellRef.current) {
        e.preventDefault();
        // Insert below = insert after currentIndex
        const afterIdx = currentIndex !== -1 ? currentIndex : currentCells.length - 1;
        d.addCellRef.current('code', '', afterIdx, 'cell');
        return;
      }

      // M - Convert cell to Markdown
      if (key === 'm' && d.changeCellTypeRef.current) {
        e.preventDefault();
        d.changeCellTypeRef.current(focusedCellId, 'markdown');
        return;
      }

      // Y - Convert cell to Code
      if (key === 'y' && d.changeCellTypeRef.current) {
        e.preventDefault();
        d.changeCellTypeRef.current(focusedCellId, 'code');
        return;
      }

      // X - Cut cell (copy to clipboard + delete)
      if (key === 'x' && d.deleteCellRef.current) {
        e.preventDefault();
        const cellToCut = currentCells.find(c => c.id === focusedCellId);
        if (cellToCut) {
          // Copy to clipboard first, then delete (last cell will be cleared, not deleted)
          const clipboardItems: ShortcutClipboardItem[] = [{
            type: cellToCut.type,
            content: cellToCut.content,
            sourceId: cellToCut.id,
            isCut: true
          }];
          d.cellClipboardRef.current = clipboardItems;
          d.setCellClipboard(clipboardItems);
          d.deleteCellRef.current(focusedCellId);
        }
        return;
      }

      // C - Copy cell
      if (key === 'c') {
        e.preventDefault();
        const cellToCopy = currentCells.find(c => c.id === focusedCellId);
        if (cellToCopy) {
          const clipboardItems: ShortcutClipboardItem[] = [{
            type: cellToCopy.type,
            content: cellToCopy.content,
            sourceId: cellToCopy.id,
            isCut: false
          }];
          d.cellClipboardRef.current = clipboardItems;
          d.setCellClipboard(clipboardItems);
        }
        return;
      }

      // V - Paste cell(s) below, Shift+V - Paste cell(s) above
      const clipboard = d.cellClipboardRef.current;
      if (key === 'v' && clipboard && clipboard.length > 0) {
        e.preventDefault();
        const pasteAbove = e.shiftKey;
        // Use activeCellId to find current position, fallback to start/end
        const currentIdx = currentCells.findIndex(c => c.id === focusedCellId);
        const baseIdx = currentIdx >= 0 ? currentIdx : (pasteAbove ? -1 : currentCells.length - 1);
        // For paste below: insert at currentIdx + 1; above: at currentIdx
        const insertAt = pasteAbove ? Math.max(0, baseIdx) : baseIdx + 1;
        d.pasteClipboardCellsRef.current?.(clipboard, insertAt);
        return;
      }

      // E - Enqueue cell (cut to FIFO queue), then focus next cell
      if (key === 'e' && d.deleteCellRef.current) {
        e.preventDefault();
        const currentIdx = currentCells.findIndex(c => c.id === focusedCellId);
        const cellToQueue = currentIdx >= 0 ? currentCells[currentIdx] : null;
        if (cellToQueue) {
          const queueItem: ShortcutClipboardItem = {
            type: cellToQueue.type,
            content: cellToQueue.content,
            sourceId: cellToQueue.id,
            isCut: true
          };
          d.setCellQueue(prev => [...prev, queueItem]);
          d.cellQueueRef.current = [...d.cellQueueRef.current, queueItem];

          // Determine next cell to focus (prefer next, fallback to same cell if last one)
          const nextIdx = currentIdx < currentCells.length - 1 ? currentIdx + 1 : currentIdx - 1;
          const nextCellId = nextIdx >= 0 ? currentCells[nextIdx]?.id : focusedCellId;

          // Delete the cell (last cell will be cleared, not deleted)
          d.deleteCellRef.current(focusedCellId);

          // Explicitly focus the next cell in cell mode
          if (nextCellId) {
            d.setActiveCellId(nextCellId);
            d.setPendingFocus({ cellId: nextCellId, mode: 'cell' });
          }
        }
        return;
      }

      // D - Dequeue cell (paste oldest from FIFO queue below current cell)
      if (key === 'd' && d.addCellRef.current) {
        e.preventDefault();
        const queue = d.cellQueueRef.current;
        if (queue.length > 0) {
          const [first, ...rest] = queue;
          d.setCellQueue(() => rest);
          d.cellQueueRef.current = rest;
          // Insert below current cell
          const currentIdx = currentCells.findIndex(c => c.id === focusedCellId);
          const afterIdx = currentIdx >= 0 ? currentIdx : currentCells.length - 1;
          d.addCellRef.current(first.type, first.content, afterIdx);
        }
        return;
      }

      // Enter - Focus active cell editor (enter edit mode)
      if (key === 'Enter') {
        e.preventDefault();
        // Find and focus the CodeMirror editor for the active cell
        const cellElement = document.querySelector(`[data-cell-id="${focusedCellId}"] .cm-content`);
        if (cellElement instanceof HTMLElement) {
          cellElement.focus({ preventScroll: true });
        }
        return;
      }
    };

    // Use capture phase to intercept shortcuts before they're handled by child components
    // This is especially important for Cmd+S which browsers might try to handle natively
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);
}
