// Tests des concepts ICT : npx tsx server/ictConcepts.test.ts
import { findBreakers, findInversionFVGs, findTrendlines, isDisplacement, oteZone } from './ictConcepts';
import { findSwings, scanStructure } from './smc';
import type { Candle } from './marketData';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const M = 15 * 60_000;
const mk = (closes: number[], w = 0.0002): Candle[] =>
  closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: i * M, o, h: Math.max(o, c) + w, l: Math.min(o, c) - w, c };
  });

// Displacement
{
  const cs = mk([...Array.from({ length: 25 }, (_, i) => 1.1 + (i % 2) * 0.0003), 1.1003 + 0.003]);
  ok('Grande bougie pleine = displacement', isDisplacement(cs, 25, 'bull'));
  ok('Petite bougie = pas de displacement', !isDisplacement(cs, 24, 'bull'));
}

// Structure de référence : sommet 1.1013, creux 1.0988, hausse qui casse le sommet (BOS) jusqu'à 1.1030,
// puis chute sous le creux (CHoCH baissier)
const ref: number[] = [];
for (let i = 0; i < 4; i++) ref.push(1.1 + i * 0.0004);
for (let i = 0; i < 6; i++) ref.push(1.1012 - i * 0.0004);
ref.push(1.0988);
for (let i = 1; i <= 8; i++) ref.push(1.0989 + i * 0.0005);
for (let i = 1; i <= 14; i++) ref.push(1.1029 - i * 0.0006);
for (let i = 1; i <= 3; i++) ref.push(1.0945 + i * 0.0003);
const rc = mk(ref, 0.0001);
const rsw = findSwings(rc, 2);
const rst = scanStructure(rc, rsw, 2);

// OTE achat de la jambe 1.0987 -> 1.1030 : 62-79 %
{
  const o = oteZone(rc, rst.events, rsw, 'bull');
  const size = 1.103 - 1.0987;
  ok('OTE = retracement 62–79 % de la jambe qui a cassé la structure', !!o && Math.abs(o.top - (1.103 - 0.62 * size)) < 1e-6 && Math.abs(o.bottom - (1.103 - 0.79 * size)) < 1e-6, JSON.stringify(o));
}

// Trendline : 3 sommets descendants alignés puis prix sous la ligne
{
  const closes: number[] = [];
  const peaks = [1.11, 1.108, 1.106];
  for (const pk of peaks) {
    for (let i = 0; i < 6; i++) closes.push(pk - 0.003 + i * 0.0005);
    closes.push(pk);
    for (let i = 1; i <= 6; i++) closes.push(pk - i * 0.0005);
  }
  for (let i = 0; i < 4; i++) closes.push(1.102);
  const cs = mk(closes, 0);
  const sw = findSwings(cs, 2);
  const tls = findTrendlines(cs, sw, 0.002, 'M15', 200);
  const buy = tls.find(t => t.side === 'buy');
  ok('Trendline de 3 sommets descendants détectée (liquidité au-dessus)', !!buy && buy.touches >= 3 && buy.intact, JSON.stringify(buy));
}

// Breaker : OB haussier (creux 1.0988) cassé par une clôture puis CHoCH baissier = breaker baissier
{
  const brk = findBreakers(rc, 'M15', rst.events, rsw, 0.003);
  ok('Breaker baissier détecté après la cassure de l’OB haussier', brk.some(z => z.kind === 'Breaker' && z.dir === 'bear'), JSON.stringify(brk.map(z => [z.dir, z.bottom, z.top])));
}

// IFVG : FVG haussier (gap 1.1010-1.1020) traversé par une clôture sous 1.1010 = zone de vente
{
  const cs: Candle[] = [];
  for (let i = 0; i < 10; i++) cs.push({ t: i * M, o: 1.1, h: 1.1005, l: 1.0995, c: 1.1 });
  cs.push({ t: 10 * M, o: 1.1, h: 1.101, l: 1.0998, c: 1.1008 });
  cs.push({ t: 11 * M, o: 1.1008, h: 1.1035, l: 1.1006, c: 1.1032 });
  cs.push({ t: 12 * M, o: 1.1032, h: 1.104, l: 1.102, c: 1.1035 });
  for (let i = 13; i < 18; i++) cs.push({ t: i * M, o: 1.103, h: 1.1032, l: 1.1012, c: 1.1015 });
  cs.push({ t: 18 * M, o: 1.1015, h: 1.1016, l: 1.0995, c: 1.0998 });
  cs.push({ t: 19 * M, o: 1.0998, h: 1.1002, l: 1.099, c: 1.0995 });
  const z = findInversionFVGs(cs, 'M15', 0.002);
  ok('FVG haussier cassé par une clôture = IFVG baissier', z.some(x => x.kind === 'IFVG' && x.dir === 'bear' && Math.abs(x.bottom - 1.101) < 1e-9 && Math.abs(x.top - 1.102) < 1e-9), JSON.stringify(z));
}

if (failed) {
  console.log(`\n${failed} test(s) en échec`);
  process.exit(1);
}
console.log('\nTous les tests des concepts ICT passent.');
