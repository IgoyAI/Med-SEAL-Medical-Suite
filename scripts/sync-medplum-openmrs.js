#!/usr/bin/env node
/**
 * Med-SEAL Data Sync: Medplum FHIR → OpenMRS REST
 *
 * Reads patient data from Medplum FHIR and creates patients
 * in OpenMRS via the REST API with proper identifiers.
 */

const MEDPLUM_BASE = process.env.MEDPLUM_BASE_URL || 'http://localhost:8103';
const OPENMRS_BASE = process.env.OPENMRS_BASE || 'http://localhost:8080/openmrs/ws/rest/v1';
const OPENMRS_USER = process.env.OPENMRS_USER || 'admin';
const OPENMRS_PASS = process.env.OPENMRS_PASS || 'Admin123';
const CONCURRENCY = parseInt(process.env.SYNC_CONCURRENCY || '3');
const ID_TYPE_UUID = '334367fd-1d33-11f1-84a0-0aafd43fb0bf'; // "Patient Identifier" type
const LOCATION_UUID = '44c4e56a-643e-4698-86eb-f99ec88bee76'; // MedSEAL General Hospital

// --- Medplum Auth ---
async function getMedplumToken() {
    const cv = 'medseal-sync-' + Date.now();
    const loginRes = await fetch(`${MEDPLUM_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: 'admin@example.com', password: 'medplum_admin',
            scope: 'openid fhirUser', codeChallengeMethod: 'plain', codeChallenge: cv,
        }),
    });
    const { code } = await loginRes.json();
    const tokenRes = await fetch(`${MEDPLUM_BASE}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}&code_verifier=${cv}`,
    });
    const { access_token } = await tokenRes.json();
    return access_token;
}

const omrsAuth = 'Basic ' + Buffer.from(`${OPENMRS_USER}:${OPENMRS_PASS}`).toString('base64');

// --- Fetch all patients from Medplum ---
async function fetchMedplumPatients(token) {
    const patients = [];
    let url = `${MEDPLUM_BASE}/fhir/R4/Patient?_count=100`;
    while (url) {
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) break;
        const bundle = await res.json();
        for (const e of (bundle.entry || [])) if (e.resource) patients.push(e.resource);
        const next = (bundle.link || []).find(l => l.relation === 'next');
        url = next ? next.url : null;
        process.stdout.write(`\r  Fetched ${patients.length} patients...`);
    }
    console.log();
    return patients;
}

// --- Create patient in OpenMRS REST ---
let idCounter = 1000;
async function createInOpenMRS(patient) {
    const name = patient.name?.[0] || {};
    const given = name.given?.[0] || 'Unknown';
    const family = name.family || 'Unknown';
    const middle = name.given?.[1] || '';

    const gender = patient.gender === 'male' ? 'M' : patient.gender === 'female' ? 'F' : 'U';
    const birthdate = patient.birthDate || '1900-01-01';
    const dead = patient.deceasedBoolean === true || !!patient.deceasedDateTime;
    const deathDate = patient.deceasedDateTime ? patient.deceasedDateTime.substring(0, 10) : undefined;

    const addr = patient.address?.[0] || {};

    const body = {
        person: {
            names: [{
                givenName: given,
                middleName: middle || undefined,
                familyName: family,
                preferred: true,
            }],
            gender: gender,
            birthdate: birthdate,
        },
        identifiers: [{
            identifier: `MEDSEAL-${String(idCounter++).padStart(6, '0')}`,
            identifierType: ID_TYPE_UUID,
            location: LOCATION_UUID,
            preferred: true,
        }],
    };

    const res = await fetch(`${OPENMRS_BASE}/patient`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': omrsAuth },
        body: JSON.stringify(body),
    });

    if (res.ok) return { success: true };
    const err = await res.text();
    return { success: false, status: res.status, error: err.substring(0, 150) };
}

// --- Concurrency ---
async function runWithConcurrency(items, fn, limit) {
    const results = [];
    let idx = 0;
    await Promise.all(Array.from({ length: limit }, async () => {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i], i);
        }
    }));
    return results;
}

// --- Main ---
async function main() {
    console.log('=== Med-SEAL Data Sync: Medplum → OpenMRS ===\n');

    console.log('Authenticating with Medplum...');
    const token = await getMedplumToken();
    console.log('✅ Medplum authenticated\n');

    console.log('Fetching patients from Medplum...');
    const patients = await fetchMedplumPatients(token);
    console.log(`Found ${patients.length} patients\n`);

    console.log('Syncing patients to OpenMRS...');
    let ok = 0, fail = 0;
    await runWithConcurrency(patients, async (p, i) => {
        const r = await createInOpenMRS(p);
        if (r.success) { ok++; }
        else {
            fail++;
            if (fail <= 3) console.log(`  ❌ ${p.name?.[0]?.family}: ${r.status} ${r.error}`);
        }
        if ((ok + fail) % 50 === 0 || (ok + fail) === patients.length) {
            console.log(`  Progress: ${ok + fail}/${patients.length} (✅ ${ok} ❌ ${fail})`);
        }
    }, CONCURRENCY);

    console.log(`\n=== Done ===`);
    console.log(`✅ ${ok}  ❌ ${fail}  Total: ${patients.length}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
