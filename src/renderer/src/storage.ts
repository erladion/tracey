// Per-viewer conveniences (last repository, theme, selection). Never required.
export function load<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v == null ? null : (JSON.parse(v) as T);
  } catch {
    return null;
  }
}

export function save(key: string, value: unknown) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: nothing is remembered, which is fine.
  }
}
