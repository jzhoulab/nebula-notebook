import * as os from 'os';
import * as path from 'path';

/**
 * Directory holding Nebula's auth material (auth.json, passkeys.json).
 * `NEBULA_AUTH_DIR` relocates it — a test seam and a way to run a throwaway
 * server without touching the real `~/.nebula`. Resolved at call time so a
 * process that sets the variable before first use is honored.
 */
export function resolveNebulaDir(): string {
  return process.env.NEBULA_AUTH_DIR || path.join(os.homedir(), '.nebula');
}
