import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allElements, parseHtml, textLines } from '../src/core/html';
import { readDoorsHtml } from '../src/core/doorshtml';
import { formatReport, guessMap, mapToYaml, planImport, readMap } from '../src/core/doors';
import { parseConfig } from '../src/core/config';
import { buildIndex, coverage } from '../src/core/model';
import { readProjectFiles } from '../src/backend/service';
import { importReqif } from '../src/backend/cli';
import { decodeHtml } from '../src/backend/reqifz';
import { xhtmlToMarkdown } from '../src/core/xhtml';

// As DOORS 9 writes a module's view: upper-case tags, cells left open, a picture beside
// the file (with a Windows path), an OLE object drawn as a metafile.
const REQS = `<HTML><HEAD><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=windows-1252">
<TITLE>/Payments/Requirements/System Requirements</TITLE>
<STYLE>td { font: 10pt Arial }</STYLE></HEAD>
<BODY>
<TABLE BORDER=1 CELLSPACING=0>
<TR><TH>ID<TH>System Requirements<TH>Status<TH>Variant<TH>Out-links
<TR><TD>1<TD><B>1 Payments</B><TD><TD><TD>
<TR><TD>2<TD><P>When the gateway times out, the system shall retry up to <B>3</B> times.<TD>Approved<TD>Base<BR>Pro<TD>
<TR><TD>3<TD><H2>1.1 Invoices</H2><TD><TD><TD>
<TR><TD>4<TD><P>Invoices list:<UL><LI>the net amount<LI>the tax</UL>
<TABLE BORDER=1><TR><TD>Region<TD>Rate<TR><TD>EU<TD>20%</TABLE>
<P><IMG SRC="pics\\inv.png" ALT=layout><TD>Proposed<TD>Pro<TD>
<TR><TD>5<TD>Invoices shall show the tax line &ndash; per region&nbsp;<TD>Approved<TD>Base<TD>2
<TR><TD>6<TD><P>The gateway's states:<P><IMG SRC="ole1.wmf"><TD>Approved<TD>Base<TD>
</TABLE>
</BODY></HTML>`;

// The tests: separate heading and text columns, a header row of bold cells, links with
// and without the module's name.
const TESTS = `<html><head><title>System Tests</title></head><body>
<table>
<tr><td><b>Absolute Number</b></td><td><b>Object Heading</b></td><td><b>Object Text</b></td><td><b>Verifies</b></td></tr>
<tr><td>10</td><td>1 Retry</td><td></td><td></td></tr>
<tr><td>11</td><td></td><td>Pay while the gateway times out; check there are three retries.</td><td>System Requirements: 2</td></tr>
<tr><td>12</td><td></td><td>Tax line shows on the invoice</td><td>5<br>4</td></tr>
</table></body></html>`;

describe('reading HTML', () => {
  it('copes with HTML as old tools write it', () => {
    const { doc, title } = parseHtml('<HTML><TITLE>T &amp; U</TITLE><SCRIPT>if (a<b) x()</SCRIPT><P CLASS=x>one<P>two &copy 2026<UL><LI>a<LI>b</UL><TABLE><TR><TD>1<TD>2<TR><TD>3</TABLE></HTML>');
    expect(title).toBe('T & U');
    expect(textLines(doc.children)).toBe('one\ntwo © 2026\na\nb\n1 2\n3');
    expect(xhtmlToMarkdown(allElements(doc, 'html')[0].children, { image: () => null })).toBe('one\n\ntwo © 2026\n\n- a\n- b\n\n| 1 | 2 |\n| --- | --- |\n| 3 |  |');
  });

  it('reads the bytes in the charset declared, or as Windows-1252 when they are not UTF-8', () => {
    expect(decodeHtml(Buffer.from([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9]))).toBe('<p>café');
    expect(decodeHtml(Buffer.from('<p>café', 'utf8'))).toBe('<p>café');
    expect(decodeHtml(Buffer.concat([Buffer.from('<meta charset="iso-8859-1"><p>'), Buffer.from([0xe5])]))).toContain('<p>å');
  });
});

describe('DOORS modules exported as HTML', () => {
  const exp = readDoorsHtml([
    { name: 'reqs.htm', html: REQS, key: 'f0' },
    { name: 'tests.htm', html: TESTS, key: 'f1' },
  ]);
  const config = parseConfig(null).config;

  it('finds the modules, columns, headings and links', () => {
    expect(exp.reqif.specs.map((s) => s.name)).toEqual(['System Requirements', 'System Tests']);
    const notes = exp.notes.join('\n');
    expect(notes).toContain('“ID”: the ID');
    expect(notes).toContain('“System Requirements”: the main column: headings and text');
    expect(notes).toContain('“Out-links”: links');
    expect(notes).toContain('“Object Heading”: headings');
    expect(notes).toContain('“Verifies”: links');
    expect(exp.reqif.relations.map((r) => `${r.source}>${r.target}`)).toEqual(['m0:4>m0:1', 'm1:1>m0:1', 'm1:2>m0:4', 'm1:2>m0:3']);
    // 1 Payments > (2, 1.1 Invoices > (4, 5, 6))
    const tree = (ns: (typeof exp.reqif.specs)[0]['children']): unknown[] => ns.map((n) => (n.children.length ? [n.object, tree(n.children)] : n.object));
    expect(tree(exp.reqif.specs[0].children)).toEqual([['m0:0', ['m0:1', ['m0:2', ['m0:3', 'm0:4', 'm0:5']]]]]);
    expect(exp.reqif.objects.get('m0:0')!.values.get('Object Heading')!.text).toBe('Payments');
    expect(exp.reqif.objects.get('m0:1')!.values.get('Variant')!.enums).toEqual(['Base', 'Pro']);
  });

  it('imports them like a ReqIF export: files, links, pictures and the module outline', () => {
    const map = guessMap(exp.reqif, config);
    expect(map.modules['System Tests'].kind).toBe('testcase');
    expect(map.attributes.status).toBe('Status');
    const png = new Uint8Array([137, 80, 78, 71]);
    const plan = planImport(exp.reqif, map, config, { attachment: (p) => (p === 'f0/pics/inv.png' ? png : null) });
    const file = (start: string) => [...plan.files].find(([p]) => p.startsWith(start))?.[1] as string;

    const r2 = file('requirements/REQ-2-');
    expect(r2).toContain('title: When the gateway times out, the system shall retry up to 3 times');
    expect(r2).toContain('status: approved');
    expect(r2).toContain('variants: [base, pro]');
    expect(r2).toContain('section: 1 Payments');
    expect(r2).toContain('retry up to **3** times.');

    const r4 = file('requirements/REQ-4-');
    expect(r4).toContain('- the net amount\n- the tax');
    expect(r4).toContain('| Region | Rate |');
    expect(r4).toContain('![layout](images/REQ-4.png)');
    expect(plan.files.get('requirements/images/REQ-4.png')).toBe(png);

    expect(file('requirements/REQ-5-')).toContain('refines: [REQ-2]');
    expect(file('requirements/REQ-5-')).toContain('the tax line – per region');
    expect(file('requirements/REQ-6-')).toContain('*(picture not imported: ole1.wmf)*');
    expect(plan.report.images.notShown).toEqual(['REQ-6: ole1.wmf']);

    expect(file('tests/TC-11-')).toContain('verifies: [REQ-2]');
    expect(file('tests/TC-12-')).toContain('verifies: [REQ-5, REQ-4]');
    expect(plan.files.get('requirements/README.md')).toContain('## 1 Payments');
    expect(plan.files.get('requirements/README.md')).toContain('### 1.1 Invoices');
    expect(plan.files.get('tests/README.md')).toContain('## 1 Retry');
  });

  it('puts test steps (linked to their test case in the same module) in the test case’s Steps list', () => {
    const steps = readDoorsHtml([
      { name: 'reqs.htm', html: REQS, key: 'f0' },
      {
        name: 'runs.htm',
        key: 'f1',
        html: `<html><head><title>Payment Tests</title></head><body><table>
<tr><th>Absolute Number<th>Payment Tests<th>Links
<tr><td>30<td><b>1 Retry</b><td>
<tr><td>31<td>Retry on a gateway timeout<td>System Requirements: 2
<tr><td>32<td>Make the gateway <b>time out</b><td>31
<tr><td>33<td><p>Pay an invoice<p>with tax<td>31<br>System Requirements: 5
<tr><td>34<td>Check there are three retries<td>31
<tr><td>35<td>Invoice tax line<td>System Requirements: 5
</table></body></html>`,
      },
    ]);
    const map = guessMap(steps.reqif, config);
    const plan = planImport(steps.reqif, map, config, { attachment: () => null });
    const file = (start: string) => [...plan.files].find(([p]) => p.startsWith(start))?.[1] as string | undefined;
    const tc31 = file('tests/TC-31-')!;
    expect(tc31).toContain('## Steps\n\n1. Make the gateway **time out**\n2. Pay an invoice with tax\n3. Check there are three retries\n');
    // The step's own link to a requirement is its test case's.
    expect(tc31).toContain('verifies: [REQ-2, REQ-5]');
    expect(file('tests/TC-32-')).toBeUndefined();
    expect(file('tests/TC-35-')).toContain('verifies: [REQ-5]');
    expect(plan.files.get('tests/README.md')).not.toContain('TC-32');
    expect(plan.report.links.odd).toEqual([]);
    expect(plan.report.links.steps).toBe(3);
    expect(formatReport(plan.report)).toContain('2 items, 1 heading, 0 information objects, 3 test steps (in their test cases)');
  });

  it('takes the variants from the column the map names, and says when the map names a column that isn’t there', () => {
    const map = guessMap(exp.reqif, config);
    // Status as the variants column, one value per line in a cell.
    const plan = planImport(exp.reqif, { ...map, attributes: { ...map.attributes, variants: 'Status' } }, config, { attachment: () => null });
    const r2 = [...plan.files].find(([p]) => p.startsWith('requirements/REQ-2-'))![1] as string;
    expect(r2).toContain('variants: [approved]');
    const typo = planImport(exp.reqif, { ...map, attributes: { ...map.attributes, variants: 'Varaint', keep: ['Owner'] } }, config, { attachment: () => null });
    expect(typo.report.missingAttributes).toEqual(['variants: “Varaint”', 'keep: “Owner”']);
    expect(formatReport(typo.report)).toContain('Not in the export (check the names in the map\'s attributes): variants: “Varaint”, keep: “Owner”');
  });

  it('reads a variant value meaning every variant ("All") as no variants list', () => {
    const all = readDoorsHtml([{ name: 'reqs.htm', html: REQS.replace('<TD>Proposed<TD>Pro<TD>', '<TD>Proposed<TD>All<TD>'), key: 'f0' }]);
    const map = guessMap(all.reqif, config);
    expect(map.values.variants).toEqual({ Base: 'base', Pro: 'pro', All: '*' });
    expect(mapToYaml(map, all.reqif)).toMatch(/All: ["']\*["']/);
    const plan = planImport(all.reqif, map, config, { attachment: () => null });
    const file = (start: string) => [...plan.files].find(([p]) => p.startsWith(start))![1] as string;
    expect(file('requirements/REQ-4-')).not.toContain('variants:');
    expect(file('requirements/REQ-2-')).toContain('variants: [base, pro]');
    expect(plan.report.unknownVariants).toEqual([]);
    // Written by hand as "All:" (no value) or "All: '*'", it means the same.
    expect(readMap('values:\n  variants:\n    All:\n    Base: base\n', map).values.variants).toMatchObject({ All: '*', Base: 'base' });
    expect(readMap("values:\n  variants:\n    All: '*'\n", map).values.variants).toEqual({ All: '*' });
  });

  it('says when the export is not a table', () => {
    expect(() => readDoorsHtml([{ name: 'doc.htm', html: '<h1>Spec</h1><p>Text only</p>', key: 'f0' }])).toThrow(/no table/);
  });
});

describe('import-html on the command line', () => {
  it('reads the files and the pictures beside them, and imports into a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracey-html-'));
    const repo = join(dir, 'repo');
    mkdirSync(join(dir, 'pics'));
    writeFileSync(join(dir, 'pics', 'inv.png'), Buffer.from([137, 80, 78, 71]));
    writeFileSync(join(dir, 'reqs.htm'), Buffer.from(REQS, 'latin1'));
    writeFileSync(join(dir, 'tests.htm'), TESTS);
    mkdirSync(repo);
    const log: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => log.push(a.join(' '));
    try {
      expect(await importReqif(['import-html', join(dir, 'reqs.htm'), join(dir, 'tests.htm'), '--into', repo])).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(log.join('\n')).toContain('“Verifies”: links');
    expect(existsSync(join(repo, 'requirements/images/REQ-4.png'))).toBe(true);
    expect(readFileSync(join(repo, 'trace.yml'), 'utf8')).toContain('prefix: REQ-');
    const { config, files } = await readProjectFiles(repo);
    const cov = coverage(buildIndex(files, config));
    expect(cov.requirements.map((r) => r.id).sort()).toEqual(['REQ-2', 'REQ-4', 'REQ-5', 'REQ-6']);
    expect(cov.untested.map((r) => r.id).sort()).toEqual(['REQ-6']);
  });
});
