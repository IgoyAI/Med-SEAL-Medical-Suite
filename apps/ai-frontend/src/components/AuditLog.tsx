import { useState, useEffect, useCallback } from 'react';
import {
    DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell,
    TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch,
    Tag, Pagination,
} from '@carbon/react';

interface AuditEntry {
    id?: number;
    type: string;
    user: string;
    detail: string;
    time: string;
    ip?: string;
}

export default function AuditLog() {
    const [entries, setEntries] = useState<AuditEntry[]>([]);
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/audit');
            if (res.ok) {
                const data = await res.json();
                setEntries(Array.isArray(data) ? data : data.events || data.rows || []);
            }
        } catch { /* ignore */ }
    }, []);

    useEffect(() => { load(); const iv = setInterval(load, 15000); return () => clearInterval(iv); }, [load]);

    const filtered = entries.filter(e =>
        !search || [e.type, e.user, e.detail, e.time, e.ip].some(f => f?.toLowerCase().includes(search.toLowerCase()))
    );
    const start = (page - 1) * pageSize;
    const pageEntries = filtered.slice(start, start + pageSize);

    const typeTagType = (t: string) => {
        switch (t) {
            case 'login': return 'blue' as const;
            case 'logout': return 'warm-gray' as const;
            case 'launch': return 'green' as const;
            case 'user_create': return 'teal' as const;
            case 'user_update': return 'cyan' as const;
            case 'user_delete': return 'red' as const;
            case 'password_change': return 'purple' as const;
            case '2fa_enable': return 'green' as const;
            case '2fa_disable': return 'magenta' as const;
            default: return 'gray' as const;
        }
    };

    const headers = [
        { key: 'type', header: 'Event' },
        { key: 'user', header: 'User' },
        { key: 'detail', header: 'Detail' },
        { key: 'ip', header: 'IP Address' },
        { key: 'time', header: 'Time' },
    ];

    const rows = pageEntries.map((e, i) => ({
        id: String(e.id ?? `${page}-${i}`),
        type: e.type,
        user: e.user,
        detail: e.detail,
        ip: e.ip || '—',
        time: e.time ? new Date(e.time).toLocaleString() : '—',
    }));

    return (
        <div className="page-section">
            <div className="section-title">Access Log</div>
            <div className="table-panel">
            <DataTable rows={rows} headers={headers} isSortable>
                {({ rows: dtRows, headers: dtHeaders, getTableProps, getHeaderProps, getRowProps }) => (
                    <TableContainer>
                        <TableToolbar>
                            <TableToolbarContent>
                                <TableToolbarSearch
                                    placeholder="Search by event, user, detail, or IP..."
                                    onChange={(e: any) => { setSearch(e.target?.value || ''); setPage(1); }}
                                    persistent
                                />
                            </TableToolbarContent>
                        </TableToolbar>
                        <Table {...getTableProps()} size="md">
                            <TableHead>
                                <TableRow>
                                    {dtHeaders.map(h => (
                                        <TableHeader {...getHeaderProps({ header: h })} key={h.key}>{h.header}</TableHeader>
                                    ))}
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {dtRows.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={headers.length} style={{ textAlign: 'center', color: 'var(--cds-text-helper)', padding: '2rem' }}>
                                            No audit events recorded yet
                                        </TableCell>
                                    </TableRow>
                                ) : dtRows.map((row, i) => {
                                    const entry = pageEntries[i];
                                    if (!entry) return null;
                                    return (
                                        <TableRow {...getRowProps({ row })} key={row.id}>
                                            <TableCell>
                                                <Tag type={typeTagType(entry.type)} size="sm">{entry.type}</Tag>
                                            </TableCell>
                                            <TableCell>{entry.user}</TableCell>
                                            <TableCell>{entry.detail}</TableCell>
                                            <TableCell style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '0.75rem' }}>
                                                {entry.ip || '—'}
                                            </TableCell>
                                            <TableCell style={{ fontSize: '0.75rem' }}>
                                                {entry.time ? new Date(entry.time).toLocaleString() : '—'}
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                        {filtered.length > 0 && (
                            <Pagination
                                totalItems={filtered.length}
                                pageSize={pageSize}
                                pageSizes={[10, 25, 50]}
                                page={page}
                                onChange={({ page: p, pageSize: ps }) => { setPage(p); setPageSize(ps); }}
                            />
                        )}
                    </TableContainer>
                )}
            </DataTable>
            </div>
        </div>
    );
}
