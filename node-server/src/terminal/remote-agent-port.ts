/**
 * Remote-agent reverse-channel port — ONE per Nebula installation.
 *
 * The port names a fact about the INSTALLATION (which loopback port on this
 * server the user's machine reverse-forwards its sshd to), not about a
 * browser. It used to live only in browser localStorage: any new browser
 * profile minted a fresh random port and silently orphaned the tunnel the
 * user had configured for the old one (lab report: standing Burrow tunnel on
 * one port, panel probing another → "tunnel not detected"). The server owns
 * the value now; browsers mirror it (same pattern as terminal bindings).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Loopback-only, user-space, random to avoid collisions on shared login nodes. */
const PORT_MIN = 20000;
const PORT_RANGE = 40000;

function validPort(p: unknown): p is number {
  return Number.isInteger(p) && (p as number) >= 1024 && (p as number) <= 65535;
}

export class RemoteAgentPortStore {
  private file: string;
  private port: number | null = null;
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
      const data = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as { port?: unknown };
      if (validPort(data.port)) this.port = data.port;
    } catch { /* missing/corrupt file — no port yet */ }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ port: this.port }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn('Failed to persist remote-agent port:', e);
    }
  }

  /**
   * The installation port. When none is stored yet: adopt a valid `claim`
   * (the first browser to sync keeps the port its user already built a
   * tunnel for — no forced re-tunnel on upgrade), else generate. Once
   * stored, claims are ignored — later browsers converge, never fork.
   */
  ensure(claim?: number): number {
    this.ensureLoaded();
    if (this.port !== null) return this.port;
    this.port = validPort(claim) ? claim : PORT_MIN + Math.floor(Math.random() * PORT_RANGE);
    this.persist();
    return this.port;
  }

  /** Explicit user override (settings modal regenerate / manual edit). */
  set(port: number): number {
    if (!validPort(port)) {
      throw new Error('port must be an integer in 1024-65535');
    }
    this.ensureLoaded();
    this.port = port;
    this.persist();
    return port;
  }
}

export const remoteAgentPort = new RemoteAgentPortStore();
