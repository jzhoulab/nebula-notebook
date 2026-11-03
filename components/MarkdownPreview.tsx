import React, { createContext, useContext } from 'react';

interface Props {
  content: string;
  placeholder?: string;
  allowImages?: boolean;
}

const ImagePolicy = createContext(true);
function MarkdownImage({src, alt}: {src: string; alt: string}) {
  const allowImages = useContext(ImagePolicy);
  return allowImages ? <img src={src} alt={alt} className="my-3 max-h-[32rem] max-w-full rounded-lg border border-slate-200 bg-white object-contain shadow-sm" />
    : <span className="text-slate-500">[Image: {alt || 'external image'}]</span>;
}

const SAFE_URL_PATTERN = /^(https?:|mailto:|\/|#)/i;
const BLOCKQUOTE_PATTERN = /^>\s?(.*)$/;
const UNORDERED_LIST_PATTERN = /^[-*+]\s+(.*)$/;
const ORDERED_LIST_PATTERN = /^\d+\.\s+(.*)$/;
const HEADING_CLASSES = [
  '',
  'mt-1 mb-3 text-2xl font-semibold tracking-tight text-slate-900',
  'mt-1 mb-3 text-xl font-semibold tracking-tight text-slate-900',
  'mt-1 mb-2 text-lg font-semibold text-slate-900',
  'mt-1 mb-2 text-base font-semibold text-slate-900',
  'mt-1 mb-2 text-sm font-semibold uppercase tracking-wide text-slate-700',
  'mt-1 mb-2 text-sm font-medium uppercase tracking-wide text-slate-500',
];

function sanitizeUrl(url: string): string | null {
  const trimmed = url.trim();
  return SAFE_URL_PATTERN.test(trimmed) ? trimmed : null;
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let remaining = text;
  let partIndex = 0;

  while (remaining.length > 0) {
    const matches = [
      { type: 'image' as const, match: /!\[([^\]]*)\]\(([^)]+)\)/.exec(remaining) },
      { type: 'link' as const, match: /\[([^\]]+)\]\(([^)]+)\)/.exec(remaining) },
      { type: 'code' as const, match: /`([^`]+)`/.exec(remaining) },
      { type: 'strong' as const, match: /\*\*([^*]+)\*\*/.exec(remaining) },
      { type: 'strike' as const, match: /~~([^~]+)~~/.exec(remaining) },
      { type: 'em' as const, match: /\*([^*\n]+)\*/.exec(remaining) },
    ].filter((entry) => entry.match);

    if (matches.length === 0) {
      nodes.push(remaining);
      break;
    }

    matches.sort((left, right) => (left.match?.index ?? 0) - (right.match?.index ?? 0));
    const nextMatch = matches[0];
    const match = nextMatch.match;
    if (!match) break;

    if (match.index > 0) {
      nodes.push(remaining.slice(0, match.index));
    }

    const key = `${keyPrefix}-${partIndex}`;
    const [, firstGroup = '', secondGroup = ''] = match;

    if (nextMatch.type === 'image') {
      const safeUrl = sanitizeUrl(secondGroup);
      if (safeUrl) {
        nodes.push(
          <MarkdownImage
            key={key}
            src={safeUrl}
            alt={firstGroup}
          />,
        );
      } else {
        nodes.push(match[0]);
      }
    } else if (nextMatch.type === 'link') {
      const safeUrl = sanitizeUrl(secondGroup);
      if (safeUrl) {
        nodes.push(
          <a
            key={key}
            href={safeUrl}
            target={safeUrl.startsWith('#') || safeUrl.startsWith('/') ? undefined : '_blank'}
            rel={safeUrl.startsWith('#') || safeUrl.startsWith('/') ? undefined : 'noreferrer'}
            className="text-blue-700 underline decoration-blue-200 underline-offset-2 hover:text-blue-800 hover:decoration-blue-400"
            onClick={(event) => event.stopPropagation()}
          >
            {renderInline(firstGroup, `${key}-label`)}
          </a>,
        );
      } else {
        nodes.push(match[0]);
      }
    } else if (nextMatch.type === 'code') {
      nodes.push(
        <code
          key={key}
          className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.8125rem] text-slate-800"
        >
          {firstGroup}
        </code>,
      );
    } else if (nextMatch.type === 'strong') {
      nodes.push(
        <strong key={key} className="font-semibold text-slate-900">
          {renderInline(firstGroup, `${key}-strong`)}
        </strong>,
      );
    } else if (nextMatch.type === 'strike') {
      nodes.push(
        <del key={key} className="text-slate-500">
          {renderInline(firstGroup, `${key}-strike`)}
        </del>,
      );
    } else if (nextMatch.type === 'em') {
      nodes.push(
        <em key={key} className="italic">
          {renderInline(firstGroup, `${key}-em`)}
        </em>,
      );
    }

    remaining = remaining.slice(match.index + match[0].length);
    partIndex += 1;
  }

  return nodes;
}

function isBlockBoundary(line: string): boolean {
  return (
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^([-*_])(?:\s*\1){2,}\s*$/.test(line) ||
    BLOCKQUOTE_PATTERN.test(line) ||
    UNORDERED_LIST_PATTERN.test(line) ||
    ORDERED_LIST_PATTERN.test(line)
  );
}

function renderParagraph(lines: string[], key: string): React.ReactElement {
  const children: React.ReactNode[] = [];

  lines.forEach((line, index) => {
    if (index > 0) children.push(' ');
    children.push(...renderInline(line, `${key}-line-${index}`));
  });

  return (
    <p key={key} className="my-2 text-sm leading-6 text-slate-800">
      {children}
    </p>
  );
}

function renderBlocks(content: string, keyPrefix: string): React.ReactElement[] {
  const normalized = content.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const elements: React.ReactElement[] = [];
  let cursor = 0;
  let blockIndex = 0;

  while (cursor < lines.length) {
    const line = lines[cursor];
    const trimmed = line.trim();

    if (!trimmed) {
      cursor += 1;
      continue;
    }

    const blockKey = `${keyPrefix}-${blockIndex}`;
    blockIndex += 1;

    if (/^```/.test(line)) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      cursor += 1;

      while (cursor < lines.length && !/^```/.test(lines[cursor])) {
        codeLines.push(lines[cursor]);
        cursor += 1;
      }

      if (cursor < lines.length && /^```/.test(lines[cursor])) {
        cursor += 1;
      }

      elements.push(
        <div key={blockKey} className="my-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-950 text-slate-100 shadow-sm">
          {language && (
            <div className="border-b border-white/10 px-3 py-1 text-[0.6875rem] uppercase tracking-wide text-slate-400">
              {language}
            </div>
          )}
          <pre className="overflow-x-auto px-3 py-2 text-[0.8125rem] leading-6">
            <code>{codeLines.join('\n')}</code>
          </pre>
        </div>,
      );
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 6);
      const tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      elements.push(
        React.createElement(
          tag,
          { key: blockKey, className: HEADING_CLASSES[level] },
          renderInline(headingMatch[2], `${blockKey}-heading`),
        ),
      );
      cursor += 1;
      continue;
    }

    if (/^([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      elements.push(<hr key={blockKey} className="my-4 border-slate-200" />);
      cursor += 1;
      continue;
    }

    if (BLOCKQUOTE_PATTERN.test(line)) {
      const quoteLines: string[] = [];

      while (cursor < lines.length) {
        const quoteLine = lines[cursor];
        if (!quoteLine.trim()) {
          quoteLines.push('');
          cursor += 1;
          continue;
        }

        const quoteMatch = BLOCKQUOTE_PATTERN.exec(quoteLine);
        if (!quoteMatch) break;

        quoteLines.push(quoteMatch[1]);
        cursor += 1;
      }

      elements.push(
        <blockquote key={blockKey} className="my-3 border-l-4 border-slate-200 bg-slate-50/80 py-1 pl-4 pr-2 text-slate-600">
          {renderBlocks(quoteLines.join('\n'), `${blockKey}-quote`)}
        </blockquote>,
      );
      continue;
    }

    const unorderedMatch = UNORDERED_LIST_PATTERN.exec(line);
    const orderedMatch = ORDERED_LIST_PATTERN.exec(line);
    if (unorderedMatch || orderedMatch) {
      const items: string[] = [];
      const ordered = Boolean(orderedMatch);

      while (cursor < lines.length) {
        const currentLine = lines[cursor];
        const itemMatch = ordered ? ORDERED_LIST_PATTERN.exec(currentLine) : UNORDERED_LIST_PATTERN.exec(currentLine);
        if (itemMatch) {
          items.push(itemMatch[1]);
          cursor += 1;
          continue;
        }

        const continuationMatch = /^\s{2,}(.*)$/.exec(currentLine);
        if (continuationMatch && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1]} ${continuationMatch[1].trim()}`;
          cursor += 1;
          continue;
        }

        break;
      }

      const Tag = ordered ? 'ol' : 'ul';
      const listClassName = ordered
        ? 'my-3 list-decimal space-y-1 pl-6 text-sm leading-6 text-slate-800'
        : 'my-3 list-disc space-y-1 pl-6 text-sm leading-6 text-slate-800';

      elements.push(
        <Tag key={blockKey} className={listClassName}>
          {items.map((item, itemIndex) => (
            <li key={`${blockKey}-item-${itemIndex}`}>{renderInline(item, `${blockKey}-item-${itemIndex}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (cursor < lines.length) {
      const paragraphLine = lines[cursor];
      if (!paragraphLine.trim()) break;
      if (paragraphLines.length > 0 && isBlockBoundary(paragraphLine)) break;
      paragraphLines.push(paragraphLine.trim());
      cursor += 1;
    }

    elements.push(renderParagraph(paragraphLines, blockKey));
  }

  return elements;
}

export const MarkdownPreview: React.FC<Props> = ({ content, placeholder = '## Markdown Title', allowImages = true }) => {
  const trimmed = content.trim();

  return (
    <ImagePolicy.Provider value={allowImages}><div className="px-3 py-2 select-text">
      {trimmed ? (
        <div className="[overflow-wrap:anywhere]">
          {renderBlocks(content, 'markdown')}
        </div>
      ) : (
        <p className="min-h-[1.5rem] text-sm italic text-slate-400">{placeholder}</p>
      )}
    </div></ImagePolicy.Provider>
  );
};
