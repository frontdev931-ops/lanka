import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { clinicDate, clinicHm } from '../common/clinic-time';
import { PrismaService } from '../prisma/prisma.service';
import { accessBlocked, billingEnforced } from '../service/plans';
import { marketingAllowed } from './consent';
import { PlannerService } from './planner.service';
import { RequestsService } from './requests.service';
import { render } from './scenarios';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MAX_AUTOMATIONS = 20;
const PLACEHOLDERS = new Set(['name', 'clinic', 'date', 'time', 'months']);
const ACTIVE_VISIT = ['PLANNED', 'CONFIRMED', 'NOT_CONFIRMED'];
const VISIT_AFTER_STATUSES = ['VISITED', 'DID_NOT_COME', 'CANCELLED', 'MOVED'];

export type Trigger =
  | { type: 'VISIT_BEFORE'; hours: number }
  | { type: 'VISIT_AFTER'; status: string; delayHours: number }
  | { type: 'NO_VISIT'; days: number }
  | { type: 'TREATMENT_OPEN'; days: number }
  | { type: 'BIRTHDAY' };
export interface Conditions {
  noOtherFutureVisit?: boolean;
  source?: string;
  minVisits?: number;
  maxVisits?: number;
  doctor?: string;
  service?: string;
}
export interface Action {
  type: 'SEND_MESSAGE' | 'CREATE_REQUEST';
  text: string;
}
export interface Stop {
  ifBooked?: boolean;
  ifReplied?: boolean;
}
export interface AutomationInput {
  name: string;
  kind: 'service' | 'marketing';
  trigger: Trigger;
  conditions?: Conditions;
  action: Action;
  stop?: Stop;
  templateKey?: string | null;
}

export interface Report {
  id: string;
  name: string;
  enabled: boolean;
  candidates: number;
  toDo: number;
  alreadyDone: number;
  skipped: Record<string, number>;
  sample: { patient: string; text: string }[];
}

interface Candidate {
  patientId: string;
  dedupeKey: string;
  visitId?: string;
  doctorName?: string | null;
  serviceName?: string | null;
  vars: { date?: string; time?: string; months?: number };
  expiresAt?: Date;
}

// Ready-made starting points for the builder: the clinic picks one, looks at it and may change it. Nothing runs until it is switched on.
export const TEMPLATES: (AutomationInput & { key: string })[] = [
  { key: 'confirm-3h', name: 'Нагадування за 3 години', kind: 'service', trigger: { type: 'VISIT_BEFORE', hours: 3 }, action: { type: 'SEND_MESSAGE', text: '{name}, нагадуємо: сьогодні о {time} вас чекають у клініці «{clinic}». Якщо щось змінилося, напишіть нам.' } },
  { key: 'thanks-after', name: 'Подяка наступного дня', kind: 'service', trigger: { type: 'VISIT_AFTER', status: 'VISITED', delayHours: 20 }, action: { type: 'SEND_MESSAGE', text: '{name}, дякуємо, що були в клініці «{clinic}». Якщо виникнуть запитання після візиту, напишіть нам.' } },
  { key: 'no-show-ask', name: 'Неявка: запитати, коли зручно', kind: 'service', trigger: { type: 'VISIT_AFTER', status: 'DID_NOT_COME', delayHours: 2 }, stop: { ifBooked: true }, action: { type: 'SEND_MESSAGE', text: '{name}, ми не дочекалися вас {date}. Підкажіть, коли вам зручно прийти? Клініка «{clinic}».' } },
  { key: 'treatment-3w', name: 'Незавершене лікування', kind: 'marketing', trigger: { type: 'TREATMENT_OPEN', days: 21 }, stop: { ifBooked: true, ifReplied: true }, action: { type: 'SEND_MESSAGE', text: '{name}, у вас є незавершене лікування в клініці «{clinic}». Запрошуємо записатися на наступний візит.' } },
  { key: 'lapsed-instagram', name: 'Повернення давніх пацієнтів з Instagram', kind: 'marketing', trigger: { type: 'NO_VISIT', days: 365 }, conditions: { source: 'instagram', noOtherFutureVisit: true }, stop: { ifBooked: true, ifReplied: true }, action: { type: 'SEND_MESSAGE', text: '{name}, давно не бачили вас у клініці «{clinic}». Запрошуємо на візит, будемо раді вас бачити!' } },
  { key: 'first-visit-call', name: 'Зв’язатися після першого візиту', kind: 'service', trigger: { type: 'VISIT_AFTER', status: 'VISITED', delayHours: 48 }, conditions: { maxVisits: 1 }, action: { type: 'CREATE_REQUEST', text: 'Зв’язатися з пацієнтом після першого візиту: запитати враження і домовитися про наступний.' } },
];

// Automations built by the clinic. The engine only reads our copy of the clinic's data and writes to our own queue: messages wait for
// approval (or go by themselves when the clinic allows service messages), every one is re-checked right before sending, and a
// marketing message needs consent and respects the limit of one promotion in 14 days.
@Injectable()
export class CustomAutomationsService {
  private readonly log = new Logger(CustomAutomationsService.name);

  constructor(
    private prisma: PrismaService,
    private planner: PlannerService,
    private requests: RequestsService,
  ) {}

  // ---------- definitions ----------

  private clean(d: AutomationInput): AutomationInput {
    const name = (d.name ?? '').trim();
    if (!name || name.length > 120) throw new BadRequestException('bad_automation');
    if (!['service', 'marketing'].includes(d.kind)) throw new BadRequestException('bad_automation');
    const t = d.trigger as Trigger & Record<string, unknown>;
    const int = (v: unknown, min: number, max: number) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestException('bad_automation');
      return n;
    };
    let trigger: Trigger;
    switch (t?.type) {
      case 'VISIT_BEFORE':
        trigger = { type: 'VISIT_BEFORE', hours: int(t.hours, 1, 72) };
        break;
      case 'VISIT_AFTER':
        if (!VISIT_AFTER_STATUSES.includes(String(t.status))) throw new BadRequestException('bad_automation');
        trigger = { type: 'VISIT_AFTER', status: String(t.status), delayHours: int(t.delayHours ?? 0, 0, 168) };
        break;
      case 'NO_VISIT':
        trigger = { type: 'NO_VISIT', days: int(t.days, 30, 1095) };
        break;
      case 'TREATMENT_OPEN':
        trigger = { type: 'TREATMENT_OPEN', days: int(t.days, 7, 365) };
        break;
      case 'BIRTHDAY':
        trigger = { type: 'BIRTHDAY' };
        break;
      default:
        throw new BadRequestException('bad_automation');
    }
    const c = d.conditions ?? {};
    const conditions: Conditions = {
      ...(c.noOtherFutureVisit ? { noOtherFutureVisit: true } : {}),
      ...(c.source?.trim() ? { source: c.source.trim().slice(0, 60) } : {}),
      ...(c.minVisits !== undefined && c.minVisits !== null ? { minVisits: int(c.minVisits, 0, 1000) } : {}),
      ...(c.maxVisits !== undefined && c.maxVisits !== null ? { maxVisits: int(c.maxVisits, 0, 1000) } : {}),
      ...(c.doctor?.trim() ? { doctor: c.doctor.trim().slice(0, 80) } : {}),
      ...(c.service?.trim() ? { service: c.service.trim().slice(0, 80) } : {}),
    };
    // a doctor or a service exists only for a visit
    if ((conditions.doctor || conditions.service) && !['VISIT_BEFORE', 'VISIT_AFTER'].includes(trigger.type)) throw new BadRequestException('bad_automation');
    const text = (d.action?.text ?? '').trim();
    if (!['SEND_MESSAGE', 'CREATE_REQUEST'].includes(d.action?.type) || text.length < 10 || text.length > 600) throw new BadRequestException('bad_automation');
    if ([...text.matchAll(/\{(\w+)\}/g)].some((x) => !PLACEHOLDERS.has(x[1]))) throw new BadRequestException('bad_template');
    // Nothing about a visit makes sense for a birthday or "no visit" trigger
    if (['NO_VISIT', 'BIRTHDAY', 'TREATMENT_OPEN'].includes(trigger.type) && /\{(date|time)\}/.test(text)) throw new BadRequestException('bad_template');
    const s = d.stop ?? {};
    return { name, kind: d.kind, trigger, conditions, action: { type: d.action.type, text }, stop: { ...(s.ifBooked ? { ifBooked: true } : {}), ...(s.ifReplied ? { ifReplied: true } : {}) }, templateKey: d.templateKey ?? null };
  }

  templates() {
    return TEMPLATES;
  }

  async list(clinicId: string) {
    const rows = await this.prisma.automation.findMany({ where: { clinicId }, orderBy: { createdAt: 'asc' } });
    const last = await this.prisma.automationRun.findMany({ where: { clinicId, automationId: { in: rows.map((r) => r.id) } }, orderBy: { at: 'desc' }, distinct: ['automationId'] });
    const byId = new Map(last.map((r) => [r.automationId, r]));
    return rows.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, kind: r.kind, trigger: r.trigger, conditions: r.conditions, action: r.action, stop: r.stop, templateKey: r.templateKey, lastRun: byId.get(r.id) ? { at: byId.get(r.id)!.at, candidates: byId.get(r.id)!.candidates, queued: byId.get(r.id)!.queued, requests: byId.get(r.id)!.requests } : null }));
  }

  async create(clinicId: string, userId: string, d: AutomationInput) {
    const data = this.clean(d);
    if ((await this.prisma.automation.count({ where: { clinicId } })) >= MAX_AUTOMATIONS) throw new BadRequestException('automation_limit');
    const row = await this.prisma.automation.create({ data: { clinicId, name: data.name, kind: data.kind, trigger: data.trigger as object, conditions: data.conditions as object, action: data.action as object, stop: data.stop as object, templateKey: data.templateKey ?? null, createdById: userId } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'automation.created', details: { id: row.id, trigger: data.trigger.type } } });
    return row.id;
  }

  // Changing what an automation does switches it off: it is looked at (preview) and switched on again on purpose
  async update(clinicId: string, userId: string, id: string, d: Partial<AutomationInput> & { enabled?: boolean }) {
    const cur = await this.prisma.automation.findFirst({ where: { id, clinicId } });
    if (!cur) throw new NotFoundException('automation_not_found');
    const content = d.name !== undefined || d.kind !== undefined || d.trigger !== undefined || d.conditions !== undefined || d.action !== undefined || d.stop !== undefined;
    let data: Prisma.AutomationUpdateInput = {};
    if (content) {
      const merged = this.clean({ name: d.name ?? cur.name, kind: (d.kind ?? cur.kind) as 'service' | 'marketing', trigger: (d.trigger ?? cur.trigger) as Trigger, conditions: (d.conditions ?? cur.conditions) as Conditions, action: (d.action ?? cur.action) as Action, stop: (d.stop ?? cur.stop) as Stop, templateKey: cur.templateKey });
      data = { name: merged.name, kind: merged.kind, trigger: merged.trigger as object, conditions: merged.conditions as object, action: merged.action as object, stop: merged.stop as object, enabled: false };
    }
    if (d.enabled !== undefined) data.enabled = d.enabled;
    await this.prisma.automation.update({ where: { id }, data });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'automation.changed', details: { id, enabled: d.enabled, content } } });
  }

  async remove(clinicId: string, userId: string, id: string) {
    const r = await this.prisma.automation.deleteMany({ where: { id, clinicId } });
    if (!r.count) throw new NotFoundException('automation_not_found');
    // what is still waiting in the queue is cancelled: nobody will send it for an automation that no longer exists
    await this.prisma.outboundMessage.updateMany({ where: { clinicId, ruleKey: { in: [`auto:${id}`, `auto-m:${id}`] }, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } }, data: { status: 'CANCELLED', error: 'Автоматизацію видалено' } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'automation.deleted', details: { id } } });
  }

  async journal(clinicId: string, id: string) {
    const a = await this.prisma.automation.findFirst({ where: { id, clinicId } });
    if (!a) throw new NotFoundException('automation_not_found');
    const ruleKey = a.kind === 'marketing' ? `auto-m:${id}` : `auto:${id}`;
    const [runs, msgs] = await Promise.all([
      this.prisma.automationRun.findMany({ where: { automationId: id }, orderBy: { at: 'desc' }, take: 30 }),
      this.prisma.outboundMessage.groupBy({ by: ['status'], where: { clinicId, ruleKey }, _count: true }),
    ]);
    return { runs, messages: Object.fromEntries(msgs.map((m) => [m.status, m._count])) };
  }

  // ---------- candidates ----------

  private async candidates(clinicId: string, id: string, t: Trigger, now: Date): Promise<Candidate[]> {
    const dm = (d: Date) => clinicDate(d).slice(5).split('-').reverse().join('.');
    if (t.type === 'VISIT_BEFORE') {
      const visits = await this.prisma.visit.findMany({
        where: { clinicId, status: { in: ACTIVE_VISIT }, startsAt: { gt: new Date(now.getTime() + 30 * 60_000), lte: new Date(now.getTime() + 72 * HOUR) }, patient: { removedAt: null } },
        select: { id: true, patientId: true, startsAt: true, bookedAt: true, doctorName: true, serviceName: true },
      });
      return visits
        .filter((v) => v.startsAt.getTime() - t.hours * HOUR <= now.getTime() && !(v.bookedAt && v.bookedAt.getTime() > v.startsAt.getTime() - t.hours * HOUR))
        .map((v) => ({ patientId: v.patientId, visitId: v.id, doctorName: v.doctorName, serviceName: v.serviceName, dedupeKey: `auto:${id}:v:${v.id}`, vars: { date: dm(v.startsAt), time: clinicHm(v.startsAt) }, expiresAt: v.startsAt }));
    }
    if (t.type === 'VISIT_AFTER') {
      const at = t.delayHours * HOUR;
      const visits = await this.prisma.visit.findMany({
        where: { clinicId, status: t.status, startsAt: { gte: new Date(now.getTime() - at - 36 * HOUR), lte: new Date(now.getTime() - at) }, patient: { removedAt: null } },
        select: { id: true, patientId: true, startsAt: true, doctorName: true, serviceName: true },
      });
      return visits.map((v) => ({ patientId: v.patientId, visitId: v.id, doctorName: v.doctorName, serviceName: v.serviceName, dedupeKey: `auto:${id}:v:${v.id}`, vars: { date: dm(v.startsAt), time: clinicHm(v.startsAt) }, expiresAt: new Date(v.startsAt.getTime() + at + 3 * DAY) }));
    }
    if (t.type === 'BIRTHDAY') {
      const [, mm, dd] = clinicDate(now).split('-');
      const rows = await this.prisma.patient.findMany({ where: { clinicId, removedAt: null, birthDate: { not: null } }, select: { id: true, birthDate: true } });
      const year = clinicDate(now).slice(0, 4);
      return rows.filter((p) => p.birthDate!.toISOString().slice(5, 10) === `${mm}-${dd}`).map((p) => ({ patientId: p.id, dedupeKey: `auto:${id}:p:${p.id}:${year}`, vars: {}, expiresAt: new Date(now.getTime() + 20 * HOUR) }));
    }
    // NO_VISIT and TREATMENT_OPEN: the period ran out within the last 14 days (switching on does not write to the whole history)
    const dueTo = new Date(now.getTime() - t.days * DAY);
    const dueFrom = new Date(dueTo.getTime() - 14 * DAY);
    let onlyIds: string[] | undefined;
    if (t.type === 'TREATMENT_OPEN') {
      const open = await this.prisma.planItem.findMany({ where: { clinicId, status: { in: ['NEW', 'PLANNED_TO_DO'] } }, select: { patientId: true }, distinct: ['patientId'] });
      const started = await this.prisma.planItem.findMany({ where: { clinicId, status: { in: ['DONE', 'INVOICED'] }, patientId: { in: open.map((o) => o.patientId) } }, select: { patientId: true }, distinct: ['patientId'] });
      onlyIds = started.map((x) => x.patientId);
      if (!onlyIds.length) return [];
    }
    const patients = await this.prisma.patient.findMany({ where: { clinicId, removedAt: null, ...(onlyIds ? { id: { in: onlyIds } } : {}), lastVisitAt: { not: null, gte: dueFrom, lte: dueTo } }, select: { id: true, lastVisitAt: true } });
    return patients.map((p) => ({ patientId: p.id, dedupeKey: `auto:${id}:p:${p.id}:${clinicDate(p.lastVisitAt!).slice(0, 7)}`, vars: {} }));
  }

  // ---------- plan ----------

  // Looks for people the automation applies to. dryRun only counts and shows examples. `draft` previews something not saved yet.
  async plan(clinicId: string, a: { id: string; name: string; enabled: boolean; kind: string; trigger: Trigger; conditions: Conditions; action: Action }, opts: { dryRun: boolean; now?: Date }): Promise<Report> {
    const now = opts.now ?? new Date();
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true, autoSendService: true, assumeConsent: true } });
    const report: Report = { id: a.id, name: a.name, enabled: a.enabled, candidates: 0, toDo: 0, alreadyDone: 0, skipped: {}, sample: [] };
    const skip = (k: string) => (report.skipped[k] = (report.skipped[k] ?? 0) + 1);
    let cands = await this.candidates(clinicId, a.id, a.trigger, now);
    // One action per patient per check, so a patient with two visits is not written to twice in one go
    const seen = new Set<string>();
    cands = cands.filter((c) => (seen.has(c.patientId) ? false : (seen.add(c.patientId), true)));
    report.candidates = cands.length;
    if (!cands.length) return report;

    const ids = [...new Set(cands.map((c) => c.patientId))];
    const [patients, done, futures, counts] = await Promise.all([
      this.prisma.patient.findMany({ where: { clinicId, id: { in: ids } }, select: { id: true, fullName: true, source: true, consent: true, automationPaused: true, channels: { where: { channel: 'TELEGRAM', optedOutAt: null }, select: { id: true } } } }),
      this.prisma.automationHit.findMany({ where: { automationId: a.id, dedupeKey: { in: cands.map((c) => c.dedupeKey) } }, select: { dedupeKey: true } }),
      this.prisma.visit.findMany({ where: { clinicId, patientId: { in: ids }, status: { in: ACTIVE_VISIT }, startsAt: { gt: now } }, select: { id: true, patientId: true } }),
      this.prisma.visit.groupBy({ by: ['patientId'], where: { clinicId, patientId: { in: ids }, status: 'VISITED' }, _count: true }),
    ]);
    const pm = new Map(patients.map((p) => [p.id, p]));
    const doneKeys = new Set(done.map((d) => d.dedupeKey));
    const visitCount = new Map(counts.map((c) => [c.patientId, c._count]));
    const marketing = a.kind === 'marketing';
    const tooSoon = marketing ? await this.planner.recentlyContacted(clinicId, ids, now) : new Set<string>();
    const c = a.conditions;
    const like = (hay: string | null | undefined, needle: string) => (hay ?? '').toLowerCase().includes(needle.toLowerCase());

    const create: Prisma.OutboundMessageCreateManyInput[] = [];
    const hits: Prisma.AutomationHitCreateManyInput[] = [];
    const requests: { c: Candidate; text: string; name: string }[] = [];
    for (const cand of cands) {
      if (doneKeys.has(cand.dedupeKey)) {
        report.alreadyDone++;
        continue;
      }
      const p = pm.get(cand.patientId);
      if (!p) continue;
      // conditions of the clinic
      if (c.source && !like(p.source, c.source)) { skip('source'); continue; }
      const n = visitCount.get(p.id) ?? 0;
      if (c.minVisits !== undefined && n < c.minVisits) { skip('minVisits'); continue; }
      if (c.maxVisits !== undefined && n > c.maxVisits) { skip('maxVisits'); continue; }
      if (c.doctor && !like(cand.doctorName, c.doctor)) { skip('doctor'); continue; }
      if (c.service && !like(cand.serviceName, c.service)) { skip('service'); continue; }
      if (c.noOtherFutureVisit && futures.some((f) => f.patientId === p.id && f.id !== cand.visitId)) { skip('hasFutureVisit'); continue; }
      const text = render(a.action.text, { fullName: p.fullName, clinic: clinic.name, ...cand.vars });
      if (a.action.type === 'CREATE_REQUEST') {
        report.toDo++;
        if (report.sample.length < 5) report.sample.push({ patient: p.fullName, text });
        requests.push({ c: cand, text, name: p.fullName });
        hits.push({ clinicId, automationId: a.id, dedupeKey: cand.dedupeKey, patientId: p.id, outcome: 'REQUEST' });
        continue;
      }
      if (p.automationPaused || p.consent === 'WITHDRAWN') { skip('paused'); continue; }
      if (marketing && !marketingAllowed(p.consent, clinic.assumeConsent)) { skip('noConsent'); continue; }
      if (marketing && tooSoon.has(p.id)) { skip('tooSoon'); continue; }
      if (!p.channels.length) { skip('noChannel'); continue; }
      report.toDo++;
      if (report.sample.length < 5) report.sample.push({ patient: p.fullName, text });
      create.push({ clinicId, patientId: p.id, ruleKey: `${marketing ? 'auto-m' : 'auto'}:${a.id}`, channel: 'TELEGRAM', text, status: !marketing && clinic.autoSendService ? 'APPROVED' : 'PENDING_APPROVAL', scheduledFor: now, expiresAt: cand.expiresAt, dedupeKey: cand.dedupeKey, visitId: cand.visitId });
      hits.push({ clinicId, automationId: a.id, dedupeKey: cand.dedupeKey, patientId: p.id, outcome: 'QUEUED' });
    }
    if (!opts.dryRun) {
      if (create.length) await this.prisma.outboundMessage.createMany({ data: create, skipDuplicates: true });
      for (const r of requests) await this.requests.upsert(clinicId, { channel: 'AUTOMATION', chatId: `auto-${a.id}-${r.c.patientId}`, patientId: r.c.patientId, contactName: r.name, kind: 'HANDOFF', summary: r.text });
      if (hits.length) await this.prisma.automationHit.createMany({ data: hits, skipDuplicates: true });
      await this.prisma.automationRun.create({ data: { clinicId, automationId: a.id, candidates: report.candidates, queued: create.length, requests: requests.length, skipped: report.skipped as object } });
    }
    return report;
  }

  async preview(clinicId: string, id: string): Promise<Report> {
    const a = await this.prisma.automation.findFirst({ where: { id, clinicId } });
    if (!a) throw new NotFoundException('automation_not_found');
    return this.plan(clinicId, { id: a.id, name: a.name, enabled: a.enabled, kind: a.kind, trigger: a.trigger as unknown as Trigger, conditions: a.conditions as Conditions, action: a.action as unknown as Action }, { dryRun: true });
  }

  // A draft that is not saved yet: the same counting, to look at the audience before creating
  async previewDraft(clinicId: string, d: AutomationInput): Promise<Report> {
    const c = this.clean(d);
    return this.plan(clinicId, { id: 'draft', name: c.name, enabled: false, kind: c.kind, trigger: c.trigger, conditions: c.conditions ?? {}, action: c.action }, { dryRun: true });
  }

  async planClinic(clinicId: string, now = new Date()): Promise<Report[]> {
    const c = await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { suspendedAt: true, isDemo: true, billingStatus: true, paidUntil: true } });
    if (!c || c.suspendedAt || c.isDemo || (billingEnforced() && accessBlocked(c))) return [];
    const rows = await this.prisma.automation.findMany({ where: { clinicId, enabled: true } });
    const out: Report[] = [];
    for (const a of rows) out.push(await this.plan(clinicId, { id: a.id, name: a.name, enabled: true, kind: a.kind, trigger: a.trigger as unknown as Trigger, conditions: a.conditions as Conditions, action: a.action as unknown as Action }, { dryRun: false, now }));
    return out;
  }

  async planAll(now = new Date()) {
    const clinics = await this.prisma.automation.findMany({ where: { enabled: true }, distinct: ['clinicId'], select: { clinicId: true } });
    for (const c of clinics) await this.planClinic(c.clinicId, now).catch((e) => this.log.warn(`Automations ${c.clinicId}: ${(e as Error).message}`));
  }

  // Checked by the queue right before sending: why this message must not go. null means it may go.
  async stopReason(m: { clinicId: string; patientId: string; ruleKey: string; createdAt: Date }, now = new Date()): Promise<string | null> {
    const id = m.ruleKey.slice(m.ruleKey.indexOf(':') + 1);
    const a = await this.prisma.automation.findFirst({ where: { id, clinicId: m.clinicId } });
    if (!a || !a.enabled) return 'Автоматизацію вимкнено або видалено';
    const stop = a.stop as Stop;
    if (stop.ifBooked && (await this.prisma.visit.count({ where: { clinicId: m.clinicId, patientId: m.patientId, status: { in: ACTIVE_VISIT }, startsAt: { gt: now } } }))) return 'Пацієнт уже записаний';
    if (stop.ifReplied && (await this.prisma.chatMessage.count({ where: { clinicId: m.clinicId, patientId: m.patientId, direction: 'IN', createdAt: { gt: m.createdAt } } }))) return 'Пацієнт уже відповів';
    return null;
  }
}
