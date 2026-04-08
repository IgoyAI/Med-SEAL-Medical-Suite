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

export default function LoginPage({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [step, setStep] = useState('credentials'); // 'credentials' | '2fa' | 'no2fa-warning'
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null);

  const handleCredentials = async (e) => {
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
      if (data.requires2FA) {
        setStep('2fa');
      } else {
        setStep('no2fa-warning');
      }
    } catch {
      setError('Connection error. Try again.');
    }
    setLoading(false);
  };

  const handle2FA = async (e) => {
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
      await onLogin(data.username, data.role, data.tags);
    } catch {
      setError('Connection error. Try again.');
    }
    setLoading(false);
  };

  const proceedWithoutMFA = async () => {
    if (!pending) return;
    await onLogin(pending.username, pending.role, pending.tags);
  };

  return (
    <div className="login-page">
      {/* ── Left panel ── */}
      <aside className="login-aside">
        <div className="login-aside__brand">
          <div className="login-aside__logo">
            <Security size={24} />
          </div>
          <div>
            <div className="login-aside__name">Med-SEAL</div>
            <div className="login-aside__tag">Single Sign-On V2</div>
          </div>
        </div>

        <div className="login-aside__headline">
          <h1>
            <strong>One login</strong> for your entire clinical platform
          </h1>
          <p>
            Access patient records, medical imaging, clinical decision support,
            and all Med-SEAL services from a single secure sign-in.
          </p>
        </div>

        <div className="login-aside__features">
          <div className="login-feature">
            <div className="login-feature__icon"><CheckmarkFilled size={16} /></div>
            Electronic Medical Records &amp; patient management
          </div>
          <div className="login-feature">
            <div className="login-feature__icon"><Encryption size={16} /></div>
            Medical imaging &amp; radiology viewing
          </div>
          <div className="login-feature">
            <div className="login-feature__icon"><MobileCheck size={16} /></div>
            AI-powered clinical decision support
          </div>
        </div>
      </aside>

      {/* ── Login form ── */}
      <main className="login-main">
        <div className="login-card animate-in">
          {/* Step 1: Credentials */}
          {step === 'credentials' && (
            <>
              <div className="login-card__header">
                <h2>Sign in</h2>
                <p>Enter your Med-SEAL credentials to continue</p>
              </div>

              <form onSubmit={handleCredentials} className="login-card__form">
                <TextInput
                  id="login-username"
                  labelText="Username"
                  placeholder="Enter your username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
                />
                <PasswordInput
                  id="login-password"
                  labelText="Password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
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

          {/* Step 2: 2FA */}
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
                    onChange={(e) =>
                      setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                    }
                    maxLength={6}
                    autoFocus
                    required
                  />
                </div>

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
                    <InlineLoading description="Verifying..." />
                  ) : (
                    <>
                      <Button type="submit" renderIcon={CheckmarkFilled} size="lg">
                        Verify &amp; Sign In
                      </Button>
                      <Button
                        kind="ghost"
                        size="lg"
                        onClick={() => {
                          setStep('credentials');
                          setError('');
                          setTotpCode('');
                        }}
                      >
                        ← Back to login
                      </Button>
                    </>
                  )}
                </div>
              </form>
            </>
          )}

          {/* No 2FA Warning */}
          {step === 'no2fa-warning' && (
            <>
              <div className="no2fa-warning">
                <WarningAlt size={32} />
                <h3>2FA Not Enabled</h3>
                <p>
                  Your account does not have two-factor authentication enabled.
                  For security, we strongly recommend enabling it in your{' '}
                  <strong>Profile &amp; Security</strong> settings.
                </p>
              </div>

              <Button
                kind="primary"
                size="lg"
                onClick={proceedWithoutMFA}
                style={{ width: '100%' }}
              >
                Continue to Dashboard →
              </Button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
