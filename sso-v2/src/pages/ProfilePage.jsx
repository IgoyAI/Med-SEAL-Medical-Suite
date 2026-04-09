import { useState, useEffect, useCallback } from 'react';
import { API } from '../api';
import {
  Grid,
  Column,
  TextInput,
  PasswordInput,
  Button,
  Toggle,
  InlineNotification,
  Tag,
} from '@carbon/react';
import {
  UserAvatar,
  Locked,
  MobileCheck,
  Save,
  TrashCan,
} from '@carbon/icons-react';

export default function ProfilePage({ username }) {
  const [profile, setProfile] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [curPwd, setCurPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [twoFASecret, setTwoFASecret] = useState('');
  const [twoFAUrl, setTwoFAUrl] = useState('');
  const [twoFACode, setTwoFACode] = useState('');
  const [setting2FA, setSetting2FA] = useState(false);
  const [notification, setNotification] = useState(null);

  const notify = (kind, title, subtitle) => {
    setNotification({ kind, title, subtitle });
    setTimeout(() => setNotification(null), 4000);
  };

  const loadProfile = useCallback(async () => {
    try {
      const res = await fetch(`${API}/users/${username}`);
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
      const res = await fetch(`${API}/users/${username}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName, email }),
      });
      if (res.ok) {
        notify('success', 'Saved', 'Profile updated successfully');
        loadProfile();
      } else {
        const err = await res.json();
        notify('error', 'Error', err.error || 'Failed to save');
      }
    } catch { notify('error', 'Error', 'Network error'); }
  };

  const changePassword = async () => {
    if (!curPwd || !newPwd) { notify('warning', 'Warning', 'Fill in all password fields'); return; }
    if (newPwd !== confirmPwd) { notify('warning', 'Warning', 'New passwords do not match'); return; }
    if (newPwd.length < 4) { notify('warning', 'Warning', 'Password must be at least 4 characters'); return; }
    try {
      const res = await fetch(`${API}/users/${username}/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: curPwd, newPassword: newPwd }),
      });
      if (res.ok) {
        notify('success', 'Done', 'Password changed successfully');
        setCurPwd(''); setNewPwd(''); setConfirmPwd('');
      } else {
        const err = await res.json();
        notify('error', 'Error', err.error || 'Password change failed');
      }
    } catch { notify('error', 'Error', 'Network error'); }
  };

  const start2FA = async () => {
    try {
      const res = await fetch(`${API}/users/${username}/2fa/setup`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setTwoFASecret(data.secret);
        setTwoFAUrl(data.otpauthUrl || '');
        setSetting2FA(true);
      }
    } catch { notify('error', 'Error', 'Failed to start 2FA setup'); }
  };

  const verify2FA = async () => {
    if (twoFACode.length !== 6) { notify('warning', 'Warning', 'Enter a 6-digit code'); return; }
    try {
      const res = await fetch(`${API}/users/${username}/2fa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: twoFACode }),
      });
      if (res.ok) {
        notify('success', 'Enabled', 'Two-factor authentication is now active');
        setSetting2FA(false); setTwoFACode(''); setTwoFASecret('');
        loadProfile();
      } else {
        const err = await res.json();
        notify('error', 'Error', err.error || 'Verification failed');
      }
    } catch { notify('error', 'Error', 'Network error'); }
  };

  const disable2FA = async () => {
    try {
      const res = await fetch(`${API}/users/${username}/2fa`, { method: 'DELETE' });
      if (res.ok) {
        notify('info', 'Disabled', '2FA has been turned off');
        loadProfile();
      }
    } catch { notify('error', 'Error', 'Network error'); }
  };

  if (!profile) {
    return (
      <div className="page-body" style={{ textAlign: 'center', padding: '4rem', color: 'var(--cds-text-helper)' }}>
        Loading profile…
      </div>
    );
  }

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <h1>Profile &amp; Security</h1>
          <p className="page-subtitle">Manage your account settings, password, and two-factor authentication</p>
        </div>
      </div>

      {notification && (
        <div style={{ marginBottom: '1rem' }}>
          <InlineNotification
            kind={notification.kind}
            title={notification.title}
            subtitle={notification.subtitle}
            lowContrast
            onClose={() => setNotification(null)}
          />
        </div>
      )}

      {/* Profile Info */}
      <div className="profile-panel">
        <div className="profile-panel__header">
          <div className="profile-panel__icon">
            <UserAvatar size={16} />
          </div>
          <div>
            <div className="profile-panel__title">Profile Information</div>
            <div className="profile-panel__subtitle">Update your display name and email</div>
          </div>
        </div>
        <div className="profile-panel__body">
          <Grid narrow>
            <Column lg={8} md={4} sm={4} className="profile-row">
              <TextInput id="prof-username" labelText="Username" value={username} disabled />
            </Column>
            <Column lg={8} md={4} sm={4} className="profile-row">
              <TextInput
                id="prof-display"
                labelText="Display Name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </Column>
            <Column lg={8} md={4} sm={4} className="profile-row">
              <TextInput
                id="prof-email"
                labelText="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Column>
            <Column lg={8} md={4} sm={4} className="profile-row">
              <TextInput
                id="prof-since"
                labelText="Member Since"
                value={new Date(profile.createdAt).toLocaleDateString()}
                disabled
              />
            </Column>
          </Grid>
          <div className="profile-actions">
            <Button kind="primary" renderIcon={Save} onClick={saveProfile}>
              Save Changes
            </Button>
          </div>
        </div>
      </div>

      {/* Password */}
      <div className="profile-panel">
        <div className="profile-panel__header">
          <div className="profile-panel__icon">
            <Locked size={16} />
          </div>
          <div>
            <div className="profile-panel__title">Change Password</div>
            <div className="profile-panel__subtitle">Verify your current password to set a new one</div>
          </div>
        </div>
        <div className="profile-panel__body">
          <Grid narrow>
            <Column lg={16} md={8} sm={4} className="profile-row">
              <PasswordInput
                id="cur-pwd"
                labelText="Current Password"
                placeholder="Enter current password"
                value={curPwd}
                onChange={(e) => setCurPwd(e.target.value)}
                required
              />
            </Column>
            <Column lg={8} md={4} sm={4} className="profile-row">
              <PasswordInput
                id="new-pwd"
                labelText="New Password"
                placeholder="Enter new password"
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                required
              />
            </Column>
            <Column lg={8} md={4} sm={4} className="profile-row">
              <PasswordInput
                id="confirm-pwd"
                labelText="Confirm New Password"
                placeholder="Confirm new password"
                value={confirmPwd}
                onChange={(e) => setConfirmPwd(e.target.value)}
                required
              />
            </Column>
          </Grid>
          <div className="profile-actions">
            <Button kind="primary" renderIcon={Locked} onClick={changePassword}>
              Change Password
            </Button>
          </div>
        </div>
      </div>

      {/* 2FA */}
      <div className="profile-panel">
        <div className="profile-panel__header">
          <div className="profile-panel__icon">
            <MobileCheck size={16} />
          </div>
          <div>
            <div className="profile-panel__title">Two-Factor Authentication (2FA)</div>
            <div className="profile-panel__subtitle">Add an extra layer of security to your account</div>
          </div>
        </div>
        <div className="profile-panel__body">
          {profile.twoFAEnabled ? (
            <>
              <div className="twofa-status-card">
                <span className="twofa-status-dot twofa-status-dot--enabled" />
                <div>
                  <strong style={{ color: 'var(--cds-text-primary)', fontSize: '0.875rem' }}>
                    2FA is enabled
                  </strong>
                  <br />
                  <span style={{ fontSize: '0.75rem', color: 'var(--cds-text-secondary)' }}>
                    Your account is protected with two-factor authentication.
                  </span>
                </div>
              </div>
              <Button kind="danger" renderIcon={TrashCan} onClick={disable2FA}>
                Disable 2FA
              </Button>
            </>
          ) : setting2FA ? (
            <>
              <p style={{ fontSize: '0.8125rem', color: 'var(--cds-text-secondary)', marginBottom: '1rem' }}>
                Scan this QR code with your authenticator app:
              </p>
              {twoFAUrl && (
                <div className="twofa-setup-qr">
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(twoFAUrl)}`}
                    alt="2FA QR Code"
                    width={200}
                    height={200}
                  />
                  <div className="qr-label">Scan with Google Authenticator, Authy, or similar</div>
                </div>
              )}
              <p style={{ fontSize: '0.75rem', color: 'var(--cds-text-secondary)', marginBottom: '0.5rem' }}>
                Or enter this secret manually:
              </p>
              <div className="twofa-secret-display">{twoFASecret}</div>
              <Grid narrow>
                <Column lg={8} md={4} sm={4}>
                  <TextInput
                    id="verify-2fa"
                    labelText="6-digit code"
                    placeholder="000000"
                    value={twoFACode}
                    onChange={(e) => setTwoFACode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    maxLength={6}
                    required
                  />
                </Column>
                <Column lg={8} md={4} sm={4} style={{ display: 'flex', alignItems: 'flex-end', gap: '0.5rem' }}>
                  <Button kind="primary" onClick={verify2FA}>Verify &amp; Enable</Button>
                  <Button kind="ghost" onClick={() => { setSetting2FA(false); setTwoFASecret(''); setTwoFAUrl(''); setTwoFACode(''); }}>
                    Cancel
                  </Button>
                </Column>
              </Grid>
            </>
          ) : (
            <>
              <div className="twofa-status-card">
                <span className="twofa-status-dot twofa-status-dot--disabled" />
                <div>
                  <strong style={{ color: 'var(--cds-text-primary)', fontSize: '0.875rem' }}>
                    2FA is not enabled
                  </strong>
                  <br />
                  <span style={{ fontSize: '0.75rem', color: 'var(--cds-text-secondary)' }}>
                    Protect your account with a verification code at sign-in.
                  </span>
                </div>
              </div>
              <Button kind="primary" renderIcon={MobileCheck} onClick={start2FA}>
                Set Up 2FA
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
