/**
 * Auth Middleware - Protect routes and WebSocket connections
 *
 * Public routes (no auth required):
 * - /api/health
 * - /api/ready
 * - /api/auth/*
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { IncomingMessage } from 'http';
import { parse as parseUrl } from 'url';
import { timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { authService } from './auth-service';
import { readClusterSecret } from '../cluster/cluster-secret';

const SESSION_TOKEN_PATH = path.join(os.homedir(), '.nebula', 'session-token');

/**
 * Persist a session token to disk so MCP servers and CLI tools
 * can piggyback on the browser's authentication.
 */
export function persistSessionToken(token: string): void {
  try {
    const dir = path.dirname(SESSION_TOKEN_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SESSION_TOKEN_PATH, token, { mode: 0o600 });
  } catch {
    // Non-critical — MCP just won't be able to auto-auth
  }
}

/**
 * Read the persisted session token (written when browser authenticates).
 */
function readSessionToken(): string | undefined {
  try {
    if (!fs.existsSync(SESSION_TOKEN_PATH)) return undefined;
    const token = fs.readFileSync(SESSION_TOKEN_PATH, 'utf-8').trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

// Routes that don't require authentication
const PUBLIC_ROUTES = [
  '/api/health',
  '/api/ready',
  '/api/auth/status',
  '/api/auth/verify',
];

const CLUSTER_SECRET_HEADER = 'x-nebula-cluster-secret';

function isClientMode(): boolean {
  const explicit = process.env.NEBULA_CLIENT_MODE;
  if (explicit !== undefined) {
    return explicit === 'true';
  }
  return !!process.env.NEBULA_MAIN_SERVER;
}

function getClusterSecret(): string | null {
  return process.env.NEBULA_CLUSTER_SECRET || readClusterSecret() || null;
}

/**
 * Extract auth token from request
 * Checks Authorization header (Bearer token) and query parameter
 */
function extractToken(req: FastifyRequest | IncomingMessage): string | undefined {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Check query parameter (for WebSocket and MCP connections)
  // FastifyRequest has parsed query, IncomingMessage needs URL parsing
  if ('query' in req && typeof (req as any).query === 'object' && (req as any).query?.token) {
    return (req as any).query.token as string;
  }

  // Fallback: parse URL manually (for IncomingMessage / WebSocket upgrade)
  const url = (req as IncomingMessage).url;
  if (url) {
    const parsed = parseUrl(url, true);
    const token = parsed.query.token;
    if (typeof token === 'string') {
      return token;
    }
  }

  return undefined;
}

function extractClusterSecret(req: FastifyRequest | IncomingMessage): string | undefined {
  const headers = req.headers;
  const value = headers[CLUSTER_SECRET_HEADER] as string | string[] | undefined;
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Loopback = same machine (or arrived through an ssh tunnel, which
 *  terminates on this machine) — the trust boundary for the on-disk
 *  session-token fallback used by MCP/CLI tools. */
function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

function hasValidClusterSecret(req: FastifyRequest | IncomingMessage): boolean {
  const clusterSecret = getClusterSecret();
  if (!clusterSecret) {
    return false;
  }
  const provided = extractClusterSecret(req);
  return Boolean(provided && secretsEqual(provided, clusterSecret));
}

function isClusterRoute(pathname: string): boolean {
  return pathname.startsWith('/api/servers') || pathname.startsWith('/servers');
}

/**
 * Check if a path is a public route
 */
function isPublicRoute(pathname: string): boolean {
  // Exact matches
  if (PUBLIC_ROUTES.includes(pathname)) {
    return true;
  }

  // Static files (frontend assets)
  if (!pathname.startsWith('/api/')) {
    return true;
  }

  return false;
}

/**
 * Fastify onRequest hook for authentication
 */
export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Reconstruct the full pathname including the prefix
  // Fastify strips the prefix when registering under /api, so we need the raw URL
  const pathname = request.url.split('?')[0];

  if (isClientMode()) {
    // Allow public routes regardless
    if (isPublicRoute(pathname)) {
      return;
    }
    if (!getClusterSecret()) {
      return reply.code(503).send({
        error: 'cluster_secret_required',
        message: 'Cluster secret required for client mode. Set NEBULA_CLUSTER_SECRET.',
      });
    }
    if (!hasValidClusterSecret(request)) {
      return reply.code(403).send({
        error: 'cluster_auth_required',
        message: 'Cluster authentication required.',
      });
    }
    return;
  }

  if (isClusterRoute(pathname) && hasValidClusterSecret(request)) {
    return;
  }

  if (authService.isAuthDisabled()) {
    return;
  }

  // Allow public routes
  if (isPublicRoute(pathname)) {
    return;
  }

  // Check if auth is configured
  if (!authService.isSetupComplete()) {
    // During setup, only allow auth routes
    return reply.code(503).send({
      error: 'setup_required',
      message: '2FA setup not complete. Check server terminal for QR code.',
    });
  }

  // Extract and validate token
  let token = extractToken(request);

  // Fallback: if no token in request, check the persisted session token file.
  // This allows MCP servers and CLI tools to piggyback on the browser's auth
  // without needing their own TOTP flow. Loopback-only: those tools run on
  // this machine (or reach it through an ssh tunnel, which lands on
  // loopback); a token-less request from the network gets no free ride.
  // Browser requests carry Origin. Never let a cross-origin page inherit the
  // machine-local CLI/MCP credential merely because the TCP peer is loopback.
  const isBrowser = request.headers.origin !== undefined;
  const loopback = isLoopback(request.ip);
  if (!token && loopback && !isBrowser) {
    token = readSessionToken();
  }

  if (!token) {
    // Say WHY there is no credential. A CLI/agent whose tunnel terminates on
    // another host loses the loopback free ride and must not be told to
    // "log in" (a browser action that cannot help it) — name the peer and
    // the rule so the caller can self-diagnose (2026-08-17 lab incident).
    if (!isBrowser && !loopback) {
      return reply.code(401).send({
        error: 'no_token_non_loopback',
        message:
          `No auth token, and this request did not arrive from loopback (peer ${request.ip}) — ` +
          'the token-less CLI/MCP piggyback only works when the tunnel terminates on the server host itself. ' +
          'Set NEBULA_TOKEN (or ~/.nebula/token) for this client, or forward to the server\'s own localhost.',
      });
    }
    if (!isBrowser) {
      return reply.code(401).send({
        error: 'no_token_no_session',
        message:
          'No auth token, and no browser session is persisted yet (~/.nebula/session-token on the server) — ' +
          'log in once from a browser, or set NEBULA_TOKEN for this client.',
      });
    }
    return reply.code(401).send({
      error: 'auth_required',
      message: 'Authentication required. Please log in.',
    });
  }

  const payload = authService.validateToken(token);
  if (!payload) {
    return reply.code(401).send({
      error: 'invalid_token',
      message:
        'Invalid or expired token. Browser: log in again. CLI/agent: refresh the token — ' +
        'unset a stale NEBULA_TOKEN / ~/.nebula/token, or relaunch the agent from Nebula (which pushes a fresh one).',
    });
  }

  // Persist valid tokens from request headers so MCP/CLI can piggyback.
  // Only write once (when file doesn't exist or token differs).
  const requestToken = extractToken(request);
  if (requestToken) {
    const existing = readSessionToken();
    if (existing !== requestToken) {
      persistSessionToken(requestToken);
    }
  }

  // Token is valid, continue (simply return)
}

/**
 * WebSocket authentication middleware
 * Returns true if the connection is authenticated
 */
export function authWebSocketMiddleware(request: IncomingMessage): boolean {
  if (isClientMode()) {
    const clusterSecret = getClusterSecret();
    if (!clusterSecret) {
      console.log('[Auth] WebSocket rejected - cluster secret not configured');
      return false;
    }
    const provided = extractClusterSecret(request as any);
    if (!provided || !secretsEqual(provided, clusterSecret)) {
      console.log('[Auth] WebSocket rejected - invalid cluster secret');
      return false;
    }
    return true;
  }
  if (authService.isAuthDisabled()) {
    return true;
  }
  const url = request.url || '';
  const pathname = parseUrl(url).pathname || '';

  // Check if auth is configured
  if (!authService.isSetupComplete()) {
    console.log('[Auth] WebSocket rejected - setup not complete');
    return false;
  }

  // Extract and validate token from query parameter
  const token = extractToken(request);
  if (!token) {
    console.log('[Auth] WebSocket rejected - no token provided');
    return false;
  }

  const payload = authService.validateToken(token);
  if (!payload) {
    console.log('[Auth] WebSocket rejected - invalid token');
    return false;
  }

  return true;
}
