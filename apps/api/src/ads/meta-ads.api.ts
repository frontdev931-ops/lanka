import { Injectable } from '@nestjs/common';
import { graphVersion } from '../automations/meta-login.api';

// Why Meta refused: the token is no longer valid, the permission or the account access is missing, the API limit was hit, or anything else
export type AdsErrorKind = 'expired' | 'no_permission' | 'rate_limited' | 'meta_error';
export class MetaAdsError extends Error {
  constructor(
    message: string,
    readonly kind: AdsErrorKind,
    readonly code?: number,
  ) {
    super(message);
  }
}

// Meta's error codes (Graph API / Marketing API error reference): 190 an invalid or expired token; 10, 200-299 a missing permission;
// 4, 17, 32, 613 and 80000-80014 the call or business-use-case rate limits
export function kindOf(code?: number, subcode?: number): AdsErrorKind {
  if (code === 190 || subcode === 463 || subcode === 467) return 'expired';
  if (code === 10 || (code !== undefined && code >= 200 && code < 300)) return 'no_permission';
  if (code === 4 || code === 17 || code === 32 || code === 613 || (code !== undefined && code >= 80000 && code <= 80014)) return 'rate_limited';
  return 'meta_error';
}

export interface AdAccountInfo {
  accountId: string;
  name: string;
  currency: string;
  timezoneName: string;
  // Meta's account_status: 1 active, 2 disabled, 3 unsettled, ...
  status: number | null;
}
export interface InsightRow {
  campaign_id?: string;
  campaign_name?: string;
  date_start?: string;
  date_stop?: string;
  spend?: string;
  impressions?: string;
  inline_link_clicks?: string;
  reach?: string;
  actions?: { action_type: string; value: string }[];
}

// The Marketing API, read only (ads_read). The token goes in a header, never in the address or the log.
@Injectable()
export class MetaAdsApi {
  private async get<T>(token: string, path: string, params: Record<string, string> = {}): Promise<T> {
    const q = new URLSearchParams(params);
    let res: Response;
    try {
      res = await fetch(`https://graph.facebook.com/${graphVersion()}/${path}${q.toString() ? `?${q}` : ''}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new MetaAdsError('Meta недоступна', 'meta_error');
    }
    const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: number; error_subcode?: number } }) | null;
    if (!res.ok || !json || json.error) {
      const code = json?.error?.code ?? res.status;
      throw new MetaAdsError((json?.error?.message ?? `Meta ${res.status}`).slice(0, 200), kindOf(code, json?.error?.error_subcode), code);
    }
    return json;
  }

  // Every page of a list (cursor paging; the token is never put into a "next" address)
  private async all<T>(token: string, path: string, params: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let i = 0; i < 50; i++) {
      const r = await this.get<{ data?: T[]; paging?: { cursors?: { after?: string }; next?: string } }>(token, path, { ...params, ...(after ? { after } : {}) });
      out.push(...(r.data ?? []));
      after = r.paging?.next ? r.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  }

  // The ad accounts this person can reach with the granted permission
  async adAccounts(token: string): Promise<AdAccountInfo[]> {
    const rows = await this.all<{ account_id?: string; id?: string; name?: string; currency?: string; timezone_name?: string; account_status?: number }>(token, 'me/adaccounts', { fields: 'account_id,name,currency,timezone_name,account_status', limit: '200' });
    return rows.map(toAccount).filter((a): a is AdAccountInfo => !!a);
  }

  async account(token: string, accountId: string): Promise<AdAccountInfo> {
    const r = await this.get<{ account_id?: string; id?: string; name?: string; currency?: string; timezone_name?: string; account_status?: number }>(token, `act_${encodeURIComponent(accountId)}`, { fields: 'account_id,name,currency,timezone_name,account_status' });
    const a = toAccount(r);
    if (!a) throw new MetaAdsError('Meta не віддала дані кабінету', 'meta_error');
    return a;
  }

  // Insights of the ad account (GET act_{id}/insights): level, period, daily slices or the whole period, fields and the attribution windows
  insights(token: string, accountId: string, params: Record<string, string>): Promise<InsightRow[]> {
    return this.all<InsightRow>(token, `act_${encodeURIComponent(accountId)}/insights`, { limit: '500', ...params });
  }
}

function toAccount(r: { account_id?: string; id?: string; name?: string; currency?: string; timezone_name?: string; account_status?: number }): AdAccountInfo | null {
  const id = r.account_id ?? r.id?.replace(/^act_/, '');
  if (!id || !r.currency || !r.timezone_name) return null;
  return { accountId: id, name: r.name ?? id, currency: r.currency, timezoneName: r.timezone_name, status: r.account_status ?? null };
}
