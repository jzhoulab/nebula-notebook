/**
 * Browser side of the installation-wide reverse-channel port: the server owns
 * the value; browsers mirror it into settings. A browser holding a locally
 * generated port offers it as a claim so the first sync after upgrade keeps
 * the port the user's existing tunnel already forwards.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { syncRemoteAgentPort, setRemoteAgentPort, getSettings, saveSettings } from '../settingsService';

const fetchMock = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('syncRemoteAgentPort', () => {
  it('adopts the server port into settings (server wins over a divergent local value)', async () => {
    saveSettings({ remoteAgentPort: 31703 });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ port: 46386 }) });
    expect(await syncRemoteAgentPort()).toBe(46386);
    expect(getSettings().remoteAgentPort).toBe(46386);
  });

  it('offers the locally stored port as a claim', async () => {
    saveSettings({ remoteAgentPort: 46386 });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ port: 46386 }) });
    await syncRemoteAgentPort();
    expect(String(fetchMock.mock.calls[0][0])).toContain('claim=46386');
  });

  it('sends no claim when nothing is stored locally', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ port: 23456 }) });
    expect(await syncRemoteAgentPort()).toBe(23456);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('claim');
    expect(getSettings().remoteAgentPort).toBe(23456);
  });

  it('keeps the local value when the server is unreachable (offline fallback)', async () => {
    saveSettings({ remoteAgentPort: 46386 });
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await syncRemoteAgentPort()).toBe(46386);
    expect(getSettings().remoteAgentPort).toBe(46386);
  });
});

describe('setRemoteAgentPort', () => {
  it('saves locally and PUTs the override to the server', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ port: 25000 }) });
    await setRemoteAgentPort(25000);
    expect(getSettings().remoteAgentPort).toBe(25000);
    const put = fetchMock.mock.calls.find((c) => c[1]?.method === 'PUT');
    expect(put).toBeTruthy();
    expect(JSON.parse(put![1].body)).toEqual({ port: 25000 });
  });
});
