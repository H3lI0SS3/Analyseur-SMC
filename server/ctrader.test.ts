// Client cTrader contre un serveur simulé (aucun réseau). npx tsx server/ctrader.test.ts
import { CTraderClient, ctraderConfig, PT, toCandle, type SocketLike } from './ctrader';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};

/** Serveur cTrader simulé : répond comme l'Open API JSON (port 5036). */
function fakeServer(opts: { expiredToken?: boolean; symbols?: { symbolId: number; symbolName: string }[]; dropAfter?: number } = {}) {
  const sent: any[] = [];
  let tokenOk = !opts.expiredToken;
  const urls: string[] = [];
  const factory = (url: string): SocketLike => {
    urls.push(url);
    const ws: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      close() {
        setTimeout(() => ws.onclose?.(), 0);
      },
      send(data: string) {
        const msg = JSON.parse(data);
        sent.push(msg);
        const reply = (payloadType: number, payload: any) =>
          setTimeout(() => ws.onmessage?.({ data: JSON.stringify({ clientMsgId: msg.clientMsgId, payloadType, payload }) }), 1);
        switch (msg.payloadType) {
          case PT.HEARTBEAT:
            return;
          case PT.APP_AUTH_REQ:
            return msg.payload.clientSecret === 'secret' ? reply(PT.APP_AUTH_RES, {}) : reply(PT.ERROR_RES, { errorCode: 'CH_CLIENT_AUTH_FAILURE', description: 'bad secret' });
          case PT.ACCOUNTS_BY_TOKEN_REQ:
            return reply(PT.ACCOUNTS_BY_TOKEN_RES, { accessToken: msg.payload.accessToken, permissionScope: 'SCOPE_VIEW', ctidTraderAccount: [{ ctidTraderAccountId: 999, isLive: true }, { ctidTraderAccountId: 123, isLive: false }] });
          case PT.ACCOUNT_AUTH_REQ:
            if (!tokenOk && msg.payload.accessToken === 'old') return reply(PT.ERROR_RES, { errorCode: 'CH_ACCESS_TOKEN_INVALID', description: 'expired' });
            return reply(PT.ACCOUNT_AUTH_RES, { ctidTraderAccountId: msg.payload.ctidTraderAccountId });
          case PT.REFRESH_TOKEN_REQ:
            tokenOk = true;
            return reply(PT.REFRESH_TOKEN_RES, { accessToken: 'new', tokenType: 'bearer', expiresIn: 2628000, refreshToken: 'r2' });
          case PT.SYMBOLS_LIST_REQ:
            return reply(PT.SYMBOLS_LIST_RES, { ctidTraderAccountId: 123, symbol: opts.symbols ?? [{ symbolId: 41, symbolName: 'XAUUSD' }, { symbolId: 1, symbolName: 'EURUSD' }] });
          case PT.GET_TRENDBARS_REQ: {
            const { fromTimestamp, toTimestamp, period } = msg.payload;
            const step = period === 5 ? 300_000 : period === 7 ? 900_000 : 3_600_000;
            const bars = [];
            for (let t = Math.ceil(fromTimestamp / step) * step; t < toTimestamp && t <= NOW; t += step) {
              const day = new Date(t).getUTCDay();
              if (day === 6) continue; // samedi fermé
              // or vers 4000 : low 400000000 (= 4000,00), open +50 (0,50), high +300, close +120 (champ deltaOpen absent si 0)
              bars.push({ volume: 10, period, low: 400_000_000 + (t / step) % 1000, deltaOpen: 50_000, deltaHigh: 300_000, deltaClose: 120_000, utcTimestampInMinutes: t / 60_000 });
            }
            return reply(PT.GET_TRENDBARS_RES, { ctidTraderAccountId: 123, period, trendbar: bars });
          }
          default:
            return reply(PT.ERROR_RES, { errorCode: 'UNSUPPORTED', description: String(msg.payloadType) });
        }
      },
    };
    setTimeout(() => ws.onopen?.(), 1);
    return ws;
  };
  return { factory, sent, urls };
}

const NOW = Date.UTC(2026, 10, 4, 9, 2);
const cfg = { clientId: 'id', clientSecret: 'secret', accessToken: 'tok', refreshToken: null, accountId: null, env: 'demo' as const, symbols: { 'XAU/USD': 'XAUUSD', 'EUR/USD': 'EURUSD' } };

(async () => {
  // 1. Configuration par l'environnement
  ok('Sans variables CTRADER_* : cTrader désactivé', ctraderConfig({}) === null);
  const c1 = ctraderConfig({ CTRADER_CLIENT_ID: ' a ', CTRADER_CLIENT_SECRET: 'b', CTRADER_ACCESS_TOKEN: 'c', CTRADER_ENV: 'LIVE', CTRADER_ACCOUNT_ID: '42' });
  ok('Configuration lue (espaces retirés, live, compte)', !!c1 && c1.clientId === 'a' && c1.env === 'live' && c1.accountId === 42 && c1.symbols['XAU/USD'] === 'XAUUSD');

  // 2. Conversion des prix
  const k = toCandle({ low: 400_012_345, deltaHigh: 300_000, deltaClose: 120_000, utcTimestampInMinutes: NOW / 60_000 });
  ok('Prix au 1/100 000, champ absent = 0 (open = low)', !!k && k.l === 4000.12345 && k.h === 4003.12345 && k.c === 4001.32345 && k.o === 4000.12345, JSON.stringify(k));

  // 3. Connexion complète et bougies M5
  const s = fakeServer();
  const client = new CTraderClient(cfg, s.factory, { heartbeatMs: 5, idleMs: 60_000 });
  const m5 = await client.trendbars('XAU/USD', 'M5', 150, NOW);
  ok('URL démo JSON : wss://demo.ctraderapi.com:5036', s.urls[0] === 'wss://demo.ctraderapi.com:5036');
  ok('Séquence : application → comptes → compte → symboles → barres', s.sent.filter(m => m.payloadType !== PT.HEARTBEAT).map(m => m.payloadType).slice(0, 5).join(',') === [PT.APP_AUTH_REQ, PT.ACCOUNTS_BY_TOKEN_REQ, PT.ACCOUNT_AUTH_REQ, PT.SYMBOLS_LIST_REQ, PT.GET_TRENDBARS_REQ].join(','));
  ok('Compte démo choisi automatiquement (123, pas le réel 999)', s.sent.find(m => m.payloadType === PT.ACCOUNT_AUTH_REQ)?.payload.ctidTraderAccountId === 123);
  ok('Symbole XAUUSD → id 41', s.sent.find(m => m.payloadType === PT.GET_TRENDBARS_REQ)?.payload.symbolId === 41);
  ok('150 bougies M5, triées, espacées de 5 min', m5.length === 150 && m5.every((c, i) => i === 0 || c.t - m5[i - 1].t === 300_000), String(m5.length));
  ok('Prix reconstruits (≈ 4000)', m5.every(c => c.l > 3999 && c.l < 4011 && c.h > c.l && c.o >= c.l && c.c <= c.h));
  ok('Jeton en lecture seule détecté', client.scope === 'SCOPE_VIEW');

  // 4. H1 sur 5000 barres : découpé en plusieurs requêtes, sans doublon
  const before = s.sent.filter(m => m.payloadType === PT.GET_TRENDBARS_REQ).length;
  const h1 = await client.trendbars('XAU/USD', 'H1', 5000, NOW);
  const reqs = s.sent.filter(m => m.payloadType === PT.GET_TRENDBARS_REQ).slice(before);
  ok('H1 : historique découpé en tranches (≤ 90 jours)', reqs.length >= 3 && reqs.every(r => r.payload.toTimestamp - r.payload.fromTimestamp <= 90 * 86_400_000), `${reqs.length} requêtes`);
  ok('H1 : 5000 bougies uniques', h1.length === 5000 && new Set(h1.map(c => c.t)).size === 5000);
  ok('Connexion réutilisée (une seule authentification)', s.sent.filter(m => m.payloadType === PT.APP_AUTH_REQ).length === 1);
  await new Promise(r => setTimeout(r, 20));
  ok('Heartbeat envoyé', s.sent.some(m => m.payloadType === PT.HEARTBEAT));
  // 5. SÉCURITÉ : aucun message autre que lecture (pas d'ordre, pas d'abonnement au trading)
  const allowed = new Set<number>([PT.HEARTBEAT, PT.APP_AUTH_REQ, PT.ACCOUNTS_BY_TOKEN_REQ, PT.ACCOUNT_AUTH_REQ, PT.SYMBOLS_LIST_REQ, PT.GET_TRENDBARS_REQ, PT.REFRESH_TOKEN_REQ]);
  ok('Aucun message de trading envoyé', s.sent.every(m => allowed.has(m.payloadType)));
  client.close();

  // 6. Jeton expiré : renouvelé une fois avec le refresh token
  const s2 = fakeServer({ expiredToken: true });
  const c2 = new CTraderClient({ ...cfg, accessToken: 'old', refreshToken: 'r1' }, s2.factory, { heartbeatMs: 60_000 });
  const bars = await c2.trendbars('XAU/USD', 'M15', 50, NOW);
  ok('Jeton expiré → renouvelé puis compte authentifié', bars.length === 50 && c2.tokenRefreshedAt !== null && s2.sent.filter(m => m.payloadType === PT.ACCOUNT_AUTH_REQ).pop()?.payload.accessToken === 'new');
  c2.close();

  // 7. Erreurs claires
  const c3 = new CTraderClient({ ...cfg, clientSecret: 'faux' }, fakeServer().factory, { heartbeatMs: 60_000 });
  const e3 = await c3.trendbars('XAU/USD', 'M5', 10, NOW).catch(e => e);
  ok('Mauvais secret : erreur explicite', e3 instanceof Error && /CH_CLIENT_AUTH_FAILURE/.test(e3.message), e3?.message);
  const c4 = new CTraderClient(cfg, fakeServer({ symbols: [{ symbolId: 7, symbolName: 'GOLD' }] }).factory, { heartbeatMs: 60_000 });
  const e4 = await c4.trendbars('XAU/USD', 'M5', 10, NOW).catch(e => e);
  ok('Symbole absent : message qui indique CTRADER_SYMBOL_XAU', e4 instanceof Error && /CTRADER_SYMBOL_XAU/.test(e4.message), e4?.message);
  c4.close();
  const c5 = new CTraderClient({ ...cfg, symbols: { 'XAU/USD': 'GOLD', 'EUR/USD': 'EURUSD' } }, fakeServer({ symbols: [{ symbolId: 7, symbolName: 'GOLD' }] }).factory, { heartbeatMs: 60_000 });
  ok('Nom de symbole personnalisé (GOLD)', (await c5.trendbars('XAU/USD', 'M5', 10, NOW)).length === 10);
  c5.close();
  const c6 = new CTraderClient(cfg, () => { const w: any = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }; setTimeout(() => w.onerror?.(), 1); return w; }, { heartbeatMs: 60_000 });
  const e6 = await c6.trendbars('XAU/USD', 'M5', 10, NOW).catch(e => e);
  ok('Serveur injoignable : erreur explicite et nouvelle tentative possible', e6 instanceof Error && /impossible/.test(e6.message) && c6.lastError !== null);

  // 8. Intégration : la source de données de l'app lit cTrader en priorité
  {
    const srv = fakeServer();
    (globalThis as any).WebSocket = function (url: string) {
      return srv.factory(url);
    };
    Object.assign(process.env, { CTRADER_CLIENT_ID: 'id', CTRADER_CLIENT_SECRET: 'secret', CTRADER_ACCESS_TOKEN: 'tok', CTRADER_ENV: 'demo' });
    delete process.env.TWELVE_DATA_API_KEY;
    const realNow = Date.now;
    Date.now = () => NOW; // mercredi, marché ouvert
    const md = await import('./marketData');
    const m15 = await md.getSeries('XAU/USD', 'M15');
    ok('getSeries M15 : source cTrader (FxPro)', m15.source === md.CTRADER_SOURCE && m15.candles.length === 700 && !m15.futuresProxy, `${m15.source} ${m15.candles.length}`);
    const d1 = await md.getSeries('XAU/USD', 'D1');
    ok('D1 reconstruit depuis le H1 cTrader', d1.candles.length > 100 && d1.source === md.CTRADER_SOURCE, String(d1.candles.length));
    const m5 = await md.getM5('XAU/USD');
    ok('getM5 : bougies cTrader', !!m5 && m5.length === 150);
    const live = await md.getLivePrice('XAU/USD');
    ok('Prix en direct = dernière M5 cTrader', !!live && live.price === m5![m5!.length - 1].c);
    ok('Statut : source affichée « cTrader (FxPro) »', md.dataSourceName() === 'cTrader (FxPro)');
    ok('Toujours aucun message de trading', srv.sent.every(m => [PT.HEARTBEAT, PT.APP_AUTH_REQ, PT.ACCOUNTS_BY_TOKEN_REQ, PT.ACCOUNT_AUTH_REQ, PT.SYMBOLS_LIST_REQ, PT.GET_TRENDBARS_REQ].includes(m.payloadType)));
    Date.now = realNow;
  }

  if (failed) {
    console.log(`\n${failed} test(s) en échec`);
    process.exit(1);
  }
  console.log('\nTous les tests cTrader passent.');
  process.exit(0);
})();
