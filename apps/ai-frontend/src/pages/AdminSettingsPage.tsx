import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../components/Toast';
import {
    TextInput, NumberInput, Toggle, Button, Select, SelectItem,
    InlineNotification,
} from '@carbon/react';
import {
    Settings, Time, Locked, Security, Save, Reset,
} from '@carbon/icons-react';

interface SSOSettings {
    sessionTimeoutMinutes: number;
    passwordMinLength: number;
    passwordRequireUppercase: boolean;
    passwordRequireNumber: boolean;
    passwordRequireSpecial: boolean;
    maxFailedAttempts: number;
    lockoutDurationMinutes: number;
    enforce2FA: boolean;
    ssoSessionCookieName: string;
    ssoSessionMaxAgeDays: number;
    allowedOrigins: string;
}

const DEFAULTS: SSOSettings = {
    sessionTimeoutMinutes: 30,
    passwordMinLength: 8,
    passwordRequireUppercase: true,
    passwordRequireNumber: true,
    passwordRequireSpecial: false,
    maxFailedAttempts: 5,
    lockoutDurationMinutes: 15,
    enforce2FA: false,
    ssoSessionCookieName: 'medseal_sso',
    ssoSessionMaxAgeDays: 1,
    allowedOrigins: '*',
};

export default function AdminSettingsPage() {
    const { showToast } = useToast();
    const [settings, setSettings] = useState<SSOSettings>(DEFAULTS);
    const [saved, setSaved] = useState<SSOSettings>(DEFAULTS);
    const [loading, setLoading] = useState(true);

    const loadSettings = useCallback(async () => {
        try {
            const res = await fetch('/api/admin/settings');
            if (res.ok) {
                const data = await res.json();
                const merged = { ...DEFAULTS, ...data };
                setSettings(merged);
                setSaved(merged);
            }
        } catch { /* use defaults */ }
        setLoading(false);
    }, []);

    useEffect(() => { loadSettings(); }, [loadSettings]);

    const hasChanges = JSON.stringify(settings) !== JSON.stringify(saved);

    const handleSave = async () => {
        try {
            const res = await fetch('/api/admin/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            });
            if (res.ok) {
                setSaved({ ...settings });
                showToast('success', 'Settings saved successfully');
            } else {
                const err = await res.json();
                showToast('error', err.error || 'Failed to save settings');
            }
        } catch {
            showToast('error', 'Network error');
        }
    };

    const handleReset = () => {
        setSettings({ ...saved });
        showToast('info', 'Changes discarded');
    };

    const update = <K extends keyof SSOSettings>(key: K, value: SSOSettings[K]) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    };

    if (loading) {
        return (
            <div style={{ padding: '2rem', color: 'var(--cds-text-helper)' }}>
                Loading settings...
            </div>
        );
    }

    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">System Settings</h1>
                    <p className="page-subtitle">Configure session management, password policy, security, and SSO behavior</p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <Button kind="secondary" size="md" renderIcon={Reset} onClick={handleReset} disabled={!hasChanges}>
                        Discard
                    </Button>
                    <Button kind="primary" size="md" renderIcon={Save} onClick={handleSave} disabled={!hasChanges}>
                        Save Settings
                    </Button>
                </div>
            </div>

            {hasChanges && (
                <div style={{ marginBottom: 'var(--ms-page-gap)' }}>
                    <InlineNotification
                        kind="warning"
                        title="Unsaved changes"
                        subtitle="You have modified settings that have not been saved yet."
                        lowContrast
                        hideCloseButton
                    />
                </div>
            )}

            {/* Session Management */}
            <div className="profile-panel">
                <div className="profile-panel__header">
                    <div className="profile-panel__icon"><Time size={16} /></div>
                    <div>
                        <div className="profile-panel__title">Session Management</div>
                        <div className="profile-panel__subtitle">Configure session timeout and cookie settings</div>
                    </div>
                </div>
                <div className="profile-panel__body">
                    <div className="profile-row">
                        <NumberInput
                            id="session-timeout"
                            label="Session Timeout (minutes) *"
                            min={5} max={480} step={5}
                            value={settings.sessionTimeoutMinutes}
                            onChange={(_e: any, { value }: { value: string | number }) => update('sessionTimeoutMinutes', Number(value))}
                            helperText="Users are logged out after this period of inactivity"
                        />
                        <NumberInput
                            id="session-max-age"
                            label="Max Session Age (days) *"
                            min={1} max={30} step={1}
                            value={settings.ssoSessionMaxAgeDays}
                            onChange={(_e: any, { value }: { value: string | number }) => update('ssoSessionMaxAgeDays', Number(value))}
                            helperText="Maximum lifetime of an SSO session cookie"
                        />
                    </div>
                    <div className="profile-row">
                        <TextInput
                            id="cookie-name"
                            labelText="Session Cookie Name"
                            value={settings.ssoSessionCookieName}
                            onChange={e => update('ssoSessionCookieName', e.target.value)}
                            helperText="Name of the SSO session cookie"
                        />
                        <TextInput
                            id="allowed-origins"
                            labelText="Allowed Origins (CORS)"
                            value={settings.allowedOrigins}
                            onChange={e => update('allowedOrigins', e.target.value)}
                            helperText="Comma-separated list of allowed origins, or * for all"
                        />
                    </div>
                </div>
            </div>

            {/* Password Policy */}
            <div className="profile-panel">
                <div className="profile-panel__header">
                    <div className="profile-panel__icon"><Locked size={16} /></div>
                    <div>
                        <div className="profile-panel__title">Password Policy</div>
                        <div className="profile-panel__subtitle">Define minimum requirements for user passwords</div>
                    </div>
                </div>
                <div className="profile-panel__body">
                    <div className="profile-row">
                        <NumberInput
                            id="pwd-min-length"
                            label="Minimum Password Length *"
                            min={4} max={64} step={1}
                            value={settings.passwordMinLength}
                            onChange={(_e: any, { value }: { value: string | number }) => update('passwordMinLength', Number(value))}
                            helperText="Minimum number of characters required"
                        />
                        <div />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.5rem' }}>
                        <Toggle
                            id="pwd-uppercase"
                            labelText="Require Uppercase Letter"
                            labelA="Off" labelB="On"
                            toggled={settings.passwordRequireUppercase}
                            onToggle={v => update('passwordRequireUppercase', v)}
                        />
                        <Toggle
                            id="pwd-number"
                            labelText="Require Number"
                            labelA="Off" labelB="On"
                            toggled={settings.passwordRequireNumber}
                            onToggle={v => update('passwordRequireNumber', v)}
                        />
                        <Toggle
                            id="pwd-special"
                            labelText="Require Special Character"
                            labelA="Off" labelB="On"
                            toggled={settings.passwordRequireSpecial}
                            onToggle={v => update('passwordRequireSpecial', v)}
                        />
                    </div>
                </div>
            </div>

            {/* Brute-Force Protection */}
            <div className="profile-panel">
                <div className="profile-panel__header">
                    <div className="profile-panel__icon"><Security size={16} /></div>
                    <div>
                        <div className="profile-panel__title">Brute-Force Protection</div>
                        <div className="profile-panel__subtitle">Configure account lockout after failed login attempts</div>
                    </div>
                </div>
                <div className="profile-panel__body">
                    <div className="profile-row">
                        <NumberInput
                            id="max-attempts"
                            label="Max Failed Attempts *"
                            min={1} max={20} step={1}
                            value={settings.maxFailedAttempts}
                            onChange={(_e: any, { value }: { value: string | number }) => update('maxFailedAttempts', Number(value))}
                            helperText="Account locks after this many consecutive failures"
                        />
                        <NumberInput
                            id="lockout-duration"
                            label="Lockout Duration (minutes) *"
                            min={1} max={1440} step={5}
                            value={settings.lockoutDurationMinutes}
                            onChange={(_e: any, { value }: { value: string | number }) => update('lockoutDurationMinutes', Number(value))}
                            helperText="How long the account stays locked"
                        />
                    </div>
                </div>
            </div>

            {/* Two-Factor Authentication Policy */}
            <div className="profile-panel">
                <div className="profile-panel__header">
                    <div className="profile-panel__icon"><Settings size={16} /></div>
                    <div>
                        <div className="profile-panel__title">Two-Factor Authentication Policy</div>
                        <div className="profile-panel__subtitle">Organization-wide 2FA enforcement settings</div>
                    </div>
                </div>
                <div className="profile-panel__body">
                    <Toggle
                        id="enforce-2fa"
                        labelText="Enforce 2FA for All Users"
                        labelA="Optional" labelB="Required"
                        toggled={settings.enforce2FA}
                        onToggle={v => update('enforce2FA', v)}
                    />
                    <p style={{ fontSize: '0.75rem', color: 'var(--cds-text-secondary)', marginTop: '0.75rem', lineHeight: 1.6 }}>
                        When enabled, all users must set up two-factor authentication before accessing the system.
                        Users without 2FA will be redirected to the setup page after login.
                    </p>
                </div>
            </div>
        </>
    );
}
