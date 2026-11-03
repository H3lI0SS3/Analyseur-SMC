// Mise en situation : l'app rejouée quart d'heure par quart d'heure sur les vraies bougies du 02-03/11/2026,
// avec les règles du desk, la taille de position et le suivi automatique. npx tsx server/situation.test.ts
import data from './fixtures/real-2026-11-03.json';
import { analyze } from './smc';
import { auditEngine } from './audit';
import { evaluate } from '../src/lib/tracker';
import { deskCheck } from '../src/lib/desk';
import { lotSize, riskForGrade } from '../src/lib/utils';
import type { JournalEntry } from '../src/types';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const conv = (rows: any[]) => rows.map(([d, o, h, l, c]: any) => ({ t: Date.parse(d.replace(' ', 'T') + ':00Z'), o, h, l, c }));
const P: Record<string, any> = {};
for (const pair of ['XAU/USD', 'EUR/USD']) P[pair] = Object.fromEntries(Object.entries((data as any)[pair]).map(([k, v]) => [k, conv(v as any[])]));
const cfg: Record<string, { dec: number; spread: number; contract: number }> = { 'XAU/USD': { dec: 2, spread: 0.24, contract: 100 }, 'EUR/USD': { dec: 5, spread: 0.00012, contract: 100_000 } };
const TF: Record<string, number> = { M15: 900_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000 };
const news = { available: true, events: [{ t: Date.UTC(2026, 10, 3, 12, 0), currency: 'USD', title: 'Congressional Elections', tentative: true }] };
const journal: JournalEntry[] = [];
let incoh: string[] = [];
let outsideKz = 0;
let runs = 0;
for (let now = Date.UTC(2026, 10, 2, 7, 0); now <= Date.UTC(2026, 10, 3, 21, 15); now += 900_000) {
  for (const j of journal) {
    const m15 = P[j.pair].M15.filter((c: any) => c.t >= j.createdAt - 900_000 && c.t + 900_000 <= now);
    const ev = evaluate({ ...j, result: j.entryType === 'limite' ? 'attente' : 'en_cours', rMultiple: null, filledAt: null, tp1At: null, exitAt: null }, m15, now);
    if (ev) Object.assign(j, ev);
  }
  for (const pair of ['XAU/USD', 'EUR/USD']) {
    const S = P[pair];
    const series: any = Object.fromEntries(['M15', 'H1', 'H4', 'D1'].map(tf => [tf, S[tf].filter((c: any) => c.t + TF[tf] <= now || (tf !== 'M15' && c.t <= now))]));
    const c = cfg[pair];
    if (series.M15.length < 40) continue; // le début de l'échantillon n'a pas assez de bougies
    const e = analyze(series, c.dec, { now, spread: c.spread, commissionPerLot: 0, contract: c.contract, news, newsCurrencies: ['USD'] });
    runs++;
    incoh = incoh.concat(auditEngine(e, { now, series, spread: c.spread, commissionPerLot: 0, contract: c.contract }));
    if (e.signal === 'attendre' || !e.setup) continue;
    if (!e.session.killzone) outsideKz++;
    const s = e.setup;
    if (journal.some(j => j.pair === pair && Math.abs(j.entry - s.entry) < 1e-9) || deskCheck(journal, pair, s.direction, now)) continue;
    const risk = riskForGrade(1, e.grade);
    journal.push({ id: `${pair}-${now}`, createdAt: now, pair, direction: s.direction, entry: s.entry, sl: s.sl, tp: s.tp2 ?? s.tp1, rrPlanned: s.rr2 ?? s.rr1, riskPct: risk, lots: lotSize(pair, 10_000, risk, s.entry, s.sl, 0, 1), result: s.entryType === 'limite' ? 'attente' : 'en_cours', rMultiple: null, note: '', auto: true, entryType: s.entryType, tp1: s.tp1, tp2: s.tp2, validUntil: s.validUntil, spread: c.spread, commissionPerLot: 0, contract: c.contract, filledAt: null, tp1At: null, exitAt: null } as JournalEntry);
  }
}
const gold = journal.find(j => j.pair === 'XAU/USD');
ok(`Aucune incohérence sur ${runs} analyses (or + EUR/USD, 2 jours)`, incoh.length === 0 && runs > 150, incoh.slice(0, 3).join(' | '));
ok('Aucun signal hors kill zone', outsideKz === 0);
ok('02/11 : aucune vente pendant la hausse de l’or', !journal.some(j => j.createdAt < Date.UTC(2026, 10, 2, 22, 0)));
ok('03/11 07:00 : vente limite de l’or à l’ouverture de Londres', !!gold && gold.createdAt === Date.UTC(2026, 10, 3, 7, 0) && gold.direction === 'vendre' && gold.entryType === 'limite', gold ? `${gold.entry} / ${gold.sl}` : 'aucune');
ok('Jour d’élections (horaire inconnu) : risque divisé par 2', gold?.riskPct === 0.5);
ok('Ordre limite annulé : TP1 atteint avant l’exécution (pas de poursuite du prix)', gold?.result === 'expire', gold?.result);
ok('EUR/USD : pas de trade (biais D1/H4 en conflit)', !journal.some(j => j.pair === 'EUR/USD'));

if (failed) {
  console.log(`\n${failed} test(s) en échec`);
  process.exit(1);
}
console.log('\nTous les tests de mise en situation passent.');
