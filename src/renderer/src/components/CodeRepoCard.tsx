// Settings: which repository's commits link to Jira issues.
import { useEffect, useState } from 'react';
import type { RepoEntry } from '../../../shared/api';
import type { Project } from '../project';
import { api, platform } from '../api';
import { Icon } from '../icons';
import { notify } from '../notify';

export function CodeRepoCard({ project }: { project: Project }) {
  const { code, commits, index } = project;
  const settings = index.config.code;
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    api.listRepos().then(setRepos, () => {});
  }, [code.repo?.id]);

  const attempt = async (what: string, f: () => Promise<RepoEntry | null>) => {
    setBusy(what);
    try {
      const r = await f();
      if (r) project.setCodeRepo(r);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const linked = commits.filter((c) => c.issues.length || c.items.length).length;
  const others = repos.filter((r) => r.id !== project.repo.id);

  return (
    <section className="card">
      <h2>Code repository</h2>
      <p className="muted">
        Commits in the code repository name Jira issues (<code>PROJ-466: …</code>). Trace reads them to link each commit to the requirements naming that issue, and on to their
        test cases. It only reads this repository; it never changes it.
      </p>
      <dl className="settings-summary">
        <dt>In trace.yml</dt>
        <dd>
          {settings.repository ? <code>{settings.repository}</code> : <span className="muted">No <code>code.repository</code> set, so it can't be found by itself.</span>}
          {settings.branch && (
            <>
              {' '}
              · branch <code>{settings.branch}</code>
            </>
          )}
        </dd>
        <dt>Jira projects</dt>
        <dd>{index.config.jiraProjects.length ? index.config.jiraProjects.join(', ') : 'Those used in requirements’ jira: fields'}</dd>
      </dl>

      <div className="code-status">
        {code.repo ? (
          <>
            <span>
              Reading commits from <span className="strong">{code.repo.name}</span> <span className="muted small">({code.repo.location})</span>
              {code.how === 'found' && <span className="muted small"> · found by its address</span>}
              {code.how === 'chosen' && <span className="muted small"> · chosen on this computer</span>}
            </span>
            <span className="muted small">
              {code.loading ? 'Reading…' : code.error ? <span className="warn-text">{code.error}</span> : `${code.count} commits read, ${linked} name a Jira issue or item.`}
            </span>
          </>
        ) : (
          <span className="muted">Not connected.</span>
        )}
      </div>

      <div className="dialog-actions">
        {settings.repository && !code.repo && (
          <button type="button" className="button primary" disabled={!!busy} onClick={() => attempt('clone', () => api.cloneRepo(settings.repository!))}>
            <Icon name="download" /> {busy === 'clone' ? 'Cloning…' : 'Clone it'}
          </button>
        )}
        {platform === 'desktop' && (
          <button type="button" className="button" disabled={!!busy} onClick={() => attempt('folder', () => api.openFolder())}>
            <Icon name="folder" /> Choose its folder…
          </button>
        )}
        {others.length > 0 && (
          <select
            className="button"
            value=""
            aria-label="Use a repository Trace knows"
            onChange={(e) => {
              const r = others.find((x) => x.id === e.target.value);
              if (r) project.setCodeRepo(r);
            }}
          >
            <option value="">Use another repository…</option>
            {others.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="button" onClick={() => project.setCodeRepo(project.repo)} disabled={code.repo?.id === project.repo.id}>
          Code is in this repository
        </button>
        {code.repo && (
          <>
            <button type="button" className="button" onClick={() => void project.reloadCommits()} disabled={code.loading}>
              <Icon name="refresh" /> Read again
            </button>
            {code.how === 'chosen' && (
              <button type="button" className="link-button" onClick={() => project.setCodeRepo(null)}>
                Disconnect
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
