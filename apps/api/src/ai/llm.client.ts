import { Injectable, Logger } from '@nestjs/common';

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export class LlmError extends Error {}

// Тонкая обёртка над Messages API. Ключ один на весь сервис и берётся только из окружения сервера;
// в сообщения об ошибках он не попадает. Класс подменяется в тестах.
@Injectable()
export class LlmClient {
  private readonly log = new Logger('Llm');

  get configured() {
    return !!process.env.AI_API_KEY;
  }

  async complete(system: string, messages: { role: 'user' | 'assistant'; content: string }[], maxTokens = 400): Promise<LlmResult> {
    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.AI_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.AI_MODEL || 'claude-haiku-5-5', max_tokens: maxTokens, system, messages }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new LlmError('ИИ-сервис недоступен');
    }
    const json = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } } | null;
    if (!res.ok || !json?.content) {
      // The provider's error type and status go to the server log (never the key, the prompt or the answer): this is how a wrong key or model is found
      this.log.warn(`AI request failed: status ${res.status}, ${(json as { error?: { type?: string } } | null)?.error?.type ?? 'no error type'}`);
      throw new LlmError(`Ошибка ИИ-сервиса (${res.status})`);
    }
    return {
      text: json.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim(),
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    };
  }
}
