// One requirement or test case: its fields (front matter), its text (WYSIWYG), and
// what it's linked to.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Node as PMNode } from 'prosemirror-model';
import { decodeText, encodeText, joinFrontMatter, readFrontMatter, setFields, splitFrontMatter } from '../../../core/frontmatter';
import { parseBody, serializeBody, type ParsedBody } from '../../../core/markdown/markdown';
import { isRunnable, isVerifiable, linksFrom, statusesFor, typeOf, typeWord } from '../../../core/config';
import { byEvidence, fingerprint, linkedIds, METHOD_LABEL, METHODS, type Item } from '../../../core/model';
import type { Project } from '../project';
import { Editor } from '../editor/Editor';
import type { RefTarget } from '../editor/setup';
import { ChipInput } from './bits';
import { durationText, formatDuration, parseDuration } from '../../../core/estimate';
import { TracePanel } from './TracePanel';
import type { RunFocus } from './RunsView';
import { Dialog } from './Dialog';
import { RenameDialog } from './RenameDialog';
import { Icon } from '../icons';
import { api } from '../api';
import { notify } from '../notify';
import { load as loadSetting, save as saveSetting } from '../storage';
import type { Blame, FileCommit, GitChange } from '../../../shared/api';
import { bodyBlocks, readVersion, whatChanged } from '../../../core/diff';
import { imagesIn, MAX_IMAGE_BYTES, newImagePath } from '../../../core/images';
import { NO_MARKS, type GitMarks } from '../editor/gitmarks';
import { CompareDialog, imageResolver } from './Compare';
import { CommitDialog } from './GitBar';
import { timeAgo } from './bits';
import { fieldInput, fieldIssue, fieldText, listValue, otherFields } from '../../../core/fields';
import { fieldsFor, type FieldDef, type TraceConfig } from '../../../core/config';

interface Props {
  project: Project;
  path: string;
  onOpenId: (id: string) => void;
  onNewTest: (req: Item) => void;
  onNewRefinement: (req: Item) => void;
  onNewLinked: (kind: string, link: string, target: Item) => void;
  onShowInGraph: (item: Item) => void;
  onOpenRun: (focus: RunFocus) => void;
  onDeleted: () => void;
  onRenamed: (path: string) => void; // its ID changed, and the file with it
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

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

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

export function ItemView({ project, path, onOpenId, onNewTest, onNewRefinement, onNewLinked, onShowInGraph, onOpenRun, onDeleted, onRenamed }: Props) {
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
  const [renaming, setRenaming] = useState(false);
  const idRef = useRef('');
  idRef.current = item?.id || path.replace(/^.*\//, '').replace(/\.md$/i, '');

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

  // Items to suggest in link fields, by type: made once per change to the project.
  const byKind = useMemo(() => {
    const m = new Map<string, { value: string; label: string }[]>();
    for (const i of index.items) {
      const l = m.get(i.kind);
      const s = { value: i.id, label: i.title };
      if (l) l.push(s);
      else m.set(i.kind, [s]);
    }
    return m;
  }, [index]);
  const suggestionsOf = (kinds: string[]) => (kinds.length === 1 ? (byKind.get(kinds[0]) ?? []) : kinds.flatMap((k) => byKind.get(k) ?? []));

  const refs = useMemo(() => {
    const m = new Map<string, RefTarget>();
    for (const it of index.items) m.set(it.id, { title: it.title });
    return m;
  }, [index]);

  const resolveImage = useMemo(() => imageResolver(project.repo.id, path), [project.repo.id, path]);

  // Pasted or dropped images go in images/ beside the item, named after it.
  const addImages = useCallback(
    (files: File[]) =>
      Promise.all(
        files.map(async (f) => {
          const where = newImagePath(path, idRef.current, f.name, f.type);
          if (!where) {
            notify(`${f.name || 'That image'} can’t be added: use PNG, JPEG, GIF or WebP.`, 'error');
            return null;
          }
          if (f.size > MAX_IMAGE_BYTES) {
            notify(`${f.name || 'The image'} is too large (10 MB at most).`, 'error');
            return null;
          }
          try {
            const saved = await api.addImage(project.repo.id, where.path, toBase64(new Uint8Array(await f.arrayBuffer())));
            void project.refreshGit();
            const name = f.name.replace(/\.[^.]*$/, '');
            return { src: where.src.replace(/[^/]*$/, saved.slice(saved.lastIndexOf('/') + 1)), alt: name && !/^image$/i.test(name) ? name : null };
          } catch (e) {
            notify(`Couldn’t add ${f.name || 'the image'}: ${(e as Error).message}`, 'error');
            return null;
          }
        }),
      ),
    [path, project],
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
    // A large repository's index catches up a moment after an edit (a new item, say).
    if (project.pending) return <div className="empty-state muted">Loading…</div>;
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
  // A link added here is reviewed now; one removed loses its review, unless the item
  // still links to it in another list (a requirement's refines and its mitigates…).
  const reviewedFor = (it: Item, before: string[], after: string[], list?: string) => {
    const reviewed: Record<string, string> = {};
    const others = list
      ? linkedIds({ ...it, verifies: list === 'verifies' ? [] : it.verifies, refines: list === 'refines' ? [] : it.refines, links: { ...it.links, [list]: [] } })
      : [];
    for (const [k, v] of Object.entries(it.reviewed)) if (!before.includes(k) || after.includes(k) || others.includes(k)) reviewed[k] = v;
    for (const v of after)
      if (!reviewed[v] && !before.includes(v)) {
        const req = index.byId.get(v);
        if (req) reviewed[v] = fingerprint(req);
      }
    return reviewed;
  };
  const reqSuggestions = suggestionsOf(['requirement']);
  const componentSuggestions = index.config.components.map((c) => ({ value: c.key, label: c.name }));
  const variantSuggestions = index.config.variants.map((v) => ({ value: v.key, label: v.name }));

  return (
    <div className="item-view">
      <article className="item-main">
        <header className="item-head">
          <div className="item-head-row">
            <button
              type="button"
              className="item-id big id-button"
              title="Change the ID, and everywhere it’s named"
              onClick={() => {
                // Write the text being typed first, so the rename sees it.
                if (flushBody()) compose();
                setRenaming(true);
              }}
            >
              {item.id}
              <Icon name="edit" size={12} />
            </button>
            <span className="kind-label">{typeOf(index.config, item.kind).name}</span>
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
          <TitleInput value={item.title} onChange={(title) => setField({ title })} />
          <div className="fields">
            {isRunnable(index.config, item.kind) && (
              <ChipInput
                label="Verifies"
                mono
                values={item.verifies}
                suggestions={suggestionsOf(index.config.types.filter((t) => isVerifiable(index.config, t.key)).map((t) => t.key))}
                onOpen={onOpenId}
                placeholder={`${index.config.types.filter((t) => isVerifiable(index.config, t.key)).map((t) => t.prefix || t.name).join(' / ')}…`}
                onChange={(verifies) => setField({ verifies, reviewed: reviewedFor(item, item.verifies, verifies, 'verifies') })}
              />
            )}
            {item.kind === 'requirement' && (
              <ChipInput
                label="Refines"
                mono
                values={item.refines}
                suggestions={reqSuggestions.filter((s) => s.value !== item.id)}
                onOpen={onOpenId}
                placeholder="REQ-… it breaks down"
                onChange={(refines) => setField({ refines, reviewed: reviewedFor(item, item.refines, refines, 'refines') })}
              />
            )}
            {linksFrom(index.config, item.kind)
              .filter((l) => !l.builtIn)
              .map((l) => (
                <ChipInput
                  key={l.key}
                  label={l.name}
                  mono
                  values={item.links[l.key] ?? []}
                  suggestions={suggestionsOf(l.to).filter((x) => x.value !== item.id)}
                  onOpen={onOpenId}
                  placeholder={`${l.to.map((k) => typeOf(index.config, k).prefix || typeWord(index.config, k)).join(' / ')}…`}
                  onChange={(ids) => setField({ [l.key]: ids.length ? ids : undefined, reviewed: reviewedFor(item, item.links[l.key] ?? [], ids, l.key) })}
                />
              ))}
            {item.kind === 'requirement' && (
              <div className="chip-field">
                <label htmlFor="verification" className="chip-label">
                  Verification
                </label>
                <select
                  id="verification"
                  className="field-select"
                  value={item.verification}
                  onChange={(e) => setField({ verification: e.target.value === 'test' ? undefined : e.target.value })}
                  title="How this requirement is verified. By analysis, inspection or demonstration: it’s covered once Evidence names what shows it. None: it needs no verification."
                >
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m === 'test' ? 'Test (test cases)' : METHOD_LABEL[m]}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {item.kind === 'requirement' && (byEvidence(item.verification) || item.evidence.length > 0) && (
              <ChipInput
                label="Evidence"
                values={item.evidence}
                href={(v) => (/^https?:\/\//i.test(v) ? v : null)}
                onChange={(evidence) => setField({ evidence: evidence.length ? evidence : undefined })}
                placeholder="Document or link"
              />
            )}
            <ChipInput label="Components" values={item.components} suggestions={componentSuggestions} onChange={(components) => setField({ components })} placeholder="Add component" />
            {(variantSuggestions.length > 0 || item.variants.length > 0) && (
              <ChipInput
                label="Variants"
                values={item.variants}
                suggestions={variantSuggestions}
                onChange={(variants) => setField({ variants })}
                placeholder={item.variants.length ? 'Add variant' : 'All variants'}
              />
            )}
            {isRunnable(index.config, item.kind) && <EstimateField raw={item.data.estimate == null ? '' : String(item.data.estimate)} onChange={(estimate) => setField({ estimate })} />}
            <ChipInput label="Jira" mono values={item.jira} href={jira ? (k) => `${jira}/browse/${encodeURIComponent(k)}` : undefined} onChange={(v) => setField({ jira: v })} placeholder="PROJ-123" />
            {fieldsFor(index.config, item.kind).map((f) => (
              <DeclaredField key={f.key} def={f} value={item.data[f.key]} onChange={(v) => setField({ [f.key]: v })} />
            ))}
          </div>
          <OtherFields item={item} config={index.config} />
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
          <Editor doc={doc} onChange={onChange} refs={refs} onOpenRef={onOpenId} resolveImage={resolveImage} gitMarks={gitMarks} onAddImages={addImages} />
        </div>
      </article>
      <TracePanel project={project} item={item} onOpenId={onOpenId} onNewTest={onNewTest} onNewRefinement={onNewRefinement} onNewLinked={onNewLinked} onShowInGraph={onShowInGraph} onOpenRun={onOpenRun} />
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
            // The item, and new or changed images it shows.
            const images = new Set(imagesIn(path, raw));
            const mine = git.changes.filter((c) => c.path === path || images.has(c.path));
            if (!mine.some((c) => c.path === path)) mine.unshift({ path, kind: fileState === 'new' ? 'added' : 'modified' });
            return mine;
          })()}
          initialMessage={`${item.id}: `}
          onClose={() => setCommitting(false)}
          onCommit={(message, paths, author, push) => void commitItem(message, paths, author, push)}
        />
      )}
      {renaming && <RenameDialog project={project} item={item} onClose={() => setRenaming(false)} onRenamed={onRenamed} />}
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

// How long the test case takes to run. Saved tidied (90 → 1h 30m) when it can be read.
function EstimateField({ raw, onChange }: { raw: string; onChange: (v: string | undefined) => void }) {
  const [text, setText] = useState(raw);
  useEffect(() => setText(raw), [raw]);
  const minutes = parseDuration(text);
  const commit = () => {
    const t = text.trim();
    if (!t) {
      if (raw) onChange(undefined);
      return;
    }
    if (minutes == null) return;
    const tidy = durationText(minutes);
    if (tidy !== raw) onChange(tidy);
    setText(tidy);
  };
  return (
    <div className="chip-field estimate-field">
      <label htmlFor="estimate" className="chip-label">
        Estimate
      </label>
      <input
        id="estimate"
        value={text}
        placeholder="30m"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        aria-invalid={minutes === null}
        title="How long running it takes: 30m, 1h, 1h 30m"
      />
      {minutes === null ? <span className="warn-text small">Write it like 30m or 1h 30m</span> : minutes != null && text.trim() !== durationText(minutes) ? <span className="muted small">{formatDuration(minutes)}</span> : null}
    </div>
  );
}

// Fields Tracey has no editor for (from an import, or written by hand): shown as they
// are, read-only. Saving never touches them.
function OtherFields({ item, config }: { item: Item; config: TraceConfig }) {
  const fields = otherFields(item, config);
  if (!fields.length) return null;
  return (
    <div className="other-fields" title="Read-only here: change these in the file itself.">
      {fields.map(([k, v]) => (
        <div key={k} className="chip-field">
          <span className="chip-label">{k}</span>
          {Array.isArray(v) ? (
            <span className="chips">
              {v.map((x, i) => (
                <span key={i} className="chip read-only">
                  {fieldText(x)}
                </span>
              ))}
            </span>
          ) : (
            <span className="field-value">{fieldText(v)}</span>
          )}
        </div>
      ))}
      <span className="other-fields-note">
        <Icon name="lock" size={12} /> read-only
      </span>
    </div>
  );
}

// A field trace.yml declares: a list of choices, chips, or a box for one value.
export function DeclaredField({ def, value, onChange }: { def: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const issue = fieldIssue(def, value);
  const id = `field-${def.key}`;
  if (def.type === 'list' || def.type === 'choices')
    return (
      <ChipInput
        label={def.name}
        values={listValue(value)}
        suggestions={def.values.map((v) => ({ value: v, label: v }))}
        onChange={(v) => onChange(v.length ? v : undefined)}
        placeholder={def.type === 'choices' ? 'Add' : 'Add…'}
      />
    );
  if (def.type === 'choice') {
    const current = value == null ? '' : fieldText(value);
    return (
      <div className="chip-field">
        <label htmlFor={id} className="chip-label">
          {def.name}
        </label>
        <select id={id} className="field-select" value={current} onChange={(e) => onChange(e.target.value || undefined)} aria-invalid={!!issue} title={issue ?? undefined}>
          <option value="">—</option>
          {current && !def.values.includes(current) && <option value={current}>{current} (not a choice)</option>}
          {def.values.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </div>
    );
  }
  return <TextField def={def} id={id} raw={value == null ? '' : fieldText(value)} issue={issue} onChange={onChange} />;
}

function TextField({ def, id, raw, issue, onChange }: { def: FieldDef; id: string; raw: string; issue: string | null; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(raw);
  useEffect(() => setText(raw), [raw]);
  const commit = (t = text) => {
    if (t.trim() !== raw) onChange(fieldInput(def, t));
  };
  return (
    <div className="chip-field">
      <label htmlFor={id} className="chip-label">
        {def.name}
      </label>
      <input
        id={id}
        className={`field-input ${def.type}`}
        type={def.type === 'date' ? 'date' : 'text'}
        inputMode={def.type === 'number' ? 'decimal' : undefined}
        value={text}
        placeholder={def.type === 'number' ? '0' : '—'}
        onChange={(e) => {
          setText(e.target.value);
          if (def.type === 'date') commit(e.target.value);
        }}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        aria-invalid={!!issue}
        title={issue ? `Has ${issue}` : undefined}
      />
    </div>
  );
}

// The title, typed into its own state: in a large repository the item shown catches up a
// moment after each edit, and the box mustn't jump back meanwhile. A change from
// elsewhere (getting the latest, say) still shows.
function TitleInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  const sent = useRef(value);
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value);
    }
  }, [value]);
  return (
    <textarea
      className="title-input"
      rows={1}
      value={text}
      // One line in the file: Enter doesn't add a line break.
      onChange={(e) => {
        const v = e.target.value.replace(/\s*\n\s*/g, ' ');
        sent.current = v;
        setText(v);
        onChange(v);
      }}
      onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
      placeholder="Title"
      aria-label="Title"
    />
  );
}
