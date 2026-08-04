import { afterEach, describe, expect, it, vi } from 'vitest';
import { NebulaClient } from '../notebook/client.js';

const okBody = (path: string, name: string) =>
  new Response(JSON.stringify({ status: 'ok', file: { path, name } }), { status: 200 });

describe('NebulaClient uploadFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends path before file in multipart uploads', async () => {
    const client = new NebulaClient({ baseUrl: 'http://localhost:3000' });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      expect(body).toBeInstanceOf(FormData);

      const formData = body as FormData;
      expect(Array.from(formData.keys())).toEqual(['path', 'file']);
      expect(formData.get('path')).toBe('/tmp');

      const filePart = formData.get('file');
      expect(filePart).toBeInstanceOf(File);
      expect((filePart as File).name).toBe('demo.bin');

      return okBody('/tmp/demo.bin', 'demo.bin');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await client.uploadFile('/tmp', Buffer.from('hello'), 'demo.bin');

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ path: '/tmp/demo.bin', name: 'demo.bin' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes the conflict policy as a query param', async () => {
    const client = new NebulaClient({ baseUrl: 'http://localhost:3000' });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/api/fs/upload?on_conflict=fail');
      return okBody('/tmp/demo.bin', 'demo.bin');
    });
    vi.stubGlobal('fetch', fetchMock);
    await client.uploadFile('/tmp', Buffer.from('x'), 'demo.bin', { onConflict: 'fail' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the SERVER's stored path — under 'rename' it differs from the request", async () => {
    const client = new NebulaClient({ baseUrl: 'http://localhost:3000' });
    // The reported failure: agent asked for train.py, server stored train_1.py,
    // and the old client threw the answer away and claimed train.py was written.
    vi.stubGlobal('fetch', vi.fn(async () => okBody('/w/train_1.py', 'train_1.py')));
    const result = await client.uploadFile('/w', Buffer.from('x'), 'train.py', { onConflict: 'rename' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ path: '/w/train_1.py', name: 'train_1.py' });
  });

  it('surfaces a 409 conflict as an error with the server detail', async () => {
    const client = new NebulaClient({ baseUrl: 'http://localhost:3000' });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ detail: 'already exists: /w/train.py' }), { status: 409 })));
    const result = await client.uploadFile('/w', Buffer.from('x'), 'train.py', { onConflict: 'fail' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists: /w/train.py');
  });

  it('tolerates an older server that returns no body (falls back to the requested path)', async () => {
    const client = new NebulaClient({ baseUrl: 'http://localhost:3000' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const result = await client.uploadFile('/tmp', Buffer.from('x'), 'demo.bin');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ path: '/tmp/demo.bin', name: 'demo.bin' });
  });
});
