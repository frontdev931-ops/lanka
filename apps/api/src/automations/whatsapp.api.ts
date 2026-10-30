import { Injectable } from '@nestjs/common';
import { MetaApiError, QuickReply } from './meta-graph.api';

export interface WaMessage {
  from: string;
  id: string;
  type: string;
  text?: { body?: string };
  interactive?: { button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
}
export interface WaWebhook {
  object?: string;
  entry?: { id: string; changes?: { field?: string; value?: { metadata?: { phone_number_id?: string }; contacts?: { wa_id?: string; profile?: { name?: string } }[]; messages?: WaMessage[] } }[] }[];
}

// WhatsApp Business Cloud API (Meta). The token goes in a header only.
@Injectable()
export class WhatsAppApi {
  private async call<T>(token: string, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`https://graph.facebook.com/v21.0/${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new MetaApiError('WhatsApp недоступний');
    }
    const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: number } }) | null;
    if (!res.ok || !json || json.error) throw new MetaApiError(json?.error?.message ?? `Помилка WhatsApp (${res.status})`, json?.error?.code ?? res.status);
    return json;
  }

  // The number the token can use
  phoneNumber(token: string, phoneNumberId: string) {
    return this.call<{ id?: string; display_phone_number?: string; verified_name?: string }>(token, 'GET', `${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`);
  }

  // A text, with up to three answer buttons (WhatsApp allows no more in one message)
  sendText(token: string, phoneNumberId: string, to: string, text: string, buttons: QuickReply[] = []) {
    const base = { messaging_product: 'whatsapp', to };
    const body = buttons.length
      ? { ...base, type: 'interactive', interactive: { type: 'button', body: { text: text.slice(0, 1024) }, action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.payload.slice(0, 256), title: b.title.slice(0, 20) } })) } } }
      : { ...base, type: 'text', text: { body: text.slice(0, 4096) } };
    return this.call<unknown>(token, 'POST', `${encodeURIComponent(phoneNumberId)}/messages`, body);
  }
}
