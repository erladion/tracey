// Short messages at the bottom of the window.
export type ToastKind = 'info' | 'error' | 'success';
export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  action?: { label: string; run: () => void }; // a button on the message: Undo, say
}

type Listener = (toasts: Toast[]) => void;
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l(toasts));

export function notify(message: string, kind: ToastKind = 'info', action?: Toast['action']) {
  const t = { id: nextId++, message, kind, action };
  toasts = [...toasts, t];
  emit();
  // A message with something to do stays a little longer.
  setTimeout(() => dismiss(t.id), kind === 'error' ? 9000 : action ? 8000 : 3500);
}

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  l(toasts);
  return () => listeners.delete(l);
}
