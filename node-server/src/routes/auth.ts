/**
 * Auth Routes - API endpoints for 2FA (TOTP) and passkey (WebAuthn) login
 *
 * Public (no session required): /auth/status, /auth/verify,
 * /auth/passkeys/login-options, /auth/passkeys/login.
 * Everything else under /auth/passkeys requires a valid session — the auth
 * middleware enforces that (see PUBLIC_ROUTES in auth-middleware.ts).
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authService } from '../auth/auth-service';
import { persistSessionToken } from '../auth/auth-middleware';
import { deriveRpInfo, passkeyService, PasskeyRpError, RpInfo } from '../auth/passkeys';

/**
 * Session length flag. Absent → long (30-day) session; only an explicit
 * `false` (or "false"/0) asks for the 24 h one. Accepts both the historical
 * `trustBrowser` key the UI sends and the shorter `trusted`.
 */
export function parseTrusted(body: unknown): boolean {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const flag = b.trusted !== undefined ? b.trusted : b.trustBrowser;
  if (flag === undefined || flag === null) return true;
  return !(flag === false || flag === 'false' || flag === 0 || flag === '0');
}

/** rpID/origin for this request, or a 400 reply (IP-literal host). */
function rpInfoOrReply(request: FastifyRequest, reply: FastifyReply): RpInfo | null {
  try {
    return deriveRpInfo(request.headers);
  } catch (err) {
    if (err instanceof PasskeyRpError) {
      reply.code(400).send({ ok: false, error: err.message, code: err.code });
      return null;
    }
    throw err;
  }
}

export default async function authRoutes(fastify: FastifyInstance) {
  /**
   * GET /auth/status
   * Check if 2FA is configured and if the current request is authenticated
   */
  fastify.get('/auth/status', async (request: FastifyRequest, reply: FastifyReply) => {
    // Extract token from Authorization header or query parameter
    let token: string | undefined;

    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }

    const status = authService.getAuthStatus(token);
    return reply.send(status);
  });

  /**
   * POST /auth/verify
   * Verify a TOTP code and issue a session token
   */
  fastify.post('/auth/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    const { code } = (request.body as any) ?? {};

    if (!code || typeof code !== 'string') {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Verification code is required',
      });
    }

    // Clean the code (remove spaces)
    const cleanCode = code.replace(/\s/g, '');

    if (!/^\d{6}$/.test(cleanCode)) {
      return reply.code(400).send({
        error: 'invalid_format',
        message: 'Code must be 6 digits',
      });
    }

    const result = authService.verifyCode(cleanCode, parseTrusted(request.body));

    if (result.success) {
      // Persist token so MCP servers and CLI tools can auto-authenticate
      if (result.token) persistSessionToken(result.token);
      return reply.send({
        success: true,
        token: result.token,
      });
    } else {
      return reply.code(401).send({
        success: false,
        error: result.error,
      });
    }
  });

  // ── Passkeys (WebAuthn) ───────────────────────────────────────────────────

  /**
   * POST /auth/passkeys/login-options  (public)
   * A login challenge for the passkeys enrolled at this hostname, or
   * `{ ok:false, error }` when there are none (the UI shows a hint).
   */
  fastify.post('/auth/passkeys/login-options', async (request: FastifyRequest, reply: FastifyReply) => {
    const rp = rpInfoOrReply(request, reply);
    if (!rp) return;
    return reply.send(await passkeyService.loginOptions(rp));
  });

  /**
   * POST /auth/passkeys/login  (public, rate-limited like TOTP)
   * Verify the assertion and issue the SAME session token TOTP issues, in the
   * same response shape, so the client's login path is shared. Passkey login
   * always gets the long (30-day) session — the device already proved itself.
   */
  fastify.post('/auth/passkeys/login', async (request: FastifyRequest, reply: FastifyReply) => {
    if (authService.isAuthDisabled()) {
      return reply.code(400).send({ success: false, error: 'Authentication is disabled on this server' });
    }
    const rp = rpInfoOrReply(request, reply);
    if (!rp) return;

    const limit = authService.checkRateLimit();
    if (!limit.allowed) {
      return reply.code(429).send({ success: false, error: `Too many attempts. Try again in ${limit.waitSeconds}s` });
    }

    const result = await passkeyService.login(rp, request.body);
    // `=== false` (not `!`): the root tsconfig has no strictNullChecks, where
    // truthiness does not narrow a boolean discriminant.
    if (result.ok === false) {
      authService.recordFailedAttempt();
      return reply.code(401).send({ success: false, error: result.error });
    }

    authService.clearFailedAttempts();
    const token = authService.issueToken(true);
    persistSessionToken(token);
    return reply.send({ success: true, token });
  });

  /**
   * POST /auth/passkeys/register-options  (authenticated)
   */
  fastify.post('/auth/passkeys/register-options', async (request: FastifyRequest, reply: FastifyReply) => {
    const rp = rpInfoOrReply(request, reply);
    if (!rp) return;
    return reply.send(await passkeyService.registerOptions(rp));
  });

  /**
   * POST /auth/passkeys/register  (authenticated)
   * Body: { token, response, label? }
   */
  fastify.post('/auth/passkeys/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const rp = rpInfoOrReply(request, reply);
    if (!rp) return;
    const result = await passkeyService.register(rp, request.body);
    if (result.ok === false) {
      return reply.code(400).send(result);
    }
    return reply.send(result);
  });

  /**
   * GET /auth/passkeys  (authenticated)
   * Every enrolled passkey (never the public keys) plus this request's rpID so
   * the UI can tell which ones apply to the address it is open at.
   */
  fastify.get('/auth/passkeys', async (request: FastifyRequest, reply: FastifyReply) => {
    let rpID: string | null = null;
    let rpError: string | null = null;
    try {
      rpID = deriveRpInfo(request.headers).rpID;
    } catch (err) {
      if (!(err instanceof PasskeyRpError)) throw err;
      rpError = err.message; // listing still works; enrolling here will not
    }
    return reply.send({ ok: true, rpID, rpError, passkeys: passkeyService.list() });
  });

  /**
   * DELETE /auth/passkeys/:id  (authenticated)
   */
  fastify.delete('/auth/passkeys/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    if (!id) {
      return reply.code(400).send({ ok: false, error: 'Passkey id is required' });
    }
    const removed = passkeyService.delete(id);
    if (!removed) {
      return reply.code(404).send({ ok: false, error: 'Passkey not found' });
    }
    return reply.send({ ok: true, removed: 1 });
  });
}
