import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config';
import { buildIndex, coverage, fingerprint, linksOf, newItemText, type SourceFile } from '../src/core/model';
import { buildGraph, columns } from '../src/core/graph';
import { impact } from '../src/core/impact';
import { tables } from '../src/core/spreadsheet';
import { otherFields } from '../src/core/fields';
import type { LinkedCommit } from '../src/core/commits';

// The V-model's right side: integration tests verify architecture elements, which
// implement requirements; test cases still verify requirements.
const CONFIG = `
types:
  architecture: { name: Architecture element, prefix: ARC-, dir: architecture }
  integration-test: { name: Integration test, prefix: IT-, dir: integration-tests, runnable: true }
links:
  implements: { name: Implements, reverse: Implemented by, from: architecture, to: requirement }
  verifies: { to: [architecture] }
rules:
  - { every: architecture, needs: verifies }
`;

const file = (path: string, id: string, front = ''): SourceFile => ({ path, text: `---\nid: ${id}\ntitle: ${id} title\nstatus: draft\n${front}---\n${id} text.\n` });
const fp = (id: string) => fingerprint({ title: `${id} title`, body: `${id} text.` });

const files = () => [
  file('requirements/REQ-1.md', 'REQ-1'),
  file('architecture/ARC-1.md', 'ARC-1', 'implements: [REQ-1]\ncomponents: [payments]\n'),
  file('architecture/ARC-2.md', 'ARC-2'),
  file('integration-tests/IT-1.md', 'IT-1', `verifies: [ARC-1]\nestimate: 45m\ncomponents: [payments]\nreviewed:\n  ARC-1: "${fp('ARC-1')}"\n`),
  file('tests/TC-1.md', 'TC-1', 'verifies: [REQ-1]\n'),
];

describe('runnable types and what tests verify', () => {
  it('reads runnable types and what verifies may link', () => {
    const { config } = parseConfig(CONFIG);
    expect(config.types.map((t) => [t.key, t.runnable])).toEqual([
      ['requirement', false],
      ['testcase', true],
      ['architecture', false],
      ['integration-test', true],
    ]);
    expect(config.types[3].statuses).toEqual(config.testcaseStatuses);
    const verifies = config.links.find((l) => l.key === 'verifies')!;
    expect([verifies.from, verifies.to]).toEqual([
      ['testcase', 'integration-test'],
      ['requirement', 'architecture'],
    ]);
    expect(config.notes).toEqual([]);
    expect(parseConfig(`${CONFIG.replace('verifies: { to: [architecture] }', 'verifies: { from: [architecture], to: [nothing] }')}`).config.notes).toEqual([
      'links: verifies from architecture: only runnable types verify (runnable: true on the type).',
      'links: verifies names “nothing” under to:, which isn\'t an item type.',
      'rules: verifies links can\'t come from architecture, so “every: architecture, needs: verifies” can never be met.',
    ]);
  });

  it('links integration tests to what they verify, with review state', () => {
    const idx = buildIndex(files(), CONFIG);
    expect(idx.problems).toEqual([]);
    const it1 = idx.byId.get('IT-1')!;
    expect([it1.verifies, it1.estimate]).toEqual([['ARC-1'], 45]);
    expect(otherFields(it1, idx.config)).toEqual([]);
    expect(linksOf(idx, idx.byId.get('ARC-1')!).map((l) => [l.test.id, l.state])).toEqual([['IT-1', 'ok']]);
    expect(linksOf(idx, it1).map((l) => l.req.id)).toEqual(['ARC-1']);
    // A test case can't verify an integration test.
    const bad = buildIndex([...files(), file('tests/TC-2.md', 'TC-2', 'verifies: [IT-1]\n')], CONFIG);
    expect(bad.problems.map((p) => p.message)).toEqual(['TC-2 verifies IT-1, which is an integration test: tests verify requirements or architecture elements.']);
  });

  it('counts verifies in rules and coverage', () => {
    const cov = coverage(buildIndex(files(), CONFIG));
    expect(cov.rules[0].missing.map((i) => i.id)).toEqual(['ARC-2']);
    expect(cov.orphans).toEqual([]);
    expect(cov.componentsWithoutTests).toEqual([]);
    const changed = files().map((f) => (f.path.includes('ARC-1') ? { ...f, text: f.text.replace('ARC-1 text.', 'Rewritten.') } : f));
    expect(coverage(buildIndex(changed, CONFIG)).suspect.map((l) => `${l.test.id}→${l.req.id}`)).toEqual(['IT-1→ARC-1']);
  });

  it('draws them in the graph, after what they verify', () => {
    const g = buildGraph(buildIndex(files(), CONFIG));
    // Test cases may verify architecture too, so they come after it, with integration tests.
    expect(columns(g).filter((c) => c.nodes.length).map((c) => c.itemType ?? c.type)).toEqual(['req', 'architecture', 'integration-test', 'test', 'component']);
    expect(g.fwd.get('item:ARC-1')).toEqual(['item:IT-1']);
    expect(g.fwd.get('item:IT-1')).toEqual(['component:payments']);
    expect(g.byKey.get('item:ARC-2')!.tag).toBe('Not verified');
  });

  it('puts them in test runs: picked through what they verify, never other items', () => {
    const idx = buildIndex(files(), CONFIG);
    const commit = (items: string[]): LinkedCommit => ({ commit: { hash: 'abcdef12', author: '', date: '', subject: '', body: '', files: [] }, issues: [], items, components: [] });
    const picked = impact(idx, [commit(['ARC-1']), commit(['IT-1'])], { components: false });
    expect([...picked.cases.keys()].sort()).toEqual(['IT-1']);
    expect([...impact(idx, [commit(['ARC-2'])], { components: false }).cases.keys()]).toEqual([]);
  });

  it('starts new ones with steps and exports them', () => {
    expect(newItemText('integration-test', { id: 'IT-2', title: 'Two', status: 'draft', verifies: ['ARC-1'], steps: true })).toBe(
      '---\nid: IT-2\ntitle: Two\nstatus: draft\nverifies: [ARC-1]\n---\n## Steps\n\n1. \n\n## Expected\n\n',
    );
    const sheet = tables(buildIndex(files(), CONFIG), { obsolete: false, component: null, runs: [] }).others;
    const col = (h: string) => sheet.columns.findIndex((c) => c.header === h);
    const row = (id: string) => sheet.rows.find((r) => r[0] === id)!;
    expect([row('IT-1')[col('Verifies')], row('ARC-1')[col('Verified by')], row('ARC-1')[col('Implements')]]).toEqual(['ARC-1', 'IT-1', 'REQ-1']);
  });
});
