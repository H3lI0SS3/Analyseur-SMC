// Moteur ORA corrigé : npx tsx server/ora.test.ts
import {
  calculateJournalStats, calculateOTEDiscountZone, createJournalEntry, evaluateMasterSMCTrade, oraKillZone, updateTradeStatus,
  type Candle, type MarketDataBundle,
} from './smcMasterEngine';
import { asianSession, buildBundle } from './ora';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const C = (t: number, o: number, h: number, l: number, c: number): Candle => ({ timestamp: t, open: o, high: h, low: l, close: c, volume: 0 });
const DAY = 86_400_000;
const T = Date.UTC(2026, 10, 4, 8, 0); // mercredi 08:00 UTC : kill zone de Londres
const costs = { spread: 0.2, commissionPerLot: 7, contract: 100 };

/** Achat d'école : biais D1 haussier, prix en discount M15, sweep du bas asiatique, displacement, FVG haussier M5. */
function bundle(over: Partial<{ t: number; fvg: boolean; dailyBull: boolean; keyHigh: number; sweep: boolean }> = {}): MarketDataBundle {
  const o = { t: T, fvg: true, dailyBull: true, keyHigh: 2100, sweep: true, ...over };
  const daily = [0, 1, 2, 3, 4, 5].map(i => C(T - (6 - i) * DAY, 1990, 2000, 1980, 1995));
  daily.push(o.dailyBull ? C(T - 3_600_000, 1995, o.keyHigh, 1990, 2015) : C(T - 3_600_000, 1995, 1999, 1985, 1990));
  const m15 = Array.from({ length: 30 }, (_, i) => C(T - (30 - i) * 900_000, 2020, 2040, 2000, 2010 + (i === 29 ? 0 : 5)));
  const asian = Array.from({ length: 8 }, (_, i) => C(Date.UTC(2026, 10, 4, i, 0), 2008, 2014, 2005, 2010));
  const m5: Candle[] = [];
  for (let i = 0; i < 19; i++) {
    const t = o.t - (20 - i) * 300_000;
    if (o.fvg && i === 6) m5.push(C(t, 2010.4, 2013, 2010.3, 2012.8)); // bougie impulsive : FVG entre i=5 et i=7
    else if (o.fvg && i >= 7) m5.push(C(t, 2012.4, 2012.9, 2011.2, 2012.5));
    else m5.push(C(t, 2010, 2010.5, 2009.6, 2010.2));
  }
  // bougie active : balaie le bas asiatique (2005) puis clôture haussière avec un grand corps
  m5.push(o.sweep ? C(o.t - 300_000, 2006, 2013, 2004, 2012) : C(o.t - 300_000, 2006, 2013, 2006, 2012));
  return { symbol: 'XAU/USD', daily, h4: [], m15, m5, asianSession: asian };
}

// 1. Cas d'école validé
const p = evaluateMasterSMCTrade(bundle(), costs);
ok('Achat d’école : VALIDÉ', p.status === 'VALIDÉ' && p.approved && p.direction === 'BUY', p.status + ' ' + p.steps.filter(s => !s.ok).map(s => s.label + ': ' + s.detail).join(' | '));
ok('Score 100 % quand les 6 confluences sont validées', p.confidenceScore === 100, String(p.confidenceScore));
ok('Les 6 étapes sont affichées dans l’ordre', p.steps.map(s => s.label).join(',') === 'Biais HTF,Matrice M15,Cycle AMD,Displacement M5,Confluence FVG/OTE,Ratio R:R');
ok('Stop sous le plus bas M5 − 0,30', p.stopLoss === 2003.7, String(p.stopLoss));
ok('R:R net TP1 = 1:2 exactement (coûts inclus)', p.rr1 === 2, String(p.rr1));
ok('R:R net TP2 ≥ 1:2,5 vers la liquidité HTF', (p.rr2 ?? 0) >= 2.5 && p.takeProfit2 === 2100, `${p.rr2} → ${p.takeProfit2}`);
ok('Ordre des niveaux : stop < entrée < TP1 < TP2', p.stopLoss < p.entryPrice && p.entryPrice < p.takeProfit1 && p.takeProfit1 < p.takeProfit2);

// 2. Correction 1 : sans FVG ni OTE → REJETÉ
const noFvg = evaluateMasterSMCTrade(bundle({ fvg: false }), costs);
ok('Sans FVG ni OTE : REJETÉ', noFvg.status === 'REJETÉ' && !noFvg.stepsValidation.fvgOteValidated, noFvg.steps[4].detail);
ok('Score dynamique : 5/6 = 83 %', noFvg.confidenceScore === 83, String(noFvg.confidenceScore));

// 3. Correction 3 : hors kill zone
const late = evaluateMasterSMCTrade(bundle({ t: Date.UTC(2026, 10, 4, 11, 30) }), costs);
ok('11:25 UTC : EN ATTENTE - HORS KILL ZONE', late.status === 'EN ATTENTE - HORS KILL ZONE' && !late.approved, late.status);
ok('Kill zones UTC : 07:00 Londres, 13:00 New York, 16:00 fermé', oraKillZone(Date.UTC(2026, 10, 4, 7, 0)).name === 'Londres' && oraKillZone(Date.UTC(2026, 10, 4, 13, 0)).name === 'New York' && !oraKillZone(Date.UTC(2026, 10, 4, 16, 0)).active && !oraKillZone(Date.UTC(2026, 10, 4, 6, 55)).active);

// 4. Correction 2 : TP2 trop proche ou du mauvais côté
const nearTp2 = evaluateMasterSMCTrade(bundle({ keyHigh: 2030 }), costs);
ok('TP2 trop proche (R:R < 2,5) : REJETÉ', nearTp2.status === 'REJETÉ' && !nearTp2.stepsValidation.rrValid, nearTp2.steps[5].detail);
const wrongTp2 = evaluateMasterSMCTrade(bundle({ keyHigh: 2011 }), costs);
ok('TP2 sous l’entrée d’un achat : plan annulé', !wrongTp2.approved && /mauvais côté/.test(wrongTp2.steps[5].detail), wrongTp2.steps[5].detail);

// 5. Biais neutre et absence de sweep
const neutral = evaluateMasterSMCTrade(bundle({ dailyBull: false }), costs);
ok('Biais D1 neutre : REJETÉ, aucune direction', neutral.status === 'REJETÉ' && neutral.direction === null && neutral.confidenceScore === 0);
const noSweep = evaluateMasterSMCTrade(bundle({ sweep: false }), costs);
ok('Pas de sweep asiatique : AMD refusé', !noSweep.stepsValidation.amdCycleValid && !noSweep.approved);

// 6. Bugs du code d'origine corrigés
const ote = calculateOTEDiscountZone(110, 100, 'SELL');
ok('OTE vente : borne basse < borne haute (106,18 – 107,86)', ote.oteLow < ote.oteHigh && Math.abs(ote.oteLow - 106.18) < 1e-9 && Math.abs(ote.oteHigh - 107.86) < 1e-9);
ok('FVG haussier reconnu pour un BUY (BULLISH ≠ BUY corrigé)', p.stepsValidation.fvgOteValidated && /FVG haussier/.test(p.steps[4].detail), p.steps[4].detail);

// 7. Journal
const j = createJournalEntry(p, T)!;
ok('Journal : trade OPEN créé depuis un plan validé', j.status === 'OPEN' && j.entryPrice === p.entryPrice);
ok('Journal : rien n’est créé depuis un plan rejeté', createJournalEntry(noFvg) === null);
const w = updateTradeStatus(j, 'WIN_TP1', p.takeProfit1);
const l = updateTradeStatus({ ...j, id: 'b' }, 'LOSS', p.stopLoss);
const be = updateTradeStatus({ ...j, id: 'c' }, 'BREAK_EVEN', p.entryPrice + 1);
ok('Pips or (1 pip = 0,10 $)', w.pnlPips === Math.round((p.takeProfit1 - p.entryPrice) * 100) / 10, String(w.pnlPips));
const st = calculateJournalStats([w, l, be, { ...j, id: 'd' }]);
ok('Stats : 3 clôturés, 1 gain, win rate 33 %, trades ouverts exclus', st.totalTrades === 3 && st.wins === 1 && st.losses === 1 && st.breakEvens === 1 && st.winRate === 33, JSON.stringify(st));

// 8. Paquet serveur : uniquement des bougies clôturées, session asiatique du jour
{
  const now = Date.UTC(2026, 10, 4, 8, 2); // la M5 de 08:00 est en cours
  const mk = (step: number, from: number, n: number) => Array.from({ length: n }, (_, i) => ({ t: from + i * step, o: 1, h: 2, l: 0.5, c: 1.5 }));
  const t8 = Date.UTC(2026, 10, 4, 8, 0);
  const h1 = mk(3_600_000, t8 - 200 * 3_600_000, 201);
  const m15 = mk(900_000, t8 - 100 * 900_000, 101);
  const m5 = mk(300_000, t8 - 60 * 300_000, 61);
  const b = buildBundle('XAU/USD', h1, m15, m5, now);
  ok('M5 active = dernière bougie clôturée (07:55)', b.m5[b.m5.length - 1].timestamp === Date.UTC(2026, 10, 4, 7, 55));
  ok('Aucune M15/H1 en cours dans le paquet', b.m15.every(c => c.timestamp + 900_000 <= now));
  const asia = asianSession(m15, now);
  ok('Session asiatique : 00:00–06:00 UTC du jour', asia.length > 0 && asia.every(c => new Date(c.t).getUTCHours() < 6 && new Date(c.t).getUTCDate() === 4));
}

if (failed) { console.log(`\n${failed} test(s) en échec`); process.exit(1); }
console.log('\nTous les tests du moteur ORA passent.');
