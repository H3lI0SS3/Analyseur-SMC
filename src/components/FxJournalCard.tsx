// Journal automatique : positions lues sur ton compte cTrader (FxPro), communes à tous tes appareils.
// Le type (protocole / TEST / hors app), le stop et la note sont modifiables ; tout est sauvegardé côté serveur.
import { useEffect, useState } from 'react';
import { RefreshCw, Wallet } from 'lucide-react';
import { api, cx, localDateTime, readJson } from '../lib/utils';

export interface FxStatsView {
  closed: number;
  withR: number;
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
interface FxTradeView {
  positionId: string;
  pair: string;
  direction: 'acheter' | 'vendre';
  lots: number;
  openedAt: number;
  closedAt: number | null;
  entry: number;
  exit: number | null;
  net: number | null;
  fees: number | null;
  stop: number | null;
  stopSource: 'plan' | 'ordre' | 'saisi' | null;
  riskUsd: number | null;
  r: number | null;
  kind: 'protocole' | 'test' | 'hors';
  kindSource: 'signal' | 'saisi' | 'aucun';
  signal: { entry: number; sl: number; at: number } | null;
  gaps: string[];
  note: string;
}
export interface FxJournalView {
  available: boolean;
  error: string | null;
  persistent: boolean;
  storeError: string | null;
  account: { login: number | null; broker: string | null } | null;
  trades: FxTradeView[];
  stats: FxStatsView;
  protocole: FxStatsView;
  test: FxStatsView;
  hors: FxStatsView;
}

const KINDS = [
  { k: 'protocole', label: 'Protocole' },
  { k: 'test', label: 'TEST' },
  { k: 'hors', label: 'Hors app' },
] as const;

const sign = (v: number) => (v >= 0 ? '+' : '');

export function useFxJournal(refreshKey = 0) {
  const [data, setData] = useState<FxJournalView | null>(null);
  const load = async (refresh = false) => {
    try {
      const res = await api(`/api/journal${refresh ? '?refresh=1' : ''}`);
      if (res.ok) setData((await readJson(res)) as FxJournalView);
    } catch {
      /* hors ligne */
    }
  };
  useEffect(() => {
    load();
    const id = window.setInterval(() => document.visibilityState === 'visible' && load(), 5 * 60_000);
    return () => window.clearInterval(id);
  }, [refreshKey]);
  return { data, reload: load };
}

function StatBox({ title, v, dashed }: { title: string; v: FxStatsView; dashed?: boolean }) {
  return (
    <div className={cx('rounded-lg px-2 py-1.5 text-[11px] leading-snug', dashed ? 'border border-dashed border-gold/60' : 'bg-card2')}>
      <div className="font-semibold">{title}</div>
      <div className="text-mute">
        {v.closed} clos{v.avgR !== null ? ` · ${sign(v.avgR)}${v.avgR} R moy.` : ''}
        {v.winRate !== null ? ` · ${v.winRate} % gagnants` : ''}
        {v.closed ? ` · ${sign(v.netUsd)}${v.netUsd.toFixed(2)} $` : ''}
      </div>
    </div>
  );
}

export function FxJournalCard({ data, reload }: { data: FxJournalView | null; reload: (refresh?: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!data) return null;
  const annotate = async (positionId: string, body: Record<string, unknown>) => {
    setErr(null);
    try {
      const res = await api('/api/journal/annotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ positionId, ...body }) });
      if (!res.ok) throw new Error();
      await reload(true);
    } catch {
      setErr('Enregistrement impossible (connexion ?). Réessaie.');
    }
  };
  const s = data.stats;
  return (
    <section className="card p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="label flex items-center gap-1.5">
          <Wallet className="h-3.5 w-3.5 text-gold" /> Journal FxPro (automatique)
        </div>
        <button
          onClick={async () => {
            setBusy(true);
            await reload(true);
            setBusy(false);
          }}
          className="flex items-center gap-1 rounded-md bg-card2 px-2 py-1 text-[11px] text-mute hover:text-ink"
        >
          <RefreshCw className={cx('h-3 w-3', busy && 'animate-spin')} /> Actualiser
        </button>
      </div>
      {data.error ? (
        <p className="text-[12px] text-warn">{data.error}</p>
      ) : (
        <>
          <p className="text-[11px] leading-snug text-mute">
            Positions lues sur ton compte {data.account?.broker ?? 'cTrader'}
            {data.account?.login ? ` n° ${data.account.login}` : ''} (lecture seule), les mêmes sur tous tes appareils. R = résultat net réel / risque réel (ton entrée → le stop du plan).
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-card2 py-2">
              <div className="num text-lg font-bold">{s.closed}</div>
              <div className="text-[10px] text-mute">trades de l’app clos</div>
            </div>
            <div className="rounded-lg bg-card2 py-2">
              <div className={cx('num text-lg font-bold', s.totalR >= 0 ? 'text-up' : 'text-down')}>{sign(s.totalR)}{s.totalR} R</div>
              <div className="text-[10px] text-mute">{s.avgR !== null ? `${sign(s.avgR)}${s.avgR} R par trade (${s.withR} avec stop)` : 'aucun R calculé'}</div>
            </div>
            <div className="rounded-lg bg-card2 py-2">
              <div className={cx('num text-lg font-bold', s.netUsd >= 0 ? 'text-up' : 'text-down')}>{sign(s.netUsd)}{Math.round(s.netUsd)} $</div>
              <div className="text-[10px] text-mute">{s.winRate !== null ? `${s.winRate} % gagnants` : 'net'}</div>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-mute">
            {s.viability !== null
              ? `Viabilité : ${s.viability} % (R moyen entre ${s.ciLow} et ${s.ciHigh} à 95 %).`
              : `${s.withR}/${s.minTrades} trades avec R : la viabilité s’affichera à partir de ${s.minTrades} trades de l’app (protocole + TEST).`}
          </p>
          {data.trades.some(t => t.closedAt && t.r === null) && (
            <p className="mt-2 rounded-lg border border-warn/40 bg-warn/5 px-2 py-1.5 text-[11px] text-warn">
              {data.trades.filter(t => t.closedAt && t.r === null).length} position(s) clôturée(s) sans stop connu : le R ne peut pas être calculé. Saisis le « stop prévu » sur chaque ligne, et choisis son type (Protocole, TEST ou Hors app).
            </p>
          )}
          <div className="mt-2 grid grid-cols-3 gap-2">
            <StatBox title="Protocole" v={data.protocole} />
            <StatBox title="TEST" v={data.test} dashed />
            <StatBox title="Hors app (non compté)" v={data.hors} />
          </div>
          {!data.persistent && <p className="mt-2 text-[11px] text-warn">Telegram non configuré : les types et notes saisis seront perdus au prochain redémarrage du serveur.</p>}
          {data.storeError && <p className="mt-2 text-[11px] text-warn">{data.storeError}</p>}
          {err && <p className="mt-2 text-[11px] text-warn">{err}</p>}
          {data.trades.length === 0 ? (
            <p className="mt-3 text-[12px] text-mute">Aucune position EUR/USD ou or sur les 120 derniers jours.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {data.trades.map(t => (
                <TradeRow key={t.positionId} t={t} onAnnotate={b => annotate(t.positionId, b)} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function TradeRow({ t, onAnnotate }: { key?: string; t: FxTradeView; onAnnotate: (b: Record<string, unknown>) => void }) {
  const [note, setNote] = useState(t.note);
  const [sl, setSl] = useState(t.stopSource === 'saisi' && t.stop !== null ? String(t.stop) : '');
  useEffect(() => setNote(t.note), [t.note]);
  const long = t.direction === 'acheter';
  return (
    <li className={cx('rounded-lg p-3 text-[12px]', t.kind === 'test' ? 'border border-dashed border-gold/60 bg-card2' : 'bg-card2')}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className={long ? 'text-up' : 'text-down'}>{long ? 'Achat' : 'Vente'}</span> {t.pair} · {t.lots} lot
          <div className="text-[10px] text-mute">
            {localDateTime(t.openedAt)}
            {t.closedAt ? ` → ${localDateTime(t.closedAt)}` : ' · en cours'}
          </div>
        </div>
        <div className="text-right">
          {t.r !== null && <div className={cx('num text-sm font-bold', t.r >= 0 ? 'text-up' : 'text-down')}>{sign(t.r)}{t.r} R</div>}
          {t.net !== null && <div className={cx('num text-[11px]', t.net >= 0 ? 'text-up' : 'text-down')}>{sign(t.net)}{t.net.toFixed(2)} $</div>}
        </div>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <span className="text-mute">Entrée </span>
          <span className="num">{t.entry}</span>
        </div>
        <div>
          <span className="text-mute">Sortie </span>
          <span className="num">{t.exit ?? '—'}</span>
        </div>
        <div>
          <span className="text-mute">Stop </span>
          <span className="num">{t.stop ?? '—'}</span>
          {t.stopSource && <span className="text-[10px] text-mute"> ({t.stopSource === 'plan' ? 'plan' : t.stopSource === 'ordre' ? 'ordre' : 'saisi'})</span>}
        </div>
      </div>
      {t.riskUsd !== null && <div className="mt-1 text-[10px] text-mute">Risque réel : {t.riskUsd.toFixed(0)} $</div>}
      {t.closedAt && t.r === null && <div className="mt-1 text-[10px] font-semibold text-warn">R inconnu : saisis le stop prévu ci-dessous.</div>}
      {t.gaps.map(g => (
        <div key={g} className="mt-1 text-[10px] text-warn">
          Écart avec le plan : {g}
        </div>
      ))}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {KINDS.map(k => (
          <button
            key={k.k}
            onClick={() => onAnnotate({ kind: k.k })}
            className={cx('rounded-md border px-2 py-0.5 text-[11px]', t.kind === k.k ? (k.k === 'test' ? 'border-gold bg-gold text-white' : 'border-ink bg-ink text-white') : 'border-line text-mute')}
          >
            {k.label}
          </button>
        ))}
        <span className="ml-1 text-[10px] text-mute">{t.kindSource === 'signal' ? 'reconnu automatiquement' : t.kindSource === 'saisi' ? 'choisi par toi' : 'aucun signal de l’app trouvé'}</span>
      </div>
      {t.stopSource !== 'plan' && t.closedAt && (
        <div className="mt-2 flex items-center gap-1 text-[11px]">
          <span className="text-mute">Stop prévu (pour le R)</span>
          <input
            value={sl}
            onChange={e => setSl(e.target.value.replace(',', '.'))}
            onBlur={() => sl !== (t.stopSource === 'saisi' && t.stop !== null ? String(t.stop) : '') && onAnnotate({ sl: sl === '' ? null : Number(sl) })}
            inputMode="decimal"
            className="w-24 rounded-md border border-line bg-white px-1.5 py-0.5 num"
            placeholder="ex. 1.12532"
          />
        </div>
      )}
      <input
        value={note}
        onChange={e => setNote(e.target.value)}
        onBlur={() => note !== t.note && onAnnotate({ note })}
        className="mt-2 w-full rounded-md border border-line bg-white px-2 py-1 text-[11px]"
        placeholder="Note (émotion, erreur, leçon…)"
      />
    </li>
  );
}
