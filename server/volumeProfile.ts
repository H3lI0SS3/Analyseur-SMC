// Volume profile en ticks (information, ne compte PAS dans le verdict).
// Le forex et l'or spot n'ont pas de volume centralisé : on utilise le volume en ticks de FxPro (cTrader),
// c'est-à-dire le nombre de variations de prix. Sans cTrader (Twelve Data, Yahoo), aucun profil n'est calculé.
import type { Candle } from './marketData';
import { tradingDayStart } from './time';

export interface VolumeProfile {
  /** début de la journée de trading (17h00 New York) */
  from: number;
  to: number;
  /** prix le plus échangé (Point of Control) */
  poc: number;
  /** zone de valeur : 70 % du volume autour du POC */
  vah: number;
  val: number;
  totalTicks: number;
  bars: number;
}

export const VALUE_AREA = 0.7;

/**
 * Profil d'une série de bougies : le volume de chaque bougie est réparti uniformément entre son plus bas et son
 * plus haut, par tranches de `bin` (prix). Null si aucune bougie n'a de volume.
 */
export function volumeProfile(candles: Candle[], bin: number): VolumeProfile | null {
  const withVol = candles.filter(c => (c.v ?? 0) > 0 && c.h >= c.l);
  if (!withVol.length || !(bin > 0)) return null;
  const key = (p: number) => Math.floor(p / bin + 1e-9);
  const hist = new Map<number, number>();
  for (const c of withVol) {
    const k0 = key(c.l);
    const k1 = key(c.h);
    const share = c.v! / (k1 - k0 + 1);
    for (let k = k0; k <= k1; k++) hist.set(k, (hist.get(k) ?? 0) + share);
  }
  const keys = [...hist.keys()].sort((a, b) => a - b);
  const total = keys.reduce((s, k) => s + hist.get(k)!, 0);
  // POC : tranche la plus chargée (en cas d'égalité, la plus proche du milieu du range)
  const mid = (keys[0] + keys[keys.length - 1]) / 2;
  let poc = keys[0];
  for (const k of keys) {
    const a = hist.get(k)!;
    const b = hist.get(poc)!;
    if (a > b + 1e-9 || (Math.abs(a - b) <= 1e-9 && Math.abs(k - mid) < Math.abs(poc - mid))) poc = k;
  }
  // zone de valeur : on s'étend depuis le POC vers le côté le plus chargé jusqu'à 70 % du volume
  let lo = keys.indexOf(poc);
  let hi = lo;
  let acc = hist.get(poc)!;
  while (acc < VALUE_AREA * total && (lo > 0 || hi < keys.length - 1)) {
    const down = lo > 0 ? hist.get(keys[lo - 1])! : -1;
    const up = hi < keys.length - 1 ? hist.get(keys[hi + 1])! : -1;
    if (up >= down) acc += hist.get(keys[++hi])!;
    else acc += hist.get(keys[--lo])!;
  }
  const price = (k: number) => (k + 0.5) * bin;
  return {
    from: withVol[0].t,
    to: withVol[withVol.length - 1].t,
    poc: price(poc),
    vah: (keys[hi] + 1) * bin,
    val: keys[lo] * bin,
    totalTicks: Math.round(total),
    bars: withVol.length,
  };
}

export interface SessionProfiles {
  today: VolumeProfile | null;
  yesterday: VolumeProfile | null;
  /** position du prix par rapport à la zone de valeur de la veille */
  priceVsYesterday: 'au-dessus' | 'dans' | 'en dessous' | null;
  bin: number;
}

/** Profils de la journée en cours et de la veille, sur les bougies M15 (null si pas de volume). */
export function sessionProfiles(m15: Candle[], price: number, bin: number, now: number): SessionProfiles | null {
  if (!m15.some(c => (c.v ?? 0) > 0)) return null;
  const today0 = tradingDayStart(now);
  const yest0 = tradingDayStart(today0 - 3_600_000);
  const today = volumeProfile(m15.filter(c => c.t >= today0 && c.t <= now), bin);
  const yesterday = volumeProfile(m15.filter(c => c.t >= yest0 && c.t < today0), bin);
  const priceVsYesterday = yesterday ? (price > yesterday.vah ? 'au-dessus' : price < yesterday.val ? 'en dessous' : 'dans') : null;
  return { today, yesterday, priceVsYesterday, bin };
}
