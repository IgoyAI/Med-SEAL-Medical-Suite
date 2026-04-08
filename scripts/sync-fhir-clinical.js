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

// Build FHIR Patient ID -> OpenEMR PID map
async function buildPatientMap(token) {
    const map = {};
    let url = `${MEDPLUM_BASE}/fhir/R4/Patient?_count=200&_elements=id,name`;
    let page = 0;
    let idx = 1;
    while (url && page < 100) {
        const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token }, signal: AbortSignal.timeout(30000) });
        if (!res.ok) break;
        const bundle = await res.json();
        for (const e of (bundle.entry || [])) {
            map[e.resource.id] = idx++;
        }
        const next = (bundle.link || []).find(l => l.relation === 'next');
        url = next ? next.url : null;
        page++;
        if (page % 2 === 0) process.stdout.write(`  Patient map: ${idx-1}...\r`);
    }
    console.log(`  Patient map built: ${idx-1} entries`);
    return map;
}

// Fetch and sync one resource type
async function syncResourceType(token, pool, patMap, config) {
    const { resourceType, listType, label, titleFn, codeFn, dateFn } = config;
    console.log(`\nSyncing ${label}...`);
    
    let url = `${MEDPLUM_BASE}/fhir/R4/${resourceType}?_count=50`;
    let total = 0, inserted = 0, page = 0, retries = 0;

    while (url && page < 2000) {
        try {
            const res = await fetch(url, {
                headers: { 'Authorization': 'Bearer ' + token },
                signal: AbortSignal.timeout(30000),
            });
            if (!res.ok) {
                console.log(`  HTTP ${res.status} on page ${page}, stopping`);
                break;
            }
            const bundle = await res.json();
            const entries = bundle.entry || [];
            if (entries.length === 0) break;

            for (const e of entries) {
                const r = e.resource;
                const patRef = (r.subject?.reference || r.patient?.reference || '').replace('Patient/', '');
                const pid = patMap[patRef] || 0;
                if (pid === 0) continue;

                const title = titleFn(r);
                const code = codeFn(r);
                const date = dateFn(r);
                const active = (r.clinicalStatus?.coding?.[0]?.code === 'active' || r.status === 'active') ? 1 : 0;

                try {
                    await pool.query(
                        'INSERT INTO lists (type, title, diagnosis, begdate, activity, pid) VALUES (?, ?, ?, ?, ?, ?)',
                        [listType, title.substring(0, 255), code.substring(0, 255), date || null, active, pid]
                    );
                    inserted++;
                } catch {}
                total++;
            }

            const next = (bundle.link || []).find(l => l.relation === 'next');
            url = next ? next.url : null;
            page++;
            retries = 0;
            if (page % 10 === 0) console.log(`  ${label}: page ${page}, ${inserted} inserted / ${total} processed`);
        } catch (err) {
            retries++;
            if (retries > 3) {
                console.log(`  ${label}: too many retries, stopping at page ${page}`);
                break;
            }
            console.log(`  ${label}: fetch error on page ${page}, retry ${retries}/3: ${err.message}`);
            await new Promise(r => setTimeout(r, 3000));
            // Refresh token
            try { token = await getToken(); } catch {}
        }
    }
    console.log(`  ${label} DONE: ${inserted} inserted, ${total} processed, ${page} pages`);
    return inserted;
}

(async () => {
    console.log('=== FHIR Clinical Data Sync to OpenEMR ===\n');
    
    let token = await getToken();
    console.log('Authenticated with FHIR\n');

    const pool = mysql.createPool({
        host: 'localhost', port: 3307,
        user: 'openemr', password: process.env.OPENEMR_DB_PASS || 'changeme', database: 'openemr',
    });

    // Clear old synced lists data (keep original 57)
    await pool.query("DELETE FROM lists WHERE id > 57 AND type IN ('medical_problem','medication','allergy')");
    console.log('Cleared old synced clinical data');

    const patMap = await buildPatientMap(token);
    // Refresh token after patient map build
    token = await getToken();

    const configs = [
        {
            resourceType: 'Condition', listType: 'medical_problem', label: 'Conditions',
            titleFn: r => r.code?.text || r.code?.coding?.[0]?.display || 'Unknown condition',
            codeFn: r => 'ICD10:' + (r.code?.coding?.[0]?.code || ''),
            dateFn: r => r.onsetDateTime?.split('T')[0] || r.recordedDate?.split('T')[0] || '',
        },
        {
            resourceType: 'MedicationRequest', listType: 'medication', label: 'Medications',
            titleFn: r => {
                const name = r.medicationCodeableConcept?.text || r.medicationCodeableConcept?.coding?.[0]?.display || 'Unknown med';
                const dosage = r.dosageInstruction?.[0]?.text || '';
                return dosage ? `${name} - ${dosage}` : name;
            },
            codeFn: r => r.medicationCodeableConcept?.coding?.[0]?.code || '',
            dateFn: r => r.authoredOn?.split('T')[0] || '',
        },
        {
            resourceType: 'AllergyIntolerance', listType: 'allergy', label: 'Allergies',
            titleFn: r => r.code?.text || r.code?.coding?.[0]?.display || 'Unknown allergy',
            codeFn: r => r.code?.coding?.[0]?.code || '',
            dateFn: r => r.onsetDateTime?.split('T')[0] || r.recordedDate?.split('T')[0] || '',
        },
    ];

    let totalInserted = 0;
    for (const config of configs) {
        const count = await syncResourceType(token, pool, patMap, config);
        totalInserted += count;
        // Refresh token between resource types
        try { token = await getToken(); } catch {}
    }

    console.log(`\n=== SYNC COMPLETE: ${totalInserted} total clinical records inserted ===`);
    await pool.end();
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
