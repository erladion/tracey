// Several items picked in the list: change their status, components, variants, links
// and fields all at once. The files change like any edit and are committed from the
// bottom bar.
import { useMemo, useState } from 'react';
import { fieldsFor, linksFrom, statusesFor, typeOf, type FieldDef } from '../../../core/config';
import { bulkChanges, emptyEdit, type BulkEdit as Edit } from '../../../core/bulk';
import { fieldInput } from '../../../core/fields';
import { durationText, parseDuration } from '../../../core/estimate';
import { fieldLabel } from '../../../core/diff';
import { METHODS, type Item } from '../../../core/model';
import type { Project } from '../project';
import { notify } from '../notify';
import { ChipInput } from './bits';

interface Props {
  project: Project;
  paths: string[];
  onOpen: (path: string) => void;
  onClear: () => void;
}

type Single = { key: string; name: string; kind: 'pick'; values: string[]; clearable: boolean } | { key: string; name: string; kind: 'type'; type: 'text' | 'number' | 'date' | 'estimate'; def?: FieldDef };
type Multi = { key: string; name: string; suggestions: { value: string; label: string }[]; mono?: boolean };

export function BulkEdit({ project, paths, onOpen, onClear }: Props) {
  const { index } = project;
  const items = useMemo(() => paths.map((p) => index.byPath.get(p)).filter((i): i is Item => !!i), [paths, index]);
  const kind = items[0]?.kind ?? 'requirement';
  const noun = typeOf(index.config, kind).name.toLowerCase();
  const nouns = typeOf(index.config, kind).plural.toLowerCase();
  const [edit, setEdit] = useState<Edit>(emptyEdit);
  const [typed, setTyped] = useState<Record<string, string>>({}); // text being typed for "Set to…"

  const declared = fieldsFor(index.config, kind);
  const singles: Single[] = [
    { key: 'status', name: 'Status', kind: 'pick', values: statusesFor(index.config, kind), clearable: false },
    ...(kind === 'testcase' ? [{ key: 'estimate', name: 'Estimate', kind: 'type', type: 'estimate' } as Single] : []),
    ...(kind === 'requirement' ? [{ key: 'verification', name: 'Verification', kind: 'pick', values: [...METHODS], clearable: false } as Single] : []),
    ...declared
      .filter((f) => f.type !== 'list' && f.type !== 'choices')
      .map((f): Single => (f.type === 'choice' ? { key: f.key, name: f.name, kind: 'pick', values: f.values, clearable: true } : { key: f.key, name: f.name, kind: 'type', type: f.type as 'text' | 'number' | 'date', def: f })),
  ];
  const multis: Multi[] = [
    { key: 'components', name: 'Components', suggestions: index.config.components.map((c) => ({ value: c.key, label: c.name })) },
    ...(index.config.variants.length ? [{ key: 'variants', name: 'Variants', suggestions: index.config.variants.map((v) => ({ value: v.key, label: v.name })) }] : []),
    ...linksFrom(index.config, kind).map((l) => ({
      key: l.key,
      name: l.name,
      mono: true,
      suggestions: index.items.filter((i) => l.to.includes(i.kind)).map((i) => ({ value: i.id, label: i.title })),
    })),
    ...(kind === 'requirement' ? [{ key: 'evidence', name: 'Evidence', suggestions: [] }] : []),
    { key: 'jira', name: 'Jira', mono: true, suggestions: [] },
    ...declared.filter((f) => f.type === 'list' || f.type === 'choices').map((f) => ({ key: f.key, name: f.name, suggestions: f.values.map((v) => ({ value: v, label: v })) })),
  ];

  const changes = useMemo(() => bulkChanges(items, edit, index), [items, edit, index]);
  const touched = [...new Set([...changes.values()].flatMap((c) => Object.keys(c)).filter((k) => k !== 'reviewed'))];
  const pending = Object.keys(edit.set).length + Object.values(edit.add).flat().length + Object.values(edit.remove).flat().length > 0;

  const setValue = (key: string, v: unknown | typeof KEEP) => {
    const set = { ...edit.set };
    if (v === KEEP) delete set[key];
    else set[key] = v;
    setEdit({ ...edit, set });
  };
  const setList = (which: 'add' | 'remove', key: string, values: string[]) => setEdit({ ...edit, [which]: { ...edit[which], [key]: values } });

  // "Set to…" a typed value: what goes in the file, or undefined while it can't be read.
  const typedValue = (s: Extract<Single, { kind: 'type' }>, text: string): unknown => {
    if (s.type === 'estimate') {
      const m = parseDuration(text);
      return m == null ? undefined : durationText(m);
    }
    return s.def ? fieldInput(s.def, text) : text.trim() || undefined;
  };

  const apply = () => {
    for (const [path, c] of changes) project.updateFields(path, c);
    notify(`Changed ${changes.size} ${changes.size === 1 ? noun : nouns}. Commit them from the bottom bar.`, 'success');
    setEdit(emptyEdit());
    setTyped({});
  };

  if (!items.length) return null;
  return (
    <div className="bulk-edit">
      <div className="bulk-head">
        <h1>
          {items.length} {items.length === 1 ? noun : nouns} picked
        </h1>
        <button type="button" className="button" onClick={onClear}>
          Clear selection
        </button>
      </div>
      <div className="bulk-picked">
        {items.map((it) => (
          <button key={it.path} type="button" className="chip mono bulk-chip" title={it.title} onClick={() => onOpen(it.path)}>
            {it.id}
          </button>
        ))}
      </div>
      <p className="muted small">Ctrl-click (⌘ on a Mac) adds or removes one in the list; Shift-click picks everything between.</p>

      <section className="card bulk-form" aria-label="Change all of them">
        <h2>Change all of them</h2>
        <div className="bulk-grid">
          {singles.map((s) => {
            const has = s.key in edit.set;
            const v = edit.set[s.key];
            const id = `bulk-${s.key}`;
            if (s.kind === 'pick')
              return (
                <div key={s.key} className="bulk-row">
                  <label htmlFor={id}>{s.name}</label>
                  <div className="bulk-ctl">
                    <select id={id} value={!has ? KEEP : v === null ? CLEAR : String(v)} onChange={(e) => setValue(s.key, e.target.value === KEEP ? KEEP : e.target.value === CLEAR ? null : e.target.value)}>
                      <option value={KEEP}>Keep as is</option>
                      {s.values.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                      {s.clearable && <option value={CLEAR}>Clear it</option>}
                    </select>
                  </div>
                </div>
              );
            const mode = !has && !(s.key in typed) ? KEEP : v === null ? CLEAR : 'set';
            const text = typed[s.key] ?? '';
            const bad = mode === 'set' && text.trim() !== '' && typedValue(s, text) === undefined;
            return (
              <div key={s.key} className="bulk-row">
                <label htmlFor={id}>{s.name}</label>
                <div className="bulk-ctl">
                  <select
                    id={id}
                    value={mode}
                    onChange={(e) => {
                      const m = e.target.value;
                      const t = { ...typed };
                      if (m === 'set') t[s.key] = text;
                      else delete t[s.key];
                      setTyped(t);
                      const set = { ...edit.set };
                      if (m === KEEP) delete set[s.key];
                      else if (m === CLEAR) set[s.key] = null;
                      else delete set[s.key];
                      setEdit({ ...edit, set });
                    }}
                  >
                    <option value={KEEP}>Keep as is</option>
                    <option value="set">Set to…</option>
                    <option value={CLEAR}>Clear it</option>
                  </select>
                  {mode === 'set' && (
                    <input
                      aria-label={`${s.name}: new value`}
                      className="field-input"
                      type={s.type === 'date' ? 'date' : 'text'}
                      value={text}
                      autoFocus
                      placeholder={s.type === 'estimate' ? '30m' : s.type === 'number' ? '0' : ''}
                      aria-invalid={bad}
                      onChange={(e) => {
                        setTyped({ ...typed, [s.key]: e.target.value });
                        const val = typedValue(s, e.target.value);
                        const set = { ...edit.set };
                        if (val === undefined) delete set[s.key];
                        else set[s.key] = val;
                        setEdit({ ...edit, set });
                      }}
                    />
                  )}
                  {bad && <span className="warn-text small">{s.type === 'estimate' ? 'Write it like 30m or 1h 30m' : 'Can’t read that'}</span>}
                </div>
              </div>
            );
          })}
          {multis.map((m) => (
            <div key={m.key} className="bulk-row">
              <span className="bulk-label">{m.name}</span>
              <div className="bulk-ctl lists">
                <ChipInput idKey={`add-${m.key}`} label="Add" mono={m.mono} values={edit.add[m.key] ?? []} suggestions={m.suggestions} onChange={(v) => setList('add', m.key, v)} placeholder="Add…" />
                <ChipInput idKey={`remove-${m.key}`} label="Remove" mono={m.mono} values={edit.remove[m.key] ?? []} suggestions={m.suggestions} onChange={(v) => setList('remove', m.key, v)} placeholder="Remove…" />
              </div>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <span className="muted small" aria-live="polite">
            {!pending
              ? 'Nothing to change yet.'
              : changes.size
                ? `Changes ${touched.map((k) => declared.find((f) => f.key === k)?.name ?? fieldLabel(k)).join(', ')} in ${changes.size} of ${items.length} files.`
                : `That changes nothing: they all have it already.`}
          </span>
          <span className="tool-spacer" />
          <button
            type="button"
            className="button"
            disabled={!pending}
            onClick={() => {
              setEdit(emptyEdit());
              setTyped({});
            }}
          >
            Reset
          </button>
          <button type="button" className="button primary" disabled={!changes.size} onClick={apply}>
            Change {changes.size || ''} {changes.size === 1 ? noun : nouns}
          </button>
        </div>
      </section>
    </div>
  );
}

const KEEP = '\u0000keep';
const CLEAR = '\u0000clear';
