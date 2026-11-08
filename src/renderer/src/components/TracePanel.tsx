// Beside an item: what it's linked to and whether those links still hold, its
// components, its problems, and its history.
import { useEffect, useMemo, useState } from 'react';
import { byEvidence, itemLinks, linksOf, refinesOf, verification, type Item, type ItemLink, type RefineLink } from '../../../core/model';
import { isRunnable, isVerifiable, linksFrom, linksTo, typeOf, typeWord } from '../../../core/config';
import { commitsFor } from '../../../core/commits';
import { SOURCE_LABEL } from '../../../core/links';
import type { FileCommit } from '../../../shared/api';
import type { Project } from '../project';
import { api } from '../api';
import { Icon } from '../icons';
import { lastResult, resultsFor, stepProblems, type CaseResult } from '../../../core/runs';
import { stepsOf } from '../../../core/steps';
import { LinkBadge, ResultPill, StatusPill, VariantTag, timeAgo } from './bits';
import type { RunFocus } from './RunsView';
import { Dialog } from './Dialog';
import { CompareDialog } from './Compare';

interface Props {
  project: Project;
  item: Item;
  onOpenId: (id: string) => void;
  onNewTest: (req: Item) => void;
  onNewRefinement: (req: Item) => void;
  onNewLinked: (kind: string, link: string, target: Item) => void; // a new item of `kind` linking to `target`
  onShowInGraph: (item: Item) => void;
  onOpenRun: (focus: RunFocus) => void;
}

export function TracePanel({ project, item, onOpenId, onNewTest, onNewRefinement, onNewLinked, onShowInGraph, onOpenRun }: Props) {
  const { index } = project;
  const links = linksOf(index, item);
  const problems = index.problems.filter((p) => p.path === item.path);
  const components = index.config.components.filter((c) => item.components.includes(c.key));
  const refines = refinesOf(index, item);
  const covered = useMemo(() => verification(index), [index]);
  const how = item.kind === 'requirement' && !links.length ? covered : null;
  const throughRefinements = how?.covered.get(item.id) === 'refinements';
  const declared = itemLinks(index, item);
  const outDefs = linksFrom(index.config, item.kind).filter((l) => !l.builtIn && (item.links[l.key]?.length ?? 0) > 0);
  const inDefs = linksTo(index.config, item.kind).filter((l) => !l.builtIn);
  const verifiable = isVerifiable(index.config, item.kind);
  const runnable = isRunnable(index.config, item.kind);
  const builtIn = verifiable || runnable;
  // What can verify it: test cases, and other runnable types.
  const testers = verifiable ? index.config.types.filter((t) => t.runnable).map((t) => t.key) : [];

  return (
    <aside className="trace-panel" aria-label="Traceability">
      <button type="button" className="button small graph-link" onClick={() => onShowInGraph(item)}>
        <Icon name="logo" size={14} /> Show in traceability graph
      </button>
      {builtIn && (
      <section>
        <div className="panel-head">
          <h3>{verifiable ? 'Verified by' : 'Verifies'}</h3>
          {testers.length === 1 && (
            <button type="button" className="link-button" onClick={() => (testers[0] === 'testcase' && item.kind === 'requirement' ? onNewTest(item) : onNewLinked(testers[0], 'verifies', item))}>
              <Icon name="plus" size={14} /> New {typeWord(index.config, testers[0])}
            </button>
          )}
        </div>
        {testers.length > 1 && (
          <div className="panel-new">
            {testers.map((k) => (
              <button key={k} type="button" className="link-button" onClick={() => onNewLinked(k, 'verifies', item)}>
                <Icon name="plus" size={14} /> New {typeWord(index.config, k)}
              </button>
            ))}
          </div>
        )}
        {links.length === 0 ? (
          how?.covered.get(item.id) === 'evidence' ? (
            <p className="muted small">
              No test case: it’s verified by {item.verification}, shown by {item.evidence.join(', ')}.
            </p>
          ) : throughRefinements ? (
            <p className="muted small">No test case of its own, but it’s covered: every requirement refining it is.</p>
          ) : how?.exempt.has(item.id) ? (
            <p className="muted small">No test case, and none needed: its verification is set to none.</p>
          ) : (
            <p className={`muted small${verifiable && item.status !== 'obsolete' && (item.kind === 'requirement' || index.config.rules.some((r) => r.type === item.kind && r.link === 'verifies')) ? ' gap-note' : ''}`}>
              {item.kind !== 'requirement'
                ? verifiable
                  ? `No test verifies this ${typeWord(index.config, item.kind)} yet.`
                  : item.kind === 'testcase'
                    ? 'This test case doesn’t verify a requirement yet. Add one under Verifies.'
                    : `This ${typeWord(index.config, item.kind)} doesn’t verify anything yet. Add it under Verifies.`
                : item.kind === 'requirement'
                ? byEvidence(item.verification) && !refines.down.length
                  ? `It’s to be verified by ${item.verification}, but no evidence is recorded yet. Add it under Evidence.`
                  : refines.down.length
                    ? 'No test case verifies this requirement, nor all the requirements refining it.'
                    : 'No test case verifies this requirement yet.'
                : ''}
            </p>
          )
        ) : (
          <ul className="link-list">
            {links.map((l) => {
              const other = verifiable ? l.test : l.req;
              return (
                <li key={other.id} className={`link-card ${l.state}`}>
                  <button type="button" className="link-target" onClick={() => onOpenId(other.id)}>
                    <span className="item-id">{other.id}</span>
                    <span className="link-title">{other.title}</span>
                  </button>
                  <div className="link-meta">
                    <StatusPill status={other.status} />
                    <VariantTag variants={other.variants} config={index.config} />
                    <LinkBadge state={l.state} />
                    {verifiable && <LastRun result={lastResult(project.runs, other.id)} config={index.config} onOpenRun={onOpenRun} />}
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
        {runnable && item.verifies.filter((v) => !index.byId.has(v)).length > 0 && (
          <p className="warn-text small">Not found: {item.verifies.filter((v) => !index.byId.has(v)).join(', ')}</p>
        )}
      </section>
      )}

      {item.kind === 'requirement' && (refines.up.length > 0 || item.refines.some((r) => !index.byId.has(r))) && (
        <section>
          <h3>Refines</h3>
          <RefineList links={refines.up} other={(l) => l.parent} project={project} onOpenId={onOpenId} />
          {item.refines.filter((v) => !index.byId.has(v)).length > 0 && <p className="warn-text small">Not found: {item.refines.filter((v) => !index.byId.has(v)).join(', ')}</p>}
        </section>
      )}
      {item.kind === 'requirement' && (
        <section>
          <div className="panel-head">
            <h3>Refined by</h3>
            <button type="button" className="link-button" onClick={() => onNewRefinement(item)}>
              <Icon name="plus" size={14} /> New requirement
            </button>
          </div>
          {refines.down.length === 0 ? (
            <p className="muted small">Nothing breaks it down. A requirement that does names it under Refines.</p>
          ) : (
            <RefineList links={refines.down} other={(l) => l.child} project={project} onOpenId={onOpenId} />
          )}
        </section>
      )}

      {outDefs.map((def) => {
        const missing = (item.links[def.key] ?? []).filter((id) => !declared.out.some((l) => l.def === def && l.to.id === id));
        return (
          <section key={`out-${def.key}`}>
            <h3>{def.name}</h3>
            <LinkList links={declared.out.filter((l) => l.def === def)} other={(l) => l.to} project={project} onOpenId={onOpenId} />
            {missing.length > 0 && <p className="warn-text small">Not found, or not a {def.to.map((k) => typeWord(index.config, k)).join(' or ')}: {missing.join(', ')}</p>}
          </section>
        );
      })}
      {inDefs.map((def) => {
        const links = declared.in.filter((l) => l.def === def);
        return (
          <section key={`in-${def.key}`}>
            <h3>{def.reverse}</h3>
            <div className="panel-new">
              {def.from.map((k) => (
                <button key={k} type="button" className="link-button" onClick={() => onNewLinked(k, def.key, item)}>
                  <Icon name="plus" size={14} /> New {typeWord(index.config, k)}
                </button>
              ))}
            </div>
            {links.length === 0 ? (
              <p className="muted small">
                Nothing yet. {article(def.from.map((k) => typeWord(index.config, k)).join(' or '))} that does names it under {def.name}.
              </p>
            ) : (
              <LinkList links={links} other={(l) => l.from} project={project} onOpenId={onOpenId} />
            )}
          </section>
        );
      })}

      {runnable && <Results project={project} item={item} onOpenRun={onOpenRun} />}

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
          No commits in {project.code.repo.name} name {isRunnable(project.index.config, item.kind) ? 'its ID, its Jira issues or those of the requirements it verifies' : 'its ID or its Jira issues'}.
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

const runWhen = (r: CaseResult) => [r.case.tester, r.case.date || r.run.created].filter(Boolean).join(', ');
const runName = (r: CaseResult, config: Project['index']['config']) =>
  r.run.variant ? `${r.run.name} (${config.variants.find((v) => v.key === r.run.variant)?.name ?? r.run.variant})` : r.run.name;

// A test's last result, beside it under "Verified by".
function LastRun({ result, config, onOpenRun }: { result: CaseResult | null; config: Project['index']['config']; onOpenRun: (focus: RunFocus) => void }) {
  if (!result) return <span className="muted small">Never run</span>;
  return (
    <button type="button" className="last-run" onClick={() => onOpenRun({ path: result.run.path, caseId: result.case.id })} title={`Last run in ${runName(result, config)} (${runWhen(result)})`}>
      <ResultPill result={result.case.result} />
      <span className="muted small">{runName(result, config)}</span>
    </button>
  );
}

function Results({ project, item, onOpenRun }: { project: Project; item: Item; onOpenRun: (focus: RunFocus) => void }) {
  const [all, setAll] = useState(false);
  const results = resultsFor(project.runs, item.id);
  return (
    <section>
      <h3>Test results</h3>
      {results.length === 0 ? (
        <p className="muted small">Not in a test run yet.</p>
      ) : (
        <ul className="history">
          {(all ? results : results.slice(0, 6)).map((r) => (
            <li key={r.run.path}>
              <button type="button" className="history-row" onClick={() => onOpenRun({ path: r.run.path, caseId: item.id })} title="Open this test run">
                <span className="result-line">
                  <ResultPill result={r.case.result} />
                  <span className="history-msg">{runName(r, project.index.config)}</span>
                </span>
                <span className="muted small">
                  {r.case.result === 'not-run' ? `To do · run created ${r.run.created}` : runWhen(r)}
                  {r.run.to ? ` · code ${r.run.to}` : ''}
                </span>
                {stepProblems(r.case, stepsOf(item.body).steps).map((p) => (
                  <span key={p} className="small warn-text">
                    {p}
                  </span>
                ))}
                {r.case.note && <span className="small result-note">{r.case.note}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {results.length > 6 && (
        <button type="button" className="link-button small" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${results.length}`}
        </button>
      )}
    </section>
  );
}

// Requirements linked by refines, with whether the link still holds.
function RefineList({ links, other, project, onOpenId }: { links: RefineLink[]; other: (l: RefineLink) => Item; project: Project; onOpenId: (id: string) => void }) {
  return (
    <ul className="link-list">
      {links.map((l) => {
        const o = other(l);
        return (
          <li key={o.id} className={`link-card ${l.state}`}>
            <button type="button" className="link-target" onClick={() => onOpenId(o.id)}>
              <span className="item-id">{o.id}</span>
              <span className="link-title">{o.title}</span>
            </button>
            <div className="link-meta">
              <StatusPill status={o.status} />
              <VariantTag variants={o.variants} config={project.index.config} />
              <LinkBadge state={l.state} />
            </div>
            {l.state !== 'ok' && (
              <div className="link-actions">
                {l.state === 'suspect' && (
                  <span className="muted small">
                    {l.parent.id} changed. Check {l.child.id} still breaks it down right, then mark it reviewed.
                  </span>
                )}
                <button type="button" className="button small" onClick={() => project.markReviewed(l.child, [l.parent.id])}>
                  <Icon name="check" size={14} /> Mark reviewed
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// Links of a declared type (mitigates, implements…), with whether each still holds.
function LinkList({ links, other, project, onOpenId }: { links: ItemLink[]; other: (l: ItemLink) => Item; project: Project; onOpenId: (id: string) => void }) {
  return (
    <ul className="link-list">
      {links.map((l) => {
        const o = other(l);
        return (
          <li key={`${l.def.key}:${o.id}`} className={`link-card ${l.state}`}>
            <button type="button" className="link-target" onClick={() => onOpenId(o.id)}>
              <span className="item-id">{o.id}</span>
              <span className="link-title">{o.title}</span>
            </button>
            <div className="link-meta">
              <span className="muted small">{typeOf(project.index.config, o.kind).name}</span>
              <StatusPill status={o.status} />
              <VariantTag variants={o.variants} config={project.index.config} />
              <LinkBadge state={l.state} />
            </div>
            {l.state !== 'ok' && (
              <div className="link-actions">
                {l.state === 'suspect' && (
                  <span className="muted small">
                    {l.to.id} changed. Check {l.from.id} still {l.def.name.toLowerCase()} it, then mark it reviewed.
                  </span>
                )}
                <button type="button" className="button small" onClick={() => project.markReviewed(l.from, [l.to.id])}>
                  <Icon name="check" size={14} /> Mark reviewed
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// "a requirement", "an architecture element": the article, capitalized to start a sentence.
const article = (words: string) => `${/^[aeiou]/i.test(words) ? 'An' : 'A'} ${words}`;
