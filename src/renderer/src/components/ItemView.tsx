// One requirement or test case: its fields (front matter), its text (WYSIWYG), and
// what it's linked to.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Node as PMNode } from 'prosemirror-model';
import { decodeText, encodeText, joinFrontMatter, readFrontMatter, setFields, splitFrontMatter } from '../../../core/frontmatter';
import { parseBody, serializeBody, type ParsedBody } from '../../../core/markdown/markdown';
import { statusesFor } from '../../../core/config';
import { fingerprint, type Item } from '../../../core/model';
import type { Project } from '../project';
import { Editor } from '../editor/Editor';
import type { RefTarget } from '../editor/setup';
import { fileUrl } from '../api';
import { ChipInput } from './bits';
import { TracePanel } from './TracePanel';
import { Dialog } from './Dialog';
import { Icon } from '../icons';

interface Props {
  project: Project;
  path: string;
  onOpenId: (id: string) => void;
  onNewTest: (req: Item) => void;
  onShowInGraph: (item: Item) => void;
  onDeleted: () => void;
}

interface Loaded {
  crlf: boolean;
  front: string | null;
  body: string; // as last serialized (or read)
  parsed: ParsedBody;
}

function load(raw: string): Loaded {
  const { text, crlf } = decodeText(raw);
  const { front, body } = splitFrontMatter(text);
  return { crlf, front, body, parsed: parseBody(body) };
}

const BODY_DELAY = 250;

export function ItemView({ project, path, onOpenId, onNewTest, onShowInGraph, onDeleted }: Props) {
  const raw = project.texts.get(path) ?? '';
  const item = project.index.byPath.get(path);
  const { index, setText } = project;

  const state = useRef<Loaded>(null as unknown as Loaded);
  if (!state.current) state.current = load(raw);
  const [doc, setDoc] = useState<PMNode>(() => state.current.parsed.doc);
  const composed = useRef(raw); // the text as this view last wrote or read it
  const latestDoc = useRef<PMNode | null>(null); // edited, not serialized yet
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const compose = useCallback(() => {
    const s = state.current;
    const text = encodeText(joinFrontMatter(s.front, s.body), s.crlf);
    composed.current = text;
    setText(path, text);
  }, [setText, path]);

  const flushBody = useCallback(() => {
    clearTimeout(timer.current);
    if (!latestDoc.current) return false;
    state.current.body = serializeBody(latestDoc.current, state.current.parsed);
    latestDoc.current = null;
    return true;
  }, []);

  // Changes made elsewhere (marking a link reviewed, getting the latest from git).
  useEffect(() => {
    if (raw === composed.current) return;
    flushBody();
    const next = decodeText(raw);
    const { front, body } = splitFrontMatter(next.text);
    composed.current = raw;
    state.current.front = front;
    state.current.crlf = next.crlf;
    if (body !== state.current.body) {
      state.current.body = body;
      state.current.parsed = parseBody(body);
      setDoc(state.current.parsed.doc);
    }
  }, [raw, flushBody]);

  // Write what's pending when leaving the item.
  useEffect(
    () => () => {
      if (flushBody()) compose();
    },
    [flushBody, compose],
  );

  const onChange = useCallback(
    (d: PMNode) => {
      latestDoc.current = d;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (flushBody()) compose();
      }, BODY_DELAY);
    },
    [flushBody, compose],
  );

  const setField = useCallback(
    (changes: Record<string, unknown>) => {
      flushBody();
      state.current.front = setFields(state.current.front, changes);
      compose();
    },
    [flushBody, compose],
  );

  const refs = useMemo(() => {
    const m = new Map<string, RefTarget>();
    for (const it of index.items) m.set(it.id, { title: it.title });
    return m;
  }, [index]);

  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const resolveImage = useCallback(
    (src: string) => {
      if (/^(https?:|data:)/.test(src)) return src;
      const parts = (src.startsWith('/') ? src.slice(1) : dir + src).split('/');
      const out: string[] = [];
      for (const p of parts) p === '..' ? out.pop() : p !== '.' && out.push(p);
      return fileUrl(project.repo.id, out.join('/'));
    },
    [dir, project.repo.id],
  );

  if (!item) {
    const { error } = readFrontMatter(splitFrontMatter(decodeText(raw).text).front);
    return (
      <div className="empty-state">
        <h2>{path}</h2>
        <p>{error ? `The front matter can't be read: ${error}` : 'This file has no id in its front matter, so it is not a requirement or test case.'}</p>
      </div>
    );
  }

  const statuses = statusesFor(index.config, item.kind);
  const jira = index.config.jiraUrl;
  const reqSuggestions = index.items.filter((i) => i.kind === 'requirement').map((i) => ({ value: i.id, label: i.title }));
  const componentSuggestions = index.config.components.map((c) => ({ value: c.key, label: c.name }));

  return (
    <div className="item-view">
      <article className="item-main">
        <header className="item-head">
          <div className="item-head-row">
            <span className="item-id big">{item.id}</span>
            <span className="kind-label">{item.kind === 'requirement' ? 'Requirement' : 'Test case'}</span>
            <span className="tool-spacer" />
            <label className="status-field">
              <span className="visually-hidden">Status</span>
              <select value={item.status} onChange={(e) => setField({ status: e.target.value })} className={`status-select status-${item.status}`}>
                {!statuses.includes(item.status) && <option value={item.status}>{item.status || '(none)'}</option>}
                {statuses.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <button type="button" className="icon-button" aria-label="Delete" title="Delete this file" onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" />
            </button>
          </div>
          <textarea
            className="title-input"
            rows={1}
            value={item.title}
            // One line in the file: Enter doesn't add a line break.
            onChange={(e) => setField({ title: e.target.value.replace(/\s*\n\s*/g, ' ') })}
            onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
            placeholder="Title"
            aria-label="Title"
          />
          <div className="fields">
            {item.kind === 'testcase' && (
              <ChipInput
                label="Verifies"
                mono
                values={item.verifies}
                suggestions={reqSuggestions}
                onOpen={onOpenId}
                placeholder="REQ-…"
                onChange={(verifies) => {
                  // A link added here is reviewed now; one removed loses its review.
                  const reviewed: Record<string, string> = {};
                  for (const v of verifies) {
                    if (item.reviewed[v]) reviewed[v] = item.reviewed[v];
                    else if (!item.verifies.includes(v)) {
                      const req = index.byId.get(v);
                      if (req) reviewed[v] = fingerprint(req);
                    }
                  }
                  setField({ verifies, reviewed });
                }}
              />
            )}
            <ChipInput label="Components" values={item.components} suggestions={componentSuggestions} onChange={(components) => setField({ components })} placeholder="Add component" />
            <ChipInput label="Jira" mono values={item.jira} href={jira ? (k) => `${jira}/browse/${encodeURIComponent(k)}` : undefined} onChange={(v) => setField({ jira: v })} placeholder="PROJ-123" />
          </div>
          <div className="item-path mono" title="File in the repository">
            {path}
          </div>
        </header>
        <Editor doc={doc} onChange={onChange} refs={refs} onOpenRef={onOpenId} resolveImage={resolveImage} />
      </article>
      <TracePanel project={project} item={item} onOpenId={onOpenId} onNewTest={onNewTest} onShowInGraph={onShowInGraph} />
      {confirmDelete && (
        <Dialog title={`Delete ${item.id}?`} onClose={() => setConfirmDelete(false)}>
          <div className="dialog-body">
            <p>
              This deletes <code>{path}</code>. It stays in git history, and you can bring it back by discarding the change before you commit.
            </p>
            {item.kind === 'requirement' && (index.verifiedBy.get(item.id)?.length ?? 0) > 0 && (
              <p className="warn-text">{index.verifiedBy.get(item.id)!.map((t) => t.id).join(', ')} verify it, and will have broken links.</p>
            )}
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
                  clearTimeout(timer.current);
                  latestDoc.current = null;
                  await project.deleteItem(path);
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
