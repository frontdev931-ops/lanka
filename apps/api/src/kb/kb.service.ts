import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from '../integrations/sync.service';

export const KB_KINDS = ['SERVICE', 'DOCTOR', 'LOCATION', 'FAQ'] as const;
export type KbKind = (typeof KB_KINDS)[number];
const DAY = 86_400_000;
// A price is quoted only while a person confirmed it this recently
export const PRICE_FRESH_DAYS = 90;
const MAX_ITEMS = 300;
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

const fresh = (d: Date | null, now = new Date()) => !!d && now.getTime() - d.getTime() < PRICE_FRESH_DAYS * DAY;

@Injectable()
export class KbService {
  constructor(
    private prisma: PrismaService,
    private sync: SyncService,
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
    if (cur.kind === 'SERVICE' && cur.priceUah === null && cur.source === 'CLINICCARDS') throw new BadRequestException('kb_price_needed');
    const now = new Date();
    await this.prisma.kbItem.update({ where: { id }, data: { approvedAt: now, approvedById: userId, reviewedAt: now } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.approved', details: { id } } });
  }

  // Approves every draft of one price-list group at once, after the person looked the group over. Items that still need a price
  // (imported without one) are skipped and counted, never approved without a price.
  async approveGroup(clinicId: string, userId: string, kind: KbKind, category: string | null): Promise<{ approved: number; skipped: number }> {
    if (!KB_KINDS.includes(kind)) throw new BadRequestException('bad_kb_kind');
    const drafts = await this.prisma.kbItem.findMany({ where: { clinicId, kind, category, approvedAt: null }, select: { id: true, kind: true, priceUah: true, source: true } });
    const ok = drafts.filter((d) => !(d.kind === 'SERVICE' && d.priceUah === null && d.source === 'CLINICCARDS'));
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

  // Drafts from the price list of the clinic's system. Nothing is approved: the currency of that list is not trusted, a person
  // checks every price. Services already in the knowledge base are left as they are.
  async importServices(clinicId: string, userId: string): Promise<{ added: number }> {
    const connector = await this.sync.connectorForClinic(clinicId);
    if (!connector?.fetchServiceList) throw new BadRequestException('kb_import_unavailable');
    let list: { externalId: string; name: string; groupName?: string; description?: string; priceUah?: number }[];
    try {
      list = await connector.fetchServiceList();
    } catch {
      throw new BadRequestException('kb_import_failed');
    }
    const known = new Set((await this.prisma.kbItem.findMany({ where: { clinicId, kind: 'SERVICE' }, select: { externalId: true, title: true } })).flatMap((k) => [k.externalId ?? '', k.title.toLowerCase()]));
    let added = 0;
    for (const s of list.slice(0, MAX_ITEMS)) {
      const name = s.name.trim().slice(0, 160);
      if (!name || known.has(s.externalId) || known.has(name.toLowerCase())) continue;
      if ((await this.prisma.kbItem.count({ where: { clinicId } })) >= MAX_ITEMS) break;
      await this.prisma.kbItem.create({ data: { clinicId, kind: 'SERVICE', title: name, category: s.groupName?.slice(0, 120) ?? null, text: (s.description ?? '').slice(0, 900), priceUah: s.priceUah !== undefined && Number.isFinite(s.priceUah) ? Math.round(s.priceUah) : null, source: 'CLINICCARDS', externalId: s.externalId } });
      added++;
    }
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.imported', details: { added } } });
    return { added };
  }

  // What the model may know. Only approved, active items. A price and its amount appear only when confirmed in the last 90 days.
  // A clinic with a long price list (112 dental has 234 items) cannot put it all into every prompt: with more than SERVICES_ALL services
  // only those that match the patient's words are included, plus the list of directions so the model knows what exists.
  // The amounts a reply may mention are those of the services that were included.
  async factsFor(clinicId: string, now = new Date(), query = ''): Promise<KbFacts> {
    const rows = await this.prisma.kbItem.findMany({ where: { clinicId, active: true, approvedAt: { not: null } }, orderBy: [{ kind: 'asc' }, { title: 'asc' }] });
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
      const price = r.priceUah !== null && fresh(r.reviewedAt, now) ? r.priceUah : null;
      if (price !== null) allowed.add(price);
      sections.SERVICE.push(`- ${r.title}${r.category ? ` (група: ${r.category})` : ''}${r.durationMin ? `; тривалість ${r.durationMin} хв` : ''}${price !== null ? `; ціна ${price} грн` : '; ціна: не називати, передати адміністратору'}${r.text ? `; ${r.text.replace(/\s*\n\s*/g, ' ')}` : ''}`);
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
    return { text: parts.join('\n\n').slice(0, PROMPT_BUDGET), allowedAmounts: [...allowed], pricesKnown: [...allowed].length > 0 || services.some((r) => r.priceUah !== null && fresh(r.reviewedAt, now)) };
  }
}
