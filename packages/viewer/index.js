/** Nebula Notebook Viewer. Pure display: no kernels, services, mutation or code evaluation. */
const MAX_TEXT = 100000;
const join = (value, field = 'text') => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(x => typeof x === 'string')) return value.join('');
  throw new TypeError(`${field} must be a string or an array of strings`);
};

export function parseNotebook(input) {
  const n = typeof input === 'string' ? JSON.parse(input) : input;
  if (!n || n.nbformat !== 4) throw new TypeError('Expected an nbformat 4 notebook');
  if (!Array.isArray(n.cells)) throw new TypeError('Notebook cells must be an array');
  return {...n, metadata: {...(n.metadata || {})}, cells: n.cells.map((c, i) => {
    if (!['code', 'markdown', 'raw'].includes(c.cell_type)) throw new TypeError(`Unsupported cell_type at cell ${i}`);
    if (c.outputs !== undefined && !Array.isArray(c.outputs)) throw new TypeError(`outputs must be an array at cell ${i}`);
    return {...c, source: join(c.source, `cell ${i} source`), outputs: [...(c.outputs || [])]};
  })};
}

function safeLink(value, doc) {
  try {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw || raw.startsWith('//')) return null;
    const u = new URL(raw, doc.baseURI);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}

function element(doc, tag, className, text) {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function appendInline(parent, text, doc) {
  // Small Markdown subset, using DOM text nodes rather than HTML interpolation.
  const re = /(`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\))/g;
  let cursor = 0, match;
  while ((match = re.exec(text))) {
    parent.append(doc.createTextNode(text.slice(cursor, match.index)));
    if (match[2]) parent.append(element(doc, 'code', '', match[2]));
    else if (match[3]) parent.append(element(doc, 'strong', '', match[3]));
    else {
      const href = safeLink(match[5], doc);
      if (href) { const a = element(doc, 'a', '', match[4]); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a); }
      else parent.append(doc.createTextNode(match[0]));
    }
    cursor = match.index + match[0].length;
  }
  parent.append(doc.createTextNode(text.slice(cursor)));
}

function markdown(doc, source) {
  const wrapper = element(doc, 'div', 'nb-markdown');
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let list = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { list = null; continue; }
    if (/^```/.test(line)) {
      const code = []; while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      wrapper.append(element(doc, 'pre', 'nb-code', code.join('\n'))); list = null; continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^(?:[-*+]\s+|\d+\.\s+)(.*)$/.exec(line);
    if (heading) {
      const h = element(doc, 'h' + Math.min(6, heading[1].length + 1)); appendInline(h, heading[2], doc); wrapper.append(h); list = null;
    } else if (bullet) {
      if (!list) { list = element(doc, /^\d/.test(line) ? 'ol' : 'ul'); wrapper.append(list); }
      const li = element(doc, 'li'); appendInline(li, bullet[1], doc); list.append(li);
    } else {
      const p = element(doc, 'p'); appendInline(p, line, doc); wrapper.append(p); list = null;
    }
  }
  return wrapper;
}

function textOutput(doc, text, error = false) {
  const box = element(doc, 'div', 'nb-output' + (error ? ' nb-error' : ''));
  // ANSI control codes are presentation only; never interpreted as terminal commands.
  const clean = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  box.append(element(doc, 'pre', '', clean.slice(0, MAX_TEXT)));
  if (clean.length > MAX_TEXT) box.append(element(doc, 'p', 'nb-note', 'Display truncated. The downloaded notebook retains the full saved output.'));
  return box;
}

function safeHtml(doc, source) {
  // Reconstruct an inert subset suitable for data tables, without scripts, CSS,
  // frames, forms, SVG, event handlers, external images or active MIME payloads.
  const parsed = doc.createElement('template');
  parsed.innerHTML = source;
  const allowed = new Set(['TABLE','THEAD','TBODY','TFOOT','TR','TH','TD','CAPTION','P','DIV','SPAN','PRE','CODE','STRONG','EM','B','I','BR','HR','UL','OL','LI','H1','H2','H3','H4','H5','H6','A','BLOCKQUOTE']);
  const blocked = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','SVG','MATH','FORM','INPUT','BUTTON','TEXTAREA','LINK','META']);
  const copy = node => {
    if (node.nodeType === 3) return doc.createTextNode(node.textContent);
    if (node.nodeType !== 1 || blocked.has(node.tagName)) return doc.createDocumentFragment();
    const dest = allowed.has(node.tagName) ? doc.createElement(node.tagName.toLowerCase()) : doc.createDocumentFragment();
    if (node.tagName === 'A') { const href = safeLink(node.getAttribute('href'), doc); if (href) { dest.href = href; dest.target = '_blank'; dest.rel = 'noopener noreferrer'; } }
    if (['TD','TH'].includes(node.tagName)) for (const key of ['colspan','rowspan']) { const n = Number(node.getAttribute(key)); if (Number.isInteger(n) && n > 0 && n < 1000) dest.setAttribute(key, String(n)); }
    for (const child of node.childNodes) dest.append(copy(child));
    return dest;
  };
  const box = element(doc, 'div', 'nb-html-output');
  for (const node of parsed.content.childNodes) box.append(copy(node));
  return box;
}

function renderOutput(doc, output) {
  if (output.output_type === 'stream') return textOutput(doc, join(output.text ?? ''), output.name === 'stderr');
  if (output.output_type === 'error') return textOutput(doc, output.traceback?.length ? join(output.traceback.map(x => x + '\n')) : `${output.ename || 'Error'}: ${output.evalue || ''}`, true);
  const data = output.data || {};
  for (const mime of ['image/png', 'image/jpeg']) if (data[mime]) {
    const value = join(data[mime]).replace(/\s/g, '');
    if (/^[A-Za-z0-9+/]+=*$/.test(value)) { const img = element(doc, 'img', 'nb-image'); img.src = `data:${mime};base64,${value}`; img.alt = 'Saved notebook output'; img.loading = 'lazy'; return img; }
  }
  if (typeof data['text/html'] === 'string' || Array.isArray(data['text/html'])) {
    const value = join(data['text/html']);
    if (value.length <= MAX_TEXT) return safeHtml(doc, value);
    return textOutput(doc, value);
  }
  if (data['text/plain'] !== undefined) return textOutput(doc, join(data['text/plain']));
  if (data['application/json'] !== undefined) return textOutput(doc, JSON.stringify(data['application/json'], null, 2));
  return element(doc, 'p', 'nb-note', 'This output has no supported saved display. Its full MIME payload remains in the notebook; interactive kernel outputs require local execution.');
}

export function mountNotebook(target, input, options = {}) {
  if (!target?.ownerDocument) throw new TypeError('A DOM container is required');
  const n = parseNotebook(input), doc = target.ownerDocument;
  const root = element(doc, 'section', 'nebula-viewer');
  root.setAttribute('aria-label', options.title || 'Nebula read-only notebook');
  const header = element(doc, 'header', 'nb-toolbar');
  const identity = element(doc, 'div', 'nb-identity');
  identity.append(element(doc, 'strong', '', options.title || n.metadata.title || 'Nebula Notebook'));
  identity.append(element(doc, 'span', 'nb-mode', 'Read-only · saved outputs'));
  const toggle = element(doc, 'button', 'nb-toggle', 'Hide code'); toggle.type = 'button';
  header.append(identity, toggle); root.append(header);
  const sources = [];
  n.cells.forEach((cell, index) => {
    const article = element(doc, 'article', 'nb-cell nb-' + cell.cell_type);
    article.dataset.cellIndex = String(index);
    if (cell.cell_type === 'markdown') article.append(markdown(doc, cell.source));
    else {
      const label = cell.cell_type === 'raw' ? 'Raw cell' : cell.execution_count == null ? 'Not executed' : `Saved execution [${cell.execution_count}]`;
      const details = element(doc, 'details', 'nb-source');
      details.append(element(doc, 'summary', '', label), element(doc, 'pre', 'nb-code', cell.source));
      sources.push(details); article.append(details);
      if (cell.outputs.length) {
        const outputs = element(doc, 'div', 'nb-outputs'); outputs.setAttribute('aria-label', 'Saved outputs');
        cell.outputs.forEach(o => outputs.append(renderOutput(doc, o))); article.append(outputs);
      }
    }
    root.append(article);
  });
  let shown = options.showCode !== false;
  const setShowCode = value => { shown = Boolean(value); sources.forEach(s => { s.open = shown; }); toggle.textContent = shown ? 'Hide code' : 'Show code'; toggle.setAttribute('aria-pressed', String(shown)); };
  const onToggle = () => setShowCode(!shown); toggle.addEventListener('click', onToggle); setShowCode(shown);
  target.replaceChildren(root);
  return {setShowCode, destroy() { toggle.removeEventListener('click', onToggle); root.remove(); }};
}
