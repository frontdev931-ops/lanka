import {
  ClinicConnector,
  ExternalBlock,
  ExternalInvoice,
  ExternalPatient,
  ExternalPayment,
  ExternalPlanItem,
  ExternalShift,
  ExternalVisit,
} from './connector';

const DAY = 86_400_000;
const DOCTORS = [
  { id: 'demo-d1', name: 'Іваненко', cabinet: 'demo-c1', cabinetName: 'Кабінет 1' },
  { id: 'demo-d2', name: 'Петренко', cabinet: 'demo-c2', cabinetName: 'Кабінет 2' },
];

const midnight = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * DAY);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};
const at = (d: Date, h: number, m = 0) => new Date(d.getTime() + (h * 60 + m) * 60_000);

// Демо-данные, чтобы вся цепочка (синхронізація → звіт) працювала без ключа Cliniccards.
export class DemoConnector implements ClinicConnector {
  // Made-up people: the names are invented and the phones are in a block that is not used by real subscribers
  private static readonly NAMES = [
    'Коваленко Олена', 'Шевченко Андрій', 'Бондаренко Марія', 'Ткаченко Дмитро', 'Кравченко Ірина', 'Мельник Сергій', 'Олійник Наталія', 'Лисенко Віктор',
    'Савченко Оксана', 'Руденко Максим', 'Гончаренко Юлія', 'Паламарчук Олег', 'Жук Тетяна', 'Романюк Богдан', 'Мазур Катерина', 'Поліщук Артем',
    'Литвин Анастасія', 'Кузьменко Денис', 'Яремченко Вікторія', 'Сидоренко Павло', 'Данилюк Софія', 'Гавриленко Роман', 'Тимошенко Дарина', 'Остапенко Ігор',
    'Левченко Христина', 'Мироненко Владислав', 'Чорновол Аліна', 'Дяченко Микита', 'Пономаренко Леся', 'Радченко Станіслав', 'Захарченко Ольга', 'Федоренко Євген',
    'Мартинюк Валерія', 'Нестеренко Тарас', 'Шаповал Інна', 'Приходько Назар', 'Баранов Кирило', 'Власенко Любов', 'Гнатюк Іван', 'Зубенко Діана',
  ];
  private static readonly SOURCES = ['Instagram', 'Рекомендація', 'Google', 'Сайт', 'Instagram', 'Рекомендація'];
  private patients: ExternalPatient[] = Array.from({ length: 80 }, (_, i) => ({
    externalId: `demo-p-${i + 1}`,
    fullName: DemoConnector.NAMES[i % DemoConnector.NAMES.length] + (i >= DemoConnector.NAMES.length ? ' (молодший)' : ''),
    phone: `+38050000${String(1000 + i)}`,
    source: DemoConnector.SOURCES[i % DemoConnector.SOURCES.length],
    lastVisitAt: new Date(Date.now() - (5 + i * 4) * DAY),
    // у кожного п'ятого є заборгованість
    balanceIssued: 1000 + (i % 5) * 400,
    balancePaid: i % 5 === 0 ? 400 : 1000 + (i % 5) * 400,
  }));

  async fetchPatients() {
    return this.patients;
  }

  async fetchVisits() {
    const now = Date.now();
    const visits: ExternalVisit[] = [];
    this.patients.forEach((p, i) => {
      const doc = DOCTORS[i % 2];
      visits.push({
        externalId: `demo-v-${i + 1}-done`,
        patientExternalId: p.externalId,
        doctorId: doc.id,
        doctorName: doc.name,
        cabinetId: doc.cabinet,
        serviceName: ['Професійна гігієна', 'Лікування карієсу', 'Консультація ортодонта', 'Пломбування каналу'][i % 4],
        startsAt: new Date(now - (5 + i * 5) * DAY),
        status: i % 7 === 0 ? 'DID_NOT_COME' : 'VISITED',
        amount: 800 + (i % 5) * 400,
      });
      if (i % 3 === 0) {
        visits.push({
          externalId: `demo-v-${i + 1}-next`,
          patientExternalId: p.externalId,
          doctorId: doc.id,
          doctorName: doc.name,
          cabinetId: doc.cabinet,
          serviceName: 'Повторний огляд',
          startsAt: at(midnight(3 + i), 10),
          endsAt: at(midnight(3 + i), 11),
          status: 'PLANNED',
        });
      }
    });
    return visits;
  }

  // План лікування: у кожного четвертого пацієнта частина пунктів виконана, частина чекає
  async fetchTreatment() {
    const items: ExternalPlanItem[] = [];
    this.patients.forEach((p, i) => {
      if (i % 4 !== 0) return;
      for (let j = 0; j < 4; j++) {
        const done = j < 2;
        const created = midnight(-60 - i);
        items.push({
          externalId: `demo-pi-${i + 1}-${j}`,
          patientExternalId: p.externalId,
          planId: `demo-plan-${i + 1}`,
          name: ['Консультація', 'Лікування карієсу', 'Пломбування каналу', 'Професійна чистка'][j],
          price: 500 + j * 400,
          status: done ? 'DONE' : j === 2 ? 'PLANNED_TO_DO' : 'NEW',
          createdAt: created,
          markedDoneAt: done ? new Date(created.getTime() + (j + 1) * DAY) : undefined,
        });
      }
    });
    return items;
  }

  async fetchFinance() {
    const payments: ExternalPayment[] = [];
    const invoices: ExternalInvoice[] = [];
    this.patients.forEach((p, i) => {
      const amount = 800 + (i % 5) * 400;
      const when = new Date(Date.now() - (5 + i * 5) * DAY);
      invoices.push({ externalId: `demo-inv-${i + 1}`, patientExternalId: p.externalId, issuedAt: when, amount, issuerName: DOCTORS[i % 2].name });
      payments.push({ externalId: `demo-pay-${i + 1}`, patientExternalId: p.externalId, paidAt: when, amount: i % 5 === 0 ? amount / 2 : amount, type: i % 2 ? 'CASH' : 'CREDIT_CARD' });
    });
    return { payments, invoices };
  }

  // Зміни лікарів на найближчі тижні: будні, 9:00–18:00, з обідньою перервою в першому кабінеті
  async fetchSchedule() {
    const shifts: ExternalShift[] = [];
    const blocks: ExternalBlock[] = [];
    for (let off = -7; off <= 30; off++) {
      const d = midnight(off);
      if ([0, 6].includes(d.getUTCDay())) continue;
      for (const doc of DOCTORS) {
        shifts.push({
          externalId: `demo-shift-${doc.id}-${off}`,
          doctorId: doc.id,
          doctorName: doc.name,
          cabinetId: doc.cabinet,
          cabinetName: doc.cabinetName,
          startsAt: at(d, 9),
          endsAt: at(d, 18),
        });
      }
      blocks.push({ externalId: `demo-block-${off}`, cabinetId: DOCTORS[0].cabinet, startsAt: at(d, 13), endsAt: at(d, 14), note: 'Обід' });
    }
    return { shifts, blocks };
  }
}
