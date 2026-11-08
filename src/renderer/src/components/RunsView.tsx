// Test runs: pick the test cases a release needs (from the commits between two
// versions), record a result for each, and produce a report.
import { useEffect, useMemo, useState } from 'react';
import MarkdownIt from 'markdown-it';
import type { Project } from '../project';
import { compareIds, forVariant, type Item } from '../../../core/model';
import { isRunnable } from '../../../core/config';
import { linkCommits } from '../../../core/commits';
import { buildIssueLinks, projectsOf } from '../../../core/links';
import type { Commit, JiraIssue } from '../../../shared/api';
import { impact, reasonText, type Impact } from '../../../core/impact';
import { addCases, newRunText, releaseFrom, removeCase, resultFromSteps, runPath, setCase, setRelease as setRunRelease, setStep, stepProblems, summarize, today, RESULTS, type Result, type RunCase, type TestRun } from '../../../core/runs';
import { stepsOf } from '../../../core/steps';
import { releases } from '../../../core/verdict';
import { estimateOf, estimateText, formatDuration, runEstimate } from '../../../core/estimate';
import { reportHtml, reportMarkdown } from '../../../core/report';
import { slug } from '../../../core/model';
import { api } from '../api';
import { savePdf } from '../pdf';
import { download } from '../download';
import { Icon } from '../icons';
import { notify } from '../notify';
import { Dialog } from './Dialog';
import { RESULT_LABEL, ShowMore, StatusPill, useShown, VariantTag } from './bits';
import { load, save } from '../storage';

// Test steps are shown as formatted text; raw HTML in them is shown as text.
const md = MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough']);

// A run to open, and the case to show in it.
export interface RunFocus {
  path: string;
  caseId: string;
}

export function RunsView({ project, focus, onOpenId, fromWork = 0 }: { project: Project; focus?: RunFocus | null; onOpenId: (id: string) => void; fromWork?: number }) {
  const { runs } = project;
  const key = `trace.run.${project.repo.id}`;
  const [selected, setSelected] = useState<string | null>(() => focus?.path ?? load<string>(key));
  const [creating, setCreating] = useState<false | 'any' | 'work'>(fromWork ? 'work' : false);
  // Asked for from the work list while this view was open.
  useEffect(() => {
    if (fromWork) setCreating('work');
  }, [fromWork]);
  useEffect(() => save(key, selected), [key, selected]);
  const run = runs.find((r) => r.path === selected) ?? null;

  return (
    <>
      <aside className="sidebar runs-sidebar" aria-label="Test runs">
        <button type="button" className="button primary" onClick={() => setCreating('any')}>
          <Icon name="plus" /> New test run
        </button>
        <ul className="item-list">
          {runs.map((r) => {
            const s = summarize(r);
            const left = s.notRun ? runEstimate(r, project.allIndex).left : null;
            return (
              <li key={r.path}>
                <button type="button" className={`item-row${r.path === selected ? ' selected' : ''}`} onClick={() => setSelected(r.path)}>
                  <span className="item-title">
                    {r.name} {r.variant && <VariantTag variants={[r.variant]} config={project.allIndex.config} />}
                  </span>
                  <span className="muted small">
                    {r.from || r.to ? `${r.from} → ${r.to} · ` : ''}
                    {r.created}
                  </span>
                  <ProgressBar s={s} />
                  <span className="muted small">
                    {s.done} of {s.total} run{s.failed ? ` · ${s.failed} failed` : ''}
                    {left?.counted ? ` · ${formatDuration(left.minutes)}${left.missing ? '+' : ''} left` : ''}
                  </span>
                </button>
              </li>
            );
          })}
          {runs.length === 0 && <li className="muted list-empty">No test runs yet.</li>}
        </ul>
      </aside>
      <main className="main">
        {run ? (
          <RunDetail key={run.path} project={project} run={run} focusCase={focus?.path === run.path ? focus.caseId : null} onOpenId={onOpenId} onDeleted={() => setSelected(null)} />
        ) : (
          <div className="empty-state">
            <h2>Test runs</h2>
            <p>
              A test run lists the test cases to run for a release: those reached from the commits between two versions of the code, through their Jira issues and the
              components they change. Record a result for each, then download the report.
            </p>
            <button type="button" className="button primary" onClick={() => setCreating('any')}>
              <Icon name="plus" /> New test run
            </button>
          </div>
        )}
      </main>
      {creating && (
        <NewRunDialog
          project={project}
          fromWork={creating === 'work'}
          onClose={() => setCreating(false)}
          onCreated={(path) => {
            setCreating(false);
            setSelected(path);
          }}
        />
      )}
    </>
  );
}

function ProgressBar({ s }: { s: ReturnType<typeof summarize> }) {
  const part = (n: number, cls: string) => (n ? <span className={cls} style={{ flex: n }} /> : null);
  return (
    <span className="progress" aria-hidden="true">
      {part(s.passed, 'passed')}
      {part(s.failed, 'failed')}
      {part(s.blocked, 'blocked')}
      {part(s.notRun, 'not-run')}
    </span>
  );
}

// ---- one run ----------------------------------------------------------------------

type Filter = 'all' | 'todo' | 'problems' | 'passed';
const STEP_MARK: Record<'passed' | 'failed' | 'blocked', string> = { passed: '✓', failed: '✕', blocked: '!' };

function RunDetail({
  project,
  run,
  focusCase,
  onOpenId,
  onDeleted,
}: {
  project: Project;
  run: TestRun;
  focusCase: string | null;
  onOpenId: (id: string) => void;
  onDeleted: () => void;
}) {
  // Every item: a run may hold test cases the chosen variant doesn't show.
  const index = project.allIndex;
  const s = summarize(run);
  const est = useMemo(() => runEstimate(run, index), [run, index]);
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(focusCase);
  useEffect(() => {
    if (focusCase) document.querySelector(`[data-case="${CSS.escape(focusCase)}"]`)?.scrollIntoView({ block: 'center' });
  }, [focusCase]);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tester, setTester] = useState(() => load<string>('trace.tester') ?? load<{ name: string }>('trace.author')?.name ?? '');
  useEffect(() => save('trace.tester', tester || null), [tester]);

  // Whose cases: anyone's, mine (the tester's), nobody's yet, or one person's.
  const [assigned, setAssigned] = useState<string>(() => load<string>(`trace.runAssigned.${run.path}`) ?? '');
  useEffect(() => save(`trace.runAssigned.${run.path}`, assigned || null), [assigned, run.path]);
  const me = tester.trim();
  const whose = (c: RunCase) => (assigned === '' ? true : assigned === '\u0000me' ? !!me && c.assignee === me : assigned === '\u0000none' ? !c.assignee : c.assignee === assigned);
  // Search: every word somewhere in the case's ID, title, assignee, tester or notes.
  const [query, setQuery] = useState('');
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (c: RunCase) => {
    if (!words.length) return true;
    const hay = [c.id, index.byId.get(c.id)?.title ?? '', c.assignee, c.tester, c.note, ...Object.values(c.stepNotes)].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const cases = run.cases.filter(
    (c) =>
      whose(c) &&
      matches(c) &&
      (filter === 'todo' ? c.result === 'not-run' : filter === 'problems' ? c.result === 'failed' || c.result === 'blocked' : filter === 'passed' ? c.result === 'passed' : true),
  );
  // Everyone who has tested or been assigned in any run: suggestions for assigning.
  const people = useMemo(
    () => [...new Set([...project.runs.flatMap((r) => r.cases.flatMap((c) => [c.tester, c.assignee])), me].map((x) => x.trim()).filter(Boolean))].sort(),
    [project.runs, me],
  );
  const assignees = [...new Set(run.cases.map((c) => c.assignee).filter(Boolean))].sort();
  // A page of cases at a time; the open one is always shown.
  const page = useShown(cases.length, 200, `${run.path}\u0000${filter}\u0000${assigned}\u0000${query}`, cases.findIndex((c) => c.id === open));
  const [assignTo, setAssignTo] = useState('');

  const needTester = () => {
    if (me) return false;
    notify('Enter your name as tester first.', 'error');
    document.getElementById('tester')?.focus();
    return true;
  };
  const record = (c: RunCase, result: Result) => {
    if (result !== 'not-run' && needTester()) return;
    project.updateFile(run.path, (t) => setCase(t, c.id, result === 'not-run' ? { result, tester: '', date: '' } : { result, tester: me, date: today() }));
  };
  // One step's result (again: clears it); the case's result follows its steps.
  const recordStep = (c: RunCase, n: number, r: Result, count: number) => {
    if (needTester()) return;
    const clear = c.steps[n] === r;
    const steps = { ...c.steps };
    if (clear) delete steps[n];
    else steps[n] = r;
    const result = resultFromSteps(steps, count);
    const any = Object.keys(steps).length > 0;
    project.updateFile(run.path, (t) => setCase(setStep(t, c.id, n, { result: clear ? null : r }), c.id, any ? { result, tester: me, date: today() } : { result: 'not-run', tester: '', date: '' }));
  };
  const assign = (ids: string[], who: string) => project.updateFile(run.path, (t) => ids.reduce((x, id) => setCase(x, id, { assignee: who.trim() }), t));

  const reportName = slug(run.name) || 'test-run';

  return (
    <div className="dashboard run-detail">
      <div className="dash-head graph-head">
        <div>
          <h1>{run.name}</h1>
          <p className="muted">
            {run.from || run.to ? (
              <>
                Code <code>{run.from}</code> → <code>{run.to}</code>
                {run.codeCommit && (
                  <>
                    {' '}
                    (<span className="mono">{run.codeCommit.slice(0, 8)}</span>)
                  </>
                )}
                {run.commitCount != null && <> · {run.commitCount} commits</>}
                {run.issues.length > 0 && <> · {run.issues.length} Jira issues</>} ·{' '}
              </>
            ) : null}
            {run.fixVersion && (
              <>
                Jira fix version <code>{run.fixVersion}</code> ·{' '}
              </>
            )}
            {run.variant && (
              <>
                Variant <strong>{index.config.variants.find((v) => v.key === run.variant)?.name ?? run.variant}</strong> ·{' '}
              </>
            )}
            created {run.created} · <span className="mono small">{run.path}</span>
          </p>
          <ReleaseLine project={project} run={run} />
          {run.error && <p className="warn-text">This file can’t be read: {run.error}</p>}
        </div>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={() => void savePdf(reportHtml(run, index), `${reportName}-report.pdf`)}>
            <Icon name="download" /> Report (PDF)
          </button>
          <button type="button" className="button" onClick={() => download(`${reportName}-report.html`, reportHtml(run, index), 'text/html')}>
            <Icon name="download" /> Report (HTML)
          </button>
          <button type="button" className="button" onClick={() => download(`${reportName}-report.md`, reportMarkdown(run, index), 'text/markdown')}>
            <Icon name="download" /> Report (Markdown)
          </button>
          <button
            type="button"
            className="button"
            title="Save the Markdown report next to the run, to commit with it"
            onClick={async () => {
              const path = run.path.replace(/\.ya?ml$/i, '-report.md');
              await project.createFile(path, reportMarkdown(run, index));
              notify(`Saved ${path}.${project.git ? ' Commit it to keep it with the run.' : ''}`, 'success');
            }}
          >
            Save report to repository
          </button>
          <button type="button" className="icon-button" aria-label="Delete this test run" title="Delete this test run" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" />
          </button>
        </div>
      </div>

      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Passed</span>
          <span className="tile-value ok">{s.passed}</span>
          <ProgressBar s={s} />
        </div>
        <div className="tile">
          <span className="tile-label">Failed</span>
          <span className={`tile-value${s.failed ? ' warn' : ''}`}>{s.failed}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Blocked</span>
          <span className="tile-value">{s.blocked}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Not run</span>
          <span className="tile-value">
            {s.notRun} <span className="tile-of">of {s.total}</span>
          </span>
          <span className="tile-sub" title={est.total.counted ? `The whole run: about ${formatDuration(est.total.minutes)}` : 'Give test cases an estimate, like 30m'}>
            {est.total.counted
              ? `About ${formatDuration(est.left.minutes)} left${est.left.missing ? `, ${est.left.missing} without an estimate` : ''}`
              : 'No time estimates'}
          </span>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <div className="segmented small" role="tablist">
            {(
              [
                ['all', `All (${s.total})`],
                ['todo', `To do (${s.notRun})`],
                ['problems', `Failed or blocked (${s.failed + s.blocked})`],
                ['passed', `Passed (${s.passed})`],
              ] as const
            ).map(([f, label]) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {label}
              </button>
            ))}
          </div>
          <div className="dialog-actions">
            <div className="search run-search">
              <Icon name="search" />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a case" aria-label="Find a case in this run" title="Searches the ID, title, who it's for, the tester and the notes" />
            </div>
            <label className="field inline">
              <span>Assigned</span>
              <select value={assigned} onChange={(e) => setAssigned(e.target.value)} aria-label="Whose cases">
                <option value="">Anyone</option>
                <option value={'\u0000me'} disabled={!me}>
                  Mine{me ? ` (${me})` : ''}
                </option>
                <option value={'\u0000none'}>Nobody yet</option>
                {assignees.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label className="field inline">
              <span>Tester</span>
              <input id="tester" value={tester} onChange={(e) => setTester(e.target.value)} placeholder="Your name" />
            </label>
            <button type="button" className="button" onClick={() => setAdding(true)}>
              <Icon name="plus" /> Add test cases
            </button>
          </div>
        </div>

        <div className="assign-shown">
          <span className="muted small">
            Assign the {cases.length} shown to
          </span>
          <input list="run-people" value={assignTo} onChange={(e) => setAssignTo(e.target.value)} placeholder="Name" aria-label="Assign the shown cases to" />
          <button type="button" className="button small" disabled={!cases.length || !assignTo.trim()} onClick={() => assign(cases.map((c) => c.id), assignTo)}>
            Assign
          </button>
          <button type="button" className="link-button small" disabled={!cases.some((c) => c.assignee)} onClick={() => assign(cases.map((c) => c.id), '')}>
            Unassign
          </button>
          {assignees.length > 0 && (
            <span className="muted small who-progress">
              {[...assignees, ...(run.cases.some((c) => !c.assignee) ? [''] : [])]
                .map((a) => {
                  const mine = run.cases.filter((c) => c.assignee === a);
                  return `${a || 'Nobody'}: ${mine.filter((c) => c.result !== 'not-run').length} of ${mine.length} done`;
                })
                .join(' · ')}
            </span>
          )}
          <datalist id="run-people">
            {people.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
        <ul className="run-cases">
          {cases.slice(0, page.shown).map((c) => {
            const item = index.byId.get(c.id);
            const expanded = open === c.id;
            const { steps, rest } = item ? stepsOf(item.body) : { steps: [], rest: '' };
            const problems = stepProblems(c);
            return (
              <li key={c.id} className={`run-case ${c.result}`} data-case={c.id}>
                <div className="run-case-row">
                  <button type="button" className="run-case-main" onClick={() => setOpen(expanded ? null : c.id)} aria-expanded={expanded}>
                    <span className={`caret${expanded ? ' open' : ''}`} aria-hidden="true">
                      ›
                    </span>
                    <span className="run-case-text">
                      <span>
                        <span className="item-id">{c.id}</span> <span className="strong">{item?.title ?? '(no longer in the repository)'}</span>
                      </span>
                      {(c.reason.length > 0 || item?.estimate != null || c.assignee) && (
                        <span className="muted small">
                          {[...(c.assignee ? [`for ${c.assignee}`] : []), ...c.reason, ...(item?.estimate != null ? [`about ${formatDuration(item.estimate)}`] : [])].join(' · ')}
                        </span>
                      )}
                      {steps.length > 0 && Object.keys(c.steps).length > 0 && (
                        <span className={`small ${problems.length ? 'warn-text' : 'muted'}`}>
                          {problems.length ? problems.join(' · ') : `${Object.values(c.steps).filter((r) => r === 'passed').length} of ${steps.length} steps passed`}
                        </span>
                      )}
                    </span>
                  </button>
                  <div className="result-buttons" role="radiogroup" aria-label={`Result for ${c.id}`}>
                    {RESULTS.map((r) => (
                      <button key={r} type="button" role="radio" aria-checked={c.result === r} className={`result ${r}${c.result === r ? ' on' : ''}`} onClick={() => record(c, r)}>
                        {RESULT_LABEL[r]}
                      </button>
                    ))}
                  </div>
                </div>
                {(c.tester || c.result === 'failed' || c.result === 'blocked' || c.note) && (
                  <div className="run-case-extra">
                    {c.tester && (
                      <span className="muted small">
                        {c.tester} · {c.date}
                      </span>
                    )}
                    <textarea
                      className="note-input"
                      rows={Math.min(10, Math.max(1, c.note.split('\n').length))}
                      value={c.note}
                      onChange={(e) => project.updateFile(run.path, (t) => setCase(t, c.id, { note: e.target.value }))}
                      placeholder={c.result === 'failed' || c.result === 'blocked' ? 'What happened? (defect key, observed result; Enter for a new line)' : 'Note'}
                      aria-label={`Note for ${c.id}`}
                    />
                  </div>
                )}
                {expanded && (
                  <div className="run-case-body">
                    {item ? (
                      <>
                        <div className="link-meta">
                          <StatusPill status={item.status} />
                          {item.verifies.length > 0 && <span className="muted small">Verifies {item.verifies.join(', ')}</span>}
                          <span className="tool-spacer" />
                          <button type="button" className="link-button small" onClick={() => onOpenId(item.id)}>
                            Open test case
                          </button>
                          <button type="button" className="link-button small" onClick={() => project.updateFile(run.path, (t) => removeCase(t, c.id))}>
                            Remove from run
                          </button>
                        </div>
                        <label className="field inline assign-field">
                          <span>Assigned to</span>
                          <input
                            list="run-people"
                            value={c.assignee}
                            placeholder="Nobody"
                            onChange={(e) => assign([c.id], e.target.value)}
                            aria-label={`Who's to run ${c.id}`}
                          />
                        </label>
                        {steps.length > 0 && (
                          <ol className="step-list" aria-label="Steps">
                            {steps.map((text, i) => {
                              const n = i + 1;
                              const r = c.steps[n];
                              return (
                                <li key={n} className={`step ${r ?? ''}`}>
                                  <div className="step-row">
                                    <span className="step-n">{n}</span>
                                    <span className="step-text" dangerouslySetInnerHTML={{ __html: md.renderInline(text) }} />
                                    <span className="step-buttons" role="group" aria-label={`Step ${n}`}>
                                      {(['passed', 'failed', 'blocked'] as const).map((x) => (
                                        <button
                                          key={x}
                                          type="button"
                                          className={`step-result ${x}${r === x ? ' on' : ''}`}
                                          aria-pressed={r === x}
                                          title={`${RESULT_LABEL[x]}${r === x ? ' (click again to clear)' : ''}`}
                                          aria-label={`Step ${n}: ${RESULT_LABEL[x]}`}
                                          onClick={() => recordStep(c, n, x, steps.length)}
                                        >
                                          {STEP_MARK[x]}
                                        </button>
                                      ))}
                                    </span>
                                  </div>
                                  {(r === 'failed' || r === 'blocked' || c.stepNotes[n]) && (
                                    <input
                                      className="note-input step-note"
                                      value={c.stepNotes[n] ?? ''}
                                      onChange={(e) => project.updateFile(run.path, (t) => setStep(t, c.id, n, { note: e.target.value }))}
                                      placeholder="What happened at this step?"
                                      aria-label={`Note for step ${n} of ${c.id}`}
                                    />
                                  )}
                                </li>
                              );
                            })}
                          </ol>
                        )}
                        <div className="prose rendered" dangerouslySetInnerHTML={{ __html: md.render(steps.length ? rest : item.body) }} />
                      </>
                    ) : (
                      <button type="button" className="link-button small" onClick={() => project.updateFile(run.path, (t) => removeCase(t, c.id))}>
                        Remove from run
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
          {cases.length === 0 && <li className="muted list-empty">None.</li>}
          {page.shown < cases.length && (
            <li>
              <ShowMore shown={page.shown} total={cases.length} more={page.more} what="test cases" />
            </li>
          )}
        </ul>
      </section>

      {(run.gaps.requirementsWithoutTests.length > 0 || run.gaps.componentsWithoutTests.length > 0 || run.gaps.issuesWithoutRequirement.length > 0) && (
        <section className="card attention">
          <h2>Not covered by this run</h2>
          {run.gaps.requirementsWithoutTests.length > 0 && <p>Requirements affected but with no test cases: {run.gaps.requirementsWithoutTests.join(', ')}</p>}
          {run.gaps.componentsWithoutTests.length > 0 && <p>Components changed but with no test cases: {run.gaps.componentsWithoutTests.join(', ')}</p>}
          {run.gaps.issuesWithoutRequirement.length > 0 && <p>Jira issues changed in code but named by no requirement: {run.gaps.issuesWithoutRequirement.join(', ')}</p>}
        </section>
      )}

      {adding && <AddCasesDialog project={project} run={run} onClose={() => setAdding(false)} />}
      {confirmDelete && (
        <Dialog title={`Delete “${run.name}”?`} onClose={() => setConfirmDelete(false)}>
          <div className="dialog-body">
            <p>
              This deletes <code>{run.path}</code> and its results. It stays in git history once committed.
            </p>
            <div className="dialog-actions">
              <span className="tool-spacer" />
              <button type="button" className="button" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="button danger"
                onClick={async () => {
                  setConfirmDelete(false);
                  await project.deleteItem(run.path);
                  onDeleted();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function AddCasesDialog({ project, run, onClose }: { project: Project; run: TestRun; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const inRun = new Set(run.cases.map((c) => c.id));
  const q = query.trim().toLowerCase();
  const pool = run.variant ? forVariant(project.allIndex, run.variant) : project.allIndex;
  const tests = pool.items.filter(
    (i) => isRunnable(pool.config, i.kind) && i.status !== 'obsolete' && !inRun.has(i.id) && (!q || i.id.toLowerCase().includes(q) || i.title.toLowerCase().includes(q) || i.components.some((c) => c.includes(q))),
  );
  // What's on the work list and could go in this run.
  const fromList = project.work.filter((e) => {
    const it = pool.byId.get(e.id);
    return it && isRunnable(pool.config, it.kind) && it.status !== 'obsolete' && !inRun.has(e.id);
  });
  return (
    <Dialog title="Add test cases" onClose={onClose} wide>
      <div className="dialog-body">
        <div className="search">
          <Icon name="search" />
          <input autoFocus type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search ID, title or component" aria-label="Search" />
        </div>
        <ul className="change-list">
          {tests.map((t) => (
            <li key={t.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={chosen.has(t.id)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(t.id);
                    else next.delete(t.id);
                    setChosen(next);
                  }}
                />
                <span className="mono">{t.id}</span> <span className="change-path">{t.title}</span>
              </label>
            </li>
          ))}
          {tests.length === 0 && <li className="muted">All test cases are in this run.</li>}
        </ul>
        <div className="dialog-actions">
          <button type="button" className="link-button" onClick={() => setChosen(new Set(tests.map((t) => t.id)))}>
            Select all shown
          </button>
          {fromList.length > 0 && (
            <button
              type="button"
              className="link-button"
              onClick={() => {
                project.updateFile(run.path, (t) => addCases(t, fromList.map((e) => ({ id: e.id, reason: [e.reason] }))));
                onClose();
              }}
            >
              Add the work list ({fromList.length})
            </button>
          )}
          <span className="tool-spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!chosen.size}
            onClick={() => {
              project.updateFile(run.path, (t) => addCases(t, [...chosen].map((id) => ({ id, reason: ['Added by hand'] }))));
              onClose();
            }}
          >
            Add {chosen.size || ''}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// The release a run's results count toward, and changing it: say a run tested main and
// the release was tagged afterwards.
function ReleaseLine({ project, run }: { project: Project; run: TestRun }) {
  const rel = releaseFrom(run);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const known = useMemo(() => releases(project.runs).map((r) => r.name), [project.runs]);
  const save = () => {
    project.updateFile(run.path, (t) => setRunRelease(t, value));
    setEditing(false);
  };
  if (editing)
    return (
      <form
        className="release-edit"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label htmlFor="run-release">Release</label>
        <input id="run-release" list="run-release-list" value={value} onChange={(e) => setValue(e.target.value)} placeholder="v2.4.0" spellCheck={false} autoFocus />
        <datalist id="run-release-list">
          {known.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <button type="submit" className="button small primary">
          Save
        </button>
        <button type="button" className="button small" onClick={() => setEditing(false)}>
          Cancel
        </button>
        <span className="muted small">{run.to || run.fixVersion ? 'Empty: follow the code tag or Jira fix version again.' : 'Empty: no release.'}</span>
      </form>
    );
  return (
    <p className="muted release-line">
      {rel ? (
        <>
          Release <strong>{rel.version}</strong>
          {rel.from === 'code' ? ' (the code tag tested)' : rel.from === 'jira' ? ' (the Jira fix version)' : ''}
        </>
      ) : (
        <>No release: its results count only as the latest results and as this run.</>
      )}{' '}
      <button
        type="button"
        className="link-button"
        onClick={() => {
          setValue(run.release ?? rel?.version ?? '');
          setEditing(true);
        }}
      >
        {rel ? 'Change' : 'Set release'}
      </button>
    </p>
  );
}

// ---- a new run ------------------------------------------------------------------------

function NewRunDialog({ project, fromWork, onClose, onCreated }: { project: Project; fromWork: boolean; onClose: () => void; onCreated: (path: string) => void }) {
  const { code } = project;
  const variants = project.allIndex.config.variants;
  const [variant, setVariant] = useState(project.variant ?? '');
  // The test cases that apply to the variant being tested.
  const index = useMemo(() => (variant ? forVariant(project.allIndex, variant) : project.allIndex), [project.allIndex, variant]);
  const [tags, setTags] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [components, setComponents] = useState(true);
  const [scopeChoice, setScope] = useState<'impact' | 'all' | 'work' | 'none' | null>(fromWork ? 'work' : null);
  const [emptyWork, setEmptyWork] = useState(true);
  // Until chosen: between versions when the code repository is connected (it may still be loading).
  const scope = scopeChoice ?? (code.repo || project.jira.status?.user ? 'impact' : 'all');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [fixVersion, setFixVersion] = useState('');
  // The release its results count toward: the tag or fix version tested, or typed.
  const [release, setRelease] = useState('');
  const [releaseEdited, setReleaseEdited] = useState(false);
  const knownReleases = useMemo(() => [...new Set([...releases(project.runs).map((r) => r.name), ...tags])], [project.runs, tags]);
  const [range, setRange] = useState<{ commits: Commit[]; to: string } | null>(null);
  const [fvIssues, setFvIssues] = useState<{ name: string; issues: JiraIssue[] } | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [busy, setBusy] = useState(false);
  const jiraOn = !!project.jira.status?.user;
  const wantRange = scope === 'impact' && !!code.repo && !!from.trim() && !!to.trim();
  const fv = scope === 'impact' && jiraOn ? fixVersion.trim() : '';

  useEffect(() => {
    if (!code.repo) return;
    api.gitTags(code.repo.id).then((t) => {
      setTags(t);
      if (t.length) setTo((v) => v || t[0]);
      if (t.length > 1) setFrom((v) => v || t[1]);
    }, () => {});
  }, [code.repo]);

  useEffect(() => {
    if (!releaseEdited) setRelease(wantRange && tags.includes(to.trim()) ? to.trim() : fv);
  }, [to, fv, wantRange, tags, releaseEdited]);

  useEffect(() => {
    if (!nameEdited) {
      const v = (wantRange ? to : fv).replace(/^v(?=\d)/, '');
      const rel = release.trim().replace(/^v(?=\d)/, '');
      setName(
        scope === 'impact' && v ? `Release ${v}` : scope === 'all' ? `Full regression ${rel || today()}` : rel ? `Test run ${rel}` : `Test run ${today()}`,
      );
    }
  }, [to, fv, wantRange, scope, nameEdited, release]);

  // The commits between the versions, and the issues in the fix version, read when they change.
  useEffect(() => {
    if (!wantRange && !fv) {
      setRange(null);
      setFvIssues(null);
      return;
    }
    let live = true;
    setState({ loading: true, error: null });
    const t = setTimeout(async () => {
      try {
        const r = wantRange ? await api.gitRange(code.repo!.id, from.trim(), to.trim()) : null;
        let issues: JiraIssue[] = [];
        if (fv) {
          const projects = projectsOf(index, project.links);
          const scopeJql = projects ? ` AND project in (${[...projects].map((p) => `"${p}"`).join(', ')})` : '';
          issues = (await api.jiraSearch(project.jira.server!, `fixVersion = "${fv.replace(/["\\]/g, '')}"${scopeJql}`, index.config.jira.field, index.config.jira.max)).issues;
        }
        if (!live) return;
        setRange(r);
        setFvIssues(fv ? { name: fv, issues } : null);
        setState({ loading: false, error: null });
      } catch (e) {
        if (live) {
          setRange(null);
          setFvIssues(null);
          setState({ loading: false, error: (e as Error).message });
        }
      }
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantRange, fv, from, to, code.repo]);

  const preview = useMemo(() => {
    if (scope !== 'impact' || (!range && !fvIssues)) return null;
    // The fix version's issues count as read from Jira too, so their labels and text link.
    const links = buildIssueLinks(index, [...project.jira.issues, ...(fvIssues?.issues ?? [])]);
    const linked = linkCommits(range?.commits ?? [], index, links);
    return {
      impact: impact(index, linked, { components, links, fixVersion: fvIssues ? { name: fvIssues.name, issues: fvIssues.issues.map((i) => i.key) } : undefined }),
      to: range?.to ?? null,
      commits: range ? range.commits.length : null,
    };
  }, [scope, range, fvIssues, index, project.jira.issues, components]);
  const fixVersions = useMemo(() => [...new Set(project.jira.issues.flatMap((i) => i.fixVersions))].sort((a, b) => compareIds(b, a)), [project.jira.issues]);

  const componentName = (k: string) => index.config.components.find((c) => c.key === k)?.name ?? k;
  const allTests = useMemo(() => index.items.filter((i) => isRunnable(index.config, i.kind) && i.status !== 'obsolete'), [index]);
  const picked: { item: Item; reason: string[] }[] = useMemo(() => {
    if (scope === 'all') return allTests.map((item) => ({ item, reason: ['Full regression'] }));
    if (scope === 'work')
      return project.work.flatMap((e) => {
        const item = index.byId.get(e.id);
        return item && item.status !== 'obsolete' && isRunnable(index.config, item.kind) ? [{ item, reason: [e.reason] }] : [];
      });
    if (scope === 'none' || !preview) return [];
    return [...preview.impact.cases]
      .map(([id, reasons]) => ({ item: index.byId.get(id)!, reason: reasons.map((r) => reasonText(r, componentName)) }))
      .filter((x) => x.item)
      .sort((a, b) => compareIds(a.item.id, b.item.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, preview, index, allTests, project.work]);

  const create = async () => {
    setBusy(true);
    try {
      const existing = new Set(project.runs.map((r) => r.path));
      const path = runPath(index.config.runs.dir, name.trim(), existing);
      const im = scope === 'impact' ? preview?.impact : null;
      const text = newRunText({
        name: name.trim(),
        created: today(),
        release: release.trim() || null,
        from: wantRange ? from.trim() : null,
        to: wantRange ? to.trim() : null,
        // Whether it's a tag (a release) or a branch or commit; unknown if the tags didn't load.
        toTag: wantRange && tags.length ? tags.includes(to.trim()) : null,
        fixVersion: fv || null,
        codeCommit: scope === 'impact' ? (preview?.to ?? null) : null,
        commitCount: scope === 'impact' ? (preview?.commits ?? null) : null,
        requirementsCommit: project.git?.head ?? null,
        variant: variant || null,
        issues: im?.issues ?? [],
        gaps: {
          requirementsWithoutTests: im?.requirementsWithoutTests ?? [],
          componentsWithoutTests: (im?.componentsWithoutTests ?? []).map(componentName),
          issuesWithoutRequirement: im?.issuesWithoutRequirement ?? [],
        },
        cases: picked.map((p) => ({ id: p.item.id, reason: p.reason })),
      });
      await project.createFile(path, text);
      if (scope === 'work' && emptyWork) {
        const before = project.work;
        project.clearWork();
        notify('Made the test run and emptied the work list.', 'success', { label: 'Undo emptying', run: () => project.setWork(before) });
      }
      onCreated(path);
    } catch (e) {
      notify((e as Error).message, 'error');
      setBusy(false);
    }
  };

  const im = preview?.impact;
  return (
    <Dialog title="New test run" onClose={onClose} wide>
      <div className="dialog-body">
        <div className="segmented" role="radiogroup" aria-label="Which test cases">
          <button type="button" role="radio" aria-checked={scope === 'impact'} className={scope === 'impact' ? 'on' : ''} onClick={() => setScope('impact')} disabled={!code.repo && !jiraOn}>
            Changed in a release
          </button>
          <button type="button" role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
            {allTests.some((t) => t.kind !== 'testcase') ? 'All tests' : 'All test cases'} ({allTests.length})
          </button>
          <button type="button" role="radio" aria-checked={scope === 'work'} className={scope === 'work' ? 'on' : ''} onClick={() => setScope('work')} disabled={!project.work.length}>
            Work list ({project.work.length})
          </button>
          <button type="button" role="radio" aria-checked={scope === 'none'} className={scope === 'none' ? 'on' : ''} onClick={() => setScope('none')}>
            Choose myself
          </button>
        </div>

        {variants.length > 0 && (
          <label className="field">
            <span>Variant tested</span>
            <select value={variant} onChange={(e) => setVariant(e.target.value)}>
              <option value="">Not variant-specific (every test case)</option>
              {variants.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {scope === 'impact' && !code.repo && !jiraOn && (
          <p className="warn-text small">Connect the code repository or Jira under Settings first: the commits between two versions, or a Jira fix version, say what changed.</p>
        )}

        {scope === 'impact' && (code.repo || jiraOn) && (
          <>
            {code.repo && (
              <div className="two-col">
                <label className="field">
                  <span>From version (already tested)</span>
                  <input list="tag-list" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="v2.3.0" spellCheck={false} />
                </label>
                <label className="field">
                  <span>To version (to test)</span>
                  <input list="tag-list" value={to} onChange={(e) => setTo(e.target.value)} placeholder="v2.4.0 or main" spellCheck={false} />
                </label>
                <datalist id="tag-list">
                  {tags.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </div>
            )}
            {jiraOn && (
              <label className="field">
                <span>{code.repo ? 'And' : 'Issues in'} Jira fix version (optional)</span>
                <input list="fix-version-list" value={fixVersion} onChange={(e) => setFixVersion(e.target.value)} placeholder="2.4.0" spellCheck={false} />
                <datalist id="fix-version-list">
                  {fixVersions.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </label>
            )}
            {code.repo && (
              <label className="check">
                <input type="checkbox" checked={components} onChange={(e) => setComponents(e.target.checked)} />
                <span>Also include test cases of components the changes touch (by path, from trace.yml)</span>
              </label>
            )}
            <div className="code-status">
              {state.loading ? (
                <span className="muted">Reading{wantRange ? ` ${code.repo!.name}` : ''}{fv ? `${wantRange ? ' and' : ''} Jira` : ''}…</span>
              ) : state.error ? (
                <span className="warn-text">{state.error}</span>
              ) : im ? (
                <>
                  <span>
                    {preview!.commits != null && (
                      <>
                        <span className="strong">{preview!.commits}</span> commits in {code.repo!.name}
                        {fvIssues ? ' and ' : ', '}
                      </>
                    )}
                    {fvIssues && (
                      <>
                        <span className="strong">{fvIssues.issues.length}</span> issues in fix version {fvIssues.name},{' '}
                      </>
                    )}
                    naming <span className="strong">{im.issues.length}</span> Jira issue{im.issues.length === 1 ? '' : 's'} → <span className="strong">{im.requirements.size}</span>{' '}
                    requirement{im.requirements.size === 1 ? '' : 's'} → <span className="strong">{picked.length}</span> test case{picked.length === 1 ? '' : 's'} to run (of {allTests.length}).
                  </span>
                  {(im.issuesWithoutRequirement.length > 0 || im.requirementsWithoutTests.length > 0 || im.componentsWithoutTests.length > 0 || im.commitsWithoutKeys > 0) && (
                    <span className="warn-text small">
                      {[
                        im.issuesWithoutRequirement.length && `Linked to no requirement or test case: ${im.issuesWithoutRequirement.join(', ')}.`,
                        im.requirementsWithoutTests.length && `${im.requirementsWithoutTests.join(', ')} ha${im.requirementsWithoutTests.length === 1 ? 's' : 've'} no test cases.`,
                        im.componentsWithoutTests.length && `Changed with no test cases: ${im.componentsWithoutTests.map(componentName).join(', ')}.`,
                        im.commitsWithoutKeys && `${im.commitsWithoutKeys} commit${im.commitsWithoutKeys === 1 ? '' : 's'} name no Jira issue.`,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    </span>
                  )}
                </>
              ) : (
                <span className="muted">{code.repo ? 'Choose two versions' : 'Enter a fix version'}{code.repo && jiraOn ? ', a fix version, or both.' : '.'}</span>
              )}
            </div>
          </>
        )}

        {picked.length > 0 && (
          <ul className="change-list preview-list">
            {picked.map((p) => (
              <li key={p.item.id} className="preview-row">
                <span>
                  <span className="mono">{p.item.id}</span> {p.item.title}
                </span>
                <span className="muted small">{p.reason.join(' · ')}</span>
              </li>
            ))}
          </ul>
        )}
        {scope === 'none' && <p className="muted small">The run starts empty; add test cases to it with “Add test cases”.</p>}
        {scope === 'work' && (
          <>
            {picked.length < project.work.length && (
              <p className="muted small">
                {project.work.length - picked.length} on the work list {project.work.length - picked.length === 1 ? 'is' : 'are'} left out: obsolete, gone, or not for this variant.
              </p>
            )}
            <label className="check">
              <input type="checkbox" checked={emptyWork} onChange={(e) => setEmptyWork(e.target.checked)} />
              <span>Empty the work list once the run is made</span>
            </label>
          </>
        )}
        {picked.length > 0 && (
          <p className="small run-estimate">
            Estimated time: <strong>{estimateText(estimateOf(picked.map((p) => p.item.id), index))}</strong>
          </p>
        )}

        <label className="field">
          <span>Release (optional)</span>
          <input
            list="release-list"
            value={release}
            onChange={(e) => {
              setRelease(e.target.value);
              setReleaseEdited(true);
            }}
            placeholder="v2.4.0"
            spellCheck={false}
          />
          <datalist id="release-list">
            {knownReleases.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>
        <p className="muted small">
          {release.trim()
            ? `Its results count toward release ${release.trim()} in the traceability matrix.`
            : 'Without one, its results count only as the latest results and as this run, not toward a release.'}
        </p>

        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
          />
        </label>
        <p className="muted small">
          Saved as <code>{runPath(index.config.runs.dir, name.trim() || 'test-run', new Set(project.runs.map((r) => r.path)))}</code>
          {project.git ? ' in this repository; commit it like any other change.' : '.'} Results are recorded in it as you go.
        </p>
        <div className="dialog-actions">
          <span className="tool-spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" disabled={busy || !name.trim() || (scope === 'impact' && (!preview || state.loading))} onClick={create}>
            Create test run{picked.length ? ` (${picked.length})` : ''}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
