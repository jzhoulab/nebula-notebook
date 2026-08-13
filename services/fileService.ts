/**
 * File Service - Real filesystem operations via backend API
 */
import { isNotebookExtension, stripNotebookExtension, getPathExtension } from '../utils/notebookFormats';
import { Cell, NotebookMetadata } from '../types';
import { TimestampedOperation } from '../hooks/useUndoRedo';
const API_BASE = '/api';

export interface FileItem {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  size: string;
  sizeBytes: number;
  modified: number;
  extension: string;
  fileType: 'folder' | 'notebook' | 'code' | 'data' | 'image' | 'document' | 'file';
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  mtime: number;
  items: FileItem[];
}

export interface DirectoryMtime {
  path: string;
  mtime: number;
}

export interface FileMtime {
  path: string;
  mtime: number;
}

export interface NotebookData {
  path: string;
  cells: Cell[];
  mtime: number;
}

export interface SaveResult {
  success: boolean;
  mtime: number;
}

export interface RootDirectoryResponse {
  root: string;
}

// Storage keys for local state
const STORAGE_ACTIVE_PATH = 'nebula-active-path';

const getShadowSerializeConfig = () => {
  if (typeof window === 'undefined') {
    return { enabled: false, logMatches: false, sample: 1 };
  }
  const globals = window as typeof window & {
    __NEBULA_SERIALIZE_SHADOW__?: boolean;
    __NEBULA_SERIALIZE_SHADOW_LOG__?: boolean;
    __NEBULA_SERIALIZE_SHADOW_SAMPLE__?: number;
  };
  return {
    enabled: globals.__NEBULA_SERIALIZE_SHADOW__ ?? false,
    logMatches: globals.__NEBULA_SERIALIZE_SHADOW_LOG__ ?? true,
    sample: globals.__NEBULA_SERIALIZE_SHADOW_SAMPLE__ ?? 1,
  };
};

const shouldRunShadowSerialize = (sample: number) => {
  if (!Number.isFinite(sample) || sample <= 0) return false;
  if (sample === 1) return true;
  if (sample < 1) return Math.random() < sample;
  return Math.random() < 1 / sample;
};

/**
 * Build save payload as a Blob. Each cell stringified individually,
 * Blob holds references — no single joined string. Temporary ~800MB spike
 * for 500MB notebooks, GC'd immediately after send.
 */
// Sentinel replacing a code cell's outputs when they haven't changed since the
// last successful save — the server re-uses the outputs already in the file.
// Autosave payloads are dominated by base64 image outputs that rarely change;
// over a slow uplink (SSH tunnel through a VPN, measured ~52 KB/s) re-uploading
// them saturated the tunnel for ~20s per save and starved the terminal.
const OUTPUTS_UNCHANGED_SENTINEL = '__nebula-outputs-unchanged-v1__';

// Per-notebook: each code cell's outputs hash as of its last successful save.
// Cleared on notebook load so the first save after a (re)load is always full.
const savedOutputsHashes = new Map<string, Map<string, string>>();

/** Fast non-cryptographic hash (djb2 + length) for change detection only. */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + s.length;
}

/**
 * Seed the outputs-elision baseline from freshly LOADED cells: the in-memory
 * outputs are byte-identical to the file at this instant, so the FIRST save
 * after opening can already elide unchanged outputs. Without this, that first
 * save shipped the full payload — observed 1.2MB+ on plot-heavy notebooks,
 * which used to saturate slow tunnels for many seconds. Hashes are computed
 * exactly like buildSavePayload's, on the same in-memory objects.
 */
export const seedOutputsBaseline = (path: string, cells: Cell[]): void => {
  const hashes = new Map<string, string>();
  for (const cell of cells) {
    if (cell.type === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      hashes.set(cell.id, hashString(JSON.stringify(cell.outputs)));
    }
  }
  savedOutputsHashes.set(path, hashes);
};

const buildSavePayload = (
  path: string,
  cells: Cell[],
  kernelName?: string,
  history?: TimestampedOperation[],
  priorHashes?: Map<string, string> | null,
): { blob: Blob; hashes: Map<string, string>; elided: number } => {
  const hashes = new Map<string, string>();
  let elided = 0;
  const parts: string[] = [`{"path":${JSON.stringify(path)},"cells":[`];
  for (let i = 0; i < cells.length; i++) {
    if (i > 0) parts.push(',');
    const cell = cells[i];
    if (cell.type === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      const h = hashString(JSON.stringify(cell.outputs));
      hashes.set(cell.id, h);
      if (priorHashes && priorHashes.get(cell.id) === h) {
        elided++;
        parts.push(JSON.stringify({ ...cell, outputs: OUTPUTS_UNCHANGED_SENTINEL as unknown as Cell['outputs'] }));
        continue;
      }
    }
    parts.push(JSON.stringify(cell));
  }
  parts.push(']');
  if (kernelName !== undefined) parts.push(`,"kernel_name":${JSON.stringify(kernelName)}`);
  if (history !== undefined) parts.push(`,"history":${JSON.stringify(history)}`);
  parts.push('}');
  return { blob: new Blob(parts, { type: 'application/json' }), hashes, elided };
};

// Directory of the notebook currently open in the editor. Kernels start with
// cwd = the notebook's directory, so relative paths typed in cells resolve
// against it — the file-path completion source uses this as its base.
let activeNotebookDir: string | null = null;
export const setActiveNotebookPath = (path: string | null): void => {
  if (!path) { activeNotebookDir = null; return; }
  const i = path.lastIndexOf('/');
  activeNotebookDir = i > 0 ? path.slice(0, i) : i === 0 ? '/' : null;
};
export const getActiveNotebookDir = (): string | null => activeNotebookDir;

/**
 * List contents of a directory
 */
export const listDirectory = async (path: string = '~'): Promise<DirectoryListing> => {
  const response = await fetch(`${API_BASE}/fs/list?path=${encodeURIComponent(path)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to list directory');
  }

  return response.json();
};

/**
 * Get server root directory
 */
export const getRootDirectory = async (): Promise<string> => {
  const response = await fetch(`${API_BASE}/fs/root`);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to get root directory');
  }
  const data = await response.json() as RootDirectoryResponse;
  return data.root;
};

/**
 * Set server root directory
 */
export const setRootDirectory = async (root: string): Promise<string> => {
  const response = await fetch(`${API_BASE}/fs/root`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to set root directory');
  }

  const data = await response.json() as RootDirectoryResponse;
  return data.root;
};

/**
 * Get directory modification time (lightweight change detection)
 */
export const getDirectoryMtime = async (path: string = '~'): Promise<DirectoryMtime> => {
  const response = await fetch(`${API_BASE}/fs/mtime?path=${encodeURIComponent(path)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to get directory mtime');
  }

  return response.json();
};

/**
 * Get file modification time (lightweight change detection)
 */
export const getFileMtime = async (path: string): Promise<FileMtime> => {
  const response = await fetch(`${API_BASE}/fs/file-mtime?path=${encodeURIComponent(path)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to get file mtime');
  }

  return response.json();
};

/**
 * Read a file's contents
 */
export const readFile = async (path: string): Promise<{ path: string; type: string; content: any }> => {
  const response = await fetch(`${API_BASE}/fs/read?path=${encodeURIComponent(path)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to read file');
  }

  return response.json();
};

/**
 * Download a file to the user's computer
 */
export const downloadFile = async (path: string, filename: string): Promise<void> => {
  // Use dedicated download endpoint that streams raw file content
  const response = await fetch(`${API_BASE}/fs/download?path=${encodeURIComponent(path)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to download file');
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

/**
 * Write content to a file
 */
export const writeFile = async (path: string, content: any, fileType: string = 'text'): Promise<void> => {
  const response = await fetch(`${API_BASE}/fs/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, file_type: fileType })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to write file');
  }
};

/**
 * Create a new file or directory
 */
export const createFile = async (path: string, isDirectory: boolean = false): Promise<FileItem> => {
  const response = await fetch(`${API_BASE}/fs/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, is_directory: isDirectory })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to create file');
  }

  const data = await response.json();
  return data.file;
};

/**
 * Create a new folder (convenience wrapper for createFile)
 */
export const createFolder = async (parentDir: string, name: string): Promise<FileItem> => {
  const folderPath = parentDir.endsWith('/') ? `${parentDir}${name}` : `${parentDir}/${name}`;
  return createFile(folderPath, true);
};

/**
 * Delete a file or directory
 */
export const deleteFile = async (path: string): Promise<void> => {
  const response = await fetch(`${API_BASE}/fs/delete?path=${encodeURIComponent(path)}`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to delete file');
  }
};

/**
 * Rename/move a file or directory
 */
export const renameFile = async (oldPath: string, newPath: string): Promise<FileItem> => {
  const response = await fetch(`${API_BASE}/fs/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_path: oldPath, new_path: newPath })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to rename file');
  }

  const data = await response.json();
  return data.file;
};

/**
 * Duplicate a file
 */
export const duplicateFile = async (sourcePath: string): Promise<FileItem> => {
  const response = await fetch(`${API_BASE}/fs/duplicate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: sourcePath })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to duplicate file');
  }

  const data = await response.json();
  return data.file;
};

/**
 * Upload a file to a directory
 */
export const uploadFile = async (directory: string, file: File): Promise<FileItem> => {
  const formData = new FormData();
  // path must come before file — @fastify/multipart's request.file() may
  // not see fields that follow the file part in the multipart stream.
  formData.append('path', directory);
  formData.append('file', file);

  const response = await fetch(`${API_BASE}/fs/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to upload file');
  }

  const data = await response.json();
  return data.file;
};

/**
 * Notebook data including cells and metadata
 */
export interface NotebookData {
  path: string;        // normalized absolute path from backend
  cells: Cell[];
  kernelspec: string;  // kernel name from notebook metadata
  mtime: number;       // modification time for conflict detection
  access: NotebookAccess;
}

export type NotebookAccess =
  | { read_only: false }
  | { read_only: true; reason: 'sealed'; seal_id: string };

export interface NotebookReadOptions {
  /** Evidence-link assertion; the server verifies it against the canonical path. */
  sealId?: string;
}

/**
 * Get notebook cells from a .ipynb file
 * @deprecated Use getNotebookData instead to get kernelspec and mtime
 */
export const getNotebookCells = async (path: string): Promise<Cell[]> => {
  const data = await getNotebookData(path);
  return data.cells;
};

/**
 * Get notebook data including cells, kernelspec, and mtime.
 * Results are cached briefly (500ms) so React Strict Mode double-mounts
 * reuse the same cell objects instead of creating a second copy (~500MB saved).
 */
let _notebookDataCache: {
  requestPath: string;
  canonicalPath: string;
  sealId?: string;
  data: NotebookData;
  ts: number;
} | null = null;

export const getNotebookData = async (path: string, options: NotebookReadOptions = {}): Promise<NotebookData> => {
  // Return cached result if same path and <500ms old (Strict Mode double-mount)
  if (
    _notebookDataCache &&
    (_notebookDataCache.requestPath === path || _notebookDataCache.canonicalPath === path) &&
    _notebookDataCache.sealId === options.sealId &&
    Date.now() - _notebookDataCache.ts < 500
  ) {
    return _notebookDataCache.data;
  }

  const query = new URLSearchParams({ path });
  if (options.sealId) query.set('seal', options.sealId);
  const response = await fetch(`${API_BASE}/notebook/cells?${query.toString()}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to read notebook');
  }

  const data = await response.json();
  const result: NotebookData = {
    path: data.path || path,
    cells: data.cells,
    kernelspec: data.kernelspec || 'python3',
    mtime: data.mtime,
    access: data.access?.read_only === true && data.access?.reason === 'sealed' && typeof data.access?.seal_id === 'string'
      ? { read_only: true, reason: 'sealed', seal_id: data.access.seal_id }
      : { read_only: false },
  };

  // Fresh load: drop elision hashes so the next save is full — the in-memory
  // state was just (re)seeded from disk and prior hashes may be stale.
  savedOutputsHashes.delete(path);
  savedOutputsHashes.delete(result.path);

  // Cache briefly for Strict Mode dedup
  _notebookDataCache = {
    requestPath: path,
    canonicalPath: result.path,
    sealId: options.sealId,
    data: result,
    ts: Date.now(),
  };
  setTimeout(() => {
    if (
      _notebookDataCache?.requestPath === path &&
      _notebookDataCache?.canonicalPath === result.path
    ) {
      _notebookDataCache = null;
    }
  }, 1000);

  return result;
};

/**
 * Save cells to a notebook file
 * @param path - Path to the notebook file
 * @param cells - Cells to save
 * @param kernelName - Optional kernel name to persist in notebook metadata
 * @returns SaveResult with success status and new mtime for conflict detection
 */
// Stamp logged with every save so it's verifiable in DevTools which client
// build is running and what each autosave costs over the wire.
const NEBULA_CLIENT_BUILD = 'delta-save-2026-07-08';

/**
 * Gzip a payload with the browser's native CompressionStream.
 * Returns null when unsupported so the caller falls back to plain JSON.
 */
async function gzipBlob(blob: Blob): Promise<ArrayBuffer | null> {
  try {
    const CS = (globalThis as { CompressionStream?: new (f: string) => ReadableWritablePair<Uint8Array, Uint8Array> }).CompressionStream;
    if (!CS) return null;
    const stream = blob.stream().pipeThrough(new CS('gzip'));
    return await new Response(stream).arrayBuffer();
  } catch {
    return null;
  }
}

/** POST one save payload, gzipped when large (slow-uplink tunnels). */
const postSavePayload = async (blob: Blob, elided: number): Promise<Response> => {
  const gz = blob.size > 16_384 ? await gzipBlob(blob) : null;
  console.log(
    `[nebula ${NEBULA_CLIENT_BUILD}] autosave ${(blob.size / 1024).toFixed(0)}KB` +
    (elided > 0 ? ` (${elided} cells' unchanged outputs elided)` : '') +
    (gz ? ` → gzip ${(gz.byteLength / 1024).toFixed(0)}KB on the wire` : '')
  );
  return fetch(`${API_BASE}/notebook/save`, {
    method: 'POST',
    headers: { 'Content-Type': gz ? 'application/gzip' : 'application/json' },
    body: gz ?? blob,
  });
};

export const saveNotebookCells = async (
  path: string,
  cells: Cell[],
  kernelName?: string,
  history?: any[],
): Promise<SaveResult> => {
  // Payload diet: elide outputs unchanged since the last successful save
  // (sentinel resolved server-side from the file), then gzip what remains.
  const prior = savedOutputsHashes.get(path) ?? null;
  let { blob, hashes, elided } = buildSavePayload(path, cells, kernelName, history, prior);
  let response = await postSavePayload(blob, elided);

  // Server couldn't resolve a sentinel (ids changed, external rewrite…):
  // retry once with the full payload.
  if (response.status === 409) {
    const err = await response.json().catch(() => ({} as { code?: string }));
    if (err?.code !== 'needs_full') {
      throw new Error(err?.detail || 'Failed to save notebook');
    }
    savedOutputsHashes.delete(path);
    ({ blob, hashes, elided } = buildSavePayload(path, cells, kernelName, history, null));
    response = await postSavePayload(blob, 0);
  }

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to save notebook');
  }

  const data = await response.json();
  // This save is now what's on disk — future saves elide against it.
  savedOutputsHashes.set(path, hashes);
  return { success: true, mtime: data.mtime };
};

// --- Compatibility layer for existing code ---

/**
 * Get files - for backward compatibility
 * Now returns notebooks from current directory
 */
export const getFiles = async (): Promise<NotebookMetadata[]> => {
  try {
    const listing = await listDirectory('~');
    return listing.items
      .filter(item => isNotebookExtension(item.extension))
      .map(item => ({
        id: item.path,
        name: stripNotebookExtension(item.name),
        lastModified: item.modified * 1000,
        fileType: 'notebook' as const,
        extension: item.extension || '.ipynb',
        size: item.size
      }));
  } catch (e) {
    console.error('Failed to list files:', e);
    return [];
  }
};

/**
 * Get file content with mtime - for conflict detection
 */
export const getFileContentWithMtime = async (
  id: string,
  options: NotebookReadOptions = {},
): Promise<NotebookData | null> => {
  try {
    return await getNotebookData(id, options);
  } catch (e) {
    console.error('Failed to get file content:', e);
    return null;
  }
};

/**
 * Get file content - for backward compatibility (without mtime)
 */
export const getFileContent = async (id: string): Promise<Cell[] | null> => {
  try {
    const result = await getNotebookData(id);
    return result.cells;
  } catch (e) {
    console.error('Failed to get file content:', e);
    return null;
  }
};

/**
 * Save file content with mtime - for conflict detection
 */
export const saveFileContentWithMtime = async (
  id: string,
  cells: Cell[],
  kernelName?: string,
  history?: any[],
): Promise<SaveResult | null> => {
  try {
    return await saveNotebookCells(id, cells, kernelName, history);
  } catch (e) {
    console.error('Failed to save file content:', e);
    return null;
  }
};

/**
 * Save file content - for backward compatibility (without mtime)
 */
export const saveFileContent = async (id: string, cells: Cell[]): Promise<boolean> => {
  try {
    await saveNotebookCells(id, cells);
    return true;
  } catch (e) {
    console.error('Failed to save file content:', e);
    return false;
  }
};

/**
 * Create a new notebook
 */
export const createNotebook = async (
  name: string,
  initialCells: Cell[],
  directory?: string,
  extension: '.ipynb' | '.qmd' | '.py' = '.ipynb'
): Promise<NotebookMetadata> => {
  const dir = directory || '~';

  const fullPath = `${dir}/${name}${extension}`;

  const response = await fetch(`${API_BASE}/notebook/operation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation: {
        type: 'createNotebook',
        notebookPath: fullPath,
        overwrite: false,
        kernelName: 'python3',
        kernelDisplayName: 'Python 3',
      },
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to create notebook');
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || 'Failed to create notebook');
  }

  if (initialCells.length > 0) {
    await saveNotebookCells(fullPath, initialCells);
  }

  return {
    id: fullPath,
    name,
    lastModified: Date.now(),
    fileType: 'notebook',
    extension,
    size: '1KB'
  };
};

/**
 * Delete a notebook
 */
export const deleteNotebook = async (id: string): Promise<void> => {
  await deleteFile(id);
};

/**
 * Update notebook metadata (rename)
 */
export const updateNotebookMetadata = async (id: string, updates: Partial<NotebookMetadata>): Promise<void> => {
  if (updates.name) {
    const dir = id.substring(0, id.lastIndexOf('/'));
    // Preserve the file's actual extension (.ipynb, .qmd, .py)
    const ext = getPathExtension(id) || '.ipynb';
    const newPath = `${dir}/${updates.name}${ext}`;
    await renameFile(id, newPath);
  }
};

/**
 * Save active file path
 */
export const saveActiveFileId = (path: string): void => {
  localStorage.setItem(STORAGE_ACTIVE_PATH, path);
};

/**
 * Get active file path
 */
export const getActiveFileId = (): string | null => {
  return localStorage.getItem(STORAGE_ACTIVE_PATH);
};

/**
 * Initialize file system - compatibility function
 */
export const initFileSystem = async (defaultCells: Cell[]): Promise<void> => {
  // Check if we have any saved state
  const activePath = getActiveFileId();
  if (activePath) {
    try {
      // Verify the file still exists
      await readFile(activePath);
      return;
    } catch {
      // File doesn't exist, clear the active path
      localStorage.removeItem(STORAGE_ACTIVE_PATH);
    }
  }

  // No active file, user will need to create or open one
};

// --- History Persistence ---

/**
 * Load operation history for a notebook from .nebula directory
 */
export const loadNotebookHistory = async (notebookPath: string): Promise<TimestampedOperation[]> => {
  try {
    const response = await fetch(
      `${API_BASE}/notebook/history?notebook_path=${encodeURIComponent(notebookPath)}`
    );

    if (!response.ok) {
      console.warn('Failed to load history:', await response.text());
      return [];
    }

    const data = await response.json();
    return data.history || [];
  } catch (error) {
    console.warn('Failed to load notebook history:', error);
    return [];
  }
};

/**
 * Save operation history for a notebook to .nebula directory
 */
export const saveNotebookHistory = async (
  notebookPath: string,
  history: TimestampedOperation[]
): Promise<boolean> => {
  try {
    const response = await fetch(`${API_BASE}/notebook/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebook_path: notebookPath,
        history
      })
    });

    if (!response.ok) {
      console.warn('Failed to save history:', await response.text());
      return false;
    }

    return true;
  } catch (error) {
    console.warn('Failed to save notebook history:', error);
    return false;
  }
};

// --- Session State Persistence ---

/**
 * Session state structure for restoring user's editing context
 */
export interface SessionState {
  unflushedEdit?: {
    cellId: string;
    lastFlushedContent: string;
  };
  activeCellId?: string; // Last focused cell - scroll here on refresh
}

/**
 * Load session state for a notebook from .nebula directory
 */
export const loadNotebookSession = async (notebookPath: string): Promise<SessionState> => {
  try {
    const response = await fetch(
      `${API_BASE}/notebook/session?notebook_path=${encodeURIComponent(notebookPath)}`
    );

    if (!response.ok) {
      console.warn('Failed to load session:', await response.text());
      return {};
    }

    const data = await response.json();
    return data.session || {};
  } catch (error) {
    console.warn('Failed to load notebook session:', error);
    return {};
  }
};

/**
 * Save session state for a notebook to .nebula directory
 */
export const saveNotebookSession = async (
  notebookPath: string,
  session: SessionState
): Promise<boolean> => {
  try {
    const response = await fetch(`${API_BASE}/notebook/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebook_path: notebookPath,
        session
      })
    });

    if (!response.ok) {
      console.warn('Failed to save session:', await response.text());
      return false;
    }

    return true;
  } catch (error) {
    console.warn('Failed to save notebook session:', error);
    return false;
  }
};

// --- Agent Permission API ---

export interface AgentPermissionStatus {
  notebook_path: string;
  agent_created: boolean;
  agent_permitted: boolean;
  has_history: boolean;
  can_agent_modify: boolean;
  reason: string;
  /** File mtime after the permission write (the flag lives in the notebook file). */
  mtime?: number;
}

/**
 * Get agent permission status for a notebook
 */
export const getAgentPermissionStatus = async (
  notebookPath: string
): Promise<AgentPermissionStatus | null> => {
  try {
    const response = await fetch(
      `${API_BASE}/notebook/agent-status?path=${encodeURIComponent(notebookPath)}`
    );

    if (!response.ok) {
      console.warn('Failed to get agent status:', await response.text());
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn('Failed to get agent permission status:', error);
    return null;
  }
};

/**
 * Grant or revoke agent permission for a notebook
 */
export const setAgentPermission = async (
  notebookPath: string,
  permitted: boolean
): Promise<AgentPermissionStatus | null> => {
  try {
    const response = await fetch(`${API_BASE}/notebook/permit-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebook_path: notebookPath,
        permitted
      })
    });

    if (!response.ok) {
      console.warn('Failed to set agent permission:', await response.text());
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn('Failed to set agent permission:', error);
    return null;
  }
};

// --- Notebook Settings API ---

export type OutputLoggingMode = 'minimal' | 'full';

export interface NotebookSettings {
  notebook_path: string;
  output_logging: OutputLoggingMode;
  full_width: boolean;
  mtime?: number;
}

/**
 * Get notebook settings (output logging mode, etc.)
 */
export const getNotebookSettings = async (
  notebookPath: string
): Promise<NotebookSettings | null> => {
  try {
    const response = await fetch(
      `${API_BASE}/notebook/settings?path=${encodeURIComponent(notebookPath)}`
    );

    if (!response.ok) {
      console.warn('Failed to get notebook settings:', await response.text());
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn('Failed to get notebook settings:', error);
    return null;
  }
};

/**
 * Update notebook settings
 */
export const updateNotebookSettings = async (
  notebookPath: string,
  settings: { output_logging?: OutputLoggingMode; full_width?: boolean }
): Promise<NotebookSettings | null> => {
  try {
    const response = await fetch(`${API_BASE}/notebook/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: notebookPath,
        ...settings
      })
    });

    if (!response.ok) {
      console.warn('Failed to update notebook settings:', await response.text());
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn('Failed to update notebook settings:', error);
    return null;
  }
};

/**
 * Persist live ipywidgets state into notebook metadata.widgets
 * (application/vnd.jupyter.widget-state+json). Returns the new file mtime so
 * the caller can adopt it and avoid a false conflict on the next save.
 */
export const saveWidgetState = async (
  notebookPath: string,
  widgetState: Record<string, unknown>
): Promise<{ mtime?: number } | null> => {
  try {
    const response = await fetch(`${API_BASE}/notebook/widget-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: notebookPath, widget_state: widgetState })
    });

    if (!response.ok) {
      console.warn('Failed to persist widget state:', await response.text());
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn('Failed to persist widget state:', error);
    return null;
  }
};
