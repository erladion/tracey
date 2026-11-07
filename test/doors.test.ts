import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseXml, XmlError } from '../src/core/xml';
import { readReqif, walkSpec } from '../src/core/reqif';
import { xhtmlToMarkdown } from '../src/core/xhtml';
import { guessMap, planImport, readMap } from '../src/core/doors';
import { parseConfig } from '../src/core/config';
import { buildIndex, coverage, linksOf } from '../src/core/model';
import { readProjectFiles } from '../src/backend/service';
import { importReqif } from '../src/backend/cli';
import { readExport } from '../src/backend/reqifz';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/doors9.reqif'), 'utf8');
const md = (xhtml: string, image = (d: string) => `img/${d}`) => xhtmlToMarkdown(parseXml(`<x xmlns:xhtml="h">${xhtml}</x>`).children, { image });

describe('reading XML', () => {
  it('reads elements, attributes, entities and CDATA, and says where it breaks', () => {
    const d = parseXml('<?xml version="1.0"?><!-- c --><a x="1 &amp; 2"><b>t &lt; u &#x41;</b><![CDATA[<raw>]]></a>');
    expect(d.attrs.x).toBe('1 & 2');
    expect(d.children.map((c) => (c.type === 'el' ? c.name : c.text))).toEqual(['b', '<raw>']);
    expect(() => parseXml('<a>\n<b></a>')).toThrow(XmlError);
    expect(() => parseXml('<a>\n<b></a>')).toThrow(/line 2/);
  });
});

describe('XHTML to Markdown', () => {
  it('keeps formatting, lists, tables and links', () => {
    expect(md('<xhtml:div>A <xhtml:b>bold</xhtml:b> and <xhtml:span style="font-style: italic">slanted</xhtml:span> 2*3 word.</xhtml:div>')).toBe('A **bold** and *slanted* 2\\*3 word.');
    expect(md('<xhtml:ol><xhtml:li>one</xhtml:li><xhtml:li>two<xhtml:ul><xhtml:li>sub</xhtml:li></xhtml:ul></xhtml:li></xhtml:ol>')).toBe('1. one\n2. two\n   - sub');
    expect(md('<xhtml:table><xhtml:tr><xhtml:th>A</xhtml:th><xhtml:th>B</xhtml:th></xhtml:tr><xhtml:tr><xhtml:td>1|2</xhtml:td></xhtml:tr></xhtml:table>')).toBe('| A | B |\n| --- | --- |\n| 1\\|2 |  |');
    expect(md('<xhtml:p>See <xhtml:a href="https://x.example/a b">the spec</xhtml:a>.</xhtml:p><xhtml:p>- not a list</xhtml:p>')).toBe('See [the spec](https://x.example/a%20b).\n\n\\- not a list');
    expect(md('<xhtml:div>line one<xhtml:br/>line two</xhtml:div>')).toBe('line one\\\nline two');
  });

  it('shows embedded objects by their picture, and says when there is none', () => {
    const skipped: string[] = [];
    const out = xhtmlToMarkdown(parseXml('<x xmlns:xhtml="h"><xhtml:object data="a.ole" type="application/oleobject"><xhtml:object data="a b.png" type="image/png"/></xhtml:object> <xhtml:object data="c.ole"/></x>').children, {
      image: (d) => `images/${d}`,
      skipped: (w) => skipped.push(w),
    });
    expect(out).toBe('![](images/a%20b.png) *(embedded object not imported: c.ole)*');
    expect(skipped).toEqual(['c.ole']);
  });
});

describe('ReqIF', () => {
  const reqif = readReqif(FIXTURE);
  it('reads objects with named attributes, links and module order', () => {
    expect(reqif.title).toBe('Payments baseline 3.2');
    expect(reqif.specs.map((s) => s.name)).toEqual(['System Requirements', 'System Test Specification']);
    const o13 = reqif.objects.get('o-13')!;
    expect(o13.values.get('Status')).toMatchObject({ kind: 'enum', enums: ['Proposed'] });
    expect(o13.values.get('Variant')!.enums).toEqual(['Base', 'Pro']);
    expect(reqif.relations.map((r) => r.type)).toEqual(['Verifies', 'Verifies', 'Satisfies', 'Satisfies']);
    expect(walkSpec(reqif.specs[0]).map((w) => `${w.object}@${w.depth}`)).toEqual(['o-h1@1', 'o-intro@2', 'o-12@2', 'o-h11@2', 'o-13@3', 'o-14@3']);
  });
});

describe('DOORS import', () => {
  const reqif = readReqif(FIXTURE);
  const config = parseConfig(null).config;
  const map = guessMap(reqif, config);
  const plan = planImport(reqif, map, config, { attachment: (p) => (p === 'files/limits.png' ? new Uint8Array([1, 2, 3]) : null), date: '2026-11-07' });
  const file = (start: string) => [...plan.files].find(([p]) => p.startsWith(start))![1] as string;

  it('guesses where modules go and what attributes and link types mean', () => {
    expect(map.modules).toEqual({
      'System Requirements': { kind: 'requirement', dir: 'requirements', prefix: 'REQ-' },
      'System Test Specification': { kind: 'testcase', dir: 'tests', prefix: 'TC-' },
    });
    expect(map.attributes).toMatchObject({ id: ['ReqIF.ForeignID'], text: ['ReqIF.Text'], status: 'Status', variants: 'Variant', keep: ['Priority', 'Effort Days'] });
    expect(map.values.status).toEqual({ Accepted: 'approved', Proposed: 'draft', Rejected: 'obsolete' });
    expect(map.values.testStatus.Accepted).toBe('ready');
    expect(map.links).toEqual({ verifies: ['Verifies'], refines: ['Satisfies'], reversed: [] });
  });

  it('writes one file per requirement and test case, with its fields and links', () => {
    const r12 = file('requirements/REQ-12-');
    expect(r12).toMatch(/^---\nid: REQ-12\ntitle: When the gateway times out, the system shall retry the payment\nstatus: approved\n/);
    expect(r12).toContain('section: 1 Payments\npriority: High\n');
    expect(r12).toContain('- with *increasing* delay\n  - 1 s, 4 s, 16 s');
    const r13 = file('requirements/REQ-13-');
    expect(r13).toContain('title: Daily limits per card type\n');
    expect(r13).toContain('variants: [base, pro]\nrefines: [REQ-12]\nsection: 1.1 Limits\n');
    expect(r13).toContain('| Debit | 5 000 \\| 10 000 |');
    // Test cases verify their requirements whichever way DOORS drew the link, reviewed as exported.
    const idx = buildIndex([...plan.files].filter(([p]) => p.endsWith('.md')).map(([path, text]) => ({ path, text: text as string })), null);
    expect(idx.problems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(linksOf(idx, idx.byId.get('TC-6')!).map((l) => `${l.req.id}:${l.state}`)).toEqual(['REQ-13:ok']);
    expect(coverage(idx).tested.map((r) => r.id)).toEqual(['REQ-12', 'REQ-13']);
    expect(idx.byId.get('REQ-2')!.data['effort-days']).toBe(3);
  });

  it('keeps the module order and headings in a README, and copies pictures', () => {
    const readme = file('requirements/README.md');
    expect(readme).toContain('## 1 Payments\n\n- [REQ-2](REQ-2-');
    expect(readme).toContain('### 1.1 Limits\n\n- [REQ-13]');
    expect(plan.files.get('requirements/images/REQ-14.png')).toEqual(new Uint8Array([1, 2, 3]));
    expect(file('requirements/REQ-14-')).toContain('![](images/REQ-14.png)');
  });

  it('reports what it left out', () => {
    expect(plan.report.links).toMatchObject({ verifies: 2, refines: 1, dangling: 1 });
    expect(plan.report.images.notShown).toEqual(['REQ-14: files/legacy.ole']);
    expect(plan.report.unknownVariants).toEqual([]); // trace.yml has none yet: nothing to compare with
    expect(plan.traceYml).toContain('variants:\n  base: { name: Base }\n  pro: { name: Pro }');
  });

  it('follows an edited map', () => {
    const edited = readMap('modules:\n  System Test Specification: { kind: skip }\nattributes:\n  keep: []\nvalues:\n  status: { Accepted: review }\n', map);
    const p = planImport(reqif, edited, config, { attachment: () => null });
    expect([...p.files.keys()].some((k) => k.startsWith('tests/'))).toBe(false);
    expect(p.files.get([...p.files.keys()].find((k) => k.startsWith('requirements/REQ-12-'))!)).toContain('status: review\n');
    expect(p.files.get([...p.files.keys()].find((k) => k.startsWith('requirements/REQ-12-'))!)).not.toContain('priority');
  });
});

describe('import-reqif on the command line', () => {
  it('writes a map, imports a .reqifz into a repository, and refuses to import twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-doors-'));
    // A real .reqifz: deflated, the .reqif in a folder, the picture beside it.
    writeFileSync(join(dir, 'export.reqif'), FIXTURE);
    writeFileSync(join(dir, 'limits.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    execFileSync('python3', ['-I', '-c', `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)
z.write(sys.argv[2],'export/payments.reqif'); z.write(sys.argv[3],'export/files/limits.png'); z.close()`, join(dir, 'x.reqifz'), join(dir, 'export.reqif'), join(dir, 'limits.png')]);
    const repo = join(dir, 'repo');
    const log: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => log.push(a.join(' '));
    try {
      expect(await importReqif(['import-reqif', join(dir, 'x.reqifz'), '--init-map', join(dir, 'map.yml'), '--into', repo])).toBe(0);
      expect(readFileSync(join(dir, 'map.yml'), 'utf8')).toContain('System Requirements: {kind: requirement, dir: requirements, prefix: REQ-}');
      expect(await importReqif(['import-reqif', join(dir, 'x.reqifz'), '--map', join(dir, 'map.yml'), '--into', repo, '--dry-run'])).toBe(0);
      expect(existsSync(repo)).toBe(false);
      expect(await importReqif(['import-reqif', join(dir, 'x.reqifz'), '--map', join(dir, 'map.yml'), '--into', repo])).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(log.join('\n')).toContain('Pictures: 1 copied.');
    expect(readFileSync(join(repo, 'requirements/images/REQ-14.png'))).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'));
    const { config, files } = await readProjectFiles(repo);
    expect(config).toContain('variants:');
    const idx = buildIndex(files, config);
    expect(idx.items.map((i) => i.id)).toEqual(['REQ-2', 'REQ-12', 'REQ-13', 'REQ-14', 'TC-5', 'TC-6']);
    expect(idx.problems.filter((p) => p.severity === 'error')).toEqual([]);
    // Again: the IDs are taken, so nothing is written.
    const err = console.error;
    console.error = () => {};
    console.log = () => {};
    try {
      expect(await importReqif(['import-reqif', join(dir, 'x.reqifz'), '--into', repo])).toBe(1);
    } finally {
      console.error = err;
      console.log = orig;
    }
  });
});

describe('modules exported separately', () => {
  // The requirements module in one export; the test module, with its links to the
  // requirements, in another (as DOORS writes a module's out-links with it).
  const drop = (xml: string, objects: RegExp, spec: string, links: string[]) =>
    xml
      .replace(new RegExp(`<SPEC-OBJECT IDENTIFIER="(?:${objects.source})"[\\s\\S]*?</SPEC-OBJECT>\\s*`, 'g'), '')
      .replace(new RegExp(`<SPECIFICATION IDENTIFIER="${spec}"[\\s\\S]*?</SPECIFICATION>\\s*`), '')
      .replace(new RegExp(`<SPEC-RELATION IDENTIFIER="(?:${links.join('|')})">[\\s\\S]*?</SPEC-RELATION>\\s*`, 'g'), '');
  const reqs = drop(FIXTURE, /t-[^"]+/, 's-test', ['l1', 'l2']);
  const tests = drop(FIXTURE, /o-[^"]+/, 's-sys', ['l3', 'l4']);

  it('loses the links when read alone, and keeps them when read together', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-doors2-'));
    writeFileSync(join(dir, 'reqs.reqif'), reqs);
    writeFileSync(join(dir, 'tests.reqif'), tests);
    const alone = await readExport(join(dir, 'tests.reqif'));
    expect(alone.reqif.specs.map((s) => s.name)).toEqual(['System Test Specification']);
    const cfg = parseConfig(null).config;
    expect(planImport(alone.reqif, guessMap(alone.reqif, cfg), cfg, { attachment: () => null }).report.links.dangling).toBe(2);

    const both = await readExport([join(dir, 'reqs.reqif'), join(dir, 'tests.reqif'), join(dir, 'tests.reqif')]);
    expect(both.reqif.specs.map((s) => s.name)).toEqual(['System Requirements', 'System Test Specification']);
    expect(both.reqif.relations.map((r) => r.id)).toEqual(['l3', 'l4', 'l1', 'l2']); // the second read of tests adds nothing

    const repo = join(dir, 'repo');
    const orig = console.log;
    console.log = () => {};
    try {
      expect(await importReqif(['import-reqif', join(dir, 'reqs.reqif'), join(dir, 'tests.reqif'), '--into', repo])).toBe(0);
    } finally {
      console.log = orig;
    }
    const { config, files } = await readProjectFiles(repo);
    const idx = buildIndex(files, config);
    expect(idx.byId.get('TC-5')!.verifies).toEqual(['REQ-12']);
    expect(idx.byId.get('TC-6')!.verifies).toEqual(['REQ-13']);
  });
});
