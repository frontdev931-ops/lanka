import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsImportService } from '../integrations/settings-import.service';
import { SyncService } from '../integrations/sync.service';

export const KB_KINDS = ['SERVICE', 'DOCTOR', 'LOCATION', 'FAQ'] as const;
export type KbKind = (typeof KB_KINDS)[number];
const DAY = 86_400_000;
// A price is quoted only while a person confirmed it this recently
export const PRICE_FRESH_DAYS = 90;
const MAX_ITEMS = 600;
// How much of the knowledge goes into one prompt
const PROMPT_BUDGET = 9000;
// Up to this many services go into every prompt; above it only the ones that match the question (at most SERVICES_SHOWN)
const SERVICES_ALL = 40;
const SERVICES_SHOWN = 25;

export interface KbInput {
  kind?: KbKind;
  title?: string;
  text?: string;
  durationMin?: number | null;
  priceUah?: number | null;
  active?: boolean;
}

export interface KbFacts {
  // Text for the model; null when the clinic approved nothing
  text: string | null;
  // The amounts (UAH) the reply may mention: only fresh approved prices
  allowedAmounts: number[];
  pricesKnown: boolean;
}

// The price Cliniccards has now differs from the clinic's own, and the administrator has not accepted it nor chosen to keep the own one
// (only for an approved position: a draft simply follows Cliniccards)
export const priceDivergent = (r: { externalId: string | null; externalPrice: number | null; priceUah: number | null; externalPriceAcked: number | null; approvedAt: Date | null }) =>
  !!r.approvedAt && !!r.externalId && r.externalPrice !== null && r.externalPrice !== r.priceUah && r.externalPrice !== r.externalPriceAcked;

const fresh = (d: Date | null, now = new Date()) => !!d && now.getTime() - d.getTime() < PRICE_FRESH_DAYS * DAY;

@Injectable()
export class KbService {
  constructor(
    private prisma: PrismaService,
    private sync: SyncService,
    private imports: SettingsImportService,
  ) {}

  async list(clinicId: string) {
    const rows = await this.prisma.kbItem.findMany({ where: { clinicId }, orderBy: [{ kind: 'asc' }, { title: 'asc' }] });
    const now = new Date();
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      category: r.category,
      text: r.text,
      durationMin: r.durationMin,
      priceUah: r.priceUah,
      // unknown (null) is not the same as free (0): the first is never quoted, the second is told as "free"
      priceState: r.priceUah === null ? 'UNKNOWN' : r.priceUah === 0 ? 'FREE' : 'SET',
      // Cliniccards has another price than the clinic confirmed: shown to the administrator, and the old price is not quoted meanwhile
      priceDivergence: priceDivergent(r) ? { own: r.priceUah, source: r.externalPrice } : null,
      fromCliniccards: !!r.externalId,
      missingInSource: !!r.missingInSourceAt,
      active: r.active,
      source: r.source,
      approved: !!r.approvedAt,
      // approved, but not confirmed for 90 days: prices stop being quoted, the rest still works
      stale: !!r.approvedAt && !fresh(r.reviewedAt, now),
      reviewedAt: r.reviewedAt,
    }));
  }

  async summary(clinicId: string) {
    const rows = await this.list(clinicId);
    return { total: rows.length, approved: rows.filter((r) => r.approved && r.active).length, drafts: rows.filter((r) => !r.approved).length, stale: rows.filter((r) => r.stale).length };
  }

  private clean(d: KbInput) {
    const out: { kind?: KbKind; title?: string; text?: string; durationMin?: number | null; priceUah?: number | null; active?: boolean } = {};
    if (d.kind !== undefined) {
      if (!KB_KINDS.includes(d.kind)) throw new BadRequestException('bad_kb_kind');
      out.kind = d.kind;
    }
    if (d.title !== undefined) {
      const t = d.title.trim();
      if (!t || t.length > 160) throw new BadRequestException('bad_kb_title');
      out.title = t;
    }
    if (d.text !== undefined) {
      if (d.text.length > 900) throw new BadRequestException('bad_kb_text');
      out.text = d.text.trim();
    }
    for (const k of ['durationMin', 'priceUah'] as const) {
      if (d[k] === undefined) continue;
      const v = d[k];
      if (v !== null && (!Number.isInteger(v) || v < 0 || v > (k === 'durationMin' ? 600 : 1_000_000))) throw new BadRequestException('bad_kb_number');
      out[k] = v;
    }
    if (d.active !== undefined) out.active = d.active;
    return out;
  }

  async create(clinicId: string, userId: string, d: KbInput & { kind: KbKind; title: string }) {
    if ((await this.prisma.kbItem.count({ where: { clinicId } })) >= MAX_ITEMS) throw new BadRequestException('kb_full');
    const data = this.clean(d);
    const row = await this.prisma.kbItem.create({ data: { clinicId, kind: data.kind!, title: data.title!, text: data.text ?? '', durationMin: data.durationMin ?? null, priceUah: data.priceUah ?? null, active: data.active ?? true } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.created', details: { id: row.id, kind: row.kind } } });
    return row.id;
  }

  // Any change of the content takes the approval back: the AI uses an item again only after a person approves the new version
  async update(clinicId: string, userId: string, id: string, d: KbInput) {
    const cur = await this.prisma.kbItem.findFirst({ where: { id, clinicId } });
    if (!cur) throw new NotFoundException('kb_not_found');
    const data = this.clean({ ...d, kind: undefined });
    const contentChanged = (['title', 'text', 'durationMin', 'priceUah'] as const).some((k) => data[k] !== undefined && data[k] !== cur[k]);
    await this.prisma.kbItem.update({ where: { id }, data: { ...data, ...(contentChanged ? { approvedAt: null, approvedById: null } : {}) } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.updated', details: { id, contentChanged } } });
  }

  async approve(clinicId: string, userId: string, id: string) {
    const cur = await this.prisma.kbItem.findFirst({ where: { id, clinicId } });
    if (!cur) throw new NotFoundException('kb_not_found');
    // an unknown price does not block the approval: the bot simply never names a price for it
    const now = new Date();
    await this.prisma.kbItem.update({ where: { id }, data: { approvedAt: now, approvedById: userId, reviewedAt: now } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.approved', details: { id } } });
  }

  // Approves every draft of one price-list group at once, after the person looked the group over. Items that still need a price
  // (imported without one) are skipped and counted, never approved without a price.
  async approveGroup(clinicId: string, userId: string, kind: KbKind, category: string | null): Promise<{ approved: number; skipped: number }> {
    if (!KB_KINDS.includes(kind)) throw new BadRequestException('bad_kb_kind');
    const drafts = await this.prisma.kbItem.findMany({ where: { clinicId, kind, category, approvedAt: null }, select: { id: true, kind: true, priceUah: true, source: true } });
    const ok = drafts;
    const now = new Date();
    if (ok.length) await this.prisma.kbItem.updateMany({ where: { clinicId, id: { in: ok.map((d) => d.id) } }, data: { approvedAt: now, approvedById: userId, reviewedAt: now } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.approved_group', details: { kind, category, approved: ok.length } } });
    return { approved: ok.length, skipped: drafts.length - ok.length };
  }

  // "Still true": renews the 90 days without changing anything (only for an approved item)
  async confirm(clinicId: string, userId: string, id: string) {
    const r = await this.prisma.kbItem.updateMany({ where: { id, clinicId, approvedAt: { not: null } }, data: { reviewedAt: new Date() } });
    if (!r.count) throw new NotFoundException('kb_not_found');
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.confirmed', details: { id } } });
  }

  async remove(clinicId: string, userId: string, id: string) {
    const r = await this.prisma.kbItem.deleteMany({ where: { id, clinicId } });
    if (!r.count) throw new NotFoundException('kb_not_found');
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.deleted', details: { id } } });
  }

  // Drafts from the price list of the clinic's system (see SettingsImportService): nothing is approved, the currency of that list is not
  // trusted and a person checks every price; services already in the knowledge base are linked or refreshed, never doubled.
  async importServices(clinicId: string, userId: string): Promise<{ added: number; updated: number; missing: number; total: number; note: string | null }> {
    const connector = await this.sync.connectorForClinic(clinicId);
    if (!connector?.fetchServiceList) throw new BadRequestException('kb_import_unavailable');
    let r;
    try {
      r = await this.imports.importPrices(clinicId, connector);
    } catch {
      throw new BadRequestException('kb_import_failed');
    }
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.imported', details: { added: r.added, updated: r.updated, missing: r.missing } } });
    return r;
  }

  // What the administrator has to decide after an import: a price that changed in Cliniccards, positions that vanished from the price list,
  // and hand-made services whose name equals an imported position (never linked automatically: names repeat across groups)
  async review(clinicId: string) {
    const [rows, clinic] = await Promise.all([
      this.prisma.kbItem.findMany({ where: { clinicId, kind: 'SERVICE', active: true }, orderBy: { title: 'asc' } }),
      this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { priceListNote: true, priceListSyncedAt: true } }),
    ]);
    const imported = rows.filter((r) => r.externalId && r.source === 'CLINICCARDS');
    const matches = rows
      .filter((r) => !r.externalId && !r.matchDismissed)
      .map((m) => ({ manual: { id: m.id, title: m.title, category: m.category, priceUah: m.priceUah }, candidates: imported.filter((i) => i.title.toLowerCase() === m.title.toLowerCase()).map((i) => ({ id: i.id, title: i.title, category: i.category, priceUah: i.priceUah })) }))
      .filter((m) => m.candidates.length > 0);
    return {
      syncedAt: clinic.priceListSyncedAt,
      note: clinic.priceListNote,
      priceChanges: rows.filter(priceDivergent).map((r) => ({ id: r.id, title: r.title, category: r.category, own: r.priceUah, source: r.externalPrice })),
      missing: rows.filter((r) => r.missingInSourceAt).map((r) => ({ id: r.id, title: r.title, category: r.category, since: r.missingInSourceAt })),
      matches,
    };
  }

  // The administrator takes the price Cliniccards has now, or keeps the clinic's own one (and is not asked again until Cliniccards changes it)
  async resolvePrice(clinicId: string, userId: string, id: string, action: 'accept' | 'keep') {
    const cur = await this.prisma.kbItem.findFirst({ where: { id, clinicId, kind: 'SERVICE' } });
    if (!cur || cur.externalPrice === null) throw new NotFoundException('kb_not_found');
    if (action === 'accept') await this.prisma.kbItem.update({ where: { id }, data: { priceUah: cur.externalPrice, externalPriceAcked: null, reviewedAt: new Date() } });
    else await this.prisma.kbItem.update({ where: { id }, data: { externalPriceAcked: cur.externalPrice, reviewedAt: new Date() } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.price_resolved', details: { id, action, source: cur.externalPrice, own: cur.priceUah } } });
  }

  // A position that vanished from the price list: keep it as the clinic's own service, or switch it off (nothing is deleted)
  async resolveMissing(clinicId: string, userId: string, id: string, action: 'keep' | 'disable') {
    const cur = await this.prisma.kbItem.findFirst({ where: { id, clinicId, kind: 'SERVICE', missingInSourceAt: { not: null } } });
    if (!cur) throw new NotFoundException('kb_not_found');
    if (action === 'keep') await this.prisma.kbItem.update({ where: { id }, data: { missingInSourceAt: null, externalId: null, externalTitle: null, externalPrice: null, externalPriceAcked: null } });
    else await this.prisma.kbItem.update({ where: { id }, data: { active: false, onlineBooking: false } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.missing_resolved', details: { id, action } } });
  }

  // The administrator says that a hand-made service IS this position of the price list. The clinic's own text, length, price and settings stay; the
  // imported duplicate is switched off (not deleted: a doctor's list of services may still point at it).
  async link(clinicId: string, userId: string, manualId: string, importedId: string) {
    const [manual, imp] = await Promise.all([
      this.prisma.kbItem.findFirst({ where: { id: manualId, clinicId, kind: 'SERVICE', externalId: null } }),
      this.prisma.kbItem.findFirst({ where: { id: importedId, clinicId, kind: 'SERVICE', externalId: { not: null }, source: 'CLINICCARDS' } }),
    ]);
    if (!manual || !imp) throw new NotFoundException('kb_not_found');
    await this.prisma.$transaction([
      this.prisma.kbItem.update({ where: { id: imp.id }, data: { externalId: null, active: false, onlineBooking: false, source: 'MANUAL', matchDismissed: true } }),
      this.prisma.kbItem.update({ where: { id: manual.id }, data: { externalId: imp.externalId, externalTitle: imp.externalTitle, externalPrice: imp.externalPrice, ...(manual.category ? {} : { category: imp.category }) } }),
    ]);
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.linked', details: { manualId, importedId } } });
  }

  async dismissMatch(clinicId: string, userId: string, id: string) {
    const r = await this.prisma.kbItem.updateMany({ where: { id, clinicId, kind: 'SERVICE', externalId: null }, data: { matchDismissed: true } });
    if (!r.count) throw new NotFoundException('kb_not_found');
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.match_dismissed', details: { id } } });
  }

  // What the model may know. Only approved, active items. A price and its amount appear only when confirmed in the last 90 days.
  // A clinic with a long price list (112 dental has 234 items) cannot put it all into every prompt: with more than SERVICES_ALL services
  // only those that match the patient's words are included, plus the list of directions so the model knows what exists.
  // The amounts a reply may mention are those of the services that were included.
  async factsFor(clinicId: string, now = new Date(), query = ''): Promise<KbFacts> {
    const rows = await this.prisma.kbItem.findMany({ where: { clinicId, active: true, approvedAt: { not: null }, missingInSourceAt: null }, orderBy: [{ kind: 'asc' }, { title: 'asc' }] });
    if (!rows.length) return { text: null, allowedAmounts: [], pricesKnown: false };
    const services = rows.filter((r) => r.kind === 'SERVICE');
    let shown = services;
    let directions: string[] = [];
    if (services.length > SERVICES_ALL) {
      const stems = [...new Set((query.toLowerCase().match(/[\p{L}]{4,}/gu) ?? []).map((w) => w.slice(0, 5)))];
      const score = (r: (typeof services)[number]) => stems.filter((st) => `${r.title} ${r.category ?? ''}`.toLowerCase().includes(st)).length;
      shown = services.map((r) => ({ r, n: score(r) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, SERVICES_SHOWN).map((x) => x.r);
      directions = [...new Set(services.map((r) => r.category).filter((c): c is string => !!c))].slice(0, 40);
    }
    const allowed = new Set<number>();
    const sections: Record<KbKind, string[]> = { SERVICE: [], DOCTOR: [], LOCATION: [], FAQ: [] };
    for (const r of shown) {
      // the old price is not told as current while Cliniccards has another one that the administrator has not decided about
      const price = r.priceUah !== null && fresh(r.reviewedAt, now) && !priceDivergent(r) ? r.priceUah : null;
      if (price !== null) allowed.add(price);
      sections.SERVICE.push(`- ${r.title}${r.category ? ` (група: ${r.category})` : ''}${r.durationMin ? `; тривалість ${r.durationMin} хв` : ''}${price === 0 ? '; безкоштовно (ціна 0 грн)' : price !== null ? `; ціна ${price} грн` : '; ціна: не називати, передати адміністратору'}${r.text ? `; ${r.text.replace(/\s*\n\s*/g, ' ')}` : ''}`);
    }
    for (const r of rows) {
      const kind = r.kind as KbKind;
      if (kind === 'FAQ') sections.FAQ.push(`- Питання: ${r.title}\n  Відповідь: ${r.text}`);
      else if (kind === 'DOCTOR' || kind === 'LOCATION') sections[kind].push(`- ${r.title}${r.text ? `: ${r.text}` : ''}`);
    }
    const parts: string[] = [];
    const add = (head: string, lines: string[]) => lines.length && parts.push(`${head}\n${lines.join('\n')}`);
    if (directions.length) parts.push(`НАПРЯМКИ ПОСЛУГ КЛІНІКИ (повний прайс не наведено; конкретні послуги нижче лише ті, що стосуються питання): ${directions.join(', ')}`);
    add('ПОСЛУГИ:', sections.SERVICE);
    add('ЛІКАРІ:', sections.DOCTOR);
    add('АДРЕСИ ТА КОНТАКТИ:', sections.LOCATION);
    add('ЧАСТІ ПИТАННЯ:', sections.FAQ);
    return { text: parts.join('\n\n').slice(0, PROMPT_BUDGET), allowedAmounts: [...allowed], pricesKnown: [...allowed].length > 0 || services.some((r) => r.priceUah !== null && fresh(r.reviewedAt, now) && !priceDivergent(r)) };
  }
}
