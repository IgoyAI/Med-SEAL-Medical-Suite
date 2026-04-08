import {
  Tag,
  Tabs,
  TabList,
  Tab,
  TabPanels,
  TabPanel,
  StructuredListWrapper,
  StructuredListBody,
  StructuredListRow,
  StructuredListCell,
  InlineNotification,
  Button,
} from '@carbon/react';
import { Close, UserAvatar } from '@carbon/icons-react';
import type { PatientContext } from '../types';

interface Props {
  patient: PatientContext;
  onClose: () => void;
}

export default function PatientPanel({ patient, onClose }: Props) {
  const activeConditions = patient.conditions?.filter((c) => c.clinicalStatus === 'active') || [];
  const activeMeds = patient.medications?.filter((m) => m.status === 'active') || [];
  const criticalAllergies = patient.allergies?.filter((a) => a.criticality === 'high') || [];
  const vitals = patient.observations?.filter((o) => o.category === 'vital-signs') || [];
  const labs = patient.observations?.filter((o) => o.category === 'laboratory') || [];

  // Get latest vitals by most recent date
  const latestVitalDate = vitals.reduce(
    (max, v) => (v.effectiveDate > max ? v.effectiveDate : max),
    '',
  );
  const latestVitals = vitals.filter((v) => v.effectiveDate === latestVitalDate);

  // Get latest labs
  const latestLabDate = labs.reduce(
    (max, l) => (l.effectiveDate > max ? l.effectiveDate : max),
    '',
  );
  const latestLabs = labs.filter((l) => l.effectiveDate === latestLabDate);

  return (
    <div className="patient-panel">
      <div className="patient-panel__header">
        <div className="patient-panel__identity">
          <div className="patient-panel__avatar">
            <UserAvatar size={24} />
          </div>
          <div>
            <div className="patient-panel__name">
              {patient.firstName} {patient.lastName}
            </div>
            <div className="patient-panel__meta">
              {patient.dateOfBirth} &middot; {patient.gender} &middot; MRN: {patient.syntheaId || patient.id}
            </div>
          </div>
        </div>
        <div className="patient-panel__actions">
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Close}
            iconDescription="Close panel"
            hasIconOnly
            onClick={onClose}
          />
        </div>
      </div>

      {criticalAllergies.length > 0 && (
        <div className="patient-panel__alerts">
          {criticalAllergies.map((a, i) => (
            <InlineNotification
              key={i}
              kind="error"
              title="Allergy"
              subtitle={`${a.display} — ${a.reaction}`}
              lowContrast
              hideCloseButton
            />
          ))}
        </div>
      )}

      <Tabs>
        <TabList aria-label="Patient data tabs" contained>
          <Tab>Summary</Tab>
          <Tab>Conditions</Tab>
          <Tab>Meds</Tab>
          <Tab>Vitals</Tab>
          <Tab>Labs</Tab>
        </TabList>
        <TabPanels>
          {/* Summary */}
          <TabPanel>
            <div className="panel-section">
              <h4>Active Conditions ({activeConditions.length})</h4>
              <div className="tag-list">
                {activeConditions.slice(0, 8).map((c, i) => (
                  <Tag key={i} size="sm" type={c.severity === 'severe' ? 'red' : 'gray'}>
                    {c.display}
                  </Tag>
                ))}
              </div>
            </div>
            <div className="panel-section">
              <h4>Medications ({activeMeds.length})</h4>
              <div className="tag-list">
                {activeMeds.slice(0, 8).map((m, i) => (
                  <Tag key={i} size="sm" type="blue">
                    {m.display}
                  </Tag>
                ))}
              </div>
            </div>
            <div className="panel-section">
              <h4>Allergies ({patient.allergies?.length || 0})</h4>
              <div className="tag-list">
                {(patient.allergies || []).map((a, i) => (
                  <Tag key={i} size="sm" type={a.criticality === 'high' ? 'red' : 'warm-gray'}>
                    {a.display}
                  </Tag>
                ))}
                {!patient.allergies?.length && (
                  <span className="no-data">No Known Allergies (NKA)</span>
                )}
              </div>
            </div>
          </TabPanel>

          {/* Conditions */}
          <TabPanel>
            <StructuredListWrapper isCondensed>
              <StructuredListBody>
                {activeConditions.map((c, i) => (
                  <StructuredListRow key={i}>
                    <StructuredListCell>
                      <div className="condition-row">
                        <strong>{c.display}</strong>
                        <div className="condition-meta">
                          <Tag size="sm" type="outline">{c.code}</Tag>
                          {c.severity && <Tag size="sm" type={c.severity === 'severe' ? 'red' : 'gray'}>{c.severity}</Tag>}
                          <span className="meta-text">Onset: {c.onsetDate || 'Unknown'}</span>
                        </div>
                      </div>
                    </StructuredListCell>
                  </StructuredListRow>
                ))}
              </StructuredListBody>
            </StructuredListWrapper>
          </TabPanel>

          {/* Medications */}
          <TabPanel>
            <StructuredListWrapper isCondensed>
              <StructuredListBody>
                {activeMeds.map((m, i) => (
                  <StructuredListRow key={i}>
                    <StructuredListCell>
                      <div className="med-row">
                        <strong>{m.display}</strong>
                        <div className="med-meta">
                          <span>{m.dosage}</span>
                          <span>&middot;</span>
                          <span>{m.frequency}</span>
                          <span>&middot;</span>
                          <span>{m.route}</span>
                        </div>
                        {m.reasonDisplay && (
                          <div className="med-reason">For: {m.reasonDisplay}</div>
                        )}
                      </div>
                    </StructuredListCell>
                  </StructuredListRow>
                ))}
              </StructuredListBody>
            </StructuredListWrapper>
          </TabPanel>

          {/* Vitals */}
          <TabPanel>
            {latestVitals.length > 0 ? (
              <>
                <div className="panel-date">
                  Latest: {new Date(latestVitalDate).toLocaleDateString()}
                </div>
                <StructuredListWrapper isCondensed>
                  <StructuredListBody>
                    {latestVitals.map((v, i) => (
                      <StructuredListRow key={i}>
                        <StructuredListCell>{v.display}</StructuredListCell>
                        <StructuredListCell>
                          <strong>{v.value}</strong> {v.unit}
                        </StructuredListCell>
                      </StructuredListRow>
                    ))}
                  </StructuredListBody>
                </StructuredListWrapper>
              </>
            ) : (
              <div className="no-data">No vital signs recorded</div>
            )}
          </TabPanel>

          {/* Labs */}
          <TabPanel>
            {latestLabs.length > 0 ? (
              <>
                <div className="panel-date">
                  Latest: {new Date(latestLabDate).toLocaleDateString()}
                </div>
                <StructuredListWrapper isCondensed>
                  <StructuredListBody>
                    {latestLabs.map((l, i) => (
                      <StructuredListRow key={i}>
                        <StructuredListCell>
                          {l.display}
                          {l.interpretation === 'high' && <Tag size="sm" type="red" className="lab-flag">HIGH</Tag>}
                          {l.interpretation === 'low' && <Tag size="sm" type="blue" className="lab-flag">LOW</Tag>}
                        </StructuredListCell>
                        <StructuredListCell>
                          <strong>{l.value}</strong> {l.unit}
                          {l.referenceRange && (
                            <span className="ref-range"> (Ref: {l.referenceRange})</span>
                          )}
                        </StructuredListCell>
                      </StructuredListRow>
                    ))}
                  </StructuredListBody>
                </StructuredListWrapper>
              </>
            ) : (
              <div className="no-data">No lab results recorded</div>
            )}
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}
