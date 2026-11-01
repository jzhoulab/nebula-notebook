import React, { useMemo, useEffect, useState } from 'react';
import { decodeHtmlParam, wrapHtmlDocument } from '../utils/htmlPreview';
import { readFile } from '../services/fileService';
import { withBase } from '../lib/basePath';

interface HtmlPreviewProps {
  encodedHtml?: string;
  filePath?: string;
}

export const HtmlPreview: React.FC<HtmlPreviewProps> = ({ encodedHtml, filePath }) => {
  const [htmlFromFile, setHtmlFromFile] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [fileError, setFileError] = useState<string | null>(null);
  // Trust gate: HTML from a file on disk (as opposed to notebook cell output
  // we generated) is untrusted — require an explicit click before rendering.
  const [trusted, setTrusted] = useState<boolean>(!filePath);

  const { html: htmlFromParam, error: paramError } = useMemo(() => {
    if (!encodedHtml) {
      return { html: '', error: null as string | null };
    }
    try {
      const decoded = decodeHtmlParam(encodedHtml);
      return { html: decoded, error: null as string | null };
    } catch (err) {
      return { html: '', error: err instanceof Error ? err.message : 'Failed to decode HTML' };
    }
  }, [encodedHtml]);

  useEffect(() => {
    if (!filePath || !trusted) return;
    let mounted = true;
    setIsLoading(true);
    setFileError(null);
    readFile(filePath)
      .then((result) => {
        if (!mounted) return;
        if (result.type !== 'text' || typeof result.content !== 'string') {
          setFileError('HTML file could not be read as text.');
          return;
        }
        setHtmlFromFile(result.content);
      })
      .catch((err: Error) => {
        if (!mounted) return;
        setFileError(err.message || 'Failed to load HTML file');
      })
      .finally(() => {
        if (mounted) setIsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [filePath]);

  useEffect(() => {
    document.title = filePath
      ? `${filePath.split('/').pop()} — Nebula`
      : 'HTML Output - Nebula Notebook';
  }, [filePath]);

  const html = filePath ? htmlFromFile : htmlFromParam;
  const error = filePath ? fileError : paramError;

  if (!trusted && filePath) {
    const name = filePath.split('/').pop() || filePath;
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-6">
        <div className="max-w-lg rounded-lg border border-amber-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold mb-2 flex items-center gap-2">
            <span className="text-amber-500">⚠</span> Open HTML file?
          </h1>
          <p className="text-sm text-slate-600 mb-1">
            <span className="font-mono">{name}</span> can run scripts. Only open HTML you trust —
            a malicious page could act on your behalf in Nebula.
          </p>
          <p className="text-xs text-slate-400 mb-4">
            It will render in a sandbox with no access to your Nebula session, but scripts still run.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setTrusted(true)}
              className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
            >
              Open in sandbox
            </button>
            <a
              href={withBase(`/api/fs/download?path=${encodeURIComponent(filePath)}`)}
              className="px-3 py-1.5 rounded-md bg-slate-100 text-slate-700 text-sm font-medium hover:bg-slate-200"
            >
              Download instead
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-6">
        <div className="text-sm text-slate-500">Loading HTML…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-6">
        <div className="max-w-lg rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold mb-2">Unable to open HTML output</h1>
          <p className="text-sm text-slate-600">{error}</p>
        </div>
      </div>
    );
  }

  const srcDoc = wrapHtmlDocument(html);

  return (
    <div className="min-h-screen bg-white">
      <iframe
        title="HTML Output"
        className="w-full h-screen border-0"
        srcDoc={srcDoc}
        // allow-scripts WITHOUT allow-same-origin: the document runs in a null
        // origin, so its JS can render/interact but cannot read this page's
        // localStorage (the Nebula auth token) or call the API as the user.
        // For file-sourced HTML only — our own cell-output HTML is trusted.
        sandbox={filePath ? 'allow-scripts allow-popups allow-forms allow-downloads' : undefined}
      />
    </div>
  );
};
