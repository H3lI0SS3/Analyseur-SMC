# Journal des versions

## Audit — lot 3 : robustesse et backtest
- Alertes : déduplication persistante (fichier Telegram) — la même alerte ne repart plus après un redémarrage ou sur une autre instance.
- Alertes « ordre prêt » et TEST : volume conseillé (solde réel × risque prévu), perte si stop, chemin cTrader « Ordre en attente → Limit, PAS au marché ».
- Sauvegarde Telegram : le fichier épinglé est remplacé dans le même message (plus de messages « épinglé » à chaque sauvegarde), relu et fusionné avant chaque écriture, sauvegardes regroupées (20 s).
- Backtest : historique lu sur cTrader (même flux que le direct ; Twelve Data en secours) ; exécution M5 rejouée exactement comme en direct (surveillance après la bougie du CHoCH et dans la kill zone, ordre déjà servi = manqué, R:R revérifié après l'affinage M5).
- Surveillance : le secret peut passer par l'en-tête X-Watch-Key (Réglages et README).

## Backtest : gestion de sortie de Mehdi (mesure)
- Nouvelle comparaison des gestions, sur le protocole + TEST en exécution M5 : la gestion actuelle (50 % à TP1, stop au point d'entrée, reste à TP2) contre la gestion de Mehdi (toute la position vise TP2, stop initial gardé, puis remonté sur TP1 quand le prix a fait la moitié ou les 3/4 du chemin TP1 → TP2).

## Audit — lot 1 : chiffres justes et risque maîtrisé
- Journal FxPro : le stop retenu pour le R est le stop d'origine, du côté de la perte et à moins de 5 % de l'entrée ; un stop déplacé en gain (cas du 10/11, +1,04 R faux) ou aberrant (« 1 ») est ignoré et signalé. Stop saisi vérifié par le serveur.
- Solde réel lu sur cTrader (lecture seule) : les lots proposés l'utilisent à la place du capital saisi.
- Risque conseillé : 0,5 % par trade du protocole tant que l'app n'a pas 30 trades réels clos, puis 1 % ; TEST 0,25 %.
- Chaque trade du journal montre le lot pris, le lot conseillé, le risque réel en % ; au-delà de 2 fois le lot conseillé : « position trop grosse ».
- Perte du jour et règles du desk (trades par jour, pertes d'affilée, un trade par actif, exposition dollar) calculées sur le compte FxPro réel, positions ouvertes comprises.
- Surveillance : alerte Telegram (une seule fois) si une position ouverte est trop grosse ou si la perte du jour atteint 3 %.

## Règles 3.12 (gel le 12/11/2026 à 12:00 UTC) — décidées sur la ventilation du backtest
- Or : le premium/discount de l’impulsion devient facultatif (bonus). C’est la seule variante qui passe le critère fixé à l’avance (≥ +0,2 R net par trade et ≥ 30 trades sur chacune des deux moitiés, exécution M5 : +0,38 R puis +0,55 R). EUR/USD : inchangé (+0,39 R puis +0,15 R, sous le critère).
- Mode TEST recentré : kill zone et contexte HTF obligatoires ; il ne peut manquer que le premium/discount et/ou un R:R entre 2 et 2,5. Le signal TEST passe par la même exécution M5 que le protocole (CHoCH M5 dans la zone) : l’alerte 🧪 et le bouton ne viennent qu’avec l’ordre M5.
- Backtest : nouvelle mesure « entrée au marché après le CHoCH M5 » (au lieu de l’ordre limite à mi-jambe) pour le protocole et le TEST 3.12 ; l’ancienne définition du TEST reste mesurée pour comparaison.

## Backtest : ventilation par condition manquante (mesure seule)
- Le backtest mesure, en M15 et en M5, le protocole seul puis le protocole + les setups auxquels il manque UNE seule condition (kill zone, R:R 2,5, premium/discount, contexte HTF), les setups « sans kill zone » seuls, et tout le mode TEST.
- Critère fixé avant de voir les résultats : on n'envisage d'assouplir une condition que si la variante garde au moins 30 trades et ≥ +0,2 R net par trade sur chacune des deux moitiés. Aucune règle n'est changée.

## Journal automatique FxPro
- Le journal lit tes positions sur ton compte cTrader (lecture seule : deals et ordres) : entrée et sortie réelles, lots, résultat net (frais et swap compris). Les mêmes sur tous tes appareils, sans saisie.
- Chaque position est rapprochée du signal de l’app qui l’a proposée (protocole ou TEST, même actif et même sens pendant sa validité). Le R est le résultat net réel divisé par le risque réel (ton entrée → le stop du plan) ; les écarts avec le plan sont signalés.
- Statistiques et viabilité : tous les trades de l’app (protocole + TEST), avec le détail par type ; les trades « hors app » ne comptent pas.
- Type, stop et note modifiables ; sauvegarde persistante dans un fichier épinglé de ta conversation Telegram (le serveur AI Studio ne garde rien).
- Outil connecteur « journal ».

## Signal TEST : validité fixe
- La validité d’un signal TEST est ancrée sur la cassure M15 (4 h après, comme le backtest) au lieu de glisser à chaque analyse ; passé ce délai, plus de signal TEST sur ce déclencheur.

## EUR/USD réactivé et mode entraînement (TEST)
- EUR/USD réactivé, exécuté en M5 comme l’or (même règle que le backtest).
- Mode entraînement (compte démo) : quand le déclencheur M15 est complet (balayage → displacement → CHoCH, FVG/OB de l’impulsion) mais que le contexte HTF, le premium/discount ou la kill zone manque, ou que le R:R net est entre 1:2 et 1:2,5, l’app propose un signal « TEST » (carte dédiée, alerte Telegram 🧪, risque 0,25 %).
- Journal : trades TEST marqués et comptés à part ; ils n’entrent jamais dans la viabilité du protocole.
- Surveillance : hors kill zone, analyse rapide sans IA si la source est cTrader (gratuite), pour les signaux TEST.
- Backtest : la 2e variante mesure « protocole + entraînement » (fréquence par jour de bourse et résultat en R).

## Heure du Maroc et dépendances
- Heure du Maroc = GMT depuis le 20/09/2026, codée dans l’app : le serveur AI Studio (base de fuseaux ancienne) affichait +1 h.
- Volume profile : le lundi, la veille est la séance du vendredi.
- cTrader utilise le WebSocket natif de Node 22 : dépendance « ws » retirée (package.json aligné sur le package-lock).

## cTrader : historique H1 fiable
- Requêtes d’historique espacées (limite cTrader : 5 par seconde) et refus de fréquence réessayés.
- Plage trop longue refusée : tranches raccourcies automatiquement.
- Erreurs suivies par série (M5, M15, H1) : une série qui marche n’efface plus l’erreur d’une autre.
- Le test cTrader du connecteur vérifie M15, H1 (5000 bougies) et M5.

## cTrader : choix du compte démo
- Les comptes démo du cTrader ID sont essayés du plus récemment actif au plus ancien ; un ancien compte expiré (CH_CTID_TRADER_ACCOUNT_NOT_FOUND) est sauté.
- CTRADER_ACCOUNT_ID accepte aussi le numéro de login FxPro.
- Le statut indique le compte utilisé et les comptes autorisés (numéros seulement).

## 09/11/2026 — cTrader : compatibilité Node
- Premier essai réel : l'app basculait sur Twelve Data. Cause la plus probable : le serveur AI Studio tourne sur une version de Node sans WebSocket intégré. Ajout de la bibliothèque **ws** en secours (même interface, testée contre un serveur local qui imite cTrader).
- Le connecteur (outil « etat ») affiche maintenant l'état de cTrader (configuré, environnement, dernière erreur, lecture seule) et la version de Node, sans aucun secret.

## 07/11/2026 (nuit) — nouvelle identité visuelle
- **Palette « lavande »** : fond clair bleuté (#F3F4FB), cartes blanches, accent indigo-violet (#5A46E0), texte indigo foncé (#1D1B3A). Police Manrope, chiffres à largeur fixe.
- **Verdicts inchangés dans leur sens** : bandeau vert « Achat », rouge « Vente », orange « Attendre », en grand en haut de la carte du verdict.
- **TradingView** en grand (environ deux tiers de l'écran), thème clair assorti, bouton plein écran (Échap pour quitter). L'app s'élargit sur ordinateur.
- Graphique de l'app, en-tête, barre de navigation et icône recolorés ; titres de section en minuscules, contour de focus visible au clavier.

## 07/11/2026 (nuit) — volume profile en ticks (information)
- Les bougies cTrader conservent le **volume en ticks** de FxPro. Calcul du **volume profile** de la journée en cours et de la veille (journée 17h–17h New York) : POC, zone de valeur à 70 % (VAH / VAL), position du prix par rapport à la zone de la veille.
- **Information seulement** : carte « Volume profile (ticks FxPro) » dans l'analyse et champ dans le connecteur ; n'entre pas dans le verdict. Sans cTrader (Twelve Data, Yahoo), rien n'est affiché : ces sources n'ont pas de volume.
- Étape suivante, après l'activation de cTrader : tester au backtest, sur l'historique FxPro, une règle « zone d'entrée alignée avec le POC ou la zone de valeur ».

## 07/11/2026 — cTrader (FxPro), surveillance automatique, alertes Telegram, TradingView
- **cTrader Open API** (`server/ctrader.ts`) : bougies M5 / M15 / H1 au prix FxPro, en priorité sur Twelve Data (qui reste en secours, puis Yahoo). Protocole JSON sur WebSocket (port 5036), lecture seule : aucun message de trading n'existe dans le code. Jeton renouvelé automatiquement s'il expire (refresh token), sans jamais être affiché. Clés dans les Secrets (`CTRADER_*`).
- **Surveillance automatique** (`server/watch.ts`, route `/api/watch/tick?key=WATCH_SECRET`) : appelée toutes les 5 minutes par cron-job.org (l'hébergement AI Studio se met en veille). Pendant les kill zones uniquement, sur l'or : moteur principal + exécution M5 (règles 3.11). Analyse rapide sans IA, puis analyse complète avec Gemini seulement si un setup apparaît. Deux alertes, sans doublon : « setup en préparation » et « ordre prêt ».
- **Telegram** (`server/telegram.ts`) : message avec entrée, stop, TP1/TP2, R:R et validité ; routes d'aide `/api/watch/telegram-chats` et `/api/watch/telegram-test`.
- **App** : carte « Surveillance automatique » en haut de l'onglet Analyse (alertes du jour, « Ajouter au journal » pendant 10 min) ; graphique **TradingView** en direct (OANDA, M5 / M15 / D1) au-dessus du graphique de l'app, qui garde les niveaux du plan ; Réglages : état de cTrader, Telegram et de la surveillance.

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
