import { Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { decrypt } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelAdapter, SendError, SlotOption, slotPayload } from './channels';
import { TelegramApi, TelegramError } from './telegram.api';

@Injectable()
export class TelegramAdapter implements ChannelAdapter {
  readonly channel = 'TELEGRAM';
  readonly caps = { canInitiate: true, replyWindowMs: null, buttons: true, templates: false };

  constructor(
    private prisma: PrismaService,
    private api: TelegramApi,
  ) {}

  async send(clinicId: string, chatId: string, text: string, options: SlotOption[]) {
    const i = await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.TELEGRAM } } });
    if (!i?.apiKeyEnc) throw new SendError('bot_not_connected', false, 'not_connected');
    try {
      await this.api.sendMessage(decrypt(i.apiKeyEnc), chatId, text, options.length ? { reply_markup: { inline_keyboard: options.map((o) => [{ text: o.label, callback_data: slotPayload(o) }]) } } : undefined);
    } catch (e) {
      if (e instanceof TelegramError) throw new SendError(e.message, e.code === 403);
      throw e;
    }
  }
}
