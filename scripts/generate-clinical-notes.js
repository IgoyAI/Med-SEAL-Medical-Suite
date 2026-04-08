#!/usr/bin/env node
/**
 * Generate realistic SOAP notes and vitals for all encounters in OpenEMR.
 * Links them through the `forms` table so they appear within each encounter.
 */
const { execSync } = require('child_process');
const fs = require('fs');

function esc(s) { return s ? String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") : ''; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randF(min, max, dec = 1) { return (Math.random() * (max - min) + min).toFixed(dec); }

// Realistic clinical note templates by encounter reason
const noteTemplates = {
    'check up': {
        subjective: [
            'Patient presents for routine health checkup. Denies any acute complaints. Reports feeling generally well. No weight changes, fevers, or night sweats.',
            'Routine wellness visit. Patient denies chest pain, shortness of breath, or palpitations. Sleep and appetite normal. No new medications.',
            'Annual health screening visit. Patient reports good overall health. Denies fatigue, headaches, or changes in vision. Exercise 3x/week.',
        ],
        objective: [
            'General: Alert, oriented, well-nourished, no acute distress.\nHEENT: Normocephalic, PERRLA, oropharynx clear.\nLungs: Clear to auscultation bilaterally.\nCV: RRR, no murmurs/gallops/rubs.\nAbdomen: Soft, non-tender, non-distended, normoactive BS.',
            'General: Well-appearing, NAD.\nHEENT: No lymphadenopathy, TMs clear bilaterally.\nLungs: Unlabored respirations, CTA B/L.\nHeart: S1/S2 normal, regular rate.\nAbdomen: Soft, NT/ND.\nExtremities: No edema, pulses 2+ throughout.',
        ],
        assessment: [
            'Routine health maintenance. All screening labs within normal limits. Up to date on age-appropriate vaccinations.',
            'Annual wellness examination. No acute concerns identified. Continue current health maintenance plan.',
            'Preventive health visit. Risk factors reviewed. Patient encouraged to continue healthy lifestyle.',
        ],
        plan: [
            '1. Continue current medications\n2. Routine labs ordered: CBC, BMP, Lipid panel\n3. Flu vaccine administered\n4. Return in 12 months for annual exam',
            '1. Health screening labs ordered\n2. Reviewed diet and exercise recommendations\n3. Cancer screening up to date\n4. Follow up in 1 year or sooner if concerns arise',
        ],
    },
    'symptom': {
        subjective: [
            'Patient presents with chief complaint of {symptoms}. Onset approximately {days} days ago. Describes symptoms as intermittent, worsening over the past 24 hours. No alleviating factors identified. Denies associated fever or chills.',
            'Patient reports {symptoms} for the past {days} days. Tried OTC medications with minimal relief. No recent travel or sick contacts. Denies shortness of breath.',
            'CC: {symptoms}. Patient states symptoms began gradually {days} days ago. Reports mild discomfort affecting daily activities. No prior episodes. No known allergies.',
        ],
        objective: [
            'General: Mildly uncomfortable but no acute distress.\nHEENT: Mucous membranes moist.\nLungs: Clear, no wheezes or crackles.\nCV: Regular rate and rhythm.\nAbdomen: Soft, mild tenderness on palpation, no rebound/guarding.\nNeuro: Alert, oriented x4.',
            'VS: See vitals.\nGeneral: Appears fatigued but alert.\nLungs: Clear bilaterally.\nHeart: RRR, no murmurs.\nAbdomen: NTND, +BS.\nSkin: No rashes or lesions.',
        ],
        assessment: [
            'Acute {condition}. Symptoms consistent with clinical presentation. No red flags identified.',
            '{condition} — likely self-limiting. Will monitor for progression. Differential includes viral etiology vs early bacterial process.',
        ],
        plan: [
            '1. Symptomatic treatment: acetaminophen PRN for pain/fever\n2. Increase fluid intake, rest as needed\n3. Return if symptoms worsen or persist >7 days\n4. Discussed warning signs requiring ER visit',
            '1. Prescribed {medication}\n2. Activity modification as tolerated\n3. Follow up in 5-7 days\n4. Labs ordered if no improvement',
        ],
    },
    'well child': {
        subjective: [
            'Well child visit. Parents report child is developing appropriately. Meeting developmental milestones. No concerns about feeding, sleep, or behavior. Up to date on vaccinations.',
            'Routine pediatric visit. Child is active and playful per parent report. Eating well, sleeping through the night. No recent illnesses or injuries.',
        ],
        objective: [
            'General: Active, alert, well-nourished child in NAD.\nGrowth: Weight and height tracking along expected percentile.\nHEENT: Normocephalic, fontanelles flat (if applicable), ears clear, throat clear.\nLungs: Clear.\nHeart: RRR.\nAbdomen: Soft, non-tender.\nNeuro: Age-appropriate developmental milestones met.',
        ],
        assessment: ['Healthy child. Growth and development appropriate for age. Up to date on immunization schedule.'],
        plan: ['1. Age-appropriate vaccines administered today\n2. Reviewed safety: car seat, water safety, helmet use\n3. Diet counseling provided\n4. Next well child visit in 12 months'],
    },
    'examination': {
        subjective: [
            'Patient presents for comprehensive physical examination. Reviews systems: Denies headache, vision changes, chest pain, dyspnea, abdominal pain, urinary symptoms, joint pain or rashes.',
            'General examination requested. Patient reports overall stable health. No new symptoms since last visit. Medications unchanged.',
        ],
        objective: [
            'General: Well-developed, well-nourished adult in NAD.\nHEENT: PERRLA, EOM intact, TMs clear, oropharynx without erythema.\nNeck: Supple, no thyromegaly, no lymphadenopathy.\nLungs: CTAB, no wheezes/rhonchi.\nCV: RRR, PMI non-displaced, no murmurs.\nAbdomen: Soft, NT/ND, no HSM, +BS.\nExtremities: No cyanosis, clubbing, or edema.\nNeuro: CN II-XII intact, DTRs 2+ symmetric.\nSkin: No suspicious lesions.',
        ],
        assessment: ['Comprehensive examination within normal limits. Chronic conditions stable on current management.'],
        plan: ['1. Continue current medications\n2. Labs: CBC, CMP, TSH, Lipid panel, HbA1c\n3. Age-appropriate cancer screening discussed\n4. Return in 6-12 months or sooner PRN'],
    },
    'vaccine': {
        subjective: ['Patient presents for scheduled immunization. No current illness. No adverse reactions to previous vaccinations. No contraindications identified.'],
        objective: ['General: NAD. Injection site inspected — no abnormalities. Patient monitored for 15 minutes post-administration. No signs of anaphylaxis or adverse reaction.'],
        assessment: ['Immunization administered without complication.'],
        plan: ['1. Vaccine administered per schedule\n2. Patient/guardian educated on common side effects (soreness, low-grade fever)\n3. Tylenol PRN for discomfort\n4. Next vaccination per schedule'],
    },
    'default': {
        subjective: [
            'Patient presents for evaluation. Reports {symptoms}. Duration: {days} days. Has been managing with rest and OTC medications. No significant PMH changes.',
            'Follow-up visit. Patient reports current symptoms are {improvement}. Medication compliance noted. No new concerns.',
        ],
        objective: [
            'VS: See vitals.\nGeneral: Alert, oriented, cooperative.\nRelevant exam findings within normal limits for chief complaint.\nNo acute findings requiring immediate intervention.',
        ],
        assessment: ['Clinical findings consistent with diagnosis. Patient condition is stable/improving.'],
        plan: ['1. Continue current management\n2. Medication adjustments as needed\n3. Return for follow-up as scheduled\n4. Patient education provided'],
    },
};

const symptoms = ['fatigue and malaise', 'headache and dizziness', 'cough and congestion', 'abdominal discomfort',
    'joint pain and stiffness', 'back pain', 'sore throat', 'nausea', 'chest tightness', 'shortness of breath on exertion'];
const conditions = ['upper respiratory infection', 'acute gastroenteritis', 'tension headache', 'musculoskeletal strain',
    'viral syndrome', 'seasonal allergies', 'mild anxiety', 'insomnia', 'GERD', 'urinary tract symptoms'];
const medications = ['ibuprofen 400mg PO TID x 7 days', 'amoxicillin 500mg PO TID x 10 days',
    'omeprazole 20mg PO daily x 14 days', 'cetirizine 10mg PO daily PRN', 'acetaminophen 500mg PO Q6H PRN'];
const improvements = ['gradually improving', 'stable, no change', 'slightly worse but manageable', 'much better since last visit', 'intermittent, comes and goes'];

function pickRandom(arr) { return arr[rand(0, arr.length - 1)]; }

function getTemplate(reason) {
    const r = reason.toLowerCase();
    if (r.includes('check up') || r.includes('checkup')) return noteTemplates['check up'];
    if (r.includes('symptom')) return noteTemplates['symptom'];
    if (r.includes('well child')) return noteTemplates['well child'];
    if (r.includes('examination') || r.includes('general exam')) return noteTemplates['examination'];
    if (r.includes('vaccine') || r.includes('immunization')) return noteTemplates['vaccine'];
    return noteTemplates['default'];
}

function fillTemplate(text) {
    return text
        .replace(/{symptoms}/g, pickRandom(symptoms))
        .replace(/{days}/g, rand(1, 14))
        .replace(/{condition}/g, pickRandom(conditions))
        .replace(/{medication}/g, pickRandom(medications))
        .replace(/{improvement}/g, pickRandom(improvements));
}

async function main() {
    console.log('=== Generating SOAP Notes + Vitals for All Encounters ===\n');

    // Get all encounters
    const encData = execSync(
        `docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -N -e "SELECT id, pid, encounter, date, reason FROM form_encounter ORDER BY id"`,
        { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 }
    ).toString().trim();

    const encounters = encData.split('\n').map(line => {
        const [id, pid, encounter, date, ...reasonParts] = line.split('\t');
        return { id: +id, pid: +pid, encounter: +encounter, date, reason: reasonParts.join('\t') };
    });

    console.log(`Found ${encounters.length} encounters\n`);

    const soapLines = [];
    const vitalsLines = [];
    const formLines = [];

    for (let i = 0; i < encounters.length; i++) {
        const enc = encounters[i];
        const tmpl = getTemplate(enc.reason);

        // SOAP note
        const subj = esc(fillTemplate(pickRandom(tmpl.subjective)));
        const obj = esc(fillTemplate(pickRandom(tmpl.objective)));
        const assess = esc(fillTemplate(pickRandom(tmpl.assessment)));
        const plan = esc(fillTemplate(pickRandom(tmpl.plan)));

        soapLines.push(`INSERT INTO form_soap (date, pid, user, groupname, authorized, activity, subjective, objective, assessment, plan) VALUES ('${enc.date}', ${enc.pid}, 'admin', 'Default', 1, 1, '${subj}', '${obj}', '${assess}', '${plan}');`);

        // Register SOAP in forms table
        formLines.push(`INSERT INTO forms (date, encounter, form_name, form_id, pid, user, groupname, authorized, deleted, formdir) VALUES ('${enc.date}', ${enc.encounter}, 'SOAP', LAST_INSERT_ID(), ${enc.pid}, 'admin', 'Default', 1, 0, 'soap');`);

        // Vitals
        const age = enc.pid; // just for seeding variation
        const systolic = rand(110, 140);
        const diastolic = rand(60, 90);
        const weight = randF(50, 100, 1);
        const height = randF(150, 190, 1);
        const temp = randF(36.4, 37.2, 1);
        const pulse = rand(60, 100);
        const resp = rand(12, 20);
        const o2 = randF(95, 100, 0);
        const bmi = (parseFloat(weight) / Math.pow(parseFloat(height) / 100, 2)).toFixed(1);

        vitalsLines.push(`INSERT INTO form_vitals (date, pid, user, groupname, authorized, activity, bps, bpd, weight, height, temperature, temp_method, pulse, respiration, oxygen_saturation, BMI, note) VALUES ('${enc.date}', ${enc.pid}, 'admin', 'Default', 1, 1, '${systolic}', '${diastolic}', ${weight}, ${height}, ${temp}, 'Oral', ${pulse}, ${resp}, ${o2}, ${bmi}, '');`);

        // Register Vitals in forms table
        formLines.push(`INSERT INTO forms (date, encounter, form_name, form_id, pid, user, groupname, authorized, deleted, formdir) VALUES ('${enc.date}', ${enc.encounter}, 'Vitals', LAST_INSERT_ID(), ${enc.pid}, 'admin', 'Default', 1, 0, 'vitals');`);

        if ((i + 1) % 1000 === 0) console.log(`  Generated ${i + 1}/${encounters.length}`);
    }

    console.log(`\nGenerated ${soapLines.length} SOAP notes + ${vitalsLines.length} vitals`);

    // Write SQL files
    // Interleave soap/form pairs so LAST_INSERT_ID() works
    const allLines = [];
    for (let i = 0; i < soapLines.length; i++) {
        allLines.push(soapLines[i]);
        allLines.push(formLines[i * 2]); // SOAP form registration
        allLines.push(vitalsLines[i]);
        allLines.push(formLines[i * 2 + 1]); // Vitals form registration
    }

    const sqlFile = '/tmp/clinical_notes.sql';
    fs.writeFileSync(sqlFile, allLines.join('\n'));
    console.log(`📄 SQL file: ${sqlFile} (${allLines.length} statements, ${(fs.statSync(sqlFile).size / 1024 / 1024).toFixed(1)} MB)`);

    // Copy and execute
    console.log('Copying to container...');
    execSync(`docker cp ${sqlFile} medseal-openemr-db:/tmp/clinical_notes.sql`, { stdio: 'pipe' });

    console.log('Executing batch (this takes a minute)...');
    try {
        execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -e "source /tmp/clinical_notes.sql"`, {
            stdio: 'pipe', timeout: 300000, maxBuffer: 10 * 1024 * 1024
        });
        console.log('✅ Batch executed!');
    } catch (e) {
        console.error('Error:', e.stderr?.toString().substring(0, 500) || e.message);
    }

    // Verify
    const soap = execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -N -e "SELECT COUNT(*) FROM form_soap"`, { stdio: 'pipe' }).toString().trim();
    const vitals = execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -N -e "SELECT COUNT(*) FROM form_vitals"`, { stdio: 'pipe' }).toString().trim();
    const forms = execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -N -e "SELECT formdir, COUNT(*) FROM forms GROUP BY formdir"`, { stdio: 'pipe' }).toString().trim();

    console.log(`\n=== VERIFIED ===`);
    console.log(`SOAP notes: ${soap}`);
    console.log(`Vitals:     ${vitals}`);
    console.log(`Forms by type:\n${forms}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
