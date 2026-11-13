// Settings: the language model that suggests test cases for Jira issues (any OpenAI-style
// API: llama.cpp, vLLM, Ollama, LM Studio, or a hosted one over https with an API key).
import { useEffect, useState } from 'react';
import type { LlmStatus } from '../../../shared/api';
import { candidateCount } from '../../../core/suggest';
import { api } from '../api';
import { Icon } from '../icons';
import { notify } from '../notify';

export function LlmCard() {
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [url, setUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [think, setThink] = useState(false);
  const [candidates, setCandidates] = useState('');
  const [busy, setBusy] = useState(false);

  const check = async (fill: boolean) => {
    setChecking(true);
    try {
      const s = await api.llmStatus();
      setStatus(s);
      if (fill) {
        setUrl(s.url);
        setModel(s.model);
        setThink(s.think);
        setCandidates(s.candidates ? String(s.candidates) : '');
      }
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    void check(true);
  }, []);

  const save = async (keyChange: string | null | undefined) => {
    setBusy(true);
    try {
      await api.llmSetup({ url, model, key: keyChange, think, candidates: Number(candidates) || 0 });
      setKey('');
      notify(url.trim() ? 'Language model saved.' : 'Language model removed.', 'success');
      await check(true);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const perIssue = status ? candidateCount(status.candidates, status.contextSize) : 0;
  const models = status ? [...new Set([...status.models, ...(model ? [model] : [])])] : [];

  return (
    <section className="card">
      <h2>Language model</h2>
      <p className="muted small">
        Suggests test cases for Jira issues by what they’re about, in <strong>Test runs → New test run</strong>. Any server with an OpenAI-style API works: llama.cpp
        (llama-server), vLLM, Ollama, LM Studio, or a hosted one over https with an API key. Issue texts and test case titles are sent to it.
      </p>

      <div className="code-status">
        {checking ? (
          <span className="muted">Asking the server…</span>
        ) : !status ? (
          <span className="muted">Not read yet.</span>
        ) : !status.url ? (
          <span className="muted">{status.editable ? 'Not set up: enter its address below.' : 'Not set up: the server needs TRACE_LLM_URL in its environment.'}</span>
        ) : status.error ? (
          <span className="warn-text">{status.error}</span>
        ) : (
          <>
            <span>
              Connected to <span className="strong">{status.url}</span>: {status.models.length} model{status.models.length === 1 ? '' : 's'}, using{' '}
              <span className="strong">{status.model || status.models[0] || '?'}</span>
              {status.contextSize ? ` (context ${status.contextSize.toLocaleString()} tokens)` : ''}.
            </span>
            <span className="muted small">
              Offers each issue its {perIssue} likeliest test cases{status.candidates ? '' : status.contextSize ? ', from the context size' : ' (the server doesn’t say its context size)'}
              {status.think ? '; the model thinks before answering' : ''}.
            </span>
          </>
        )}
      </div>

      {status?.editable ? (
        <form
          className="inline-form wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void save(key.trim() ? key : undefined);
          }}
        >
          <label className="field grow">
            <span>Address (the API’s base)</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8080/v1" spellCheck={false} />
          </label>
          <label className="field">
            <span>Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">The server’s first</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>API key, if it needs one (kept encrypted on this computer)</span>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" placeholder={status.hasKey ? '•••••••• (saved)' : ''} />
          </label>
          <label className="field">
            <span>Test cases per issue</span>
            <input type="number" min={0} max={500} value={candidates} onChange={(e) => setCandidates(e.target.value)} placeholder={`auto (${candidateCount(0, status.contextSize)})`} />
          </label>
          <label className="check">
            <input type="checkbox" checked={think} onChange={(e) => setThink(e.target.checked)} />
            <span>Let the model think before answering (reasoning models: slower, sometimes better)</span>
          </label>
          <div className="dialog-actions">
            <button type="submit" className="button primary" disabled={busy}>
              Save
            </button>
            {status.hasKey && (
              <button type="button" className="button" disabled={busy} onClick={() => void save(null)}>
                Remove the key
              </button>
            )}
            <button type="button" className="button" disabled={checking} onClick={() => void check(false)}>
              <Icon name="refresh" /> Test the connection
            </button>
          </div>
        </form>
      ) : status && status.url ? (
        <p className="muted small">
          Set where the server runs: <code>TRACE_LLM_URL</code>, <code>TRACE_LLM_MODEL</code>, <code>TRACE_LLM_KEY</code>, <code>TRACE_LLM_THINK</code>,{' '}
          <code>TRACE_LLM_CANDIDATES</code>.
        </p>
      ) : null}
    </section>
  );
}
