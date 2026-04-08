#!/usr/bin/env node
/**
 * Med-SEAL Radiology Integration v2
 * Uses Orthanc's study modification API to create studies for different patients
 * Then creates matching procedure orders + reports in OpenEMR
 */
const { execSync } = require('child_process');
const fs = require('fs');

const ORTHANC = 'http://localhost:8042';
const AUTH = 'Basic ' + Buffer.from('orthanc:orthanc').toString('base64');

function esc(s) { return s ? String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") : ''; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

const radStudies = [
    {
        code: 'CXR', modality: 'CR', name: 'Chest X-Ray', bodyPart: 'CHEST', desc: 'PA and Lateral Chest',
        findings: ['Heart size normal. Lungs clear bilaterally. No pleural effusion or pneumothorax. Mediastinum unremarkable. IMPRESSION: Normal chest radiograph.', 'Mild cardiomegaly. Bilateral basal atelectasis. No focal consolidation or effusion. IMPRESSION: Mild cardiomegaly with bibasilar atelectasis.', 'Clear lungs. Normal heart size and mediastinal contour. No acute cardiopulmonary findings.', 'Small left pleural effusion. Mild cardiomegaly. Right lung clear. IMPRESSION: Small left pleural effusion.']
    },
    {
        code: 'CT-HEAD', modality: 'CT', name: 'CT Head', bodyPart: 'HEAD', desc: 'Axial CT brain without contrast',
        findings: ['No acute intracranial hemorrhage. No mass effect or midline shift. Ventricles symmetric. Gray-white differentiation preserved. IMPRESSION: Normal CT brain.', 'No acute intracranial pathology. Mild age-related cerebral atrophy. IMPRESSION: No acute findings.', 'Mild periventricular white matter hypodensities consistent with chronic small vessel disease. No hemorrhage or mass. IMPRESSION: Chronic small vessel ischemic changes.']
    },
    {
        code: 'CT-AP', modality: 'CT', name: 'CT Abdomen/Pelvis', bodyPart: 'ABDOMEN', desc: 'CT abdomen/pelvis with IV contrast',
        findings: ['Liver, spleen, pancreas normal. Kidneys enhance symmetrically. No lymphadenopathy. IMPRESSION: Normal CT abdomen/pelvis.', 'Small hepatic cyst segment VII (1.2cm). Otherwise unremarkable. IMPRESSION: Simple hepatic cyst.', 'Mild hepatic steatosis. No masses or free fluid. IMPRESSION: Mild fatty liver.']
    },
    {
        code: 'US-ABD', modality: 'US', name: 'Ultrasound Abdomen', bodyPart: 'ABDOMEN', desc: 'Complete abdominal ultrasound',
        findings: ['Liver normal. Gallbladder: No stones. CBD 4mm. Kidneys normal bilaterally. Spleen normal. IMPRESSION: Normal abdominal ultrasound.', 'Mildly echogenic liver (steatosis). Single 8mm gallstone. CBD normal. IMPRESSION: Cholelithiasis. Mild hepatic steatosis.']
    },
    {
        code: 'MRI-BRAIN', modality: 'MR', name: 'MRI Brain', bodyPart: 'HEAD', desc: 'MRI brain with/without gadolinium',
        findings: ['No acute infarct on DWI. No hemorrhage. No enhancing lesion. Ventricles normal. IMPRESSION: Normal MRI brain.', 'Scattered T2/FLAIR hyperintense foci in periventricular white matter — chronic microvascular ischemic changes. No acute process. IMPRESSION: Chronic small vessel disease.']
    },
    {
        code: 'MRI-LS', modality: 'MR', name: 'MRI Lumbar Spine', bodyPart: 'LSPINE', desc: 'MRI lumbar spine without contrast',
        findings: ['L4-L5: Mild disc bulge with facet hypertrophy. Mild bilateral foraminal narrowing. L5-S1: Small posterior disc protrusion contacting left S1 nerve root. IMPRESSION: L4-L5 degenerative changes. L5-S1 disc protrusion.', 'L4-L5: Moderate disc protrusion with mild central stenosis. L5-S1: Normal. IMPRESSION: L4-L5 disc protrusion with mild stenosis.']
    },
    {
        code: 'ECHO', modality: 'US', name: 'Echocardiogram', bodyPart: 'HEART', desc: 'Transthoracic echo',
        findings: ['LV size/function normal. EF 60-65%. No wall motion abnormalities. Valves normal. No pericardial effusion. IMPRESSION: Normal echocardiogram.', 'Mild concentric LVH. EF 55-60%. Trace MR, mild TR. RVSP 30mmHg. IMPRESSION: Mild LVH, preserved systolic function.']
    },
    {
        code: 'MAMMO', modality: 'MG', name: 'Mammogram', bodyPart: 'BREAST', desc: 'Bilateral screening mammography',
        findings: ['Scattered fibroglandular density. No masses, distortion, or calcifications. BIRADS 1 Negative. IMPRESSION: Negative mammogram.', 'Heterogeneously dense tissue. No dominant mass. BIRADS 2 Benign. IMPRESSION: Benign findings.']
    },
];

const radiologists = ['Dr. Sarah Chen', 'Dr. James Liu', 'Dr. Priya Sharma', 'Dr. Michael Tan', 'Dr. Rachel Ng'];

async function main() {
    console.log('=== Radiology Integration v2 ===\n');

    // Get the parent study from the uploaded DICOM
    const patientsRes = await fetch(`${ORTHANC}/patients`, { headers: { Authorization: AUTH } });
    const patients = await patientsRes.json();

    if (patients.length === 0) {
        console.log('No DICOM in Orthanc. Uploading base DICOM...');
        const dcm = fs.readFileSync('/tmp/dicom_knee.dcm');
        await fetch(`${ORTHANC}/instances`, {
            method: 'POST', headers: { Authorization: AUTH, 'Content-Type': 'application/dicom' }, body: dcm
        });
    }

    const studiesRes = await fetch(`${ORTHANC}/studies`, { headers: { Authorization: AUTH } });
    const studies = await studiesRes.json();
    const parentStudy = studies[0];
    console.log(`Base study: ${parentStudy}\n`);

    // Get OpenEMR patients  
    const patientData = execSync(
        `docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -N -e "SELECT pid, fname, lname, DOB, sex FROM patient_data ORDER BY pid LIMIT 30"`,
        { stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString().trim().split('\n').map(l => {
        const [pid, fname, lname, dob, sex] = l.split('\t');
        return { pid: +pid, fname, lname, dob, sex };
    });

    // Create modified studies for each patient
    let created = 0;
    const studyLinks = [];

    for (let i = 0; i < patientData.length; i++) {
        const pat = patientData[i];
        const study = radStudies[i % radStudies.length];
        const studyDate = `2024${String(rand(1, 12)).padStart(2, '0')}${String(rand(1, 28)).padStart(2, '0')}`;
        const accession = `RAD${String(i + 1).padStart(6, '0')}`;

        try {
            const modRes = await fetch(`${ORTHANC}/studies/${parentStudy}/modify`, {
                method: 'POST',
                headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    Replace: {
                        PatientID: String(pat.pid),
                        PatientName: `${pat.lname}^${pat.fname}`,
                        PatientBirthDate: (pat.dob || '20000101').replace(/-/g, ''),
                        PatientSex: pat.sex === 'Male' ? 'M' : 'F',
                        StudyDate: studyDate,
                        Modality: study.modality,
                        BodyPartExamined: study.bodyPart,
                        StudyDescription: study.desc,
                        AccessionNumber: accession,
                        InstitutionName: 'Med-SEAL General Hospital',
                        SeriesDescription: study.name,
                    },
                    Force: true,
                    KeepSource: true,
                }),
            });

            if (modRes.ok) {
                const result = await modRes.json();
                created++;
                const dateFormatted = `${studyDate.substring(0, 4)}-${studyDate.substring(4, 6)}-${studyDate.substring(6, 8)}`;
                studyLinks.push({
                    pid: pat.pid, accession, study, dateFormatted, orthanc_id: result.ID || result.Path,
                    radiologist: radiologists[i % radiologists.length],
                    finding: study.findings[i % study.findings.length],
                });
                console.log(`  ✅ ${pat.fname} ${pat.lname} — ${study.name} (${accession})`);
            } else {
                const err = await res.text();
                console.log(`  ❌ ${pat.fname}: ${err.substring(0, 80)}`);
            }
        } catch (e) {
            console.log(`  ❌ ${pat.fname}: ${e.message}`);
        }
    }

    console.log(`\n✅ ${created} studies created in Orthanc\n`);

    // Create procedure orders + reports in OpenEMR
    console.log('📋 Creating procedure orders + reports in OpenEMR...');
    const sqlLines = [];

    for (const s of studyLinks) {
        sqlLines.push(`INSERT INTO procedure_order (provider_id, patient_id, encounter_id, date_ordered, order_priority, order_status, activity, control_id, lab_id, clinical_hx) VALUES (1, ${s.pid}, 0, '${s.dateFormatted}', 'normal', 'complete', 1, '${s.accession}', 0, 'Radiology order');`);
        sqlLines.push(`SET @oid = LAST_INSERT_ID();`);
        sqlLines.push(`INSERT INTO procedure_order_code (procedure_order_id, procedure_order_seq, procedure_code, procedure_name, procedure_source, procedure_order_title) VALUES (@oid, 1, '${s.study.code}', '${esc(s.study.name)}', '1', '${esc(s.study.name)}');`);
        sqlLines.push(`INSERT INTO procedure_report (procedure_order_id, procedure_order_seq, date_collected, date_report, source, report_status, review_status, report_notes) VALUES (@oid, 1, '${s.dateFormatted}', '${s.dateFormatted}', '${esc(s.radiologist)}', 'final', 'reviewed', '${esc(s.finding)}');`);
        sqlLines.push(`SET @rid = LAST_INSERT_ID();`);
        sqlLines.push(`INSERT INTO procedure_result (procedure_report_id, result_data_type, result_code, result_text, date, facility, result, result_status) VALUES (@rid, 'L', '${s.study.code}', '${esc(s.study.name)} Report', '${s.dateFormatted}', 'Radiology Department', '${esc(s.finding)}', 'final');`);
    }

    if (sqlLines.length > 0) {
        const sqlFile = '/tmp/rad_orders.sql';
        fs.writeFileSync(sqlFile, sqlLines.join('\n'));
        execSync(`docker cp ${sqlFile} medseal-openemr-db:/tmp/rad_orders.sql`, { stdio: 'pipe' });
        execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -e "source /tmp/rad_orders.sql"`, { stdio: 'pipe', timeout: 30000 });
        console.log(`✅ ${studyLinks.length} radiology orders + reports created\n`);
    }

    // Verify
    const stats = await (await fetch(`${ORTHANC}/statistics`, { headers: { Authorization: AUTH } })).json();
    const orders = execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -N -e "SELECT COUNT(*) FROM procedure_order WHERE order_status='complete'"`, { stdio: 'pipe' }).toString().trim();
    const reports = execSync(`docker exec medseal-openemr-db mariadb -u openemr -popenemr openemr -N -e "SELECT COUNT(*) FROM procedure_report WHERE report_status='final'"`, { stdio: 'pipe' }).toString().trim();

    console.log('=== VERIFIED ===');
    console.log(`Orthanc: ${stats.CountStudies} studies, ${stats.CountPatients} patients, ${stats.CountInstances} instances`);
    console.log(`OpenEMR: ${orders} procedure orders, ${reports} radiology reports`);
    console.log(`\nOrthanc Explorer: http://localhost:8042`);
    console.log(`OHIF Viewer: http://localhost:3003`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
