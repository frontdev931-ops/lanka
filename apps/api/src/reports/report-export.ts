import * as path from 'path';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { Lang, VALUE_LABEL } from '../common/i18n';
import type { Cell, Report } from './reports.service';

// Подпись значения для людей (статусы, да/нет, «не указан»): общая для CSV, Excel и PDF
export function cellLabel(lang: Lang, key: string, value: Cell): string {
  const v = VALUE_LABEL[lang];
  if (key === 'kind') return v.kind[String(value)] ?? String(value ?? '');
  if (key === 'visitStatus') return v.status[String(value)] ?? String(value ?? '');
  if (key === 'rebooked') return value ? v.yes : v.no;
  if (key === 'source' && !value) return v.notSpecified;
  return String(value ?? '');
}

const TEXT = {
  uk: { rule: 'Правило розрахунку', updated: 'Дані оновлено', generated: 'Сформовано', rows: 'Рядків', cut: 'Показано перші {n} рядків. Повний список у Excel.', never: 'ще не завантажували' },
  ru: { rule: 'Правило расчёта', updated: 'Данные обновлены', generated: 'Сформировано', rows: 'Строк', cut: 'Показаны первые {n} строк. Полный список в Excel.', never: 'ещё не загружали' },
  en: { rule: 'Calculation rule', updated: 'Data updated', generated: 'Generated', rows: 'Rows', cut: 'First {n} rows shown. The full list is in Excel.', never: 'not loaded yet' },
} as const;

const when = (d: Date | string | null, lang: Lang) => (d ? new Date(d).toLocaleString(lang === 'uk' ? 'uk-UA' : lang === 'ru' ? 'ru-RU' : 'en-GB', { timeZone: 'Europe/Kyiv' }) : TEXT[lang].never);

// Excel: числа остаются числами (их можно суммировать), всё остальное текст. Строки записываются как текст, а не формулы.
export async function toXlsx(report: Report, lang: Lang): Promise<Buffer> {
  const t = TEXT[lang];
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LANKA';
  const ws = wb.addWorksheet(report.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  ws.addRow([report.title]).font = { bold: true, size: 14 };
  ws.addRow([`${t.rule}: ${report.rule}`]);
  ws.addRow([`${t.updated}: ${when(report.dataUpdatedAt, lang)} · ${t.generated}: ${when(report.generatedAt, lang)} · ${t.rows}: ${report.rows.length}`]);
  ws.addRow([]);
  const head = ws.addRow(report.columns.map((c) => c.label));
  head.font = { bold: true };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F2F1' } }));
  const widths = report.columns.map((c) => Math.max(10, c.label.length + 2));
  for (const r of report.rows) {
    const cells = report.columns.map((c, i) => {
      const raw = r[c.key];
      const out: ExcelJS.CellValue = typeof raw === 'number' && !['kind', 'visitStatus', 'rebooked', 'source'].includes(c.key) ? raw : cellLabel(lang, c.key, raw);
      widths[i] = Math.min(60, Math.max(widths[i], String(out).length + 2));
      return out;
    });
    ws.addRow(cells);
  }
  report.columns.forEach((_, i) => (ws.getColumn(i + 1).width = widths[i]));
  ws.views = [{ state: 'frozen', ySplit: 5 }];
  if (report.rows.length) ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5 + report.rows.length, column: report.columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const FONT = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf', 'DejaVuSans-Bold.ttf');
const PDF_MAX_ROWS = 1500;

// PDF: альбомная A4, таблица с повтором шапки на каждой странице, шрифт с кириллицей. Очень длинные списки обрезаются (полный в Excel).
export function toPdf(report: Report, lang: Lang): Promise<Buffer> {
  const t = TEXT[lang];
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32, bufferPages: true, info: { Title: report.title, Producer: 'LANKA' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('r', FONT);
    doc.registerFont('b', FONT_BOLD);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    doc.font('b').fontSize(15).text(report.title, left, doc.y);
    doc.font('r').fontSize(8.5).fillColor('#444').text(`${t.rule}: ${report.rule}`, { width });
    doc.text(`${t.updated}: ${when(report.dataUpdatedAt, lang)} · ${t.generated}: ${when(report.generatedAt, lang)} · ${t.rows}: ${report.rows.length}`, { width });
    doc.fillColor('#000').moveDown(0.6);

    // ширина колонок по содержимому (не больше 28% строки)
    const sample = report.rows.slice(0, 200);
    const weight = report.columns.map((c) => Math.min(40, Math.max(c.label.length, ...sample.map((r) => cellLabel(lang, c.key, r[c.key]).length), 4)));
    const total = weight.reduce((a, b) => a + b, 0);
    const colW = weight.map((w) => Math.min(width * 0.28, (w / total) * width));
    const scale = width / colW.reduce((a, b) => a + b, 0);
    const cw = colW.map((w) => w * scale);
    const pad = 3;
    const fs = 8;

    const rowHeight = (cells: string[], font: string) => {
      doc.font(font).fontSize(fs);
      return Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: cw[i] - pad * 2 }))) + pad * 2;
    };
    const drawRow = (cells: string[], header: boolean) => {
      const h = rowHeight(cells, header ? 'b' : 'r');
      if (doc.y + h > doc.page.height - doc.page.margins.bottom - 14) {
        doc.addPage();
        drawRow(report.columns.map((c) => c.label), true);
      }
      const y = doc.y;
      if (header) doc.rect(left, y, width, h).fill('#E6F2F1').fillColor('#000');
      let x = left;
      cells.forEach((c, i) => {
        doc.font(header ? 'b' : 'r').fontSize(fs).text(c, x + pad, y + pad, { width: cw[i] - pad * 2, height: h - pad });
        x += cw[i];
      });
      doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.3).strokeColor('#cccccc').stroke();
      doc.y = y + h;
      doc.x = left;
    };

    drawRow(report.columns.map((c) => c.label), true);
    for (const r of report.rows.slice(0, PDF_MAX_ROWS)) drawRow(report.columns.map((c) => cellLabel(lang, c.key, r[c.key])), false);
    if (report.rows.length > PDF_MAX_ROWS) doc.moveDown(0.5).font('r').fontSize(8.5).text(t.cut.replace('{n}', String(PDF_MAX_ROWS)), left, doc.y);

    // номера страниц
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font('r').fontSize(8).fillColor('#666').text(`${i + 1} / ${range.count}`, left, doc.page.height - doc.page.margins.bottom + 8, { width, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
