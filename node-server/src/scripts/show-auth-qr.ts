import fs from 'fs';
import os from 'os';
import path from 'path';
import { authenticator } from 'otplib';
import { buildSetupInstructions, renderQr, type QrMode } from '../auth/setup-qr';

interface AuthConfigFile {
  totpSecret?: string;
  setupComplete?: boolean;
}

const AUTH_CONFIG_FILE = path.join(os.homedir(), '.nebula', 'auth.json');
const ISSUER = 'NebulaNotebook';
const ACCOUNT_NAME = 'local';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readAuthConfig(): AuthConfigFile {
  if (!fs.existsSync(AUTH_CONFIG_FILE)) {
    fail(`[Auth] Config not found: ${AUTH_CONFIG_FILE}\n[Auth] Start the Nebula server once to initialize 2FA.`);
  }

  try {
    const raw = fs.readFileSync(AUTH_CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as AuthConfigFile;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`[Auth] Failed to read ${AUTH_CONFIG_FILE}: ${detail}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`show-auth-qr — reprint the 2FA setup QR for this machine's Nebula

  npm run auth:qr              # compact QR (Unicode half-blocks)
  npm run auth:qr -- --big     # font-independent QR (ANSI color blocks) —
                               # use when the compact one renders as dashes
  npm run auth:qr -- --url     # print only the otpauth:// URL (no QR)`);
    return;
  }

  const config = readAuthConfig();
  const secret = typeof config.totpSecret === 'string' ? config.totpSecret.trim() : '';

  if (!secret) {
    fail(`[Auth] Missing "totpSecret" in ${AUTH_CONFIG_FILE}`);
  }

  const otpAuthUrl = authenticator.keyuri(ACCOUNT_NAME, ISSUER, secret);

  if (args.includes('--url')) {
    console.log(otpAuthUrl);
    return;
  }

  const mode: QrMode = args.includes('--big') ? 'big' : 'small';
  console.log(buildSetupInstructions(secret, otpAuthUrl, renderQr(otpAuthUrl, mode)));
  if (mode === 'small') {
    console.log('Garbled? Re-run with --big for a font-independent QR.');
  }
}

main();
