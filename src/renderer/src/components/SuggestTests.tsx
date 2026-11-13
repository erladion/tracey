// In a new test run: test cases for the release's Jira issues by what the issues are about,
// suggested by the language model (Settings), reviewed here before they join the run.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JiraIssue, LlmStatus } from '../../../shared/api';
import type { ProjectIndex } from '../../../core/model';
import { candidateCount, issueText, readSuggestions, suggestPrompt, testIndex, type Suggestion } from '../../../core/suggest';
import { api } from '../api';
import { addToWork } from './WorkList';
import type { Project } from '../project';

export interface Chosen {
  id: string;
  reason: string;
}

interface Result {
  issue: JiraIssue;
  suggestions: Suggestion[];
  error: string | null;
  note: string | null; // the model's answer couldn't be read, or named test cases it wasn't offered
}

interface Props {
  project: Project;
  index: ProjectIndex; // the test cases that apply to the run's variant
  issues: JiraIssue[]; // the release's issues, as read from Jira
  linked: Map<string, Set<string>>; // issue → the test cases already picked through its links
  picked: Set<string>; // the test cases the run has without these suggestions
  onChange: (chosen: Chosen[]) => void;
}

const reasonOf = (issue: string, why: string) => `${issue} (suggested)${why ? `: ${why}` : ''}`;

export function SuggestTests({ project, index, issues, linked, picked, onChange }: Props) {
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [which, setWhich] = useState<'unlinked' | 'all'>('unlinked');
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState<{ at: number; of: number; key: string } | null>(null);
  const [unchosen, setUnchosen] = useState<Set<string>>(new Set()); // issue + test case
  // Each suggestion run's number: a run that's been stopped or overtaken stops showing.
  const gen = useRef(0);

  useEffect(() => {
    api.llmStatus().then(setStatus, () => setStatus(null));
  }, []);

  const unlinked = useMemo(() => issues.filter((i) => !linked.get(i.key)?.size), [issues, linked]);
  const asked = which === 'unlinked' ? unlinked : issues;
  const search = useMemo(() => testIndex(index), [index]);
  const perIssue = status ? candidateCount(status.candidates, status.contextSize) : 30;

  // New issues (another fix version): the old suggestions don't apply.
  const issueKeys = issues.map((i) => i.key).join(',');
  useEffect(() => {
    gen.current++;
    setRunning(null);
    setResults([]);
    setUnchosen(new Set());
  }, [issueKeys]);

  // What the run gets: the chosen suggestions not already in it, each test case once.
  const chosen = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const r of results)
      for (const s of r.suggestions) {
        if (picked.has(s.id) || unchosen.has(`${r.issue.key}>${s.id}`)) continue;
        out.set(s.id, [...(out.get(s.id) ?? []), reasonOf(r.issue.key, s.why)]);
      }
    return [...out].map(([id, reasons]) => ({ id, reason: reasons.join(' · ') }));
  }, [results, picked, unchosen]);
  const chosenKey = chosen.map((c) => `${c.id}:${c.reason}`).join('|');
  useEffect(() => onChange(chosen), [chosenKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggest = async () => {
    const my = ++gen.current;
    const live = () => gen.current === my;
    setResults([]);
    setUnchosen(new Set());
    const done: Result[] = [];
    for (let i = 0; i < asked.length && live(); i++) {
      const issue = asked[i];
      setRunning({ at: i + 1, of: asked.length, key: issue.key });
      const candidates = search.search(issueText(issue), perIssue);
      let result: Result;
      if (!candidates.length) result = { issue, suggestions: [], error: null, note: 'No test case shares words with it.' };
      else
        try {
          const answer = await api.llmChat(suggestPrompt(issue, candidates), true);
          const read = readSuggestions(answer, new Set(candidates.map((c) => c.item.id)));
          result = {
            issue,
            suggestions: read.suggestions,
            error: null,
            note: !read.readable ? 'The model’s answer couldn’t be read.' : read.dropped ? `The model named ${read.dropped} test case${read.dropped === 1 ? '' : 's'} it wasn’t offered (left out).` : null,
          };
        } catch (e) {
          result = { issue, suggestions: [], error: (e as Error).message, note: null };
          // The server can't be reached or refuses: the next issues would fail the same way.
          if (/Couldn't reach|refused the request|Nothing at|No language model|has no language model/.test(result.error!)) {
            if (live()) setResults([...done, result]);
            break;
          }
        }
      if (!live()) return;
      done.push(result);
      setResults([...done]);
    }
    if (live()) setRunning(null);
  };

  if (!issues.length) return null;
  if (status && !status.url)
    return (
      <p className="muted small">
        Set up a language model under <strong>Settings</strong> to have test cases suggested for these {issues.length} issues by what they’re about.
      </p>
    );

  const found = results.reduce((a, r) => a + r.suggestions.filter((s) => !picked.has(s.id)).length, 0);
  return (
    <section className="suggest" aria-label="Suggested test cases">
      <div className="inline-form wrap">
        <span className="strong">Suggest test cases by what the issues are about</span>
        <select value={which} onChange={(e) => setWhich(e.target.value as 'unlinked' | 'all')} disabled={!!running} aria-label="Which issues">
          <option value="unlinked">Issues with no test cases yet ({unlinked.length})</option>
          <option value="all">All the issues ({issues.length})</option>
        </select>
        {running ? (
          <button
            type="button"
            className="button"
            onClick={() => {
              gen.current++;
              setRunning(null);
            }}
          >
            Stop
          </button>
        ) : (
          <button type="button" className="button" onClick={() => void suggest()} disabled={!asked.length || !status}>
            {results.length ? 'Suggest again' : 'Suggest'}
          </button>
        )}
        {running && (
          <span className="muted small">
            Issue {running.at} of {running.of}: {running.key}…
          </span>
        )}
      </div>
      {!running && results.length > 0 && (
        <p className="muted small">
          {found ? `${found} suggestion${found === 1 ? '' : 's'} for ${results.length} issue${results.length === 1 ? '' : 's'}; ${chosen.length} test case${chosen.length === 1 ? '' : 's'} chosen to add to the run. Untick what doesn’t fit.` : `Nothing suggested for ${results.length} issue${results.length === 1 ? '' : 's'}.`}{' '}
          {chosen.length > 0 && (
            <button type="button" className="link-button small" onClick={() => addToWork(project, chosen.map((c) => ({ id: c.id, reason: c.reason })))}>
              Add the chosen to the work list
            </button>
          )}
        </p>
      )}
      {results.length > 0 && (
        <ul className="change-list suggest-list">
          {results.map((r) => (
            <li key={r.issue.key} className="suggest-issue">
              <span>
                <span className="mono">{r.issue.key}</span> {r.issue.summary}
              </span>
              {r.error && <span className="warn-text small">{r.error}</span>}
              {r.note && <span className="muted small">{r.note}</span>}
              {!r.error && !r.suggestions.length && !r.note && <span className="muted small">Nothing fits.</span>}
              {r.suggestions.map((s) => {
                const item = index.byId.get(s.id);
                const k = `${r.issue.key}>${s.id}`;
                const already = picked.has(s.id);
                return (
                  <label key={k} className="check suggest-row">
                    <input
                      type="checkbox"
                      checked={already || !unchosen.has(k)}
                      disabled={already}
                      onChange={(e) => {
                        const next = new Set(unchosen);
                        if (e.target.checked) next.delete(k);
                        else next.add(k);
                        setUnchosen(next);
                      }}
                    />
                    <span>
                      <span className="mono">{s.id}</span> {item?.title}
                      {already && <span className="muted small"> (already in the run)</span>}
                      {s.why && <span className="muted small"> · {s.why}</span>}
                    </span>
                  </label>
                );
              })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
