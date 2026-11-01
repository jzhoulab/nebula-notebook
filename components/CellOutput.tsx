import React, { memo, useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { CellOutput as ICellOutput } from '../types';
import { ChevronDown, ChevronRight, GripHorizontal, WrapText, ArrowRightLeft, ExternalLink } from 'lucide-react';
import { encodeHtmlParam, wrapHtmlDocument, MAX_HTML_PARAM_LENGTH } from '../utils/htmlPreview';
import AnsiToHtml from 'ansi-to-html';
import { ImageModalViewer } from './ImageModalViewer';
import { DisplayDataOutput, HtmlOutputRenderer } from './DisplayDataOutput';
import { KernelHintBar } from './KernelHintBar';
import { detectKernelHint } from '../utils/kernelHints';
import {
  MAX_OUTPUT_LINES,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_LINES_ERROR,
  MAX_OUTPUT_CHARS_ERROR,
  OUTPUT_MIN_HEIGHT_PX,
  OUTPUT_DEFAULT_HEIGHT_PX,
} from '../config';
import { withBase } from '../lib/basePath';

// Outputs render on LIGHT backgrounds (white / red-50), but ansi-to-html's
// default palette targets dark terminals — white (SGR 37) maps to #FFF and is
// invisible. R's cli/rlang error formatting uses white/bright-white heavily.
// Remap the light palette entries to readable dark equivalents; other colors
// keep their (already dark enough) defaults.
const ansiConverter = new AnsiToHtml({
  escapeXML: true,
  colors: {
    7: '#334155',   // white → slate-700 (matches default output text)
    10: '#15803d',  // bright green → green-700
    11: '#b45309',  // bright yellow → amber-700
    13: '#a21caf',  // bright magenta → fuchsia-700
    14: '#0e7490',  // bright cyan → cyan-700
    15: '#1e293b',  // bright white → slate-800
  },
});

// Strip autoplay from audio/video elements in HTML output.
// Prevents all media from playing simultaneously when loading a notebook
// or when React re-mounts elements during virtualized scrolling.
function stripAutoplay(html: string): string {
  // Fast path: skip regex when there's no autoplay to strip (~200ms savings on scroll)
  if (!html.includes('autoplay')) return html;
  return html.replace(/(<(?:audio|video)\b[^>]*?)\s+autoplay(?:=["'][^"']*["'])?/gi, '$1');
}

// Display limits to prevent UI freeze from huge outputs
// Note: Full data is preserved in state for saving - only display is truncated
// Separate limits for regular output and error output (tracebacks need more context)
const MAX_DISPLAY_LINES = MAX_OUTPUT_LINES;
const MAX_DISPLAY_CHARS = MAX_OUTPUT_CHARS;
const MAX_DISPLAY_LINES_ERROR = MAX_OUTPUT_LINES_ERROR;
const MAX_DISPLAY_CHARS_ERROR = MAX_OUTPUT_CHARS_ERROR;

interface Props {
  outputs: ICellOutput[];
  isUpdating?: boolean;
  executionMs?: number; // Execution time in milliseconds
  scrolled?: boolean; // Jupyter standard: true = collapsed with max-height, false/undefined = expanded
  onScrolledChange?: (scrolled: boolean) => void; // Called when user toggles collapse/expand
  scrolledHeight?: number; // Persisted height of output area in scroll mode
  onScrolledHeightChange?: (height: number) => void; // Called when user resizes the output area
  kernelSessionId?: string; // Live kernel session for interactive widget outputs (ipywidgets)
}

function areOutputsEqual(prevOutputs: ICellOutput[], nextOutputs: ICellOutput[]): boolean {
  if (prevOutputs === nextOutputs) {
    return true;
  }

  if (prevOutputs.length !== nextOutputs.length) {
    return false;
  }

  for (let i = 0; i < prevOutputs.length; i += 1) {
    const prev = prevOutputs[i];
    const next = nextOutputs[i];

    if (
      prev === next
    ) {
      continue;
    }

    if (
      prev.id !== next.id ||
      prev.type !== next.type ||
      prev.content !== next.content ||
      prev.timestamp !== next.timestamp
    ) {
      return false;
    }
  }

  return true;
}

// Format execution time compactly
const formatExecutionTime = (ms: number): string => {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
};

// Collapse multiple consecutive blank lines into one
const compactOutput = (text: string): string => {
  return text.replace(/\n{3,}/g, '\n\n').trim();
};

// Process carriage returns (\r) to simulate terminal line overwriting.
// tqdm and similar libraries use \r to overwrite the current line with progress updates.
function processCarriageReturns(text: string): string {
  return text.split('\n').map(line => {
    if (!line.includes('\r')) return line;
    const parts = line.split('\r');
    let result = '';
    for (const part of parts) {
      if (part === '') continue;
      if (part.length >= result.length) {
        result = part;
      } else {
        // Partial overwrite: new text replaces start of old text
        result = part + result.slice(part.length);
      }
    }
    return result;
  }).join('\n');
}

// Merge adjacent same-type text outputs so \r processing works across chunk boundaries.
// tqdm sends many small stderr chunks; merging them lets processCarriageReturns see the full picture.
function coalesceOutputs(outputs: ICellOutput[]): ICellOutput[] {
  const result: ICellOutput[] = [];
  for (const output of outputs) {
    const prev = result[result.length - 1];
    if (prev && prev.type === output.type &&
        (output.type === 'stdout' || output.type === 'stderr')) {
      result[result.length - 1] = { ...prev, content: prev.content + output.content };
    } else {
      result.push(output);
    }
  }
  return result;
}

// Convert text with ANSI codes to sanitized HTML.
// processCarriageReturns collapses \r overwrites first, then ansi-to-html converts color codes to spans.
function renderAnsiText(text: string): string {
  const processed = processCarriageReturns(text);
  return ansiConverter.toHtml(processed);
}

function estimateDisplayOutputHeight(outputs: ICellOutput[]): number {
  let total = 0;
  for (const output of outputs) {
    if (output.type === 'image') {
      total += 300;
      continue;
    }
    if (output.type === 'html') {
      total += 240;
      continue;
    }
    if (output.type === 'display_data') {
      total += 320;
      continue;
    }
    const lineCount = (output.content?.match(/\n/g) || []).length + 1;
    total += lineCount * 20;
  }
  return total;
}

// Convert a base64 data URI to a blob URL. Returns the blob URL and a revoke function.
// Blob URLs allow the browser to release decoded media buffers when revoked,
// preventing unbounded memory growth as cells scroll in/out of the virtual list.
function useDataUriBlobUrl(dataUri: string | null): string | null {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!dataUri) { setBlobUrl(null); return; }
    // Parse "data:<mime>;base64,<data>"
    const match = dataUri.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) { setBlobUrl(dataUri); return; } // fallback: use data URI directly
    try {
      const byteChars = atob(match[2]);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: match[1] });
      const url = URL.createObjectURL(blob);
      setBlobUrl(url);
      return () => URL.revokeObjectURL(url);
    } catch {
      setBlobUrl(dataUri); // fallback on decode error
    }
  }, [dataUri]);
  return blobUrl;
}

// Replace data: URIs inside HTML content with blob URLs.
// Returns the processed HTML and a cleanup function to revoke all blob URLs.
function useHtmlBlobUrls(html: string | null): string | null {
  const [processed, setProcessed] = useState<string | null>(null);
  const blobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    // Revoke previous blob URLs
    for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
    blobUrlsRef.current = [];

    if (!html) { setProcessed(null); return; }

    // Only process if there are data URIs worth converting (>100KB)
    if (!html.includes('data:audio/') && !html.includes('data:image/')) {
      setProcessed(html);
      return;
    }

    try {
      const newUrls: string[] = [];
      const result = html.replace(
        /data:(audio\/wav|image\/png);base64,([A-Za-z0-9+/=\s]{100,})/g,
        (_, mime, b64data) => {
          try {
            const clean = b64data.replace(/\s/g, '');
            const byteChars = atob(clean);
            const bytes = new Uint8Array(byteChars.length);
            for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
            const blob = new Blob([bytes], { type: mime });
            const url = URL.createObjectURL(blob);
            newUrls.push(url);
            return url;
          } catch {
            return `data:${mime};base64,${b64data}`;
          }
        }
      );
      blobUrlsRef.current = newUrls;
      setProcessed(result);
    } catch {
      setProcessed(html);
    }

    return () => {
      for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
      blobUrlsRef.current = [];
    };
  }, [html]);

  return processed;
}

// Image output using blob URL — browser releases decoded bitmap when cell unmounts
const ImageOutput: React.FC<{ content: string; onOpenImage: (src: string) => void }> = memo(({ content, onOpenImage }) => {
  const blobUrl = useDataUriBlobUrl(`data:image/png;base64,${content}`);
  if (!blobUrl) return null;
  return (
    <div className="my-4 flex justify-start">
      <button type="button" onClick={() => onOpenImage(blobUrl)} className="text-left" title="Open image viewer">
        <img src={blobUrl} alt="Plot Output" className="max-w-full h-auto bg-white rounded shadow-sm border border-slate-200" />
      </button>
    </div>
  );
});

// HTML output with data URIs replaced by blob URLs
const HtmlOutput: React.FC<{ content: string; renderedHtml: string; openHtmlInNewTab: (html: string) => void; isolated?: boolean }> = memo(({ content, renderedHtml, openHtmlInNewTab, isolated = false }) => {
  const processedHtml = useHtmlBlobUrls(renderedHtml);
  if (processedHtml === null) return null;
  return (
    <div className="my-2">
      <div className="flex justify-end mb-1">
        <button
          onClick={() => openHtmlInNewTab(content)}
          className="inline-flex items-center gap-1 text-[0.625rem] text-slate-500 hover:text-slate-700 hover:bg-slate-100 px-2 py-1 rounded transition-colors"
          title="Open HTML output in new tab"
        >
          <ExternalLink className="w-3 h-3" />
          <span>Open in new tab</span>
        </button>
      </div>
      <HtmlOutputRenderer html={processedHtml} isolated={isolated} />
    </div>
  );
});

const OutputItem: React.FC<{ output: ICellOutput; wrapText: boolean; onOpenImage: (src: string) => void; allowAutoplay?: boolean; kernelSessionId?: string }> = memo(({ output, wrapText, onOpenImage, allowAutoplay, kernelSessionId }) => {
  const textClass = wrapText ? 'whitespace-pre-wrap break-words' : 'whitespace-pre overflow-x-auto';
  const openHtmlInNewTab = useCallback((html: string) => {
      const encoded = encodeHtmlParam(html);
      if (encoded.length <= MAX_HTML_PARAM_LENGTH) {
        const url = `${window.location.origin}${withBase(`/?htmlContent=${encoded}`)}`;
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }
    const fullHtml = wrapHtmlDocument(html);
    const blob = new Blob([fullHtml], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  }, []);

  // ⚠️ PERFORMANCE: Memoize expensive text transformations.
  // Without this, stripAutoplay (257ms) and renderAnsiText (78ms) re-run on every
  // CellOutput render even though the content hasn't changed.
  const renderedHtml = useMemo(() => {
    switch (output.type) {
      case 'stdout':
        return renderAnsiText(output.content);
      case 'stderr':
        return renderAnsiText(compactOutput(output.content));
      case 'html':
        // Autoplay is stripped on the backend at parse time to avoid
        // duplicating huge base64 audio strings on the frontend.
        return output.content;
      default:
        return '';
    }
  }, [output.type, output.content, allowAutoplay]);

  const renderPlainText = useCallback((text: string) => (
    <div className={`font-mono text-sm text-slate-700 mb-1 ${textClass}`}>
      {text}
    </div>
  ), [textClass]);

  const renderHtmlOutput = useCallback((html: string, isolated = false) => (
    <HtmlOutput
      content={html}
      renderedHtml={html}
      openHtmlInNewTab={openHtmlInNewTab}
      isolated={isolated}
    />
  ), [openHtmlInNewTab]);

  const renderImageOutput = useCallback((base64: string) => (
    <ImageOutput content={base64} onOpenImage={onOpenImage} />
  ), [onOpenImage]);

  switch (output.type) {
    case 'stdout':
      return <div className={`font-mono text-sm text-slate-700 mb-1 ${textClass}`} dangerouslySetInnerHTML={{ __html: renderedHtml }} />;
    case 'stderr':
      return <div className={`font-mono text-sm text-red-600 bg-red-50 p-2 rounded mb-1 ${textClass}`} dangerouslySetInnerHTML={{ __html: renderedHtml }} />;
    case 'error':
      return (
        <div className={`font-mono text-sm text-red-700 bg-red-100 border-l-4 border-red-500 p-2 mb-2 rounded-r ${textClass}`}>
          {compactOutput(output.content)}
        </div>
      );
    case 'image':
      return <ImageOutput content={output.content} onOpenImage={onOpenImage} />;
    case 'html':
      return (
        <HtmlOutput
          content={output.content}
          renderedHtml={renderedHtml}
          openHtmlInNewTab={openHtmlInNewTab}
          isolated={Boolean(
            output.metadata?.['text/html'] &&
            typeof output.metadata['text/html'] === 'object' &&
            !Array.isArray(output.metadata['text/html']) &&
            (output.metadata['text/html'] as Record<string, unknown>).isolated === true
          )}
        />
      );
    case 'display_data':
      return (
        <DisplayDataOutput
          output={output}
          fallbackHtmlRenderer={renderHtmlOutput}
          fallbackImageRenderer={renderImageOutput}
          fallbackTextRenderer={renderPlainText}
          kernelSessionId={kernelSessionId}
        />
      );
    default:
      return null;
  }
});

const MIN_HEIGHT = OUTPUT_MIN_HEIGHT_PX;
const DEFAULT_COLLAPSED_HEIGHT = OUTPUT_DEFAULT_HEIGHT_PX;

const CellOutputComponent: React.FC<Props> = ({ outputs, isUpdating = false, executionMs, scrolled, onScrolledChange, scrolledHeight, onScrolledHeightChange, kernelSessionId }) => {
  // scrolled prop controls collapse state (Jupyter standard: true = collapsed with scrollbar)
  // Use prop if provided, otherwise default to false (expanded)
  const isCollapsed = scrolled === true;
  // Use persisted height if available, otherwise use default
  const [collapsedHeight, setCollapsedHeight] = useState(scrolledHeight ?? DEFAULT_COLLAPSED_HEIGHT);
  const [isResizing, setIsResizing] = useState(false);
  // wrapText is local state for horizontal scroll vs text wrap (not persisted)
  const [wrapText, setWrapText] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeImageSrc, setActiveImageSrc] = useState<string | null>(null);
  // Track mount time: outputs created after mount are from fresh execution and may autoplay
  const mountTimeRef = useRef(Date.now());

  // Track if this is the initial render to avoid resetting collapse state
  const initialRenderRef = useRef(true);

  // Store resize cleanup function for unmount
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  // Cleanup resize listeners on unmount
  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
    };
  }, []);

  // Sync local collapsed height with prop when it changes (e.g., from undo/redo)
  useEffect(() => {
    if (scrolledHeight !== undefined) {
      setCollapsedHeight(scrolledHeight);
    }
  }, [scrolledHeight]);

  // Truncate outputs for display only - full data preserved in parent state for saving
  // Separate limits for regular output (stdout/stderr) and error output (tracebacks)
  const displayOutputs = useMemo(() => {
    // Quick check - count lines and chars separately for regular and error outputs
    let regularLines = 0;
    let regularChars = 0;
    let errorLines = 0;
    let errorChars = 0;

    for (const output of outputs) {
      const lines = output.type === 'image' || output.type === 'html'
        || output.type === 'display_data'
        ? 0
        : (output.content?.match(/\n/g) || []).length + 1;
      const chars = output.content?.length || 0;

      if (output.type === 'error') {
        errorLines += lines;
        errorChars += chars;
      } else {
        regularLines += lines;
        regularChars += chars;
      }
    }

    // No truncation needed if under limits
    const regularOk = regularLines <= MAX_DISPLAY_LINES && regularChars <= MAX_DISPLAY_CHARS;
    const errorOk = errorLines <= MAX_DISPLAY_LINES_ERROR && errorChars <= MAX_DISPLAY_CHARS_ERROR;
    if (regularOk && errorOk) {
      return outputs;
    }

    // Need to truncate - track lines/chars shown separately
    const truncated: ICellOutput[] = [];
    let regularLinesShown = 0;
    let regularCharsShown = 0;
    let errorLinesShown = 0;
    let errorCharsShown = 0;
    let truncationNeeded = false;

    for (const output of outputs) {
      const outputSize = output.content?.length || 0;
      const outputLines = output.type === 'image' || output.type === 'html'
        ? 0
        : (output.content?.match(/\n/g) || []).length + 1;

      // Determine limits based on output type
      const isError = output.type === 'error';
      const maxLines = isError ? MAX_DISPLAY_LINES_ERROR : MAX_DISPLAY_LINES;
      const maxChars = isError ? MAX_DISPLAY_CHARS_ERROR : MAX_DISPLAY_CHARS;
      const currentLines = isError ? errorLinesShown : regularLinesShown;
      const currentChars = isError ? errorCharsShown : regularCharsShown;

      // Check if adding this would exceed limits for its category
      if (currentLines + outputLines > maxLines || currentChars + outputSize > maxChars) {
        // For text outputs, show partial content up to the limit
        if (output.type === 'stdout' || output.type === 'stderr' || output.type === 'error') {
          const remainingLines = maxLines - currentLines;
          if (remainingLines > 0 && output.content) {
            // Split into lines and take what we can fit
            const lines = output.content.split('\n');
            const truncatedLines = lines.slice(0, remainingLines);
            truncated.push({
              ...output,
              id: `${output.id}-truncated`,
              content: truncatedLines.join('\n')
            });
            if (isError) {
              errorLinesShown += truncatedLines.length;
            } else {
              regularLinesShown += truncatedLines.length;
            }
          }
        }
        // For images/html, include if size is ok
        else if (output.type === 'image' || output.type === 'html') {
          if (currentChars + outputSize <= maxChars) {
            truncated.push(output);
            regularCharsShown += outputSize;
          }
        }
        truncationNeeded = true;
        continue; // Skip to next output instead of breaking
      }

      truncated.push(output);
      if (isError) {
        errorLinesShown += outputLines;
        errorCharsShown += outputSize;
      } else {
        regularLinesShown += outputLines;
        regularCharsShown += outputSize;
      }
    }

    // Add truncation warning if needed
    if (truncationNeeded) {
      const totalLines = regularLinesShown + errorLinesShown;
      truncated.push({
        id: `display-truncated-${Date.now()}`,
        type: 'stderr',
        content: `\n⚠️ Output limit reached (${totalLines.toLocaleString()} lines). Additional output not displayed.`,
        timestamp: Date.now(),
      });
    }

    return truncated;
  }, [outputs]);

  // Coalesce adjacent same-type text outputs so \r processing works across chunk boundaries.
  // This is done after truncation so limits are applied to raw output count, not coalesced count.
  const coalescedOutputs = useMemo(() => coalesceOutputs(displayOutputs), [displayOutputs]);

  // Recognizable, actionable kernel errors (e.g. headless-R plotting) → an
  // inline hint with a one-click, session-scoped fix. See utils/kernelHints.ts.
  const kernelHint = useMemo(() => detectKernelHint(coalescedOutputs), [coalescedOutputs]);

  // Check if output is tall enough to warrant collapse option.
  // Seed this from an estimate so tall outputs don't render once as "short"
  // and then expand controls in a second pass (which can cause scroll jumps).
  const [showCollapseOption, setShowCollapseOption] = useState(() =>
    estimateDisplayOutputHeight(outputs) > DEFAULT_COLLAPSED_HEIGHT
  );

  // Use useLayoutEffect to measure before paint, avoiding flicker
  useLayoutEffect(() => {
    if (contentRef.current) {
      const contentHeight = contentRef.current.scrollHeight;
      // Small hysteresis to avoid toggling around the threshold due to minor
      // layout jitter while virtualized items mount/measure.
      const upperThreshold = DEFAULT_COLLAPSED_HEIGHT + 8;
      const lowerThreshold = DEFAULT_COLLAPSED_HEIGHT - 8;
      const shouldShow = showCollapseOption
        ? contentHeight > lowerThreshold
        : contentHeight > upperThreshold;

      // Only update if changed to avoid unnecessary re-renders
      if (shouldShow !== showCollapseOption) {
        setShowCollapseOption(shouldShow);
      }

      // On initial render with tall content, don't auto-collapse
      // User explicitly toggles collapse state
      if (initialRenderRef.current) {
        initialRenderRef.current = false;
      }
    }
  }, [displayOutputs, wrapText, showCollapseOption]);

  // Handle collapse toggle
  // Calls onScrolledChange to persist the collapsed state (Jupyter standard)
  const handleCollapseToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent bubbling to cell container (avoids scroll jumps)

    const newCollapsed = !isCollapsed;
    onScrolledChange?.(newCollapsed);
    // Note: Don't call onVisibilityChange here - Virtuoso handles scroll position
    // during height changes. Triggering scroll during state transition causes jumps.
  }, [isCollapsed, onScrolledChange]);

  // Handle resize drag
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const startY = e.clientY;
    const startHeight = collapsedHeight;
    let finalHeight = startHeight;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      finalHeight = Math.max(MIN_HEIGHT, startHeight + deltaY);
      setCollapsedHeight(finalHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      resizeCleanupRef.current = null;
      // Persist the final height if it changed
      if (finalHeight !== startHeight) {
        onScrolledHeightChange?.(finalHeight);
      }
    };

    // Store cleanup for unmount
    resizeCleanupRef.current = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [collapsedHeight, onScrolledHeightChange]);

  // Show minimal output area with just execution time if no outputs
  if (outputs.length === 0) {
    if (executionMs === undefined) return null;
    return (
      <div className="relative border-t border-slate-100 rounded-b-lg bg-white h-8">
        <span className="absolute top-1.5 right-2 text-xs text-slate-400 tabular-nums" title="Execution time">
          {formatExecutionTime(executionMs)}
        </span>
      </div>
    );
  }

  // Check if any output has long lines that might benefit from scroll toggle
  const hasTextOutput = coalescedOutputs.some(o => o.type === 'stdout' || o.type === 'stderr' || o.type === 'error');

  return (
    <>
      {activeImageSrc && (
        <ImageModalViewer
          src={activeImageSrc}
          alt="Output"
          onClose={() => setActiveImageSrc(null)}
        />
      )}
      <div
        ref={containerRef}
        className="relative border-t border-slate-100 rounded-b-lg bg-white"
      >
      {isUpdating && outputs.length > 0 && (
        <div
          aria-label="Output updating"
          data-testid="cell-output-updating-overlay"
          className="absolute inset-0 bg-slate-500/10 pointer-events-none z-10"
        />
      )}
      {/* Left gutter - clickable to collapse/expand */}
      {showCollapseOption && (
        <div
          className="absolute left-0 top-0 bottom-0 w-6 flex items-start pt-3 justify-center cursor-pointer hover:bg-slate-100 transition-colors z-20 border-r border-slate-100"
          onClick={handleCollapseToggle}
          title={isCollapsed ? "Expand output" : "Collapse output"}
        >
          {isCollapsed ? (
            <ChevronRight className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          )}
        </div>
      )}

      {/* Top right controls: execution time and wrap toggle */}
      <div className="absolute top-1 right-2 flex items-center gap-2 z-20">
        {/* Execution time indicator */}
        {executionMs !== undefined && (
          <span className="text-xs text-slate-400 tabular-nums" title="Execution time">
            {formatExecutionTime(executionMs)}
          </span>
        )}
        {/* Wrap/scroll toggle button - local state only */}
        {hasTextOutput && (
          <button
            className="p-1 rounded hover:bg-slate-100 transition-colors"
            onClick={() => setWrapText(!wrapText)}
            title={wrapText ? "Switch to horizontal scroll" : "Switch to text wrap"}
          >
            {wrapText ? (
              <ArrowRightLeft className="w-4 h-4 text-slate-400" />
            ) : (
              <WrapText className="w-4 h-4 text-slate-400" />
            )}
          </button>
        )}
      </div>

      {/* Output content */}
      <div
        ref={contentRef}
        className={`p-4 ${showCollapseOption ? 'pl-8' : ''} ${hasTextOutput ? 'pr-8' : ''}`}
        style={isCollapsed ? {
          maxHeight: collapsedHeight,
          overflowY: 'auto',
          overflowX: wrapText ? 'hidden' : 'auto'
        } : {
          overflowX: wrapText ? 'hidden' : 'auto'
        }}
      >
        {coalescedOutputs.map((out) => (
          <OutputItem key={out.id} output={out} wrapText={wrapText} onOpenImage={setActiveImageSrc} allowAutoplay={out.timestamp >= mountTimeRef.current} kernelSessionId={kernelSessionId} />
        ))}
      </div>

      {/* Actionable hint for recognized kernel errors (kept outside the scroll
          area so it's visible even when the output is collapsed). */}
      {kernelHint && (
        <div className={`px-4 ${showCollapseOption ? 'pl-8' : ''}`}>
          <KernelHintBar hint={kernelHint} kernelSessionId={kernelSessionId} />
        </div>
      )}

      {/* Resize handle - only show when collapsed */}
      {isCollapsed && (
        <div
          className={`absolute bottom-0 left-0 right-0 h-3 flex items-center justify-center cursor-ns-resize bg-slate-50 hover:bg-slate-100 border-t border-slate-200 transition-colors z-20 ${isResizing ? 'bg-blue-100' : ''}`}
          onMouseDown={handleResizeStart}
        >
          <GripHorizontal className="w-4 h-4 text-slate-400" />
        </div>
      )}

      {/* Collapsed indicator */}
      {isCollapsed && (
        <div className="absolute bottom-3 right-2 text-xs text-slate-400 bg-white px-1 rounded z-20">
          Scroll for more
        </div>
      )}
      </div>
    </>
  );
};

export const CellOutput = memo(CellOutputComponent, (prevProps, nextProps) => {
  return (
    prevProps.isUpdating === nextProps.isUpdating &&
    prevProps.executionMs === nextProps.executionMs &&
    prevProps.scrolled === nextProps.scrolled &&
    prevProps.scrolledHeight === nextProps.scrolledHeight &&
    prevProps.kernelSessionId === nextProps.kernelSessionId &&
    areOutputsEqual(prevProps.outputs, nextProps.outputs)
  );
});

CellOutput.displayName = 'CellOutput';
