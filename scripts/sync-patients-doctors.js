#!/usr/bin/env node
/**
 * Med-SEAL Patient & Doctor Sync: OpenEMR -> Medplum FHIR
 *
 * Reads patients from patient_data and doctors from users table,
 * creates/updates FHIR Patient and Practitioner resources in Medplum.
 *
 * Doctor specialty = facility name (from OpenEMR facility table).
 * Uses identifier-based upsert to avoid duplicates on re-run.
 */

const { execSync } = require('child_process');

const MEDPLUM_BASE = process.env.MEDPLUM_BASE_URL || 'http://localhost:8103';
const CONTAINER = 'medseal-openemr-db';
const DB = 'openemr';
const PATIENT_SYSTEM = 'https://medseal.io/openemr/patient';
const PRACTITIONER_SYSTEM = 'https://medseal.io/openemr/practitioner';

// ---- SQL helper ----
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
    const cv = 'sync-pd-' + Date.now();
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

// ---- Build existing resource index by identifier (for dedup) ----
async function buildExistingIndex(token, resourceType, system) {
    const index = {}; // identifier_value -> fhir_id
    let url = `${MEDPLUM_BASE}/fhir/R4/${resourceType}?identifier=${encodeURIComponent(system + '|')}&_count=200`;
    let page = 0;
    while (url && page < 100) {
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) break;
        const bundle = await res.json();
        for (const e of (bundle.entry || [])) {
            const r = e.resource;
            const idVal = (r.identifier || []).find(id => id.system === system)?.value;
            if (idVal) index[idVal] = r.id;
        }
        const next = (bundle.link || []).find(l => l.relation === 'next');
        url = next ? next.url : null;
        page++;
    }
    return index;
}

// ========================================================
// PATIENT SYNC
// ========================================================
function readOpenEMRPatients() {
    const raw = sql(
        `SELECT pid, fname, lname, mname, DOB, sex, street, city, state, postal_code, phone_home, phone_cell, email FROM patient_data ORDER BY pid`
    );
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map(line => {
        const c = line.split('\t');
        return {
            pid: c[0], fname: c[1], lname: c[2], mname: c[3],
            dob: c[4], sex: c[5], street: c[6], city: c[7],
            state: c[8], zip: c[9], phone: c[10], cell: c[11], email: c[12],
        };
    });
}

function mapGender(sex) {
    if (!sex) return 'unknown';
    const s = sex.toLowerCase();
    if (s === 'male' || s === 'm') return 'male';
    if (s === 'female' || s === 'f') return 'female';
    return 'unknown';
}

function buildFhirPatient(p) {
    const resource = {
        resourceType: 'Patient',
        identifier: [{ system: PATIENT_SYSTEM, value: String(p.pid) }],
        active: true,
        name: [{
            family: p.lname || 'Unknown',
            given: [p.fname || 'Unknown'].concat(p.mname ? [p.mname] : []),
        }],
        gender: mapGender(p.sex),
    };

    if (p.dob && p.dob !== 'NULL' && p.dob !== '0000-00-00') {
        resource.birthDate = p.dob;
    }

    // Telecom
    const telecom = [];
    if (p.phone && p.phone !== 'NULL') telecom.push({ system: 'phone', value: p.phone, use: 'home' });
    if (p.cell && p.cell !== 'NULL') telecom.push({ system: 'phone', value: p.cell, use: 'mobile' });
    if (p.email && p.email !== 'NULL') telecom.push({ system: 'email', value: p.email });
    if (telecom.length > 0) resource.telecom = telecom;

    // Address
    if (p.street || p.city || p.state || p.zip) {
        const addr = {};
        if (p.street && p.street !== 'NULL') addr.line = [p.street];
        if (p.city && p.city !== 'NULL') addr.city = p.city;
        if (p.state && p.state !== 'NULL') addr.state = p.state;
        if (p.zip && p.zip !== 'NULL' && p.zip !== '00000') addr.postalCode = p.zip;
        if (Object.keys(addr).length > 0) resource.address = [addr];
    }

    return resource;
}

// ========================================================
// DOCTOR (PRACTITIONER) SYNC
// ========================================================
function readOpenEMRDoctors() {
    const raw = sql(
        `SELECT u.id, u.username, u.fname, u.lname, u.npi, u.specialty, u.facility_id, u.email, u.title, IFNULL(f.name, '') as facility_name
         FROM users u
         LEFT JOIN facility f ON u.facility_id = f.id
         WHERE u.active = 1 AND u.authorized = 1 AND u.id > 1
         ORDER BY u.id`
    );
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map(line => {
        const c = line.split('\t');
        return {
            uid: c[0], username: c[1], fname: c[2], lname: c[3],
            npi: c[4], specialty: c[5], facilityId: c[6],
            email: c[7], title: c[8], facilityName: c[9],
        };
    });
}

function buildFhirPractitioner(doc) {
    // Specialty = facility name (as per user requirement)
    const specialty = doc.facilityName || doc.specialty || '';

    const resource = {
        resourceType: 'Practitioner',
        identifier: [{ system: PRACTITIONER_SYSTEM, value: String(doc.uid) }],
        active: true,
        name: [{
            prefix: doc.title ? [doc.title] : [],
            family: doc.lname || 'Unknown',
            given: [doc.fname || 'Unknown'],
        }],
    };

    // NPI identifier
    if (doc.npi && doc.npi !== 'NULL' && doc.npi !== '') {
        resource.identifier.push({
            system: 'http://hl7.org/fhir/sid/us-npi',
            value: doc.npi,
        });
    }

    // Telecom
    if (doc.email && doc.email !== 'NULL' && doc.email !== '') {
        resource.telecom = [{ system: 'email', value: doc.email }];
    }

    // Qualification (specialty from facility)
    if (specialty) {
        resource.qualification = [{
            code: {
                coding: [{ display: specialty }],
                text: specialty,
            },
        }];
    }

    return resource;
}

// ========================================================
// MAIN SYNC
// ========================================================
async function main() {
    console.log('==========================================================');
    console.log('  Med-SEAL Patient & Doctor Sync: OpenEMR -> Medplum FHIR');
    console.log('==========================================================\n');

    // 1. Auth
    console.log('Authenticating with Medplum...');
    const token = await getMedplumToken();
    console.log('Authenticated.\n');

    // ---- Sync Patients ----
    console.log('--- PATIENT SYNC ---\n');
    console.log('Reading OpenEMR patients...');
    const patients = readOpenEMRPatients();
    console.log(`  ${patients.length} patients found.\n`);

    console.log('Checking existing synced patients...');
    const existingPatients = await buildExistingIndex(token, 'Patient', PATIENT_SYSTEM);
    console.log(`  ${Object.keys(existingPatients).length} previously synced.\n`);

    let pCreated = 0, pUpdated = 0, pFailed = 0;

    for (let i = 0; i < patients.length; i++) {
        const p = patients[i];
        const fhirPat = buildFhirPatient(p);
        const existingId = existingPatients[p.pid];

        try {
            if (existingId) {
                fhirPat.id = existingId;
                const res = await fetch(`${MEDPLUM_BASE}/fhir/R4/Patient/${existingId}`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(fhirPat),
                });
                res.ok ? pUpdated++ : pFailed++;
            } else {
                const res = await fetch(`${MEDPLUM_BASE}/fhir/R4/Patient`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(fhirPat),
                });
                res.ok ? pCreated++ : pFailed++;
            }
        } catch { pFailed++; }

        if ((i + 1) % 50 === 0 || i === patients.length - 1) {
            process.stdout.write(`\r  Patients: ${i + 1}/${patients.length} | Created: ${pCreated} | Updated: ${pUpdated} | Failed: ${pFailed}`);
        }
    }
    console.log('\n');

    // ---- Sync Doctors ----
    console.log('--- DOCTOR (PRACTITIONER) SYNC ---\n');
    console.log('Reading OpenEMR doctors...');
    const doctors = readOpenEMRDoctors();
    console.log(`  ${doctors.length} doctors found.\n`);

    console.log('Checking existing synced practitioners...');
    const existingDocs = await buildExistingIndex(token, 'Practitioner', PRACTITIONER_SYSTEM);
    console.log(`  ${Object.keys(existingDocs).length} previously synced.\n`);

    let dCreated = 0, dUpdated = 0, dFailed = 0;

    for (let i = 0; i < doctors.length; i++) {
        const doc = doctors[i];
        const fhirDoc = buildFhirPractitioner(doc);
        const existingId = existingDocs[doc.uid];

        try {
            if (existingId) {
                fhirDoc.id = existingId;
                const res = await fetch(`${MEDPLUM_BASE}/fhir/R4/Practitioner/${existingId}`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(fhirDoc),
                });
                res.ok ? dUpdated++ : dFailed++;
            } else {
                const res = await fetch(`${MEDPLUM_BASE}/fhir/R4/Practitioner`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(fhirDoc),
                });
                res.ok ? dCreated++ : dFailed++;
            }
        } catch { dFailed++; }

        if ((i + 1) % 50 === 0 || i === doctors.length - 1) {
            process.stdout.write(`\r  Doctors: ${i + 1}/${doctors.length} | Created: ${dCreated} | Updated: ${dUpdated} | Failed: ${dFailed}`);
        }
    }
    console.log('\n');

    // ---- Summary ----
    console.log('==========================================================');
    console.log('  SYNC COMPLETE');
    console.log('----------------------------------------------------------');
    console.log(`  Patients:     ${patients.length} total | ${pCreated} created | ${pUpdated} updated | ${pFailed} failed`);
    console.log(`  Doctors:      ${doctors.length} total | ${dCreated} created | ${dUpdated} updated | ${dFailed} failed`);
    console.log('==========================================================');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
