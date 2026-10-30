import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TaskResult } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../common/phone';
import { parseTable } from './file-parser';
import { Mapping, nameKey, parseDate, parseOutcome, suggest, validateMapping } from './mapping';

const SAMPLE = 5;
const MAX_UNMATCHED_ROWS = 5000;

interface PatientRow {
  id: string;
  externalId: string;
  fullName: string;
  phoneNorm: string | null;
  extra: unknown;
}

type Extra = Record<string, { v: string; b: string }>;

interface Sample {
  row: number;
  key: string;
}

export interface Summary {
  total: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  emptyKey: number;
  duplicateKeys: number;
  // PATIENT_EXTRA
  fieldsToSet: number;
  fieldsSkippedFilled: number;
  patientsToUpdate: number;
  // CONTACTS
  contactsToCreate: number;
  contactsDuplicate: number;
  badDates: number;
  samples: { unmatched: Sample[]; ambiguous: Sample[] };
}

interface Plan {
  summary: Summary;
  badRows: number[]; // строки, которые не удалось сопоставить: для скачивания
  extraUpdates: Map<string, Extra>; // patientId -> новые значения
  contacts: Prisma.ContactLogCreateManyInput[];
}

@Injectable()
export class ImportsService {
  constructor(private prisma: PrismaService) {}

  async upload(clinicId: string, userId: string, filename: string, buffer: Buffer) {
    const table = await parseTable(buffer);
    const batch = await this.prisma.importBatch.create({
      data: { clinicId, userId, filename: filename.slice(0, 200), columns: table.columns, rows: table.rows },
    });
    // Не доведённые до конца загрузки старше трёх дней убираем, чтобы не копились большие таблицы
    await this.prisma.importBatch.deleteMany({ where: { clinicId, status: 'DRAFT', createdAt: { lt: new Date(Date.now() - 3 * 86_400_000) } } });
    return {
      id: batch.id,
      filename: batch.filename,
      columns: table.columns,
      sampleRows: table.rows.slice(0, 10),
      totalRows: table.rows.length,
      suggestions: suggest(table.columns),
    };
  }

  private async load(clinicId: string, id: string) {
    const batch = await this.prisma.importBatch.findFirst({ where: { id, clinicId } });
    if (!batch) throw new NotFoundException('import_not_found');
    return batch;
  }

  // Общий расчёт для предпросмотра и записи: так предпросмотр не может разойтись с тем, что будет записано
  private async plan(clinicId: string, columns: string[], rows: string[][], m: Mapping, batchId: string): Promise<Plan> {
    const col = (name?: string) => (name ? columns.indexOf(name) : -1);
    const keyIdx = col(m.matchColumn);

    const patients: PatientRow[] = await this.prisma.patient.findMany({
      where: { clinicId, removedAt: null },
      select: { id: true, externalId: true, fullName: true, phoneNorm: true, extra: true },
    });
    const index = new Map<string, PatientRow[]>();
    const add = (k: string | null, p: PatientRow) => {
      if (!k) return;
      const list = index.get(k) ?? [];
      list.push(p);
      index.set(k, list);
    };
    for (const p of patients) {
      if (m.matchBy === 'PHONE') add(p.phoneNorm, p);
      else if (m.matchBy === 'EXTERNAL_ID') add(p.externalId.toLowerCase(), p);
      else add(nameKey(p.fullName) || null, p);
    }
    const keyOf = (cell: string): string | null => {
      const v = cell.trim();
      if (!v) return null;
      if (m.matchBy === 'PHONE') return normalizePhone(v);
      if (m.matchBy === 'EXTERNAL_ID') return v.toLowerCase();
      return nameKey(v) || null;
    };

    const s: Summary = {
      total: rows.length, matched: 0, unmatched: 0, ambiguous: 0, emptyKey: 0, duplicateKeys: 0,
      fieldsToSet: 0, fieldsSkippedFilled: 0, patientsToUpdate: 0,
      contactsToCreate: 0, contactsDuplicate: 0, badDates: 0,
      samples: { unmatched: [], ambiguous: [] },
    };
    const badRows: number[] = [];
    const extraUpdates = new Map<string, Extra>();
    const byId = new Map(patients.map((p) => [p.id, p]));
    const seenKeys = new Set<string>();
    const contacts: Prisma.ContactLogCreateManyInput[] = [];
    const contactKeys = new Set<string>();
    const dateIdx = col(m.dateColumn);
    const outcomeIdx = col(m.outcomeColumn);
    const noteIdx = col(m.noteColumn);

    // Уже существующие контакты нужны, чтобы повторная загрузка того же файла не создавала дублей
    const existingKeys = new Set<string>();
    if (m.type === 'CONTACTS') {
      const old = await this.prisma.contactLog.findMany({ where: { clinicId }, select: { patientId: true, contactedAt: true, note: true } });
      for (const o of old) existingKeys.add(`${o.patientId}|${o.contactedAt.toISOString().slice(0, 10)}|${o.note ?? ''}`);
    }

    rows.forEach((row, i) => {
      const rowNumber = i + 2; // строка 1 — заголовки
      const raw = row[keyIdx] ?? '';
      const key = keyOf(raw);
      if (!key) {
        s.emptyKey++;
        badRows.push(rowNumber);
        return;
      }
      const found = index.get(key);
      if (!found) {
        s.unmatched++;
        badRows.push(rowNumber);
        if (s.samples.unmatched.length < SAMPLE) s.samples.unmatched.push({ row: rowNumber, key: raw });
        return;
      }
      if (found.length > 1) {
        s.ambiguous++;
        badRows.push(rowNumber);
        if (s.samples.ambiguous.length < SAMPLE) s.samples.ambiguous.push({ row: rowNumber, key: raw });
        return;
      }
      const patient = found[0];
      s.matched++;
      if (seenKeys.has(key)) s.duplicateKeys++;
      seenKeys.add(key);

      if (m.type === 'PATIENT_EXTRA') {
        // Для одного пациента строки накапливаются: более поздняя строка файла важнее ранней
        const current = (patient.extra ?? {}) as Extra;
        const next = extraUpdates.get(patient.id) ?? {};
        for (const f of m.fields!) {
          const value = (row[col(f.column)] ?? '').trim();
          if (!value) continue; // пустое значение ничего не стирает
          const label = (f.label ?? f.column).trim();
          const filled = (next[label] ?? current[label])?.v;
          if (filled && !m.overwrite && !next[label]) {
            s.fieldsSkippedFilled++;
            continue;
          }
          next[label] = { v: value, b: batchId };
        }
        if (Object.keys(next).length) extraUpdates.set(patient.id, next);
        return;
      }

      const when = parseDate(row[dateIdx] ?? '');
      if (!when) {
        s.badDates++;
        badRows.push(rowNumber);
        return;
      }
      const outcomeText = outcomeIdx >= 0 ? (row[outcomeIdx] ?? '').trim() : '';
      const outcome: TaskResult | null = parseOutcome(outcomeText);
      const noteText = noteIdx >= 0 ? (row[noteIdx] ?? '').trim() : '';
      // Непонятный результат не теряем: он сохраняется в заметке
      const note = [outcome ? '' : outcomeText, noteText].filter(Boolean).join(' · ').slice(0, 1000) || null;
      const dupKey = `${patient.id}|${when.toISOString().slice(0, 10)}|${note ?? ''}`;
      if (existingKeys.has(dupKey) || contactKeys.has(dupKey)) {
        s.contactsDuplicate++;
        return;
      }
      contactKeys.add(dupKey);
      contacts.push({
        clinicId, patientId: patient.id, channel: m.channel ?? 'OTHER', outcome, note, source: 'IMPORT', importBatchId: batchId, contactedAt: when,
      });
    });

    if (m.type === 'PATIENT_EXTRA') {
      s.patientsToUpdate = extraUpdates.size;
      for (const u of extraUpdates.values()) s.fieldsToSet += Object.keys(u).length;
      // значения, совпадающие с уже сохранёнными, не считаем изменением
      for (const [id, u] of extraUpdates) {
        const current = (byId.get(id)?.extra ?? {}) as Extra;
        for (const [k, v] of Object.entries(u)) if (current[k]?.v === v.v) {
          s.fieldsToSet--;
          delete u[k];
        }
        if (!Object.keys(u).length) {
          extraUpdates.delete(id);
          s.patientsToUpdate--;
        }
      }
    }
    s.contactsToCreate = contacts.length;
    return { summary: s, badRows, extraUpdates, contacts };
  }

  async dryRun(clinicId: string, id: string, mapping: unknown) {
    const batch = await this.load(clinicId, id);
    if (batch.status === 'DONE') throw new ConflictException('import_done');
    const m = validateMapping(mapping, batch.columns as string[]);
    const { summary } = await this.plan(clinicId, batch.columns as string[], batch.rows as string[][], m, batch.id);
    return summary;
  }

  async apply(clinicId: string, userId: string, id: string, mapping: unknown) {
    const batch = await this.load(clinicId, id);
    if (batch.status === 'DONE') throw new ConflictException('import_done');
    const m = validateMapping(mapping, batch.columns as string[]);
    const plan = await this.plan(clinicId, batch.columns as string[], batch.rows as string[][], m, batch.id);

    // Занимаем загрузку до записи: два одновременных запроса не применят её дважды
    const claimed = await this.prisma.importBatch.updateMany({ where: { id, clinicId, status: 'DRAFT' }, data: { status: 'DONE', appliedAt: new Date(), type: m.type } });
    if (!claimed.count) throw new ConflictException('import_done');

    try {
      if (m.type === 'PATIENT_EXTRA') {
        const current = new Map(
          (await this.prisma.patient.findMany({ where: { clinicId, id: { in: [...plan.extraUpdates.keys()] } }, select: { id: true, extra: true } })).map((p) => [p.id, (p.extra ?? {}) as Extra]),
        );
        // Remember the previous value of every changed key so the import can be undone
        const undo: Record<string, Record<string, unknown>> = {};
        for (const [patientId, u] of plan.extraUpdates) undo[patientId] = Object.fromEntries(Object.keys(u).map((k) => [k, (current.get(patientId) ?? {})[k] ?? null]));
        await this.prisma.importBatch.update({ where: { id }, data: { undoData: undo as Prisma.InputJsonValue } });
        const entries = [...plan.extraUpdates.entries()];
        for (let i = 0; i < entries.length; i += 50) {
          await Promise.all(
            entries.slice(i, i + 50).map(([patientId, u]) =>
              this.prisma.patient.update({ where: { id: patientId }, data: { extra: { ...(current.get(patientId) ?? {}), ...u } as Prisma.InputJsonValue } }),
            ),
          );
        }
      } else {
        for (let i = 0; i < plan.contacts.length; i += 1000) {
          await this.prisma.contactLog.createMany({ data: plan.contacts.slice(i, i + 1000).map((c) => ({ ...c, userId })) });
        }
      }
    } catch (e) {
      // Запись не удалась: возвращаем загрузку в черновики, чтобы её можно было повторить
      await this.prisma.importBatch.update({ where: { id }, data: { status: 'DRAFT', appliedAt: null } });
      throw e;
    }

    const stats = { ...plan.summary, badRows: plan.badRows.slice(0, MAX_UNMATCHED_ROWS) } as unknown as Prisma.InputJsonValue;
    await this.prisma.importBatch.update({ where: { id }, data: { stats } });
    await this.prisma.auditLog.create({
      data: { clinicId, userId, action: 'import.applied', details: { importId: id, type: m.type, matched: plan.summary.matched, created: plan.summary.contactsToCreate, fields: plan.summary.fieldsToSet } },
    });
    return plan.summary;
  }

  // Undo an applied import: contact notes created by it are deleted, changed extra fields return to their previous values.
  // Changes made after the import to the same fields are overwritten by the previous values (documented in the confirmation).
  async undo(clinicId: string, userId: string, id: string) {
    const batch = await this.load(clinicId, id);
    if (batch.status !== 'DONE' || batch.undoneAt) throw new ConflictException('import_not_undoable');
    const claimed = await this.prisma.importBatch.updateMany({ where: { id, clinicId, status: 'DONE', undoneAt: null }, data: { undoneAt: new Date() } });
    if (!claimed.count) throw new ConflictException('import_not_undoable');
    let reverted = 0;
    if (batch.type === 'CONTACTS') {
      reverted = (await this.prisma.contactLog.deleteMany({ where: { clinicId, importBatchId: id } })).count;
    } else {
      const undo = (batch.undoData ?? {}) as Record<string, Record<string, unknown>>;
      const ids = Object.keys(undo);
      for (let i = 0; i < ids.length; i += 50) {
        const slice = ids.slice(i, i + 50);
        const rows = await this.prisma.patient.findMany({ where: { clinicId, id: { in: slice } }, select: { id: true, extra: true } });
        await Promise.all(
          rows.map((p) => {
            const next = { ...((p.extra ?? {}) as Record<string, unknown>) };
            for (const [k, v] of Object.entries(undo[p.id])) {
              if (v === null || v === undefined) delete next[k];
              else next[k] = v;
            }
            return this.prisma.patient.update({ where: { id: p.id }, data: { extra: next as Prisma.InputJsonValue } });
          }),
        );
        reverted += rows.length;
      }
    }
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'import.undone', details: { importId: id, type: batch.type, reverted } } });
    return { reverted };
  }

  async history(clinicId: string) {
    const rows = await this.prisma.importBatch.findMany({
      where: { clinicId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, filename: true, type: true, status: true, stats: true, createdAt: true, appliedAt: true, userId: true, undoneAt: true },
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const names = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => {
      const stats = (r.stats ?? {}) as Partial<Summary>;
      return { id: r.id, filename: r.filename, type: r.type, status: r.status, undoneAt: r.undoneAt, createdAt: r.createdAt, appliedAt: r.appliedAt, user: r.userId ? names.get(r.userId) ?? null : null, total: stats.total ?? null, matched: stats.matched ?? null, unmatched: (stats.unmatched ?? 0) + (stats.ambiguous ?? 0) + (stats.emptyKey ?? 0) + (stats.badDates ?? 0) };
    });
  }

  async discard(clinicId: string, id: string) {
    const r = await this.prisma.importBatch.deleteMany({ where: { id, clinicId, status: 'DRAFT' } });
    if (!r.count) throw new NotFoundException('import_not_found');
    return { ok: true };
  }

  // Строки файла, которые не удалось применить (нет пациента, неоднозначно, пустой ключ, плохая дата)
  async unmatchedCsv(clinicId: string, id: string) {
    const batch = await this.load(clinicId, id);
    if (batch.status !== 'DONE') throw new BadRequestException('bad_mapping');
    const bad = new Set(((batch.stats as { badRows?: number[] }).badRows ?? []));
    const columns = batch.columns as string[];
    const rows = batch.rows as string[][];
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = rows.map((r, i) => (bad.has(i + 2) ? [String(i + 2), ...r].map(esc).join(';') : null)).filter((l): l is string => !!l);
    return '﻿' + [['#', ...columns].map(esc).join(';'), ...lines].join('\r\n');
  }

  async preview(clinicId: string, id: string) {
    const b = await this.load(clinicId, id);
    return { id: b.id, filename: b.filename, status: b.status, columns: b.columns, sampleRows: (b.rows as string[][]).slice(0, 10), totalRows: (b.rows as string[][]).length, suggestions: suggest(b.columns as string[]) };
  }
}
