// Exécution en direct : étapes M5 (même règle que le backtest), kill zones, actifs en pause.
import assert from 'node:assert/strict';
import { killzoneStart, m5Stage, m5WatchStart, PAUSED_PAIRS, M5_EXECUTION_PAIRS, closedM5 } from './execution';
import type { Setup } from './smc';

const T0 = Date.UTC(2026, 10, 4, 13, 0); // mercredi 08h00 New York (kill zone NY)
const M5 = 5 * 60_000;
const bar = (i: number, o: number, h: number, l: number, c: number) => ({ t: T0 + i * M5, o, h, l, c });
const sell: Setup = { direction: 'vendre', entryType: 'limite', entry: 100, sl: 105, tp1: 90, tp2: 85, tp1Label: 'x', tp2Label: 'y', rr1: 2, rr2: 3, zoneId: 'M15-FVG-1', zoneLabel: 'FVG' };
const zone = { bottom: 100, top: 102 };
const opts = { spread: 0.2, commUnit: 0.07, decimals: 2 };
const ok = (name: string, cond: boolean, info = '') => { assert.ok(cond, `${name} ${info}`); console.log(`OK  ${name}${info ? ' — ' + info : ''}`); };

const climb = [
  bar(0, 97, 98, 96.5, 97.8),
  bar(1, 97.8, 99, 97.5, 98.9),
  bar(2, 98.9, 100.6, 98.7, 100.4), // entre dans la zone
  bar(3, 100.4, 103, 100.2, 101.5), // extrême
  bar(4, 101.5, 101.6, 99.8, 100.1),
];

// 1. le prix n'est pas encore revenu dans la zone
{
  const st = m5Stage(sell, zone, T0, climb.slice(0, 2), T0 + 2 * M5, opts);
  ok('Avant la zone : on attend, aucun ordre', st.stage === 'attente_zone' && st.order === null, st.stage);
}
// 2. dans la zone, pas encore de CHoCH M5 : on donne le niveau à surveiller
{
  const st = m5Stage(sell, zone, T0, climb, T0 + 5 * M5, opts);
  ok('Dans la zone : attente du CHoCH M5 avec son niveau', st.stage === 'attente_choch' && st.chochLevel === 98.7, `${st.stage} ${st.chochLevel}`);
}
// 3. CHoCH M5 : ordre limite au milieu de la jambe, stop M5, objectifs M15
{
  const m5 = [...climb, bar(5, 100.1, 100.2, 98.2, 98.4)];
  const st = m5Stage(sell, zone, T0, m5, T0 + 6 * M5, opts);
  ok('CHoCH M5 : ordre Sell Limit', st.stage === 'ordre' && !!st.order, st.stage);
  ok('Entrée à mi-jambe (103 → 98,4)', st.order!.entry === 100.7, String(st.order!.entry));
  ok('Stop M5 derrière l’extrême + marge + spread', st.order!.sl === 103.7, String(st.order!.sl));
  ok('Objectifs M15 inchangés', st.order!.tp1 === 90 && st.order!.tp2 === 85);
  ok('R:R net recalculé ≥ 2,5', (st.order!.rr2 ?? 0) >= 2.5, String(st.order!.rr2));
  ok('Ordre valable au plus 4 h après le CHoCH', st.order!.validUntil <= T0 + 6 * M5 + 4 * 3_600_000);
}
// 4. l'entrée a déjà été servie depuis le CHoCH : trade manqué, on ne court pas après
{
  const m5 = [...climb, bar(5, 100.1, 100.2, 98.2, 98.4), bar(6, 98.4, 100.9, 98.3, 100.5)];
  const st = m5Stage(sell, zone, T0, m5, T0 + 7 * M5, opts);
  ok('Entrée déjà touchée : trade manqué', st.stage === 'manqué', st.stage);
}
// 5. stop M15 touché avant le CHoCH : annulé
{
  const m5 = [bar(0, 99, 100.5, 98.8, 100.2), bar(1, 100.2, 104.9, 100, 104)];
  const st = m5Stage(sell, zone, T0, m5, T0 + 2 * M5, opts);
  ok('Stop M15 touché : setup annulé', st.stage === 'annulé', st.message);
}
// 6. annonce : l'ordre expire 30 min avant
{
  const m5 = [...climb, bar(5, 100.1, 100.2, 98.2, 98.4)];
  const cut = T0 + 7 * M5;
  const st = m5Stage(sell, zone, T0, m5, T0 + 6 * M5, { ...opts, newsCut: cut });
  ok('Expiration avant l’annonce', st.order?.validUntil === cut);
}
// 7. kill zones et début de surveillance
{
  ok('Kill zone NY : début 07h00 NY', killzoneStart(T0) === Date.UTC(2026, 10, 4, 12, 0));
  ok('Hors kill zone : null', killzoneStart(Date.UTC(2026, 10, 4, 17, 0)) === null);
  const mssAsie = Date.UTC(2026, 10, 4, 5, 0);
  ok('CHoCH avant la kill zone : surveillance dès le début de la kill zone', m5WatchStart(mssAsie, T0) === Date.UTC(2026, 10, 4, 12, 0));
  ok('CHoCH pendant la kill zone : surveillance après la clôture de sa bougie', m5WatchStart(T0, T0 + 3_600_000) === T0 + 15 * 60_000);
}
// 8. bougie M5 en cours exclue
{
  const m5 = [bar(0, 1, 1, 1, 1), bar(1, 1, 1, 1, 1)];
  ok('Bougie M5 en cours exclue', closedM5(m5, T0 + M5 + 60_000).length === 1);
}
// 9. décisions du 06/11
ok('EUR/USD en pause', !!PAUSED_PAIRS['EUR/USD'] && !PAUSED_PAIRS['XAU/USD']);
ok('Or exécuté en M5', M5_EXECUTION_PAIRS.has('XAU/USD') && !M5_EXECUTION_PAIRS.has('EUR/USD'));

console.log('\nTous les tests d’exécution passent.');
