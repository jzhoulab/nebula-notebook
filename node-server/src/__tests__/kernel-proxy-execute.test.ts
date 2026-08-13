// @vitest-environment node
/**
 * executeRemoteCode — headless execution against a kernel living on a peer
 * (allocation) server, over the same WS protocol the UI proxy speaks:
 * sync_outputs (subscribe) → execute → collect output messages → result.
 *
 * Runs against a real in-process WebSocket server standing in for the
 * compute-node client server.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { executeRemoteCode } from '../cluster/kernel-proxy';
import { serverRegistry } from '../cluster/server-registry';

type ConnScript = (ws: WebSocket, messages: any[]) => void;

let httpServer: http.Server;
let serverId: string;
let currentScript: ConnScript;

beforeAll(async () => {
  process.env.NEBULA_CLUSTER_SECRET = process.env.NEBULA_CLUSTER_SECRET || 'test-secret';

  httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer, path: undefined });
  wss.on('connection', (ws, req) => {
    if (!/^\/api\/kernels\/[^/]+\/ws$/.test(req.url || '')) {
      ws.close(1008, 'bad path');
      return;
    }
    const messages: any[] = [];
    ws.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()));
      currentScript(ws, messages);
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;

  const reg = serverRegistry.register({
    host: '127.0.0.1',
    port,
    secret: process.env.NEBULA_CLUSTER_SECRET!,
    name: 'fake-arm-client',
  } as any);
  expect(reg.success).toBe(true);
  serverId = reg.serverId!;
});

afterAll(async () => {
  serverRegistry.unregister(serverId);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));

describe('executeRemoteCode', () => {
  it('subscribes, executes, streams outputs for the cell, and returns the result', async () => {
    currentScript = (ws, messages) => {
      const last = messages[messages.length - 1];
      if (last.type === 'sync_outputs') {
        send(ws, { type: 'sync_outputs', cells: {} });
      } else if (last.type === 'execute') {
        // The remote executor must subscribe BEFORE executing — otherwise the
        // server never streams output messages to this socket.
        expect(messages[0].type).toBe('sync_outputs');
        expect(last.code).toBe('print("hi")');
        expect(last.cell_id).toBe('cell-1');
        send(ws, { type: 'status', status: 'busy', cell_id: 'cell-1' });
        send(ws, { type: 'output', output: { type: 'stdout', content: 'hi\n' }, cell_id: 'cell-1' });
        send(ws, { type: 'output', output: { type: 'stdout', content: 'other\n' }, cell_id: 'someone-else' });
        send(ws, { type: 'result', result: { status: 'ok', executionCount: 7 } });
        send(ws, { type: 'status', status: 'idle' });
      }
    };

    const outputs: any[] = [];
    const result = await executeRemoteCode(
      `${serverId}::sess-1`,
      'print("hi")',
      async (output) => { outputs.push(output); },
      'cell-1'
    );

    expect(result.status).toBe('ok');
    expect(result.executionCount).toBe(7);
    // Output for another cell (concurrent execution on the session) is not ours.
    expect(outputs).toEqual([{ type: 'stdout', content: 'hi\n' }]);
  });

  it('returns error results (tracebacks) like local executeCode does', async () => {
    currentScript = (ws, messages) => {
      const last = messages[messages.length - 1];
      if (last.type === 'sync_outputs') send(ws, { type: 'sync_outputs', cells: {} });
      else if (last.type === 'execute') {
        send(ws, { type: 'result', result: { status: 'error', executionCount: 8, error: 'NameError: boom' } });
      }
    };

    const result = await executeRemoteCode(`${serverId}::sess-2`, 'boom', async () => {}, 'cell-2');
    expect(result.status).toBe('error');
    expect(result.error).toContain('NameError');
  });

  it('rejects when the connection drops before a result (node died mid-run)', async () => {
    currentScript = (ws, messages) => {
      const last = messages[messages.length - 1];
      if (last.type === 'sync_outputs') send(ws, { type: 'sync_outputs', cells: {} });
      else if (last.type === 'execute') ws.close();
    };

    await expect(
      executeRemoteCode(`${serverId}::sess-3`, 'x', async () => {}, 'cell-3')
    ).rejects.toThrow(/closed|lost/i);
  });

  it('rejects for an unregistered server', async () => {
    await expect(
      executeRemoteCode('nosuch:1::sess', 'x', async () => {}, null)
    ).rejects.toThrow(/not found/i);
  });
});
