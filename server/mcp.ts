// Connecteur MCP : permet à Claude (claude.ai → Connecteurs personnalisés) d'utiliser l'app.
// Adresse : https://<ton-app>/mcp — protégée par le secret MCP_TOKEN.
// Lecture seule : aucun outil ne passe d'ordre chez un broker.

import { ctraderStatus, getCTrader } from './ctrader';
import crypto from 'crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { PAIRS, getSeries, getQuotes, dataSourceName, type Timeframe } from './marketData';
import { availableProviders, CLAUDE_MODEL, GEMINI_MODEL } from './ai';
import { runAnalysis, AnalysisError } from './analysis';
import { advanceJobAsync, finishedTrades, getJob, labDataFor, startBacktest, INSTANCE_ID } from './backtestJobs';
import { QUICK_CRITERION, QUICK_HYPOTHESES, runQuickLab, type QuickLabParams } from './quickLab';
import { exportTrades } from './historySnapshot';
import { describe as describeBt } from './backtest';
import { maDateTime } from './time';
import { getJournalStore } from './journalStore';
import { getFxJournal } from './fxJournal';

const CONTRACT: Record<string, number> = { 'EUR/USD': 100_000, 'XAU/USD': 100 };
const PAIR_ENUM = z.enum(['EUR/USD', 'XAU/USD']);

function lots(pair: string, capital: number, riskPct: number, entry: number, sl: number) {
  const dist = Math.abs(entry - sl);
  if (!dist) return null;
  return Math.floor(((capital * riskPct) / 100 / (dist * CONTRACT[pair])) * 100) / 100;
}

const text = (obj: unknown) => ({ content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });

/** Connexion cTrader réelle (lecture seule) dans la même requête : résultat ou erreur exacte, sans aucun secret. */
async function testCTrader() {
  const c = getCTrader();
  if (!c) return { ok: false, erreur: 'cTrader non configuré (CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, CTRADER_ACCESS_TOKEN).' };
  const one = async (tf: 'M5' | 'M15' | 'H1', n: number) => {
    const t0 = Date.now();
    try {
      const bars = await c.trendbars('XAU/USD', tf, n);
      const last = bars[bars.length - 1];
      return { ok: true, bougies: bars.length, derniere: last ? { heure_utc: new Date(last.t).toISOString(), cloture: last.c } : null, duree_ms: Date.now() - t0 };
    } catch (e: any) {
      return { ok: false, code: e?.code ?? null, erreur: String(e?.message || e), duree_ms: Date.now() - t0 };
    }
  };
  const m15 = await one('M15', 100);
  const h1 = await one('H1', 5000);
  const m5 = await one('M5', 150);
  return { ok: m15.ok && h1.ok && m5.ok, M15: m15, H1_5000: h1, M5: m5, lecture_seule: c.scope === 'SCOPE_VIEW', compte: c.accountInfo, erreurs_series: Object.fromEntries(c.seriesErrors) };
}

/** Trades par jour de bourse (5 jours sur 7). */
const perDay = (trades: number, from: number, to: number) => Number((trades / Math.max(1, ((to - from) / 86_400_000) * (5 / 7))).toFixed(2));

/** Présentation d'un résultat du labo rapide (outil « labo » et résumé joint au backtest). */
function fmtQuick(label: string, r: ReturnType<typeof runQuickLab>) {
  return {
    hypothese: label,
    passe_le_critere: r.passes,
    trades_par_jour_de_bourse: r.tradesPerDay,
    toute_la_periode: r.all,
    premiere_moitie: r.halves[0],
    deuxieme_moitie: r.halves[1],
    trimestres_R: r.quarters.map(q => `${q.trades} tr. / ${q.totalR} R`),
    par_sens: r.byDirection,
    par_session: r.bySession,
  };
}

function buildServer() {
  const server = new McpServer({ name: 'analyseur-smc', version: '2.2.0' });
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

  server.registerTool(
    'etat',
    {
      title: 'État de l’app',
      description: 'Source des données de marché, IA disponibles et actifs suivis. tester_ctrader = true : tente une vraie connexion cTrader (lecture seule) et renvoie le résultat ou l’erreur exacte.',
      inputSchema: { tester_ctrader: z.preprocess(v => v === true || v === 'true', z.boolean()).optional().describe('Tester la connexion cTrader maintenant (true)') },
      annotations: readOnly,
    },
    async ({ tester_ctrader }) =>
      text({
        ...(tester_ctrader ? { test_ctrader: await testCTrader() } : {}),
        source_donnees: dataSourceName(),
        ia_disponibles: availableProviders(),
        modeles: { claude: CLAUDE_MODEL, gemini: GEMINI_MODEL },
        actifs: Object.values(PAIRS).map(p => p.id),
        heure_serveur_utc: new Date().toISOString(),
        // aucun secret : configuré ou non, environnement, dernière erreur, lecture seule
        ctrader: ctraderStatus(),
        version_node: process.version,
      })
  );

  server.registerTool(
    'cotations',
    {
      title: 'Cotations en direct',
      description: 'Dernier prix réel de EUR/USD et de l’or (XAU/USD), variation du jour, heure de la dernière bougie et source.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      const q = await getQuotes();
      return text(
        Object.fromEntries(
          Object.entries(q).map(([k, v]) => [
            k,
            v.error ? { erreur: v.error } : { prix: v.price, variation_jour_pct: v.changePct, heure_utc: new Date(v.time!).toISOString(), en_retard_ou_ferme: v.stale, source: v.source },
          ])
        )
      );
    }
  );

  server.registerTool(
    'journal',
    {
      title: 'Journal automatique',
      description: 'Positions lues sur le compte cTrader (lecture seule), rapprochées des signaux de l’app (protocole / TEST), avec résultat net, R réel et statistiques.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      const j = await getFxJournal(getCTrader(), getJournalStore(), Object.fromEntries(Object.entries(PAIRS).map(([id, p]) => [id, p.decimals])));
      return text({
        disponible: j.available,
        erreur: j.error,
        sauvegarde_persistante: j.persistent,
        erreur_sauvegarde: j.storeError,
        compte: j.account,
        stats_app_protocole_plus_test: j.stats,
        stats_protocole: j.protocole,
        stats_test: j.test,
        stats_hors_app: j.hors,
        trades: j.trades.slice(0, 40).map(t => ({ ...t, ouvert: maDateTime(t.openedAt), clos: t.closedAt ? maDateTime(t.closedAt) : null })),
      });
    }
  );

  server.registerTool(
    'bougies',
    {
      title: 'Bougies',
      description: 'Bougies OHLC réelles (heures UTC) pour un actif et une unité de temps.',
      inputSchema: {
        actif: PAIR_ENUM.describe('EUR/USD ou XAU/USD'),
        unite_de_temps: z.enum(['M15', 'H1', 'H4', 'D1']).describe('M15, H1, H4 ou D1'),
        nombre: z.number().int().min(5).max(150).optional().describe('Nombre de bougies (5 à 150, défaut 50)'),
      },
      annotations: readOnly,
    },
    async ({ actif, unite_de_temps, nombre }) => {
      try {
        const s = await getSeries(actif, unite_de_temps as Timeframe);
        const dec = PAIRS[actif].decimals;
        const rows = s.candles
          .slice(-(nombre || 50))
          .map(c => `${new Date(c.t).toISOString().slice(0, 16).replace('T', ' ')} | O ${c.o.toFixed(dec)} H ${c.h.toFixed(dec)} L ${c.l.toFixed(dec)} C ${c.c.toFixed(dec)}`);
        return text(`${actif} ${unite_de_temps} — source ${s.source}${s.futuresProxy ? ' (futures or COMEX : écart possible de 10 à 40 $ avec le spot)' : ''}\nheure UTC | open high low close\n${rows.join('\n')}`);
      } catch (err: any) {
        return fail(`Données indisponibles : ${err.message}`);
      }
    }
  );

  server.registerTool(
    'analyser',
    {
      title: 'Analyse SMC',
      description:
        'Lance l’analyse complète de l’app sur données réelles : biais D1/H4, structure par unité de temps, liquidité, FVG/Order Blocks, plan (entrée, stop, objectifs, R:R), checklist et décision (acheter / vendre / attendre). ' +
        'Par défaut sans IA interne (ia = "aucune") : c’est toi qui commentes le résultat. Ne passe aucun ordre.',
      inputSchema: {
        actif: PAIR_ENUM.describe('EUR/USD ou XAU/USD'),
        ia: z.enum(['aucune', 'auto', 'claude', 'gemini']).optional().describe('Relecture par l’IA interne de l’app (défaut : aucune)'),
        note: z.string().max(500).optional().describe('Contexte donné par le trader'),
        capital: z.number().positive().optional().describe('Capital du compte en $ pour calculer la taille de lot'),
        risque_pct: z.number().positive().max(10).optional().describe('Risque par trade en % (défaut 1)'),
      },
      annotations: readOnly,
    },
    async ({ actif, ia, note, capital, risque_pct }) => {
      try {
        const a = await runAnalysis({ pair: actif, provider: ia === 'aucune' || !ia ? 'none' : ia === 'auto' ? 'auto' : ia, note });
        const e = a.engine;
        const p = a.final.plan;
        const risk = risque_pct ?? 1;
        return text({
          verdict_final: a.verdict,
          actif: a.label,
          genere_a_utc: new Date(a.generatedAt).toISOString(),
          source: a.source,
          avertissements: a.warnings,
          prix: e.price,
          heure_prix_utc: new Date(e.priceTime).toISOString(),
          decision: a.final.signal,
          condition_attente: a.final.signal === 'attendre' ? a.final.notes[0] ?? e.waitCondition : null,
          execution_m5: a.execution ? { etape: a.execution.stage, message: a.execution.message, zone: a.execution.zone, niveau_choch: a.execution.chochLevel, ordre: a.execution.order } : null,
          actif_en_pause: a.paused,
          signal_entrainement_test: a.engine.training
            ? {
                regle: 'TEST 3.12, compte démo uniquement, risque 0,25 % : kill zone obligatoire, il ne manque que le premium/discount et/ou un R:R entre 2 et 2,5 ; entrée sur CHoCH M5 comme le protocole.',
                ordre_pret: a.engine.training.ready !== false,
                execution_m5: a.engine.training.message ?? null,
                plan: a.engine.training.setup,
                conditions_manquantes: a.engine.training.missing,
              }
            : null,
          volume_profile_ticks: a.volumeProfile ?? 'indisponible (volume en ticks seulement avec cTrader)',
          score_confluence: `${e.checklist.filter(c => c.ok).length}/${e.checklist.length}`,
          score_qualite: `${e.score}/100 (classe ${e.grade})`,
          plan: p
            ? {
                ...p,
                statut: a.final.signal === 'attendre' ? 'en préparation, pas d’entrée' : 'exploitable',
                zone: e.setup?.zoneLabel,
                objectifs: { tp1: e.setup?.tp1Label, tp2: e.setup?.tp2Label },
                taille_lot: a.final.signal === 'attendre' ? 'aucune : pas d’entrée tant que le plan n’est pas exploitable' : capital ? lots(actif, capital, risk, p.entry, p.sl) : 'donner capital pour calculer',
                risque_usd: a.final.signal !== 'attendre' && capital ? Number(((capital * risk) / 100).toFixed(2)) : null,
              }
            : null,
          checklist: e.checklist.map(c => ({ condition: c.label, ok: c.ok, obligatoire: c.core, detail: c.detail })),
          biais: { valeur: e.bias, detail: e.biasDetail },
          cycle_amd: e.amd,
          session: e.session,
          structure: Object.fromEntries(
            (['D1', 'H4', 'H1', 'M15'] as const).map(tf => {
              const s = e.timeframes[tf];
              return [tf, { tendance: s.trend, derniere_cassure: s.lastEvent ? `${s.lastEvent.kind} ${s.lastEvent.dir === 'bull' ? 'haussier' : 'baissier'} @ ${s.lastEvent.level}` : null, rsi14: s.rsi14 && Number(s.rsi14.toFixed(1)), atr14: Number(s.atr14.toFixed(a.decimals)) }];
            })
          ),
          range_h1: e.dealingRange,
          liquidite: e.liquidity.map(l => ({ niveau: l.label, prix: l.price, cote: l.side === 'buy' ? 'au-dessus (acheteuse)' : 'en dessous (vendeuse)', deja_pris: l.swept })),
          zones: e.zones.map(z => ({ type: z.kind, ut: z.tf, sens: z.dir === 'bull' ? 'haussier' : 'baissier', bas: z.bottom, haut: z.top, deja_teste: z.touched })),
          zones_a_surveiller_pas_des_signaux: e.alternatives,
          concepts_ict: {
            displacement_a_l_origine_de_la_zone: e.ict.displacement,
            ote: e.ict.ote,
            liquidite_trendline: e.ict.trendlines.map(t => ({ cote: t.side === 'buy' ? 'au-dessus (acheteuse)' : 'en dessous (vendeuse)', touches: t.touches, niveau_actuel: t.priceNow, intacte: t.intact })),
          },
          bougies_japonaises: (a.candlePatterns || []).map(p => ({ figure: p.name, sens: p.dir, ut: p.tf, heure_utc: new Date(p.t).toISOString(), dans_la_zone: p.inZone, detail: p.detail })),
          notes: a.final.notes,
          ia_interne: a.ai ? { moteur: a.ai.engine, verdict: a.ai.verdict, resume: a.ai.resume, plan: a.ai.plan, invalidation: a.ai.invalidation } : a.aiError,
          pipeline_gemini: a.pipeline ? { statut: a.pipeline.status, message: a.pipeline.message, gemini: a.pipeline.gemini, controles: a.pipeline.guard?.checks ?? [] } : null,
        });
      } catch (err: any) {
        return fail(err instanceof AnalysisError ? err.message : `Erreur : ${err.message}`);
      }
    }
  );

  server.registerTool(
    'backtest',
    {
      title: 'Backtest du moteur',
      description:
        'Rejoue le moteur sur ~2 ans d’historique réel (cTrader : H1, M15, M5) et simule chaque plan avec coûts : trades, réussite, total en R, profit factor, pire repli. ' +
        'Protocole complet et signaux TEST, exécution M15 et M5 comme en direct ; résultats sur toute la période, coupée en deux moitiés pour vérifier la stabilité. ' +
        'Le calcul prend plusieurs minutes : chaque appel le fait avancer ; rappelle l’outil jusqu’au statut « terminé ».',
      inputSchema: {
        actif: PAIR_ENUM.describe('EUR/USD ou XAU/USD'),
        relancer: z.boolean().optional().describe('Relancer même si un résultat existe déjà'),
        export: z.boolean().optional().describe('Inclure l’export compact de tous les trades (volumineux)'),
      },
      annotations: readOnly,
    },
    async ({ actif, relancer, export: withExport }) => {
      // calcul par tranches non bloquantes (le serveur continue de répondre à l'app pendant ce temps)
      let job = getJob(actif, 0);
      if (job?.status === 'en cours' && !job.phase?.startsWith('Téléchargement')) job = await advanceJobAsync(actif, 45_000);
      if (job?.status === 'erreur' && !relancer) {
        return fail(`Backtest ${actif} en erreur (serveur ${job.instance}) : ${job.error}. Passe relancer=true pour réessayer.`);
      }
      if (!job || relancer) {
        const started = startBacktest(actif);
        // laisse au téléchargement le temps d'avancer pendant cet appel
        await new Promise(r => setTimeout(r, 20_000));
        job = getJob(actif, 5_000) ?? started;
        if (job.status === 'erreur') return fail(`Backtest ${actif} en erreur (serveur ${job.instance}) : ${job.error}`);
        return text(`Backtest ${actif} lancé (serveur ${job.instance}) : ${job.phase}. Rappelle l’outil pour le faire avancer.`);
      }
      if (job.status === 'en cours' && job.phase?.startsWith('Téléchargement')) {
        // Cloud Run ne donne du CPU que pendant une requête : on garde celle-ci ouverte pour que
        // le téléchargement (réseau + limiteur de débit) progresse vraiment.
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 2_500));
          const j = getJob(actif, 0);
          if (j && (j.status !== 'en cours' || !j.phase?.startsWith('Téléchargement'))) break;
        }
        job = (await advanceJobAsync(actif, 30_000))!;
      }
      if (job.status === 'erreur') return fail(`Backtest ${actif} en erreur (serveur ${job.instance}) : ${job.error}`);
      if (job.status === 'en cours') return text(`Backtest ${actif} en cours (serveur ${job.instance}) : ${job.phase}. Rappelle l’outil pour continuer le calcul.`);
      const r = job.result!;
      return text({
        actif,
        source: r.source,
        prix_futures: r.futuresProxy,
        periode: `${maDateTime(r.from)} → ${maDateTime(r.to)}`,
        pas_analyses: r.stepsEvaluated,
        duree_calcul_s: Math.round(r.durationMs / 1000),
        protocole_complet: { resume: describeBt(r.strict), trades_par_jour_de_bourse: perDay(r.strict.trades, r.from, r.to), ...r.strict },
        protocole_plus_entrainement_test: {
          regle: 'Protocole complet + signaux du mode TEST 3.12 (kill zone obligatoire ; il ne peut manquer que le premium/discount et/ou un R:R entre 2 et 2,5). Exécution M15 ici (sans affinage M5) : voir la ventilation pour l’exécution M5.',
          resume: describeBt(r.souple),
          trades_par_jour_de_bourse: perDay(r.souple.trades, r.from, r.to),
          ...r.souple,
        },
        bougies_m15: r.m15Count,
        historique_limite_par_la_source: r.limitedBySource,
        moteur_ora_corrige: r.ora
          ? {
              regle: 'Retiré de l’app le 07/11 (non rentable au backtest), suivi ici pour comparaison. ORA Trader corrigé (FVG/OTE obligatoire, R:R net TP1 ≥ 2 et TP2 ≥ 2,5, kill zones à l’heure de New York comme le moteur principal, prix dans le FVG ou l’OTE), rejoué en M5, mêmes coûts et même gestion que le moteur actuel.',
              signaux: r.ora.signals,
              toute_la_periode: r.ora.all,
              premiere_moitie: r.ora.firstHalf,
              deuxieme_moitie: r.ora.secondHalf,
              derniers_trades: r.ora.last.map(t => ({ ...t, at: maDateTime(t.at) })),
            }
          : 'non calculé (bougies M5 indisponibles)',
        labo: {
          coupure_entre_les_deux_moities: maDateTime(r.lab.splitAt),
          regle: r.lab.rule,
          variantes: r.lab.variants.map(v => ({
            variante: v.label,
            premiere_moitie: v.inSample,
            deuxieme_moitie: v.outOfSample ?? 'masquée (non retenue sur la 1re moitié)',
          })),
        },
        ventilation_par_condition_manquante: r.breakdown
          ? {
              critere: r.breakdown.criterion,
              coupure_entre_les_deux_moities: maDateTime(r.breakdown.splitAt),
              lignes: r.breakdown.rows.map(b => ({
                variante: b.label,
                execution: b.exec,
                trades_par_jour_de_bourse: b.tradesPerDay,
                premiere_moitie: b.firstHalf,
                deuxieme_moitie: b.secondHalf,
                passe_le_critere: b.passes,
              })),
            }
          : null,
        gestion_de_sortie: r.management
          ? {
              perimetre: r.management.scope,
              coupure_entre_les_deux_moities: maDateTime(r.management.splitAt),
              lignes: r.management.rows.map(m => ({ gestion: m.label, premiere_moitie: m.firstHalf, deuxieme_moitie: m.secondHalf })),
            }
          : null,
        // le labo rapide est joint ici : certains clients gardent en cache l'ancienne liste d'outils et ne voient pas « labo »
        labo_rapide: (() => {
          const d = labDataFor(actif);
          if (!d) return 'indisponible sur ce serveur (backtest terminé ailleurs ou serveur redémarré)';
          return {
            critere: `≥ ${QUICK_CRITERION.minTradesPerHalf} trades et ≥ +${QUICK_CRITERION.minAvgR} R/trade sur chaque moitié, au moins ${QUICK_CRITERION.minPositiveQuarters} trimestres sur 4 positifs.`,
            hypotheses: QUICK_HYPOTHESES.map(h => fmtQuick(h.label, runQuickLab(d, h.params))),
          };
        })(),
        hypotheses: r.assumptions,
        ...(withExport ? { export_compact: { from: r.from, to: r.to, generatedAt: Date.now(), rulesVersion: r.rulesVersion, rows: exportTrades(finishedTrades(actif) ?? []) } } : {}),
        // depuis la 3.7 les deux variantes sont identiques : une seule liste
        derniers_trades: r.lastTrades.filter(t => t.variant === 'strict').map(t => ({
          signal: maDateTime(t.signalAt),
          sens: t.direction,
          entree: t.entry,
          sl: t.sl,
          tp1: t.tp1,
          tp2: t.tp2,
          resultat: t.outcome,
          r: t.r,
          session: t.session,
          amd: t.amdPhase,
        })),
      });
    }
  );

  server.registerTool(
    'labo',
    {
      title: 'Laboratoire rapide',
      description:
        'Rejoue en quelques secondes les setups du dernier backtest TERMINÉ sur ce serveur avec d’autres réglages (stop minimal en ATR H1, exécution M15/M5, sessions, sens, R:R, gestion), sans relancer le moteur. ' +
        'Sans réglage : renvoie toutes les hypothèses déclarées à l’avance. Mesure seule : ne change aucune règle de l’app. ' +
        'Résultat par moitié et par trimestre, et critère : ≥ 30 trades et ≥ +0,2 R/trade sur chaque moitié, 3 trimestres sur 4 positifs.',
      inputSchema: {
        actif: PAIR_ENUM.describe('EUR/USD ou XAU/USD'),
        execution: z.enum(['M15', 'M5', 'M5 marché']).optional(),
        conditions_manquantes: z.array(z.enum(['pd', 'rr', 'session', 'htf'])).optional().describe('Conditions obligatoires qu’un setup peut manquer (défaut : pd ; le R:R se règle avec rr_min)'),
        stop_min_atr_h1: z.number().min(0).max(5).optional().describe('Stop au moins égal à k × ATR H1 (0 = stop du moteur)'),
        rr_min: z.number().min(2).max(6).optional().describe('R:R net minimal de l’ordre final pour le protocole (défaut 2,5 ; un setup TEST garde 2)'),
        sens: z.enum(['tous', 'acheter', 'vendre']).optional(),
        sessions: z.enum(['toutes', 'londres', 'new_york']).optional(),
        gestion: z.enum(['partiel', 'tp1', 'final', 'suivi50', 'suivi75']).optional(),
      },
      annotations: readOnly,
    },
    async ({ actif, execution, conditions_manquantes, stop_min_atr_h1, rr_min, sens, sessions, gestion }) => {
      const d = labDataFor(actif);
      if (!d) return fail(`Aucun backtest ${actif} terminé sur ce serveur (${INSTANCE_ID}). Lance l’outil backtest jusqu’au statut « terminé », puis rappelle le labo.`);
      const fmt = fmtQuick;
      const custom = [execution, conditions_manquantes, stop_min_atr_h1, rr_min, sens, sessions, gestion].some(x => x !== undefined);
      const head = {
        actif,
        serveur: INSTANCE_ID,
        periode: `${maDateTime(d.from)} → ${maDateTime(d.to)}`,
        setups_en_memoire: d.candidates.length,
        critere: `≥ ${QUICK_CRITERION.minTradesPerHalf} trades et ≥ +${QUICK_CRITERION.minAvgR} R/trade sur chaque moitié, au moins ${QUICK_CRITERION.minPositiveQuarters} trimestres sur 4 positifs.`,
      };
      if (custom) {
        const p: QuickLabParams = {
          execution: execution ?? 'M5',
          allowMissing: conditions_manquantes ?? ['pd'],
          minStopAtrH1: stop_min_atr_h1 ?? 0,
          minRR: rr_min ?? 2.5,
          direction: sens ?? 'tous',
          sessions: sessions ?? 'toutes',
          management: gestion ?? 'partiel',
        };
        return text({ ...head, resultat: fmt('Réglage personnalisé', runQuickLab(d, p)), reglage: p });
      }
      return text({ ...head, hypotheses: QUICK_HYPOTHESES.map(h => fmt(h.label, runQuickLab(d, h.params))) });
    }
  );

  return server;
}

/**
 * Vérifie le secret, accepté sous 4 formes :
 *  - dans l'adresse : /mcp/<MCP_TOKEN>   (le plus fiable avec les connecteurs Claude)
 *  - en-tête "Authorization: Bearer <MCP_TOKEN>" ou "X-API-Key: <MCP_TOKEN>"
 *  - paramètre ?token=<MCP_TOKEN>
 */
function auth(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.MCP_TOKEN;
  if (!expected || expected.length < 16) {
    return res.status(503).json({ error: 'Connecteur désactivé : définis un secret MCP_TOKEN (16 caractères minimum) dans AI Studio.' });
  }
  const header = String(req.headers.authorization || '');
  const candidates = [
    String(req.params.token || ''),
    header.startsWith('Bearer ') ? header.slice(7).trim() : '',
    String(req.headers['x-api-key'] || ''),
    String(req.query.token || ''),
  ].filter(Boolean);
  const b = Buffer.from(expected);
  const ok = candidates.some(c => {
    const a = Buffer.from(c);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!ok) return res.status(401).json({ error: 'Non autorisé.' });
  next();
}

async function handleMcp(req: Request, res: Response) {
  // Mode sans session : un serveur neuf par requête (adapté à Cloud Run).
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error('[MCP] erreur', err?.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Erreur interne' }, id: null });
    }
  }
}

export function mountMcp(app: Express) {
  const paths = ['/mcp', '/mcp/:token'];
  // Journal minimal pour diagnostiquer les connexions (sans jamais afficher le secret).
  app.use(['/mcp', '/.well-known'], (req, _res, next) => {
    // jamais le jeton : tout ce qui suit /mcp est masqué, la query string n'est pas journalisée
    const shown = req.baseUrl === '/mcp' ? (req.path === '/' ? '/mcp' : '/mcp/***') : `${req.baseUrl}${req.path}`;
    console.log(`[MCP] ${req.method} ${shown} — ${req.headers['user-agent'] || ''}`);
    next();
  });
  app.post(paths, auth, handleMcp);
  app.get(paths, auth, (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Utilise POST.' }));
  app.delete(paths, auth, (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Pas de session.' }));
  // Pas d'OAuth : on répond clairement 404 en JSON (sinon le site renverrait la page HTML de l'app).
  app.all('/.well-known/*', (_req, res) => res.status(404).json({ error: 'Pas de découverte OAuth : authentification par jeton.' }));
}
