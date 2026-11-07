// ORA Trader côté serveur : prépare le paquet de bougies (D1, H4, M15, M5 clôturées, session asiatique)
// et appelle le moteur ORA corrigé. Aucun ordre n'est passé.
import { aggregateTrading, getM5, getSeries, PAIRS, type Candle as AppCandle } from './marketData';
import { PAUSED_PAIRS } from './execution';
import { marketClosed } from './time';
import { evaluateMasterSMCTrade, type Candle, type MarketDataBundle, type MasterTradePlan } from './smcMasterEngine';

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

export interface OraResponse {
  pair: string;
  generatedAt: number;
  plan: MasterTradePlan;
  source: string;
  marketClosed: boolean;
  paused: string | null;
  /** l'or n'est évalué que sur du prix spot (pas de futures Yahoo) */
  warnings: string[];
  costs: { spread: number; commissionPerLot: number; contract: number };
  lastM5: number | null;
}

export async function runOra(pair: string, opts: { spread?: number; commissionPerLot?: number } = {}): Promise<OraResponse> {
  const info = PAIRS[pair];
  if (!info) throw Object.assign(new Error('Actif non supporté (EUR/USD ou XAU/USD).'), { status: 400 });
  const now = Date.now();
  const costs = {
    spread: Number.isFinite(opts.spread) && opts.spread! >= 0 && opts.spread! < 50 * info.pipSize ? opts.spread! : info.defaultSpread,
    commissionPerLot: Number.isFinite(opts.commissionPerLot) && opts.commissionPerLot! >= 0 && opts.commissionPerLot! <= 100 ? opts.commissionPerLot! : 7,
    contract: info.contract,
  };
  const [h1, m15] = await Promise.all([getSeries(pair, 'H1'), getSeries(pair, 'M15')]);
  if (h1.futuresProxy || m15.futuresProxy) {
    throw Object.assign(new Error('Données de secours en prix futures : ORA ne peut pas être évalué sur l’or sans prix spot.'), { status: 424 });
  }
  const m5 = await getM5(pair);
  if (!m5) throw Object.assign(new Error('Bougies M5 indisponibles (Twelve Data) : ORA a besoin du M5.'), { status: 424 });
  const plan = evaluateMasterSMCTrade(buildBundle(pair, h1.candles, m15.candles, m5, now), costs);
  const closed = marketClosed(now);
  const paused = PAUSED_PAIRS[pair] ?? null;
  const warnings: string[] = [];
  if (closed) warnings.push('Marché fermé : évaluation sur les dernières bougies, aucun trade possible.');
  if (h1.fallback || m15.fallback) warnings.push('Données de secours (Yahoo Finance) : vérifie les niveaux sur ton broker.');
  return {
    pair,
    generatedAt: now,
    plan,
    source: m15.source,
    marketClosed: closed,
    paused,
    warnings,
    costs,
    lastM5: m5.length ? m5[m5.length - 1].t : null,
  };
}
