import { apiFetch } from './api';
import type { PatientContext } from '../types';

interface PatientSearchResult {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
}

export async function searchPatients(query: string): Promise<PatientSearchResult[]> {
  return apiFetch<PatientSearchResult[]>(`/cdss/patients?q=${encodeURIComponent(query)}`);
}

export async function getPatientContext(patientId: string): Promise<PatientContext> {
  return apiFetch<PatientContext>(`/cdss/patients/${encodeURIComponent(patientId)}`);
}
