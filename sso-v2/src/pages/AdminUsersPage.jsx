import { useState, useEffect, useCallback } from 'react';
import {
  Grid,
  Column,
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
  Tag,
  Modal,
  TextInput,
  PasswordInput,
  Select,
  SelectItem,
  Toggle,
  InlineNotification,
} from '@carbon/react';
import {
  Add,
  Edit,
  TrashCan,
  Unlocked,
  Password,
  Renew,
  UserAdmin,
} from '@carbon/icons-react';
import { ROLES, roleLabel } from '../services';

export default function AdminUsersPage() {
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(null); // 'create' | 'edit' | 'resetPwd' | null
  const [editing, setEditing] = useState(null);
  const [facilities, setFacilities] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [notification, setNotification] = useState(null);

  // Form state
  const [fUsername, setFUsername] = useState('');
  const [fDisplayName, setFDisplayName] = useState('');
  const [fEmail, setFEmail] = useState('');
  const [fPassword, setFPassword] = useState('');
  const [fRole, setFRole] = useState('clin');
  const [fStatus, setFStatus] = useState('active');
  const [fRadiologist, setFRadiologist] = useState(false);
  const [fFacilityId, setFFacilityId] = useState(0);

  const notify = (kind, title, subtitle) => {
    setNotification({ kind, title, subtitle });
    setTimeout(() => setNotification(null), 4000);
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/users');
      if (res.ok) setUsers(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch('/api/facilities').then((r) => r.json()).then(setFacilities).catch(() => {});
  }, []);

  const syncOpenEMR = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/admin/sync-openemr', { method: 'POST' });
      const data = await res.json();
      if (res.ok) notify('success', 'Synced', `${data.synced}/${data.total} users to OpenEMR`);
      else notify('error', 'Error', data.error || 'Sync failed');
    } catch { notify('error', 'Error', 'Network error during sync'); }
    setSyncing(false);
  };

  const openCreate = () => {
    setFUsername(''); setFDisplayName(''); setFEmail('');
    setFPassword(''); setFRole('clin'); setFRadiologist(false); setFFacilityId(0);
    setModal('create');
  };

  const openEdit = (u) => {
    setEditing(u); setFDisplayName(u.displayName);
    setFEmail(u.email); setFRole(u.role); setFStatus(u.status);
    setFRadiologist((u.tags || []).includes('radiologist'));
    setFFacilityId(u.facilityId || 0);
    setModal('edit');
  };

  const openResetPwd = (u) => {
    setEditing(u); setFPassword('');
    setModal('resetPwd');
  };

  const close = () => { setModal(null); setEditing(null); };

  const handleCreate = async () => {
    if (!fUsername || !fPassword) { notify('warning', 'Missing', 'Username and password required'); return; }
    const tags = fRadiologist ? ['radiologist'] : [];
    const res = await fetch('/api/admin/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: fUsername, displayName: fDisplayName || fUsername, email: fEmail, password: fPassword, role: fRole, tags, facilityId: fFacilityId }),
    });
    if (res.ok) { notify('success', 'Created', `User ${fUsername} created`); close(); load(); }
    else { const e = await res.json(); notify('error', 'Error', e.error); }
  };

  const handleEdit = async () => {
    if (!editing) return;
    const tags = fRadiologist ? ['radiologist'] : [];
    const res = await fetch(`/api/admin/users/${editing.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: fDisplayName, email: fEmail, role: fRole, status: fStatus, tags, facilityId: fFacilityId }),
    });
    if (res.ok) { notify('success', 'Updated', `User ${editing.username} updated`); close(); load(); }
    else { const e = await res.json(); notify('error', 'Error', e.error); }
  };

  const handleResetPwd = async () => {
    if (!editing || !fPassword) { notify('warning', 'Missing', 'Enter a new password'); return; }
    const res = await fetch(`/api/admin/users/${editing.id}/reset-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: fPassword }),
    });
    if (res.ok) { notify('success', 'Reset', `Password reset for ${editing.username}`); close(); }
    else { const e = await res.json(); notify('error', 'Error', e.error); }
  };

  const handleDelete = async (u) => {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
    if (res.ok) { notify('info', 'Deleted', `User ${u.username} deleted`); load(); }
    else { const e = await res.json(); notify('error', 'Error', e.error); }
  };

  const handleUnlock = async (u) => {
    const res = await fetch(`/api/admin/users/${u.id}/unlock`, { method: 'POST' });
    if (res.ok) { notify('success', 'Unlocked', `User ${u.username} unlocked`); load(); }
    else { const e = await res.json(); notify('error', 'Error', e.error); }
  };

  // Build table data
  const headers = [
    { key: 'user', header: 'User' },
    { key: 'email', header: 'Email' },
    { key: 'role', header: 'Role' },
    { key: 'dept', header: 'Department' },
    { key: 'status', header: 'Status' },
    { key: 'twofa', header: '2FA' },
    { key: 'lastLogin', header: 'Last Login' },
  ];

  const rows = users.map((u) => ({
    id: String(u.id),
    user: u.displayName || u.username,
    email: u.email || '—',
    role: u.role,
    dept: u.facilityId > 0
      ? (facilities.find((f) => f.id === u.facilityId)?.name || `#${u.facilityId}`)
      : '—',
    status: u.status,
    twofa: u.twoFAEnabled ? '✓' : '—',
    lastLogin: u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'Never',
    _raw: u,
  }));

  const roleTagType = (r) => {
    if (r === 'admin') return 'blue';
    if (r === 'doc') return 'green';
    if (r === 'breakglass') return 'red';
    return 'cool-gray';
  };

  const statusTagType = (s) => {
    if (s === 'active') return 'green';
    if (s === 'locked') return 'magenta';
    return 'red';
  };

  return (
    <div className="page-body">
      <div className="admin-header">
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 300, color: 'var(--cds-text-primary)', marginBottom: '0.25rem' }}>
            User Management
          </h1>
          <p className="page-subtitle">Create, edit, lock/unlock, and manage user accounts</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Button kind="secondary" renderIcon={Renew} onClick={syncOpenEMR} disabled={syncing} size="md">
            {syncing ? 'Syncing…' : 'Sync to OpenEMR'}
          </Button>
          <Button kind="primary" renderIcon={Add} onClick={openCreate} size="md">
            New User
          </Button>
        </div>
      </div>

      {notification && (
        <div style={{ marginBottom: '1rem' }}>
          <InlineNotification
            kind={notification.kind}
            title={notification.title}
            subtitle={notification.subtitle}
            lowContrast
            onClose={() => setNotification(null)}
          />
        </div>
      )}

      {/* Stats */}
      <div className="admin-stats">
        <div className="admin-stat">
          <span className="admin-stat__num">{users.length}</span>
          <span className="admin-stat__label">Total Users</span>
        </div>
        <div className="admin-stat">
          <span className="admin-stat__num">{users.filter((u) => u.status === 'active').length}</span>
          <span className="admin-stat__label">Active</span>
        </div>
        <div className="admin-stat">
          <span className="admin-stat__num">{users.filter((u) => u.status === 'locked').length}</span>
          <span className="admin-stat__label">Locked</span>
        </div>
        <div className="admin-stat">
          <span className="admin-stat__num">{users.filter((u) => u.role === 'admin').length}</span>
          <span className="admin-stat__label">Admins</span>
        </div>
        <div className="admin-stat">
          <span className="admin-stat__num">{users.filter((u) => u.role === 'doc').length}</span>
          <span className="admin-stat__label">Physicians</span>
        </div>
      </div>

      {/* Users Table */}
      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps, onInputChange }) => (
          <TableContainer>
            <TableToolbar>
              <TableToolbarContent>
                <TableToolbarSearch onChange={onInputChange} placeholder="Search users..." />
              </TableToolbarContent>
            </TableToolbar>
            <Table {...getTableProps()} size="md">
              <TableHead>
                <TableRow>
                  {tableHeaders.map((h) => (
                    <TableHeader {...getHeaderProps({ header: h })} key={h.key}>{h.header}</TableHeader>
                  ))}
                  <TableHeader>Actions</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map((row) => {
                  const rawUser = users.find((u) => String(u.id) === row.id);
                  return (
                    <TableRow {...getRowProps({ row })} key={row.id}>
                      {row.cells.map((cell) => (
                        <TableCell key={cell.id}>
                          {cell.info.header === 'user' && rawUser ? (
                            <div className="admin-user-cell">
                              <div className="admin-user-avatar">{rawUser.username.charAt(0).toUpperCase()}</div>
                              <div>
                                <div className="admin-user-name">{rawUser.displayName}</div>
                                <div className="admin-user-uname">@{rawUser.username}</div>
                              </div>
                            </div>
                          ) : cell.info.header === 'role' ? (
                            <Tag type={roleTagType(cell.value)} size="sm">{roleLabel(cell.value)}</Tag>
                          ) : cell.info.header === 'status' ? (
                            <Tag type={statusTagType(cell.value)} size="sm">{cell.value}</Tag>
                          ) : cell.value}
                        </TableCell>
                      ))}
                      <TableCell>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <Button kind="ghost" size="sm" hasIconOnly renderIcon={Edit} iconDescription="Edit" onClick={() => rawUser && openEdit(rawUser)} />
                          <Button kind="ghost" size="sm" hasIconOnly renderIcon={Password} iconDescription="Reset Password" onClick={() => rawUser && openResetPwd(rawUser)} />
                          {rawUser?.status === 'locked' && (
                            <Button kind="ghost" size="sm" hasIconOnly renderIcon={Unlocked} iconDescription="Unlock" onClick={() => handleUnlock(rawUser)} />
                          )}
                          {rawUser?.username !== 'admin' && (
                            <Button kind="danger--ghost" size="sm" hasIconOnly renderIcon={TrashCan} iconDescription="Delete" onClick={() => rawUser && handleDelete(rawUser)} />
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DataTable>

      {/* ── Modals ── */}
      <Modal
        open={modal === 'create'}
        onRequestClose={close}
        onRequestSubmit={handleCreate}
        modalHeading="Create New User"
        modalLabel="User Management"
        primaryButtonText="Create User"
        secondaryButtonText="Cancel"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.5rem 0' }}>
          <TextInput id="mu-username" labelText="Username *" value={fUsername} onChange={(e) => setFUsername(e.target.value)} placeholder="e.g. dr.smith" />
          <Grid narrow>
            <Column lg={8} md={4} sm={4}>
              <TextInput id="mu-display" labelText="Display Name" value={fDisplayName} onChange={(e) => setFDisplayName(e.target.value)} />
            </Column>
            <Column lg={8} md={4} sm={4}>
              <TextInput id="mu-email" labelText="Email" value={fEmail} onChange={(e) => setFEmail(e.target.value)} />
            </Column>
          </Grid>
          <Grid narrow>
            <Column lg={8} md={4} sm={4}>
              <PasswordInput id="mu-pwd" labelText="Password *" value={fPassword} onChange={(e) => setFPassword(e.target.value)} />
            </Column>
            <Column lg={8} md={4} sm={4}>
              <Select id="mu-role" labelText="Role" value={fRole} onChange={(e) => setFRole(e.target.value)}>
                {ROLES.map((r) => <SelectItem key={r.value} value={r.value} text={r.label} />)}
              </Select>
            </Column>
          </Grid>
          <Grid narrow>
            <Column lg={8} md={4} sm={4}>
              <Select id="mu-dept" labelText="Department" value={fFacilityId} onChange={(e) => setFFacilityId(parseInt(e.target.value))}>
                <SelectItem value={0} text="— None —" />
                {facilities.map((f) => <SelectItem key={f.id} value={f.id} text={f.name} />)}
              </Select>
            </Column>
            <Column lg={8} md={4} sm={4} style={{ display: 'flex', alignItems: 'flex-end' }}>
              <Toggle id="mu-rad" labelText="Radiologist Tag" labelA="No" labelB="Yes" toggled={fRadiologist} onToggle={() => setFRadiologist(!fRadiologist)} />
            </Column>
          </Grid>
        </div>
      </Modal>

      <Modal
        open={modal === 'edit'}
        onRequestClose={close}
        onRequestSubmit={handleEdit}
        modalHeading={`Edit ${editing?.username || ''}`}
        modalLabel="User Management"
        primaryButtonText="Save Changes"
        secondaryButtonText="Cancel"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.5rem 0' }}>
          <Grid narrow>
            <Column lg={8} md={4} sm={4}>
              <TextInput id="eu-display" labelText="Display Name" value={fDisplayName} onChange={(e) => setFDisplayName(e.target.value)} />
            </Column>
            <Column lg={8} md={4} sm={4}>
              <TextInput id="eu-email" labelText="Email" value={fEmail} onChange={(e) => setFEmail(e.target.value)} />
            </Column>
          </Grid>
          <Grid narrow>
            <Column lg={8} md={4} sm={4}>
              <Select id="eu-role" labelText="Role" value={fRole} onChange={(e) => setFRole(e.target.value)}>
                {ROLES.map((r) => <SelectItem key={r.value} value={r.value} text={r.label} />)}
              </Select>
            </Column>
            <Column lg={8} md={4} sm={4}>
              <Select id="eu-status" labelText="Status" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                <SelectItem value="active" text="Active" />
                <SelectItem value="locked" text="Locked" />
                <SelectItem value="disabled" text="Disabled" />
              </Select>
            </Column>
          </Grid>
          <Grid narrow>
            <Column lg={8} md={4} sm={4}>
              <Select id="eu-dept" labelText="Department" value={fFacilityId} onChange={(e) => setFFacilityId(parseInt(e.target.value))}>
                <SelectItem value={0} text="— None —" />
                {facilities.map((f) => <SelectItem key={f.id} value={f.id} text={f.name} />)}
              </Select>
            </Column>
            <Column lg={8} md={4} sm={4} style={{ display: 'flex', alignItems: 'flex-end' }}>
              <Toggle id="eu-rad" labelText="Radiologist Tag" labelA="No" labelB="Yes" toggled={fRadiologist} onToggle={() => setFRadiologist(!fRadiologist)} />
            </Column>
          </Grid>
        </div>
      </Modal>

      <Modal
        open={modal === 'resetPwd'}
        onRequestClose={close}
        onRequestSubmit={handleResetPwd}
        modalHeading={`Reset Password — ${editing?.username || ''}`}
        modalLabel="User Management"
        primaryButtonText="Reset Password"
        secondaryButtonText="Cancel"
        danger
      >
        <div style={{ padding: '0.5rem 0' }}>
          <PasswordInput
            id="rp-pwd"
            labelText="New Password"
            placeholder="Enter new password (min 4 chars)"
            value={fPassword}
            onChange={(e) => setFPassword(e.target.value)}
          />
        </div>
      </Modal>
    </div>
  );
}
