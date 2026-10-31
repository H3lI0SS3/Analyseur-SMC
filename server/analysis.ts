// Logique d'analyse partagée entre l'interface web (/api/analyze) et le connecteur MCP.
import { PAIRS, TIMEFRAMES, getSeries, type Timeframe, type Candle } from './marketData';
import { analyze, type EngineResult } from './smc';
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

export function reconcile(eng: EngineResult, ai: AiReview | null, dec: number) {
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
      const ordered = long
        ? n.stop_loss < n.entree && n.entree < n.tp1 && (!n.tp2 || n.tp2 > n.tp1)
        : n.stop_loss > n.entree && n.entree > n.tp1 && (!n.tp2 || n.tp2 < n.tp1);
      const rr1 = Math.abs(n.tp1 - n.entree) / risk;
      const rr2 = n.tp2 ? Math.abs(n.tp2 - n.entree) / risk : null;
      const changed = n.entree !== plan.entry || n.stop_loss !== plan.sl || n.tp1 !== plan.tp1 || (n.tp2 ?? null) !== plan.tp2;
      if (changed) {
        if (
          ordered &&
          Math.abs(n.entree - plan.entry) <= atrH1 &&
          risk >= 0.3 * atrH1 &&
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
          notes.push('Niveaux affinés par l’IA, vérifiés par le moteur (ordre cohérent, stop réaliste, R:R ≥ 1:2).');
        } else {
          notes.push('L’IA a proposé d’autres niveaux, refusés car incohérents ou R:R < 1:2. Niveaux du moteur conservés.');
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
}

export async function runAnalysis({ pair, provider, image, note }: AnalysisOptions) {
  const info = PAIRS[pair];
  if (!info) throw new AnalysisError('Actif non supporté (EUR/USD ou XAU/USD).', 400);

  let series: Record<Timeframe, Candle[]>;
  let source = '';
  let sourceNote: string | undefined;
  try {
    const results = await Promise.all(TIMEFRAMES.map(tf => getSeries(pair, tf)));
    series = Object.fromEntries(results.map(r => [r.tf, r.candles])) as Record<Timeframe, Candle[]>;
    source = results[0].source;
    sourceNote = results[0].note;
  } catch (err: any) {
    throw new AnalysisError(
      `Impossible de récupérer les données de marché réelles (${err.message}). Aucune analyse n'est produite sans vraies données.`,
      502
    );
  }

  const engine = analyze(series, info.decimals);
  const warnings: string[] = [];
  if (sourceNote) warnings.push(sourceNote);
  const lastT = series.M15[series.M15.length - 1].t;
  if (Date.now() - lastT > 45 * 60_000) {
    warnings.push(`Dernière bougie reçue à ${new Date(lastT).toISOString().slice(11, 16)} UTC : données en retard ou marché fermé.`);
  }

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
      aiError = `L’IA (${chosen}) n’a pas répondu : ${String(err?.message || err).slice(0, 200)}. Résultat basé uniquement sur les calculs du moteur.`;
    }
  } else if (provider !== 'none') {
    aiError = 'Aucune clé IA configurée : résultat basé uniquement sur les calculs du moteur.';
  }

  const final = reconcile(engine, ai, info.decimals);
  return {
    pair,
    label: info.label,
    decimals: info.decimals,
    pipSize: info.pipSize,
    generatedAt: Date.now(),
    source,
    warnings,
    engine,
    ai,
    aiError,
    final,
  };
}
