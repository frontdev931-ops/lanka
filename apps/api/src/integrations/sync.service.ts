import { BadRequestException, ConflictException, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Integration, Provider, SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt, encrypt } from '../common/crypto';
import { normalizePhone } from '../common/phone';
import { matchInquiries } from '../inquiries/match';
import { ClinicConnector } from './connector';
import { DemoConnector } from './demo.connector';
import { CliniccardsClient } from './cliniccards.client';
import { CliniccardsConnector } from './cliniccards.connector';

const DAY = 86_400_000;
// Окна синхронизации: прошлое нужно отчётам, будущее — поиску следующих визитов и свободных окон.
// История записей нужна воронке пациента (первый визит, повторные визиты): три года
const VISITS_PAST = 1095;
const VISITS_FUTURE = 90;
// Пункты плана фильтруются по дате создания и меняют статус, поэтому читаем три года каждый раз:
// старый план с невыполненными пунктами иначе выпадает из «Незавершённого лечения»
const TREATMENT_PAST = 1095;
const FINANCE_FIRST = 365; // платежи и акты почти не меняются: первый раз год, потом только последние дни
const FINANCE_REGULAR = 45;
const REMINDERS_FUTURE = 365; // читаем напоминания от сегодняшнего дня на год вперёд
const SCHEDULE_PAST = 7;
const SCHEDULE_FUTURE = 30;

// Пишем в базу порциями параллельно: быстрее последовательной записи, но без перегрузки пула соединений.
async function inBatches<T>(items: T[], fn: (item: T) => Promise<void>, size = 20) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

// Какие ID из списка существующих отсутствуют в свежей выгрузке (их удалили в Cliniccards)
const missing = (existing: { externalId: string }[], fresh: Set<string>) =>
  existing.map((r) => r.externalId).filter((id) => !fresh.has(id));

@Injectable()
export class SyncService implements OnApplicationBootstrap {
  constructor(private prisma: PrismaService) {}

  // Перезапуск сервера обрывает загрузку на полпути, а запись о ней остаётся «идёт» навсегда.
  // Сервер один, поэтому при старте любая запись «идёт» точно осиротела. (Если серверов станет несколько,
  // здесь нужно будет смотреть только на давно не обновлявшиеся записи.)
  async onApplicationBootstrap() {
    await this.failStale(0);
  }

  // Создаёт запись о загрузке, если у клиники нет другой идущей. Проверка и создание идут под блокировкой базы:
  // автообновление и ручной запуск не могут стартовать одновременно (иначе двойная нагрузка на лимит 60 запросов в минуту).
  private async startRun(clinicId: string, integrationId: string) {
    await this.failStale(30 * 60_000, clinicId);
    return this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${clinicId})) AS locked`;
      const active = locked ? await tx.syncRun.findFirst({ where: { clinicId, status: SyncStatus.RUNNING }, select: { id: true } }) : true;
      if (!locked || active) throw new ConflictException('sync_running');
      return tx.syncRun.create({ data: { clinicId, integrationId } });
    });
  }

  // Записи «идёт» старше olderThanMs считаются прерванными
  private failStale(olderThanMs: number, clinicId?: string) {
    return this.prisma.syncRun.updateMany({
      where: { status: SyncStatus.RUNNING, startedAt: { lt: new Date(Date.now() - olderThanMs) }, ...(clinicId ? { clinicId } : {}) },
      data: { status: SyncStatus.FAILED, finishedAt: new Date(), error: 'Загрузка прервана: сервер был перезапущен или не ответил' },
    });
  }

  private connectorFor(i: Integration): ClinicConnector {
    return i.apiKeyEnc
      ? new CliniccardsConnector(new CliniccardsClient(decrypt(i.apiKeyEnc)))
      : new DemoConnector();
  }

  // The connector of a clinic with a real key, or null for a demo clinic (made-up data has nothing to write to)
  async connectorForClinic(clinicId: string): Promise<ClinicConnector | null> {
    const i = await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.CLINICCARDS } } });
    return i?.apiKeyEnc ? this.connectorFor(i) : null;
  }

  private ensureIntegration(clinicId: string) {
    return this.prisma.integration.upsert({
      where: { clinicId_provider: { clinicId, provider: Provider.CLINICCARDS } },
      create: { clinicId, provider: Provider.CLINICCARDS },
      update: {},
    });
  }

  async status(clinicId: string) {
    const i = await this.ensureIntegration(clinicId);
    const lastRun = await this.prisma.syncRun.findFirst({
      where: { clinicId },
      orderBy: { startedAt: 'desc' },
      select: { status: true, error: true, startedAt: true },
    });
    return { connected: !!i.apiKeyEnc, mode: i.apiKeyEnc ? 'cliniccards' : 'demo', lastSyncAt: i.lastSyncAt, lastRun };
  }

  // Проверяет ключ запросом списка сотрудников, затем сохраняет его зашифрованным
  // и удаляет демо-данные клиники, чтобы они не смешались с реальными.
  async connect(clinicId: string, userId: string, apiKey: string) {
    try {
      await new CliniccardsClient(apiKey).get('/staff');
    } catch {
      throw new BadRequestException('bad_api_key');
    }
    await this.prisma.$transaction([
      this.prisma.integration.update({
        where: { clinicId_provider: { clinicId, provider: Provider.CLINICCARDS } },
        data: { apiKeyEnc: encrypt(apiKey), lastSyncAt: null },
      }),
      this.prisma.patient.deleteMany({ where: { clinicId, externalId: { startsWith: 'demo-' } } }),
      this.prisma.payment.deleteMany({ where: { clinicId, externalId: { startsWith: 'demo-' } } }),
      this.prisma.invoice.deleteMany({ where: { clinicId, externalId: { startsWith: 'demo-' } } }),
      this.prisma.shift.deleteMany({ where: { clinicId, externalId: { startsWith: 'demo-' } } }),
      this.prisma.reservedBlock.deleteMany({ where: { clinicId, externalId: { startsWith: 'demo-' } } }),
      this.prisma.auditLog.create({ data: { clinicId, userId, action: 'integration.connected' } }),
    ]);
    return this.status(clinicId);
  }

  // userId = null для автоматического запуска по расписанию
  async run(clinicId: string, userId: string | null) {
    const integration = await this.ensureIntegration(clinicId);
    const run = await this.startRun(clinicId, integration.id);

    try {
      const connector = this.connectorFor(integration);
      const now = Date.now();
      const win = (past: number, future: number) => ({ from: new Date(now - past * DAY), to: new Date(now + future * DAY) });
      const visitsWin = win(VISITS_PAST, VISITS_FUTURE);
      const scheduleWin = win(SCHEDULE_PAST, SCHEDULE_FUTURE);

      // Сначала читаем всё: если любой запрос упадёт, в базе ничего не меняется и ничего не удаляется
      // Проценты примерно соответствуют времени этапов: чтение из Cliniccards занимает секунды (около 20 запросов),
      // основное время уходит на запись в базу
      const step = (progress: number, stage: string) => this.prisma.syncRun.update({ where: { id: run.id }, data: { progress, stage } });
      await step(2, 'patients');
      const patients = await connector.fetchPatients();
      await step(8, 'visits');
      const visits = await connector.fetchVisits(visitsWin);
      await step(11, 'treatment');
      const plan = await connector.fetchTreatment(win(TREATMENT_PAST, 0));
      await step(18, 'finance');
      const plans = (await connector.fetchPlans?.(win(TREATMENT_PAST, 0))) ?? [];
      const finance = await connector.fetchFinance(win(integration.lastSyncAt ? FINANCE_REGULAR : FINANCE_FIRST, 0));
      await step(21, 'schedule');
      const schedule = await connector.fetchSchedule(scheduleWin);
      // Напоминания нужны отчётам только как «о пациенте уже помнят»: с сегодняшнего дня и дальше
      const remindersWin = { from: new Date(new Date().setUTCHours(0, 0, 0, 0)), to: new Date(now + REMINDERS_FUTURE * DAY) };
      const reminders = (await connector.fetchReminders?.(remindersWin)) ?? [];
      await step(24, 'saving');
      // Логотип — необязательная мелочь: если не получилось, загрузку данных это не останавливает
      const cabinets = (await connector.fetchCabinets?.().catch(() => null)) ?? [];
      const profile = await connector.fetchProfile?.().catch(() => null);
      if (profile) await this.prisma.clinic.update({ where: { id: clinicId }, data: { logo: profile.logo ?? null } });

      const idByExternal = new Map<string, string>();
      await inBatches(patients, async (p) => {
        const data = {
          fullName: p.fullName,
          phone: p.phone,
          phoneNorm: normalizePhone(p.phone),
          source: p.source,
          preferredContact: p.preferredContact,
          lastVisitAt: p.lastVisitAt,
          createdAtExt: p.createdAt,
          firstVisitAt: p.firstVisitAt,
          birthDate: p.birthday ?? null,
          balanceIssued: p.balanceIssued,
          balancePaid: p.balancePaid,
        };
        const row = await this.prisma.patient.upsert({
          where: { clinicId_externalId: { clinicId, externalId: p.externalId } },
          create: { clinicId, externalId: p.externalId, ...data },
          // Пациент снова пришёл из Cliniccards (например, удаление отменили): возвращается в списки
          update: { ...data, removedAt: null },
        });
        idByExternal.set(p.externalId, row.id);
      });

      // Пациенты, которых в Cliniccards больше нет (удалены или объединены), скрываются, а не удаляются: задачи, согласия
      // и история контактов остаются. Защита от сбоя: если пришёл пустой или резко меньший список, ничего не скрываем.
      const fresh = new Set(patients.map((p) => p.externalId));
      const known = await this.prisma.patient.findMany({ where: { clinicId, removedAt: null }, select: { externalId: true } });
      const gone = known.map((k) => k.externalId).filter((id) => !fresh.has(id));
      const removalSkipped = gone.length > 0 && (patients.length === 0 || (known.length >= 20 && patients.length < known.length * 0.5));
      if (gone.length && !removalSkipped) {
        for (let i = 0; i < gone.length; i += 1000) {
          await this.prisma.patient.updateMany({ where: { clinicId, externalId: { in: gone.slice(i, i + 1000) } }, data: { removedAt: new Date() } });
        }
      }

      await step(34, 'saving');
      // Записи
      let visitCount = 0;
      const freshVisits = new Set<string>();
      await inBatches(visits, async (v) => {
        const patientId = idByExternal.get(v.patientExternalId);
        if (!patientId) return;
        const data = {
          patientId,
          doctorId: v.doctorId,
          doctorName: v.doctorName,
          cabinetId: v.cabinetId,
          serviceName: v.serviceName,
          startsAt: v.startsAt,
          endsAt: v.endsAt,
          bookedAt: v.bookedAt,
          status: v.status,
          amount: v.amount,
        };
        await this.prisma.visit.upsert({
          where: { clinicId_externalId: { clinicId, externalId: v.externalId } },
          create: { clinicId, externalId: v.externalId, ...data },
          update: data,
        });
        freshVisits.add(v.externalId);
        visitCount++;
      });
      // Записи, удалённые в Cliniccards, пропадают и у нас (в пределах прочитанного окна)
      const staleVisits = missing(
        await this.prisma.visit.findMany({ where: { clinicId, startsAt: { gte: visitsWin.from, lte: visitsWin.to } }, select: { externalId: true } }),
        freshVisits,
      );
      if (staleVisits.length) await this.prisma.visit.deleteMany({ where: { clinicId, externalId: { in: staleVisits } } });

      await step(44, 'saving');
      // Планы лечения (пункты неизвестных пациентов, например архивных, пропускаем)
      let planCount = 0;
      await inBatches(plan, async (i) => {
        const patientId = idByExternal.get(i.patientExternalId);
        if (!patientId) return;
        const data = {
          patientId,
          planId: i.planId,
          name: i.name,
          price: i.price,
          status: i.status,
          groupName: i.groupName,
          createdAtExt: i.createdAt,
          markedDoneAt: i.markedDoneAt,
          doneByDoctorId: i.doneByDoctorId,
        };
        await this.prisma.planItem.upsert({
          where: { clinicId_externalId: { clinicId, externalId: i.externalId } },
          create: { clinicId, externalId: i.externalId, ...data },
          update: data,
        });
        planCount++;
      });

      for (const c of cabinets) {
        await this.prisma.cabinet.upsert({
          where: { clinicId_externalId: { clinicId, externalId: c.externalId } },
          create: { clinicId, externalId: c.externalId, name: c.name },
          update: { name: c.name },
        });
      }

      await step(80, 'saving');
      // Итоги планов (нужны, чтобы остаток лечения считался в валюте клиники)
      await inBatches(plans, async (pl) => {
        const data = { total: pl.total, totalDone: pl.totalDone, createdAtExt: pl.createdAt };
        await this.prisma.treatmentPlan.upsert({
          where: { clinicId_externalId: { clinicId, externalId: pl.externalId } },
          create: { clinicId, externalId: pl.externalId, ...data },
          update: data,
        });
      });

      await step(84, 'saving');
      // Финансы
      await inBatches(finance.payments, async (p) => {
        const data = { patientId: (p.patientExternalId && idByExternal.get(p.patientExternalId)) || null, paidAt: p.paidAt, amount: p.amount, type: p.type };
        await this.prisma.payment.upsert({
          where: { clinicId_externalId: { clinicId, externalId: p.externalId } },
          create: { clinicId, externalId: p.externalId, ...data },
          update: data,
        });
      });
      await inBatches(finance.invoices, async (i) => {
        const data = { patientId: (i.patientExternalId && idByExternal.get(i.patientExternalId)) || null, issuedAt: i.issuedAt, amount: i.amount, issuerName: i.issuerName };
        await this.prisma.invoice.upsert({
          where: { clinicId_externalId: { clinicId, externalId: i.externalId } },
          create: { clinicId, externalId: i.externalId, ...data },
          update: data,
        });
      });

      await step(92, 'saving');
      // Расписание: смены и блоки времени в окне заменяются свежими
      await inBatches(schedule.shifts, async (s) => {
        const data = { doctorId: s.doctorId, doctorName: s.doctorName, cabinetId: s.cabinetId, cabinetName: s.cabinetName, startsAt: s.startsAt, endsAt: s.endsAt };
        await this.prisma.shift.upsert({
          where: { clinicId_externalId: { clinicId, externalId: s.externalId } },
          create: { clinicId, externalId: s.externalId, ...data },
          update: data,
        });
      });
      await inBatches(schedule.blocks, async (b) => {
        const data = { cabinetId: b.cabinetId, startsAt: b.startsAt, endsAt: b.endsAt, note: b.note };
        await this.prisma.reservedBlock.upsert({
          where: { clinicId_externalId: { clinicId, externalId: b.externalId } },
          create: { clinicId, externalId: b.externalId, ...data },
          update: data,
        });
      });
      const inWindow = { gte: scheduleWin.from, lte: scheduleWin.to };
      const staleShifts = missing(
        await this.prisma.shift.findMany({ where: { clinicId, startsAt: inWindow }, select: { externalId: true } }),
        new Set(schedule.shifts.map((s) => s.externalId)),
      );
      if (staleShifts.length) await this.prisma.shift.deleteMany({ where: { clinicId, externalId: { in: staleShifts } } });
      const staleBlocks = missing(
        await this.prisma.reservedBlock.findMany({ where: { clinicId, startsAt: inWindow }, select: { externalId: true } }),
        new Set(schedule.blocks.map((b) => b.externalId)),
      );
      if (staleBlocks.length) await this.prisma.reservedBlock.deleteMany({ where: { clinicId, externalId: { in: staleBlocks } } });

      await step(96, 'saving');
      // Напоминания: свежие записываются, исчезнувшие из прочитанного окна удаляются
      await inBatches(reminders, async (r) => {
        const data = { patientId: (r.patientExternalId && idByExternal.get(r.patientExternalId)) || null, dueDate: r.dueDate, note: r.note, status: r.status };
        await this.prisma.reminder.upsert({
          where: { clinicId_externalId: { clinicId, externalId: r.externalId } },
          create: { clinicId, externalId: r.externalId, ...data },
          update: data,
        });
      });
      if (connector.fetchReminders) {
        const staleReminders = missing(
          await this.prisma.reminder.findMany({ where: { clinicId, dueDate: { gte: remindersWin.from, lte: remindersWin.to } }, select: { externalId: true } }),
          new Set(reminders.map((r) => r.externalId)),
        );
        if (staleReminders.length) await this.prisma.reminder.deleteMany({ where: { clinicId, externalId: { in: staleReminders } } });
      }

      // Новые карточки: обращения, внесённые администратором, привязываются к ним по телефону
      await matchInquiries(this.prisma, clinicId);

      const extra = {
        reminders: reminders.length,
        planItems: planCount,
        payments: finance.payments.length,
        invoices: finance.invoices.length,
        shifts: schedule.shifts.length,
        blocks: schedule.blocks.length,
        removedVisits: staleVisits.length,
        removedPatients: removalSkipped ? 0 : gone.length,
        ...(removalSkipped ? { removalSkipped: true } : {}),
      };
      const finishedAt = new Date();
      await this.prisma.integration.update({
        where: { id: integration.id },
        data: { lastSyncAt: finishedAt },
      });
      await this.prisma.auditLog.create({
        data: { clinicId, userId, action: 'sync.finished', details: { patients: patients.length, visits: visitCount, ...extra } },
      });
      return this.prisma.syncRun.update({
        where: { id: run.id },
        data: { status: SyncStatus.OK, finishedAt, patients: patients.length, visits: visitCount, extra, progress: 100, stage: null },
      });
    } catch (e) {
      await this.prisma.syncRun.update({
        where: { id: run.id },
        data: { status: SyncStatus.FAILED, finishedAt: new Date(), error: (e as Error).message },
      });
      throw e;
    }
  }

  // Запуск, начатый менее 30 минут назад и не завершённый: второй параллельно не стартуем
  async hasActiveRun(clinicId: string) {
    const since = new Date(Date.now() - 30 * 60_000);
    return !!(await this.prisma.syncRun.findFirst({ where: { clinicId, status: SyncStatus.RUNNING, startedAt: { gte: since } } }));
  }

  async lastRuns(clinicId: string) {
    // Загрузка дольше 30 минут не бывает: так застрявшая запись не будет вечно «идти» и блокировать новый запуск
    await this.failStale(30 * 60_000, clinicId);
    return this.prisma.syncRun.findMany({
      where: { clinicId },
      orderBy: { startedAt: 'desc' },
      take: 10,
    });
  }
}
