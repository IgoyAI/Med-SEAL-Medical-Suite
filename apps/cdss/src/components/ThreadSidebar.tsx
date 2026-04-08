import { useState } from 'react';
import { Button, Search, OverflowMenu, OverflowMenuItem, SkeletonText } from '@carbon/react';
import { Add, Chat } from '@carbon/icons-react';
import type { Thread } from '../types';

interface Props {
  threads: Thread[];
  activeThreadId: number | null;
  collapsed: boolean;
  loading?: boolean;
  onSelect: (id: number) => void;
  onCreate: () => void;
  onRename: (id: number, title: string) => void;
}

function groupByDate(threads: Thread[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const week = new Date(today.getTime() - 7 * 86400000);
  const month = new Date(today.getTime() - 30 * 86400000);

  const groups: { label: string; items: Thread[] }[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Previous 30 days', items: [] },
    { label: 'Older', items: [] },
  ];

  for (const t of threads) {
    const d = new Date(t.updated_at);
    if (d >= today) groups[0].items.push(t);
    else if (d >= yesterday) groups[1].items.push(t);
    else if (d >= week) groups[2].items.push(t);
    else if (d >= month) groups[3].items.push(t);
    else groups[4].items.push(t);
  }

  return groups.filter((g) => g.items.length > 0);
}

export default function ThreadSidebar({
  threads,
  activeThreadId,
  collapsed,
  loading,
  onSelect,
  onCreate,
  onRename,
}: Props) {
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const filtered = threads.filter(
    (t) =>
      t.title.toLowerCase().includes(search.toLowerCase()) ||
      t.patient_name?.toLowerCase().includes(search.toLowerCase()),
  );

  const groups = search ? [{ label: 'Results', items: filtered }] : groupByDate(filtered);

  const startRename = (t: Thread) => {
    setEditingId(t.id);
    setEditTitle(t.title);
  };

  const commitRename = () => {
    if (editingId && editTitle.trim()) {
      onRename(editingId, editTitle.trim());
    }
    setEditingId(null);
  };

  return (
    <div className={`thread-sidebar ${collapsed ? 'thread-sidebar--collapsed' : ''}`}>
      <div className="thread-sidebar__header">
        {collapsed ? (
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Add}
            iconDescription="New chat"
            hasIconOnly
            onClick={onCreate}
          />
        ) : (
          <Button
            kind="primary"
            size="sm"
            renderIcon={Add}
            onClick={onCreate}
            className="thread-sidebar__new"
          >
            New Chat
          </Button>
        )}
      </div>

      {!collapsed && (
        <div className="thread-sidebar__search">
          <Search
            size="sm"
            labelText="Search conversations"
            placeholder="Search conversations..."
            value={search}
            onChange={(e: any) => setSearch(e.target.value)}
            closeButtonLabelText="Clear"
          />
        </div>
      )}

      <div className="thread-sidebar__list">
        {loading ? (
          !collapsed && (
            <div className="thread-sidebar__skeleton">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="thread-skeleton-item">
                  <SkeletonText width="80%" />
                  <SkeletonText width="50%" />
                </div>
              ))}
            </div>
          )
        ) : collapsed ? (
          threads.slice(0, 15).map((thread) => (
            <button
              key={thread.id}
              className={`thread-icon-btn ${thread.id === activeThreadId ? 'thread-icon-btn--active' : ''}`}
              onClick={() => onSelect(thread.id)}
              title={thread.title}
            >
              <Chat size={16} />
            </button>
          ))
        ) : filtered.length === 0 ? (
          <div className="thread-sidebar__empty">
            {threads.length === 0 ? 'No conversations yet' : 'No matches found'}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="thread-group">
              <div className="thread-group__label">{group.label}</div>
              {group.items.map((thread) => (
                <div
                  key={thread.id}
                  className={`thread-item ${thread.id === activeThreadId ? 'thread-item--active' : ''}`}
                  onClick={() => onSelect(thread.id)}
                >
                  <div className="thread-item__icon">
                    <Chat size={16} />
                  </div>
                  <div className="thread-item__content">
                    {editingId === thread.id ? (
                      <input
                        className="thread-item__edit"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename();
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <>
                        <span className="thread-item__title">{thread.title}</span>
                        {thread.patient_name && (
                          <span className="thread-item__patient">{thread.patient_name}</span>
                        )}
                      </>
                    )}
                  </div>
                  <div className="thread-item__actions" onClick={(e) => e.stopPropagation()}>
                    <OverflowMenu size="sm" flipped>
                      <OverflowMenuItem itemText="Rename" onClick={() => startRename(thread)} />
                    </OverflowMenu>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
