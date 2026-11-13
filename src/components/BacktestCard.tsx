import { useEffect, useRef, useState } from 'react';
import { FlaskConical, Loader2 } from 'lucide-react';
import type { BacktestJob, LabStats, RiskSettings, VariantStats } from '../types';
import { api, costsFor, cx, localDateTime, readJson } from '../lib/utils';

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
      const j: BacktestJob = await readJson(r);
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
      const j = await readJson(r);
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
          className="flex items-center gap-1.5 rounded-md border border-gold px-2.5 py-1 text-xs font-semibold text-gold disabled:opacity-50"
        >
          {job.status === 'en cours' && <Loader2 className="h-3 w-3 spin" />}
          {job.status === 'en cours' ? 'Calcul…' : res ? 'Relancer' : 'Lancer'}
        </button>
      </div>
      <p className="text-xs leading-snug text-mute">
        À titre d’information seulement : n’entre pas dans le verdict ni dans la viabilité (calculée sur tes trades suivis). Rejoue le moteur sur les vraies bougies M15 passées (jusqu’à 2 ans), avec tes coûts. Calcul de plusieurs minutes : garde cet écran ouvert.
      </p>
      {error && <p className="text-xs text-down">{error}</p>}
      {job.status === 'erreur' && <p className="text-xs text-down">Erreur : {job.error}</p>}
      {job.status === 'en cours' && (
        <div>
          <div className="mb-1 text-xs text-mute">{job.phase}</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-card2">
            <div className="h-full bg-gold transition-all" style={{ width: `${job.progress ?? 0}%` }} />
          </div>
        </div>
      )}
      {res && (
        <>
          <p className="text-xs text-mute">
            Période : {localDateTime(res.from)} → {localDateTime(res.to)} ({Math.round((res.to - res.from) / 86_400_000)} jours, {res.m15Count.toLocaleString('fr-FR')} bougies M15) · {res.source}
            {res.limitedBySource && ' · historique maximal fourni par la source'}
          </p>
          <div className="label">Toute la période</div>
          <div className="grid grid-cols-2 gap-2">
            <Variant title="Protocole complet" v={res.strict} />
            <Variant title="Protocole + entraînement (TEST)" v={res.souple} />
          </div>
          {Math.min(res.strict.trades, res.souple.trades) < 100 && (
            <p className="text-xs leading-snug text-warn">
              Moins de 100 trades sur une des deux règles : échantillon encore trop petit pour trancher.
            </p>
          )}
          {res.lab && <LabTable lab={res.lab} />}
          {res.breakdown && <BreakdownTable b={res.breakdown} />}
          {res.management && <ManagementTable m={res.management} />}
          <details className="text-xs text-mute">
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
      <div className="text-xs font-semibold">{title}</div>
      <div className={cx('num mt-1 text-xl font-bold', v.totalR > 0 ? 'text-up' : v.totalR < 0 ? 'text-down' : '')}>
        {v.trades ? `${v.totalR >= 0 ? '+' : ''}${v.totalR} R` : '—'}
      </div>
      <div className="mt-1 space-y-0.5 text-xs text-mute">
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
      <p className="text-xs leading-snug text-mute">
        Chaque variante est notée sur la 1re moitié (jusqu’au {localDateTime(lab.splitAt)}). La 2e moitié, jamais utilisée pour choisir, n’est révélée que pour les 3 meilleures, la référence et l’entrée affinée M5 (hypothèse annoncée avant le test) : c’est le vrai test.
      </p>
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 bg-card2 px-2 py-1.5 text-xs uppercase tracking-wide text-mute">
          <span>Variante</span>
          <span className="text-right">1re moitié</span>
          <span className="text-right">2e moitié</span>
        </div>
        {lab.variants.map(v => (
          <div key={v.id} className={cx('grid grid-cols-[1fr_auto_auto] items-center gap-x-3 border-t border-line px-2 py-1.5 text-xs', v.id === 'base' && 'bg-white/5')}>
            <span className="leading-tight">{v.label}</span>
            <span className={cx('num text-right', cls(v.inSample))}>
              {fmtR(v.inSample)}
              <span className="block text-xs text-mute">{v.inSample.trades} tr.</span>
            </span>
            <span className={cx('num text-right', cls(v.outOfSample))}>
              {v.outOfSample ? fmtR(v.outOfSample) : 'masquée'}
              {v.outOfSample && <span className="block text-xs text-mute">{v.outOfSample.trades} tr.</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ventilation par condition manquante : mesure seule, les deux moitiés sont toujours affichées. */
function BreakdownTable({ b }: { b: NonNullable<NonNullable<BacktestJob['result']>['breakdown']> }) {
  const fmtR = (s: LabStats) => (s.avgR !== null ? `${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)} R` : '—');
  const cls = (s: LabStats) => (s.avgR !== null ? (s.avgR > 0 ? 'text-up' : s.avgR < 0 ? 'text-down' : '') : 'text-mute');
  return (
    <div className="space-y-2 pt-1">
      <div className="label">Ventilation par condition manquante</div>
      <p className="text-xs leading-snug text-mute">{b.criterion} Coupure entre les moitiés : {localDateTime(b.splitAt)}.</p>
      {(['M5', 'M5 marché', 'M15'] as const).map(exec =>
        b.rows.some(r => r.exec === exec) ? (
          <div key={exec} className="overflow-hidden rounded-lg border border-line">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 bg-card2 px-2 py-1.5 text-xs uppercase tracking-wide text-mute">
              <span>Exécution {exec === 'M5 marché' ? 'M5, entrée au marché après le CHoCH' : exec}</span>
              <span className="text-right">/ jour</span>
              <span className="text-right">1re moitié</span>
              <span className="text-right">2e moitié</span>
            </div>
            {b.rows
              .filter(r => r.exec === exec)
              .map(r => (
                <div key={r.id} className={cx('grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 border-t border-line px-2 py-1.5 text-xs', r.passes && 'bg-up/5')}>
                  <span className="leading-tight">
                    {r.label}
                    {r.passes && <span className="ml-1 text-xs font-semibold text-up">✓ critère</span>}
                  </span>
                  <span className="num text-right">{r.tradesPerDay}</span>
                  <span className={cx('num text-right', cls(r.firstHalf))}>
                    {fmtR(r.firstHalf)}
                    <span className="block text-xs text-mute">{r.firstHalf.trades} tr.</span>
                  </span>
                  <span className={cx('num text-right', cls(r.secondHalf))}>
                    {fmtR(r.secondHalf)}
                    <span className="block text-xs text-mute">{r.secondHalf.trades} tr.</span>
                  </span>
                </div>
              ))}
          </div>
        ) : null
      )}
    </div>
  );
}

/** Gestion de sortie : actuelle (50 % à TP1) contre stop remonté sur TP1 à l'approche de TP2. */
function ManagementTable({ m }: { m: NonNullable<NonNullable<BacktestJob['result']>['management']> }) {
  const fmtR = (s: LabStats) => (s.avgR !== null ? `${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)} R` : '—');
  const cls = (s: LabStats) => (s.avgR !== null ? (s.avgR > 0 ? 'text-up' : s.avgR < 0 ? 'text-down' : '') : 'text-mute');
  return (
    <div className="space-y-2 pt-1">
      <div className="label">Gestion de sortie</div>
      <p className="text-xs leading-snug text-mute">{m.scope}. Coupure entre les moitiés : {localDateTime(m.splitAt)}.</p>
      <div className="overflow-hidden rounded-lg border border-line">
        {m.rows.map(r => (
          <div key={r.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 border-t border-line px-2 py-1.5 text-xs first:border-t-0">
            <span className="leading-tight">{r.label}</span>
            <span className={cx('num text-right', cls(r.firstHalf))}>
              {fmtR(r.firstHalf)}
              <span className="block text-xs text-mute">{r.firstHalf.trades} tr. · {r.firstHalf.winRate ?? '—'} %</span>
            </span>
            <span className={cx('num text-right', cls(r.secondHalf))}>
              {fmtR(r.secondHalf)}
              <span className="block text-xs text-mute">{r.secondHalf.trades} tr. · {r.secondHalf.winRate ?? '—'} %</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
