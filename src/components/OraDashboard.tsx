// Tableau de bord ORA Trader : panneau de validation, plan de trade validé, bouton « Prendre le Trade » et journal.
// Le moteur et le journal viennent directement de server/smcMasterEngine.ts (fonctions pures partagées).
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleDashed, Clock3, FlaskConical, RefreshCw, Trash2, XCircle } from 'lucide-react';
import {
  calculateJournalStats,
  createJournalEntry,
  updateTradeStatus,
  type JournalEntry as OraJournalEntry,
  type MasterTradePlan,
} from '../../server/smcMasterEngine';
import type { RiskSettings } from '../types';
import { api, costsFor, cx, fmt, loadArray, localDateTime, localTime, lotScale, lotSize, readJson, save } from '../lib/utils';

export interface OraResponse {
  pair: string;
  generatedAt: number;
  plan: MasterTradePlan;
  source: string;
  marketClosed: boolean;
  paused: string | null;
  warnings: string[];
  costs: { spread: number; commissionPerLot: number; contract: number };
  lastM5: number | null;
}

const STATUS_STYLE: Record<MasterTradePlan['status'], string> = {
  VALIDÉ: 'bg-up/15 text-up border-up/40',
  REJETÉ: 'bg-down/15 text-down border-down/40',
  'EN ATTENTE - HORS KILL ZONE': 'bg-warn/15 text-warn border-warn/40',
};

const J_LABEL: Record<OraJournalEntry['status'], { label: string; tone: string }> = {
  OPEN: { label: 'OPEN', tone: 'text-gold' },
  WIN_TP1: { label: 'WIN TP1', tone: 'text-up' },
  WIN_TP2: { label: 'WIN TP2', tone: 'text-up' },
  LOSS: { label: 'LOSS', tone: 'text-down' },
  BREAK_EVEN: { label: 'BREAK EVEN', tone: 'text-mute' },
};

export function OraDashboard({ pair, decimals, settings }: { pair: string; decimals: number; settings: RiskSettings }) {
  const [data, setData] = useState<OraResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [journal, setJournal] = useState<OraJournalEntry[]>(() => loadArray<OraJournalEntry>('ora_journal'));
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => save('ora_journal', journal), [journal]);

  const run = async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const c = costsFor(pair, settings);
      const res = await api(`/api/ora?pair=${encodeURIComponent(pair)}&spread=${c.spread}&commission=${c.commissionPerLot}`);
      const json = await readJson(res);
      if (!res.ok) throw new Error(json?.error || `Erreur ${res.status}`);
      setData(json as OraResponse);
    } catch (e: any) {
      setError(e?.message || 'Analyse ORA impossible.');
      setData(null);
    } finally {
      setLoading(false);
    }
  };
  // nouvel actif : on efface l'analyse précédente (jamais le plan d'un autre actif à l'écran)
  useEffect(() => {
    setData(null);
    setError(null);
  }, [pair]);

  const plan = data?.pair === pair ? data.plan : null;
  const stats = useMemo(() => calculateJournalStats(journal), [journal]);
  const openSame = journal.some(j => j.status === 'OPEN' && j.symbol === pair);
  const blockReason = !plan
    ? null
    : !plan.approved
    ? 'Plan non validé : rien à prendre.'
    : data?.marketClosed
    ? 'Marché fermé.'
    : data?.paused
    ? 'Actif en pause.'
    : openSame
    ? `Un trade ORA est déjà ouvert sur ${pair}.`
    : null;
  const lots = plan?.approved ? lotSize(pair, settings.capital, settings.riskPct, plan.entryPrice, plan.stopLoss, settings.commissionPerLot, lotScale(settings.broker)) : null;

  const take = () => {
    if (!plan || blockReason) return;
    const entry = createJournalEntry(plan);
    if (!entry) return;
    setJournal(prev => [entry, ...prev]);
    setNotice('Trade enregistré dans le journal ORA. Place l’ordre toi-même chez ton broker.');
  };
  const close = (id: string, status: 'WIN_TP1' | 'WIN_TP2' | 'LOSS' | 'BREAK_EVEN') =>
    setJournal(prev =>
      prev.map(j => {
        if (j.id !== id) return j;
        const price = status === 'WIN_TP1' ? j.takeProfit1 : status === 'WIN_TP2' ? j.takeProfit2 : status === 'LOSS' ? j.stopLoss : j.entryPrice;
        return updateTradeStatus(j, status, price);
      })
    );

  return (
    <div className="space-y-3">
      {/* Bandeau : moteur en test */}
      <section className="card flex items-start gap-2 border-warn/40 px-3 py-2">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <p className="text-[11px] leading-snug text-warn">
          Moteur ORA corrigé <span className="font-semibold">en test</span> : il n’est pas encore validé par le backtest sur 2 ans. Le moteur principal reste l’onglet Analyse.
        </p>
      </section>

      <div className="flex items-center gap-2">
        <button onClick={run} disabled={loading} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gold py-3 text-sm font-bold text-bg disabled:opacity-60">
          <RefreshCw className={cx('h-4 w-4', loading && 'animate-spin')} />
          {loading ? 'Analyse ORA…' : `Analyser ${pair} avec ORA`}
        </button>
      </div>
      {error && <div className="card border-down/50 px-3 py-2 text-[11px] text-down">{error}</div>}
      {data?.warnings.map(w => (
        <div key={w} className="card border-warn/50 px-3 py-2 text-[11px] text-warn">{w}</div>
      ))}
      {data?.paused && <div className="card border-warn/50 px-3 py-2 text-[11px] text-warn">{data.paused}</div>}

      {plan && (
        <>
          {/* Statut + score */}
          <section className={cx('card border p-4', STATUS_STYLE[plan.status])}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-bold">{plan.status}</div>
              <div className="num text-sm font-semibold">Confiance {plan.confidenceScore} %</div>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-card2">
              <div className={cx('h-full', plan.confidenceScore === 100 ? 'bg-up' : plan.confidenceScore >= 50 ? 'bg-warn' : 'bg-down')} style={{ width: `${plan.confidenceScore}%` }} />
            </div>
            <p className="mt-2 text-[11px] text-ink/80">
              {plan.steps.filter(s => s.ok).length}/6 confluences validées · bougie M5 {plan.killZone.candleTime ? localTime(plan.killZone.candleTime) : '—'} ·{' '}
              {plan.killZone.active ? `kill zone ${plan.killZone.name}` : 'hors kill zone (07–10 / 13–16 UTC)'}
            </p>
          </section>

          {/* Panneau de validation */}
          <section className="card p-4">
            <div className="label mb-2">Validation ORA (toutes obligatoires)</div>
            <ol className="space-y-2">
              {plan.steps.map((s, i) => (
                <li key={s.key} className="flex gap-2 text-[12px]">
                  {s.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-up" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-down" />}
                  <span>
                    <span className="font-semibold">
                      {i + 1}. {s.label}
                    </span>
                    <span className="text-mute"> — {s.detail}</span>
                  </span>
                </li>
              ))}
              <li className="flex gap-2 text-[12px]">
                {plan.killZone.active ? <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-up" /> : <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-warn" />}
                <span>
                  <span className="font-semibold">Kill zone</span>
                  <span className="text-mute"> — {plan.killZone.active ? `${plan.killZone.name} active.` : 'hors fenêtre : statut en attente.'}</span>
                </span>
              </li>
            </ol>
          </section>

          {/* Plan de trade */}
          {plan.direction && (
            <section className={cx('card p-4', plan.approved ? 'border-up/50' : 'opacity-80')}>
              <div className="mb-3 flex items-center justify-between">
                <div className="label">{plan.approved ? 'Plan de Trade Validé' : 'Plan de trade (non validé)'}</div>
                <span className={cx('rounded-md px-2 py-0.5 text-xs font-bold', plan.direction === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>{plan.direction}</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
                <Level label="Entrée (marché)" value={fmt(plan.entryPrice, decimals)} />
                <Level label="Stop Loss" value={fmt(plan.stopLoss, decimals)} tone="text-down" />
                <Level label={`TP1 · 1:${plan.rr1 ?? '—'}`} value={fmt(plan.takeProfit1, decimals)} tone="text-up" />
                <Level label={`TP2 · 1:${plan.rr2 ?? '—'}`} value={fmt(plan.takeProfit2, decimals)} tone="text-up" />
              </div>
              {lots !== null && (
                <p className="mt-2 text-[11px] text-mute">
                  Taille : <span className="num text-ink">{fmt(lots, 2)} lot</span> pour {settings.riskPct} % de {settings.capital.toLocaleString('fr-FR')} $ (commission incluse).
                </p>
              )}
              <button
                onClick={take}
                disabled={!!blockReason}
                className="mt-3 w-full rounded-xl bg-up py-2.5 text-sm font-bold text-bg disabled:cursor-not-allowed disabled:bg-card2 disabled:text-mute"
              >
                📌 Prendre le Trade
              </button>
              {blockReason && <p className="mt-1 text-center text-[11px] text-mute">{blockReason}</p>}
              {notice && <p className="mt-1 text-center text-[11px] text-up">{notice}</p>}
            </section>
          )}
        </>
      )}

      {/* Journal ORA */}
      <section className="card p-4">
        <div className="label mb-3">Journal de Trading ORA</div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="Trades clôturés" value={String(stats.totalTrades)} />
          <Stat label="Win rate" value={`${stats.winRate} %`} tone={stats.totalTrades ? (stats.winRate >= 50 ? 'text-up' : 'text-down') : undefined} />
          <Stat label="Pips cumulés" value={`${stats.totalPips > 0 ? '+' : ''}${stats.totalPips}`} tone={stats.totalPips > 0 ? 'text-up' : stats.totalPips < 0 ? 'text-down' : undefined} />
        </div>
        <p className="mt-2 text-[10px] text-mute">
          {stats.wins} gagnés · {stats.losses} perdus · {stats.breakEvens} à zéro · moyenne {stats.averageProfitPips} pips par trade · or : 1 pip = 0,10 $
        </p>
        {journal.length === 0 ? (
          <p className="mt-3 text-[12px] text-mute">Aucun trade ORA pour l’instant.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {journal.map(j => (
              <li key={j.id} className="rounded-lg bg-card2 p-3 text-[12px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">
                    <span className={j.direction === 'BUY' ? 'text-up' : 'text-down'}>{j.direction}</span> {j.symbol}
                  </span>
                  <span className={cx('text-[11px] font-bold', J_LABEL[j.status].tone)}>
                    {J_LABEL[j.status].label}
                    {j.pnlPips !== undefined && j.status !== 'OPEN' ? ` · ${j.pnlPips > 0 ? '+' : ''}${j.pnlPips} pips` : ''}
                  </span>
                </div>
                <div className="num mt-1 text-[11px] text-mute">
                  {localDateTime(j.timestamp)} · E {fmt(j.entryPrice, decimals)} · SL {fmt(j.stopLoss, decimals)} · TP1 {fmt(j.takeProfit1, decimals)} · TP2 {fmt(j.takeProfit2, decimals)} · {j.confidenceScore} %
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {j.status === 'OPEN' &&
                    (['WIN_TP1', 'WIN_TP2', 'LOSS', 'BREAK_EVEN'] as const).map(s => (
                      <button key={s} onClick={() => close(j.id, s)} className="rounded-md border border-line px-2 py-1 text-[10px] font-semibold text-ink hover:border-gold">
                        {J_LABEL[s].label}
                      </button>
                    ))}
                  <button onClick={() => setJournal(prev => prev.filter(x => x.id !== j.id))} className="ml-auto rounded-md px-2 py-1 text-[10px] text-mute hover:text-down" aria-label="Supprimer">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Level({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-card2 px-2.5 py-2">
      <div className="text-[10px] text-mute">{label}</div>
      <div className={cx('num text-sm font-semibold', tone)}>{value}</div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-card2 px-2 py-2">
      <div className="text-[10px] text-mute">{label}</div>
      <div className={cx('num text-base font-bold', tone)}>{value}</div>
    </div>
  );
}
