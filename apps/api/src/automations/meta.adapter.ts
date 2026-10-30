import { Provider } from '@prisma/client';
import { decrypt } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelAdapter, ChannelCaps, SendError, SlotOption, slotPayload } from './channels';
import { GraphMessagingApi, MetaApiError } from './meta-graph.api';

// Meta lets a business answer only within 24 hours after the person's last message
export const META_WINDOW_MS = 24 * 3_600_000;

// Instagram and Facebook Messenger send the same way: the clinic's token, the person's id, text and quick replies
export abstract class MetaAdapter implements ChannelAdapter {
  abstract readonly channel: string;
  protected abstract readonly provider: Provider;
  readonly caps: ChannelCaps = { canInitiate: false, replyWindowMs: META_WINDOW_MS, buttons: true, templates: false };

  constructor(
    protected prisma: PrismaService,
    protected api: GraphMessagingApi,
  ) {}

  // The api for this connection: an account connected through Facebook Login uses a different address than an Instagram Login one
  protected apiFor(_config?: Record<string, unknown>): GraphMessagingApi {
    return this.api;
  }

  async send(clinicId: string, chatId: string, text: string, options: SlotOption[]) {
    const i = await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: this.provider } } });
    if (!i?.apiKeyEnc) throw new SendError(`${this.channel.toLowerCase()}_not_connected`, false, 'not_connected');
    try {
      await this.apiFor((i.config ?? {}) as Record<string, unknown>).sendMessage(decrypt(i.apiKeyEnc), chatId, text, options.map((o) => ({ title: o.label, payload: slotPayload(o) })));
    } catch (e) {
      if (e instanceof MetaApiError) throw new SendError(e.message, false);
      throw e;
    }
  }
}
