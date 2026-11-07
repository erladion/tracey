// The list of requirements or test cases, with search and filters.
import { useMemo, useState, type KeyboardEvent } from 'react';
import type { Kind } from '../../../core/config';
import { linksOf, type Item } from '../../../core/model';
import type { Project } from '../project';
import { Icon } from '../icons';
import { StatusPill, VariantTag } from './bits';
import { matchesSearch } from '../../../core/fields';

interface Props {
  project: Project;
  kind: Kind;
  onKind: (k: Kind) => void;
  selected: string | null;
  onSelect: (path: string) => void;
  onNew: () => void;
}

export function Sidebar({ project, kind, onKind, selected, onSelect, onNew }: Props) {
  const { index } = project;
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [component, setComponent] = useState('');

  const counts = useMemo(
    () => ({
      requirement: index.items.filter((i) => i.kind === 'requirement').length,
      testcase: index.items.filter((i) => i.kind === 'testcase').length,
    }),
    [index],
  );

  const statuses = kind === 'requirement' ? index.config.statuses : index.config.testcaseStatuses;
  const components = useMemo(() => {
    const keys = new Set([...index.config.components.map((c) => c.key), ...index.items.flatMap((i) => i.components)]);
    return [...keys].sort();
  }, [index]);

  const items = useMemo(() => {
    const q = query.trim();
    return index.items.filter(
      (i) =>
        i.kind === kind &&
        (!status || i.status === status) &&
        (!component || i.components.includes(component)) &&
        matchesSearch(i, q),
    );
  }, [index, kind, query, status, component]);

  const move = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = items.findIndex((it) => it.path === selected);
    const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      onSelect(next.path);
      document.getElementById(`row-${next.path}`)?.focus();
    }
  };

  return (
    <aside className="sidebar" aria-label="Items">
      <div className="segmented" role="tablist">
        {(['requirement', 'testcase'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => onKind(k)}>
            {k === 'requirement' ? 'Requirements' : 'Test cases'} <span className="count">{counts[k]}</span>
          </button>
        ))}
      </div>
      <div className="search">
        <Icon name="search" />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search, or field:value" aria-label="Search" title="Words are searched in the ID, title, text and every field. field:value searches one field, like priority:high." />
      </div>
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {statuses.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={component} onChange={(e) => setComponent(e.target.value)} aria-label="Component">
          <option value="">Any component</option>
          {components.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <ul className="item-list" onKeyDown={move}>
        {items.map((it) => (
          <li key={it.path}>
            <button
              type="button"
              id={`row-${it.path}`}
              className={`item-row${it.path === selected ? ' selected' : ''}${it.status === 'obsolete' ? ' obsolete' : ''}`}
              onClick={() => onSelect(it.path)}
              aria-current={it.path === selected ? 'true' : undefined}
            >
              <span className="item-row-top">
                <span className="item-id">{it.id}</span>
                <RowBadge project={project} item={it} />
              </span>
              <span className="item-title">{it.title || <em className="muted">Untitled</em>}</span>
              <span className="item-row-bottom">
                <StatusPill status={it.status} />
                <VariantTag variants={it.variants} config={index.config} />
                {it.kind === 'testcase' && it.verifies.length > 0 && <span className="muted small mono">→ {it.verifies.join(', ')}</span>}
              </span>
            </button>
          </li>
        ))}
        {items.length === 0 && !project.loading && <li className="muted list-empty">Nothing matches.</li>}
      </ul>
      <button type="button" className="button sidebar-new" onClick={onNew}>
        <Icon name="plus" /> New {kind === 'requirement' ? 'requirement' : 'test case'}
      </button>
    </aside>
  );
}

function RowBadge({ project, item }: { project: Project; item: Item }) {
  const links = linksOf(project.index, item);
  if (links.some((l) => l.state === 'suspect'))
    return (
      <span className="row-badge warn" title="A linked requirement changed since review">
        <Icon name="warn" size={13} /> suspect
      </span>
    );
  if (item.kind === 'requirement') {
    if (item.status === 'obsolete') return null;
    return links.length ? (
      <span className="row-badge" title={`${links.length} test case${links.length === 1 ? '' : 's'}`}>
        {links.length} test{links.length === 1 ? '' : 's'}
      </span>
    ) : (
      <span className="row-badge gap" title="No test case verifies this requirement">
        no tests
      </span>
    );
  }
  return item.verifies.length ? null : <span className="row-badge gap">verifies nothing</span>;
}
