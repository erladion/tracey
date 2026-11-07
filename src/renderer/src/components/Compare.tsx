// Comparing two versions of a requirement or test case: fields, then the text block by
// block (formatted), with word-level changes inside changed blocks. A version can be
// restored from here.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import MarkdownIt from 'markdown-it';
import type { FileCommit } from '../../../shared/api';
import type { Item } from '../../../core/model';
import { blockChanges, blockText, bodyBlocks, fieldChanges, readVersion, wordDiff } from '../../../core/diff';
import type { Project } from '../project';
import { imagePath } from '../../../core/images';
import { api, fileUrl } from '../api';
import { notify } from '../notify';
import { Dialog } from './Dialog';
import { timeAgo } from './bits';

// Raw HTML in the text is shown as text, never run.
const md = MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough']);

export type Against = 'now' | 'previous';

export function versionLabel(c: FileCommit): string {
  return `${c.commit.slice(0, 7)} · ${c.message} · ${c.author}, ${timeAgo(c.date)}`;
}

// Where the browser loads an item's image from: web images as they are, the
// repository's through Tracey.
export function imageResolver(repo: string, itemPath: string) {
  return (src: string) => {
    if (/^(https?:|data:)/i.test(src)) return src;
    const p = imagePath(itemPath, src);
    return p ? fileUrl(repo, p) : '';
  };
}

export function Rendered({ source, image, className }: { source: string; image: (src: string) => string; className: string }) {
  const html = useMemo(
    () => md.render(source).replace(/<img src="([^"]*)"/g, (_m, src: string) => `<img src="${image(src.replace(/&amp;/g, '&')).replace(/"/g, '&quot;')}"`),
    [source, image],
  );
  return <div className={`cmp-block prose ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function TextDiff({ oldBody, newBody, image, onlyChanges = false }: { oldBody: string; newBody: string; image: (src: string) => string; onlyChanges?: boolean }) {
  const a = useMemo(() => bodyBlocks(oldBody).map((b) => b.key), [oldBody]);
  const b = useMemo(() => bodyBlocks(newBody).map((x) => x.key), [newBody]);
  const ops = useMemo(() => blockChanges(a, b), [a, b]);
  const out: ReactNode[] = [];
  let skipped = 0;
  const flushSkipped = (k: string) => {
    if (skipped) out.push(<div key={`s${k}`} className="cmp-skipped muted small">{skipped} unchanged block{skipped === 1 ? '' : 's'}</div>);
    skipped = 0;
  };
  ops.forEach((op, i) => {
    if (op.kind === 'same') {
      if (onlyChanges) skipped++;
      else out.push(<Rendered key={i} source={b[op.b]} image={image} className="cmp-same" />);
      return;
    }
    flushSkipped(String(i));
    if (op.kind === 'added') out.push(<Rendered key={i} source={b[op.b]} image={image} className="cmp-add" />);
    else if (op.kind === 'removed') out.push(<Rendered key={i} source={a[op.a]} image={image} className="cmp-del" />);
    else
      out.push(
        <div key={i} className="cmp-block cmp-chg">
          {wordDiff(blockText(a[op.a]), blockText(b[op.b])).map((p, j) => (p.kind === 'same' ? p.text : p.kind === 'add' ? <ins key={j}>{p.text}</ins> : <del key={j}>{p.text}</del>))}
        </div>,
      );
  });
  flushSkipped('end');
  if (!ops.some((o) => o.kind !== 'same')) out.unshift(<p key="none" className="muted small">The text is the same.</p>);
  return <div className="cmp-text">{out}</div>;
}

export function CompareDialog({
  project,
  item,
  log,
  start,
  against: startAgainst,
  onClose,
}: {
  project: Project;
  item: Item;
  log: FileCommit[];
  start: number; // index in log
  against: Against;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(start);
  const [against, setAgainst] = useState<Against>(startAgainst);
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [texts, setTexts] = useState<{ old: string | null; new: string | null } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const now = project.texts.get(item.path) ?? '';
  const repo = project.repo.id;
  const image = useMemo(() => imageResolver(repo, item.path), [repo, item.path]);

  useEffect(() => {
    let live = true;
    setTexts(null);
    // '' before the file existed.
    const version = (i: number) => (i < log.length ? api.gitShow(repo, log[i].commit, log[i].path) : Promise.resolve(''));
    const load = against === 'now' ? Promise.all([version(index), Promise.resolve(now)]) : Promise.all([version(index + 1), version(index)]);
    load.then(
      ([o, n]) => live && setTexts({ old: o, new: n }),
      () => live && setTexts({ old: null, new: null }),
    );
    return () => {
      live = false;
    };
    // `now` is read when the dialog opens or the choice changes, not on every save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, log, index, against]);

  const c = log[index];
  const oldV = texts?.old != null ? readVersion(texts.old) : null;
  const newV = texts?.new != null ? readVersion(texts.new) : null;
  const fields = oldV && newV ? fieldChanges(oldV.data, newV.data) : [];

  const restore = () => {
    if (texts?.old == null) return;
    project.setText(item.path, texts.old);
    notify(`${item.id} is back to ${c.commit.slice(0, 7)}. Commit to keep it.`, 'success');
    onClose();
  };

  return (
    <Dialog title={`${item.id}: compare versions`} onClose={onClose} wide>
      <div className="dialog-body compare">
        <div className="compare-controls">
          <label className="field">
            <span>Version</span>
            <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
              {log.map((v, i) => (
                <option key={v.commit} value={i}>
                  {versionLabel(v)}
                </option>
              ))}
            </select>
          </label>
          <div className="segmented small" role="radiogroup" aria-label="Compare with">
            <button type="button" role="radio" aria-checked={against === 'now'} className={against === 'now' ? 'on' : ''} onClick={() => setAgainst('now')}>
              This version → now
            </button>
            <button type="button" role="radio" aria-checked={against === 'previous'} className={against === 'previous' ? 'on' : ''} onClick={() => setAgainst('previous')}>
              What this commit changed
            </button>
          </div>
          <label className="check small">
            <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} /> Only changes
          </label>
        </div>
        {!texts ? (
          <p className="muted">Loading…</p>
        ) : texts.old == null || texts.new == null ? (
          <p className="warn-text">This version of the file couldn’t be read.</p>
        ) : (
          <>
            <p className="muted small compare-legend">
              <del>removed</del> <ins>added</ins> · {against === 'now' ? `${c.commit.slice(0, 7)} → your copy now` : index + 1 < log.length ? `${log[index + 1].commit.slice(0, 7)} → ${c.commit.slice(0, 7)}` : `created in ${c.commit.slice(0, 7)}`}
            </p>
            {fields.length > 0 && (
              <table className="cmp-fields">
                <tbody>
                  {fields.map((f) => (
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
            <TextDiff oldBody={oldV!.body} newBody={newV!.body} image={image} onlyChanges={onlyChanges} />
          </>
        )}
        <div className="dialog-actions">
          {against === 'now' && texts?.old != null && texts.old !== now && texts.old !== '' && (
            confirm ? (
              <>
                <span className="warn-text small">Replace your copy with {c.commit.slice(0, 7)}? Uncommitted changes to {item.id} are lost.</span>
                <button type="button" className="button danger" onClick={restore}>
                  Restore
                </button>
                <button type="button" className="button" onClick={() => setConfirm(false)}>
                  No
                </button>
              </>
            ) : (
              <button type="button" className="button" onClick={() => setConfirm(true)}>
                Restore this version
              </button>
            )
          )}
          <span className="tool-spacer" />
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
