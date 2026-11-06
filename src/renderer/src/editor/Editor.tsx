// A ProseMirror view for one item's text, with its toolbar.
import { useEffect, useRef, useState } from 'react';
import { EditorView } from 'prosemirror-view';
import { Slice, type Node as PMNode } from 'prosemirror-model';
import { undo, redo } from 'prosemirror-history';
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, deleteTable } from 'prosemirror-tables';
import type { Command } from 'prosemirror-state';
import { schema } from '../../../core/markdown/schema';
import { parser } from '../../../core/markdown/markdown';
import { createEditorState, refsKey, type RefTarget } from './setup';
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
}

export function Editor({ doc, onChange, refs, onOpenRef, resolveImage }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [, setTick] = useState(0);
  const [linkDialog, setLinkDialog] = useState<{ href: string } | null>(null);
  const latest = useRef({ onChange, onOpenRef, resolveImage });
  latest.current = { onChange, onOpenRef, resolveImage };

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
        setTick((t) => t + 1);
      },
    });
    viewRef.current = view;
    view.dispatch(view.state.tr.setMeta(refsKey, refs).setMeta('addToHistory', false));
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
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && state) {
            e.preventDefault();
            setLinkDialog({ href: currentLink(state)?.href ?? '' });
          }
        }}
      />
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
