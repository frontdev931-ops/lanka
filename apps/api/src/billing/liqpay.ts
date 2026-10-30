import { createHash, timingSafeEqual } from 'crypto';

export const LIQPAY_CHECKOUT = 'https://www.liqpay.ua/api/3/checkout';

// LiqPay signs a request as base64(sha1(private_key + data + private_key)), where data is the base64 of the JSON parameters
export const sign = (data: string, privateKey: string) => createHash('sha1').update(privateKey + data + privateKey).digest('base64');

export function signatureValid(data: string, signature: string, privateKey: string): boolean {
  const want = Buffer.from(sign(data, privateKey));
  const got = Buffer.from(signature ?? '');
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface LiqpayParams {
  version: number;
  public_key: string;
  action: 'pay';
  amount: number;
  currency: 'UAH';
  description: string;
  order_id: string;
  result_url?: string;
  server_url?: string;
  language?: string;
}

export function buildCheckout(params: Omit<LiqpayParams, 'version' | 'public_key' | 'action' | 'currency'>, keys: { publicKey: string; privateKey: string }) {
  const data = Buffer.from(JSON.stringify({ version: 3, public_key: keys.publicKey, action: 'pay', currency: 'UAH', ...params })).toString('base64');
  return { url: LIQPAY_CHECKOUT, data, signature: sign(data, keys.privateKey) };
}

export interface LiqpayCallback {
  order_id?: string;
  status?: string;
  amount?: number;
  currency?: string;
  payment_id?: number | string;
}

export const decodeCallback = (data: string): LiqpayCallback | null => {
  try {
    return JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as LiqpayCallback;
  } catch {
    return null;
  }
};
