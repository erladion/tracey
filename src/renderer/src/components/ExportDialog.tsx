// Export the requirements and test cases as a PDF document.
import { useState } from 'react';
import type { Project } from '../project';
import { specHtml } from '../../../core/specdoc';
import { slug } from '../../../core/model';
import { imageUrl, savePdf } from '../pdf';
import { Dialog } from './Dialog';

export function ExportDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const { index, repo, git } = project;
  const [title, setTitle] = useState(`${repo.name}: requirements and test cases`);
  const [requirements, setRequirements] = useState(true);
  const [testcases, setTestcases] = useState(true);
  const [matrix, setMatrix] = useState(true);
  const [obsolete, setObsolete] = useState(false);
  const [component, setComponent] = useState('');
  const [busy, setBusy] = useState(false);
  const components = [...new Set([...index.config.components.map((c) => c.key), ...index.items.flatMap((i) => i.components)])].sort();
  const uncommitted = (git?.changes ?? []).some((c) => index.byPath.has(c.path));

  const exportIt = async () => {
    setBusy(true);
    const meta: [string, string][] = [['Repository', repo.name]];
    if (git?.branch) meta.push(['Branch', git.branch]);
    if (git?.head) meta.push(['Commit', git.head + (uncommitted ? ' (with uncommitted changes)' : '')]);
    const html = specHtml(index, {
      title: title.trim() || repo.name,
      requirements,
      testcases,
      matrix,
      obsolete,
      component: component || null,
      meta,
      image: (itemPath, src) => imageUrl(repo.id, itemPath, src),
      issues: (item) => (project.links.byItem.get(item.id) ?? []).map((l) => l.issue).sort(),
    });
    await savePdf(html, `${slug(title) || 'specification'}.pdf`);
    setBusy(false);
    onClose();
  };

  return (
    <Dialog title="Export PDF" onClose={onClose}>
      <div className="dialog-body">
        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="stack tight">
          <label className="check">
            <input type="checkbox" checked={requirements} onChange={(e) => setRequirements(e.target.checked)} />
            <span>Requirements, with their text</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={testcases} onChange={(e) => setTestcases(e.target.checked)} />
            <span>Test cases, with their steps</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={matrix} onChange={(e) => setMatrix(e.target.checked)} />
            <span>Traceability matrix</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={obsolete} onChange={(e) => setObsolete(e.target.checked)} />
            <span>Include obsolete items</span>
          </label>
        </div>
        {components.length > 0 && (
          <label className="field">
            <span>Component</span>
            <select value={component} onChange={(e) => setComponent(e.target.value)}>
              <option value="">All</option>
              {components.map((c) => (
                <option key={c} value={c}>
                  {index.config.components.find((x) => x.key === c)?.name ?? c}
                </option>
              ))}
            </select>
          </label>
        )}
        {uncommitted && <p className="muted small">Some requirements or test cases have uncommitted changes; the document shows them as they are now.</p>}
        <div className="dialog-actions">
          <span className="tool-spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" disabled={busy || !(requirements || testcases || matrix)} onClick={exportIt}>
            Export PDF
          </button>
        </div>
      </div>
    </Dialog>
  );
}
