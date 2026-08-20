/**
 * Shared CLI plumbing: exit codes, flag parsing, server URL resolution,
 * session-state persistence, and output helpers.
 *
 * The CLI is a thin layer over the shared NebulaClient / tools code (the same
 * code the MCP server uses) — nothing in here talks HTTP directly.
 */

import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { NebulaClient } from '../notebook/client.js';

// =============================================================================
// Exit codes
// =============================================================================

export const EXIT = {
  OK: 0,
  /** Generic failure */
  ERROR: 1,
  /** Usage / configuration error (bad flags, missing NEBULA_URL, …) */
  USAGE: 2,
  /** Kernel dead or not found */
  KERNEL: 7,
  /** Optimistic-concurrency conflict (cell changed since last read) */
  CONFLICT: 9,
  /** Execution still running when --max-wait expired (not an error) */
  RUNNING: 3,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number = EXIT.ERROR,
    readonly hintText?: string
  ) {
    super(message);
    this.name = 'CliError';
  }
}

// =============================================================================
// Flag parsing (node:util parseArgs — zero extra deps)
// =============================================================================

export interface ParsedArgs {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

type FlagSpec = Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }>;

/** Flags accepted by every command. */
const COMMON_FLAGS: FlagSpec = {
  url: { type: 'string' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

export function parse(argv: string[], flags: FlagSpec = {}): ParsedArgs {
  const options = { ...COMMON_FLAGS, ...flags };

  // parseArgs rejects `--index -1` as ambiguous; fold negative-number values
  // of string flags into `--index=-1` form before parsing.
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.startsWith('--') ? arg.slice(2) : undefined;
    const next = argv[i + 1];
    if (name && options[name]?.type === 'string' && next !== undefined && /^-\d/.test(next)) {
      args.push(`${arg}=${next}`);
      i += 1;
    } else {
      args.push(arg);
    }
  }

  try {
    const { values, positionals } = parseArgs({
      args,
      options,
      allowPositionals: true,
      strict: true,
    });
    return { values: values as ParsedArgs['values'], positionals };
  } catch (e) {
    throw new CliError(
      e instanceof Error ? e.message : String(e),
      EXIT.USAGE,
      "run the command with --help for usage"
    );
  }
}

export function requirePositional(positionals: string[], index: number, name: string, usage: string): string {
  const value = positionals[index];
  if (!value) {
    throw new CliError(`missing <${name}>`, EXIT.USAGE, `usage: ${usage}`);
  }
  return value;
}

// =============================================================================
// Server URL resolution: --url flag > NEBULA_URL env > error
// =============================================================================

export function resolveUrl(flagUrl: unknown): string {
  const url = (typeof flagUrl === 'string' && flagUrl) || process.env.NEBULA_URL;
  if (!url) {
    throw new CliError(
      'no Nebula server URL configured',
      EXIT.USAGE,
      'pass --url http://localhost:8000 or export NEBULA_URL=http://localhost:8000'
    );
  }
  return url.replace(/\/+$/, '');
}

// =============================================================================
// Session state (shared agent lock across CLI invocations)
// =============================================================================

export interface CliSessionState {
  url: string;
  path: string;
  agentId: string;
  name?: string;
  startedAt: number;
}

function stateDir(): string {
  return process.env.NEBULA_STATE_DIR || path.join(os.homedir(), '.nebula');
}

/** State file is keyed by hash(url + notebook path) so invocations share the lock. */
export function sessionFilePath(url: string, notebookPath: string): string {
  const key = createHash('sha256').update(`${url}\n${notebookPath}`).digest('hex').slice(0, 16);
  return path.join(stateDir(), `cli-session-${key}.json`);
}

export function loadSessionState(url: string, notebookPath: string): CliSessionState | null {
  try {
    const raw = fs.readFileSync(sessionFilePath(url, notebookPath), 'utf-8');
    const parsed = JSON.parse(raw) as CliSessionState;
    return typeof parsed.agentId === 'string' && parsed.agentId ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSessionState(state: CliSessionState): string {
  const file = sessionFilePath(state.url, state.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  return file;
}

export function clearSessionState(url: string, notebookPath: string): void {
  fs.rmSync(sessionFilePath(url, notebookPath), { force: true });
}

export function newAgentId(): string {
  return `nebula-cli-${randomBytes(4).toString('hex')}`;
}

/**
 * Build a NebulaClient for a command. If a CLI session exists for this
 * url+notebook, its agent token is attached automatically so the invocation
 * shares the agent lock started by `nebula session start`.
 */
/**
 * Explicit credential for the CLI, in precedence order: NEBULA_TOKEN,
 * NEBULA_TOKEN_FILE, then $NEBULA_STATE_DIR/token (default ~/.nebula/token —
 * where Nebula pushes a token when it launches an agent on your machine).
 * undefined = none configured; the server may still accept the request via
 * its loopback piggyback when the tunnel terminates on the server host.
 */
export function resolveAuthToken(): string | undefined {
  const fromEnv = process.env.NEBULA_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const candidates = [process.env.NEBULA_TOKEN_FILE, path.join(stateDir(), 'token')];
  for (const file of candidates) {
    if (!file) continue;
    try {
      const value = fs.readFileSync(file, 'utf-8').trim();
      if (value) return value;
    } catch {
      /* absent — try the next source */
    }
  }
  return undefined;
}

export function makeClient(url: string, notebookPath?: string): NebulaClient {
  const session = notebookPath ? loadSessionState(url, notebookPath) : null;
  return new NebulaClient({
    baseUrl: url,
    token: resolveAuthToken(),
    // stderr, so --json stdout stays parseable.
    onNotice: (n) => console.error(n),
    agentId: session?.agentId,
    clientName: session?.name ?? 'nebula-cli',
    // Sessions are explicit in the CLI (nebula session start/end).
    autoStartAgentSession: false,
  });
}

// =============================================================================
// Content input: --content <str> | --content-file <f> | "-" (stdin)
// =============================================================================

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function resolveContentInput(
  content: unknown,
  contentFile: unknown,
  stdinMarker: boolean
): Promise<string> {
  const provided = [content !== undefined, contentFile !== undefined, stdinMarker].filter(Boolean);
  if (provided.length !== 1) {
    throw new CliError(
      'provide exactly one of --content <str>, --content-file <file>, or - (stdin)',
      EXIT.USAGE
    );
  }
  if (typeof content === 'string') {
    return content;
  }
  if (typeof contentFile === 'string') {
    try {
      return fs.readFileSync(contentFile, 'utf-8');
    } catch (e) {
      throw new CliError(
        `cannot read --content-file ${contentFile}: ${e instanceof Error ? e.message : String(e)}`,
        EXIT.USAGE
      );
    }
  }
  return readStdin();
}

// =============================================================================
// Output helpers
// =============================================================================

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/** At most one contextual next-step hint per command (AXI); suppressed by --quiet/--json. */
export function printHint(text: string, values: ParsedArgs['values']): void {
  if (!values.quiet && !values.json) {
    console.log(`hint: ${text}`);
  }
}

export function firstLineOf(content: string, max = 80): string {
  const lines = content.split('\n');
  let first = lines[0];
  let truncated = lines.length > 1;
  if (first.length > max) {
    first = first.slice(0, max);
    truncated = true;
  }
  return truncated ? `${first}…` : first;
}

export function tailLines(text: string, n: number): string[] {
  const lines = text.replace(/\n$/, '').split('\n');
  return lines.slice(Math.max(0, lines.length - n));
}

export function parseIntFlag(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(String(value), 10);
  if (Number.isNaN(n)) {
    throw new CliError(`${name} must be an integer, got "${String(value)}"`, EXIT.USAGE);
  }
  return n;
}

/** Map an operation error message to a CliError with the right exit code/hint. */
export function toCliError(message: string | undefined, notebookPath?: string): CliError {
  // Server/client errors sometimes arrive already prefixed with "Error: "; the CLI
  // printer adds its own "error: ", so strip a redundant leading "Error:" to avoid
  // the doubled "error: Error: ..." prefix.
  const msg = (message || 'operation failed').replace(/^Error:\s*/i, '');
  if (/API error 401/.test(msg)) {
    // Surface the server's own diagnosis (it names the peer / the missing
    // credential source) and say what a CLI caller can actually do about it.
    return new CliError(
      msg,
      EXIT.ERROR,
      'authenticate this client: set NEBULA_TOKEN (or ~/.nebula/token) to a Nebula session token — ' +
      'relaunching the agent from Nebula pushes one; a token-less client is only accepted when its tunnel terminates on the server host'
    );
  }
  if (/NEBULA_ARM64_NODE_BIN/.test(msg)) {
    // Cross-arch refusal at submit: hand the user the agent-executable fix.
    return new CliError(msg, EXIT.ERROR, 'get an agent-ready setup guide with: nebula compute arm-setup');
  }
  if (/agent session required/i.test(msg)) {
    return new CliError(msg, EXIT.ERROR, `start one with: nebula session start ${notebookPath ?? '<path>'}`);
  }
  if (/kernel session not found|no kernel|kernel .*dead/i.test(msg)) {
    return new CliError(msg, EXIT.KERNEL);
  }
  return new CliError(msg, EXIT.ERROR);
}
