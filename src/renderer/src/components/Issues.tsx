// Everything that needs a look, in one place: the summary in the status bar, and the
// panel it opens. Errors (broken links, duplicate IDs), links to review (the linked item
// changed since), warnings, and gaps (no tests, a rule not met).
import { useState } from 'react';
import type { Coverage, Problem } from '../../../core/model';
import { typeOf } from '../../../core/config';
import type { Project } from '../project';
import { Icon } from '../icons';
import { Dialog } from './Dialog';

export interface IssueCounts {
  errors: number;
  review: number;
  warnings: number;
  gaps: number;
}

export function issueCounts(cov: Coverage): IssueCounts {
  const errors = cov.problems.filter((p) => p.severity === 'error').length;
  return {
    errors,
    review: cov.suspect.length + cov.suspectRefines.length + cov.suspectLinks.length,
    warnings: cov.problems.length - errors,
    gaps: cov.untested.length + cov.orphans.length + cov.rules.reduce((n, r) => n + r.missing.length, 0),
  };
}

const s = (n: number) => (n === 1 ? '' : 's');

// Each kind of issue has its icon and color, in the status bar and the panel alike.
export const ISSUE_ICON: Record<keyof IssueCounts, string> = { errors: 'error', review: 'warn', warnings: 'alert', gaps: 'gap' };
const Heading = ({ kind, children }: { kind: keyof IssueCounts; children: React.ReactNode }) => (
  <h3 className={`issue-heading issue-count ${kind}`}>
    <Icon name={ISSUE_ICON[kind]} size={16} />
    {children}
  </h3>
);

// The status bar's summary: only what isn't zero; nothing at all when all's well.
export function IssuesButton({
  project,
  cov,
  onOpenId,
  onOpenPath,
  onSettings,
}: {
  project: Project;
  cov: Coverage;
  onOpenId: (id: string) => void;
  onOpenPath: (path: string) => void;
  onSettings: () => void;
}) {
  const c = issueCounts(cov);
  const [open, setOpen] = useState(false);
  const parts = (
    [
      ['errors', c.errors, `${c.errors} error${s(c.errors)}`],
      ['review', c.review, `${c.review} to review`],
      ['warnings', c.warnings, `${c.warnings} warning${s(c.warnings)}`],
      ['gaps', c.gaps, `${c.gaps} gap${s(c.gaps)}`],
    ] as const
  ).filter(([, n]) => n);
  return (
    <>
      <button type="button" className="bar-button issues-button" onClick={() => setOpen(true)} title="What needs a look: click for the list">
        {parts.length ? (
          parts.map(([k, , label]) => (
            <span key={k} className={`issue-count ${k}`}>
              <Icon name={ISSUE_ICON[k]} size={14} />
              {label}
            </span>
          ))
        ) : (
          <span className="issue-count none">
            <Icon name="check" size={14} />
            No issues
          </span>
        )}
      </button>
      {open && <IssuesDialog project={project} cov={cov} onOpenId={onOpenId} onOpenPath={onOpenPath} onSettings={onSettings} onClose={() => setOpen(false)} />}
    </>
  );
}

const MAX = 100; // per section; the rest are on the Coverage page

function IssuesDialog({
  project,
  cov,
  onOpenId,
  onOpenPath,
  onSettings,
  onClose,
}: {
  project: Project;
  cov: Coverage;
  onOpenId: (id: string) => void;
  onOpenPath: (path: string) => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const c = issueCounts(cov);
  const config = project.index.config;
  const go = (f: () => void) => () => {
    onClose();
    f();
  };
  const openProblem = (p: Problem) => (p.id ? go(() => onOpenId(p.id!)) : p.path === 'trace.yml' ? go(onSettings) : p.path ? go(() => onOpenPath(p.path!)) : undefined);
  const id = (x: string) => (
    <button type="button" className="link-button mono" onClick={go(() => onOpenId(x))}>
      {x}
    </button>
  );
  const more = (n: number) => (n > MAX ? <li className="muted small">and {n - MAX} more: see Coverage.</li> : null);
  const review = [
    ...cov.suspect.map((l) => ({ key: `v${l.test.id}${l.req.id}`, changed: l.req.id, by: l.test.id, how: 'verifies it', mark: () => project.markReviewed(l.test, [l.req.id]) })),
    ...cov.suspectRefines.map((l) => ({ key: `r${l.child.id}${l.parent.id}`, changed: l.parent.id, by: l.child.id, how: 'refines it', mark: () => project.markReviewed(l.child, [l.parent.id]) })),
    ...cov.suspectLinks.map((l) => ({ key: `d${l.from.id}${l.to.id}`, changed: l.to.id, by: l.from.id, how: `${l.def.name.toLowerCase()} it`, mark: () => project.markReviewed(l.from, [l.to.id]) })),
  ];
  const errors = cov.problems.filter((p) => p.severity === 'error');
  const warnings = cov.problems.filter((p) => p.severity === 'warning');
  const nothing = !c.errors && !c.review && !c.warnings && !c.gaps;

  return (
    <Dialog title="Issues" onClose={onClose} wide>
      <div className="dialog-body issues">
        {nothing && <p className="muted">Nothing needs a look: no errors, no links to review, no warnings, and every requirement and rule is covered.</p>}
        {errors.length > 0 && (
          <section>
            <Heading kind="errors">Errors ({errors.length})</Heading>
            <p className="muted small">The files say something that can’t be right: fix these first.</p>
            <ul className="issue-list">
              {errors.slice(0, MAX).map((p, i) => (
                <li key={i}>
                  <button type="button" className="link-button issue-open" onClick={openProblem(p)}>
                    {p.message}
                  </button>
                  {p.path && <span className="muted small mono">{p.path}</span>}
                </li>
              ))}
              {more(errors.length)}
            </ul>
          </section>
        )}
        {review.length > 0 && (
          <section>
            <Heading kind="review">To review ({review.length})</Heading>
            <p className="muted small">Changed since what links to it was reviewed: check the link still holds, then mark it reviewed.</p>
            <ul className="issue-list">
              {review.slice(0, MAX).map((r) => (
                <li key={r.key}>
                  <span>
                    {id(r.changed)} changed; {id(r.by)} {r.how}.
                  </span>
                  <button type="button" className="button small" onClick={r.mark}>
                    Mark reviewed
                  </button>
                </li>
              ))}
              {more(review.length)}
            </ul>
          </section>
        )}
        {c.gaps > 0 && (
          <section>
            <Heading kind="gaps">Gaps ({c.gaps})</Heading>
            {cov.untested.length > 0 && (
              <p className="issue-ids">
                <span className="muted small">Not covered: </span>
                {cov.untested.slice(0, MAX).map((r) => (
                  <span key={r.id}>{id(r.id)} </span>
                ))}
                {cov.untested.length > MAX && <span className="muted small">and {cov.untested.length - MAX} more</span>}
              </p>
            )}
            {cov.orphans.length > 0 && (
              <p className="issue-ids">
                <span className="muted small">Verify nothing: </span>
                {cov.orphans.slice(0, MAX).map((t) => (
                  <span key={t.id}>{id(t.id)} </span>
                ))}
                {cov.orphans.length > MAX && <span className="muted small">and {cov.orphans.length - MAX} more</span>}
              </p>
            )}
            {cov.rules
              .filter((r) => r.missing.length)
              .map((r, i) => (
                <p key={i} className="issue-ids">
                  <span className="muted small">
                    {typeOf(config, r.rule.type).plural}, {r.rule.tag.toLowerCase()}:{' '}
                  </span>
                  {r.missing.slice(0, MAX).map((it) => (
                    <span key={it.id}>{id(it.id)} </span>
                  ))}
                  {r.missing.length > MAX && <span className="muted small">and {r.missing.length - MAX} more</span>}
                </p>
              ))}
          </section>
        )}
        {warnings.length > 0 && (
          <section>
            <Heading kind="warnings">Warnings ({warnings.length})</Heading>
            <ul className="issue-list">
              {warnings.slice(0, MAX).map((p, i) => (
                <li key={i}>
                  <button type="button" className="link-button issue-open" onClick={openProblem(p)}>
                    {p.message}
                  </button>
                  {p.path && <span className="muted small mono">{p.path}</span>}
                </li>
              ))}
              {more(warnings.length)}
            </ul>
          </section>
        )}
        <div className="dialog-actions">
          <span className="tool-spacer" />
          <button type="button" className="button primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
