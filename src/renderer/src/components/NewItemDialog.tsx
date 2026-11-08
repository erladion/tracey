import { useState } from 'react';
import { isRunnable, typeWord, type Kind } from '../../../core/config';
import { checkNewId, nextId, type ProjectIndex } from '../../../core/model';
import { Dialog } from './Dialog';

export interface NewItemRequest {
  kind: Kind;
  verifies?: string[];
  refines?: string[]; // a requirement breaking these down
  links?: Record<string, string[]>; // declared link types: what it links to
  components?: string[];
  variants?: string[];
}

interface Props {
  request: NewItemRequest;
  index: ProjectIndex;
  onClose: () => void;
  onCreate: (kind: Kind, title: string, opts: { id?: string; verifies?: string[]; refines?: string[]; links?: Record<string, string[]>; components?: string[]; variants?: string[] }) => void;
}

export function NewItemDialog({ request, index, onClose, onCreate }: Props) {
  const [kind, setKind] = useState<Kind>(request.kind);
  const [title, setTitle] = useState('');
  const [typedId, setTypedId] = useState<string | null>(null); // null: the next free one
  const [busy, setBusy] = useState(false);
  const [variants, setVariants] = useState<string[]>(request.variants ?? []);
  const next = nextId(index, kind);
  const id = typedId ?? next;
  const check = typedId == null ? { error: null, warning: null } : checkNewId(index, kind, typedId);
  const verifies = isRunnable(index.config, kind) ? request.verifies : undefined;
  const refines = kind === 'requirement' ? request.refines : undefined;
  const links = request.links;
  const linked = Object.entries(links ?? {}).filter(([, ids]) => ids.length);
  const fixedKind = !!(request.verifies || request.refines || linked.length);
  const linkDef = linked.length ? index.config.links.find((l) => l.key === linked[0][0]) : undefined;
  const canCreate = !!title.trim() && !check.error && !busy;

  return (
    <Dialog
      title={
        refines?.length
          ? `New requirement refining ${refines.join(', ')}`
          : verifies?.length && kind !== 'testcase'
            ? `New ${typeWord(index.config, kind)} verifying ${verifies.join(', ')}`
          : linkDef
            ? `New ${typeWord(index.config, kind)} that ${linkDef.name.toLowerCase()} ${linked[0][1].join(', ')}`
            : `New ${typeWord(index.config, kind)}`
      }
      onClose={onClose}
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canCreate) return;
          setBusy(true);
          onCreate(kind, title.trim(), { id: typedId?.trim() || undefined, verifies, refines, links, components: request.components, variants });
        }}
      >
        {!fixedKind && (
          <div className={`segmented${index.config.types.length > 2 ? ' wrap' : ''}`} role="radiogroup" aria-label="Kind">
            {index.config.types.map((t) => (
              <button key={t.key} type="button" role="radio" aria-checked={kind === t.key} className={kind === t.key ? 'on' : ''} onClick={() => setKind(t.key)}>
                {t.name}
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
        {index.config.variants.length > 0 && (
          <fieldset className="variant-choice">
            <legend className="small">Variants</legend>
            <label className="check">
              <input type="checkbox" checked={variants.length === 0} onChange={() => setVariants([])} />
              <span>All</span>
            </label>
            {index.config.variants.map((v) => (
              <label key={v.key} className="check">
                <input
                  type="checkbox"
                  checked={variants.includes(v.key)}
                  onChange={(e) => setVariants(e.target.checked ? [...variants, v.key] : variants.filter((x) => x !== v.key))}
                />
                <span>{v.name}</span>
              </label>
            ))}
          </fieldset>
        )}
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
