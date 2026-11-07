import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/core/model';
import { fieldInput, fieldText, listValue, matchesSearch, otherFields } from '../src/core/fields';
import { tables } from '../src/core/spreadsheet';

const CONFIG = 'requirements: { dir: requirements }\ntestcases: { dir: tests }\n';
const index = buildIndex(
  [
    {
      path: 'requirements/SYS-12.md',
      text: '---\nid: SYS-12\ntitle: Retry the payment\nstatus: approved\ntype: requirement\npriority: High\nsafety-level: ASIL B\nsection: 3.2 Payment\ndoors: { module: Payments, id: 12 }\nowners: [anna, bo]\nestimate: 2h\nempty:\n---\nRetry after a gateway timeout.\n',
    },
    { path: 'tests/TC-001.md', text: '---\nid: TC-001\ntitle: Retry once\nverifies: [SYS-12]\nestimate: 30m\npriority: Low\nreviewed: { SYS-12: abc123 }\n---\nTime out the gateway.\n' },
  ],
  CONFIG,
);
const req = index.byId.get('SYS-12')!;
const tc = index.byId.get('TC-001')!;

describe('fields Tracey has no editor for', () => {
  it('are the rest of the front matter, in the file’s order, without empty ones', () => {
    expect(otherFields(req).map(([k]) => k)).toEqual(['type', 'priority', 'safety-level', 'section', 'doors', 'owners', 'estimate']);
    // A test case's estimate and verifies have editors; reviewed is bookkeeping.
    expect(otherFields(tc).map(([k]) => k)).toEqual(['priority']);
  });
  it('read as text', () => {
    expect(['doors', 'owners'].map((k) => fieldText(req.data[k]))).toEqual(['module: Payments · id: 12', 'anna, bo']);
  });
  it('can be searched, all of them or one by name', () => {
    const find = (q: string) => [req, tc].filter((i) => matchesSearch(i, q)).map((i) => i.id);
    expect(find('')).toEqual(['SYS-12', 'TC-001']);
    expect(find('retry')).toEqual(['SYS-12', 'TC-001']);
    expect(find('asil')).toEqual(['SYS-12']);
    expect(find('priority:high')).toEqual(['SYS-12']);
    expect(find('Priority:LOW')).toEqual(['TC-001']);
    expect(find('doors:payments')).toEqual(['SYS-12']);
    expect(find('safety-level:asil retry')).toEqual(['SYS-12']);
    expect(find('verifies:sys-12')).toEqual(['TC-001']);
    expect(find('owner:anna')).toEqual([]);
    expect(find('abc123')).toEqual([]); // review fingerprints aren't searched
  });
});

describe('fields declared in trace.yml', () => {
  const cfg = `${CONFIG}fields:
  priority: [Low, Medium, High]
  owner: text
  effort: { type: number, for: testcase }
  due: date
  platforms: { values: [Linux, Windows], multiple: true }
  tags: list
  safety: { name: Safety level, values: [QM, ASIL B], for: requirement }
  status: [nope]
`;
  const file = (id: string, extra: string) => ({ path: `${id.startsWith('TC') ? 'tests' : 'requirements'}/${id}.md`, text: `---\nid: ${id}\ntitle: ${id}\n${extra}---\n` });
  const idx = buildIndex(
    [
      file('REQ-01', 'priority: High\nowner: anna\ndue: 2026-12-01\nplatforms: [Linux]\ntags: [ui, slow]\nsafety: ASIL B\neffort: 3\n'),
      file('REQ-02', 'priority: Urgent\ndue: soon\nplatforms: [Linux, Mac]\nowner: [a, b]\n'),
      file('TC-001', 'priority: Low\neffort: 2.5\nsafety: QM\nverifies: [REQ-01]\n'),
      file('TC-002', 'effort: lots\n'),
    ],
    cfg,
  );
  it('reads them, shorthand or spelled out; built-in fields can’t be declared', () => {
    expect(idx.config.fields.map((f) => [f.key, f.name, f.type, f.values.join('/'), f.kinds.join('+')])).toEqual([
      ['priority', 'Priority', 'choice', 'Low/Medium/High', 'requirement+testcase'],
      ['owner', 'Owner', 'text', '', 'requirement+testcase'],
      ['effort', 'Effort', 'number', '', 'testcase'],
      ['due', 'Due', 'date', '', 'requirement+testcase'],
      ['platforms', 'Platforms', 'choices', 'Linux/Windows', 'requirement+testcase'],
      ['tags', 'Tags', 'list', '', 'requirement+testcase'],
      ['safety', 'Safety level', 'choice', 'QM/ASIL B', 'requirement'],
    ]);
  });
  it('warns about values that don’t fit', () => {
    expect(idx.problems.filter((p) => p.code === 'bad-field').map((p) => p.message)).toEqual([
      'REQ-02 has Priority “Urgent”, which isn\'t one of: Low, Medium, High.',
      'REQ-02 has Owner a list, but it takes one line of text.',
      'REQ-02 has Due “soon”, which isn\'t a date like 2026-11-07.',
      'REQ-02 has Platforms “Mac”, not among: Linux, Windows.',
      'TC-002 has Effort “lots”, which isn\'t a number.',
    ]);
  });
  it('leaves only undeclared fields read-only, per kind', () => {
    const r1 = idx.byId.get('REQ-01')!;
    const t1 = idx.byId.get('TC-001')!;
    expect(otherFields(r1, idx.config).map(([k]) => k)).toEqual(['effort']); // effort is for test cases
    expect(otherFields(t1, idx.config).map(([k]) => k)).toEqual(['safety']); // safety is for requirements
  });
  it('turns typed text into values', () => {
    const f = (k: string) => idx.config.fields.find((x) => x.key === k)!;
    expect([fieldInput(f('effort'), ' 2,5 '), fieldInput(f('owner'), ' anna '), fieldInput(f('owner'), '  '), fieldInput(f('effort'), 'x')]).toEqual([2.5, 'anna', undefined, 'x']);
    expect(listValue(['a', 'b'])).toEqual(['a', 'b']);
    expect(listValue('a')).toEqual(['a']);
    expect(listValue(null)).toEqual([]);
  });
  it('get a column each in the spreadsheet, before File', () => {
    const t = tables(idx, { obsolete: false, component: null, runs: [] });
    const heads = (s: 'requirements' | 'testcases') => t[s].columns.map((c) => c.header);
    expect(heads('requirements').slice(-7)).toEqual(['Priority', 'Owner', 'Due', 'Platforms', 'Tags', 'Safety level', 'File']);
    expect(heads('testcases').slice(-6)).toEqual(['Priority', 'Owner', 'Effort', 'Due', 'Platforms', 'Tags', 'File'].slice(-6));
    const tc = t.testcases.rows.find((r) => r[0] === 'TC-001')!;
    expect(tc.slice(-7, -1)).toEqual(['Low', null, 2.5, null, null, null]);
    expect(t.requirements.rows[0].slice(-7, -1)).toEqual(['High', 'anna', '2026-12-01', 'Linux', 'ui, slow', 'ASIL B']);
  });
});
