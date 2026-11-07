// Small shared pieces: status pills, link-state badges, chip inputs.
import { useState, type KeyboardEvent } from 'react';
import type { LinkState } from '../../../core/model';
import type { Result } from '../../../core/runs';
import { Icon } from '../icons';

export function StatusPill({ status }: { status: string }) {
  if (!status) return <span className="pill muted-pill">no status</span>;
  return <span className={`pill status-${status.replace(/[^\w-]/g, '')}`}>{status}</span>;
}

export const RESULT_LABEL: Record<Result, string> = { passed: 'Passed', failed: 'Failed', blocked: 'Blocked', 'not-run': 'Not run' };

export function ResultPill({ result, title }: { result: Result; title?: string }) {
  return (
    <span className={`result-pill ${result}`} title={title}>
      {RESULT_LABEL[result]}
    </span>
  );
}

export function LinkBadge({ state }: { state: LinkState }) {
  if (state === 'ok')
    return (
      <span className="link-badge ok" title="Reviewed against the requirement's current text">
        <Icon name="check" size={14} /> Reviewed
      </span>
    );
  if (state === 'suspect')
    return (
      <span className="link-badge suspect" title="The requirement changed since this link was last reviewed">
        <Icon name="warn" size={14} /> Changed since review
      </span>
    );
  return (
    <span className="link-badge unreviewed" title="Not reviewed against a version of the requirement yet">
      Not reviewed
    </span>
  );
}

interface ChipProps {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  suggestions?: { value: string; label: string }[];
  href?: (value: string) => string | null;
  onOpen?: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}

export function ChipInput({ label, values, onChange, suggestions = [], href, onOpen, placeholder, mono }: ChipProps) {
  const [text, setText] = useState('');
  const id = `chips-${label.replace(/\W/g, '')}`;
  const add = (raw: string) => {
    const v = raw.trim().replace(/,$/, '');
    if (v && !values.includes(v)) onChange([...values, v]);
    setText('');
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && text.trim())) {
      if (text.trim()) {
        e.preventDefault();
        add(text);
      }
    } else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
  };
  const options = suggestions.filter((s) => !values.includes(s.value));
  return (
    <div className="chip-field">
      <label htmlFor={id} className="chip-label">
        {label}
      </label>
      <div className="chips">
        {values.map((v) => {
          const url = href?.(v);
          return (
            <span key={v} className={`chip${mono ? ' mono' : ''}`}>
              {url ? (
                <a href={url} target="_blank" rel="noreferrer">
                  {v}
                </a>
              ) : onOpen ? (
                <button type="button" className="chip-open" onClick={() => onOpen(v)}>
                  {v}
                </button>
              ) : (
                v
              )}
              <button type="button" className="chip-remove" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
                <Icon name="close" size={12} />
              </button>
            </span>
          );
        })}
        <input
          id={id}
          className="chip-input"
          value={text}
          list={options.length ? `${id}-list` : undefined}
          onChange={(e) => {
            const v = e.target.value;
            // Picking from the list adds at once.
            if (options.some((o) => o.value === v)) add(v);
            else setText(v);
          }}
          onKeyDown={key}
          onBlur={() => text.trim() && add(text)}
          placeholder={values.length ? '' : placeholder}
          spellCheck={false}
        />
        {options.length > 0 && (
          <datalist id={`${id}-list`}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </datalist>
        )}
      </div>
    </div>
  );
}

export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
