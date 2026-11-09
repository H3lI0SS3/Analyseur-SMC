// Données de marché RÉELLES uniquement.
// - cTrader Open API (si CTRADER_* est défini) : bougies au prix du broker FxPro, en priorité.
// - Twelve Data (si TWELVE_DATA_API_KEY est défini) : cotations spot EUR/USD et XAU/USD.
// - Sinon Yahoo Finance (gratuit, sans clé) : EURUSD=X et GC=F (futures or COMEX).
// H4 et D1 sont reconstruits à partir du H1 avec la frontière forex de 17h00 New York,
// comme les graphiques MT5 des brokers. Aucune donnée n'est inventée.

import { HOUR, marketClosed, tradingDayStart } from './time';
import { getCTrader } from './ctrader';

export interface Candle {
  t: number; // timestamp d'ouverture (ms, UTC)
  o: number;
  h: number;
  l: number;
  c: number;
  /** volume en ticks (cTrader uniquement ; absent avec Twelve Data et Yahoo) */
  v?: number;
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

/** Libellé de la source quand les bougies viennent de cTrader. */
export const CTRADER_SOURCE = 'cTrader (FxPro)';

export interface SeriesResult {
  pair: string;
  tf: Timeframe;
  candles: Candle[];
  source: string;
  /** true si l'or vient des futures (Yahoo) : niveaux non transposables chez le broker */
  futuresProxy: boolean;
  /** données de secours (Yahoo Finance) parce que Twelve Data est épuisé ou en panne */
  fallback?: boolean;
  /** or de secours : futures recalées sur le spot de cet écart (futures − spot), si connu */
  basis?: number | null;
  /** true si la source a échoué et qu'on ressert une donnée réelle plus ancienne */
  fromStaleCache: boolean;
  fetchedAt: number;
}

// Offre gratuite Twelve Data : 800 crédits/jour. M15 rafraîchi toutes les 2 min, H1 toutes les 5 min.
// Crédits Twelve Data limités (800 / jour) : M15 rafraîchi toutes les 5 min pour l'affichage (une analyse force 30 s),
// H1 toutes les 15 min. Avec l'app ouverte toute la journée : ~30 crédits / heure au lieu de ~85.
const CACHE_TTL: Record<'M15' | 'H1', number> = { M15: 300_000, H1: 900_000 };
const cache = new Map<string, SeriesResult>();
const inflight = new Map<string, Promise<SeriesResult>>();

export function dataSourceName(): string {
  if (getCTrader()) return CTRADER_SOURCE;
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
  if (!pair || marketClosed(Date.now())) return null;
  const hit = liveCache.get(pairId);
  if (hit && Date.now() - hit.at < 15_000) return hit;
  // cTrader : dernier prix de la bougie M5 en cours (prix du broker, cache 60 s)
  if (getCTrader()) {
    const m5 = await getM5(pairId).catch(() => null);
    const last = m5?.[m5.length - 1];
    if (last && Date.now() - last.t < 10 * 60_000) {
      const v = { price: last.c, at: Date.now() };
      liveCache.set(pairId, v);
      return v;
    }
  }
  if (!apiKey) return null;
  try {
    await twelveSlot();
    const res = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(pair.twelveSymbol)}&apikey=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(6_000) });
    if (res.status === 429) await twelveCheck(res); // bloque les appels suivants
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
      // 1. cTrader (FxPro) : prix du broker, aucun crédit consommé
      const ct = getCTrader();
      if (ct) {
        try {
          const candles = await ct.trendbars(pairId, tf, tf === 'M15' ? 700 : 5000);
          if (candles.length < 60) throw new Error(`Pas assez de bougies cTrader pour ${pairId} ${tf} (${candles.length}).`);
          const res: SeriesResult = { pair: pairId, tf, candles, source: CTRADER_SOURCE, futuresProxy: false, fromStaleCache: false, fetchedAt: Date.now() };
          ct.lastError = null;
          cache.set(key, res);
          return res;
        } catch (err) {
          ct.lastError = `${pairId} ${tf} : ${(err as Error).message}`;
          console.warn(`[cTrader ${pairId} ${tf}] ${(err as Error).message} : bascule sur Twelve Data.`);
        }
      }
      const useTwelve = !!process.env.TWELVE_DATA_API_KEY;
      let res: SeriesResult;
      if (useTwelve && !twelveLimitMessage()) {
        try {
          const candles = await fetchTwelve(pair, tf, process.env.TWELVE_DATA_API_KEY!);
          if (candles.length < 60) throw new Error(`Pas assez de bougies reçues pour ${pairId} ${tf} (${candles.length}).`);
          res = { pair: pairId, tf, candles, source: 'Twelve Data', futuresProxy: false, fromStaleCache: false, fetchedAt: Date.now() };
          lastTwelve.set(key, res);
        } catch (err) {
          // quota épuisé ou panne de Twelve Data : bascule sur Yahoo Finance
          res = await fromYahoo(pair, tf, key, `Twelve Data indisponible (${String((err as Error).message).slice(0, 80)})`);
        }
      } else if (useTwelve) {
        res = await fromYahoo(pair, tf, key, twelveLimitMessage()!);
      } else {
        const candles = await fetchYahoo(pair, tf);
        if (candles.length < 60) throw new Error(`Pas assez de bougies reçues pour ${pairId} ${tf} (${candles.length}).`);
        res = { pair: pairId, tf, candles, source: 'Yahoo Finance', futuresProxy: pair.isFuturesOnYahoo, fromStaleCache: false, fetchedAt: Date.now() };
      }
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
/** Twelve Data a répondu 429 : plus d'appel avant cette heure (fin de minute, ou minuit UTC si le quota du jour est épuisé). */
let twelveBlockedUntil = 0;
let twelveBlockedMsg = '';
const nextUtcMidnight = (t: number) => Math.floor(t / 86_400_000) * 86_400_000 + 86_400_000;

export function twelveLimitMessage(): string | null {
  return Date.now() < twelveBlockedUntil ? twelveBlockedMsg : null;
}

/** Lève une erreur claire et bloque les appels suivants si Twelve Data refuse pour quota. */
async function twelveCheck(res: Response): Promise<void> {
  if (res.status !== 429) {
    if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);
    return;
  }
  const body = await res.text().catch(() => '');
  const daily = /day|daily|jour/i.test(body);
  twelveBlockedUntil = daily ? nextUtcMidnight(Date.now()) + 60_000 : Date.now() + 61_000;
  twelveBlockedMsg = daily
    ? 'Quota quotidien de Twelve Data épuisé (800 requêtes / jour sur l’offre gratuite) : nouvelles données à minuit UTC (00h00 au Maroc).'
    : 'Limite de Twelve Data par minute atteinte : réessaie dans une minute.';
  throw new Error(twelveBlockedMsg);
}

async function twelveSlot() {
  if (Date.now() < twelveBlockedUntil) throw new Error(twelveBlockedMsg);
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

async function fetchTwelve(pair: PairInfo, tf: 'M5' | 'M15' | 'H1', apiKey: string, size = tf === 'M15' ? 700 : 5000): Promise<Candle[]> {
  await twelveSlot();
  const interval = tf === 'M5' ? '5min' : tf === 'M15' ? '15min' : '1h';
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair.twelveSymbol)}` +
    `&interval=${interval}&outputsize=${size}&timezone=UTC&order=ASC&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  await twelveCheck(res);
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

// ---------- Bougies M5 (exécution affinée) ----------
const m5Cache = new Map<string, { at: number; candles: Candle[] }>();

/**
 * Dernières bougies M5 (≈ 12 h) pour l'exécution affinée. Twelve Data uniquement : en secours Yahoo, l'or
 * serait en prix futures, donc pas de M5 (l'app attend plutôt que de donner une entrée fausse). Cache 60 s.
 */
export async function getM5(pairId: string, maxAgeMs = 60_000): Promise<Candle[] | null> {
  const pair = PAIRS[pairId];
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!pair || (!key && !getCTrader())) return null;
  const hit = m5Cache.get(pairId);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.candles;
  const ct = getCTrader();
  if (ct) {
    try {
      const candles = await ct.trendbars(pairId, 'M5', 150);
      if (candles.length >= 30) {
        m5Cache.set(pairId, { at: Date.now(), candles });
        return candles;
      }
    } catch (e: any) {
      ct.lastError = `${pairId} M5 : ${e?.message || e}`;
      console.warn(`[cTrader M5 ${pairId}] ${e?.message || e} : bascule sur Twelve Data.`);
    }
  }
  if (!key) return hit && Date.now() - hit.at < 10 * 60_000 ? hit.candles : null;
  try {
    const candles = await fetchTwelve(pair, 'M5', key!, 150);
    m5Cache.set(pairId, { at: Date.now(), candles });
    return candles;
  } catch (e: any) {
    console.warn(`[M5 ${pairId}] indisponible : ${e?.message || e}`);
    return hit && Date.now() - hit.at < 10 * 60_000 ? hit.candles : null;
  }
}

// ---------- Secours Yahoo Finance ----------
/** Dernières séries Twelve Data reçues : servent à recaler les futures de l'or sur le spot en secours. */
const lastTwelve = new Map<string, SeriesResult>();
/** Dernier écart futures − spot connu par actif (valable pour toutes les unités de temps). */
const lastBasis = new Map<string, { basis: number; at: number }>();

/** Écart futures − spot (médiane sur les bougies communes), ou null s'il n'y a pas assez de recouvrement. */
export function estimateBasis(futures: Candle[], spot: Candle[]): number | null {
  const byT = new Map(spot.map(c => [c.t, c.c]));
  const diffs = futures.filter(c => byT.has(c.t)).map(c => c.c - byT.get(c.t)!);
  if (diffs.length < 8) return null;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

async function fromYahoo(pair: PairInfo, tf: 'M15' | 'H1', key: string, why: string): Promise<SeriesResult> {
  const raw = await fetchYahoo(pair, tf);
  if (raw.length < 60) throw new Error(`${why}. Secours Yahoo Finance : pas assez de bougies (${raw.length}).`);
  let candles = raw;
  let basis: number | null = null;
  let futuresProxy = false;
  if (pair.isFuturesOnYahoo) {
    // or : Yahoo ne publie que les futures COMEX. On les recale sur le spot si on connaît l'écart.
    const spot = lastTwelve.get(key);
    basis = spot ? estimateBasis(raw, spot.candles) : null;
    if (basis !== null) lastBasis.set(pair.id, { basis, at: Date.now() });
    else {
      // écart mesuré sur l'autre unité de temps dans les 24 dernières heures (il bouge de quelques cents par jour)
      const known = lastBasis.get(pair.id);
      if (known && Date.now() - known.at < 24 * 3_600_000) basis = known.basis;
    }
    if (basis === null) futuresProxy = true;
    else candles = raw.map(c => ({ t: c.t, o: c.o - basis!, h: c.h - basis!, l: c.l - basis!, c: c.c - basis! }));
  }
  return {
    pair: pair.id,
    tf,
    candles,
    source: basis !== null ? `Yahoo Finance (secours, futures recalées −${basis.toFixed(2)} $)` : 'Yahoo Finance (secours)',
    futuresProxy,
    fallback: true,
    basis,
    fromStaleCache: false,
    fetchedAt: Date.now(),
  };
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
  /** M5 sur la même période (variante « entrée affinée M5 ») ; null si indisponible */
  m5: Candle[] | null;
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
async function fetchTwelveDeep(pair: PairInfo, tf: 'M5' | 'M15' | 'H1', apiKey: string, maxBars: number, onPage?: (n: number) => void) {
  const interval = tf === 'M5' ? '5min' : tf === 'M15' ? '15min' : '1h';
  let all: Candle[] = [];
  let endDate: string | null = null;
  let limited = false;
  let minuteRetries = 0;
  for (let page = 0; page < Math.ceil(maxBars / 3000) + 2 && all.length < maxBars; page++) {
    await twelveSlot();
    const url =
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair.twelveSymbol)}` +
      `&interval=${interval}&outputsize=5000&timezone=UTC&order=ASC&apikey=${encodeURIComponent(apiKey)}` +
      (endDate ? `&end_date=${encodeURIComponent(endDate)}` : '');
    // une page lente ne doit pas faire échouer tout le téléchargement : 2 nouvelles tentatives
    let res: Response | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        break;
      } catch (e: any) {
        const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timeout|aborted/i.test(String(e?.message));
        if (!timeout || attempt >= 2) throw e;
        await new Promise(r => setTimeout(r, 3_000));
        await twelveSlot();
      }
    }
    await twelveCheck(res);
    const json: any = await res.json();
    // Twelve Data signale ses limites dans une réponse 200 { status: 'error', code: 429 } : ce n'est PAS la fin de
    // l'historique. Limite par minute → on attend et on refait la même page ; quota du jour → erreur explicite.
    if (json.status === 'error' && (Number(json.code) === 429 || /credits|limit/i.test(String(json.message)))) {
      if (/day|daily/i.test(String(json.message))) {
        twelveBlockedUntil = nextUtcMidnight(Date.now()) + 60_000;
        twelveBlockedMsg = 'Quota quotidien de Twelve Data épuisé (800 requêtes / jour sur l’offre gratuite) : nouvelles données à minuit UTC (00h00 au Maroc).';
        throw new Error(twelveBlockedMsg);
      }
      if (++minuteRetries > 5) throw new Error(`Twelve Data : ${json.message}`);
      await new Promise(r => setTimeout(r, Number(process.env.TWELVE_MINUTE_WAIT_MS) || 61_000));
      page--;
      continue;
    }
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
    // M5 sur la même période que le M15 : facultatif, le backtest principal ne dépend pas de lui
    let m5: Candle[] | null = null;
    try {
      const r5 = await fetchTwelveDeep(pair, 'M5', key, Math.ceil(m15.candles.length * 3.05), n => onProgress?.(`${n} bougies M5 téléchargées`));
      m5 = r5.candles.length > 1000 ? r5.candles : null;
    } catch (e: any) {
      console.warn(`[Backtest ${pairId}] M5 indisponible : ${e?.message || e}`);
    }
    res = { h1: h1.candles, m15: m15.candles, m5, source: 'Twelve Data', futuresProxy: false, fetchedAt: Date.now(), limitedBySource: m15.limited };
  } else {
    const [h1, m15] = [await fetchYahoo(pair, 'H1'), await fetchYahoo(pair, 'M15', true)];
    res = { h1, m15, m5: null, source: 'Yahoo Finance', futuresProxy: pair.isFuturesOnYahoo, fetchedAt: Date.now(), limitedBySource: true };
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
