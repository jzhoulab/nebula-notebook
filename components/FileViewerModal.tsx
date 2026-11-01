import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Download, X } from 'lucide-react';
import { classifyFileView, inlineViewUrl, fileExtension } from '../lib/fileViewer';
import { detectDelimiter, parseDelimited, inferHeader, CANDIDATE_DELIMITERS } from '../lib/csvTable';
import { readFile } from '../services/fileService';
import { withBase } from '../lib/basePath';

interface FileViewerModalProps {
  path: string;
  name: string;
  token?: string | null;
  onClose: () => void;
}

/**
 * In-tab viewer for browser-native file types (PDF, video, audio). The body
 * is just a native element pointed at the inline-serve URL — the browser's
 * OWN renderer handles it (PDF runs out-of-process, not in the SPA heap), so
 * there's no bundled library and the memory is reclaimed when this unmounts
 * and the element leaves the DOM. Consistent chrome across types; the "Open in
 * new tab" button pops the same URL out to a full browser tab on demand.
 *
 * Non-native formats (npy/parquet/h5/…) would register a lazy-imported body
 * renderer here — see the file-viewer design notes — so their cost is only
 * paid when someone actually opens one.
 */
export const FileViewerModal: React.FC<FileViewerModalProps> = ({ path, name, token, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const url = inlineViewUrl(path, token);
  const ext = fileExtension(name || path);
  const isVideo = ['.mp4', '.webm', '.mov', '.m4v', '.ogv'].includes(ext);
  const isAudio = ['.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac'].includes(ext);
  const isPdf = ext === '.pdf';
  const isTabular = ['.csv', '.tsv'].includes(ext);

  // Portal to <body>: both FileBrowser variants would otherwise trap this —
  // the inline card clips via overflow-hidden, and the sidebar's transform
  // makes position:fixed resolve against the pane instead of the viewport.
  return createPortal(
    <div
      className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4 sm:p-8"
      onClick={onClose} // clicking anywhere outside the panel closes
    >
      <div
        className="w-full h-full max-w-6xl flex flex-col rounded-lg overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-900 text-slate-100 text-sm flex-shrink-0">
        <span className="font-medium truncate flex-1" title={path}>{name}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-700 text-slate-200"
          title="Open in a new browser tab"
        >
          <ExternalLink className="w-3.5 h-3.5" /> New tab
        </a>
        <a
          href={withBase(`/api/fs/download?path=${encodeURIComponent(path)}${token ? `&token=${encodeURIComponent(token)}` : ''}`)}
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-700 text-slate-200"
          title="Download"
        >
          <Download className="w-3.5 h-3.5" /> Download
        </a>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-slate-700 text-slate-300"
          title="Close (Esc)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 bg-slate-800 flex items-center justify-center">
        {isPdf ? (
          <iframe title={name} src={url} className="w-full h-full border-0 bg-white" />
        ) : isVideo ? (
          <video controls autoPlay src={url} className="max-w-full max-h-full" />
        ) : isAudio ? (
          <audio controls autoPlay src={url} className="w-2/3" />
        ) : isTabular ? (
          <TabularBody path={path} defaultDelim={ext === '.tsv' ? '\t' : undefined} />
        ) : (
          <div className="text-center text-slate-300">
            <p className="text-sm mb-3">No in-app preview for this file type.</p>
            <a href={url} target="_blank" rel="noopener noreferrer" className="underline">Try opening in a new tab</a>
          </div>
        )}
      </div>
      </div>
    </div>,
    document.body
  );
};

const MAX_TABLE_ROWS = 2000;

/** CSV/TSV table body: detect delimiter + header (both overridable), render a
 *  capped table (warn, don't refuse), with a raw-text fallback. */
const TabularBody: React.FC<{ path: string; defaultDelim?: string }> = ({ path, defaultDelim }) => {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [delim, setDelim] = useState<string | null>(defaultDelim ?? null);
  const [headerOverride, setHeaderOverride] = useState<boolean | null>(null);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    let alive = true;
    readFile(path)
      .then((r) => { if (!alive) return; if (r.type === 'text' && typeof r.content === 'string') setText(r.content); else setError('File is not text-decodable.'); })
      .catch((e: Error) => { if (alive) setError(e.message || 'Failed to read file'); });
    return () => { alive = false; };
  }, [path]);

  const effectiveDelim = delim ?? (text ? detectDelimiter(text.slice(0, 8192)) : ',');
  const rows = useMemo(() => (text ? parseDelimited(text, effectiveDelim) : []), [text, effectiveDelim]);
  const hasHeader = headerOverride ?? inferHeader(rows);
  const capped = rows.length > MAX_TABLE_ROWS;
  const bodyRows = hasHeader ? rows.slice(1) : rows;
  const shownRows = bodyRows.slice(0, MAX_TABLE_ROWS - (hasHeader ? 1 : 0));

  if (error) return <div className="text-red-300 text-sm p-4">{error}</div>;
  if (text === null) return <div className="text-slate-300 text-sm p-4">Loading…</div>;

  return (
    <div className="w-full h-full flex flex-col bg-white">
      <div className="flex items-center gap-3 px-3 py-1.5 bg-slate-100 border-b border-slate-200 text-xs text-slate-600 flex-shrink-0">
        <label className="flex items-center gap-1">delimiter
          <select value={effectiveDelim} onChange={(e) => setDelim(e.target.value)} className="border border-slate-300 rounded px-1 py-0.5">
            {CANDIDATE_DELIMITERS.map((d) => <option key={d} value={d}>{d === '\t' ? 'Tab' : d === ',' ? 'Comma' : d === ';' ? 'Semicolon' : 'Pipe'}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={hasHeader} onChange={(e) => setHeaderOverride(e.target.checked)} /> first row is header
        </label>
        <span className="text-slate-400">{rows.length.toLocaleString()} rows × {rows[0]?.length ?? 0} cols</span>
        {capped && <span className="text-amber-600">showing first {MAX_TABLE_ROWS.toLocaleString()}</span>}
        <span className="flex-1" />
        <button onClick={() => setRaw((v) => !v)} className="underline decoration-dotted hover:text-slate-800">{raw ? 'as table' : 'as raw text'}</button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {raw ? (
          <pre className="text-xs font-mono p-3 whitespace-pre">{text}</pre>
        ) : (
          <table className="text-xs border-collapse w-max">
            {hasHeader && rows[0] && (
              <thead className="sticky top-0"><tr>
                {rows[0].map((c, i) => <th key={i} className="border border-slate-200 bg-slate-50 px-2 py-1 text-left font-semibold whitespace-nowrap">{c}</th>)}
              </tr></thead>
            )}
            <tbody>
              {shownRows.map((r, ri) => (
                <tr key={ri} className="odd:bg-white even:bg-slate-50/50">
                  {r.map((c, ci) => <td key={ci} className="border border-slate-200 px-2 py-1 whitespace-nowrap max-w-[24rem] truncate" title={c}>{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

/** Types the FileViewerModal renders in-app (as opposed to images → the rich
 *  ImageModalViewer, text → the editor, html → the trust-gated page). */
export function opensInFileViewerModal(pathOrName: string): boolean {
  return classifyFileView(pathOrName) === 'newtab'
    && !['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif'].includes(fileExtension(pathOrName));
}
