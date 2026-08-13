/**
 * Kernel Service Types
 *
 * Types for Jupyter kernel management in Node.js
 */

/**
 * Jupyter kernelspec definition (from kernel.json files)
 */
export interface KernelSpec {
  name: string;
  displayName: string;
  language: string;
  path: string;
  argv?: string[];
  env?: Record<string, string>;
}

/**
 * Jupyter connection configuration
 * Contains port information for ZeroMQ channels
 */
export interface ConnectionConfig {
  ip: string;
  transport: string;
  signatureScheme: string;
  key: string;
  shellPort: number;
  stdinPort: number;
  controlPort: number;
  iopubPort: number;
  hbPort: number;
}

/**
 * Active kernel session
 */
export interface KernelSession {
  id: string;
  kernelName: string;
  filePath: string | null;
  status: KernelStatus;
  executionCount: number;
  pid: number | null;
  connectionFile: string | null;
  connectionConfig: ConnectionConfig | null;
  createdAt: number;
  lastActivity: number;
}

/**
 * Kernel status
 */
export type KernelStatus = 'starting' | 'idle' | 'busy' | 'dead';

/**
 * Persisted session for SQLite storage
 */
export interface PersistedSession {
  sessionId: string;
  kernelName: string;
  filePath: string | null;
  kernelPid: number | null;
  serverId?: string | null;
  serverInstanceId?: string | null;
  kernelStartTime?: string | null;
  status: 'active' | 'orphaned' | 'terminated';
  createdAt: number;
  lastHeartbeat: number;
  connectionFile: string | null;
  connectionConfig: string | null; // JSON-serialized connection config
}

/**
 * Kernel output types (matching Jupyter message types)
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type OutputType = 'stdout' | 'stderr' | 'image' | 'html' | 'error' | 'display_data';
export type MimeBundle = Record<string, JsonValue>;

/**
 * Kernel output message
 */
export interface KernelOutput {
  type: OutputType;
  content: string;
  mimeBundle?: MimeBundle;
  metadata?: Record<string, JsonValue>;
  preferredMimeType?: string;
  /** Exact protocol shape retained for immutable replay sealing. */
  jupyterOutputType?: 'execute_result' | 'display_data';
  /** Present for execute_result protocol messages. */
  jupyterExecutionCount?: number;
}

export interface InternalExecutionOptions {
  /** Server-authored probes use false so they cannot perturb notebook counts. */
  storeHistory?: false;
}

export interface SequencedKernelOutput {
  seq: number;
  output: KernelOutput;
  cellId?: string | null;
}

/**
 * Execution queue metadata for a kernel session.
 */
export interface ExecutionQueueInfo {
  /** Zero-based position of this request in the session queue. */
  queuePosition: number;
  /** Total number of requests queued for the session at enqueue time (includes this request). */
  queueLength: number;
}

/**
 * Execution result
 */
export interface ExecutionResult {
  status: 'ok' | 'error';
  executionCount: number | null;
  error?: string;
  queuePosition?: number;
  queueLength?: number;
}

/**
 * Options for starting a kernel
 */
export interface StartKernelOptions {
  kernelName?: string;
  cwd?: string;
  filePath?: string;
  /**
   * Server-only launch hardening. This is intentionally not accepted by the
   * public kernel HTTP route; replay sealing uses it to exclude user-site
   * packages before the Python process starts.
   */
  internalEnv?: {
    PYTHONNOUSERSITE?: '1';
  };
}

/**
 * Session info returned by API
 */
export interface SessionInfo {
  id: string;
  kernelName: string;
  filePath: string | null;
  status: KernelStatus;
  executionCount: number;
  memoryMb: number | null;
  pid: number | null;
  createdAt: number; // Unix timestamp in seconds
}

/**
 * Kernel service configuration
 */
export interface KernelServiceConfig {
  startupTimeoutSeconds?: number;
  shutdownTimeoutSeconds?: number;
  messageTimeoutSeconds?: number;
  pollingIntervalSeconds?: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Required<KernelServiceConfig> = {
  startupTimeoutSeconds: 60,
  shutdownTimeoutSeconds: 10,
  messageTimeoutSeconds: 5,
  pollingIntervalSeconds: 0.1,
};
