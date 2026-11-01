// Tests de l'horloge New York : npx tsx server/time.test.ts
import { marketClosed, nyToUtc, tradingDayStart, tradingWeekStart, maTime } from './time';

let failed = 0;
const iso = (t: number) => new Date(t).toISOString().slice(0, 16);
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'OK ' : 'ÉCHEC'} ${label} : ${got}${ok ? '' : ` (attendu ${want})`}`);
}

// Kill zone New York (07h00 NY) : 11h00 UTC en été, 12h00 UTC en hiver
eq('KZ NY 1er juillet 2026', iso(nyToUtc(2026, 7, 1, 7)), '2026-07-01T11:00');
eq('KZ NY 15 janvier 2026', iso(nyToUtc(2026, 1, 15, 7)), '2026-01-15T12:00');
// Fermeture du vendredi 17h00 NY : 21h00 UTC le 30/10 (heure d'été US), 22h00 UTC le 6/11
eq('Ouvert ven. 30/10 20:59 UTC', marketClosed(Date.UTC(2026, 9, 30, 20, 59)), false);
eq('Fermé ven. 30/10 21:00 UTC', marketClosed(Date.UTC(2026, 9, 30, 21, 0)), true);
eq('Ouvert ven. 6/11 21:30 UTC', marketClosed(Date.UTC(2026, 10, 6, 21, 30)), false);
eq('Fermé ven. 6/11 22:00 UTC', marketClosed(Date.UTC(2026, 10, 6, 22, 0)), true);
eq('Fermé sam. 31/10', marketClosed(Date.UTC(2026, 9, 31, 12)), true);
eq('Réouverture dim. 1/11 22:00 UTC', marketClosed(Date.UTC(2026, 10, 1, 22, 0)), false);
// Jour de trading : commence à 17h00 NY
eq('Jour de trading de mer. 4/11 10:00 UTC', iso(tradingDayStart(Date.UTC(2026, 10, 4, 10))), '2026-11-03T22:00');
eq('Jour de trading de mer. 15/7 21:30 UTC', iso(tradingDayStart(Date.UTC(2026, 6, 15, 21, 30))), '2026-07-15T21:00');
// Changement d'heure US (dimanche 1/11/2026) : la semaine démarre dim. 17h00 NY = 22h00 UTC
eq('Semaine de mar. 3/11', iso(tradingWeekStart(Date.UTC(2026, 10, 3, 12))), '2026-11-01T22:00');
eq('Semaine de jeu. 29/10', iso(tradingWeekStart(Date.UTC(2026, 9, 29, 12))), '2026-10-25T21:00');
// Heure du Maroc
eq('Heure Maroc de 12:30 UTC le 6/11', maTime(Date.UTC(2026, 10, 6, 12, 30)), '12:30');

if (failed) {
  console.log(`\n${failed} test(s) en échec`);
  process.exit(1);
}
console.log('\nTous les tests horaires passent.');

// Annonces : horaire « à confirmer » repéré (minute non ronde), vrai horaire accepté
import { isTentativeTime } from './news';
{
  const real = Date.UTC(2026, 10, 3, 13, 30);
  const odd = Date.UTC(2026, 10, 3, 15, 16);
  console.log(`${!isTentativeTime(real) && isTentativeTime(odd) ? 'OK ' : 'ÉCHEC'} Annonce à 15:16 = horaire non confirmé, 13:30 = vrai horaire`);
  if (isTentativeTime(real) || !isTentativeTime(odd)) process.exit(1);
}
