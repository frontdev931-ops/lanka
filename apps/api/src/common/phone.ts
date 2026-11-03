// A phone in one form, "digits only, with the country code". Ukrainian numbers in any notation
// (0501234567, +38 (050) 123-45-67, 380501234567, 80501234567, 501234567) are reduced to 380501234567.
// Numbers of other countries stay as they are (digits only). Values that are too short are not treated as a phone.
export function normalizePhone(raw?: string | null): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length < 9) return null;
  if (d.length === 9) return '380' + d;
  if (d.length === 10 && d.startsWith('0')) return '38' + d;
  if (d.length === 11 && d.startsWith('80')) return '3' + d;
  return d;
}
