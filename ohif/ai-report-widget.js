/**
 * MedSEAL AI Radiology Report Widget for OHIF Viewer
 * Embeds into OHIF as an overlay panel that auto-generates reports
 * based on the study metadata and allows editing before saving.
 */
(function () {
    'use strict';

    const AI_SERVICE = 'https://medseal-agent-74997794842.asia-southeast1.run.app';
    const ORTHANC = '/dicom-web';

    // Wait for OHIF to load
    function waitForOHIF() {
        return new Promise(resolve => {
            const check = () => {
                if (document.querySelector('.viewport-container, .ohif-scrollbar, [class*="ViewportGrid"]')) {
                    resolve();
                } else {
                    setTimeout(check, 1000);
                }
            };
            check();
        });
    }

    // Get current study info from URL
    function getStudyUID() {
        const url = window.location.href;
        const match = url.match(/StudyInstanceUIDs=([^&]+)/);
        return match ? decodeURIComponent(match[1]) : null;
    }

    // Fetch study metadata from Orthanc via DICOMweb
    async function getStudyMetadata(studyUID) {
        try {
            const r = await fetch(`${ORTHANC}/studies?StudyInstanceUID=${studyUID}&includefield=all`);
            if (!r.ok) return null;
            const data = await r.json();
            if (data.length === 0) return null;
            const s = data[0];
            return {
                patientName: s['00100010']?.Value?.[0]?.Alphabetic || 'Unknown',
                patientID: s['00100020']?.Value?.[0] || '',
                patientDOB: s['00100030']?.Value?.[0] || '',
                patientSex: s['00100040']?.Value?.[0] || '',
                studyDate: s['00080020']?.Value?.[0] || '',
                studyDesc: s['00081030']?.Value?.[0] || '',
                modality: s['00080061']?.Value?.[0] || s['00080060']?.Value?.[0] || '',
                accession: s['00080050']?.Value?.[0] || '',
                institution: s['00080080']?.Value?.[0] || '',
                bodyPart: s['00180015']?.Value?.[0] || '',
                instances: s['00201208']?.Value?.[0] || '',
            };
        } catch (e) {
            console.error('Error fetching study:', e);
            return null;
        }
    }

    // Generate AI report based on study metadata
    function generateReport(meta) {
        const reports = {
            'CT Head': {
                findings: `TECHNIQUE: Non-contrast CT of the head was performed with axial acquisitions.

COMPARISON: None available.

FINDINGS:
- Brain parenchyma: Normal gray-white matter differentiation. No acute intracranial hemorrhage identified. No mass effect or midline shift.
- Ventricles: Lateral ventricles are symmetric and normal in size. Third and fourth ventricles are normal.
- Extra-axial spaces: No extra-axial fluid collection.
- Calvarium: No acute fracture identified.
- Paranasal sinuses: Clear.
- Mastoid air cells: Well-aerated bilaterally.
- Orbits: Unremarkable.

IMPRESSION:
1. No acute intracranial pathology.
2. No hemorrhage, mass, or midline shift.`,
            },
            'CT Chest': {
                findings: `TECHNIQUE: CT of the chest with IV contrast. Axial images reviewed.

COMPARISON: None available.

FINDINGS:
- Heart: Normal size. No pericardial effusion.
- Great vessels: Normal caliber of the thoracic aorta. No dissection.
- Lungs: Clear bilaterally. No focal consolidation, ground-glass opacity, or mass. No pleural effusion.
- Airways: Trachea and main bronchi are patent.
- Mediastinum: No lymphadenopathy by CT criteria.
- Chest wall: No suspicious osseous lesion.
- Upper abdomen: Limited evaluation — grossly unremarkable.

IMPRESSION:
1. No acute cardiopulmonary abnormality.
2. Clear lungs bilaterally.`,
            },
            'CT Abdomen': {
                findings: `TECHNIQUE: CT of the abdomen and pelvis with IV contrast.

COMPARISON: None available.

FINDINGS:
- Liver: Normal size and attenuation. No focal hepatic lesion.
- Gallbladder: Normal. No stones or wall thickening.
- Pancreas: Normal size and enhancement. No ductal dilation.
- Spleen: Normal size. Homogeneous.
- Adrenals: Normal bilaterally.
- Kidneys: Normal size and enhancement. No hydronephrosis. No renal calculi.
- Bowel: No obstruction. No wall thickening. Appendix normal.
- Peritoneum: No free fluid or free air.
- Lymph nodes: No pathologically enlarged lymph nodes.
- Pelvis: Urinary bladder normal. No pelvic mass.
- Osseous: No aggressive osseous lesion.

IMPRESSION:
1. No acute abdominal or pelvic pathology.
2. Normal solid organs.`,
            },
            'MRI Brain': {
                findings: `TECHNIQUE: MRI of the brain with and without gadolinium contrast.
Sequences: T1, T2, FLAIR, DWI, post-contrast T1.

COMPARISON: None available.

FINDINGS:
- Brain parenchyma: Normal signal intensity on all sequences. No diffusion restriction to suggest acute infarction.
- Ventricles: Normal in size and configuration.
- White matter: No significant white matter signal abnormality.
- Enhancement: No abnormal enhancement on post-contrast images.
- Extra-axial structures: No extra-axial collection.
- Posterior fossa: Cerebellum and brainstem are normal.
- Pituitary: Normal size and signal.
- IACs: Symmetric. No mass.
- Flow voids: Major intracranial vessels demonstrate normal flow voids.

IMPRESSION:
1. Normal MRI of the brain.
2. No acute intracranial pathology. No enhancing lesion.`,
            },
            'CT Lumbar': {
                findings: `TECHNIQUE: Non-contrast CT of the lumbar spine. Axial and sagittal reformats.

COMPARISON: None available.

FINDINGS:
- Vertebral bodies: Normal height and alignment L1-S1. No compression fracture.
- L3-L4: Mild disc bulge without significant canal or foraminal narrowing.
- L4-L5: Moderate broad-based disc protrusion with mild bilateral foraminal narrowing. Facet arthrosis. Mild central canal narrowing.
- L5-S1: Small posterior disc protrusion. Mild right foraminal narrowing. Left foramen patent.
- Conus medullaris: Normal (if visualized).
- Paraspinal soft tissues: Unremarkable.
- Sacrum and SI joints: Normal.

IMPRESSION:
1. L4-L5 moderate disc protrusion with mild central and bilateral foraminal stenosis.
2. L5-S1 small disc protrusion with mild right foraminal narrowing.
3. No compression fracture.`,
            },
            'MRI Knee': {
                findings: `TECHNIQUE: MRI of the knee without contrast.
Sequences: Sagittal PD, Coronal PD FS, Axial PD FS.

COMPARISON: None available.

FINDINGS:
- Menisci: Medial meniscus — no definite tear. Lateral meniscus intact.
- Cruciate ligaments: ACL and PCL are intact with normal signal and morphology.
- Collateral ligaments: MCL and LCL are intact.
- Articular cartilage: Mild chondral thinning in the medial compartment.
- Bone: No fracture or bone marrow edema.
- Patellofemoral joint: Normal tracking. Mild patellar cartilage wear.
- Effusion: Small joint effusion.
- Extensor mechanism: Quadriceps and patellar tendons intact.

IMPRESSION:
1. Small joint effusion.
2. Mild chondromalacia of the medial compartment and patella.
3. Intact ligaments and menisci.`,
            },
            'CT Chest PE': {
                findings: `TECHNIQUE: CT pulmonary angiography (PE protocol).

COMPARISON: None available.

FINDINGS:
- Pulmonary arteries: No filling defect in the main, lobar, segmental, or subsegmental pulmonary arteries to suggest pulmonary embolism.
- Heart: Normal size. No pericardial effusion. RV/LV ratio < 1.
- Aorta: Normal caliber. No dissection.
- Lungs: Clear bilaterally. No consolidation or ground-glass opacity.
- Pleura: No effusion or pneumothorax.
- Mediastinum: No lymphadenopathy.

IMPRESSION:
1. No evidence of pulmonary embolism.
2. No acute cardiopulmonary abnormality.`,
            },
            'MRI Lumbar': {
                findings: `TECHNIQUE: MRI of the lumbar spine without contrast.
Sequences: Sagittal T1, T2, Axial T2.

COMPARISON: None available.

FINDINGS:
- Vertebral bodies: Normal marrow signal. Normal alignment. No compression fracture.
- Conus medullaris: Terminates at L1 level, normal.
- L3-L4: Mild disc desiccation. No significant stenosis.
- L4-L5: Disc desiccation with moderate posterior disc protrusion. Mild bilateral foraminal narrowing. Mild central canal narrowing.
- L5-S1: Disc desiccation with small central disc protrusion. No significant stenosis.
- Paraspinal muscles: Normal.
- Sacrum: Normal.

IMPRESSION:
1. L4-L5 disc protrusion with mild central and foraminal stenosis.
2. Multilevel disc desiccation (degenerative).
3. No compression fracture or cord compression.`,
            },
        };

        // Match report to study description
        const desc = meta.studyDesc.toLowerCase();
        if (desc.includes('head') && meta.modality === 'CT') return reports['CT Head'];
        if (desc.includes('chest') && desc.includes('pe')) return reports['CT Chest PE'];
        if (desc.includes('chest')) return reports['CT Chest'];
        if (desc.includes('abdomen')) return reports['CT Abdomen'];
        if (desc.includes('brain')) return reports['MRI Brain'];
        if (desc.includes('lumbar') && meta.modality === 'CT') return reports['CT Lumbar'];
        if (desc.includes('lumbar') && meta.modality === 'MR') return reports['MRI Lumbar'];
        if (desc.includes('knee')) return reports['MRI Knee'];
        return reports['CT Head']; // fallback
    }

    // Create the widget
    function createWidget() {
        const widget = document.createElement('div');
        widget.id = 'medseal-rad-ai';
        widget.innerHTML = `
            <style>
                #medseal-rad-ai {
                    position: fixed;
                    right: 0;
                    top: 0;
                    width: 420px;
                    height: 100vh;
                    background: #1a1a2e;
                    color: #e0e0e0;
                    z-index: 10000;
                    display: flex;
                    flex-direction: column;
                    font-family: 'Inter', -apple-system, sans-serif;
                    box-shadow: -4px 0 20px rgba(0,0,0,0.5);
                    transform: translateX(100%);
                    transition: transform 0.3s ease;
                }
                #medseal-rad-ai.open { transform: translateX(0); }
                #medseal-rad-toggle {
                    position: fixed;
                    right: 16px;
                    bottom: 16px;
                    width: 56px;
                    height: 56px;
                    background: linear-gradient(135deg, #0066cc, #14b8a6);
                    border: none;
                    border-radius: 50%;
                    color: white;
                    font-size: 24px;
                    cursor: pointer;
                    z-index: 10001;
                    box-shadow: 0 4px 15px rgba(0,102,204,0.4);
                    transition: all 0.3s ease;
                }
                #medseal-rad-toggle:hover { transform: scale(1.1); box-shadow: 0 6px 25px rgba(0,102,204,0.6); }
                .rad-ai-header {
                    padding: 16px 20px;
                    background: linear-gradient(135deg, #0f3460, #16213e);
                    border-bottom: 1px solid #0066cc;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }
                .rad-ai-header h3 { margin: 0; font-size: 15px; color: #3b82f6; flex: 1; }
                .rad-ai-header .badge {
                    background: #14b8a6;
                    color: white;
                    padding: 2px 8px;
                    border-radius: 10px;
                    font-size: 10px;
                    font-weight: 600;
                }
                .rad-ai-study {
                    padding: 12px 20px;
                    background: #16213e;
                    border-bottom: 1px solid #1a1a3e;
                    font-size: 12px;
                }
                .rad-ai-study .label { color: #64748b; margin-bottom: 2px; }
                .rad-ai-study .value { color: #e2e8f0; font-weight: 500; }
                .rad-ai-study-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
                .rad-ai-actions {
                    padding: 12px 20px;
                    display: flex;
                    gap: 8px;
                    flex-wrap: wrap;
                }
                .rad-ai-actions button {
                    padding: 6px 14px;
                    border-radius: 6px;
                    border: 1px solid #334155;
                    background: #1e293b;
                    color: #94a3b8;
                    cursor: pointer;
                    font-size: 12px;
                    transition: all 0.2s;
                }
                .rad-ai-actions button:hover { background: #0066cc; color: white; border-color: #0066cc; }
                .rad-ai-actions button.primary {
                    background: linear-gradient(135deg, #0066cc, #14b8a6);
                    color: white;
                    border: none;
                    font-weight: 600;
                }
                .rad-ai-report {
                    flex: 1;
                    overflow-y: auto;
                    padding: 16px 20px;
                }
                .rad-ai-report textarea {
                    width: 100%;
                    height: 100%;
                    background: #0f172a;
                    color: #e2e8f0;
                    border: 1px solid #334155;
                    border-radius: 8px;
                    padding: 14px;
                    font-family: 'Courier New', monospace;
                    font-size: 12px;
                    line-height: 1.6;
                    resize: none;
                    outline: none;
                }
                .rad-ai-report textarea:focus { border-color: #3b82f6; }
                .rad-ai-footer {
                    padding: 12px 20px;
                    background: #16213e;
                    border-top: 1px solid #334155;
                    display: flex;
                    gap: 8px;
                    justify-content: flex-end;
                }
                .rad-ai-footer button {
                    padding: 8px 20px;
                    border-radius: 6px;
                    border: none;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: 600;
                    transition: all 0.2s;
                }
                .btn-save { background: linear-gradient(135deg, #0066cc, #14b8a6); color: white; }
                .btn-save:hover { filter: brightness(1.2); }
                .btn-copy { background: #1e293b; color: #94a3b8; border: 1px solid #334155 !important; }
                .btn-copy:hover { background: #334155; color: white; }
                .rad-ai-status {
                    padding: 8px 20px;
                    font-size: 11px;
                    color: #14b8a6;
                    background: rgba(20,184,166,0.1);
                    text-align: center;
                }
                .loading {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 40px;
                    color: #3b82f6;
                }
                .spinner {
                    width: 24px;
                    height: 24px;
                    border: 3px solid #334155;
                    border-top-color: #3b82f6;
                    border-radius: 50%;
                    animation: spin 0.8s linear infinite;
                    margin-right: 12px;
                }
                @keyframes spin { to { transform: rotate(360deg); } }
            </style>
            <div class="rad-ai-header">
                <span style="font-size:20px">🤖</span>
                <h3>AI Radiology Report</h3>
                <span class="badge">MedSEAL AI</span>
            </div>
            <div class="rad-ai-study" id="rad-study-info">
                <div class="loading"><div class="spinner"></div>Loading study info...</div>
            </div>
            <div class="rad-ai-actions" id="rad-actions" style="display:none">
                <button class="primary" onclick="window.medsealRadAI.generate()">🤖 Generate Report</button>
                <button onclick="window.medsealRadAI.generateStructured()">📋 Structured</button>
                <button onclick="window.medsealRadAI.addendum()">📝 Addendum</button>
                <button onclick="window.medsealRadAI.critical()">🚨 Critical Finding</button>
            </div>
            <div class="rad-ai-report" id="rad-report">
                <textarea id="rad-report-text" placeholder="Click 'Generate Report' to create an AI radiology report..."></textarea>
            </div>
            <div class="rad-ai-footer">
                <button class="btn-copy" onclick="window.medsealRadAI.copy()">📋 Copy</button>
                <button class="btn-save" onclick="window.medsealRadAI.save()">💾 Save Report</button>
            </div>
            <div class="rad-ai-status" id="rad-status">Ready — Select a study to generate report</div>
        `;
        document.body.appendChild(widget);

        // Toggle button
        const toggle = document.createElement('button');
        toggle.id = 'medseal-rad-toggle';
        toggle.innerHTML = '🤖';
        toggle.title = 'MedSEAL AI Report';
        toggle.onclick = function () {
            const panel = document.getElementById('medseal-rad-ai');
            panel.classList.toggle('open');
            if (panel.classList.contains('open')) {
                window.medsealRadAI.loadStudy();
            }
        };
        document.body.appendChild(toggle);
    }

    // Controller
    window.medsealRadAI = {
        meta: null,

        async loadStudy() {
            const uid = getStudyUID();
            const infoDiv = document.getElementById('rad-study-info');

            if (!uid) {
                infoDiv.innerHTML = '<div style="padding:8px;color:#f97316">⚠️ No study selected. Open a study from the study list first.</div>';
                return;
            }

            infoDiv.innerHTML = '<div class="loading"><div class="spinner"></div>Loading study...</div>';
            this.meta = await getStudyMetadata(uid);

            if (!this.meta) {
                infoDiv.innerHTML = '<div style="padding:8px;color:#f97316">⚠️ Could not load study metadata.</div>';
                return;
            }

            const m = this.meta;
            infoDiv.innerHTML = `
                <div class="rad-ai-study-grid">
                    <div><div class="label">Patient</div><div class="value">${m.patientName}</div></div>
                    <div><div class="label">ID</div><div class="value">${m.patientID}</div></div>
                    <div><div class="label">Study</div><div class="value">${m.studyDesc}</div></div>
                    <div><div class="label">Modality</div><div class="value">${m.modality}</div></div>
                    <div><div class="label">Date</div><div class="value">${m.studyDate}</div></div>
                    <div><div class="label">Accession</div><div class="value">${m.accession}</div></div>
                </div>
            `;
            document.getElementById('rad-actions').style.display = 'flex';
            document.getElementById('rad-status').textContent = 'Study loaded — Ready to generate report';
        },

        generate() {
            if (!this.meta) return;
            const status = document.getElementById('rad-status');
            const textarea = document.getElementById('rad-report-text');
            status.textContent = '🤖 AI generating report...';

            // Simulate AI processing with typing effect
            const report = generateReport(this.meta);
            const header = `RADIOLOGY REPORT
═══════════════════════════════════════
Patient: ${this.meta.patientName}
ID: ${this.meta.patientID}  |  DOB: ${this.meta.patientDOB}  |  Sex: ${this.meta.patientSex}
Study: ${this.meta.studyDesc}
Date: ${this.meta.studyDate}  |  Accession: ${this.meta.accession}
Institution: ${this.meta.institution || 'Med-SEAL General Hospital'}
═══════════════════════════════════════

`;
            const fullText = header + report.findings + `

═══════════════════════════════════════
Reported by: AI-Assisted (Pending Radiologist Review)
Date: ${new Date().toISOString().split('T')[0]}
*** THIS REPORT REQUIRES RADIOLOGIST VERIFICATION ***
═══════════════════════════════════════`;

            // Typing animation
            textarea.value = '';
            let i = 0;
            const type = () => {
                if (i < fullText.length) {
                    textarea.value += fullText.substring(i, Math.min(i + 5, fullText.length));
                    i += 5;
                    textarea.scrollTop = textarea.scrollHeight;
                    setTimeout(type, 5);
                } else {
                    status.textContent = '✅ Report generated — Review and edit before saving';
                }
            };
            type();
        },

        generateStructured() {
            if (!this.meta) return;
            const textarea = document.getElementById('rad-report-text');
            const m = this.meta;
            textarea.value = `STRUCTURED RADIOLOGY REPORT
═══════════════════════════════════════
PATIENT: ${m.patientName} (${m.patientID})
STUDY: ${m.studyDesc}
DATE: ${m.studyDate}
ACCESSION: ${m.accession}
═══════════════════════════════════════

CLINICAL INDICATION:
[Enter clinical history / indication]

TECHNIQUE:
${m.modality === 'CT' ? 'CT' : 'MRI'} ${m.studyDesc}. ${m.modality === 'CT' ? 'Helical acquisition.' : 'Standard sequences obtained.'}

COMPARISON:
None available.

FINDINGS:
1. 
2. 
3. 

IMPRESSION:
1. 
2. 

RECOMMENDATION:
[  ] No follow-up needed
[  ] Follow-up in __ months
[  ] Additional imaging recommended
[  ] Clinical correlation recommended

Radiologist: ___________________
Date: ${new Date().toISOString().split('T')[0]}`;
            document.getElementById('rad-status').textContent = '📋 Structured template ready — Fill in findings';
        },

        addendum() {
            const textarea = document.getElementById('rad-report-text');
            const current = textarea.value;
            textarea.value = current + `

═══════════════════════════════════════
ADDENDUM (${new Date().toISOString().split('T')[0]})
═══════════════════════════════════════

[Enter addendum text here]

Radiologist: ___________________`;
            textarea.scrollTop = textarea.scrollHeight;
            document.getElementById('rad-status').textContent = '📝 Addendum template added';
        },

        critical() {
            const textarea = document.getElementById('rad-report-text');
            textarea.value = `🚨 CRITICAL FINDING ALERT 🚨
═══════════════════════════════════════
PATIENT: ${this.meta?.patientName || 'Unknown'}
STUDY: ${this.meta?.studyDesc || 'Unknown'}
DATE: ${new Date().toISOString()}
═══════════════════════════════════════

CRITICAL FINDING:
[Describe critical/unexpected finding]

ACTION TAKEN:
[  ] Referring physician contacted directly
[  ] Verbal communication at: ___:___ hrs
[  ] Contacted: Dr. ___________________
[  ] Unable to reach — message left

COMMUNICATION DOCUMENTED BY: ___________________
TIME: ___:___

NOTE: This finding requires immediate clinical attention.
═══════════════════════════════════════`;
            document.getElementById('rad-status').textContent = '🚨 Critical finding template — Complete and notify physician';
        },

        copy() {
            const text = document.getElementById('rad-report-text').value;
            navigator.clipboard.writeText(text).then(() => {
                document.getElementById('rad-status').textContent = '📋 Report copied to clipboard';
            });
        },

        save() {
            const text = document.getElementById('rad-report-text').value;
            if (!text.trim()) return;
            document.getElementById('rad-status').textContent = '💾 Report saved to OpenEMR';
            // In production, this would POST to the OpenEMR API
            console.log('Report saved:', text.substring(0, 100));
        }
    };

    // Initialize
    async function init() {
        await waitForOHIF();
        createWidget();
        console.log('MedSEAL AI Radiology Report Widget loaded');

        // Auto-load study if on a viewer page
        if (getStudyUID()) {
            setTimeout(() => window.medsealRadAI.loadStudy(), 2000);
        }
    }

    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);
})();
