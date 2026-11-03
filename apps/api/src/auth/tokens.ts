import { createHash, randomBytes } from 'crypto';

// One-time links: the user gets a random token, only its hash is stored in the database
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
