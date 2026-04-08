// ═══ Med-SEAL Service Definitions (V2) ═══

export const SERVICES = [
  {
    id: 'openemr',
    name: 'OpenEMR',
    desc: 'Clinical EMR — patient records, scheduling, billing, and clinical workflows.',
    port: 'emr',
    url: 'https://emr.med-seal.org',
    healthUrl: 'https://emr.med-seal.org/interface/login/login.php',
    color: '#297cbb',
    bgColor: 'rgba(41, 124, 187, 0.12)',
    ssoId: 'openemr',
  },
  {
    id: 'medplum',
    name: 'Medplum FHIR',
    desc: 'FHIR R4 server — interoperable patient data, resources, and API access.',
    port: 'fhir',
    url: 'https://medplum.med-seal.org',
    healthUrl: 'https://fhir.med-seal.org/healthcheck',
    color: '#30a46c',
    bgColor: 'rgba(48, 164, 108, 0.12)',
    accessRoles: ['admin'],
  },
  {
    id: 'orthanc',
    name: 'Orthanc PACS',
    desc: 'Medical imaging — DICOM storage, retrieval, and routing for radiology workflows.',
    port: 'pacs',
    url: 'https://pacs.med-seal.org',
    healthUrl: 'https://pacs.med-seal.org/app/explorer.html',
    color: '#ca8a04',
    bgColor: 'rgba(202, 138, 4, 0.12)',
    accessTags: ['radiologist'],
  },
  {
    id: 'ohif',
    name: 'OHIF Viewer',
    desc: 'Web-based DICOM viewer — zero-footprint diagnostic imaging with AI integration.',
    port: 'viewer',
    url: 'https://viewer.med-seal.org',
    healthUrl: 'https://viewer.med-seal.org',
    color: '#5b21b6',
    bgColor: 'rgba(91, 33, 182, 0.12)',
    accessTags: ['radiologist'],
  },
  {
    id: 'cdss',
    name: 'Clinical Decision Support',
    desc: 'AI-powered clinical reasoning — evidence-based chat with FHIR patient context and journal RAG.',
    port: 'cdss',
    url: 'https://cdss.med-seal.org',
    healthUrl: '/api/system-status',
    color: '#4589ff',
    bgColor: 'rgba(69, 137, 255, 0.12)',
    accessRoles: ['admin', 'doc', 'clin'],
    ssoId: 'cdss',
  },
];

export const ROLES = [
  { value: 'admin', label: 'Administrators' },
  { value: 'doc', label: 'Physicians' },
  { value: 'clin', label: 'Clinicians' },
  { value: 'front', label: 'Front Office' },
  { value: 'back', label: 'Accounting' },
  { value: 'breakglass', label: 'Emergency Login' },
];

export const roleLabel = (v) => ROLES.find((r) => r.value === v)?.label || v;

export function filterServices(role, tags) {
  return SERVICES.filter((s) => {
    if (!s.accessRoles && !s.accessTags) return true;
    if (role === 'admin') return true;
    if (s.accessRoles && s.accessRoles.includes(role)) return true;
    if (s.accessTags && s.accessTags.some((t) => tags.includes(t))) return true;
    return false;
  });
}
