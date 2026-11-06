// Markdown ↔ ProseMirror, keeping what wasn't edited exactly as written.
//
// Each top-level block of a parsed document is remembered with its source text. On
// save, a block that is still the same node object (ProseMirror reuses unchanged
// nodes across edits) is written back verbatim; only new or edited blocks are
// serialized. So editing one paragraph changes only that paragraph in the diff.
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { MarkdownParser, MarkdownSerializer, defaultMarkdownSerializer, type MarkdownSerializerState } from 'prosemirror-markdown';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';

export const md = MarkdownIt('commonmark', { html: true }).enable(['table', 'strikethrough']);

function listIsTight(tokens: Token[], i: number): boolean {
  while (++i < tokens.length) if (tokens[i].type !== 'list_item_open') return tokens[i].hidden;
  return false;
}

function cellAlign(tok: Token): { align: string | null } {
  const m = /text-align:\s*(left|center|right)/.exec(tok.attrGet('style') ?? '');
  return { align: m ? m[1] : null };
}

export const parser = new MarkdownParser(schema, md, {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph' },
  list_item: { block: 'list_item' },
  bullet_list: { block: 'bullet_list', getAttrs: (tok, tokens, i) => ({ tight: listIsTight(tokens, i), bullet: tok.markup || '-' }) },
  ordered_list: { block: 'ordered_list', getAttrs: (tok, tokens, i) => ({ order: Number(tok.attrGet('start') ?? 1) || 1, tight: listIsTight(tokens, i) }) },
  heading: { block: 'heading', getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)) }) },
  code_block: { block: 'code_block', noCloseToken: true },
  fence: { block: 'code_block', getAttrs: (tok) => ({ params: tok.info || '' }), noCloseToken: true },
  html_block: { block: 'html_block', noCloseToken: true },
  hr: { node: 'horizontal_rule' },
  image: { node: 'image', getAttrs: (tok) => ({ src: tok.attrGet('src'), title: tok.attrGet('title') || null, alt: tok.children?.[0]?.content || null }) },
  hardbreak: { node: 'hard_break' },
  softbreak: { node: 'soft_break' },
  html_inline: { node: 'html_inline', getAttrs: (tok) => ({ html: tok.content }) },
  table: { block: 'table' },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: 'table_row' },
  th: { block: 'table_header', getAttrs: cellAlign },
  td: { block: 'table_cell', getAttrs: cellAlign },
  em: { mark: 'em' },
  strong: { mark: 'strong' },
  s: { mark: 'strike' },
  link: { mark: 'link', getAttrs: (tok) => ({ href: tok.attrGet('href'), title: tok.attrGet('title') || null }) },
  code_inline: { mark: 'code', noCloseToken: true },
});

function cellMarkdown(cell: PMNode): string {
  const para = schema.node('doc', null, [schema.node('paragraph', null, cell.content)]);
  return serializer
    .serialize(para)
    .trim()
    .replace(/\n+/g, ' ')
    .replace(/(^|[^\\])\|/g, '$1\\|');
}

function table(state: MarkdownSerializerState, node: PMNode) {
  const rows: string[][] = [];
  const aligns: (string | null)[] = [];
  node.forEach((row, _o, r) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      cells.push(cellMarkdown(cell));
      if (r === 0) aligns.push(cell.attrs.align);
    });
    rows.push(cells);
  });
  const width = Math.max(1, ...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const delim = Array.from({ length: width }, (_, i) => {
    const a = aligns[i];
    return a === 'left' ? ':---' : a === 'center' ? ':---:' : a === 'right' ? '---:' : '---';
  });
  state.write(line(rows[0] ?? []));
  state.ensureNewLine();
  state.write(`| ${delim.join(' | ')} |`);
  for (const row of rows.slice(1)) {
    state.ensureNewLine();
    state.write(line(row));
  }
  state.closeBlock(node);
}

export const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    html_block(state, node) {
      state.text(node.textContent, false);
      state.closeBlock(node);
    },
    soft_break(state, _node, parent, index) {
      // Only between text: one at the end of a paragraph would add a blank line.
      for (let i = index + 1; i < parent.childCount; i++)
        if (parent.child(i).type.name !== 'soft_break') {
          state.write('\n');
          return;
        }
    },
    html_inline(state, node) {
      state.write(node.attrs.html);
    },
    table,
    table_row() {},
    table_cell() {},
    table_header() {},
  },
  {
    ...defaultMarkdownSerializer.marks,
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  },
);

export interface ParsedBody {
  doc: PMNode;
  lead: string; // blank lines before the first block
  // Original top-level nodes → their source (up to the next block) and position.
  blocks: Map<PMNode, { src: string; index: number }>;
}

export function parseBody(text: string): ParsedBody {
  const doc = parser.parse(text);
  const blocks = new Map<PMNode, { src: string; index: number }>();
  const starts = md
    .parse(text, {})
    .filter((t) => t.level === 0 && t.nesting !== -1 && t.block && t.map)
    .map((t) => t.map![0]);
  if (!starts.length || starts.length !== doc.childCount) return { doc, lead: '', blocks };
  const lineStart = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStart.push(i + 1);
  const at = (line: number) => (line < lineStart.length ? lineStart[line] : text.length);
  for (let i = 0; i < starts.length; i++) {
    const from = at(starts[i]);
    const to = i + 1 < starts.length ? at(starts[i + 1]) : text.length;
    blocks.set(doc.child(i), { src: text.slice(from, to), index: i });
  }
  return { doc, lead: text.slice(0, at(starts[0])), blocks };
}

export function serializeNode(node: PMNode): string {
  return serializer.serialize(schema.node('doc', null, [node]), { tightLists: true }).replace(/\n*$/, '\n');
}

export function serializeBody(doc: PMNode, parsed: ParsedBody | null): string {
  // An empty document (one empty paragraph) is an empty body.
  if (doc.childCount === 1 && doc.firstChild!.type.name === 'paragraph' && doc.firstChild!.content.size === 0) {
    const orig = parsed?.blocks.get(doc.firstChild!);
    return orig ? parsed!.lead + orig.src : '';
  }
  let out = parsed?.lead ?? '';
  let prevIndex = -2;
  let first = true;
  doc.forEach((child) => {
    const orig = parsed?.blocks.get(child);
    // Markdown has no empty paragraphs: leave out the ones left behind by editing.
    if (!orig && child.type.name === 'paragraph' && child.content.size === 0) return;
    const piece = orig ? orig.src : serializeNode(child);
    // Blocks next to each other in the original keep their own spacing; anything else
    // is separated by a blank line.
    if (!first && !(orig && orig.index === prevIndex + 1)) out = out.replace(/\n*$/, '\n\n');
    first = false;
    out += piece;
    prevIndex = orig ? orig.index : -2;
  });
  return out.endsWith('\n') || out === '' ? out : out + '\n';
}
