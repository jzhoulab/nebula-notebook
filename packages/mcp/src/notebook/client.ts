/**
 * Nebula Notebook Client - Unified API for Notebook Operations
 *
 * This client provides programmatic access to Nebula Notebook, enabling AI agents
 * and automation tools to manipulate notebooks through a consistent interface.
 *
 * ## Architecture
 *
 * The client routes operations through Nebula's Operation Router, which transparently
 * handles both UI-connected and headless modes:
 *
 * ```
 * NebulaClient → HTTP/WS → Operation Router → UI (WebSocket) or Headless (File)
 * ```
 *
 * From the client's perspective, both modes are identical - the router handles
 * the complexity of determining where to apply operations.
 *
 * ## Key Features
 *
 * - **Kernel Management**: Start, stop, restart, interrupt Jupyter kernels
 * - **Cell Operations**: Insert, delete, update, move, duplicate cells
 * - **Code Execution**: WebSocket streaming with real-time output capture
 * - **Agent Sessions**: Lock/unlock notebooks to prevent concurrent access
 * - **Dual Mode**: Works seamlessly with or without UI connected
 *
 * ## Usage
 *
 * ```typescript
 * const client = new NebulaClient({ baseUrl: 'http://localhost:8000' });
 *
 * // Start agent session (shows indicator in UI)
 * await client.startAgentSession(path, 'my-agent');
 *
 * // Insert a cell
 * const result = await client.insertCellOp(path, 0, {
 *   id: 'imports',
 *   type: 'code',
 *   content: 'import numpy as np'
 * });
 *
 * // Execute the cell
 * const execResult = await client.executeCell(path, sessionId, { cellIndex: 0 });
 *
 * // End session
 * await client.endAgentSession(path);
 * ```
 *
 * ## Error Handling
 *
 * All methods return `ToolResult<T>` with `success` boolean and either `data` or `error`:
 *
 * ```typescript
 * const result = await client.insertCellOp(path, 0, cell);
 * if (!result.success) {
 *   console.error(result.error);
 *   return;
 * }
 * console.log('Inserted cell:', result.data.cellId);
 * ```
 *
 * @see {@link https://github.com/jzhoulab/nebula-notebook/blob/main/docs/AGENTIC_ARCHITECTURE.md}
 * @module NebulaClient
 */

import type { Notebook, NotebookCell, CellOutput, CellMetadata, ToolResult } from '../types.js';

export interface NebulaClientConfig {
  /** Base URL for Nebula API (default: http://localhost:8000) */
  baseUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Number of retries for transient errors (default: 3) */
  retries?: number;
  /** Optional agent session ID for lock enforcement */
  agentId?: string;
  /** Optional client name for lock metadata */
  clientName?: string;
  /** Optional client version for lock metadata */
  clientVersion?: string;
  /** Auto-start agent session for write operations (default: true if agentId provided) */
  autoStartAgentSession?: boolean;
  /**
   * Bearer token sent on every request. Without one the client relies on the
   * server's loopback piggyback (browser session handed to token-less requests
   * from 127.0.0.1) — which breaks whenever the tunnel terminates on a
   * different host than the server. See resolveAuthToken() in the CLI.
   */
  token?: string;
}

export interface KernelSession {
  sessionId: string;
  kernelName: string;
  status: 'idle' | 'busy' | 'starting' | 'disconnected';
  filePath?: string;
}

export interface SessionInfo {
  id: string;
  kernel_name: string;
  status: string;
  file_path?: string;
  execution_count?: number;
}

export interface ExecutionResult {
  outputs: CellOutput[];
  executionCount?: number;
  success: boolean;
  error?: string;
}

export interface WriteCellResult {
  cellIndex: number;
  cellId: string;
  totalCells: number;
  idModified?: boolean;      // True if requested ID was auto-fixed
  requestedId?: string;      // Original ID if modified
}

export interface MetadataSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'enum';
    values?: string[];
    description: string;
    agentMutable: boolean;
    default?: unknown;
  };
}

export interface SearchResult {
  cells: Array<{
    index: number;
    score: number;
    type: string;
    content: string;
    id: string;
  }>;
  totalCells: number;
}

// =============================================================================
// Compute allocation types (mirror node-server /api/compute shapes)
// =============================================================================

export type ComputeAllocationState =
  | 'pending'
  | 'running'
  | 'active'
  | 'ended'
  | 'failed'
  | 'cancelled';

/**
 * Resource request for a compute allocation. Field names are camelCase on the
 * wire — the /api/compute routes parse camelCase keys (memGb, gpuType, …).
 */
export interface ComputeSpec {
  partition: string;
  qos?: string;
  account?: string;
  cpus?: number;
  memGb?: number;
  gpus?: number;
  gpuType?: string;
  walltimeMinutes?: number;
  jobName?: string;
  /** Opt-in: auto-end the allocation after this many idle minutes (client self-exit). */
  idleTimeoutMinutes?: number;
}

export interface ComputeAllocation {
  id: string;
  jobId?: string;
  spec: {
    partition: string;
    qos?: string;
    account?: string;
    cpus: number;
    memGb: number;
    gpus?: number;
    gpuType?: string;
    walltimeMinutes: number;
    jobName: string;
    idleTimeoutMinutes?: number;
  };
  state: ComputeAllocationState;
  serverId?: string;
  nodes?: string[];
  reason?: string;
  createdAt: number;
  walltimeEndsAt?: number;
}

export interface ComputeStatus {
  enabled: boolean;
  scheduler: string | null;
}

export interface ComputePartitionLoad {
  name: string;
  up: boolean;
  timeLimit: string;
  cpus: { alloc: number; idle: number; other: number; total: number };
  /** One entry per GPU model in the partition (heterogeneous queues have several). */
  gpus?: { type: string; total: number; idle: number }[];
  nodes: { idle: number; mixed: number; alloc: number; down: number; total: number };
  jobs: { pending: number; running: number };
  /** Distinct CPU arches of the partition's nodes (e.g. 'x86_64', 'aarch64'). */
  archs?: string[];
}

export interface ComputeQosLoad {
  name: string;
  priority: number;
  maxWall?: string;
  preemptible: boolean;
  preempts: string[];
  jobs: { running: number; pending: number };
}

export interface ComputePartitions {
  enabled: boolean;
  associations: {
    account?: string;
    partitions: string[];
    qoses: string[];
    defaultQos?: string;
  } | null;
  load: {
    partitions: ComputePartitionLoad[];
    qoses: ComputeQosLoad[];
    fetchedAt: number;
  } | null;
}

export interface ComputeStartEstimate {
  startsAt?: string;
  nodes?: string[];
  reason?: string;
}

/**
 * Client for Nebula Notebook headless API
 */
export class NebulaClient {
  private baseUrl: string;
  private timeout: number;
  private retries: number;
  private agentId?: string;
  private clientName?: string;
  private clientVersion?: string;
  private autoStartAgentSession: boolean;
  private token?: string;
  private activeAgentSessions: Set<string> = new Set();
  private agentSessionInFlight: Map<string, Promise<ToolResult<{ warning?: string }>>> = new Map();
  private pinnedKernelSessions: Map<string, string> = new Map();
  private lastBackend?: 'ui' | 'headless';
  private lastAutoStartWarning?: string;
  private autoStartWarnedPaths: Set<string> = new Set();
  private activeNotebookPath: string | null = null;
  // Track last tool call timestamp per notebook path for user change detection
  private lastToolCallTimestamp: Map<string, number> = new Map();

  constructor(config: NebulaClientConfig = {}) {
    this.baseUrl = config.baseUrl || 'http://localhost:8000';
    this.timeout = config.timeout || 30000;
    this.retries = config.retries ?? 3;
    this.agentId = config.agentId;
    this.clientName = config.clientName;
    this.clientVersion = config.clientVersion;
    this.autoStartAgentSession = config.autoStartAgentSession ?? Boolean(config.agentId);
    this.token = config.token?.trim() || undefined;
  }

  /** Authorization header when a token is configured; empty otherwise. */
  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private recordBackend(backend?: 'ui' | 'headless'): void {
    if (backend) {
      this.lastBackend = backend;
    }
  }

  consumeLastBackend(): 'ui' | 'headless' | undefined {
    const backend = this.lastBackend;
    this.lastBackend = undefined;
    return backend;
  }

  consumeAutoStartWarning(): string | undefined {
    const warning = this.lastAutoStartWarning;
    this.lastAutoStartWarning = undefined;
    return warning;
  }

  hasActiveAgentSession(path: string): boolean {
    return this.activeAgentSessions.has(path);
  }

  /**
   * Get the notebook path associated with the active agent session (if any).
   */
  getActiveNotebookPath(): string | null {
    return this.activeNotebookPath;
  }

  getPinnedKernelSessionId(path: string): string | null {
    return this.pinnedKernelSessions.get(path) ?? null;
  }

  private setActiveNotebookPath(path: string): void {
    this.activeNotebookPath = path;
  }

  private clearActiveNotebookPath(path: string): void {
    if (this.activeNotebookPath === path) {
      const remaining = Array.from(this.activeAgentSessions);
      this.activeNotebookPath = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
  }

  private pinKernelSession(path: string, sessionId: string): void {
    this.pinnedKernelSessions.set(path, sessionId);
  }

  private clearPinnedKernelSession(path: string): void {
    this.pinnedKernelSessions.delete(path);
  }

  private clearPinnedKernelSessionById(sessionId: string): void {
    for (const [path, pinnedSessionId] of this.pinnedKernelSessions.entries()) {
      if (pinnedSessionId === sessionId) {
        this.pinnedKernelSessions.delete(path);
      }
    }
  }

  private selectBestSessionForFile(sessions: SessionInfo[], notebookPath: string): SessionInfo | null {
    const matching = sessions.filter(s => s.file_path === notebookPath);
    if (matching.length === 0) {
      return null;
    }

    return matching.reduce((best, session) => {
      const bestCreated = typeof (best as any).created_at === 'number' ? (best as any).created_at : -Infinity;
      const sessionCreated = typeof (session as any).created_at === 'number' ? (session as any).created_at : -Infinity;
      return sessionCreated > bestCreated ? session : best;
    }, matching[0]);
  }

  async resolveKernelSessionIdForNotebook(
    path: string,
    options: { kernelName?: string; createIfMissing?: boolean } = {},
  ): Promise<ToolResult<{ sessionId: string }>> {
    const pinnedSessionId = this.getPinnedKernelSessionId(path);
    if (pinnedSessionId) {
      return { success: true, data: { sessionId: pinnedSessionId } };
    }

    const sessions = await this.listSessions();
    if (sessions.success) {
      const existing = this.selectBestSessionForFile(sessions.data || [], path);
      if (existing?.id) {
        this.pinKernelSession(path, existing.id);
        return { success: true, data: { sessionId: existing.id } };
      }
    } else if (!options.createIfMissing) {
      return { success: false, error: sessions.error };
    }

    if (!options.createIfMissing) {
      return { success: false, error: 'Kernel session not found for notebook' };
    }

    const created = await this.getOrCreateKernelForFile(path, options.kernelName);
    if (!created.success) {
      return { success: false, error: created.error };
    }

    return { success: true, data: { sessionId: created.data!.sessionId } };
  }

  /**
   * Check if an error is retryable (network/connection errors)
   */
  private isRetryable(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes('network') ||
        msg.includes('connection') ||
        msg.includes('econnrefused') ||
        msg.includes('econnreset') ||
        msg.includes('timeout')
      );
    }
    return false;
  }

  /**
   * Check if an error is a connection failure (server not reachable)
   */
  private isConnectionError(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes('econnrefused') ||
        msg.includes('fetch failed') ||
        msg.includes('network request failed') ||
        msg.includes('failed to fetch') ||
        msg.includes('unable to connect') ||
        msg.includes('enotfound') ||
        msg.includes('getaddrinfo')
      );
    }
    return false;
  }

  /**
   * Delay for retry backoff
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Fetch with automatic retry for transient errors
   */
  private async fetch<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<ToolResult<T>> {
    let lastError: string = 'Unknown error';

    for (let attempt = 0; attempt < this.retries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          ...options,
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...this.authHeaders(),
            ...options.headers,
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const error = await response.text();
          // Don't retry 4xx errors (client errors)
          if (response.status >= 400 && response.status < 500) {
            return { success: false, error: `API error ${response.status}: ${error}` };
          }
          lastError = `API error ${response.status}: ${error}`;
          // Retry 5xx errors
          if (attempt < this.retries - 1) {
            await this.delay(1000 * (attempt + 1));
            continue;
          }
          return { success: false, error: lastError };
        }

        const data = await response.json();
        return { success: true, data: data as T };
      } catch (e) {
        clearTimeout(timeoutId);

        if (e instanceof Error && e.name === 'AbortError') {
          lastError = 'Request timeout';
        } else if (this.isConnectionError(e)) {
          // Provide helpful error for connection failures
          lastError = `Cannot connect to Nebula server at ${this.baseUrl}. ` +
            `Ensure the server is running or use connect_server to configure the correct URL.`;
        } else {
          lastError = `Request failed: ${e instanceof Error ? e.message : String(e)}`;
        }

        // Retry if retryable and not last attempt
        if (this.isRetryable(e) && attempt < this.retries - 1) {
          await this.delay(1000 * (attempt + 1));
          continue;
        }

        return { success: false, error: lastError };
      }
    }

    return { success: false, error: lastError };
  }

  // ===========================================================================
  // Kernel Operations
  // ===========================================================================

  /**
   * List available kernel specs with display names and versions
   */
  async listKernels(): Promise<ToolResult<Array<{
    name: string;
    displayName: string;
    language: string;
  }>>> {
    const result = await this.fetch<{
      kernels: Array<{
        name: string;
        display_name: string;
        language: string;
      }>;
    }>('/api/kernels');
    if (!result.success) return { success: false, error: result.error };
    return {
      success: true,
      data: result.data?.kernels.map((k) => ({
        name: k.name,
        displayName: k.display_name,
        language: k.language,
      })) ?? [],
    };
  }

  /**
   * List active kernel sessions
   */
  async listSessions(): Promise<ToolResult<SessionInfo[]>> {
    const result = await this.fetch<{ sessions: SessionInfo[] }>('/api/kernels/sessions');
    if (!result.success) return { success: false, error: result.error };
    return { success: true, data: result.data?.sessions ?? [] };
  }

  /**
   * Start a new kernel session
   */
  async startKernel(kernelName: string = 'python3', filePath?: string): Promise<ToolResult<KernelSession>> {
    const result = await this.fetch<{ session_id: string; kernel_name: string }>('/api/kernels/start', {
      method: 'POST',
      body: JSON.stringify({ kernel_name: kernelName, file_path: filePath }),
    });
    if (!result.success) return { success: false, error: result.error };
    if (filePath) {
      this.pinKernelSession(filePath, result.data!.session_id);
    }
    return {
      success: true,
      data: {
        sessionId: result.data!.session_id,
        kernelName: result.data!.kernel_name,
        status: 'idle',
        filePath,
      },
    };
  }

  /**
   * Get or create a kernel session for a notebook file.
   *
   * Pass `serverId` to start (and bind) the notebook's kernel on a specific
   * registered server — e.g. a compute allocation's serverId. The server also
   * persists it as the notebook's kernel preference, so later kernels for this
   * notebook start on the same server.
   */
  async getOrCreateKernelForFile(
    filePath: string,
    kernelName?: string,
    serverId?: string
  ): Promise<ToolResult<KernelSession>> {
    const result = await this.fetch<{ session_id: string; kernel_name: string; file_path: string }>(
      '/api/kernels/for-file',
      {
        method: 'POST',
        body: JSON.stringify({
          file_path: filePath,
          kernel_name: kernelName,
          ...(serverId ? { server_id: serverId } : {}),
        }),
      }
    );
    if (!result.success) return { success: false, error: result.error };
    this.pinKernelSession(filePath, result.data!.session_id);
    return {
      success: true,
      data: {
        sessionId: result.data!.session_id,
        kernelName: result.data!.kernel_name,
        status: 'idle',
        filePath: result.data!.file_path,
      },
    };
  }

  /**
   * Execute code in a kernel session (simple REST version)
   */
  async executeCode(sessionId: string, code: string): Promise<ToolResult<ExecutionResult>> {
    return this.fetch<ExecutionResult>(`/api/kernels/${sessionId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  /**
   * Execute code with WebSocket streaming for real-time output
   */
  async executeCodeStreaming(
    sessionId: string,
    code: string,
    timeoutMs: number = 60000
  ): Promise<ToolResult<ExecutionResult>> {
    return new Promise((resolve) => {
      const wsUrl = this.baseUrl.replace(/^http/, 'ws') + `/api/kernels/${sessionId}/ws`;
      const outputs: CellOutput[] = [];
      let executionCount: number | undefined;
      let hasError = false;
      let errorMessage: string | undefined;

      // Use dynamic import for ws in Node.js environment
      const connectWs = async () => {
        try {
          // Try browser WebSocket first
          const WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : (await import('ws')).default;
          const ws = new WebSocketImpl(wsUrl);

          const timeout = setTimeout(() => {
            ws.close();
            resolve({
              success: false,
              error: `Execution timeout after ${timeoutMs / 1000}s`,
              data: { outputs, success: false, executionCount },
            });
          }, timeoutMs);

          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'execute', code }));
          };

          ws.onmessage = (event: { data: string | Buffer }) => {
            try {
              const data = typeof event.data === 'string' ? event.data : event.data.toString();
              const msg = JSON.parse(data);

              if (msg.type === 'output') {
                outputs.push(this.parseJupyterOutput(msg.output));
              } else if (msg.type === 'result') {
                executionCount = msg.result?.execution_count;
                if (msg.result?.outputs) {
                  outputs.push(...msg.result.outputs.map((o: any) => this.parseJupyterOutput(o)));
                }
              } else if (msg.type === 'error') {
                hasError = true;
                errorMessage = msg.error;
                outputs.push({ type: 'error', content: msg.error || 'Unknown error' });
              } else if (msg.type === 'status' && msg.status === 'idle') {
                clearTimeout(timeout);
                ws.close();
                resolve({
                  success: !hasError,
                  data: { outputs, success: !hasError, executionCount, error: errorMessage },
                });
              }
            } catch (e) {
              // Ignore parse errors for non-JSON messages
            }
          };

          ws.onerror = (error: any) => {
            clearTimeout(timeout);
            ws.close();
            resolve({
              success: false,
              error: `WebSocket error: ${error.message || 'Unknown error'}`,
            });
          };

          ws.onclose = () => {
            clearTimeout(timeout);
          };
        } catch (e) {
          // Fall back to REST API if WebSocket fails
          const result = await this.executeCode(sessionId, code);
          resolve(result);
        }
      };

      connectWs();
    });
  }

  /**
   * Interrupt a running kernel
   */
  async interruptKernel(sessionId: string): Promise<ToolResult<void>> {
    return this.fetch<void>(`/api/kernels/${sessionId}/interrupt`, {
      method: 'POST',
    });
  }

  /**
   * Restart a kernel session
   */
  async restartKernel(sessionId: string): Promise<ToolResult<void>> {
    return this.fetch<void>(`/api/kernels/${sessionId}/restart`, {
      method: 'POST',
    });
  }

  /**
   * Shutdown a kernel session
   */
  async shutdownKernel(sessionId: string): Promise<ToolResult<void>> {
    const result = await this.fetch<void>(`/api/kernels/${sessionId}`, {
      method: 'DELETE',
    });
    if (result.success) {
      this.clearPinnedKernelSessionById(sessionId);
    }
    return result;
  }

  /**
   * Stop a kernel session (alias for shutdownKernel)
   */
  async stopKernel(sessionId: string): Promise<ToolResult<void>> {
    return this.shutdownKernel(sessionId);
  }

  // ===========================================================================
  // File Operations (non-notebook specific)
  // ===========================================================================

  /**
   * List files in a directory
   */
  async listFiles(path: string = '.'): Promise<ToolResult<{ name: string; type: string }[]>> {
    interface ListDirResponse {
      path: string;
      parent: string | null;
      mtime: number;
      items: Array<{
        name: string;
        path: string;
        isDirectory: boolean;
        size: string;
        modified: number;
        extension: string;
        fileType: string;
      }>;
    }

    const result = await this.fetch<ListDirResponse>(`/api/fs/list?path=${encodeURIComponent(path)}`);
    if (!result.success) return { success: false, error: result.error };

    // Transform the response to match expected format
    const items = result.data!.items.map((item) => ({
      name: item.name,
      type: item.isDirectory ? 'directory' : item.fileType || 'file',
    }));

    return { success: true, data: items };
  }

  /**
   * Read a file's content
   */
  async readFile(path: string): Promise<ToolResult<{ content: string }>> {
    interface ReadFileResponse {
      path: string;
      type: 'text' | 'notebook' | 'binary';
      content: any;
      message?: string;
    }

    const result = await this.fetch<ReadFileResponse>(`/api/fs/read?path=${encodeURIComponent(path)}`);
    if (!result.success) return { success: false, error: result.error };

    // Handle binary files
    if (result.data!.type === 'binary') {
      return { success: false, error: result.data!.message || 'Binary file cannot be read as text' };
    }

    // Handle notebook files (return as JSON string)
    if (result.data!.type === 'notebook') {
      return { success: true, data: { content: JSON.stringify(result.data!.content, null, 2) } };
    }

    // Handle text files
    return { success: true, data: { content: result.data!.content } };
  }

  /**
   * Write content to a file
   */
  async writeFile(path: string, content: string): Promise<ToolResult<void>> {
    return this.fetch<void>('/api/fs/write', {
      method: 'POST',
      body: JSON.stringify({ path, content, file_type: 'text' }),
    });
  }

  /**
   * Delete a file or directory
   */
  async deleteFile(path: string): Promise<ToolResult<void>> {
    return this.fetch<void>(`/api/fs/delete?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
  }

  /**
   * Rename/move a file or directory
   */
  async renameFile(oldPath: string, newPath: string): Promise<ToolResult<void>> {
    return this.fetch<void>('/api/fs/rename', {
      method: 'POST',
      body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
    });
  }

  /**
   * Download a file as Buffer (supports both text and binary)
   * Uses the /fs/download endpoint that streams raw file content
   */
  async downloadFile(serverPath: string): Promise<ToolResult<{ content: Buffer }>> {
    try {
      const url = `${this.baseUrl}/api/fs/download?path=${encodeURIComponent(serverPath)}`;
      const response = await fetch(url, { headers: this.authHeaders() });

      if (!response.ok) {
        const errorText = await response.text();
        let errorDetail = 'Download failed';
        try {
          const errorJson = JSON.parse(errorText);
          errorDetail = errorJson.detail || errorDetail;
        } catch {
          errorDetail = errorText || errorDetail;
        }
        return { success: false, error: errorDetail };
      }

      const arrayBuffer = await response.arrayBuffer();
      const content = Buffer.from(arrayBuffer);

      return { success: true, data: { content } };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { success: false, error: `Download failed: ${error}` };
    }
  }

  /**
   * Upload a file using multipart form data (supports binary)
   */
  async uploadFile(
    destDir: string,
    content: Buffer,
    filename: string,
    options: { onConflict?: 'rename' | 'overwrite' | 'fail' } = {}
  ): Promise<ToolResult<{ path: string; name: string }>> {
    try {
      const blob = new Blob([content]);
      const formData = new FormData();
      // Path must precede the file part. The Nebula backend uses
      // @fastify/multipart request.file(), which may not expose fields that
      // arrive after the file stream in the multipart payload.
      formData.append('path', destDir);
      formData.append('file', blob, filename);

      const conflictQ = options.onConflict ? `?on_conflict=${options.onConflict}` : '';
      const url = `${this.baseUrl}/api/fs/upload${conflictQ}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: this.authHeaders(),
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorDetail = 'Upload failed';
        try {
          const errorJson = JSON.parse(errorText);
          errorDetail = errorJson.detail || errorDetail;
        } catch {
          errorDetail = errorText || errorDetail;
        }
        return { success: false, error: errorDetail };
      }

      // The server may have stored the file under a DIFFERENT name than
      // requested ('rename' conflict policy) — return its answer, never
      // assume. Reporting the requested path as written sent an agent's
      // edits to a `_1` copy nobody was reading (lab report).
      try {
        const body = await response.json() as { file?: { path?: string; name?: string } };
        if (body?.file?.path && body.file.name) {
          return { success: true, data: { path: body.file.path, name: body.file.name } };
        }
      } catch { /* older server without a body — fall through */ }
      return { success: true, data: { path: `${destDir.replace(/\/+$/, '')}/${filename}`, name: filename } };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { success: false, error: `Upload failed: ${error}` };
    }
  }

  /**
   * Get the metadata schema from Nebula API
   */
  async getMetadataSchema(): Promise<ToolResult<MetadataSchema>> {
    return this.fetch<MetadataSchema>('/api/cell/metadata-schema');
  }

  // ===========================================================================
  // Execution
  // ===========================================================================

  /**
   * Execute a cell in a notebook and save the outputs back
   *
   * This combines read -> execute -> save into a single operation,
   * eliminating round-trips for the common iterative workflow.
   *
   * Supports both cellIndex (positional) and cellId (stable).
   * When save is true, outputs are saved incrementally during execution
   * so the notebook file reflects progress in real-time.
   */
  async executeCell(
    path: string,
    sessionId: string,
    options: {
      cellIndex?: number;
      cellId?: string;
      timeout?: number;
      save?: boolean;
      saveIntervalMs?: number;
    } = {}
  ): Promise<ToolResult<ExecutionResult & { cellIndex: number; cellId: string }>> {
    const { cellIndex, cellId, timeout = 60000, save = true, saveIntervalMs = 2000 } = options;

    if (cellIndex === undefined && cellId === undefined) {
      return { success: false, error: 'Must provide either cellIndex or cellId' };
    }

    // Read the notebook via router (gets UI state if connected, else file)
    const notebookResult = await this.readNotebookViaRouter(path);
    if (!notebookResult.success) {
      return { success: false, error: notebookResult.error };
    }

    const notebook = notebookResult.data!;
    let foundIndex: number = -1;
    let cell: NotebookCell | undefined;

    if (cellId !== undefined) {
      foundIndex = notebook.cells.findIndex(c => c.id === cellId);
      if (foundIndex === -1) {
        return { success: false, error: `Cell with id '${cellId}' not found` };
      }
      cell = notebook.cells[foundIndex];
    } else {
      if (cellIndex! < 0 || cellIndex! >= notebook.cells.length) {
        return { success: false, error: `Cell index ${cellIndex} out of range (0-${notebook.cells.length - 1})` };
      }
      foundIndex = cellIndex!;
      cell = notebook.cells[foundIndex];
    }

    if (cell.type !== 'code') {
      return { success: false, error: `Cell ${foundIndex} is not a code cell (type: ${cell.type})` };
    }

    // Execute with incremental saves via operation router
    const result = await this.executeWithIncrementalSave(
      sessionId,
      cell.content,
      path,
      cell.id,
      { timeout, save, saveIntervalMs }
    );

    return {
      success: result.success,
      data: result.data ? {
        ...result.data,
        cellIndex: foundIndex,
        cellId: cell.id,
      } : undefined,
      error: result.error,
    };
  }

  /**
   * Execute code with incremental saves via operation router
   * Outputs are sent to UI (if connected) or saved to file via updateOutputs operation
   */
  private async executeWithIncrementalSave(
    sessionId: string,
    code: string,
    path: string,
    cellId: string,
    options: { timeout: number; save: boolean; saveIntervalMs: number }
  ): Promise<ToolResult<ExecutionResult>> {
    const { timeout, save, saveIntervalMs } = options;

    return new Promise((resolve) => {
      const wsUrl = this.baseUrl.replace(/^http/, 'ws') + `/api/kernels/${sessionId}/ws`;
      const outputs: CellOutput[] = [];
      let executionCount: number | undefined;
      let hasError = false;
      let errorMessage: string | undefined;
      let lastSaveTime = Date.now();
      let saveTimer: ReturnType<typeof setInterval> | undefined;

      const saveOutputs = async () => {
        if (!save) return;
        // Use operation router to update outputs (goes to UI if connected)
        await this.updateOutputsOp(path, cellId, [...outputs], executionCount);
        lastSaveTime = Date.now();
      };

      const connectWs = async () => {
        try {
          const WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : (await import('ws')).default;
          const ws = new WebSocketImpl(wsUrl);

          const timeoutTimer = setTimeout(async () => {
            if (saveTimer) clearInterval(saveTimer);
            await saveOutputs(); // Final save before closing
            ws.close();
            resolve({
              success: true, // Timeout is not an error, just incomplete
              data: { outputs, success: true, executionCount },
            });
          }, timeout);

          // Set up periodic save interval
          if (save) {
            saveTimer = setInterval(async () => {
              if (outputs.length > 0 && Date.now() - lastSaveTime >= saveIntervalMs) {
                await saveOutputs();
              }
            }, saveIntervalMs);
          }

          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'execute', code }));
          };

          ws.onmessage = (event: { data: string | Buffer }) => {
            try {
              const data = typeof event.data === 'string' ? event.data : event.data.toString();
              const msg = JSON.parse(data);

              if (msg.type === 'output') {
                outputs.push(this.parseJupyterOutput(msg.output));
              } else if (msg.type === 'result') {
                executionCount = msg.result?.execution_count;
                if (msg.result?.outputs) {
                  outputs.push(...msg.result.outputs.map((o: any) => this.parseJupyterOutput(o)));
                }
              } else if (msg.type === 'error') {
                hasError = true;
                errorMessage = msg.error;
                outputs.push({ type: 'error', content: msg.error || 'Unknown error' });
              } else if (msg.type === 'status' && msg.status === 'idle') {
                clearTimeout(timeoutTimer);
                if (saveTimer) clearInterval(saveTimer);

                // Final save
                (async () => {
                  await saveOutputs();
                  ws.close();
                  resolve({
                    success: !hasError,
                    data: { outputs, success: !hasError, executionCount, error: errorMessage },
                  });
                })();
              }
            } catch (e) {
              // Ignore parse errors for non-JSON messages
            }
          };

          ws.onerror = async (error: any) => {
            clearTimeout(timeoutTimer);
            if (saveTimer) clearInterval(saveTimer);
            await saveOutputs(); // Save what we have
            ws.close();
            resolve({
              success: false,
              error: `WebSocket error: ${error.message || 'Unknown error'}`,
            });
          };

          ws.onclose = () => {
            clearTimeout(timeoutTimer);
            if (saveTimer) clearInterval(saveTimer);
          };
        } catch (e) {
          // Fall back to non-incremental execution
          const result = await this.executeCodeStreaming(sessionId, code, timeout);
          if (result.success && save) {
            await this.updateOutputsOp(path, cellId, result.data!.outputs, result.data!.executionCount);
          }
          resolve(result);
        }
      };

      connectWs();
    });
  }

  /**
   * Search cells in a notebook by keyword
   */
  async searchCells(path: string, query: string, limit: number = 5): Promise<ToolResult<SearchResult>> {
    const notebookResult = await this.readNotebookViaRouter(path);
    if (!notebookResult.success) {
      return { success: false, error: notebookResult.error };
    }

    const notebook = notebookResult.data!;
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);

    if (terms.length === 0) {
      return { success: true, data: { cells: [], totalCells: notebook.cells.length } };
    }

    // Score each cell
    const scored = notebook.cells.map((cell, index) => {
      const content = cell.content.toLowerCase();
      let score = 0;

      for (const term of terms) {
        const matches = (content.match(new RegExp(term, 'g')) || []).length;
        score += matches;
      }

      // Boost exact phrase matches
      if (content.includes(query.toLowerCase())) {
        score += 10;
      }

      return { ...cell, index, score };
    });

    // Filter and sort by score
    const matches = scored
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return {
      success: true,
      data: {
        cells: matches.map((m) => ({
          index: m.index,
          score: m.score,
          type: m.type,
          content: m.content,
          id: m.id,
        })),
        totalCells: notebook.cells.length,
      },
    };
  }

  // ===========================================================================
  // LLM Operations
  // ===========================================================================

  /**
   * Generate code using LLM
   */
  async generateCode(
    prompt: string,
    context?: string,
    provider?: string,
    model?: string
  ): Promise<ToolResult<string>> {
    return this.fetch<string>('/api/llm/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        context,
        provider,
        model,
      }),
    });
  }

  /**
   * Chat with notebook context
   */
  async chat(
    message: string,
    notebookContext: string,
    history?: { role: string; content: string }[],
    provider?: string,
    model?: string
  ): Promise<ToolResult<string>> {
    return this.fetch<string>('/api/llm/chat', {
      method: 'POST',
      body: JSON.stringify({
        message,
        context: notebookContext,
        history,
        provider,
        model,
      }),
    });
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private parseJupyterOutput(output: any): CellOutput {
    // Handle outputs already in internal format (from WebSocket)
    if (output.type && output.content !== undefined) {
      return {
        type: output.type,
        content: output.content,
      };
    }
    // Handle Jupyter notebook format
    if (output.output_type === 'stream') {
      return {
        type: output.name === 'stderr' ? 'stderr' : 'stdout',
        content: Array.isArray(output.text) ? output.text.join('') : output.text,
      };
    }
    if (output.output_type === 'error') {
      return {
        type: 'error',
        content: (output.traceback || []).join('\n'),
      };
    }
    if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
      if (output.data?.['image/png']) {
        return { type: 'image', content: output.data['image/png'] };
      }
      if (output.data?.['text/html']) {
        return { type: 'html', content: output.data['text/html'] };
      }
      if (output.data?.['text/plain']) {
        return { type: 'stdout', content: output.data['text/plain'] };
      }
    }
    return { type: 'stdout', content: JSON.stringify(output) };
  }

  private toJupyterOutput(output: CellOutput): any {
    switch (output.type) {
      case 'stdout':
        return { output_type: 'stream', name: 'stdout', text: output.content };
      case 'stderr':
        return { output_type: 'stream', name: 'stderr', text: output.content };
      case 'error':
        return { output_type: 'error', traceback: output.content.split('\n') };
      case 'image':
        return { output_type: 'display_data', data: { 'image/png': output.content } };
      case 'html':
        return { output_type: 'display_data', data: { 'text/html': output.content } };
      default:
        return { output_type: 'stream', name: 'stdout', text: output.content };
    }
  }

  // ===========================================================================
  // Operation-Based API (routes through backend to UI or headless)
  // ===========================================================================
  //
  // These methods use the Operation Router pattern:
  // 1. Client sends operation to POST /api/notebook/operation
  // 2. Backend checks if UI is connected via WebSocket
  // 3. If UI connected: forwards to UI, UI applies and returns result
  // 4. If no UI: applies via HeadlessOperationHandler (file-based)
  //
  // From the agent's perspective, both paths are identical.
  // ===========================================================================

  /**
   * Apply a notebook operation through the operation router.
   *
   * Operations are routed to:
   * - Connected UI via WebSocket (if available) - UI applies and saves
   * - Headless manager (file-based) otherwise
   *
   * From the agent's perspective, both modes behave identically.
   */
  async applyOperation(operation: import('../types.js').NotebookOperation): Promise<ToolResult<import('../types.js').OperationResult>> {
    if (this.agentId) {
      (operation as import('../types.js').NotebookOperation & import('../types.js').AgentContextFields).agentId = this.agentId;
      if (this.clientName) {
        (operation as import('../types.js').NotebookOperation & import('../types.js').AgentContextFields).clientName = this.clientName;
      }
      if (this.clientVersion) {
        (operation as import('../types.js').NotebookOperation & import('../types.js').AgentContextFields).clientVersion = this.clientVersion;
      }
      if (this.autoStartAgentSession && this.isWriteOperation(operation.type)) {
        const ensured = await this.ensureAgentSession(operation.notebookPath);
        if (!ensured.success) {
          return { success: false, error: ensured.error };
        }
      }
    }

    const result = await this.fetch<import('../types.js').OperationResult>('/api/notebook/operation', {
      method: 'POST',
      body: JSON.stringify({ operation }),
    });
    if (result.success) {
      this.recordBackend(result.data?.backend);
    }
    return result;
  }

  private isWriteOperation(opType: string): boolean {
    const readOnlyOps = new Set(['readCell', 'readCellOutput', 'searchCells', 'readNotebook']);
    const sessionOps = new Set(['startAgentSession', 'endAgentSession']);
    const creationOps = new Set(['createNotebook']); // File doesn't exist yet, no session needed
    return !readOnlyOps.has(opType) && !sessionOps.has(opType) && !creationOps.has(opType);
  }

  private async ensureAgentSession(path: string): Promise<ToolResult<{ warning?: string }>> {
    if (!this.agentId) {
      return { success: true, data: {} };
    }
    if (this.activeAgentSessions.has(path)) {
      return { success: true, data: {} };
    }
    const inFlight = this.agentSessionInFlight.get(path);
    if (inFlight) {
      return inFlight;
    }
    const shouldWarn = !this.autoStartWarnedPaths.has(path);
    const startPromise = this.startAgentSession(path, this.agentId);
    this.agentSessionInFlight.set(path, startPromise);
    try {
      const result = await startPromise;
      if (result.success && shouldWarn) {
        this.lastAutoStartWarning = `Auto-started agent session for ${path}. Call start_agent_session/end_agent_session explicitly.`;
        this.autoStartWarnedPaths.add(path);
      }
      return result;
    } finally {
      this.agentSessionInFlight.delete(path);
    }
  }

  /**
   * Read notebook through the operation router.
   *
   * If UI is connected, requests current state from UI.
   * Otherwise reads from file.
   */
  async readNotebookViaRouter(
    path: string,
    options: {
      includeOutputs?: boolean;
      maxLines?: number;
      maxChars?: number;
      maxLinesError?: number;
      maxCharsError?: number;
    } = {}
  ): Promise<ToolResult<Notebook>> {
    interface RouterReadResult {
      success: boolean;
      backend?: 'ui' | 'headless';
      data?: {
        path: string;
        cells: NotebookCell[];
        metadata?: Record<string, unknown>;
      };
      error?: string;
    }

    // Build query string with options
    const params = new URLSearchParams({ path });
    if (options.includeOutputs !== undefined) {
      params.set('include_outputs', String(options.includeOutputs));
    }
    if (options.maxLines !== undefined) {
      params.set('max_lines', String(options.maxLines));
    }
    if (options.maxChars !== undefined) {
      params.set('max_chars', String(options.maxChars));
    }
    if (options.maxLinesError !== undefined) {
      params.set('max_lines_error', String(options.maxLinesError));
    }
    if (options.maxCharsError !== undefined) {
      params.set('max_chars_error', String(options.maxCharsError));
    }

    const result = await this.fetch<RouterReadResult>(`/api/notebook/read?${params.toString()}`);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Router returns response with success/data/error structure
    const routerResult = result.data!;
    this.recordBackend(routerResult.backend);
    if (!routerResult.success) {
      return { success: false, error: routerResult.error };
    }

    return {
      success: true,
      data: {
        path: routerResult.data!.path,
        cells: routerResult.data!.cells,
        metadata: routerResult.data!.metadata,
        backend: routerResult.backend,
      },
    };
  }

  /**
   * Check if a UI is connected for a notebook path
   */
  async hasUI(path: string): Promise<boolean> {
    const result = await this.fetch<{ hasUI: boolean }>(`/api/notebook/has-ui?path=${encodeURIComponent(path)}`);
    return result.success && result.data?.hasUI === true;
  }

  // ===========================================================================
  // Operation-Based Notebook Methods
  // ===========================================================================

  /**
   * Create a new notebook using the operation router.
   *
   * Routes to UI if connected (UI creates file and tracks mtime),
   * otherwise creates via headless manager.
   *
   * @param path - Path to create the notebook
   * @param options - Optional settings
   * @param options.overwrite - Allow overwriting existing file (default: false)
   * @param options.kernelName - Kernel name (default: 'python3')
   * @param options.kernelDisplayName - Display name for kernel
   * @returns Result with path and mtime on success
   */
  async createNotebookOp(
    path: string,
    options: {
      overwrite?: boolean;
      kernelName?: string;
      kernelDisplayName?: string;
    } = {}
  ): Promise<ToolResult<{ path?: string; mtime?: number; popupBlocked?: boolean; popupMessage?: string }>> {
    const { overwrite = false, kernelName = 'python3', kernelDisplayName = 'Python 3' } = options;

    return this.applyOperation({
      type: 'createNotebook',
      notebookPath: path,
      overwrite,
      kernelName,
      kernelDisplayName,
    });
  }

  // ===========================================================================
  // Operation-Based Cell Methods
  // ===========================================================================

  /**
   * Insert a cell using the operation router
   */
  async insertCellOp(
    path: string,
    index: number,
    cell: { id: string; type: 'code' | 'markdown'; content: string; metadata?: CellMetadata }
  ): Promise<ToolResult<WriteCellResult>> {
    const operation: import('../types.js').InsertCellOp = {
      type: 'insertCell',
      notebookPath: path,
      index,
      cell,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }
    if (opResult.sessionId) {
      this.pinKernelSession(path, opResult.sessionId);
    }

    return {
      success: true,
      data: {
        cellIndex: opResult.cellIndex!,
        cellId: opResult.cellId!,
        totalCells: -1, // Not available from operation result
        idModified: opResult.idModified,
        requestedId: opResult.requestedId,
      },
    };
  }

  /**
   * Delete a cell using the operation router
   */
  async deleteCellOp(path: string, options: { cellId?: string; cellIndex?: number }): Promise<ToolResult<void>> {
    const operation: import('../types.js').DeleteCellOp = {
      type: 'deleteCell',
      notebookPath: path,
      cellId: options.cellId,
      cellIndex: options.cellIndex,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    return { success: true };
  }

  /**
   * Update cell content using the operation router
   */
  async updateContentOp(path: string, cellId: string, content: string): Promise<ToolResult<void>> {
    const operation: import('../types.js').UpdateContentOp = {
      type: 'updateContent',
      notebookPath: path,
      cellId,
      content,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    return { success: true };
  }

  /**
   * Update cell metadata using the operation router
   */
  async updateMetadataOp(path: string, cellId: string, changes: Record<string, unknown>): Promise<ToolResult<void>> {
    const operation: import('../types.js').UpdateMetadataOp = {
      type: 'updateMetadata',
      notebookPath: path,
      cellId,
      changes,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    return { success: true };
  }

  /**
   * Move a cell using the operation router
   *
   * Supports two modes:
   * 1. By index: moveCellOp(path, 0, 5) - move from index 0 to 5
   * 2. By ID: moveCellOp(path, 0, 0, { cellId: 'cell-1', afterCellId: 'cell-2' })
   */
  async moveCellOp(
    path: string,
    fromIndex: number,
    toIndex: number,
    options?: {
      cellId?: string;
      afterCellId?: string;
    }
  ): Promise<ToolResult<{
    cellId?: string;
    fromIndex: number;
    toIndex: number;
  }>> {
    const operation = {
      type: 'moveCell' as const,
      notebookPath: path,
      fromIndex,
      toIndex,
      ...(options?.cellId && { cellId: options.cellId }),
      ...(options?.afterCellId && { afterCellId: options.afterCellId }),
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    return {
      success: true,
      data: {
        cellId: opResult.cellId,
        fromIndex: opResult.fromIndex ?? fromIndex,
        toIndex: opResult.toIndex ?? toIndex,
      },
    };
  }

  /**
   * Duplicate a cell using the operation router
   */
  async duplicateCellOp(path: string, cellIndex: number, newCellId: string): Promise<ToolResult<{
    cellIndex: number;
    cellId: string;
    metadata?: { totalCells?: number; operationTime?: number };
  }>> {
    const operation: import('../types.js').DuplicateCellOp = {
      type: 'duplicateCell',
      notebookPath: path,
      cellIndex,
      newCellId,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    return {
      success: true,
      data: {
        cellIndex: opResult.cellIndex!,
        cellId: opResult.cellId!,
        metadata: opResult.metadata  // Phase 2 ready: include metadata from backend
      },
    };
  }

  /**
   * Update cell outputs using the operation router
   */
  async updateOutputsOp(path: string, cellId: string, outputs: CellOutput[], executionCount?: number): Promise<ToolResult<void>> {
    const operation: import('../types.js').UpdateOutputsOp = {
      type: 'updateOutputs',
      notebookPath: path,
      cellId,
      outputs,
      executionCount,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    return { success: true };
  }

  // ===========================================================================
  // Read Operations (single cell, no full notebook read needed)
  // ===========================================================================

  /**
   * Read a single cell using the operation router.
   *
   * More efficient than readNotebook when you only need one cell.
   * Routes to UI if connected, otherwise reads from file.
   */
  async readCellOp(
    path: string,
    options: { cellId?: string; cellIndex?: number }
  ): Promise<ToolResult<{ cell: NotebookCell; cellIndex: number }>> {
    const operation: import('../types.js').ReadCellOp = {
      type: 'readCell',
      notebookPath: path,
      cellId: options.cellId,
      cellIndex: options.cellIndex,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    return {
      success: true,
      data: {
        cell: opResult.cell!,
        cellIndex: opResult.cellIndex!,
      },
    };
  }

  /**
   * Read cell outputs using the operation router.
   *
   * More efficient than readNotebook when you only need outputs.
   * Routes to UI if connected, otherwise reads from file.
   *
   * Supports truncation options for large outputs:
   * - maxLines: Max lines for regular output (default: 100)
   * - maxChars: Max characters for regular output (default: 10000)
   * - maxLinesError: Max lines for error output (default: 200)
   * - maxCharsError: Max characters for error output (default: 20000)
   * - lineOffset: Skip first N lines for pagination
   * - saveToFile: Force save full output to temp file
   */
  async readCellOutputOp(
    path: string,
    options: {
      cellId?: string;
      cellIndex?: number;
      maxLines?: number;
      maxChars?: number;
      maxLinesError?: number;
      maxCharsError?: number;
      lineOffset?: number;
      saveToFile?: boolean;
    }
  ): Promise<ToolResult<{
    outputs: Array<CellOutput & {
      truncated?: boolean;
      truncation_reason?: string | null;
      total_lines?: number;
      total_chars?: number;
      returned_range?: { start_line: number; end_line: number; char_count: number };
      temp_file?: string;
      temp_file_size?: number;
      is_binary?: boolean;
    }>;
    executionCount?: number;
    executionStatus?: 'idle' | 'busy' | 'error';
    cellId: string;
    cellIndex: number;
    temp_files?: string[];
  }>> {
    const operation: import('../types.js').ReadCellOutputOp = {
      type: 'readCellOutput',
      notebookPath: path,
      cellId: options.cellId,
      cellIndex: options.cellIndex,
      // Pass truncation options using snake_case for backend
      max_lines: options.maxLines,
      max_chars: options.maxChars,
      max_lines_error: options.maxLinesError,
      max_chars_error: options.maxCharsError,
      line_offset: options.lineOffset,
      save_to_file: options.saveToFile,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    return {
      success: true,
      data: {
        outputs: opResult.outputs || [],
        executionCount: opResult.executionCount,
        executionStatus: opResult.executionStatus,
        cellId: opResult.cellId!,
        cellIndex: opResult.cellIndex!,
        temp_files: opResult.temp_files,
      },
    };
  }

  /**
   * Clear all cells from a notebook using the operation router
   *
   * This is the proper way to clear a notebook - routes to UI if connected
   * or falls back to headless mode. Returns the number of cells deleted.
   */
  async clearNotebookOp(path: string): Promise<ToolResult<{
    deletedCount: number;
    metadata?: { totalCells?: number; operationTime?: number };
  }>> {
    const operation: import('../types.js').ClearNotebookOp = {
      type: 'clearNotebook',
      notebookPath: path,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    return {
      success: true,
      data: {
        deletedCount: opResult.deletedCount ?? 0,
        metadata: opResult.metadata  // Phase 2 ready: include metadata from backend
      },
    };
  }

  // ===========================================================================
  // Batch Operations (Phase 1 enhancements)
  // ===========================================================================

  /**
   * Delete multiple cells by ID in a single operation
   *
   * More efficient than multiple single deletes - handles index shifting automatically.
   */
  async deleteCellsOp(path: string, cellIds: string[]): Promise<ToolResult<{
    deletedCount: number;
    deletedIds: string[];
    notFound?: string[];
    totalCells: number;
  }>> {
    const operation = {
      type: 'deleteCells' as const,
      notebookPath: path,
      cellIds,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    return {
      success: true,
      data: {
        deletedCount: opResult.deletedCount ?? 0,
        deletedIds: opResult.deletedIds ?? [],
        notFound: opResult.notFound,
        totalCells: opResult.totalCells ?? 0,
      },
    };
  }

  /**
   * Insert multiple cells at a position in a single operation
   *
   * More efficient than multiple single inserts.
   */
  async insertCellsOp(
    path: string,
    cells: Array<{
      id?: string;
      type?: 'code' | 'markdown';
      content: string;
    }>,
    position: number = -1
  ): Promise<ToolResult<{
    insertedCount: number;
    insertedIds: string[];
    startIndex: number;
    totalCells: number;
  }>> {
    const operation = {
      type: 'insertCells' as const,
      notebookPath: path,
      cells,
      position,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    return {
      success: true,
      data: {
        insertedCount: opResult.insertedCount ?? 0,
        insertedIds: opResult.insertedIds ?? [],
        startIndex: opResult.startIndex ?? 0,
        totalCells: opResult.totalCells ?? 0,
      },
    };
  }

  /**
   * Search cells with optional output search
   *
   * Enhanced version that can search in cell outputs as well as source code.
   */
  async searchCellsOp(
    path: string,
    query: string,
    options: {
      includeOutputs?: boolean;
      limit?: number;
    } = {}
  ): Promise<ToolResult<{
    query: string;
    matchCount: number;
    matches: Array<{
      cellId: string;
      cellIndex: number;
      matchLocation: 'source' | 'output';
      matchLine?: number;
      outputIndex?: number;
      outputType?: string;
      preview: string;
    }>;
    hasMore: boolean;
  }>> {
    const operation = {
      type: 'searchCells' as const,
      notebookPath: path,
      query,
      includeOutputs: options.includeOutputs ?? false,
      limit: options.limit ?? 10,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    return {
      success: true,
      data: {
        query: opResult.query ?? query,
        matchCount: opResult.matchCount ?? 0,
        matches: opResult.matches ?? [],
        hasMore: opResult.hasMore ?? false,
      },
    };
  }

  /**
   * Clear outputs from one or more cells
   *
   * Useful for cleanup before sharing notebooks.
   */
  async clearOutputsOp(
    path: string,
    cellIds?: string[]
  ): Promise<ToolResult<{
    clearedCount: number;
    clearedIds: string[];
    notFound?: string[];
  }>> {
    const operation = {
      type: 'clearOutputs' as const,
      notebookPath: path,
      ...(cellIds && cellIds.length > 0 ? { cellIds } : {}),
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    return {
      success: true,
      data: {
        clearedCount: opResult.clearedCount ?? 0,
        clearedIds: opResult.clearedIds ?? [],
        notFound: opResult.notFound,
      },
    };
  }

  // ===========================================================================
  // Execution Operations
  // ===========================================================================

  /**
   * Execute a cell through the operation router
   *
   * Routes to UI if connected (shows running indicator) or executes in headless mode.
   * For long-running cells, returns with status="busy" after maxWait seconds.
   * Use readCellOutputOp with max_wait to poll for more output.
   */
  async executeCellOp(
    path: string,
    options: {
      cellId?: string;
      cellIndex?: number;
      sessionId?: string;
      maxWait?: number;
      saveOutputs?: boolean;
    }
  ): Promise<ToolResult<{
    cellId: string;
    cellIndex: number;
    executionStatus: 'idle' | 'busy' | 'error';
    executionCount?: number;
    outputs: Array<import('../types.js').CellOutput>;
    executionTime?: number;
    sessionId?: string;
    error?: string;
  }>> {
    const resolvedSession = options.sessionId
      ? { success: true as const, data: { sessionId: options.sessionId } }
      : await this.resolveKernelSessionIdForNotebook(path, {
          createIfMissing: true,
        });

    if (!resolvedSession.success) {
      return { success: false, error: resolvedSession.error };
    }

    const effectiveSessionId = resolvedSession.data!.sessionId;
    this.pinKernelSession(path, effectiveSessionId);

    const operation: import('../types.js').ExecuteCellOp = {
      type: 'executeCell',
      notebookPath: path,
      cellId: options.cellId,
      cellIndex: options.cellIndex,
      sessionId: effectiveSessionId,
      maxWait: options.maxWait,
      saveOutputs: options.saveOutputs,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    return {
      success: true,
      data: {
        cellId: opResult.cellId!,
        cellIndex: opResult.cellIndex!,
        executionStatus: opResult.executionStatus ?? 'idle',
        executionCount: opResult.executionCount,
        outputs: opResult.outputs ?? [],
        executionTime: opResult.executionTime,
        sessionId: opResult.sessionId,
        error: opResult.error,
      },
    };
  }

  // ===========================================================================
  // Agent Session Management
  // ===========================================================================
  //
  // Agent sessions provide:
  // 1. UI feedback: Shows "Agent" badge with purple styling when session active
  // 2. Conflict prevention: Warns if multiple agents try to access same notebook
  // 3. Session tracking: Records start time and agent ID for diagnostics
  //
  // Best practice: Always wrap agent operations in try/finally:
  //
  //   await client.startAgentSession(path, 'my-agent');
  //   try {
  //     // ... operations ...
  //   } finally {
  //     await client.endAgentSession(path);
  //   }
  //
  // In headless mode (no UI), session operations are no-ops that always succeed.
  // ===========================================================================

  /**
   * Start an agent session (locks notebook for agent use).
   * If a session is already active, returns a warning but still starts a new session.
   *
   * @param path - Path to the notebook file
   * @param agentId - Optional identifier for this agent session
   * @param force - If true, forcibly end any existing session and steal the lock.
   *                Use only with explicit user permission.
   * @param lastSessionTimestamp - Optional timestamp (ms) to fetch updates since last session.
   */
  async startAgentSession(
    path: string,
    agentId?: string,
    force?: boolean,
    lastSessionTimestamp?: number,
    exclusive?: boolean
  ): Promise<ToolResult<{
    warning?: string;
    previousSessionDuration?: number;
    updatesSince?: import('../types.js').UpdateSummary[];
  }>> {
    const operation: import('../types.js').StartAgentSessionOp & import('../types.js').AgentContextFields = {
      type: 'startAgentSession',
      notebookPath: path,
      agentId: agentId || this.agentId,
      clientName: this.clientName,
      clientVersion: this.clientVersion,
      force,
      lastSessionTimestamp,
      exclusive,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }
    this.activeAgentSessions.add(path);
    this.setActiveNotebookPath(path);
    await this.resolveKernelSessionIdForNotebook(path, { createIfMissing: false }).catch(() => undefined);

    return {
      success: true,
      data: {
        warning: opResult.warning,
        updatesSince: opResult.updatesSince,
      },
    };
  }

  /**
   * End an agent session (unlocks notebook).
   * Should be called when agent work is complete.
   */
  async endAgentSession(path: string): Promise<ToolResult<{
    sessionDuration?: number;
    warning?: string;
  }>> {
    const operation: import('../types.js').EndAgentSessionOp = {
      type: 'endAgentSession',
      notebookPath: path,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }
    this.activeAgentSessions.delete(path);
    this.clearActiveNotebookPath(path);
    this.clearPinnedKernelSession(path);

    return {
      success: true,
      data: {
        sessionDuration: opResult.sessionDuration,
        warning: opResult.warning,
      },
    };
  }

  // ===========================================================================
  // Python Environment Discovery
  // ===========================================================================

  /**
   * List available Python environments on the system.
   *
   * Discovers Python installations from:
   * - System Python
   * - Conda environments
   * - pyenv versions
   * - Virtual environments
   * - Homebrew Python
   */
  async listPythonEnvironments(refresh: boolean = false): Promise<ToolResult<Array<{
    name: string;
    path: string;
    version?: string;
    source: string;
    isActive?: boolean;
  }>>> {
    const result = await this.fetch<{
      environments: Array<{
        name: string;
        path: string;
        version?: string;
        source: string;
        is_active?: boolean;
      }>;
    }>(`/api/python/environments?refresh=${refresh}`);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      data: result.data!.environments.map(env => ({
        name: env.name,
        path: env.path,
        version: env.version,
        source: env.source,
        isActive: env.is_active,
      })),
    };
  }

  /**
   * Get detailed information about a Python environment.
   *
   * @param pythonPath - Path to the Python executable (optional, uses system Python if not provided)
   */
  async getPythonInfo(pythonPath?: string): Promise<ToolResult<{
    path: string;
    version: string;
    packages?: string[];
  }>> {
    try {
      // If no path provided, get info about the first available Python
      if (!pythonPath) {
        const envResult = await this.listPythonEnvironments();
        if (!envResult.success || !envResult.data?.length) {
          return { success: false, error: 'No Python environments found' };
        }
        pythonPath = envResult.data[0].path;
      }

      // For now, return basic info from the environment list
      // A more detailed endpoint could be added to the backend
      const envResult = await this.listPythonEnvironments();
      if (!envResult.success) {
        return { success: false, error: envResult.error };
      }

      const env = envResult.data?.find(e => e.path === pythonPath);
      if (!env) {
        return { success: false, error: `Python not found: ${pythonPath}` };
      }

      return {
        success: true,
        data: {
          path: env.path,
          version: env.version || 'unknown',
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  // ===========================================================================
  // Compute Allocations (scheduler-backed compute, /api/compute)
  // ===========================================================================
  //
  // Thin wrappers over the server's compute-allocation REST API. All routes
  // are no-ops (enabled: false / 400) when the server has no scheduler —
  // check computeStatus() first.
  // ===========================================================================

  /** Whether scheduler-backed compute is available on this server. */
  async computeStatus(): Promise<ToolResult<ComputeStatus>> {
    return this.fetch<ComputeStatus>('/api/compute/status');
  }

  /** Allowed partitions/QoS for the current user + a live load snapshot. */
  async listPartitions(): Promise<ToolResult<ComputePartitions>> {
    return this.fetch<ComputePartitions>('/api/compute/partitions');
  }

  /** QoS names a partition will accept (null = any). */
  async partitionQos(partition: string): Promise<ToolResult<{ allowed: string[] | null }>> {
    return this.fetch<{ allowed: string[] | null }>(
      `/api/compute/partition-qos?partition=${encodeURIComponent(partition)}`
    );
  }

  /** Dry-run estimated start time for a prospective allocation (no submit). */
  async estimateStart(spec: ComputeSpec): Promise<ToolResult<ComputeStartEstimate>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(spec)) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, String(value));
      }
    }
    return this.fetch<ComputeStartEstimate>(`/api/compute/estimate?${params.toString()}`);
  }

  /** List current allocations (pending / running / active / ended / …). */
  async listAllocations(): Promise<ToolResult<ComputeAllocation[]>> {
    const result = await this.fetch<{ allocations: ComputeAllocation[] }>('/api/compute/allocations');
    if (!result.success) return { success: false, error: result.error };
    return { success: true, data: result.data?.allocations ?? [] };
  }

  /** Submit a new compute allocation. Returns it in state 'pending'. */
  async createAllocation(spec: ComputeSpec): Promise<ToolResult<ComputeAllocation>> {
    return this.fetch<ComputeAllocation>('/api/compute/allocations', {
      method: 'POST',
      body: JSON.stringify(spec),
    });
  }

  /** Cancel an allocation (scancel + evict its server). */
  async cancelAllocation(id: string): Promise<ToolResult<{ cancelled: boolean }>> {
    return this.fetch<{ cancelled: boolean }>(`/api/compute/allocations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  // ===========================================================================
  // User Change Tracking
  // ===========================================================================

  /**
   * Get the last tool call timestamp for a notebook path.
   * Used internally to track user changes between tool calls.
   */
  getLastToolCallTimestamp(path: string): number {
    return this.lastToolCallTimestamp.get(path) ?? 0;
  }

  /**
   * Record the current time as the last tool call for a notebook path.
   * Called automatically after each operation.
   */
  recordToolCallTimestamp(path: string, timestamp?: number): void {
    this.lastToolCallTimestamp.set(path, timestamp ?? Date.now());
  }

  /**
   * Get updates since the last tool call for a notebook.
   *
   * Returns summaries of edits and events since the last recorded
   * tool call timestamp (no source filtering).
   */
  async getUpdatesSinceOp(path: string): Promise<ToolResult<{
    updates: import('../types.js').UpdateSummary[];
    sinceTimestamp: number;
    serverTimestamp: number;
  }>> {
    const sinceTimestamp = this.getLastToolCallTimestamp(path);

    const operation: import('../types.js').GetUpdatesSinceOp = {
      type: 'getUpdatesSince',
      notebookPath: path,
      sinceTimestamp,
    };

    const result = await this.applyOperation(operation);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const opResult = result.data!;
    if (!opResult.success) {
      return { success: false, error: opResult.error };
    }

    // Update the timestamp with server's timestamp if provided
    if (opResult.serverTimestamp) {
      this.recordToolCallTimestamp(path, opResult.serverTimestamp);
    }

    return {
      success: true,
      data: {
        updates: opResult.updatesSince ?? [],
        sinceTimestamp,
        serverTimestamp: opResult.serverTimestamp ?? Date.now(),
      },
    };
  }
}

/**
 * Create a new Nebula client
 */
export function createNebulaClient(config?: NebulaClientConfig): NebulaClient {
  return new NebulaClient(config);
}
