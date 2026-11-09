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

export function AlertsCard({ onAdd }: { onAdd: (a: AnalysisResponse, test?: boolean) => string | null }) {
  const [data, setData] = useState<AlertsPayload | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await api('/api/alerts');
        if (res.ok && alive) setData((await readJson(res)) as AlertsPayload);
      } catch {
        /* hors ligne : on réessaie à la prochaine minute */
      }
      if (alive) setTick(t => t + 1);
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  if (!data || !data.watchConfigured) return null;
  const recent = data.alerts.filter(a => Date.now() - a.at < 24 * 3_600_000).slice(0, 5);
  return (
    <section className="card p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="label flex items-center gap-1.5">
          <BellRing className="h-3.5 w-3.5 text-gold" /> Surveillance automatique
        </div>
        <span className="text-[10px] text-mute">
          {data.lastTick ? `vérifié ${localDateTime(data.lastTick.at)}` : 'pas encore de vérification'} · Telegram {data.telegram ? 'actif' : 'non configuré'}
        </span>
      </div>
      {recent.length === 0 ? (
        <p className="text-[12px] text-mute">Aucune alerte dans les dernières 24 h. Tu seras prévenu dès qu’un setup se prépare et quand l’ordre est prêt.</p>
      ) : (
        <ul className="space-y-2">
          {recent.map(a => {
            const fresh = Date.now() - a.at < FRESH_MS;
            return (
              <li key={a.id} className={cx('rounded-lg p-3 text-[12px]', a.kind === 'ordre' ? 'border border-up/40 bg-up/5' : a.kind === 'test' ? 'border border-dashed border-gold/60 bg-card2' : 'bg-card2')}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{a.title}</span>
                  <span className="shrink-0 text-[10px] text-mute">{localDateTime(a.at)}</span>
                </div>
                <p className="mt-1 whitespace-pre-line text-[11px] leading-snug text-ink/80">{a.text.split('\n').slice(1).join('\n')}</p>
                {!a.telegram.ok && a.telegram.error && <p className="mt-1 text-[10px] text-warn">{a.telegram.error}</p>}
                {(a.kind === 'ordre' || a.kind === 'test') && (
                  <div className="mt-2">
                    <button
                      disabled={!fresh}
                      onClick={() => setMsg(m => ({ ...m, [a.id]: onAdd(a.analysis, a.kind === 'test') ?? (a.kind === 'test' ? 'Ajouté au journal (TEST) : place l’ordre toi-même sur ta démo FxPro.' : 'Ajouté au journal : place l’ordre toi-même sur FxPro.') }))}
                      className={cx('w-full rounded-lg py-2 text-[12px] font-bold disabled:cursor-not-allowed disabled:bg-card2 disabled:text-mute', a.kind === 'test' ? 'bg-gold text-white' : 'bg-up text-bg')}
                    >
                      {fresh ? (a.kind === 'test' ? 'Ajouter au journal (TEST)' : 'Ajouter au journal') : 'Alerte de plus de 10 min : relance l’analyse'}
                    </button>
                    {msg[a.id] && <p className="mt-1 text-center text-[11px] text-mute">{msg[a.id]}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
