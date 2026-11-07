// Backtest du moteur ORA corrigé : rejoué bougie M5 par bougie M5, mêmes coûts et même gestion que le moteur actuel
// (50 % à TP1, stop au point d'entrée, reste à TP2). Fenêtres calculées au fil de l'eau (aucune information future).
import { labStats, simulate, type LabStats } from './backtest';
import type { Candle } from './marketData';
import type { Setup } from './smc';
import { marketClosed, tradingDayStart } from './time';
import { evaluateMasterSMCTrade, oraKillZone, type Candle as OraCandle } from './smcMasterEngine';
import { ORA_ASIA_UTC, toOra } from './ora';

const M5 = 5 * 60_000;
const M15 = 15 * 60_000;
const H1 = 3_600_000;

export interface OraBacktest {
  trades: number;
  signals: number;
  all: LabStats;
  firstHalf: LabStats;
  secondHalf: LabStats;
  splitAt: number;
  last: { at: number; direction: 'BUY' | 'SELL'; entry: number; sl: number; tp1: number; tp2: number; r: number | null }[];
}

function firstAtOrAfter(arr: { t: number }[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function runOraBacktest(
  symbol: string,
  h1: Candle[],
  m15: Candle[],
  m5: Candle[],
  costs: { spread: number; commissionPerLot: number; contract: number },
  from: number,
  splitAt: number
): OraBacktest {
  const commUnit = costs.commissionPerLot / costs.contract;
  // journées de trading construites au fil de l'eau avec les H1 clôturées
  const days: (OraCandle & { n: number })[] = [];
  let ih1 = 0;
  const pushH1 = (c: Candle) => {
    const key = tradingDayStart(c.t);
    const cur = days[days.length - 1];
    if (!cur || cur.timestamp !== key) days.push({ timestamp: key, open: c.o, high: c.h, low: c.l, close: c.c, volume: 0, n: 1 });
    else {
      cur.high = Math.max(cur.high, c.h);
      cur.low = Math.min(cur.low, c.l);
      cur.close = c.c;
      cur.n++;
    }
  };
  let busyUntil = 0;
  let signals = 0;
  const results: { at: number; r: number | null; direction: 'BUY' | 'SELL'; entry: number; sl: number; tp1: number; tp2: number }[] = [];
  const inKz = (t: number) => oraKillZone(t).active;

  for (let i = firstAtOrAfter(m5, from); i < m5.length - 1; i++) {
    const active = m5[i];
    const now = active.t + M5;
    // hors kill zone, ORA ne peut rien approuver : on saute (même résultat, calcul plus rapide)
    if (!inKz(active.t) || marketClosed(now) || now < busyUntil) continue;
    while (ih1 < h1.length && h1[ih1].t + H1 <= now) pushH1(h1[ih1++]);
    const j15 = firstAtOrAfter(m15, now - M15 + 1); // M15 clôturées : t + 15 min <= now
    if (j15 < 30 || days.length < 6) continue;
    const dayUtc = Date.UTC(new Date(active.t).getUTCFullYear(), new Date(active.t).getUTCMonth(), new Date(active.t).getUTCDate());
    const a0 = firstAtOrAfter(m15, dayUtc + ORA_ASIA_UTC.from * H1);
    const a1 = Math.min(firstAtOrAfter(m15, dayUtc + ORA_ASIA_UTC.to * H1 - M15 + 1), j15);
    const daily = days.filter((d, k) => k === days.length - 1 || d.n >= 6).slice(-12);
    const plan = evaluateMasterSMCTrade(
      {
        symbol,
        daily,
        h4: [],
        m15: m15.slice(j15 - 30, j15).map(toOra),
        m5: m5.slice(Math.max(0, i - 24), i + 1).map(toOra),
        asianSession: m15.slice(a0, Math.max(a0, a1)).map(toOra),
      },
      costs
    );
    if (!plan.approved || !plan.direction) continue;
    signals++;
    const setup: Setup = {
      direction: plan.direction === 'BUY' ? 'acheter' : 'vendre',
      entryType: 'marché',
      entry: plan.entryPrice,
      sl: plan.stopLoss,
      tp1: plan.takeProfit1,
      tp2: plan.takeProfit2,
      tp1Label: 'TP1 (2R net)',
      tp2Label: 'Liquidité HTF',
      rr1: plan.rr1 ?? 0,
      rr2: plan.rr2,
      zoneId: 'ORA',
      zoneLabel: 'ORA',
    };
    const sim = simulate(setup, now, m5, i + 1, costs.spread, 'partiel');
    const r = sim.outcome === 'expiré' || sim.outcome === 'en cours' ? null : (sim.pnl - commUnit) / (sim.risk + commUnit);
    results.push({ at: now, r, direction: plan.direction, entry: plan.entryPrice, sl: plan.stopLoss, tp1: plan.takeProfit1, tp2: plan.takeProfit2 });
    busyUntil = sim.exitAt ?? Number.POSITIVE_INFINITY; // un seul trade à la fois
  }
  const rs = (f: (x: (typeof results)[number]) => boolean) => results.filter(x => x.r !== null && f(x)).map(x => x.r as number);
  return {
    trades: rs(() => true).length,
    signals,
    all: labStats(rs(() => true)),
    firstHalf: labStats(rs(x => x.at < splitAt)),
    secondHalf: labStats(rs(x => x.at >= splitAt)),
    splitAt,
    last: results.slice(-10).reverse(),
  };
}
