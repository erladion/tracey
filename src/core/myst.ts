// Sphinx-Needs in MyST Markdown: needs read where they are written, and changes written
// back into them.
//
//   ```{req} Retry failed payments
//   :id: REQ_001
//   :status: open
//   :tags: payments
//   :links: REQ_000
//
//   Text, in MyST Markdown.
//   ```
//
// (also :::{req} with the colon_fence extension, and options as a --- YAML block).
//
// The rest of Tracey sees each need as a file of its own: `docs/reqs.md#REQ_001`, with
// front matter made from the directive (title from its argument, links from :links: and
// the other link options) and the directive's text as the body. Writing that "file"
// rewrites only the directive, in place; the rest of the MyST file stays as written.
import { Document, parseDocument } from 'yaml';
import { outsideType, typeKey, type Kind, type LinkDef, type TraceConfig, type TypeDef } from './config';
import { readFrontMatter, splitFrontMatter } from './frontmatter';

// ---- virtual paths ------------------------------------------------------------------

// docs/reqs.md#REQ_001; a second need with the same ID in the file: #REQ_001~2; a need
// without an ID: #@3 (the third need in the file).
export interface NeedKey {
  file: string;
  id: string; // '' : by position
  n: number; // which need with that ID (1: the first), or the position when id is ''
}

const NEED_PATH = /^(.+\.md)#([^/#]+)$/i;
export const isNeedPath = (path: string) => NEED_PATH.test(path);
export const needFile = (path: string) => NEED_PATH.exec(path)?.[1] ?? path;

export function splitNeedPath(path: string): NeedKey | null {
  const m = NEED_PATH.exec(path);
  if (!m) return null;
  const at = /^@(\d+)$/.exec(m[2]);
  if (at) return { file: m[1], id: '', n: Number(at[1]) };
  const dup = /^(.*)~(\d+)$/.exec(m[2]);
  return dup ? { file: m[1], id: dup[1], n: Number(dup[2]) } : { file: m[1], id: m[2], n: 1 };
}

export const needPath = (file: string, id: string, n = 1) => `${file}#${id ? (n > 1 ? `${id}~${n}` : id) : `@${n}`}`;

// ---- reading directives ---------------------------------------------------------------

export interface Need {
  name: string; // the directive: req
  title: string; // its argument
  options: [string, string | null][]; // as written, in order; null: a flag (:hide:)
  yamlOptions: boolean; // options in a --- block
  body: string; // the text, without the blank line after the options and trailing blank lines
  indent: string;
  fence: string; // ``` or :::: as written
  start: number; // offset of the opening line
  end: number; // offset after the closing line (and its newline)
  bodyLine: number; // the body's first line in the file (0-based)
  id: string;
}

// Sphinx-Needs' own types, and what a project usually adds; conf.py's needs_types add more.
export const NEED_DIRECTIVES = ['req', 'spec', 'impl', 'test', 'need'];
// Directives whose text is code, not Markdown: needs inside them are examples.
const LITERAL = new Set(['code', 'code-block', 'sourcecode', 'code-cell', 'literalinclude', 'math', 'raw', 'eval-rst', 'mermaid', 'graphviz', 'plantuml', 'uml', 'csv-table', 'list-table']);

const OPEN = /^( {0,3})(`{3,}|~{3,}|:{3,})\{([A-Za-z][\w:.-]*)\}[ \t]*(.*?)[ \t]*$/;
const CODE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const closes = (line: string, fence: string) => {
  const m = /^ {0,3}(`+|~+|:+)[ \t]*$/.exec(line);
  return !!m && m[1][0] === fence[0] && m[1].length >= fence.length;
};

export function parseNeeds(text: string, isNeed: (directive: string) => boolean): Need[] {
  const lines = text.split('\n');
  const offsets: number[] = [];
  let at = 0;
  for (const l of lines) {
    offsets.push(at);
    at += l.length + 1;
  }
  const offset = (i: number) => (i < lines.length ? offsets[i] : text.length);
  const needs: Need[] = [];
  const open: string[] = []; // fences of the directives around this line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open.length && closes(line, open[open.length - 1])) {
      open.pop();
      continue;
    }
    const m = OPEN.exec(line);
    if (m && isNeed(m[3])) {
      const need = readNeed(lines, i, m, offset);
      needs.push(need.need);
      i = need.last;
      continue;
    }
    if (m && !(m[2][0] !== ':' && LITERAL.has(m[3]))) {
      open.push(m[2]); // a directive holding Markdown: look inside
      continue;
    }
    const code = m ? [m[0], m[1], m[2]] : CODE.exec(line);
    if (code && !(code[2][0] === '`' && code[0].slice(code[1].length + code[2].length).includes('`'))) {
      let j = i + 1;
      while (j < lines.length && !closes(lines[j], code[2])) j++;
      i = j;
    }
  }
  return needs;
}

function readNeed(lines: string[], first: number, m: RegExpExecArray, offset: (i: number) => number): { need: Need; last: number } {
  const [, indent, fence, name, title] = m;
  // The closing fence; in a colon fence, not one inside a code block.
  let end = first + 1;
  let code: string | null = null;
  for (; end < lines.length; end++) {
    const l = lines[end];
    if (code) {
      if (closes(l, code)) code = null;
      continue;
    }
    if (closes(l, fence)) break;
    const c = fence[0] === ':' ? CODE.exec(l) : null;
    if (c) code = c[2];
  }
  let i = first + 1;
  const options: [string, string | null][] = [];
  let yamlOptions = false;
  if (i < end && /^ {0,3}---[ \t]*$/.test(lines[i])) {
    const close = lines.slice(i + 1, end).findIndex((l) => /^ {0,3}---[ \t]*$/.test(l));
    if (close >= 0) {
      yamlOptions = true;
      const data = parseDocument(lines.slice(i + 1, i + 1 + close).join('\n')).toJS() as Record<string, unknown> | null;
      for (const [k, v] of Object.entries(data && typeof data === 'object' ? data : {}))
        options.push([k, v == null ? null : Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)]);
      i += close + 2;
    }
  } else {
    for (; i < end; i++) {
      const o = /^\s*:([\w.-]+):(?:[ \t]+(.*?))?[ \t]*$/.exec(lines[i]);
      if (!o) break;
      options.push([o[1], o[2] == null || o[2] === '' ? null : o[2]]);
    }
  }
  if (i < end && !lines[i].trim()) i++;
  let last = end;
  while (last > i && !lines[last - 1].trim()) last--;
  const id = options.find(([k]) => k === 'id')?.[1] ?? '';
  return {
    need: {
      name,
      title,
      options,
      yamlOptions,
      body: lines.slice(i, last).join('\n'),
      indent,
      fence,
      start: offset(first),
      end: offset(end + 1),
      bodyLine: i,
      id: id.trim(),
    },
    last: end,
  };
}

// Whether a file may hold needs at all: a directive fence anywhere.
export const mayHoldNeeds = (text: string) => /^ {0,3}(`{3,}|~{3,}|:{3,})\{/m.test(text);

// ---- conf.py --------------------------------------------------------------------------

export interface SphinxDeclared {
  usesNeeds: boolean; // sphinx_needs among the extensions
  directives: { directive: string; title: string; prefix: string }[]; // needs_types
  links: string[]; // needs_extra_links' options (and needs_links' keys)
  options: string[]; // needs_extra_options (and needs_fields' keys)
  idRegex: string | null;
  complete: boolean; // false: options come from elsewhere too (needs_from_toml), so don't warn
}

// Sphinx-Needs' own types, for a conf.py without needs_types.
const DEFAULT_TYPES = [
  { directive: 'req', title: 'Requirement', prefix: 'R_' },
  { directive: 'spec', title: 'Specification', prefix: 'S_' },
  { directive: 'impl', title: 'Implementation', prefix: 'I_' },
  { directive: 'test', title: 'Test Case', prefix: 'T_' },
];

// What Sphinx-Needs takes without being told.
export const STANDARD_OPTIONS = new Set(
  'id status tags links collapse delete jinja_content hide title_from_content style layout template pre_template post_template constraints duration completion'.split(' '),
);

// The text of `name = [ … ]` or `name = { … }`, brackets balanced.
function assigned(text: string, name: string): string | null {
  const m = new RegExp(`^\\s*${name}\\s*(?::[^=\\n]*)?=\\s*([[{(])`, 'm').exec(text);
  if (!m) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = m.index + m[0].length - 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') i = text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i);
    else if ('[{('.includes(c)) depth++;
    else if (']})'.includes(c) && --depth === 0) return text.slice(m.index + m[0].length - 1, i + 1);
  }
  return null;
}

const strings = (s: string) => [...s.matchAll(/["']([^"'\n]+)["']/g)].map((m) => m[1]);
const valueOf = (dict: string, key: string) => new RegExp(`["']${key}["']\\s*:\\s*["']([^"'\\n]*)["']`).exec(dict)?.[1] ?? null;
const dicts = (s: string) => [...s.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]);
const topKeys = (s: string) => [...s.matchAll(/(?:^|[{,]\s*)["']([\w-]+)["']\s*:\s*\{/gm)].map((m) => m[1]);

export function readConfPy(text: string | null): SphinxDeclared | null {
  if (text == null) return null;
  const types = assigned(text, 'needs_types');
  const links = assigned(text, 'needs_extra_links');
  const newLinks = assigned(text, 'needs_links');
  const options = assigned(text, 'needs_extra_options');
  const fields = assigned(text, 'needs_fields');
  const id = /^\s*needs_id_regex\s*=\s*r?(["'])(.*?)\1/m.exec(text);
  const fromToml = /^\s*needs_from_toml\s*=/m.test(text);
  return {
    usesNeeds: /["']sphinx_needs["']/.test(text),
    directives: types
      ? dicts(types).flatMap((d) => (valueOf(d, 'directive') ? [{ directive: valueOf(d, 'directive')!, title: valueOf(d, 'title') ?? '', prefix: valueOf(d, 'prefix') ?? '' }] : []))
      : fromToml
        ? []
        : DEFAULT_TYPES,
    links: [...(links ? dicts(links).flatMap((d) => valueOf(d, 'option') ?? []) : []), ...(newLinks ? topKeys(newLinks) : [])],
    options: [...(options ? (options.includes('{') ? dicts(options).flatMap((d) => valueOf(d, 'name') ?? []) : strings(options)) : []), ...(fields ? topKeys(fields) : [])],
    idRegex: id ? id[2] : null,
    complete: !fromToml,
  };
}

// The ID pattern Sphinx-Needs checks (its default unless conf.py sets one).
export function idPatternOf(declared: SphinxDeclared | null): RegExp {
  const src = declared?.idRegex ?? '^[A-Z0-9_]{5,}';
  try {
    return new RegExp(src);
  } catch {
    return /^[A-Z0-9_]{5,}/;
  }
}

// ---- needs ↔ Tracey -------------------------------------------------------------------

export interface NeedContext {
  config: TraceConfig;
  declared: SphinxDeclared | null;
  kindOfId: (id: string) => Kind | null; // any item's type, needs or not; null: unknown
}

// The item type a directive is: as trace.yml maps it, req and test, or a type's own key.
export function kindOfDirective(config: TraceConfig, directive: string): Kind | null {
  const mapped = config.sphinx?.types[directive] ?? config.sphinx?.reads[directive];
  if (mapped) return mapped;
  if (directive === 'req') return 'requirement';
  if (directive === 'test') return 'testcase';
  return config.types.find((t) => !t.builtIn && t.key === directive)?.key ?? null;
}

// An ID's item type by its prefix (the longest that fits): for IDs not read yet, like
// one just renamed.
export function kindByPrefix(config: TraceConfig, id: string): Kind | null {
  return config.types.filter((t) => t.prefix && id.startsWith(t.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0]?.key ?? null;
}

// The directive for a new need of a type.
export function directiveOf(config: TraceConfig, kind: Kind): string {
  const mapped = Object.entries(config.sphinx?.types ?? {}).find(([, k]) => k === kind)?.[0];
  return mapped ?? (kind === 'requirement' ? 'req' : kind === 'testcase' ? 'test' : kind);
}

// A need as seen when the project is read: enough to settle the types conf.py declares.
export interface NeedSeen {
  directive: string;
  id: string;
  status: string | null;
}

// The prefix and digits most of the IDs have (`REQ_` and 3 for REQ_001), else the fallback.
function idShape(ids: string[], prefix: string): { prefix: string; digits: number } {
  const parts = ids.map((id) => /^(.*?)(\d+)$/.exec(id)).filter((m): m is RegExpExecArray => !!m);
  const most = <T>(xs: T[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<T, number>())].sort((a, b) => b[1] - a[1])[0]?.[0];
  const p = most(parts.map((m) => m[1])) ?? prefix;
  return { prefix: p, digits: most(parts.filter((m) => m[1] === p).map((m) => m[2].length)) ?? 3 };
}

// The settings with the types conf.py declares that trace.yml neither maps nor declares.
// One titled like an item type is read as it ({tc} "Test Case" as test cases), and new
// ones written as it unless that type's own directive is declared too; any other is an item type of its own, keyed by its
// directive and named by its title, with the prefix and digits its needs' IDs have (else
// conf.py's prefix) and the statuses they use (else the requirements').
export function withSphinxTypes(config: TraceConfig, declared: SphinxDeclared | null, seen: NeedSeen[]): TraceConfig {
  if (!config.sphinx || !declared) return config;
  const directives = new Set(declared.directives.map((d) => d.directive));
  const types: TypeDef[] = [];
  const mapped: Record<string, Kind> = {};
  const reads: Record<string, Kind> = {};
  for (const d of declared.directives) {
    if (kindOfDirective(config, d.directive) || types.some((t) => t.key === d.directive)) continue;
    const like = typeKey(config.types, d.title) ?? typeKey(config.types, d.directive);
    if (like) {
      (directives.has(directiveOf(config, like)) ? reads : mapped)[d.directive] = like;
      continue;
    }
    const needs = seen.filter((n) => n.directive === d.directive);
    const statuses = [...new Set(needs.map((n) => n.status).filter((x): x is string => !!x))];
    const t = outsideType(d.directive, {
      name: d.title,
      ...idShape(needs.map((n) => n.id).filter(Boolean), d.prefix || `${d.directive.toUpperCase()}_`),
      statuses: statuses.length ? statuses : config.statuses,
    });
    if (t) types.push(t);
  }
  if (!types.length && !Object.keys(mapped).length && !Object.keys(reads).length) return config;
  return {
    ...config,
    types: [...config.types, ...types],
    sphinx: { ...config.sphinx, types: { ...config.sphinx.types, ...mapped }, reads: { ...config.sphinx.reads, ...reads } },
  };
}

// What withSphinxTypes needs to know of a need file's needs.
export const needsSeen = (files: NeedFile[]): NeedSeen[] =>
  files.flatMap((f) => f.needs.map((n) => ({ directive: n.name, id: n.id, status: n.options.find(([k]) => k === 'status')?.[1] ?? null })));

// Which directives are needs: those that are item types, Sphinx-Needs' own, and conf.py's.
export function needDirectives(config: TraceConfig, declared: SphinxDeclared | null): Set<string> {
  return new Set([
    ...NEED_DIRECTIVES,
    ...Object.keys(config.sphinx?.types ?? {}),
    ...Object.keys(config.sphinx?.reads ?? {}),
    ...config.types.filter((t) => !t.builtIn).map((t) => t.key),
    ...(declared?.directives.map((d) => d.directive) ?? []),
  ]);
}

const split = (v: string | null) => (v ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
const splitIds = (v: string | null) => (v ?? '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);

// Options that hold need IDs: `links`, the link types, and those trace.yml or conf.py name.
function isLinkOption(ctx: NeedContext, option: string): boolean {
  return option === 'links' || option in (ctx.config.sphinx?.links ?? {}) || ctx.config.links.some((l) => l.key === option) || !!ctx.declared?.links.includes(option);
}

const fits = (l: LinkDef, from: Kind, to: Kind) => l.from.includes(from) && l.to.includes(to);

// The link type a link option means here: as trace.yml maps it, the link type of that
// name, or (`links` and other generic ones) the one link type joining the two types.
// null: none, so it stays as written.
function linkTypeOf(ctx: NeedContext, option: string, from: Kind, target: string): string | null {
  const mapped = ctx.config.sphinx?.links[option];
  if (mapped) return mapped;
  if (ctx.config.links.some((l) => l.key === option)) return option;
  const to = ctx.kindOfId(target);
  if (!to) return null;
  const candidates = ctx.config.links.filter((l) => fits(l, from, to));
  return candidates.length === 1 ? candidates[0].key : null;
}

// The option a new link of a type is written under: as trace.yml maps it, the link
// type's name when conf.py declares it, `links` when that reads back as the same link
// type, else the link type's name.
function optionFor(ctx: NeedContext, link: string, from: Kind, target: string): string {
  const mapped = Object.entries(ctx.config.sphinx?.links ?? {}).find(([, l]) => l === link)?.[0];
  if (mapped) return mapped;
  if (ctx.declared?.links.includes(link)) return link;
  if (linkTypeOf(ctx, 'links', from, target) === link) return 'links';
  return link;
}

// Fields whose values are lists, written comma-separated.
function listFields(config: TraceConfig): Set<string> {
  return new Set(['components', 'tags', 'variants', 'jira', 'evidence', ...config.fields.filter((f) => f.type === 'list' || f.type === 'choices').map((f) => f.key)]);
}

// A need as the front matter and body Tracey reads.
export function needToItemText(need: Need, ctx: NeedContext): string {
  const { config } = ctx;
  const kind = kindOfDirective(config, need.name);
  const lists = listFields(config);
  const components = new Set(config.components.map((c) => c.key));
  const front: Record<string, unknown> = {};
  if (need.id) front.id = need.id;
  front.type = kind ?? need.name;
  front.title = need.title;
  const links: Record<string, string[]> = {};
  const add = (key: string, ids: string[]) => {
    const list = (front[key] ??= []) as string[];
    for (const id of ids) if (!list.includes(id)) list.push(id);
  };
  for (const [key, value] of need.options) {
    if (key === 'id' || key === 'type' || key === 'title') continue;
    if (key === 'tags') {
      const tags = split(value);
      if (components.size) {
        add('components', tags.filter((t) => components.has(t)));
        if (tags.some((t) => !components.has(t))) add('tags', tags.filter((t) => !components.has(t)));
      } else add('tags', tags);
    } else if (kind && isLinkOption(ctx, key)) {
      const raw: string[] = [];
      for (const id of splitIds(value)) {
        const link = linkTypeOf(ctx, key, kind, id);
        if (!link) raw.push(id);
        else if (!(links[link] ??= []).includes(id)) links[link].push(id);
      }
      for (const [link, ids] of Object.entries(links)) if (!(link in front)) front[link] = ids;
      add(key, raw);
      if (!(front[key] as string[]).length) delete front[key];
    } else if (key === 'reviewed') {
      const map: Record<string, string> = {};
      for (const pair of split(value)) {
        const [id, fp] = pair.split('=').map((s) => s.trim());
        if (id && fp) map[id] = fp;
      }
      front.reviewed = map;
    } else if (lists.has(key)) add(key, split(value));
    else front[key] = value;
  }
  for (const [link, ids] of Object.entries(links)) front[link] = ids;
  const doc = new Document(front);
  for (const pair of (doc.contents as { items: { value: { flow?: boolean; items?: unknown[] } | null }[] }).items)
    if (pair.value && Array.isArray(pair.value.items) && pair.value.items.length && !('key' in (pair.value.items[0] as object))) pair.value.flow = true;
  const yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false, nullStr: '' }).replace(/:[ \t]+$/gm, ':');
  return `---\n${yaml}---\n${need.body ? `${need.body}\n` : ''}`;
}

// The directive for an item's text: changed in place from `old` when there is one, so
// options keep their order, links their option, and the fence its style.
export function itemTextToNeed(text: string, old: Need | null, ctx: NeedContext, style: { fence: string } = { fence: '```' }): string {
  const { config } = ctx;
  const { front, body } = splitFrontMatter(text);
  const { data, error } = readFrontMatter(front);
  if (error) throw new Error(`The front matter can't be read: ${error}`);
  const typed = String(data.type ?? '');
  const kind = typeKey(config.types, typed) ?? (old ? kindOfDirective(config, old.name) : typed ? null : kindByPrefix(config, String(data.id ?? '')));
  const name = old && kindOfDirective(config, old.name) === kind ? old.name : kind ? directiveOf(config, kind) : typed || old?.name || 'need';
  const title = String(data.title ?? '').replace(/\s*\n\s*/g, ' ').trim();
  const lists = listFields(config);
  const linkKeys = new Set(config.links.map((l) => l.key));

  // Each option's value, by name.
  const values = new Map<string, string | null>();
  const put = (key: string, ids: string[]) => {
    if (!ids.length) return;
    const was = values.get(key);
    const all = [...split(was ?? null), ...ids.filter((i) => !split(was ?? null).includes(i))];
    values.set(key, all.join(', '));
  };
  const oldOption = new Map<string, string>(); // target → the link option it was under
  if (old) for (const [k, v] of old.options) if (isLinkOption(ctx, k)) for (const id of splitIds(v)) if (!oldOption.has(id)) oldOption.set(id, k);
  const scalar = (v: unknown) => (v == null ? null : Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v).replace(/\s*\n\s*/g, ' '));
  for (const [key, v] of Object.entries(data)) {
    if (key === 'type' || key === 'title') continue;
    if (key === 'components' || key === 'tags') {
      const had = split(values.get('tags') ?? null);
      values.set('tags', [...had, ...(Array.isArray(v) ? v.map(String) : split(scalar(v))).filter((t) => !had.includes(t))].join(', '));
      if (!values.get('tags')) values.delete('tags');
    } else if (linkKeys.has(key) && kind) {
      for (const id of Array.isArray(v) ? v.map(String) : splitIds(scalar(v))) put(oldOption.get(id) ?? optionFor(ctx, key, kind, id), [id]);
    } else if (key === 'reviewed' && v && typeof v === 'object' && !Array.isArray(v)) {
      const pairs = Object.entries(v as Record<string, unknown>).map(([id, fp]) => `${id}=${String(fp)}`);
      if (pairs.length) values.set('reviewed', pairs.join(', '));
    } else if (isLinkOption(ctx, key) && Array.isArray(v)) put(key, v.map(String));
    else if (Array.isArray(v) || lists.has(key)) {
      const s = scalar(v);
      if (s) values.set(key, s);
    } else values.set(key, scalar(v));
  }
  if (values.get('id') == null) values.delete('id');
  // Links keep their order within an option; new ones go after.
  for (const [k, v] of old?.options ?? []) {
    const now = values.get(k);
    if (!now || !isLinkOption(ctx, k)) continue;
    const was = splitIds(v);
    const ids = split(now);
    values.set(k, [...was.filter((i) => ids.includes(i)), ...ids.filter((i) => !was.includes(i))].join(', '));
  }

  // Old options first, in their order; then the new ones, id and status leading.
  const order: string[] = [];
  for (const [k] of old?.options ?? []) if (values.has(k) && !order.includes(k)) order.push(k);
  for (const k of ['id', 'status', ...values.keys()]) if (values.has(k) && !order.includes(k)) order.push(k);

  const indent = old?.indent ?? '';
  let options: string;
  if (old?.yamlOptions) {
    const doc = new Document(Object.fromEntries(order.map((k) => [k, values.get(k)])));
    options = order.length ? `---\n${doc.toString({ lineWidth: 0, nullStr: '' }).replace(/:[ \t]+$/gm, ':')}---\n` : '';
  } else options = order.map((k) => (values.get(k) == null ? `:${k}:\n` : `:${k}: ${values.get(k)}\n`)).join('');
  const content = body.replace(/^\s*\n/, '').trimEnd();
  // A fence longer than any in the text, so the text can't close it.
  const base = old?.fence ?? style.fence;
  const ch = base[0];
  let longest = 0;
  for (const m of content.matchAll(new RegExp(`^ {0,3}(\\${ch}{3,})`, 'gm'))) longest = Math.max(longest, m[1].length);
  const fence = ch.repeat(Math.max(base.length, longest + 1));
  return `${indent}${fence}{${name}}${title ? ` ${title}` : ''}\n${options}${content ? `${options ? '\n' : ''}${content}\n` : ''}${indent}${fence}\n`;
}

// ---- files ------------------------------------------------------------------------------

export interface NeedFile {
  path: string;
  needs: Need[];
}

export function readNeedFile(path: string, text: string, config: TraceConfig, declared: SphinxDeclared | null): NeedFile {
  const directives = needDirectives(config, declared);
  return { path, needs: mayHoldNeeds(text) ? parseNeeds(text, (d) => directives.has(d)) : [] };
}

// Each need's virtual path in its file.
export function needPaths(file: NeedFile): string[] {
  const seen = new Map<string, number>();
  let n = 0;
  return file.needs.map((need) => {
    n++;
    if (!need.id) return needPath(file.path, '', n);
    const k = (seen.get(need.id) ?? 0) + 1;
    seen.set(need.id, k);
    return needPath(file.path, need.id, k);
  });
}

function findNeed(file: NeedFile, key: NeedKey): Need | null {
  const paths = needPaths(file);
  const i = paths.indexOf(needPath(key.file, key.id, key.n));
  return i < 0 ? null : file.needs[i];
}

// Every need in the files as an item's text, by virtual path. kindOf: other items' types.
export function explodeNeeds(files: NeedFile[], config: TraceConfig, declared: SphinxDeclared | null, kindOf: (id: string) => Kind | null = () => null): { path: string; text: string }[] {
  const kinds = new Map<string, Kind | null>();
  for (const f of files) for (const n of f.needs) if (n.id && !kinds.has(n.id)) kinds.set(n.id, kindOfDirective(config, n.name));
  const ctx: NeedContext = { config, declared, kindOfId: (id) => (kinds.has(id) ? kinds.get(id)! : (kindOf(id) ?? kindByPrefix(config, id))) };
  return files.flatMap((f) => {
    const paths = needPaths(f);
    return f.needs.map((n, i) => ({ path: paths[i], text: needToItemText(n, ctx) }));
  });
}

// One need as an item's text; null when it isn't in the file.
export function needText(file: NeedFile, key: NeedKey, ctx: NeedContext): string | null {
  const n = findNeed(file, key);
  return n ? needToItemText(n, ctx) : null;
}

// The file with a need's item text written into it: in place of the need the path names
// (or, its ID changed meanwhile, the one need with the text's ID), else added at the end.
export function writeNeed(fileText: string, key: NeedKey, itemText: string, ctx: NeedContext, heading: string): string {
  const file = readNeedFile(key.file, fileText, ctx.config, ctx.declared);
  let old = findNeed(file, key);
  if (!old) {
    const id = String(readFrontMatter(splitFrontMatter(itemText).front).data.id ?? '').trim();
    const same = id ? file.needs.filter((n) => n.id === id) : [];
    if (same.length > 1) throw new Error(`${key.file} has ${id} ${same.length} times: reload, then try again.`);
    old = same[0] ?? null;
  }
  const fence = file.needs[0]?.fence ?? '```';
  const directive = itemTextToNeed(itemText, old, ctx, { fence: fence.length > 3 && fence[0] === ':' ? ':::' : fence.slice(0, 3) });
  if (old) return fileText.slice(0, old.start) + directive + fileText.slice(old.end);
  const before = fileText.replace(/\s+$/, '');
  return before ? `${before}\n\n${directive}` : `# ${heading}\n\n${directive}`;
}

// The file without the need; blank lines around it close up.
export function removeNeed(fileText: string, key: NeedKey, config: TraceConfig, declared: SphinxDeclared | null): string {
  const need = findNeed(readNeedFile(key.file, fileText, config, declared), key);
  if (!need) return fileText;
  const before = fileText.slice(0, need.start).replace(/\n+$/, '\n');
  const after = fileText.slice(need.end).replace(/^\n+/, '');
  return before.trim() && after ? `${before}\n${after}` : before + after;
}

// The file with its needs taken out: what's left is the page around them.
export const withoutNeeds = (text: string, file: NeedFile) => file.needs.reduceRight((t, n) => t.slice(0, n.start) + t.slice(n.end), text);

// Which options a need's item text is written with, for checking them against conf.py.
export function optionsOf(itemText: string, ctx: NeedContext): string[] {
  const d = itemTextToNeed(itemText, null, ctx);
  return [...d.matchAll(/^:([\w.-]+):/gm)].map((m) => m[1]);
}

// trace.yml for a Sphinx-Needs project opened without one: where its MyST files are,
// and the ID prefixes and statuses its needs use.
export function sphinxConfigText(dir: string, files: NeedFile[], config: TraceConfig, declared: SphinxDeclared | null): string {
  const by = new Map<Kind, Need[]>();
  for (const f of files) for (const n of f.needs) {
    const k = kindOfDirective(config, n.name);
    if (k) (by.get(k) ?? by.set(k, []).get(k)!).push(n);
  }
  const lines = ['# Made by Tracey from the Sphinx-Needs project it found. See README for every option.'];
  const kindBlock = (kind: Kind, key: string) => {
    const fallback = declared?.directives.find((d) => d.directive === directiveOf(config, kind))?.prefix || (kind === 'requirement' ? 'REQ_' : 'TC_');
    const { prefix, digits } = idShape((by.get(kind) ?? []).map((n) => n.id), fallback);
    lines.push(`${key}: { prefix: ${JSON.stringify(prefix)}, digits: ${digits} }`);
  };
  kindBlock('requirement', 'requirements');
  kindBlock('testcase', 'testcases');
  const statuses = (kind: Kind) => [...new Set((by.get(kind) ?? []).map((n) => n.options.find(([k]) => k === 'status')?.[1]).filter((s): s is string => !!s))];
  if (statuses('requirement').length) lines.push(`statuses: [${statuses('requirement').join(', ')}]`);
  if (statuses('testcase').length) lines.push(`testcaseStatuses: [${statuses('testcase').join(', ')}]`);
  lines.push('sphinx-needs:', `  dir: ${dir || '.'}`);
  return `${lines.join('\n')}\n`;
}
