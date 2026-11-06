import { clinicDate, clinicHm } from '../common/clinic-time';
import { PrismaService } from '../prisma/prisma.service';

// What the SYSTEM knows about the booking of this dialogue, read from the booking request (never concluded from the text of the history): a visit that the system
// created and confirmed (the service, the date, the time; NO contacts of the patient), or a creation whose result is still unknown. A booking whose time is more than
// 12 hours past is history, not the booking of this talk. Used for the model's state lines and for the answers of the code after a booking.
export type BookingStatus = { kind: 'CONFIRMED'; service: string | null; date: string; time: string } | { kind: 'UNKNOWN' } | null;

export async function bookingStatusOf(prisma: PrismaService, clinicId: string, channel: string, chatId: string): Promise<BookingStatus> {
  const confirmed = await prisma.bookingRequest.findFirst({
    where: { clinicId, channel, chatId, kind: 'BOOKING', status: 'DONE', confirmedAt: { not: null }, externalVisitId: { not: null }, confirmedStartsAt: { gt: new Date(Date.now() - 12 * 3_600_000) } },
    orderBy: { confirmedAt: 'desc' },
    select: { confirmedService: true, service: true, confirmedStartsAt: true },
  });
  const open = await prisma.bookingRequest.findFirst({ where: { clinicId, channel, chatId, kind: 'BOOKING', status: 'NEW' }, orderBy: { createdAt: 'desc' }, select: { autoState: true, confirmedAt: true } });
  // a booking that is being made again, or one whose result is unknown, is never called successful
  if (open && !open.confirmedAt && (open.autoState === 'UNKNOWN' || open.autoState === 'RUNNING')) return { kind: 'UNKNOWN' };
  if (confirmed?.confirmedStartsAt && !open) {
    const d = clinicDate(confirmed.confirmedStartsAt);
    return { kind: 'CONFIRMED', service: confirmed.confirmedService ?? confirmed.service, date: `${d.slice(8)}.${d.slice(5, 7)}.${d.slice(0, 4)}`, time: clinicHm(confirmed.confirmedStartsAt) };
  }
  return null;
}
