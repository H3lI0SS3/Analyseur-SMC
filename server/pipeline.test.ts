// Pipeline Gemini : payload, schéma JSON, appel avec délai/erreurs, contrôle serveur. npx tsx server/pipeline.test.ts
import oct30 from './fixtures/real-2026-10-30.json';
import { analyze } from './smc';
import type { Candle, Timeframe } from './marketData';
import { buildMarketPayload, estimateTokens } from './pipeline/payload';
import { parsePipelineJson, type PipelineValidated } from './pipeline/schema';
import { runGeminiPipeline, type GeminiCall } from './pipeline/gemini';
import { netRR, verifyPipeline } from './pipeline/guard';
import { runPipeline } from './pipeline';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const conv = (rows: any[]): Candle[] => rows.map(([d, o, h, l, c]) => ({ t: Date.parse(d.replace(' ', 'T') + ':00Z'), o, h, l, c }));
const all = Object.fromEntries(Object.entries((oct30 as any)['XAU/USD']).map(([k, v]) => [k, conv(v as any[])])) as Record<Timeframe, Candle[]>;
const now = Date.parse('2026-10-30T06:46:00Z');
const series = Object.fromEntries((['M15', 'H1', 'H4', 'D1'] as Timeframe[]).map(tf => [tf, all[tf].filter(c => c.t <= now)])) as Record<Timeframe, Candle[]>;
const costs = { spread: 0.24, commissionPerLot: 0, contract: 100 };
const engine = analyze(series, 2, { now, ...costs, news: { available: true, events: [] }, newsCurrencies: ['USD'] });
// cible lointaine pour un R:R ≥ 2,5 (ce jour-là, la liquidité proche ne donnait que 1:1,7 — c'est pour tester le contrôle)
engine.liquidity.push({ id: 'PWL-test', label: 'Plus bas semaine précédente (PWL)', price: +(engine.setup!.entry - 60).toFixed(2), side: 'sell', swept: false });

(async () => {
  // ---------- 1. Payload ----------
  {
    const p = buildMarketPayload({ symbol: 'XAU/USD', decimals: 2, now, spread: 0.24, series, engine });
    const m15 = p.windows.find(w => w.tf === 'M15')!;
    ok('Fenêtres HTF + LTF présentes', p.windows.map(w => w.tf).join() === 'H4,H1,M15');
    ok('Bougie en cours séparée des bougies clôturées', !!m15.current && m15.bars.every(b => Date.parse(b[0].replace(' ', 'T') + ':00Z') + 900_000 <= now), m15.current?.[0]);
    ok('Budget de tokens respecté', estimateTokens(p) <= 6000, `${estimateTokens(p)} tokens`);
    ok('Volume absent signalé (forex OTC)', p.volumeAvailable === false);
    ok('Faits du moteur joints (déclencheur, liquidité, zones HTF)', !!p.facts.engineTrigger && p.facts.liquidity.length > 0 && p.facts.htfZones.length > 0);
    ok('R:R minimal transmis = 2,5', p.rules.minRR === 2.5);
    const small = buildMarketPayload({ symbol: 'XAU/USD', decimals: 2, now, spread: 0.24, series, engine, maxTokens: 3000 });
    ok('Budget serré : fenêtres raccourcies, jamais sous 24 bougies HTF', estimateTokens(small) < estimateTokens(p) && small.windows.every(w => w.bars.length >= (w.role === 'HTF' ? 24 : 48) || w.bars.length < 24), small.windows.map(w => `${w.tf}:${w.bars.length}`).join(' '));
  }

  // ---------- 2. Schéma JSON ----------
  const tr = engine.trigger!;
  const entry = engine.setup!.entry;
  const sl = engine.setup!.sl;
  const target = engine.liquidity.filter(l => !l.swept && l.side === 'sell' && l.price < entry).sort((a, b) => b.price - a.price).find(l => netRR('SELL', entry, sl, l.price + 0.24, 0.24, 0) >= 2.5)!;
  const tp = +(target.price + 0.24).toFixed(2);
  const zone = engine.zones.find(z => z.id === engine.setup!.zoneId)!;
  const pos = ((zone.top + zone.bottom) / 2 - tr.legLow) / (tr.legHigh - tr.legLow);
  const steps = { htf: { ok: true, detail: 'x' }, declencheur: { ok: true, detail: 'x' }, zone: { ok: true, detail: 'x' }, risque: { ok: true, detail: 'x' } };
  const good: PipelineValidated = {
    statut: 'VALIDÉ', etape_echec: null, raison: 'Sweep du swing high puis CHoCH baissier.', symbole: 'XAU/USD', timeframe: 'M15', direction: 'SELL',
    entree: entry, stop_loss: sl, take_profit: tp, rr: +netRR('SELL', entry, sl, tp, 0.24, 0).toFixed(2),
    fvg: { haut: zone.top, bas: zone.bottom, position_vague: +pos.toFixed(2) }, etapes: steps,
  };
  {
    ok('JSON VALIDÉ conforme accepté', parsePipelineJson(JSON.stringify(good)).ok);
    ok('JSON entouré de ```json accepté', parsePipelineJson('```json\n' + JSON.stringify(good) + '\n```').ok);
    ok('Nombre envoyé en texte converti', parsePipelineJson(JSON.stringify({ ...good, entree: String(good.entree) })).ok);
    const rej = { statut: 'REJETÉ', etape_echec: 'htf', raison: 'Milieu de nulle part.', symbole: 'XAU/USD', timeframe: 'M15', direction: null, entree: null, stop_loss: null, take_profit: null, rr: null, fvg: null, etapes: { ...steps, htf: { ok: false, detail: 'aucune zone' } } };
    ok('JSON REJETÉ conforme accepté', parsePipelineJson(JSON.stringify(rej)).ok);
    ok('VALIDÉ sans entrée : refusé', !parsePipelineJson(JSON.stringify({ ...good, entree: null })).ok);
    ok('VALIDÉ avec niveaux dans le mauvais ordre : refusé', !parsePipelineJson(JSON.stringify({ ...good, stop_loss: entry - 5 })).ok);
    ok('VALIDÉ avec une étape en échec : refusé', !parsePipelineJson(JSON.stringify({ ...good, etapes: { ...steps, zone: { ok: false, detail: 'x' } } })).ok);
    ok('REJETÉ sans étape en échec : refusé', !parsePipelineJson(JSON.stringify({ ...rej, etape_echec: null })).ok);
    ok('Texte libre : refusé', !parsePipelineJson('Je pense qu’il faut vendre.').ok);
    ok('Statut inconnu : refusé', !parsePipelineJson(JSON.stringify({ ...good, statut: 'PEUT-ÊTRE' })).ok);
  }

  // ---------- 3. Appel API : délai, surcharge, JSON invalide ----------
  {
    const p = buildMarketPayload({ symbol: 'XAU/USD', decimals: 2, now, spread: 0.24, series, engine });
    const never: GeminiCall = () => new Promise(() => {});
    const t = await runGeminiPipeline(p, { call: never, timeoutMs: 80 });
    ok('Délai dépassé : INDISPONIBLE (timeout), sans exception', t.status === 'indisponible' && t.reason === 'timeout');
    let n = 0;
    const busyThenOk: GeminiCall = async () => {
      if (n++ === 0) throw new Error('503 UNAVAILABLE');
      return JSON.stringify(good);
    };
    const b = await runGeminiPipeline(p, { call: busyThenOk, models: ['m1'], timeoutMs: 5000 });
    ok('Surcharge puis réponse : nouvelle tentative réussie', b.status === 'ok' && n === 2);
    let m = 0;
    const gone: GeminiCall = async ({ model }) => {
      m++;
      if (model === 'old') throw new Error('404 model not found');
      return JSON.stringify(good);
    };
    const g = await runGeminiPipeline(p, { call: gone, models: ['old', 'new'], timeoutMs: 5000 });
    ok('Modèle retiré : bascule sur le modèle de secours', g.status === 'ok' && g.status === 'ok' && (g as any).model === 'new' && m === 2);
    const bad = await runGeminiPipeline(p, { call: async () => '{"statut":"VALIDÉ"}', models: ['m1'], timeoutMs: 5000 });
    ok('JSON non conforme deux fois : INDISPONIBLE (json_invalide)', bad.status === 'indisponible' && bad.reason === 'json_invalide');
    const nokey = await runGeminiPipeline(p, { apiKeyPresent: false });
    ok('Sans clé : INDISPONIBLE (pas_de_cle)', nokey.status === 'indisponible' && nokey.reason === 'pas_de_cle');
  }

  // ---------- 4. Contrôle serveur : Gemini ne fait jamais foi seul ----------
  {
    const ctx = { engine, symbol: 'XAU/USD', decimals: 2, spread: 0.24, commissionPerLot: 0, contract: 100, rangeLow: 3800, rangeHigh: 4100 };
    const v = verifyPipeline(good, ctx);
    ok('Plan cohérent avec les bougies : VALIDÉ', v.decision === 'VALIDÉ', v.reason);
    ok('R:R recalculé ≥ 2,5', (v.rrServer ?? 0) >= 2.5, `${v.rrServer}`);
    const wrongDir = verifyPipeline({ ...good, direction: 'BUY', stop_loss: entry - 10, take_profit: entry + 50 }, ctx);
    ok('Achat contre le biais baissier : REJETÉ', wrongDir.decision === 'REJETÉ' && wrongDir.reason.includes('biais'), wrongDir.reason);
    const slInside = verifyPipeline({ ...good, stop_loss: tr.extreme - 2 }, ctx);
    ok('Stop sous l’extrême du sweep : REJETÉ', slInside.decision === 'REJETÉ', slInside.reason);
    const fakeRR = verifyPipeline({ ...good, rr: 4.5 }, ctx);
    ok('R:R annoncé faux : REJETÉ', fakeRR.decision === 'REJETÉ' && fakeRR.reason.includes('R:R'), fakeRR.reason);
    const shortTp = verifyPipeline({ ...good, take_profit: entry - 20, rr: +netRR('SELL', entry, sl, entry - 20, 0.24, 0).toFixed(2) }, ctx);
    ok('TP sans liquidité ou R:R < 2,5 : REJETÉ', shortTp.decision === 'REJETÉ', shortTp.reason);
    const invented = verifyPipeline({ ...good, take_profit: 3000, rr: +netRR('SELL', entry, sl, 3000, 0.24, 0).toFixed(2) }, ctx);
    ok('Prix inventé hors des bougies : REJETÉ', invented.decision === 'REJETÉ', invented.reason);
    const discount = verifyPipeline({ ...good, fvg: { haut: tr.legLow + 2, bas: tr.legLow + 1, position_vague: 0.9 }, entree: tr.legLow + 1 }, ctx);
    ok('FVG en discount pour une vente : REJETÉ', discount.decision === 'REJETÉ', discount.reason);
    const rejected = verifyPipeline({ ...good, statut: 'REJETÉ', etape_echec: 'declencheur', raison: 'Pas de CHoCH.' } as any, ctx);
    ok('REJETÉ par Gemini : reste REJETÉ', rejected.decision === 'REJETÉ' && rejected.reason.includes('declencheur'));
  }

  // ---------- 5. Bout en bout ----------
  {
    const rep = await runPipeline({ symbol: 'XAU/USD', decimals: 2, now, series, engine, costs, call: async () => JSON.stringify(good), timeoutMs: 5000 });
    ok('Bout en bout : rapport VALIDÉ avec contrôles', rep.status === 'VALIDÉ' && !!rep.guard && rep.guard.checks.length >= 10, rep.message);
    const down = await runPipeline({ symbol: 'XAU/USD', decimals: 2, now, series, engine, costs, call: () => new Promise(() => {}), timeoutMs: 50 });
    ok('Bout en bout : Gemini muet → INDISPONIBLE, repli sur le moteur', down.status === 'INDISPONIBLE' && down.message.includes('moteur seul'));
  }

  if (failed) {
    console.log(`\n${failed} test(s) en échec`);
    process.exit(1);
  }
  console.log('\nTous les tests du pipeline Gemini passent.');
})();
