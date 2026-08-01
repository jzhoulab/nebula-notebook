// @vitest-environment node
/**
 * Pty busy probe — real-pty integration tests.
 *
 * "Busy" must mean SOMETHING OWNS THE TTY FOREGROUND (an agent TUI, an ssh
 * hop, a command the user ran) — not "the shell has a child process". A login
 * shell sourcing its rc files (modules, conda init — seconds on GPFS) spawns
 * transient children from t=0 while keeping the tty foreground for itself, so
 * a child-scan probe reported every FRESHLY CREATED pty as busy and made the
 * launch guard adopt a nonexistent agent instead of typing the launch command
 * (lab report: "start a new agent only opens a terminal").
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { ptyManager } from '../terminal/pty-manager';

function childrenOf(pid: number): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-P', String(pid)], (err, stdout) => {
      resolve(err ? [] : stdout.trim().split('\n').filter(Boolean));
    });
  });
}

/** Poll until `ok(value)` or timeout; returns the last value either way. */
async function poll<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() - start > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * A stand-in "shell" that reproduces the rc-init process topology: spawn a
 * child (as profile scripts do), then exec into a clean interactive bash that
 * keeps the tty foreground. create() appends `-l`; the script ignores it.
 */
function makeFakeShell(withInitChild: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-ptybusy-'));
  const script = path.join(dir, 'fake-shell.sh');
  fs.writeFileSync(
    script,
    `#!/bin/bash\n${withInitChild ? 'sleep 15 &\n' : ''}exec /bin/bash --noprofile --norc -i\n`,
    { mode: 0o755 }
  );
  return script;
}

const spawned: string[] = [];
function createPty(id: string, shell: string) {
  const info = ptyManager.create({ id, shell, cwd: os.tmpdir() });
  spawned.push(info.id);
  return info;
}

afterEach(() => {
  for (const id of spawned.splice(0)) ptyManager.kill(id);
});

describe('ptyManager.isBusy', () => {
  it('rc-init children do NOT make a fresh pty busy — the foreground is still the shell', async () => {
    const info = createPty('busy-rc-init', makeFakeShell(true));
    // Premise: the init child really exists right now (this is exactly the
    // state a child-scan probe mis-reads as busy).
    const kids = await poll(() => childrenOf(info.pid), (k) => k.length > 0, 5000);
    expect(kids.length).toBeGreaterThan(0);
    // The probe must see through it: nothing owns the tty foreground but the
    // shell. Poll-until-false absorbs transient native-read hiccups WITHOUT
    // losing teeth — a child-based probe stays true for the child's lifetime
    // (15s > timeout), so it can never sneak past this assertion.
    const busy = await poll(() => ptyManager.isBusy(info.id), (b) => b === false, 3000);
    expect(busy).toBe(false);
  });

  it('a command given the tty foreground IS busy, and idle again after it exits', async () => {
    const info = createPty('busy-fg-cmd', makeFakeShell(false));
    expect(await poll(() => ptyManager.isBusy(info.id), (b) => b === false, 5000)).toBe(false);
    ptyManager.write(info.id, 'sleep 15\r');
    expect(await poll(() => ptyManager.isBusy(info.id), (b) => b === true, 5000)).toBe(true);
    ptyManager.write(info.id, '\x03'); // interrupt — back to the prompt
    expect(await poll(() => ptyManager.isBusy(info.id), (b) => b === false, 5000)).toBe(false);
  });

  it('claims nothing for an unknown pty', () => {
    expect(ptyManager.isBusy('no-such-pty')).toBe(null);
  });
});
