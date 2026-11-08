// The repository's own settings, from `trace.yml` at its root. Every key is optional.
//
//   requirements: { dir: requirements, prefix: REQ-, digits: 2 }
//   testcases:    { dir: tests,        prefix: TC-,  digits: 3 }
//   statuses: [draft, review, approved, obsolete]
//   components:
//     payments: { name: Payments, paths: ["src/payments/**"] }
//   variants:
//     pro: { name: Pro }
//   fields:
//     priority: [Low, Medium, High]
//     owner: text
//   jira: { url: https://jira.example.com }
//   types:                       item types beyond requirements and test cases
//     risk: { name: Risk, prefix: RSK-, dir: risks, statuses: [open, mitigated, closed] }
//     integration-test: { prefix: IT-, dir: integration-tests, runnable: true }
//   links:                       link types beyond verifies and refines
//     mitigates: { name: Mitigates, reverse: Mitigated by, from: requirement, to: risk }
//     verifies: { to: [requirement, architecture] }   what tests may verify, besides requirements
//   rules:                       what counts as a gap, besides requirements without tests
//     - { every: risk, needs: mitigates }
import { isMap, isScalar, parse, parseDocument, stringify } from 'yaml';

export type IssueLinkSource = 'labels' | 'field' | 'text' | 'remote-links';
export const ISSUE_LINK_SOURCES: IssueLinkSource[] = ['labels', 'field', 'text', 'remote-links'];

export interface JiraConfig {
  api: 2 | 3; // 2: Data Center / Server; 3: Cloud
  jql: string | null; // which issues to read for links (default: the projects')
  field: string | null; // a custom field (name or customfield_123) listing requirement / test case IDs
  links: IssueLinkSource[]; // where issues may name items
  max: number; // how many issues to read at most
}

// An item's type: 'requirement' and 'testcase' are built in; trace.yml can add more
// under `types:` (risk, architecture…), named by their key.
export type Kind = string;
export const BUILT_IN_KINDS = ['requirement', 'testcase'] as const;
export type BuiltInKind = (typeof BUILT_IN_KINDS)[number];

// An item type, built in or declared.
export interface TypeDef extends KindConfig {
  key: string;
  name: string; // "Risk"
  plural: string; // "Risks"
  statuses: string[];
  builtIn: boolean;
  runnable: boolean; // run in test runs, with results and estimates, and verifies things (test cases, and types declared so)
}

// A link type: items of the `from` types name items of the `to` types in a front-matter
// list named by the key (`mitigates: [RSK-1]`). verifies (test case → requirement) and
// refines (requirement → requirement) are built in, with their own meaning for coverage.
export interface LinkDef {
  key: string;
  name: string; // "Mitigates", as the linking item shows it
  reverse: string; // "Mitigated by", as the linked item shows it
  from: string[];
  to: string[];
  builtIn: boolean;
}

// What counts as a gap: every item of a type needs a link of some type, to it (in) or
// from it (out). Requirements needing test cases is built in.
export interface RuleDef {
  type: string;
  link: string;
  incoming: boolean; // true: something must link to it; false: it must link to something
  tag: string; // the gap in a word or two: "Not mitigated"
  text: string; // the gap as a sentence: "Nothing mitigates this risk."
}

export interface KindConfig {
  dir: string; // where new items of this kind go (and, when set, where they're looked for)
  prefix: string; // ID prefix, e.g. REQ-
  digits: number; // zero-padding of new IDs
}

export interface Component {
  key: string;
  name: string;
  paths: string[]; // glob patterns, relative to the repository root
}

// A product variant. Items name the variants they're limited to; none means all.
export interface Variant {
  key: string;
  name: string;
}

// A front-matter field of the repository's own (priority, owner…), editable in Tracey.
//   text: one line · number · date (2026-11-07) · list: free words
//   choice: one of `values` · choices: any of `values`
export type FieldType = 'text' | 'number' | 'date' | 'list' | 'choice' | 'choices';
export const FIELD_TYPES: FieldType[] = ['text', 'number', 'date', 'list', 'choice', 'choices'];

export interface FieldDef {
  key: string; // as written in the front matter
  name: string; // for people
  type: FieldType;
  values: string[]; // for choice and choices
  kinds: Kind[]; // which item types have it
}

// Fields Tracey has its own editor for; a declaration can't take them over.
export const BUILT_IN_FIELDS = new Set(['id', 'type', 'title', 'status', 'components', 'variants', 'jira', 'verifies', 'refines', 'verification', 'evidence', 'estimate', 'reviewed']);

export interface TraceConfig {
  requirements: KindConfig;
  testcases: KindConfig;
  statuses: string[];
  testcaseStatuses: string[];
  components: Component[];
  variants: Variant[];
  fields: FieldDef[];
  jiraUrl: string | null;
  // Jira project keys (PROJ) to look for in commit messages. Empty: those used in
  // requirements' `jira:` fields.
  jiraProjects: string[];
  jira: JiraConfig;
  // The code repository whose commit messages name Jira issues.
  code: { repository: string | null; branch: string | null; commits: number };
  runs: { dir: string };
  types: TypeDef[]; // requirement, testcase, then the declared ones in order
  links: LinkDef[]; // verifies, refines, then the declared ones
  rules: RuleDef[];
  notes: string[]; // parts of trace.yml that couldn't be used, and why
}

export const CONFIG_FILES = ['trace.yml', '.trace.yml'];

export const DEFAULT_CONFIG: TraceConfig = {
  requirements: { dir: 'requirements', prefix: 'REQ-', digits: 2 },
  testcases: { dir: 'tests', prefix: 'TC-', digits: 3 },
  statuses: ['draft', 'review', 'approved', 'obsolete'],
  testcaseStatuses: ['draft', 'ready', 'obsolete'],
  components: [],
  variants: [],
  fields: [],
  jiraUrl: null,
  jiraProjects: [],
  jira: { api: 2, jql: null, field: null, links: ISSUE_LINK_SOURCES, max: 2000 },
  code: { repository: null, branch: null, commits: 500 },
  runs: { dir: 'test-runs' },
  types: [],
  links: [],
  rules: [],
  notes: [],
};
const BUILT_IN_LINKS: readonly LinkDef[] = [
  { key: 'verifies', name: 'Verifies', reverse: 'Verified by', from: ['testcase'], to: ['requirement'], builtIn: true },
  { key: 'refines', name: 'Refines', reverse: 'Refined by', from: ['requirement'], to: ['requirement'], builtIn: true },
];
const builtInTypes = (c: Pick<TraceConfig, 'requirements' | 'testcases' | 'statuses' | 'testcaseStatuses'>): TypeDef[] => [
  { key: 'requirement', name: 'Requirement', plural: 'Requirements', statuses: c.statuses, builtIn: true, runnable: false, ...c.requirements },
  { key: 'testcase', name: 'Test case', plural: 'Test cases', statuses: c.testcaseStatuses, builtIn: true, runnable: true, ...c.testcases },
];
DEFAULT_CONFIG.types = builtInTypes(DEFAULT_CONFIG);
DEFAULT_CONFIG.links = BUILT_IN_LINKS.map((l) => ({ ...l }));

export interface ConfigResult {
  config: TraceConfig;
  error: string | null;
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const strList = (v: unknown, fallback: string[]) =>
  Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? [v] : fallback;

function kind(v: unknown, d: KindConfig): KindConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const digits = Number(o.digits);
  return {
    dir: str(o.dir, d.dir).replace(/^\.?\/+|\/+$/g, ''),
    prefix: str(o.prefix, d.prefix),
    digits: Number.isInteger(digits) && digits > 0 && digits < 10 ? digits : d.digits,
  };
}

export function parseConfig(text: string | null): ConfigResult {
  if (text == null) return { config: DEFAULT_CONFIG, error: null };
  let raw: unknown;
  try {
    raw = parse(text) ?? {};
  } catch (e) {
    return { config: DEFAULT_CONFIG, error: `trace.yml: ${(e as Error).message}` };
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const components: Component[] = [];
  const comps = o.components;
  if (comps && typeof comps === 'object') {
    for (const [key, v] of Object.entries(comps as Record<string, unknown>)) {
      if (Array.isArray(v) || typeof v === 'string') components.push({ key, name: key, paths: strList(v, []) });
      else {
        const c = (v ?? {}) as Record<string, unknown>;
        components.push({ key, name: str(c.name, key), paths: strList(c.paths, []) });
      }
    }
  }
  // variants: { pro: { name: Pro }, base: Base }  or  [base, pro]
  const variants: Variant[] = [];
  if (Array.isArray(o.variants)) for (const v of o.variants) if (v != null && String(v).trim()) variants.push({ key: String(v).trim(), name: String(v).trim() });
  if (o.variants && typeof o.variants === 'object' && !Array.isArray(o.variants))
    for (const [key, v] of Object.entries(o.variants as Record<string, unknown>))
      variants.push({ key, name: typeof v === 'string' ? v : str((v as Record<string, unknown> | null)?.name, key) });
  const jira = (o.jira && typeof o.jira === 'object' ? o.jira : {}) as Record<string, unknown>;
  const notes: string[] = [];
  const requirements = kind(o.requirements, DEFAULT_CONFIG.requirements);
  const testcases = kind(o.testcases, DEFAULT_CONFIG.testcases);
  const statuses = strList(o.statuses, DEFAULT_CONFIG.statuses);
  const testcaseStatuses = strList(o.testcaseStatuses ?? o['testcase-statuses'], DEFAULT_CONFIG.testcaseStatuses);
  const types = [...builtInTypes({ requirements, testcases, statuses, testcaseStatuses }), ...typeDefs(o.types, statuses, testcaseStatuses, notes)];
  const links = [...builtInLinks(o.links, types, notes), ...linkDefs(o.links, types, notes)];
  const linkKeys = new Set(links.map((l) => l.key));
  const fields = (o.fields && typeof o.fields === 'object' && !Array.isArray(o.fields) ? Object.entries(o.fields as Record<string, unknown>).map(([k, v]) => fieldDef(k, v, types)).filter((f): f is FieldDef => !!f) : []).filter((f) => {
    if (!linkKeys.has(f.key)) return true;
    notes.push(`The field “${f.key}” is also a link type under links:, so it's used as the link.`);
    return false;
  });
  const rules = ruleDefs(o.rules, types, links, notes);
  const code = (o.code && typeof o.code === 'object' ? o.code : {}) as Record<string, unknown>;
  const commitCount = Number(code.commits);
  return {
    config: {
      requirements,
      testcases,
      statuses,
      testcaseStatuses,
      components,
      variants,
      fields,
      jiraUrl: typeof jira.url === 'string' && jira.url ? jira.url.replace(/\/+$/, '') : null,
      jiraProjects: strList(jira.projects, []).map((p) => p.toUpperCase()),
      jira: {
        api: Number(jira.api) === 3 ? 3 : 2,
        jql: typeof jira.jql === 'string' && jira.jql.trim() ? jira.jql.trim() : null,
        field: typeof jira.field === 'string' && jira.field.trim() ? jira.field.trim() : null,
        links: jira.links === undefined ? ISSUE_LINK_SOURCES : (strList(jira.links, []).filter((l) => (ISSUE_LINK_SOURCES as string[]).includes(l)) as IssueLinkSource[]),
        max: Number.isInteger(Number(jira.max)) && Number(jira.max) > 0 ? Math.min(Number(jira.max), 10_000) : 2000,
      },
      code: {
        repository: typeof code.repository === 'string' && code.repository.trim() ? code.repository.trim() : null,
        branch: typeof code.branch === 'string' && code.branch.trim() ? code.branch.trim() : null,
        commits: Number.isInteger(commitCount) && commitCount > 0 ? Math.min(commitCount, 5000) : 500,
      },
      runs: { dir: str((o.runs as Record<string, unknown> | undefined)?.dir, 'test-runs').replace(/^\.?\/+|\/+$/g, '') },
      types,
      links,
      rules,
      notes,
    },
    error: null,
  };
}

// trace.yml with its variants replaced. Only those lines change; the rest of the file
// (comments, order, spacing) stays as written. None: the key is removed.
export function setVariants(text: string | null, variants: Variant[]): string {
  const src = text ?? SAMPLE_CONFIG;
  const block = variants.length ? `variants:\n${variants.map((v) => `  ${v.key}: { name: ${stringify(v.name || v.key, { lineWidth: 0 }).trim()} }\n`).join('')}` : '';
  const doc = parseDocument(src);
  const pair = isMap(doc.contents) ? doc.contents.items.find((p) => isScalar(p.key) && p.key.value === 'variants') : undefined;
  if (!pair || !isScalar(pair.key) || !pair.key.range) return block ? `${src}${src && !src.endsWith('\n') ? '\n' : ''}${block}` : src;
  const value = pair.value as { range?: [number, number, number] } | null;
  const from = src.lastIndexOf('\n', pair.key.range[0] - 1) + 1;
  const last = Math.max(pair.key.range[2], value?.range?.[1] ?? 0);
  // To the end of the value's last line, but not into a comment after it.
  const lineEnd = src.indexOf('\n', Math.max(from, last - 1));
  const to = lineEnd < 0 ? src.length : lineEnd + 1;
  return src.slice(0, from) + block + src.slice(to);
}

// A variant key from its name: "Pro Max" → "pro-max".
export const variantKey = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

//   priority: [Low, Medium, High]                 a choice
//   owner: text
//   safety: { name: Safety level, values: [QM, ASIL A], for: requirement }
//   platforms: { values: [Linux, Windows], multiple: true }
function fieldDef(key: string, v: unknown, types: TypeDef[]): FieldDef | null {
  if (BUILT_IN_FIELDS.has(key)) return null;
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const values = (Array.isArray(v) ? v : Array.isArray(o.values) ? o.values : []).map((x) => String(x).trim()).filter(Boolean);
  const named = typeof v === 'string' ? v.trim().toLowerCase() : typeof o.type === 'string' ? o.type.trim().toLowerCase() : '';
  let type: FieldType = (FIELD_TYPES as string[]).includes(named) ? (named as FieldType) : values.length ? 'choice' : 'text';
  if (values.length && (o.multiple === true || type === 'list')) type = 'choices';
  if ((type === 'choice' || type === 'choices') && !values.length) type = type === 'choice' ? 'text' : 'list';
  const forList = strList(o.for, []);
  const kinds = forList.length ? [...new Set(forList.map((x) => typeKey(types, x)).filter((k): k is string => !!k))] : types.map((t) => t.key);
  return { key, name: str(o.name, label(key)), type, values: type === 'choice' || type === 'choices' ? values : [], kinds: kinds.length ? kinds : types.map((t) => t.key) };
}

const label = (key: string) => key.charAt(0).toUpperCase() + key.slice(1).replace(/[-_]/g, ' ');
const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');

// A type named loosely: its key, name or plural, any case ("Test cases", "tests", "risk").
export function typeKey(types: TypeDef[], name: string): string | null {
  const n = norm(name);
  if (!n) return null;
  const hit = types.find((t) => norm(t.key) === n || norm(t.name) === n || norm(t.plural) === n);
  if (hit) return hit.key;
  if (/^tests?(cases?)?$/.test(n)) return 'testcase';
  if (/^req(uirement)?s?$/.test(n)) return 'requirement';
  return null;
}

const RESERVED = new Set(['requirement', 'testcase', 'commit', 'issue', 'component', 'item', 'req', 'test']);

//   risk: { name: Risk, plural: Risks, prefix: RSK-, dir: risks, digits: 2, statuses: [open, closed] }
function typeDefs(v: unknown, statuses: string[], testStatuses: string[], notes: string[]): TypeDef[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    if (v != null) notes.push('types: should list item types by key, like  risk: { prefix: RSK- }.');
    return [];
  }
  const out: TypeDef[] = [];
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]*$/.test(key) || RESERVED.has(key)) {
      notes.push(RESERVED.has(key) ? `types: “${key}” is built in, so it can't be declared again.` : `types: “${key}” isn't a usable key: use lower-case letters, digits and dashes.`);
      continue;
    }
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = str(o.name, label(key));
    const k = kind(o, { dir: key, prefix: `${key.slice(0, 4).toUpperCase()}-`, digits: 2 });
    const runnable = o.runnable === true;
    out.push({ key, name, plural: str(o.plural, /s$/i.test(name) ? name : `${name}s`), statuses: strList(o.statuses, runnable ? testStatuses : statuses), builtIn: false, runnable, ...k });
  }
  return out;
}

//   mitigates: { name: Mitigates, reverse: Mitigated by, from: [requirement], to: risk }
function linkDefs(v: unknown, types: TypeDef[], notes: string[]): LinkDef[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    if (v != null) notes.push('links: should list link types by key, like  mitigates: { from: requirement, to: risk }.');
    return [];
  }
  const out: LinkDef[] = [];
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) {
      notes.push(`links: “${key}” isn't a usable key: use lower-case letters, digits and dashes.`);
      continue;
    }
    if (key === 'verifies') continue; // built in; what it may link is extended in builtInLinks
    if (BUILT_IN_FIELDS.has(key)) {
      notes.push(`links: “${key}” is one of Tracey's own fields, so it can't be a link type.`);
      continue;
    }
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const resolve = (side: string) => {
      const names = strList(o[side], []);
      const keys = names.map((n) => {
        const k = typeKey(types, n);
        if (!k) notes.push(`links: ${key} names “${n}” under ${side}:, which isn't an item type.`);
        return k;
      });
      return [...new Set(keys.filter((k): k is string => !!k))];
    };
    const from = resolve('from');
    const to = resolve('to');
    if (!from.length || !to.length) {
      notes.push(`links: ${key} needs the item types it goes from and to (from: requirement, to: risk).`);
      continue;
    }
    const name = str(o.name, label(key));
    out.push({ key, name, reverse: str(o.reverse, `${name} (from)`), from, to, builtIn: false });
  }
  return out;
}

// The built-in links. Test cases and the runnable types verify; requirements, and the
// types `links: verifies: { to: […] }` adds, are verified.
function builtInLinks(v: unknown, types: TypeDef[], notes: string[]): LinkDef[] {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>).verifies : null) as Record<string, unknown> | null;
  const named = (side: string) =>
    strList(o?.[side], []).flatMap((n) => {
      const k = typeKey(types, n);
      if (!k) notes.push(`links: verifies names “${n}” under ${side}:, which isn't an item type.`);
      return k ? [k] : [];
    });
  for (const k of named('from')) if (!types.find((t) => t.key === k)?.runnable) notes.push(`links: verifies from ${k}: only runnable types verify (runnable: true on the type).`);
  const from = types.filter((t) => t.runnable).map((t) => t.key);
  const to = [...new Set(['requirement', ...named('to')])];
  return BUILT_IN_LINKS.map((l) => (l.key === 'verifies' ? { ...l, from, to } : { ...l }));
}

//   - { every: risk, needs: mitigates }                    something must mitigate each risk
//   - { every: requirement, needs: implements, tag: No design }
//   - { every: architecture, needs: implements, direction: out }   it must implement something
function ruleDefs(v: unknown, types: TypeDef[], links: LinkDef[], notes: string[]): RuleDef[] {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    notes.push('rules: should be a list, like  - { every: risk, needs: mitigates }.');
    return [];
  }
  const out: RuleDef[] = [];
  for (const raw of v) {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const type = typeKey(types, String(o.every ?? ''));
    const link = links.find((l) => l.key === String(o.needs ?? '').trim());
    if (!type || !link) {
      notes.push(`rules: “every: ${String(o.every ?? '')}, needs: ${String(o.needs ?? '')}” needs an item type and a link type.`);
      continue;
    }
    const dir = String(o.direction ?? '').toLowerCase();
    const canIn = link.to.includes(type);
    const canOut = link.from.includes(type);
    const incoming = dir === 'out' ? false : dir === 'in' ? true : canIn;
    if (incoming ? !canIn : !canOut) {
      notes.push(`rules: ${link.key} links can't ${incoming ? 'go to' : 'come from'} ${type}, so “every: ${type}, needs: ${link.key}” can never be met.`);
      continue;
    }
    const t = types.find((x) => x.key === type)!;
    const tag = str(o.tag, incoming ? `Not ${link.reverse.toLowerCase().replace(/\s+by$/, '')}` : `${link.name} nothing`);
    const text = incoming ? `Nothing ${link.name.toLowerCase()} this ${t.name.toLowerCase()}.` : `This ${t.name.toLowerCase()} ${link.name.toLowerCase()} nothing.`;
    out.push({ type, link: link.key, incoming, tag, text: str(o.text, text) });
  }
  return out;
}

export const fieldsFor = (config: TraceConfig, k: Kind) => config.fields.filter((f) => f.kinds.includes(k));

// An item type's settings; one the config doesn't know gets the requirements' statuses.
export function typeOf(config: TraceConfig, k: Kind): TypeDef {
  return config.types.find((t) => t.key === k) ?? { key: k, name: label(k), plural: `${label(k)}s`, statuses: config.statuses, builtIn: false, runnable: false, dir: '', prefix: '', digits: 2 };
}

const verifiesDef = (config: TraceConfig) => config.links.find((l) => l.key === 'verifies');
// Run in test runs (test cases, and types declared runnable); they verify.
export const isRunnable = (config: TraceConfig, k: Kind) => typeOf(config, k).runnable;
// What test cases (and other runnable types) can verify: requirements, and types added to verifies.
export const isVerifiable = (config: TraceConfig, k: Kind) => verifiesDef(config)?.to.includes(k) ?? k === 'requirement';

export const statusesFor = (config: TraceConfig, k: Kind): string[] => typeOf(config, k).statuses;
export const typeName = (config: TraceConfig, k: Kind) => typeOf(config, k).name;
export const typePlural = (config: TraceConfig, k: Kind) => typeOf(config, k).plural;
// "requirement", "test case", "risk": inside a sentence.
export const typeWord = (config: TraceConfig, k: Kind) => typeOf(config, k).name.toLowerCase();

// The link types an item of a type can have, and those that can point at it.
export const linksFrom = (config: TraceConfig, k: Kind) => config.links.filter((l) => l.from.includes(k));
export const linksTo = (config: TraceConfig, k: Kind) => config.links.filter((l) => l.to.includes(k));
export const customLinks = (config: TraceConfig) => config.links.filter((l) => !l.builtIn);
export const customTypes = (config: TraceConfig) => config.types.filter((t) => !t.builtIn);

// The starting trace.yml for a new project.
export const SAMPLE_CONFIG = `# Tracey settings. See README for every option.
requirements:
  dir: requirements
  prefix: REQ-
  digits: 2
testcases:
  dir: tests
  prefix: TC-
  digits: 3
statuses: [draft, review, approved, obsolete]
testcaseStatuses: [draft, ready, obsolete]
# Components: path patterns into the code, so changed files map to test cases.
components:
  payments:
    name: Payments
    paths: ["src/payments/**"]
# Product variants. An item limited to some says so (variants: [pro]); one that
# doesn't say applies to all of them.
# variants:
#   base: { name: Base }
#   pro: { name: Pro }
# Fields of your own, editable in Tracey (others in the files are shown read-only):
# fields:
#   priority: [Low, Medium, High]                     # one of these
#   owner: text                                       # also: number, date, list
#   platforms: { values: [Linux, Windows], multiple: true }
#   safety: { name: Safety level, values: [QM, ASIL A, ASIL B], for: requirement }
# jira:
#   url: https://jira.example.com
#   api: 2               # 2: Data Center / Server (personal access token); 3: Cloud
#   projects: [PROJ]     # keys to look for in commit messages, and issues to read
#   field: Requirements  # a custom field on issues listing REQ-/TC- IDs (name or customfield_12345)
#   links: [labels, field, text, remote-links]   # where issues may name requirements and test cases
#   jql: project = PROJ AND updated >= -365d      # which issues to read (default: the projects')
# The code repository: its commit messages name Jira issues (PROJ-466), which links
# commits to the requirements naming those issues, and on to their test cases.
# code:
#   repository: https://bitbucket.example.com/scm/proj/app.git
#   branch: main
#   commits: 500         # how far back to look
`;
