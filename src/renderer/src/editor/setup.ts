// Editor state: keymaps, input rules (type Markdown, get formatting), tables, and
// item references (REQ-07) that open with Ctrl+click.
import { EditorState, Plugin, PluginKey, type Command } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { history, undo, redo } from 'prosemirror-history';
import { baseKeymap, chainCommands, exitCode } from 'prosemirror-commands';
import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule, undoInputRule } from 'prosemirror-inputrules';
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { columnResizing, goToNextCell, tableEditing } from 'prosemirror-tables';
import type { MarkType, Node as PMNode } from 'prosemirror-model';
import { schema } from '../../../core/markdown/schema';
import { codeBlock, heading, paragraph, toggleCode, toggleEm, toggleList, toggleStrike, toggleStrong } from './commands';
import { gitMarksPlugin } from './gitmarks';

const { nodes, marks } = schema;

const hardBreak: Command = (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView());
  return true;
};

function markRule(pattern: RegExp, type: MarkType): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const lead = match[0].length - match[0].trimStart().length;
    return state.tr.replaceWith(start + lead, end, schema.text(match[1], [type.create()])).removeStoredMark(type);
  });
}

const rules = inputRules({
  rules: [
    textblockTypeInputRule(/^(#{1,4})\s$/, nodes.heading, (m) => ({ level: m[1].length })),
    wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list, (m) => ({ bullet: m[1] })),
    wrappingInputRule(/^(\d+)\.\s$/, nodes.ordered_list, (m) => ({ order: +m[1] }), (m, node) => node.childCount + node.attrs.order === +m[1]),
    wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
    textblockTypeInputRule(/^```([\w-]*)\s$/, nodes.code_block, (m) => ({ params: m[1] })),
    markRule(/(?:^|\s)\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, marks.strong),
    markRule(/(?:^|[\s(])\*([^*\s](?:[^*]*[^*\s])?)\*$/, marks.em),
    markRule(/(?:^|[\s(])_([^_\s](?:[^_]*[^_\s])?)_$/, marks.em),
    markRule(/(?:^|[\s(])~~([^~\s](?:[^~]*[^~\s])?)~~$/, marks.strike),
    markRule(/(?:^|[\s(])`([^`]+)`$/, marks.code),
  ],
});

const keys = keymap({
  'Mod-z': undo,
  'Shift-Mod-z': redo,
  'Mod-y': redo,
  Backspace: undoInputRule,
  'Mod-b': toggleStrong,
  'Mod-i': toggleEm,
  'Mod-e': toggleCode,
  'Mod-Shift-x': toggleStrike,
  Enter: splitListItem(nodes.list_item),
  Tab: chainCommands(goToNextCell(1), sinkListItem(nodes.list_item)),
  'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(nodes.list_item)),
  'Shift-Enter': chainCommands(exitCode, hardBreak),
  'Mod-Enter': exitCode,
  'Mod-Alt-0': paragraph,
  'Mod-Alt-1': heading(1),
  'Mod-Alt-2': heading(2),
  'Mod-Alt-3': heading(3),
  'Mod-Shift-8': toggleList(nodes.bullet_list),
  'Mod-Shift-7': toggleList(nodes.ordered_list),
  'Mod-Shift-e': codeBlock,
});

const placeholder = new Plugin({
  props: {
    decorations(state) {
      const { doc } = state;
      if (doc.childCount !== 1 || !doc.firstChild!.isTextblock || doc.firstChild!.content.size) return null;
      return DecorationSet.create(doc, [Decoration.node(0, doc.firstChild!.nodeSize, { class: 'empty', 'data-placeholder': 'Describe it here…' })]);
    },
  },
});

// Chromium reports selection changes asynchronously, so a key pressed right after a
// click can reach the keymap before ProseMirror has seen the new cursor position, and
// Enter would split the block at the old one. Read the DOM selection first. (From
// Wysette; `domObserver` is internal to prosemirror-view, and this is what its own
// forceFlush does once a selectionchange event has arrived.)
const syncSelectionOnKey = new Plugin({
  props: {
    handleKeyDown(view) {
      (view as unknown as { domObserver?: { flush?: () => void } }).domObserver?.flush?.();
      return false;
    },
  },
});

// ---- item references ------------------------------------------------------------

export interface RefTarget {
  title: string;
}
export const refsKey = new PluginKey<Map<string, RefTarget>>('refs');
// REQ-07, and Sphinx-Needs' REQ_007: only IDs that are items are marked.
const REF = /\b[A-Z][A-Z0-9_-]*\d\b/g;

function refDecorations(doc: PMNode, refs: Map<string, RefTarget>): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || node.marks.some((m) => m.type === marks.code || m.type === marks.link)) return;
    for (const m of node.text!.matchAll(REF)) {
      const t = refs.get(m[0]);
      if (t) decos.push(Decoration.inline(pos + m.index!, pos + m.index! + m[0].length, { class: 'item-ref', 'data-ref': m[0] }));
    }
  });
  return DecorationSet.create(doc, decos);
}

export function refsPlugin(onOpen: (id: string) => void) {
  return new Plugin<{ refs: Map<string, RefTarget>; decos: DecorationSet }>({
    key: refsKey as never,
    state: {
      init: (_, state) => ({ refs: new Map(), decos: DecorationSet.create(state.doc, []) }),
      apply(tr, value, _old, state) {
        const refs = tr.getMeta(refsKey) as Map<string, RefTarget> | undefined;
        if (refs) return { refs, decos: refDecorations(state.doc, refs) };
        if (tr.docChanged) return { refs: value.refs, decos: refDecorations(state.doc, value.refs) };
        return value;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decos;
      },
      handleClick(_view, _pos, event) {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const el = (event.target as HTMLElement).closest?.('[data-ref]');
        if (el) {
          onOpen(el.getAttribute('data-ref')!);
          return true;
        }
        const a = (event.target as HTMLElement).closest?.('a[href]');
        if (a && /^https?:/.test(a.getAttribute('href')!)) {
          window.open(a.getAttribute('href')!, '_blank', 'noopener');
          return true;
        }
        return false;
      },
    },
  });
}

export function createEditorState(doc: PMNode, onOpenRef: (id: string) => void): EditorState {
  return EditorState.create({
    doc,
    plugins: [
      syncSelectionOnKey,
      columnResizing(),
      tableEditing(),
      rules,
      keys,
      keymap(baseKeymap),
      history(),
      dropCursor(),
      gapCursor(),
      placeholder,
      refsPlugin(onOpenRef),
      gitMarksPlugin(),
    ],
  });
}
