import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Search, X, ChevronUp, ChevronDown, Replace, ReplaceAll } from 'lucide-react';
import { Cell } from '../types';

interface SearchMatch {
  cellIndex: number;
  cellId: string;
  startIndex: number;
  endIndex: number;
}

/** Escape a literal string for embedding in a RegExp (whole-word mode). */
function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface CurrentMatch {
  cellId: string;
  startIndex: number;
  endIndex: number;
}

interface Props {
  cells: Cell[];
  isOpen: boolean;
  readOnly?: boolean;
  onClose: () => void;
  onNavigateToCell: (cellIndex: number, cellId: string) => void;
  getCursorAnchor?: () => { cellId: string; pos: number; ts: number } | null;
  onSearchChange?: (query: string, caseSensitive: boolean, useRegex: boolean, currentMatch: CurrentMatch | null) => void;
  onReplace?: (cellId: string, startIndex: number, endIndex: number, replacement: string) => void;
  onReplaceAllInCell?: (cellId: string, query: string, replacement: string, caseSensitive: boolean, useRegex: boolean) => void;
  onReplaceAllInNotebook?: (query: string, replacement: string, caseSensitive: boolean, useRegex: boolean) => void;
  activeCellId?: string | null; // Start search from this cell
  initialQuery?: string;
}

export const NotebookSearch: React.FC<Props> = ({
  cells,
  isOpen,
  readOnly = false,
  onClose,
  onNavigateToCell,
  getCursorAnchor,
  onSearchChange,
  onReplace,
  onReplaceAllInCell,
  onReplaceAllInNotebook,
  activeCellId,
  initialQuery,
}) => {
  const [query, setQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regexError, setRegexError] = useState<string | null>(null);
  const [showReplace, setShowReplace] = useState(false);
  const [showReplaceAllMenu, setShowReplaceAllMenu] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceAllMenuRef = useRef<HTMLDivElement>(null);
  const navAnchorRef = useRef<{ cellId: string; pos: number; ts: number } | null>(null);
  // Set on Replace: after the cells update and matches recompute, jump to the
  // first match AFTER the replacement. Without this the same index re-selects
  // the replaced text when the replacement still contains the query
  // (preds → preds_train would recursively edit the same instance).
  const pendingReplaceAnchorRef = useRef<{ cellId: string; pos: number } | null>(null);

  // Whole-word mode is implemented as a query transform at the boundary:
  // downstream consumers (highlight decorations, replace-all) already speak
  // (query, caseSensitive, useRegex), so we hand them a \b-wrapped regex
  // instead of threading a fourth flag everywhere.
  const effectiveUseRegex = useRegex || wholeWord;
  const effectiveQuery = wholeWord && query
    ? `\\b(?:${useRegex ? query : escapeRegExpLiteral(query)})\\b`
    : query;

  // Focus input when opened
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
      searchInputRef.current.select();
    }
  }, [isOpen]);

  // Seed search query from selection when opening (or when Ctrl/Cmd+F is pressed again
  // with a new selection while search is already open).
  useEffect(() => {
    if (!isOpen || initialQuery === undefined) return;
    setQuery(initialQuery);
    setCurrentMatchIndex(0);
  }, [isOpen, initialQuery]);

  // Close replace all menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (replaceAllMenuRef.current && !replaceAllMenuRef.current.contains(e.target as Node)) {
        setShowReplaceAllMenu(false);
      }
    };
    if (showReplaceAllMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showReplaceAllMenu]);

  const getEffectiveAnchor = useCallback(() => {
    const cursor = getCursorAnchor?.() ?? null;
    const nav = navAnchorRef.current;

    // Prefer nav anchor on ties to avoid "cursor" updates that are not user-driven
    // (e.g., editor mount) from overriding navigation.
    if (cursor && (!nav || cursor.ts > nav.ts)) return cursor;
    return nav;
  }, [getCursorAnchor]);

  const findNextMatchIndexFromAnchor = useCallback((matchList: SearchMatch[], anchor: { cellId: string; pos: number }) => {
    const anchorCellIndex = cells.findIndex(c => c.id === anchor.cellId);
    if (anchorCellIndex === -1) return 0;

    const idx = matchList.findIndex(m =>
      m.cellIndex > anchorCellIndex ||
      (m.cellIndex === anchorCellIndex && m.startIndex >= anchor.pos)
    );
    return idx === -1 ? 0 : idx;
  }, [cells]);

  const findPrevMatchIndexFromAnchor = useCallback((matchList: SearchMatch[], anchor: { cellId: string; pos: number }) => {
    const anchorCellIndex = cells.findIndex(c => c.id === anchor.cellId);
    if (anchorCellIndex === -1) return matchList.length > 0 ? matchList.length - 1 : 0;

    for (let i = matchList.length - 1; i >= 0; i--) {
      const m = matchList[i];
      if (m.cellIndex < anchorCellIndex) return i;
      if (m.cellIndex === anchorCellIndex && m.endIndex < anchor.pos) return i;
    }
    return matchList.length > 0 ? matchList.length - 1 : 0;
  }, [cells]);

  // Notify parent of search query changes for highlighting
  useEffect(() => {
    // Only notify when search is open
    if (!isOpen) return;

    const currentMatch = matches.length > 0 ? {
      cellId: matches[currentMatchIndex]?.cellId,
      startIndex: matches[currentMatchIndex]?.startIndex,
      endIndex: matches[currentMatchIndex]?.endIndex,
    } : null;
    // Report the EFFECTIVE query (whole-word mode hands downstream a \b-wrapped
    // regex) so cell highlight decorations match exactly what we matched here.
    onSearchChange?.(effectiveQuery, caseSensitive, effectiveUseRegex, currentMatch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, effectiveQuery, caseSensitive, effectiveUseRegex, currentMatchIndex, matches]); // Intentionally exclude onSearchChange to prevent infinite loops

  // Track previous query to detect query changes vs cell content changes
  const prevQueryRef = useRef(query);
  const prevCaseSensitiveRef = useRef(caseSensitive);
  const prevUseRegexRef = useRef(useRegex);
  const prevWholeWordRef = useRef(wholeWord);

  // Search through cells
  useEffect(() => {
    // Don't search when closed
    if (!isOpen) return;

    if (!query.trim()) {
      setMatches([]);
      setCurrentMatchIndex(0);
      setRegexError(null);
      prevQueryRef.current = query;
      return;
    }

    const newMatches: SearchMatch[] = [];

    // Build regex or use string search (whole-word mode always goes through
    // the regex path via the \b-wrapped effective query)
    let regex: RegExp | null = null;
    if (effectiveUseRegex) {
      try {
        regex = new RegExp(effectiveQuery, caseSensitive ? 'g' : 'gi');
        setRegexError(null);
      } catch (e) {
        setRegexError((e as Error).message);
        setMatches([]);
        return;
      }
    }

    cells.forEach((cell, cellIndex) => {
      if (effectiveUseRegex && regex) {
        // Regex search
        regex.lastIndex = 0; // Reset regex state
        let match;
        while ((match = regex.exec(cell.content)) !== null) {
          newMatches.push({
            cellIndex,
            cellId: cell.id,
            startIndex: match.index,
            endIndex: match.index + match[0].length,
          });
          // Prevent infinite loop on zero-length matches
          if (match[0].length === 0) regex.lastIndex++;
        }
      } else {
        // String search
        const searchQuery = caseSensitive ? query : query.toLowerCase();
        const content = caseSensitive ? cell.content : cell.content.toLowerCase();
        let startIndex = 0;

        while (true) {
          const foundIndex = content.indexOf(searchQuery, startIndex);
          if (foundIndex === -1) break;

          newMatches.push({
            cellIndex,
            cellId: cell.id,
            startIndex: foundIndex,
            endIndex: foundIndex + query.length,
          });

          startIndex = foundIndex + 1;
        }
      }
    });

    setMatches(newMatches);

    // Only navigate to first match when query changes, not when cell content changes
    const queryChanged = query !== prevQueryRef.current ||
                         caseSensitive !== prevCaseSensitiveRef.current ||
                         useRegex !== prevUseRegexRef.current ||
                         wholeWord !== prevWholeWordRef.current;

    // After a Replace, advance to the first match AFTER the replacement —
    // otherwise a replacement that still contains the query (preds →
    // preds_train) is re-selected and Replace loops on the same instance.
    if (!queryChanged && pendingReplaceAnchorRef.current) {
      const anchor = pendingReplaceAnchorRef.current;
      pendingReplaceAnchorRef.current = null;
      if (newMatches.length > 0) {
        const nextIndex = findNextMatchIndexFromAnchor(newMatches, anchor);
        setCurrentMatchIndex(nextIndex);
        onNavigateToCell(newMatches[nextIndex].cellIndex, newMatches[nextIndex].cellId);
        navAnchorRef.current = { cellId: newMatches[nextIndex].cellId, pos: newMatches[nextIndex].endIndex, ts: Date.now() };
      } else {
        setCurrentMatchIndex(0);
      }
    } else if (!queryChanged && newMatches.length > 0 && currentMatchIndex >= newMatches.length) {
      // Content change shrank the match list — clamp the stale index
      setCurrentMatchIndex(newMatches.length - 1);
    }

    if (queryChanged && newMatches.length > 0) {
      // VS Code behavior: when the query changes, find the first match at or
      // after the CURRENT position. This means:
      // - First search: start from cursor/active cell
      // - Editing query (e.g., "forward" → "for"): stay near the current match
      //
      // We use the current match position if available (user was already
      // navigating matches), otherwise fall back to cursor/active cell.
      const currentMatch = matches[currentMatchIndex];
      const anchor = currentMatch
        ? { cellId: currentMatch.cellId, pos: currentMatch.startIndex }
        : getEffectiveAnchor();
      let startIndex: number;

      if (anchor) {
        startIndex = findNextMatchIndexFromAnchor(newMatches, anchor);
      } else {
        const activeCellIndex = activeCellId
          ? cells.findIndex(c => c.id === activeCellId)
          : 0;
        startIndex = newMatches.findIndex(m => m.cellIndex >= activeCellIndex);
        if (startIndex === -1) startIndex = 0;
      }

      setCurrentMatchIndex(startIndex);
      onNavigateToCell(newMatches[startIndex].cellIndex, newMatches[startIndex].cellId);
      navAnchorRef.current = { cellId: newMatches[startIndex].cellId, pos: newMatches[startIndex].endIndex, ts: Date.now() };
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    } else if (queryChanged) {
      setCurrentMatchIndex(0);
    }

    prevQueryRef.current = query;
    prevCaseSensitiveRef.current = caseSensitive;
    prevUseRegexRef.current = useRegex;
    prevWholeWordRef.current = wholeWord;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, query, cells, caseSensitive, useRegex, wholeWord, onNavigateToCell, activeCellId, findNextMatchIndexFromAnchor]);

  const goToMatch = useCallback((index: number) => {
    if (matches.length === 0) return;

    const wrappedIndex = ((index % matches.length) + matches.length) % matches.length;
    setCurrentMatchIndex(wrappedIndex);

    const match = matches[wrappedIndex];
    onNavigateToCell(match.cellIndex, match.cellId);
    navAnchorRef.current = { cellId: match.cellId, pos: match.endIndex, ts: Date.now() };

    // Re-focus search input after navigation
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [matches, onNavigateToCell]);

  // VSCode-style navigation: simply increment/decrement and wrap around.
  // Anchor-based positioning is only used when the query CHANGES (in the
  // useEffect above) to pick the starting match nearest the cursor.
  const goToNextMatch = useCallback(() => {
    if (matches.length === 0) return;
    goToMatch((currentMatchIndex + 1) % matches.length);
  }, [currentMatchIndex, goToMatch, matches]);

  const goToPrevMatch = useCallback(() => {
    if (matches.length === 0) return;
    goToMatch((currentMatchIndex - 1 + matches.length) % matches.length);
  }, [currentMatchIndex, goToMatch, matches]);

  // Replace current match, then advance to the next match past the
  // replacement (handled when matches recompute — see the search effect)
  const handleReplace = useCallback(() => {
    if (readOnly || matches.length === 0 || !onReplace) return;

    const match = matches[currentMatchIndex];
    pendingReplaceAnchorRef.current = {
      cellId: match.cellId,
      pos: match.startIndex + replaceText.length,
    };
    onReplace(match.cellId, match.startIndex, match.endIndex, replaceText);

    // Re-focus search input after replace
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [readOnly, matches, currentMatchIndex, replaceText, onReplace]);

  // Replace all in current cell
  const handleReplaceAllInCell = useCallback(() => {
    if (readOnly || matches.length === 0 || !onReplaceAllInCell) return;

    const currentCellId = matches[currentMatchIndex]?.cellId;
    if (currentCellId) {
      onReplaceAllInCell(currentCellId, effectiveQuery, replaceText, caseSensitive, effectiveUseRegex);
    }
    setShowReplaceAllMenu(false);

    // Re-focus search input
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [readOnly, matches, currentMatchIndex, effectiveQuery, replaceText, caseSensitive, effectiveUseRegex, onReplaceAllInCell]);

  // Replace all in notebook
  const handleReplaceAllInNotebook = useCallback(() => {
    if (readOnly || !query || !onReplaceAllInNotebook) return;

    onReplaceAllInNotebook(effectiveQuery, replaceText, caseSensitive, effectiveUseRegex);
    setShowReplaceAllMenu(false);

    // Re-focus search input
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [readOnly, query, effectiveQuery, replaceText, caseSensitive, effectiveUseRegex, onReplaceAllInNotebook]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      if (e.shiftKey) {
        goToPrevMatch();
      } else {
        goToNextMatch();
      }
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      // Ctrl/Cmd+Enter to replace
      e.preventDefault();
      handleReplace();
    }
  };

  // Get count of matches in current cell
  const currentCellMatchCount = matches.filter(m => m.cellId === matches[currentMatchIndex]?.cellId).length;

  if (!isOpen) return null;

  return (
    <div data-notebook-search className="fixed top-16 right-4 z-50 bg-white rounded-lg shadow-xl border border-slate-200 p-2 flex flex-col gap-2">
      {/* Search row */}
      <div className="flex items-center gap-2">
        <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
        <input
          ref={searchInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search in notebook..."
          className="w-48 px-2 py-1 text-sm border-none outline-none bg-transparent"
          autoFocus
        />

        {query && (
          <span className={`text-xs min-w-[3.75rem] ${regexError ? 'text-red-500' : 'text-slate-500'}`}>
            {regexError
              ? 'Invalid regex'
              : matches.length > 0
                ? `${currentMatchIndex + 1} of ${matches.length}`
                : 'No matches'}
          </span>
        )}

        <div className="flex items-center border-l border-slate-200 pl-2 gap-1">
          <button
            onClick={goToPrevMatch}
            disabled={matches.length === 0}
            className="p-1 hover:bg-slate-100 rounded disabled:opacity-30"
            title="Previous (Shift+Enter)"
          >
            <ChevronUp className="w-4 h-4" />
          </button>
          <button
            onClick={goToNextMatch}
            disabled={matches.length === 0}
            className="p-1 hover:bg-slate-100 rounded disabled:opacity-30"
            title="Next (Enter)"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>

        <button
          onClick={() => setCaseSensitive(!caseSensitive)}
          className={`px-1.5 py-0.5 text-xs font-mono rounded ${
            caseSensitive ? 'bg-blue-100 text-blue-700' : 'text-slate-400 hover:bg-slate-100'
          }`}
          title="Case sensitive"
        >
          Aa
        </button>

        <button
          onClick={() => setWholeWord(!wholeWord)}
          className={`px-1.5 py-0.5 text-xs font-mono rounded ${
            wholeWord ? 'bg-blue-100 text-blue-700' : 'text-slate-400 hover:bg-slate-100'
          }`}
          title="Match whole word"
          aria-label="Match whole word"
        >
          <span className="border-b border-current">ab</span>
        </button>

        <button
          onClick={() => setUseRegex(!useRegex)}
          className={`px-1.5 py-0.5 text-xs font-mono rounded ${
            useRegex ? 'bg-blue-100 text-blue-700' : 'text-slate-400 hover:bg-slate-100'
          }`}
          title="Use regular expression"
        >
          .*
        </button>

        {!readOnly && (
          <button
            onClick={() => setShowReplace(!showReplace)}
            className={`p-1 rounded ${showReplace ? 'bg-blue-100 text-blue-700' : 'text-slate-400 hover:bg-slate-100'}`}
            title="Toggle replace"
          >
            <Replace className="w-4 h-4" />
          </button>
        )}

        <button
          onClick={onClose}
          className="p-1 hover:bg-slate-100 rounded"
          title="Close (Esc)"
        >
          <X className="w-4 h-4 text-slate-400" />
        </button>
      </div>

      {/* Replace row */}
      {!readOnly && showReplace && (
        <div className="flex items-center gap-2 pl-6">
          <input
            ref={replaceInputRef}
            type="text"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Replace with..."
            className="w-48 px-2 py-1 text-sm border border-slate-200 rounded outline-none focus:border-blue-400"
          />

          <button
            onClick={handleReplace}
            disabled={matches.length === 0}
            className="px-2 py-1 text-xs bg-slate-100 hover:bg-slate-200 rounded disabled:opacity-30"
            title="Replace (Ctrl+Enter)"
          >
            Replace
          </button>

          <div className="relative" ref={replaceAllMenuRef}>
            <button
              onClick={() => setShowReplaceAllMenu(!showReplaceAllMenu)}
              disabled={matches.length === 0}
              className="px-2 py-1 text-xs bg-slate-100 hover:bg-slate-200 rounded disabled:opacity-30 flex items-center gap-1"
              title="Replace all options"
            >
              <ReplaceAll className="w-3 h-3" />
              Replace All
              <ChevronDown className="w-3 h-3" />
            </button>

            {showReplaceAllMenu && (
              <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[10rem] z-10">
                <button
                  onClick={handleReplaceAllInCell}
                  className="w-full px-3 py-1.5 text-xs text-left hover:bg-slate-100 flex items-center justify-between"
                >
                  <span>In this cell</span>
                  <span className="text-slate-400">({currentCellMatchCount})</span>
                </button>
                <button
                  onClick={handleReplaceAllInNotebook}
                  className="w-full px-3 py-1.5 text-xs text-left hover:bg-slate-100 flex items-center justify-between"
                >
                  <span>In all cells</span>
                  <span className="text-slate-400">({matches.length})</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Hook to get the current search query for highlighting in cells
export function useSearchHighlight() {
  const [searchState, setSearchState] = useState<{
    query: string;
    caseSensitive: boolean;
  } | null>(null);

  return { searchState, setSearchState };
}
