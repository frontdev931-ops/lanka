import { BadRequestException, Injectable } from '@nestjs/common';
import { clinicDate } from '../common/clinic-time';
import { PrismaService } from '../prisma/prisma.service';

const DAY = 86_400_000;

// Качество по оценкам пациентов: сводка, по врачам, по месяцам, последние низкие оценки с комментариями
@Injectable()
export class ReviewsService {
  constructor(private prisma: PrismaService) {}

  async settings(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { reviewUrl: true } });
    const rule = await this.prisma.automationRule.findUnique({ where: { clinicId_key: { clinicId, key: 'visit-review' } }, select: { enabled: true } });
    return { reviewUrl: c.reviewUrl, collecting: !!rule?.enabled };
  }

  async setReviewUrl(clinicId: string, url: string | null) {
    const clean = url?.trim() || null;
    if (clean && !/^https:\/\/[^\s]{4,300}$/.test(clean)) throw new BadRequestException('bad_review_url');
    await this.prisma.clinic.update({ where: { id: clinicId }, data: { reviewUrl: clean } });
    return this.settings(clinicId);
  }

  async summary(clinicId: string, months: number, now = new Date()) {
    const since = new Date(now.getTime() - months * 30 * DAY);
    const [rows, asked] = await Promise.all([
      this.prisma.review.findMany({ where: { clinicId, createdAt: { gte: since } }, include: { patient: { select: { id: true, fullName: true } } }, orderBy: { createdAt: 'desc' } }),
      this.prisma.outboundMessage.count({ where: { clinicId, ruleKey: 'visit-review', status: 'SENT', sentAt: { gte: since } } }),
    ]);
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100 : null);
    const group = (key: (r: (typeof rows)[number]) => string | null) => {
      const m = new Map<string, number[]>();
      for (const r of rows) {
        const k = key(r);
        if (k) m.set(k, [...(m.get(k) ?? []), r.rating]);
      }
      return m;
    };
    const dist = [1, 2, 3, 4, 5].map((n) => ({ rating: n, count: rows.filter((r) => r.rating === n).length }));
    return {
      months,
      asked,
      count: rows.length,
      average: avg(rows.map((r) => r.rating)),
      positivePct: rows.length ? Math.round((rows.filter((r) => r.rating >= 4).length / rows.length) * 100) : null,
      responseRate: asked ? Math.round((rows.length / asked) * 100) : null,
      distribution: dist,
      byDoctor: [...group((r) => r.doctorName)].map(([doctor, xs]) => ({ doctor, count: xs.length, average: avg(xs), low: xs.filter((x) => x <= 3).length })).sort((a, b) => b.count - a.count),
      byMonth: [...group((r) => clinicDate(r.createdAt).slice(0, 7))].map(([month, xs]) => ({ month, count: xs.length, average: avg(xs) })).sort((a, b) => a.month.localeCompare(b.month)),
      low: rows
        .filter((r) => r.rating <= 3)
        .slice(0, 20)
        .map((r) => ({ id: r.id, rating: r.rating, comment: r.comment, doctorName: r.doctorName, createdAt: r.createdAt, patient: r.patient })),
    };
  }
}
