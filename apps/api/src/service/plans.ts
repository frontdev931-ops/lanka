// Tariffs: what a clinic may use and what it pays. There is no free period: a clinic first sees a demo, real data opens after payment.
export interface Limits {
  users: number;
  messagesPerMonth: number;
  aiRepliesPerMonth: number;
}

// Things a plan may or may not include. The server checks them where the feature is used.
// ai_assistant: the manager's assistant (questions about the clinic's data, AI-built report specs). patient_agent: the right to turn on the autonomous
// patient agent (the clinic's owner still has to set it up and switch it on; the plan alone turns nothing on).
// The plan split of 2026-11-23: Start has the AI administrator replying on its own in every channel (ai_autoreply, multi_channel, patient_agent);
// Pro adds the AI's own writes to Cliniccards (auto_booking: booking, rescheduling and cancelling without a staff member), the manager's assistant,
// signals and the daily digest. A staff member's one-click booking from a request is not an AI write and stays on every plan.
export type Feature = 'ai_autoreply' | 'multi_channel' | 'advanced_analytics' | 'daily_digest' | 'ai_assistant' | 'patient_agent' | 'auto_booking';

export const PLANS: Record<string, { label: string; limits: Limits; priceUah: number; features: Feature[] }> = {
  START: { label: 'Start', limits: { users: 5, messagesPerMonth: 2000, aiRepliesPerMonth: 500 }, priceUah: 1990, features: ['ai_autoreply', 'multi_channel', 'patient_agent'] },
  PRO: { label: 'Pro', limits: { users: 30, messagesPerMonth: 10_000, aiRepliesPerMonth: 3000 }, priceUah: 4990, features: ['ai_autoreply', 'multi_channel', 'advanced_analytics', 'daily_digest', 'ai_assistant', 'patient_agent', 'auto_booking'] },
  // A branch of a paid network: the Pro capabilities and Pro allowances, per branch (no shared pool); paid by the network (NETWORK_PRICE below)
  NETWORK: { label: 'Network', limits: { users: 30, messagesPerMonth: 10_000, aiRepliesPerMonth: 3000 }, priceUah: 0, features: ['ai_autoreply', 'multi_channel', 'advanced_analytics', 'daily_digest', 'ai_assistant', 'patient_agent', 'auto_booking'] },
  // Individual terms: only the overrides apply (a missing one falls back to the Pro level); everything is included
  CUSTOM: { label: 'Custom', limits: { users: 30, messagesPerMonth: 10_000, aiRepliesPerMonth: 3000 }, priceUah: 0, features: ['ai_autoreply', 'multi_channel', 'advanced_analytics', 'daily_digest', 'ai_assistant', 'patient_agent', 'auto_booking'] },
};

export const PLAN_KEYS = Object.keys(PLANS);
// Plans a clinic can buy by itself
export const SELLABLE_PLANS = ['START', 'PRO'];

// The one-time standard onboarding of a NETWORK (its first branch), a fixed sum in hryvnias (paid with the first network month)
export const SETUP_FEE_UAH = 4990;
// The one-time assisted launch of a single clinic (2026-11-19, corrected the same day: one fee for both plans), paid with the first month and
// charged once per clinic (Clinic.setupPaidAt): 4 990 UAH. Start: Cliniccards, Telegram and reminders, agreed website forms, one team session;
// Pro also the standard agent setup within the agreed scope (knowledge, the plan's channels, handoff and scenario checks, the digest and
// signals). A plan change after the launch never charges it again. Custom integrations and development are quoted separately.
export const LAUNCH_FEE_UAH: Record<string, number> = { START: 4990, PRO: 4990 };
export const launchFeeUah = (plan: string) => LAUNCH_FEE_UAH[plan] ?? LAUNCH_FEE_UAH.START;
// The monthly price a clinic pays for a plan: the price stored when it paid for that plan (Clinic.renewalPlan/renewalPriceUah; clinics that
// paid before 2026-11-19 keep the price list of that time, set by the migration), otherwise the current list price. Never by name or email.
export const monthlyPriceUah = (c: { renewalPlan: string | null; renewalPriceUah: number | null }, plan: string) =>
  c.renewalPlan === plan && c.renewalPriceUah ? c.renewalPriceUah : PLANS[plan].priceUah;
// Billing terms of a single clinic (2026-11-19): monthly, or one upfront annual payment = 12 calendar months for 10 monthly prices (no
// automatic recurring charge). The annual price is derived from the clinic's applicable monthly price, so a stored price carries over
// (Pro at 3 990 → 39 900 a year). The launch is never discounted. Usage limits stay monthly (periodStart below rolls month by month).
export const BILLING_TERMS: Record<number, { months: number; paidMonths: number }> = { 1: { months: 1, paidMonths: 1 }, 12: { months: 12, paidMonths: 10 } };
export const TERM_MONTHS = [1, 12];
export const termPriceUah = (monthlyUah: number, months: number) => monthlyUah * BILLING_TERMS[months].paidMonths;

// Calendar months: the same day of the month, or the last day of a shorter month (31 Jan + 1 = 28/29 Feb; 29 Feb 2028 + 12 = 28 Feb 2029);
// the time of day is kept. Used for every paid period.
export function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const r = new Date(d);
  r.setUTCDate(1);
  r.setUTCFullYear(y, m, Math.min(d.getUTCDate(), last));
  return r;
}
// The network offer (2026-11-16): 7 990 UAH a month includes two branches, each further branch 2 990 UAH a month; the first onboarding is the standard
// one (SETUP_FEE_UAH); a further comparable branch's onboarding is quoted individually, from BRANCH_SETUP_MIN_UAH (never charged without a quote)
export const NETWORK_PRICE = { baseUah: 7990, includedBranches: 2, extraBranchUah: 2990 };
export const BRANCH_SETUP_MIN_UAH = 2990;
export const networkMonthlyUah = (branches: number) => NETWORK_PRICE.baseUah + Math.max(0, branches - NETWORK_PRICE.includedBranches) * NETWORK_PRICE.extraBranchUah;
// One pack of extra AI replies
export const AI_PACK = { replies: 500, priceUah: 390 };
// After the paid month ends the clinic keeps access this many days, then real data is closed (kept, not deleted)
export const GRACE_DAYS = 5;

export const hasFeature = (plan: string, feature: Feature) => (PLANS[plan] ?? PLANS.START).features.includes(feature);

// The plan's limits with the clinic's own overrides on top
export function effectiveLimits(plan: string, overrides: unknown): Limits {
  const base = (PLANS[plan] ?? PLANS.START).limits;
  const o = (overrides && typeof overrides === 'object' ? overrides : {}) as Partial<Limits>;
  const pick = (k: keyof Limits) => (Number.isInteger(o[k]) && (o[k] as number) >= 0 ? (o[k] as number) : base[k]);
  return { users: pick('users'), messagesPerMonth: pick('messagesPerMonth'), aiRepliesPerMonth: pick('aiRepliesPerMonth') };
}

export const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

// Where the current allowance period starts: the last payment, or the calendar month for clinics without one (manual or older clinics).
// The allowance is monthly: from the payment it rolls on by calendar months (an annual payment gives twelve monthly allowances, not a pool).
export function periodStart(c: { periodStartsAt: Date | null }, now = new Date()): Date {
  if (!c.periodStartsAt) return monthStart(now);
  if (c.periodStartsAt > now) return c.periodStartsAt;
  let k = (now.getUTCFullYear() - c.periodStartsAt.getUTCFullYear()) * 12 + now.getUTCMonth() - c.periodStartsAt.getUTCMonth();
  while (k > 0 && addMonths(c.periodStartsAt, k) > now) k--;
  return addMonths(c.periodStartsAt, Math.max(0, k));
}

// Billing is enforced in production, and in tests that switch it on
export const billingEnforced = () => (process.env.BILLING_ENFORCED ? process.env.BILLING_ENFORCED === 'true' : process.env.NODE_ENV === 'production');

// LAUNCH_PENDING: the first payment (plan + one month + launch) is confirmed, the launch is being prepared. The clinic may set itself up, but the
// paid month has not started and nothing goes out to patients until the service owner starts it (POST /platform/clinics/:id/launch).
export const launchPending = (c: { billingStatus: string }) => c.billingStatus === 'LAUNCH_PENDING';

// A clinic is locked out of real data before the first payment and after the grace days. Demo clinics (isDemo) are never locked.
export function accessBlocked(c: { billingStatus: string; paidUntil: Date | null; isDemo?: boolean }, now = new Date()): boolean {
  if (c.isDemo) return false;
  if (c.billingStatus === 'AWAITING_PAYMENT' || c.billingStatus === 'LAPSED') return true;
  return !!c.paidUntil && c.paidUntil.getTime() + GRACE_DAYS * 86_400_000 < now.getTime();
}
