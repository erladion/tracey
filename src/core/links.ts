// Links between Jira issues and requirements / test cases, from wherever they're
// written:
//
//   front matter     jira: [PROJ-466] on a requirement or test case
//   label            the issue has the label REQ-07
//   field            the issue's requirements field (jira.field) lists REQ-07
//   text             the issue's summary or description mentions REQ-07
//   remote link      one of the issue's links (web links) has REQ-07 in its address or title
//
// Which of the Jira-side ones count is set by jira.links in trace.yml.
import type { JiraIssue } from '../shared/api';
import type { Item, ProjectIndex } from './model';

export type LinkSource = 'front-matter' | 'label' | 'field' | 'text' | 'remote-link';

export const SOURCE_LABEL: Record<LinkSource, string> = {
  'front-matter': 'front matter',
  label: 'label',
  field: 'field',
  text: 'mentioned in issue',
  'remote-link': 'remote link',
};

export interface IssueLink {
  issue: string;
  item: string; // requirement or test case ID
  sources: LinkSource[];
}

export interface IssueLinks {
  byIssue: Map<string, IssueLink[]>;
  byItem: Map<string, IssueLink[]>;
  issues: Map<string, JiraIssue>; // what's known about each issue from Jira
}

const ID = /\b[A-Z][A-Z0-9_]*-\d+\b/g;

// Requirement and test case IDs in a piece of text (only ones that exist).
export function itemIdsIn(text: string, index: ProjectIndex): string[] {
  const out = new Set<string>();
  for (const m of text.toUpperCase().matchAll(ID)) if (index.byId.has(m[0])) out.add(m[0]);
  return [...out];
}

export function buildIssueLinks(index: ProjectIndex, issues: JiraIssue[] = []): IssueLinks {
  const pairs = new Map<string, IssueLink>();
  const add = (issue: string, item: string, source: LinkSource) => {
    const k = `${issue}\u0000${item}`;
    const l = pairs.get(k) ?? { issue, item, sources: [] };
    if (!l.sources.includes(source)) l.sources.push(source);
    pairs.set(k, l);
  };

  for (const it of index.items) for (const j of it.jira) add(j.toUpperCase(), it.id, 'front-matter');

  const use = new Set(index.config.jira.links);
  for (const is of issues) {
    if (use.has('labels')) for (const l of is.labels) if (index.byId.has(l.toUpperCase())) add(is.key, l.toUpperCase(), 'label');
    if (use.has('field')) for (const id of itemIdsIn(is.field.join(' '), index)) add(is.key, id, 'field');
    if (use.has('text')) for (const id of itemIdsIn(`${is.summary}\n${is.description}`, index)) add(is.key, id, 'text');
    if (use.has('remote-links')) for (const r of is.remoteLinks ?? []) for (const id of itemIdsIn(`${r.url} ${r.title}`, index)) add(is.key, id, 'remote-link');
  }

  const byIssue = new Map<string, IssueLink[]>();
  const byItem = new Map<string, IssueLink[]>();
  for (const l of pairs.values()) {
    byIssue.set(l.issue, [...(byIssue.get(l.issue) ?? []), l]);
    byItem.set(l.item, [...(byItem.get(l.item) ?? []), l]);
  }
  return { byIssue, byItem, issues: new Map(issues.map((i) => [i.key, i])) };
}

// The issues an item is linked to directly.
export function issuesOf(links: IssueLinks, item: Item): IssueLink[] {
  return links.byItem.get(item.id) ?? [];
}

// The Jira projects to recognise in commit messages: configured, else the ones links use.
export function projectsOf(index: ProjectIndex, links: IssueLinks): Set<string> | null {
  if (index.config.jiraProjects.length) return new Set(index.config.jiraProjects);
  const used = new Set([...links.byIssue.keys()].map((k) => k.replace(/-\d+$/, '')));
  return used.size ? used : null;
}

// The JQL that finds the issues to read: the configured one, else the projects'.
export function linkQuery(index: ProjectIndex, links: IssueLinks): string | null {
  if (index.config.jira.jql) return index.config.jira.jql;
  const projects = projectsOf(index, links);
  return projects ? `project in (${[...projects].map((p) => `"${p}"`).join(', ')}) ORDER BY updated DESC` : null;
}
