// Export the requirements and test cases: a PDF document, an Excel workbook, or one
// table as CSV.
import { useState } from 'react';
import type { Project } from '../project';
import { specHtml } from '../../../core/specdoc';
import { slug, type Item } from '../../../core/model';
import { customTypes } from '../../../core/config';
import { tables, TABLE_LABEL, type TableKey } from '../../../core/spreadsheet';
import { csv, xlsx } from '../../../core/xlsx';
import { imageUrl, savePdf } from '../pdf';
import { download } from '../download';
import { loadTrend } from '../trend';
import { notify } from '../notify';
import { load, save } from '../storage';
import { Dialog } from './Dialog';
import { SourceSelect } from './ResultSource';
import { describeSource, sourceName, sourceRuns, type ResultSource } from '../../../core/verdict';

type Format = 'pdf' | 'xlsx' | 'csv';

const FORMATS: [Format, string][] = [
  ['pdf', 'PDF document'],
  ['xlsx', 'Excel workbook'],
  ['csv', 'CSV'],
];

const ALL_SHEETS: TableKey[] = ['requirements', 'testcases', 'others', 'matrix', 'runs', 'results', 'trend'];

const SHEET_HINT: Record<TableKey, string> = {
  requirements: 'with their test cases, coverage and last results',
  testcases: 'with what they verify and their last result',
  others: 'the item types trace.yml declares, with their links',
  matrix: 'requirements down, test cases across',
  runs: 'one row per run, with its totals',
  results: 'every result in every run',
  trend: 'coverage and results at each run',
};

export function ExportDialog({ project, source: initialSource, onClose }: { project: Project; source?: ResultSource; onClose: () => void }) {
  const { index, repo, git } = project;
  const [format, setFormatState] = useState<Format>(() => load<Format>('trace.exportFormat') ?? 'pdf');
  const variantName = project.variant ? (index.config.variants.find((v) => v.key === project.variant)?.name ?? project.variant) : null;
  const [title, setTitle] = useState(`${repo.name}: requirements and test cases${variantName ? ` (${variantName})` : ''}`);
  const [requirements, setRequirements] = useState(true);
  const [testcases, setTestcases] = useState(true);
  const [matrix, setMatrix] = useState(true);
  const otherTypes = customTypes(index.config);
  // "Other items" only when trace.yml declares item types.
  const SHEETS = ALL_SHEETS.filter((k) => k !== 'others' || otherTypes.length > 0);
  const [others, setOthers] = useState(true);
  const [sheets, setSheets] = useState<Set<TableKey>>(() => new Set(SHEETS));
  const [csvTable, setCsvTable] = useState<TableKey>('requirements');
  const [obsolete, setObsolete] = useState(false);
  const [component, setComponent] = useState('');
  const [busy, setBusy] = useState(false);
  // Test results in the matrix: as chosen on the Coverage screen, unless changed here.
  const [source, setSource] = useState<ResultSource>(initialSource ?? { kind: 'none' });
  const resultRuns = sourceRuns(project.runs, source);
  const components = [...new Set([...index.config.components.map((c) => c.key), ...index.items.flatMap((i) => i.components)])].sort();
  const uncommitted = (git?.changes ?? []).some((c) => index.byPath.has(c.path));
  const issues = (item: Item) => (project.links.byItem.get(item.id) ?? []).map((l) => l.issue).sort();
  const fileName = slug(title) || slug(repo.name) || 'trace';

  const setFormat = (f: Format) => {
    setFormatState(f);
    save('trace.exportFormat', f);
  };

  const exportPdf = async () => {
    const meta: [string, string][] = [['Repository', repo.name]];
    if (variantName) meta.push(['Variant', variantName]);
    if (git?.branch) meta.push(['Branch', git.branch]);
    if (git?.head) meta.push(['Commit', git.head + (uncommitted ? ' (with uncommitted changes)' : '')]);
    if (matrix && resultRuns) meta.push(['Test results', sourceName(project.runs, source)]);
    const html = specHtml(index, {
      title: title.trim() || repo.name,
      requirements,
      testcases,
      others,
      matrix,
      obsolete,
      component: component || null,
      meta,
      image: (itemPath, src) => imageUrl(repo.id, itemPath, src),
      issues,
      results: matrix && resultRuns ? { runs: resultRuns, description: describeSource(project.runs, source), oneRun: source.kind === 'run' } : null,
    });
    await savePdf(html, `${fileName}.pdf`);
  };

  const exportTables = async () => {
    const wanted = format === 'xlsx' ? SHEETS.filter((k) => sheets.has(k)) : [csvTable];
    const trend = wanted.includes('trend') ? await loadTrend(project) : null;
    const results = resultRuns ? { runs: resultRuns, name: sourceName(project.runs, source), oneRun: source.kind === 'run' } : null;
    const all = tables(index, { obsolete, component: component || null, runs: project.runs, issues, trend, results });
    if (format === 'xlsx')
      download(
        `${fileName}.xlsx`,
        xlsx(
          wanted.map((k) => all[k]),
          { title: title.trim() || repo.name },
        ) as Uint8Array<ArrayBuffer>,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    else download(`${fileName}-${slug(TABLE_LABEL[csvTable])}.csv`, csv(all[csvTable]), 'text/csv;charset=utf-8');
  };

  const exportIt = async () => {
    setBusy(true);
    try {
      await (format === 'pdf' ? exportPdf() : exportTables());
      onClose();
    } catch (e) {
      notify(`Couldn’t export: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const nothing = format === 'pdf' ? !(requirements || testcases || matrix || (others && otherTypes.length > 0)) : format === 'xlsx' ? sheets.size === 0 : false;
  const check = (label: string, on: boolean, set: (v: boolean) => void, hint?: string) => (
    <label className="check">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="muted small"> · {hint}</span>}
      </span>
    </label>
  );

  return (
    <Dialog title="Export" onClose={onClose}>
      <div className="dialog-body">
        <div className="segmented" role="radiogroup" aria-label="Format">
          {FORMATS.map(([f, label]) => (
            <button key={f} type="button" role="radio" aria-checked={format === f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>
              {label}
            </button>
          ))}
        </div>
        {format !== 'csv' && (
          <label className="field">
            <span>{format === 'pdf' ? 'Title' : 'Name'}</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        )}
        {format === 'pdf' && (
          <div className="stack tight">
            {check('Requirements, with their text', requirements, setRequirements)}
            {check('Test cases, with their steps', testcases, setTestcases)}
            {otherTypes.length > 0 && check(`${otherTypes.map((t) => t.plural).join(', ')}, with their text`, others, setOthers)}
            {check('Traceability matrix', matrix, setMatrix)}
          </div>
        )}
        {format === 'xlsx' && (
          <div className="stack tight">
            <span className="muted small">One sheet each:</span>
            {SHEETS.map((k) =>
              check(
                TABLE_LABEL[k],
                sheets.has(k),
                (v) => {
                  const next = new Set(sheets);
                  if (v) next.add(k);
                  else next.delete(k);
                  setSheets(next);
                },
                SHEET_HINT[k],
              ),
            )}
          </div>
        )}
        {format === 'csv' && (
          <label className="field">
            <span>Table</span>
            <select value={csvTable} onChange={(e) => setCsvTable(e.target.value as TableKey)}>
              {SHEETS.map((k) => (
                <option key={k} value={k}>
                  {TABLE_LABEL[k]}: {SHEET_HINT[k]}
                </option>
              ))}
            </select>
          </label>
        )}
        {project.runs.length > 0 && (format === 'pdf' ? matrix : format === 'xlsx' ? sheets.has('matrix') : csvTable === 'matrix') && (
          <label className="field">
            <span>Test results in the matrix</span>
            <SourceSelect runs={project.runs} value={source} onChange={setSource} />
          </label>
        )}
        <div className="stack tight">{check('Include obsolete items', obsolete, setObsolete)}</div>
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
        {variantName && <p className="muted small">Only what applies to the variant {variantName} (chosen at the top).</p>}
        {uncommitted && <p className="muted small">Some requirements or test cases have uncommitted changes; the export shows them as they are now.</p>}
        <div className="dialog-actions">
          <span className="tool-spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" disabled={busy || nothing} onClick={exportIt}>
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
