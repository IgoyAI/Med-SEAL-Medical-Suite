#!/usr/bin/env node
// ============================================================
// Med-SEAL Suite — Synthea FHIR Bundle Loader
// Loads Synthea-generated FHIR R4 bundles into Medplum
// ============================================================

const fs = require('fs');
const path = require('path');

const MEDPLUM_BASE = process.env.MEDPLUM_BASE_URL || 'http://localhost:8103';
const SYNTHEA_OUTPUT = process.env.SYNTHEA_OUTPUT_DIR || path.join(__dirname, 'output', 'fhir');
const CONCURRENCY = parseInt(process.env.LOADER_CONCURRENCY || '5');

// --- Auth ---
async function getAccessToken() {
    const codeVerifier = 'medseal-synthea-loader-' + Date.now();

    // Step 1: Login with PKCE
    const loginRes = await fetch(`${MEDPLUM_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: process.env.MEDPLUM_EMAIL || 'admin@example.com',
            password: process.env.MEDPLUM_PASSWORD || 'changeme',
            scope: 'openid fhirUser',
            codeChallengeMethod: 'plain',
            codeChallenge: codeVerifier,
        }),
    });
    if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
    const loginData = await loginRes.json();
    const code = loginData.code;
    if (!code) throw new Error('No auth code returned from login: ' + JSON.stringify(loginData));

    // Step 2: Exchange code for token with code_verifier
    const tokenRes = await fetch(`${MEDPLUM_BASE}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}&code_verifier=${codeVerifier}`,
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    const { access_token } = await tokenRes.json();
    if (!access_token) throw new Error('No access_token in token response');
    return access_token;
}

// --- Upload a single FHIR bundle ---
async function uploadBundle(filePath, token, index, total) {
    const baseName = path.basename(filePath);
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const bundle = JSON.parse(raw);

        // Synthea generates "transaction" bundles, POST directly to FHIR base
        const res = await fetch(`${MEDPLUM_BASE}/fhir/R4`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/fhir+json',
                'Authorization': `Bearer ${token}`,
            },
            body: raw,
        });

        if (res.ok) {
            const result = await res.json();
            const created = result.entry?.length || 0;
            process.stdout.write(`\r[${index}/${total}] ✅ ${baseName} — ${created} resources`);
            return { file: baseName, status: 'ok', resources: created };
        } else {
            const errText = await res.text();
            process.stdout.write(`\r[${index}/${total}] ❌ ${baseName} — HTTP ${res.status}`);
            return { file: baseName, status: 'error', code: res.status, error: errText.slice(0, 200) };
        }
    } catch (err) {
        process.stdout.write(`\r[${index}/${total}] ❌ ${baseName} — ${err.message}`);
        return { file: baseName, status: 'error', error: err.message };
    }
}

// --- Main ---
async function main() {
    console.log('=== Med-SEAL Synthea FHIR Loader ===');
    console.log(`Medplum:    ${MEDPLUM_BASE}`);
    console.log(`Synthea:    ${SYNTHEA_OUTPUT}`);
    console.log(`Concurrency: ${CONCURRENCY}\n`);

    // Check output directory
    if (!fs.existsSync(SYNTHEA_OUTPUT)) {
        console.error(`❌ Synthea output directory not found: ${SYNTHEA_OUTPUT}`);
        console.error('   Run Synthea first: ./run_synthea -p 1000');
        process.exit(1);
    }

    // Get all FHIR JSON files
    const files = fs.readdirSync(SYNTHEA_OUTPUT)
        .filter(f => f.endsWith('.json'))
        .map(f => path.join(SYNTHEA_OUTPUT, f));

    console.log(`Found ${files.length} FHIR bundle files`);

    // Separate hospital/practitioner bundles (load first) from patient bundles
    const hospitalFiles = files.filter(f => path.basename(f).startsWith('hospital'));
    const practitionerFiles = files.filter(f => path.basename(f).startsWith('practitioner'));
    const patientFiles = files.filter(f =>
        !path.basename(f).startsWith('hospital') &&
        !path.basename(f).startsWith('practitioner')
    );

    console.log(`  → ${hospitalFiles.length} hospital bundles`);
    console.log(`  → ${practitionerFiles.length} practitioner bundles`);
    console.log(`  → ${patientFiles.length} patient bundles\n`);

    // Authenticate
    console.log('Authenticating with Medplum...');
    const token = await getAccessToken();
    console.log('✅ Authenticated\n');

    const errors = [];
    let totalResources = 0;
    let processed = 0;
    const totalFiles = files.length;

    // Load hospital + practitioner bundles first (sequentially)
    console.log('--- Loading hospital & practitioner data ---');
    for (const file of [...hospitalFiles, ...practitionerFiles]) {
        processed++;
        const result = await uploadBundle(file, token, processed, totalFiles);
        if (result.status === 'ok') totalResources += result.resources;
        else errors.push(result);
    }
    console.log('\n');

    // Load patient bundles with concurrency
    console.log('--- Loading patient data ---');
    for (let i = 0; i < patientFiles.length; i += CONCURRENCY) {
        const batch = patientFiles.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
            batch.map((file, j) => {
                processed++;
                return uploadBundle(file, token, processed, totalFiles);
            })
        );
        for (const r of results) {
            if (r.status === 'ok') totalResources += r.resources;
            else errors.push(r);
        }
    }

    // Summary
    console.log('\n\n=== Load Complete ===');
    console.log(`Total files:     ${totalFiles}`);
    console.log(`Successful:      ${totalFiles - errors.length}`);
    console.log(`Failed:          ${errors.length}`);
    console.log(`Total resources: ${totalResources}`);

    if (errors.length > 0) {
        console.log('\n--- Errors ---');
        for (const e of errors.slice(0, 10)) {
            console.log(`  ${e.file}: ${e.error?.slice(0, 100)}`);
        }
        if (errors.length > 10) console.log(`  ... and ${errors.length - 10} more`);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
