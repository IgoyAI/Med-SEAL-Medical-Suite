import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../components/Toast';
import { TextInput, PasswordInput, Button, InlineNotification, Tag, SkeletonText } from '@carbon/react';
import { UserAvatar, Locked, MobileCheck, Save, TrashCan } from '@carbon/icons-react';

interface Props { username: string; }

interface Profile {
    displayName: string; email: string; twoFAEnabled: boolean;
    createdAt: string; updatedAt: string;
}

export default function ProfilePage({ username }: Props) {
    const { showToast } = useToast();

    const [profile, setProfile] = useState<Profile | null>(null);
    const [displayName, setDisplayName] = useState('');
    const [email, setEmail] = useState('');

    const [curPwd, setCurPwd] = useState('');
    const [newPwd, setNewPwd] = useState('');
    const [confirmPwd, setConfirmPwd] = useState('');

    const [twoFASecret, setTwoFASecret] = useState('');
    const [twoFAUrl, setTwoFAUrl] = useState('');
    const [twoFACode, setTwoFACode] = useState('');
    const [setting2FA, setSetting2FA] = useState(false);

    const loadProfile = useCallback(async () => {
        try {
            const res = await fetch(`/api/users/${username}`);
            if (res.ok) {
                const data = await res.json();
                setProfile(data);
                setDisplayName(data.displayName);
                setEmail(data.email);
            }
        } catch { /* ignore */ }
    }, [username]);

    useEffect(() => { loadProfile(); }, [loadProfile]);

    const saveProfile = async () => {
        try {
            const res = await fetch(`/api/users/${username}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ displayName, email }),
            });
            if (res.ok) { showToast('success', 'Profile updated'); loadProfile(); }
            else { const err = await res.json(); showToast('error', err.error || 'Failed to save'); }
        } catch { showToast('error', 'Network error'); }
    };

    const changePassword = async () => {
        if (!curPwd || !newPwd) { showToast('warning', 'Fill in all password fields'); return; }
        if (newPwd !== confirmPwd) { showToast('warning', 'New passwords do not match'); return; }
        if (newPwd.length < 4) { showToast('warning', 'Password must be at least 4 characters'); return; }
        try {
            const res = await fetch(`/api/users/${username}/password`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword: curPwd, newPassword: newPwd }),
            });
            if (res.ok) {
                showToast('success', 'Password changed successfully');
                setCurPwd(''); setNewPwd(''); setConfirmPwd('');
            } else {
                const err = await res.json();
                showToast('error', err.error || 'Password change failed');
            }
        } catch { showToast('error', 'Network error'); }
    };

    const start2FA = async () => {
        try {
            const res = await fetch(`/api/users/${username}/2fa/setup`, { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                setTwoFASecret(data.secret);
                setTwoFAUrl(data.otpauthUrl || '');
                setSetting2FA(true);
            }
        } catch { showToast('error', 'Failed to start 2FA setup'); }
    };

    const verify2FA = async () => {
        if (twoFACode.length !== 6) { showToast('warning', 'Enter a 6-digit code'); return; }
        try {
            const res = await fetch(`/api/users/${username}/2fa/verify`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: twoFACode }),
            });
            if (res.ok) {
                showToast('success', 'Two-factor authentication enabled');
                setSetting2FA(false); setTwoFACode(''); setTwoFASecret('');
                loadProfile();
            } else {
                const err = await res.json();
                showToast('error', err.error || 'Verification failed');
            }
        } catch { showToast('error', 'Network error'); }
    };

    const disable2FA = async () => {
        try {
            const res = await fetch(`/api/users/${username}/2fa`, { method: 'DELETE' });
            if (res.ok) { showToast('info', 'Two-factor authentication disabled'); loadProfile(); }
        } catch { showToast('error', 'Network error'); }
    };

    if (!profile) return (
        <div style={{ padding: '2rem' }}>
            <SkeletonText heading width="200px" className="profile-skeleton-heading" />
            <SkeletonText paragraph lineCount={3} width="100%" />
        </div>
    );

    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Profile &amp; Security</h1>
                    <p className="page-subtitle">Manage your account settings, password, and two-factor authentication</p>
                </div>
            </div>

            {/* Profile Information */}
            <div className="profile-panel animate-in">
                <div className="profile-panel__header">
                    <div className="profile-panel__icon"><UserAvatar size={16} /></div>
                    <div>
                        <div className="profile-panel__title">Profile Information</div>
                        <div className="profile-panel__subtitle">Update your display name and email</div>
                    </div>
                </div>
                <div className="profile-panel__body">
                    {/* Username as read-only info line */}
                    <div style={{ marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--cds-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.32px', fontWeight: 600 }}>Username</span>
                        <Tag type="gray" size="sm">@{username}</Tag>
                        <span style={{ fontSize: '0.6875rem', color: 'var(--cds-text-helper)', marginLeft: 'auto' }}>
                            Member since {new Date(profile.createdAt).toLocaleDateString()}
                        </span>
                    </div>
                    <div className="profile-row">
                        <TextInput id="p-display" labelText="Display Name *" value={displayName}
                            onChange={e => setDisplayName(e.target.value)} required aria-required="true" />
                        <TextInput id="p-email" labelText="Email *" type="email" value={email}
                            onChange={e => setEmail(e.target.value)} required aria-required="true" />
                    </div>
                    <div className="profile-actions">
                        <Button kind="primary" renderIcon={Save} onClick={saveProfile}>Save Changes</Button>
                    </div>
                </div>
            </div>

            {/* Change Password */}
            <div className="profile-panel animate-in-delay-1">
                <div className="profile-panel__header">
                    <div className="profile-panel__icon"><Locked size={16} /></div>
                    <div>
                        <div className="profile-panel__title">Change Password</div>
                        <div className="profile-panel__subtitle">Verify your current password to set a new one</div>
                    </div>
                </div>
                <div className="profile-panel__body">
                    <div className="profile-row">
                        <PasswordInput id="p-cur" labelText="Current Password *" value={curPwd}
                            onChange={e => setCurPwd(e.target.value)} placeholder="Enter current password"
                            required aria-required="true" />
                    </div>
                    <div className="profile-row">
                        <PasswordInput id="p-new" labelText="New Password *" value={newPwd}
                            onChange={e => setNewPwd(e.target.value)} placeholder="Enter new password"
                            required aria-required="true" />
                        <PasswordInput id="p-confirm" labelText="Confirm New Password *" value={confirmPwd}
                            onChange={e => setConfirmPwd(e.target.value)} placeholder="Confirm new password"
                            required aria-required="true" />
                    </div>
                    <div className="profile-actions">
                        <Button kind="primary" renderIcon={Locked} onClick={changePassword}>Change Password</Button>
                    </div>
                </div>
            </div>

            {/* Two-Factor Authentication */}
            <div className="profile-panel animate-in-delay-2">
                <div className="profile-panel__header">
                    <div className="profile-panel__icon"><MobileCheck size={16} /></div>
                    <div>
                        <div className="profile-panel__title">Two-Factor Authentication (2FA)</div>
                        <div className="profile-panel__subtitle">Add an extra layer of security to your account</div>
                    </div>
                </div>
                <div className="profile-panel__body">
                    {profile.twoFAEnabled ? (
                        <>
                            <div className="twofa-status-card">
                                <div className="twofa-status-dot twofa-status-dot--enabled" />
                                <div>
                                    <strong style={{ color: 'var(--cds-text-primary)' }}>2FA is enabled</strong>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--cds-text-secondary)' }}>
                                        Your account is protected with two-factor authentication.
                                    </div>
                                </div>
                            </div>
                            <Button kind="danger" renderIcon={TrashCan} onClick={disable2FA}>Disable 2FA</Button>
                        </>
                    ) : setting2FA ? (
                        <>
                            <InlineNotification kind="info" title="Setup"
                                subtitle="Scan this QR code with your authenticator app" lowContrast hideCloseButton />
                            {twoFAUrl && (
                                <div className="twofa-setup-qr">
                                    <img
                                        src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(twoFAUrl)}`}
                                        alt="2FA QR Code"
                                    />
                                    <div className="qr-label">Scan with your authenticator app</div>
                                </div>
                            )}
                            <p style={{ fontSize: '0.75rem', color: 'var(--cds-text-secondary)', marginBottom: 8 }}>
                                Or enter this secret manually:
                            </p>
                            <div className="twofa-secret-display">{twoFASecret}</div>
                            <div className="twofa-verify-row">
                                <TextInput id="2fa-code" labelText="Verification code *" placeholder="6-digit code"
                                    value={twoFACode} maxLength={6}
                                    onChange={e => setTwoFACode((e.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6))}
                                    required aria-required="true" />
                                <Button kind="primary" onClick={verify2FA}>Verify &amp; Enable</Button>
                            </div>
                            <Button kind="ghost" onClick={() => { setSetting2FA(false); setTwoFASecret(''); setTwoFAUrl(''); setTwoFACode(''); }}>
                                Cancel
                            </Button>
                        </>
                    ) : (
                        <>
                            <div className="twofa-status-card">
                                <div className="twofa-status-dot twofa-status-dot--disabled" />
                                <div>
                                    <strong style={{ color: 'var(--cds-text-primary)' }}>2FA is not enabled</strong>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--cds-text-secondary)' }}>
                                        Protect your account by requiring a verification code at sign-in.
                                    </div>
                                </div>
                            </div>
                            <Button kind="primary" renderIcon={MobileCheck} onClick={start2FA}>Set Up 2FA</Button>
                        </>
                    )}
                </div>
            </div>
        </>
    );
}
