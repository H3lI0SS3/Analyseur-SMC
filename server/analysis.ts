// Logique d'analyse partagée entre l'interface web (/api/analyze) et le connecteur MCP.
import { PAIRS, TIMEFRAMES, getSeries, type Timeframe, type Candle } from './marketData';
import { getNews, NEWS_CURRENCIES } from './news';
import type { CandlePattern } from './candlePatterns';
import { marketClosed, maTime } from './time';
import { analyze, RULES_VERSION, type EngineResult } from './smc';
import { availableProviders, reviewWithAi, type AiProvider, type AiReview } from './ai';

export const compact = (c: Candle[], n: number, dec: number) =>
  c
    .slice(-n)
    .map(x => `[${new Date(x.t).toISOString().slice(5, 16).replace('T', ' ')},${x.o.toFixed(dec)},${x.h.toFixed(dec)},${x.l.toFixed(dec)},${x.c.toFixed(dec)}]`)
    .join('\n');

export interface FinalPlan {
  direction: 'acheter' | 'vendre';
  entryType: 'marché' | 'limite';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number | null;
  rr1: number;
  rr2: number | null;
  origin: 'moteur' | 'ajusté par l’IA';
}

export interface Costs {
  spread: number;
  commissionPerLot: number;
  contract: number;
}

export function reconcile(eng: EngineResult, ai: AiReview | null, dec: number, costs: Costs) {
  const notes: string[] = [];
  let signal = eng.signal;
  let plan: FinalPlan | null = eng.setup
    ? {
        direction: eng.setup.direction,
        entryType: eng.setup.entryType,
        entry: eng.setup.entry,
        sl: eng.setup.sl,
        tp1: eng.setup.tp1,
        tp2: eng.setup.tp2,
        rr1: eng.setup.rr1,
        rr2: eng.setup.rr2,
        origin: 'moteur',
      }
    : null;

  if (ai) {
    // L'IA peut seulement rendre la décision plus prudente.
    if (signal !== 'attendre' && (ai.verdict === 'REJETÉ' || ai.signal !== signal)) {
      signal = 'attendre';
      notes.push('Le plan du moteur a été rejeté par l’IA (voir son analyse).');
    }
    if (eng.signal === 'attendre' && ai.signal !== 'attendre') {
      notes.push('L’IA voyait une entrée, mais les conditions obligatoires du moteur ne sont pas remplies : on attend.');
    }
    // Ajustement des niveaux par l'IA : accepté seulement s'il reste cohérent et vérifiable.
    const n = ai.niveaux;
    if (plan && n.entree && n.stop_loss && n.tp1) {
      const long = plan.direction === 'acheter';
      const atrH1 = eng.timeframes.H1.atr14;
      const risk = Math.abs(n.entree - n.stop_loss);
      const engineRisk = Math.abs(plan.entry - plan.sl);
      const commUnit = costs.commissionPerLot / costs.contract;
      const ordered = long
        ? n.stop_loss < n.entree && n.entree < n.tp1 && (!n.tp2 || n.tp2 > n.tp1)
        : n.stop_loss > n.entree && n.entree > n.tp1 && (!n.tp2 || n.tp2 < n.tp1);
      // Le stop de l'IA ne peut pas être plus serré que celui du moteur (sinon la taille de lot grossit).
      const stopNotTighter = risk >= engineRisk - 1e-9;
      // Chaque objectif doit tomber sur un niveau de liquidité connu (tolérance 0,1 ATR H1 + spread).
      const tol = 0.1 * atrH1 + costs.spread;
      const onLiquidity = (p: number) => eng.liquidity.some(l => Math.abs(l.price - p) <= tol);
      const targetsOk = onLiquidity(n.tp1) && (!n.tp2 || onLiquidity(n.tp2));
      const rrNet = (tp: number) => (Math.abs(tp - n.entree!) - commUnit) / (risk + commUnit);
      const rr1 = rrNet(n.tp1);
      const rr2 = n.tp2 ? rrNet(n.tp2) : null;
      const changed = n.entree !== plan.entry || n.stop_loss !== plan.sl || n.tp1 !== plan.tp1 || (n.tp2 ?? null) !== plan.tp2;
      if (changed) {
        if (
          ordered &&
          stopNotTighter &&
          targetsOk &&
          Math.abs(n.entree - plan.entry) <= atrH1 &&
          risk <= 2.5 * atrH1 &&
          (rr2 ?? rr1) >= 2
        ) {
          const r = (x: number) => Number(x.toFixed(dec));
          const inside = long ? n.entree >= eng.price : n.entree <= eng.price;
          plan = {
            ...plan,
            entry: r(n.entree),
            sl: r(n.stop_loss),
            tp1: r(n.tp1),
            tp2: n.tp2 ? r(n.tp2) : null,
            rr1: Number(rr1.toFixed(2)),
            rr2: rr2 ? Number(rr2.toFixed(2)) : null,
            entryType: inside ? 'marché' : 'limite',
            origin: 'ajusté par l’IA',
          };
          notes.push('Niveaux affinés par l’IA, vérifiés par le moteur (stop pas plus serré, objectifs sur la liquidité, R:R net ≥ 1:2).');
        } else {
          const why = !stopNotTighter
            ? 'stop plus serré que celui du moteur'
            : !targetsOk
            ? 'objectif hors des niveaux de liquidité'
            : 'niveaux incohérents ou R:R net < 1:2';
          notes.push(`L’IA a proposé d’autres niveaux, refusés (${why}). Niveaux du moteur conservés.`);
        }
      }
    }
  }
  return { signal, plan, notes };
}

export class AnalysisError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface AnalysisOptions {
  pair: string;
  provider?: AiProvider | 'none' | 'auto';
  image?: { base64: string; mediaType: string };
  note?: string;
  spread?: number;
  commissionPerLot?: number;
}

const DEFAULT_COMMISSION = 7; // $ aller-retour par lot

export async function runAnalysis({ pair, provider, image, note, spread, commissionPerLot }: AnalysisOptions) {
  const info = PAIRS[pair];
  if (!info) throw new AnalysisError('Actif non supporté (EUR/USD ou XAU/USD).', 400);
  const now = Date.now();
  const costs: Costs = {
    spread: Number.isFinite(spread) && spread! >= 0 && spread! < 50 * info.pipSize ? spread! : info.defaultSpread,
    commissionPerLot: Number.isFinite(commissionPerLot) && commissionPerLot! >= 0 && commissionPerLot! <= 100 ? commissionPerLot! : DEFAULT_COMMISSION,
    contract: info.contract,
  };

  let series: Record<Timeframe, Candle[]>;
  let results;
  try {
    results = await Promise.all(TIMEFRAMES.map(tf => getSeries(pair, tf)));
    series = Object.fromEntries(results.map(r => [r.tf, r.candles])) as Record<Timeframe, Candle[]>;
  } catch (err: any) {
    throw new AnalysisError(
      `Impossible de récupérer les données de marché réelles (${err.message}). Aucune analyse n'est produite sans vraies données.`,
      502
    );
  }
  const source = results[0].source;
  const futuresProxy = results.some(r => r.futuresProxy);
  const fromStaleCache = results.some(r => r.fromStaleCache);
  const news = await getNews();

  let engine: EngineResult;
  try {
    engine = analyze(series, info.decimals, {
      now,
      spread: costs.spread,
      commissionPerLot: costs.commissionPerLot,
      contract: costs.contract,
      news,
      newsCurrencies: NEWS_CURRENCIES[pair],
    });
  } catch (err: any) {
    throw new AnalysisError(`Analyse impossible : ${err.message}`, 502);
  }

  // ----- Ordre limite et annonces : l'ordre doit être annulé 30 min avant la prochaine annonce forte -----
  let newsCut: string | null = null;
  if (engine.setup?.validUntil && engine.nextNews && engine.nextNews.t - 30 * 60_000 < engine.setup.validUntil) {
    engine.setup.validUntil = Math.max(now, engine.nextNews.t - 30 * 60_000);
    newsCut = `Ordre limite à annuler avant ${maTime(engine.setup.validUntil)} (heure du Maroc) : annonce forte ${engine.nextNews.title} (${engine.nextNews.currency}) à ${maTime(engine.nextNews.t)}.`;
  }

  // ----- Bougies japonaises (ebook) : calculées par le moteur, critère de confluence -----
  const candlePatterns: CandlePattern[] = futuresProxy ? [] : engine.ict.candlePatterns;

  // ----- Garde-fous données -----
  const warnings: string[] = [];
  const blockers: string[] = [];
  const lastT = series.M15[series.M15.length - 1].t;
  const marketIsClosed = marketClosed(now);
  if (futuresProxy) {
    blockers.push('Prix de l’or issu des futures (écart de 10 à 40 $ avec ton broker) : niveaux masqués. Ajoute la clé TWELVE_DATA_API_KEY pour le prix spot.');
  }
  if (fromStaleCache) blockers.push('La source de données ne répond plus : données des dernières minutes seulement, pas de signal.');
  if (!marketIsClosed && now - lastT > 20 * 60_000) {
    blockers.push(`Données en retard : dernière bougie à ${maTime(lastT)} (heure du Maroc). Pas de signal tant qu’elles ne sont pas à jour.`);
  }
  if (marketIsClosed) warnings.push('Marché fermé : réouverture le dimanche à 17h00 New York.');
  if (!engine.newsAvailable) warnings.push('Calendrier économique indisponible : vérifie les annonces toi-même.');

  let ai: AiReview | null = null;
  let aiError: string | null = null;
  const providers = availableProviders();
  const chosen: AiProvider | null =
    provider === 'none'
      ? null
      : provider && provider !== 'auto' && providers.includes(provider)
      ? provider
      : providers.includes('claude')
      ? 'claude'
      : providers[0] || null;
  if (chosen) {
    try {
      const img = image && typeof image.base64 === 'string' && image.base64.length < 11_000_000 ? image : undefined;
      ai = await reviewWithAi(
        chosen,
        pair,
        engine,
        compact(series.H1, 40, info.decimals),
        compact(series.M15, 48, info.decimals),
        img,
        typeof note === 'string' ? note.slice(0, 500) : undefined
      );
    } catch (err: any) {
      const msg = String(err?.message || err);
      aiError = /\b(503|429)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded/i.test(msg)
        ? `L’IA (${chosen}) est surchargée en ce moment (côté ${chosen === 'gemini' ? 'Google' : 'Anthropic'}). Réessaie dans une minute. Résultat basé uniquement sur les calculs du moteur.`
        : `L’IA (${chosen}) n’a pas répondu : ${msg.slice(0, 200)}. Résultat basé uniquement sur les calculs du moteur.`;
    }
  } else if (provider !== 'none') {
    aiError = 'Aucune clé IA configurée : résultat basé uniquement sur les calculs du moteur.';
  }

  const final = reconcile(engine, ai, info.decimals, costs);

  if (newsCut) final.notes.push(newsCut);
  if (blockers.length || marketIsClosed) {
    final.signal = 'attendre';
    final.plan = futuresProxy ? null : final.plan;
    final.notes.unshift(...blockers);
  }
  if (futuresProxy) {
    // aucun niveau en prix futures ne doit sortir de l'app
    engine.setup = null;
    engine.alternatives = [];
  }
  warnings.unshift(...blockers);
  const verdict = buildVerdict(engine, final, ai, blockers, candlePatterns);

  return {
    verdict,
    rulesVersion: RULES_VERSION,
    pair,
    label: info.label,
    decimals: info.decimals,
    pipSize: info.pipSize,
    contract: info.contract,
    costs,
    generatedAt: now,
    source,
    futuresProxy,
    warnings,
    engine,
    ai,
    aiError,
    final,
    candlePatterns,
  };
}

// ---------- Verdict final : l'action à faire, tirée uniquement de ta stratégie ----------
// La viabilité (%) n'est plus calculée ici : elle vient des trades réellement suivis dans le journal de l'app.
export const VIABILITY_THRESHOLD = 85;

export interface Verdict {
  action: 'ACHETER' | 'VENDRE' | 'ATTENDRE';
  threshold: number;
  summary: string;
  pour: string[];
  contre: string[];
}

function buildVerdict(
  engine: EngineResult,
  final: { signal: 'acheter' | 'vendre' | 'attendre'; plan: FinalPlan | null; notes: string[] },
  ai: AiReview | null,
  blockers: string[],
  patterns: CandlePattern[] = []
): Verdict {
  const pour: string[] = [];
  const contre: string[] = [];
  for (const c of engine.checklist) {
    if (c.ok) pour.push(`${c.label} — ${c.detail}`);
    else contre.push(`${c.label}${c.core ? ' (obligatoire)' : ''} — ${c.detail}`);
  }
  for (const b of blockers) contre.unshift(b);
  // Bougies japonaises : la confirmation est un critère de la checklist ; ici on signale une figure CONTRE le plan
  const setupDir = final.plan?.direction ?? engine.setup?.direction ?? null;
  if (setupDir) {
    const want = setupDir === 'acheter' ? 'haussier' : 'baissier';
    const fmtP = (p: CandlePattern) => `${p.name} en ${p.tf} à ${maTime(p.t)}${p.inZone ? ', dans la zone d’entrée' : ''}`;
    const against = patterns.filter(p => p.dir !== want);
    if (against.length) contre.push(`Bougies japonaises — ${against.map(fmtP).join(' ; ')} : figure de retournement contre le trade.`);
  }
  if (ai) {
    const l = `Relecture IA (${ai.engine}) : ${ai.verdict}. ${ai.resume}`;
    (ai.verdict === 'VALIDÉ' ? pour : contre).push(l);
  }

  const plan = final.plan;
  const take = final.signal !== 'attendre' && !!plan;
  const long = plan?.direction === 'acheter';
  const summary = take
    ? `${long ? 'Achat' : 'Vente'} : toutes les conditions obligatoires de ta stratégie sont réunies (${engine.checklist.filter(c => c.ok).length}/${engine.checklist.length} critères, qualité ${engine.grade} ${engine.score}/100${engine.grade === 'B' ? ', risque divisé par 2' : ''}). Ordre ${plan!.entryType === 'limite' ? 'limite' : 'au marché'} à ${plan!.entry}, stop ${plan!.sl}, TP1 ${plan!.tp1}${plan!.tp2 ? `, TP2 ${plan!.tp2}` : ''}.`
    : `On attend : ${final.notes[0] || engine.waitCondition || 'les conditions de ta stratégie ne sont pas réunies.'}`;
  const action: Verdict['action'] = !take ? 'ATTENDRE' : long ? 'ACHETER' : 'VENDRE';
  return { action, threshold: VIABILITY_THRESHOLD, summary, pour, contre };
}
