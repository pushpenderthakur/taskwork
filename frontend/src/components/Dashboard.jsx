/**
 * Signed-in dashboard.
 *
 * Shows the profile with per-channel verification, which social accounts are
 * linked, and the active sessions. "Refresh" re-reads `/me` and `/sessions`;
 * sign-out revokes either the current session or every session.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  Globe,
  KeyRound,
  Loader2,
  LogOut,
  Mail,
  Phone,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { api, apiErrorMessage, clearSession, saveSession } from '../api';

/** One profile row; hidden entirely when the channel is not set. */
function Field({ icon: Icon, label, value, verified }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="flex items-center gap-2 text-sm text-slate-600">
        <Icon size={16} /> {label}
      </span>
      <span className="flex items-center gap-2 text-sm font-medium text-slate-800">
        {value}
        {verified ? (
          <span
            title="Verified"
            className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700"
          >
            <CheckCircle2 size={12} /> Verified
          </span>
        ) : (
          <span
            title="Not verified"
            className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500"
          >
            <Circle size={12} /> Unverified
          </span>
        )}
      </span>
    </div>
  );
}

export default function Dashboard({ user: initialUser, onSignedOut }) {
  const [user, setUser] = useState(initialUser);
  const [sessions, setSessions] = useState([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  // Which action is in flight: 'profile', 'logout' or 'logout-all'.
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const fetchSessions = useCallback(async () => {
    const { data } = await api.get('/sessions');
    return data.sessions ?? [];
  }, []);

  // Load sessions on mount; `cancelled` avoids a state update after unmount.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const list = await fetchSessions();
        if (cancelled) return;
        setSessions(list);
        setError('');
      } catch (err) {
        if (!cancelled) setError(apiErrorMessage(err, 'Could not load your sessions.'));
      } finally {
        if (!cancelled) setLoadingSessions(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [fetchSessions]);

  /** Manual refresh of the session list. */
  const refreshSessions = async () => {
    setLoadingSessions(true);
    try {
      setSessions(await fetchSessions());
      setError('');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load your sessions.'));
    } finally {
      setLoadingSessions(false);
    }
  };

  /** Re-reads `/me` and updates the cached user. */
  const refreshProfile = async () => {
    setBusy('profile');
    setError('');
    try {
      const { data } = await api.get('/me');
      saveSession({ user: data.user });
      setUser(data.user);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not refresh your profile.'));
    } finally {
      setBusy('');
    }
  };

  /**
   * Signs out. `path` is `/logout` (current session) or `/logout-all` (every
   * device); the local session is cleared either way, even if the call fails.
   */
  const signOut = async (path) => {
    setBusy(path);
    setError('');
    try {
      await api.post(path);
    } catch (err) {
      setError(apiErrorMessage(err, 'Sign out failed.'));
    } finally {
      clearSession();
      onSignedOut();
    }
  };

  const displayName = user.name || user.email || user.phone || 'Taskwork user';
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
      <div className="max-w-xl w-full bg-white rounded-2xl shadow-xl p-8">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-14 h-14 rounded-full bg-blue-600 text-white flex items-center justify-center text-2xl font-bold">
            {initial}
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-slate-800">{displayName}</h1>
            <p className="text-sm text-slate-500">
              Signed in{' '}
              {user.providers?.google || user.providers?.apple ? 'with social login' : 'with an OTP'}
            </p>
          </div>
          <button
            type="button"
            onClick={refreshProfile}
            disabled={busy === 'profile'}
            className="p-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 transition disabled:opacity-50"
            title="Refresh profile"
          >
            {busy === 'profile' ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <RefreshCw size={18} />
            )}
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg">
            {error}
          </div>
        )}

        <div className="divide-y divide-slate-100 border-y border-slate-100">
          <Field
            icon={Mail}
            label="Email"
            value={user.email}
            verified={user.emailVerified}
          />
          <Field
            icon={Phone}
            label="Phone"
            value={user.phone}
            verified={user.phoneVerified}
          />
          <div className="flex items-center justify-between gap-3 py-2">
            <span className="flex items-center gap-2 text-sm text-slate-600">
              <ShieldCheck size={16} /> Linked providers
            </span>
            <span className="flex items-center gap-2 text-xs font-medium">
              <span
                className={`rounded-full px-2 py-0.5 ${
                  user.providers?.google
                    ? 'bg-blue-50 text-blue-700'
                    : 'bg-slate-100 text-slate-400'
                }`}
              >
                Google
              </span>
              <span
                className={`rounded-full px-2 py-0.5 ${
                  user.providers?.apple
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-400'
                }`}
              >
                Apple
              </span>
            </span>
          </div>
        </div>

        <div className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase text-slate-500">
              <KeyRound size={14} /> Active sessions
            </h2>
            <button
              type="button"
              onClick={refreshSessions}
              className="text-xs text-blue-600 hover:underline"
            >
              Refresh
            </button>
          </div>

          {loadingSessions ? (
            <p className="text-sm text-slate-500 py-3">Loading sessions…</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-slate-500 py-3">No active sessions.</p>
          ) : (
            <ul className="space-y-2">
              {sessions.map((session) => (
                <li
                  key={session.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2"
                >
                  <span className="flex items-center gap-2 text-sm text-slate-700">
                    <Globe size={14} />
                    <span className="truncate max-w-[220px]">
                      {session.userAgent ?? 'Unknown device'}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-xs text-slate-500">
                    {session.ip ?? '—'}
                    {session.current && (
                      <span className="rounded-full bg-green-50 px-2 py-0.5 font-medium text-green-700">
                        This device
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => signOut('/logout')}
            disabled={Boolean(busy)}
            className="flex items-center justify-center gap-2 py-2.5 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition disabled:opacity-50"
          >
            <LogOut size={16} /> Sign out
          </button>
          <button
            type="button"
            onClick={() => signOut('/logout-all')}
            disabled={Boolean(busy)}
            className="flex items-center justify-center gap-2 py-2.5 border border-red-200 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 transition disabled:opacity-50"
          >
            <Trash2 size={16} /> Sign out everywhere
          </button>
        </div>
      </div>
    </div>
  );
}