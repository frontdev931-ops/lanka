import { BadRequestException, Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { encrypt } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hasFeature } from '../service/plans';
import { InboundService } from './inbound.service';
import { IntakeService } from './intake.service';
import { ViberProvider } from './viber.provider';

// Viber of the clinic. The partner is not chosen yet, so this works against the ViberProvider interface only (tests use a fake).
// `receive` is what the partner's webhook handler will call with an already-normalised message.
@Injectable()
export class ViberService {
  constructor(
    private prisma: PrismaService,
    private provider: ViberProvider,
    private inbound: InboundService,
    private intake: IntakeService,
  ) {
    this.inbound.register('VIBER', async (clinicId, payload) => {
      const m = payload as { from: string; id: string; text: string; payload?: string; name?: string; phone?: string };
      await this.intake.handle(clinicId, { channel: 'VIBER', chatId: m.from, mid: m.id, text: m.text, payload: m.payload, name: m.name });
    });
  }

  private where(clinicId: string) {
    return { clinicId_provider: { clinicId, provider: Provider.VIBER } };
  }

  async status(clinicId: string) {
    const i = await this.prisma.integration.findUnique({ where: this.where(clinicId) });
    const linked = await this.prisma.patientChannel.count({ where: { clinicId, channel: 'VIBER', optedOutAt: null } });
    return { connected: !!i?.apiKeyEnc, username: ((i?.config ?? {}) as { senderName?: string }).senderName ?? null, linkedPatients: linked, serverReady: this.provider.available };
  }

  async connect(clinicId: string, credentials: Record<string, string>) {
    const plan = (await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true } })).plan;
    if (!hasFeature(plan, 'multi_channel')) throw new BadRequestException('plan_feature');
    if (!this.provider.available) throw new BadRequestException('viber_provider_not_chosen');
    let senderName: string;
    try {
      senderName = (await this.provider.verify(credentials)).senderName;
    } catch {
      throw new BadRequestException('bad_viber_credentials');
    }
    await this.prisma.integration.upsert({ where: this.where(clinicId), create: { clinicId, provider: Provider.VIBER, apiKeyEnc: encrypt(JSON.stringify(credentials)), config: { senderName } }, update: { apiKeyEnc: encrypt(JSON.stringify(credentials)), config: { senderName } } });
    return this.status(clinicId);
  }

  async disconnect(clinicId: string) {
    await this.prisma.integration.deleteMany({ where: { clinicId, provider: Provider.VIBER } });
    return { connected: false };
  }

  // A message from a person, normalised by the partner's webhook handler
  receive(clinicId: string, m: { from: string; id: string; text: string; payload?: string; name?: string }) {
    return this.inbound.receive(clinicId, 'VIBER', `VIBER:${m.id}`, m);
  }
}
