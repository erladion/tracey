import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/core/model';
import { projectFiles } from '../src/core/sample';
import { buildIssueLinks, linkQuery } from '../src/core/links';
import { linkCommits, commitsFor } from '../src/core/commits';
import { impact, reasonText } from '../src/core/impact';
import { buildGraph } from '../src/core/graph';
import type { JiraIssue } from '../src/shared/api';

const files = Object.entries(projectFiles(true))
  .filter(([p]) => p.endsWith('.md') && p !== 'README.md')
  .map(([path, text]) => ({ path, text }));
const config = projectFiles(true)['trace.yml'] + 'jira:\n  url: https://jira.example.com\n  field: Requirements\n';
const index = buildIndex(files, config);
const issue = (key: string, extra: Partial<JiraIssue>): JiraIssue => ({
  key,
  summary: '',
  status: 'Open',
  statusCategory: 'new',
  type: 'Bug',
  labels: [],
  fixVersions: [],
  description: '',
  field: [],
  remoteLinks: null,
  ...extra,
});

const issues = [
  issue('PROJ-501', { labels: ['REQ-12', 'backend'] }),
  issue('PROJ-502', { field: ['REQ-31, TC-140'] }),
  issue('PROJ-503', { summary: 'Retry message missing', description: 'Seen while running tc-102 against REQ-07. REQ-99 is not a thing.' }),
  issue('PROJ-504', { remoteLinks: [{ url: 'https://trace.example.com/#REQ-19', title: 'Requirement' }] }),
  issue('PROJ-466', { summary: 'Retry failed payments', labels: ['REQ-07'], fixVersions: ['2.4.0'] }),
];
const links = buildIssueLinks(index, issues);

describe('issue links', () => {
  it('reads every source, and says where each link came from', () => {
    const of = (k: string) => (links.byIssue.get(k) ?? []).map((l) => `${l.item}:${l.sources.join('+')}`).sort();
    expect(of('PROJ-501')).toEqual(['REQ-12:label']);
    expect(of('PROJ-502')).toEqual(['REQ-31:field', 'TC-140:field']);
    expect(of('PROJ-503')).toEqual(['REQ-07:text', 'TC-102:text']);
    expect(of('PROJ-504')).toEqual(['REQ-19:remote-link']);
    expect(of('PROJ-466')).toEqual(['REQ-07:front-matter+label']);
  });

  it('follows jira.links', () => {
    const only = buildIndex(files, config + '  links: [labels]\n');
    const l = buildIssueLinks(only, issues);
    expect(l.byIssue.has('PROJ-503')).toBe(false);
    expect(l.byIssue.has('PROJ-501')).toBe(true);
  });

  it('builds the query from the projects', () => {
    expect(linkQuery(index, links)).toBe('project in ("PROJ") ORDER BY updated DESC');
  });

  it('feeds commits, impact and the graph', () => {
    const linked = linkCommits([{ hash: 'aaaa1111', author: 'A', date: '2026-11-01T10:00:00Z', subject: 'PROJ-503 show retry message', body: '', files: [] }], index, links);
    expect(commitsFor(index.byId.get('TC-102')!, linked, index, links).map((c) => c.via)).toEqual([['PROJ-503']]);
    const im = impact(index, linked, { components: false, links, fixVersion: { name: '2.4.0', issues: ['PROJ-466', 'PROJ-502'] } });
    expect([...im.cases.keys()].sort()).toEqual(['TC-101', 'TC-102', 'TC-130', 'TC-140']);
    expect(im.cases.get('TC-102')!.map((r) => reasonText(r)).sort()).toEqual(['PROJ-466 → REQ-07 (fix version 2.4.0)', 'PROJ-503 links to it (1 commit)', 'PROJ-503 → REQ-07 (1 commit)']);
    const g = buildGraph(index, {}, linked, links);
    expect(g.byKey.get('issue:PROJ-466')!.sub).toBe('Retry failed payments');
    expect(g.edges.find((e) => e.from === 'issue:PROJ-502' && e.to === 'test:TC-140')!.sources).toEqual(['field']);
  });
});
