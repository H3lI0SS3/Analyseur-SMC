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

// Offre gratuite Twelve Data : 800 crédits/jour. M15 rafraîchi toutes les 2 min, H1 toutes les 5 min.
const CACHE_TTL: Record<'M15' | 'H1', number> = { M15: 120_000, H1: 300_000 };
const cache = new Map<string, SeriesResult>();
const inflight = new Map<string, Promise<SeriesResult>>();

export function dataSourceName(): 'Twelve Data' | 'Yahoo Finance' {
  return process.env.TWELVE_DATA_API_KEY ? 'Twelve Data' : 'Yahoo Finance';
}

/** M15 et H1 sont téléchargés ; H4 et D1 sont reconstruits depuis le H1. */
export async function getSeries(pairId: string, tf: Timeframe, maxAgeMs?: number): Promise<SeriesResult> {
  if (tf === 'H4' || tf === 'D1') {
    const h1 = await getRaw(pairId, 'H1', maxAgeMs);
    return { ...h1, tf, candles: aggregateTrading(h1.candles, tf) };
  }
  return getRaw(pairId, tf, maxAgeMs);
}

const liveCache = new Map<string, { price: number; at: number }>();

/** Dernier prix en direct déjà connu (sans nouvelle requête), s'il a moins de maxAge. */
export function peekLivePrice(pairId: string, maxAge = 60_000) {
  const hit = liveCache.get(pairId);
  return hit && Date.now() - hit.at < maxAge ? hit : null;
}

/** Prix en direct (dernier prix connu de la source), mis en cache 15 s. Null si indisponible. */
export async function getLivePrice(pairId: string): Promise<{ price: number; at: number } | null> {
  const pair = PAIRS[pairId];
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!pair || !apiKey || marketClosed(Date.now())) return null;
  const hit = liveCache.get(pairId);
  if (hit && Date.now() - hit.at < 15_000) return hit;
  try {
    await twelveSlot();
    const res = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(pair.twelveSymbol)}&apikey=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(6_000) });
    const json: any = await res.json();
    const price = Number(json?.price);
    if (!res.ok || !Number.isFinite(price) || price <= 0) return null;
    const v = { price, at: Date.now() };
    liveCache.set(pairId, v);
    return v;
  } catch {
    return null;
  }
}

/**
 * Remplace le prix de la bougie M15 en cours par le prix en direct (clôture, plus haut, plus bas).
 * Les bougies clôturées ne sont jamais modifiées : la structure reste calculée sur des données figées.
 */
export function withLivePrice(m15: Candle[], live: { price: number; at: number } | null): Candle[] {
  if (!live || !m15.length) return m15;
  const last = m15[m15.length - 1];
  const period = TF_MS.M15;
  if (live.at >= last.t + period) {
    // la bougie en cours n'est pas encore dans la série : on l'ajoute
    const t = Math.floor(live.at / period) * period;
    return [...m15, { t, o: last.c, h: Math.max(last.c, live.price), l: Math.min(last.c, live.price), c: live.price }];
  }
  if (live.at < last.t) return m15;
  return [...m15.slice(0, -1), { ...last, c: live.price, h: Math.max(last.h, live.price), l: Math.min(last.l, live.price) }];
}

async function getRaw(pairId: string, tf: 'M15' | 'H1', maxAgeMs?: number): Promise<SeriesResult> {
  const pair = PAIRS[pairId];
  if (!pair) throw new Error(`Actif non supporté : ${pairId}`);
  const key = `${pairId}|${tf}`;
  const hit = cache.get(key);
  // Marché fermé : aucune nouvelle bougie, inutile de consommer des crédits (cache 30 min).
  const ttl = marketClosed(Date.now()) ? 30 * 60_000 : Math.min(CACHE_TTL[tf], maxAgeMs ?? Infinity);
  if (hit && !hit.fromStaleCache && Date.now() - hit.fetchedAt < ttl) return hit;
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
    if (twelveCalls.length < (Number(process.env.TWELVE_RATE_PER_MIN) || 7)) {
      twelveCalls.push(now);
      return;
    }
    await new Promise(r => setTimeout(r, 60_000 - (now - twelveCalls[0]) + 50));
  }
}

async function fetchTwelve(pair: PairInfo, tf: 'M15' | 'H1', apiKey: string, size = tf === 'M15' ? 700 : 5000): Promise<Candle[]> {
  await twelveSlot();
  const interval = tf === 'M15' ? '15min' : '1h';
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
async function fetchYahoo(pair: PairInfo, tf: 'M15' | 'H1', long = false): Promise<Candle[]> {
  const [interval, range] = tf === 'M15' ? ['15m', long ? '60d' : '10d'] : ['60m', '1y'];
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

// ---------- Historique long (backtest) ----------
export interface History {
  h1: Candle[];
  m15: Candle[];
  source: string;
  futuresProxy: boolean;
  fetchedAt: number;
  /** vrai si la source ne remonte pas plus loin que ce qui a été demandé */
  limitedBySource: boolean;
}
const historyCache = new Map<string, History>();

const fmtTwelve = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');

/**
 * Remonte l'historique Twelve Data page par page (5 000 bougies par page) jusqu'à maxBars,
 * ou jusqu'à ce que l'offre ne fournisse plus de données.
 */
async function fetchTwelveDeep(pair: PairInfo, tf: 'M15' | 'H1', apiKey: string, maxBars: number, onPage?: (n: number) => void) {
  const interval = tf === 'M15' ? '15min' : '1h';
  let all: Candle[] = [];
  let endDate: string | null = null;
  let limited = false;
  for (let page = 0; page < 20 && all.length < maxBars; page++) {
    await twelveSlot();
    const url =
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair.twelveSymbol)}` +
      `&interval=${interval}&outputsize=5000&timezone=UTC&order=ASC&apikey=${encodeURIComponent(apiKey)}` +
      (endDate ? `&end_date=${encodeURIComponent(endDate)}` : '');
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);
    const json: any = await res.json();
    if (json.status === 'error' || !Array.isArray(json.values) || !json.values.length) {
      if (page === 0) throw new Error(`Twelve Data : ${json.message || 'réponse invalide'}`);
      limited = true; // plus de données disponibles plus loin dans le passé
      break;
    }
    const chunk = clean(
      json.values.map((v: any) => ({
        t: Date.parse(String(v.datetime).replace(' ', 'T') + (String(v.datetime).length > 10 ? 'Z' : 'T00:00:00Z')),
        o: Number(v.open),
        h: Number(v.high),
        l: Number(v.low),
        c: Number(v.close),
      }))
    );
    const oldest = all.length ? all[0].t : Infinity;
    const fresh = chunk.filter(c => c.t < oldest);
    if (!fresh.length) {
      limited = true;
      break;
    }
    all = [...fresh, ...all];
    onPage?.(all.length);
    endDate = fmtTwelve(fresh[0].t - 60_000);
    // page incomplète côté source = on est au bout de l'historique disponible
    // (on compte les lignes BRUTES : les bougies du week-end retirées par clean() ne comptent pas)
    if (json.values.length < 4000) {
      limited = true;
      break;
    }
  }
  return { candles: all.slice(-maxBars), limited };
}

/**
 * Historique pour le backtest : jusqu'à ~2 ans de M15 (Twelve Data, par pages) et le H1 correspondant.
 * Sans clé Twelve Data : 60 jours de M15 (Yahoo). Mis en cache 6 h.
 */
export async function getHistory(pairId: string, onProgress?: (msg: string) => void): Promise<History> {
  const pair = PAIRS[pairId];
  if (!pair) throw new Error(`Actif non supporté : ${pairId}`);
  const hit = historyCache.get(pairId);
  if (hit && Date.now() - hit.fetchedAt < 6 * 3_600_000) return hit;
  const key = process.env.TWELVE_DATA_API_KEY;
  let res: History;
  if (key) {
    const m15 = await fetchTwelveDeep(pair, 'M15', key, 52_000, n => onProgress?.(`${n} bougies M15 téléchargées`));
    // H1 : couvrir la période M15 + 4 mois de préchauffage (structure D1/H4)
    const needH1 = Math.ceil((m15.candles[m15.candles.length - 1].t - m15.candles[0].t) / HOUR) + 4 * 30 * 24;
    const h1 = await fetchTwelveDeep(pair, 'H1', key, Math.min(needH1, 20_000), n => onProgress?.(`${n} bougies H1 téléchargées`));
    res = { h1: h1.candles, m15: m15.candles, source: 'Twelve Data', futuresProxy: false, fetchedAt: Date.now(), limitedBySource: m15.limited };
  } else {
    const [h1, m15] = [await fetchYahoo(pair, 'H1'), await fetchYahoo(pair, 'M15', true)];
    res = { h1, m15, source: 'Yahoo Finance', futuresProxy: pair.isFuturesOnYahoo, fetchedAt: Date.now(), limitedBySource: true };
  }
  historyCache.set(pairId, res);
  return res;
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
        const [m15s, d1] = await Promise.all([getSeries(id, 'M15'), getSeries(id, 'D1')]);
        // prix en direct déjà récupéré par une analyse récente : réutilisé sans requête supplémentaire
        const m15 = { ...m15s, candles: withLivePrice(m15s.candles, m15s.futuresProxy ? null : peekLivePrice(id)) };
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
