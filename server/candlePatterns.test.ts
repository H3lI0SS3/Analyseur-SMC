// Tests des figures japonaises : npx tsx server/candlePatterns.test.ts
import { findCandlePatterns } from './candlePatterns';
import type { Candle } from './marketData';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const M = 15 * 60_000;
// 20 bougies calmes (corps 0.0002) puis un mouvement de 7 bougies dans le sens `dir`, puis les bougies de la figure
function build(dir: 'baisse' | 'hausse', figure: [number, number, number, number][]): Candle[] {
  const out: Candle[] = [];
  let p = 1.1;
  for (let i = 0; i < 20; i++) {
    const o = p, c = p + (i % 2 ? 0.0002 : -0.0002);
    out.push({ t: i * M, o, h: Math.max(o, c) + 0.0001, l: Math.min(o, c) - 0.0001, c });
    p = c;
  }
  for (let i = 0; i < 7; i++) {
    const o = p, c = p + (dir === 'baisse' ? -0.0004 : 0.0004);
    out.push({ t: (20 + i) * M, o, h: Math.max(o, c) + 0.0001, l: Math.min(o, c) - 0.0001, c });
    p = c;
  }
  figure.forEach(([o, h, l, c], k) => out.push({ t: (27 + k) * M, o: p + o, h: p + h, l: p + l, c: p + c }));
  return out;
}
const names = (cs: Candle[], zone?: { top: number; bottom: number }) => findCandlePatterns(cs, 'M15', { zone }).map(p => `${p.name}${p.inZone ? '*' : ''}`);

ok('Avalement haussier après une baisse', names(build('baisse', [[0, 0.0001, -0.0005, -0.0004], [-0.0005, 0.0003, -0.0006, 0.0002]])).includes('Avalement haussier'));
ok('Avalement haussier sans baisse avant = ignoré', !names(build('hausse', [[0, 0.0001, -0.0005, -0.0004], [-0.0005, 0.0003, -0.0006, 0.0002]])).includes('Avalement haussier'));
ok('Harami haussier', names(build('baisse', [[0, 0.0001, -0.0009, -0.0008], [-0.0005, -0.0003, -0.0007, -0.0004]])).includes('Harami haussier'));
ok('Harami en croix haussier (doji)', names(build('baisse', [[0, 0.0001, -0.0009, -0.0008], [-0.0004, -0.0001, -0.0008, -0.00041]])).includes('Harami en croix haussier'));
ok('Structure pénétrante haussière', names(build('baisse', [[0, 0.0001, -0.0009, -0.0008], [-0.0008, -0.0002, -0.0009, -0.0003]])).includes('Structure pénétrante haussière'));
ok('Étoile du matin', names(build('baisse', [[0, 0.0001, -0.0009, -0.0008], [-0.0008, -0.0007, -0.001, -0.0009], [-0.0009, -0.0002, -0.001, -0.0003]])).includes('Étoile du matin'));
ok('Avalement baissier après une hausse', names(build('hausse', [[0, 0.0005, -0.0001, 0.0004], [0.0005, 0.0006, -0.0003, -0.0002]])).includes('Avalement baissier'));
ok('Couverture en nuage noir', names(build('hausse', [[0, 0.0009, -0.0001, 0.0008], [0.0008, 0.0009, 0.0002, 0.0003]])).includes('Couverture en nuage noir'));
ok('Étoile du soir', names(build('hausse', [[0, 0.0009, -0.0001, 0.0008], [0.0008, 0.001, 0.0007, 0.0009], [0.0009, 0.001, 0.0002, 0.0003]])).includes('Étoile du soir'));
ok('Figure marquée « dans la zone »', names(build('baisse', [[0, 0.0001, -0.0005, -0.0004], [-0.0005, 0.0003, -0.0006, 0.0002]]), { top: 1.0975, bottom: 1.096 }).some(n => n.endsWith('*')));
ok('Bougies calmes = aucune figure', names(build('baisse', [[0, 0.0001, -0.0001, 0.00005], [0.00005, 0.0001, -0.0001, 0]])).length === 0, names(build('baisse', [[0, 0.0001, -0.0001, 0.00005], [0.00005, 0.0001, -0.0001, 0]])).join(','));

if (failed) {
  console.log(`\n${failed} test(s) en échec`);
  process.exit(1);
}
console.log('\nTous les tests des bougies japonaises passent.');
