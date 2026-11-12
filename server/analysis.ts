// Logique d'analyse partagée entre l'interface web (/api/analyze) et le connecteur MCP.
import { PAIRS, TIMEFRAMES, getLivePrice, getM5, getSeries, withLivePrice, type Timeframe, type Candle } from './marketData';
import { M5_EXECUTION_PAIRS, applyExecution } from './execution';
import { sessionProfiles } from './volumeProfile';
import { getNews, NEWS_CURRENCIES } from './news';
import type { CandlePattern } from './candlePatterns';
import { auditEngine } from './audit';
import { getJournalStore } from './journalStore';
import { marketClosed, maTime } from './time';
import { analyze, PD_OPTIONAL_PAIRS, RULES_VERSION, type EngineResult } from './smc';
/** Délai maximal de la relecture IA (au-delà, le prix « en direct » vieillit et l'analyse paraît bloquée). */
export const AI_TIMEOUT_MS = 35_000;
import { availableProviders, reviewWithAi, type AiProvider, type AiReview } from './ai';
import { runPipeline, PIPELINE_TIMEOUT_MS, type PipelineReport } from './pipeline';

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
      // L'entrée reste celle de la zone du moteur (checklist, OTE et score sont calculés dessus) :
      // l'IA peut seulement élargir le stop et déplacer les objectifs sur de la liquidité.
      const r = (x: number) => Number(x.toFixed(dec));
      const sameEntry = Math.abs(n.entree - plan.entry) <= 2 * Math.pow(10, -dec);
      const riskR = Math.abs(plan.entry - r(n.stop_loss));
      const rrNet = (tp: number) => (Math.abs(r(tp) - plan!.entry) - commUnit) / (riskR + commUnit);
      const rr1 = rrNet(n.tp1);
      const rr2 = n.tp2 ? rrNet(n.tp2) : null;
      const changed = !sameEntry || r(n.stop_loss) !== plan.sl || r(n.tp1) !== plan.tp1 || (n.tp2 ? r(n.tp2) : null) !== plan.tp2;
      if (changed) {
        if (sameEntry && ordered && stopNotTighter && targetsOk && risk <= 2.5 * atrH1 && (rr2 ?? rr1) >= 2) {
          plan = {
            ...plan,
            sl: r(n.stop_loss),
            tp1: r(n.tp1),
            tp2: n.tp2 ? r(n.tp2) : null,
            rr1: Number(rr1.toFixed(2)),
            rr2: rr2 ? Number(rr2.toFixed(2)) : null,
            origin: 'ajusté par l’IA',
          };
          notes.push('Stop et objectifs affinés par l’IA, vérifiés par le moteur (stop pas plus serré, objectifs sur la liquidité, R:R net ≥ 1:2).');
        } else {
          const why = !sameEntry
            ? 'entrée hors de la zone du moteur'
            : !stopNotTighter
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
  let livePriceAt: number | null = null;
  let results;
  try {
    // Analyse : M15 rechargé s'il a plus de 30 s, et prix en direct pour la bougie en cours
    const [res, live] = await Promise.all([Promise.all(TIMEFRAMES.map(tf => getSeries(pair, tf, tf === 'M15' ? 30_000 : undefined))), getLivePrice(pair)]);
    results = res;
    series = Object.fromEntries(results.map(r => [r.tf, r.candles])) as Record<Timeframe, Candle[]>;
    if (!results.some(r => r.futuresProxy)) series.M15 = withLivePrice(series.M15, live);
    livePriceAt = live?.at ?? null;
  } catch (err: any) {
    throw new AnalysisError(
      `Impossible de récupérer les données de marché réelles (${err.message}). Aucune analyse n'est produite sans vraies données.`,
      424
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
      pdOptional: PD_OPTIONAL_PAIRS.has(pair),
    });
  } catch (err: any) {
    throw new AnalysisError(`Analyse impossible : ${err.message}`, 424);
  }

  // ----- Ordre limite et annonces : l'ordre doit être annulé 30 min avant la prochaine annonce forte -----
  let newsCut: string | null = null;
  if (engine.setup?.validUntil && engine.nextNews && engine.nextNews.t - 30 * 60_000 < engine.setup.validUntil) {
    engine.setup.validUntil = Math.max(now, engine.nextNews.t - 30 * 60_000);
    newsCut = `Ordre limite à annuler avant ${maTime(engine.setup.validUntil)} (heure du Maroc) : annonce forte ${engine.nextNews.title} (${engine.nextNews.currency}) à ${maTime(engine.nextNews.t)}.`;
  }
  // même règle pour le signal d'entraînement (TEST) : jamais d'ordre ouvert pendant l'annonce
  const tr = engine.training?.setup;
  if (tr?.validUntil && engine.nextNews && engine.nextNews.t - 30 * 60_000 < tr.validUntil) tr.validUntil = Math.max(now, engine.nextNews.t - 30 * 60_000);
  if (engine.training && tr?.validUntil !== undefined && tr.validUntil <= now) engine.training = null;

  // ----- Bougies japonaises (ebook) : calculées par le moteur, critère de confluence -----
  const candlePatterns: CandlePattern[] = futuresProxy ? [] : engine.ict.candlePatterns;

  // ----- Contrôle de cohérence : aucune analyse contradictoire ne peut produire un trade -----
  const incoherences = auditEngine(engine, { now, series, spread: costs.spread, commissionPerLot: costs.commissionPerLot, contract: costs.contract });
  if (incoherences.length) console.error(`[Cohérence ${pair}] ${incoherences.join(' | ')}`);

  // ----- Garde-fous données -----
  const warnings: string[] = [];
  const blockers: string[] = [];
  const lastT = series.M15[series.M15.length - 1].t;
  const marketIsClosed = marketClosed(now);
  if (futuresProxy) {
    blockers.push(results.some(r => r.fallback)
      ? 'Twelve Data épuisé et écart futures/spot de l’or inconnu : niveaux masqués (écart de 10 à 40 $ avec ton broker). L’or redevient disponible à minuit UTC ; EUR/USD fonctionne en secours.'
      : 'Prix de l’or issu des futures (écart de 10 à 40 $ avec ton broker) : niveaux masqués. Ajoute la clé TWELVE_DATA_API_KEY pour le prix spot.');
  }
  if (incoherences.length) blockers.push(`Incohérence détectée dans l’analyse (${incoherences[0]}) : pas de signal par sécurité.`);
  if (fromStaleCache) blockers.push('La source de données ne répond plus : données des dernières minutes seulement, pas de signal.');
  if (!marketIsClosed && now - lastT > 20 * 60_000) {
    blockers.push(`Données en retard : dernière bougie à ${maTime(lastT)} (heure du Maroc). Pas de signal tant qu’elles ne sont pas à jour.`);
  }
  if (results.some(r => r.fallback)) {
    const gold = results.find(r => r.basis !== undefined && r.basis !== null);
    warnings.push(
      `Données de secours Yahoo Finance (Twelve Data épuisé ou en panne) : pas de prix en direct${
        gold ? `, or recalé sur le spot (écart futures −${gold.basis!.toFixed(2)} $)` : ''
      }. Recale toujours avec le prix de ton broker avant d’entrer.`
    );
  }
  if (marketIsClosed) warnings.push('Marché fermé : réouverture le dimanche à 17h00 New York.');
  if (!engine.newsAvailable) warnings.push('Calendrier économique indisponible : vérifie les annonces toi-même.');
  if (engine.tentativeNews.length) warnings.push(`Annonce forte aujourd’hui sans horaire confirmé : ${engine.tentativeNews.join(', ')}. Vérifie l’heure sur ForexFactory avant d’entrer.`);

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
  let pipeline: PipelineReport | null = null;
  if (chosen === 'gemini' && !futuresProxy && !image) {
    // Gemini : pipeline SMC strict en JSON structuré, recontrôlé par le serveur (double validation)
    pipeline = await runPipeline({ symbol: pair, decimals: info.decimals, now, series, engine, costs, timeoutMs: PIPELINE_TIMEOUT_MS });
    // (l'indisponibilité est affichée dans la carte du pipeline, pas en double dans « Lecture de l'IA »)
  } else if (chosen) {
    try {
      const img = image && typeof image.base64 === 'string' && image.base64.length < 11_000_000 ? image : undefined;
      // l'IA ne doit jamais bloquer l'analyse : au-delà de AI_TIMEOUT_MS on rend le résultat du moteur seul
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('TIMEOUT_IA')), AI_TIMEOUT_MS); });
      ai = await Promise.race([reviewWithAi(
        chosen,
        pair,
        engine,
        compact(series.H1, 40, info.decimals),
        compact(series.M15, 48, info.decimals),
        img,
        typeof note === 'string' ? note.slice(0, 500) : undefined
      ), timeout]).finally(() => clearTimeout(timer));
    } catch (err: any) {
      const msg = String(err?.message || err);
      aiError = msg === 'TIMEOUT_IA'
        ? `L’IA (${chosen}) a mis plus de ${AI_TIMEOUT_MS / 1000} s à répondre : résultat basé uniquement sur les calculs du moteur (le verdict de ta stratégie n’en dépend pas).`
        : /\b(503|429)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded/i.test(msg)
        ? `L’IA (${chosen}) est surchargée en ce moment (côté ${chosen === 'gemini' ? 'Google' : 'Anthropic'}). Réessaie dans une minute. Résultat basé uniquement sur les calculs du moteur.`
        : `L’IA (${chosen}) n’a pas répondu : ${msg.slice(0, 200)}. Résultat basé uniquement sur les calculs du moteur.`;
    }
  } else if (provider !== 'none') {
    aiError = 'Aucune clé IA configurée : résultat basé uniquement sur les calculs du moteur.';
  }

  const final = reconcile(engine, ai, info.decimals, costs);
  // Double validation : un trade du moteur refusé par le pipeline Gemini (ou par le contrôle serveur) n'est pas pris.
  if (pipeline && final.signal !== 'attendre' && pipeline.status === 'REJETÉ') {
    final.signal = 'attendre';
    final.notes.unshift(`Pipeline Gemini : ${pipeline.message}`);
  }
  if (pipeline?.status === 'INDISPONIBLE' && final.signal !== 'attendre') warnings.push(pipeline.message);

  if (newsCut) final.notes.push(newsCut);
  // mode entraînement : jamais sur données douteuses, prix futures ou marché fermé
  if (blockers.length || marketIsClosed || futuresProxy) engine.training = null;
  if (blockers.length || marketIsClosed) {
    final.signal = 'attendre';
    final.plan = futuresProxy ? null : final.plan;
    final.notes.unshift(...blockers);
  }

  // ----- Exécution affinée M5 (or) et actifs en pause -----
  const needM5 = final.signal !== 'attendre' && !!final.plan && !!engine.setup && !!engine.trigger && M5_EXECUTION_PAIRS.has(pair);
  const m5raw = needM5 ? await getM5(pair) : null;
  const { execution, paused } = applyExecution(pair, engine, final, m5raw, now, costs, info.decimals);
  if (paused) warnings.push(paused);

  if (futuresProxy) {
    // aucun niveau en prix futures ne doit sortir de l'app
    engine.setup = null;
    engine.alternatives = [];
  }
  warnings.unshift(...blockers);
  const verdict = buildVerdict(engine, final, ai, blockers, candlePatterns, pipeline, newsCut);

  // ----- Journal automatique : on garde la trace de chaque signal proposé (protocole ou TEST) -----
  // pour rapprocher ensuite tes positions cTrader du plan qui les a déclenchées. Jamais bloquant.
  if (!futuresProxy && !blockers.length) {
    const rec = (kind: 'protocole' | 'test', p: { direction: 'acheter' | 'vendre'; entry: number; sl: number; tp1: number | null; tp2?: number | null; validUntil?: number; zoneId?: string; zoneLabel?: string }) =>
      getJournalStore()
        .addSignal({
          id: `${kind}|${pair}|${p.direction}|${p.zoneId ?? p.entry}`,
          pair,
          kind,
          direction: p.direction,
          entry: p.entry,
          sl: p.sl,
          tp1: p.tp1 ?? null,
          tp2: p.tp2 ?? null,
          at: now,
          validUntil: p.validUntil ?? null,
          zone: p.zoneLabel ?? null,
        })
        .catch(() => false);
    if (final.signal !== 'attendre' && final.plan) rec('protocole', { ...final.plan, validUntil: engine.setup?.validUntil, zoneId: engine.setup?.zoneId, zoneLabel: engine.setup?.zoneLabel } as any);
    else if (engine.training?.ready) rec('test', engine.training.setup as any);
  }

  return {
    verdict,
    rulesVersion: RULES_VERSION,
    livePriceAt,
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
    pipeline,
    final,
    candlePatterns,
    execution,
    paused,
    // volume profile en ticks (cTrader uniquement) : information, n'entre pas dans le verdict
    volumeProfile: sessionProfiles(series.M15, series.M15[series.M15.length - 1].c, pair === 'XAU/USD' ? 0.5 : info.pipSize, now),
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
  patterns: CandlePattern[] = [],
  pipeline: PipelineReport | null = null,
  newsCut: string | null = null
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
  if (pipeline && pipeline.status !== 'INDISPONIBLE') {
    const l = `Pipeline Gemini (${pipeline.model}) : ${pipeline.status}. ${pipeline.message}`;
    (pipeline.status === 'VALIDÉ' ? pour : contre).push(l);
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
    : // la vraie raison d'attendre d'abord ; l'annulation avant annonce n'est qu'une précision (sinon : « Attendre » + « ordre à annuler », incohérent)
      `On attend : ${final.notes.find(n => n !== newsCut) || engine.waitCondition || 'les conditions de ta stratégie ne sont pas réunies.'}${newsCut ? ` ${newsCut.replace('Ordre limite à annuler', 'Si le setup se valide, ordre limite à annuler')}` : ''}`;
  const confirmation = !take || !pipeline ? '' : pipeline.status === 'VALIDÉ' ? ' Plan confirmé par le pipeline Gemini.' : ' Pipeline Gemini indisponible : plan du moteur seul, vérifie-le toi-même.';
  const action: Verdict['action'] = !take ? 'ATTENDRE' : long ? 'ACHETER' : 'VENDRE';
  return { action, threshold: VIABILITY_THRESHOLD, summary: summary + confirmation, pour, contre };
}
