// Suivi automatique des trades pris depuis l'analyse.
// Mêmes règles que le moteur : ordre limite annulé après sa validité (4 h) ou si TP1 est atteint avant l'exécution,
// stop vérifié avant l'objectif dans la même bougie, 50 % à TP1 puis stop au point d'entrée et reste à TP2.
import type { JournalEntry } from '../types';
import { api } from './utils';

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

const M15 = 15 * 60_000;
const EXPIRY = 4 * 3_600_000;
const MAX_HOLD = 5 * 24 * 3_600_000;

/** Trades que l'app suit encore toute seule. */
export const isTracked = (j: JournalEntry) => !!j.auto && (j.result === 'attente' || j.result === 'en_cours');

/** Rejoue un trade sur les bougies M15 clôturées et renvoie son nouvel état (ou null si rien ne change). */
export function evaluate(j: JournalEntry, candles: Candle[], now: number): Partial<JournalEntry> | null {
  if (!j.tp1) return null;
  const long = j.direction === 'acheter';
  const spread = j.spread ?? 0;
  // bougies clôturées qui commencent après la prise du trade (comme le backtest : on part de la bougie suivante)
  const closed = candles.filter(c => c.t + M15 <= now && c.t >= j.createdAt - (j.createdAt % M15) + (j.createdAt % M15 ? M15 : 0));
  const entry = j.entryType === 'marché' && long ? j.entry + spread : j.entry;
  const risk = Math.abs(entry - j.sl);
  if (!risk) return null;
  const commR = (j.commissionPerLot ?? 0) / Math.max(1e-9, risk * (j.contract ?? 1)); // commission en fraction de R
  const toR = (pnl: number) => Number(((pnl / risk - commR) / (1 + commR)).toFixed(2));

  // 1. exécution
  let filledAt: number | null = j.filledAt ?? null;
  let i0: number;
  if (filledAt === null) {
    if (j.entryType === 'marché') {
      filledAt = j.createdAt;
    } else {
      const deadline = j.validUntil ?? j.createdAt + EXPIRY;
      let found = -1;
      for (let i = 0; i < closed.length && closed[i].t < deadline; i++) {
        const c = closed[i];
        const touched = long ? c.l <= j.entry - spread : c.h >= j.entry;
        if (touched) {
          found = i;
          break;
        }
        const tp1Reached = long ? c.h >= j.tp1 : c.l <= j.tp1 - spread;
        if (tp1Reached) return { result: 'expire', rMultiple: null, exitAt: c.t };
      }
      if (found < 0) {
        const lastT = closed.length ? closed[closed.length - 1].t + M15 : 0;
        return now >= deadline && lastT >= deadline ? { result: 'expire', rMultiple: null, exitAt: deadline } : null;
      }
      filledAt = closed[found].t;
    }
  }
  i0 = closed.findIndex(c => c.t >= filledAt! - (filledAt! % M15));
  if (i0 < 0) i0 = closed.length; // pas encore de bougie clôturée après l'exécution

  // 2. gestion
  const hasTp2 = j.tp2 !== null && j.tp2 !== undefined;
  let sl = j.sl;
  let remaining = 1;
  let pnl = 0;
  let tp1At: number | null = null;
  const hit = (c: Candle, tp: number) => (long ? c.h >= tp : c.l <= tp - spread);
  for (let i = i0; i < closed.length; i++) {
    const c = closed[i];
    if (c.t - filledAt > MAX_HOLD) {
      pnl += remaining * (long ? c.o - entry : entry - c.o - spread);
      const r = toR(pnl);
      return { result: r > 0 ? 'gagne' : r < 0 ? 'perdu' : 'breakeven', rMultiple: r, filledAt, tp1At, exitAt: c.t };
    }
    const slHit = long ? c.l <= sl : c.h >= sl - spread;
    if (slHit) {
      pnl += remaining * (long ? sl - entry : entry - sl);
      const r = toR(pnl);
      return { result: tp1At ? 'gagne' : Math.abs(sl - entry) < 1e-12 ? 'breakeven' : 'perdu', rMultiple: r, filledAt, tp1At, exitAt: c.t };
    }
    if (!tp1At && hit(c, j.tp1)) {
      const part = hasTp2 ? 0.5 : 1;
      pnl += part * Math.abs(j.tp1 - entry);
      remaining -= part;
      tp1At = c.t;
      if (!hasTp2) return { result: 'gagne', rMultiple: toR(pnl), filledAt, tp1At, exitAt: c.t };
      sl = entry; // stop au point d'entrée
      continue;
    }
    if (tp1At && hasTp2 && hit(c, j.tp2!)) {
      pnl += remaining * Math.abs(j.tp2! - entry);
      return { result: 'gagne', rMultiple: toR(pnl), filledAt, tp1At, exitAt: c.t };
    }
  }
  const patch: Partial<JournalEntry> = {};
  if (j.result !== 'en_cours') patch.result = 'en_cours';
  if (j.filledAt !== filledAt) patch.filledAt = filledAt;
  if ((j.tp1At ?? null) !== tp1At) patch.tp1At = tp1At;
  return Object.keys(patch).length ? patch : null;
}

/** Met à jour tous les trades suivis à partir des vraies bougies M15. Renvoie le journal modifié, ou null si rien n'a changé. */
export async function trackJournal(journal: JournalEntry[]): Promise<JournalEntry[] | null> {
  const open = journal.filter(isTracked);
  if (!open.length) return null;
  const pairs = [...new Set(open.map(j => j.pair))];
  const now = Date.now();
  const byPair: Record<string, Candle[]> = {};
  await Promise.all(
    pairs.map(async p => {
      const since = Math.min(...open.filter(j => j.pair === p).map(j => j.createdAt));
      try {
        const r = await api(`/api/candles?pair=${encodeURIComponent(p)}&tf=M15&since=${since}`);
        if (r.ok) byPair[p] = (await r.json()).candles || [];
      } catch {
        /* on réessaiera au prochain tour */
      }
    })
  );
  let changed = false;
  const next = journal.map(j => {
    if (!isTracked(j) || !byPair[j.pair]) return j;
    const patch = evaluate(j, byPair[j.pair], now);
    if (!patch) return j;
    changed = true;
    return { ...j, ...patch };
  });
  return changed ? next : null;
}

/** Statistiques de la stratégie sur les trades suivis et clôturés. */
export interface StrategyStats {
  closed: number;
  wins: number;
  winRate: number | null;
  totalR: number;
  avgR: number | null;
  /** probabilité (0-100) que la stratégie soit rentable sur la durée ; null sous 30 trades */
  viability: number | null;
  minTrades: number;
}

export const MIN_TRADES = 30;

function normCdf(x: number) {
  // Abramowitz & Stegun 26.2.17
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export function strategyStats(journal: JournalEntry[], filter?: (j: JournalEntry) => boolean): StrategyStats {
  const rs = journal
    .filter(j => j.auto !== undefined && j.rMultiple !== null && ['gagne', 'perdu', 'breakeven'].includes(j.result))
    .filter(j => !filter || filter(j))
    .map(j => j.rMultiple as number);
  const n = rs.length;
  const totalR = rs.reduce((s, r) => s + r, 0);
  const avgR = n ? totalR / n : null;
  let viability: number | null = null;
  if (n >= MIN_TRADES && avgR !== null) {
    const sd = Math.sqrt(rs.reduce((s, r) => s + (r - avgR) ** 2, 0) / (n - 1));
    viability = sd > 0 ? Math.round(normCdf(avgR / (sd / Math.sqrt(n))) * 100) : avgR > 0 ? 100 : 0;
  }
  const wins = rs.filter(r => r > 0).length;
  return { closed: n, wins, winRate: n ? Math.round((wins / n) * 100) : null, totalR: Number(totalR.toFixed(2)), avgR: avgR === null ? null : Number(avgR.toFixed(2)), viability, minTrades: MIN_TRADES };
}
