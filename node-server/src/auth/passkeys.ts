/**
 * Passkeys (WebAuthn) — biometric / security-key login that AUGMENTS TOTP.
 *
 * A verified assertion mints the same session JWT the TOTP path mints; TOTP
 * stays as the fallback and as the way to authenticate before enrolling the
 * first passkey. Credentials are stored per rpID (per hostname): a passkey
 * enrolled at `localhost` (the ssh-tunnel case) works wherever the browser
 * reaches Nebula as `localhost`, one enrolled at a tunnel domain works there.
 *
 * Storage: `<nebula dir>/passkeys.json`, mode 0600, next to auth.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { randomBytes } from 'crypto';
import type { IncomingHttpHeaders } from 'http';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { resolveNebulaDir } from './nebula-dir';

// ── Storage ─────────────────────────────────────────────────────────────────

export interface PasskeyCredential {
  /** Credential ID (base64url) — also what the authenticator presents at login. */
  id: string;
  /** COSE public key, base64url. Never leaves the server. */
  publicKey: string;
  counter: number;
  transports: AuthenticatorTransportFuture[];
  /** Hostname the credential was enrolled at; a passkey is only offered there. */
  rpID: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PasskeyStore {
  /** Stable opaque user handle (base64url) shared by every credential. */
  userId: string | null;
  credentials: PasskeyCredential[];
}

/** What clients may see: everything except the public key. */
export interface PublicPasskey {
  id: string;
  rpID: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export const PASSKEYS_FILENAME = 'passkeys.json';
export const MAX_LABEL_LENGTH = 60;

export function passkeysFilePath(): string {
  return path.join(resolveNebulaDir(), PASSKEYS_FILENAME);
}

export function toPublicPasskey(c: PasskeyCredential): PublicPasskey {
  return { id: c.id, rpID: c.rpID, label: c.label, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt ?? null };
}

function sanitizeCredential(raw: unknown): PasskeyCredential | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.publicKey !== 'string' || typeof c.rpID !== 'string') return null;
  return {
    id: c.id,
    publicKey: c.publicKey,
    counter: Number.isFinite(Number(c.counter)) ? Number(c.counter) : 0,
    transports: Array.isArray(c.transports) ? (c.transports.filter((t) => typeof t === 'string') as AuthenticatorTransportFuture[]) : [],
    rpID: c.rpID,
    label: typeof c.label === 'string' ? c.label : `passkey · ${c.rpID}`,
    createdAt: typeof c.createdAt === 'string' ? c.createdAt : new Date(0).toISOString(),
    lastUsedAt: typeof c.lastUsedAt === 'string' ? c.lastUsedAt : null,
  };
}

/** Load the store; a missing or unreadable file is an empty store. */
export function loadPasskeyStore(): PasskeyStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(passkeysFilePath(), 'utf8'));
    const credentials = Array.isArray(parsed?.credentials)
      ? (parsed.credentials.map(sanitizeCredential).filter(Boolean) as PasskeyCredential[])
      : [];
    return { userId: typeof parsed?.userId === 'string' ? parsed.userId : null, credentials };
  } catch {
    return { userId: null, credentials: [] };
  }
}

/**
 * Persist the store, private to the user (dir 0700, file 0600) and atomically
 * (tmp + rename) so a failed write never leaves a truncated credential list.
 */
export function savePasskeyStore(store: PasskeyStore): void {
  const file = passkeysFilePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // mode above is subject to umask; be explicit
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing partial to clean */ }
    throw err;
  }
}

// ── Challenges ──────────────────────────────────────────────────────────────

export type ChallengeType = 'login' | 'register';

interface ChallengeEntry {
  challenge: string;
  type: ChallengeType;
  rpID: string;
  expiresAt: number;
}

export const CHALLENGE_TTL_MS = 120_000;

/**
 * Outstanding WebAuthn challenges: in-memory, single-use, 120 s TTL, typed
 * (a login challenge cannot complete a registration) and bound to the rpID
 * they were issued for. The opaque token handed to the client is the map key.
 */
export class PasskeyChallenges {
  private readonly entries = new Map<string, ChallengeEntry>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs: number = CHALLENGE_TTL_MS) {}

  put(type: ChallengeType, rpID: string, challenge: string): string {
    this.sweep();
    const token = randomBytes(16).toString('hex');
    this.entries.set(token, { challenge, type, rpID, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /** Consume a challenge. Returns null (and burns the token) on any mismatch. */
  take(token: unknown, type: ChallengeType, rpID: string): string | null {
    const key = typeof token === 'string' ? token : '';
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (!entry || entry.type !== type || entry.rpID !== rpID || entry.expiresAt < this.now()) return null;
    return entry.challenge;
  }

  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, v] of this.entries) {
      if (v.expiresAt < now) this.entries.delete(k);
    }
  }
}

// ── Relying-party identity ──────────────────────────────────────────────────

export interface RpInfo {
  /** Hostname only (no port) — what the browser scopes the credential to. */
  rpID: string;
  /** `${proto}://${host[:port]}` as the browser will report it in clientDataJSON. */
  origin: string;
}

export class PasskeyRpError extends Error {
  readonly code = 'invalid_rp_id';
}

function firstHeader(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw ?? '').split(',')[0].trim();
}

/**
 * Derive rpID and origin from the request's own Host (or X-Forwarded-Host).
 * The rpID is the hostname with the port stripped; the origin keeps the port.
 * Protocol honors X-Forwarded-Proto and otherwise defaults to https — except
 * for localhost, which browsers treat as a secure context over plain http and
 * which is the common case (ssh tunnel to localhost:3000).
 *
 * WebAuthn forbids IP-literal rpIDs, so `127.0.0.1` is rejected with advice
 * to use `http://localhost:PORT` instead.
 */
export function deriveRpInfo(headers: IncomingHttpHeaders): RpInfo {
  const hostHeader = firstHeader(headers['x-forwarded-host']) || firstHeader(headers.host);
  let hostname = hostHeader;
  let port = '';
  if (hostHeader.startsWith('[')) {
    // IPv6 literal, e.g. [::1]:3000 — rejected below, parsed only for the message.
    const end = hostHeader.indexOf(']');
    hostname = end > 0 ? hostHeader.slice(1, end) : hostHeader;
    port = end > 0 ? hostHeader.slice(end + 1).replace(/^:/, '') : '';
  } else {
    const m = /^([^:]*)(?::(\d+))?$/.exec(hostHeader);
    if (m) {
      hostname = m[1];
      port = m[2] ?? '';
    }
  }
  hostname = hostname.toLowerCase() || 'localhost';

  if (net.isIP(hostname)) {
    const suggested = `http://localhost${port ? `:${port}` : ''}`;
    throw new PasskeyRpError(
      `Passkeys cannot be used at an IP address (${hostname}) — WebAuthn requires a hostname. ` +
      `Open ${suggested} instead of ${hostname}.`,
    );
  }

  const isLocal = hostname === 'localhost' || hostname.endsWith('.localhost');
  const forwardedProto = firstHeader(headers['x-forwarded-proto']).toLowerCase();
  const proto = forwardedProto === 'http' || forwardedProto === 'https' ? forwardedProto : (isLocal ? 'http' : 'https');
  const defaultPort = proto === 'https' ? '443' : '80';
  const originHost = port && port !== defaultPort ? `${hostname}:${port}` : hostname;
  return { rpID: hostname, origin: `${proto}://${originHost}` };
}

// ── Service ─────────────────────────────────────────────────────────────────

export type OptionsResult<T> =
  | { ok: true; token: string; options: T }
  | { ok: false; error: string };

export type LoginResult =
  | { ok: true; credential: PasskeyCredential }
  | { ok: false; error: string };

export type RegisterResult =
  | { ok: true; passkey: PublicPasskey }
  | { ok: false; error: string };

const RP_NAME = 'Nebula Notebook';
const USER_NAME = 'nebula';

function asObject(body: unknown): Record<string, any> {
  return body && typeof body === 'object' ? (body as Record<string, any>) : {};
}

export class PasskeyService {
  readonly challenges: PasskeyChallenges;

  constructor(challenges: PasskeyChallenges = new PasskeyChallenges()) {
    this.challenges = challenges;
  }

  /** Credentials enrolled at this rpID. */
  credentialsFor(rpID: string, store: PasskeyStore = loadPasskeyStore()): PasskeyCredential[] {
    return store.credentials.filter((c) => c.rpID === rpID);
  }

  /** Unauthenticated: a login challenge, or `ok:false` when nothing is enrolled here. */
  async loginOptions(rp: RpInfo): Promise<OptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
    const creds = this.credentialsFor(rp.rpID);
    if (creds.length === 0) {
      return { ok: false, error: `No passkeys enrolled for ${rp.rpID}` };
    }
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: 'preferred',
      allowCredentials: creds.map((c) => ({
        id: c.id,
        transports: c.transports.length ? c.transports : undefined,
      })),
    });
    return { ok: true, token: this.challenges.put('login', rp.rpID, options.challenge), options };
  }

  /**
   * Unauthenticated: verify an assertion against a stored credential. On
   * success the counter and lastUsedAt are persisted. The caller mints the
   * session and applies rate limiting.
   */
  async login(rp: RpInfo, body: unknown): Promise<LoginResult> {
    const { token, response } = asObject(body);
    const challenge = this.challenges.take(token, 'login', rp.rpID);
    const assertion = response as AuthenticationResponseJSON | undefined;
    const store = loadPasskeyStore();
    const cred = assertion?.id
      ? store.credentials.find((c) => c.id === assertion.id && c.rpID === rp.rpID)
      : undefined;
    if (!challenge || !cred) {
      return { ok: false, error: 'Passkey not recognized' };
    }

    let verified = false;
    let newCounter = cred.counter;
    try {
      const verification = await verifyAuthenticationResponse({
        response: assertion!,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
          counter: cred.counter,
          transports: cred.transports,
        },
        requireUserVerification: false,
      });
      verified = verification.verified;
      newCounter = verification.authenticationInfo?.newCounter ?? cred.counter;
    } catch {
      verified = false;
    }
    if (!verified) {
      return { ok: false, error: 'Passkey verification failed' };
    }

    cred.counter = newCounter;
    cred.lastUsedAt = new Date().toISOString();
    savePasskeyStore(store);
    return { ok: true, credential: cred };
  }

  /** Authenticated: a registration challenge for this rpID. */
  async registerOptions(rp: RpInfo): Promise<OptionsResult<PublicKeyCredentialCreationOptionsJSON>> {
    const store = loadPasskeyStore();
    if (!store.userId) {
      store.userId = randomBytes(16).toString('base64url');
      savePasskeyStore(store); // the user handle must survive restarts
    }
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rp.rpID,
      userID: new Uint8Array(Buffer.from(store.userId, 'base64url')),
      userName: USER_NAME,
      userDisplayName: `Nebula @ ${rp.rpID}`,
      attestationType: 'none',
      excludeCredentials: this.credentialsFor(rp.rpID, store).map((c) => ({
        id: c.id,
        transports: c.transports.length ? c.transports : undefined,
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    return { ok: true, token: this.challenges.put('register', rp.rpID, options.challenge), options };
  }

  /** Authenticated: verify an attestation and store the new credential. */
  async register(rp: RpInfo, body: unknown): Promise<RegisterResult> {
    const { token, response, label } = asObject(body);
    const challenge = this.challenges.take(token, 'register', rp.rpID);
    if (!challenge) {
      return { ok: false, error: 'Challenge expired — try again' };
    }
    const attestation = response as RegistrationResponseJSON | undefined;
    if (!attestation?.id) {
      return { ok: false, error: 'Missing attestation response' };
    }

    let registered: { id: string; publicKey: Uint8Array; counter: number; transports?: AuthenticatorTransportFuture[] } | undefined;
    try {
      const verification = await verifyRegistrationResponse({
        response: attestation,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: false,
      });
      registered = verification.verified ? verification.registrationInfo?.credential : undefined;
    } catch {
      registered = undefined;
    }
    if (!registered) {
      return { ok: false, error: 'Attestation verification failed' };
    }

    const store = loadPasskeyStore();
    const existing = store.credentials.find((c) => c.id === registered!.id);
    if (existing) {
      return { ok: true, passkey: toPublicPasskey(existing) };
    }
    const cleanLabel = typeof label === 'string' ? label.trim().slice(0, MAX_LABEL_LENGTH) : '';
    const cred: PasskeyCredential = {
      id: registered.id,
      publicKey: Buffer.from(registered.publicKey).toString('base64url'),
      counter: Number(registered.counter) || 0,
      transports: registered.transports ?? attestation.response?.transports ?? [],
      rpID: rp.rpID,
      label: cleanLabel || `passkey · ${rp.rpID}`,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    store.credentials.push(cred);
    savePasskeyStore(store);
    console.log(`[Auth] Passkey enrolled for ${rp.rpID} (${store.credentials.length} total)`);
    return { ok: true, passkey: toPublicPasskey(cred) };
  }

  /** Authenticated: every enrolled passkey, public fields only. */
  list(): PublicPasskey[] {
    return loadPasskeyStore().credentials.map(toPublicPasskey);
  }

  /** Authenticated: remove a credential by id. Returns whether one was removed. */
  delete(id: string): boolean {
    const store = loadPasskeyStore();
    const before = store.credentials.length;
    store.credentials = store.credentials.filter((c) => c.id !== id);
    if (store.credentials.length === before) return false;
    savePasskeyStore(store);
    console.log(`[Auth] Passkey removed (${store.credentials.length} remaining)`);
    return true;
  }
}

export const passkeyService = new PasskeyService();
