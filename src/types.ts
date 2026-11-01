export type Timeframe = 'M15' | 'H1' | 'H4' | 'D1';
export type Trend = 'haussier' | 'baissier' | 'neutre';
export type Signal = 'acheter' | 'vendre' | 'attendre';
export type AiProvider = 'claude' | 'gemini';

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface PairMeta {
  id: string;
  label: string;
  decimals: number;
  pipSize: number;
  contract?: number;
  defaultSpread?: number;
}

export interface Status {
  dataSource: string;
  providers: AiProvider[];
  defaultProvider: AiProvider | null;
  models: { claude: string; gemini: string };
  mcpEnabled?: boolean;
  accessRequired?: boolean;
  rulesVersion?: string;
  pairs: PairMeta[];
}

export interface Quote {
  price?: number;
  time?: number;
  changePct?: number | null;
  stale?: boolean;
  source?: string;
  futuresProxy?: boolean;
  error?: string;
}

export interface StructureEvent {
  kind: 'BOS' | 'CHoCH';
  dir: 'bull' | 'bear';
  level: number;
  t: number;
}

export interface TfSummary {
  tf: Timeframe;
  trend: Trend;
  lastEvent: StructureEvent | null;
  swingHigh: number | null;
  swingLow: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  atr14: number;
  lastClose: number;
  lastTime: number;
}

export interface Zone {
  id: string;
  tf: Timeframe;
  kind: 'FVG' | 'OB' | 'Breaker' | 'IFVG';
  dir: 'bull' | 'bear';
  top: number;
  bottom: number;
  t: number;
  touched: boolean;
}

export interface LiquidityLevel {
  id: string;
  label: string;
  price: number;
  side: 'buy' | 'sell';
  swept: boolean;
  sweptAt?: number;
}

export interface Setup {
  direction: 'acheter' | 'vendre';
  entryType: 'marché' | 'limite';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number | null;
  tp1Label: string;
  tp2Label: string | null;
  rr1: number;
  rr2: number | null;
  zoneId: string;
  zoneLabel: string;
  validUntil?: number;
}

export interface AmdState {
  phase: 'Accumulation' | 'Manipulation' | 'Distribution' | 'Indéterminée';
  direction: 'haussière' | 'baissière' | null;
  detail: string;
  asiaHigh: number | null;
  asiaLow: number | null;
}

export interface VariantStats {
  signals: number;
  filled: number;
  expired: number;
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  totalR: number;
  avgR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number;
  longestLosingStreak: number;
  bySession: Record<string, { trades: number; totalR: number }>;
}

export interface BacktestJob {
  status: 'aucun' | 'en cours' | 'terminé' | 'erreur';
  phase?: string;
  progress?: number;
  startedAt?: number;
  error?: string;
  result?: {
    from: number;
    to: number;
    stepsEvaluated: number;
    source: string;
    assumptions: string[];
    strict: VariantStats;
    souple: VariantStats;
    strictForward: VariantStats;
    soupleForward: VariantStats;
    frozenFrom: number;
    rulesVersion: string;
    limitedBySource: boolean;
    m15Count: number;
    lab?: {
      splitAt: number;
      rule: string;
      variants: { id: string; label: string; inSample: LabStats; outOfSample: LabStats | null }[];
    };
  };
}

export interface LabStats {
  trades: number;
  winRate: number | null;
  avgR: number | null;
  totalR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
  ciLow: number | null;
  ciHigh: number | null;
}

export interface CheckItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  core: boolean;
}

export interface EngineResult {
  price: number;
  priceTime: number;
  timeframes: Record<Timeframe, TfSummary>;
  bias: Trend;
  biasDetail: string;
  session: { name: string; killzone: boolean; detail: string };
  dealingRange: { high: number; low: number; position: number; label: string } | null;
  liquidity: LiquidityLevel[];
  zones: Zone[];
  setup: Setup | null;
  alternatives: Setup[];
  checklist: CheckItem[];
  score: number;
  grade?: 'A+' | 'B' | 'C';
  signal: Signal;
  waitCondition: string | null;
  nextNews: { t: number; currency: string; title: string } | null;
  tentativeNews?: string[];
  newsAvailable: boolean;
  amd: AmdState;
  ict?: {
    ote: { dir: 'bull' | 'bear'; legLow: number; legHigh: number; top: number; bottom: number; detail: string } | null;
    displacement: boolean;
    trendlines: { side: 'buy' | 'sell'; touches: number; priceNow: number; firstT: number; lastT: number; intact: boolean; label: string }[];
    candlePatterns: CandlePattern[];
  };
}

export interface AiReview {
  engine: string;
  verdict: 'VALIDÉ' | 'REJETÉ';
  signal: Signal;
  resume: string;
  contexte: string;
  liquidite: string;
  zones: string;
  plan: string;
  gestion: string;
  invalidation: string;
  lecture_capture: string | null;
  niveaux: { entree: number | null; stop_loss: number | null; tp1: number | null; tp2: number | null };
}

export interface FinalPlan {
  direction: 'acheter' | 'vendre';
  entryType: 'marché' | 'limite';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number | null;
  rr1: number;
  rr2: number | null;
  origin: string;
}

export type SignalHistory =
  | {
      status: 'disponible';
      criteria: string;
      matched: string[];
      trades: number;
      winRate: number;
      avgR: number;
      ciLow: number;
      ciHigh: number;
      profitFactor: number | null;
      fillRate: number | null;
      verdict: 'favorable' | 'défavorable' | 'non démontré';
      viability: number | null;
      message: string;
      period: { from: number; to: number };
      rulesVersion: string;
    }
  | { status: 'en préparation'; message: string; progress: number }
  | { status: 'indisponible'; message: string };

export interface Verdict {
  action: 'ACHETER' | 'VENDRE' | 'ATTENDRE';
  threshold: number;
  summary: string;
  pour: string[];
  contre: string[];
}

export interface CandlePattern {
  name: string;
  dir: 'haussier' | 'baissier';
  tf: Timeframe;
  t: number;
  candles: number;
  inZone: boolean;
  detail: string;
}

export interface AnalysisResponse {
  candlePatterns?: CandlePattern[];
  rulesVersion?: string;
  verdict?: Verdict;
  history?: SignalHistory | null;
  pair: string;
  label: string;
  decimals: number;
  pipSize: number;
  contract: number;
  costs: { spread: number; commissionPerLot: number; contract: number };
  generatedAt: number;
  source: string;
  futuresProxy: boolean;
  warnings: string[];
  engine: EngineResult;
  ai: AiReview | null;
  aiError: string | null;
  final: { signal: Signal; plan: FinalPlan | null; notes: string[] };
}

export interface RiskSettings {
  capital: number;
  riskPct: number;
  dailyLossPct: number;
  aiProvider: AiProvider | 'none' | 'auto';
  /** spread EUR/USD en pips */
  spreadEurPips: number;
  /** spread de l'or en $ */
  spreadGold: number;
  /** commission aller-retour par lot, en $ */
  commissionPerLot: number;
}

/** attente = ordre limite pas encore exécuté ; expire = ordre limite jamais exécuté (annulé) */
export type TradeResult = 'attente' | 'en_cours' | 'gagne' | 'perdu' | 'breakeven' | 'expire' | 'non_pris';

export interface JournalEntry {
  id: string;
  createdAt: number;
  pair: string;
  direction: 'acheter' | 'vendre';
  entry: number;
  sl: number;
  tp: number; // objectif final (TP2 sinon TP1)
  rrPlanned: number;
  riskPct: number;
  lots: number | null;
  result: TradeResult;
  rMultiple: number | null; // résultat en R (ex : +2, -1)
  note: string;
  // ---- suivi automatique (trades pris depuis l'analyse) ----
  auto?: boolean; // true = l'app suit le trade sur les bougies M15 ; false dès que tu saisis le résultat toi-même
  entryType?: 'limite' | 'marché';
  tp1?: number;
  tp2?: number | null;
  validUntil?: number; // ordre limite annulé après cette heure s'il n'est pas exécuté
  spread?: number;
  commissionPerLot?: number;
  contract?: number;
  filledAt?: number | null;
  tp1At?: number | null;
  exitAt?: number | null;
  rulesVersion?: string;
  pattern?: string | null; // figure japonaise dans le sens du trade au moment de la prise (null = aucune)
}
