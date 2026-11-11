// Journal automatique : positions clôturées lues sur le compte cTrader (FxPro), en lecture seule.
// Chaque position est rapprochée du signal de l'app qui l'a proposée (protocole ou TEST) ; le R est calculé
// sur le résultat NET réel (frais et swap compris) et le risque réel (entrée réelle → stop du plan).
// La même liste est servie à tous tes appareils : plus de saisie à la main, plus de journal par navigateur.
import type { CTraderClient } from './ctrader';
import type { Annotation, SignalRec, StoreData, TradeKind } from './journalStore';

/** Taille d'un lot standard (unités de l'actif). */
export const CONTRACT: Record<string, number> = { 'EUR/USD': 100_000, 'XAU/USD': 100 };
/** Historique relu à chaque fois. */
export const HISTORY_DAYS = 120;
const MIN_TRADES = 30;
const MATCH_BEFORE = 15 * 60_000;
const MATCH_AFTER = 30 * 60_000;

export interface FxTrade {
  positionId: string;
  pair: string;
  direction: 'acheter' | 'vendre';
  lots: number;
  openedAt: number;
  closedAt: number | null;
  entry: number;
  exit: number | null;
  /** résultat net en $ (brut + swap + frais) ; null si la position est encore ouverte */
  net: number | null;
  gross: number | null;
  fees: number | null;
  stop: number | null;
  stopSource: 'plan' | 'ordre' | 'saisi' | null;
  /** risque réel en $ : |entrée réelle − stop| × taille */
  riskUsd: number | null;
  /** R net réel = résultat net / risque réel */
  r: number | null;
  kind: TradeKind;
  kindSource: 'signal' | 'saisi' | 'aucun';
  signal: SignalRec | null;
  /** écarts avec le plan proposé (entrée au marché au lieu de la limite, etc.) */
  gaps: string[];
  note: string;
}

export interface FxStats {
  /** positions clôturées (avec ou sans R) */
  closed: number;
  /** clôturées dont le R est connu (stop connu) : base des statistiques en R */
  withR: number;
  /** clôturées sans R : stop introuvable, à saisir */
  missingStop: number;
  wins: number;
  winRate: number | null;
  totalR: number;
  avgR: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  viability: number | null;
  minTrades: number;
  netUsd: number;
}

const num = (v: any) => (v === undefined || v === null || v === '' ? null : Number(v));
const isBuy = (side: any) => side === 1 || side === '1' || String(side).toUpperCase() === 'BUY';
const filled = (d: any) => d.dealStatus === undefined || d.dealStatus === 2 || d.dealStatus === '2' || String(d.dealStatus).toUpperCase() === 'FILLED' || String(d.dealStatus).toUpperCase() === 'PARTIALLY_FILLED';
const money = (v: any, md: number) => (num(v) ?? 0) / 10 ** md;

function normCdf(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

export function fxStats(trades: FxTrade[]): FxStats {
  const closedAll = trades.filter(t => t.closedAt !== null);
  const done = closedAll.filter(t => t.r !== null);
  const rs = done.map(t => t.r as number);
  const n = rs.length;
  const totalR = rs.reduce((s, r) => s + r, 0);
  const avgR = n ? totalR / n : null;
  let viability: number | null = null;
  let ciLow: number | null = null;
  let ciHigh: number | null = null;
  if (n >= MIN_TRADES && avgR !== null) {
    const sd = Math.sqrt(rs.reduce((s, r) => s + (r - avgR) ** 2, 0) / (n - 1));
    const se = sd / Math.sqrt(n);
    viability = sd > 0 ? Math.round(normCdf(avgR / se) * 100) : avgR > 0 ? 100 : 0;
    ciLow = Number((avgR - 1.96 * se).toFixed(2));
    ciHigh = Number((avgR + 1.96 * se).toFixed(2));
  }
  // gagnants : selon le R quand il est connu, sinon selon le résultat net
  const wins = closedAll.filter(t => (t.r ?? t.net ?? 0) > 0).length;
  const netUsd = closedAll.filter(t => t.net !== null).reduce((s, t) => s + (t.net as number), 0);
  return {
    closed: closedAll.length,
    withR: n,
    missingStop: closedAll.length - n,
    wins,
    winRate: closedAll.length ? Math.round((wins / closedAll.length) * 100) : null,
    totalR: Number(totalR.toFixed(2)),
    avgR: avgR === null ? null : Number(avgR.toFixed(2)),
    ciLow,
    ciHigh,
    viability,
    minTrades: MIN_TRADES,
    netUsd: Number(netUsd.toFixed(2)),
  };
}

/** Signal de l'app le plus récent compatible avec l'ouverture (même actif, même sens, pendant sa validité). */
export function matchSignal(signals: SignalRec[], pair: string, direction: string, openedAt: number): SignalRec | null {
  let best: SignalRec | null = null;
  for (const s of signals) {
    if (s.pair !== pair || s.direction !== direction) continue;
    const end = (s.validUntil ?? s.at + 4 * 3_600_000) + MATCH_AFTER;
    if (openedAt < s.at - MATCH_BEFORE || openedAt > end) continue;
    // à égalité de fenêtre, le protocole prime sur le TEST, puis le plus récent
    if (!best || (s.kind === 'protocole' && best.kind === 'test') || (s.kind === best.kind && s.at > best.at)) best = s;
  }
  return best;
}

/** Construit les trades à partir des deals et ordres bruts de cTrader. */
export function buildTrades(deals: any[], orders: any[], pairOf: (symbolId: number) => string | null, store: StoreData, decimals: Record<string, number>): FxTrade[] {
  const byPos = new Map<string, any[]>();
  for (const d of deals) {
    if (!filled(d) || d.positionId === undefined) continue;
    const k = String(d.positionId);
    if (!byPos.has(k)) byPos.set(k, []);
    byPos.get(k)!.push(d);
  }
  const orderById = new Map<string, any>(orders.map(o => [String(o.orderId), o]));
  const out: FxTrade[] = [];
  for (const [positionId, ds] of byPos) {
    ds.sort((a, b) => Number(a.executionTimestamp ?? a.createTimestamp) - Number(b.executionTimestamp ?? b.createTimestamp));
    const opening = ds.filter(d => !d.closePositionDetail);
    const closing = ds.filter(d => !!d.closePositionDetail);
    const first = opening[0] ?? closing[0];
    const pair = pairOf(Number(first.symbolId));
    if (!pair) continue; // autre actif que ceux de l'app
    const dec = decimals[pair] ?? 5;
    const long = opening.length ? isBuy(opening[0].tradeSide) : !isBuy(closing[0].tradeSide);
    const openedAt = Number(first.executionTimestamp ?? first.createTimestamp);
    const openUnits = opening.reduce((s, d) => s + (num(d.filledVolume) ?? num(d.volume) ?? 0), 0) / 100;
    const closedUnits = closing.reduce((s, d) => s + (num(d.closePositionDetail.closedVolume) ?? num(d.filledVolume) ?? 0), 0) / 100;
    const units = closedUnits || openUnits;
    const entryFromClose = closing.length ? num(closing[0].closePositionDetail.entryPrice) : null;
    const entry =
      entryFromClose ??
      (opening.length ? opening.reduce((s, d) => s + Number(d.executionPrice) * (num(d.filledVolume) ?? 0), 0) / Math.max(1, opening.reduce((s, d) => s + (num(d.filledVolume) ?? 0), 0)) : Number(first.executionPrice));
    const isClosed = closing.length > 0 && (!openUnits || closedUnits >= openUnits - 1e-9);
    let exit: number | null = null;
    let gross: number | null = null;
    let fees: number | null = null;
    let net: number | null = null;
    if (closing.length) {
      const vol = closing.reduce((s, d) => s + (num(d.closePositionDetail.closedVolume) ?? 0), 0) || 1;
      exit = closing.reduce((s, d) => s + Number(d.executionPrice) * (num(d.closePositionDetail.closedVolume) ?? 0), 0) / vol;
      gross = 0;
      fees = 0;
      for (const d of closing) {
        const md = num(d.closePositionDetail.moneyDigits) ?? num(d.moneyDigits) ?? 2;
        gross += money(d.closePositionDetail.grossProfit, md);
        fees += money(d.closePositionDetail.commission, md) + money(d.closePositionDetail.swap, md);
      }
      net = gross + fees;
    }
    const direction = long ? 'acheter' : 'vendre';
    const ann: Annotation = store.annotations[positionId] ?? {};
    const signal = matchSignal(store.signals, pair, direction, openedAt);
    // stop posé à l'ouverture : absolu (stopLoss) ou relatif à l'entrée (relativeStopLoss, en 1/100000 de prix),
    // sinon sur un autre ordre de la même position (stop ajouté ou modifié ensuite)
    const openOrder = opening.length ? orderById.get(String(opening[0].orderId)) : null;
    const stopOf = (o: any): number | null => {
      if (!o) return null;
      const abs = num(o.stopLoss);
      if (abs !== null && abs > 0) return abs;
      const rel = num(o.relativeStopLoss);
      if (rel !== null && rel > 0) return long ? entry - rel / 100_000 : entry + rel / 100_000;
      return null;
    };
    const orderStop =
      stopOf(openOrder) ?? orders.filter(o => String(o.positionId) === positionId).map(stopOf).find((v): v is number => v !== null) ?? null;
    const annStop = num(ann.sl);
    const stop = annStop ?? signal?.sl ?? orderStop ?? null;
    const stopSource: FxTrade['stopSource'] = annStop !== null ? 'saisi' : signal ? 'plan' : orderStop !== null ? 'ordre' : null;
    const riskUsd = stop !== null && units ? Math.abs(entry - stop) * units : null;
    const r = isClosed && net !== null && riskUsd ? Number((net / riskUsd).toFixed(2)) : null;
    const kind: TradeKind = ann.kind ?? signal?.kind ?? 'hors';
    const gaps: string[] = [];
    if (signal) {
      const tol = 10 ** -dec * (pair === 'XAU/USD' ? 50 : 5);
      if (Math.abs(entry - signal.entry) > tol) gaps.push(`entrée réelle ${entry.toFixed(dec)} au lieu de ${signal.entry.toFixed(dec)} (plan)`);
    }
    out.push({
      positionId,
      pair,
      direction,
      lots: Number((units / (CONTRACT[pair] ?? 100_000)).toFixed(2)),
      openedAt,
      closedAt: isClosed ? Number(closing[closing.length - 1].executionTimestamp ?? closing[closing.length - 1].createTimestamp) : null,
      entry: Number(entry.toFixed(dec)),
      exit: exit === null ? null : Number(exit.toFixed(dec)),
      net: isClosed && net !== null ? Number(net.toFixed(2)) : null,
      gross: isClosed && gross !== null ? Number(gross.toFixed(2)) : null,
      fees: isClosed && fees !== null ? Number(fees.toFixed(2)) : null,
      stop,
      stopSource,
      riskUsd: riskUsd === null ? null : Number(riskUsd.toFixed(2)),
      r,
      kind,
      kindSource: ann.kind ? 'saisi' : signal ? 'signal' : 'aucun',
      signal,
      gaps,
      note: ann.note ?? '',
    });
  }
  return out.sort((a, b) => b.openedAt - a.openedAt);
}

export interface FxJournal {
  available: boolean;
  error: string | null;
  persistent: boolean;
  storeError: string | null;
  account: { login: number | null; broker: string | null } | null;
  trades: FxTrade[];
  /** trades proposés par l'app (protocole + TEST) : c'est la mesure de pertinence de ses analyses */
  stats: FxStats;
  protocole: FxStats;
  test: FxStats;
  hors: FxStats;
  updatedAt: number;
}

let cache: { at: number; value: FxJournal } | null = null;

export function invalidateFxJournal() {
  cache = null;
}

/** Journal complet (cache 60 s). */
export async function getFxJournal(
  client: CTraderClient | null,
  store: { get(): Promise<StoreData>; persistent: boolean; lastError: string | null },
  decimals: Record<string, number>,
  now = Date.now()
): Promise<FxJournal> {
  if (cache && now - cache.at < 60_000) return cache.value;
  const data = await store.get();
  const base = (trades: FxTrade[], error: string | null): FxJournal => {
    const app = trades.filter(t => t.kind !== 'hors');
    return {
      available: !!client && !error,
      error,
      persistent: store.persistent,
      storeError: store.lastError,
      account: client?.accountInfo ?? null,
      trades,
      stats: fxStats(app),
      protocole: fxStats(trades.filter(t => t.kind === 'protocole')),
      test: fxStats(trades.filter(t => t.kind === 'test')),
      hors: fxStats(trades.filter(t => t.kind === 'hors')),
      updatedAt: now,
    };
  };
  if (!client) return base([], 'cTrader non configuré : le journal automatique lit tes positions sur ton compte FxPro.');
  try {
    const from = now - HISTORY_DAYS * 86_400_000;
    const deals = await client.deals(from, now);
    let ordersError: string | null = null;
    const orders = await client.orders(from, now).catch(e => {
      ordersError = String(e?.message || e);
      return [];
    });
    if (ordersError) console.warn('[journal] ordres cTrader indisponibles (stops non lus) :', ordersError);
    const value = base(buildTrades(deals, orders, id => client.pairOfSymbol(id), data, decimals), null);
    cache = { at: now, value };
    return value;
  } catch (e: any) {
    return base([], `Historique cTrader indisponible : ${String(e?.message || e).slice(0, 200)}`);
  }
}
