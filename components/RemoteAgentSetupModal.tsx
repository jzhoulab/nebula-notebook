/**
 * RemoteAgentSetupModal — configure "agent on your machine" mode.
 *
 * Lives with the agent terminal bar (its only entry points), NOT in the app
 * settings: the bar's "on: my machine" dropdown is the on/off switch, this
 * dialog is just the connection details for the reverse SSH channel.
 *
 * Shape of the page, in priority order (lab report: the old one was "a bit too
 * long, overwhelming" — five numbered steps and a five-field form, all open at
 * once, with no sense of what was already done):
 *   1. Hand the whole thing to an agent. Most people would rather paste one
 *      prompt than follow a page, and the agent is already on the machine that
 *      needs the work.
 *   2. Three steps, done by hand, each showing whether it is ALREADY DONE from
 *      what the server can observe — so the page shrinks as you progress.
 *   3. Everything else folded away until asked for.
 */

import React, { useEffect, useState } from 'react';
import { X, Laptop, Check, Circle, ChevronRight } from 'lucide-react';
import { ModalShell } from './ModalShell';
import {
  getSettings, saveSettings, ensureRemoteAgentPort, syncRemoteAgentConfig,
  pushRemoteAgentConfig, discoverRemoteAgentUser, NebulaSettings,
} from '../services/settingsService';
import { getTerminalServerInfo, checkReverseTunnel } from '../services/terminalService';
import { agentTerminalService } from '../services/agentTerminalService';

interface Props {
  onClose: () => void;
}

/** A step's heading: a tick when the server can see it is already done. */
const StepHead: React.FC<{ n: number; title: string; done: boolean; hint?: string }> = ({ n, title, done, hint }) => (
  <div className="flex items-center gap-1.5">
    {done
      ? <Check className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
      : <Circle className="w-3.5 h-3.5 text-slate-300 flex-shrink-0" />}
    <span className={`text-xs font-medium ${done ? 'text-green-700' : 'text-slate-700'}`}>
      {n}. {title}
    </span>
    {done && hint && <span className="text-[0.7rem] text-green-600">{hint}</span>}
  </div>
);

const CopyRow: React.FC<{ text: string; copied: boolean; onCopy: () => void }> = ({ text, copied, onCopy }) => (
  <div className="flex items-start gap-1.5 mt-1">
    <code className="flex-1 px-2 py-1.5 text-xs bg-slate-800 text-slate-100 rounded break-all select-all">{text}</code>
    <button onClick={onCopy} className="px-2 py-1.5 text-xs bg-slate-200 hover:bg-slate-300 rounded flex-shrink-0">
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  </div>
);

export const RemoteAgentSetupModal: React.FC<Props> = ({ onClose }) => {
  const [settings, setSettings] = useState<NebulaSettings>(() => {
    ensureRemoteAgentPort();
    return getSettings();
  });
  // The port and identity are INSTALLATION facts owned by the server —
  // converge before showing commands, so what's printed here matches what
  // every other browser of this user will probe and use.
  useEffect(() => {
    void syncRemoteAgentConfig().then(() => setSettings(getSettings()));
  }, []);
  const [serverInfo, setServerInfo] = useState<{ hostname: string | null; port: number | null }>({ hostname: null, port: null });
  const [tunnel, setTunnel] = useState<{ up: boolean; ssh: boolean | null } | null>(null);
  const tunnelUp = tunnel === null ? null : (tunnel.up && tunnel.ssh !== false);
  const [copied, setCopied] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);

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

  const host = serverInfo.hostname ?? '<server-host>';
  const burrowCommand = agentTerminalService.buildBurrowCommand(serverInfo.hostname, serverInfo.port);
  const sshCommand = agentTerminalService.buildTunnelCommand(serverInfo.hostname, serverInfo.port);
  const agentPrompt = agentTerminalService.buildRemoteSetupAgentPrompt(serverInfo.hostname, serverInfo.port);
  const sshCopyIdCommand = `ssh-copy-id -o ProxyCommand=none -p ${settings.remoteAgentPort} ${settings.remoteAgentUser?.trim() || '<your-mac-user>'}@localhost`;
  // NEBULA-scoped name: a bare CLAUDE_CODE_OAUTH_TOKEN in ~/.zshenv would also
  // hijack the user's own interactive claude sessions (overriding their normal
  // Keychain login); the launch command maps _NEBULA to the real var, scoped to
  // Nebula-launched agents only.
  const tokenExportCommand = `echo 'export CLAUDE_CODE_OAUTH_TOKEN_NEBULA=PASTE-TOKEN-HERE' >> ~/.zshenv && chmod 600 ~/.zshenv`;

  // What the server can actually observe about progress.
  const step1Done = tunnel?.up === true;                       // something forwards the port
  const step2Done = tunnelUp === true;                         // ...and sshd answered on it
  const knownUser = settings.remoteAgentUser?.trim() || '';
  const step3Done = !!knownUser;

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
            The agent runs on <span className="font-medium">your computer</span> — its memory, its network, its
            logins — while its terminal stays in this page. That needs an SSH tunnel from your machine
            to <code className="bg-slate-100 px-1 rounded">{host}</code> and back.
          </p>

          {/* The easy road, first: most people have an agent that can just do this. */}
          <div className="rounded border border-purple-200 bg-purple-50 px-3 py-2">
            <p className="text-xs font-medium text-purple-900">Easiest: let an agent do it</p>
            <p className="text-xs text-purple-800 mt-0.5">
              Paste this into Claude Code (or any agent) <span className="font-medium">running on your own
              machine</span>. It carries your real host and ports, sets up the tunnel, turns on Remote Login,
              installs the Nebula skill + MCP, and reports back your username.
            </p>
            <div className="flex items-center gap-2 mt-1.5">
              <button
                onClick={() => copy(agentPrompt, 'prompt')}
                className="px-2.5 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700 font-medium"
              >
                {copied === 'prompt' ? 'Copied ✓' : 'Copy setup prompt'}
              </button>
              <button
                onClick={() => setShowPrompt(v => !v)}
                className="text-xs text-purple-700 hover:text-purple-900 underline decoration-dotted"
              >
                {showPrompt ? 'hide' : 'preview'}
              </button>
            </div>
            {showPrompt && (
              <pre className="mt-2 p-2 text-[0.7rem] leading-relaxed bg-white border border-purple-200 rounded max-h-56 overflow-auto whitespace-pre-wrap text-slate-700">{agentPrompt}</pre>
            )}
          </div>

          <p className="text-xs text-slate-400 text-center">— or do it yourself, three steps —</p>

          <div>
            <StepHead n={1} title="Connect the tunnel" done={step1Done} hint="port is forwarded" />
            {!step1Done && (
              <>
                <p className="text-xs text-slate-500 mt-1">
                  On <span className="font-medium">your machine</span>. With{' '}
                  <a href="https://github.com/jzthree/Burrow" target="_blank" rel="noreferrer" className="text-purple-600 hover:text-purple-800 underline">Burrow</a>{' '}
                  it reconnects itself (add once, then connect from the menu bar):
                </p>
                <CopyRow text={burrowCommand} copied={copied === 'burrow'} onCopy={() => copy(burrowCommand, 'burrow')} />
                <p className="text-xs text-slate-400 mt-1.5">…or plain ssh, in a terminal you leave open:</p>
                <CopyRow text={sshCommand} copied={copied === 'ssh'} onCopy={() => copy(sshCommand, 'ssh')} />
                {!settings.remoteAgentJumpHost?.trim() && (
                  <p className="text-[0.7rem] text-amber-700 mt-1.5">
                    On clusters <code className="font-medium">{host}</code> is often not reachable directly. If you
                    normally <code className="font-medium">ssh &lt;alias&gt;</code> first, set that alias as the jump host
                    under Advanced — these commands update automatically.
                  </p>
                )}
              </>
            )}
          </div>

          <div>
            <StepHead n={2} title="Let the server back in" done={step2Done} hint="your machine answered" />
            {!step2Done && (
              <>
                <p className="text-xs text-slate-500 mt-1">
                  On <span className="font-medium">your machine</span>: turn on{' '}
                  <span className="font-medium">Remote Login</span> (System Settings → General → Sharing).
                  {tunnel?.up && tunnel.ssh === false && (
                    <span className="text-amber-700"> The tunnel is up but nothing answered SSH — this is the missing piece.</span>
                  )}
                </p>
                <p className="text-xs text-slate-400 mt-1.5">
                  Then, once per machine, on <span className="font-medium">the server</span> — so launches don't ask for a password:
                </p>
                <CopyRow text={sshCopyIdCommand} copied={copied === 'copyid'} onCopy={() => copy(sshCopyIdCommand, 'copyid')} />
              </>
            )}
          </div>

          <div>
            <StepHead n={3} title="Who you are on that machine" done={step3Done} hint={knownUser ? `found: ${knownUser}` : undefined} />
            {!step3Done && (
              <>
                <p className="text-xs text-slate-500 mt-1">
                  Nebula needs your login there to ssh back. It can ask your machine directly once
                  steps 1–2 are done — no typing.
                </p>
                <div className="flex items-center gap-2 mt-1.5">
                  <button
                    onClick={async () => {
                      setFinding(true); setFindError(null);
                      const { user, reason } = await discoverRemoteAgentUser();
                      setFinding(false);
                      setSettings(getSettings());
                      if (!user) setFindError(reason ?? 'no answer over the tunnel');
                    }}
                    disabled={finding}
                    className="px-2.5 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50 font-medium"
                  >
                    {finding ? 'Asking your machine…' : 'Find it for me'}
                  </button>
                  <input
                    type="text"
                    value={settings.remoteAgentUser ?? ''}
                    onChange={(e) => persist({ remoteAgentUser: e.target.value })}
                    placeholder="…or type it (e.g. jane)"
                    className="flex-1 px-2 py-1 text-xs border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>
                {findError && <p className="text-[0.7rem] text-amber-700 mt-1">{findError}</p>}
              </>
            )}
          </div>

          {/* Claude-specific and rarely-changed knobs stay out of the way. */}
          <button
            onClick={() => setShowAdvanced(v => !v)}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 pt-1"
          >
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
            Advanced — ports, jump host, Claude sign-in token
          </button>

          {showAdvanced && (
            <div className="space-y-3 border-t border-slate-100 pt-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-xs text-slate-500 mb-1">SSH port on your machine</p>
                  <input
                    type="number"
                    value={settings.remoteAgentLocalSshPort ?? 22}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      persist({ remoteAgentLocalSshPort: Number.isInteger(n) && n > 0 ? n : 22 });
                    }}
                    className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                  <p className="text-[0.7rem] text-slate-400 mt-0.5">Default 22. Use 2222 if a policy blocks 22.</p>
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
                  <p className="text-xs text-slate-500 mb-1">Nebula URL from your machine</p>
                  <input
                    type="text"
                    value={settings.remoteAgentLocalUrl ?? 'http://localhost:3000'}
                    onChange={(e) => persist({ remoteAgentLocalUrl: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-1">Reverse port (this installation)</p>
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
                      title="Pick a new port (if this one collides with another user on the server). Every browser follows; your tunnel must be updated to match."
                    >
                      regenerate
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <p className="text-xs text-slate-600 font-medium">Claude sign-in token</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  Only needed if ssh-launched <code className="bg-slate-100 px-1 rounded">claude</code> keeps asking you
                  to log in: its credentials live in the macOS Keychain, which ssh sessions can't read. Run{' '}
                  <code className="bg-slate-100 px-1 rounded">claude setup-token</code> on your machine, then store it
                  under the Nebula-scoped name so your own sessions keep their normal login:
                </p>
                <CopyRow text={tokenExportCommand} copied={copied === 'token'} onCopy={() => copy(tokenExportCommand, 'token')} />
                <p className="text-[0.7rem] text-slate-400 mt-1">
                  Codex needs no token — its credentials are file-based (<code className="bg-slate-100 px-1 rounded">~/.codex</code>) and work over ssh.
                </p>
              </div>

              <div>
                <p className="text-xs text-slate-600 font-medium">nebula CLI on your machine</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  The launched agent drives your notebook through it. Any Node.js ≥ 20 works — agents fall back to{' '}
                  <code className="bg-slate-100 px-1 rounded">npx</code> automatically. Install once to skip that download:
                </p>
                <CopyRow text="npm install -g nebula-notebook-mcp" copied={copied === 'nebulacli'} onCopy={() => copy('npm install -g nebula-notebook-mcp', 'nebulacli')} />
              </div>
            </div>
          )}
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
