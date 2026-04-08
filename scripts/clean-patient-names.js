#!/usr/bin/env node
/**
 * Clean Synthea trailing numbers from FHIR Patient and Practitioner names.
 * "Abe604 Becker968" → "Abe Becker"
 */

const FHIR_BASE = process.env.FHIR_BASE || 'http://localhost:8103';

function clean(s) { return (s || '').replace(/\d+$/, '').trim(); }

async function getToken() {
  const cv = 'clean-names-' + Date.now();
  const login = await fetch(`${FHIR_BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@example.com', password: 'medplum_admin',
      scope: 'openid fhirUser', codeChallengeMethod: 'plain', codeChallenge: cv,
    }),
  });
  const { code } = await login.json();
  const tok = await fetch(`${FHIR_BASE}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=authorization_code&code=${code}&code_verifier=${cv}`,
  });
  return (await tok.json()).access_token;
}

async function fetchAll(resourceType, token) {
  let url = `${FHIR_BASE}/fhir/R4/${resourceType}?_count=200`;
  const resources = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const bundle = await res.json();
    for (const e of (bundle.entry || [])) if (e.resource) resources.push(e.resource);
    const next = (bundle.link || []).find(l => l.relation === 'next');
    url = next ? next.url : null;
  }
  return resources;
}

function cleanNames(resource) {
  let changed = false;
  if (!resource.name) return false;
  for (const n of resource.name) {
    if (n.family && n.family !== clean(n.family)) {
      n.family = clean(n.family);
      changed = true;
    }
    if (n.given) {
      const cleaned = n.given.map(g => clean(g));
      if (JSON.stringify(cleaned) !== JSON.stringify(n.given)) {
        n.given = cleaned;
        changed = true;
      }
    }
    if (n.prefix) n.prefix = n.prefix.map(s => clean(s));
    if (n.suffix) n.suffix = n.suffix.map(s => clean(s));
  }
  return changed;
}

async function cleanResourceType(resourceType, token) {
  console.log(`--- ${resourceType} ---`);
  const resources = await fetchAll(resourceType, token);
  console.log(`Found ${resources.length} ${resourceType} resources\n`);
  let updated = 0;

  for (const r of resources) {
    if (!cleanNames(r)) continue;

    const display = r.name[0];
    const after = `${(display.given || []).join(' ')} ${display.family || ''}`.trim();

    const res = await fetch(`${FHIR_BASE}/fhir/R4/${resourceType}/${r.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/fhir+json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(r),
    });

    if (res.ok) {
      updated++;
      if (updated % 50 === 0) process.stdout.write(`  ${updated} updated...\r`);
    } else {
      const err = await res.json().catch(() => ({}));
      console.log(`  ❌ ${r.id}: ${err.issue?.[0]?.details?.text || res.status}`);
    }
  }

  console.log(`  ✅ Updated ${updated}/${resources.length} ${resourceType} resources\n`);
  return { total: resources.length, updated };
}

async function main() {
  console.log('=== Cleaning Synthea names (Patient + Practitioner) ===\n');
  console.log(`FHIR: ${FHIR_BASE}\n`);
  const token = await getToken();

  const patients = await cleanResourceType('Patient', token);
  const practitioners = await cleanResourceType('Practitioner', token);

  console.log('=== Done ===');
  console.log(`  Patients:      ${patients.updated}/${patients.total}`);
  console.log(`  Practitioners: ${practitioners.updated}/${practitioners.total}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
