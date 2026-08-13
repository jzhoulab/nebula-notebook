// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { isTrustedBrowserOrigin } from '../server/cors-origin';

describe('browser origin trust', () => {
  it('accepts only literal loopback browser origins by default', () => {
    expect(isTrustedBrowserOrigin('http://localhost:5173')).toBe(true);
    expect(isTrustedBrowserOrigin('https://127.0.0.1:3000')).toBe(true);
    expect(isTrustedBrowserOrigin('http://127.42.7.9')).toBe(true);
    expect(isTrustedBrowserOrigin('http://[::1]:3000')).toBe(true);
  });

  it('rejects lookalikes, credentials, and non-origin URL components', () => {
    expect(isTrustedBrowserOrigin('http://127.evil.example')).toBe(false);
    expect(isTrustedBrowserOrigin('http://localhost.evil.example')).toBe(false);
    expect(isTrustedBrowserOrigin('http://user@localhost:3000')).toBe(false);
    expect(isTrustedBrowserOrigin('http://localhost:3000/path')).toBe(false);
    expect(isTrustedBrowserOrigin('not a URL')).toBe(false);
  });

  it('accepts an exact configured origin without widening it', () => {
    const configured = ['https://notebooks.example.org'];
    expect(isTrustedBrowserOrigin('https://notebooks.example.org', configured)).toBe(true);
    expect(isTrustedBrowserOrigin('https://notebooks.example.org.evil.test', configured)).toBe(false);
  });
});
