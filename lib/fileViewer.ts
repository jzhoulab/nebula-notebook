import { withBase } from './basePath';

/**
 * Single source of truth for "how should this file open" — replaces the
 * type checks that were duplicated across FileBrowser and FileListItem.
 *
 * Policy (see the file-viewer design discussion):
 *  - notebook  → open in the notebook view
 *  - text      → inline editor (source, plaintext, CSV/TSV) — small, cheap,
 *                stays in context; huge files WARN, never refuse
 *  - html      → dedicated page behind a trust gate + sandboxed iframe
 *                (HTML JS can otherwise read the Nebula auth token)
 *  - newtab    → hand to the browser's own viewer in a NEW TAB — the
 *                memory-correct home for anything a bundled viewer would
 *                make expensive (PDF, media, images): a separate document
 *                lifecycle, reclaimed on close, no leak into the SPA heap
 *  - download  → unknown/binary; let the user save it
 */

export type FileView = 'notebook' | 'text' | 'html' | 'newtab' | 'download';

const NOTEBOOK_EXTS = new Set(['.ipynb', '.qmd']);

const TEXT_EXTS = new Set([
  '.py', '.r', '.jl', '.json', '.txt', '.md', '.markdown', '.yaml', '.yml',
  '.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.csv', '.tsv', '.log',
  '.toml', '.ini', '.cfg', '.sh', '.bash', '.zsh', '.sql', '.xml', '.rmd',
  '.c', '.h', '.cpp', '.hpp', '.java', '.go', '.rs', '.rb', '.pl', '.lua',
]);

const HTML_EXTS = new Set(['.html', '.htm']);

/**
 * Types the browser renders natively and safely in a tab. HTML is
 * deliberately EXCLUDED — served same-origin, its JS could exfiltrate the
 * auth token; it goes through the trust-gated html view instead.
 */
export const INLINE_VIEWABLE_EXTS = new Set([
  '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif',
  '.mp4', '.webm', '.mov', '.m4v', '.ogv',
  '.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac',
]);

export function fileExtension(pathOrName: string): string {
  const base = pathOrName.split('/').pop() || pathOrName;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export function classifyFileView(pathOrName: string): FileView {
  const ext = fileExtension(pathOrName);
  if (NOTEBOOK_EXTS.has(ext)) return 'notebook';
  if (HTML_EXTS.has(ext)) return 'html';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (INLINE_VIEWABLE_EXTS.has(ext)) return 'newtab';
  return 'download';
}

export function isEditableTextFile(pathOrName: string): boolean {
  return classifyFileView(pathOrName) === 'text';
}

/** URL that serves a file for INLINE viewing in a new tab (browser-native). */
export function inlineViewUrl(path: string, token?: string | null): string {
  const params = new URLSearchParams({ path, inline: '1' });
  if (token) params.set('token', token);
  return withBase(`/api/fs/download?${params.toString()}`);
}
