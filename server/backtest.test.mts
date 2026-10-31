// Tests du simulateur et du backtest : npx tsx server/backtest.test.ts
import { simulate, runBacktest } from './backtest';
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
  console.log(`(info) marché aléatoire — strict : ${res.strict.trades} trades, ${res.strict.totalR} R ; souple : ${res.souple.trades} trades, ${res.souple.totalR} R`);
}

if (failed) {
  console.log(`\n${failed} test(s) en échec`);
  process.exit(1);
}
console.log('\nTous les tests du backtest passent.');
