import { Injectable } from '@nestjs/common';
import { instagramAppId, instagramAppSecret } from './meta-chat.service';
import { GraphMessagingApi, MetaApiError, MetaMessagingEvent, MetaWebhook, QuickReply } from './meta-graph.api';

// Kept under the old names: Instagram uses the same webhook shape and send call as Messenger
export type IgMessagingEvent = MetaMessagingEvent;
export type IgWebhook = MetaWebhook;
export type IgQuickReply = QuickReply;
export class InstagramError extends MetaApiError {}

export type IgShortToken = { access_token: string; user_id?: string };
export type IgLongToken = { access_token: string; expires_in?: number };

// Instagram messaging API (Instagram login): the account token of the clinic's business account
@Injectable()
export class InstagramApi extends GraphMessagingApi {
  protected readonly host = 'https://graph.instagram.com';

  // The account the token belongs to
  me(token: string) {
    return this.call<{ user_id?: string; id?: string; username?: string }>(token, 'GET', 'me?fields=user_id,username');
  }

  // So Meta delivers Direct messages to our webhook for this account
  subscribeApps(token: string) {
    return this.call<{ success?: boolean }>(token, 'POST', 'me/subscribed_apps?subscribed_fields=messages');
  }

  // Short-lived token from the authorization code (Business Login). The secret stays in the body, not in the address.
  async exchangeCode(code: string, redirectUri: string): Promise<IgShortToken> {
    const json = await this.form('https://api.instagram.com/oauth/access_token', {
      client_id: instagramAppId(),
      client_secret: instagramAppSecret(),
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    });
    const row = Array.isArray(json.data) ? json.data[0] : json;
    if (!row?.access_token) throw new InstagramError('Instagram не видав токен', 400);
    return { access_token: String(row.access_token), user_id: row.user_id != null ? String(row.user_id) : undefined };
  }

  // 60-day token. Refresh before it expires; a system-user token is not used here.
  async exchangeLongLived(shortToken: string): Promise<IgLongToken> {
    const q = new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: instagramAppSecret(),
      access_token: shortToken,
    });
    const json = await this.read(`https://graph.instagram.com/access_token?${q}`);
    if (!json.access_token) throw new InstagramError('Instagram не видав довгий токен', 400);
    return { access_token: String(json.access_token), expires_in: Number(json.expires_in) || undefined };
  }

  async refreshLongLived(token: string): Promise<IgLongToken> {
    const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token });
    const json = await this.read(`https://graph.instagram.com/refresh_access_token?${q}`);
    if (!json.access_token) throw new InstagramError('Instagram не оновив токен', 400);
    return { access_token: String(json.access_token), expires_in: Number(json.expires_in) || undefined };
  }

  private async form(url: string, body: Record<string, string>) {
    return this.parse(
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(20_000),
      }),
    );
  }

  private async read(url: string) {
    return this.parse(fetch(url, { signal: AbortSignal.timeout(20_000) }));
  }

  private async parse(pending: Promise<Response>) {
    let res: Response;
    try {
      res = await pending;
    } catch {
      throw new InstagramError('Instagram недоступна');
    }
    const json = (await res.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
      user_id?: string | number;
      data?: { access_token?: string; user_id?: string | number }[];
      error?: { message?: string; code?: number };
    } | null;
    if (!res.ok || !json || json.error) throw new InstagramError(json?.error?.message ?? `Помилка Instagram (${res.status})`, json?.error?.code ?? res.status);
    return json;
  }
}
