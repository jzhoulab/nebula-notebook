export type CellType = 'code' | 'markdown';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type OutputType = 'stdout' | 'stderr' | 'image' | 'html' | 'error' | 'display_data';
export type MimeBundle = Record<string, JsonValue>;

export interface CellOutput {
  id: string;
  type: OutputType;
  content: string;
  timestamp: number;
  mimeBundle?: MimeBundle;
  metadata?: Record<string, JsonValue>;
  preferredMimeType?: string;
}

export interface Cell {
  id: string;
  type: CellType;
  content: string;
  outputs: CellOutput[];
  isExecuting: boolean;
  pendingOutputReset?: boolean; // transient: hide previous-run outputs from read_output until fresh output arrives
  executionCount?: number;
  lastExecutionMs?: number;
  scrolled?: boolean; // Output collapsed state: true = collapsed with scrollbar (Jupyter standard)
  scrolledHeight?: number; // Height of output area when in scrolled mode (pixels)
  sourceCollapsed?: boolean; // Source (code) collapsed to a fixed height with its own scrollbar
  sourceHeight?: number; // Height of the source area when collapsed (pixels)
  _metadata?: Record<string, unknown>; // Preserve unknown metadata from external tools
}

export interface NotebookMetadata {
  id: string;
  name: string;
  lastModified: number;
  fileType?: 'notebook' | 'file';
  extension?: string;
  size?: string;
}

// Kernel types are now in services/kernelService.ts

// Tab types for multi-notebook support
export interface Tab {
  id: string;              // Unique tab ID (UUID)
  fileId: string;          // Path to the notebook file
  title: string;           // Display name (filename without .ipynb)
  isDirty: boolean;        // Has unsaved changes
  isLoading: boolean;      // Loading state
}

export type KernelStatus = 'idle' | 'busy' | 'starting' | 'disconnected' | 'dead';

// Per-notebook state - everything needed to manage a notebook's context
export interface NotebookState {
  tabId: string;
  fileId: string;
  cells: Cell[];
  activeCellId: string | null;
  kernelSessionId: string | null;
  kernelStatus: KernelStatus;
  kernelName: string;
  executionQueue: string[];
}
