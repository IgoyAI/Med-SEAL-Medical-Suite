import { useState } from 'react';
import {
  TextInput,
  PasswordInput,
  Button,
  InlineLoading,
  InlineNotification,
} from '@carbon/react';
import {
  Security,
  Locked,
  CheckmarkFilled,
  MobileCheck,
  Encryption,
  WarningAlt,
} from '@carbon/icons-react';

interface Props {
  onLogin: (username: string, role: string, tags: string[]) => void;
}

export default function LoginPage({ onLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [step, setStep] = useState<'credentials' | '2fa' | 'no2fa-warning'>('credentials');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<any>(null);

  const handleCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Please enter username and password');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error);
        setLoading(false);
        return;
      }
      setPending(data);
      setStep(data.requires2FA ? '2fa' : 'no2fa-warning');
    } catch {
      setError('Connection error. Try again.');
    }
    setLoading(false);
  };

  const handle2FA = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!totpCode || totpCode.length !== 6) {
      setError('Enter a 6-digit code');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/2fa-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: pending.username, code: totpCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error);
        setLoading(false);
        return;
      }
      onLogin(data.username, data.role, data.tags);
    } catch {
      setError('Connection error. Try again.');
    }
    setLoading(false);
  };

  const proceedWithoutMFA = () => {
    if (pending) onLogin(pending.username, pending.role, pending.tags);
  };

  return (
    <div className="login-page">
      <aside className="login-aside">
        <div className="login-aside__brand">
          <div className="login-aside__logo">
            <Security size={24} />
          </div>
          <div>
            <div className="login-aside__name">Med-SEAL</div>
            <div className="login-aside__tag">Clinical Decision Support</div>
          </div>
        </div>
        <div className="login-aside__headline">
          <h1>
            <strong>Smarter clinical decisions,</strong> backed by evidence
          </h1>
          <p>
            Ask clinical questions about your patients and get answers
            grounded in their medical records and the latest medical literature.
          </p>
        </div>
        <div className="login-aside__features">
          <div className="login-feature">
            <div className="login-feature__icon"><CheckmarkFilled size={16} /></div>
            Patient-aware — reads conditions, medications, labs &amp; vitals
          </div>
          <div className="login-feature">
            <div className="login-feature__icon"><Encryption size={16} /></div>
            Journal-cited — references from PubMed &amp; medical literature
          </div>
          <div className="login-feature">
            <div className="login-feature__icon"><MobileCheck size={16} /></div>
            Audit-ready — every conversation is logged and traceable
          </div>
        </div>
      </aside>

      <main className="login-main">
        <div className="login-card animate-in">
          {step === 'credentials' && (
            <>
              <div className="login-card__header">
                <h2>Sign in to CDSS</h2>
                <p>Enter your Med-SEAL credentials to continue</p>
              </div>
              <form onSubmit={handleCredentials} className="login-card__form">
                <TextInput
                  id="login-username"
                  labelText="Username"
                  placeholder="Enter your username"
                  value={username}
                  onChange={(e: any) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
                />
                <PasswordInput
                  id="login-password"
                  labelText="Password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e: any) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
                {error && (
                  <InlineNotification
                    kind="error"
                    title="Error"
                    subtitle={error}
                    lowContrast
                    hideCloseButton
                  />
                )}
                <div className="login-card__actions">
                  {loading ? (
                    <InlineLoading description="Authenticating..." />
                  ) : (
                    <Button type="submit" renderIcon={Locked} size="lg">
                      Sign In
                    </Button>
                  )}
                </div>
              </form>
              <div className="login-card__footer">
                Secured by Med-SEAL SSO
              </div>
            </>
          )}

          {step === '2fa' && (
            <>
              <div className="twofa-header">
                <div className="twofa-icon-wrap">
                  <MobileCheck size={28} />
                </div>
                <h3>Two-Factor Authentication</h3>
                <p>Enter the 6-digit code from your authenticator app</p>
              </div>
              <form onSubmit={handle2FA} className="login-card__form">
                <div className="totp-field">
                  <TextInput
                    id="totp-code"
                    labelText="Verification Code"
                    placeholder="000000"
                    value={totpCode}
                    onChange={(e: any) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    maxLength={6}
                    autoFocus
                  />
                </div>
                {error && (
                  <InlineNotification kind="error" title="Error" subtitle={error} lowContrast hideCloseButton />
                )}
                <div className="login-card__actions">
                  {loading ? (
                    <InlineLoading description="Verifying..." />
                  ) : (
                    <>
                      <Button type="submit" renderIcon={CheckmarkFilled} size="lg">
                        Verify &amp; Sign In
                      </Button>
                      <Button kind="ghost" size="lg" onClick={() => { setStep('credentials'); setError(''); setTotpCode(''); }}>
                        &larr; Back to login
                      </Button>
                    </>
                  )}
                </div>
              </form>
            </>
          )}

          {step === 'no2fa-warning' && (
            <>
              <div className="no2fa-warning">
                <WarningAlt size={32} />
                <h3>2FA Not Enabled</h3>
                <p>
                  Your account does not have two-factor authentication enabled.
                  For security, we recommend enabling it in your profile settings.
                </p>
              </div>
              <Button kind="primary" size="lg" onClick={proceedWithoutMFA} style={{ width: '100%' }}>
                Continue to CDSS &rarr;
              </Button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
