import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectFiles, safePath } from '../src/backend/service';

describe('reading a repository', () => {
  it('finds items (BOM or not) and test runs, and skips other files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-repo-'));
    for (const d of ['requirements', 'tests', 'test-runs', 'node_modules/x']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'trace.yml'), 'statuses: [draft]\n');
    writeFileSync(join(dir, 'requirements/a.md'), '﻿---\nid: REQ-01\n---\nText\n');
    writeFileSync(join(dir, 'tests/b.md'), '---\r\nid: TC-001\r\n---\r\n');
    writeFileSync(join(dir, 'tests/notes.md'), 'No front matter\n');
    writeFileSync(join(dir, 'test-runs/r.yml'), 'name: R\n');
    writeFileSync(join(dir, 'node_modules/x/c.md'), '---\nid: REQ-99\n---\n');
    const { config, files } = await readProjectFiles(dir);
    expect(config).toBe('statuses: [draft]\n');
    expect(files.map((f) => f.path).sort()).toEqual(['requirements/a.md', 'test-runs/r.yml', 'tests/b.md']);
  });

  it('keeps paths inside the repository', () => {
    expect(() => safePath('/r', '../x')).toThrow();
    expect(() => safePath('/r', '.git/config')).toThrow();
    expect(() => safePath('/r', '/etc/passwd')).toThrow();
    expect(safePath('/r', 'requirements/a.md')).toBe('/r/requirements/a.md');
  });
});
