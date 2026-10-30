import { Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

// The real sender; replaced with a fake in tests so nothing leaves the machine
@Injectable()
export class PushSender {
  get configured() {
    return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  }

  async send(sub: { endpoint: string; p256dh: string; auth: string }, payload: PushPayload) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 3600 });
  }
}

@Injectable()
export class PushService {
  private readonly log = new Logger(PushService.name);

  constructor(
    private prisma: PrismaService,
    private sender: PushSender,
  ) {}

  get available() {
    return this.sender.configured;
  }

  publicKey() {
    return process.env.VAPID_PUBLIC_KEY ?? null;
  }

  async status(userId: string) {
    return { available: this.available, publicKey: this.publicKey(), devices: await this.prisma.pushSubscription.count({ where: { userId } }) };
  }

  async subscribe(clinicId: string, userId: string, sub: { endpoint: string; p256dh: string; auth: string }) {
    if ((await this.prisma.pushSubscription.count({ where: { userId } })) >= 10) await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint: { not: sub.endpoint } } });
    await this.prisma.pushSubscription.upsert({ where: { endpoint: sub.endpoint }, create: { clinicId, userId, ...sub }, update: { clinicId, userId, p256dh: sub.p256dh, auth: sub.auth } });
    return this.status(userId);
  }

  async unsubscribe(userId: string, endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
    return this.status(userId);
  }

  // A message to the staff who handle requests (owner, manager, administrator) or to one user. The text carries no patient data.
  async notify(clinicId: string, payload: PushPayload, onlyUserId?: string) {
    if (!this.available) return 0;
    const subs = await this.prisma.pushSubscription.findMany({
      where: { clinicId, ...(onlyUserId ? { userId: onlyUserId } : { userId: { in: (await this.prisma.membership.findMany({ where: { clinicId, role: { in: ['OWNER', 'MANAGER', 'ADMIN'] } }, select: { userId: true } })).map((m) => m.userId) } }) },
    });
    let sent = 0;
    for (const s of subs) {
      try {
        await this.sender.send(s, payload);
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        // 404/410: the browser dropped the subscription; remove it
        if (code === 404 || code === 410) await this.prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
        else this.log.warn(`Push: ${(e as Error).message}`);
      }
    }
    return sent;
  }
}
