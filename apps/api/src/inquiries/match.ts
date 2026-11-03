import { PrismaService } from '../prisma/prisma.service';

// Links inquiries to cards by phone. A card created on the day of the inquiry or later (with two days of slack)
// means "the inquiry became a patient". If a card with this phone existed long ago, this is a returning patient: it stays
// linked, but in the acquisition funnel it is not counted as new.
export async function matchInquiries(prisma: PrismaService, clinicId: string) {
  const open = await prisma.inquiry.findMany({ where: { clinicId, patientId: null, phoneNorm: { not: null } } });
  if (!open.length) return 0;
  const phones = [...new Set(open.map((i) => i.phoneNorm!))];
  const patients = await prisma.patient.findMany({
    where: { clinicId, removedAt: null, phoneNorm: { in: phones } },
    select: { id: true, phoneNorm: true, createdAtExt: true },
    orderBy: { createdAtExt: 'asc' },
  });
  const by = new Map<string, typeof patients>();
  for (const p of patients) (by.get(p.phoneNorm!) ?? by.set(p.phoneNorm!, []).get(p.phoneNorm!)!).push(p);

  let linked = 0;
  for (const i of open) {
    const list = by.get(i.phoneNorm!) ?? [];
    if (!list.length) continue;
    const since = i.occurredAt.getTime() - 2 * 86_400_000;
    const fresh = list.find((p) => p.createdAtExt && p.createdAtExt.getTime() >= since);
    const target = fresh ?? list[0];
    await prisma.inquiry.update({ where: { id: i.id }, data: { patientId: target.id, returning: !fresh } });
    linked++;
  }
  return linked;
}
