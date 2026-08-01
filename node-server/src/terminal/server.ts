/**
 * Terminal Server - Routes and WebSocket setup for PTY management
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { ptyManager } from './pty-manager';
import { agentRegistry } from './agent-registry';
import { terminalBindings, SHARED_SHELL_NAME, TerminalBindingScope } from './binding-store';
import { remoteAgentConfig } from './remote-agent-config';
import { fsService } from '../fs/fs-service';
import {
  CreateTerminalRequest,
  ResizeTerminalRequest,
  ClientMessage,
  ServerMessage,
} from './types';

// Get configured root directory for terminals
function getDefaultCwd(): string {
  return fsService.normalizePath('~');
}

// Nebula repo root on the server (parent of node-server). Surfaced so the UI
// can show a path-qualified MCP setup command — agents/users won't know where
// the repo lives, and `npm run setup-mcp` only works from inside it.
// Works from both src/ (tsx) and dist/ (build): each is 3 levels deep.
const NEBULA_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Track WebSocket connections by terminal ID
const wsConnections = new Map<string, Set<WebSocket>>();

/**
 * Setup terminal REST routes as a Fastify plugin
 */
export async function setupTerminalRoutes(fastify: FastifyInstance): Promise<void> {
  // Terminal health check (includes terminal count and repo root for the
  // path-qualified MCP setup hint shown in the agent terminal UI, plus
  // hostname/port so the UI can compose an exact SSH tunnel command)
  fastify.get('/api/terminals/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      status: 'ok',
      terminals: ptyManager.list().length,
      repo_root: NEBULA_REPO_ROOT,
      hostname: os.hostname(),
      port: Number(process.env.PORT) || 3000,
    });
  });

  // Remote-agent config: ONE per installation, owned by the server, so every
  // browser converges on the same reverse port (per-browser random ports
  // orphaned the user's standing tunnel) and inherits a completed setup
  // instead of re-prompting for it (both lab reports). The claim* params let
  // the FIRST browser to sync donate what it already had working; stored
  // truth always wins afterwards.
  fastify.get('/api/terminals/agent-config', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string | undefined>;
    const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
    return reply.send(remoteAgentConfig.claim({
      port: num(q.claimPort),
      user: q.claimUser,
      localSshPort: num(q.claimSshPort),
      jumpHost: q.claimJump,
      localUrl: q.claimUrl,
    }));
  });

  fastify.put('/api/terminals/agent-config', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as Record<string, unknown> | null) || {};
    // Only fields actually present are touched (undefined keeps, null erases).
    const pick = (k: string) => (k in body ? (body[k] as never) : undefined);
    return reply.send(remoteAgentConfig.patch({
      port: pick('port'), user: pick('user'), localSshPort: pick('localSshPort'),
      jumpHost: pick('jumpHost'), localUrl: pick('localUrl'),
    }));
  });

  // Probe a loopback port on THIS host — used by remote-agent mode to detect
  // whether the user's reverse SSH channel (ssh -R <port>:localhost:22) is up.
  // Loopback-only by construction; the port is user-chosen and random.
  fastify.get('/api/terminals/reverse-check', async (request: FastifyRequest, reply: FastifyReply) => {
    const port = Number((request.query as { port?: string }).port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return reply.status(400).send({ error: 'port must be an integer in 1024-65535' });
    }
    // Two-signal probe at the cost of one connection: `up` = the listener
    // accepted (fast path, unchanged); `ssh` = an SSH banner arrived within
    // 700ms of connecting (an sshd greets immediately with "SSH-2.0-...").
    // ssh=false means the port is forwarded but nothing SSH answers — the
    // classic Remote-Login-off case; ssh=null means banner unknown (slow
    // network) and MUST NOT be treated as a failure.
    const result = await new Promise<{ up: boolean; ssh: boolean | null }>((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port, timeout: 1200 });
      let bannerTimer: NodeJS.Timeout | null = null;
      const finish = (up: boolean, ssh: boolean | null) => {
        if (bannerTimer) clearTimeout(bannerTimer);
        sock.destroy();
        resolve({ up, ssh });
      };
      sock.once('connect', () => {
        bannerTimer = setTimeout(() => finish(true, null), 700);
        sock.once('data', (buf) => finish(true, buf.toString('latin1').startsWith('SSH-')));
      });
      sock.once('timeout', () => finish(false, null));
      sock.once('error', () => finish(false, null));
    });
    return reply.send({ up: result.up, ssh: result.ssh });
  });

  // List all terminals
  // ---- Agent registry: project-scoped agent sessions (see agent-registry.ts) ----
  fastify.get('/api/agents', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ agents: agentRegistry.listEnriched() });
  });

  fastify.post('/api/agents/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const b = (request.body ?? {}) as Partial<{
      terminalId: string; kind: 'claude' | 'codex'; workdir: string;
      location: 'server' | 'remote'; sessionId: string; launchedFrom: string;
      mirrorSlug: string;
    }>;
    if (!b.terminalId || !b.kind || !b.workdir) {
      return reply.code(400).send({ error: 'terminalId, kind, workdir required' });
    }
    const record = agentRegistry.register({
      terminalId: b.terminalId,
      kind: b.kind === 'codex' ? 'codex' : 'claude',
      workdir: b.workdir,
      location: b.location === 'remote' ? 'remote' : 'server',
      sessionId: b.sessionId,
      launchedFrom: b.launchedFrom,
      mirrorSlug: b.mirrorSlug,
    });
    return reply.send(record);
  });

  fastify.post('/api/agents/:id/hibernate', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    if (!agentRegistry.hibernate(id)) return reply.code(404).send({ error: 'unknown agent' });
    return reply.send({ ok: true });
  });

  fastify.delete('/api/agents/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    if (!agentRegistry.remove(id)) return reply.code(404).send({ error: 'unknown agent' });
    return reply.send({ ok: true });
  });

  fastify.get('/api/terminals', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(ptyManager.list());
  });

  // Create a new terminal
  fastify.post('/api/terminals', async (request: FastifyRequest, reply: FastifyReply) => {
    const options: CreateTerminalRequest = (request.body as any) || {};
    // Use configured root directory as default cwd
    const finalOptions = { cwd: getDefaultCwd(), ...options };

    try {
      const terminal = ptyManager.create(finalOptions);
      console.log(`[Terminal] Created terminal ${terminal.id} (PID: ${terminal.pid})`);
      return reply.code(201).send(terminal);
    } catch (error) {
      console.error('[Terminal] Failed to create terminal:', error);
      return reply.code(500).send({
        error: 'Failed to create terminal',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Get or create a named terminal (for persistent terminals via URL)
  fastify.post('/api/terminals/named/:name', async (request: FastifyRequest, reply: FastifyReply) => {
    const { name } = request.params as any;
    const options: CreateTerminalRequest = (request.body as any) || {};
    // Use configured root directory as default cwd
    const finalOptions = { cwd: getDefaultCwd(), ...options };

    try {
      const terminal = ptyManager.getOrCreate(name, finalOptions);
      console.log(`[Terminal] Get/create named terminal '${name}' -> ${terminal.id}`);
      return reply.send(terminal);
    } catch (error) {
      console.error('[Terminal] Failed to get/create named terminal:', error);
      return reply.code(500).send({
        error: 'Failed to get/create terminal',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // --- Terminal bindings: which named pty a notebook's panel attaches to ---
  // GET returns the stored binding, or the plane default when none is stored
  // (shell → server-shared srv-main; agent → project scope, name resolved
  // client-side from the chosen workdir).
  fastify.get('/api/terminals/binding', async (request: FastifyRequest, reply: FastifyReply) => {
    const { file_path, plane } = request.query as { file_path?: string; plane?: string };
    if (!file_path || (plane !== 'shell' && plane !== 'agent')) {
      return reply.code(400).send({ detail: 'file_path and plane (shell|agent) are required' });
    }
    const stored = terminalBindings.get(file_path, plane);
    if (stored) {
      return reply.send({
        plane, scope: stored.scope, name: stored.name,
        custom_name: stored.customName ?? null, stored: true,
      });
    }
    if (plane === 'shell') {
      return reply.send({ plane, scope: 'server', name: SHARED_SHELL_NAME, custom_name: null, stored: false });
    }
    return reply.send({ plane, scope: 'project', name: null, custom_name: null, stored: false });
  });

  fastify.put('/api/terminals/binding', async (request: FastifyRequest, reply: FastifyReply) => {
    const { file_path, plane, scope, name } = (request.body as {
      file_path?: string; plane?: string; scope?: string; name?: string;
    }) || {};
    if (!file_path || (plane !== 'shell' && plane !== 'agent')) {
      return reply.code(400).send({ detail: 'file_path and plane (shell|agent) are required' });
    }
    if (!['server', 'project', 'notebook', 'named'].includes(scope || '')) {
      return reply.code(400).send({ detail: 'scope must be server|project|notebook|named' });
    }
    try {
      const binding = terminalBindings.set(file_path, plane, scope as TerminalBindingScope, name);
      return reply.send({
        plane, scope: binding.scope, name: binding.name,
        custom_name: binding.customName ?? null, stored: true,
      });
    } catch (e) {
      return reply.code(400).send({ detail: e instanceof Error ? e.message : 'Invalid binding' });
    }
  });

  fastify.delete('/api/terminals/binding', async (request: FastifyRequest, reply: FastifyReply) => {
    const { file_path, plane } = request.query as { file_path?: string; plane?: string };
    if (!file_path || (plane !== 'shell' && plane !== 'agent')) {
      return reply.code(400).send({ detail: 'file_path and plane (shell|agent) are required' });
    }
    terminalBindings.delete(file_path, plane);
    return reply.send({ ok: true });
  });

  // Tty-foreground probe: is something running in this pty's foreground (a
  // TUI, an ssh hop, a command)? Clients MUST check this before typing a
  // launch command into an existing pty — records can mis-score liveness (a
  // hand-resumed agent never re-registers), and a launch line typed into a
  // live TUI becomes a chat prompt (lab report). A fresh login shell sourcing
  // rc files reads false — its init children never own the tty.
  // busy:null = unknown (pty gone / foreground unreadable) — claim nothing.
  fastify.get('/api/terminals/:id/busy', async (request: FastifyRequest, reply: FastifyReply) => {
    const busy = ptyManager.isBusy((request.params as any).id);
    return reply.send({ busy });
  });

  // Get terminal info
  fastify.get('/api/terminals/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const terminal = ptyManager.getTerminalInfo((request.params as any).id);

    if (!terminal) {
      return reply.code(404).send({ error: 'Terminal not found' });
    }

    return reply.send(terminal);
  });

  // Delete/close a terminal
  fastify.delete('/api/terminals/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const success = ptyManager.kill((request.params as any).id);

    if (!success) {
      return reply.code(404).send({ error: 'Terminal not found' });
    }

    console.log(`[Terminal] Closed terminal ${(request.params as any).id}`);
    return reply.send({ status: 'ok' });
  });

  // Resize terminal
  fastify.post('/api/terminals/:id/resize', async (request: FastifyRequest, reply: FastifyReply) => {
    const { cols, rows }: ResizeTerminalRequest = request.body as any;

    if (!cols || !rows) {
      return reply.code(400).send({ error: 'cols and rows are required' });
    }

    const success = ptyManager.resize((request.params as any).id, cols, rows);

    if (!success) {
      return reply.code(404).send({ error: 'Terminal not found' });
    }

    return reply.send({ status: 'ok', cols, rows });
  });
}

/**
 * Setup terminal WebSocket server with noServer mode
 * Returns the WSS so the upgrade can be handled externally
 */
export function setupTerminalWebSocket(server: HttpServer): WebSocketServer {
  // Use noServer mode to avoid conflicts with kernel WebSocket
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,  // Disable compression
  });

  // Handle upgrade requests for /ws path
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

    if (pathname === '/ws') {
      // Authenticate WebSocket connection
      const { authWebSocketMiddleware } = require('../auth');
      if (!authWebSocketMiddleware(request)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
    // Don't destroy socket for non-matching paths - let other handlers deal with it
  });

  wss.on('connection', (ws: WebSocket, req) => {
    // Extract terminal ID from URL query
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const terminalId = url.searchParams.get('id');

    if (!terminalId) {
      ws.close(4000, 'Terminal ID required');
      return;
    }

    const session = ptyManager.get(terminalId);
    if (!session) {
      ws.close(4004, 'Terminal not found');
      return;
    }

    console.log(`[Terminal] WebSocket connected to terminal ${terminalId}`);

    // Track this connection
    if (!wsConnections.has(terminalId)) {
      wsConnections.set(terminalId, new Set());
    }
    const connections = wsConnections.get(terminalId)!;
    connections.add(ws);

    // Send buffered output for reconnection
    const buffer = ptyManager.getOutputBuffer(terminalId);
    if (buffer) {
      // Append an authoritative reassert of the sticky input modes so a
      // reconnect never leaves mouse/focus reporting dangling on at the shell
      // (the buffer trim can drop or split the app's own mode-reset).
      const info = ptyManager.getTerminalInfo(terminalId);
      const replayMsg: ServerMessage = {
        type: 'replay',
        data: buffer + ptyManager.getModeReset(terminalId),
        cols: info?.cols,
        rows: info?.rows,
      };
      ws.send(JSON.stringify(replayMsg));
    }

    // One subscription per websocket, sending only to ITS socket — the pty
    // layer now multicasts, so no shared-closure broadcast trickery needed.
    const unsubData = ptyManager.addDataListener(terminalId, (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data } satisfies ServerMessage));
      }
    });
    const unsubExit = ptyManager.addExitListener(terminalId, (code: number) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code } satisfies ServerMessage));
      }
    });

    // Handle incoming messages
    ws.on('message', (rawData) => {
      try {
        const message: ClientMessage = JSON.parse(rawData.toString());

        switch (message.type) {
          case 'input':
            ptyManager.write(terminalId, message.data);
            break;

          case 'resize':
            ptyManager.resize(terminalId, message.cols, message.rows);
            break;

          default:
            console.warn(`[Terminal] Unknown message type:`, message);
        }
      } catch (error) {
        console.error('[Terminal] Failed to parse message:', error);
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      console.log(`[Terminal] WebSocket disconnected from terminal ${terminalId}`);

      unsubData();
      unsubExit();
      const connections = wsConnections.get(terminalId);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
          wsConnections.delete(terminalId);
        }
      }
    });

    ws.on('error', (error) => {
      console.error(`[Terminal] WebSocket error for terminal ${terminalId}:`, error);
    });
  });

  return wss;
}

/**
 * Cleanup all terminals (call on shutdown)
 */
export function cleanupTerminals(): void {
  ptyManager.killAll();
}
