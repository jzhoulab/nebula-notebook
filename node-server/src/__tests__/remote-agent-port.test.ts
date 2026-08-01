// @vitest-environment node
/**
 * Remote-agent reverse-channel port — ONE per installation, owned by the server.
 *
 * The port names an installation fact (which loopback port on this server the
 * user's machine reverse-forwards its sshd to). When it lived only in browser
 * localStorage, every new browser profile minted a fresh random port and
 * silently orphaned the tunnel the user had configured for the old one (lab
 * report: standing Burrow tunnel on one port, panel probing another →
 * "tunnel not detected").
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RemoteAgentPortStore } from '../terminal/remote-agent-port';

let file: string;
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-raport-')), 'remote-agent.json');
});

describe('RemoteAgentPortStore', () => {
  it('generates once and stays stable across instances (the installation port)', () => {
    const a = new RemoteAgentPortStore(file);
    const port = a.ensure();
    expect(port).toBeGreaterThanOrEqual(20000);
    expect(port).toBeLessThan(60000);
    expect(a.ensure()).toBe(port);
    // A fresh instance (server restart) reads the same persisted value.
    expect(new RemoteAgentPortStore(file).ensure()).toBe(port);
  });

  it('adopts a valid claim when nothing is stored — the first browser to sync keeps its tunnel', () => {
    const store = new RemoteAgentPortStore(file);
    expect(store.ensure(46386)).toBe(46386);
    expect(new RemoteAgentPortStore(file).ensure()).toBe(46386);
  });

  it('ignores a claim once a port is stored — later browsers converge, never fork', () => {
    const store = new RemoteAgentPortStore(file);
    store.ensure(46386);
    expect(store.ensure(31703)).toBe(46386);
  });

  it('ignores invalid claims (out of range, non-integer) and generates instead', () => {
    for (const bad of [80, 70000, 1.5, NaN]) {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-raport-')), 'p.json');
      const port = new RemoteAgentPortStore(f).ensure(bad);
      expect(port).toBeGreaterThanOrEqual(20000);
      expect(port).toBeLessThan(60000);
    }
  });

  it('set() overrides explicitly and persists; invalid values throw', () => {
    const store = new RemoteAgentPortStore(file);
    store.ensure(46386);
    expect(store.set(31703)).toBe(31703);
    expect(new RemoteAgentPortStore(file).ensure()).toBe(31703);
    expect(() => store.set(80)).toThrow();
    expect(() => store.set(2.5)).toThrow();
  });
});
