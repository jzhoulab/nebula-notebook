/**
 * Remote-agent config — ONE per Nebula installation.
 *
 * How to reach the user's machine describes the INSTALLATION, not a browser:
 * which loopback port here their sshd is reverse-forwarded to, their username
 * on that machine, its sshd port, an optional jump host. It used to live only
 * in browser localStorage, where two failures followed:
 *   - a fresh browser minted a NEW random port and silently orphaned the
 *     tunnel the user had already built (lab report: "tunnel not detected");
 *   - a fresh browser re-prompted the whole setup dialog for a tunnel that
 *     was up and working — and "fresh" includes merely a second ORIGIN, since
 *     localhost:3000 and localhost:8867 have separate localStorage.
 * The server owns it now; browsers mirror it (same pattern as bindings).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Loopback-only, user-space, random to avoid collisions on shared login nodes. */
const PORT_MIN = 20000;
const PORT_RANGE = 40000;

export interface RemoteAgentConfig {
  /** Reverse-channel port on THIS host (the -R target). */
  port?: number;
  /** Username on the user's machine, for the ssh hop back. */
  user?: string;
  /** sshd port on the user's machine (macOS policy often forces 2222). */
  localSshPort?: number;
  /** Optional ProxyJump host shown in the tunnel command. */
  jumpHost?: string;
  /** Nebula URL as seen FROM the user's machine (their -L forward). */
  localUrl?: string;
}

/** Field-level patch; null means "erase this field". */
export type RemoteAgentConfigPatch = {
  [K in keyof RemoteAgentConfig]?: RemoteAgentConfig[K] | null;
};

function validPort(p: unknown): p is number {
  return Number.isInteger(p) && (p as number) >= 1024 && (p as number) <= 65535;
}

function cleanString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export class RemoteAgentConfigStore {
  private file: string;
  private config: RemoteAgentConfig = {};
  private loaded = false;

  constructor(file?: string) {
    this.file =
      file ||
      process.env.NEBULA_REMOTE_AGENT_FILE ||
      path.join(os.homedir(), '.nebula', 'remote-agent.json');
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, unknown>;
      // Field-by-field so a legacy {port}-only file (and any junk) reads clean.
      if (validPort(raw.port)) this.config.port = raw.port;
      if (validPort(raw.localSshPort)) this.config.localSshPort = raw.localSshPort;
      this.config.user = cleanString(raw.user);
      this.config.jumpHost = cleanString(raw.jumpHost);
      this.config.localUrl = cleanString(raw.localUrl);
    } catch { /* missing/corrupt file — nothing configured yet */ }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn('Failed to persist remote-agent config:', e);
    }
  }

  get(): RemoteAgentConfig {
    this.ensureLoaded();
    return { ...this.config };
  }

  /**
   * The installation port, generating one on first use. A valid `claim` is
   * adopted ONLY when none is stored — the first browser to sync keeps the
   * port its user already built a tunnel for; later browsers converge.
   */
  ensurePort(claim?: number): number {
    this.ensureLoaded();
    if (this.config.port !== undefined) return this.config.port;
    this.config.port = validPort(claim) ? claim : PORT_MIN + Math.floor(Math.random() * PORT_RANGE);
    this.persist();
    return this.config.port;
  }

  /**
   * Adopt a browser's local values for whatever this installation does NOT
   * know yet, and return the effective config. Stored truth always wins, so
   * one browser's stale copy can never overwrite a working setup.
   */
  claim(claimed: RemoteAgentConfig): RemoteAgentConfig {
    this.ensureLoaded();
    const missing: RemoteAgentConfigPatch = {};
    if (this.config.user === undefined && cleanString(claimed.user)) missing.user = claimed.user;
    if (this.config.localSshPort === undefined && validPort(claimed.localSshPort)) missing.localSshPort = claimed.localSshPort;
    if (this.config.jumpHost === undefined && cleanString(claimed.jumpHost)) missing.jumpHost = claimed.jumpHost;
    if (this.config.localUrl === undefined && cleanString(claimed.localUrl)) missing.localUrl = claimed.localUrl;
    if (Object.keys(missing).length) this.patch(missing);
    this.ensurePort(claimed.port); // adopt-if-missing, and always end up with one
    return this.get();
  }

  /**
   * Explicit override (setup dialog). Merges: omitted fields keep their
   * stored value, `null` erases, invalid values are ignored rather than
   * stored — a typo must not break a working installation.
   */
  patch(fields: RemoteAgentConfigPatch): RemoteAgentConfig {
    this.ensureLoaded();
    const setOrClear = <K extends keyof RemoteAgentConfig>(
      key: K,
      value: RemoteAgentConfig[K] | null | undefined,
      clean: (v: unknown) => RemoteAgentConfig[K] | undefined
    ): void => {
      if (value === undefined) return;                        // not mentioned — keep
      if (value === null) { delete this.config[key]; return; } // explicit erase
      const ok = clean(value);
      if (ok !== undefined) this.config[key] = ok;             // invalid — keep stored
    };
    const asPort = (v: unknown) => (validPort(v) ? v : undefined) as RemoteAgentConfig['port'];
    setOrClear('port', fields.port, asPort);
    setOrClear('localSshPort', fields.localSshPort, asPort);
    setOrClear('user', fields.user, cleanString);
    setOrClear('jumpHost', fields.jumpHost, cleanString);
    setOrClear('localUrl', fields.localUrl, cleanString);
    this.persist();
    return this.get();
  }
}

export const remoteAgentConfig = new RemoteAgentConfigStore();
