import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import {
  GlobalTheme,
  Header,
  HeaderContainer,
  HeaderName,
  HeaderNavigation,
  HeaderMenuItem,
  HeaderGlobalBar,
  HeaderGlobalAction,
  HeaderPanel,
  SideNav,
  SideNavItems,
  SideNavLink,
  SideNavMenu,
  SideNavMenuItem,
  SkipToContent,
  Content,
} from '@carbon/react';
import {
  Dashboard,
  UserAvatar,
  Notification,
  Settings,
  Search,
  Activity,
  Hospital,
  DataBase,
  Security,
  UserAdmin,
  Help,
  Book,
  Logout,
  CheckmarkFilled,
  WarningFilled,
  InformationFilled,
} from '@carbon/icons-react';

import { useSession } from './hooks/useSession';
import { filterServices } from './services';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ProfilePage from './pages/ProfilePage';
import AdminUsersPage from './pages/AdminUsersPage';
import StatusPage from './pages/StatusPage';

import './app.scss';

const ROLE_LABELS = {
  admin: 'Administrators',
  doc: 'Physicians',
  clin: 'Clinicians',
  front: 'Front Office',
  back: 'Accounting',
  breakglass: 'Emergency Login',
};

function AppShell() {
  const { session, login, logout } = useSession();
  const [displayName, setDisplayName] = useState('');
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const userRole = session?.role || '';
  const userTags = session?.tags || [];

  useEffect(() => {
    if (!session) return;
    fetch(`/api/users/${session.username}`)
      .then((r) => r.json())
      .then((d) => setDisplayName(d.displayName || session.username))
      .catch(() => setDisplayName(session.username));
  }, [session]);

  if (!session) {
    return <LoginPage onLogin={login} />;
  }

  const visibleServices = filterServices(userRole, userTags);
  const isAdmin = userRole === 'admin';
  const currentPath = location.pathname;

  return (
    <GlobalTheme theme="g100">
      <HeaderContainer
        render={() => (
          <>
            <Header aria-label="Med-SEAL SSO V2">
              <SkipToContent />
              <HeaderName
                prefix="Med-SEAL"
                onClick={() => navigate('/dashboard')}
                style={{ cursor: 'pointer' }}
              >
                SSO V2
              </HeaderName>
              <HeaderNavigation aria-label="Main navigation">
                <HeaderMenuItem
                  isActive={currentPath === '/dashboard' || currentPath === '/'}
                  onClick={() => navigate('/dashboard')}
                >
                  Dashboard
                </HeaderMenuItem>
                <HeaderMenuItem
                  isActive={currentPath === '/status'}
                  onClick={() => navigate('/status')}
                >
                  Status
                </HeaderMenuItem>
                <HeaderMenuItem
                  isActive={currentPath === '/profile'}
                  onClick={() => navigate('/profile')}
                >
                  Profile
                </HeaderMenuItem>
                {isAdmin && (
                  <HeaderMenuItem
                    isActive={currentPath === '/admin/users'}
                    onClick={() => navigate('/admin/users')}
                  >
                    Users
                  </HeaderMenuItem>
                )}
              </HeaderNavigation>
              <HeaderGlobalBar>
                <HeaderGlobalAction aria-label="Search">
                  <Search size={20} />
                </HeaderGlobalAction>
                <HeaderGlobalAction
                  aria-label="Notifications"
                  isActive={notificationsOpen}
                  onClick={() => setNotificationsOpen(!notificationsOpen)}
                >
                  <Notification size={20} />
                </HeaderGlobalAction>
                <HeaderGlobalAction
                  aria-label={displayName || session.username}
                  tooltipAlignment="end"
                  onClick={logout}
                >
                  <Logout size={20} />
                </HeaderGlobalAction>
              </HeaderGlobalBar>

              <HeaderPanel
                aria-label="Notification Panel"
                expanded={notificationsOpen}
              >
                <div className="notif-panel">
                  <h4>Notifications</h4>
                  <div className="notif-item">
                    <CheckmarkFilled size={16} className="icon-success" />
                    <div>
                      <strong>Session Active</strong>
                      <p>Signed in as {displayName || session.username}</p>
                    </div>
                  </div>
                  <div className="notif-item">
                    <InformationFilled size={16} className="icon-info" />
                    <div>
                      <strong>SSO V2 Active</strong>
                      <p>Running Carbon Design System</p>
                    </div>
                  </div>
                  <div className="notif-item">
                    <WarningFilled size={16} className="icon-warning" />
                    <div>
                      <strong>2FA Recommended</strong>
                      <p>Enable in Profile &amp; Security</p>
                    </div>
                  </div>
                </div>
              </HeaderPanel>
            </Header>

            <SideNav
              aria-label="Side navigation"
              isRail
              expanded
            >
              <SideNavItems>
                {/* Services */}
                <SideNavLink
                  renderIcon={Dashboard}
                  isActive={currentPath === '/dashboard' || currentPath === '/'}
                  onClick={() => navigate('/dashboard')}
                >
                  Homepage
                </SideNavLink>

                <SideNavMenu renderIcon={Hospital} title="Clinical" defaultExpanded>
                  {visibleServices.map((s) => (
                    <SideNavMenuItem
                      key={s.id}
                      onClick={() => {
                        const url = s.ssoId
                          ? `/api/sso/launch/${s.ssoId}?u=${encodeURIComponent(session.username)}`
                          : s.url;
                        window.open(url, '_blank');
                      }}
                    >
                      {s.name}
                    </SideNavMenuItem>
                  ))}
                </SideNavMenu>

                {/* Account */}
                <SideNavLink
                  renderIcon={UserAvatar}
                  isActive={currentPath === '/profile'}
                  onClick={() => navigate('/profile')}
                >
                  Profile &amp; Security
                </SideNavLink>

                {isAdmin && (
                  <SideNavLink
                    renderIcon={UserAdmin}
                    isActive={currentPath === '/admin/users'}
                    onClick={() => navigate('/admin/users')}
                  >
                    User Management
                  </SideNavLink>
                )}

                {/* Support */}
                <SideNavLink
                  renderIcon={Activity}
                  isActive={currentPath === '/status'}
                  onClick={() => navigate('/status')}
                >
                  System Status
                </SideNavLink>

                <SideNavLink
                  renderIcon={Book}
                  onClick={() => window.open('https://github.com/IgoyAI/Med-SEAL-Suite', '_blank')}
                >
                  Documentation
                </SideNavLink>

                <SideNavLink
                  renderIcon={Help}
                  onClick={() => window.open('mailto:support@medseal.io')}
                >
                  Help &amp; FAQ
                </SideNavLink>
              </SideNavItems>
            </SideNav>

            <Content className="app-content">
              <Routes>
                <Route path="/dashboard" element={<DashboardPage username={session.username} role={userRole} tags={userTags} />} />
                <Route path="/status" element={<StatusPage />} />
                <Route path="/profile" element={<ProfilePage username={session.username} />} />
                <Route path="/admin/users" element={
                  isAdmin ? <AdminUsersPage /> : <Navigate to="/dashboard" replace />
                } />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </Content>

            <footer className="app-footer">
              Med-SEAL Suite · SSO V2 · Secured Single Sign-On · Carbon Design System
            </footer>
          </>
        )}
      />
    </GlobalTheme>
  );
}

export default function App() {
  return <AppShell />;
}
