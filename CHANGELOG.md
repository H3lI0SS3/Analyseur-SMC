# Journal des versions

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
