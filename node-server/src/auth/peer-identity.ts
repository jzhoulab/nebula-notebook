/**
 * Peer identity for loopback connections.
 *
 * The session-token fallback (browser's token handed to token-less local
 * callers) is only safe if "local" means "the same user". On a shared login
 * node it does not: every other account's processes also reach 127.0.0.1.
 *
 * On Linux the kernel publishes the answer. A loopback connection appears in
 * /proc/net/tcp twice — once for each end — and the client's row carries the
 * uid that owns it. Matching on the port pair (client's local port == our
 * peer port, client's remote port == our listening port) identifies that row
 * without having to re-encode addresses.
 */

import * as fs from 'fs';
import * as os from 'os';

export interface TcpRow {
  localPort: number;
  remPort: number;
  uid: number;
}

/** Parse /proc/net/tcp (or tcp6). Unparseable lines are skipped, not thrown. */
export function parseProcNetTcp(content: string): TcpRow[] {
  const rows: TcpRow[] = [];
  for (const line of content.split('\n')) {
    const f = line.trim().split(/\s+/);
    // sl local rem st tx:rx tr:when retrnsmt uid …
    if (f.length < 8 || !/^\d+:$/.test(f[0])) continue;
    const local = f[1]?.split(':');
    const rem = f[2]?.split(':');
    const uid = Number(f[7]);
    if (!local || !rem || local.length !== 2 || rem.length !== 2 || !Number.isFinite(uid)) continue;
    const localPort = parseInt(local[1], 16);
    const remPort = parseInt(rem[1], 16);
    if (!Number.isFinite(localPort) || !Number.isFinite(remPort)) continue;
    rows.push({ localPort, remPort, uid });
  }
  return rows;
}

/**
 * uid of the process that opened `peerPort` toward `serverPort`, or null when
 * the pair isn't present. Listening sockets (remote port 0) never match.
 */
export function findPeerUid(rows: TcpRow[], peerPort: number, serverPort: number): number | null {
  if (!serverPort) return null;
  for (const r of rows) {
    if (r.localPort === peerPort && r.remPort === serverPort) return r.uid;
  }
  return null;
}

export type PeerVerdict = 'same-user' | 'other-user' | 'unknown';

/**
 * Is the loopback peer the same OS user the server runs as?
 *
 * 'unknown' on platforms without /proc (macOS, Windows) — callers decide the
 * policy there; on Linux, where shared multi-user hosts actually live, the
 * answer is authoritative.
 */
export function classifyPeer(peerPort: number | undefined, serverPort: number | undefined): PeerVerdict {
  if (os.platform() !== 'linux') return 'unknown';
  if (!peerPort || !serverPort) return 'unknown';
  let rows: TcpRow[] = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      rows = rows.concat(parseProcNetTcp(fs.readFileSync(f, 'utf-8')));
    } catch {
      /* file absent — try the other family */
    }
  }
  if (rows.length === 0) return 'unknown';
  const uid = findPeerUid(rows, peerPort, serverPort);
  if (uid === null) return 'unknown';
  let self: number;
  try {
    self = typeof process.getuid === 'function' ? process.getuid() : -1;
  } catch {
    return 'unknown';
  }
  return uid === self ? 'same-user' : 'other-user';
}
