// ═══ Med-SEAL Service Definitions ═══

export interface Service {
    id: string;
    name: string;
    desc: string;
    port: string;
    url: string;
    healthUrl: string;
    color: string;
    bgColor: string;
    ssoId?: string;
    accessRoles?: string[] | null;
    accessTags?: string[];
}

// Filter services based on user role + tags
export function filterServices(role: string, tags: string[]): Service[] {
    return SERVICES.filter(s => {
        if (!s.accessRoles && !s.accessTags) return true;
        if (role === 'admin') return true;
        if (s.accessRoles && s.accessRoles.includes(role)) return true;
        if (s.accessTags && s.accessTags.some(t => tags.includes(t))) return true;
        return false;
    });
}

// ── Service list ─────────────────────────────────────────

export const SERVICES: Service[] = [
    {
        id: 'openemr', name: 'OpenEMR',
        desc: 'Clinical EMR — patient records, scheduling, billing, and clinical workflows.',
        port: 'emr',
        url: 'https://emr.med-seal.org',
        healthUrl: '/api/system-status',
        color: '#297cbb', bgColor: '#e8f4fd',
        ssoId: 'openemr',
    },
    {
        id: 'medplum', name: 'Medplum FHIR',
        desc: 'FHIR R4 server — interoperable patient data, resources, and API access.',
        port: 'fhir',
        url: 'https://medplum.med-seal.org',
        healthUrl: '/api/system-status',
        color: '#30a46c', bgColor: '#eff8f4',
        accessRoles: ['admin'],
    },
    {
        id: 'cdss', name: 'Clinical Decision Support',
        desc: 'AI-powered clinical reasoning — evidence-based chat with FHIR patient context and journal RAG.',
        port: 'cdss',
        url: 'https://cdss.med-seal.org',
        healthUrl: '/api/system-status',
        color: '#4589ff', bgColor: '#edf5ff',
        ssoId: 'cdss',
        accessRoles: ['admin', 'doc', 'clin'],
    },
    {
        id: 'langfuse', name: 'Langfuse',
        desc: 'LLM observability — trace, evaluate, and monitor AI agent performance.',
        port: 'langfuse',
        url: 'http://119.13.90.82:3100',
        healthUrl: '/api/system-status',
        color: '#e11d48', bgColor: '#fef2f2',
        accessRoles: ['admin'],
    },
];
