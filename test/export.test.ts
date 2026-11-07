import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex } from '../src/core/model';
import { readRun } from '../src/core/runs';
import { trend } from '../src/core/trend';
import { tables } from '../src/core/spreadsheet';
import { columnName, csv, xlsx, zip } from '../src/core/xlsx';
import { readProjectFilesAt } from '../src/backend/service';

const req = (id: string, status = 'approved') => ({ path: `requirements/${id}.md`, text: `---\nid: ${id}\ntitle: Title of ${id}\nstatus: ${status}\n---\nText of ${id}.\n` });
const tc = (id: string, verifies: string[], extra = '') => ({ path: `tests/${id}.md`, text: `---\nid: ${id}\ntitle: Test ${id}\nstatus: ready\nverifies: [${verifies.join(', ')}]\n${extra}---\n## Steps\n` });
const CONFIG = 'requirements: { dir: requirements }\ntestcases: { dir: tests }\n';

const old = buildIndex([req('REQ-01'), req('REQ-02'), tc('TC-001', ['REQ-01'])], CONFIG);
const now = buildIndex([req('REQ-01'), req('REQ-02'), req('REQ-03', 'obsolete'), tc('TC-001', ['REQ-01']), tc('TC-002', ['REQ-02'])], CONFIG);
const run1 = readRun('test-runs/r1.yml', 'name: Release 1.0\ncreated: 2026-09-01\nrequirements-commit: aaa\ncode: { to: v1.0 }\ncases:\n  TC-001: { result: failed, tester: Ana, date: 2026-09-02, note: "=SUM(A1)" }\n');
const run2 = readRun('test-runs/r2.yml', 'name: Release 2.0\ncreated: 2026-10-01\nrequirements-commit: bbb\ncases:\n  TC-001: { result: passed }\n  TC-002: { result: passed }\n');
const run3 = readRun('test-runs/r3.yml', 'name: Smoke\ncreated: 2026-10-15\ncases:\n  TC-002: { result: not-run }\n');

describe('coverage over time', () => {
  const points = trend([run2, run3, run1], (r) => (r.requirementsCommit === 'aaa' ? old : r.requirementsCommit === 'bbb' ? now : null), now, '2026-11-07');
  it('has a point per run, oldest first, then now', () => {
    expect(points.map((p) => p.label)).toEqual(['Release 1.0', 'Release 2.0', 'Smoke', 'Now']);
  });
  it('counts coverage with the requirements of the time, and requirements passing in the run', () => {
    expect(points[0]).toMatchObject({ version: 'v1.0', coverage: { requirements: 2, tested: 1, suspect: 0 }, passing: 0, results: { failed: 1, total: 1 } });
    expect(points[1]).toMatchObject({ coverage: { requirements: 2, tested: 2 }, passing: 2 });
    expect(points[2]).toMatchObject({ coverage: null, passing: null, results: { notRun: 1 } });
    expect(points[3]).toMatchObject({ date: '2026-11-07', run: null, results: null, coverage: { requirements: 2, tested: 2 } });
  });
});

describe('spreadsheet tables', () => {
  const t = tables(now, { obsolete: false, component: null, runs: [run2, run1], trend: null });
  it('lists requirements with their tests, coverage and last results', () => {
    expect(t.requirements.rows.map((r) => r.slice(0, 1))).toEqual([['REQ-01'], ['REQ-02']]);
    const col = (h: string) => t.requirements.columns.findIndex((c) => c.header === h);
    const r1 = t.requirements.rows[0];
    expect(r1[col('Test cases')]).toBe('TC-001');
    expect(r1[col('Covered')]).toBe('Yes');
    expect(r1[col('Variants')]).toBe('All variants');
    expect(r1[col('Last results')]).toBe('TC-001: passed (Release 2.0)');
  });
  it('makes a matrix of requirements and the tests that verify them', () => {
    expect(t.matrix.columns.map((c) => c.header)).toEqual(['Requirement', 'Title', 'TC-001', 'TC-002']);
    expect(t.matrix.rows.map((r) => r.slice(2))).toEqual([
      ['not reviewed', null],
      [null, 'not reviewed'],
    ]);
  });
  it('lists every result, and includes obsolete items only when asked', () => {
    expect(t.results.rows.map((r) => `${r[0]}:${r[2]}:${r[5]}`)).toEqual(['Release 2.0:TC-001:passed', 'Release 2.0:TC-002:passed', 'Release 1.0:TC-001:failed']);
    expect(tables(now, { obsolete: true, component: null, runs: [] }).requirements.rows).toHaveLength(3);
  });
});

describe('CSV', () => {
  it('quotes what needs it and never lets a cell run as a formula', () => {
    const out = csv({ name: 'x', columns: [{ header: 'A', width: 1 }, { header: 'B', width: 1 }, { header: 'C', width: 1 }], rows: [['say "hi", ok', '=SUM(A1)', { pct: 0.5 }], [3, null, 'two\nlines']] });
    expect(out).toBe('﻿A,B,C\r\n"say ""hi"", ok",\'=SUM(A1),50%\r\n3,,"two\nlines"\r\n');
  });
});

describe('Excel workbook', () => {
  it('names columns like Excel', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });

  it('is a zip that unzip accepts, with well-formed parts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-xlsx-'));
    const t = tables(now, { obsolete: false, component: null, runs: [run2, run1], trend: trend([run1], () => old, now) });
    const book = xlsx([t.requirements, t.matrix, t.results, t.trend, { name: 'Odd: name/with*chars?', columns: [{ header: 'X', width: 5 }], rows: [['<&> "\u0001']] }], { title: 'T & R' });
    writeFileSync(join(dir, 'b.xlsx'), book);
    const list = execFileSync('unzip', ['-Z1', join(dir, 'b.xlsx')]).toString().trim().split('\n');
    expect(list).toContain('xl/worksheets/sheet5.xml');
    execFileSync('unzip', ['-tq', join(dir, 'b.xlsx')]); // CRCs check out
    const script = `import zipfile,sys,xml.dom.minidom as m
z=zipfile.ZipFile(sys.argv[1])
for n in z.namelist(): m.parseString(z.read(n))
w=z.read('xl/workbook.xml').decode()
print(w[w.index('<sheets>'):w.index('</sheets>')])
print(z.read('xl/worksheets/sheet5.xml').decode())`;
    const out = execFileSync('python3', ['-I', '-c', script, join(dir, 'b.xlsx')]).toString();
    expect(out).toContain('name="Odd  name with chars"');
    expect(out).toContain('<t>&lt;&amp;&gt; &quot;</t>');
    expect(out).toContain('<autoFilter ref="A1:A2"/>');
  });

  it('zips several files that unzip reads back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-zip-'));
    writeFileSync(join(dir, 'z.zip'), zip([{ name: 'a/b.txt', data: new TextEncoder().encode('hello') }, { name: 'c.txt', data: new Uint8Array() }]));
    expect(execFileSync('unzip', ['-p', join(dir, 'z.zip'), 'a/b.txt']).toString()).toBe('hello');
  });
});

describe('the requirements at a commit', () => {
  it('reads items from git as they were, ignoring other files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-at-'));
    const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, env }).toString().trim();
    g('init', '-q');
    mkdirSync(join(dir, 'requirements'));
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'trace.yml'), CONFIG);
    for (const f of [req('REQ-01'), tc('TC-001', ['REQ-01'])]) writeFileSync(join(dir, f.path), f.text);
    writeFileSync(join(dir, 'requirements/notes.md'), 'no front matter\n');
    writeFileSync(join(dir, 'README.md'), '---\nid: REQ-99\n---\n');
    g('add', '.');
    g('commit', '-qm', 'one');
    const first = g('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'requirements/REQ-02.md'), req('REQ-02').text);
    g('add', '.');
    g('commit', '-qm', 'two');

    const at = await readProjectFilesAt(dir, first);
    expect(at!.config).toBe(CONFIG);
    expect(at!.files.map((f) => f.path).sort()).toEqual(['requirements/REQ-01.md', 'tests/TC-001.md']);
    expect(at!.files[0].text).toContain('Text of REQ-01.');
    expect((await readProjectFilesAt(dir, g('rev-parse', 'HEAD')))!.files).toHaveLength(3);
    expect(await readProjectFilesAt(dir, 'deadbeef')).toBeNull();
    expect(await readProjectFilesAt(dir, '--output=x')).toBeNull();
  });
});
