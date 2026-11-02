# Analyseur SMC – EUR/USD & Or

Outil d'aide à la décision SMC/ICT pour EUR/USD et XAU/USD. **Aucune exécution d'ordres** : l'app analyse, tu décides et tu passes l'ordre toi-même chez ton broker.

## Principe (règles 3.8)

1. **Vraies données** : bougies D1, H4, H1 et M15 depuis Twelve Data (offre gratuite : 800 requêtes / jour, l'app en consomme ~30 / heure quand elle est ouverte et visible). Aucun prix n'est inventé.
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
