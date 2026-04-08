import { useState, useCallback, useEffect, useRef } from 'react';
import { Modal, TextInput, Button } from '@carbon/react';

interface Props {
    open: boolean;
    onVerified: () => void;
    onCancel: () => void;
}

export default function CaptchaModal({ open, onVerified, onCancel }: Props) {
    const [code, setCode] = useState('');
    const [input, setInput] = useState('');
    const [error, setError] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const generateCode = useCallback(() => {
        let c = '';
        for (let i = 0; i < 6; i++) c += Math.floor(Math.random() * 10);
        return c;
    }, []);

    useEffect(() => {
        if (open) {
            setCode(generateCode());
            setInput('');
            setError(false);
            setTimeout(() => inputRef.current?.focus(), 200);
        }
    }, [open, generateCode]);

    const refresh = () => { setCode(generateCode()); setInput(''); setError(false); };

    const verify = () => {
        if (input === code) onVerified();
        else { setError(true); setInput(''); inputRef.current?.focus(); }
    };

    return (
        <Modal
            open={open}
            modalHeading="Security Verification"
            primaryButtonText="Verify"
            secondaryButtonText="Cancel"
            onRequestSubmit={verify}
            onRequestClose={onCancel}
            size="xs"
        >
            <p style={{ fontSize: '0.8125rem', color: 'var(--cds-text-secondary)', marginBottom: '1rem' }}>
                Type the code below to confirm you are human
            </p>
            <div className="captcha-display">
                {code.split('').map((ch, i) => (
                    <span key={i} className="captcha-char">{ch}</span>
                ))}
            </div>
            <TextInput
                ref={inputRef as any}
                id="captcha-input"
                labelText="Verification code"
                placeholder="Enter 6-digit code"
                value={input}
                maxLength={6}
                invalid={error}
                invalidText="Code does not match. Try again."
                onChange={e => { setInput((e.target as HTMLInputElement).value.replace(/\D/g, '')); setError(false); }}
                onKeyDown={e => { if (e.key === 'Enter') verify(); }}
            />
            <Button kind="ghost" size="sm" onClick={refresh} style={{ marginTop: '0.5rem' }}>
                New code
            </Button>
        </Modal>
    );
}
