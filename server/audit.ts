// Contrôleur de cohérence du moteur : vérifie qu'une analyse ne se contredit pas elle-même.
// Utilisé par les tests (données synthétiques et réelles). Renvoie la liste des incohérences trouvées.
import { TF_MS, type Candle, type Timeframe } from './marketData';
import { MIN_CONFLUENCES, type EngineResult } from './smc';
import { marketClosed } from './time';

export interface AuditContext {
  now: number;
  series: Record<Timeframe, Candle[]>;
  spread: number;
  commissionPerLot: number;
  contract: number;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

export function auditEngine(e: EngineResult, ctx: AuditContext): string[] {
  const errs: string[] = [];
  const err = (m: string) => errs.push(m);
  const ck = (k: string) => e.checklist.find(c => c.key === k);
  const ok = (k: string) => !!ck(k)?.ok;
  const s = e.setup;
  const tick = Math.max(1e-9, Math.abs(e.price) * 1e-6);
  const commUnit = ctx.commissionPerLot / (ctx.contract || 1);
  const m15Closed = ctx.series.M15.filter(c => c.t + TF_MS.M15 <= ctx.now);

  // ---- 1. Plan ----
  if (s) {
    const long = s.direction === 'acheter';
    if (long ? !(s.sl < s.entry && s.entry < s.tp1) : !(s.sl > s.entry && s.entry > s.tp1)) err(`niveaux dans le mauvais ordre (${s.sl} / ${s.entry} / ${s.tp1})`);
    if (s.tp2 !== null && (long ? s.tp2 <= s.tp1 : s.tp2 >= s.tp1)) err('TP2 avant TP1');
    const risk = Math.abs(s.entry - s.sl);
    const rr = (tp: number) => (Math.abs(tp - s.entry) - commUnit) / (risk + commUnit);
    if (!near(rr(s.tp1), s.rr1, 0.03)) err(`R:R TP1 annoncé ${s.rr1}, recalculé ${rr(s.tp1).toFixed(2)}`);
    if (s.tp2 !== null && s.rr2 !== null && !near(rr(s.tp2), s.rr2, 0.03)) err(`R:R TP2 annoncé ${s.rr2}, recalculé ${rr(s.tp2).toFixed(2)}`);
    const z = e.zones.find(x => x.id === s.zoneId);
    if (!z) err('zone du plan absente de la liste des zones');
    else {
      if ((z.dir === 'bull') !== long) err('sens de la zone différent du sens du plan');
      if (s.entryType === 'marché' && !(e.price <= z.top + tick && e.price >= z.bottom - tick)) err('entrée au marché alors que le prix est hors de la zone');
      if (s.entryType === 'limite' && !near(s.entry, long ? z.top : z.bottom, tick * 10)) err('ordre limite pas posé sur le bord de la zone');
      if (s.sl !== undefined && (long ? s.sl >= z.bottom : s.sl <= z.top)) err('stop à l’intérieur de la zone');
    }
    const want = e.bias === 'haussier' ? 'acheter' : e.bias === 'baissier' ? 'vendre' : null;
    if (want && s.direction !== want) err('plan contre le biais H4/D1');
    if (!want) err('plan proposé sans biais');
    // objectifs posés sur une liquidité non prise, du bon côté, un spread avant
    for (const [tp, label] of [[s.tp1, s.tp1Label], [s.tp2, s.tp2Label]] as const) {
      if (tp === null) continue;
      const lvl = e.liquidity.find(l => l.label === label && near(long ? l.price - ctx.spread : l.price + ctx.spread, tp, tick * 10));
      if (!lvl) err(`objectif ${tp} sans liquidité correspondante (${label})`);
      else if (lvl.swept) err(`objectif ${tp} posé sur une liquidité déjà prise`);
      else if (long ? lvl.side !== 'buy' : lvl.side !== 'sell') err(`objectif ${tp} sur une liquidité du mauvais côté`);
    }
    if (!marketClosed(ctx.now) && (!s.validUntil || s.validUntil < ctx.now)) err('validité du plan absente ou déjà passée');
  }

  // ---- 2. Zones : aucune zone invalidée par les bougies clôturées ----
  for (const z of e.zones) {
    const tfC = ctx.series[z.tf].filter(c => c.t + TF_MS[z.tf] <= ctx.now);
    const i = tfC.findIndex(c => c.t === z.t);
    if (i < 0) continue;
    const from = z.kind === 'FVG' ? i + 2 : i + 1;
    for (let j = from; j < tfC.length; j++) {
      const c = tfC[j];
      if (z.kind === 'FVG' && (z.dir === 'bull' ? c.l <= z.bottom - tick : c.h >= z.top + tick)) { err(`FVG ${z.id} comblé mais encore proposé`); break; }
      if (z.kind === 'OB' && (z.dir === 'bull' ? c.c < z.bottom - tick : c.c > z.top + tick)) { err(`OB ${z.id} invalidé mais encore proposé`); break; }
    }
    if (z.top < z.bottom) err(`zone ${z.id} inversée (haut < bas)`);
  }

  // ---- 3. Checklist cohérente avec les données ----
  if (s) {
    const long = s.direction === 'acheter';
    if (ok('ote') && !(e.ict.ote && s.entry <= e.ict.ote.top + tick && s.entry >= e.ict.ote.bottom - tick)) err('OTE coché alors que l’entrée est hors OTE');
    if (ok('pd') && !(e.dealingRange && (long ? e.dealingRange.position < 0.5 : e.dealingRange.position > 0.5))) err('premium/discount coché à tort');
    if (ok('ltf') && e.timeframes.M15.trend !== (long ? 'haussier' : 'baissier')) err('structure M15 cochée à tort');
    if (ok('amd') && e.amd.direction !== (long ? 'haussière' : 'baissière')) err('AMD coché contre le sens du cycle');
    if (ok('trendline') && !e.ict.trendlines.some(t => t.intact && (long ? t.side === 'buy' && t.priceNow > s.entry : t.side === 'sell' && t.priceNow < s.entry))) err('trendline cochée sans trendline valide');
    if (ok('candle') && !e.ict.candlePatterns.some(p => p.inZone && p.dir === (long ? 'haussier' : 'baissier'))) err('bougie japonaise cochée sans figure dans la zone');
    if (ok('rr') !== ((s.rr2 ?? s.rr1) >= 2)) err('case R:R incohérente avec le plan');
  } else {
    for (const k of ['zone', 'rr', 'sweep', 'amd', 'pd', 'ltf', 'displacement', 'ote', 'trendline', 'candle']) if (ok(k)) err(`critère « ${k} » coché sans plan`);
  }
  if (ok('session') !== e.session.killzone) err('case kill zone incohérente avec la session');
  if (ok('bias') !== (e.bias !== 'neutre')) err('case biais incohérente');

  // ---- 3b. Balayages cohérents avec la liste de liquidité ----
  for (const sw of e.sweeps) {
    const lvl = e.liquidity.find(l => l.label === sw.label && near(l.price, sw.price, tick * 10));
    if (lvl && !lvl.swept) err(`balayage de « ${sw.label} » annoncé alors que le niveau est marqué non pris`);
    if (lvl?.formedAt && sw.t < lvl.formedAt) err(`« ${sw.label} » balayé avant même d’exister`);
    if (sw.t > ctx.now) err('balayage dans le futur');
  }

  // ---- 4. AMD ----
  if ((e.amd.phase === 'Manipulation' || e.amd.phase === 'Distribution') && !e.amd.direction) err('AMD en manipulation/distribution sans direction');
  if ((e.amd.phase === 'Accumulation' || e.amd.phase === 'Indéterminée') && e.amd.direction) err('AMD sans cycle mais avec une direction');

  // ---- 5. Score et décision ----
  if (e.score < 0 || e.score > 100) err(`score hors bornes (${e.score})`);
  if (e.grade !== (e.score >= 80 ? 'A+' : e.score >= 60 ? 'B' : 'C')) err('classe incohérente avec le score');
  if (e.dealingRange && (e.dealingRange.position < 0 || e.dealingRange.position > 1)) err('position dans le range hors de 0-100 %');
  if (e.signal !== 'attendre') {
    if (!s) err('signal sans plan');
    else if (e.signal !== s.direction) err('signal différent du sens du plan');
    if (!e.checklist.filter(c => c.core).every(c => c.ok)) err('signal alors qu’une condition obligatoire manque');
    if (e.checklist.filter(c => !c.core && c.ok).length < MIN_CONFLUENCES) err('signal avec moins de confluences que le minimum');
    if (e.grade === 'C') err('signal en classe C');
    if (marketClosed(ctx.now)) err('signal marché fermé');
    if (s?.entryType === 'marché' && !ok('ltf')) err('entrée au marché sans confirmation M15');
  } else if (!e.waitCondition) err('« attendre » sans raison affichée');

  // ---- 6. Données ----
  if (m15Closed.length && e.timeframes.M15.lastTime !== m15Closed[m15Closed.length - 1].t) err('la structure M15 n’utilise pas la dernière bougie clôturée');
  return errs;
}
