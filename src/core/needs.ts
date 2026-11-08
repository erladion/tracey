// Sphinx-Needs interchange: the project as a needs.json (what Sphinx-Needs' `needs`
// builder writes and its `needimport` reads), and items from one.
//
// The file (format 1):
//
//   { "created": "…", "current_version": "1.0", "project": "…",
//     "versions": { "1.0": { "created": "…", "creator": {…}, "needs_amount": 12,
//                            "needs": { "REQ-07": { "id": "REQ-07", "type": "req", … } } } } }
//
// A need has id, type, type_name, title, status, tags, content (before Sphinx-Needs 4:
// description), a list for each link type and `<link>_back` for the reverse, and any
// other fields. Requirements are type `req` and test cases `test`, as in Sphinx-Needs'
// defaults; declared types keep their key. Components become tags. Text is Markdown, as
// written (a MyST project reads it as is).
import { linksFrom, linksTo, typeKey, typeOf, type Kind, type TraceConfig } from './config';
import { setFields } from './frontmatter';
import { fingerprint, newItemPath, slug, type Item, type ProjectIndex } from './model';

const TO_SPHINX: Record<string, string> = { requirement: 'req', testcase: 'test' };
const FROM_SPHINX: Record<string, string> = { req: 'requirement', test: 'testcase' };

// What an item links to of a link type, and what links to it.
const targets = (it: Item, key: string) => (key === 'verifies' ? it.verifies : key === 'refines' ? it.refines : (it.links[key] ?? []));
function sources(index: ProjectIndex, it: Item, key: string): Item[] {
  if (key === 'verifies') return index.verifiedBy.get(it.id) ?? [];
  if (key === 'refines') return index.refinedBy.get(it.id) ?? [];
  return index.linkedBy.get(key)?.get(it.id) ?? [];
}

export interface NeedsExportOptions {
  project: string;
  version?: string; // default 1.0
  obsolete?: boolean; // include obsolete items (default: yes; their status says so)
  created?: Date;
  creator?: string; // Tracey's version
}

export function needsJson(index: ProjectIndex, o: NeedsExportOptions): string {
  const version = o.version || '1.0';
  const created = (o.created ?? new Date()).toISOString();
  const items = index.items.filter((i) => o.obsolete !== false || i.status !== 'obsolete');
  const keep = new Set(items);
  const needs: Record<string, Record<string, unknown>> = {};
  for (const it of items) {
    const t = typeOf(index.config, it.kind);
    const need: Record<string, unknown> = {
      id: it.id,
      type: TO_SPHINX[it.kind] ?? it.kind,
      type_name: t.name,
      title: it.title,
      status: it.status || null,
      tags: it.components,
      content: it.body.trim(),
      docname: it.path.replace(/\.md$/i, ''),
      links: [],
    };
    for (const l of linksFrom(index.config, it.kind)) need[l.key] = targets(it, l.key);
    for (const l of linksTo(index.config, it.kind))
      need[`${l.key}_back`] = sources(index, it, l.key)
        .filter((s) => keep.has(s))
        .map((s) => s.id);
    if (it.variants.length) need.variants = it.variants;
    if (it.jira.length) need.jira = it.jira;
    if (it.kind === 'requirement' && it.verification !== 'test') need.verification = it.verification;
    if (it.evidence.length) need.evidence = it.evidence;
    if (it.data.estimate != null && it.data.estimate !== '') need.estimate = String(it.data.estimate);
    for (const f of index.config.fields) if (f.kinds.includes(it.kind) && it.data[f.key] != null && it.data[f.key] !== '') need[f.key] = it.data[f.key];
    needs[it.id] = need;
  }
  const file = {
    created,
    current_version: version,
    project: o.project,
    versions: { [version]: { created, creator: { program: 'Tracey', ...(o.creator ? { version: o.creator } : {}) }, needs_amount: items.length, needs } },
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

// ---- import ------------------------------------------------------------------------------

export interface NeedsImportOptions {
  version?: string; // which version in the file (default: its current_version)
  types?: Record<string, string>; // need type → item type: { spec: requirement }
  links?: Record<string, string>; // need link field → link type: { links: refines }
  keepFields?: string[]; // other need fields to keep as they are
  existingPaths?: Set<string>; // files already in the repository
}

export interface NeedsImportReport {
  version: string;
  needs: number;
  byType: { from: string; to: string | null; count: number }[]; // to null: left out
  existing: string[]; // IDs already in the repository: left as they are
  links: Record<string, number>; // link type → links imported
  unmapped: { field: string; from: string; to: string; count: number }[]; // links with no link type for those item types
  dangling: number; // links to needs neither in the file nor in the repository
  fieldsLeftOut: Record<string, number>;
  rst: number; // needs whose text looks like reStructuredText
}

export interface NeedsImportPlan {
  files: Map<string, string>;
  report: NeedsImportReport;
}

// Sphinx-Needs' own bookkeeping: never imported, never reported.
const INTERNAL = new Set(
  'id type type_name title status tags content description links links_back docname lineno lineno_content sections section_name signature is_external is_import is_need is_part parent_need parent_needs external_url external_css parts id_complete id_parent full_title layout style template pre_template post_template hide collapse constraints constraints_passed constraints_results arch doctype content_id type_color type_style jinja_content is_modified modifications query service specific url has_dead_links has_forbidden_dead_links delete created updated'.split(
    ' ',
  ),
);
const TRACEY_FIELDS = ['variants', 'jira', 'verification', 'evidence', 'estimate'];

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => x != null && x !== '').map(String) : v == null || v === '' ? [] : [String(v)]);
const empty = (v: unknown) => v == null || v === '' || v === false || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length);

export function readNeedsFile(text: string, version?: string): { version: string; needs: Record<string, Record<string, unknown>> } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not a needs.json: ${(e as Error).message}`);
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  const versions = o.versions as Record<string, Record<string, unknown>> | undefined;
  if (!versions || typeof versions !== 'object') throw new Error('Not a needs.json: there are no versions in it.');
  const v = version ?? (typeof o.current_version === 'string' && versions[o.current_version] ? o.current_version : Object.keys(versions).pop());
  if (!v || !versions[v]) throw new Error(`There's no version ${version ?? ''} in the file; it has ${Object.keys(versions).join(', ') || 'none'}.`);
  const needs = versions[v].needs as Record<string, Record<string, unknown>> | undefined;
  if (!needs || typeof needs !== 'object') throw new Error(`Version ${v} has no needs.`);
  return { version: v, needs };
}

// The item type a need becomes: as asked, else the one its type or type name matches
// (req → requirement, test → test case, a declared type by key or name).
function itemType(config: TraceConfig, need: Record<string, unknown>, asked: Record<string, string>): string | null {
  const t = String(need.type ?? '');
  if (asked[t]) return typeKey(config.types, asked[t]);
  return FROM_SPHINX[t] ?? typeKey(config.types, t) ?? (need.type_name ? typeKey(config.types, String(need.type_name)) : null);
}

export function planNeedsImport(text: string, index: ProjectIndex, o: NeedsImportOptions = {}): NeedsImportPlan {
  const config = index.config;
  const { version, needs } = readNeedsFile(text, o.version);
  const report: NeedsImportReport = { version, needs: 0, byType: [], existing: [], links: {}, unmapped: [], dangling: 0, fieldsLeftOut: {}, rst: 0 };
  const all = Object.entries(needs).filter(([, n]) => n && typeof n === 'object');
  report.needs = all.length;

  // Which needs come in, and as what.
  const kindOf = new Map<string, Kind>();
  const byType = new Map<string, { to: string | null; count: number }>();
  for (const [key, n] of all) {
    const to = itemType(config, n, o.types ?? {});
    const from = String(n.type ?? '');
    const b = byType.get(from) ?? { to, count: 0 };
    b.count++;
    byType.set(from, b);
    if (to) kindOf.set(key, to);
  }
  report.byType = [...byType].map(([from, b]) => ({ from, ...b }));

  // Link fields: `links`, those with a _back somewhere, Tracey's, and those asked for.
  const linkFields = new Set(['links', ...config.links.map((l) => l.key), ...Object.keys(o.links ?? {})]);
  for (const [, n] of all) for (const k of Object.keys(n)) if (k.endsWith('_back') && k !== 'links_back') linkFields.add(k.slice(0, -5));
  const kindOfId = (id: string): Kind | null => kindOf.get(id) ?? index.byId.get(id)?.kind ?? null;
  const linkType = (field: string, from: Kind, to: Kind): string | null => {
    const fits = (key: string) => {
      const l = config.links.find((x) => x.key === key);
      return !!l && l.from.includes(from) && l.to.includes(to);
    };
    const asked = o.links?.[field];
    if (asked) return fits(asked) ? asked : null;
    if (fits(field)) return field;
    const candidates = config.links.filter((l) => l.from.includes(from) && l.to.includes(to));
    return candidates.length === 1 ? candidates[0].key : null;
  };

  // The items, with their links.
  const components = new Set(config.components.map((c) => c.key));
  const declared = new Set(config.fields.map((f) => f.key));
  const keepFields = new Set(o.keepFields ?? []);
  const planned = new Map<string, { kind: Kind; title: string; body: string }>();
  const front = new Map<string, Record<string, unknown>>();
  const unmapped = new Map<string, number>();
  for (const [key, n] of all) {
    const kind = kindOf.get(key);
    if (!kind) continue;
    if (index.byId.has(key)) {
      report.existing.push(key);
      continue;
    }
    const title = String(n.title ?? key);
    const body = String(n.content ?? n.description ?? '').trim();
    if (/^\.\. [\w:-]+::|^\s*:\w[\w-]*:\s|``\S/m.test(body)) report.rst++;
    planned.set(key, { kind, title, body });
    const tags = list(n.tags);
    const fields: Record<string, unknown> = {
      id: key,
      title,
      status: n.status == null || n.status === '' ? (typeOf(config, kind).statuses[0] ?? 'draft') : String(n.status),
      components: components.size ? tags.filter((t) => components.has(t)) : tags,
    };
    const lists: Record<string, string[]> = {};
    for (const field of linkFields) {
      for (const id of list(n[field])) {
        const to = kindOfId(id);
        if (!to) {
          report.dangling++;
          continue;
        }
        const lt = linkType(field, kind, to);
        if (!lt) {
          const k = `${field}\u0000${kind}\u0000${to}`;
          unmapped.set(k, (unmapped.get(k) ?? 0) + 1);
          continue;
        }
        if (!(lists[lt] ??= []).includes(id)) lists[lt].push(id);
      }
    }
    for (const l of linksFrom(config, kind)) if (lists[l.key]?.length) fields[l.key] = lists[l.key];
    for (const [k, v] of Object.entries(n)) {
      if (INTERNAL.has(k) || linkFields.has(k) || k.endsWith('_back') || empty(v)) continue;
      if (TRACEY_FIELDS.includes(k) || declared.has(k) || keepFields.has(k)) fields[k] = v;
      else report.fieldsLeftOut[k] = (report.fieldsLeftOut[k] ?? 0) + 1;
    }
    if (components.size && tags.some((t) => !components.has(t))) fields.tags = tags.filter((t) => !components.has(t));
    front.set(key, fields);
  }
  report.unmapped = [...unmapped].map(([k, count]) => {
    const [field, from, to] = k.split('\u0000');
    return { field, from, to, count };
  });

  // Links count as reviewed: they're made against the text as it is in the file.
  const fp = (id: string) => {
    const p = planned.get(id);
    const ex = index.byId.get(id);
    return p ? fingerprint(p) : ex ? fingerprint(ex) : null;
  };
  const files = new Map<string, string>();
  const taken = new Set(o.existingPaths ?? []);
  for (const [id, fields] of front) {
    const p = planned.get(id)!;
    const reviewed: Record<string, string> = {};
    for (const l of config.links)
      for (const target of (fields[l.key] as string[] | undefined) ?? []) {
        report.links[l.key] = (report.links[l.key] ?? 0) + 1;
        const f = fp(target);
        if (f) reviewed[target] = f;
      }
    if (Object.keys(reviewed).length) fields.reviewed = reviewed;
    const base = newItemPath({ ...index, byPath: new Map() }, p.kind, id, p.title).replace(/\.md$/, '');
    let path = `${base}.md`;
    for (let i = 2; taken.has(path) || index.byPath.has(path); i++) path = `${base}-${i}.md`;
    taken.add(path);
    files.set(path, `---\n${setFields(null, fields)}---\n${p.body ? `${p.body}\n` : ''}`);
  }
  return { files, report };
}

export function formatNeedsReport(r: NeedsImportReport, config: TraceConfig): string {
  const out = [`Read ${r.needs} needs (version ${r.version}).`];
  for (const b of r.byType)
    out.push(
      b.to
        ? `  ${b.from || '(no type)'} → ${typeOf(config, b.to).plural.toLowerCase()}: ${b.count}`
        : `  ${b.from || '(no type)'}: ${b.count} left out. Declare the type in trace.yml (types:), or map it with --type ${b.from || 'TYPE'}=requirement.`,
    );
  if (r.existing.length) out.push(`${r.existing.length} already in the repository, left as they are: ${r.existing.slice(0, 10).join(', ')}${r.existing.length > 10 ? '…' : ''}.`);
  const links = Object.entries(r.links);
  out.push(links.length ? `Links: ${links.map(([k, n]) => `${n} ${k}`).join(', ')}.` : 'No links.');
  for (const u of r.unmapped)
    out.push(
      `  ${u.count} ${u.field} link${u.count === 1 ? '' : 's'} from ${typeOf(config, u.from).plural.toLowerCase()} to ${typeOf(config, u.to).plural.toLowerCase()} left out: no link type fits. Map it with --link ${u.field}=LINK, or declare one under links:.`,
    );
  if (r.dangling) out.push(`  ${r.dangling} link${r.dangling === 1 ? '' : 's'} to needs neither in the file nor in the repository left out.`);
  const left = Object.entries(r.fieldsLeftOut);
  if (left.length) out.push(`Fields left out: ${left.map(([k, n]) => `${k} (${n})`).join(', ')}. Declare them under fields: in trace.yml, or keep them with --keep-fields ${left.map(([k]) => k).join(',')}.`);
  if (r.rst) out.push(`${r.rst} need${r.rst === 1 ? "'s text looks" : "s' text looks"} like reStructuredText: it's kept as written, not converted to Markdown.`);
  return out.join('\n');
}

export const needsFileName = (project: string) => `${slug(project) || 'needs'}-needs.json`;
