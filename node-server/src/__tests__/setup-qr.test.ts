// @vitest-environment node
/**
 * 2FA setup QR rendering. Lab report: the small Unicode QR (half-block glyphs)
 * renders as unscannable dashes/underscores in terminals whose font lacks
 * proper Block Elements coverage (web terminals, some font fallbacks). The
 * setup text must survive that: offer a font-independent fallback (ANSI
 * background-colored spaces) and always print the otpauth:// URL + manual key
 * so no environment is a dead end.
 */

import { describe, it, expect } from 'vitest';
import { renderQr, buildSetupInstructions, accountLabel } from '../auth/setup-qr';

const URL_SAMPLE = 'otpauth://totp/NebulaNotebook:local?secret=EXAMPLESECRET123&issuer=NebulaNotebook';

describe('renderQr', () => {
  it('small mode uses half-block glyphs (compact, most terminals)', () => {
    const qr = renderQr(URL_SAMPLE, 'small');
    expect(qr).toMatch(/[\u2584\u2588\u2580]/); // lower half / full / upper half block
  });

  it('big mode is font-independent: ANSI-colored spaces, no glyphs at all', () => {
    const qr = renderQr(URL_SAMPLE, 'big');
    expect(qr).toContain('\u001b[47m'); // white background
    expect(qr).toContain('\u001b[40m'); // black background
    // Strip ANSI: nothing but spaces and newlines may remain — scannability
    // must not depend on any glyph the terminal font draws.
    const stripped = qr.replace(/\u001b\[[0-9;]*m/g, '');
    expect(stripped.replace(/[ \n]/g, '')).toBe('');
  });
});

describe('buildSetupInstructions', () => {
  const text = buildSetupInstructions('EXAMPLESECRET123', URL_SAMPLE, '<QR>');

  it('embeds the QR, manual key, and the full otpauth URL', () => {
    expect(text).toContain('<QR>');
    expect(text).toContain('EXAMPLESECRET123');
    expect(text).toContain(URL_SAMPLE); // copy-paste path when no camera/QR works
  });

  it('tells the user what to do when the QR looks garbled', () => {
    expect(text).toMatch(/garbled|not scan/i);
    expect(text).toContain('npm run auth:qr');
    expect(text).toContain('--big');
  });
});

describe('accountLabel', () => {
  // Every install used the same otpauth label ("NebulaNotebook: local"), so a
  // user with a laptop instance AND a cluster instance sees two identical
  // entries in their authenticator and cannot tell which code goes where
  // (2026-08-27 report: "the 2FA code I recorded earlier doesn't work").
  it('identifies the install by host and port', () => {
    expect(accountLabel('cri22in002', 3001)).toBe('cri22in002:3001');
    expect(accountLabel('my-laptop.local', 3000)).toBe('my-laptop.local:3000');
  });

  it('degrades safely when the host is unknown or unusable in a label', () => {
    expect(accountLabel('', 3000)).toBe('local:3000');
    expect(accountLabel('host:with:colons', 3000)).toBe('host-with-colons:3000');
  });
});
