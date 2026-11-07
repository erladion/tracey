// Settings: the product variants in trace.yml, to add, rename and remove without
// editing the YAML by hand.
import { useEffect, useMemo, useState } from 'react';
import { setVariants, variantKey, type Variant } from '../../../core/config';
import type { Project } from '../project';
import { Icon } from '../icons';
import { notify } from '../notify';

interface Row extends Variant {
  isNew: boolean;
}

export function VariantsCard({ project, blocked }: { project: Project; blocked: boolean }) {
  const saved = project.allIndex.config.variants;
  const fresh = () => saved.map((v) => ({ ...v, isNew: false }));
  const [rows, setRows] = useState<Row[]>(fresh);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setRows(fresh()), [project.config]);
  const [busy, setBusy] = useState(false);

  // How many items each variant is named by, including ones trace.yml doesn't define.
  const uses = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of project.allIndex.items) for (const v of it.variants) m.set(v, (m.get(v) ?? 0) + 1);
    return m;
  }, [project.allIndex]);
  const undefinedKeys = [...uses.keys()].filter((k) => !saved.some((v) => v.key === k)).sort();

  const keys = rows.map((r) => r.key.trim());
  const problem = (r: Row, i: number): string | null => {
    const k = r.key.trim();
    if (!r.name.trim()) return 'Give it a name.';
    if (!k) return 'Give it a key.';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(k)) return 'Keys are letters, digits, - and _.';
    if (keys.indexOf(k) !== i) return `“${k}” is used twice.`;
    return null;
  };
  const problems = rows.map(problem);
  const dirty = JSON.stringify(rows.map(({ key, name }) => ({ key: key.trim(), name: name.trim() }))) !== JSON.stringify(saved.map(({ key, name }) => ({ key, name })));
  const removed = saved.filter((v) => !keys.includes(v.key) && uses.get(v.key));

  const update = (i: number, change: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...change } : r)));
  const add = (key = '', name = '') => setRows([...rows, { key, name, isNew: true }]);

  const save = async () => {
    setBusy(true);
    try {
      await project.writeConfig(setVariants(project.config, rows.map((r) => ({ key: r.key.trim(), name: r.name.trim() }))));
      await project.reload();
      notify('Variants saved in trace.yml.', 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card variants-card">
      <h2>Variants</h2>
      <p className="muted">
        The product variants this repository describes. An item limited to some lists them above its text (<code>variants: [pro]</code>); one that lists none applies to
        all of them, so most items need nothing.
      </p>
      {rows.length > 0 ? (
        <table className="variants-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Items limited to it</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <input
                    value={r.name}
                    aria-label="Variant name"
                    placeholder="Pro"
                    autoFocus={r.isNew && !r.name}
                    onChange={(e) => update(i, r.isNew && (r.key === '' || r.key === variantKey(r.name)) ? { name: e.target.value, key: variantKey(e.target.value) } : { name: e.target.value })}
                  />
                </td>
                <td>
                  {r.isNew ? (
                    <input className="mono" value={r.key} aria-label="Variant key" placeholder="pro" onChange={(e) => update(i, { key: e.target.value })} />
                  ) : (
                    <code title="What items name. It can’t be changed here, since items use it.">{r.key}</code>
                  )}
                  {problems[i] && <span className="warn-text small block">{problems[i]}</span>}
                </td>
                <td className="muted">{uses.get(r.key.trim()) ?? 0}</td>
                <td className="row-actions">
                  <button type="button" className="icon-button" aria-label={`Remove ${r.name || r.key || 'variant'}`} title="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    <Icon name="trash" size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No variants: every item applies to the one product.</p>
      )}
      {undefinedKeys.length > 0 && (
        <p className="warn-text small">
          Items name {undefinedKeys.length === 1 ? 'a variant' : 'variants'} trace.yml doesn’t define:{' '}
          {undefinedKeys.map((k, i) => (
            <span key={k}>
              {i > 0 && ', '}
              <code>{k}</code> ({uses.get(k)}){' '}
              {!keys.includes(k) && (
                <button type="button" className="link-button small" onClick={() => add(k, k.charAt(0).toUpperCase() + k.slice(1))}>
                  Add it
                </button>
              )}
            </span>
          ))}
        </p>
      )}
      {removed.length > 0 && (
        <p className="warn-text small">
          {removed.map((v) => `${v.name} is named by ${uses.get(v.key)} item${uses.get(v.key) === 1 ? '' : 's'}`).join('; ')}. They’ll be listed under Problems until their variants are
          changed.
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="button" onClick={() => add()}>
          <Icon name="plus" /> Add a variant
        </button>
        <span className="tool-spacer" />
        {blocked && dirty && <span className="muted small">Save or revert your trace.yml edits below first.</span>}
        <button type="button" className="button" disabled={!dirty || busy} onClick={() => setRows(fresh())}>
          Revert
        </button>
        <button type="button" className="button primary" disabled={!dirty || busy || blocked || problems.some(Boolean)} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}
