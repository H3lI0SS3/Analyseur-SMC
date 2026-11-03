// Appel à Google AI Studio (Gemini) en Structured Outputs, avec délai maximal, modèles de secours,
// nouvelle tentative si Google est surchargé, et validation stricte du JSON reçu.
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { GEMINI_FALLBACKS, isBusy, isModelGone } from '../ai';
import type { MarketPayload } from './payload';
import { GEMINI_RESPONSE_SCHEMA, parsePipelineJson, type PipelineResult } from './schema';

export const PIPELINE_TIMEOUT_MS = 30_000;

export const PIPELINE_SYSTEM = `Tu es le moteur de décision SMC/ICT de l'application ISMC. Tu appliques un pipeline séquentiel STRICT, en fail-fast : dès qu'une étape échoue, tu t'arrêtes et tu renvoies statut "REJETÉ" avec etape_echec = cette étape.

Données : fenêtres OHLCV en heure UTC (bougies clôturées ; "current" = bougie en cours, à ne jamais utiliser comme structure) et "facts" calculés par un moteur déterministe. Le volume est indisponible sur le forex OTC : juge le displacement sur la taille du corps et la clôture près de l'extrême.

Étape 1 — htf : le prix doit provenir d'une zone clé HTF (Order Block ou FVG H1/H4 de facts.htfZones) ou d'une liquidité externe (facts.liquidity : veille, semaine, Asie, égaux, swings H4/D1), et le trade doit aller dans le sens de facts.bias. Prix « au milieu de nulle part » ou biais neutre : REJETÉ.
Étape 2 — declencheur (M15) : dans cet ordre, (a) sweep : mèche au-delà d'un sommet/creux puis clôture revenue, (b) displacement : bougie impulsive nette dans le sens du trade, (c) CHoCH : clôture au-delà du dernier swing opposé. Si une bougie clôture au-delà de l'extrême du sweep après le CHoCH : REJETÉ.
Étape 3 — zone : un FVG créé par l'impulsion. position_vague = (milieu du FVG − bas de la vague) / (haut − bas). BUY seulement si position_vague < 0,5 (discount), SELL seulement si > 0,5 (premium).
Étape 4 — risque : entrée au début du FVG ; stop derrière l'extrême du sweep + rules.slBuffer (+ spread pour un SELL) ; TP placé un spread avant la liquidité opposée non prise ; rr = (|TP − entrée| − rules.commissionPerUnit) / (|entrée − SL| + rules.commissionPerUnit) (le spread est déjà dans le stop et le TP). rr < rules.minRR : REJETÉ.

Règles absolues :
- N'invente AUCUN prix : entrée, SL, TP et FVG viennent des bougies fournies ou des facts.
- facts.newsBlocked = true : REJETÉ à l'étape htf (« annonce imminente »).
- enginePlan = plan calculé par le moteur déterministe. S'il existe, tu valides ou rejettes CE plan : tu reprends exactement sa direction, son entrée, son stop, son TP et son rr (ne propose pas d'autres niveaux). S'il est null, il n'y a pas de plan exploitable : REJETÉ à la première étape qui manque (en général « declencheur »).
- Si facts.engineTrigger est null, il n'y a très probablement pas de déclencheur : ne le valide que si tu le vois sans ambiguïté dans les bougies M15.
- Chaque étape : ok + détail court en français, avec les prix et heures UTC utilisés. Les étapes non atteintes : ok=false, détail "non évaluée (fail-fast)".
- Si statut = "VALIDÉ" : etape_echec = null, tous les champs du plan sont remplis. Si "REJETÉ" : renseigne au moins etape_echec et raison.`;

/** Fonction d'appel bas niveau (remplaçable en test). Renvoie le texte JSON brut. */
export type GeminiCall = (req: { model: string; system: string; user: string; signal: AbortSignal }) => Promise<string>;

/** Réflexion réduite : sans ça, Gemini dépasse souvent 30 s sur ce payload. Désactivée si le modèle la refuse. */
let thinkingSupported = true;

const defaultCall: GeminiCall = async ({ model, system, user, signal }) => {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const run = (withThinking: boolean) =>
    ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: user }] }],
      config: {
        systemInstruction: system,
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_RESPONSE_SCHEMA as any,
        abortSignal: signal,
        ...(withThinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
      },
    });
  let res;
  try {
    res = await run(thinkingSupported);
  } catch (e: any) {
    if (!thinkingSupported || !/thinking/i.test(String(e?.message || e))) throw e;
    thinkingSupported = false;
    res = await run(false);
  }
  return res.text ?? '';
};

export type PipelineCallOutcome =
  | { status: 'ok'; result: PipelineResult; model: string; latencyMs: number }
  | { status: 'indisponible'; reason: 'pas_de_cle' | 'timeout' | 'surcharge' | 'json_invalide' | 'erreur'; detail: string; latencyMs: number };

export interface PipelineCallOptions {
  timeoutMs?: number;
  models?: string[];
  call?: GeminiCall;
  apiKeyPresent?: boolean;
}

/** Délai maximal + annulation de la requête en cours. */
async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      ctl.abort();
      rej(new Error('TIMEOUT_PIPELINE'));
    }, ms);
  });
  try {
    return await Promise.race([run(ctl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function buildUserPrompt(p: MarketPayload): string {
  return `Analyse ${p.symbol} (heure de génération ${p.generatedAtUtc}). Applique le pipeline et réponds uniquement avec l'objet JSON.\n${JSON.stringify(p)}`;
}

/** Envoie le payload à Gemini et renvoie un résultat validé, ou une indisponibilité explicite (jamais d'exception). */
export async function runGeminiPipeline(payload: MarketPayload, opts: PipelineCallOptions = {}): Promise<PipelineCallOutcome> {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  if (!(opts.apiKeyPresent ?? !!process.env.GEMINI_API_KEY) && !opts.call) {
    return { status: 'indisponible', reason: 'pas_de_cle', detail: 'Aucune clé GEMINI_API_KEY configurée.', latencyMs: 0 };
  }
  const call = opts.call ?? defaultCall;
  const models = opts.models ?? GEMINI_FALLBACKS;
  const user = buildUserPrompt(payload);
  try {
    return await withTimeout(opts.timeoutMs ?? PIPELINE_TIMEOUT_MS, async signal => {
      let lastErr: unknown = null;
      for (const model of models) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const raw = await call({ model, system: PIPELINE_SYSTEM, user, signal });
            const parsed = parsePipelineJson(raw);
            if ('error' in parsed) {
              // une seconde chance seulement : un JSON non conforme ne se corrige pas en insistant
              lastErr = new Error(`JSON_INVALIDE:${parsed.error}`);
              if (attempt === 0) continue;
              return { status: 'indisponible', reason: 'json_invalide', detail: parsed.error, latencyMs: ms() } as const;
            }
            return { status: 'ok', result: parsed.value, model, latencyMs: ms() } as const;
          } catch (e) {
            if (signal.aborted) throw e;
            lastErr = e;
            if (isModelGone(e)) break; // modèle retiré : suivant
            if (!isBusy(e)) throw e;
            if (attempt === 0) await new Promise(r => setTimeout(r, 1_500));
          }
        }
      }
      throw lastErr ?? new Error('Aucun modèle Gemini disponible.');
    });
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg === 'TIMEOUT_PIPELINE' || e?.name === 'AbortError')
      return { status: 'indisponible', reason: 'timeout', detail: `Gemini n’a pas répondu en ${(opts.timeoutMs ?? PIPELINE_TIMEOUT_MS) / 1000} s.`, latencyMs: ms() };
    if (msg.startsWith('JSON_INVALIDE:')) return { status: 'indisponible', reason: 'json_invalide', detail: msg.slice(14), latencyMs: ms() };
    if (isBusy(e)) return { status: 'indisponible', reason: 'surcharge', detail: 'Gemini est surchargé (côté Google).', latencyMs: ms() };
    return { status: 'indisponible', reason: 'erreur', detail: msg.slice(0, 200), latencyMs: ms() };
  }
}
