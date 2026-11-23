// Requirements and test cases, read from the repository's Markdown files, and the
// links between them. Pure: used by the app (live, as you type) and by `check` in CI.
//
// A file is an item when its front matter has an `id` whose prefix is a configured
// one (REQ-, TC-), or a `type: requirement | testcase`. IDs are never derived from
// file names, so files can be renamed or moved freely.
import { parseDuration } from './estimate';
import { fieldIssue } from './fields';
import { customLinks, isRunnable, isVerifiable, linksFrom, parseConfig, typeOf, type Component, type Kind, type LinkDef, type RuleDef, type TraceConfig, statusesFor } from './config';
import { decodeText, readFrontMatter, splitFrontMatter } from './frontmatter';
import { directiveOf, idPatternOf, isNeedPath, needFile, needPath, optionsOf, readConfPy, STANDARD_OPTIONS, withSphinxTypes, type NeedSeen, type SphinxDeclared } from './myst';

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
  links: Record<string, string[]>; // declared link types (trace.yml links:) → the IDs it names
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
    | 'bad-verification'
    | 'wrong-link-type'
    | 'sphinx';
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

// A link of a declared type: `from` names `to` under the link's key.
export interface ItemLink {
  def: LinkDef;
  from: Item;
  to: Item;
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
  linkedBy: Map<string, Map<string, Item[]>>; // declared link type → ID → the items linking to it
  problems: Problem[];
  sphinx?: SphinxDeclared | null; // a Sphinx-Needs project: what its conf.py declares (null: no conf.py)
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => x != null && x !== '').map((x) => String(x).trim()) : v == null || v === '' ? [] : String(v).split(/[,\s]+/).filter(Boolean);

// The type said in the file (`type: risk`), else the longest ID prefix that matches,
// else the folder it's in. Test cases win a tie with requirements, as they always have.
function kindOf(id: string, data: Record<string, unknown>, path: string, config: TraceConfig): Kind | null {
  const type = typeof data.type === 'string' ? data.type.toLowerCase().trim() : '';
  if (/^req(uirement)?$/.test(type)) return 'requirement';
  if (/^(test|testcase|test-case|tc)$/.test(type)) return 'testcase';
  const declared = config.types.find((t) => !t.builtIn && (t.key === type || t.name.toLowerCase() === type));
  if (declared) return declared.key;
  const order = [...config.types].sort((a, b) => Number(b.key === 'testcase') - Number(a.key === 'testcase'));
  const byPrefix = order.filter((t) => t.prefix && id.startsWith(t.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (byPrefix) return byPrefix.key;
  const byDir = id ? order.filter((t) => t.dir && inDir(path, t.dir)).sort((a, b) => b.dir.length - a.dir.length)[0] : undefined;
  return byDir?.key ?? null;
}

const inDir = (path: string, dir: string) => !!dir && (path === dir || path.startsWith(dir + '/'));

export function readItem(file: SourceFile, config: TraceConfig): { item: Item | null; problems: Problem[] } {
  const { text } = decodeText(file.text);
  const { front, body } = splitFrontMatter(text);
  const problems: Problem[] = [];
  const { data, error } = readFrontMatter(front);
  const configured = config.types.some((t) => t.dir && inDir(file.path, t.dir));
  if (error) {
    if (configured || front?.includes('id:')) problems.push({ severity: 'error', code: 'yaml', message: `Front matter can't be read: ${error}`, path: file.path });
    return { item: null, problems };
  }
  const id = data.id == null ? '' : String(data.id).trim();
  const kind = kindOf(id, data, file.path, config);
  if (!id || !kind) {
    if (isNeedPath(file.path)) {
      if (kind) problems.push({ severity: 'warning', code: 'no-id', message: `This ${String(data.type ?? 'need')} has no :id:, so nothing can link to it. Give it one.`, path: file.path });
      return { item: null, problems };
    }
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
      verifies: isRunnable(config, kind) ? list(data.verifies) : [],
      refines: kind === 'requirement' ? list(data.refines) : [],
      links: Object.fromEntries(linksFrom(config, kind).filter((l) => !l.builtIn).map((l) => [l.key, list(data[l.key])])),
      verification: method ?? 'test',
      evidence: kind === 'requirement' ? (Array.isArray(data.evidence) ? data.evidence : data.evidence == null || data.evidence === '' ? [] : [data.evidence]).map((x) => String(x).trim()).filter(Boolean) : [],
      estimate: isRunnable(config, kind) ? (parseDuration(data.estimate) ?? null) : null,
      reviewed,
      path: file.path,
      front,
      body,
      data,
    },
    problems,
  };
}

// What's wrong with an item by itself (not its links): read once with the item, and
// kept with it while the file and the settings stay the same.
function itemProblems(it: Item, config: TraceConfig): Problem[] {
  const problems: Problem[] = [];
  const componentKeys = new Set(config.components.map((c) => c.key));
  const variantKeys = new Set(config.variants.map((v) => v.key));
  if (!it.title.trim()) problems.push({ severity: 'warning', code: 'missing-title', message: `${it.id} has no title.`, path: it.path, id: it.id });
  const statuses = statusesFor(config, it.kind);
  if (it.status && !statuses.includes(it.status))
    problems.push({ severity: 'warning', code: 'bad-status', message: `${it.id} has status “${it.status}”, which isn't one of: ${statuses.join(', ')}.`, path: it.path, id: it.id });
  if (componentKeys.size)
    for (const c of it.components)
      if (!componentKeys.has(c)) problems.push({ severity: 'warning', code: 'unknown-component', message: `${it.id} names component “${c}”, which trace.yml doesn't define.`, path: it.path, id: it.id });
  if (isRunnable(config, it.kind) && parseDuration(it.data.estimate) === null)
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
  return problems;
}

// Files read before, by path, text and settings: as you type, only the file that
// changed is read again (items are never changed once read, so they're shared).
const readCache = new Map<string, { text: string; configText: string | null; read: ReturnType<typeof readItem> }>();
function readChecked(f: SourceFile, config: TraceConfig): ReturnType<typeof readItem> {
  const r = readItem(f, config);
  return r.item ? { item: r.item, problems: [...r.problems, ...itemProblems(r.item, config)] } : r;
}

export function buildIndex(files: SourceFile[], configText: string | null): ProjectIndex {
  const parsed = parseConfig(configText);
  const problems: Problem[] = parsed.error ? [{ severity: 'error', code: 'config', message: parsed.error, path: 'trace.yml' }] : [];
  // A Sphinx-Needs project: conf.py's declarations, and the types it declares as item types.
  const sphinx = parsed.config.sphinx ? readConfPy(files.find((f) => f.path === parsed.config.sphinx!.conf)?.text ?? null) : undefined;
  const config = parsed.config.sphinx ? withSphinxTypes(parsed.config, sphinx ?? null, needsSeen(files)) : parsed.config;
  // Items read under other settings are read again.
  const settings = config === parsed.config ? configText : `${configText}\n${JSON.stringify([config.types, config.sphinx?.types, config.sphinx?.reads])}`;
  const items: Item[] = [];
  // Other projects or versions (the trend reads old ones) replace entries as they go;
  // it's emptied when it grows well past what one project holds.
  if (readCache.size > 4 * files.length + 2000) readCache.clear();
  for (const f of files) {
    if (!/\.md(#[^/]*)?$/i.test(f.path)) continue; // test runs and other files
    const hit = readCache.get(f.path);
    const r = hit && hit.text === f.text && hit.configText === settings ? hit.read : readChecked(f, config);
    if (r !== hit?.read) readCache.set(f.path, { text: f.text, configText: settings, read: r });
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
    const same = seen.get(it.id);
    if (same) same.push(it);
    else seen.set(it.id, [it]);
  }
  for (const [id, same] of seen)
    if (same.length > 1)
      for (const it of same)
        problems.push({ severity: 'error', code: 'duplicate-id', message: `${id} is also used by ${same.filter((o) => o !== it).map((o) => o.path).join(', ')}.`, path: it.path, id });

  const verifiedBy = new Map<string, Item[]>();
  const refinedBy = new Map<string, Item[]>();
  const linkedBy = new Map<string, Map<string, Item[]>>(customLinks(config).map((l) => [l.key, new Map()]));
  const typeName = (k: Kind) => typeOf(config, k).name.toLowerCase();
  const a = (word: string) => `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;
  const verifiable = config.types.filter((t) => isVerifiable(config, t.key)).map((t) => t.plural.toLowerCase());
  for (const it of items) {
    for (const target of it.verifies) {
      const req = byId.get(target);
      if (!req) problems.push({ severity: 'error', code: 'broken-link', message: `${it.id} verifies ${target}, which doesn't exist.`, path: it.path, id: it.id });
      else if (!isVerifiable(config, req.kind))
        problems.push({
          severity: 'error',
          code: 'link-to-testcase',
          message: `${it.id} verifies ${target}, which is ${a(typeName(req.kind))}${verifiable.length > 1 ? `: tests verify ${verifiable.join(' or ')}` : ''}.`,
          path: it.path,
          id: it.id,
        });
      else {
        const by = verifiedBy.get(target);
        if (by) by.push(it);
        else verifiedBy.set(target, [it]);
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
      else if (parent.kind !== 'requirement') problems.push({ severity: 'error', code: 'link-to-testcase', message: `${it.id} refines ${target}, which is ${a(typeName(parent.kind))}.`, path: it.path, id: it.id });
      else if (parent === it) problems.push({ severity: 'error', code: 'refine-loop', message: `${it.id} refines itself.`, path: it.path, id: it.id });
      else {
        const by = refinedBy.get(target);
        if (by) by.push(it);
        else refinedBy.set(target, [it]);
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
  // Links of the declared types.
  for (const it of items)
    for (const [key, targets] of Object.entries(it.links)) {
      const def = config.links.find((l) => l.key === key)!;
      const into = linkedBy.get(key)!;
      for (const target of targets) {
        const to = byId.get(target);
        const where = { path: it.path, id: it.id };
        if (!to) problems.push({ severity: 'error', code: 'broken-link', message: `${it.id} ${def.name.toLowerCase()} ${target}, which doesn't exist.`, ...where });
        else if (to === it) problems.push({ severity: 'error', code: 'wrong-link-type', message: `${it.id} ${def.name.toLowerCase()} itself.`, ...where });
        else if (!def.to.includes(to.kind))
          problems.push({
            severity: 'error',
            code: 'wrong-link-type',
            message: `${it.id} ${def.name.toLowerCase()} ${target}, which is ${a(typeName(to.kind))}: ${def.key} links go to ${def.to.map((k) => typeOf(config, k).plural.toLowerCase()).join(' or ')}.`,
            ...where,
          });
        else {
          const by = into.get(target);
          if (by) by.push(it);
          else into.set(target, [it]);
          if (!sharesVariant(it, to))
            problems.push({ severity: 'warning', code: 'variant-mismatch', message: `${it.id} is for ${it.variants.join(', ')} and ${to.id} for ${to.variants.join(', ')}, so the link never applies.`, ...where });
        }
      }
    }
  for (const n of config.notes) problems.push({ severity: 'warning', code: 'config', message: n, path: 'trace.yml' });
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
  if (config.sphinx) problems.push(...sphinxProblems(files, items, config, sphinx ?? null, byId));
  return { config, items, byId, byPath, verifiedBy, refinedBy, linkedBy, problems, sphinx };
}

// The needs among the files, as their item texts say (the type is the directive, for the
// types withSphinxTypes settles).
function needsSeen(files: SourceFile[]): NeedSeen[] {
  const field = (front: string, key: string) => new RegExp(`^${key}: *(.*)$`, 'm').exec(front)?.[1].trim().replace(/^(["'])(.*)\1$/, '$2') ?? '';
  return files.flatMap((f) => {
    if (!isNeedPath(f.path)) return [];
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(f.text)?.[1] ?? '';
    return [{ directive: field(front, 'type'), id: field(front, 'id'), status: field(front, 'status') || null }];
  });
}

// What a Sphinx build would trip over, or what Tracey leaves out: options conf.py doesn't
// declare, IDs its pattern refuses, and needs of types that aren't item types.
function sphinxProblems(files: SourceFile[], items: Item[], config: TraceConfig, declared: SphinxDeclared | null, byId: Map<string, Item>): Problem[] {
  const problems: Problem[] = [];
  const conf = config.sphinx!.conf;
  if (!declared) problems.push({ severity: 'warning', code: 'sphinx', message: `There's no ${conf}, so Tracey can't check needs against what Sphinx-Needs declares. Set sphinx-needs: conf: in trace.yml.`, path: 'trace.yml' });
  const unmapped = new Map<string, number>();
  for (const f of files) {
    if (!isNeedPath(f.path) || byId.get(/^id: (.+)$/m.exec(f.text)?.[1] ?? '')?.path === f.path) continue;
    const type = /^type: (.+)$/m.exec(f.text)?.[1]?.trim();
    if (type && !config.types.some((t) => t.key === type)) unmapped.set(type, (unmapped.get(type) ?? 0) + 1);
  }
  for (const [type, n] of unmapped)
    problems.push({
      severity: 'warning',
      code: 'sphinx',
      message: `${n} ${type} need${n === 1 ? ' isn’t' : 's aren’t'} shown: ${type} isn't an item type${declared && !declared.directives.some((d) => d.directive === type) ? `, and needs_types in ${conf} doesn't declare it` : ''}. Map it under sphinx-needs: types: (${type}: requirement), or declare it under types:.`,
      path: 'trace.yml',
    });
  if (!declared) return problems;
  const ctx = { config, declared, kindOfId: (id: string) => byId.get(id)?.kind ?? null };
  const undeclared = new Map<string, string[]>();
  const known = new Set([...STANDARD_OPTIONS, ...declared.options, ...declared.links]);
  const pattern = idPatternOf(declared);
  const directives = new Set(declared.directives.map((d) => d.directive));
  for (const it of items) {
    if (!isNeedPath(it.path)) continue;
    if (!pattern.test(it.id))
      problems.push({ severity: 'warning', code: 'sphinx', message: `${it.id} doesn't match the ID pattern Sphinx-Needs checks (${pattern.source}).`, path: it.path, id: it.id });
    if (declared.complete)
      for (const o of optionsOf(`---\n${it.front ?? ''}---\n`, ctx)) if (!known.has(o)) (undeclared.get(o) ?? undeclared.set(o, []).get(o)!).push(it.id);
  }
  for (const [o, ids] of undeclared) {
    const link = config.links.some((l) => l.key === o);
    problems.push({
      severity: 'warning',
      code: 'sphinx',
      message: `Sphinx-Needs doesn't know the option :${o}:, which ${ids.length > 3 ? `${ids.slice(0, 3).join(', ')} and ${ids.length - 3} more use` : `${ids.join(', ')} use${ids.length === 1 ? 's' : ''}`}. Add ${link ? `{"option": "${o}"} to needs_extra_links` : `"${o}" to needs_extra_options`} in ${conf}${link ? `, or map an option to ${o} under sphinx-needs: links:` : ''}.`,
      path: conf,
    });
  }
  // needs_types replaces Sphinx-Needs' own types, so what Tracey writes must be in it.
  if (directives.size)
    for (const t of config.types) {
      const d = directiveOf(config, t.key);
      if ((t.builtIn || items.some((i) => i.kind === t.key && isNeedPath(i.path))) && !directives.has(d))
        problems.push({ severity: 'warning', code: 'sphinx', message: `New ${t.plural.toLowerCase()} are written as {${d}}, which needs_types in ${conf} doesn't declare. Map another directive to ${t.key} under sphinx-needs: types:.`, path: conf });
    }
  return problems;
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
  const linkedBy = new Map([...index.linkedBy].map(([k, m]) => [k, keep(m)]));
  // Problems about items the variant doesn't have aren't its problems.
  const problems = index.problems.filter((p) => !p.path || !index.byPath.has(p.path) || byPath.has(p.path));
  return { config: index.config, items, byId, byPath, verifiedBy, refinedBy, linkedBy, problems, sphinx: index.sphinx };
}

// REQ-2 before REQ-10.
const kindRank = (k: Kind) => (k === 'requirement' ? 0 : k === 'testcase' ? 1 : 2);
// One collator for every comparison: localeCompare with options makes a new one each
// time, which takes seconds over a hundred thousand items.
export const compareIds = new Intl.Collator(undefined, { numeric: true }).compare;

export function compareItems(a: Item, b: Item): number {
  if (a.kind !== b.kind) return kindRank(a.kind) - kindRank(b.kind) || a.kind.localeCompare(b.kind);
  return compareIds(a.id, b.id);
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

// Verifies links: of a verified item (a requirement…), the tests verifying it; of a test
// (a test case, or another runnable type), what it verifies.
export function linksOf(index: ProjectIndex, item: Item): Link[] {
  if (isVerifiable(index.config, item.kind)) return (index.verifiedBy.get(item.id) ?? []).map((test) => ({ test, req: item, state: linkState(test, item) }));
  return item.verifies.flatMap((id) => {
    const req = index.byId.get(id);
    return req && req !== item && isVerifiable(index.config, req.kind) ? [{ test: item, req, state: linkState(item, req) }] : [];
  });
}

// An item's links of the declared types: out to what it names, in from what names it.
export function itemLinks(index: ProjectIndex, item: Item): { out: ItemLink[]; in: ItemLink[] } {
  const out: ItemLink[] = [];
  for (const [key, targets] of Object.entries(item.links)) {
    const def = index.config.links.find((l) => l.key === key);
    if (!def) continue;
    for (const id of targets) {
      const to = index.byId.get(id);
      if (to && to !== item && def.to.includes(to.kind)) out.push({ def, from: item, to, state: linkState(item, to) });
    }
  }
  const incoming: ItemLink[] = [];
  for (const [key, by] of index.linkedBy) {
    const def = index.config.links.find((l) => l.key === key)!;
    for (const from of by.get(item.id) ?? []) incoming.push({ def, from, to: item, state: linkState(from, item) });
  }
  return { out, in: incoming };
}

// Every link an item makes, of any type: the IDs it names. For review fingerprints.
export const linkedIds = (item: Item): string[] => [...new Set([...item.verifies, ...item.refines, ...Object.values(item.links).flat()])];

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
  orphans: Item[]; // test cases and other runnable items (not obsolete) that verify nothing
  suspect: Link[];
  unreviewed: Link[];
  suspectRefines: RefineLink[]; // parents changed since the refining requirement was reviewed
  suspectLinks: ItemLink[]; // declared link types: the linked item changed since review
  unreviewedLinks: ItemLink[];
  rules: RuleResult[]; // trace.yml rules: the items each leaves without a needed link
  componentsWithoutTests: Component[];
  problems: Problem[];
}

const live = (it: Item) => it.status !== 'obsolete';

export type CoveredBy = 'tests' | 'evidence' | 'refinements';

export interface RuleResult {
  rule: RuleDef;
  items: Item[]; // the live items of its type
  missing: Item[]; // of those, the ones without the link
}

// Each rule: the items (not obsolete) of its type without a link of its type, to them
// (incoming) or from them (outgoing). Links from or to obsolete items don't count.
export function checkRules(index: ProjectIndex): RuleResult[] {
  return index.config.rules.map((rule) => {
    const items = index.items.filter((i) => i.kind === rule.type && live(i));
    const has = (it: Item) =>
      rule.incoming
        ? (index.linkedBy.get(rule.link) ?? (rule.link === 'verifies' ? index.verifiedBy : rule.link === 'refines' ? index.refinedBy : new Map<string, Item[]>())).get(it.id)?.some(live)
        : (rule.link === 'verifies' ? it.verifies : rule.link === 'refines' ? it.refines : (it.links[rule.link] ?? [])).some((id) => {
            const t = index.byId.get(id);
            return !!t && t !== it && live(t);
          });
    return { rule, items, missing: items.filter((i) => !has(i)) };
  });
}

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
  const tests = index.items.filter((i) => isRunnable(index.config, i.kind)); // test cases and other runnable types
  const links = index.items.filter((i) => isVerifiable(index.config, i.kind)).flatMap((r) => linksOf(index, r));
  const { covered, exempt } = verification(index);
  const tested = requirements.filter((r) => live(r) && covered.has(r.id));
  const refines = requirements.flatMap((r) => refinesOf(index, r).up);
  const testedComponents = new Set(tests.filter(live).flatMap((t) => t.components));
  const declared = index.items.flatMap((i) => itemLinks(index, i).out).filter((l) => live(l.from) && live(l.to));
  return {
    requirements,
    testcases,
    counted: requirements.filter((r) => live(r) && !exempt.has(r.id)),
    tested,
    throughRefinements: tested.filter((r) => covered.get(r.id) === 'refinements'),
    byEvidence: tested.filter((r) => covered.get(r.id) === 'evidence'),
    untested: requirements.filter((r) => live(r) && !covered.has(r.id) && !exempt.has(r.id)),
    exempt: requirements.filter((r) => exempt.has(r.id)),
    orphans: tests.filter((t) => live(t) && t.verifies.length === 0),
    suspect: links.filter((l) => l.state === 'suspect' && live(l.test) && live(l.req)),
    unreviewed: links.filter((l) => l.state === 'unreviewed' && live(l.test) && live(l.req)),
    suspectRefines: refines.filter((l) => l.state === 'suspect' && live(l.child) && live(l.parent)),
    suspectLinks: declared.filter((l) => l.state === 'suspect'),
    unreviewedLinks: declared.filter((l) => l.state === 'unreviewed'),
    rules: checkRules(index),
    componentsWithoutTests: index.config.components.filter((c) => !testedComponents.has(c.key)),
    problems: index.problems,
  };
}

// ---- new items -------------------------------------------------------------------------

export function nextId(index: ProjectIndex, kind: Kind): string {
  const { prefix, digits } = typeOf(index.config, kind);
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
  const own = typeOf(index.config, kind).prefix;
  // Another type's prefix, unless this type's is a longer one starting with it.
  const otherType = index.config.types.find((t) => t.key !== kind && t.prefix && id.startsWith(t.prefix) && !(own.startsWith(t.prefix) && id.startsWith(own)));
  const ok = (warning: string | null = null) => ({ error: null, warning });
  if (!id) return { error: 'Enter an ID.', warning: null };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return { error: 'Use letters, digits and . - _ only, without spaces.', warning: null };
  if (id.length > 64) return { error: 'That ID is too long (64 characters at most).', warning: null };
  const taken = index.items.find((i) => i.id.toLowerCase() === id.toLowerCase());
  if (taken) return { error: `${taken.id} is already used by ${taken.path}.`, warning: null };
  if (otherType) return { error: `IDs starting with ${otherType.prefix} are ${otherType.plural.toLowerCase()}. Use one starting with ${own}.`, warning: null };
  if (index.config.sphinx) {
    const pattern = idPatternOf(index.sphinx ?? null);
    if (!pattern.test(id)) return { error: `Sphinx-Needs takes IDs matching ${pattern.source}${index.sphinx?.idRegex ? '' : ' (capital letters, digits and _, five or more)'}.`, warning: null };
    return ok(own && !id.startsWith(own) ? `It doesn’t start with ${own}.` : null);
  }
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
  if (index.config.sphinx) return needPath(newNeedFile(index, kind), id);
  const dir = typeOf(index.config, kind).dir;
  const s = slug(title);
  const base = `${dir ? dir + '/' : ''}${id}${s ? '-' + s : ''}`;
  let path = `${base}.md`;
  for (let n = 2; index.byPath.has(path); n++) path = `${base}-${n}.md`;
  return path;
}

// The MyST file a new need goes in: as trace.yml says, else the one holding the most of
// its type, else one named after the type in the MyST folder.
export function newNeedFile(index: ProjectIndex, kind: Kind): string {
  const sphinx = index.config.sphinx!;
  if (sphinx.files[kind]) return sphinx.files[kind];
  const counts = new Map<string, number>();
  for (const it of index.items) if (it.kind === kind && isNeedPath(it.path)) counts.set(needFile(it.path), (counts.get(needFile(it.path)) ?? 0) + 1);
  const most = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return most ?? `${sphinx.dir ? `${sphinx.dir}/` : ''}${slug(typeOf(index.config, kind).plural) || kind}.md`;
}

export function newItemText(
  kind: Kind,
  fields: {
    id: string;
    title: string;
    status: string;
    verifies?: string[];
    refines?: string[];
    links?: Record<string, string[]>;
    components?: string[];
    variants?: string[];
    reviewed?: Record<string, string>;
    type?: boolean;
    steps?: boolean; // start with Steps and Expected headings (test cases, and runnable types)
    labels?: boolean; // bold labels instead of headings (a Sphinx need can't hold headings)
  },
): string {
  const yamlString = (s: string) => (/^[\w .,()/-]*$/.test(s) && !/^[\s-]|:\s|\s$/.test(s) && s !== '' ? s : JSON.stringify(s));
  const lines = [`id: ${yamlString(fields.id)}`];
  // An ID without the kind's prefix: say what it is, rather than leave it to the folder.
  if (fields.type) lines.push(`type: ${kind}`);
  lines.push(`title: ${yamlString(fields.title)}`, `status: ${fields.status}`);
  if (fields.components?.length) lines.push(`components: [${fields.components.join(', ')}]`);
  if (fields.variants?.length) lines.push(`variants: [${fields.variants.join(', ')}]`);
  if (kind === 'testcase' || fields.verifies) lines.push(`verifies: [${(fields.verifies ?? []).join(', ')}]`);
  if (kind === 'requirement' && fields.refines?.length) lines.push(`refines: [${fields.refines.join(', ')}]`);
  for (const [key, ids] of Object.entries(fields.links ?? {})) if (ids.length) lines.push(`${key}: [${ids.join(', ')}]`);
  const r = Object.entries(fields.reviewed ?? {});
  if (r.length) lines.push('reviewed:', ...r.map(([k, v]) => `  ${k}: "${v}"`));
  const body = kind === 'testcase' || fields.steps ? (fields.labels ? '**Steps**\n\n1. \n\n**Expected**\n\n' : '## Steps\n\n1. \n\n## Expected\n\n') : '';
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

// A component's paths: patterns it covers, and (starting with !) parts of those it doesn't,
// as `["src/payments/**", "!src/payments/refunds/**"]` when refunds is its own component.
export function componentsForPath(path: string, components: Component[]): Component[] {
  const hit = (p: string) => globToRegExp(p).test(path);
  return components.filter((c) => c.paths.some((p) => !p.startsWith('!') && hit(p)) && !c.paths.some((p) => p.startsWith('!') && hit(p.slice(1))));
}
