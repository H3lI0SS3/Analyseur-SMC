// Secours Yahoo Finance quand Twelve Data est épuisé : npx tsx server/fallback.test.ts
process.env.TWELVE_DATA_API_KEY = 'test';
// horloge figée un mercredi : le week-end, l'app garde volontairement son cache 30 min (marché fermé), ce qui fausserait le test
const FIXED_NOW = Date.UTC(2026, 10, 4, 9, 0);
Date.now = () => FIXED_NOW;
import { estimateBasis, getSeries } from './marketData';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};

// 200 bougies M15 / H1 d'un mardi-mercredi passé (marché ouvert)
const start = Date.UTC(2026, 9, 27, 0, 0);
const mk = (step: number, n: number, base: number) =>
  Array.from({ length: n }, (_, i) => ({ t: start + i * step, o: base + i * 0.1, h: base + i * 0.1 + 1, l: base + i * 0.1 - 1, c: base + i * 0.1 + 0.5 }));
const spotM15 = mk(900_000, 200, 3900);
const spotH1 = mk(3_600_000, 200, 3900);
const twelveJson = (c: typeof spotM15) => ({
  status: 'ok',
  values: c.map(k => ({ datetime: new Date(k.t).toISOString().slice(0, 19).replace('T', ' '), open: k.o, high: k.h, low: k.l, close: k.c })),
});
const yahooJson = (c: typeof spotM15, shift: number) => ({
  chart: { result: [{ timestamp: c.map(k => k.t / 1000), indicators: { quote: [{ open: c.map(k => k.o + shift), high: c.map(k => k.h + shift), low: c.map(k => k.l + shift), close: c.map(k => k.c + shift) }] } }] },
});

let quotaOut = false;
const calls: string[] = [];
(globalThis as any).fetch = async (url: string) => {
  calls.push(url);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('twelvedata')) {
    if (quotaOut) return new Response('{"code":429,"message":"You have run out of API credits for the day."}', { status: 429 });
    return json(twelveJson(url.includes('15min') ? spotM15 : spotH1));
  }
  if (url.includes('yahoo')) {
    const isGold = url.includes('GC%3DF') || url.includes('GC=F');
    const isM15 = url.includes('15m');
    return json(yahooJson(isM15 ? spotM15 : spotH1, isGold ? 20 : 0));
  }
  throw new Error('url inattendue ' + url);
};

(async () => {
  ok('Écart futures − spot estimé (médiane)', estimateBasis(spotM15.map(c => ({ ...c, c: c.c + 18.5 })), spotM15) === 18.5);
  ok('Pas assez de bougies communes : écart inconnu', estimateBasis(spotM15.slice(0, 5), spotM15.slice(0, 5)) === null);

  // 1. Twelve fonctionne : données spot
  const tw = await getSeries('XAU/USD', 'M15', 0);
  ok('Twelve Data disponible : source Twelve', tw.source === 'Twelve Data' && !tw.fallback);

  // 2. Quota épuisé : bascule sur Yahoo
  quotaOut = true;
  const eur = await getSeries('EUR/USD', 'H1', 0);
  ok('EUR/USD : secours Yahoo Finance utilisable', !!eur.fallback && !eur.futuresProxy && eur.source.includes('secours'), eur.source);
  const twelveAfter = calls.filter(u => u.includes('twelvedata')).length;
  const gold = await getSeries('XAU/USD', 'M15', 0);
  ok('Or : futures Yahoo recalées sur le spot (écart 20 $)', !!gold.fallback && !gold.futuresProxy && gold.basis === 20, gold.source);
  ok('Or recalé = prix spot connus', Math.abs(gold.candles[gold.candles.length - 1].c - spotM15[spotM15.length - 1].c) < 1e-9);
  ok('Après le 429, plus aucun appel à Twelve Data (quota bloqué jusqu’à minuit)', calls.filter(u => u.includes('twelvedata')).length === twelveAfter);
  const goldH1 = await getSeries('XAU/USD', 'H1', 0);
  ok('Or H1 : écart réutilisé depuis le M15', !goldH1.futuresProxy && goldH1.basis === 20, goldH1.source);

  if (failed) {
    console.log(`\n${failed} test(s) en échec`);
    process.exit(1);
  }
  console.log('\nTous les tests du secours Yahoo passent.');
})();
