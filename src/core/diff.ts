// Comparing versions of a requirement or test case: its fields, and its text block by
// block (paragraphs, lists, tables…), with word-level changes inside a changed block.
// Used for change marks in the editor, comparing versions, and merging.
import type { Node as PMNode } from 'prosemirror-model';
import { blockStarts, parser, serializeNode } from './markdown/markdown';
import { decodeText, readFrontMatter, splitFrontMatter } from './frontmatter';

export type Op = { kind: 'same'; a: number; b: number } | { kind: 'del'; a: number } | { kind: 'add'; b: number };

// The shortest edit from a to b (longest common subsequence).
export function diffSeq<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): Op[] {
  const n = a.length;
  const m = b.length;
  let pre = 0;
  while (pre < n && pre < m && eq(a[pre], b[pre])) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && eq(a[n - 1 - suf], b[m - 1 - suf])) suf++;
  const A = n - pre - suf;
  const B = m - pre - suf;
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: 'same', a: i, b: i });
  if (A * B > 4_000_000) {
    // Too big to compare closely: all out, all in.
    for (let i = 0; i < A; i++) ops.push({ kind: 'del', a: pre + i });
    for (let j = 0; j < B; j++) ops.push({ kind: 'add', b: pre + j });
  } else {
    const W = B + 1;
    const dp = new Uint32Array((A + 1) * W);
    for (let i = A - 1; i >= 0; i--)
      for (let j = B - 1; j >= 0; j--) dp[i * W + j] = eq(a[pre + i], b[pre + j]) ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    let i = 0;
    let j = 0;
    while (i < A || j < B) {
      if (i < A && j < B && eq(a[pre + i], b[pre + j])) ops.push({ kind: 'same', a: pre + i++, b: pre + j++ });
      else if (i < A && (j === B || dp[(i + 1) * W + j] >= dp[i * W + j + 1])) ops.push({ kind: 'del', a: pre + i++ });
      else ops.push({ kind: 'add', b: pre + j++ });
    }
  }
  for (let k = suf; k > 0; k--) ops.push({ kind: 'same', a: n - k, b: m - k });
  return ops;
}

// ---- Words --------------------------------------------------------------------------

export interface WordPart {
  kind: 'same' | 'add' | 'del';
  text: string;
}

const tokens = (s: string) => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];

export function wordDiff(a: string, b: string): WordPart[] {
  const ta = tokens(a);
  const tb = tokens(b);
  const out: WordPart[] = [];
  const push = (kind: WordPart['kind'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  // Deletions before additions in each changed stretch, so it reads "old → new".
  let dels = '';
  let adds = '';
  const flush = () => {
    if (dels) push('del', dels);
    if (adds) push('add', adds);
    dels = adds = '';
  };
  for (const op of diffSeq(ta, tb)) {
    if (op.kind === 'same') {
      flush();
      push('same', ta[op.a]);
    } else if (op.kind === 'del') dels += ta[op.a];
    else adds += tb[op.b];
  }
  flush();
  return out;
}

// How much two texts have in common, 0..1 (by words).
export function similarity(a: string, b: string): number {
  const wa = a.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const wb = b.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!wa.length && !wb.length) return 1;
  const same = diffSeq(wa, wb).filter((o) => o.kind === 'same').length;
  return same / Math.max(wa.length, wb.length);
}

// ---- Blocks -------------------------------------------------------------------------

const keys = new WeakMap<PMNode, string>();
// A block's Markdown, written the same way whatever the source looked like ('' for an
// empty paragraph, which isn't saved).
export function blockKey(node: PMNode): string {
  let k = keys.get(node);
  if (k === undefined) {
    k = node.type.name === 'paragraph' && node.content.size === 0 ? '' : serializeNode(node).trim();
    keys.set(node, k);
  }
  return k;
}

export interface BodyBlock {
  key: string; // see blockKey
  from: number; // lines [from, to) in the body; -1 if not known
  to: number;
}

export function bodyBlocks(body: string): BodyBlock[] {
  const doc = parser.parse(body);
  const starts = blockStarts(body);
  const ok = starts.length === doc.childCount;
  const lines = body.split('\n').length;
  const out: BodyBlock[] = [];
  doc.forEach((node, _pos, i) => {
    const key = blockKey(node);
    if (key) out.push({ key, from: ok ? starts[i] : -1, to: ok ? (starts[i + 1] ?? lines) : -1 });
  });
  return out;
}

// A block's text without Markdown syntax, for word-level comparison.
export function blockText(key: string): string {
  const doc = parser.parse(key);
  return doc.textBetween(0, doc.content.size, '\n', ' ');
}

export type BlockChange =
  | { kind: 'same'; a: number; b: number }
  | { kind: 'changed'; a: number; b: number }
  | { kind: 'removed'; a: number }
  | { kind: 'added'; b: number };

// Block by block: a removed block and an added one in the same place that are alike
// count as one changed block.
export function blockChanges(a: string[], b: string[]): BlockChange[] {
  const out: BlockChange[] = [];
  let dels: number[] = [];
  let adds: number[] = [];
  const flush = () => {
    let k = 0;
    while (k < dels.length && k < adds.length && similarity(blockText(a[dels[k]]), blockText(b[adds[k]])) >= 0.3) {
      out.push({ kind: 'changed', a: dels[k], b: adds[k] });
      k++;
    }
    for (const i of dels.slice(k)) out.push({ kind: 'removed', a: i });
    for (const j of adds.slice(k)) out.push({ kind: 'added', b: j });
    dels = [];
    adds = [];
  };
  for (const op of diffSeq(a, b)) {
    if (op.kind === 'same') {
      flush();
      out.push(op);
    } else if (op.kind === 'del') dels.push(op.a);
    else adds.push(op.b);
  }
  flush();
  return out;
}

// ---- Files and fields -----------------------------------------------------------------

export interface ItemVersion {
  data: Record<string, unknown>; // front matter
  body: string;
  bodyLine: number; // the line the body starts on in the file
}

export function readVersion(raw: string): ItemVersion {
  const text = decodeText(raw).text;
  const { front, body } = splitFrontMatter(text);
  const head = text.slice(0, text.length - body.length);
  return { data: readFrontMatter(front).data, body, bodyLine: head.split('\n').length - 1 };
}

const FIELD_LABELS: Record<string, string> = { id: 'ID', title: 'Title', status: 'Status', components: 'Components', verifies: 'Verifies', jira: 'Jira' };
export const fieldLabel = (k: string) => FIELD_LABELS[k] ?? k;

export const showValue = (v: unknown): string =>
  v == null ? '' : Array.isArray(v) ? v.map(showValue).join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);

export interface FieldChange {
  field: string;
  label: string;
  old: string;
  new: string;
}

// Changed fields, in a fixed order (the review fingerprints aren't shown).
export function fieldChanges(a: Record<string, unknown>, b: Record<string, unknown>): FieldChange[] {
  const order = Object.keys(FIELD_LABELS);
  const all = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'reviewed').sort((x, y) => {
    const ix = order.indexOf(x);
    const iy = order.indexOf(y);
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy) || x.localeCompare(y);
  });
  return all.filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)).map((k) => ({ field: k, label: fieldLabel(k), old: showValue(a[k]), new: showValue(b[k]) }));
}

// What differs between two versions of an item, in words: ["text", "Status", …].
export function whatChanged(oldRaw: string, newRaw: string): string[] {
  const a = readVersion(oldRaw);
  const b = readVersion(newRaw);
  const out = fieldChanges(a.data, b.data).map((f) => f.label);
  const ka = bodyBlocks(a.body).map((x) => x.key);
  const kb = bodyBlocks(b.body).map((x) => x.key);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) out.unshift('text');
  return out;
}
