/**
 * Kernel Proxy
 *
 * Handles proxying kernel operations to peer servers in a cluster.
 * When a kernel is started on a remote server, this module manages
 * the communication between the client and the remote kernel.
 */

import { WebSocket } from 'ws';
import { serverRegistry, PeerServer } from './server-registry';

// Track proxied kernel sessions: sessionId -> { serverId, remoteSessionId, ws }
interface ProxiedSession {
  serverId: string;        // Which server owns this kernel
  remoteSessionId: string; // Session ID on the remote server
  remoteWs?: WebSocket;    // WebSocket connection to remote server
  localWs?: WebSocket;     // Client's WebSocket
}

const proxiedSessions: Map<string, ProxiedSession> = new Map();

function getClusterHeaders(): Record<string, string> {
  const secret = process.env.NEBULA_CLUSTER_SECRET;
  return secret ? { 'X-Nebula-Cluster-Secret': secret } : {};
}

/**
 * Create a composite session ID that encodes the server
 */
export function createProxiedSessionId(serverId: string, remoteSessionId: string): string {
  return `${serverId}::${remoteSessionId}`;
}

/**
 * Parse a composite session ID
 */
export function parseSessionId(sessionId: string): { isProxied: boolean; serverId?: string; remoteSessionId?: string } {
  if (sessionId.includes('::')) {
    const [serverId, remoteSessionId] = sessionId.split('::', 2);
    return { isProxied: true, serverId, remoteSessionId };
  }
  return { isProxied: false };
}

/**
 * Check if a session ID is for a proxied (remote) kernel
 */
export function isProxiedSession(sessionId: string): boolean {
  return sessionId.includes('::');
}

/**
 * Get the server for a session
 */
export function getSessionServer(sessionId: string): PeerServer | null {
  const { isProxied, serverId } = parseSessionId(sessionId);
  if (!isProxied || !serverId) return null;
  return serverRegistry.getServer(serverId) || null;
}

/**
 * Start a kernel on a remote server
 */
export async function startRemoteKernel(
  serverId: string,
  kernelName: string,
  filePath?: string
): Promise<{ sessionId: string; created?: boolean; createdAt?: number }> {
  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  if (server.status !== 'online') {
    throw new Error(`Server is offline: ${serverId}`);
  }

  // Call the remote server's kernel start endpoint
  const endpoint = filePath
    ? `${server.url}/api/kernels/for-file`
    : `${server.url}/api/kernels/start`;

  const body = filePath
    ? { file_path: filePath, kernel_name: kernelName }
    : { kernel_name: kernelName };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getClusterHeaders() },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
    throw new Error(error.detail || `Failed to start kernel on ${serverId}`);
  }

  const result = await response.json() as { session_id: string; created?: boolean; created_at?: number };
  const remoteSessionId = result.session_id;

  // Create composite session ID
  const proxySessionId = createProxiedSessionId(serverId, remoteSessionId);

  // Track the proxied session
  proxiedSessions.set(proxySessionId, {
    serverId,
    remoteSessionId,
  });

  console.log(`[KernelProxy] Started kernel on ${serverId}, session: ${proxySessionId}`);

  return {
    sessionId: proxySessionId,
    created: filePath ? result.created : true,
    createdAt: result.created_at,
  };
}

export interface RemoteExecuteResult {
  status: string;
  executionCount: number | null;
  error?: string;
  queuePosition?: number;
  queueLength?: number;
}

/**
 * Execute code on a remote kernel and stream its outputs — the headless
 * counterpart of the UI's WebSocket proxy, speaking the same protocol:
 * subscribe (`sync_outputs`), `execute`, collect `output` messages until the
 * `result` arrives. Outputs are filtered to the executing cell so concurrent
 * runs on the session don't cross streams.
 */
export async function executeRemoteCode(
  proxySessionId: string,
  code: string,
  outputCallback: (output: Record<string, unknown>) => void | Promise<void>,
  cellId?: string | null
): Promise<RemoteExecuteResult> {
  const { serverId, remoteSessionId } = parseSessionId(proxySessionId);
  if (!serverId || !remoteSessionId) {
    throw new Error('Invalid proxied session ID');
  }
  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  const wsUrl = server.url.replace(/^http/, 'ws') + `/api/kernels/${remoteSessionId}/ws`;

  return new Promise<RemoteExecuteResult>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: getClusterHeaders() });
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      try { ws.close(); } catch { /* already closing */ }
    };

    ws.on('open', () => {
      // Subscribe BEFORE executing — the server only streams `output`
      // messages to sockets that performed the initial sync.
      ws.send(JSON.stringify({ type: 'sync_outputs' }));
      ws.send(JSON.stringify({ type: 'execute', code, cell_id: cellId ?? null }));
    });

    // Messages are handled through a serial chain so an async outputCallback
    // finishes before the result resolves (outputs must not race completion).
    let chain: Promise<void> = Promise.resolve();
    ws.on('message', (data) => {
      chain = chain
        .then(async () => {
          if (settled) return;
          const msg = JSON.parse(data.toString());
          if (msg.type === 'output') {
            if (cellId == null || msg.cell_id === cellId) {
              await outputCallback(msg.output);
            }
          } else if (msg.type === 'result') {
            settle(() => resolve(msg.result as RemoteExecuteResult));
          } else if (msg.type === 'error') {
            settle(() => reject(new Error(msg.error || 'Remote kernel error')));
          }
        })
        .catch((err) => {
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        });
    });

    ws.on('close', () => {
      if (!settled) {
        // Mid-run channel loss is the earliest signal the compute node died.
        serverRegistry.reportUnreachable(serverId);
        settle(() => reject(new Error(`Kernel connection closed before completion (server ${serverId})`)));
      }
    });

    ws.on('error', (err) => {
      serverRegistry.reportUnreachable(serverId);
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    });
  });
}

/**
 * Interrupt a kernel on a remote server
 */
export async function interruptRemoteKernel(sessionId: string): Promise<void> {
  const { serverId, remoteSessionId } = parseSessionId(sessionId);
  if (!serverId || !remoteSessionId) {
    throw new Error('Invalid proxied session ID');
  }

  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  const response = await fetch(`${server.url}/api/kernels/${remoteSessionId}/interrupt`, {
    method: 'POST',
    headers: { ...getClusterHeaders() },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
    throw new Error(error.detail || 'Failed to interrupt kernel');
  }
}

/**
 * Restart a kernel on a remote server
 */
export async function restartRemoteKernel(sessionId: string): Promise<void> {
  const { serverId, remoteSessionId } = parseSessionId(sessionId);
  if (!serverId || !remoteSessionId) {
    throw new Error('Invalid proxied session ID');
  }

  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  const response = await fetch(`${server.url}/api/kernels/${remoteSessionId}/restart`, {
    method: 'POST',
    headers: { ...getClusterHeaders() },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
    throw new Error(error.detail || 'Failed to restart kernel');
  }
}

/**
 * Get status of a kernel on a remote server
 */
export async function getRemoteKernelStatus(sessionId: string): Promise<{
  status: string;
  execution_count?: number;
  memory_mb?: number;
}> {
  const { serverId, remoteSessionId } = parseSessionId(sessionId);
  if (!serverId || !remoteSessionId) {
    throw new Error('Invalid proxied session ID');
  }

  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  let response;
  try {
    response = await fetch(`${server.url}/api/kernels/${remoteSessionId}/status`, {
      headers: { ...getClusterHeaders() },
    });
  } catch (err) {
    // Connection-level failure (refused/reset) — the node may be gone.
    serverRegistry.reportUnreachable(serverId);
    throw err;
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
    throw new Error(error.detail || 'Failed to get kernel status');
  }

  return response.json() as Promise<{ status: string; execution_count?: number; memory_mb?: number }>;
}

/**
 * Shutdown a kernel on a remote server
 */
export async function shutdownRemoteKernel(sessionId: string): Promise<void> {
  const { serverId, remoteSessionId } = parseSessionId(sessionId);
  if (!serverId || !remoteSessionId) {
    throw new Error('Invalid proxied session ID');
  }

  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  const response = await fetch(`${server.url}/api/kernels/${remoteSessionId}`, {
    method: 'DELETE',
    headers: { ...getClusterHeaders() },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
    throw new Error(error.detail || 'Failed to shutdown kernel');
  }

  // Clean up proxied session
  proxiedSessions.delete(sessionId);
}

/**
 * Get available kernels from a remote server
 */
export async function getRemoteKernels(serverId: string): Promise<{ kernels: any[] }> {
  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }
  if (server.status !== 'online') {
    throw new Error(`Server is offline: ${serverId}`);
  }

  const response = await fetch(`${server.url}/api/kernels`, {
    headers: { ...getClusterHeaders() },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
    throw new Error(error.detail || 'Failed to fetch kernels');
  }
  return response.json() as Promise<{ kernels: any[] }>;
}

/**
 * Get active kernel sessions from a remote server
 */
export async function getRemoteKernelSessions(serverId: string): Promise<{ sessions: any[] }> {
  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }
  if (server.status !== 'online') {
    throw new Error(`Server is offline: ${serverId}`);
  }

  const response = await fetch(`${server.url}/api/kernels/sessions`, {
    headers: { ...getClusterHeaders() },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
    throw new Error(error.detail || 'Failed to fetch kernel sessions');
  }
  return response.json() as Promise<{ sessions: any[] }>;
}

/**
 * Get dead kernel sessions from a remote server
 */
export async function getRemoteDeadKernelSessions(serverId: string): Promise<{ sessions: any[] }> {
  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }
  if (server.status !== 'online') {
    throw new Error(`Server is offline: ${serverId}`);
  }

  const response = await fetch(`${server.url}/api/kernels/dead`, {
    headers: { ...getClusterHeaders() },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
    throw new Error(error.detail || 'Failed to fetch dead kernel sessions');
  }
  return response.json() as Promise<{ sessions: any[] }>;
}

/**
 * Cleanup dead kernel sessions on a remote server
 */
export async function cleanupRemoteDeadKernelSessions(serverId: string, sessionIds?: string[]): Promise<{ deleted: number }> {
  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }
  if (server.status !== 'online') {
    throw new Error(`Server is offline: ${serverId}`);
  }

  const response = await fetch(`${server.url}/api/kernels/dead/cleanup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getClusterHeaders() },
    body: JSON.stringify({ session_ids: sessionIds }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
    throw new Error(error.detail || 'Failed to cleanup dead kernel sessions');
  }
  return response.json() as Promise<{ deleted: number }>;
}

/**
 * Create a WebSocket proxy to a remote kernel
 */
export function createWebSocketProxy(
  sessionId: string,
  clientWs: WebSocket
): WebSocket | null {
  const { serverId, remoteSessionId } = parseSessionId(sessionId);
  if (!serverId || !remoteSessionId) {
    return null;
  }

  const server = serverRegistry.getServer(serverId);
  if (!server) {
    console.error(`[KernelProxy] Server not found for WebSocket proxy: ${serverId}`);
    return null;
  }

  // Create WebSocket URL for remote server
  const wsUrl = server.url.replace(/^http/, 'ws') + `/api/kernels/${remoteSessionId}/ws`;

  console.log(`[KernelProxy] Creating WebSocket proxy to ${wsUrl}`);

  const remoteWs = new WebSocket(wsUrl, {
    headers: getClusterHeaders(),
  });

  // The client (UI) sends its messages as soon as *its* socket is open — which
  // is before this remote socket finishes connecting. Those early messages
  // (notably the one-time `sync_outputs` that subscribes to the kernel's output
  // stream, and the first `execute`) would otherwise be silently dropped,
  // leaving the cell running with no output. Buffer them and flush on open.
  const pending: Array<{ data: unknown; isBinary: boolean }> = [];
  const sendToRemote = (data: unknown, isBinary: boolean) => {
    if (remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(isBinary ? (data as any) : (typeof data === 'string' ? data : (data as any).toString()));
    } else {
      pending.push({ data, isBinary });
    }
  };

  remoteWs.on('open', () => {
    for (const { data, isBinary } of pending) {
      if (remoteWs.readyState === WebSocket.OPEN) {
        remoteWs.send(isBinary ? (data as any) : (typeof data === 'string' ? data : (data as any).toString()));
      }
    }
    pending.length = 0;
  });

  // Forward messages from remote to client
  remoteWs.on('message', (data, isBinary) => {
    if (clientWs.readyState !== WebSocket.OPEN) {
      return;
    }
    if (isBinary) {
      clientWs.send(data);
      return;
    }
    clientWs.send(typeof data === 'string' ? data : data.toString());
  });

  // Forward messages from client to remote (buffered until remote is open)
  clientWs.on('message', (data, isBinary) => {
    sendToRemote(data, isBinary);
  });

  // Handle remote close
  remoteWs.on('close', () => {
    console.log(`[KernelProxy] Remote WebSocket closed for ${sessionId}`);
    // The kernel channel dropping is the earliest signal a compute node
    // died (walltime, scancel, crash) — let the allocation layer verify.
    const { serverId: sid } = parseSessionId(sessionId);
    if (sid) serverRegistry.reportUnreachable(sid);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close();
    }
  });

  // Handle client close
  clientWs.on('close', () => {
    console.log(`[KernelProxy] Client WebSocket closed for ${sessionId}`);
    if (remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.close();
    }
  });

  // Handle errors
  remoteWs.on('error', (err) => {
    console.error(`[KernelProxy] Remote WebSocket error for ${sessionId}:`, err);
    const { serverId: sid } = parseSessionId(sessionId);
    if (sid) serverRegistry.reportUnreachable(sid);
  });

  // Track the proxy
  const session = proxiedSessions.get(sessionId);
  if (session) {
    session.remoteWs = remoteWs;
    session.localWs = clientWs;
  }

  return remoteWs;
}

/**
 * Get all proxied sessions
 */
export function getProxiedSessions(): Map<string, ProxiedSession> {
  return proxiedSessions;
}

/**
 * Cleanup all proxied sessions
 */
export function cleanupProxiedSessions(): void {
  for (const [sessionId, session] of proxiedSessions.entries()) {
    if (session.remoteWs) {
      session.remoteWs.close();
    }
    if (session.localWs) {
      session.localWs.close();
    }
    proxiedSessions.delete(sessionId);
  }
}
