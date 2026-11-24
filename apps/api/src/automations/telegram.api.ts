import { Injectable } from '@nestjs/common';

export interface TgUpdate {
  update_id: number;
  callback_query?: { id: string; from: { id: number; username?: string; first_name?: string; last_name?: string; language_code?: string }; message?: { chat: { id: number } }; data?: string };
  message?: {
    chat: { id: number; type?: string; title?: string };
    from?: { id: number; username?: string; first_name?: string; last_name?: string; language_code?: string };
    text?: string;
    contact?: { phone_number: string; user_id?: number };
  };
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

// A thin wrapper over the Bot API. The token is part of the address, so it never gets into error messages or the log.
@Injectable()
export class TelegramApi {
  private async call<T>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new TelegramError('Telegram недоступний');
    }
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number } | null;
    if (!json?.ok) throw new TelegramError(json?.description ?? `Помилка Telegram (${res.status})`, json?.error_code ?? res.status);
    return json.result as T;
  }

  getMe(token: string) {
    return this.call<{ id: number; username: string }>(token, 'getMe');
  }

  sendMessage(token: string, chatId: string | number, text: string, extra: Record<string, unknown> = {}) {
    return this.call<unknown>(token, 'sendMessage', { chat_id: chatId, text, ...extra });
  }

  answerCallbackQuery(token: string, id: string) {
    return this.call<boolean>(token, 'answerCallbackQuery', { callback_query_id: id });
  }

  getUpdates(token: string, offset?: number) {
    return this.call<TgUpdate[]>(token, 'getUpdates', { offset, timeout: 0, allowed_updates: ['message', 'callback_query'] });
  }

  setWebhook(token: string, url: string, secret: string) {
    return this.call<boolean>(token, 'setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'] });
  }

  // The bot's current delivery state: a webhook address (another service may be using the bot) and how many updates wait undelivered
  getWebhookInfo(token: string) {
    return this.call<{ url?: string; pending_update_count?: number }>(token, 'getWebhookInfo');
  }

  deleteWebhook(token: string) {
    return this.call<boolean>(token, 'deleteWebhook');
  }
}
