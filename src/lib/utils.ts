import type { JournalEntry, RiskSettings } from '../types';

export const fmt = (v: number | null | undefined, dec: number) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(dec);

export const timeUtc = (t: number) => new Date(t).toISOString().slice(11, 16) + ' UTC';

// Toutes les heures affichées sont en heure du Maroc.
const TZ = 'Africa/Casablanca';
export const localTime = (t: number) =>
  new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });

export const localDateTime = (t: number) =>
  new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: TZ });

/** Taille d'un contrat standard (1 lot) par actif. Compte supposé en USD. */
export const CONTRACT: Record<string, number> = { 'EUR/USD': 100_000, 'XAU/USD': 100 };

/** Spread (en prix) et commission de l'utilisateur pour un actif. */
export function costsFor(pair: string, s: RiskSettings) {
  return {
    spread: pair === 'XAU/USD' ? s.spreadGold : s.spreadEurPips * 0.0001,
    commissionPerLot: s.commissionPerLot,
  };
}

/**
 * Lots arrondis à 0,01 vers le bas pour ne jamais dépasser le risque choisi.
 * Perte par lot si le stop est touché = distance x contrat + commission.
 */
export function lotSize(pair: string, capital: number, riskPct: number, entry: number, sl: number, commissionPerLot = 0): number | null {
  const contract = CONTRACT[pair];
  const dist = Math.abs(entry - sl);
  if (!contract || !dist || capital <= 0 || riskPct <= 0) return null;
  const riskUsd = (capital * riskPct) / 100;
  const lossPerLot = dist * contract + Math.max(0, commissionPerLot);
  const lots = Math.floor((riskUsd / lossPerLot) * 100) / 100;
  return lots > 0 ? lots : 0;
}

/** Perte réelle en $ si le stop est touché, avec la taille arrondie. */
export function realRiskUsd(pair: string, lots: number, entry: number, sl: number, commissionPerLot = 0): number {
  return lots * (Math.abs(entry - sl) * (CONTRACT[pair] || 0) + Math.max(0, commissionPerLot));
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

/**
 * Risque consommé aujourd'hui, en % du capital :
 * pertes réalisées (en R x risque) + risque des trades encore ouverts.
 */
export function todayLossPct(journal: JournalEntry[]): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return journal
    .filter(j => j.createdAt >= start.getTime())
    .reduce((s, j) => {
      if (j.result === 'en_cours' || j.result === 'attente') return s + j.riskPct;
      if (j.rMultiple !== null && j.rMultiple < 0) return s + Math.abs(j.rMultiple) * j.riskPct;
      return s;
    }, 0);
}

// ---------- Appels API avec code d'accès ----------
const CODE_KEY = 'sa_access_code';
export const getAccessCode = () => {
  try {
    return localStorage.getItem(CODE_KEY) || '';
  } catch {
    return '';
  }
};
export const setAccessCode = (c: string) => {
  try {
    localStorage.setItem(CODE_KEY, c);
  } catch {
    /* ignoré */
  }
};
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function api(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const code = getAccessCode();
  if (code) headers.set('X-Access-Code', code);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 && onUnauthorized) onUnauthorized();
  return res;
}

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** Risque à appliquer selon la classe du setup : classe B = risque divisé par deux (grille SMC). */
export const riskForGrade = (riskPct: number, grade?: 'A+' | 'B' | 'C') => (grade === 'B' ? riskPct / 2 : riskPct);

/** Taille au format eToro : unités (EUR ou onces), valeur exposée en $ et montant à investir selon le levier. */
export function etoroSize(pair: string, lots: number, price: number, leverage: number) {
  const units = lots * (CONTRACT[pair] || 0);
  const exposure = units * price; // EUR x cours EUR/USD = $ ; onces x prix de l'once = $
  const lev = Math.max(1, leverage || 1);
  return { units, exposure, amount: exposure / lev, leverage: lev };
}

/** Écart maximal accepté entre le prix du broker et celui de l'app (au-delà : faute de frappe ou mauvais actif). */
export const MAX_BROKER_GAP: Record<string, number> = { 'XAU/USD': 15, 'EUR/USD': 0.001 };

/**
 * Décalage entre le prix du broker et celui de l'app.
 * Le trader saisit le prix « Sell » (bid) affiché chez son broker ; on ajoute un demi-spread pour obtenir le prix moyen,
 * comparable au prix du flux de l'app. Tous les niveaux du plan sont décalés de cet écart (distances et R:R inchangés).
 */
export function brokerOffset(pair: string, appPrice: number, bidText: string, spread: number): { offset: number; error: string | null } {
  const t = bidText.trim().replace(/\s/g, '').replace(',', '.');
  if (!t) return { offset: 0, error: null };
  const bid = Number(t);
  if (!Number.isFinite(bid) || bid <= 0) return { offset: 0, error: 'Prix invalide.' };
  const offset = bid + spread / 2 - appPrice;
  const max = MAX_BROKER_GAP[pair] ?? appPrice * 0.004;
  if (Math.abs(offset) > max) return { offset: 0, error: `Écart de ${Math.abs(offset).toFixed(pair === 'XAU/USD' ? 2 : 5)} avec l’app : trop grand, vérifie l’actif et le prix saisi (niveaux non recalés).` };
  const dec = pair === 'XAU/USD' ? 2 : 5;
  return { offset: Number(offset.toFixed(dec)), error: null };
}
