import { clinicDate, clinicHm } from '../common/clinic-time';
import { PrismaService } from '../prisma/prisma.service';

// What the SYSTEM knows about the booking of this dialogue, read from the booking request (never concluded from the text of the history): a visit that the system
// created and confirmed (the service, the date, the time; NO contacts of the patient), or a creation whose result is still unknown. A booking whose time is more than
// 12 hours past is history, not the booking of this talk. Used for the model's state lines and for the answers of the code after a booking.
// The visit itself decides whether that booking still stands: CANCELLED (by the agent's cancellation or seen by the sync) is said as cancelled, a visit moved or
// missed in Cliniccards is not called confirmed, and a cancellation whose result is unknown is neither "cancelled" nor "still booked".
export type BookingStatus = { kind: 'CONFIRMED' | 'CANCELLED'; service: string | null; date: string; time: string } | { kind: 'UNKNOWN'; cancel?: boolean; move?: boolean } | null;

// a visit in these statuses can still be cancelled (the same list BookingService accepts)
export const CANCELLABLE = ['PLANNED', 'CONFIRMED', 'NOT_CONFIRMED', 'BOOKING'];

const dmy = (at: Date) => {
  const d = clinicDate(at);
  return `${d.slice(8)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
};

export async function bookingStatusOf(prisma: PrismaService, clinicId: string, channel: string, chatId: string): Promise<BookingStatus> {
  const confirmed = await prisma.bookingRequest.findFirst({
    where: { clinicId, channel, chatId, kind: 'BOOKING', status: 'DONE', confirmedAt: { not: null }, externalVisitId: { not: null }, confirmedStartsAt: { gt: new Date(Date.now() - 12 * 3_600_000) } },
    orderBy: { confirmedAt: 'desc' },
    select: { confirmedService: true, service: true, confirmedStartsAt: true, externalVisitId: true },
  });
  const open = await prisma.bookingRequest.findFirst({ where: { clinicId, channel, chatId, kind: 'BOOKING', status: 'NEW' }, orderBy: { createdAt: 'desc' }, select: { autoState: true, confirmedAt: true } });
  // a booking that is being made again, or one whose result is unknown, is never called successful
  if (open && !open.confirmedAt && (open.autoState === 'UNKNOWN' || open.autoState === 'RUNNING')) return { kind: 'UNKNOWN' };
  if (confirmed?.confirmedStartsAt && !open) {
    const at = { service: confirmed.confirmedService ?? confirmed.service, date: dmy(confirmed.confirmedStartsAt), time: clinicHm(confirmed.confirmedStartsAt) };
    const visit = await prisma.visit.findFirst({ where: { clinicId, externalId: confirmed.externalVisitId! }, select: { status: true } });
    if (visit?.status === 'CANCELLED') return { kind: 'CANCELLED', ...at };
    // the agent's cancellation or move of this dialogue is under way or its result is not known: nothing is claimed either way (neither time for a move)
    const changing = await prisma.agentDraft.findFirst({ where: { clinicId, channel, chatId, choice: { in: ['CANCEL_VISIT', 'MOVE_VISIT'] }, status: { in: ['APPROVING', 'UNKNOWN'] } }, orderBy: { createdAt: 'desc' }, select: { choice: true } });
    if (changing) return changing.choice === 'MOVE_VISIT' ? { kind: 'UNKNOWN', move: true } : { kind: 'UNKNOWN', cancel: true };
    if (visit && (visit.status === 'MOVED' || visit.status === 'DID_NOT_COME')) return null;
    return { kind: 'CONFIRMED', ...at };
  }
  return null;
}

export interface ConversationVisit {
  requestId: string;
  visitId: string;
  externalVisitId: string;
  startsAt: Date;
  doctorId: string | null;
  doctor: string | null;
  service: string | null;
  status: string;
  // the visit's length (a move keeps it)
  minutes: number;
  date: string;
  time: string;
}

// The future visits the agent may ask about, cancel or move in THIS dialogue: the ones this dialogue created (a booking request of the chat that the system
// confirmed, with the id of the visit it wrote: BookingRequest → externalVisitId) and, since 2026-11-16, every future visit of the patient whose card the chat
// is linked to (below). Our copy of the visit must still be cancellable. Nothing here is found by a name or a phone.
export async function conversationVisits(prisma: PrismaService, clinicId: string, channel: string, chatId: string): Promise<ConversationVisit[]> {
  const reqs = await prisma.bookingRequest.findMany({
    where: { clinicId, channel, chatId, kind: 'BOOKING', status: 'DONE', confirmedAt: { not: null }, externalVisitId: { not: null } },
    orderBy: { confirmedAt: 'desc' },
    select: { id: true, externalVisitId: true, confirmedService: true, service: true, confirmedDoctor: true },
  });
  const out: ConversationVisit[] = [];
  for (const r of reqs) {
    const v = await prisma.visit.findFirst({ where: { clinicId, externalId: r.externalVisitId!, startsAt: { gt: new Date() }, status: { in: CANCELLABLE } }, select: { id: true, externalId: true, startsAt: true, endsAt: true, doctorId: true, doctorName: true, status: true } });
    if (!v || out.some((x) => x.visitId === v.id)) continue;
    out.push({ requestId: r.id, visitId: v.id, externalVisitId: v.externalId, startsAt: v.startsAt, doctorId: v.doctorId ?? null, doctor: r.confirmedDoctor ?? null, service: r.confirmedService ?? r.service, status: v.status, minutes: Math.round(((v.endsAt ?? new Date(v.startsAt.getTime() + 30 * 60_000)).getTime() - v.startsAt.getTime()) / 60_000), date: dmy(v.startsAt), time: clinicHm(v.startsAt) });
  }
  // The owner's decision of 2026-11-16: also every other future visit of the patient whose card THIS chat is linked to (a one-time link from the card, the
  // patient's own shared phone number in Telegram, or a staff member's link in the inbox; never a match by a name or a phone typed in the chat).
  // Their anchor (requestId) is the visit's own id: no booking request is needed to ask about, cancel or move them.
  // Not for the website chat (2026-11-17): its visitor is anonymous and its session is a browser token, not a verified identity, so even a chat a staff
  // member linked to a card gets no access to that patient's other visits (only the visits this very dialogue booked)
  const linked = channel === 'WEB' ? [] : await prisma.patientChannel.findMany({ where: { clinicId, channel, externalId: chatId, optedOutAt: null }, select: { patientId: true } });
  if (linked.length) {
    const visits = await prisma.visit.findMany({
      where: { clinicId, patientId: { in: linked.map((l) => l.patientId) }, startsAt: { gt: new Date() }, status: { in: CANCELLABLE }, patient: { removedAt: null } },
      orderBy: { startsAt: 'asc' },
      select: { id: true, externalId: true, startsAt: true, endsAt: true, doctorId: true, doctorName: true, serviceName: true, status: true },
    });
    for (const v of visits) {
      if (out.some((x) => x.visitId === v.id)) continue;
      out.push({ requestId: v.id, visitId: v.id, externalVisitId: v.externalId, startsAt: v.startsAt, doctorId: v.doctorId ?? null, doctor: v.doctorName ?? null, service: v.serviceName ?? null, status: v.status, minutes: Math.round(((v.endsAt ?? new Date(v.startsAt.getTime() + 30 * 60_000)).getTime() - v.startsAt.getTime()) / 60_000), date: dmy(v.startsAt), time: clinicHm(v.startsAt) });
    }
  }
  return out;
}
