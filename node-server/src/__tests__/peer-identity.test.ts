// @vitest-environment node
/**
 * Who is on the other end of a loopback connection?
 *
 * The CLI/MCP convenience path hands out the browser's session token to
 * token-less requests from 127.0.0.1. That equates "loopback" with "the same
 * user" — true on a laptop, false on a shared login node, where every other
 * account's processes are also on loopback (verified 2026-09-22 on a CRI node
 * with 14 other users logged in: GET /api/fs/list returned 200, unauthenticated).
 *
 * On Linux the kernel already knows: /proc/net/tcp lists both sockets of a
 * loopback pair, and the client's row carries its owner's uid.
 */

import { describe, it, expect } from 'vitest';
import { parseProcNetTcp, findPeerUid } from '../auth/peer-identity';

// Real shape from a CRI login node (uid is field 7).
const SAMPLE = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:C068 00000000:0000 0A 00000000:00000000 00:00000000 00000000 788688670        0 119113711 1 0000000000000000 100 0 0 10 0
 108: 00000000:0BB9 00000000:0000 0A 00000000:00000000 00:00000000 00000000 788716020        0 50934511 1 0000000000000000 100 0 0 10 0
 231: 0100007F:E4C2 0100007F:0BB9 01 00000000:00000000 00:00000000 00000000 788716020        0 50999001 1 0000000000000000 20 4 30 10 -1
 232: 0100007F:0BB9 0100007F:E4C2 01 00000000:00000000 00:00000000 00000000 788716020        0 50999002 1 0000000000000000 20 4 30 10 -1
 233: 0100007F:F1A0 0100007F:0BB9 01 00000000:00000000 00:00000000 00000000 900000123        0 51000111 1 0000000000000000 20 4 30 10 -1
`;

describe('parseProcNetTcp', () => {
  it('reads local/remote ports and the owning uid, skipping the header', () => {
    const rows = parseProcNetTcp(SAMPLE);
    expect(rows).toHaveLength(5);
    expect(rows[3]).toMatchObject({ localPort: 0x0bb9, remPort: 0xe4c2, uid: 788716020 });
  });

  it('ignores malformed lines instead of throwing', () => {
    expect(parseProcNetTcp('garbage\n\n  sl  local_address\nnot a row')).toEqual([]);
  });
});

describe('findPeerUid', () => {
  const rows = parseProcNetTcp(SAMPLE);

  it('finds the CLIENT socket of a loopback pair (local=peer, remote=server)', () => {
    // our own CLI: connected from port 0xE4C2 to the server on 0x0BB9
    expect(findPeerUid(rows, 0xe4c2, 0x0bb9)).toBe(788716020);
  });

  it('reports a different account connecting to the same server port', () => {
    expect(findPeerUid(rows, 0xf1a0, 0x0bb9)).toBe(900000123);
  });

  it('is null when the pair is absent (socket already closed, or another host)', () => {
    expect(findPeerUid(rows, 0x1234, 0x0bb9)).toBeNull();
    expect(findPeerUid(rows, 0xe4c2, 0x9999)).toBeNull();
  });

  it('never matches a listening socket (remote port 0)', () => {
    expect(findPeerUid(rows, 0x0bb9, 0)).toBeNull();
  });
});
