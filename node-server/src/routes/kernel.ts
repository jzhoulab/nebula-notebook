/**
 * Kernel API Routes
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KernelService } from '../kernel/kernel-service';
import { getKernelSearchPaths, getKernelSpec, resolveKernelSpec, envKernelPythonPath } from '../kernel/kernelspec';
import { pythonDiscovery } from '../discovery/discovery-service';
import { KernelProvisionError } from '../discovery/types';
import { fsService } from '../fs/fs-service';
import { operationRouter } from '../notebook/operation-router';
import {
  isProxiedSession,
  parseSessionId,
  startRemoteKernel,
  interruptRemoteKernel,
  restartRemoteKernel,
  shutdownRemoteKernel,
  getRemoteKernelStatus,
  getRemoteKernels,
  getRemoteKernelSessions,
  getRemoteDeadKernelSessions,
  cleanupRemoteDeadKernelSessions,
  createProxiedSessionId,
  createWebSocketProxy,
} from '../cluster/kernel-proxy';
import { serverRegistry } from '../cluster/server-registry';
import { allocationService } from '../scheduler/allocation-service';
import {
  assertPathMutable,
  sealedErrorBody,
  SealedPathLockedError,
} from '../fs/sealed-path';

// Track all WebSocket connections per kernel session for broadcasting
const sessionWebSockets: Map<string, Set<WebSocket>> = new Map();

// Only send streaming outputs to sockets after they've performed an initial output sync.
// This prevents a race where live `output` messages arrive before `sync_outputs`, causing
// the frontend to advance its seq watermark and skip replayed outputs on refresh/reconnect.
const outputSubscribedSockets: WeakSet<WebSocket> = new WeakSet();

// Shared kernel service instance - exported for use by headless handler
const kernelService = new KernelService();
// When a kernel dies (crash, OOM, reattached PID gone), push the status to
// every client immediately — otherwise the UI shows 'busy' until the next
// poll or failed execute.
kernelService.onSessionDead((sessionId: string) => {
  const sockets = sessionWebSockets.get(sessionId);
  if (!sockets || sockets.size === 0) return;
  const msg = JSON.stringify({ type: 'status', status: 'dead' });
  for (const socket of sockets) {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(msg);
    } catch {
      // Socket already closing — the reconnect loop will handle it
    }
  }
});

// Broadcast kernel-originated comm messages (ipywidgets state sync, etc.) to
// every client attached to the session. This includes idle-time traffic from
// widget observers — comm messages are demuxed regardless of parent request.
kernelService.onComm((sessionId: string, comm) => {
  const sockets = sessionWebSockets.get(sessionId);
  if (!sockets || sockets.size === 0) return;
  const msg = JSON.stringify({
    type: 'comm',
    comm: {
      msg_type: comm.msgType,
      comm_id: comm.commId,
      ...(comm.targetName !== undefined && { target_name: comm.targetName }),
      data: comm.data,
      ...(comm.buffers && { buffers: comm.buffers }),
    },
  });
  for (const socket of sockets) {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(msg);
    } catch {
      // Socket already closing — the reconnect loop will handle it
    }
  }
});

// Initialize kernel service on module load
kernelService.initialize().catch(err => {
  console.error('Failed to initialize kernel service:', err);
});

function buildKernelMetadata(kernelName: string): Record<string, unknown> {
  // env: kernels have no on-disk spec — synthesize one, preferring the
  // discovery cache's label ("Python 3.10 (conda: hypir)") over the raw path.
  const envPython = envKernelPythonPath(kernelName);
  const cachedLabel = envPython ? pythonDiscovery.getFromCache()?.[envPython]?.displayName : undefined;
  const spec = resolveKernelSpec(kernelName, cachedLabel);
  return {
    kernelspec: {
      name: kernelName,
      display_name: spec?.displayName || (kernelName === 'python3' ? 'Python 3' : kernelName),
      language: spec?.language || 'python',
    },
  };
}

/**
 * Map provisioning failures to structured responses (matching routes/python.ts)
 * so the UI can branch on `code` — e.g. open the ipykernel install prompt —
 * instead of parsing error prose. Returns true if the error was handled.
 */
function sendProvisionError(reply: FastifyReply, err: unknown): boolean {
  if (!(err instanceof KernelProvisionError)) return false;
  const status = err.code === 'python_not_found' ? 404
    : err.code === 'externally_managed' || err.code === 'needs_ipykernel' ? 422
    : 500;
  reply.code(status).send({ detail: err.message, code: err.code, install_hint: err.installHint });
  return true;
}

function sendSealedError(reply: FastifyReply, err: unknown): boolean {
  if (!(err instanceof SealedPathLockedError)) return false;
  reply.code(err.statusCode).send(sealedErrorBody(err));
  return true;
}

async function persistNotebookKernelMetadata(
  filePath: string,
  kernelName: string
): Promise<{ changed?: boolean; mtime?: number }> {
  // Best-effort: persisting the kernel choice into the notebook's metadata is a
  // secondary side-effect. If it fails (e.g. the notebook file doesn't exist yet,
  // or isn't writable), the kernel session itself is still valid — don't fail the
  // whole request. The choice gets re-persisted on the next save.
  try {
    const result = await fsService.updateNotebookMetadata(filePath, buildKernelMetadata(kernelName));
    if (!result.success) {
      console.warn(`[Kernel] Could not persist kernel metadata for ${filePath}: ${result.error}`);
      return {};
    }
    return {
      changed: result.changed,
      mtime: result.mtime,
    };
  } catch (err) {
    console.warn(`[Kernel] Could not persist kernel metadata for ${filePath}:`, err);
    return {};
  }
}

/**
 * Setup WebSocket handler for kernel execution
 */
export function setupKernelWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req) => {
    // Extract session ID from URL path: /api/kernels/{sessionId}/ws
    const url = req.url || '';
    const match = url.match(/\/api\/kernels\/([^/]+)\/ws/);
    if (!match) {
      ws.close(1008, 'Invalid path');
      return;
    }

    const sessionId = decodeURIComponent(match[1]);

    // Check if this is a proxied session
    if (isProxiedSession(sessionId)) {
      console.log(`[Kernel WS] Creating proxy for remote session ${sessionId}`);
      const remoteWs = createWebSocketProxy(sessionId, ws);
      if (!remoteWs) {
        ws.send(JSON.stringify({ type: 'error', error: 'Failed to connect to remote server' }));
        ws.close(1008, 'Failed to connect to remote server');
      }
      return;
    }

    ws.on('error', (err) => {
      console.error(`[Kernel WS] WebSocket error for session ${sessionId}:`, err);
    });

    // Validate session exists and register socket before handling any messages.
    // Use a fast session snapshot here to avoid `ps`/memory lookups blocking the
    // initial `sync_outputs` handshake on refresh/reconnect.
    const session = kernelService.getSessionStatusFast(sessionId);
    if (!session) {
      console.log(`[Kernel WS] Session ${sessionId} not found, closing connection`);
      ws.send(JSON.stringify({ type: 'error', error: 'Session not found' }));
      ws.close(1008, 'Session not found');
      return;
    }

    console.log(`[Kernel WS] Connected for session ${sessionId} (kernel: ${session.kernelName}, status: ${session.status})`);

    // Track this WebSocket for broadcasting
    if (!sessionWebSockets.has(sessionId)) {
      sessionWebSockets.set(sessionId, new Set());
    }
    sessionWebSockets.get(sessionId)!.add(ws);

    // Send initial status so frontend knows the kernel state immediately
    const executingCellId = kernelService.getExecutingCellId(sessionId);
    ws.send(JSON.stringify({ type: 'status', status: session.status, ...(executingCellId != null && { cell_id: executingCellId }) }));

    const handleMessage = async (raw: string) => {
      try {
        const message = JSON.parse(raw);

        if (message.type === 'execute') {
          const code = message.code || '';
          const cellId = message.cell_id || null;

          // Broadcast helper: send to all connected WebSockets for this session
          const broadcast = (msg: string, options?: { outputsOnly?: boolean }) => {
            const outputsOnly = options?.outputsOnly ?? false;
            const sockets = sessionWebSockets.get(sessionId);
            if (sockets) {
              for (const socket of sockets) {
                if (socket.readyState === WebSocket.OPEN) {
                  if (outputsOnly && !outputSubscribedSockets.has(socket)) continue;
                  socket.send(msg);
                }
              }
            }
          };

          // Send busy status to all clients
          broadcast(JSON.stringify({ type: 'status', status: 'busy', ...(cellId != null && { cell_id: cellId }) }));

          // Execute code with streaming output broadcast to all clients
          const result = await kernelService.executeCode(
            sessionId,
            code,
            async (output, outputCellId) => {
              broadcast(JSON.stringify({
                type: 'output',
                output,
                cell_id: outputCellId ?? null,
              }), { outputsOnly: true });
            },
            undefined,
            cellId
          );

          // Broadcast result and idle status to all clients
          broadcast(JSON.stringify({ type: 'result', result }));
          broadcast(JSON.stringify({ type: 'status', status: 'idle' }));
        } else if (message.type === 'sync_outputs') {
          // Send complete cell output arrays for all buffered cells (replace semantics)
          const cellOutputs = kernelService.getAllCellOutputs(sessionId);
          const cells: Record<string, Array<Record<string, unknown>>> = {};
          for (const [cId, outputs] of cellOutputs) {
            cells[cId] = outputs.map(o => ({ ...o }));
          }

          const executingCellId = kernelService.getExecutingCellId(sessionId);
          ws.send(JSON.stringify({ type: 'sync_outputs', cells, executing_cell: executingCellId }));

          // Only start streaming outputs after the client has performed an initial sync.
          outputSubscribedSockets.add(ws);
        } else if (message.type === 'complete') {
          const code = message.code || '';
          const cursorPos = message.cursor_pos ?? code.length;

          const result = await kernelService.complete(sessionId, code, cursorPos);
          ws.send(JSON.stringify({ type: 'complete_reply', result }));
        } else if (message.type === 'comm') {
          // Client -> kernel comm message (ipywidgets interaction):
          // { type: 'comm', comm: { msg_type, comm_id, target_name?, data, buffers? } }
          const comm = (message.comm && typeof message.comm === 'object') ? message.comm : {};
          const msgType = comm.msg_type;
          if (msgType !== 'comm_open' && msgType !== 'comm_msg' && msgType !== 'comm_close') {
            ws.send(JSON.stringify({ type: 'error', error: `Invalid comm msg_type: ${String(msgType)}` }));
            return;
          }
          if (typeof comm.comm_id !== 'string' || comm.comm_id.length === 0) {
            ws.send(JSON.stringify({ type: 'error', error: 'comm.comm_id is required' }));
            return;
          }

          const content: Record<string, unknown> = {
            comm_id: comm.comm_id,
            data: (comm.data && typeof comm.data === 'object') ? comm.data : {},
          };
          if (msgType === 'comm_open') {
            content.target_name = typeof comm.target_name === 'string' ? comm.target_name : '';
          }
          const buffers = Array.isArray(comm.buffers)
            ? (comm.buffers as unknown[]).filter((b): b is string => typeof b === 'string')
            : undefined;

          await kernelService.sendCommMessage(sessionId, msgType, content, buffers);
        } else if (message.type === 'comm_info') {
          // Late-joiner support: list open comms known for this session.
          // Reply only to the requesting socket.
          const openComms = kernelService.getOpenComms(sessionId);
          const comms: Record<string, { target_name: string }> = {};
          for (const [commId, info] of Object.entries(openComms)) {
            comms[commId] = { target_name: info.targetName };
          }
          ws.send(JSON.stringify({ type: 'comm_info_reply', comms }));
        }
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : 'Unknown error';
        console.error('[Kernel WS] Error:', errMessage);
        ws.send(JSON.stringify({ type: 'error', error: errMessage }));
      }
    };

    ws.on('message', (data) => {
      void handleMessage(data.toString());
    });

    ws.on('close', () => {
      console.log(`[Kernel WS] Disconnected for session ${sessionId}`);
      const sockets = sessionWebSockets.get(sessionId);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) {
          sessionWebSockets.delete(sessionId);
        }
      }
    });
  });
}

export default async function kernelRoutes(fastify: FastifyInstance) {
  /**
   * List available kernelspecs
   * Transforms to snake_case to match Python API format expected by frontend
   */
  fastify.get('/kernels', async (request: FastifyRequest, reply: FastifyReply) => {
    const serverId = (request.query as any).server_id as string | undefined;
    const localServerId = serverRegistry.getLocalServerId();
    if (serverId && serverId !== localServerId && serverId !== 'local') {
      try {
        const data = await getRemoteKernels(serverId);
        return reply.send(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({ detail: message });
      }
    }

    const kernels = kernelService.getAvailableKernels().map(k => ({
      name: k.name,
      display_name: k.displayName,
      language: k.language,
      path: k.path,
      python_path: k.argv?.[0] || null, // First element of argv is typically the Python executable
    }));
    return reply.send({ kernels });
  });

  /**
   * Debug endpoint to show kernel discovery paths and environment
   */
  fastify.get('/kernels/debug', async (_request: FastifyRequest, reply: FastifyReply) => {
    const searchPaths = getKernelSearchPaths();

    // Check common kernel locations
    const commonPaths = [
      path.join(os.homedir(), '.local', 'share', 'jupyter', 'kernels'),
      '/usr/local/share/jupyter/kernels',
      '/usr/share/jupyter/kernels',
    ];

    const condaPrefix = process.env.CONDA_PREFIX;
    if (condaPrefix) {
      commonPaths.push(path.join(condaPrefix, 'share', 'jupyter', 'kernels'));
    }

    const pathStatus: Record<string, { exists: boolean; kernels?: string[]; error?: string }> = {};

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        try {
          const entries = fs.readdirSync(p, { withFileTypes: true });
          const kernels = entries
            .filter(e => e.isDirectory() && fs.existsSync(path.join(p, e.name, 'kernel.json')))
            .map(e => e.name);
          pathStatus[p] = { exists: true, kernels };
        } catch (err) {
          pathStatus[p] = { exists: true, error: String(err) };
        }
      } else {
        pathStatus[p] = { exists: false };
      }
    }

    return reply.send({
      node_executable: process.execPath,
      jupyter_data_paths: searchPaths,
      common_paths: pathStatus,
      env: {
        JUPYTER_PATH: process.env.JUPYTER_PATH || '(not set)',
        CONDA_PREFIX: process.env.CONDA_PREFIX || '(not set)',
        HOME: process.env.HOME || '(not set)',
      },
      discovered_kernels: kernelService.getAvailableKernels().map(k => ({
        name: k.name,
        display_name: k.displayName,
        language: k.language,
        path: k.path,
      })),
    });
  });

  /**
   * List all active kernel sessions
   * Transforms to snake_case to match Python API format expected by frontend
   */
  fastify.get('/kernels/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
    const serverId = (request.query as any).server_id as string | undefined;
    const localServerId = serverRegistry.getLocalServerId();
    if (serverId && serverId !== localServerId && serverId !== 'local') {
      try {
        const data = await getRemoteKernelSessions(serverId);
        const sessions = (data.sessions || []).map((session: any) => ({
          ...session,
          id: createProxiedSessionId(serverId, session.id),
        }));
        return reply.send({ sessions });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({ detail: message });
      }
    }

    const allSessions = await kernelService.getAllSessions();
    const sessions = allSessions.map(s => ({
      id: s.id,
      kernel_name: s.kernelName,
      file_path: s.filePath,
      status: s.status,
      execution_count: s.executionCount,
      memory_mb: s.memoryMb,
      pid: s.pid,
      created_at: s.createdAt,
    }));
    return reply.send({ sessions });
  });

  /**
   * Get dead (orphaned/terminated) kernel sessions that can be cleaned up
   * These are sessions from previous server runs that failed to reattach
   */
  fastify.get('/kernels/dead', async (request: FastifyRequest, reply: FastifyReply) => {
    const serverId = (request.query as any).server_id as string | undefined;
    const localServerId = serverRegistry.getLocalServerId();
    if (serverId && serverId !== localServerId && serverId !== 'local') {
      try {
        const data = await getRemoteDeadKernelSessions(serverId);
        return reply.send(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({ detail: message });
      }
    }

    // Confirmed-dead rows (process gone) are auto-removed without user
    // confirmation — only ambiguous leftovers (PID still alive) are reported
    // for the explicit Clean Up flow.
    await kernelService.autoCleanupDeadSessions().catch(() => { /* best effort */ });

    const deadSessions = kernelService.getDeadSessions();
    const sessions = deadSessions.map(s => ({
      session_id: s.sessionId,
      kernel_name: s.kernelName,
      file_path: s.filePath,
      status: s.status,
      last_heartbeat: s.lastHeartbeat,
    }));
    return reply.send({ sessions });
  });

  /**
   * Cleanup dead kernel sessions
   * If session_ids provided, only those are cleaned up
   * Otherwise all dead sessions are cleaned up
   */
  fastify.post('/kernels/dead/cleanup', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { session_ids, server_id } = request.body as any;
      const serverId = server_id as string | undefined;
      const localServerId = serverRegistry.getLocalServerId();
      if (serverId && serverId !== localServerId && serverId !== 'local') {
        const result = await cleanupRemoteDeadKernelSessions(serverId, session_ids);
        return reply.send(result);
      }

      const deleted = await kernelService.cleanupDeadSessions(session_ids);
      return reply.send({ deleted });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Start a new kernel session
   * If server_id is provided and not local, starts on remote server
   */
  fastify.post('/kernels/start', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { kernel_name = 'python3', cwd, file_path, server_id, client_origin } = request.body as any;
      if (file_path) {
        assertPathMutable(kernelService.normalizeNotebookPath(file_path), { operation: 'start a kernel for' });
      }

      const localServerId = serverRegistry.getLocalServerId();
      // Check if we should start on a remote server
      if (server_id && server_id !== localServerId && server_id !== 'local') {
        // Start on remote server
        const result = await startRemoteKernel(server_id, kernel_name, file_path);
        let notebookMtime: number | undefined;
        if (file_path) {
          kernelService.saveNotebookKernelPreference(file_path, kernel_name, server_id);
          const metadataResult = await persistNotebookKernelMetadata(file_path, kernel_name);
          notebookMtime = metadataResult.mtime;
          if (client_origin !== 'ui') {
            operationRouter.notifyKernelChanged(file_path, { kernelName: kernel_name, serverId: server_id, mtime: metadataResult.mtime });
          }
        }
        return reply.send({ session_id: result.sessionId, kernel_name, server_id, mtime: notebookMtime });
      }

      // Start locally
      const sessionId = await kernelService.startKernel({
        kernelName: kernel_name,
        cwd,
        filePath: file_path,
      });
      let notebookMtime: number | undefined;
      if (file_path) {
        kernelService.saveNotebookKernelPreference(file_path, kernel_name, localServerId);
        const metadataResult = await persistNotebookKernelMetadata(file_path, kernel_name);
        notebookMtime = metadataResult.mtime;
        if (client_origin !== 'ui') {
          operationRouter.notifyKernelChanged(file_path, { kernelName: kernel_name, serverId: localServerId, mtime: metadataResult.mtime });
        }
      }
      return reply.send({ session_id: sessionId, kernel_name, server_id: localServerId, mtime: notebookMtime });
    } catch (err) {
      if (sendSealedError(reply, err)) return reply;
      if (sendProvisionError(reply, err)) return reply;
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Get stored kernel preference for a notebook file.
   */
  fastify.get('/kernels/preference', async (request: FastifyRequest, reply: FastifyReply) => {
    const filePath = (request.query as any).file_path as string;
    if (!filePath) {
      return reply.code(400).send({ detail: 'file_path query parameter is required' });
    }

    const preference = kernelService.getNotebookKernelPreference(filePath);
    if (!preference) {
      return reply.send({ kernel_name: null, server_id: null });
    }
    return reply.send({
      kernel_name: preference.kernelName,
      server_id: preference.serverId,
      updated_at: preference.updatedAt,
    });
  });

  /**
   * Get or create kernel for a notebook file
   * If server_id is provided and not local, starts on remote server
   */
  fastify.post('/kernels/for-file', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { file_path, kernel_name, server_id, client_origin } = request.body as any;
      if (!file_path) {
        return reply.code(400).send({ detail: 'file_path is required' });
      }

      const normalizedFilePath = kernelService.normalizeNotebookPath(file_path);
      assertPathMutable(normalizedFilePath, { operation: 'start a kernel for' });
      let effectiveKernelName = kernel_name as string | undefined;
      let effectiveServerId = server_id as string | undefined;
      const localServerId = serverRegistry.getLocalServerId();

      if (!effectiveServerId) {
        const preference = kernelService.getNotebookKernelPreference(normalizedFilePath);
        if (preference?.kernelName) {
          effectiveKernelName = preference.kernelName;
        }
        if (preference?.serverId) {
          const preferredServerId = preference.serverId;
          const isLocalPreference = preferredServerId === localServerId || preferredServerId === 'local';
          const hasServer = !!serverRegistry.getServer(preferredServerId);
          if (isLocalPreference || hasServer) {
            effectiveServerId = preferredServerId;
          }
        }
      }

      // No explicit kernel and no saved preference: resolve from the
      // notebook's own kernelspec metadata (headless callers — CLI/MCP —
      // don't resolve it client-side the way the UI does). Only then fall
      // back to python3.
      if (!effectiveKernelName) {
        try {
          const metadata = await fsService.getNotebookMetadataAsync(normalizedFilePath);
          const specName = (metadata.kernelspec as { name?: string } | undefined)?.name;
          if (specName) {
            effectiveKernelName = specName;
          }
        } catch {
          // fall through to the default
        }
      }
      if (!effectiveKernelName) {
        effectiveKernelName = 'python3';
      }

      // Check if we should start on a remote server
      if (effectiveServerId && effectiveServerId !== localServerId && effectiveServerId !== 'local') {
        // Start on remote server
        const result = await startRemoteKernel(effectiveServerId, effectiveKernelName, file_path);
        kernelService.saveNotebookKernelPreference(normalizedFilePath, effectiveKernelName, effectiveServerId);
        const metadataResult = await persistNotebookKernelMetadata(normalizedFilePath, effectiveKernelName);
        if (client_origin !== 'ui') {
          operationRouter.notifyKernelChanged(normalizedFilePath, {
            kernelName: effectiveKernelName,
            serverId: effectiveServerId,
            mtime: metadataResult.mtime,
          });
        }
        return reply.send({
          session_id: result.sessionId,
          kernel_name: effectiveKernelName,
          file_path,
          server_id: effectiveServerId,
          created: result.created ?? false,
          created_at: result.createdAt,
          mtime: metadataResult.mtime,
        });
      }

      // Start locally
      const { sessionId, created } = await kernelService.getOrCreateKernel(normalizedFilePath, effectiveKernelName);
      const sessionInfo = await kernelService.getSessionStatus(sessionId);
      kernelService.saveNotebookKernelPreference(normalizedFilePath, effectiveKernelName, localServerId);
      const metadataResult = await persistNotebookKernelMetadata(normalizedFilePath, effectiveKernelName);
      if (client_origin !== 'ui') {
        operationRouter.notifyKernelChanged(normalizedFilePath, {
          kernelName: effectiveKernelName,
          serverId: localServerId,
          mtime: metadataResult.mtime,
        });
      }
      return reply.send({
        session_id: sessionId,
        kernel_name: effectiveKernelName,
        file_path,
        server_id: localServerId,
        created,
        created_at: sessionInfo?.createdAt,
        mtime: metadataResult.mtime,
      });
    } catch (err) {
      if (sendSealedError(reply, err)) return reply;
      if (sendProvisionError(reply, err)) return reply;
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Check if a kernel exists for a file
   */
  fastify.get('/kernels/for-file', async (request: FastifyRequest, reply: FastifyReply) => {
    const filePath = (request.query as any).file_path as string;
    if (!filePath) {
      return reply.code(400).send({ detail: 'file_path query parameter is required' });
    }
    // We don't have a direct method, so check sessions
    const sessions = await kernelService.getAllSessions();
    const session = sessions.find(s => s.filePath === filePath);
    if (session) {
      return reply.send({ session_id: session.id, exists: true });
    } else {
      return reply.send({ session_id: null, exists: false });
    }
  });

  /**
   * Stop a kernel session
   */
  fastify.delete('/kernels/:sessionId', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { sessionId } = request.params as any;

      // Check if this is a proxied session
      if (isProxiedSession(sessionId)) {
        await shutdownRemoteKernel(sessionId);
        return reply.send({ status: 'ok' });
      }

      const success = await kernelService.stopKernel(sessionId);
      if (success) {
        return reply.send({ status: 'ok' });
      } else {
        return reply.code(404).send({ detail: 'Session not found' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Interrupt kernel execution
   */
  fastify.post('/kernels/:sessionId/interrupt', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { sessionId } = request.params as any;

      // Check if this is a proxied session
      if (isProxiedSession(sessionId)) {
        await interruptRemoteKernel(sessionId);
        return reply.send({ status: 'ok' });
      }

      const success = await kernelService.interruptKernel(sessionId);
      if (success) {
        return reply.send({ status: 'ok' });
      } else {
        return reply.code(404).send({ detail: 'Session not found' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Restart a kernel
   */
  fastify.post('/kernels/:sessionId/restart', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { sessionId } = request.params as any;

      // Check if this is a proxied session
      if (isProxiedSession(sessionId)) {
        await restartRemoteKernel(sessionId);
        return reply.send({ status: 'ok' });
      }

      const success = await kernelService.restartKernel(sessionId);
      if (success) {
        return reply.send({ status: 'ok' });
      } else {
        return reply.code(404).send({ detail: 'Session not found' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Get kernel session status
   */
  fastify.get('/kernels/:sessionId/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = request.params as any;

    // Check if this is a proxied session
    if (isProxiedSession(sessionId)) {
      try {
        const remoteStatus = await getRemoteKernelStatus(sessionId);
        // Return the COMPOSITE session id (serverId::remoteId) — the remote
        // server reports its own local id, and leaking that to clients makes
        // them reference a session the main server doesn't recognize.
        return reply.send({ ...remoteStatus, id: sessionId });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        // "Server is offline / not found" from the registry is a HEARTBEAT
        // signal, not ground truth: a compute node saturated by a heavy
        // execution can miss heartbeats for minutes while its SLURM job (and
        // kernel) are perfectly alive — then recover. Treating that as
        // terminal permanently killed live kernels (red kernel, reconnect
        // loop stopped, only a page refresh recovered).
        //
        // The scheduler is the authority: return 410 Gone (terminal) only
        // when the session's allocation is confirmed ended/failed/cancelled
        // by squeue polling. Everything else is 503 (transient) so the
        // client's reconnect loop keeps trying and revives the kernel when
        // the node recovers.
        if (/server (is offline|not found)/i.test(message)) {
          const { serverId } = parseSessionId(sessionId);
          const allocation = serverId
            ? allocationService.list().find(a => a.serverId === serverId)
            : undefined;
          if (allocation && ['ended', 'failed', 'cancelled'].includes(allocation.state)) {
            return reply.code(410).send({ detail: `Allocation ${allocation.state} — kernel stopped`, reason: 'server_gone' });
          }
          return reply.code(503).send({ detail: `${message} (may be transient — compute node busy or re-registering)`, reason: 'server_unreachable' });
        }
        return reply.code(500).send({ detail: message });
      }
    }

    const status = await kernelService.getSessionStatus(sessionId);
    if (status) {
      // Convert to snake_case for frontend compatibility
      return reply.send({
        id: status.id,
        kernel_name: status.kernelName,
        file_path: status.filePath,
        status: status.status,
        execution_count: status.executionCount,
        memory_mb: status.memoryMb,
        pid: status.pid,
      });
    } else {
      return reply.code(404).send({ detail: 'Session not found' });
    }
  });
}

export { kernelService };
