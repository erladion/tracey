// Beside an item: what it's linked to and whether those links still hold, its
// components, its problems, and its history.
import { useEffect, useState } from 'react';
import { linksOf, type Item } from '../../../core/model';
import { commitsFor } from '../../../core/commits';
import { SOURCE_LABEL } from '../../../core/links';
import type { FileCommit } from '../../../shared/api';
import type { Project } from '../project';
import { api } from '../api';
import { Icon } from '../icons';
import { LinkBadge, StatusPill, timeAgo } from './bits';
import { Dialog } from './Dialog';
import { CompareDialog } from './Compare';

interface Props {
  project: Project;
  item: Item;
  onOpenId: (id: string) => void;
  onNewTest: (req: Item) => void;
  onShowInGraph: (item: Item) => void;
}

export function TracePanel({ project, item, onOpenId, onNewTest, onShowInGraph }: Props) {
  const { index } = project;
  const links = linksOf(index, item);
  const problems = index.problems.filter((p) => p.path === item.path);
  const components = index.config.components.filter((c) => item.components.includes(c.key));

  return (
    <aside className="trace-panel" aria-label="Traceability">
      <button type="button" className="button small graph-link" onClick={() => onShowInGraph(item)}>
        <Icon name="logo" size={14} /> Show in traceability graph
      </button>
      <section>
        <div className="panel-head">
          <h3>{item.kind === 'requirement' ? 'Verified by' : 'Verifies'}</h3>
          {item.kind === 'requirement' && (
            <button type="button" className="link-button" onClick={() => onNewTest(item)}>
              <Icon name="plus" size={14} /> New test case
            </button>
          )}
        </div>
        {links.length === 0 ? (
          <p className={`muted small${item.kind === 'requirement' && item.status !== 'obsolete' ? ' gap-note' : ''}`}>
            {item.kind === 'requirement' ? 'No test case verifies this requirement yet.' : 'This test case doesn’t verify a requirement yet. Add one under Verifies.'}
          </p>
        ) : (
          <ul className="link-list">
            {links.map((l) => {
              const other = item.kind === 'requirement' ? l.test : l.req;
              return (
                <li key={other.id} className={`link-card ${l.state}`}>
                  <button type="button" className="link-target" onClick={() => onOpenId(other.id)}>
                    <span className="item-id">{other.id}</span>
                    <span className="link-title">{other.title}</span>
                  </button>
                  <div className="link-meta">
                    <StatusPill status={other.status} />
                    <LinkBadge state={l.state} />
                  </div>
                  {l.state !== 'ok' && (
                    <div className="link-actions">
                      {l.state === 'suspect' && (
                        <span className="muted small">
                          {l.req.id} changed. Check {l.test.id} still tests what it says, then mark it reviewed.
                        </span>
                      )}
                      <button type="button" className="button small" onClick={() => project.markReviewed(l.test, [l.req.id])}>
                        <Icon name="check" size={14} /> Mark reviewed
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {item.kind === 'testcase' && item.verifies.filter((v) => !index.byId.has(v)).length > 0 && (
          <p className="warn-text small">Not found: {item.verifies.filter((v) => !index.byId.has(v)).join(', ')}</p>
        )}
      </section>

      {components.length > 0 && (
        <section>
          <h3>Components</h3>
          <ul className="plain-list">
            {components.map((c) => (
              <li key={c.key}>
                <span className="strong">{c.name}</span>
                <span className="muted small mono">{c.paths.join(', ') || 'no paths'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {problems.length > 0 && (
        <section>
          <h3>Problems</h3>
          <ul className="plain-list">
            {problems.map((p, i) => (
              <li key={i} className={p.severity === 'error' ? 'warn-text' : 'muted'}>
                {p.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <JiraIssues project={project} item={item} />

      <Commits project={project} item={item} />

      <History project={project} item={item} />
    </aside>
  );
}

function JiraIssues({ project, item }: { project: Project; item: Item }) {
  const links = project.links.byItem.get(item.id) ?? [];
  const jiraUrl = project.index.config.jiraUrl;
  if (!links.length) return null;
  return (
    <section>
      <h3>Jira issues</h3>
      <ul className="plain-list">
        {links.map((l) => {
          const is = project.links.issues.get(l.issue);
          return (
            <li key={l.issue} className="issue-row">
              <span>
                {jiraUrl ? (
                  <a className="mono small" href={`${jiraUrl}/browse/${encodeURIComponent(l.issue)}`} target="_blank" rel="noreferrer">
                    {l.issue}
                  </a>
                ) : (
                  <span className="mono small">{l.issue}</span>
                )}{' '}
                {is?.summary}
              </span>
              <span className="issue-meta">
                {is && <span className={`pill cat-${is.statusCategory || 'new'}`}>{is.status}</span>}
                {is?.fixVersions.length ? <span className="muted small">fix {is.fixVersions.join(', ')}</span> : null}
                {l.sources.map((s) => (
                  <span key={s} className="source-tag" title="Where the link is written">
                    {SOURCE_LABEL[s]}
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Commits({ project, item }: { project: Project; item: Item }) {
  const [all, setAll] = useState(false);
  if (!project.code.repo) return null;
  const found = commitsFor(item, project.commits, project.index, project.links);
  return (
    <section>
      <h3>Code commits</h3>
      {found.length === 0 ? (
        <p className="muted small">
          No commits in {project.code.repo.name} name {item.kind === 'requirement' ? 'its ID or its Jira issues' : 'its ID, its Jira issues or those of the requirements it verifies'}.
        </p>
      ) : (
        <ul className="history">
          {(all ? found : found.slice(0, 6)).map(({ linked, via }) => (
            <li key={linked.commit.hash} className="history-row static">
              <span className="history-msg" title={linked.commit.subject}>
                {linked.commit.subject}
              </span>
              <span className="muted small">
                <span className="mono">{linked.commit.hash.slice(0, 8)}</span> · {linked.commit.author} · {timeAgo(linked.commit.date)} · via <span className="mono">{via.join(', ')}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {found.length > 6 && (
        <button type="button" className="link-button small" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${found.length}`}
        </button>
      )}
    </section>
  );
}

function History({ project, item }: { project: Project; item: Item }) {
  const [log, setLog] = useState<FileCommit[] | null>(null);
  const [shown, setShown] = useState<number | null>(null); // a version, compared with the one before it
  // Look again after a commit, a branch switch or getting the latest.
  const gitKey = project.git ? `${project.git.branch}:${project.git.ahead}:${project.git.behind}:${project.git.changes.length}` : '';
  useEffect(() => {
    let live = true;
    setLog(null);
    if (!project.git) return;
    api
      .gitLog(project.repo.id, item.path)
      .then((l) => live && setLog(l))
      .catch(() => live && setLog([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.repo.id, item.path, gitKey]);

  if (!project.git) return null;
  return (
    <section>
      <h3>History</h3>
      {log === null ? (
        <p className="muted small">Loading…</p>
      ) : log.length === 0 ? (
        <p className="muted small">Not committed yet.</p>
      ) : (
        <ul className="history">
          {log.slice(0, 12).map((c) => (
            <li key={c.commit}>
              <button type="button" className="history-row" onClick={() => setShown(log.indexOf(c))} title="See what this commit changed">
                <span className="history-msg">{c.message}</span>
                <span className="muted small">
                  {c.author} · {timeAgo(c.date)} · <span className="mono">{c.commit.slice(0, 7)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {shown != null && log && <CompareDialog project={project} item={item} log={log} start={shown} against="previous" onClose={() => setShown(null)} />}
    </section>
  );
}
