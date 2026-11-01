import { useEffect, useRef, useState } from 'react';
import { FlaskConical, Loader2 } from 'lucide-react';
import type { BacktestJob, LabStats, RiskSettings, VariantStats } from '../types';
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
      if (j.status === 'en cours' && !timer.current) timer.current = setInterval(poll, 3000);
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
      if (!timer.current) timer.current = setInterval(poll, 3000);
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
        À titre d’information seulement : n’entre pas dans le verdict ni dans la viabilité (calculée sur tes trades suivis). Rejoue le moteur sur les vraies bougies M15 passées (jusqu’à 2 ans), avec tes coûts. Calcul de plusieurs minutes : garde cet écran ouvert.
      </p>
      {error && <p className="text-xs text-down">{error}</p>}
      {job.status === 'erreur' && <p className="text-xs text-down">Erreur : {job.error}</p>}
      {job.status === 'en cours' && (
        <div>
          <div className="mb-1 text-[11px] text-mute">{job.phase}</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-card2">
            <div className="h-full bg-gold transition-all" style={{ width: `${job.progress ?? 0}%` }} />
          </div>
        </div>
      )}
      {res && (
        <>
          <p className="text-[11px] text-mute">
            Période : {localDateTime(res.from)} → {localDateTime(res.to)} ({Math.round((res.to - res.from) / 86_400_000)} jours, {res.m15Count.toLocaleString('fr-FR')} bougies M15) · {res.source}
            {res.limitedBySource && ' · historique maximal fourni par la source'}
          </p>
          <div className="label">Toute la période</div>
          <div className="grid grid-cols-2 gap-2">
            <Variant title="Sweep obligatoire (ta règle)" v={res.strict} />
            <Variant title="Sweep en bonus" v={res.souple} />
          </div>
          {Math.min(res.strict.trades, res.souple.trades) < 100 && (
            <p className="text-[11px] leading-snug text-warn">
              Moins de 100 trades sur une des deux règles : échantillon encore trop petit pour trancher.
            </p>
          )}
          <div className="label pt-1">Depuis le gel des règles ({localDateTime(res.frozenFrom)}, version {res.rulesVersion})</div>
          <p className="text-[11px] leading-snug text-mute">
            Signaux apparus après la date où les règles ont été figées : ils n’ont pas pu influencer la conception du moteur. C’est l’équivalent d’un suivi en direct ; il se remplit semaine après semaine.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Variant title="Sweep obligatoire" v={res.strictForward} />
            <Variant title="Sweep en bonus" v={res.soupleForward} />
          </div>
          {res.lab && <LabTable lab={res.lab} />}
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

function LabTable({ lab }: { lab: NonNullable<NonNullable<BacktestJob['result']>['lab']> }) {
  const fmtR = (s: LabStats | null) => (s && s.avgR !== null ? `${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)} R` : '—');
  const cls = (s: LabStats | null) => (s && s.avgR !== null ? (s.avgR > 0 ? 'text-up' : s.avgR < 0 ? 'text-down' : '') : 'text-mute');
  return (
    <div className="space-y-2 pt-1">
      <div className="label">Labo d’optimisation</div>
      <p className="text-[11px] leading-snug text-mute">
        Chaque variante est notée sur la 1re moitié (jusqu’au {localDateTime(lab.splitAt)}). La 2e moitié, jamais utilisée pour choisir, n’est révélée que pour les 3 meilleures et la référence : c’est le vrai test.
      </p>
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 bg-card2 px-2 py-1.5 text-[10px] uppercase tracking-wide text-mute">
          <span>Variante</span>
          <span className="text-right">1re moitié</span>
          <span className="text-right">2e moitié</span>
        </div>
        {lab.variants.map(v => (
          <div key={v.id} className={cx('grid grid-cols-[1fr_auto_auto] items-center gap-x-3 border-t border-line px-2 py-1.5 text-[11px]', v.id === 'base' && 'bg-white/5')}>
            <span className="leading-tight">{v.label}</span>
            <span className={cx('num text-right', cls(v.inSample))}>
              {fmtR(v.inSample)}
              <span className="block text-[9px] text-mute">{v.inSample.trades} tr.</span>
            </span>
            <span className={cx('num text-right', cls(v.outOfSample))}>
              {v.outOfSample ? fmtR(v.outOfSample) : 'masquée'}
              {v.outOfSample && <span className="block text-[9px] text-mute">{v.outOfSample.trades} tr.</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
