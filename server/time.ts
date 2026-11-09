// Horloge de marché en heure de New York (heure d'été gérée automatiquement par Intl).
// Convention forex / MT5 : le jour de trading commence à 17h00 New York.

const NY = 'America/New_York';
const nyFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
// Maroc : retour définitif à l'heure GMT le dimanche 20/09/2026 (03:00 → 02:00). Règle codée ici pour ne pas dépendre
// de la base de fuseaux du serveur (celle d'AI Studio / Cloud Run ne connaît pas encore ce changement : elle affiche +1 h).
export const MA_GMT_SINCE = Date.UTC(2026, 8, 20, 2, 0);
const maTz = (t: number) => (t >= MA_GMT_SINCE ? 'UTC' : 'Africa/Casablanca');
const fmts = new Map<string, Intl.DateTimeFormat>();
const maFmtAt = (t: number, day = false) => {
  const key = `${maTz(t)}|${day}`;
  let f = fmts.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('fr-FR', day ? { timeZone: maTz(t), weekday: 'short', day: '2-digit', month: '2-digit' } : { timeZone: maTz(t), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    fmts.set(key, f);
  }
  return f;
};

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export interface NyParts {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  mi: number;
  dow: number; // 0 = dimanche
}

export function nyParts(t: number): NyParts {
  const p: Record<string, number> = {};
  for (const part of nyFmt.formatToParts(new Date(t))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, dow };
}

/** Décalage New York - UTC en ms à l'instant t (ex. -4 h en été, -5 h en hiver). */
function nyOffset(t: number): number {
  const p = nyParts(t);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  return asUtc - Math.floor(t / 60_000) * 60_000;
}

/** Convertit une heure murale de New York en timestamp UTC (les jours peuvent déborder, ex. d = 0). */
export function nyToUtc(y: number, m: number, d: number, h: number, mi = 0): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - nyOffset(guess);
  t = guess - nyOffset(t); // second passage pour les jours de changement d'heure
  return t;
}

/** Début du jour de trading (dernier 17h00 New York <= t). */
export function tradingDayStart(t: number): number {
  const p = nyParts(t);
  return p.h >= 17 ? nyToUtc(p.y, p.m, p.d, 17) : nyToUtc(p.y, p.m, p.d - 1, 17);
}

/** Début de la semaine de trading (dimanche 17h00 New York). */
export function tradingWeekStart(t: number): number {
  const s = tradingDayStart(t);
  const p = nyParts(s); // 17h00 d'un jour donné
  return nyToUtc(p.y, p.m, p.d - p.dow, 17);
}

/** Marché fermé : du vendredi 17h00 au dimanche 17h00 (New York). */
export function marketClosed(t: number): boolean {
  const p = nyParts(t);
  return (p.dow === 5 && p.h >= 17) || p.dow === 6 || (p.dow === 0 && p.h < 17);
}

/** Heure du Maroc, ex. "14:30". */
export const maTime = (t: number) => maFmtAt(t).format(new Date(t));
/** Jour + heure du Maroc, ex. "ven. 30/10 14:30". */
export const maDateTime = (t: number) => `${maFmtAt(t, true).format(new Date(t))} ${maFmtAt(t).format(new Date(t))}`;
