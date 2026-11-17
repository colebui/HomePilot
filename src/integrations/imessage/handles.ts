/**
 * iMessage handles are phone numbers or Apple ID emails, and the same person can appear as
 * "+1 (512) 555-0100", "15125550100" or "+15125550100". Compare handles only after normalizing.
 */
export function normalizeHandle(raw: string): string {
  const s = raw.trim();
  if (s.includes('@')) return s.toLowerCase();
  const digits = s.replace(/\D/g, '');
  if (!digits) return s;
  if (s.startsWith('+')) return `+${digits}`;
  // Without a country code, assume North America (imsg's own default region is US).
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/** The configured allowlist entry this handle matches, or undefined. */
export function matchAllowed(handle: string, allowed: readonly string[]): string | undefined {
  const n = normalizeHandle(handle);
  return allowed.find((a) => a !== 'local-cli' && normalizeHandle(a) === n);
}

/** For logs: keep only enough to recognise a handle. "+15125550100" -> "…0100", "a@b.com" -> "…@b.com". */
export function maskHandle(raw: string): string {
  const n = normalizeHandle(raw);
  if (n.includes('@')) return `…@${n.split('@')[1] ?? ''}`;
  return `…${n.slice(-4)}`;
}
