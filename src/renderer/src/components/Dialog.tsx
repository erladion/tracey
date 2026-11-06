import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '../icons';

// A modal dialog: Escape or the close button cancels.
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input, textarea, select, button.primary');
    first?.focus();
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
