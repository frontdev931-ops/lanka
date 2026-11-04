import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsImportService } from '../integrations/settings-import.service';
import { SyncService } from '../integrations/sync.service';
import { stemsOf } from '../ai/dental';

export const KB_KINDS = ['SERVICE', 'DOCTOR', 'LOCATION', 'FAQ'] as const;
export type KbKind = (typeof KB_KINDS)[number];
const DAY = 86_400_000;
// A price is quoted only while a person confirmed it this recently
export const PRICE_FRESH_DAYS = 90;
const MAX_ITEMS = 600;
// How much of the knowledge goes into one prompt
const PROMPT_BUDGET = 14000;
// The services take at most this much of it, so doctors, addresses and answers are never cut off
const SERVICES_BUDGET = 10000;
// Up to this many services go into every prompt; above it only the ones that match the question (at most SERVICES_SHOWN)
const SERVICES_ALL = 40;
const SERVICES_SHOWN = 30;

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
  // The amounts (UAH) the reply may mention: only known, current prices of the clinic's own list
  allowedAmounts: number[];
  // The services shown to the model with a known price: a named sum must belong to the service it is named for
  priced: { title: string; category: string | null; amount: number }[];
  // For the diagnostic log (ids only): the services put into the prompt and how many the clinic has
  shownIds: string[];
  serviceCount: number;
  pricesKnown: boolean;
}

// An imported position follows the price list by itself. A discrepancy exists only for a price the clinic set by hand on purpose (a local
// exception) that Cliniccards now contradicts, until the administrator accepts the source price or keeps the own one.
export const priceDivergent = (r: { externalId: string | null; externalPrice: number | null; priceUah: number | null; externalPriceAcked: number | null; localFields: string[] }) =>
  !!r.externalId && r.localFields.includes('priceUah') && r.externalPrice !== null && r.externalPrice !== r.priceUah && r.externalPrice !== r.externalPriceAcked;

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
      stale: !!r.approvedAt && !(r.externalId && !r.localFields.includes('priceUah')) && !fresh(r.reviewedAt, now),
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

  // Any change of the content of a hand-made item takes the approval back: the AI uses it again only after a person approves the new version.
  // An imported service keeps its approval (it follows Cliniccards); a field the clinic changes by hand becomes a local exception that
  // an import never overwrites (a price equal to the source's is no exception).
  async update(clinicId: string, userId: string, id: string, d: KbInput) {
    const cur = await this.prisma.kbItem.findFirst({ where: { id, clinicId } });
    if (!cur) throw new NotFoundException('kb_not_found');
    const data = this.clean({ ...d, kind: undefined });
    const contentChanged = (['title', 'text', 'durationMin', 'priceUah'] as const).some((k) => data[k] !== undefined && data[k] !== cur[k]);
    const local = new Set(cur.localFields);
    if (cur.externalId) {
      if (data.title !== undefined && data.title !== cur.title) data.title === cur.externalTitle ? local.delete('title') : local.add('title');
      if (data.text !== undefined && data.text !== cur.text) local.add('text');
      if (data.priceUah !== undefined && data.priceUah !== cur.priceUah) data.priceUah !== null && data.priceUah > 0 && data.priceUah === cur.externalPrice ? local.delete('priceUah') : local.add('priceUah');
    }
    const resetApproval = contentChanged && !cur.externalId;
    await this.prisma.kbItem.update({ where: { id }, data: { ...data, localFields: [...local], ...(resetApproval ? { approvedAt: null, approvedById: null } : {}) } });
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
    // accepting the source price returns the position to following Cliniccards (a source 0 is kept as an explicit "free")
    if (action === 'accept') await this.prisma.kbItem.update({ where: { id }, data: { priceUah: cur.externalPrice, externalPriceAcked: null, reviewedAt: new Date(), localFields: cur.externalPrice === 0 ? cur.localFields : cur.localFields.filter((f) => f !== 'priceUah') } });
    else await this.prisma.kbItem.update({ where: { id }, data: { externalPriceAcked: cur.externalPrice, reviewedAt: new Date() } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.price_resolved', details: { id, action, source: cur.externalPrice, own: cur.priceUah } } });
  }

  // A position that vanished from the price list: keep it as the clinic's own service, or switch it off (nothing is deleted)
  async resolveMissing(clinicId: string, userId: string, id: string, action: 'keep' | 'disable') {
    const cur = await this.prisma.kbItem.findFirst({ where: { id, clinicId, kind: 'SERVICE', missingInSourceAt: { not: null } } });
    if (!cur) throw new NotFoundException('kb_not_found');
    if (action === 'keep') await this.prisma.kbItem.update({ where: { id }, data: { missingInSourceAt: null, externalId: null, externalTitle: null, externalPrice: null, externalPriceAcked: null, localFields: [] } });
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
      this.prisma.kbItem.update({ where: { id: manual.id }, data: { externalId: imp.externalId, externalTitle: imp.externalTitle, externalPrice: imp.externalPrice, localFields: ['title', 'text', ...(manual.priceUah !== null ? ['priceUah'] : [])], ...(manual.category ? {} : { category: imp.category }) } }),
    ]);
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.linked', details: { manualId, importedId } } });
  }

  async dismissMatch(clinicId: string, userId: string, id: string) {
    const r = await this.prisma.kbItem.updateMany({ where: { id, clinicId, kind: 'SERVICE', externalId: null }, data: { matchDismissed: true } });
    if (!r.count) throw new NotFoundException('kb_not_found');
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'kb.match_dismissed', details: { id } } });
  }

  // Services ranked by the words of the patient (see factsFor): stems of the title and the group, the words of the last message weigh three
  // times more, a stem that many services share weighs little. Shorter stems are tried when nothing matched.
  rankServices<T extends { title: string; category: string | null }>(services: T[], query: string, focus: string, max: number): { r: T; score: number }[] {
    const N = services.length;
    const run = (n: number) => {
      const sets = services.map((r) => new Set(stemsOf(`${r.title} ${r.category ?? ''}`, n)));
      const df = new Map<string, number>();
      for (const set of sets) for (const st of set) df.set(st, (df.get(st) ?? 0) + 1);
      const q = new Set(stemsOf(query, n));
      const f = new Set(stemsOf(focus, n));
      return services
        .map((r, i) => {
          let score = 0;
          for (const st of new Set([...q, ...f])) if (sets[i].has(st)) score += (f.has(st) ? 3 : 1) * Math.log(1 + N / df.get(st)!);
          return { r, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, max);
    };
    const found = run(5);
    return found.length ? found : run(4);
  }

  // The services of the clinic that the patient's words point to (best first), for choosing the service of a booking. Only services that can
  // be booked: trusted, active, and not vanished from the price list.
  async matchServices(clinicId: string, query: string, focus: string, max = 6) {
    const rows = await this.prisma.kbItem.findMany({ where: { clinicId, kind: 'SERVICE', active: true, approvedAt: { not: null }, missingInSourceAt: null } });
    return this.rankServices(rows, query, focus, max);
  }

  // What the model may know. Services: every active service of the clinic, imported from Cliniccards (also drafts) or made by hand, whether or
  // not it is allowed for online booking and whether or not it has a length. The other kinds (doctors, addresses, answers) only when approved.
  // A price is named only when it is known and current: a number, not a guess. A price is current when it follows the last read of the price
  // list (not older than 90 days) or was confirmed by a person in the last 90 days; an unknown price, a position that vanished from the
  // price list and a price the source and the clinic disagree about are told to the model as "do not name, the administrator will clarify".
  // A clinic with a long price list (112 dental has 234 items) cannot put it all into every prompt: with more than SERVICES_ALL services
  // only those that match the patient's words are included, plus the list of directions so the model knows what exists.
  // The amounts a reply may mention are those of the services that were included.
  async factsFor(clinicId: string, now = new Date(), query = '', focus = ''): Promise<KbFacts> {
    const [all, clinic] = await Promise.all([
      this.prisma.kbItem.findMany({ where: { clinicId, active: true }, orderBy: [{ kind: 'asc' }, { title: 'asc' }] }),
      this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { priceListSyncedAt: true } }),
    ]);
    // Trusted: services imported from the connected Cliniccards (they follow it by themselves), and everything else only once approved.
    // A hand-made draft is not published.
    const rows = all.filter((r) => !!r.approvedAt || (r.kind === 'SERVICE' && !!r.externalId && r.source === 'CLINICCARDS'));
    if (!rows.length) return { text: null, allowedAmounts: [], priced: [], shownIds: [], serviceCount: 0, pricesKnown: false };
    const services = rows.filter((r) => r.kind === 'SERVICE');
    // KNOWN: a number that may be named; FREE: explicitly free; CONFLICT / GONE / UNKNOWN: the administrator clarifies
    const priceOf = (r: (typeof services)[number]): { state: 'KNOWN' | 'FREE' | 'CONFLICT' | 'GONE' | 'UNKNOWN'; amount: number | null } => {
      if (r.missingInSourceAt) return { state: 'GONE', amount: null };
      if (priceDivergent(r)) return { state: 'CONFLICT', amount: null };
      if (r.priceUah === null) return { state: 'UNKNOWN', amount: null };
      const followsSource = !!r.externalId && r.source === 'CLINICCARDS' && !r.localFields.includes('priceUah');
      const current = followsSource ? fresh(clinic?.priceListSyncedAt ?? null, now) : fresh(r.reviewedAt, now);
      if (!current) return { state: 'UNKNOWN', amount: null };
      return { state: r.priceUah === 0 ? 'FREE' : 'KNOWN', amount: r.priceUah };
    };
    const states = new Map(services.map((r) => [r.id, priceOf(r)]));
    let shown = services;
    let directions: string[] = [];
    let partial = false;
    if (services.length > SERVICES_ALL) {
      // The search runs over the WHOLE list (not only what fits in the prompt). Words of the patient (Russian and Ukrainian spellings are
      // folded together, a typo of the price list like "гігєна" too) are matched to the title and group by stems; the words of the LAST message
      // (`focus`) weigh three times more than the earlier ones, so a new topic is not drowned by the old ones; a stem that many services share
      // ("професійна") weighs little (by how rare it is in this price list). Shorter stems are tried when nothing matched.
      partial = true;
      const found = this.rankServices(services, query, focus, SERVICES_SHOWN);
      shown = found.map((x) => x.r);
      directions = [...new Set(services.map((r) => r.category).filter((c): c is string => !!c))].slice(0, 40);
    }
    const allowed = new Set<number>();
    const priced: KbFacts['priced'] = [];
    const sections: Record<KbKind, string[]> = { SERVICE: [], DOCTOR: [], LOCATION: [], FAQ: [] };
    for (const r of shown) {
      const p = states.get(r.id)!;
      if (p.amount !== null && p.state !== 'FREE') allowed.add(p.amount);
      if (p.state === 'FREE') allowed.add(0);
      if (p.amount !== null) priced.push({ title: r.title, category: r.category, amount: p.amount });
      const price =
        p.state === 'FREE'
          ? '; безкоштовно (ціна 0 грн)'
          : p.amount !== null
            ? `; ціна ${p.amount} грн (фіксована)`
            : p.state === 'GONE'
              ? '; ціна: не називати, цієї позиції вже немає в актуальному прайсі, вартість треба уточнити в адміністратора'
              : p.state === 'CONFLICT'
                ? '; ціна: не називати, дані про ціну суперечливі, вартість треба уточнити в адміністратора'
                : '; ціна: не називати, вона невідома, вартість треба уточнити в адміністратора';
      sections.SERVICE.push(`- ${r.title}${r.category ? ` (група: ${r.category})` : ''}${r.durationMin ? `; тривалість ${r.durationMin} хв` : ''}${price}${r.text ? `; склад і опис саме цієї послуги: ${r.text.replace(/\s*\n\s*/g, ' ').slice(0, 400)}` : ''}`);
    }
    for (const r of rows) {
      const kind = r.kind as KbKind;
      if (kind === 'FAQ') sections.FAQ.push(`- Питання: ${r.title}\n  Відповідь: ${r.text}`);
      else if (kind === 'DOCTOR' || kind === 'LOCATION') sections[kind].push(`- ${r.title}${r.text ? `: ${r.text}` : ''}`);
    }
    const parts: string[] = [];
    const add = (head: string, lines: string[]) => lines.length && parts.push(`${head}\n${lines.join('\n')}`);
    if (partial) {
      parts.push(
        `НАПРЯМКИ ПОСЛУГ КЛІНІКИ: ${directions.join(', ')}\nПрайс клініки великий (${services.length} позицій), нижче лише ті послуги, що найближче до слів пацієнта. ${shown.length ? 'Відсутність послуги в цьому списку НЕ означає, що її немає в клініці: не стверджуй, що такої послуги нема, а якщо потрібної немає серед наведених, попроси уточнити назву.' : 'Точного збігу за словами пацієнта не знайдено: не стверджуй, що такої послуги немає, і не називай жодної ціни; попроси уточнити назву послуги або скажи, що вартість уточнить адміністратор.'}`,
      );
    }
    // whole lines only: the least relevant services are dropped, a line is never cut in the middle
    let used = 0;
    const fit = sections.SERVICE.filter((l) => (used += l.length + 1) <= SERVICES_BUDGET);
    add('ПОСЛУГИ:', fit);
    add('ЛІКАРІ:', sections.DOCTOR);
    add('АДРЕСИ ТА КОНТАКТИ:', sections.LOCATION);
    add('ЧАСТІ ПИТАННЯ:', sections.FAQ);
    // pricesKnown: the clinic has a service list, so a question about a price goes to the model (it names a known price or says it is to be clarified)
    return { text: parts.join('\n\n').slice(0, PROMPT_BUDGET), allowedAmounts: [...allowed], priced, shownIds: shown.map((r) => r.id), serviceCount: services.length, pricesKnown: services.length > 0 };
  }
}
