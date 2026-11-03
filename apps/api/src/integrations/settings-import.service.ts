import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicConnector } from './connector';

// The same number as the limit of the knowledge base of a clinic
const MAX_ITEMS = 600;

export type HoursImport = 'imported' | 'kept_manual' | 'unavailable';

// What Cliniccards already knows is taken from it, so the clinic does not type it twice: the working hours (GET /schedule-settings) and the
// price list (GET /prices). Reads only. Hours and holidays are never guessed from visits or from a calendar; the price list has no length of
// a visit, so a length is always asked of the clinic. What the clinic set by hand is never overwritten by a repeated import.
@Injectable()
export class SettingsImportService {
  private readonly log = new Logger(SettingsImportService.name);

  constructor(private prisma: PrismaService) {}

  // `force` is an explicit action of the clinic ("take them from Cliniccards"): it replaces hours typed by hand. A sync never does.
  async importHours(clinicId: string, connector: ClinicConnector, force = false): Promise<HoursImport> {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { workHours: true, workHoursSource: true } });
    const configured = !!c.workHours && typeof c.workHours === 'object' && Object.keys(c.workHours as object).length > 0;
    if (!force && configured && c.workHoursSource === 'MANUAL') return 'kept_manual';
    if (!connector.fetchWorkingHours) return 'unavailable';
    let wh;
    try {
      wh = await connector.fetchWorkingHours();
    } catch {
      return 'unavailable';
    }
    if (!wh) return 'unavailable';
    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: { workHours: wh.week as unknown as Prisma.InputJsonValue, workHoursHolidays: wh.holidays as unknown as Prisma.InputJsonValue, workHoursSource: 'CLINICCARDS', workHoursUpdatedAt: new Date() },
    });
    return 'imported';
  }

  // Drafts from the price list: names, groups, prices and the ids in Cliniccards. Nothing is approved and nothing is allowed for online booking.
  // A repeated import creates no duplicates (the id in Cliniccards is the key), refreshes drafts, and leaves an approved text, the length, the
  // cabinets and the permission for online booking as the clinic set them; what Cliniccards has now is kept apart (externalTitle, externalPrice)
  // so a change is visible. A hand-made service is NEVER linked to a position by the name alone: names repeat across groups, so a match is only
  // shown to the administrator (see KbService.review). A position that is no longer in a list that was read in full is marked as missing; an
  // error, an empty answer, a cut list, or too many positions vanishing at once marks nothing.
  async importPrices(clinicId: string, connector: ClinicConnector): Promise<{ added: number; updated: number; missing: number; total: number; note: string | null }> {
    if (!connector.fetchServiceList) throw new Error('unavailable');
    const list = await connector.fetchServiceList();
    const rows = await this.prisma.kbItem.findMany({ where: { clinicId, kind: 'SERVICE' } });
    const byExternal = new Map(rows.filter((r) => r.externalId).map((r) => [r.externalId!, r]));
    let total = await this.prisma.kbItem.count({ where: { clinicId } });
    let added = 0;
    let updated = 0;
    let truncated = list.length > MAX_ITEMS;
    const seen = new Set<string>();
    for (const s of list.slice(0, MAX_ITEMS)) {
      const name = s.name.trim().slice(0, 160);
      if (!name) continue;
      seen.add(s.externalId);
      // an explicit 0 is a price; only a missing value is "no price". Cliniccards also writes 0 where nobody typed a price, so a draft never
      // takes 0 as its own price: the administrator says whether the service is free.
      const price = s.priceUah !== undefined && Number.isFinite(s.priceUah) ? Math.round(s.priceUah) : null;
      const category = s.groupName?.slice(0, 120) ?? null;
      const text = (s.description ?? '').slice(0, 900);
      const cur = byExternal.get(s.externalId);
      if (cur) {
        const data: Prisma.KbItemUpdateInput = {};
        if (cur.externalTitle !== name) data.externalTitle = name;
        if (cur.externalPrice !== price) data.externalPrice = price;
        if (cur.missingInSourceAt) data.missingInSourceAt = null; // it is back in the price list
        if (cur.category !== category && (!cur.category || !cur.approvedAt)) data.category = category;
        if (!cur.approvedAt) {
          // a draft follows Cliniccards; a price typed by hand on the draft stays
          if (cur.title !== name) data.title = name;
          if (cur.text !== text && s.description !== undefined) data.text = text;
          const own = price !== null && price > 0 ? price : null;
          // a 0 on a draft was typed by the administrator ("free"), a draft never takes 0 from the source: it stays through every sync
          if ((cur.priceUah === null || (cur.priceUah > 0 && cur.priceUah === cur.externalPrice)) && cur.priceUah !== own) data.priceUah = own;
        }
        if (Object.keys(data).length) {
          await this.prisma.kbItem.update({ where: { id: cur.id }, data });
          updated++;
        }
        continue;
      }
      if (total >= MAX_ITEMS) {
        truncated = true;
        break;
      }
      await this.prisma.kbItem.create({ data: { clinicId, kind: 'SERVICE', title: name, category, text, priceUah: price !== null && price > 0 ? price : null, source: 'CLINICCARDS', externalId: s.externalId, externalTitle: name, externalPrice: price } });
      total++;
      added++;
    }
    // positions that vanished: only from a list that was read successfully and completely, and never in a mass
    const known = rows.filter((r) => r.externalId);
    const gone = known.filter((r) => !seen.has(r.externalId!) && !r.missingInSourceAt);
    let note: string | null = null;
    let missing = 0;
    if (!truncated && list.length > 0 && gone.length) {
      if (gone.length > Math.max(5, Math.floor(known.length * 0.3))) {
        note = `suspicious_missing:${gone.length}`;
      } else {
        await this.prisma.kbItem.updateMany({ where: { id: { in: gone.map((r) => r.id) } }, data: { missingInSourceAt: new Date() } });
        missing = gone.length;
      }
    }
    await this.prisma.clinic.update({ where: { id: clinicId }, data: { priceListSyncedAt: new Date(), priceListCount: list.length, priceListNote: note } });
    return { added, updated, missing, total: list.length, note };
  }

  // Both, for a sync: a failure of one never stops the other or the sync itself
  async afterSync(clinicId: string, connector: ClinicConnector): Promise<void> {
    await this.importHours(clinicId, connector).catch((e) => this.log.warn(`Working hours not imported: ${(e as Error).message}`));
    await this.importPrices(clinicId, connector).catch((e) => this.log.warn(`Price list not imported: ${(e as Error).message}`));
  }
}
