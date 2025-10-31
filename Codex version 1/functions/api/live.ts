interface Env {
  BULLION_CSV_URL?: string;
}

const SUPPORTED_CURRENCIES = ["USD", "PKR", "INR", "GBP", "EUR", "AED", "SAR", "BDT", "NPR"] as const;
const CURRENCY_API_URL = "https://latest.currency-api.pages.dev/v1/currencies/usd.json";
const CURRENCY_TTL_MS = 5 * 60 * 1000;
const BULLION_TTL_MS = 12 * 60 * 60 * 1000;
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
  observationLabel: "fallback",
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
    this.lastGood = createFallbackBullionPayload();
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
      return cloneBullionPayload(payload, payload.cacheStatus);
    } catch (error) {
      console.error("bullion service fetch failed", error);
      return cloneBullionPayload(this.lastGood, "cached");
    }
  }

  private async fetchFresh(env: Env): Promise<BullionPayload> {
    if (!env.BULLION_CSV_URL) {
      console.warn("bullion csv url missing; using fallback prices");
      return createFallbackBullionPayload();
    }

    const sheet = await fetchBullionSheet(env.BULLION_CSV_URL);

    const gold = sheet.gold ?? this.lastGood.gold ?? createFallbackGoldQuote();
    if (!sheet.gold) {
      console.warn("gold price fallback in effect; sheet missing gold row");
    }

    const silver = sheet.silver ?? this.lastGood.silver ?? createFallbackSilverQuote();
    if (!sheet.silver) {
      console.warn("silver price fallback in effect; sheet missing silver row");
    }

    const cacheStatus: "fresh" | "cached" =
      sheet.gold && sheet.silver ? "fresh" : "cached";

    return {
      gold,
      silver,
      cacheStatus,
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

function createFallbackBullionPayload(): BullionPayload {
  return {
    gold: createFallbackGoldQuote(),
    silver: createFallbackSilverQuote(),
    cacheStatus: "cached",
  };
}

function createFallbackGoldQuote(): BullionQuote {
  const usdPerGram = FALLBACK_BULLION.goldUsdPerGram;
  return {
    usdPerGram,
    usdPerTroyOunce: usdPerGram * TROY_OUNCE_GRAMS,
    observationDate: FALLBACK_BULLION.observationLabel,
  };
}

function createFallbackSilverQuote(): BullionQuote {
  const usdPerGram = FALLBACK_BULLION.silverUsdPerGram;
  return {
    usdPerGram,
    usdPerTroyOunce: usdPerGram * TROY_OUNCE_GRAMS,
    observationDate: FALLBACK_BULLION.observationLabel,
  };
}

async function fetchBullionSheet(url: string): Promise<{ gold?: BullionQuote; silver?: BullionQuote }> {
  const res = await fetch(url, {
    headers: {
      // Disable intermediate caching so Sheets updates propagate predictably
      "cache-control": "no-cache",
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("bullion sheet fetch error", res.status, detail);
    throw new Error(`bullion sheet ${res.status}`);
  }
  const text = await res.text();
  return parseBullionCsv(text);
}

function parseBullionCsv(csv: string): { gold?: BullionQuote; silver?: BullionQuote } {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {};
  }

  const headers = parseCsvLine(lines[0]).map((value) => value.trim().toLowerCase());
  const metalIdx = headers.findIndex((value) => value === "metal" || value.includes("metal"));
  const gramIdx = headers.findIndex((value) => value.includes("usd") && value.includes("gram"));
  const ounceIdx = headers.findIndex((value) => value.includes("usd") && (value.includes("ounce") || value.includes("oz")));
  const dateIdx = headers.findIndex((value) => value.includes("date") || value.includes("time") || value.includes("updated"));

  const results: { gold?: BullionQuote; silver?: BullionQuote } = {};

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (cells.length === 0) continue;

    const metalRaw = normalizeCell(cells[metalIdx]);
    if (!metalRaw) continue;

    const normalizedMetal = metalRaw.toLowerCase();
    const target = normalizedMetal.includes("gold") ? "gold" : normalizedMetal.includes("silver") ? "silver" : null;
    if (!target) continue;

    const usdPerGramCell = normalizeCell(cells[gramIdx]);
    const usdPerOunceCell = normalizeCell(cells[ounceIdx]);
    const observationRaw = normalizeCell(cells[dateIdx]);

    let usdPerGram = parseCurrencyNumber(usdPerGramCell);
    let usdPerTroyOunce = parseCurrencyNumber(usdPerOunceCell);

    if (usdPerGram == null && usdPerTroyOunce != null) {
      usdPerGram = usdPerTroyOunce / TROY_OUNCE_GRAMS;
    } else if (usdPerGram != null && usdPerTroyOunce == null) {
      usdPerTroyOunce = usdPerGram * TROY_OUNCE_GRAMS;
    }

    if (usdPerGram == null || usdPerTroyOunce == null) {
      continue;
    }

    const observationDate = normalizeObservationDate(observationRaw);

    const quote: BullionQuote = {
      usdPerGram,
      usdPerTroyOunce,
      observationDate,
    };

    results[target] = quote;
  }

  return results;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function normalizeCell(cell?: string): string | null {
  if (cell == null) return null;
  const trimmed = cell.trim();
  return trimmed.length ? trimmed : null;
}

function parseCurrencyNumber(value: string | null): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function normalizeObservationDate(value: string | null): string {
  if (!value) {
    return new Date().toISOString();
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return new Date().toISOString();
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  return trimmed;
}
