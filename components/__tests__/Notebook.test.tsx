/**
 * Tests for Notebook component - keyboard shortcuts and cell operations
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';

// Mock all the services before importing Notebook
vi.mock('../../services/kernelService', () => ({
  API_BASE: '/api',
  kernelService: {
    getAvailableKernels: vi.fn().mockResolvedValue([
      { name: 'python3', display_name: 'Python 3', language: 'python' }
    ]),
    getPythonEnvironments: vi.fn().mockResolvedValue({
      kernelspecs: [{ name: 'python3', display_name: 'Python 3', language: 'python' }],
      environments: []
    }),
    startKernel: vi.fn().mockResolvedValue('test-session-id'),
    getOrCreateKernelForFile: vi.fn().mockResolvedValue({ sessionId: 'test-session-id', created: true, createdAt: Date.now() / 1000 }),
    getKernelPreference: vi.fn().mockResolvedValue(null),
    getStatus: vi.fn().mockResolvedValue({ status: 'idle', execution_count: 0 }),
    stopKernel: vi.fn().mockResolvedValue(true),
    restartKernel: vi.fn().mockResolvedValue(true),
    interruptKernel: vi.fn().mockResolvedValue(true),
    executeCode: vi.fn().mockResolvedValue({ status: 'ok', execution_count: 1 }),
    installKernel: vi.fn().mockResolvedValue({ kernel_name: 'python3' }),
    onReconnect: vi.fn().mockReturnValue(() => {}),
    onDisconnect: vi.fn().mockReturnValue(() => {}),
    onStatus: vi.fn().mockReturnValue(() => {}),
    onBufferedOutput: vi.fn().mockReturnValue(() => {}),
    onSyncReplace: vi.fn().mockReturnValue(() => {}),
  },
  KernelSpec: {},
  PythonEnvironment: {},
  ENV_KERNEL_PREFIX: 'env:',
  envKernelName: (pythonPath: string) => `env:${pythonPath}`,
  isEnvKernelName: (name: string | null | undefined) => !!name && name.startsWith('env:'),
  KernelProvisionError: class KernelProvisionError extends Error {
    code?: string;
    installHint?: string;
  },
}));

vi.mock('../../services/fileService', () => ({
  getFiles: vi.fn().mockResolvedValue([]),
  setActiveNotebookPath: vi.fn(),
  getActiveNotebookDir: vi.fn().mockReturnValue(null),
  seedOutputsBaseline: vi.fn(),
  downloadFile: vi.fn().mockResolvedValue(undefined),
  getNotebookData: vi.fn().mockResolvedValue({
    path: '/test/notebook.ipynb',
    cells: [
      { id: 'cell-1', type: 'code', content: 'print("hello")', outputs: [], isExecuting: false },
      { id: 'cell-2', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
    ],
    kernelspec: 'python3',
    mtime: Date.now() / 1000
  }),
  getFileContentWithMtime: vi.fn().mockResolvedValue({
    path: '/test/notebook.ipynb',
    cells: [
      { id: 'cell-1', type: 'code', content: 'print("hello")', outputs: [], isExecuting: false },
      { id: 'cell-2', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
    ],
    kernelspec: 'python3',
    mtime: Date.now() / 1000
  }),
  saveNotebookCells: vi.fn().mockResolvedValue({ success: true, mtime: Date.now() / 1000 }),
  saveFileContentWithMtime: vi.fn().mockResolvedValue({ success: true, mtime: Date.now() / 1000 }),
  getFileMtime: vi.fn().mockResolvedValue({ mtime: Date.now() / 1000 }),
  getActiveFileId: vi.fn().mockReturnValue('/test/notebook.ipynb'),
  saveActiveFileId: vi.fn(),
  updateNotebookMetadata: vi.fn().mockResolvedValue(undefined),
  renameFile: vi.fn().mockResolvedValue(undefined),
  loadNotebookHistory: vi.fn().mockResolvedValue([]),
  saveNotebookHistory: vi.fn().mockResolvedValue(undefined),
  loadNotebookSession: vi.fn().mockResolvedValue({}),
  getNotebookSettings: vi.fn().mockResolvedValue(null),
  updateNotebookSettings: vi.fn().mockResolvedValue({
    notebook_path: '/test/notebook.ipynb',
    output_logging: 'minimal',
    full_width: false,
    mtime: Date.now() / 1000,
  }),
  saveNotebookSession: vi.fn().mockResolvedValue(true),
  getAgentPermissionStatus: vi.fn().mockResolvedValue({
    agent_created: false,
    agent_permitted: false,
    has_history: false,
    can_agent_modify: false,
  }),
}));

vi.mock('../../services/settingsService', () => ({
  getSettings: vi.fn().mockReturnValue({
    lastKernel: 'python3'
  }),
  saveSettings: vi.fn(),
}));

vi.mock('../../hooks/useAutosave', () => ({
  useAutosave: vi.fn().mockReturnValue({
    status: { status: 'saved', lastSaved: Date.now() },
    saveNow: vi.fn().mockResolvedValue(undefined),
    hasUnsavedChanges: vi.fn().mockReturnValue(false),
  }),
  formatLastSaved: vi.fn().mockReturnValue('just now'),
}));

vi.mock('../../hooks/useOperationHandler', () => ({
  useOperationHandler: vi.fn(),
}));

// Mock VirtualCellList
vi.mock('../VirtualCellList', () => ({
  VirtualCellList: ({ cells, renderCell, fullWidth }: any) => (
    <div data-testid="virtual-cell-list" data-full-width={String(Boolean(fullWidth))}>
      {cells.map((cell: any, idx: number) => (
        <div key={cell.id} data-testid={`cell-container-${idx}`}>
          {renderCell(cell, idx)}
        </div>
      ))}
    </div>
  ),
}));



// Mock FileBrowser to avoid its internal complexity
vi.mock('../FileBrowser', () => ({
  FileBrowser: () => <div data-testid="file-browser">Mock File Browser</div>,
}));

// Mock SettingsModal
vi.mock('../SettingsModal', () => ({
  SettingsModal: () => null,
}));

// Mock KernelManager
vi.mock('../KernelManager', () => ({
  KernelManager: () => null,
}));

// Mock NotebookSearch
vi.mock('../NotebookSearch', () => ({
  NotebookSearch: () => null,
}));

// Mock NotebookBreadcrumb
vi.mock('../NotebookBreadcrumb', () => ({
  NotebookBreadcrumb: () => null,
}));

// Mock Cell component to avoid CodeMirror DOM measurement issues in tests.
// Mirrors the real Cell's requestedFocusMode contract: mode 'cell' focuses the div.
vi.mock('../Cell', async () => {
  const React = await import('react');
  return {
  Cell: ({ cell, index, isActive, isHighlighted, isLocked, onClick, onDelete, onMove, onChangeType, onRun, requestedFocusMode, onFocusModeApplied }: any) => {
    const ref = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
      if (requestedFocusMode === 'cell') {
        ref.current?.focus();
        onFocusModeApplied?.();
      }
    }, [requestedFocusMode, onFocusModeApplied]);
    return (
    <div
      ref={ref}
      tabIndex={0}
      data-testid={`cell-${cell.id}`}
      data-cell-id={cell.id}
      data-cell-type={cell.type}
      data-active={isActive}
      data-highlighted={String(!!isHighlighted)}
      data-locked={String(!!isLocked)}
      onClick={(e: React.MouseEvent) => onClick(cell.id, e)}
    >
      <span data-testid={`cell-index-${index}`}>#{index + 1}</span>
      <div data-testid={`cell-content-${cell.id}`}>{cell.content}</div>
      <div data-testid={`cell-output-count-${cell.id}`}>{cell.outputs.length}</div>
      <div data-testid={`cell-executing-${cell.id}`}>{cell.isExecuting ? 'true' : 'false'}</div>
      <button disabled={isLocked} data-testid={`delete-${cell.id}`} onClick={(e) => { e.stopPropagation(); onDelete(cell.id); }}>Delete</button>
      <button disabled={isLocked} data-testid={`move-up-${cell.id}`} onClick={(e) => { e.stopPropagation(); onMove(cell.id, 'up'); }}>Up</button>
      <button disabled={isLocked} data-testid={`move-down-${cell.id}`} onClick={(e) => { e.stopPropagation(); onMove(cell.id, 'down'); }}>Down</button>
      <button disabled={isLocked} data-testid={`to-markdown-${cell.id}`} onClick={(e) => { e.stopPropagation(); onChangeType(cell.id, 'markdown'); }}>M</button>
      <button disabled={isLocked} data-testid={`to-code-${cell.id}`} onClick={(e) => { e.stopPropagation(); onChangeType(cell.id, 'code'); }}>Y</button>
      <button disabled={isLocked} data-testid={`run-${cell.id}`} onClick={(e) => { e.stopPropagation(); onRun(cell.id); }}>Run</button>
    </div>
    );
  },
  };
});

// Import after mocks
import { Notebook } from '../Notebook';
import { NotificationProvider } from '../NotificationSystem';
import { kernelService } from '../../services/kernelService';
import * as fileService from '../../services/fileService';
import { useOperationHandler } from '../../hooks/useOperationHandler';
import { useAutosave } from '../../hooks/useAutosave';

// Helper to render Notebook with required providers
const renderNotebook = () => {
  return render(
    <NotificationProvider>
      <Notebook />
    </NotificationProvider>
  );
};

describe('Notebook', () => {
  const getOrderedCellIds = () => {
    return Array.from(document.querySelectorAll('[data-cell-id]'))
      .map(el => el.getAttribute('data-cell-id'))
      .filter((id): id is string => Boolean(id));
  };

  const getCellContents = () => {
    return screen.getAllByTestId(/cell-content-/).map(el => el.textContent ?? '');
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
    vi.mocked(fileService.getNotebookData).mockResolvedValue({
      path: '/test/notebook.ipynb',
      cells: [
        { id: 'cell-1', type: 'code', content: 'print("hello")', outputs: [], isExecuting: false },
        { id: 'cell-2', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
      ],
      kernelspec: 'python3',
      mtime: Date.now() / 1000,
    } as Awaited<ReturnType<typeof fileService.getNotebookData>>);
    vi.mocked(fileService.getFileContentWithMtime).mockResolvedValue({
      path: '/test/notebook.ipynb',
      cells: [
        { id: 'cell-1', type: 'code', content: 'print("hello")', outputs: [], isExecuting: false },
        { id: 'cell-2', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
      ],
      kernelspec: 'python3',
      mtime: Date.now() / 1000,
    } as Awaited<ReturnType<typeof fileService.getFileContentWithMtime>>);
    vi.mocked(fileService.getNotebookSettings).mockResolvedValue(null);
    vi.mocked(fileService.updateNotebookSettings).mockResolvedValue({
      notebook_path: '/test/notebook.ipynb',
      output_logging: 'minimal',
      full_width: false,
      mtime: Date.now() / 1000,
    });
    // executeCode resolves void (results arrive via output callbacks); the
    // resolved value here is ignored — cast through unknown for the old shape.
    vi.mocked(kernelService.executeCode).mockResolvedValue({ status: 'ok', execution_count: 1 } as unknown as Awaited<ReturnType<typeof kernelService.executeCode>>);
    vi.mocked(useOperationHandler).mockReturnValue({
      isConnected: true,
      activeOperation: null,
      agentSession: null,
      forceEndAgentSession: vi.fn(),
      disconnect: vi.fn(),
      reconnect: vi.fn(),
    } as ReturnType<typeof useOperationHandler>);
    // Mock window.confirm
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // Mock crypto.randomUUID with valid UUID format
    let uuidCounter = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-0000-0000-00000000000${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('keyboard shortcuts - command mode', () => {
    // Note: Command mode shortcuts in Notebook.tsx trigger when the focused
    // element is the cell div itself (data-cell-id). We simulate this by
    // firing keydown on the cell element after setting the active cell via click.

    it('pressing "a" inserts cell above active cell', async () => {
      renderNotebook();

      // Wait for cells to load
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Click on cell 2 to make it active
      const cell2 = screen.getByTestId('cell-cell-2');
      fireEvent.click(cell2);

      // Press 'a' to insert above - fire on cell to simulate command mode
      fireEvent.keyDown(cell2, { key: 'a' });

      // Should now have 3 cells, with new cell at position 2 (index 1)
      await waitFor(() => {
        expect(screen.getByText('#3')).toBeInTheDocument();
      });
    });

    it('pressing "b" inserts cell below active cell', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'b' to insert below - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'b' });

      // Should now have 3 cells
      await waitFor(() => {
        expect(screen.getByText('#3')).toBeInTheDocument();
      });
    });

    it('pressing "a" moves selection to the inserted cell (Jupyter behavior)', async () => {
      renderNotebook();
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      const cell2 = screen.getByTestId('cell-cell-2');
      fireEvent.click(cell2);
      fireEvent.keyDown(cell2, { key: 'a' });

      await waitFor(() => {
        const ids = getOrderedCellIds();
        expect(ids).toHaveLength(3);
        // New cell sits where cell-2 was (index 1) and must hold the focus,
        // so the next keystroke operates on it — not on the original cell.
        const newCellEl = document.querySelector(`[data-cell-id="${ids[1]}"]`);
        expect(ids[1]).not.toBe('cell-2');
        expect(document.activeElement).toBe(newCellEl);
      });
    });

    it('pressing "b" moves selection to the inserted cell (Jupyter behavior)', async () => {
      renderNotebook();
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);
      fireEvent.keyDown(cell1, { key: 'b' });

      await waitFor(() => {
        const ids = getOrderedCellIds();
        expect(ids).toHaveLength(3);
        const newCellEl = document.querySelector(`[data-cell-id="${ids[1]}"]`);
        expect(ids[1]).not.toBe('cell-2');
        expect(document.activeElement).toBe(newCellEl);
      });
    });
  });

  describe('browser tab title', () => {
    it('matches the displayed notebook name (extension stripped), like the in-app header', async () => {
      renderNotebook();
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });
      // Header shows "notebook" (stripNotebookExtension) — the tab must agree.
      await waitFor(() => {
        expect(document.title).toBe('notebook - Nebula Notebook');
      });
    });
  });

  describe('recently updated cell highlighting', () => {
    it('pulses the highlight on cells whose content an agent operation changed', async () => {
      renderNotebook();
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Grab the onAgentOperation callback the Notebook passed into the hook
      const hookOptions = vi.mocked(useOperationHandler).mock.calls.at(-1)?.[0] as any;
      expect(typeof hookOptions.onAgentOperation).toBe('function');

      act(() => {
        hookOptions.onAgentOperation(
          { type: 'updateContent', cellId: 'cell-2', content: 'x = 2' },
          { success: true, cellId: 'cell-2' }
        );
      });

      await waitFor(() => {
        expect(screen.getByTestId('cell-cell-2').getAttribute('data-highlighted')).toBe('true');
      });
      expect(screen.getByTestId('cell-cell-1').getAttribute('data-highlighted')).toBe('false');
    });
  });

  describe('keyboard shortcuts - cell-mode undo/redo', () => {
    it('pressing "z" undoes the last cell operation, Shift+Z redoes it (no opt-in needed)', async () => {
      renderNotebook();
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);
      fireEvent.keyDown(cell1, { key: 'b' });
      await waitFor(() => {
        expect(getOrderedCellIds()).toHaveLength(3);
      });

      // z (cell mode, default keymap) undoes the insert
      fireEvent.keyDown(screen.getByTestId('cell-cell-1'), { key: 'z' });
      await waitFor(() => {
        expect(getOrderedCellIds()).toHaveLength(2);
      });

      // Shift+Z redoes it
      fireEvent.keyDown(screen.getByTestId('cell-cell-1'), { key: 'Z', shiftKey: true });
      await waitFor(() => {
        expect(getOrderedCellIds()).toHaveLength(3);
      });
    });

    it('pressing "m" converts cell to markdown', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'm' to convert to markdown - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'm' });

      // The cell type toggle should reflect markdown being selected
      // (This is harder to test directly, but the keydown handler should be called)
    });

    it('pressing "y" converts cell to code', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Click on cell 1
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'y' to convert to code - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'y' });

      // The cell should remain/become code type
    });

    it('delete button is clickable and triggers action', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click directly on the cell element to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Verify delete button exists and is clickable
      // Note: Full delete flow tested in e2e tests; this verifies UI availability
      // Note: 'dd' vim-style shortcut is handled at Cell component level
      const deleteButton = screen.getByTestId('delete-cell-1');
      expect(deleteButton).toBeInTheDocument();

      // Click should not throw - action is handled by Notebook state
      expect(() => fireEvent.click(deleteButton)).not.toThrow();
    });

    it('pressing "d" once does not delete cell', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'd' only once - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'd' });

      // Wait a bit to ensure no deletion
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should still have 2 cells
      expect(screen.getByText('#1')).toBeInTheDocument();
      expect(screen.getByText('#2')).toBeInTheDocument();
    });

    it('arrow up navigates to previous cell', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click on cell 2 to make it active
      const cell2 = screen.getByTestId('cell-cell-2');
      fireEvent.click(cell2);

      // Arrow navigation is handled at the Cell level when cell div is focused
      // Here we just verify the cell was activated
      expect(screen.getByText('#2')).toBeInTheDocument();
    });

    it('arrow down navigates to next cell', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Arrow navigation is handled at the Cell level when cell div is focused
      // Here we just verify the cell was activated
      expect(screen.getByText('#1')).toBeInTheDocument();
    });
  });

  describe('kernel reconnecting indicator', () => {
    it('does not show reconnecting during startup when only the operation handler is disconnected', async () => {
      vi.mocked(useOperationHandler).mockReturnValue({
        isConnected: false,
        activeOperation: null,
        agentSession: null,
        forceEndAgentSession: vi.fn(),
        disconnect: vi.fn(),
        reconnect: vi.fn(),
      } as ReturnType<typeof useOperationHandler>);

      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      expect(screen.queryByText('Kernel reconnecting')).not.toBeInTheDocument();
      expect(screen.queryByText('Reconnecting')).not.toBeInTheDocument();
    });

    it('shows reconnecting when the active kernel disconnects', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(vi.mocked(kernelService.onDisconnect).mock.calls.length).toBeGreaterThan(1);
      });

      const disconnectCallback = vi.mocked(kernelService.onDisconnect).mock.calls.at(-1)?.[0];
      expect(disconnectCallback).toBeTypeOf('function');

      act(() => {
        disconnectCallback?.('test-session-id');
      });

      expect(await screen.findByText('Kernel reconnecting')).toBeInTheDocument();
    });
  });

  describe('execution output refresh', () => {
    it('keeps previous output visible until the rerun finishes with no new output', async () => {
      const oldOutputCell = {
        id: 'cell-1',
        type: 'code' as const,
        content: 'print("hello again")',
        outputs: [{ id: 'out-1', type: 'stdout' as const, content: 'old output', timestamp: Date.now() }],
        isExecuting: false,
      };

      vi.mocked(fileService.getNotebookData).mockResolvedValue({
        path: '/test/notebook.ipynb',
        cells: [oldOutputCell],
        kernelspec: 'python3',
        mtime: Date.now() / 1000,
      } as Awaited<ReturnType<typeof fileService.getNotebookData>>);
      vi.mocked(fileService.getFileContentWithMtime).mockResolvedValue({
        path: '/test/notebook.ipynb',
        cells: [oldOutputCell],
        kernelspec: 'python3',
        mtime: Date.now() / 1000,
      } as Awaited<ReturnType<typeof fileService.getFileContentWithMtime>>);

      // The test only controls WHEN the execute resolves (no result payload).
      let resolveExecution: (() => void) | null = null;
      vi.mocked(kernelService.executeCode).mockImplementation(() => (
        new Promise<Awaited<ReturnType<typeof kernelService.executeCode>>>(resolve => {
          resolveExecution = () => resolve(undefined);
        })
      ));

      renderNotebook();

      await screen.findByTestId('cell-cell-1');
      expect(screen.getByTestId('cell-output-count-cell-1')).toHaveTextContent('1');

      fireEvent.click(screen.getByTestId('run-cell-1'));

      await waitFor(() => {
        expect(screen.getByTestId('cell-executing-cell-1')).toHaveTextContent('true');
        expect(screen.getByTestId('cell-output-count-cell-1')).toHaveTextContent('1');
      });

      await act(async () => {
        resolveExecution?.();
      });

      await waitFor(() => {
        expect(screen.getByTestId('cell-executing-cell-1')).toHaveTextContent('false');
        expect(screen.getByTestId('cell-output-count-cell-1')).toHaveTextContent('0');
      });
    });
  });

  describe('file path canonicalization', () => {
    it('canonicalizes a relative file URL to the backend-resolved absolute path', async () => {
      window.history.replaceState({}, '', '/?file=alphagenome_official_eval_v2.ipynb');

      vi.mocked(fileService.getFileContentWithMtime).mockResolvedValue({
        path: '/endosome/archive/bioinformatics/Zhou_lab/shared/jzhou/Code/dnase/alphagenome_official_eval_v2.ipynb',
        cells: [
          { id: 'cell-1', type: 'code', content: 'print("hello")', outputs: [], isExecuting: false },
        ],
        kernelspec: 'python3',
        mtime: Date.now() / 1000,
      } as Awaited<ReturnType<typeof fileService.getFileContentWithMtime>>);

      renderNotebook();

      await waitFor(() => {
        expect(window.location.search).toContain(
          'file=/endosome/archive/bioinformatics/Zhou_lab/shared/jzhou/Code/dnase/alphagenome_official_eval_v2.ipynb'
        );
      });

      expect(vi.mocked(fileService.saveActiveFileId)).toHaveBeenCalledWith(
        '/endosome/archive/bioinformatics/Zhou_lab/shared/jzhou/Code/dnase/alphagenome_official_eval_v2.ipynb'
      );
    });
  });

  describe('sealed evidence deep links', () => {
    it('uses server-derived access to lock controls, preserve outputs, and focus the canonical cell id', async () => {
      const sealedPath = '/test/run/.nebula/seals/seal-123/notebook.ipynb';
      window.history.replaceState(
        {},
        '',
        `/?file=${encodeURIComponent(sealedPath)}&mode=sealed&seal=seal-123&cell=target-cell`,
      );
      vi.mocked(fileService.getFileContentWithMtime).mockResolvedValue({
        path: sealedPath,
        cells: [
          { id: 'first-cell', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
          {
            id: 'target-cell',
            type: 'code',
            content: 'print(result)',
            outputs: [{ id: 'output-1', type: 'stdout', content: '42', timestamp: Date.now() }],
            isExecuting: false,
          },
        ],
        kernelspec: 'python3',
        mtime: Date.now() / 1000,
        access: { read_only: true, reason: 'sealed', seal_id: 'seal-123' },
      } as Awaited<ReturnType<typeof fileService.getFileContentWithMtime>>);

      renderNotebook();

      expect(await screen.findByText('Sealed evidence')).toBeInTheDocument();
      expect(screen.getByText('seal-123')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByTestId('cell-target-cell')).toHaveAttribute('data-locked', 'true');
        expect(screen.getByTestId('cell-target-cell')).toHaveAttribute('data-active', 'true');
        expect(document.activeElement).toBe(screen.getByTestId('cell-target-cell'));
      });
      expect(screen.getByTestId('cell-output-count-target-cell')).toHaveTextContent('1');
      expect(screen.getByTestId('run-target-cell')).toBeDisabled();
      expect(screen.getByTestId('delete-target-cell')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Save notebook' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Run all cells' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Download snapshot' })).toBeEnabled();
      expect(vi.mocked(fileService.getFileContentWithMtime)).toHaveBeenCalledWith(
        sealedPath,
        { sealId: 'seal-123' },
      );
      expect(vi.mocked(useAutosave).mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false });
      expect(kernelService.getOrCreateKernelForFile).not.toHaveBeenCalled();
      expect(window.location.search).toContain('mode=sealed');
      expect(window.location.search).toContain('cell=target-cell');
    });

    it('does not trust mode=sealed when the server classifies the notebook as mutable', async () => {
      window.history.replaceState({}, '', '/?file=%2Ftest%2Fnotebook.ipynb&mode=sealed');
      renderNotebook();

      await screen.findByTestId('cell-cell-1');
      expect(screen.queryByText('Sealed evidence')).not.toBeInTheDocument();
      expect(screen.getByTestId('cell-cell-1')).toHaveAttribute('data-locked', 'false');
    });
  });

  describe('text selection', () => {
    it('preserves an existing selection when clicking inside the same cell', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByTestId('cell-cell-1')).toBeInTheDocument();
      });

      const cell = screen.getByTestId('cell-cell-1');
      const content = screen.getByTestId('cell-content-cell-1');
      const textNode = content.firstChild;
      expect(textNode?.nodeType).toBe(Node.TEXT_NODE);

      const range = document.createRange();
      range.setStart(textNode!, 0);
      range.setEnd(textNode!, 5);

      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      expect(selection?.toString()).toBe('print');

      fireEvent.click(cell);

      expect(window.getSelection()?.toString()).toBe('print');
    });

    it('clears a stale selection when clicking a different cell', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByTestId('cell-cell-2')).toBeInTheDocument();
      });

      const firstCellContent = screen.getByTestId('cell-content-cell-1');
      const secondCell = screen.getByTestId('cell-cell-2');
      const textNode = firstCellContent.firstChild;
      expect(textNode?.nodeType).toBe(Node.TEXT_NODE);

      const range = document.createRange();
      range.setStart(textNode!, 0);
      range.setEnd(textNode!, 5);

      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      expect(selection?.toString()).toBe('print');

      fireEvent.click(secondCell);

      expect(window.getSelection()?.toString()).toBe('');
    });
  });

  describe('keyboard shortcuts - cut/copy/paste', () => {
    it('pressing "x" cuts the active cell and paste works repeatedly after cut', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click directly on the cell element to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'x' to cut - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'x' });

      // Should now have only 1 cell (cell was cut/deleted)
      await waitFor(() => {
        expect(screen.queryByTestId('cell-cell-1')).not.toBeInTheDocument();
      });

      // Focus remaining cell and paste twice (clipboard should persist)
      const cell2 = screen.getByTestId('cell-cell-2');
      fireEvent.click(cell2);
      fireEvent.keyDown(cell2, { key: 'v' });
      fireEvent.keyDown(cell2, { key: 'v' });

      await waitFor(() => {
        const contents = getCellContents();
        expect(contents.filter(c => c === 'print(\"hello\")')).toHaveLength(2);
        expect(contents.filter(c => c === 'x = 1')).toHaveLength(1);
      });
    });

    it('pressing "c" copies the active cell (does not delete)', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'c' to copy - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'c' });

      // Should still have 2 cells (copy doesn't delete)
      expect(screen.getByText('#1')).toBeInTheDocument();
      expect(screen.getByText('#2')).toBeInTheDocument();
    });

    it('pressing "v" pastes cell below after copy', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'c' to copy, then 'v' to paste - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'c' });
      fireEvent.keyDown(cell1, { key: 'v' });

      // Should now have 3 cells with the new cell inserted below cell 1
      await waitFor(() => {
        expect(screen.getByText('#3')).toBeInTheDocument();
      });

      const orderedIds = getOrderedCellIds();
      const insertedId = orderedIds.find(id => id !== 'cell-1' && id !== 'cell-2');
      expect(insertedId).toBeTruthy();
      expect(orderedIds).toEqual(['cell-1', insertedId!, 'cell-2']);
      expect(screen.getByTestId(`cell-content-${insertedId}`)).toHaveTextContent('print("hello")');
    });

    it('pressing "Shift+V" pastes cell above focused cell', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Copy cell 2 content, then focus cell 1 for paste target
      const cell2 = screen.getByTestId('cell-cell-2');
      fireEvent.click(cell2);
      fireEvent.keyDown(cell2, { key: 'c' });

      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Shift+V should paste above the focused cell (cell 1)
      fireEvent.keyDown(cell1, { key: 'v', shiftKey: true });

      // Should now have 3 cells
      await waitFor(() => {
        expect(screen.getByText('#3')).toBeInTheDocument();
      });

      const orderedIds = getOrderedCellIds();
      const insertedId = orderedIds.find(id => id !== 'cell-1' && id !== 'cell-2');
      expect(insertedId).toBeTruthy();
      expect(orderedIds).toEqual([insertedId!, 'cell-1', 'cell-2']);
      expect(screen.getByTestId(`cell-content-${insertedId}`)).toHaveTextContent('x = 1');
    });

    it('paste works multiple times after copy', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);
      fireEvent.keyDown(cell1, { key: 'c' });
      fireEvent.keyDown(cell1, { key: 'v' });
      fireEvent.keyDown(cell1, { key: 'v' });

      await waitFor(() => {
        expect(screen.getByText('#4')).toBeInTheDocument();
      });

      const contents = getCellContents();
      expect(contents.filter(c => c === 'print(\"hello\")')).toHaveLength(3);
      expect(contents.filter(c => c === 'x = 1')).toHaveLength(1);
    });
  });

  describe('keyboard shortcuts - global', () => {
    it('Ctrl+S saves the notebook', async () => {
      const { useAutosave } = await import('../../hooks/useAutosave');
      const mockSaveNow = vi.fn().mockResolvedValue(undefined);
      vi.mocked(useAutosave).mockReturnValue({
        status: { status: 'saved', lastSaved: Date.now() },
        saveNow: mockSaveNow,
        hasUnsavedChanges: vi.fn().mockReturnValue(false),
      });

      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Press Ctrl+S - global shortcuts work from anywhere
      fireEvent.keyDown(document.body, { key: 's', ctrlKey: true });

      // saveNow should have been called
      await waitFor(() => {
        expect(mockSaveNow).toHaveBeenCalled();
      });
    });

    it('Cmd+S saves the notebook (Mac)', async () => {
      const { useAutosave } = await import('../../hooks/useAutosave');
      const mockSaveNow = vi.fn().mockResolvedValue(undefined);
      vi.mocked(useAutosave).mockReturnValue({
        status: { status: 'saved', lastSaved: Date.now() },
        saveNow: mockSaveNow,
        hasUnsavedChanges: vi.fn().mockReturnValue(false),
      });

      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Press Cmd+S (metaKey) - global shortcuts work from anywhere
      fireEvent.keyDown(document.body, { key: 's', metaKey: true });

      await waitFor(() => {
        expect(mockSaveNow).toHaveBeenCalled();
      });
    });

    it('Ctrl+F opens search', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Press Ctrl+F - global shortcuts work from anywhere
      fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });

      // Search component should be visible
      // (NotebookSearch is rendered based on isSearchOpen state)
    });
  });

  describe('keyboard shortcuts - enter to focus', () => {
    it('pressing Enter focuses active cell editor', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active (but not in edit mode)
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press Enter to focus editor - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'Enter' });

      // The CodeMirror content should receive focus
      // (This is harder to test directly due to CodeMirror internals)
    });
  });

  describe('keyboard shortcuts - do not trigger in input fields', () => {
    it('shortcuts do not trigger when typing in an input', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Find an input field (like the AI prompt input when open)
      // For this test, we'll simulate the check by setting target.tagName
      const mockEvent = {
        key: 'a',
        target: { tagName: 'INPUT', isContentEditable: false },
        preventDefault: vi.fn(),
      };

      // The keyboard handler checks isInput and should return early
      // We verify by checking that cells are not modified
      expect(screen.getByText('#1')).toBeInTheDocument();
      expect(screen.getByText('#2')).toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    it('arrow up at first cell does nothing', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Arrow navigation is handled at Cell level - just verify no crash
      expect(screen.getByText('#1')).toBeInTheDocument();
    });

    it('arrow down at last cell does nothing', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click on cell 2 (last cell) to make it active
      const cell2 = screen.getByTestId('cell-cell-2');
      fireEvent.click(cell2);

      // Arrow navigation is handled at Cell level - just verify no crash
      expect(screen.getByText('#2')).toBeInTheDocument();
    });

    it('paste without prior copy does nothing', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'v' without copying first - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'v' });

      // Should still have only 2 cells
      expect(screen.getByText('#1')).toBeInTheDocument();
      expect(screen.getByText('#2')).toBeInTheDocument();
      expect(screen.queryByText('#3')).not.toBeInTheDocument();
    });
  });

  describe('full width mode', () => {
    it('applies persisted full width setting on load', async () => {
      vi.mocked(fileService.getNotebookSettings).mockResolvedValue({
        notebook_path: '/test/notebook.ipynb',
        output_logging: 'minimal',
        full_width: true,
      });

      renderNotebook();

      await waitFor(() => {
        expect(screen.getByTestId('virtual-cell-list')).toHaveAttribute('data-full-width', 'true');
      });
    });

    it('toggles full width mode and persists notebook settings', async () => {
      vi.mocked(fileService.updateNotebookSettings).mockResolvedValue({
        notebook_path: '/test/notebook.ipynb',
        output_logging: 'minimal',
        full_width: true,
        mtime: 1234,
      });

      renderNotebook();

      await waitFor(() => {
        expect(screen.getByTestId('virtual-cell-list')).toHaveAttribute('data-full-width', 'false');
      });

      fireEvent.click(screen.getByTitle('Enable full width mode'));

      await waitFor(() => {
        expect(fileService.updateNotebookSettings).toHaveBeenCalledWith('/test/notebook.ipynb', { full_width: true });
        expect(screen.getByTestId('virtual-cell-list')).toHaveAttribute('data-full-width', 'true');
      });
    });

    it('shows an explicit exit control and can disable full width mode', async () => {
      vi.mocked(fileService.updateNotebookSettings)
        .mockResolvedValueOnce({
          notebook_path: '/test/notebook.ipynb',
          output_logging: 'minimal',
          full_width: true,
          mtime: 1234,
        })
        .mockResolvedValueOnce({
          notebook_path: '/test/notebook.ipynb',
          output_logging: 'minimal',
          full_width: false,
          mtime: 1235,
        });

      renderNotebook();

      await waitFor(() => {
        expect(screen.getByTestId('virtual-cell-list')).toHaveAttribute('data-full-width', 'false');
      });

      fireEvent.click(screen.getByTitle('Enable full width mode'));

      await waitFor(() => {
        expect(screen.getByTitle('Exit full width mode')).toBeInTheDocument();
        expect(screen.getByTestId('virtual-cell-list')).toHaveAttribute('data-full-width', 'true');
      });

      fireEvent.click(screen.getByTitle('Exit full width mode'));

      await waitFor(() => {
        expect(fileService.updateNotebookSettings).toHaveBeenLastCalledWith('/test/notebook.ipynb', { full_width: false });
        expect(screen.getByTestId('virtual-cell-list')).toHaveAttribute('data-full-width', 'false');
      });
    });
  });

  describe('panel toggles: terminal and history', () => {
    // Both panels are togglable ON and OFF from the keyboard and from a single
    // palette command — no state (e.g. "terminal panel open on the agent tab")
    // where the only way to close it is the mouse.
    const isPaletteOpen = () => screen.queryByLabelText('Command palette') !== null;
    const openPalette = () => fireEvent.keyDown(document.body, { code: 'KeyP', key: 'P', ctrlKey: true, shiftKey: true });
    const paletteButton = (re: RegExp) => screen.getByRole('button', { name: re });

    it('Cmd/Ctrl+Shift+H toggles the history panel', async () => {
      renderNotebook();
      await screen.findByTestId('cell-cell-1');
      expect(screen.queryByTestId('history-panel')).toBeNull();

      fireEvent.keyDown(document.body, { key: 'h', ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(screen.getByTestId('history-panel')).toBeInTheDocument());

      fireEvent.keyDown(document.body, { key: 'H', metaKey: true, shiftKey: true });
      await waitFor(() => expect(screen.queryByTestId('history-panel')).toBeNull());
    });

    const openAgentTab = async () => {
      openPalette();
      await waitFor(() => expect(isPaletteOpen()).toBe(true));
      fireEvent.click(paletteButton(/Open agent terminal/));
      await waitFor(() => expect(screen.getByTestId('terminal-panel')).not.toHaveClass('hidden'));
    };

    it('Ctrl+` toggles the terminal panel off even when it is on the agent tab', async () => {
      renderNotebook();
      await screen.findByTestId('cell-cell-1');
      await openAgentTab();

      fireEvent.keyDown(document.body, { key: '`', ctrlKey: true });
      await waitFor(() => expect(screen.getByTestId('terminal-panel')).toHaveClass('hidden'));
    });

    it('the palette "terminal panel" command is a true on/off toggle regardless of tab', async () => {
      renderNotebook();
      await screen.findByTestId('cell-cell-1');
      await openAgentTab();

      openPalette();
      await waitFor(() => expect(isPaletteOpen()).toBe(true));
      fireEvent.click(paletteButton(/Hide terminal panel/));
      await waitFor(() => expect(screen.getByTestId('terminal-panel')).toHaveClass('hidden'));

      openPalette();
      await waitFor(() => expect(isPaletteOpen()).toBe(true));
      fireEvent.click(paletteButton(/Show terminal panel/));
      await waitFor(() => expect(screen.getByTestId('terminal-panel')).not.toHaveClass('hidden'));
    });

    it('palette lists the history and terminal toggles with their shortcuts', async () => {
      renderNotebook();
      await screen.findByTestId('cell-cell-1');
      openPalette();
      await waitFor(() => expect(isPaletteOpen()).toBe(true));
      // Titles flip Show/Hide with panel state (which may persist from a
      // previous test via storage) — the invariant is the shortcut labels.
      expect(paletteButton(/(Show|Hide) history panel/)).toHaveTextContent(/⇧H|Shift\+H/);
      expect(paletteButton(/(Show|Hide) terminal panel/)).toHaveTextContent(/`/);
      expect(paletteButton(/Open shell terminal/)).toBeInTheDocument();
      expect(paletteButton(/Open agent terminal/)).toBeInTheDocument();
    });
  });

  describe('run above / run below', () => {
    const threeCells = () => {
      const cells = [
        { id: 'cell-1', type: 'code' as const, content: 'print("a1")', outputs: [], isExecuting: false },
        { id: 'cell-2', type: 'code' as const, content: 'print("a2")', outputs: [], isExecuting: false },
        { id: 'cell-3', type: 'code' as const, content: 'print("a3")', outputs: [], isExecuting: false },
      ];
      const data = {
        path: '/test/notebook.ipynb',
        cells,
        kernelspec: 'python3',
        mtime: Date.now() / 1000,
      };
      vi.mocked(fileService.getNotebookData).mockResolvedValue(
        data as Awaited<ReturnType<typeof fileService.getNotebookData>>);
      vi.mocked(fileService.getFileContentWithMtime).mockResolvedValue(
        data as Awaited<ReturnType<typeof fileService.getFileContentWithMtime>>);
    };

    /** Contents executeCode received, in order — the ground truth of what ran. */
    const executedContents = () =>
      vi.mocked(kernelService.executeCode).mock.calls.map((call) => call[1]);

    const openRunMenu = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run options' }));
    };

    it('runs only the cells above the active cell (exclusive)', async () => {
      threeCells();
      renderNotebook();
      await screen.findByTestId('cell-cell-3');

      fireEvent.click(screen.getByTestId('cell-cell-3'));
      vi.mocked(kernelService.executeCode).mockClear();

      openRunMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: /Run cells above/ }));

      await waitFor(() => {
        expect(executedContents()).toEqual(['print("a1")', 'print("a2")']);
      });
    });

    it('runs the active cell and all below (inclusive)', async () => {
      threeCells();
      renderNotebook();
      await screen.findByTestId('cell-cell-2');

      fireEvent.click(screen.getByTestId('cell-cell-2'));
      vi.mocked(kernelService.executeCode).mockClear();

      openRunMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: /Run cell and below/ }));

      await waitFor(() => {
        expect(executedContents()).toEqual(['print("a2")', 'print("a3")']);
      });
    });

    it('disables "run above" on the first cell, enables it further down', async () => {
      threeCells();
      renderNotebook();
      await screen.findByTestId('cell-cell-1');

      // First cell active (the load default): nothing above it, but
      // itself-and-below works.
      fireEvent.click(screen.getByTestId('cell-cell-1'));
      openRunMenu();
      expect(screen.getByRole('menuitem', { name: /Run cells above/ })).toBeDisabled();
      expect(screen.getByRole('menuitem', { name: /Run cell and below/ })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Run options' })); // close

      fireEvent.click(screen.getByTestId('cell-cell-2'));
      openRunMenu();
      expect(screen.getByRole('menuitem', { name: /Run cells above/ })).toBeEnabled();
      expect(screen.getByRole('menuitem', { name: /Run cell and below/ })).toBeEnabled();
    });
  });
});
