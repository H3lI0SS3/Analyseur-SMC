// Audit du moteur sur de VRAIES bougies (or et EUR/USD, 29-30/10/2026), à chaque quart d'heure : npx tsx server/realdata.test.ts
import data from './fixtures/real-2026-10-30.json';
import { analyze } from './smc';
import { auditEngine } from './audit';
import type { Candle, Timeframe } from './marketData';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const conv = (rows: any[]): Candle[] => rows.map(([d, o, h, l, c]) => ({ t: Date.parse(d.replace(' ', 'T') + ':00Z'), o, h, l, c }));

for (const [pair, dec, spread, contract] of [['XAU/USD', 2, 0.3, 100], ['EUR/USD', 5, 0.0001, 100_000]] as const) {
  const raw = (data as any)[pair];
  const all = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, conv(v as any[])])) as Record<Timeframe, Candle[]>;
  const problems: string[] = [];
  let runs = 0;
  let signals = 0;
  for (let t = all.M15[0].t + 40 * 900_000; t <= all.M15[all.M15.length - 1].t; t += 900_000) {
    const series = Object.fromEntries((['M15', 'H1', 'H4', 'D1'] as Timeframe[]).map(tf => [tf, all[tf].filter(c => c.t <= t)])) as Record<Timeframe, Candle[]>;
    const ctx = { now: t + 5 * 60_000, series, spread, commissionPerLot: 7, contract };
    const e = analyze(series, dec, { ...ctx, news: { available: true, events: [] }, newsCurrencies: ['USD'] });
    runs++;
    if (e.signal !== 'attendre') signals++;
    for (const m of auditEngine(e, ctx)) problems.push(`${new Date(t).toISOString().slice(5, 16)} ${m}`);
  }
  ok(`${pair} : aucune incohérence sur ${runs} analyses réelles (${signals} signaux)`, problems.length === 0, problems.slice(0, 5).join(' | '));
}

if (failed) {
  console.log(`\n${failed} test(s) en échec`);
  process.exit(1);
}
console.log('\nTous les tests sur données réelles passent.');
