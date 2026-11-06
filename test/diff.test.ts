import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockChanges, bodyBlocks, diffSeq, fieldChanges, readVersion, whatChanged, wordDiff } from '../src/core/diff';
import { git } from '../src/backend/git';

const doc = (front: string, body: string) => `---\n${front}---\n${body}`;

describe('comparing versions', () => {
  it('finds the shortest edit', () => {
    const ops = diffSeq('abcde'.split(''), 'abxde'.split(''));
    expect(ops.map((o) => o.kind)).toEqual(['same', 'same', 'del', 'add', 'same', 'same']);
  });

  it('compares text block by block, pairing similar blocks as changed', () => {
    const a = bodyBlocks('# Retry\n\nThe client retries 3 times.\n\nOld note.\n\n- one\n- two\n').map((b) => b.key);
    const b = bodyBlocks('# Retry\n\nThe client retries 5 times.\n\n- one\n- two\n\nA new paragraph about something else entirely.\n').map((b) => b.key);
    expect(blockChanges(a, b).map((c) => c.kind)).toEqual(['same', 'changed', 'removed', 'same', 'added']);
  });

  it('ignores how a block was written, not what it says', () => {
    const a = bodyBlocks('Some *text*\nwrapped.\n').map((b) => b.key);
    const b = bodyBlocks('Some _text_\nwrapped.\n').map((b) => b.key);
    expect(blockChanges(a, b).map((c) => c.kind)).toEqual(['same']);
  });

  it('shows word changes as old then new', () => {
    expect(wordDiff('retries 3 times', 'retries 5 times')).toEqual([
      { kind: 'same', text: 'retries ' },
      { kind: 'del', text: '3' },
      { kind: 'add', text: '5' },
      { kind: 'same', text: ' times' },
    ]);
  });

  it('knows each block’s lines, and where the body starts', () => {
    const v = readVersion(doc('id: REQ-1\ntitle: T\n', '\nFirst.\n\n- a\n- b\n\nLast\nline.\n'));
    expect(v.bodyLine).toBe(4);
    expect(bodyBlocks(v.body).map((b) => [b.from, b.to])).toEqual([
      [1, 3],
      [3, 6],
      [6, 9],
    ]);
  });

  it('says what changed: fields and text', () => {
    const a = doc('id: REQ-1\ntitle: Old\nstatus: draft\nreviewed: { REQ-2: abc }\n', 'Text.\n');
    const b = doc('id: REQ-1\ntitle: New\nstatus: approved\nreviewed: { REQ-2: def }\n', 'Text, changed.\n');
    expect(whatChanged(a, b)).toEqual(['text', 'Title', 'Status']);
    expect(whatChanged(a, a.replace(/\n/g, '\r\n'))).toEqual([]);
    expect(fieldChanges({ verifies: ['REQ-1'] }, { verifies: ['REQ-1', 'REQ-2'] })).toEqual([{ field: 'verifies', label: 'Verifies', old: 'REQ-1', new: 'REQ-1, REQ-2' }]);
  });
});

describe('git blame', () => {
  it('says who last changed each line, and which lines aren’t committed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-blame-'));
    const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'Ana', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'Ana', GIT_COMMITTER_EMAIL: 'a@x' } });
    g('init', '-q');
    writeFileSync(join(dir, 'r.md'), 'one\ntwo\n');
    g('add', '.');
    g('commit', '-qm', 'First version');
    writeFileSync(join(dir, 'r.md'), 'one\ntwo changed\n');
    const b = await git.blame(dir, 'r.md');
    expect(b!.lines.map((l) => l.text)).toEqual(['one', 'two changed']);
    expect(b!.lines[1].commit).toBeNull();
    const c = b!.commits[b!.lines[0].commit!];
    expect(c).toMatchObject({ author: 'Ana', message: 'First version' });
    expect(await git.blame(dir, 'new.md')).toBeNull();
  });
});
