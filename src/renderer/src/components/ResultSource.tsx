// Where the matrix's test results come from: the latest of each test case, a release
// (the runs for one code version), one test run, or none.
import { useMemo } from 'react';
import type { TestRun } from '../../../core/runs';
import { releases, sourceRuns, versionKey, type ResultSource, type Verdict, VERDICT_LABEL } from '../../../core/verdict';
import { load, save } from '../storage';

const keyOf = (s: ResultSource) => (s.kind === 'release' ? `release:${versionKey(s.key)}` : s.kind === 'run' ? `run:${s.path}` : s.kind);

function parseKey(k: string): ResultSource {
  if (k.startsWith('release:')) return { kind: 'release', key: k.slice(8) };
  if (k.startsWith('run:')) return { kind: 'run', path: k.slice(4) };
  return k === 'latest' ? { kind: 'latest' } : { kind: 'none' };
}

const storeKey = (repoId: string) => `trace.results.${repoId}`;

// The source last chosen for a repository; the latest results when there are runs.
export function loadSource(repoId: string, runs: TestRun[]): ResultSource {
  const s = load<ResultSource>(storeKey(repoId));
  if (s && (s.kind === 'none' || sourceRuns(runs, s))) return s;
  return runs.length ? { kind: 'latest' } : { kind: 'none' };
}

export function saveSource(repoId: string, s: ResultSource) {
  save(storeKey(repoId), s);
}

export function SourceSelect({ runs, value, onChange, id }: { runs: TestRun[]; value: ResultSource; onChange: (s: ResultSource) => void; id?: string }) {
  const rels = useMemo(() => releases(runs), [runs]);
  return (
    <select id={id} value={keyOf(value)} onChange={(e) => onChange(parseKey(e.target.value))}>
      <option value="none">No results, links only</option>
      <option value="latest">Latest result of each test case</option>
      {rels.length > 0 && (
        <optgroup label="Releases">
          {rels.map((r) => (
            <option key={r.key} value={`release:${r.key}`}>
              Release {r.name} ({r.runs.length} run{r.runs.length === 1 ? '' : 's'})
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="Test runs">
        {runs.map((r) => (
          <option key={r.path} value={`run:${r.path}`}>
            {r.name}
            {r.created ? ` (${r.created})` : ''}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

const VERDICT_CLASS: Record<Verdict, string> = { verified: 'passed', failing: 'failed', blocked: 'blocked', partial: 'partial', 'not-run': 'not-run', 'no-tests': '' };

export function VerdictPill({ verdict, evidence }: { verdict: Verdict; evidence?: boolean }) {
  if (verdict === 'no-tests') return <span className="pill gap-pill">{evidence ? 'No evidence' : 'No tests'}</span>;
  return <span className={`result-pill ${VERDICT_CLASS[verdict]}`}>{VERDICT_LABEL[verdict]}</span>;
}
