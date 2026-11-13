// Laboratoire rapide : rejoue en quelques secondes les setups trouvés par le dernier backtest avec d'autres réglages
// (stop minimal en ATR H1, sessions, sens, R:R, gestion, exécution M15 / M5). Le moteur n'est pas relancé : seuls
// l'ordre et sa gestion changent. Mesure seule : aucune règle de l'app n'est modifiée ici.
import { EXPIRY, firstAtOrAfter, labStats, marketRule, simulate, type Candidate, type LabData, type LabStats, type Management } from './backtest';
import { MIN_RR, TRAINING_MIN_RR, type Setup } from './smc';

export interface QuickLabParams {
  /** M15 : ordre limite sur la zone M15 ; M5 : CHoCH M5 puis ordre limite (comme en direct) ; M5 marché : entrée à la clôture du CHoCH M5 */
  execution: 'M15' | 'M5' | 'M5 marché';
  /** conditions obligatoires qu'un setup peut manquer (pd, rr, session, htf) */
  allowMissing: string[];
  /** stop au moins égal à k × ATR H1 du moment du signal (0 = stop du moteur) */
  minStopAtrH1: number;
  /** R:R net minimal de l'ordre final (après ajustement du stop) pour un setup du protocole ; un setup TEST dont seul
   *  le R:R manquait garde le minimum TEST (2), comme en direct */
  minRR: number;
  direction: 'tous' | 'acheter' | 'vendre';
  sessions: 'toutes' | 'londres' | 'new_york';
  management: Management;
}

export interface QuickLabResult {
  params: QuickLabParams;
  all: LabStats;
  halves: [LabStats, LabStats];
  quarters: LabStats[];
  tradesPerDay: number;
  passes: boolean;
  quartersPositive: number;
  byDirection: Record<string, LabStats>;
  bySession: Record<string, LabStats>;
}

export const QUICK_CRITERION = { minAvgR: 0.2, minTradesPerHalf: 30, minPositiveQuarters: 3 };

function widen(s: Setup, minDist: number): Setup {
  const dist = Math.abs(s.entry - s.sl);
  if (!(minDist > dist)) return s;
  const long = s.direction === 'acheter';
  return { ...s, sl: long ? s.entry - minDist : s.entry + minDist };
}

export function runQuickLab(d: LabData, p: QuickLabParams): QuickLabResult {
  const commUnit = d.costs.commissionPerLot / d.costs.contract;
  const spread = d.costs.spread;
  const rrNet = (s: Setup) => {
    const risk = Math.abs(s.entry - s.sl);
    const tp = s.tp2 ?? s.tp1;
    return (Math.abs(tp - s.entry) - commUnit) / (risk + commUnit);
  };
  const rows: { t: number; r: number; dir: string; ses: string }[] = [];
  let busy = 0;
  for (const c of d.candidates as Candidate[]) {
    if (c.t < busy || !marketRule(c)) continue;
    // 'rr' est jugé ci-dessous avec minRR, sur l'ordre final
    if (!c.missing.every(k => k === 'rr' || p.allowMissing.includes(k))) continue;
    if (p.direction !== 'tous' && c.direction !== p.direction) continue;
    if (p.sessions === 'londres' && !/Londres/.test(c.session)) continue;
    if (p.sessions === 'new_york' && !/New York/.test(c.session)) continue;
    let order: Setup | null = null;
    let candles = d.m15;
    let from = c.t;
    let idx = -1;
    if (p.execution === 'M15') {
      order = c.setup;
      idx = firstAtOrAfter(d.m15, c.t);
    } else {
      if (!c.hasM5 || !d.m5) continue;
      candles = d.m5;
      const live = p.execution === 'M5' ? c.live : c.live && !c.live.late ? c.live : null;
      if (live) {
        order = p.execution === 'M5' ? live.setup : live.market;
        from = live.from;
        idx = live.idx;
      }
    }
    if (order && p.minStopAtrH1 > 0) order = widen(order, p.minStopAtrH1 * c.atrH1);
    const need = c.missing.includes('rr') ? Math.min(TRAINING_MIN_RR, p.minRR) : p.minRR;
    if (!order || rrNet(order) < need - 1e-9) {
      // pas d'ordre exploitable : le setup occupe quand même la fenêtre de l'ordre (comme le backtest)
      busy = c.t + EXPIRY;
      continue;
    }
    const sim = simulate(order, from, candles, idx, spread, p.management);
    busy = sim.exitAt ?? (sim.filledAt === null ? c.t + EXPIRY : Number.MAX_SAFE_INTEGER);
    if (sim.outcome === 'expiré' || sim.outcome === 'en cours') continue;
    const r = (sim.pnl - commUnit) / (sim.risk + commUnit);
    rows.push({ t: c.t, r, dir: c.direction, ses: /Londres/.test(c.session) ? 'Londres' : /New York/.test(c.session) ? 'New York' : 'hors kill zone' });
  }
  const span = d.to - d.from;
  const cut = (i: number, n: number) => d.from + (span * i) / n;
  const part = (a: number, b: number) => labStats(rows.filter(x => x.t >= a && x.t < b).map(x => x.r));
  const halves: [LabStats, LabStats] = [part(d.from, cut(1, 2)), part(cut(1, 2), d.to + 1)];
  const quarters = [0, 1, 2, 3].map(i => part(cut(i, 4), i === 3 ? d.to + 1 : cut(i + 1, 4)));
  const okHalf = (h: LabStats) => h.trades >= QUICK_CRITERION.minTradesPerHalf && (h.avgR ?? -1) >= QUICK_CRITERION.minAvgR;
  const quartersPositive = quarters.filter(q => q.trades > 0 && q.totalR > 0).length;
  const group = (key: 'dir' | 'ses') => {
    const out: Record<string, LabStats> = {};
    for (const k of [...new Set(rows.map(x => x[key]))]) out[k] = labStats(rows.filter(x => x[key] === k).map(x => x.r));
    return out;
  };
  const tradingDays = Math.max(1, (span / 86_400_000) * (5 / 7));
  return {
    params: p,
    all: labStats(rows.map(x => x.r)),
    halves,
    quarters,
    tradesPerDay: Number((rows.length / tradingDays).toFixed(2)),
    passes: okHalf(halves[0]) && okHalf(halves[1]) && quartersPositive >= QUICK_CRITERION.minPositiveQuarters,
    quartersPositive,
    byDirection: group('dir'),
    bySession: group('ses'),
  };
}

const BASE: QuickLabParams = { execution: 'M5', allowMissing: ['pd'], minStopAtrH1: 0, minRR: MIN_RR, direction: 'tous', sessions: 'toutes', management: 'partiel' };

/**
 * Hypothèses déclarées AVANT de voir les résultats (13/11/2026). Une hypothèse n'est retenue que si elle passe le
 * critère : ≥ 30 trades et ≥ +0,2 R net par trade sur CHACUNE des deux moitiés, et au moins 3 trimestres sur 4 positifs.
 */
export const QUICK_HYPOTHESES: { id: string; label: string; params: QuickLabParams }[] = [
  { id: 'ref', label: 'Référence : règles en direct (protocole + TEST, exécution M5, 50 % à TP1)', params: BASE },
  { id: 'atr1_m5', label: 'Stop ≥ 1 ATR H1, exécution M5', params: { ...BASE, minStopAtrH1: 1 } },
  { id: 'atr15_m5', label: 'Stop ≥ 1,5 ATR H1, exécution M5', params: { ...BASE, minStopAtrH1: 1.5 } },
  { id: 'm15', label: 'Exécution M15 (ordre limite sur la zone)', params: { ...BASE, execution: 'M15' } },
  { id: 'atr1_m15', label: 'Stop ≥ 1 ATR H1, exécution M15', params: { ...BASE, execution: 'M15', minStopAtrH1: 1 } },
  { id: 'atr15_m15', label: 'Stop ≥ 1,5 ATR H1, exécution M15', params: { ...BASE, execution: 'M15', minStopAtrH1: 1.5 } },
  { id: 'suivi75', label: 'Gestion de Mehdi : stop remonté sur TP1 aux 3/4 de TP1 → TP2', params: { ...BASE, management: 'suivi75' } },
  { id: 'atr1_suivi75', label: 'Stop ≥ 1 ATR H1 + gestion de Mehdi (3/4)', params: { ...BASE, minStopAtrH1: 1, management: 'suivi75' } },
  { id: 'ny', label: 'Kill zone de New York seulement', params: { ...BASE, sessions: 'new_york' } },
  { id: 'londres', label: 'Kill zone de Londres seulement', params: { ...BASE, sessions: 'londres' } },
  { id: 'tp1', label: 'Tout à TP1', params: { ...BASE, management: 'tp1' } },
  { id: 'atr1_tp1_m15', label: 'Stop ≥ 1 ATR H1, tout à TP1, exécution M15', params: { ...BASE, execution: 'M15', minStopAtrH1: 1, management: 'tp1' } },
];
