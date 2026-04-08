import { useState, useCallback } from 'react';

const SESSION_KEY = 'medseal_session';

export function useSession() {
  const [session, setSessionState] = useState(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  const login = useCallback(async (username, role, tags) => {
    const s = { username, loginTime: Date.now(), role: role || 'user', tags: tags || [] };
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    document.cookie = `medseal_sso=${encodeURIComponent(username)}; path=/; max-age=86400; SameSite=Lax`;
    setSessionState(s);
  }, []);

  const logout = useCallback(() => {
    const user = session?.username || 'unknown';
    fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'logout', user, detail: 'Signed out' }),
    }).catch(() => {});
    localStorage.removeItem(SESSION_KEY);
    document.cookie = 'medseal_sso=; path=/; max-age=0';
    setSessionState(null);
  }, [session]);

  return { session, login, logout };
}
