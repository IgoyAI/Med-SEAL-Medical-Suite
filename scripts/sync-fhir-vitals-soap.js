const mysql = require('mysql2/promise');
const MEDPLUM_BASE = 'http://localhost:8103';

async function getToken() {
    const cv = 'sync-' + Date.now();
    const login = await fetch(MEDPLUM_BASE + '/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com', password: 'medplum_admin', scope: 'openid fhirUser', codeChallengeMethod: 'plain', codeChallenge: cv }),
    });
    const { code } = await login.json();
    const tok = await fetch(MEDPLUM_BASE + '/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=authorization_code&code=' + code + '&code_verifier=' + cv,
    });
    const { access_token } = await tok.json();
    return access_token;
}

async function buildPatientMap(token) {
    const map = {};
    let url = `${MEDPLUM_BASE}/fhir/R4/Patient?_count=200&_elements=id`;
    let page = 0, idx = 1;
    while (url && page < 100) {
        const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token }, signal: AbortSignal.timeout(30000) });
        if (!res.ok) break;
        const bundle = await res.json();
        for (const e of (bundle.entry || [])) map[e.resource.id] = idx++;
        const next = (bundle.link || []).find(l => l.relation === 'next');
        url = next ? next.url : null;
        page++;
    }
    console.log(`Patient map: ${idx - 1} entries`);
    return map;
}

// LOINC codes for common vitals
const VITAL_CODES = {
    '85354-9': 'bp',         // Blood pressure panel
    '8480-6': 'bps',         // Systolic BP
    '8462-4': 'bpd',         // Diastolic BP
    '8867-4': 'pulse',       // Heart rate
    '9279-1': 'respiration', // Respiratory rate
    '8310-5': 'temperature', // Body temperature
    '29463-7': 'weight',     // Body weight
    '8302-2': 'height',      // Body height
    '39156-5': 'BMI',        // BMI
    '2708-6': 'oxygen_saturation', // O2 sat
    '59408-5': 'oxygen_saturation', // O2 sat (pulse ox)
};

(async () => {
    console.log('=== Syncing FHIR Vitals & SOAP to OpenEMR Encounters ===\n');

    let token = await getToken();
    const pool = mysql.createPool({
        host: 'localhost', port: 3307,
        user: 'openemr', password: 'openemr', database: 'openemr',
    });
    const patMap = await buildPatientMap(token);
    token = await getToken();

    // Get existing encounter IDs for new encounters (3207+)
    const [encRows] = await pool.query('SELECT id, encounter, pid, date, reason FROM form_encounter WHERE encounter >= 3207 ORDER BY encounter');
    console.log(`Found ${encRows.length} new encounters to update\n`);

    // Step 1: Sync FHIR vital-signs Observations into form_vitals
    console.log('Syncing Vitals from FHIR Observations...');
    let url = `${MEDPLUM_BASE}/fhir/R4/Observation?category=vital-signs&_count=50&_sort=-date`;
    let vitalsInserted = 0, page = 0;

    // Build encounter lookup by pid+date for matching
    const encLookup = {};
    for (const enc of encRows) {
        const dateKey = enc.date.toISOString().split('T')[0];
        const key = `${enc.pid}_${dateKey}`;
        if (!encLookup[key]) encLookup[key] = enc;
    }

    while (url && page < 2000) {
        try {
            const res = await fetch(url, {
                headers: { 'Authorization': 'Bearer ' + token },
                signal: AbortSignal.timeout(30000),
            });
            if (!res.ok) { console.log(`  HTTP ${res.status} on page ${page}, stopping`); break; }
            const bundle = await res.json();
            const entries = bundle.entry || [];
            if (entries.length === 0) break;

            for (const e of entries) {
                const obs = e.resource;
                const patRef = (obs.subject?.reference || '').replace('Patient/', '');
                const pid = patMap[patRef] || 0;
                if (!pid) continue;

                const obsDate = obs.effectiveDateTime?.split('T')[0] || '';
                if (!obsDate) continue;

                const code = obs.code?.coding?.[0]?.code || '';
                const vitalType = VITAL_CODES[code];
                if (!vitalType) continue;

                // Try match to encounter
                const key = `${pid}_${obsDate}`;
                const enc = encLookup[key];
                if (!enc) continue;

                // Extract value
                let value = obs.valueQuantity?.value;
                let bps = null, bpd = null;

                if (vitalType === 'bp' && obs.component) {
                    bps = obs.component.find(c => c.code?.coding?.[0]?.code === '8480-6')?.valueQuantity?.value;
                    bpd = obs.component.find(c => c.code?.coding?.[0]?.code === '8462-4')?.valueQuantity?.value;
                }

                // Check if vitals record exists for this encounter
                const [existing] = await pool.query('SELECT id FROM form_vitals WHERE id = ?', [enc.encounter]);

                if (existing.length > 0) {
                    // Update existing vitals
                    if (vitalType === 'bp' && bps) {
                        await pool.query('UPDATE form_vitals SET bps = ?, bpd = ? WHERE id = ?', [bps, bpd, enc.encounter]);
                    } else if (value != null) {
                        await pool.query(`UPDATE form_vitals SET ${vitalType} = ? WHERE id = ?`, [value, enc.encounter]);
                    }
                }
                vitalsInserted++;
            }

            const next = (bundle.link || []).find(l => l.relation === 'next');
            url = next ? next.url : null;
            page++;
            if (page % 20 === 0) console.log(`  Vitals: page ${page}, ${vitalsInserted} updated`);
        } catch (err) {
            console.log(`  Vitals error page ${page}: ${err.message}`);
            await new Promise(r => setTimeout(r, 3000));
            try { token = await getToken(); } catch {}
        }
    }
    console.log(`  Vitals DONE: ${vitalsInserted} updated, ${page} pages\n`);

    // Step 2: Update SOAP notes with real clinical data from conditions
    console.log('Updating SOAP notes with real clinical data...');
    token = await getToken();

    // Get conditions per patient from OpenEMR lists (just synced)
    const [condRows] = await pool.query("SELECT pid, GROUP_CONCAT(title SEPARATOR ', ') as conditions FROM lists WHERE type = 'medical_problem' AND activity = 1 GROUP BY pid");
    const condMap = {};
    for (const r of condRows) condMap[r.pid] = r.conditions;

    // Get medications per patient
    const [medRows] = await pool.query("SELECT pid, GROUP_CONCAT(title SEPARATOR ', ') as meds FROM lists WHERE type = 'medication' AND activity = 1 GROUP BY pid");
    const medMap = {};
    for (const r of medRows) medMap[r.pid] = r.meds;

    // Get allergies per patient
    const [allergyRows] = await pool.query("SELECT pid, GROUP_CONCAT(title SEPARATOR ', ') as allergies FROM lists WHERE type = 'allergy' GROUP BY pid");
    const allergyMap = {};
    for (const r of allergyRows) allergyMap[r.pid] = r.allergies;

    let soapUpdated = 0;
    for (const enc of encRows) {
        const conditions = condMap[enc.pid] || 'No active conditions';
        const meds = medMap[enc.pid] || 'No current medications';
        const allergies = allergyMap[enc.pid] || 'NKDA';

        // Get vitals for this encounter
        const [vitals] = await pool.query('SELECT bps, bpd, pulse, respiration, temperature, weight, height, BMI, oxygen_saturation FROM form_vitals WHERE id = ?', [enc.encounter]);
        let vitalsText = 'Vitals not recorded for this visit.';
        if (vitals.length > 0) {
            const v = vitals[0];
            const parts = [];
            if (v.bps) parts.push(`BP: ${v.bps}/${v.bpd || '?'} mmHg`);
            if (v.pulse) parts.push(`HR: ${v.pulse} bpm`);
            if (v.respiration) parts.push(`RR: ${v.respiration}/min`);
            if (v.temperature) parts.push(`Temp: ${v.temperature} F`);
            if (v.weight) parts.push(`Wt: ${v.weight} kg`);
            if (v.height) parts.push(`Ht: ${v.height} cm`);
            if (v.BMI) parts.push(`BMI: ${v.BMI}`);
            if (v.oxygen_saturation) parts.push(`SpO2: ${v.oxygen_saturation}%`);
            if (parts.length > 0) vitalsText = parts.join(', ');
        }

        const subjective = `${enc.reason || 'General visit'}.\nActive conditions: ${conditions.substring(0, 500)}.\nAllergies: ${allergies.substring(0, 200)}.`;
        const objective = `${vitalsText}\nGeneral: Alert, oriented, in no acute distress.\nPhysical exam performed as clinically indicated.`;
        const assessment = `Clinical assessment for: ${enc.reason || 'General evaluation'}.\nActive problems: ${conditions.substring(0, 300)}.`;
        const plan = `Current medications: ${meds.substring(0, 500)}.\nContinue current management. Follow up as scheduled.`;

        // Update existing SOAP note
        const [soapExists] = await pool.query(
            'SELECT id FROM form_soap WHERE pid = ? AND date = ?',
            [enc.pid, enc.date]
        );
        
        if (soapExists.length > 0) {
            await pool.query(
                'UPDATE form_soap SET subjective = ?, objective = ?, assessment = ?, plan = ? WHERE id = ?',
                [subjective, objective, assessment, plan, soapExists[0].id]
            );
        }
        soapUpdated++;
        if (soapUpdated % 1000 === 0) console.log(`  SOAP: ${soapUpdated}/${encRows.length} updated`);
    }
    console.log(`  SOAP DONE: ${soapUpdated} updated\n`);

    console.log('=== SYNC COMPLETE ===');
    await pool.end();
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
