// Règles du desk : npx tsx src/lib/desk.test.mts
import { deskCheck, splitOrders } from './desk';
import { inRollover, nextRollover } from '../../server/smc';
import type { JournalEntry } from '../types';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const now = Date.now();
const j = (o: Partial<JournalEntry>): JournalEntry => ({
  id: Math.random().toString(), createdAt: now - 3_600_000, pair: 'XAU/USD', direction: 'vendre', entry: 1, sl: 2, tp: 0.5, rrPlanned: 2.5, riskPct: 1, lots: 0.01,
  result: 'perdu', rMultiple: -1, note: '', auto: true, exitAt: now - 1_800_000, ...o,
} as JournalEntry);

ok('Journal vide : trade autorisé', deskCheck([], 'XAU/USD', 'vendre', now) === null);
ok('Deux trades déjà pris aujourd’hui : refusé', !!deskCheck([j({ result: 'gagne', rMultiple: 2 }), j({ pair: 'EUR/USD', result: 'gagne', rMultiple: 1 })], 'XAU/USD', 'vendre', now)?.includes('maximum'));
ok('Trade non pris ou expiré : ne compte pas', deskCheck([j({ result: 'non_pris' }), j({ result: 'expire' })], 'XAU/USD', 'vendre', now) === null);
ok('Trade déjà ouvert sur l’actif : refusé', !!deskCheck([j({ result: 'en_cours', rMultiple: null })], 'XAU/USD', 'acheter', now)?.includes('Un seul trade'));
ok('Achat or + achat EUR/USD (même exposition dollar) : refusé', !!deskCheck([j({ pair: 'EUR/USD', direction: 'acheter', result: 'attente', rMultiple: null })], 'XAU/USD', 'acheter', now)?.includes('dollar'));
ok('Achat or + vente EUR/USD (expositions opposées) : autorisé', deskCheck([j({ pair: 'EUR/USD', direction: 'vendre', result: 'attente', rMultiple: null })], 'XAU/USD', 'acheter', now) === null);
ok('Une perte aujourd’hui : autorisé', deskCheck([j({})], 'EUR/USD', 'vendre', now) === null);
ok('Split 0,07 lot → 0,03 + 0,04', JSON.stringify(splitOrders(0.07)) === '{"lot1":0.03,"lot2":0.04}');
ok('Split 0,01 lot : impossible', splitOrders(0.01) === null);
ok('Rollover : 17h00 NY bloqué, 15h00 NY libre', inRollover(Date.UTC(2026, 10, 3, 22, 0)) && !inRollover(Date.UTC(2026, 10, 3, 20, 0)));
ok('Prochain rollover = 16h45 NY (21h45 UTC en novembre)', nextRollover(Date.UTC(2026, 10, 3, 12, 0)) === Date.UTC(2026, 10, 3, 21, 45));
ok('Après le rollover : celui du lendemain', nextRollover(Date.UTC(2026, 10, 3, 23, 0)) === Date.UTC(2026, 10, 4, 21, 45));

if (failed) { console.log(`\n${failed} test(s) en échec`); process.exit(1); }
console.log('\nTous les tests du desk passent.');
