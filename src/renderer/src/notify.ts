// Short messages at the bottom of the window.
export type ToastKind = 'info' | 'error' | 'success';
export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

type Listener = (toasts: Toast[]) => void;
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l(toasts));

export function notify(message: string, kind: ToastKind = 'info') {
  const t = { id: nextId++, message, kind };
  toasts = [...toasts, t];
  emit();
  setTimeout(() => dismiss(t.id), kind === 'error' ? 9000 : 3500);
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
