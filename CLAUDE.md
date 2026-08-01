# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Nebula Notebook is a web-based Jupyter notebook alternative with AI integration. It uses real Jupyter kernels via ZeroMQ, supports multiple LLM providers (Gemini, OpenAI, Anthropic), and provides real filesystem access. The backend is Node.js/TypeScript with Express, communicating with Jupyter kernels via the ZeroMQ protocol.

## Development Commands

```bash
# Install dependencies
npm install                    # Frontend + backend dependencies
cd node-server && npm install  # Backend dependencies

# Run the application
npm run dev                    # Development mode with hot reload (Vite on :3000, Node on :8000)
npm run start                  # Alias for npm run dev
npm run prod                   # Production mode (Node.js on :3000 only) — runs the backend
                               # from SOURCE via tsx --watch; a git pull hot-restarts it

# Build
npm run build                  # Frontend production build only (vite). The backend has NO
                               # build step in prod; node-server's `npm run build` (tsc) exists
                               # for `npm start` but its dist/ goes stale — never deploy from it
npm run preview                # Preview production build

# Testing
npm test                       # Run all frontend tests (vitest)
npm test -- --watch            # Watch mode for TDD
cd node-server && npm test     # Run backend tests
```

## Architecture

### Frontend (React 19 + TypeScript + Vite)

**Core Notebook Components:**
- `components/Notebook.tsx` - Main notebook container: multi-tab management, file I/O, kernel sessions, undo/redo, search, inline rename
- `components/Cell.tsx` - Individual cell: execution controls, AI generation, queue position, output scrolling
- `components/CodeEditor.tsx` - CodeMirror 6 editor: syntax highlighting, kernel-based completion, indentation detection
- `components/CellOutput.tsx` - Output rendering: stdout/stderr/error/HTML/image, truncation, resizable collapsed state
- `components/VirtualCellList.tsx` - React Virtuoso for large notebook performance (1000px overscan)

**Dashboard & File Browser:**
- `components/Dashboard.tsx` - Landing page: recent notebooks, file browser, active kernels, terminals, tips
- `components/FileBrowser.tsx` - File/folder browser: sidebar and inline variants, create/delete/rename/upload/download
- `components/FileListItem.tsx` - File list item: icons, metadata, inline rename, context actions

**Terminal:**
- `components/TerminalPage.tsx` - Full-screen terminal with persistent named terminals
- `components/TerminalInstance.tsx` - xterm.js integration with WebSocket PTY connection
- `components/TerminalPanel.tsx` - Embedded terminal panel in notebook view

**AI & Chat:**
- `components/AIChatSidebar.tsx` - AI assistant: full notebook context, multi-message history, image support

**Utilities & Dialogs:**
- `components/SettingsModal.tsx` - Settings: General, AI, Appearance, Notifications tabs
- `components/KernelManager.tsx` - Kernel management: list sessions, memory usage, interrupt/restart
- `components/HistoryPanel.tsx` - Notebook history: timeline view, preview, restore to any point
- `components/NotebookSearch.tsx` - Find & replace: regex, case-sensitive, navigate matches
- `components/AuthGate.tsx` / `TOTPLogin.tsx` - 2FA authentication

**Services:**
- `services/kernelService.ts` - Multi-session kernel management, WebSocket streaming, code completion
- `services/fileService.ts` - Filesystem operations, notebook I/O, history/session persistence
- `services/llmService.ts` - Multi-provider LLM client (Google, OpenAI, Anthropic)
- `services/authService.ts` - JWT token management for 2FA
- `services/terminalService.ts` - Terminal session management
- `services/clusterService.ts` - Multi-server clustering support

**Hooks:**
- `hooks/useUndoRedo.ts` - Operation-based notebook history (insert/delete/move/update cells)
- `hooks/useAutosave.ts` - Debounced autosave (1s) with conflict detection
- `hooks/useConflictResolution.ts` - mtime-based conflict handling

**Utilities:**
- `utils/notebookAvatar.ts` - Deterministic notebook avatars
- `utils/indentationDetector.ts` - Auto-detect code indentation
- `lib/notebookOperations.ts` - Pure functions for notebook state
- `lib/diffUtils.ts` - Diff and patch utilities

### Backend (Node.js + TypeScript + Express)

**Entry & Config:**
- `node-server/src/index.ts` - Express server, WebSocket setup, auth initialization

**Routes:**
- `routes/auth.ts` - 2FA authentication endpoints
- `routes/kernel.ts` - Kernel session management and WebSocket
- `routes/notebook.ts` - Notebook cells, history, session, agent permissions
- `routes/fs.ts` - Filesystem operations (list, read, write, rename, delete, upload, download)
- `routes/llm.ts` - LLM generation endpoints
- `routes/python.ts` - Python environment discovery
- `routes/cluster.ts` - Multi-server clustering

**Services:**
- `kernel/kernel-service.ts` - Jupyter kernel management via ZeroMQ
- `kernel/kernelspec.ts` - Kernel discovery
- `fs/fs-service.ts` - Filesystem operations, notebook I/O, metadata preservation
- `llm/llm-service.ts` - Multi-provider LLM abstraction
- `auth/auth-service.ts` - TOTP 2FA and JWT management
- `auth/auth-middleware.ts` - Route and WebSocket authentication
- `terminal/pty-manager.ts` - PTY session management
- `discovery/discovery-service.ts` - Python environment discovery

## Key API Endpoints

**Authentication** (unprotected)
- `GET /api/auth/status` - Check 2FA config and auth status
- `POST /api/auth/verify` - Verify TOTP code, get JWT token

**Kernels** (protected)
- `GET /api/kernels` - List available kernelspecs
- `POST /api/kernels/start` - Start kernel session
- `POST /api/kernels/for-file` - Get or create kernel for notebook (one notebook = one kernel)
- `WS /api/kernels/{id}/ws` - WebSocket for kernel I/O and completion
- `POST /api/kernels/{id}/interrupt` - Interrupt execution
- `POST /api/kernels/{id}/restart` - Restart kernel
- `GET /api/kernels/sessions` - List active sessions with memory usage

**Notebook** (protected)
- `GET /api/notebook/cells` - Get cells + kernelspec + mtime
- `POST /api/notebook/save` - Save notebook cells
- `GET/POST /api/notebook/history` - Load/save operation history
- `GET/POST /api/notebook/session` - Load/save editing state
- `GET /api/notebook/agent-status` - Check agent permissions
- `POST /api/notebook/permit-agent` - Grant/revoke agent access
- `WS /api/notebook/{path}/ws` - Real-time notebook sync

**Filesystem** (protected)
- `GET /api/fs/list` - List directory contents
- `GET /api/fs/read` - Read file contents
- `GET /api/fs/download` - Download file (raw stream)
- `POST /api/fs/write` - Write file
- `POST /api/fs/create` - Create file or folder
- `DELETE /api/fs/delete` - Delete file or folder
- `POST /api/fs/rename` - Rename/move (handles notebook metadata files)
- `POST /api/fs/duplicate` - Duplicate file or folder
- `POST /api/fs/upload` - Upload file (multipart)

**Terminals** (protected)
- `GET /api/terminals` - List terminals
- `POST /api/terminals` - Create terminal
- `POST /api/terminals/named/{name}` - Get or create named terminal
- `WS /api/terminals/{id}/ws` - WebSocket for terminal I/O

**LLM** (protected)
- `POST /api/llm/generate` - Generate text
- `POST /api/llm/generate-structured` - Generate JSON (code + explanation + action)
- `POST /api/llm/chat` - Chat with notebook context

**Python Discovery** (protected)
- `GET /api/python/environments` - List Python envs and kernelspecs
- `POST /api/python/install-ipykernel` - Install ipykernel into an env (one installer: conda → uv → pip)
- `POST /api/python/probe` - Validate a manually-entered interpreter path, remember it in the cache
- `POST /api/python/install-kernel` - Legacy: install + register a kernelspec (MCP/scripts; UI uses raw launch)

## URL Parameters

- `?file=<path>` - Open notebook file directly
- `?terminal=<name>` - Open persistent named terminal

## Configuration

- Frontend dev server proxies `/api/*` to backend (configured in `vite.config.ts`)
- 2FA config stored in `~/.nebula/auth.json` (mode 0600)
- Notebook history/session stored in `.nebula/` directory alongside notebooks
- TypeScript paths: `@/*` maps to project root

### Settings (localStorage)
```typescript
interface NebulaSettings {
  rootDirectory: string;
  llmProvider: 'google' | 'openai' | 'anthropic';
  llmModel: string;
  lastKernel: string;
  notifyOnLongRun?: boolean;
  notifyThresholdSeconds?: number;
  notifySoundEnabled?: boolean;
  indentation?: 'auto' | '2' | '4' | '8' | 'tab';
  showLineNumbers?: boolean;
  showCellIds?: boolean;
  apiKeys?: { google?, openai?, anthropic? };
}
```

## Authentication (2FA)

Nebula uses TOTP-based two-factor authentication:

1. **First Start**: Server prints QR code to terminal. Scan with authenticator app.
2. **Login**: Enter 6-digit code in the UI
3. **Trust Browser**: Check "Trust this browser" for 30-day sessions (vs 24 hours)
4. **Rate Limiting**: 5 attempts per 30 seconds

Config file: `~/.nebula/auth.json` contains the TOTP secret.

## Keyboard Shortcuts

The notebook supports Jupyter-style keyboard shortcuts with two modes:
- **Edit Mode** (blue border): Cursor in editor
- **Cell Mode** (green border): Press Escape to enter

### Edit Mode (blue border)
| Shortcut | Action |
|----------|--------|
| `Shift+Enter` | Run cell and advance to next |
| `Ctrl/Cmd+Enter` | Run current cell only |
| `Escape` | Exit to cell mode |
| `Ctrl/Cmd+Z` / `Y` | Undo / Redo (text only) |

### Cell Mode (green border, press Escape to enter)
| Shortcut | Action |
|----------|--------|
| `Enter` | Enter edit mode |
| `A` / `B` | Insert cell above / below |
| `M` / `Y` | Convert to Markdown / Code |
| `X` / `C` / `V` | Cut / Copy / Paste cell |
| `Shift+V` | Paste cell above |
| `E` / `D` | Enqueue / Dequeue cell for batch execution |
| `Z` / `Shift+Z` | Undo / Redo cell operations (notebook-level history) |
| `Delete/Backspace` | Delete cell |
| `Arrow Up/Down` | Navigate between cells |
| `Ctrl/Cmd+Shift+↑/↓` | Move cell up / down |

### Global
| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd+S` | Save notebook |
| `Ctrl/Cmd+F` | Open search |
| `Ctrl/Cmd+C` | Interrupt kernel (when busy) |
| `Ctrl+\`` | Toggle integrated terminal |

## Key Features

### Cell Execution Queue
- Press `E` in cell mode to enqueue cells for batch execution
- Press `D` to dequeue
- FIFO execution order with queue position display

### History & Session
- Full operation history persisted to `.nebula/` directory
- Restore notebook to any point in history via History panel
- Session state preserved: active cell, unflushed edits

### File Browser
- Sidebar variant (notebook view) and inline variant (dashboard)
- Create/rename/duplicate/delete files and folders
- Drag-and-drop upload
- Filter to notebooks only (preference persisted)
- Inline rename by clicking filename

### Terminals (binding model)
- Terminals are named ptys; attach is always get-or-create on the name — duplicates are
  impossible. A notebook has exactly ONE binding per plane (shell / agent) deciding which
  pty its panel attaches to; bindings persist server-side (`~/.nebula/terminal-bindings.json`)
  and follow the notebook across browsers (`GET/PUT/DELETE /api/terminals/binding`).
- Shell plane default: server-shared `srv-main` (rebindable via the panel chip to
  project / notebook-private / any name). cwd applies on CREATE only — attaching never
  cds a shared terminal. Live legacy per-notebook shells are grandfathered.
- Agent plane default: project (workdir) scope — records in `~/.nebula/agents.json` carry
  the conversation id (`--session-id`), location (server / user's machine), and pinned
  mirror-dir slug; the launch bar is a state machine over them (attach live → continue
  hibernated → start fresh), with an honest chip when the session lives at the other
  location. Shared agents get `[now driving: <path>]` origin tags on notebook switch.
- Integrated terminal panel (`Ctrl+\``); full-screen named terminals via `?terminal=name`;
  multiple tabs can attach to the same pty; the panel's "agents" button opens the
  Terminals & agents manager (attach / continue / hibernate / kill).

### Kernel Selection (VSCode-style)

- **Discovery is filesystem-only** (`discovery/conda-locations.ts`): conda envs come from
  `~/.conda/environments.txt`, `.condarc` `envs_dirs`, well-known roots (incl. micromamba,
  Homebrew), `CONDA_*`/`MAMBA_*` env vars, and roots derived from conda/mamba/micromamba
  binaries on PATH — conda is never executed. A dir is a conda env iff it has `conda-meta/`.
- **Raw launch**: any env with ipykernel starts directly via the kernel name `env:<pythonPath>`
  (synthetic argv `python -m ipykernel_launcher`); no kernelspec registration.
- **Install button**: envs without ipykernel prompt to install; the backend picks ONE
  installer (conda-like binary `-p <prefix>` → `uv pip install --python` → pip), verifies
  the import afterwards, and reports failure with the installer's output. PEP 668
  externally-managed interpreters are refused with a copyable isolated-env command.
- **Manual entry**: "Enter interpreter path…" probes and remembers arbitrary interpreters.
- **Per-env kernelspecs**: each discovered env's `share/jupyter/kernels` is scanned (R,
  Julia, etc.); the env's own default `python*` spec is hidden as redundant.

### AI Integration
- Chat sidebar with full notebook context
- Cell generation from prompts
- Error fixing suggestions
- Multi-provider support (Gemini, OpenAI, Anthropic)

### MCP Server
Nebula includes an MCP server for AI agent integration, enabling agents to:
- Run code in notebooks
- Analyze data
- Execute notebook operations headlessly

## Undo/Redo System

Nebula uses a **dual undo/redo architecture**:

### 1. Text-Level Undo (CodeMirror)
- `Ctrl/Cmd+Z` / `Shift+Z` in edit mode
- Character-level undo per cell

### 2. Notebook-Level Undo (useUndoRedo hook)
- Toolbar Undo/Redo buttons
- Operations: insert/delete/move cells, type changes, metadata changes
- Full operation log with timestamps for session replay

### Operation Types
```typescript
type UndoableOperation =
  | { type: 'insertCell'; index: number; cell: Cell }
  | { type: 'deleteCell'; index: number; cell: Cell }
  | { type: 'moveCell'; fromIndex: number; toIndex: number }
  | { type: 'updateContent'; cellId: string; oldContent: string; newContent: string }
  | { type: 'updateMetadata'; cellId: string; changes: MetadataChanges }
  | { type: 'batch'; operations: UndoableOperation[] };
```

## Performance

- **Progressive rendering**: Cells render in batches of 10 via `requestIdleCallback` (VirtualCellList)
- **Lazy CodeMirror**: Cells start as `<pre>` placeholders, swap to CodeMirror when near viewport
- **Autosave**: 1-second debounce with conflict detection
- **Output Truncation**: Large outputs truncated for display (data preserved)

### Scroll Jump Prevention (IMPORTANT — do not regress)

CodeMirror 6 defers line measurement for off-screen content. When a cell enters the viewport,
CM re-measures its lines and can change height by 500px+. This causes visible scroll jumps,
especially when jumping to the bottom of a notebook and scrolling back up.

The fix uses **height pinning** during the `<pre>` → CodeMirror transition (Cell.tsx):

1. Each cell renders a `<pre>` placeholder with matching CSS (`break-all`, same font/padding as CM)
2. When the cell enters the viewport (IntersectionObserver, 300px margin), the editor wrapper div
   is **locked** to the `<pre>` height (`height: Xpx; overflow: hidden`) before React swaps to CM
3. CM mounts inside the locked container and goes through async measurement passes (height oscillates)
   — but none of this affects page layout because the wrapper is locked
4. A ResizeObserver watches for CM to stop resizing (150ms of stability), then **releases** the pin
5. The final height delta (`<pre>` vs settled CM) is typically <10px — imperceptible

Three things that must stay in sync for this to work:
- **Cell.tsx `<pre>`**: must have `break-all` and matching font/padding to closely match CM's final height
- **CodeEditor.tsx `.cm-scroller`**: must have `height: auto !important` to override `@uiw/react-codemirror`'s
  `height: 100% !important` default — without this, CM editors collapse to ~625px with internal scrollbars
- **Cell.tsx height pinning**: the IntersectionObserver must lock height BEFORE `setEditorMounted(true)`,
  and the ResizeObserver must wait for CM to fully settle before releasing

**Do NOT**: remove lazy mounting (causes CM to estimate heights for all cells upfront — wrong estimates
cause jumps when cells enter viewport). Do NOT remove `break-all` from `<pre>` (causes large height
mismatch). Do NOT remove `height: auto !important` from `.cm-scroller` (causes tiny editors).

## Metadata Preservation

Cell metadata is preserved across load/save:
- `nebula_id`: Internal cell ID for history tracking
- `scrolled`: Jupyter-standard collapsed output state
- `_metadata`: Unknown metadata from external tools preserved

## Test Locations

- Frontend: `components/__tests__/`, `hooks/__tests__/`, `services/__tests__/`, `lib/__tests__/`
- Backend: `node-server/src/__tests__/`
- Framework: Vitest

## TDD Workflow (Required)

1. Write failing tests first
2. Run tests to confirm they fail
3. Implement minimum code to pass
4. Run tests to confirm they pass
5. Refactor while keeping tests green
6. Commit when tests pass

## Legacy-Compat Registry

Compat shims are tagged `LEGACY-COMPAT(<date>, …)` in code — `grep -rn "LEGACY-COMPAT"`
finds them all. Each states its removal condition; none should outlive it:

- **Grandfathered per-notebook shells** (TerminalPanel `resolveShellTerminal`):
  self-expiring — ptys die on server restart. Remove the legacy-name check and
  old-server fallback in the next release.
- **Slug-less agent records resume from real workdir** (TerminalPanel
  `continueAgentRecord` + `legacyRealCwd` plumbing in agentTerminalService):
  remove once `~/.nebula/agents.json` has no server records without `mirrorSlug`
  (registry caps at 50; every relaunch re-pins).
- **`POST /api/python/install-kernel`** (install + kernelspec registration):
  kept as a supported API for MCP/scripted callers, NOT a shim — the UI uses raw
  launch. Reevaluate only if the MCP surface migrates.
