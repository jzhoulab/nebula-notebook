// @vitest-environment node
/**
 * The CLI/MCP piggyback (loopback + no token → the browser's persisted session
 * token) is topology-dependent: a tunnel that terminates on ANOTHER host makes
 * the peer non-loopback and the free ride vanishes. When that happens the
 * refusal must SAY so — "Please log in" sent an agent chasing a browser login
 * that could not have helped (2026-08-17, cri22in001-terminated tunnel).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const authState = vi.hoisted(() => ({
  disabled: false,
  setupComplete: true,
  validTokens: new Set<string>(),
}));

vi.mock('../auth/auth-service', () => ({
  authService: {
    isAuthDisabled: () => authState.disabled,
    isSetupComplete: () => authState.setupComplete,
    validateToken: (t: string) => (authState.validTokens.has(t) ? { iat: 1, exp: 2, trusted: true } : null),
  },
}));

vi.mock('../cluster/cluster-secret', () => ({ readClusterSecret: () => null }));

// Peer classification is stubbed: the parser itself is covered in
// peer-identity.test.ts; here we assert the POLICY it drives.
const peerState = vi.hoisted(() => ({ verdict: 'same-user' as string }));
vi.mock('../auth/peer-identity', () => ({
  classifyPeer: () => peerState.verdict,
}));

// Whether a session token exists on disk is per-test (diskState): some cases
// need the piggyback source absent, the peer-identity cases need it present.
const diskState = vi.hoisted(() => ({ sessionToken: null as string | null }));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const isSessionTokenPath = (p: unknown) => String(p).endsWith('session-token');
  return {
    ...actual,
    existsSync: (p: unknown) =>
      isSessionTokenPath(p) ? diskState.sessionToken !== null : actual.existsSync(p as string),
    readFileSync: ((p: unknown, ...rest: unknown[]) =>
      isSessionTokenPath(p)
        ? (diskState.sessionToken as string)
        : (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof actual.readFileSync,
    // A request that authenticates with a real token makes the middleware
    // persist it via a module-internal call. Without this interception the
    // suite overwrote the user's real ~/.nebula/session-token with the
    // literal fixture token on every run (observed 2026-09-12).
    writeFileSync: ((p: unknown, data: unknown, opts?: unknown) => {
      if (isSessionTokenPath(p)) return;
      return actual.writeFileSync(p as string, data as string, opts as any);
    }) as typeof actual.writeFileSync,
  };
});

import { authMiddleware } from '../auth/auth-middleware';

function fakeRequest(over: { ip?: string; headers?: Record<string, string>; url?: string }) {
  return {
    url: over.url ?? '/api/notebook/cells?path=x',
    ip: over.ip ?? '10.50.178.201',
    headers: over.headers ?? {},
    query: {},
  } as any;
}

function fakeReply() {
  const reply: any = { statusCode: 200, body: undefined };
  reply.code = (c: number) => { reply.statusCode = c; return reply; };
  reply.send = (b: unknown) => { reply.body = b; return reply; };
  return reply;
}

describe('authMiddleware — token-less refusals explain themselves', () => {
  beforeEach(() => {
    authState.disabled = false;
    authState.setupComplete = true;
    authState.validTokens.clear();
    delete process.env.NEBULA_CLIENT_MODE;
    peerState.verdict = 'same-user';
    diskState.sessionToken = null;
  });

  it('non-loopback peer without a token: names the peer and the loopback rule', async () => {
    const reply = fakeReply();
    await authMiddleware(fakeRequest({ ip: '10.50.178.201' }), reply);
    expect(reply.statusCode).toBe(401);
    expect(reply.body.error).toBe('no_token_non_loopback');
    expect(reply.body.message).toContain('10.50.178.201');
    expect(reply.body.message).toMatch(/loopback/i);
    expect(reply.body.message).toMatch(/NEBULA_TOKEN/);
    // and NOT the browser-oriented advice
    expect(reply.body.message).not.toMatch(/please log in/i);
  });

  it('loopback peer without a token and no session file: says the piggyback source is missing', async () => {
    const reply = fakeReply();
    await authMiddleware(fakeRequest({ ip: '127.0.0.1' }), reply);
    expect(reply.statusCode).toBe(401);
    expect(reply.body.error).toBe('no_token_no_session');
    expect(reply.body.message).toMatch(/session-token|log in/i);
  });

  it('a browser (Origin header) without a token still gets the plain login prompt', async () => {
    const reply = fakeReply();
    await authMiddleware(fakeRequest({ ip: '127.0.0.1', headers: { origin: 'http://localhost:3000' } }), reply);
    expect(reply.statusCode).toBe(401);
    expect(reply.body.error).toBe('auth_required');
  });

  it('an invalid/expired token tells CLI callers how to refresh, not just "log in"', async () => {
    const reply = fakeReply();
    await authMiddleware(fakeRequest({ ip: '10.50.178.201', headers: { authorization: 'Bearer stale' } }), reply);
    expect(reply.statusCode).toBe(401);
    expect(reply.body.error).toBe('invalid_token');
    expect(reply.body.message).toMatch(/NEBULA_TOKEN|~\/\.nebula\/token/);
  });

  it('a valid bearer token from a non-loopback peer is accepted (topology no longer matters)', async () => {
    authState.validTokens.add('good');
    const reply = fakeReply();
    const result = await authMiddleware(fakeRequest({ ip: '10.50.178.201', headers: { authorization: 'Bearer good' } }), reply);
    expect(result).toBeUndefined();
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBeUndefined();
  });
});

describe('loopback session-token fallback is limited to the SAME OS user', () => {
  // A shared login node puts other accounts on 127.0.0.1 too. Handing them the
  // browser's token is account takeover (fs read/write + notebook execution).
  beforeEach(() => {
    authState.validTokens.add('browser-session');
    diskState.sessionToken = 'browser-session';
  });

  it('same-user loopback caller still gets the piggyback (the CLI keeps working)', async () => {
    peerState.verdict = 'same-user';
    const reply = fakeReply();
    const r = await authMiddleware(fakeRequest({ ip: '127.0.0.1' }), reply);
    expect(r).toBeUndefined();
    expect(reply.statusCode).toBe(200);
  });

  it('ANOTHER user on the same host is refused, and told why', async () => {
    peerState.verdict = 'other-user';
    const reply = fakeReply();
    await authMiddleware(fakeRequest({ ip: '127.0.0.1' }), reply);
    expect(reply.statusCode).toBe(401);
    expect(reply.body.error).toBe('peer_not_owner');
    expect(reply.body.message).toMatch(/different OS user|another user/i);
  });

  it('that user cannot borrow the token by pretending to be a browser either', async () => {
    peerState.verdict = 'other-user';
    const reply = fakeReply();
    await authMiddleware(fakeRequest({ ip: '127.0.0.1', headers: { origin: 'http://localhost:3000' } }), reply);
    expect(reply.statusCode).toBe(401);
  });

  it('a real token from another user is still honoured (auth, not identity, is the gate)', async () => {
    peerState.verdict = 'other-user';
    const reply = fakeReply();
    const r = await authMiddleware(
      fakeRequest({ ip: '127.0.0.1', headers: { authorization: 'Bearer browser-session' } }), reply);
    expect(r).toBeUndefined();
    expect(reply.statusCode).toBe(200);
  });

  it('unknown peer (no /proc — macOS dev box) keeps the old convenience', async () => {
    peerState.verdict = 'unknown';
    const reply = fakeReply();
    const r = await authMiddleware(fakeRequest({ ip: '127.0.0.1' }), reply);
    expect(r).toBeUndefined();
    expect(reply.statusCode).toBe(200);
  });
});
