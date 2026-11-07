// Choosing a repository: one opened before, a folder, a clone, or a new project.
import { useEffect, useState } from 'react';
import type { RepoEntry } from '../../../shared/api';
import { api, platform } from '../api';
import { Icon } from '../icons';
import { notify } from '../notify';

export function StartScreen({ onOpen }: { onOpen: (r: RepoEntry) => void }) {
  const [repos, setRepos] = useState<RepoEntry[] | null>(null);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [examples, setExamples] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () =>
    api
      .listRepos()
      .then(setRepos)
      .catch((e) => notify(e.message, 'error'));
  useEffect(() => {
    void refresh();
  }, []);

  const attempt = async (what: string, f: () => Promise<RepoEntry | null>) => {
    setBusy(what);
    try {
      const r = await f();
      if (r) onOpen(r);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="start">
      <div className="start-inner">
        <header className="start-head">
          <span className="brand-mark large">
            <Icon name="logo" size={28} />
          </span>
          <div>
            <h1>Tracey</h1>
            <p>Requirements and test cases as Markdown in git, linked both ways.</p>
          </div>
        </header>

        <div className="start-grid">
          <section className="card">
            <h2>{platform === 'desktop' ? 'Recent repositories' : 'Repositories on this server'}</h2>
            {repos === null ? (
              <p className="muted">Loading…</p>
            ) : repos.length === 0 ? (
              <p className="muted">None yet. Clone one or start a new project.</p>
            ) : (
              <ul className="repo-list">
                {repos.map((r) => (
                  <li key={r.id}>
                    <button type="button" className="repo-row" onClick={() => attempt(r.id, () => api.openRepo(r.id))} disabled={!!busy}>
                      <Icon name="folder" />
                      <span className="repo-row-text">
                        <span className="repo-row-name">{r.name}</span>
                        <span className="repo-row-path">{r.location}</span>
                      </span>
                    </button>
                    {platform === 'desktop' && (
                      <button type="button" className="icon-button" aria-label={`Forget ${r.name}`} title="Remove from this list" onClick={() => api.forgetRepo(r.id).then(refresh)}>
                        <Icon name="close" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {platform === 'desktop' && (
              <button type="button" className="button" onClick={() => attempt('folder', () => api.openFolder())} disabled={!!busy}>
                <Icon name="folder" /> Open a folder…
              </button>
            )}
          </section>

          <div className="start-side">
            <section className="card">
              <h2>Clone a repository</h2>
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (url.trim()) void attempt('clone', () => api.cloneRepo(url.trim()));
                }}
              >
                <label className="field">
                  <span>Repository address</span>
                  <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://bitbucket.example.com/scm/proj/repo.git" spellCheck={false} />
                </label>
                <p className="hint">Uses your git credentials{platform === 'web' ? ' on the server' : ''} (credential helper or SSH key).</p>
                <button type="submit" className="button primary" disabled={!!busy || !url.trim()}>
                  <Icon name="download" /> {busy === 'clone' ? 'Cloning…' : 'Clone'}
                </button>
              </form>
            </section>

            <section className="card">
              <h2>New project</h2>
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim()) void attempt('new', () => api.createProject(name.trim(), examples));
                }}
              >
                <label className="field">
                  <span>Name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="payments-requirements" spellCheck={false} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={examples} onChange={(e) => setExamples(e.target.checked)} />
                  <span>Include example requirements and test cases</span>
                </label>
                <button type="submit" className="button" disabled={!!busy || !name.trim()}>
                  <Icon name="plus" /> Create
                </button>
              </form>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
