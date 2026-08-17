/**
 * Finding out who the user is on their OWN machine, so remote-agent mode
 * doesn't have to ask.
 *
 * The reverse tunnel already reaches the user's sshd; once their key is
 * authorized, `whoami` over it answers the question exactly. The only guess is
 * which login to attempt, and the server's own username is both the common
 * answer and precisely what a bare `ssh localhost` would try.
 */

import { execFile, spawn } from 'child_process';
import * as os from 'os';

/** POSIX-portable login names — anything else never reaches an ssh argument. */
const LOGIN_RE = /^[A-Za-z0-9._-]+$/;

/** Logins worth trying, best first: an explicit hint, then the server's own. */
export function candidateUsernames(serverUser: string, hint?: string): string[] {
  const out: string[] = [];
  for (const candidate of [hint, serverUser]) {
    const value = (candidate ?? '').trim();
    if (!value || !LOGIN_RE.test(value) || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

/** The login reported by the remote `whoami`, or null if nothing usable came back. */
export function parseWhoami(stdout: string): string | null {
  const line = stdout.split('\n').find((l) => l.startsWith('NB_USER='));
  const value = line ? line.slice('NB_USER='.length).trim() : '';
  return value && LOGIN_RE.test(value) ? value : null;
}

function sshWhoami(port: number, user: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      'ssh',
      ['-p', String(port), '-o', 'ProxyCommand=none', '-o', 'StrictHostKeyChecking=accept-new',
       // BatchMode: never hang on a password prompt — key auth or nothing.
       '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `${user}@localhost`,
       'printf "NB_USER=%s\\n" "$(whoami)"'],
      { timeout: timeoutMs },
      (err, stdout) => resolve(err ? null : parseWhoami(String(stdout))),
    );
    child.on('error', () => resolve(null));
  });
}

/**
 * Try each candidate login over the reverse channel and return the first that
 * authenticates, as the remote host itself reports it. null = nobody answered
 * (tunnel down, key not authorized yet, or a different login) — the caller
 * must then ask, and say plainly that this is what it needs.
 */
export async function discoverRemoteUser(port: number, hint?: string): Promise<string | null> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  let serverUser = '';
  try { serverUser = os.userInfo().username; } catch { /* no passwd entry — hint only */ }
  for (const candidate of candidateUsernames(serverUser, hint)) {
    const found = await sshWhoami(port, candidate, 12000);
    if (found) return found;
  }
  return null;
}

/** Where the pushed token lives on the user's machine ($HOME-relative). */
export const REMOTE_TOKEN_PATH = '.nebula/token';

/**
 * Deliver an auth token to the user's machine over the reverse channel so the
 * remote agent's `nebula` CLI authenticates with a real credential — instead
 * of relying on the loopback piggyback, which silently dies the moment its
 * tunnel terminates on a different host than the server (2026-08-17).
 *
 * The token travels on ssh's STDIN only: never in argv (visible in `ps` and
 * shell history on a shared login node), never echoed. Written 0600 under a
 * private dir, atomically, and acknowledged with a marker so a half-written
 * or missing file is reported as failure, not success.
 */
export function pushRemoteAgentToken(port: number, user: string, token: string, timeoutMs = 12000): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return Promise.resolve(false);
  if (!LOGIN_RE.test(user)) return Promise.resolve(false);
  if (!token || /[\r\n]/.test(token) || token.length > 8192) return Promise.resolve(false);

  const remoteScript =
    `umask 077 && mkdir -p "$HOME/.nebula" && ` +
    `t="$HOME/${REMOTE_TOKEN_PATH}" && cat > "$t.tmp" && chmod 600 "$t.tmp" && mv -f "$t.tmp" "$t" && ` +
    `[ -s "$t" ] && printf 'NB_TOKEN_OK\\n'`;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'ssh',
        ['-p', String(port), '-o', 'ProxyCommand=none', '-o', 'StrictHostKeyChecking=accept-new',
         '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `${user}@localhost`, remoteScript],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      return resolve(false);
    }
    let out = '';
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(false); }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { out += String(d); });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0 && out.includes('NB_TOKEN_OK')));
    try {
      child.stdin?.write(token);
      child.stdin?.end();
    } catch {
      finish(false);
    }
  });
}
