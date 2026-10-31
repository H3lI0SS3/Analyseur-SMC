// Backtest en tâche de fond, découpé en tranches, et historique des trades pour éclairer chaque signal.
// Cloud Run ne donne vraiment du CPU que pendant les requêtes : chaque consultation (analyse, cotations,
// onglet Journal, connecteur Claude) fait donc avancer le calcul de quelques secondes.
import crypto from 'crypto';
import { PAIRS, getHistory } from './marketData';

/** Identifiant de ce serveur : si deux appels n'ont pas le même, l'hébergeur a lancé plusieurs serveurs. */
export const INSTANCE_ID = crypto.randomBytes(3).toString('hex');
import { BacktestRun, similarHistory, type BacktestResult, type BtTrade, type SetupFeatures, type SimilarHistory } from './backtest';
import { bundledSnapshot, importTrades } from './historySnapshot';

export interface JobView {
  instance?: string;
  status: 'aucun' | 'en cours' | 'terminé' | 'erreur';
  phase?: string;
  progress?: number; // 0-100
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  result?: BacktestResult & { source: string; futuresProxy: boolean; limitedBySource: boolean; m15Count: number };
}

interface Job extends JobView {
  run?: BacktestRun;
  meta?: { source: string; futuresProxy: boolean; limitedBySource: boolean; m15Count: number };
  trades?: BtTrade[];
}

const jobs = new Map<string, Job>();
const bundledCache = new Map<string, BtTrade[]>();
/** Un historique de plus de 7 jours est recalculé à la prochaine analyse. */
const MAX_AGE = 7 * 24 * 3_600_000;

const view = (j: Job): JobView => {
  const { run, meta, trades, ...v } = j;
  return { ...v, instance: INSTANCE_ID };
};

/** Fait avancer le calcul (budget en ms) et renvoie l'état. */
export function getJob(pair: string, budgetMs = 8000): JobView | null {
  const job = jobs.get(pair);
  if (!job) return null;
  advance(job, budgetMs);
  return view(job);
}

/** Fait avancer tous les calculs en cours (appelé à chaque rafraîchissement des cotations). */
export function advanceAll(budgetMs: number) {
  for (const job of jobs.values()) advance(job, budgetMs);
}

function advance(job: Job, budgetMs: number) {
  if (job.status !== 'en cours' || !job.run) return;
  job.run.step(budgetMs);
  job.progress = Math.round(job.run.progress * 100);
  job.phase = `Calcul : ${job.progress} %`;
  if (job.run.done) {
    job.result = { ...job.run.result(), ...job.meta! };
    job.trades = job.run.allTrades();
    job.status = 'terminé';
    job.finishedAt = Date.now();
    job.run = undefined; // libère la mémoire
  }
}

/** Continue en arrière-plan par petites tranches quand le serveur a du temps libre. */
function backgroundLoop(job: Job) {
  if (job.status !== 'en cours') return;
  advance(job, 300);
  setTimeout(() => backgroundLoop(job), 50);
}

export function startBacktest(pair: string, spread?: number, commissionPerLot?: number): JobView {
  const info = PAIRS[pair];
  if (!info) throw new Error('Actif non supporté (EUR/USD ou XAU/USD).');
  const running = jobs.get(pair);
  if (running && running.status === 'en cours' && Date.now() - running.startedAt! < 60 * 60_000) return view(running);
  const job: Job = { status: 'en cours', phase: 'Téléchargement de l’historique…', progress: 0, startedAt: Date.now() };
  // on garde l'ancien historique de trades tant que le nouveau calcul n'est pas fini
  if (running?.trades) {
    job.trades = running.trades;
    job.result = running.result;
  }
  jobs.set(pair, job);
  const costs = {
    spread: Number.isFinite(spread) && spread! >= 0 && spread! < 50 * info.pipSize ? spread! : info.defaultSpread,
    commissionPerLot: Number.isFinite(commissionPerLot) && commissionPerLot! >= 0 && commissionPerLot! <= 100 ? commissionPerLot! : 7,
    contract: info.contract,
  };
  (async () => {
    try {
      const hist = await getHistory(pair, msg => (job.phase = `Téléchargement : ${msg}`));
      if (hist.h1.length < 1500 || hist.m15.length < 800) throw new Error(`historique insuffisant (${hist.h1.length} H1, ${hist.m15.length} M15)`);
      job.meta = { source: hist.source, futuresProxy: hist.futuresProxy, limitedBySource: hist.limitedBySource, m15Count: hist.m15.length };
      job.run = new BacktestRun(pair, hist.h1, hist.m15, info.decimals, costs);
      job.phase = 'Calcul : 0 %';
      backgroundLoop(job);
    } catch (err: any) {
      job.status = 'erreur';
      job.error = String(err?.message || err);
      job.finishedAt = Date.now();
      console.error(`[Backtest ${pair}] erreur : ${job.error}`);
    }
  })();
  return view(job);
}

export type HistoryForSignal =
  | SimilarHistory
  | { status: 'en préparation'; message: string; progress: number }
  | { status: 'indisponible'; message: string };

/**
 * Résultat historique des setups similaires au plan actuel.
 * Lance automatiquement le backtest si aucun n'existe (ou s'il a plus de 7 jours).
 */
export function historyForSignal(pair: string, features: SetupFeatures | null): HistoryForSignal | null {
  let job = jobs.get(pair);
  const stale = job?.status === 'terminé' && Date.now() - (job.finishedAt || 0) > MAX_AGE;
  const bundled = bundledSnapshot(pair);
  const snapFresh = !!bundled && Date.now() - bundled.generatedAt < 2 * MAX_AGE;
  if ((!job && !snapFresh) || job?.status === 'erreur' || stale) {
    try {
      startBacktest(pair);
    } catch {
      /* actif non supporté : ignoré */
    }
    job = jobs.get(pair);
  }
  if (!features) return null;
  if (job?.trades && job.result) {
    const h = similarHistory(job.trades, features, { from: job.result.from, to: job.result.to });
    return h ?? { status: 'indisponible', message: 'Aucun setup comparable dans l’historique.' };
  }
  // En attendant un calcul frais : historique embarqué dans l'app (même moteur, mêmes règles)
  const snap = bundledSnapshot(pair);
  if (snap) {
    let trades = bundledCache.get(pair);
    if (!trades) bundledCache.set(pair, (trades = importTrades(snap.rows)));
    const h = similarHistory(trades, features, { from: snap.from, to: snap.to });
    if (h) return h;
  }
  if (job?.status === 'erreur') return { status: 'indisponible', message: `Historique indisponible : ${job.error}` };
  return {
    status: 'en préparation',
    message: `Historique en cours de calcul (${job?.phase ?? 'démarrage'}). Le résultat passé de ce type de setup s’affichera à la prochaine analyse.`,
    progress: job?.progress ?? 0,
  };
}

/** Trades du dernier backtest terminé (pour l'export compact). */
export function finishedTrades(pair: string): BtTrade[] | null {
  const j = jobs.get(pair);
  return j?.status === 'terminé' && j.trades ? j.trades : null;
}
