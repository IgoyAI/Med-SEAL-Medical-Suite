#!/usr/bin/env node
/**
 * Med-SEAL Enterprise Sync Service (GKE-native)
 * ══════════════════════════════════════════════
 * Bidirectional synchronization across all Med-SEAL systems:
 *
 *   SSO (PostgreSQL) ←→ FHIR/Medplum ←→ OpenEMR (MySQL)
 *                              ↑
 *               Patient Portal App (reads FHIR directly)
 *
 * Sync directions:
 *   1. SSO  → FHIR       Practitioner resources (doc/clin users)
 *   2. FHIR → SSO        New practitioners created in Medplum
 *   3. SSO  → OpenEMR    User accounts (users, ACL, groups)
 *   4. FHIR → OpenEMR    Patients, Conditions, Meds, Allergies, Immunizations, Appointments
 *   5. OpenEMR → FHIR    Encounters + SOAP notes, Appointment status, Patient updates
 *   6. OpenEMR → FHIR    Vitals/Observations (so Patient App displays latest)
 *
 * The Patient Portal App reads directly from FHIR — all data synced to Medplum
 * is immediately visible in the app. No separate app-sync is needed.
 *
 * Usage:
 *   node scripts/sync-service.js                     # Poll every 30s (default)
 *   SYNC_INTERVAL=60 node scripts/sync-service.js    # Custom interval
 *
 * Environment Variables:
 *   MEDPLUM_BASE_URL   Medplum FHIR server (default: http://medplum-server:8103)
 *   MEDPLUM_EMAIL      Admin login email
 *   MEDPLUM_PASSWORD   Admin login password
 *   OPENEMR_DB_HOST    OpenEMR MySQL host (default: openemr-db)
 *   OPENEMR_DB_PORT    OpenEMR MySQL port (default: 3306)
 *   OPENEMR_DB_USER    OpenEMR MySQL user (default: openemr)
 *   OPENEMR_DB_PASS    OpenEMR MySQL password
 *   OPENEMR_DB_NAME    OpenEMR database name (default: openemr)
 *   SSO_DB_URL         SSO PostgreSQL URL (default: postgres://sso:sso_secret@sso-db:5432/medseal_sso)
 *   SYNC_INTERVAL      Seconds between sync cycles (default: 30)
 */

const mysql = require('mysql2/promise');
const { Pool } = require('pg');

// ══════════════════════════════════════════════
//  Configuration
// ══════════════════════════════════════════════
const MEDPLUM_BASE    = process.env.MEDPLUM_BASE_URL  || 'http://medplum-server:8103';
const MEDPLUM_EMAIL   = process.env.MEDPLUM_EMAIL     || 'admin@example.com';
const MEDPLUM_PASSWORD= process.env.MEDPLUM_PASSWORD  || 'medplum_admin';
const INTERVAL        = parseInt(process.env.SYNC_INTERVAL || '30', 10);

const MEDSEAL_IDENTIFIER_SYSTEM = 'https://medseal.io/sso/username';
const APPT_SYSTEM_ID            = 'https://medseal.io/openemr/appointment';

// ══════════════════════════════════════════════
//  Database Pools
// ══════════════════════════════════════════════
let emrPool;   // MySQL — OpenEMR
let ssoPool;   // PostgreSQL — SSO

function initPools() {
  emrPool = mysql.createPool({
    host:     process.env.OPENEMR_DB_HOST || 'openemr-db',
    port:     parseInt(process.env.OPENEMR_DB_PORT || '3306'),
    user:     process.env.OPENEMR_DB_USER || 'openemr',
    password: process.env.OPENEMR_DB_PASS || 'openemr',
    database: process.env.OPENEMR_DB_NAME || 'openemr',
    waitForConnections: true,
    connectionLimit: 5,
  });
  ssoPool = new Pool({
    connectionString: process.env.SSO_DB_URL || 'postgres://sso:sso_secret@sso-db:5432/medseal_sso',
    max: 5,
    idleTimeoutMillis: 30000,
  });
  log('INFO', 'Database pools initialized');
}

// ══════════════════════════════════════════════
//  Structured Logging
// ══════════════════════════════════════════════
function log(level, msg, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: 'medseal-sync',
    message: msg,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ══════════════════════════════════════════════
//  SQL Helpers
// ══════════════════════════════════════════════
async function emrQuery(sql, params = []) {
  try {
    const [result] = await emrPool.query(sql, params);
    return Array.isArray(result) ? result : result;
  } catch (e) {
    log('ERROR', `MySQL query failed: ${e.message}`, { sql: sql.substring(0, 100) });
    return [];
  }
}

// Safe first-row accessor: handles both arrays and non-arrays
function first(result) {
  if (Array.isArray(result) && result.length > 0) return result[0];
  return result && typeof result === 'object' && !Array.isArray(result) ? result : undefined;
}

async function ssoQuery(sql, params = []) {
  try {
    const { rows } = await ssoPool.query(sql, params);
    return rows;
  } catch (e) {
    log('ERROR', `PG query failed: ${e.message}`, { sql: sql.substring(0, 100) });
    return [];
  }
}

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s);
}

function cleanName(name) {
  return (name || '').replace(/\d+$/, '').trim();
}

// ══════════════════════════════════════════════
//  Medplum Auth (auto-refresh)
// ══════════════════════════════════════════════
let _token = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const cv = 'sync-' + Date.now();
  const login = await fetch(`${MEDPLUM_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: MEDPLUM_EMAIL, password: MEDPLUM_PASSWORD,
      scope: 'openid fhirUser', codeChallengeMethod: 'plain', codeChallenge: cv,
    }),
  });
  const { code } = await login.json();
  const tok = await fetch(`${MEDPLUM_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=authorization_code&code=${code}&code_verifier=${cv}`,
  });
  const { access_token, expires_in } = await tok.json();
  _token = access_token;
  _tokenExpiry = Date.now() + ((expires_in || 3600) - 60) * 1000;
  return _token;
}

// ══════════════════════════════════════════════
//  FHIR Helpers
// ══════════════════════════════════════════════
async function fhirGet(path) {
  const token = await getToken();
  const res = await fetch(`${MEDPLUM_BASE}/fhir/R4/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function fhirPost(path, body) {
  const token = await getToken();
  const res = await fetch(`${MEDPLUM_BASE}/fhir/R4/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: res.ok ? await res.json() : null };
}

async function fhirPut(path, body) {
  const token = await getToken();
  const res = await fetch(`${MEDPLUM_BASE}/fhir/R4/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: res.ok ? await res.json() : null };
}

async function fetchSince(resourceType, since, maxPages = 20) {
  const token = await getToken();
  const items = [];
  const separator = resourceType.includes('?') ? '&' : '?';
  let url = `${MEDPLUM_BASE}/fhir/R4/${resourceType}${separator}_lastUpdated=ge${since}&_count=200`;
  let page = 0;
  while (url && page < maxPages) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const bundle = await res.json();
    for (const e of (bundle.entry || [])) if (e.resource) items.push(e.resource);
    const next = (bundle.link || []).find(l => l.relation === 'next');
    url = next ? next.url : null;
    page++;
  }
  return items;
}

async function fetchAllIds(resourceType) {
  const token = await getToken();
  const ids = new Set();
  let url = `${MEDPLUM_BASE}/fhir/R4/${resourceType}?_count=1000&_elements=id`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const bundle = await res.json();
    for (const e of (bundle.entry || [])) if (e.resource?.id) ids.add(e.resource.id);
    const next = (bundle.link || []).find(l => l.relation === 'next');
    url = next ? next.url : null;
  }
  return ids;
}

// ══════════════════════════════════════════════════════════
//  DIRECTION 1: SSO → FHIR (Practitioner sync)
// ══════════════════════════════════════════════════════════
async function syncSSOToFHIR() {
  const users = await ssoQuery(
    "SELECT username, display_name, email, role, status, facility_id FROM sso_users WHERE role IN ('doc', 'clin', 'admin') AND status = 'active'"
  );
  if (!users.length) return 0;

  let synced = 0;
  for (const u of users) {
    const parts = (u.display_name || u.username).trim().split(/\s+/);
    const lname = parts.pop() || '';
    const fname = parts.join(' ') || u.username;

    // Check if practitioner with this identifier exists
    const token = await getToken();
    const searchRes = await fetch(
      `${MEDPLUM_BASE}/fhir/R4/Practitioner?identifier=${encodeURIComponent(MEDSEAL_IDENTIFIER_SYSTEM + '|' + u.username)}&_count=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const bundle = searchRes.ok ? await searchRes.json() : { entry: [] };
    const existing = (bundle.entry || [])[0]?.resource;

    const practitioner = {
      resourceType: 'Practitioner',
      identifier: [{ system: MEDSEAL_IDENTIFIER_SYSTEM, value: u.username }],
      active: true,
      name: [{ family: lname, given: [fname] }],
      telecom: u.email ? [{ system: 'email', value: u.email }] : [],
      qualification: [{
        code: {
          text: u.role === 'doc' ? 'Physician' : u.role === 'clin' ? 'Clinician' : 'Administrator',
        },
      }],
    };

    if (existing) {
      practitioner.id = existing.id;
      const result = await fhirPut(`Practitioner/${existing.id}`, practitioner);
      if (result.ok) synced++;
    } else {
      const result = await fhirPost('Practitioner', practitioner);
      if (result.ok) synced++;
    }
  }
  return synced;
}

// ══════════════════════════════════════════════════════════
//  DIRECTION 2: FHIR → SSO (new practitioners)
// ══════════════════════════════════════════════════════════
async function syncFHIRToSSO() {
  const practitioners = await fetchSince('Practitioner', lastSyncTime || new Date(Date.now() - 7 * 86400000).toISOString());
  let synced = 0;

  for (const p of practitioners) {
    const ssoId = p.identifier?.find(i => i.system === MEDSEAL_IDENTIFIER_SYSTEM)?.value;
    if (ssoId) continue; // Already from SSO — skip

    const name = p.name?.[0] || {};
    const fname = cleanName(name.given?.[0] || '');
    const lname = cleanName(name.family || '');
    const email = p.telecom?.find(t => t.system === 'email')?.value || '';
    const username = (fname + lname).toLowerCase().replace(/[^a-z0-9]/g, '') || `fhir_${p.id.substring(0, 8)}`;

    // Check if already exists in SSO
    const existing = await ssoQuery('SELECT id FROM sso_users WHERE username = $1', [username]);
    if (existing.length > 0) continue;

    // Create in SSO with a temporary password
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('changeme123', 10);
    await ssoQuery(
      `INSERT INTO sso_users (username, display_name, email, password_hash, role, status, tags)
       VALUES ($1, $2, $3, $4, 'doc', 'active', ARRAY['fhir-imported'])`,
      [username, `${fname} ${lname}`.trim(), email, hash]
    );

    // Tag the FHIR Practitioner with the SSO identifier
    p.identifier = p.identifier || [];
    p.identifier.push({ system: MEDSEAL_IDENTIFIER_SYSTEM, value: username });
    await fhirPut(`Practitioner/${p.id}`, p);

    log('INFO', `FHIR->SSO: Created user ${username} from Practitioner/${p.id}`, { direction: 'fhir->sso' });
    synced++;
  }
  return synced;
}

// ══════════════════════════════════════════════════════════
//  DIRECTION 3: SSO → OpenEMR (user accounts)
// ══════════════════════════════════════════════════════════
const ROLE_GROUP_MAP = { admin: 11, clin: 12, doc: 13, front: 14, back: 15, breakglass: 16 };
const OPENEMR_SSO_PASSWORD_HASH = '$2y$10$YQnEfbNz8F3fEgLRTfJEoOnXZH08BXfC3S87q0AA54KEdzrtXtTyG';

async function syncSSOToOpenEMR() {
  const users = await ssoQuery("SELECT username, display_name, email, role, status, facility_id FROM sso_users WHERE status = 'active'");
  let synced = 0;

  for (const u of users) {
    const parts = (u.display_name || u.username).trim().split(/\s+/);
    const lname = parts.pop() || '';
    const fname = parts.join(' ') || u.username;
    const authorized = ['admin', 'doc', 'clin'].includes(u.role) ? 1 : 0;
    const groupId = ROLE_GROUP_MAP[u.role] || ROLE_GROUP_MAP.front;

    const rows = await emrQuery('SELECT id FROM users WHERE username = ? LIMIT 1', [u.username]);
    const existing = first(rows);

    if (existing) {
      await emrQuery(
        'UPDATE users SET fname=?, lname=?, email=?, active=1, authorized=?, facility_id=? WHERE id=?',
        [fname, lname, u.email, authorized, u.facility_id || 0, existing.id]
      );
      await emrQuery('UPDATE users_secure SET password=?, last_update_password=NOW() WHERE id=?', [OPENEMR_SSO_PASSWORD_HASH, existing.id]);
    } else {
      const uuid = require('crypto').randomUUID().replace(/-/g, '');
      const insertResult = await emrQuery(
        `INSERT INTO users (username, password, uuid, fname, lname, email, authorized, active, calendar, facility_id)
         VALUES (?, 'NoLongerUsed', UNHEX(?), ?, ?, ?, ?, 1, 1, ?)`,
        [u.username, uuid, fname, lname, u.email, authorized, u.facility_id || 0]
      );
      const userId = insertResult?.insertId;
      if (userId) {
        await emrQuery(
          'INSERT INTO users_secure (id, username, password, last_update_password) VALUES (?, ?, ?, NOW())',
          [userId, u.username, OPENEMR_SSO_PASSWORD_HASH]
        );
        // ACL entry
        const maxAroRows = await emrQuery('SELECT MAX(id) as maxId FROM gacl_aro');
        const maxAro = first(maxAroRows);
        const aroId = (maxAro?.maxId || 10) + 1;
        await emrQuery(
          'INSERT INTO gacl_aro (id, section_value, value, order_value, name, hidden) VALUES (?, ?, ?, 10, ?, 0)',
          [aroId, 'users', u.username, u.display_name]
        );
        await emrQuery('INSERT INTO gacl_groups_aro_map (group_id, aro_id) VALUES (?, ?)', [groupId, aroId]);
        await emrQuery("INSERT INTO `groups` (`name`, `user`) VALUES ('Default', ?)", [u.username]);
      }
    }
    synced++;
  }
  return synced;
}

// ══════════════════════════════════════════════════════════
//  DIRECTION 4: FHIR → OpenEMR (clinical data)
// ══════════════════════════════════════════════════════════

function getPatientMap(rows) {
  const map = {};
  for (const r of rows) {
    const hex = r.uuid ? Buffer.from(r.uuid).toString('hex') : '';
    if (hex && r.pid) {
      const fhirId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
      map[fhirId] = r.pid;
    }
  }
  return map;
}

async function syncFHIRToOpenEMR(since) {
  const stats = { patients: 0, conditions: 0, meds: 0, allergies: 0, immunizations: 0, appointments: 0, encounters: 0, vitals: 0, soap: 0, procedures: 0, diagnostics: 0 };

  // Patient map
  const pRows = await emrQuery("SELECT uuid, pid FROM patient_data WHERE uuid IS NOT NULL");
  let patientMap = getPatientMap(pRows);

  // Patients
  const patients = await fetchSince('Patient', since);
  for (const p of patients) {
    const uuidHex = p.id.replace(/-/g, '');
    const name = p.name?.[0] || {};
    const fname = esc(cleanName(name.given?.[0] || ''));
    const lname = esc(cleanName(name.family || ''));
    const dob = p.birthDate || '';
    const sex = p.gender === 'male' ? 'Male' : p.gender === 'female' ? 'Female' : 'Unknown';
    const phone = p.telecom?.find(t => t.system === 'phone')?.value || '';
    const email = p.telecom?.find(t => t.system === 'email')?.value || '';
    const addr = p.address?.[0] || {};
    const identifiers = p.identifier || [];
    const mrnId = identifiers.find(i => i.type?.coding?.some(c => c.code === 'MR') || i.system?.includes('mrn'));
    const pubpid = esc(mrnId?.value || identifiers[0]?.value || p.id.substring(0, 8));

    const existRows = await emrQuery('SELECT pid FROM patient_data WHERE uuid = UNHEX(?) LIMIT 1', [uuidHex]);
    const exists = first(existRows);
    if (exists) {
      await emrQuery(
        `UPDATE patient_data SET fname=?, lname=?, DOB=?, sex=?, pubpid=?, phone_home=?, email=?,
         street=?, city=?, state=?, postal_code=?, country_code=? WHERE uuid=UNHEX(?)`,
        [fname, lname, dob, sex, pubpid, phone, email,
         addr.line?.[0] || '', addr.city || '', addr.state || '', addr.postalCode || '', addr.country || '', uuidHex]
      );
    } else {
      const maxPidRows = await emrQuery('SELECT IFNULL(MAX(pid), 0) + 1 as next FROM patient_data');
      const maxPid = first(maxPidRows);
      const newPid = maxPid?.next || 1;
      await emrQuery(
        `INSERT INTO patient_data (pid, uuid, pubpid, fname, lname, DOB, sex, phone_home, email,
         street, city, state, postal_code, country_code, date, title, language, financial, mname, drivers_license)
         VALUES (?, UNHEX(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), '', '', '', '', '')`,
        [newPid, uuidHex, pubpid, fname, lname, dob, sex, phone, email,
         addr.line?.[0] || '', addr.city || '', addr.state || '', addr.postalCode || '', addr.country || '']
      );
    }
    stats.patients++;
  }

  // Refresh map
  const pRows2 = await emrQuery("SELECT uuid, pid FROM patient_data WHERE uuid IS NOT NULL");
  patientMap = getPatientMap(pRows2);

  // Conditions
  try {
    const conditions = await fetchSince('Condition', since);
    for (const c of conditions) {
      const patId = (c.subject?.reference || '').replace('Patient/', '');
      const pid = patientMap[patId];
      if (!pid) continue;
      const title = (c.code?.text || c.code?.coding?.[0]?.display || 'Unknown').substring(0, 200);
      const icd = c.code?.coding?.find(cd => cd.system?.includes('icd') || cd.system?.includes('snomed'))?.code || '';
      const diagnosis = icd ? `ICD10:${icd}` : '';
      const begdate = c.onsetDateTime?.substring(0, 10) || c.recordedDate?.substring(0, 10) || '';
      const enddate = c.abatementDateTime?.substring(0, 10) || '';
      const activity = c.clinicalStatus?.coding?.[0]?.code === 'resolved' ? 0 : 1;

      const cRows = await emrQuery("SELECT id FROM lists WHERE type='medical_problem' AND pid=? AND title=? LIMIT 1", [pid, title]);
      const exists = first(cRows);
      if (!exists) {
        await emrQuery(
          "INSERT INTO lists (date, type, title, diagnosis, begdate, enddate, activity, pid, user, external_id) VALUES (NOW(), 'medical_problem', ?, ?, ?, ?, ?, ?, 'sync', ?)",
          [title, diagnosis, begdate, enddate, activity, pid, c.id]
        );
      } else {
        await emrQuery('UPDATE lists SET activity=?, enddate=? WHERE id=?', [activity, enddate, exists.id]);
      }
      stats.conditions++;
    }
  } catch (e) { log('WARN', `Conditions sync error: ${e.message}`); }

  // Medications
  try {
    const meds = await fetchSince('MedicationRequest', since);
    for (const m of meds) {
      const patId = (m.subject?.reference || '').replace('Patient/', '');
      const pid = patientMap[patId];
      if (!pid) continue;
      const drug = (m.medicationCodeableConcept?.text || m.medicationCodeableConcept?.coding?.[0]?.display || 'Unknown').substring(0, 200);
      const rxnorm = m.medicationCodeableConcept?.coding?.find(c => c.system?.includes('rxnorm'))?.code || '';
      const dosage = (m.dosageInstruction?.[0]?.text || '').substring(0, 100);
      const start = m.authoredOn?.substring(0, 10) || '';
      const active = m.status === 'active' ? 1 : 0;

      const mRows = await emrQuery('SELECT id FROM prescriptions WHERE patient_id=? AND drug=? LIMIT 1', [pid, drug]);
      const exists = first(mRows);
      if (!exists) {
        await emrQuery(
          "INSERT INTO prescriptions (patient_id, date_added, provider_id, drug, rxnorm_drugcode, dosage, start_date, active, medication, external_id) VALUES (?, NOW(), 1, ?, ?, ?, ?, ?, 1, ?)",
          [pid, drug, rxnorm, dosage, start, active, m.id]
        );
      } else {
        await emrQuery('UPDATE prescriptions SET active=? WHERE id=?', [active, exists.id]);
      }
      stats.meds++;
    }
  } catch (e) { log('WARN', `Medications sync error: ${e.message}`); }

  // Allergies
  try {
    const allergies = await fetchSince('AllergyIntolerance', since);
    for (const a of allergies) {
      const patId = (a.patient?.reference || '').replace('Patient/', '');
      const pid = patientMap[patId];
      if (!pid) continue;
      const title = (a.code?.text || a.code?.coding?.[0]?.display || 'Unknown Allergy').substring(0, 200);
      const severity = a.reaction?.[0]?.severity || '';
      const begdate = a.onsetDateTime?.substring(0, 10) || a.recordedDate?.substring(0, 10) || '';
      const active = a.clinicalStatus?.coding?.[0]?.code === 'inactive' ? 0 : 1;

      const aRows = await emrQuery("SELECT id FROM lists WHERE type='allergy' AND pid=? AND title=? LIMIT 1", [pid, title]);
      const exists = first(aRows);
      if (!exists) {
        await emrQuery(
          "INSERT INTO lists (date, type, title, begdate, activity, pid, user, severity_al, external_id) VALUES (NOW(), 'allergy', ?, ?, ?, ?, 'sync', ?, ?)",
          [title, begdate, active, pid, severity, a.id]
        );
      } else {
        await emrQuery('UPDATE lists SET activity=? WHERE id=?', [active, exists.id]);
      }
      stats.allergies++;
    }
  } catch (e) { log('WARN', `Allergies sync error: ${e.message}`); }

  // Immunizations
  try {
    const imms = await fetchSince('Immunization', since);
    for (const im of imms) {
      const patId = (im.patient?.reference || '').replace('Patient/', '');
      const pid = patientMap[patId];
      if (!pid) continue;
      const vaccine = (im.vaccineCode?.text || im.vaccineCode?.coding?.[0]?.display || 'Unknown').substring(0, 200);
      const cvx = im.vaccineCode?.coding?.find(c => c.system?.includes('cvx'))?.code || '';
      const date = im.occurrenceDateTime?.substring(0, 10) || '';

      const iRows = await emrQuery(
        "SELECT id FROM immunizations WHERE patient_id=? AND cvx_code=? AND administered_date=? LIMIT 1",
        [pid, cvx, date]
      );
      const exists = first(iRows);
      if (!exists) {
        await emrQuery(
          "INSERT INTO immunizations (patient_id, administered_date, immunization_id, cvx_code, note, added_erroneously, external_id) VALUES (?, ?, 0, ?, ?, 0, ?)",
          [pid, date, cvx, vaccine, im.id]
        );
      }
      stats.immunizations++;
    }
  } catch (e) { log('WARN', `Immunizations sync error: ${e.message}`); }

  // Encounters
  try {
    const encounters = await fetchSince('Encounter', since);
    let encNumResult = await emrQuery("SELECT IFNULL(MAX(encounter),0) as mx FROM form_encounter");
    let encNum = (first(encNumResult)?.mx || 0) + 1;
    for (const enc of encounters) {
      const patId = (enc.subject?.reference || '').replace('Patient/', '');
      const pid = patientMap[patId];
      if (!pid) continue;
      const fhirId = enc.id.substring(0, 20);
      const eRows = await emrQuery('SELECT encounter FROM form_encounter WHERE external_id=? LIMIT 1', [fhirId]);
      if (first(eRows)) continue;
      const date = enc.period?.start ? new Date(enc.period.start).toISOString().replace('T', ' ').substring(0, 19) : '2024-01-01 08:00:00';
      const reason = (enc.reasonCode?.[0]?.text || enc.type?.[0]?.text || enc.class?.display || 'Encounter').substring(0, 255);
      // Resolve practitioner and their specialty-based facility
      const practRef = enc.participant?.find(p => p.individual?.reference?.startsWith('Practitioner/'))?.individual?.reference || '';
      const practFhirId = practRef.replace('Practitioner/', '');
      let encProviderId = 1;
      let encFacilityId = 3; // default
      let encFacilityName = 'Med-SEAL General Hospital';
      if (practFhirId && practitionerMap[practFhirId]) {
        encProviderId = practitionerMap[practFhirId];
        const provFacRows = await emrQuery('SELECT u.facility_id, f.name FROM users u LEFT JOIN facility f ON f.id = u.facility_id WHERE u.id=? LIMIT 1', [encProviderId]);
        const provFac = first(provFacRows);
        if (provFac?.facility_id > 0) {
          encFacilityId = provFac.facility_id;
          encFacilityName = provFac.name || encFacilityName;
        }
      }
      const thisEnc = encNum++;
      await emrQuery('INSERT INTO form_encounter (date, reason, facility, facility_id, pid, encounter, onset_date, provider_id, external_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [date, reason, encFacilityName, encFacilityId, pid, thisEnc, date, encProviderId, fhirId]);
      await emrQuery("INSERT INTO forms (date, encounter, form_name, form_id, pid, user, groupname, authorized, deleted, formdir) VALUES (?, ?, 'New Patient Encounter', 0, ?, 'sync', 'Default', 1, 0, 'newpatient')", [date, thisEnc, pid]);
      stats.encounters++;
    }
  } catch(e) { log('WARN', `Encounters sync error: ${e.message}`); }

  // Vitals
  try {
    const vitals = await fetchSince('Observation?category=vital-signs', since);
    const vitalsByPatDate = {};
    for (const obs of vitals) {
      const patId = (obs.subject?.reference || '').replace('Patient/', '');
      const pid = patientMap[patId];
      if (!pid) continue;
      const dateStr = obs.effectiveDateTime?.substring(0, 10) || '';
      if (!dateStr) continue;
      const key = `${pid}|${dateStr}`;
      if (!vitalsByPatDate[key]) vitalsByPatDate[key] = { pid, date: dateStr, bps: '', bpd: '', pulse: 0, respiration: 0, temperature: 0, weight: 0, height: 0, oxygen_saturation: 0 };
      const v = vitalsByPatDate[key];
      const code = obs.code?.coding?.[0]?.code || '';
      if (code === '85354-9' || code === '55284-4') {
        for (const comp of (obs.component || [])) {
          const cc = comp.code?.coding?.[0]?.code || '';
          if (cc === '8480-6') v.bps = String(comp.valueQuantity?.value || '');
          if (cc === '8462-4') v.bpd = String(comp.valueQuantity?.value || '');
        }
      } else if (code === '8867-4') v.pulse = obs.valueQuantity?.value || 0;
      else if (code === '9279-1') v.respiration = obs.valueQuantity?.value || 0;
      else if (code === '8310-5') v.temperature = obs.valueQuantity?.value || 0;
      else if (code === '29463-7') v.weight = obs.valueQuantity?.value || 0;
      else if (code === '8302-2') v.height = obs.valueQuantity?.value || 0;
      else if (code === '2708-6' || code === '59408-5') v.oxygen_saturation = obs.valueQuantity?.value || 0;
      else if (code === '8480-6') v.bps = String(obs.valueQuantity?.value || '');
      else if (code === '8462-4') v.bpd = String(obs.valueQuantity?.value || '');
    }
    for (const [, v] of Object.entries(vitalsByPatDate)) {
      const vRows = await emrQuery('SELECT id FROM form_vitals WHERE pid=? AND DATE(date)=? LIMIT 1', [v.pid, v.date]);
      if (first(vRows)) continue;
      const dt = `${v.date} 08:00:00`;
      const result = await emrQuery('INSERT INTO form_vitals (date, pid, user, groupname, authorized, activity, bps, bpd, weight, height, temperature, pulse, respiration, oxygen_saturation) VALUES (?, ?, "sync", "Default", 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)', [dt, v.pid, v.bps, v.bpd, v.weight, v.height, v.temperature, v.pulse, v.respiration, v.oxygen_saturation]);
      const formId = result.insertId;
      if (formId) {
        const encRows = await emrQuery('SELECT encounter FROM form_encounter WHERE pid=? AND DATE(date)<=? ORDER BY date DESC LIMIT 1', [v.pid, v.date]);
        let encId = first(encRows)?.encounter;
        if (!encId) {
          const firstEncRows = await emrQuery('SELECT encounter FROM form_encounter WHERE pid=? ORDER BY date ASC LIMIT 1', [v.pid]);
          encId = first(firstEncRows)?.encounter || 0;
        }
        await emrQuery('INSERT INTO forms (date, encounter, form_name, form_id, pid, user, groupname, authorized, deleted, formdir, provider_id) VALUES (?, ?, "Vitals", ?, ?, "sync", "Default", 1, 0, "vitals", 1)', [dt, encId, formId, v.pid]);
      }
      stats.vitals++;
    }
  } catch(e) { log('WARN', `Vitals sync error: ${e.message}`); }

  // SOAP
  try {
    const soapDocs = await fetchSince('DocumentReference?type=http://loinc.org|34109-9', since);
    for (const doc of soapDocs) {
      const patId = (doc.subject?.reference || '').replace('Patient/', '');
      const pid = patientMap[patId];
      if (!pid) continue;
      const content = doc.content?.[0]?.attachment?.data;
      if (!content) continue;
      const text = Buffer.from(content, 'base64').toString('utf8');
      const sMatch = text.match(/SUBJECTIVE:\n([\s\S]*?)(?=\nOBJECTIVE:)/);
      const oMatch = text.match(/OBJECTIVE:\n([\s\S]*?)(?=\nASSESSMENT:)/);
      const aMatch = text.match(/ASSESSMENT:\n([\s\S]*?)(?=\nPLAN:)/);
      const pMatch = text.match(/PLAN:\n([\s\S]*?)(?=\n={5,}|$)/);
      if (!sMatch && !oMatch && !aMatch && !pMatch) continue;
      const date = doc.date ? new Date(doc.date).toISOString().replace('T', ' ').substring(0, 19) : '2024-01-01 08:00:00';
      const dateShort = date.substring(0, 10);
      const sRows = await emrQuery('SELECT id FROM form_soap WHERE pid=? AND DATE(date)=? LIMIT 1', [pid, dateShort]);
      if (first(sRows)) continue;
      const result = await emrQuery('INSERT INTO form_soap (date, pid, user, groupname, authorized, activity, subjective, objective, assessment, plan) VALUES (?, ?, "sync", "Default", 1, 1, ?, ?, ?, ?)', [date, pid, sMatch?.[1]?.trim() || '', oMatch?.[1]?.trim() || '', aMatch?.[1]?.trim() || '', pMatch?.[1]?.trim() || '']);
      const formId = result.insertId;
      if (formId) {
        const encRows = await emrQuery('SELECT encounter FROM form_encounter WHERE pid=? AND DATE(date)<=? ORDER BY date DESC LIMIT 1', [pid, dateShort]);
        let encId = first(encRows)?.encounter;
        if (!encId) {
          const firstEncRows = await emrQuery('SELECT encounter FROM form_encounter WHERE pid=? ORDER BY date ASC LIMIT 1', [pid]);
          encId = first(firstEncRows)?.encounter || 0;
        }
        await emrQuery('INSERT INTO forms (date, encounter, form_name, form_id, pid, user, groupname, authorized, deleted, formdir, provider_id) VALUES (?, ?, "SOAP", ?, ?, "sync", "Default", 1, 0, "soap", 1)', [date, encId, formId, pid]);
      }
      stats.soap++;
    }
  } catch(e) { log('WARN', `SOAP sync error: ${e.message}`); }

  // Procedures
  try {
    const procedures = await fetchSince('Procedure', since);
    for (const proc of procedures) {
      const patId = (proc.subject?.reference || '').replace('Patient/', '');
      const pid = patientMap[patId];
      if (!pid) continue;
      const title = (proc.code?.text || proc.code?.coding?.[0]?.display || 'Procedure').substring(0, 200);
      const snomedCode = proc.code?.coding?.find(c => c.system?.includes('snomed'))?.code || '';
      const date = proc.performedDateTime?.substring(0, 10) || proc.performedPeriod?.start?.substring(0, 10) || '';
      const pRows = await emrQuery("SELECT id FROM lists WHERE type='surgery' AND pid=? AND title=? AND begdate=? LIMIT 1", [pid, title, date]);
      if (!first(pRows)) {
        await emrQuery("INSERT INTO lists (date, type, title, diagnosis, begdate, activity, pid, user) VALUES (NOW(), 'surgery', ?, ?, ?, 1, ?, 'sync')", [title, snomedCode ? 'SNOMED:' + snomedCode : '', date, pid]);
        stats.procedures++;
      }
    }
  } catch(e) { log('WARN', `Procedures sync error: ${e.message}`); }

  // DiagReports
  try {
    const diagGrp = await fetchSince('DiagnosticReport', since);
    for (const rpt of diagGrp) {
      const patId = (rpt.subject?.reference || '').replace('Patient/', '');
      const pid = patientMap[patId];
      if (!pid) continue;
      const title = (rpt.code?.text || rpt.code?.coding?.[0]?.display || 'Lab Report').substring(0, 200);
      const date = rpt.effectiveDateTime?.substring(0, 10) || rpt.issued?.substring(0, 10) || '';
      const rRows = await emrQuery('SELECT procedure_order_id FROM procedure_order WHERE patient_id=? AND order_diagnosis=? AND date_ordered=? LIMIT 1', [pid, title, date]);
      if (!first(rRows)) {
        const encRows = await emrQuery('SELECT encounter FROM form_encounter WHERE pid=? AND DATE(date)<=? ORDER BY date DESC LIMIT 1', [pid, date]);
        let encId = first(encRows)?.encounter;
        if (!encId) {
          const firstEncRows = await emrQuery('SELECT encounter FROM form_encounter WHERE pid=? ORDER BY date ASC LIMIT 1', [pid]);
          encId = first(firstEncRows)?.encounter || 0;
        }
        await emrQuery("INSERT INTO procedure_order (provider_id, patient_id, encounter_id, date_ordered, order_priority, order_status, order_diagnosis, activity) VALUES (1, ?, ?, ?, 'normal', 'complete', ?, 1)", [pid, encId, date, title]);
        stats.diagnostics++;
      }
    }
  } catch(e) { log('WARN', `DiagReports sync error: ${e.message}`); }

  // Appointments (FHIR → OpenEMR)
  try {
    const practitionerMap = await buildPractitionerMap();
    const appts = await fetchSince('Appointment', since);
    for (const a of appts) {
      upsertAppointmentToEMR(a, patientMap, practitionerMap);
      stats.appointments++;
    }
  } catch (e) { log('WARN', `Appointments sync error: ${e.message}`); }

  return stats;
}

const FHIR_STATUS_MAP = {
  'booked': '-', 'arrived': '>', 'fulfilled': 'x',
  'noshow': '?', 'cancelled': '%', 'pending': '-',
};

async function upsertAppointmentToEMR(appt, patientMap, practitionerMap) {
  const fhirId = appt.id;
  const title = (appt.description || appt.serviceType?.[0]?.text || 'Appointment').substring(0, 150);
  const status = FHIR_STATUS_MAP[appt.status] || '-';
  const patRef = appt.participant?.find(p => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference || '';
  const patFhirId = patRef.replace('Patient/', '');
  const pid = patientMap[patFhirId];
  if (!pid) return;
  const practRef = appt.participant?.find(p => p.actor?.reference?.startsWith('Practitioner/'))?.actor?.reference || '';
  const practFhirId = practRef.replace('Practitioner/', '');
  const aid = (practFhirId && practitionerMap[practFhirId]) ? practitionerMap[practFhirId] : 1;
  const startDt = appt.start ? new Date(appt.start) : null;
  const endDt = appt.end ? new Date(appt.end) : null;
  if (!startDt) return;
  const eventDate = startDt.toISOString().substring(0, 10);
  const startTime = startDt.toISOString().substring(11, 19);
  const durationSec = endDt ? Math.round((endDt - startDt) / 1000) : 1800;
  const comments = (appt.comment || appt.patientInstruction || '').substring(0, 500);

  const eRows = await emrQuery("SELECT pc_eid FROM openemr_postcalendar_events WHERE pc_external_id=? LIMIT 1", [fhirId]);
  const existing = first(eRows);
  if (existing) {
    await emrQuery(
      "UPDATE openemr_postcalendar_events SET pc_title=?, pc_eventDate=?, pc_startTime=?, pc_duration=?, pc_apptstatus=?, pc_hometext=?, pc_aid=? WHERE pc_external_id=?",
      [title, eventDate, startTime, durationSec, status, comments, aid, fhirId]
    );
  } else {
    await emrQuery(
      `INSERT INTO openemr_postcalendar_events
       (pc_pid, pc_aid, pc_title, pc_time, pc_eventDate, pc_endDate, pc_startTime, pc_duration, pc_apptstatus, pc_hometext, pc_external_id, pc_catid, pc_alldayevent, pc_recurrtype, pc_recurrfreq, pc_facility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 9, 0, 0, 0, 3)`,
      [pid, aid, title, `${eventDate} ${startTime}`, eventDate, eventDate, startTime, durationSec, status, comments, fhirId]
    );
  }
}

async function buildPractitionerMap() {
  const token = await getToken();
  const map = {};
  let url = `${MEDPLUM_BASE}/fhir/R4/Practitioner?_count=200&_elements=id,name`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const bundle = await res.json();
    for (const e of (bundle.entry || [])) {
      const p = e.resource;
      const nameObj = p.name?.[0] || {};
      const fname = cleanName(nameObj.given?.[0] || '').toLowerCase();
      const lname = cleanName(nameObj.family || '').toLowerCase();
      if (!lname) continue;
      const rows = await emrQuery(
        "SELECT id FROM users WHERE LOWER(fname)=? AND LOWER(lname)=? AND active=1 LIMIT 1",
        [fname, lname]
      );
      if (rows.length > 0) map[p.id] = rows[0].id;
    }
    const next = (bundle.link || []).find(l => l.relation === 'next');
    url = next ? next.url : null;
  }
  return map;
}

// ══════════════════════════════════════════════════════════
//  DIRECTION 5: OpenEMR → FHIR (Encounters + SOAP)
// ══════════════════════════════════════════════════════════
async function pushEncountersToFHIR() {
  const token = await getToken();
  const sinceDate = new Date(Date.now() - 30 * 86400000).toISOString().substring(0, 10);
  const rows = await emrQuery(`
    SELECT fe.encounter, fe.pid, fe.date, fe.reason, fe.provider_id, fe.facility,
           fs.subjective, fs.objective, fs.assessment, fs.plan,
           LOWER(HEX(p.uuid)) as fhir_uuid,
           u.fname as dr_fname, u.lname as dr_lname
    FROM form_encounter fe
    LEFT JOIN form_soap fs ON fs.pid = fe.pid AND DATE(fs.date) = DATE(fe.date) AND fs.activity = 1
    JOIN patient_data p ON p.pid = fe.pid
    LEFT JOIN users u ON u.id = fe.provider_id
    WHERE fe.fhir_id IS NULL AND fe.date >= ? AND p.uuid IS NOT NULL
    ORDER BY fe.date ASC LIMIT 20
  `, [sinceDate]);

  let pushed = 0;
  for (const row of rows) {
    const h = row.fhir_uuid;
    if (!h || h.length !== 32) continue;
    const patFhirId = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;

    try {
      const encDate = new Date(row.date);
      const encEnd = new Date(encDate.getTime() + 30 * 60000);

      // Look up practitioner
      let practitionerRef = null;
      if (row.dr_fname && row.dr_lname) {
        try {
          const pr = await fhirGet(`Practitioner?name=${encodeURIComponent(row.dr_lname)}&_count=5`);
          const match = (pr?.entry || []).find(e => e.resource?.name?.[0]?.family?.toLowerCase() === row.dr_lname.toLowerCase());
          if (match) practitionerRef = match.resource.id;
        } catch (_) {}
      }

      const participant = row.dr_fname && row.dr_lname ? [{
        individual: {
          ...(practitionerRef ? { reference: `Practitioner/${practitionerRef}` } : {}),
          display: `Dr. ${row.dr_fname} ${row.dr_lname}`,
        },
      }] : [];

      const encBody = {
        resourceType: 'Encounter',
        status: 'finished',
        class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
        type: row.reason ? [{ text: row.reason }] : [],
        subject: { reference: `Patient/${patFhirId}` },
        period: { start: encDate.toISOString(), end: encEnd.toISOString() },
        reasonCode: row.reason ? [{ text: row.reason }] : [],
        ...(row.facility ? { location: [{ location: { display: row.facility } }] } : {}),
        ...(participant.length ? { participant } : {}),
      };

      const encRes = await fhirPost('Encounter', encBody);
      if (!encRes.ok) continue;
      const encFhirId = encRes.data?.id;

      // Push SOAP note as DocumentReference
      if (row.subjective || row.objective || row.assessment || row.plan) {
        const soapText = [
          row.subjective ? `SUBJECTIVE:\n${row.subjective}` : '',
          row.objective ? `\nOBJECTIVE:\n${row.objective}` : '',
          row.assessment ? `\nASSESSMENT:\n${row.assessment}` : '',
          row.plan ? `\nPLAN:\n${row.plan}` : '',
        ].filter(Boolean).join('\n');

        await fhirPost('DocumentReference', {
          resourceType: 'DocumentReference',
          status: 'current',
          type: { coding: [{ system: 'http://loinc.org', code: '34109-9', display: 'Note' }], text: 'SOAP Note' },
          subject: { reference: `Patient/${patFhirId}` },
          date: encDate.toISOString(),
          description: `SOAP Note - ${row.reason || 'Encounter'} (${encDate.toISOString().substring(0,10)})`,
          context: { encounter: [{ reference: `Encounter/${encFhirId}` }] },
          content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(soapText).toString('base64'), title: `SOAP Note - ${encDate.toISOString().substring(0,10)}` } }],
        });
      }

      // Mark as pushed
      await emrQuery('UPDATE form_encounter SET fhir_id=? WHERE encounter=?', [encFhirId, row.encounter]);

      // Update FHIR Appointment status to fulfilled
      try {
        const encDateStr = encDate.toISOString().substring(0, 10);
        const apptSearch = await fhirGet(`Appointment?actor=Patient/${patFhirId}&date=ge${encDateStr}T00:00:00&date=le${encDateStr}T23:59:59&_count=5`);
        for (const entry of (apptSearch?.entry || [])) {
          const appt = entry.resource;
          if (appt.status === 'booked' || appt.status === 'arrived') {
            await fhirPut(`Appointment/${appt.id}`, { ...appt, status: 'fulfilled' });
            await emrQuery("UPDATE openemr_postcalendar_events SET pc_apptstatus='>' WHERE pc_external_id=?", [appt.id]);
          }
        }
      } catch (_) {}

      pushed++;
    } catch (e) { /* retry next cycle */ }
  }
  return pushed;
}

// ══════════════════════════════════════════════════════════
//  DIRECTION 6: OpenEMR → FHIR (Vitals for Patient App)
// ══════════════════════════════════════════════════════════
async function pushVitalsToFHIR() {
  const token = await getToken();
  const sinceDate = new Date(Date.now() - 7 * 86400000).toISOString().substring(0, 10);

  const rows = await emrQuery(`
    SELECT fv.id, fv.pid, fv.date, fv.bps, fv.bpd, fv.pulse, fv.respiration,
           fv.temperature, fv.weight, fv.height, fv.BMI, fv.oxygen_saturation,
           LOWER(HEX(p.uuid)) as fhir_uuid
    FROM form_vitals fv
    JOIN patient_data p ON p.pid = fv.pid
    WHERE fv.date >= ? AND p.uuid IS NOT NULL
    ORDER BY fv.date DESC LIMIT 50
  `, [sinceDate]);

  let pushed = 0;
  const VITAL_LOINC = {
    bp:    { code: '85354-9', display: 'Blood pressure panel' },
    pulse: { code: '8867-4', display: 'Heart rate' },
    resp:  { code: '9279-1', display: 'Respiratory rate' },
    temp:  { code: '8310-5', display: 'Body temperature' },
    weight:{ code: '29463-7', display: 'Body weight' },
    height:{ code: '8302-2', display: 'Body height' },
    bmi:   { code: '39156-5', display: 'Body mass index' },
    spo2:  { code: '2708-6', display: 'Oxygen saturation' },
  };

  for (const v of rows) {
    const h = v.fhir_uuid;
    if (!h || h.length !== 32) continue;
    const patFhirId = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    const effectiveDate = new Date(v.date).toISOString();
    const identifierBase = `oemr-vitals-${v.id}`;

    // Blood Pressure (composite observation)
    if (v.bps && v.bpd) {
      const bpId = `${identifierBase}-bp`;
      const existing = await fhirGet(`Observation?identifier=${encodeURIComponent(`https://medseal.io/openemr/vitals|${bpId}`)}&_count=1`);
      if (!(existing?.entry?.length > 0)) {
        await fhirPost('Observation', {
          resourceType: 'Observation', status: 'final',
          identifier: [{ system: 'https://medseal.io/openemr/vitals', value: bpId }],
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
          code: { coding: [{ system: 'http://loinc.org', ...VITAL_LOINC.bp }] },
          subject: { reference: `Patient/${patFhirId}` },
          effectiveDateTime: effectiveDate,
          component: [
            { code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] }, valueQuantity: { value: parseFloat(v.bps), unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } },
            { code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic blood pressure' }] }, valueQuantity: { value: parseFloat(v.bpd), unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } },
          ],
        });
        pushed++;
      }
    }

    // Simple vitals
    const simpleVitals = [
      { key: 'pulse', loinc: VITAL_LOINC.pulse, value: v.pulse, unit: '/min', code: '/min' },
      { key: 'resp', loinc: VITAL_LOINC.resp, value: v.respiration, unit: '/min', code: '/min' },
      { key: 'temp', loinc: VITAL_LOINC.temp, value: v.temperature, unit: 'degF', code: '[degF]' },
      { key: 'weight', loinc: VITAL_LOINC.weight, value: v.weight, unit: 'kg', code: 'kg' },
      { key: 'height', loinc: VITAL_LOINC.height, value: v.height, unit: 'cm', code: 'cm' },
      { key: 'bmi', loinc: VITAL_LOINC.bmi, value: v.BMI, unit: 'kg/m2', code: 'kg/m2' },
      { key: 'spo2', loinc: VITAL_LOINC.spo2, value: v.oxygen_saturation, unit: '%', code: '%' },
    ];

    for (const sv of simpleVitals) {
      if (!sv.value) continue;
      const vid = `${identifierBase}-${sv.key}`;
      const existing = await fhirGet(`Observation?identifier=${encodeURIComponent(`https://medseal.io/openemr/vitals|${vid}`)}&_count=1`);
      if (existing?.entry?.length > 0) continue;
      await fhirPost('Observation', {
        resourceType: 'Observation', status: 'final',
        identifier: [{ system: 'https://medseal.io/openemr/vitals', value: vid }],
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', ...sv.loinc }] },
        subject: { reference: `Patient/${patFhirId}` },
        effectiveDateTime: effectiveDate,
        valueQuantity: { value: parseFloat(sv.value), unit: sv.unit, system: 'http://unitsofmeasure.org', code: sv.code },
      });
      pushed++;
    }
  }
  return pushed;
}

// ══════════════════════════════════════════════════════════
//  Deletion detection
// ══════════════════════════════════════════════════════════
async function detectDeletedPatients(patientMap) {
  const fhirIds = await fetchAllIds('Patient');
  let deleted = 0;
  for (const [fhirId, pid] of Object.entries(patientMap)) {
    if (!fhirIds.has(fhirId)) {
      await emrQuery(
        "UPDATE patient_data SET deceased_date=NOW(), deceased_reason='Removed from FHIR' WHERE pid=? AND (deceased_date IS NULL OR deceased_date='')",
        [pid]
      );
      log('WARN', `Patient PID ${pid} deleted from FHIR - deactivated in OpenEMR`, { direction: 'fhir->openemr', pid });
      deleted++;
    }
  }
  return deleted;
}

// ══════════════════════════════════════════════════════════
//  Schema Migrations
// ══════════════════════════════════════════════════════════
async function ensureSchema() {
  // OpenEMR: external_id columns
  const tables = [['lists', 'external_id'], ['prescriptions', 'external_id'], ['immunizations', 'external_id']];
  for (const [table, col] of tables) {
    const rows = await emrQuery(`SHOW COLUMNS FROM ${table} LIKE ?`, [col]);
    if (!rows || (Array.isArray(rows) && rows.length === 0)) {
      await emrQuery(`ALTER TABLE ${table} ADD COLUMN ${col} VARCHAR(64) DEFAULT NULL`);
      log('INFO', `Added ${col} column to ${table}`);
    }
  }
  // Appointment external key
  const extIdRows = await emrQuery("SHOW COLUMNS FROM openemr_postcalendar_events LIKE 'pc_external_id'");
  if (!extIdRows || (Array.isArray(extIdRows) && extIdRows.length === 0)) {
    try {
      await emrPool.query("ALTER TABLE openemr_postcalendar_events ADD COLUMN pc_external_id VARCHAR(64) DEFAULT NULL");
      await emrPool.query("ALTER TABLE openemr_postcalendar_events ADD INDEX idx_pc_external_id (pc_external_id)");
      log('INFO', 'Added pc_external_id to openemr_postcalendar_events');
    } catch (e) {
      if (!e.message.includes('Duplicate column')) log('WARN', `pc_external_id migration: ${e.message}`);
    }
  }
  // Encounter FHIR ID
  const fhirIdRows = await emrQuery("SHOW COLUMNS FROM form_encounter LIKE 'fhir_id'");
  if (!fhirIdRows || (Array.isArray(fhirIdRows) && fhirIdRows.length === 0)) {
    try {
      await emrPool.query("ALTER TABLE form_encounter ADD COLUMN fhir_id VARCHAR(64) DEFAULT NULL");
      log('INFO', 'Added fhir_id to form_encounter');
    } catch (e) {
      if (!e.message.includes('Duplicate column')) log('WARN', `fhir_id migration: ${e.message}`);
    }
  }
}

// ══════════════════════════════════════════════════════════
//  Main Sync Loop
// ══════════════════════════════════════════════════════════
let lastSyncTime = null;

async function runSyncCycle(cycleNum) {
  const start = Date.now();
  const since = lastSyncTime || new Date(Date.now() - 7 * 86400000).toISOString();
  const sinceFmt = since.substring(0, 19);

  log('INFO', `Sync cycle #${cycleNum} started`, { since: sinceFmt, cycle: cycleNum });

  try {
    const cycleStart = new Date().toISOString();

    // Direction 1: SSO → FHIR
    const ssoToFhir = await syncSSOToFHIR();
    if (ssoToFhir) log('INFO', `SSO->FHIR: ${ssoToFhir} practitioner(s) synced`, { direction: 'sso->fhir', count: ssoToFhir });

    // Direction 2: FHIR → SSO
    const fhirToSso = await syncFHIRToSSO();
    if (fhirToSso) log('INFO', `FHIR->SSO: ${fhirToSso} practitioner(s) imported`, { direction: 'fhir->sso', count: fhirToSso });

    // Direction 3: SSO → OpenEMR
    const ssoToEmr = await syncSSOToOpenEMR();
    if (ssoToEmr) log('INFO', `SSO->OpenEMR: ${ssoToEmr} user(s) synced`, { direction: 'sso->openemr', count: ssoToEmr });

    // Direction 4: FHIR → OpenEMR
    const fhirToEmr = await syncFHIRToOpenEMR(sinceFmt);
    const fhirTotal = Object.values(fhirToEmr).reduce((a, b) => a + b, 0);
    if (fhirTotal) log('INFO', `FHIR->OpenEMR: ${JSON.stringify(fhirToEmr)}`, { direction: 'fhir->openemr', ...fhirToEmr });

    // Direction 5: OpenEMR → FHIR (encounters)
    const encPushed = await pushEncountersToFHIR();
    if (encPushed) log('INFO', `OpenEMR->FHIR: ${encPushed} encounter(s) pushed`, { direction: 'openemr->fhir', count: encPushed });

    // Direction 6: OpenEMR → FHIR (vitals for Patient App)
    const vitalsPushed = await pushVitalsToFHIR();
    if (vitalsPushed) log('INFO', `OpenEMR->FHIR: ${vitalsPushed} vital(s) pushed (visible in Patient App)`, { direction: 'openemr->fhir', count: vitalsPushed });

    // Deletion detection
    const pRows = await emrQuery("SELECT uuid, pid FROM patient_data WHERE uuid IS NOT NULL");
    const patientMap = getPatientMap(pRows);
    const deleted = await detectDeletedPatients(patientMap);
    if (deleted) log('WARN', `${deleted} patient(s) deactivated (deleted from FHIR)`, { direction: 'deletion', count: deleted });

    lastSyncTime = cycleStart;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log('INFO', `Sync cycle #${cycleNum} completed in ${elapsed}s`, {
      cycle: cycleNum, elapsed, ssoToFhir, fhirToSso, ssoToEmr, ...fhirToEmr, encPushed, vitalsPushed, deleted,
    });
  } catch (err) {
    log('ERROR', `Sync cycle #${cycleNum} failed: ${err.message}`, { cycle: cycleNum, error: err.message });
  }
}

async function main() {
  log('INFO', '========================================');
  log('INFO', 'Med-SEAL Enterprise Sync Service');
  log('INFO', '========================================');
  log('INFO', `Interval: ${INTERVAL}s | Medplum: ${MEDPLUM_BASE}`);

  initPools();
  await ensureSchema();

  let cycle = 1;
  await runSyncCycle(cycle++);

  setInterval(async () => {
    await runSyncCycle(cycle++);
  }, INTERVAL * 1000);

  log('INFO', `Next sync in ${INTERVAL}s`);
}

main().catch(e => {
  log('ERROR', `Fatal: ${e.message}`);
  process.exit(1);
});
