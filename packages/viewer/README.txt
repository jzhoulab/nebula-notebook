Nebula Notebook Viewer 0.1.0
============================

A dependency-free browser library for viewing saved nbformat-4 .ipynb files
from Nebula Notebook or Jupyter. This package is present in the repository;
it has not been published to an npm registry by this change.

Usage (ES modules)

  import {mountNotebook} from './nebula-viewer/index.js';
  // Include nebula-viewer/style.css in the host page.
  const notebook = await response.json();
  const viewer = mountNotebook(container, notebook, {
    title: 'Processing and quality checks', showCode: true
  });
  // On unmount: viewer.destroy()

The host owns fetching, downloads, dataset navigation and authorization.
The viewer itself has no fetch, kernel, filesystem, terminal, LLM, autosave,
execution or notebook-editing API. Code visibility is ephemeral display state.
It does not import the full Nebula application or its server-backed services.

Supported displays

- Markdown headings, paragraphs, lists, fenced code, inline code, bold and links.
- Code/raw cells, saved execution counters, stdout/stderr and error outputs.
- PNG/JPEG MIME outputs, inert HTML tables/text, text/plain and JSON fallbacks.
- Source strings and source arrays from standard nbformat-4 notebooks.

Read-only display and executable copies

The website shows the saved outputs. To rerun, download the identical .ipynb
plus its input data, environment information and recipe, then open that copy
in a local Nebula instance or another compatible Jupyter environment.
The viewer never executes notebook Python or JavaScript. Rich Nebula/Plotly/
widget outputs use their saved raster/text fallback; active payloads are not
evaluated. Publish fallbacks when a notebook needs to be browsable offline.
HTML is rebuilt from an inert tag allowlist; active content is omitted.
Long text output is visibly truncated at 100,000 characters; source data is
preserved in the caller's notebook and in its download.

The component is intentionally distinct from the full application's sealed
notebook mode. It does not claim to verify a seal, execution provenance or
scientific correctness. Those checks belong in the release and audit bundle.

Validation

  npm test --prefix packages/viewer

Tests use a simulated DOM, not browser rendering. They check format validation,
input preservation, output modes, active-content isolation and teardown.
