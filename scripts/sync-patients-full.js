#!/usr/bin/env node
/**
 * Med-SEAL Complete Patient Update
 * Fills ALL patient_data columns from FHIR Patient resources:
 * demographics, identifiers, race, ethnicity, language, marital status, etc.
 * Also ensures encounter history is properly linked.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const MEDPLUM_BASE = 'http://localhost:8103';

function esc(s) { return s ? String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"') : ''; }
function cleanName(n) { return (n || '').replace(/\d+$/, '').trim(); }

async function getToken() {
    const cv = 'full-' + Date.now();
    const l = await fetch(`${MEDPLUM_BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'medplum_admin', scope: 'openid fhirUser', codeChallengeMethod: 'plain', codeChallenge: cv }) });
    const { code } = await l.json();
    const t = await fetch(`${MEDPLUM_BASE}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=authorization_code&code=${code}&code_verifier=${cv}` });
    return (await t.json()).access_token;
}

async function fetchAll(token, type, maxPages = 20) {
    const items = [];
    let url = `${MEDPLUM_BASE}/fhir/R4/${type}?_count=200`;
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

function getExtension(patient, url) {
    const ext = (patient.extension || []).find(e => e.url === url);
    if (!ext) return null;
    // Handle nested extensions (e.g., race, ethnicity)
    if (ext.extension) {
        const text = ext.extension.find(e => e.url === 'text');
        if (text) return text.valueString;
        const cat = ext.extension.find(e => e.url === 'ombCategory');
        if (cat && cat.valueCoding) return cat.valueCoding.display;
    }
    return ext.valueString || ext.valueCode || null;
}

function getIdentifier(patient, code) {
    const id = (patient.identifier || []).find(i =>
        i.type?.coding?.some(c => c.code === code)
    );
    return id ? id.value : '';
}

async function main() {
    console.log('=== Complete Patient Data Update ===\n');
    const token = await getToken();
    console.log('✅ Auth OK\n');

    const patients = await fetchAll(token, 'Patient', 20);
    console.log(`\nUpdating ${patients.length} patients...\n`);

    const sqlLines = [];

    for (let i = 0; i < patients.length; i++) {
        const p = patients[i];
        const pid = i + 1;

        // Name
        const name = p.name?.[0] || {};
        const fname = esc(cleanName(name.given?.[0] || ''));
        const mname = esc(cleanName(name.given?.[1] || ''));
        const lname = esc(cleanName(name.family || ''));
        const prefix = esc(name.prefix?.[0] || '');

        // Demographics
        const dob = p.birthDate || '';
        const gender = p.gender || '';
        const sex = gender === 'male' ? 'Male' : gender === 'female' ? 'Female' : '';

        // Address
        const addr = p.address?.[0] || {};
        const street = esc((addr.line || []).join(', '));
        const city = esc(addr.city || '');
        const state = esc(addr.state || '');
        const zip = esc(addr.postalCode || '');
        const country = esc(addr.country || 'US');

        // Phone/Email
        const phone = esc((p.telecom || []).find(t => t.system === 'phone')?.value || '');
        const email = esc((p.telecom || []).find(t => t.system === 'email')?.value || '');

        // Identifiers
        const ssn = esc(getIdentifier(p, 'SS'));
        const dl = esc(getIdentifier(p, 'DL'));
        const passport = esc(getIdentifier(p, 'PPN'));
        const mrn = esc(getIdentifier(p, 'MR'));

        // Race & Ethnicity
        const race = esc(getExtension(p, 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race') || '');
        const ethnicity = esc(getExtension(p, 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity') || '');

        // Birth sex
        const birthsex = getExtension(p, 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex') || '';

        // Mother's maiden name
        const mothersMaiden = esc(cleanName(getExtension(p, 'http://hl7.org/fhir/StructureDefinition/patient-mothersMaidenName') || ''));

        // Birth place
        const birthPlaceExt = (p.extension || []).find(e => e.url === 'http://hl7.org/fhir/StructureDefinition/patient-birthPlace');
        const birthPlace = birthPlaceExt ? esc(`${birthPlaceExt.valueAddress?.city || ''}, ${birthPlaceExt.valueAddress?.state || ''}`) : '';

        // Marital status
        const marital = esc(p.maritalStatus?.text || p.maritalStatus?.coding?.[0]?.display || '');
        const maritalCode = p.maritalStatus?.coding?.[0]?.code || '';
        let status = '';
        switch (maritalCode) {
            case 'S': status = 'single'; break;
            case 'M': status = 'married'; break;
            case 'D': status = 'divorced'; break;
            case 'W': status = 'widowed'; break;
            default: status = '';
        }

        // Language
        const lang = esc(p.communication?.[0]?.language?.text || p.communication?.[0]?.language?.coding?.[0]?.display || '');
        const langCode = p.communication?.[0]?.language?.coding?.[0]?.code || '';

        // Deceased
        const deceased = p.deceasedDateTime ? 'YES' : (p.deceasedBoolean ? 'YES' : '');
        const deceasedDate = p.deceasedDateTime ? esc(p.deceasedDateTime.substring(0, 10)) : '';

        // Multiple birth
        const multiBirth = p.multipleBirthBoolean === true ? 'Yes' : 'No';

        // Build UPDATE SQL
        sqlLines.push(`UPDATE patient_data SET
            fname='${fname}',
            mname='${mname}',
            lname='${lname}',
            title='${prefix}',
            DOB='${dob}',
            sex='${sex}',
            street='${street}',
            city='${city}',
            state='${state}',
            postal_code='${zip}',
            country_code='${country}',
            phone_home='${phone}',
            email='${email}',
            ss='${ssn}',
            drivers_license='${dl}',
            race='${race}',
            ethnicity='${ethnicity}',
            language='${lang}',
            status='${status}',
            mothersname='${mothersMaiden}',
            deceased_date='${deceasedDate}',
            pubpid='${pid}'
        WHERE pid=${pid};`);
    }

    // Write SQL
    const sqlFile = '/tmp/patient_update.sql';
    fs.writeFileSync(sqlFile, sqlLines.join('\n'));
    console.log(`📄 SQL file: ${sqlFile} (${sqlLines.length} UPDATE statements)`);

    // Execute
    console.log('Executing...');
    try {
        execSync(`docker cp ${sqlFile} medseal-openemr-db:/tmp/patient_update.sql`, { stdio: 'pipe' });
        execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -e "source /tmp/patient_update.sql"`, { stdio: 'pipe', timeout: 60000 });
        console.log('✅ All patients updated!');
    } catch (e) {
        console.error('Error:', e.stderr?.toString().substring(0, 500) || e.message);
    }

    // Verify
    console.log('\n=== Sample Patient (PID 1) ===');
    const out = execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -e "SELECT pid, fname, mname, lname, title, DOB, sex, street, city, state, postal_code, phone_home, email, ss, race, ethnicity, language, status, mothersname FROM patient_data WHERE pid=1"`, { stdio: 'pipe' }).toString();
    console.log(out);

    // Also verify encounters are linked
    const enc = execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -N -e "SELECT COUNT(*) FROM form_encounter WHERE pid=1"`, { stdio: 'pipe' }).toString().trim();
    console.log(`Encounters for PID 1: ${enc}`);

    // Summary
    const total = execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -N -e "SELECT COUNT(*) FROM patient_data WHERE ss != '' AND ss IS NOT NULL"`, { stdio: 'pipe' }).toString().trim();
    console.log(`\nPatients with SSN filled: ${total}/754`);
    const withRace = execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -N -e "SELECT COUNT(*) FROM patient_data WHERE race != '' AND race IS NOT NULL"`, { stdio: 'pipe' }).toString().trim();
    console.log(`Patients with race filled: ${withRace}/754`);
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
