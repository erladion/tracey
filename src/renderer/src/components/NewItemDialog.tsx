import { useState } from 'react';
import type { Kind } from '../../../core/config';
import { nextId, type ProjectIndex } from '../../../core/model';
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
  onCreate: (kind: Kind, title: string, opts: { verifies?: string[]; components?: string[] }) => void;
}

export function NewItemDialog({ request, index, onClose, onCreate }: Props) {
  const [kind, setKind] = useState<Kind>(request.kind);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const id = nextId(index, kind);
  const verifies = kind === 'testcase' ? request.verifies : undefined;

  return (
    <Dialog title={`New ${kind === 'requirement' ? 'requirement' : 'test case'}`} onClose={onClose}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim() || busy) return;
          setBusy(true);
          onCreate(kind, title.trim(), { verifies, components: request.components });
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
        <label className="field">
          <span>Title</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'requirement' ? 'Payment retry after gateway timeout' : 'Payment stops after 3 retries'} />
        </label>
        <p className="muted small">
          It gets the next free ID, <code>{id}</code>
          {verifies?.length ? (
            <>
              , and verifies <code>{verifies.join(', ')}</code>
            </>
          ) : null}
          . Another branch may take the same ID before this one is merged; Coverage shows duplicates if that happens.
        </p>
        <div className="dialog-actions">
          <span className="tool-spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!title.trim() || busy}>
            Create {id}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
