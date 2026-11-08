// The status bar: branch, changes, commit, get latest, push; and save state.
import { useEffect, useMemo, useState } from 'react';
import type { Branches, GitChange, Identity } from '../../../shared/api';
import type { Project } from '../project';
import { api, platform } from '../api';
import { Icon } from '../icons';
import { notify } from '../notify';
import { Dialog } from './Dialog';
import { load, save } from '../storage';
import { ResolveDialog } from './Resolve';
import { IssuesButton } from './Issues';
import type { Coverage } from '../../../core/model';

const FETCH_EVERY = 5 * 60_000;

export function GitBar({
  project,
  cov,
  onOpenId,
  onOpenPath,
  onSettings,
}: {
  project: Project;
  cov: Coverage; // what the issues summary counts
  onOpenId: (id: string) => void;
  onOpenPath: (path: string) => void;
  onSettings: () => void;
}) {
  const { git, repo } = project;
  const [busy, setBusy] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const conflicts = git?.changes.filter((c) => c.kind === 'conflicted').length ?? 0;

  const pull = () =>
    run('pull', async () => {
      const r = await api.gitPull(repo.id, load<Identity>('trace.author'));
      if (r === 'conflicts') {
        notify('You and the server changed the same things. Choose what to keep.', 'info');
        setResolveOpen(true);
      } else notify('Up to date with the server.', 'success');
    });

  // Check the server now and then, so "↓ 2" shows up.
  useEffect(() => {
    if (!git?.upstream) return;
    const tick = () => api.gitFetch(repo.id).then(project.refreshGit, () => {});
    void tick();
    const t = setInterval(tick, FETCH_EVERY);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.id, !!git?.upstream]);

  const run = async (what: string, f: () => Promise<unknown>, done?: string) => {
    setBusy(what);
    try {
      await project.flush();
      await f();
      if (done) notify(done, 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(null);
      await project.reload();
    }
  };


  return (
    <footer className="gitbar">
      {git ? (
        <>
          <button type="button" className="bar-button" onClick={() => setBranchOpen(true)} title="Switch branch">
            <Icon name="branch" size={14} /> {git.branch ?? '(detached)'}
          </button>
          {git.merging ? (
            <button type="button" className="bar-button strong warn-text" onClick={() => setResolveOpen(true)} title="Getting the latest stopped on conflicts">
              <Icon name="warn" size={14} /> {conflicts ? `Resolve conflicts (${conflicts})` : 'Finish merging'}
            </button>
          ) : (
            <button type="button" className={`bar-button${git.changes.length ? ' strong' : ''}`} onClick={() => setCommitOpen(true)} disabled={!git.changes.length} title="Commit changes">
              <Icon name="dot" size={14} /> {git.changes.length ? `${git.changes.length} change${git.changes.length === 1 ? '' : 's'} to commit` : 'No changes'}
            </button>
          )}
          {git.upstream ? (
            <>
              <button type="button" className="bar-button" onClick={() => void pull()} disabled={!!busy || git.merging} title="Get the latest from the server (your commits go on top)">
                <Icon name="down" size={14} /> {busy === 'pull' ? 'Getting latest…' : `Get latest${git.behind ? ` (${git.behind})` : ''}`}
              </button>
              <button type="button" className="bar-button" onClick={() => run('push', () => api.gitPush(repo.id), 'Pushed.')} disabled={!!busy || !git.ahead} title="Send your commits to the server">
                <Icon name="up" size={14} /> {busy === 'push' ? 'Pushing…' : `Push${git.ahead ? ` (${git.ahead})` : ''}`}
              </button>
            </>
          ) : git.hasRemote && (
            <button type="button" className="bar-button" onClick={() => run('push', () => api.gitPush(repo.id), 'Pushed.')} disabled={!!busy} title="Publish this branch to the server (origin)">
              <Icon name="up" size={14} /> {busy === 'push' ? 'Publishing…' : 'Publish branch'}
            </button>
          )}
        </>
      ) : (
        <span className="bar-text muted">Not a git repository: changes are saved, but not versioned.</span>
      )}
      <span className="tool-spacer" />
      <IssuesButton project={project} cov={cov} onOpenId={onOpenId} onOpenPath={onOpenPath} onSettings={onSettings} />
      <button type="button" className="bar-button" onClick={() => run('reload', async () => {})} title="Read the files again">
        <Icon name="refresh" size={14} />
      </button>
      <span className="bar-text muted" aria-live="polite">
        {project.saving ? 'Saving…' : 'Saved'}
      </span>

      {commitOpen && git && (
        <CommitDialog
          project={project}
          changes={git.changes}
          onClose={() => setCommitOpen(false)}
          onCommit={(message, paths, author, push) => {
            setCommitOpen(false);
            void run(
              'commit',
              async () => {
                await api.gitCommit(repo.id, message, paths, author);
                if (push) await api.gitPush(repo.id);
              },
              push ? 'Committed and pushed.' : 'Committed.',
            );
          }}
        />
      )}
      {resolveOpen && git?.merging && <ResolveDialog project={project} onClose={() => setResolveOpen(false)} />}
      {branchOpen && <BranchDialog project={project} onClose={() => setBranchOpen(false)} onSwitch={(b, create) => {
        setBranchOpen(false);
        void run('branch', () => api.gitCheckout(repo.id, b, create), create ? `Started ${b}.` : `Switched to ${b}.`);
      }} />}
    </footer>
  );
}

const KIND_LABEL: Record<GitChange['kind'], string> = { modified: 'changed', added: 'new', deleted: 'deleted', renamed: 'renamed', conflicted: 'conflict' };

export function CommitDialog({
  project,
  changes,
  initialMessage = '',
  onClose,
  onCommit,
}: {
  project: Project;
  changes: GitChange[];
  initialMessage?: string;
  onClose: () => void;
  onCommit: (message: string, paths: string[], author: Identity | null, push: boolean) => void;
}) {
  const [chosen, setChosen] = useState(() => new Set(changes.map((c) => c.path)));
  const [message, setMessage] = useState(initialMessage);
  const [identity, setIdentity] = useState<Identity | null | undefined>(undefined);
  const [author, setAuthor] = useState<Identity>(() => load<Identity>('trace.author') ?? { name: '', email: '' });
  useEffect(() => {
    api.gitIdentity(project.repo.id).then(setIdentity, () => setIdentity(null));
  }, [project.repo.id]);
  // On the web, commits are made by the server: say who you are. On the desktop, git's own settings unless missing.
  const askAuthor = platform === 'web' || identity === null;
  const titleOf = (path: string) => project.index.byPath.get(path);
  const canCommit = message.trim() && chosen.size && (!askAuthor || (author.name.trim() && author.email.trim()));

  const submit = (push: boolean) => {
    if (!canCommit) return;
    if (askAuthor) save('trace.author', author);
    onCommit(
      message.trim(),
      changes.filter((c) => chosen.has(c.path)).flatMap((c) => (c.from ? [c.path, c.from] : [c.path])),
      askAuthor ? author : null,
      push,
    );
  };

  return (
    <Dialog title="Commit changes" onClose={onClose} wide>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
      >
        <ul className="change-list">
          {changes.map((c) => {
            const it = titleOf(c.path);
            return (
              <li key={c.path}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={chosen.has(c.path)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(c.path);
                      else next.delete(c.path);
                      setChosen(next);
                    }}
                  />
                  <span className={`change-kind ${c.kind}`}>{KIND_LABEL[c.kind]}</span>
                  <span className="change-path">
                    {it ? (
                      <>
                        <span className="mono">{it.id}</span> {it.title}
                      </>
                    ) : (
                      <span className="mono">{c.path}</span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <label className="field">
          <span>Message</span>
          <textarea autoFocus rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What changed, and why" />
        </label>
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
        <div className="dialog-actions">
          <span className="muted small">{identity ? `As ${identity.name} <${identity.email}>` : ''}</span>
          <span className="tool-spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          {project.git?.hasRemote && (
            <button type="button" className="button" disabled={!canCommit} onClick={() => submit(true)}>
              Commit and push
            </button>
          )}
          <button type="submit" className="button primary" disabled={!canCommit}>
            Commit {chosen.size} file{chosen.size === 1 ? '' : 's'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function BranchDialog({ project, onClose, onSwitch }: { project: Project; onClose: () => void; onSwitch: (branch: string, create: boolean) => void }) {
  const [branches, setBranches] = useState<Branches | null>(null);
  const [name, setName] = useState('');
  useEffect(() => {
    api.gitBranches(project.repo.id).then(setBranches, (e) => notify(e.message, 'error'));
  }, [project.repo.id]);
  const remoteOnly = branches ? branches.remote.filter((r) => !branches.local.includes(r.replace(/^[^/]+\//, ''))) : [];

  return (
    <Dialog title="Branches" onClose={onClose}>
      <div className="dialog-body">
        {project.git?.changes.length ? <p className="muted small">Your uncommitted changes come along to the branch you switch to.</p> : null}
        {!branches ? (
          <p className="muted">Loading…</p>
        ) : (
          <ul className="branch-list">
            {branches.local.map((b) => (
              <li key={b}>
                <button type="button" className={`branch-row${b === branches.current ? ' current' : ''}`} disabled={b === branches.current} onClick={() => onSwitch(b, false)}>
                  <Icon name="branch" size={14} /> {b} {b === branches.current && <span className="muted small">current</span>}
                </button>
              </li>
            ))}
            {remoteOnly.map((r) => (
              <li key={r}>
                <button type="button" className="branch-row" onClick={() => onSwitch(r.replace(/^[^/]+\//, ''), false)}>
                  <Icon name="branch" size={14} /> {r.replace(/^[^/]+\//, '')} <span className="muted small">on the server</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onSwitch(name.trim(), true);
          }}
        >
          <label className="field grow">
            <span>New branch from here</span>
            <input value={name} onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))} placeholder="req/payment-retries" spellCheck={false} />
          </label>
          <button type="submit" className="button primary" disabled={!name.trim()}>
            Create
          </button>
        </form>
      </div>
    </Dialog>
  );
}
