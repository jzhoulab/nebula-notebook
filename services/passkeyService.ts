/**
 * Passkey Service - Frontend client for WebAuthn (Touch ID / Face ID /
 * security key) login and enrollment.
 *
 * Login mints the same session token the TOTP path does and stores it through
 * authService, so everything downstream (fetch interceptor, WebSocket URLs) is
 * shared. Passkeys are scoped to the hostname the page is open at (the rpID):
 * one enrolled at `localhost` (ssh tunnel) is offered at `localhost` only.
 */

import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { authService } from './authService';

const API_BASE = '/api';

export interface PasskeyInfo {
  id: string;
  rpID: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PasskeyList {
  /** rpID of the address the page is open at; null when it is an IP literal. */
  rpID: string | null;
  /** Why passkeys cannot be enrolled at this address (IP literal), if so. */
  rpError: string | null;
  passkeys: PasskeyInfo[];
}

export type PasskeyLoginResult =
  | { status: 'ok' }
  /** Nothing enrolled at this hostname — fall back to the code. */
  | { status: 'none'; message: string }
  /** The user dismissed the platform prompt; nothing to report. */
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export type PasskeyAddResult =
  | { ok: true; passkey: PasskeyInfo }
  | { ok: false; cancelled?: boolean; error: string };

/** True when this browser can do WebAuthn at all (the button is shown then). */
export function passkeysSupported(): boolean {
  try {
    return typeof window !== 'undefined' && browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** Hostname the page is open at — the rpID a new passkey will be bound to. */
export function currentRpID(): string {
  return typeof window !== 'undefined' ? window.location.hostname : 'localhost';
}

/** "Mac · localhost" style default label for a new passkey. */
export function defaultPasskeyLabel(): string {
  return `${platformName()} · ${currentRpID()}`;
}

function platformName(): string {
  if (typeof navigator === 'undefined') return 'This device';
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux';
  return 'This device';
}

function isUserCancel(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

function messageOf(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as any).message === 'string') {
    return (err as any).message;
  }
  return fallback;
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

const SECURE_CONTEXT_HINT =
  'Passkeys need a secure context — open Nebula at http://localhost:PORT (e.g. through an ssh tunnel) or over https.';

/**
 * Full passkey login: challenge → platform prompt → verify → store the session.
 */
export async function loginWithPasskey(): Promise<PasskeyLoginResult> {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return { status: 'error', message: SECURE_CONTEXT_HINT };
  }
  let optionsBody: any;
  try {
    const res = await fetch(`${API_BASE}/auth/passkeys/login-options`, { method: 'POST' });
    optionsBody = await readJson(res);
    if (!res.ok) {
      return { status: 'error', message: optionsBody.error || `Server error (${res.status})` };
    }
  } catch {
    return { status: 'error', message: 'Network error' };
  }
  if (!optionsBody.ok) {
    return { status: 'none', message: optionsBody.error || 'No passkey enrolled here' };
  }

  let assertion;
  try {
    assertion = await startAuthentication({ optionsJSON: optionsBody.options });
  } catch (err) {
    if (isUserCancel(err)) return { status: 'cancelled' };
    return { status: 'error', message: messageOf(err, 'Passkey prompt failed') };
  }

  try {
    const res = await fetch(`${API_BASE}/auth/passkeys/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: optionsBody.token, response: assertion }),
    });
    const data = await readJson(res);
    if (data.success && data.token) {
      authService.setToken(data.token);
      return { status: 'ok' };
    }
    return { status: 'error', message: data.error || 'Passkey verification failed' };
  } catch {
    return { status: 'error', message: 'Network error' };
  }
}

/** Enrolled passkeys (public fields only) plus this address's rpID. */
export async function listPasskeys(): Promise<PasskeyList> {
  const res = await fetch(`${API_BASE}/auth/passkeys`);
  const data = await readJson(res);
  if (!res.ok || !data.ok) {
    throw new Error(data.error || data.message || `Could not load passkeys (${res.status})`);
  }
  return { rpID: data.rpID ?? null, rpError: data.rpError ?? null, passkeys: data.passkeys ?? [] };
}

/**
 * Enroll this device: challenge → platform prompt → verify. Requires an
 * authenticated session (the fetch interceptor attaches it).
 */
export async function addPasskey(label?: string): Promise<PasskeyAddResult> {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return { ok: false, error: SECURE_CONTEXT_HINT };
  }
  let optionsBody: any;
  try {
    const res = await fetch(`${API_BASE}/auth/passkeys/register-options`, { method: 'POST' });
    optionsBody = await readJson(res);
    if (!res.ok || !optionsBody.ok) {
      return { ok: false, error: optionsBody.error || optionsBody.message || `Could not start enrollment (${res.status})` };
    }
  } catch {
    return { ok: false, error: 'Network error' };
  }

  let attestation;
  try {
    attestation = await startRegistration({ optionsJSON: optionsBody.options });
  } catch (err) {
    if (isUserCancel(err)) return { ok: false, cancelled: true, error: 'Cancelled' };
    const name = (err as { name?: string } | null)?.name;
    if (name === 'InvalidStateError') {
      return { ok: false, error: 'This device already has a passkey for this address.' };
    }
    return { ok: false, error: messageOf(err, 'Passkey enrollment failed') };
  }

  try {
    const res = await fetch(`${API_BASE}/auth/passkeys/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: optionsBody.token, response: attestation, label: label || defaultPasskeyLabel() }),
    });
    const data = await readJson(res);
    if (res.ok && data.ok && data.passkey) {
      return { ok: true, passkey: data.passkey };
    }
    return { ok: false, error: data.error || data.message || 'Passkey enrollment failed' };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function deletePasskey(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await readJson(res);
  if (!res.ok || !data.ok) {
    throw new Error(data.error || data.message || `Could not remove passkey (${res.status})`);
  }
}
