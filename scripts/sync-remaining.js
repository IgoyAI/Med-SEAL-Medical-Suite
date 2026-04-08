#!/usr/bin/env node
/**
 * Med-SEAL Sync: Medications, Immunizations, Allergies
 */
const { execSync } = require('child_process');
const MEDPLUM_BASE = 'http://localhost:8103';

function sql(q) {
    const escaped = q.replace(/"/g, '\\"').replace(/`/g, '\\`');
    try { return execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -N -e "${escaped}"`, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }).toString().trim(); }
    catch (e) { return ''; }
}
function esc(s) { return s ? String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"') : ''; }

async function getToken() {
    const cv = 's3-' + Date.now();
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
        } catch (e) {
            console.log(`\n  Retry page ${page}...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    console.log();
    return items;
}

let patientMap = {};
async function buildMap(token) {
    const patients = await fetchAll(token, 'Patient', 20);
    patients.forEach((p, i) => { patientMap[p.id] = i + 1; });
}

async function main() {
    console.log('=== Sync: Meds, Immunizations, Allergies ===\n');
    const token = await getToken();
    console.log('✅ Auth OK'); await buildMap(token);

    // Medications
    console.log('\n💊 Medications...');
    const meds = await fetchAll(token, 'MedicationRequest', 100);
    let ok = 0, fail = 0, skip = 0;
    for (const m of meds) {
        const pid = patientMap[(m.subject?.reference || '').replace('Patient/', '')];
        if (!pid) { skip++; continue; }
        const drug = esc((m.medicationCodeableConcept?.text || m.medicationCodeableConcept?.coding?.[0]?.display || 'Unknown').substring(0, 200));
        const rxnorm = m.medicationCodeableConcept?.coding?.find(c => c.system?.includes('rxnorm'))?.code || '';
        const dosage = esc((m.dosageInstruction?.[0]?.text || '').substring(0, 100));
        const startDate = m.authoredOn?.substring(0, 10) || '';
        const active = m.status === 'active' ? 1 : 0;
        try { sql(`INSERT INTO prescriptions(patient_id,date_added,provider_id,drug,rxnorm_drugcode,dosage,start_date,active,medication)VALUES(${pid},NOW(),1,'${drug}','${esc(rxnorm)}','${dosage}','${startDate}',${active},1)`); ok++; } catch (e) { fail++; }
        if (ok % 500 === 0 && ok > 0) console.log(`  Progress: ${ok}`);
    }
    console.log(`  ✅ ${ok}  ❌ ${fail}  ⏭️ ${skip}`);

    // Immunizations
    console.log('\n💉 Immunizations...');
    const imms = await fetchAll(token, 'Immunization', 60);
    ok = 0; fail = 0; skip = 0;
    for (const im of imms) {
        const pid = patientMap[(im.patient?.reference || '').replace('Patient/', '')];
        if (!pid) { skip++; continue; }
        const vaccine = esc((im.vaccineCode?.text || im.vaccineCode?.coding?.[0]?.display || 'Unknown').substring(0, 200));
        const cvx = im.vaccineCode?.coding?.find(c => c.system?.includes('cvx'))?.code || '';
        const d = im.occurrenceDateTime?.substring(0, 10) || '';
        try { sql(`INSERT INTO immunizations(patient_id,administered_date,immunization_id,cvx_code,note,added_erroneously)VALUES(${pid},'${d}',0,'${esc(cvx)}','${vaccine}',0)`); ok++; } catch (e) { fail++; }
        if (ok % 500 === 0 && ok > 0) console.log(`  Progress: ${ok}`);
    }
    console.log(`  ✅ ${ok}  ❌ ${fail}  ⏭️ ${skip}`);

    // Allergies
    console.log('\n⚠️ Allergies...');
    const allergies = await fetchAll(token, 'AllergyIntolerance', 10);
    ok = 0; fail = 0; skip = 0;
    for (const a of allergies) {
        const pid = patientMap[(a.patient?.reference || '').replace('Patient/', '')];
        if (!pid) { skip++; continue; }
        const title = esc((a.code?.text || a.code?.coding?.[0]?.display || 'Unknown').substring(0, 200));
        const severity = a.reaction?.[0]?.severity || '';
        const begdate = a.onsetDateTime?.substring(0, 10) || a.recordedDate?.substring(0, 10) || '';
        try { sql(`INSERT INTO lists(date,type,title,begdate,activity,pid,user,severity_al)VALUES(NOW(),'allergy','${title}','${begdate}',1,${pid},'admin','${esc(severity)}')`); ok++; } catch (e) { fail++; }
    }
    console.log(`  ✅ ${ok}  ❌ ${fail}  ⏭️ ${skip}`);

    console.log('\n=== DONE ===');
    console.log('Prescriptions: ' + sql("SELECT COUNT(*) FROM prescriptions"));
    console.log('Immunizations: ' + sql("SELECT COUNT(*) FROM immunizations"));
    console.log('Allergies:     ' + sql("SELECT COUNT(*) FROM lists WHERE type='allergy'"));
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
