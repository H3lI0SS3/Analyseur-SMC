// Journal automatique cTrader + sauvegarde Telegram (aucun réseau). npx tsx server/fxJournal.test.ts
import { buildTrades, fxStats, matchSignal } from './fxJournal';
import { JournalStore, type StoreData, type SignalRec } from './journalStore';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const T = (h: number, m: number, s = 0) => Date.UTC(2026, 10, 10, h, m, s);
const EUR = 1;
const XAU = 41;
const pairOf = (id: number) => (id === EUR ? 'EUR/USD' : id === XAU ? 'XAU/USD' : null);
const decimals = { 'EUR/USD': 5, 'XAU/USD': 2 };

// le trade réel de Mehdi (relevé FxPro du 10/11) : vente 1 lot EUR/USD au marché 1.12184, clôture 1.11495, brut 689 $, frais 7,83 $
const deals = [
  { dealId: 1, orderId: 11, positionId: 155532150, symbolId: EUR, tradeSide: 'SELL', volume: 10_000_000, filledVolume: 10_000_000, executionPrice: 1.12184, executionTimestamp: T(10, 18, 57), dealStatus: 'FILLED', moneyDigits: 2 },
  {
    dealId: 2, orderId: 12, positionId: 155532150, symbolId: EUR, tradeSide: 'BUY', volume: 10_000_000, filledVolume: 10_000_000, executionPrice: 1.11495, executionTimestamp: T(16, 23, 29), dealStatus: 'FILLED', moneyDigits: 2,
    closePositionDetail: { entryPrice: 1.12184, grossProfit: 68900, swap: 0, commission: -783, closedVolume: 10_000_000, moneyDigits: 2 },
  },
  // un trade sur un autre symbole (ignoré)
  { dealId: 3, orderId: 13, positionId: 999, symbolId: 77, tradeSide: 'BUY', volume: 100, filledVolume: 100, executionPrice: 10, executionTimestamp: T(11, 0), dealStatus: 'FILLED' },
  // un achat d'or encore ouvert, stop posé dans l'ordre
  { dealId: 4, orderId: 14, positionId: 777, symbolId: XAU, tradeSide: 'BUY', volume: 1_000, filledVolume: 1_000, executionPrice: 4050.5, executionTimestamp: T(12, 30), dealStatus: 'FILLED', moneyDigits: 2 },
];
const orders = [{ orderId: 14, stopLoss: 4040.5 }];
const sigTest: SignalRec = { id: 'test|EUR/USD|vendre|M15-FVG-1', pair: 'EUR/USD', kind: 'test', direction: 'vendre', entry: 1.12376, sl: 1.12532, tp1: 1.12176, tp2: 1.11356, at: T(10, 15), validUntil: T(13, 0), zone: 'FVG' };
const store: StoreData = { v: 1, signals: [sigTest], annotations: {} };

const trades = buildTrades(deals, orders, pairOf, store, decimals);
const eur = trades.find(t => t.positionId === '155532150')!;
ok('Positions de l’app seulement (autre symbole ignoré)', trades.length === 2 && !trades.some(t => t.positionId === '999'));
ok('Vente EUR/USD : 1 lot, entrée 1.12184, sortie 1.11495', eur.direction === 'vendre' && eur.lots === 1 && eur.entry === 1.12184 && eur.exit === 1.11495);
ok('Résultat net = relevé FxPro (681,17 $)', eur.net === 681.17 && eur.gross === 689 && eur.fees === -7.83, `${eur.net}`);
ok('Rapproché du signal TEST de 10:15', eur.kind === 'test' && eur.kindSource === 'signal' && eur.signal?.id === sigTest.id);
ok('Risque réel : entrée réelle → stop du plan (34,8 pips × 1 lot = 348 $)', eur.riskUsd === 348 && eur.stopSource === 'plan', `${eur.riskUsd}`);
ok('R net réel ≈ +1,96 (et non +6,21)', eur.r === 1.96, `${eur.r}`);
ok('Écart avec le plan signalé (entrée au marché au lieu de la limite)', eur.gaps.length === 1 && /1\.12184/.test(eur.gaps[0]));
const gold = trades.find(t => t.positionId === '777')!;
ok('Position ouverte : pas de R ni de résultat, stop lu dans l’ordre', gold.closedAt === null && gold.net === null && gold.r === null && gold.stop === 4040.5 && gold.stopSource === 'ordre' && gold.lots === 0.1);
ok('Sans signal : classé « hors app »', gold.kind === 'hors' && gold.kindSource === 'aucun');

// annotations : type forcé à la main et stop saisi
const store2: StoreData = { v: 1, signals: [], annotations: { '155532150': { kind: 'test', sl: 1.12532, note: 'entrée trop tôt' } } };
const t2 = buildTrades(deals, orders, pairOf, store2, decimals).find(t => t.positionId === '155532150')!;
ok('Annotation : type et stop saisis, note gardée', t2.kind === 'test' && t2.kindSource === 'saisi' && t2.stopSource === 'saisi' && t2.r === 1.96 && t2.note === 'entrée trop tôt');

// rapprochement : fenêtre et priorité au protocole
const sigPro: SignalRec = { ...sigTest, id: 'p', kind: 'protocole', at: T(10, 0) };
ok('Le protocole prime sur le TEST dans la même fenêtre', matchSignal([sigTest, sigPro], 'EUR/USD', 'vendre', T(10, 20))?.kind === 'protocole');
ok('Hors fenêtre de validité : pas de rapprochement', matchSignal([sigTest], 'EUR/USD', 'vendre', T(14, 0)) === null);
ok('Sens opposé : pas de rapprochement', matchSignal([sigTest], 'EUR/USD', 'acheter', T(10, 20)) === null);

// statistiques
const s = fxStats(trades.filter(t => t.kind !== 'hors'));
ok('Stats : 1 trade clos, +1,96 R, 681,17 $', s.closed === 1 && s.totalR === 1.96 && s.netUsd === 681.17 && s.viability === null);

// sauvegarde Telegram (fichier épinglé)
(async () => {
  const calls: { method: string; body: any }[] = [];
  let saved: string | null = null;
  const fake = async (url: string, init?: any) => {
    const method = url.split('/').pop()!;
    if (url.includes('/file/bot')) return { ok: true, status: 200, json: async () => JSON.parse(saved ?? '{}') };
    let body: any = null;
    if (init?.body instanceof FormData) {
      const f = init.body.get('document') as Blob;
      saved = await f.text();
      body = { file_name: (init.body.get('document') as any).name };
    } else if (init?.body) body = JSON.parse(init.body);
    calls.push({ method, body });
    const result =
      method === 'getChat' ? (saved ? { pinned_message: { message_id: 5, document: { file_id: 'F', file_name: 'ora-journal.json' } } } : {}) :
      method === 'getFile' ? { file_path: 'docs/x.json' } :
      method === 'sendDocument' ? { message_id: 6 } : true;
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };
  const env = { TELEGRAM_BOT_TOKEN: '1:A', TELEGRAM_CHAT_ID: '42' };
  const st = new JournalStore(env, fake as any, 0);
  ok('Sauvegarde persistante quand Telegram est configuré', st.persistent);
  ok('Signal ajouté une fois (pas de doublon)', (await st.addSignal(sigTest)) && !(await st.addSignal(sigTest)));
  await st.annotate('155532150', { kind: 'test', note: 'ok', sl: 1.12532 });
  await st.flush();
  ok('Fichier JSON envoyé puis épinglé sans notification', calls.some(c => c.method === 'sendDocument') && calls.some(c => c.method === 'pinChatMessage' && c.body.disable_notification === true));
  const st2 = new JournalStore(env, fake as any, 0);
  const back = await st2.get();
  ok('Relu par un nouveau serveur (autre appareil / redémarrage)', back.signals.length === 1 && back.annotations['155532150']?.note === 'ok' && back.annotations['155532150']?.sl === 1.12532);
  const mem = new JournalStore({}, fake as any, 0);
  ok('Sans Telegram : mémoire seule, pas d’erreur', !mem.persistent && (await mem.addSignal(sigTest)) && (await mem.get()).signals.length === 1);

  if (failed) {
    console.log(`\n${failed} test(s) en échec`);
    process.exit(1);
  }
  console.log('\nTous les tests du journal automatique passent.');
})();
