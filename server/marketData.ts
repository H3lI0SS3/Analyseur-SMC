// Données de marché RÉELLES uniquement.
// - Twelve Data (si TWELVE_DATA_API_KEY est défini) : cotations spot EUR/USD et XAU/USD.
// - Sinon Yahoo Finance (gratuit, sans clé) : EURUSD=X et GC=F (futures or COMEX).
// H4 et D1 sont reconstruits à partir du H1 avec la frontière forex de 17h00 New York,
// comme les graphiques MT5 des brokers. Aucune donnée n'est inventée.

import { HOUR, marketClosed, tradingDayStart } from './time';

export interface Candle {
  t: number; // timestamp d'ouverture (ms, UTC)
  o: number;
  h: number;
  l: number;
  c: number;
}

export type Timeframe = 'M15' | 'H1' | 'H4' | 'D1';
export const TIMEFRAMES: Timeframe[] = ['D1', 'H4', 'H1', 'M15'];
export const TF_MS: Record<Timeframe, number> = { M15: 15 * 60_000, H1: HOUR, H4: 4 * HOUR, D1: 24 * HOUR };

export interface PairInfo {
  id: string; // 'EUR/USD'
  label: string;
  decimals: number;
  pipSize: number;
  contract: number; // taille d'un lot standard
  defaultSpread: number; // en prix
  twelveSymbol: string;
  yahooSymbol: string;
  isFuturesOnYahoo: boolean;
}

export const PAIRS: Record<string, PairInfo> = {
  'EUR/USD': {
    id: 'EUR/USD',
    label: 'EUR/USD',
    decimals: 5,
    pipSize: 0.0001,
    contract: 100_000,
    defaultSpread: 0.0001,
    twelveSymbol: 'EUR/USD',
    yahooSymbol: 'EURUSD=X',
    isFuturesOnYahoo: false,
  },
  'XAU/USD': {
    id: 'XAU/USD',
    label: 'Or (XAU/USD)',
    decimals: 2,
    pipSize: 0.1,
    contract: 100,
    defaultSpread: 0.3,
    twelveSymbol: 'XAU/USD',
    yahooSymbol: 'GC=F',
    isFuturesOnYahoo: true,
  },
};

export interface SeriesResult {
  pair: string;
  tf: Timeframe;
  candles: Candle[];
  source: 'Twelve Data' | 'Yahoo Finance';
  /** true si l'or vient des futures (Yahoo) : niveaux non transposables chez le broker */
  futuresProxy: boolean;
  /** true si la source a échoué et qu'on ressert une donnée réelle plus ancienne */
  fromStaleCache: boolean;
  fetchedAt: number;
}

const CACHE_TTL: Record<'M15' | 'H1', number> = { M15: 60_000, H1: 120_000 };
const cache = new Map<string, SeriesResult>();
const inflight = new Map<string, Promise<SeriesResult>>();

export function dataSourceName(): 'Twelve Data' | 'Yahoo Finance' {
  return process.env.TWELVE_DATA_API_KEY ? 'Twelve Data' : 'Yahoo Finance';
}

/** M15 et H1 sont téléchargés ; H4 et D1 sont reconstruits depuis le H1. */
export async function getSeries(pairId: string, tf: Timeframe): Promise<SeriesResult> {
  if (tf === 'H4' || tf === 'D1') {
    const h1 = await getRaw(pairId, 'H1');
    return { ...h1, tf, candles: aggregateTrading(h1.candles, tf) };
  }
  return getRaw(pairId, tf);
}

async function getRaw(pairId: string, tf: 'M15' | 'H1'): Promise<SeriesResult> {
  const pair = PAIRS[pairId];
  if (!pair) throw new Error(`Actif non supporté : ${pairId}`);
  const key = `${pairId}|${tf}`;
  const hit = cache.get(key);
  if (hit && !hit.fromStaleCache && Date.now() - hit.fetchedAt < CACHE_TTL[tf]) return hit;
  const running = inflight.get(key);
  if (running) return running;

  const p = (async () => {
    try {
      const useTwelve = !!process.env.TWELVE_DATA_API_KEY;
      const candles = useTwelve ? await fetchTwelve(pair, tf, process.env.TWELVE_DATA_API_KEY!) : await fetchYahoo(pair, tf);
      if (candles.length < 60) throw new Error(`Pas assez de bougies reçues pour ${pairId} ${tf} (${candles.length}).`);
      const res: SeriesResult = {
        pair: pairId,
        tf,
        candles,
        source: dataSourceName(),
        futuresProxy: !useTwelve && pair.isFuturesOnYahoo,
        fromStaleCache: false,
        fetchedAt: Date.now(),
      };
      cache.set(key, res);
      return res;
    } catch (err) {
      // Donnée réelle de moins de 15 min resservie, mais signalée comme telle.
      if (hit && Date.now() - hit.fetchedAt < 15 * 60_000) return { ...hit, fromStaleCache: true };
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// ---------- Limiteur Twelve Data (offre gratuite : 8 requêtes / minute) ----------
const twelveCalls: number[] = [];
async function twelveSlot() {
  for (;;) {
    const now = Date.now();
    while (twelveCalls.length && now - twelveCalls[0] > 60_000) twelveCalls.shift();
    if (twelveCalls.length < 7) {
      twelveCalls.push(now);
      return;
    }
    await new Promise(r => setTimeout(r, 60_000 - (now - twelveCalls[0]) + 50));
  }
}

async function fetchTwelve(pair: PairInfo, tf: 'M15' | 'H1', apiKey: string): Promise<Candle[]> {
  await twelveSlot();
  const interval = tf === 'M15' ? '15min' : '1h';
  const size = tf === 'M15' ? 700 : 5000;
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair.twelveSymbol)}` +
    `&interval=${interval}&outputsize=${size}&timezone=UTC&order=ASC&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);
  const json: any = await res.json();
  if (json.status === 'error' || !Array.isArray(json.values)) {
    throw new Error(`Twelve Data : ${json.message || 'réponse invalide'}`);
  }
  const out: Candle[] = json.values.map((v: any) => ({
    t: Date.parse(String(v.datetime).replace(' ', 'T') + (String(v.datetime).length > 10 ? 'Z' : 'T00:00:00Z')),
    o: Number(v.open),
    h: Number(v.high),
    l: Number(v.low),
    c: Number(v.close),
  }));
  return clean(out);
}

// ---------- Yahoo Finance ----------
async function fetchYahoo(pair: PairInfo, tf: 'M15' | 'H1'): Promise<Candle[]> {
  const [interval, range] = tf === 'M15' ? ['15m', '10d'] : ['60m', '1y'];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(pair.yahooSymbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingAnalyzer/3.0)', Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status} pour ${pair.yahooSymbol}`);
  const json: any = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r || !Array.isArray(r.timestamp)) {
    throw new Error(`Yahoo Finance : ${json?.chart?.error?.description || 'réponse invalide'}`);
  }
  const q = r.indicators?.quote?.[0] || {};
  const out: Candle[] = r.timestamp.map((ts: number, i: number) => ({ t: ts * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i] }));
  return clean(out);
}

/** Bougies valides, triées, sans doublon, hors week-end (certaines sources publient des bougies plates quand le marché est fermé). */
function clean(list: Candle[]): Candle[] {
  const ok = list.filter(
    c =>
      Number.isFinite(c.t) &&
      !marketClosed(c.t) &&
      [c.o, c.h, c.l, c.c].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0) &&
      c.h >= Math.max(c.o, c.c) &&
      c.l <= Math.min(c.o, c.c)
  );
  ok.sort((a, b) => a.t - b.t);
  return ok.filter((c, i) => i === 0 || c.t !== ok[i - 1].t);
}

/**
 * Regroupe des bougies H1 en H4 ou D1 sur la frontière forex de 17h00 New York
 * (H4 : 17h, 21h, 01h, 05h, 09h, 13h NY). Les bougies trop incomplètes sont écartées, sauf la dernière.
 */
export function aggregateTrading(h1: Candle[], tf: 'H4' | 'D1'): Candle[] {
  const out: (Candle & { n: number })[] = [];
  let cur: (Candle & { n: number }) | null = null;
  for (const c of h1) {
    const dayStart = tradingDayStart(c.t);
    const key = tf === 'D1' ? dayStart : dayStart + Math.floor((c.t - dayStart) / (4 * HOUR)) * 4 * HOUR;
    if (!cur || cur.t !== key) {
      if (cur) out.push(cur);
      cur = { t: key, o: c.o, h: c.h, l: c.l, c: c.c, n: 1 };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.n++;
    }
  }
  if (cur) out.push(cur);
  const min = tf === 'D1' ? 6 : 2;
  return out.filter((c, i) => i === out.length - 1 || c.n >= min).map(({ n, ...c }) => c);
}

// ---------- Cotations ----------
export interface QuoteInfo {
  price?: number;
  time?: number;
  changePct?: number | null;
  stale?: boolean;
  source?: string;
  futuresProxy?: boolean;
  error?: string;
}

/** Dernier prix (clôture M15 en cours) et variation depuis la clôture du jour de trading précédent. */
export async function getQuotes(): Promise<Record<string, QuoteInfo>> {
  const out: Record<string, QuoteInfo> = {};
  await Promise.all(
    Object.keys(PAIRS).map(async id => {
      try {
        const [m15, d1] = await Promise.all([getSeries(id, 'M15'), getSeries(id, 'D1')]);
        const last = m15.candles[m15.candles.length - 1];
        const today = tradingDayStart(last.t);
        const prevClose = [...d1.candles].reverse().find(c => c.t < today)?.c;
        out[id] = {
          price: Number(last.c.toFixed(PAIRS[id].decimals)),
          time: last.t,
          changePct: prevClose ? Number((((last.c - prevClose) / prevClose) * 100).toFixed(2)) : null,
          stale: marketClosed(Date.now()) || Date.now() - last.t > 20 * 60_000,
          source: m15.source,
          futuresProxy: m15.futuresProxy,
        };
      } catch (err: any) {
        out[id] = { error: err.message };
      }
    })
  );
  return out;
}
