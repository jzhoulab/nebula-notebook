/**
 * Auth Service - TOTP-based 2FA authentication
 *
 * Handles:
 * - TOTP secret generation and verification
 * - JWT session token management
 * - Auth config persistence (~/.nebula/auth.json)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { authenticator } from 'otplib';
import * as jwt from 'jsonwebtoken';
import { accountLabel, buildSetupInstructions, renderQr } from './setup-qr';

// Config file location (env override is a test seam)
const NEBULA_DIR = process.env.NEBULA_AUTH_DIR || path.join(os.homedir(), '.nebula');
const AUTH_CONFIG_FILE = path.join(NEBULA_DIR, 'auth.json');

// JWT settings
const JWT_SECRET_LENGTH = 64;
const SHORT_SESSION_HOURS = 24;
const LONG_SESSION_DAYS = 30;

export interface AuthConfig {
  totpSecret: string;
  jwtSecret: string;
  setupComplete: boolean;
  createdAt: number;
}

export interface JWTPayload {
  iat: number;
  exp: number;
  trusted: boolean;
}

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
}

export interface VerifyResult {
  success: boolean;
  token?: string;
  error?: string;
}

// Rate limiting: max 5 attempts per 30 seconds
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 30000;
// DELIBERATELY wide (±5 steps = ±2.5min): cluster login nodes have shipped
// with minutes of clock skew and a tight window locks the user out entirely.
// Availability beats the marginal brute-force surface here — do not "fix"
// this back to 1 without confirming server NTP is trustworthy everywhere.
const TOTP_WINDOW_STEPS = 5;
authenticator.options = {
  ...authenticator.options,
  window: [TOTP_WINDOW_STEPS, TOTP_WINDOW_STEPS],
};

class AuthService {
  private config: AuthConfig | null = null;
  private initialized = false;
  private failedAttempts: number[] = []; // timestamps of failed attempts
  private disabled = false;

  /**
   * Disable authentication (for local/dev usage only)
   */
  disableAuth(): void {
    this.disabled = true;
  }

  isAuthDisabled(): boolean {
    return this.disabled;
  }

  /**
   * Initialize the auth service
   * Returns true if setup is needed (first run)
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) {
      return !this.config?.setupComplete;
    }
    if (this.disabled) {
      this.initialized = true;
      return false;
    }

    // Ensure .nebula directory exists
    if (!fs.existsSync(NEBULA_DIR)) {
      fs.mkdirSync(NEBULA_DIR, { recursive: true, mode: 0o700 });
    }

    // Try to load existing config
    if (fs.existsSync(AUTH_CONFIG_FILE)) {
      try {
        const data = fs.readFileSync(AUTH_CONFIG_FILE, 'utf-8');
        this.config = JSON.parse(data);
        this.initialized = true;
        return !this.config!.setupComplete;
      } catch (err) {
        console.error('[Auth] Failed to load auth config:', err);
        // NEVER silently overwrite an existing-but-unreadable config: it may
        // hold the user's only copy of their TOTP secret (e.g. truncated by a
        // quota-full write). Preserve it for recovery before regenerating.
        try {
          const backup = `${AUTH_CONFIG_FILE}.corrupt-${Date.now()}`;
          fs.copyFileSync(AUTH_CONFIG_FILE, backup);
          console.error(`[Auth] Unreadable auth config backed up to ${backup} — regenerating fresh secrets.`);
        } catch { /* backup is best-effort */ }
      }
    }

    // No config exists - generate new secrets
    this.config = {
      totpSecret: authenticator.generateSecret(),
      jwtSecret: this.generateJWTSecret(),
      setupComplete: false,
      createdAt: Date.now(),
    };

    // Save immediately so secret persists across restarts during setup
    this.saveConfig();

    this.initialized = true;
    return true; // Setup needed
  }

  /**
   * Generate a secure random JWT secret
   */
  private generateJWTSecret(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    const randomBytes = require('crypto').randomBytes(JWT_SECRET_LENGTH);
    for (let i = 0; i < JWT_SECRET_LENGTH; i++) {
      result += chars[randomBytes[i] % chars.length];
    }
    return result;
  }

  /**
   * Save config to disk with secure permissions
   */
  private saveConfig(): void {
    if (!this.config) return;

    // Atomic write (tmp + rename): a plain writeFileSync truncates BEFORE
    // writing, so a quota-full/crashed write leaves an empty auth.json and
    // the TOTP secret then exists only in this process's memory — exactly the
    // failure that forces users to re-enroll after the next restart. With
    // rename, a failed write leaves the previous file untouched.
    const tmp = `${AUTH_CONFIG_FILE}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, AUTH_CONFIG_FILE);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* nothing partial to clean */ }
      // Loud, specific failure: the server keeps working from memory, but the
      // secret will NOT survive a restart — the user must be able to see why.
      console.error(
        `[Auth] FAILED to persist auth config to ${AUTH_CONFIG_FILE} — ` +
        `2FA secrets exist ONLY in memory and will be lost on restart. ` +
        `Check disk quota/permissions. Error:`, err
      );
      throw err;
    }
  }

  /**
   * Print QR code and manual key to terminal for initial setup
   */
  printSetupInstructions(): void {
    if (!this.config) {
      console.error('[Auth] Cannot print setup - not initialized');
      return;
    }

    const issuer = 'NebulaNotebook';
    // host:port so several Nebula installs are distinguishable in the app.
    const accountName = accountLabel(os.hostname(), process.env.PORT || process.env.NODE_SERVER_PORT || 3000);
    const otpAuthUrl = authenticator.keyuri(accountName, issuer, this.config.totpSecret);
    console.log(buildSetupInstructions(this.config.totpSecret, otpAuthUrl, renderQr(otpAuthUrl, 'small')));
  }

  /**
   * Check if 2FA setup is complete
   */
  isSetupComplete(): boolean {
    if (this.disabled) {
      return true;
    }
    return this.config?.setupComplete ?? false;
  }

  /**
   * Verify a TOTP code and issue a JWT token
   */
  verifyCode(code: string, trustBrowser: boolean = false): VerifyResult {
    if (!this.config) {
      return { success: false, error: 'Auth not initialized' };
    }

    // Rate limiting: clean old attempts and check
    const now = Date.now();
    this.failedAttempts = this.failedAttempts.filter(t => now - t < WINDOW_MS);

    if (this.failedAttempts.length >= MAX_ATTEMPTS) {
      const oldestAttempt = this.failedAttempts[0];
      const waitSeconds = Math.ceil((WINDOW_MS - (now - oldestAttempt)) / 1000);
      return { success: false, error: `Too many attempts. Try again in ${waitSeconds}s` };
    }

    // Verify TOTP code
    const isValid = authenticator.verify({
      token: code,
      secret: this.config.totpSecret,
    });

    if (!isValid) {
      this.failedAttempts.push(now);
      const remaining = MAX_ATTEMPTS - this.failedAttempts.length;
      return { success: false, error: `Invalid code. ${remaining} attempts remaining` };
    }

    // Success - clear failed attempts
    this.failedAttempts = [];

    // Mark setup as complete on first successful verification
    if (!this.config.setupComplete) {
      this.config.setupComplete = true;
      this.saveConfig();
      console.log('[Auth] Setup complete - first verification successful');
    }

    // Issue JWT token
    const token = this.issueToken(trustBrowser);

    return { success: true, token };
  }

  /**
   * Issue a new JWT token
   */
  private issueToken(trusted: boolean): string {
    if (!this.config) {
      throw new Error('Auth not initialized');
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = trusted
      ? LONG_SESSION_DAYS * 24 * 60 * 60 // 30 days
      : SHORT_SESSION_HOURS * 60 * 60; // 24 hours

    const payload: JWTPayload = {
      iat: now,
      exp: now + expiresIn,
      trusted,
    };

    return jwt.sign(payload, this.config.jwtSecret);
  }

  /**
   * Validate a JWT token
   * Returns the payload if valid, null if invalid
   */
  validateToken(token: string): JWTPayload | null {
    if (!this.config) {
      return null;
    }

    try {
      const payload = jwt.verify(token, this.config.jwtSecret) as JWTPayload;
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Get auth status for a request
   */
  getAuthStatus(token?: string): AuthStatus {
    if (this.disabled) {
      return { configured: true, authenticated: true };
    }
    const configured = this.config?.setupComplete ?? false;
    const authenticated = token ? this.validateToken(token) !== null : false;

    return { configured, authenticated };
  }

  /**
   * Get the TOTP secret (for testing only)
   * @internal
   */
  _getTotpSecret(): string | null {
    return this.config?.totpSecret ?? null;
  }
}

// Export singleton instance
export const authService = new AuthService();
