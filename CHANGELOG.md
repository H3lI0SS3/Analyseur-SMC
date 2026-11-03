# Journal des versions

## Règles 3.9 — 03/11/2026 (revue « desk »)
- **Ticket broker** : ordre prêt à saisir (Buy/Sell Limit ou marché), position découpée en deux ordres (TP1 et TP2), break-even à déplacer sur l'ordre 2, expiration de l'ordre limite.
- **Règles du desk** au moment de prendre un trade : 2 trades maximum par jour, stop après 2 pertes d'affilée, un seul trade par actif, pas deux trades avec la même exposition au dollar (achat or + achat EUR/USD).
- **Rollover** (16h45–18h30 New York) : aucune nouvelle entrée, et les ordres limite expirent avant 16h45 NY.
- **Jour d'annonce forte à horaire inconnu** (élections…) : classe B au mieux, donc risque divisé par 2.

## 02/11/2026 — secours de données
- **Yahoo Finance en secours** quand Twelve Data est épuisé (429) ou en panne : EUR/USD directement ; or via les futures COMEX recalées sur le spot (écart futures − spot mesuré sur les dernières bougies Twelve Data). Si l'écart est inconnu, niveaux de l'or masqués.
- Après un 429 « quota du jour », plus aucun appel à Twelve Data jusqu'à minuit UTC.
- Bandeau dans l'app quand les données de secours sont utilisées.

## Règles 3.8 — 02/11/2026
- **Pipeline Gemini** (`server/pipeline/`) : payload OHLCV en fenêtres glissantes (H4 60, H1 72, M15 96 bougies, budget ~6 000 tokens), Structured Outputs `VALIDÉ` / `REJETÉ`, validation zod, délai de 30 s, nouvelle tentative et modèles de secours.
- **Contrôle serveur** de chaque réponse de Gemini : même plan que le moteur, sens du biais, déclencheur, prix réels, entrée au début du FVG, premium/discount, stop derrière le sweep, TP sur liquidité, R:R recalculé.
- **Double validation** : trade uniquement si le moteur et Gemini sont d'accord ; Gemini muet = moteur seul + avertissement.
- **R:R net minimal 1:2,5** (moteur, pipeline, audit, base de connaissance).
- Quota Twelve Data : cache plus long, pas de rafraîchissement onglet caché, message clair après un 429.

## Règles 3.7 — 02/11/2026
- Protocole SMC en 4 étapes obligatoires : contexte HTF ; balayage → displacement → CHoCH ; FVG/OB de l'impulsion en premium/discount de la vague ; kill zone + annonces.
- Stop derrière l'extrême du balayage (début du balayage compris).

## Règles 3.6 — 02/11/2026
- Pas de trade contre une impulsion M15 ≥ 3 ATR des 2 dernières heures.
