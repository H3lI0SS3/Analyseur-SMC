# Analyseur SMC – EUR/USD & Or

Outil d'aide à la décision SMC/ICT pour EUR/USD et XAU/USD. **Aucune exécution d'ordres** : l'app analyse, tu décides et tu passes l'ordre toi-même chez ton broker.

## Principe

1. **Vraies données** : bougies D1, H4, H1 et M15 depuis Twelve Data (si clé) ou Yahoo Finance. Si la source ne répond pas, l'app affiche une erreur : aucun prix n'est inventé.
2. **Moteur de calcul** (`server/smc.ts`), déterministe et vérifiable :
   - structure par unité de temps (swings, BOS, CHoCH), EMA 50/200, RSI, ATR ;
   - liquidité : veille (PDH/PDL), semaine précédente (PWH/PWL), range asiatique, égaux hauts/bas, swings H1 non pris, balayages récents ;
   - zones : Fair Value Gaps et Order Blocks H1/M15 non invalidés ;
   - plan : entrée sur la zone, stop derrière la zone, objectifs sur la liquidité opposée, R:R calculé ;
   - checklist de 7 conditions, dont 3 obligatoires (biais D1/H4, zone dans le sens du biais, R:R ≥ 1:2).
3. **IA** (Claude ou Gemini) : relit les calculs, la capture d'écran éventuelle et ta note. Elle peut **rejeter** un plan ou **affiner** les niveaux (ajustement accepté seulement s'il reste cohérent et à R:R ≥ 1:2), mais ne peut jamais transformer un « attendre » en trade.
4. **Risque** : taille de lot calculée selon ton capital et ton % de risque (compte en USD), garde-fou de perte journalière, journal en R avec export CSV.

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
server/ai.ts           Relecture par Claude / Gemini (sortie structurée)
server/analysis.ts     Analyse partagée (web + connecteur)
server/mcp.ts          Connecteur MCP pour Claude
src/App.tsx            Interface mobile (Analyse, Journal, Réglages)
src/components/        Graphique, panneau d'analyse, journal, réglages
```

Outil d'aide à la décision, pas un conseil en investissement. Teste d'abord sur compte démo.
