// Moteur d'analyse technique SMC/ICT calculé à partir des vraies bougies.
// Tout ce qui sort d'ici est déterministe et vérifiable : mêmes bougies => même résultat.

import { TF_MS, type Candle, type Timeframe } from './marketData';
import { HOUR, marketClosed, maDateTime, maTime, nyParts, nyToUtc, tradingDayStart, tradingWeekStart } from './time';
import { findBreakers, findInversionFVGs, findTrendlines, isDisplacement, oteZone, zoneFromDisplacement, type OteZone, type TrendlineLiquidity } from './ictConcepts';
import { findCandlePatterns, type CandlePattern } from './candlePatterns';

// ---------------- Version des règles ----------------
// Toute modification de la logique de décision change la version (affichée dans l'app, le journal et le backtest).
export const RULES_VERSION = '3.12';
// 3.4 : displacement, OTE, liquidité de trendline, breaker blocks, bougies japonaises (ebook) dans la décision ; 3 confluences sur 8
export const MIN_CONFLUENCES = 3; // (règles ≤ 3.6, conservé pour le laboratoire du backtest)
/** R:R net minimal (spread et commission compris) pour qu'un plan soit exploitable. */
export const MIN_RR = 2.5;
/**
 * Mode entraînement (compte démo uniquement) : signaux « TEST » pour pratiquer l'app tous les jours.
 * Gardé : biais D1/H4, balayage → displacement → CHoCH M15, FVG/OB né de l'impulsion, annonces, rollover, choc contre le plan.
 * Assoupli : contexte HTF, premium/discount, kill zone (facultatifs) et R:R net minimal 1:2 au lieu de 1:2,5.
 * Ces signaux ne sont PAS le protocole : leurs résultats sont suivis à part (journal et backtest).
 */
export const TRAINING_MIN_RR = 2;
/**
 * 3.12 : conditions qu'un signal TEST peut manquer (ventilation du backtest du 11–12/11/2026 : sans kill zone ou sans
 * contexte HTF, l'avantage disparaît ; sans premium/discount ou avec un R:R entre 2 et 2,5, il reste positif en M5).
 */
export const TRAINING_ALLOWED_MISSING = ['pd', 'rr'];
/** 3.12 : actifs où le premium/discount de l'impulsion n'est plus obligatoire (critère passé sur les deux moitiés). */
export const PD_OPTIONAL_PAIRS = new Set(['XAU/USD']);
/** Un setup presque complet devient un signal TEST si ce qui manque est uniquement autorisé (3.12). */
export const trainingEligible = (missingKeys: string[]) => missingKeys.length > 0 && missingKeys.every(k => TRAINING_ALLOWED_MISSING.includes(k));
/** Score minimal pour la classe A+ (en dessous : classe B, risque divisé par 2). */
export const GRADE_A = 70;

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
  kind: 'FVG' | 'OB' | 'Breaker' | 'IFVG';
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
  /** instant à partir duquel le niveau existe : seules les bougies suivantes peuvent le balayer */
  formedAt?: number;
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
  /** balayages récents détectés (mèche au-delà puis clôture revenue) */
  sweeps: SweepInfo[];
  zones: Zone[];
  setup: Setup | null;
  alternatives: Setup[];
  checklist: CheckItem[];
  score: number; // 0-100, score de qualité de la grille SMC (pas une probabilité)
  grade: 'A+' | 'B' | 'C';
  signal: 'acheter' | 'vendre' | 'attendre';
  waitCondition: string | null;
  /** signal d'entraînement (TEST, compte démo) quand le protocole complet n'est pas rempli ; null sinon */
  training: {
    setup: Setup;
    missing: string[];
    missingKeys: string[];
    /** 3.12 : exécution M5 comme le protocole — true quand le CHoCH M5 a donné l'ordre (setup = ordre M5) */
    ready?: boolean;
    stage?: string;
    message?: string;
  } | null;
  /** déclencheur M15 complet mais protocole incomplet (toutes conditions de contexte confondues) : mesure du backtest */
  nearMiss: { setup: Setup; missing: string[]; missingKeys: string[] } | null;
  nextNews: { t: number; currency: string; title: string } | null;
  /** annonces fortes du jour sans horaire confirmé */
  tentativeNews: string[];
  newsAvailable: boolean;
  amd: AmdState;
  /** déclencheur balayage → displacement → CHoCH retenu (règles ≥ 3.7), ou null */
  trigger: Trigger | null;
  /** zones H1/H4 (OB/FVG) utilisées pour le contexte HTF */
  htfZones: Zone[];
  /** concepts ICT utilisés dans la décision */
  ict: {
    ote: OteZone | null;
    displacement: boolean;
    trendlines: TrendlineLiquidity[];
    candlePatterns: CandlePattern[];
  };
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
  news?: { available: boolean; events: { t: number; currency: string; title: string; tentative?: boolean }[] };
  newsCurrencies?: string[];
  /** 3.12 : premium/discount facultatif (bonus) au lieu d'obligatoire */
  pdOptional?: boolean;
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
        formedAt: s.t + 4 * HOUR, // swing confirmé 3 bougies H1 plus tard
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
          formedAt: sw.t + (tf === 'D1' ? 3 * 24 * HOUR : 4 * 4 * HOUR), // swing confirmé
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

  // Un niveau peut avoir été pris par une mèche M15 dans une bougie H1/H4/D1 pas encore clôturée :
  // on vérifie chaque niveau sur les bougies M15 depuis sa formation (sinon il resterait « non pris » à tort).
  for (const l of levels) {
    if (l.swept || l.id.startsWith('RN') || l.formedAt === undefined) continue;
    const hit = m15.find(c => c.t >= l.formedAt! && (l.side === 'buy' ? c.h > l.price : c.l < l.price));
    if (hit) {
      l.swept = true;
      l.sweptAt = hit.t;
      l.label = l.label.replace(' non pris', ''); // « Swing low H4 non pris » marqué pris serait contradictoire
    }
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
  return { id, label, price, side, swept, sweptAt, formedAt: from };
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
    ...levels.filter(l => !l.id.startsWith('RN')).map(l => ({ side: l.side, label: l.label, price: l.price, since: l.formedAt ?? 0 })),
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
  // le premier côté balayé est la manipulation
  const highSwept = !!tHigh && (!tLow || tHigh <= tLow);
  const manipT = (highSwept ? tHigh : tLow)!;
  const otherT = highSwept ? tLow : tHigh; // l'autre côté du range pris plus tard (objectif de la distribution)
  const direction = highSwept ? 'baissière' : 'haussière';
  const dist = m15Events.find(e => e.t > manipT && e.t < now && e.dir === (highSwept ? 'bear' : 'bull'));
  // Cycle invalidé (définitivement) : une bougie clôture au-delà de l'extrême de la manipulation après le balayage
  const manipCandles = after.filter(c => c.t >= manipT && c.t < manipT + 2 * HOUR);
  const manipExtreme = highSwept ? Math.max(...manipCandles.map(c => c.h)) : Math.min(...manipCandles.map(c => c.l));
  const breach = after.find(c => c.t >= manipT + 2 * HOUR && c.t < now && (highSwept ? c.c > manipExtreme : c.c < manipExtreme));
  if (breach) {
    return {
      phase: 'Indéterminée',
      direction: null,
      detail: `${highSwept ? 'Haut' : 'Bas'} asiatique balayé à ${maTime(manipT)}, puis clôture ${highSwept ? 'au-dessus du plus haut' : 'sous le plus bas'} du balayage (${r(manipExtreme)}) à ${maTime(breach.t)} : cycle AMD invalidé.`,
      asiaHigh: r(hi),
      asiaLow: r(lo),
    };
  }
  if (otherT) {
    if (dist && dist.t <= otherT) {
      return {
        phase: 'Distribution',
        direction,
        detail: `${highSwept ? 'Haut' : 'Bas'} asiatique balayé à ${maTime(manipT)}, ${dist.kind} ${direction} à ${maTime(dist.t)}, puis ${highSwept ? 'bas' : 'haut'} asiatique atteint à ${maTime(otherT)} : distribution ${direction} avancée (objectif du range atteint).`,
        asiaHigh: r(hi),
        asiaLow: r(lo),
      };
    }
    const first = highSwept ? 'haut' : 'bas';
    return { phase: 'Indéterminée', direction: null, detail: `Les deux côtés du range asiatique ont été pris (d’abord le ${first}) sans cassure de confirmation entre les deux : pas de cycle AMD exploitable aujourd’hui.`, asiaHigh: r(hi), asiaLow: r(lo) };
  }
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

const ZONE_NAMES: Record<Zone['kind'], string> = { FVG: 'Fair Value Gap', OB: 'Order Block', Breaker: 'Breaker Block', IFVG: 'Inversion FVG' };

// ---------------- Moteur principal ----------------
/** Amplitude M15 (en ATR M15) au-delà de laquelle une bougie est un choc. */
export const SHOCK_ATR = 3;
/** Durée pendant laquelle un choc contraire bloque le trade (sauf structure M15 retournée). */
export const SHOCK_WINDOW = 2 * HOUR;

/** Dernière bougie M15 (en cours comprise) des 2 dernières heures qui forme un choc CONTRE le sens du trade. */
export function findShock(m15: Candle[], now: number, atrM15: number, long: boolean): Candle | null {
  if (!(atrM15 > 0)) return null;
  for (let i = m15.length - 1; i >= 0; i--) {
    const c = m15[i];
    if (c.t > now) continue;
    if (c.t < now - SHOCK_WINDOW) break;
    if (c.h - c.l >= SHOCK_ATR * atrM15 && (long ? c.c < c.o : c.c > c.o)) return c;
  }
  return null;
}

// ---------------- Déclencheur structurel (règles 3.7) ----------------
/** Balayage → displacement → CHoCH/MSS sur M15, dans cet ordre. */
export interface Trigger {
  dir: Dir;
  sweep: { label: string; price: number; t: number; idx: number; htf: boolean };
  /** extrême du balayage (plus haut pour une vente, plus bas pour un achat) : le stop va derrière */
  extreme: number;
  displacementT: number;
  mss: StructureEvent;
  /** jambe impulsive : de l'extrême du balayage jusqu'au bout du mouvement */
  legHigh: number;
  legLow: number;
  /** le balayage ou la cassure a eu lieu en kill zone (Londres / New York) */
  inSession: boolean;
}

/** Durée maximale entre le balayage et la cassure de structure. */
export const TRIGGER_MAX_GAP = 4 * HOUR;
/** Au-delà, le déclencheur est trop ancien pour poser un ordre. */
export const TRIGGER_MAX_AGE = 6 * HOUR;

export interface SweepCandidate {
  side: 'buy' | 'sell';
  label: string;
  price: number;
  since: number;
  htf: boolean;
}

/**
 * Cherche le déclencheur le plus récent dans le sens demandé (bear = vente, bull = achat) :
 * 1. balayage d'une liquidité (mèche au-delà, clôture revenue de l'autre côté sur la même bougie ou la suivante),
 * 2. displacement dans le sens du trade entre le balayage et la cassure,
 * 3. cassure de structure M15 (CHoCH/BOS) dans le sens du trade après le balayage.
 * Le déclencheur est annulé si une bougie clôture au-delà de l'extrême du balayage, ou si la structure M15 se retourne ensuite.
 */
export function findTrigger(m15: Candle[], events: StructureEvent[], cands: SweepCandidate[], dir: Dir, now: number): Trigger | null {
  const long = dir === 'bull';
  const side = long ? 'sell' : 'buy';
  const pool = cands.filter(c => c.side === side);
  const n = m15.length;
  const minIdx = Math.max(21, n - Math.round(TRIGGER_MAX_AGE / TF_MS.M15) - Math.round(TRIGGER_MAX_GAP / TF_MS.M15));
  for (let i = n - 2; i >= minIdx; i--) {
    const c = m15[i];
    // balayage sur cette bougie : mèche au-delà, clôture revenue (même bougie ou la suivante)
    let best: SweepCandidate | null = null;
    for (const l of pool) {
      if (c.t < l.since) continue;
      const pierced = long ? c.l < l.price : c.h > l.price;
      if (!pierced) continue;
      const back = (k: Candle | undefined) => !!k && (long ? k.c > l.price : k.c < l.price);
      if (!back(c) && !back(m15[i + 1])) continue;
      // on retient le niveau le plus significatif (HTF d'abord), puis le plus loin du prix d'avant
      if (!best || (l.htf && !best.htf) || (l.htf === best.htf && (long ? l.price < best.price : l.price > best.price))) best = l;
    }
    if (!best) continue;
    const mss = events.find(e => e.dir === dir && e.idx > i && e.t - c.t <= TRIGGER_MAX_GAP);
    if (!mss) continue;
    if (now - mss.t > TRIGGER_MAX_AGE) continue;
    let dispIdx = -1;
    for (let j = i; j <= mss.idx; j++) if (isDisplacement(m15, j, dir)) { dispIdx = j; break; }
    if (dispIdx < 0) continue;
    // le balayage commence à la première bougie qui a percé le niveau (plusieurs bougies peuvent rester au-delà)
    let p = i;
    while (p - 1 >= 0 && (long ? m15[p - 1].l < best.price : m15[p - 1].h > best.price) && m15[p - 1].t >= best.since) p--;
    const seg = m15.slice(p, mss.idx + 1);
    const extreme = long ? Math.min(...seg.map(k => k.l)) : Math.max(...seg.map(k => k.h));
    // annulé : clôture au-delà de l'extrême après la cassure, ou structure M15 retournée depuis
    const after = m15.slice(mss.idx + 1);
    if (after.some(k => (long ? k.c < extreme : k.c > extreme))) continue;
    if (events.some(e => e.idx > mss.idx && e.dir !== dir)) continue;
    const rest = m15.slice(i);
    const legHigh = long ? Math.max(...rest.map(k => k.h)) : extreme;
    const legLow = long ? extreme : Math.min(...rest.map(k => k.l));
    return {
      dir,
      sweep: { label: best.label, price: best.price, t: c.t, idx: i, htf: best.htf },
      extreme,
      displacementT: m15[dispIdx].t,
      mss,
      legHigh,
      legLow,
      inSession: sessionInfo(c.t).killzone || sessionInfo(mss.t).killzone,
    };
  }
  return null;
}

/** Rollover de fin de journée de trading (16h45–18h30 heure de New York). */
export function inRollover(t: number): boolean {
  const p = nyParts(t);
  const h = p.h + p.mi / 60;
  return h >= 16.75 && h < 18.5;
}

/** Prochain début de rollover (16h45 NY) après t. */
export function nextRollover(t: number): number {
  const p = nyParts(t);
  let r = nyToUtc(p.y, p.m, p.d, 16, 45);
  if (r <= t) r = nyToUtc(p.y, p.m, p.d + 1, 16, 45);
  return r;
}

/** Liquidité « externe » (objectif HTF clair) : veille, semaine, Asie, égaux hauts/bas, swings H4/D1. */
export const isExternalLiquidity = (id: string) => /^(PD|PW|AS|EQ|H4|D1)/.test(id);

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

  const liquidityRaw = buildLiquidity(closed.D1, h1, m15, raw.H1.swings, atrH1, price, {
    h4: closed.H4,
    h4Swings: raw.H4.swings,
    d1Swings: raw.D1.swings,
    roundStep: decimals >= 4 ? 0.005 : 50,
  });
  // balayages détectés sur les prix exacts (un arrondi ne doit jamais créer un faux balayage)
  const sweeps = findSweeps(m15, liquidityRaw, h1, raw.H1.swings).map(sw => ({ ...sw, price: r(sw.price) }));
  const liquidity = liquidityRaw.map(l => ({ ...l, price: r(l.price) }));
  // marché fermé : on décrit le cycle de la dernière séance, pas une séance qui n'existe pas
  // (−1 ms : la dernière bougie de vendredi finit pile à 17h00 NY, qui ouvrirait une journée inexistante)
  const amdRef = marketClosed(now) ? lastM15.t + TF_MS.M15 - 1 : now;
  const amd = amdPhase(m15, raw.M15.events, amdRef, decimals);
  const strictSweep = opts.strictSweep ?? true;

  // Zones H1 + M15 non invalidées, proches du prix
  const zones: Zone[] = [
    ...findFVGs(h1, 'H1', atrH1),
    ...findOrderBlocks(h1, 'H1', raw.H1.events, raw.H1.swings, atrH1),
    ...findFVGs(m15, 'M15', atrM15, 96),
    ...findOrderBlocks(m15, 'M15', raw.M15.events, raw.M15.swings, atrM15),
    ...findBreakers(h1, 'H1', raw.H1.events, raw.H1.swings, atrH1),
    ...findBreakers(m15, 'M15', raw.M15.events, raw.M15.swings, atrM15),
    ...findInversionFVGs(h1, 'H1', atrH1),
    ...findInversionFVGs(m15, 'M15', atrM15, 96),
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
    // R:R calculé sur les niveaux ARRONDIS, ceux qui sont affichés et passés chez le broker
    const risk = Math.abs(r(entry) - r(sl));
    if (risk <= 0 || risk > 2.5 * atrH1) return null;
    // Objectif placé un spread AVANT la liquidité (pour être servi), R:R NET de commission.
    const tpOf = (lvl: number) => (long ? lvl - spread : lvl + spread);
    const rrNet = (lvl: number) => (Math.abs(r(tpOf(lvl)) - r(entry)) - commUnit) / (risk + commUnit);
    // Cibles = liquidité opposée non prise, au-delà d'1R net
    const targets = liquidity
      .filter(l => !l.swept && (long ? l.side === 'buy' && l.price > entry : l.side === 'sell' && l.price < entry) && rrNet(l.price) >= 1)
      .sort((a, b) => (long ? a.price - b.price : b.price - a.price));
    if (!targets.length) return null;
    const t1 = targets[0];
    const t2 = targets.find(t => rrNet(t.price) >= MIN_RR && t !== t1) || null;
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
      zoneLabel: `${ZONE_NAMES[z.kind]} ${z.dir === 'bull' ? 'haussier' : 'baissier'} ${z.tf} (${r(z.bottom)} – ${r(z.top)})`,
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

  // ----- Déclencheur structurel (3.7) : balayage → displacement → CHoCH, puis FVG/OB né de l'impulsion -----
  const sweepCands: SweepCandidate[] = [
    ...liquidityRaw.filter(l => !l.id.startsWith('RN')).map(l => ({ side: l.side, label: l.label, price: l.price, since: l.formedAt ?? 0, htf: true })),
    ...raw.H1.swings
      .filter((sw: Swing) => sw.idx >= h1.length - 120)
      .map((sw: Swing) => ({ side: (sw.type === 'high' ? 'buy' : 'sell') as 'buy' | 'sell', label: `Swing ${sw.type === 'high' ? 'high' : 'low'} H1`, price: sw.price, since: sw.t + 4 * HOUR, htf: true })),
    ...raw.M15.swings
      .filter((sw: Swing) => sw.idx >= m15.length - 96)
      .map((sw: Swing) => ({ side: (sw.type === 'high' ? 'buy' : 'sell') as 'buy' | 'sell', label: `Swing ${sw.type === 'high' ? 'high' : 'low'} M15`, price: sw.price, since: sw.t + 4 * TF_MS.M15, htf: false })),
  ];
  const trigger = wantDir ? findTrigger(m15, raw.M15.events, sweepCands, wantDir === 'acheter' ? 'bull' : 'bear', now) : null;
  // zones HTF (H1/H4) pour l'alignement de la zone d'entrée
  const atrH4 = timeframes.H4.atr14;
  const htfZones: Zone[] = [
    ...zones.filter(z => z.tf === 'H1' && (z.kind === 'FVG' || z.kind === 'OB')),
    ...findFVGs(closed.H4, 'H4', atrH4, 60),
    ...findOrderBlocks(closed.H4, 'H4', raw.H4.events, raw.H4.swings, atrH4),
  ];
  let trigZone: Zone | null = null;
  let trigPremium = false;
  let trigSetup: Setup | null = null;
  /** pourquoi le déclencheur ne donne pas de plan (affiché dans la checklist) */
  let trigWhy: string | null = null;
  if (trigger) {
    const long = trigger.dir === 'bull';
    const mid = (trigger.legHigh + trigger.legLow) / 2;
    const inHalf = (z: Zone) => (long ? (z.top + z.bottom) / 2 <= mid : (z.top + z.bottom) / 2 >= mid);
    // FVG né de l'impulsion (bougie du milieu entre le balayage et la bougie après la cassure)
    const fvgs = findFVGs(m15, 'M15', atrM15, 96).filter(
      z => z.dir === trigger.dir && z.t >= trigger.sweep.t && z.t <= trigger.mss.t + TF_MS.M15
    );
    // OB : dernière bougie opposée entre le balayage et le premier displacement
    let ob: Zone | null = null;
    const iDisp = m15.findIndex(k => k.t === trigger.displacementT);
    for (let j = iDisp; j >= Math.max(0, trigger.sweep.idx - 1); j--) {
      const k = m15[j];
      if (long ? k.c < k.o : k.c > k.o) {
        const z: Zone = { id: `M15-OB-${k.t}`, tf: 'M15', kind: 'OB', dir: trigger.dir, top: k.h, bottom: k.l, t: k.t, touched: false };
        // invalidé par une clôture au-delà (dès la bougie suivante) ; testé si le prix y est revenu après la cassure
        if (!m15.slice(j + 1).some(x => (long ? x.c < z.bottom : x.c > z.top))) {
          z.touched = m15.slice(trigger.mss.idx + 1).some(x => (long ? x.l <= z.top : x.h >= z.bottom));
          ob = z;
        }
        break;
      }
    }
    const pool = [...fvgs, ...(ob ? [ob] : [])].filter(z => (long ? price >= z.bottom : price <= z.top));
    // priorité : zone dans la bonne moitié de l'impulsion, la plus proche du prix
    const dist = (z: Zone) => Math.abs((long ? z.top : z.bottom) - price);
    const sorted = [...pool].sort((a, b) => Number(inHalf(b)) - Number(inHalf(a)) || dist(a) - dist(b));
    trigZone = sorted[0] ? { ...sorted[0], top: r(sorted[0].top), bottom: r(sorted[0].bottom) } : null;
    trigPremium = !!trigZone && inHalf(trigZone);
    if (trigZone) {
      const z = trigZone;
      const inside = price <= z.top && price >= z.bottom;
      const entry = inside ? price : long ? z.top : z.bottom;
      // stop juste derrière l'extrême du balayage
      const buffer = Math.max(0.1 * atrM15, spread);
      // (si l'OB dépasse l'extrême du balayage, le stop va derrière l'OB)
      const base = long ? Math.min(trigger.extreme, z.bottom) : Math.max(trigger.extreme, z.top);
      let sl = long ? base - buffer : base + buffer + spread;
      const minRisk = Math.max(0.3 * atrH1, 4 * spread);
      if (Math.abs(entry - sl) < minRisk) sl = long ? entry - minRisk : entry + minRisk;
      const risk = Math.abs(r(entry) - r(sl));
      if (!(risk > 0 && risk <= 2.5 * atrH1)) {
        trigWhy = `${ZONE_NAMES[z.kind]} de l’impulsion trouvé (${z.bottom} – ${z.top}), mais stop derrière le balayage trop large : ${r(risk)} > 2,5 ATR H1 (${r(2.5 * atrH1)}).`;
      } else {
        const tpOf = (lvl: number) => (long ? lvl - spread : lvl + spread);
        const rrNet = (lvl: number) => (Math.abs(r(tpOf(lvl)) - r(entry)) - commUnit) / (risk + commUnit);
        const targets = liquidity
          .filter(l => !l.swept && (long ? l.side === 'buy' && l.price > entry : l.side === 'sell' && l.price < entry) && rrNet(l.price) >= 1)
          .sort((a, b) => (long ? a.price - b.price : b.price - a.price));
        if (!targets.length) trigWhy = `${ZONE_NAMES[z.kind]} de l’impulsion trouvé (${z.bottom} – ${z.top}), mais aucune liquidité opposée non prise à au moins 1R.`;
        if (targets.length) {
          const t1 = targets[0];
          const t2 = targets.find(t => rrNet(t.price) >= MIN_RR && t !== t1) || null;
          trigSetup = {
            direction: long ? 'acheter' : 'vendre',
            entryType: inside ? 'marché' : 'limite',
            entry: r(entry),
            sl: r(sl),
            tp1: r(tpOf(t1.price)),
            tp2: t2 ? r(tpOf(t2.price)) : null,
            tp1Label: t1.label,
            tp2Label: t2?.label ?? null,
            rr1: Number(rrNet(t1.price).toFixed(2)),
            rr2: t2 ? Number(rrNet(t2.price).toFixed(2)) : null,
            zoneId: z.id,
            zoneLabel: `${ZONE_NAMES[z.kind]} ${long ? 'haussier' : 'baissier'} M15 né de l’impulsion (${z.bottom} – ${z.top})`,
          };
        }
      }
      if (!zones.some(x => x.id === z.id)) zones.push(z);
    }
  }
  // Plan proposé : celui du déclencheur ; sinon le plan « en préparation » sur la zone la plus proche (pas de signal possible)
  const setup = trigSetup || aligned.find(c => (c.rr2 ?? c.rr1) >= MIN_RR) || aligned[0] || null;
  if (setup) setup.validUntil = Math.min(now + 4 * HOUR, nextRollover(now));
  const alternatives = candidates.filter(c => c !== setup && c.zoneId !== setup?.zoneId).slice(0, 3);
  const finalTarget = trigSetup ? liquidity.find(l => l.label === (trigSetup!.tp2Label ?? trigSetup!.tp1Label) && Math.abs(l.price - (trigSetup!.tp2Label ? trigSetup!.tp2! : trigSetup!.tp1)) <= spread + 10 ** -decimals * 2) : null;
  const htfTarget = !!trigSetup && liquidity.some(l => isExternalLiquidity(l.id) && !l.swept && (trigSetup!.direction === 'acheter' ? l.side === 'buy' && l.price > trigSetup!.entry : l.side === 'sell' && l.price < trigSetup!.entry));
  const htfZoneAligned = !!trigZone && htfZones.some(z => z.dir === trigZone!.dir && z.bottom <= trigZone!.top && z.top >= trigZone!.bottom);
  const htfZoneAtExtreme = !!trigger && htfZones.some(z => z.dir === trigger.dir && trigger.extreme <= z.top + atrM15 * 0.25 && trigger.extreme >= z.bottom - atrM15 * 0.25);
  const htfContext = !!trigger && (trigger.sweep.htf || htfZoneAtExtreme || htfTarget);
  void finalTarget;

  // ----- Annonces économiques -----
  const curr = opts.newsCurrencies ?? ['USD'];
  // les annonces à horaire non confirmé ne bloquent pas une fausse heure : elles sont signalées pour la journée
  const relevant = (opts.news?.events ?? []).filter(e => curr.includes(e.currency) && !e.tentative);
  const tentativeToday = (opts.news?.events ?? []).filter(e => curr.includes(e.currency) && e.tentative && tradingDayStart(e.t) === tradingDayStart(now));
  const blocking = relevant.find(e => Math.abs(e.t - now) <= 30 * 60_000) || null;
  const nextNews = relevant.find(e => e.t >= now - 30 * 60_000) || null;
  const newsAvailable = !!opts.news?.available;
  const newsOk = newsAvailable && !blocking;
  const newsDetail = !newsAvailable
    ? 'Calendrier économique indisponible : vérifie les annonces toi-même avant d’entrer.'
    : blocking
    ? `${blocking.title} (${blocking.currency}) à ${maTime(blocking.t)} : pas d’entrée entre ${maTime(blocking.t - 30 * 60_000)} et ${maTime(blocking.t + 30 * 60_000)}.`
    : nextNews
    ? `Prochaine annonce forte : ${nextNews.title} (${nextNews.currency}), ${maDateTime(nextNews.t)}.${tentativeToday.length ? ` Aujourd’hui, horaire non confirmé : ${tentativeToday.map(e => e.title).join(', ')} (prudence).` : ''}`
    : tentativeToday.length
    ? `Horaire non confirmé aujourd’hui : ${tentativeToday.map(e => e.title).join(', ')} (prudence toute la journée).`
    : 'Aucune autre annonce forte cette semaine.';

  // ----- Concepts ICT de la zone du plan -----
  const finalRR = setup ? setup.rr2 ?? setup.rr1 : 0;
  const isLong = setup?.direction === 'acheter';
  const setupZone = setup ? zones.find(z => z.id === setup.zoneId) || null : null;
  const zc = setupZone ? (setupZone.tf === 'H1' ? h1 : m15) : null;
  const zraw = setupZone ? raw[setupZone.tf] : null;
  const displacement = !!setupZone && !!zc && zoneFromDisplacement(zc, setupZone);
  const oteRaw = setupZone && zc && zraw ? oteZone(zc, zraw.events, zraw.swings, setupZone.dir) : null;
  const ote = oteRaw ? { ...oteRaw, legLow: r(oteRaw.legLow), legHigh: r(oteRaw.legHigh), top: r(oteRaw.top), bottom: r(oteRaw.bottom) } : null;
  const inOte = !!setup && !!setupZone && !!ote && setupZone.bottom <= ote.top && setupZone.top >= ote.bottom && setup.entry <= ote.top && setup.entry >= ote.bottom;
  const trendlines = [...findTrendlines(m15, raw.M15.swings, atrM15, 'M15', 120), ...findTrendlines(h1, raw.H1.swings, atrH1, 'H1', 120)].map(t => ({ ...t, priceNow: r(t.priceNow) }));
  const tlTarget = setup
    ? trendlines.find(t => t.intact && (isLong ? t.side === 'buy' && t.priceNow > setup.entry : t.side === 'sell' && t.priceNow < setup.entry)) || null
    : null;
  const candlePatterns = [
    ...findCandlePatterns(m15, 'M15', { recent: 3, zone: setupZone }),
    ...findCandlePatterns(h1, 'H1', { recent: 2, zone: setupZone }),
  ];
  const patternForTrade = setup ? candlePatterns.find(p => p.dir === (isLong ? 'haussier' : 'baissier') && p.inZone) || null : null;

  // ----- Checklist (règles 3.7 : protocole en 4 étapes, toutes obligatoires) -----
  const sweepForTrade = setup ? sweeps.find(sw => sw.side === (isLong ? 'sell' : 'buy')) || null : null;
  const ltfOk = !!setup && timeframes.M15.trend === (isLong ? 'haussier' : 'baissier');
  const fromTrigger = !!trigSetup && setup === trigSetup;
  const dirWord = isLong ? 'haussier' : 'baissier';
  const checklist: CheckItem[] = [
    {
      key: 'bias',
      label: '1. Courant HTF : biais D1/H4 clair',
      ok: bias !== 'neutre',
      detail: biasDetail,
      core: true,
    },
    {
      key: 'htf',
      label: '1. Contexte HTF : liquidité HTF balayée, zone clé ou objectif externe',
      ok: htfContext,
      detail: !trigger
        ? 'Pas encore de déclencheur : le contexte se juge sur le balayage.'
        : trigger.sweep.htf
        ? `${trigger.sweep.label} balayé : liquidité HTF prise.`
        : htfZoneAtExtreme
        ? 'Le balayage s’est fait dans une zone H1/H4 : le prix sort d’une zone clé.'
        : htfTarget
        ? 'Objectif externe clair (veille, semaine, Asie, égaux, swing H4/D1).'
        : 'Balayage d’une simple liquidité M15, sans zone clé ni objectif externe : « au milieu de nulle part ».',
      core: true,
    },
    {
      key: 'sweep',
      label: '2. Balayage de liquidité',
      ok: !!trigger,
      detail: trigger
        ? `${trigger.sweep.label} (${r(trigger.sweep.price)}) balayé à ${maTime(trigger.sweep.t)} (heure du Maroc).`
        : sweepForTrade
        ? `${sweepForTrade.label} balayé à ${maTime(sweepForTrade.t)}, mais sans displacement ni CHoCH ${dirWord} derrière.`
        : `Aucun balayage ${isLong ? 'sous un creux' : 'au-dessus d’un sommet'} suivi d’une cassure dans les dernières heures.`,
      core: true,
    },
    {
      key: 'displacement',
      label: '2. Displacement après le balayage',
      ok: !!trigger,
      detail: trigger ? `Bougie impulsive ${dirWord} à ${maTime(trigger.displacementT)} (corps ≥ 2x la moyenne).` : 'Pas de bougie impulsive dans le sens du trade après un balayage.',
      core: true,
    },
    {
      key: 'choch',
      label: '2. CHoCH / MSS M15 net',
      ok: !!trigger,
      detail: trigger
        ? `${trigger.mss.kind} ${dirWord} à ${maTime(trigger.mss.t)} (cassure de ${r(trigger.mss.level)}).`
        : `Attendre une cassure M15 ${dirWord} après un balayage.`,
      core: true,
    },
    {
      key: 'zone',
      label: '3. FVG / OB né de l’impulsion',
      ok: fromTrigger,
      detail: fromTrigger ? setup!.zoneLabel : trigger ? trigWhy ?? 'Pas de FVG ni d’OB exploitable dans l’impulsion (ou déjà invalidé).' : setup ? `Zone en attente : ${setup.zoneLabel}.` : 'Aucune zone.',
      core: true,
    },
    {
      key: 'pd',
      label: isLong ? '3. Zone en discount de l’impulsion (< 50 %)' : '3. Zone en premium de l’impulsion (> 50 %)',
      // jugé sur la zone de l'impulsion même si elle est rejetée pour une autre raison (stop trop large…) : sinon la
      // checklist affiche « zone en premium » en rouge et le verdict la compte à tort comme manquante
      ok: !!trigger && !!trigZone && trigPremium,
      detail: trigger && trigZone
        ? `Impulsion ${r(trigger.legLow)} → ${r(trigger.legHigh)}, milieu ${r((trigger.legHigh + trigger.legLow) / 2)} : zone ${trigPremium ? (isLong ? 'en discount' : 'en premium') : (isLong ? 'au-dessus du milieu (premium)' : 'sous le milieu (discount)')}.`
        : 'Pas d’impulsion de référence.',
      core: !opts.pdOptional,
    },
    {
      key: 'rr',
      label: `Ratio risque/rendement net ≥ 1:${MIN_RR}`,
      ok: finalRR >= MIN_RR,
      detail: setup ? `R:R net (spread et commission compris) 1:${finalRR.toFixed(2)} (TP1 1:${setup.rr1.toFixed(2)})` : 'Pas de plan.',
      core: true,
    },
    {
      key: 'session',
      label: '4. Entrée pendant une session forte (kill zone Londres / New York)',
      // le timing s'applique à l'ENTRÉE ; un balayage en session forte n'est qu'une préférence (bonus ci-dessous)
      ok: session.killzone,
      detail: session.detail,
      core: true,
    },
    {
      key: 'sweepSession',
      label: 'Bonus : balayage ou cassure pendant une kill zone',
      ok: !!trigger && trigger.inSession,
      detail: trigger ? (trigger.inSession ? 'Balayage ou cassure en kill zone : mouvement de forte liquidité.' : 'Balayage et cassure hors kill zone (session asiatique ou creuse) : setup valable, mais moins fiable.') : 'Pas de déclencheur.',
      core: false,
    },
    {
      key: 'news',
      label: '4. Pas d’annonce à fort impact (±30 min)',
      ok: newsOk,
      detail: newsDetail,
      core: true,
    },
    {
      key: 'htfzone',
      label: 'Bonus : zone alignée avec un OB/FVG H1 ou H4',
      ok: htfZoneAligned,
      detail: htfZoneAligned ? 'La zone d’entrée repose sur une zone HTF du même sens.' : 'Pas de zone H1/H4 du même sens sous la zone d’entrée.',
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
      key: 'amd',
      label: 'Bonus : cycle AMD dans le sens du trade',
      ok: !!setup && amd.direction === (isLong ? 'haussière' : 'baissière') && (amd.phase === 'Manipulation' || amd.phase === 'Distribution'),
      detail: `${amd.phase} — ${amd.detail}`,
      core: false,
    },
    {
      key: 'candle',
      label: 'Bonus : bougie japonaise de retournement dans la zone',
      ok: !!patternForTrade,
      detail: patternForTrade
        ? `${patternForTrade.name} en ${patternForTrade.tf} à ${maTime(patternForTrade.t)} : ${patternForTrade.detail}`
        : 'Aucune figure de retournement (ebook) dans la zone sur les dernières bougies M15/H1.',
      core: false,
    },
    {
      key: 'trendline',
      label: 'Bonus : liquidité de trendline vers l’objectif',
      ok: !!tlTarget,
      detail: tlTarget
        ? `${tlTarget.label}, vers ${tlTarget.priceNow} : stops accumulés ${isLong ? 'au-dessus' : 'en dessous'}, carburant pour le mouvement.`
        : 'Aucune trendline de 3 touches intacte du côté de l’objectif.',
      core: false,
    },
  ];

  const coreOk = checklist.filter(c => c.core).every(c => c.ok);
  // Score de qualité : mesure de confluence, pas une probabilité. A+ ≥ 70, sinon B (risque divisé par 2).
  const ok = (k: string) => !!checklist.find(c => c.key === k)?.ok;
  const score = !setup
    ? 0
    : Math.min(
        100,
        (bias !== 'neutre' ? (d1 === h4 ? 20 : 10) : 0) +
          (trigger?.sweep.htf ? 20 : ok('htf') ? 10 : 0) +
          (ok('zone') && trigZone && !trigZone.touched ? 10 : 0) +
          (ok('htfzone') ? 15 : 0) +
          (ok('sweepSession') ? 10 : 0) +
          (finalRR >= 3.5 ? 10 : 0) +
          (ok('amd') ? 5 : 0) +
          (ok('candle') ? 5 : 0) +
          (ok('trendline') ? 5 : 0)
      );
  // Jour d'annonce forte à horaire inconnu (élections, discours…) : classe B au mieux (risque divisé par 2)
  const grade: EngineResult['grade'] = !fromTrigger ? 'C' : score >= GRADE_A && !tentativeToday.length ? 'A+' : 'B';
  let signal: EngineResult['signal'] = 'attendre';
  let waitCondition: string | null = null;
  if (coreOk && fromTrigger) {
    signal = setup!.direction;
  } else {
    const missing = checklist.filter(c => c.core && !c.ok).map(c => c.label.replace(/^\d\. /, '').toLowerCase());
    waitCondition = !wantDir
      ? 'Attendre une structure H4 claire (cassure confirmée) avant de chercher une entrée.'
      : !trigger
      ? `Attendre le déclencheur : balayage d’une liquidité ${isLong || wantDir === 'acheter' ? 'sous un creux' : 'au-dessus d’un sommet'}, puis displacement et CHoCH M15 ${wantDir === 'acheter' ? 'haussier' : 'baissier'}.`
      : `Déclencheur présent, il manque : ${missing.join(', ')}.`;
  }
  // Choc de volatilité contre le plan (annonce imprévue, gros titre…) : on ne vend pas dans une impulsion haussière,
  // on n'achète pas dans une chute, tant que la structure M15 n'a pas repris le sens du trade.
  const shock = setup ? findShock(series.M15, now, atrM15, isLong) : null;
  if (shock && !ltfOk && signal !== 'attendre') {
    signal = 'attendre';
    const move = shock.c - shock.o;
    waitCondition = `Impulsion ${move > 0 ? 'haussière' : 'baissière'} violente à ${maTime(shock.t)} (${move > 0 ? '+' : ''}${r(move)} en 15 min, plus de ${SHOCK_ATR} fois la volatilité normale) contre le plan : on attend une cassure M15 ${isLong ? 'haussière' : 'baissière'} avant d’entrer.`;
  }
  if (blocking && signal !== 'attendre') {
    signal = 'attendre';
    waitCondition = `Annonce à fort impact : ${blocking.title} à ${maTime(blocking.t)}. On attend la fin de la fenêtre de 30 minutes.`;
  }
  // Rollover (16h45–18h30 NY) : spreads très larges, pas de nouvelle entrée
  if (signal !== 'attendre' && inRollover(now)) {
    signal = 'attendre';
    waitCondition = 'Rollover de fin de journée (16h45–18h30 New York) : spreads très larges, pas de nouvelle entrée. Relance l’analyse après.';
  }
  if (marketClosed(now)) {
    signal = 'attendre';
    waitCondition = 'Marché fermé : analyse à revoir à la réouverture (dimanche 17h00 New York).';
  }

  // ----- Setup presque complet (déclencheur M15 complet, contexte incomplet) et mode entraînement (TEST) -----
  let nearMiss: EngineResult['nearMiss'] = null;
  let training: EngineResult['training'] = null;
  if (
    signal === 'attendre' &&
    trigSetup &&
    bias !== 'neutre' &&
    trigSetup.direction === wantDir &&
    newsOk &&
    !(shock && !ltfOk) &&
    !inRollover(now) &&
    !marketClosed(now) &&
    (trigSetup.rr2 ?? trigSetup.rr1) >= TRAINING_MIN_RR
  ) {
    const failed = checklist.filter(c => c.core && !c.ok && c.key !== 'rr');
    const missing = failed.map(c => c.label.replace(/^\d\. /, ''));
    const missingKeys = failed.map(c => c.key);
    if (finalRR < MIN_RR) {
      missing.push(`R:R net 1:${(trigSetup.rr2 ?? trigSetup.rr1).toFixed(2)} (< 1:${MIN_RR})`);
      missingKeys.push('rr');
    }
    // validité ancrée sur la cassure (CHoCH/BOS M15) : 4 h après, comme dans le backtest — elle ne glisse pas à chaque analyse
    const until = Math.min((trigger?.mss.t ?? now) + TF_MS.M15 + 4 * HOUR, nextRollover(now));
    if (until > now) nearMiss = { setup: { ...trigSetup, validUntil: until }, missing, missingKeys };
    // TEST 3.12 : kill zone et contexte HTF obligatoires ; seuls le premium/discount et un R:R entre 2 et 2,5 peuvent manquer
    if (nearMiss && trainingEligible(nearMiss.missingKeys)) training = nearMiss;
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
    sweeps,
    zones,
    setup,
    alternatives,
    checklist,
    score,
    grade,
    signal,
    waitCondition,
    training,
    nearMiss,
    nextNews,
    tentativeNews: tentativeToday.map(e => `${e.title} (${e.currency})`),
    newsAvailable,
    amd,
    trigger,
    htfZones: htfZones.map(z => ({ ...z, top: r(z.top), bottom: r(z.bottom) })),
    ict: { ote, displacement, trendlines, candlePatterns },
  };
}
