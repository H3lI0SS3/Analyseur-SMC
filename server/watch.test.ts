// Surveillance automatique et alertes Telegram (aucun réseau). npx tsx server/watch.test.ts
import { Watcher, toHtml } from './watch';
import { esc, sendTelegram, telegramChats, telegramConfig } from './telegram';

let failed = 0;
const ok = (label: string, cond: boolean, info = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK ' : 'ÉCHEC'} ${label}${info ? ` — ${info}` : ''}`);
};
const KZ = Date.UTC(2026, 11, 2, 13, 0); // mercredi 08:00 New York (kill zone NY, heure d'hiver)
const plan = { direction: 'vendre', entryType: 'limite', entry: 4051.54, sl: 4060.2, tp1: 4020.1, tp2: 3990, rr1: 3.2, rr2: 6.4 };
const zone = { bottom: 4050, top: 4055 };
const resp = (over: any) => ({ pair: 'XAU/USD', generatedAt: KZ, final: { signal: 'attendre', plan, notes: [] }, execution: null, engine: { setup: { validUntil: KZ + 3_600_000 } }, ...over });

(async () => {
  // Telegram
  ok('Telegram non configuré : désactivé', telegramConfig({}) === null);
  ok('Échappement HTML', esc('<b>&') === '&lt;b&gt;&amp;');
  const calls: any[] = [];
  const fakeFetch = async (url: string, init?: any) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/getUpdates')) return { ok: true, status: 200, json: async () => ({ ok: true, result: [{ message: { chat: { id: 777, first_name: 'Mehdi' } } }] }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const env = { TELEGRAM_BOT_TOKEN: '123:ABC', TELEGRAM_CHAT_ID: '777' };
  const sent = await sendTelegram('<b>test</b>', { fetchImpl: fakeFetch, env });
  ok('Envoi Telegram : bon bot, bon chat, mode HTML', sent.ok && calls[0].url === 'https://api.telegram.org/bot123:ABC/sendMessage' && calls[0].body.chat_id === '777' && calls[0].body.parse_mode === 'HTML');
  const bad = await sendTelegram('x', { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) }), env });
  ok('Erreur Telegram renvoyée sans exception', !bad.ok && /Unauthorized/.test(bad.error ?? ''));
  const down = await sendTelegram('x', { fetchImpl: async () => { throw new Error('ECONNRESET'); }, env });
  ok('Telegram injoignable : pas d’exception', !down.ok && /injoignable/.test(down.error ?? ''));
  ok('Recherche du chat id (getUpdates)', (await telegramChats({ fetchImpl: fakeFetch, env }))[0]?.id === '777');

  // Surveillance
  let next: any = resp({});
  const providers: string[] = [];
  const messages: string[] = [];
  ok('Paires surveillées par défaut : or et EUR/USD (EUR/USD réactivé en M5)', new Watcher(async () => null).pairs.join(',') === 'EUR/USD,XAU/USD', new Watcher(async () => null).pairs.join(','));
  let offKz = false;
  const w = new Watcher(
    async ({ provider }) => {
      providers.push(provider);
      return next;
    },
    async html => {
      messages.push(html);
      return { ok: true };
    },
    () => offKz,
    ['XAU/USD']
  );

  const sat = await w.tick(Date.UTC(2026, 11, 5, 13, 0));
  ok('Samedi : rien n’est analysé', sat.skipped === 'Marché fermé.' && providers.length === 0);
  const off = await w.tick(Date.UTC(2026, 11, 2, 17, 0));
  ok('Hors kill zone : rien n’est analysé', /Hors kill zone/.test(off.skipped ?? '') && providers.length === 0);

  const t1 = await w.tick(KZ);
  ok('Kill zone, pas de setup : 1 seule analyse rapide sans IA, aucune alerte', providers.join(',') === 'none' && t1.checked[0].alert === null && messages.length === 0);

  next = resp({ execution: { stage: 'attente_zone', zone, message: 'Setup M15 valide. Attends le retour dans la zone 4050 – 4055.' } });
  providers.length = 0;
  const t2 = await w.tick(KZ + 300_000);
  ok('Setup M15 : 2e analyse complète (avec Gemini) puis alerte « en préparation »', providers.join(',') === 'none,auto' && t2.checked[0].alert === 'setup' && /en préparation/.test(messages[0]));
  await w.tick(KZ + 600_000);
  ok('Même setup 5 min plus tard : pas de doublon', messages.length === 1);

  next = resp({ final: { signal: 'vendre', plan, notes: [] }, execution: { stage: 'ordre', zone, message: 'CHoCH M5 à 13:10 : ordre Sell Limit à 4051.54.' } });
  const t3 = await w.tick(KZ + 900_000);
  ok('CHoCH M5 : alerte « ordre prêt » avec entrée, stop, TP et validité', t3.checked[0].alert === 'ordre' && /ordre prêt/.test(messages[1]) && /Sell Limit : 4051\.54/.test(messages[1]) && /Stop : 4060\.20/.test(messages[1]) && /TP2 : 3990\.00/.test(messages[1]) && /Valable jusqu&#39;à|Valable jusqu'à/.test(messages[1]), messages[1]?.slice(0, 120));
  ok('Le message rappelle que rien n’est passé automatiquement', /Rien n'est passé automatiquement/.test(messages[1]));
  await w.tick(KZ + 1_200_000);
  ok('Même ordre 5 min plus tard : pas de doublon', messages.length === 2);
  ok('Alertes gardées pour l’app (analyse jointe pour « Ajouter au journal »)', w.alerts.length === 2 && w.alerts[0].kind === 'ordre' && w.alerts[0].analysis.final.plan.entry === 4051.54);
  ok('Message HTML : titre en gras, contenu échappé', toHtml({ ...w.alerts[0], text: 'Titre\n<a> & b' }) === '<b>Titre</b>\n&lt;a&gt; &amp; b');

  next = resp({ execution: { stage: 'annulé', zone, message: 'Stop M15 touché.' } });
  const t4 = await w.tick(KZ + 1_500_000);
  ok('Setup annulé : pas d’alerte', t4.checked[0].alert === null && messages.length === 2);

  // mode entraînement : alerte TEST, aussi hors kill zone quand la source est cTrader (gratuite)
  const tsetup = { direction: 'acheter', entryType: 'limite', entry: 4100.5, sl: 4094.2, tp1: 4115, tp2: 4120, rr1: 2.1, rr2: 2.9, zoneId: 'M15-FVG-1', validUntil: KZ + 7_200_000 };
  next = resp({ engine: { setup: null, training: { setup: tsetup, missing: ['Zone en discount de l’impulsion (< 50 %)'] } } });
  const t6 = await w.tick(KZ + 1_800_000);
  ok('Signal d’entraînement : alerte « TEST » avec entrée, stop, conditions manquantes et risque 0,25 %', t6.checked[0].alert === 'test' && /TEST entraînement/.test(messages[2]) && /Buy Limit : 4100\.50/.test(messages[2]) && /discount/.test(messages[2]) && /0,25 %/.test(messages[2]), messages[2]?.slice(0, 160));
  await w.tick(KZ + 2_100_000);
  ok('Même signal TEST 5 min plus tard : pas de doublon', messages.length === 3);
  providers.length = 0;
  const offSkip = await w.tick(Date.UTC(2026, 11, 2, 17, 0));
  ok('Hors kill zone sans cTrader : rien n’est analysé (crédits Twelve Data)', !!offSkip.skipped && providers.length === 0);
  offKz = true;
  const offRun = await w.tick(Date.UTC(2026, 11, 2, 17, 0));
  ok('Hors kill zone avec cTrader : analyse rapide sans IA (signaux TEST possibles)', offRun.skipped === null && providers.join(',') === 'none');

  // une erreur d'analyse ne casse pas la surveillance
  const w2 = new Watcher(async () => { throw new Error('Twelve Data indisponible'); }, async () => ({ ok: true }));
  const t5 = await w2.tick(KZ);
  ok('Erreur de données : signalée, pas d’exception', t5.checked[0].verdict === 'erreur' && /Twelve/.test(t5.checked[0].error ?? ''));

  if (failed) {
    console.log(`\n${failed} test(s) en échec`);
    process.exit(1);
  }
  console.log('\nTous les tests de surveillance passent.');
})();
