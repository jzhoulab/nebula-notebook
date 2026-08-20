/**
 * `nebula context` — which notebook is the user looking at right now?
 *
 * Agents launched from Nebula get NEBULA_AGENT_TERMINAL in their environment;
 * the browser reports the viewed notebook per agent terminal (switch + tab
 * focus). Use this when an instruction says "this notebook / this cell"
 * without a path — the answer changes as the user moves between tabs.
 * Fails LOUD when nothing was reported: guessing edits the wrong file.
 */

import { CliError, EXIT, makeClient, parse, printHint, printJson, resolveUrl } from './shared.js';

export async function cmdContext(argv: string[]): Promise<number> {
  const { values } = parse(argv);
  if (values.help) {
    console.log(`usage: nebula context

Prints the notebook the user is currently viewing (their "driving" notebook
for this agent terminal). Requires NEBULA_AGENT_TERMINAL in the environment —
Nebula sets it when it launches an agent. Exit 1 when unknown: ask the user
instead of guessing.`);
    return EXIT.OK;
  }

  const terminal = process.env.NEBULA_AGENT_TERMINAL?.trim();
  if (!terminal) {
    throw new CliError(
      'NEBULA_AGENT_TERMINAL is not set — this shell was not launched by Nebula as an agent terminal',
      EXIT.ERROR,
      'ask the user which notebook they mean, or pass explicit paths'
    );
  }

  const client = makeClient(resolveUrl(values.url));
  const result = await client.getDrivingNotebook(terminal);
  if (!result.success) throw new CliError(result.error || 'context lookup failed', EXIT.ERROR);

  const { notebook, at } = result.data!;
  if (!notebook) {
    throw new CliError(
      'no driving notebook reported yet for this agent terminal',
      EXIT.ERROR,
      'the browser reports it when the user views a notebook — ask the user which notebook they mean'
    );
  }
  if (values.json) {
    printJson({ notebook, at });
    return EXIT.OK;
  }
  console.log(notebook);
  if (at) {
    const s = Math.max(1, Math.round((Date.now() - at) / 1000));
    printHint(`the user has been viewing this for ${s < 90 ? `${s}s` : `${Math.round(s / 60)}m`} — it changes as they switch notebooks/tabs`, values);
  }
  return EXIT.OK;
}
