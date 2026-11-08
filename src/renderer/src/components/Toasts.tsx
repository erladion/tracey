import { useEffect, useState } from 'react';
import { dismiss, subscribe, type Toast } from '../notify';

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribe(setToasts), []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="link-button strong"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="link-button" onClick={() => dismiss(t.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
