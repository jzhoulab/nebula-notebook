// @vitest-environment node
/**
 * Pushing an auth token to the user's machine over the reverse channel, so a
 * remote agent's `nebula` CLI authenticates with a real credential instead of
 * depending on WHERE its tunnel terminates (loopback piggyback). The token
 * travels on ssh's stdin — never in a command line (ps, shell history, the
 * terminal panel), never echoed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: spawnMock, execFile: vi.fn() }));

import { pushRemoteAgentToken, REMOTE_TOKEN_PATH } from '../terminal/remote-agent-identity';

interface FakeChild extends EventEmitter {
  stdin: { chunks: string[]; write: (s: string) => void; end: () => void; ended: boolean };
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function fakeChild(exitCode: number, stdout = ''): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = {
    chunks: [],
    ended: false,
    write(s: string) { this.chunks.push(s); },
    end() { this.ended = true; },
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setTimeout(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', exitCode);
  }, 0);
  return child;
}

describe('pushRemoteAgentToken', () => {
  beforeEach(() => spawnMock.mockReset());

  it('writes the token to ~/.nebula/token on the remote host with 0600 perms, via stdin', async () => {
    const child = fakeChild(0, 'NB_TOKEN_OK\n');
    spawnMock.mockReturnValue(child);

    const ok = await pushRemoteAgentToken(31703, 'jianzhou', 'eyJ.secret.jwt');
    expect(ok).toBe(true);

    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe('ssh');
    expect(args).toEqual(expect.arrayContaining(['-p', '31703', '-o', 'BatchMode=yes', '-o', 'ProxyCommand=none', 'jianzhou@localhost']));
    // The remote script creates the dir privately and writes atomically.
    const remoteScript = args[args.length - 1] as string;
    expect(remoteScript).toContain('umask 077');
    expect(remoteScript).toContain(REMOTE_TOKEN_PATH);
    expect(remoteScript).toContain('NB_TOKEN_OK');
    // Token goes over stdin only — never in argv.
    expect(args.join(' ')).not.toContain('eyJ.secret.jwt');
    expect(child.stdin.chunks.join('')).toBe('eyJ.secret.jwt');
    expect(child.stdin.ended).toBe(true);
  });

  it('reports failure when the remote host does not acknowledge', async () => {
    spawnMock.mockReturnValue(fakeChild(255, ''));
    expect(await pushRemoteAgentToken(31703, 'jianzhou', 'tok')).toBe(false);
  });

  it('refuses unsafe inputs without spawning anything', async () => {
    expect(await pushRemoteAgentToken(31703, 'bad user; rm -rf', 'tok')).toBe(false);
    expect(await pushRemoteAgentToken(80, 'jianzhou', 'tok')).toBe(false);
    expect(await pushRemoteAgentToken(31703, 'jianzhou', '')).toBe(false);
    expect(await pushRemoteAgentToken(31703, 'jianzhou', 'has\nnewline')).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
