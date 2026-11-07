/**
 * ============================================================================
 * ORA TRADER - MASTER ENGINE & TRADING JOURNAL (version corrigée, 07/11/2026)
 * ============================================================================
 * Architecture : Top-Down + Premium/Discount + AMD + FVG + OTE + Journal
 * Pair Support : XAU/USD, EUR/USD
 *
 * Corrections par rapport au code d'origine (demandées par le trader le 07/11/2026) :
 *  1. FVG ou OTE OBLIGATOIRE : sans l'un des deux, le plan est REJETÉ.
 *  2. R:R strict : TP1 ≥ 1:2,0 et TP2 ≥ 1:2,5 (net du spread et de la commission), sinon plan annulé.
 *  3. Kill zones à l'heure de New York, comme le moteur principal (Londres 02–05 h, New York 07–10 h ; en hiver 07–10 h et
 *     12–15 h UTC, une heure plus tôt en UTC pendant l'heure d'été américaine) ; hors fenêtre → « EN ATTENTE - HORS KILL ZONE ».
 *  5. (07/11, après revue) FVG validé seulement si le prix de la bougie active est à l'intérieur du FVG (retour dans le FVG).
 *  4. Score de confiance dynamique : part des 6 confluences validées (HTF, M15, AMD, displacement, FVG/OTE, R:R).
 * Corrections de bugs constatés à la relecture :
 *  - le FVG comparait 'BULLISH'/'BEARISH' à 'BUY'/'SELL' : jamais égal, le FVG n'était jamais reconnu ;
 *  - la zone OTE d'une vente avait ses bornes inversées : condition impossible ;
 *  - TP2 (liquidité HTF) pouvait se trouver du mauvais côté de l'entrée : il est maintenant contrôlé ;
 *  - toutes les étapes sont évaluées (au lieu de s'arrêter à la première) pour afficher le panneau complet et le score.
 * Retiré de l’app le 07/11/2026 après le backtest sur 2 ans (or : 10 trades, −0,24 R par trade) ; conservé pour le backtest.
 */

// ============================================================================
// 1. TYPES & INTERFACES DE BASE
// ============================================================================

import { nyParts } from './time';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketDataBundle {
  symbol: string;
  daily: Candle[];
  h4: Candle[];
  m15: Candle[];
  /** bougies M5 CLÔTURÉES (la dernière est la « bougie active » évaluée) */
  m5: Candle[];
  asianSession: Candle[];
}

/** Coûts du broker, en unités de prix (spread) et en $ par lot (commission aller-retour). */
export interface OraCosts {
  spread: number;
  commissionPerLot: number;
  contract: number;
}

export type OraStatus = 'VALIDÉ' | 'REJETÉ' | 'EN ATTENTE - HORS KILL ZONE';

export type OraStepKey = 'htfBiasValid' | 'mtfDiscountPremiumValid' | 'amdCycleValid' | 'ltfDisplacementValid' | 'fvgOteValidated' | 'rrValid';

export interface OraStep {
  key: OraStepKey;
  label: string;
  ok: boolean;
  detail: string;
}

export interface MasterTradePlan {
  approved: boolean;
  status: OraStatus;
  symbol: string;
  direction: 'BUY' | 'SELL' | null;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  /** R:R net vers TP1 et TP2 (spread et commission inclus) */
  rr1: number | null;
  rr2: number | null;
  /** 0–100 : part des 6 confluences validées */
  confidenceScore: number;
  stepsValidation: Record<OraStepKey, boolean>;
  /** détail des 6 étapes, dans l'ordre d'affichage */
  steps: OraStep[];
  killZone: { name: 'Londres' | 'New York' | null; active: boolean; candleTime: number | null };
  rationale: string[];
}

export interface JournalEntry {
  id: string;
  timestamp: number;
  symbol: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  confidenceScore: number;
  rationale: string[];
  status: 'OPEN' | 'WIN_TP1' | 'WIN_TP2' | 'LOSS' | 'BREAK_EVEN';
  closePrice?: number;
  pnlPips?: number;
  notes?: string;
}

export interface JournalStats {
  totalTrades: number;
  wins: number;
  losses: number;
  breakEvens: number;
  winRate: number; // En pourcentage (ex: 78%)
  totalPips: number;
  averageProfitPips: number;
}

// ============================================================================
// 2. PARAMÈTRES
// ============================================================================

/**
 * Kill zones à l'heure de New York [début, fin[, heure d'été comprise — mêmes fenêtres que le moteur principal.
 * En hiver : Londres 07–10 h UTC, New York 12–15 h UTC ; une heure plus tôt en UTC pendant l'heure d'été américaine.
 */
export const ORA_KILL_ZONES: { name: 'Londres' | 'New York'; from: number; to: number }[] = [
  { name: 'Londres', from: 2, to: 5 },
  { name: 'New York', from: 7, to: 10 },
];
export const ORA_MIN_RR_TP1 = 2.0;
export const ORA_MIN_RR_TP2 = 2.5;
/** Nombre de confluences comptées dans le score. */
export const ORA_CONFLUENCES = 6;

export const STEP_LABELS: Record<OraStepKey, string> = {
  htfBiasValid: 'Biais HTF',
  mtfDiscountPremiumValid: 'Matrice M15',
  amdCycleValid: 'Cycle AMD',
  ltfDisplacementValid: 'Displacement M5',
  fvgOteValidated: 'Confluence FVG/OTE',
  rrValid: 'Ratio R:R',
};

// ============================================================================
// 3. SOUS-FONCTIONS ANALYTIQUES (SMC, ICT, FVG & OTE)
// ============================================================================

export function analyzeHTFBias(daily: Candle[]): { bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; keyLevel: number } {
  if (!daily || daily.length < 5) {
    return { bias: 'NEUTRAL', keyLevel: 0 };
  }

  const lastDaily = daily[daily.length - 1];
  const prevDaily = daily[daily.length - 2];

  let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (lastDaily.close > prevDaily.high) {
    bias = 'BULLISH';
  } else if (lastDaily.close < prevDaily.low) {
    bias = 'BEARISH';
  }

  const slice = daily.slice(-10);
  const keyLevel = bias === 'BULLISH' ? Math.max(...slice.map(c => c.high)) : Math.min(...slice.map(c => c.low));

  return { bias, keyLevel };
}

export function validatePremiumDiscountZone(m15: Candle[], bias: 'BULLISH' | 'BEARISH'): { isValid: boolean; equilibrium: number; reason: string } {
  if (!m15 || m15.length < 15) {
    return { isValid: false, equilibrium: 0, reason: 'Rejet M15 : Historique insuffisant.' };
  }

  const currentPrice = m15[m15.length - 1].close;
  const recentSlice = m15.slice(-30);
  const highest = Math.max(...recentSlice.map(c => c.high));
  const lowest = Math.min(...recentSlice.map(c => c.low));

  if (highest === lowest) {
    return { isValid: false, equilibrium: highest, reason: 'Rejet M15 : Amplitude nulle.' };
  }

  const equilibrium = (highest + lowest) / 2;

  if (bias === 'BULLISH' && currentPrice <= equilibrium) {
    return { isValid: true, equilibrium, reason: "Zone Discount validée (Prix sous l'Équilibre 50%)." };
  } else if (bias === 'BEARISH' && currentPrice >= equilibrium) {
    return { isValid: true, equilibrium, reason: "Zone Premium validée (Prix au-dessus de l'Équilibre 50%)." };
  }

  const currentZone = currentPrice > equilibrium ? 'Premium' : 'Discount';
  return {
    isValid: false,
    equilibrium,
    reason: `Rejet M15 : Prix en zone ${currentZone}, incompatible avec un biais ${bias}.`,
  };
}

export function detectFairValueGaps(candles: Candle[]): { top: number; bottom: number; type: 'BULLISH' | 'BEARISH' }[] {
  const fvgs: { top: number; bottom: number; type: 'BULLISH' | 'BEARISH' }[] = [];
  if (!candles || candles.length < 3) return fvgs;

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];

    if (next.low > prev.high) {
      fvgs.push({ top: next.low, bottom: prev.high, type: 'BULLISH' });
    } else if (next.high < prev.low) {
      fvgs.push({ top: prev.low, bottom: next.high, type: 'BEARISH' });
    }
  }
  return fvgs;
}

/** Zone OTE (retracement 61,8 % – 78,6 %). Correction : oteLow est toujours la borne basse, oteHigh la borne haute. */
export function calculateOTEDiscountZone(high: number, low: number, direction: 'BUY' | 'SELL'): { oteHigh: number; oteLow: number } {
  const diff = Math.abs(high - low);
  if (direction === 'BUY') {
    // achat : retracement depuis le sommet vers le bas
    return { oteHigh: high - diff * 0.618, oteLow: high - diff * 0.786 };
  }
  // vente : retracement depuis le creux vers le haut
  return { oteHigh: low + diff * 0.786, oteLow: low + diff * 0.618 };
}

export function validateAMDCycle(
  asianSession: Candle[],
  activeCandle: Candle,
  targetDirection: 'BUY' | 'SELL'
): { isValid: boolean; manipulationType: 'HIGH_SWEEP' | 'LOW_SWEEP' | 'NONE'; reason: string } {
  if (!asianSession || asianSession.length === 0 || !activeCandle) {
    return { isValid: false, manipulationType: 'NONE', reason: 'Rejet AMD : Données asiatiques absentes.' };
  }

  const asianHigh = Math.max(...asianSession.map(c => c.high));
  const asianLow = Math.min(...asianSession.map(c => c.low));

  const isManipulatingLow = activeCandle.low < asianLow;
  const isManipulatingHigh = activeCandle.high > asianHigh;

  if (targetDirection === 'BUY' && isManipulatingLow && activeCandle.close > activeCandle.open) {
    return { isValid: true, manipulationType: 'LOW_SWEEP', reason: "Cycle AMD Validé : Stop Hunt sous l'Asian Low avec rejet haussier." };
  }

  if (targetDirection === 'SELL' && isManipulatingHigh && activeCandle.close < activeCandle.open) {
    return { isValid: true, manipulationType: 'HIGH_SWEEP', reason: "Cycle AMD Validé : Faux breakout au-dessus de l'Asian High avec rejet baissier." };
  }

  return { isValid: false, manipulationType: 'NONE', reason: 'Rejet AMD : Absence de balayage de liquidité asiatique (Judas Swing).' };
}

export function validateDisplacementM5(activeCandle: Candle, m5Candles: Candle[]): boolean {
  if (!activeCandle || !m5Candles || m5Candles.length < 5) return false;

  const sliceSize = Math.min(10, m5Candles.length);
  const recentSlice = m5Candles.slice(-sliceSize);
  const totalBody = recentSlice.reduce((acc, c) => acc + Math.abs(c.close - c.open), 0);
  const avgBody = totalBody / sliceSize;

  if (avgBody === 0) return false;

  const currentBody = Math.abs(activeCandle.close - activeCandle.open);
  return currentBody >= avgBody * 1.4;
}

/** Kill zone de la bougie active (heure de New York de son ouverture). */
export function oraKillZone(timestamp: number): { name: 'Londres' | 'New York' | null; active: boolean } {
  const p = nyParts(timestamp);
  const h = p.h + p.mi / 60;
  const kz = ORA_KILL_ZONES.find(z => h >= z.from && h < z.to);
  return { name: kz?.name ?? null, active: !!kz };
}

/** R:R net : (gain − commission) / (risque + commission), en unités de prix. */
export function netRR(fill: number, stop: number, target: number, commUnit: number): number {
  const risk = Math.abs(fill - stop);
  if (risk === 0) return 0;
  return (Math.abs(target - fill) - commUnit) / (risk + commUnit);
}

// ============================================================================
// 4. MOTEUR MAÎTRE GLOBAL ORA TRADER
// ============================================================================

const ZERO_COSTS: OraCosts = { spread: 0, commissionPerLot: 0, contract: 1 };

export function evaluateMasterSMCTrade(market: MarketDataBundle, costs: OraCosts = ZERO_COSTS): MasterTradePlan {
  const symbol = market.symbol || 'XAU/USD';
  const isGold = symbol.includes('XAU');
  const round = (x: number) => Math.round(x * (isGold ? 100 : 100_000)) / (isGold ? 100 : 100_000);
  const commUnit = costs.contract > 0 ? costs.commissionPerLot / costs.contract : 0;
  const steps: OraStep[] = [];
  const rationale: string[] = [];
  const push = (key: OraStepKey, ok: boolean, detail: string) => {
    steps.push({ key, label: STEP_LABELS[key], ok, detail });
    rationale.push(`${steps.length}. ${STEP_LABELS[key]} : ${detail}`);
  };

  const activeCandle = market.m5 && market.m5.length > 0 ? market.m5[market.m5.length - 1] : null;
  const kz = activeCandle ? oraKillZone(activeCandle.timestamp) : { name: null, active: false };

  // 1. Biais Macro HTF
  const { bias, keyLevel } = analyzeHTFBias(market.daily);
  const tradeDirection: 'BUY' | 'SELL' | null = bias === 'BULLISH' ? 'BUY' : bias === 'BEARISH' ? 'SELL' : null;
  push(
    'htfBiasValid',
    bias !== 'NEUTRAL',
    bias === 'NEUTRAL'
      ? 'Biais macro journalier neutre (la dernière clôture D1 ne dépasse ni le plus haut ni le plus bas de la veille).'
      : `${bias} (clôture D1 au-delà de la veille) | Cible de liquidité : ${round(keyLevel)}`
  );

  // 2. Matrice M15 Premium / Discount
  const m15Check = tradeDirection ? validatePremiumDiscountZone(market.m15, bias as 'BULLISH' | 'BEARISH') : null;
  push('mtfDiscountPremiumValid', !!m15Check?.isValid, m15Check ? m15Check.reason : 'Non évaluable sans biais HTF.');

  // 3. Cycle AMD
  const amdCheck = tradeDirection && activeCandle ? validateAMDCycle(market.asianSession, activeCandle, tradeDirection) : null;
  push(
    'amdCycleValid',
    !!amdCheck?.isValid,
    !activeCandle ? 'Bougie M5 active introuvable.' : amdCheck ? amdCheck.reason : 'Non évaluable sans biais HTF.'
  );

  // 4. Displacement M5
  const hasDisplacement = !!activeCandle && !!tradeDirection && validateDisplacementM5(activeCandle, market.m5);
  // le displacement doit aller dans le sens du trade (correction : le corps seul ne donnait pas le sens)
  const sameWay = !!activeCandle && !!tradeDirection && (tradeDirection === 'BUY' ? activeCandle.close > activeCandle.open : activeCandle.close < activeCandle.open);
  push(
    'ltfDisplacementValid',
    hasDisplacement && sameWay,
    !tradeDirection
      ? 'Non évaluable sans biais HTF.'
      : hasDisplacement && sameWay
      ? 'Impulsion institutionnelle validée (corps ≥ 1,4× la moyenne des 10 dernières M5, dans le sens du trade).'
      : hasDisplacement
      ? 'Impulsion M5 contre le sens du trade.'
      : 'Impulsion (Displacement) M5 insuffisante.'
  );

  // 5. Confluence FVG & OTE — OBLIGATOIRE (correction 1)
  const recentM5 = (market.m5 || []).slice(-20);
  let fvgOk = false;
  let fvgDetail = 'Non évaluable sans biais HTF.';
  if (tradeDirection && activeCandle && recentM5.length >= 3) {
    const wanted = tradeDirection === 'BUY' ? 'BULLISH' : 'BEARISH'; // correction : 'BUY' ≠ 'BULLISH'
    const price = activeCandle.close;
    // FVG du bon sens ET prix de la bougie active à l'intérieur (retour dans le FVG au moment de l'entrée)
    const fvgs = detectFairValueGaps(recentM5).filter(f => f.type === wanted && price >= f.bottom && price <= f.top);
    const highestM5 = Math.max(...recentM5.map(c => c.high));
    const lowestM5 = Math.min(...recentM5.map(c => c.low));
    const ote = calculateOTEDiscountZone(highestM5, lowestM5, tradeDirection);
    const isInOTE = price >= ote.oteLow && price <= ote.oteHigh; // correction : bornes dans le bon ordre
    fvgOk = fvgs.length > 0 || isInOTE;
    const last = fvgs[fvgs.length - 1];
    fvgDetail = fvgOk
      ? [
          last ? `prix (${round(price)}) dans le FVG ${wanted === 'BULLISH' ? 'haussier' : 'baissier'} M5 ${round(last.bottom)} – ${round(last.top)}` : null,
          isInOTE ? `prix dans l'OTE 0,618–0,786 (${round(ote.oteLow)} – ${round(ote.oteHigh)})` : null,
        ]
          .filter(Boolean)
          .join(' ; ') + '.'
      : `Prix (${round(price)}) ni dans un FVG ${wanted === 'BULLISH' ? 'haussier' : 'baissier'} des 20 dernières M5, ni dans l'OTE (${round(ote.oteLow)} – ${round(ote.oteHigh)}) : REJETÉ.`;
  }
  push('fvgOteValidated', fvgOk, fvgDetail);

  // 6. SL, TP et R:R strict (correction 2)
  let entryPrice = 0;
  let stopLoss = 0;
  let tp1 = 0;
  let tp2 = 0;
  let rr1: number | null = null;
  let rr2: number | null = null;
  let rrOk = false;
  let rrDetail = 'Non évaluable sans biais HTF.';
  if (tradeDirection && activeCandle && recentM5.length) {
    const long = tradeDirection === 'BUY';
    const pipOffset = isGold ? 0.3 : 0.0003;
    entryPrice = activeCandle.close; // prix affiché (bid)
    const fill = long ? entryPrice + costs.spread : entryPrice; // un achat au marché est servi à l'ask
    stopLoss = long ? Math.min(...recentM5.map(c => c.low)) - pipOffset : Math.max(...recentM5.map(c => c.high)) + pipOffset + costs.spread;
    const risk = Math.abs(fill - stopLoss);
    if (risk === 0 || (long ? stopLoss >= fill : stopLoss <= fill)) {
      rrDetail = 'Risque nul ou stop du mauvais côté : plan annulé.';
    } else {
      // TP1 placé pour obtenir exactement 1:2 NET (le TP1 « 2R » brut d'origine tombait sous 1:2 une fois les coûts payés)
      const tp1Dist = ORA_MIN_RR_TP1 * (risk + commUnit) + commUnit;
      tp1 = long ? fill + tp1Dist : fill - tp1Dist;
      tp2 = keyLevel;
      rr1 = Number(netRR(fill, stopLoss, tp1, commUnit).toFixed(2));
      const tp2Side = long ? tp2 > fill : tp2 < fill;
      rr2 = tp2Side ? Number(netRR(fill, stopLoss, tp2, commUnit).toFixed(2)) : null;
      rrOk = rr1 >= ORA_MIN_RR_TP1 - 1e-9 && rr2 !== null && rr2 >= ORA_MIN_RR_TP2;
      rrDetail = !tp2Side
        ? `TP2 (liquidité HTF ${round(tp2)}) du mauvais côté de l'entrée : plan annulé.`
        : rrOk
        ? `R:R net TP1 1:${rr1} et TP2 1:${rr2} (minimum 1:${ORA_MIN_RR_TP1} et 1:${ORA_MIN_RR_TP2}, spread et commission inclus).`
        : `R:R net TP2 1:${rr2} < 1:${ORA_MIN_RR_TP2} : plan annulé.`;
    }
  }
  push('rrValid', rrOk, rrDetail);

  // Score dynamique (correction 4) et statut (correction 3)
  const validCount = steps.filter(s => s.ok).length;
  const confidenceScore = Math.round((validCount / ORA_CONFLUENCES) * 100);
  const allOk = validCount === ORA_CONFLUENCES;
  const status: OraStatus = !kz.active ? 'EN ATTENTE - HORS KILL ZONE' : allOk ? 'VALIDÉ' : 'REJETÉ';
  if (!kz.active) rationale.push('Hors kill zone (Londres 02–05 h, New York 07–10 h, heure de New York) : aucune approbation possible.');
  else rationale.push(`Kill zone ${kz.name} active.`);

  const approved = status === 'VALIDÉ';
  return {
    approved,
    status,
    symbol,
    direction: tradeDirection,
    entryPrice: round(entryPrice),
    stopLoss: round(stopLoss),
    takeProfit1: round(tp1),
    takeProfit2: round(tp2),
    rr1,
    rr2,
    confidenceScore,
    stepsValidation: Object.fromEntries(steps.map(s => [s.key, s.ok])) as Record<OraStepKey, boolean>,
    steps,
    killZone: { ...kz, candleTime: activeCandle?.timestamp ?? null },
    rationale,
  };
}

// ============================================================================
// 5. JOURNAL DE TRADING ORA TRADER
// ============================================================================

export function createJournalEntry(plan: MasterTradePlan, now = Date.now()): JournalEntry | null {
  if (!plan.approved || !plan.direction) return null;

  return {
    id: `ora_trade_${now}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: now,
    symbol: plan.symbol,
    direction: plan.direction,
    entryPrice: plan.entryPrice,
    stopLoss: plan.stopLoss,
    takeProfit1: plan.takeProfit1,
    takeProfit2: plan.takeProfit2,
    confidenceScore: plan.confidenceScore,
    rationale: plan.rationale,
    status: 'OPEN',
  };
}

export function updateTradeStatus(entry: JournalEntry, status: 'WIN_TP1' | 'WIN_TP2' | 'LOSS' | 'BREAK_EVEN', closePrice: number, notes?: string): JournalEntry {
  const isGold = entry.symbol.includes('XAU');
  const pipMultiplier = isGold ? 10 : 10000;

  let pnlPips = 0;
  if (entry.direction === 'BUY') {
    pnlPips = (closePrice - entry.entryPrice) * pipMultiplier;
  } else {
    pnlPips = (entry.entryPrice - closePrice) * pipMultiplier;
  }

  if (status === 'BREAK_EVEN') pnlPips = 0;

  return {
    ...entry,
    status,
    closePrice,
    pnlPips: Math.round(pnlPips * 10) / 10,
    notes: notes || entry.notes,
  };
}

export function calculateJournalStats(entries: JournalEntry[]): JournalStats {
  const closed = entries.filter(e => e.status !== 'OPEN');

  if (closed.length === 0) {
    return { totalTrades: 0, wins: 0, losses: 0, breakEvens: 0, winRate: 0, totalPips: 0, averageProfitPips: 0 };
  }

  const wins = closed.filter(e => e.status === 'WIN_TP1' || e.status === 'WIN_TP2').length;
  const losses = closed.filter(e => e.status === 'LOSS').length;
  const breakEvens = closed.filter(e => e.status === 'BREAK_EVEN').length;

  const winRate = Math.round((wins / closed.length) * 100);
  const totalPips = closed.reduce((acc, e) => acc + (e.pnlPips || 0), 0);
  const averageProfitPips = Math.round((totalPips / closed.length) * 10) / 10;

  return {
    totalTrades: closed.length,
    wins,
    losses,
    breakEvens,
    winRate,
    totalPips: Math.round(totalPips * 10) / 10,
    averageProfitPips,
  };
}
