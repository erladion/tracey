import { describe, expect, it } from 'vitest';
import { buildIndex, coverage, fingerprint, globToRegExp, linkState, newItemPath, newItemText, nextId } from '../src/core/model';
import { setFields, splitFrontMatter } from '../src/core/frontmatter';

const req = `---
id: REQ-07
title: Payment retry after gateway timeout
status: approved
components: [payments]
jira: [PROJ-466]
---
When the payment gateway times out, the system retries
up to 3 times with increasing delay before failing.
`;
const tc = (reviewed?: string) => `---
id: TC-102
title: Payment stops after 3 retries
verifies: [REQ-07, REQ-99]
components: [payments]
${reviewed ? `reviewed:\n  REQ-07: "${reviewed}"\n` : ''}---
## Steps
1. Configure the gateway stub to time out.
`;
const config = 'components:\n  payments: { name: Payments, paths: ["src/payments/**"] }\n  export: ["src/export/**"]\n';

describe('model', () => {
  it('reads items, links and problems', () => {
    const idx = buildIndex([{ path: 'requirements/r7.md', text: req }, { path: 'tests/t102.md', text: tc() }, { path: 'requirements/REQ-08.md', text: '---\nid: REQ-07\ntitle: Dup\n---\n' }], config);
    expect(idx.items.map((i) => i.id)).toEqual(['REQ-07', 'REQ-07', 'TC-102']);
    expect(idx.verifiedBy.get('REQ-07')!.map((t) => t.id)).toEqual(['TC-102']);
    const codes = idx.problems.map((p) => p.code).sort();
    expect(codes).toEqual(['broken-link', 'duplicate-id', 'duplicate-id']);
    const cov = coverage(idx);
    expect(cov.componentsWithoutTests.map((c) => c.key)).toEqual(['export']);
    expect(nextId(idx, 'requirement')).toBe('REQ-08');
    expect(nextId(idx, 'testcase')).toBe('TC-103');
  });

  it('marks links suspect when the requirement text changes', () => {
    const r = buildIndex([{ path: 'r.md', text: req }], null).items[0];
    const fp = fingerprint(r);
    const idx = buildIndex([{ path: 'r.md', text: req }, { path: 't.md', text: tc(fp) }], null);
    expect(linkState(idx.byId.get('TC-102')!, idx.byId.get('REQ-07')!)).toBe('ok');
    const idx2 = buildIndex([{ path: 'r.md', text: req.replace('3 times', '5 times') }, { path: 't.md', text: tc(fp) }], null);
    expect(linkState(idx2.byId.get('TC-102')!, idx2.byId.get('REQ-07')!)).toBe('suspect');
    expect(coverage(idx2).suspect).toHaveLength(1);
  });

  it('edits front matter keeping its style', () => {
    const { front } = splitFrontMatter(req);
    const out = setFields(front, { status: 'draft', components: ['payments', 'billing'], jira: [] });
    expect(out).toBe('id: REQ-07\ntitle: Payment retry after gateway timeout\nstatus: draft\ncomponents: [payments, billing]\n');
  });

  it('creates new items', () => {
    const idx = buildIndex([{ path: 'requirements/REQ-01-x.md', text: '---\nid: REQ-01\ntitle: x\n---\n' }], null);
    expect(newItemPath(idx, 'requirement', 'REQ-02', 'Export invoices: as PDF!')).toBe('requirements/REQ-02-export-invoices-as-pdf.md');
    const text = newItemText('testcase', { id: 'TC-001', title: 'A: b', status: 'draft', verifies: ['REQ-01'] });
    const parsed = buildIndex([{ path: 'tests/a.md', text }], null).items[0];
    expect(parsed.title).toBe('A: b');
    expect(parsed.verifies).toEqual(['REQ-01']);
  });

  it('matches component globs', () => {
    expect(globToRegExp('src/payments/**').test('src/payments/a/b.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/x.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/x.ts')).toBe(false);
  });
});
