import { useState, useEffect, useCallback } from 'react';
import {
  Grid,
  Column,
  Tile,
  ClickableTile,
  Tag,
  Button,
  DataTable,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  TableContainer,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
  InlineNotification,
} from '@carbon/react';
import {
  Activity,
  Hospital,
  Report,
  CloudMonitoring,
  Launch,
  ArrowRight,
  Renew,
} from '@carbon/icons-react';
import { SERVICES, filterServices } from '../services';

function StatTile({ icon: Icon, label, value, trend, trendDirection }) {
  return (
    <Tile className="stat-tile">
      <div className="stat-tile__header">
        <Icon size={20} className="stat-tile__icon" />
        <span className="stat-tile__label">{label}</span>
      </div>
      <div className="stat-tile__value">{value}</div>
      {trend && (
        <div className={`stat-tile__trend stat-tile__trend--${trendDirection}`}>
          {trendDirection === 'up' ? '↑' : '↓'} {trend}
        </div>
      )}
    </Tile>
  );
}

function ServiceCard({ service, status, onLaunch }) {
  const statusLabels = { checking: 'Checking…', up: 'Operational', down: 'Offline' };
  return (
    <ClickableTile className="service-card" onClick={onLaunch}>
      <div
        className="service-card__icon"
        style={{ background: service.bgColor, color: service.color }}
      >
        <Hospital size={28} />
      </div>
      <div className="service-card__name">{service.name}</div>
      <div className="service-card__desc">{service.desc}</div>
      <div className="service-card__footer">
        <span className="service-card__launch">
          Launch <ArrowRight size={14} />
        </span>
        <span className="service-card__status">
          <span className={`status-dot status-dot--${status}`} />
          {statusLabels[status] || 'Checking…'}
        </span>
      </div>
    </ClickableTile>
  );
}

// Audit log table
const auditHeaders = [
  { key: 'time', header: 'Time' },
  { key: 'user', header: 'User' },
  { key: 'type', header: 'Type' },
  { key: 'detail', header: 'Detail' },
];

export default function DashboardPage({ username, role, tags }) {
  const [statuses, setStatuses] = useState({});
  const [auditRows, setAuditRows] = useState([]);

  const visibleServices = filterServices(role, tags);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/system-status');
      const data = await res.json();
      setStatuses(data);
    } catch {
      // Fallback: show all as 'checking'
    }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const res = await fetch('/api/audit?limit=10');
      if (res.ok) {
        const data = await res.json();
        setAuditRows(
          (data.rows || data || []).map((r, i) => ({
            id: String(i),
            time: r.timestamp
              ? new Date(r.timestamp).toLocaleString()
              : '—',
            user: r.user || '—',
            type: r.type || '—',
            detail: r.detail || '—',
          }))
        );
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    checkHealth();
    loadAudit();
    const iv = setInterval(checkHealth, 30000);
    return () => clearInterval(iv);
  }, [checkHealth, loadAudit]);

  const launch = (svc) => {
    const launchUrl = svc.ssoId
      ? `/api/sso/launch/${svc.ssoId}?u=${encodeURIComponent(username)}`
      : svc.url;
    window.open(launchUrl, '_blank');
  };

  return (
    <div className="page-body">
      <div className="page-header">
        <div>
          <h1>Welcome back, {username}</h1>
          <p className="page-subtitle">
            Select a service to launch. All services share your session.
          </p>
        </div>
        <Button
          kind="ghost"
          renderIcon={Renew}
          onClick={checkHealth}
          size="sm"
        >
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <Grid className="stat-row" narrow>
        <Column lg={4} md={4} sm={4}>
          <StatTile icon={Activity} label="Active Services" value={visibleServices.length} />
        </Column>
        <Column lg={4} md={4} sm={4}>
          <StatTile
            icon={Hospital}
            label="Online"
            value={Object.values(statuses).filter((s) => s === 'up').length}
            trend={Object.values(statuses).length > 0 ? 'All monitored' : undefined}
            trendDirection="up"
          />
        </Column>
        <Column lg={4} md={4} sm={4}>
          <StatTile icon={Report} label="Audit Events" value={auditRows.length} />
        </Column>
        <Column lg={4} md={4} sm={4}>
          <StatTile
            icon={CloudMonitoring}
            label="SSO Version"
            value="V2"
            trend="Carbon Design"
            trendDirection="up"
          />
        </Column>
      </Grid>

      {/* Services */}
      <div className="services-section">
        <div className="section-title">
          <Launch size={18} />
          Clinical Services
        </div>
        <Grid narrow>
          {visibleServices.map((s) => (
            <Column key={s.id} lg={4} md={4} sm={4}>
              <ServiceCard
                service={s}
                status={statuses[s.id] || 'checking'}
                onLaunch={() => launch(s)}
              />
            </Column>
          ))}
        </Grid>
      </div>

      {/* Audit Log */}
      <div className="audit-section">
        <DataTable rows={auditRows} headers={auditHeaders}>
          {({
            rows,
            headers,
            getTableProps,
            getHeaderProps,
            getRowProps,
            onInputChange,
          }) => (
            <TableContainer title="Audit Log" description="Recent authentication events">
              <TableToolbar>
                <TableToolbarContent>
                  <TableToolbarSearch
                    onChange={onInputChange}
                    placeholder="Search audit log..."
                  />
                </TableToolbarContent>
              </TableToolbar>
              <Table {...getTableProps()} size="md">
                <TableHead>
                  <TableRow>
                    {headers.map((header) => (
                      <TableHeader {...getHeaderProps({ header })} key={header.key}>
                        {header.header}
                      </TableHeader>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={headers.length}>
                        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--cds-text-helper)' }}>
                          No audit events yet. Events will appear as users sign in.
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((row) => (
                      <TableRow {...getRowProps({ row })} key={row.id}>
                        {row.cells.map((cell) => (
                          <TableCell key={cell.id}>{cell.value}</TableCell>
                        ))}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </DataTable>
      </div>
    </div>
  );
}
