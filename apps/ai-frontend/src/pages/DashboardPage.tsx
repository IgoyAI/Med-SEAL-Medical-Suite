import { useState, useEffect, useCallback } from 'react';
import { SERVICES, filterServices } from '../services';
import ServiceTile from '../components/ServiceTile';
import AuditLog from '../components/AuditLog';
import { useToast } from '../components/Toast';
import { Tile, Button } from '@carbon/react';
import { Activity, Hospital, Report, Time, Renew } from '@carbon/icons-react';

interface Props {
    username: string;
    role: string;
    tags: string[];
}

export default function DashboardPage({ username, role, tags }: Props) {
    const [statuses, setStatuses] = useState<Record<string, 'checking' | 'up' | 'down'>>({});
    const [auditCount, setAuditCount] = useState(0);
    const [lastLogin, setLastLogin] = useState('');
    const { showToast } = useToast();

    const visibleServices = filterServices(role, tags);

    const checkHealth = useCallback(async () => {
        try {
            const res = await fetch('/api/system-status');
            const data = await res.json();
            setStatuses(data);
        } catch {
            console.error('Failed to get system status');
        }
    }, []);

    const loadAuditCount = useCallback(async () => {
        try {
            const res = await fetch('/api/audit');
            if (res.ok) {
                const data = await res.json();
                const entries = Array.isArray(data) ? data : data.events || [];
                setAuditCount(entries.length);
                if (entries.length > 0 && entries[0].time) {
                    setLastLogin(new Date(entries[0].time).toLocaleString());
                }
            }
        } catch { /* ignore */ }
    }, []);

    useEffect(() => {
        checkHealth();
        loadAuditCount();
        const iv = setInterval(checkHealth, 30000);
        return () => clearInterval(iv);
    }, [checkHealth, loadAuditCount]);

    const launch = (svc: typeof SERVICES[0]) => {
        const launchUrl = svc.ssoId
            ? `/api/sso/launch/${svc.ssoId}?u=${encodeURIComponent(username)}`
            : svc.url;
        window.open(launchUrl, '_blank');
        showToast('info', `Launching ${svc.name}...`);
    };

    const onlineCount = Object.values(statuses).filter(s => s === 'up').length;
    const totalServices = Object.keys(statuses).length || SERVICES.length;

    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">
                        Welcome back, <span className="accent">{username}</span>
                    </h1>
                    <p className="page-subtitle">Select a service to launch. All services share your session.</p>
                </div>
                <Button kind="ghost" size="sm" renderIcon={Renew} onClick={checkHealth}>
                    Refresh
                </Button>
            </div>

            {/* Stat tiles */}
            <div className="page-section animate-in">
                <div className="stat-grid">
                    <Tile className="stat-tile">
                        <div className="stat-tile__header">
                            <Hospital size={16} className="stat-tile__icon" />
                            <span className="stat-tile__label">Active Services</span>
                        </div>
                        <div className="stat-tile__value">{visibleServices.length}</div>
                        <div className="stat-tile__detail">Available to your role</div>
                    </Tile>
                    <Tile className="stat-tile">
                        <div className="stat-tile__header">
                            <Activity size={16} className="stat-tile__icon" />
                            <span className="stat-tile__label">Online</span>
                        </div>
                        <div className="stat-tile__value">{onlineCount}/{totalServices}</div>
                        <div className="stat-tile__detail">Systems operational</div>
                    </Tile>
                    <Tile className="stat-tile">
                        <div className="stat-tile__header">
                            <Report size={16} className="stat-tile__icon" />
                            <span className="stat-tile__label">Audit Events</span>
                        </div>
                        <div className="stat-tile__value">{auditCount}</div>
                        <div className="stat-tile__detail">Recent log entries</div>
                    </Tile>
                    <Tile className="stat-tile">
                        <div className="stat-tile__header">
                            <Time size={16} className="stat-tile__icon" />
                            <span className="stat-tile__label">Last Activity</span>
                        </div>
                        <div className="stat-tile__value" style={{ fontSize: '1rem', fontWeight: 400 }}>
                            {lastLogin || '—'}
                        </div>
                        <div className="stat-tile__detail">Most recent audit event</div>
                    </Tile>
                </div>
            </div>

            {/* Service cards */}
            <div className="page-section animate-in-delay-1">
                <div className="section-title"><Hospital size={16} /> Clinical Applications</div>
                <div className="service-grid">
                    {visibleServices.map(s => (
                        <ServiceTile
                            key={s.id}
                            service={s}
                            status={statuses[s.id] || 'checking'}
                            onLaunch={() => launch(s)}
                        />
                    ))}
                </div>
            </div>

            <div className="animate-in-delay-2">
                <AuditLog />
            </div>
        </>
    );
}
