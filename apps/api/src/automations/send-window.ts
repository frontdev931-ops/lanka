import { clinicDate, clinicHm, localToUtc } from '../common/clinic-time';

// The hours of the day the queue sends in (the clinic's time zone): at night messages wait for the morning
export const SEND_FROM = '08:00';
export const SEND_TO = '22:00';

export const inSendWindow = (at: Date) => {
  const hm = clinicHm(at);
  return hm >= SEND_FROM && hm < SEND_TO;
};

// The earliest moment a message queued at `at` can go out: now, or the next morning's start of the sending hours
export function nextSendMoment(at: Date): Date {
  if (inSendWindow(at)) return at;
  const today = localToUtc(`${clinicDate(at)} ${SEND_FROM}:00`);
  return today.getTime() > at.getTime() ? today : new Date(localToUtc(`${clinicDate(new Date(at.getTime() + 12 * 3_600_000))} ${SEND_FROM}:00`).getTime());
}
