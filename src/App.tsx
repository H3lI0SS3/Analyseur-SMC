import { useEffect, useRef, useState } from 'react';
import { BookOpen, KeyRound, LineChart, Settings2, ShieldAlert } from 'lucide-react';
import { CandleChart } from './components/CandleChart';
import { AnalysisPanel } from './components/AnalysisPanel';
import { JournalView } from './components/JournalView';
import { FxJournalCard, useFxJournal } from './components/FxJournalCard';
import { SettingsView } from './components/SettingsView';
import { BacktestCard } from './components/BacktestCard';
import { AlertsCard } from './components/AlertsCard';
import { TradingViewChart } from './components/TradingViewChart';
import type { AnalysisResponse, JournalEntry, Quote, RiskSettings, Status } from './types';
import { deskCheck, deskCheckFx } from './lib/desk';
import { api, CONTRACT, costsFor, riskForGrade, cx, fmt, getAccessCode, load, loadArray, lotScale, lotSize, save, sessionNow, setAccessCode, setUnauthorizedHandler, todayLossPct, readJson, TEST_RISK_PCT } from './lib/utils';
import { isTracked, strategyStats, trackJournal } from './lib/tracker';

type Tab = 'analyse' | 'journal' | 'reglages';

const DEFAULT_SETTINGS: RiskSettings = {
  capital: 10000,
  riskPct: 1,
  dailyLossPct: 3,
  aiProvider: 'auto',
  // préréglage FxPro cTrader (compte démo du trader)
  spreadEurPips: 0.2,
  spreadGold: 0.2,
  commissionPerLot: 7,
  broker: 'mt5',
  leverageEur: 30,
  leverageGold: 20,
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
    // broker par défaut : cTrader FxPro (identifiant interne « mt5 » gardé pour les réglages enregistrés)
    const migrated = s.broker ? s : { ...s, broker: 'mt5' as const };
    return { ...migrated, riskPct: Math.min(2, migrated.riskPct) }; // risque plafonné à 2 % par trade
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
      .then(r => readJson(r))
      .then((s: Status) => {
        setStatus(s);
        if (s.accessRequired && !getAccessCode()) setNeedCode(true);
      })
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    const get = () =>
      api('/api/quotes')
        .then(r => readJson(r))
        .then(j => setQuotes(j.quotes || {}))
        .catch(() => {});
    get();
    // onglet caché : pas de rafraîchissement (économise le quota de données), reprise dès qu'il redevient visible
    const id = setInterval(() => document.visibilityState === 'visible' && get(), 30_000);
    const onVis = () => document.visibilityState === 'visible' && get();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [reloadKey]);

  const pairs = status?.pairs || FALLBACK_PAIRS;
  const meta = pairs.find(p => p.id === pair) || pairs[0];
  // compte réel (journal FxPro) : solde, politique de risque et règles du desk calculés sur tes vraies positions
  const fx = useFxJournal();
  const fxOk = !!fx.data?.available;
  const eff = {
    ...settings,
    capital: fxOk && fx.data!.balance ? fx.data!.balance : settings.capital,
    riskPct: fxOk ? Math.min(settings.riskPct, fx.data!.policy.protocolRiskPct) : settings.riskPct,
  };
  const lossToday = fxOk ? fx.data!.desk.lossTodayPct : todayLossPct(journal);
  const blocked = lossToday >= settings.dailyLossPct;

  /** Ajoute le trade au suivi ; renvoie un message d'erreur si on refuse (analyse périmée, doublon). */
  const addToJournal = (a: AnalysisResponse, test = false): string | null => {
    const p = test ? a.engine.training?.setup : a.final.plan;
    if (!p) return test ? 'Pas de signal d’entraînement à suivre.' : 'Pas de plan à suivre.';
    if (Date.now() - a.generatedAt > 10 * 60_000) return 'Analyse de plus de 10 minutes : relance l’analyse avant de prendre le trade.';
    const dup = journal.some(j => isTracked(j) && j.pair === a.pair && j.direction === p.direction && Math.abs(j.entry - p.entry) < 1e-9);
    if (dup) return 'Ce trade est déjà suivi dans le journal.';
    const desk = fxOk ? deskCheckFx(fx.data!.desk, a.pair, p.direction, settings.dailyLossPct) : deskCheck(journal, a.pair, p.direction);
    if (desk) return desk;
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
        riskPct: test ? TEST_RISK_PCT : riskForGrade(eff.riskPct, a.engine.grade),
        lots: lotSize(a.pair, eff.capital, test ? TEST_RISK_PCT : riskForGrade(eff.riskPct, a.engine.grade), p.entry, p.sl, costs.commissionPerLot, lotScale(settings.broker)),
        result: p.entryType === 'limite' ? 'attente' : 'en_cours',
        rMultiple: null,
        note: '',
        auto: true,
        entryType: p.entryType,
        tp1: p.tp1,
        tp2: p.tp2,
        validUntil: test ? a.engine.training?.setup.validUntil : a.engine.setup?.validUntil,
        spread: costs.spread,
        commissionPerLot: costs.commissionPerLot,
        contract: a.contract ?? CONTRACT[a.pair],
        filledAt: null,
        tp1At: null,
        exitAt: null,
        rulesVersion: a.rulesVersion,
        pattern: (a.candlePatterns || []).find(cp => cp.dir === (p.direction === 'acheter' ? 'haussier' : 'baissier'))?.name ?? null,
        ...(test ? { test: true } : {}),
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
    const id = setInterval(() => document.visibilityState === 'visible' && tick(), 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [openCount, reloadKey]);
  // statistiques : celles du journal FxPro automatique (positions réelles, tous appareils) dès qu'il est disponible
  const localStats = strategyStats(journal, undefined, status?.rulesVersion);
  const stats = fx.data?.available ? fx.data.stats : localStats;
  const [session, setSession] = useState(() => sessionNow());
  useEffect(() => {
    const id = setInterval(() => setSession(sessionNow()), 60_000);
    return () => clearInterval(id);
  }, []);
  const quoteList = Object.values(quotes) as Quote[];
  const connection = !status
    ? { label: 'hors ligne', tone: 'bg-down', title: 'Serveur injoignable' }
    : quoteList.some(q => q?.error)
    ? { label: 'données indisponibles', tone: 'bg-down', title: quoteList.find(q => q?.error)?.error || '' }
    : quoteList.some(q => typeof (q as any)?.source === 'string' && (q as any).source.includes('secours'))
    ? { label: 'secours Yahoo', tone: 'bg-warn', title: 'Twelve Data épuisé : données Yahoo Finance' }
    : { label: `connecté · ${status.dataSource}`, tone: 'bg-up', title: 'Données en direct' };

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
    <div className="mx-auto min-h-screen max-w-2xl pb-24 lg:max-w-4xl">
      {/* En-tête */}
      <header className="sticky top-0 z-10 border-b border-line bg-white/90 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))] backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <h1 className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[17px] font-extrabold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gold text-white" aria-hidden>
              <svg viewBox="0 0 100 100" className="h-4 w-4"><path d="M14 72L42 40L62 56L86 28" stroke="currentColor" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
            </span>
            ORA Trader
          </h1>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-xs">
            {/* Indicateur de session (mis à jour chaque minute) */}
            <span
              className={cx(
                'rounded-full border px-2 py-0.5 font-semibold',
                session.killzone ? 'border-up/50 text-up' : session.closed ? 'border-line text-mute' : 'border-warn/40 text-warn'
              )}
            >
              {session.label}
            </span>
            {/* Statut de connexion */}
            <span className="flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-mute" title={connection.title}>
              <span className={cx('h-1.5 w-1.5 rounded-full', connection.tone)} />
              {connection.label}
            </span>
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
                    <span className={cx('num text-xs', q.changePct >= 0 ? 'text-up' : 'text-down')}>
                      {q.changePct >= 0 ? '+' : ''}
                      {q.changePct.toFixed(2)} %
                    </span>
                  )}
                </div>
                <div className="num mt-0.5 text-lg font-semibold">
                  {q?.error ? <span className="text-sm text-down">indisponible</span> : fmt(q?.price, p.decimals)}
                </div>
                {q?.stale && <div className="text-xs text-warn">marché fermé / en retard</div>}
                {q?.futuresProxy && !q?.stale && <div className="text-xs text-warn">prix futures (≠ broker)</div>}
              </button>
            );
          })}
        </div>
      </header>

      <main className="space-y-3 px-4 pt-3">
        {/* Données indisponibles : on affiche la vraie raison (quota, source en panne…) */}
        {(() => {
          const err = Object.values(quotes).find((q: any) => q?.error) as { error?: string } | undefined;
          if (err?.error) return <div className="card border-down/50 px-3 py-2 text-xs leading-snug text-down">{err.error}</div>;
          const backup = Object.values(quotes).some((q: any) => typeof q?.source === 'string' && q.source.includes('secours'));
          return backup ? (
            <div className="card border-warn/50 px-3 py-2 text-xs leading-snug text-warn">
              Twelve Data épuisé : données de secours Yahoo Finance (sans prix en direct). Recale toujours avec le prix de ton broker avant d’entrer.
            </div>
          ) : null;
        })()}
        {/* Garde-fou perte journalière */}
        <div className={cx('card flex items-center gap-3 px-3 py-2', blocked && 'border-down/60')}>
          <ShieldAlert className={cx('h-4 w-4 shrink-0', blocked ? 'text-down' : 'text-gold')} />
          <div className="flex-1">
            <div className="flex justify-between text-xs">
              <span className={blocked ? 'font-semibold text-down' : 'text-mute'}>
                {blocked ? 'Limite de perte du jour atteinte : stop pour aujourd’hui.' : fxOk ? 'Perte du jour (compte FxPro, positions ouvertes comprises)' : 'Perte du jour'}
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
            {/* d'abord la réponse (verdict + ordre), ensuite le contexte */}
            <AnalysisPanel
              pair={pair}
              status={status}
              settings={eff}
              analysis={analyses[pair] || null}
              setAnalysis={a => setAnalyses(prev => ({ ...prev, [pair]: a }))}
              onAddJournal={addToJournal}
              dailyBlocked={blocked}
              stats={stats}
              desk={fxOk ? fx.data!.desk : null}
              dailyLossPct={settings.dailyLossPct}
            />
            <AlertsCard />
            <TradingViewChart pair={pair} />
            <CandleChart reload={reloadKey} pair={pair} decimals={meta.decimals} analysis={analyses[pair] || null} />
          </>
        )}
        {tab === 'journal' && (
          <>
            <FxJournalCard data={fx.data} reload={fx.reload} />
            {fx.error && !fx.data && <p className="card border-warn/50 px-4 py-3 text-sm text-warn">{fx.error}</p>}
            {journal.length > 0 && (
              <details className="card px-4 py-3">
                <summary className="cursor-pointer text-sm font-semibold text-mute">Ancien journal de cet appareil (archivé, {journal.length} entrées)</summary>
                <p className="mt-2 text-xs text-mute">Remplacé par le journal FxPro automatique. Gardé ici en lecture et pour l’export CSV / la sauvegarde.</p>
                <div className="mt-3">
                  <JournalView journal={journal} setJournal={setJournal} rulesVersion={status?.rulesVersion} />
                </div>
              </details>
            )}
            <BacktestCard pair={pair} settings={settings} />
          </>
        )}
        {tab === 'reglages' && <SettingsView settings={settings} setSettings={setSettings} status={status} />}
      </main>

      {/* Navigation basse */}
      <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="mx-auto grid max-w-2xl grid-cols-3 lg:max-w-4xl">
          {(
            [
              ['analyse', 'Analyse', LineChart],
              ['journal', 'Journal', BookOpen],
              ['reglages', 'Réglages', Settings2],
            ] as const
          ).map(([key, label, Icon]) => (
            <button key={key} onClick={() => setTab(key)} className={cx('flex flex-col items-center gap-0.5 py-2.5 text-xs', tab === key ? 'text-gold' : 'text-mute')}>
              <Icon className="h-5 w-5" />
              {label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
