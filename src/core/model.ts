// Requirements and test cases, read from the repository's Markdown files, and the
// links between them. Pure: used by the app (live, as you type) and by `check` in CI.
//
// A file is an item when its front matter has an `id` whose prefix is a configured
// one (REQ-, TC-), or a `type: requirement | testcase`. IDs are never derived from
// file names, so files can be renamed or moved freely.
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
  jira: string[];
  verifies: string[]; // test cases: the requirements they verify
  // Test cases: per verified requirement, the fingerprint of its text when the link
  // was last reviewed. A different fingerprint now makes the link suspect.
  reviewed: Record<string, string>;
  path: string;
  front: string | null;
  body: string;
  data: Record<string, unknown>;
}

export type Severity = 'error' | 'warning';

export interface Problem {
  severity: Severity;
  code: 'config' | 'yaml' | 'no-id' | 'duplicate-id' | 'missing-title' | 'bad-status' | 'broken-link' | 'link-to-testcase' | 'unknown-component';
  message: string;
  path?: string;
  id?: string;
}

export type LinkState = 'ok' | 'suspect' | 'unreviewed';

export interface Link {
  test: Item;
  req: Item;
  state: LinkState;
}

export interface ProjectIndex {
  config: TraceConfig;
  items: Item[];
  byId: Map<string, Item>; // the first item with each ID
  byPath: Map<string, Item>;
  verifiedBy: Map<string, Item[]>; // requirement ID → test cases verifying it
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
      jira: list(data.jira),
      verifies: kind === 'testcase' ? list(data.verifies) : [],
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
  const componentKeys = new Set(config.components.map((c) => c.key));
  for (const it of items) {
    if (!it.title.trim()) problems.push({ severity: 'warning', code: 'missing-title', message: `${it.id} has no title.`, path: it.path, id: it.id });
    const statuses = statusesFor(config, it.kind);
    if (it.status && !statuses.includes(it.status))
      problems.push({ severity: 'warning', code: 'bad-status', message: `${it.id} has status “${it.status}”, which isn't one of: ${statuses.join(', ')}.`, path: it.path, id: it.id });
    if (componentKeys.size)
      for (const c of it.components)
        if (!componentKeys.has(c)) problems.push({ severity: 'warning', code: 'unknown-component', message: `${it.id} names component “${c}”, which trace.yml doesn't define.`, path: it.path, id: it.id });
    for (const target of it.verifies) {
      const req = byId.get(target);
      if (!req) problems.push({ severity: 'error', code: 'broken-link', message: `${it.id} verifies ${target}, which doesn't exist.`, path: it.path, id: it.id });
      else if (req.kind !== 'requirement') problems.push({ severity: 'error', code: 'link-to-testcase', message: `${it.id} verifies ${target}, which is a test case.`, path: it.path, id: it.id });
      else verifiedBy.set(target, [...(verifiedBy.get(target) ?? []), it]);
    }
  }
  return { config, items, byId, byPath, verifiedBy, problems };
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

export function linkState(test: Item, req: Item): LinkState {
  const seen = test.reviewed[req.id];
  if (!seen) return 'unreviewed';
  return seen === fingerprint(req) ? 'ok' : 'suspect';
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
  tested: Item[];
  untested: Item[]; // requirements (not obsolete) no test case verifies
  orphans: Item[]; // test cases (not obsolete) that verify nothing
  suspect: Link[];
  unreviewed: Link[];
  componentsWithoutTests: Component[];
  problems: Problem[];
}

const live = (it: Item) => it.status !== 'obsolete';

export function coverage(index: ProjectIndex): Coverage {
  const requirements = index.items.filter((i) => i.kind === 'requirement');
  const testcases = index.items.filter((i) => i.kind === 'testcase');
  const links = requirements.flatMap((r) => linksOf(index, r));
  const tested = requirements.filter((r) => live(r) && (index.verifiedBy.get(r.id) ?? []).some(live));
  const testedComponents = new Set(testcases.filter(live).flatMap((t) => t.components));
  return {
    requirements,
    testcases,
    tested,
    untested: requirements.filter((r) => live(r) && !tested.includes(r)),
    orphans: testcases.filter((t) => live(t) && t.verifies.length === 0),
    suspect: links.filter((l) => l.state === 'suspect' && live(l.test) && live(l.req)),
    unreviewed: links.filter((l) => l.state === 'unreviewed' && live(l.test) && live(l.req)),
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
    return ok(`Trace recognizes IDs in text, commit messages and Jira when they look like ${own || 'TC-'}123 (capital letters, a dash, a number). This one is only linked through fields such as Verifies.`);
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
  fields: { id: string; title: string; status: string; verifies?: string[]; components?: string[]; reviewed?: Record<string, string>; type?: boolean },
): string {
  const yamlString = (s: string) => (/^[\w .,()/-]*$/.test(s) && !/^[\s-]|:\s|\s$/.test(s) && s !== '' ? s : JSON.stringify(s));
  const lines = [`id: ${yamlString(fields.id)}`];
  // An ID without the kind's prefix: say what it is, rather than leave it to the folder.
  if (fields.type) lines.push(`type: ${kind}`);
  lines.push(`title: ${yamlString(fields.title)}`, `status: ${fields.status}`);
  if (fields.components?.length) lines.push(`components: [${fields.components.join(', ')}]`);
  if (kind === 'testcase') {
    lines.push(`verifies: [${(fields.verifies ?? []).join(', ')}]`);
    const r = Object.entries(fields.reviewed ?? {});
    if (r.length) lines.push('reviewed:', ...r.map(([k, v]) => `  ${k}: "${v}"`));
  }
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
