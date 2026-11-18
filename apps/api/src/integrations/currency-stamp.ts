import { PrismaService } from '../prisma/prisma.service';

// What the owner states, in two separate scopes (Cliniccards sends no currency for any of them; common/money.ts):
//   finance: payments, invoices and the patients' card balances  -> Clinic.sourceCurrency
//   plans:   treatment-plan totals                                -> Clinic.planCurrency
// A scope not stated keeps its amounts "currency not confirmed". Plan item prices and visit amounts are never stamped.
export type CurrencyScope = 'finance' | 'plans';
export const CURRENCY_SCOPES: CurrencyScope[] = ['finance', 'plans'];

// Stamps the stated currency on the loaded amounts of a scope that have none yet. A stamp that is already there is never changed here: a later
// statement of another currency applies only to amounts loaded from then on. `correct` = the owner says the earlier statement of that scope was a
// mistake: then every amount of that scope gets the new code (an explicit, logged action).
export async function stampCurrency(prisma: PrismaService, clinicId: string, opts: { correct?: boolean; scope?: CurrencyScope } = {}) {
  const c = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { sourceCurrency: true, planCurrency: true } });
  if (!c) return 0;
  let n = 0;
  if (c.sourceCurrency && opts.scope !== 'plans') {
    const code = c.sourceCurrency;
    const only = opts.correct ? {} : { currency: null };
    const [a, b, d] = await prisma.$transaction([
      prisma.payment.updateMany({ where: { clinicId, ...only }, data: { currency: code } }),
      prisma.invoice.updateMany({ where: { clinicId, ...only }, data: { currency: code } }),
      prisma.patient.updateMany({ where: { clinicId, ...(opts.correct ? {} : { balanceCurrency: null }) }, data: { balanceCurrency: code } }),
    ]);
    n += a.count + b.count + d.count;
  }
  if (c.planCurrency && opts.scope !== 'finance') {
    n += (await prisma.treatmentPlan.updateMany({ where: { clinicId, ...(opts.correct ? {} : { currency: null }) }, data: { currency: c.planCurrency } })).count;
  }
  return n;
}
