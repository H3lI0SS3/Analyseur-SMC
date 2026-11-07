# Analyseur SMC – EUR/USD & Or

Outil d'aide à la décision SMC/ICT pour EUR/USD et XAU/USD. **Aucune exécution d'ordres** : l'app analyse, tu décides et tu passes l'ordre toi-même chez ton broker.

## Principe (règles 3.8)

1. **Vraies données** : bougies D1, H4, H1 et M15 depuis Twelve Data (offre gratuite : 800 requêtes / jour, l'app en consomme ~30 / heure quand elle est ouverte et visible). Si Twelve Data est épuisé ou en panne, l'app bascule sur **Yahoo Finance** (EUR/USD direct, or via futures recalées sur le spot). Aucun prix n'est inventé.
2. **Moteur déterministe** (`server/smc.ts`) — protocole en 4 étapes, toutes obligatoires :
   1. **Contexte HTF** : biais D1/H4, balayage d'une liquidité HTF, zone H1/H4 ou objectif externe ;
   2. **Déclencheur M15**, dans l'ordre : balayage → displacement → CHoCH ;
   3. **Zone** : FVG/OB né de l'impulsion, en premium (vente) ou discount (achat) de la vague ;
   4. **Timing et risque** : kill zone Londres/New York, pas d'annonce à ±30 min, stop derrière le balayage, TP sur la liquidité opposée, **R:R net ≥ 1:2,5**.
3. **Pipeline Gemini** (`server/pipeline/`) : Gemini reçoit les bougies en fenêtres glissantes + les faits du moteur, et renvoie un JSON strict **VALIDÉ** ou **REJETÉ**. Le serveur recontrôle chaque chiffre (R:R recalculé, stop, premium/discount, TP sur liquidité, même plan que le moteur). **Un trade n'est proposé que si le moteur ET Gemini sont d'accord.** Si Gemini ne répond pas en 30 s, l'app garde le verdict du moteur et le signale.
4. **Risque** : taille de lot selon ton capital et ton % de risque (classe B = risque divisé par 2), compte standard ou cent, garde-fou de perte journalière, journal suivi automatiquement en R.

## Clés (AI Studio → Secrets)

| Variable | Rôle |
|---|---|
| `GEMINI_API_KEY` | Injectée par AI Studio. Active Gemini. |
| `ANTHROPIC_API_KEY` | Facultative. Active Claude (prioritaire en mode Auto). |
| `TWELVE_DATA_API_KEY` | Facultative, recommandée : cotations spot. Sans elle, l'or vient des futures COMEX (GC=F). |
| `MCP_TOKEN` | Facultative. Active le connecteur Claude sur `/mcp` (16 caractères minimum). |
| `CLAUDE_MODEL` / `GEMINI_MODEL` | Facultatifs (par défaut `claude-sonnet-5-5` / `gemini-3.8-flash`). |

## Connecteur Claude (MCP)

L'app expose un serveur MCP sur `https://<ton-app>/mcp` (lecture seule) avec 4 outils : `etat`, `cotations`, `bougies`, `analyser`.

1. Dans AI Studio → Secrets, crée `MCP_TOKEN` avec un code long et aléatoire, puis publie l'app.
2. Dans Claude → Personnaliser → Connecteurs → Ajouter → Connecteur personnalisé :
   - URL : `https://<ton-app>/mcp/<ton MCP_TOKEN>` (méthode recommandée)
   - Authentification : « Pas de connexion ».
   - Autres formes acceptées : en-tête `Authorization: Bearer <token>`, en-tête `X-API-Key`, ou `?token=<token>`.
3. Les journaux du serveur (AI Studio) affichent chaque appel `[MCP]` pour diagnostiquer, sans jamais afficher le secret.

## Mettre à jour l'app publiée (AI Studio)

1. AI Studio → onglet **GitHub** → **Pull changes to Google AI Studio**.
2. Onglet **Publish** → **Republish** → **Publish your app**.
3. Vérifier : l'app affiche la version des règles dans `/api/status` (`rulesVersion`).

## Tests

```bash
npm test   # moteur, protocole, pipeline Gemini, backtest, suivi, données réelles, cohérence
```

## Lancer en local

```bash
npm install
cp .env.example .env   # puis renseigner les clés
npm run dev            # http://localhost:3000
```

## Structure

```
server.ts              API : /api/status, /api/quotes, /api/candles, /api/analyze
server/marketData.ts   Récupération des bougies réelles + cache
server/smc.ts          Moteur SMC/ICT (calculs)
server/ai.ts           Relecture par Claude (sortie structurée)
server/pipeline/       Pipeline Gemini : payload.ts (fenêtres OHLCV), schema.ts (JSON VALIDÉ/REJETÉ + zod),
                       gemini.ts (appel, délai, secours), guard.ts (contrôle serveur), index.ts (orchestration)
server/audit.ts        Contrôleur de cohérence (aucune analyse contradictoire ne donne de trade)
server/analysis.ts     Analyse partagée (web + connecteur)
server/mcp.ts          Connecteur MCP pour Claude
src/App.tsx            Interface mobile (Analyse, Journal, Réglages)
src/components/        Graphique, panneau d'analyse, journal, réglages
```

Outil d'aide à la décision, pas un conseil en investissement. Teste d'abord sur compte démo.


## Données FxPro (cTrader) et alertes automatiques

### 1. Connecter cTrader (lecture seule)
1. Va sur https://openapi.ctrader.com, connecte-toi avec ton cTrader ID (celui de FxPro), puis **Applications → Add new app**. Attends que l'application soit validée (statut « Active »).
2. Note le **Client ID** et le **Secret**.
3. Ouvre le **Playground** de l'application, choisis l'autorisation **« accounts »** (lecture seule), connecte ton compte FxPro et copie l'**access token** et le **refresh token**.
4. Dans AI Studio, panneau **Secrets**, ajoute : `CTRADER_CLIENT_ID`, `CTRADER_CLIENT_SECRET`, `CTRADER_ACCESS_TOKEN`, `CTRADER_REFRESH_TOKEN`, et `CTRADER_ENV` = `demo` (ou `live` pour un compte réel).
5. Republie. Dans Réglages, la source doit afficher **cTrader (FxPro)**. En cas de problème cTrader, l'app bascule seule sur Twelve Data, puis Yahoo.

L'app n'implémente aucun message de trading : elle ne peut pas passer d'ordre, même avec un jeton qui en aurait le droit.

### 2. Bot Telegram
1. Dans Telegram, écris à **@BotFather** → `/newbot` → copie le **token**.
2. Ajoute `TELEGRAM_BOT_TOKEN` et `WATCH_SECRET` (une phrase longue et aléatoire, 16 caractères minimum) dans les Secrets, puis republie.
3. Envoie « bonjour » à ton bot, puis ouvre `https://TON-APP/api/watch/telegram-chats?key=TON_WATCH_SECRET` : copie l'`id` affiché dans `TELEGRAM_CHAT_ID`, puis republie.
4. Test : `https://TON-APP/api/watch/telegram-test?key=TON_WATCH_SECRET` doit t'envoyer un message.

### 3. Vérification toutes les 5 minutes
L'hébergement AI Studio se met en veille sans visiteur : une tâche externe réveille l'app.
1. Crée un compte gratuit sur https://cron-job.org.
2. Nouvelle tâche : adresse `https://TON-APP/api/watch/tick?key=TON_WATCH_SECRET`, toutes les **5 minutes**, délai d'attente maximal.
3. La surveillance ne travaille que pendant les kill zones (Londres 02–05 h, New York 07–10 h, heure de New York), sur l'or uniquement (EUR/USD en pause). Elle envoie « setup en préparation » quand le scénario M15 est valide, puis « ordre prêt » quand le CHoCH M5 confirme. Les alertes apparaissent aussi en haut de l'onglet Analyse, avec « Ajouter au journal ».
