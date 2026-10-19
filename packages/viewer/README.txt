Nebula Notebook Viewer 0.2.0
===========================

A read-only browser build from the Nebula source tree. It shares the real
MarkdownPreview and PythonHighlighter components and cell presentation tokens
with the application. The package has not been published to an npm registry.

Embed with an ES module

  import {mountNotebook} from './nebula-viewer/index.js';
  const viewer = mountNotebook(container, notebook, {
    title: 'catalog-audit', filename: 'catalog-audit.ipynb', showCode: true
  });
  // viewer.setShowCode(false); viewer.destroy();

Distribute dist/index.js to the above URL. React and styles are bundled;
the hosting page does not need React, Tailwind, CodeMirror, or a server.
Each mount has an isolated shadow root so page styles cannot alter the
notebook. element.shadowRoot is exposed for integration and accessibility QA.

Plain script and offline HTML

  <script src="viewer.global.js"></script>
  <script>
    NebulaNotebookViewer.mountNotebook(container, notebook);
  </script>

Distribute dist/viewer.global.js. Inline that bundle and serialized notebook
data to create standalone offline HTML; escape less-than characters in
serialized notebook data. A page containing this viewer can itself be
embedded with a normal iframe. The viewer uses no cross-frame messaging.
Host authentication and frame policies must permit the intended audience.

Reading behavior

Nebula cell headers, syntax colors, Markdown, execution counts, source/output
folding, a section contents list and a download of the original notebook.
Supported saved outputs: stdout/stderr, errors, PNG/JPEG, inert HTML tables
and text/JSON. Unknown metadata and complete output payloads remain in the
download. Long displayed text is truncated visibly at 100,000 characters.

Execution is a separate capability

No kernel, filesystem, terminal, AI service, credentials, autosave or notebook
editing is imported. The build fails if backend or runtime service modules
enter the viewer dependency graph. Code cells never execute in this viewer.
Arbitrary active HTML/JavaScript, live widgets and custom interactive outputs
are not evaluated; publish saved image/text fallbacks. External Markdown
images are shown as labels rather than fetched automatically. The full
application retains its existing Markdown image behavior.

For execution, download the same .ipynb with data/environment/recipe, then
open a local copy in full Nebula or another compatible Jupyter environment.
This display component does not verify a provenance seal or scientific QC.

Build and verify from the full Nebula repository

  npm run build --prefix packages/viewer
  npx tsc -p packages/viewer/tsconfig.json
  npm test --prefix packages/viewer
  npx vitest run components/__tests__/NotebookViewer.test.tsx components/__tests__/Cell.test.tsx

Tests use a simulated DOM; real-browser visual checks are separate. Existing
backend replay/sealing work is outside the viewer package.
