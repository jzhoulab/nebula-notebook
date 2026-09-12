// @vitest-environment node
/**
 * Passkey routes end to end on a real Fastify instance with the SAME auth
 * hook index.ts installs, against a throwaway NEBULA_AUTH_DIR. The WebAuthn
 * library is mocked: what is under test is our plumbing — challenge handling,
 * rpID/origin passed to the verifier, credential persistence, the shared rate
 * limiter, and that a passkey login mints the very same session token TOTP
 * does (30-day by default).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';

// The auth dir is resolved when auth-service loads — relocate it before imports.
const env = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-passkeys-routes-'));
  process.env.NEBULA_AUTH_DIR = path.join(tmp, 'nebula');
  return { tmp };
});

// Never touch the user's real ~/.nebula/session-token from a test: neither
// read it (a loopback token-less request would consult it) nor write it (the
// routes persist a fresh session, and the middleware re-persists any valid
// request token through a module-INTERNAL call that a module mock cannot
// intercept — so the interception has to sit at the fs layer).
const persisted = vi.hoisted(() => ({ tokens: [] as string[] }));
const isSessionTokenPath = (p: unknown) => String(p).endsWith('session-token');
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (p: unknown) => (isSessionTokenPath(p) ? false : actual.existsSync(p as string)),
    writeFileSync: ((p: unknown, data: unknown, opts?: unknown) => {
      if (isSessionTokenPath(p)) { persisted.tokens.push(String(data)); return; }
      return actual.writeFileSync(p as string, data as string, opts as any);
    }) as typeof actual.writeFileSync,
  };
});

// The WebAuthn library: deterministic challenges, verifiers that record what
// they were asked to verify and say yes.
const webauthn = vi.hoisted(() => ({
  seq: 0,
  verifyReg: [] as any[],
  verifyAuth: [] as any[],
  regVerified: true,
  authVerified: true,
}));
vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: vi.fn(async (opts: any) => ({
    challenge: `login-challenge-${++webauthn.seq}`,
    rpId: opts.rpID,
    allowCredentials: opts.allowCredentials,
    userVerification: opts.userVerification,
    timeout: 60000,
  })),
  generateRegistrationOptions: vi.fn(async (opts: any) => ({
    challenge: `register-challenge-${++webauthn.seq}`,
    rp: { id: opts.rpID, name: opts.rpName },
    user: { id: Buffer.from(opts.userID).toString('base64url'), name: opts.userName, displayName: opts.userDisplayName },
    attestation: opts.attestationType,
    excludeCredentials: opts.excludeCredentials,
    authenticatorSelection: opts.authenticatorSelection,
    pubKeyCredParams: [],
  })),
  verifyRegistrationResponse: vi.fn(async (args: any) => {
    webauthn.verifyReg.push(args);
    if (!webauthn.regVerified) return { verified: false };
    return {
      verified: true,
      registrationInfo: {
        credential: { id: args.response.id, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal', 'hybrid'] },
      },
    };
  }),
  verifyAuthenticationResponse: vi.fn(async (args: any) => {
    webauthn.verifyAuth.push(args);
    if (!webauthn.authVerified) return { verified: false };
    return { verified: true, authenticationInfo: { newCounter: args.credential.counter + 1 } };
  }),
}));

import authRoutes, { parseTrusted } from '../routes/auth';
import { authService, LONG_SESSION_DAYS, SHORT_SESSION_HOURS } from '../auth/auth-service';
import { authMiddleware, isPublicRoute } from '../auth/auth-middleware';
import { loadPasskeyStore, passkeysFilePath } from '../auth/passkeys';

const HOST = 'localhost:3457';
const ORIGIN = 'http://localhost:3457';

function sessionSeconds(token: string): number {
  const p = jwt.decode(token) as { iat: number; exp: number };
  return p.exp - p.iat;
}

describe('passkey routes', () => {
  let app: FastifyInstance;
  let session: string; // a TOTP-issued token, the way a first-time user gets in

  beforeAll(async () => {
    app = Fastify();
    await app.register(authRoutes, { prefix: '/api' });
    app.addHook('onRequest', async (request, reply) => {
      const pathname = request.url.split('?')[0];
      if (isPublicRoute(pathname)) return;
      await authMiddleware(request, reply);
    });
    // a protected non-auth route, to prove the hook still guards the rest
    app.get('/api/protected', async () => ({ ok: true }));
    await app.ready();

    await authService.initialize();
    const code = authenticator.generate(authService._getTotpSecret()!);
    const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code } });
    expect(res.statusCode).toBe(200);
    session = res.json().token;
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(env.tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    authService.clearFailedAttempts();
    webauthn.regVerified = true;
    webauthn.authVerified = true;
  });

  // `session` is assigned in beforeAll — build the header per use, not at describe time.
  const authed = () => ({ authorization: `Bearer ${session}`, host: HOST });
  const browser = { host: HOST, origin: ORIGIN };

  it('auth.json landed in the relocated dir, not the real home', () => {
    expect(fs.existsSync(path.join(process.env.NEBULA_AUTH_DIR!, 'auth.json'))).toBe(true);
    expect(process.env.NEBULA_AUTH_DIR!.startsWith(os.tmpdir())).toBe(true);
  });

  it('login-options with nothing enrolled: ok:false with a reason (still 200)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/passkeys/login-options', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, error: 'No passkeys enrolled for localhost' });
  });

  it('management routes are NOT public: list/enroll/delete 401 without a session', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/auth/passkeys', headers: browser });
    expect(list.statusCode).toBe(401);
    expect(list.json().error).toBe('auth_required');
    const opts = await app.inject({ method: 'POST', url: '/api/auth/passkeys/register-options', headers: browser });
    expect(opts.statusCode).toBe(401);
    const reg = await app.inject({ method: 'POST', url: '/api/auth/passkeys/register', headers: browser, payload: {} });
    expect(reg.statusCode).toBe(401);
    const del = await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/x', headers: browser });
    expect(del.statusCode).toBe(401);
    // and the hook still guards ordinary API routes
    const other = await app.inject({ method: 'GET', url: '/api/protected', headers: browser });
    expect(other.statusCode).toBe(401);
  });

  it('an IP-literal host is refused with the localhost advice', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/passkeys/login-options', headers: { host: '127.0.0.1:3457' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_rp_id');
    expect(res.json().error).toContain('http://localhost:3457');
    const reg = await app.inject({ method: 'POST', url: '/api/auth/passkeys/register-options', headers: { ...authed(), host: '127.0.0.1:3457' } });
    expect(reg.statusCode).toBe(400);
  });

  it('register → login round trip mints the same 30-day session TOTP does', async () => {
    // 1. registration options (authenticated)
    const optRes = await app.inject({ method: 'POST', url: '/api/auth/passkeys/register-options', headers: authed() });
    expect(optRes.statusCode).toBe(200);
    const opt = optRes.json();
    expect(opt.ok).toBe(true);
    expect(opt.options.rp).toEqual({ id: 'localhost', name: 'Nebula Notebook' });
    expect(opt.options.attestation).toBe('none');
    expect(opt.options.authenticatorSelection).toEqual({ residentKey: 'preferred', userVerification: 'preferred' });
    // the user handle was persisted so re-enrollments share it
    expect(loadPasskeyStore().userId).toBe(opt.options.user.id);

    // 2. register (authenticated) with a label
    const attestation = { id: 'cred-A', rawId: 'cred-A', type: 'public-key', response: { clientDataJSON: 'x', attestationObject: 'y' }, clientExtensionResults: {} };
    const regRes = await app.inject({
      method: 'POST', url: '/api/auth/passkeys/register', headers: authed(),
      payload: { token: opt.token, response: attestation, label: 'MacBook · localhost' },
    });
    expect(regRes.statusCode).toBe(200);
    expect(regRes.json().ok).toBe(true);
    expect(regRes.json().passkey).toMatchObject({ id: 'cred-A', rpID: 'localhost', label: 'MacBook · localhost', lastUsedAt: null });
    expect(regRes.json().passkey.publicKey).toBeUndefined();
    const verifyArgs = webauthn.verifyReg.at(-1);
    expect(verifyArgs).toMatchObject({ expectedChallenge: opt.options.challenge, expectedOrigin: ORIGIN, expectedRPID: 'localhost', requireUserVerification: false });

    // persisted, 0600, public key kept server-side only
    const stored = loadPasskeyStore();
    expect(stored.credentials).toHaveLength(1);
    expect(stored.credentials[0]).toMatchObject({ id: 'cred-A', publicKey: Buffer.from([1, 2, 3, 4]).toString('base64url'), counter: 0, transports: ['internal', 'hybrid'], rpID: 'localhost' });
    expect(fs.statSync(passkeysFilePath()).mode & 0o777).toBe(0o600);

    // the register token is single-use
    const again = await app.inject({
      method: 'POST', url: '/api/auth/passkeys/register', headers: authed(),
      payload: { token: opt.token, response: attestation },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toMatch(/expired/i);

    // 3. list (authenticated) — no public keys, rpID of this request included
    const list = await app.inject({ method: 'GET', url: '/api/auth/passkeys', headers: authed() });
    expect(list.statusCode).toBe(200);
    expect(list.json().rpID).toBe('localhost');
    expect(list.json().passkeys).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain('publicKey');

    // 4. login options (public) now offer the credential
    const loginOptRes = await app.inject({ method: 'POST', url: '/api/auth/passkeys/login-options', headers: { host: HOST } });
    const loginOpt = loginOptRes.json();
    expect(loginOpt.ok).toBe(true);
    expect(loginOpt.options.allowCredentials).toEqual([{ id: 'cred-A', transports: ['internal', 'hybrid'] }]);

    // ...but only at the rpID it was enrolled for
    const elsewhere = await app.inject({ method: 'POST', url: '/api/auth/passkeys/login-options', headers: { host: 'other.example.org' } });
    expect(elsewhere.json()).toEqual({ ok: false, error: 'No passkeys enrolled for other.example.org' });

    // 5. login (public): TOTP-shaped response, 30-day token, counter bumped
    const assertion = { id: 'cred-A', rawId: 'cred-A', type: 'public-key', response: { clientDataJSON: 'x', authenticatorData: 'y', signature: 'z' }, clientExtensionResults: {} };
    persisted.tokens.length = 0;
    const loginRes = await app.inject({ method: 'POST', url: '/api/auth/passkeys/login', headers: { host: HOST }, payload: { token: loginOpt.token, response: assertion } });
    expect(loginRes.statusCode).toBe(200);
    const body = loginRes.json();
    expect(body.success).toBe(true);
    expect(typeof body.token).toBe('string');
    expect(sessionSeconds(body.token)).toBe(LONG_SESSION_DAYS * 24 * 3600);
    expect(authService.validateToken(body.token)).toMatchObject({ trusted: true });
    expect(persisted.tokens).toEqual([body.token]); // MCP/CLI piggyback keeps working (went to the fs seam, not ~/.nebula)
    const authArgs = webauthn.verifyAuth.at(-1);
    expect(authArgs).toMatchObject({ expectedChallenge: loginOpt.options.challenge, expectedOrigin: ORIGIN, expectedRPID: 'localhost', requireUserVerification: false });
    expect(authArgs.credential).toMatchObject({ id: 'cred-A', counter: 0 });
    expect(Buffer.from(authArgs.credential.publicKey)).toEqual(Buffer.from([1, 2, 3, 4]));
    const after = loadPasskeyStore().credentials[0];
    expect(after.counter).toBe(1);
    expect(after.lastUsedAt).toBeTruthy();

    // the session works on protected routes
    const ok = await app.inject({ method: 'GET', url: '/api/protected', headers: { ...browser, authorization: `Bearer ${body.token}` } });
    expect(ok.statusCode).toBe(200);

    // the login token is single-use
    const replay = await app.inject({ method: 'POST', url: '/api/auth/passkeys/login', headers: { host: HOST }, payload: { token: loginOpt.token, response: assertion } });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ success: false, error: 'Passkey not recognized' });

    // 6. delete (authenticated)
    const del = await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/cred-A', headers: authed() });
    expect(del.statusCode).toBe(200);
    expect(loadPasskeyStore().credentials).toHaveLength(0);
    const delAgain = await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/cred-A', headers: authed() });
    expect(delAgain.statusCode).toBe(404);
  });

  it('a failed assertion is a 401 and counts against the shared TOTP rate limit', async () => {
    // enroll something so login-options succeeds
    const opt = (await app.inject({ method: 'POST', url: '/api/auth/passkeys/register-options', headers: authed() })).json();
    await app.inject({
      method: 'POST', url: '/api/auth/passkeys/register', headers: authed(),
      payload: { token: opt.token, response: { id: 'cred-B', rawId: 'cred-B', type: 'public-key', response: {}, clientExtensionResults: {} } },
    });

    webauthn.authVerified = false;
    for (let i = 0; i < 5; i++) {
      const lo = (await app.inject({ method: 'POST', url: '/api/auth/passkeys/login-options', headers: { host: HOST } })).json();
      const res = await app.inject({ method: 'POST', url: '/api/auth/passkeys/login', headers: { host: HOST }, payload: { token: lo.token, response: { id: 'cred-B', rawId: 'cred-B', type: 'public-key', response: {}, clientExtensionResults: {} } } });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Passkey verification failed');
    }
    // 6th attempt: locked out — on the passkey path...
    const lo = (await app.inject({ method: 'POST', url: '/api/auth/passkeys/login-options', headers: { host: HOST } })).json();
    const locked = await app.inject({ method: 'POST', url: '/api/auth/passkeys/login', headers: { host: HOST }, payload: { token: lo.token, response: { id: 'cred-B' } } });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toMatch(/Too many attempts/);
    // ...and on the TOTP path (one bucket, not one per endpoint)
    const code = authenticator.generate(authService._getTotpSecret()!);
    const totp = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code } });
    expect(totp.statusCode).toBe(401);
    expect(totp.json().error).toMatch(/Too many attempts/);

    await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/cred-B', headers: authed() });
  });

  it('a failed attestation is a 400 and stores nothing', async () => {
    webauthn.regVerified = false;
    const opt = (await app.inject({ method: 'POST', url: '/api/auth/passkeys/register-options', headers: authed() })).json();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/passkeys/register', headers: authed(),
      payload: { token: opt.token, response: { id: 'cred-C', rawId: 'cred-C', type: 'public-key', response: {}, clientExtensionResults: {} } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/verification failed/i);
    expect(loadPasskeyStore().credentials.find((c) => c.id === 'cred-C')).toBeUndefined();
  });
});

describe('session length', () => {
  it('TOTP login without a trusted flag yields the 30-day session', async () => {
    await authService.initialize();
    const code = authenticator.generate(authService._getTotpSecret()!);
    const app = Fastify();
    await app.register(authRoutes, { prefix: '/api' });
    const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code } });
    expect(res.statusCode).toBe(200);
    expect(sessionSeconds(res.json().token)).toBe(LONG_SESSION_DAYS * 24 * 3600);
    await app.close();
  });

  it('TOTP login with trusted:false (or trustBrowser:false) yields the 24 h session', async () => {
    await authService.initialize();
    const app = Fastify();
    await app.register(authRoutes, { prefix: '/api' });
    for (const payload of [{ trusted: false }, { trustBrowser: false }]) {
      const code = authenticator.generate(authService._getTotpSecret()!);
      const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code, ...payload } });
      expect(res.statusCode).toBe(200);
      expect(sessionSeconds(res.json().token)).toBe(SHORT_SESSION_HOURS * 3600);
      expect(authService.validateToken(res.json().token)).toMatchObject({ trusted: false });
    }
    await app.close();
  });

  it('issueToken defaults to the long session at the service level too', () => {
    expect(sessionSeconds(authService.issueToken())).toBe(LONG_SESSION_DAYS * 24 * 3600);
    expect(sessionSeconds(authService.issueToken(false))).toBe(SHORT_SESSION_HOURS * 3600);
  });

  it('parseTrusted: only an explicit false opts out', () => {
    expect(parseTrusted({})).toBe(true);
    expect(parseTrusted(undefined)).toBe(true);
    expect(parseTrusted({ trustBrowser: true })).toBe(true);
    expect(parseTrusted({ trusted: false })).toBe(false);
    expect(parseTrusted({ trustBrowser: false })).toBe(false);
    expect(parseTrusted({ trustBrowser: 'false' })).toBe(false);
    expect(parseTrusted({ trusted: false, trustBrowser: true })).toBe(false); // `trusted` wins
  });
});
