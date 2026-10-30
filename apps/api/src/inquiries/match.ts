import { PrismaService } from '../prisma/prisma.service';

// Связывает обращения с карточками по телефону. Карточка, созданная в день обращения или позже (с запасом двое суток),
// значит «обращение стало пациентом». Если у этого телефона карточка была давно, это вернувшийся пациент: он остаётся
// связанным, но в воронке привлечения не считается новым.
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
