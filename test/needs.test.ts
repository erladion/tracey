import { describe, expect, it } from 'vitest';
import { buildIndex, coverage, type SourceFile } from '../src/core/model';
import { formatNeedsReport, needsJson, planNeedsImport, readNeedsFile } from '../src/core/needs';

const CONFIG = `
components:
  payments: { name: Payments, paths: ["src/payments/**"] }
types:
  risk: { name: Risk, prefix: RSK-, dir: risks }
links:
  mitigates: { name: Mitigates, reverse: Mitigated by, from: requirement, to: risk }
fields:
  priority: [Low, High]
`;
const file = (path: string, id: string, front = '', body = `${id} text.`): SourceFile => ({ path, text: `---\nid: ${id}\ntitle: ${id} title\nstatus: approved\n${front}---\n${body}\n` });
const files = [
  file('requirements/REQ-1.md', 'REQ-1', 'components: [payments]\npriority: High\nmitigates: [RSK-1]\n', 'Retry **three** times.'),
  file('requirements/REQ-2.md', 'REQ-2', 'refines: [REQ-1]\nverification: analysis\nevidence: [report.pdf]\n'),
  file('risks/RSK-1.md', 'RSK-1'),
  file('tests/TC-1.md', 'TC-1', 'verifies: [REQ-1]\nestimate: 30m\n'),
].map((f) => (f.path.startsWith('tests/') ? { ...f, text: f.text.replace('status: approved', 'status: ready') } : f));

describe('needs.json export', () => {
  const index = buildIndex(files, CONFIG);
  const json = JSON.parse(needsJson(index, { project: 'Demo', version: '2.4', created: new Date('2026-11-08T10:00:00Z') }));

  it('writes the Sphinx-Needs layout', () => {
    expect([json.project, json.current_version, Object.keys(json.versions), json.versions['2.4'].needs_amount]).toEqual(['Demo', '2.4', ['2.4'], 4]);
    expect(json.versions['2.4'].needs['REQ-1']).toEqual({
      id: 'REQ-1',
      type: 'req',
      type_name: 'Requirement',
      title: 'REQ-1 title',
      status: 'approved',
      tags: ['payments'],
      content: 'Retry **three** times.',
      docname: 'requirements/REQ-1',
      links: [],
      refines: [],
      mitigates: ['RSK-1'],
      verifies_back: ['TC-1'],
      refines_back: ['REQ-2'],
      priority: 'High',
    });
    const n = json.versions['2.4'].needs;
    expect([n['TC-1'].type, n['TC-1'].verifies, n['TC-1'].estimate, n['RSK-1'].type, n['RSK-1'].mitigates_back, n['REQ-2'].verification, n['REQ-2'].evidence]).toEqual([
      'test',
      ['REQ-1'],
      '30m',
      'risk',
      ['REQ-1'],
      'analysis',
      ['report.pdf'],
    ]);
  });

  it('reads back into the same items, links reviewed', () => {
    const empty = buildIndex([], CONFIG);
    const plan = planNeedsImport(needsJson(index, { project: 'Demo' }), empty);
    expect([...plan.files.keys()].sort()).toEqual(['requirements/REQ-1-req-1-title.md', 'requirements/REQ-2-req-2-title.md', 'risks/RSK-1-rsk-1-title.md', 'tests/TC-1-tc-1-title.md']);
    expect(plan.files.get('requirements/REQ-1-req-1-title.md')).toMatch(/^---\nid: REQ-1\ntitle: REQ-1 title\nstatus: approved\ncomponents: \[payments\]\nmitigates: \[RSK-1\]\npriority: High\nreviewed:\n {2}RSK-1: "\w+"\n---\nRetry \*\*three\*\* times\.\n$/);
    const again = buildIndex(
      [...plan.files].map(([path, text]) => ({ path, text })),
      CONFIG,
    );
    expect(again.problems).toEqual([]);
    const cov = coverage(again);
    expect([cov.suspect, cov.unreviewed, cov.suspectLinks, cov.unreviewedLinks, cov.suspectRefines].map((x) => x.length)).toEqual([0, 0, 0, 0, 0]);
    expect(again.byId.get('TC-1')!.estimate).toBe(30);
    expect(again.byId.get('REQ-2')!.verification).toBe('analysis');
  });
});

describe('needs.json import', () => {
  // As Sphinx-Needs writes it: generic `links`, a custom `tests` link, older `description`.
  const sphinx = JSON.stringify({
    current_version: '1.0',
    project: 'Other',
    versions: {
      '0.9': { needs: {} },
      '1.0': {
        needs: {
          R_001: { id: 'R_001', type: 'req', title: 'Login', status: 'open', tags: ['auth', 'payments'], description: 'Users log in.\n\n.. note:: legacy', links: [], links_back: ['S_001'], owner: 'Ana', lineno: 3 },
          S_001: { id: 'S_001', type: 'spec', type_name: 'Specification', title: 'Login form', status: null, content: 'A form.', links: ['R_001', 'X_404'] },
          T_001: { id: 'T_001', type: 'test', title: 'Log in', content: '', links: [], tests: ['S_001', 'R_001'], tests_back: [] },
          I_001: { id: 'I_001', type: 'impl', title: 'Code', content: '' },
        },
      },
    },
  });

  it('maps types and links it can, and reports the rest', () => {
    const index = buildIndex([], CONFIG);
    const plan = planNeedsImport(sphinx, index, { types: { spec: 'requirement' } });
    const r = plan.report;
    expect([r.version, r.needs]).toEqual(['1.0', 4]);
    expect(r.byType).toEqual([
      { from: 'req', to: 'requirement', count: 1 },
      { from: 'spec', to: 'requirement', count: 1 },
      { from: 'test', to: 'testcase', count: 1 },
      { from: 'impl', to: null, count: 1 },
    ]);
    // spec → req through `links`: only refines fits; test → spec/req through `tests`: verifies.
    expect(r.links).toEqual({ refines: 1, verifies: 2 });
    expect([r.dangling, r.unmapped, r.fieldsLeftOut, r.rst]).toEqual([1, [], { owner: 1 }, 1]);
    const req = plan.files.get('requirements/R_001-login.md')!;
    expect(req).toContain('components: [payments]\ntags: [auth]');
    expect(req).toContain('Users log in.');
    expect(plan.files.get('requirements/S_001-login-form.md')).toContain('status: draft\nrefines: [R_001]');
    expect(formatNeedsReport(r, index.config)).toContain('impl: 1 left out. Declare the type in trace.yml (types:), or map it with --type impl=requirement.');
  });

  it('keeps fields asked for, picks a version, and leaves existing IDs alone', () => {
    const index = buildIndex([file('requirements/R_001.md', 'R_001')], CONFIG);
    const plan = planNeedsImport(sphinx, index, { keepFields: ['owner'], types: { spec: 'requirement' } });
    expect(plan.report.existing).toEqual(['R_001']);
    expect(plan.files.has('requirements/R_001-login.md')).toBe(false);
    // S_001 still links to R_001, which is in the repository.
    expect(plan.files.get('requirements/S_001-login-form.md')).toContain('refines: [R_001]');
    expect(planNeedsImport(sphinx, buildIndex([], CONFIG), { version: '0.9' }).report.needs).toBe(0);
    expect(() => readNeedsFile(sphinx, '3.0')).toThrow("There's no version 3.0 in the file; it has 0.9, 1.0.");
    expect(() => readNeedsFile('{"a":1}')).toThrow('Not a needs.json: there are no versions in it.');
  });

  it('says when a link type is missing for a pair of types', () => {
    const plan = planNeedsImport(sphinx, buildIndex([], CONFIG), { types: { spec: 'risk' } });
    // spec is now a risk: risk → req through `links` has no link type (mitigates goes the
    // other way), and nor has test → risk through `tests`.
    expect(plan.report.unmapped).toEqual([
      { field: 'links', from: 'risk', to: 'requirement', count: 1 },
      { field: 'tests', from: 'testcase', to: 'risk', count: 1 },
    ]);
  });
});
