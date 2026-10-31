import { useState } from 'react';
import { BookOpen, Download, Trash2 } from 'lucide-react';
import type { JournalEntry, TradeResult } from '../types';
import { cx, localDateTime } from '../lib/utils';

interface Props {
  journal: JournalEntry[];
  setJournal: (j: JournalEntry[]) => void;
}

const RESULTS: { key: TradeResult; label: string; cls: string }[] = [
  { key: 'gagne', label: 'Gagné', cls: 'border-up text-up' },
  { key: 'perdu', label: 'Perdu', cls: 'border-down text-down' },
  { key: 'breakeven', label: 'BE', cls: 'border-mute text-ink' },
  { key: 'non_pris', label: 'Non pris', cls: 'border-mute text-mute' },
];

export function JournalView({ journal, setJournal }: Props) {
  const [confirmReset, setConfirmReset] = useState(false);
  const closed = journal.filter(j => j.rMultiple !== null && j.result !== 'non_pris');
  const wins = closed.filter(j => (j.rMultiple as number) > 0).length;
  const totalR = closed.reduce((s, j) => s + (j.rMultiple as number), 0);
  const winRate = closed.length ? Math.round((wins / closed.length) * 100) : null;
  const expectancy = closed.length ? totalR / closed.length : null;

  const update = (id: string, patch: Partial<JournalEntry>) => setJournal(journal.map(j => (j.id === id ? { ...j, ...patch } : j)));

  const setResult = (j: JournalEntry, r: TradeResult) => {
    // Valeur proposée, à corriger avec le R réel (sortie partielle, slippage…)
    const rMultiple = r === 'gagne' ? j.rrPlanned : r === 'perdu' ? -1 : r === 'breakeven' ? 0 : null;
    update(j.id, { result: r, rMultiple });
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
            {journal.length > 0 && (
              <button onClick={exportCsv} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-mute">
                <Download className="h-3.5 w-3.5" /> CSV
              </button>
            )}
            {journal.length > 0 &&
              (confirmReset ? (
                <span className="flex items-center gap-2 text-[11px]">
                  <button onClick={() => { setJournal([]); setConfirmReset(false); }} className="font-semibold text-down">Tout effacer</button>
                  <button onClick={() => setConfirmReset(false)} className="text-mute">Annuler</button>
                </span>
              ) : (
                <button onClick={() => setConfirmReset(true)} className="rounded-md px-2 py-1 text-[11px] text-mute">Vider</button>
              ))}
          </div>
        </div>

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
                </div>
                <div className="flex items-center gap-2">
                  {j.rMultiple !== null && (
                    <span className={cx('num text-sm font-bold', j.rMultiple > 0 ? 'text-up' : j.rMultiple < 0 ? 'text-down' : 'text-mute')}>
                      {j.rMultiple > 0 ? '+' : ''}
                      {j.rMultiple.toFixed(1)} R
                    </span>
                  )}
                  <button onClick={() => setJournal(journal.filter(x => x.id !== j.id))} className="p-1 text-mute" aria-label="Supprimer">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="num mt-2 grid grid-cols-3 gap-1 text-[11px]">
                <span>E {j.entry}</span>
                <span className="text-down">SL {j.sl}</span>
                <span className="text-up">TP {j.tp}</span>
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
                      onChange={e => update(j.id, { rMultiple: e.target.value === '' ? null : Number(e.target.value) })}
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

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="card px-3 py-2.5 text-center">
      <div className="text-[10px] uppercase tracking-wide text-mute">{label}</div>
      <div className={cx('num mt-0.5 text-lg font-bold', cls)}>{value}</div>
    </div>
  );
}
