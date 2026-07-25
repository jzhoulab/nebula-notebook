# Nebula Notebook — Product Demo Storyboard

A ~3-minute product film that earns trust with "it's a *nicer* Jupyter," then
delivers the wow with "your agent edits the notebook **while you do**." Every
claim is an on-screen action — show, never tell.

**Positioning (the one line):** *The notebook that an agent can drive end-to-end
— while you keep working in it.*

**The spine:** one continuous story following a real analysis
(`exoplanets.ipynb`, our hero), so the film feels like a workflow, not a feature
checklist. We open on the impossible thing, rewind to establish the polish, then
build back up to it and pay it off.

---

## Pre-production checklist

Prepare these once; the whole film is shot against them.

- [ ] **Restart the server** (the running instance is stale): `npm run stop && NO_AUTH=true NEBULA_PRESERVE_KERNELS=true NEBULA_REATTACH_KERNELS=true npm run start` → UI at **:3000**.
- [ ] **Kernel ready**: the `nebula` kernel attached, idle (green pill).
- [ ] **Notebook A — `exoplanets.ipynb`** (hero/perf/outputs): the discovery-method scatter, a Plotly cell (interactive), one `application/vnd.nebula.web+json` cell (interactive widget), one cell with a `tqdm` loop. Long enough (~40+ cells, pad with markdown) to *show* instant load.
- [ ] **Notebook B — a deliberate bug**: a cell that raises (e.g. `df.groupby('startype').radius.mean()` with a misspelled column) for the "Fix with agent" beat.
- [ ] **Agent CLI ready**: `claude` installed and the MCP registered (`npx nebula-notebook-mcp setup-mcp`) so the launch chip works on camera.
- [ ] **Clean desktop / browser chrome**: hide bookmarks, full-screen the tab, light theme (matches the app).
- [ ] Verify exact keybindings on screen during rehearsal (the labels below are the intent; confirm against the running build).

---

## ACT 0 — The hook (0:00–0:15)

**Cold open on the one thing Jupyter cannot do.** No logo, no preamble.

| | |
|---|---|
| **On screen** | Split focus: user is typing in cell 2; at the same moment Claude Code (Agent terminal, bottom) is rewriting cell 5. A **purple presence ring** blooms on cell 5 as the agent's edit lands. Both cursors alive. |
| **Caption** | *"Your notebook. Your agent. At the same time."* |
| **Why it lands** | This is literally impossible in Jupyter — its kernel API is fire-and-forget, no concurrent-edit model. We're showing the payoff first to earn the next two minutes. |
| **Features** | collaborative OCC sessions (`operation-router.ts`), presence rings (`Cell.tsx`), agent terminal (`TerminalPanel.tsx`). |

Hard cut to black → title card: **Nebula Notebook**.

---

## ACT 1 — It's a notebook, but everything is smoother (0:15–1:05)

Establish familiarity and rack up the delighters fast. Quick cuts, ~5s each.

1. **Instant open.** Open `exoplanets.ipynb` — 40+ cells, renders immediately.
   *Caption: "Big notebooks open instantly."* — virtualized cell list with
   `content-visibility` + progressive batching (`VirtualCellList.tsx`); the
   explicit contrast: Jupyter/Virtuoso stalls the main thread on large notebooks.

2. **Run All, with a pulse.** Click Run All → pending cells show a pulsing amber
   **`[*]`** queue marker (hover shows position), each finishes with an inline
   **execution time** ("412ms"). *Caption: "See exactly what's running, and how long it took."* —
   execution queue position + timing (`Cell.tsx`, `CellOutput.tsx`).

3. **Outputs that are actually alive.** The Plotly cell renders → pan / zoom /
   hover on camera. Then the **Nebula-web interactive output** (a small custom
   widget — click it, it responds). *Caption: "Interactive outputs. No widget
   plumbing."* — `application/vnd.nebula.web+json` + Plotly MIME
   (`DisplayDataOutput.tsx`, `docs/RICH_OUTPUTS.md`).

4. **A progress bar that looks like one.** Run the `tqdm` cell → a single clean
   bar advances (not a wall of `\r`). *Caption: "Progress bars, done right."* —
   carriage-return + stream coalescing (`CellOutput.tsx`, `fs-service.ts`).

5. **Driven by the keyboard.** `⌘⇧P` opens the **quick cell navigator** → type
   "scatter" → jump. Then command-mode: `b` new cell, `m` markdown, `y` code.
   *Caption: "Fly through it without the mouse."* — quick navigator + Jupyter-style
   keymap (`Notebook.tsx`).

6. **Search & replace — across the whole notebook.** `⌘F`, seeded with the
   selected token, regex on, live match count, **Replace all**. *Caption:
   "Real find-and-replace. Regex included."* — `NotebookSearch.tsx` (Jupyter has
   none).

7. **One-tap focus.** Click the full-width toggle → the notebook breathes.
   *Caption: "Your screen, your layout."* — per-notebook full-width
   (`Notebook.tsx`).

**Act theme card:** *"Everything Jupyter does — just nicer."*

---

## ACT 2 — Never lose work (1:05–1:35)

The trust-builder. Make undo feel like a superpower.

1. **Infinite undo with a memory.** Delete a cell, mangle another, then `⌘Z`
   `⌘Z` `⌘Z` — each undo **pulses the affected cell blue** and scrolls
   it into view. *Caption: "Undo anything. Watch it happen."* — dual undo
   (per-cell text + structural) + visual feedback (`useUndoRedo.ts`,
   `Notebook.tsx`).

2. **Time travel.** Open the **History** panel (status bar) → operations grouped
   by time. Click one three steps back → the notebook **previews that moment**
   with diff highlighting (orange = changed, red = deleted). Click **Restore
   Here**. *Caption: "Scrub through your entire edit history."* —
   `HistoryPanel.tsx`, time-travel preview, `RestoreDialog.tsx`.

3. **Always saved.** Pan to the status bar: *"Saved 12s ago."* *Caption:
   "Autosave that knows when the file changed underneath you."* — autosave +
   mtime conflict detection (`useAutosave.ts`, `useConflictResolution.ts`).

**Act theme card:** *"Your work, on a timeline."*

---

## ACT 3 — The agent is the IDE (1:35–2:35) — THE CORE

The payoff. Slow down here; this is the reason to switch.

1. **A cell breaks.** Notebook B: a cell errors red. A **"Fix with agent"**
   button sits on the error. Click it. *Caption: "One click."* — `Cell.tsx`.

2. **The agent wakes up — already briefed.** The Agent terminal slides up; the
   **Claude Code** launch chip fires; the bootstrap prompt is visible — it
   already knows the server (`:3000`) and *which notebook*. *Caption: "It knows
   where it is."* — bootstrap prompt + launch chips (`agentTerminalService.ts`,
   `TerminalPanel.tsx`).

3. **It fixes it live.** Claude calls the MCP tools — `read_notebook`,
   `update_cell`, `execute_cell` — the cell content rewrites **in the UI**, the
   output turns green, a **purple ring** marks the touched cell. *Caption: "It
   reads, edits, and re-runs — and you watch it happen."* — MCP tool suite
   (`packages/mcp/src/tools/`), live UI routing (`useOperationHandler.ts`).

4. **THE MONEY SHOT — you both edit at once.** While the agent reindents cell 5,
   the presenter **keeps editing cell 2**. Both land. Then the presenter edits
   the *same* cell the agent is working on → the agent gets a **conflict, with
   your current content**, re-reads, applies its change *on top of your edit*,
   and retries. A soft blue toast — not a red error. *Caption: "Edit the same
   notebook. Nothing gets clobbered."* — optimistic concurrency + self-healing
   conflicts (`operation-router.ts`). **This is the single most important shot in
   the film.**

5. **It survives a refresh.** Hit `⌘R` mid-session. The terminal reattaches, the
   agent is still running, scrollback intact. *Caption: "Your agent survives a
   refresh."* — named reattaching ptys (`TerminalPanel.tsx`).

6. **Talk to it about any cell.** Hover a cell → **Send to agent** → type "add a
   docstring and type hints" → it's injected with the cell's context. *Caption:
   "Point at anything. Ask in plain English."* — per-cell prompts (`Cell.tsx`).

**Act theme card:** *"Not autocomplete. A collaborator."**

---

## ACT 4 — Works with your setup (2:35–2:55)

Knock down the two adoption objections: "will it run with my Python?" and "I hate
.ipynb in git."

1. **Whatever Python you have.** Open the kernel menu → it has **detected your
   environments** (conda / venv / uv / pixi / Homebrew / system), one-click
   **Register** where `ipykernel` exists, and an exact copy-paste command where
   it doesn't — including the PEP 668 "externally managed" case. *Caption:
   "It meets your environment where it is."* — detect-and-guide onboarding
   (`discovery-service.ts`).

2. **Git-friendly notebooks.** `+` menu → **Quarto notebook (.qmd)** / **Python
   notebook (.py)**. Show a side-by-side: the `.py` percent file is clean,
   readable text; the equivalent `.ipynb` is a JSON blob. A one-line code change
   = a one-line diff. *Caption: "Notebooks your git history will thank you for."*
   — text formats, outputs never serialized (`notebook-formats/`).

3. **Kernels that don't flinch.** Restart the dev server on camera → the kernel
   **reattaches**, execution state preserved. *Caption: "Restart the server.
   Keep your kernel."* — `NEBULA_PRESERVE_KERNELS` / reattach
   (`kernel-service.ts`).

---

## ACT 4½ — One more thing (2:55–3:12)

The film feels finished — then the capstone. The *same* notebook, now on a compute
cluster, with no batch script and no SSH tunnel. Play it as a reveal: a beat of
quiet, then the menu.

| | |
|---|---|
| **On screen** | Kernel menu → **Server** section → **+ New compute allocation**. A modal opens next to a **live cluster-load panel**: partitions and QoS filtered to only what this account may actually submit to, each row showing idle CPUs, idle GPUs **by type**, and queue backlog (your own jobs called out). A recommendation banner points at the queue you'll land on soonest. Set CPUs / memory / GPUs / walltime; choose a GPU queue → the GPU-type list narrows to the models that queue really has. **Submit.** The allocation drops into the Server list as **"Queued · waiting…"** (live elapsed), then turns into a green online server the moment the job starts. Pick it, run a cell — `!hostname` prints the compute node, `nvidia-smi` shows the card. Same notebook, same agent, same history — now on a cluster node. |
| **Caption** | *"One more thing — it runs where your compute lives."* |
| **Why it lands** | The whole HPC ritual — write an sbatch script, queue, find the node, forward a port, point Jupyter at it — collapses into one menu entry. And it's **detection-gated**: invisible unless a scheduler is present, so nothing changes for laptop users. One allocation hosts *many* kernels — queue once, run several notebooks in it. |
| **Features** | scheduler-backed allocations (`scheduler/SlurmScheduler`, `allocation-service.ts`); allowed-partition/QoS + GPU-type-by-queue picker with a live capacity-based load monitor and soonest-queue recommendation (`ComputeAllocationModal.tsx`, `ComputeDashboardCard.tsx`); browser⇄compute-node kernels proxied over WS, ZeroMQ never crossing the network (`kernel-proxy.ts`). Full design in [`SLURM_COMPUTE.md`](./SLURM_COMPUTE.md). |

**Shooting note:** this beat needs a **live scheduler** — capture it presenter-driven
against a real SLURM login node (like the authentic option in Act 3). Off-cluster the
feature is hidden by design, so there's nothing to mock; don't fake it.

---

## ACT 5 — Get started (3:12–3:22)

| | |
|---|---|
| **On screen** | A terminal. Two commands typed: `npx nebula-notebook` then `npx nebula-notebook-mcp setup-mcp`. Cut to the hero image. |
| **Caption** | *"Two commands. Your notebook, and your agent."* |
| **End card** | Logo + `github.com/jzhoulab/nebula-notebook`. |

---

## B-roll pool (insert as needed; cut for time)

Delighters that didn't make the main cut but strengthen any slow beat:

- **Resource status bar** — live RAM / GPU temp in the footer.
- **Per-notebook favicon avatars** — every notebook gets a deterministic colored icon; the browser tab matches.
- **Output collapse + drag-resize** — pull the bottom edge of a tall output; the height persists (and is undoable).
- **FIFO cell queue** — `e` to enqueue a cell, `d` to dequeue elsewhere (move blocks around fast).
- **Indentation auto-detect** — opens a 2-space file as 2-space without asking.
- **Keyboard help modal** (`⌘?`) — every shortcut, grouped.
- **Isolated HTML output** — a notebook's sloppy `position:fixed` HTML stays sandboxed in an iframe instead of hijacking the page.
- **Cell stats** — live code/markdown/total counts in the status bar.
- **Headless agent** — close the browser entirely; an agent on your laptop keeps editing the file; reopen and the work is there.
- **`.py` notebook discrimination** — a marker-bearing script offers "open as notebook"; a plain script opens as text and is never silently converted.

---

## Recording approach

**Recommended: hybrid.** The agent/collaboration beats (Act 3) need a live
`claude` CLI and human choreography — those should be **screen-recorded** by a
presenter following the script above (QuickTime / OBS, 1080p+, cursor
highlighting on). The deterministic UI delighters (Acts 1, 2, 4) can be captured
either the same way or **automated**: drive Chrome against `:3000` via the
browser-automation tools and capture each scene as a GIF (`gif_creator`) — useful
for crisp, repeatable README clips even if the final film is a single screen
recording.

**Music/pacing:** Acts 1–2 fast and rhythmic; Act 3 slows ~30% for the money
shot; Act 4½ is a beat of quiet, then the reveal; Act 5 resolves. Target ~3:20 total.

**Distribution:** the README hero SVG already exists; embed the money-shot GIF
(Act 3, scene 4) near the top of the README, link the full film, and reuse Act-1
GIFs inline next to the Highlights bullets. The Act-4½ compute capstone gets its
own clip next to the cluster/scheduler section of the README.
