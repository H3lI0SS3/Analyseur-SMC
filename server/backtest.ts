// Backtest : rejoue le moteur bougie par bougie sur l'historique réel, sans regarder le futur,
// puis simule chaque plan comme un trader discipliné (ordre limite expirant, stop, prises partielles).
// Deux variantes sont mesurées en un seul passage :
//  - « strict »  : ta règle d'origine, pas de trade sans balayage de liquidité préalable ;
//  - « souple »  : le balayage n'est qu'un bonus de confluence.

import { aggregateTrading, TF_MS, type Candle, type Timeframe } from './marketData';
import { analyze, RULES_FROZEN_AT, RULES_VERSION, type EngineResult, type Setup } from './smc';
import { HOUR, marketClosed, maDateTime, nyParts } from './time';

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
}

const EXPIRY = 4 * HOUR; // un ordre limite non exécuté est annulé après 4 h
const MAX_HOLD = 5 * 24 * HOUR; // un trade ouvert est clôturé après 5 jours

export function simulate(setup: Setup, from: number, m15: Candle[], startIdx: number, spread: number) {
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

  // 2. gestion : SL ; à TP1 on encaisse 50 % et le stop passe au point d'entrée ; reste à TP2
  let remaining = 1;
  let pnl = 0;
  let tp1Done = false;
  const hasTp2 = setup.tp2 !== null;
  for (let i = filledIdx; i < m15.length; i++) {
    const c = m15[i];
    if (c.t - filledAt > MAX_HOLD) {
      pnl += remaining * (long ? c.o - entry : entry - c.o - spread);
      return { filledAt, exitAt: c.t, pnl, outcome: 'clôturé (durée max)' as const, risk };
    }
    // stop d'abord (hypothèse prudente si stop et objectif dans la même bougie)
    const slHit = long ? c.l <= sl : c.h >= sl - spread;
    if (slHit) {
      pnl += remaining * (long ? sl - entry : entry - sl);
      const outcome = tp1Done ? ('gagné' as const) : Math.abs(sl - entry) < 1e-12 ? ('break-even' as const) : ('perdu' as const);
      return { filledAt, exitAt: c.t, pnl, outcome, risk };
    }
    const hit = (tp: number) => (long ? c.h >= tp : c.l <= tp - spread);
    if (!tp1Done && hit(setup.tp1)) {
      const part = hasTp2 ? 0.5 : 1;
      pnl += part * Math.abs(setup.tp1 - entry);
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
    private costs: BacktestCosts
  ) {
    this.h4All = aggregateTrading(h1, 'H4');
    this.d1All = aggregateTrading(h1, 'D1');
    this.commUnit = costs.commissionPerLot / costs.contract;
    // départ : il faut au moins 60 jours de H1 et 500 bougies M15 d'historique
    this.startT = Math.max(h1[0].t + 60 * 24 * HOUR, m15[Math.min(500, m15.length - 1)].t);
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
      // un trade est déjà en cours dans les deux variantes : aucun nouveau signal ne serait pris
      if (now < this.busyUntil.strict && now < this.busyUntil.souple) continue;
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
        });
      } catch {
        continue;
      }
      this.steps++;

      const souple = eng.signal !== 'attendre' && !!eng.setup;
      const sweepOk = !!eng.checklist.find(c => c.key === 'sweep')?.ok;
      const optionalOk = eng.checklist.filter(c => !c.core && c.ok).length;
      const strict = souple && sweepOk && optionalOk - 1 >= 2;

      for (const variant of ['strict', 'souple'] as const) {
        const take = variant === 'strict' ? strict : souple;
        if (!take || now < this.busyUntil[variant]) continue; // un seul trade à la fois par variante
        const setup = eng.setup!;
        const sim = simulate(setup, now, m15, k + 1, this.costs.spread);
        const r = sim.outcome === 'expiré' || sim.outcome === 'en cours' ? null : (sim.pnl - this.commUnit) / (sim.risk + this.commUnit);
        this.trades.push({
          variant,
          signalAt: now,
          filledAt: sim.filledAt,
          exitAt: sim.exitAt,
          direction: setup.direction,
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
    };
  }
}

/** Exécution complète en une fois (tests, scripts). */
export async function runBacktest(pair: string, h1: Candle[], m15: Candle[], decimals: number, costs: BacktestCosts): Promise<BacktestResult> {
  const run = new BacktestRun(pair, h1, m15, decimals, costs);
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
  message: string;
  period: { from: number; to: number };
  rulesVersion: string;
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
  const pool = trades.filter(t => t.variant === 'souple' && t.features);
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
      message,
      period,
      rulesVersion: RULES_VERSION,
    };
  }
  return null;
}
