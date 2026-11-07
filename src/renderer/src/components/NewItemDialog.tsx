import { useState } from 'react';
import type { Kind } from '../../../core/config';
import { checkNewId, nextId, type ProjectIndex } from '../../../core/model';
import { Dialog } from './Dialog';

export interface NewItemRequest {
  kind: Kind;
  verifies?: string[];
  components?: string[];
}

interface Props {
  request: NewItemRequest;
  index: ProjectIndex;
  onClose: () => void;
  onCreate: (kind: Kind, title: string, opts: { id?: string; verifies?: string[]; components?: string[] }) => void;
}

export function NewItemDialog({ request, index, onClose, onCreate }: Props) {
  const [kind, setKind] = useState<Kind>(request.kind);
  const [title, setTitle] = useState('');
  const [typedId, setTypedId] = useState<string | null>(null); // null: the next free one
  const [busy, setBusy] = useState(false);
  const next = nextId(index, kind);
  const id = typedId ?? next;
  const check = typedId == null ? { error: null, warning: null } : checkNewId(index, kind, typedId);
  const verifies = kind === 'testcase' ? request.verifies : undefined;
  const canCreate = !!title.trim() && !check.error && !busy;

  return (
    <Dialog title={`New ${kind === 'requirement' ? 'requirement' : 'test case'}`} onClose={onClose}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canCreate) return;
          setBusy(true);
          onCreate(kind, title.trim(), { id: typedId?.trim() || undefined, verifies, components: request.components });
        }}
      >
        {!request.verifies && (
          <div className="segmented" role="radiogroup" aria-label="Kind">
            {(['requirement', 'testcase'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                {k === 'requirement' ? 'Requirement' : 'Test case'}
              </button>
            ))}
          </div>
        )}
        <div className="new-item-fields">
          <label className="field new-item-id">
            <span>ID</span>
            <input
              className="mono"
              value={id}
              onChange={(e) => setTypedId(e.target.value)}
              aria-invalid={!!check.error}
              aria-describedby="new-id-note"
              spellCheck={false}
            />
          </label>
          <label className="field grow">
            <span>Title</span>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'requirement' ? 'Payment retry after gateway timeout' : 'Payment stops after 3 retries'} />
          </label>
        </div>
        <p id="new-id-note" className={`small ${check.error ? 'warn-text' : 'muted'}`}>
          {check.error ??
            check.warning ??
            (typedId == null || id === next ? (
              <>
                The next free ID; type another to choose it.
                {verifies?.length ? (
                  <>
                    {' '}
                    It verifies <code>{verifies.join(', ')}</code>.
                  </>
                ) : null}{' '}
                Another branch may take the same ID before this one is merged; Coverage shows duplicates if that happens.
              </>
            ) : (
              <>
                Free in this branch.{' '}
                <button type="button" className="link-button small" onClick={() => setTypedId(null)}>
                  Use {next} instead
                </button>
              </>
            ))}
        </p>
        <div className="dialog-actions">
          <span className="tool-spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!canCreate}>
            Create {id.trim() || '…'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
