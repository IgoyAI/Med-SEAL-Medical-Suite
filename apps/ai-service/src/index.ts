// ===== Med-SEAL AI Service =====
// Express server bridging FHIR patient data with user's LLM API.
// Provides 4 AI agent endpoints: Chat, Radiology, CDS, Ambient.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { callLLM, streamLLM, getLLMConfig, ChatMessage } from './llm';
import { SYSTEM_PROMPTS, buildClinicalContext, buildRadiologyContext } from './prompts';
import { initOpenEMRPool, syncUserToOpenEMR, deleteOpenEMRUser, syncOnLogin, listFacilities, syncAppointmentsToFHIR, writeAppointmentToOpenEMR } from './openemr-db';

// Convert Node bcrypt ($2b$) hash to PHP-compatible ($2y$) for OpenEMR
const toPhpBcrypt = (hash: string) => hash.replace(/^\$2b\$/, '$2y$');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = parseInt(process.env.PORT || '4003');

// ===== Health Check =====
app.get('/health', (_, res) => {
    const config = getLLMConfig();
    res.json({
        status: 'ok',
        service: 'med-seal-ai',
        llm: { url: config.apiUrl, model: config.model },
        agents: ['clinical-chat', 'radiology-report', 'cds-alerts', 'ambient-summary'],
    });
});

app.get('/api/system-status', async (req, res) => {
    const check = async (url: string) => {
        try {
            await fetch(url, { signal: AbortSignal.timeout(1500) });
            return 'up';
        } catch {
            return 'down';
        }
    };

    const medplumBase = process.env.MEDPLUM_BASE_URL || 'http://medplum-server:8103';
    const langfuseUrl = process.env.LANGFUSE_URL || 'http://172.18.0.1:3100';
    const [openemr, medplum, langfuse] = await Promise.all([
        check('http://openemr:80/interface/login/login.php'),
        check(`${medplumBase}/healthcheck`),
        check(`${langfuseUrl}/api/public/health`),
    ]);

    res.json({ openemr, medplum, langfuse });
});

// ===========================================================
// AGENT 1: Clinical AI Assistant (Chat)
// ===========================================================
app.post('/chat', async (req, res) => {
    try {
        const { patient, message, history = [] } = req.body;

        if (!patient || !message) {
            return res.status(400).json({ error: 'patient and message are required' });
        }

        const context = buildClinicalContext(patient);

        const messages: ChatMessage[] = [
            { role: 'system', content: SYSTEM_PROMPTS.clinicalAssistant },
            { role: 'user', content: `Here is the patient's clinical data:\n\n${context}` },
            { role: 'assistant', content: 'I have reviewed the patient\'s clinical data. I\'m ready to assist with clinical questions about this patient.' },
            ...history.map((h: any) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
            { role: 'user', content: message },
        ];

        const response = await callLLM(messages);
        res.json({ response, agent: 'clinical-chat' });
    } catch (error: any) {
        console.error('[Chat] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Streaming version
app.post('/chat/stream', async (req, res) => {
    try {
        const { patient, message, history = [] } = req.body;
        if (!patient || !message) {
            return res.status(400).json({ error: 'patient and message are required' });
        }

        const context = buildClinicalContext(patient);
        const messages: ChatMessage[] = [
            { role: 'system', content: SYSTEM_PROMPTS.clinicalAssistant },
            { role: 'user', content: `Here is the patient\'s clinical data:\n\n${context}` },
            { role: 'assistant', content: 'I have reviewed the patient\'s clinical data. Ready to assist.' },
            ...history.map((h: any) => ({ role: h.role, content: h.content })),
            { role: 'user', content: message },
        ];

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        await streamLLM(messages, (text) => {
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
        });

        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// ===========================================================
// AGENT 2: Radiology AI Report Generator
// ===========================================================
app.post('/radiology/report', async (req, res) => {
    try {
        const { study, clinicalIndication } = req.body;

        if (!study) {
            return res.status(400).json({ error: 'study data is required' });
        }

        const context = buildRadiologyContext(study);

        const messages: ChatMessage[] = [
            { role: 'system', content: SYSTEM_PROMPTS.radiologyReport },
            {
                role: 'user',
                content: `Generate a structured radiology report for this study:\n\n${context}\n\nClinical Indication: ${clinicalIndication || 'Not provided'}\n\nPlease generate a complete, structured radiology report.`,
            },
        ];

        const report = await callLLM(messages, { temperature: 0.2 });
        res.json({ report, agent: 'radiology-report' });
    } catch (error: any) {
        console.error('[Radiology] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ===========================================================
// AGENT 3: Clinical Decision Support (CDS Alerts)
// ===========================================================
app.post('/cds/alerts', async (req, res) => {
    try {
        const { patient } = req.body;

        if (!patient) {
            return res.status(400).json({ error: 'patient data is required' });
        }

        const context = buildClinicalContext(patient);

        const messages: ChatMessage[] = [
            { role: 'system', content: SYSTEM_PROMPTS.clinicalDecisionSupport },
            {
                role: 'user',
                content: `Analyze this patient's data and generate Clinical Decision Support alerts. Return as a JSON array of alert objects.\n\n${context}\n\nRespond with ONLY a JSON array of alerts, each with: category, title, description, recommendation, evidence.`,
            },
        ];

        const raw = await callLLM(messages, { temperature: 0.1 });

        // Parse JSON from LLM response
        let alerts: any[] = [];
        try {
            // Try to extract JSON array from response
            const jsonMatch = raw.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                alerts = JSON.parse(jsonMatch[0]);
            }
        } catch {
            // If parsing fails, create a single alert from the raw text
            alerts = [{
                category: 'INFO',
                title: 'AI Analysis',
                description: raw.slice(0, 500),
                recommendation: 'Review the full AI analysis',
                evidence: 'AI-generated analysis',
            }];
        }

        res.json({ alerts, agent: 'cds-alerts' });
    } catch (error: any) {
        console.error('[CDS] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ===========================================================
// AGENT 4: Ambient Clinical Intelligence
// ===========================================================
app.post('/ambient/summary', async (req, res) => {
    try {
        const { patient, type = 'visit' } = req.body;

        if (!patient) {
            return res.status(400).json({ error: 'patient data is required' });
        }

        const context = buildClinicalContext(patient);

        const typePrompts: Record<string, string> = {
            visit: 'Generate a SOAP-format visit summary for this patient based on their most recent encounter and current clinical data.',
            discharge: 'Generate a discharge summary for this patient including medication reconciliation and follow-up plan.',
            referral: 'Generate a referral letter for this patient including relevant clinical history and reason for referral.',
            timeline: 'Generate a chronological clinical timeline for this patient, highlighting key events and trends.',
        };

        const messages: ChatMessage[] = [
            { role: 'system', content: SYSTEM_PROMPTS.ambientIntelligence },
            {
                role: 'user',
                content: `${typePrompts[type] || typePrompts.visit}\n\n${context}`,
            },
        ];

        const summary = await callLLM(messages, { temperature: 0.2, maxTokens: 3000 });
        res.json({ summary, type, agent: 'ambient-summary' });
    } catch (error: any) {
        console.error('[Ambient] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ===========================================================
// Audit Log (PostgreSQL-backed)
// ===========================================================
import * as db from './db';

const getIp = (req: any) => (req.headers['x-forwarded-for'] as string || req.ip || 'unknown');

// ===========================================================
// Authentication
// ===========================================================

// POST /api/auth/login — verify username + password, check 2FA
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

        const user = await db.getUser(username);
        if (!user) return res.status(401).json({ error: 'Invalid username or password' });

        // Check lockout
        if (db.isLocked(user)) {
            return res.status(423).json({ error: 'Account is locked. Please contact an administrator.' });
        }

        // Verify password
        const valid = await db.verifyPassword(user, password);
        if (!valid) {
            const result = await db.recordFailedLogin(username);
            if (result.locked) {
                await db.addAuditEntry('security', username, 'Account locked after failed attempts', getIp(req));
                return res.status(423).json({ error: 'Account locked after too many failed attempts. Try again in 15 minutes.' });
            }
            return res.status(401).json({ error: `Invalid username or password. ${result.attemptsLeft} attempt(s) remaining.` });
        }

        // Password is correct — check if 2FA is required
        if (user.two_fa_enabled) {
            // Generate a 2-digit challenge number for number-matching display
            const challengeNumber = Math.floor(10 + Math.random() * 90); // 10-99
            // Don't reset login attempts yet — wait for 2FA
            return res.json({
                ok: true, requires2FA: true,
                challengeNumber,
                username: user.username, displayName: user.display_name,
                role: user.role, tags: user.tags || [],
            });
        }

        // No 2FA — login success
        await db.resetLoginAttempts(username);
        await db.addAuditEntry('login', username, 'SSO sign-in', getIp(req));

        // Sync user to OpenEMR on every login
        syncOnLogin(username, user.display_name, user.email, toPhpBcrypt(user.password_hash), user.role, user.facility_id)
            .catch(e => console.error('[OpenEMR-Sync] login sync error:', e.message));

        res.json({
            ok: true, requires2FA: false, twoFAEnabled: false,
            username: user.username, displayName: user.display_name,
            role: user.role, tags: user.tags || [],
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/auth/2fa-verify — validate TOTP code during login
app.post('/api/auth/2fa-verify', async (req, res) => {
    try {
        const { username, code } = req.body;
        if (!username || !code || code.length !== 6) {
            return res.status(400).json({ error: 'Username and a 6-digit code are required' });
        }
        const user = await db.getUser(username);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!user.two_fa_enabled || !user.two_fa_secret) {
            return res.status(400).json({ error: '2FA is not enabled for this user' });
        }

        // TOTP verification — demo accepts any 6-digit code
        // In production, verify against the TOTP secret using a library like otplib
        const isValid = /^\d{6}$/.test(code); // Accept any 6-digit code for demo
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid verification code' });
        }

        // 2FA passed — complete login
        await db.resetLoginAttempts(username);
        await db.addAuditEntry('login', username, 'SSO sign-in (2FA verified)', getIp(req));

        // Sync user to OpenEMR on every login (2FA path)
        syncOnLogin(username, user.display_name, user.email, toPhpBcrypt(user.password_hash), user.role, user.facility_id)
            .catch(e => console.error('[OpenEMR-Sync] 2fa login sync error:', e.message));

        res.json({
            ok: true,
            username: user.username, displayName: user.display_name,
            role: user.role, tags: user.tags || [],
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/audit — log an event
app.post('/api/audit', async (req, res) => {
    try {
        const { type, user, detail } = req.body;
        if (!type || !user) return res.status(400).json({ error: 'type and user are required' });
        const entry = await db.addAuditEntry(type, user, detail || '', getIp(req));
        res.json({ ok: true, entry });
    } catch (error: any) {
        console.error('[Audit] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/audit — retrieve events (returns array)
app.get('/api/audit', async (_, res) => {
    try {
        const entries = await db.getAuditLog();
        // Map to frontend-expected format
        res.json(entries.map(e => ({
            id: e.id, type: e.event_type, user: e.username,
            detail: e.detail, time: e.created_at, ip: e.ip_address,
        })));
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// ===========================================================
// SSO Auto-Login (Service Launch Relay)
// ===========================================================
interface SSOTarget {
    loginUrl: string;
    formAction: string;
    fields: Record<string, string>;
}

function getSSOTargets(username: string, password: string): Record<string, SSOTarget> {
    const openemrHost = process.env.OPENEMR_EXTERNAL_URL || 'http://localhost:8081';
    return {
        openemr: {
            loginUrl: openemrHost,
            formAction: `${openemrHost}/interface/main/main_screen.php?auth=login&site=default`,
            fields: {
                new_login_session_management: '1',
                languageChoice: '1',
                authUser: username,
                clearPass: password,
            },
        },
    };
}

// GET /api/sso/launch/:service
app.get('/api/sso/launch/:service', async (req, res) => {
    const { service } = req.params;
    const username = req.query.u as string || 'admin';

    // CDSS uses client-side session — redirect with auth params in hash
    if (service === 'cdss') {
        const user = await db.getUser(username);
        if (!user) return res.status(404).send('User not found');
        await db.addAuditEntry('sso-launch', username, 'SSO auto-login to cdss', getIp(req));
        const cdssHost = process.env.CDSS_EXTERNAL_URL || 'https://cdss.med-seal.org';
        const params = new URLSearchParams({
            u: user.username,
            r: user.role,
            t: (user.tags || []).join(','),
        });
        return res.redirect(`${cdssHost}/#/sso?${params.toString()}`);
    }

    const ssoTargets = getSSOTargets(username, 'pass');
    const target = ssoTargets[service];

    if (!target) {
        return res.status(404).send(`<html><body><h2>Service "${service}" does not support SSO auto-login.</h2><p><a href="javascript:window.close()">Close</a></p></body></html>`);
    }

    await db.addAuditEntry('sso-launch', username, `SSO auto-login to ${service}`, getIp(req));

    const hiddenFields = Object.entries(target.fields)
        .map(([k, v]) => `<input type="hidden" name="${k}" value="${v}"/>`)
        .join('\n            ');

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html>
<head>
    <title>Med-SEAL SSO — Signing in to ${service}…</title>
    <style>
        body { font-family: 'Inter', system-ui, sans-serif; background: #f4f3f0;
               display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { text-align: center; padding: 40px; background: #fff; border-radius: 12px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.06); border: 1px solid #e4e2dd; }
        .spinner { width: 32px; height: 32px; border: 3px solid #e4e2dd;
                   border-top-color: #4a6fa5; border-radius: 50%; animation: spin 0.8s linear infinite;
                   margin: 0 auto 16px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        h2 { font-size: 16px; color: #2c2c2a; margin: 0 0 4px; }
        p { font-size: 13px; color: #8a8a84; margin: 0; }
    </style>
</head>
<body>
    <div class="card">
        <div class="spinner"></div>
        <h2>Signing in to ${service}…</h2>
        <p>Please wait, you are being authenticated via Med-SEAL SSO.</p>
    </div>
    <form id="sso" method="POST" action="${target.formAction}" style="display:none">
        ${hiddenFields}
    </form>
    <script>document.getElementById('sso').submit();</script>
</body>
</html>`);
});

// ===========================================================
// Facilities List (from OpenEMR MySQL)
// ===========================================================
app.get('/api/facilities', async (_, res) => {
    try {
        const facilities = await listFacilities();
        res.json(facilities);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// ===========================================================
// User Profile Endpoints (PostgreSQL-backed)
// ===========================================================

// GET /api/users/:username — get own profile
app.get('/api/users/:username', async (req, res) => {
    try {
        let user = await db.getUser(req.params.username);
        if (!user) {
            // Auto-create on first access (backward compat)
            user = await db.createUser(
                req.params.username,
                req.params.username.charAt(0).toUpperCase() + req.params.username.slice(1),
                `${req.params.username}@medseal.local`,
                'pass'
            );
        }
        res.json({
            username: user.username,
            displayName: user.display_name,
            email: user.email,
            role: user.role,
            tags: user.tags || [],
            twoFAEnabled: user.two_fa_enabled,
            createdAt: user.created_at,
            updatedAt: user.updated_at,
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/users/:username — update own profile
app.put('/api/users/:username', async (req, res) => {
    try {
        const user = await db.getUser(req.params.username);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const { displayName, email } = req.body;
        const updated = await db.updateUser(user.id, {
            display_name: displayName || undefined,
            email: email || undefined,
        });
        res.json({ ok: true, user: { displayName: updated?.display_name, email: updated?.email } });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/users/:username/password — change password
app.put('/api/users/:username/password', async (req, res) => {
    try {
        const user = await db.getUser(req.params.username);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'currentPassword and newPassword are required' });
        }
        const valid = await db.verifyPassword(user, currentPassword);
        if (!valid) return res.status(403).json({ error: 'Current password is incorrect' });
        if (newPassword.length < 4) {
            return res.status(400).json({ error: 'Password must be at least 4 characters' });
        }
        await db.setPassword(user.id, newPassword);
        await db.addAuditEntry('security', req.params.username, 'Password changed', getIp(req));
        res.json({ ok: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/users/:username/2fa/setup
app.post('/api/users/:username/2fa/setup', async (req, res) => {
    try {
        const user = await db.getUser(req.params.username);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let secret = '';
        for (let i = 0; i < 24; i++) {
            secret += chars[Math.floor(Math.random() * chars.length)];
            if ((i + 1) % 4 === 0 && i < 23) secret += ' ';
        }
        await db.set2FASecret(user.id, secret.replace(/ /g, ''));
        res.json({
            secret, issuer: 'Med-SEAL', account: user.email,
            otpauthUrl: `otpauth://totp/Med-SEAL:${user.email}?secret=${secret.replace(/ /g, '')}&issuer=Med-SEAL`,
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/users/:username/2fa/verify
app.post('/api/users/:username/2fa/verify', async (req, res) => {
    try {
        const { code } = req.body;
        if (!code || code.length !== 6) return res.status(400).json({ error: 'A 6-digit code is required' });
        const user = await db.getUser(req.params.username);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!user.two_fa_secret) return res.status(400).json({ error: '2FA setup not initiated' });
        // Demo: accept any 6-digit code
        await db.enable2FA(user.id);
        await db.addAuditEntry('security', req.params.username, '2FA enabled', getIp(req));
        res.json({ ok: true, twoFAEnabled: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/users/:username/2fa
app.delete('/api/users/:username/2fa', async (req, res) => {
    try {
        const user = await db.getUser(req.params.username);
        if (!user) return res.status(404).json({ error: 'User not found' });
        await db.disable2FA(user.id);
        await db.addAuditEntry('security', req.params.username, '2FA disabled', getIp(req));
        res.json({ ok: true, twoFAEnabled: false });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// ===========================================================
// Admin User Management (CRUD + Lock/Unlock + Reset)
// ===========================================================

// GET /api/admin/users — list all users
app.get('/api/admin/users', async (_, res) => {
    try {
        const users = await db.listUsers();
        res.json(users.map(u => ({
            id: u.id, username: u.username, displayName: u.display_name,
            email: u.email, role: u.role, status: u.status,
            tags: u.tags || [],
            facilityId: u.facility_id || 0,
            twoFAEnabled: u.two_fa_enabled,
            failedAttempts: u.failed_login_attempts,
            lastLogin: u.last_login, createdAt: u.created_at, updatedAt: u.updated_at,
        })));
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/admin/users — create user
app.post('/api/admin/users', async (req, res) => {
    try {
        const { username, displayName, email, password, role, tags, facilityId } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
        if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
        const existing = await db.getUser(username);
        if (existing) return res.status(409).json({ error: 'Username already exists' });
        const user = await db.createUser(username, displayName || username, email || `${username}@medseal.local`, password, role || 'user', facilityId || 0);
        // Save tags if provided
        if (tags && Array.isArray(tags)) {
            await db.updateUser(user.id, { tags });
        }
        await db.addAuditEntry('admin', req.body.adminUser || 'admin', `Created user: ${username}`, getIp(req));

        // Sync new user to OpenEMR
        syncUserToOpenEMR(username, displayName || username, email || `${username}@medseal.local`, toPhpBcrypt(user.password_hash), role || 'user', 'active', facilityId || 0)
            .catch(e => console.error('[OpenEMR-Sync] create sync error:', e.message));

        res.json({ ok: true, user: { id: user.id, username: user.username } });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/admin/users/:id — edit user
app.put('/api/admin/users/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { displayName, email, role, status, tags, facilityId } = req.body;
        const updated = await db.updateUser(id, {
            display_name: displayName, email, role, status, tags,
            facility_id: facilityId !== undefined ? facilityId : undefined,
        });
        if (!updated) return res.status(404).json({ error: 'User not found' });
        await db.addAuditEntry('admin', req.body.adminUser || 'admin', `Updated user #${id}: ${updated.username}`, getIp(req));

        // Sync updated user to OpenEMR
        syncUserToOpenEMR(
            updated.username, updated.display_name, updated.email,
            toPhpBcrypt(updated.password_hash), updated.role, updated.status,
            updated.facility_id || 0
        ).catch(e => console.error('[OpenEMR-Sync] update sync error:', e.message));

        res.json({ ok: true, user: updated });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/admin/users/:id — delete user
app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const user = await db.getUserById(id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.username === 'admin') return res.status(403).json({ error: 'Cannot delete the primary admin account' });
        await db.deleteUser(id);
        await db.addAuditEntry('admin', 'admin', `Deleted user: ${user.username}`, getIp(req));

        // Remove user from OpenEMR
        deleteOpenEMRUser(user.username)
            .catch(e => console.error('[OpenEMR-Sync] delete sync error:', e.message));

        res.json({ ok: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/admin/sync-openemr — sync all SSO users to OpenEMR
app.post('/api/admin/sync-openemr', async (req, res) => {
    try {
        const users = await db.listUsers();
        let synced = 0;
        const errors: string[] = [];
        for (const u of users) {
            try {
                await syncUserToOpenEMR(
                    u.username, u.display_name, u.email,
                    toPhpBcrypt(u.password_hash), u.role, u.status,
                    u.facility_id || 0
                );
                synced++;
            } catch (e: any) {
                errors.push(`${u.username}: ${e.message}`);
            }
        }
        await db.addAuditEntry('admin', 'admin', `Bulk sync to OpenEMR: ${synced}/${users.length} users`, getIp(req));
        res.json({ ok: true, synced, total: users.length, errors });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/appointments/writeback — write a FHIR appointment back to OpenEMR calendar (real-time)
app.post('/api/appointments/writeback', async (req, res) => {
    try {
        const { fhirAppointmentId, patientName, practitionerName, start, end, status, serviceType, description } = req.body;
        if (!fhirAppointmentId || !start) {
            return res.status(400).json({ error: 'fhirAppointmentId and start are required' });
        }
        const result = await writeAppointmentToOpenEMR({
            fhirAppointmentId,
            patientName: patientName || 'Unknown',
            practitionerName: practitionerName || 'Unknown',
            start,
            end,
            status: status || 'booked',
            serviceType,
            description,
        });
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/sync-appointments — sync OpenEMR appointments to Medplum FHIR
app.post('/api/admin/sync-appointments', async (req, res) => {
    try {
        const medplumBase = process.env.MEDPLUM_BASE_URL || 'http://medplum-server:8103';

        // Authenticate with Medplum
        const cv = 'sync-appt-' + Date.now();
        const loginRes = await fetch(`${medplumBase}/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'admin@example.com', password: 'medplum_admin',
                scope: 'openid fhirUser', codeChallengeMethod: 'plain', codeChallenge: cv
            }),
        });
        const { code } = await loginRes.json() as any;
        const tokRes = await fetch(`${medplumBase}/oauth2/token`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=authorization_code&code=${code}&code_verifier=${cv}`,
        });
        const { access_token } = await tokRes.json() as any;

        // Run sync
        const result = await syncAppointmentsToFHIR(medplumBase, access_token);
        await db.addAuditEntry('admin', 'admin',
            `Appointment sync: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped, ${result.failed} failed (${result.total} total)`,
            getIp(req)
        );
        res.json({ ok: true, ...result });
    } catch (error: any) {
        console.error('[Appt-Sync] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/admin/users/:id/unlock — unlock locked account
app.post('/api/admin/users/:id/unlock', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const user = await db.getUserById(id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        await db.unlockUser(id);
        await db.addAuditEntry('admin', 'admin', `Unlocked user: ${user.username}`, getIp(req));
        res.json({ ok: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/admin/users/:id/reset-password — admin password reset
app.post('/api/admin/users/:id/reset-password', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { newPassword } = req.body;
        if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
        const user = await db.getUserById(id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        await db.setPassword(id, newPassword);
        await db.addAuditEntry('admin', 'admin', `Reset password for: ${user.username}`, getIp(req));
        res.json({ ok: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// ===========================================================
// CDSS — Thread & Message Management + Streaming Chat
// ===========================================================

// GET /api/cdss/threads — list threads for a user
app.get('/api/cdss/threads', async (req, res) => {
    try {
        const username = req.query.username as string;
        if (!username) return res.status(400).json({ error: 'username query param required' });
        const threads = await db.listCDSSThreads(username);
        res.json(threads);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/cdss/threads — create thread
app.post('/api/cdss/threads', async (req, res) => {
    try {
        const { username, patientId, patientName } = req.body;
        if (!username) return res.status(400).json({ error: 'username is required' });
        const thread = await db.createCDSSThread(username, patientId, patientName);
        res.json(thread);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/cdss/threads/:id — rename thread
app.put('/api/cdss/threads/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { title } = req.body;
        if (!title) return res.status(400).json({ error: 'title is required' });
        const updated = await db.updateCDSSThread(id, title);
        if (!updated) return res.status(404).json({ error: 'Thread not found' });
        res.json(updated);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/cdss/threads/:id — disabled for audit trail compliance
app.delete('/api/cdss/threads/:id', async (_req, res) => {
    res.status(403).json({ error: 'Thread deletion is disabled. Clinical conversations are retained for audit trail compliance.' });
});

// GET /api/cdss/threads/:id/messages — get messages for a thread
app.get('/api/cdss/threads/:id/messages', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const messages = await db.listCDSSMessages(id);
        res.json(messages);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/cdss/threads/:id/messages/stream — send message via Med-SEAL-Agent (SSE)
app.post('/api/cdss/threads/:id/messages/stream', async (req, res) => {
    const AGENT_BASE = process.env.AGENT_BASE_URL || 'http://localhost:8000';

    try {
        const threadId = parseInt(req.params.id);
        const { message, patient } = req.body;
        if (!message) return res.status(400).json({ error: 'message is required' });

        // Save user message
        await db.addCDSSMessage(threadId, 'user', message);

        // Get or create agent session for this thread
        const thread = await db.getCDSSThread(threadId);
        let agentSessionId = thread?.agent_session_id;

        if (!agentSessionId) {
            const sessionRes = await fetch(`${AGENT_BASE}/sessions`, { method: 'POST' });
            const sessionData = await sessionRes.json() as any;
            agentSessionId = sessionData.session_id;
            await db.setAgentSessionId(threadId, agentSessionId!);
        }

        // Use /openemr/ endpoint for clinician-grade CDS with live FHIR context
        const patientId = patient?.id || thread?.patient_id || 'default-patient';
        const agentUrl = `${AGENT_BASE}/openemr/sessions/${agentSessionId}/chat`;

        // Stream from agent
        const agentRes = await fetch(agentUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                patient_id: patientId,
            }),
        });

        if (!agentRes.ok) {
            const err = await agentRes.text();
            console.error('[CDSS Agent] Error:', err);

            // Fallback to basic LLM if agent fails
            console.log('[CDSS] Falling back to direct LLM...');
            const context = patient ? buildClinicalContext(patient) : '';
            const msgs: ChatMessage[] = [
                { role: 'system', content: SYSTEM_PROMPTS.clinicalAssistant },
            ];
            if (context) {
                msgs.push(
                    { role: 'user', content: `Here is the patient's clinical data:\n\n${context}` },
                    { role: 'assistant', content: 'I have reviewed the patient\'s clinical data. Ready to assist.' },
                );
            }
            msgs.push({ role: 'user', content: message });

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            let fallbackResponse = '';
            await streamLLM(msgs, (text) => {
                fallbackResponse += text;
                res.write(`data: ${JSON.stringify({ text })}\n\n`);
            });
            await db.addCDSSMessage(threadId, 'assistant', fallbackResponse);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        // Stream SSE from agent to frontend in real-time
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        let fullContent = '';
        let sources: any[] = [];
        let thinking = '';
        const steps: string[] = [];

        // Process agent SSE line by line
        const processLine = (line: string) => {
            if (!line.startsWith('data: ')) return;
            const data = line.slice(6).trim();
            if (!data) return;
            try {
                const event = JSON.parse(data);

                // Forward step events immediately
                if (event.done === false && event.step) {
                    steps.push(event.step);
                    res.write(`data: ${JSON.stringify({ step: event.step })}\n\n`);
                }

                // V2 token events — forward immediately
                if (event.type === 'llm_token' && event.content) {
                    fullContent += event.content;
                    res.write(`data: ${JSON.stringify({ text: event.content })}\n\n`);
                }

                // Final event (V1: done=true, V2: type=complete)
                if ((event.done === true && event.content) || (event.type === 'complete' && event.content)) {
                    const eventContent = event.content || '';
                    sources = event.structured_sources || event.sources ||
                              event.metadata?.structured_sources || event.metadata?.sources || [];
                    thinking = event.thinking || '';

                    if (event.steps) {
                        for (const s of event.steps) steps.push(s.action || s);
                    }

                    // Extract <think> from content
                    const thinkMatch = eventContent.match(/<think>([\s\S]*?)<\/think>/);
                    if (thinkMatch) {
                        thinking = thinkMatch[1].trim() + (thinking ? '\n' + thinking : '');
                    }
                    const cleanContent = eventContent.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();

                    // If no token-by-token streaming happened, stream the final content word by word
                    if (!fullContent && cleanContent) {
                        fullContent = cleanContent;
                        const words = cleanContent.split(' ');
                        for (let i = 0; i < words.length; i++) {
                            res.write(`data: ${JSON.stringify({ text: (i === 0 ? '' : ' ') + words[i] })}\n\n`);
                        }
                    } else if (!fullContent) {
                        fullContent = cleanContent;
                    }
                }
            } catch {
                // skip malformed JSON
            }
        };

        // Read agent response as a stream, process lines as they arrive
        const reader = agentRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // keep incomplete line in buffer

            for (const line of lines) {
                processLine(line);
            }
        }
        // Process any remaining buffer
        if (buffer) processLine(buffer);

        // Build thinking from steps if model didn't produce <think> tags
        if (!thinking && steps.length > 0) {
            const uniqueSteps = [...new Set(steps)];
            thinking = uniqueSteps.map(s => `- ${s}`).join('\n');
        }

        // Send thinking
        if (thinking) {
            res.write(`data: ${JSON.stringify({ thinking })}\n\n`);
        }

        // Send sources
        if (sources.length > 0) {
            const formattedSources = sources.map((s: any) => ({
                title: s.title || '',
                authors: s.authors || '',
                journal: s.source_label || s.journal || '',
                year: s.year || '',
                doi: s.doi || '',
                abstract: s.abstract || '',
                relevance: s.relevance_score,
            }));
            res.write(`data: ${JSON.stringify({ sources: formattedSources })}\n\n`);
        }

        // Save to DB
        await db.addCDSSMessage(
            threadId, 'assistant', fullContent,
            sources.length > 0 ? sources : undefined,
            thinking || undefined,
        );

        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error: any) {
        console.error('[CDSS Stream] Error:', error.message);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        } else {
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    }
});

// GET /api/cdss/patients — search patients via Medplum FHIR
app.get('/api/cdss/patients', async (req, res) => {
    try {
        const query = req.query.q as string;
        if (!query) return res.status(400).json({ error: 'q query param required' });

        const medplumBase = process.env.MEDPLUM_BASE_URL || 'http://medplum-server:8103';

        // Authenticate with Medplum
        const cv = 'cdss-search-' + Date.now();
        const loginRes = await fetch(`${medplumBase}/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'admin@example.com', password: 'medplum_admin',
                scope: 'openid fhirUser', codeChallengeMethod: 'plain', codeChallenge: cv
            }),
        });
        const { code } = await loginRes.json() as any;
        const tokRes = await fetch(`${medplumBase}/oauth2/token`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=authorization_code&code=${code}&code_verifier=${cv}`,
        });
        const { access_token } = await tokRes.json() as any;

        // Search patients
        const searchRes = await fetch(
            `${medplumBase}/fhir/R4/Patient?name:contains=${encodeURIComponent(query)}&_count=20`,
            { headers: { Authorization: `Bearer ${access_token}` } }
        );
        const bundle = await searchRes.json() as any;

        const patients = (bundle.entry || []).map((e: any) => {
            const r = e.resource;
            const name = r.name?.[0] || {};
            return {
                id: r.id,
                firstName: name.given?.join(' ') || '',
                lastName: name.family || '',
                dateOfBirth: r.birthDate || '',
                gender: r.gender || '',
            };
        });

        res.json(patients);
    } catch (error: any) {
        console.error('[CDSS Patients] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/cdss/patients/:id — get full patient context from Medplum FHIR
app.get('/api/cdss/patients/:id', async (req, res) => {
    try {
        const patientId = req.params.id;
        const medplumBase = process.env.MEDPLUM_BASE_URL || 'http://medplum-server:8103';

        // Authenticate with Medplum
        const cv = 'cdss-patient-' + Date.now();
        const loginRes = await fetch(`${medplumBase}/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'admin@example.com', password: 'medplum_admin',
                scope: 'openid fhirUser', codeChallengeMethod: 'plain', codeChallenge: cv
            }),
        });
        const { code } = await loginRes.json() as any;
        const tokRes = await fetch(`${medplumBase}/oauth2/token`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=authorization_code&code=${code}&code_verifier=${cv}`,
        });
        const { access_token } = await tokRes.json() as any;

        const headers = { Authorization: `Bearer ${access_token}` };

        // Fetch patient + related resources in parallel
        const [patientRes, conditionsRes, medsRes, allergiesRes, obsRes, encountersRes, immunRes] = await Promise.all([
            fetch(`${medplumBase}/fhir/R4/Patient/${patientId}`, { headers }),
            fetch(`${medplumBase}/fhir/R4/Condition?patient=${patientId}&_count=50`, { headers }),
            fetch(`${medplumBase}/fhir/R4/MedicationRequest?patient=${patientId}&_count=50`, { headers }),
            fetch(`${medplumBase}/fhir/R4/AllergyIntolerance?patient=${patientId}&_count=50`, { headers }),
            fetch(`${medplumBase}/fhir/R4/Observation?patient=${patientId}&_count=100&_sort=-date`, { headers }),
            fetch(`${medplumBase}/fhir/R4/Encounter?patient=${patientId}&_count=10&_sort=-date`, { headers }),
            fetch(`${medplumBase}/fhir/R4/Immunization?patient=${patientId}&_count=20`, { headers }),
        ]);

        const patient = await patientRes.json() as any;
        const conditionsBundle = await conditionsRes.json() as any;
        const medsBundle = await medsRes.json() as any;
        const allergiesBundle = await allergiesRes.json() as any;
        const obsBundle = await obsRes.json() as any;
        const encountersBundle = await encountersRes.json() as any;
        const immunBundle = await immunRes.json() as any;

        const name = patient.name?.[0] || {};

        const context = {
            id: patient.id,
            firstName: name.given?.join(' ') || '',
            lastName: name.family || '',
            dateOfBirth: patient.birthDate || '',
            gender: patient.gender || '',
            syntheaId: patient.identifier?.[0]?.value || patient.id,

            conditions: (conditionsBundle.entry || []).map((e: any) => {
                const r = e.resource;
                return {
                    code: r.code?.coding?.[0]?.code || '',
                    display: r.code?.coding?.[0]?.display || r.code?.text || '',
                    severity: r.severity?.coding?.[0]?.display || '',
                    onsetDate: r.onsetDateTime || '',
                    clinicalStatus: r.clinicalStatus?.coding?.[0]?.code || '',
                };
            }),

            medications: (medsBundle.entry || []).map((e: any) => {
                const r = e.resource;
                const dosage = r.dosageInstruction?.[0] || {};
                return {
                    code: r.medicationCodeableConcept?.coding?.[0]?.code || '',
                    display: r.medicationCodeableConcept?.coding?.[0]?.display || r.medicationCodeableConcept?.text || '',
                    dosage: dosage.doseAndRate?.[0]?.doseQuantity?.value ? `${dosage.doseAndRate[0].doseQuantity.value} ${dosage.doseAndRate[0].doseQuantity.unit || ''}` : '',
                    frequency: dosage.timing?.code?.text || dosage.text || '',
                    route: dosage.route?.coding?.[0]?.display || '',
                    status: r.status || '',
                    reasonDisplay: r.reasonCode?.[0]?.coding?.[0]?.display || '',
                };
            }),

            allergies: (allergiesBundle.entry || []).map((e: any) => {
                const r = e.resource;
                return {
                    code: r.code?.coding?.[0]?.code || '',
                    display: r.code?.coding?.[0]?.display || r.code?.text || '',
                    category: r.category?.[0] || '',
                    criticality: r.criticality || '',
                    reaction: r.reaction?.[0]?.manifestation?.[0]?.coding?.[0]?.display || '',
                    clinicalStatus: r.clinicalStatus?.coding?.[0]?.code || '',
                };
            }),

            observations: (obsBundle.entry || []).map((e: any) => {
                const r = e.resource;
                return {
                    code: r.code?.coding?.[0]?.code || '',
                    display: r.code?.coding?.[0]?.display || r.code?.text || '',
                    value: r.valueQuantity?.value?.toString() || r.valueString || r.valueCodeableConcept?.text || '',
                    unit: r.valueQuantity?.unit || '',
                    category: r.category?.[0]?.coding?.[0]?.code || '',
                    effectiveDate: r.effectiveDateTime || '',
                    interpretation: r.interpretation?.[0]?.coding?.[0]?.code || '',
                    referenceRange: r.referenceRange?.[0] ? `${r.referenceRange[0].low?.value || ''}-${r.referenceRange[0].high?.value || ''} ${r.referenceRange[0].low?.unit || ''}` : '',
                };
            }),

            encounters: (encountersBundle.entry || []).map((e: any) => {
                const r = e.resource;
                return {
                    date: r.period?.start || '',
                    classCode: r.class?.code || '',
                    reasonDesc: r.reasonCode?.[0]?.coding?.[0]?.display || '',
                    provider: r.participant?.[0]?.individual?.display || '',
                };
            }),

            immunizations: (immunBundle.entry || []).map((e: any) => {
                const r = e.resource;
                return {
                    vaccineCode: r.vaccineCode?.coding?.[0]?.code || '',
                    vaccineDisplay: r.vaccineCode?.coding?.[0]?.display || r.vaccineCode?.text || '',
                    occurrenceDate: r.occurrenceDateTime || '',
                    doseNumber: r.protocolApplied?.[0]?.doseNumberPositiveInt?.toString() || '',
                };
            }),

            imagingStudies: [],
        };

        res.json(context);
    } catch (error: any) {
        console.error('[CDSS Patient Context] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ===========================================================
// Start Server
// ===========================================================
import { initDB } from './db';

// Start server — DB is optional (SSO features won't work without it)
(async () => {
    try {
        await initDB();
        initOpenEMRPool();
        console.log('[DB] Connected');
    } catch (err: any) {
        console.warn('[DB] Not available — SSO/audit endpoints will fail, but AI agents will work.', err.message);
    }

    app.listen(PORT, () => {
        const config = getLLMConfig();
        console.log(`
╔════════════════════════════════════════════╗
║        Med-SEAL AI Service v2.0           ║
╠════════════════════════════════════════════╣
║  Port:     ${PORT}                           ║
║  LLM URL:  ${config.apiUrl.slice(0, 30).padEnd(30)}║
║  Model:    ${config.model.padEnd(30)}║
╠════════════════════════════════════════════╣
║  Agents:                                  ║
║  • POST /chat          Clinical Chat AI   ║
║  • POST /chat/stream   Chat (Streaming)   ║
║  • POST /radiology/report  Report Gen AI  ║
║  • POST /cds/alerts    Decision Support   ║
║  • POST /ambient/summary  Summarization   ║
║  CDSS:                                    ║
║  • /api/cdss/threads   Thread CRUD        ║
║  • /api/cdss/patients  FHIR Patient Proxy ║
╚════════════════════════════════════════════╝
        `);
    });
})();

