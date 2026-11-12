// Entrée affinée M5 : règle figée du labo (CHoCH M5 dans la zone M15).
import assert from 'node:assert/strict';
import { refineM5, simulate } from './backtest';
import type { Setup } from './smc';

const T0 = Date.UTC(2026, 10, 4, 13, 0); // mercredi, marché ouvert
const M5 = 5 * 60_000;
const bar = (i: number, o: number, h: number, l: number, c: number) => ({ t: T0 + i * M5, o, h, l, c });

const sell: Setup = {
  direction: 'vendre', entryType: 'limite', entry: 100, sl: 105, tp1: 90, tp2: 85,
  tp1Label: 'x', tp2Label: 'y', rr1: 2, rr2: 3, zoneId: 'M15-FVG-1', zoneLabel: 'FVG',
};
const zone = { bottom: 100, top: 102 };

// 1. montée dans la zone, extrême 103, clôture sous le dernier creux M5 → vente limite au milieu de la jambe
{
  const m5 = [
    bar(0, 97, 98, 96.5, 97.8),
    bar(1, 97.8, 99, 97.5, 98.9),
    bar(2, 98.9, 100.6, 98.7, 100.4), // entre dans la zone
    bar(3, 100.4, 103, 100.2, 101.5), // extrême
    bar(4, 101.5, 101.6, 99.8, 100.1),
    bar(5, 100.1, 100.2, 98.2, 98.4), // clôture < 98,7 (dernier creux avant l'extrême) → CHoCH
    bar(6, 98.4, 98.5, 95, 95.2),
  ];
  const r = refineM5(sell, zone, T0, m5, 0.2);
  assert.equal(r.kind, 'entrée');
  if (r.kind === 'entrée') {
    assert.equal(r.setup.entryType, 'limite');
    assert.ok(Math.abs(r.setup.entry - 100.7) < 1e-9, `entrée ${r.setup.entry}`); // milieu de 103 → 98,4
    // stop = 103 + max(0,2 ; 10 % de 5) + spread = 103,7
    assert.ok(Math.abs(r.setup.sl - 103.7) < 1e-9, `stop ${r.setup.sl}`);
    assert.ok(Math.abs(r.setup.sl - r.setup.entry) < 5, 'stop plus serré que le stop M15');
    assert.equal(r.idx, 6);
    assert.equal(r.setup.tp1, 90);
  }
}

// 2. le stop M15 est touché avant le CHoCH M5 : pas de trade
{
  const m5 = [bar(0, 99, 100.5, 98.8, 100.2), bar(1, 100.2, 104.9, 100, 104), bar(2, 104, 104.5, 97, 97.5)];
  const r = refineM5(sell, zone, T0, m5, 0.2);
  assert.deepEqual(r, { kind: 'annulé', reason: 'stop M15 touché' });
}

// 3. TP1 atteint avant d'entrer dans la zone : plan annulé
{
  const m5 = [bar(0, 95, 96, 89.5, 90)];
  assert.deepEqual(refineM5(sell, zone, T0, m5, 0.2), { kind: 'annulé', reason: 'objectif atteint' });
}

// 4. le prix ne vient jamais dans la zone en 4 h : expiré
{
  const m5 = Array.from({ length: 60 }, (_, i) => bar(i, 97, 97.5, 96.5, 97));
  assert.deepEqual(refineM5(sell, zone, T0, m5, 0.2), { kind: 'annulé', reason: 'expiré' });
}

// 5. stop plancher : un extrême M5 collé à l'entrée ne donne pas un stop dans le bruit (≥ 25 % du risque M15)
{
  const m5 = [
    bar(0, 99.7, 99.8, 99.6, 99.7),
    bar(1, 99.7, 99.9, 99.65, 99.85),
    bar(2, 99.85, 99.95, 99.7, 99.9),
    bar(3, 99.9, 100.05, 99.85, 100), // extrême 100,05 dans la zone
    bar(4, 100, 100.02, 99.5, 99.55), // clôture < 99,6 → CHoCH
  ];
  const r = refineM5(sell, zone, T0, m5, 0.02);
  assert.equal(r.kind, 'entrée');
  if (r.kind === 'entrée') assert.ok(r.setup.sl - r.setup.entry >= 1.25 - 1e-9, `risque ${r.setup.sl - r.setup.entry}`);
}

// 6. achat symétrique
{
  const buy: Setup = { ...sell, direction: 'acheter', entry: 100, sl: 95, tp1: 110, tp2: 115 };
  const z = { bottom: 98, top: 100 };
  const m5 = [
    bar(0, 103, 103.5, 102, 102.2),
    bar(1, 102.2, 102.4, 101, 101.1),
    bar(2, 101.1, 101.3, 99.4, 99.6), // entre dans la zone
    bar(3, 99.6, 99.8, 97, 98.5), // extrême bas
    bar(4, 98.5, 100.5, 98.4, 100.3),
    bar(5, 100.3, 102.5, 100.2, 102.1), // clôture > 101,3 (dernier sommet avant l'extrême) → CHoCH
  ];
  const r = refineM5(buy, z, T0, m5, 0.2);
  assert.equal(r.kind, 'entrée');
  if (r.kind === 'entrée') {
    assert.ok(Math.abs(r.setup.entry - 99.55) < 1e-9, `entrée ${r.setup.entry}`); // milieu de 97 → 102,1
    assert.ok(Math.abs(r.setup.sl - 96.5) < 1e-9, `stop ${r.setup.sl}`); // 97 − max(0,2 ; 0,5)
  }
}

console.log('refine : 6 cas OK');

// ---------- Gestion de Mehdi : stop remonté sur TP1 à l'approche de TP2 (mesure du backtest) ----------
{
  const T0 = Date.UTC(2026, 10, 12, 13, 0);
  const st: any = { direction: 'vendre', entryType: 'limite', entry: 100, sl: 101, tp1: 98, tp2: 96, rr1: 2, rr2: 4 };
  const k = (i: number, o: number, h: number, l: number, c: number) => ({ t: T0 + i * 900_000, o, h, l, c });
  // remplissage à 100, descente jusqu'à 96,9 (plus de la moitié du chemin TP1 → TP2), puis remontée jusqu'au stop initial
  const path = [k(0, 99.5, 100.2, 99.4, 99.8), k(1, 99.8, 99.9, 96.9, 97.2), k(2, 97.2, 98.4, 97.1, 98.3), k(3, 98.3, 101.5, 98.2, 101.2)];
  const s50 = simulate(st, T0, path as any, 0, 0, 'suivi50');
  const s75 = simulate(st, T0, path as any, 0, 0, 'suivi75');
  const sp = simulate(st, T0, path as any, 0, 0, 'partiel');
  assert.equal(s50.pnl, 2, 'suivi50 : stop remonté sur TP1 (97 atteint), sortie à 98 = +2 R');
  assert.equal(s75.pnl, -1, 'suivi75 : 96,5 pas atteint, stop initial touché = −1 R');
  assert.equal(sp.pnl, 1, 'partiel : 50 % à TP1 (+1), reste au point mort (0) = +1 R');
  const direct = [k(0, 99.5, 100.2, 99.4, 99.8), k(1, 99.8, 99.9, 95.8, 96.1)];
  assert.equal(simulate(st, T0, direct as any, 0, 0, 'suivi75').pnl, 4, 'TP2 atteint : toute la position = +4 R');
  console.log('OK  gestion « stop remonté sur TP1 » : 4 scénarios');
}
