import type { CanonicalJsonValue } from './canonical-json';

export interface ProvenanceActor {
  /** Authenticated principal category, for example user, agent, or system. */
  kind: string;
  /** Stable principal identifier within the actor category. */
  id?: string;
  /** Optional human-readable client/principal label. */
  name?: string;
  attributes?: Record<string, CanonicalJsonValue>;
}

export interface ProvenanceEventInput {
  type: string;
  actor: ProvenanceActor;
  payload?: CanonicalJsonValue;
  runId?: string;
  taskId?: string;
  sourceId?: string;
  executionId?: string;
  inputManifestSha256?: string;
  environmentManifestSha256?: string;
  idempotencyKey?: string;
}

export interface ProvenanceEvent {
  schemaVersion: 1;
  eventId: string;
  seq: number;
  timestamp: string;
  notebookPath: string;
  type: string;
  actor: ProvenanceActor;
  payload: CanonicalJsonValue;
  runId?: string;
  taskId?: string;
  sourceId?: string;
  executionId?: string;
  inputManifestSha256?: string;
  environmentManifestSha256?: string;
  idempotencyKey?: string;
  idempotencyRequestHash?: string;
  prevHash: string | null;
  eventHash: string;
}

export interface ProvenanceAppendResult {
  event: ProvenanceEvent;
  appended: boolean;
}

export interface ProvenanceVerification {
  valid: boolean;
  eventCount: number;
  lastSeq: number;
  headHash: string | null;
  error?: string;
  failedLine?: number;
}

export interface ProvenanceBlobReference {
  sha256: string;
  sizeBytes: number;
}

export interface ProvenanceBlobVerification {
  valid: boolean;
  expectedSha256: string;
  actualSha256?: string;
  sizeBytes?: number;
  error?: string;
}

