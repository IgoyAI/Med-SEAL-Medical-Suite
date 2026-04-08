import { useState } from 'react';
import { useToast } from '../components/Toast';
import { TextInput, PasswordInput, Button, InlineNotification, InlineLoading } from '@carbon/react';
import { Security, Locked, CheckmarkFilled, MobileCheck, Encryption, WarningAlt, ArrowRight } from '@carbon/icons-react';

interface Props {
    onLogin: (username: string, role: string, tags: string[]) => Promise<void> | void;
}

type Step = 'credentials' | '2fa' | 'no2fa-warning';

export default function LoginPage({ onLogin }: Props) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [totpCode, setTotpCode] = useState('');
    const [step, setStep] = useState<Step>('credentials');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [pending, setPending] = useState<{
        username: string; displayName: string; role: string; tags: string[]; challengeNumber?: number;
    } | null>(null);
    const { showToast } = useToast();

    const handleCredentials = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!username.trim() || !password) { setError('Please enter username and password'); return; }
        setLoading(true); setError('');
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username.trim(), password }),
            });
            const data = await res.json();
            if (!res.ok) { setError(data.error); setLoading(false); return; }
            setPending(data);
            setStep(data.requires2FA ? '2fa' : 'no2fa-warning');
        } catch { setError('Connection error. Try again.'); }
        setLoading(false);
    };

    const handle2FA = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!totpCode || totpCode.length !== 6) { setError('Enter a 6-digit code'); return; }
        setLoading(true); setError('');
        try {
            const res = await fetch('/api/auth/2fa-verify', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: pending!.username, code: totpCode }),
            });
            const data = await res.json();
            if (!res.ok) { setError(data.error); setLoading(false); return; }
            await onLogin(data.username, data.role, data.tags);
            showToast('success', `Welcome back, ${data.displayName || data.username}`);
        } catch { setError('Connection error. Try again.'); }
        setLoading(false);
    };

    const proceedWithoutMFA = async () => {
        if (!pending) return;
        await onLogin(pending.username, pending.role, pending.tags);
        showToast('success', `Welcome back, ${pending.displayName || pending.username}`);
    };

    return (
        <div className="login-page">
            {/* ── Left branding panel ── */}
            <aside className="login-aside">
                <div className="login-aside__brand">
                    <div className="login-aside__logo">
                        <span className="login-aside__logo-text">MS</span>
                    </div>
                    <div>
                        <div className="login-aside__name">Med-SEAL</div>
                        <div className="login-aside__tag">Enterprise Access Layer</div>
                    </div>
                </div>
                <div className="login-aside__headline">
                    <h1>Secure access to your <strong>clinical suite</strong></h1>
                    <p>Single sign-on for OpenEMR, Medplum FHIR, and AI services. One identity, every application.</p>
                </div>
                <div className="login-aside__features">
                    <div className="login-feature">
                        <div className="login-feature__icon"><Locked size={16} /></div>
                        Access only what your role requires
                    </div>
                    <div className="login-feature">
                        <div className="login-feature__icon"><MobileCheck size={16} /></div>
                        Extra protection with authenticator app
                    </div>
                    <div className="login-feature">
                        <div className="login-feature__icon"><Encryption size={16} /></div>
                        Secure encrypted sessions
                    </div>
                    <div className="login-feature">
                        <div className="login-feature__icon"><CheckmarkFilled size={16} /></div>
                        Every action recorded for compliance
                    </div>
                </div>
            </aside>

            {/* ── Right form panel ── */}
            <main className="login-main">
                {/* Mobile-only brand (visible when aside is hidden) */}
                <div className="login-mobile-brand">
                    <div className="login-aside__logo">
                        <span className="login-aside__logo-text">MS</span>
                    </div>
                    <span className="login-mobile-brand__name">Med-SEAL</span>
                </div>

                <div className="login-card animate-in">
                    {/* Step 1: Credentials */}
                    {step === 'credentials' && (
                        <>
                            <div className="login-card__header">
                                <h2>Sign in</h2>
                                <p>Enter your credentials to continue</p>
                            </div>
                            <form onSubmit={handleCredentials} className="login-card__form">
                                <TextInput
                                    id="username" labelText="Username *"
                                    placeholder="Enter your username"
                                    value={username} onChange={e => setUsername(e.target.value)}
                                    autoComplete="username" autoFocus
                                    required aria-required="true"
                                />
                                <PasswordInput
                                    id="password" labelText="Password *"
                                    placeholder="Enter your password"
                                    value={password} onChange={e => setPassword(e.target.value)}
                                    autoComplete="current-password"
                                    required aria-required="true"
                                />

                                <div className="login-card__forgot">
                                    <button type="button" className="login-forgot-link" onClick={() => showToast('info', 'Contact your administrator to reset your password')}>
                                        Forgot password?
                                    </button>
                                </div>

                                {error && (
                                    <InlineNotification
                                        kind="error" title="Error" subtitle={error}
                                        lowContrast hideCloseButton
                                        className="login-error"
                                    />
                                )}

                                <div className="login-card__actions">
                                    {loading ? (
                                        <InlineLoading description="Signing in..." />
                                    ) : (
                                        <Button type="submit" renderIcon={ArrowRight} size="lg" className="login-cta">
                                            Sign in
                                        </Button>
                                    )}
                                </div>
                            </form>
                            <div className="login-card__footer">
                                Secured by Med-SEAL SSO · v2.0
                            </div>
                        </>
                    )}

                    {/* Step 2: 2FA */}
                    {step === '2fa' && (
                        <>
                            <div className="twofa-header">
                                <div className="twofa-icon-wrap"><MobileCheck size={28} /></div>
                                <h3>Two-Factor Authentication</h3>
                                <p>Enter the 6-digit code from your authenticator app</p>
                            </div>
                            <form onSubmit={handle2FA} className="login-card__form">
                                <div className="totp-field">
                                    <TextInput
                                        id="totp-code" labelText="Verification code *"
                                        placeholder="000000" maxLength={6}
                                        value={totpCode}
                                        onChange={e => setTotpCode((e.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6))}
                                        autoFocus autoComplete="one-time-code"
                                        required aria-required="true"
                                    />
                                </div>
                                {error && (
                                    <InlineNotification
                                        kind="error" title="Error" subtitle={error}
                                        lowContrast hideCloseButton
                                        className="login-error"
                                    />
                                )}
                                <div className="login-card__actions">
                                    {loading ? (
                                        <InlineLoading description="Verifying..." />
                                    ) : (
                                        <Button type="submit" renderIcon={ArrowRight} size="lg" className="login-cta">
                                            Verify &amp; Sign in
                                        </Button>
                                    )}
                                    <Button kind="ghost" size="lg" className="login-cta" onClick={() => { setStep('credentials'); setError(''); setTotpCode(''); }}>
                                        Back to login
                                    </Button>
                                </div>
                            </form>
                        </>
                    )}

                    {/* Step 3: No-2FA Warning */}
                    {step === 'no2fa-warning' && (
                        <>
                            <div className="no2fa-warning">
                                <WarningAlt size={28} />
                                <h3>2FA Not Enabled</h3>
                                <p>Your account does not have two-factor authentication enabled. We strongly recommend enabling it in your <strong>Profile &amp; Security</strong> settings.</p>
                            </div>
                            <Button onClick={proceedWithoutMFA} renderIcon={ArrowRight} size="lg" className="login-cta">
                                Continue to Dashboard
                            </Button>
                        </>
                    )}
                </div>
            </main>
        </div>
    );
}
