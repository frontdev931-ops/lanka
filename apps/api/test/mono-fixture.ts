import { generateKeyPairSync, sign } from 'node:crypto';
import type { MonoStatus } from '../src/billing/mono';

interface InvoiceRequest {
  amount: number;
  ccy: number;
  paymentType: string;
  validity: number;
  redirectUrl: string;
  webHookUrl: string;
  merchantPaymInfo: { reference: string; destination: string; basketOrder: { sum: number; total: number }[] };
}

export function monoFixture() {
  const token = 'fixture-mono-token';
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const foreignKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const invoices = new Map<string, InvoiceRequest>();
  const statuses = new Map<string, MonoStatus>();
  const statement = new Set<string>();
  let nextCreation: 'unknown' | 'rejected' | null = null;
  let nextPageUrl: string | undefined;
  let lastTime = 0;

  function event(reference: string, amount: number, status: MonoStatus['status'] = 'success', rest: Partial<MonoStatus> = {}) {
    lastTime = Math.max(Date.now(), lastTime + 1);
    return { reference, invoiceId: 'mono-' + reference, amount, ccy: 980, status, modifiedDate: new Date(lastTime).toISOString(), ...rest };
  }

  function install() {
    process.env.MONO_ACQUIRING_TOKEN = token;
    const mocked = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.monobank.ua');
      expect(new Headers(init?.headers).get('X-Token')).toBe(token);
      if (url.pathname === '/api/merchant/pubkey') {
        return Response.json({ key: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64') });
      }
      if (url.pathname === '/api/merchant/invoice/create') {
        expect(init?.method).toBe('POST');
        const body: InvoiceRequest = JSON.parse(String(init?.body));
        const mode = nextCreation;
        nextCreation = null;
        const pageUrl = nextPageUrl;
        nextPageUrl = undefined;
        if (mode === 'rejected') return Response.json({}, { status: 400 });
        const reference = body.merchantPaymInfo.reference;
        expect(invoices.has(reference)).toBe(false);
        invoices.set(reference, body);
        const reported = event(reference, body.amount, 'created');
        statuses.set(reported.invoiceId, reported);
        if (mode === 'unknown') throw new DOMException('timed out', 'TimeoutError');
        return Response.json({ invoiceId: reported.invoiceId, pageUrl: pageUrl ?? 'https://pay.mbnk.biz/' + reported.invoiceId });
      }
      if (url.pathname === '/api/merchant/invoice/status') {
        const report = statuses.get(url.searchParams.get('invoiceId')!);
        return report ? Response.json(report) : Response.json({}, { status: 404 });
      }
      if (url.pathname === '/api/merchant/statement') {
        return Response.json({ list: [...statement].map((id) => statuses.get(id)) });
      }
      throw new Error('Unexpected request in mono fixture');
    });
    return () => { mocked.mockRestore(); delete process.env.MONO_ACQUIRING_TOKEN; };
  }

  return {
    invoices, install, event,
    failNext: (mode: 'unknown' | 'rejected') => { nextCreation = mode; },
    pageUrlNext: (url: string) => { nextPageUrl = url; },
    report: (status: MonoStatus, inStatement = false) => {
      statuses.set(status.invoiceId, status);
      if (inStatement) statement.add(status.invoiceId);
    },
    signature: (body: string, valid = true) => sign('sha256', Buffer.from(body), valid ? privateKey : foreignKey).toString('base64'),
  };
}
