import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config';
import { setFields, splitFrontMatter, joinFrontMatter } from '../src/core/frontmatter';
import { explodeNeeds, needPath, parseNeeds, readConfPy, readNeedFile, removeNeed, splitNeedPath, writeNeed, type NeedContext } from '../src/core/myst';

const CONFIG = parseConfig(`
requirements: { prefix: REQ_, digits: 3 }
testcases: { prefix: TC_, digits: 3 }
components:
  payments: { name: Payments }
sphinx-needs:
  dir: docs
`).config;

const REQS = `# Requirements

Some prose about the system.

\`\`\`\`{req} Retry failed payments
:id: REQ_001
:status: open
:tags: payments, backend

Retry **three** times.

\`\`\`python
retry(3)
\`\`\`
\`\`\`\`

\`\`\`{req} Back off between retries
:id: REQ_002
:links: REQ_001
:collapse:

Wait longer each time.
\`\`\`

\`\`\`\`{code-block} markdown
\`\`\`{req} Only an example
:id: REQ_999
\`\`\`
\`\`\`\`

:::{note}
\`\`\`{spec} Retry design
:id: SPEC_001
:links: REQ_001
\`\`\`
:::

More prose.
`;

const TESTS = `# Tests

::::{test} Retries three times
:id: TC_001
:links: REQ_001, SPEC_001
:reviewed: REQ_001=abc123

**Steps**

1. Fail a payment.

**Expected**

Three tries.
::::
`;

const decl = readConfPy(`extensions = ["myst_parser", "sphinx_needs"]
needs_types = [
    {"directive": "req", "title": "Requirement", "prefix": "REQ_", "color": "#BFD8D2", "style": "node"},
    {"directive": "spec", "title": "Specification", "prefix": "SPEC_"},
    {"directive": "test", "title": "Test", "prefix": "TC_"},
]
needs_extra_links = [
    {"option": "tests", "incoming": "is tested by", "outgoing": "tests"},  # a comment
]
needs_extra_options = ["reviewed", "priority"]
needs_id_regex = r"^[A-Z]+_[0-9]+"
`);

const files = [readNeedFile('docs/reqs.md', REQS, CONFIG, decl), readNeedFile('docs/tests.md', TESTS, CONFIG, decl)];
const exploded = new Map(explodeNeeds(files, CONFIG, decl).map((f) => [f.path, f.text]));
const kinds = new Map([
  ['REQ_001', 'requirement'],
  ['REQ_002', 'requirement'],
  ['TC_001', 'testcase'],
  ['SPEC_001', null],
]);
const ctx: NeedContext = { config: CONFIG, declared: decl, kindOfId: (id) => kinds.get(id) ?? null };

describe('reading MyST needs', () => {
  it('finds needs, in containers too, but not in code', () => {
    expect(files[0].needs.map((n) => `${n.name}:${n.id}`)).toEqual(['req:REQ_001', 'req:REQ_002', 'spec:SPEC_001']);
    expect(files[0].needs[0].body).toBe('Retry **three** times.\n\n```python\nretry(3)\n```');
    expect(files[1].needs[0].fence).toBe('::::');
  });

  it('reads conf.py', () => {
    expect(decl).toEqual({
      usesNeeds: true,
      directives: [
        { directive: 'req', title: 'Requirement', prefix: 'REQ_' },
        { directive: 'spec', title: 'Specification', prefix: 'SPEC_' },
        { directive: 'test', title: 'Test', prefix: 'TC_' },
      ],
      links: ['tests'],
      options: ['reviewed', 'priority'],
      idRegex: '^[A-Z]+_[0-9]+',
      complete: true,
    });
  });

  it('gives each need an item text: links by what they join, tags as components', () => {
    expect([...exploded.keys()]).toEqual(['docs/reqs.md#REQ_001', 'docs/reqs.md#REQ_002', 'docs/reqs.md#SPEC_001', 'docs/tests.md#TC_001']);
    expect(exploded.get('docs/reqs.md#REQ_001')).toBe('---\nid: REQ_001\ntype: requirement\ntitle: Retry failed payments\nstatus: open\ncomponents: [payments]\ntags: [backend]\n---\nRetry **three** times.\n\n```python\nretry(3)\n```\n');
    expect(exploded.get('docs/reqs.md#REQ_002')).toBe('---\nid: REQ_002\ntype: requirement\ntitle: Back off between retries\nrefines: [REQ_001]\ncollapse:\n---\nWait longer each time.\n');
    // SPEC_001 isn't an item type, so links to it stay as written.
    expect(exploded.get('docs/tests.md#TC_001')).toMatch(/^---\nid: TC_001\ntype: testcase\ntitle: Retries three times\nverifies: \[REQ_001\]\nlinks: \[SPEC_001\]\nreviewed:\n {2}REQ_001: abc123\n---\n\*\*Steps\*\*\n/);
  });

  it('names needs by file and ID', () => {
    expect(splitNeedPath('docs/reqs.md#REQ_001')).toEqual({ file: 'docs/reqs.md', id: 'REQ_001', n: 1 });
    expect(splitNeedPath('docs/reqs.md#REQ_001~2')).toEqual({ file: 'docs/reqs.md', id: 'REQ_001', n: 2 });
    expect(splitNeedPath('docs/reqs.md#@3')).toEqual({ file: 'docs/reqs.md', id: '', n: 3 });
    expect(splitNeedPath('docs/reqs.md')).toBeNull();
    expect(needPath('a.md', 'X_1', 2)).toBe('a.md#X_1~2');
  });
});

describe('writing MyST needs', () => {
  const key = splitNeedPath('docs/reqs.md#REQ_002')!;

  it('writes an unchanged need back as it was', () => {
    for (const [path, text] of exploded) {
      const k = splitNeedPath(path)!;
      const source = k.file === 'docs/reqs.md' ? REQS : TESTS;
      expect(writeNeed(source, k, text, ctx, 'x')).toBe(source);
    }
  });

  it('changes only the need, keeping option order, link options and flags', () => {
    const text = exploded.get('docs/reqs.md#REQ_002')!;
    const { front, body } = splitFrontMatter(text);
    const edited = joinFrontMatter(setFields(front, { status: 'approved', title: 'Back off, exponentially', priority: 'High' }), `${body}More text.\n`);
    const out = writeNeed(REQS, key, edited, ctx, 'x');
    expect(out).toBe(
      REQS.replace(
        '```{req} Back off between retries\n:id: REQ_002\n:links: REQ_001\n:collapse:\n\nWait longer each time.\n```',
        '```{req} Back off, exponentially\n:id: REQ_002\n:links: REQ_001\n:collapse:\n:status: approved\n:priority: High\n\nWait longer each time.\nMore text.\n```',
      ),
    );
  });

  it('writes new links under the option conf.py declares, or links', () => {
    const text = exploded.get('docs/tests.md#TC_001')!;
    const { front, body } = splitFrontMatter(text);
    const out = writeNeed(TESTS, splitNeedPath('docs/tests.md#TC_001')!, joinFrontMatter(setFields(front, { verifies: ['REQ_001', 'REQ_002'] }), body), ctx, 'x');
    expect(out).toContain(':links: REQ_001, SPEC_001, REQ_002\n');
    const mapped = { ...ctx, config: parseConfig('sphinx-needs:\n  links: { tests: verifies }\n').config };
    const out2 = writeNeed(TESTS, splitNeedPath('docs/tests.md#TC_001')!, joinFrontMatter(setFields(front, { verifies: ['REQ_001', 'REQ_002'] }), body), mapped, 'x');
    expect(out2).toContain(':links: REQ_001, SPEC_001\n:reviewed: REQ_001=abc123\n:tests: REQ_002\n');
  });

  it('lengthens the fence when the text holds one as long', () => {
    const text = exploded.get('docs/reqs.md#REQ_002')!;
    const out = writeNeed(REQS, key, `${text}\n\`\`\`\ncode\n\`\`\`\n`, ctx, 'x');
    expect(out).toContain('````{req} Back off between retries');
    expect(readNeedFile('docs/reqs.md', out, CONFIG, decl).needs.map((n) => n.id)).toEqual(['REQ_001', 'REQ_002', 'SPEC_001']);
  });

  it('follows a need whose ID changed', () => {
    const text = exploded.get('docs/reqs.md#REQ_002')!.replace('id: REQ_002', 'id: REQ_020');
    const once = writeNeed(REQS, key, text, ctx, 'x');
    expect(once).toContain(':id: REQ_020\n');
    const twice = writeNeed(once, key, text.replace('Wait', 'Then wait'), ctx, 'x');
    expect(twice).toContain(':id: REQ_020\n:links: REQ_001\n:collapse:\n\nThen wait');
    expect(readNeedFile('docs/reqs.md', twice, CONFIG, decl).needs).toHaveLength(3);
  });

  it('adds a new need at the end, in the file’s fence style, and removes one', () => {
    const text = '---\nid: TC_002\ntype: testcase\ntitle: Backs off\nstatus: draft\nverifies: [REQ_002]\n---\n**Steps**\n\n1. \n';
    const out = writeNeed(TESTS, splitNeedPath('docs/tests.md#TC_002')!, text, ctx, 'Tests');
    expect(out).toBe(`${TESTS}\n:::{test} Backs off\n:id: TC_002\n:status: draft\n:links: REQ_002\n\n**Steps**\n\n1.\n:::\n`);
    expect(removeNeed(out, splitNeedPath('docs/tests.md#TC_002')!, CONFIG, decl)).toBe(TESTS);
    expect(writeNeed('', splitNeedPath('docs/new.md#TC_002')!, text, ctx, 'Test cases')).toMatch(/^# Test cases\n\n```{test} Backs off\n/);
    const gone = removeNeed(REQS, key, CONFIG, decl);
    expect(gone).not.toContain('REQ_002');
    expect(gone).toContain('````\n\n````{code-block}');
  });

  it('keeps options given as YAML', () => {
    const src = '```{req} A\n---\nid: REQ_005\nstatus: open\n---\nText.\n```\n';
    const f = readNeedFile('r.md', src, CONFIG, null);
    expect(f.needs[0].options).toEqual([
      ['id', 'REQ_005'],
      ['status', 'open'],
    ]);
    const [v] = explodeNeeds([f], CONFIG, null);
    expect(writeNeed(src, splitNeedPath(v.path)!, v.text.replace('status: open', 'status: done'), ctx, 'x')).toBe('```{req} A\n---\nid: REQ_005\nstatus: done\n---\n\nText.\n```\n');
  });
});

it('finds no needs in other fences', () => {
  expect(parseNeeds('```\n```{req} X\n:id: R_1\n```\n```\n', () => true)).toHaveLength(0);
});

it('keeps MyST in a need’s text through the editor', async () => {
  const { parseBody, serializeBody } = await import('../src/core/markdown/markdown');
  const { schema } = await import('../src/core/markdown/schema');
  const body = 'Retry as {need}`REQ_001` says.\n\n:::{note}\nA **note**.\n:::\n\n```{mermaid}\ngraph TD; A-->B\n```\n\nLast paragraph.\n';
  const p = parseBody(body);
  expect(serializeBody(p.doc, p)).toBe(body);
  const last = p.doc.childCount - 1;
  const doc = p.doc.copy(p.doc.content.replaceChild(last, schema.node('paragraph', null, [schema.text('Changed.')])));
  expect(serializeBody(doc, p)).toBe(body.replace('Last paragraph.', 'Changed.'));
});
