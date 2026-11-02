// Contrat de sortie de Gemini : un objet « VALIDÉ » (plan complet) ou « REJETÉ » (raison + étape en échec).
// 1. responseSchema : imposé à Gemini (Structured Outputs) pour qu'il ne puisse renvoyer que ce format.
// 2. Schémas zod : revalidation côté serveur (types, champs requis selon le statut) avant tout affichage.
import { Type } from '@google/genai';
import { z } from 'zod';

export const PIPELINE_STEPS = ['htf', 'declencheur', 'zone', 'risque'] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

// ---------- 1. Schéma imposé à Gemini ----------
// Un seul objet (Gemini gère mal les unions) : les champs du plan sont « nullable » et deviennent
// obligatoires côté serveur quand statut = VALIDÉ.
const num = { type: Type.NUMBER, nullable: true };
const step = (d: string) => ({
  type: Type.OBJECT,
  properties: { ok: { type: Type.BOOLEAN }, detail: { type: Type.STRING, description: d } },
  required: ['ok', 'detail'],
});

export const GEMINI_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    statut: { type: Type.STRING, enum: ['VALIDÉ', 'REJETÉ'] },
    etape_echec: { type: Type.STRING, enum: [...PIPELINE_STEPS], nullable: true, description: 'Première étape en échec (fail-fast), null si VALIDÉ' },
    raison: { type: Type.STRING, description: 'Une à deux phrases : pourquoi le plan est validé ou rejeté' },
    symbole: { type: Type.STRING },
    timeframe: { type: Type.STRING, enum: ['M15'] },
    direction: { type: Type.STRING, enum: ['BUY', 'SELL'], nullable: true },
    entree: num,
    stop_loss: num,
    take_profit: num,
    rr: { ...num, description: 'R:R net = (|TP − entrée| − spread) / (|entrée − SL| + spread)' },
    fvg: {
      type: Type.OBJECT,
      nullable: true,
      properties: { haut: { type: Type.NUMBER }, bas: { type: Type.NUMBER }, position_vague: { type: Type.NUMBER, description: '0 = bas de la vague, 1 = haut' } },
      required: ['haut', 'bas', 'position_vague'],
    },
    etapes: {
      type: Type.OBJECT,
      properties: {
        htf: step('Zone clé HTF ou liquidité externe d’où vient le prix'),
        declencheur: step('Sweep → displacement → CHoCH, avec les heures UTC'),
        zone: step('FVG de l’impulsion et position premium/discount dans la vague'),
        risque: step('Stop derrière le sweep + buffer, TP sur la liquidité opposée, R:R'),
      },
      required: [...PIPELINE_STEPS],
    },
  },
  required: ['statut', 'etape_echec', 'raison', 'symbole', 'timeframe', 'direction', 'entree', 'stop_loss', 'take_profit', 'rr', 'fvg', 'etapes'],
  propertyOrdering: ['statut', 'etape_echec', 'raison', 'symbole', 'timeframe', 'direction', 'entree', 'stop_loss', 'take_profit', 'rr', 'fvg', 'etapes'],
};

// ---------- 2. Validation stricte côté serveur ----------
const price = z.number().finite().positive();
const stepZ = z.object({ ok: z.boolean(), detail: z.string().min(1).max(600) });
const stepsZ = z.object({ htf: stepZ, declencheur: stepZ, zone: stepZ, risque: stepZ });

export const ValidatedSchema = z
  .object({
    statut: z.literal('VALIDÉ'),
    etape_echec: z.null(),
    raison: z.string().min(1).max(600),
    symbole: z.string().min(3),
    timeframe: z.literal('M15'),
    direction: z.enum(['BUY', 'SELL']),
    entree: price,
    stop_loss: price,
    take_profit: price,
    rr: z.number().finite().positive(),
    fvg: z.object({ haut: price, bas: price, position_vague: z.number().min(0).max(1) }),
    etapes: stepsZ,
  })
  .superRefine((v, ctx) => {
    const buy = v.direction === 'BUY';
    if (buy ? !(v.stop_loss < v.entree && v.entree < v.take_profit) : !(v.stop_loss > v.entree && v.entree > v.take_profit))
      ctx.addIssue({ code: 'custom', message: 'Niveaux dans le mauvais ordre pour la direction (SL / entrée / TP).' });
    if (v.fvg.haut <= v.fvg.bas) ctx.addIssue({ code: 'custom', message: 'FVG inversé (haut ≤ bas).' });
    if (!PIPELINE_STEPS.every(s => v.etapes[s].ok)) ctx.addIssue({ code: 'custom', message: 'VALIDÉ alors qu’une étape est en échec.' });
  });

export const RejectedSchema = z.object({
  statut: z.literal('REJETÉ'),
  etape_echec: z.enum(PIPELINE_STEPS),
  raison: z.string().min(1).max(600),
  symbole: z.string().min(3),
  timeframe: z.literal('M15'),
  direction: z.enum(['BUY', 'SELL']).nullable(),
  entree: price.nullable(),
  stop_loss: price.nullable(),
  take_profit: price.nullable(),
  rr: z.number().finite().nullable(),
  fvg: z.object({ haut: price, bas: price, position_vague: z.number().min(0).max(1) }).nullable(),
  etapes: stepsZ,
});

export const PipelineResultSchema = z.discriminatedUnion('statut', [ValidatedSchema, RejectedSchema]);
export type PipelineValidated = z.infer<typeof ValidatedSchema>;
export type PipelineRejected = z.infer<typeof RejectedSchema>;
export type PipelineResult = z.infer<typeof PipelineResultSchema>;

export type ParseOutcome = { ok: true; value: PipelineResult } | { ok: false; error: string };

/** Lecture tolérante du texte renvoyé (JSON pur, ou JSON entouré de texte / balises ```), puis validation stricte. */
export function parsePipelineJson(raw: string): ParseOutcome {
  let data: unknown;
  const text = (raw || '').trim();
  try {
    data = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, error: 'Réponse de Gemini sans JSON.' };
    try {
      data = JSON.parse(m[0]);
    } catch {
      return { ok: false, error: 'JSON de Gemini illisible.' };
    }
  }
  // tolérance : un nombre envoyé en texte ("3912.5") est converti, rien d'autre n'est corrigé
  if (data && typeof data === 'object') {
    for (const k of ['entree', 'stop_loss', 'take_profit', 'rr'] as const) {
      const v = (data as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) (data as Record<string, unknown>)[k] = Number(v);
    }
  }
  const res = PipelineResultSchema.safeParse(data);
  if (!res.success) {
    const first = res.error.issues[0];
    return { ok: false, error: `JSON de Gemini non conforme : ${first ? `${first.path.join('.') || 'objet'} — ${first.message}` : 'format inattendu'}.` };
  }
  return { ok: true, value: res.data };
}
