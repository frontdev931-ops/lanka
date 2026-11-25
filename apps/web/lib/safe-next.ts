// A path inside this app to go back to (after sign-in, from a notification): "/..." only, never another site ("//host", "\\", a scheme)
export function safeNext(v: string | null | undefined): string | null {
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.includes('\\') || /^\/+[a-z]+:/i.test(v) || v.length > 500) return null;
  if (v.startsWith('/login')) return null;
  return v;
}
