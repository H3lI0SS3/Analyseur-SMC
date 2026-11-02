// Garde « choc contraire » : npx tsx server/shock.test.ts
// Cas réel du 02/11/2026 : or +40 $ en 15 min à 13:30 UTC, l'app proposait une vente à 13:43 (stoppée à 14:30).
import { findShock, SHOCK_WINDOW } from './smc';
import type { Candle } from './marketData';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const t = (hhmm: string) => Date.parse(`2026-11-02T${hhmm}:00Z`);
const C = (hhmm: string, o: number, h: number, l: number, c: number): Candle => ({ t: t(hhmm), o, h, l, c });
const m15: Candle[] = [
  C('12:30', 3903.43, 3903.43, 3899.7, 3902.3),
  C('12:45', 3902.0, 3903.66, 3900.0, 3901.4),
  C('13:00', 3901.18, 3904.83, 3896.81, 3900.68),
  C('13:15', 3899.98, 3907.62, 3895.85, 3907.09),
  // bougie en cours à 13:43 (prix en direct ≈ 3935)
  C('13:30', 3905.75, 3940.0, 3905.01, 3935.0),
];
const atr = 6.75;
const sh = findShock(m15, t('13:43'), atr, false);
ok('Vente à 13:43 : choc haussier détecté (bougie en cours de +29 $)', !!sh && sh.t === t('13:30'), sh ? `${sh.c - sh.o}` : 'aucun');
ok('Achat à 13:43 : pas bloqué (le choc va dans son sens)', findShock(m15, t('13:43'), atr, true) === null);
ok('Avant le choc (13:20) : rien', findShock(m15.slice(0, 4), t('13:20'), atr, false) === null);
const later = [...m15.slice(0, 4), C('13:30', 3905.75, 3947.86, 3905.01, 3945.99), C('13:45', 3943.45, 3952.74, 3939.09, 3945.83)];
ok('Encore bloqué 1 h après', !!findShock(later, t('14:43'), atr, false));
ok('Plus bloqué après 2 h', findShock(later, t('13:30') + SHOCK_WINDOW + 15 * 60_000 + 1, atr, false) === null);
ok('Bougie normale (2 ATR) : pas un choc', findShock([C('13:30', 3900, 3913, 3900, 3912)], t('13:40'), atr, false) === null);
ok('ATR absent : pas de blocage fantôme', findShock(m15, t('13:43'), 0, false) === null);

if (failed) { console.log(`\n${failed} test(s) en échec`); process.exit(1); }
console.log('\nTous les tests du choc contraire passent.');
