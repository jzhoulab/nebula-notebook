// @vitest-environment node
/**
 * Remote-agent config — ONE per installation, owned by the server.
 *
 * How to reach the user's machine (reverse port, username on that machine,
 * its sshd port, jump host) describes the INSTALLATION, not a browser. While
 * it lived in browser localStorage, every new browser — or merely a second
 * origin, since localhost:3000 and localhost:8867 have separate storage —
 * started blank: it minted its own random port (orphaning the standing
 * tunnel) and re-prompted for setup that was already done and working.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RemoteAgentConfigStore } from '../terminal/remote-agent-config';

let file: string;
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-racfg-')), 'remote-agent.json');
});

describe('RemoteAgentConfigStore: port', () => {
  it('generates once and stays stable across instances (the installation port)', () => {
    const a = new RemoteAgentConfigStore(file);
    const port = a.ensurePort();
    expect(port).toBeGreaterThanOrEqual(20000);
    expect(port).toBeLessThan(60000);
    expect(a.ensurePort()).toBe(port);
    // A fresh instance (server restart) reads the same persisted value.
    expect(new RemoteAgentConfigStore(file).ensurePort()).toBe(port);
  });

  it('adopts a valid claim when nothing is stored — the first browser to sync keeps its tunnel', () => {
    const store = new RemoteAgentConfigStore(file);
    expect(store.ensurePort(46386)).toBe(46386);
    expect(new RemoteAgentConfigStore(file).ensurePort()).toBe(46386);
  });

  it('ignores a claim once a port is stored — later browsers converge, never fork', () => {
    const store = new RemoteAgentConfigStore(file);
    store.ensurePort(46386);
    expect(store.ensurePort(31703)).toBe(46386);
  });

  it('ignores invalid claims (out of range, non-integer) and generates instead', () => {
    for (const bad of [80, 70000, 1.5, NaN]) {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-racfg-')), 'p.json');
      const port = new RemoteAgentConfigStore(f).ensurePort(bad);
      expect(port).toBeGreaterThanOrEqual(20000);
      expect(port).toBeLessThan(60000);
    }
  });

  it('patch({port}) overrides explicitly and persists; invalid values are ignored', () => {
    const store = new RemoteAgentConfigStore(file);
    store.ensurePort(46386);
    expect(store.patch({ port: 31703 }).port).toBe(31703);
    expect(new RemoteAgentConfigStore(file).ensurePort()).toBe(31703);
    expect(store.patch({ port: 80 }).port).toBe(31703); // out of range — kept
  });
});

describe('RemoteAgentConfigStore: identity (so setup already done is never re-prompted)', () => {
  it('patch merges — later writes never clobber fields they omit', () => {
    const store = new RemoteAgentConfigStore(file);
    store.patch({ user: 'jianzhou', localSshPort: 2222 });
    store.patch({ jumpHost: 'randi' });
    const cfg = new RemoteAgentConfigStore(file).get();
    expect(cfg).toMatchObject({ user: 'jianzhou', localSshPort: 2222, jumpHost: 'randi' });
  });

  it('claim() fills only what is MISSING — a configured installation is never overwritten', () => {
    const store = new RemoteAgentConfigStore(file);
    store.patch({ user: 'jianzhou', localSshPort: 2222 });
    const cfg = store.claim({ port: 31703, user: 'someone-else', jumpHost: 'randi' });
    expect(cfg.user).toBe('jianzhou'); // stored truth wins
    expect(cfg.jumpHost).toBe('randi'); // was missing — adopted
    expect(cfg.port).toBe(31703);
  });

  it('ignores blank and out-of-range values instead of storing junk', () => {
    const store = new RemoteAgentConfigStore(file);
    store.patch({ user: '   ', jumpHost: '', localSshPort: 99999 });
    const cfg = store.get();
    expect(cfg.user).toBeUndefined();
    expect(cfg.jumpHost).toBeUndefined();
    expect(cfg.localSshPort).toBeUndefined();
  });

  it('clears a field when explicitly given null (erase, not merge)', () => {
    const store = new RemoteAgentConfigStore(file);
    store.patch({ jumpHost: 'randi' });
    expect(store.patch({ jumpHost: null }).jumpHost).toBeUndefined();
  });

  it('reads a legacy {port}-only file without losing the port', () => {
    fs.writeFileSync(file, JSON.stringify({ port: 31703 }));
    const cfg = new RemoteAgentConfigStore(file).get();
    expect(cfg.port).toBe(31703);
    expect(cfg.user).toBeUndefined();
  });
});
