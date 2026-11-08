// The list of requirements, test cases or another item type, with search and filters.
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { fieldsFor, isRunnable, statusesFor, typeWord, type Kind } from '../../../core/config';
import { checkRules, itemLinks, linksOf, verification, type Item } from '../../../core/model';
import type { Project } from '../project';
import { Icon } from '../icons';
import { ShowMore, StatusPill, useShown, VariantTag } from './bits';
import { listValue, matchesSearch } from '../../../core/fields';

const NONE = '\u0000none';

interface Props {
  project: Project;
  kind: Kind;
  onKind: (k: Kind) => void;
  selected: string | null;
  onSelect: (path: string) => void;
  onNew: () => void;
  picked: string[]; // several chosen to change at once
  onPick: (paths: string[]) => void;
}

export function Sidebar({ project, kind, onKind, selected, onSelect, onNew, picked, onPick }: Props) {
  const [picking, setPicking] = useState(false); // plain clicks pick, for touch screens
  const [anchor, setAnchor] = useState<string | null>(null);
  const { index } = project;
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [component, setComponent] = useState('');
  // Declared choice fields to filter on: key → value ('' any, NONE without one).
  const [byField, setByField] = useState<Record<string, string>>({});
  const how = useMemo(() => ({ ...verification(index), rules: ruleGaps(index) }), [index]);
  const choiceFields = useMemo(() => fieldsFor(index.config, kind).filter((f) => f.type === 'choice' || f.type === 'choices'), [index.config, kind]);

  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const i of index.items) out.set(i.kind, (out.get(i.kind) ?? 0) + 1);
    return out;
  }, [index]);
  // Requirements, test cases, then the declared types; and any type an item names that
  // trace.yml doesn't (so it can still be found).
  const tabs = [...index.config.types, ...[...counts.keys()].filter((k) => !index.config.types.some((t) => t.key === k)).map((k) => ({ key: k, plural: k }))];

  const statuses = statusesFor(index.config, kind);
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
        matchesSearch(i, q) &&
        choiceFields.every((f) => {
          const want = byField[f.key];
          if (!want) return true;
          const have = listValue(i.data[f.key]);
          return want === NONE ? !have.length : have.includes(want);
        }),
    );
  }, [index, kind, query, status, component, byField, choiceFields]);

  // A page of rows at a time; the selected one is always shown.
  const { shown, more } = useShown(
    items.length,
    300,
    `${kind}\u0000${query}\u0000${status}\u0000${component}\u0000${JSON.stringify(byField)}`,
    items.findIndex((i) => i.path === selected),
  );
  const pickedSet = new Set(picked);
  const many = picking || picked.length > 0;
  // Ctrl/⌘-click toggles one, Shift-click takes the range from the last one clicked.
  const click = (e: MouseEvent, path: string) => {
    const from = anchor ?? selected;
    if (e.shiftKey && from) {
      const a = items.findIndex((i) => i.path === from);
      const b = items.findIndex((i) => i.path === path);
      if (a >= 0 && b >= 0) {
        const range = items.slice(Math.min(a, b), Math.max(a, b) + 1).map((i) => i.path);
        onPick([...new Set([...picked, ...range])]);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey || many) {
      const start = picked.length ? picked : selected && selected !== path && !picking ? [selected] : [];
      const next = start.includes(path) ? start.filter((p) => p !== path) : [...start, path];
      onPick(next);
      setAnchor(path);
      return;
    }
    setAnchor(path);
    onSelect(path);
  };

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
      <div className={`segmented${tabs.length > 2 ? ' wrap kinds' : ''}`} role="tablist">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={kind === t.key} className={kind === t.key ? 'on' : ''} onClick={() => onKind(t.key)}>
            {t.plural} <span className="count">{counts.get(t.key) ?? 0}</span>
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
        {choiceFields.map((f) => (
          <select key={f.key} value={byField[f.key] ?? ''} onChange={(e) => setByField({ ...byField, [f.key]: e.target.value })} aria-label={`Filter by ${f.name.toLowerCase()}`} className={byField[f.key] ? 'on' : ''}>
            <option value="">Any {f.name.toLowerCase()}</option>
            {f.values.map((v) => (
              <option key={v} value={v}>
                {f.name}: {v}
              </option>
            ))}
            <option value={NONE}>No {f.name.toLowerCase()}</option>
          </select>
        ))}
      </div>
      <div className="pick-bar">
        {many ? (
          <>
            <span className="small">
              <span className="strong">{picked.length}</span> picked
            </span>
            <button type="button" className="link-button small" onClick={() => onPick([...new Set([...picked, ...items.map((i) => i.path)])])} disabled={items.every((i) => pickedSet.has(i.path))}>
              Pick all {items.length} shown
            </button>
            <span className="tool-spacer" />
            <button
              type="button"
              className="link-button small"
              onClick={() => {
                onPick([]);
                setPicking(false);
              }}
            >
              Done
            </button>
          </>
        ) : (
          <button type="button" className="link-button small" onClick={() => setPicking(true)} title="Or Ctrl-click (⌘ on a Mac) and Shift-click in the list">
            Change several at once…
          </button>
        )}
      </div>
      <ul className="item-list" onKeyDown={move}>
        {items.slice(0, shown).map((it) => (
          <li key={it.path}>
            <button
              type="button"
              id={`row-${it.path}`}
              className={`item-row${!many && it.path === selected ? ' selected' : ''}${pickedSet.has(it.path) ? ' picked' : ''}${many ? ' picking' : ''}${it.status === 'obsolete' ? ' obsolete' : ''}`}
              onClick={(e) => click(e, it.path)}
              aria-current={!many && it.path === selected ? 'true' : undefined}
              aria-pressed={many ? pickedSet.has(it.path) : undefined}
            >
              {many && (
                <span className="pick-box" aria-hidden="true">
                  {pickedSet.has(it.path) && <Icon name="check" size={12} />}
                </span>
              )}
              <span className="item-row-top">
                <span className="item-id">{it.id}</span>
                <RowBadge project={project} item={it} how={how} />
              </span>
              <span className="item-title">{it.title || <em className="muted">Untitled</em>}</span>
              <span className="item-row-bottom">
                <StatusPill status={it.status} />
                <VariantTag variants={it.variants} config={index.config} />
                {it.verifies.length > 0 && <span className="muted small mono">→ {it.verifies.join(', ')}</span>}
              </span>
            </button>
          </li>
        ))}
        {items.length === 0 && !project.loading && <li className="muted list-empty">Nothing matches.</li>}
        {shown < items.length && (
          <li>
            <ShowMore shown={shown} total={items.length} more={more} what="items" />
          </li>
        )}
      </ul>
      <button type="button" className="button sidebar-new" onClick={onNew}>
        <Icon name="plus" /> New {typeWord(index.config, kind)}
      </button>
    </aside>
  );
}

// The first rule each item misses: ID → the gap in a word or two.
function ruleGaps(index: Project['index']): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of checkRules(index)) for (const it of r.missing) if (!out.has(it.id)) out.set(it.id, r.rule.tag);
  return out;
}

function RowBadge({ project, item, how }: { project: Project; item: Item; how: ReturnType<typeof verification> & { rules: Map<string, string> } }) {
  const links = linksOf(project.index, item);
  if (links.some((l) => l.state === 'suspect') || itemLinks(project.index, item).out.some((l) => l.state === 'suspect'))
    return (
      <span className="row-badge warn" title="A linked requirement changed since review">
        <Icon name="warn" size={13} /> suspect
      </span>
    );
  if (item.status === 'obsolete') return null;
  const rule = how.rules.get(item.id);
  const cfg = project.index.config;
  if (item.kind !== 'requirement' && !isRunnable(cfg, item.kind)) {
    if (rule) return <span className="row-badge gap">{rule.toLowerCase()}</span>;
    return links.length ? <span className="row-badge">{links.length} test{links.length === 1 ? '' : 's'}</span> : null;
  }
  if (item.kind === 'requirement') {
    const covered = how.covered.get(item.id);
    if (links.length)
      return (
        <span className="row-badge" title={`${links.length} test case${links.length === 1 ? '' : 's'}`}>
          {links.length} test{links.length === 1 ? '' : 's'}
        </span>
      );
    if (covered === 'refinements')
      return (
        <span className="row-badge" title="Covered: every requirement refining it is">
          covered
        </span>
      );
    if (covered === 'evidence')
      return (
        <span className="row-badge" title={`Verified by ${item.verification}: ${item.evidence.join(', ')}`}>
          {item.verification}
        </span>
      );
    if (how.exempt.has(item.id)) return null;
    if (item.verification !== 'test')
      return (
        <span className="row-badge gap" title={`To be verified by ${item.verification}, but no evidence is recorded`}>
          no evidence
        </span>
      );
    return (
      <span className="row-badge gap" title="No test case verifies this requirement">
        no tests
      </span>
    );
  }
  if (!item.verifies.length) return <span className="row-badge gap">verifies nothing</span>;
  return rule ? <span className="row-badge gap">{rule.toLowerCase()}</span> : null;
}
