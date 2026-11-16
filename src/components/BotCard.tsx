import { Bot } from 'lucide-react';
import type { BotEventView, FxJournalView } from './FxJournalCard';
import { cx, localDateTime } from '../lib/utils';

const TYPE: Record<BotEventView['type'], { label: string; tone: string }> = {
  ordre_passe: { label: 'Ordre passé', tone: 'bg-up/15 text-up' },
  refuse: { label: 'Refusé', tone: 'bg-warn/15 text-warn' },
  stop_remonte: { label: 'Stop remonté', tone: 'bg-gold/15 text-gold' },
  erreur: { label: 'Erreur', tone: 'bg-down/15 text-down' },
};
const sign = (v: number) => (v >= 0 ? '+' : '');

/** Historique du bot de test démo : état, décisions (ordres passés, refus, stops remontés) et résultat de ses trades. */
export function BotCard({ data }: { data: FxJournalView | null }) {
  if (!data?.botStatus) return null;
  const st = data.botStatus;
  const events = data.botEvents ?? [];
  if (st.mode === 'éteint' && !events.length) return null;
  const trades = data.trades.filter(t => t.botId);
  // un trade du bot = deux positions (moitié TP1 + moitié TP2) : on les regroupe
  const groups = new Map<string, typeof trades>();
  for (const t of trades) groups.set(t.botId as string, [...(groups.get(t.botId as string) ?? []), t]);
  const rows = [...groups.entries()]
    .map(([id, ts]) => {
      const closed = ts.every(t => t.closedAt !== null);
      const net = ts.every(t => t.net !== null) ? ts.reduce((s, t) => s + (t.net as number), 0) : null;
      const risk = ts.reduce((s, t) => s + (t.riskUsd ?? 0), 0);
      return {
        id,
        t: ts[0],
        lots: Number(ts.reduce((s, t) => s + t.lots, 0).toFixed(2)),
        openedAt: Math.min(...ts.map(t => t.openedAt)),
        closed,
        net,
        r: closed && net !== null && risk > 0 ? Number((net / risk).toFixed(2)) : null,
        exits: ts.map(t => (t.exit !== null ? t.exit : null)),
      };
    })
    .sort((a, b) => b.openedAt - a.openedAt);
  const s = data.botStats;
  const on = st.mode === 'demo';
  return (
    <section className="card space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="label flex items-center gap-1.5">
          <Bot className="h-3.5 w-3.5 text-gold" /> Bot de test · compte démo
        </div>
        <span className={cx('rounded px-1.5 py-0.5 text-xs font-bold', on && st.ok ? 'bg-up/15 text-up' : on ? 'bg-warn/15 text-warn' : 'bg-card2 text-mute')}>
          {on ? (st.ok ? 'ACTIF' : 'EN ATTENTE') : 'ÉTEINT'}
        </span>
      </div>
      {on && !st.ok && <p className="text-xs leading-snug text-warn">{st.reason}</p>}
      {s && (
        <div className="rounded-lg bg-card2 px-3 py-2 text-xs leading-snug">
          <span className="font-semibold">Trades du bot : </span>
          {s.closed} clos
          {s.avgR !== null ? ` · ${sign(s.avgR)}${s.avgR} R moy.` : ''}
          {s.winRate !== null ? ` · ${s.winRate} % gagnants` : ''}
          {s.closed ? ` · ${sign(s.netUsd)}${s.netUsd.toFixed(2)} $` : ''}
          {!s.closed && ' · aucun trade clos pour l’instant'}
        </div>
      )}
      {rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-line">
          {rows.map(r => (
            <div key={r.id} className="border-t border-line px-2 py-1.5 text-xs first:border-t-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">
                  {r.t.pair} · {r.t.direction === 'acheter' ? 'achat' : 'vente'} · {r.lots} lot
                </span>
                <span className={cx('num', r.net === null ? 'text-mute' : r.net > 0 ? 'text-up' : r.net < 0 ? 'text-down' : '')}>
                  {r.net === null ? (r.closed ? '—' : 'en cours') : `${sign(r.net)}${r.net.toFixed(2)} $${r.r !== null ? ` · ${sign(r.r)}${r.r} R` : ''}`}
                </span>
              </div>
              <div className="text-mute">
                {localDateTime(r.openedAt)} · entrée {r.t.entry}
                {r.exits.some(e => e !== null) ? ` · sorties ${r.exits.filter(e => e !== null).join(' / ')}` : ''}
                {r.t.stop !== null ? ` · stop ${r.t.stop}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="label pt-1">Décisions du bot</div>
      {events.length === 0 ? (
        <p className="text-xs text-mute">Aucune décision pour l’instant : le bot agit quand une alerte « ordre prêt » arrive.</p>
      ) : (
        <div className="space-y-1.5">
          {events.slice(0, 30).map(e => (
            <div key={e.id} className="rounded-lg bg-card2 px-2 py-1.5 text-xs leading-snug">
              <div className="flex items-center gap-2">
                <span className={cx('rounded px-1.5 py-0.5 font-bold', TYPE[e.type].tone)}>{TYPE[e.type].label}</span>
                <span className="text-mute">{localDateTime(e.at)}</span>
                {e.pair && <span className="font-semibold">{e.pair}</span>}
                {e.kind && <span className="text-mute">{e.kind === 'test' ? 'TEST' : 'protocole'}</span>}
              </div>
              <p className="mt-0.5 text-ink/90">{e.message}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
