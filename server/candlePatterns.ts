// Figures de retournement en bougies japonaises (ebook « Anticiper les marchés avec les bougies japonaises »),
// adaptées au forex et à l'or en intraday : le marché tourne en continu, la bougie suivante ouvre au niveau de la
// clôture précédente, donc les conditions « ouvre sous / au-dessus de la clôture de la veille » et les figures à gap
// (bébé abandonné, gap des sommets lourdauds) ne s'appliquent qu'aux vrais gaps (réouverture du dimanche).
// Rôle dans l'app : confirmation affichée et suivie, sans changer la décision de la stratégie SMC.
import type { Candle, Timeframe } from './marketData';

export type PatternDir = 'haussier' | 'baissier';

export interface CandlePattern {
  name: string;
  dir: PatternDir;
  tf: Timeframe;
  t: number; // ouverture de la dernière bougie de la figure (UTC)
  candles: number; // nombre de bougies de la figure
  inZone: boolean; // la figure touche la zone d'entrée du plan
  detail: string;
}

const body = (c: Candle) => Math.abs(c.c - c.o);
const range = (c: Candle) => c.h - c.l;
const green = (c: Candle) => c.c > c.o;
const red = (c: Candle) => c.c < c.o;
const mid = (c: Candle) => (c.o + c.c) / 2;
const bodyTop = (c: Candle) => Math.max(c.o, c.c);
const bodyBot = (c: Candle) => Math.min(c.o, c.c);

/**
 * Cherche les figures dont la dernière bougie fait partie des `recent` dernières bougies clôturées.
 * `zone` : bornes de la zone FVG/OB du plan (facultatif) pour savoir si la figure s'est formée dedans.
 */
export function findCandlePatterns(
  candles: Candle[],
  tf: Timeframe,
  opts: { recent?: number; zone?: { top: number; bottom: number } | null } = {}
): CandlePattern[] {
  const recent = opts.recent ?? 3;
  const out: CandlePattern[] = [];
  if (candles.length < 25) return out;
  const touches = (cs: Candle[]) =>
    !!opts.zone && cs.some(c => c.l <= opts.zone!.top && c.h >= opts.zone!.bottom);

  for (let i = candles.length - recent; i < candles.length; i++) {
    if (i < 22) continue;
    const ref = candles.slice(i - 20, i);
    const avgBody = ref.reduce((s, c) => s + body(c), 0) / ref.length || 1e-12;
    const big = (c: Candle) => body(c) >= 1.2 * avgBody;
    const small = (c: Candle) => body(c) <= 0.5 * avgBody;
    const doji = (c: Candle) => range(c) > 0 && body(c) <= 0.1 * range(c);
    const c0 = candles[i];
    const c1 = candles[i - 1];
    const c2 = candles[i - 2];
    // contexte : la figure doit arriver après un mouvement (6 bougies avant le début de la figure)
    const trendBefore = (start: number): PatternDir | null => {
      const a = candles[start - 7];
      const b = candles[start - 1];
      if (!a || !b) return null;
      const move = b.c - a.c;
      if (Math.abs(move) < 2 * avgBody) return null;
      return move < 0 ? 'baissier' : 'haussier';
    };
    const add = (name: string, dir: PatternDir, cs: Candle[], detail: string) =>
      out.push({ name, dir, tf, t: cs[cs.length - 1].t, candles: cs.length, inZone: touches(cs), detail });

    // --- 2 bougies ---
    const ctx2 = trendBefore(i - 1);
    if (ctx2 === 'baissier') {
      if (red(c1) && green(c0) && bodyTop(c0) >= bodyTop(c1) && bodyBot(c0) <= bodyBot(c1) && body(c0) > body(c1)) {
        add('Avalement haussier', 'haussier', [c1, c0], 'Le corps vert englobe le corps rouge précédent : retour des acheteurs.');
      } else if (red(c1) && big(c1) && bodyTop(c0) < bodyTop(c1) && bodyBot(c0) > bodyBot(c1)) {
        if (doji(c0)) add('Harami en croix haussier', 'haussier', [c1, c0], 'Un doji dans le corps d’une grande bougie rouge : la force vendeuse s’épuise (variante la plus forte du harami).');
        else if (small(c0)) add('Harami haussier', 'haussier', [c1, c0], 'Une petite bougie dans le corps d’une grande bougie rouge : la force vendeuse s’épuise.');
      } else if (red(c1) && big(c1) && green(c0) && c0.c > mid(c1) && c0.c < c1.o) {
        add('Structure pénétrante haussière', 'haussier', [c1, c0], 'La bougie verte clôture au-delà de la moitié du grand corps rouge précédent.');
      }
    }
    if (ctx2 === 'haussier') {
      if (green(c1) && red(c0) && bodyTop(c0) >= bodyTop(c1) && bodyBot(c0) <= bodyBot(c1) && body(c0) > body(c1)) {
        add('Avalement baissier', 'baissier', [c1, c0], 'Le corps rouge englobe le corps vert précédent : retour des vendeurs.');
      } else if (green(c1) && big(c1) && bodyTop(c0) < bodyTop(c1) && bodyBot(c0) > bodyBot(c1)) {
        if (doji(c0)) add('Harami en croix baissier', 'baissier', [c1, c0], 'Un doji dans le corps d’une grande bougie verte : la force acheteuse s’épuise.');
        else if (small(c0)) add('Harami baissier', 'baissier', [c1, c0], 'Une petite bougie dans le corps d’une grande bougie verte : la force acheteuse s’épuise.');
      } else if (green(c1) && big(c1) && red(c0) && c0.c < mid(c1) && c0.c > c1.o) {
        add('Couverture en nuage noir', 'baissier', [c1, c0], 'La bougie rouge clôture sous la moitié du grand corps vert précédent.');
      }
    }

    // --- 3 bougies ---
    const ctx3 = trendBefore(i - 2);
    if (ctx3 === 'baissier' && red(c2) && big(c2) && small(c1) && green(c0) && c0.c > mid(c2) && bodyTop(c1) <= bodyBot(c2) + 0.5 * body(c2)) {
      const gaps = c1.h < c2.l && c1.h < c0.l;
      add(gaps ? 'Bébé abandonné haussier' : 'Étoile du matin', 'haussier', [c2, c1, c0],
        gaps ? 'Bougie centrale isolée par deux gaps : excès de panique puis reprise en main des acheteurs.' : 'Grande bougie rouge, petite bougie d’hésitation, puis bougie verte qui reprend plus de la moitié du corps rouge.');
    }
    if (ctx3 === 'haussier' && green(c2) && big(c2) && small(c1) && red(c0) && c0.c < mid(c2) && bodyBot(c1) >= bodyTop(c2) - 0.5 * body(c2)) {
      const gaps = c1.l > c2.h && c1.l > c0.h;
      add(gaps ? 'Bébé abandonné baissier' : 'Étoile du soir', 'baissier', [c2, c1, c0],
        gaps ? 'Bougie centrale isolée par deux gaps : excès d’optimisme puis reprise en main des vendeurs.' : 'Grande bougie verte, petite bougie d’hésitation, puis bougie rouge qui reprend plus de la moitié du corps vert.');
    }
  }
  // la figure la plus récente d'abord ; à égalité, la plus longue (3 bougies) d'abord
  return out.sort((a, b) => b.t - a.t || b.candles - a.candles);
}
