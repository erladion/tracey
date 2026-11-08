import { describe, expect, it } from 'vitest';
import { buildIndex, type SourceFile } from '../src/core/model';
import { addEntries, testsFor } from '../src/core/worklist';

const req = (id: string, front = ''): SourceFile => ({ path: `requirements/${id}.md`, text: `---\nid: ${id}\ntitle: ${id}\nstatus: draft\n${front}---\n` });
const test = (id: string, verifies: string[], status = 'ready'): SourceFile => ({ path: `tests/${id}.md`, text: `---\nid: ${id}\ntitle: ${id}\nstatus: ${status}\nverifies: [${verifies.join(', ')}]\n---\n` });

// REQ-10 is broken down into REQ-1 and REQ-2; REQ-2 into REQ-3 (and back into REQ-2: a loop).
const index = buildIndex(
  [
    req('REQ-10'),
    req('REQ-1', 'refines: [REQ-10]\n'),
    req('REQ-2', 'refines: [REQ-10, REQ-3]\n'),
    req('REQ-3', 'refines: [REQ-2]\n'),
    test('TC-1', ['REQ-1']),
    test('TC-2', ['REQ-2', 'REQ-10']),
    test('TC-3', ['REQ-3']),
    test('TC-9', ['REQ-3'], 'obsolete'),
  ],
  null,
);

describe('the work list', () => {
  it('takes a test as it is, and a requirement as its tests and its refinements’ tests', () => {
    expect(testsFor(index, [index.byId.get('TC-1')!])).toEqual([{ id: 'TC-1', reason: 'Picked by hand' }]);
    expect(testsFor(index, [index.byId.get('REQ-10')!])).toEqual([
      { id: 'TC-2', reason: 'Verifies REQ-10' },
      { id: 'TC-1', reason: 'Verifies REQ-1, which refines REQ-10' },
      { id: 'TC-3', reason: 'Verifies REQ-3, which refines REQ-10' },
    ]);
    // A loop of refinements ends; obsolete tests stay out.
    expect(testsFor(index, [index.byId.get('REQ-3')!]).map((e) => e.id)).toEqual(['TC-3', 'TC-2']);
  });

  it('adds only what isn’t in it yet, at the end', () => {
    const list = addEntries([{ id: 'TC-2', reason: 'a' }], [{ id: 'TC-1', reason: 'b' }, { id: 'TC-2', reason: 'c' }, { id: 'TC-1', reason: 'd' }]);
    expect(list).toEqual([
      { id: 'TC-2', reason: 'a' },
      { id: 'TC-1', reason: 'b' },
    ]);
  });
});
