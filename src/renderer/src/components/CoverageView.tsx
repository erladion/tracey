// The whole repository at a glance: what's tested, what isn't, which links need a
// look, and what's broken.
import { useMemo, useState } from 'react';
import { coverage, linksOf, type Link } from '../../../core/model';
import type { Project } from '../project';
import { Icon } from '../icons';
import { LinkBadge, StatusPill } from './bits';
import { ExportDialog } from './ExportDialog';

interface Props {
  project: Project;
  onOpenId: (id: string) => void;
  onOpenPath: (path: string) => void;
}

type Filter = 'all' | 'gaps' | 'suspect';

export function CoverageView({ project, onOpenId, onOpenPath }: Props) {
  const { index } = project;
  const cov = useMemo(() => coverage(index), [index]);
  const [filter, setFilter] = useState<Filter>('all');
  const [exporting, setExporting] = useState(false);
  const live = cov.requirements.filter((r) => r.status !== 'obsolete');
  const pct = live.length ? Math.round((cov.tested.length / live.length) * 100) : 0;
  const errors = cov.problems.filter((p) => p.severity === 'error');

  const rows = useMemo(
    () =>
      cov.requirements
        .map((r) => ({ req: r, links: linksOf(index, r) }))
        .filter(({ req, links }) =>
          filter === 'gaps' ? req.status !== 'obsolete' && links.length === 0 : filter === 'suspect' ? links.some((l) => l.state === 'suspect') : true,
        ),
    [cov, index, filter],
  );

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
          <p className="muted">Requirements, the test cases that verify them, and links to check, in this branch’s files as they are now.</p>
        </div>
        <button type="button" className="button" onClick={() => setExporting(true)}>
          <Icon name="download" /> Export PDF
        </button>
      </div>
      {exporting && <ExportDialog project={project} onClose={() => setExporting(false)} />}

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

      <div className="dash-columns">
        <section className="card grow">
          <div className="card-head">
            <h2>Traceability</h2>
            <div className="segmented small" role="tablist">
              {(
                [
                  ['all', 'All'],
                  ['gaps', `No tests (${cov.untested.length})`],
                  ['suspect', `Suspect (${new Set(cov.suspect.map((l) => l.req.id)).size})`],
                ] as const
              ).map(([f, label]) => (
                <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="table-scroll">
            <table className="matrix">
              <thead>
                <tr>
                  <th>Requirement</th>
                  <th>Status</th>
                  <th>Components</th>
                  <th>Test cases</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ req, links }) => (
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
                    <td className="small">{req.components.join(', ') || <span className="muted">—</span>}</td>
                    <td>
                      {links.length === 0 ? (
                        req.status === 'obsolete' ? (
                          <span className="muted small">—</span>
                        ) : (
                          <span className="pill gap-pill">No tests</span>
                        )
                      ) : (
                        <div className="test-chips">
                          {links.map((l) => (
                            <button key={l.test.id} type="button" className={`test-chip ${l.state}`} onClick={() => onOpenId(l.test.id)} title={`${l.test.id}: ${l.test.title}`}>
                              {l.state === 'suspect' && <Icon name="warn" size={12} />}
                              {l.test.id}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      {filter === 'all' ? 'No requirements yet.' : 'None.'}
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
