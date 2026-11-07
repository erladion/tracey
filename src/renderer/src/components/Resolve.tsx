// Resolving conflicts after getting the latest: for each file both you and the server
// changed, Tracey merges what it can and asks about the rest, side by side.
import { useEffect, useMemo, useState } from 'react';
import type { ConflictVersions, Identity } from '../../../shared/api';
import { planMerge, type Choice, type Conflict, type MergePlan } from '../../../core/merge';
import { blockText, readVersion, showValue, wordDiff } from '../../../core/diff';
import type { Project } from '../project';
import { api } from '../api';
import { notify } from '../notify';
import { load, save } from '../storage';
import { Dialog } from './Dialog';
import { Rendered, imageResolver } from './Compare';

function Diffed({ base, text }: { base: string; text: string }) {
  // What this side changed, against how it was before.
  return (
    <div className="cmp-block cmp-chg">
      {wordDiff(base, text).map((p, j) => (p.kind === 'same' ? p.text : p.kind === 'add' ? <ins key={j}>{p.text}</ins> : <del key={j}>{p.text}</del>))}
    </div>
  );
}

function Option({ on, label, onPick, children }: { on: boolean; label: string; onPick: () => void; children?: React.ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={`choice${on ? ' on' : ''}`} onClick={onPick}>
      <span className="choice-label">{label}</span>
      {children}
    </button>
  );
}

function ConflictCard({ c, choice, onChoose, image }: { c: Conflict; choice: Choice | null; onChoose: (c: Choice) => void; image: (src: string) => string }) {
  if (c.kind === 'field' || c.kind === 'case') {
    const title = c.kind === 'field' ? c.label : c.id;
    return (
      <div className="conflict">
        <div className="conflict-head">
          <span className="strong">{title}</span> <span className="muted small">before: {c.base || '(none)'}</span>
        </div>
        <div className="choices" role="radiogroup" aria-label={title}>
          <Option on={choice === 'ours'} label="Yours" onPick={() => onChoose('ours')}>
            <span>{c.ours || '(none)'}</span>
          </Option>
          <Option on={choice === 'theirs'} label="From the server" onPick={() => onChoose('theirs')}>
            <span>{c.theirs || '(none)'}</span>
          </Option>
        </div>
      </div>
    );
  }
  if (c.kind === 'text') {
    const base = blockText(c.base.join('\n\n'));
    const side = (blocks: string[]) =>
      !blocks.length ? <p className="muted small">(removed)</p> : base ? <Diffed base={base} text={blockText(blocks.join('\n\n'))} /> : <Rendered source={blocks.join('\n\n')} image={image} className="" />;
    return (
      <div className="conflict">
        <div className="conflict-head">
          <span className="strong">Text</span> <span className="muted small">both changed the same {c.base.length > 1 ? 'paragraphs' : 'paragraph'}</span>
        </div>
        <div className="choices" role="radiogroup" aria-label="Text">
          <Option on={choice === 'ours'} label="Yours" onPick={() => onChoose('ours')}>
            {side(c.ours)}
          </Option>
          <Option on={choice === 'theirs'} label="From the server" onPick={() => onChoose('theirs')}>
            {side(c.theirs)}
          </Option>
        </div>
        <div className="conflict-foot">
          <button type="button" role="radio" aria-checked={choice === 'both'} className={`button small toggle${choice === 'both' ? ' on' : ''}`} onClick={() => onChoose('both')}>
            Keep both (yours first)
          </button>
          {base && (
            <details className="small">
              <summary className="muted">Before</summary>
              <Rendered source={c.base.join('\n\n')} image={image} className="cmp-same" />
            </details>
          )}
        </div>
      </div>
    );
  }
  const show = (t: string | null, gone: string) => (t == null ? <span className="muted">{gone}</span> : <pre className="source-view small">{t.length > 4000 ? `${t.slice(0, 4000)}…` : t}</pre>);
  return (
    <div className="conflict">
      <div className="conflict-head">
        <span className="strong">The whole file</span> <span className="muted small">Tracey can’t merge this kind of file part by part</span>
      </div>
      <div className="choices" role="radiogroup" aria-label="File">
        <Option on={choice === 'ours'} label="Yours" onPick={() => onChoose('ours')}>
          {show(c.ours, 'You deleted it')}
        </Option>
        <Option on={choice === 'theirs'} label="From the server" onPick={() => onChoose('theirs')}>
          {show(c.theirs, 'Deleted on the server')}
        </Option>
      </div>
    </div>
  );
}

export function ResolveDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const repo = project.repo.id;
  const conflicted = useMemo(() => (project.git?.changes ?? []).filter((c) => c.kind === 'conflicted').map((c) => c.path), [project.git]);
  const [path, setPath] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ path: string; plan: MergePlan; name: string } | null>(null);
  const [choices, setChoices] = useState<(Choice | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<Identity | null | undefined>(undefined);
  const [author, setAuthor] = useState<Identity>(() => load<Identity>('trace.author') ?? { name: '', email: '' });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const current = path && conflicted.includes(path) ? path : (conflicted[0] ?? null);

  useEffect(() => {
    api.gitIdentity(repo).then(setIdentity, () => setIdentity(null));
  }, [repo]);

  useEffect(() => {
    let live = true;
    setPlan(null);
    if (!current) return;
    api.gitConflict(repo, current).then(
      (v: ConflictVersions) => {
        if (!live) return;
        const p = planMerge(current, project.index.config.runs.dir, v.base, v.ours, v.theirs);
        // The file has conflict markers now, so its ID comes from your version.
        const v2 = v.ours ?? v.theirs;
        const d = p.kind === 'item' && v2 ? readVersion(v2).data : {};
        setPlan({ path: current, plan: p, name: d.id ? `${showValue(d.id)} ${showValue(d.title)}`.trim() : (current.split('/').pop() ?? current) });
        setChoices(p.conflicts.map(() => null));
      },
      (e) => notify((e as Error).message, 'error'),
    );
    return () => {
      live = false;
    };
  }, [repo, current, project.index.config.runs.dir]);

  const step = async (what: () => Promise<void>) => {
    setBusy(true);
    try {
      await what();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
      await project.reload();
    }
  };

  const saveFile = () =>
    step(async () => {
      if (!plan) return;
      await api.gitResolve(repo, plan.path, plan.plan.build(choices as Choice[]));
      notify(`${plan.path} merged.`, 'success');
    });

  const askAuthor = identity === null;
  const finish = (push: boolean) =>
    step(async () => {
      if (askAuthor) save('trace.author', author);
      await api.gitFinishMerge(repo, askAuthor ? author : null);
      if (push) await api.gitPush(repo);
      notify(push ? 'Merged and pushed.' : 'Merged. Push when you’re ready.', 'success');
      onClose();
    });

  const cancel = () =>
    step(async () => {
      await api.gitAbortMerge(repo);
      notify('Back to how it was before getting the latest.', 'success');
      onClose();
    });

  const image = useMemo(() => imageResolver(repo, plan?.path ?? ''), [repo, plan?.path]);
  const all = plan ? choices.every((c) => c) : false;
  const title = (p: string) => project.index.byPath.get(p)?.id ?? p.split('/').pop() ?? p;

  return (
    <Dialog title="Resolve conflicts" onClose={onClose} wide>
      <div className="dialog-body resolve">
        {conflicted.length > 0 ? (
          <>
            <p className="muted">
              You and the server changed the same things in {conflicted.length} file{conflicted.length === 1 ? '' : 's'}. Tracey merged everything else; choose what to keep here.
            </p>
            {conflicted.length > 1 && (
              <div className="segmented small" role="tablist">
                {conflicted.map((p) => (
                  <button key={p} type="button" role="tab" aria-selected={p === current} className={p === current ? 'on' : ''} onClick={() => setPath(p)}>
                    {title(p)}
                  </button>
                ))}
              </div>
            )}
            {!plan ? (
              <p className="muted">Reading…</p>
            ) : (
              <>
                <h3 className="resolve-file">
                  {plan.name} <span className="mono muted small">{plan.path}</span>
                </h3>
                {plan.plan.auto.length > 0 && <p className="small ok-text">Taken from the server automatically: {plan.plan.auto.join(', ')}.</p>}
                {plan.plan.conflicts.map((c, i) => (
                  <ConflictCard key={i} c={c} choice={choices[i]} image={image} onChoose={(ch) => setChoices(choices.map((x, j) => (j === i ? ch : x)))} />
                ))}
                {plan.plan.conflicts.length === 0 && <p className="small">Nothing left to choose: Tracey can merge this file by itself.</p>}
              </>
            )}
          </>
        ) : (
          <>
            <p>All conflicts are resolved. Finish to record the merge (a commit joining your work and the server’s).</p>
            {askAuthor && (
              <div className="two-col">
                <label className="field">
                  <span>Your name</span>
                  <input value={author.name} onChange={(e) => setAuthor({ ...author, name: e.target.value })} />
                </label>
                <label className="field">
                  <span>Your email</span>
                  <input type="email" value={author.email} onChange={(e) => setAuthor({ ...author, email: e.target.value })} />
                </label>
              </div>
            )}
          </>
        )}
        <div className="dialog-actions">
          {confirmCancel ? (
            <>
              <span className="warn-text small">Undo getting the latest? Your work stays as it was before.</span>
              <button type="button" className="button danger" disabled={busy} onClick={() => void cancel()}>
                Undo
              </button>
              <button type="button" className="button" onClick={() => setConfirmCancel(false)}>
                No
              </button>
            </>
          ) : (
            <button type="button" className="button" disabled={busy} onClick={() => setConfirmCancel(true)}>
              Cancel getting the latest…
            </button>
          )}
          <span className="tool-spacer" />
          {conflicted.length > 0 ? (
            <button type="button" className="button primary" disabled={busy || !plan || !all} onClick={() => void saveFile()}>
              {plan && !all ? `Choose ${choices.filter((c) => !c).length} more` : 'Use these choices'}
            </button>
          ) : (
            <>
              <button type="button" className="button" disabled={busy || identity === undefined || (askAuthor && !(author.name.trim() && author.email.trim()))} onClick={() => void finish(false)}>
                Finish
              </button>
              {project.git?.hasRemote && (
                <button type="button" className="button primary" disabled={busy || identity === undefined || (askAuthor && !(author.name.trim() && author.email.trim()))} onClick={() => void finish(true)}>
                  Finish and push
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
