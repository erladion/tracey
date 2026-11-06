// Git in the editor: marks on blocks changed since the last commit (and where blocks
// were removed), and who last changed each block (shown on hover).
//
// Blocks are matched by their Markdown, so the marks follow the text as it's edited.
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { blockChanges, blockKey, blockText, diffSeq } from '../../../core/diff';

export interface GitMarks {
  base: string[] | null; // the committed version's blocks (blockKey); null: no change marks
  blame: { blocks: string[]; labels: string[]; uncommitted: string } | null; // labels[i] for blocks[i]
}

export const NO_MARKS: GitMarks = { base: null, blame: null };

interface State {
  marks: GitMarks;
  deco: DecorationSet;
}

export const gitMarksKey = new PluginKey<State>('gitMarks');

const ellipsis = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function build(doc: PMNode, marks: GitMarks): DecorationSet {
  if (!marks.base && !marks.blame) return DecorationSet.empty;
  const nodes: { pos: number; node: PMNode; key: string }[] = [];
  doc.forEach((node, pos) => {
    const key = blockKey(node);
    if (key) nodes.push({ pos, node, key });
  });
  const keys = nodes.map((n) => n.key);
  const attrs = nodes.map(() => ({ class: '', blame: '' }));
  const decos: Decoration[] = [];

  if (marks.base) {
    let after = -1; // the last current block seen
    let removed: number[] = [];
    const flushRemoved = () => {
      if (!removed.length) return;
      const pos = after >= 0 ? nodes[after].pos + nodes[after].node.nodeSize : 0;
      const texts = removed.map((i) => ellipsis(blockText(marks.base![i]).replace(/\s+/g, ' '), 140));
      const n = removed.length;
      decos.push(
        Decoration.widget(
          pos,
          () => {
            const el = document.createElement('div');
            el.className = 'chg-removed';
            el.contentEditable = 'false';
            el.textContent = `${n} block${n === 1 ? '' : 's'} removed since the last commit`;
            el.title = `Removed:\n${texts.join('\n')}`;
            return el;
          },
          { side: -1, key: `rm:${pos}:${texts.join('|')}`, ignoreSelection: true },
        ),
      );
      removed = [];
    };
    for (const op of blockChanges(marks.base, keys)) {
      if (op.kind === 'removed') {
        removed.push(op.a);
        continue;
      }
      flushRemoved();
      after = op.b;
      if (op.kind !== 'same') attrs[op.b].class = op.kind === 'added' ? 'chg chg-added' : 'chg chg-changed';
    }
    flushRemoved();
  }

  if (marks.blame) {
    const { blocks, labels, uncommitted } = marks.blame;
    for (let i = 0; i < nodes.length; i++) attrs[i].blame = uncommitted;
    for (const op of diffSeq(blocks, keys)) if (op.kind === 'same') attrs[op.b].blame = labels[op.a];
  }

  nodes.forEach((n, i) => {
    const a = attrs[i];
    const spec: Record<string, string> = {};
    if (a.class) spec.class = a.class;
    if (a.blame) spec['data-blame'] = a.blame;
    if (Object.keys(spec).length) decos.push(Decoration.node(n.pos, n.pos + n.node.nodeSize, spec));
  });
  return DecorationSet.create(doc, decos);
}

export const gitMarksPlugin = () =>
  new Plugin<State>({
    key: gitMarksKey,
    state: {
      init: () => ({ marks: NO_MARKS, deco: DecorationSet.empty }),
      apply(tr, value, _old, state) {
        const marks = tr.getMeta(gitMarksKey) as GitMarks | undefined;
        if (marks) return { marks, deco: build(state.doc, marks) };
        if (tr.docChanged && (value.marks.base || value.marks.blame)) return { marks: value.marks, deco: build(state.doc, value.marks) };
        return value;
      },
    },
    props: {
      decorations: (state) => gitMarksKey.getState(state)?.deco,
    },
  });
