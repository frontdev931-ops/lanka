import { createHash, randomBytes } from 'crypto';

// Одноразовые ссылки: пользователю уходит случайный токен, в базе лежит только его хэш
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
