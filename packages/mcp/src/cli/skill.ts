/**
 * `nebula setup-skill` — install a Claude Code Agent Skill that teaches
 * agents launched OUTSIDE Nebula terminals (plain shells, SSH sessions, other
 * projects) how to drive notebooks with this CLI. Inside Nebula terminals the
 * bootstrap prompt + PATH injection already cover this; the skill closes the
 * gap everywhere else.
 *
 * The skill content is embedded here (single source of truth) so `npx
 * nebula-notebook-mcp` installs work without file-resolution games.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { CliError, EXIT } from './shared.js';

const SKILL_MD = `---
name: nebula-notebook
description: Drive Jupyter-style notebooks (.ipynb/.qmd/.py percent) on a Nebula Notebook server with the \`nebula\` CLI — read/edit/insert/delete cells, execute with output in one call, search, manage kernels. Use when the user asks to work on a notebook served by Nebula (a NEBULA_URL / localhost:3000 notebook server), run or fix notebook cells, or inspect notebook outputs.
---

# Nebula Notebook CLI

Work with notebooks on a running Nebula server via the \`nebula\` CLI.

## Connect (do this first — it depends on where you are running)

Find the server URL, in this order:

1. **\`NEBULA_URL\` already set?** (\`echo $NEBULA_URL\`) — you are likely inside a
   Nebula terminal; everything is pre-wired. Verify: \`curl -s $NEBULA_URL/api/health\`.
2. **Same machine as the server?** Try \`curl -s http://localhost:3000/api/health\`
   — if it answers \`{"status":"ok"...}\`, use \`export NEBULA_URL=http://localhost:3000\`.
3. **Server is remote (common on HPC: it runs on a login node).** Two cases —
   ASK THE USER which applies; do not guess:
   - a tunnel is already forwarded (they browse Nebula at \`http://localhost:3000\`
     on this machine) → step 2 will have worked;
   - no tunnel yet → ask the user to run one, e.g.
     \`ssh -L 3000:<server-host>:3000 <cluster>\`, or to give you a directly
     reachable URL. The right URL is whatever THEY open the Nebula UI at.
4. Health check fails everywhere → tell the user the server looks down and ask
   how they normally start/reach it (\`npx nebula-notebook\` locally).

Notebook paths in commands are paths on the SERVER's filesystem (ask the user
or find them via the UI/file browser if unsure — they are usually absolute).

If \`nebula\` is not on PATH, it ships in the \`nebula-notebook-mcp\` npm package —
no separate install needed, just prefix every command with npx (it fetches the
package on first use and caches it): \`npx -p nebula-notebook-mcp nebula …\`. To
avoid the per-call npx overhead, install it once: \`npm i -g nebula-notebook-mcp\`
(then \`nebula …\` works directly). From a Nebula repo checkout you can also run
\`<repo>/packages/mcp/bin/nebula\`.

## Commands

\`\`\`bash
nebula nb read <path>                    # list cells: #idx id type [n] first-line
nebula nb read <path> --cells 3-8 --outputs --full
nebula run <path> <cell-id> --tail 40    # execute AND print output tail in one call
nebula nb edit <path> <cell-id> -   # content from stdin (bare '-'); or --content '...' / --content-file <f>
#   ^ writes cell source DIRECTLY. Never ferry source through the kernel (base64/chunked prints, helper cells).
nebula nb insert <path> --index N --content '...' [--type markdown] [--id my-id]
nebula nb delete <path> <cell-id>
nebula nb search <path> <query> --limit 5
nebula nb create <path> [--kernel ir]    # new notebook (agent-permitted by default)
nebula nb move <path> <cell-id> --to 0   # reorder (or --after <cell-id>)
nebula nb duplicate <path> <cell-id>
nebula nb clear-outputs <path> [--cells id,id]
nebula nb meta <path> <cell-id> --set type=markdown
nebula kernel ls                         # available kernels on the server
nebula kernel status|start|stop|restart|interrupt <path>
nebula session start <path>              # hold the agent edit lock (persists across invocations)
nebula session end <path>
nebula compute status|queues|alloc|ls|use|cancel   # cluster compute (see below)
nebula fs ls|cat|write|rm|mv|download|upload       # SERVER files — remote agents only;
                                                   # in a Nebula terminal use the shell
\`\`\`

All commands accept \`--json\` (raw) and \`--quiet\` (no hint line).
Notebook paths are absolute paths on the SERVER's filesystem.

## Long-running cells — no polling

\`nebula run\` BLOCKS until the cell finishes (it follows the execution
internally). So for anything that might take a while, **launch it as a
background shell task and move on** — the process exiting IS the completion
signal; you will be notified. Never write your own poll loop.

\`\`\`bash
nebula run <path> train-cell --max-wait 0 --tail 60   # run in background; 0 = wait however long it takes
\`\`\`

Exit codes tell you what happened: 0 done-ok · 1 cell errored (traceback in the
tail) · 3 still running when --max-wait expired. \`--no-wait\` exists for true
fire-and-forget (check later with \`nebula nb read --outputs\`).

## Cluster compute (optional)

Some Nebula servers sit on HPC clusters and can run notebook kernels on
scheduler-backed compute allocations. The feature is detection-gated — absent
on laptops/plain servers — so **check \`nebula compute status\` first**; if it
says no scheduler, skip this section entirely (kernels run on the server).

Typical flow:

\`\`\`bash
nebula compute status                                  # scheduler present?
nebula compute queues                                  # partitions, idle CPUs/GPUs, backlog
nebula compute alloc --partition gpu --gpus 1 --walltime 2 --idle-timeout 60 --wait   # background task; blocks until active
nebula compute use <alloc-id> <notebook.ipynb>         # bind the notebook's kernels to it
nebula run <notebook.ipynb> <cell-id>                  # now executes on the allocation
nebula compute cancel <alloc-id>                       # when the task is done
\`\`\`

\`alloc --wait\` follows the queue internally (like \`nebula run\`): launch it
as a background shell task and the process exit is the signal — never write
your own poll loop.

Etiquette — allocations consume real cluster resources:

- Request modest resources: only the CPUs/GPUs/memory/walltime the task needs.
- Add \`--idle-timeout 60\` to allocations you create: the allocation ends
  itself after 60 idle minutes (no kernel/terminal activity), so a forgotten
  allocation never squats on GPUs.
- Cancel allocations you created as soon as the task completes (the idle
  timeout is a safety net, not a substitute).
- NEVER cancel allocations you did not create (\`nebula compute ls\` shows all).

## Rules

- **Read before editing.** Edits are OCC-checked against what you last read.
- **Exit code 9 = edit conflict**: the cell changed (usually the user typing).
  The current content is printed — re-apply your change against it and retry.
  This is normal collaboration, not an error.
- **Exit code 7** = no kernel session; \`nebula run\` starts one automatically.
- Prefer \`nebula run\` over edit-then-hope: it executes and returns status,
  execution_count, and the output tail in a single call.
- For multi-edit work, \`nebula session start\` first (shows the user a purple
  "agent session" badge and locks out conflicting edits), \`session end\` when done.
- Pipe freely: \`nebula nb read <path> --full | grep -n pattern\` filters
  before output reaches your context.
`;

export async function cmdSetupSkill(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'boolean', default: false },
      dir: { type: 'string' },
      print: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      quiet: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`nebula setup-skill — install the Claude Code skill for this CLI

Teaches agents in plain terminals (outside Nebula) when and how to use nebula.

  nebula setup-skill              # → ~/.claude/skills/nebula-notebook/SKILL.md (all projects)
  nebula setup-skill --project    # → ./.claude/skills/nebula-notebook/SKILL.md (this repo)
  nebula setup-skill --dir <d>    # → <d>/nebula-notebook/SKILL.md
  nebula setup-skill --print      # print the skill to stdout instead`);
    return EXIT.OK;
  }

  if (values.print) {
    process.stdout.write(SKILL_MD);
    return EXIT.OK;
  }

  const baseDir = values.dir
    ? path.resolve(values.dir)
    : values.project
      ? path.join(process.cwd(), '.claude', 'skills')
      : path.join(os.homedir(), '.claude', 'skills');

  const skillDir = path.join(baseDir, 'nebula-notebook');
  const skillPath = path.join(skillDir, 'SKILL.md');

  try {
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillPath, SKILL_MD, 'utf-8');
  } catch (err) {
    throw new CliError(
      `failed to write skill: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.ERROR,
      'check permissions, or use --dir / --print'
    );
  }

  console.log(`installed: ${skillPath}`);
  if (!values.quiet) {
    console.log('hint: new Claude Code sessions will discover it automatically; set NEBULA_URL in shells where agents run');
  }
  return EXIT.OK;
}
