#!/usr/bin/env node
/**
 * Med-SEAL Appointment Sync: OpenEMR -> Medplum FHIR
 *
 * Reads appointments from OpenEMR's openemr_postcalendar_events table
 * and creates/updates FHIR Appointment resources in Medplum.
 *
 * Uses an identifier-based upsert to avoid duplicates on re-run.
 */

const { execSync } = require('child_process');

const MEDPLUM_BASE = process.env.MEDPLUM_BASE_URL || 'http://localhost:8103';
const CONTAINER = 'medseal-openemr-db';
const DB = 'openemr';
const SYSTEM_ID = 'https://medseal.io/openemr/appointment';

// ---- OpenEMR status -> FHIR Appointment.status ----
const STATUS_MAP = {
    '-': 'booked',       // pending
    '#': 'booked',       // insurance verified
    '>': 'arrived',      // checked in
    '~': 'arrived',      // arrived
    '@': 'arrived',      // in exam room
    'x': 'fulfilled',    // completed
    '?': 'noshow',       // no show
    '%': 'cancelled',    // cancelled
};

// ---- SQL helpers ----
function sql(query) {
    const escaped = query.replace(/"/g, '\\"').replace(/`/g, '\\`');
    try {
        return execSync(
            `docker exec ${CONTAINER} mariadb -u openemr -popenemr ${DB} -N -e "${escaped}"`,
            { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }
        ).toString().trim();
    } catch (e) { return ''; }
}

// ---- Medplum Auth ----
async function getMedplumToken() {
    const cv = 'sync-appt-' + Date.now();
    const login = await fetch(`${MEDPLUM_BASE}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: 'admin@example.com', password: 'medplum_admin',
            scope: 'openid fhirUser', codeChallengeMethod: 'plain', codeChallenge: cv
        }),
    });
    const { code } = await login.json();
    const tok = await fetch(`${MEDPLUM_BASE}/oauth2/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}&code_verifier=${cv}`,
    });
    const { access_token } = await tok.json();
    return access_token;
}

// ---- FHIR helpers ----
async function fhirSearch(token, resourceType, params) {
    const res = await fetch(`${MEDPLUM_BASE}/fhir/R4/${resourceType}?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const bundle = await res.json();
    return (bundle.entry || []).map(e => e.resource);
}

async function fhirPost(token, resourceType, resource) {
    const res = await fetch(`${MEDPLUM_BASE}/fhir/R4/${resourceType}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(resource),
    });
    return { ok: res.ok, status: res.status, data: await res.json() };
}

async function fhirPut(token, resourceType, id, resource) {
    const res = await fetch(`${MEDPLUM_BASE}/fhir/R4/${resourceType}/${id}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(resource),
    });
    return { ok: res.ok, status: res.status, data: await res.json() };
}

// ---- Build patient map (OpenEMR pid -> FHIR Patient ID) ----
async function buildPatientMap(token) {
    const map = {}; // openemr_pid -> fhir_patient_id
    let url = `${MEDPLUM_BASE}/fhir/R4/Patient?_count=200`;
    let page = 0;
    while (url && page < 50) {
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) break;
        const bundle = await res.json();
        const entries = (bundle.entry || []).map(e => e.resource);
        entries.forEach((p, i) => {
            // OpenEMR patients were loaded sequentially, pid = page_offset + index + 1
            const pid = page * 200 + i + 1;
            map[pid] = p.id;
        });
        const next = (bundle.link || []).find(l => l.relation === 'next');
        url = next ? next.url : null;
        page++;
    }
    console.log(`  Patient map built: ${Object.keys(map).length} entries`);
    return map;
}

// ---- Build practitioner map (OpenEMR user id -> FHIR Practitioner ID) ----
async function buildPractitionerMap(token) {
    const map = {}; // openemr_provider_id -> fhir_practitioner_id
    let url = `${MEDPLUM_BASE}/fhir/R4/Practitioner?_count=200`;
    let page = 0;
    while (url && page < 10) {
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) break;
        const bundle = await res.json();
        const entries = (bundle.entry || []).map(e => e.resource);
        entries.forEach((p, i) => {
            const uid = page * 200 + i + 1;
            map[uid] = p.id;
        });
        const next = (bundle.link || []).find(l => l.relation === 'next');
        url = next ? next.url : null;
        page++;
    }
    console.log(`  Practitioner map built: ${Object.keys(map).length} entries`);
    return map;
}

// ---- Build existing appointment index (for dedup) ----
async function buildExistingApptIndex(token) {
    const index = {}; // openemr_eid -> fhir_id
    let url = `${MEDPLUM_BASE}/fhir/R4/Appointment?identifier=${encodeURIComponent(SYSTEM_ID + '|')}&_count=200`;
    let page = 0;
    while (url && page < 50) {
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) break;
        const bundle = await res.json();
        for (const e of (bundle.entry || [])) {
            const appt = e.resource;
            const eid = (appt.identifier || []).find(id => id.system === SYSTEM_ID)?.value;
            if (eid) index[eid] = appt.id;
        }
        const next = (bundle.link || []).find(l => l.relation === 'next');
        url = next ? next.url : null;
        page++;
        process.stdout.write(`\r  Indexed ${Object.keys(index).length} existing synced appointments...`);
    }
    if (Object.keys(index).length > 0) console.log();
    return index;
}

// ---- Read OpenEMR appointments ----
function readOpenEMRAppointments() {
    const raw = sql(
        `SELECT pc_eid, pc_catid, pc_aid, pc_pid, pc_title, pc_eventDate, pc_startTime, pc_endTime, pc_duration, pc_apptstatus, pc_facility, pc_hometext FROM openemr_postcalendar_events WHERE pc_pid > 0 AND pc_eventstatus = 1 ORDER BY pc_eventDate, pc_startTime`
    );
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map(line => {
        const cols = line.split('\t');
        return {
            eid: cols[0],
            catid: cols[1],
            aid: cols[2],      // provider id
            pid: cols[3],      // patient id
            title: cols[4],
            eventDate: cols[5],
            startTime: cols[6],
            endTime: cols[7],
            duration: parseInt(cols[8] || '0'),
            status: cols[9],
            facility: cols[10],
            notes: cols[11] || '',
        };
    });
}

// ---- Build FHIR Appointment resource ----
function buildFhirAppointment(appt, patientMap, practitionerMap) {
    const fhirStatus = STATUS_MAP[appt.status] || 'proposed';

    // Build ISO datetime with timezone (FHIR instant requires timezone)
    // Use UTC offset — appointments are stored in local server timezone
    const tzOffset = new Date().getTimezoneOffset();
    const tzSign = tzOffset <= 0 ? '+' : '-';
    const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
    const tzMins = String(Math.abs(tzOffset) % 60).padStart(2, '0');
    const tz = `${tzSign}${tzHours}:${tzMins}`;
    const start = `${appt.eventDate}T${appt.startTime}${tz}`;
    const end = `${appt.eventDate}T${appt.endTime}${tz}`;

    // Duration in minutes
    const durationMinutes = appt.duration > 0 ? Math.round(appt.duration / 60) : 15;

    // Participants
    const participants = [];
    const fhirPatientId = patientMap[appt.pid];
    if (fhirPatientId) {
        participants.push({
            actor: { reference: `Patient/${fhirPatientId}` },
            status: fhirStatus === 'fulfilled' ? 'accepted' : 'accepted',
        });
    }
    const fhirPractitionerId = practitionerMap[appt.aid];
    if (fhirPractitionerId) {
        participants.push({
            actor: { reference: `Practitioner/${fhirPractitionerId}` },
            status: 'accepted',
        });
    }

    const resource = {
        resourceType: 'Appointment',
        identifier: [
            {
                system: SYSTEM_ID,
                value: String(appt.eid),
            },
        ],
        status: fhirStatus,
        serviceType: [
            {
                coding: [{ display: appt.title }],
                text: appt.title,
            },
        ],
        appointmentType: {
            coding: [{ display: appt.title }],
            text: appt.title,
        },
        start,
        end,
        minutesDuration: durationMinutes,
        participant: participants,
        comment: appt.notes || undefined,
    };

    // Remove undefined fields
    if (!resource.comment) delete resource.comment;

    return resource;
}

// ---- Main sync ----
async function main() {
    console.log('======================================================');
    console.log('  Med-SEAL Appointment Sync: OpenEMR -> Medplum FHIR');
    console.log('======================================================\n');

    // 1. Auth
    console.log('Authenticating with Medplum...');
    const token = await getMedplumToken();
    console.log('Authenticated.\n');

    // 2. Build maps
    console.log('Building patient map...');
    const patientMap = await buildPatientMap(token);
    console.log('Building practitioner map...');
    const practitionerMap = await buildPractitionerMap(token);

    // 3. Index existing synced appointments (for dedup)
    console.log('Checking existing synced appointments...');
    const existingIndex = await buildExistingApptIndex(token);
    console.log(`  ${Object.keys(existingIndex).length} previously synced appointments found.\n`);

    // 4. Read OpenEMR appointments
    console.log('Reading OpenEMR appointments...');
    const appointments = readOpenEMRAppointments();
    console.log(`  ${appointments.length} appointments found in OpenEMR.\n`);

    if (appointments.length === 0) {
        console.log('Nothing to sync.');
        return;
    }

    // 5. Sync
    let created = 0, updated = 0, skipped = 0, failed = 0;
    const batchSize = 50;

    for (let i = 0; i < appointments.length; i++) {
        const appt = appointments[i];

        // Skip appointments without a mapped patient
        if (!patientMap[appt.pid]) {
            skipped++;
            continue;
        }

        const fhirAppt = buildFhirAppointment(appt, patientMap, practitionerMap);
        const existingId = existingIndex[appt.eid];

        try {
            if (existingId) {
                // Update existing
                fhirAppt.id = existingId;
                const result = await fhirPut(token, 'Appointment', existingId, fhirAppt);
                if (result.ok) updated++;
                else failed++;
            } else {
                // Create new
                const result = await fhirPost(token, 'Appointment', fhirAppt);
                if (result.ok) created++;
                else failed++;
            }
        } catch (e) {
            failed++;
        }

        if ((i + 1) % batchSize === 0 || i === appointments.length - 1) {
            process.stdout.write(`\r  Progress: ${i + 1}/${appointments.length} | Created: ${created} | Updated: ${updated} | Skipped: ${skipped} | Failed: ${failed}`);
        }
    }
    console.log('\n');

    // 6. Summary
    console.log('======================================================');
    console.log('  SYNC COMPLETE');
    console.log('------------------------------------------------------');
    console.log(`  Total OpenEMR appointments:  ${appointments.length}`);
    console.log(`  Created in FHIR:             ${created}`);
    console.log(`  Updated in FHIR:             ${updated}`);
    console.log(`  Skipped (no patient match):  ${skipped}`);
    console.log(`  Failed:                      ${failed}`);
    console.log('======================================================');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
