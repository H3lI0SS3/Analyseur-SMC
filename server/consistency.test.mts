// Tests de cohérence avec des trades : npx tsx server/consistency.test.mts
// 1. Le moteur ne se contredit jamais (contrôleur d'invariants) sur des marchés en tendance, en range, le week-end et autour des annonces.
// 2. Chaque trade du backtest est cohérent et donne EXACTEMENT le même résultat quand il est rejoué par le suivi du journal.
// 3. Parité backtest / suivi sur des centaines de trades aléatoires (limite, marché, achat, vente, gaps).
import { aggregateTrading, type Candle, type Timeframe } from './marketData';
import { analyze } from './smc';
import { auditEngine } from './audit';
import { BacktestRun, simulate } from './backtest';
import { evaluate } from '../src/lib/tracker';
import { nyParts } from './time';
import type { JournalEntry } from '../src/types';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const M15 = 900_000;
const H = 3_600_000;

/** Marché synthétique : alternance de tendances et de ranges, week-ends fermés, gap à la réouverture. */
function market(seed: number, start: number, end: number, base: number, vol: number): { m15: Candle[]; h1: Candle[] } {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const m15: Candle[] = [];
  let p = base;
  let drift = 0;
  let lastT = 0;
  for (let t = start; t < end; t += M15) {
    const ny = nyParts(t);
    if ((ny.dow === 5 && ny.h >= 17) || ny.dow === 6 || (ny.dow === 0 && ny.h < 17)) continue;
    if (t % (2 * 24 * H) === 0) drift = (rnd() - 0.5) * 0.6; // nouveau régime tous les 2 jours
    if (lastT && t - lastT > 4 * H) p += (rnd() - 0.5) * vol * 12; // gap de réouverture
    lastT = t;
    const o = p;
    const impulse = rnd() < 0.03 ? (rnd() - 0.5) * vol * 14 : 0; // displacements occasionnels
    const c = o + (rnd() - 0.5 + drift * 0.3) * vol * 4 + impulse;
    m15.push({ t, o, h: Math.max(o, c) + rnd() * vol * 2, l: Math.min(o, c) - rnd() * vol * 2, c });
    p = c;
  }
  const h1: Candle[] = [];
  for (const c of m15) {
    const k = Math.floor(c.t / H) * H;
    const last = h1[h1.length - 1];
    if (!last || last.t !== k) h1.push({ ...c, t: k });
    else {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
    }
  }
  return { m15, h1 };
}

// ---------- 1. Contrôleur d'invariants sur 3 marchés (or et EUR/USD), toutes les 2 h, avec annonces et week-ends ----------
{
  const markets = [
    { seed: 7, base: 1.16, vol: 0.0002, dec: 5, spread: 0.0001, contract: 100_000 },
    { seed: 99, base: 4000, vol: 0.9, dec: 2, spread: 0.3, contract: 100 },
    { seed: 2024, base: 1.09, vol: 0.00025, dec: 5, spread: 0.0001, contract: 100_000 },
  ];
  let runs = 0;
  let signals = 0;
  let plans = 0;
  const problems = new Map<string, number>();
  for (const mk of markets) {
    const { m15, h1 } = market(mk.seed, Date.UTC(2026, 3, 1), Date.UTC(2026, 9, 10), mk.base, mk.vol);
    const h4 = aggregateTrading(h1, 'H4');
    const d1 = aggregateTrading(h1, 'D1');
    for (let now = Date.UTC(2026, 8, 1) + 5 * 60_000; now < Date.UTC(2026, 9, 10); now += 2 * H) {
      const cut = (c: Candle[]) => c.filter(x => x.t <= now);
      const series: Record<Timeframe, Candle[]> = { M15: cut(m15).slice(-700), H1: cut(h1).slice(-3000), H4: cut(h4), D1: cut(d1) };
      if (series.M15.length < 100) continue;
      // une annonce forte de temps en temps, parfois imminente
      const news = { available: true, events: runs % 7 === 0 ? [{ t: now + 10 * 60_000, currency: 'USD', title: 'CPI' }] : runs % 5 === 0 ? [{ t: now + 2 * H, currency: 'USD', title: 'NFP' }] : [] };
      const ctx = { now, series, spread: mk.spread, commissionPerLot: 7, contract: mk.contract };
      const e = analyze(series, mk.dec, { ...ctx, news, newsCurrencies: ['USD'] });
      runs++;
      if (e.setup) plans++;
      if (e.signal !== 'attendre') signals++;
      if (news.events[0] && Math.abs(news.events[0].t - now) <= 30 * 60_000 && e.signal !== 'attendre') problems.set('signal pendant une annonce', (problems.get('signal pendant une annonce') || 0) + 1);
      for (const m of auditEngine(e, ctx)) problems.set(m.replace(/[\d.]{4,}/g, '#'), (problems.get(m.replace(/[\d.]{4,}/g, '#')) || 0) + 1);
    }
  }
  ok(`Aucune incohérence sur ${runs} analyses (${plans} plans, ${signals} signaux)`, problems.size === 0, [...problems].map(([k, v]) => `${k} ×${v}`).join(' | '));
  ok('Le test couvre des plans et des signaux', plans > 50 && signals > 5, `${plans} plans, ${signals} signaux`);
}

// ---------- 2. Backtest : chaque trade est cohérent et identique quand le journal le rejoue ----------
{
  const { m15, h1 } = market(31, Date.UTC(2026, 4, 1), Date.UTC(2026, 9, 1), 1.12, 0.0002);
  const run = new BacktestRun('EUR/USD', h1, m15.slice(-2600), 5, { spread: 0.0001, commissionPerLot: 7, contract: 100_000 });
  while (!run.done) run.step(5000);
  const trades = run.allTrades();
  const end = m15[m15.length - 1].t + M15;
  let mismatches: string[] = [];
  let checked = 0;
  for (const t of trades) {
    const long = t.direction === 'acheter';
    if (long ? !(t.sl < t.entry && t.entry < t.tp1) : !(t.sl > t.entry && t.entry > t.tp1)) mismatches.push(`niveaux incohérents ${t.signalAt}`);
    if (t.r !== null && t.outcome === 'perdu' && t.r > 0) mismatches.push('trade perdu avec un R positif');
    if (t.r !== null && t.outcome === 'gagné' && t.r <= 0 && !t.tp2) mismatches.push('trade gagné avec un R négatif');
    const j: JournalEntry = {
      id: 'b', createdAt: t.signalAt, pair: 'EUR/USD', direction: t.direction, entry: t.entry, sl: t.sl, tp: t.tp2 ?? t.tp1, rrPlanned: t.plannedRR,
      riskPct: 1, lots: 1, result: t.entryType === 'limite' ? 'attente' : 'en_cours', rMultiple: null, note: '', auto: true,
      entryType: t.entryType, tp1: t.tp1, tp2: t.tp2, validUntil: t.signalAt + 4 * H, spread: 0.0001, commissionPerLot: 7, contract: 100_000,
      filledAt: null, tp1At: null, exitAt: null,
    };
    const ev = evaluate(j, m15.filter(c => c.t >= t.signalAt - M15), end);
    checked++;
    const trackerR = ev?.rMultiple ?? null;
    const trackerExpired = ev?.result === 'expire';
    if (t.outcome === 'expiré' ? !trackerExpired : t.outcome === 'en cours' ? !(ev === null || ev.result === 'en_cours') : trackerR === null || Math.abs(trackerR - (t.r as number)) > 0.011)
      mismatches.push(`${new Date(t.signalAt).toISOString().slice(5, 16)} backtest ${t.outcome} ${t.r} / journal ${ev?.result} ${trackerR}`);
  }
  ok(`Backtest : ${trades.length} trades simulés`, trades.length >= 10, `${trades.length}`);
  ok(`Chaque trade du backtest est cohérent et rejoué à l’identique par le journal (${checked} trades)`, mismatches.length === 0, mismatches.slice(0, 5).join(' | '));
}

// ---------- 3. Parité sur des trades aléatoires ----------
{
  const { m15 } = market(555, Date.UTC(2026, 6, 1), Date.UTC(2026, 9, 1), 4000, 0.9);
  let s = 77;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const diffs: string[] = [];
  const N = 600;
  const spread = 0.3;
  for (let n = 0; n < N; n++) {
    const k = 50 + Math.floor(rnd() * (m15.length - 800));
    const from = m15[k].t + M15; // signal à la clôture de la bougie k
    const price = m15[k].c;
    const long = rnd() < 0.5;
    const market = rnd() < 0.3;
    const risk = 2 + rnd() * 8;
    const entry = market ? price : long ? price - rnd() * 6 : price + rnd() * 6;
    const sl = long ? entry - risk : entry + risk;
    const tp1 = long ? entry + risk * (1 + rnd() * 3) : entry - risk * (1 + rnd() * 3);
    const tp2 = rnd() < 0.6 ? (long ? tp1 + risk * rnd() * 3 : tp1 - risk * rnd() * 3) : null;
    const setup = { direction: long ? 'acheter' : 'vendre', entryType: market ? 'marché' : 'limite', entry, sl, tp1, tp2, tp1Label: '', tp2Label: null, rr1: 0, rr2: null, zoneId: '', zoneLabel: '' } as const;
    const sim = simulate(setup as any, from, m15, k + 1, spread);
    const comm = 7 / 100;
    const simR = sim.outcome === 'expiré' || sim.outcome === 'en cours' ? null : Number(((sim.pnl - comm) / (sim.risk + comm)).toFixed(2));
    const j: JournalEntry = {
      id: 'r', createdAt: from, pair: 'XAU/USD', direction: setup.direction, entry, sl, tp: tp2 ?? tp1, rrPlanned: 2, riskPct: 1, lots: 1,
      result: market ? 'en_cours' : 'attente', rMultiple: null, note: '', auto: true, entryType: setup.entryType, tp1, tp2,
      validUntil: from + 4 * H, spread, commissionPerLot: 7, contract: 100, filledAt: null, tp1At: null, exitAt: null,
    };
    const ev = evaluate(j, m15.slice(k), m15[m15.length - 1].t + M15);
    const same =
      sim.outcome === 'expiré' ? ev?.result === 'expire' : sim.outcome === 'en cours' ? !ev || ev.result === 'en_cours' : ev?.rMultiple !== undefined && ev.rMultiple !== null && Math.abs(ev.rMultiple - (simR as number)) <= 0.011;
    if (!same) diffs.push(`#${n} ${setup.direction} ${setup.entryType} backtest ${sim.outcome} ${simR} / journal ${ev?.result} ${ev?.rMultiple}`);
  }
  ok(`Backtest et journal donnent le même résultat sur ${N} trades aléatoires`, diffs.length === 0, `${diffs.length} écarts : ${diffs.slice(0, 4).join(' | ')}`);
}

if (failed) {
  console.log(`\n${failed} test(s) en échec`);
  process.exit(1);
}
console.log('\nTous les tests de cohérence passent.');
