import { Injectable, Logger } from '@nestjs/common';

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  // Why the model stopped ("end_turn", "max_tokens", ...) and how many of the output tokens went to thinking (billed as output). For diagnosis and
  // evaluation only: the working bot does not read them. A "max_tokens" stop means the answer (and with thinking on, possibly the thinking) hit the limit.
  stopReason?: string | null;
  thinkingTokens?: number | null;
}

export class LlmError extends Error {
  // The provider's status and error message (no key, no prompt): for the local evaluation; never logged or sent on
  detail?: string;
}

// A thin wrapper over the Messages API. There is one key for the whole service and it is taken only from the server environment;
// it never gets into error messages. The class is replaced in tests.
@Injectable()
export class LlmClient {
  private readonly log = new Logger('Llm');

  get configured() {
    return !!process.env.AI_API_KEY;
  }

  async complete(system: string, messages: { role: 'user' | 'assistant'; content: string }[], maxTokens = 400, opts: { schema?: Record<string, unknown> } = {}): Promise<LlmResult> {
    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.AI_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.AI_MODEL || 'claude-haiku-5-5', max_tokens: maxTokens, system, messages, ...(opts.schema ? { output_config: { format: { type: 'json_schema', schema: opts.schema } } } : {}) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new LlmError('ИИ-сервис недоступен');
    }
    const json = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[]; stop_reason?: string | null; usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { thinking_tokens?: number } }; error?: { message?: string } } | null;
    if (!res.ok || !json?.content) {
      // The provider's error type and status go to the server log (never the key, the prompt or the answer): this is how a wrong key or model is found
      this.log.warn(`AI request failed: status ${res.status}, ${(json as { error?: { type?: string } } | null)?.error?.type ?? 'no error type'}`);
      const err = new LlmError(`Ошибка ИИ-сервиса (${res.status})`);
      const e = (json as { error?: { type?: string; message?: string } } | null)?.error;
      err.detail = `${res.status} ${e?.type ?? ''}: ${(e?.message ?? '').slice(0, 300)}`.trim();
      throw err;
    }
    return {
      text: json.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim(),
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      stopReason: json.stop_reason ?? null,
      thinkingTokens: json.usage?.output_tokens_details?.thinking_tokens ?? null,
    };
  }
}
