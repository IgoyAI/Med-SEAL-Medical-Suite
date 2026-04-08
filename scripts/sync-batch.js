#!/usr/bin/env node
/**
 * Med-SEAL Sync: Medications + Immunizations (Batch SQL)
 * Writes SQL file then runs it in one shot to avoid per-row exec failures.
 */
const { execSync, writeFileSync } = require('child_process');
const fs = require('fs');
const MEDPLUM_BASE = 'http://localhost:8103';

function esc(s) { return s ? String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"') : ''; }

async function getToken() {
    const cv = 's4-' + Date.now();
    const l = await fetch(`${MEDPLUM_BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'medplum_admin', scope: 'openid fhirUser', codeChallengeMethod: 'plain', codeChallenge: cv }) });
    const { code } = await l.json();
    const t = await fetch(`${MEDPLUM_BASE}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=authorization_code&code=${code}&code_verifier=${cv}` });
    return (await t.json()).access_token;
}

async function fetchAll(token, type, maxPages = 100) {
    const items = [];
    let url = `${MEDPLUM_BASE}/fhir/R4/${type}?_count=100`;
    let page = 0;
    while (url && page < maxPages) {
        try {
            const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
            if (!r.ok) break;
            const b = await r.json();
            for (const e of (b.entry || [])) if (e.resource) items.push(e.resource);
            const n = (b.link || []).find(l => l.relation === 'next');
            url = n ? n.url : null; page++;
            process.stdout.write(`\r  ${items.length} ${type}...`);
        } catch (e) { console.log(`\n  Retry...`); await new Promise(r => setTimeout(r, 2000)); }
    }
    console.log();
    return items;
}

async function main() {
    console.log('=== Batch Sync: Meds + Immunizations ===\n');
    const token = await getToken();
    console.log('✅ Auth OK');

    // Build patient map
    const patients = await fetchAll(token, 'Patient', 20);
    const patientMap = {};
    patients.forEach((p, i) => { patientMap[p.id] = i + 1; });
    console.log(`Patient map: ${Object.keys(patientMap).length}\n`);

    // --- Medications → SQL file ---
    console.log('💊 Fetching MedicationRequests...');
    const meds = await fetchAll(token, 'MedicationRequest', 100);
    let sqlLines = [];
    let ok = 0, skip = 0;
    for (const m of meds) {
        const pid = patientMap[(m.subject?.reference || '').replace('Patient/', '')];
        if (!pid) { skip++; continue; }
        const drug = esc((m.medicationCodeableConcept?.text || m.medicationCodeableConcept?.coding?.[0]?.display || 'Unknown').substring(0, 200));
        const rxnorm = m.medicationCodeableConcept?.coding?.find(c => c.system?.includes('rxnorm'))?.code || '';
        const dosage = esc((m.dosageInstruction?.[0]?.text || '').substring(0, 100));
        const startDate = m.authoredOn?.substring(0, 10) || '2024-01-01';
        const active = m.status === 'active' ? 1 : 0;
        sqlLines.push(`INSERT INTO prescriptions(patient_id,date_added,provider_id,drug,rxnorm_drugcode,dosage,start_date,active,medication)VALUES(${pid},NOW(),1,'${drug}','${esc(rxnorm)}','${dosage}','${startDate}',${active},1);`);
        ok++;
    }
    console.log(`  Built ${ok} medication inserts (${skip} skipped)`);

    // --- Immunizations → SQL file ---
    console.log('\n💉 Fetching Immunizations...');
    const imms = await fetchAll(token, 'Immunization', 60);
    let imOk = 0, imSkip = 0;
    for (const im of imms) {
        const pid = patientMap[(im.patient?.reference || '').replace('Patient/', '')];
        if (!pid) { imSkip++; continue; }
        const vaccine = esc((im.vaccineCode?.text || im.vaccineCode?.coding?.[0]?.display || 'Unknown').substring(0, 200));
        const cvx = im.vaccineCode?.coding?.find(c => c.system?.includes('cvx'))?.code || '';
        const d = im.occurrenceDateTime?.substring(0, 10) || '2024-01-01';
        sqlLines.push(`INSERT INTO immunizations(patient_id,administered_date,immunization_id,cvx_code,note,added_erroneously)VALUES(${pid},'${d}',0,'${esc(cvx)}','${vaccine}',0);`);
        imOk++;
    }
    console.log(`  Built ${imOk} immunization inserts (${imSkip} skipped)`);

    // Write SQL file and execute in batch
    const sqlFile = '/tmp/medseal_batch_sync.sql';
    fs.writeFileSync(sqlFile, sqlLines.join('\n'));
    console.log(`\n📄 SQL file: ${sqlFile} (${sqlLines.length} statements)`);
    console.log('Executing batch...');

    // Copy SQL file into container and run
    try {
        execSync(`docker cp ${sqlFile} medseal-openemr-db:/tmp/batch_sync.sql`, { stdio: 'pipe' });
        const result = execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -e "source /tmp/batch_sync.sql"`, { stdio: 'pipe', timeout: 120000 });
        console.log('✅ Batch executed!');
    } catch (e) {
        console.error('Batch error:', e.stderr?.toString().substring(0, 500) || e.message);
    }

    // Verify
    const rx = execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -N -e "SELECT COUNT(*) FROM prescriptions"`, { stdio: 'pipe' }).toString().trim();
    const im = execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -N -e "SELECT COUNT(*) FROM immunizations"`, { stdio: 'pipe' }).toString().trim();
    console.log(`\n=== VERIFIED ===`);
    console.log(`Prescriptions: ${rx}`);
    console.log(`Immunizations: ${im}`);
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
