import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../components/Toast';
import {
    Button, Modal, TextInput, PasswordInput, Select, SelectItem, Tag, Toggle,
    DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell,
    TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch,
} from '@carbon/react';
import { Add, Edit, TrashCan, Unlocked, Password, Renew, Security, WarningAlt } from '@carbon/icons-react';

const ROLES = [
    { value: 'admin', label: 'Administrators' },
    { value: 'doc', label: 'Physicians' },
    { value: 'clin', label: 'Clinicians' },
    { value: 'front', label: 'Front Office' },
    { value: 'back', label: 'Accounting' },
    { value: 'breakglass', label: 'Emergency Login' },
] as const;

const roleLabel = (v: string) => ROLES.find(r => r.value === v)?.label || v;

interface User {
    id: number; username: string; displayName: string; email: string;
    role: string; status: string; tags: string[]; facilityId: number;
    twoFAEnabled: boolean; failedAttempts: number; lastLogin: string | null; createdAt: string;
}

interface Facility { id: number; name: string; }

type ModalType = 'create' | 'edit' | 'resetPwd' | 'confirmDelete' | null;

export default function AdminUsersPage() {
    const { showToast } = useToast();
    const [users, setUsers] = useState<User[]>([]);
    const [modal, setModal] = useState<ModalType>(null);
    const [editing, setEditing] = useState<User | null>(null);

    const [fUsername, setFUsername] = useState('');
    const [fDisplayName, setFDisplayName] = useState('');
    const [fEmail, setFEmail] = useState('');
    const [fPassword, setFPassword] = useState('');
    const [fRole, setFRole] = useState('clin');
    const [fStatus, setFStatus] = useState('active');
    const [fRadiologist, setFRadiologist] = useState(false);
    const [fFacilityId, setFFacilityId] = useState(0);
    const [facilities, setFacilities] = useState<Facility[]>([]);
    const [syncing, setSyncing] = useState(false);

    const syncOpenEMR = async () => {
        setSyncing(true);
        try {
            const res = await fetch('/api/admin/sync-openemr', { method: 'POST' });
            const data = await res.json();
            if (res.ok) showToast('success', `Synced ${data.synced}/${data.total} users to OpenEMR`);
            else showToast('error', data.error || 'Sync failed');
        } catch { showToast('error', 'Network error during sync'); }
        setSyncing(false);
    };

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/admin/users');
            if (res.ok) setUsers(await res.json());
        } catch { /* ignore */ }
    }, []);

    useEffect(() => { load(); }, [load]);
    useEffect(() => { fetch('/api/facilities').then(r => r.json()).then(setFacilities).catch(() => {}); }, []);

    const openCreate = () => {
        setFUsername(''); setFDisplayName(''); setFEmail('');
        setFPassword(''); setFRole('clin'); setFRadiologist(false); setFFacilityId(0);
        setModal('create');
    };
    const openEdit = (u: User) => {
        setEditing(u); setFDisplayName(u.displayName); setFEmail(u.email);
        setFRole(u.role); setFStatus(u.status);
        setFRadiologist((u.tags || []).includes('radiologist'));
        setFFacilityId(u.facilityId || 0);
        setModal('edit');
    };
    const openResetPwd = (u: User) => { setEditing(u); setFPassword(''); setModal('resetPwd'); };
    const openConfirmDelete = (u: User) => { setEditing(u); setModal('confirmDelete'); };
    const close = () => { setModal(null); setEditing(null); };

    const handleCreate = async () => {
        if (!fUsername || !fPassword) { showToast('warning', 'Username and password required'); return; }
        const tags = fRadiologist ? ['radiologist'] : [];
        const res = await fetch('/api/admin/users', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: fUsername, displayName: fDisplayName || fUsername, email: fEmail, password: fPassword, role: fRole, tags, facilityId: fFacilityId }),
        });
        if (res.ok) { showToast('success', `User ${fUsername} created`); close(); load(); }
        else { const e = await res.json(); showToast('error', e.error); }
    };

    const handleEdit = async () => {
        if (!editing) return;
        const tags = fRadiologist ? ['radiologist'] : [];
        const res = await fetch(`/api/admin/users/${editing.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayName: fDisplayName, email: fEmail, role: fRole, status: fStatus, tags, facilityId: fFacilityId }),
        });
        if (res.ok) { showToast('success', `User ${editing.username} updated`); close(); load(); }
        else { const e = await res.json(); showToast('error', e.error); }
    };

    const handleResetPwd = async () => {
        if (!editing || !fPassword) { showToast('warning', 'Enter a new password'); return; }
        const res = await fetch(`/api/admin/users/${editing.id}/reset-password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newPassword: fPassword }),
        });
        if (res.ok) { showToast('success', `Password reset for ${editing.username}`); close(); }
        else { const e = await res.json(); showToast('error', e.error); }
    };

    const handleDelete = async () => {
        if (!editing) return;
        const res = await fetch(`/api/admin/users/${editing.id}`, { method: 'DELETE' });
        if (res.ok) { showToast('info', `User ${editing.username} deleted`); close(); load(); }
        else { const e = await res.json(); showToast('error', e.error); }
    };

    const handleUnlock = async (u: User) => {
        const res = await fetch(`/api/admin/users/${u.id}/unlock`, { method: 'POST' });
        if (res.ok) { showToast('success', `User ${u.username} unlocked`); load(); }
        else { const e = await res.json(); showToast('error', e.error); }
    };

    const roleTagType = (r: string) => r === 'admin' ? 'blue' as const : r === 'doc' ? 'green' as const : r === 'breakglass' ? 'red' as const : 'gray' as const;
    const statusTagType = (s: string) => s === 'active' ? 'green' as const : s === 'locked' ? 'warm-gray' as const : 'red' as const;

    const headers = [
        { key: 'user', header: 'User' },
        { key: 'email', header: 'Email' },
        { key: 'role', header: 'Role' },
        { key: 'dept', header: 'Department' },
        { key: 'status', header: 'Status' },
        { key: 'twofa', header: '2FA' },
        { key: 'lastLogin', header: 'Last Login' },
        { key: 'actions', header: 'Actions' },
    ];

    const rows = users.map(u => ({ ...u, id: String(u.id) }));

    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">User Management</h1>
                    <p className="page-subtitle">Create, edit, lock/unlock, and manage user accounts</p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <Button kind="secondary" size="md" renderIcon={Renew} onClick={syncOpenEMR} disabled={syncing}>
                        {syncing ? 'Syncing...' : 'Sync to OpenEMR'}
                    </Button>
                    <Button kind="primary" size="md" renderIcon={Add} onClick={openCreate}>New User</Button>
                </div>
            </div>

            {/* Stats */}
            <div className="admin-stats">
                <div className="admin-stat"><span className="admin-stat__num">{users.length}</span><span className="admin-stat__label">Total Users</span></div>
                <div className="admin-stat"><span className="admin-stat__num">{users.filter(u => u.status === 'active').length}</span><span className="admin-stat__label">Active</span></div>
                <div className="admin-stat"><span className="admin-stat__num">{users.filter(u => u.status === 'locked').length}</span><span className="admin-stat__label">Locked</span></div>
                <div className="admin-stat"><span className="admin-stat__num">{users.filter(u => u.role === 'admin').length}</span><span className="admin-stat__label">Admins</span></div>
                <div className="admin-stat"><span className="admin-stat__num">{users.filter(u => u.role === 'doc').length}</span><span className="admin-stat__label">Physicians</span></div>
            </div>

            {/* Users table */}
            <div className="section-title">All Users</div>
            <div className="table-panel">
            <DataTable rows={rows} headers={headers} isSortable>
                {({ rows: dtRows, headers: dtHeaders, getTableProps, getHeaderProps, getRowProps, onInputChange }) => (
                    <TableContainer>
                        <TableToolbar>
                            <TableToolbarContent>
                                <TableToolbarSearch
                                    onChange={onInputChange}
                                    placeholder="Search users..."
                                    persistent
                                />
                            </TableToolbarContent>
                        </TableToolbar>
                        <Table {...getTableProps()}>
                            <TableHead>
                                <TableRow>
                                    {dtHeaders.map(h => (
                                        <TableHeader {...getHeaderProps({ header: h })} key={h.key}>{h.header}</TableHeader>
                                    ))}
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {dtRows.map(row => {
                                    const u = users.find(u => String(u.id) === row.id)!;
                                    if (!u) return null;
                                    return (
                                        <TableRow {...getRowProps({ row })} key={row.id}>
                                            <TableCell>
                                                <div className="admin-user-cell">
                                                    <div className="admin-user-avatar">{u.username.charAt(0).toUpperCase()}</div>
                                                    <div>
                                                        <div className="admin-user-name">{u.displayName}</div>
                                                        <div className="admin-user-uname">@{u.username}</div>
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell>{u.email}</TableCell>
                                            <TableCell>
                                                <Tag type={roleTagType(u.role)} size="sm">
                                                    {u.role === 'admin' && <Security size={12} />} {roleLabel(u.role)}
                                                </Tag>
                                            </TableCell>
                                            <TableCell>
                                                {u.facilityId > 0
                                                    ? (facilities.find(f => f.id === u.facilityId)?.name || `#${u.facilityId}`)
                                                    : <span style={{ color: 'var(--cds-text-helper)' }}>-</span>}
                                            </TableCell>
                                            <TableCell>
                                                <Tag type={statusTagType(u.status)} size="sm">
                                                    {u.status === 'locked' && <WarningAlt size={12} />} {u.status}
                                                </Tag>
                                            </TableCell>
                                            <TableCell>{u.twoFAEnabled ? 'Yes' : '-'}</TableCell>
                                            <TableCell style={{ fontSize: '0.75rem' }}>
                                                {u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'Never'}
                                            </TableCell>
                                            <TableCell>
                                                <div className="admin-actions">
                                                    <Button kind="ghost" size="sm" hasIconOnly renderIcon={Edit}
                                                        iconDescription="Edit" onClick={() => openEdit(u)} />
                                                    <Button kind="ghost" size="sm" hasIconOnly renderIcon={Password}
                                                        iconDescription="Reset Password" onClick={() => openResetPwd(u)} />
                                                    {u.status === 'locked' && (
                                                        <Button kind="ghost" size="sm" hasIconOnly renderIcon={Unlocked}
                                                            iconDescription="Unlock" onClick={() => handleUnlock(u)} />
                                                    )}
                                                    {u.username !== 'admin' && (
                                                        <Button kind="danger--ghost" size="sm" hasIconOnly renderIcon={TrashCan}
                                                            iconDescription="Delete" onClick={() => openConfirmDelete(u)} />
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
            </div>

            {/* Create / Edit Modal */}
            <Modal
                open={modal === 'create' || modal === 'edit'}
                modalHeading={modal === 'create' ? 'Create New User' : `Edit ${editing?.username}`}
                primaryButtonText={modal === 'create' ? 'Create User' : 'Save Changes'}
                secondaryButtonText="Cancel"
                onRequestSubmit={modal === 'create' ? handleCreate : handleEdit}
                onRequestClose={close}
                size="md"
            >
                {modal === 'create' && (
                    <TextInput id="m-user" labelText="Username *" value={fUsername}
                        onChange={e => setFUsername(e.target.value)} placeholder="e.g. dr.smith"
                        required aria-required="true" style={{ marginBottom: '1rem' }} />
                )}
                <div className="profile-row">
                    <TextInput id="m-display" labelText="Display Name" value={fDisplayName}
                        onChange={e => setFDisplayName(e.target.value)} />
                    <TextInput id="m-email" labelText="Email" value={fEmail}
                        onChange={e => setFEmail(e.target.value)} />
                </div>
                {modal === 'create' && (
                    <div className="profile-row">
                        <PasswordInput id="m-pass" labelText="Password *" value={fPassword}
                            onChange={e => setFPassword(e.target.value)}
                            required aria-required="true" />
                        <Select id="m-role" labelText="Role" value={fRole} onChange={e => setFRole(e.target.value)}>
                            {ROLES.map(r => <SelectItem key={r.value} value={r.value} text={r.label} />)}
                        </Select>
                    </div>
                )}
                {modal === 'edit' && (
                    <div className="profile-row">
                        <Select id="m-role" labelText="Role" value={fRole} onChange={e => setFRole(e.target.value)}>
                            {ROLES.map(r => <SelectItem key={r.value} value={r.value} text={r.label} />)}
                        </Select>
                        <Select id="m-status" labelText="Status" value={fStatus} onChange={e => setFStatus(e.target.value)}>
                            <SelectItem value="active" text="Active" />
                            <SelectItem value="locked" text="Locked" />
                            <SelectItem value="disabled" text="Disabled" />
                        </Select>
                    </div>
                )}
                <div className="profile-row">
                    <Select id="m-dept" labelText="Department" value={String(fFacilityId)}
                        onChange={e => setFFacilityId(parseInt(e.target.value))}>
                        <SelectItem value="0" text="- None -" />
                        {facilities.map(f => <SelectItem key={f.id} value={String(f.id)} text={f.name} />)}
                    </Select>
                    <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 8 }}>
                        <Toggle id="m-rad" labelText="Radiologist" labelA="No" labelB="Yes"
                            toggled={fRadiologist} onToggle={checked => setFRadiologist(checked)} />
                    </div>
                </div>
            </Modal>

            {/* Reset Password Modal */}
            <Modal
                open={modal === 'resetPwd'}
                modalHeading={`Reset Password - ${editing?.username}`}
                primaryButtonText="Reset Password"
                secondaryButtonText="Cancel"
                onRequestSubmit={handleResetPwd}
                onRequestClose={close}
                size="sm"
            >
                <PasswordInput id="m-reset" labelText="New Password *" value={fPassword}
                    onChange={e => setFPassword(e.target.value)} placeholder="Enter new password (min 4 chars)"
                    required aria-required="true" />
            </Modal>

            {/* Confirm Delete Modal */}
            <Modal
                open={modal === 'confirmDelete'}
                modalHeading="Delete User"
                primaryButtonText="Delete"
                secondaryButtonText="Cancel"
                onRequestSubmit={handleDelete}
                onRequestClose={close}
                danger
                size="sm"
            >
                <p style={{ fontSize: '0.875rem', color: 'var(--cds-text-primary)' }}>
                    Are you sure you want to delete user <strong>"{editing?.username}"</strong>? This action cannot be undone.
                </p>
            </Modal>
        </>
    );
}
