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

// No persisted session token on disk for these tests: the piggyback source is
// absent, so the diagnostic must talk about the PEER, not the file.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: (p: unknown) => (String(p).endsWith('session-token') ? false : actual.existsSync(p as string)) };
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
