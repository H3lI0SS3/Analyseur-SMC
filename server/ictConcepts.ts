// Concepts ICT complémentaires : displacement, OTE (Optimal Trade Entry), liquidité de trendline, breaker block.
// Calculés uniquement sur des bougies clôturées, comme le reste du moteur.
import type { Candle, Timeframe } from './marketData';
import type { Dir, StructureEvent, Swing, Zone } from './smc';

const body = (c: Candle) => Math.abs(c.c - c.o);
const range = (c: Candle) => c.h - c.l;

/**
 * Displacement : bougie impulsive au corps nettement plus grand que la moyenne (≥ 2x les 20 précédentes)
 * et qui clôture près de son extrême (corps ≥ 60 % de la bougie). Signe d'un ordre institutionnel agressif.
 */
export function isDisplacement(c: Candle[], i: number, dir: Dir): boolean {
  if (i < 20) return false;
  const x = c[i];
  const avg = c.slice(i - 20, i).reduce((s, k) => s + body(k), 0) / 20;
  if (!avg || body(x) < 2 * avg || range(x) <= 0 || body(x) / range(x) < 0.6) return false;
  return dir === 'bull' ? x.c > x.o : x.c < x.o;
}

/** Le mouvement qui a créé la zone (±3 bougies autour de sa date) contient-il un displacement dans son sens ? */
export function zoneFromDisplacement(c: Candle[], z: Zone): boolean {
  const i = c.findIndex(k => k.t === z.t);
  if (i < 0) return false;
  for (let j = Math.max(0, i - 1); j <= Math.min(c.length - 1, i + 3); j++) if (isDisplacement(c, j, z.dir)) return true;
  return false;
}

export interface OteZone {
  dir: Dir;
  legLow: number;
  legHigh: number;
  top: number; // borne haute de la zone 62–79 %
  bottom: number;
  detail: string;
}

/**
 * OTE du dernier impulse qui a cassé la structure dans le sens `dir` :
 * achat = retracement de 62 à 79 % de la jambe swing low -> plus haut atteint après la cassure (inverse pour une vente).
 */
export function oteZone(c: Candle[], events: StructureEvent[], swings: Swing[], dir: Dir): OteZone | null {
  const ev = [...events].reverse().find(e => e.dir === dir);
  if (!ev) return null;
  const origin = [...swings].filter(s => s.idx < ev.idx && s.type === (dir === 'bull' ? 'low' : 'high')).pop();
  if (!origin) return null;
  const after = c.slice(ev.idx);
  if (!after.length) return null;
  if (dir === 'bull') {
    const legLow = origin.price;
    const legHigh = Math.max(...after.map(k => k.h));
    const size = legHigh - legLow;
    if (size <= 0) return null;
    return { dir, legLow, legHigh, top: legHigh - 0.62 * size, bottom: legHigh - 0.79 * size, detail: 'retracement 62–79 % de la jambe haussière qui a cassé la structure' };
  }
  const legHigh = origin.price;
  const legLow = Math.min(...after.map(k => k.l));
  const size = legHigh - legLow;
  if (size <= 0) return null;
  return { dir, legLow, legHigh, top: legLow + 0.79 * size, bottom: legLow + 0.62 * size, detail: 'retracement 62–79 % de la jambe baissière qui a cassé la structure' };
}

export interface TrendlineLiquidity {
  side: 'buy' | 'sell'; // buy = ligne de plus hauts descendants (stops au-dessus) ; sell = plus bas montants (stops en dessous)
  touches: number;
  priceNow: number; // niveau de la ligne à la dernière bougie
  firstT: number;
  lastT: number;
  intact: boolean; // aucune clôture au-delà depuis la dernière touche
  label: string;
}

/**
 * Liquidité de trendline : au moins 3 sommets (ou creux) alignés. Les stops s'accumulent juste au-delà de la ligne,
 * c'est un carburant / une cible pour le prix.
 */
export function findTrendlines(c: Candle[], swings: Swing[], atrVal: number, tf: Timeframe, lookback = 120): TrendlineLiquidity[] {
  const out: TrendlineLiquidity[] = [];
  const from = c.length - lookback;
  const tol = 0.2 * atrVal;
  for (const side of ['buy', 'sell'] as const) {
    const pts = swings.filter(s => s.idx >= from && s.type === (side === 'buy' ? 'high' : 'low')).slice(-8);
    let best: TrendlineLiquidity | null = null;
    for (let a = 0; a < pts.length; a++) {
      for (let b = pts.length - 1; b > a + 1; b--) {
        const p1 = pts[a];
        const p2 = pts[b];
        const slope = (p2.price - p1.price) / (p2.idx - p1.idx);
        // ligne de plus hauts descendante, ou de plus bas montante (la liquidité se construit contre le mouvement)
        if (side === 'buy' ? slope >= 0 : slope <= 0) continue;
        const at = (i: number) => p1.price + slope * (i - p1.idx);
        const touches = pts.filter(p => p.idx >= p1.idx && p.idx <= p2.idx && Math.abs(p.price - at(p.idx)) <= tol).length;
        if (touches < 3) continue;
        // la ligne doit être respectée : aucune clôture franchement au-delà entre la 1re et la dernière touche
        let respected = true;
        for (let i = p1.idx; i <= p2.idx && respected; i++) if (side === 'buy' ? c[i].c > at(i) + tol : c[i].c < at(i) - tol) respected = false;
        if (!respected) continue;
        let intact = true;
        for (let i = p2.idx + 1; i < c.length && intact; i++) if (side === 'buy' ? c[i].c > at(i) + tol : c[i].c < at(i) - tol) intact = false;
        const cand: TrendlineLiquidity = {
          side,
          touches,
          priceNow: at(c.length - 1),
          firstT: p1.t,
          lastT: p2.t,
          intact,
          label: `Liquidité de trendline ${tf} (${touches} ${side === 'buy' ? 'sommets descendants' : 'creux montants'})`,
        };
        if (!best || cand.lastT > best.lastT || (cand.lastT === best.lastT && cand.touches > best.touches)) best = cand;
      }
    }
    if (best) out.push(best);
  }
  return out;
}

/**
 * Breaker block : un order block cassé (le prix a clôturé au travers) puis une cassure de structure dans l'autre sens.
 * L'ancien support devient résistance (et inversement) : on le joue au retest.
 */
export function findBreakers(c: Candle[], tf: Timeframe, events: StructureEvent[], swings: Swing[], atrVal: number): Zone[] {
  const out: Zone[] = [];
  for (const ev of events.slice(-10)) {
    const origin = [...swings].filter(s => s.idx < ev.idx && s.type === (ev.dir === 'bull' ? 'low' : 'high')).pop();
    if (!origin) continue;
    let k = -1;
    for (let j = ev.idx; j >= Math.max(0, origin.idx - 3); j--) {
      const opposite = ev.dir === 'bull' ? c[j].c < c[j].o : c[j].c > c[j].o;
      if (j <= origin.idx + 1 && opposite) {
        k = j;
        break;
      }
    }
    if (k < 0) continue;
    const top = c[k].h;
    const bottom = c[k].l;
    if (top - bottom > 3 * atrVal) continue;
    // l'OB doit avoir été traversé par une clôture, puis une cassure de structure dans le sens opposé
    let brokeAt = -1;
    for (let j = ev.idx + 1; j < c.length; j++) {
      if (ev.dir === 'bull' ? c[j].c < bottom : c[j].c > top) {
        brokeAt = j;
        break;
      }
    }
    if (brokeAt < 0) continue;
    const opp: Dir = ev.dir === 'bull' ? 'bear' : 'bull';
    const confirm = events.find(e => e.dir === opp && e.idx >= brokeAt - 2 && e.idx <= brokeAt + 12);
    if (!confirm) continue;
    const z: Zone = { id: `${tf}-BRK-${c[k].t}`, tf, kind: 'Breaker', dir: opp, top, bottom, t: c[k].t, touched: false };
    // invalidé si le prix clôture de nouveau de l'autre côté ; testé si le prix revient dedans
    let valid = true;
    for (let j = brokeAt + 1; j < c.length && valid; j++) {
      if (opp === 'bull') {
        if (c[j].c < bottom) valid = false;
        else if (j > confirm.idx && c[j].l <= top) z.touched = true;
      } else {
        if (c[j].c > top) valid = false;
        else if (j > confirm.idx && c[j].h >= bottom) z.touched = true;
      }
    }
    if (valid) out.push(z);
  }
  return out.filter((z, i, arr) => arr.findIndex(o => o.id === z.id) === i);
}


/**
 * Inversion FVG (IFVG) : un FVG traversé par une clôture change de polarité.
 * FVG haussier cassé (clôture sous sa borne basse) = zone de vente au retest, et inversement.
 */
export function findInversionFVGs(c: Candle[], tf: Timeframe, atrVal: number, lookback = 120): Zone[] {
  const out: Zone[] = [];
  const start = Math.max(2, c.length - lookback);
  for (let i = start; i < c.length; i++) {
    const a = c[i - 2];
    const b = c[i];
    let dir: Dir | null = null;
    let top = 0;
    let bottom = 0;
    if (b.l > a.h && b.l - a.h >= 0.15 * atrVal) {
      dir = 'bull';
      top = b.l;
      bottom = a.h;
    } else if (b.h < a.l && a.l - b.h >= 0.15 * atrVal) {
      dir = 'bear';
      top = a.l;
      bottom = b.h;
    }
    if (!dir) continue;
    // cassure par une clôture au-delà de la borne opposée
    let brokeAt = -1;
    for (let j = i + 1; j < c.length; j++) {
      if (dir === 'bull' ? c[j].c < bottom : c[j].c > top) {
        brokeAt = j;
        break;
      }
    }
    if (brokeAt < 0) continue;
    const inv: Dir = dir === 'bull' ? 'bear' : 'bull';
    const z: Zone = { id: `${tf}-IFVG-${c[i - 1].t}`, tf, kind: 'IFVG', dir: inv, top, bottom, t: c[i - 1].t, touched: false };
    let valid = true;
    for (let j = brokeAt + 1; j < c.length && valid; j++) {
      if (inv === 'bear') {
        if (c[j].c > top) valid = false;
        else if (c[j].h >= bottom) z.touched = true;
      } else {
        if (c[j].c < bottom) valid = false;
        else if (c[j].l <= top) z.touched = true;
      }
    }
    if (valid) out.push(z);
  }
  return out;
}
