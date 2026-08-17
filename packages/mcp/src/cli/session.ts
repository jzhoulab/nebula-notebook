/**
 * `nebula session …` — agent-lock sessions.
 *
 * `session start` acquires the agent lock via the shared client and persists
 * the agent token to $NEBULA_STATE_DIR (or ~/.nebula), keyed by hash of
 * url+path, so separate CLI invocations share the same lock. Other commands
 * attach the token automatically (see makeClient in shared.ts).
 */

import { NebulaClient } from '../notebook/client.js';
import {
  CliError,
  EXIT,
  clearSessionState,
  loadSessionState,
  newAgentId,
  parse,
  printHint,
  printJson,
  requirePositional,
  resolveAuthToken,
  resolveUrl,
  saveSessionState,
} from './shared.js';

const SESSION_HELP = `usage: nebula session start <path> [--name NAME] [--exclusive]
       nebula session end <path>

Holds/releases the agent lock for a notebook. The session token is stored in
$NEBULA_STATE_DIR (default ~/.nebula), so every later nebula invocation for
the same server+notebook automatically carries the lock until 'session end'.
--exclusive locks out concurrent user edits (required by destructive
operations like 'nb clear').

examples:
  nebula session start analysis.ipynb --name refactor-bot
  nebula nb edit analysis.ipynb cell-3 --content 'x = 1'   # uses the lock
  nebula session end analysis.ipynb`;

export async function cmdSession(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'start':
      return sessionStart(rest);
    case 'end':
      return sessionEnd(rest);
    case undefined:
    case '--help':
    case '-h':
      console.log(SESSION_HELP);
      return sub === undefined ? EXIT.USAGE : EXIT.OK;
    default:
      throw new CliError(`unknown session subcommand: ${sub}`, EXIT.USAGE, "run 'nebula session --help' for usage");
  }
}

async function sessionStart(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    name: { type: 'string' },
    exclusive: { type: 'boolean' },
  });
  if (values.help) {
    console.log(SESSION_HELP);
    return EXIT.OK;
  }
  const nbPath = requirePositional(positionals, 0, 'path', 'nebula session start <path> [--name NAME] [--exclusive]');
  const url = resolveUrl(values.url);
  const name = values.name as string | undefined;

  // Reuse an existing token for this url+path so a re-start keeps the identity.
  const existing = loadSessionState(url, nbPath);
  const agentId = existing?.agentId ?? newAgentId();

  const client = new NebulaClient({
    token: resolveAuthToken(),
    baseUrl: url,
    agentId,
    clientName: name ?? 'nebula-cli',
    autoStartAgentSession: false,
  });

  const result = await client.startAgentSession(nbPath, agentId, undefined, undefined, Boolean(values.exclusive) || undefined);
  if (!result.success) {
    throw new CliError(result.error ?? 'failed to start session', EXIT.ERROR);
  }

  const stateFile = saveSessionState({
    url,
    path: nbPath,
    agentId,
    name,
    startedAt: Date.now(),
  });

  if (values.json) {
    printJson({ path: nbPath, agentId, stateFile, warning: result.data?.warning });
    return EXIT.OK;
  }
  console.log(`session started for ${nbPath} (agent ${agentId})`);
  if (result.data?.warning) {
    console.log(`warning: ${result.data.warning}`);
  }
  printHint(`later invocations reuse this lock; release it with: nebula session end ${nbPath}`, values);
  return EXIT.OK;
}

async function sessionEnd(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv);
  if (values.help) {
    console.log(SESSION_HELP);
    return EXIT.OK;
  }
  const nbPath = requirePositional(positionals, 0, 'path', 'nebula session end <path>');
  const url = resolveUrl(values.url);

  const existing = loadSessionState(url, nbPath);
  if (!existing) {
    throw new CliError(
      `no CLI session for ${nbPath}`,
      EXIT.ERROR,
      `start one with: nebula session start ${nbPath}`
    );
  }

  const client = new NebulaClient({
    token: resolveAuthToken(),
    baseUrl: url,
    agentId: existing.agentId,
    clientName: existing.name ?? 'nebula-cli',
    autoStartAgentSession: false,
  });

  const result = await client.endAgentSession(nbPath);
  if (!result.success) {
    // Keep the state file so the user can retry ending the session.
    throw new CliError(result.error ?? 'failed to end session', EXIT.ERROR);
  }
  clearSessionState(url, nbPath);

  if (values.json) {
    printJson({ path: nbPath, ended: true, sessionDuration: result.data?.sessionDuration });
    return EXIT.OK;
  }
  const duration = result.data?.sessionDuration;
  console.log(duration !== undefined ? `session ended (${Math.round(duration / 1000)}s)` : 'session ended');
  printHint(`reads still work without a session; start a new one with: nebula session start ${nbPath}`, values);
  return EXIT.OK;
}
