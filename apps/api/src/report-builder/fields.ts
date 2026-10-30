import { clinicDate } from '../common/clinic-time';
import { Lang } from '../common/i18n';

type L = Record<Lang, string>;
const l = (uk: string, ru: string, en: string): L => ({ uk, ru, en });

export type FieldType = 'string' | 'number' | 'date' | 'enum';
export interface FieldDef {
  key: string;
  label: L;
  type: FieldType;
  // Деньги: видят только руководство и аналитик
  money?: boolean;
  // Для enum: код -> подпись
  values?: Record<string, L>;
  // Колонка модели для выборки на стороне базы (ускорение); фильтрация всё равно проверяется в коде
  db?: string;
  get: (row: any) => unknown;
}
export interface DatasetDef {
  id: string;
  label: L;
  // Весь набор денежный (платежи)
  money?: boolean;
  model: 'patient' | 'visit' | 'planItem' | 'payment' | 'inquiry' | 'bookingRequest' | 'review';
  fields: FieldDef[];
}

const VISIT_STATUS: Record<string, L> = {
  PLANNED: l('Запланований', 'Запланирован', 'Scheduled'),
  CONFIRMED: l('Підтверджений', 'Подтверждён', 'Confirmed'),
  NOT_CONFIRMED: l('Не підтверджений', 'Не подтверждён', 'Not confirmed'),
  VISITED: l('Був на прийомі', 'Был на приёме', 'Visited'),
  DID_NOT_COME: l('Не прийшов', 'Не пришёл', 'No-show'),
  CANCELLED: l('Скасований', 'Отменён', 'Cancelled'),
  MOVED: l('Перенесений', 'Перенесён', 'Rescheduled'),
  IN_CLINIC: l('У клініці', 'В клинике', 'In clinic'),
  IN_CHAIR: l('У кріслі', 'В кресле', 'In chair'),
  BOOKING: l('Бронь', 'Бронь', 'Booking'),
};
const PLAN_STATUS: Record<string, L> = {
  NEW: l('Новий', 'Новый', 'New'),
  PLANNED_TO_DO: l('Заплановано', 'Запланировано', 'Planned'),
  DONE: l('Виконано', 'Выполнено', 'Done'),
  INVOICED: l('Виставлено рахунок', 'Выставлен счёт', 'Invoiced'),
};
const CONSENT: Record<string, L> = {
  UNKNOWN: l('Невідомо', 'Неизвестно', 'Unknown'),
  GIVEN: l('Є згода', 'Есть согласие', 'Given'),
  WITHDRAWN: l('Відкликано', 'Отозвано', 'Withdrawn'),
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const day = (v: unknown) => (v instanceof Date ? clinicDate(v) : null);

const patientBits = (prefix = ''): FieldDef[] => [
  { key: 'patientName', label: l('Пацієнт', 'Пациент', 'Patient'), type: 'string', get: (r) => (prefix ? r.patient?.fullName : r.fullName) ?? null },
  { key: 'phone', label: l('Телефон', 'Телефон', 'Phone'), type: 'string', get: (r) => (prefix ? r.patient?.phone : r.phone) ?? null },
  { key: 'source', label: l('Джерело звернення', 'Источник обращения', 'Source'), type: 'string', get: (r) => (prefix ? r.patient?.source : r.source) ?? null },
];

export const DATASETS: DatasetDef[] = [
  {
    id: 'patients',
    label: l('Пацієнти', 'Пациенты', 'Patients'),
    model: 'patient',
    fields: [
      { key: 'patientName', label: l('Пацієнт', 'Пациент', 'Patient'), type: 'string', db: 'fullName', get: (r) => r.fullName },
      { key: 'phone', label: l('Телефон', 'Телефон', 'Phone'), type: 'string', db: 'phone', get: (r) => r.phone ?? null },
      { key: 'source', label: l('Джерело звернення', 'Источник обращения', 'Source'), type: 'string', db: 'source', get: (r) => r.source ?? null },
      { key: 'consent', label: l('Згода на повідомлення', 'Согласие на сообщения', 'Message consent'), type: 'enum', values: CONSENT, db: 'consent', get: (r) => r.consent },
      { key: 'createdAtExt', label: l('Картку створено', 'Карточка создана', 'Card created'), type: 'date', db: 'createdAtExt', get: (r) => r.createdAtExt ?? null },
      { key: 'firstVisitAt', label: l('Перший візит', 'Первый визит', 'First visit'), type: 'date', db: 'firstVisitAt', get: (r) => r.firstVisitAt ?? null },
      { key: 'lastVisitAt', label: l('Останній візит', 'Последний визит', 'Last visit'), type: 'date', db: 'lastVisitAt', get: (r) => r.lastVisitAt ?? null },
      { key: 'visitsCount', label: l('Кількість візитів', 'Количество визитов', 'Visits'), type: 'number', get: (r) => r._count?.visits ?? 0 },
      { key: 'balanceIssued', label: l('Виставлено', 'Выставлено', 'Invoiced'), type: 'number', money: true, db: 'balanceIssued', get: (r) => num(r.balanceIssued) },
      { key: 'balancePaid', label: l('Сплачено', 'Оплачено', 'Paid'), type: 'number', money: true, db: 'balancePaid', get: (r) => num(r.balancePaid) },
      { key: 'debt', label: l('Борг', 'Долг', 'Debt'), type: 'number', money: true, get: (r) => Math.max(0, (num(r.balanceIssued) ?? 0) - (num(r.balancePaid) ?? 0)) },
    ],
  },
  {
    id: 'visits',
    label: l('Записи на прийом', 'Записи на приём', 'Appointments'),
    model: 'visit',
    fields: [
      ...patientBits('p'),
      { key: 'startsAt', label: l('Дата візиту', 'Дата визита', 'Visit date'), type: 'date', db: 'startsAt', get: (r) => r.startsAt },
      { key: 'status', label: l('Статус', 'Статус', 'Status'), type: 'enum', values: VISIT_STATUS, db: 'status', get: (r) => r.status },
      { key: 'doctorName', label: l('Лікар', 'Врач', 'Doctor'), type: 'string', db: 'doctorName', get: (r) => r.doctorName ?? null },
      { key: 'serviceName', label: l('Послуга', 'Услуга', 'Service'), type: 'string', db: 'serviceName', get: (r) => r.serviceName ?? null },
      { key: 'bookedAt', label: l('Запис створено', 'Запись создана', 'Booked on'), type: 'date', db: 'bookedAt', get: (r) => r.bookedAt ?? null },
      { key: 'amount', label: l('Сума', 'Сумма', 'Amount'), type: 'number', money: true, db: 'amount', get: (r) => num(r.amount) },
    ],
  },
  {
    id: 'treatment',
    label: l('Послуги з планів лікування', 'Услуги из планов лечения', 'Treatment plan items'),
    model: 'planItem',
    fields: [
      ...patientBits('p'),
      { key: 'name', label: l('Послуга', 'Услуга', 'Service'), type: 'string', db: 'name', get: (r) => r.name },
      { key: 'groupName', label: l('Напрямок', 'Направление', 'Direction'), type: 'string', db: 'groupName', get: (r) => r.groupName ?? null },
      { key: 'status', label: l('Статус', 'Статус', 'Status'), type: 'enum', values: PLAN_STATUS, db: 'status', get: (r) => r.status },
      { key: 'createdAtExt', label: l('Додано в план', 'Добавлено в план', 'Added to plan'), type: 'date', db: 'createdAtExt', get: (r) => r.createdAtExt },
      { key: 'markedDoneAt', label: l('Виконано', 'Выполнено', 'Done on'), type: 'date', db: 'markedDoneAt', get: (r) => r.markedDoneAt ?? null },
      { key: 'price', label: l('Ціна', 'Цена', 'Price'), type: 'number', money: true, db: 'price', get: (r) => num(r.price) },
    ],
  },
  {
    id: 'payments',
    label: l('Платежі', 'Платежи', 'Payments'),
    model: 'payment',
    money: true,
    fields: [
      ...patientBits('p'),
      { key: 'paidAt', label: l('Дата платежу', 'Дата платежа', 'Payment date'), type: 'date', db: 'paidAt', get: (r) => r.paidAt },
      { key: 'amount', label: l('Сума', 'Сумма', 'Amount'), type: 'number', money: true, db: 'amount', get: (r) => num(r.amount) },
      { key: 'type', label: l('Тип платежу', 'Тип платежа', 'Payment type'), type: 'string', db: 'type', get: (r) => r.type ?? null },
    ],
  },
];

const INQUIRY_STATUS: Record<string, L> = { OPEN: l('Відкрите', 'Открытое', 'Open'), LOST: l('Втрачене', 'Потеряно', 'Lost') };
const REQUEST_KIND: Record<string, L> = {
  BOOKING: l('Запис', 'Запись', 'Booking'),
  RESCHEDULE: l('Перенесення', 'Перенос', 'Reschedule'),
  CANCEL: l('Скасування', 'Отмена', 'Cancellation'),
  HANDOFF: l('Передано людині', 'Передано человеку', 'Handed to a person'),
  REVIEW: l('Низька оцінка', 'Низкая оценка', 'Low rating'),
};
const REQUEST_STATUS: Record<string, L> = { NEW: l('Нова', 'Новая', 'New'), DONE: l('Опрацьована', 'Обработана', 'Handled'), DISMISSED: l('Не потрібно', 'Не нужно', 'Not needed') };

// Data of the messaging side: inquiries, requests from chats, visit ratings (no money in any of them)
DATASETS.push(
  {
    id: 'inquiries',
    label: l('Звернення', 'Обращения', 'Inquiries'),
    model: 'inquiry',
    fields: [
      { key: 'occurredAt', label: l('Дата звернення', 'Дата обращения', 'Inquiry date'), type: 'date', db: 'occurredAt', get: (r) => r.occurredAt },
      { key: 'channel', label: l('Канал', 'Канал', 'Channel'), type: 'string', db: 'channel', get: (r) => r.channel },
      { key: 'name', label: l('Ім’я', 'Имя', 'Name'), type: 'string', db: 'name', get: (r) => r.name ?? null },
      { key: 'phone', label: l('Телефон', 'Телефон', 'Phone'), type: 'string', db: 'phone', get: (r) => r.phone ?? null },
      { key: 'status', label: l('Статус', 'Статус', 'Status'), type: 'enum', values: INQUIRY_STATUS, db: 'status', get: (r) => r.status },
      { key: 'returning', label: l('Вже був пацієнтом', 'Уже был пациентом', 'Already a patient'), type: 'enum', values: { true: l('Так', 'Да', 'Yes'), false: l('Ні', 'Нет', 'No') }, get: (r) => String(!!r.returning) },
      { key: 'note', label: l('Примітка', 'Примечание', 'Note'), type: 'string', get: (r) => r.note ?? null },
    ],
  },
  {
    id: 'requests',
    label: l('Заявки з переписки', 'Заявки из переписки', 'Chat requests'),
    model: 'bookingRequest',
    fields: [
      { key: 'createdAt', label: l('Створено', 'Создано', 'Created'), type: 'date', db: 'createdAt', get: (r) => r.createdAt },
      { key: 'kind', label: l('Вид', 'Вид', 'Kind'), type: 'enum', values: REQUEST_KIND, db: 'kind', get: (r) => r.kind },
      { key: 'status', label: l('Статус', 'Статус', 'Status'), type: 'enum', values: REQUEST_STATUS, db: 'status', get: (r) => r.status },
      { key: 'patientName', label: l('Пацієнт', 'Пациент', 'Patient'), type: 'string', get: (r) => r.patient?.fullName ?? r.contactName ?? null },
      { key: 'summary', label: l('Суть', 'Суть', 'Summary'), type: 'string', get: (r) => r.summary },
      { key: 'handledAt', label: l('Опрацьовано', 'Обработано', 'Handled on'), type: 'date', db: 'handledAt', get: (r) => r.handledAt ?? null },
    ],
  },
  {
    id: 'reviews',
    label: l('Оцінки візитів', 'Оценки визитов', 'Visit ratings'),
    model: 'review',
    fields: [
      { key: 'createdAt', label: l('Дата оцінки', 'Дата оценки', 'Rating date'), type: 'date', db: 'createdAt', get: (r) => r.createdAt },
      { key: 'rating', label: l('Оцінка', 'Оценка', 'Rating'), type: 'number', db: 'rating', get: (r) => r.rating },
      { key: 'doctorName', label: l('Лікар', 'Врач', 'Doctor'), type: 'string', db: 'doctorName', get: (r) => r.doctorName ?? null },
      { key: 'patientName', label: l('Пацієнт', 'Пациент', 'Patient'), type: 'string', get: (r) => r.patient?.fullName ?? null },
      { key: 'comment', label: l('Коментар', 'Комментарий', 'Comment'), type: 'string', get: (r) => r.comment ?? null },
    ],
  },
);

export const dataset = (id: string) => DATASETS.find((d) => d.id === id);
export const field = (d: DatasetDef, key: string) => d.fields.find((f) => f.key === key);
export { day };
