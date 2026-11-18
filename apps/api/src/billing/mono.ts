import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createPublicKey, KeyObject, verify } from 'node:crypto';

const BASE = 'https://api.monobank.ua';
const CHECKOUT_ORIGINS = new Set(['https://pay.mbnk.biz', 'https://pay.monobank.ua']);
export const MONO_CURRENCY = 980;
export const INVOICE_VALIDITY = 15 * 60;
const STATUSES = ['created', 'processing', 'hold', 'success', 'failure', 'reversed', 'expired'] as const;

export interface MonoStatus {
  invoiceId: string;
  status: typeof STATUSES[number];
  amount: number;
  ccy: number;
  reference?: string;
  finalAmount?: number;
  modifiedDate: string;
  cancelList?: { status: string; amount: number; ccy: number; modifiedDate?: string }[];
}

export class MonoRequestError extends Error {
  constructor(readonly status?: number) {
    super('mono_request_failed');
  }
}

@Injectable()
export class MonoClient {
  private key?: { value: KeyObject; token: string; expires: number };
  private keyRequest?: { token: string; promise: Promise<KeyObject> };

  get configured() {
    return !!process.env.MONO_ACQUIRING_TOKEN?.trim();
  }

  private async request(path: string, body?: object): Promise<unknown> {
    const token = process.env.MONO_ACQUIRING_TOKEN?.trim();
    if (!token) throw new MonoRequestError();
    try {
      const res = await fetch(BASE + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'X-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8_000),
        redirect: 'error',
      });
      if (!res.ok) throw new MonoRequestError(res.status);
      return await res.json();
    } catch (e) {
      throw e instanceof MonoRequestError ? e : new MonoRequestError();
    }
  }

  async create(order: { id: string; orderId: string; amountMinor: number; currency: number; networkId: string | null; kind: string; plan: string | null; setupMinor: number }, description: string) {
    const origin = (process.env.WEB_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
    const redirect = new URL(order.networkId ? '/network' : '/settings?tab=billing', origin);
    if (order.networkId) redirect.searchParams.set('network', order.networkId);
    redirect.searchParams.set('payment', order.id);
    const setup = order.setupMinor < order.amountMinor ? order.setupMinor : 0;
    const service = order.amountMinor - setup;
    const basketOrder = [{ name: description, qty: 1, sum: service, total: service, unit: 'посл.', code: order.plan ?? order.kind }];
    if (setup) basketOrder.push({ name: 'LANKA: разове підключення', qty: 1, sum: setup, total: setup, unit: 'посл.', code: 'SETUP' });
    const response = await this.request('/api/merchant/invoice/create', {
      amount: order.amountMinor, ccy: order.currency, paymentType: 'debit', validity: INVOICE_VALIDITY,
      redirectUrl: redirect.href, webHookUrl: origin + '/backend/billing/mono/webhook',
      merchantPaymInfo: {
        reference: order.orderId, destination: setup ? description + ' + підключення' : description, basketOrder,
      },
    }) as { invoiceId?: string; pageUrl?: string } | null;
    if (typeof response?.invoiceId !== 'string' || !response.invoiceId) throw new MonoRequestError();
    const { invoiceId, pageUrl } = response;
    if (typeof pageUrl === 'string' && URL.canParse(pageUrl)) {
      const page = new URL(pageUrl);
      if (CHECKOUT_ORIGINS.has(page.origin) && !page.username && !page.password) return { invoiceId, pageUrl };
    }
    // An unusable URL is not a failed invoice. Keep its ID for reconciliation.
    return { invoiceId, pageUrl: null };
  }

  async status(invoiceId: string) {
    const status = readMonoStatus(await this.request('/api/merchant/invoice/status?' + new URLSearchParams({ invoiceId })));
    if (!status || status.invoiceId !== invoiceId) throw new MonoRequestError();
    return status;
  }

  async findInvoice(reference: string, createdAt: Date) {
    const from = Math.floor(createdAt.getTime() / 1000) - 1;
    const to = Math.min(Math.floor(Date.now() / 1000), from + 86_400);
    const statement = await this.request('/api/merchant/statement?' + new URLSearchParams({ from: String(from), to: String(to) })) as { list?: { invoiceId?: string; reference?: string }[] } | null;
    if (!Array.isArray(statement?.list)) throw new MonoRequestError();
    const matches = [...new Set(statement.list.filter((row) => row?.reference === reference).map((row) => row.invoiceId))];
    return matches.length === 1 && typeof matches[0] === 'string' ? matches[0] : null;
  }

  async validSignature(body: Buffer, signature: string) {
    if (signature.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
    const bytes = Buffer.from(signature, 'base64');
    const token = process.env.MONO_ACQUIRING_TOKEN?.trim();
    if (!token) throw new ServiceUnavailableException('billing_not_configured');
    try {
      const cached = this.key?.token === token && this.key.expires > Date.now() ? this.key.value : null;
      if (cached && verify('sha256', body, cached, bytes)) return true;
      // The bank recommends refreshing the public key if the stored key no longer verifies.
      if (cached && this.key!.expires - Date.now() > 60 * 60_000 - 30_000) return false;
      const key = await this.fetchKey(token);
      return verify('sha256', body, key, bytes);
    } catch {
      throw new ServiceUnavailableException('billing_provider_unavailable');
    }
  }

  private async fetchKey(token: string): Promise<KeyObject> {
    if (this.keyRequest?.token === token) return this.keyRequest.promise;
    const request = { token, promise: this.request('/api/merchant/pubkey').then((data) => {
      const base64 = (data as { key?: string } | null)?.key;
      if (typeof base64 !== 'string') throw new MonoRequestError();
      const value = createPublicKey(Buffer.from(base64, 'base64'));
      if (value.asymmetricKeyType !== 'ec') throw new MonoRequestError();
      this.key = { token, value, expires: Date.now() + 60 * 60_000 };
      return value;
    }) };
    this.keyRequest = request;
    try {
      return await request.promise;
    } finally {
      if (this.keyRequest === request) this.keyRequest = undefined;
    }
  }
}

export function readMonoStatus(value: unknown): MonoStatus | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as MonoStatus;
  if (typeof data.invoiceId !== 'string' || !data.invoiceId || !STATUSES.includes(data.status) ||
      !Number.isSafeInteger(data.amount) || !Number.isSafeInteger(data.ccy) ||
      typeof data.modifiedDate !== 'string' || !Number.isFinite(Date.parse(data.modifiedDate))) return null;
  return data;
}
