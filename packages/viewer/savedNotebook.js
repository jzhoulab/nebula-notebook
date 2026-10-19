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

export function renderOutput(doc, output) {
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

