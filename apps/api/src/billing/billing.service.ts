import { BadRequestException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { MailService } from '../auth/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AI_PACK, GRACE_DAYS, PLANS, SELLABLE_PLANS, SETUP_FEE_USD, effectiveLimits, periodStart } from '../service/plans';
import { FxRates } from './fx.service';
import { buildCheckout, decodeCallback, signatureValid } from './liqpay';

const DAY = 86_400_000;
const addMonth = (d: Date) => {
  const r = new Date(d);
  r.setUTCMonth(r.getUTCMonth() + 1);
  return r;
};

@Injectable()
export class BillingService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(BillingService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private fx: FxRates,
    private mail: MailService,
  ) {}

  // Statuses and reminders are checked every hour (not in tests: AUTOMATIONS_TICK_SECONDS=0)
  onApplicationBootstrap() {
    if (!Number(process.env.AUTOMATIONS_TICK_SECONDS ?? 60)) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.warn(`Billing: ${(e as Error).message}`)), 3_600_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private keys() {
    const publicKey = process.env.LIQPAY_PUBLIC_KEY;
    const privateKey = process.env.LIQPAY_PRIVATE_KEY;
    return publicKey && privateKey ? { publicKey, privateKey } : null;
  }

  private async setupMinor(clinicId: string): Promise<number> {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { setupPaidAt: true } });
    if (c.setupPaidAt) return 0;
    try {
      return Math.round(SETUP_FEE_USD * (await this.fx.usdUah()) * 100);
    } catch {
      throw new BadRequestException('fx_unavailable');
    }
  }

  async overview(clinicId: string, now = new Date()) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true, billingStatus: true, paidUntil: true, periodStartsAt: true, setupPaidAt: true, aiMonthlyLimit: true, aiPurchased: true, aiPackCapPerMonth: true, limitOverrides: true } });
    const since = periodStart(c, now);
    const [used, packs, payments] = await Promise.all([
      this.prisma.aiUsage.count({ where: { clinicId, ok: true, billable: true, createdAt: { gte: since } } }),
      this.prisma.billingPayment.count({ where: { clinicId, kind: 'AI_PACK', status: 'PAID', paidAt: { gte: since } } }),
      this.prisma.billingPayment.findMany({ where: { clinicId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, kind: true, plan: true, amountMinor: true, setupMinor: true, packReplies: true, status: true, createdAt: true, paidAt: true } }),
    ]);
    let setupUah: number | null = null;
    if (!c.setupPaidAt) setupUah = await this.setupMinor(clinicId).then((m) => Math.round(m / 100)).catch(() => null);
    return {
      configured: !!this.keys(),
      plan: c.plan,
      status: c.billingStatus,
      paidUntil: c.paidUntil,
      graceUntil: c.paidUntil ? new Date(c.paidUntil.getTime() + GRACE_DAYS * DAY) : null,
      plans: SELLABLE_PLANS.map((k) => ({ key: k, priceUah: PLANS[k].priceUah, limits: PLANS[k].limits, features: PLANS[k].features })),
      setupPaid: !!c.setupPaidAt,
      setupUah,
      pack: { ...AI_PACK, bought: packs, cap: c.aiPackCapPerMonth },
      ai: { included: c.aiMonthlyLimit, used, purchased: c.aiPurchased, remaining: Math.max(0, c.aiMonthlyLimit - used) + c.aiPurchased },
      limits: effectiveLimits(c.plan, c.limitOverrides),
      payments,
    };
  }

  private orderId(clinicId: string) {
    return `lanka-${clinicId.slice(-8)}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  }

  async checkout(clinicId: string, plan: string) {
    const keys = this.keys();
    if (!keys) throw new BadRequestException('billing_not_configured');
    if (!SELLABLE_PLANS.includes(plan)) throw new BadRequestException('bad_plan');
    const setupMinor = await this.setupMinor(clinicId);
    const amountMinor = PLANS[plan].priceUah * 100 + setupMinor;
    const orderId = this.orderId(clinicId);
    await this.prisma.billingPayment.create({ data: { clinicId, orderId, kind: 'SUBSCRIPTION', plan, amountMinor, setupMinor } });
    return this.form(orderId, amountMinor, `LANKA ${PLANS[plan].label}${setupMinor ? ' + підключення' : ''}`, keys);
  }

  async buyPack(clinicId: string, now = new Date()) {
    const keys = this.keys();
    if (!keys) throw new BadRequestException('billing_not_configured');
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { billingStatus: true, periodStartsAt: true, aiPackCapPerMonth: true } });
    if (c.billingStatus !== 'ACTIVE' && c.billingStatus !== 'PAST_DUE') throw new BadRequestException('payment_required');
    const bought = await this.prisma.billingPayment.count({ where: { clinicId, kind: 'AI_PACK', status: 'PAID', paidAt: { gte: periodStart(c, now) } } });
    if (bought >= c.aiPackCapPerMonth) throw new BadRequestException('pack_cap');
    const orderId = this.orderId(clinicId);
    const amountMinor = AI_PACK.priceUah * 100;
    await this.prisma.billingPayment.create({ data: { clinicId, orderId, kind: 'AI_PACK', amountMinor, packReplies: AI_PACK.replies } });
    return this.form(orderId, amountMinor, `LANKA: ${AI_PACK.replies} відповідей ШІ`, keys);
  }

  private form(orderId: string, amountMinor: number, description: string, keys: { publicKey: string; privateKey: string }) {
    const origin = (process.env.WEB_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
    return buildCheckout({ amount: amountMinor / 100, description, order_id: orderId, result_url: `${origin}/billing`, server_url: `${origin}/backend/billing/liqpay/callback`, language: 'uk' }, keys);
  }

  // LiqPay calls this after a payment. Safe to repeat: an order is applied once.
  async callback(data: string, signature: string, now = new Date()) {
    const keys = this.keys();
    if (!keys || !data || !signature || !signatureValid(data, signature, keys.privateKey)) throw new BadRequestException('bad_signature');
    const cb = decodeCallback(data);
    if (!cb?.order_id) return;
    const order = await this.prisma.billingPayment.findUnique({ where: { orderId: cb.order_id } });
    if (!order) return;
    const ok = cb.status === 'success' || (cb.status === 'sandbox' && process.env.NODE_ENV !== 'production');
    if (!ok) {
      if (['failure', 'error', 'reversed'].includes(cb.status ?? '')) await this.prisma.billingPayment.updateMany({ where: { id: order.id, status: 'PENDING' }, data: { status: 'FAILED' } });
      return; // wait_accept and other in-between statuses change nothing
    }
    // What was paid must match what we asked for
    if (cb.currency !== 'UAH' || Math.round(Number(cb.amount) * 100) !== order.amountMinor) {
      this.log.error(`LiqPay order ${order.orderId}: amount or currency mismatch`);
      return;
    }
    const applied = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.billingPayment.updateMany({ where: { id: order.id, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'PAID', paidAt: now, providerRef: cb.payment_id !== undefined ? String(cb.payment_id) : null } });
      if (!claim.count) return false;
      if (order.kind === 'AI_PACK') {
        await tx.clinic.update({ where: { id: order.clinicId }, data: { aiPurchased: { increment: order.packReplies } } });
      } else {
        const c = await tx.clinic.findUniqueOrThrow({ where: { id: order.clinicId }, select: { paidUntil: true, limitOverrides: true, setupPaidAt: true } });
        const plan = order.plan ?? 'START';
        // paying before the month ends extends it
        const base = c.paidUntil && c.paidUntil > now ? c.paidUntil : now;
        await tx.clinic.update({
          where: { id: order.clinicId },
          data: { plan, billingStatus: 'ACTIVE', paidUntil: addMonth(base), periodStartsAt: now, aiMonthlyLimit: effectiveLimits(plan, c.limitOverrides).aiRepliesPerMonth, ...(order.setupMinor && !c.setupPaidAt ? { setupPaidAt: now } : {}) },
        });
      }
      await tx.auditLog.create({ data: { clinicId: order.clinicId, action: 'billing.paid', details: { kind: order.kind, plan: order.plan, amountMinor: order.amountMinor } } });
      return true;
    });
    if (applied) await this.notify(order.clinicId, 'Оплату отримано', `Дякуємо! Оплату ${(order.amountMinor / 100).toFixed(2)} грн отримано.`);
  }

  private async ownerEmail(clinicId: string): Promise<string | null> {
    const m = await this.prisma.membership.findFirst({ where: { clinicId, role: 'OWNER' }, select: { user: { select: { email: true } } } });
    return m?.user.email ?? null;
  }

  private async notify(clinicId: string, subject: string, text: string) {
    const to = await this.ownerEmail(clinicId);
    if (to) await this.mail.send({ to, subject: `LANKA: ${subject}`, text });
  }

  // Moves clinics through ACTIVE -> PAST_DUE -> LAPSED and sends one reminder per step
  async tick(now = new Date()) {
    const soon = new Date(now.getTime() + 5 * DAY);
    const clinics = await this.prisma.clinic.findMany({ where: { billingStatus: { in: ['ACTIVE', 'PAST_DUE'] }, paidUntil: { not: null, lt: soon } }, select: { id: true, billingStatus: true, paidUntil: true } });
    for (const c of clinics) {
      const until = c.paidUntil!;
      const graceEnd = new Date(until.getTime() + GRACE_DAYS * DAY);
      const step = now >= graceEnd ? 'LAPSED' : now >= until ? 'PAST_DUE' : 'SOON';
      if (step !== 'SOON' && c.billingStatus !== step) await this.prisma.clinic.update({ where: { id: c.id }, data: { billingStatus: step } });
      const action = `billing.notice.${step.toLowerCase()}`;
      const sent = await this.prisma.auditLog.findFirst({ where: { clinicId: c.id, action, createdAt: { gt: new Date(until.getTime() - 40 * DAY) } }, select: { id: true } });
      if (sent) continue;
      await this.prisma.auditLog.create({ data: { clinicId: c.id, action, details: { paidUntil: until.toISOString() } } });
      const day = (d: Date) => d.toISOString().slice(0, 10);
      if (step === 'SOON') await this.notify(c.id, 'Скоро закінчується оплачений місяць', `Оплачений період діє до ${day(until)}. Продовжити можна на сторінці «Оплата» в кабінеті.`);
      else if (step === 'PAST_DUE') await this.notify(c.id, 'Оплачений місяць закінчився', `Кабінет працює ще ${GRACE_DAYS} днів (до ${day(graceEnd)}), потім доступ до даних закриється. Дані збережуться.`);
      else await this.notify(c.id, 'Доступ до даних закрито', 'Оплата не надійшла. Дані збережено: після оплати доступ відновиться одразу.');
    }
  }
}
