// Backtest ORA : exécution, durée, absence d'information future. npx tsx server/oraBacktest.test.ts
import { runOraBacktest } from './oraBacktest';
import { oraKillZone } from './smcMasterEngine';
import type { Candle } from './marketData';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
// marche aléatoire reproductible sur ~4 mois en M5, agrégée en M15 et H1
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const start = Date.UTC(2026, 5, 1);
const m5: Candle[] = [];
let p = 2000;
for (let t = start; t < start + 120 * 86_400_000; t += 300_000) {
  const d = new Date(t);
  if (d.getUTCDay() === 6 || (d.getUTCDay() === 0 && d.getUTCHours() < 22) || (d.getUTCDay() === 5 && d.getUTCHours() >= 21)) continue;
  const o = p;
  const move = (rnd() - 0.5) * (rnd() < 0.05 ? 12 : 3);
  p = o + move;
  m5.push({ t, o, h: Math.max(o, p) + rnd() * 1.5, l: Math.min(o, p) - rnd() * 1.5, c: p });
}
const agg = (src: Candle[], ms: number) => {
  const out: Candle[] = [];
  for (const c of src) {
    const k = Math.floor(c.t / ms) * ms;
    const last = out[out.length - 1];
    if (!last || last.t !== k) out.push({ t: k, o: c.o, h: c.h, l: c.l, c: c.c });
    else { last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; }
  }
  return out;
};
const m15 = agg(m5, 900_000);
const h1 = agg(m5, 3_600_000);
const t0 = Date.now();
const r = runOraBacktest('XAU/USD', h1, m15, m5, { spread: 0.2, commissionPerLot: 7, contract: 100 }, start + 10 * 86_400_000, start + 65 * 86_400_000);
const ms = Date.now() - t0;
console.log(`(info) ${m5.length} bougies M5, ${r.signals} signaux, ${r.trades} trades, ${ms} ms, moyenne ${r.all.avgR} R`);
ok('Le backtest ORA tourne jusqu’au bout', r.all.trades === r.trades);
ok('Durée raisonnable (< 20 s pour 4 mois)', ms < 20_000, `${ms} ms`);
ok('Deux moitiés = total', r.firstHalf.trades + r.secondHalf.trades === r.trades);
const byT = new Map(m5.map(c => [c.t, c]));
ok('Entrée = clôture de la bougie M5 qui vient de se terminer (pas d’information future)', r.last.every(t => Math.abs((byT.get(t.at - 300_000)?.c ?? NaN) - t.entry) < 0.006), r.last.slice(0, 2).map(t => `${t.entry}`).join(','));
ok('Signaux uniquement en kill zone ORA (heure de New York)', r.last.every(t => oraKillZone(t.at - 300_000).active));
if (failed) { console.log(`\n${failed} test(s) en échec`); process.exit(1); }
console.log('\nTous les tests du backtest ORA passent.');
