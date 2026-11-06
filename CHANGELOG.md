# Journal des versions

## 06/11/2026 — labo : entrée affinée M5 (règles en direct inchangées, 3.10)
- **Hypothèse testée, déclarée avant de voir les résultats** : même setup M15 (contexte, balayage, displacement, CHoCH, zone), mais entrée affinée en M5 comme le font les traders SMC en intraday : le prix entre dans la zone M15, fait un extrême M5, puis CHoCH M5 (clôture au-delà du dernier creux/sommet M5) ; ordre limite au milieu de la jambe du CHoCH ; stop derrière l'extrême M5 (au moins 25 % du stop M15) ; objectifs inchangés. Si le stop M15 est touché avant le CHoCH M5, pas de trade.
- La 2e moitié de l'historique est toujours révélée pour cette variante : c'est elle qui décidera si l'app passe en exécution M5.
- Le backtest télécharge aussi le **M5 sur 2 ans** (facultatif : s'il échoue, le reste du backtest continue).
- Rapport du backtest : liste de **tous les signaux depuis le gel des règles**, y compris les ordres limite jamais exécutés (pour rejouer les journées récentes) ; les doublons strict/souple sont retirés.
- Cohérence : un niveau de liquidité pris par une mèche M15 ne garde plus l'étiquette « non pris » (ex. « Swing low H4 non pris » marqué déjà pris) ; contrôle ajouté à l'audit automatique.
- **Bug corrigé** : quand Twelve Data atteint sa limite par minute, il répond « erreur » dans une réponse normale ; l'app le prenait pour la fin de l'historique et le backtest tournait en silence sur une période tronquée (1 an au lieu de 2 pour l'or le 06/11). Elle attend maintenant une minute et reprend la même page.
- Téléchargement de l'historique plus robuste : une page lente est retentée 2 fois au lieu de faire échouer tout le backtest (cause de l'échec EUR/USD du 06/11).

## Règles 3.10 — 03/11/2026 (mise en situation)
- Le **timing s'applique à l'entrée** : l'app ne propose un trade que pendant une kill zone (Londres / New York). Un balayage pendant une kill zone devient un bonus (+10 au score), conformément au protocole (« sessions de Londres ou New York de préférence »). En 3.9, un setup formé en Asie était refusé même à l'ouverture de Londres : zéro trade en deux jours.
- Test de mise en situation sur les vraies bougies du 02-03/11 (journal, règles du desk, taille, suivi automatique).

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
