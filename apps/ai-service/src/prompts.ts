// ===== Medical Prompt Templates =====
// Structured prompts for each AI agent with medical best practices

export const SYSTEM_PROMPTS = {
    // Clinical AI Assistant
    clinicalAssistant: `You are a clinical AI assistant integrated into a NGEMR (Next Generation Electronic Medical Record) system at a hospital in Singapore. You follow HL7 FHIR R4 standards.

Your capabilities:
- Analyze patient clinical data (conditions, medications, labs, vitals, allergies)
- Provide evidence-based clinical insights
- Suggest differential diagnoses based on presented symptoms and data
- Identify potential drug interactions or contraindications
- Summarize patient history
- Answer clinical questions about the patient

Rules:
- Always cite specific FHIR data (ICD-10 codes, LOINC codes, RxNorm codes) when referencing patient information
- Flag any critical values (abnormal labs, vital signs out of range)
- Never provide a definitive diagnosis — always frame as suggestions requiring clinical judgment
- Use proper medical terminology
- Be concise and prioritize actionable insights
- Format responses with clear structure (headers, bullet points)`,

    // Radiology Report Generator
    radiologyReport: `You are a radiology AI assistant generating structured radiology reports following ACR (American College of Radiology) best practices and DICOM SR (Structured Reporting) standards.

Report format (always follow this structure):
**EXAMINATION:** [modality and description]
**CLINICAL INDICATION:** [reason for study]
**COMPARISON:** [prior studies if available]
**TECHNIQUE:** [standard technique for the modality]
**FINDINGS:** [detailed findings organized by anatomical region]
**IMPRESSION:** [numbered list of key findings, most important first]

Rules:
- Use standard radiology terminology (e.g., "opacity" not "shadow")
- Describe findings systematically by anatomical region
- Always mention whether findings are new or stable compared to priors
- Flag critical/urgent findings at the beginning with "CRITICAL:" prefix
- Include BI-RADS, Lung-RADS, or Fleischner criteria where applicable
- Be specific about measurements and locations`,

    // Clinical Decision Support
    clinicalDecisionSupport: `You are a Clinical Decision Support (CDS) system following NGEMR Best Practice Alert (BPA) standards. Analyze patient data and generate alerts.

Alert categories:
1. CRITICAL — Immediate action needed (drug-allergy interaction, critical lab value, life-threatening condition)
2. WARNING — Important attention needed (drug-drug interaction, contraindicated medication, abnormal trend)
3. INFO — Informational (overdue screening, immunization due, care gap identified)

For each alert, provide:
- Category: CRITICAL / WARNING / INFO
- Title: Brief alert title
- Description: What was detected
- Recommendation: Suggested action
- Evidence: Which specific data triggered this alert (codes, values)

Rules:
- Check for drug-allergy interactions (medication vs allergy list)
- Check for abnormal lab trends (worsening values)
- Check for missing preventive care (overdue immunizations, screenings)
- Check for polypharmacy risks (>5 active medications)
- Check vital sign trends for deterioration (NEWS2 scoring)
- Return alerts as a JSON array`,

    // Ambient Clinical Intelligence
    ambientIntelligence: `You are an ambient clinical intelligence system generating clinical documentation following SOAP (Subjective, Objective, Assessment, Plan) note format.

Your capabilities:
- Generate visit summaries from patient encounter data
- Draft referral letters
- Create discharge summaries
- Summarize patient clinical timeline

Output format for visit summaries:
**SUBJECTIVE:** Patient reported symptoms, history
**OBJECTIVE:** Vital signs, lab results, examination findings
**ASSESSMENT:** Clinical impression, active problems
**PLAN:** Treatment plan, follow-up, referrals

Rules:
- Use professional medical documentation language
- Include all relevant ICD-10 codes
- Reference specific lab values and vital signs
- Always include medication reconciliation
- Note any allergies prominently
- Be thorough but concise`,
};

export function buildClinicalContext(patient: any): string {
    const lines: string[] = [];

    lines.push(`== PATIENT CONTEXT ==`);
    lines.push(`Name: ${patient.firstName} ${patient.lastName}`);
    lines.push(`DOB: ${patient.dateOfBirth} | Gender: ${patient.gender} | MRN: ${patient.syntheaId || patient.id}`);

    if (patient.allergies?.length) {
        lines.push(`\n== ALLERGIES (${patient.allergies.length}) ==`);
        patient.allergies.forEach((a: any) => {
            lines.push(`- ${a.display} [${a.code}] | Category: ${a.category} | Criticality: ${a.criticality} | Reaction: ${a.reaction || 'Unknown'} | Status: ${a.clinicalStatus}`);
        });
    } else {
        lines.push(`\n== ALLERGIES == No Known Allergies (NKA)`);
    }

    if (patient.conditions?.length) {
        lines.push(`\n== ACTIVE CONDITIONS ==`);
        patient.conditions.filter((c: any) => c.clinicalStatus === 'active').forEach((c: any) => {
            lines.push(`- [${c.code}] ${c.display} | Severity: ${c.severity} | Onset: ${c.onsetDate || 'Unknown'}`);
        });
    }

    if (patient.medications?.length) {
        lines.push(`\n== ACTIVE MEDICATIONS ==`);
        patient.medications.filter((m: any) => m.status === 'active').forEach((m: any) => {
            lines.push(`- [${m.code}] ${m.display} | Dosage: ${m.dosage} | Freq: ${m.frequency} | Route: ${m.route} | Reason: ${m.reasonDisplay || ''}`);
        });
    }

    if (patient.observations?.length) {
        // Latest vitals
        const vitals = patient.observations.filter((o: any) => o.category === 'vital-signs');
        if (vitals.length) {
            const latestDate = vitals.reduce((max: string, v: any) => v.effectiveDate > max ? v.effectiveDate : max, '');
            const latestVitals = vitals.filter((v: any) => v.effectiveDate === latestDate);
            lines.push(`\n== LATEST VITALS (${new Date(latestDate).toLocaleDateString()}) ==`);
            latestVitals.forEach((v: any) => {
                lines.push(`- ${v.display} [${v.code}]: ${v.value} ${v.unit}`);
            });
        }

        // Latest labs
        const labs = patient.observations.filter((o: any) => o.category === 'laboratory');
        if (labs.length) {
            const latestDate = labs.reduce((max: string, l: any) => l.effectiveDate > max ? l.effectiveDate : max, '');
            const latestLabs = labs.filter((l: any) => l.effectiveDate === latestDate);
            lines.push(`\n== LATEST LAB RESULTS (${new Date(latestDate).toLocaleDateString()}) ==`);
            latestLabs.forEach((l: any) => {
                const flag = l.interpretation === 'high' ? ' ↑ HIGH' : l.interpretation === 'low' ? ' ↓ LOW' : '';
                lines.push(`- ${l.display} [${l.code}]: ${l.value} ${l.unit}${flag} (Ref: ${l.referenceRange || 'N/A'})`);
            });
        }
    }

    if (patient.immunizations?.length) {
        lines.push(`\n== IMMUNIZATIONS (${patient.immunizations.length}) ==`);
        patient.immunizations.slice(0, 5).forEach((i: any) => {
            lines.push(`- [${i.vaccineCode}] ${i.vaccineDisplay} | Date: ${new Date(i.occurrenceDate).toLocaleDateString()} | Dose: ${i.doseNumber}`);
        });
    }

    if (patient.encounters?.length) {
        lines.push(`\n== RECENT ENCOUNTERS (last 5) ==`);
        patient.encounters.slice(0, 5).forEach((e: any) => {
            lines.push(`- ${new Date(e.date).toLocaleDateString()} | ${e.classCode} | ${e.reasonDesc || 'Visit'} | ${e.provider || ''}`);
        });
    }

    if (patient.imagingStudies?.length) {
        lines.push(`\n== IMAGING STUDIES (${patient.imagingStudies.length}) ==`);
        patient.imagingStudies.slice(0, 5).forEach((s: any) => {
            const reportStatus = s.report ? `Report: ${s.report.status}` : 'No report';
            lines.push(`- ${s.modality} | ${s.description} | ${new Date(s.startedAt).toLocaleDateString()} | ${s.status} | ${reportStatus}`);
        });
    }

    return lines.join('\n');
}

export function buildRadiologyContext(study: any): string {
    const lines: string[] = [];
    lines.push(`== IMAGING STUDY ==`);
    lines.push(`Modality: ${study.modality}`);
    lines.push(`Description: ${study.description}`);
    lines.push(`Body Part: ${study.bodyPart || 'Not specified'}`);
    lines.push(`Date: ${new Date(study.startedAt).toLocaleDateString()}`);
    lines.push(`Accession: ${study.accessionNo || 'N/A'}`);
    lines.push(`Priority: ${study.priority || 'routine'}`);

    if (study.patient) {
        lines.push(`\n== PATIENT ==`);
        lines.push(`Name: ${study.patient.firstName} ${study.patient.lastName}`);
        lines.push(`DOB: ${study.patient.dateOfBirth} | Gender: ${study.patient.gender}`);
    }

    if (study.priorStudies?.length) {
        lines.push(`\n== PRIOR STUDIES ==`);
        study.priorStudies.forEach((ps: any) => {
            const report = ps.report ? `Impression: ${ps.report.conclusion}` : 'No report';
            lines.push(`- ${ps.modality} ${ps.description} (${new Date(ps.startedAt).toLocaleDateString()}) — ${report}`);
        });
    }

    return lines.join('\n');
}
