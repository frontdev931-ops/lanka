import * as ExcelJS from 'exceljs';
import { normalizePhone } from '../src/common/phone';
import { parseTable } from '../src/imports/file-parser';
import { nameKey, parseDate, parseOutcome, suggest, validateMapping } from '../src/imports/mapping';

describe('нормализация телефона', () => {
  it.each([
    ['0501234567', '380501234567'],
    ['+38 (050) 123-45-67', '380501234567'],
    ['380501234567', '380501234567'],
    ['80501234567', '380501234567'],
    ['501234567', '380501234567'],
    ['+1 415 555 0100', '14155550100'], // чужие номера остаются цифрами
  ])('%s → %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each(['', '   ', '12345', 'нет', null, undefined])('«%s» — не телефон', (raw) => {
    expect(normalizePhone(raw as string | null | undefined)).toBeNull();
  });
});

describe('даты из таблиц', () => {
  it.each([
    ['2026-10-20', '2026-10-20'],
    ['20.10.2026', '2026-10-20'],
    ['5.3.2026', '2026-03-05'],
    ['20/10/26', '2026-10-20'],
    ['20-10-2026', '2026-10-20'],
    ['2026-10-20T14:30:00', '2026-10-20'],
    ['46315', '2026-10-20'], // серийный номер Excel
  ])('%s → %s', (raw, expected) => {
    expect(parseDate(raw)?.toISOString().slice(0, 10)).toBe(expected);
  });

  it.each(['', 'вчера', '31.02.2026', '2026-13-40', '01.01.1999', '01.01.2099'])('«%s» отклоняется', (raw) => {
    expect(parseDate(raw)).toBeNull();
  });
});

describe('результат контакта из текста', () => {
  it.each([
    ['Записався', 'BOOKED'],
    ['записана на пятницу', 'BOOKED'],
    ['не відповів', 'NO_ANSWER'],
    ['Не отвечает', 'NO_ANSWER'],
    ['недозвон', 'NO_ANSWER'],
    ['Відмовився', 'DECLINED'],
    ['отказ', 'DECLINED'],
    ['не записався', 'DECLINED'], // «не записався» не должно стать «записався»
    ['перетелефонувати', 'CALL_LATER'],
    ['Перезвонить позже', 'CALL_LATER'],
  ])('«%s» → %s', (text, expected) => {
    expect(parseOutcome(text)).toBe(expected);
  });

  it('непонятный текст не превращается в результат', () => {
    expect(parseOutcome('обговорили ціни')).toBeNull();
    expect(parseOutcome('')).toBeNull();
  });
});

describe('ключ имени', () => {
  it('порядок слов, регистр и знаки не важны', () => {
    expect(nameKey('Іваненко Олег')).toBe(nameKey('олег  іваненко.'));
    expect(nameKey("Мар'яна-Софія Коваль")).toBe(nameKey('коваль мар яна софія'));
    expect(nameKey('Іваненко Олег')).not.toBe(nameKey('Іваненко Олена'));
  });
});

describe('подсказки столбцов', () => {
  it('находит телефон, имя, дату, результат и комментарий', () => {
    const s = suggest(['ПІБ пацієнта', 'Телефон', 'Дата дзвінка', 'Результат', 'Коментар']);
    expect(s).toMatchObject({ name: 'ПІБ пацієнта', phone: 'Телефон', date: 'Дата дзвінка', outcome: 'Результат', note: 'Коментар' });
  });
});

describe('проверка настроек сопоставления', () => {
  const cols = ['Телефон', 'Джерело', 'Дата'];
  it('принимает правильные настройки', () => {
    expect(() => validateMapping({ type: 'PATIENT_EXTRA', matchBy: 'PHONE', matchColumn: 'Телефон', fields: [{ column: 'Джерело' }] }, cols)).not.toThrow();
    expect(() => validateMapping({ type: 'CONTACTS', matchBy: 'PHONE', matchColumn: 'Телефон', dateColumn: 'Дата' }, cols)).not.toThrow();
  });

  it.each([
    ['нет такого столбца', { type: 'PATIENT_EXTRA', matchBy: 'PHONE', matchColumn: 'Нет', fields: [{ column: 'Джерело' }] }],
    ['неизвестный тип', { type: 'DELETE_ALL', matchBy: 'PHONE', matchColumn: 'Телефон' }],
    ['нет полей', { type: 'PATIENT_EXTRA', matchBy: 'PHONE', matchColumn: 'Телефон', fields: [] }],
    ['повтор названий полей', { type: 'PATIENT_EXTRA', matchBy: 'PHONE', matchColumn: 'Телефон', fields: [{ column: 'Джерело', label: 'A' }, { column: 'Дата', label: 'a' }] }],
    ['контакты без даты', { type: 'CONTACTS', matchBy: 'PHONE', matchColumn: 'Телефон' }],
    ['неизвестный канал', { type: 'CONTACTS', matchBy: 'PHONE', matchColumn: 'Телефон', dateColumn: 'Дата', channel: 'PIGEON' }],
    ['не объект', 'строка'],
  ])('отклоняет: %s', (_, mapping) => {
    expect(() => validateMapping(mapping, cols)).toThrow();
  });
});

describe('разбор файлов', () => {
  it('CSV с разделителем «;», BOM и кириллицей', async () => {
    const csv = '﻿Телефон;Джерело;Коментар\r\n0501234567;Instagram;"Просила, щоб ""перетелефонували"""\r\n\r\n0671112233;Google;\r\n';
    const t = await parseTable(Buffer.from(csv, 'utf8'));
    expect(t.columns).toEqual(['Телефон', 'Джерело', 'Коментар']);
    expect(t.rows).toEqual([
      ['0501234567', 'Instagram', 'Просила, щоб "перетелефонували"'],
      ['0671112233', 'Google', ''],
    ]);
  });

  it('CSV с запятой и табуляцией', async () => {
    expect((await parseTable(Buffer.from('a,b\n1,2\n'))).rows).toEqual([['1', '2']]);
    expect((await parseTable(Buffer.from('a\tb\n1\t2\n'))).rows).toEqual([['1', '2']]);
  });

  it('пустые и повторяющиеся заголовки получают имена', async () => {
    const t = await parseTable(Buffer.from('Імя;;Імя\nА;Б;В\n'));
    expect(t.columns).toEqual(['Імя', 'Колонка 2', 'Імя (2)']);
  });

  it('XLSX: строки, числа, даты и формулы', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Лист1');
    ws.addRow(['Телефон', 'Дата', 'Сума']);
    ws.addRow([380501234567, new Date(Date.UTC(2026, 9, 20)), { formula: '1+2', result: 3 }]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const t = await parseTable(buf);
    expect(t.columns).toEqual(['Телефон', 'Дата', 'Сума']);
    expect(t.rows).toEqual([['380501234567', '2026-10-20', '3']]);
  });

  it.each([
    ['пустой файл', Buffer.alloc(0)],
    ['повреждённый xlsx', Buffer.from('PK\u0003\u0004мусор')],
    ['только пустые строки', Buffer.from('\n\n  \n')],
  ])('отклоняет: %s', async (_, buf) => {
    await expect(parseTable(buf)).rejects.toThrow();
  });

  it('слишком много строк', async () => {
    const csv = 'a\n' + Array.from({ length: 20_001 }, (_, i) => String(i + 1)).join('\n');
    await expect(parseTable(Buffer.from(csv))).rejects.toThrow();
  });
});
