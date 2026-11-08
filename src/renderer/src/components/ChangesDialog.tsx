// What changed in the requirements and test cases between two versions: two releases,
// a release and now, or tags in the requirements repository. Exportable as PDF.
import { useEffect, useMemo, useState } from 'react';
import { forVariant, slug, type ProjectIndex } from '../../../core/model';
import { changeCounts, changedTypes, changesHtml, compareVersions, countsText, untouchedTests, type ItemChange } from '../../../core/changes';
import { releases } from '../../../core/verdict';
import type { Project } from '../project';
import { api } from '../api';
import { indexAt } from '../trend';
import { imageUrl, savePdf } from '../pdf';
import { notify } from '../notify';
import { Dialog } from './Dialog';
import { imageResolver, Rendered, TextDiff } from './Compare';

type Point = { kind: 'now' } | { kind: 'release'; key: string } | { kind: 'tag'; tag: string };

const keyOf = (p: Point) => (p.kind === 'release' ? `release:${p.key}` : p.kind === 'tag' ? `tag:${p.tag}` : 'now');
const parse = (k: string): Point => (k.startsWith('release:') ? { kind: 'release', key: k.slice(8) } : k.startsWith('tag:') ? { kind: 'tag', tag: k.slice(4) } : { kind: 'now' });

interface Side {
  label: string; // "Release v2.4.0 (requirements at 1a2b3c4)"
  index: ProjectIndex | null;
  error: string | null;
}

const LABEL = { added: 'Added', changed: 'Changed', removed: 'Removed' } as const;

export function ChangesDialog({ project, onOpenId, onClose }: { project: Project; onOpenId: (id: string) => void; onClose: () => void }) {
  // Earlier versions come from git history; a folder outside git has only now.
  if (!project.git)
    return (
      <Dialog title="What changed" onClose={onClose}>
        <div className="dialog-body">
          <p>Comparing versions needs git history, and this folder isn’t a git repository: there’s only the version on disk now.</p>
          <p className="muted small">To compare releases, keep the requirements in git (git init, then commit), and record test runs from then on.</p>
          <div className="dialog-actions">
            <span className="tool-spacer" />
            <button type="button" className="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </Dialog>
    );
  return <Changes project={project} onOpenId={onOpenId} onClose={onClose} />;
}

function Changes({ project, onOpenId, onClose }: { project: Project; onOpenId: (id: string) => void; onClose: () => void }) {
  const repo = project.repo.id;
  // A release's requirements: as the newest of its runs that recorded them.
  const rels = useMemo(
    () =>
      releases(project.runs)
        .map((r) => ({ ...r, run: r.runs.find((x) => x.requirementsCommit) }))
        .filter((r) => r.run),
    [project.runs],
  );
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => {
    api.gitTags(repo).then(setTags, () => {});
  }, [repo]);
  const [from, setFrom] = useState<Point>(() => (rels.length >= 2 ? { kind: 'release', key: rels[1].key } : rels.length ? { kind: 'release', key: rels[0].key } : { kind: 'now' }));
  const [to, setTo] = useState<Point>(() => (rels.length >= 2 ? { kind: 'release', key: rels[0].key } : { kind: 'now' }));
  // Without releases, start from the newest tag once the tags are read.
  useEffect(() => {
    if (!rels.length && tags.length && from.kind === 'now' && to.kind === 'now') setFrom({ kind: 'tag', tag: tags[0] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tags]);

  const view = (idx: ProjectIndex) => (project.variant ? forVariant(idx, project.variant) : idx);
  const resolve = async (p: Point): Promise<Side> => {
    if (p.kind === 'now') return { label: 'Now (your copy, with uncommitted changes)', index: view(project.allIndex), error: null };
    let commit: string;
    let label: string;
    if (p.kind === 'release') {
      const r = rels.find((x) => x.key === p.key);
      if (!r) return { label: `Release ${p.key}`, index: null, error: 'No test run for this release recorded its requirements.' };
      commit = r.run!.requirementsCommit!;
      label = `Release ${r.name} (requirements when “${r.run!.name}” was created, ${commit.slice(0, 7)})`;
    } else {
      try {
        commit = await api.gitCommitOf(repo, p.tag);
      } catch (e) {
        return { label: `Tag ${p.tag}`, index: null, error: (e as Error).message };
      }
      label = `Tag ${p.tag} (${commit.slice(0, 7)})`;
    }
    const idx = await indexAt(repo, commit);
    return idx ? { label, index: view(idx), error: null } : { label, index: null, error: `Commit ${commit.slice(0, 7)} isn’t in this copy of the repository. Get the latest and try again.` };
  };

  const [sides, setSides] = useState<{ from: Side; to: Side } | null>(null);
  useEffect(() => {
    let live = true;
    setSides(null);
    Promise.all([resolve(from), resolve(to)]).then(([a, b]) => live && setSides({ from: a, to: b }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyOf(from), keyOf(to), project.allIndex, project.variant]);

  const changes = useMemo(() => (sides?.from.index && sides.to.index ? compareVersions(sides.from.index, sides.to.index) : null), [sides]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };
  const stale = changes?.filter(untouchedTests) ?? [];
  const [busy, setBusy] = useState(false);

  const exportPdf = async () => {
    if (!changes || !sides) return;
    setBusy(true);
    try {
      const name = (p: Point) => (p.kind === 'release' ? rels.find((r) => r.key === p.key)?.name ?? p.key : p.kind === 'tag' ? p.tag : 'now');
      const title = `${project.repo.name}: changes from ${name(from)} to ${name(to)}`;
      const meta: [string, string][] = [['Repository', project.repo.name]];
      if (project.variant) meta.push(['Variant', project.allIndex.config.variants.find((v) => v.key === project.variant)?.name ?? project.variant]);
      const html = changesHtml(changes, { title, from: sides.from.label, to: sides.to.label, meta, image: (itemPath, src) => imageUrl(repo, itemPath, src), types: project.allIndex.config.types });
      await savePdf(html, `${slug(title) || 'changes'}.pdf`);
    } catch (e) {
      notify(`Couldn’t export: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const picker = (label: string, value: Point, set: (p: Point) => void) => (
    <label className="field">
      <span>{label}</span>
      <select value={keyOf(value)} onChange={(e) => set(parse(e.target.value))}>
        <option value="now">Now (your copy)</option>
        {rels.length > 0 && (
          <optgroup label="Releases (requirements as tested)">
            {rels.map((r) => (
              <option key={r.key} value={`release:${r.key}`}>
                Release {r.name}
              </option>
            ))}
          </optgroup>
        )}
        {tags.length > 0 && (
          <optgroup label="Tags in this repository">
            {tags.map((t) => (
              <option key={t} value={`tag:${t}`}>
                {t}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );

  const row = (c: ItemChange) => {
    const it = c.now ?? c.old!;
    const expanded = open.has(c.id);
    const image = imageResolver(repo, it.path);
    return (
      <li key={c.id} className={`change-row ${c.change}`}>
        <div className="change-head">
          <button type="button" className="change-main" onClick={() => toggle(c.id)} aria-expanded={expanded}>
            <span className={`caret${expanded ? ' open' : ''}`} aria-hidden="true">
              ›
            </span>
            <span className="item-id">{c.id}</span> <span>{it.title}</span>
          </button>
          <span className={`pill change-pill ${c.change}`}>{LABEL[c.change]}</span>
          {c.change === 'changed' && (
            <span className="muted small">{[...(c.textChanged ? ['text'] : []), ...c.fields.map((f) => f.label)].join(', ')}</span>
          )}
          {untouchedTests(c) && (
            <span className="pill gap-pill" title={`Verified by ${c.tests.map((t) => t.id).join(', ')}, none of which changed`}>
              Tests not updated
            </span>
          )}
          {c.now && (
            <button
              type="button"
              className="link-button small"
              onClick={() => {
                onOpenId(c.id);
                onClose();
              }}
            >
              Open
            </button>
          )}
        </div>
        {expanded && (
          <div className="change-body">
            {c.change === 'changed' && c.fields.length > 0 && (
              <table className="cmp-fields">
                <tbody>
                  {c.fields.map((f) => (
                    <tr key={f.field}>
                      <td>{f.label}</td>
                      <td>
                        {f.old ? <del>{f.old}</del> : <span className="muted">(none)</span>} → {f.new ? <ins>{f.new}</ins> : <span className="muted">(none)</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {c.change === 'changed' && <TextDiff oldBody={c.old!.body} newBody={c.now!.body} image={image} onlyChanges />}
            {c.change === 'added' && <Rendered source={c.now!.body} image={image} className="cmp-add" />}
            {c.change === 'removed' && <Rendered source={c.old!.body} image={image} className="cmp-del" />}
            {c.kind === 'requirement' && c.tests.length > 0 && (
              <p className="muted small">
                Verified by{' '}
                {c.tests.map((t, i) => (
                  <span key={t.id}>
                    {i > 0 && ', '}
                    <span className="mono">{t.id}</span>
                    {t.changed ? ' (changed too)' : ''}
                  </span>
                ))}
              </p>
            )}
          </div>
        )}
      </li>
    );
  };

  const section = (kind: string, title: string) => {
    const list = changes?.filter((c) => c.kind === kind) ?? [];
    if (!list.length) return null;
    return (
      <section className="changes-section">
        <h3>
          {title} <span className="muted small">{countsText(changeCounts(list, kind))}</span>
        </h3>
        <ul className="change-list changes">{list.map(row)}</ul>
      </section>
    );
  };

  return (
    <Dialog title="What changed" onClose={onClose} wide>
      <div className="dialog-body changes-dialog">
        <div className="two-col">
          {picker('From', from, setFrom)}
          {picker('To', to, setTo)}
        </div>
        {!sides ? (
          <p className="muted">Reading both versions…</p>
        ) : sides.from.error || sides.to.error ? (
          <p className="warn-text">{sides.from.error ?? sides.to.error}</p>
        ) : (
          changes && (
            <>
              <p className="muted small">
                {sides.from.label} → {sides.to.label}
                {project.variant ? `, for the variant ${project.allIndex.config.variants.find((v) => v.key === project.variant)?.name ?? project.variant}` : ''}.
              </p>
              <p>
                <strong>Requirements:</strong> {countsText(changeCounts(changes, 'requirement'))} · <strong>Test cases:</strong> {countsText(changeCounts(changes, 'testcase'))}
              </p>
              {stale.length > 0 && (
                <p className="warn-text small">
                  {stale.length} requirement{stale.length === 1 ? '' : 's'} changed text while {stale.length === 1 ? 'its' : 'their'} test cases didn’t: {stale.map((c) => c.id).join(', ')}.
                </p>
              )}
              {changes.length === 0 ? <p className="muted">Nothing changed in the requirements or test cases.</p> : null}
              {changedTypes(changes, project.allIndex.config.types).map((t) => (
                <div key={t.key}>{section(t.key, t.plural)}</div>
              ))}
            </>
          )
        )}
        <div className="dialog-actions">
          {changes && changes.length > 0 && (
            <button type="button" className="button" onClick={() => setOpen(open.size ? new Set() : new Set(changes.map((c) => c.id)))}>
              {open.size ? 'Collapse all' : 'Expand all'}
            </button>
          )}
          <span className="tool-spacer" />
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
          <button type="button" className="button primary" disabled={!changes || busy} onClick={exportPdf}>
            {busy ? 'Exporting…' : 'Export PDF'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
