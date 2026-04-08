import { useState, useCallback } from 'react';
import type { Session } from '../types';

const SESSION_KEY = 'medseal_session';

export function useSession() {
  const [session, setSessionState] = useState<Session | null>(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  const login = useCallback(async (username: string, role: string, tags: string[]) => {
    const s: Session = { username, loginTime: Date.now(), role: role || 'user', tags: tags || [] };
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    document.cookie = `medseal_sso=${encodeURIComponent(username)}; path=/; max-age=86400; SameSite=Lax`;
    setSessionState(s);
  }, []);

  const logout = useCallback(() => {
    const user = session?.username || 'unknown';
    fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'logout', user, detail: 'Signed out from CDSS' }),
    }).catch(() => {});
    localStorage.removeItem(SESSION_KEY);
    document.cookie = 'medseal_sso=; path=/; max-age=0';
    setSessionState(null);
  }, [session]);

  return { session, login, logout };
}
