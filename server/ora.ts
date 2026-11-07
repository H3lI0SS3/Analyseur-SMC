// ORA Trader : préparation des bougies pour le moteur ORA corrigé (utilisé uniquement par le backtest depuis le 07/11/2026 :
// 10 trades en 2 ans sur l'or, −0,24 R par trade → retiré de l'app, conservé pour pouvoir le retester).
import { aggregateTrading, type Candle as AppCandle } from './marketData';
import type { Candle, MarketDataBundle } from './smcMasterEngine';

const M5_MS = 5 * 60_000;
const M15_MS = 15 * 60_000;
const H1_MS = 3_600_000;
/** Session asiatique pour l'AMD : 00:00–06:00 UTC du jour de la bougie active. */
export const ORA_ASIA_UTC = { from: 0, to: 6 };

export const toOra = (c: AppCandle): Candle => ({ timestamp: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: 0 });

/** Bougies de la session asiatique du jour de `t` (si la session n'a pas commencé, celle de la veille). */
export function asianSession(m15: AppCandle[], t: number): AppCandle[] {
  const day = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());
  const pick = (d: number) => m15.filter(c => c.t >= d + ORA_ASIA_UTC.from * H1_MS && c.t + M15_MS <= d + ORA_ASIA_UTC.to * H1_MS && c.t + M15_MS <= t);
  const today = pick(day);
  return today.length ? today : pick(day - 86_400_000);
}

/** Paquet ORA à l'instant `now`, uniquement avec des bougies clôturées (aucune information future). */
export function buildBundle(symbol: string, h1: AppCandle[], m15: AppCandle[], m5: AppCandle[], now: number): MarketDataBundle {
  const h1c = h1.filter(c => c.t + H1_MS <= now);
  const m15c = m15.filter(c => c.t + M15_MS <= now);
  const m5c = m5.filter(c => c.t + M5_MS <= now);
  const active = m5c[m5c.length - 1];
  return {
    symbol,
    daily: aggregateTrading(h1c, 'D1').map(toOra), // la dernière D1 = journée en cours, construite avec les H1 clôturées
    h4: aggregateTrading(h1c, 'H4').map(toOra),
    m15: m15c.map(toOra),
    m5: m5c.map(toOra),
    asianSession: active ? asianSession(m15c, active.t + M5_MS).map(toOra) : [],
  };
}
