// Chaîne réelle : moteur sur les vraies bougies du 03/11 → exécution M5 → plan final ; EUR/USD en pause.
// npx tsx server/executionLive.test.ts
import data from './fixtures/real-2026-11-03.json';
import { analyze } from './smc';
import { applyExecution } from './execution';
import type { Candle } from './marketData';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const conv = (rows: any[]) => rows.map(([d, o, h, l, c]: any) => ({ t: Date.parse(d.replace(' ', 'T') + ':00Z'), o, h, l, c }));
const S: any = Object.fromEntries(Object.entries((data as any)['XAU/USD']).map(([k, v]) => [k, conv(v as any[])]));
const TF: Record<string, number> = { M15: 900_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000 };
const costs = { spread: 0.24, commissionPerLot: 7, contract: 100 };
const news = { available: true, events: [] as any[] };
// M5 « réalistes » : chaque M15 découpée en 3 (ouverture → extrême → extrême → clôture)
const toM5 = (m15: Candle[]) =>
  m15.flatMap(c => {
    const up = c.c >= c.o;
    const a = up ? c.l : c.h, b = up ? c.h : c.l;
    return [
      { t: c.t, o: c.o, h: Math.max(c.o, a), l: Math.min(c.o, a), c: a },
      { t: c.t + 300_000, o: a, h: Math.max(a, b), l: Math.min(a, b), c: b },
      { t: c.t + 600_000, o: b, h: Math.max(b, c.c), l: Math.min(b, c.c), c: c.c },
    ];
  });

const at = (now: number) => {
  const series: any = Object.fromEntries(['M15', 'H1', 'H4', 'D1'].map(tf => [tf, S[tf].filter((c: any) => c.t + TF[tf] <= now || (tf !== 'M15' && c.t <= now))]));
  return analyze(series, 2, { now, spread: costs.spread, commissionPerLot: costs.commissionPerLot, contract: costs.contract, news, newsCurrencies: ['USD'] });
};

// 1. Signal M15 de l'or le 03/11 à 07:00 UTC (vente limite, ouverture de Londres), puis suivi M5 quart d'heure par quart d'heure
const t0 = Date.UTC(2026, 10, 3, 7, 0);
const e0 = at(t0);
ok('03/11 07:00 : setup M15 vendeur valide sur les vraies bougies', e0.signal === 'vendre' && !!e0.setup && !!e0.trigger, e0.signal);
const stages: string[] = [];
let order: any = null;
for (let now = t0; now <= t0 + 4 * 3_600_000; now += 900_000) {
  const e = at(now);
  if (e.signal === 'attendre' || !e.setup) { stages.push(`${new Date(now).toISOString().slice(11, 16)} moteur:attendre`); continue; }
  const final: any = { signal: e.signal, plan: { ...e.setup, origin: 'moteur' }, notes: [] };
  const m5 = toM5(S.M15.filter((c: any) => c.t + 900_000 <= now));
  const r = applyExecution('XAU/USD', e, final, m5, now, costs, 2);
  stages.push(`${new Date(now).toISOString().slice(11, 16)} ${r.execution?.stage}`);
  // cohérence à chaque instant
  if (r.execution?.stage === 'ordre') {
    const p = final.plan;
    ok(`${new Date(now).toISOString().slice(11, 16)} ordre M5 : stop au-dessus de l’entrée, objectif en dessous`, p.sl > p.entry && p.entry > p.tp1, `${p.entry} / ${p.sl} / ${p.tp1}`);
    ok(`${new Date(now).toISOString().slice(11, 16)} stop M5 pas plus large que le stop M15`, p.sl - p.entry <= e.setup!.sl - e.setup!.entry + 1e-9 || e.setup!.sl === p.sl);
    ok(`${new Date(now).toISOString().slice(11, 16)} signal conservé et plan = setup moteur`, final.signal === 'vendre' && e.setup!.entry === p.entry && e.setup!.sl === p.sl);
    order = order ?? p;
  } else {
    ok(`${new Date(now).toISOString().slice(11, 16)} pas d’ordre M5 → verdict Attendre avec explication`, final.signal === 'attendre' && /M5/.test(final.notes[0] ?? ''), r.execution?.stage);
  }
}
console.log('(info) étapes :', stages.join(' | '));
ok('Au moins une étape M5 évaluée sur le signal réel', stages.some(s => !s.includes('moteur')));

// 2. M5 indisponibles : jamais d'entrée
{
  const e = at(t0);
  const final: any = { signal: e.signal, plan: { ...e.setup!, origin: 'moteur' }, notes: [] };
  const r = applyExecution('XAU/USD', e, final, null, t0, costs, 2);
  ok('M5 indisponibles : Attendre', r.execution?.stage === 'indisponible' && final.signal === 'attendre');
}
// 3. EUR/USD en pause : un signal devient Attendre, avec la raison
{
  const e = at(t0); // moteur réel ; on le présente comme un signal EUR/USD pour tester la pause seule
  const final: any = { signal: 'vendre', plan: { ...e.setup!, origin: 'moteur' }, notes: [] };
  const r = applyExecution('EUR/USD', e, final, null, t0, costs, 2);
  ok('EUR/USD : pas d’exécution M5', r.execution === null);
  ok('EUR/USD en pause : signal → Attendre, raison en tête', final.signal === "attendre" && /en pause/.test(final.notes[0]) && !!r.paused, final.notes[0]?.slice(0, 80));
}
// 4. Sans signal, rien ne change
{
  const e = at(Date.UTC(2026, 10, 3, 18, 0));
  const final: any = { signal: 'attendre', plan: e.setup ? { ...e.setup, origin: 'moteur' } : null, notes: [] };
  const r = applyExecution('XAU/USD', e, final, [], Date.UTC(2026, 10, 3, 18, 0), costs, 2);
  ok('Pas de signal M15 : pas d’étape M5', r.execution === null && final.signal === 'attendre');
}

if (failed) { console.log(`\n${failed} test(s) en échec`); process.exit(1); }
console.log('\nTous les tests de la chaîne d’exécution passent.');
