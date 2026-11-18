import { BadRequestException, ConflictException, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Integration, Prisma, Provider, SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { cancelStaleReminders } from '../automations/visit-reminders';
import { AUTO_SYNC_HOUR, autoSyncEnabled, autoSyncSlot, clinicTimeZone } from './auto-sync-schedule';
import { decrypt, encrypt } from '../common/crypto';
import { normalizePhone } from '../common/phone';
import { matchInquiries } from '../inquiries/match';
import { CurrencyScope, stampCurrency } from './currency-stamp';
import { SOURCE_CURRENCIES } from '../common/money';
import { ClinicConnector } from './connector';
import { DemoConnector } from './demo.connector';
import { SettingsImportService } from './settings-import.service';
import { CliniccardsClient } from './cliniccards.client';
import { CliniccardsConnector } from './cliniccards.connector';

const DAY = 86_400_000;
// Sync windows: the past is needed by reports, the future by the search for next visits and free windows.
// The history of appointments is needed by the patient funnel (first visit, repeat visits): three years
const VISITS_PAST = 1095;
const VISITS_FUTURE = 90;
// Plan items are filtered by creation date and change status, so we read three years each time:
// otherwise an old plan with incomplete items drops out of "Unfinished treatment"
const TREATMENT_PAST = 1095;
const FINANCE_FIRST = 365; // payments and acts hardly change: a year the first time, then only the last days
const FINANCE_REGULAR = 45;
const REMINDERS_FUTURE = 365; // we read reminders from today a year ahead
const SCHEDULE_PAST = 7;
const SCHEDULE_FUTURE = 30;

// We write to the database in portions in parallel: faster than sequential writing, but without overloading the connection pool.
async function inBatches<T>(items: T[], fn: (item: T) => Promise<void>, size = 20) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

// Which IDs of the existing list are missing from the fresh export (they were deleted in Cliniccards)
const missing = (existing: { externalId: string }[], fresh: Set<string>) =>
  existing.map((r) => r.externalId).filter((id) => !fresh.has(id));

// A running load refreshes its heartbeat this often; without one for HEARTBEAT_STALE_MS it is treated as cut off. MAX_RUN_MS: no load lasts longer.
export const HEARTBEAT_MS = 20_000;
export const HEARTBEAT_STALE_MS = 2 * 60_000;
const MAX_RUN_MS = 30 * 60_000;

// What kind of failure the last load had, for a readable sentence on the card (the full message stays in the history)
export function errorKind(error: string | null): 'network' | 'interrupted' | 'access' | 'other' {
  const e = error ?? '';
  if (/нет связи|ECONN|ETIMEDOUT|fetch failed|timeout/i.test(e)) return 'network';
  if (/прервана|прерван|interrupted/i.test(e)) return 'interrupted';
  if (/\b(401|403)\b|unauthori|forbidden|api.?key|ключ/i.test(e)) return 'access';
  return 'other';
}

@Injectable()
export class SyncService implements OnApplicationBootstrap {
  constructor(
    private prisma: PrismaService,
    private imports: SettingsImportService,
  ) {}

  // A server restart cuts a load off halfway, and the record of it stays "running" forever. A running load proves it is alive with a heartbeat
  // (heartbeatAt, refreshed every HEARTBEAT_MS), so at start only the loads WITHOUT a recent heartbeat are closed: with several API servers a start of one
  // does not mark the load another one is doing. A load cut off a moment ago is closed by the next check after HEARTBEAT_STALE_MS (every start of a load
  // and every read of the status runs the check); the daily automatic load then tries again when its lease ends (AutoSyncService).
  async onApplicationBootstrap() {
    await this.failStale();
  }

  // Creates a load record if the clinic has no other running one. The check and creation run under a database lock:
  // auto-refresh and a manual start cannot start at the same time (otherwise a double load on the limit of 60 requests per minute).
  private async startRun(clinicId: string, integrationId: string) {
    await this.failStale(clinicId);
    return this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${clinicId})) AS locked`;
      const active = locked ? await tx.syncRun.findFirst({ where: { clinicId, status: SyncStatus.RUNNING }, select: { id: true } }) : true;
      if (!locked || active) throw new ConflictException('sync_running');
      return tx.syncRun.create({ data: { clinicId, integrationId, heartbeatAt: new Date() } });
    });
  }

  // "Running" records that are certainly not running any more: no heartbeat for HEARTBEAT_STALE_MS, or started more than MAX_RUN_MS ago (a load never
  // lasts that long; also the rule for a record made before the heartbeat existed)
  private failStale(clinicId?: string) {
    const now = Date.now();
    return this.prisma.syncRun.updateMany({
      where: {
        status: SyncStatus.RUNNING,
        ...(clinicId ? { clinicId } : {}),
        OR: [{ heartbeatAt: { lt: new Date(now - HEARTBEAT_STALE_MS) } }, { startedAt: { lt: new Date(now - MAX_RUN_MS) } }],
      },
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
    await this.failStale(clinicId);
    const lastRun = await this.prisma.syncRun.findFirst({
      where: { clinicId },
      orderBy: { startedAt: 'desc' },
      select: { status: true, error: true, startedAt: true, finishedAt: true },
    });
    const tz = clinicTimeZone(clinicId);
    const on = autoSyncEnabled() && !!i.apiKeyEnc;
    const cur = await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { sourceCurrency: true, sourceCurrencyStatedAt: true, planCurrency: true, planCurrencyStatedAt: true } });
    return {
      // the currency of the amounts as stated by the owner (null: not stated) and the choices
      // two separately stated scopes: payments, invoices and balances (code) and treatment-plan totals (planCode); null = not stated
      currency: { code: cur?.sourceCurrency ?? null, statedAt: cur?.sourceCurrencyStatedAt ?? null, planCode: cur?.planCurrency ?? null, planStatedAt: cur?.planCurrencyStatedAt ?? null, options: SOURCE_CURRENCIES },
      connected: !!i.apiKeyEnc,
      mode: i.apiKeyEnc ? 'cliniccards' : 'demo',
      lastSyncAt: i.lastSyncAt,
      lastRun: lastRun ? { ...lastRun, errorKind: lastRun.status === SyncStatus.FAILED ? errorKind(lastRun.error) : null } : null,
      // shown as on only when the server runs it (AUTO_SYNC) and the clinic has a Cliniccards key
      autoSync: { enabled: on, hour: AUTO_SYNC_HOUR, timeZone: tz, nextAt: on ? autoSyncSlot(new Date(), tz).nextAt : null },
    };
  }

  // The owner states a currency for ONE scope (currency-stamp.ts): 'finance' = payments, invoices and patient balances; 'plans' = treatment-plan totals.
  // First statement of a scope: every amount of that scope loaded so far (all unstamped) gets it. A different currency later: by default only the amounts
  // loaded from now on (the clinic changed its accounting); with correct = true every amount of that scope is relabelled (the earlier statement was a
  // mistake). The other scope is never touched. Both are written to the audit log with the scope and the old and new code.
  async setCurrency(clinicId: string, userId: string, code: string, correct: boolean, scope: CurrencyScope = 'finance') {
    if (!(SOURCE_CURRENCIES as readonly string[]).includes(code)) throw new BadRequestException('bad_currency');
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { sourceCurrency: true, planCurrency: true } });
    const before = scope === 'plans' ? c.planCurrency : c.sourceCurrency;
    const now = new Date();
    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: scope === 'plans' ? { planCurrency: code, planCurrencyStatedAt: now, planCurrencyStatedById: userId } : { sourceCurrency: code, sourceCurrencyStatedAt: now, sourceCurrencyStatedById: userId },
    });
    const stamped = await stampCurrency(this.prisma, clinicId, { scope, correct: correct && !!before && before !== code });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'clinic.currency', details: { scope, before, after: code, correct: !!correct, stamped } } });
    return this.status(clinicId);
  }

  // Checks the key with a request for the list of staff, then stores it encrypted
  // and deletes the clinic's demo data so that it does not mix with the real data.
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

  // userId = null for an automatic start on schedule
  async run(clinicId: string, userId: string | null) {
    const integration = await this.ensureIntegration(clinicId);
    const run = await this.startRun(clinicId, integration.id);
    // the sign of life while the load runs (also during the long writing stage, which has no step of its own)
    const beat = setInterval(() => void this.prisma.syncRun.updateMany({ where: { id: run.id, status: SyncStatus.RUNNING }, data: { heartbeatAt: new Date() } }).catch(() => undefined), HEARTBEAT_MS);
    beat.unref();

    try {
      const connector = this.connectorFor(integration);
      const now = Date.now();
      const win = (past: number, future: number) => ({ from: new Date(now - past * DAY), to: new Date(now + future * DAY) });
      const visitsWin = win(VISITS_PAST, VISITS_FUTURE);
      const scheduleWin = win(SCHEDULE_PAST, SCHEDULE_FUTURE);

      // We read everything first: if any request fails, nothing in the database changes and nothing is deleted
      // The percentages roughly match the time of the stages: reading from Cliniccards takes seconds (about 20 requests),
      // most of the time goes into writing to the database
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
      // Reminders are needed by reports only as "the patient is already remembered": from today onwards
      const remindersWin = { from: new Date(new Date().setUTCHours(0, 0, 0, 0)), to: new Date(now + REMINDERS_FUTURE * DAY) };
      const reminders = (await connector.fetchReminders?.(remindersWin)) ?? [];
      await step(24, 'saving');
      // The logo is an optional detail: if it did not work, the data load is not stopped
      const cabinets = (await connector.fetchCabinets?.().catch(() => null)) ?? [];
      const profile = await connector.fetchProfile?.().catch(() => null);
      // the logo and the name of the clinic come from Cliniccards, so the cabinet and the messages to patients carry the real name
      if (profile) await this.prisma.clinic.update({ where: { id: clinicId }, data: { logo: profile.logo ?? null, ...(profile.name ? { name: profile.name } : {}) } });
      // The working hours and the price list are what the clinic would otherwise type again: read from Cliniccards, without ever replacing what it typed itself
      await this.imports.afterSync(clinicId, connector);

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
          // The patient came back from Cliniccards (for example a deletion was undone): returns to the lists
          update: { ...data, removedAt: null },
        });
        idByExternal.set(p.externalId, row.id);
      });

      // Patients that Cliniccards no longer has (deleted or merged) are hidden, not deleted: tasks, consents
      // and the contact history stay. Protection against a failure: if an empty or sharply smaller list came, we hide nothing.
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
      // Appointments
      let visitCount = 0;
      const freshVisits = new Set<string>();
      // the times we knew of the visits that are not yet past: a visit that comes back at another time moved (in Cliniccards, or through LANKA unseen until now)
      const knownTimes = new Map((await this.prisma.visit.findMany({ where: { clinicId, startsAt: { gte: new Date(now - DAY) } }, select: { externalId: true, startsAt: true } })).map((v) => [v.externalId, v.startsAt]));
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
      // Appointments deleted in Cliniccards disappear for us too (within the window that was read)
      const staleVisits = missing(
        await this.prisma.visit.findMany({ where: { clinicId, startsAt: { gte: visitsWin.from, lte: visitsWin.to } }, select: { externalId: true } }),
        freshVisits,
      );
      if (staleVisits.length) await this.prisma.visit.deleteMany({ where: { clinicId, externalId: { in: staleVisits } } });
      // a new time seen here is recorded (the moment LANKA learned it; how often or when it changed in Cliniccards in between is not known), and the waiting reminders
      // of moved, cancelled or deleted visits are cancelled (never sent with the old time)
      const timeChanges = visits.filter((v) => freshVisits.has(v.externalId) && knownTimes.has(v.externalId) && knownTimes.get(v.externalId)!.getTime() !== v.startsAt.getTime());
      if (timeChanges.length) await this.prisma.auditLog.createMany({ data: timeChanges.map((v) => ({ clinicId, userId: null, action: 'visit.time_changed', details: { visit: v.externalId, from: knownTimes.get(v.externalId)!.toISOString(), to: v.startsAt.toISOString(), source: 'sync' } })) });
      await cancelStaleReminders(this.prisma, clinicId);

      await step(44, 'saving');
      // Treatment plans (items of unknown patients, for example archived ones, are skipped)
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
      // Plan totals (needed so that the remaining treatment is counted in the clinic's currency)
      await inBatches(plans, async (pl) => {
        const data = { total: pl.total, totalDone: pl.totalDone, createdAtExt: pl.createdAt };
        await this.prisma.treatmentPlan.upsert({
          where: { clinicId_externalId: { clinicId, externalId: pl.externalId } },
          create: { clinicId, externalId: pl.externalId, ...data },
          update: data,
        });
      });

      await step(84, 'saving');
      // Finance
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
      // Schedule: shifts and time blocks in the window are replaced with fresh ones
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
      // Reminders: fresh ones are written, those that vanished from the window that was read are deleted
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

      // New cards: inquiries entered by the administrator are linked to them by phone
      await matchInquiries(this.prisma, clinicId);
      // the amounts just loaded get the clinic's stated currency (nothing happens while it is not stated)
      await stampCurrency(this.prisma, clinicId);

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
      // Prisma request errors can include the query arguments, including patient data.
      let failure = e;
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        failure = new Error(`Cliniccards sync database request failed (${e.code})`);
      } else if (e instanceof Prisma.PrismaClientValidationError || e instanceof Prisma.PrismaClientUnknownRequestError) {
        failure = new Error('Cliniccards sync database request failed');
      }
      await this.prisma.syncRun.update({
        where: { id: run.id },
        data: { status: SyncStatus.FAILED, finishedAt: new Date(), error: (failure as Error).message },
      });
      throw failure;
    } finally {
      clearInterval(beat);
    }
  }

  // A run that started less than 30 minutes ago and has not finished: we do not start a second one in parallel
  async hasActiveRun(clinicId: string) {
    const since = new Date(Date.now() - 30 * 60_000);
    return !!(await this.prisma.syncRun.findFirst({ where: { clinicId, status: SyncStatus.RUNNING, startedAt: { gte: since } } }));
  }

  async lastRuns(clinicId: string) {
    // A load never lasts longer than 30 minutes: so a stuck record does not "run" forever and block a new start
    await this.failStale(clinicId);
    return this.prisma.syncRun.findMany({
      where: { clinicId },
      orderBy: { startedAt: 'desc' },
      take: 10,
    });
  }
}
