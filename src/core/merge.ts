// Merging two people's changes to the same file (yours and the server's, from a common
// starting point), the way Tracey understands the file:
//
//   requirement / test case   field by field; the text block by block; lists (verifies,
//                             components, jira) as sets, so additions on both sides merge
//   test run                  case by case, field by field
//   anything else             the whole file: yours or the server's
//
// What only one side changed is taken automatically. What both changed differently is a
// conflict, for a person to choose.
import { parseDocument } from 'yaml';
import { decodeText, encodeText, joinFrontMatter, readFrontMatter, setFields, splitFrontMatter } from './frontmatter';
import { parseBody, serializeNode } from './markdown/markdown';
import { blockKey, diffSeq, fieldLabel, showValue } from './diff';
import { patchRun } from './runs';

export type Choice = 'ours' | 'theirs' | 'both';

export type Conflict =
  | { kind: 'field'; label: string; base: string; ours: string; theirs: string }
  | { kind: 'text'; base: string[]; ours: string[]; theirs: string[] } // blocks (Markdown)
  | { kind: 'case'; id: string; base: string; ours: string; theirs: string }
  | { kind: 'file'; base: string | null; ours: string | null; theirs: string | null };

export interface MergePlan {
  kind: 'item' | 'run' | 'file';
  auto: string[]; // what was taken from the server without asking
  conflicts: Conflict[];
  build(choices: Choice[]): string | null; // a choice per conflict; null: delete the file
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

// One value, three versions. Lists of names merge as sets; maps key by key.
export function merge3(b: unknown, o: unknown, t: unknown): { value: unknown; conflict: boolean; theirs: boolean } {
  if (same(o, t)) return { value: o, conflict: false, theirs: false };
  if (same(b, o)) return { value: t, conflict: false, theirs: true };
  if (same(b, t)) return { value: o, conflict: false, theirs: false };
  const base = b ?? (strings(o) || strings(t) ? [] : undefined);
  if (strings(base) && (o == null || strings(o)) && (t == null || strings(t))) {
    const ol = (o ?? []) as string[];
    const tl = (t ?? []) as string[];
    const value = [...ol.filter((x) => tl.includes(x) || !base.includes(x)), ...tl.filter((x) => !base.includes(x) && !ol.includes(x))];
    return { value, conflict: false, theirs: true };
  }
  if ((b == null || isObj(b)) && isObj(o) && isObj(t)) {
    const bb = (b ?? {}) as Record<string, unknown>;
    const value: Record<string, unknown> = {};
    let conflict = false;
    for (const k of [...new Set([...Object.keys(o), ...Object.keys(t)])]) {
      const r = merge3(bb[k], o[k], t[k]);
      conflict ||= r.conflict;
      if (r.value !== undefined) value[k] = r.value;
    }
    return { value, conflict, theirs: true };
  }
  return { value: o, conflict: true, theirs: false };
}

// ---- Requirements and test cases ------------------------------------------------------

interface Block {
  key: string;
  src: string;
}

function blocksOf(body: string): Block[] {
  const parsed = parseBody(body);
  const out: Block[] = [];
  parsed.doc.forEach((node) => {
    const key = blockKey(node);
    if (key) out.push({ key, src: parsed.blocks.get(node)?.src ?? serializeNode(node) });
  });
  return out;
}

const joinBlocks = (srcs: string[]) => {
  const parts = srcs.map((s) => s.replace(/\s+$/, '')).filter(Boolean);
  return parts.length ? `${parts.join('\n\n')}\n` : '';
};

type Segment = { take: Block[] } | { conflict: number };

// Three-way, block by block: stretches between blocks all three share.
function diff3(base: Block[], ours: Block[], theirs: Block[], onConflict: (c: { base: Block[]; ours: Block[]; theirs: Block[] }) => number) {
  const keys = (x: Block[]) => x.map((b) => b.key);
  const mo = new Map<number, number>();
  const mt = new Map<number, number>();
  for (const op of diffSeq(keys(base), keys(ours))) if (op.kind === 'same') mo.set(op.a, op.b);
  for (const op of diffSeq(keys(base), keys(theirs))) if (op.kind === 'same') mt.set(op.a, op.b);
  const segments: Segment[] = [];
  let fromTheirs = 0;
  let i = 0;
  let jo = 0;
  let jt = 0;
  const eq = (x: Block[], y: Block[]) => x.length === y.length && x.every((v, n) => v.key === y[n].key);
  const chunk = (bEnd: number, oEnd: number, tEnd: number) => {
    const b = base.slice(i, bEnd);
    const o = ours.slice(jo, oEnd);
    const t = theirs.slice(jt, tEnd);
    if (!b.length && !o.length && !t.length) return;
    // Neighbouring blocks changed on both sides: block by block when they line up.
    if (b.length > 1 && b.length === o.length && b.length === t.length && !eq(o, t) && !eq(b, o) && !eq(b, t)) {
      for (let n = 0; n < b.length; n++) {
        const [bn, on, tn] = [b[n], o[n], t[n]];
        if (on.key === tn.key || bn.key === tn.key) segments.push({ take: [on] });
        else if (bn.key === on.key) {
          segments.push({ take: [tn] });
          fromTheirs++;
        } else segments.push({ conflict: onConflict({ base: [bn], ours: [on], theirs: [tn] }) });
      }
      return;
    }
    if (eq(o, t) || eq(b, t)) segments.push({ take: o });
    else if (eq(b, o)) {
      segments.push({ take: t });
      fromTheirs++;
    } else segments.push({ conflict: onConflict({ base: b, ours: o, theirs: t }) });
  };
  for (let a = 0; a < base.length; a++) {
    const o = mo.get(a);
    const t = mt.get(a);
    if (o === undefined || t === undefined || o < jo || t < jt) continue;
    chunk(a, o, t);
    segments.push({ take: [ours[o]] });
    i = a + 1;
    jo = o + 1;
    jt = t + 1;
  }
  chunk(base.length, ours.length, theirs.length);
  return { segments, fromTheirs };
}

export function mergeItem(base: string, ours: string, theirs: string): MergePlan {
  const crlf = decodeText(ours).crlf;
  const split = (raw: string) => {
    const { front, body } = splitFrontMatter(decodeText(raw).text);
    return { front, body, data: readFrontMatter(front).data };
  };
  const B = split(base);
  const O = split(ours);
  const T = split(theirs);
  const conflicts: Conflict[] = [];
  const auto: string[] = [];

  // Fields.
  const fieldChanges: Record<string, unknown> = {};
  const fieldConflicts: { key: string; index: number }[] = [];
  for (const key of [...new Set([...Object.keys(O.data), ...Object.keys(T.data), ...Object.keys(B.data)])]) {
    const r = merge3(B.data[key], O.data[key], T.data[key]);
    if (r.conflict && key === 'reviewed') {
      // Review fingerprints: keep yours where both changed.
      fieldChanges[key] = r.value;
    } else if (r.conflict) {
      fieldConflicts.push({ key, index: conflicts.length });
      conflicts.push({ kind: 'field', label: fieldLabel(key), base: showValue(B.data[key]), ours: showValue(O.data[key]), theirs: showValue(T.data[key]) });
    } else if (!same(r.value, O.data[key])) {
      fieldChanges[key] = r.value;
      if (key !== 'reviewed') auto.push(fieldLabel(key));
    }
  }

  // Text.
  const blockSets = new Map<number, { ours: Block[]; theirs: Block[] }>(); // conflict → its blocks
  const { segments, fromTheirs } = diff3(blocksOf(B.body), blocksOf(O.body), blocksOf(T.body), (c) => {
    conflicts.push({ kind: 'text', base: c.base.map((b) => b.key), ours: c.ours.map((b) => b.key), theirs: c.theirs.map((b) => b.key) });
    blockSets.set(conflicts.length - 1, { ours: c.ours, theirs: c.theirs });
    return conflicts.length - 1;
  });
  const textConflicts = blockSets.size;
  if (fromTheirs) auto.push(`${fromTheirs} text change${fromTheirs === 1 ? '' : 's'}`);

  return {
    kind: 'item',
    auto,
    conflicts,
    build(choices) {
      const changes = { ...fieldChanges };
      for (const { key, index } of fieldConflicts) changes[key] = choices[index] === 'theirs' ? (T.data[key] ?? undefined) : O.data[key];
      const front = Object.keys(changes).length ? setFields(O.front, changes) : O.front;
      const body =
        !fromTheirs && !textConflicts
          ? O.body
          : joinBlocks(
              segments.flatMap((s) => {
                if ('take' in s) return s.take.map((b) => b.src);
                const set = blockSets.get(s.conflict)!;
                const c = choices[s.conflict];
                if (c === 'theirs') return set.theirs.map((b) => b.src);
                if (c === 'both') return [...set.ours, ...set.theirs.filter((t) => !set.ours.some((o) => o.key === t.key))].map((b) => b.src);
                return set.ours.map((b) => b.src);
              }),
            );
      return encodeText(joinFrontMatter(front, body), crlf);
    },
  };
}

// ---- Test runs ------------------------------------------------------------------------

const caseSummary = (c: unknown): string => {
  if (!isObj(c)) return '(not in the run)';
  const who = [c.tester, c.date].filter(Boolean).join(', ');
  return `${showValue(c.result) || 'not-run'}${who ? ` (${who})` : ''}${c.note ? `: ${showValue(c.note)}` : ''}`;
};

export function mergeRun(base: string, ours: string, theirs: string): MergePlan {
  const read = (t: string) => {
    const d = parseDocument(t);
    if (d.errors.length) return null;
    const o = d.toJS();
    return isObj(o) ? o : {};
  };
  const B = read(base);
  const O = read(ours);
  const T = read(theirs);
  if (!B || !O || !T) return mergeFile(base, ours, theirs);
  const conflicts: Conflict[] = [];
  const auto: string[] = [];
  const top: Record<string, unknown> = {};
  const topConflicts: { key: string; index: number }[] = [];
  for (const key of [...new Set([...Object.keys(O), ...Object.keys(T)])]) {
    if (key === 'cases') continue;
    const r = merge3(B[key], O[key], T[key]);
    if (r.conflict) {
      topConflicts.push({ key, index: conflicts.length });
      conflicts.push({ kind: 'field', label: key, base: showValue(B[key]), ours: showValue(O[key]), theirs: showValue(T[key]) });
    } else if (!same(r.value, O[key])) {
      top[key] = r.value;
      auto.push(key);
    }
  }
  const bc = isObj(B.cases) ? B.cases : {};
  const oc = isObj(O.cases) ? O.cases : {};
  const tc = isObj(T.cases) ? T.cases : {};
  const cases: Record<string, Record<string, unknown> | null> = {};
  const caseConflicts: { id: string; index: number }[] = [];
  let fromTheirs = 0;
  for (const id of [...new Set([...Object.keys(oc), ...Object.keys(tc), ...Object.keys(bc)])]) {
    const r = merge3(bc[id], oc[id], tc[id]);
    if (r.conflict) {
      caseConflicts.push({ id, index: conflicts.length });
      conflicts.push({ kind: 'case', id, base: caseSummary(bc[id]), ours: caseSummary(oc[id]), theirs: caseSummary(tc[id]) });
    } else if (!same(r.value, oc[id])) {
      cases[id] = isObj(r.value) ? r.value : null;
      fromTheirs++;
    }
  }
  if (fromTheirs) auto.unshift(`${fromTheirs} test case${fromTheirs === 1 ? '' : 's'}`);
  return {
    kind: 'run',
    auto,
    conflicts,
    build(choices) {
      const t = { ...top };
      for (const { key, index } of topConflicts) if (choices[index] === 'theirs') t[key] = T[key] ?? null;
      const c = { ...cases };
      for (const { id, index } of caseConflicts) if (choices[index] === 'theirs') c[id] = isObj(tc[id]) ? tc[id] : null;
      return Object.keys(t).length || Object.keys(c).length ? patchRun(ours, t, c) : ours;
    },
  };
}

// ---- Anything else ----------------------------------------------------------------------

export function mergeFile(base: string | null, ours: string | null, theirs: string | null): MergePlan {
  return {
    kind: 'file',
    auto: [],
    conflicts: [{ kind: 'file', base, ours, theirs }],
    build: (choices) => (choices[0] === 'theirs' ? theirs : ours),
  };
}

// The way to merge a file, from its name and contents.
export function planMerge(path: string, runsDir: string, base: string | null, ours: string | null, theirs: string | null): MergePlan {
  if (ours == null || theirs == null) return mergeFile(base, ours, theirs);
  const b = base ?? '';
  if (/\.md$/i.test(path) && readFrontMatter(splitFrontMatter(decodeText(ours).text).front).data.id && readFrontMatter(splitFrontMatter(decodeText(theirs).text).front).data.id)
    return mergeItem(b, ours, theirs);
  if (runsDir && path.startsWith(`${runsDir}/`) && /\.ya?ml$/i.test(path)) return mergeRun(b, ours, theirs);
  return mergeFile(base, ours, theirs);
}
