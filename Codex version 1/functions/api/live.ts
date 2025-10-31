interface Env {
  FRED_API_KEY?: string;
}

const SUPPORTED_CURRENCIES = ["USD", "PKR", "INR", "GBP", "EUR", "AED", "SAR", "BDT", "NPR"] as const;
const CURRENCY_API_URL = "https://latest.currency-api.pages.dev/v1/currencies/usd.json";
const FRED_OBSERVATIONS_URL = "https://api.stlouisfed.org/fred/series/observations";
const GOLD_SERIES_ID = "GOLDAMGBD229NLBM";
const SILVER_SERIES_ID = "SLVPRUSD";
const CURRENCY_TTL_MS = 5 * 60 * 1000;
const BULLION_TTL_MS = 10 * 60 * 1000;
const TROY_OUNCE_GRAMS = 31.1034768;

const FALLBACK_CURRENCY_RATES: Record<SupportedCurrency, number> = {
  USD: 1,
  PKR: 281.1,
  INR: 87.8,
  GBP: 0.74,
  EUR: 0.92,
  AED: 3.6725,
  SAR: 3.75,
  BDT: 121.7,
  NPR: 140.9,
};

const FALLBACK_BULLION = {
  goldUsdPerGram: 135.08,
  silverUsdPerGram: 1.7,
};

type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

interface CurrencyPayload {
  base: SupportedCurrency;
  rates: Record<SupportedCurrency, number>;
  timestamp: string;
  crossRates: Record<SupportedCurrency, Record<SupportedCurrency, number>>;
  cacheStatus: "fresh" | "cached";
}

interface BullionQuote {
  usdPerTroyOunce: number;
  usdPerGram: number;
  observationDate: string;
}

interface BullionPayload {
  gold: BullionQuote;
  silver: BullionQuote;
  cacheStatus: "fresh" | "cached";
}

interface CacheEntry<T> {
  payload: T;
  expiresAt: number;
}

class CurrencyService {
  private cache: CacheEntry<CurrencyPayload> | null = null;
  private lastGood: CurrencyPayload;

  constructor() {
    const fallbackRates = { ...FALLBACK_CURRENCY_RATES };
    const fallbackPayload: CurrencyPayload = {
      base: "USD",
      rates: fallbackRates,
      timestamp: new Date(0).toISOString(),
      crossRates: buildCrossRates(fallbackRates),
      cacheStatus: "cached",
    };
    this.lastGood = fallbackPayload;
  }

  async get(): Promise<CurrencyPayload> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return cloneCurrencyPayload(this.cache.payload, "cached");
    }
    try {
      const payload = await this.fetchFresh();
      this.cache = { payload, expiresAt: now + CURRENCY_TTL_MS };
      this.lastGood = cloneCurrencyPayload(payload, "cached");
      return cloneCurrencyPayload(payload, "fresh");
    } catch (error) {
      console.error("currency service fetch failed", error);
      return cloneCurrencyPayload(this.lastGood, "cached");
    }
  }

  private async fetchFresh(): Promise<CurrencyPayload> {
    const res = await fetch(CURRENCY_API_URL);
    if (!res.ok) {
      throw new Error(`currency api ${res.status}`);
    }
    const raw = (await res.json()) as {
      date?: string;
      usd?: Record<string, number>;
    };
    if (!raw.usd) {
      throw new Error("currency api missing usd payload");
    }
    const rates: Record<SupportedCurrency, number> = { ...FALLBACK_CURRENCY_RATES };
    rates.PKR = pickNumber(raw.usd.pkr, this.lastGood.rates.PKR);
    rates.INR = pickNumber(raw.usd.inr, this.lastGood.rates.INR);
    rates.GBP = pickNumber(raw.usd.gbp, this.lastGood.rates.GBP);
    rates.EUR = pickNumber(raw.usd.eur, this.lastGood.rates.EUR);
    rates.AED = pickNumber(raw.usd.aed, this.lastGood.rates.AED);
    rates.SAR = pickNumber(raw.usd.sar, this.lastGood.rates.SAR);
    rates.BDT = pickNumber(raw.usd.bdt, this.lastGood.rates.BDT);
    rates.NPR = pickNumber(raw.usd.npr, this.lastGood.rates.NPR);
    rates.USD = 1;
    const crossRates = buildCrossRates(rates);
    const timestamp = raw.date ? new Date(`${raw.date}T00:00:00Z`).toISOString() : new Date().toISOString();
    return { base: "USD", rates, timestamp, crossRates, cacheStatus: "fresh" };
  }
}

class BullionService {
  private cache: CacheEntry<BullionPayload> | null = null;
  private lastGood: BullionPayload;

  constructor() {
    const goldUsdPerGram = FALLBACK_BULLION.goldUsdPerGram;
    const silverUsdPerGram = FALLBACK_BULLION.silverUsdPerGram;
    this.lastGood = {
      gold: {
        usdPerGram: goldUsdPerGram,
        usdPerTroyOunce: goldUsdPerGram * TROY_OUNCE_GRAMS,
        observationDate: "fallback",
      },
      silver: {
        usdPerGram: silverUsdPerGram,
        usdPerTroyOunce: silverUsdPerGram * TROY_OUNCE_GRAMS,
        observationDate: "fallback",
      },
      cacheStatus: "cached",
    };
  }

  async get(env: Env): Promise<BullionPayload> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return cloneBullionPayload(this.cache.payload, "cached");
    }
    try {
      const payload = await this.fetchFresh(env);
      this.cache = { payload, expiresAt: now + BULLION_TTL_MS };
      this.lastGood = cloneBullionPayload(payload, "cached");
      return cloneBullionPayload(payload, "fresh");
    } catch (error) {
      console.error("bullion service fetch failed", error);
      return cloneBullionPayload(this.lastGood, "cached");
    }
  }

  private async fetchFresh(env: Env): Promise<BullionPayload> {
    if (!env.FRED_API_KEY) {
      throw new Error("missing FRED_API_KEY");
    }
    const [gold, silver] = await Promise.all([
      this.fetchSeries(env.FRED_API_KEY, GOLD_SERIES_ID),
      this.fetchSeries(env.FRED_API_KEY, SILVER_SERIES_ID),
    ]);
    const payload: BullionPayload = {
      gold,
      silver,
      cacheStatus: "fresh",
    };
    return payload;
  }

  private async fetchSeries(apiKey: string, seriesId: string): Promise<BullionQuote> {
    const url = new URL(FRED_OBSERVATIONS_URL);
    url.searchParams.set("series_id", seriesId);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("file_type", "json");
    url.searchParams.set("sort_order", "desc");
    url.searchParams.set("limit", "5");

    const res = await fetch(url.toString());
    if (!res.ok) {
      let detail: string | undefined;
      try {
        detail = await res.text();
      } catch (error) {
        detail = (error as Error)?.message;
      }
      console.error("fred series fetch error", seriesId, res.status, detail);
      throw new Error(`fred ${seriesId} ${res.status}`);
    }
    const data = (await res.json()) as {
      observations?: Array<{ value?: string; date?: string }>;
    };
    const observation = data.observations?.find((item) => item.value && item.value !== ".") ?? null;
    if (!observation || !observation.value || !observation.date) {
      throw new Error(`fred ${seriesId} missing observation`);
    }
    const usdPerTroyOunce = Number(observation.value);
    if (!isFinite(usdPerTroyOunce)) {
      throw new Error(`fred ${seriesId} invalid value`);
    }
    const usdPerGram = usdPerTroyOunce / TROY_OUNCE_GRAMS;
    return {
      usdPerTroyOunce,
      usdPerGram,
      observationDate: observation.date,
    };
  }
}

const currencyService = new CurrencyService();
const bullionService = new BullionService();

export const onRequest: PagesFunction<Env> = async (context) => {
  const [currency, bullion] = await Promise.all([currencyService.get(), bullionService.get(context.env)]);
  const response = {
    currency,
    bullion,
  };
  return Response.json(response, {
    headers: {
      "cache-control": "no-store",
    },
  });
};

function pickNumber(value: unknown, fallback: number): number {
  const num = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(num) ? num : fallback;
}

function buildCrossRates(rates: Record<SupportedCurrency, number>): Record<SupportedCurrency, Record<SupportedCurrency, number>> {
  const matrix = {} as Record<SupportedCurrency, Record<SupportedCurrency, number>>;
  for (const from of SUPPORTED_CURRENCIES) {
    const fromRate = rates[from];
    const denom = isFinite(fromRate) && fromRate !== 0 ? fromRate : NaN;
    const row = {} as Record<SupportedCurrency, number>;
    for (const to of SUPPORTED_CURRENCIES) {
      const toRate = rates[to];
      row[to] = isFinite(toRate) && isFinite(denom) ? toRate / denom : NaN;
    }
    matrix[from] = row;
  }
  return matrix;
}

function cloneCrossRates(
  matrix: Record<SupportedCurrency, Record<SupportedCurrency, number>>
): Record<SupportedCurrency, Record<SupportedCurrency, number>> {
  const copy = {} as Record<SupportedCurrency, Record<SupportedCurrency, number>>;
  for (const key of SUPPORTED_CURRENCIES) {
    const row = matrix[key];
    copy[key] = { ...(row || {}) };
  }
  return copy;
}

function cloneCurrencyPayload(payload: CurrencyPayload, status: "fresh" | "cached"): CurrencyPayload {
  return {
    base: payload.base,
    rates: { ...payload.rates },
    timestamp: payload.timestamp,
    crossRates: cloneCrossRates(payload.crossRates),
    cacheStatus: status,
  };
}

function cloneBullionPayload(payload: BullionPayload, status: "fresh" | "cached"): BullionPayload {
  return {
    gold: { ...payload.gold },
    silver: { ...payload.silver },
    cacheStatus: status,
  };
}
