// Ctrl+Shift+P: jump to an item, a test run or an action by typing part of its name.
import { useEffect, useMemo, useRef, useState } from 'react';
import { typeOf } from '../../../core/config';
import type { Item } from '../../../core/model';
import type { Project } from '../project';
import { Icon } from '../icons';

export interface PaletteAction {
  label: string; // "Go to Coverage", "New risk"
  hint?: string;
  run: () => void;
}

type Entry = { key: string; kind: 'action'; action: PaletteAction } | { key: string; kind: 'item'; item: Item } | { key: string; kind: 'run'; path: string; name: string; created: string };

const MAX = 40;

export function Palette({
  project,
  actions,
  recent,
  onOpenItem,
  onOpenRun,
  onClose,
}: {
  project: Project;
  actions: PaletteAction[];
  recent: string[]; // paths of items opened lately, newest first
  onOpenItem: (it: Item) => void;
  onOpenRun: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const index = project.allIndex;

  const entries = useMemo((): Entry[] => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = (s: string) => words.every((w) => s.includes(w));
    if (!words.length) {
      const items = recent
        .map((p) => index.byPath.get(p))
        .filter((i): i is Item => !!i)
        .slice(0, 8);
      return [...items.map((item) => ({ key: `i:${item.path}`, kind: 'item' as const, item })), ...actions.map((action) => ({ key: `a:${action.label}`, kind: 'action' as const, action }))];
    }
    const q = query.trim().toLowerCase();
    const found: { item: Item; rank: number }[] = [];
    for (const item of index.items) {
      const id = item.id.toLowerCase();
      const title = item.title.toLowerCase();
      if (!all(`${id} ${title}`)) continue;
      found.push({ item, rank: id === q ? 0 : id.startsWith(q) ? 1 : title.startsWith(q) ? 2 : 3 });
      if (found.length > 2000) break;
    }
    found.sort((a, b) => a.rank - b.rank || a.item.id.localeCompare(b.item.id, undefined, { numeric: true }));
    const acts = actions.filter((a) => all(a.label.toLowerCase()));
    const runs = project.runs.filter((r) => all(`${r.name} ${r.path}`.toLowerCase()));
    return [
      ...(found[0]?.rank === 0 ? [] : acts.map((action) => ({ key: `a:${action.label}`, kind: 'action' as const, action }))),
      ...found.slice(0, MAX).map(({ item }) => ({ key: `i:${item.path}`, kind: 'item' as const, item })),
      ...runs.slice(0, 10).map((r) => ({ key: `r:${r.path}`, kind: 'run' as const, path: r.path, name: r.name, created: r.created })),
      ...(found[0]?.rank === 0 ? acts.map((action) => ({ key: `a:${action.label}`, kind: 'action' as const, action })) : []),
    ];
  }, [query, index, actions, recent, project.runs]);

  useEffect(() => setAt(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const choose = (e: Entry | undefined) => {
    if (!e) return;
    onClose();
    if (e.kind === 'action') e.action.run();
    else if (e.kind === 'item') onOpenItem(e.item);
    else onOpenRun(e.path);
  };

  return (
    <div className="scrim palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Go to">
        <div className="search palette-search">
          <Icon name="search" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Go to an item, a test run or an action…"
            aria-label="Go to"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const n = entries.length || 1;
                setAt((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(entries[at]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>
        <ul className="palette-list" ref={list} role="listbox" aria-label="Results">
          {entries.map((e, i) => (
            <li key={e.key} role="option" aria-selected={i === at} className={i === at ? 'on' : ''} onMouseMove={() => i !== at && setAt(i)} onMouseDown={(ev) => ev.preventDefault()} onClick={() => choose(e)}>
              {e.kind === 'action' ? (
                <>
                  <span className="palette-kind">Action</span>
                  <span className="palette-main">{e.action.label}</span>
                  {e.action.hint && <span className="muted small">{e.action.hint}</span>}
                </>
              ) : e.kind === 'item' ? (
                <>
                  <span className="palette-kind">{typeOf(index.config, e.item.kind).name}</span>
                  <span className="palette-main">
                    <span className="item-id">{e.item.id}</span> {e.item.title}
                  </span>
                  <span className="muted small">{e.item.status}</span>
                </>
              ) : (
                <>
                  <span className="palette-kind">Test run</span>
                  <span className="palette-main">{e.name}</span>
                  <span className="muted small">{e.created}</span>
                </>
              )}
            </li>
          ))}
          {entries.length === 0 && <li className="muted palette-empty">Nothing matches.</li>}
        </ul>
        <div className="palette-hint muted small">↑↓ to choose · Enter to open · Esc to close · Alt+← and Alt+→ go back and forward</div>
      </div>
    </div>
  );
}
