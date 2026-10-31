import type { JournalEntry } from '../types';

export const fmt = (v: number | null | undefined, dec: number) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(dec);

export const timeUtc = (t: number) => new Date(t).toISOString().slice(11, 16) + ' UTC';

export const localTime = (t: number) =>
  new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

export const localDateTime = (t: number) =>
  new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Taille d'un contrat standard (1 lot) par actif. Compte supposé en USD. */
const CONTRACT: Record<string, number> = { 'EUR/USD': 100_000, 'XAU/USD': 100 };

/** Lots arrondis à 0,01 vers le bas pour ne jamais dépasser le risque choisi. */
export function lotSize(pair: string, capital: number, riskPct: number, entry: number, sl: number): number | null {
  const contract = CONTRACT[pair];
  const dist = Math.abs(entry - sl);
  if (!contract || !dist || capital <= 0 || riskPct <= 0) return null;
  const riskUsd = (capital * riskPct) / 100;
  const lots = Math.floor((riskUsd / (dist * contract)) * 100) / 100;
  return lots > 0 ? lots : 0;
}

export function distanceLabel(pair: string, a: number, b: number): string {
  const d = Math.abs(a - b);
  return pair === 'XAU/USD' ? `${d.toFixed(2)} $` : `${(d / 0.0001).toFixed(1)} pips`;
}

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function loadArray<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : on ignore */
  }
}

/** Pertes du jour en % du capital, d'après le journal. */
export function todayLossPct(journal: JournalEntry[]): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return journal
    .filter(j => j.createdAt >= start.getTime() && j.rMultiple !== null && j.rMultiple < 0)
    .reduce((s, j) => s + Math.abs(j.rMultiple as number) * j.riskPct, 0);
}

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
