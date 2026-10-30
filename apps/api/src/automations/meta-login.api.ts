import { Injectable } from '@nestjs/common';
import { MetaApiError } from './meta-graph.api';

export const graphVersion = () => process.env.META_GRAPH_VERSION || 'v21.0';

export interface TokenInfo {
  isValid: boolean;
  // 'USER', 'PAGE' or 'SYSTEM_USER' (as Meta names the kind of token)
  type: string;
  // milliseconds since the epoch; null when the token does not expire
  expiresAt: number | null;
  scopes: string[];
  // The pages the person picked in the dialog (granular permissions); empty when the dialog did not limit them
  pageIds: string[];
}
export interface PageInfo {
  id: string;
  name: string;
  accessToken?: string;
  igId: string | null;
  igUsername: string | null;
}

// Facebook Login for Business over the Graph API. Secrets go in the body or a header, never in the address.
@Injectable()
export class MetaLoginApi {
  private async call<T>(token: string | null, method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`https://graph.facebook.com/${graphVersion()}/${path}`, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new MetaApiError('Meta недоступна');
    }
    const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: number } }) | null;
    if (!res.ok || !json || json.error) throw new MetaApiError(json?.error?.message ?? `Помилка Meta (${res.status})`, json?.error?.code ?? res.status);
    return json;
  }

  // The authorization code becomes a token. For a configuration of the "System-user access token" kind it does not expire.
  async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; expiresIn: number | null }> {
    const r = await this.call<{ access_token?: string; expires_in?: number }>(null, 'POST', 'oauth/access_token', {
      client_id: process.env.META_APP_ID ?? '',
      client_secret: process.env.META_APP_SECRET ?? '',
      redirect_uri: redirectUri,
      code,
    });
    if (!r.access_token) throw new MetaApiError('Meta не видала токен', 400);
    return { accessToken: r.access_token, expiresIn: r.expires_in ? Number(r.expires_in) : null };
  }

  // What a token is: its kind, whether it is still valid and when it ends (0 means never)
  async debugToken(token: string): Promise<TokenInfo> {
    const appToken = `${process.env.META_APP_ID ?? ''}|${process.env.META_APP_SECRET ?? ''}`;
    const r = await this.call<{ data?: { is_valid?: boolean; type?: string; expires_at?: number; scopes?: string[]; granular_scopes?: { scope: string; target_ids?: string[] }[] } }>(appToken, 'GET', `debug_token?input_token=${encodeURIComponent(token)}`);
    const d = r.data ?? {};
    const pageScopes = ['pages_messaging', 'pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'leads_retrieval'];
    const pageIds = [...new Set((d.granular_scopes ?? []).filter((g) => pageScopes.includes(g.scope)).flatMap((g) => g.target_ids ?? []))];
    return { isValid: !!d.is_valid, type: d.type ?? 'UNKNOWN', expiresAt: d.expires_at ? d.expires_at * 1000 : null, scopes: d.scopes ?? [], pageIds };
  }

  // The pages the token can reach, each with the Instagram account attached to it
  async accounts(token: string): Promise<PageInfo[]> {
    const r = await this.call<{ data?: { id: string; name?: string; instagram_business_account?: { id: string; username?: string } }[] }>(token, 'GET', 'me/accounts?fields=id,name,instagram_business_account{id,username}&limit=100');
    return (r.data ?? []).map((p) => ({ id: p.id, name: p.name ?? p.id, igId: p.instagram_business_account?.id ?? null, igUsername: p.instagram_business_account?.username ?? null }));
  }

  // The access token of one page (derived from the person's token)
  async pageToken(token: string, pageId: string): Promise<string> {
    const r = await this.call<{ access_token?: string }>(token, 'GET', `${encodeURIComponent(pageId)}?fields=access_token`);
    if (!r.access_token) throw new MetaApiError('Meta не видала токен сторінки', 400);
    return r.access_token;
  }

  // So that Meta delivers the page's messages (and Instagram messages of the account attached to it) to our webhook
  subscribe(pageToken: string, pageId: string, fields: string) {
    return this.call<{ success?: boolean }>(pageToken, 'POST', `${encodeURIComponent(pageId)}/subscribed_apps`, { subscribed_fields: fields });
  }
}
