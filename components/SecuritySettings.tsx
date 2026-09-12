import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Plus, Trash2, Loader2, AlertCircle, ShieldCheck } from 'lucide-react';
import {
  addPasskey,
  deletePasskey,
  listPasskeys,
  passkeysSupported,
  defaultPasskeyLabel,
  currentRpID,
  type PasskeyInfo,
} from '../services/passkeyService';
import { useNotification } from './NotificationSystem';

function formatDate(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Settings → Security: the passkeys enrolled for this server, grouped by the
 * address they belong to (a passkey is bound to the hostname it was enrolled
 * at), plus "Add this device" enrollment and per-row removal.
 */
export const SecuritySettings: React.FC = () => {
  const { toast, confirm } = useNotification();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rpID, setRpID] = useState<string | null>(currentRpID());
  const [rpError, setRpError] = useState<string | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [label, setLabel] = useState(defaultPasskeyLabel());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const supported = passkeysSupported();

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await listPasskeys();
      setPasskeys(list.passkeys);
      setRpID(list.rpID);
      setRpError(list.rpError);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load passkeys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    try {
      const result = await addPasskey(label.trim() || undefined);
      if (result.ok === false) {
        if (!result.cancelled) setAddError(result.error);
        return;
      }
      toast(`Passkey "${result.passkey.label}" added`, 'success');
      setLabel(defaultPasskeyLabel());
      await refresh();
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (p: PasskeyInfo) => {
    const ok = await confirm({
      title: 'Remove passkey',
      message: `Remove "${p.label}"? Devices that relied on it will need your authenticator code to sign in.`,
      confirmLabel: 'Remove',
      variant: 'danger',
    });
    if (!ok) return;
    setRemoving(p.id);
    try {
      await deletePasskey(p.id);
      toast(`Removed "${p.label}"`, 'success');
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove passkey', 'error');
    } finally {
      setRemoving(null);
    }
  };

  const here = rpID ? passkeys.filter((p) => p.rpID === rpID) : [];
  const elsewhere = passkeys.filter((p) => !rpID || p.rpID !== rpID);
  const canEnroll = supported && !rpError;

  const renderRow = (p: PasskeyInfo, showRp: boolean) => (
    <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
      <KeyRound className="w-4 h-4 text-slate-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-700 truncate">{p.label}</p>
        <p className="text-xs text-slate-500">
          {showRp && <span className="font-mono">{p.rpID} · </span>}
          added {formatDate(p.createdAt)} · last used {formatDate(p.lastUsedAt)}
        </p>
      </div>
      <button
        type="button"
        onClick={() => handleRemove(p)}
        disabled={removing === p.id}
        aria-label={`Remove passkey ${p.label}`}
        title="Remove passkey"
        className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
      >
        {removing === p.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
      </button>
    </li>
  );

  return (
    <>
      <div>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
          <ShieldCheck className="w-4 h-4" />
          Passkeys
        </label>
        <div className="p-3 bg-slate-50 rounded-lg">
          <p className="text-xs text-slate-500">
            Sign in with Touch ID, Face ID, or a security key instead of typing a code. A passkey is
            bound to the address you enroll it at — this page is open at{' '}
            <span className="font-mono text-slate-700">{rpID ?? window.location.hostname}</span>. Your
            authenticator code keeps working as the fallback.
          </p>
        </div>
      </div>

      {rpError && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{rpError}</span>
        </div>
      )}

      {!supported && !rpError && (
        <div className="flex items-start gap-2 p-3 bg-slate-50 rounded-lg text-sm text-slate-600">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>This browser does not support passkeys (WebAuthn).</span>
        </div>
      )}

      {/* Enrolled at this address */}
      <div>
        <p className="text-sm font-medium text-slate-700 mb-2">
          At this address{rpID ? <span className="font-normal text-slate-500"> ({rpID})</span> : null}
        </p>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500 p-3">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : loadError ? (
          <div className="flex items-center gap-2 text-sm text-red-600 p-3 bg-red-50 rounded-lg">
            <AlertCircle className="w-4 h-4" /> {loadError}
          </div>
        ) : here.length === 0 ? (
          <p className="text-sm text-slate-500 p-3 bg-slate-50 rounded-lg">No passkey enrolled here yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
            {here.map((p) => renderRow(p, false))}
          </ul>
        )}
      </div>

      {/* Add this device */}
      {canEnroll && (
        <div>
          <p className="text-sm font-medium text-slate-700 mb-2">Add this device</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={60}
              placeholder={defaultPasskeyLabel()}
              aria-label="Passkey label"
              disabled={adding}
              className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={adding}
              className="px-3 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap"
            >
              {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add this device
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-1.5">
            Your browser will ask for Touch ID / Face ID or a security key. Platform passkeys synced by
            iCloud Keychain or Google Password Manager work from your other devices at the same address.
          </p>
          {addError && (
            <div className="flex items-start gap-2 mt-2 text-sm text-red-600">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{addError}</span>
            </div>
          )}
        </div>
      )}

      {/* Enrolled at other addresses */}
      {!loading && elsewhere.length > 0 && (
        <div>
          <p className="text-sm font-medium text-slate-700 mb-2">
            At other addresses <span className="font-normal text-slate-500">(not offered here)</span>
          </p>
          <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
            {elsewhere.map((p) => renderRow(p, true))}
          </ul>
        </div>
      )}
    </>
  );
};
