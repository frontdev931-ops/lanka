import { Injectable } from '@nestjs/common';

export interface MetaMessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean; quick_reply?: { payload?: string } };
}
export interface MetaWebhook {
  object?: string;
  entry?: { id: string; messaging?: MetaMessagingEvent[] }[];
}
export interface QuickReply {
  title: string;
  payload: string;
}

export interface MetaLead {
  id?: string;
  created_time?: string;
  field_data?: { name: string; values?: string[] }[];
  form_id?: string;
  platform?: string;
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  is_organic?: boolean;
}

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

// Thin wrapper over a Meta Graph messaging API. The token goes in a header, never in the address, so it cannot leak through errors or logs.
export abstract class GraphMessagingApi {
  protected abstract readonly host: string;

  protected async call<T>(token: string, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.host}/v21.0/${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new MetaApiError('Meta недоступна');
    }
    const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: number } }) | null;
    if (!res.ok || !json || json.error) throw new MetaApiError(json?.error?.message ?? `Помилка Meta (${res.status})`, json?.error?.code ?? res.status);
    return json;
  }

  profile(token: string, id: string) {
    return this.call<{ name?: string; username?: string }>(token, 'GET', `${encodeURIComponent(id)}?fields=name,username`);
  }

  sendMessage(token: string, recipientId: string, text: string, quickReplies: QuickReply[] = []) {
    const message: Record<string, unknown> = { text };
    if (quickReplies.length) message.quick_replies = quickReplies.slice(0, 13).map((q) => ({ content_type: 'text', title: q.title.slice(0, 20), payload: q.payload }));
    return this.call<unknown>(token, 'POST', 'me/messages', { recipient: { id: recipientId }, message });
  }
}

// Facebook Messenger: the page access token of the clinic's Facebook page
@Injectable()
export class FacebookApi extends GraphMessagingApi {
  protected readonly host = 'https://graph.facebook.com';

  // A lead from an advertising form of the page (Lead Ads); needs the leads_retrieval permission of the page token. The ad, ad set and campaign ids and
  // "organic" are fields of the lead itself; if Meta refuses them for this token (a field error), the lead is read again with the basic fields only.
  async getLead(token: string, leadgenId: string): Promise<MetaLead> {
    const path = (fields: string) => `${encodeURIComponent(leadgenId)}?fields=${fields}`;
    try {
      return await this.call<MetaLead>(token, 'GET', path('id,created_time,field_data,form_id,platform,ad_id,adset_id,campaign_id,is_organic'));
    } catch (e) {
      if (e instanceof MetaApiError && e.code === 100 && /field/i.test(e.message)) return this.call<MetaLead>(token, 'GET', path('field_data,form_id,platform'));
      throw e;
    }
  }

  // The page the token belongs to
  me(token: string) {
    return this.call<{ id?: string; name?: string }>(token, 'GET', 'me?fields=id,name');
  }
}
