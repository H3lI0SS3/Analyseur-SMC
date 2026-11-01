import { useRef, useState } from 'react';
import { BookOpen, Download, Radar, Trash2, Upload } from 'lucide-react';
import type { JournalEntry, TradeResult } from '../types';
import { cx, localDateTime } from '../lib/utils';
import { isTracked, strategyStats } from '../lib/tracker';

interface Props {
  journal: JournalEntry[];
  setJournal: (j: JournalEntry[]) => void;
  rulesVersion?: string;
}

const RESULTS: { key: TradeResult; label: string; cls: string }[] = [
  { key: 'gagne', label: 'Gagné', cls: 'border-up text-up' },
  { key: 'perdu', label: 'Perdu', cls: 'border-down text-down' },
  { key: 'breakeven', label: 'BE', cls: 'border-mute text-ink' },
  { key: 'non_pris', label: 'Non pris', cls: 'border-mute text-mute' },
];

export function JournalView({ journal, setJournal, rulesVersion }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const tracked = (j: JournalEntry) => j.auto !== undefined;
  const [confirmReset, setConfirmReset] = useState(false);
  const st = strategyStats(journal, undefined, rulesVersion);
  const withP = strategyStats(journal, j => !!j.pattern, rulesVersion);
  const withoutP = strategyStats(journal, j => j.pattern === null, rulesVersion);
  const closed = journal.filter(j => j.rMultiple !== null && ['gagne', 'perdu', 'breakeven'].includes(j.result));
  const wins = closed.filter(j => (j.rMultiple as number) > 0).length;
  const totalR = closed.reduce((s, j) => s + (j.rMultiple as number), 0);
  const winRate = closed.length ? Math.round((wins / closed.length) * 100) : null;
  const expectancy = closed.length ? totalR / closed.length : null;

  const update = (id: string, patch: Partial<JournalEntry>) => setJournal(journal.map(j => (j.id === id ? { ...j, ...patch } : j)));

  const setResult = (j: JournalEntry, r: TradeResult) => {
    // Valeur proposée, à corriger avec le R réel (sortie partielle, slippage…)
    const rMultiple = r === 'gagne' ? j.rrPlanned : r === 'perdu' ? -1 : r === 'breakeven' ? 0 : null;
    // saisie manuelle : l'app arrête de suivre ce trade
    update(j.id, { result: r, rMultiple, auto: j.auto === undefined ? undefined : false });
  };

  const exportCsv = () => {
    const head = 'date;actif;sens;entree;stop;objectif;rr_prevu;risque_pct;lots;resultat;r_obtenu;note';
    const rows = journal.map(j =>
      [new Date(j.createdAt).toISOString(), j.pair, j.direction, j.entry, j.sl, j.tp, j.rrPlanned, j.riskPct, j.lots ?? '', j.result, j.rMultiple ?? '', `"${j.note.replace(/"/g, "'")}"`].join(';')
    );
    const blob = new Blob(['﻿' + [head, ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `journal-trading-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Sauvegarde complète (le journal n'existe que dans ce navigateur) : à garder sur ton téléphone ou ton Drive
  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ app: 'analyseur-smc', version: 1, exportedAt: Date.now(), journal }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `journal-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = async (f: File) => {
    try {
      const data = JSON.parse(await f.text());
      const list: JournalEntry[] = Array.isArray(data) ? data : data.journal;
      if (!Array.isArray(list)) throw new Error();
      const ids = new Set(journal.map(j => j.id));
      const added = list.filter(j => j && typeof j.id === 'string' && !ids.has(j.id));
      setJournal([...journal, ...added].sort((a, b) => b.createdAt - a.createdAt));
      setMsg(`${added.length} trade(s) restauré(s).`);
    } catch {
      setMsg('Fichier de sauvegarde illisible.');
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Trades clos" value={String(closed.length)} />
        <Stat label="Réussite" value={winRate === null ? '—' : `${winRate} %`} />
        <Stat
          label="Total"
          value={closed.length ? `${totalR >= 0 ? '+' : ''}${totalR.toFixed(1)} R` : '—'}
          cls={totalR > 0 ? 'text-up' : totalR < 0 ? 'text-down' : ''}
        />
      </div>
      <section className="card p-3">
        <div className="label flex items-center gap-1.5">
          <Radar className="h-3.5 w-3.5 text-gold" /> Suivi de ta stratégie
        </div>
        <p className="mt-1 text-[11px] leading-snug text-mute">
          Chaque trade pris avec « Je prends ce trade » est suivi tout seul sur les vraies bougies M15 : exécution de l’ordre, TP1 (50 % encaissés, stop au point d’entrée), TP2 ou stop.
          Résultats en R, spread et commission compris. Le suivi tourne quand l’app est ouverte et rattrape jusqu’à 7 jours d’absence.
        </p>
        <div className="num mt-2 grid grid-cols-3 gap-1 text-center text-[11px]">
          <div><div className="text-mute">Suivis clos</div><div className="text-sm font-semibold">{st.closed}</div></div>
          <div><div className="text-mute">Moyenne</div><div className={cx('text-sm font-semibold', (st.avgR ?? 0) > 0 ? 'text-up' : (st.avgR ?? 0) < 0 ? 'text-down' : '')}>{st.avgR === null ? '—' : `${st.avgR >= 0 ? '+' : ''}${st.avgR} R`}</div></div>
          <div><div className="text-mute">Viabilité</div><div className="text-sm font-semibold">{st.viability === null ? `${st.closed}/${st.minTrades}` : `${st.viability} %`}</div></div>
        </div>
        {withP.closed + withoutP.closed > 0 && (
          <p className="mt-2 text-[11px] leading-snug text-mute">
            Bougies japonaises — avec figure : {withP.closed} trades{withP.avgR !== null ? `, ${withP.avgR >= 0 ? '+' : ''}${withP.avgR} R en moyenne` : ''} · sans figure : {withoutP.closed} trades{withoutP.avgR !== null ? `, ${withoutP.avgR >= 0 ? '+' : ''}${withoutP.avgR} R en moyenne` : ''}.
          </p>
        )}
      </section>
      {expectancy !== null && (
        <p className="px-1 text-[11px] text-mute">
          Espérance : <span className={cx('num', expectancy >= 0 ? 'text-up' : 'text-down')}>{expectancy >= 0 ? '+' : ''}{expectancy.toFixed(2)} R</span> par trade.
          {closed.length < 30 && ' Moins de 30 trades : chiffre encore peu fiable.'}
        </p>
      )}

      <section className="card p-3">
        <div className="mb-3 flex items-center justify-between">
          <div className="label flex items-center gap-1.5">
            <BookOpen className="h-3.5 w-3.5 text-gold" /> Journal
          </div>
          <div className="flex items-center gap-1">
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ''; }} />
            {journal.length > 0 && (
              <button onClick={exportCsv} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-mute">
                <Download className="h-3.5 w-3.5" /> CSV
              </button>
            )}
            {journal.length > 0 && (
              <button onClick={exportJson} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-mute">
                <Download className="h-3.5 w-3.5" /> Sauvegarder
              </button>
            )}
            <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-mute">
              <Upload className="h-3.5 w-3.5" /> Restaurer
            </button>
            {journal.some(j => !tracked(j)) &&
              (confirmReset ? (
                <span className="flex items-center gap-2 text-[11px]">
                  <button onClick={() => { setJournal(journal.filter(tracked)); setConfirmReset(false); }} className="font-semibold text-down">Effacer</button>
                  <button onClick={() => setConfirmReset(false)} className="text-mute">Annuler</button>
                </span>
              ) : (
                <button onClick={() => setConfirmReset(true)} className="rounded-md px-2 py-1 text-[11px] text-mute" title="Efface les trades notés à la main ; les trades suivis restent">Vider</button>
              ))}
          </div>
        </div>
        {msg && <p className="mb-2 text-[11px] text-gold">{msg}</p>}
        <p className="mb-2 text-[10px] leading-snug text-mute">
          Les trades suivis ne peuvent pas être supprimés (sinon la viabilité serait faussée). Le journal est stocké dans ce navigateur : fais une sauvegarde de temps en temps.
        </p>

        {!journal.length && (
          <p className="py-6 text-center text-sm text-mute">
            Aucun trade. Après une analyse avec un plan validé, appuie sur « Je prends ce trade ».
          </p>
        )}

        <ul className="space-y-2">
          {journal.map(j => (
            <li key={j.id} className="rounded-lg bg-card2 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">
                    <span className={j.direction === 'acheter' ? 'text-up' : 'text-down'}>{j.direction === 'acheter' ? 'Achat' : 'Vente'}</span> {j.pair}
                  </div>
                  <div className="text-[11px] text-mute">{localDateTime(j.createdAt)}</div>
                  <TrackBadge j={j} />
                  {j.pattern && <div className="text-[10px] text-mute">Bougies japonaises : {j.pattern}</div>}
                </div>
                <div className="flex items-center gap-2">
                  {j.rMultiple !== null && (
                    <span className={cx('num text-sm font-bold', j.rMultiple > 0 ? 'text-up' : j.rMultiple < 0 ? 'text-down' : 'text-mute')}>
                      {j.rMultiple > 0 ? '+' : ''}
                      {j.rMultiple.toFixed(1)} R
                    </span>
                  )}
                  {!tracked(j) && (
                    <button onClick={() => setJournal(journal.filter(x => x.id !== j.id))} className="p-1 text-mute" aria-label="Supprimer">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="num mt-2 grid grid-cols-3 gap-1 text-[11px]">
                <span>E {j.entry}</span>
                <span className="text-down">SL {j.sl}</span>
                <span className="text-up">{j.tp1 !== undefined && j.tp2 ? `TP1 ${j.tp1} · TP2 ${j.tp2}` : `TP ${j.tp}`}</span>
              </div>
              <div className="mt-1 text-[11px] text-mute">
                R:R prévu 1:{j.rrPlanned.toFixed(1)} · risque {j.riskPct} %{j.lots ? ` · ${j.lots.toFixed(2)} lot` : ''}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {RESULTS.map(r => (
                  <button
                    key={r.key}
                    onClick={() => setResult(j, r.key)}
                    className={cx('rounded-md border px-2.5 py-1 text-[11px] font-semibold', j.result === r.key ? r.cls + ' bg-white/5' : 'border-line text-mute')}
                  >
                    {r.label}
                  </button>
                ))}
                {(j.result === 'gagne' || j.result === 'perdu') && (
                  <label className="flex items-center gap-1 text-[11px] text-mute">
                    R réel
                    <input
                      type="number"
                      step="0.1"
                      value={j.rMultiple ?? ''}
                      onChange={e => update(j.id, { rMultiple: e.target.value === '' ? null : Number(e.target.value), auto: j.auto === undefined ? undefined : false })}
                      className="num w-14 rounded border border-line bg-bg px-1.5 py-0.5 text-ink"
                    />
                  </label>
                )}
              </div>
              <input
                value={j.note}
                onChange={e => update(j.id, { note: e.target.value })}
                placeholder="Note (émotion, erreur, leçon…)"
                className="mt-2 w-full rounded border border-line bg-bg px-2 py-1.5 text-xs text-ink placeholder:text-mute focus:border-gold focus:outline-none"
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function TrackBadge({ j }: { j: JournalEntry }) {
  if (j.auto === undefined) return null;
  const label = isTracked(j)
    ? j.result === 'attente'
      ? `Suivi auto : ordre limite en attente${j.validUntil ? ` (jusqu’à ${localDateTime(j.validUntil)})` : ''}`
      : j.tp1At
      ? 'Suivi auto : TP1 touché, stop au point d’entrée'
      : 'Suivi auto : position ouverte'
    : j.result === 'expire'
    ? 'Ordre jamais exécuté (annulé) : ne compte pas'
    : j.auto
    ? `Clôturé automatiquement${j.exitAt ? ` le ${localDateTime(j.exitAt)}` : ''}`
    : 'Résultat saisi à la main';
  return <div className={cx('mt-0.5 text-[10px]', isTracked(j) ? 'text-gold' : 'text-mute')}>{label}</div>;
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="card px-3 py-2.5 text-center">
      <div className="text-[10px] uppercase tracking-wide text-mute">{label}</div>
      <div className={cx('num mt-0.5 text-lg font-bold', cls)}>{value}</div>
    </div>
  );
}
