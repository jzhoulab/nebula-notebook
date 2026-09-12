import React from 'react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const passkeyState = vi.hoisted(() => ({ supported: true }));

vi.mock('../../services/passkeyService', () => ({
  passkeysSupported: () => passkeyState.supported,
  loginWithPasskey: vi.fn(),
}));

// authService installs a global fetch interceptor on import — keep it out.
vi.mock('../../services/authService', () => ({
  authService: { verify: vi.fn() },
}));

import { TOTPLogin, PASSKEY_NONE_HINT } from '../TOTPLogin';
import { loginWithPasskey } from '../../services/passkeyService';
import { authService } from '../../services/authService';

const passkeyButton = () => screen.getByRole('button', { name: /sign in with passkey/i });

describe('TOTPLogin — passkey first, code as fallback', () => {
  beforeEach(() => {
    passkeyState.supported = true;
    (loginWithPasskey as Mock).mockReset();
    (authService.verify as Mock).mockReset();
  });

  it('shows the passkey button whenever the browser supports WebAuthn, with the code entry beside it', () => {
    render(<TOTPLogin setupRequired={false} onSuccess={() => {}} />);
    expect(passkeyButton()).toBeInTheDocument();
    expect(screen.getByText(/Touch ID, Face ID, or a security key/)).toBeInTheDocument();
    // TOTP stays on the same screen
    expect(screen.getAllByRole('textbox')).toHaveLength(6);
    expect(screen.getByRole('button', { name: /verify/i })).toBeInTheDocument();
  });

  it('hides the passkey button when WebAuthn is unsupported or during first-time setup', () => {
    passkeyState.supported = false;
    const { unmount } = render(<TOTPLogin setupRequired={false} onSuccess={() => {}} />);
    expect(screen.queryByRole('button', { name: /sign in with passkey/i })).toBeNull();
    unmount();

    passkeyState.supported = true;
    render(<TOTPLogin setupRequired={true} onSuccess={() => {}} />);
    expect(screen.queryByRole('button', { name: /sign in with passkey/i })).toBeNull();
    expect(screen.getByText('Set Up 2FA')).toBeInTheDocument();
  });

  it('with no passkey enrolled here, shows the one-line hint pointing at Settings → Security', async () => {
    (loginWithPasskey as Mock).mockResolvedValue({ status: 'none', message: 'No passkeys enrolled for localhost' });
    const onSuccess = vi.fn();
    render(<TOTPLogin setupRequired={false} onSuccess={onSuccess} />);
    fireEvent.click(passkeyButton());
    expect(await screen.findByText(PASSKEY_NONE_HINT)).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
    // the code inputs are still usable
    expect(screen.getAllByRole('textbox')[0]).not.toBeDisabled();
  });

  it('a verified passkey completes the login through the shared success path', async () => {
    (loginWithPasskey as Mock).mockResolvedValue({ status: 'ok' });
    const onSuccess = vi.fn();
    render(<TOTPLogin setupRequired={false} onSuccess={onSuccess} />);
    fireEvent.click(passkeyButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it('a dismissed prompt says nothing; a real error is surfaced', async () => {
    (loginWithPasskey as Mock).mockResolvedValueOnce({ status: 'cancelled' });
    render(<TOTPLogin setupRequired={false} onSuccess={() => {}} />);
    fireEvent.click(passkeyButton());
    await waitFor(() => expect(loginWithPasskey).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(PASSKEY_NONE_HINT)).toBeNull();

    (loginWithPasskey as Mock).mockResolvedValueOnce({ status: 'error', message: 'Passkeys cannot be used at an IP address (127.0.0.1)' });
    fireEvent.click(passkeyButton());
    expect(await screen.findByText(/IP address \(127\.0\.0\.1\)/)).toBeInTheDocument();
  });

  it('"Keep me signed in" (30-day session) is checked by default and is what the code path sends', async () => {
    (authService.verify as Mock).mockResolvedValue({ success: true });
    const onSuccess = vi.fn();
    render(<TOTPLogin setupRequired={false} onSuccess={onSuccess} />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
    expect(screen.getByText(/Keep me signed in on this device \(30 days\)/)).toBeInTheDocument();

    const inputs = screen.getAllByRole('textbox');
    '123456'.split('').forEach((d, i) => fireEvent.change(inputs[i], { target: { value: d } }));
    await waitFor(() => expect(authService.verify).toHaveBeenCalledWith('123456', true));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });
});
