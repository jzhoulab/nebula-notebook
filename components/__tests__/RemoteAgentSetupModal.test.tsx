import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RemoteAgentSetupModal } from '../RemoteAgentSetupModal';

vi.mock('../../services/terminalService', () => ({
  getTerminalServerInfo: vi.fn().mockResolvedValue({
    available: true,
    repoRoot: null,
    hostname: 'login-node',
    port: 3000,
  }),
  checkReverseTunnel: vi.fn().mockResolvedValue({ up: false, ssh: null }),
}));

/** Rarely-changed guidance lives behind "Advanced" — open it like a user would. */
const openAdvanced = () => fireEvent.click(screen.getByText(/^Advanced/));

describe('RemoteAgentSetupModal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('instructs storing the token under the Nebula-scoped name, not the global var', () => {
    render(<RemoteAgentSetupModal onClose={() => {}} />);
    openAdvanced();

    // Storing the token as CLAUDE_CODE_OAUTH_TOKEN would hijack the user's own
    // interactive claude sessions; the setup must use the NEBULA-scoped name.
    expect(
      screen.getByText(/export CLAUDE_CODE_OAUTH_TOKEN_NEBULA=PASTE-TOKEN-HERE/)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/export CLAUDE_CODE_OAUTH_TOKEN=PASTE-TOKEN-HERE/)
    ).toBeNull();
  });

  it('states the nebula CLI prerequisite for the user machine', () => {
    render(<RemoteAgentSetupModal onClose={() => {}} />);
    openAdvanced();

    // The agent launched on the user's machine drives the notebook through the
    // nebula CLI — the guided setup must say so without pointing at the README.
    expect(screen.getByText(/nebula CLI/i)).toBeInTheDocument();
    expect(screen.getByText('npm install -g nebula-notebook-mcp')).toBeInTheDocument();
    // The zero-install path (Node's npx fallback) must be mentioned too.
    expect(screen.getByText(/npx/)).toBeInTheDocument();
  });

  it('leads with handing the whole setup to an agent (the path most users take)', () => {
    render(<RemoteAgentSetupModal onClose={() => {}} />);
    // Visible without expanding anything — it is the primary route, not a footnote.
    expect(screen.getByText(/Copy setup prompt/)).toBeInTheDocument();
    expect(screen.getByText(/let an agent do it/i)).toBeInTheDocument();
  });

  it('offers to discover the username instead of only demanding it', () => {
    render(<RemoteAgentSetupModal onClose={() => {}} />);
    // The lab report was "I cannot use it until I put in my username, and
    // nothing said so" — the step must be named AND self-serving.
    expect(screen.getByText(/Who you are on that machine/)).toBeInTheDocument();
    expect(screen.getByText(/Find it for me/)).toBeInTheDocument();
  });

  it('keeps the five connection knobs out of the initial view', () => {
    render(<RemoteAgentSetupModal onClose={() => {}} />);
    expect(screen.queryByText(/SSH jump host/)).toBeNull();
    openAdvanced();
    expect(screen.getByText(/SSH jump host/)).toBeInTheDocument();
  });
});
