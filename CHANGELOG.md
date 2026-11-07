# Journal des versions

## 07/11/2026 (nuit) — ORA retiré de l'app
- Backtest 2 ans sur l'or, mêmes coûts et même gestion : **ORA corrigé 10 trades, 20 % de réussite, −0,24 R par trade (−2,4 R)**, contre +0,33 R par trade pour l'exécution M5 en direct (50 trades, positive sur les deux moitiés). ORA trouve trop peu de setups et ceux-ci perdent.
- L'onglet « ORA (test) » et la route `/api/ora` sont retirés : un seul verdict dans l'app. Le moteur (`server/smcMasterEngine.ts`) et son backtest restent dans le code pour pouvoir le retester ; le rapport du backtest continue d'afficher le bloc ORA pour comparaison.
- L'en-tête (ORA Trader, indicateur de session, statut de connexion) est conservé.

## 07/11/2026 (soir) — ORA : deux idées retenues de la nouvelle version proposée
- **Kill zones ORA à l'heure de New York**, identiques au moteur principal (Londres 02–05 h, New York 07–10 h) : 07–10 h et 12–15 h UTC en hiver, une heure plus tôt en UTC pendant l'heure d'été américaine.
- **FVG validé seulement si le prix de la bougie active est à l'intérieur** (retour dans le FVG au moment de l'entrée) ; l'OTE reste une alternative.
- Non repris de cette version (revue du 07/11) : score fixe à 95, contrôle R:R qui ne peut pas échouer et sans frais, suppression du R:R ≥ 2,5 vers TP2, biais par moyenne mobile, bougie active « avant-dernière » (information future dans le stop), arrêt à la première étape, seuil d'impulsion abaissé sans test, arrondi à 3 décimales.

## 07/11/2026 — ORA Trader (moteur corrigé, en test) et nouvel en-tête
- **Moteur ORA** (`server/smcMasterEngine.ts`) intégré avec les corrections demandées : FVG ou OTE obligatoire ; R:R net TP1 ≥ 1:2 et TP2 ≥ 1:2,5 (spread et commission inclus) ; kill zones 07:00–10:00 et 13:00–16:00 UTC (sinon « EN ATTENTE - HORS KILL ZONE ») ; score de confiance dynamique sur 6 confluences. Bugs du code d'origine corrigés : FVG jamais reconnu ('BULLISH' comparé à 'BUY'), zone OTE de vente impossible (bornes inversées), TP2 possible du mauvais côté, displacement sans contrôle du sens.
- Évalué uniquement sur des bougies clôturées (dernière M5 clôturée = bougie active), session asiatique 00:00–06:00 UTC. Route `/api/ora`.
- **Onglet « ORA (test) »** : panneau de validation (6 étapes + kill zone), carte « Plan de Trade Validé » (BUY/SELL, entrée, SL, TP1, TP2, R:R, taille), bouton « 📌 Prendre le Trade », **Journal de Trading ORA** (OPEN, WIN_TP1, WIN_TP2, LOSS, BREAK_EVEN ; trades clôturés, win rate, pips cumulés).
- **Backtest** : ORA est rejoué sur les mêmes 2 ans, en M5, avec les mêmes coûts et la même gestion que le moteur actuel (bloc « moteur_ora_corrige » du rapport). Il ne remplacera le moteur principal que s'il fait mieux sur les deux moitiés.
- **En-tête** : nom ORA Trader, indicateur de session (kill zones, Asie, rollover, marché fermé) et statut de connexion (connecté, secours Yahoo, données indisponibles, hors ligne), à côté du sélecteur d'actif.

## Règles 3.11 — 06/11/2026 (décision après le backtest sur 2 ans)
- **Or : exécution affinée en M5.** Le scénario M15 complet reste obligatoire (contexte, balayage → displacement → CHoCH, zone en premium/discount, kill zone, annonces, Gemini). L'entrée n'est donnée qu'après un **CHoCH M5 dans la zone M15** : ordre limite au milieu de la jambe du CHoCH, stop derrière l'extrême M5, objectifs M15 inchangés. Règle identique à celle du backtest (même fonction). Étapes affichées : attente de la zone → attente du CHoCH M5 (avec le niveau à surveiller) → ordre ; « manqué » si l'entrée a déjà été servie, « annulé » si le stop M15 ou TP1 est touché avant. Sans bougies M5 : pas d'entrée.
  - Backtest 2 ans, gain moyen par trade (1re / 2e moitié) : or −0,05 / +0,24 R en M15 → **+0,31 / +0,35 R en M5** ; EUR/USD −0,26 / −0,12 R → +0,34 / 0,00 R. Environ 3 fois moins de trades : avantage encourageant mais pas encore démontré (≈ 7 % de risque que ce soit le hasard). Validation par les 30 premiers trades suivis en démo.
- **EUR/USD en pause** : −0,19 R par trade sur 180 trades en 2 ans, sur les deux moitiés. L'analyse reste affichée, aucun trade n'est proposé.
- Date de gel remise au 06/11 20:00 UTC : le suivi « depuis le gel » repart sur ces règles.

## 06/11/2026 — labo : entrée affinée M5 (règles en direct inchangées, 3.10)
- **Hypothèse testée, déclarée avant de voir les résultats** : même setup M15 (contexte, balayage, displacement, CHoCH, zone), mais entrée affinée en M5 comme le font les traders SMC en intraday : le prix entre dans la zone M15, fait un extrême M5, puis CHoCH M5 (clôture au-delà du dernier creux/sommet M5) ; ordre limite au milieu de la jambe du CHoCH ; stop derrière l'extrême M5 (au moins 25 % du stop M15) ; objectifs inchangés. Si le stop M15 est touché avant le CHoCH M5, pas de trade.
- La 2e moitié de l'historique est toujours révélée pour cette variante : c'est elle qui décidera si l'app passe en exécution M5.
- Le backtest télécharge aussi le **M5 sur 2 ans** (facultatif : s'il échoue, le reste du backtest continue).
- Rapport du backtest : liste de **tous les signaux depuis le gel des règles**, y compris les ordres limite jamais exécutés (pour rejouer les journées récentes) ; les doublons strict/souple sont retirés.
- Cohérence : un niveau de liquidité pris par une mèche M15 ne garde plus l'étiquette « non pris » (ex. « Swing low H4 non pris » marqué déjà pris) ; contrôle ajouté à l'audit automatique.
- **Bug corrigé** : quand Twelve Data atteint sa limite par minute, il répond « erreur » dans une réponse normale ; l'app le prenait pour la fin de l'historique et le backtest pouvait tourner en silence sur une période tronquée. Elle attend maintenant une minute et reprend la même page.
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
