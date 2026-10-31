import { useEffect, useRef, useState } from 'react';
import { FlaskConical, Loader2 } from 'lucide-react';
import type { BacktestJob, RiskSettings, VariantStats } from '../types';
import { api, costsFor, cx, localDateTime } from '../lib/utils';

interface Props {
  pair: string;
  settings: RiskSettings;
}

/** Lance le backtest du moteur sur l'historique réel et affiche la comparaison des deux règles. */
export function BacktestCard({ pair, settings }: Props) {
  const [job, setJob] = useState<BacktestJob>({ status: 'aucun' });
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = async () => {
    try {
      const r = await api(`/api/backtest?pair=${encodeURIComponent(pair)}`);
      const j: BacktestJob = await r.json();
      setJob(j);
      if (j.status !== 'en cours' && timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    } catch {
      /* on réessaie au prochain tour */
    }
  };

  useEffect(() => {
    poll();
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair]);

  const start = async () => {
    setError(null);
    try {
      const r = await api('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pair, ...costsFor(pair, settings) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Erreur');
      setJob(j);
      if (!timer.current) timer.current = setInterval(poll, 5000);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const res = job.result;
  return (
    <section className="card space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="label flex items-center gap-1.5">
          <FlaskConical className="h-3.5 w-3.5 text-gold" /> Backtest du moteur · {pair}
        </div>
        <button
          onClick={start}
          disabled={job.status === 'en cours'}
          className="flex items-center gap-1.5 rounded-md border border-gold px-2.5 py-1 text-[11px] font-semibold text-gold disabled:opacity-50"
        >
          {job.status === 'en cours' && <Loader2 className="h-3 w-3 spin" />}
          {job.status === 'en cours' ? 'Calcul…' : res ? 'Relancer' : 'Lancer'}
        </button>
      </div>
      <p className="text-[11px] leading-snug text-mute">
        Rejoue le moteur toutes les 15 minutes sur environ 2 mois de vraies données, avec tes coûts, et mesure ce qu’auraient donné ses plans. Calcul d’environ une minute.
      </p>
      {error && <p className="text-xs text-down">{error}</p>}
      {job.status === 'erreur' && <p className="text-xs text-down">Erreur : {job.error}</p>}
      {res && (
        <>
          <p className="text-[11px] text-mute">
            Période : {localDateTime(res.from)} → {localDateTime(res.to)} · {res.source}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Variant title="Sweep obligatoire (ta règle)" v={res.strict} />
            <Variant title="Sweep en bonus" v={res.souple} />
          </div>
          {res.strict.trades < 30 && (
            <p className="text-[11px] leading-snug text-warn">
              Moins de 30 trades : échantillon trop petit pour conclure. Relance chaque semaine et compare.
            </p>
          )}
          <details className="text-[11px] text-mute">
            <summary className="cursor-pointer">Hypothèses du test</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {res.assumptions.map(a => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}

function Variant({ title, v }: { title: string; v: VariantStats }) {
  return (
    <div className="rounded-lg bg-card2 p-3">
      <div className="text-[11px] font-semibold">{title}</div>
      <div className={cx('num mt-1 text-xl font-bold', v.totalR > 0 ? 'text-up' : v.totalR < 0 ? 'text-down' : '')}>
        {v.trades ? `${v.totalR >= 0 ? '+' : ''}${v.totalR} R` : '—'}
      </div>
      <div className="mt-1 space-y-0.5 text-[11px] text-mute">
        <div>{v.trades} trades · réussite {v.winRate ?? '—'} %</div>
        <div>moyenne {v.avgR ?? '—'} R · PF {v.profitFactor ?? '—'}</div>
        <div>pire repli {v.maxDrawdownR} R · {v.longestLosingStreak} pertes d’affilée</div>
      </div>
    </div>
  );
}
