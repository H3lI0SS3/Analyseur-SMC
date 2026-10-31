// Backtest en tâche de fond, découpé en tranches.
// Cloud Run ne donne vraiment du CPU que pendant les requêtes : chaque consultation de l'état
// (onglet Journal ou connecteur Claude) fait donc avancer le calcul de quelques secondes.
import { PAIRS, getHistory } from './marketData';
import { BacktestRun, type BacktestResult } from './backtest';

export interface JobView {
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
}

const jobs = new Map<string, Job>();

const view = (j: Job): JobView => {
  const { run, meta, ...v } = j;
  return v;
};

/** Fait avancer le calcul (budget en ms) et renvoie l'état. */
export function getJob(pair: string, budgetMs = 8000): JobView | null {
  const job = jobs.get(pair);
  if (!job) return null;
  advance(job, budgetMs);
  return view(job);
}

function advance(job: Job, budgetMs: number) {
  if (job.status !== 'en cours' || !job.run) return;
  job.run.step(budgetMs);
  job.progress = Math.round(job.run.progress * 100);
  job.phase = `Calcul : ${job.progress} %`;
  if (job.run.done) {
    job.result = { ...job.run.result(), ...job.meta! };
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
    }
  })();
  return view(job);
}
