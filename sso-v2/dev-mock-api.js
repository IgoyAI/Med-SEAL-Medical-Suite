// ═══════════════════════════════════════════════════════════
//  Mock API for Med-SEAL SSO V2 — dev/demo mode only
//  Provides in-memory user store so the frontend works
//  without the ai-service backend + PostgreSQL.
// ═══════════════════════════════════════════════════════════

const DEMO_USERS = [
  {
    id: 1,
    username: 'admin',
    displayName: 'Administrator',
    email: 'admin@medseal.local',
    password: 'pass',
    role: 'admin',
    status: 'active',
    tags: [],
    twoFAEnabled: false,
    twoFASecret: null,
    facilityId: 0,
    lastLogin: new Date().toISOString(),
    createdAt: '2025-01-15T08:00:00Z',
  },
  {
    id: 2,
    username: 'dr.tan',
    displayName: 'Dr. Sarah Tan',
    email: 'sarah.tan@medseal.local',
    password: 'pass',
    role: 'doc',
    status: 'active',
    tags: ['radiologist'],
    twoFAEnabled: true,
    twoFASecret: 'JBSWY3DPEHPK3PXP',
    facilityId: 1,
    lastLogin: '2026-04-03T09:20:00Z',
    createdAt: '2025-02-20T10:30:00Z',
  },
  {
    id: 3,
    username: 'nurse.lee',
    displayName: 'Nurse James Lee',
    email: 'james.lee@medseal.local',
    password: 'pass',
    role: 'clin',
    status: 'active',
    tags: [],
    twoFAEnabled: false,
    twoFASecret: null,
    facilityId: 1,
    lastLogin: '2026-04-04T07:15:00Z',
    createdAt: '2025-03-10T14:00:00Z',
  },
  {
    id: 4,
    username: 'receptionist.wong',
    displayName: 'Alice Wong',
    email: 'alice.wong@medseal.local',
    password: 'pass',
    role: 'front',
    status: 'active',
    tags: [],
    twoFAEnabled: false,
    twoFASecret: null,
    facilityId: 2,
    lastLogin: '2026-04-02T11:00:00Z',
    createdAt: '2025-04-05T09:00:00Z',
  },
];

const DEMO_FACILITIES = [
  { id: 1, name: 'Main Hospital' },
  { id: 2, name: 'Outpatient Clinic' },
  { id: 3, name: 'Radiology Centre' },
];

const auditLog = [
  { timestamp: new Date().toISOString(), user: 'admin', type: 'login', detail: 'Signed in from demo' },
  { timestamp: new Date(Date.now() - 3600000).toISOString(), user: 'dr.tan', type: 'login', detail: 'Signed in (2FA verified)' },
  { timestamp: new Date(Date.now() - 7200000).toISOString(), user: 'nurse.lee', type: 'login', detail: 'Signed in' },
  { timestamp: new Date(Date.now() - 10800000).toISOString(), user: 'admin', type: 'user_create', detail: 'Created user receptionist.wong' },
];

// ── Helpers ──

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

// ── Plugin ──

export function mockApiPlugin() {
  return {
    name: 'mock-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith('/api/')) return next();

        const url = req.url.split('?')[0];
        const method = req.method;
        const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);

        // ── Auth ──
        if (url === '/api/auth/login' && method === 'POST') {
          const body = await parseBody(req);
          const user = DEMO_USERS.find((u) => u.username === body.username);
          if (!user) return json(res, 401, { error: 'User not found' });
          if (user.password !== body.password) return json(res, 401, { error: 'Invalid password' });
          if (user.status === 'locked') return json(res, 403, { error: 'Account locked' });

          auditLog.unshift({
            timestamp: new Date().toISOString(),
            user: user.username,
            type: 'login',
            detail: `Signed in from demo`,
          });

          return json(res, 200, {
            username: user.username,
            role: user.role,
            tags: user.tags,
            requires2FA: user.twoFAEnabled,
          });
        }

        if (url === '/api/auth/2fa-verify' && method === 'POST') {
          const body = await parseBody(req);
          const user = DEMO_USERS.find((u) => u.username === body.username);
          if (!user) return json(res, 401, { error: 'User not found' });
          // Accept any 6-digit code in demo mode
          if (!body.code || body.code.length !== 6) return json(res, 400, { error: 'Invalid code' });
          return json(res, 200, {
            username: user.username,
            role: user.role,
            tags: user.tags,
          });
        }

        // ── User Profile ──
        const userMatch = url.match(/^\/api\/users\/([^/]+)$/);
        if (userMatch) {
          const user = DEMO_USERS.find((u) => u.username === userMatch[1]);
          if (!user) return json(res, 404, { error: 'Not found' });

          if (method === 'GET') {
            return json(res, 200, user);
          }
          if (method === 'PUT') {
            const body = await parseBody(req);
            if (body.displayName) user.displayName = body.displayName;
            if (body.email) user.email = body.email;
            return json(res, 200, user);
          }
        }

        const pwdMatch = url.match(/^\/api\/users\/([^/]+)\/password$/);
        if (pwdMatch && method === 'PUT') {
          const user = DEMO_USERS.find((u) => u.username === pwdMatch[1]);
          if (!user) return json(res, 404, { error: 'Not found' });
          const body = await parseBody(req);
          if (user.password !== body.currentPassword) return json(res, 400, { error: 'Current password incorrect' });
          user.password = body.newPassword;
          return json(res, 200, { ok: true });
        }

        // ── 2FA Setup ──
        const twoFASetup = url.match(/^\/api\/users\/([^/]+)\/2fa\/setup$/);
        if (twoFASetup && method === 'POST') {
          const secret = 'JBSWY3DPEHPK3PXP';
          return json(res, 200, {
            secret,
            otpauthUrl: `otpauth://totp/Med-SEAL:${twoFASetup[1]}?secret=${secret}&issuer=Med-SEAL`,
          });
        }

        const twoFAVerify = url.match(/^\/api\/users\/([^/]+)\/2fa\/verify$/);
        if (twoFAVerify && method === 'POST') {
          const user = DEMO_USERS.find((u) => u.username === twoFAVerify[1]);
          if (user) { user.twoFAEnabled = true; }
          return json(res, 200, { ok: true });
        }

        const twoFADisable = url.match(/^\/api\/users\/([^/]+)\/2fa$/);
        if (twoFADisable && method === 'DELETE') {
          const user = DEMO_USERS.find((u) => u.username === twoFADisable[1]);
          if (user) { user.twoFAEnabled = false; user.twoFASecret = null; }
          return json(res, 200, { ok: true });
        }

        // ── Admin Users ──
        if (url === '/api/admin/users' && method === 'GET') {
          return json(res, 200, DEMO_USERS);
        }

        if (url === '/api/admin/users' && method === 'POST') {
          const body = await parseBody(req);
          const newUser = {
            id: DEMO_USERS.length + 1,
            username: body.username,
            displayName: body.displayName || body.username,
            email: body.email || '',
            password: body.password || 'pass',
            role: body.role || 'clin',
            status: 'active',
            tags: body.tags || [],
            twoFAEnabled: false,
            twoFASecret: null,
            facilityId: body.facilityId || 0,
            lastLogin: null,
            createdAt: new Date().toISOString(),
          };
          DEMO_USERS.push(newUser);
          auditLog.unshift({
            timestamp: new Date().toISOString(),
            user: 'admin',
            type: 'user_create',
            detail: `Created user ${newUser.username}`,
          });
          return json(res, 201, newUser);
        }

        const adminUserMatch = url.match(/^\/api\/admin\/users\/(\d+)$/);
        if (adminUserMatch) {
          const id = parseInt(adminUserMatch[1]);
          const idx = DEMO_USERS.findIndex((u) => u.id === id);

          if (method === 'PUT' && idx >= 0) {
            const body = await parseBody(req);
            Object.assign(DEMO_USERS[idx], {
              ...(body.displayName && { displayName: body.displayName }),
              ...(body.email && { email: body.email }),
              ...(body.role && { role: body.role }),
              ...(body.status && { status: body.status }),
              ...(body.tags && { tags: body.tags }),
              ...(body.facilityId !== undefined && { facilityId: body.facilityId }),
            });
            return json(res, 200, DEMO_USERS[idx]);
          }

          if (method === 'DELETE' && idx >= 0) {
            DEMO_USERS.splice(idx, 1);
            return json(res, 200, { ok: true });
          }
        }

        const resetPwdMatch = url.match(/^\/api\/admin\/users\/(\d+)\/reset-password$/);
        if (resetPwdMatch && method === 'POST') {
          const id = parseInt(resetPwdMatch[1]);
          const user = DEMO_USERS.find((u) => u.id === id);
          if (user) {
            const body = await parseBody(req);
            user.password = body.newPassword || 'pass';
          }
          return json(res, 200, { ok: true });
        }

        const unlockMatch = url.match(/^\/api\/admin\/users\/(\d+)\/unlock$/);
        if (unlockMatch && method === 'POST') {
          const id = parseInt(unlockMatch[1]);
          const user = DEMO_USERS.find((u) => u.id === id);
          if (user) { user.status = 'active'; }
          return json(res, 200, { ok: true });
        }

        if (url === '/api/admin/sync-openemr' && method === 'POST') {
          return json(res, 200, { synced: DEMO_USERS.length, total: DEMO_USERS.length });
        }

        // ── Facilities ──
        if (url === '/api/facilities') {
          return json(res, 200, DEMO_FACILITIES);
        }

        // ── System Status ──
        if (url === '/api/system-status') {
          return json(res, 200, {
            openemr: 'up',
            medplum: 'up',
            orthanc: 'up',
            ohif: 'up',
          });
        }

        // ── Audit ──
        if (url === '/api/audit' && method === 'GET') {
          const limit = parseInt(query.limit) || 50;
          return json(res, 200, { rows: auditLog.slice(0, limit) });
        }

        if (url === '/api/audit' && method === 'POST') {
          const body = await parseBody(req);
          auditLog.unshift({
            timestamp: new Date().toISOString(),
            user: body.user || 'unknown',
            type: body.type || 'event',
            detail: body.detail || '',
          });
          return json(res, 200, { ok: true });
        }

        // ── SSO Launch ──
        const launchMatch = url.match(/^\/api\/sso\/launch\/(.+)$/);
        if (launchMatch) {
          // In demo mode, just redirect to a placeholder
          res.writeHead(302, { Location: `/#demo-launch-${launchMatch[1]}` });
          return res.end();
        }

        // Fallback
        return json(res, 404, { error: 'API route not found (mock)' });
      });
    },
  };
}
