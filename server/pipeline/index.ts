// Orchestration : données → Gemini (JSON strict) → contrôle déterministe → rapport prêt à afficher.
import type { Candle, Timeframe } from '../marketData';
import type { EngineResult } from '../smc';
import { buildMarketPayload, estimateTokens, type WindowSpec } from './payload';
import { runGeminiPipeline, type GeminiCall } from './gemini';
import { verifyPipeline, type GuardVerdict } from './guard';
import type { PipelineResult } from './schema';

export interface PipelineReport {
  /** décision finale du pipeline (après contrôle serveur) */
  status: 'VALIDÉ' | 'REJETÉ' | 'INDISPONIBLE';
  message: string;
  gemini: PipelineResult | null;
  guard: GuardVerdict | null;
  model: string | null;
  latencyMs: number;
  payloadTokens: number;
}

export interface RunPipelineInput {
  symbol: string;
  decimals: number;
  now: number;
  series: Record<Timeframe, Candle[]>;
  engine: EngineResult;
  costs: { spread: number; commissionPerLot: number; contract: number };
  windows?: WindowSpec[];
  timeoutMs?: number;
  call?: GeminiCall;
}

export async function runPipeline(input: RunPipelineInput): Promise<PipelineReport> {
  const payload = buildMarketPayload({
    symbol: input.symbol,
    decimals: input.decimals,
    now: input.now,
    spread: input.costs.spread,
    series: input.series,
    engine: input.engine,
    windows: input.windows,
  });
  const payloadTokens = estimateTokens(payload);
  const out = await runGeminiPipeline(payload, { timeoutMs: input.timeoutMs, call: input.call });
  if (out.status !== 'ok') {
    return {
      status: 'INDISPONIBLE',
      message: `Double validation indisponible (${out.detail}) : résultat du moteur seul.`,
      gemini: null,
      guard: null,
      model: null,
      latencyMs: out.latencyMs,
      payloadTokens,
    };
  }
  // plage des prix « connus » : bougies envoyées + niveaux de liquidité et zones HTF fournis à Gemini
  const all = payload.windows.flatMap(w => [...w.bars, ...(w.current ? [w.current] : [])]);
  const known = [
    ...all.flatMap(b => [b[2], b[3]]),
    ...payload.facts.liquidity.map(l => l.price),
    ...payload.facts.htfZones.flatMap(z => [z.top, z.bottom]),
  ];
  const guard = verifyPipeline(out.result, {
    engine: input.engine,
    symbol: input.symbol,
    decimals: input.decimals,
    spread: input.costs.spread,
    commissionPerLot: input.costs.commissionPerLot,
    contract: input.costs.contract,
    rangeLow: Math.min(...known),
    rangeHigh: Math.max(...known),
  });
  return { status: guard.decision, message: guard.reason, gemini: out.result, guard, model: out.model, latencyMs: out.latencyMs, payloadTokens };
}

export * from './schema';
export { buildMarketPayload, DEFAULT_WINDOWS } from './payload';
export { runGeminiPipeline, PIPELINE_TIMEOUT_MS } from './gemini';
export { verifyPipeline, netRR } from './guard';
