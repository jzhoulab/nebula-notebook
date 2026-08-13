/**
 * Tests for conflictService
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the fileService
vi.mock('../fileService', () => ({
  getFileMtime: vi.fn(),
  getFileContentWithMtime: vi.fn(),
  saveFileContentWithMtime: vi.fn()
}));

import {
  checkForConflict,
  saveWithConflictCheck,
  forceSaveLocal,
  loadRemoteVersion
} from '../conflictService';
import {
  getFileMtime,
  getFileContentWithMtime,
  saveFileContentWithMtime
} from '../fileService';

const mockGetFileMtime = vi.mocked(getFileMtime);
const mockGetFileContentWithMtime = vi.mocked(getFileContentWithMtime);
const mockSaveFileContentWithMtime = vi.mocked(saveFileContentWithMtime);

describe('conflictService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkForConflict', () => {
    it('should return no conflict when lastKnownMtime is null', async () => {
      const result = await checkForConflict('/path/to/file.ipynb', null);

      expect(result.hasConflict).toBe(false);
      expect(result.remoteMtime).toBeNull();
      expect(mockGetFileMtime).not.toHaveBeenCalled();
    });

    it('should return no conflict when remote mtime equals local mtime', async () => {
      mockGetFileMtime.mockResolvedValue({ path: '/path/to/file.ipynb', mtime: 1000 });

      const result = await checkForConflict('/path/to/file.ipynb', 1000);

      expect(result.hasConflict).toBe(false);
      expect(result.remoteMtime).toBe(1000);
    });

    it('should return no conflict when remote mtime is older than local', async () => {
      mockGetFileMtime.mockResolvedValue({ path: '/path/to/file.ipynb', mtime: 900 });

      const result = await checkForConflict('/path/to/file.ipynb', 1000);

      expect(result.hasConflict).toBe(false);
      expect(result.remoteMtime).toBe(900);
    });

    it('should detect conflict when remote mtime is significantly newer', async () => {
      mockGetFileMtime.mockResolvedValue({ path: '/path/to/file.ipynb', mtime: 2000 });

      const result = await checkForConflict('/path/to/file.ipynb', 1000);

      expect(result.hasConflict).toBe(true);
      expect(result.remoteMtime).toBe(2000);
    });

    it('should NOT detect conflict for small mtime differences (within tolerance)', async () => {
      // Small differences can occur due to floating-point precision or filesystem timing
      // These should NOT trigger a false positive conflict
      mockGetFileMtime.mockResolvedValue({ path: '/path/to/file.ipynb', mtime: 1000.3 });

      const result = await checkForConflict('/path/to/file.ipynb', 1000);

      expect(result.hasConflict).toBe(false);
      expect(result.remoteMtime).toBe(1000.3);
    });

    it('should handle network errors gracefully', async () => {
      mockGetFileMtime.mockRejectedValue(new Error('Network error'));

      const result = await checkForConflict('/path/to/file.ipynb', 1000);

      expect(result.hasConflict).toBe(false);
      expect(result.remoteMtime).toBeNull();
      expect(result.error).toBe('Network error');
    });

    it('should detect conflict at exact tolerance boundary (0.5s)', async () => {
      // Exactly at tolerance boundary (0.5s) should NOT be a conflict
      mockGetFileMtime.mockResolvedValue({ path: '/path/to/file.ipynb', mtime: 1000.5 });

      const result = await checkForConflict('/path/to/file.ipynb', 1000);

      expect(result.hasConflict).toBe(false);
      expect(result.remoteMtime).toBe(1000.5);
    });

    it('should detect conflict just above tolerance boundary', async () => {
      // Just over tolerance (0.51s) SHOULD be a conflict
      mockGetFileMtime.mockResolvedValue({ path: '/path/to/file.ipynb', mtime: 1000.51 });

      const result = await checkForConflict('/path/to/file.ipynb', 1000);

      expect(result.hasConflict).toBe(true);
      expect(result.remoteMtime).toBe(1000.51);
    });

    it('should handle non-Error thrown values', async () => {
      mockGetFileMtime.mockRejectedValue('string error');

      const result = await checkForConflict('/path/to/file.ipynb', 1000);

      expect(result.hasConflict).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });

  describe('saveWithConflictCheck', () => {
    const mockCells = [
      { id: '1', type: 'code' as const, content: 'print(1)', outputs: [], isExecuting: false }
    ];

    it('should save successfully when no conflict exists', async () => {
      mockGetFileMtime.mockResolvedValue({ path: '/path/to/file.ipynb', mtime: 1000 });
      mockSaveFileContentWithMtime.mockResolvedValue({ success: true, mtime: 1001 });

      const result = await saveWithConflictCheck(
        '/path/to/file.ipynb',
        mockCells,
        1000,
        'python3'
      );

      expect(result.success).toBe(true);
      expect(result.newMtime).toBe(1001);
      expect(result.conflict).toBeUndefined();
    });

    it('should return conflict info when remote is newer', async () => {
      mockGetFileMtime.mockResolvedValue({ path: '/path/to/file.ipynb', mtime: 2000 });

      const result = await saveWithConflictCheck(
        '/path/to/file.ipynb',
        mockCells,
        1000,
        'python3'
      );

      expect(result.success).toBe(false);
      expect(result.newMtime).toBeNull();
      expect(result.conflict).toEqual({ remoteMtime: 2000 });
      // Should not attempt to save when conflict detected
      expect(mockSaveFileContentWithMtime).not.toHaveBeenCalled();
    });

    it('should save when lastKnownMtime is null (new file)', async () => {
      mockSaveFileContentWithMtime.mockResolvedValue({ success: true, mtime: 1000 });

      const result = await saveWithConflictCheck(
        '/path/to/file.ipynb',
        mockCells,
        null,
        'python3'
      );

      expect(result.success).toBe(true);
      expect(result.newMtime).toBe(1000);
      // Should not check for conflict when no baseline mtime
      expect(mockGetFileMtime).not.toHaveBeenCalled();
    });

    it('should handle save errors', async () => {
      mockGetFileMtime.mockResolvedValue({ path: '/path/to/file.ipynb', mtime: 1000 });
      mockSaveFileContentWithMtime.mockRejectedValue(new Error('Save failed'));

      const result = await saveWithConflictCheck(
        '/path/to/file.ipynb',
        mockCells,
        1000,
        'python3'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Save failed');
    });

    it('should handle null response from save', async () => {
      mockGetFileMtime.mockResolvedValue({ path: '/path/to/file.ipynb', mtime: 1000 });
      mockSaveFileContentWithMtime.mockResolvedValue(null);

      const result = await saveWithConflictCheck(
        '/path/to/file.ipynb',
        mockCells,
        1000,
        'python3'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Save returned no result');
    });

    it('should pass history to save function', async () => {
      mockGetFileMtime.mockResolvedValue({ path: '/path/to/file.ipynb', mtime: 1000 });
      mockSaveFileContentWithMtime.mockResolvedValue({ success: true, mtime: 1001 });

      const mockHistory = [{ type: 'insertCell', index: 0, cell: mockCells[0] }];

      await saveWithConflictCheck(
        '/path/to/file.ipynb',
        mockCells,
        1000,
        'python3',
        mockHistory
      );

      expect(mockSaveFileContentWithMtime).toHaveBeenCalledWith(
        '/path/to/file.ipynb',
        mockCells,
        'python3',
        mockHistory,
      );
    });
  });

  describe('forceSaveLocal', () => {
    const mockCells = [
      { id: '1', type: 'code' as const, content: 'print(1)', outputs: [], isExecuting: false }
    ];

    it('should save without checking for conflicts', async () => {
      mockSaveFileContentWithMtime.mockResolvedValue({ success: true, mtime: 3000 });

      const result = await forceSaveLocal('/path/to/file.ipynb', mockCells, 'python3');

      expect(result.success).toBe(true);
      expect(result.newMtime).toBe(3000);
      // Should NOT check mtime - force save ignores conflicts
      expect(mockGetFileMtime).not.toHaveBeenCalled();
    });

    it('should handle save errors', async () => {
      mockSaveFileContentWithMtime.mockRejectedValue(new Error('Disk full'));

      const result = await forceSaveLocal('/path/to/file.ipynb', mockCells, 'python3');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Disk full');
    });

    it('should handle null response from save', async () => {
      mockSaveFileContentWithMtime.mockResolvedValue(null);

      const result = await forceSaveLocal('/path/to/file.ipynb', mockCells, 'python3');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Save returned no result');
    });

    it('should pass history to save function', async () => {
      mockSaveFileContentWithMtime.mockResolvedValue({ success: true, mtime: 3000 });

      const mockHistory = [{ type: 'insertCell', index: 0, cell: mockCells[0] }];

      await forceSaveLocal('/path/to/file.ipynb', mockCells, 'python3', mockHistory);

      expect(mockSaveFileContentWithMtime).toHaveBeenCalledWith(
        '/path/to/file.ipynb',
        mockCells,
        'python3',
        mockHistory,
      );
    });
  });

  describe('loadRemoteVersion', () => {
    it('should load remote file content', async () => {
      const remoteCells = [
        { id: 'remote-1', type: 'code' as const, content: 'remote code', outputs: [], isExecuting: false }
      ];
      mockGetFileContentWithMtime.mockResolvedValue({
        path: '/path/to/file.ipynb',
        cells: remoteCells,
        mtime: 5000,
        kernelspec: 'python3',
        access: { read_only: false }
      });

      const result = await loadRemoteVersion('/path/to/file.ipynb');

      expect(result.success).toBe(true);
      expect(result.cells).toEqual(remoteCells);
      expect(result.mtime).toBe(5000);
    });

    it('should handle load errors', async () => {
      mockGetFileContentWithMtime.mockRejectedValue(new Error('File not found'));

      const result = await loadRemoteVersion('/path/to/file.ipynb');

      expect(result.success).toBe(false);
      expect(result.cells).toBeNull();
      expect(result.mtime).toBeNull();
      expect(result.error).toBe('File not found');
    });

    it('should handle null response', async () => {
      mockGetFileContentWithMtime.mockResolvedValue(null);

      const result = await loadRemoteVersion('/path/to/file.ipynb');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Load returned no result');
    });
  });
});
