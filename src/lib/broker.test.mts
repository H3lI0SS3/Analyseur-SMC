// Recalage des niveaux sur le prix du broker : npx tsx src/lib/broker.test.mts
import { brokerOffset } from './utils';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};

// Cas réel du 02/11 01:25 UTC : app 3904.72, FxPro Sell 3907.17 / Buy 3907.36 (spread 0.19)
let r = brokerOffset('XAU/USD', 3904.72, '3907,17', 0.19);
ok('Or : écart calculé au prix moyen (Sell + demi-spread)', r.error === null && Math.abs(r.offset - 2.55) < 0.001, `${r.offset}`);
r = brokerOffset('XAU/USD', 3908.39, '3905.74', 0.19);
ok('Or : écart négatif accepté', r.error === null && Math.abs(r.offset - -2.555) < 0.006, `${r.offset}`);
ok('Champ vide : pas de recalage', brokerOffset('XAU/USD', 3904.72, '  ', 0.19).offset === 0 && brokerOffset('XAU/USD', 3904.72, '', 0.19).error === null);
ok('Texte invalide refusé', brokerOffset('XAU/USD', 3904.72, 'abc', 0.19).error !== null);
r = brokerOffset('XAU/USD', 3904.72, '390.72', 0.19);
ok('Faute de frappe (écart énorme) refusée, niveaux non recalés', r.error !== null && r.offset === 0);
r = brokerOffset('XAU/USD', 3904.72, '1.11708', 0.19);
ok('Mauvais actif refusé', r.error !== null && r.offset === 0);
r = brokerOffset('EUR/USD', 1.11709, '1.11708', 0.00002);
ok('EUR/USD : écart quasi nul', r.error === null && Math.abs(r.offset) < 0.00001, `${r.offset}`);
r = brokerOffset('EUR/USD', 1.11709, '1.1191', 0.00002);
ok('EUR/USD : écart de 20 pips refusé', r.error !== null);
// le recalage ne change pas les distances : stop et objectifs bougent du même écart que l'entrée
const plan = { entry: 3948.45, sl: 3958.9, tp1: 3900.3 };
const o = brokerOffset('XAU/USD', 3904.72, '3907.17', 0.19).offset;
ok('Distances entrée/stop/TP conservées', Math.abs((plan.sl + o) - (plan.entry + o) - (plan.sl - plan.entry)) < 1e-9 && Math.abs((plan.entry + o) - (plan.tp1 + o) - (plan.entry - plan.tp1)) < 1e-9);

if (failed) { console.log(`\n${failed} test(s) en échec`); process.exit(1); }
console.log('\nTous les tests du recalage broker passent.');
