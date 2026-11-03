import React, { useMemo } from 'react';

/**
 * Lightweight Python syntax highlighter
 * Uses regex tokenization - fast and virtualization-friendly
 */

interface Token {
  type: 'keyword' | 'atom' | 'definition' | 'className' | 'string' | 'comment' | 'number' | 'decorator' | 'text';
  value: string;
}

const KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from',
  'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
  'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
]);

const ATOMS = new Set(['True', 'False', 'None']);


// Tokenize Python code - simple regex-based approach
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let remaining = code;
  let afterKeyword = '';

  while (remaining.length > 0) {
    let matched = false;

    // Triple-quoted strings (must come before single quotes)
    const tripleMatch = remaining.match(/^('''[\s\S]*?'''|"""[\s\S]*?""")/);
    if (tripleMatch) {
      tokens.push({ type: 'string', value: tripleMatch[0] });
      remaining = remaining.slice(tripleMatch[0].length);
      matched = true;
      continue;
    }

    // Single/double quoted strings
    const stringMatch = remaining.match(/^('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/);
    if (stringMatch) {
      tokens.push({ type: 'string', value: stringMatch[0] });
      remaining = remaining.slice(stringMatch[0].length);
      matched = true;
      continue;
    }

    // Comments
    const commentMatch = remaining.match(/^#.*/);
    if (commentMatch) {
      tokens.push({ type: 'comment', value: commentMatch[0] });
      remaining = remaining.slice(commentMatch[0].length);
      matched = true;
      continue;
    }

    // Decorators
    const decoratorMatch = remaining.match(/^@\w+/);
    if (decoratorMatch) {
      tokens.push({ type: 'decorator', value: decoratorMatch[0] });
      remaining = remaining.slice(decoratorMatch[0].length);
      matched = true;
      continue;
    }

    // Numbers (including floats and scientific notation)
    const numberMatch = remaining.match(/^-?\d+\.?\d*(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      tokens.push({ type: 'number', value: numberMatch[0] });
      remaining = remaining.slice(numberMatch[0].length);
      matched = true;
      continue;
    }

    // Words (identifiers, keywords, builtins)
    const wordMatch = remaining.match(/^[a-zA-Z_]\w*/);
    if (wordMatch) {
      const word = wordMatch[0];
      let type: Token['type'] = 'text';
      if (afterKeyword === 'def') {
        type = 'definition';
      } else if (afterKeyword === 'class') {
        type = 'className';
      } else if (KEYWORDS.has(word)) {
        type = 'keyword';
      } else if (ATOMS.has(word)) {
        type = 'atom';
      }
      afterKeyword = word;
      tokens.push({ type, value: word });
      remaining = remaining.slice(word.length);
      matched = true;
      continue;
    }

    // Operators
    const operatorMatch = remaining.match(/^[+\-*/%=<>!&|^~:]+/);
    if (operatorMatch) {
      tokens.push({ type: 'text', value: operatorMatch[0] });
      remaining = remaining.slice(operatorMatch[0].length);
      matched = true;
      continue;
    }

    // Any other character (whitespace, punctuation, etc.)
    if (!matched) {
      tokens.push({ type: 'text', value: remaining[0] });
      remaining = remaining.slice(1);
    }
  }

  return tokens;
}

// What the notebook editor actually paints: CodeMirror's defaultHighlightStyle.
const TOKEN_STYLES: Record<Token['type'], string> = {
  keyword: 'text-[#708]',
  atom: 'text-[#219]',
  definition: 'text-[#00f]',
  className: 'text-[#167]',
  string: 'text-[#a11]',
  comment: 'text-[#940]',
  number: 'text-[#164]',
  decorator: 'text-[#404740]',
  text: ''
};

interface Props {
  code: string;
  className?: string;
}

export const PythonHighlighter: React.FC<Props> = ({ code, className = '' }) => {
  const tokens = useMemo(() => tokenize(code), [code]);

  return (
    <pre className={`font-mono text-sm leading-6 whitespace-pre-wrap break-words ${className}`}>
      {tokens.map((token, i) => (
        <span key={i} className={TOKEN_STYLES[token.type]}>
          {token.value}
        </span>
      ))}
    </pre>
  );
};
