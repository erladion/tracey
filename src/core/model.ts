// Requirements and test cases, read from the repository's Markdown files, and the
// links between them. Pure: used by the app (live, as you type) and by `check` in CI.
//
// A file is an item when its front matter has an `id` whose prefix is a configured
// one (REQ-, TC-), or a `type: requirement | testcase`. IDs are never derived from
// file names, so files can be renamed or moved freely.
import { parseDuration } from './estimate';
import { fieldIssue } from './fields';
import { parseConfig, type Component, type Kind, type TraceConfig, statusesFor } from './config';
import { decodeText, readFrontMatter, splitFrontMatter } from './frontmatter';

export interface SourceFile {
  path: string; // relative to the repository root, with /
  text: string;
}

export interface Item {
  kind: Kind;
  id: string;
  title: string;
  status: string;
  components: string[];
  variants: string[]; // the variants it's limited to; empty: all of them
  jira: string[];
  verifies: string[]; // test cases: the requirements they verify
  refines: string[]; // requirements: the requirements they break down (their parents)
  verification: Method; // requirements: how it's verified (test cases unless said otherwise)
  evidence: string[]; // requirements verified other than by test: the documents or records showing it
  estimate: number | null; // test cases: minutes to run it (see estimate.ts); null: none or unreadable
  // Per linked requirement (verified by a test case, refined by a requirement), the
  // fingerprint of its text when the link was last reviewed. A different fingerprint
  // now makes the link suspect.
  reviewed: Record<string, string>;
  path: string;
  front: string | null;
  body: string;
  data: Record<string, unknown>;
}

export type Severity = 'error' | 'warning';

export interface Problem {
  severity: Severity;
  code:
    | 'config'
    | 'yaml'
    | 'no-id'
    | 'duplicate-id'
    | 'missing-title'
    | 'bad-status'
    | 'broken-link'
    | 'link-to-testcase'
    | 'unknown-component'
    | 'unknown-variant'
    | 'variant-mismatch'
    | 'bad-estimate'
    | 'bad-field'
    | 'refine-loop'
    | 'bad-verification';
  message: string;
  path?: string;
  id?: string;
}

export type LinkState = 'ok' | 'suspect' | 'unreviewed';

// How a requirement is verified. By test (the default): a test case verifies it. By
// analysis, inspection or demonstration: it's covered once `evidence:` names what shows
// it. None: it needs no verification (a definition, a constraint), so it's no gap.
export const METHODS = ['test', 'analysis', 'inspection', 'demonstration', 'none'] as const;
export type Method = (typeof METHODS)[number];
export const METHOD_LABEL: Record<Method, string> = { test: 'Test', analysis: 'Analysis', inspection: 'Inspection', demonstration: 'Demonstration', none: 'None needed' };
export const byEvidence = (m: Method) => m !== 'test' && m !== 'none';

function readMethod(v: unknown): Method | null {
  if (v == null || v === '') return 'test';
  const m = String(v).trim().toLowerCase();
  return (METHODS as readonly string[]).includes(m) ? (m as Method) : null;
}

export interface Link {
  test: Item;
  req: Item;
  state: LinkState;
}

// A requirement breaking down another: the child names its parent under `refines:`.
export interface RefineLink {
  child: Item;
  parent: Item;
  state: LinkState;
}

export interface ProjectIndex {
  config: TraceConfig;
  items: Item[];
  byId: Map<string, Item>; // the first item with each ID
  byPath: Map<string, Item>;
  verifiedBy: Map<string, Item[]>; // requirement ID → test cases verifying it
  refinedBy: Map<string, Item[]>; // requirement ID → requirements refining it
  problems: Problem[];
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => x != null && x !== '').map((x) => String(x).trim()) : v == null || v === '' ? [] : String(v).split(/[,\s]+/).filter(Boolean);

function kindOf(id: string, data: Record<string, unknown>, path: string, config: TraceConfig): Kind | null {
  const type = typeof data.type === 'string' ? data.type.toLowerCase() : '';
  if (/^req(uirement)?$/.test(type)) return 'requirement';
  if (/^(test|testcase|test-case|tc)$/.test(type)) return 'testcase';
  if (id.startsWith(config.testcases.prefix)) return 'testcase';
  if (id.startsWith(config.requirements.prefix)) return 'requirement';
  if (id && inDir(path, config.testcases.dir)) return 'testcase';
  if (id && inDir(path, config.requirements.dir)) return 'requirement';
  return null;
}

const inDir = (path: string, dir: string) => !!dir && (path === dir || path.startsWith(dir + '/'));

export function readItem(file: SourceFile, config: TraceConfig): { item: Item | null; problems: Problem[] } {
  const { text } = decodeText(file.text);
  const { front, body } = splitFrontMatter(text);
  const problems: Problem[] = [];
  const { data, error } = readFrontMatter(front);
  const configured = inDir(file.path, config.requirements.dir) || inDir(file.path, config.testcases.dir);
  if (error) {
    if (configured || front?.includes('id:')) problems.push({ severity: 'error', code: 'yaml', message: `Front matter can't be read: ${error}`, path: file.path });
    return { item: null, problems };
  }
  const id = data.id == null ? '' : String(data.id).trim();
  const kind = kindOf(id, data, file.path, config);
  if (!id || !kind) {
    if (configured && front != null && !/(^|\/)(README|index)\.md$/i.test(file.path))
      problems.push({ severity: 'warning', code: 'no-id', message: 'No id in the front matter, so this file is not a requirement or test case.', path: file.path });
    return { item: null, problems };
  }
  const method = kind === 'requirement' ? readMethod(data.verification) : 'test';
  if (method === null)
    problems.push({
      severity: 'warning',
      code: 'bad-verification',
      message: `${id} has verification “${String(data.verification)}”, which isn't one of: ${METHODS.join(', ')}. It's taken as test.`,
      path: file.path,
      id,
    });
  const reviewedRaw = data.reviewed;
  const reviewed: Record<string, string> = {};
  if (reviewedRaw && typeof reviewedRaw === 'object' && !Array.isArray(reviewedRaw))
    for (const [k, v] of Object.entries(reviewedRaw)) reviewed[k] = String(v);
  return {
    item: {
      kind,
      id,
      title: data.title == null ? '' : String(data.title),
      status: data.status == null ? '' : String(data.status),
      components: list(data.components),
      variants: list(data.variants),
      jira: list(data.jira),
      verifies: kind === 'testcase' ? list(data.verifies) : [],
      refines: kind === 'requirement' ? list(data.refines) : [],
      verification: method ?? 'test',
      evidence: kind === 'requirement' ? (Array.isArray(data.evidence) ? data.evidence : data.evidence == null || data.evidence === '' ? [] : [data.evidence]).map((x) => String(x).trim()).filter(Boolean) : [],
      estimate: kind === 'testcase' ? (parseDuration(data.estimate) ?? null) : null,
      reviewed,
      path: file.path,
      front,
      body,
      data,
    },
    problems,
  };
}

export function buildIndex(files: SourceFile[], configText: string | null): ProjectIndex {
  const { config, error } = parseConfig(configText);
  const problems: Problem[] = error ? [{ severity: 'error', code: 'config', message: error, path: 'trace.yml' }] : [];
  const items: Item[] = [];
  for (const f of files) {
    if (!/\.md$/i.test(f.path)) continue; // test runs and other files
    const r = readItem(f, config);
    problems.push(...r.problems);
    if (r.item) items.push(r.item);
  }
  items.sort(compareItems);

  const byId = new Map<string, Item>();
  const byPath = new Map<string, Item>();
  const seen = new Map<string, Item[]>();
  for (const it of items) {
    byPath.set(it.path, it);
    if (!byId.has(it.id)) byId.set(it.id, it);
    seen.set(it.id, [...(seen.get(it.id) ?? []), it]);
  }
  for (const [id, same] of seen)
    if (same.length > 1)
      for (const it of same)
        problems.push({ severity: 'error', code: 'duplicate-id', message: `${id} is also used by ${same.filter((o) => o !== it).map((o) => o.path).join(', ')}.`, path: it.path, id });

  const verifiedBy = new Map<string, Item[]>();
  const refinedBy = new Map<string, Item[]>();
  const componentKeys = new Set(config.components.map((c) => c.key));
  const variantKeys = new Set(config.variants.map((v) => v.key));
  for (const it of items) {
    if (!it.title.trim()) problems.push({ severity: 'warning', code: 'missing-title', message: `${it.id} has no title.`, path: it.path, id: it.id });
    const statuses = statusesFor(config, it.kind);
    if (it.status && !statuses.includes(it.status))
      problems.push({ severity: 'warning', code: 'bad-status', message: `${it.id} has status “${it.status}”, which isn't one of: ${statuses.join(', ')}.`, path: it.path, id: it.id });
    if (componentKeys.size)
      for (const c of it.components)
        if (!componentKeys.has(c)) problems.push({ severity: 'warning', code: 'unknown-component', message: `${it.id} names component “${c}”, which trace.yml doesn't define.`, path: it.path, id: it.id });
    if (it.kind === 'testcase' && parseDuration(it.data.estimate) === null)
      problems.push({
        severity: 'warning',
        code: 'bad-estimate',
        message: `${it.id} has estimate “${String(it.data.estimate)}”, which isn't a time: write it like 30m, 1h or 1h 30m.`,
        path: it.path,
        id: it.id,
      });
    for (const f of config.fields) {
      const issue = f.kinds.includes(it.kind) ? fieldIssue(f, it.data[f.key]) : null;
      if (issue) problems.push({ severity: 'warning', code: 'bad-field', message: `${it.id} has ${f.name} ${issue}.`, path: it.path, id: it.id });
    }
    for (const v of it.variants)
      if (!variantKeys.has(v))
        problems.push({
          severity: 'warning',
          code: 'unknown-variant',
          message: variantKeys.size ? `${it.id} names variant “${v}”, which trace.yml doesn't define.` : `${it.id} names variant “${v}”, but trace.yml defines no variants.`,
          path: it.path,
          id: it.id,
        });
    for (const target of it.verifies) {
      const req = byId.get(target);
      if (!req) problems.push({ severity: 'error', code: 'broken-link', message: `${it.id} verifies ${target}, which doesn't exist.`, path: it.path, id: it.id });
      else if (req.kind !== 'requirement') problems.push({ severity: 'error', code: 'link-to-testcase', message: `${it.id} verifies ${target}, which is a test case.`, path: it.path, id: it.id });
      else {
        verifiedBy.set(target, [...(verifiedBy.get(target) ?? []), it]);
        if (!sharesVariant(it, req))
          problems.push({
            severity: 'warning',
            code: 'variant-mismatch',
            message: `${it.id} is for ${it.variants.join(', ')} and ${req.id} for ${req.variants.join(', ')}, so it can never verify it.`,
            path: it.path,
            id: it.id,
          });
      }
    }
    for (const target of it.refines) {
      const parent = byId.get(target);
      if (!parent) problems.push({ severity: 'error', code: 'broken-link', message: `${it.id} refines ${target}, which doesn't exist.`, path: it.path, id: it.id });
      else if (parent.kind !== 'requirement') problems.push({ severity: 'error', code: 'link-to-testcase', message: `${it.id} refines ${target}, which is a test case.`, path: it.path, id: it.id });
      else if (parent === it) problems.push({ severity: 'error', code: 'refine-loop', message: `${it.id} refines itself.`, path: it.path, id: it.id });
      else {
        refinedBy.set(target, [...(refinedBy.get(target) ?? []), it]);
        if (!sharesVariant(it, parent))
          problems.push({
            severity: 'warning',
            code: 'variant-mismatch',
            message: `${it.id} is for ${it.variants.join(', ')} and ${parent.id} for ${parent.variants.join(', ')}, so it can never refine it.`,
            path: it.path,
            id: it.id,
          });
      }
    }
  }
  // A requirement that, through its parents, refines itself.
  for (const it of items) {
    if (it.kind !== 'requirement' || !it.refines.length) continue;
    const seen = new Set<string>();
    const queue = it.refines.filter((r) => r !== it.id); // refining itself directly is reported above
    while (queue.length) {
      const id = queue.shift()!;
      if (id === it.id) {
        problems.push({ severity: 'error', code: 'refine-loop', message: `${it.id} refines itself through ${it.refines.join(', ')}: the chain of refines goes round in a loop.`, path: it.path, id: it.id });
        break;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      const p = byId.get(id);
      if (p && p !== it && p.kind === 'requirement') queue.push(...p.refines);
    }
  }
  return { config, items, byId, byPath, verifiedBy, refinedBy, problems };
}

// ---- variants ------------------------------------------------------------------------

export const appliesTo = (item: Pick<Item, 'variants'>, variant: string) => item.variants.length === 0 || item.variants.includes(variant);

// Whether two items can meet in some variant.
export const sharesVariant = (a: Pick<Item, 'variants'>, b: Pick<Item, 'variants'>) => !a.variants.length || !b.variants.length || a.variants.some((v) => b.variants.includes(v));

export function variantNames(config: TraceConfig, item: Pick<Item, 'variants'>): string {
  return item.variants.length ? item.variants.map((v) => config.variants.find((x) => x.key === v)?.name ?? v).join(', ') : 'All variants';
}

// The project as one variant sees it: only the items that apply to it, and only the
// links between them. Coverage, the graph and exports then work per variant as is.
export function forVariant(index: ProjectIndex, variant: string): ProjectIndex {
  const items = index.items.filter((i) => appliesTo(i, variant));
  const kept = new Set(items);
  const byId = new Map([...index.byId].filter(([, it]) => kept.has(it)));
  const byPath = new Map([...index.byPath].filter(([, it]) => kept.has(it)));
  const keep = (from: Map<string, Item[]>) => {
    const out = new Map<string, Item[]>();
    for (const [id, linked] of from) {
      const req = index.byId.get(id);
      if (!req || !kept.has(req)) continue;
      const l = linked.filter((x) => kept.has(x));
      if (l.length) out.set(id, l);
    }
    return out;
  };
  const verifiedBy = keep(index.verifiedBy);
  const refinedBy = keep(index.refinedBy);
  // Problems about items the variant doesn't have aren't its problems.
  const problems = index.problems.filter((p) => !p.path || !index.byPath.has(p.path) || byPath.has(p.path));
  return { config: index.config, items, byId, byPath, verifiedBy, refinedBy, problems };
}

// REQ-2 before REQ-10.
export function compareItems(a: Item, b: Item): number {
  if (a.kind !== b.kind) return a.kind === 'requirement' ? -1 : 1;
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

// ---- links and review ------------------------------------------------------------

// FNV-1a over the requirement's title and text, whitespace-insensitive.
export function fingerprint(req: Pick<Item, 'title' | 'body'>): string {
  const s = `${req.title.trim()}\n${req.body.replace(/\s+/g, ' ').trim()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Whether `from` (a test case verifying, or a requirement refining) still matches `req`.
export function linkState(from: Item, req: Item): LinkState {
  const seen = from.reviewed[req.id];
  if (!seen) return 'unreviewed';
  return seen === fingerprint(req) ? 'ok' : 'suspect';
}

// A requirement's refines links: up to the ones it breaks down, down to those breaking it down.
export function refinesOf(index: ProjectIndex, item: Item): { up: RefineLink[]; down: RefineLink[] } {
  if (item.kind !== 'requirement') return { up: [], down: [] };
  const up = item.refines.flatMap((id) => {
    const parent = index.byId.get(id);
    return parent && parent.kind === 'requirement' && parent !== item ? [{ child: item, parent, state: linkState(item, parent) }] : [];
  });
  const down = (index.refinedBy.get(item.id) ?? []).map((child) => ({ child, parent: item, state: linkState(child, item) }));
  return { up, down };
}

export function linksOf(index: ProjectIndex, item: Item): Link[] {
  if (item.kind === 'requirement') return (index.verifiedBy.get(item.id) ?? []).map((test) => ({ test, req: item, state: linkState(test, item) }));
  return item.verifies.flatMap((id) => {
    const req = index.byId.get(id);
    return req && req.kind === 'requirement' ? [{ test: item, req, state: linkState(item, req) }] : [];
  });
}

// ---- coverage ----------------------------------------------------------------------

export interface Coverage {
  requirements: Item[];
  testcases: Item[];
  counted: Item[]; // requirements that count: not obsolete, and needing verification
  tested: Item[]; // covered: verified by a test case, by evidence, or through their refinements
  throughRefinements: Item[]; // of those, the ones only covered through their refinements
  byEvidence: Item[]; // of those, the ones covered by analysis, inspection or demonstration
  untested: Item[]; // requirements (not obsolete) nothing covers
  exempt: Item[]; // requirements needing no verification (verification: none) that nothing covers
  orphans: Item[]; // test cases (not obsolete) that verify nothing
  suspect: Link[];
  unreviewed: Link[];
  suspectRefines: RefineLink[]; // parents changed since the refining requirement was reviewed
  componentsWithoutTests: Component[];
  problems: Problem[];
}

const live = (it: Item) => it.status !== 'obsolete';

export type CoveredBy = 'tests' | 'evidence' | 'refinements';

// Which requirements are covered, and how: verified by a test case, by evidence (when
// verified by analysis, inspection or demonstration), or broken down into requirements
// that all are. Refinements needing no verification don't count either way. Exempt:
// needing no verification, and covered by nothing.
export function verification(index: ProjectIndex): { covered: Map<string, CoveredBy>; exempt: Set<string> } {
  const covered = new Map<string, CoveredBy>();
  const exempt = new Set<string>();
  const visiting = new Set<string>();
  const check = (r: Item): CoveredBy | 'exempt' | null => {
    const known = covered.get(r.id) ?? (exempt.has(r.id) ? 'exempt' : undefined);
    if (known) return known;
    if (visiting.has(r.id)) return null; // a loop covers nothing
    let how: CoveredBy | 'exempt' | null = null;
    if ((index.verifiedBy.get(r.id) ?? []).some(live)) how = 'tests';
    else if (byEvidence(r.verification) && r.evidence.length) how = 'evidence';
    else {
      visiting.add(r.id);
      const below = (index.refinedBy.get(r.id) ?? []).filter(live).map(check).filter((x) => x !== 'exempt');
      visiting.delete(r.id);
      if (below.length && below.every(Boolean)) how = 'refinements';
      else if (r.verification === 'none') how = 'exempt';
    }
    if (how === 'exempt') exempt.add(r.id);
    else if (how) covered.set(r.id, how);
    return how;
  };
  for (const r of index.items) if (r.kind === 'requirement' && live(r)) check(r);
  return { covered, exempt };
}

export const coveredRequirements = (index: ProjectIndex) => verification(index).covered;

export function coverage(index: ProjectIndex): Coverage {
  const requirements = index.items.filter((i) => i.kind === 'requirement');
  const testcases = index.items.filter((i) => i.kind === 'testcase');
  const links = requirements.flatMap((r) => linksOf(index, r));
  const { covered, exempt } = verification(index);
  const tested = requirements.filter((r) => live(r) && covered.has(r.id));
  const refines = requirements.flatMap((r) => refinesOf(index, r).up);
  const testedComponents = new Set(testcases.filter(live).flatMap((t) => t.components));
  return {
    requirements,
    testcases,
    counted: requirements.filter((r) => live(r) && !exempt.has(r.id)),
    tested,
    throughRefinements: tested.filter((r) => covered.get(r.id) === 'refinements'),
    byEvidence: tested.filter((r) => covered.get(r.id) === 'evidence'),
    untested: requirements.filter((r) => live(r) && !covered.has(r.id) && !exempt.has(r.id)),
    exempt: requirements.filter((r) => exempt.has(r.id)),
    orphans: testcases.filter((t) => live(t) && t.verifies.length === 0),
    suspect: links.filter((l) => l.state === 'suspect' && live(l.test) && live(l.req)),
    unreviewed: links.filter((l) => l.state === 'unreviewed' && live(l.test) && live(l.req)),
    suspectRefines: refines.filter((l) => l.state === 'suspect' && live(l.child) && live(l.parent)),
    componentsWithoutTests: index.config.components.filter((c) => !testedComponents.has(c.key)),
    problems: index.problems,
  };
}

// ---- new items -------------------------------------------------------------------------

export function nextId(index: ProjectIndex, kind: Kind): string {
  const { prefix, digits } = kind === 'requirement' ? index.config.requirements : index.config.testcases;
  let max = 0;
  for (const it of index.items) {
    if (!it.id.startsWith(prefix)) continue;
    const n = Number(it.id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return prefix + String(max + 1).padStart(digits, '0');
}

// An ID someone typed for a new item: an error stops it, a warning only informs.
export function checkNewId(index: ProjectIndex, kind: Kind, raw: string): { error: string | null; warning: string | null } {
  const id = raw.trim();
  const own = (kind === 'requirement' ? index.config.requirements : index.config.testcases).prefix;
  const other = (kind === 'requirement' ? index.config.testcases : index.config.requirements).prefix;
  const ok = (warning: string | null = null) => ({ error: null, warning });
  if (!id) return { error: 'Enter an ID.', warning: null };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return { error: 'Use letters, digits and . - _ only, without spaces.', warning: null };
  if (id.length > 64) return { error: 'That ID is too long (64 characters at most).', warning: null };
  const taken = index.items.find((i) => i.id.toLowerCase() === id.toLowerCase());
  if (taken) return { error: `${taken.id} is already used by ${taken.path}.`, warning: null };
  if (other && !other.startsWith(own) && id.startsWith(other))
    return { error: `IDs starting with ${other} are ${kind === 'requirement' ? 'test cases' : 'requirements'}. Use one starting with ${own}.`, warning: null };
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(id))
    return ok(`Tracey recognizes IDs in text, commit messages and Jira when they look like ${own || 'TC-'}123 (capital letters, a dash, a number). This one is only linked through fields such as Verifies.`);
  if (own && !id.startsWith(own)) return ok(`It doesn’t start with ${own}, so the file says what it is (type: ${kind}).`);
  return ok();
}

export function slug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
}

export function newItemPath(index: ProjectIndex, kind: Kind, id: string, title: string): string {
  const dir = (kind === 'requirement' ? index.config.requirements : index.config.testcases).dir;
  const s = slug(title);
  const base = `${dir ? dir + '/' : ''}${id}${s ? '-' + s : ''}`;
  let path = `${base}.md`;
  for (let n = 2; index.byPath.has(path); n++) path = `${base}-${n}.md`;
  return path;
}

export function newItemText(
  kind: Kind,
  fields: { id: string; title: string; status: string; verifies?: string[]; refines?: string[]; components?: string[]; variants?: string[]; reviewed?: Record<string, string>; type?: boolean },
): string {
  const yamlString = (s: string) => (/^[\w .,()/-]*$/.test(s) && !/^[\s-]|:\s|\s$/.test(s) && s !== '' ? s : JSON.stringify(s));
  const lines = [`id: ${yamlString(fields.id)}`];
  // An ID without the kind's prefix: say what it is, rather than leave it to the folder.
  if (fields.type) lines.push(`type: ${kind}`);
  lines.push(`title: ${yamlString(fields.title)}`, `status: ${fields.status}`);
  if (fields.components?.length) lines.push(`components: [${fields.components.join(', ')}]`);
  if (fields.variants?.length) lines.push(`variants: [${fields.variants.join(', ')}]`);
  if (kind === 'testcase') lines.push(`verifies: [${(fields.verifies ?? []).join(', ')}]`);
  if (kind === 'requirement' && fields.refines?.length) lines.push(`refines: [${fields.refines.join(', ')}]`);
  const r = Object.entries(fields.reviewed ?? {});
  if (r.length) lines.push('reviewed:', ...r.map(([k, v]) => `  ${k}: "${v}"`));
  const body = kind === 'testcase' ? '## Steps\n\n1. \n\n## Expected\n\n' : '';
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

// ---- components ------------------------------------------------------------------------

// `src/payments/**`, `*.ts`, `docs/?.md`
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  const p = pattern.replace(/^\.?\//, '');
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function componentsForPath(path: string, components: Component[]): Component[] {
  return components.filter((c) => c.paths.some((p) => globToRegExp(p).test(path)));
}
