import { PrismaService } from '../prisma/prisma.service';

// Visits moved to another time THROUGH LANKA (the staff action or the agent), as the audit records them: one `booking.rescheduled` entry per confirmed move, its
// `details.attempt` the BookingAttempt of that one operation (agent-administrator.md section 47). The ONE counting rule for the report and the digest:
//   - an operation is a distinct attempt id of the clinic; repeated entries of one attempt are one operation dated by its EARLIEST entry, decided over all
//     entries before the period ends, so a duplicate can never count in another period;
//   - entries without an attempt id (written before 2026-11-11) are not operations: they are counted apart as legacy entries, never merged by visit or time;
//   - `visit.time_changed` (a new time seen by the sync) is not a LANKA operation and is not read here;
//   - the visit's current row is not needed: a move stays counted when the visit is gone from LANKA's copy.
// This is NOT the Cliniccards MOVED status: that one is a status of visits by their appointment date; this one counts actions by their date.

export interface LankaMove {
  attempt: string;
  // the earliest recorded success of the operation
  at: Date;
  visit: string | null;
  from: Date | null;
  to: Date | null;
  // who made it, only when it was recorded: the agent, a staff member (userId), or not known
  actor: 'agent' | 'staff' | 'unknown';
  userId: string | null;
}

export interface LankaMoves {
  operations: LankaMove[];
  // distinct visits of those operations (by the visit's Cliniccards id)
  visits: number;
  // booking.rescheduled entries in the period that carry no operation identity
  legacy: number;
}

const iso = (v: unknown): Date | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);

// Operations whose earliest entry is in [from, to)
export async function lankaMoves(prisma: PrismaService, clinicId: string, from: Date, to: Date): Promise<LankaMoves> {
  const rows = await prisma.auditLog.findMany({ where: { clinicId, action: 'booking.rescheduled', createdAt: { lt: to } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { userId: true, details: true, createdAt: true } });
  const first = new Map<string, LankaMove>();
  let legacy = 0;
  for (const r of rows) {
    const d = (r.details ?? {}) as Record<string, unknown>;
    const attempt = typeof d.attempt === 'string' && d.attempt ? d.attempt : null;
    if (!attempt) {
      if (r.createdAt >= from) legacy++;
      continue;
    }
    if (first.has(attempt)) continue;
    first.set(attempt, {
      attempt,
      at: r.createdAt,
      visit: typeof d.visit === 'string' ? d.visit : null,
      from: iso(d.from),
      to: iso(d.to),
      actor: d.by === 'agent' ? 'agent' : r.userId ? 'staff' : 'unknown',
      userId: r.userId,
    });
  }
  const operations = [...first.values()].filter((m) => m.at >= from && m.at < to);
  return { operations, visits: new Set(operations.map((m) => m.visit ?? `?${m.attempt}`)).size, legacy };
}
