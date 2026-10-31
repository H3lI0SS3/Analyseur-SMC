// Tests du simulateur et du backtest : npx tsx server/backtest.test.ts
import { simulate, runBacktest, BacktestRun, similarHistory, normCdf, type BtTrade, type SetupFeatures } from './backtest';
import { exportTrades, importTrades } from './historySnapshot';
import type { Candle } from './marketData';
import type { Setup } from './smc';
import { nyParts } from './time';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};

const T0 = Date.UTC(2026, 10, 3, 13);
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ t: T0 + i * 900_000, o, h, l, c });
const setup = (p: Partial<Setup>): Setup => ({
  direction: 'acheter', entryType: 'limite', entry: 100, sl: 99, tp1: 102, tp2: 104,
  tp1Label: '', tp2Label: null, rr1: 2, rr2: 4, zoneId: 'z', zoneLabel: 'z', ...p,
});

// 1. Achat limite servi, TP1 puis TP2
{
  const c = [bar(0, 101, 101.5, 99.8, 100.5), bar(1, 100.5, 102.2, 100.4, 102), bar(2, 102, 104.3, 101.9, 104)];
  const r = simulate(setup({}), T0, c, 0, 0);
  ok('Achat : TP1 puis TP2', r.outcome === 'gagné' && Math.abs(r.pnl - 3) < 1e-9, `pnl ${r.pnl}`);
}
// 2. Stop et objectif dans la même bougie : on compte le stop
{
  const c = [bar(0, 101, 101, 99.9, 100), bar(1, 100, 102.5, 98.5, 101)];
  const r = simulate(setup({}), T0, c, 0, 0);
  ok('Stop compté en premier si même bougie', r.outcome === 'perdu' && Math.abs(r.pnl + 1) < 1e-9);
}
// 3. TP1 puis retour au point d'entrée : break-even sur le reste
{
  const c = [bar(0, 101, 101, 99.9, 100), bar(1, 100, 102.1, 100, 102), bar(2, 102, 102, 99.9, 100)];
  const r = simulate(setup({}), T0, c, 0, 0);
  ok('TP1 puis stop au point d’entrée : gain partiel', r.outcome === 'gagné' && Math.abs(r.pnl - 1) < 1e-9, `pnl ${r.pnl}`);
}
// 4. Ordre limite jamais touché : expiré
{
  const c = Array.from({ length: 20 }, (_, i) => bar(i, 101, 101.5, 100.5, 101));
  ok('Ordre non servi en 4 h : expiré', simulate(setup({}), T0, c, 0, 0).outcome === 'expiré');
}
// 5. Vente : le stop se déclenche sur l'ask (bid + spread)
{
  const s = setup({ direction: 'vendre', entry: 100, sl: 101, tp1: 98, tp2: null });
  const c = [bar(0, 99.5, 100.1, 99.4, 100), bar(1, 100, 100.95, 99.8, 100.5)];
  const r = simulate(s, T0, c, 0, 0.1);
  ok('Vente : stop touché via le spread', r.outcome === 'perdu', `${r.outcome}`);
}

// 5b. Modes de gestion
{
  const c = [bar(0, 101, 101, 99.9, 100), bar(1, 100, 102.1, 100, 102), bar(2, 102, 104.2, 101.5, 104)];
  ok('Gestion tout à TP1 : +2', Math.abs(simulate(setup({}), T0, c, 0, 0, 'tp1').pnl - 2) < 1e-9);
  ok('Gestion objectif final : +4', Math.abs(simulate(setup({}), T0, c, 0, 0, 'final').pnl - 4) < 1e-9);
  const back = [bar(0, 101, 101, 99.9, 100), bar(1, 100, 102.1, 100, 102), bar(2, 102, 102, 98.9, 99)];
  ok('Gestion objectif final : pas de point mort, retour au stop = -1', Math.abs(simulate(setup({}), T0, back, 0, 0, 'final').pnl + 1) < 1e-9);
}

// 6. Backtest complet sur données synthétiques : pas de crash, durée raisonnable
{
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const m15: Candle[] = [];
  let p = 1.16;
  for (let t = Date.UTC(2026, 0, 5); t < Date.UTC(2026, 9, 30); t += 900_000) {
    const ny = nyParts(t);
    if ((ny.dow === 5 && ny.h >= 17) || ny.dow === 6 || (ny.dow === 0 && ny.h < 17)) continue;
    const o = p, c = o + (rnd() - 0.5) * 0.0008;
    m15.push({ t, o, h: Math.max(o, c) + rnd() * 0.0004, l: Math.min(o, c) - rnd() * 0.0004, c });
    p = c;
  }
  const h1: Candle[] = [];
  for (const c of m15) {
    const k = Math.floor(c.t / 3_600_000) * 3_600_000, last = h1[h1.length - 1];
    if (!last || last.t !== k) h1.push({ ...c, t: k });
    else { last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; }
  }
  const t0 = Date.now();
  const res = await runBacktest('EUR/USD', h1.slice(-5000), m15.slice(-5000), 5, { spread: 0.0001, commissionPerLot: 7, contract: 100_000 });
  const secs = (Date.now() - t0) / 1000;
  ok('Backtest complet exécuté', res.stepsEvaluated > 1000, `${res.stepsEvaluated} pas en ${secs.toFixed(1)} s`);
  ok('Moins de 90 s de calcul', secs < 90);
  ok('La règle stricte prend au plus autant de signaux que la souple', res.strict.signals <= res.souple.signals, `${res.strict.signals} vs ${res.souple.signals}`);
  ok('Résultats cohérents (gains + pertes + BE = trades)', res.strict.wins + res.strict.losses + res.strict.breakeven === res.strict.trades);
  ok('Statistiques « depuis le gel » présentes', !!res.strictForward && !!res.soupleForward);
  // Labo : la variante de référence doit reproduire exactement le backtest « sweep en bonus »
  const baseV = res.lab.variants.find(v => v.id === 'base')!;
  const strictV = res.lab.variants.find(v => v.id === 'strict')!;
  const sum = (x: { trades: number; totalR: number }, y: { trades: number; totalR: number } | null) => ({ trades: x.trades + (y?.trades ?? 0), totalR: Number((x.totalR + (y?.totalR ?? 0)).toFixed(2)) });
  const bAll = sum(baseV.inSample, baseV.outOfSample);
  ok('Labo : la référence reproduit le backtest actuel', bAll.trades === res.souple.trades && Math.abs(bAll.totalR - res.souple.totalR) < 0.05, `${bAll.trades} trades ${bAll.totalR} R vs ${res.souple.trades} trades ${res.souple.totalR} R`);
  ok('Labo : la variante stricte reproduit le backtest strict (1re moitié)', strictV.inSample.trades <= res.strict.trades, `${strictV.inSample.trades} ≤ ${res.strict.trades}`);
  const revealed = res.lab.variants.filter(v => v.outOfSample !== null).map(v => v.id);
  ok('Labo : 2e moitié révélée seulement pour la référence et au plus 3 variantes', revealed.includes('base') && revealed.length <= 4, revealed.join(', '));
  ok('Labo : 12 variantes évaluées', res.lab.variants.length === 12);
  // le découpage en tranches ne doit pas changer le résultat
  const run = new BacktestRun('EUR/USD', h1.slice(-5000), m15.slice(-5000), 5, { spread: 0.0001, commissionPerLot: 7, contract: 100_000 });
  while (!run.done) run.step(137);
  const r2 = run.result();
  ok('Calcul par tranches identique au calcul en une fois', r2.souple.totalR === res.souple.totalR && r2.strict.trades === res.strict.trades, `${r2.souple.totalR} vs ${res.souple.totalR}`);
  console.log(`(info) marché aléatoire — strict : ${res.strict.trades} trades, ${res.strict.totalR} R ; souple : ${res.souple.trades} trades, ${res.souple.totalR} R`);
}

// 7. Téléchargement de l'historique page par page (Twelve Data simulé)
{
  process.env.TWELVE_DATA_API_KEY = 'test';
  process.env.TWELVE_RATE_PER_MIN = '1000';
  const realFetch = globalThis.fetch;
  const firstAvailable = Date.UTC(2025, 3, 1); // la source ne remonte pas avant le 1er avril 2025
  const lastBar = Date.UTC(2026, 9, 30, 20, 45);
  let calls = 0;
  globalThis.fetch = (async (url: any) => {
    calls++;
    const u = new URL(String(url));
    const step = u.searchParams.get('interval') === '15min' ? 900_000 : 3_600_000;
    const end = u.searchParams.get('end_date') ? Date.parse(u.searchParams.get('end_date')!.replace(' ', 'T') + 'Z') : lastBar;
    const vals: any[] = [];
    // comme Twelve Data, la source simulée publie AUSSI des bougies plates le week-end
    for (let t = Math.floor(end / step) * step; vals.length < 5000 && t >= firstAvailable; t -= step) {
      vals.push({ datetime: new Date(t).toISOString().slice(0, 19).replace('T', ' '), open: '1.1', high: '1.11', low: '1.09', close: '1.1' });
    }
    vals.reverse();
    if (!vals.length) return new Response(JSON.stringify({ status: 'error', code: 400, message: 'No data is available on the specified dates.' }), { status: 200 });
    return new Response(JSON.stringify({ status: 'ok', values: vals }), { status: 200 });
  }) as any;
  const { getHistory } = await import('./marketData');
  const hist = await getHistory('EUR/USD');
  globalThis.fetch = realFetch;
  const sortedUnique = hist.m15.every((c, i) => i === 0 || c.t > hist.m15[i - 1].t);
  ok('Historique M15 reconstitué sans doublon ni trou de tri', sortedUnique, `${hist.m15.length} bougies, ${calls} requêtes`);
  ok('Remonte jusqu’à la limite de la source', Math.abs(hist.m15[0].t - firstAvailable) < 7 * 86_400_000, new Date(hist.m15[0].t).toISOString().slice(0, 10));
  ok('Limite de la source signalée', hist.limitedBySource === true);
  ok('H1 couvre la période M15 + préchauffage', hist.h1[0].t <= hist.m15[0].t + 7 * 86_400_000, `H1 dès ${new Date(hist.h1[0].t).toISOString().slice(0, 10)}`);
}

// 8. Historique des setups similaires
{
  const f: SetupFeatures = { direction: 'vendre', zoneKind: 'OB', zoneTf: 'M15', session: 'Kill zone de New York', sweep: true, amd: true, premiumDiscount: true, entryType: 'limite' };
  const mk = (over: Partial<SetupFeatures>, r: number | null, i: number): BtTrade => ({
    variant: 'souple', signalAt: i, filledAt: r === null ? null : i, exitAt: i, direction: (over.direction ?? f.direction), entry: 1, sl: 1, tp1: 1, tp2: null,
    plannedRR: 2, outcome: r === null ? 'expiré' : r > 0 ? 'gagné' : 'perdu', r, session: '', amdPhase: '', features: { ...f, ...over },
  });
  const trades: BtTrade[] = [];
  // 40 setups identiques, nettement gagnants
  for (let i = 0; i < 40; i++) trades.push(mk({}, i % 2 ? 2.5 : -1, i));
  // 200 autres setups (achats) perdants
  for (let i = 0; i < 200; i++) trades.push(mk({ direction: 'acheter' }, i % 4 ? -1 : 1.5, 100 + i));
  const h = similarHistory(trades, f, { from: 0, to: 1 })!;
  ok('Setups identiques trouvés au niveau le plus précis', h.trades === 40 && h.matched.length === 6, h.criteria);
  ok('Moyenne exacte', Math.abs(h.avgR - 0.75) < 1e-9, `${h.avgR}`);
  ok('Verdict favorable si toute la fourchette est > 0', h.verdict === (h.ciLow > 0 ? 'favorable' : 'non démontré'), `${h.ciLow} → ${h.ciHigh}`);
  const g = similarHistory(trades, { ...f, direction: 'acheter', zoneKind: 'FVG' }, { from: 0, to: 1 })!;
  ok('Élargissement automatique si trop peu de setups identiques', g.matched.length === 1 && g.trades === 200, g.criteria);
  ok('Setup historiquement perdant détecté', g.verdict === 'défavorable', `${g.avgR} R`);
  const few = similarHistory(trades.slice(0, 10), f, { from: 0, to: 1 })!;
  ok('Moins de 30 setups au total : on utilise tous les signaux', few.matched.length === 0 && few.trades === 10);
  ok('Moins de 30 trades : aucun verdict', few.verdict === 'non démontré');
  ok('Les ordres expirés ne comptent pas comme trades', similarHistory([...trades, mk({}, null, 999)], f, { from: 0, to: 1 })!.trades === 40);
}

// 9. Viabilité et export compact
{
  ok('normCdf(0) = 0,5', Math.abs(normCdf(0) - 0.5) < 1e-7);
  ok('normCdf(1,036) ≈ 0,85', Math.abs(normCdf(1.036) - 0.85) < 0.001, `${normCdf(1.036).toFixed(4)}`);
  ok('normCdf(-1,96) ≈ 0,025', Math.abs(normCdf(-1.96) - 0.025) < 0.001);
  const f: SetupFeatures = { direction: 'vendre', zoneKind: 'OB', zoneTf: 'M15', session: 'Kill zone de Londres', sweep: true, amd: false, premiumDiscount: true, entryType: 'limite' };
  const mk = (r: number | null, i: number): BtTrade => ({ variant: 'souple', signalAt: i, filledAt: r === null ? null : i, exitAt: i, direction: 'vendre', entry: 1, sl: 1, tp1: 1, tp2: null, plannedRR: 2, outcome: r === null ? 'expiré' : r > 0 ? 'gagné' : 'perdu', r, session: '', amdPhase: '', features: f });
  const strong = Array.from({ length: 100 }, (_, i) => mk(i % 2 ? 2.5 : -1, i)); // moyenne +0,75 R
  const weak = Array.from({ length: 100 }, (_, i) => mk(i % 4 ? -1 : 3, i)); // moyenne 0 R
  const hs = similarHistory(strong, f, { from: 0, to: 1 })!;
  const hw = similarHistory(weak, f, { from: 0, to: 1 })!;
  ok('Viabilité élevée pour un setup nettement rentable', (hs.viability ?? 0) >= 99, `${hs.viability} %`);
  ok('Viabilité ≈ 50 % pour un setup à espérance nulle', Math.abs((hw.viability ?? 0) - 50) <= 2, `${hw.viability} %`);
  ok('Pas de viabilité sous 30 trades', similarHistory(strong.slice(0, 10), f, { from: 0, to: 1 })!.viability === null);
  const round = importTrades(exportTrades([...strong, mk(null, 999)]));
  const hr = similarHistory(round, f, { from: 0, to: 1 })!;
  ok('Export / import compact sans perte', hr.trades === hs.trades && hr.avgR === hs.avgR && hr.viability === hs.viability && round.length === 101);
}

if (failed) {
  console.log(`\n${failed} test(s) en échec`);
  process.exit(1);
}
console.log('\nTous les tests du backtest passent.');
