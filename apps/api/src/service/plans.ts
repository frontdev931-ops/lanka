// Tariffs: what a clinic may use and what it pays. There is no free period: a clinic first sees a demo, real data opens after payment.
export interface Limits {
  users: number;
  messagesPerMonth: number;
  aiRepliesPerMonth: number;
}

// Things a plan may or may not include. The server checks them where the feature is used.
// ai_assistant: the manager's assistant (questions about the clinic's data, AI-built report specs). patient_agent: the right to turn on the autonomous
// patient agent (the clinic's owner still has to set it up and switch it on; the plan alone turns nothing on).
export type Feature = 'ai_autoreply' | 'multi_channel' | 'advanced_analytics' | 'daily_digest' | 'ai_assistant' | 'patient_agent';

export const PLANS: Record<string, { label: string; limits: Limits; priceUah: number; features: Feature[] }> = {
  START: { label: 'Start', limits: { users: 5, messagesPerMonth: 2000, aiRepliesPerMonth: 500 }, priceUah: 1990, features: [] },
  PRO: { label: 'Pro', limits: { users: 30, messagesPerMonth: 10_000, aiRepliesPerMonth: 3000 }, priceUah: 3990, features: ['ai_autoreply', 'multi_channel', 'advanced_analytics', 'daily_digest', 'ai_assistant', 'patient_agent'] },
  // A branch of a paid network: the Pro capabilities and Pro allowances, per branch (no shared pool); paid by the network (NETWORK_PRICE below)
  NETWORK: { label: 'Network', limits: { users: 30, messagesPerMonth: 10_000, aiRepliesPerMonth: 3000 }, priceUah: 0, features: ['ai_autoreply', 'multi_channel', 'advanced_analytics', 'daily_digest', 'ai_assistant', 'patient_agent'] },
  // Individual terms: only the overrides apply (a missing one falls back to the Pro level); everything is included
  CUSTOM: { label: 'Custom', limits: { users: 30, messagesPerMonth: 10_000, aiRepliesPerMonth: 3000 }, priceUah: 0, features: ['ai_autoreply', 'multi_channel', 'advanced_analytics', 'daily_digest', 'ai_assistant', 'patient_agent'] },
};

export const PLAN_KEYS = Object.keys(PLANS);
// Plans a clinic can buy by itself
export const SELLABLE_PLANS = ['START', 'PRO'];

// The one-time standard onboarding of a clinic, a fixed sum in hryvnias (paid with the first month)
export const SETUP_FEE_UAH = 4990;
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

// Where the current allowance period starts: the last payment, or the calendar month for clinics without one (manual or older clinics)
export const periodStart = (c: { periodStartsAt: Date | null }, now = new Date()) => c.periodStartsAt ?? monthStart(now);

// Billing is enforced in production, and in tests that switch it on
export const billingEnforced = () => (process.env.BILLING_ENFORCED ? process.env.BILLING_ENFORCED === 'true' : process.env.NODE_ENV === 'production');

// A clinic is locked out of real data before the first payment and after the grace days. Demo clinics (isDemo) are never locked.
export function accessBlocked(c: { billingStatus: string; paidUntil: Date | null; isDemo?: boolean }, now = new Date()): boolean {
  if (c.isDemo) return false;
  if (c.billingStatus === 'AWAITING_PAYMENT' || c.billingStatus === 'LAPSED') return true;
  return !!c.paidUntil && c.paidUntil.getTime() + GRACE_DAYS * 86_400_000 < now.getTime();
}
