// Exécution en direct : actifs en pause et entrée affinée en M5.
// La règle M5 est EXACTEMENT celle du backtest (refineM5) : ce qui a été testé est ce qui est appliqué.
import { EXPIRY, refineM5 } from './backtest';
import type { Candle } from './marketData';
import { MIN_RR, nextRollover, type EngineResult, type Setup } from './smc';
import { maTime, nyParts, nyToUtc } from './time';

/**
 * Actifs en pause : le moteur continue d'analyser (pour le suivi), mais aucun trade n'est proposé.
 * Décision du 06/11/2026 après le backtest sur 2 ans (règles 3.10).
 */
export const PAUSED_PAIRS: Record<string, string> = {
  'EUR/USD':
    'EUR/USD en pause : sur 2 ans, la stratégie y perd (−0,19 R par trade sur 180 trades, sur les deux moitiés de l’historique). Les setups restent affichés pour le suivi, mais aucun trade n’est proposé.',
};

/** Actifs exécutés en M5 : le scénario M15 complet reste obligatoire, l'entrée se fait sur CHoCH M5 dans la zone. */
export const M5_EXECUTION_PAIRS = new Set(['XAU/USD']);

export type M5StageKind = 'attente_zone' | 'attente_choch' | 'ordre' | 'manqué' | 'annulé' | 'indisponible';

export interface M5Stage {
  stage: M5StageKind;
  /** phrase affichée au trader */
  message: string;
  zone: { bottom: number; top: number };
  /** début de la surveillance M5 (clôture du CHoCH M15, ou début de la kill zone) */
  from: number;
  /** fin de la fenêtre de 4 h pour obtenir le CHoCH M5 */
  until: number;
  extreme: number | null;
  chochLevel: number | null;
  order: { entry: number; sl: number; tp1: number; tp2: number | null; rr1: number; rr2: number | null; validUntil: number; chochAt: number } | null;
}

/** Début de la kill zone en cours (Londres 02h00, New York 07h00, heure de New York), ou null hors kill zone. */
export function killzoneStart(now: number): number | null {
  const p = nyParts(now);
  const h0 = p.h >= 2 && p.h < 5 ? 2 : p.h >= 7 && p.h < 10 ? 7 : null;
  return h0 === null ? null : nyToUtc(p.y, p.m, p.d, h0);
}

/** Bougies M5 clôturées uniquement (la bougie en cours ne compte jamais comme structure). */
export const closedM5 = (m5: Candle[], now: number) => m5.filter(c => c.t + 5 * 60_000 <= now);

/**
 * Étape de l'exécution M5 pour un setup M15 valide.
 * from = instant où le setup M15 est devenu exploitable ; m5 = bougies M5 clôturées.
 */
export function m5Stage(
  setup: Setup,
  zone: { bottom: number; top: number },
  from: number,
  m5: Candle[],
  now: number,
  opts: { spread: number; commUnit: number; decimals: number; newsCut?: number | null }
): M5Stage {
  const r = (x: number) => Number(x.toFixed(opts.decimals));
  const long = setup.direction === 'acheter';
  const base = { zone, from, until: from + EXPIRY, extreme: null, chochLevel: null, order: null };
  const zoneTxt = `${r(zone.bottom)} – ${r(zone.top)}`;
  const ref = refineM5(setup, zone, from, m5, opts.spread);

  if (ref.kind === 'annulé') {
    const why =
      ref.reason === 'stop M15 touché'
        ? `le prix a touché le stop M15 (${setup.sl}) avant tout CHoCH M5 : le setup a échoué, pas de trade.`
        : ref.reason === 'objectif atteint'
        ? `l’objectif TP1 (${setup.tp1}) a été atteint sans retour propre dans la zone : on ne court pas après le prix.`
        : `pas de CHoCH M5 dans la zone en 4 h : le setup a expiré.`;
    return { ...base, stage: 'annulé', message: `Exécution M5 : ${why}` };
  }

  if (ref.kind === 'en attente') {
    if (!ref.inZone) {
      return {
        ...base,
        until: ref.until,
        stage: 'attente_zone',
        message: `Setup M15 valide. Exécution M5 : attends que le prix revienne dans la zone ${zoneTxt}, puis un CHoCH M5 ${long ? 'haussier' : 'baissier'}. Aucun ordre à placer pour l’instant. Relance l’analyse quand le prix est dans la zone (au plus tard ${maTime(ref.until)}, heure du Maroc).`,
      };
    }
    return {
      ...base,
      until: ref.until,
      extreme: ref.extreme,
      chochLevel: ref.chochLevel,
      stage: 'attente_choch',
      message: `Prix dans la zone ${zoneTxt}. Exécution M5 : attends une clôture M5 ${long ? 'au-dessus de' : 'sous'} ${ref.chochLevel !== null ? r(ref.chochLevel) : 'la dernière structure M5'} (CHoCH M5). Si le prix ${long ? 'descend sous' : 'monte au-dessus de'} ${setup.sl}, le setup est annulé. Relance l’analyse dans 5 à 15 minutes (au plus tard ${maTime(ref.until)}).`,
    };
  }

  // CHoCH M5 obtenu : ordre limite au milieu de la jambe, comme dans le backtest
  const o = ref.setup;
  const entry = r(o.entry);
  const sl = r(o.sl);
  const chochAt = ref.from - 5 * 60_000;
  let validUntil = Math.min(ref.from + EXPIRY, nextRollover(now));
  if (opts.newsCut) validUntil = Math.min(validUntil, opts.newsCut);
  // depuis le CHoCH : l'ordre a-t-il déjà été servi, ou TP1 atteint sans nous ?
  for (const c of m5.filter(x => x.t >= ref.from)) {
    const tp1Reached = long ? c.h >= setup.tp1 : c.l <= setup.tp1 - opts.spread;
    const touched = long ? c.l <= entry - opts.spread : c.h >= entry;
    if (touched) {
      return {
        ...base,
        stage: 'manqué',
        message: `Exécution M5 : le CHoCH M5 a eu lieu à ${maTime(chochAt)} et le prix est déjà revenu à l’entrée (${entry}) à ${maTime(c.t)}. Le trade est parti sans toi : ne le prends pas en retard, à un moins bon prix.`,
      };
    }
    if (tp1Reached) return { ...base, stage: 'annulé', message: `Exécution M5 : TP1 (${setup.tp1}) atteint avant le retour à l’entrée M5 : setup annulé.` };
  }
  if (validUntil <= now) return { ...base, stage: 'annulé', message: `Exécution M5 : l’ordre issu du CHoCH M5 de ${maTime(chochAt)} a expiré.` };
  const commUnit = opts.commUnit;
  const risk = Math.abs(entry - sl);
  const rrNet = (tp: number) => Number(((Math.abs(tp - entry) - commUnit) / (risk + commUnit)).toFixed(2));
  const rr1 = rrNet(setup.tp1);
  const rr2 = setup.tp2 !== null ? rrNet(setup.tp2) : null;
  const ordered = long ? sl < entry && entry < setup.tp1 : sl > entry && entry > setup.tp1;
  if (!ordered || (rr2 ?? rr1) < MIN_RR) {
    return { ...base, stage: 'annulé', message: `Exécution M5 : niveaux M5 incohérents ou R:R insuffisant (${rr2 ?? rr1}) : pas de trade.` };
  }
  return {
    ...base,
    stage: 'ordre',
    extreme: null,
    chochLevel: null,
    order: { entry, sl, tp1: setup.tp1, tp2: setup.tp2, rr1, rr2, validUntil, chochAt },
    message: `CHoCH M5 à ${maTime(chochAt)} dans la zone ${zoneTxt} : ordre ${long ? 'Buy' : 'Sell'} Limit à ${entry}, stop ${sl} (stop M5, plus serré que le stop M15 ${setup.sl}), objectifs inchangés. Valable jusqu’à ${maTime(validUntil)}.`,
  };
}

/** Début de la surveillance M5 : clôture de la bougie M15 du CHoCH, et pas avant le début de la kill zone en cours. */
export function m5WatchStart(mssT: number, now: number): number {
  const kz = killzoneStart(now);
  return Math.max(mssT + 15 * 60_000, kz ?? 0);
}

interface FinalLike {
  signal: 'acheter' | 'vendre' | 'attendre';
  plan: { direction: 'acheter' | 'vendre'; entryType: 'marché' | 'limite'; entry: number; sl: number; tp1: number; tp2: number | null; rr1: number; rr2: number | null; origin: any } | null;
  notes: string[];
}

/**
 * Après le moteur, le pipeline et les garde-fous : exécution M5 puis pause éventuelle de l'actif.
 * Modifie final (et engine.setup quand un ordre M5 est donné). m5 = bougies M5 brutes (null si indisponibles).
 */
export function applyExecution(
  pair: string,
  engine: EngineResult,
  final: FinalLike,
  m5: Candle[] | null,
  now: number,
  costs: { spread: number; commissionPerLot: number; contract: number },
  decimals: number
): { execution: M5Stage | null; paused: string | null } {
  let execution: M5Stage | null = null;
  if (final.signal !== 'attendre' && final.plan && engine.setup && engine.trigger && M5_EXECUTION_PAIRS.has(pair)) {
    const zone = engine.zones.find(z => z.id === engine.setup!.zoneId);
    const from = m5WatchStart(engine.trigger.mss.t, now);
    if (!zone || !m5) {
      execution = {
        stage: 'indisponible',
        zone: zone ? { bottom: zone.bottom, top: zone.top } : { bottom: final.plan.entry, top: final.plan.entry },
        from,
        until: from,
        extreme: null,
        chochLevel: null,
        order: null,
        message: 'Bougies M5 indisponibles : impossible de vérifier le CHoCH M5, donc pas d’entrée. Réessaie dans une minute.',
      };
    } else {
      execution = m5Stage(engine.setup, { bottom: zone.bottom, top: zone.top }, from, closedM5(m5, now), now, {
        spread: costs.spread,
        commUnit: costs.commissionPerLot / costs.contract,
        decimals,
        newsCut: engine.nextNews ? engine.nextNews.t - 30 * 60_000 : null,
      });
    }
    if (execution.stage === 'ordre' && execution.order) {
      const o = execution.order;
      final.plan = { ...final.plan, entryType: 'limite', entry: o.entry, sl: o.sl, rr1: o.rr1, rr2: o.rr2 };
      engine.setup = { ...engine.setup, entryType: 'limite', entry: o.entry, sl: o.sl, rr1: o.rr1, rr2: o.rr2, validUntil: o.validUntil };
      final.notes.push(execution.message);
    } else {
      final.signal = 'attendre';
      final.notes.unshift(execution.message);
    }
  }
  const paused = PAUSED_PAIRS[pair] ?? null;
  if (paused && final.signal !== 'attendre' && final.plan) {
    final.notes.unshift(`Setup détecté (${final.plan.direction === 'acheter' ? 'achat' : 'vente'} à ${final.plan.entry}), non proposé. ${paused}`);
    final.signal = 'attendre';
  }
  return { execution, paused };
}
