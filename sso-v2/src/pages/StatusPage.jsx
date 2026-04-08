import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Button,
  Tag,
  Tile,
} from '@carbon/react';
import {
  CheckmarkFilled,
  WarningFilled,
  Renew,
} from '@carbon/icons-react';
import { SERVICES } from '../services';

export default function StatusPage() {
  const [statuses, setStatuses] = useState({});
  const [lastChecked, setLastChecked] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Generate fake 30-day uptime bars
  const uptimeBars = useMemo(() => {
    return SERVICES.reduce((acc, s) => {
      acc[s.id] = Array.from({ length: 30 }, () => {
        const r = Math.random();
        return r > 0.05 ? 'up' : r > 0.02 ? 'degraded' : 'down';
      });
      return acc;
    }, {});
  }, []);

  const checkAll = useCallback(async () => {
    setRefreshing(true);
    const newStatuses = {};
    for (const s of SERVICES) {
      try {
        await fetch(s.healthUrl, { mode: 'no-cors', cache: 'no-cache' });
        newStatuses[s.id] = 'operational';
      } catch {
        newStatuses[s.id] = 'down';
      }
    }
    setStatuses(newStatuses);
    setLastChecked(new Date());
    setRefreshing(false);
  }, []);

  useEffect(() => {
    checkAll();
    const iv = setInterval(checkAll, 30000);
    return () => clearInterval(iv);
  }, [checkAll]);

  const allOk = Object.values(statuses).every((s) => s === 'operational');
  const hasChecked = Object.values(statuses).length > 0;

  const uptimePercent = (id) => {
    const bars = uptimeBars[id] || [];
    const up = bars.filter((b) => b === 'up').length;
    return bars.length ? ((up / bars.length) * 100).toFixed(1) : '—';
  };

  const statusLabel = (s) => {
    switch (s) {
      case 'operational': return 'Operational';
      case 'degraded': return 'Degraded';
      case 'down': return 'Major Outage';
      default: return 'Checking…';
    }
  };

  const statusTagType = (s) => {
    switch (s) {
      case 'operational': return 'green';
      case 'degraded': return 'magenta';
      case 'down': return 'red';
      default: return 'cool-gray';
    }
  };

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <h1>System Status</h1>
          <p className="page-subtitle">Real-time health monitoring for all Med-SEAL services</p>
        </div>
        <Button
          kind="ghost"
          renderIcon={Renew}
          onClick={checkAll}
          disabled={refreshing}
          size="sm"
          className={refreshing ? 'spin' : ''}
        >
          Refresh
        </Button>
      </div>

      {/* Overall banner */}
      <div className={`status-banner ${hasChecked ? (allOk ? 'status-banner--ok' : 'status-banner--issues') : ''}`}>
        {allOk ? <CheckmarkFilled size={24} /> : <WarningFilled size={24} />}
        <div>
          <div className="status-banner__text">
            {!hasChecked ? 'Checking services…' : allOk ? 'All Systems Operational' : 'Some Systems Experiencing Issues'}
          </div>
          <div className="status-banner__sub">
            {lastChecked ? `Last checked: ${lastChecked.toLocaleTimeString()}` : 'Initializing…'}
          </div>
        </div>
      </div>

      {/* Service rows */}
      <div className="section-title" style={{ marginBottom: '1rem' }}>Current Status</div>
      {SERVICES.map((s) => {
        const st = statuses[s.id] || 'checking';
        return (
          <div key={s.id} className="status-row">
            <div className="status-row__left">
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: s.bgColor,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: s.color,
                  fontWeight: 700,
                  fontSize: '0.75rem',
                }}
              >
                {s.name.charAt(0)}
              </div>
              {s.name}
            </div>
            <div className="status-row__right">
              <div className="uptime-bar">
                {(uptimeBars[s.id] || []).map((bar, i) => (
                  <div
                    key={i}
                    className={`uptime-bar__segment uptime-bar__segment--${bar}`}
                    style={{ height: bar === 'up' ? '100%' : bar === 'degraded' ? '60%' : '30%' }}
                    title={`Day ${i + 1}: ${bar}`}
                  />
                ))}
              </div>
              <span className="uptime-pct">{uptimePercent(s.id)}%</span>
              <Tag type={statusTagType(st)} size="sm">{statusLabel(st)}</Tag>
            </div>
          </div>
        );
      })}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1.5rem', fontSize: '0.75rem', color: 'var(--cds-text-helper)' }}>
        <span>Uptime over the past 30 days</span>
      </div>
    </div>
  );
}
