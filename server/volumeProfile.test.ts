// Volume profile en ticks. npx tsx server/volumeProfile.test.ts
import { sessionProfiles, volumeProfile } from './volumeProfile';
import { toCandle } from './ctrader';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const T = Date.UTC(2026, 10, 4, 14, 0);
const C = (i: number, l: number, h: number, v?: number) => ({ t: T - (40 - i) * 900_000, o: l, h, l, c: h, ...(v !== undefined ? { v } : {}) });

// 1. Sans volume (Twelve Data / Yahoo) : aucun profil
ok('Sans volume : pas de profil', volumeProfile([C(0, 4000, 4002), C(1, 4001, 4003)], 0.5) === null && sessionProfiles([C(0, 4000, 4002)], 4001, 0.5, T) === null);

// 2. Volume concentré autour de 4050 : POC à 4050, zone de valeur resserrée autour
const bars = [C(0, 4040, 4060, 200), ...Array.from({ length: 10 }, (_, i) => C(i + 1, 4049.6, 4050.4, 300)), C(11, 4070, 4072, 50)];
const p = volumeProfile(bars, 0.5)!;
ok('POC sur la zone la plus échangée (≈ 4050)', Math.abs(p.poc - 4050) <= 0.5, String(p.poc));
ok('Zone de valeur autour du POC (VAL ≤ POC ≤ VAH)', p.val <= p.poc && p.poc <= p.vah, `${p.val} – ${p.vah}`);
ok('Zone de valeur bien plus étroite que le range (4040–4072)', p.vah - p.val < 10, `${p.vah - p.val}`);
ok('Volume total conservé', p.totalTicks === 200 + 3000 + 50, String(p.totalTicks));
const share = (lo: number, hi: number) => bars.reduce((s, c) => s + (c.v ?? 0) * Math.max(0, Math.min(c.h, hi) - Math.max(c.l, lo)) / Math.max(c.h - c.l, 1e-9), 0) / p.totalTicks;
ok('La zone de valeur contient au moins 70 % du volume', share(p.val, p.vah) >= 0.69, share(p.val, p.vah).toFixed(2));

// 3. Journée en cours / veille et position du prix (journée de trading : 17h00 New York = 22h00 UTC en hiver)
const now = Date.UTC(2026, 10, 4, 15, 0); // mercredi 10h00 New York
const yest = Array.from({ length: 20 }, (_, i) => ({ t: Date.UTC(2026, 10, 3, 10, 0) + i * 900_000, o: 4000, h: 4004, l: 3996, c: 4000, v: 100 }));
const todayBars = Array.from({ length: 10 }, (_, i) => ({ t: Date.UTC(2026, 10, 4, 12, 0) + i * 900_000, o: 4020, h: 4022, l: 4018, c: 4020, v: 100 }));
const sp = sessionProfiles([...yest, ...todayBars], 4021, 0.5, now)!;
ok('Profil de la veille (journée 17h–17h New York)', !!sp.yesterday && Math.abs(sp.yesterday.poc - 4000) <= 2, String(sp.yesterday?.poc));
ok('Profil du jour', !!sp.today && Math.abs(sp.today.poc - 4020) <= 2, String(sp.today?.poc));
ok('Prix au-dessus de la zone de valeur de la veille', sp.priceVsYesterday === 'au-dessus');

// lundi : la veille est la séance du vendredi (le week-end n'a pas de volume)
const mon = Date.UTC(2026, 10, 9, 16, 0); // lundi 11h00 New York
const fri = Array.from({ length: 20 }, (_, i) => ({ t: Date.UTC(2026, 10, 6, 12, 0) + i * 900_000, o: 4050, h: 4052, l: 4048, c: 4050, v: 100 }));
const monBars = Array.from({ length: 10 }, (_, i) => ({ t: Date.UTC(2026, 10, 9, 10, 0) + i * 900_000, o: 4100, h: 4102, l: 4098, c: 4100, v: 100 }));
const spm = sessionProfiles([...fri, ...monBars], 4100, 0.5, mon)!;
ok('Lundi : profil de la veille = vendredi', !!spm.yesterday && Math.abs(spm.yesterday.poc - 4050) <= 2 && spm.priceVsYesterday === 'au-dessus', String(spm.yesterday?.poc));

// 4. Volume lu depuis les barres cTrader
const k = toCandle({ volume: 1234, low: 400_000_000, deltaHigh: 100_000, utcTimestampInMinutes: T / 60_000 });
ok('Volume en ticks conservé depuis cTrader', k?.v === 1234);
ok('Volume absent : champ non créé', toCandle({ low: 400_000_000, utcTimestampInMinutes: T / 60_000 })?.v === undefined);

if (failed) { console.log(`\n${failed} test(s) en échec`); process.exit(1); }
console.log('\nTous les tests du volume profile passent.');
