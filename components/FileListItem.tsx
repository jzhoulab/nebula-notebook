/**
 * FileListItem - Shared file/folder row component with hover actions
 *
 * Used by both FileBrowser and Dashboard for consistent UX.
 */

import { isNotebookExtension, isScriptNotebookExtension } from '../utils/notebookFormats';
import { classifyFileView } from '../lib/fileViewer';
import { readFile } from '../services/fileService';
import React, { useRef, useEffect, useState, memo } from 'react';
import {
  Folder,
  Book,
  FileCode,
  FileText,
  File,
  Copy,
  Trash2,
  Download,
  ExternalLink,
  Pencil,
} from 'lucide-react';
import { FileItem } from '../services/fileService';

interface FileListItemProps {
  item: FileItem;
  isCurrentFile?: boolean;
  onNavigate?: (path: string) => void;
  onSelect?: (path: string) => void;
  onOpenNewTab?: (path: string) => void;
  onOpenTextFile?: (item: FileItem) => void;
  onOpenImageFile?: (item: FileItem) => void;
  /** pdf / video / audio: open in the in-tab viewer modal (default on click). */
  onOpenViewer?: (item: FileItem) => void;
  onRename?: (item: FileItem, newName: string) => void;
  onDuplicate?: (item: FileItem) => void;
  onDownload?: (item: FileItem) => void;
  onDelete?: (item: FileItem) => void;
  compact?: boolean;
  /** Whether this item is currently being edited */
  isEditing?: boolean;
  /** Current edit value when editing */
  editValue?: string;
  /** Called when edit value changes */
  onEditChange?: (value: string) => void;
  /** Called to start editing this item */
  onStartEdit?: (item: FileItem) => void;
  /** Called when editing is cancelled (Escape) */
  onCancelEdit?: () => void;
  /** Called when editing is confirmed (Enter) */
  onConfirmEdit?: () => void;
  /** Move a file/folder into a destination folder (drag-and-drop). */
  onMoveItem?: (sourcePath: string, destFolderPath: string) => void;
}

// Format relative time
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp * 1000;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

// Get file icon
function getFileIcon(item: FileItem) {
  if (item.isDirectory) return <Folder className="w-4 h-4 text-blue-500" />;
  if (item.extension === '.ipynb') return <Book className="w-4 h-4 text-orange-500" />;
  if (item.extension === '.qmd') return <Book className="w-4 h-4 text-violet-500" />;
  if (item.extension === '.py') return <FileCode className="w-4 h-4 text-blue-500" />;
  if (item.extension?.toLowerCase() === '.r') return <FileCode className="w-4 h-4 text-sky-600" />;
  if (item.extension?.toLowerCase() === '.jl') return <FileCode className="w-4 h-4 text-purple-500" />;
  if (item.extension === '.csv') return <FileText className="w-4 h-4 text-green-500" />;
  if (item.extension === '.json') return <FileCode className="w-4 h-4 text-yellow-500" />;
  return <File className="w-4 h-4 text-slate-400" />;
}

const FileListItemComponent: React.FC<FileListItemProps> = ({
  item,
  isCurrentFile = false,
  onNavigate,
  onSelect,
  onOpenNewTab,
  onOpenTextFile,
  onOpenImageFile,
  onOpenViewer,
  onRename,
  onDuplicate,
  onDownload,
  onDelete,
  compact = false,
  isEditing = false,
  editValue = '',
  onEditChange,
  onStartEdit,
  onCancelEdit,
  onConfirmEdit,
  onMoveItem,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const view = classifyFileView(item.name || item.path);
  const isNotebook = isNotebookExtension(item.extension);
  const isHtml = view === 'html';
  const isImageFile = item.fileType === 'image'
    || ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif'].includes((item.extension || '').toLowerCase());
  // CSV/TSV: a tabular file — open the in-tab table viewer by default (it has
  // a raw-text fallback + open-in-new-tab), rather than the raw text editor.
  const isTabular = ['.csv', '.tsv'].includes((item.extension || '').toLowerCase());
  const isTextFile = view === 'text' && !isTabular;
  // pdf / video / audio (+ tabular) → open in the in-tab viewer modal.
  const isNewTabViewable = (view === 'newtab' && !isImageFile) || isTabular;
  const isOpenableInTab = isNotebook || isHtml || isTextFile || isTabular || view === 'newtab';
  const isClickable = (item.isDirectory || isNotebook || isTextFile || isHtml
    || (isNewTabViewable && onOpenViewer)
    || (isImageFile && onOpenImageFile)) && !isEditing;

  // Focus + select-name-without-extension ONCE when ENTERING edit mode.
  // Deliberately NOT keyed on editValue: with the controlled value in the
  // deps, every keystroke re-ran this effect and re-selected the whole name,
  // so each typed character replaced the entire filename (lab bug report).
  useEffect(() => {
    if (!isEditing || !inputRef.current) return;
    const input = inputRef.current;
    input.focus();
    const name = input.value;
    const dotIndex = name.lastIndexOf('.');
    if (dotIndex > 0 && !item.isDirectory) {
      input.setSelectionRange(0, dotIndex);
    } else {
      input.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  const handleClick = () => {
    if (isEditing) return;
    if (item.isDirectory && onNavigate) {
      onNavigate(item.path);
    } else if (isNotebook && onSelect) {
      onSelect(item.path);
    } else if (isTextFile && onOpenTextFile) {
      onOpenTextFile(item);
    } else if (isImageFile && onOpenImageFile) {
      onOpenImageFile(item);
    } else if (isNewTabViewable && onOpenViewer) {
      // pdf / video / audio: in-tab viewer by default (it has a new-tab button).
      onOpenViewer(item);
    } else if (isHtml && onOpenNewTab) {
      // HTML → trust-gated page (its own sandboxed view).
      onOpenNewTab(item.path);
    }
  };

  const handleAction = (e: React.MouseEvent, action: () => void) => {
    e.stopPropagation();
    action();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onConfirmEdit?.();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancelEdit?.();
    }
  };

  const handleBlur = () => {
    // Confirm on blur (clicking outside)
    onConfirmEdit?.();
  };

  // Determine which actions are available
  const hasRenameAction = onStartEdit && onRename;
  const hasFileActions = !item.isDirectory && (onOpenNewTab || hasRenameAction || onDuplicate || onDownload || onDelete);
  const hasFolderActions = item.isDirectory && (hasRenameAction || onDuplicate || onDelete);
  const hasActions = (hasFileActions || hasFolderActions) && !isEditing;

  return (
    <div
      onClick={isClickable ? handleClick : undefined}
      draggable={!isEditing && !!onMoveItem}
      onDragStart={onMoveItem ? (e) => {
        if (isEditing) { e.preventDefault(); return; }
        e.dataTransfer.setData('application/x-nebula-move', item.path);
        e.dataTransfer.setData('text/plain', item.path);
        e.dataTransfer.effectAllowed = 'move';
      } : undefined}
      onDragOver={item.isDirectory && onMoveItem ? (e) => {
        if (!e.dataTransfer.types.includes('application/x-nebula-move')) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (!isDropTarget) setIsDropTarget(true);
      } : undefined}
      onDragLeave={item.isDirectory && onMoveItem ? () => setIsDropTarget(false) : undefined}
      onDrop={item.isDirectory && onMoveItem ? (e) => {
        if (!e.dataTransfer.types.includes('application/x-nebula-move')) return;
        e.preventDefault();
        e.stopPropagation();
        setIsDropTarget(false);
        const src = e.dataTransfer.getData('application/x-nebula-move');
        if (src && src !== item.path) onMoveItem(src, item.path);
      } : undefined}
      className={`
        group relative flex items-center px-3 py-2 rounded-md transition-all
        ${isDropTarget ? 'ring-2 ring-blue-400 bg-blue-100/70' : ''}
        ${compact ? 'mb-1' : ''}
        ${isClickable ? 'cursor-pointer' : 'cursor-default'}
        ${isCurrentFile
          ? 'bg-blue-100/50 text-blue-900 font-medium'
          : isClickable
            ? 'text-slate-600 hover:bg-slate-200/50'
            : isEditing
              ? 'text-slate-600 bg-slate-100'
              : 'text-slate-500 opacity-60'
        }
      `}
    >
      {/* File icon and name */}
      <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
        {getFileIcon(item)}
        <div className="flex flex-col min-w-0 flex-1">
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => onEditChange?.(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              className="text-xs px-1.5 py-0.5 border border-blue-400 rounded bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 w-full"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className="text-xs truncate"
              title={item.name}
            >
              {item.name}
            </span>
          )}
          {!item.isDirectory && !compact && !isEditing && (
            <span className="text-[0.5625rem] text-slate-400 flex gap-2">
              {formatRelativeTime(item.modified)}
              <span>•</span>
              {item.size}
            </span>
          )}
        </div>
      </div>

      {/* Hover Actions */}
      {hasActions && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none group-hover:pointer-events-auto">
          <div className="flex bg-white shadow-sm rounded border border-slate-200">
            {/* File-specific actions */}
            {!item.isDirectory && (
              <>
                {isScriptNotebookExtension(item.extension) && onSelect && (
                  <button
                    onClick={(e) =>
                      handleAction(e, async () => {
                        // Content-based discrimination: marker/header-bearing
                        // scripts ARE notebooks and open silently; plain
                        // scripts get an informed-consent confirm first.
                        try {
                          const result = await readFile(item.path);
                          const text = typeof result.content === 'string' ? result.content : '';
                          const isPercent = /^#\s*%%/m.test(text) || text.startsWith('# ---\n');
                          if (!isPercent) {
                            const ok = window.confirm(
                              'This looks like a plain script. Opening it as a notebook will add # %% cell markers and cell ids when you save. Continue?'
                            );
                            if (!ok) return;
                          }
                        } catch {
                          // If the sniff fails, fall through and open anyway
                        }
                        onSelect(item.path);
                      })
                    }
                    className="p-1 text-slate-400 hover:text-orange-500 hover:bg-slate-100"
                    title="Open as notebook"
                  >
                    <Book className="w-3.5 h-3.5" />
                  </button>
                )}
                {isOpenableInTab && onOpenNewTab && (
                  <>
                    <button
                      onClick={(e) => handleAction(e, () => onOpenNewTab(item.path))}
                      className="p-1 text-slate-400 hover:text-green-600 hover:bg-green-50"
                      title="Open in new tab"
                    >
                      <ExternalLink className="w-3 h-3" />
                    </button>
                    {(hasRenameAction || onDuplicate || onDownload || onDelete) && (
                      <div className="w-[1px] bg-slate-200" />
                    )}
                  </>
                )}
                {hasRenameAction && (
                  <>
                    <button
                      onClick={(e) => handleAction(e, () => onStartEdit!(item))}
                      className="p-1 text-slate-400 hover:text-amber-600 hover:bg-amber-50"
                      title="Rename"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    {(onDuplicate || onDownload || onDelete) && <div className="w-[1px] bg-slate-200" />}
                  </>
                )}
                {onDuplicate && (
                  <>
                    <button
                      onClick={(e) => handleAction(e, () => onDuplicate(item))}
                      className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50"
                      title="Duplicate"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                    {(onDownload || onDelete) && <div className="w-[1px] bg-slate-200" />}
                  </>
                )}
                {onDownload && (
                  <>
                    <button
                      onClick={(e) => handleAction(e, () => onDownload(item))}
                      className="p-1 text-slate-400 hover:text-purple-600 hover:bg-purple-50"
                      title="Download"
                    >
                      <Download className="w-3 h-3" />
                    </button>
                    {onDelete && <div className="w-[1px] bg-slate-200" />}
                  </>
                )}
                {onDelete && (
                  <button
                    onClick={(e) => handleAction(e, () => onDelete(item))}
                    className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50"
                    title="Delete"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </>
            )}

            {/* Folder-specific actions */}
            {item.isDirectory && (
              <>
                {hasRenameAction && (
                  <>
                    <button
                      onClick={(e) => handleAction(e, () => onStartEdit!(item))}
                      className="p-1 text-slate-400 hover:text-amber-600 hover:bg-amber-50"
                      title="Rename folder"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    {(onDuplicate || onDelete) && <div className="w-[1px] bg-slate-200" />}
                  </>
                )}
                {onDuplicate && (
                  <>
                    <button
                      onClick={(e) => handleAction(e, () => onDuplicate(item))}
                      className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50"
                      title="Duplicate folder"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                    {onDelete && <div className="w-[1px] bg-slate-200" />}
                  </>
                )}
                {onDelete && (
                  <button
                    onClick={(e) => handleAction(e, () => onDelete(item))}
                    className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50"
                    title="Delete folder"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export const FileListItem = memo(FileListItemComponent);
FileListItem.displayName = 'FileListItem';
