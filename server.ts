import crypto from 'crypto';
import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { PAIRS, TIMEFRAMES, getSeries, getQuotes, dataSourceName, TF_MS, type Timeframe } from './server/marketData';
import { availableProviders, CLAUDE_MODEL, GEMINI_MODEL } from './server/ai';
import { runAnalysis, AnalysisError } from './server/analysis';
import { mountMcp } from './server/mcp';
import { advanceAll, getJob, startBacktest } from './server/backtestJobs';

dotenv.config();

const app = express();
const PORT = 3000;
app.use(express.json({ limit: '12mb' }));

// ---------- Code d'accès (protège tes crédits IA et données) ----------
// Si APP_ACCESS_CODE est défini, toutes les routes /api/* (sauf /api/status) exigent l'en-tête X-Access-Code.
const accessCode = () => (process.env.APP_ACCESS_CODE || '').trim();
const failures = new Map<string, number[]>();
app.use('/api', (req, res, next) => {
  const code = accessCode();
  if (!code || req.path === '/status') return next();
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const recent = (failures.get(ip) || []).filter(t => now - t < 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans une minute.' });
  const given = Buffer.from(String(req.headers['x-access-code'] || ''));
  const want = Buffer.from(code);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next();
  recent.push(now);
  failures.set(ip, recent);
  res.status(401).json({ error: 'Code d’accès requis.', accessRequired: true });
});

// ---------- Statut ----------
app.get('/api/status', (_req, res) => {
  const providers = availableProviders();
  res.json({
    dataSource: dataSourceName(),
    providers,
    defaultProvider: providers.includes('claude') ? 'claude' : providers[0] || null,
    models: { claude: CLAUDE_MODEL, gemini: GEMINI_MODEL },
    mcpEnabled: (process.env.MCP_TOKEN || '').length >= 16,
    accessRequired: accessCode().length > 0,
    pairs: Object.values(PAIRS).map(p => ({ id: p.id, label: p.label, decimals: p.decimals, pipSize: p.pipSize, contract: p.contract, defaultSpread: p.defaultSpread })),
  });
});

// ---------- Bougies ----------
app.get('/api/candles', async (req, res) => {
  const pair = String(req.query.pair || 'EUR/USD');
  const tf = String(req.query.tf || 'H1') as Timeframe;
  if (!TIMEFRAMES.includes(tf)) return res.status(400).json({ error: 'Unité de temps invalide.' });
  try {
    const s = await getSeries(pair, tf);
    // ?since=<ms> : toutes les bougies depuis cette date (suivi automatique des trades du journal)
    const since = Number(req.query.since);
    const candles = Number.isFinite(since) && since > 0 ? s.candles.filter(c => c.t >= since - TF_MS[tf]).slice(-700) : s.candles.slice(-150);
    res.json({ pair, tf, candles, source: s.source, futuresProxy: s.futuresProxy, fetchedAt: s.fetchedAt });
  } catch (err: any) {
    res.status(502).json({ error: `Données indisponibles : ${err.message}` });
  }
});

// ---------- Cotations ----------
app.get('/api/quotes', async (_req, res) => {
  const quotes = await getQuotes();
  advanceAll(1500); // fait progresser un éventuel calcul d'historique
  res.json({ quotes });
});

// ---------- Analyse ----------
app.post('/api/analyze', async (req, res) => {
  const { pair = 'EUR/USD', provider, image, note, spread, commissionPerLot } = req.body || {};
  try {
    const img = image && typeof image.base64 === 'string' ? { base64: image.base64, mediaType: String(image.mediaType || 'image/jpeg') } : undefined;
    res.json(await runAnalysis({ pair, provider, image: img, note, spread: Number(spread), commissionPerLot: Number(commissionPerLot) }));
  } catch (err: any) {
    res.status(err instanceof AnalysisError ? err.status : 500).json({ error: err.message });
  }
});

// ---------- Backtest (rejeu du moteur sur l'historique) ----------
app.post('/api/backtest', (req, res) => {
  const { pair = 'EUR/USD', spread, commissionPerLot } = req.body || {};
  try {
    res.json(startBacktest(pair, Number(spread), Number(commissionPerLot)));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
app.get('/api/backtest', async (req, res) => {
  // chaque consultation fait avancer le calcul ~2,5 s (Cloud Run ne donne du CPU que pendant les requêtes)
  const pair = String(req.query.pair || 'EUR/USD');
  let job = getJob(pair, 2500);
  if (job?.status === 'en cours' && job.phase?.startsWith('Téléchargement')) {
    await new Promise(r => setTimeout(r, 2500)); // laisse le téléchargement avancer pendant la requête
    job = getJob(pair, 0);
  }
  res.json(job || { status: 'aucun' });
});

// ---------- Connecteur MCP (pour piloter l'app depuis Claude) ----------
mountMcp(app);

app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `Route API non trouvée : ${req.originalUrl}` });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Analyseur] Serveur prêt sur http://0.0.0.0:${PORT} — données : ${dataSourceName()}, IA : ${availableProviders().join(', ') || 'aucune'}`);
  });
}

startServer();
