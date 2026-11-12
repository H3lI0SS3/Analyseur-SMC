// Règles du desk (gestion du risque au niveau du compte), appliquées au moment de prendre un trade.
// Elles complètent la stratégie : un setup valide peut être refusé parce que le compte est déjà exposé.
import type { JournalEntry, Signal } from '../types';

export const MAX_TRADES_PER_DAY = 2;
export const MAX_LOSSES_IN_A_ROW = 2;

const startOfDay = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const isOpen = (j: JournalEntry) => j.result === 'attente' || j.result === 'en_cours';
/** Sens de l'exposition au dollar : acheter l'or ou l'EUR/USD = vendre le dollar. */
const usdSide = (pair: string, dir: Exclude<Signal, 'attendre'>) => (pair.endsWith('/USD') ? (dir === 'acheter' ? 'short' : 'long') : 'neutral');

/** Renvoie la raison du refus, ou null si le desk autorise le trade. */
export function deskCheck(journal: JournalEntry[], pair: string, direction: Exclude<Signal, 'attendre'>, now = Date.now()): string | null {
  const today = journal.filter(j => j.createdAt >= startOfDay(now) && j.result !== 'non_pris' && j.result !== 'expire');
  if (today.length >= MAX_TRADES_PER_DAY) return `Règle du desk : ${MAX_TRADES_PER_DAY} trades maximum par jour (déjà ${today.length} aujourd’hui). Reprends demain.`;
  // pertes consécutives du jour (du plus récent au plus ancien)
  const closed = today.filter(j => !isOpen(j)).sort((a, b) => (b.exitAt ?? b.createdAt) - (a.exitAt ?? a.createdAt));
  let losses = 0;
  for (const j of closed) {
    if (j.result === 'perdu' || (j.rMultiple !== null && j.rMultiple < 0)) losses++;
    else break;
  }
  if (losses >= MAX_LOSSES_IN_A_ROW) return `Règle du desk : ${losses} pertes d’affilée aujourd’hui. Stop pour la journée, on ne cherche pas à se refaire.`;
  const open = journal.filter(isOpen);
  if (open.some(j => j.pair === pair)) return `Règle du desk : un trade est déjà ouvert ou en attente sur ${pair}. Un seul trade à la fois par actif.`;
  const side = usdSide(pair, direction);
  const same = open.find(j => usdSide(j.pair, j.direction) === side && side !== 'neutral');
  if (same) return `Règle du desk : ${same.direction === 'acheter' ? 'achat' : 'vente'} ${same.pair} déjà ouvert, même exposition au dollar. Deux trades corrélés = risque doublé : attends qu’il soit clôturé.`;
  return null;
}

/** Découpe de la position en deux ordres (TP1 et TP2) pour gérer la sortie partielle chez le broker. */
export function splitOrders(totalLots: number): { lot1: number; lot2: number } | null {
  const cents = Math.round(totalLots * 100);
  if (cents < 2) return null;
  const c1 = Math.floor(cents / 2);
  return { lot1: c1 / 100, lot2: (cents - c1) / 100 };
}

/** Mêmes règles, calculées sur le compte réel (journal FxPro) : c'est la version utilisée quand cTrader est connecté. */
export interface FxDesk {
  balance: number | null;
  lossTodayPct: number;
  tradesToday: number;
  lossStreakToday: number;
  open: { pair: string; direction: 'acheter' | 'vendre'; lots: number; stop: number | null }[];
  maxTradesPerDay: number;
  maxLossesInARow: number;
}
export function deskCheckFx(desk: FxDesk, pair: string, direction: Exclude<Signal, 'attendre'>, dailyLossPct: number): string | null {
  if (desk.lossTodayPct >= dailyLossPct) return `Règle du desk : perte du jour ${desk.lossTodayPct} % (limite ${dailyLossPct} %), positions ouvertes comprises. Stop pour aujourd’hui.`;
  if (desk.tradesToday >= desk.maxTradesPerDay) return `Règle du desk : ${desk.maxTradesPerDay} trades maximum par jour sur ton compte (déjà ${desk.tradesToday} aujourd’hui). Reprends demain.`;
  if (desk.lossStreakToday >= desk.maxLossesInARow) return `Règle du desk : ${desk.lossStreakToday} pertes d’affilée aujourd’hui sur ton compte. Stop pour la journée.`;
  if (desk.open.some(o => o.pair === pair)) return `Règle du desk : une position est déjà ouverte sur ${pair} dans cTrader. Un seul trade à la fois par actif.`;
  const side = usdSide(pair, direction);
  const same = desk.open.find(o => usdSide(o.pair, o.direction) === side && side !== 'neutral');
  if (same) return `Règle du desk : ${same.direction === 'acheter' ? 'achat' : 'vente'} ${same.pair} déjà ouvert dans cTrader, même exposition au dollar. Attends qu’il soit clôturé.`;
  return null;
}
