import { useEffect, useRef, useState } from 'react';
import { BookOpen, KeyRound, LineChart, Settings2, ShieldAlert } from 'lucide-react';
import { CandleChart } from './components/CandleChart';
import { AnalysisPanel } from './components/AnalysisPanel';
import { JournalView } from './components/JournalView';
import { SettingsView } from './components/SettingsView';
import { BacktestCard } from './components/BacktestCard';
import type { AnalysisResponse, JournalEntry, Quote, RiskSettings, Status } from './types';
import { api, CONTRACT, costsFor, riskForGrade, cx, fmt, getAccessCode, load, loadArray, lotSize, save, setAccessCode, setUnauthorizedHandler, todayLossPct } from './lib/utils';
import { isTracked, strategyStats, trackJournal } from './lib/tracker';

type Tab = 'analyse' | 'journal' | 'reglages';

const DEFAULT_SETTINGS: RiskSettings = {
  capital: 10000,
  riskPct: 1,
  dailyLossPct: 3,
  aiProvider: 'auto',
  spreadEurPips: 1,
  spreadGold: 0.3,
  commissionPerLot: 7,
};
const FALLBACK_PAIRS = [
  { id: 'EUR/USD', label: 'EUR/USD', decimals: 5, pipSize: 0.0001 },
  { id: 'XAU/USD', label: 'Or (XAU/USD)', decimals: 2, pipSize: 0.1 },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('analyse');
  const [status, setStatus] = useState<Status | null>(null);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [pair, setPair] = useState<string>(() => load('sa_ui', { pair: 'XAU/USD' }).pair);
  const [settings, setSettings] = useState<RiskSettings>(() => {
    const s = load('sa_settings', DEFAULT_SETTINGS);
    return { ...s, riskPct: Math.min(2, s.riskPct) }; // risque plafonné à 2 % par trade
  });
  const [needCode, setNeedCode] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => setUnauthorizedHandler(() => setNeedCode(true)), []);
  const [journal, setJournal] = useState<JournalEntry[]>(() => loadArray<JournalEntry>('sa_journal'));
  const [analyses, setAnalyses] = useState<Record<string, AnalysisResponse | null>>({});

  useEffect(() => save('sa_settings', settings), [settings]);
  useEffect(() => save('sa_journal', journal), [journal]);
  useEffect(() => save('sa_ui', { pair }), [pair]);

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then((s: Status) => {
        setStatus(s);
        if (s.accessRequired && !getAccessCode()) setNeedCode(true);
      })
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    const get = () =>
      api('/api/quotes')
        .then(r => r.json())
        .then(j => setQuotes(j.quotes || {}))
        .catch(() => {});
    get();
    const id = setInterval(get, 30_000);
    return () => clearInterval(id);
  }, [reloadKey]);

  const pairs = status?.pairs || FALLBACK_PAIRS;
  const meta = pairs.find(p => p.id === pair) || pairs[0];
  const lossToday = todayLossPct(journal);
  const blocked = lossToday >= settings.dailyLossPct;

  /** Ajoute le trade au suivi ; renvoie un message d'erreur si on refuse (analyse périmée, doublon). */
  const addToJournal = (a: AnalysisResponse): string | null => {
    const p = a.final.plan;
    if (!p) return 'Pas de plan à suivre.';
    if (Date.now() - a.generatedAt > 10 * 60_000) return 'Analyse de plus de 10 minutes : relance l’analyse avant de prendre le trade.';
    const dup = journal.some(j => isTracked(j) && j.pair === a.pair && j.direction === p.direction && Math.abs(j.entry - p.entry) < 1e-9);
    if (dup) return 'Ce trade est déjà suivi dans le journal.';
    const costs = costsFor(a.pair, settings);
    setJournal([
      {
        id: 'j_' + Date.now(),
        createdAt: Date.now(),
        pair: a.pair,
        direction: p.direction,
        entry: p.entry,
        sl: p.sl,
        tp: p.tp2 ?? p.tp1,
        rrPlanned: p.rr2 ?? p.rr1,
        riskPct: riskForGrade(settings.riskPct, a.engine.grade),
        lots: lotSize(a.pair, settings.capital, riskForGrade(settings.riskPct, a.engine.grade), p.entry, p.sl, costs.commissionPerLot),
        result: p.entryType === 'limite' ? 'attente' : 'en_cours',
        rMultiple: null,
        note: '',
        auto: true,
        entryType: p.entryType,
        tp1: p.tp1,
        tp2: p.tp2,
        validUntil: a.engine.setup?.validUntil,
        spread: costs.spread,
        commissionPerLot: costs.commissionPerLot,
        contract: a.contract ?? CONTRACT[a.pair],
        filledAt: null,
        tp1At: null,
        exitAt: null,
        rulesVersion: a.rulesVersion,
        pattern: (a.candlePatterns || []).find(cp => cp.dir === (p.direction === 'acheter' ? 'haussier' : 'baissier'))?.name ?? null,
      },
      ...journal,
    ]);
    return null;
  };

  // Suivi automatique : l'app vérifie les trades ouverts sur les vraies bougies M15 toutes les minutes
  const journalRef = useRef(journal);
  journalRef.current = journal;
  const openCount = journal.filter(isTracked).length;
  useEffect(() => {
    if (!openCount) return;
    let alive = true;
    const tick = async () => {
      const next = await trackJournal(journalRef.current);
      // on applique seulement aux trades encore suivis, sans écraser une saisie faite entre-temps
      if (alive && next) {
        const byId = new Map(next.map(j => [j.id, j]));
        setJournal(cur => cur.map(j => (isTracked(j) && byId.has(j.id) ? byId.get(j.id)! : j)));
      }
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [openCount, reloadKey]);
  const stats = strategyStats(journal, undefined, status?.rulesVersion);

  if (needCode) {
    return (
      <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        <div className="card space-y-4 p-5">
          <div className="flex items-center gap-2 text-base font-bold">
            <KeyRound className="h-5 w-5 text-gold" /> Code d’accès
          </div>
          <p className="text-sm text-mute">Cette app est protégée. Entre le code défini dans le secret APP_ACCESS_CODE d’AI Studio.</p>
          <input
            type="password"
            value={codeInput}
            onChange={e => setCodeInput(e.target.value)}
            className="w-full rounded-lg border border-line bg-card2 px-3 py-2.5 text-base text-ink focus:border-gold focus:outline-none"
            autoFocus
          />
          <button
            onClick={() => {
              setAccessCode(codeInput.trim());
              setNeedCode(false);
              setReloadKey(k => k + 1);
            }}
            disabled={!codeInput.trim()}
            className="w-full rounded-lg bg-gold py-2.5 text-sm font-bold text-bg disabled:opacity-50"
          >
            Entrer
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-2xl pb-24">
      {/* En-tête */}
      <header className="sticky top-0 z-10 border-b border-line bg-bg/95 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))] backdrop-blur">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-bold tracking-tight">
            Analyseur <span className="text-gold">SMC</span>
          </h1>
          <div className="flex items-center gap-1.5 text-[11px] text-mute">
            <span className={cx('h-1.5 w-1.5 rounded-full', status ? 'bg-up' : 'bg-down')} />
            {status ? status.dataSource : 'hors ligne'}
          </div>
        </div>

        {/* Sélection de l'actif */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          {pairs.map(p => {
            const q = quotes[p.id];
            const active = p.id === pair;
            return (
              <button
                key={p.id}
                onClick={() => setPair(p.id)}
                className={cx('rounded-xl border px-3 py-2 text-left transition', active ? 'border-gold bg-gold/10' : 'border-line bg-card')}
              >
                <div className="flex items-center justify-between">
                  <span className={cx('text-xs font-semibold', active ? 'text-gold' : 'text-mute')}>{p.label}</span>
                  {q?.changePct !== undefined && q?.changePct !== null && (
                    <span className={cx('num text-[11px]', q.changePct >= 0 ? 'text-up' : 'text-down')}>
                      {q.changePct >= 0 ? '+' : ''}
                      {q.changePct.toFixed(2)} %
                    </span>
                  )}
                </div>
                <div className="num mt-0.5 text-lg font-semibold">
                  {q?.error ? <span className="text-sm text-down">indisponible</span> : fmt(q?.price, p.decimals)}
                </div>
                {q?.stale && <div className="text-[10px] text-warn">marché fermé / en retard</div>}
                {q?.futuresProxy && !q?.stale && <div className="text-[10px] text-warn">prix futures (≠ broker)</div>}
              </button>
            );
          })}
        </div>
      </header>

      <main className="space-y-3 px-4 pt-3">
        {/* Garde-fou perte journalière */}
        <div className={cx('card flex items-center gap-3 px-3 py-2', blocked && 'border-down/60')}>
          <ShieldAlert className={cx('h-4 w-4 shrink-0', blocked ? 'text-down' : 'text-gold')} />
          <div className="flex-1">
            <div className="flex justify-between text-[11px]">
              <span className={blocked ? 'font-semibold text-down' : 'text-mute'}>
                {blocked ? 'Limite de perte du jour atteinte : stop pour aujourd’hui.' : 'Perte du jour'}
              </span>
              <span className="num">
                {lossToday.toFixed(1)} / {settings.dailyLossPct} %
              </span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-card2">
              <div
                className={cx('h-full', blocked ? 'bg-down' : lossToday / settings.dailyLossPct > 0.66 ? 'bg-warn' : 'bg-up')}
                style={{ width: `${Math.min(100, (lossToday / settings.dailyLossPct) * 100)}%` }}
              />
            </div>
          </div>
        </div>

        {tab === 'analyse' && (
          <>
            <CandleChart reload={reloadKey} pair={pair} decimals={meta.decimals} analysis={analyses[pair] || null} />
            <AnalysisPanel
              pair={pair}
              status={status}
              settings={settings}
              analysis={analyses[pair] || null}
              setAnalysis={a => setAnalyses(prev => ({ ...prev, [pair]: a }))}
              onAddJournal={addToJournal}
              dailyBlocked={blocked}
              stats={stats}
            />
          </>
        )}
        {tab === 'journal' && (
          <>
            <JournalView journal={journal} setJournal={setJournal} rulesVersion={status?.rulesVersion} />
            <BacktestCard pair={pair} settings={settings} />
          </>
        )}
        {tab === 'reglages' && <SettingsView settings={settings} setSettings={setSettings} status={status} />}
      </main>

      {/* Navigation basse */}
      <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="mx-auto grid max-w-2xl grid-cols-3">
          {(
            [
              ['analyse', 'Analyse', LineChart],
              ['journal', 'Journal', BookOpen],
              ['reglages', 'Réglages', Settings2],
            ] as const
          ).map(([key, label, Icon]) => (
            <button key={key} onClick={() => setTab(key)} className={cx('flex flex-col items-center gap-0.5 py-2.5 text-[11px]', tab === key ? 'text-gold' : 'text-mute')}>
              <Icon className="h-5 w-5" />
              {label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
