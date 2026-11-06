// Editing commands used by the toolbar and keyboard shortcuts.
import type { NodeType, MarkType } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';
import { lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { liftListItem, wrapInList } from 'prosemirror-schema-list';
import { schema } from '../../../core/markdown/schema';

const { nodes, marks } = schema;

export const toggleStrong = toggleMark(marks.strong);
export const toggleEm = toggleMark(marks.em);
export const toggleStrike = toggleMark(marks.strike);
export const toggleCode = toggleMark(marks.code);
export const paragraph = setBlockType(nodes.paragraph);
export const heading = (level: number) => setBlockType(nodes.heading, { level });
export const codeBlock = setBlockType(nodes.code_block);

export function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

// The innermost block's type and attributes, for the block-style menu.
export function blockStyle(state: EditorState): string {
  const parent = state.selection.$from.parent;
  if (parent.type === nodes.heading) return `h${parent.attrs.level}`;
  if (parent.type === nodes.code_block) return 'code';
  return 'p';
}

export function inside(state: EditorState, type: NodeType): number | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === type) return d;
  return null;
}

export function toggleList(type: NodeType): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const n = $from.node(d);
      if (n.type === type) return liftListItem(nodes.list_item)(state, dispatch);
      if (n.type === nodes.bullet_list || n.type === nodes.ordered_list) {
        dispatch?.(state.tr.setNodeMarkup($from.before(d), type, { tight: n.attrs.tight }));
        return true;
      }
    }
    return wrapInList(type)(state, dispatch);
  };
}

export const toggleQuote: Command = (state, dispatch) => (inside(state, nodes.blockquote) != null ? lift(state, dispatch) : wrapIn(nodes.blockquote)(state, dispatch));

export const insertRule: Command = (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(nodes.horizontal_rule.create()).scrollIntoView());
  return true;
};

export function insertTable(rows = 3, cols = 3): Command {
  return (state, dispatch) => {
    const cell = (header: boolean) => (header ? nodes.table_header : nodes.table_cell).create();
    const row = (header: boolean) => nodes.table_row.create(null, Array.from({ length: cols }, () => cell(header)));
    const table = nodes.table.create(null, [row(true), ...Array.from({ length: rows - 1 }, () => row(false))]);
    dispatch?.(state.tr.replaceSelectionWith(table).scrollIntoView());
    return true;
  };
}

export function currentLink(state: EditorState): { href: string; from: number; to: number } | null {
  const { $from } = state.selection;
  const mark = marks.link.isInSet($from.marks()) ?? ($from.nodeAfter ? marks.link.isInSet($from.nodeAfter.marks) : null);
  if (!mark) return null;
  // The run of text around the cursor that carries this link.
  const parent = $from.parent;
  let pos = $from.start();
  let from = -1;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const end = pos + child.nodeSize;
    if (mark.isInSet(child.marks)) {
      if (from < 0) from = pos;
      if (end >= $from.pos && from <= $from.pos) {
        let to = end;
        for (let j = i + 1; j < parent.childCount && mark.isInSet(parent.child(j).marks); j++) to += parent.child(j).nodeSize;
        return { href: mark.attrs.href, from, to };
      }
    } else from = -1;
    pos = end;
  }
  return null;
}

export function setLink(href: string, text?: string): Command {
  return (state, dispatch) => {
    const existing = currentLink(state);
    let { from, to } = state.selection;
    if (existing && from === to) ({ from, to } = existing);
    const tr = state.tr;
    if (!href) {
      tr.removeMark(from, to, marks.link);
    } else if (from === to) {
      const label = text || href;
      tr.insertText(label, from);
      tr.addMark(from, from + label.length, marks.link.create({ href }));
    } else {
      tr.removeMark(from, to, marks.link).addMark(from, to, marks.link.create({ href }));
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}
