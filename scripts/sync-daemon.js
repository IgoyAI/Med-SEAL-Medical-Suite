#!/usr/bin/env node
/**
 * Med-SEAL Continuous Sync Daemon
 * Medplum FHIR → OpenEMR (real-time delta sync)
 *
 * Features:
 *  - Polls Medplum every SYNC_INTERVAL_SECONDS (default 30s)
 *  - Detects NEW and UPDATED resources via _lastUpdated filter
 *  - Detects DELETED patients by comparing FHIR UUID list vs OpenEMR (soft-delete)
 *  - Handles: Patients, Conditions, MedicationRequests, Allergies, Immunizations, Encounters
 *
 * Usage:
 *   node scripts/sync-daemon.js
 *   SYNC_INTERVAL_SECONDS=60 node scripts/sync-daemon.js
 */

const { execSync } = require('child_process');

const MEDPLUM_BASE       = process.env.MEDPLUM_BASE_URL || 'http://localhost:8103';
const CONTAINER          = 'medseal-openemr-db';
const DB                 = 'openemr';
const INTERVAL_SECONDS   = parseInt(process.env.SYNC_INTERVAL_SECONDS || '30', 10);
const MEDPLUM_EMAIL      = process.env.MEDPLUM_EMAIL    || 'admin@example.com';
const MEDPLUM_PASSWORD   = process.env.MEDPLUM_PASSWORD || 'medplum_admin';

// ══════════════════════════════════════════════
//  DB helpers
// ══════════════════════════════════════════════
function sql(query) {
    const escaped = query.replace(/"/g, '\\"').replace(/`/g, '\\`');
    try {
        return execSync(
            `docker exec ${CONTAINER} mariadb -u openemr -popenemr ${DB} -N -e "${escaped}"`,
            { stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }
        ).toString().trim();
    } catch (e) { return ''; }
}

function sqlRows(query) {
    const raw = sql(query);
    if (!raw) return [];
    return raw.split('\n').map(r => r.split('\t'));
}

function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function cleanName(name) {
    return (name || '').replace(/\d+$/, '').trim();
}

// ══════════════════════════════════════════════
//  Medplum auth (auto-refreshes on expiry)
// ══════════════════════════════════════════════
let _token = null;
let _tokenExpiry = 0;

async function getToken() {
    if (_token && Date.now() < _tokenExpiry) return _token;
    const cv = 'sync-' + Date.now();
    const login = await fetch(`${MEDPLUM_BASE}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: MEDPLUM_EMAIL, password: MEDPLUM_PASSWORD,
            scope: 'openid fhirUser', codeChallengeMethod: 'plain', codeChallenge: cv
        }),
    });
    const { code } = await login.json();
    const tok = await fetch(`${MEDPLUM_BASE}/oauth2/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}&code_verifier=${cv}`,
    });
    const { access_token, expires_in } = await tok.json();
    _token = access_token;
    _tokenExpiry = Date.now() + ((expires_in || 3600) - 60) * 1000;
    return _token;
}

// ══════════════════════════════════════════════
//  Fetch helpers
// ══════════════════════════════════════════════
async function fhirGet(path) {
    const token = await getToken();
    const res = await fetch(`${MEDPLUM_BASE}/fhir/R4/${path}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    return res.json();
}

async function fetchSince(resourceType, since, maxPages = 20) {
    const token = await getToken();
    const items = [];
    let url = `${MEDPLUM_BASE}/fhir/R4/${resourceType}?_lastUpdated=ge${since}&_count=200`;
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

// ══════════════════════════════════════════════
//  OpenEMR patient map: fhir_uuid → openemr_pid
// ══════════════════════════════════════════════
function getPatientMap() {
    const rows = sqlRows("SELECT uuid, pid FROM patient_data WHERE uuid IS NOT NULL AND uuid != ''");
    const map = {};
    for (const [uuid, pid] of rows) {
        if (uuid && pid) map[uuid] = parseInt(pid, 10);
    }
    return map;
}

// ══════════════════════════════════════════════
//  FHIR Practitioner UUID → OpenEMR user id map
// ══════════════════════════════════════════════
async function buildPractitionerMap() {
    const token = await getToken();
    const map = {}; // fhirPractitionerId -> openemrUserId
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
            // Match OpenEMR users by fname + lname (case-insensitive)
            const match = sql(`SELECT id FROM users WHERE LOWER(fname)='${esc(fname)}' AND LOWER(lname)='${esc(lname)}' AND active=1 LIMIT 1`);
            if (match) {
                map[p.id] = parseInt(match, 10);
            } else {
                // Fallback: match just last name
                const matchL = sql(`SELECT id FROM users WHERE LOWER(lname)='${esc(lname)}' AND active=1 LIMIT 1`);
                if (matchL) map[p.id] = parseInt(matchL, 10);
            }
        }
        const next = (bundle.link || []).find(l => l.relation === 'next');
        url = next ? next.url : null;
    }
    const matched = Object.keys(map).length;
    if (matched) console.log(`  👨‍⚕️  Practitioner map: ${matched} matched to OpenEMR users`);
    return map;
}

// ══════════════════════════════════════════════
//  Upsert a patient from FHIR → OpenEMR
// ══════════════════════════════════════════════
function upsertPatient(p) {
    const fhirId = p.id;
    const name   = p.name?.[0] || {};
    const fname  = esc(cleanName(name.given?.[0] || ''));
    const lname  = esc(cleanName(name.family || ''));
    const dob    = p.birthDate || '';
    const sex    = p.gender === 'male' ? 'Male' : p.gender === 'female' ? 'Female' : 'Unknown';
    const phone  = p.telecom?.find(t => t.system === 'phone')?.value || '';
    const email  = p.telecom?.find(t => t.system === 'email')?.value || '';
    const addr   = p.address?.[0] || {};
    const street = esc(addr.line?.[0] || '');
    const city   = esc(addr.city || '');
    const state  = esc(addr.state || '');
    const postal = esc(addr.postalCode || '');
    const country= esc(addr.country || '');
    const ssn    = p.identifier?.find(i => i.system?.includes('ssn'))?.value || '';
    // pubpid: prefer MRN > first identifier value > UUID short
    const identifiers = p.identifier || [];
    const mrnId    = identifiers.find(i => i.type?.coding?.some(c => c.code === 'MR') || i.system?.includes('mrn') || i.system?.includes('medical-record'));
    const pubpid   = esc(mrnId?.value || identifiers[0]?.value || fhirId.substring(0, 8));
    const uuidHex  = fhirId.replace(/-/g, '');

    // Check if patient with this FHIR UUID exists (uuid is binary(16))
    const existing = sql(`SELECT pid FROM patient_data WHERE uuid = UNHEX('${uuidHex}') LIMIT 1`);

    if (existing) {
        sql(`UPDATE patient_data SET
            fname='${fname}', lname='${lname}', DOB='${esc(dob)}', sex='${esc(sex)}',
            pubpid='${pubpid}',
            phone_home='${esc(phone)}', email='${esc(email)}',
            street='${street}', city='${city}', state='${state}',
            postal_code='${postal}', country_code='${country}', ss='${esc(ssn)}'
            WHERE uuid=UNHEX('${uuidHex}')`);
        return 'updated';
    } else {
        // insert — uuid is binary(16)
        const pid_row = sql("SELECT IFNULL(MAX(pid), 0) + 1 FROM patient_data");
        const newPid = parseInt(pid_row, 10) || 1;
        sql(`INSERT INTO patient_data
            (pid, uuid, pubpid, fname, lname, DOB, sex, phone_home, email,
             street, city, state, postal_code, country_code, ss, date,
             title, language, financial, mname, drivers_license, phone_biz, phone_contact, phone_cell)
            VALUES (${newPid}, UNHEX('${uuidHex}'), '${pubpid}',
            '${fname}', '${lname}', '${esc(dob)}', '${esc(sex)}',
            '${esc(phone)}', '${esc(email)}', '${street}', '${city}', '${state}',
            '${postal}', '${country}', '${esc(ssn)}', NOW(),
            '', '', '', '', '', '', '', '')`);
        return 'created';
    }
}

// ══════════════════════════════════════════════
//  Deletion detection: compare FHIR IDs vs OpenEMR
// ══════════════════════════════════════════════
async function detectAndHandleDeletedPatients(patientMap) {
    const fhirIds = await fetchAllIds('Patient');
    let deleted = 0;
    for (const [fhirId, pid] of Object.entries(patientMap)) {
        if (!fhirIds.has(fhirId)) {
            // Patient was deleted in FHIR — soft-delete in OpenEMR
            sql(`UPDATE patient_data SET deceased_date=NOW(), deceased_reason='Removed from FHIR' WHERE pid=${pid} AND (deceased_date IS NULL OR deceased_date='')`);
            // Also deactivate related prescriptions
            sql(`UPDATE prescriptions SET active=0 WHERE patient_id=${pid}`);
            console.log(`  ⚠️  Patient PID ${pid} (FHIR: ${fhirId}) deleted in FHIR → deactivated in OpenEMR`);
            deleted++;
        }
    }
    return deleted;
}

// ══════════════════════════════════════════════
//  Delta sync: conditions, meds, allergies, immunizations
// ══════════════════════════════════════════════
function upsertCondition(c, patientMap) {
    const patId = (c.subject?.reference || '').replace('Patient/', '');
    const pid   = patientMap[patId];
    if (!pid) return;
    const title    = esc((c.code?.text || c.code?.coding?.[0]?.display || 'Unknown').substring(0, 200));
    const icd      = c.code?.coding?.find(cd => cd.system?.includes('icd') || cd.system?.includes('snomed'))?.code || '';
    const diagnosis= icd ? `ICD10:${esc(icd)}` : '';
    const begdate  = c.onsetDateTime?.substring(0, 10) || c.recordedDate?.substring(0, 10) || '';
    const enddate  = c.abatementDateTime?.substring(0, 10) || '';
    const activity = c.clinicalStatus?.coding?.[0]?.code === 'resolved' ? 0 : 1;
    const fhirId   = esc(c.id);

    const exists = sql(`SELECT id FROM lists WHERE type='medical_problem' AND pid=${pid} AND title='${title}' LIMIT 1`);
    if (!exists) {
        sql(`INSERT INTO lists (date, type, title, diagnosis, begdate, enddate, activity, pid, user, external_id)
             VALUES (NOW(), 'medical_problem', '${title}', '${diagnosis}', '${begdate}', '${enddate}', ${activity}, ${pid}, 'sync', '${fhirId}')`);
    } else {
        sql(`UPDATE lists SET activity=${activity}, enddate='${enddate}' WHERE id=${exists}`);
    }
}

function upsertMedication(m, patientMap) {
    const patId  = (m.subject?.reference || '').replace('Patient/', '');
    const pid    = patientMap[patId];
    if (!pid) return;
    const drug   = esc((m.medicationCodeableConcept?.text || m.medicationCodeableConcept?.coding?.[0]?.display || 'Unknown').substring(0, 200));
    const rxnorm = esc(m.medicationCodeableConcept?.coding?.find(c => c.system?.includes('rxnorm'))?.code || '');
    const dosage = esc((m.dosageInstruction?.[0]?.text || '').substring(0, 100));
    const start  = m.authoredOn?.substring(0, 10) || '';
    const active = m.status === 'active' ? 1 : 0;
    const fhirId = esc(m.id);

    const exists = sql(`SELECT id FROM prescriptions WHERE patient_id=${pid} AND drug='${drug}' LIMIT 1`);
    if (!exists) {
        sql(`INSERT INTO prescriptions (patient_id, date_added, provider_id, drug, rxnorm_drugcode, dosage, start_date, active, medication, external_id)
             VALUES (${pid}, NOW(), 1, '${drug}', '${rxnorm}', '${dosage}', '${start}', ${active}, 1, '${fhirId}')`);
    } else {
        sql(`UPDATE prescriptions SET active=${active} WHERE id=${exists}`);
    }
}

function upsertAllergy(a, patientMap) {
    const patId   = (a.patient?.reference || '').replace('Patient/', '');
    const pid     = patientMap[patId];
    if (!pid) return;
    const title   = esc((a.code?.text || a.code?.coding?.[0]?.display || 'Unknown Allergy').substring(0, 200));
    const severity= esc(a.reaction?.[0]?.severity || '');
    const begdate = a.onsetDateTime?.substring(0, 10) || a.recordedDate?.substring(0, 10) || '';
    const active  = a.clinicalStatus?.coding?.[0]?.code === 'inactive' ? 0 : 1;
    const fhirId  = esc(a.id);

    const exists = sql(`SELECT id FROM lists WHERE type='allergy' AND pid=${pid} AND title='${title}' LIMIT 1`);
    if (!exists) {
        sql(`INSERT INTO lists (date, type, title, begdate, activity, pid, user, severity_al, external_id)
             VALUES (NOW(), 'allergy', '${title}', '${begdate}', ${active}, ${pid}, 'sync', '${severity}', '${fhirId}')`);
    } else {
        sql(`UPDATE lists SET activity=${active} WHERE id=${exists}`);
    }
}

function upsertImmunization(im, patientMap) {
    const patId  = (im.patient?.reference || '').replace('Patient/', '');
    const pid    = patientMap[patId];
    if (!pid) return;
    const vaccine= esc((im.vaccineCode?.text || im.vaccineCode?.coding?.[0]?.display || 'Unknown').substring(0, 200));
    const cvx    = esc(im.vaccineCode?.coding?.find(c => c.system?.includes('cvx'))?.code || '');
    const date   = im.occurrenceDateTime?.substring(0, 10) || '';
    const fhirId = esc(im.id);

    const exists = sql(`SELECT id FROM immunizations WHERE patient_id=${pid} AND cvx_code='${cvx}' AND administered_date='${date}' LIMIT 1`);
    if (!exists) {
        sql(`INSERT INTO immunizations (patient_id, administered_date, immunization_id, cvx_code, note, added_erroneously, external_id)
             VALUES (${pid}, '${date}', 0, '${cvx}', '${vaccine}', 0, '${fhirId}')`);
    }
}

// ── Sync FHIR Appointment → openemr_postcalendar_events ──
const FHIR_STATUS_MAP = {
    'booked': '-', 'arrived': '>', 'fulfilled': 'x',
    'noshow': '?', 'cancelled': '%', 'pending': '-'
};

function upsertAppointment(appt, patientMap, practitionerMap) {
    const fhirId  = appt.id;
    const title   = esc((appt.description || appt.serviceType?.[0]?.text || 'Appointment').substring(0, 150));
    const status  = FHIR_STATUS_MAP[appt.status] || '-';

    // Find patient participant
    const patRef    = appt.participant?.find(p => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference || '';
    const patFhirId = patRef.replace('Patient/', '');
    const pid       = patientMap[patFhirId];
    if (!pid) return;

    // Find practitioner participant — map to OpenEMR user id
    const practRef    = appt.participant?.find(p => p.actor?.reference?.startsWith('Practitioner/'))?.actor?.reference || '';
    const practFhirId = practRef.replace('Practitioner/', '');
    const aid         = (practFhirId && practitionerMap[practFhirId]) ? practitionerMap[practFhirId] : 1;

    const startDt = appt.start ? new Date(appt.start) : null;
    const endDt   = appt.end   ? new Date(appt.end)   : null;
    if (!startDt) return;

    const eventDate  = startDt.toISOString().substring(0, 10);
    const startTime  = startDt.toISOString().substring(11, 19);
    const durationMin = endDt ? Math.round((endDt - startDt) / 60000) : 30;
    const durationSec = durationMin * 60;
    const comments   = esc((appt.comment || appt.patientInstruction || '').substring(0, 500));

    const existing = sql(`SELECT pc_eid FROM openemr_postcalendar_events WHERE pc_external_id='${esc(fhirId)}' LIMIT 1`);
    if (existing) {
        sql(`UPDATE openemr_postcalendar_events SET
            pc_title='${title}', pc_eventDate='${eventDate}', pc_startTime='${startTime}',
            pc_duration=${durationSec}, pc_apptstatus='${status}', pc_hometext='${comments}',
            pc_aid=${aid}
            WHERE pc_external_id='${esc(fhirId)}'`);
    } else {
        sql(`INSERT INTO openemr_postcalendar_events
            (pc_pid, pc_aid, pc_title, pc_time, pc_eventDate, pc_endDate,
             pc_startTime, pc_duration, pc_apptstatus, pc_hometext, pc_external_id,
             pc_catid, pc_alldayevent, pc_recurrtype, pc_recurrfreq, pc_facility)
            VALUES (${pid}, ${aid}, '${title}', '${eventDate} ${startTime}', '${eventDate}', '${eventDate}',
            '${startTime}', ${durationSec}, '${status}', '${comments}', '${esc(fhirId)}',
            9, 0, 0, 0, 3)`);
    }
}

// ══════════════════════════════════════════════
//  Add external_id column if missing
// ══════════════════════════════════════════════
function ensureExternalIdColumns() {
    const tables = [
        ['lists', 'external_id'],
        ['prescriptions', 'external_id'],
        ['immunizations', 'external_id'],
    ];
    for (const [table, col] of tables) {
        const exists2 = sql(`SHOW COLUMNS FROM ${table} LIKE '${col}'`);
        if (!exists2) {
            sql(`ALTER TABLE ${table} ADD COLUMN ${col} VARCHAR(64) DEFAULT NULL`);
            console.log(`  ✅ Added ${col} column to ${table}`);
        }
    }
    // Appointment external key
    const hasExtId = sql(`SHOW COLUMNS FROM openemr_postcalendar_events LIKE 'pc_external_id'`);
    if (!hasExtId) {
        sql(`ALTER TABLE openemr_postcalendar_events ADD COLUMN pc_external_id VARCHAR(64) DEFAULT NULL, ADD INDEX idx_pc_external_id (pc_external_id)`);
        console.log('  ✅ Added pc_external_id column to openemr_postcalendar_events');
    }
}

// ══════════════════════════════════════════════
//  Main sync loop
// ══════════════════════════════════════════════
let lastSyncTime = null;

async function runSyncCycle(cycleNum) {
    const start = Date.now();
    const since = lastSyncTime || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(); // first run: last 7 days
    const sinceFmt = since.substring(0, 19); // ISO 8601 without ms

    console.log(`\n━━━━ Sync Cycle #${cycleNum} @ ${new Date().toLocaleTimeString()} ━━━━`);
    console.log(`  Checking changes since: ${sinceFmt}`);

    try {
        // Update lastSyncTime at start of cycle to avoid missing updates during the run
        const cycleStart = new Date().toISOString();
        const token = await getToken();

        const patientMap = getPatientMap();
        const fhirPatients = await fetchSince('Patient', sinceFmt, 10);
        let created = 0, updated = 0;
        for (const p of fhirPatients) {
            const result = upsertPatient(p);
            if (result === 'created') created++;
            else updated++;
        }
        if (fhirPatients.length) console.log(`  👤 Patients: +${created} new, ~${updated} updated`);

        // Refresh map after patient upserts
        const freshMap = getPatientMap();

        // Delta sync clinical data (each step isolated so one failure doesn't abort the rest)
        try {
            const conditions = await fetchSince('Condition', sinceFmt, 10);
            for (const c of conditions) upsertCondition(c, freshMap);
            if (conditions.length) console.log(`  🩺 Conditions: ${conditions.length} synced`);
        } catch (e) { console.log(`  ⚠️  Conditions skipped: ${e.message}`); }

        try {
            const meds = await fetchSince('MedicationRequest', sinceFmt, 10);
            for (const m of meds) upsertMedication(m, freshMap);
            if (meds.length) console.log(`  💊 Medications: ${meds.length} synced`);
        } catch (e) { console.log(`  ⚠️  Medications skipped: ${e.message}`); }

        try {
            const allergies = await fetchSince('AllergyIntolerance', sinceFmt, 10);
            for (const a of allergies) upsertAllergy(a, freshMap);
            if (allergies.length) console.log(`  ⚠️  Allergies: ${allergies.length} synced`);
        } catch (e) { console.log(`  ⚠️  Allergies skipped: ${e.message}`); }

        try {
            const imms = await fetchSince('Immunization', sinceFmt, 10);
            for (const im of imms) upsertImmunization(im, freshMap);
            if (imms.length) console.log(`  💉 Immunizations: ${imms.length} synced`);
        } catch (e) { console.log(`  ⚠️  Immunizations skipped: ${e.message}`); }

        // FHIR Appointments → OpenEMR calendar (with practitioner mapping)
        try {
            const practitionerMap = await buildPractitionerMap();
            const appts = await fetchSince('Appointment', sinceFmt, 10);
            for (const a of appts) upsertAppointment(a, freshMap, practitionerMap);
            if (appts.length) console.log(`  📅 Appointments: ${appts.length} synced`);
        } catch (e) { console.log(`  ⚠️  Appointments skipped: ${e.message}`); }

        // ── OpenEMR → FHIR reverse sync (ALWAYS runs) ──
        try {
            const pushed = await pushEncountersToFHIR(token);
            if (pushed) console.log(`  📤 OpenEMR→FHIR: ${pushed} encounter(s) pushed`);
        } catch (e) {
            console.log(`  ⚠️  OpenEMR→FHIR push skipped: ${e.message}`);
        }

        // Deletion check (runs every cycle — compares full ID lists)
        let deleted = 0;
        try {
            deleted = await detectAndHandleDeletedPatients(freshMap);
            if (deleted) console.log(`  🗑️  ${deleted} patient(s) deactivated (deleted from FHIR)`);
        } catch (delErr) {
            console.log(`  ⚠️  Deletion check skipped: ${delErr.message}`);
        }

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`  ✅ Cycle #${cycleNum} done (${elapsed}s)`);


        lastSyncTime = cycleStart;
    } catch (err) {
        console.error(`  ❌ Sync cycle error: ${err.message}`);
    }
}

// ══════════════════════════════════════════════════════════
//  OpenEMR → FHIR  (encounters + SOAP notes)
// ══════════════════════════════════════════════════════════
function ensureEncounterFhirIdColumn() {
    sql(`ALTER TABLE form_encounter ADD COLUMN IF NOT EXISTS fhir_id VARCHAR(64) DEFAULT NULL`);
}

async function pushEncountersToFHIR(token) {
    // Fetch encounters not yet pushed to FHIR (fhir_id IS NULL), last 30 days
    const sinceDate = new Date(Date.now() - 30 * 86400000).toISOString().substring(0, 10);
    const rows = sqlRows(`
        SELECT fe.encounter, fe.pid, fe.date, fe.reason, fe.provider_id,
               fs.subjective, fs.objective, fs.assessment, fs.plan,
               LOWER(HEX(p.uuid)) as fhir_uuid,
               u.fname as dr_fname, u.lname as dr_lname
        FROM form_encounter fe
        LEFT JOIN form_soap fs ON fs.pid = fe.pid
            AND DATE(fs.date) = DATE(fe.date)
            AND fs.activity = 1
        JOIN patient_data p ON p.pid = fe.pid
        LEFT JOIN users u ON u.id = fe.provider_id
        WHERE fe.fhir_id IS NULL
          AND fe.date >= '${sinceDate}'
          AND p.uuid IS NOT NULL
        ORDER BY fe.date ASC
        LIMIT 20
    `);

    if (!rows.length || (rows.length === 1 && rows[0][0] === '')) return 0;
    let pushed = 0;

    for (const [encounterId, pid, date, reason, providerId,
                 subjective, objective, assessment, plan,
                 fhirUuidHex, drFname, drLname] of rows) {
        if (!fhirUuidHex || fhirUuidHex.length !== 32) continue;

        // Reconstruct FHIR patient UUID
        const h = fhirUuidHex;
        const patFhirId = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;

        try {
            const encDate = new Date(date);
            const encEnd  = new Date(encDate.getTime() + 30 * 60000);

            // Look up FHIR Practitioner ID by name
            let practitionerRef = null;
            if (drFname && drLname) {
                try {
                    const pr = await fetch(
                        `${MEDPLUM_BASE}/fhir/R4/Practitioner?name=${encodeURIComponent(drLname)}&_count=5`,
                        { headers: { Authorization: `Bearer ${token}` } }
                    );
                    if (pr.ok) {
                        const prb = await pr.json();
                        const match = (prb.entry || []).find(e => {
                            const n = e.resource?.name?.[0];
                            return n?.family?.toLowerCase() === drLname.toLowerCase();
                        });
                        if (match) practitionerRef = match.resource.id;
                    }
                } catch (_) {}
            }

            // 1) Push FHIR Encounter
            const participant = drFname && drLname ? [{
                individual: {
                    ...(practitionerRef ? { reference: `Practitioner/${practitionerRef}` } : {}),
                    display: `Dr. ${drFname} ${drLname}`,
                }
            }] : [];

            const encBody = {
                resourceType: 'Encounter',
                status: 'finished',
                class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
                type: reason ? [{ text: reason }] : [],
                subject: { reference: `Patient/${patFhirId}` },
                period: { start: encDate.toISOString(), end: encEnd.toISOString() },
                reasonCode: reason ? [{ text: reason }] : [],
                ...(participant.length ? { participant } : {}),
            };

            const encRes = await fetch(`${MEDPLUM_BASE}/fhir/R4/Encounter`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(encBody),
            });
            if (!encRes.ok) continue;
            const encFhir = await encRes.json();
            const encFhirId = encFhir.id;

            // 2) Push SOAP note as DocumentReference (if SOAP exists)
            const hasSoap = subjective || objective || assessment || plan;
            if (hasSoap) {
                const soapText = [
                    subjective ? `SUBJECTIVE:\n${subjective}` : '',
                    objective  ? `\nOBJECTIVE:\n${objective}`  : '',
                    assessment ? `\nASSESSMENT:\n${assessment}` : '',
                    plan       ? `\nPLAN:\n${plan}`             : '',
                ].filter(Boolean).join('\n');

                const b64 = Buffer.from(soapText, 'utf8').toString('base64');
                await fetch(`${MEDPLUM_BASE}/fhir/R4/DocumentReference`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        resourceType: 'DocumentReference',
                        status: 'current',
                        type: {
                            coding: [{ system: 'http://loinc.org', code: '34109-9', display: 'Note' }],
                            text: 'SOAP Note',
                        },
                        subject: { reference: `Patient/${patFhirId}` },
                        date: encDate.toISOString(),
                        description: `SOAP Note — ${reason || 'Encounter'} (${encDate.toISOString().substring(0,10)})`,
                        context: { encounter: [{ reference: `Encounter/${encFhirId}` }] },
                        content: [{
                            attachment: {
                                contentType: 'text/plain',
                                data: b64,
                                title: `SOAP Note — ${encDate.toISOString().substring(0,10)}`,
                            },
                        }],
                    }),
                });
            }

            // 3) Mark encounter as pushed in OpenEMR
            sql(`UPDATE form_encounter SET fhir_id='${esc(encFhirId)}' WHERE encounter=${encounterId}`);

            // 4) Mark the FHIR Appointment as fulfilled + OpenEMR appointment as completed
            try {
                const encDateStr = encDate.toISOString().substring(0, 10);
                // Find FHIR Appointment for this patient on this date
                const apptSearch = await fetch(
                    `${MEDPLUM_BASE}/fhir/R4/Appointment?actor=Patient/${patFhirId}&date=ge${encDateStr}T00:00:00&date=le${encDateStr}T23:59:59&_count=5`,
                    { headers: { Authorization: `Bearer ${token}` } }
                );
                if (apptSearch.ok) {
                    const apptBundle = await apptSearch.json();
                    for (const entry of (apptBundle.entry || [])) {
                        const appt = entry.resource;
                        if (appt.status === 'booked' || appt.status === 'arrived') {
                            // Update FHIR Appointment to fulfilled
                            await fetch(`${MEDPLUM_BASE}/fhir/R4/Appointment/${appt.id}`, {
                                method: 'PUT',
                                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                                body: JSON.stringify({ ...appt, status: 'fulfilled' }),
                            });
                            // Also update OpenEMR appointment status to '>' (Completed)
                            sql(`UPDATE openemr_postcalendar_events SET pc_apptstatus='>' WHERE pc_external_id='${esc(appt.id)}'`);
                        }
                    }
                }
            } catch (_) { /* non-critical — appointment status update failed */ }

            pushed++;
        } catch (e) {
            // skip this encounter, will retry next cycle
        }
    }
    return pushed;
}

async function main() {
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║  Med-SEAL Sync Daemon (FHIR ↔ OpenEMR bidirectional) ║');
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log(`║  Sync interval: ${String(INTERVAL_SECONDS + 's').padEnd(6)}                                ║`);
    console.log(`║  Medplum base:  ${MEDPLUM_BASE.padEnd(38)} ║`);
    console.log('╚═══════════════════════════════════════════════════════╝');

    // Ensure schema is ready
    ensureExternalIdColumns();
    ensureEncounterFhirIdColumn();

    let cycle = 1;
    // Run immediately on start
    await runSyncCycle(cycle++);

    // Then run on interval
    setInterval(async () => {
        await runSyncCycle(cycle++);
    }, INTERVAL_SECONDS * 1000);

    console.log(`\n⏱  Next sync in ${INTERVAL_SECONDS}s. Press Ctrl+C to stop.\n`);
}

main().catch(e => {
    console.error('Fatal:', e.message);
    process.exit(1);
});
