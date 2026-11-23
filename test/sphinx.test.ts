// A Sphinx-Needs project opened by the back end: needs read from MyST files, written
// back into them, and git's answers per need.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend, readProjectFiles, type RepoHost } from '../src/backend/service';
import { buildIndex, coverage, newItemPath, newItemText } from '../src/core/model';
import { buildGraph } from '../src/core/graph';
import { setFields, splitFrontMatter, joinFrontMatter } from '../src/core/frontmatter';
import { planRename } from '../src/core/rename';

const CONF = `extensions = ["myst_parser", "sphinx_needs"]
needs_types = [
    {"directive": "req", "title": "Requirement", "prefix": "REQ_"},
    {"directive": "test", "title": "Test", "prefix": "TC_"},
]
needs_extra_options = ["reviewed"]
`;
const REQS = `# Requirements

Intro.

\`\`\`{req} Retry failed payments
:id: REQ_001
:status: open

Retry three times.
\`\`\`

\`\`\`{req} Back off
:id: REQ_002
:status: open
:links: REQ_001

Wait longer each time.
\`\`\`
`;
const TESTS = `# Tests

\`\`\`{test} Retries
:id: TC_001
:status: open
:links: REQ_001

**Steps**

1. Fail a payment.
2. Watch.

**Expected**

Three tries.
\`\`\`
`;

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'trace-sphinx-'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs/conf.py'), CONF);
  writeFileSync(join(dir, 'docs/reqs.md'), REQS);
  writeFileSync(join(dir, 'docs/tests.md'), TESTS);
  writeFileSync(join(dir, 'README.md'), '---\ntitle: not an item\n---\n');
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'Needs');
  const host: RepoHost = {
    list: async () => [],
    resolve: async () => dir,
    open: async () => ({ id: dir, name: 'p', location: dir }),
    forget: async () => {},
    openFolder: async () => null,
    newLocation: async () => null,
  };
  return { dir, api: createBackend(host, { get: async () => null, set: async () => {} } as never) };
}

describe('a Sphinx-Needs project', () => {
  it('opens without trace.yml: needs as items, settings from what they use', async () => {
    const { dir } = project();
    const { config, files } = await readProjectFiles(dir);
    expect(config).toBe(
      '# Made by Tracey from the Sphinx-Needs project it found. See README for every option.\nrequirements: { prefix: "REQ_", digits: 3 }\ntestcases: { prefix: "TC_", digits: 3 }\nstatuses: [open]\ntestcaseStatuses: [open]\nsphinx-needs:\n  dir: docs\n',
    );
    // README has front matter but no ID: read, and not an item, as always.
    expect(files.map((f) => f.path)).toEqual(['README.md', 'docs/reqs.md#REQ_001', 'docs/reqs.md#REQ_002', 'docs/tests.md#TC_001', 'docs/conf.py']);
    const index = buildIndex(files, config);
    expect(index.problems).toEqual([]);
    expect(index.byId.get('TC_001')!.verifies).toEqual(['REQ_001']);
    expect(index.byId.get('REQ_002')!.refines).toEqual(['REQ_001']);
    const cov = coverage(index);
    expect(cov.untested.map((r) => r.id)).toEqual(['REQ_002']);
    // New needs: in the file with most of their type, with Sphinx-style IDs and steps.
    expect(newItemPath(index, 'requirement', 'REQ_003', 'x')).toBe('docs/reqs.md#REQ_003');
    expect(newItemPath(index, 'testcase', 'TC_002', 'x')).toBe('docs/tests.md#TC_002');
  });

  it('writes edits into the directive, and adds and removes needs', async () => {
    const { dir, api } = project();
    const { files } = await api.loadFiles(dir);
    const text = files.find((f) => f.path === 'docs/reqs.md#REQ_001')!.text;
    const { front, body } = splitFrontMatter(text);
    await api.writeFile(dir, 'docs/reqs.md#REQ_001', joinFrontMatter(setFields(front, { status: 'approved' }), body.replace('three', 'five')));
    await api.writeFile(dir, 'docs/reqs.md#REQ_003', newItemText('requirement', { id: 'REQ_003', title: 'Log retries', status: 'open', refines: ['REQ_001'] }));
    await api.deleteFile(dir, 'docs/reqs.md#REQ_002');
    expect(readFileSync(join(dir, 'docs/reqs.md'), 'utf8')).toBe(
      REQS.replace(':status: open\n\nRetry three', ':status: approved\n\nRetry five').replace(
        '```{req} Back off\n:id: REQ_002\n:status: open\n:links: REQ_001\n\nWait longer each time.\n```\n',
        '```{req} Log retries\n:id: REQ_003\n:status: open\n:links: REQ_001\n```\n',
      ),
    );
  });

  it('saves edits to two needs of one file at once without losing either', async () => {
    const { dir, api } = project();
    const { files } = await api.loadFiles(dir);
    const t = (p: string) => files.find((f) => f.path === p)!.text;
    await Promise.all([
      api.writeFile(dir, 'docs/reqs.md#REQ_001', t('docs/reqs.md#REQ_001').replace('Retry three', 'Retry 3')),
      api.writeFile(dir, 'docs/reqs.md#REQ_002', t('docs/reqs.md#REQ_002').replace('Wait longer', 'Wait much longer')),
    ]);
    const now = readFileSync(join(dir, 'docs/reqs.md'), 'utf8');
    expect(now).toContain('Retry 3 times');
    expect(now).toContain('Wait much longer');
  });

  it('answers git per need: status, history, the committed version, blame, commit', async () => {
    const { dir, api } = project();
    const { files } = await api.loadFiles(dir);
    const text = files.find((f) => f.path === 'docs/reqs.md#REQ_002')!.text;
    await api.writeFile(dir, 'docs/reqs.md#REQ_002', text.replace('status: open', 'status: approved'));
    const status = await api.gitStatus(dir);
    expect(status!.changes).toEqual([{ path: 'docs/reqs.md#REQ_002', kind: 'modified' }]);
    expect(await api.gitShow(dir, status!.head!, 'docs/reqs.md#REQ_002')).toBe(text);
    expect((await api.gitLog(dir, 'docs/reqs.md#REQ_002')).map((l) => [l.message, l.path])).toEqual([['Needs', 'docs/reqs.md#REQ_002']]);
    const blame = await api.gitBlame(dir, 'docs/reqs.md#REQ_002');
    // The fields changed (not committed); the text is as committed.
    expect(blame!.lines.map((l) => [l.commit ? 'committed' : 'new', l.text])).toEqual([
      ['new', '---'],
      ['new', 'id: REQ_002'],
      ['new', 'type: requirement'],
      ['new', 'title: Back off'],
      ['new', 'status: approved'],
      ['new', 'refines: [REQ_001]'],
      ['new', '---'],
      ['committed', 'Wait longer each time.'],
    ]);
    await api.gitCommit(dir, 'Approve REQ_002', ['docs/reqs.md#REQ_002'], { name: 'T', email: 't@example.com' });
    expect((await api.gitStatus(dir))!.changes).toEqual([]);
    // Another need's history doesn't show this commit.
    expect((await api.gitLog(dir, 'docs/reqs.md#REQ_001')).map((l) => l.message)).toEqual(['Needs']);
    expect((await api.gitLog(dir, 'docs/reqs.md#REQ_002')).map((l) => l.message)).toEqual(['Approve REQ_002', 'Needs']);
    // The page around the needs is a change of its own.
    writeFileSync(join(dir, 'docs/reqs.md'), readFileSync(join(dir, 'docs/reqs.md'), 'utf8').replace('Intro.', 'Introduction.'));
    expect((await api.gitStatus(dir))!.changes).toEqual([{ path: 'docs/reqs.md', kind: 'modified' }]);
    // A version in the past reads the same way.
    const then = await api.loadFilesAt(dir, status!.head!);
    expect(then!.files.map((f) => f.path)).toEqual(['README.md', 'docs/reqs.md#REQ_001', 'docs/reqs.md#REQ_002', 'docs/tests.md#TC_001', 'docs/conf.py']);
  });

  it('changes an ID everywhere, the need staying where it is', async () => {
    const { dir, api } = project();
    const { config, files } = await api.loadFiles(dir);
    const texts = new Map(files.map((f) => [f.path, f.text]));
    const index = buildIndex(files, config);
    const plan = planRename(index, texts, config, index.byId.get('REQ_001')!, 'REQ_010', true);
    expect(plan.move).toBeNull();
    for (const [path, text] of plan.texts) await api.writeFile(dir, path, text);
    const reqs = readFileSync(join(dir, 'docs/reqs.md'), 'utf8');
    expect(reqs).toBe(REQS.replace(':id: REQ_001', ':id: REQ_010').replace(':links: REQ_001', ':links: REQ_010'));
    expect(readFileSync(join(dir, 'docs/tests.md'), 'utf8')).toContain(':links: REQ_010\n');
    // Saving again under the old path finds it by its new ID.
    await api.writeFile(dir, 'docs/reqs.md#REQ_001', plan.texts.get('docs/reqs.md#REQ_001')!.replace('three', 'four'));
    expect(readFileSync(join(dir, 'docs/reqs.md'), 'utf8')).toContain(':id: REQ_010\n:status: open\n\nRetry four');
  });

  it('warns about what Sphinx would refuse', async () => {
    const { dir } = project();
    writeFileSync(join(dir, 'docs/tests.md'), TESTS.replace(':links: REQ_001', ':links: REQ_001\n:estimate: 30m').replace('TC_001', 'tc-1'));
    const { config, files } = await readProjectFiles(dir);
    const messages = buildIndex(files, config).problems.map((p) => p.message);
    expect(messages).toContain('tc-1 doesn\'t match the ID pattern Sphinx-Needs checks (^[A-Z0-9_]{5,}).');
    expect(messages).toContain('Sphinx-Needs doesn\'t know the option :estimate:, which tc-1 uses. Add "estimate" to needs_extra_options in docs/conf.py.');
  });

  it('shows the types conf.py declares, without trace.yml saying so', async () => {
    const { dir, api } = project();
    writeFileSync(
      join(dir, 'docs/conf.py'),
      CONF.replace('"TC_"},\n]\n', '"TC_"},\n    {"directive": "spec", "title": "Specification", "prefix": "SPEC_"},\n    {"directive": "tc", "title": "Test Case", "prefix": "TC_"},\n]\n'),
    );
    writeFileSync(
      join(dir, 'docs/specs.md'),
      '# Specs\n\n```{spec} Retry schedule\n:id: SPEC_01\n:status: draft\n:links: REQ_001\n\n1 s, 4 s, 16 s.\n```\n\n```{tc} Schedule\n:id: TC_009\n:status: blocked\n:links: REQ_002\n```\n',
    );
    const { config, files } = await api.loadFiles(dir);
    const index = buildIndex(files, config);
    expect(index.problems).toEqual([]);
    // {spec} is a type of its own, named and numbered as conf.py and its needs say.
    expect(index.config.types.find((t) => t.key === 'spec')).toMatchObject({ name: 'Specification', plural: 'Specifications', prefix: 'SPEC_', digits: 2, statuses: ['draft'], builtIn: false });
    expect(index.byId.get('SPEC_01')).toMatchObject({ kind: 'spec', title: 'Retry schedule' });
    // {tc}, titled like test cases, is read as test cases; new ones are still {test}.
    expect(index.byId.get('TC_009')).toMatchObject({ kind: 'testcase', verifies: ['REQ_002'] });
    expect(index.config.sphinx).toMatchObject({ types: {}, reads: { tc: 'testcase' } });
    const graph = buildGraph(index, {});
    expect(graph.typeOrder).toContain('spec');
    expect(graph.nodes.map((n) => n.key)).toContain('item:SPEC_01');
    // A new one is written as {spec} beside the others.
    const path = newItemPath(index, 'spec', 'SPEC_02', 'Jitter');
    expect(path).toBe('docs/specs.md#SPEC_02');
    await api.writeFile(dir, path, newItemText('spec', { id: 'SPEC_02', title: 'Jitter', status: 'draft', type: true, labels: true }));
    expect(readFileSync(join(dir, 'docs/specs.md'), 'utf8')).toContain('```{spec} Jitter\n:id: SPEC_02\n:status: draft\n```\n');
  });

  it('takes trace.yml over conf.py, and Sphinx-Needs\' own types without needs_types', async () => {
    const { dir } = project();
    writeFileSync(join(dir, 'docs/conf.py'), 'extensions = ["myst_parser", "sphinx_needs"]\n');
    writeFileSync(join(dir, 'docs/specs.md'), '```{spec} Retry schedule\n:id: SPEC_01\n```\n\n```{impl} Retry loop\n:id: IMPL_01\n```\n');
    let { config, files } = await readProjectFiles(dir);
    let index = buildIndex(files, config);
    expect(index.byId.get('SPEC_01')!.kind).toBe('spec');
    expect(index.config.types.find((t) => t.key === 'impl')!.name).toBe('Implementation');
    writeFileSync(join(dir, 'trace.yml'), 'requirements: { prefix: REQ_ }\ntestcases: { prefix: TC_ }\nsphinx-needs:\n  dir: docs\n  types: { spec: requirement }\n');
    ({ config, files } = await readProjectFiles(dir));
    index = buildIndex(files, config);
    expect(index.byId.get('SPEC_01')!.kind).toBe('requirement');
    expect(index.config.types.map((t) => t.key)).toEqual(['requirement', 'testcase', 'impl']);
  });
});
