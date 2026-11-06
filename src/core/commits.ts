// Commits, linked by the keys in their messages: a Jira key (PROJ-466) links a commit
// to that issue, and through it to the requirements naming it in `jira:`; a
// requirement or test case ID (REQ-07) links it to that item directly. The files a
// commit changed map to components through their paths in trace.yml.
import type { Commit } from '../shared/api';
import { componentsForPath, type Item, type ProjectIndex } from './model';
import { buildIssueLinks, projectsOf, type IssueLinks } from './links';

export interface LinkedCommit {
  commit: Commit;
  issues: string[]; // Jira keys in the message
  items: string[]; // requirement and test case IDs in the message
  components: string[]; // component keys whose paths it touched
}

const KEY = /\b([A-Z][A-Z0-9_]+)-(\d+)\b/g;
// Look like Jira keys, aren't.
const NOT_JIRA = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'HTTP', 'TLS', 'SSL', 'X', 'ES', 'MD', 'AES', 'RSA', 'CVE', 'WIP']);

export function linkCommits(commits: Commit[], index: ProjectIndex, links: IssueLinks = buildIssueLinks(index)): LinkedCommit[] {
  const projects = projectsOf(index, links);
  const itemPrefixes = [index.config.requirements.prefix, index.config.testcases.prefix];
  return commits.map((commit) => {
    const text = `${commit.subject}\n${commit.body}`;
    const issues = new Set<string>();
    const items = new Set<string>();
    for (const m of text.matchAll(KEY)) {
      const key = m[0];
      if (index.byId.has(key)) items.add(key);
      else if (itemPrefixes.some((p) => key.startsWith(p))) continue; // an item that doesn't exist (any more)
      else if (projects ? projects.has(m[1]) : !NOT_JIRA.has(m[1])) issues.add(key);
    }
    const components = new Set<string>();
    for (const f of commit.files) for (const c of componentsForPath(f, index.config.components)) components.add(c.key);
    return { commit, issues: [...issues], items: [...items], components: [...components] };
  });
}

// The commits that reach an item: through the Jira issues linked to it, or naming it;
// for a test case, also through the requirements it verifies.
export function commitsFor(item: Item, linked: LinkedCommit[], index: ProjectIndex, links: IssueLinks = buildIssueLinks(index)): { linked: LinkedCommit; via: string[] }[] {
  const reqs = item.kind === 'requirement' ? [] : item.verifies.map((v) => index.byId.get(v)).filter((r): r is Item => !!r && r.kind === 'requirement');
  const issuesOf = (id: string) => (links.byItem.get(id) ?? []).map((l) => l.issue);
  const own = issuesOf(item.id);
  const out: { linked: LinkedCommit; via: string[] }[] = [];
  for (const l of linked) {
    const via = new Set<string>();
    if (l.items.includes(item.id)) via.add(item.id);
    for (const j of own) if (l.issues.includes(j)) via.add(j);
    for (const r of reqs) {
      if (l.items.includes(r.id)) via.add(r.id);
      for (const j of issuesOf(r.id)) if (l.issues.includes(j)) via.add(j);
    }
    if (via.size) out.push({ linked: l, via: [...via] });
  }
  return out;
}
