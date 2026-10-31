// Moteur d'analyse technique SMC/ICT calculé à partir des vraies bougies.
// Tout ce qui sort d'ici est déterministe et vérifiable : mêmes bougies => même résultat.

import { TF_MS, type Candle, type Timeframe } from './marketData';
import { HOUR, marketClosed, maDateTime, maTime, nyParts, nyToUtc, tradingDayStart, tradingWeekStart } from './time';

// ---------------- Types ----------------
export type Trend = 'haussier' | 'baissier' | 'neutre';
export type Dir = 'bull' | 'bear';

export interface Swing {
  idx: number;
  t: number;
  price: number;
  type: 'high' | 'low';
}

export interface StructureEvent {
  kind: 'BOS' | 'CHoCH';
  dir: Dir;
  level: number;
  t: number;
  idx: number;
}

export interface Zone {
  id: string;
  tf: Timeframe;
  kind: 'FVG' | 'OB';
  dir: Dir;
  top: number;
  bottom: number;
  t: number;
  touched: boolean; // déjà partiellement testée
}

export interface TfSummary {
  tf: Timeframe;
  trend: Trend;
  lastEvent: StructureEvent | null;
  swingHigh: number | null; // dernier swing high encore valide
  swingLow: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  atr14: number;
  lastClose: number;
  lastTime: number;
}

export interface LiquidityLevel {
  id: string;
  label: string;
  price: number;
  side: 'buy' | 'sell'; // buy-side = au-dessus (stops acheteurs/vendeurs), sell-side = en dessous
  swept: boolean;
  sweptAt?: number;
}

export interface Setup {
  direction: 'acheter' | 'vendre';
  entryType: 'marché' | 'limite';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number | null;
  tp1Label: string;
  tp2Label: string | null;
  rr1: number;
  rr2: number | null;
  zoneId: string;
  zoneLabel: string;
  /** au-delà de cette heure, le plan n'est plus valable (ordre limite à annuler) */
  validUntil?: number;
}

export interface AmdState {
  phase: 'Accumulation' | 'Manipulation' | 'Distribution' | 'Indéterminée';
  /** sens attendu pour la distribution */
  direction: 'haussière' | 'baissière' | null;
  detail: string;
  asiaHigh: number | null;
  asiaLow: number | null;
}

export interface CheckItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  core: boolean; // condition obligatoire
}

export interface EngineResult {
  price: number;
  priceTime: number;
  timeframes: Record<Timeframe, TfSummary>;
  bias: Trend;
  biasDetail: string;
  session: { name: string; killzone: boolean; detail: string };
  dealingRange: { high: number; low: number; position: number; label: 'premium' | 'discount' | 'équilibre' } | null;
  liquidity: LiquidityLevel[];
  zones: Zone[];
  setup: Setup | null;
  alternatives: Setup[];
  checklist: CheckItem[];
  score: number; // 0-100, score de confluence (pas une probabilité)
  signal: 'acheter' | 'vendre' | 'attendre';
  waitCondition: string | null;
  nextNews: { t: number; currency: string; title: string } | null;
  newsAvailable: boolean;
  amd: AmdState;
}

export interface AnalyzeOptions {
  /** règle du trader : pas de trade sans balayage de liquidité préalable (défaut : true) */
  strictSweep?: boolean;
  /** instant de l'analyse (par défaut maintenant) : permet de rejouer le passé */
  now?: number;
  /** spread en prix (ex. 0.0001 = 1 pip EUR/USD, 0.30 $ sur l'or) */
  spread?: number;
  /** commission aller-retour par lot, en $ */
  commissionPerLot?: number;
  /** taille d'un lot (100 000 EUR/USD, 100 oz or) */
  contract?: number;
  news?: { available: boolean; events: { t: number; currency: string; title: string }[] };
  newsCurrencies?: string[];
}

// ---------------- Indicateurs ----------------
export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function atr(c: Candle[], period = 14): number {
  if (c.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < c.length; i++) {
    trs.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  }
  const n = Math.min(period, trs.length);
  let a = trs.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

// ---------------- Structure ----------------
export function findSwings(c: Candle[], k = 2): Swing[] {
  const out: Swing[] = [];
  for (let i = k; i < c.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (j < i ? c[j].h >= c[i].h : c[j].h > c[i].h) isHigh = false;
      if (j < i ? c[j].l <= c[i].l : c[j].l < c[i].l) isLow = false;
    }
    if (isHigh) out.push({ idx: i, t: c[i].t, price: c[i].h, type: 'high' });
    if (isLow) out.push({ idx: i, t: c[i].t, price: c[i].l, type: 'low' });
  }
  return out;
}

interface StructureScan {
  trend: Trend;
  events: StructureEvent[];
  swingHigh: Swing | null;
  swingLow: Swing | null;
}

/** Suit la structure : une clôture au-delà du dernier swing = BOS (dans le sens) ou CHoCH (contre). */
export function scanStructure(c: Candle[], swings: Swing[], k = 2): StructureScan {
  let trend: Trend = 'neutre';
  const events: StructureEvent[] = [];
  let lastHigh: Swing | null = null;
  let lastLow: Swing | null = null;
  let si = 0;
  for (let i = 0; i < c.length; i++) {
    // un swing n'est "connu" qu'une fois confirmé (k bougies après)
    while (si < swings.length && swings[si].idx + k <= i) {
      const s = swings[si];
      if (s.type === 'high') lastHigh = s;
      else lastLow = s;
      si++;
    }
    if (lastHigh && c[i].c > lastHigh.price && i > lastHigh.idx) {
      events.push({ kind: trend === 'baissier' ? 'CHoCH' : 'BOS', dir: 'bull', level: lastHigh.price, t: c[i].t, idx: i });
      trend = 'haussier';
      lastHigh = null; // cassé
    } else if (lastLow && c[i].c < lastLow.price && i > lastLow.idx) {
      events.push({ kind: trend === 'haussier' ? 'CHoCH' : 'BOS', dir: 'bear', level: lastLow.price, t: c[i].t, idx: i });
      trend = 'baissier';
      lastLow = null;
    }
  }
  // swings encore valides (non cassés) les plus récents
  const lastClose = c[c.length - 1].c;
  const validHigh = [...swings].reverse().find(s => s.type === 'high' && s.price > lastClose && !brokenAfter(c, s)) || null;
  const validLow = [...swings].reverse().find(s => s.type === 'low' && s.price < lastClose && !brokenAfter(c, s)) || null;
  return { trend, events, swingHigh: validHigh, swingLow: validLow };
}

function brokenAfter(c: Candle[], s: Swing): boolean {
  for (let i = s.idx + 1; i < c.length; i++) {
    if (s.type === 'high' && c[i].c > s.price) return true;
    if (s.type === 'low' && c[i].c < s.price) return true;
  }
  return false;
}

// ---------------- Zones (FVG / OB) ----------------
export function findFVGs(c: Candle[], tf: Timeframe, atrVal: number, lookback = 120): Zone[] {
  const out: Zone[] = [];
  const start = Math.max(2, c.length - lookback);
  const period = TF_MS[tf];
  for (let i = start; i < c.length; i++) {
    const a = c[i - 2];
    const b = c[i];
    // un trou de cotation (week-end, pause) n'est pas un Fair Value Gap
    if (b.t - a.t > 2.5 * period) continue;
    if (b.l > a.h && b.l - a.h >= 0.15 * atrVal) {
      const z: Zone = { id: `${tf}-FVG-${c[i - 1].t}`, tf, kind: 'FVG', dir: 'bull', top: b.l, bottom: a.h, t: c[i - 1].t, touched: false };
      if (updateMitigation(c, i + 1, z)) out.push(z);
    } else if (b.h < a.l && a.l - b.h >= 0.15 * atrVal) {
      const z: Zone = { id: `${tf}-FVG-${c[i - 1].t}`, tf, kind: 'FVG', dir: 'bear', top: a.l, bottom: b.h, t: c[i - 1].t, touched: false };
      if (updateMitigation(c, i + 1, z)) out.push(z);
    }
  }
  return out;
}

/** Order block = dernière bougie opposée avant le mouvement impulsif qui a cassé la structure. */
export function findOrderBlocks(c: Candle[], tf: Timeframe, events: StructureEvent[], swings: Swing[], atrVal: number): Zone[] {
  const out: Zone[] = [];
  for (const ev of events.slice(-8)) {
    // origine du mouvement : swing opposé le plus extrême entre le swing cassé et la cassure
    const origin = [...swings]
      .filter(s => s.idx < ev.idx && s.type === (ev.dir === 'bull' ? 'low' : 'high'))
      .pop();
    if (!origin) continue;
    let k = -1;
    for (let j = ev.idx; j >= Math.max(0, origin.idx - 3); j--) {
      const bearish = c[j].c < c[j].o;
      const bullish = c[j].c > c[j].o;
      if (j <= origin.idx + 1 && ((ev.dir === 'bull' && bearish) || (ev.dir === 'bear' && bullish))) {
        k = j;
        break;
      }
    }
    if (k < 0) continue;
    const z: Zone = {
      id: `${tf}-OB-${c[k].t}`,
      tf,
      kind: 'OB',
      dir: ev.dir,
      top: c[k].h,
      bottom: c[k].l,
      t: c[k].t,
      touched: false,
    };
    if (z.top - z.bottom > 3 * atrVal) continue; // bougie trop grande : zone peu exploitable
    if (updateMitigation(c, k + 1, z, ev.idx + 1)) out.push(z);
  }
  // dédoublonnage
  return out.filter((z, i, arr) => arr.findIndex(o => o.id === z.id) === i);
}

/** Retourne false si la zone est invalidée (traversée). Marque touched si testée. */
function updateMitigation(c: Candle[], from: number, z: Zone, touchFrom = from): boolean {
  for (let j = from; j < c.length; j++) {
    if (z.dir === 'bull') {
      if (z.kind === 'FVG' ? c[j].l <= z.bottom : c[j].c < z.bottom) return false;
      if (j >= touchFrom && c[j].l <= z.top) z.touched = true;
    } else {
      if (z.kind === 'FVG' ? c[j].h >= z.top : c[j].c > z.top) return false;
      if (j >= touchFrom && c[j].h >= z.bottom) z.touched = true;
    }
  }
  return true;
}

// ---------------- Liquidité ----------------
export interface HtfInput {
  h4: Candle[];
  h4Swings: Swing[];
  d1Swings: Swing[];
  /** pas des chiffres ronds (50 $ sur l'or, 50 pips sur EUR/USD) */
  roundStep: number;
}

export function buildLiquidity(
  d1: Candle[],
  h1: Candle[],
  m15: Candle[],
  h1Swings: Swing[],
  atrH1: number,
  price: number,
  htf?: HtfInput
): LiquidityLevel[] {
  const levels: LiquidityLevel[] = [];
  const now = m15[m15.length - 1].t;
  const today = tradingDayStart(now); // jour de trading : depuis 17h00 New York

  // Veille (PDH/PDL) : jour de trading précédent
  const prevDay = [...d1].reverse().find(c => c.t < today);
  if (prevDay) {
    levels.push(mkLevel('PDH', 'Plus haut de la veille (PDH)', prevDay.h, 'buy', m15, today));
    levels.push(mkLevel('PDL', 'Plus bas de la veille (PDL)', prevDay.l, 'sell', m15, today));
  }

  // Semaine précédente (PWH/PWL), semaine démarrant le dimanche 17h00 New York
  const thisWeek = tradingWeekStart(now);
  const prevWeekStart = tradingWeekStart(thisWeek - 1);
  const pw = d1.filter(c => tradingWeekStart(c.t) === prevWeekStart);
  if (pw.length) {
    levels.push(mkLevel('PWH', 'Plus haut semaine précédente (PWH)', Math.max(...pw.map(c => c.h)), 'buy', m15, thisWeek));
    levels.push(mkLevel('PWL', 'Plus bas semaine précédente (PWL)', Math.min(...pw.map(c => c.l)), 'sell', m15, thisWeek));
  }

  // Range asiatique : 20h00 - 00h00 New York (dans le jour de trading en cours)
  const asiaStart = today + 3 * HOUR;
  const asiaEnd = today + 7 * HOUR;
  const asia = m15.filter(c => c.t >= asiaStart && c.t < asiaEnd);
  if (asia.length >= 8 && now >= asiaEnd) {
    levels.push(mkLevel('ASH', 'Haut du range asiatique', Math.max(...asia.map(c => c.h)), 'buy', m15, asiaEnd));
    levels.push(mkLevel('ASL', 'Bas du range asiatique', Math.min(...asia.map(c => c.l)), 'sell', m15, asiaEnd));
  }

  // Swings H1 récents non pris (cibles de liquidité) + égaux hauts/bas
  const recent = h1Swings.filter(s => s.idx >= h1.length - 120);
  const tol = 0.12 * atrH1;
  for (const type of ['high', 'low'] as const) {
    const list = recent.filter(s => s.type === type);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const takenAfter = h1.slice(s.idx + 1).some(c => (type === 'high' ? c.h > s.price : c.l < s.price));
      if (takenAfter) continue;
      const twin = list.find((o, j) => j !== i && Math.abs(o.price - s.price) <= tol && o.idx < s.idx);
      levels.push({
        id: `${twin ? 'EQ' : 'SW'}${type === 'high' ? 'H' : 'L'}-${s.t}`,
        label: twin
          ? type === 'high' ? 'Égaux hauts H1 (liquidité acheteuse)' : 'Égaux bas H1 (liquidité vendeuse)'
          : type === 'high' ? 'Swing high H1 non pris' : 'Swing low H1 non pris',
        price: s.price,
        side: type === 'high' ? 'buy' : 'sell',
        swept: false,
      });
    }
  }

  // Swings H4 et D1 non pris : grandes cibles de liquidité (débloquent les marchés en extension)
  if (htf) {
    const addHtf = (c: Candle[], swings: Swing[], tf: 'H4' | 'D1', lookback: number) => {
      for (const sw of swings.filter(x => x.idx >= c.length - lookback)) {
        if (c.slice(sw.idx + 1).some(k => (sw.type === 'high' ? k.h > sw.price : k.l < sw.price))) continue;
        levels.push({
          id: `${tf}${sw.type === 'high' ? 'H' : 'L'}-${sw.t}`,
          label: `Swing ${sw.type === 'high' ? 'high' : 'low'} ${tf} non pris`,
          price: sw.price,
          side: sw.type === 'high' ? 'buy' : 'sell',
          swept: false,
        });
      }
    };
    addHtf(d1, htf.d1Swings, 'D1', 120);
    addHtf(htf.h4, htf.h4Swings, 'H4', 180);
    // Chiffres ronds les plus proches (au-dessus et en dessous)
    const up = Math.ceil(price / htf.roundStep) * htf.roundStep;
    const down = Math.floor(price / htf.roundStep) * htf.roundStep;
    if (up > price) levels.push({ id: `RNH-${up}`, label: 'Chiffre rond', price: up, side: 'buy', swept: false });
    if (down < price) levels.push({ id: `RNL-${down}`, label: 'Chiffre rond', price: down, side: 'sell', swept: false });
  }

  // tri + dédoublonnage des niveaux très proches (on garde le plus significatif)
  const priority = (id: string) =>
    /^(PW|PD)/.test(id) ? 0 : /^D1/.test(id) ? 1 : /^AS/.test(id) ? 2 : /^H4/.test(id) ? 3 : /^EQ/.test(id) ? 4 : /^RN/.test(id) ? 6 : 5;
  levels.sort((a, b) => priority(a.id) - priority(b.id));
  const kept: LiquidityLevel[] = [];
  for (const l of levels) {
    if (!kept.some(k => k.side === l.side && Math.abs(k.price - l.price) <= tol * 0.5)) kept.push(l);
  }
  // On garde les niveaux non pris pertinents + ceux balayés (contexte)
  const maxDist = (l: LiquidityLevel) => (/^(D1|PW)/.test(l.id) ? 25 : 12) * atrH1;
  return kept
    .filter(l => l.swept || Math.abs(l.price - price) <= maxDist(l))
    .sort((a, b) => b.price - a.price);
}

/** Un niveau est "balayé" si une mèche l'a dépassé puis le prix a clôturé de l'autre côté. */
function mkLevel(id: string, label: string, price: number, side: 'buy' | 'sell', m15: Candle[], from: number): LiquidityLevel {
  const after = m15.filter(c => c.t >= from);
  let swept = false;
  let sweptAt: number | undefined;
  for (const c of after) {
    if (side === 'buy' && c.h > price) {
      swept = true;
      sweptAt = sweptAt ?? c.t;
    }
    if (side === 'sell' && c.l < price) {
      swept = true;
      sweptAt = sweptAt ?? c.t;
    }
  }
  return { id, label, price, side, swept, sweptAt };
}

/** Balayage récent de liquidité dans les N dernières bougies M15 : mèche au-delà + clôture revenue à l'intérieur. */
export function recentSweep(m15: Candle[], levels: LiquidityLevel[], lookback = 24): { side: 'buy' | 'sell'; level: LiquidityLevel; t: number } | null {
  const recent = m15.slice(-lookback);
  let found: { side: 'buy' | 'sell'; level: LiquidityLevel; t: number } | null = null;
  for (const l of levels) {
    for (const c of recent) {
      const isSweep = l.side === 'buy' ? c.h > l.price && c.c < l.price : c.l < l.price && c.c > l.price;
      if (isSweep && (!found || c.t > found.t)) found = { side: l.side, level: l, t: c.t };
    }
  }
  return found;
}

export interface SweepInfo {
  side: 'buy' | 'sell'; // liquidité balayée : buy = au-dessus (signal baissier), sell = en dessous (signal haussier)
  label: string;
  price: number;
  t: number;
}

/**
 * Balayages récents (8 h de M15) : mèche au-delà d'un niveau puis clôture revenue de l'autre côté.
 * Niveaux testés : liquidité externe (veille, semaine, Asie, HTF) ET tous les swings H1 récents,
 * même déjà pris (c'est justement le sweep qui les prend).
 */
export function findSweeps(m15: Candle[], levels: LiquidityLevel[], h1: Candle[], h1Swings: Swing[], lookback = 32): SweepInfo[] {
  const recent = m15.slice(-lookback);
  const cands: { side: 'buy' | 'sell'; label: string; price: number; since: number }[] = [
    // un chiffre rond est une cible, pas un réservoir de stops : il ne compte pas comme balayage
    ...levels.filter(l => !l.id.startsWith('RN')).map(l => ({ side: l.side, label: l.label, price: l.price, since: 0 })),
    ...h1Swings
      .filter(s => s.idx >= h1.length - 120)
      .map(s => ({
        side: (s.type === 'high' ? 'buy' : 'sell') as 'buy' | 'sell',
        label: `Swing ${s.type === 'high' ? 'high' : 'low'} H1`,
        price: s.price,
        since: s.t + 4 * HOUR, // le swing doit être formé (k bougies) avant le balayage
      })),
  ];
  const out: SweepInfo[] = [];
  for (const l of cands) {
    for (const c of recent) {
      if (c.t < l.since) continue;
      const isSweep = l.side === 'buy' ? c.h > l.price && c.c < l.price : c.l < l.price && c.c > l.price;
      if (isSweep) {
        out.push({ side: l.side, label: l.label, price: l.price, t: c.t });
        break;
      }
    }
  }
  return out.sort((a, b) => b.t - a.t);
}

/**
 * Cycle AMD du jour (ICT Power of 3), en heure de New York :
 * Accumulation = range asiatique 20h-00h NY ; Manipulation = balayage d'un côté de ce range ;
 * Distribution = cassure de structure M15 dans le sens opposé au balayage.
 */
export function amdPhase(m15: Candle[], m15Events: StructureEvent[], now: number, dec: number): AmdState {
  const day = tradingDayStart(now);
  const asiaStart = day + 3 * HOUR;
  const asiaEnd = day + 7 * HOUR;
  const asia = m15.filter(c => c.t >= asiaStart && c.t < asiaEnd);
  const r = (x: number) => Number(x.toFixed(dec));
  if (now < asiaEnd) {
    return { phase: 'Accumulation', direction: null, detail: `Range asiatique en formation (fin à ${maTime(asiaEnd)} heure du Maroc).`, asiaHigh: null, asiaLow: null };
  }
  if (asia.length < 8) {
    return { phase: 'Indéterminée', direction: null, detail: 'Range asiatique incomplet (données manquantes).', asiaHigh: null, asiaLow: null };
  }
  const hi = Math.max(...asia.map(c => c.h));
  const lo = Math.min(...asia.map(c => c.l));
  const after = m15.filter(c => c.t >= asiaEnd);
  const tHigh = after.find(c => c.h > hi)?.t;
  const tLow = after.find(c => c.l < lo)?.t;
  if (!tHigh && !tLow) {
    return { phase: 'Accumulation', direction: null, detail: `Range asiatique ${r(lo)} – ${r(hi)} intact : en attente de la manipulation.`, asiaHigh: r(hi), asiaLow: r(lo) };
  }
  if (tHigh && tLow) {
    const first = tHigh < tLow ? 'haut' : 'bas';
    return { phase: 'Indéterminée', direction: null, detail: `Les deux côtés du range asiatique ont été pris (d’abord le ${first}) : pas de cycle AMD exploitable aujourd’hui.`, asiaHigh: r(hi), asiaLow: r(lo) };
  }
  const highSwept = !!tHigh;
  const manipT = (tHigh ?? tLow)!;
  const direction = highSwept ? 'baissière' : 'haussière';
  const dist = m15Events.find(e => e.t > manipT && e.dir === (highSwept ? 'bear' : 'bull'));
  if (dist) {
    return {
      phase: 'Distribution',
      direction,
      detail: `${highSwept ? 'Haut' : 'Bas'} asiatique balayé à ${maTime(manipT)}, puis ${dist.kind} ${direction} à ${maTime(dist.t)} : distribution ${direction} en cours.`,
      asiaHigh: r(hi),
      asiaLow: r(lo),
    };
  }
  return {
    phase: 'Manipulation',
    direction,
    detail: `${highSwept ? 'Haut' : 'Bas'} asiatique (${r(highSwept ? hi : lo)}) balayé à ${maTime(manipT)} : on attend une cassure M15 ${direction} pour confirmer la distribution.`,
    asiaHigh: r(hi),
    asiaLow: r(lo),
  };
}

// ---------------- Session (heure de New York, affichée en heure du Maroc) ----------------
export function sessionInfo(t: number): { name: string; killzone: boolean; detail: string } {
  if (marketClosed(t)) {
    return { name: 'Marché fermé (week-end)', killzone: false, detail: 'Réouverture le dimanche à 17h00 New York.' };
  }
  const p = nyParts(t);
  const h = p.h + p.mi / 60;
  const ma = (hNy: number) => maTime(nyToUtc(p.y, p.m, p.d, hNy));
  const kzLondon = `02h-05h New York, soit ${ma(2)}-${ma(5)} au Maroc`;
  const kzNy = `07h-10h New York, soit ${ma(7)}-${ma(10)} au Maroc`;
  if (h >= 2 && h < 5) return { name: 'Kill zone de Londres', killzone: true, detail: `Kill zone de Londres (${kzLondon}).` };
  if (h >= 7 && h < 10) return { name: 'Kill zone de New York', killzone: true, detail: `Kill zone de New York (${kzNy}).` };
  if (h >= 5 && h < 7) return { name: 'Londres (avant New York)', killzone: false, detail: `Hors kill zone. Prochaine : New York (${kzNy}).` };
  if (h >= 10 && h < 17) return { name: 'New York (après la kill zone)', killzone: false, detail: 'Hors kill zone : liquidité en baisse.' };
  if (h >= 17 && h < 20) return { name: 'Ouverture du jour (faible liquidité)', killzone: false, detail: 'Spreads souvent larges à cette heure.' };
  return { name: 'Session asiatique', killzone: false, detail: `Range en formation. Prochaine : Londres (${kzLondon}).` };
}

// ---------------- Résumé par unité de temps ----------------
export function summarize(tf: Timeframe, c: Candle[]): { summary: TfSummary; swings: Swing[]; events: StructureEvent[] } {
  const k = tf === 'D1' ? 2 : 3;
  const swings = findSwings(c, k);
  const st = scanStructure(c, swings, k);
  const closes = c.map(x => x.c);
  return {
    summary: {
      tf,
      trend: st.trend,
      lastEvent: st.events[st.events.length - 1] || null,
      swingHigh: st.swingHigh?.price ?? null,
      swingLow: st.swingLow?.price ?? null,
      ema50: ema(closes, 50),
      ema200: ema(closes, 200),
      rsi14: rsi(closes, 14),
      atr14: atr(c, 14),
      lastClose: c[c.length - 1].c,
      lastTime: c[c.length - 1].t,
    },
    swings,
    events: st.events,
  };
}

// ---------------- Moteur principal ----------------
export function analyze(series: Record<Timeframe, Candle[]>, decimals: number, opts: AnalyzeOptions = {}): EngineResult {
  const r = (x: number) => Number(x.toFixed(decimals));
  const now = opts.now ?? Date.now();
  // Le prix actuel vient de la dernière bougie M15, même non clôturée...
  const lastM15 = series.M15[series.M15.length - 1];
  const price = lastM15.c;
  const priceTime = lastM15.t;
  // ...mais tous les calculs (structure, zones, indicateurs) n'utilisent que des bougies CLÔTURÉES.
  const closed = {} as Record<Timeframe, Candle[]>;
  for (const tf of ['D1', 'H4', 'H1', 'M15'] as Timeframe[]) {
    closed[tf] = series[tf].filter(c => c.t + TF_MS[tf] <= now);
    if (closed[tf].length < 30) throw new Error(`Pas assez de bougies clôturées en ${tf}.`);
  }
  const s: any = {};
  const raw: any = {};
  for (const tf of ['D1', 'H4', 'H1', 'M15'] as Timeframe[]) {
    raw[tf] = summarize(tf, closed[tf]);
    s[tf] = raw[tf].summary;
  }
  const timeframes = s as Record<Timeframe, TfSummary>;
  const m15 = closed.M15;
  const h1 = closed.H1;
  const spread = Math.max(0, opts.spread ?? 0);
  const commUnit = Math.max(0, opts.commissionPerLot ?? 0) / (opts.contract || 1);
  const atrH1 = timeframes.H1.atr14;
  const atrM15 = timeframes.M15.atr14;

  // Biais : H4 décide, D1 confirme
  const d1 = timeframes.D1.trend;
  const h4 = timeframes.H4.trend;
  let bias: Trend = 'neutre';
  let biasDetail: string;
  if (h4 !== 'neutre' && (d1 === h4 || d1 === 'neutre')) {
    bias = h4;
    biasDetail = d1 === h4 ? `D1 et H4 ${h4}s : biais ${h4} aligné.` : `H4 ${h4}, D1 sans direction claire.`;
  } else if (h4 !== 'neutre' && d1 !== h4) {
    bias = 'neutre';
    biasDetail = `Conflit : D1 ${d1}, H4 ${h4}. Pas de biais directionnel fiable.`;
  } else {
    biasDetail = 'Structure H4 sans direction claire.';
  }

  // Dealing range H1 (dernier swing high/low H1 de part et d'autre du prix)
  const hiR = raw.H1.swings.filter((x: Swing) => x.type === 'high' && x.idx >= h1.length - 60);
  const loR = raw.H1.swings.filter((x: Swing) => x.type === 'low' && x.idx >= h1.length - 60);
  let dealingRange: EngineResult['dealingRange'] = null;
  if (hiR.length && loR.length) {
    const high = Math.max(...hiR.map((x: Swing) => x.price), price);
    const low = Math.min(...loR.map((x: Swing) => x.price), price);
    if (high > low) {
      const position = (price - low) / (high - low);
      dealingRange = {
        high: r(high),
        low: r(low),
        position: Number(position.toFixed(2)),
        label: position > 0.55 ? 'premium' : position < 0.45 ? 'discount' : 'équilibre',
      };
    }
  }

  const liquidity = buildLiquidity(closed.D1, h1, m15, raw.H1.swings, atrH1, price, {
    h4: closed.H4,
    h4Swings: raw.H4.swings,
    d1Swings: raw.D1.swings,
    roundStep: decimals >= 4 ? 0.005 : 50,
  }).map(l => ({ ...l, price: r(l.price) }));
  const sweeps = findSweeps(m15, liquidity, h1, raw.H1.swings);
  // marché fermé : on décrit le cycle de la dernière séance, pas une séance qui n'existe pas
  const amdRef = marketClosed(now) ? lastM15.t + TF_MS.M15 : now;
  const amd = amdPhase(m15, raw.M15.events, amdRef, decimals);
  const strictSweep = opts.strictSweep ?? true;

  // Zones H1 + M15 non invalidées, proches du prix
  const zones: Zone[] = [
    ...findFVGs(h1, 'H1', atrH1),
    ...findOrderBlocks(h1, 'H1', raw.H1.events, raw.H1.swings, atrH1),
    ...findFVGs(m15, 'M15', atrM15, 96),
    ...findOrderBlocks(m15, 'M15', raw.M15.events, raw.M15.swings, atrM15),
  ]
    .filter(z => Math.abs((z.top + z.bottom) / 2 - price) <= 4 * atrH1)
    .map(z => ({ ...z, top: r(z.top), bottom: r(z.bottom) }));

  const session = sessionInfo(now);

  // ----- Construction des plans possibles -----
  const buildSetup = (z: Zone): Setup | null => {
    const long = z.dir === 'bull';
    const inside = price <= z.top && price >= z.bottom;
    // l'entrée doit être sur le bord proche de la zone (limite) ou au marché si le prix est déjà dedans
    if (long && price < z.bottom) return null;
    if (!long && price > z.top) return null;
    const entry = inside ? price : long ? z.top : z.bottom;
    const buffer = Math.max(0.15 * atrH1, 0.5 * atrM15);
    // SL derrière la zone et derrière le dernier swing protecteur s'il est proche
    const protect = long
      ? Math.min(z.bottom, ...(timeframes.M15.swingLow && timeframes.M15.swingLow < entry && entry - timeframes.M15.swingLow < 1.5 * atrH1 ? [timeframes.M15.swingLow] : []))
      : Math.max(z.top, ...(timeframes.M15.swingHigh && timeframes.M15.swingHigh > entry && timeframes.M15.swingHigh - entry < 1.5 * atrH1 ? [timeframes.M15.swingHigh] : []));
    // Graphique en prix bid : le stop d'une vente se déclenche sur l'ask, on lui ajoute le spread.
    let sl = long ? protect - buffer : protect + buffer + spread;
    // stop jamais plus serré que 0,3 ATR H1 ni que 4 spreads (sinon il saute sur le simple bruit)
    const minRisk = Math.max(0.3 * atrH1, 4 * spread);
    if (Math.abs(entry - sl) < minRisk) sl = long ? entry - minRisk : entry + minRisk;
    const risk = Math.abs(entry - sl);
    if (risk <= 0 || risk > 2.5 * atrH1) return null;
    // Objectif placé un spread AVANT la liquidité (pour être servi), R:R NET de commission.
    const tpOf = (lvl: number) => (long ? lvl - spread : lvl + spread);
    const rrNet = (lvl: number) => (Math.abs(tpOf(lvl) - entry) - commUnit) / (risk + commUnit);
    // Cibles = liquidité opposée non prise, au-delà d'1R net
    const targets = liquidity
      .filter(l => !l.swept && (long ? l.side === 'buy' && l.price > entry : l.side === 'sell' && l.price < entry) && rrNet(l.price) >= 1)
      .sort((a, b) => (long ? a.price - b.price : b.price - a.price));
    if (!targets.length) return null;
    const t1 = targets[0];
    const t2 = targets.find(t => rrNet(t.price) >= 2 && t !== t1) || null;
    const rr1 = rrNet(t1.price);
    const rr2 = t2 ? rrNet(t2.price) : null;
    return {
      direction: long ? 'acheter' : 'vendre',
      entryType: inside ? 'marché' : 'limite',
      entry: r(entry),
      sl: r(sl),
      tp1: r(tpOf(t1.price)),
      tp2: t2 ? r(tpOf(t2.price)) : null,
      tp1Label: t1.label,
      tp2Label: t2?.label ?? null,
      rr1: Number(rr1.toFixed(2)),
      rr2: rr2 ? Number(rr2.toFixed(2)) : null,
      zoneId: z.id,
      zoneLabel: `${z.kind === 'FVG' ? 'Fair Value Gap' : 'Order Block'} ${z.dir === 'bull' ? 'haussier' : 'baissier'} ${z.tf} (${r(z.bottom)} – ${r(z.top)})`,
    };
  };

  // Zones jamais testées d'abord, puis la plus proche du prix.
  const touchedById = new Map(zones.map(z => [z.id, z.touched]));
  const candidates = zones
    .map(buildSetup)
    .filter((x): x is Setup => !!x)
    .sort((a, b) => Number(touchedById.get(a.zoneId)) - Number(touchedById.get(b.zoneId)) || Math.abs(a.entry - price) - Math.abs(b.entry - price));

  const wantDir = bias === 'haussier' ? 'acheter' : bias === 'baissier' ? 'vendre' : null;
  const aligned = wantDir ? candidates.filter(c => c.direction === wantDir) : [];
  const setup = aligned.find(c => (c.rr2 ?? c.rr1) >= 2) || aligned[0] || null;
  if (setup) setup.validUntil = now + 4 * HOUR;
  const alternatives = candidates.filter(c => c !== setup).slice(0, 3);

  // ----- Annonces économiques -----
  const curr = opts.newsCurrencies ?? ['USD'];
  const relevant = (opts.news?.events ?? []).filter(e => curr.includes(e.currency));
  const blocking = relevant.find(e => Math.abs(e.t - now) <= 30 * 60_000) || null;
  const nextNews = relevant.find(e => e.t >= now - 30 * 60_000) || null;
  const newsAvailable = !!opts.news?.available;
  const newsOk = newsAvailable && !blocking;
  const newsDetail = !newsAvailable
    ? 'Calendrier économique indisponible : vérifie les annonces toi-même avant d’entrer.'
    : blocking
    ? `${blocking.title} (${blocking.currency}) à ${maTime(blocking.t)} : pas d’entrée entre ${maTime(blocking.t - 30 * 60_000)} et ${maTime(blocking.t + 30 * 60_000)}.`
    : nextNews
    ? `Prochaine annonce forte : ${nextNews.title} (${nextNews.currency}), ${maDateTime(nextNews.t)}.`
    : 'Aucune autre annonce forte cette semaine.';

  // ----- Checklist -----
  const finalRR = setup ? setup.rr2 ?? setup.rr1 : 0;
  const isLong = setup?.direction === 'acheter';
  // un achat demande un balayage SOUS le prix (liquidité vendeuse), une vente un balayage AU-DESSUS
  const sweepForTrade = setup ? sweeps.find(sw => sw.side === (isLong ? 'sell' : 'buy')) || null : null;
  const ltfOk = !!setup && timeframes.M15.trend === (isLong ? 'haussier' : 'baissier');
  const checklist: CheckItem[] = [
    {
      key: 'bias',
      label: 'Biais D1/H4 clair',
      ok: bias !== 'neutre',
      detail: biasDetail,
      core: true,
    },
    {
      key: 'zone',
      label: 'Zone d\'entrée (FVG/OB) dans le sens du biais',
      ok: !!setup,
      detail: setup ? setup.zoneLabel : 'Aucun FVG/OB valide dans le sens du biais près du prix.',
      core: true,
    },
    {
      key: 'rr',
      label: 'Ratio risque/rendement net ≥ 1:2',
      ok: finalRR >= 2,
      detail: setup ? `R:R net (spread et commission compris) 1:${finalRR.toFixed(2)} (TP1 1:${setup.rr1.toFixed(2)})` : 'Pas de plan.',
      core: true,
    },
    {
      key: 'sweep',
      label: 'Liquidité balayée avant l’entrée',
      ok: !!setup && !!sweepForTrade,
      detail: sweepForTrade
        ? `${sweepForTrade.label} (${r(sweepForTrade.price)}) balayé à ${maTime(sweepForTrade.t)} (heure du Maroc).`
        : sweeps.length
        ? `Dernier balayage dans l’autre sens : ${sweeps[0].label} à ${maTime(sweeps[0].t)}.`
        : 'Aucun balayage net de liquidité dans les 8 dernières heures.',
      core: strictSweep,
    },
    {
      key: 'amd',
      label: 'Cycle AMD dans le sens du trade',
      ok: !!setup && amd.direction === (isLong ? 'haussière' : 'baissière') && (amd.phase === 'Manipulation' || amd.phase === 'Distribution'),
      detail: `${amd.phase} — ${amd.detail}`,
      core: false,
    },
    {
      key: 'pd',
      label: isLong ? 'Achat en zone discount' : 'Vente en zone premium',
      ok: !!setup && !!dealingRange && (isLong ? dealingRange.position < 0.5 : dealingRange.position > 0.5),
      detail: dealingRange ? `Prix à ${Math.round(dealingRange.position * 100)} % du range H1 (${dealingRange.label}).` : 'Range H1 indéterminé.',
      core: false,
    },
    {
      key: 'ltf',
      label: 'Structure M15 dans le sens du trade',
      ok: ltfOk,
      detail: `M15 ${timeframes.M15.trend}${timeframes.M15.lastEvent ? ` (dernier ${timeframes.M15.lastEvent.kind} ${timeframes.M15.lastEvent.dir === 'bull' ? 'haussier' : 'baissier'})` : ''}.`,
      core: false,
    },
    {
      key: 'news',
      label: 'Pas d’annonce à fort impact (±30 min)',
      ok: newsOk,
      detail: newsDetail,
      core: true,
    },
    {
      key: 'session',
      label: 'Pendant une kill zone (Londres / New York)',
      ok: session.killzone,
      detail: session.detail,
      core: false,
    },
  ];

  const coreOk = checklist.filter(c => c.core).every(c => c.ok);
  const okCount = checklist.filter(c => c.ok).length;
  const score = Math.round((okCount / checklist.length) * 100);
  let signal: EngineResult['signal'] = 'attendre';
  let waitCondition: string | null = null;
  // conditions obligatoires toutes remplies + au moins 2 conditions de confluence
  const optionalOk = checklist.filter(c => !c.core && c.ok).length;
  if (coreOk && optionalOk >= 2 && setup) {
    signal = setup.direction;
    // au marché : seulement si la structure M15 confirme déjà le sens du trade
    if (setup.entryType === 'marché' && !ltfOk) {
      signal = 'attendre';
      waitCondition = `Prix déjà dans la zone : attendre une cassure M15 ${isLong ? 'haussière' : 'baissière'} (CHoCH) avant d’entrer.`;
    }
  } else {
    const missing = checklist.filter(c => !c.ok).map(c => c.label.toLowerCase());
    waitCondition = setup
      ? `Plan en préparation, il manque : ${missing.join(', ')}.`
      : bias === 'neutre'
      ? 'Attendre une structure H4 claire (cassure confirmée) avant de chercher une entrée.'
      : `Attendre un retour du prix dans une zone ${bias === 'haussier' ? 'haussière (discount)' : 'baissière (premium)'} avec de la place jusqu'à la prochaine liquidité.`;
  }
  if (blocking && signal !== 'attendre') {
    signal = 'attendre';
    waitCondition = `Annonce à fort impact : ${blocking.title} à ${maTime(blocking.t)}. On attend la fin de la fenêtre de 30 minutes.`;
  }
  if (marketClosed(now)) {
    signal = 'attendre';
    waitCondition = 'Marché fermé : analyse à revoir à la réouverture (dimanche 17h00 New York).';
  }

  return {
    price: r(price),
    priceTime,
    timeframes,
    bias,
    biasDetail,
    session,
    dealingRange,
    liquidity,
    zones,
    setup,
    alternatives,
    checklist,
    score,
    signal,
    waitCondition,
    nextNews,
    newsAvailable,
    amd,
  };
}
