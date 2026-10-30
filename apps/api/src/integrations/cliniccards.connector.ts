import {
  ClinicConnector,
  CreateVisitRequest,
  CreatePatientRequest,
  UpdateVisitRequest,
  ExternalBlock,
  ExternalInvoice,
  ExternalCabinet,
  ExternalPatient,
  ExternalPlan,
  ExternalReminder,
  ExternalProfile,
  ExternalPayment,
  ExternalPlanItem,
  ExternalShift,
  ExternalVisit,
  SyncWindow,
} from './connector';
import { CliniccardsClient, CliniccardsError } from './cliniccards.client';
import { clinicDate, clinicHm, localToUtc } from '../common/clinic-time';

// Проверено на живой клинике: Cliniccards отдаёт тысячи строк за один запрос (все пациенты за 0,7 с,
// три года пунктов планов — 25 тысяч строк за 1,9 с). Лимит запросов 60 в минуту, поэтому важнее число запросов,
// чем размер ответа. Если на какой-то клинике большой период не пройдёт, коннектор сам перейдёт на мелкие отрезки.
const PAGE = 1000;
const CHUNK_DAYS = 365;
const SMALL_CHUNK_DAYS = 31;
// Логотип хранится строкой в базе и отдаётся в каждом /auth/me: ограничиваем размер (~700 КБ картинки)
const MAX_LOGO = 1_000_000;
const DAY = 86_400_000;

type Id = string | number;

interface RawPatient {
  patient_id: Id;
  firstname?: string;
  lastname?: string;
  phone?: string;
  source?: string | null;
  preferred_contact?: string | null;
  last_visit_date?: string | null;
  first_visit_date?: string | null;
  birthday?: string | null;
  date_created?: string | null;
  balance_issued?: string | number | null;
  balance_paid?: string | number | null;
}

// Statuses used when writing. NOT VERIFIED on a live clinic: the documentation lists the status names but not which one a new visit takes.
export const VISIT_STATUS = { created: 'PLANNED', confirmed: 'CONFIRMED', cancelled: 'CANCELLED' } as const;

// Text fields of Cliniccards come with HTML entities (&#34; &quot; &amp; ...)
export function decodeEntities(s: string): string {
  const named: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === '#') {
      const code = g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return named[g.toLowerCase()] ?? m;
  });
}

interface RawVisit {
  visit_id: Id;
  patient_id: Id;
  status: string;
  doctor?: string;
  doctor_id?: Id;
  cabinet_id?: Id;
  visit_start: string;
  visit_end?: string;
  date_created?: string | null;
  price_items?: { price_item_name?: string; price?: string | number }[] | null;
}

interface RawPlanItem {
  plan_item_id: Id;
  patient_id: Id;
  plan_id: Id;
  price_group_name?: string | null;
  name?: string;
  price?: string | number | null;
  status: string;
  date_created: string;
  marked_done_date?: string | null;
  done_by_doctor_id?: Id | null;
}

interface RawPayment {
  payment_id: Id;
  patient_id?: Id | null;
  date: string;
  amount: string | number;
  type?: string;
}

interface RawInvoice {
  id: Id;
  patient_id?: Id | null;
  date_created: string;
  amount: string | number;
  issuer_name?: string;
}

interface RawShift {
  schedule_shift_id: Id;
  schedule_cabinets_id: Id;
  schedule_cabinet_name?: string;
  doctor?: string;
  doctor_id: Id;
  shift_start: string;
  shift_end: string;
}

interface RawBlock {
  schedule_space_id: Id;
  schedule_cabinets_id: Id;
  note?: string;
  space_start: string;
  space_end: string;
}

interface RawCabinet {
  cabinet_id: Id;
  name?: string | null;
}

interface RawPlan {
  plan_id: Id;
  date_created: string;
  plan_total?: string | number | null;
  plan_total_done?: string | number | null;
  plan_total_with_discount?: string | number | null;
  plan_total_done_with_discount?: string | number | null;
}

interface RawReminder {
  id: Id;
  patient_id?: Id | null;
  date: string;
  note?: string | null;
  status?: string;
}

// Дата без времени остаётся «чистой» датой (полночь UTC), чтобы день не сдвигался
const toDate = (s?: string | null) => {
  if (!s || s.startsWith('0000')) return undefined;
  return s.length > 10 ? localToUtc(s) : new Date(s + 'T00:00:00Z');
};
const num = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : Number(v));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const str = (v: Id | null | undefined) => (v === null || v === undefined ? undefined : String(v));

export class CliniccardsConnector implements ClinicConnector {
  constructor(private readonly client: CliniccardsClient) {}

  // Период режем на крупные отрезки (год). Если Cliniccards отказал на большом отрезке (ошибка запроса, не лимит
  // частоты), этот отрезок перечитывается мелкими по 31 дню, чтобы загрузка не ломалась из-за размера ответа.
  private async chunked<T>(path: string, { from, to }: SyncWindow, days = CHUNK_DAYS): Promise<T[]> {
    const out: T[] = [];
    for (let start = new Date(from); start <= to; start = new Date(start.getTime() + days * DAY)) {
      const end = new Date(Math.min(start.getTime() + (days - 1) * DAY, to.getTime()));
      try {
        out.push(...(await this.client.get<T[]>(path, { from: iso(start), to: iso(end) })));
      } catch (e) {
        if (days <= SMALL_CHUNK_DAYS || !(e instanceof CliniccardsError) || /нет связи/.test(e.message)) throw e;
        out.push(...(await this.chunked<T>(path, { from: start, to: end }, SMALL_CHUNK_DAYS)));
      }
    }
    return out;
  }

  // Field names follow the POST/PUT /visits documentation. NOT VERIFIED on a live clinic (see .claude/docs/cliniccards-api.md):
  // the accepted `status` of a new visit, whether `doctor_id` is required, the shape of the reply.
  private checkTimes(startsAt: Date, endsAt: Date) {
    const minutes = (d: Date) => Number(clinicHm(d).slice(3, 5));
    if (minutes(startsAt) % 5 || minutes(endsAt) % 5) throw new CliniccardsError('Час запису має бути кратним 5 хвилинам');
    if (clinicDate(startsAt) !== clinicDate(endsAt) || endsAt <= startsAt) throw new CliniccardsError('Запис має починатися й закінчуватися в один день');
  }

  async createVisit(req: CreateVisitRequest): Promise<{ externalId: string }> {
    const note = req.note.trim();
    if (!note || note.length > 400) throw new CliniccardsError('Примітка до запису має бути від 1 до 400 символів');
    this.checkTimes(req.startsAt, req.endsAt);
    const data = await this.client.post<{ visit_id?: number | string } | number | string>('/visits', {
      status: VISIT_STATUS.created,
      patient_id: Number(req.patientExternalId),
      cabinet_id: Number(req.cabinetId),
      ...(req.doctorId ? { doctor_id: Number(req.doctorId) } : {}),
      note,
      date: clinicDate(req.startsAt),
      time_start: clinicHm(req.startsAt),
      time_end: clinicHm(req.endsAt),
    });
    const id = typeof data === 'object' && data !== null ? data.visit_id : data;
    if (id === undefined || id === null || id === '') throw new CliniccardsError('Cliniccards не повернув ідентифікатор запису', true);
    return { externalId: String(id) };
  }

  // PUT /visits needs every field again, so the current visit is read first and only the requested fields change
  async updateVisit(externalId: string, req: UpdateVisitRequest): Promise<void> {
    const day = clinicDate(req.currentStartsAt);
    const rows = await this.client.get<(RawVisit & { note?: string })[]>('/visits', { from: day, to: day });
    const cur = rows.find((v) => String(v.visit_id) === externalId);
    if (!cur) throw new CliniccardsError('Запис не знайдено в Cliniccards (можливо, її вже змінили)');
    const startsAt = req.startsAt ?? toDate(cur.visit_start)!;
    const endsAt = req.endsAt ?? (req.startsAt ? new Date(req.startsAt.getTime() + ((toDate(cur.visit_end)?.getTime() ?? startsAt.getTime() + 1_800_000) - toDate(cur.visit_start)!.getTime())) : toDate(cur.visit_end)!);
    this.checkTimes(startsAt, endsAt);
    const doctorId = req.doctorId ?? str(cur.doctor_id);
    await this.client.put('/visits', {
      visit_id: Number(externalId),
      status: req.status ?? cur.status,
      patient_id: Number(cur.patient_id),
      cabinet_id: Number(req.cabinetId ?? cur.cabinet_id),
      ...(doctorId ? { doctor_id: Number(doctorId) } : {}),
      // the existing note is kept; Cliniccards requires a non-empty one
      note: (cur.note ?? '').trim() || 'LANKA',
      date: clinicDate(startsAt),
      time_start: clinicHm(startsAt),
      time_end: clinicHm(endsAt),
    });
  }

  // The `phone` filter of GET /patients is NOT VERIFIED on a live clinic; if it is ignored the caller sees too many ids and refuses to guess
  async findPatientIdsByPhone(phone: string): Promise<string[]> {
    const rows = await this.client.get<{ patient_id: Id; phone?: string | null; phone2?: string | null }[]>('/patients', { phone, limit: 20, offset: 0 });
    const want = phone.replace(/\D/g, '');
    return rows.filter((p) => [p.phone, p.phone2].some((x) => (x ?? '').replace(/\D/g, '').endsWith(want.slice(-9)))).map((p) => String(p.patient_id));
  }

  async createPatient(req: CreatePatientRequest): Promise<{ externalId: string }> {
    const data = await this.client.post<{ patient_id?: number | string } | number | string>('/patients', {
      lastname: req.lastName,
      firstname: req.firstName,
      phone: req.phone,
      ...(req.source ? { source: req.source } : {}),
    });
    const id = typeof data === 'object' && data !== null ? data.patient_id : data;
    if (id === undefined || id === null || id === '') throw new CliniccardsError('Cliniccards не повернув ідентифікатор пацієнта', true);
    return { externalId: String(id) };
  }

  // GET /prices (checked on a live clinic: 234 rows, fields as below). One row per price item with its group. There is no currency field,
  // while Cliniccards lets a currency be chosen per item, so a price is only a suggestion that a person confirms. Names come with
  // HTML entities (&#34;), a price of "0" means "not set" (consultations), `item_additional` is what the service includes.
  async fetchServiceList() {
    const rows = await this.client.get<{ group_name?: string | null; item_id?: Id; item_name?: string | null; item_price?: string | number | null; item_additional?: string | null }[]>('/prices');
    const out: { externalId: string; name: string; groupName?: string; description?: string; priceUah?: number }[] = [];
    for (const r of rows ?? []) {
      const name = decodeEntities(r.item_name ?? '').trim();
      if (r.item_id === undefined || r.item_id === null || !name) continue;
      const price = num(r.item_price);
      const group = decodeEntities(r.group_name ?? '').trim();
      const description = decodeEntities(r.item_additional ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
      out.push({ externalId: String(r.item_id), name, ...(group ? { groupName: group } : {}), ...(description ? { description } : {}), ...(price !== undefined && price > 0 ? { priceUah: price } : {}) });
    }
    return out;
  }

  async fetchCabinets(): Promise<ExternalCabinet[]> {
    const rows = await this.client.get<RawCabinet[]>('/cabinets');
    return (rows ?? []).filter((c) => c.cabinet_id !== undefined && c.cabinet_id !== null).map((c) => ({ externalId: String(c.cabinet_id), name: c.name?.trim() || `#${c.cabinet_id}` }));
  }

  async fetchPlans(window: SyncWindow): Promise<ExternalPlan[]> {
    const out = new Map<string, ExternalPlan>();
    for (const p of await this.chunked<RawPlan>('/plans', window)) {
      const createdAt = toDate(p.date_created);
      const total = num(p.plan_total_with_discount ?? p.plan_total);
      if (!createdAt || total === undefined) continue;
      out.set(String(p.plan_id), {
        externalId: String(p.plan_id),
        total,
        totalDone: num(p.plan_total_done_with_discount ?? p.plan_total_done) ?? 0,
        createdAt,
      });
    }
    return [...out.values()];
  }

  async fetchReminders(window: SyncWindow): Promise<ExternalReminder[]> {
    const out: ExternalReminder[] = [];
    for (const r of await this.chunked<RawReminder>('/reminders', window)) {
      const dueDate = toDate(r.date);
      if (!dueDate) continue;
      out.push({
        externalId: String(r.id),
        patientExternalId: str(r.patient_id),
        dueDate,
        note: r.note || undefined,
        status: String(r.status ?? 'NEW').toUpperCase(),
      });
    }
    return out;
  }

  async fetchProfile(): Promise<ExternalProfile> {
    const p = await this.client.get<{ logo?: string | null }>('/clinic-profile');
    // Только растровые форматы и разумный размер: SVG не принимаем, он может содержать скрипты
    const logo = p?.logo;
    const ok = typeof logo === 'string' && logo.length <= MAX_LOGO && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(logo);
    return { logo: ok ? logo : undefined };
  }

  async fetchPatients(): Promise<ExternalPatient[]> {
    const out: ExternalPatient[] = [];
    // Читаем до пустой страницы и сдвигаем начало на число реально пришедших строк: если сервер когда-нибудь
    // отдаст страницу меньше запрошенной (свой потолок), пациенты не потеряются
    for (let offset = 0; ; ) {
      const page = await this.client.get<RawPatient[]>('/patients', { limit: PAGE, offset });
      if (!page.length) return out;
      offset += page.length;
      for (const p of page) {
        out.push({
          externalId: String(p.patient_id),
          fullName: [p.lastname, p.firstname].filter(Boolean).join(' ') || `#${p.patient_id}`,
          phone: p.phone || undefined,
          source: p.source || undefined,
          preferredContact: p.preferred_contact || undefined,
          lastVisitAt: toDate(p.last_visit_date),
          createdAt: toDate(p.date_created),
          firstVisitAt: toDate(p.first_visit_date),
          birthday: toDate(p.birthday),
          balanceIssued: num(p.balance_issued),
          balancePaid: num(p.balance_paid),
        });
      }
    }
  }

  async fetchVisits(window: SyncWindow): Promise<ExternalVisit[]> {
    const out: ExternalVisit[] = [];
    for (const v of await this.chunked<RawVisit>('/visits', window)) {
      const startsAt = toDate(v.visit_start);
      if (!startsAt) continue;
      const items = v.price_items ?? [];
      out.push({
        externalId: String(v.visit_id),
        patientExternalId: String(v.patient_id),
        doctorId: str(v.doctor_id),
        doctorName: v.doctor,
        cabinetId: str(v.cabinet_id),
        serviceName: items.map((i) => i.price_item_name).filter(Boolean).join(', ') || undefined,
        startsAt,
        endsAt: toDate(v.visit_end),
        bookedAt: toDate(v.date_created),
        status: v.status,
        amount: items.length ? items.reduce((s, i) => s + (num(i.price) ?? 0), 0) : undefined,
      });
    }
    return dedupe(out);
  }

  // Период в /planItems, по нашему допущению, отбирает пункты по дате создания (в документации не уточняется)
  async fetchTreatment(window: SyncWindow): Promise<ExternalPlanItem[]> {
    const out: ExternalPlanItem[] = [];
    for (const i of await this.chunked<RawPlanItem>('/planItems', window)) {
      const createdAt = toDate(i.date_created);
      if (!createdAt) continue;
      out.push({
        externalId: String(i.plan_item_id),
        patientExternalId: String(i.patient_id),
        planId: String(i.plan_id),
        name: i.name ?? '',
        price: num(i.price),
        status: i.status,
        groupName: i.price_group_name?.trim() || undefined,
        createdAt,
        markedDoneAt: toDate(i.marked_done_date),
        doneByDoctorId: str(i.done_by_doctor_id),
      });
    }
    return dedupe(out);
  }

  async fetchFinance(window: SyncWindow) {
    const payments: ExternalPayment[] = [];
    for (const p of await this.chunked<RawPayment>('/payments', window)) {
      const paidAt = toDate(p.date);
      const amount = num(p.amount);
      if (!paidAt || amount === undefined) continue;
      payments.push({ externalId: String(p.payment_id), patientExternalId: str(p.patient_id), paidAt, amount, type: p.type });
    }
    const invoices: ExternalInvoice[] = [];
    for (const i of await this.chunked<RawInvoice>('/invoices', window)) {
      const issuedAt = toDate(i.date_created);
      const amount = num(i.amount);
      if (!issuedAt || amount === undefined) continue;
      invoices.push({ externalId: String(i.id), patientExternalId: str(i.patient_id), issuedAt, amount, issuerName: i.issuer_name });
    }
    return { payments: dedupe(payments), invoices: dedupe(invoices) };
  }

  async fetchSchedule(window: SyncWindow) {
    const shifts: ExternalShift[] = [];
    for (const s of await this.chunked<RawShift>('/schedule-shifts', window)) {
      const startsAt = toDate(s.shift_start);
      const endsAt = toDate(s.shift_end);
      if (!startsAt || !endsAt) continue;
      shifts.push({
        externalId: String(s.schedule_shift_id),
        doctorId: String(s.doctor_id),
        doctorName: s.doctor,
        cabinetId: String(s.schedule_cabinets_id),
        cabinetName: s.schedule_cabinet_name,
        startsAt,
        endsAt,
      });
    }
    const blocks: ExternalBlock[] = [];
    for (const b of await this.chunked<RawBlock>('/schedule-spaces', window)) {
      const startsAt = toDate(b.space_start);
      const endsAt = toDate(b.space_end);
      if (!startsAt || !endsAt) continue;
      blocks.push({ externalId: String(b.schedule_space_id), cabinetId: String(b.schedule_cabinets_id), startsAt, endsAt, note: b.note || undefined });
    }
    return { shifts: dedupe(shifts), blocks: dedupe(blocks) };
  }
}

// Отрезки периода могут пересекаться на границах: убираем повторы по ID
function dedupe<T extends { externalId: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((r) => [r.externalId, r])).values()];
}
