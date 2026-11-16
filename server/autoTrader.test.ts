// Bot de test démo : npx tsx server/autoTrader.test.ts
process.env.BOT_MODE = 'demo';
import { AutoTrader, botEnabled, botKinds, splitVolume, volumeFor, type BotOrder, type Spec, type TradingPort } from './autoTrader';
import { CTraderClient, CTraderError, ctraderConfig } from './ctrader';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};

const spec: Spec = { symbolId: 1, digits: 5, lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000, maxVolume: 10_000_000_000 };
const NOW = Date.UTC(2026, 10, 16, 9, 0);

function fake(opts: { gate?: { ok: boolean; reason: string }; positions?: any[]; orders?: any[]; failOn?: number } = {}) {
  const placed: any[] = [];
  const cancelled: number[] = [];
  const amended: any[] = [];
  const state = { positions: opts.positions ?? [], orders: opts.orders ?? [] };
  const port: TradingPort = {
    tradingGate: () => opts.gate ?? { ok: true, reason: '' },
    symbolSpec: async () => spec,
    reconcile: async () => ({ positions: state.positions, orders: state.orders }),
    placeLimit: async o => {
      if (opts.failOn !== undefined && placed.length === opts.failOn) throw new Error('refusé par le broker');
      placed.push(o);
      state.orders = [...state.orders, { orderId: 900 + placed.length, tradeData: { label: o.label } }];
    },
    cancelOrder: async id => {
      cancelled.push(id);
    },
    amendPositionSl: async (id, sl, tp) => {
      amended.push({ id, sl, tp });
    },
  };
  return { port, placed, cancelled, amended, state };
}

const sell: BotOrder = { pair: 'EUR/USD', kind: 'ordre', direction: 'vendre', entryType: 'limite', entry: 1.10637, sl: 1.10702, tp1: 1.10466, tp2: 1.1001, validUntil: NOW + 3 * 3_600_000, lots: 0.26, price: 1.1048 };

(async () => {
  ok('Éteint par défaut sans BOT_MODE', !botEnabled({}) && botEnabled({ BOT_MODE: 'demo' }) && !botEnabled({ BOT_MODE: 'live' }));
  ok('Types pris : ordre et test par défaut', botKinds({}).has('ordre') && botKinds({}).has('test') && !botKinds({ BOT_KINDS: 'ordre' }).has('test'));
  ok('Volume arrondi au pas (0,26 lot → 0,26)', volumeFor(0.26, spec) === 2_600_000);
  ok('Volume sous le minimum → 0', volumeFor(0.0004, spec) === 0);
  ok('Coupe en deux : 0,26 → 0,13 + 0,13', JSON.stringify(splitVolume(2_600_000, spec)) === JSON.stringify([1_300_000, 1_300_000]));
  ok('Coupe impossible : 0,01 lot', splitVolume(100_000, spec) === null);

  // 1) ordre normal : deux moitiés, stop commun, TP1 / TP2, étiquettes A / B
  let f = fake();
  let bot = new AutoTrader(f.port, 3, () => NOW);
  let r = await bot.place(sell);
  ok('Ordre passé', r.placed, r.message);
  ok('Deux ordres limite (moitié TP1, moitié TP2)', f.placed.length === 2 && f.placed[0].tp === 1.10466 && f.placed[1].tp === 1.1001 && f.placed[0].volume === 1_300_000 && f.placed[1].volume === 1_300_000);
  ok('Même entrée et même stop, côté vente', f.placed.every(o => o.side === 'SELL' && o.limit === 1.10637 && o.sl === 1.10702));
  ok('Étiquettes ORA|id|A et B', /^ORA\|[a-z0-9]+\|A$/.test(f.placed[0].label) && /^ORA\|[a-z0-9]+\|B$/.test(f.placed[1].label));
  ok('Expiration = validité du plan', f.placed[0].expiresAt === sell.validUntil);

  // 2) un seul trade à la fois
  r = await bot.place({ ...sell, entry: 1.1064 });
  ok('Refus : un trade du bot est déjà ouvert', !r.placed && /déjà ouvert/.test(r.message), r.message);

  // 3) refus de sécurité
  f = fake({ gate: { ok: false, reason: 'Le compte utilisé est un compte RÉEL' } });
  r = await new AutoTrader(f.port, 3, () => NOW).place(sell);
  ok('Refus sur compte réel / sans droit de trading', !r.placed && f.placed.length === 0 && /RÉEL/.test(r.message));
  f = fake();
  bot = new AutoTrader(f.port, 3, () => NOW);
  r = await bot.place({ ...sell, entry: 1.1040, price: 1.1048 });
  ok('Refus : vente limite sous le prix', !r.placed && /dépassé/.test(r.message) && f.placed.length === 0);
  r = await bot.place({ ...sell, sl: 1.1050 });
  ok('Refus : stop du mauvais côté', !r.placed && /incohérents/.test(r.message));
  r = await bot.place({ ...sell, lots: null });
  ok('Refus : pas de lot conseillé', !r.placed && /lot conseillé/.test(r.message));
  r = await bot.place({ ...sell, entryType: 'marche' });
  ok('Refus : ordre au marché non géré', !r.placed && /limite/.test(r.message));

  // 4) limite par jour
  f = fake();
  bot = new AutoTrader(f.port, 1, () => NOW);
  await bot.place(sell);
  f.state.orders = [];
  r = await bot.place(sell);
  ok('Refus : limite d’ordres par jour', !r.placed && /par jour/.test(r.message), r.message);
  const later = new AutoTrader(f.port, 1, () => NOW + 86_400_000 + 1000);
  ok('Compteur remis à zéro le lendemain', (await later.place(sell)).placed);

  // 5) sans TP2 : tout à TP1, un seul ordre
  f = fake();
  r = await new AutoTrader(f.port, 3, () => NOW).place({ ...sell, tp2: null });
  ok('Sans TP2 : un seul ordre vers TP1', r.placed && f.placed.length === 1 && f.placed[0].volume === 2_600_000 && f.placed[0].tp === 1.10466);

  // 6) la 2e moitié échoue : la 1re est retirée
  f = fake({ failOn: 1 });
  r = await new AutoTrader(f.port, 3, () => NOW).place(sell);
  ok('2e ordre refusé : 1re moitié annulée, rien ne reste', !r.placed && f.cancelled.length === 1 && /NON passé/.test(r.message), r.message);

  // 7) gestion : TP1 touché (A fermé) → stop de B au prix d'entrée
  const posB = (sl: number) => ({ positionId: 7, price: 1.10637, stopLoss: sl, takeProfit: 1.1001, tradeData: { label: 'ORA|abc123|B', tradeSide: 2 } });
  f = fake({ positions: [posB(1.10702)] });
  let msgs = await new AutoTrader(f.port, 3, () => NOW).manage();
  ok('TP1 touché : stop de la 2e moitié remonté au point d’entrée', f.amended.length === 1 && f.amended[0].sl === 1.10637 && f.amended[0].tp === 1.1001 && msgs.length === 1);
  f = fake({ positions: [posB(1.10637)] });
  msgs = await new AutoTrader(f.port, 3, () => NOW).manage();
  ok('Stop déjà au point d’entrée : rien à faire', f.amended.length === 0 && msgs.length === 0);
  f = fake({ positions: [posB(1.10702), { positionId: 6, price: 1.10637, stopLoss: 1.10702, tradeData: { label: 'ORA|abc123|A', tradeSide: 2 } }] });
  msgs = await new AutoTrader(f.port, 3, () => NOW).manage();
  ok('TP1 pas encore touché (A ouverte) : stop inchangé', f.amended.length === 0);
  f = fake({ positions: [{ positionId: 8, price: 1.1, stopLoss: 1.2, tradeData: { label: 'manuel', tradeSide: 2 } }] });
  msgs = await new AutoTrader(f.port, 3, () => NOW).manage();
  ok('Position manuelle (sans étiquette ORA) jamais touchée', f.amended.length === 0);
  f = fake({ gate: { ok: false, reason: 'x' }, positions: [posB(1.10702)] });
  msgs = await new AutoTrader(f.port, 3, () => NOW).manage();
  ok('Gestion inactive si le garde-fou refuse', f.amended.length === 0);

  // 8) garde-fou du vrai client cTrader : lecture seule, compte réel, env live
  const cfg = ctraderConfig({ CTRADER_CLIENT_ID: 'a', CTRADER_CLIENT_SECRET: 'b', CTRADER_ACCESS_TOKEN: 'c' })!;
  const mk = (env: 'demo' | 'live', scope: string, live: boolean) => {
    const c: any = new CTraderClient({ ...cfg, env });
    c.scope = scope;
    c.accountInfo = { login: 111, broker: 'FxPro' };
    c.availableAccounts = [{ login: 111, live, broker: 'FxPro' }];
    return c as CTraderClient;
  };
  ok('Garde-fou : jeton lecture seule refusé', !mk('demo', 'SCOPE_VIEW', false).tradingGate().ok);
  ok('Garde-fou : compte réel refusé', !mk('demo', 'SCOPE_TRADE', true).tradingGate().ok);
  ok('Garde-fou : CTRADER_ENV=live refusé', !mk('live', 'SCOPE_TRADE', false).tradingGate().ok);
  ok('Garde-fou : démo + droit de trading accepté', mk('demo', 'SCOPE_TRADE', false).tradingGate().ok);
  let refused = false;
  try {
    await mk('demo', 'SCOPE_VIEW', false).placeLimit({ pair: 'EUR/USD', side: 'SELL', volume: 100000, limit: 1.1, sl: 1.2, tp: 1, expiresAt: NOW, label: 'ORA|x|A', comment: '' });
  } catch (e) {
    refused = e instanceof CTraderError && e.code === 'TRADING_REFUSED';
  }
  ok('placeLimit lève TRADING_REFUSED sans autorisation (aucun message envoyé)', refused);

  console.log(failed ? `\n${failed} échec(s)` : '\nTous les tests du bot démo passent.');
  process.exit(failed ? 1 : 0);
})();
