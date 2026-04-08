import { useState, useEffect, useCallback } from 'react';
import { Button, Tag } from '@carbon/react';
import { CheckmarkFilled, WarningFilled, Renew, Hospital } from '@carbon/icons-react';

type Status = 'operational' | 'down' | 'checking';

// All monitored services (shown regardless of user role — status is informational)
const STATUS_SERVICES = [
    { id: 'openemr', name: 'OpenEMR', desc: 'Clinical EMR', color: '#297cbb', bgColor: '#e8f4fd' },
    { id: 'medplum', name: 'Medplum FHIR', desc: 'FHIR R4 Server', color: '#30a46c', bgColor: '#eff8f4' },
    { id: 'orthanc', name: 'Orthanc PACS', desc: 'DICOM Storage', color: '#ca8a04', bgColor: '#fef9c3' },
    { id: 'ohif', name: 'OHIF Viewer', desc: 'Radiology Viewer', color: '#5b21b6', bgColor: '#ede9fe' },
    { id: 'langfuse', name: 'Langfuse', desc: 'LLM Observability', color: '#e11d48', bgColor: '#fef2f2' },
];

export default function StatusPage() {
    const [statuses, setStatuses] = useState<Record<string, Status>>({});
    const [lastChecked, setLastChecked] = useState<Date | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    const checkAll = useCallback(async () => {
        setRefreshing(true);
        try {
            const res = await fetch('/api/system-status');
            if (res.ok) {
                const data = await res.json();
                const mapped: Record<string, Status> = {};
                for (const s of STATUS_SERVICES) {
                    const val = data[s.id];
                    mapped[s.id] = val === 'up' ? 'operational' : val === 'down' ? 'down' : 'checking';
                }
                setStatuses(mapped);
            }
        } catch {
            const fallback: Record<string, Status> = {};
            for (const s of STATUS_SERVICES) fallback[s.id] = 'down';
            setStatuses(fallback);
        }
        setLastChecked(new Date());
        setRefreshing(false);
    }, []);

    useEffect(() => {
        checkAll();
        const iv = setInterval(checkAll, 30000);
        return () => clearInterval(iv);
    }, [checkAll]);

    const allOk = Object.values(statuses).every(s => s === 'operational');
    const statusValues = Object.values(statuses);
    const hasChecked = statusValues.length > 0 && statusValues.every(s => s !== 'checking');

    const statusTag = (s: Status) => {
        switch (s) {
            case 'operational': return <Tag type="green" size="sm">Operational</Tag>;
            case 'down': return <Tag type="red" size="sm">Offline</Tag>;
            default: return <Tag type="gray" size="sm">Checking...</Tag>;
        }
    };

    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">System Status</h1>
                    <p className="page-subtitle">Real-time health monitoring for all Med-SEAL services</p>
                </div>
                <Button kind="ghost" size="sm" renderIcon={Renew} onClick={checkAll} disabled={refreshing}>
                    {refreshing ? 'Refreshing...' : 'Refresh'}
                </Button>
            </div>

            <div className={`status-banner animate-in ${hasChecked ? (allOk ? 'status-banner--ok' : 'status-banner--issues') : ''}`}>
                {allOk ? <CheckmarkFilled size={20} /> : <WarningFilled size={20} />}
                <div>
                    <div className="status-banner__text">
                        {!hasChecked ? 'Checking services...' : allOk ? 'All Systems Operational' : 'Some Systems Experiencing Issues'}
                    </div>
                    <div className="status-banner__sub">
                        {lastChecked ? `Last checked: ${lastChecked.toLocaleTimeString()}` : 'Initializing...'}
                    </div>
                </div>
            </div>

            <div className="section-title animate-in-delay-1">Current Status</div>
            {STATUS_SERVICES.map((s, i) => {
                const st = statuses[s.id] || 'checking';
                return (
                    <div key={s.id} className={`status-row animate-in-delay-${Math.min(i + 1, 3)}`}>
                        <div className="status-row__left">
                            <div
                                style={{
                                    width: 32, height: 32, borderRadius: 8,
                                    background: s.bgColor, color: s.color,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontWeight: 700, fontSize: '0.75rem',
                                }}
                            >
                                {s.name.charAt(0)}
                            </div>
                            <div>
                                <div>{s.name}</div>
                                <div style={{ fontSize: '0.6875rem', color: 'var(--cds-text-secondary)' }}>{s.desc}</div>
                            </div>
                        </div>
                        <div className="status-row__right">
                            {statusTag(st)}
                        </div>
                    </div>
                );
            })}

            <div className="status-footer">
                <span>Auto-refreshes every 30 seconds</span>
            </div>
        </>
    );
}
