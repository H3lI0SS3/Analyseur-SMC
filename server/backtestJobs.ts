// Lancement du backtest en tâche de fond (il prend jusqu'à ~1 minute) et conservation du dernier résultat.
import { PAIRS, getHistory } from './marketData';
import { runBacktest, type BacktestResult } from './backtest';

interface Job {
  status: 'en cours' | 'terminé' | 'erreur';
  startedAt: number;
  finishedAt?: number;
  result?: BacktestResult & { source: string; futuresProxy: boolean };
  error?: string;
}

const jobs = new Map<string, Job>();

export function getJob(pair: string): Job | null {
  return jobs.get(pair) || null;
}

export function startBacktest(pair: string, spread?: number, commissionPerLot?: number): Job {
  const info = PAIRS[pair];
  if (!info) throw new Error('Actif non supporté (EUR/USD ou XAU/USD).');
  const running = jobs.get(pair);
  if (running && running.status === 'en cours' && Date.now() - running.startedAt < 10 * 60_000) return running;
  const job: Job = { status: 'en cours', startedAt: Date.now() };
  jobs.set(pair, job);
  const costs = {
    spread: Number.isFinite(spread) && spread! >= 0 && spread! < 50 * info.pipSize ? spread! : info.defaultSpread,
    commissionPerLot: Number.isFinite(commissionPerLot) && commissionPerLot! >= 0 && commissionPerLot! <= 100 ? commissionPerLot! : 7,
    contract: info.contract,
  };
  (async () => {
    try {
      const hist = await getHistory(pair);
      if (hist.h1.length < 1500 || hist.m15.length < 800) throw new Error(`historique insuffisant (${hist.h1.length} H1, ${hist.m15.length} M15)`);
      const res = await runBacktest(pair, hist.h1, hist.m15, info.decimals, costs);
      job.result = { ...res, source: hist.source, futuresProxy: hist.futuresProxy };
      job.status = 'terminé';
    } catch (err: any) {
      job.status = 'erreur';
      job.error = String(err?.message || err);
    } finally {
      job.finishedAt = Date.now();
    }
  })();
  return job;
}
