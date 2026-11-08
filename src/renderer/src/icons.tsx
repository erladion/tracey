// Stroke icons, drawn on a 16×16 grid in the current text colour.
import type { ReactNode } from 'react';

const paths: Record<string, ReactNode> = {
  logo: (
    <>
      <circle cx="4" cy="4" r="2.4" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M5.8 5.8l4.4 4.4" />
    </>
  ),
  bold: <path d="M4.5 3h4.2a2.4 2.4 0 010 4.8H4.5zM4.5 7.8h4.8a2.6 2.6 0 010 5.2H4.5z" />,
  italic: <path d="M7 3h5M4 13h5M9.5 3l-3 10" />,
  strike: <path d="M3 8h10M10.8 5.2C10.4 3.9 9.3 3.2 8 3.2c-1.7 0-2.9.9-2.9 2.2M5 10.6c.3 1.4 1.5 2.2 3.1 2.2 1.8 0 3-1 3-2.3" />,
  code: <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />,
  link: <path d="M6.8 9.2a2.6 2.6 0 003.7 0l2.2-2.2a2.6 2.6 0 00-3.7-3.7l-.8.8M9.2 6.8a2.6 2.6 0 00-3.7 0L3.3 9a2.6 2.6 0 003.7 3.7l.8-.8" />,
  bullets: <path d="M6 4h8M6 8h8M6 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />,
  numbers: <path d="M6.5 4h7.5M6.5 8h7.5M6.5 12h7.5M2 3l1-.5V6M2 9.2c.3-.5 1.8-.6 1.8.3 0 .7-1.8 1.4-1.8 2.2h1.9" />,
  quote: <path d="M3 4v8M6 5h7M6 8h7M6 11h5" />,
  codeblock: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M6 6.5L4.5 8 6 9.5M10 6.5L11.5 8 10 9.5" />
    </>
  ),
  table: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M2 10h12M6.5 6.5v7" />
    </>
  ),
  rule: <path d="M2 8h12" />,
  undo: <path d="M5 4L2.5 6.5 5 9M2.5 6.5H10a3.5 3.5 0 010 7H7" />,
  redo: <path d="M11 4l2.5 2.5L11 9M13.5 6.5H6a3.5 3.5 0 000 7h3" />,
  plus: <path d="M8 3v10M3 8h10" />,
  edit: <path d="M10.5 2.5l3 3L6 13H3v-3zM9 4l3 3" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.8A1.3 1.3 0 009.2 2.5H3.8a1.3 1.3 0 00-1.3 1.3v5.4a1.3 1.3 0 001.3 1.3h1.7" />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </>
  ),
  branch: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-6.2 4.3" />
    </>
  ),
  up: <path d="M8 13V3M4 7l4-4 4 4" />,
  down: <path d="M8 3v10M4 9l4 4 4-4" />,
  check: <path d="M3 8.5l3 3 7-7" />,
  error: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
    </>
  ),
  alert: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8v3.8M8 11.1v.1" />
    </>
  ),
  gap: <circle cx="8" cy="8" r="5.5" strokeDasharray="2.4 2" />,
  warn: (
    <>
      <path d="M8 2.5l6 10.5H2z" />
      <path d="M8 7v2.5M8 11.3h.01" />
    </>
  ),
  dot: <circle cx="8" cy="8" r="2.5" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />,
  folder: <path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z" />,
  download: <path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
    </>
  ),
  moon: <path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" />,
  history: (
    <>
      <path d="M2.5 8a5.5 5.5 0 101.6-3.9M2.5 2.5v2.5H5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  external: <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" />,
  refresh: <path d="M13 3v3.5H9.5M3 13V9.5h3.5M12.5 6.5A5 5 0 004 5M3.5 9.5A5 5 0 0012 11" />,
  more: <path d="M4 8h.01M8 8h.01M12 8h.01" />,
};

export function Icon({ name, size = 16, label }: { name: keyof typeof paths | string; size?: number; label?: string }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {paths[name]}
    </svg>
  );
}
