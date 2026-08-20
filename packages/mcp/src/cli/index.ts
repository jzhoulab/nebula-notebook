/**
 * nebula — agent-facing CLI for Nebula Notebook.
 *
 * A thin layer over the shared NebulaClient / tools code (the same code the
 * MCP server uses). Design follows AXI (https://axi.md): compact plain-text
 * output, combined operations, one contextual hint per command, --json for
 * raw output, distinct exit codes.
 *
 * Exit codes: 0 ok · 1 error · 2 usage · 7 kernel dead/not-found · 9 OCC conflict
 */

import { CliError, EXIT } from './shared.js';
import { cmdNb } from './nb.js';
import { cmdRun } from './run.js';
import { cmdKernel } from './kernel.js';
import { cmdSession } from './session.js';
import { cmdCompute } from './compute.js';
import { cmdFs } from './fs.js';
import { cmdSetupSkill } from './skill.js';
import { cmdContext } from './context.js';

const ROOT_HELP = `nebula — work with notebooks on a running Nebula server

Server URL required: --url <url> on any command, or export NEBULA_URL.
Not installed? npx -p nebula-notebook-mcp nebula …  (or: npm i -g nebula-notebook-mcp)

usage: nebula <command> …

  nb read|edit|insert|delete|search <path> …
                                 cells: read/OCC-checked edit (conflict → exit 9)/
                                 insert/delete/search — see 'nebula nb --help'
  nb create|move|duplicate|clear-outputs|clear|meta <path> …
                                 create notebooks, reorder/copy cells, outputs, metadata
  run <path> <cell-id>           execute a cell + print output tail (--tail)
  kernel ls                      available kernels on the server
  kernel status|start|stop|restart|interrupt <path>
  session start|end <path>       hold/release the agent lock across invocations
  context                        the notebook the user is viewing NOW (never guess "this notebook")
  compute status|queues|alloc|ls|use|cancel
                                 cluster compute allocations (HPC; optional)
  fs ls|cat|write|rm|mv|download|upload
                                 SERVER files (remote agents; in a Nebula terminal use the shell)
  setup-skill                    install the Claude Code skill (for agents outside Nebula terminals)

Every command accepts --json (raw output) and --quiet (no hint line).
Run 'nebula <command> --help' for examples.`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(ROOT_HELP);
    return EXIT.OK;
  }

  switch (cmd) {
    case 'nb':
      return cmdNb(rest);
    case 'run':
      return cmdRun(rest);
    case 'kernel':
      return cmdKernel(rest);
    case 'session':
      return cmdSession(rest);
    case 'compute':
      return cmdCompute(rest);
    case 'fs':
      return cmdFs(rest);
    case 'context':
      return cmdContext(rest);
    case 'setup-skill':
      return cmdSetupSkill(rest);
    default:
      throw new CliError(`unknown command: ${cmd}`, EXIT.USAGE, "run 'nebula --help' for the command list");
  }
}

/** Exit only after stdout/stderr are flushed (they can be async on pipes). */
function finish(code: number): void {
  let pending = 2;
  const done = () => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
}

main(process.argv.slice(2))
  .then(finish)
  .catch((e: unknown) => {
    if (e instanceof CliError) {
      console.error(`error: ${e.message}`);
      if (e.hintText) console.error(`hint: ${e.hintText}`);
      finish(e.code);
    } else {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      finish(EXIT.ERROR);
    }
  });
