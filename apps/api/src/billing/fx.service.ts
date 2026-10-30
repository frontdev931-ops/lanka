import { Injectable, Logger } from '@nestjs/common';

// UAH per 1 USD, for the one-off setup fee in dollars. Source: the National Bank of Ukraine open data; USD_UAH_RATE overrides it
// (the address is written from the NBU documentation and has not been called from this server yet).
@Injectable()
export class FxRates {
  private readonly log = new Logger(FxRates.name);
  private cached: { rate: number; at: number } | null = null;

  async usdUah(): Promise<number> {
    const fixed = Number(process.env.USD_UAH_RATE);
    if (fixed > 0) return fixed;
    if (this.cached && Date.now() - this.cached.at < 6 * 3_600_000) return this.cached.rate;
    try {
      const res = await fetch('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json', { signal: AbortSignal.timeout(10_000) });
      const rate = ((await res.json()) as { rate?: number }[])[0]?.rate;
      if (rate && rate > 0) {
        this.cached = { rate, at: Date.now() };
        return rate;
      }
    } catch (e) {
      this.log.warn(`Курс НБУ недоступний: ${(e as Error).message}`);
    }
    // The last known rate is better than a failed payment page
    if (this.cached) return this.cached.rate;
    throw new Error('fx_unavailable');
  }
}
