// The repository's own settings, from `trace.yml` at its root. Every key is optional.
//
//   requirements: { dir: requirements, prefix: REQ-, digits: 2 }
//   testcases:    { dir: tests,        prefix: TC-,  digits: 3 }
//   statuses: [draft, review, approved, obsolete]
//   components:
//     payments: { name: Payments, paths: ["src/payments/**"] }
//   variants:
//     pro: { name: Pro }
//   jira: { url: https://jira.example.com }
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

export type Kind = 'requirement' | 'testcase';

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

export interface TraceConfig {
  requirements: KindConfig;
  testcases: KindConfig;
  statuses: string[];
  testcaseStatuses: string[];
  components: Component[];
  variants: Variant[];
  jiraUrl: string | null;
  // Jira project keys (PROJ) to look for in commit messages. Empty: those used in
  // requirements' `jira:` fields.
  jiraProjects: string[];
  jira: JiraConfig;
  // The code repository whose commit messages name Jira issues.
  code: { repository: string | null; branch: string | null; commits: number };
  runs: { dir: string };
}

export const CONFIG_FILES = ['trace.yml', '.trace.yml'];

export const DEFAULT_CONFIG: TraceConfig = {
  requirements: { dir: 'requirements', prefix: 'REQ-', digits: 2 },
  testcases: { dir: 'tests', prefix: 'TC-', digits: 3 },
  statuses: ['draft', 'review', 'approved', 'obsolete'],
  testcaseStatuses: ['draft', 'ready', 'obsolete'],
  components: [],
  variants: [],
  jiraUrl: null,
  jiraProjects: [],
  jira: { api: 2, jql: null, field: null, links: ISSUE_LINK_SOURCES, max: 2000 },
  code: { repository: null, branch: null, commits: 500 },
  runs: { dir: 'test-runs' },
};

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
  const code = (o.code && typeof o.code === 'object' ? o.code : {}) as Record<string, unknown>;
  const commitCount = Number(code.commits);
  return {
    config: {
      requirements: kind(o.requirements, DEFAULT_CONFIG.requirements),
      testcases: kind(o.testcases, DEFAULT_CONFIG.testcases),
      statuses: strList(o.statuses, DEFAULT_CONFIG.statuses),
      testcaseStatuses: strList(o.testcaseStatuses ?? o['testcase-statuses'], DEFAULT_CONFIG.testcaseStatuses),
      components,
      variants,
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

export function statusesFor(config: TraceConfig, k: Kind): string[] {
  return k === 'requirement' ? config.statuses : config.testcaseStatuses;
}

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
