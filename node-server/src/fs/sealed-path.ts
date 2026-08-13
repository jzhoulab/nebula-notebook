import * as fs from 'fs';
import * as path from 'path';

export interface SealedPathInfo {
  sealed: true;
  sealId: string;
  sealedRoot: string;
  canonicalPath: string;
}

export type PathSealClassification = SealedPathInfo | { sealed: false };

/**
 * A public Nebula API attempted to mutate immutable replay evidence.
 * ReplaySealService intentionally writes with node:fs and does not cross this
 * public mutation boundary.
 */
export class SealedPathLockedError extends Error {
  readonly name = 'SealedPathLockedError';
  readonly code = 'sealed_read_only';
  readonly statusCode = 403;
  readonly sealId: string;
  readonly lockedPath: string;

  constructor(info: SealedPathInfo, operation = 'modify') {
    super(`Cannot ${operation} sealed evidence ${info.sealId}: ${info.canonicalPath}`);
    this.sealId = info.sealId;
    this.lockedPath = info.canonicalPath;
  }
}

function classifyAbsolutePath(absolutePath: string): PathSealClassification {
  const normalized = path.resolve(absolutePath);
  const root = path.parse(normalized).root;
  const components = normalized.slice(root.length).split(path.sep).filter(Boolean);

  for (let index = 0; index <= components.length - 3; index += 1) {
    if (components[index] !== '.nebula' || components[index + 1] !== 'seals') continue;
    const sealId = components[index + 2];
    if (!sealId) continue;
    return {
      sealed: true,
      sealId,
      sealedRoot: path.join(root, ...components.slice(0, index + 3)),
      canonicalPath: normalized,
    };
  }

  // Replay metadata outside the immutable snapshot directory is equally part
  // of the scientific record. Public FS/notebook routes must not rewrite the
  // hash chain, its content-addressed blobs, or durable replay job registry.
  for (let index = 0; index < components.length; index += 1) {
    if (components[index] !== '.nebula') continue;
    const remainder = components.slice(index + 1);
    const isLedger = remainder.length === 1
      && remainder[0].endsWith('.provenance.jsonl');
    const isBlob = remainder.length >= 3
      && remainder[0] === 'provenance'
      && remainder[1] === 'blobs';
    const isReplayRegistry = remainder.length >= 2
      && remainder[0] === 'replay-seal-jobs';
    if (!isLedger && !isBlob && !isReplayRegistry) continue;
    const evidenceId = isLedger
      ? remainder[0]
      : isReplayRegistry
        ? 'replay-seal-jobs'
        : 'provenance-blobs';
    return {
      sealed: true,
      sealId: evidenceId,
      sealedRoot: path.join(root, ...components.slice(0, index + 2)),
      canonicalPath: normalized,
    };
  }
  return { sealed: false };
}

/** Resolve symlinks even when the final destination does not exist yet. */
function realpathThroughNearestExistingAncestor(absolutePath: string): string {
  let cursor = path.resolve(absolutePath);
  const suffix: string[] = [];

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return path.resolve(absolutePath);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }

  try {
    return path.resolve(fs.realpathSync.native(cursor), ...suffix);
  } catch {
    return path.resolve(absolutePath);
  }
}

/**
 * Derive sealed state from the filesystem path, never from caller-supplied UI
 * mode. Both the lexical path and its resolved target are checked: a symlink
 * cannot smuggle a write into a seal, while a symlink inside a seal cannot
 * make its lexical entry mutable.
 */
export function classifySealedPath(filePath: string): PathSealClassification {
  const lexical = classifyAbsolutePath(path.resolve(filePath));
  if (lexical.sealed) return lexical;
  return classifyAbsolutePath(realpathThroughNearestExistingAncestor(filePath));
}

function sealRootInDirectory(directory: string): SealedPathInfo | null {
  const candidateRoots = path.basename(directory) === '.nebula'
    ? [path.join(directory, 'seals')]
    : [path.join(directory, '.nebula', 'seals')];

  const nebulaDirectory = path.basename(directory) === '.nebula'
    ? directory
    : path.join(directory, '.nebula');
  try {
    const metadataEntries = fs.readdirSync(nebulaDirectory, { withFileTypes: true });
    const protectedEntry = metadataEntries.find((item) =>
      item.name.endsWith('.provenance.jsonl')
      || item.name === 'provenance'
      || item.name === 'replay-seal-jobs');
    if (protectedEntry) {
      const info = classifySealedPath(path.join(nebulaDirectory, protectedEntry.name));
      if (info.sealed) return info;
    }
  } catch {
    // No server-owned provenance metadata below this directory.
  }

  for (const sealsDir of candidateRoots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sealsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const entry = entries.find(item => item.name !== '.' && item.name !== '..');
    if (!entry) continue;
    const info = classifySealedPath(path.join(sealsDir, entry.name));
    if (info.sealed) return info;
  }
  return null;
}

/** Find a seal that a recursive delete/rename of `directory` would destroy. */
export function findSealedDescendant(directory: string): SealedPathInfo | null {
  const normalized = path.resolve(directory);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(normalized);
  } catch {
    return null;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;

  const stack = [normalized];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const direct = sealRootInDirectory(current);
    if (direct) return direct;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === '.nebula') continue; // Checked directly above.
      stack.push(path.join(current, entry.name));
    }
  }
  return null;
}

export function assertPathMutable(
  filePath: string,
  options: { operation?: string; protectDescendants?: boolean } = {},
): void {
  const info = classifySealedPath(filePath);
  if (info.sealed) throw new SealedPathLockedError(info, options.operation);

  if (options.protectDescendants) {
    const descendant = findSealedDescendant(filePath);
    if (descendant) throw new SealedPathLockedError(descendant, options.operation);
  }
}

export function sealedErrorBody(error: SealedPathLockedError) {
  return {
    code: error.code,
    detail: error.message,
    seal_id: error.sealId,
    path: error.lockedPath,
  };
}
