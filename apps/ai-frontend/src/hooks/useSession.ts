import { useState, useCallback } from 'react';

const SESSION_KEY = 'medseal_session';

export interface Session {
    username: string;
    loginTime: number;
    role: string;
    tags: string[];
}

export function useSession() {
    const [session, setSessionState] = useState<Session | null>(() => {
        try {
            const raw = localStorage.getItem(SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    });

    const login = useCallback(async (username: string, role?: string, tags?: string[]) => {
        // Role and tags are now passed directly from the login API response
        const finalRole = role || 'user';
        const finalTags = tags || [];

        const s: Session = { username, loginTime: Date.now(), role: finalRole, tags: finalTags };
        localStorage.setItem(SESSION_KEY, JSON.stringify(s));
        document.cookie = `medseal_sso=${encodeURIComponent(username)}; path=/; max-age=86400; SameSite=Lax`;
        setSessionState(s);
    }, []);

    const logout = useCallback(() => {
        const user = session?.username || 'unknown';
        fetch('/api/audit', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'logout', user, detail: 'Signed out' }),
        }).catch(() => { });
        localStorage.removeItem(SESSION_KEY);
        document.cookie = 'medseal_sso=; path=/; max-age=0';
        setSessionState(null);
    }, [session]);

    return { session, login, logout };
}
