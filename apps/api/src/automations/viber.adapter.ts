import { Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelAdapter, SendError, SlotOption, slotPayload } from './channels';
import { ViberProvider, viberCredentials } from './viber.provider';

// Viber Business: a conversation opened by the person; limits of the partner are not known yet, so no window is assumed
@Injectable()
export class ViberAdapter implements ChannelAdapter {
  readonly channel = 'VIBER';
  readonly caps = { canInitiate: false, replyWindowMs: null, buttons: true, templates: false };

  constructor(
    private prisma: PrismaService,
    private provider: ViberProvider,
  ) {}

  async send(clinicId: string, chatId: string, text: string, options: SlotOption[]) {
    const i = await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.VIBER } } });
    const creds = i ? viberCredentials(i) : null;
    if (!creds) throw new SendError('viber_not_connected', false, 'not_connected');
    try {
      await this.provider.send(creds, chatId, text, options.map((o) => ({ title: o.label, payload: slotPayload(o) })));
    } catch (e) {
      throw new SendError((e as Error).message, false);
    }
  }
}
