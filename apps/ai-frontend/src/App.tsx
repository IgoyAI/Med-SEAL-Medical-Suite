import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useSession } from './hooks/useSession';
import { ToastProvider } from './components/Toast';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import StatusPage from './pages/StatusPage';
import ProfilePage from './pages/ProfilePage';
import AdminUsersPage from './pages/AdminUsersPage';
import AdminSettingsPage from './pages/AdminSettingsPage';
import { filterServices } from './services';

import { GlobalTheme } from '@carbon/react';
import {
    Header, HeaderName,
    HeaderGlobalBar, HeaderGlobalAction,
    SideNav, SideNavItems, SideNavLink, SideNavMenu, SideNavMenuItem,
    Content, SkipToContent,
} from '@carbon/react';
import {
    UserAvatar, Logout, Security, Hospital, Activity,
    Book, Help, UserAdmin, Dashboard, Settings,
} from '@carbon/icons-react';

const ROLE_LABELS: Record<string, string> = {
    admin: 'Administrators', doc: 'Physicians', clin: 'Clinicians',
    front: 'Front Office', back: 'Accounting', breakglass: 'Emergency Login',
};

function AppShell() {
    const { session, login, logout } = useSession();
    const [displayName, setDisplayName] = useState('');
    const navigate = useNavigate();
    const location = useLocation();

    const userRole = session?.role || '';
    const userTags = session?.tags || [];

    useEffect(() => {
        if (!session) return;
        fetch(`/api/users/${session.username}`)
            .then(r => r.json())
            .then(d => setDisplayName(d.displayName || session.username))
            .catch(() => setDisplayName(session.username));
    }, [session]);

    if (!session) {
        return <LoginPage onLogin={login} />;
    }

    const visibleServices = filterServices(userRole, userTags);
    const isAdmin = userRole === 'admin';
    const currentPath = location.pathname;

    return (
        <>
            <Header aria-label="Med-SEAL">
                <SkipToContent />
                <HeaderName
                    prefix=""
                    onClick={() => navigate('/dashboard')}
                    style={{ cursor: 'pointer' }}
                >
                    <Security size={20} style={{ marginRight: 8 }} />
                    Med-SEAL
                </HeaderName>

                <HeaderGlobalBar>
                    <span className="header-user-info">
                        <span className="header-user-name">{displayName || session.username}</span>
                        {userRole && <span className="header-user-role">{ROLE_LABELS[userRole] || userRole}</span>}
                    </span>
                    <HeaderGlobalAction aria-label="Sign out" onClick={logout} tooltipAlignment="end">
                        <Logout size={20} />
                    </HeaderGlobalAction>
                </HeaderGlobalBar>
            </Header>

            <SideNav
                aria-label="Side navigation"
                isFixedNav
                expanded
            >
                <SideNavItems>
                    {/* ── Services ── */}
                    <SideNavLink
                        renderIcon={Dashboard}
                        isActive={currentPath === '/dashboard' || currentPath === '/'}
                        onClick={() => navigate('/dashboard')}
                    >
                        Dashboard
                    </SideNavLink>

                    <SideNavMenu title="Clinical Services" renderIcon={Hospital} defaultExpanded>
                        {visibleServices.map(s => (
                            <SideNavMenuItem key={s.id} onClick={() => {
                                const url = s.ssoId ? `/api/sso/launch/${s.ssoId}?u=${encodeURIComponent(session.username)}` : s.url;
                                window.open(url, '_blank');
                            }}>
                                {s.name}
                            </SideNavMenuItem>
                        ))}
                    </SideNavMenu>

                    <div className="sidenav-divider" />

                    {/* ── Account ── */}
                    <SideNavLink renderIcon={UserAvatar} isActive={currentPath === '/profile'}
                        onClick={() => navigate('/profile')}>
                        Profile &amp; Security
                    </SideNavLink>
                    {isAdmin && (
                        <SideNavLink renderIcon={UserAdmin} isActive={currentPath === '/admin/users'}
                            onClick={() => navigate('/admin/users')}>
                            User Management
                        </SideNavLink>
                    )}
                    {isAdmin && (
                        <SideNavLink renderIcon={Settings} isActive={currentPath === '/admin/settings'}
                            onClick={() => navigate('/admin/settings')}>
                            System Settings
                        </SideNavLink>
                    )}

                    <div className="sidenav-divider" />

                    {/* ── Support ── */}
                    <SideNavLink renderIcon={Activity} isActive={currentPath === '/status'}
                        onClick={() => navigate('/status')}>
                        System Status
                    </SideNavLink>
                    <SideNavLink renderIcon={Book}
                        onClick={() => window.open('https://github.com/IgoyAI/Med-SEAL-Suite', '_blank')}>
                        Documentation
                    </SideNavLink>
                    <SideNavLink renderIcon={Help}
                        onClick={() => window.open('mailto:support@medseal.io')}>
                        Help &amp; FAQ
                    </SideNavLink>
                </SideNavItems>
            </SideNav>

            <Content className="app-content">
                <div className="page-body">
                    <Routes>
                        <Route path="/dashboard" element={<DashboardPage username={session.username} role={userRole} tags={userTags} />} />
                        <Route path="/status" element={<StatusPage />} />
                        <Route path="/profile" element={<ProfilePage username={session.username} />} />
                        <Route path="/admin/users" element={
                            isAdmin ? <AdminUsersPage /> : <Navigate to="/dashboard" replace />
                        } />
                        <Route path="/admin/settings" element={
                            isAdmin ? <AdminSettingsPage /> : <Navigate to="/dashboard" replace />
                        } />
                        <Route path="*" element={<Navigate to="/dashboard" replace />} />
                    </Routes>
                </div>
                <footer className="app-footer">
                    Med-SEAL Suite · v2.0 · IBM Carbon Design System
                </footer>
            </Content>
        </>
    );
}

export default function App() {
    return (
        <GlobalTheme theme="g100">
            <BrowserRouter>
                <ToastProvider>
                    <AppShell />
                </ToastProvider>
            </BrowserRouter>
        </GlobalTheme>
    );
}
