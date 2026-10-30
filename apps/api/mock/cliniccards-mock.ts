import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

// Крошечный PNG 1×1: имитация логотипа клиники
const MOCK_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Локальная имитация API Cliniccards по документации (https://cliniccards.com/api): те же адреса,
// заголовки, формат ответа {data, result, error}, постраничная выдача пациентов, лимит запросов.
// Нужна, чтобы проверять коннектор без доступа к настоящей клинике. Данные искусственные, но
// содержат «грязные» случаи, которые бывают в реальности (пустой телефон, дата 0000-00-00,
// price_items = null, числовые и строковые ID вперемешку, пункты плана неизвестного пациента).

export const MOCK_KEY = 'mock-api-key-12345';
const DAY = 86_400_000;

export interface MockOptions {
  key?: string;
  patients?: number;
  // Запросов в минуту на ключ (в настоящем API 60)
  rateLimitPerMinute?: number;
  seed?: number;
  // Имитация потолков сервера (в тестах запасных вариантов коннектора): больше строк за страницу или дней за период он не отдаёт
  maxPageSize?: number;
  maxPeriodDays?: number;
}

type Json = Record<string, unknown>;

export interface MockData {
  patients: Json[];
  visits: Json[];
  planItems: Json[];
  payments: Json[];
  invoices: Json[];
  shifts: Json[];
  spaces: Json[];
  staff: Json[];
  cabinets: Json[];
  reminders: Json[];
  plans: Json[];
}

export interface MockHandle {
  url: string;
  server: Server;
  data: MockData;
  requests: { path: string; query: Record<string, string> }[];
  // Writes received (method, path, body), and switches for failure tests
  writes: { method: string; path: string; body: Json }[];
  control: { failWith?: number; dropReplyAfterWrite?: boolean };
  close(): Promise<void>;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
// Время клиники приходит без часового пояса: формат «YYYY-MM-DD HH:MM:SS»
const dt = (d: Date) => `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}`;
const day = (d: Date) => d.toISOString().slice(0, 10);
const atMidnight = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * DAY);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

export function buildData(opts: MockOptions = {}): MockData {
  const rand = rng(opts.seed ?? 42);
  const N = opts.patients ?? 450;
  const doctors = [
    { doctor_id: '501', lastname: 'Іваненко', firstname: 'Олег', role: 'DOCTOR', cabinet: '801' },
    { doctor_id: '502', lastname: 'Петренко', firstname: 'Ірина', role: 'DOCTOR', cabinet: '802' },
    { doctor_id: '503', lastname: 'Шевченко', firstname: 'Андрій', role: 'DOCTOR', cabinet: '801' },
  ];
  const staff = [
    ...doctors.map((d) => ({ doctor_id: d.doctor_id, lastname: d.lastname, firstname: d.firstname, role: d.role, phone: '+380670000000' })),
    { doctor_id: '509', lastname: 'Коваль', firstname: 'Марія', role: 'MANAGER', phone: '' },
  ];
  const cabinets = [
    { cabinet_id: '801', name: 'Кабінет 1', order_index: '0' },
    { cabinet_id: '802', name: 'Кабінет 2', order_index: '1' },
  ];
  const sources = ['Instagram', 'Google', 'Рекомендація пацієнта', null];
  const services = [
    { id: 1001, name: 'Консультація', price: 300 },
    { id: 1002, name: 'Лікування карієсу', price: 1500 },
    { id: 1003, name: 'Професійна чистка', price: 1200 },
    { id: 1004, name: 'Пломбування каналу', price: 2800 },
    { id: 1005, name: 'Видалення зуба', price: 900 },
  ];
  const doctorName = (id: string) => {
    const d = doctors.find((x) => x.doctor_id === id)!;
    return `${d.lastname} ${d.firstname}`;
  };

  const visits: Json[] = [];
  const payments: Json[] = [];
  const invoices: Json[] = [];
  const planItems: Json[] = [];
  const patients: Json[] = [];
  let visitId = 7_000_000;
  let payId = 18_000_000;
  let invId = 20_000_000;
  let itemId = 55_000_000;
  let planId = 8_000_000;

  for (let i = 0; i < N; i++) {
    const patientId = 100_000 + i;
    const count = 1 + Math.floor(rand() * 3);
    let lastVisit: Date | null = null;
    let issued = 0;
    let paid = 0;

    for (let k = 0; k < count; k++) {
      const offset = Math.floor(rand() * 260) - 200; // от -200 до +60 дней
      const start = atMidnight(offset);
      start.setUTCHours(9 + Math.floor(rand() * 8), rand() < 0.5 ? 0 : 30, 0, 0);
      const end = new Date(start.getTime() + (30 + Math.floor(rand() * 2) * 30) * 60_000);
      const doc = doctors[Math.floor(rand() * doctors.length)];
      const past = start.getTime() < Date.now();
      const r = rand();
      const status = past
        ? r < 0.75 ? 'VISITED' : r < 0.85 ? 'DID_NOT_COME' : r < 0.95 ? 'CANCELLED' : 'MOVED'
        : r < 0.5 ? 'PLANNED' : r < 0.8 ? 'CONFIRMED' : r < 0.9 ? 'NOT_CONFIRMED' : 'CANCELLED';
      const picked = services.slice(0, 1 + Math.floor(rand() * 2));
      const priceItems =
        rand() < 0.2
          ? null // записи без услуг приходят как null
          : picked.map((s) => ({ price_item_id: s.id, price_item_name: s.name, price_item_code: null, price: s.price.toFixed(2) }));
      visits.push({
        visit_id: String(visitId++),
        patient_id: rand() < 0.5 ? String(patientId) : patientId, // ID приходят и строкой, и числом
        status,
        doctor: doctorName(doc.doctor_id),
        doctor_id: doc.doctor_id,
        date_created: dt(new Date(start.getTime() - 5 * DAY)),
        date_edited: dt(new Date(start.getTime() - 2 * DAY)),
        visit_start: dt(start),
        visit_end: dt(end),
        note: '',
        cabinet: cabinets.find((c) => c.cabinet_id === doc.cabinet)!.name,
        cabinet_id: doc.cabinet,
        price_items: priceItems,
      });
      if (status === 'VISITED') {
        if (!lastVisit || start > lastVisit) lastVisit = start;
        const total = (priceItems ?? []).reduce((s, x) => s + Number(x.price), 0);
        if (total > 0) {
          invoices.push({
            id: invId++,
            patient_id: patientId,
            date_created: day(start),
            amount: total,
            issuer_id: Number(doc.doctor_id),
            issuer_name: doctorName(doc.doctor_id),
            invoice_type: 'STANDARD',
          });
          issued += total;
          // не все счета оплачены полностью: создаёт задолженность
          const payShare = rand() < 0.8 ? 1 : 0.5;
          paid += total * payShare;
          payments.push({
            payment_id: String(payId++),
            patient_id: rand() < 0.05 ? null : String(patientId), // бывают платежи без пациента
            date: dt(start),
            amount: String(total * payShare),
            type: rand() < 0.5 ? 'CASH' : 'CREDIT_CARD',
            cash_desk_id: '11830',
            invoice_id: null,
          });
        }
      }
    }

    // План лечения у части пациентов: часть пунктов выполнена, часть ждёт
    if (rand() < 0.4) {
      const pid = planId++;
      const total = 3 + Math.floor(rand() * 3);
      const done = Math.floor(rand() * total);
      for (let j = 0; j < total; j++) {
        const created = atMidnight(-Math.floor(rand() * 150));
        const isDone = j < done;
        const svc = services[1 + Math.floor(rand() * 4)];
        planItems.push({
          plan_item_id: String(itemId++),
          patient_id: String(patientId),
          plan_id: String(pid),
          stage_id: String(pid * 10),
          name: svc.name,
          price_group_name: svc.price > 1000 ? 'Терапія' : 'Профілактика',
          price: String(svc.price),
          amount: '1',
          status: isDone ? (rand() < 0.5 ? 'DONE' : 'INVOICED') : rand() < 0.5 ? 'NEW' : 'PLANNED_TO_DO',
          date_created: dt(created),
          done_by_doctor_id: isDone ? doctors[0].doctor_id : null,
          marked_done_date: isDone ? dt(new Date(created.getTime() + 3 * DAY)) : null,
        });
      }
    }

    patients.push({
      patient_id: String(patientId),
      lastname: 'Тестенко',
      firstname: `Пацієнт${i + 1}`,
      source: sources[i % sources.length],
      phone: i % 50 === 0 ? '' : `38050${String(1000000 + i)}`,
      phone2: '',
      email: '',
      gender: i % 2 ? 'F' : 'M',
      birthday: i % 11 === 0 ? null : '1985-05-05',
      curator_id: null,
      date_created: '2024-01-15',
      preferred_contact: i % 3 === 0 ? 'PHONE' : null,
      statuses: [],
      balance_paid: String(paid),
      balance_issued: String(issued),
      first_visit_date: lastVisit ? day(lastVisit) : null,
      last_visit_date: i % 97 === 0 ? '0000-00-00' : lastVisit ? day(lastVisit) : null,
      important_note: '',
      note: '',
      code: `T${i}`,
    });
  }

  // Пункт плана неизвестного пациента (например, архивного): коннектор должен его пропустить
  planItems.push({
    plan_item_id: String(itemId++), patient_id: '999999', plan_id: '1', stage_id: '1', name: 'Консультація', price: '300', amount: '1',
    status: 'NEW', date_created: dt(atMidnight(-10)), done_by_doctor_id: null, marked_done_date: null,
  });

  // Смены врачей: будни, ±30 дней; Шевченко работає у другу половину дня
  const shifts: Json[] = [];
  const spaces: Json[] = [];
  let shiftId = 1_200_000;
  let spaceId = 1_700_000;
  for (let off = -30; off <= 60; off++) {
    const d = atMidnight(off);
    if ([0, 6].includes(d.getUTCDay())) continue;
    for (const doc of doctors) {
      const s = new Date(d);
      s.setUTCHours(doc.doctor_id === '503' ? 13 : 9, 0, 0, 0);
      const e = new Date(d);
      e.setUTCHours(doc.doctor_id === '503' ? 20 : 18, 0, 0, 0);
      shifts.push({
        schedule_shift_id: String(shiftId++),
        schedule_cabinets_id: doc.cabinet,
        schedule_cabinet_name: cabinets.find((c) => c.cabinet_id === doc.cabinet)!.name,
        doctor: doctorName(doc.doctor_id),
        doctor_id: doc.doctor_id,
        shift_start: dt(s),
        shift_end: dt(e),
      });
    }
    // Обідня перерва в кабінеті 1 щодня
    const bs = new Date(d);
    bs.setUTCHours(13, 0, 0, 0);
    const be = new Date(d);
    be.setUTCHours(14, 0, 0, 0);
    spaces.push({
      schedule_space_id: String(spaceId++),
      schedule_cabinets_id: '801',
      schedule_cabinet_name: 'Кабінет 1',
      created_by: 'Коваль Марія',
      created_by_id: '509',
      note: 'Обід',
      type: 'Break',
      space_start: dt(bs),
      space_end: dt(be),
    });
  }

  // Напоминания сотрудникам: по умолчанию пусто, тесты добавляют их сами
  // Итоги планов считаются из пунктов, как в Cliniccards (в тестах отдельные планы подменяются)
  const byPlan = new Map<string, { total: number; done: number; created: string }>();
  for (const i of planItems) {
    const a = byPlan.get(String(i.plan_id)) ?? { total: 0, done: 0, created: String(i.date_created) };
    a.total += Number(i.price);
    if (i.status === 'DONE' || i.status === 'INVOICED') a.done += Number(i.price);
    if (String(i.date_created) < a.created) a.created = String(i.date_created);
    byPlan.set(String(i.plan_id), a);
  }
  const plans: Json[] = [...byPlan].map(([id, a]) => ({
    plan_id: id, plan_name: 'План лікування', doctor_id: '1', date_created: a.created, date_edited: a.created,
    plan_total: String(a.total), plan_total_done: String(a.done), plan_discount: '0',
    plan_total_with_discount: String(a.total), plan_total_done_with_discount: String(a.done), stages_list: {},
  }));
  return { patients, visits, planItems, payments, invoices, shifts, spaces, staff, cabinets, reminders: [], plans };
}

const inRange = (value: unknown, from?: string, to?: string) => {
  const d = String(value ?? '').slice(0, 10);
  return (!from || d >= from) && (!to || d <= to);
};

export async function startMock(opts: MockOptions = {}, port = 0): Promise<MockHandle> {
  const key = opts.key ?? MOCK_KEY;
  const limit = opts.rateLimitPerMinute ?? 60;
  const data = buildData(opts);
  const requests: MockHandle['requests'] = [];
  const writes: MockHandle['writes'] = [];
  const control: MockHandle['control'] = {};
  let nextVisit = 900_000;
  let nextPatient = 800_000;
  let windowStart = Date.now();
  let used = 0;

  const send = (res: ServerResponse, status: number, body: Json) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const ok = (res: ServerResponse, payload: unknown) => send(res, 200, { data: payload, result: 'success', error: null });
  const fail = (res: ServerResponse, status: number, error: string) => send(res, status, { data: null, result: 'fail', error });

  // POST/PUT as in the documentation: required fields are checked the way the real API is said to check them
  const handleWrite = (req: IncomingMessage, res: ServerResponse, path: string, body: Json) => {
    writes.push({ method: req.method ?? '', path, body });
    if (control.failWith) return fail(res, control.failWith, 'Mock failure');
    const reply = (payload: unknown) => {
      if (control.dropReplyAfterWrite) return void req.socket.destroy(); // the write happened, the answer is lost
      return ok(res, payload);
    };
    if (path === '/visits') {
      const need = ['status', 'patient_id', 'cabinet_id', 'date', 'time_start', 'time_end', 'note'];
      for (const f of need) if (body[f] === undefined || body[f] === '') return fail(res, 400, `Field ${f} is required`);
      if (String(body.note).length > 400) return fail(res, 400, 'note is too long');
      if (!/^\d{2}:\d{2}$/.test(String(body.time_start)) || Number(String(body.time_start).slice(3)) % 5) return fail(res, 400, 'time must be a multiple of 5 minutes');
      if (!data.patients.some((p) => String(p.patient_id) === String(body.patient_id))) return fail(res, 400, 'Unknown patient');
      const cab = data.cabinets.find((c) => String(c.cabinet_id) === String(body.cabinet_id));
      if (!cab) return fail(res, 400, 'Unknown cabinet');
      const row = {
        status: body.status, patient_id: String(body.patient_id), doctor_id: body.doctor_id !== undefined ? String(body.doctor_id) : null, doctor: '', cabinet_id: String(body.cabinet_id), cabinet: cab.name,
        date_created: dt(new Date()), date_edited: dt(new Date()), visit_start: `${body.date} ${body.time_start}:00`, visit_end: `${body.date} ${body.time_end}:00`, note: body.note, price_items: null,
      };
      if (req.method === 'POST') {
        const id = String(nextVisit++);
        data.visits.push({ visit_id: id, ...row });
        return reply({ visit_id: id });
      }
      const cur = data.visits.find((v) => String(v.visit_id) === String(body.visit_id));
      if (!cur) return fail(res, 404, 'Visit not found');
      Object.assign(cur, row, { visit_id: cur.visit_id, date_created: cur.date_created, price_items: cur.price_items });
      return reply({ visit_id: String(cur.visit_id) });
    }
    if (path === '/patients') {
      if (req.method === 'POST') {
        for (const f of ['lastname', 'firstname', 'phone']) if (!body[f]) return fail(res, 400, `Field ${f} is required`);
        const id = String(nextPatient++);
        data.patients.push({ patient_id: id, lastname: body.lastname, firstname: body.firstname, phone: String(body.phone).replace(/\D/g, ''), source: body.source ?? '', date_created: dt(new Date()) });
        return reply({ patient_id: id });
      }
    }
    return fail(res, 404, `Unknown method ${path}`);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
    const q = Object.fromEntries(url.searchParams.entries());

    // Настоящее API требует оба заголовка в каждом запросе
    if (req.headers.token !== key) return fail(res, 401, 'Wrong API key');
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) return fail(res, 400, 'Content-Type must be application/json');

    if (Date.now() - windowStart > 60_000) {
      windowStart = Date.now();
      used = 0;
    }
    if (++used > limit) return fail(res, 429, 'Too many requests');

    if (req.method === 'POST' || req.method === 'PUT') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          handleWrite(req, res, path, JSON.parse(raw || '{}'));
        } catch {
          fail(res, 400, 'Bad JSON');
        }
      });
      return;
    }
    if (req.method !== 'GET') return fail(res, 405, 'Mock supports GET, POST and PUT only');
    requests.push({ path, query: q });

    if (opts.maxPeriodDays && q.from && q.to) {
      const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 + 1;
      if (days > opts.maxPeriodDays) return fail(res, 400, 'Period is too long');
    }
    const range = (rows: Json[], field: string) => rows.filter((r) => inRange(r[field], q.from, q.to));

    if (path === '/patients') {
      let rows = data.patients;
      if (q.phone) rows = rows.filter((p) => String(p.phone) === q.phone.replace(/\D/g, ''));
      if (q.limit) {
        const offset = Number(q.offset ?? 0);
        const size = Math.min(Number(q.limit), opts.maxPageSize ?? Infinity);
        rows = [...rows].sort((a, b) => Number(a.patient_id) - Number(b.patient_id)).slice(offset, offset + size);
      }
      return ok(res, rows);
    }
    if (path.startsWith('/patients/')) {
      const ids = path.split('/')[2].split(',');
      return ok(res, data.patients.filter((p) => ids.includes(String(p.patient_id))));
    }
    if (path === '/visits') {
      if (!q.from || !q.to) return fail(res, 400, 'from and to are required');
      return ok(res, range(data.visits, 'visit_start'));
    }
    if (path === '/planItems' || path.startsWith('/planItems/')) {
      const status = path.split('/')[2];
      let rows = range(data.planItems, 'date_created');
      if (status && status !== 'invoiced') rows = rows.filter((r) => r.status === status);
      if (status === 'invoiced') rows = rows.filter((r) => r.status === 'INVOICED');
      return ok(res, rows);
    }
    if (path === '/payments') return ok(res, range(data.payments, 'date'));
    if (path === '/invoices') return ok(res, range(data.invoices, 'date_created'));
    if (path === '/schedule-shifts') return ok(res, range(data.shifts, 'shift_start'));
    if (path === '/schedule-spaces') return ok(res, range(data.spaces, 'space_start'));
    if (path === '/clinic-profile') return ok(res, { id: 1, name: 'Mock', type: 'CLINIC', logo: MOCK_LOGO });
    if (path === '/plans') return ok(res, range(data.plans, 'date_created'));
    if (path === '/reminders') return ok(res, range(data.reminders, 'date').filter((r) => !q.patient_id || String(r.patient_id) === q.patient_id));
    if (path === '/prices') {
      const row = (g: string, gid: string, id: string, name: string, price: string | null) => ({ group_id: gid, group_name: g, group_color: '1', group_additional: null, item_id: id, item_name: name, item_code: null, item_additional: null, item_price: price });
      return ok(res, [{ ...row('Профілактика', '77', '1001', 'Професійна гігєна &#34;Air flow&#34; 1 ступеня', '1200'), item_additional: '— AirFlow\r\n— Полірування' }, row('Терапія', '78', '1002', 'Лікування карієсу', '1800'), row('Консультації', '79', '1003', 'Консультація', '0')]);
    }
    if (path === '/staff') return ok(res, data.staff);
    if (path === '/cabinets') return ok(res, data.cabinets);
    if (path === '/sub-clinics') return ok(res, []);
    return fail(res, 404, `Unknown method ${path}`);
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actual}/api`,
    server,
    data,
    requests,
    writes,
    control,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
