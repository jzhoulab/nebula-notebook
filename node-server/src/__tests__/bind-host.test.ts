// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { assertSafeNoAuthBind, resolveBindHost, resolveNoAuthBindHost } from '../server/bind-host';

describe('server bind host', () => {
  it('preserves the network-listening default for existing deployments', () => {
    expect(resolveBindHost([], {})).toBe('0.0.0.0');
  });

  it('accepts an explicit loopback CLI or environment binding', () => {
    expect(resolveBindHost(['node', 'server', '--host', '127.0.0.1'], {}))
      .toBe('127.0.0.1');
    expect(resolveBindHost([], { NEBULA_BIND_HOST: '::1' })).toBe('::1');
  });

  it('prefers CLI state and rejects URL-shaped or control-bearing values', () => {
    expect(resolveBindHost(
      ['node', 'server', '--host=localhost'],
      { NEBULA_BIND_HOST: '0.0.0.0' },
    )).toBe('localhost');
    expect(() => resolveBindHost([], { NEBULA_BIND_HOST: 'http://127.0.0.1' }))
      .toThrow(/bind host/i);
    expect(() => resolveBindHost([], { NEBULA_BIND_HOST: '127.0.0.1\nspoof' }))
      .toThrow(/bind host/i);
  });

  it('allows no-auth only on a literal loopback bind', () => {
    expect(() => assertSafeNoAuthBind('127.0.0.1')).not.toThrow();
    expect(() => assertSafeNoAuthBind('::1')).not.toThrow();
    expect(() => assertSafeNoAuthBind('localhost')).not.toThrow();
    expect(() => assertSafeNoAuthBind('0.0.0.0')).toThrow(/no-auth.*loopback/i);
    expect(() => assertSafeNoAuthBind('notebooks.example.org')).toThrow(/no-auth.*loopback/i);
  });

  it('no-auth with no chosen host defaults to loopback instead of refusing', () => {
    // `NEBULA_NO_AUTH=true npx nebula-notebook` (the pack smoke / quickstart
    // flow) must boot — and must never accidentally listen on the network.
    expect(resolveNoAuthBindHost([], {})).toBe('127.0.0.1');
    expect(resolveNoAuthBindHost([], { NEBULA_NO_AUTH: 'true' })).toBe('127.0.0.1');
  });

  it('no-auth honors an explicit loopback host and refuses an explicit network one', () => {
    expect(resolveNoAuthBindHost(['node', 'server', '--host', '::1'], {})).toBe('::1');
    expect(resolveNoAuthBindHost([], { NEBULA_BIND_HOST: 'localhost' })).toBe('localhost');
    expect(() => resolveNoAuthBindHost(['node', 'server', '--host', '0.0.0.0'], {}))
      .toThrow(/no-auth.*loopback/i);
    expect(() => resolveNoAuthBindHost([], { NEBULA_BIND_HOST: 'notebooks.example.org' }))
      .toThrow(/no-auth.*loopback/i);
  });
});
