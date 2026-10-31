import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { PAIRS, TIMEFRAMES, getSeries, getQuotes, dataSourceName, type Timeframe } from './server/marketData';
import { availableProviders, CLAUDE_MODEL, GEMINI_MODEL } from './server/ai';
import { runAnalysis, AnalysisError } from './server/analysis';
import { mountMcp } from './server/mcp';

dotenv.config();

const app = express();
const PORT = 3000;
app.use(express.json({ limit: '12mb' }));

// ---------- Statut ----------
app.get('/api/status', (_req, res) => {
  const providers = availableProviders();
  res.json({
    dataSource: dataSourceName(),
    providers,
    defaultProvider: providers.includes('claude') ? 'claude' : providers[0] || null,
    models: { claude: CLAUDE_MODEL, gemini: GEMINI_MODEL },
    mcpEnabled: (process.env.MCP_TOKEN || '').length >= 16,
    pairs: Object.values(PAIRS).map(p => ({ id: p.id, label: p.label, decimals: p.decimals, pipSize: p.pipSize })),
  });
});

// ---------- Bougies ----------
app.get('/api/candles', async (req, res) => {
  const pair = String(req.query.pair || 'EUR/USD');
  const tf = String(req.query.tf || 'H1') as Timeframe;
  if (!TIMEFRAMES.includes(tf)) return res.status(400).json({ error: 'Unité de temps invalide.' });
  try {
    const s = await getSeries(pair, tf);
    res.json({ pair, tf, candles: s.candles.slice(-150), source: s.source, note: s.note, fetchedAt: s.fetchedAt });
  } catch (err: any) {
    res.status(502).json({ error: `Données indisponibles : ${err.message}` });
  }
});

// ---------- Cotations ----------
app.get('/api/quotes', async (_req, res) => {
  res.json({ quotes: await getQuotes() });
});

// ---------- Analyse ----------
app.post('/api/analyze', async (req, res) => {
  const { pair = 'EUR/USD', provider, image, note } = req.body || {};
  try {
    const img = image && typeof image.base64 === 'string' ? { base64: image.base64, mediaType: String(image.mediaType || 'image/jpeg') } : undefined;
    res.json(await runAnalysis({ pair, provider, image: img, note }));
  } catch (err: any) {
    res.status(err instanceof AnalysisError ? err.status : 500).json({ error: err.message });
  }
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
