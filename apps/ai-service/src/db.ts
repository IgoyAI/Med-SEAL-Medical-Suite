// ===== Med-SEAL SSO Database Layer =====
// PostgreSQL connection pool, schema init, and query helpers.

import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 10;

// ── Connection Pool ────────────────────────────────────────
const pool = new Pool({
    connectionString: process.env.SSO_DB_URL || 'postgres://sso:sso_secret@localhost:5434/medseal_sso',
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 3000,
});

// ── Schema Initialization ──────────────────────────────────
export async function initDB(): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS sso_users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(64) UNIQUE NOT NULL,
                display_name VARCHAR(128),
                email VARCHAR(256),
                password_hash VARCHAR(256) NOT NULL,
                role VARCHAR(16) DEFAULT 'user',
                status VARCHAR(16) DEFAULT 'active',
                tags TEXT[] DEFAULT '{}',
                two_fa_enabled BOOLEAN DEFAULT FALSE,
                two_fa_secret VARCHAR(64),
                facility_id INT DEFAULT 0,
                failed_login_attempts INT DEFAULT 0,
                locked_until TIMESTAMPTZ,
                last_login TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS audit_log (
                id SERIAL PRIMARY KEY,
                event_type VARCHAR(32) NOT NULL,
                username VARCHAR(64) NOT NULL,
                detail TEXT,
                ip_address VARCHAR(64),
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(username);
        `);

        // CDSS thread & message tables
        await client.query(`
            CREATE TABLE IF NOT EXISTS cdss_threads (
                id SERIAL PRIMARY KEY,
                username VARCHAR(64) NOT NULL,
                patient_id VARCHAR(128),
                patient_name VARCHAR(256),
                title VARCHAR(256) DEFAULT 'New conversation',
                agent_session_id VARCHAR(128),
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS cdss_messages (
                id SERIAL PRIMARY KEY,
                thread_id INT NOT NULL REFERENCES cdss_threads(id) ON DELETE CASCADE,
                role VARCHAR(16) NOT NULL,
                content TEXT NOT NULL,
                sources JSONB,
                thinking TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_cdss_threads_user ON cdss_threads(username);
            CREATE INDEX IF NOT EXISTS idx_cdss_messages_thread ON cdss_messages(thread_id);
        `);

        // Migration: add agent_session_id to cdss_threads
        await client.query(`
            ALTER TABLE cdss_threads ADD COLUMN IF NOT EXISTS agent_session_id VARCHAR(128);
        `);

        // Migration: add tags column for existing tables
        await client.query(`
            ALTER TABLE sso_users ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
        `);

        // Migration: add facility_id column for department assignment
        await client.query(`
            ALTER TABLE sso_users ADD COLUMN IF NOT EXISTS facility_id INT DEFAULT 0;
        `);

        // Seed default admin if no users exist
        const { rows } = await client.query('SELECT COUNT(*) FROM sso_users');
        if (parseInt(rows[0].count) === 0) {
            const hash = await bcrypt.hash('pass', BCRYPT_ROUNDS);
            await client.query(
                `INSERT INTO sso_users (username, display_name, email, password_hash, role)
                 VALUES ($1, $2, $3, $4, $5)`,
                ['admin', 'Administrator', 'admin@medseal.local', hash, 'admin']
            );
            console.log('[DB] Seeded default admin user (admin / pass)');
        }

        console.log('[DB] Schema initialized');
    } finally {
        client.release();
    }
}

// ── User Types ─────────────────────────────────────────────
export interface SSOUser {
    id: number;
    username: string;
    display_name: string;
    email: string;
    password_hash: string;
    role: string;
    status: string;
    tags: string[];
    facility_id: number;
    two_fa_enabled: boolean;
    two_fa_secret: string | null;
    failed_login_attempts: number;
    locked_until: Date | null;
    last_login: Date | null;
    created_at: Date;
    updated_at: Date;
}

// ── User Queries ───────────────────────────────────────────

export async function getUser(username: string): Promise<SSOUser | null> {
    const { rows } = await pool.query('SELECT * FROM sso_users WHERE username = $1', [username]);
    return rows[0] || null;
}

export async function getUserById(id: number): Promise<SSOUser | null> {
    const { rows } = await pool.query('SELECT * FROM sso_users WHERE id = $1', [id]);
    return rows[0] || null;
}

export async function listUsers(): Promise<SSOUser[]> {
    const { rows } = await pool.query('SELECT * FROM sso_users ORDER BY created_at ASC');
    return rows;
}

export async function createUser(
    username: string, displayName: string, email: string,
    password: string, role: string = 'user', facilityId: number = 0
): Promise<SSOUser> {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await pool.query(
        `INSERT INTO sso_users (username, display_name, email, password_hash, role, facility_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [username, displayName, email, hash, role, facilityId]
    );
    return rows[0];
}

export async function updateUser(
    id: number, fields: { display_name?: string; email?: string; role?: string; status?: string; tags?: string[]; facility_id?: number }
): Promise<SSOUser | null> {
    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) { sets.push(`${k} = $${i}`); vals.push(v); i++; }
    }
    if (sets.length === 0) return getUserById(id);
    sets.push(`updated_at = NOW()`);
    vals.push(id);
    const { rows } = await pool.query(
        `UPDATE sso_users SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals
    );
    return rows[0] || null;
}

export async function deleteUser(id: number): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM sso_users WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
}

// ── Password ───────────────────────────────────────────────

export async function verifyPassword(user: SSOUser, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.password_hash);
}

export async function setPassword(id: number, newPassword: string): Promise<void> {
    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query('UPDATE sso_users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, id]);
}

// ── Account Lockout ────────────────────────────────────────
const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export async function recordFailedLogin(username: string): Promise<{ locked: boolean; attemptsLeft: number }> {
    const user = await getUser(username);
    if (!user) return { locked: false, attemptsLeft: 0 };
    const attempts = user.failed_login_attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60000);
        await pool.query(
            'UPDATE sso_users SET failed_login_attempts = $1, locked_until = $2, status = $3 WHERE username = $4',
            [attempts, lockUntil, 'locked', username]
        );
        return { locked: true, attemptsLeft: 0 };
    }
    await pool.query('UPDATE sso_users SET failed_login_attempts = $1 WHERE username = $2', [attempts, username]);
    return { locked: false, attemptsLeft: MAX_ATTEMPTS - attempts };
}

export async function resetLoginAttempts(username: string): Promise<void> {
    await pool.query(
        'UPDATE sso_users SET failed_login_attempts = 0, locked_until = NULL, status = $1, last_login = NOW() WHERE username = $2',
        ['active', username]
    );
}

export async function unlockUser(id: number): Promise<void> {
    await pool.query(
        'UPDATE sso_users SET failed_login_attempts = 0, locked_until = NULL, status = $1, updated_at = NOW() WHERE id = $2',
        ['active', id]
    );
}

export function isLocked(user: SSOUser): boolean {
    if (user.status === 'disabled') return true;
    if (user.status === 'locked' && user.locked_until && new Date(user.locked_until) > new Date()) return true;
    // Auto-unlock if lockout expired
    if (user.status === 'locked' && user.locked_until && new Date(user.locked_until) <= new Date()) return false;
    return false;
}

// ── 2FA ────────────────────────────────────────────────────

export async function set2FASecret(id: number, secret: string): Promise<void> {
    await pool.query('UPDATE sso_users SET two_fa_secret = $1, updated_at = NOW() WHERE id = $2', [secret, id]);
}

export async function enable2FA(id: number): Promise<void> {
    await pool.query('UPDATE sso_users SET two_fa_enabled = TRUE, updated_at = NOW() WHERE id = $1', [id]);
}

export async function disable2FA(id: number): Promise<void> {
    await pool.query(
        'UPDATE sso_users SET two_fa_enabled = FALSE, two_fa_secret = NULL, updated_at = NOW() WHERE id = $1', [id]
    );
}

// ── Audit Log ──────────────────────────────────────────────

export interface AuditEntry {
    id: number;
    event_type: string;
    username: string;
    detail: string;
    ip_address: string;
    created_at: Date;
}

export async function addAuditEntry(
    eventType: string, username: string, detail: string, ip: string
): Promise<AuditEntry> {
    const { rows } = await pool.query(
        `INSERT INTO audit_log (event_type, username, detail, ip_address)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [eventType, username, detail, ip]
    );
    return rows[0];
}

export async function getAuditLog(limit: number = 200): Promise<AuditEntry[]> {
    const { rows } = await pool.query(
        'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1', [limit]
    );
    return rows;
}

// ── CDSS Thread & Message Queries ─────────────────────────

export interface CDSSThread {
    id: number;
    username: string;
    patient_id: string | null;
    patient_name: string | null;
    title: string;
    agent_session_id: string | null;
    created_at: Date;
    updated_at: Date;
}

export interface CDSSMessage {
    id: number;
    thread_id: number;
    role: string;
    content: string;
    sources: any;
    thinking: string | null;
    created_at: Date;
}

export async function listCDSSThreads(username: string): Promise<CDSSThread[]> {
    const { rows } = await pool.query(
        'SELECT * FROM cdss_threads WHERE username = $1 ORDER BY updated_at DESC',
        [username]
    );
    return rows;
}

export async function getCDSSThread(id: number): Promise<CDSSThread | null> {
    const { rows } = await pool.query('SELECT * FROM cdss_threads WHERE id = $1', [id]);
    return rows[0] || null;
}

export async function createCDSSThread(
    username: string, patientId?: string, patientName?: string, agentSessionId?: string
): Promise<CDSSThread> {
    const { rows } = await pool.query(
        `INSERT INTO cdss_threads (username, patient_id, patient_name, agent_session_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [username, patientId || null, patientName || null, agentSessionId || null]
    );
    return rows[0];
}

export async function setAgentSessionId(threadId: number, agentSessionId: string): Promise<void> {
    await pool.query('UPDATE cdss_threads SET agent_session_id = $1 WHERE id = $2', [agentSessionId, threadId]);
}

export async function updateCDSSThread(id: number, title: string): Promise<CDSSThread | null> {
    const { rows } = await pool.query(
        `UPDATE cdss_threads SET title = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [title, id]
    );
    return rows[0] || null;
}

export async function deleteCDSSThread(id: number): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM cdss_threads WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
}

export async function listCDSSMessages(threadId: number): Promise<CDSSMessage[]> {
    const { rows } = await pool.query(
        'SELECT * FROM cdss_messages WHERE thread_id = $1 ORDER BY created_at ASC',
        [threadId]
    );
    return rows;
}

export async function addCDSSMessage(
    threadId: number, role: string, content: string,
    sources?: any, thinking?: string
): Promise<CDSSMessage> {
    const { rows } = await pool.query(
        `INSERT INTO cdss_messages (thread_id, role, content, sources, thinking)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [threadId, role, content, sources ? JSON.stringify(sources) : null, thinking || null]
    );
    // Touch thread updated_at
    await pool.query('UPDATE cdss_threads SET updated_at = NOW() WHERE id = $1', [threadId]);
    return rows[0];
}
