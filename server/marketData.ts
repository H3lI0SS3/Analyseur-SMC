// Données de marché RÉELLES uniquement.
// - Twelve Data (si TWELVE_DATA_API_KEY est défini) : cotations spot EUR/USD et XAU/USD.
// - Sinon Yahoo Finance (gratuit, sans clé) : EURUSD=X et GC=F (futures or COMEX).
// Aucune donnée n'est inventée : si la source échoue, une erreur est renvoyée.

export interface Candle {
  t: number; // timestamp d'ouverture (ms, UTC)
  o: number;
  h: number;
  l: number;
  c: number;
}

export type Timeframe = 'M15' | 'H1' | 'H4' | 'D1';
export const TIMEFRAMES: Timeframe[] = ['D1', 'H4', 'H1', 'M15'];

export interface PairInfo {
  id: string; // 'EUR/USD'
  label: string;
  decimals: number;
  pipSize: number;
  twelveSymbol: string;
  yahooSymbol: string;
  yahooNote?: string;
}

export const PAIRS: Record<string, PairInfo> = {
  'EUR/USD': {
    id: 'EUR/USD',
    label: 'EUR/USD',
    decimals: 5,
    pipSize: 0.0001,
    twelveSymbol: 'EUR/USD',
    yahooSymbol: 'EURUSD=X',
  },
  'XAU/USD': {
    id: 'XAU/USD',
    label: 'Or (XAU/USD)',
    decimals: 2,
    pipSize: 0.1,
    twelveSymbol: 'XAU/USD',
    yahooSymbol: 'GC=F',
    yahooNote:
      "Source Yahoo : prix des futures or COMEX (GC=F), qui peut différer de quelques dollars du XAU/USD spot de ton broker. Ajoute une clé TWELVE_DATA_API_KEY pour le spot.",
  },
};

export interface SeriesResult {
  pair: string;
  tf: Timeframe;
  candles: Candle[];
  source: 'Twelve Data' | 'Yahoo Finance';
  note?: string;
  fetchedAt: number;
}

const CACHE_TTL: Record<Timeframe, number> = {
  M15: 60_000,
  H1: 120_000,
  H4: 600_000,
  D1: 1_800_000,
};

const cache = new Map<string, SeriesResult>();
const inflight = new Map<string, Promise<SeriesResult>>();

export function dataSourceName(): 'Twelve Data' | 'Yahoo Finance' {
  return process.env.TWELVE_DATA_API_KEY ? 'Twelve Data' : 'Yahoo Finance';
}

export async function getSeries(pairId: string, tf: Timeframe): Promise<SeriesResult> {
  const pair = PAIRS[pairId];
  if (!pair) throw new Error(`Actif non supporté : ${pairId}`);
  const key = `${pairId}|${tf}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL[tf]) return hit;
  const running = inflight.get(key);
  if (running) return running;

  const p = (async () => {
    try {
      const candles = process.env.TWELVE_DATA_API_KEY
        ? await fetchTwelve(pair, tf, process.env.TWELVE_DATA_API_KEY)
        : await fetchYahoo(pair, tf);
      if (candles.length < 30) {
        throw new Error(`Pas assez de bougies reçues pour ${pairId} ${tf} (${candles.length}).`);
      }
      const res: SeriesResult = {
        pair: pairId,
        tf,
        candles,
        source: dataSourceName(),
        note: process.env.TWELVE_DATA_API_KEY ? undefined : pair.yahooNote,
        fetchedAt: Date.now(),
      };
      cache.set(key, res);
      return res;
    } catch (err) {
      // En cas d'échec, on peut resservir une donnée réelle récente (< 15 min) en le signalant,
      // mais jamais une donnée inventée.
      if (hit && Date.now() - hit.fetchedAt < 15 * 60_000) return hit;
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// ---------- Twelve Data ----------
const TWELVE_INTERVAL: Record<Timeframe, string> = { M15: '15min', H1: '1h', H4: '4h', D1: '1day' };

async function fetchTwelve(pair: PairInfo, tf: Timeframe, apiKey: string): Promise<Candle[]> {
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair.twelveSymbol)}` +
    `&interval=${TWELVE_INTERVAL[tf]}&outputsize=300&timezone=UTC&order=ASC&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);
  const json: any = await res.json();
  if (json.status === 'error' || !Array.isArray(json.values)) {
    throw new Error(`Twelve Data : ${json.message || 'réponse invalide'}`);
  }
  const out: Candle[] = json.values
    .map((v: any) => ({
      t: Date.parse(v.datetime.replace(' ', 'T') + (v.datetime.length > 10 ? 'Z' : 'T00:00:00Z')),
      o: Number(v.open),
      h: Number(v.high),
      l: Number(v.low),
      c: Number(v.close),
    }))
    .filter(isValidCandle);
  out.sort((a, b) => a.t - b.t);
  return out;
}

// ---------- Yahoo Finance ----------
async function fetchYahooRaw(symbol: string, interval: string, range: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingAnalyzer/2.0)', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status} pour ${symbol}`);
  const json: any = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r || !Array.isArray(r.timestamp)) {
    throw new Error(`Yahoo Finance : ${json?.chart?.error?.description || 'réponse invalide'}`);
  }
  const q = r.indicators?.quote?.[0] || {};
  const out: Candle[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c: Candle = { t: r.timestamp[i] * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i] };
    if (isValidCandle(c)) out.push(c);
  }
  return out;
}

async function fetchYahoo(pair: PairInfo, tf: Timeframe): Promise<Candle[]> {
  switch (tf) {
    case 'M15':
      return fetchYahooRaw(pair.yahooSymbol, '15m', '10d');
    case 'H1':
      return fetchYahooRaw(pair.yahooSymbol, '60m', '1mo');
    case 'H4':
      return aggregate(await fetchYahooRaw(pair.yahooSymbol, '60m', '6mo'), 4 * 3600_000);
    case 'D1':
      return fetchYahooRaw(pair.yahooSymbol, '1d', '1y');
  }
}

/** Regroupe des bougies en périodes fixes alignées sur l'UTC (ex : H4 = 00h, 04h, 08h…). */
export function aggregate(candles: Candle[], periodMs: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of candles) {
    const bucket = Math.floor(c.t / periodMs) * periodMs;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: c.o, h: c.h, l: c.l, c: c.c };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function isValidCandle(c: Candle): boolean {
  return (
    Number.isFinite(c.t) &&
    [c.o, c.h, c.l, c.c].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0) &&
    c.h >= c.l
  );
}

export interface QuoteInfo {
  price?: number;
  time?: number;
  changePct?: number | null;
  stale?: boolean;
  source?: string;
  error?: string;
}

/** Dernier prix (clôture M15 en cours) et variation depuis la clôture de la veille. */
export async function getQuotes(): Promise<Record<string, QuoteInfo>> {
  const out: Record<string, QuoteInfo> = {};
  await Promise.all(
    Object.keys(PAIRS).map(async id => {
      try {
        const [m15, d1] = await Promise.all([getSeries(id, 'M15'), getSeries(id, 'D1')]);
        const last = m15.candles[m15.candles.length - 1];
        const today = Math.floor(last.t / 86_400_000) * 86_400_000;
        const prevClose = [...d1.candles].reverse().find(c => c.t < today)?.c;
        out[id] = {
          price: Number(last.c.toFixed(PAIRS[id].decimals)),
          time: last.t,
          changePct: prevClose ? Number((((last.c - prevClose) / prevClose) * 100).toFixed(2)) : null,
          stale: Date.now() - last.t > 45 * 60_000,
          source: m15.source,
        };
      } catch (err: any) {
        out[id] = { error: err.message };
      }
    })
  );
  return out;
}
