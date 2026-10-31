// Historique compact des setups simulés : export depuis un backtest terminé, et rechargement au démarrage.
// Format d'une ligne : sens|zone|UT|session|sweep|amd|pd|entrée|exécuté|R
//   sens a=acheter v=vendre ; zone F=FVG O=OB ; session = index dans SESSIONS ; entrée m=marché l=limite ; R vide = expiré.
import snapshot from './data/history.json';
import type { BtTrade } from './backtest';

export const SESSIONS = [
  'Kill zone de Londres',
  'Kill zone de New York',
  'Session asiatique',
  'Londres (hors kill zone)',
  'New York (hors kill zone)',
  'Ouverture du jour',
];

export interface PairSnapshot {
  from: number;
  to: number;
  generatedAt: number;
  rulesVersion: string;
  rows: string;
}

export function exportTrades(trades: BtTrade[]): string {
  return trades
    .filter(t => t.variant === 'souple' && t.features)
    .map(t => {
      const f = t.features;
      const s = Math.max(0, SESSIONS.indexOf(f.session));
      return [
        f.direction === 'acheter' ? 'a' : 'v',
        f.zoneKind === 'OB' ? 'O' : 'F',
        f.zoneTf,
        s,
        f.sweep ? 1 : 0,
        f.amd ? 1 : 0,
        f.premiumDiscount ? 1 : 0,
        f.entryType === 'marché' ? 'm' : 'l',
        t.filledAt !== null ? 1 : 0,
        t.r === null ? '' : t.r,
      ].join('|');
    })
    .join(';');
}

export function importTrades(rows: string): BtTrade[] {
  if (!rows) return [];
  return rows.split(';').map((line, i) => {
    const [d, k, tf, s, sw, amd, pd, e, f, r] = line.split('|');
    const direction = d === 'a' ? 'acheter' : 'vendre';
    const session = SESSIONS[Number(s)] ?? SESSIONS[0];
    return {
      variant: 'souple',
      signalAt: i,
      filledAt: f === '1' ? i : null,
      exitAt: null,
      direction,
      entry: 0,
      sl: 0,
      tp1: 0,
      tp2: null,
      plannedRR: 0,
      outcome: r === '' ? 'expiré' : Number(r) > 0 ? 'gagné' : 'perdu',
      r: r === '' ? null : Number(r),
      session,
      amdPhase: '',
      features: {
        direction,
        zoneKind: k === 'O' ? 'OB' : 'FVG',
        zoneTf: tf,
        session,
        sweep: sw === '1',
        amd: amd === '1',
        premiumDiscount: pd === '1',
        entryType: e === 'm' ? 'marché' : 'limite',
      },
    } as BtTrade;
  });
}

/** Historique embarqué dans l'app pour un actif (ou null). */
export function bundledSnapshot(pair: string): PairSnapshot | null {
  const p = (snapshot as any).pairs?.[pair];
  return p && typeof p.rows === 'string' && p.rows.length ? (p as PairSnapshot) : null;
}
