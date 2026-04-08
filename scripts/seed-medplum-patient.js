#!/usr/bin/env node
/**
 * Med-SEAL FHIR Seed Script
 *
 * Seeds the Medplum FHIR server with realistic patient data for the
 * Med-SEAL patient portal demo.
 *
 * Usage: node scripts/seed-medplum-patient.js
 */

const FHIR_BASE = process.env.FHIR_BASE || 'http://localhost:8103';
const EMAIL = process.env.MEDPLUM_EMAIL || 'admin@example.com';
const PASSWORD = process.env.MEDPLUM_PASSWORD || 'medplum_admin';

async function getToken() {
  const cv = 'medseal-seed-' + Date.now();
  // Step 1: Login with PKCE
  const loginRes = await fetch(`${FHIR_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: EMAIL, password: PASSWORD,
      scope: 'openid fhirUser',
      codeChallengeMethod: 'plain',
      codeChallenge: cv,
    }),
  });
  const loginData = await loginRes.json();
  if (!loginRes.ok) throw new Error(`Login failed: ${JSON.stringify(loginData)}`);

  // Step 2: Exchange code for token with code_verifier
  const { code } = loginData;
  if (!code) throw new Error(`No code in login response: ${JSON.stringify(loginData)}`);

  const tokenRes = await fetch(`${FHIR_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=authorization_code&code=${code}&code_verifier=${cv}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
  return tokenData.access_token;
}

async function fhirPost(token, resourceType, resource) {
  const res = await fetch(`${FHIR_BASE}/fhir/R4/${resourceType}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/fhir+json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(resource),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`  ❌ Failed to create ${resourceType}:`, JSON.stringify(data, null, 2));
    return null;
  }
  console.log(`  ✅ Created ${resourceType}/${data.id}`);
  return data;
}

async function fhirSearch(token, resourceType, params = '') {
  const res = await fetch(`${FHIR_BASE}/fhir/R4/${resourceType}?${params}`, {
    headers: {
      'Content-Type': 'application/fhir+json',
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!res.ok) return [];
  const bundle = await res.json();
  return (bundle.entry || []).map(e => e.resource);
}

async function main() {
  console.log('🏥 Med-SEAL FHIR Seed Script');
  console.log(`   Server: ${FHIR_BASE}`);
  console.log(`   Email:  ${EMAIL}\n`);

  // Get access token
  let token;
  try {
    token = await getToken();
    console.log('🔑 Authenticated successfully\n');
  } catch (e) {
    console.error('❌ Authentication failed:', e.message);
    console.log('\nTrying with client credentials...');

    // Try using the Medplum super admin client
    try {
      const clientRes = await fetch(`${FHIR_BASE}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials&client_id=2a5a78e1-197f-4c5e-b396-4659495d1b0c&client_secret=super_admin_secret',
      });
      if (clientRes.ok) {
        const clientData = await clientRes.json();
        token = clientData.access_token;
        console.log('🔑 Authenticated via client credentials\n');
      }
    } catch {}

    if (!token) {
      console.error('❌ All authentication methods failed. Please check credentials.');
      process.exit(1);
    }
  }

  // Check if patient already exists
  const existingPatients = await fhirSearch(token, 'Patient', '_count=10');
  if (existingPatients.length > 0) {
    console.log(`ℹ️  Found ${existingPatients.length} existing patient(s):`);
    existingPatients.forEach(p => {
      const n = p.name?.[0];
      console.log(`   - ${n?.given?.join(' ')} ${n?.family} (${p.id})`);
    });

    // Check for existing data for the first patient
    const pid = existingPatients[0].id;
    const meds = await fhirSearch(token, 'MedicationRequest', `patient=Patient/${pid}&_count=5`);
    const obs = await fhirSearch(token, 'Observation', `patient=Patient/${pid}&_count=5`);
    const appts = await fhirSearch(token, 'Appointment', `actor=Patient/${pid}&_count=5`);

    console.log(`\n📊 Data for Patient/${pid}:`);
    console.log(`   Medications: ${meds.length}`);
    console.log(`   Observations: ${obs.length}`);
    console.log(`   Appointments: ${appts.length}`);

    if (meds.length > 0 && obs.length > 0) {
      console.log('\n✅ Patient data already exists. Skipping seed.');
      return;
    }
    console.log('\n📝 Seeding additional data for existing patient...');
    await seedPatientData(token, pid);
    return;
  }

  // Create patient
  console.log('📝 Creating patient...');
  const patient = await fhirPost(token, 'Patient', {
    resourceType: 'Patient',
    active: true,
    name: [{ use: 'official', family: 'Hassan', given: ['Amir'] }],
    gender: 'male',
    birthDate: '1974-05-12',
    telecom: [
      { system: 'phone', value: '+65-9123-4567', use: 'mobile' },
      { system: 'email', value: 'amir.hassan@email.com' },
    ],
    address: [{
      use: 'home',
      line: ['Blk 123 Tampines Ave 4, #08-456'],
      city: 'Singapore',
      postalCode: '520123',
      country: 'SG',
    }],
    communication: [{ language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'en' }] }, preferred: true }],
    maritalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus', code: 'M', display: 'Married' }] },
  });

  if (!patient) {
    console.error('❌ Failed to create patient. Exiting.');
    process.exit(1);
  }

  await seedPatientData(token, patient.id);
}

async function seedPatientData(token, patientId) {
  const patientRef = `Patient/${patientId}`;

  // ── Conditions ──────────────────────────────────────────────────
  console.log('\n📝 Creating conditions...');
  const conditions = [
    { code: '44054006', display: 'Type 2 Diabetes Mellitus', system: 'http://snomed.info/sct' },
    { code: '59621000', display: 'Essential Hypertension', system: 'http://snomed.info/sct' },
    { code: '55822004', display: 'Hyperlipidemia', system: 'http://snomed.info/sct' },
  ];
  for (const cond of conditions) {
    await fhirPost(token, 'Condition', {
      resourceType: 'Condition',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
      code: { coding: [{ system: cond.system, code: cond.code, display: cond.display }], text: cond.display },
      subject: { reference: patientRef },
      onsetDateTime: '2024-06-01',
    });
  }

  // ── Allergies ──────────────────────────────────────────────────
  console.log('\n📝 Creating allergies...');
  const allergies = [
    { code: '764146007', display: 'Penicillin' },
    { code: '735029006', display: 'Shellfish' },
  ];
  for (const allergy of allergies) {
    await fhirPost(token, 'AllergyIntolerance', {
      resourceType: 'AllergyIntolerance',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] },
      type: 'allergy',
      code: { coding: [{ system: 'http://snomed.info/sct', code: allergy.code, display: allergy.display }], text: allergy.display },
      patient: { reference: patientRef },
    });
  }

  // ── Medications (MedicationRequest) ────────────────────────────
  console.log('\n📝 Creating medication requests...');
  const meds = [
    {
      name: 'Metformin 500mg',
      code: '860975',
      system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
      dosage: 'Take 500mg twice daily with meals',
      reason: 'Type 2 Diabetes Mellitus',
      prescriber: 'Dr. Sarah Chen',
    },
    {
      name: 'Lisinopril 10mg',
      code: '314076',
      system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
      dosage: 'Take 10mg once daily in the morning',
      reason: 'Essential Hypertension',
      prescriber: 'Dr. Michael Tan',
    },
    {
      name: 'Atorvastatin 20mg',
      code: '259255',
      system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
      dosage: 'Take 20mg once daily at bedtime',
      reason: 'Hyperlipidemia',
      prescriber: 'Dr. Michael Tan',
    },
    {
      name: 'Vitamin D3 1000IU',
      code: '316965',
      system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
      dosage: 'Take 1000IU once daily in the morning with food',
      reason: 'Vitamin D supplementation',
      prescriber: 'Dr. Sarah Chen',
    },
  ];

  for (const med of meds) {
    await fhirPost(token, 'MedicationRequest', {
      resourceType: 'MedicationRequest',
      status: 'active',
      intent: 'order',
      medicationCodeableConcept: {
        coding: [{ system: med.system, code: med.code, display: med.name }],
        text: med.name,
      },
      subject: { reference: patientRef },
      authoredOn: '2025-06-15',
      requester: { display: med.prescriber },
      reasonCode: [{ text: med.reason }],
      dosageInstruction: [{
        text: med.dosage,
        patientInstruction: med.dosage,
      }],
      dispenseRequest: {
        numberOfRepeatsAllowed: 3,
        quantity: { value: 30, unit: 'tablets' },
        validityPeriod: { start: '2025-06-15', end: '2026-06-15' },
      },
    });
  }

  // ── Observations (Vitals) ──────────────────────────────────────
  console.log('\n📝 Creating vital sign observations...');
  const today = new Date();
  for (let d = 6; d >= 0; d--) {
    const date = new Date(today);
    date.setDate(date.getDate() - d);
    const dateStr = date.toISOString().split('T')[0];

    // Blood Pressure
    const systolic = 125 + Math.round(Math.random() * 15);
    const diastolic = 78 + Math.round(Math.random() * 10);
    await fhirPost(token, 'Observation', {
      resourceType: 'Observation',
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel' }] },
      subject: { reference: patientRef },
      effectiveDateTime: `${dateStr}T08:00:00Z`,
      component: [
        {
          code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] },
          valueQuantity: { value: systolic, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' },
        },
        {
          code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic blood pressure' }] },
          valueQuantity: { value: diastolic, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' },
        },
      ],
    });

    // Heart rate
    await fhirPost(token, 'Observation', {
      resourceType: 'Observation',
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] },
      subject: { reference: patientRef },
      effectiveDateTime: `${dateStr}T08:00:00Z`,
      valueQuantity: { value: 68 + Math.round(Math.random() * 10), unit: '/min', system: 'http://unitsofmeasure.org', code: '/min' },
    });

    // Blood glucose
    await fhirPost(token, 'Observation', {
      resourceType: 'Observation',
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: '2339-0', display: 'Glucose [Mass/volume] in Blood' }] },
      subject: { reference: patientRef },
      effectiveDateTime: `${dateStr}T07:30:00Z`,
      valueQuantity: { value: parseFloat((5.5 + Math.random() * 2).toFixed(1)), unit: 'mmol/L', system: 'http://unitsofmeasure.org', code: 'mmol/L' },
    });
  }

  // Lab results
  console.log('\n📝 Creating lab results...');
  const labs = [
    { code: '4548-4', display: 'HbA1c', value: 6.8, unit: '%', category: 'laboratory', interp: 'H' },
    { code: '2345-7', display: 'Glucose [Fasting]', value: 6.2, unit: 'mmol/L', category: 'laboratory', interp: 'N' },
    { code: '2093-3', display: 'Total Cholesterol', value: 4.8, unit: 'mmol/L', category: 'laboratory', interp: 'N' },
    { code: '13457-7', display: 'LDL Cholesterol', value: 3.2, unit: 'mmol/L', category: 'laboratory', interp: 'H' },
    { code: '2160-0', display: 'Creatinine', value: 88, unit: 'µmol/L', category: 'laboratory', interp: 'N' },
  ];
  for (const lab of labs) {
    await fhirPost(token, 'Observation', {
      resourceType: 'Observation',
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: lab.category }] }],
      code: { coding: [{ system: 'http://loinc.org', code: lab.code, display: lab.display }] },
      subject: { reference: patientRef },
      effectiveDateTime: '2026-03-08T10:00:00Z',
      valueQuantity: { value: lab.value, unit: lab.unit },
      interpretation: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: lab.interp }] }],
    });
  }

  // ── Appointments ──────────────────────────────────────────────
  console.log('\n📝 Creating appointments...');
  const appts = [
    { doctor: 'Dr. Sarah Chen', specialty: 'Endocrinology', date: '2026-03-20T09:30:00Z', desc: 'HbA1c review, medication adjustment', type: 'Follow-up' },
    { doctor: 'Dr. Michael Tan', specialty: 'Cardiology', date: '2026-03-25T14:00:00Z', desc: 'Annual cardiac screening', type: 'Consultation' },
    { doctor: 'Dr. Aisha Rahman', specialty: 'General Practice', date: '2026-04-02T10:15:00Z', desc: 'Routine health screening', type: 'Check-up' },
  ];
  for (const appt of appts) {
    await fhirPost(token, 'Appointment', {
      resourceType: 'Appointment',
      status: 'booked',
      description: appt.desc,
      start: appt.date,
      end: new Date(new Date(appt.date).getTime() + 30 * 60000).toISOString(),
      appointmentType: { coding: [{ display: appt.type }] },
      serviceType: [{ coding: [{ display: appt.specialty }] }],
      participant: [
        { actor: { reference: patientRef, display: 'Amir Hassan' }, status: 'accepted' },
        { actor: { display: appt.doctor }, status: 'accepted' },
      ],
    });
  }

  console.log('\n🎉 Seed complete! Patient data is ready.');
  console.log(`   Patient ID: ${patientId}`);
  console.log(`   Login: admin@example.com / medplum_admin`);
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
