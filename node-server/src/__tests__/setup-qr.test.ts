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
import { renderQr, buildSetupInstructions } from '../auth/setup-qr';

const URL_SAMPLE = 'otpauth://totp/NebulaNotebook:local?secret=JAOUKLAUJYVSGK23&issuer=NebulaNotebook';

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
  const text = buildSetupInstructions('JAOUKLAUJYVSGK23', URL_SAMPLE, '<QR>');

  it('embeds the QR, manual key, and the full otpauth URL', () => {
    expect(text).toContain('<QR>');
    expect(text).toContain('JAOUKLAUJYVSGK23');
    expect(text).toContain(URL_SAMPLE); // copy-paste path when no camera/QR works
  });

  it('tells the user what to do when the QR looks garbled', () => {
    expect(text).toMatch(/garbled|not scan/i);
    expect(text).toContain('npm run auth:qr');
    expect(text).toContain('--big');
  });
});
