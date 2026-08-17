/**
 * Explicit credentials for the CLI/MCP client. Without a token the client
 * relies on the server's loopback piggyback — which silently breaks the moment
 * a tunnel terminates on a different host than the server. NEBULA_TOKEN (or a
 * token file) makes authentication independent of network topology.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NebulaClient } from '../notebook/client.js';
import { resolveAuthToken } from '../cli/shared.js';

const ok = () => new Response(JSON.stringify({ items: [] }), { status: 200 });

describe('NebulaClient auth token', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends Authorization: Bearer on JSON requests when a token is configured', async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _init?: RequestInit) => ok());
    vi.stubGlobal('fetch', fetchMock);
    const client = new NebulaClient({ baseUrl: 'http://localhost:3000', token: 'tok-123' });
    await client.listFiles('/tmp');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('sends the token on the raw download and multipart upload paths too', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ status: 'ok', file: { path: '/tmp/a', name: 'a' } }), { status: 200 });
    }));
    const client = new NebulaClient({ baseUrl: 'http://localhost:3000', token: 'tok-123' });
    await client.downloadFile('/tmp/a');
    await client.uploadFile('/tmp', Buffer.from('x'), 'a');
    for (const init of calls) {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
    }
  });

  it('sends no Authorization header when no token is configured (loopback piggyback path)', async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _init?: RequestInit) => ok());
    vi.stubGlobal('fetch', fetchMock);
    const client = new NebulaClient({ baseUrl: 'http://localhost:3000' });
    await client.listFiles('/tmp');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe('resolveAuthToken', () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-tok-'));
    delete process.env.NEBULA_TOKEN;
    delete process.env.NEBULA_TOKEN_FILE;
    process.env.NEBULA_STATE_DIR = dir;
  });
  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prefers NEBULA_TOKEN over everything', () => {
    process.env.NEBULA_TOKEN = ' env-tok ';
    fs.writeFileSync(path.join(dir, 'token'), 'file-tok\n');
    expect(resolveAuthToken()).toBe('env-tok');
  });

  it('then NEBULA_TOKEN_FILE, then $NEBULA_STATE_DIR/token', () => {
    const custom = path.join(dir, 'custom.tok');
    fs.writeFileSync(custom, 'custom-tok\n');
    fs.writeFileSync(path.join(dir, 'token'), 'state-tok\n');
    process.env.NEBULA_TOKEN_FILE = custom;
    expect(resolveAuthToken()).toBe('custom-tok');
    delete process.env.NEBULA_TOKEN_FILE;
    expect(resolveAuthToken()).toBe('state-tok');
  });

  it('is undefined when nothing is configured (piggyback), and ignores empty files', () => {
    expect(resolveAuthToken()).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'token'), '  \n');
    expect(resolveAuthToken()).toBeUndefined();
  });
});
