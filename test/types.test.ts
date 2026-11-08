import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config';
import { buildIndex, checkNewId, coverage, fingerprint, forVariant, itemLinks, newItemText, nextId, type SourceFile } from '../src/core/model';
import { buildGraph, columns, typeOrder } from '../src/core/graph';
import { bulkChanges } from '../src/core/bulk';
import { otherFields } from '../src/core/fields';
import { tables } from '../src/core/spreadsheet';
import { specHtml } from '../src/core/specdoc';
import { changesHtml, compareVersions } from '../src/core/changes';
import { planRename } from '../src/core/rename';

const CONFIG = `
types:
  risk: { name: Risk, prefix: RSK-, dir: risks }
  architecture: { name: Architecture element, prefix: ARC-, dir: architecture }
links:
  mitigates: { name: Mitigates, reverse: Mitigated by, from: [requirement, test cases], to: risk }
  implements: { name: Implements, reverse: Implemented by, from: architecture, to: requirements }
rules:
  - { every: risk, needs: mitigates }
  - { every: architecture, needs: implements }
`;

const file = (path: string, id: string, front = '', body = `${id} text.`): SourceFile => ({ path, text: `---\nid: ${id}\ntitle: ${id} title\nstatus: draft\n${front}---\n${body}\n` });
const fp = (id: string) => fingerprint({ title: `${id} title`, body: `${id} text.` });

const files = (extra: SourceFile[] = []) => [
  file('risks/RSK-1.md', 'RSK-1'),
  file('risks/RSK-2.md', 'RSK-2'),
  file('requirements/REQ-1.md', 'REQ-1', `mitigates: [RSK-1]\nreviewed:\n  RSK-1: "${fp('RSK-1')}"\n`),
  file('architecture/ARC-1.md', 'ARC-1', `implements: [REQ-1]\nreviewed:\n  REQ-1: "${fp('REQ-1')}"\n`),
  file('architecture/ARC-2.md', 'ARC-2'),
  file('tests/TC-1.md', 'TC-1', 'verifies: [REQ-1]\n'),
  ...extra,
];

describe('item and link types from trace.yml', () => {
  it('reads types, links and rules, and says what it can’t use', () => {
    const { config } = parseConfig(`
types:
  risk: { name: Risk, prefix: RSK-, dir: risks, statuses: [open, mitigated, closed, obsolete] }
  architecture: { name: Architecture element, prefix: ARC-, dir: architecture }
links:
  mitigates: { name: Mitigates, reverse: Mitigated by, from: [requirement, test cases], to: risk }
  implements: { name: Implements, reverse: Implemented by, from: architecture, to: requirements }
  bogus: { from: requirement, to: nothing }
  title: { from: requirement, to: risk }
rules:
  - { every: risk, needs: mitigates }
  - { every: architecture, needs: implements }
  - { every: risk, needs: implements }
fields:
  mitigates: text
  severity: { values: [Low, High], for: risk }
`);
    expect(config.types[2].statuses).toEqual(['open', 'mitigated', 'closed', 'obsolete']);
    expect(config.types.map((t) => [t.key, t.plural, t.prefix])).toEqual([
      ['requirement', 'Requirements', 'REQ-'],
      ['testcase', 'Test cases', 'TC-'],
      ['risk', 'Risks', 'RSK-'],
      ['architecture', 'Architecture elements', 'ARC-'],
    ]);
    expect(config.links.map((l) => [l.key, l.from, l.to])).toEqual([
      ['verifies', ['testcase'], ['requirement']],
      ['refines', ['requirement'], ['requirement']],
      ['mitigates', ['requirement', 'testcase'], ['risk']],
      ['implements', ['architecture'], ['requirement']],
    ]);
    expect(config.rules.map((r) => [r.type, r.link, r.incoming, r.tag])).toEqual([
      ['risk', 'mitigates', true, 'Not mitigated'],
      ['architecture', 'implements', false, 'Implements nothing'],
    ]);
    expect(config.fields.map((f) => [f.key, f.kinds])).toEqual([['severity', ['risk']]]);
    expect(config.notes).toEqual([
      'links: bogus names “nothing” under to:, which isn\'t an item type.',
      'links: bogus needs the item types it goes from and to (from: requirement, to: risk).',
      "links: “title” is one of Tracey's own fields, so it can't be a link type.",
      'The field “mitigates” is also a link type under links:, so it\'s used as the link.',
      'rules: implements links can\'t come from risk, so “every: risk, needs: implements” can never be met.',
    ]);
  });

  it('knows an item’s type by prefix, by folder or by what it says', () => {
    const idx = buildIndex([...files(), file('risks/hazard.md', 'HZ-9'), file('notes/x.md', 'X-1', 'type: risk\n')], CONFIG);
    expect(['RSK-1', 'ARC-1', 'HZ-9', 'X-1', 'TC-1'].map((id) => idx.byId.get(id)!.kind)).toEqual(['risk', 'architecture', 'risk', 'risk', 'testcase']);
    expect(nextId(idx, 'risk')).toBe('RSK-02'.replace('02', '03'));
    expect(checkNewId(idx, 'risk', 'REQ-9').error).toBe('IDs starting with REQ- are requirements. Use one starting with RSK-.');
  });

  it('links items both ways, with review state', () => {
    const idx = buildIndex(files(), CONFIG);
    expect(idx.problems).toEqual([]);
    expect(idx.byId.get('REQ-1')!.links).toEqual({ mitigates: ['RSK-1'] });
    const risk = itemLinks(idx, idx.byId.get('RSK-1')!);
    expect(risk.in.map((l) => [l.def.key, l.from.id, l.state])).toEqual([['mitigates', 'REQ-1', 'ok']]);
    const req = itemLinks(idx, idx.byId.get('REQ-1')!);
    expect(req.in.map((l) => [l.def.key, l.from.id])).toEqual([['implements', 'ARC-1']]);
    // A link field on a type it isn't for stays an ordinary field.
    expect(otherFields(idx.byId.get('REQ-1')!, idx.config)).toEqual([]);
    const odd = buildIndex([file('risks/RSK-5.md', 'RSK-5', 'implements: [REQ-1]\n'), file('requirements/REQ-1.md', 'REQ-1')], CONFIG).byId.get('RSK-5')!;
    expect(odd.links).toEqual({});
  });

  it('reports broken links, wrong types and links to itself', () => {
    const idx = buildIndex([file('requirements/REQ-1.md', 'REQ-1', 'mitigates: [RSK-9, TC-1]\n'), file('architecture/ARC-1.md', 'ARC-1', 'implements: [ARC-1]\n'), file('tests/TC-1.md', 'TC-1', 'verifies: []\n')], CONFIG);
    expect(idx.problems.map((p) => p.message)).toEqual([
      "REQ-1 mitigates RSK-9, which doesn't exist.",
      'REQ-1 mitigates TC-1, which is a test case: mitigates links go to risks.',
      'ARC-1 implements itself.',
    ]);
  });

  it('makes a link suspect when the linked item changes', () => {
    const changed = files().map((f) => (f.path === 'risks/RSK-1.md' ? { ...f, text: f.text.replace('RSK-1 text.', 'Now worse.') } : f));
    const cov = coverage(buildIndex(changed, CONFIG));
    expect(cov.suspectLinks.map((l) => `${l.from.id} ${l.def.key} ${l.to.id}`)).toEqual(['REQ-1 mitigates RSK-1']);
    expect(buildGraph(buildIndex(changed, CONFIG)).byKey.get('req:REQ-1')!.tag).toBe('Suspect');
  });

  it('checks the rules, ignoring obsolete items', () => {
    const cov = coverage(buildIndex(files([file('requirements/REQ-2.md', 'REQ-2', 'status: obsolete\nmitigates: [RSK-2]\n'.replace('status: obsolete\n', ''))]), CONFIG));
    expect(cov.rules.map((r) => [r.rule.type, r.items.length, r.missing.map((i) => i.id)])).toEqual([
      ['risk', 2, []],
      ['architecture', 2, ['ARC-2']],
    ]);
    const obsolete = files([{ path: 'requirements/REQ-2.md', text: '---\nid: REQ-2\ntitle: t\nstatus: obsolete\nmitigates: [RSK-2]\n---\n' }]);
    expect(coverage(buildIndex(obsolete, CONFIG)).rules[0].missing.map((i) => i.id)).toEqual(['RSK-2']);
  });

  it('draws a column per type, in the order their links go, with rule gaps', () => {
    const idx = buildIndex(files(), CONFIG);
    expect(typeOrder(idx.config)).toEqual(['risk', 'requirement', 'architecture', 'testcase']);
    const g = buildGraph(idx);
    expect(columns(g).filter((c) => c.nodes.length).map((c) => c.itemType ?? c.type)).toEqual(['risk', 'req', 'architecture', 'test']);
    expect(g.fwd.get('item:RSK-1')).toEqual(['req:REQ-1']);
    expect(g.fwd.get('req:REQ-1')).toEqual(expect.arrayContaining(['test:TC-1', 'item:ARC-1']));
    expect([g.byKey.get('item:ARC-2')!.tag, g.byKey.get('item:RSK-2')!.tag]).toEqual(['Implements nothing', 'Not mitigated']);
  });

  it('keeps links per variant', () => {
    const idx = buildIndex(files([file('requirements/REQ-2.md', 'REQ-2', 'variants: [pro]\nmitigates: [RSK-2]\n')]), `${CONFIG}variants: [base, pro]\n`);
    expect(idx.linkedBy.get('mitigates')!.get('RSK-2')!.map((i) => i.id)).toEqual(['REQ-2']);
    expect(forVariant(idx, 'base').linkedBy.get('mitigates')!.has('RSK-2')).toBe(false);
    expect(coverage(forVariant(idx, 'base')).rules[0].missing.map((i) => i.id)).toEqual(['RSK-2']);
  });

  it('changes links in bulk, reviewed, and only on the types they’re for', () => {
    const idx = buildIndex(files(), CONFIG);
    const items = ['REQ-1', 'TC-1', 'ARC-1'].map((id) => idx.byId.get(id)!);
    const c = bulkChanges(items, { set: {}, add: { mitigates: ['RSK-2'] }, remove: {} }, idx);
    expect(c.get('requirements/REQ-1.md')).toEqual({ mitigates: ['RSK-1', 'RSK-2'], reviewed: { 'RSK-1': fp('RSK-1'), 'RSK-2': fp('RSK-2') } });
    expect(c.get('tests/TC-1.md')).toEqual({ mitigates: ['RSK-2'], reviewed: { 'RSK-2': fp('RSK-2') } });
    expect(c.has('architecture/ARC-1.md')).toBe(false);
  });

  it('starts new items with their links', () => {
    expect(newItemText('risk', { id: 'RSK-3', title: 'Three', status: 'open', links: { mitigates: [] } })).toBe('---\nid: RSK-3\ntitle: Three\nstatus: open\n---\n');
    expect(newItemText('requirement', { id: 'REQ-3', title: 'Three', status: 'draft', links: { mitigates: ['RSK-1'] }, reviewed: { 'RSK-1': 'abc' } })).toBe(
      '---\nid: REQ-3\ntitle: Three\nstatus: draft\nmitigates: [RSK-1]\nreviewed:\n  RSK-1: "abc"\n---\n',
    );
  });

  it('exports the types and links', () => {
    const idx = buildIndex(files(), CONFIG);
    const t = tables(idx, { obsolete: false, component: null, runs: [] });
    expect(t.others.rows.map((r) => r.slice(0, 2))).toEqual([
      ['RSK-1', 'Risk'],
      ['RSK-2', 'Risk'],
      ['ARC-1', 'Architecture element'],
      ['ARC-2', 'Architecture element'],
    ]);
    const col = (h: string) => t.requirements.columns.findIndex((c) => c.header === h);
    const req = t.requirements.rows.find((r) => r[0] === 'REQ-1')!;
    expect([req[col('Mitigates')], req[col('Implemented by')]]).toEqual(['RSK-1', 'ARC-1']);
    const html = specHtml(idx, { title: 'Spec', requirements: true, testcases: true, matrix: false, obsolete: false, component: null, meta: [], image: (_p, s) => s });
    expect(html).toContain('<h2 id="type-risk">Risks</h2>');
    expect(html).toContain('<td>Mitigated by</td><td><a class="mono" href="#i-REQ-1">REQ-1</a></td>');
  });

  it('lists changes per type, and renames IDs in declared links', () => {
    const old = buildIndex(files(), CONFIG);
    const now = buildIndex(files([file('risks/RSK-3.md', 'RSK-3')]), CONFIG);
    const html = changesHtml(compareVersions(old, now), { title: 'x', from: 'a', to: 'b', meta: [], image: (_p, s) => s, types: now.config.types });
    expect(html).toContain('<tr><td>Risks</td><td>1</td><td>0</td><td>0</td></tr>');
    const texts = new Map(files().map((f) => [f.path, f.text]));
    const plan = planRename(old, texts, CONFIG, old.byId.get('RSK-1')!, 'RSK-100', false);
    expect(plan.texts.get('requirements/REQ-1.md')).toContain('mitigates: [RSK-100]');
    // RSK-1's own text names it, so its fingerprint changes; the reviewed link stays reviewed.
    expect(plan.texts.get('requirements/REQ-1.md')).toContain(`RSK-100: ${fingerprint({ title: 'RSK-100 title', body: 'RSK-100 text.' })}`);
  });

  it('changes nothing for a project that declares nothing', () => {
    const { config } = parseConfig('statuses: [draft, approved]\n');
    expect([config.types.map((t) => t.key), config.links.map((l) => l.key), config.rules, config.notes]).toEqual([['requirement', 'testcase'], ['verifies', 'refines'], [], []]);
    expect(typeOrder(config)).toEqual(['requirement', 'testcase']);
  });
});
