// Étape 0 du pipeline : préparer les données de marché envoyées à Gemini.
// Fenêtres glissantes OHLCV par unité de temps (HTF + LTF), arrondies, avec un budget de tokens.
// On joint aussi les faits calculés par le moteur (liquidité, zones HTF, cassures) : Gemini raisonne
// sur ces faits et ne doit citer AUCUN prix qui n'y figure pas.
import { TF_MS, type Candle, type Timeframe } from '../marketData';
import type { EngineResult } from '../smc';
import { MIN_RR } from '../smc';

/** Une bougie compacte : [heure UTC "YYYY-MM-DD HH:MM", open, high, low, close, volume|null]. */
export type OhlcvBar = [string, number, number, number, number, number | null];

export interface WindowSpec {
  tf: Timeframe;
  bars: number;
  role: 'HTF' | 'LTF';
}

/** Fenêtres par défaut : assez de contexte structurel, ~3 000 tokens au total. */
export const DEFAULT_WINDOWS: WindowSpec[] = [
  { tf: 'H4', bars: 60, role: 'HTF' }, // 10 jours : zones et liquidité externes
  { tf: 'H1', bars: 72, role: 'HTF' }, // 3 jours : structure intermédiaire, PDH/PDL
  { tf: 'M15', bars: 96, role: 'LTF' }, // 24 h : balayage, displacement, CHoCH, FVG
];

/** Budget maximal (estimation grossière : ~4 caractères par token). */
export const MAX_PAYLOAD_TOKENS = 6_000;

export interface MarketWindow {
  tf: Timeframe;
  role: 'HTF' | 'LTF';
  /** bougies CLÔTURÉES uniquement, de la plus ancienne à la plus récente */
  bars: OhlcvBar[];
  /** bougie en cours (non clôturée), séparée pour qu'elle ne soit jamais prise pour une structure */
  current: OhlcvBar | null;
}

export interface MarketPayload {
  symbol: string;
  decimals: number;
  generatedAtUtc: string;
  price: number;
  spread: number;
  volumeAvailable: boolean;
  windows: MarketWindow[];
  /** faits déterministes du moteur : les seuls niveaux que Gemini a le droit d'utiliser */
  facts: {
    bias: { value: string; detail: string; d1: string; h4: string };
    session: { name: string; killzone: boolean };
    newsBlocked: boolean;
    nextNews: string | null;
    liquidity: { label: string; price: number; side: 'au-dessus' | 'en dessous'; swept: boolean }[];
    htfZones: { tf: string; kind: string; dir: 'haussier' | 'baissier'; top: number; bottom: number }[];
    m15Breaks: { kind: string; dir: 'haussier' | 'baissier'; level: number; timeUtc: string }[];
    engineTrigger: {
      dir: 'haussier' | 'baissier';
      sweepLabel: string;
      sweepPrice: number;
      sweepTimeUtc: string;
      sweepExtreme: number;
      displacementTimeUtc: string;
      chochLevel: number;
      chochTimeUtc: string;
      legHigh: number;
      legLow: number;
    } | null;
  };
  /** plan calculé par le moteur : c'est CE plan que Gemini valide ou rejette (il n'en propose pas d'autre) */
  enginePlan: {
    direction: 'BUY' | 'SELL';
    entryType: 'limite' | 'marché';
    entry: number;
    stopLoss: number;
    takeProfit: number;
    rr: number;
    zone: string;
  } | null;
  rules: { minRR: number; slBuffer: number; ltf: Timeframe; commissionPerUnit: number };
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

function toBar(c: Candle, dec: number): OhlcvBar {
  const v = (c as Candle & { v?: number }).v;
  return [iso(c.t), +c.o.toFixed(dec), +c.h.toFixed(dec), +c.l.toFixed(dec), +c.c.toFixed(dec), typeof v === 'number' && Number.isFinite(v) ? v : null];
}

/** Fenêtre glissante : les N dernières bougies clôturées + la bougie en cours à part. */
export function slidingWindow(candles: Candle[], tf: Timeframe, n: number, now: number, dec: number): { bars: OhlcvBar[]; current: OhlcvBar | null } {
  const closed = candles.filter(c => c.t + TF_MS[tf] <= now);
  const live = candles.find(c => c.t <= now && c.t + TF_MS[tf] > now) ?? null;
  return { bars: closed.slice(-n).map(c => toBar(c, dec)), current: live ? toBar(live, dec) : null };
}

/** Estimation du nombre de tokens d'un objet sérialisé. */
export const estimateTokens = (x: unknown) => Math.ceil(JSON.stringify(x).length / 4);

export interface PayloadInput {
  symbol: string;
  decimals: number;
  now: number;
  spread: number;
  /** commission aller-retour par lot / taille du contrat (même unité que le prix) */
  commissionPerUnit?: number;
  series: Record<Timeframe, Candle[]>;
  engine: EngineResult;
  windows?: WindowSpec[];
  maxTokens?: number;
}

export function buildMarketPayload(input: PayloadInput): MarketPayload {
  const { symbol, decimals: dec, now, spread, series, engine } = input;
  const specs = (input.windows ?? DEFAULT_WINDOWS).map(w => ({ ...w }));
  const maxTokens = input.maxTokens ?? MAX_PAYLOAD_TOKENS;
  const r = (x: number) => +x.toFixed(dec);
  const word = (d: 'bull' | 'bear') => (d === 'bull' ? 'haussier' : 'baissier') as 'haussier' | 'baissier';
  const tr = engine.trigger;

  const facts: MarketPayload['facts'] = {
    bias: { value: engine.bias, detail: engine.biasDetail, d1: engine.timeframes.D1.trend, h4: engine.timeframes.H4.trend },
    session: { name: engine.session.name, killzone: engine.session.killzone },
    newsBlocked: !engine.checklist.find(c => c.key === 'news')?.ok,
    nextNews: engine.nextNews ? `${engine.nextNews.title} (${engine.nextNews.currency}) ${iso(engine.nextNews.t)} UTC` : null,
    liquidity: engine.liquidity.map(l => ({ label: l.label, price: l.price, side: l.side === 'buy' ? 'au-dessus' : 'en dessous', swept: l.swept })),
    htfZones: engine.htfZones.map(z => ({ tf: z.tf, kind: z.kind, dir: word(z.dir), top: z.top, bottom: z.bottom })),
    m15Breaks: [], // rempli ci-dessous à partir de la dernière cassure connue
    engineTrigger: tr
      ? {
          dir: word(tr.dir),
          sweepLabel: tr.sweep.label,
          sweepPrice: r(tr.sweep.price),
          sweepTimeUtc: iso(tr.sweep.t),
          sweepExtreme: r(tr.extreme),
          displacementTimeUtc: iso(tr.displacementT),
          chochLevel: r(tr.mss.level),
          chochTimeUtc: iso(tr.mss.t),
          legHigh: r(tr.legHigh),
          legLow: r(tr.legLow),
        }
      : null,
  };
  const last = engine.timeframes.M15.lastEvent;
  if (last) facts.m15Breaks.push({ kind: last.kind, dir: word(last.dir), level: r(last.level), timeUtc: iso(last.t) });

  // le plan n'est transmis que s'il vient du déclencheur complet (zone née de l'impulsion)
  const st = engine.setup;
  const fromTrigger = !!st && !!engine.checklist.find(c => c.key === 'zone')?.ok;
  const finalTp = st ? st.tp2 ?? st.tp1 : 0;
  const enginePlan: MarketPayload['enginePlan'] =
    st && fromTrigger
      ? {
          direction: st.direction === 'acheter' ? 'BUY' : 'SELL',
          entryType: st.entryType,
          entry: st.entry,
          stopLoss: st.sl,
          takeProfit: finalTp,
          rr: st.rr2 ?? st.rr1,
          zone: st.zoneLabel,
        }
      : null;

  const make = (): MarketPayload => ({
    symbol,
    decimals: dec,
    generatedAtUtc: new Date(now).toISOString(),
    price: engine.price,
    spread,
    volumeAvailable: false,
    windows: specs.map(w => ({ tf: w.tf, role: w.role, ...slidingWindow(series[w.tf], w.tf, w.bars, now, dec) })),
    facts,
    enginePlan,
    rules: { minRR: MIN_RR, slBuffer: r(Math.max(0.1 * engine.timeframes.M15.atr14, spread)), ltf: 'M15', commissionPerUnit: input.commissionPerUnit ?? 0 },
  });

  // Budget de tokens : on raccourcit d'abord les fenêtres HTF (le moteur fournit déjà zones et liquidité HTF),
  // jamais en dessous de 24 bougies, puis la fenêtre LTF jusqu'à 48 bougies.
  let payload = make();
  for (let guard = 0; estimateTokens(payload) > maxTokens && guard < 20; guard++) {
    const htf = specs.filter(s => s.role === 'HTF' && s.bars > 24).sort((a, b) => b.bars - a.bars)[0];
    const ltf = specs.find(s => s.role === 'LTF' && s.bars > 48);
    const target = htf ?? ltf;
    if (!target) break;
    target.bars = Math.max(target.role === 'HTF' ? 24 : 48, Math.floor(target.bars * 0.75));
    payload = make();
  }
  payload.volumeAvailable = payload.windows.some(w => w.bars.some(b => b[5] !== null));
  return payload;
}
