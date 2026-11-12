import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, TaskResult, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { Period } from '../reports/period';
import { Lang, TASK_TITLE } from '../common/i18n';

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};


@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private reports: ReportsService,
  ) {}

  list(clinicId: string, q: { status?: TaskStatus; assigneeId?: string; patientId?: string }) {
    return this.prisma.task.findMany({
      where: { clinicId, status: q.status, assigneeId: q.assigneeId, patientId: q.patientId },
      include: {
        patient: { select: { id: true, fullName: true, phone: true } },
        assignee: { select: { id: true, name: true } },
      },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    });
  }

  async summary(clinicId: string) {
    const today = startOfToday();
    const [open, overdue, doneToday] = await Promise.all([
      this.prisma.task.count({ where: { clinicId, status: 'OPEN' } }),
      this.prisma.task.count({ where: { clinicId, status: 'OPEN', dueDate: { lt: today } } }),
      this.prisma.task.count({ where: { clinicId, status: 'DONE', completedAt: { gte: today } } }),
    ]);
    return { open, overdue, doneToday };
  }

  async assignees(clinicId: string) {
    const rows = await this.prisma.membership.findMany({
      where: { clinicId },
      include: { user: { select: { id: true, name: true } } },
    });
    return rows.map((m) => ({ id: m.user.id, name: m.user.name, role: m.role }));
  }

  private async assertMember(clinicId: string, userId?: string | null) {
    if (!userId) return;
    const m = await this.prisma.membership.findUnique({ where: { userId_clinicId: { userId, clinicId } } });
    if (!m) throw new BadRequestException('assignee_not_member');
  }

  private async assertPatient(clinicId: string, patientId?: string | null) {
    if (!patientId) return;
    const p = await this.prisma.patient.findFirst({ where: { id: patientId, clinicId }, select: { id: true } });
    if (!p) throw new BadRequestException('patient_not_found');
  }

  async create(
    clinicId: string,
    userId: string,
    dto: { title: string; note?: string; patientId?: string; assigneeId?: string; dueDate?: string; priority?: number },
  ) {
    await this.assertMember(clinicId, dto.assigneeId);
    await this.assertPatient(clinicId, dto.patientId);
    const task = await this.prisma.task.create({
      data: {
        clinicId,
        createdById: userId,
        title: dto.title,
        note: dto.note,
        patientId: dto.patientId,
        assigneeId: dto.assigneeId,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : startOfToday(),
        priority: dto.priority === 2 ? 2 : 1,
      },
    });
    await this.audit(clinicId, userId, 'task.created', { taskId: task.id });
    return task;
  }

  async update(
    clinicId: string,
    userId: string,
    id: string,
    dto: { status?: TaskStatus; result?: TaskResult | null; assigneeId?: string | null; note?: string; dueDate?: string; priority?: number },
  ) {
    const task = await this.prisma.task.findFirst({ where: { id, clinicId } });
    if (!task) throw new NotFoundException('task_not_found');
    if (dto.assigneeId !== undefined) await this.assertMember(clinicId, dto.assigneeId);

    const data: Prisma.TaskUncheckedUpdateInput = {
      note: dto.note,
      assigneeId: dto.assigneeId,
      priority: dto.priority === undefined ? undefined : dto.priority === 2 ? 2 : 1,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
    };
    if (dto.status) {
      data.status = dto.status;
      data.completedAt = dto.status === 'OPEN' ? null : new Date();
      if (dto.status === 'OPEN') data.result = null;
    }
    if (dto.result !== undefined && dto.status !== 'OPEN') data.result = dto.result;

    const updated = await this.prisma.task.update({ where: { id }, data });
    // The result of a contact on a task goes straight into the patient's contact history
    if (dto.result && dto.status !== 'OPEN' && task.patientId) {
      await this.prisma.contactLog.create({
        data: { clinicId, patientId: task.patientId, userId, outcome: dto.result, note: task.title, source: 'TASK', taskId: id },
      });
    }
    await this.audit(clinicId, userId, 'task.updated', { taskId: id, status: dto.status, result: dto.result });
    return updated;
  }

  // Creates tasks from the report rows. For a patient who already has an open task
  // from the same report, a new one is not created. Rows with actionable = 0 are skipped.
  async fromReport(clinicId: string, userId: string, role: Role, reportId: string, days: number | undefined, lang: Lang, assigneeId?: string, maxDays?: number, period?: Period | null) {
    const title = TASK_TITLE[reportId]?.[lang];
    if (!title) throw new BadRequestException('report_no_tasks');
    await this.assertMember(clinicId, assigneeId);
    const report = await this.reports.build(clinicId, reportId, days, lang, role, maxDays, period);
    const source = `report:${reportId}`;

    const patientIds = [
      ...new Set(report.rows.filter((r) => r.patientId && r.actionable !== 0).map((r) => String(r.patientId))),
    ];
    const existing = await this.prisma.task.findMany({
      where: { clinicId, source, status: 'OPEN', patientId: { in: patientIds } },
      select: { patientId: true },
    });
    const skip = new Set(existing.map((t) => t.patientId));
    const fresh = patientIds.filter((p) => !skip.has(p));

    await this.prisma.task.createMany({
      data: fresh.map((patientId) => ({
        clinicId,
        patientId,
        source,
        title,
        assigneeId,
        createdById: userId,
        dueDate: startOfToday(),
      })),
    });
    await this.audit(clinicId, userId, 'task.bulk_created', { reportId, created: fresh.length });
    return { created: fresh.length, skippedExisting: patientIds.length - fresh.length };
  }

  private audit(clinicId: string, userId: string, action: string, details: Prisma.InputJsonValue) {
    return this.prisma.auditLog.create({ data: { clinicId, userId, action, details } });
  }
}
