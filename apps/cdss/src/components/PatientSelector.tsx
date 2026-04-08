import { useState, useEffect } from 'react';
import {
  Modal,
  Search,
  StructuredListWrapper,
  StructuredListHead,
  StructuredListRow,
  StructuredListCell,
  StructuredListBody,
  Tag,
  InlineLoading,
} from '@carbon/react';
import { searchPatients } from '../services/fhir';

interface PatientResult {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (patientId: string, patientName: string) => void;
}

export default function PatientSelector({ open, onClose, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setSearched(false);
    }
  }, [open]);

  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    const timeout = setTimeout(async () => {
      setLoading(true);
      try {
        const patients = await searchPatients(query.trim());
        // Deduplicate by patient ID
        const seen = new Set<string>();
        const unique = patients.filter((p) => {
          if (seen.has(p.id)) return false;
          seen.add(p.id);
          return true;
        });
        setResults(unique);
        setSearched(true);
      } catch (err) {
        console.error('Patient search failed:', err);
        setResults([]);
        setSearched(true);
      }
      setLoading(false);
    }, 400);
    return () => clearTimeout(timeout);
  }, [query]);

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading="Select Patient"
      passiveModal
      size="md"
    >
      <div className="patient-selector">
        <Search
          size="lg"
          labelText="Search patients"
          placeholder="Search by patient name..."
          value={query}
          onChange={(e: any) => setQuery(e.target.value)}
          autoFocus
        />

        {loading && (
          <div className="patient-selector__loading">
            <InlineLoading description="Searching..." />
          </div>
        )}

        {!loading && searched && results.length === 0 && (
          <div className="patient-selector__empty">
            No patients found for "{query}"
          </div>
        )}

        {results.length > 0 && (
          <StructuredListWrapper selection className="patient-selector__list">
            <StructuredListHead>
              <StructuredListRow head>
                <StructuredListCell head>Name</StructuredListCell>
                <StructuredListCell head>DOB</StructuredListCell>
                <StructuredListCell head>Gender</StructuredListCell>
              </StructuredListRow>
            </StructuredListHead>
            <StructuredListBody>
              {results.map((p) => (
                <StructuredListRow
                  key={p.id}
                  onClick={() => {
                    onSelect(p.id, `${p.firstName} ${p.lastName}`);
                    onClose();
                  }}
                  className="patient-row"
                >
                  <StructuredListCell>
                    <strong>{p.firstName} {p.lastName}</strong>
                  </StructuredListCell>
                  <StructuredListCell>{p.dateOfBirth}</StructuredListCell>
                  <StructuredListCell>
                    <Tag size="sm" type={p.gender === 'male' ? 'blue' : 'magenta'}>
                      {p.gender}
                    </Tag>
                  </StructuredListCell>
                </StructuredListRow>
              ))}
            </StructuredListBody>
          </StructuredListWrapper>
        )}
      </div>
    </Modal>
  );
}
