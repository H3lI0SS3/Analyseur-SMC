// Couche IA : l'IA INTERPRÈTE les calculs du moteur, elle ne fournit pas les données.
// Elle peut rejeter un plan ou affiner les niveaux, jamais inventer des prix ni forcer un trade.

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, Type } from '@google/genai';
import type { EngineResult } from './smc';

export type AiProvider = 'claude' | 'gemini';

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// Si un modèle est retiré par Google, on essaie automatiquement le suivant.
const GEMINI_FALLBACKS = [...new Set([GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-flash-latest'])];
let geminiWorking: string | null = null;
const isBusy = (e: any) => /\b(503|429)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand/i.test(String(e?.message || e));
const isModelGone = (e: any) => /\b404\b|not found|no longer available|is not supported/i.test(String(e?.message || e));

export function availableProviders(): AiProvider[] {
  const out: AiProvider[] = [];
  if (process.env.ANTHROPIC_API_KEY) out.push('claude');
  if (process.env.GEMINI_API_KEY) out.push('gemini');
  return out;
}

export interface AiReview {
  engine: string;
  verdict: 'VALIDÉ' | 'REJETÉ';
  signal: 'acheter' | 'vendre' | 'attendre';
  resume: string;
  contexte: string;
  liquidite: string;
  zones: string;
  plan: string;
  gestion: string;
  invalidation: string;
  lecture_capture: string | null;
  niveaux: { entree: number | null; stop_loss: number | null; tp1: number | null; tp2: number | null };
}

const SYSTEM = `Tu es un analyste senior SMC/ICT et risk manager. Tu reçois des DONNÉES DE MARCHÉ RÉELLES déjà calculées par un moteur (structure multi-timeframe, liquidité, Fair Value Gaps, Order Blocks, plan proposé avec R:R calculé).

Règles absolues :
- Tu n'inventes AUCUN prix. Tous les niveaux que tu cites doivent venir des données fournies (zones, liquidité, swings, bougies).
- Tu ne peux pas transformer un signal "attendre" du moteur en trade. Tu peux en revanche REJETER un plan du moteur si tu vois un problème (ex : entrée juste sous une liquidité majeure, contre-tendance D1, annonce, structure confuse).
- Un plan n'est VALIDÉ que si le R:R final est d'au moins 1:2, que le biais H4 est dans le sens du trade et que le stop est derrière une invalidation logique.
- Si une capture d'écran est fournie, décris ce que tu y vois dans "lecture_capture" et signale toute contradiction avec les données. Les prix de la capture peuvent venir d'un autre broker : ne les utilise pas pour fixer les niveaux.
- Sois concret, court et en français simple. Pas de jargon gratuit, pas de promesses : aucune probabilité de gain.
- Les "niveaux" que tu renvoies : reprends ceux du plan du moteur, ou propose un ajustement en t'appuyant sur une zone/liquidité fournie. Mets null si aucun trade.

Base de connaissance de l'application (à appliquer en lisant les données et la capture) :
- Structure : BOS = cassure dans le sens de la tendance ; CHoCH = première cassure contre la tendance (changement de caractère).
- Displacement : bougies impulsives à grand corps qui cassent la structure et laissent un FVG ; une zone née d'un displacement est plus fiable.
- OTE (Optimal Trade Entry) : retracement de 62 à 79 % de la jambe qui a cassé la structure ; l'entrée idéale est un FVG/OB situé dans l'OTE.
- Order Block : dernière bougie opposée avant l'impulse. Breaker Block : order block cassé suivi d'un CHoCH ; l'ancien support devient résistance (et inversement), on le joue au retest.
- Liquidité : stops au-delà des plus hauts/bas égaux, de la veille, de la semaine, du range asiatique et des trendlines de 3 touches (liquidité de trendline). Le prix va chercher cette liquidité : elle sert de cible, et son balayage (sweep) précède souvent le retournement.
- Cycle AMD : accumulation (range asiatique), manipulation (balayage d'un côté), distribution (mouvement opposé confirmé par une cassure M15).
- Bougies japonaises (ebook « Anticiper les marchés avec les bougies japonaises ») : figures de retournement valables seulement après un mouvement et idéalement dans la zone d'entrée — avalement, harami et harami en croix (doji, plus fort), structure pénétrante / couverture en nuage noir (clôture au-delà de la moitié du corps précédent), étoile du matin / du soir, bébé abandonné (bougie centrale isolée par deux gaps). Une figure contre le plan est un signal d'alerte. En forex intraday il n'y a pas de gap entre bougies : les figures à gap ne s'appliquent qu'à la réouverture.`;

const FIELDS_DESC = {
  verdict: 'VALIDÉ si le plan est exploitable tel quel, sinon REJETÉ',
  signal: 'acheter, vendre ou attendre',
  resume: '2 à 3 phrases : ce qu’il faut retenir maintenant',
  contexte: 'Biais D1/H4/H1, structure, premium/discount',
  liquidite: 'Liquidité prise, liquidité restante visée',
  zones: 'Zones d’intérêt (FVG/OB) pertinentes et pourquoi',
  plan: 'Entrée, stop, objectifs, type d’ordre, ou condition à attendre',
  gestion: 'Gestion : break-even, prises partielles, quand ne pas prendre le trade',
  invalidation: 'Ce qui invalide l’idée (prix ou événement)',
  lecture_capture: 'Lecture de la capture d’écran, ou null si pas de capture',
};

function buildUserText(pair: string, eng: EngineResult, candlesH1: string, candlesM15: string, note?: string) {
  const ctx = {
    actif: pair,
    prix_actuel: eng.price,
    heure_prix_utc: new Date(eng.priceTime).toISOString(),
    session: eng.session,
    biais: { valeur: eng.bias, detail: eng.biasDetail },
    unites_de_temps: eng.timeframes,
    range_h1: eng.dealingRange,
    liquidite: eng.liquidity,
    zones: eng.zones,
    plan_moteur: eng.setup,
    plans_alternatifs: eng.alternatives,
    checklist: eng.checklist.map(c => ({ condition: c.label, ok: c.ok, detail: c.detail, obligatoire: c.core })),
    cycle_amd: eng.amd,
    concepts_ict: { displacement: eng.ict.displacement, ote: eng.ict.ote, trendlines: eng.ict.trendlines, bougies_japonaises: eng.ict.candlePatterns },
    signal_moteur: eng.signal,
    condition_attente_moteur: eng.waitCondition,
  };
  return `Données calculées (JSON) :\n${JSON.stringify(ctx)}\n\n40 dernières bougies H1 [heure UTC, open, high, low, close] :\n${candlesH1}\n\n48 dernières bougies M15 :\n${candlesM15}\n${note ? `\nNote du trader : "${note}"\n` : ''}\nDonne ton avis structuré.`;
}

export async function reviewWithAi(
  provider: AiProvider,
  pair: string,
  eng: EngineResult,
  candlesH1: string,
  candlesM15: string,
  image?: { base64: string; mediaType: string },
  note?: string
): Promise<AiReview> {
  const text = buildUserText(pair, eng, candlesH1, candlesM15, note);
  return provider === 'claude' ? reviewClaude(text, image) : reviewGemini(text, image);
}

async function reviewClaude(text: string, image?: { base64: string; mediaType: string }): Promise<AiReview> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const content: any[] = [];
  if (image) {
    const mt = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(image.mediaType) ? image.mediaType : 'image/jpeg';
    content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: image.base64 } });
  }
  content.push({ type: 'text', text });

  const strProp = (d: string) => ({ type: 'string', description: d });
  const numOrNull = { type: ['number', 'null'] };
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2500,
    system: SYSTEM,
    tools: [
      {
        name: 'avis_trade',
        description: 'Retourne l’avis structuré sur la configuration de marché.',
        input_schema: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['VALIDÉ', 'REJETÉ'], description: FIELDS_DESC.verdict },
            signal: { type: 'string', enum: ['acheter', 'vendre', 'attendre'] },
            resume: strProp(FIELDS_DESC.resume),
            contexte: strProp(FIELDS_DESC.contexte),
            liquidite: strProp(FIELDS_DESC.liquidite),
            zones: strProp(FIELDS_DESC.zones),
            plan: strProp(FIELDS_DESC.plan),
            gestion: strProp(FIELDS_DESC.gestion),
            invalidation: strProp(FIELDS_DESC.invalidation),
            lecture_capture: { type: ['string', 'null'], description: FIELDS_DESC.lecture_capture },
            niveaux: {
              type: 'object',
              properties: { entree: numOrNull, stop_loss: numOrNull, tp1: numOrNull, tp2: numOrNull },
              required: ['entree', 'stop_loss', 'tp1', 'tp2'],
            },
          },
          required: ['verdict', 'signal', 'resume', 'contexte', 'liquidite', 'zones', 'plan', 'gestion', 'invalidation', 'lecture_capture', 'niveaux'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'avis_trade' },
    messages: [{ role: 'user', content }],
  } as any);

  const block: any = (res as any).content.find((b: any) => b.type === 'tool_use');
  if (!block) throw new Error('Réponse Claude sans résultat structuré.');
  return normalize(block.input, `Claude (${CLAUDE_MODEL})`);
}

async function reviewGemini(text: string, image?: { base64: string; mediaType: string }): Promise<AiReview> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const parts: any[] = [];
  if (image) parts.push({ inlineData: { mimeType: image.mediaType || 'image/jpeg', data: image.base64 } });
  parts.push({ text });
  const str = (d: string) => ({ type: Type.STRING, description: d });
  const num = { type: Type.NUMBER, nullable: true };
  const call = (model: string) => ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: SYSTEM,
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          verdict: { type: Type.STRING, enum: ['VALIDÉ', 'REJETÉ'] },
          signal: { type: Type.STRING, enum: ['acheter', 'vendre', 'attendre'] },
          resume: str(FIELDS_DESC.resume),
          contexte: str(FIELDS_DESC.contexte),
          liquidite: str(FIELDS_DESC.liquidite),
          zones: str(FIELDS_DESC.zones),
          plan: str(FIELDS_DESC.plan),
          gestion: str(FIELDS_DESC.gestion),
          invalidation: str(FIELDS_DESC.invalidation),
          lecture_capture: { type: Type.STRING, nullable: true, description: FIELDS_DESC.lecture_capture },
          niveaux: {
            type: Type.OBJECT,
            properties: { entree: num, stop_loss: num, tp1: num, tp2: num },
            required: ['entree', 'stop_loss', 'tp1', 'tp2'],
          },
        },
        required: ['verdict', 'signal', 'resume', 'contexte', 'liquidite', 'zones', 'plan', 'gestion', 'invalidation', 'niveaux'],
      },
    },
  });
  let res: any = null;
  let used = '';
  let lastErr: any = null;
  let goneSeen = false;
  const order = geminiWorking ? [geminiWorking, ...GEMINI_FALLBACKS.filter(m => m !== geminiWorking)] : GEMINI_FALLBACKS;
  outer: for (const model of order) {
    // 2 essais par modèle si Google est momentanément surchargé (503 / 429)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await call(model);
        used = model;
        // on ne retient un modèle de secours que si le précédent a été retiré (pas s'il était juste surchargé)
        if (goneSeen) geminiWorking = model;
        break outer;
      } catch (e) {
        lastErr = e;
        if (isModelGone(e)) {
          goneSeen = true;
          continue outer; // modèle retiré : on passe au suivant
        }
        if (!isBusy(e)) throw e; // autre erreur (clé, réseau) : on ne masque rien
        if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
  if (!res) throw lastErr;
  const raw = res.text || '';
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Réponse Gemini illisible.');
    parsed = JSON.parse(m[0]);
  }
  return normalize(parsed, `Gemini (${used})`);
}

function normalize(p: any, engine: string): AiReview {
  const s = (v: any) => (typeof v === 'string' ? v.trim() : '');
  const n = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    engine,
    verdict: s(p.verdict).toUpperCase().startsWith('VALID') ? 'VALIDÉ' : 'REJETÉ',
    signal: ['acheter', 'vendre', 'attendre'].includes(p.signal) ? p.signal : 'attendre',
    resume: s(p.resume),
    contexte: s(p.contexte),
    liquidite: s(p.liquidite),
    zones: s(p.zones),
    plan: s(p.plan),
    gestion: s(p.gestion),
    invalidation: s(p.invalidation),
    lecture_capture: s(p.lecture_capture) || null,
    niveaux: {
      entree: n(p.niveaux?.entree),
      stop_loss: n(p.niveaux?.stop_loss),
      tp1: n(p.niveaux?.tp1),
      tp2: n(p.niveaux?.tp2),
    },
  };
}
