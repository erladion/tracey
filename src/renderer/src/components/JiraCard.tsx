// Settings: the Jira connection, and where issues may name requirements and test cases.
import { useMemo, useState } from 'react';
import type { Project } from '../project';
import { api } from '../api';
import { Icon } from '../icons';
import { notify } from '../notify';
import { SOURCE_LABEL, linkQuery, type LinkSource } from '../../../core/links';

export function JiraCard({ project }: { project: Project }) {
  const { jira, links, index } = project;
  const cfg = index.config;
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const counts = useMemo(() => {
    const c: Record<LinkSource, number> = { 'front-matter': 0, label: 0, field: 0, text: 0, 'remote-link': 0 };
    for (const ls of links.byIssue.values()) for (const l of ls) for (const s of l.sources) c[s]++;
    return c;
  }, [links]);

  if (!cfg.jiraUrl)
    return (
      <section className="card">
        <h2>Jira</h2>
        <p className="muted">
          Not set up. Add <code>jira: {'{'} url: https://jira.example.com {'}'}</code> to trace.yml below (and <code>api: 3</code> for Jira Cloud). Without it, issue keys
          in front matter and commit messages still link; with it, Trace also reads the issues, so their labels, a field, their text and their remote links can name
          requirements and test cases too.
        </p>
      </section>
    );

  const own = !!jira.status?.hasToken && !jira.status.shared; // a token of the user's own is saved
  const server = jira.server ?? { url: cfg.jiraUrl, api: cfg.jira.api };
  const save = async (t: string) => {
    setBusy(true);
    try {
      await api.jiraSetToken(server, t, cfg.jira.api === 3 ? email : null);
      setToken('');
      await project.refreshJira();
      notify(t ? 'Token saved.' : 'Token removed.', 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Jira</h2>
      <dl className="settings-summary">
        <dt>Server</dt>
        <dd>
          <a href={cfg.jiraUrl} target="_blank" rel="noreferrer">
            {cfg.jiraUrl}
          </a>{' '}
          · {cfg.jira.api === 3 ? 'Cloud (API 3)' : 'Data Center / Server (API 2)'}
        </dd>
        <dt>Issues read</dt>
        <dd>
          <code>{linkQuery(index, links) ?? '(no projects known yet: set jira.projects)'}</code> plus every key named in front matter or commits, up to {cfg.jira.max}
        </dd>
        <dt>Links from</dt>
        <dd>
          front matter{cfg.jira.links.map((l) => `, ${l === 'field' ? `the field “${cfg.jira.field ?? '(set jira.field)'}”` : l === 'text' ? 'summary and description' : l}`).join('')}
        </dd>
      </dl>

      <div className="code-status">
        {jira.loading ? (
          <span className="muted">Reading Jira…</span>
        ) : jira.error ? (
          <span className="warn-text">{jira.error}</span>
        ) : jira.status?.error ? (
          <span className="warn-text">{jira.status.error}</span>
        ) : jira.status?.user ? (
          <>
            <span>
              Signed in as <span className="strong">{jira.status.user}</span>
              {jira.status.shared ? <span className="muted"> (the server's shared token: add your own below to read Jira as yourself)</span> : ''}. {jira.read} issues read.
            </span>
            <span className="muted small">
              Links found:{' '}
              {(Object.keys(counts) as LinkSource[])
                .filter((k) => counts[k])
                .map((k) => `${counts[k]} by ${SOURCE_LABEL[k]}`)
                .join(', ') || 'none'}
              {jira.missing.length > 0 && <span className="warn-text"> · not in Jira: {jira.missing.join(', ')}</span>}
            </span>
          </>
        ) : jira.status && !jira.status.hasToken ? (
          <span className="muted">No token yet: add your own below.</span>
        ) : (
          <span className="muted">Not read yet.</span>
        )}
      </div>

      {jira.status?.canStore !== false && (
        <form
          className="inline-form wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void save(token);
          }}
        >
          {cfg.jira.api === 3 && (
            <label className="field">
              <span>Atlassian account email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            </label>
          )}
          <label className="field grow">
            <span>{cfg.jira.api === 3 ? 'API token' : 'Personal access token'} (kept encrypted {jira.status?.storedIn === 'browser' ? 'in this browser' : 'on this computer'})</span>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder={own ? '•••••••• (saved)' : ''} />
          </label>
          <button type="submit" className="button primary" disabled={busy || !token.trim() || (cfg.jira.api === 3 && !email.trim())}>
            Save token
          </button>
          {own && (
            <button type="button" className="button" disabled={busy} onClick={() => void save('')}>
              Remove
            </button>
          )}
        </form>
      )}
      <div className="dialog-actions">
        <button type="button" className="button" onClick={() => void project.refreshJira()} disabled={jira.loading}>
          <Icon name="refresh" /> Read again
        </button>
        <span className="muted small">
          {cfg.jira.api === 3 ? 'Create a token at id.atlassian.com → Security → API tokens.' : 'Create a token in Jira under your profile → Personal Access Tokens.'}
        </span>
      </div>
    </section>
  );
}
