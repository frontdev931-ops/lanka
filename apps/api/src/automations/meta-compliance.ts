import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, NotFoundException, Param, Post } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

// The secrets that may sign Meta requests: the Facebook app and (when it is a separate one) the Instagram app
export const metaSecrets = () => [process.env.META_APP_SECRET, process.env.META_INSTAGRAM_APP_SECRET].filter((s): s is string => !!s);

// "signed_request" = base64url(signature) + "." + base64url(JSON). The signature is HMAC-SHA256 of the second part with the app secret.
export function parseSignedRequest(signed: string | undefined): { user_id?: string } | null {
  const [sig, payload] = (signed ?? '').split('.');
  if (!sig || !payload) return null;
  const got = Buffer.from(sig, 'base64url');
  for (const secret of metaSecrets()) {
    const want = createHmac('sha256', secret).update(payload).digest();
    if (got.length === want.length && timingSafeEqual(got, want)) {
      try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { algorithm?: string; user_id?: string | number };
        if (data.algorithm && data.algorithm.toUpperCase() !== 'HMAC-SHA256') return null;
        return { user_id: data.user_id !== undefined ? String(data.user_id) : undefined };
      } catch {
        return null;
      }
    }
  }
  return null;
}

const META_CHANNELS = ['INSTAGRAM', 'MESSENGER', 'WHATSAPP'];
const META_PROVIDERS = [Provider.INSTAGRAM, Provider.MESSENGER, Provider.WHATSAPP];

@Injectable()
export class MetaComplianceService {
  constructor(private prisma: PrismaService) {}

  // Takes the connections made by this person away (their access tokens are deleted); returns how many
  private async disconnect(userId: string): Promise<number> {
    const rows = await this.prisma.integration.findMany({ where: { provider: { in: META_PROVIDERS }, config: { path: ['ownId'], equals: userId } }, select: { id: true, clinicId: true, provider: true } });
    for (const r of rows) {
      await this.prisma.integration.delete({ where: { id: r.id } });
      await this.prisma.auditLog.create({ data: { clinicId: r.clinicId, action: `${r.provider.toLowerCase()}.disconnected_by_meta`, details: { reason: 'deauthorized' } } });
    }
    return rows.length;
  }

  // The person removed the app in Facebook or Instagram: the access is gone, so our copy of it must go too
  async deauthorize(signed: string | undefined) {
    const p = parseSignedRequest(signed);
    if (!p?.user_id) throw new BadRequestException('bad_signature');
    const disconnected = await this.disconnect(p.user_id);
    await this.prisma.dataDeletionRequest.create({ data: { code: `DA-${randomBytes(6).toString('hex')}`, externalUserId: p.user_id, status: 'DEAUTHORIZED', summary: { disconnected } } });
    return { ok: true };
  }

  // The person asked Meta to delete their data held by this app. What is identified by this id is deleted: the connected accounts
  // with their tokens, the conversations with this id and the links of chats to patient cards. A clinic's own records about a patient
  // (visits, treatment) are not Meta data and stay with the clinic as its processor.
  async requestDeletion(signed: string | undefined) {
    const p = parseSignedRequest(signed);
    if (!p?.user_id) throw new BadRequestException('bad_signature');
    const userId = p.user_id;
    const disconnected = await this.disconnect(userId);
    const messages = await this.prisma.chatMessage.deleteMany({ where: { channel: { in: META_CHANNELS }, chatId: userId } });
    const links = await this.prisma.patientChannel.deleteMany({ where: { channel: { in: META_CHANNELS }, externalId: userId } });
    const requests = await this.prisma.bookingRequest.deleteMany({ where: { channel: { in: META_CHANNELS }, chatId: userId } });
    const code = `DD-${randomBytes(8).toString('hex')}`;
    await this.prisma.dataDeletionRequest.create({ data: { code, externalUserId: userId, status: 'DELETED', summary: { disconnected, messages: messages.count, chatLinks: links.count, requests: requests.count } } });
    const origin = (process.env.WEB_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
    return { url: `${origin}/data-deletion?code=${code}`, confirmation_code: code };
  }

  async status(code: string) {
    const r = await this.prisma.dataDeletionRequest.findUnique({ where: { code } });
    if (!r) throw new NotFoundException();
    // the person's id is not shown: only that the request was handled and what kind of data it touched
    return { status: r.status, createdAt: r.createdAt, summary: r.summary };
  }
}

// Public: called by Meta, no sign-in. The signature is the proof. A body of the form application/x-www-form-urlencoded.
@Controller('meta')
export class MetaComplianceController {
  constructor(private svc: MetaComplianceService) {}

  @Post('deauthorize')
  @HttpCode(200)
  deauthorize(@Body() body: { signed_request?: string }) {
    return this.svc.deauthorize(body?.signed_request);
  }

  @Post('data-deletion')
  @HttpCode(200)
  dataDeletion(@Body() body: { signed_request?: string }) {
    return this.svc.requestDeletion(body?.signed_request);
  }

  @Get('data-deletion/status/:code')
  status(@Param('code') code: string) {
    return this.svc.status(code);
  }
}
