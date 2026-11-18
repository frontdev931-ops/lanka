import { BadRequestException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { MailService } from '../auth/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AI_PACK, BRANCH_SETUP_MIN_UAH, GRACE_DAYS, PLANS, SELLABLE_PLANS, SETUP_FEE_UAH, effectiveLimits, networkMonthlyUah, periodStart } from '../service/plans';
import { buildCheckout, decodeCallback, liqpaySandbox, signatureValid } from './liqpay';

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
    private mail: MailService,
  ) {}

  // Statuses and reminders are checked every hour (not in tests: AUTOMATIONS_TICK_SECONDS=0)
  onApplicationBootstrap() {
    if (!Number(process.env.AUTOMATIONS_TICK_SECONDS ?? 60)) return;
    this.timer = setInterval(() => void this.tick().then(() => this.networkTick()).catch((e) => this.log.warn(`Billing: ${(e as Error).message}`)), 3_600_000);
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
    return SETUP_FEE_UAH * 100;
  }

  async overview(clinicId: string, now = new Date()) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { networkId: true, plan: true, billingStatus: true, paidUntil: true, periodStartsAt: true, setupPaidAt: true, aiMonthlyLimit: true, aiPurchased: true, aiPackCapPerMonth: true, limitOverrides: true } });
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
      // a branch of a network is paid by its network (/billing/network/:id): its own payment page only points there
      network: c.networkId ? await this.prisma.network.findUnique({ where: { id: c.networkId }, select: { id: true, name: true } }) : null,
      // LiqPay's test mode is on (a local or staging check; never in production)
      sandbox: liqpaySandbox(),
      // an order sent to LiqPay in the last 30 minutes and not confirmed yet: the page says the payment is being checked
      checking: payments.some((p) => p.status === 'PENDING' && now.getTime() - p.createdAt.getTime() < 30 * 60_000),
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
    // A plan the clinic does not fit into is not sold: more staff (with open invitations) than the plan allows must be removed first
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { limitOverrides: true, networkId: true } });
    // a branch of a network is paid by its network (networkCheckout), never on its own
    if (c.networkId) throw new BadRequestException('network_branch');
    const [users, pending] = await Promise.all([
      this.prisma.membership.count({ where: { clinicId } }),
      this.prisma.invitation.count({ where: { clinicId, acceptedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    if (users + pending > effectiveLimits(plan, c.limitOverrides).users) throw new BadRequestException('plan_users_over');
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
      // A paid order reversed later (a refund or a chargeback): recorded and sent to the service owner. The paid period is NOT taken back by
      // itself: that is a person's decision (a partial refund, a goodwill refund).
      if (cb.status === 'reversed') {
        const r = await this.prisma.billingPayment.updateMany({ where: { id: order.id, status: 'PAID' }, data: { status: 'REVERSED' } });
        if (r.count) {
          await this.prisma.auditLog.create({ data: { clinicId: order.clinicId, action: 'billing.reversed', details: { orderId: order.orderId, amountMinor: order.amountMinor } } });
          await this.toServiceOwner(`LiqPay: повернення оплати ${order.orderId}`, `Оплату ${order.orderId} (${(order.amountMinor / 100).toFixed(2)} грн) повернено в LiqPay. Оплачений період клініки ${order.clinicId} не змінено: вирішіть вручну.`);
        }
      }
      return; // wait_accept and other in-between statuses change nothing
    }
    // What was paid must match what we asked for
    if (cb.currency !== 'UAH' || Math.round(Number(cb.amount) * 100) !== order.amountMinor) {
      this.log.error(`LiqPay order ${order.orderId}: amount or currency mismatch`);
      await this.prisma.auditLog.create({ data: { clinicId: order.clinicId, action: 'billing.mismatch', details: { orderId: order.orderId, expected: order.amountMinor, got: Math.round(Number(cb.amount) * 100), currency: cb.currency ?? null } } });
      await this.toServiceOwner(`LiqPay: сума не збігається ${order.orderId}`, `Оплату ${order.orderId} не застосовано: очікували ${(order.amountMinor / 100).toFixed(2)} UAH, отримали ${cb.amount} ${cb.currency}. Перевірте в кабінеті LiqPay.`);
      return;
    }
    let duplicateSetup = false;
    let duplicatePeriod = false;
    const applied = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.billingPayment.updateMany({ where: { id: order.id, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'PAID', paidAt: now, providerRef: cb.payment_id !== undefined ? String(cb.payment_id) : null } });
      if (!claim.count) return false;
      if (order.kind === 'AI_PACK') {
        await tx.clinic.update({ where: { id: order.clinicId }, data: { aiPurchased: { increment: order.packReplies } } });
      } else if (order.kind === 'BRANCH_SETUP') {
        await tx.clinic.update({ where: { id: order.clinicId }, data: { branchSetupPaidAt: now } });
      } else if (order.kind === 'NETWORK' && order.networkId) {
        const n = await tx.network.findUniqueOrThrow({ where: { id: order.networkId }, select: { paidUntil: true, setupPaidAt: true } });
        // the period this order bought was already granted by another order (two payment windows both paid): the money is recorded for the service
        // owner to refund, the period is not granted a second time
        if (order.periodFrom && n.paidUntil && n.paidUntil.getTime() > order.periodFrom.getTime()) {
          duplicatePeriod = true;
          return true;
        }
        if (order.setupMinor && n.setupPaidAt) duplicateSetup = true;
        const base = n.paidUntil && n.paidUntil > now ? n.paidUntil : now;
        const until = addMonth(base);
        await tx.network.update({ where: { id: order.networkId }, data: { billingStatus: 'ACTIVE', paidUntil: until, periodStartsAt: now, ...(order.setupMinor && !n.setupPaidAt ? { setupPaidAt: now } : {}) } });
        // every branch gets the network's paid period and the Pro capabilities and allowances, each its own (no shared pool)
        for (const b of await tx.clinic.findMany({ where: { networkId: order.networkId }, select: { id: true, limitOverrides: true } })) {
          await tx.clinic.update({ where: { id: b.id }, data: { plan: 'NETWORK', billingStatus: 'ACTIVE', paidUntil: until, periodStartsAt: now, aiMonthlyLimit: effectiveLimits('NETWORK', b.limitOverrides).aiRepliesPerMonth } });
        }
      } else {
        const c = await tx.clinic.findUniqueOrThrow({ where: { id: order.clinicId }, select: { paidUntil: true, limitOverrides: true, setupPaidAt: true } });
        // Two payment windows opened before the first payment and both paid: the connection fee was taken twice. The month is applied as usual;
        // the second fee is recorded for the service owner to refund (setupPaidAt stays the first one).
        if (order.setupMinor && c.setupPaidAt) duplicateSetup = true;
        const plan = order.plan ?? 'START';
        // paying before the month ends extends it
        const base = c.paidUntil && c.paidUntil > now ? c.paidUntil : now;
        await tx.clinic.update({
          where: { id: order.clinicId },
          data: { plan, billingStatus: 'ACTIVE', paidUntil: addMonth(base), periodStartsAt: now, aiMonthlyLimit: effectiveLimits(plan, c.limitOverrides).aiRepliesPerMonth, ...(order.setupMinor && !c.setupPaidAt ? { setupPaidAt: now } : {}) },
        });
      }
      await tx.auditLog.create({ data: { clinicId: order.clinicId, action: 'billing.paid', details: { kind: order.kind, plan: order.plan, amountMinor: order.amountMinor, ...(order.networkId ? { networkId: order.networkId } : {}) } } });
      return true;
    });
    if (applied) await this.notify(order.clinicId, 'Оплату отримано', `Дякуємо! Оплату ${(order.amountMinor / 100).toFixed(2)} грн отримано.`);
    if (applied && duplicatePeriod) {
      await this.prisma.auditLog.create({ data: { clinicId: order.clinicId, action: 'billing.period_duplicate', details: { orderId: order.orderId, networkId: order.networkId, amountMinor: order.amountMinor } } });
      await this.toServiceOwner(`LiqPay: повторна оплата періоду мережі ${order.orderId}`, `Мережа ${order.networkId} оплатила той самий період удруге (замовлення ${order.orderId}, ${(order.amountMinor / 100).toFixed(2)} грн). Період не продовжено вдруге; поверніть оплату.`);
    }
    if (applied && duplicateSetup) {
      await this.prisma.auditLog.create({ data: { clinicId: order.clinicId, action: 'billing.setup_duplicate', details: { orderId: order.orderId, setupMinor: order.setupMinor } } });
      await this.toServiceOwner(`LiqPay: повторна оплата підключення ${order.orderId}`, `Клініка ${order.clinicId} оплатила підключення вдруге (${(order.setupMinor / 100).toFixed(2)} грн у замовленні ${order.orderId}). Поверніть цю частину.`);
    }
  }

  // The service owner (PLATFORM_ADMIN_EMAILS): what needs a person's decision about money
  private async toServiceOwner(subject: string, text: string) {
    const to = (process.env.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    for (const addr of to) await this.mail.send({ to: addr, subject: `LANKA: ${subject}`, text }).catch(() => undefined);
    if (!to.length) this.log.warn(`${subject}: PLATFORM_ADMIN_EMAILS is empty, nobody was mailed`);
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
    // branches of a network follow their network (networkTick below), so their owner is not reminded once per branch
    // (a branch of a network that is not paid yet keeps its own days, which run out here as for any clinic)
    const clinics = await this.prisma.clinic.findMany({ where: { OR: [{ networkId: null }, { network: { billingStatus: { notIn: ['ACTIVE', 'PAST_DUE'] } } }], billingStatus: { in: ['ACTIVE', 'PAST_DUE'] }, paidUntil: { not: null, lt: soon } }, select: { id: true, billingStatus: true, paidUntil: true } });
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

  // ---------- networks ----------
  // The network's monthly payment for its current branches plus the standard onboarding once (the first branch). Only the network's owner pays.
  async networkOverview(networkId: string) {
    const n = await this.prisma.network.findUniqueOrThrow({ where: { id: networkId }, include: { clinics: { select: { id: true, name: true, branchSetupQuoteUah: true, branchSetupPaidAt: true }, orderBy: { name: 'asc' } } } });
    const payments = await this.prisma.billingPayment.findMany({ where: { networkId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, kind: true, clinicId: true, amountMinor: true, setupMinor: true, status: true, createdAt: true, paidAt: true } });
    // What the next payment does, shown before paying. The owner's rule (approved 2026-11-16, no proration): to add a branch during a paid period the
    // owner PREPAYS the next network period at the price including it; once that payment is confirmed the new branch gets access at once, and its
    // access until that period starts is complimentary. The payment charges the monthly amount for ALL current branches (plus the first onboarding
    // once); it buys the month starting at the end of the paid period (today when nothing is paid or the period has ended); the renewal after it is
    // the same monthly amount for the same branches. A further branch's onboarding is a separate payment (branchSetups). One period is bought once:
    // when the next period is already prepaid, or a payment window was opened minutes ago, no new purchase is offered.
    const now = new Date();
    const from = n.paidUntil && n.paidUntil > now ? n.paidUntil : now;
    const block = await this.networkCheckoutBlock(networkId, n.paidUntil, now);
    const to = addMonth(from);
    const monthly = networkMonthlyUah(n.clinics.length);
    const states = await this.prisma.clinic.findMany({ where: { networkId }, orderBy: { name: 'asc' }, select: { name: true, plan: true, billingStatus: true, paidUntil: true } });
    const onNetwork = (b: (typeof states)[number]) => b.plan === 'NETWORK' && !!n.paidUntil && !!b.paidUntil && b.paidUntil.getTime() === n.paidUntil.getTime() && (b.billingStatus === 'ACTIVE' || b.billingStatus === 'PAST_DUE');
    const nextPayment = {
      chargeNowUah: monthly + (n.setupPaidAt ? 0 : SETUP_FEE_UAH),
      monthlyUah: monthly,
      setupUah: n.setupPaidAt ? null : SETUP_FEE_UAH,
      coversFrom: from,
      coversTo: to,
      renewal: { date: to, amountUah: monthly },
      // the branches this payment pays for (all current ones)
      branchesCovered: states.map((b) => b.name),
      // these branches get the network's paid access when this payment is confirmed (until then they keep their own state)
      branchesGettingAccess: block ? [] : states.filter((b) => !onNetwork(b)).map((b) => b.name),
      // the bought period starts later than now: access from the confirmation to its start is complimentary for the branches getting access
      complimentaryUntil: from > now ? from : null,
      // null = a purchase is offered; next_period_paid = the next period is already prepaid (a branch added now is not covered by it: support);
      // payment_pending = a payment window was opened minutes ago and is not confirmed yet
      blocked: block,
      // branches without the network's paid access while the next period is already prepaid: the case is handled with support, no charge here
      uncoveredAfterPrepaid: block === 'next_period_paid' ? states.filter((b) => !onNetwork(b)).map((b) => b.name) : [],
    };
    return {
      configured: !!this.keys(),
      sandbox: liqpaySandbox(),
      nextPayment,
      status: n.billingStatus,
      paidUntil: n.paidUntil,
      graceUntil: n.paidUntil ? new Date(n.paidUntil.getTime() + GRACE_DAYS * DAY) : null,
      branches: n.clinics.length,
      monthlyUah: networkMonthlyUah(n.clinics.length),
      setupUah: n.setupPaidAt ? null : SETUP_FEE_UAH,
      // a further branch's onboarding: only an amount the service owner quoted for it can be paid
      branchSetups: n.clinics.filter((c) => c.branchSetupQuoteUah && !c.branchSetupPaidAt).map((c) => ({ clinicId: c.id, name: c.name, quoteUah: c.branchSetupQuoteUah })),
      checking: payments.some((p) => p.status === 'PENDING' && Date.now() - p.createdAt.getTime() < 30 * 60_000),
      payments,
    };
  }

  async networkCheckout(networkId: string) {
    const keys = this.keys();
    if (!keys) throw new BadRequestException('billing_not_configured');
    const n = await this.prisma.network.findUniqueOrThrow({ where: { id: networkId }, select: { name: true, setupPaidAt: true, clinics: { select: { id: true }, orderBy: { createdAt: 'asc' } } } });
    if (!n.clinics.length) throw new BadRequestException('network_no_branches');
    const now = new Date();
    const paidUntil = (await this.prisma.network.findUniqueOrThrow({ where: { id: networkId }, select: { paidUntil: true } })).paidUntil;
    const block = await this.networkCheckoutBlock(networkId, paidUntil, now);
    if (block) throw new BadRequestException(block === 'next_period_paid' ? 'network_next_period_paid' : 'network_payment_pending');
    const periodFrom = paidUntil && paidUntil > now ? paidUntil : now;
    const setupMinor = n.setupPaidAt ? 0 : SETUP_FEE_UAH * 100;
    const amountMinor = networkMonthlyUah(n.clinics.length) * 100 + setupMinor;
    const orderId = this.orderId(n.clinics[0].id);
    await this.prisma.billingPayment.create({ data: { clinicId: n.clinics[0].id, networkId, orderId, kind: 'NETWORK', plan: 'NETWORK', amountMinor, setupMinor, periodFrom } });
    return this.form(orderId, amountMinor, `LANKA: мережа «${n.name}», ${n.clinics.length} філ.${setupMinor ? ' + підключення' : ''}`, keys);
  }

  // Why no network purchase is offered now (null: it is). The next period is already prepaid when the paid end lies more than one month ahead
  // (the current period plus a prepaid one); a payment window opened in the last 15 minutes is waiting for LiqPay's confirmation.
  private async networkCheckoutBlock(networkId: string, paidUntil: Date | null, now: Date): Promise<'next_period_paid' | 'payment_pending' | null> {
    if (paidUntil && paidUntil.getTime() > addMonth(now).getTime() + 60_000) return 'next_period_paid';
    const pending = await this.prisma.billingPayment.count({ where: { networkId, kind: 'NETWORK', status: 'PENDING', createdAt: { gt: new Date(now.getTime() - 15 * 60_000) } } });
    return pending ? 'payment_pending' : null;
  }

  async branchSetupCheckout(networkId: string, clinicId: string) {
    const keys = this.keys();
    if (!keys) throw new BadRequestException('billing_not_configured');
    const c = await this.prisma.clinic.findFirst({ where: { id: clinicId, networkId }, select: { id: true, name: true, branchSetupQuoteUah: true, branchSetupPaidAt: true } });
    if (!c) throw new BadRequestException('branch_not_found');
    if (!c.branchSetupQuoteUah || c.branchSetupQuoteUah < BRANCH_SETUP_MIN_UAH) throw new BadRequestException('branch_setup_not_quoted');
    if (c.branchSetupPaidAt) throw new BadRequestException('branch_setup_paid');
    const orderId = this.orderId(c.id);
    const amountMinor = c.branchSetupQuoteUah * 100;
    await this.prisma.billingPayment.create({ data: { clinicId: c.id, networkId, orderId, kind: 'BRANCH_SETUP', amountMinor } });
    return this.form(orderId, amountMinor, `LANKA: підключення філіалу «${c.name}»`, keys);
  }

  // A network moves through ACTIVE -> PAST_DUE -> LAPSED like a clinic, and its branches with it; its owners get one reminder per step
  async networkTick(now = new Date()) {
    const soon = new Date(now.getTime() + 5 * DAY);
    const nets = await this.prisma.network.findMany({ where: { billingStatus: { in: ['ACTIVE', 'PAST_DUE'] }, paidUntil: { not: null, lt: soon } }, include: { clinics: { select: { id: true } }, members: { where: { role: 'OWNER' }, include: { user: { select: { email: true } } } } } });
    for (const n of nets) {
      const until = n.paidUntil!;
      const graceEnd = new Date(until.getTime() + GRACE_DAYS * DAY);
      const step = now >= graceEnd ? 'LAPSED' : now >= until ? 'PAST_DUE' : 'SOON';
      if (step !== 'SOON' && n.billingStatus !== step) {
        await this.prisma.network.update({ where: { id: n.id }, data: { billingStatus: step } });
        await this.prisma.clinic.updateMany({ where: { networkId: n.id }, data: { billingStatus: step } });
      }
      const action = `billing.network.${step.toLowerCase()}`;
      const anchor = n.clinics[0]?.id;
      if (!anchor) continue;
      const sent = await this.prisma.auditLog.findFirst({ where: { clinicId: anchor, action, createdAt: { gt: new Date(until.getTime() - 40 * DAY) } }, select: { id: true } });
      if (sent) continue;
      await this.prisma.auditLog.create({ data: { clinicId: anchor, action, details: { networkId: n.id, paidUntil: until.toISOString() } } });
      const day = (d: Date) => d.toISOString().slice(0, 10);
      const text = step === 'SOON' ? `Оплачений період мережі «${n.name}» діє до ${day(until)}.` : step === 'PAST_DUE' ? `Оплачений період мережі «${n.name}» закінчився. Філіали працюють ще ${GRACE_DAYS} днів (до ${day(graceEnd)}).` : `Доступ до даних філіалів мережі «${n.name}» закрито. Дані збережено.`;
      for (const m of n.members) await this.mail.send({ to: m.user.email, subject: `LANKA: оплата мережі «${n.name}»`, text }).catch(() => undefined);
    }
  }
}