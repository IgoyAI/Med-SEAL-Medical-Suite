#!/usr/bin/env node
/**
 * Med-SEAL Full Data Sync: Medplum FHIR → OpenEMR Direct DB
 *
 * Syncs: Practitioners, Encounters, Conditions, Medications,
 *        Immunizations, Allergies
 *
 * Names are cleaned (trailing Synthea numbers removed).
 */

const { execSync } = require('child_process');

const MEDPLUM_BASE = process.env.MEDPLUM_BASE_URL || 'http://localhost:8103';
const CONTAINER = 'medseal-openemr-db';
const DB = 'openemr';

function sql(query) {
    const escaped = query.replace(/"/g, '\\"').replace(/`/g, '\\`');
    try {
        return execSync(
            `docker exec ${CONTAINER} mariadb -u openemr -popenemr ${DB} -N -e "${escaped}"`,
            { stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }
        ).toString().trim();
    } catch (e) { return ''; }
}

function esc(s) {
    if (!s) return '';
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function cleanName(name) {
    return (name || '').replace(/\d+$/, '').trim();
}

// ---- Medplum Auth ----
async function getMedplumToken() {
    const cv = 'sync-' + Date.now();
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

// ---- Fetch all resources from Medplum (paginated) ----
async function fetchAll(token, resourceType, maxPages = 50) {
    const items = [];
    let url = `${MEDPLUM_BASE}/fhir/R4/${resourceType}?_count=200`;
    let page = 0;
    while (url && page < maxPages) {
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) break;
        const bundle = await res.json();
        for (const e of (bundle.entry || [])) if (e.resource) items.push(e.resource);
        const next = (bundle.link || []).find(l => l.relation === 'next');
        url = next ? next.url : null;
        page++;
        process.stdout.write(`\r  Fetched ${items.length} ${resourceType}...`);
    }
    console.log();
    return items;
}

// ---- Build patient PID lookup (Medplum FHIR ID → OpenEMR pid) ----
// We stored patients in order, so pid = index + 1
let patientMap = {}; // fhir_id -> openemr_pid

async function buildPatientMap(token) {
    const patients = await fetchAll(token, 'Patient', 20);
    patients.forEach((p, i) => {
        patientMap[p.id] = i + 1;
    });
    console.log(`  Patient map built: ${Object.keys(patientMap).length} entries`);
}

// ---- Sync Practitioners → users table ----
async function syncPractitioners(token) {
    console.log('\n📋 Syncing Practitioners...');
    const practitioners = await fetchAll(token, 'Practitioner', 20);
    let ok = 0, fail = 0;

    for (const p of practitioners) {
        const name = p.name?.[0] || {};
        const fname = esc(cleanName(name.given?.[0] || 'Unknown'));
        const lname = esc(cleanName(name.family || 'Unknown'));
        const npi = p.identifier?.find(i => i.system?.includes('npi'))?.value || '';
        const qual = p.qualification?.[0]?.code?.text || '';
        const specialty = esc(qual);

        try {
            sql(`INSERT INTO users (username, password, authorized, fname, lname, npi, specialty, active, see_auth, facility_id, title) VALUES ('${esc(lname.toLowerCase())}', '', 1, '${fname}', '${lname}', '${esc(npi)}', '${specialty}', 1, 1, 0, 'Dr.')`);
            ok++;
        } catch (e) { fail++; }
    }
    console.log(`  ✅ ${ok} practitioners  ❌ ${fail} failures`);
    return ok;
}

// ---- Sync Encounters → form_encounter ----
async function syncEncounters(token) {
    console.log('\n📋 Syncing Encounters...');
    const encounters = await fetchAll(token, 'Encounter', 100);
    let ok = 0, fail = 0, skip = 0;

    for (let i = 0; i < encounters.length; i++) {
        const e = encounters[i];
        const patRef = e.subject?.reference || '';
        const patId = patRef.replace('Patient/', '');
        const pid = patientMap[patId];
        if (!pid) { skip++; continue; }

        const date = e.period?.start?.substring(0, 19)?.replace('T', ' ') || '2024-01-01 00:00:00';
        const dateEnd = e.period?.end?.substring(0, 19)?.replace('T', ' ') || '';
        const reason = esc((e.reasonCode?.[0]?.text || e.type?.[0]?.text || '').substring(0, 200));
        const classCode = e.class?.code || 'AMB';
        const encId = i + 1;

        try {
            sql(`INSERT INTO form_encounter (date, reason, facility, facility_id, pid, encounter, provider_id, class_code, date_end) VALUES ('${date}', '${reason}', 'Med-SEAL General Hospital', 3, ${pid}, ${encId}, 1, '${esc(classCode)}', '${dateEnd}')`);
            // Also insert into forms table
            sql(`INSERT INTO forms (date, encounter, form_name, form_id, pid, user, formdir) VALUES ('${date}', ${encId}, 'New Patient Encounter', LAST_INSERT_ID(), ${pid}, 'admin', 'newpatient')`);
            ok++;
        } catch (e) { fail++; }

        if ((i + 1) % 500 === 0) console.log(`  Progress: ${i + 1}/${encounters.length} (✅ ${ok})`);
    }
    console.log(`  ✅ ${ok} encounters  ❌ ${fail} failures  ⏭️ ${skip} skipped`);
    return ok;
}

// ---- Sync Conditions → lists (type='medical_problem') ----
async function syncConditions(token) {
    console.log('\n📋 Syncing Conditions (Diagnoses)...');
    const conditions = await fetchAll(token, 'Condition', 80);
    let ok = 0, fail = 0, skip = 0;

    for (let i = 0; i < conditions.length; i++) {
        const c = conditions[i];
        const patRef = c.subject?.reference || '';
        const patId = patRef.replace('Patient/', '');
        const pid = patientMap[patId];
        if (!pid) { skip++; continue; }

        const title = esc((c.code?.text || c.code?.coding?.[0]?.display || 'Unknown').substring(0, 200));
        const icd = c.code?.coding?.find(cd => cd.system?.includes('icd') || cd.system?.includes('snomed'))?.code || '';
        const diagnosis = icd ? `ICD10:${esc(icd)}` : '';
        const begdate = c.onsetDateTime?.substring(0, 10) || c.recordedDate?.substring(0, 10) || '';
        const enddate = c.abatementDateTime?.substring(0, 10) || '';
        const activity = c.clinicalStatus?.coding?.[0]?.code === 'resolved' ? 0 : 1;

        try {
            sql(`INSERT INTO lists (date, type, title, diagnosis, begdate, enddate, activity, pid, user) VALUES (NOW(), 'medical_problem', '${title}', '${diagnosis}', '${begdate}', '${enddate}', ${activity}, ${pid}, 'admin')`);
            ok++;
        } catch (e) { fail++; }

        if ((i + 1) % 1000 === 0) console.log(`  Progress: ${i + 1}/${conditions.length} (✅ ${ok})`);
    }
    console.log(`  ✅ ${ok} conditions  ❌ ${fail} failures  ⏭️ ${skip} skipped`);
}

// ---- Sync MedicationRequests → prescriptions ----
async function syncMedications(token) {
    console.log('\n📋 Syncing Medications...');
    const meds = await fetchAll(token, 'MedicationRequest', 60);
    let ok = 0, fail = 0, skip = 0;

    for (let i = 0; i < meds.length; i++) {
        const m = meds[i];
        const patRef = m.subject?.reference || '';
        const patId = patRef.replace('Patient/', '');
        const pid = patientMap[patId];
        if (!pid) { skip++; continue; }

        const drug = esc((m.medicationCodeableConcept?.text || m.medicationCodeableConcept?.coding?.[0]?.display || 'Unknown Medication').substring(0, 200));
        const rxnorm = m.medicationCodeableConcept?.coding?.find(c => c.system?.includes('rxnorm'))?.code || '';
        const dosage = esc((m.dosageInstruction?.[0]?.text || '').substring(0, 100));
        const startDate = m.authoredOn?.substring(0, 10) || '';
        const active = m.status === 'active' ? 1 : 0;

        try {
            sql(`INSERT INTO prescriptions (patient_id, date_added, provider_id, drug, rxnorm_drugcode, dosage, start_date, active, medication) VALUES (${pid}, NOW(), 1, '${drug}', '${esc(rxnorm)}', '${dosage}', '${startDate}', ${active}, 1)`);
            ok++;
        } catch (e) { fail++; }

        if ((i + 1) % 500 === 0) console.log(`  Progress: ${i + 1}/${meds.length} (✅ ${ok})`);
    }
    console.log(`  ✅ ${ok} medications  ❌ ${fail} failures  ⏭️ ${skip} skipped`);
}

// ---- Sync Immunizations ----
async function syncImmunizations(token) {
    console.log('\n📋 Syncing Immunizations...');
    const imms = await fetchAll(token, 'Immunization', 40);
    let ok = 0, fail = 0, skip = 0;

    for (let i = 0; i < imms.length; i++) {
        const im = imms[i];
        const patRef = im.patient?.reference || '';
        const patId = patRef.replace('Patient/', '');
        const pid = patientMap[patId];
        if (!pid) { skip++; continue; }

        const vaccine = esc((im.vaccineCode?.text || im.vaccineCode?.coding?.[0]?.display || 'Unknown').substring(0, 200));
        const cvx = im.vaccineCode?.coding?.find(c => c.system?.includes('cvx'))?.code || '';
        const adminDate = im.occurrenceDateTime?.substring(0, 10) || '';

        try {
            sql(`INSERT INTO immunizations (patient_id, administered_date, immunization_id, cvx_code, note, added_erroneously) VALUES (${pid}, '${adminDate}', 0, '${esc(cvx)}', '${vaccine}', 0)`);
            ok++;
        } catch (e) { fail++; }

        if ((i + 1) % 500 === 0) console.log(`  Progress: ${i + 1}/${imms.length} (✅ ${ok})`);
    }
    console.log(`  ✅ ${ok} immunizations  ❌ ${fail} failures  ⏭️ ${skip} skipped`);
}

// ---- Sync Allergies → lists (type='allergy') ----
async function syncAllergies(token) {
    console.log('\n📋 Syncing Allergies...');
    const allergies = await fetchAll(token, 'AllergyIntolerance', 10);
    let ok = 0, fail = 0, skip = 0;

    for (const a of allergies) {
        const patRef = a.patient?.reference || '';
        const patId = patRef.replace('Patient/', '');
        const pid = patientMap[patId];
        if (!pid) { skip++; continue; }

        const title = esc((a.code?.text || a.code?.coding?.[0]?.display || 'Unknown Allergy').substring(0, 200));
        const severity = a.reaction?.[0]?.severity || '';
        const begdate = a.onsetDateTime?.substring(0, 10) || a.recordedDate?.substring(0, 10) || '';

        try {
            sql(`INSERT INTO lists (date, type, title, begdate, activity, pid, user, severity_al) VALUES (NOW(), 'allergy', '${title}', '${begdate}', 1, ${pid}, 'admin', '${esc(severity)}')`);
            ok++;
        } catch (e) { fail++; }
    }
    console.log(`  ✅ ${ok} allergies  ❌ ${fail} failures  ⏭️ ${skip} skipped`);
}

// ---- Main ----
async function main() {
    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║  Med-SEAL Full Data Sync: Medplum → OpenEMR  ║');
    console.log('╚═══════════════════════════════════════════════╝\n');

    console.log('Authenticating with Medplum...');
    const token = await getMedplumToken();
    console.log('✅ Authenticated\n');

    console.log('Building patient map...');
    await buildPatientMap(token);

    // Clear existing synced data (except patients)
    console.log('\nClearing previous synced data...');
    sql("DELETE FROM users WHERE id > 1");
    sql("DELETE FROM form_encounter WHERE 1=1");
    sql("DELETE FROM forms WHERE formdir='newpatient'");
    sql("DELETE FROM lists WHERE type IN ('medical_problem','allergy')");
    sql("DELETE FROM prescriptions WHERE 1=1");
    sql("DELETE FROM immunizations WHERE 1=1");
    console.log('Cleared.\n');

    await syncPractitioners(token);
    await syncEncounters(token);
    await syncConditions(token);
    await syncMedications(token);
    await syncImmunizations(token);
    await syncAllergies(token);

    // Sync OpenEMR appointments to FHIR (reverse direction)
    console.log('\n📋 Syncing Appointments (OpenEMR → Medplum FHIR)...');
    try {
        const { execSync: exec2 } = require('child_process');
        exec2('node scripts/sync-appointments.js', { cwd: process.cwd(), stdio: 'inherit', timeout: 300000 });
    } catch (e) {
        console.error('  Appointment sync failed:', e.message);
    }

    // Summary
    console.log('\n╔═══════════════════════════════════════════════╗');
    console.log('║              SYNC COMPLETE                     ║');
    console.log('╠═══════════════════════════════════════════════╣');
    const counts = {
        'Patients': sql("SELECT COUNT(*) FROM patient_data"),
        'Practitioners': sql("SELECT COUNT(*) FROM users WHERE id > 1"),
        'Encounters': sql("SELECT COUNT(*) FROM form_encounter"),
        'Conditions': sql("SELECT COUNT(*) FROM lists WHERE type='medical_problem'"),
        'Medications': sql("SELECT COUNT(*) FROM prescriptions"),
        'Immunizations': sql("SELECT COUNT(*) FROM immunizations"),
        'Allergies': sql("SELECT COUNT(*) FROM lists WHERE type='allergy'"),
    };
    for (const [k, v] of Object.entries(counts)) {
        console.log(`║  ${k.padEnd(15)} ${String(v).padStart(8)}              ║`);
    }
    console.log('╚═══════════════════════════════════════════════╝');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
