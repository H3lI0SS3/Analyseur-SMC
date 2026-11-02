// Recalage des niveaux sur le prix du broker : npx tsx src/lib/broker.test.mts
import { brokerOffset, lotSize, realRiskUsd, minLotRiskUsd } from './utils';

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

// ---- Compte cent (50 $) ----
// Or, stop 13,36 $ (signal du 02/11) : compte standard impossible, compte cent OK
ok('Compte standard 50 $ : or impossible (0 lot)', lotSize('XAU/USD', 50, 1, 3909, 3922.36, 0) === 0);
ok('Lot minimum standard = 13,36 $ de perte (27 % de 50 $)', Math.abs(minLotRiskUsd('XAU/USD', 3909, 3922.36) - 13.36) < 0.01);
let l = lotSize('XAU/USD', 50, 1, 3909, 3922.36, 0, 100);
ok('Compte cent 50 $, 1 % : 0,03 lot cent', l === 0.03, `${l}`);
ok('Risque réel ≤ 1 % (0,40 $)', Math.abs(realRiskUsd('XAU/USD', l!, 3909, 3922.36, 0, 100) - 0.4008) < 0.001);
l = lotSize('XAU/USD', 50, 0.5, 3909, 3922.36, 0, 100);
ok('Compte cent, classe B (0,5 %) : 0,01 lot cent', l === 0.01, `${l}`);
l = lotSize('EUR/USD', 50, 1, 1.1188, 1.1208, 0, 100);
ok('Compte cent EUR/USD stop 20 pips : 0,25 lot cent (0,50 $)', l === 0.25, `${l}`);
ok('Jamais plus que le risque demandé', [[3909, 3922.36], [3909, 3910.1], [3909, 3950]].every(([e, s2]) => { const x = lotSize('XAU/USD', 50, 1, e, s2, 0, 100)!; return realRiskUsd('XAU/USD', x, e, s2, 0, 100) <= 0.5 + 1e-9; }));
ok('Compte standard inchangé (10 000 $, 1 %, stop 13,36 $ → 0,07 lot)', lotSize('XAU/USD', 10000, 1, 3909, 3922.36, 7) === 0.07);

if (failed) { console.log(`\n${failed} test(s) en échec`); process.exit(1); }
console.log('\nTous les tests du recalage broker passent.');
