// Changing an item's ID: everything in the repository naming it changes with it (see
// core/rename.ts). Jira issues and commit messages can't be changed from here, so the
// dialog says which still name the old one.
import { useMemo, useState } from 'react';
import { checkNewId, type Item } from '../../../core/model';
import { movedPath, planRename } from '../../../core/rename';
import type { Project } from '../project';
import { notify } from '../notify';
import { Dialog } from './Dialog';

interface Props {
  project: Project;
  item: Item;
  onClose: () => void;
  onRenamed: (path: string) => void; // the item's file, as it is now
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function RenameDialog({ project, item, onClose, onRenamed }: Props) {
  const { index } = project;
  const [id, setId] = useState(item.id);
  const [moveFile, setMoveFile] = useState(true);
  const [busy, setBusy] = useState(false);
  const newId = id.trim();
  const same = newId === item.id;
  const check = useMemo(() => {
    const c = checkNewId(index, item.kind, newId);
    // Only the letter case changes: the ID "taken" is this item's own.
    if (c.error && newId.toLowerCase() === item.id.toLowerCase() && !same && !index.items.some((i) => i !== item && i.id.toLowerCase() === newId.toLowerCase())) return { error: null, warning: c.warning };
    return c;
  }, [index, item, newId, same]);
  const canMove = !same && !!newId && movedPath(item.path, item.id, newId, () => false) !== null;
  const plan = useMemo(
    () => (same || check.error ? null : planRename(index, project.texts, project.config, item, newId, moveFile && canMove)),
    [same, check.error, index, project.texts, project.config, item, newId, moveFile, canMove],
  );
  const outside = useMemo(() => {
    const issues = (project.links.byItem.get(item.id) ?? []).filter((l) => l.sources.some((s) => s !== 'front-matter')).map((l) => l.issue);
    const commits = project.commits.filter((c) => c.items.includes(item.id)).length;
    return { issues, commits };
  }, [project.links, project.commits, item.id]);

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      for (const [path, text] of plan.texts) if (path !== plan.move?.from) project.setText(path, text);
      if (plan.move) {
        await project.createFile(plan.move.to, plan.texts.get(plan.move.from) ?? project.texts.get(plan.move.from) ?? '');
        onRenamed(plan.move.to);
        await project.deleteItem(plan.move.from);
      }
      const others = plan.texts.size - 1;
      notify(`${item.id} is now ${newId}${others > 0 ? `, in ${plural(others, 'other file')} too` : ''}. Commit the change from the bottom bar.`, 'success');
      onClose();
    } catch (e) {
      notify(`Couldn’t change the ID: ${(e as Error).message}`, 'error');
      setBusy(false);
    }
  };

  const fileName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  return (
    <Dialog title={`Change the ID of ${item.id}`} onClose={onClose}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (plan && !busy) void apply();
        }}
      >
        <label className="field">
          <span>New ID</span>
          <input className="mono" value={id} onChange={(e) => setId(e.target.value)} spellCheck={false} autoFocus aria-invalid={!!check.error} />
        </label>
        {!same && check.error && <p className="warn-text small">{check.error}</p>}
        {!same && !check.error && check.warning && <p className="muted small">{check.warning}</p>}
        {canMove && (
          <label className="check">
            <input type="checkbox" checked={moveFile} onChange={(e) => setMoveFile(e.target.checked)} />
            <span>
              Rename the file too: <code>{fileName(item.path)}</code> → <code>{fileName(plan?.move?.to ?? movedPath(item.path, item.id, newId, () => false) ?? '')}</code>
            </span>
          </label>
        )}
        {plan && (
          <div className="rename-summary small">
            {plan.duplicate ? (
              <p className="warn-text">
                Another file also has the ID {item.id}. Only this file’s ID changes: what names {item.id} keeps pointing at the other one.
              </p>
            ) : plan.items.length || plan.runs.length ? (
              <p>
                Also changes where {item.id} is named
                {plan.items.length > 0 && (
                  <>
                    {' '}
                    in <span className="mono">{plan.items.map((i) => i.id).join(', ')}</span>
                  </>
                )}
                {plan.items.length > 0 && plan.runs.length > 0 && ' and'}
                {plan.runs.length > 0 && <> in {plural(plan.runs.length, 'test run')}</>}. Links reviewed before stay reviewed.
              </p>
            ) : (
              <p className="muted">Nothing else in the repository names {item.id}.</p>
            )}
            {(outside.issues.length > 0 || outside.commits > 0) && !plan.duplicate && (
              <p className="warn-text">
                {[outside.issues.length ? `${plural(outside.issues.length, 'Jira issue')} (${outside.issues.slice(0, 5).join(', ')}${outside.issues.length > 5 ? '…' : ''})` : '', outside.commits ? plural(outside.commits, 'commit message') : '']
                  .filter(Boolean)
                  .join(' and ')}{' '}
                name {item.id}. Tracey can’t change those, so they won’t link to {newId} until they name it.
              </p>
            )}
          </div>
        )}
        <div className="dialog-actions">
          <span className="tool-spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!plan || busy}>
            Change ID
          </button>
        </div>
      </form>
    </Dialog>
  );
}
