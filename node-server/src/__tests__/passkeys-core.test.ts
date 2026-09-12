// @vitest-environment node
/**
 * Passkey primitives: the on-disk store (private file next to auth.json), the
 * single-use / expiring challenge map, and rpID/origin derivation from the
 * request Host. These are the pieces a WebAuthn bug hides in — the library
 * calls themselves are exercised (mocked) in passkeys-routes.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadPasskeyStore,
  savePasskeyStore,
  passkeysFilePath,
  PasskeyChallenges,
  deriveRpInfo,
  PasskeyRpError,
  CHALLENGE_TTL_MS,
  type PasskeyStore,
} from '../auth/passkeys';

let tmpDir: string;
const savedEnv = process.env.NEBULA_AUTH_DIR;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-passkeys-'));
  // Point the auth dir at a throwaway location — never the user's ~/.nebula.
  process.env.NEBULA_AUTH_DIR = path.join(tmpDir, 'nebula');
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.NEBULA_AUTH_DIR;
  else process.env.NEBULA_AUTH_DIR = savedEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sampleStore = (): PasskeyStore => ({
  userId: 'dXNlci1pZA',
  credentials: [
    {
      id: 'cred-1',
      publicKey: 'AQID',
      counter: 3,
      transports: ['internal'],
      rpID: 'localhost',
      label: 'Mac · localhost',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastUsedAt: null,
    },
  ],
});

describe('passkey store', () => {
  it('lives next to auth.json (honors NEBULA_AUTH_DIR)', () => {
    expect(passkeysFilePath()).toBe(path.join(process.env.NEBULA_AUTH_DIR!, 'passkeys.json'));
  });

  it('a missing file is an empty store, not an error', () => {
    expect(loadPasskeyStore()).toEqual({ userId: null, credentials: [] });
  });

  it('round-trips and writes a private (0600) file in a private (0700) dir', () => {
    savePasskeyStore(sampleStore());
    const file = passkeysFilePath();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(loadPasskeyStore()).toEqual(sampleStore());
    // no temp file left behind
    expect(fs.readdirSync(path.dirname(file))).toEqual(['passkeys.json']);
  });

  it('a corrupt file degrades to an empty store', () => {
    fs.mkdirSync(path.dirname(passkeysFilePath()), { recursive: true });
    fs.writeFileSync(passkeysFilePath(), '{not json');
    expect(loadPasskeyStore()).toEqual({ userId: null, credentials: [] });
  });

  it('drops malformed credential entries but keeps the good ones', () => {
    fs.mkdirSync(path.dirname(passkeysFilePath()), { recursive: true });
    fs.writeFileSync(
      passkeysFilePath(),
      JSON.stringify({ userId: 'u', credentials: [sampleStore().credentials[0], { id: 'no-key' }, 'junk'] }),
    );
    const store = loadPasskeyStore();
    expect(store.credentials).toHaveLength(1);
    expect(store.credentials[0].id).toBe('cred-1');
  });
});

describe('passkey challenges', () => {
  let now = 1_000_000;
  const clock = () => now;

  beforeEach(() => { now = 1_000_000; });

  it('is single-use: the second take of the same token returns null', () => {
    const ch = new PasskeyChallenges(clock);
    const token = ch.put('login', 'localhost', 'abc');
    expect(ch.take(token, 'login', 'localhost')).toBe('abc');
    expect(ch.take(token, 'login', 'localhost')).toBeNull();
  });

  it('expires after 120 s (and the expired entry is burned)', () => {
    const ch = new PasskeyChallenges(clock);
    const token = ch.put('login', 'localhost', 'abc');
    now += CHALLENGE_TTL_MS - 1;
    expect(ch.size).toBe(1);
    now += 2;
    expect(ch.take(token, 'login', 'localhost')).toBeNull();
    expect(ch.size).toBe(0);
  });

  it('is typed: a register challenge cannot complete a login (and vice versa)', () => {
    const ch = new PasskeyChallenges(clock);
    const reg = ch.put('register', 'localhost', 'r');
    expect(ch.take(reg, 'login', 'localhost')).toBeNull();
    const login = ch.put('login', 'localhost', 'l');
    expect(ch.take(login, 'register', 'localhost')).toBeNull();
  });

  it('is bound to the rpID it was issued for', () => {
    const ch = new PasskeyChallenges(clock);
    const token = ch.put('login', 'localhost', 'abc');
    expect(ch.take(token, 'login', 'nebula.example.org')).toBeNull();
  });

  it('tolerates garbage tokens', () => {
    const ch = new PasskeyChallenges(clock);
    expect(ch.take(undefined, 'login', 'localhost')).toBeNull();
    expect(ch.take({ token: 'x' }, 'login', 'localhost')).toBeNull();
    expect(ch.take('nope', 'login', 'localhost')).toBeNull();
  });

  it('sweeps expired entries on put', () => {
    const ch = new PasskeyChallenges(clock);
    ch.put('login', 'localhost', 'a');
    ch.put('login', 'localhost', 'b');
    now += CHALLENGE_TTL_MS + 1;
    ch.put('login', 'localhost', 'c');
    expect(ch.size).toBe(1);
  });
});

describe('rpID / origin derivation', () => {
  it('localhost with a port: rpID drops the port, origin keeps it, proto is http', () => {
    expect(deriveRpInfo({ host: 'localhost:3000' })).toEqual({ rpID: 'localhost', origin: 'http://localhost:3000' });
  });

  it('a real hostname defaults to https', () => {
    expect(deriveRpInfo({ host: 'nebula.example.org' })).toEqual({
      rpID: 'nebula.example.org',
      origin: 'https://nebula.example.org',
    });
  });

  it('honors X-Forwarded-Proto and X-Forwarded-Host (first value wins)', () => {
    expect(deriveRpInfo({ host: 'localhost:3001', 'x-forwarded-host': 'nb.lab.edu, internal', 'x-forwarded-proto': 'https, http' })).toEqual({
      rpID: 'nb.lab.edu',
      origin: 'https://nb.lab.edu',
    });
    // proxy terminating TLS in front of a local port
    expect(deriveRpInfo({ host: 'localhost:8443', 'x-forwarded-proto': 'https' })).toEqual({
      rpID: 'localhost',
      origin: 'https://localhost:8443',
    });
  });

  it('drops the default port from the origin', () => {
    expect(deriveRpInfo({ host: 'nb.lab.edu:443' }).origin).toBe('https://nb.lab.edu');
    expect(deriveRpInfo({ host: 'localhost:80' }).origin).toBe('http://localhost');
  });

  it('lower-cases the hostname', () => {
    expect(deriveRpInfo({ host: 'LocalHost:3000' }).rpID).toBe('localhost');
  });

  it('rejects an IP-literal host with advice to use localhost', () => {
    let err: unknown;
    try { deriveRpInfo({ host: '127.0.0.1:3000' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PasskeyRpError);
    expect((err as Error).message).toContain('http://localhost:3000');
    expect((err as Error).message).toContain('127.0.0.1');
    expect(() => deriveRpInfo({ host: '10.50.1.7' })).toThrow(PasskeyRpError);
    expect(() => deriveRpInfo({ host: '[::1]:3000' })).toThrow(/http:\/\/localhost:3000/);
  });

  it('no Host at all falls back to localhost', () => {
    expect(deriveRpInfo({})).toEqual({ rpID: 'localhost', origin: 'http://localhost' });
  });
});
