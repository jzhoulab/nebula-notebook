/**
 * 2FA setup QR rendering with a font-independent fallback.
 *
 * The compact QR uses Unicode half-block glyphs — some terminal fonts (web
 * terminals, fallback fonts without Block Elements) draw those as thin
 * dashes/underscores, making the QR unscannable (lab report 2026-08-19).
 * "big" mode instead paints SPACES with ANSI background colors: nothing to
 * scan depends on any glyph, only on color support.
 */

import * as qrcode from 'qrcode-terminal';

export type QrMode = 'small' | 'big';

/**
 * The otpauth account label. Every install used to render the same
 * "NebulaNotebook: local" entry, so a user running Nebula in two places got
 * two indistinguishable authenticator entries — and no way to tell which
 * 6-digit code belongs to which server. Host:port makes them self-labeling.
 * Colons are separators in the otpauth label grammar, so they are replaced.
 */
export function accountLabel(host: string, port: number | string): string {
  const clean = (host || '').trim().replace(/:/g, '-') || 'local';
  return `${clean}:${port}`;
}

export function renderQr(otpAuthUrl: string, mode: QrMode): string {
  let out = '';
  // qrcode-terminal invokes the callback synchronously.
  qrcode.generate(otpAuthUrl, { small: mode === 'small' }, (s: string) => { out = s; });
  return out;
}

export function buildSetupInstructions(secret: string, otpAuthUrl: string, qrString: string): string {
  const bar = '='.repeat(60);
  return [
    '',
    bar,
    '  NEBULA NOTEBOOK - 2FA SETUP',
    bar,
    '',
    'Scan this QR code with your authenticator app:',
    '',
    qrString,
    '',
    'QR garbled or does not scan? Your terminal font lacks block',
    'characters — print a font-independent (color-block) QR with:',
    '  cd node-server && npm run auth:qr -- --big',
    '',
    'Or enter this key manually: ' + secret,
    'Or paste this URL into your authenticator/password manager:',
    '  ' + otpAuthUrl,
    '',
    'Then open the Nebula UI and enter the 6-digit code.',
    bar,
    '',
  ].join('\n');
}
