import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/core/model';
import { fieldText, matchesSearch, otherFields } from '../src/core/fields';

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
