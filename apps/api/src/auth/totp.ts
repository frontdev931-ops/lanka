import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// Временные одноразовые коды по RFC 6238 (SHA-1, 6 цифр, шаг 30 секунд): совместимы с Google Authenticator, Microsoft Authenticator, Authy.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(randomBytes(20));

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export const stepOf = (t = Date.now()) => Math.floor(t / 1000 / STEP_SECONDS);

// Возвращает номер шага, на котором код подошёл (с запасом ±1 шаг на расхождение часов), либо null
export function verifyTotp(secret: string, code: string, t = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = stepOf(t);
  for (const s of [step, step - 1, step + 1]) {
    const a = Buffer.from(hotp(secret, s));
    const b = Buffer.from(code);
    if (a.length === b.length && timingSafeEqual(a, b)) return s;
  }
  return null;
}

export const otpauthUrl = (secret: string, email: string, issuer = 'LANKA') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;

// Резервные коды: 10 символов, группами по 5 («ABCDE-FGHJK»), без похожих букв
export const newRecoveryCode = () => {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  const s = [...bytes].map((b) => alpha[b % alpha.length]).join('');
  return `${s.slice(0, 5)}-${s.slice(5)}`;
};
