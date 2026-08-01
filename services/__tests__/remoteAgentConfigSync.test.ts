/**
 * Browser side of the installation-wide remote-agent config: the server owns
 * it; browsers mirror it into settings. A browser holding locally generated
 * values offers them as claims, so the first sync after upgrade keeps the
 * port the user's existing tunnel already forwards.
 *
 * The payoff is `remoteAgentSetupComplete`: a second browser (or merely the
 * second origin — localhost:3000 and localhost:8867 have separate storage)
 * inherits the username instead of re-prompting for setup already done.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  syncRemoteAgentConfig, pushRemoteAgentConfig, remoteAgentSetupComplete,
  getSettings, saveSettings,
} from '../settingsService';

const fetchMock = vi.fn();
const okJson = (body: unknown) => ({ ok: true, json: async () => body });

beforeEach(() => {
  window.localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('syncRemoteAgentConfig', () => {
  it('adopts the server config into settings (server wins over divergent local values)', async () => {
    saveSettings({ remoteAgentPort: 31703, remoteAgentUser: 'stale' });
    fetchMock.mockResolvedValue(okJson({ port: 46386, user: 'jianzhou', localSshPort: 2222, jumpHost: 'randi' }));
    const cfg = await syncRemoteAgentConfig();
    expect(cfg?.port).toBe(46386);
    const s = getSettings();
    expect(s.remoteAgentPort).toBe(46386);
    expect(s.remoteAgentUser).toBe('jianzhou');
    expect(s.remoteAgentLocalSshPort).toBe(2222);
    expect(s.remoteAgentJumpHost).toBe('randi');
  });

  it('claims locally stored values so the first browser to sync keeps its working setup', async () => {
    saveSettings({ remoteAgentPort: 46386, remoteAgentUser: 'jianzhou', remoteAgentLocalSshPort: 2222 });
    fetchMock.mockResolvedValue(okJson({ port: 46386, user: 'jianzhou', localSshPort: 2222 }));
    await syncRemoteAgentConfig();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('claimPort=46386');
    expect(url).toContain('claimUser=jianzhou');
    expect(url).toContain('claimSshPort=2222');
  });

  it('sends no claims when nothing is stored locally', async () => {
    fetchMock.mockResolvedValue(okJson({ port: 23456 }));
    expect((await syncRemoteAgentConfig())?.port).toBe(23456);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('claim');
    expect(getSettings().remoteAgentPort).toBe(23456);
  });

  it('keeps local values when the server is unreachable (offline fallback)', async () => {
    saveSettings({ remoteAgentPort: 46386, remoteAgentUser: 'jianzhou' });
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await syncRemoteAgentConfig()).toBeNull();
    const s = getSettings();
    expect(s.remoteAgentPort).toBe(46386);
    expect(s.remoteAgentUser).toBe('jianzhou');
  });

  it('never erases a local username when the server has none', async () => {
    saveSettings({ remoteAgentUser: 'jianzhou' });
    fetchMock.mockResolvedValue(okJson({ port: 31703 }));
    await syncRemoteAgentConfig();
    expect(getSettings().remoteAgentUser).toBe('jianzhou');
  });
});

describe('remoteAgentSetupComplete', () => {
  it('is false with no username, true once one is known', () => {
    expect(remoteAgentSetupComplete()).toBe(false);
    saveSettings({ remoteAgentUser: '  ' });
    expect(remoteAgentSetupComplete()).toBe(false);
    saveSettings({ remoteAgentUser: 'jianzhou' });
    expect(remoteAgentSetupComplete()).toBe(true);
  });

  it('becomes true after syncing a username from the server — no re-prompt in a fresh browser', async () => {
    expect(remoteAgentSetupComplete()).toBe(false); // fresh browser: knows nothing
    fetchMock.mockResolvedValue(okJson({ port: 31703, user: 'jianzhou', localSshPort: 2222 }));
    await syncRemoteAgentConfig();
    expect(remoteAgentSetupComplete()).toBe(true);
  });
});

describe('pushRemoteAgentConfig', () => {
  it('saves locally and PUTs the override so every browser follows', async () => {
    fetchMock.mockResolvedValue(okJson({ port: 25000, user: 'jianzhou' }));
    await pushRemoteAgentConfig({ port: 25000, user: 'jianzhou' });
    const s = getSettings();
    expect(s.remoteAgentPort).toBe(25000);
    expect(s.remoteAgentUser).toBe('jianzhou');
    const put = fetchMock.mock.calls.find((c) => c[1]?.method === 'PUT');
    expect(put).toBeTruthy();
    expect(JSON.parse(put![1].body)).toMatchObject({ port: 25000, user: 'jianzhou' });
  });
});
