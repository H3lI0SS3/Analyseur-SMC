// Connecteur MCP : permet à Claude (claude.ai → Connecteurs personnalisés) d'utiliser l'app.
// Adresse : https://<ton-app>/mcp — protégée par le secret MCP_TOKEN.
// Lecture seule : aucun outil ne passe d'ordre chez un broker.

import crypto from 'crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { PAIRS, getSeries, getQuotes, dataSourceName, type Timeframe } from './marketData';
import { availableProviders, CLAUDE_MODEL, GEMINI_MODEL } from './ai';
import { runAnalysis, AnalysisError } from './analysis';

const CONTRACT: Record<string, number> = { 'EUR/USD': 100_000, 'XAU/USD': 100 };
const PAIR_ENUM = z.enum(['EUR/USD', 'XAU/USD']);

function lots(pair: string, capital: number, riskPct: number, entry: number, sl: number) {
  const dist = Math.abs(entry - sl);
  if (!dist) return null;
  return Math.floor(((capital * riskPct) / 100 / (dist * CONTRACT[pair])) * 100) / 100;
}

const text = (obj: unknown) => ({ content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });

function buildServer() {
  const server = new McpServer({ name: 'analyseur-smc', version: '2.1.0' });
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

  server.registerTool(
    'etat',
    {
      title: 'État de l’app',
      description: 'Source des données de marché, IA disponibles et actifs suivis.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () =>
      text({
        source_donnees: dataSourceName(),
        ia_disponibles: availableProviders(),
        modeles: { claude: CLAUDE_MODEL, gemini: GEMINI_MODEL },
        actifs: Object.values(PAIRS).map(p => p.id),
        heure_serveur_utc: new Date().toISOString(),
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
        return text(`${actif} ${unite_de_temps} — source ${s.source}${s.note ? ` (${s.note})` : ''}\nheure UTC | open high low close\n${rows.join('\n')}`);
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
          actif: a.label,
          genere_a_utc: new Date(a.generatedAt).toISOString(),
          source: a.source,
          avertissements: a.warnings,
          prix: e.price,
          heure_prix_utc: new Date(e.priceTime).toISOString(),
          decision: a.final.signal,
          condition_attente: a.final.signal === 'attendre' ? e.waitCondition : null,
          score_confluence: `${e.checklist.filter(c => c.ok).length}/${e.checklist.length}`,
          plan: p
            ? {
                ...p,
                statut: a.final.signal === 'attendre' ? 'en préparation, pas d’entrée' : 'exploitable',
                zone: e.setup?.zoneLabel,
                objectifs: { tp1: e.setup?.tp1Label, tp2: e.setup?.tp2Label },
                taille_lot: capital ? lots(actif, capital, risk, p.entry, p.sl) : 'donner capital pour calculer',
                risque_usd: capital ? Number(((capital * risk) / 100).toFixed(2)) : null,
              }
            : null,
          checklist: e.checklist.map(c => ({ condition: c.label, ok: c.ok, obligatoire: c.core, detail: c.detail })),
          biais: { valeur: e.bias, detail: e.biasDetail },
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
          plans_alternatifs: e.alternatives,
          notes: a.final.notes,
          ia_interne: a.ai ? { moteur: a.ai.engine, verdict: a.ai.verdict, resume: a.ai.resume, plan: a.ai.plan, invalidation: a.ai.invalidation } : a.aiError,
        });
      } catch (err: any) {
        return fail(err instanceof AnalysisError ? err.message : `Erreur : ${err.message}`);
      }
    }
  );

  return server;
}

/** Vérifie le secret : en-tête "Authorization: Bearer <MCP_TOKEN>" (recommandé) ou ?token=<MCP_TOKEN>. */
function auth(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.MCP_TOKEN;
  if (!expected || expected.length < 16) {
    return res.status(503).json({ error: 'Connecteur désactivé : définis un secret MCP_TOKEN (16 caractères minimum) dans AI Studio.' });
  }
  const header = String(req.headers.authorization || '');
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.query.token || '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Non autorisé.' });
  }
  next();
}

export function mountMcp(app: Express) {
  app.post('/mcp', auth, async (req, res) => {
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
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Erreur interne' }, id: null });
      }
    }
  });
  app.get('/mcp', auth, (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Utilise POST.' }));
  app.delete('/mcp', auth, (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Pas de session.' }));
}
