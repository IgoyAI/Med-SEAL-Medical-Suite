import { useEffect, useState, useCallback } from 'react';
import {
  GlobalTheme,
  Header,
  HeaderName,
  HeaderGlobalBar,
  HeaderGlobalAction,
  HeaderMenuButton,
  SkipToContent,
} from '@carbon/react';
import { Logout, UserAvatar, Asleep, Light } from '@carbon/icons-react';
import { useSession } from './hooks/useSession';
import LoginPage from './pages/LoginPage';
import ChatPage from './pages/ChatPage';
import './app.scss';

type Theme = 'g100' | 'white';

export default function App() {
  const { session, login, logout } = useSession();
  const [theme, setTheme] = useState<Theme>(() => {
    return (localStorage.getItem('medseal_theme') as Theme) || 'g100';
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'g100' ? 'white' : 'g100';
      localStorage.setItem('medseal_theme', next);
      return next;
    });
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  // Handle SSO redirect
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith('#/sso?')) {
      const params = new URLSearchParams(hash.slice(6));
      const u = params.get('u');
      const r = params.get('r');
      const t = params.get('t');
      if (u) {
        login(u, r || 'user', t ? t.split(',').filter(Boolean) : []);
        window.location.hash = '';
      }
    }
  }, [login]);

  if (!session) {
    return (
      <GlobalTheme theme="g100">
        <LoginPage onLogin={login} />
      </GlobalTheme>
    );
  }

  return (
    <GlobalTheme theme={theme}>
      <div className={`cdss-root cdss-root--${theme}`}>
        <Header aria-label="Med-SEAL CDSS">
          <SkipToContent />
          <HeaderMenuButton
            aria-label={sidebarOpen ? 'Close menu' : 'Open menu'}
            onClick={toggleSidebar}
            isActive={sidebarOpen}
            aria-expanded={sidebarOpen}
          />
          <HeaderName prefix="Med-SEAL">
            CDSS
          </HeaderName>
          <HeaderGlobalBar>
            <HeaderGlobalAction
              aria-label={theme === 'g100' ? 'Light mode' : 'Dark mode'}
              onClick={toggleTheme}
            >
              {theme === 'g100' ? <Light size={20} /> : <Asleep size={20} />}
            </HeaderGlobalAction>
            <HeaderGlobalAction
              aria-label={session.username}
              tooltipAlignment="end"
            >
              <UserAvatar size={20} />
            </HeaderGlobalAction>
            <HeaderGlobalAction
              aria-label="Sign out"
              tooltipAlignment="end"
              onClick={logout}
            >
              <Logout size={20} />
            </HeaderGlobalAction>
          </HeaderGlobalBar>
        </Header>
        <ChatPage username={session.username} sidebarOpen={sidebarOpen} />
      </div>
    </GlobalTheme>
  );
}
