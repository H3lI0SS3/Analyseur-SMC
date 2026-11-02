// Tests du suivi automatique : npx tsx src/lib/tracker.test.mts
import { evaluate, strategyStats, MIN_TRADES } from './tracker';
import type { JournalEntry } from '../types';
import { etoroSize } from './utils';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const M = 15 * 60_000;
const t0 = Date.UTC(2026, 10, 3, 8, 0); // mardi 08:00 UTC
const base: JournalEntry = {
  id: 'x', createdAt: t0 + 5 * 60_000, pair: 'EUR/USD', direction: 'acheter', entry: 1.1, sl: 1.099, tp: 1.104, rrPlanned: 4, riskPct: 1, lots: 1,
  result: 'attente', rMultiple: null, note: '', auto: true, entryType: 'limite', tp1: 1.102, tp2: 1.104, validUntil: t0 + 4 * 3_600_000,
  spread: 0, commissionPerLot: 0, contract: 100_000, filledAt: null, tp1At: null, exitAt: null,
};
const c = (i: number, o: number, h: number, l: number, cl: number) => ({ t: t0 + i * M, o, h, l, c: cl });
const late = t0 + 20 * M;

// la bougie de prise du trade (i=0) ne compte pas, même si elle touche l'entrée
{
  const r = evaluate(base, [c(0, 1.1005, 1.101, 1.0995, 1.1), c(1, 1.1005, 1.1008, 1.1003, 1.1006)], t0 + 2 * M);
  ok('Bougie de prise du trade ignorée : ordre toujours en attente', r === null, JSON.stringify(r));
}
// exécution puis TP1 puis retour au point d'entrée : +1 R sur 50 %
{
  const r = evaluate(base, [c(1, 1.1005, 1.1006, 1.0999, 1.1002), c(2, 1.1002, 1.1021, 1.1001, 1.102), c(3, 1.102, 1.1021, 1.0999, 1.1)], late);
  ok('TP1 puis stop au point d’entrée = gagné +1 R', r?.result === 'gagne' && r?.rMultiple === 1, JSON.stringify(r));
}
// exécution puis TP2 : 0,5 x 2 R + 0,5 x 4 R = +3 R
{
  const r = evaluate(base, [c(1, 1.1005, 1.1006, 1.0999, 1.1002), c(2, 1.1002, 1.1021, 1.1001, 1.102), c(3, 1.102, 1.1041, 1.1015, 1.104)], late);
  ok('TP1 puis TP2 = +3 R', r?.result === 'gagne' && r?.rMultiple === 3, JSON.stringify(r));
}
// stop et objectif dans la même bougie : on compte le stop
{
  const r = evaluate(base, [c(1, 1.1005, 1.1006, 1.0999, 1.1002), c(2, 1.1002, 1.1025, 1.0985, 1.1)], late);
  ok('Stop et TP dans la même bougie = perdu -1 R', r?.result === 'perdu' && r?.rMultiple === -1, JSON.stringify(r));
}
// TP1 atteint avant l'exécution : ordre annulé
{
  const r = evaluate(base, [c(1, 1.1005, 1.1022, 1.1003, 1.102)], late);
  ok('TP1 atteint avant l’exécution = ordre annulé', r?.result === 'expire', JSON.stringify(r));
}
// jamais exécuté avant la fin de validité
{
  const cs = Array.from({ length: 18 }, (_, i) => c(i + 1, 1.1008, 1.101, 1.1005, 1.1008));
  const r = evaluate(base, cs, t0 + 19 * M);
  ok('Ordre limite non exécuté après 4 h = annulé', r?.result === 'expire', JSON.stringify(r));
}
// exécuté mais rien d'autre : position ouverte
{
  const r = evaluate(base, [c(1, 1.1005, 1.1006, 1.0999, 1.1002), c(2, 1.1002, 1.101, 1.0995, 1.1005)], late);
  ok('Exécuté sans stop ni TP = en cours', r?.result === 'en_cours' && r?.filledAt === t0 + M, JSON.stringify(r));
}
// vente au marché, commission incluse : stop = -1 R un peu au-delà
{
  const sell: JournalEntry = { ...base, direction: 'vendre', entryType: 'marché', entry: 1.1, sl: 1.101, tp1: 1.098, tp2: null, commissionPerLot: 7 };
  const r = evaluate(sell, [c(1, 1.1, 1.1011, 1.0995, 1.1008)], late);
  ok('Vente au marché stoppée = perdu, -1 R (commission comprise)', r?.result === 'perdu' && r?.rMultiple === -1, JSON.stringify(r));
}
// viabilité : rien sous 30 trades, puis calculée
{
  const mk = (r: number, i: number): JournalEntry => ({ ...base, id: 'k' + i, result: r > 0 ? 'gagne' : 'perdu', rMultiple: r, auto: true });
  ok('Viabilité masquée sous 30 trades', strategyStats(Array.from({ length: 29 }, (_, i) => mk(i % 3 ? -1 : 3, i))).viability === null);
  const good = strategyStats(Array.from({ length: MIN_TRADES }, (_, i) => mk(i % 2 ? -1 : 3, i)));
  ok('Stratégie gagnante sur 30 trades = viabilité élevée', (good.viability ?? 0) >= 95, String(good.viability));
  const bad = strategyStats(Array.from({ length: MIN_TRADES }, (_, i) => mk(i % 5 ? -1 : 1, i)));
  ok('Stratégie perdante = viabilité faible', (bad.viability ?? 100) < 10, String(bad.viability));
  const legacy = strategyStats([{ ...base, auto: undefined, result: 'gagne', rMultiple: 3 }]);
  ok('Anciens trades du journal (avant le suivi) non comptés', legacy.closed === 0);
  const manual = strategyStats([{ ...base, auto: false, result: 'gagne', rMultiple: 4 }]);
  ok('Trade saisi ou corrigé à la main non compté', manual.closed === 0);
  const ver = strategyStats([{ ...base, auto: true, result: 'gagne', rMultiple: 2, rulesVersion: '3.2' }], undefined, '3.3');
  ok('Trade d’une autre version des règles non compté', ver.closed === 0);
  ok('Fourchette à 95 % fournie à partir de 30 trades', good.ciLow !== null && good.ciLow > 0);
}
// gap au-delà du stop : sortie à l'ouverture, perte supérieure à 1 R
{
  const r = evaluate({ ...base, entryType: 'marché', result: 'en_cours' }, [c(1, 1.0985, 1.0987, 1.098, 1.0982)], late);
  ok('Gap sous le stop = perte au prix d’ouverture (-1,5 R)', r?.result === 'perdu' && r?.rMultiple === -1.5, JSON.stringify(r));
}
// app fermée plus de 7 jours : suivi interrompu
{
  const old = { ...base, createdAt: t0 - 9 * 86_400_000 };
  const r = evaluate(old, [c(1, 1.1005, 1.1006, 1.1003, 1.1004)], late);
  ok('Historique manquant = suivi interrompu, saisie manuelle demandée', r?.auto === false, JSON.stringify(r));
}

// Taille eToro : 0,10 lot EUR/USD à 1,10 avec levier 1:30 = 10 000 unités, 11 000 $ exposés, ≈ 367 $ à investir
{
  const z = etoroSize('EUR/USD', 0.1, 1.1, 30);
  ok('Conversion eToro EUR/USD', z.units === 10000 && Math.abs(z.exposure - 11000) < 1e-6 && Math.abs(z.amount - 366.67) < 0.01, JSON.stringify(z));
  const g = etoroSize('XAU/USD', 0.05, 4000, 20);
  ok('Conversion eToro or (0,05 lot = 5 onces, 20 000 $ exposés, 1 000 $ à investir)', g.units === 5 && Math.abs(g.amount - 1000) < 1e-6, JSON.stringify(g));
}

if (failed) {
  console.log(`\n${failed} test(s) en échec`);
  process.exit(1);
}
console.log('\nTous les tests du suivi passent.');
