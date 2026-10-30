import { BadRequestException, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { clinicDate } from '../common/clinic-time';
import { Lang } from '../common/i18n';
import { PrismaService } from '../prisma/prisma.service';
import type { Report } from '../reports/reports.service';
import { DATASETS, DatasetDef, FieldDef, dataset, field } from './fields';

export type Op = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'isNull' | 'notNull';
export type Fn = 'count' | 'sum' | 'avg' | 'min' | 'max';
export interface ReportSpec {
  dataset: string;
  columns?: string[];
  filters?: { field: string; op: Op; value?: unknown }[];
  groupBy?: { field: string; bucket?: 'month' | 'day' };
  aggregates?: { fn: Fn; field?: string }[];
  sort?: { field: string; dir?: 'asc' | 'desc' };
  limit?: number;
}

const MONEY_ROLES: Role[] = [Role.OWNER, Role.MANAGER, Role.ANALYST];
const OPS: Record<string, Op[]> = {
  string: ['eq', 'ne', 'contains', 'in', 'isNull', 'notNull'],
  enum: ['eq', 'ne', 'in', 'isNull', 'notNull'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'isNull', 'notNull'],
  date: ['eq', 'gt', 'gte', 'lt', 'lte', 'isNull', 'notNull'],
};
const FETCH_CAP = 100_000;
export const ROW_LIMIT_MAX = 20_000;
const bad = (detail: string): never => {
  throw new BadRequestException({ message: 'bad_spec', detail });
};

// Значение даты в фильтре: «2026-01-31» или «-30d» (30 дней назад от сегодня; удобно для сохранённых отчётов)
function parseDay(v: unknown): string {
  const s = String(v ?? '');
  const rel = /^([+-]?\d{1,4})d$/.exec(s);
  if (rel) return clinicDate(new Date(Date.now() + Number(rel[1]) * 86_400_000));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return bad(`date: ${s}`);
}

@Injectable()
export class ReportBuilderService {
  constructor(private prisma: PrismaService) {}

  // Что доступно роли: наборы данных и поля (деньги скрыты от тех, кому их видеть нельзя)
  catalog(role: Role, lang: Lang) {
    const money = MONEY_ROLES.includes(role);
    return DATASETS.filter((d) => money || !d.money).map((d) => ({
      id: d.id,
      label: d.label[lang],
      fields: d.fields
        .filter((f) => money || !f.money)
        .map((f) => ({ key: f.key, label: f.label[lang], type: f.type, money: !!f.money, ops: OPS[f.type], values: f.values ? Object.fromEntries(Object.entries(f.values).map(([k, v]) => [k, v[lang]])) : undefined })),
    }));
  }

  private validate(spec: ReportSpec, role: Role): { d: DatasetDef; cols: FieldDef[]; limit: number } {
    if (!spec || typeof spec !== 'object') bad('spec');
    const d = dataset(spec.dataset);
    if (!d) return bad(`dataset: ${spec.dataset}`);
    const money = MONEY_ROLES.includes(role);
    if (d.money && !money) throw new BadRequestException({ message: 'bad_spec', detail: 'forbidden dataset' });
    const f = (key: string): FieldDef => {
      const x = field(d, key);
      if (!x) return bad(`field: ${key}`);
      if (x!.money && !money) return bad(`forbidden field: ${key}`);
      return x!;
    };
    if ((spec.filters?.length ?? 0) > 10) bad('too many filters');
    for (const fl of spec.filters ?? []) {
      const x = f(fl.field);
      if (!OPS[x.type].includes(fl.op)) bad(`op ${fl.op} for ${fl.field}`);
      if (!['isNull', 'notNull'].includes(fl.op) && (fl.value === undefined || fl.value === null || fl.value === '')) bad(`value for ${fl.field}`);
      if (x.type === 'number' && !['isNull', 'notNull'].includes(fl.op) && !Number.isFinite(Number(fl.value))) bad(`number: ${fl.field}`);
      if (x.type === 'date' && !['isNull', 'notNull'].includes(fl.op)) parseDay(fl.value);
      if (fl.op === 'in' && !Array.isArray(fl.value)) bad(`in: ${fl.field}`);
    }
    const aggs = spec.aggregates ?? [];
    if (spec.groupBy) {
      const g = f(spec.groupBy.field);
      if (spec.groupBy.bucket && g.type !== 'date') bad('bucket only for dates');
      if (!aggs.length) bad('aggregates required with groupBy');
    }
    for (const a of aggs) {
      if (!['count', 'sum', 'avg', 'min', 'max'].includes(a.fn)) bad(`fn: ${a.fn}`);
      if (a.fn !== 'count') {
        const x = f(a.field ?? '');
        if (x.type !== 'number' && !(['min', 'max'].includes(a.fn) && x.type === 'date')) bad(`aggregate ${a.fn} on ${a.field}`);
      }
    }
    if (aggs.length && !spec.groupBy && (spec.columns?.length ?? 0)) bad('columns cannot be combined with totals');
    const cols = (spec.columns ?? []).map(f);
    if (!spec.groupBy && !aggs.length && !cols.length) bad('columns required');
    if (cols.length > 20) bad('too many columns');
    const limit = Math.min(ROW_LIMIT_MAX, Math.max(1, Math.floor(Number(spec.limit) || 1000)));
    return { d, cols, limit };
  }

  // Условия для выборки из базы: ускорение; точная проверка выполняется в коде ниже
  private where(d: DatasetDef, clinicId: string, spec: ReportSpec) {
    const where: Record<string, unknown> = { clinicId };
    if (d.model === 'patient') where.removedAt = null;
    for (const fl of spec.filters ?? []) {
      const x = field(d, fl.field)!;
      if (!x.db || x.type !== 'date') continue;
      const edge = (day: string, end: boolean) => new Date(`${day}T${end ? '23:59:59' : '00:00:00'}+03:00`);
      const cur = (where[x.db] as Record<string, Date>) ?? {};
      if (fl.op === 'gte') cur.gte = new Date(edge(parseDay(fl.value), false).getTime() - 86_400_000);
      if (fl.op === 'gt') cur.gte = new Date(edge(parseDay(fl.value), false).getTime() - 86_400_000);
      if (fl.op === 'lte') cur.lte = new Date(edge(parseDay(fl.value), true).getTime() + 86_400_000);
      if (fl.op === 'lt') cur.lte = new Date(edge(parseDay(fl.value), true).getTime() + 86_400_000);
      if (Object.keys(cur).length) where[x.db] = cur;
    }
    return where;
  }

  private async load(d: DatasetDef, clinicId: string, spec: ReportSpec): Promise<any[]> {
    const where = this.where(d, clinicId, spec);
    const take = FETCH_CAP;
    if (d.model === 'patient') return this.prisma.patient.findMany({ where: where as never, take, include: { _count: { select: { visits: true } } } });
    if (d.model === 'visit') return this.prisma.visit.findMany({ where: where as never, take, include: { patient: { select: { fullName: true, phone: true, source: true } } } });
    if (d.model === 'planItem') return this.prisma.planItem.findMany({ where: where as never, take, include: { patient: { select: { fullName: true, phone: true, source: true } } } });
    if (d.model === 'inquiry') return this.prisma.inquiry.findMany({ where: where as never, take });
    if (d.model === 'bookingRequest') return this.prisma.bookingRequest.findMany({ where: where as never, take, include: { patient: { select: { fullName: true } } } });
    if (d.model === 'review') return this.prisma.review.findMany({ where: where as never, take, include: { patient: { select: { fullName: true } } } });
    return this.prisma.payment.findMany({ where: where as never, take, include: { patient: { select: { fullName: true, phone: true, source: true } } } });
  }

  private matches(x: FieldDef, raw: unknown, fl: { op: Op; value?: unknown }): boolean {
    if (fl.op === 'isNull') return raw === null || raw === undefined || raw === '';
    if (fl.op === 'notNull') return !(raw === null || raw === undefined || raw === '');
    if (raw === null || raw === undefined) return fl.op === 'ne';
    if (x.type === 'date') {
      const v = raw instanceof Date ? clinicDate(raw) : String(raw);
      const t = parseDay(fl.value);
      return { eq: v === t, gt: v > t, gte: v >= t, lt: v < t, lte: v <= t }[fl.op as 'eq' | 'gt' | 'gte' | 'lt' | 'lte'] ?? false;
    }
    if (x.type === 'number') {
      const v = Number(raw);
      const t = Number(fl.value);
      return { eq: v === t, ne: v !== t, gt: v > t, gte: v >= t, lt: v < t, lte: v <= t }[fl.op as 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'] ?? false;
    }
    const v = String(raw).toLowerCase();
    if (fl.op === 'in') return (fl.value as unknown[]).map((s) => String(s).toLowerCase()).includes(v);
    const t = String(fl.value).toLowerCase();
    if (fl.op === 'eq') return v === t;
    if (fl.op === 'ne') return v !== t;
    if (fl.op === 'contains') return v.includes(t);
    return false;
  }

  async run(clinicId: string, role: Role, lang: Lang, spec: ReportSpec, title = '', dataUpdatedAt: Date | null = null): Promise<Report & { truncated: boolean; total: number }> {
    const { d, cols, limit } = this.validate(spec, role);
    let rows = await this.load(d, clinicId, spec);
    const truncated = rows.length >= FETCH_CAP;
    for (const fl of spec.filters ?? []) {
      const x = field(d, fl.field)!;
      rows = rows.filter((r) => this.matches(x, x.get(r), fl));
    }

    const show = (x: FieldDef, raw: unknown): string | number | null => {
      if (raw === null || raw === undefined) return null;
      if (x.type === 'date') return raw instanceof Date ? clinicDate(raw) : String(raw);
      if (x.type === 'enum') return x.values?.[String(raw)]?.[lang] ?? String(raw);
      if (x.type === 'number') return Math.round(Number(raw) * 100) / 100;
      return String(raw);
    };

    let columns: { key: string; label: string }[];
    let out: Record<string, string | number | null>[];
    const aggs = spec.aggregates ?? [];

    if (spec.groupBy || aggs.length) {
      const g = spec.groupBy ? field(d, spec.groupBy.field)! : null;
      const bucket = spec.groupBy?.bucket;
      const groups = new Map<string, { label: string | number | null; rows: any[] }>();
      if (!g) groups.set('', { label: null, rows });
      else {
        for (const r of rows) {
          const raw = g.get(r);
          let label = show(g, raw);
          if (g.type === 'date' && typeof label === 'string' && bucket === 'month') label = label.slice(0, 7);
          const k = String(label ?? '');
          const e = groups.get(k) ?? { label, rows: [] };
          e.rows.push(r);
          groups.set(k, e);
        }
      }
      const word = { count: l3('Кількість', 'Количество', 'Count'), sum: l3('Сума', 'Сумма', 'Sum'), avg: l3('Середнє', 'Среднее', 'Average'), min: l3('Мін', 'Мин', 'Min'), max: l3('Макс', 'Макс', 'Max') };
      columns = [...(g ? [{ key: 'group', label: g.label[lang] }] : []), ...aggs.map((a, i) => ({ key: `a${i}`, label: a.fn === 'count' ? word.count[lang] : `${word[a.fn][lang]}: ${field(d, a.field!)!.label[lang]}` }))];
      out = [...groups.values()].map((e) => {
        const row: Record<string, string | number | null> = g ? { group: e.label } : {};
        aggs.forEach((a, i) => {
          if (a.fn === 'count') return void (row[`a${i}`] = e.rows.length);
          const x = field(d, a.field!)!;
          const vals = e.rows.map((r) => x.get(r)).filter((v) => v !== null && v !== undefined);
          if (x.type === 'date') {
            const days = vals.map((v) => (v instanceof Date ? clinicDate(v) : String(v))).sort();
            return void (row[`a${i}`] = (a.fn === 'min' ? days[0] : days[days.length - 1]) ?? null);
          }
          const nums = vals.map(Number);
          const sum = nums.reduce((s, n) => s + n, 0);
          row[`a${i}`] = nums.length ? Math.round((a.fn === 'sum' ? sum : a.fn === 'avg' ? sum / nums.length : a.fn === 'min' ? Math.min(...nums) : Math.max(...nums)) * 100) / 100 : null;
        });
        return row;
      });
    } else {
      columns = cols.map((x) => ({ key: x.key, label: x.label[lang] }));
      // сортируем по сырым значениям (даты по дате, числа по числу), затем подписываем
      let sorted = rows;
      const sx = spec.sort && field(d, spec.sort.field);
      if (spec.sort && !sx) bad(`sort: ${spec.sort.field}`);
      if (sx) {
        const dir = spec.sort!.dir === 'desc' ? -1 : 1;
        sorted = [...rows].sort((a, b) => cmp(sx.get(a), sx.get(b)) * dir);
      }
      out = sorted.map((r) => Object.fromEntries(cols.map((x) => [x.key, show(x, x.get(r))])));
    }

    if (spec.groupBy || aggs.length) {
      const keys = columns.map((c) => c.key);
      const sk = spec.sort?.field && keys.includes(spec.sort.field) ? spec.sort.field : spec.groupBy?.bucket ? 'group' : aggs.length ? 'a0' : 'group';
      const dir = spec.sort?.dir ? (spec.sort.dir === 'desc' ? -1 : 1) : sk === 'group' ? 1 : -1;
      out.sort((a, b) => cmp(a[sk], b[sk]) * dir);
    }

    const total = out.length;
    const description = describe(spec, d, lang);
    return {
      id: 'custom',
      title: title || description.title,
      rule: description.rule,
      days: 0,
      maxDays: null,
      dataUpdatedAt,
      generatedAt: new Date().toISOString(),
      columns,
      canCreateTasks: false,
      rows: out.slice(0, limit) as never,
      truncated: truncated || total > limit,
      total,
    };
  }
}

const l3 = (uk: string, ru: string, en: string): Record<Lang, string> => ({ uk, ru, en });
const cmp = (a: unknown, b: unknown) => {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
  if (y === null || y === undefined) return -1;
  return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'uk');
};

const OP_WORD: Record<Op, Record<Lang, string>> = {
  eq: l3('=', '=', '='),
  ne: l3('≠', '≠', '≠'),
  gt: l3('>', '>', '>'),
  gte: l3('≥', '≥', '≥'),
  lt: l3('<', '<', '<'),
  lte: l3('≤', '≤', '≤'),
  contains: l3('містить', 'содержит', 'contains'),
  in: l3('один із', 'один из', 'one of'),
  isNull: l3('не заповнено', 'не заполнено', 'is empty'),
  notNull: l3('заповнено', 'заполнено', 'is filled'),
};

// Правило отчёта человеческим языком: каждый отчёт показывает, как он посчитан
function describe(spec: ReportSpec, d: DatasetDef, lang: Lang) {
  const f = (k: string) => field(d, k)?.label[lang] ?? k;
  const value = (x: { field: string; value?: unknown }) => {
    const fd = field(d, x.field);
    const one = (v: unknown) => {
      const raw = String(v);
      const rel = /^([+-]?\d{1,4})d$/.exec(raw);
      if (fd?.type === 'date' && rel) return { uk: `${Math.abs(Number(rel[1]))} дн. ${Number(rel[1]) <= 0 ? 'тому' : 'вперед'}`, ru: `${Math.abs(Number(rel[1]))} дн. ${Number(rel[1]) <= 0 ? 'назад' : 'вперёд'}`, en: `${Math.abs(Number(rel[1]))} days ${Number(rel[1]) <= 0 ? 'ago' : 'ahead'}` }[lang];
      return fd?.values?.[raw]?.[lang] ?? raw;
    };
    return Array.isArray(x.value) ? x.value.map(one).join(', ') : one(x.value);
  };
  const filters = (spec.filters ?? []).map((x) => `${f(x.field)} ${OP_WORD[x.op][lang]}${['isNull', 'notNull'].includes(x.op) ? '' : ` ${value(x)}`}`);
  const head = { uk: 'Набір даних', ru: 'Набор данных', en: 'Dataset' }[lang];
  const flt = { uk: 'Умови', ru: 'Условия', en: 'Conditions' }[lang];
  const grp = { uk: 'Групування', ru: 'Группировка', en: 'Grouped by' }[lang];
  const parts = [`${head}: ${d.label[lang]}`, filters.length ? `${flt}: ${filters.join('; ')}` : '', spec.groupBy ? `${grp}: ${f(spec.groupBy.field)}${spec.groupBy.bucket ? ` (${spec.groupBy.bucket === 'month' ? { uk: 'по місяцях', ru: 'по месяцам', en: 'by month' }[lang] : { uk: 'по днях', ru: 'по дням', en: 'by day' }[lang]})` : ''}` : ''].filter(Boolean);
  return { title: { uk: 'Власний звіт', ru: 'Свой отчёт', en: 'Custom report' }[lang] + `: ${d.label[lang]}`, rule: parts.join('. ') };
}
