export interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string | string[];
  execution_count?: number | null;
  outputs?: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
  id?: string;
}
export interface Notebook {
  nbformat: 4;
  nbformat_minor?: number;
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
}
export function parseNotebook(input: string | Notebook): Notebook & {cells: (NotebookCell & {source: string})[]};
export function mountNotebook(target: HTMLElement, input: string | Notebook, options?: {title?: string; showCode?: boolean}): {setShowCode(value: boolean): void; destroy(): void};
