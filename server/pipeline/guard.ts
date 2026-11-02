// Garde-fou déterministe : aucun chiffre de Gemini n'est affiché ni tradé sans être recontrôlé
// sur les vraies bougies et les faits du moteur. Gemini ne peut que confirmer ou refuser, jamais créer un trade.
import type { EngineResult } from '../smc';
import { MIN_RR } from '../smc';
import type { PipelineResult, PipelineValidated } from './schema';

export interface GuardCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface GuardVerdict {
  decision: 'VALIDÉ' | 'REJETÉ';
  /** pourquoi le pipeline final est validé ou rejeté (première vérification en échec) */
  reason: string;
  checks: GuardCheck[];
  /** R:R net recalculé par le serveur (celui qui est affiché), null si pas de plan */
  rrServer: number | null;
}

export interface GuardContext {
  engine: EngineResult;
  symbol: string;
  decimals: number;
  spread: number;
  commissionPerLot: number;
  contract: number;
  /** plus bas / plus haut des bougies envoyées (aucun prix ne peut en sortir) */
  rangeLow: number;
  rangeHigh: number;
}

/** R:R net : spread et commission compris (même formule que le moteur et le journal). */
export function netRR(dir: 'BUY' | 'SELL', entry: number, sl: number, tp: number, spread: number, commUnit: number): number {
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (!(risk > 0)) return 0;
  void dir;
  return (reward - spread - commUnit) / (risk + spread + commUnit);
}

export function verifyPipeline(res: PipelineResult, ctx: GuardContext): GuardVerdict {
  if (res.statut === 'REJETÉ') {
    return { decision: 'REJETÉ', reason: `Gemini — étape « ${res.etape_echec} » : ${res.raison}`, checks: [], rrServer: null };
  }
  const v: PipelineValidated = res;
  const e = ctx.engine;
  const buy = v.direction === 'BUY';
  const atrM15 = e.timeframes.M15.atr14;
  const tol = Math.max(ctx.spread * 2, 0.05 * atrM15, 10 ** -ctx.decimals * 5);
  const commUnit = ctx.commissionPerLot / (ctx.contract || 1);
  const rr = netRR(v.direction, v.entree, v.stop_loss, v.take_profit, ctx.spread, commUnit);
  const tr = e.trigger;
  const checks: GuardCheck[] = [];
  const add = (key: string, label: string, ok: boolean, detail: string) => checks.push({ key, label, ok, detail });

  add('symbole', 'Bon actif', v.symbole.replace(/\W/g, '').toUpperCase() === ctx.symbol.replace(/\W/g, '').toUpperCase(), `${v.symbole} / ${ctx.symbol}`);
  const want = e.bias === 'haussier' ? 'BUY' : e.bias === 'baissier' ? 'SELL' : null;
  add('biais', 'Sens du biais H4/D1', want === v.direction, want ? `Biais ${e.bias}, Gemini ${v.direction}.` : 'Biais neutre : aucun trade.');
  add(
    'declencheur',
    'Déclencheur confirmé par le moteur (sweep → displacement → CHoCH)',
    !!tr && (tr.dir === 'bull') === buy,
    tr ? `Moteur : sweep ${tr.sweep.label}, CHoCH ${tr.dir === 'bull' ? 'haussier' : 'baissier'}.` : 'Le moteur ne voit pas de déclencheur complet.'
  );
  const inRange = [v.entree, v.stop_loss, v.take_profit, v.fvg.haut, v.fvg.bas].every(x => x >= ctx.rangeLow - 3 * atrM15 && x <= ctx.rangeHigh + 3 * atrM15);
  add('prix', 'Prix issus des bougies fournies', inRange, inRange ? 'Tous les niveaux sont dans la plage des données.' : 'Un niveau sort de la plage des bougies : prix inventé.');
  const entryAtEdge = buy ? Math.abs(v.entree - v.fvg.haut) <= tol || (v.entree <= v.fvg.haut && v.entree >= v.fvg.bas) : Math.abs(v.entree - v.fvg.bas) <= tol || (v.entree >= v.fvg.bas && v.entree <= v.fvg.haut);
  add('entree', 'Entrée au début du FVG', entryAtEdge, `Entrée ${v.entree}, FVG ${v.fvg.bas} – ${v.fvg.haut}.`);
  if (tr) {
    const pos = ((v.fvg.haut + v.fvg.bas) / 2 - tr.legLow) / (tr.legHigh - tr.legLow || 1);
    add('pd', buy ? 'FVG en discount de la vague (< 50 %)' : 'FVG en premium de la vague (> 50 %)', buy ? pos < 0.5 : pos > 0.5, `Position recalculée : ${Math.round(pos * 100)} % de la vague ${tr.legLow} → ${tr.legHigh}.`);
    const slOk = buy ? v.stop_loss < tr.extreme : v.stop_loss > tr.extreme;
    add('stop', 'Stop derrière l’extrême du sweep', slOk, `Extrême du sweep ${+tr.extreme.toFixed(ctx.decimals)}, stop ${v.stop_loss}.`);
  } else {
    add('pd', 'Premium / discount de la vague', false, 'Pas de vague de référence côté moteur.');
    add('stop', 'Stop derrière l’extrême du sweep', false, 'Pas de sweep de référence côté moteur.');
  }
  const tpLvl = e.liquidity.find(l => !l.swept && (buy ? l.side === 'buy' && l.price > v.entree : l.side === 'sell' && l.price < v.entree) && Math.abs(l.price - v.take_profit) <= tol + ctx.spread);
  add('tp', 'TP sur une liquidité opposée non prise', !!tpLvl, tpLvl ? `${tpLvl.label} (${tpLvl.price}).` : `Aucune liquidité non prise à ${v.take_profit}.`);
  add('rr', `R:R net ≥ 1:${MIN_RR} (recalculé)`, rr >= MIN_RR, `R:R recalculé 1:${rr.toFixed(2)} (Gemini : 1:${v.rr.toFixed(2)}).`);
  add('rr_coherent', 'R:R annoncé cohérent', Math.abs(rr - v.rr) <= 0.25, Math.abs(rr - v.rr) <= 0.25 ? 'Écart négligeable.' : `Écart de ${Math.abs(rr - v.rr).toFixed(2)} : calcul de Gemini faux.`);
  const priceOk = buy ? v.entree <= e.price + tol : v.entree >= e.price - tol;
  add('cote_prix', 'Entrée du bon côté du prix actuel', priceOk, `Prix ${e.price}, entrée ${v.entree}.`);
  add('annonce', 'Pas d’annonce forte imminente', !!e.checklist.find(c => c.key === 'news')?.ok, e.checklist.find(c => c.key === 'news')?.detail ?? '');

  const failed = checks.find(c => !c.ok);
  return {
    decision: failed ? 'REJETÉ' : 'VALIDÉ',
    reason: failed ? `Contrôle serveur — ${failed.label} : ${failed.detail}` : `Plan Gemini confirmé par ${checks.length} contrôles sur les vraies bougies.`,
    checks,
    rrServer: Number(rr.toFixed(2)),
  };
}
