// Small shared pieces: status pills, link-state badges, chip inputs.
import { useState, type KeyboardEvent } from 'react';
import type { LinkState } from '../../../core/model';
import type { Result } from '../../../core/runs';
import type { TraceConfig } from '../../../core/config';
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

// The variants an item is limited to; nothing when it applies to all.
export function VariantTag({ variants, config }: { variants: string[]; config: TraceConfig }) {
  if (!variants.length) return null;
  const names = variants.map((v) => config.variants.find((x) => x.key === v)?.name ?? v);
  return (
    <span className="variant-tag" title={`Only for ${names.join(', ')}`}>
      {names.join(', ')}
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
  idKey?: string; // when the label isn't unique on the page
}

export function ChipInput({ label, values, onChange, suggestions = [], href, onOpen, placeholder, mono, idKey }: ChipProps) {
  const [text, setText] = useState('');
  const id = `chips-${(idKey ?? label).replace(/\W/g, '')}`;
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
  // Thousands of suggestions (requirements in a large project) are offered as you type,
  // a couple of hundred at a time: a list of them all is too long to draw, or to use.
  const q = text.trim().toLowerCase();
  const many = suggestions.length > 500;
  const options = (many ? (q ? suggestions.filter((s) => `${s.value} ${s.label}`.toLowerCase().includes(q)) : []) : suggestions).filter((s) => !values.includes(s.value)).slice(0, 200);
  return (
    <div className="chip-field">
      <label htmlFor={id} className="chip-label">
        {label}
      </label>
      <div className="chips">
        {values.map((v) => {
          const url = href?.(v);
          // A known value shows its name (a component's or variant's); the key is in the file.
          const named = suggestions.find((s) => s.value === v && s.label && s.label !== v);
          return (
            <span key={v} className={`chip${mono ? ' mono' : ''}`} title={named ? v : undefined}>
              {url ? (
                <a href={url} target="_blank" rel="noreferrer">
                  {v}
                </a>
              ) : onOpen ? (
                <button type="button" className="chip-open" onClick={() => onOpen(v)}>
                  {v}
                </button>
              ) : (
                (named?.label ?? v)
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

// Long lists show a page at a time: drawing thousands of rows at once freezes the
// window. `reset` starts over at one page (a new filter, say); `need` is a position that
// must be shown (the selected row).
export function useShown(total: number, page: number, reset: unknown, need = -1): { shown: number; more: (all?: boolean) => void } {
  const [count, setCount] = useState(page);
  const [last, setLast] = useState(reset);
  if (last !== reset) {
    setLast(reset);
    setCount(page);
  }
  const shown = Math.min(total, Math.max(count, need + 1));
  return { shown, more: (all) => setCount(all ? total : shown + page) };
}

export function ShowMore({ shown, total, more, what }: { shown: number; total: number; more: (all?: boolean) => void; what: string }) {
  if (shown >= total) return null;
  return (
    <div className="show-more">
      <span className="muted small">
        Showing {shown.toLocaleString()} of {total.toLocaleString()} {what}.
      </span>
      <button type="button" className="link-button small" onClick={() => more()}>
        Show more
      </button>
      <button type="button" className="link-button small" onClick={() => more(true)} title="Drawing thousands of rows takes a while">
        Show all
      </button>
    </div>
  );
}
