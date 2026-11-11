import { PrismaService } from '../prisma/prisma.service';

// Appointment reminders against the appointment as it is NOW. A reminder belongs to one revision of a visit: its id, its start time (the end of the queued
// message's dedupe key; for a row made before the key held it, the message's expiresAt, which was set to the visit's start) and an active status. A visit that moved (through LANKA, or a new time learned by the
// sync) or was cancelled makes its waiting reminders stale: they are cancelled through the queue, never sent with the old date and time; the scheduler
// makes the reminder of the new time at its normal moment (the dedupe key holds the start time, so one reminder per revision and offset).
// LANKA sees a change only after it happened through LANKA or after a sync read it: a change made in Cliniccards since the last sync is not known here.

const ACTIVE = ['PLANNED', 'CONFIRMED', 'NOT_CONFIRMED'];
const WAITING = ['PENDING_APPROVAL', 'APPROVED'];
// the audit actions that record a change of a visit's time, with the moment LANKA made or saw it: a move through LANKA, a new time seen by the sync
export const TIME_CHANGE_ACTIONS = ['booking.rescheduled', 'visit.time_changed'];

export const reminderKey = (visitId: string, hours: number, startsAt: Date) => `visit-reminder:${visitId}:${hours}:${startsAt.toISOString()}`;

// Is this queued message a reminder of a visit's time (the built-in one, or a clinic's own "before the visit" automation)?
async function beforeVisitRules(prisma: PrismaService, clinicId: string, ruleKeys: string[]): Promise<Set<string>> {
  const ids = [...new Set(ruleKeys.filter((k) => k.startsWith('auto:')).map((k) => k.slice(5)))];
  if (!ids.length) return new Set();
  const rows = await prisma.automation.findMany({ where: { clinicId, id: { in: ids } }, select: { id: true, trigger: true } });
  return new Set(rows.filter((r) => (r.trigger as { type?: string } | null)?.type === 'VISIT_BEFORE').map((r) => `auto:${r.id}`));
}

// The start time a queued reminder was made for
export function madeFor(m: { dedupeKey: string; expiresAt: Date | null }): Date | null {
  const iso = /:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(m.dedupeKey)?.[1];
  return iso ? new Date(iso) : m.expiresAt;
}

// The reminder's visit is not the one it was made for any more: gone, not active, or at another time
export function reminderStale(v: { status: string; startsAt: Date } | null | undefined, m: { dedupeKey: string; expiresAt: Date | null }): boolean {
  const at = madeFor(m);
  return !v || !ACTIVE.includes(v.status) || !at || v.startsAt.getTime() !== at.getTime();
}

// Cancels the waiting reminders of the clinic (or of these visits) whose visit moved, was cancelled or is gone. Returns how many were cancelled.
export async function cancelStaleReminders(prisma: PrismaService, clinicId: string, visitIds?: string[]): Promise<number> {
  const rows = await prisma.outboundMessage.findMany({
    where: { clinicId, status: { in: WAITING }, visitId: visitIds ? { in: visitIds } : { not: null }, OR: [{ ruleKey: 'visit-reminder' }, { ruleKey: { startsWith: 'auto:' } }] },
    select: { id: true, visitId: true, expiresAt: true, ruleKey: true, dedupeKey: true },
  });
  if (!rows.length) return 0;
  const before = await beforeVisitRules(prisma, clinicId, rows.map((r) => r.ruleKey));
  const mine = rows.filter((r) => r.ruleKey === 'visit-reminder' || before.has(r.ruleKey));
  const visits = new Map((await prisma.visit.findMany({ where: { clinicId, id: { in: mine.map((r) => r.visitId!) } }, select: { id: true, status: true, startsAt: true } })).map((v) => [v.id, v]));
  const stale = mine.filter((r) => reminderStale(visits.get(r.visitId!), r)).map((r) => r.id);
  if (!stale.length) return 0;
  const res = await prisma.outboundMessage.updateMany({ where: { id: { in: stale }, status: { in: WAITING } }, data: { status: 'CANCELLED', error: 'Час запису змінено або запис скасовано' } });
  return res.count;
}

// When LANKA last made or saw a change of each visit's time (by the visit's external id): a reminder whose moment was before that is not made for the new time
// (as for a visit booked after the reminder's moment: no reminder only because the time changed)
export async function timeChangedAt(prisma: PrismaService, clinicId: string, externalIds: string[], since: Date): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!externalIds.length) return out;
  const want = new Set(externalIds);
  const rows = await prisma.auditLog.findMany({ where: { clinicId, action: { in: TIME_CHANGE_ACTIONS }, createdAt: { gte: since } }, select: { details: true, createdAt: true } });
  for (const r of rows) {
    const visit = (r.details as { visit?: unknown } | null)?.visit;
    if (typeof visit !== 'string' || !want.has(visit)) continue;
    const prev = out.get(visit);
    if (!prev || prev < r.createdAt) out.set(visit, r.createdAt);
  }
  return out;
}
