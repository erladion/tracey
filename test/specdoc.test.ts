import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/core/model';
import { projectFiles } from '../src/core/sample';
import { specHtml } from '../src/core/specdoc';

const files = Object.entries(projectFiles(true))
  .filter(([p]) => p.endsWith('.md') && p !== 'README.md')
  .map(([path, text]) => ({ path, text }));
files.push({ path: 'requirements/REQ-50-x.md', text: '---\nid: REQ-50\ntitle: Old <b>thing</b>\nstatus: obsolete\n---\n<script>alert(1)</script>\n\n![diagram](img/flow.png)\n' });
const index = buildIndex(files, projectFiles(true)['trace.yml']);
const opts = { title: 'Spec', requirements: true, testcases: true, matrix: true, obsolete: false, component: null, meta: [['Commit', 'abc']] as [string, string][], image: (p: string, s: string) => `trace-file://repo/r/${p}|${s}` };

describe('specification document', () => {
  it('has every live item, the matrix and links between them', () => {
    const html = specHtml(index, opts);
    expect(html).toContain('<h3><span class="mono">REQ-07</span> Payment retry after gateway timeout</h3>');
    expect(html).toContain('<h3><span class="mono">TC-102</span> Payment stops after 3 retries</h3>');
    expect(html).toContain('<a class="mono" href="#i-TC-101">TC-101</a>');
    expect(html).toContain('id="matrix"');
    expect(html).not.toContain('REQ-50');
  });

  it('includes obsolete items when asked, escapes HTML, and points images at the repository', () => {
    const html = specHtml(index, { ...opts, obsolete: true });
    expect(html).toContain('Old &lt;b&gt;thing&lt;/b&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('src="trace-file://repo/r/requirements/REQ-50-x.md|img/flow.png"');
  });

  it('counts only the suspect links between items in the document', () => {
    const changed = buildIndex(
      [
        ...files,
        { path: 'requirements/REQ-60-a.md', text: '---\nid: REQ-60\ntitle: Audit trail\nstatus: approved\ncomponents: [audit]\n---\nChanged.\n' },
        { path: 'testcases/TC-160-a.md', text: '---\nid: TC-160\ntitle: Audit check\nstatus: ready\ncomponents: [audit]\nverifies: [REQ-60]\nreviewed: { REQ-60: deadbeef }\n---\n' },
      ],
      projectFiles(true)['trace.yml'],
    );
    expect(specHtml(changed, { ...opts, component: 'audit' })).toContain('1 link changed since review.');
    expect(specHtml(changed, { ...opts, component: 'billing' })).not.toContain('changed since review');
  });

  it('filters by component', () => {
    const html = specHtml(index, { ...opts, component: 'billing' });
    expect(html).toContain('REQ-12');
    expect(html).not.toContain('>REQ-07<');
  });
});
