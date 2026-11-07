import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/core/model';
import { changeCounts, changesHtml, compareVersions, countsText, untouchedTests } from '../src/core/changes';

const CONFIG = 'requirements: { dir: requirements }\ntestcases: { dir: tests }\n';
const req = (id: string, body: string, extra = '', dir = 'requirements') => ({ path: `${dir}/${id}.md`, text: `---\nid: ${id}\ntitle: Title of ${id}\nstatus: approved\n${extra}---\n${body}\n` });
const tc = (id: string, verifies: string, body = 'Steps.', extra = '') => ({ path: `tests/${id}.md`, text: `---\nid: ${id}\ntitle: Test ${id}\nstatus: ready\nverifies: [${verifies}]\n${extra}---\n${body}\n` });

const old = buildIndex(
  [
    req('REQ-01', 'Retry three times.\n\nThen stop.'),
    req('REQ-02', 'Show the tax line.'),
    req('REQ-03', 'Old feature.'),
    req('REQ-04', 'Unchanged.'),
    tc('TC-01', 'REQ-01'),
    tc('TC-02', 'REQ-02', 'Steps.', 'reviewed: { REQ-02: aaa }\n'),
  ],
  CONFIG,
);
const now = buildIndex(
  [
    req('REQ-01', 'Retry five times.\n\nThen stop.'), // text changed; its test didn't
    req('REQ-02', 'Show the tax line.', 'components: [billing]\n'), // a field changed
    req('REQ-04', 'Unchanged.', '', 'requirements/moved'), // moved: the same item
    req('REQ-05', 'A new one.'),
    tc('TC-01', 'REQ-01'),
    tc('TC-02', 'REQ-02', 'Steps.', 'reviewed: { REQ-02: bbb }\n'), // only the review fingerprint: not a change
    tc('TC-03', 'REQ-05'),
  ],
  CONFIG,
);

describe('what changed between two versions', () => {
  const changes = compareVersions(old, now);
  it('lists added, changed and removed items by ID, requirements first', () => {
    expect(changes.map((c) => `${c.id}:${c.change}`)).toEqual(['REQ-05:added', 'REQ-01:changed', 'REQ-02:changed', 'REQ-03:removed', 'TC-03:added']);
    expect(changeCounts(changes, 'requirement')).toEqual({ added: 1, changed: 2, removed: 1 });
    expect(countsText(changeCounts(changes, 'testcase'))).toBe('1 added');
    expect(countsText({ added: 0, changed: 0, removed: 0 })).toBe('no changes');
  });
  it('says what changed in an item', () => {
    const r1 = changes.find((c) => c.id === 'REQ-01')!;
    expect([r1.textChanged, r1.fields]).toEqual([true, []]);
    const r2 = changes.find((c) => c.id === 'REQ-02')!;
    expect([r2.textChanged, r2.fields.map((f) => `${f.label}: ${f.old} → ${f.new}`)]).toEqual([false, ['Components:  → billing']]);
  });
  it('flags requirements whose text changed while their tests didn’t', () => {
    const r1 = changes.find((c) => c.id === 'REQ-01')!;
    expect(r1.tests).toEqual([{ id: 'TC-01', changed: false }]);
    expect(changes.filter(untouchedTests).map((c) => c.id)).toEqual(['REQ-01']);
  });
  it('makes a document with the summary and the differences', () => {
    const html = changesHtml(changes, { title: 'Changes', from: 'Release v2.3.0', to: 'Release v2.4.0', meta: [['Repository', 'demo']], image: (_p, s) => s });
    expect(html).toContain('<tr><td>Requirements</td><td>1</td><td>2</td><td>1</td></tr>');
    expect(html).toContain('<del>three</del>');
    expect(html).toContain('<ins>five</ins>');
    expect(html).toContain('1 unchanged paragraph');
    expect(html).toContain('<span class="pill warn">tests not updated</span>');
    expect(html).toContain('Removed. Last status: approved.');
    expect(compareVersions(now, now)).toEqual([]);
    expect(changesHtml([], { title: 'C', from: 'a', to: 'b', meta: [], image: (_p, s) => s })).toContain('Nothing changed');
  });
});
