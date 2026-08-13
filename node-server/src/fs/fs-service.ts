/**
 * Filesystem Service - Real filesystem operations
 *
 * Node.js port of the Python FilesystemService.
 */

import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { isDeepStrictEqual } from 'util';
import {
  FileInfo,
  FileInfoResponse,
  FileType,
  DirectoryListing,
  MtimeResponse,
  ReadFileResponse,
  NebulaCell,
  CellOutput,
  NotebookCellsResponse,
  SaveNotebookResult,
  OUTPUTS_UNCHANGED_SENTINEL,
  JupyterNotebook,
  JupyterCell,
  JupyterOutput,
  NebulaConfig,
} from './types';
import { getDefaultKernelName } from '../kernel/default-kernel';
import { getFormatAdapter, isNotebookPath, defaultKernelForPath } from './notebook-formats/registry';
import { isPercentNotebookText } from './notebook-formats/percent';
import { NotebookFormatAdapter } from './notebook-formats/types';
import { buildDisplayOutput, convertMimeBundleToJupyter } from '../output/display-data';
import { assertPathMutable, classifySealedPath } from './sealed-path';

const JUPYTER_CELL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isValidJupyterCellId(value: unknown): value is string {
  return typeof value === 'string' && JUPYTER_CELL_ID_PATTERN.test(value);
}

/**
 * Resolve stable, unique IDs for every cell in an imported notebook.
 *
 * Native nbformat IDs own the namespace before legacy metadata fallbacks are
 * considered. This prevents an earlier legacy-only or malformed cell from
 * stealing a valid native ID from a later cell. The first occurrence of a
 * duplicate native ID remains canonical; later duplicates are repaired using
 * an otherwise-unclaimed legacy ID or a deterministic position-based ID.
 */
function resolveJupyterCellIds(cells: JupyterCell[]): string[] {
  const resolved: Array<string | undefined> = new Array(cells.length);
  const nativeOwners = new Map<string, number>();

  cells.forEach((cell, index) => {
    if (isValidJupyterCellId(cell.id) && !nativeOwners.has(cell.id)) {
      nativeOwners.set(cell.id, index);
    }
  });

  const reservedNativeIds = new Set(nativeOwners.keys());
  const used = new Set<string>();
  for (const [id, index] of nativeOwners) {
    resolved[index] = id;
    used.add(id);
  }

  cells.forEach((cell, index) => {
    if (resolved[index] !== undefined) return;
    const legacyId = cell.metadata?.nebula_id;
    if (
      isValidJupyterCellId(legacyId)
      && !reservedNativeIds.has(legacyId)
      && !used.has(legacyId)
    ) {
      resolved[index] = legacyId;
      used.add(legacyId);
    }
  });

  cells.forEach((_cell, index) => {
    if (resolved[index] !== undefined) return;
    const base = `cell-${index}`;
    let candidate = base;
    let suffix = 1;
    while (reservedNativeIds.has(candidate) || used.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    resolved[index] = candidate;
    used.add(candidate);
  });

  return resolved as string[];
}

function validateJupyterCellIds(cells: NebulaCell[]): void {
  const seen = new Set<string>();
  cells.forEach((cell, index) => {
    if (!isValidJupyterCellId(cell.id)) {
      throw new Error(
        `Invalid Jupyter cell ID at index ${index}: expected 1-64 ASCII letters, digits, hyphens, or underscores`
      );
    }
    if (seen.has(cell.id)) {
      throw new Error(`Duplicate Jupyter cell ID at index ${index}: ${cell.id}`);
    }
    seen.add(cell.id);
  });
}

const NEBULA_DIR = path.join(os.homedir(), '.nebula');
const USER_CONFIG_PATH = path.join(NEBULA_DIR, 'config.json');
const PROJECT_CONFIG_PATH = path.join(__dirname, '..', '..', '..', '.nebula-config.json');
const NOTEBOOK_METADATA_FAST_PATH_BYTES = 64 * 1024;
const NOTEBOOK_METADATA_FALLBACK_PARSE_BYTES = 8 * 1024 * 1024;

function readJsonString(source: string, startIndex: number): { value: string; endIndex: number } | null {
  if (source[startIndex] !== '"') {
    return null;
  }

  let i = startIndex + 1;
  let escaped = false;
  while (i < source.length) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      i++;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      i++;
      continue;
    }
    if (ch === '"') {
      try {
        return {
          value: JSON.parse(source.slice(startIndex, i + 1)) as string,
          endIndex: i + 1,
        };
      } catch {
        return null;
      }
    }
    i++;
  }

  return null;
}

function findMatchingJsonObjectEnd(source: string, startIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function extractTopLevelObjectField(source: string, fieldName: string): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      if (depth !== 1) {
        inString = true;
        continue;
      }

      const key = readJsonString(source, i);
      if (!key) {
        return null;
      }

      let j = key.endIndex;
      while (j < source.length && /\s/.test(source[j])) {
        j++;
      }

      if (source[j] !== ':') {
        i = key.endIndex - 1;
        continue;
      }

      if (key.value !== fieldName) {
        i = key.endIndex - 1;
        continue;
      }

      j++;
      while (j < source.length && /\s/.test(source[j])) {
        j++;
      }

      if (source[j] !== '{') {
        return null;
      }

      const endIndex = findMatchingJsonObjectEnd(source, j);
      if (endIndex === -1) {
        return null;
      }

      try {
        return JSON.parse(source.slice(j, endIndex + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }

    if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
    }
  }

  return null;
}

/**
 * Load root directory from config files if they exist.
 * Priority: env -> user config -> project config.
 */
function loadNebulaConfig(): string | null {
  const envRoot = process.env.NEBULA_WORKDIR || process.env.NEBULA_ROOT;
  if (envRoot) {
    return envRoot;
  }

  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const config: NebulaConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, 'utf-8'));
      if (config.rootDirectory) {
        return config.rootDirectory;
      }
    }
  } catch {
    // Ignore user config errors
  }

  try {
    if (fs.existsSync(PROJECT_CONFIG_PATH)) {
      const config: NebulaConfig = JSON.parse(fs.readFileSync(PROJECT_CONFIG_PATH, 'utf-8'));
      if (config.rootDirectory) {
        return config.rootDirectory;
      }
    }
  } catch {
    // Ignore project config errors
  }

  return null;
}

interface CommitJournal {
  version: 1;
  txId: string;
  notebookPath: string;
  status: 'begin' | 'commit';
  startedAt: number;
  committedAt?: number;
  files: {
    notebook: string;
    history?: string;
    session?: string;
  };
}

export interface AgentPermissionSnapshot {
  agent_created: boolean;
  agent_permitted: boolean;
  has_history: boolean;
  can_agent_modify: boolean;
  reason: string;
}

export class FilesystemService {
  private writeLocks: Map<string, Promise<void>> = new Map();
  private defaultRoot: string;

  constructor(defaultRoot?: string) {
    // Priority: explicit arg > config file > home directory
    const configuredRoot = defaultRoot || loadNebulaConfig() || os.homedir();
    this.defaultRoot = this.expandRootDirectory(configuredRoot);
  }

  /**
   * Get the server root directory.
   */
  getRootDirectory(): string {
    return this.defaultRoot;
  }

  /**
   * Set the server root directory and persist it.
   */
  setRootDirectory(rootDirectory: string, options?: { persist?: boolean }): string {
    const resolved = this.expandRootDirectory(rootDirectory);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Root directory not found: ${resolved}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`Root directory is not a folder: ${resolved}`);
    }

    this.defaultRoot = resolved;
    if (options?.persist !== false) {
      this.saveRootDirectory(resolved);
    }
    return this.defaultRoot;
  }

  private expandRootDirectory(rootDirectory: string): string {
    const trimmed = rootDirectory.trim();
    if (trimmed === '' || trimmed === '~') {
      return os.homedir();
    }
    if (trimmed.startsWith('~/')) {
      return path.join(os.homedir(), trimmed.slice(2));
    }
    return path.resolve(trimmed);
  }

  private saveRootDirectory(rootDirectory: string): void {
    if (!fs.existsSync(NEBULA_DIR)) {
      fs.mkdirSync(NEBULA_DIR, { recursive: true, mode: 0o700 });
    }
    const config: NebulaConfig = { rootDirectory };
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  /**
   * Normalize and expand path
   */
  normalizePath(filePath: string): string {
    if (filePath === '~' || filePath === '') {
      return this.defaultRoot;
    }
    if (filePath.startsWith('~/')) {
      return path.join(this.defaultRoot, filePath.slice(2));
    }
    if (filePath.startsWith('~')) {
      // Handle ~user paths (rare in practice)
      return path.resolve(os.homedir(), '..', filePath.slice(1));
    }
    if (!path.isAbsolute(filePath)) {
      return path.resolve(this.defaultRoot, filePath);
    }
    return path.resolve(filePath);
  }

  /**
   * Serialize write operations per notebook to avoid interleaving writes.
   */
  private async withWriteLock<T>(notebookPath: string, fn: () => Promise<T>): Promise<T> {
    const key = this.normalizePath(notebookPath);
    const previous = this.writeLocks.get(key) || Promise.resolve();
    let release: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.then(() => current);
    this.writeLocks.set(key, next);

    await previous;
    try {
      return await fn();
    } finally {
      release!();
      if (this.writeLocks.get(key) === next) {
        this.writeLocks.delete(key);
      }
    }
  }

  /**
   * Atomically write a file (write temp, fsync, rename, fsync dir).
   * Prevents partial/corrupt files on interruption.
   */
  private atomicWriteFileSync(targetPath: string, data: string): void {
    // Keep the immutability check at the lowest shared write primitive as a
    // backstop for future notebook mutation APIs. ReplaySealService bypasses
    // FilesystemService and writes its staging/seal artifacts directly.
    assertPathMutable(targetPath, { operation: 'write' });
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpName = `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
    const tmpPath = path.join(dir, tmpName);
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, data, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmpPath, targetPath);

    // Best-effort directory fsync
    try {
      const dirFd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Ignore fsync errors on directory handles
    }
  }

  private writeJsonAtomicSync(targetPath: string, payload: unknown): void {
    this.atomicWriteFileSync(targetPath, JSON.stringify(payload, null, 2));
  }

  /**
   * Async variant of atomicWriteFileSync (write temp, fsync, rename, fsync dir).
   * Used on hot notebook-save paths so large writes never block the event loop.
   *
   * `durable: false` skips both fsyncs while keeping the tmp+rename atomicity.
   * Use it for auxiliary files (history/session/journal/lastsave): on network
   * filesystems (GPFS) each fsync can take seconds, and a save doing ~10 of
   * them was observed at 20-27s. A crash can lose the last few seconds of an
   * auxiliary file, but never corrupt it — the rename is still atomic. The
   * notebook file itself stays fully durable.
   */
  private async atomicWriteFile(targetPath: string, data: string, opts: { durable?: boolean } = {}): Promise<void> {
    assertPathMutable(targetPath, { operation: 'write' });
    const durable = opts.durable !== false;
    const dir = path.dirname(targetPath);
    await fsp.mkdir(dir, { recursive: true });

    const tmpName = `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
    const tmpPath = path.join(dir, tmpName);
    const handle = await fsp.open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(data, 'utf-8');
      if (durable) await handle.sync();
    } finally {
      await handle.close();
    }

    await fsp.rename(tmpPath, targetPath);

    if (!durable) return;

    // Best-effort directory fsync
    try {
      const dirHandle = await fsp.open(dir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // Ignore fsync errors on directory handles
    }
  }

  private async writeJsonAtomic(targetPath: string, payload: unknown, opts: { durable?: boolean } = {}): Promise<void> {
    await this.atomicWriteFile(targetPath, JSON.stringify(payload, null, 2), opts);
  }

  /**
   * Format file size for display
   */
  formatSize(size: number): string {
    if (size < 1024) {
      return `${size}B`;
    } else if (size < 1024 * 1024) {
      return `${(size / 1024).toFixed(1)}KB`;
    } else if (size < 1024 * 1024 * 1024) {
      return `${(size / (1024 * 1024)).toFixed(1)}MB`;
    } else {
      return `${(size / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    }
  }

  /**
   * Determine file type from extension
   */
  getFileType(extension: string): FileType {
    const ext = extension.toLowerCase();
    if (ext === '.ipynb' || ext === '.qmd') {
      return 'notebook';
    } else if (['.py', '.r', '.jl', '.js', '.ts', '.tsx', '.jsx', '.json', '.yaml', '.yml', '.toml', '.md', '.txt'].includes(ext)) {
      return 'code';
    } else if (['.csv', '.tsv', '.xlsx', '.xls'].includes(ext)) {
      return 'data';
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) {
      return 'image';
    } else if (ext === '.pdf') {
      return 'document';
    }
    return 'file';
  }

  /**
   * Get file info for a path
   */
  private getFileInfo(filePath: string): FileInfo {
    const stat = fs.statSync(filePath);
    const name = path.basename(filePath);
    const isDir = stat.isDirectory();

    return {
      name,
      path: filePath,
      isDirectory: isDir,
      size: isDir ? 0 : stat.size,
      modified: stat.mtimeMs / 1000, // Convert to seconds
      extension: isDir ? '' : path.extname(name),
    };
  }

  /** Async, non-blocking variant of getFileInfo (one `fsp.stat`). Used by
   *  listDirectory so a folder's entries stat in parallel off the event loop. */
  private async getFileInfoAsync(filePath: string): Promise<FileInfo> {
    const stat = await fsp.stat(filePath);
    const name = path.basename(filePath);
    const isDir = stat.isDirectory();

    return {
      name,
      path: filePath,
      isDirectory: isDir,
      size: isDir ? 0 : stat.size,
      modified: stat.mtimeMs / 1000,
      extension: isDir ? '' : path.extname(name),
    };
  }

  /**
   * Convert FileInfo to FileInfoResponse for API
   */
  private toFileInfoResponse(info: FileInfo): FileInfoResponse {
    return {
      id: info.path,
      name: info.name,
      path: info.path,
      isDirectory: info.isDirectory,
      size: this.formatSize(info.size),
      sizeBytes: info.size,
      modified: info.modified,
      extension: info.extension,
      fileType: info.isDirectory ? 'folder' : this.getFileType(info.extension),
    };
  }

  /**
   * Get directory modification time (lightweight check for changes)
   */
  getDirectoryMtime(dirPath: string): MtimeResponse {
    const normalizedPath = this.normalizePath(dirPath);

    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`Path not found: ${normalizedPath}`);
    }

    const stat = fs.statSync(normalizedPath);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${normalizedPath}`);
    }

    return {
      path: normalizedPath,
      mtime: stat.mtimeMs / 1000,
    };
  }

  /**
   * Get file modification time
   */
  async getFileMtime(filePath: string): Promise<MtimeResponse> {
    const normalizedPath = this.normalizePath(filePath);

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(normalizedPath);
    } catch {
      // Matches the sync existsSync() behavior: any stat failure reads as missing
      throw new Error(`File not found: ${normalizedPath}`);
    }

    return {
      path: normalizedPath,
      mtime: stat.mtimeMs / 1000,
    };
  }

  /**
   * List contents of a directory
   */
  async listDirectory(dirPath: string): Promise<DirectoryListing> {
    const normalizedPath = this.normalizePath(dirPath);

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(normalizedPath);
    } catch {
      throw new Error(`Path not found: ${normalizedPath}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${normalizedPath}`);
    }

    const entries = await fsp.readdir(normalizedPath);

    // Stat every visible entry in PARALLEL rather than one blocking statSync at a
    // time. On a network filesystem a serial loop stalls the single event
    // loop for N × stat-latency, delaying every other in-flight request (kernel
    // starts, terminal creation, saves) — the source of the "everything hangs
    // while a folder lists" latency.
    const settled = await Promise.all(
      entries
        .filter((name) => !name.startsWith('.')) // skip hidden files
        .map(async (name) => {
          try {
            return this.toFileInfoResponse(await this.getFileInfoAsync(path.join(normalizedPath, name)));
          } catch {
            return null; // skip entries we can't access
          }
        })
    );
    const items = settled.filter((x): x is FileInfoResponse => x !== null);

    // Sort: directories first, then by name
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    return {
      path: normalizedPath,
      parent: normalizedPath === '/' ? null : path.dirname(normalizedPath),
      mtime: stat.mtimeMs / 1000,
      items,
    };
  }

  /**
   * Read a file's contents
   */
  async readFile(filePath: string): Promise<ReadFileResponse> {
    const normalizedPath = this.normalizePath(filePath);

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(normalizedPath);
    } catch {
      // Matches the sync existsSync() behavior: any stat failure reads as missing
      throw new Error(`File not found: ${normalizedPath}`);
    }

    if (stat.isDirectory()) {
      throw new Error(`Path is a directory: ${normalizedPath}`);
    }

    const extension = path.extname(normalizedPath).toLowerCase();

    if (extension === '.ipynb') {
      const content = JSON.parse(await fsp.readFile(normalizedPath, 'utf-8'));
      return {
        path: normalizedPath,
        type: 'notebook',
        content,
      };
    }

    // Try to read as text
    try {
      const content = await fsp.readFile(normalizedPath, 'utf-8');
      return {
        path: normalizedPath,
        type: 'text',
        content,
      };
    } catch {
      // Binary file
      return {
        path: normalizedPath,
        type: 'binary',
        content: null,
        message: 'Binary file cannot be displayed',
      };
    }
  }

  /**
   * Write content to a file
   */
  writeFile(filePath: string, content: unknown, fileType: 'text' | 'notebook' = 'text'): boolean {
    const normalizedPath = this.normalizePath(filePath);
    assertPathMutable(normalizedPath, { operation: 'write' });

    // Create parent directories if needed
    const parentDir = path.dirname(normalizedPath);
    if (parentDir && !fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    if (fileType === 'notebook') {
      fs.writeFileSync(normalizedPath, JSON.stringify(content, null, 2), 'utf-8');
    } else {
      fs.writeFileSync(normalizedPath, content as string, 'utf-8');
    }

    return true;
  }

  /**
   * Create a new file or directory
   */
  createFile(filePath: string, isDirectory: boolean = false): FileInfo & { is_directory: boolean } {
    const normalizedPath = this.normalizePath(filePath);
    assertPathMutable(normalizedPath, { operation: 'create a file in' });

    if (fs.existsSync(normalizedPath)) {
      throw new Error(`Path already exists: ${normalizedPath}`);
    }

    if (isDirectory) {
      fs.mkdirSync(normalizedPath, { recursive: true });
    } else {
      // Create parent directories if needed
      const parentDir = path.dirname(normalizedPath);
      if (parentDir && !fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      const extension = path.extname(normalizedPath).toLowerCase();
      if (extension === '.ipynb') {
        // Create empty notebook
        const notebook: JupyterNotebook = {
          cells: [],
          metadata: {
            kernelspec: {
              display_name: 'Python 3',
              language: 'python',
              name: 'python3',
            },
          },
          nbformat: 4,
          nbformat_minor: 5,
        };
        this.writeJsonAtomicSync(normalizedPath, notebook);
      } else if (extension === '.qmd') {
        // Text-format notebook template (NOT .py: creating a .py must stay a
        // plain empty script — percent parsing only applies when one is
        // opened as a notebook)
        const adapter = getFormatAdapter(normalizedPath)!;
        this.atomicWriteFileSync(
          normalizedPath,
          adapter.serialize([], {
            kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
            __qmd_language: 'python',
          })
        );
      } else {
        // Create empty file
        fs.writeFileSync(normalizedPath, '', 'utf-8');
      }
    }

    const info = this.getFileInfo(normalizedPath);
    return { ...info, is_directory: info.isDirectory };
  }

  /**
   * Get the history file path for a notebook
   */
  private getHistoryPath(notebookPath: string): string {
    const { nebulaDir, nameWithoutExt } = this.getNebulaPaths(notebookPath);
    return path.join(nebulaDir, `${nameWithoutExt}.history.json`);
  }

  /**
   * Last-Nebula-save record for text-format notebooks: the canonical cell
   * state (id/type/content) as of the last save THROUGH Nebula. At history
   * load, divergence between this record and the file means the notebook was
   * edited externally (vim, git checkout, ...) — the difference is
   * reconciled into history as a synthesized external-edit operation so
   * undo/redo stays infinite across external edits.
   */
  private getLastSavePath(notebookPath: string): string {
    const { nebulaDir, nameWithoutExt } = this.getNebulaPaths(notebookPath);
    return path.join(nebulaDir, `${nameWithoutExt}.lastsave.json`);
  }

  private async writeTextNotebookLastSave(notebookPath: string, serializedText: string, adapter: NotebookFormatAdapter): Promise<void> {
    try {
      // Record the POST-round-trip identity (parse of what was written), so
      // positional ids (qmd markdown cells) never read as false divergence.
      const canonical = adapter.parse(serializedText).cells;
      await this.writeJsonAtomic(this.getLastSavePath(notebookPath), {
        cells: canonical.map((c) => ({ id: c.id, type: c.type, content: c.content })),
      }, { durable: false });
    } catch (e) {
      console.warn('[FilesystemService] Failed to write lastsave record:', e);
    }
  }

  /**
   * Get the session state file path for a notebook
   */
  private getSessionPath(notebookPath: string): string {
    const { nebulaDir, nameWithoutExt } = this.getNebulaPaths(notebookPath);
    return path.join(nebulaDir, `${nameWithoutExt}.session.json`);
  }

  /**
   * Get the journal file path for a notebook (used for crash-safe commits)
   */
  private getJournalPath(notebookPath: string): string {
    const { nebulaDir, nameWithoutExt } = this.getNebulaPaths(notebookPath);
    return path.join(nebulaDir, `${nameWithoutExt}.commit.json`);
  }

  private readJournal(notebookPath: string): CommitJournal | null {
    const journalPath = this.getJournalPath(notebookPath);
    if (!fs.existsSync(journalPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as CommitJournal;
    } catch {
      return null;
    }
  }

  private hasPendingCommit(notebookPath: string): boolean {
    const journal = this.readJournal(notebookPath);
    if (!journal) return false;
    return journal.status === 'begin';
  }

  private getNebulaPaths(notebookPath: string): { nebulaDir: string; nameWithoutExt: string } {
    const normalizedPath = this.normalizePath(notebookPath);
    const parentDir = path.dirname(normalizedPath);
    const notebookName = path.basename(normalizedPath);
    // .ipynb sidecar names are extension-stripped (unchanged, pre-existing
    // files keep working). Text-format notebooks keep their full basename so
    // foo.py and foo.ipynb in one directory never share sidecars.
    const ext = path.extname(notebookName).toLowerCase();
    const nameWithoutExt = ext === '.ipynb'
      ? path.basename(notebookName, path.extname(notebookName))
      : notebookName;
    const nebulaDir = path.join(parentDir, '.nebula');

    return { nebulaDir, nameWithoutExt };
  }

  /**
   * Delete notebook-related metadata files (history, session)
   */
  private deleteNotebookMetadata(notebookPath: string): void {
    const historyPath = this.getHistoryPath(notebookPath);
    const sessionPath = this.getSessionPath(notebookPath);
    const journalPath = this.getJournalPath(notebookPath);
    const lastSavePath = this.getLastSavePath(notebookPath);

    if (fs.existsSync(lastSavePath)) {
      fs.unlinkSync(lastSavePath);
    }

    if (fs.existsSync(historyPath)) {
      fs.unlinkSync(historyPath);
    }
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
    }
    if (fs.existsSync(journalPath)) {
      fs.unlinkSync(journalPath);
    }
  }

  /**
   * Delete a file or directory
   */
  deleteFile(filePath: string): boolean {
    const normalizedPath = this.normalizePath(filePath);
    assertPathMutable(normalizedPath, { operation: 'delete', protectDescendants: true });

    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`Path not found: ${normalizedPath}`);
    }

    // For notebooks, also delete history and session files
    const stat = fs.statSync(normalizedPath);
    if (isNotebookPath(normalizedPath) && !stat.isDirectory()) {
      this.deleteNotebookMetadata(normalizedPath);
    }

    if (stat.isDirectory()) {
      fs.rmSync(normalizedPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(normalizedPath);
    }

    return true;
  }

  /**
   * Rename notebook-related metadata files
   */
  private renameNotebookMetadata(oldPath: string, newPath: string): void {
    const oldHistory = this.getHistoryPath(oldPath);
    const oldSession = this.getSessionPath(oldPath);
    const oldJournal = this.getJournalPath(oldPath);
    const newHistory = this.getHistoryPath(newPath);
    const newSession = this.getSessionPath(newPath);

    // Create destination .nebula directory if needed
    const newNebulaDir = path.dirname(newHistory);
    if (!fs.existsSync(newNebulaDir)) {
      fs.mkdirSync(newNebulaDir, { recursive: true });
    }

    if (fs.existsSync(oldHistory)) {
      fs.renameSync(oldHistory, newHistory);
    }
    if (fs.existsSync(oldSession)) {
      fs.renameSync(oldSession, newSession);
    }
    if (fs.existsSync(oldJournal)) {
      // Journal files are ephemeral; remove any stale commit record on rename
      fs.unlinkSync(oldJournal);
    }
    const oldLastSave = this.getLastSavePath(oldPath);
    if (fs.existsSync(oldLastSave)) {
      fs.renameSync(oldLastSave, this.getLastSavePath(newPath));
    }
  }

  /**
   * Rename/move a file or directory
   */
  renameFile(oldPath: string, newPath: string): FileInfo {
    const normalizedOld = this.normalizePath(oldPath);
    const normalizedNew = this.normalizePath(newPath);
    assertPathMutable(normalizedOld, { operation: 'move', protectDescendants: true });
    assertPathMutable(normalizedNew, { operation: 'move a file into' });

    if (!fs.existsSync(normalizedOld)) {
      throw new Error(`Path not found: ${normalizedOld}`);
    }

    if (fs.existsSync(normalizedNew)) {
      throw new Error(`Destination already exists: ${normalizedNew}`);
    }

    // For notebooks, also rename history and session files
    if (isNotebookPath(normalizedOld)) {
      this.renameNotebookMetadata(normalizedOld, normalizedNew);
    }

    fs.renameSync(normalizedOld, normalizedNew);

    return this.getFileInfo(normalizedNew);
  }

  /**
   * Duplicate notebook-related metadata files
   */
  private duplicateNotebookMetadata(srcPath: string, destPath: string): void {
    const srcHistory = this.getHistoryPath(srcPath);
    const destHistory = this.getHistoryPath(destPath);
    const srcSession = this.getSessionPath(srcPath);
    const destSession = this.getSessionPath(destPath);
    const srcLastSave = this.getLastSavePath(srcPath);

    if (fs.existsSync(srcLastSave)) {
      const destNebulaDirForLastSave = path.dirname(destHistory);
      if (!fs.existsSync(destNebulaDirForLastSave)) {
        fs.mkdirSync(destNebulaDirForLastSave, { recursive: true });
      }
      fs.copyFileSync(srcLastSave, this.getLastSavePath(destPath));
    }

    // Create destination .nebula directory if needed
    const destNebulaDir = path.dirname(destHistory);
    if (!fs.existsSync(destNebulaDir)) {
      fs.mkdirSync(destNebulaDir, { recursive: true });
    }

    if (fs.existsSync(srcHistory)) {
      fs.copyFileSync(srcHistory, destHistory);
    }
    if (fs.existsSync(srcSession)) {
      fs.copyFileSync(srcSession, destSession);
    }
  }

  /**
   * Recursively copy a directory
   */
  private copyDirectoryRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectoryRecursive(srcPath, destPath);
      } else {
        if (entry.name.endsWith('.commit.json')) {
          continue;
        }
        fs.copyFileSync(srcPath, destPath);
        // For notebooks, also duplicate history and session files
        if (isNotebookPath(entry.name)) {
          this.duplicateNotebookMetadata(srcPath, destPath);
        }
      }
    }
  }

  /**
   * Duplicate a file or directory with _copy suffix
   */
  duplicateFile(filePath: string): FileInfoResponse {
    const normalizedPath = this.normalizePath(filePath);
    assertPathMutable(normalizedPath, { operation: 'duplicate', protectDescendants: true });

    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`File not found: ${normalizedPath}`);
    }

    const stat = fs.statSync(normalizedPath);
    const isDirectory = stat.isDirectory();

    const parentDir = path.dirname(normalizedPath);
    const ext = isDirectory ? '' : path.extname(normalizedPath);
    const name = path.basename(normalizedPath, ext);

    // Find a unique name
    let newName = `${name}_copy${ext}`;
    let newPath = path.join(parentDir, newName);
    let counter = 2;
    while (fs.existsSync(newPath)) {
      newName = `${name}_copy_${counter}${ext}`;
      newPath = path.join(parentDir, newName);
      counter++;
    }

    if (isDirectory) {
      // Recursively copy directory
      this.copyDirectoryRecursive(normalizedPath, newPath);
    } else {
      // Copy the file
      fs.copyFileSync(normalizedPath, newPath);

      // For notebooks, also duplicate history and session files
      if (isNotebookPath(normalizedPath)) {
        this.duplicateNotebookMetadata(normalizedPath, newPath);
      }
    }

    return this.toFileInfoResponse(this.getFileInfo(newPath));
  }

  /**
   * Upload a file to a directory
   */
  /**
   * `onConflict` says what an existing file of the same name means:
   * - 'rename' (default): keep both — store under `name_1.ext`. Right for
   *   browser drag-drop, where a gesture must never clobber. Callers MUST
   *   surface the returned path: the stored name is not the requested one.
   * - 'overwrite': replace in place (cp semantics).
   * - 'fail': refuse loudly. For API/CLI callers who named an exact
   *   destination — silently storing elsewhere while reporting success sent
   *   an agent's edits to `train_…_1.py` nobody was reading (lab report).
   */
  async uploadFile(
    destDir: string,
    tempFilePath: string,
    originalName: string,
    onConflict: 'rename' | 'overwrite' | 'fail' = 'rename'
  ): Promise<FileInfoResponse> {
    const normalizedDir = this.normalizePath(destDir);
    assertPathMutable(normalizedDir, { operation: 'upload into' });

    if (!fs.existsSync(normalizedDir)) {
      throw new Error(`Directory not found: ${normalizedDir}`);
    }

    const stat = fs.statSync(normalizedDir);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${normalizedDir}`);
    }

    // Determine final path
    let finalPath = path.join(normalizedDir, originalName);
    assertPathMutable(finalPath, { operation: 'upload' });

    if (fs.existsSync(finalPath) && onConflict !== 'overwrite') {
      if (onConflict === 'fail') {
        throw new Error(`already exists: ${finalPath}`);
      }
      // 'rename': find a unique name
      const ext = path.extname(originalName);
      const name = path.basename(originalName, ext);
      let counter = 1;
      while (fs.existsSync(finalPath)) {
        finalPath = path.join(normalizedDir, `${name}_${counter}${ext}`);
        counter++;
      }
    }

    // Move temp file to final destination
    fs.copyFileSync(tempFilePath, finalPath);
    fs.unlinkSync(tempFilePath);

    return this.toFileInfoResponse(this.getFileInfo(finalPath));
  }

  /**
   * Convert Jupyter source to string
   */
  private sourceToString(source: string | string[]): string {
    if (Array.isArray(source)) {
      return source.join('');
    }
    return source;
  }

  /**
   * Convert string to Jupyter source format (array of lines)
   */
  private stringToSource(content: string): string[] {
    if (!content) {
      return [];
    }
    const lines = content.split('\n');
    // Add \n back to all lines except the last
    return lines.map((line, i) => (i < lines.length - 1 ? line + '\n' : line));
  }

  /**
   * Convert Jupyter outputs to Nebula format
   */
  private convertOutputs(outputs: JupyterOutput[] | undefined, cellIndex: number): CellOutput[] {
    if (!outputs) return [];

    const result: CellOutput[] = [];
    const timestamp = Date.now();

    for (let i = 0; i < outputs.length; i++) {
      const output = outputs[i];

      if (output.output_type === 'stream') {
        const streamName = output.name || 'stdout';
        const text = this.sourceToString(output.text || '');
        result.push({
          id: `output-${cellIndex}-${result.length}`,
          type: streamName === 'stderr' ? 'stderr' : 'stdout',
          content: text,
          timestamp,
        });
      } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
        const normalizedOutput = buildDisplayOutput(output.data || {}, output.metadata);
        if (normalizedOutput) {
          result.push({
            id: `output-${cellIndex}-${result.length}`,
            type: normalizedOutput.type,
            content: normalizedOutput.content,
            timestamp,
            mimeBundle: normalizedOutput.mimeBundle,
            metadata: normalizedOutput.metadata,
            preferredMimeType: normalizedOutput.preferredMimeType,
          });
        }
      } else if (output.output_type === 'error') {
        const traceback = output.traceback || [];
        result.push({
          id: `output-${cellIndex}-${result.length}`,
          type: 'error',
          content: traceback.join(''),
          timestamp,
        });
      }
    }

    return result;
  }

  /**
   * Convert Nebula outputs back to Jupyter format
   */
  private convertOutputsToJupyter(outputs: CellOutput[]): JupyterOutput[] {
    const result: JupyterOutput[] = [];

    for (const output of outputs) {
      if (output.type !== 'stdout' && output.type !== 'stderr' && output.type !== 'error' && output.mimeBundle) {
        result.push({
          output_type: 'display_data',
          data: convertMimeBundleToJupyter(output.mimeBundle),
          metadata: output.metadata || {},
        });
        continue;
      }

      if (output.type === 'stdout' || output.type === 'stderr') {
        // Coalesce consecutive same-name streams into one entry (matches Jupyter behavior).
        // This prevents tqdm progress bars from creating hundreds of output entries.
        const prev = result[result.length - 1];
        if (prev && prev.output_type === 'stream' && prev.name === output.type) {
          // Append text to existing stream entry
          const prevText = Array.isArray(prev.text) ? prev.text.join('') : (prev.text as string);
          prev.text = this.stringToSource(prevText + output.content);
        } else {
          result.push({
            output_type: 'stream',
            name: output.type,
            text: this.stringToSource(output.content),
          });
        }
      } else if (output.type === 'image') {
        result.push({
          output_type: 'display_data',
          data: { 'image/png': output.content },
          metadata: output.metadata || {},
        });
      } else if (output.type === 'html') {
        result.push({
          output_type: 'display_data',
          data: { 'text/html': output.content },
          metadata: output.metadata || {},
        });
      } else if (output.type === 'display_data') {
        result.push({
          output_type: 'display_data',
          data: { 'text/plain': output.content },
          metadata: output.metadata || {},
        });
      } else if (output.type === 'error') {
        result.push({
          output_type: 'error',
          ename: 'Error',
          evalue: '',
          traceback: this.stringToSource(output.content),
        });
      }
    }

    return result;
  }

  /**
   * Read a notebook and convert to internal cell format (async; hot path for
   * notebook load — large .ipynb reads must not block the event loop)
   */
  async getNotebookCells(notebookPath: string): Promise<NotebookCellsResponse> {
    const normalizedPath = this.normalizePath(notebookPath);

    let raw: string;
    let stat: fs.Stats;
    try {
      [raw, stat] = await Promise.all([
        fsp.readFile(normalizedPath, 'utf-8'),
        fsp.stat(normalizedPath),
      ]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error(`Notebook not found: ${normalizedPath}`);
      }
      throw err;
    }

    return this.buildNotebookCellsResponse(normalizedPath, raw, stat.mtimeMs);
  }

  /**
   * Sync variant of getNotebookCells. Kept for cold callers that need a
   * synchronous read (headless cache warm-up, initial-history bootstrap).
   */
  getNotebookCellsSync(notebookPath: string): NotebookCellsResponse {
    const normalizedPath = this.normalizePath(notebookPath);

    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`Notebook not found: ${normalizedPath}`);
    }

    const raw = fs.readFileSync(normalizedPath, 'utf-8');
    const stat = fs.statSync(normalizedPath);
    return this.buildNotebookCellsResponse(normalizedPath, raw, stat.mtimeMs);
  }

  /**
   * Convert raw notebook file content to the internal cell format (CPU only).
   */
  private buildNotebookCellsResponse(normalizedPath: string, raw: string, mtimeMs: number): NotebookCellsResponse {
    // Text notebook formats (.py percent / .qmd): adapter path. The .ipynb
    // body below is untouched.
    const formatAdapter = getFormatAdapter(normalizedPath);
    if (formatAdapter) {
      const parsed = formatAdapter.parse(raw);
      return {
        cells: parsed.cells,
        metadata: parsed.metadata,
        kernelspec: parsed.kernelspecName || defaultKernelForPath(normalizedPath),
        kernelspecSource: parsed.kernelspecName ? 'metadata' : 'default',
        mtime: mtimeMs / 1000,
      };
    }

    const notebook: JupyterNotebook = JSON.parse(raw);

    const metadataKernel = notebook.metadata?.kernelspec?.name;
    const kernelspec = metadataKernel || 'python3';
    const cellIds = resolveJupyterCellIds(notebook.cells || []);

    const cells: NebulaCell[] = notebook.cells.map((nbCell, i) => {
      let cellType: 'code' | 'markdown' = nbCell.cell_type === 'markdown' ? 'markdown' : 'code';

      const content = this.sourceToString(nbCell.source);
      const cellId = cellIds[i];
      const outputs = this.convertOutputs(nbCell.outputs, i);

      const cell: NebulaCell = {
        id: cellId,
        type: cellType,
        content,
        outputs,
        isExecuting: false,
        executionCount: nbCell.execution_count ?? null,
      };

      // Preserve scrolled state if set
      if (nbCell.metadata?.scrolled !== undefined) {
        cell.scrolled = nbCell.metadata.scrolled;
      }
      if (nbCell.metadata?.scrolled_height !== undefined) {
        cell.scrolledHeight = nbCell.metadata.scrolled_height;
      }

      // Preserve unknown metadata
      const unknownMetadata: Record<string, unknown> = {};
      for (const key of Object.keys(nbCell.metadata || {})) {
        if (!['nebula_id', 'scrolled', 'scrolled_height'].includes(key)) {
          unknownMetadata[key] = nbCell.metadata[key];
        }
      }
      if (Object.keys(unknownMetadata).length > 0) {
        cell._metadata = unknownMetadata;
      }

      return cell;
    });

    return {
      cells,
      metadata: notebook.metadata || {},
      kernelspec,
      kernelspecSource: metadataKernel ? 'metadata' : 'default',
      mtime: mtimeMs / 1000,
    };
  }

  /**
   * Read a notebook and convert to internal cell format, resolving default kernel if needed
   */
  async getNotebookCellsWithKernel(notebookPath: string): Promise<NotebookCellsResponse> {
    const result = await this.getNotebookCells(notebookPath);
    if (result.kernelspecSource === 'metadata') {
      return result;
    }

    try {
      const defaultKernel = await getDefaultKernelName();
      if (defaultKernel) {
        return {
          ...result,
          kernelspec: defaultKernel,
          kernelspecSource: 'env-default',
        };
      }
    } catch (err) {
      console.warn('[FilesystemService] Failed to resolve default kernel:', err);
    }

    return result;
  }

  /**
   * Save cells to a notebook file
   */
  async saveNotebookCells(
    notebookPath: string,
    cells: NebulaCell[],
    kernelName?: string,
    notebookMetadata?: Record<string, unknown>
  ): Promise<SaveNotebookResult> {
    const normalizedPath = this.normalizePath(notebookPath);
    assertPathMutable(normalizedPath, { operation: 'save' });

    const formatAdapter = getFormatAdapter(normalizedPath);
    if (formatAdapter) {
      return await this.saveTextNotebookCells(formatAdapter, normalizedPath, cells, kernelName, notebookMetadata);
    }

    validateJupyterCellIds(cells);

    // Load existing notebook metadata if file exists.
    // Prefer a fast scan for the top-level metadata object so we avoid
    // parsing the full notebook on every save. Fall back to full JSON
    // parsing only for smaller notebooks when the fast path cannot find it.
    let existingMetadata: JupyterNotebook['metadata'] = {};
    try {
      const stat = await fsp.stat(normalizedPath);
      const handle = await fsp.open(normalizedPath, 'r');
      let head: string;
      try {
        const buf = Buffer.alloc(NOTEBOOK_METADATA_FAST_PATH_BYTES);
        const { bytesRead } = await handle.read(buf, 0, NOTEBOOK_METADATA_FAST_PATH_BYTES, 0);
        head = buf.toString('utf-8', 0, bytesRead);
      } finally {
        await handle.close();
      }

      const extractedMetadata = extractTopLevelObjectField(head, 'metadata');
      if (extractedMetadata) {
        existingMetadata = extractedMetadata;
      } else if (stat.size <= NOTEBOOK_METADATA_FALLBACK_PARSE_BYTES) {
        const notebook = JSON.parse(await fsp.readFile(normalizedPath, 'utf-8')) as JupyterNotebook;
        existingMetadata = notebook.metadata || {};
      }
    } catch {
      // Start fresh — file missing or metadata extraction failed
    }

    kernelName = kernelName || 'python3';
    const displayName = kernelName === 'python3' ? 'Python 3' : kernelName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    // Resolve outputs-unchanged sentinels from the file on disk: the client
    // elides unchanged outputs (often MBs of base64 images) from autosaves so
    // slow uplinks aren't saturated. If anything can't be resolved, ask the
    // client to retry with a full payload rather than guessing.
    const sentinelCells = cells.filter((c) => (c.outputs as unknown) === OUTPUTS_UNCHANGED_SENTINEL);
    const priorOutputs = new Map<string, { outputs: JupyterOutput[]; execution_count: number | null }>();
    if (sentinelCells.length > 0) {
      try {
        const existing = JSON.parse(await fsp.readFile(normalizedPath, 'utf-8')) as JupyterNotebook;
        const existingCells = existing.cells || [];
        const existingCellIds = resolveJupyterCellIds(existingCells);
        existingCells.forEach((jc, index) => {
          priorOutputs.set(existingCellIds[index], {
            outputs: jc.outputs || [],
            execution_count: jc.execution_count ?? null,
          });
        });
      } catch {
        return { success: false, mtime: 0, needsFull: true };
      }
      for (const c of sentinelCells) {
        if (!priorOutputs.has(c.id)) return { success: false, mtime: 0, needsFull: true };
      }
    }

    const nbCells: JupyterCell[] = cells.map((cell) => {
      const preservedMetadata = { ...(cell._metadata || {}) };
      delete preservedMetadata.nebula_id;
      const cellMetadata: JupyterCell['metadata'] = {
        ...preservedMetadata,
      };

      if (cell.scrolled !== undefined) {
        cellMetadata.scrolled = cell.scrolled;
      }
      if (cell.scrolledHeight !== undefined) {
        cellMetadata.scrolled_height = cell.scrolledHeight;
      }

      const nbCell: JupyterCell = {
        id: cell.id,
        cell_type: cell.type,
        source: this.stringToSource(cell.content),
        metadata: cellMetadata,
      };

      if (cell.type === 'code') {
        if ((cell.outputs as unknown) === OUTPUTS_UNCHANGED_SENTINEL) {
          const prior = priorOutputs.get(cell.id)!;
          nbCell.outputs = prior.outputs;
          nbCell.execution_count = cell.executionCount ?? prior.execution_count;
        } else {
          nbCell.outputs = this.convertOutputsToJupyter(cell.outputs);
          nbCell.execution_count = cell.executionCount;
        }
      }

      return nbCell;
    });

    // Build final metadata
    const finalMetadata: JupyterNotebook['metadata'] = {
      ...existingMetadata,
      kernelspec: {
        display_name: displayName,
        language: 'python',
        name: kernelName,
      },
      language_info: {
        name: 'python',
        version: '3.11',
      },
    };

    // Merge custom notebook metadata
    if (notebookMetadata) {
      for (const [key, value] of Object.entries(notebookMetadata)) {
        if (typeof value === 'object' && value !== null && typeof finalMetadata[key] === 'object' && finalMetadata[key] !== null) {
          // Deep merge for dict values
          finalMetadata[key] = { ...(finalMetadata[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
        } else {
          finalMetadata[key] = value;
        }
      }
    }

    const notebook: JupyterNotebook = {
      metadata: finalMetadata,
      nbformat: 4,
      nbformat_minor: 5,
      cells: nbCells,
    };

    // Create parent directory if needed
    const parentDir = path.dirname(normalizedPath);
    await fsp.mkdir(parentDir, { recursive: true });

    await this.writeJsonAtomic(normalizedPath, notebook);

    const stat = await fsp.stat(normalizedPath);
    return {
      success: true,
      mtime: stat.mtimeMs / 1000,
    };
  }

  /**
   * Save notebook cells and history in a single crash-safe commit.
   * Uses a small journal + atomic writes to avoid partial files.
   */
  async saveNotebookBundle(
    notebookPath: string,
    cells: NebulaCell[],
    kernelName?: string,
    history?: unknown[],
    session?: Record<string, unknown>,
    notebookMetadata?: Record<string, unknown>
  ): Promise<SaveNotebookResult> {
    assertPathMutable(this.normalizePath(notebookPath), { operation: 'save' });
    return await this.withWriteLock(notebookPath, async () => {
      const normalizedPath = this.normalizePath(notebookPath);
      const historyPath = history ? this.getHistoryPath(notebookPath) : undefined;
      const sessionPath = session ? this.getSessionPath(notebookPath) : undefined;
      const journalPath = this.getJournalPath(notebookPath);
      const txId = crypto.randomUUID();

      const journal: CommitJournal = {
        version: 1,
        txId,
        notebookPath: normalizedPath,
        status: 'begin',
        startedAt: Date.now(),
        files: {
          notebook: normalizedPath,
          ...(historyPath ? { history: historyPath } : {}),
          ...(sessionPath ? { session: sessionPath } : {}),
        },
      };

      // Ensure .nebula directory exists for journal/history/session
      const { nebulaDir } = this.getNebulaPaths(notebookPath);
      await fsp.mkdir(nebulaDir, { recursive: true });

      // Auxiliary files: atomic but non-durable (no fsync) — see atomicWriteFile.
      // Only the notebook itself (inside saveNotebookCells) pays for fsync.
      await this.writeJsonAtomic(journalPath, journal, { durable: false });

      if (historyPath) {
        await this.writeJsonAtomic(historyPath, history || [], { durable: false });
      }

      if (sessionPath) {
        await this.writeJsonAtomic(sessionPath, session || {}, { durable: false });
      }

      const result = await this.saveNotebookCells(notebookPath, cells, kernelName, notebookMetadata);

      const committedJournal: CommitJournal = {
        ...journal,
        status: 'commit',
        committedAt: Date.now(),
      };

      await this.writeJsonAtomic(journalPath, committedJournal, { durable: false });

      try {
        await fsp.unlink(journalPath);
      } catch {
        // Ignore cleanup errors; journal can be inspected if needed
      }

      return result;
    });
  }

  /**
   * Save cells to a text-format notebook (.py percent / .qmd).
   * Outputs and execution counts are never serialized — by format design.
   */
  private async saveTextNotebookCells(
    adapter: NotebookFormatAdapter,
    normalizedPath: string,
    cells: NebulaCell[],
    kernelName?: string,
    notebookMetadata?: Record<string, unknown>
  ): Promise<SaveNotebookResult> {
    // Text formats never serialize outputs; neutralize any outputs-unchanged
    // sentinels so nothing downstream sees the marker string.
    cells = cells.map((c) =>
      (c.outputs as unknown) === OUTPUTS_UNCHANGED_SENTINEL ? { ...c, outputs: [] } : c
    );
    let existingMetadata: Record<string, unknown> = {};
    try {
      existingMetadata = adapter.parse(await fsp.readFile(normalizedPath, 'utf-8')).metadata;
    } catch {
      // Start fresh — file missing or metadata extraction failed
    }

    const finalMetadata: Record<string, unknown> = { ...existingMetadata };
    if (notebookMetadata) {
      for (const [key, value] of Object.entries(notebookMetadata)) {
        if (typeof value === 'object' && value !== null && typeof finalMetadata[key] === 'object' && finalMetadata[key] !== null) {
          finalMetadata[key] = { ...(finalMetadata[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
        } else {
          finalMetadata[key] = value;
        }
      }
    }

    const text = adapter.serialize(cells, finalMetadata, kernelName);
    await this.atomicWriteFile(normalizedPath, text);
    await this.writeTextNotebookLastSave(normalizedPath, text, adapter);
    const stat = await fsp.stat(normalizedPath);
    return { success: true, mtime: stat.mtimeMs / 1000 };
  }

  /**
   * Get notebook-level metadata
   */
  getNotebookMetadata(notebookPath: string): Record<string, unknown> {
    const normalizedPath = this.normalizePath(notebookPath);

    if (!fs.existsSync(normalizedPath)) {
      return {};
    }

    const formatAdapter = getFormatAdapter(normalizedPath);
    if (formatAdapter) {
      try {
        return formatAdapter.parse(fs.readFileSync(normalizedPath, 'utf-8')).metadata;
      } catch {
        return {};
      }
    }

    try {
      const notebook: JupyterNotebook = JSON.parse(fs.readFileSync(normalizedPath, 'utf-8'));
      return notebook.metadata || {};
    } catch {
      return {};
    }
  }

  /**
   * Async variant of getNotebookMetadata. Nebula-written notebooks put
   * `metadata` first, so the head-bytes scan avoids reading and parsing the
   * whole file; externally written notebooks fall back to a full async read.
   */
  async getNotebookMetadataAsync(notebookPath: string): Promise<Record<string, unknown>> {
    const normalizedPath = this.normalizePath(notebookPath);

    const formatAdapter = getFormatAdapter(normalizedPath);
    try {
      if (formatAdapter) {
        return formatAdapter.parse(await fsp.readFile(normalizedPath, 'utf-8')).metadata;
      }

      const handle = await fsp.open(normalizedPath, 'r');
      let head: string;
      try {
        const buf = Buffer.alloc(NOTEBOOK_METADATA_FAST_PATH_BYTES);
        const { bytesRead } = await handle.read(buf, 0, NOTEBOOK_METADATA_FAST_PATH_BYTES, 0);
        head = buf.toString('utf-8', 0, bytesRead);
      } finally {
        await handle.close();
      }

      const extracted = extractTopLevelObjectField(head, 'metadata');
      if (extracted) {
        return extracted;
      }

      const notebook: JupyterNotebook = JSON.parse(await fsp.readFile(normalizedPath, 'utf-8'));
      return notebook.metadata || {};
    } catch {
      return {};
    }
  }

  /**
   * Update notebook-level metadata without modifying cells
   */
  async updateNotebookMetadata(
    notebookPath: string,
    metadataUpdates: Record<string, unknown>
  ): Promise<{ success: boolean; changed?: boolean; mtime?: number; error?: string }> {
    assertPathMutable(this.normalizePath(notebookPath), { operation: 'update metadata for' });
    return await this.withWriteLock(notebookPath, async () => {
      const normalizedPath = this.normalizePath(notebookPath);

      try {
        await fsp.access(normalizedPath);
      } catch {
        return { success: false, error: `Notebook not found: ${normalizedPath}` };
      }

      const formatAdapter = getFormatAdapter(normalizedPath);
      if (formatAdapter) {
        try {
          const rawText = await fsp.readFile(normalizedPath, 'utf-8');
          // A plain .py script (no markers, no header) must not be
          // Nebula-fied by metadata side effects — kernel attach and
          // settings writes are skipped until a content save makes the
          // file a notebook on purpose.
          if (formatAdapter.name === 'percent' && !isPercentNotebookText(rawText)) {
            const stat = await fsp.stat(normalizedPath);
            return { success: true, changed: false, mtime: stat.mtimeMs / 1000 };
          }
          const parsed = formatAdapter.parse(rawText);
          const existingMetadata = parsed.metadata;
          const nextMetadata: Record<string, unknown> = { ...existingMetadata };
          for (const [key, value] of Object.entries(metadataUpdates)) {
            if (typeof value === 'object' && value !== null && typeof nextMetadata[key] === 'object' && nextMetadata[key] !== null) {
              nextMetadata[key] = {
                ...(nextMetadata[key] as Record<string, unknown>),
                ...(value as Record<string, unknown>),
              };
            } else {
              nextMetadata[key] = value;
            }
          }
          if (isDeepStrictEqual(existingMetadata, nextMetadata)) {
            const stat = await fsp.stat(normalizedPath);
            return { success: true, changed: false, mtime: stat.mtimeMs / 1000 };
          }
          await this.atomicWriteFile(normalizedPath, formatAdapter.serialize(parsed.cells, nextMetadata));
          const stat = await fsp.stat(normalizedPath);
          return { success: true, changed: true, mtime: stat.mtimeMs / 1000 };
        } catch (e) {
          return { success: false, error: `Failed to update notebook: ${e}` };
        }
      }

      try {
        const notebook: JupyterNotebook = JSON.parse(await fsp.readFile(normalizedPath, 'utf-8'));

        const existingMetadata = notebook.metadata || {};
        const nextMetadata: Record<string, unknown> = { ...existingMetadata };
        for (const [key, value] of Object.entries(metadataUpdates)) {
          if (typeof value === 'object' && value !== null && typeof nextMetadata[key] === 'object' && nextMetadata[key] !== null) {
            nextMetadata[key] = {
              ...(nextMetadata[key] as Record<string, unknown>),
              ...(value as Record<string, unknown>),
            };
          } else {
            nextMetadata[key] = value;
          }
        }

        if (isDeepStrictEqual(existingMetadata, nextMetadata)) {
          const stat = await fsp.stat(normalizedPath);
          return {
            success: true,
            changed: false,
            mtime: stat.mtimeMs / 1000,
          };
        }

        notebook.metadata = nextMetadata;
        await this.writeJsonAtomic(normalizedPath, notebook);
        const stat = await fsp.stat(normalizedPath);

        return {
          success: true,
          changed: true,
          mtime: stat.mtimeMs / 1000,
        };
      } catch (e) {
        return { success: false, error: `Failed to update notebook: ${e}` };
      }
    });
  }

  private stripOutputsForHistorySnapshot(cell: NebulaCell): NebulaCell {
    const snapshot: NebulaCell = {
      ...cell,
      outputs: [],
      isExecuting: false,
      pendingOutputReset: undefined,
    };
    return snapshot;
  }

  private buildInitialHistory(notebookPath: string): unknown[] {
    const { cells } = this.getNotebookCellsSync(notebookPath);
    return [{
      type: 'snapshot',
      cells: cells.map(cell => this.stripOutputsForHistorySnapshot(cell)),
      timestamp: Date.now(),
    }];
  }

  /**
   * Set agent permission and ensure newly-permitted notebooks are immediately editable.
   */
  async setAgentPermission(
    notebookPath: string,
    permitted: boolean
  ): Promise<{ success: boolean; error?: string; status?: AgentPermissionSnapshot; mtime?: number }> {
    assertPathMutable(this.normalizePath(notebookPath), { operation: 'change permissions for' });
    return await this.withWriteLock(notebookPath, async () => {
      const normalizedPath = this.normalizePath(notebookPath);

      if (!fs.existsSync(normalizedPath)) {
        return { success: false, error: `Notebook not found: ${normalizedPath}` };
      }

      const formatAdapter = getFormatAdapter(normalizedPath);
      if (formatAdapter) {
        try {
          const parsed = formatAdapter.parse(fs.readFileSync(normalizedPath, 'utf-8'));
          const nebula = ((parsed.metadata.nebula as Record<string, unknown> | undefined) || {});
          const nextMetadata = {
            ...parsed.metadata,
            nebula: { ...nebula, agent_permitted: permitted },
          };
          this.atomicWriteFileSync(normalizedPath, formatAdapter.serialize(parsed.cells, nextMetadata));

          if (permitted && !this.hasHistory(notebookPath)) {
            const historyPath = this.getHistoryPath(notebookPath);
            const nebulaDir = path.dirname(historyPath);
            if (!fs.existsSync(nebulaDir)) {
              fs.mkdirSync(nebulaDir, { recursive: true });
            }
            this.writeJsonAtomicSync(historyPath, this.buildInitialHistory(notebookPath));
          }

          return {
            success: true,
            status: this.getAgentPermissionStatus(notebookPath),
            mtime: fs.statSync(normalizedPath).mtimeMs / 1000,
          };
        } catch (e) {
          return { success: false, error: `Failed to set agent permission: ${e}` };
        }
      }

      try {
        const notebook: JupyterNotebook = JSON.parse(fs.readFileSync(normalizedPath, 'utf-8'));
        const metadata = notebook.metadata || {};
        const nebula = ((metadata.nebula as Record<string, unknown> | undefined) || {});

        notebook.metadata = {
          ...metadata,
          nebula: {
            ...nebula,
            agent_permitted: permitted,
          },
        };
        this.writeJsonAtomicSync(normalizedPath, notebook);

        if (permitted && !this.hasHistory(notebookPath)) {
          const historyPath = this.getHistoryPath(notebookPath);
          const nebulaDir = path.dirname(historyPath);
          if (!fs.existsSync(nebulaDir)) {
            fs.mkdirSync(nebulaDir, { recursive: true });
          }
          this.writeJsonAtomicSync(historyPath, this.buildInitialHistory(notebookPath));
        }

        return {
          success: true,
          status: this.getAgentPermissionStatus(notebookPath),
          // The permission flag was just written INTO the notebook file; the
          // caller must adopt this mtime or its next autosave will mistake
          // our own write for an external change ("changed on server").
          mtime: fs.statSync(normalizedPath).mtimeMs / 1000,
        };
      } catch (e) {
        return { success: false, error: `Failed to set agent permission: ${e}` };
      }
    });
  }

  /**
   * Derive agent permission status from persisted notebook metadata.
   */
  getAgentPermissionStatus(notebookPath: string): AgentPermissionSnapshot {
    const metadata = this.getNotebookMetadata(notebookPath);
    const hasHistory = this.hasHistory(notebookPath);
    return this.deriveAgentPermission(metadata, hasHistory);
  }

  /**
   * Async variant of getAgentPermissionStatus for hot request paths (it runs
   * on every agent write operation). Reads metadata via the head-bytes fast
   * path and checks history without parsing it, so the per-operation gate
   * never blocks the event loop on a slow network filesystem.
   */
  async getAgentPermissionStatusAsync(notebookPath: string): Promise<AgentPermissionSnapshot> {
    const [metadata, hasHistory] = await Promise.all([
      this.getNotebookMetadataAsync(notebookPath),
      this.hasHistoryAsync(notebookPath),
    ]);
    return this.deriveAgentPermission(metadata, hasHistory);
  }

  private deriveAgentPermission(metadata: Record<string, unknown>, hasHistory: boolean): AgentPermissionSnapshot {
    const nebula = (metadata.nebula || {}) as Record<string, unknown>;

    const agentCreated = Boolean(nebula.agent_created);
    const agentPermitted = Boolean(nebula.agent_permitted);
    // Tri-state: an explicit user revoke (agent_permitted === false) always wins,
    // even for agent-created notebooks. Agent-created notebooks are permitted by
    // default (unless revoked); other notebooks need an explicit user grant.
    const revoked = nebula.agent_permitted === false;
    const permitted = agentCreated ? !revoked : agentPermitted;
    // Agent-created notebooks carry history from creation, so they skip the
    // separate has-history gate that user-permitted notebooks require.
    const canModify = permitted && (agentCreated || hasHistory);

    return {
      agent_created: agentCreated,
      agent_permitted: agentPermitted,
      has_history: hasHistory,
      can_agent_modify: canModify,
      reason: !permitted
        ? (agentCreated ? 'Agent access revoked' : 'Not permitted for agent modifications')
        : canModify
          ? (agentCreated ? 'Agent created this notebook' : 'User permitted and history enabled')
          : 'User permitted but history not enabled',
    };
  }

  /**
   * Check if a notebook is permitted for agent modifications
   */
  isAgentPermitted(notebookPath: string): boolean {
    // Agent-created notebooks are permitted unless explicitly revoked; others
    // require an explicit grant. A user revoke wins in both cases.
    const metadata = this.getNotebookMetadata(notebookPath);
    const nebula = (metadata.nebula || {}) as Record<string, unknown>;
    const agentCreated = Boolean(nebula.agent_created);
    const revoked = nebula.agent_permitted === false;
    return agentCreated ? !revoked : Boolean(nebula.agent_permitted);
  }

  /**
   * Check if a notebook has history tracking enabled
   */
  hasHistory(notebookPath: string): boolean {
    const historyPath = this.getHistoryPath(notebookPath);
    if (!fs.existsSync(historyPath)) {
      return false;
    }
    try {
      const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      return Array.isArray(history) && history.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Async variant of hasHistory that only parses small files: history journals
   * grow to hundreds of KB, and this check runs on every agent operation — a
   * file that large necessarily has entries, so its size alone answers.
   */
  async hasHistoryAsync(notebookPath: string): Promise<boolean> {
    const historyPath = this.getHistoryPath(notebookPath);
    try {
      const stat = await fsp.stat(historyPath);
      if (stat.size > 4096) return true;
      const history = JSON.parse(await fsp.readFile(historyPath, 'utf-8'));
      return Array.isArray(history) && history.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Save operation history for a notebook
   */
  async saveHistory(notebookPath: string, history: unknown[]): Promise<boolean> {
    assertPathMutable(this.normalizePath(notebookPath), { operation: 'write history for' });
    const historyPath = this.getHistoryPath(notebookPath);

    // Create .nebula directory if needed
    const nebulaDir = path.dirname(historyPath);
    await fsp.mkdir(nebulaDir, { recursive: true });

    await this.withWriteLock(notebookPath, async () => {
      await this.writeJsonAtomic(historyPath, history);
    });
    return true;
  }

  /**
   * Load operation history for a notebook (async; history files can be many MB)
   */
  async loadHistory(notebookPath: string): Promise<unknown[]> {
    const historyPath = this.getHistoryPath(notebookPath);

    if (this.hasPendingCommit(notebookPath)) {
      console.warn(`[FilesystemService] Pending commit detected for ${notebookPath}; skipping history load.`);
      return [];
    }

    let history: unknown[];
    try {
      history = JSON.parse(await fsp.readFile(historyPath, 'utf-8'));
    } catch {
      // Missing or unreadable/corrupt history file
      return [];
    }

    // Text-format notebooks can be edited outside Nebula (that is their
    // point); reconcile any divergence into history so undo/redo stays
    // infinite across external edits. No-op for .ipynb.
    return this.reconcileExternalTextEdits(notebookPath, history);
  }

  /**
   * Sync variant of loadHistory. Kept for cold callers that need a
   * synchronous read (headless undo/redo state bootstrap).
   */
  loadHistorySync(notebookPath: string): unknown[] {
    const historyPath = this.getHistoryPath(notebookPath);

    if (this.hasPendingCommit(notebookPath)) {
      console.warn(`[FilesystemService] Pending commit detected for ${notebookPath}; skipping history load.`);
      return [];
    }

    if (!fs.existsSync(historyPath)) {
      return [];
    }

    let history: unknown[];
    try {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    } catch {
      return [];
    }

    return this.reconcileExternalTextEdits(notebookPath, history);
  }

  /**
   * Compare the file's current cells against the last-Nebula-save record.
   * On divergence, append ONE synthesized batch operation describing the
   * external edit (updateContent / insertCell / deleteCell, source
   * 'external') — both undo systems replay these, so a single undo step
   * reverts the external edit and redo reapplies it. Falls back to a plain
   * snapshot entry if synthesis fails (undo then bottoms out there instead
   * of corrupting).
   */
  private reconcileExternalTextEdits(notebookPath: string, history: unknown[]): unknown[] {
    // Reconciliation is normally a helpful read-time repair, but it persists
    // history/last-save sidecars. A sealed snapshot must stay byte-for-byte
    // immutable even when reached through an otherwise read-only API.
    if (classifySealedPath(this.normalizePath(notebookPath)).sealed) return history;
    const adapter = getFormatAdapter(notebookPath);
    if (!adapter || history.length === 0) return history;
    const normalizedPath = this.normalizePath(notebookPath);
    const lastSavePath = this.getLastSavePath(notebookPath);
    if (!fs.existsSync(normalizedPath) || !fs.existsSync(lastSavePath)) return history;

    let currentCells: NebulaCell[];
    try {
      currentCells = adapter.parse(fs.readFileSync(normalizedPath, 'utf-8')).cells;
    } catch {
      return history;
    }

    try {
      const record = JSON.parse(fs.readFileSync(lastSavePath, 'utf-8')) as {
        cells: Array<{ id: string; type: 'code' | 'markdown'; content: string }>;
      };
      const before = record.cells ?? [];
      const unchanged =
        before.length === currentCells.length &&
        before.every(
          (b, i) =>
            currentCells[i].id === b.id &&
            currentCells[i].type === b.type &&
            currentCells[i].content === b.content
        );
      if (unchanged) return history;

      const operations = this.synthesizeExternalEditOps(before, currentCells);
      if (operations.length === 0) return history;
      const mtime = fs.statSync(normalizedPath).mtimeMs;
      const entry = {
        type: 'batch',
        operations,
        source: 'external',
        operationId: `external-${crypto.randomBytes(6).toString('hex')}`,
        timestamp: mtime,
        external: true,
      };
      const next = [...history, entry];
      this.writeJsonAtomicSync(this.getHistoryPath(notebookPath), next);
      this.writeJsonAtomicSync(lastSavePath, {
        cells: currentCells.map((c) => ({ id: c.id, type: c.type, content: c.content })),
      });
      console.log(`[FilesystemService] Reconciled external edit into history for ${notebookPath} (${operations.length} ops)`);
      return next;
    } catch (e) {
      console.warn('[FilesystemService] External-edit reconciliation failed; appending snapshot:', e);
      try {
        const snapshot = {
          type: 'snapshot',
          cells: currentCells.map((c) => this.stripOutputsForHistorySnapshot(c)),
          timestamp: fs.statSync(normalizedPath).mtimeMs,
          source: 'external',
        };
        const next = [...history, snapshot];
        this.writeJsonAtomicSync(this.getHistoryPath(notebookPath), next);
        this.writeJsonAtomicSync(lastSavePath, {
          cells: currentCells.map((c) => ({ id: c.id, type: c.type, content: c.content })),
        });
        return next;
      } catch {
        return history;
      }
    }
  }

  private synthesizeExternalEditOps(
    before: Array<{ id: string; type: 'code' | 'markdown'; content: string }>,
    after: NebulaCell[]
  ): Array<Record<string, unknown>> {
    const toCell = (c: { id: string; type: 'code' | 'markdown'; content: string }): NebulaCell => ({
      id: c.id,
      type: c.type,
      content: c.content,
      outputs: [],
      executionCount: null,
      isExecuting: false,
    });
    const afterById = new Map(after.map((c, i) => [c.id, i] as const));
    const beforeById = new Map(before.map((c, i) => [c.id, i] as const));
    const ops: Array<Record<string, unknown>> = [];

    // Deletions (and type changes) — descending index so replay indices hold
    for (let i = before.length - 1; i >= 0; i--) {
      const b = before[i];
      const aIdx = afterById.get(b.id);
      const a = aIdx !== undefined ? after[aIdx] : null;
      if (!a || a.type !== b.type) {
        ops.push({ type: 'deleteCell', index: i, cell: toCell(b), source: 'external' });
      }
    }
    // Insertions (and the insert half of type changes) — ascending index
    for (let i = 0; i < after.length; i++) {
      const a = after[i];
      const bIdx = beforeById.get(a.id);
      const b = bIdx !== undefined ? before[bIdx] : null;
      if (!b || b.type !== a.type) {
        ops.push({
          type: 'insertCell',
          index: i,
          cell: { ...a, outputs: [], executionCount: null, isExecuting: false },
          source: 'external',
        });
      } else if (b.content !== a.content) {
        ops.push({
          type: 'updateContent',
          cellId: a.id,
          oldContent: b.content,
          newContent: a.content,
          source: 'external',
        });
      }
    }
    return ops;
  }

  /**
   * Save session state for a notebook
   */
  async saveSession(notebookPath: string, session: Record<string, unknown>): Promise<boolean> {
    assertPathMutable(this.normalizePath(notebookPath), { operation: 'write session state for' });
    const sessionPath = this.getSessionPath(notebookPath);

    // Create .nebula directory if needed
    const nebulaDir = path.dirname(sessionPath);
    await fsp.mkdir(nebulaDir, { recursive: true });

    await this.withWriteLock(notebookPath, async () => {
      await this.writeJsonAtomic(sessionPath, session);
    });
    return true;
  }

  /**
   * Load session state for a notebook
   */
  loadSession(notebookPath: string): Record<string, unknown> {
    const sessionPath = this.getSessionPath(notebookPath);

    if (this.hasPendingCommit(notebookPath)) {
      console.warn(`[FilesystemService] Pending commit detected for ${notebookPath}; skipping session load.`);
      return {};
    }

    if (!fs.existsSync(sessionPath)) {
      return {};
    }

    try {
      return JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    } catch {
      return {};
    }
  }
}

// Global instance with default configuration
export const fsService = new FilesystemService();
