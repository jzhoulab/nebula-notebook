// @vitest-environment node
/**
 * Filesystem Service Tests
 *
 * Comprehensive tests for all filesystem operations.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FilesystemService } from '../fs/fs-service';

describe('FilesystemService', () => {
  let service: FilesystemService;
  let testDir: string;

  beforeAll(() => {
    // Create a temporary test directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-fs-test-'));
  });

  afterAll(() => {
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    service = new FilesystemService(testDir);
  });

  describe('Path Normalization', () => {
    it('should normalize ~ to default root', () => {
      const normalized = service.normalizePath('~');
      expect(normalized).toBe(testDir);
    });

    it('should normalize ~/ paths relative to default root', () => {
      const normalized = service.normalizePath('~/subdir');
      expect(normalized).toBe(path.join(testDir, 'subdir'));
    });

    it('should handle absolute paths', () => {
      const absPath = '/tmp/test-file';
      const normalized = service.normalizePath(absPath);
      expect(normalized).toBe(absPath);
    });

    it('should resolve relative paths against the default root', () => {
      const normalized = service.normalizePath('motif_analysis_ag.ipynb');
      expect(normalized).toBe(path.join(testDir, 'motif_analysis_ag.ipynb'));
    });

    it('should handle empty path as default root', () => {
      const normalized = service.normalizePath('');
      expect(normalized).toBe(testDir);
    });
  });

  describe('Size Formatting', () => {
    it('should format bytes correctly', () => {
      expect(service.formatSize(500)).toBe('500B');
    });

    it('should format kilobytes correctly', () => {
      expect(service.formatSize(1536)).toBe('1.5KB');
    });

    it('should format megabytes correctly', () => {
      expect(service.formatSize(1572864)).toBe('1.5MB');
    });

    it('should format gigabytes correctly', () => {
      expect(service.formatSize(1610612736)).toBe('1.5GB');
    });
  });

  describe('File Type Detection', () => {
    it('should detect notebook files', () => {
      expect(service.getFileType('.ipynb')).toBe('notebook');
    });

    it('should detect code files', () => {
      expect(service.getFileType('.py')).toBe('code');
      expect(service.getFileType('.js')).toBe('code');
      expect(service.getFileType('.ts')).toBe('code');
      expect(service.getFileType('.tsx')).toBe('code');
      expect(service.getFileType('.json')).toBe('code');
      expect(service.getFileType('.md')).toBe('code');
    });

    it('should detect data files', () => {
      expect(service.getFileType('.csv')).toBe('data');
      expect(service.getFileType('.xlsx')).toBe('data');
    });

    it('should detect image files', () => {
      expect(service.getFileType('.png')).toBe('image');
      expect(service.getFileType('.jpg')).toBe('image');
      expect(service.getFileType('.svg')).toBe('image');
    });

    it('should detect document files', () => {
      expect(service.getFileType('.pdf')).toBe('document');
    });

    it('should return file for unknown extensions', () => {
      expect(service.getFileType('.xyz')).toBe('file');
      expect(service.getFileType('')).toBe('file');
    });
  });

  describe('Directory Listing', () => {
    beforeEach(() => {
      // Create test files and directories
      fs.mkdirSync(path.join(testDir, 'subdir'));
      fs.writeFileSync(path.join(testDir, 'test.txt'), 'hello');
      fs.writeFileSync(path.join(testDir, 'test.py'), 'print("hello")');
      fs.writeFileSync(path.join(testDir, '.hidden'), 'hidden file');
    });

    afterEach(() => {
      // Clean up test files
      fs.rmSync(path.join(testDir, 'subdir'), { recursive: true, force: true });
      fs.unlinkSync(path.join(testDir, 'test.txt'));
      fs.unlinkSync(path.join(testDir, 'test.py'));
      fs.unlinkSync(path.join(testDir, '.hidden'));
    });

    it('should list directory contents', async () => {
      const result = await service.listDirectory(testDir);
      expect(result.path).toBe(testDir);
      expect(result.items.length).toBeGreaterThan(0);
    });

    it('should skip hidden files', async () => {
      const result = await service.listDirectory(testDir);
      const hidden = result.items.find(i => i.name === '.hidden');
      expect(hidden).toBeUndefined();
    });

    it('should sort directories first', async () => {
      const result = await service.listDirectory(testDir);
      const firstDir = result.items.findIndex(i => i.isDirectory);
      const firstFile = result.items.findIndex(i => !i.isDirectory);
      if (firstDir !== -1 && firstFile !== -1) {
        expect(firstDir).toBeLessThan(firstFile);
      }
    });

    it('should include parent directory', async () => {
      const result = await service.listDirectory(testDir);
      expect(result.parent).toBe(path.dirname(testDir));
    });

    it('should reject on non-existent directory', async () => {
      await expect(service.listDirectory('/nonexistent/path')).rejects.toThrow();
    });

    it('should reject on file path', async () => {
      await expect(service.listDirectory(path.join(testDir, 'test.txt'))).rejects.toThrow();
    });
  });

  describe('Directory Mtime', () => {
    it('should return mtime for directory', () => {
      const result = service.getDirectoryMtime(testDir);
      expect(result.path).toBe(testDir);
      expect(typeof result.mtime).toBe('number');
    });

    it('should throw on non-existent path', () => {
      expect(() => service.getDirectoryMtime('/nonexistent')).toThrow();
    });
  });

  describe('File Mtime', () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(testDir, 'mtime-test.txt'), 'test');
    });

    afterEach(() => {
      fs.unlinkSync(path.join(testDir, 'mtime-test.txt'));
    });

    it('should return mtime for file', async () => {
      const result = await service.getFileMtime(path.join(testDir, 'mtime-test.txt'));
      expect(typeof result.mtime).toBe('number');
    });

    it('should throw on non-existent file', async () => {
      await expect(service.getFileMtime('/nonexistent')).rejects.toThrow();
    });
  });

  describe('File Reading', () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(testDir, 'read-test.txt'), 'hello world');
      fs.writeFileSync(path.join(testDir, 'read-test.ipynb'), JSON.stringify({
        cells: [],
        metadata: { kernelspec: { name: 'python3' } },
        nbformat: 4,
        nbformat_minor: 5
      }));
    });

    afterEach(() => {
      fs.unlinkSync(path.join(testDir, 'read-test.txt'));
      fs.unlinkSync(path.join(testDir, 'read-test.ipynb'));
    });

    it('should read text files', async () => {
      const result = await service.readFile(path.join(testDir, 'read-test.txt'));
      expect(result.type).toBe('text');
      expect(result.content).toBe('hello world');
    });

    it('should read notebook files as JSON', async () => {
      const result = await service.readFile(path.join(testDir, 'read-test.ipynb'));
      expect(result.type).toBe('notebook');
      expect(typeof result.content).toBe('object');
    });

    it('should throw on non-existent file', async () => {
      await expect(service.readFile('/nonexistent')).rejects.toThrow();
    });

    it('should throw on directory', async () => {
      await expect(service.readFile(testDir)).rejects.toThrow();
    });
  });

  describe('File Writing', () => {
    afterEach(() => {
      try {
        fs.unlinkSync(path.join(testDir, 'write-test.txt'));
      } catch {}
      try {
        fs.unlinkSync(path.join(testDir, 'write-test.ipynb'));
      } catch {}
    });

    it('should write text files', () => {
      service.writeFile(path.join(testDir, 'write-test.txt'), 'new content');
      const content = fs.readFileSync(path.join(testDir, 'write-test.txt'), 'utf-8');
      expect(content).toBe('new content');
    });

    it('should write notebook files as JSON', () => {
      const notebook = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 };
      service.writeFile(path.join(testDir, 'write-test.ipynb'), notebook, 'notebook');
      const content = JSON.parse(fs.readFileSync(path.join(testDir, 'write-test.ipynb'), 'utf-8'));
      expect(content.nbformat).toBe(4);
    });

    it('should create parent directories if needed', () => {
      const nestedPath = path.join(testDir, 'new-dir', 'nested', 'file.txt');
      service.writeFile(nestedPath, 'content');
      expect(fs.existsSync(nestedPath)).toBe(true);
      fs.rmSync(path.join(testDir, 'new-dir'), { recursive: true });
    });
  });

  describe('File Creation', () => {
    afterEach(() => {
      try {
        fs.unlinkSync(path.join(testDir, 'new-file.txt'));
      } catch {}
      try {
        fs.rmSync(path.join(testDir, 'new-dir'), { recursive: true });
      } catch {}
      try {
        fs.unlinkSync(path.join(testDir, 'new-notebook.ipynb'));
      } catch {}
    });

    it('should create empty text file', () => {
      const result = service.createFile(path.join(testDir, 'new-file.txt'));
      expect(fs.existsSync(path.join(testDir, 'new-file.txt'))).toBe(true);
      expect(result.is_directory).toBe(false);
    });

    it('should create directory', () => {
      const result = service.createFile(path.join(testDir, 'new-dir'), true);
      expect(fs.statSync(path.join(testDir, 'new-dir')).isDirectory()).toBe(true);
      expect(result.is_directory).toBe(true);
    });

    it('should create empty notebook with default structure', () => {
      service.createFile(path.join(testDir, 'new-notebook.ipynb'));
      const content = JSON.parse(fs.readFileSync(path.join(testDir, 'new-notebook.ipynb'), 'utf-8'));
      expect(content.cells).toEqual([]);
      expect(content.nbformat).toBe(4);
    });

    it('should throw if file already exists', () => {
      fs.writeFileSync(path.join(testDir, 'new-file.txt'), '');
      expect(() => service.createFile(path.join(testDir, 'new-file.txt'))).toThrow();
    });
  });

  describe('File Deletion', () => {
    it('should delete files', () => {
      const filePath = path.join(testDir, 'to-delete.txt');
      fs.writeFileSync(filePath, 'delete me');
      service.deleteFile(filePath);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('should delete directories recursively', () => {
      const dirPath = path.join(testDir, 'to-delete-dir');
      fs.mkdirSync(dirPath);
      fs.writeFileSync(path.join(dirPath, 'file.txt'), 'content');
      service.deleteFile(dirPath);
      expect(fs.existsSync(dirPath)).toBe(false);
    });

    it('should throw on non-existent path', () => {
      expect(() => service.deleteFile('/nonexistent')).toThrow();
    });
  });

  describe('File Renaming', () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(testDir, 'rename-source.txt'), 'content');
    });

    afterEach(() => {
      try {
        fs.unlinkSync(path.join(testDir, 'rename-source.txt'));
      } catch {}
      try {
        fs.unlinkSync(path.join(testDir, 'rename-dest.txt'));
      } catch {}
    });

    it('should rename files', () => {
      service.renameFile(
        path.join(testDir, 'rename-source.txt'),
        path.join(testDir, 'rename-dest.txt')
      );
      expect(fs.existsSync(path.join(testDir, 'rename-source.txt'))).toBe(false);
      expect(fs.existsSync(path.join(testDir, 'rename-dest.txt'))).toBe(true);
    });

    it('should throw if source does not exist', () => {
      expect(() =>
        service.renameFile('/nonexistent', path.join(testDir, 'dest.txt'))
      ).toThrow();
    });

    it('should throw if destination exists', () => {
      fs.writeFileSync(path.join(testDir, 'rename-dest.txt'), 'existing');
      expect(() =>
        service.renameFile(
          path.join(testDir, 'rename-source.txt'),
          path.join(testDir, 'rename-dest.txt')
        )
      ).toThrow();
    });
  });

  describe('File Duplication', () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(testDir, 'dup-source.txt'), 'original');
    });

    afterEach(() => {
      try {
        fs.unlinkSync(path.join(testDir, 'dup-source.txt'));
      } catch {}
      try {
        fs.unlinkSync(path.join(testDir, 'dup-source_copy.txt'));
      } catch {}
      try {
        fs.unlinkSync(path.join(testDir, 'dup-source_copy_2.txt'));
      } catch {}
    });

    it('should duplicate files with _copy suffix', () => {
      const result = service.duplicateFile(path.join(testDir, 'dup-source.txt'));
      expect(result.name).toBe('dup-source_copy.txt');
      expect(fs.existsSync(path.join(testDir, 'dup-source_copy.txt'))).toBe(true);
      const content = fs.readFileSync(path.join(testDir, 'dup-source_copy.txt'), 'utf-8');
      expect(content).toBe('original');
    });

    it('should increment suffix if _copy exists', () => {
      fs.writeFileSync(path.join(testDir, 'dup-source_copy.txt'), 'copy1');
      const result = service.duplicateFile(path.join(testDir, 'dup-source.txt'));
      expect(result.name).toBe('dup-source_copy_2.txt');
    });

    it('should throw on non-existent file', () => {
      expect(() => service.duplicateFile('/nonexistent')).toThrow();
    });

    it('should duplicate directories recursively', () => {
      const result = service.duplicateFile(testDir);
      expect(result.isDirectory).toBe(true);
      expect(fs.existsSync(result.path)).toBe(true);
    });
  });

  describe('Notebook Cells Conversion', () => {
    const sampleNotebook = {
      cells: [
        {
          cell_type: 'code',
          source: ['print("hello")', '\n', 'print("world")'],
          metadata: { nebula_id: 'cell-1', scrolled: true },
          outputs: [
            { output_type: 'stream', name: 'stdout', text: ['hello\n', 'world\n'] }
          ],
          execution_count: 1
        },
        {
          cell_type: 'markdown',
          source: '# Header',
          metadata: {},
          outputs: []
        }
      ],
      metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
      nbformat: 4,
      nbformat_minor: 5
    };

    beforeEach(() => {
      fs.writeFileSync(
        path.join(testDir, 'cells-test.ipynb'),
        JSON.stringify(sampleNotebook)
      );
    });

    afterEach(() => {
      fs.unlinkSync(path.join(testDir, 'cells-test.ipynb'));
    });

    it('should convert notebook to internal cell format', async () => {
      const result = await service.getNotebookCells(path.join(testDir, 'cells-test.ipynb'));
      expect(result.cells.length).toBe(2);
      expect(result.kernelspec).toBe('python3');
      expect(result.metadata.kernelspec?.name).toBe('python3');

      // Check code cell
      const codeCell = result.cells[0];
      expect(codeCell.type).toBe('code');
      expect(codeCell.content).toBe('print("hello")\nprint("world")');
      expect(codeCell.id).toBe('cell-1');
      expect(codeCell.scrolled).toBe(true);
      expect(codeCell.outputs.length).toBe(1);
      expect(codeCell.outputs[0].type).toBe('stdout');
      expect(codeCell.outputs[0].content).toBe('hello\nworld\n');
      expect(codeCell.outputs[0].id).toBe('output-0-0');

      // Check markdown cell
      const mdCell = result.cells[1];
      expect(mdCell.type).toBe('markdown');
      expect(mdCell.content).toBe('# Header');
    });

    it('should throw on non-existent notebook', async () => {
      await expect(service.getNotebookCells('/nonexistent.ipynb')).rejects.toThrow();
    });

    it('preserves rich display outputs with MIME bundles', async () => {
      fs.writeFileSync(
        path.join(testDir, 'cells-test.ipynb'),
        JSON.stringify({
          cells: [
            {
              cell_type: 'code',
              source: ['fig'],
              metadata: { nebula_id: 'plotly-cell' },
              outputs: [
                {
                  output_type: 'display_data',
                  data: {
                    'application/vnd.plotly.v1+json': {
                      data: [{ x: [1, 2], y: [3, 4], type: 'scatter' }],
                      layout: { title: 'Demo' },
                    },
                    'text/plain': 'Figure({ ... })',
                  },
                  metadata: {},
                },
              ],
              execution_count: 1,
            },
          ],
          metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
          nbformat: 4,
          nbformat_minor: 5,
        })
      );

      const result = await service.getNotebookCells(path.join(testDir, 'cells-test.ipynb'));
      expect(result.cells[0].outputs).toHaveLength(1);
      expect(result.cells[0].outputs[0].type).toBe('display_data');
      expect(result.cells[0].outputs[0].preferredMimeType).toBe('application/vnd.plotly.v1+json');
      expect(result.cells[0].outputs[0].mimeBundle?.['application/vnd.plotly.v1+json']).toEqual({
        data: [{ x: [1, 2], y: [3, 4], type: 'scatter' }],
        layout: { title: 'Demo' },
      });
    });
  });

  describe('Notebook Cells Saving', () => {
    const cells = [
      {
        id: 'cell-1',
        type: 'code' as const,
        content: 'print("hello")',
        outputs: [{ id: 'out-1', type: 'stdout' as const, content: 'hello\n', timestamp: Date.now() }],
        isExecuting: false,
        executionCount: 1,
        scrolled: true
      },
      {
        id: 'cell-2',
        type: 'markdown' as const,
        content: '# Title',
        outputs: [],
        isExecuting: false,
        executionCount: null
      }
    ];

    afterEach(() => {
      try {
        fs.unlinkSync(path.join(testDir, 'save-cells.ipynb'));
      } catch {}
    });

    it('round-trips source collapse metadata (source_collapsed / source_height)', async () => {
      // Long code cells collapse to a fixed, adjustable height like outputs
      // do; the state belongs in the .ipynb so it survives reloads and is
      // legible to other tools.
      const file = path.join(testDir, 'save-cells.ipynb');
      await service.saveNotebookCells(file, [
        { ...cells[0], sourceCollapsed: true, sourceHeight: 240 },
        cells[1],
      ]);
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(saved.cells[0].metadata.source_collapsed).toBe(true);
      expect(saved.cells[0].metadata.source_height).toBe(240);
      // absent (never collapsed) stays absent — no metadata churn in diffs
      expect(saved.cells[1].metadata.source_collapsed).toBeUndefined();

      const loaded = await service.getNotebookCells(file);
      expect(loaded.cells[0].sourceCollapsed).toBe(true);
      expect(loaded.cells[0].sourceHeight).toBe(240);
      expect(loaded.cells[1].sourceCollapsed).toBeUndefined();
    });

    it('should save cells to notebook format', async () => {
      await service.saveNotebookCells(path.join(testDir, 'save-cells.ipynb'), cells, 'python3');
      const saved = JSON.parse(fs.readFileSync(path.join(testDir, 'save-cells.ipynb'), 'utf-8'));

      expect(saved.nbformat).toBe(4);
      expect(saved.cells.length).toBe(2);

      // Check code cell conversion
      const codeCell = saved.cells[0];
      expect(codeCell.cell_type).toBe('code');
      expect(codeCell.source).toEqual(['print("hello")']);
      expect(codeCell.id).toBe('cell-1');
      expect(codeCell.metadata.nebula_id).toBeUndefined();
      expect(codeCell.metadata.scrolled).toBe(true);
      expect(codeCell.execution_count).toBe(1);
      expect(codeCell.outputs[0].nebula_seq).toBeUndefined();

      // Check markdown cell
      const mdCell = saved.cells[1];
      expect(mdCell.id).toBe('cell-2');
      expect(mdCell.cell_type).toBe('markdown');
      expect(mdCell.source).toEqual(['# Title']);
    });

    it('should return mtime after save', async () => {
      const result = await service.saveNotebookCells(path.join(testDir, 'save-cells.ipynb'), cells);
      expect(result.success).toBe(true);
      expect(typeof result.mtime).toBe('number');
    });

    it('should preserve existing metadata', async () => {
      // Create notebook with existing metadata
      fs.writeFileSync(path.join(testDir, 'save-cells.ipynb'), JSON.stringify({
        cells: [],
        metadata: { custom: 'value', nebula: { agent_created: true } },
        nbformat: 4,
        nbformat_minor: 5
      }));

      await service.saveNotebookCells(path.join(testDir, 'save-cells.ipynb'), cells);
      const saved = JSON.parse(fs.readFileSync(path.join(testDir, 'save-cells.ipynb'), 'utf-8'));

      expect(saved.metadata.custom).toBe('value');
      expect(saved.metadata.nebula.agent_created).toBe(true);
    });

    it('should preserve top-level metadata when cell metadata appears first in the file', async () => {
      fs.writeFileSync(path.join(testDir, 'save-cells.ipynb'), JSON.stringify({
        cells: [
          {
            cell_type: 'code',
            source: ['print("old")'],
            metadata: { nebula_id: 'existing-cell' },
            outputs: [],
            execution_count: null,
          },
        ],
        metadata: { custom: 'value', nebula: { agent_permitted: true } },
        nbformat: 4,
        nbformat_minor: 5,
      }));

      await service.saveNotebookCells(path.join(testDir, 'save-cells.ipynb'), cells);
      const saved = JSON.parse(fs.readFileSync(path.join(testDir, 'save-cells.ipynb'), 'utf-8'));

      expect(saved.metadata.custom).toBe('value');
      expect(saved.metadata.nebula.agent_permitted).toBe(true);
    });

    it('should save output without nebula_seq', async () => {
      const seqCells = [
        {
          id: 'cell-1',
          type: 'code' as const,
          content: 'print("hello")',
          outputs: [{ id: 'out-1', type: 'stdout' as const, content: 'hello\n', timestamp: Date.now() }],
          isExecuting: false,
          executionCount: 1,
        },
      ];

      await service.saveNotebookCells(path.join(testDir, 'save-cells.ipynb'), seqCells, 'python3');
      const saved = JSON.parse(fs.readFileSync(path.join(testDir, 'save-cells.ipynb'), 'utf-8'));

      expect(saved.cells[0].outputs[0].nebula_seq).toBeUndefined();
    });

    it('round-trips MIME bundle outputs back to Jupyter display_data', async () => {
      const richCells = [
        {
          id: 'cell-1',
          type: 'code' as const,
          content: 'fig',
          outputs: [{
            id: 'out-1',
            type: 'display_data' as const,
            content: 'Figure({ ... })',
            timestamp: Date.now(),
            preferredMimeType: 'application/vnd.plotly.v1+json',
            mimeBundle: {
              'application/vnd.plotly.v1+json': {
                data: [{ x: [1], y: [2], type: 'bar' }],
                layout: { title: 'Round Trip' },
              },
              'text/plain': 'Figure({ ... })',
            },
            metadata: {},
          }],
          isExecuting: false,
          executionCount: 1,
        },
      ];

      await service.saveNotebookCells(path.join(testDir, 'save-cells.ipynb'), richCells, 'python3');
      const saved = JSON.parse(fs.readFileSync(path.join(testDir, 'save-cells.ipynb'), 'utf-8'));

      expect(saved.cells[0].outputs[0].output_type).toBe('display_data');
      expect(saved.cells[0].outputs[0].data['application/vnd.plotly.v1+json']).toEqual({
        data: [{ x: [1], y: [2], type: 'bar' }],
        layout: { title: 'Round Trip' },
      });
    });
  });

  describe('History Persistence', () => {
    const historyData = [
      { type: 'insertCell', index: 0, cell: { id: 'cell-1' } },
      { type: 'updateContent', cellId: 'cell-1', oldContent: '', newContent: 'code' }
    ];

    const getNotebookPath = () => path.join(testDir, 'history-test.ipynb');

    beforeEach(() => {
      fs.writeFileSync(getNotebookPath(), JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
    });

    afterEach(() => {
      try {
        fs.unlinkSync(getNotebookPath());
      } catch {}
      try {
        fs.rmSync(path.join(testDir, '.nebula'), { recursive: true });
      } catch {}
    });

    it('should save history to .nebula directory', async () => {
      await service.saveHistory(getNotebookPath(), historyData);
      const nebulaDir = path.join(testDir, '.nebula');
      expect(fs.existsSync(nebulaDir)).toBe(true);
      expect(fs.existsSync(path.join(nebulaDir, 'history-test.history.json'))).toBe(true);
    });

    it('should load saved history', async () => {
      await service.saveHistory(getNotebookPath(), historyData);
      const loaded = await service.loadHistory(getNotebookPath());
      expect(loaded).toEqual(historyData);
    });

    it('should return empty array if no history', async () => {
      const loaded = await service.loadHistory(getNotebookPath());
      expect(loaded).toEqual([]);
    });

    it('should check if history exists', async () => {
      expect(service.hasHistory(getNotebookPath())).toBe(false);
      await service.saveHistory(getNotebookPath(), historyData);
      expect(service.hasHistory(getNotebookPath())).toBe(true);
    });
  });

  describe('Session Persistence', () => {
    const sessionData = { kernelSessionId: 'abc-123', lastOpened: Date.now() };
    const getNotebookPath = () => path.join(testDir, 'session-test.ipynb');

    beforeEach(() => {
      fs.writeFileSync(getNotebookPath(), JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
    });

    afterEach(() => {
      try {
        fs.unlinkSync(getNotebookPath());
      } catch {}
      try {
        fs.rmSync(path.join(testDir, '.nebula'), { recursive: true });
      } catch {}
    });

    it('should save and load session', async () => {
      await service.saveSession(getNotebookPath(), sessionData);
      const loaded = service.loadSession(getNotebookPath());
      expect(loaded).toEqual(sessionData);
    });

    it('should return empty object if no session', () => {
      const loaded = service.loadSession(getNotebookPath());
      expect(loaded).toEqual({});
    });
  });

  describe('Notebook Metadata', () => {
    const getNotebookPath = () => path.join(testDir, 'metadata-test.ipynb');

    beforeEach(() => {
      fs.writeFileSync(getNotebookPath(), JSON.stringify({
        cells: [],
        metadata: { kernelspec: { name: 'python3' } },
        nbformat: 4,
        nbformat_minor: 5
      }));
    });

    afterEach(() => {
      fs.unlinkSync(getNotebookPath());
    });

    it('should get notebook metadata', () => {
      const metadata = service.getNotebookMetadata(getNotebookPath()) as any;
      expect(metadata.kernelspec.name).toBe('python3');
    });

    it('should update notebook metadata', async () => {
      const result = await service.updateNotebookMetadata(getNotebookPath(), {
        nebula: { agent_permitted: true }
      });
      expect(result.success).toBe(true);
      expect(result.changed).toBe(true);
      expect(typeof result.mtime).toBe('number');

      const metadata = service.getNotebookMetadata(getNotebookPath()) as any;
      expect(metadata.nebula.agent_permitted).toBe(true);
      expect(metadata.kernelspec.name).toBe('python3'); // preserved
    });

    it('should not rewrite notebook metadata when updates are a no-op', async () => {
      const beforeMtime = fs.statSync(getNotebookPath()).mtimeMs / 1000;

      const result = await service.updateNotebookMetadata(getNotebookPath(), {
        kernelspec: { name: 'python3' }
      });

      const afterMtime = fs.statSync(getNotebookPath()).mtimeMs / 1000;
      expect(result.success).toBe(true);
      expect(result.changed).toBe(false);
      expect(result.mtime).toBe(beforeMtime);
      expect(afterMtime).toBe(beforeMtime);
    });

    it('should return empty object for non-existent notebook', () => {
      const metadata = service.getNotebookMetadata('/nonexistent.ipynb');
      expect(metadata).toEqual({});
    });

    it('should derive agent permission status from notebook metadata', async () => {
      await service.updateNotebookMetadata(getNotebookPath(), {
        nebula: { agent_permitted: true },
      });

      const status = service.getAgentPermissionStatus(getNotebookPath());
      expect(status.agent_created).toBe(false);
      expect(status.agent_permitted).toBe(true);
      expect(status.has_history).toBe(false);
      expect(status.can_agent_modify).toBe(false);
      expect(status.reason).toBe('User permitted but history not enabled');
    });

    it('should initialize history when granting agent permission', async () => {
      const result = await service.setAgentPermission(getNotebookPath(), true);

      expect(result.success).toBe(true);
      expect(result.status?.agent_permitted).toBe(true);
      expect(result.status?.has_history).toBe(true);
      expect(result.status?.can_agent_modify).toBe(true);

      const history = await service.loadHistory(getNotebookPath()) as any[];
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('snapshot');
    });
  });

  describe('Agent Permission', () => {
    const getNotebookPath = () => path.join(testDir, 'agent-test.ipynb');

    afterEach(() => {
      try {
        fs.unlinkSync(getNotebookPath());
      } catch {}
      try {
        fs.rmSync(path.join(testDir, '.nebula'), { recursive: true });
      } catch {}
    });

    it('should detect agent-created notebooks', () => {
      fs.writeFileSync(getNotebookPath(), JSON.stringify({
        cells: [],
        metadata: { nebula: { agent_created: true } },
        nbformat: 4,
        nbformat_minor: 5
      }));
      expect(service.isAgentPermitted(getNotebookPath())).toBe(true);
    });

    it('should let an explicit revoke lock out an agent-created notebook', () => {
      // agent-created but the user explicitly revoked (agent_permitted === false)
      fs.writeFileSync(getNotebookPath(), JSON.stringify({
        cells: [],
        metadata: { nebula: { agent_created: true, agent_permitted: false } },
        nbformat: 4,
        nbformat_minor: 5
      }));
      const status = service.getAgentPermissionStatus(getNotebookPath());
      expect(status.agent_created).toBe(true);
      expect(status.can_agent_modify).toBe(false);
      expect(status.reason).toBe('Agent access revoked');
      expect(service.isAgentPermitted(getNotebookPath())).toBe(false);
    });

    it('should detect user-permitted notebooks', () => {
      fs.writeFileSync(getNotebookPath(), JSON.stringify({
        cells: [],
        metadata: { nebula: { agent_permitted: true } },
        nbformat: 4,
        nbformat_minor: 5
      }));
      expect(service.isAgentPermitted(getNotebookPath())).toBe(true);
    });

    it('should return false for non-permitted notebooks', () => {
      fs.writeFileSync(getNotebookPath(), JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5
      }));
      expect(service.isAgentPermitted(getNotebookPath())).toBe(false);
    });
  });

  describe('Notebook Metadata File Handling', () => {
    const getNotebookPath = () => path.join(testDir, 'metadata-files.ipynb');
    const historyData = [{ type: 'test' }];
    const sessionData = { kernel: 'test' };

    beforeEach(async () => {
      fs.writeFileSync(getNotebookPath(), JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
      await service.saveHistory(getNotebookPath(), historyData);
      await service.saveSession(getNotebookPath(), sessionData);
    });

    afterEach(() => {
      try {
        fs.unlinkSync(getNotebookPath());
      } catch {}
      try {
        fs.rmSync(path.join(testDir, '.nebula'), { recursive: true });
      } catch {}
    });

    it('should delete history and session when deleting notebook', () => {
      service.deleteFile(getNotebookPath());
      const historyPath = path.join(testDir, '.nebula', 'metadata-files.history.json');
      const sessionPath = path.join(testDir, '.nebula', 'metadata-files.session.json');
      expect(fs.existsSync(historyPath)).toBe(false);
      expect(fs.existsSync(sessionPath)).toBe(false);
    });

    it('should rename history and session when renaming notebook', () => {
      const newPath = path.join(testDir, 'renamed.ipynb');
      service.renameFile(getNotebookPath(), newPath);

      const oldHistoryPath = path.join(testDir, '.nebula', 'metadata-files.history.json');
      const newHistoryPath = path.join(testDir, '.nebula', 'renamed.history.json');
      expect(fs.existsSync(oldHistoryPath)).toBe(false);
      expect(fs.existsSync(newHistoryPath)).toBe(true);

      // Clean up
      fs.unlinkSync(newPath);
    });

    it('should duplicate history and session when duplicating notebook', () => {
      const result = service.duplicateFile(getNotebookPath());
      const copyHistoryPath = path.join(testDir, '.nebula', 'metadata-files_copy.history.json');
      expect(fs.existsSync(copyHistoryPath)).toBe(true);

      // Clean up
      fs.unlinkSync(path.join(testDir, result.name));
    });
  });
});
