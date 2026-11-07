import { describe, expect, it } from 'vitest';
import { buildIndex, fingerprint } from '../src/core/model';
import { bulkChanges, emptyEdit } from '../src/core/bulk';

const CONFIG = 'requirements: { dir: requirements }\ntestcases: { dir: tests }\ncomponents: { pay: [src/pay], ui: [src/ui] }\nfields:\n  priority: [Low, High]\n  platforms: { values: [Linux, Windows], multiple: true }\n';
const file = (id: string, extra: string, body = '') => ({ path: `${id.startsWith('TC') ? 'tests' : 'requirements'}/${id}.md`, text: `---\nid: ${id}\ntitle: ${id}\nstatus: draft\n${extra}---\n${body}` });
const index = buildIndex(
  [
    file('REQ-01', 'components: [pay]\npriority: High\n', 'Retry.\n'),
    file('REQ-02', 'components: [pay, ui]\nplatforms: [Linux]\n', 'Export.\n'),
    file('TC-001', 'verifies: [REQ-01]\nreviewed: { REQ-01: old }\n'),
    file('TC-002', ''),
  ],
  CONFIG,
);
const items = (...ids: string[]) => ids.map((id) => index.byId.get(id)!);
const result = (m: Map<string, Record<string, unknown>>) => Object.fromEntries([...m].map(([p, c]) => [p.replace(/^.*\//, '').replace('.md', ''), c]));

describe('changing many items at once', () => {
  it('sets a field, leaving out items that already have it', () => {
    const e = { ...emptyEdit(), set: { status: 'approved', priority: 'High' } };
    expect(result(bulkChanges(items('REQ-01', 'REQ-02'), e, index))).toEqual({ 'REQ-01': { status: 'approved' }, 'REQ-02': { status: 'approved', priority: 'High' } });
  });
  it('clears a field', () => {
    expect(result(bulkChanges(items('REQ-01', 'REQ-02'), { ...emptyEdit(), set: { priority: null } }, index))).toEqual({ 'REQ-01': { priority: undefined } });
  });
  it('adds and removes values in lists, and drops a list left empty', () => {
    const e = { ...emptyEdit(), add: { components: ['ui'], platforms: ['Windows'] }, remove: { components: ['pay'] } };
    expect(result(bulkChanges(items('REQ-01', 'REQ-02'), e, index))).toEqual({
      'REQ-01': { components: ['ui'], platforms: ['Windows'] },
      'REQ-02': { components: ['ui'], platforms: ['Linux', 'Windows'] },
    });
    expect(result(bulkChanges(items('REQ-01'), { ...emptyEdit(), remove: { components: ['pay'] } }, index))).toEqual({ 'REQ-01': { components: undefined } });
  });
  it('links test cases as reviewed now, and forgets the review of a link removed', () => {
    const add = bulkChanges(items('TC-001', 'TC-002'), { ...emptyEdit(), add: { verifies: ['REQ-02', 'REQ-01'] } }, index);
    const fp = (id: string) => fingerprint(index.byId.get(id)!);
    expect(result(add)).toEqual({
      'TC-001': { verifies: ['REQ-01', 'REQ-02'], reviewed: { 'REQ-01': 'old', 'REQ-02': fp('REQ-02') } },
      'TC-002': { verifies: ['REQ-02', 'REQ-01'], reviewed: { 'REQ-02': fp('REQ-02'), 'REQ-01': fp('REQ-01') } },
    });
    expect(result(bulkChanges(items('TC-001'), { ...emptyEdit(), remove: { verifies: ['REQ-01'] } }, index))).toEqual({ 'TC-001': { verifies: undefined, reviewed: undefined } });
    // Requirements don't verify anything.
    expect(bulkChanges(items('REQ-01'), { ...emptyEdit(), add: { verifies: ['REQ-02'] } }, index).size).toBe(0);
  });
});
