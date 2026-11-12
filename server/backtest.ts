// Backtest : rejoue le moteur bougie par bougie sur l'historique réel, sans regarder le futur,
// puis simule chaque plan comme un trader discipliné (ordre limite expirant, stop, prises partielles).
// Deux variantes sont mesurées en un seul passage :
//  - « strict »  : le protocole complet (seuls ces signaux sont des trades réels) ;
//  - « souple »  : protocole + signaux du mode entraînement (TEST, compte démo), pour mesurer leur fréquence et leur résultat.

import { aggregateTrading, TF_MS, type Candle, type Timeframe } from './marketData';
import { analyze, MIN_CONFLUENCES, MIN_RR, TRAINING_MIN_RR, PD_OPTIONAL_PAIRS, RULES_FROZEN_AT, RULES_VERSION, type EngineResult, type Setup } from './smc';
import { HOUR, marketClosed, maDateTime, nyParts, nyToUtc } from './time';
import type { OraBacktest } from './oraBacktest';

export interface BacktestCosts {
  spread: number;
  commissionPerLot: number;
  contract: number;
}

export interface BtTrade {
  variant: 'strict' | 'souple';
  signalAt: number;
  filledAt: number | null;
  exitAt: number | null;
  direction: 'acheter' | 'vendre';
  entryType?: 'marché' | 'limite';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number | null;
  plannedRR: number;
  outcome: 'gagné' | 'perdu' | 'break-even' | 'expiré' | 'clôturé (durée max)' | 'en cours';
  r: number | null;
  session: string;
  amdPhase: string;
  features: SetupFeatures;
}

/** Caractéristiques d'un setup, utilisées pour retrouver les setups similaires dans l'historique. */
export interface SetupFeatures {
  direction: 'acheter' | 'vendre';
  zoneKind: 'FVG' | 'OB';
  zoneTf: string;
  session: string;
  sweep: boolean;
  amd: boolean;
  premiumDiscount: boolean;
  entryType: 'marché' | 'limite';
}

/** Extrait les caractéristiques du plan proposé par le moteur. */
export function setupFeatures(eng: EngineResult, now: number): SetupFeatures | null {
  const s = eng.setup;
  if (!s) return null;
  const [zoneTf, kind] = s.zoneId.split('-');
  const ok = (k: string) => !!eng.checklist.find(c => c.key === k)?.ok;
  return {
    direction: s.direction,
    zoneKind: kind === 'OB' ? 'OB' : 'FVG',
    zoneTf,
    session: eng.session.killzone ? eng.session.name : sessionBucket(now),
    sweep: ok('sweep'),
    amd: ok('amd'),
    premiumDiscount: ok('pd'),
    entryType: s.entryType,
  };
}

export interface VariantStats {
  signals: number;
  filled: number;
  expired: number;
  trades: number; // trades clôturés
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  totalR: number;
  avgR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number;
  longestLosingStreak: number;
  bySession: Record<string, { trades: number; totalR: number }>;
  byDirection: Record<string, { trades: number; totalR: number }>;
}

export interface BacktestResult {
  pair: string;
  from: number;
  to: number;
  stepsEvaluated: number;
  durationMs: number;
  rulesVersion: string;
  frozenFrom: number;
  assumptions: string[];
  strict: VariantStats;
  souple: VariantStats;
  /** uniquement les signaux postérieurs au gel des règles (équivalent d'un suivi en direct) */
  strictForward: VariantStats;
  soupleForward: VariantStats;
  lastTrades: BtTrade[];
  lab: LabResult;
  /** ventilation par condition manquante (mesure seule) */
  breakdown?: ReturnType<typeof runBreakdown>;
  /** gestion de sortie : actuelle contre stop remonté sur TP1 (mesure) */
  management?: ReturnType<typeof runManagement>;
  /** moteur ORA corrigé rejoué sur les mêmes bougies (si les M5 sont disponibles) */
  ora?: OraBacktest | null;
}

export const EXPIRY = 4 * HOUR; // un ordre limite non exécuté est annulé après 4 h
const MAX_HOLD = 5 * 24 * HOUR; // un trade ouvert est clôturé après 5 jours

/**
 * Gestion du trade :
 *  - 'partiel' : 50 % à TP1, stop au point d'entrée, reste à TP2 (sans TP2 : tout à TP1) ;
 *  - 'tp1'     : tout à TP1 ;
 *  - 'final'   : tout à l'objectif le plus lointain (TP2 sinon TP1), sans point mort.
 */
export type Management = 'partiel' | 'tp1' | 'final' | 'suivi50' | 'suivi75';
/**
 * Gestion de Mehdi (mesure) : toute la position vise TP2, stop initial conservé ; quand le prix a fait 50 % (suivi50)
 * ou 75 % (suivi75) du chemin TP1 → TP2, le stop est remonté sur TP1 (gain sécurisé).
 */
export const TRAIL_MODES: Record<string, number> = { suivi50: 0.5, suivi75: 0.75 };

export function simulate(setup: Setup, from: number, m15: Candle[], startIdx: number, spread: number, mode: Management = 'partiel') {
  const long = setup.direction === 'acheter';
  // au marché, un achat est servi à l'ask (prix affiché + spread)
  const entry = setup.entryType === 'marché' && long ? setup.entry + spread : setup.entry;
  let sl = setup.sl;
  const risk = Math.abs(entry - setup.sl);
  let filledAt: number | null = null;
  let filledIdx = -1;
  // 1. remplissage (graphique en bid : un achat limite est servi quand l'ask touche l'entrée)
  if (setup.entryType === 'marché') {
    filledAt = from;
    filledIdx = startIdx;
  } else {
    for (let i = startIdx; i < m15.length && m15[i].t < from + EXPIRY; i++) {
      const c = m15[i];
      const tp1Reached = long ? c.h >= setup.tp1 : c.l <= setup.tp1 - spread;
      const touched = long ? c.l <= setup.entry - spread : c.h >= setup.entry;
      if (touched) {
        filledAt = c.t;
        filledIdx = i;
        break;
      }
      if (tp1Reached) break; // l'objectif est atteint sans nous : plan annulé
    }
  }
  if (filledAt === null) return { filledAt: null, exitAt: null, pnl: 0, outcome: 'expiré' as const, risk };

  // 2bis. gestion « stop remonté sur TP1 à l'approche de TP2 » (toute la position)
  if (mode in TRAIL_MODES && setup.tp2 !== null) {
    const f = TRAIL_MODES[mode];
    const trigger = setup.tp1 + f * (setup.tp2 - setup.tp1);
    let moved = false;
    for (let i = filledIdx; i < m15.length; i++) {
      const c = m15[i];
      if (c.t - filledAt > MAX_HOLD) {
        return { filledAt, exitAt: c.t, pnl: long ? c.o - entry : entry - c.o - spread, outcome: 'clôturé (durée max)' as const, risk };
      }
      const slHit = long ? c.l <= sl : c.h >= sl - spread;
      if (slHit) {
        const exit = long ? Math.min(sl, c.o) : Math.max(sl, c.o + spread);
        const pnl = long ? exit - entry : entry - exit;
        return { filledAt, exitAt: c.t, pnl, outcome: moved ? ('gagné' as const) : ('perdu' as const), risk };
      }
      if (long ? c.h >= setup.tp2 : c.l <= setup.tp2 - spread) {
        return { filledAt, exitAt: c.t, pnl: Math.abs(setup.tp2 - entry), outcome: 'gagné' as const, risk };
      }
      // le stop n'est remonté qu'à partir de la bougie suivante (prudent)
      if (!moved && (long ? c.h >= trigger : c.l <= trigger - spread)) {
        sl = setup.tp1;
        moved = true;
      }
    }
    return { filledAt, exitAt: null, pnl: 0, outcome: 'en cours' as const, risk };
  }

  // 2. gestion : SL ; à TP1 on encaisse 50 % et le stop passe au point d'entrée ; reste à TP2
  let remaining = 1;
  let pnl = 0;
  let tp1Done = false;
  const hasTp2 = mode === 'partiel' && setup.tp2 !== null;
  const firstTarget = mode === 'final' ? setup.tp2 ?? setup.tp1 : setup.tp1;
  for (let i = filledIdx; i < m15.length; i++) {
    const c = m15[i];
    if (c.t - filledAt > MAX_HOLD) {
      pnl += remaining * (long ? c.o - entry : entry - c.o - spread);
      return { filledAt, exitAt: c.t, pnl, outcome: 'clôturé (durée max)' as const, risk };
    }
    // stop d'abord (hypothèse prudente si stop et objectif dans la même bougie)
    const slHit = long ? c.l <= sl : c.h >= sl - spread;
    if (slHit) {
      // gap au-delà du stop (réouverture, annonce) : sortie au prix d'ouverture, comme le suivi du journal
      const exit = long ? Math.min(sl, c.o) : Math.max(sl, c.o + spread);
      pnl += remaining * (long ? exit - entry : entry - exit);
      const outcome = tp1Done ? ('gagné' as const) : Math.abs(sl - entry) < 1e-12 ? ('break-even' as const) : ('perdu' as const);
      return { filledAt, exitAt: c.t, pnl, outcome, risk };
    }
    const hit = (tp: number) => (long ? c.h >= tp : c.l <= tp - spread);
    if (!tp1Done && hit(firstTarget)) {
      const part = hasTp2 ? 0.5 : 1;
      pnl += part * Math.abs(firstTarget - entry);
      remaining -= part;
      tp1Done = true;
      if (!hasTp2) return { filledAt, exitAt: c.t, pnl, outcome: 'gagné' as const, risk };
      sl = entry; // break-even
      continue;
    }
    if (tp1Done && hasTp2 && hit(setup.tp2!)) {
      pnl += remaining * Math.abs(setup.tp2! - entry);
      return { filledAt, exitAt: c.t, pnl, outcome: 'gagné' as const, risk };
    }
  }
  return { filledAt, exitAt: null, pnl, outcome: 'en cours' as const, risk };
}

/** Premier indice dont l'horodatage est >= t (recherche dichotomique). */
function firstAtOrAfter(arr: Candle[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type RefineOutcome =
  | { kind: 'entrée'; setup: Setup; from: number; idx: number; market: Setup }
  | { kind: 'annulé'; reason: 'expiré' | 'objectif atteint' | 'stop M15 touché' }
  /** les bougies s'arrêtent avant la fin de la fenêtre (analyse en direct) : on attend encore */
  | { kind: 'en attente'; inZone: boolean; extreme: number | null; chochLevel: number | null; until: number };

/**
 * Entrée affinée en M5 (règle FIGÉE avant le test) : le plan M15 reste la référence (zone, objectifs, stop maximal).
 *  1. on attend que le prix entre dans la zone M15 (FVG/OB) pendant la validité de l'ordre (4 h) ;
 *     si TP1 est atteint avant, le plan est annulé ;
 *  2. dans la zone, on suit l'extrême atteint (le « mini-balayage » M5) ; si le stop M15 est touché, le setup a échoué :
 *     pas de trade ;
 *  3. CHoCH M5 : une bougie M5 clôture au-delà du dernier swing low (vente) / swing high (achat) M5 formé avant
 *     l'extrême (à défaut, la bougie juste avant l'extrême) ;
 *  4. ordre limite au milieu de la jambe du CHoCH (extrême → clôture), valable 4 h, annulé si TP1 est atteint avant ;
 *  5. stop derrière l'extrême M5 + marge (le plus grand du spread et de 10 % du risque M15, + spread pour une vente),
 *     jamais plus serré que 25 % du risque M15 (évite les stops dans le bruit) ; objectifs inchangés.
 */
/** Niveau du CHoCH M5 : dernier creux (vente) / sommet (achat) local dans l'heure qui précède l'extrême. */
function chochLevel(m5: Candle[], extIdx: number, long: boolean): number | null {
  if (extIdx < 1) return null;
  for (let j = extIdx - 1; j >= Math.max(1, extIdx - 12); j--) {
    const a = m5[j - 1], b = m5[j], c = m5[j + 1];
    if (long ? b.h >= a.h && b.h >= c.h : b.l <= a.l && b.l <= c.l) return long ? b.h : b.l;
  }
  return long ? m5[extIdx - 1].h : m5[extIdx - 1].l;
}

export function refineM5(setup: Setup, zone: { top: number; bottom: number }, from: number, m5: Candle[], spread: number): RefineOutcome {
  const long = setup.direction === 'acheter';
  const risk15 = Math.abs(setup.entry - setup.sl);
  const buffer = Math.max(spread, 0.1 * risk15);
  const minRisk = 0.25 * risk15;
  let inZone = false;
  let ext = NaN;
  let extIdx = -1;
  let i = firstAtOrAfter(m5, from);
  for (; i < m5.length && m5[i].t < from + EXPIRY; i++) {
    const c = m5[i];
    if (!inZone) {
      if (long ? c.h >= setup.tp1 : c.l <= setup.tp1 - spread) return { kind: 'annulé', reason: 'objectif atteint' };
      const entered = long ? c.l <= zone.top : c.h >= zone.bottom;
      if (!entered) continue;
      inZone = true;
    }
    if (long ? c.l <= setup.sl : c.h >= setup.sl - spread) return { kind: 'annulé', reason: 'stop M15 touché' };
    if (extIdx < 0 || (long ? c.l < ext : c.h > ext)) {
      ext = long ? c.l : c.h;
      extIdx = i;
      continue; // la bougie qui fait l'extrême ne peut pas être celle du CHoCH
    }
    const ref = chochLevel(m5, extIdx, long);
    if (ref === null) continue;
    if (long ? c.c > ref : c.c < ref) {
      // ordre limite au milieu de la jambe CHoCH (extrême → clôture du CHoCH), comme un retour en OTE M5
      const entry = (ext + c.c) / 2;
      let sl = long ? ext - buffer : ext + buffer + spread;
      const fill = long ? entry + spread : entry;
      if (Math.abs(fill - sl) < minRisk) sl = long ? fill - minRisk : fill + minRisk;
      // mesure (labo) : même CHoCH, mais entrée AU MARCHÉ à la clôture de la bougie du CHoCH, même règle de stop
      const mFill = long ? c.c + spread : c.c;
      let mSl = long ? ext - buffer : ext + buffer + spread;
      if (Math.abs(mFill - mSl) < minRisk) mSl = long ? mFill - minRisk : mFill + minRisk;
      return {
        kind: 'entrée',
        setup: { ...setup, entryType: 'limite', entry, sl },
        from: c.t + 5 * 60_000,
        idx: i + 1,
        market: { ...setup, entryType: 'marché', entry: c.c, sl: mSl },
      };
    }
  }
  // plus de bougies alors que la fenêtre de 4 h n'est pas finie : en direct, le setup est encore en cours
  if (i >= m5.length && (!m5.length || m5[m5.length - 1].t + 5 * 60_000 < from + EXPIRY)) {
    return { kind: 'en attente', inZone, extreme: extIdx >= 0 ? ext : null, chochLevel: extIdx >= 0 ? chochLevel(m5, extIdx, long) : null, until: from + EXPIRY };
  }
  return { kind: 'annulé', reason: 'expiré' };
}

function emptyStats(): VariantStats {
  return {
    signals: 0,
    filled: 0,
    expired: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winRate: null,
    totalR: 0,
    avgR: null,
    profitFactor: null,
    maxDrawdownR: 0,
    longestLosingStreak: 0,
    bySession: {},
    byDirection: {},
  };
}

function finalize(trades: BtTrade[]): VariantStats {
  const s = emptyStats();
  s.signals = trades.length;
  s.expired = trades.filter(t => t.outcome === 'expiré').length;
  s.filled = trades.filter(t => t.filledAt !== null).length;
  const closed = trades.filter(t => t.r !== null);
  s.trades = closed.length;
  let equity = 0;
  let peak = 0;
  let streak = 0;
  let gain = 0;
  let loss = 0;
  for (const t of closed.sort((a, b) => (a.exitAt ?? 0) - (b.exitAt ?? 0))) {
    const r = t.r!;
    equity += r;
    peak = Math.max(peak, equity);
    s.maxDrawdownR = Math.max(s.maxDrawdownR, peak - equity);
    if (r > 0.05) {
      s.wins++;
      gain += r;
      streak = 0;
    } else if (r < -0.05) {
      s.losses++;
      loss -= r;
      streak++;
      s.longestLosingStreak = Math.max(s.longestLosingStreak, streak);
    } else s.breakeven++;
    const ses = (s.bySession[t.session] ||= { trades: 0, totalR: 0 });
    ses.trades++;
    ses.totalR += r;
    const dir = (s.byDirection[t.direction] ||= { trades: 0, totalR: 0 });
    dir.trades++;
    dir.totalR += r;
  }
  const round = (x: number) => Number(x.toFixed(2));
  s.totalR = round(equity);
  s.maxDrawdownR = round(s.maxDrawdownR);
  s.winRate = closed.length ? Math.round((s.wins / closed.length) * 100) : null;
  s.avgR = closed.length ? round(equity / closed.length) : null;
  s.profitFactor = loss > 0 ? round(gain / loss) : gain > 0 ? null : null;
  for (const k of Object.keys(s.bySession)) s.bySession[k].totalR = round(s.bySession[k].totalR);
  for (const k of Object.keys(s.byDirection)) s.byDirection[k].totalR = round(s.byDirection[k].totalR);
  return s;
}

/**
 * Backtest incrémental : le calcul avance par tranches (step) pour rester compatible avec un
 * hébergement qui ne donne du CPU que pendant les requêtes (Cloud Run). À chaque pas de 15 minutes,
 * seules les bougies déjà clôturées sont visibles par le moteur.
 */
export class BacktestRun {
  private h4All: Candle[];
  private d1All: Candle[];
  private commUnit: number;
  private trades: BtTrade[] = [];
  private busyUntil: Record<'strict' | 'souple', number> = { strict: 0, souple: 0 };
  private iH1 = 0;
  private iH4 = 0;
  private iD1 = 0;
  private k = 0;
  private steps = 0;
  private computeMs = 0;
  readonly startT: number;
  done = false;

  constructor(
    readonly pair: string,
    private h1: Candle[],
    private m15: Candle[],
    private decimals: number,
    private costs: BacktestCosts,
    /** bougies M5 facultatives : activent la variante « entrée affinée M5 » du labo */
    private m5: Candle[] | null = null
  ) {
    this.h4All = aggregateTrading(h1, 'H4');
    this.d1All = aggregateTrading(h1, 'D1');
    this.commUnit = costs.commissionPerLot / costs.contract;
    // départ : il faut au moins 60 jours de H1 et 500 bougies M15 d'historique
    this.startT = Math.max(h1[0].t + 60 * 24 * HOUR, m15[Math.min(500, m15.length - 1)].t);
  }

  /** Données du run (backtest ORA calculé à la fin, sur les mêmes bougies et les mêmes coûts). */
  get inputs() {
    return { h1: this.h1, m15: this.m15, m5: this.m5, costs: this.costs, startT: this.startT };
  }

  /** Avancement de 0 à 1. */
  get progress(): number {
    return this.m15.length ? this.k / this.m15.length : 1;
  }

  /** Calcule pendant au plus budgetMs millisecondes. */
  step(budgetMs: number): void {
    const until = Date.now() + budgetMs;
    const t0 = Date.now();
    const { m15, h1 } = this;
    const upto = (arr: Candle[], t: number, from: number) => {
      let i = from;
      while (i < arr.length && arr[i].t < t) i++;
      return i;
    };
    while (this.k < m15.length && Date.now() < until) {
      const k = this.k++;
      const now = m15[k].t + TF_MS.M15; // instant de clôture de la bougie k
      if (now < this.startT || marketClosed(m15[k].t)) continue;
      this.iH1 = upto(h1, now, this.iH1);
      this.iH4 = upto(this.h4All, now, this.iH4);
      this.iD1 = upto(this.d1All, now, this.iD1);
      const series: Record<Timeframe, Candle[]> = {
        M15: m15.slice(Math.max(0, k + 1 - 500), k + 1),
        H1: h1.slice(Math.max(0, this.iH1 - 800), this.iH1),
        H4: this.h4All.slice(Math.max(0, this.iH4 - 300), this.iH4),
        D1: this.d1All.slice(Math.max(0, this.iD1 - 400), this.iD1),
      };
      let eng: EngineResult;
      try {
        eng = analyze(series, this.decimals, {
          now,
          spread: this.costs.spread,
          commissionPerLot: this.costs.commissionPerLot,
          contract: this.costs.contract,
          news: { available: true, events: [] }, // calendrier historique non disponible
          strictSweep: false,
          pdOptional: PD_OPTIONAL_PAIRS.has(this.pair),
        });
      } catch {
        continue;
      }
      this.steps++;

      this.collectCandidate(eng, now, k);

      const strict = eng.signal !== 'attendre' && !!eng.setup;
      const souple = strict || !!eng.training;

      for (const variant of ['strict', 'souple'] as const) {
        const take = variant === 'strict' ? strict : souple;
        if (!take || now < this.busyUntil[variant]) continue; // un seul trade à la fois par variante
        const setup = variant === 'souple' && !strict ? eng.training!.setup : eng.setup!;
        const sim = simulate(setup, now, m15, k + 1, this.costs.spread);
        const r = sim.outcome === 'expiré' || sim.outcome === 'en cours' ? null : (sim.pnl - this.commUnit) / (sim.risk + this.commUnit);
        this.trades.push({
          variant,
          signalAt: now,
          filledAt: sim.filledAt,
          exitAt: sim.exitAt,
          direction: setup.direction,
          entryType: setup.entryType,
          entry: setup.entry,
          sl: setup.sl,
          tp1: setup.tp1,
          tp2: setup.tp2,
          plannedRR: setup.rr2 ?? setup.rr1,
          outcome: sim.outcome,
          r: r === null ? null : Number(r.toFixed(2)),
          session: eng.session.killzone ? eng.session.name : sessionBucket(now),
          amdPhase: eng.amd.phase,
          features: setupFeatures(eng, now)!,
        });
        this.busyUntil[variant] = sim.exitAt ?? (sim.filledAt === null ? now + EXPIRY : Number.MAX_SAFE_INTEGER);
      }
    }
    this.computeMs += Date.now() - t0;
    if (this.k >= m15.length) this.done = true;
  }

  private candidates: Candidate[] = [];

  /**
   * Exécution M5 rejouée comme en direct (execution.ts) : surveillance à partir de la clôture de la bougie M15 du
   * CHoCH et pas avant le début de la kill zone ; un ordre déjà servi ou au R:R insuffisant avant « maintenant » = pas
   * de trade ; l'ordre n'est servi qu'à partir de « maintenant » (le moment où l'app le donne).
   */
  private refineLikeLive(s: Setup, zone: { top: number; bottom: number }, now: number, eng: EngineResult, missing: string[]) {
    if (!this.m5 || !this.m5.length || !eng.trigger) return null;
    const p = nyParts(now);
    const h0 = p.h >= 2 && p.h < 5 ? 2 : p.h >= 7 && p.h < 10 ? 7 : null;
    const kz = h0 === null ? 0 : nyToUtc(p.y, p.m, p.d, h0);
    const from = Math.max(eng.trigger.mss.t + 15 * 60_000, kz);
    // seules les bougies M5 clôturées à « maintenant » sont connues pour décider
    const known = this.m5.slice(0, firstAtOrAfter(this.m5, now - 5 * 60_000 + 1));
    let ref = refineM5(s, zone, from, known, this.costs.spread);
    if (ref.kind === 'en attente') ref = refineM5(s, zone, from, this.m5, this.costs.spread); // la suite se joue après « maintenant »
    if (ref.kind !== 'entrée') return null;
    const long = s.direction === 'acheter';
    // déjà servi entre le CHoCH M5 et maintenant : « manqué » en direct
    for (let i = ref.idx; i < this.m5.length && this.m5[i].t < now; i++) {
      const c = this.m5[i];
      if (long ? c.l <= ref.setup.entry - this.costs.spread : c.h >= ref.setup.entry) return null;
      if (long ? c.h >= s.tp1 : c.l <= s.tp1 - this.costs.spread) return null;
    }
    // R:R net de l'ordre M5, comme en direct (TEST : R:R ≥ 2 accepté)
    const risk = Math.abs(ref.setup.entry - ref.setup.sl);
    const rr = (tp: number) => (Math.abs(tp - ref.setup.entry) - this.commUnit) / (risk + this.commUnit);
    const best = s.tp2 !== null ? rr(s.tp2) : rr(s.tp1);
    if (best < (missing.includes('rr') ? TRAINING_MIN_RR : MIN_RR)) return null;
    const start = Math.max(ref.from, now);
    return { setup: ref.setup, market: ref.market, from: start, idx: firstAtOrAfter(this.m5, start), late: ref.from < now };
  }

  /** Enregistre chaque setup qui passe les conditions obligatoires, avec son résultat pour chaque gestion. */
  private collectCandidate(eng: EngineResult, now: number, k: number) {
    // protocole complet, ou setup du mode entraînement (déclencheur complet, contexte assoupli) pour la ventilation
    const full = !!eng.setup && eng.checklist.filter(c => c.core).every(c => c.ok);
    const s = full ? eng.setup : eng.nearMiss?.setup;
    if (!s) return;
    const missing = full ? [] : eng.nearMiss!.missingKeys;
    const ok = (key: string) => !!eng.checklist.find(c => c.key === key)?.ok;
    const res = {} as Candidate['res'];
    for (const mode of ['partiel', 'tp1', 'final', 'suivi50', 'suivi75'] as Management[]) {
      const sim = simulate(s, now, this.m15, k + 1, this.costs.spread, mode);
      res[mode] = {
        filledAt: sim.filledAt,
        exitAt: sim.exitAt,
        r: sim.outcome === 'expiré' || sim.outcome === 'en cours' ? null : (sim.pnl - this.commUnit) / (sim.risk + this.commUnit),
      };
    }
    let m5res: Candidate['m5'] = null;
    const zone = eng.zones.find(z => z.id === s.zoneId);
    const live = zone ? this.refineLikeLive(s, zone, now, eng, missing) : null;
    if (this.m5 && this.m5.length && zone && now >= this.m5[0].t && now < this.m5[this.m5.length - 1].t) {
      m5res = {} as NonNullable<Candidate['m5']>;
      for (const mode of ['partiel', 'tp1', 'final', 'suivi50', 'suivi75'] as Management[]) {
        if (!live) {
          m5res[mode] = { filledAt: null, exitAt: null, r: null };
          continue;
        }
        const sim = simulate(live.setup, live.from, this.m5, live.idx, this.costs.spread, mode);
        m5res[mode] = {
          filledAt: sim.filledAt,
          exitAt: sim.exitAt,
          r: sim.outcome === 'expiré' || sim.outcome === 'en cours' ? null : (sim.pnl - this.commUnit) / (sim.risk + this.commUnit),
        };
      }
    }
    let m5mkt: Candidate['m5mkt'] = null;
    if (this.m5 && this.m5.length && zone && now >= this.m5[0].t && now < this.m5[this.m5.length - 1].t) {
      if (live && !live.late) {
        const sim = simulate(live.market, live.from, this.m5, live.idx, this.costs.spread, 'partiel');
        m5mkt = { filledAt: sim.filledAt, exitAt: sim.exitAt, r: sim.outcome === 'expiré' || sim.outcome === 'en cours' ? null : (sim.pnl - this.commUnit) / (sim.risk + this.commUnit) };
      } else m5mkt = { filledAt: null, exitAt: null, r: null };
    }
    const [zoneTf] = s.zoneId.split('-');
    this.candidates.push({
      t: now,
      missing,
      m5mkt,
      direction: s.direction,
      entryType: s.entryType,
      zoneTf,
      touched: !!eng.zones.find(z => z.id === s.zoneId)?.touched,
      optionalOk: eng.checklist.filter(c => !c.core && c.ok).length,
      score: eng.score,
      sweep: ok('sweep'),
      amd: ok('amd'),
      pd: ok('pd'),
      ltf: ok('ltf'),
      killzone: eng.session.killzone,
      rr: s.rr2 ?? s.rr1,
      res,
      m5: m5res,
    });
  }

  /** Tous les trades simulés (pour l'historique des setups similaires). */
  allTrades(): BtTrade[] {
    return this.trades;
  }

  result(): BacktestResult {
    const by = (v: 'strict' | 'souple', from = 0) => this.trades.filter(t => t.variant === v && t.signalAt >= from);
    const m15 = this.m15;
    return {
      pair: this.pair,
      from: this.startT,
      to: m15[m15.length - 1].t,
      stepsEvaluated: this.steps,
      durationMs: this.computeMs,
      rulesVersion: RULES_VERSION,
      frozenFrom: RULES_FROZEN_AT,
      assumptions: [
        'Le moteur ne voit que les bougies clôturées à chaque instant (aucune information future).',
        'Ordre limite annulé après 4 h ou si TP1 est atteint avant l’exécution ; un seul trade à la fois.',
        'Gestion : 50 % à TP1 puis stop au point d’entrée, reste à TP2 ; sans TP2, sortie totale à TP1.',
        'Si stop et objectif sont touchés dans la même bougie M15, on compte le stop (hypothèse prudente).',
        `Coûts inclus : spread ${this.costs.spread} et commission ${this.costs.commissionPerLot} $ par lot.`,
        'Entrée affinée M5 (labo) : même setup M15, CHoCH M5 dans la zone puis ordre limite au milieu de la jambe du CHoCH, stop derrière l’extrême M5 (au moins 25 % du stop M15), gestion simulée sur les bougies M5.',
        'Annonces économiques non filtrées (pas de calendrier historique) : résultats un peu optimistes ou pessimistes selon les jours.',
        `« Depuis le gel des règles » : seuls les signaux apparus après le ${maDateTime(RULES_FROZEN_AT)}, date à laquelle les règles du moteur (version ${RULES_VERSION}) ont été figées. Ces trades n’ont pas pu influencer la conception du moteur : c’est l’équivalent d’un suivi en direct.`,
      ],
      strict: finalize(by('strict')),
      souple: finalize(by('souple')),
      strictForward: finalize(by('strict', RULES_FROZEN_AT)),
      soupleForward: finalize(by('souple', RULES_FROZEN_AT)),
      lastTrades: this.trades
        .filter(t => t.r !== null)
        .sort((a, b) => b.signalAt - a.signalAt)
        .slice(0, 20),
      lab: runLab(this.candidates, this.startT, m15[m15.length - 1].t),
      breakdown: runBreakdown(this.candidates, this.startT, m15[m15.length - 1].t),
      management: runManagement(this.candidates, this.startT, m15[m15.length - 1].t),
    };
  }
}

/** Exécution complète en une fois (tests, scripts). */
export async function runBacktest(pair: string, h1: Candle[], m15: Candle[], decimals: number, costs: BacktestCosts, m5: Candle[] | null = null): Promise<BacktestResult> {
  const run = new BacktestRun(pair, h1, m15, decimals, costs, m5);
  while (!run.done) {
    run.step(2000);
    await new Promise(r => setImmediate(r));
  }
  return run.result();
}

export function sessionBucket(t: number): string {
  const h = nyParts(t).h;
  if (h >= 20 || h < 2) return 'Session asiatique';
  if (h < 7) return 'Londres (hors kill zone)';
  if (h < 17) return 'New York (hors kill zone)';
  return 'Ouverture du jour';
}

/** Résumé lisible d'une variante. */
export function describe(v: VariantStats): string {
  if (!v.trades) return `${v.signals} signal(s), aucun trade clôturé.`;
  return `${v.trades} trades, réussite ${v.winRate} %, total ${v.totalR >= 0 ? '+' : ''}${v.totalR} R, moyenne ${v.avgR} R/trade, profit factor ${v.profitFactor ?? '—'}, pire repli ${v.maxDrawdownR} R.`;
}

export const fmtDate = maDateTime;

// ---------- Historique des setups similaires ----------
export interface SimilarHistory {
  status: 'disponible';
  criteria: string;
  matched: string[];
  trades: number;
  winRate: number;
  avgR: number;
  ciLow: number;
  ciHigh: number;
  profitFactor: number | null;
  fillRate: number | null; // ordres limite réellement exécutés
  verdict: 'favorable' | 'défavorable' | 'non démontré';
  /**
   * Viabilité (0-100) : probabilité statistique que ce type de setup soit rentable sur la durée
   * (espérance > 0), calculée sur ses trades réels. null si moins de 30 trades.
   */
  viability: number | null;
  message: string;
  period: { from: number; to: number };
  rulesVersion: string;
}

/** Fonction de répartition de la loi normale (approximation d'Abramowitz-Stegun, erreur < 1e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

const LABELS: Record<keyof SetupFeatures, (f: SetupFeatures) => string> = {
  direction: f => (f.direction === 'acheter' ? 'achats' : 'ventes'),
  zoneKind: f => (f.zoneKind === 'OB' ? 'Order Block' : 'FVG'),
  zoneTf: f => f.zoneTf,
  session: f => f.session,
  sweep: f => (f.sweep ? 'avec sweep' : 'sans sweep'),
  amd: f => (f.amd ? 'AMD aligné' : 'AMD non aligné'),
  premiumDiscount: f => (f.premiumDiscount ? 'premium/discount respecté' : 'premium/discount non respecté'),
  entryType: f => (f.entryType === 'marché' ? 'au marché' : 'ordre limite'),
};

/**
 * Cherche dans le backtest les setups les plus proches du plan actuel.
 * Du plus précis au plus large : on garde le premier niveau qui réunit au moins 30 trades clôturés.
 */
export function similarHistory(trades: BtTrade[], f: SetupFeatures, period: { from: number; to: number }, minTrades = 30): SimilarHistory | null {
  const pool = trades.filter(t => t.variant === 'strict' && t.features);
  const levels: (keyof SetupFeatures)[][] = [
    ['direction', 'zoneKind', 'zoneTf', 'session', 'sweep', 'amd'],
    ['direction', 'zoneKind', 'zoneTf', 'session', 'sweep'],
    ['direction', 'zoneKind', 'zoneTf', 'session'],
    ['direction', 'zoneKind', 'zoneTf'],
    ['direction', 'zoneKind'],
    ['direction'],
    [],
  ];
  for (const keys of levels) {
    const same = pool.filter(t => keys.every(k => t.features[k] === f[k]));
    const closed = same.filter(t => t.r !== null);
    if (closed.length < minTrades && keys.length) continue;
    if (!closed.length) return null;
    const rs = closed.map(t => t.r!);
    const n = rs.length;
    const mean = rs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    const half = (1.96 * sd) / Math.sqrt(n);
    const gain = rs.filter(r => r > 0).reduce((a, b) => a + b, 0);
    const loss = -rs.filter(r => r < 0).reduce((a, b) => a + b, 0);
    const limits = same.filter(t => t.features.entryType === 'limite');
    // en dessous de 30 trades, aucun verdict : l'échantillon est trop petit
    const verdict: SimilarHistory['verdict'] = n < minTrades ? 'non démontré' : mean - half > 0 ? 'favorable' : mean + half < 0 ? 'défavorable' : 'non démontré';
    const se = sd / Math.sqrt(n);
    const viability = n < minTrades ? null : Math.round(100 * (se > 0 ? normCdf(mean / se) : mean > 0 ? 1 : 0));
    const r2 = (x: number) => Number(x.toFixed(2));
    const matched = keys.map(k => LABELS[k](f));
    const crit = matched.length ? matched.join(' · ') : 'tous les signaux du moteur';
    const message =
      verdict === 'favorable'
        ? `Ce type de setup a historiquement gagné : +${r2(mean)} R par trade en moyenne sur ${n} trades (fourchette probable ${r2(mean - half)} à ${r2(mean + half)} R).`
        : verdict === 'défavorable'
        ? `Ce type de setup a historiquement PERDU : ${r2(mean)} R par trade en moyenne sur ${n} trades. Prudence.`
        : n < minTrades
        ? `Seulement ${n} trades dans l’historique : trop peu pour conclure (${mean >= 0 ? '+' : ''}${r2(mean)} R en moyenne).`
        : `Pas d’avantage démontré : ${mean >= 0 ? '+' : ''}${r2(mean)} R par trade sur ${n} trades, mais la fourchette (${r2(mean - half)} à ${r2(mean + half)} R) inclut zéro. Ce setup peut aussi bien gagner que perdre.`;
    return {
      status: 'disponible',
      criteria: crit,
      matched,
      trades: n,
      winRate: Math.round((rs.filter(r => r > 0.05).length / n) * 100),
      avgR: r2(mean),
      ciLow: r2(mean - half),
      ciHigh: r2(mean + half),
      profitFactor: loss > 0 ? r2(gain / loss) : null,
      fillRate: limits.length ? Math.round((limits.filter(t => t.filledAt !== null).length / limits.length) * 100) : null,
      verdict,
      viability,
      message,
      period,
      rulesVersion: RULES_VERSION,
    };
  }
  return null;
}

// ---------- Labo : variantes de règles, notées sur la 1re moitié, validées sur la 2e ----------
interface Candidate {
  t: number;
  direction: 'acheter' | 'vendre';
  entryType: 'marché' | 'limite';
  zoneTf: string;
  touched: boolean;
  optionalOk: number;
  score: number;
  sweep: boolean;
  amd: boolean;
  pd: boolean;
  ltf: boolean;
  killzone: boolean;
  rr: number;
  /** conditions obligatoires manquantes ([] = protocole complet ; sinon setup du mode entraînement) */
  missing: string[];
  res: Record<Management, { filledAt: number | null; exitAt: number | null; r: number | null }>;
  /** même setup avec l'entrée affinée en M5 (null si pas de bougies M5 sur cette période) */
  m5: Record<Management, { filledAt: number | null; exitAt: number | null; r: number | null }> | null;
  /** même CHoCH M5, entrée au marché à la clôture de la bougie du CHoCH (mesure) ; gestion « partiel » */
  m5mkt: { filledAt: number | null; exitAt: number | null; r: number | null } | null;
}

export interface LabStats {
  trades: number;
  winRate: number | null;
  avgR: number | null;
  totalR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
  ciLow: number | null;
  ciHigh: number | null;
}

export interface LabVariant {
  id: string;
  label: string;
  inSample: LabStats;
  /** révélé seulement pour la référence et les 3 meilleures variantes de la 1re moitié */
  outOfSample: LabStats | null;
}

export interface LabResult {
  splitAt: number;
  rule: string;
  variants: LabVariant[];
}

// La règle de base reproduit exactement le signal actuel du moteur (règles 3.7 : toutes les étapes obligatoires,
// déjà exigées par collectCandidate). Les variantes ajoutent des filtres par-dessus.
const marketRule = (c: Candidate) => !(c.entryType === 'marché' && !c.ltf);
const base = (c: Candidate) => marketRule(c) && c.missing.length === 0;

/** Liste FIGÉE à l'avance : on ne l'ajuste pas après avoir vu les résultats. */
export const LAB_VARIANTS: { id: string; label: string; filter: (c: Candidate) => boolean; mode: Management; m5?: boolean }[] = [
  { id: 'base', label: 'Référence : règles actuelles (protocole 3.7)', filter: base, mode: 'partiel' },
  { id: 'aplus', label: 'Classe A+ uniquement', filter: c => base(c) && c.score >= 70, mode: 'partiel' },
  { id: 'kz', label: 'Kill zone obligatoire', filter: c => base(c) && c.killzone, mode: 'partiel' },
  { id: 'pd', label: 'Premium/discount obligatoire', filter: c => base(c) && c.pd, mode: 'partiel' },
  { id: 'amd', label: 'Cycle AMD aligné obligatoire', filter: c => base(c) && c.amd, mode: 'partiel' },
  { id: 'ltf', label: 'Structure M15 alignée obligatoire', filter: c => base(c) && c.ltf, mode: 'partiel' },
  { id: 'h1', label: 'Zones H1 uniquement', filter: c => base(c) && c.zoneTf === 'H1', mode: 'partiel' },
  { id: 'fresh', label: 'Zones jamais testées uniquement', filter: c => base(c) && !c.touched, mode: 'partiel' },
  { id: 'rr3', label: 'R:R final ≥ 3', filter: c => base(c) && c.rr >= 3, mode: 'partiel' },
  { id: 'tp1', label: 'Gestion : tout à TP1', filter: base, mode: 'tp1' },
  { id: 'final', label: 'Gestion : tout à l’objectif final, sans point mort', filter: base, mode: 'final' },
  // hypothèse testée (déclarée avant le test) : même setup M15, entrée sur CHoCH M5 dans la zone
  { id: 'm5', label: 'Entrée affinée M5 (CHoCH M5 dans la zone M15)', filter: c => base(c) && !!c.m5, mode: 'partiel', m5: true },
];

/** Variantes dont la 2e moitié est toujours révélée : la référence et les hypothèses déclarées à l'avance. */
const ALWAYS_REVEALED = ['base', 'm5'];

/**
 * Ventilation par condition manquante (mesure seule, aucune règle changée). Liste et critère FIGÉS avant de voir
 * les résultats : on n'envisagera d'assouplir une condition que si la variante reste ≥ +0,2 R net par trade sur
 * CHACUNE des deux moitiés, avec au moins 30 trades par moitié. Les deux moitiés sont toujours affichées.
 */
export const BREAKDOWN_CRITERION = { minAvgR: 0.2, minTradesPerHalf: 30 };
const only = (c: Candidate, key: string) => c.missing.length === 1 && c.missing[0] === key;
export const BREAKDOWN_VARIANTS: { id: string; label: string; filter: (c: Candidate) => boolean }[] = [
  { id: 'protocole', label: 'Protocole complet (référence)', filter: c => c.missing.length === 0 },
  { id: 'sans_kz', label: 'Protocole + setups à qui il manque SEULEMENT la kill zone', filter: c => c.missing.length === 0 || only(c, 'session') },
  { id: 'sans_rr', label: 'Protocole + setups à qui il manque SEULEMENT le R:R 2,5 (R:R entre 2 et 2,5)', filter: c => c.missing.length === 0 || only(c, 'rr') },
  { id: 'sans_pd', label: 'Protocole + setups à qui il manque SEULEMENT le premium/discount', filter: c => c.missing.length === 0 || only(c, 'pd') },
  { id: 'sans_htf', label: 'Protocole + setups à qui il manque SEULEMENT le contexte HTF', filter: c => c.missing.length === 0 || only(c, 'htf') },
  { id: 'kz_seul', label: 'Setups à qui il manque seulement la kill zone (seuls, sans le protocole)', filter: c => only(c, 'session') },
  { id: 'test_312', label: 'Protocole + mode TEST 3.12 (il ne manque que le premium/discount et/ou un R:R entre 2 et 2,5)', filter: c => c.missing.every(k => k === 'pd' || k === 'rr') },
  { id: 'tout_test', label: 'Protocole + tous les setups presque complets (ancien mode TEST)', filter: () => true },
];
/** lignes mesurées aussi avec l'entrée au marché après le CHoCH M5 */
const MARKET_ROWS = ['protocole', 'test_312'];

export interface BreakdownRow {
  id: string;
  label: string;
  exec: 'M15' | 'M5' | 'M5 marché';
  firstHalf: LabStats;
  secondHalf: LabStats;
  tradesPerDay: number;
  passes: boolean;
}

export function runBreakdown(cands: Candidate[], from: number, to: number): { criterion: string; splitAt: number; rows: BreakdownRow[] } {
  const splitAt = from + (to - from) / 2;
  const tradingDays = Math.max(1, ((to - from) / 86_400_000) * (5 / 7));
  const rows: BreakdownRow[] = [];
  for (const exec of ['M15', 'M5', 'M5 marché'] as const) {
    if (exec !== 'M15' && !cands.some(c => c.m5)) continue;
    for (const v of BREAKDOWN_VARIANTS) {
      if (exec === 'M5 marché' && !MARKET_ROWS.includes(v.id)) continue;
      let busy = 0;
      const a: number[] = [];
      const b: number[] = [];
      for (const c of cands) {
        if (c.t < busy || !marketRule(c) || !v.filter(c)) continue;
        if (exec === 'M5' && !c.m5) continue;
        if (exec === 'M5 marché' && !c.m5mkt) continue;
        const r = exec === 'M5' ? c.m5!.partiel : exec === 'M5 marché' ? c.m5mkt! : c.res.partiel;
        busy = r.exitAt ?? (r.filledAt === null ? c.t + EXPIRY : Number.MAX_SAFE_INTEGER);
        if (r.r === null) continue;
        (c.t < splitAt ? a : b).push(r.r);
      }
      const firstHalf = labStats(a);
      const secondHalf = labStats(b);
      const ok = (h: LabStats) => h.trades >= BREAKDOWN_CRITERION.minTradesPerHalf && (h.avgR ?? -1) >= BREAKDOWN_CRITERION.minAvgR;
      rows.push({ id: v.id, label: v.label, exec, firstHalf, secondHalf, tradesPerDay: Number(((a.length + b.length) / tradingDays).toFixed(2)), passes: ok(firstHalf) && ok(secondHalf) });
    }
  }
  return {
    criterion: `Critère fixé avant le test : au moins ${BREAKDOWN_CRITERION.minTradesPerHalf} trades et ≥ +${BREAKDOWN_CRITERION.minAvgR} R net par trade sur CHACUNE des deux moitiés.`,
    splitAt,
    rows,
  };
}

/** Comparaison des gestions de sortie (mesure) : celle du backtest (50 % à TP1 + point mort) contre la gestion de Mehdi. */
export const MANAGEMENT_ROWS: { id: Management; label: string }[] = [
  { id: 'partiel', label: '50 % à TP1, stop au point d’entrée, reste à TP2 (gestion actuelle du backtest)' },
  { id: 'suivi50', label: 'Toute la position à TP2, stop remonté sur TP1 à mi-chemin TP1 → TP2' },
  { id: 'suivi75', label: 'Toute la position à TP2, stop remonté sur TP1 aux 3/4 du chemin TP1 → TP2' },
];
export interface ManagementRow {
  id: Management;
  label: string;
  firstHalf: LabStats;
  secondHalf: LabStats;
}
export function runManagement(cands: Candidate[], from: number, to: number): { splitAt: number; scope: string; rows: ManagementRow[] } | null {
  if (!cands.some(c => c.m5)) return null;
  const splitAt = from + (to - from) / 2;
  const rows = MANAGEMENT_ROWS.map(m => {
    let busy = 0;
    const a: number[] = [];
    const b: number[] = [];
    for (const c of cands) {
      // protocole + TEST 3.12, exécution M5 (comme en direct)
      if (c.t < busy || !marketRule(c) || !c.missing.every(k => k === 'pd' || k === 'rr') || !c.m5) continue;
      const r = c.m5[m.id];
      busy = r.exitAt ?? (r.filledAt === null ? c.t + EXPIRY : Number.MAX_SAFE_INTEGER);
      if (r.r === null) continue;
      (c.t < splitAt ? a : b).push(r.r);
    }
    return { id: m.id, label: m.label, firstHalf: labStats(a), secondHalf: labStats(b) };
  });
  return { splitAt, scope: 'Protocole + TEST 3.12, exécution M5, frais compris', rows };
}

export function labStats(rs: number[]): LabStats {
  const n = rs.length;
  const r2 = (x: number) => Number(x.toFixed(2));
  if (!n) return { trades: 0, winRate: null, avgR: null, totalR: 0, profitFactor: null, maxDrawdownR: 0, ciLow: null, ciHigh: null };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const half = (1.96 * sd) / Math.sqrt(n);
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const r of rs) {
    eq += r;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  const gain = rs.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const loss = -rs.filter(r => r < 0).reduce((a, b) => a + b, 0);
  return {
    trades: n,
    winRate: Math.round((rs.filter(r => r > 0.05).length / n) * 100),
    avgR: r2(mean),
    totalR: r2(eq),
    profitFactor: loss > 0 ? r2(gain / loss) : null,
    maxDrawdownR: r2(dd),
    ciLow: r2(mean - half),
    ciHigh: r2(mean + half),
  };
}

/** Rejoue chaque variante (un trade à la fois), sépare 1re et 2e moitié de la période. */
export function runLab(cands: Candidate[], from: number, to: number): LabResult {
  const splitAt = from + (to - from) / 2;
  const hasM5 = cands.some(c => c.m5);
  const evaluated = LAB_VARIANTS.filter(v => !v.m5 || hasM5).map(v => {
    let busy = 0;
    const isR: number[] = [];
    const oosR: number[] = [];
    for (const c of cands) {
      if (c.t < busy || !v.filter(c)) continue;
      const r = v.m5 ? c.m5![v.mode] : c.res[v.mode];
      busy = r.exitAt ?? (r.filledAt === null ? c.t + EXPIRY : Number.MAX_SAFE_INTEGER);
      if (r.r === null) continue;
      (c.t < splitAt ? isR : oosR).push(r.r);
    }
    return { id: v.id, label: v.label, inSample: labStats(isR), oosAll: labStats(oosR) };
  });
  // Règle de sélection fixée à l'avance : les 3 meilleures moyennes de la 1re moitié parmi les variantes
  // ayant au moins 60 trades. Seules celles-ci (et la référence) voient leur 2e moitié révélée.
  const top = evaluated
    .filter(v => !ALWAYS_REVEALED.includes(v.id) && v.inSample.trades >= 60 && v.inSample.avgR !== null)
    .sort((a, b) => b.inSample.avgR! - a.inSample.avgR!)
    .slice(0, 3)
    .map(v => v.id);
  return {
    splitAt,
    rule: 'Sélection sur la 1re moitié uniquement (meilleure moyenne en R, au moins 60 trades) ; la 2e moitié n’est révélée que pour les 3 retenues, la référence et l’entrée affinée M5 (hypothèse déclarée avant le test).',
    variants: evaluated.map(v => ({
      id: v.id,
      label: v.label,
      inSample: v.inSample,
      outOfSample: ALWAYS_REVEALED.includes(v.id) || top.includes(v.id) ? v.oosAll : null,
    })),
  };
}
