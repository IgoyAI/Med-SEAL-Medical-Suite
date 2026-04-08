export interface Session {
  username: string;
  loginTime: number;
  role: string;
  tags: string[];
}

export interface Thread {
  id: number;
  username: string;
  patient_id: string | null;
  patient_name: string | null;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Source {
  title: string;
  authors: string | string[];
  journal: string;
  year: string;
  doi: string;
  abstract?: string;
  relevance?: number;
  relevance_score?: number;
  pmid?: string;
  source_label?: string;
}

export interface Message {
  id?: number;
  thread_id?: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources?: Source[];
  thinking?: string;
  created_at?: string;
}

export interface PatientContext {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  syntheaId?: string;
  allergies: Allergy[];
  conditions: Condition[];
  medications: Medication[];
  observations: Observation[];
  encounters: Encounter[];
  immunizations: Immunization[];
  imagingStudies: ImagingStudy[];
}

export interface Allergy {
  code: string;
  display: string;
  category: string;
  criticality: string;
  reaction: string;
  clinicalStatus: string;
}

export interface Condition {
  code: string;
  display: string;
  severity: string;
  onsetDate: string;
  clinicalStatus: string;
}

export interface Medication {
  code: string;
  display: string;
  dosage: string;
  frequency: string;
  route: string;
  status: string;
  reasonDisplay?: string;
}

export interface Observation {
  code: string;
  display: string;
  value: string;
  unit: string;
  category: string;
  effectiveDate: string;
  interpretation?: string;
  referenceRange?: string;
}

export interface Encounter {
  date: string;
  classCode: string;
  reasonDesc: string;
  provider: string;
}

export interface Immunization {
  vaccineCode: string;
  vaccineDisplay: string;
  occurrenceDate: string;
  doseNumber: string;
}

export interface ImagingStudy {
  modality: string;
  description: string;
  startedAt: string;
  status: string;
  report?: { status: string; conclusion?: string };
}
