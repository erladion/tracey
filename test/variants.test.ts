import { describe, expect, it } from 'vitest';
import { appliesTo, buildIndex, coverage, forVariant, linksOf, variantNames } from '../src/core/model';
import { parseConfig } from '../src/core/config';
import { newRunText, readRun } from '../src/core/runs';
import { trend } from '../src/core/trend';
import { tables } from '../src/core/spreadsheet';

const CONFIG = 'requirements: { dir: requirements }\ntestcases: { dir: tests }\nvariants:\n  base: { name: Base }\n  pro: { name: Pro }\n  eu: EU\n';
const req = (id: string, variants = '') => ({ path: `requirements/${id}.md`, text: `---\nid: ${id}\ntitle: ${id}\nstatus: approved\n${variants ? `variants: [${variants}]\n` : ''}---\nText.\n` });
const tc = (id: string, verifies: string, variants = '') => ({
  path: `tests/${id}.md`,
  text: `---\nid: ${id}\ntitle: ${id}\nstatus: ready\nverifies: [${verifies}]\n${variants ? `variants: [${variants}]\n` : ''}---\n`,
});

const index = buildIndex(
  [
    req('REQ-01'), // all variants, tested everywhere
    req('REQ-02'), // all variants, tested only on EU
    req('REQ-03', 'pro'), // Pro only
    tc('TC-001', 'REQ-01'),
    tc('TC-002', 'REQ-02', 'eu'),
    tc('TC-003', 'REQ-03'), // all variants, verifying a Pro requirement: fine
    tc('TC-004', 'REQ-03', 'base'), // Base can never meet Pro
    tc('TC-005', 'REQ-01', 'gold'), // unknown variant
  ],
  CONFIG,
);

describe('variants', () => {
  it('are read from trace.yml, as a map or a list', () => {
    expect(index.config.variants).toEqual([
      { key: 'base', name: 'Base' },
      { key: 'pro', name: 'Pro' },
      { key: 'eu', name: 'EU' },
    ]);
    expect(parseConfig('variants: [a, b]').config.variants.map((v) => v.key)).toEqual(['a', 'b']);
  });

  it('apply to everything unless an item says otherwise', () => {
    expect(appliesTo(index.byId.get('REQ-01')!, 'pro')).toBe(true);
    expect(appliesTo(index.byId.get('REQ-03')!, 'base')).toBe(false);
    expect(variantNames(index.config, index.byId.get('REQ-03')!)).toBe('Pro');
    expect(variantNames(index.config, index.byId.get('REQ-01')!)).toBe('All variants');
  });

  it('flag unknown variants and tests that can never verify their requirement', () => {
    const p = index.problems.map((x) => `${x.code}:${x.id}`);
    expect(p).toContain('unknown-variant:TC-005');
    expect(p).toContain('variant-mismatch:TC-004');
    expect(p).not.toContain('variant-mismatch:TC-003');
  });

  it('count coverage per variant', () => {
    const tested = (v: string) =>
      coverage(forVariant(index, v))
        .tested.map((r) => r.id)
        .join(' ');
    expect(tested('eu')).toBe('REQ-01 REQ-02');
    expect(tested('base')).toBe('REQ-01'); // REQ-02 is only tested on EU; REQ-03 isn't Base's
    expect(tested('pro')).toBe('REQ-01 REQ-03');
    expect(coverage(forVariant(index, 'base')).untested.map((r) => r.id)).toEqual(['REQ-02']);
  });

  it('show one variant only its own items and links', () => {
    const pro = forVariant(index, 'pro');
    expect(pro.items.map((i) => i.id)).toEqual(['REQ-01', 'REQ-02', 'REQ-03', 'TC-001', 'TC-003']);
    expect(linksOf(pro, pro.byId.get('REQ-03')!).map((l) => l.test.id)).toEqual(['TC-003']);
    // Problems of items the variant doesn't have aren't shown.
    expect(pro.problems.some((x) => x.id === 'TC-004')).toBe(false);
  });

  it('are recorded on test runs, shown in the trend and in exports', () => {
    const text = newRunText({ name: 'R', created: '2026-11-07', from: null, to: null, codeCommit: null, commitCount: null, requirementsCommit: 'abc', variant: 'pro', issues: [], gaps: { requirementsWithoutTests: [], componentsWithoutTests: [], issuesWithoutRequirement: [] }, cases: [{ id: 'TC-003', reason: [] }] });
    const run = readRun('test-runs/r.yml', text);
    expect(run.variant).toBe('pro');
    expect(readRun('x.yml', 'name: X\n').variant).toBeNull();
    const pts = trend([run], () => forVariant(index, 'pro'), forVariant(index, 'pro'), '2026-11-08');
    expect(pts[0].coverage).toMatchObject({ requirements: 3, tested: 2 });
    const t = tables(index, { obsolete: false, component: null, runs: [run] });
    expect(t.runs.rows[0][t.runs.columns.findIndex((c) => c.header === 'Variant')]).toBe('Pro');
    expect(t.requirements.rows.find((r) => r[0] === 'REQ-03')![t.requirements.columns.findIndex((c) => c.header === 'Variants')]).toBe('Pro');
  });
});
