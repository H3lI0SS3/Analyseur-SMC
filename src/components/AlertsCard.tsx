// Alertes de la surveillance automatique (les mêmes que sur Telegram), avec « Ajouter au journal ».
import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import type { AnalysisResponse } from '../types';
import { api, cx, localDateTime, readJson } from '../lib/utils';

export interface WatchAlertView {
  id: string;
  kind: 'ordre' | 'setup' | 'test';
  pair: string;
  at: number;
  title: string;
  text: string;
  telegram: { ok: boolean; error?: string };
  analysis: AnalysisResponse;
}
interface AlertsPayload {
  alerts: WatchAlertView[];
  lastTick: { at: number; skipped: string | null } | null;
  telegram: boolean;
  watchConfigured: boolean;
}

const FRESH_MS = 10 * 60_000;

/** État de la surveillance (dernier passage) pour prouver que l'app vit, même quand le verdict est « Attendre ». */
export function useWatchStatus() {
  const [data, setData] = useState<AlertsPayload | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await api('/api/alerts');
        if (!res.ok) throw new Error();
        const j = (await readJson(res)) as AlertsPayload;
        if (alive) {
          setData(j);
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true);
      }
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return { data, failed };
}

export function AlertsCard(_props: { onAdd?: (a: AnalysisResponse, test?: boolean) => string | null }) {
  const { data, failed } = useWatchStatus();
  if (failed && !data)
    return <section className="card px-4 py-3 text-xs text-warn">Surveillance injoignable pour l’instant : nouvel essai dans une minute.</section>;
  if (!data || !data.watchConfigured) return null;
  const recent = data.alerts.filter(a => Date.now() - a.at < 24 * 3_600_000).slice(0, 5);
  return (
    <section className="card p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="label flex items-center gap-1.5">
          <BellRing className="h-3.5 w-3.5 text-gold" /> Alertes des dernières 24 h
        </div>
        <span className="text-xs text-mute">Telegram {data.telegram ? 'actif' : 'non configuré'}</span>
      </div>
      {recent.length === 0 ? (
        <p className="text-xs text-mute">Aucune alerte. Tu seras prévenu sur Telegram dès qu’un setup se prépare et quand l’ordre est prêt.</p>
      ) : (
        <ul className="space-y-2">
          {recent.map(a => {
            const fresh = Date.now() - a.at < FRESH_MS;
            return (
              <li key={a.id} className={cx('rounded-lg p-3 text-xs', a.kind === 'ordre' ? 'border border-up/40 bg-up/5' : a.kind === 'test' ? 'border border-dashed border-gold/60 bg-card2' : 'bg-card2')}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{a.title}</span>
                  <span className="shrink-0 text-mute">{localDateTime(a.at)}</span>
                </div>
                <p className="mt-1 whitespace-pre-line leading-snug text-ink/80">{a.text.split('\n').slice(1).join('\n')}</p>
                {!a.telegram.ok && a.telegram.error && <p className="mt-1 text-warn">{a.telegram.error}</p>}
                {(a.kind === 'ordre' || a.kind === 'test') && !fresh && <p className="mt-1 text-mute">Alerte de plus de 10 min : vérifie l’analyse ci-dessus avant d’agir.</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
