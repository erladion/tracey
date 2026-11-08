// A ProseMirror view for one item's text, with its toolbar.
import { useEffect, useRef, useState } from 'react';
import { EditorView } from 'prosemirror-view';
import { Slice, type Node as PMNode } from 'prosemirror-model';
import { undo, redo } from 'prosemirror-history';
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, deleteTable } from 'prosemirror-tables';
import { TextSelection, type Command, type Transaction } from 'prosemirror-state';
import { schema } from '../../../core/markdown/schema';
import { parser } from '../../../core/markdown/markdown';
import { createEditorState, refsKey, type RefTarget } from './setup';
import { gitMarksKey, type GitMarks } from './gitmarks';
import {
  blockStyle,
  codeBlock,
  currentLink,
  heading,
  inside,
  insertRule,
  insertTable,
  markActive,
  paragraph,
  setLink,
  toggleCode,
  toggleEm,
  toggleList,
  toggleQuote,
  toggleStrike,
  toggleStrong,
} from './commands';
import { Icon } from '../icons';
import { Dialog } from '../components/Dialog';

interface Props {
  doc: PMNode; // a new document object (re)starts the editor
  onChange: (doc: PMNode) => void;
  refs: Map<string, RefTarget>;
  onOpenRef: (id: string) => void;
  resolveImage: (src: string) => string;
  gitMarks: GitMarks; // changes since the last commit, and who changed what
  // Saves pasted or dropped image files: what to link for each (null: not saved).
  onAddImages?: (files: File[]) => Promise<({ src: string; alt: string | null } | null)[]>;
  // What to show when hovering an item's ID in the text.
  describeRef?: (id: string) => RefCard | null;
}

export interface RefCard {
  kind: string; // "Requirement"
  title: string;
  status: string;
  lines: string[]; // "Verified by TC-101, TC-102", "Last result: passed (Release 2.4)"
  warn?: string; // "Changed since reviewed by TC-102"
}

// The ID being typed just before the cursor (REQ-, REQ-0, REQ-retry), and where it starts.
const TYPING_ID = /(?:^|[^\w-])([A-Z][A-Z0-9_]*-[\w.-]*)$/;
const MAX_SUGGESTIONS = 8;

// IDs starting with what's typed, or with its prefix and a title containing the rest:
// "REQ-retry" finds "REQ-07 Payment retry".
function suggestIds(refs: Map<string, RefTarget>, typed: string): { id: string; title: string }[] {
  const dash = typed.indexOf('-');
  const head = typed.slice(0, dash + 1);
  const rest = typed.slice(dash + 1).toLowerCase();
  const byWords = rest.length >= 2 && /[a-z]/.test(rest);
  const out: { id: string; title: string }[] = [];
  for (const [id, t] of refs) {
    if (!id.startsWith(head)) continue;
    if (id.startsWith(typed) || (byWords && t.title.toLowerCase().includes(rest))) out.push({ id, title: t.title });
    if (out.length >= 200) break;
  }
  return out.sort((a, b) => Number(!a.id.startsWith(typed)) - Number(!b.id.startsWith(typed)) || a.id.localeCompare(b.id, undefined, { numeric: true })).slice(0, MAX_SUGGESTIONS);
}

// Images go in paragraphs of their own, after the one the cursor is in (before it at
// its start, in place of it when empty); in a table cell, where only text fits, inline.
function placeImages(tr: Transaction, images: PMNode[]): Transaction {
  const { $from } = tr.selection;
  const parent = $from.parent;
  if (parent.type !== schema.nodes.paragraph || !tr.selection.empty) {
    for (const n of images) tr.replaceSelectionWith(n, false);
    return tr;
  }
  const paras = images.map((n) => schema.nodes.paragraph.create(null, n));
  if (!parent.content.size) return tr.replaceWith($from.before(), $from.after(), paras);
  // Spaces and line breaks around the cursor would be left dangling by a split.
  const start = $from.start();
  const end = $from.end();
  const breaks = [schema.nodes.soft_break, schema.nodes.hard_break];
  const space = (at: number) => /\s/.test(tr.doc.textBetween(at, at + 1, undefined, (leaf) => (breaks.includes(leaf.type) ? '\n' : '\ufffc')));
  let from = $from.pos;
  let to = $from.pos;
  while (from > start && space(from - 1)) from--;
  while (to < end && space(to)) to++;
  if (from === start) tr.insert($from.before(), paras);
  else if (to === end) tr.insert($from.after(), paras);
  else {
    tr.delete(from, to);
    tr.split(from);
    tr.insert(from + 1, paras); // between the two halves
  }
  return tr;
}

const imageFiles = (list: FileList | null | undefined) => [...(list ?? [])].filter((f) => f.type.startsWith('image/'));

export function Editor({ doc, onChange, refs, onOpenRef, resolveImage, gitMarks, onAddImages, describeRef }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [, setTick] = useState(0);
  const [linkDialog, setLinkDialog] = useState<{ href: string } | null>(null);
  const latest = useRef({ onChange, onOpenRef, resolveImage, gitMarks, onAddImages, refs });
  latest.current = { onChange, onOpenRef, resolveImage, gitMarks, onAddImages, refs };
  // The card shown while hovering an ID.
  const [hover, setHover] = useState<{ id: string; card: RefCard; x: number; y: number } | null>(null);
  // ID suggestions while typing one: where it starts, what's typed, which is chosen.
  const [suggest, setSuggest] = useState<{ from: number; typed: string; items: { id: string; title: string }[]; at: number; x: number; y: number } | null>(null);
  const suggestRef = useRef(suggest);
  suggestRef.current = suggest;
  const dismissed = useRef<string | null>(null); // Escape: not again for this position and text
  const lookForId = (view: EditorView) => {
    const sel = view.state.selection;
    const $from = sel.$from;
    if (!sel.empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return setSuggest(null);
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
    const m = TYPING_ID.exec(before);
    if (!m) return setSuggest(null);
    const typed = m[1];
    const from = $from.pos - typed.length;
    const items = suggestIds(latest.current.refs, typed).filter((x) => x.id !== typed);
    if (!items.length || dismissed.current === `${from}:${typed}`) return setSuggest(null);
    const c = view.coordsAtPos(from);
    setSuggest((old) => ({ from, typed, items, at: old && old.from === from ? Math.min(old.at, items.length - 1) : 0, x: c.left, y: c.bottom }));
  };
  const accept = (view: EditorView, id: string) => {
    const s = suggestRef.current;
    if (!s) return;
    view.dispatch(view.state.tr.insertText(id, s.from, view.state.selection.from));
    setSuggest(null);
    view.focus();
  };

  // Save the files, then put the images where they were pasted or dropped (`at`), or at
  // the cursor if the text changed while saving.
  const insertImages = (files: File[], at: number | null) => {
    const add = latest.current.onAddImages;
    const view = viewRef.current;
    if (!add || !view) return;
    const start = view.state.doc;
    void add(files).then((saved) => {
      if (viewRef.current !== view) return; // another item is open now
      const nodes = saved.filter((s) => s != null).map((s) => schema.nodes.image.create({ src: s.src, alt: s.alt }));
      if (!nodes.length) return;
      const tr = view.state.tr;
      if (at != null && view.state.doc === start) tr.setSelection(TextSelection.near(tr.doc.resolve(at)));
      view.dispatch(placeImages(tr, nodes).scrollIntoView());
      view.focus();
    });
  };
  const insertRef = useRef(insertImages);
  insertRef.current = insertImages;

  useEffect(() => {
    const view = new EditorView(host.current!, {
      state: createEditorState(doc, (id) => latest.current.onOpenRef(id)),
      attributes: { class: 'prose', spellcheck: 'true', 'aria-label': 'Text' },
      nodeViews: {
        image(node) {
          const img = document.createElement('img');
          img.src = latest.current.resolveImage(node.attrs.src);
          if (node.attrs.alt) img.alt = node.attrs.alt;
          if (node.attrs.title) img.title = node.attrs.title;
          return { dom: img };
        },
      },
      // Plain text pasted from elsewhere is read as Markdown. (ProseMirror pastes into
      // code blocks as-is without asking.)
      // Images pasted or dropped from files or screenshots are saved into the repository.
      handlePaste(_view, event) {
        const files = imageFiles(event.clipboardData?.files);
        if (!files.length || !latest.current.onAddImages) return false;
        event.preventDefault();
        insertRef.current(files, null);
        return true;
      },
      handleDrop(view, event) {
        const files = imageFiles(event.dataTransfer?.files);
        if (!files.length || !latest.current.onAddImages) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
        insertRef.current(files, at);
        return true;
      },
      clipboardTextParser(text) {
        const doc = parser.parse(text);
        // One paragraph: paste its text inline rather than as a new block.
        const open = doc.childCount === 1 && doc.firstChild!.type === schema.nodes.paragraph ? 1 : 0;
        return new Slice(doc.content, open, open);
      },
      dispatchTransaction(tr) {
        const v = viewRef.current!;
        v.updateState(v.state.apply(tr));
        if (tr.docChanged) latest.current.onChange(v.state.doc);
        if (tr.docChanged || tr.selectionSet) lookForId(v);
        setTick((t) => t + 1);
      },
      // While suggestions are shown, the arrows choose, Enter or Tab takes one, Escape
      // closes them.
      handleKeyDown(view, event) {
        const s = suggestRef.current;
        if (!s) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const n = s.items.length;
          setSuggest({ ...s, at: (s.at + (event.key === 'ArrowDown' ? 1 : n - 1)) % n });
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          accept(view, s.items[s.at].id);
          return true;
        }
        if (event.key === 'Escape') {
          dismissed.current = `${s.from}:${s.typed}`;
          setSuggest(null);
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        blur: () => {
          setSuggest(null);
          return false;
        },
      },
    });
    viewRef.current = view;
    view.dispatch(view.state.tr.setMeta(refsKey, refs).setMeta(gitMarksKey, latest.current.gitMarks).setMeta('addToHistory', false));
    setTick((t) => t + 1);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // refs are sent separately below; a new doc restarts the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch(view.state.tr.setMeta(refsKey, refs).setMeta('addToHistory', false));
  }, [refs]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch(view.state.tr.setMeta(gitMarksKey, gitMarks).setMeta('addToHistory', false));
  }, [gitMarks]);

  const view = viewRef.current;
  const run = (cmd: Command) => () => {
    if (!view) return;
    cmd(view.state, view.dispatch, view);
    view.focus();
  };
  const state = view?.state;
  const can = (cmd: Command) => !!state && cmd(state);
  const inTable = !!state && inside(state, schema.nodes.table) != null;

  const btn = (icon: string, label: string, cmd: Command, active = false, shortcut = '') => (
    <button
      type="button"
      className={`tool${active ? ' active' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run(cmd)}
      disabled={!can(cmd)}
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      <Icon name={icon} />
    </button>
  );

  return (
    <div className="editor">
      <div className="toolbar" role="toolbar" aria-label="Formatting">
        <select
          className="block-style"
          aria-label="Paragraph style"
          value={state ? blockStyle(state) : 'p'}
          onChange={(e) => {
            const v = e.target.value;
            run(v === 'p' ? paragraph : v === 'code' ? codeBlock : heading(Number(v.slice(1))))();
          }}
        >
          <option value="p">Text</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
          <option value="h4">Heading 4</option>
          <option value="code">Code</option>
        </select>
        <span className="tool-sep" />
        {btn('bold', 'Bold', toggleStrong, !!state && markActive(state, schema.marks.strong), 'Ctrl+B')}
        {btn('italic', 'Italic', toggleEm, !!state && markActive(state, schema.marks.em), 'Ctrl+I')}
        {btn('strike', 'Strikethrough', toggleStrike, !!state && markActive(state, schema.marks.strike), 'Ctrl+Shift+X')}
        {btn('code', 'Code', toggleCode, !!state && markActive(state, schema.marks.code), 'Ctrl+E')}
        <button
          type="button"
          className={`tool${state && currentLink(state) ? ' active' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => state && setLinkDialog({ href: currentLink(state)?.href ?? '' })}
          aria-label="Link"
          title="Link (Ctrl+K)"
        >
          <Icon name="link" />
        </button>
        <span className="tool-sep" />
        {btn('bullets', 'Bulleted list', toggleList(schema.nodes.bullet_list), !!state && inside(state, schema.nodes.bullet_list) != null, 'Ctrl+Shift+8')}
        {btn('numbers', 'Numbered list', toggleList(schema.nodes.ordered_list), !!state && inside(state, schema.nodes.ordered_list) != null, 'Ctrl+Shift+7')}
        {btn('quote', 'Quote', toggleQuote, !!state && inside(state, schema.nodes.blockquote) != null)}
        {btn('codeblock', 'Code block', codeBlock, false, 'Ctrl+Shift+E')}
        {btn('table', 'Table', insertTable())}
        {btn('rule', 'Horizontal line', insertRule)}
        {inTable && (
          <>
            <span className="tool-sep" />
            <button type="button" className="tool text" onMouseDown={(e) => e.preventDefault()} onClick={run(addRowAfter)}>
              + Row
            </button>
            <button type="button" className="tool text" onMouseDown={(e) => e.preventDefault()} onClick={run(addColumnAfter)}>
              + Column
            </button>
            <button type="button" className="tool text" onMouseDown={(e) => e.preventDefault()} onClick={run(deleteRow)}>
              − Row
            </button>
            <button type="button" className="tool text" onMouseDown={(e) => e.preventDefault()} onClick={run(deleteColumn)}>
              − Column
            </button>
            <button type="button" className="tool text" onMouseDown={(e) => e.preventDefault()} onClick={run(deleteTable)}>
              Delete table
            </button>
          </>
        )}
        <span className="tool-spacer" />
        {btn('undo', 'Undo', undo, false, 'Ctrl+Z')}
        {btn('redo', 'Redo', redo, false, 'Ctrl+Shift+Z')}
      </div>
      <div
        className="editor-host"
        ref={host}
        onMouseOver={(e) => {
          const el = (e.target as HTMLElement).closest?.('[data-ref]');
          if (!el || !describeRef) return setHover(null);
          const id = el.getAttribute('data-ref')!;
          if (hover?.id === id) return;
          const card = describeRef(id);
          const r = el.getBoundingClientRect();
          setHover(card ? { id, card, x: r.left, y: r.bottom } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && state) {
            e.preventDefault();
            setLinkDialog({ href: currentLink(state)?.href ?? '' });
          }
        }}
      />
      {hover && (
        <div className="ref-card" style={{ left: Math.min(hover.x, window.innerWidth - 340), top: hover.y + 6 }} role="tooltip">
          <div className="ref-card-head">
            <span className="kind-label">{hover.card.kind}</span>
            <span className="item-id">{hover.id}</span>
            {hover.card.status && <span className="pill">{hover.card.status}</span>}
          </div>
          <div className="ref-card-title">{hover.card.title || <em className="muted">Untitled</em>}</div>
          {hover.card.warn && <div className="small warn-text">{hover.card.warn}</div>}
          {hover.card.lines.map((l, i) => (
            <div key={i} className="small muted">
              {l}
            </div>
          ))}
          <div className="small muted ref-card-hint">Ctrl+click to open</div>
        </div>
      )}
      {suggest && (
        <ul className="id-suggest" style={{ left: Math.min(suggest.x, window.innerWidth - 380), top: suggest.y + 4 }} role="listbox" aria-label="Item IDs">
          {suggest.items.map((x, i) => (
            <li
              key={x.id}
              role="option"
              aria-selected={i === suggest.at}
              className={i === suggest.at ? 'on' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                if (view) accept(view, x.id);
              }}
            >
              <span className="item-id">{x.id}</span> <span className="id-suggest-title">{x.title}</span>
            </li>
          ))}
          <li className="id-suggest-hint muted small" aria-hidden="true">
            ↑↓ to choose · Enter or Tab to insert · Esc to close
          </li>
        </ul>
      )}
      {linkDialog && (
        <LinkDialog
          href={linkDialog.href}
          onClose={() => {
            setLinkDialog(null);
            view?.focus();
          }}
          onSave={(href) => {
            setLinkDialog(null);
            run(setLink(href))();
          }}
        />
      )}
    </div>
  );
}

function LinkDialog({ href, onSave, onClose }: { href: string; onSave: (href: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(href);
  return (
    <Dialog title={href ? 'Edit link' : 'Add link'} onClose={onClose}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(value.trim());
        }}
      >
        <label className="field">
          <span>Address</span>
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://…" />
        </label>
        <div className="dialog-actions">
          {href && (
            <button type="button" className="button" onClick={() => onSave('')}>
              Remove link
            </button>
          )}
          <span className="tool-spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
