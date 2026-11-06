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
import { api } from '../api';
import { notify } from '../notify';
import { load as loadSetting, save as saveSetting } from '../storage';
import type { Blame, FileCommit, GitChange } from '../../../shared/api';
import { bodyBlocks, readVersion, whatChanged } from '../../../core/diff';
import { NO_MARKS, type GitMarks } from '../editor/gitmarks';
import { CompareDialog } from './Compare';
import { CommitDialog } from './GitBar';
import { timeAgo } from './bits';

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

// A setting kept in this browser.
function useSetting(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => loadSetting<boolean>(key) ?? initial);
  return [
    v,
    (next) => {
      setV(next);
      saveSetting(key, next);
    },
  ];
}

const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Who last changed each block of the text, from git blame of the file on disk.
function blameLabels(b: Blame): NonNullable<GitMarks['blame']> {
  const v = readVersion(b.lines.map((l) => l.text).join('\n'));
  const blocks = bodyBlocks(v.body);
  const labels = blocks.map((bl) => {
    if (bl.from < 0) return '';
    const lines = b.lines.slice(v.bodyLine + bl.from, v.bodyLine + bl.to).filter((l) => l.text.trim());
    if (lines.some((l) => !l.commit)) return 'Not committed yet';
    const latest = lines
      .map((l) => ({ hash: l.commit!, ...b.commits[l.commit!] }))
      .filter((c) => c.date)
      .sort((x, y) => y.date.localeCompare(x.date))[0];
    return latest ? `${latest.author} · ${timeAgo(latest.date)} · ${shorten(latest.message, 70)} (${latest.hash.slice(0, 7)})` : '';
  });
  return {
    blocks: blocks.map((x) => x.key),
    labels,
    uncommitted: 'Not committed yet',
  };
}

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

  // ---- Git: what changed since the last commit, who changed what ----
  const git = project.git;
  const repoId = project.repo.id;
  const gitKey = git ? `${git.head}:${git.changes.length}` : '';
  const [head, setHead] = useState<{
    path: string;
    text: string | null;
  } | null>(null); // the committed version
  const [log, setLog] = useState<FileCommit[]>([]);
  const [showChanges, setShowChanges] = useSetting('trace.showChanges', true);
  const [showBlame, setShowBlame] = useSetting('trace.showBlame', false);
  const [blame, setBlame] = useState<GitMarks['blame']>(null);
  const [comparing, setComparing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    let live = true;
    if (!git?.head) {
      setHead({ path, text: null });
      return;
    }
    api.gitShow(repoId, git.head, path).then(
      (text) => live && setHead({ path, text }),
      () => live && setHead({ path, text: null }),
    );
    return () => {
      live = false;
    };
  }, [repoId, git?.head, path]);

  useEffect(() => {
    let live = true;
    if (!git) return setLog([]);
    api.gitLog(repoId, path).then(
      (l) => live && setLog(l),
      () => live && setLog([]),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, path, gitKey]);

  // Blame reads the file on disk: ask again once a change is saved.
  useEffect(() => {
    if (!showBlame || !git) return setBlame(null);
    let live = true;
    const t = setTimeout(() => {
      api.gitBlame(repoId, path).then(
        (b) => live && setBlame(b ? blameLabels(b) : { blocks: [], labels: [], uncommitted: 'Not committed yet' }),
        () => live && setBlame(null),
      );
    }, 500);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBlame, repoId, path, gitKey, project.saving]);

  const committed = head && head.path === path ? head.text : undefined; // undefined: loading; null: not committed
  const changes = useMemo(() => (committed ? whatChanged(committed, raw) : []), [committed, raw]);
  const base = useMemo(() => (committed ? bodyBlocks(readVersion(committed).body).map((b) => b.key) : null), [committed]);
  const conflicted = !!git?.changes.some((c) => c.path === path && c.kind === 'conflicted');
  const fileState = !git || committed === undefined ? 'unknown' : conflicted ? 'conflicted' : committed === null ? 'new' : changes.length ? 'changed' : 'clean';
  const gitMarks = useMemo<GitMarks>(
    () =>
      git
        ? {
            base: showChanges && fileState === 'changed' ? base : null,
            blame: showBlame ? blame : null,
          }
        : NO_MARKS,
    [git, showChanges, fileState, base, showBlame, blame],
  );

  const discard = () => {
    if (committed == null) return;
    setConfirmDiscard(false);
    clearTimeout(timer.current);
    latestDoc.current = null;
    setText(path, committed);
    notify(`Your changes to ${item?.id ?? path} are discarded.`, 'success');
  };

  const commitItem = async (message: string, paths: string[], author: Parameters<typeof api.gitCommit>[3], push: boolean) => {
    setCommitting(false);
    try {
      if (flushBody()) compose();
      await project.flush();
      await api.gitCommit(repoId, message, paths, author);
      if (push) await api.gitPush(repoId);
      notify(push ? 'Committed and pushed.' : 'Committed.', 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      await project.reload();
    }
  };

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
        {git && fileState !== 'unknown' && (
          <div className={`git-strip ${fileState}`}>
            <span className="git-strip-text">
              {fileState === 'conflicted' ? (
                <span className="warn-text">You and the server both changed this file: resolve it with “Resolve conflicts” in the bottom bar.</span>
              ) : fileState === 'new' ? (
                <>
                  <span className="chg-dot new" /> New: not committed yet
                </>
              ) : fileState === 'changed' ? (
                <>
                  <span className="chg-dot" /> Changed since the last commit: {changes.join(', ')}
                </>
              ) : (
                <span className="muted">{log[0] ? `No changes since the last commit · last changed by ${log[0].author}, ${timeAgo(log[0].date)}` : 'No changes since the last commit'}</span>
              )}
            </span>
            <span className="git-strip-actions">
              {fileState === 'changed' && (
                <>
                  <button
                    type="button"
                    className={`button small toggle${showChanges ? ' on' : ''}`}
                    aria-pressed={showChanges}
                    onClick={() => setShowChanges(!showChanges)}
                    title="Mark changed blocks in the text"
                  >
                    Show changes
                  </button>
                  {log.length > 0 && (
                    <button type="button" className="button small" onClick={() => setComparing(true)}>
                      Compare
                    </button>
                  )}
                  <button type="button" className="button small" onClick={() => setConfirmDiscard(true)}>
                    Discard…
                  </button>
                </>
              )}
              {(fileState === 'changed' || fileState === 'new') && (
                <button type="button" className="button small primary" onClick={() => setCommitting(true)}>
                  Commit…
                </button>
              )}
              <button
                type="button"
                className={`button small toggle${showBlame ? ' on' : ''}`}
                aria-pressed={showBlame}
                onClick={() => setShowBlame(!showBlame)}
                title="Point at a paragraph to see who last changed it"
              >
                Who changed what
              </button>
            </span>
          </div>
        )}
        <div className={`editor-wrap${showBlame && git ? ' blame-on' : ''}`}>
          <Editor doc={doc} onChange={onChange} refs={refs} onOpenRef={onOpenId} resolveImage={resolveImage} gitMarks={gitMarks} />
        </div>
      </article>
      <TracePanel project={project} item={item} onOpenId={onOpenId} onNewTest={onNewTest} onShowInGraph={onShowInGraph} />
      {comparing && log.length > 0 && <CompareDialog project={project} item={item} log={log} start={0} against="now" onClose={() => setComparing(false)} />}
      {confirmDiscard && (
        <Dialog title={`Discard your changes to ${item.id}?`} onClose={() => setConfirmDiscard(false)}>
          <div className="dialog-body">
            <p>
              {item.id} goes back to the last commit
              {log[0] ? ` (${log[0].commit.slice(0, 7)}, ${log[0].author})` : ''}. Changed: {changes.join(', ')}. This can’t be undone.
            </p>
            <div className="dialog-actions">
              <span className="tool-spacer" />
              <button type="button" className="button" onClick={() => setConfirmDiscard(false)}>
                Cancel
              </button>
              <button type="button" className="button danger" onClick={discard}>
                Discard changes
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {committing && git && (
        <CommitDialog
          project={project}
          changes={((): GitChange[] => {
            const mine = git.changes.filter((c) => c.path === path);
            return mine.length ? mine : [{ path, kind: fileState === 'new' ? 'added' : 'modified' }];
          })()}
          initialMessage={`${item.id}: `}
          onClose={() => setCommitting(false)}
          onCommit={(message, paths, author, push) => void commitItem(message, paths, author, push)}
        />
      )}
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
