// Tests du moteur sur données synthétiques : npx tsx server/engine.test.ts
import { aggregateTrading, TF_MS, type Candle, type Timeframe } from './marketData';
import { analyze, findFVGs, scanStructure, findSwings, amdPhase, type EngineResult } from './smc';
import { reconcile } from './analysis';
import { nyParts, nyToUtc } from './time';
import type { AiReview } from './ai';

let failed = 0;
function ok(label: string, cond: boolean, info = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
}

// ---------- Générateur de bougies H1/M15 (marché ouvert dim. 17h -> ven. 17h NY) ----------
function genM15(seed: number, endUtc: number, drift: number, vol: number, base: number): Candle[] {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out: Candle[] = [];
  let p = base;
  const start = endUtc - 400 * 86_400_000;
  for (let t = start; t < endUtc; t += 900_000) {
    const ny = nyParts(t);
    const closedMkt = (ny.dow === 5 && ny.h >= 17) || ny.dow === 6 || (ny.dow === 0 && ny.h < 17);
    if (closedMkt) continue;
    const o = p;
    const c = o + (rnd() - 0.5 + drift) * vol * 4;
    out.push({ t, o, h: Math.max(o, c) + rnd() * vol * 2, l: Math.min(o, c) - rnd() * vol * 2, c });
    p = c;
  }
  return out;
}
function toH1(m15: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const c of m15) {
    const k = Math.floor(c.t / 3_600_000) * 3_600_000;
    const last = out[out.length - 1];
    if (!last || last.t !== k) out.push({ ...c, t: k });
    else {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
    }
  }
  return out;
}
function seriesAt(m15: Candle[]): Record<Timeframe, Candle[]> {
  const h1 = toH1(m15);
  return { M15: m15.slice(-700), H1: h1.slice(-3000), H4: aggregateTrading(h1, 'H4'), D1: aggregateTrading(h1, 'D1') };
}

// ---------- 1. H4 et D1 calés sur 17h00 New York ----------
{
  const m15 = genM15(7, Date.UTC(2026, 9, 28, 15), 0, 0.0002, 1.16);
  const h1 = toH1(m15);
  const h4 = aggregateTrading(h1, 'H4');
  const hours = new Set(h4.slice(-60).map(c => nyParts(c.t).h));
  ok('H4 ouvrent à 17h, 21h, 01h, 05h, 09h ou 13h New York', [...hours].every(h => [17, 21, 1, 5, 9, 13].includes(h)), [...hours].sort((a, b) => a - b).join(','));
  const d1 = aggregateTrading(h1, 'D1');
  ok('D1 ouvrent à 17h00 New York', d1.slice(-40).every(c => nyParts(c.t).h === 17));
  ok('Pas de bougie D1 le samedi', d1.every(c => nyParts(c.t).dow !== 6));
}

// ---------- 2. Un gap de week-end n'est pas un FVG ----------
{
  const P = TF_MS.H1;
  const fri = Date.UTC(2026, 9, 30, 19);
  const c: Candle[] = [
    { t: fri - P, o: 1.0, h: 1.01, l: 0.99, c: 1.0 },
    { t: fri, o: 1.0, h: 1.01, l: 0.995, c: 1.005 },
    { t: fri + 49 * P, o: 1.05, h: 1.06, l: 1.04, c: 1.055 }, // dimanche soir, ouverture en gap
    { t: fri + 50 * P, o: 1.055, h: 1.06, l: 1.05, c: 1.058 },
  ];
  ok('Gap du week-end ignoré', findFVGs(c, 'H1', 0.01).length === 0);
}

// ---------- 3. La bougie en cours ne crée pas de cassure ----------
{
  const P = TF_MS.H1;
  const base = Date.UTC(2026, 10, 3, 0);
  const c: Candle[] = [];
  const closes = [1, 1.02, 1.04, 1.03, 1.01, 1.0, 1.01, 1.02, 1.015, 1.01, 1.005, 1.0];
  closes.forEach((v, i) => c.push({ t: base + i * P, o: v, h: v + 0.003, l: v - 0.003, c: v }));
  const swings = findSwings(c, 2);
  const before = scanStructure(c, swings, 2).events.length;
  const withLive = [...c, { t: base + 12 * P, o: 1.0, h: 1.06, l: 1.0, c: 1.05 }];
  const now = base + 12 * P + 20 * 60_000; // bougie ouverte depuis 20 min
  const closedOnly = withLive.filter(x => x.t + P <= now);
  ok('Bougie non clôturée exclue du calcul', scanStructure(closedOnly, findSwings(closedOnly, 2), 2).events.length === before);
}

// ---------- 4. Moteur complet : coûts, news, marché fermé ----------
const tuesday = Date.UTC(2026, 10, 3, 13, 10); // mar. 3/11, kill zone NY (08h10 NY)
const m15 = genM15(42, tuesday, -0.02, 0.0002, 1.16);
const series = seriesAt(m15);
const costs = { spread: 0.0001, commissionPerLot: 7, contract: 100_000 };
const base = analyze(series, 5, { now: tuesday, spread: 0, commissionPerLot: 0, contract: 100_000, news: { available: true, events: [] }, newsCurrencies: ['USD', 'EUR'] });
const withCosts = analyze(series, 5, { now: tuesday, ...costs, news: { available: true, events: [] }, newsCurrencies: ['USD', 'EUR'] });
ok('Session détectée en heure de New York', base.session.name === 'Kill zone de New York', base.session.name);
// Coûts : on cherche un jeu de données où le même plan existe avec et sans coûts
{
  let compared = false;
  for (let seed = 1; seed <= 40 && !compared; seed++) {
    const sr = seriesAt(genM15(seed, tuesday, seed % 2 ? 0.02 : -0.02, 0.0002, 1.16));
    const opt = { now: tuesday, contract: 100_000, news: { available: true, events: [] }, newsCurrencies: ['USD'] };
    const a = analyze(sr, 5, { ...opt, spread: 0, commissionPerLot: 0 });
    const b = analyze(sr, 5, { ...opt, spread: 0.0001, commissionPerLot: 7 });
    const pa = [a.setup, ...a.alternatives].filter(Boolean);
    const pb = [b.setup, ...b.alternatives].filter(Boolean);
    const pair = pa.map(x => [x!, pb.find(y => y!.zoneId === x!.zoneId)] as const).find(([, y]) => !!y);
    if (pair) {
      const [x, y] = pair;
      compared = true;
      ok('R:R net (avec coûts) inférieur au R:R brut', y!.rr1 < x.rr1, `${x.rr1} → ${y!.rr1} (graine ${seed})`);
      ok('Objectif rapproché de l’entrée du spread', Math.abs(y!.tp1 - y!.entry) <= Math.abs(x.tp1 - x.entry) + 1e-9);
      if (y!.direction === 'vendre') ok('Stop d’une vente décalé du spread', y!.sl >= x.sl - 1e-9);
    }
  }
  ok('Un plan comparable a été trouvé pour tester les coûts', compared);
}
const allSetups = [withCosts.setup, ...withCosts.alternatives].filter(Boolean);
ok('Chaque plan a un stop d’au moins 4 spreads', allSetups.every(s => Math.abs(s!.entry - s!.sl) >= 4 * costs.spread - 1e-9));
ok('Niveaux dans le bon ordre', allSetups.every(s => (s!.direction === 'acheter' ? s!.sl < s!.entry && s!.entry < s!.tp1 : s!.sl > s!.entry && s!.entry > s!.tp1)));

const newsNow = analyze(series, 5, { now: tuesday, ...costs, news: { available: true, events: [{ t: tuesday + 10 * 60_000, currency: 'USD', title: 'CPI' }] }, newsCurrencies: ['USD'] });
ok('Annonce dans 10 min : condition news en échec', newsNow.checklist.find(c => c.key === 'news')?.ok === false);
ok('Annonce dans 10 min : signal = attendre', newsNow.signal === 'attendre');
const tentative = analyze(series, 5, { now: tuesday, ...costs, news: { available: true, events: [{ t: tuesday + 6 * 60_000, currency: 'USD', title: 'Congressional Elections', tentative: true }] }, newsCurrencies: ['USD'] });
ok('Annonce à horaire non confirmé : pas de blocage à une fausse heure', tentative.checklist.find(c => c.key === 'news')?.ok === true);
ok('Annonce à horaire non confirmé : signalée pour la journée', tentative.tentativeNews.length === 1);
const noCal = analyze(series, 5, { now: tuesday, ...costs, newsCurrencies: ['USD'] });
ok('Calendrier indisponible : condition news en échec', noCal.checklist.find(c => c.key === 'news')?.ok === false);
const saturday = analyze(series, 5, { now: Date.UTC(2026, 10, 7, 12), ...costs, news: { available: true, events: [] } });
ok('Samedi : marché fermé, signal = attendre', saturday.signal === 'attendre' && saturday.session.name.startsWith('Marché fermé'));

// ---------- 5. Contrôle des niveaux proposés par l'IA ----------
{
  const eng: EngineResult = JSON.parse(JSON.stringify(withCosts));
  eng.price = 1.1;
  eng.timeframes.H1.atr14 = 0.002;
  eng.liquidity = [
    { id: 'A', label: 'cible', price: 1.106, side: 'buy', swept: false },
    { id: 'B', label: 'cible2', price: 1.108, side: 'buy', swept: false },
  ];
  eng.setup = { direction: 'acheter', entryType: 'limite', entry: 1.1, sl: 1.099, tp1: 1.1059, tp2: 1.1079, tp1Label: 'cible', tp2Label: 'cible2', rr1: 5, rr2: 7, zoneId: 'z', zoneLabel: 'zone' };
  eng.signal = 'acheter';
  const ai = (lv: AiReview['niveaux']): AiReview => ({ engine: 'test', verdict: 'VALIDÉ', signal: 'acheter', resume: '', contexte: '', liquidite: '', zones: '', plan: '', gestion: '', invalidation: '', lecture_capture: null, niveaux: lv });
  const tighter = reconcile(eng, ai({ entree: 1.1, stop_loss: 1.0995, tp1: 1.1059, tp2: 1.1079 }), 5, costs);
  ok('IA : stop plus serré refusé', tighter.plan?.sl === 1.099 && tighter.plan?.origin === 'moteur');
  const offTarget = reconcile(eng, ai({ entree: 1.1, stop_loss: 1.099, tp1: 1.1045, tp2: null }), 5, costs);
  ok('IA : objectif hors liquidité refusé', offTarget.plan?.tp1 === 1.1059);
  const wider = reconcile(eng, ai({ entree: 1.1, stop_loss: 1.0985, tp1: 1.1059, tp2: 1.1079 }), 5, costs);
  ok('IA : stop plus large et objectifs sur liquidité acceptés', wider.plan?.sl === 1.0985 && wider.plan?.origin === 'ajusté par l’IA');
  const moved = reconcile(eng, ai({ entree: 1.1003, stop_loss: 1.0985, tp1: 1.1059, tp2: 1.1079 }), 5, costs);
  ok('IA : entrée déplacée hors de la zone refusée', moved.plan?.entry === 1.1 && moved.plan?.origin === 'moteur');
  ok('IA : R:R recalculé sur les niveaux ajustés', !!wider.plan && Math.abs(wider.plan.rr1 - (Math.abs(wider.plan.tp1 - wider.plan.entry) - 7 / 100_000) / (Math.abs(wider.plan.entry - wider.plan.sl) + 7 / 100_000)) < 0.01);
  const rejected = reconcile(eng, { ...ai({ entree: null, stop_loss: null, tp1: null, tp2: null }), verdict: 'REJETÉ', signal: 'attendre' }, 5, costs);
  ok('IA : un rejet transforme le signal en attendre', rejected.signal === 'attendre');
  const forced = reconcile({ ...eng, signal: 'attendre' }, ai({ entree: 1.1, stop_loss: 1.099, tp1: 1.1059, tp2: null }), 5, costs);
  ok('IA : ne peut jamais forcer un trade', forced.signal === 'attendre');
}

// ---------- 6. Cycle AMD ----------
{
  // Jour de trading du mar. 3/11/2026 : Asie 20h-00h NY le lundi soir, Londres ensuite
  const asiaStart = nyToUtc(2026, 11, 2, 20);
  const m: Candle[] = [];
  for (let i = 0; i < 16; i++) m.push({ t: asiaStart + i * 900_000, o: 1.1, h: 1.101, l: 1.099, c: 1.1 }); // range 1.099-1.101
  const t1 = asiaStart + 16 * 900_000;
  const during = amdPhase(m.slice(0, 8), [], asiaStart + 2 * 3_600_000, 5);
  ok('AMD : accumulation pendant l’Asie', during.phase === 'Accumulation');
  const intact = amdPhase(m, [], t1 + 900_000, 5);
  ok('AMD : range intact après l’Asie = accumulation', intact.phase === 'Accumulation' && intact.asiaHigh === 1.101);
  const swept = [...m, { t: t1, o: 1.1, h: 1.1025, l: 1.0995, c: 1.1005 }];
  const manip = amdPhase(swept, [], t1 + 1_800_000, 5);
  ok('AMD : haut asiatique balayé = manipulation, distribution baissière attendue', manip.phase === 'Manipulation' && manip.direction === 'baissière');
  const dist = amdPhase(swept, [{ kind: 'CHoCH', dir: 'bear', level: 1.0995, t: t1 + 3_600_000, idx: 0 }], t1 + 4_000_000, 5);
  ok('AMD : cassure baissière après le balayage = distribution', dist.phase === 'Distribution');
  const both = [...swept, { t: t1 + 900_000, o: 1.1, h: 1.1, l: 1.098, c: 1.099 }];
  ok('AMD : deux côtés balayés = indéterminé', amdPhase(both, [], t1 + 3_600_000, 5).phase === 'Indéterminée');
  // bas jamais repris, mais haut balayé puis clôture au-dessus du plus haut du balayage 3 h plus tard
  const later = [...swept];
  for (let i = 1; i <= 12; i++) later.push({ t: t1 + i * 900_000, o: 1.1, h: 1.1004, l: 1.0992, c: 1.1002 });
  later.push({ t: t1 + 13 * 900_000, o: 1.1002, h: 1.104, l: 1.1002, c: 1.1035 });
  const bear = [{ kind: 'CHoCH' as const, dir: 'bear' as const, level: 1.0995, t: t1 + 3_600_000, idx: 0 }];
  const inval = amdPhase(later, bear, t1 + 14 * 900_000, 5);
  ok('AMD : clôture au-delà de l’extrême de la manipulation = cycle invalidé', inval.phase === 'Indéterminée' && inval.detail.includes('invalidé'), inval.detail);
  const notYet = amdPhase(swept, bear, t1 + 4_000_000, 5);
  ok('AMD : sans clôture au-delà, la distribution reste valide', notYet.phase === 'Distribution');
  // invalidation définitive : clôture au-delà puis retour dans le range
  const back = [...later, { t: t1 + 14 * 900_000, o: 1.1035, h: 1.1036, l: 1.0999, c: 1.1 }];
  ok('AMD : invalidation définitive même si le prix revient', amdPhase(back, bear, t1 + 15 * 900_000, 5).detail.includes('invalidé'));
  // distribution réussie : haut balayé, cassure baissière, puis bas asiatique atteint = distribution avancée
  const done = [...swept, { t: t1 + 3_600_000, o: 1.1, h: 1.1001, l: 1.0985, c: 1.0987 }];
  const ach = amdPhase(done, bear, t1 + 5_400_000, 5);
  ok('AMD : bas atteint après la cassure baissière = distribution (objectif atteint)', ach.phase === 'Distribution' && ach.direction === 'baissière', ach.detail);
}

// ---------- Week-end : le cycle AMD décrit la séance de vendredi, pas une séance fantôme ----------
{
  const sat = Date.UTC(2026, 9, 31, 23, 40); // samedi soir
  const fri = genM15(11, Date.UTC(2026, 9, 30, 21, 0), 0, 0.0002, 1.16); // dernière bougie : ven. 20:45 UTC (16:45 NY)
  const wk = analyze(seriesAt(fri), 5, { now: sat, spread: 0.0001, commissionPerLot: 7, contract: 100_000, news: { available: true, events: [] }, newsCurrencies: ['USD'] });
  ok('Week-end : AMD sans « range en formation »', !wk.amd.detail.includes('en formation'), wk.amd.detail);
}

// ---------- 7. Sweep obligatoire ----------
{
  const strictRes = analyze(series, 5, { now: tuesday, ...costs, news: { available: true, events: [] }, strictSweep: true });
  const softRes = analyze(series, 5, { now: tuesday, ...costs, news: { available: true, events: [] }, strictSweep: false });
  ok('Règle stricte : le balayage est une condition obligatoire', strictRes.checklist.find(c => c.key === 'sweep')?.core === true);
  ok('Règle souple : le balayage est un bonus', softRes.checklist.find(c => c.key === 'sweep')?.core === false);
  const sweepOk = strictRes.checklist.find(c => c.key === 'sweep')?.ok;
  if (!sweepOk) ok('Sans balayage, la règle stricte n’autorise aucun trade', strictRes.signal === 'attendre');
}

if (failed) {
  console.log(`\n${failed} test(s) en échec`);
  process.exit(1);
}
console.log('\nTous les tests du moteur passent.');
