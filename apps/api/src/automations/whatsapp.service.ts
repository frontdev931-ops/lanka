import { BadRequestException, Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { decrypt, encrypt } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hasFeature } from '../service/plans';
import { InboundService } from './inbound.service';
import { IntakeService } from './intake.service';
import { metaServerReady, metaSignatureOk, metaVerify } from './meta-chat.service';
import { WaWebhook, WhatsAppApi } from './whatsapp.api';

// WhatsApp of the clinic: one business number (Cloud API). The sender number of a message is vouched for by WhatsApp itself,
// so a card with exactly that phone is linked to the chat automatically.
@Injectable()
export class WhatsAppService {
  constructor(
    private prisma: PrismaService,
    private api: WhatsAppApi,
    private inbound: InboundService,
    private intake: IntakeService,
  ) {
    this.inbound.register('WHATSAPP', async (clinicId, payload) => {
      const { phoneNumberId, msg, name } = payload as { phoneNumberId: string; msg: { from: string; id: string; text: string; payload?: string }; name?: string };
      const i = await this.prisma.integration.findUnique({ where: this.where(clinicId) });
      if (!i?.apiKeyEnc || (i.config as { phoneNumberId?: string }).phoneNumberId !== phoneNumberId) return;
      await this.intake.handle(clinicId, { channel: 'WHATSAPP', chatId: msg.from, mid: msg.id, text: msg.text, payload: msg.payload, name, verifiedPhone: msg.from });
    });
  }

  private where(clinicId: string) {
    return { clinicId_provider: { clinicId, provider: Provider.WHATSAPP } };
  }

  async status(clinicId: string) {
    const i = await this.prisma.integration.findUnique({ where: this.where(clinicId) });
    const cfg = (i?.config ?? {}) as { displayPhone?: string; verifiedName?: string };
    const linked = await this.prisma.patientChannel.count({ where: { clinicId, channel: 'WHATSAPP', optedOutAt: null } });
    return { connected: !!i?.apiKeyEnc, username: cfg.displayPhone ?? null, linkedPatients: linked, serverReady: metaServerReady() };
  }

  async connect(clinicId: string, token: string, phoneNumberId: string) {
    const plan = (await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true } })).plan;
    if (!hasFeature(plan, 'multi_channel')) throw new BadRequestException('plan_feature');
    if (!/^\d{5,30}$/.test(phoneNumberId)) throw new BadRequestException('bad_whatsapp_number_id');
    let info: { display_phone_number?: string; verified_name?: string };
    try {
      info = await this.api.phoneNumber(token, phoneNumberId);
    } catch {
      throw new BadRequestException('bad_whatsapp_token');
    }
    const taken = await this.prisma.integration.findFirst({ where: { provider: Provider.WHATSAPP, clinicId: { not: clinicId }, config: { path: ['phoneNumberId'], equals: phoneNumberId } }, select: { id: true } });
    if (taken) throw new BadRequestException('channel_account_taken');
    const config = { phoneNumberId, displayPhone: info.display_phone_number ?? null, verifiedName: info.verified_name ?? null };
    await this.prisma.integration.upsert({ where: this.where(clinicId), create: { clinicId, provider: Provider.WHATSAPP, apiKeyEnc: encrypt(token), config }, update: { apiKeyEnc: encrypt(token), config } });
    return this.status(clinicId);
  }

  async disconnect(clinicId: string) {
    await this.prisma.integration.deleteMany({ where: { clinicId, provider: Provider.WHATSAPP } });
    return { connected: false };
  }

  verify(mode?: string, token?: string, challenge?: string) {
    return metaVerify(mode, token, challenge);
  }

  async handleWebhook(raw: Buffer | undefined, signature: string | undefined, body: WaWebhook) {
    if (!metaSignatureOk(raw, signature) || body.object !== 'whatsapp_business_account') return;
    for (const entry of body.entry ?? []) {
      for (const ch of entry.changes ?? []) {
        const v = ch.value;
        const phoneNumberId = v?.metadata?.phone_number_id;
        if (ch.field !== 'messages' || !phoneNumberId || !v?.messages?.length) continue;
        const i = await this.prisma.integration.findFirst({ where: { provider: Provider.WHATSAPP, config: { path: ['phoneNumberId'], equals: phoneNumberId } } });
        if (!i?.apiKeyEnc) continue;
        for (const m of v.messages) {
          const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
          const text = m.type === 'text' ? (m.text?.body ?? '') : (reply?.title ?? '');
          const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name;
          await this.inbound.receive(i.clinicId, 'WHATSAPP', `WHATSAPP:${m.id}`, { phoneNumberId, name, msg: { from: m.from, id: m.id, text, payload: reply?.id } });
        }
      }
    }
  }

  tokenFor(i: { apiKeyEnc: string | null }) {
    return i.apiKeyEnc ? decrypt(i.apiKeyEnc) : null;
  }
}
