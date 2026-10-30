import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelAdapter, SendError, SlotOption } from './channels';
import { FacebookAdapter } from './facebook.adapter';
import { InstagramAdapter } from './instagram.adapter';
import { ViberAdapter } from './viber.adapter';
import { WebAdapter } from './web.adapter';
import { WhatsAppAdapter } from './whatsapp.adapter';
import { TelegramAdapter } from './telegram.adapter';

export { SendError } from './channels';
export type { SlotOption } from './channels';
export { IG_WINDOW_MS } from './instagram.adapter';

// One way to write to a person in a chat, whatever the channel. Callers decide whether sending is allowed (master switch, opt-out);
// this class knows which adapter delivers and enforces what the channel forbids (the reply window). A new channel is a new adapter here.
@Injectable()
export class MessengerService {
  private adapters = new Map<string, ChannelAdapter>();

  constructor(
    private prisma: PrismaService,
    telegram: TelegramAdapter,
    instagram: InstagramAdapter,
    facebook: FacebookAdapter,
    whatsapp: WhatsAppAdapter,
    viber: ViberAdapter,
    web: WebAdapter,
  ) {
    for (const a of [telegram, instagram, facebook, whatsapp, viber, web]) this.adapters.set(a.channel, a);
  }

  caps(channel: string) {
    return this.adapters.get(channel)?.caps ?? null;
  }

  async send(clinicId: string, channel: string, chatId: string, text: string, options: SlotOption[] = []): Promise<void> {
    const adapter = this.adapters.get(channel);
    if (!adapter) throw new SendError('bad_channel');
    // A demo clinic only pretends to send: nothing leaves the server
    if ((await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { isDemo: true } }))?.isDemo) return;
    if (!(await this.windowOpen(clinicId, channel, chatId))) throw new SendError('window_closed', true, 'window_closed');
    await adapter.send(clinicId, chatId, text, adapter.caps.buttons ? options : []);
  }

  // True when we may answer now: the channel has no window, or the person wrote to us inside it
  async windowOpen(clinicId: string, channel: string, chatId: string): Promise<boolean> {
    const ms = this.adapters.get(channel)?.caps.replyWindowMs;
    if (!ms) return true;
    const last = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    return !!last && Date.now() - last.createdAt.getTime() < ms;
  }
}
