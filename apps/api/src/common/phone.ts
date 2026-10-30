// Телефон в едином виде «только цифры, с кодом страны». Украинские номера в любой записи
// (0501234567, +38 (050) 123-45-67, 380501234567, 80501234567, 501234567) сводятся к 380501234567.
// Номера других стран остаются как есть (только цифры). Слишком короткие значения не считаются телефоном.
export function normalizePhone(raw?: string | null): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length < 9) return null;
  if (d.length === 9) return '380' + d;
  if (d.length === 10 && d.startsWith('0')) return '38' + d;
  if (d.length === 11 && d.startsWith('80')) return '3' + d;
  return d;
}
