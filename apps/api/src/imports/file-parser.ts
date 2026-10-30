import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import * as ExcelJS from 'exceljs';

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 20_000;
export const MAX_COLS = 60;

export interface ParsedTable {
  columns: string[];
  rows: string[][];
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('result' in o) return cellText(o.result); // формула: берём вычисленное значение
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join('').trim();
    if ('text' in o) return String(o.text ?? '').trim();
    if ('error' in o) return '';
    return '';
  }
  return String(v).trim();
}

function decodeCsv(buf: Buffer): string {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  // Excel в кириллической Windows часто сохраняет CSV в windows-1251
  try {
    return new TextDecoder('windows-1251').decode(buf);
  } catch {
    return utf8;
  }
}

function pickDelimiter(firstLine: string): string {
  const counts = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length - 1] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

// Первая непустая строка — заголовки. Пустые заголовки получают имя «Колонка N», повторы — номер.
function finish(raw: string[][]): ParsedTable {
  const rows = raw.map((r) => r.map((c) => c.trim()));
  while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop();
  const first = rows.findIndex((r) => r.some((c) => c));
  if (first === -1) throw new BadRequestException('bad_file');
  const body = rows.slice(first);
  const width = Math.max(...body.map((r) => r.length));
  if (width > MAX_COLS || body.length - 1 > MAX_ROWS) throw new BadRequestException('file_too_big');

  const seen = new Map<string, number>();
  const columns = Array.from({ length: width }, (_, i) => {
    const base = body[0][i] || `Колонка ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
  const data = body.slice(1).filter((r) => r.some((c) => c)).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  return { columns, rows: data };
}

export async function parseTable(buffer: Buffer): Promise<ParsedTable> {
  if (buffer.length === 0 || buffer.length > MAX_BYTES) throw new BadRequestException('bad_file');
  const isXlsx = buffer[0] === 0x50 && buffer[1] === 0x4b; // «PK»: xlsx — это zip-архив
  try {
    if (isXlsx) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      const ws = wb.worksheets[0];
      if (!ws) throw new BadRequestException('bad_file');
      const raw: string[][] = [];
      ws.eachRow({ includeEmpty: true }, (row) => {
        const values = (row.values as unknown[]).slice(1); // у exceljs первая ячейка массива пустая
        raw.push(values.map(cellText));
        if (raw.length > MAX_ROWS + 2) throw new BadRequestException('file_too_big');
      });
      return finish(raw);
    }
    const text = decodeCsv(buffer).replace(/^﻿/, '');
    const delimiter = pickDelimiter(text.split(/\r?\n/, 1)[0] ?? '');
    const raw = parse(text, { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: true }) as string[][];
    return finish(raw.map((r) => r.map((c) => String(c ?? ''))));
  } catch (e) {
    if (e instanceof BadRequestException) throw e;
    throw new BadRequestException('bad_file');
  }
}
