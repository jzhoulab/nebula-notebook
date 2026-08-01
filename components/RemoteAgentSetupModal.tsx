/**
 * RemoteAgentSetupModal — configure "agent on your machine" mode.
 *
 * Lives with the agent terminal bar (its only entry points), NOT in the app
 * settings: the bar's "on: my machine" dropdown is the on/off switch, this
 * dialog is just the connection details for the reverse SSH channel.
 */

import React, { useEffect, useState } from 'react';
import { X, Laptop } from 'lucide-react';
import { ModalShell } from './ModalShell';
import { getSettings, saveSettings, ensureRemoteAgentPort, syncRemoteAgentConfig, pushRemoteAgentConfig, NebulaSettings } from '../services/settingsService';
import { getTerminalServerInfo, checkReverseTunnel } from '../services/terminalService';

interface Props {
  onClose: () => void;
}

/** Where a command must be run — the #1 source of confusion in this setup. */
const Where: React.FC<{ loc: 'local' | 'server' }> = ({ loc }) => (
  <span
    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[0.65rem] font-semibold align-middle mr-1 ${
      loc === 'local' ? 'bg-purple-100 text-purple-700' : 'bg-emerald-100 text-emerald-700'
    }`}
  >
    {loc === 'local' ? '💻 your machine' : '🖥 Nebula terminal (server)'}
  </span>
);

export const RemoteAgentSetupModal: React.FC<Props> = ({ onClose }) => {
  const [settings, setSettings] = useState<NebulaSettings>(() => {
    ensureRemoteAgentPort();
    return getSettings();
  });
  // The port is an INSTALLATION fact owned by the server — converge on it
  // (claiming our local one if the server has none yet) so the commands shown
  // here match what every other browser of this user will probe and use.
  useEffect(() => {
    void syncRemoteAgentConfig().then(() => setSettings(getSettings()));
  }, []);
  const [serverInfo, setServerInfo] = useState<{ hostname: string | null; port: number | null }>({ hostname: null, port: null });
  const [tunnel, setTunnel] = useState<{ up: boolean; ssh: boolean | null } | null>(null);
  const tunnelUp = tunnel === null ? null : (tunnel.up && tunnel.ssh !== false);
  const [copied, setCopied] = useState<string | null>(null);

  const persist = (next: Partial<NebulaSettings>) => {
    saveSettings(next);
    setSettings(getSettings());
    // Anything typed here describes the INSTALLATION (how to reach the user's
    // machine), so it belongs on the server: that is what lets a second
    // browser — or merely the second origin — inherit a finished setup
    // instead of showing this dialog again.
    void pushRemoteAgentConfig({
      user: next.remoteAgentUser,
      localSshPort: next.remoteAgentLocalSshPort,
      jumpHost: next.remoteAgentJumpHost,
      localUrl: next.remoteAgentLocalUrl,
      port: next.remoteAgentPort,
    });
  };

  useEffect(() => {
    getTerminalServerInfo().then(info => setServerInfo({ hostname: info.hostname, port: info.port })).catch(() => {});
  }, []);

  // Live tunnel status while the dialog is open — turns green the moment
  // the user's Burrow/ssh connects, so they know setup worked.
  useEffect(() => {
    if (!settings.remoteAgentPort) return;
    let stopped = false;
    const check = async () => {
      const status = await checkReverseTunnel(settings.remoteAgentPort!);
      if (!stopped) setTunnel(status);
    };
    check();
    const interval = setInterval(check, 4000);
    return () => { stopped = true; clearInterval(interval); };
  }, [settings.remoteAgentPort]);

  const localPort = (() => {
    try { return new URL(settings.remoteAgentLocalUrl || 'http://localhost:3000').port || '80'; } catch { return '3000'; }
  })();
  const jumpSsh = settings.remoteAgentJumpHost?.trim() ? ` -J ${settings.remoteAgentJumpHost.trim()}` : '';
  const jumpBurrow = settings.remoteAgentJumpHost?.trim() ? ` --jump ${settings.remoteAgentJumpHost.trim()}` : '';
  const host = serverInfo.hostname ?? '<server-host>';
  const port = serverInfo.port ?? 3000;
  const sshPort = settings.remoteAgentLocalSshPort ?? 22;
  const burrowCommand = `burrow add --name nebula-agent --host ${host}${jumpBurrow} --local ${localPort}:localhost:${port} --remote ${settings.remoteAgentPort}:localhost:${sshPort}`;
  const sshCommand = `ssh${jumpSsh} -L ${localPort}:localhost:${port} -R ${settings.remoteAgentPort}:localhost:${sshPort} ${host}`;
  const sshCopyIdCommand = `ssh-copy-id -o ProxyCommand=none -p ${settings.remoteAgentPort} ${settings.remoteAgentUser?.trim() || '<your-mac-user>'}@localhost`;
  // NEBULA-scoped name: a bare CLAUDE_CODE_OAUTH_TOKEN in ~/.zshenv would also
  // hijack the user's own interactive claude sessions (overriding their normal
  // Keychain login); the launch command maps _NEBULA to the real var, scoped to
  // Nebula-launched agents only.
  const tokenExportCommand = `echo 'export CLAUDE_CODE_OAUTH_TOKEN_NEBULA=PASTE-TOKEN-HERE' >> ~/.zshenv && chmod 600 ~/.zshenv`;

  const copy = async (text: string, which: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(c => (c === which ? null : c)), 1500);
    } catch { /* clipboard optional */ }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex z-50 overflow-y-auto p-4" onClick={onClose}>
      <ModalShell
        onClose={onClose}
        label="Agent on your machine — setup"
        className="bg-white rounded-lg shadow-xl max-w-xl w-full m-auto max-h-[85vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Laptop className="w-4 h-4 text-purple-600" />
            <h2 className="text-sm font-semibold text-slate-800">Agent on your machine</h2>
            {tunnelUp !== null && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${tunnelUp ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                {tunnelUp
                  ? '✓ tunnel connected'
                  : tunnel?.up && tunnel.ssh === false
                    ? 'tunnel up — Remote Login off?'
                    : 'tunnel not detected'}
              </span>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1 text-slate-400 hover:text-slate-600 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 text-sm">
          <p className="text-xs text-slate-500">
            The agent terminal hops back to your computer over your SSH tunnel — the agent uses
            your machine's memory and network, but lives in the Nebula page. Launch buttons switch
            automatically once the tunnel below is connected.
          </p>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="text-xs text-slate-500 mb-1">Username on your machine</p>
              <input
                type="text"
                value={settings.remoteAgentUser ?? ''}
                onChange={(e) => persist({ remoteAgentUser: e.target.value })}
                placeholder="e.g. jane"
                className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">SSH port on your machine</p>
              <input
                type="number"
                value={settings.remoteAgentLocalSshPort ?? 22}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  persist({ remoteAgentLocalSshPort: Number.isInteger(n) && n > 0 ? n : 22 });
                }}
                placeholder="22"
                className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
              <p className="text-[0.7rem] text-slate-400 mt-0.5">Default 22. Use 2222 if a policy blocks 22.</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">Nebula URL from your machine</p>
              <input
                type="text"
                value={settings.remoteAgentLocalUrl ?? 'http://localhost:3000'}
                onChange={(e) => persist({ remoteAgentLocalUrl: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">SSH jump host</p>
              <input
                type="text"
                value={settings.remoteAgentJumpHost ?? ''}
                onChange={(e) => persist({ remoteAgentJumpHost: e.target.value })}
                placeholder="the alias you normally ssh to"
                className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">Reverse port (random, yours)</p>
              <div className="flex items-center gap-1.5">
                <code className="px-2 py-1.5 text-sm bg-slate-50 border border-slate-300 rounded">{settings.remoteAgentPort}</code>
                <button
                  onClick={() => {
                    const p = 20000 + Math.floor(Math.random() * 40000);
                    // Server-side too: the override must reach every browser,
                    // or the others keep probing the old port forever.
                    void pushRemoteAgentConfig({ port: p }).then(() => setSettings(getSettings()));
                  }}
                  className="text-xs text-purple-600 hover:text-purple-800 underline decoration-dotted"
                  title="Pick a new random port (if this one collides with another user on the server)"
                >
                  regenerate
                </button>
              </div>
            </div>
          </div>

          {!settings.remoteAgentJumpHost?.trim() && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
              On clusters, <code className="font-medium">{host}</code> is usually NOT reachable directly from your
              machine (internal node; often firewalled even on VPN). If you normally connect via
              <code className="font-medium"> ssh &lt;alias&gt;</code> first, put that alias in the jump-host field —
              the commands below update automatically.
            </p>
          )}

          <div>
            <p className="text-xs text-slate-600 mb-1">
              <Where loc="local" /> <span className="font-medium">1.</span> Enable <span className="font-medium">Remote Login</span> (macOS: System Settings → Sharing).{' '}
              <span className="font-medium">2.</span> Connect the tunnel — with{' '}
              <a href="https://github.com/jzthree/Burrow" target="_blank" rel="noreferrer" className="text-purple-600 hover:text-purple-800 underline">Burrow</a>{' '}
              (recommended: supervised, auto-reconnects — add once, connect from the menu bar):
            </p>
            <div className="flex items-start gap-1.5">
              <code className="flex-1 px-2 py-1.5 text-xs bg-slate-800 text-slate-100 rounded break-all select-all">{burrowCommand}</code>
              <button
                onClick={() => copy(burrowCommand, 'burrow')}
                className="px-2 py-1.5 text-xs bg-slate-200 hover:bg-slate-300 rounded flex-shrink-0"
              >
                {copied === 'burrow' ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-2 mb-1"><Where loc="local" /> …or plain ssh (replaces your usual port-forward; dies with the shell):</p>
            <div className="flex items-start gap-1.5">
              <code className="flex-1 px-2 py-1.5 text-xs bg-slate-800 text-slate-100 rounded break-all select-all">{sshCommand}</code>
              <button
                onClick={() => copy(sshCommand, 'ssh')}
                className="px-2 py-1.5 text-xs bg-slate-200 hover:bg-slate-300 rounded flex-shrink-0"
              >
                {copied === 'ssh' ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="border-t border-slate-100 pt-2">
            <p className="text-xs text-slate-600 mb-1 font-medium">
              <span className="font-medium">3.</span> nebula CLI on your machine
            </p>
            <p className="text-xs text-slate-500 mb-1">
              <Where loc="local" /> The launched agent drives your notebook through the{' '}
              <code className="bg-slate-100 px-1 rounded">nebula</code> CLI. Any{' '}
              <span className="font-medium">Node.js ≥ 20</span> install is enough — the agent falls back to{' '}
              <code className="bg-slate-100 px-1 rounded">npx -p nebula-notebook-mcp nebula</code> when the CLI
              isn't on PATH. Install it once to skip the npx download on every call:
            </p>
            <div className="flex items-start gap-1.5">
              <code className="flex-1 px-2 py-1.5 text-xs bg-slate-800 text-slate-100 rounded break-all select-all">npm install -g nebula-notebook-mcp</code>
              <button
                onClick={() => copy('npm install -g nebula-notebook-mcp', 'nebulacli')}
                className="px-2 py-1.5 text-xs bg-slate-200 hover:bg-slate-300 rounded flex-shrink-0"
              >
                {copied === 'nebulacli' ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="border-t border-slate-100 pt-2">
            <p className="text-xs text-slate-600 mb-1 font-medium">
              <span className="font-medium">4.</span> Sign-in token — <span className="text-red-600">required for Claude Code</span>
            </p>
            <p className="text-xs text-slate-500 mb-1">
              <Where loc="local" /> Claude Code keeps its credentials in the macOS Keychain, which ssh
              sessions can't read — without this step, ssh-launched claude asks you to log in every
              time. Run <code className="bg-slate-100 px-1 rounded">claude setup-token</code> (browser
              approval, prints a token), then store the token where ssh shells find it — under the
              Nebula-scoped name, so your own <code className="bg-slate-100 px-1 rounded">claude</code>{' '}
              sessions keep using their normal login:
            </p>
            <div className="flex items-start gap-1.5">
              <code className="flex-1 px-2 py-1.5 text-xs bg-slate-800 text-slate-100 rounded break-all select-all">{tokenExportCommand}</code>
              <button
                onClick={() => copy(tokenExportCommand, 'token')}
                className="px-2 py-1.5 text-xs bg-slate-200 hover:bg-slate-300 rounded flex-shrink-0"
              >
                {copied === 'token' ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Verify with <code className="bg-slate-100 px-1 rounded">zsh -lic 'echo ${'{'}CLAUDE_CODE_OAUTH_TOKEN_NEBULA:+set{'}'}'</code>.
              {' '}Codex needs no token — its credentials are file-based (<code className="bg-slate-100 px-1 rounded">~/.codex</code>) and work over ssh.
              {' '}(Set the plain <code className="bg-slate-100 px-1 rounded">CLAUDE_CODE_OAUTH_TOKEN</code> earlier? It still works, but
              also overrides the login your own terminal sessions use — moving it to the _NEBULA name keeps them separate.)
            </p>
          </div>

          <div className="border-t border-slate-100 pt-2">
            <p className="text-xs text-slate-600 mb-1 font-medium">
              <span className="font-medium">5.</span> No password prompt — optional
            </p>
            <p className="text-xs text-slate-500 mb-1">
              <Where loc="server" /> Trust your cluster key so each launch skips the password:
            </p>
            <div className="flex items-start gap-1.5">
              <code className="flex-1 px-2 py-1.5 text-xs bg-slate-800 text-slate-100 rounded break-all select-all">{sshCopyIdCommand}</code>
              <button
                onClick={() => copy(sshCopyIdCommand, 'copyid')}
                className="px-2 py-1.5 text-xs bg-slate-200 hover:bg-slate-300 rounded flex-shrink-0"
              >
                {copied === 'copyid' ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
          </div>
        </div>

        <div className="flex justify-end px-4 py-3 border-t border-slate-200">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-purple-600 text-white rounded hover:bg-purple-700"
          >
            Done
          </button>
        </div>
      </ModalShell>
    </div>
  );
};
