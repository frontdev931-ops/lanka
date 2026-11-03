const DEFAULT_BASE = 'https://cliniccards.com/api';

// Whitelist: the client can only do GET and only these paths. Any write and delete
// (creating payments and invoices, deleting patients and appointments) is technically impossible.
// Payments and acts (/payments, /invoices) are read-only financial data for reports;
// access to them in the app is limited by roles.
const ALLOWED_GET = new Set([
  '/visits',
  '/patients',
  '/plans',
  '/planItems',
  '/payments',
  '/invoices',
  '/staff',
  '/clinic-profile',
  '/cabinets',
  '/sub-clinics',
  '/schedule-shifts',
  '/schedule-settings',
  '/schedule-spaces',
  '/reminders',
  '/waitings',
  '/prices',
]);

// Writing is allowed only for these paths. Payments, invoices, deposits, spendings, stock and any DELETE must never be added here.
// Two keys protect a real clinic: the server setting CLINICCARDS_WRITE_ENABLED=true (and the clinic's own flag, checked by the caller),
// and, for the real Cliniccards address, a second explicit CLINICCARDS_WRITE_LIVE=true that is turned on only in the manual
// verification stage together with the clinic owner. Against a mock (an overridden address) the first key is enough.
const ALLOWED_POST = new Set(['/visits', '/patients']);
const ALLOWED_PUT = new Set(['/visits', '/patients']);

export class CliniccardsError extends Error {
  // The request may have reached Cliniccards although we got no clear answer (timeout, broken connection, unreadable reply):
  // the caller must check what happened before sending it again
  constructor(
    message: string,
    readonly ambiguous = false,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  data: T;
  result: 'success' | 'fail';
  error: string | null;
}

export interface ClientOptions {
  baseUrl?: string;
  // Cliniccards' limit is 60 requests per minute per key: by default we keep a margin
  minIntervalMs?: number;
  retryDelayMs?: number;
}

// The API address can be replaced (to imitate the server in development) only outside production,
// otherwise a clinic's key could be sent to a foreign address through an environment variable.
export function resolveBaseUrl(explicit?: string) {
  if (explicit) return explicit;
  if (process.env.NODE_ENV !== 'production' && process.env.CLINICCARDS_BASE_URL) return process.env.CLINICCARDS_BASE_URL;
  return DEFAULT_BASE;
}

export class CliniccardsClient {
  private nextSlot = 0;
  private readonly base: string;
  private readonly minInterval: number;
  private readonly retryDelay: number;

  constructor(
    private readonly apiKey: string,
    opts: ClientOptions = {},
  ) {
    this.base = resolveBaseUrl(opts.baseUrl);
    // To imitate the server in development and in tests the pause between requests can be removed (outside production)
    const envInterval = process.env.NODE_ENV !== 'production' ? process.env.CLINICCARDS_MIN_INTERVAL_MS : undefined;
    this.minInterval = opts.minIntervalMs ?? (envInterval !== undefined ? Number(envInterval) : 1100);
    this.retryDelay = opts.retryDelayMs ?? 15_000;
  }

  async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    if (!ALLOWED_GET.has(path)) throw new CliniccardsError(`Путь не разрешён: ${path}`);
    await this.wait();

    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { Token: this.apiKey, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        // Neither the key nor the full URL with parameters gets into the message; only the reason code.
        const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
        throw new CliniccardsError(`Cliniccards ${path}: нет связи с сервером (${cause})`);
      }
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, this.retryDelay));
        continue;
      }
      const body = (await res.json().catch(() => null)) as Envelope<T> | null;
      if (!res.ok || !body || body.result !== 'success') {
        throw new CliniccardsError(`Cliniccards ${path}: ${body?.error ?? res.status}`);
      }
      return body.data;
    }
  }

  private assertWritable(path: string, allowed: Set<string>) {
    if (!allowed.has(path)) throw new CliniccardsError(`Путь не разрешён для записи: ${path}`);
    if (process.env.CLINICCARDS_WRITE_ENABLED !== 'true') throw new CliniccardsError('Запись в Cliniccards отключена');
    if (this.base === DEFAULT_BASE && process.env.CLINICCARDS_WRITE_LIVE !== 'true') throw new CliniccardsError('Запись в настоящий Cliniccards не разрешена');
  }

  private async write<T>(method: 'POST' | 'PUT', path: string, body: Record<string, unknown>): Promise<T> {
    this.assertWritable(path, method === 'POST' ? ALLOWED_POST : ALLOWED_PUT);
    await this.wait();
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { Token: this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
      throw new CliniccardsError(`Cliniccards ${path}: нет связи с сервером (${cause})`, true);
    }
    // No automatic retries on purpose: a repeated write after a doubtful answer could create a second record
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!json) throw new CliniccardsError(`Cliniccards ${path}: нечитаемый ответ (${res.status})`, true);
    if (!res.ok || json.result !== 'success') throw new CliniccardsError(`Cliniccards ${path}: ${json.error ?? res.status}`, res.status >= 500);
    return json.data;
  }

  post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.write<T>('POST', path, body);
  }

  put<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.write<T>('PUT', path, body);
  }

  // A simple queue: requests go no more often than one per minInterval ms.
  private async wait() {
    if (!this.minInterval) return;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minInterval;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }
}
