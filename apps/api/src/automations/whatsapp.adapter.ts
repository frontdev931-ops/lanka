import { Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { decrypt } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelAdapter, SendError, SlotOption, slotPayload } from './channels';
import { META_WINDOW_MS } from './meta.adapter';
import { MetaApiError } from './meta-graph.api';
import { WhatsAppApi } from './whatsapp.api';

// WhatsApp: free-form replies only within 24 hours of the person's last message. Writing first or later needs a template
// approved by WhatsApp: templates are not built yet (`templates` is the flag for it), so `canInitiate` stays false.
@Injectable()
export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = 'WHATSAPP';
  readonly caps = { canInitiate: false, replyWindowMs: META_WINDOW_MS, buttons: true, templates: true };

  constructor(
    private prisma: PrismaService,
    private api: WhatsAppApi,
  ) {}

  async send(clinicId: string, chatId: string, text: string, options: SlotOption[]) {
    const i = await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.WHATSAPP } } });
    const phoneNumberId = (i?.config as { phoneNumberId?: string } | undefined)?.phoneNumberId;
    if (!i?.apiKeyEnc || !phoneNumberId) throw new SendError('whatsapp_not_connected', false, 'not_connected');
    try {
      await this.api.sendText(decrypt(i.apiKeyEnc), phoneNumberId, chatId, text, options.map((o) => ({ title: o.label, payload: slotPayload(o) })));
    } catch (e) {
      if (e instanceof MetaApiError) throw new SendError(e.message, false);
      throw e;
    }
  }
}
