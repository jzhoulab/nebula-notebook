import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeBase, installBaseShims, urlWithBase, withBase } from '../basePath';

describe('basePath', () => {
  afterEach(() => { vi.unstubAllGlobals(); delete (window as Window & { __nebulaBaseShims?: boolean }).__nebulaBaseShims; });

  it('reads the base from where the built bundle was served', () => {
    expect(computeBase('https://hop.example.org/s/nebula/assets/index-AbC123.js')).toBe('/s/nebula/');
    expect(computeBase('http://localhost:3000/assets/index-AbC123.js')).toBe('/');
    expect(computeBase('http://localhost:3000/lib/basePath.ts')).toBe('/'); // dev server: at the root
    expect(computeBase('not a url')).toBe('/');
  });

  it('puts root-absolute app paths under the base, and leaves everything else', () => {
    const b = '/s/nebula/';
    expect(withBase('/api/fs/read?path=%2Fa', b)).toBe('/s/nebula/api/fs/read?path=%2Fa');
    expect(withBase('/?file=%2Fa.ipynb', b)).toBe('/s/nebula/?file=%2Fa.ipynb');
    expect(withBase('/s/nebula/api/x', b)).toBe('/s/nebula/api/x'); // already under it
    expect(withBase('//cdn.example.org/x.js', b)).toBe('//cdn.example.org/x.js');
    expect(withBase('relative/x', b)).toBe('relative/x');
    expect(withBase('/api/x', '/')).toBe('/api/x');
  });

  it('moves same-host absolute URLs (http or ws) under the base; other hosts stay', () => {
    const b = '/s/nebula/';
    expect(urlWithBase('wss://hop.example.org/api/kernels/k1/ws?token=t', 'hop.example.org', b))
      .toBe('wss://hop.example.org/s/nebula/api/kernels/k1/ws?token=t');
    expect(urlWithBase('wss://elsewhere.org/api/x', 'hop.example.org', b)).toBe('wss://elsewhere.org/api/x');
    expect(urlWithBase('https://hop.example.org/s/nebula/api/x', 'hop.example.org', b)).toBe('https://hop.example.org/s/nebula/api/x');
  });

  it('under a prefix, fetch and WebSocket reach this Nebula there; at the root nothing is wrapped', () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    const sockets: string[] = [];
    class FakeSocket { static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3; constructor(url: string) { sockets.push(url); } }
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('WebSocket', FakeSocket);
    installBaseShims('/');
    expect(window.fetch).toBe(fetchSpy);

    installBaseShims('/s/nebula/');
    void window.fetch('/api/health');
    expect(fetchSpy).toHaveBeenLastCalledWith('/s/nebula/api/health', undefined);
    const host = window.location.host;
    const ws = new window.WebSocket(`ws://${host}/api/notebook/a/ws`);
    expect(sockets.at(-1)).toBe(`ws://${host}/s/nebula/api/notebook/a/ws`);
    expect(ws).toBeInstanceOf(window.WebSocket);
    expect(window.WebSocket.OPEN).toBe(1);
  });
});
