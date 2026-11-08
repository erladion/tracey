// The work list: tests collected while looking around, to start a test run with or add to
// one. Kept on this computer (per repository); it isn't part of the repository.
import { useState } from 'react';
import { isRunnable } from '../../../core/config';
import type { Item } from '../../../core/model';
import { addCases, summarize } from '../../../core/runs';
import { testsFor, type WorkEntry } from '../../../core/worklist';
import type { Project } from '../project';
import { notify } from '../notify';
import { Icon } from '../icons';
import { Dialog } from './Dialog';
import { StatusPill } from './bits';

// Adds tests to the work list, and says what happened.
export function addToWork(project: Project, entries: WorkEntry[], empty = 'No tests to add.') {
  if (!entries.length) return notify(empty, 'error');
  const added = project.addWork(entries);
  const s = (n: number) => (n === 1 ? '' : 's');
  notify(
    added === entries.length
      ? `Added ${added} test${s(added)} to the work list.`
      : added
        ? `Added ${added} test${s(added)} to the work list; ${entries.length - added} ${entries.length - added === 1 ? 'was' : 'were'} in it already.`
        : `Already in the work list.`,
    'success',
  );
}

// Takes tests off the list (all of them when `ids` is null), with Undo.
export function removeFromWork(project: Project, ids: string[] | null) {
  const before = project.work;
  const gone = ids ? before.filter((e) => ids.includes(e.id)).length : before.length;
  if (!gone) return;
  if (ids) project.removeWork(ids);
  else project.clearWork();
  notify(ids ? `Took ${gone} test${gone === 1 ? '' : 's'} off the work list.` : 'Emptied the work list.', 'info', { label: 'Undo', run: () => project.setWork(before) });
}

// For an item: a test goes in itself; anything verified, its tests (and a requirement's
// refinements' tests).
export function WorkButton({ project, item }: { project: Project; item: Item }) {
  const runnable = isRunnable(project.index.config, item.kind);
  const inList = project.work.some((e) => e.id === item.id);
  if (runnable)
    return inList ? (
      <button type="button" className="button small" onClick={() => removeFromWork(project, [item.id])} title="In the work list: click to take it off">
        <Icon name="check" size={14} /> In the work list
      </button>
    ) : (
      <button type="button" className="button small" onClick={() => addToWork(project, testsFor(project.index, [item]))} title="Collect it, to start a test run with or add to one">
        <Icon name="plus" size={14} /> Add to work list
      </button>
    );
  const tests = testsFor(project.index, [item]);
  if (!tests.length) return null;
  return (
    <button
      type="button"
      className="button small"
      onClick={() => addToWork(project, tests)}
      title={item.kind === 'requirement' ? 'The tests verifying it, and those of the requirements refining it' : 'The tests verifying it'}
    >
      <Icon name="plus" size={14} /> Add its {tests.length} test{tests.length === 1 ? '' : 's'} to work list
    </button>
  );
}

export function WorkListDialog({ project, onOpenId, onNewRun, onClose }: { project: Project; onOpenId: (id: string) => void; onNewRun: () => void; onClose: () => void }) {
  const { work, allIndex: index } = project;
  const [run, setRun] = useState(project.runs[0]?.path ?? '');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const tick = (id: string, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(id);
    else next.delete(id);
    setTicked(next);
  };
  const tickedNow = work.filter((e) => ticked.has(e.id));
  const target = project.runs.find((r) => r.path === run);
  const missing = work.filter((e) => !index.byId.get(e.id));
  return (
    <Dialog title={`Work list (${work.length})`} onClose={onClose} wide>
      <div className="dialog-body">
        <p className="muted small">
          Tests you’ve collected: add them from a test case, a requirement (its tests, and those of the requirements refining it), the graph, a search in the list, or several
          picked items. Kept on this computer.
        </p>
        {work.length === 0 ? (
          <p className="muted">Nothing yet. Open a test case or requirement and use “Add to work list” beside it.</p>
        ) : (
          <ul className="change-list work-list">
            {work.map((e) => {
              const it = index.byId.get(e.id);
              return (
                <li key={e.id} className="work-row">
                  <input type="checkbox" checked={ticked.has(e.id)} onChange={(ev) => tick(e.id, ev.target.checked)} aria-label={`Pick ${e.id}`} />
                  <button
                    type="button"
                    className="link-button mono"
                    onClick={() => {
                      onOpenId(e.id);
                      onClose();
                    }}
                    disabled={!it}
                  >
                    {e.id}
                  </button>
                  <span className="work-title">{it ? it.title : <span className="warn-text">No longer in the repository</span>}</span>
                  {it && <StatusPill status={it.status} />}
                  <span className="muted small work-reason">{e.reason}</span>
                  <button type="button" className="icon-button" aria-label={`Take ${e.id} off the list`} title="Take it off the list" onClick={() => removeFromWork(project, [e.id])}>
                    <Icon name="close" size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {missing.length > 0 && (
          <p className="small warn-text">
            {missing.length} {missing.length === 1 ? 'is' : 'are'} no longer in the repository.{' '}
            <button type="button" className="link-button small" onClick={() => removeFromWork(project, missing.map((e) => e.id))}>
              Take {missing.length === 1 ? 'it' : 'them'} off
            </button>
          </p>
        )}
        {work.length > 0 && project.runs.length > 0 && (
          <div className="work-add-run">
            <label className="field inline">
              <span>Add to the run</span>
              <select value={run} onChange={(e) => setRun(e.target.value)}>
                {project.runs.map((r) => (
                  <option key={r.path} value={r.path}>
                    {r.name} ({summarize(r).total} cases)
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button"
              disabled={!target}
              onClick={() => {
                const have = new Set(target!.cases.map((c) => c.id));
                const adding = work.filter((e) => index.byId.get(e.id) && !have.has(e.id));
                project.updateFile(target!.path, (t) => addCases(t, adding.map((e) => ({ id: e.id, reason: [e.reason] }))));
                notify(adding.length ? `Added ${adding.length} to ${target!.name}.` : `They’re all in ${target!.name} already.`, adding.length ? 'success' : 'error');
              }}
            >
              Add
            </button>
          </div>
        )}
        <div className="dialog-actions">
          {work.length > 0 && (
            <button type="button" className="link-button" onClick={() => setTicked(tickedNow.length === work.length ? new Set() : new Set(work.map((e) => e.id)))}>
              {tickedNow.length === work.length ? 'Untick all' : 'Tick all'}
            </button>
          )}
          {tickedNow.length > 0 && (
            <button
              type="button"
              className="link-button"
              onClick={() => {
                removeFromWork(
                  project,
                  tickedNow.map((e) => e.id),
                );
                setTicked(new Set());
              }}
            >
              Take {tickedNow.length} off
            </button>
          )}
          <button type="button" className="link-button" disabled={!work.length} onClick={() => removeFromWork(project, null)}>
            Empty the list
          </button>
          <span className="tool-spacer" />
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
          <button type="button" className="button primary" disabled={!work.length} onClick={onNewRun}>
            New test run from these
          </button>
        </div>
      </div>
    </Dialog>
  );
}
