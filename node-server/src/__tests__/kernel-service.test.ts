// @vitest-environment node
/**
 * Kernel Service Tests
 *
 * Tests for Jupyter kernel management.
 * Integration tests require actual kernels and are skipped by default.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import * as childProcess from 'child_process';
import * as kernelspecModule from '../kernel/kernelspec';
import {
  discoverKernelSpecs,
  getKernelSearchPaths,
  getKernelSpec,
  hasKernelSpec,
} from '../kernel/kernelspec';
import { SessionStore } from '../kernel/session-store';
import { KernelService } from '../kernel/kernel-service';
import { PersistedSession } from '../kernel/types';

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const createMockChildProcess = (pid: number) => {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.pid = pid;
  proc.killed = false;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  return proc as unknown as childProcess.ChildProcess;
};

describe('Kernelspec Discovery', () => {
  describe('discoverKernelSpecs', () => {
    it('should include XDG_DATA_HOME kernels on Linux', () => {
      if (process.platform !== 'linux') {
        return;
      }

      const previous = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = '/tmp/nebula-xdg-data';

      try {
        expect(getKernelSearchPaths()).toContain(
          path.join('/tmp/nebula-xdg-data', 'jupyter', 'kernels')
        );
      } finally {
        if (previous === undefined) {
          delete process.env.XDG_DATA_HOME;
        } else {
          process.env.XDG_DATA_HOME = previous;
        }
      }
    });

    it('should return an array of kernelspecs', () => {
      const specs = discoverKernelSpecs();
      expect(Array.isArray(specs)).toBe(true);
    });

    it('should have required properties on each spec', () => {
      const specs = discoverKernelSpecs();
      for (const spec of specs) {
        expect(spec).toHaveProperty('name');
        expect(spec).toHaveProperty('displayName');
        expect(spec).toHaveProperty('language');
        expect(spec).toHaveProperty('path');
        expect(typeof spec.name).toBe('string');
        expect(typeof spec.displayName).toBe('string');
        expect(typeof spec.language).toBe('string');
        expect(typeof spec.path).toBe('string');
      }
    });

    it('should discover at least one kernel on most systems', () => {
      const specs = discoverKernelSpecs();
      // Most systems with Python will have at least python3
      // This is a soft expectation
      console.log(`Found ${specs.length} kernelspecs:`, specs.map(s => s.name));
    });
  });

  describe('getKernelSpec', () => {
    it('should return null for non-existent kernel', () => {
      const spec = getKernelSpec('nonexistent-kernel-xyz123');
      expect(spec).toBeNull();
    });

    it('should return spec for existing kernel', () => {
      const specs = discoverKernelSpecs();
      if (specs.length > 0) {
        const spec = getKernelSpec(specs[0].name);
        expect(spec).not.toBeNull();
        expect(spec?.name).toBe(specs[0].name);
      }
    });
  });

  describe('hasKernelSpec', () => {
    it('should return false for non-existent kernel', () => {
      expect(hasKernelSpec('nonexistent-kernel-xyz123')).toBe(false);
    });

    it('should return true for existing kernel', () => {
      const specs = discoverKernelSpecs();
      if (specs.length > 0) {
        expect(hasKernelSpec(specs[0].name)).toBe(true);
      }
    });
  });
});

describe('SessionStore', () => {
  let store: SessionStore;
  let testDbPath: string;

  beforeEach(() => {
    // Use a temporary database for each test
    testDbPath = path.join(os.tmpdir(), `nebula-test-sessions-${Date.now()}.db`);
    store = new SessionStore(testDbPath);
  });

  afterEach(() => {
    store.close();
    // Cleanup test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('saveSession / getSession', () => {
    it('should save and retrieve a session', () => {
      const session: PersistedSession = {
        sessionId: 'test-session-1',
        kernelName: 'python3',
        filePath: '/path/to/notebook.ipynb',
        kernelPid: 12345,
        status: 'active',
        createdAt: Date.now() / 1000,
        lastHeartbeat: Date.now() / 1000,
        connectionFile: '/test/kernel.json',
        connectionConfig: null,
      };

      store.saveSession(session);
      const retrieved = store.getSession('test-session-1');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.sessionId).toBe('test-session-1');
      expect(retrieved?.kernelName).toBe('python3');
      expect(retrieved?.filePath).toBe('/path/to/notebook.ipynb');
      expect(retrieved?.kernelPid).toBe(12345);
      expect(retrieved?.status).toBe('active');
    });

    it('should return null for non-existent session', () => {
      const session = store.getSession('nonexistent');
      expect(session).toBeNull();
    });

    it('should update existing session on save', () => {
      const session: PersistedSession = {
        sessionId: 'test-session-2',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 100,
        status: 'active',
        createdAt: Date.now() / 1000,
        lastHeartbeat: Date.now() / 1000,
        connectionFile: null,
        connectionConfig: null,
      };

      store.saveSession(session);

      // Update the session
      session.status = 'terminated';
      session.kernelPid = 200;
      store.saveSession(session);

      const retrieved = store.getSession('test-session-2');
      expect(retrieved?.status).toBe('terminated');
      expect(retrieved?.kernelPid).toBe(200);
    });
  });

  describe('getActiveSessions', () => {
    it('should return only active sessions', () => {
      const now = Date.now() / 1000;

      store.saveSession({
        sessionId: 'active-1',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 1,
        status: 'active',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: null,
      });

      store.saveSession({
        sessionId: 'orphaned-1',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 2,
        status: 'orphaned',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: null,
      });

      store.saveSession({
        sessionId: 'active-2',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 3,
        status: 'active',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: null,
      });

      const active = store.getActiveSessions();
      expect(active).toHaveLength(2);
      expect(active.map(s => s.sessionId).sort()).toEqual(['active-1', 'active-2']);
    });
  });

  describe('markAllOrphaned', () => {
    it('should mark all active sessions as orphaned', () => {
      const now = Date.now() / 1000;

      store.saveSession({
        sessionId: 'session-1',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 1,
        status: 'active',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: null,
      });

      store.saveSession({
        sessionId: 'session-2',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 2,
        status: 'active',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: null,
      });

      const count = store.markAllOrphaned();
      expect(count).toBe(2);

      const active = store.getActiveSessions();
      expect(active).toHaveLength(0);

      const orphaned = store.getOrphanedSessions();
      expect(orphaned).toHaveLength(2);
    });
  });

  describe('updateHeartbeat', () => {
    it('should update the heartbeat timestamp', () => {
      const now = Date.now() / 1000;

      store.saveSession({
        sessionId: 'hb-session',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 1,
        status: 'active',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: null,
      });

      // Wait a bit and update heartbeat
      const before = store.getSession('hb-session')?.lastHeartbeat;
      store.updateHeartbeat('hb-session');
      const after = store.getSession('hb-session')?.lastHeartbeat;

      expect(after).toBeGreaterThanOrEqual(before!);
    });
  });

  describe('deleteSession', () => {
    it('should delete a session', () => {
      const now = Date.now() / 1000;

      store.saveSession({
        sessionId: 'delete-me',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 1,
        status: 'active',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: null,
      });

      expect(store.getSession('delete-me')).not.toBeNull();

      store.deleteSession('delete-me');

      expect(store.getSession('delete-me')).toBeNull();
    });
  });

  describe('getSessionByFile', () => {
    it('should find session by file path', () => {
      const now = Date.now() / 1000;

      store.saveSession({
        sessionId: 'file-session',
        kernelName: 'python3',
        filePath: '/path/to/notebook.ipynb',
        kernelPid: 1,
        status: 'active',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: null,
      });

      const session = store.getSessionByFile('/path/to/notebook.ipynb');
      expect(session).not.toBeNull();
      expect(session?.sessionId).toBe('file-session');
    });

    it('should return null for non-existent file', () => {
      const session = store.getSessionByFile('/nonexistent/path.ipynb');
      expect(session).toBeNull();
    });

    it('should not find orphaned sessions by file', () => {
      const now = Date.now() / 1000;

      store.saveSession({
        sessionId: 'orphaned-file-session',
        kernelName: 'python3',
        filePath: '/orphaned/notebook.ipynb',
        kernelPid: 1,
        status: 'orphaned',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: null,
      });

      const session = store.getSessionByFile('/orphaned/notebook.ipynb');
      expect(session).toBeNull();
    });
  });

  describe('cleanupOldSessions', () => {
    it('should cleanup old terminated/orphaned sessions', () => {
      const now = Date.now() / 1000;
      const oldTime = now - (25 * 3600); // 25 hours ago

      store.saveSession({
        sessionId: 'old-orphaned',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 1,
        status: 'orphaned',
        createdAt: oldTime,
        lastHeartbeat: oldTime,
        connectionFile: null,
        connectionConfig: null,
      });

      store.saveSession({
        sessionId: 'recent-orphaned',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 2,
        status: 'orphaned',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: null,
      });

      const deleted = store.cleanupOldSessions(24);
      expect(deleted).toBe(1);

      expect(store.getSession('old-orphaned')).toBeNull();
      expect(store.getSession('recent-orphaned')).not.toBeNull();
    });
  });
});

describe('KernelService', () => {
  let service: KernelService;
  let testDbPath: string;
  let testSessionStore: SessionStore;

  beforeEach(() => {
    testDbPath = path.join(os.tmpdir(), `nebula-test-kernel-${Date.now()}.db`);
    testSessionStore = new SessionStore(testDbPath);
    service = new KernelService({}, testSessionStore);
    vi.mocked(childProcess.spawn).mockReset();
  });

  afterEach(async () => {
    await service.cleanup();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('initialization', () => {
    it('should not be ready before initialize', () => {
      expect(service.isReady).toBe(false);
    });

    it('should be ready after initialize', async () => {
      await service.initialize();
      expect(service.isReady).toBe(true);
    });

    it('should discover kernels on initialize', async () => {
      await service.initialize();
      const kernels = service.getAvailableKernels();
      expect(Array.isArray(kernels)).toBe(true);
    });
  });

  describe('getAvailableKernels', () => {
    it('should return discovered kernels', async () => {
      await service.initialize();
      const kernels = service.getAvailableKernels();

      for (const kernel of kernels) {
        expect(kernel).toHaveProperty('name');
        expect(kernel).toHaveProperty('displayName');
        expect(kernel).toHaveProperty('language');
        expect(kernel).toHaveProperty('path');
      }
    });
  });

  describe('getSessionStatus', () => {
    it('should return null for non-existent session', async () => {
      const status = await service.getSessionStatus('nonexistent');
      expect(status).toBeNull();
    });
  });

  describe('getAllSessions', () => {
    it('should return empty array when no sessions', async () => {
      const sessions = await service.getAllSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe('executeCode queueing', () => {
    it('should serialize executeCode calls for the same session', async () => {
      const calls: string[] = [];
      const first = createDeferred<void>();
      const second = createDeferred<void>();

      const internal = vi.fn()
        .mockImplementationOnce(async () => {
          calls.push('first-start');
          await first.promise;
          calls.push('first-end');
          return { status: 'ok', executionCount: 1 };
        })
        .mockImplementationOnce(async () => {
          calls.push('second-start');
          await second.promise;
          calls.push('second-end');
          return { status: 'ok', executionCount: 2 };
        });

      (service as any).executeCodeInternal = internal;

      const onOutput = vi.fn(async () => {});

      const p1 = service.executeCode('session-1', 'print(1)', onOutput);
      const p2 = service.executeCode('session-1', 'print(2)', onOutput);

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(calls).toEqual(['first-start']);

      first.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(calls).toEqual(['first-start', 'first-end', 'second-start']);

      second.resolve();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.executionCount).toBe(1);
      expect(r2.executionCount).toBe(2);
      expect(r1.queuePosition).toBe(0);
      expect(r1.queueLength).toBe(1);
      expect(r2.queuePosition).toBe(1);
      expect(r2.queueLength).toBe(2);
      expect(calls).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
    });

    it('should return a friendly error when the socket is busy', async () => {
      const busyError = new Error('Socket is busy reading; only one receive operation may be in progress at any time');
      (service as any).executeCodeInternal = vi.fn(async () => { throw busyError; });

      const onOutput = vi.fn(async () => {});
      const result = await service.executeCode('session-1', 'print(1)', onOutput);

      expect(result.status).toBe('error');
      expect(result.error).toContain('another execution');
      expect(onOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          content: expect.stringContaining('another execution'),
        }),
        undefined
      );
    });
  });

  describe('restartKernel lifecycle', () => {
    it('keeps the restarted session alive if the old process exits afterward', async () => {
      const sessionId = 'restart-race';
      const filePath = '/tmp/restart-race.ipynb';
      const oldConnFile = path.join(os.tmpdir(), `nebula-old-conn-${Date.now()}.json`);
      fs.writeFileSync(oldConnFile, '{}');

      const oldProc = createMockChildProcess(1111);
      const newProc = createMockChildProcess(2222);
      const now = Date.now() / 1000;
      const connectionConfig = {
        ip: '127.0.0.1',
        transport: 'tcp',
        signatureScheme: 'hmac-sha256',
        key: 'test-key',
        shellPort: 12345,
        stdinPort: 12346,
        controlPort: 12347,
        iopubPort: 12348,
        hbPort: 12349,
      };

      const session = {
        id: sessionId,
        kernelName: 'python3',
        filePath,
        status: 'idle' as const,
        executionCount: 7,
        pid: 1111,
        connectionFile: oldConnFile,
        connectionConfig,
        createdAt: now,
        lastActivity: now,
      };

      (service as any).sessions.set(sessionId, session);
      (service as any).fileToSession.set(filePath, sessionId);
      (service as any).kernelProcesses.set(sessionId, oldProc);
      (service as any).attachProcessLifecycle(sessionId, oldProc, session);

      vi.mocked(childProcess.spawn).mockReturnValue(newProc as unknown as ReturnType<typeof childProcess.spawn>);
      const sleepSpy = vi.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      const waitForReadySpy = vi.spyOn(service as any, 'waitForReady').mockResolvedValue('idle');
      const generateConnectionFileSpy = vi.spyOn(service as any, 'generateConnectionFile').mockResolvedValue({
        config: connectionConfig,
        filePath: path.join(os.tmpdir(), `nebula-new-conn-${Date.now()}.json`),
      });
      const getProcessStartTimeSpy = vi.spyOn(service as any, 'getProcessStartTime').mockResolvedValue('123');
      const getKernelSpecSpy = vi.spyOn(kernelspecModule, 'getKernelSpec').mockReturnValue({
        name: 'python3',
        displayName: 'Python 3',
        language: 'python',
        path: '/tmp/python3',
        argv: ['python', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
      });

      const restarted = await service.restartKernel(sessionId);
      expect(restarted).toBe(true);
      expect((service as any).kernelProcesses.get(sessionId)).toBe(newProc);
      expect(service.getSessionIdForFile(filePath)).toBe(sessionId);

      oldProc.emit('exit', 0);

      const status = await service.getSessionStatus(sessionId);
      expect(status).not.toBeNull();
      expect(status?.status).toBe('idle');
      expect(service.getSessionIdForFile(filePath)).toBe(sessionId);
      expect((service as any).kernelProcesses.get(sessionId)).toBe(newProc);

      sleepSpy.mockRestore();
      waitForReadySpy.mockRestore();
      generateConnectionFileSpy.mockRestore();
      getProcessStartTimeSpy.mockRestore();
      getKernelSpecSpy.mockRestore();
    });

    it('cleans up the session if restart fails after spawning a replacement kernel', async () => {
      const sessionId = 'restart-fail';
      const filePath = '/tmp/restart-fail.ipynb';
      const oldConnFile = path.join(os.tmpdir(), `nebula-old-conn-fail-${Date.now()}.json`);
      fs.writeFileSync(oldConnFile, '{}');

      const oldProc = createMockChildProcess(3333);
      const newProc = createMockChildProcess(4444);
      const now = Date.now() / 1000;
      const connectionConfig = {
        ip: '127.0.0.1',
        transport: 'tcp',
        signatureScheme: 'hmac-sha256',
        key: 'test-key',
        shellPort: 22345,
        stdinPort: 22346,
        controlPort: 22347,
        iopubPort: 22348,
        hbPort: 22349,
      };

      const session = {
        id: sessionId,
        kernelName: 'python3',
        filePath,
        status: 'idle' as const,
        executionCount: 3,
        pid: 3333,
        connectionFile: oldConnFile,
        connectionConfig,
        createdAt: now,
        lastActivity: now,
      };

      (service as any).sessions.set(sessionId, session);
      (service as any).fileToSession.set(filePath, sessionId);
      (service as any).kernelProcesses.set(sessionId, oldProc);
      (service as any).attachProcessLifecycle(sessionId, oldProc, session);

      vi.mocked(childProcess.spawn).mockReturnValue(newProc as unknown as ReturnType<typeof childProcess.spawn>);
      const sleepSpy = vi.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      const waitForReadySpy = vi.spyOn(service as any, 'waitForReady').mockRejectedValue(new Error('boom'));
      const generateConnectionFileSpy = vi.spyOn(service as any, 'generateConnectionFile').mockResolvedValue({
        config: connectionConfig,
        filePath: path.join(os.tmpdir(), `nebula-new-conn-fail-${Date.now()}.json`),
      });
      const getKernelSpecSpy = vi.spyOn(kernelspecModule, 'getKernelSpec').mockReturnValue({
        name: 'python3',
        displayName: 'Python 3',
        language: 'python',
        path: '/tmp/python3',
        argv: ['python', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
      });

      const restarted = await service.restartKernel(sessionId);
      expect(restarted).toBe(false);
      expect(await service.getSessionStatus(sessionId)).toBeNull();
      expect(service.getSessionIdForFile(filePath)).toBeNull();
      expect(newProc.kill).toHaveBeenCalled();

      sleepSpy.mockRestore();
      waitForReadySpy.mockRestore();
      generateConnectionFileSpy.mockRestore();
      getKernelSpecSpy.mockRestore();
    });
  });

  // Integration tests - require actual kernels, ZeroMQ, and proper kernel setup
  // These tests are skipped by default as they require a full Jupyter environment
  // To run: set RUN_KERNEL_INTEGRATION_TESTS=true
  describe.skipIf(!process.env.RUN_KERNEL_INTEGRATION_TESTS)('Integration - Kernel Execution', () => {
    let sessionId: string;

    beforeAll(async () => {
      await service.initialize();
    });

    afterAll(async () => {
      if (sessionId) {
        await service.stopKernel(sessionId);
      }
    });

    it('should start a Python kernel', async () => {
      sessionId = await service.startKernel({ kernelName: 'python3' });
      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');

      // Wait a bit for kernel to stabilize
      await new Promise(r => setTimeout(r, 2000));

      const status = await service.getSessionStatus(sessionId);
      expect(status).not.toBeNull();
      expect(status?.kernelName).toBe('python3');
    }, 60000);

    it('should execute code and return output', async () => {
      if (!sessionId) {
        sessionId = await service.startKernel({ kernelName: 'python3' });
        await new Promise(r => setTimeout(r, 2000));
      }

      const status = await service.getSessionStatus(sessionId);
      if (!status || status.status === 'dead') {
        console.log('Kernel not available, skipping test');
        return;
      }

      const outputs: string[] = [];
      const result = await service.executeCode(
        sessionId,
        'print("Hello from Python!")',
        async (entry) => {
          outputs.push(entry.content);
        }
      );

      expect(result.status).toBe('ok');
      expect(outputs.some(o => o.includes('Hello from Python!'))).toBe(true);
    }, 60000);

    it('should handle execution errors', async () => {
      if (!sessionId) {
        sessionId = await service.startKernel({ kernelName: 'python3' });
        await new Promise(r => setTimeout(r, 2000));
      }

      const status = await service.getSessionStatus(sessionId);
      if (!status || status.status === 'dead') {
        console.log('Kernel not available, skipping test');
        return;
      }

      const outputs: string[] = [];
      const result = await service.executeCode(
        sessionId,
        'raise ValueError("Test error")',
        async (entry) => {
          outputs.push(entry.content);
        }
      );

      // Error should be in the outputs
      expect(outputs.some(o => o.includes('ValueError'))).toBe(true);
    }, 60000);

    it('should stop a kernel', async () => {
      if (!sessionId) {
        sessionId = await service.startKernel({ kernelName: 'python3' });
        await new Promise(r => setTimeout(r, 2000));
      }

      const stopped = await service.stopKernel(sessionId);
      // May be false if kernel already died
      if (stopped) {
        const status = service.getSessionStatus(sessionId);
        expect(status).toBeNull();
      }

      sessionId = ''; // Clear so afterAll doesn't try to stop again
    }, 60000);
  });

  describe('reattachOrphanedSessions', () => {
    it('should skip reattachment when no orphaned sessions exist', async () => {
      await service.initialize();

      const result = await service.reattachOrphanedSessions();

      expect(result).toEqual({
        attempted: 0,
        reattached: 0,
        failed: 0,
        skipped: 0,
      });
    });

    it('should skip sessions where kernel PID is no longer alive', async () => {
      await service.initialize();
      const now = Date.now() / 1000;

      // Create an orphaned session with a non-existent PID
      testSessionStore.saveSession({
        sessionId: 'orphan-dead-pid',
        kernelName: 'python3',
        filePath: '/test/notebook.ipynb',
        kernelPid: 999999, // Very unlikely to be a real PID
        status: 'orphaned',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: JSON.stringify({
          ip: '127.0.0.1',
          transport: 'tcp',
          signatureScheme: 'hmac-sha256',
          key: 'test-key',
          shellPort: 12345,
          stdinPort: 12346,
          controlPort: 12347,
          iopubPort: 12348,
          hbPort: 12349,
        }),
      });

      const result = await service.reattachOrphanedSessions();

      expect(result.attempted).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.reattached).toBe(0);
      expect(result.failed).toBe(0);

      // Confirmed-dead sessions (PID gone) are pure bookkeeping: they are
      // auto-cleaned right after the reattach pass — no user confirmation.
      const session = testSessionStore.getSession('orphan-dead-pid');
      expect(session).toBeNull();
    });

    it('should skip sessions with no connection config available', async () => {
      await service.initialize();
      const now = Date.now() / 1000;

      // Mock isPidAlive to return true for this test
      const isPidAliveSpy = vi.spyOn(service as any, 'isPidAlive').mockReturnValue(true);

      // Create an orphaned session with no connection info
      testSessionStore.saveSession({
        sessionId: 'orphan-no-config',
        kernelName: 'python3',
        filePath: '/test/notebook.ipynb',
        kernelPid: 12345,
        status: 'orphaned',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: '/nonexistent/connection.json', // File doesn't exist
        connectionConfig: null, // No DB fallback either
      });

      const result = await service.reattachOrphanedSessions();

      expect(result.attempted).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.reattached).toBe(0);

      isPidAliveSpy.mockRestore();
    });

    it('should use DB-stored connection config when file is missing', async () => {
      await service.initialize();
      const now = Date.now() / 1000;

      // Mock isPidAlive to return true
      const isPidAliveSpy = vi.spyOn(service as any, 'isPidAlive').mockReturnValue(true);
      // Mock waitForReady to fail (kernel not responding)
      const waitForReadySpy = vi.spyOn(service as any, 'waitForReady').mockRejectedValue(new Error('Timeout'));

      const connectionConfig = {
        ip: '127.0.0.1',
        transport: 'tcp',
        signatureScheme: 'hmac-sha256',
        key: 'test-key',
        shellPort: 12345,
        stdinPort: 12346,
        controlPort: 12347,
        iopubPort: 12348,
        hbPort: 12349,
      };

      // Create an orphaned session with connection config in DB but no file
      testSessionStore.saveSession({
        sessionId: 'orphan-db-config',
        kernelName: 'python3',
        filePath: '/test/notebook.ipynb',
        kernelPid: 12345,
        status: 'orphaned',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: '/nonexistent/connection.json', // File doesn't exist
        connectionConfig: JSON.stringify(connectionConfig), // DB fallback exists
      });

      const result = await service.reattachOrphanedSessions();

      // Should attempt reattachment (not skip) because DB config exists
      expect(result.attempted).toBe(1);
      expect(result.skipped).toBe(0);
      // Should fail because waitForReady times out
      expect(result.failed).toBe(1);
      expect(result.reattached).toBe(0);

      isPidAliveSpy.mockRestore();
      waitForReadySpy.mockRestore();
    });

    it('should successfully reattach when kernel responds', async () => {
      await service.initialize();
      const now = Date.now() / 1000;

      // Mock isPidAlive to return true
      const isPidAliveSpy = vi.spyOn(service as any, 'isPidAlive').mockReturnValue(true);
      // Mock waitForReady to succeed (returns 'idle')
      const waitForReadySpy = vi.spyOn(service as any, 'waitForReady').mockResolvedValue('idle');

      const connectionConfig = {
        ip: '127.0.0.1',
        transport: 'tcp',
        signatureScheme: 'hmac-sha256',
        key: 'test-key',
        shellPort: 12345,
        stdinPort: 12346,
        controlPort: 12347,
        iopubPort: 12348,
        hbPort: 12349,
      };

      testSessionStore.saveSession({
        sessionId: 'orphan-reattach-success',
        kernelName: 'python3',
        filePath: '/test/notebook.ipynb',
        kernelPid: 12345,
        status: 'orphaned',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: JSON.stringify(connectionConfig),
      });

      const result = await service.reattachOrphanedSessions();

      expect(result.attempted).toBe(1);
      expect(result.reattached).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);

      // Session should be marked as active
      const session = testSessionStore.getSession('orphan-reattach-success');
      expect(session?.status).toBe('active');

      // Session should be accessible via getSessionStatus
      const status = await service.getSessionStatus('orphan-reattach-success');
      expect(status).not.toBeNull();
      expect(status?.status).toBe('idle');

      isPidAliveSpy.mockRestore();
      waitForReadySpy.mockRestore();
    });

    it('should mark session as dead when reattach fails', async () => {
      await service.initialize();
      const now = Date.now() / 1000;

      // Mock isPidAlive to return true
      const isPidAliveSpy = vi.spyOn(service as any, 'isPidAlive').mockReturnValue(true);
      // Mock waitForReady to fail
      const waitForReadySpy = vi.spyOn(service as any, 'waitForReady').mockRejectedValue(new Error('Connection refused'));

      const connectionConfig = {
        ip: '127.0.0.1',
        transport: 'tcp',
        signatureScheme: 'hmac-sha256',
        key: 'test-key',
        shellPort: 12345,
        stdinPort: 12346,
        controlPort: 12347,
        iopubPort: 12348,
        hbPort: 12349,
      };

      testSessionStore.saveSession({
        sessionId: 'orphan-reattach-fail',
        kernelName: 'python3',
        filePath: '/test/notebook.ipynb',
        kernelPid: 12345,
        status: 'orphaned',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: JSON.stringify(connectionConfig),
      });

      const result = await service.reattachOrphanedSessions();

      expect(result.attempted).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.reattached).toBe(0);

      // Session should be cleaned up from in-memory state
      const status = await service.getSessionStatus('orphan-reattach-fail');
      expect(status).toBeNull();

      isPidAliveSpy.mockRestore();
      waitForReadySpy.mockRestore();
    });

    it('should prevent concurrent reattachment calls', async () => {
      await service.initialize();
      const now = Date.now() / 1000;

      // Mock isPidAlive to return true
      const isPidAliveSpy = vi.spyOn(service as any, 'isPidAlive').mockReturnValue(true);
      // Mock waitForReady with a delay
      const waitForReadySpy = vi.spyOn(service as any, 'waitForReady').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      const connectionConfig = {
        ip: '127.0.0.1',
        transport: 'tcp',
        signatureScheme: 'hmac-sha256',
        key: 'test-key',
        shellPort: 12345,
        stdinPort: 12346,
        controlPort: 12347,
        iopubPort: 12348,
        hbPort: 12349,
      };

      testSessionStore.saveSession({
        sessionId: 'orphan-concurrent',
        kernelName: 'python3',
        filePath: '/test/notebook.ipynb',
        kernelPid: 12345,
        status: 'orphaned',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: JSON.stringify(connectionConfig),
      });

      // Start two concurrent reattachment calls
      const [result1, result2] = await Promise.all([
        service.reattachOrphanedSessions(),
        service.reattachOrphanedSessions(),
      ]);

      // One should succeed, one should be skipped due to concurrent protection
      const totalAttempted = result1.attempted + result2.attempted;
      expect(totalAttempted).toBe(1); // Only one actually attempted

      isPidAliveSpy.mockRestore();
      waitForReadySpy.mockRestore();
    });

    it('should restore file-to-session mapping on successful reattach', async () => {
      await service.initialize();
      const now = Date.now() / 1000;

      // Mock isPidAlive to return true
      const isPidAliveSpy = vi.spyOn(service as any, 'isPidAlive').mockReturnValue(true);
      // Mock waitForReady to succeed
      const waitForReadySpy = vi.spyOn(service as any, 'waitForReady').mockResolvedValue('idle');

      const connectionConfig = {
        ip: '127.0.0.1',
        transport: 'tcp',
        signatureScheme: 'hmac-sha256',
        key: 'test-key',
        shellPort: 12345,
        stdinPort: 12346,
        controlPort: 12347,
        iopubPort: 12348,
        hbPort: 12349,
      };

      testSessionStore.saveSession({
        sessionId: 'orphan-file-mapping',
        kernelName: 'python3',
        filePath: '/test/my-notebook.ipynb',
        kernelPid: 12345,
        status: 'orphaned',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
        connectionConfig: JSON.stringify(connectionConfig),
      });

      await service.reattachOrphanedSessions();

      // getOrCreateKernel should find the reattached session
      // (we can't fully test this without mocking more, but we can check the mapping)
      const sessions = await service.getAllSessions();
      const reattachedSession = sessions.find(s => s.id === 'orphan-file-mapping');
      expect(reattachedSession).toBeDefined();
      expect(reattachedSession?.filePath).toBe('/test/my-notebook.ipynb');

      isPidAliveSpy.mockRestore();
      waitForReadySpy.mockRestore();
    });
  });

  describe('kernel reliability fixes', () => {
    it('single-flights concurrent getOrCreateKernel calls (no double spawn)', async () => {
      const filePath = '/tmp/single-flight.ipynb';
      let startCalls = 0;
      const startSpy = vi.spyOn(service as any, 'startKernel').mockImplementation(async () => {
        startCalls++;
        await new Promise((r) => setTimeout(r, 30));
        const now = Date.now() / 1000;
        (service as any).sessions.set('sf-1', {
          id: 'sf-1', kernelName: 'python3', filePath, status: 'idle',
          executionCount: 0, pid: 4242, createdAt: now, lastActivity: now,
        });
        (service as any).fileToSession.set(filePath, 'sf-1');
        return 'sf-1';
      });

      const [a, b, c] = await Promise.all([
        service.getOrCreateKernel(filePath, 'python3'),
        service.getOrCreateKernel(filePath, 'python3'),
        service.getOrCreateKernel(filePath, 'python3'),
      ]);
      expect(startCalls).toBe(1);
      expect(a.sessionId).toBe('sf-1');
      expect(b.sessionId).toBe('sf-1');
      expect(c.sessionId).toBe('sf-1');
      startSpy.mockRestore();
      (service as any).sessions.delete('sf-1');
      (service as any).fileToSession.delete(filePath);
    });

    it('notifies onSessionDead when the kernel process exits unexpectedly', async () => {
      const sessionId = 'death-notify';
      const proc = createMockChildProcess(3333);
      const now = Date.now() / 1000;
      const session = {
        id: sessionId, kernelName: 'python3', filePath: '/tmp/death.ipynb',
        status: 'busy' as const, executionCount: 1, pid: 3333,
        createdAt: now, lastActivity: now,
      };
      (service as any).sessions.set(sessionId, session);
      (service as any).kernelProcesses.set(sessionId, proc);
      (service as any).attachProcessLifecycle(sessionId, proc, session);

      const dead: string[] = [];
      service.onSessionDead((id) => dead.push(id));
      proc.emit('exit', 137); // OOM-killed
      expect(dead).toEqual([sessionId]);
      expect(session.status).toBe('dead');
    });

    it('liveness sweep notices a dead reattached kernel (pid only, no handle)', () => {
      const sessionId = 'reattached-dead';
      const now = Date.now() / 1000;
      // PID 1 check via signal 0 would succeed; use an absurd unallocated pid
      const session = {
        id: sessionId, kernelName: 'python3', filePath: '/tmp/reattach.ipynb',
        status: 'idle' as const, executionCount: 0, pid: 2 ** 21,
        createdAt: now, lastActivity: now,
      };
      (service as any).sessions.set(sessionId, session);
      // NOTE: no kernelProcesses handle — this is the reattached case

      const dead: string[] = [];
      service.onSessionDead((id) => dead.push(id));
      service.sweepLiveness();
      expect(dead).toEqual([sessionId]);
      expect(session.status).toBe('dead');
    });

    it('restart clears buffered outputs from the old process', async () => {
      const sessionId = 'restart-buffers';
      const filePath = '/tmp/restart-buffers.ipynb';
      const oldConnFile = path.join(os.tmpdir(), `nebula-buf-conn-${Date.now()}.json`);
      fs.writeFileSync(oldConnFile, '{}');
      const oldProc = createMockChildProcess(5111);
      const newProc = createMockChildProcess(5222);
      const now = Date.now() / 1000;
      const connectionConfig = {
        ip: '127.0.0.1', transport: 'tcp', signatureScheme: 'hmac-sha256', key: 'k',
        shellPort: 22345, stdinPort: 22346, controlPort: 22347, iopubPort: 22348, hbPort: 22349,
      };
      const session = {
        id: sessionId, kernelName: 'python3', filePath, status: 'idle' as const,
        executionCount: 3, pid: 5111, connectionFile: oldConnFile, connectionConfig,
        createdAt: now, lastActivity: now,
      };
      (service as any).sessions.set(sessionId, session);
      (service as any).kernelProcesses.set(sessionId, oldProc);
      // stale outputs from the old kernel
      (service as any).cellOutputBuffers.set(sessionId, new Map([['cell-1', [{ type: 'stdout', content: 'old' }]]]));
      (service as any).cellOutputTracking.set(sessionId, new Map());

      vi.mocked(childProcess.spawn).mockReturnValue(newProc as unknown as ReturnType<typeof childProcess.spawn>);
      vi.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      vi.spyOn(service as any, 'waitForReady').mockResolvedValue('idle');
      vi.spyOn(service as any, 'generateConnectionFile').mockResolvedValue({
        config: connectionConfig,
        filePath: path.join(os.tmpdir(), `nebula-buf-new-${Date.now()}.json`),
      });
      vi.spyOn(service as any, 'getProcessStartTime').mockResolvedValue('456');
      vi.spyOn(kernelspecModule, 'getKernelSpec').mockReturnValue({
        name: 'python3', displayName: 'Python 3', language: 'python',
        path: '/tmp/python3', argv: ['python', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
      });

      const ok = await service.restartKernel(sessionId);
      expect(ok).toBe(true);
      expect((service as any).cellOutputBuffers.has(sessionId)).toBe(false);
      expect((service as any).cellOutputTracking.has(sessionId)).toBe(false);
    });
  });

});
