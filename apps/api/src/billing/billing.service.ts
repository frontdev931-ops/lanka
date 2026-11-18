import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { BillingPayment, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { MailService } from '../auth/mail.service';
import type { AuthUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AI_PACK, BRANCH_SETUP_MIN_UAH, GRACE_DAYS, PLANS, SELLABLE_PLANS, SETUP_FEE_UAH, effectiveLimits, networkMonthlyUah, periodStart } from '../service/plans';
import { canAccessPlatform } from '../service/platform-access';
import { INVOICE_VALIDITY, MONO_CURRENCY, MonoClient, MonoRequestError, MonoStatus, readMonoStatus } from './mono';
import { DIAGNOSTIC_AUDIT_PREFIX, DIAGNOSTIC_WEBHOOK, MONO_DIAGNOSTIC } from './mono-diagnostic';

const DAY = 86_400_000;
const CHECK_INTERVAL = 15_000;
const ONE_TIME_PRO_MINOR = 100;
const monoPending: Prisma.BillingPaymentWhereInput = {
  monoExpiresAt: { not: null },
  OR: [{ status: 'PENDING' }, { status: 'FAILED', monoInvoiceId: { not: null } }],
};
const paymentDetails = { id: true, kind: true, plan: true, amountMinor: true, currency: true, setupMinor: true, packReplies: true, status: true, createdAt: true, paidAt: true, periodFrom: true, periodTo: true, refundedMinor: true } as const;
type Scope = { clinicId: string; networkId?: string | null } | { networkId: string; clinicId?: never };
type Quote = Pick<BillingPayment, 'clinicId' | 'kind' | 'amountMinor'> & Partial<Pick<BillingPayment, 'networkId' | 'periodFrom' | 'periodTo' | 'plan' | 'setupMinor' | 'packReplies' | 'branchIds' | 'oneTimeProBuyerId' | 'oneTimeProIncludesSetup'>>;
const addMonth = (d: Date) => {
  const r = new Date(d);
  r.setUTCMonth(r.getUTCMonth() + 1);
  return r;
};

@Injectable()
export class BillingService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(BillingService.name);
  private timer?: NodeJS.Timeout;
  private reconciliationTimer?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private mono: MonoClient,
  ) {}

  // Statuses and reminders are checked every hour (not in tests: AUTOMATIONS_TICK_SECONDS=0)
  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'production' && !this.mono.configured) this.log.warn('Online payments unavailable: MONO_ACQUIRING_TOKEN is not configured');
    if (!Number(process.env.AUTOMATIONS_TICK_SECONDS ?? 60)) return;
    this.timer = setInterval(() => void this.tick().then(() => this.networkTick()).catch((e) => this.log.warn(`Billing: ${(e as Error).message}`)), 3_600_000);
    this.timer.unref();
    this.reconciliationTimer = setInterval(() => void this.reconcilePending().catch(() => this.log.warn('Billing reconciliation failed')), 60_000);
    this.reconciliationTimer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
  }

  async overview(user: AuthUser, now = new Date()) {
    const { clinicId } = user;
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { networkId: true, plan: true, billingStatus: true, paidUntil: true, periodStartsAt: true, setupPaidAt: true, aiMonthlyLimit: true, aiPurchased: true, aiPackCapPerMonth: true, limitOverrides: true } });
    const since = periodStart(c, now);
    const [used, packs, payments] = await Promise.all([
      this.prisma.aiUsage.count({ where: { clinicId, ok: true, billable: true, createdAt: { gte: since } } }),
      this.prisma.billingPayment.count({ where: { clinicId, kind: 'AI_PACK', status: 'PAID', paidAt: { gte: since } } }),
      this.prisma.billingPayment.findMany({ where: { clinicId, kind: { not: MONO_DIAGNOSTIC } }, orderBy: { createdAt: 'desc' }, take: 20, select: { ...paymentDetails, oneTimeProBuyerId: true } }),
    ]);
    const setupUah = c.setupPaidAt ? null : SETUP_FEE_UAH;
    const from = c.paidUntil && c.paidUntil > now ? c.paidUntil : now;
    const pending = await this.prisma.billingPayment.findFirst({ where: { clinicId, networkId: null, kind: { not: MONO_DIAGNOSTIC }, ...monoPending }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    const oneTimePro = c.networkId ? null : await this.oneTimeProOffer(user, !c.setupPaidAt);
    return {
      configured: this.mono.configured,
      // a branch of a network is paid by its network (/billing/network/:id): its own payment page only points there
      network: c.networkId ? await this.prisma.network.findUnique({ where: { id: c.networkId }, select: { id: true, name: true } }) : null,
      pendingPaymentId: pending?.id ?? null,
      nextPeriod: { from, to: addMonth(from) },
      plan: c.plan,
      status: c.billingStatus,
      paidUntil: c.paidUntil,
      graceUntil: c.paidUntil ? new Date(c.paidUntil.getTime() + GRACE_DAYS * DAY) : null,
      plans: SELLABLE_PLANS.map((k) => {
        const offer = k === 'PRO' ? oneTimePro : null;
        return {
          key: k, priceUah: PLANS[k].priceUah, totalUah: offer ? ONE_TIME_PRO_MINOR / 100 : PLANS[k].priceUah + (setupUah ?? 0),
          limits: PLANS[k].limits, features: PLANS[k].features, ...(offer && { oneTimePro: offer }),
        };
      }),
      setupPaid: !!c.setupPaidAt,
      setupUah,
      pack: { ...AI_PACK, bought: packs, cap: c.aiPackCapPerMonth, periodFrom: since, periodTo: c.paidUntil },
      ai: { included: c.aiMonthlyLimit, used, purchased: c.aiPurchased, remaining: Math.max(0, c.aiMonthlyLimit - used) + c.aiPurchased },
      limits: effectiveLimits(c.plan, c.limitOverrides),
      payments: payments.map(({ oneTimeProBuyerId, ...payment }) => ({ ...payment, oneTimePro: !!oneTimeProBuyerId })),
    };
  }

  private async lockScope(tx: Prisma.TransactionClient, scope: Scope) {
    if (scope.networkId) await tx.$queryRaw`SELECT id FROM "Network" WHERE id = ${scope.networkId} FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM "Clinic" WHERE id = ${scope.clinicId} FOR UPDATE`;
  }

  private async purchase(
    scope: Scope, kind: string, now: Date,
    quote: (tx: Prisma.TransactionClient) => Promise<{ order: Quote; description: string }>,
    subscription?: { plan: string; buyer: AuthUser },
  ) {
    if (!this.mono.configured) throw new ServiceUnavailableException('billing_not_configured');
    const active = { ...scope, kind, ...monoPending };
    const before = await this.prisma.billingPayment.findFirst({ where: active });
    if (before && before.monoExpiresAt! <= now) await this.reconcile(before);

    const reserved = await this.prisma.$transaction(async (tx) => {
      await this.lockScope(tx, scope);
      const existing = await tx.billingPayment.findFirst({ where: active, orderBy: { createdAt: 'asc' } });
      if (existing) {
        if ((subscription && existing.plan !== subscription.plan) ||
            !(await this.canOpenOneTimePro(tx, existing, subscription?.buyer))) throw new ConflictException('billing_payment_pending');
        return { order: existing, description: null };
      }
      if (before && (!subscription || before.plan === subscription.plan)) {
        const settled = await tx.billingPayment.findFirst({ where: { id: before.id, status: { in: ['PAID', 'REVERSED'] } } });
        if (settled) return { order: settled, description: null };
      }
      const { order, description } = await quote(tx);
      const row = await tx.billingPayment.create({ data: {
        ...order, orderId: randomBytes(16).toString('hex'), currency: MONO_CURRENCY,
        monoExpiresAt: new Date(now.getTime() + INVOICE_VALIDITY * 1000),
      } });
      return { order: row, description };
    });

    const { order, description } = reserved;
    if (description) {
      let invoice: Awaited<ReturnType<MonoClient['create']>>;
      try {
        invoice = await this.mono.create(order, description);
      } catch (e) {
        // A timeout, invalid answer or server failure can follow creation. It must never trigger another POST.
        if (e instanceof MonoRequestError && [400, 403, 405, 429].includes(e.status ?? 0)) {
          await this.prisma.billingPayment.updateMany({ where: { id: order.id, status: 'PENDING', monoInvoiceId: null }, data: { status: 'FAILED' } });
        }
        return { id: order.id, url: null, amountMinor: order.amountMinor };
      }
      const saved = await this.prisma.billingPayment.updateMany({
        where: { id: order.id, OR: [{ monoInvoiceId: null }, { monoInvoiceId: invoice.invoiceId }] },
        data: { monoInvoiceId: invoice.invoiceId, monoPageUrl: invoice.pageUrl, monoExpiresAt: new Date(Date.now() + INVOICE_VALIDITY * 1000) },
      });
      if (!saved.count) return { id: order.id, url: null, amountMinor: order.amountMinor };
    }
    const current = await this.prisma.billingPayment.findUniqueOrThrow({ where: { id: order.id } });
    return { id: order.id, url: this.checkoutUrl(current), amountMinor: order.amountMinor };
  }

  private checkoutUrl(order: BillingPayment) {
    return (order.status === 'PENDING' || order.status === 'FAILED') && order.monoExpiresAt && order.monoExpiresAt > new Date()
      ? order.monoPageUrl : null;
  }

  private oneTimeProEnabled(clinicId: string) {
    return process.env.BILLING_ONE_TIME_PRO_ENABLED === 'true' && process.env.BILLING_ONE_TIME_PRO_CLINIC_ID?.trim() === clinicId;
  }

  private async authorizedOneTimePro(tx: Pick<Prisma.TransactionClient, 'user' | 'membership'>, user: AuthUser) {
    if (user.role !== 'OWNER' || !(await canAccessPlatform(tx, user.userId))) return false;
    const membership = await tx.membership.findUnique({
      where: { userId_clinicId: { userId: user.userId, clinicId: user.clinicId } },
      select: { role: true, clinic: { select: { networkId: true, isDemo: true } } },
    });
    return membership?.role === 'OWNER' && !membership.clinic.networkId && !membership.clinic.isDemo;
  }

  private async canOpenOneTimePro(tx: Pick<Prisma.TransactionClient, 'user' | 'membership' | 'billingPayment'>, order: BillingPayment, user?: AuthUser) {
    if (!order.oneTimeProBuyerId) return true;
    return user?.userId === order.oneTimeProBuyerId && await this.authorizedOneTimePro(tx, user) &&
      !(await this.oneTimeProConsumed(tx, order.clinicId, order.id));
  }

  private oneTimeProConsumed(tx: Pick<Prisma.TransactionClient, 'billingPayment'>, clinicId: string, exceptId?: string) {
    return tx.billingPayment.findFirst({
      where: {
        clinicId, oneTimeProBuyerId: { not: null }, ...(exceptId && { id: { not: exceptId } }),
        OR: [{ paidAt: { not: null } }, { status: 'REVERSED' }],
      },
      select: { id: true },
    });
  }

  private async oneTimeProOffer(user: AuthUser, includesSetup: boolean) {
    if (!(await this.authorizedOneTimePro(this.prisma, user))) return null;
    if (await this.oneTimeProConsumed(this.prisma, user.clinicId)) return null;
    const open = await this.prisma.billingPayment.findFirst({
      where: { clinicId: user.clinicId, networkId: null, kind: 'SUBSCRIPTION', ...monoPending },
      select: { oneTimeProBuyerId: true, oneTimeProIncludesSetup: true },
    });
    if (open) return open.oneTimeProBuyerId === user.userId ? { includesSetup: open.oneTimeProIncludesSetup } : null;
    if (!this.oneTimeProEnabled(user.clinicId)) return null;
    return { includesSetup };
  }

  checkout(user: AuthUser, plan: string, now = new Date()) {
    const { clinicId } = user;
    if (!SELLABLE_PLANS.includes(plan)) throw new BadRequestException('bad_plan');
    return this.purchase({ clinicId, networkId: null }, 'SUBSCRIPTION', now, async (tx) => {
      const c = await tx.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { limitOverrides: true, networkId: true, setupPaidAt: true, paidUntil: true } });
      if (c.networkId) throw new BadRequestException('network_branch');
      const [users, pending] = await Promise.all([
        tx.membership.count({ where: { clinicId } }),
        tx.invitation.count({ where: { clinicId, acceptedAt: null, expiresAt: { gt: now } } }),
      ]);
      if (users + pending > effectiveLimits(plan, c.limitOverrides).users) throw new BadRequestException('plan_users_over');
      const oneTimePro = plan === 'PRO' && this.oneTimeProEnabled(clinicId) && await this.authorizedOneTimePro(tx, user) &&
        !(await this.oneTimeProConsumed(tx, clinicId));
      const setupMinor = oneTimePro || c.setupPaidAt ? 0 : SETUP_FEE_UAH * 100;
      const periodFrom = c.paidUntil && c.paidUntil > now ? c.paidUntil : now;
      return {
        order: {
          clinicId, kind: 'SUBSCRIPTION', plan, amountMinor: oneTimePro ? ONE_TIME_PRO_MINOR : PLANS[plan].priceUah * 100 + setupMinor,
          setupMinor, periodFrom, periodTo: addMonth(periodFrom),
          ...(oneTimePro && { oneTimeProBuyerId: user.userId, oneTimeProIncludesSetup: !c.setupPaidAt }),
        },
        description: oneTimePro ? `LANKA — Pro, разова перевірка оплати${c.setupPaidAt ? '' : ' (з підключенням)'}` : `LANKA ${PLANS[plan].label}`,
      };
    }, { plan, buyer: user });
  }

  buyPack(clinicId: string, now = new Date()) {
    return this.purchase({ clinicId, networkId: null }, 'AI_PACK', now, async (tx) => {
      const c = await tx.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { billingStatus: true, periodStartsAt: true, paidUntil: true, aiPackCapPerMonth: true } });
      if (c.billingStatus !== 'ACTIVE' && c.billingStatus !== 'PAST_DUE') throw new BadRequestException('payment_required');
      const since = periodStart(c, now);
      const bought = await tx.billingPayment.count({ where: { clinicId, kind: 'AI_PACK', status: 'PAID', paidAt: { gte: since } } });
      if (bought >= c.aiPackCapPerMonth) throw new BadRequestException('pack_cap');
      return {
        order: { clinicId, kind: 'AI_PACK', amountMinor: AI_PACK.priceUah * 100, packReplies: AI_PACK.replies, periodFrom: since, periodTo: c.paidUntil },
        description: `LANKA: ${AI_PACK.replies} відповідей ШІ`,
      };
    });
  }

  private diagnosticEnabled() {
    return process.env.MONO_DIAGNOSTIC_ENABLED === 'true';
  }

  async diagnosticOverview(clinicId: string) {
    const latest = await this.prisma.billingPayment.findFirst({
      where: { clinicId, kind: MONO_DIAGNOSTIC }, orderBy: { createdAt: 'desc' }, select: { id: true },
    });
    return { enabled: this.diagnosticEnabled(), configured: this.mono.configured, paymentId: latest?.id ?? null };
  }

  diagnosticCheckout(clinicId: string) {
    if (!this.diagnosticEnabled()) throw new NotFoundException();
    return this.purchase({ clinicId, networkId: null }, MONO_DIAGNOSTIC, new Date(), async () => ({
      order: { clinicId, kind: MONO_DIAGNOSTIC, amountMinor: 100 },
      description: 'LANKA — перевірка оплати',
    }));
  }

  async diagnosticPayment(id: string, clinicId: string) {
    const order = await this.reconciledPayment(id, { clinicId, kind: MONO_DIAGNOSTIC });
    const webhook = await this.prisma.auditLog.findFirst({
      where: { clinicId, action: DIAGNOSTIC_WEBHOOK, details: { path: ['orderId'], equals: order.orderId } }, select: { createdAt: true },
    });
    return {
      ...this.paymentStatus(order, this.diagnosticEnabled()),
      diagnostic: {
        invoiceId: order.monoInvoiceId,
        reference: order.orderId,
        webhookReceivedAt: webhook?.createdAt ?? null,
        checkoutLinkUnavailable: order.status === 'PENDING' && !order.monoPageUrl,
      },
    };
  }

  async payment(id: string, scope: Scope, owner: boolean, user?: AuthUser) {
    const order = await this.reconciledPayment(id, { ...scope, kind: { not: MONO_DIAGNOSTIC } });
    return this.paymentStatus(order, owner && await this.canOpenOneTimePro(this.prisma, order, user));
  }

  private async reconciledPayment(id: string, scope: Prisma.BillingPaymentWhereInput) {
    const order = await this.prisma.billingPayment.findFirst({ where: { ...scope, id } });
    if (!order) throw new NotFoundException();
    await this.reconcile(order);
    return this.prisma.billingPayment.findUniqueOrThrow({ where: { id } });
  }

  private paymentStatus(order: BillingPayment, canResume: boolean) {
    const { id, status, amountMinor, setupMinor, periodFrom, periodTo, refundedMinor, kind } = order;
    return {
      id, status, amountMinor, setupMinor, periodFrom, periodTo, refundedMinor, kind,
      ...(order.oneTimeProBuyerId && { oneTimePro: { includesSetup: order.oneTimeProIncludesSetup } }),
      review: status === 'PENDING' && !order.monoInvoiceId && !!order.monoExpiresAt && order.monoExpiresAt <= new Date(),
      url: canResume ? this.checkoutUrl(order) : null,
    };
  }

  async callback(raw?: Buffer, signature?: string) {
    if (!raw || !signature || !(await this.mono.validSignature(raw, signature))) throw new BadRequestException('bad_signature');
    const event = readMonoStatus(JSON.parse(raw.toString('utf8')));
    if (!event) throw new BadRequestException('billing_invalid_status');
    await this.applyStatus(event);
  }

  async reconcilePending() {
    if (!this.mono.configured) return;
    const now = new Date();
    const batch = await this.prisma.billingPayment.findMany({
      where: {
        AND: [{ OR: [monoPending, { monoInvoiceId: { not: null }, status: { in: ['PAID', 'EXPIRED'] }, createdAt: { gte: new Date(now.getTime() - 30 * DAY) } }] },
          { OR: [{ monoCheckedAt: null }, { monoCheckedAt: { lte: new Date(now.getTime() - 60_000) } }] }],
      },
      orderBy: [{ monoCheckedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      take: 10,
    });
    // Entries fail independently. The timeout on every request bounds the scheduler work.
    for (const row of batch) await this.reconcile(row);
  }

  private async reconcile(order: BillingPayment) {
    if (!this.mono.configured || !order.monoExpiresAt) return;
    const now = new Date();
    if (!order.monoInvoiceId && (order.status !== 'PENDING' || now.getTime() - order.createdAt.getTime() < 15_000)) return;
    // One status query per invoice per interval, even across API replicas.
    const interval = order.monoInvoiceId ? CHECK_INTERVAL : 60_000;
    const claimed = await this.prisma.billingPayment.updateMany({
      where: { id: order.id, OR: [{ monoCheckedAt: null }, { monoCheckedAt: { lte: new Date(now.getTime() - interval) } }] },
      data: { monoCheckedAt: now },
    });
    if (!claimed.count) return;
    try {
      const invoice = order.monoInvoiceId ?? await this.mono.findInvoice(order.orderId, order.createdAt);
      if (invoice) await this.applyStatus(await this.mono.status(invoice), order.id, !order.monoInvoiceId);
    } catch (e) {
      if (!(e instanceof MonoRequestError)) throw e;
    }
  }

  private async applyStatus(event: MonoStatus, localId?: string, fromStatement = false) {
    const linked = await this.prisma.billingPayment.findUnique({ where: { monoInvoiceId: event.invoiceId } });
    const order = linked ?? (localId
      ? await this.prisma.billingPayment.findUnique({ where: { id: localId } })
      : typeof event.reference === 'string' ? await this.prisma.billingPayment.findUnique({ where: { orderId: event.reference } }) : null);
    if (!order?.monoExpiresAt || (localId && order.id !== localId)) return;
    const changedAt = new Date(event.modifiedDate);
    const refund = this.refundAmount(event);
    const target = event.status === 'success' ? 'PAID' : event.status === 'reversed' ? 'REVERSED' :
      event.status === 'expired' ? 'EXPIRED' : event.status === 'failure' ? 'FAILED' : 'PENDING';
    const notices = await this.prisma.$transaction(async (tx) => {
      await this.lockScope(tx, { clinicId: order.clinicId, networkId: order.networkId });
      const fresh = await tx.billingPayment.findUniqueOrThrow({ where: { id: order.id } });
      if ((fresh.monoInvoiceId && fresh.monoInvoiceId !== event.invoiceId) ||
          (event.reference !== undefined && event.reference !== fresh.orderId) ||
          (!fresh.monoInvoiceId && !fromStatement && event.reference !== fresh.orderId)) return;
      const stale = fresh.monoModifiedAt && changedAt < fresh.monoModifiedAt;
      // A verified webhook is evidence of delivery even if the status API confirmed the payment first.
      const diagnosticWebhook = fresh.kind === MONO_DIAGNOSTIC && !localId && target === 'PAID' && !refund;
      if (stale && !diagnosticWebhook) return;
      const auditAction = (action: string) => fresh.kind === MONO_DIAGNOSTIC ? DIAGNOSTIC_AUDIT_PREFIX + action : 'billing.' + action;
      const audit = (action: string, details: Prisma.InputJsonObject) => tx.auditLog.create({
        data: { clinicId: fresh.clinicId, action: auditAction(action), details: { orderId: fresh.orderId, ...details } },
      });
      const audited = (action: string) => tx.auditLog.findFirst({
        where: { clinicId: fresh.clinicId, action: auditAction(action), details: { path: ['orderId'], equals: fresh.orderId } },
        select: { id: true },
      });
      if (event.amount !== fresh.amountMinor || event.ccy !== fresh.currency || refund > fresh.amountMinor ||
          (event.status === 'success' && event.finalAmount !== undefined &&
            (!Number.isSafeInteger(event.finalAmount) || event.finalAmount < 0 || event.finalAmount > fresh.amountMinor))) {
        if (stale || await audited('mismatch')) return;
        await audit('mismatch', { expected: fresh.amountMinor, got: event.amount, currency: event.ccy });
        return { mismatch: true };
      }
      if (diagnosticWebhook && !(await audited('webhook'))) await audit('webhook', { invoiceId: event.invoiceId });
      if (stale) return;
      if (fresh.status === 'REVERSED') return;
      const sameTime = fresh.monoModifiedAt?.getTime() === changedAt.getTime();
      if (sameTime && target === 'PENDING' && fresh.status !== 'PENDING') return;
      if ((fresh.status === 'PAID' || fresh.status === 'EXPIRED') && ['FAILED', 'PENDING'].includes(target)) return;
      if (fresh.status === 'PAID' && target === 'EXPIRED') return;

      const provider = { monoInvoiceId: event.invoiceId, monoModifiedAt: changedAt };
      if (target === 'REVERSED' || refund > fresh.refundedMinor) {
        const refundedMinor = Math.max(refund, fresh.refundedMinor);
        const reversed = target === 'REVERSED' || refundedMinor === fresh.amountMinor || !fresh.paidAt;
        await tx.billingPayment.update({ where: { id: fresh.id }, data: { ...provider, status: reversed ? 'REVERSED' : 'PAID', refundedMinor } });
        await audit(reversed ? 'reversed' : 'refunded', { refundedMinor, amountMinor: fresh.amountMinor });
        return { reversal: true, refundedMinor };
      }
      if (fresh.status === 'PAID') {
        if (!sameTime) await tx.billingPayment.update({ where: { id: fresh.id }, data: provider });
        return;
      }
      if (target !== 'PAID') {
        await tx.billingPayment.update({ where: { id: fresh.id }, data: { ...provider, status: target } });
        return;
      }
      await tx.billingPayment.update({ where: { id: fresh.id }, data: { ...provider, status: 'PAID', paidAt: changedAt } });
      const exceptions = await this.grant(tx, fresh, changedAt);
      await audit('paid', { kind: fresh.kind, plan: fresh.plan, amountMinor: fresh.amountMinor, networkId: fresh.networkId,
        ...(fresh.oneTimeProBuyerId && { oneTimePro: true, includesSetup: fresh.oneTimeProIncludesSetup }) });
      for (const action of exceptions) await audit(action, { kind: fresh.kind, amountMinor: fresh.amountMinor, networkId: fresh.networkId, setupMinor: fresh.setupMinor });
      return { paid: true, exceptions };
    });
    if (order.kind === MONO_DIAGNOSTIC) return;
    if (notices?.mismatch) {
      await this.toServiceOwner(`mono: сума або валюта не збігається ${order.orderId}`,
        `Оплату ${order.orderId} не застосовано. Очікували ${order.amountMinor} (код ${order.currency}), отримали ${event.amount} (код ${event.ccy}). Суми в мінімальних одиницях. Перевірте рахунок у кабінеті mono.`);
    }
    if (notices?.reversal) {
      await this.toServiceOwner(`mono: повернення ${order.orderId}`, `За замовленням ${order.orderId} повернено ${notices.refundedMinor / 100} грн. Доступ та ліміти не змінено. Перевірте оплату вручну.`);
    }
    if (notices?.paid) {
      await this.notify(order.clinicId, 'Оплату отримано', `Дякуємо! Оплату ${(order.amountMinor / 100).toFixed(2)} грн отримано.`).catch(() => undefined);
      for (const action of notices.exceptions) {
        const detail = action === 'setup_duplicate' ? `Підключення вже оплачене. Перевірте повернення ${order.setupMinor / 100} грн.` :
          action === 'period_duplicate' ? 'Період мережі вже оплачений. Перевірте повернення всієї суми.' :
          action === 'one_time_pro_duplicate' ? 'Разову оплату Pro вже застосовано. Перевірте другий платіж у mono.' :
          'Склад мережі або належність філіалу змінилися. Перевірте оплату та доступ.';
        await this.toServiceOwner(`mono: перевірка оплати ${order.orderId}`, `Замовлення ${order.orderId}. ${detail}`);
      }
    }
  }

  private refundAmount(event: MonoStatus) {
    if (event.status === 'reversed') return event.amount;
    if (event.status !== 'success') return 0;
    const cancellations = Array.isArray(event.cancelList) ? event.cancelList : [];
    const cancelled = cancellations.filter((c) => c?.status === 'success' && c.ccy === event.ccy && Number.isSafeInteger(c.amount) && c.amount > 0)
      .reduce((sum, c) => sum + c.amount, 0);
    return Math.max(cancelled, Number.isSafeInteger(event.finalAmount) ? event.amount - event.finalAmount! : 0);
  }

  private async grant(tx: Prisma.TransactionClient, order: BillingPayment, now: Date): Promise<string[]> {
    const { clinicId, networkId, kind, setupMinor, periodFrom } = order;
    if (kind === MONO_DIAGNOSTIC) return [];
    if (kind === 'AI_PACK') {
      await tx.clinic.update({ where: { id: clinicId }, data: { aiPurchased: { increment: order.packReplies } } });
      return [];
    }
    if (kind === 'BRANCH_SETUP' && networkId) {
      const branch = await tx.clinic.findFirst({ where: { id: clinicId, networkId }, select: { id: true } });
      if (!branch) return ['scope_changed'];
      const update = await tx.clinic.updateMany({ where: { id: clinicId, networkId, branchSetupPaidAt: null }, data: { branchSetupPaidAt: now } });
      return update.count ? [] : ['setup_duplicate'];
    }
    if (kind === 'NETWORK' && networkId) {
      const n = await tx.network.findUniqueOrThrow({ where: { id: networkId }, select: { paidUntil: true, setupPaidAt: true } });
      if (periodFrom && n.paidUntil && n.paidUntil > periodFrom) return ['period_duplicate'];
      const from = n.paidUntil && n.paidUntil > now ? n.paidUntil : now;
      const to = addMonth(from);
      await tx.billingPayment.update({ where: { id: order.id }, data: { periodFrom: from, periodTo: to } });
      await tx.network.update({ where: { id: networkId }, data: { billingStatus: 'ACTIVE', paidUntil: to, periodStartsAt: now, ...(setupMinor && !n.setupPaidAt ? { setupPaidAt: now } : {}) } });
      const branches = await tx.clinic.findMany({ where: { networkId, id: { in: order.branchIds } }, select: { id: true, limitOverrides: true }, orderBy: { id: 'asc' } });
      for (const branch of branches) {
        await tx.clinic.update({ where: { id: branch.id }, data: { plan: 'NETWORK', billingStatus: 'ACTIVE', paidUntil: to, periodStartsAt: now, aiMonthlyLimit: effectiveLimits('NETWORK', branch.limitOverrides).aiRepliesPerMonth } });
      }
      const exceptions: string[] = [];
      if (setupMinor && n.setupPaidAt) exceptions.push('setup_duplicate');
      if (branches.length !== order.branchIds.length) exceptions.push('scope_changed');
      return exceptions;
    }
    if (kind !== 'SUBSCRIPTION') throw new Error('invalid_billing_purchase');
    if (order.oneTimeProBuyerId && await this.oneTimeProConsumed(tx, clinicId, order.id)) return ['one_time_pro_duplicate'];
    const c = await tx.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { paidUntil: true, networkId: true, limitOverrides: true, setupPaidAt: true } });
    if (c.networkId) return ['scope_changed'];
    const plan = order.plan ?? 'START';
    const from = c.paidUntil && c.paidUntil > now ? c.paidUntil : now;
    const to = addMonth(from);
    await tx.billingPayment.update({ where: { id: order.id }, data: { periodFrom: from, periodTo: to } });
    await tx.clinic.update({
      where: { id: clinicId },
      data: { plan, billingStatus: 'ACTIVE', paidUntil: to, periodStartsAt: now, aiMonthlyLimit: effectiveLimits(plan, c.limitOverrides).aiRepliesPerMonth,
        ...((setupMinor || order.oneTimeProIncludesSetup) && !c.setupPaidAt ? { setupPaidAt: now } : {}) },
    });
    return setupMinor && c.setupPaidAt ? ['setup_duplicate'] : [];
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
      if (step !== 'SOON' && c.billingStatus !== step) {
        const changed = await this.prisma.clinic.updateMany({ where: { id: c.id, paidUntil: until, billingStatus: c.billingStatus }, data: { billingStatus: step } });
        if (!changed.count) continue;
      }
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
    const payments = await this.prisma.billingPayment.findMany({ where: { networkId }, orderBy: { createdAt: 'desc' }, take: 20, select: { ...paymentDetails, clinicId: true } });
    // What the next payment does, shown before paying. The owner's rule (approved 2026-11-16, no proration): to add a branch during a paid period the
    // owner PREPAYS the next network period at the price including it; once that payment is confirmed the new branch gets access at once, and its
    // access until that period starts is complimentary. The payment charges the monthly amount for ALL current branches (plus the first onboarding
    // once); it buys the month starting at the end of the paid period (today when nothing is paid or the period has ended); the renewal after it is
    // the same monthly amount for the same branches. A further branch's onboarding is a separate payment (branchSetups). One period is bought once:
    // when the next period is already prepaid, or a payment window was opened minutes ago, no new purchase is offered.
    const now = new Date();
    const from = n.paidUntil && n.paidUntil > now ? n.paidUntil : now;
    const pending = await this.prisma.billingPayment.findFirst({ where: { networkId, ...monoPending }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    const networkPending = await this.prisma.billingPayment.count({ where: { networkId, kind: 'NETWORK', ...monoPending } });
    const block = this.networkAlreadyPrepaid(n.paidUntil, now) ? 'next_period_paid' : networkPending ? 'payment_pending' : null;
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
      configured: this.mono.configured,
      pendingPaymentId: pending?.id ?? null,
      nextPayment,
      status: n.billingStatus,
      paidUntil: n.paidUntil,
      graceUntil: n.paidUntil ? new Date(n.paidUntil.getTime() + GRACE_DAYS * DAY) : null,
      branches: n.clinics.length,
      monthlyUah: networkMonthlyUah(n.clinics.length),
      setupUah: n.setupPaidAt ? null : SETUP_FEE_UAH,
      // a further branch's onboarding: only an amount the service owner quoted for it can be paid
      branchSetups: n.clinics.filter((c) => c.branchSetupQuoteUah && !c.branchSetupPaidAt).map((c) => ({ clinicId: c.id, name: c.name, quoteUah: c.branchSetupQuoteUah })),
      payments,
    };
  }

  networkCheckout(networkId: string, now = new Date()) {
    return this.purchase({ networkId }, 'NETWORK', now, async (tx) => {
      const n = await tx.network.findUniqueOrThrow({ where: { id: networkId }, select: { name: true, setupPaidAt: true, paidUntil: true, clinics: { select: { id: true }, orderBy: { createdAt: 'asc' } } } });
      if (!n.clinics.length) throw new BadRequestException('network_no_branches');
      if (this.networkAlreadyPrepaid(n.paidUntil, now)) throw new BadRequestException('network_next_period_paid');
      const periodFrom = n.paidUntil && n.paidUntil > now ? n.paidUntil : now;
      const setupMinor = n.setupPaidAt ? 0 : SETUP_FEE_UAH * 100;
      const amountMinor = networkMonthlyUah(n.clinics.length) * 100 + setupMinor;
      return {
        order: { clinicId: n.clinics[0].id, networkId, kind: 'NETWORK', plan: 'NETWORK', amountMinor, setupMinor, periodFrom, periodTo: addMonth(periodFrom), branchIds: n.clinics.map((c) => c.id) },
        description: `LANKA: мережа «${n.name}», ${n.clinics.length} філ.`,
      };
    });
  }

  // A network may prepay its next period once.
  private networkAlreadyPrepaid(paidUntil: Date | null, now: Date) {
    return !!paidUntil && paidUntil.getTime() > addMonth(now).getTime() + 60_000;
  }

  branchSetupCheckout(networkId: string, clinicId: string, now = new Date()) {
    return this.purchase({ networkId, clinicId }, 'BRANCH_SETUP', now, async (tx) => {
      const c = await tx.clinic.findFirst({ where: { id: clinicId, networkId }, select: { name: true, branchSetupQuoteUah: true, branchSetupPaidAt: true } });
      if (!c) throw new BadRequestException('branch_not_found');
      if (!c.branchSetupQuoteUah || c.branchSetupQuoteUah < BRANCH_SETUP_MIN_UAH) throw new BadRequestException('branch_setup_not_quoted');
      if (c.branchSetupPaidAt) throw new BadRequestException('branch_setup_paid');
      const amountMinor = c.branchSetupQuoteUah * 100;
      return {
        order: { clinicId, networkId, kind: 'BRANCH_SETUP', amountMinor, setupMinor: amountMinor },
        description: `LANKA: підключення філіалу «${c.name}»`,
      };
    });
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
        const changed = await this.prisma.$transaction(async (tx) => {
          const network = await tx.network.updateMany({ where: { id: n.id, paidUntil: until, billingStatus: n.billingStatus }, data: { billingStatus: step } });
          if (network.count) await tx.clinic.updateMany({ where: { networkId: n.id, plan: 'NETWORK' }, data: { billingStatus: step } });
          return network.count;
        });
        if (!changed) continue;
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
