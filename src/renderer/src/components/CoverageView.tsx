// The whole repository at a glance: what's tested, what isn't, which links need a
// look, and what's broken.
import { useMemo, useState } from 'react';
import { coverage, forVariant, type Link } from '../../../core/model';
import { describeSource, outcomeText, RESULT_MARK, resultMatrix, sourceRuns, verdictCounts, verdictSummary, type ResultSource } from '../../../core/verdict';
import { loadSource, saveSource, SourceSelect, VerdictPill } from './ResultSource';
import type { Project } from '../project';
import { Icon } from '../icons';
import { LinkBadge, StatusPill } from './bits';
import { ExportDialog } from './ExportDialog';
import { CoverageLine, ResultColumns, TrendTable } from './TrendCharts';
import { useTrend } from '../trend';
import { load, save } from '../storage';

interface Props {
  project: Project;
  onOpenId: (id: string) => void;
  onOpenPath: (path: string) => void;
  onVariant: (variant: string | null) => void;
}

type Filter = 'all' | 'gaps' | 'suspect' | 'failing' | 'blocked' | 'not-run';

export function CoverageView({ project, onOpenId, onOpenPath, onVariant }: Props) {
  const { index } = project;
  const cov = useMemo(() => coverage(index), [index]);
  const [filter, setFilter] = useState<Filter>('all');
  const [exporting, setExporting] = useState(false);
  const live = cov.requirements.filter((r) => r.status !== 'obsolete');
  const pct = live.length ? Math.round((cov.tested.length / live.length) * 100) : 0;
  const errors = cov.problems.filter((p) => p.severity === 'error');

  const [source, setSourceState] = useState<ResultSource>(() => loadSource(project.repo.id, project.runs));
  const setSource = (s: ResultSource) => {
    setSourceState(s);
    saveSource(project.repo.id, s);
  };
  const resultRuns = useMemo(() => sourceRuns(project.runs, source), [project.runs, source]);
  const oneRun = source.kind === 'run';
  const all = useMemo(() => resultMatrix(index, resultRuns ?? []), [index, resultRuns]);
  const counts = useMemo(() => verdictCounts(all), [all]);
  const shown = resultRuns ? filter : filter === 'failing' || filter === 'blocked' || filter === 'not-run' ? 'all' : filter;
  const rows = all.filter(({ req, links, verdict }) =>
    shown === 'gaps'
      ? req.status !== 'obsolete' && links.length === 0
      : shown === 'suspect'
        ? links.some((l) => l.state === 'suspect')
        : shown === 'failing'
          ? verdict === 'failing'
          : shown === 'blocked'
            ? verdict === 'blocked'
            : shown === 'not-run'
              ? verdict === 'not-run' || verdict === 'partial'
              : true,
  );
  const filters: [Filter, string, number | null][] = [
    ['all', 'All', null],
    ...(resultRuns
      ? ([
          ['failing', 'Failing', counts.failing],
          ['blocked', 'Blocked', counts.blocked],
          ['not-run', 'Not run', counts['not-run'] + counts.partial],
        ] as [Filter, string, number][])
      : []),
    ['gaps', 'No tests', cov.untested.length],
    ['suspect', 'Suspect', new Set(cov.suspect.map((l) => l.req.id)).size],
  ];

  const reviewAll = (links: Link[]) => {
    const byTest = new Map<string, Link[]>();
    for (const l of links) byTest.set(l.test.path, [...(byTest.get(l.test.path) ?? []), l]);
    for (const ls of byTest.values())
      project.markReviewed(
        ls[0].test,
        ls.map((l) => l.req.id),
      );
  };

  return (
    <div className="dashboard">
      <div className="dash-head graph-head">
        <div>
          <h1>Coverage</h1>
          <p className="muted">
            Requirements, the test cases that verify them, and links to check, in this branch’s files as they are now
            {project.variant ? (
              <>
                , for the variant <strong>{index.config.variants.find((v) => v.key === project.variant)?.name ?? project.variant}</strong>{' '}
                <button type="button" className="link-button" onClick={() => onVariant(null)}>
                  Show all
                </button>
              </>
            ) : null}
            .
          </p>
        </div>
        <button type="button" className="button" onClick={() => setExporting(true)}>
          <Icon name="download" /> Export…
        </button>
      </div>
      {exporting && <ExportDialog project={project} source={source} onClose={() => setExporting(false)} />}

      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Requirements</span>
          <span className="tile-value">{live.length}</span>
          <span className="tile-sub">{cov.requirements.length - live.length} obsolete not counted</span>
        </div>
        <div className="tile">
          <span className="tile-label">Verified by a test case</span>
          <span className="tile-value">
            {pct}% <span className="tile-of">{cov.tested.length} of {live.length}</span>
          </span>
          <span className="meter" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Without test cases</span>
          <span className={`tile-value${cov.untested.length ? ' warn' : ''}`}>{cov.untested.length}</span>
          <span className="tile-sub">
            {cov.orphans.length} test case{cov.orphans.length === 1 ? '' : 's'} verify nothing
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Links to review</span>
          <span className={`tile-value${cov.suspect.length ? ' warn' : ''}`}>{cov.suspect.length}</span>
          <span className="tile-sub">changed since review · {cov.unreviewed.length} never reviewed</span>
        </div>
      </div>

      {!project.variant && index.config.variants.length > 0 && <ByVariant project={project} onVariant={onVariant} />}

      <TrendCard project={project} />

      <div className="dash-columns">
        <section className="card grow">
          <div className="card-head">
            <h2>Traceability</h2>
            {project.runs.length > 0 && (
              <label className="results-from">
                <span>Results from</span>
                <SourceSelect runs={project.runs} value={source} onChange={setSource} />
              </label>
            )}
          </div>
          {resultRuns && (
            <p className="muted small results-note">
              {describeSource(project.runs, source).replace(/^./, (c) => c.toUpperCase())}. A requirement is verified when all of its test cases passed.{' '}
              <strong>{verdictSummary(all)}.</strong>
            </p>
          )}
          <div className="segmented small wrap" role="tablist" aria-label="Show">
            {filters.map(([f, label, n]) => (
              <button key={f} type="button" role="tab" aria-selected={shown === f} className={shown === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {label}
                {n != null && <span className="count"> {n}</span>}
              </button>
            ))}
          </div>
          <div className="table-scroll">
            <table className="matrix">
              <thead>
                <tr>
                  <th>Requirement</th>
                  <th>Status</th>
                  {resultRuns ? <th>Verdict</th> : <th>Components</th>}
                  <th>{resultRuns ? 'Test cases and their results' : 'Test cases'}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ req, links, verdict }) => (
                  <tr key={req.path} className={req.status === 'obsolete' ? 'obsolete' : ''}>
                    <td>
                      <button type="button" className="cell-link" onClick={() => onOpenId(req.id)}>
                        <span className="item-id">{req.id}</span>
                        <span>{req.title}</span>
                      </button>
                    </td>
                    <td>
                      <StatusPill status={req.status} />
                    </td>
                    {resultRuns ? (
                      <td>{verdict ? <VerdictPill verdict={verdict} /> : <span className="muted small">—</span>}</td>
                    ) : (
                      <td className="small">{req.components.join(', ') || <span className="muted">—</span>}</td>
                    )}
                    <td>
                      {links.length === 0 ? (
                        req.status === 'obsolete' || resultRuns ? (
                          <span className="muted small">—</span>
                        ) : (
                          <span className="pill gap-pill">No tests</span>
                        )
                      ) : (
                        <div className="test-chips">
                          {links.map((l) => {
                            const o = l.outcome;
                            const where = o.at ? ` in ${o.at.run.name}${o.at.case.tester ? `, ${o.at.case.tester}` : ''}${o.at.case.date ? `, ${o.at.case.date}` : ''}` : '';
                            const tip = `${l.test.id}: ${l.test.title}${resultRuns ? `\n${outcomeText(o, oneRun).replace(/^./, (c) => c.toUpperCase())}${where}` : ''}${
                              l.state === 'suspect' ? '\nThe requirement changed since this link was reviewed' : ''
                            }`;
                            return (
                              <button
                                key={l.test.id}
                                type="button"
                                className={`test-chip ${l.state}${resultRuns ? ' with-result' : ''}`}
                                onClick={() => onOpenId(l.test.id)}
                                title={tip}
                                aria-label={tip.replace(/\n/g, '. ')}
                              >
                                {resultRuns && (
                                  <span className={`mk ${o.result}${o.inRuns || o.result !== 'not-run' ? '' : ' absent'}`} aria-hidden="true">
                                    {RESULT_MARK[o.result]}
                                  </span>
                                )}
                                {l.state === 'suspect' && <Icon name="warn" size={12} />}
                                {l.test.id}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      {shown === 'all' ? 'No requirements yet.' : 'None.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="card attention">
          <h2>Needs attention</h2>
          {cov.suspect.length === 0 && cov.untested.length === 0 && cov.orphans.length === 0 && errors.length === 0 && cov.componentsWithoutTests.length === 0 && (
            <p className="muted">Nothing. Every requirement has a reviewed test case.</p>
          )}
          {cov.suspect.length > 0 && (
            <div className="attention-group">
              <h3>Requirements changed since their test cases were reviewed</h3>
              {cov.suspect.map((l) => (
                <div key={`${l.test.id}-${l.req.id}`} className="attention-item">
                  <span>
                    <button type="button" className="link-button mono" onClick={() => onOpenId(l.req.id)}>
                      {l.req.id}
                    </button>{' '}
                    changed;{' '}
                    <button type="button" className="link-button mono" onClick={() => onOpenId(l.test.id)}>
                      {l.test.id}
                    </button>{' '}
                    may no longer match.
                  </span>
                  <button type="button" className="button small" onClick={() => project.markReviewed(l.test, [l.req.id])}>
                    Mark reviewed
                  </button>
                </div>
              ))}
            </div>
          )}
          {cov.untested.length > 0 && (
            <div className="attention-group">
              <h3>No test cases</h3>
              <p className="id-list">
                {cov.untested.map((r) => (
                  <button key={r.path} type="button" className="link-button mono" onClick={() => onOpenId(r.id)} title={r.title}>
                    {r.id}
                  </button>
                ))}
              </p>
            </div>
          )}
          {cov.orphans.length > 0 && (
            <div className="attention-group">
              <h3>Test cases that verify nothing</h3>
              <p className="id-list">
                {cov.orphans.map((t) => (
                  <button key={t.path} type="button" className="link-button mono" onClick={() => onOpenId(t.id)} title={t.title}>
                    {t.id}
                  </button>
                ))}
              </p>
            </div>
          )}
          {cov.componentsWithoutTests.length > 0 && (
            <div className="attention-group">
              <h3>Components no test case covers</h3>
              <p>{cov.componentsWithoutTests.map((c) => c.name).join(', ')}</p>
            </div>
          )}
          {cov.problems.length > 0 && (
            <div className="attention-group">
              <h3>
                Problems ({errors.length} error{errors.length === 1 ? '' : 's'}, {cov.problems.length - errors.length} warning{cov.problems.length - errors.length === 1 ? '' : 's'})
              </h3>
              <ul className="problem-list">
                {cov.problems.map((p, i) => (
                  <li key={i} className={p.severity}>
                    <Icon name="warn" size={14} />
                    <span>
                      {p.message}{' '}
                      {p.path && p.path !== 'trace.yml' && (
                        <button type="button" className="link-button small" onClick={() => onOpenPath(p.path!)}>
                          Open
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {cov.unreviewed.length > 0 && (
            <div className="attention-group">
              <h3>Links never reviewed</h3>
              <p className="muted small">
                {cov.unreviewed.length} link{cov.unreviewed.length === 1 ? '' : 's'} have no record of the requirement text they were checked against, so later changes can’t be
                spotted. Mark them reviewed to start tracking.
              </p>
              <div className="link-meta">
                <LinkBadge state="unreviewed" />
                <button type="button" className="button small" onClick={() => reviewAll(cov.unreviewed)}>
                  Mark all {cov.unreviewed.length} reviewed
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function TrendCard({ project }: { project: Project }) {
  const points = useTrend(project);
  const [view, setView] = useState<'charts' | 'table'>(() => load<'charts' | 'table'>('trace.trendView') ?? 'charts');
  const choose = (v: 'charts' | 'table') => {
    setView(v);
    save('trace.trendView', v);
  };
  const runs = points?.filter((p) => p.run) ?? [];
  const unknown = runs.filter((p) => !p.coverage);
  return (
    <section className="card trend-card">
      <div className="card-head">
        <div>
          <h2>Coverage over time</h2>
          <p className="muted small">At each test run, with the requirements as they were when it was created, and now.</p>
        </div>
        {runs.length > 0 && (
          <div className="segmented small" role="tablist" aria-label="Show as">
            {(
              [
                ['charts', 'Charts'],
                ['table', 'Table'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => choose(v)}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {points === null ? (
        <p className="muted small">Reading the requirements at each run…</p>
      ) : runs.length === 0 ? (
        <p className="muted small">This fills in as you make test runs: each one records the requirements it started from and its results.</p>
      ) : view === 'charts' ? (
        <div className="trend-charts">
          <CoverageLine points={points} />
          <ResultColumns points={points} />
        </div>
      ) : (
        <TrendTable points={points} />
      )}
      {unknown.length > 0 && (
        <p className="muted small">
          Coverage isn’t known for {unknown.map((p) => p.label).join(', ')}: {unknown.length === 1 ? 'it doesn’t' : 'they don’t'} record a requirements commit, or that commit
          isn’t in this copy (get the latest).
        </p>
      )}
    </section>
  );
}

// Each variant's coverage: a requirement counts only when a test case for that
// variant verifies it.
function ByVariant({ project, onVariant }: { project: Project; onVariant: (variant: string) => void }) {
  const rows = useMemo(
    () =>
      project.allIndex.config.variants.map((v) => {
        const c = coverage(forVariant(project.allIndex, v.key));
        const live = c.requirements.filter((r) => r.status !== 'obsolete').length;
        return { v, live, tested: c.tested.length, untested: c.untested.length, suspect: c.suspect.length, pct: live ? Math.round((c.tested.length / live) * 100) : 0 };
      }),
    [project.allIndex],
  );
  return (
    <section className="card">
      <div className="card-head">
        <h2>By variant</h2>
        <span className="muted small">A requirement counts for a variant only when a test case for that variant verifies it.</span>
      </div>
      <div className="table-scroll">
        <table className="matrix variant-table">
          <thead>
            <tr>
              <th>Variant</th>
              <th className="num">Requirements</th>
              <th>Verified by a test case</th>
              <th className="num">Without tests</th>
              <th className="num">Links to review</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.v.key}>
                <td>
                  <button type="button" className="cell-link" onClick={() => onVariant(r.v.key)} title={`Show only what applies to ${r.v.name}`}>
                    <span>{r.v.name}</span>
                  </button>
                </td>
                <td className="num">{r.live}</td>
                <td>
                  <span className="variant-meter">
                    <span className="meter" aria-hidden="true">
                      <span style={{ width: `${r.pct}%` }} />
                    </span>
                    <span className="num">
                      {r.pct}% <span className="muted small">({r.tested})</span>
                    </span>
                  </span>
                </td>
                <td className={`num${r.untested ? ' warn-text' : ''}`}>{r.untested}</td>
                <td className={`num${r.suspect ? ' warn-text' : ''}`}>{r.suspect}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
