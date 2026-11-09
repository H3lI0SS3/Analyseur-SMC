// Règles 3.7 — protocole en 4 étapes, sur de vraies bougies : npx tsx server/protocol.test.ts
import oct30 from './fixtures/real-2026-10-30.json';
import nov2 from './fixtures/real-2026-11-02-xau.json';
import { analyze, findTrigger, type SweepCandidate, type StructureEvent } from './smc';
import { auditEngine } from './audit';
import type { Candle, Timeframe } from './marketData';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const conv = (rows: any[]): Candle[] => rows.map(([d, o, h, l, c]) => ({ t: Date.parse(d.replace(' ', 'T') + ':00Z'), o, h, l, c }));
const at = (all: Record<Timeframe, Candle[]>, now: number) =>
  Object.fromEntries((['M15', 'H1', 'H4', 'D1'] as Timeframe[]).map(tf => [tf, all[tf].filter(c => c.t <= now)])) as Record<Timeframe, Candle[]>;
const run = (all: Record<Timeframe, Candle[]>, now: number) => {
  const series = at(all, now);
  const e = analyze(series, 2, { now, spread: 0.24, commissionPerLot: 0, contract: 100, news: { available: true, events: [] }, newsCurrencies: ['USD'] });
  return { e, errs: auditEngine(e, { now, series, spread: 0.24, commissionPerLot: 0, contract: 100 }) };
};

// ---------- 02/11/2026 : les deux ventes perdantes de la journée ne sont plus proposées ----------
{
  const all = Object.fromEntries(Object.entries((nov2 as any).series).map(([k, v]) => [k, conv(v as any[])])) as Record<Timeframe, Candle[]>;
  const m = (hhmm: string) => Date.parse(`2026-11-02T${hhmm}:00Z`);
  const a = run(all, m('07:11'));
  ok('02/11 07:11 : pas de vente (pas de displacement ni de CHoCH baissier après le balayage)', a.e.signal === 'attendre', a.e.waitCondition ?? '');
  const b = run(all, m('13:43'));
  ok('02/11 13:43 : pas de vente dans l’impulsion haussière', b.e.signal === 'attendre', b.e.waitCondition ?? '');
  let sells = 0;
  let errs: string[] = [];
  for (let t = m('07:00'); t <= m('17:30'); t += 15 * 60_000) {
    const r = run(all, t + 60_000);
    if (r.e.signal === 'vendre') sells++;
    errs = errs.concat(r.errs);
  }
  ok('02/11 : aucune vente de toute la journée', sells === 0, `${sells}`);
  ok('02/11 : aucune incohérence', errs.length === 0, errs.slice(0, 3).join(' | '));
}

// ---------- 30/10/2026 : journée baissière, le protocole trouve la vente ----------
{
  const all = Object.fromEntries(Object.entries((oct30 as any)['XAU/USD']).map(([k, v]) => [k, conv(v as any[])])) as Record<Timeframe, Candle[]>;
  // 06:16 : FVG encore sous le milieu de l'impulsion (4009.62 → 3987.40) : pas de vente
  const early = run(all, Date.parse('2026-10-30T06:16:00Z'));
  ok('30/10 06:16 : zone en discount de l’impulsion, pas de vente', early.e.signal === 'attendre' && !early.e.checklist.find(c => c.key === 'pd')!.ok, early.e.waitCondition ?? '');
  // 06:46 : l'impulsion s'est prolongée (3981.84), le FVG est maintenant dans la moitié premium.
  // Toutes les étapes sont réunies SAUF le R:R : 1:2,3 jusqu'au TP2, sous le minimum de 1:2,5 (règles 3.8).
  const { e, errs } = run(all, Date.parse('2026-10-30T06:46:00Z'));
  const ck = (k: string) => e.checklist.find(c => c.key === k)!;
  const missing = e.checklist.filter(c => c.core && !c.ok).map(c => c.key);
  ok('30/10 06:46 : seul le R:R manque (1:2,5 exigé), pas de vente', e.signal === 'attendre' && missing.join() === 'rr', `${missing.join()} — ${ck('rr').detail}`);
  ok('Stop au-dessus du plus haut du balayage (4009.62)', !!e.setup && e.setup.sl > 4009.62, `${e.setup?.sl}`);
  ok('Zone en premium de l’impulsion', ck('pd').ok, ck('pd').detail);
  ok('Ordre : balayage puis CHoCH', ck('sweep').detail.includes('06:45') && ck('choch').detail.includes('07:00'));
  ok('30/10 : aucune incohérence', errs.length === 0, errs.join(' | '));
}

// ---------- findTrigger : l'ordre des étapes compte ----------
{
  const base = Date.UTC(2026, 10, 3, 7, 0);
  const c: Candle[] = [];
  for (let i = 0; i < 30; i++) c.push({ t: base - (30 - i) * 900_000, o: 100, h: 100.6, l: 99.4, c: 100 + (i % 2 ? 0.2 : -0.2) });
  // balayage du sommet 101 : mèche à 101.5, clôture à 100.5
  c.push({ t: base, o: 100.2, h: 101.5, l: 100.1, c: 100.5 });
  // displacement baissier : corps 2.5 (moyenne 0.2-0.4)
  c.push({ t: base + 900_000, o: 100.5, h: 100.6, l: 97.9, c: 98.0 });
  c.push({ t: base + 1_800_000, o: 98.0, h: 98.4, l: 97.5, c: 97.8 });
  const sweepIdx = 30;
  const cands: SweepCandidate[] = [{ side: 'buy', label: 'Haut du range asiatique', price: 101, since: 0, htf: true }];
  const mss: StructureEvent = { kind: 'CHoCH', dir: 'bear', level: 99.4, t: c[31].t, idx: 31 };
  const tr = findTrigger(c, [mss], cands, 'bear', base + 2 * 900_000 + 60_000);
  ok('Balayage → displacement → CHoCH : déclencheur trouvé', !!tr && tr.extreme === 101.5 && tr.sweep.idx === sweepIdx, JSON.stringify(tr?.sweep));
  ok('Pas de déclencheur à l’achat sur la même séquence', findTrigger(c, [mss], cands, 'bull', base + 2 * 900_000 + 60_000) === null);
  ok('CHoCH AVANT le balayage : pas de déclencheur', findTrigger(c, [{ ...mss, idx: 29, t: c[29].t }], cands, 'bear', base + 2 * 900_000 + 60_000) === null);
  const soft = c.map((k, i) => (i === 31 ? { ...k, o: 100.5, c: 100.1, l: 99.9 } : k));
  ok('Sans displacement : pas de déclencheur', findTrigger(soft, [mss], cands, 'bear', base + 2 * 900_000 + 60_000) === null);
  const killed = [...c, { t: base + 3 * 900_000, o: 97.8, h: 101.8, l: 97.8, c: 101.6 }];
  ok('Clôture au-delà de l’extrême du balayage : déclencheur annulé', findTrigger(killed, [mss], cands, 'bear', base + 3 * 900_000 + 60_000) === null);
  ok('Déclencheur trop ancien : ignoré', findTrigger(c, [mss], cands, 'bear', base + 8 * 3_600_000) === null);
}

if (failed) {
  console.log(`\n${failed} test(s) en échec`);
  process.exit(1);
}
console.log('\nTous les tests du protocole 3.7 passent.');
