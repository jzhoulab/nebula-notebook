import React, { useState, useRef, useEffect } from 'react';
import { Shield, Loader2, AlertCircle, CheckCircle2, Fingerprint } from 'lucide-react';
import { authService } from '../services/authService';
import { loginWithPasskey, passkeysSupported } from '../services/passkeyService';

interface Props {
  setupRequired: boolean;
  onSuccess: () => void;
}

/** Shown when the browser supports passkeys but none is enrolled at this hostname. */
export const PASSKEY_NONE_HINT =
  'No passkey on this address yet — sign in with your code, then add one in Settings → Security.';

/**
 * Login screen: passkey (Touch ID / Face ID / security key) first when the
 * browser supports WebAuthn, with the 6-digit TOTP code as the fallback on
 * the same screen. If setup is required, directs user to check terminal.
 */
export const TOTPLogin: React.FC<Props> = ({ setupRequired, onSuccess }) => {
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  // Default ON: the 30-day session. Unchecking asks for the 24 h one.
  const [trustBrowser, setTrustBrowser] = useState(true);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyHint, setPasskeyHint] = useState<string | null>(null);
  // Decided once per mount: WebAuthn support does not change while open.
  const [showPasskey] = useState(() => !setupRequired && passkeysSupported());
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Focus first input on mount
  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  // Auto-submit when all digits are entered
  useEffect(() => {
    if (digits.every(d => d !== '')) {
      handleSubmit();
    }
  }, [digits]);

  const handleDigitChange = (index: number, value: string) => {
    // Only allow single digit
    const digit = value.replace(/\D/g, '').slice(-1);

    const newDigits = [...digits];
    newDigits[index] = digit;
    setDigits(newDigits);
    setError(null);

    // Move to next input
    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    // Handle backspace to move to previous input
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }

    // Handle paste
    if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
      return; // Let paste event handle it
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedText = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);

    if (pastedText.length > 0) {
      const newDigits = [...digits];
      for (let i = 0; i < 6; i++) {
        newDigits[i] = pastedText[i] || '';
      }
      setDigits(newDigits);
      setError(null);

      // Focus appropriate input
      const focusIndex = Math.min(pastedText.length, 5);
      inputRefs.current[focusIndex]?.focus();
    }
  };

  const handleSubmit = async () => {
    const code = digits.join('');

    if (code.length !== 6) {
      setError('Please enter all 6 digits');
      return;
    }

    setIsVerifying(true);
    setError(null);

    try {
      const result = await authService.verify(code, trustBrowser);

      if (result.success) {
        onSuccess();
      } else {
        setError(result.error || 'Invalid code');
        // Clear inputs on error
        setDigits(['', '', '', '', '', '']);
        inputRefs.current[0]?.focus();
      }
    } finally {
      setIsVerifying(false);
    }
  };

  const handlePasskey = async () => {
    setPasskeyBusy(true);
    setPasskeyHint(null);
    setError(null);
    try {
      const result = await loginWithPasskey();
      if (result.status === 'ok') {
        onSuccess();
      } else if (result.status === 'none') {
        setPasskeyHint(PASSKEY_NONE_HINT);
      } else if (result.status === 'error') {
        setPasskeyHint(result.message);
      }
      // 'cancelled': the user dismissed the prompt — nothing to say.
    } finally {
      setPasskeyBusy(false);
    }
  };

  const busy = isVerifying || passkeyBusy;

  return (
    <div className="fixed inset-0 bg-slate-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-lg p-8 max-w-md w-full mx-4">
        <div className="flex flex-col items-center text-center">
          {/* Icon */}
          <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center mb-4">
            <Shield className="w-8 h-8 text-blue-600" />
          </div>

          {/* Title */}
          <h2 className="text-xl font-semibold text-slate-800 mb-2">
            {setupRequired ? 'Set Up 2FA' : showPasskey ? 'Sign in to Nebula' : 'Enter Verification Code'}
          </h2>

          {/* Instructions */}
          <p className="text-slate-500 mb-6">
            {setupRequired ? (
              <>
                Check your <span className="font-medium text-slate-700">terminal</span> for the QR code,
                then enter the 6-digit code from your authenticator app.
              </>
            ) : showPasskey ? (
              <>Use your passkey, or enter the 6-digit code from your authenticator app.</>
            ) : (
              <>Enter the 6-digit code from your authenticator app.</>
            )}
          </p>

          {/* Passkey (primary) */}
          {showPasskey && (
            <div className="w-full mb-2">
              <button
                type="button"
                onClick={handlePasskey}
                disabled={busy}
                className={`
                  w-full py-3 px-4 rounded-lg font-medium transition-colors
                  flex items-center justify-center gap-2
                  ${busy ? 'bg-blue-300 text-white cursor-wait' : 'bg-blue-600 text-white hover:bg-blue-700'}
                `}
              >
                {passkeyBusy ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Fingerprint className="w-5 h-5" />
                )}
                Sign in with passkey
              </button>
              <p className="text-xs text-slate-400 mt-2">Touch ID, Face ID, or a security key</p>
              {passkeyHint && (
                <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mt-3 text-left">
                  {passkeyHint}
                </p>
              )}
              <div className="flex items-center gap-3 my-5 text-xs text-slate-400">
                <span className="flex-1 h-px bg-slate-200" />
                or enter your code
                <span className="flex-1 h-px bg-slate-200" />
              </div>
            </div>
          )}

          {/* 6-digit input */}
          <div className="flex gap-2 mb-4" onPaste={handlePaste}>
            {digits.map((digit, index) => (
              <input
                key={index}
                ref={el => { inputRefs.current[index] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                aria-label={`Digit ${index + 1}`}
                onChange={e => handleDigitChange(index, e.target.value)}
                onKeyDown={e => handleKeyDown(index, e)}
                disabled={isVerifying}
                className={`
                  w-12 h-14 text-center text-2xl font-mono font-semibold
                  border-2 rounded-lg outline-none transition-colors
                  ${error
                    ? 'border-red-300 bg-red-50'
                    : 'border-slate-200 focus:border-blue-500 focus:bg-blue-50'
                  }
                  ${isVerifying ? 'opacity-50' : ''}
                `}
              />
            ))}
          </div>

          {/* Error message */}
          {error && (
            <div className="flex items-center gap-2 text-red-600 text-sm mb-4">
              <AlertCircle className="w-4 h-4" />
              <span>{error}</span>
            </div>
          )}

          {/* Session length (default: 30 days) */}
          <label className="flex items-center gap-2 text-sm text-slate-600 mb-6 cursor-pointer">
            <input
              type="checkbox"
              checked={trustBrowser}
              onChange={e => setTrustBrowser(e.target.checked)}
              disabled={isVerifying}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <span>Keep me signed in on this device (30 days)</span>
          </label>

          {/* Submit button */}
          <button
            onClick={handleSubmit}
            disabled={isVerifying || digits.some(d => !d)}
            className={`
              w-full py-3 px-4 rounded-lg font-medium transition-colors
              flex items-center justify-center gap-2
              ${isVerifying || digits.some(d => !d)
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700'
              }
            `}
          >
            {isVerifying ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Verifying...
              </>
            ) : (
              <>
                <CheckCircle2 className="w-5 h-5" />
                Verify
              </>
            )}
          </button>

          {/* Setup hint */}
          {setupRequired && (
            <p className="text-xs text-slate-400 mt-4">
              After entering the code, 2FA will be enabled for future sessions.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
