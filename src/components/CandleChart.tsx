import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AnalysisResponse, Candle, Timeframe } from '../types';
import { cx, fmt, localDateTime } from '../lib/utils';

interface Props {
  pair: string;
  decimals: number;
  analysis: AnalysisResponse | null;
}

const TFS: Timeframe[] = ['M15', 'H1', 'H4', 'D1'];
const TF_MS: Record<Timeframe, number> = { M15: 900e3, H1: 3600e3, H4: 4 * 3600e3, D1: 86400e3 };

export function CandleChart({ pair, decimals, analysis }: Props) {
  const [tf, setTf] = useState<Timeframe>('H1');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [meta, setMeta] = useState<{ source?: string; fetchedAt?: number }>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [width, setWidth] = useState(360);
  const [overlays, setOverlays] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(280, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/candles?pair=${encodeURIComponent(pair)}&tf=${tf}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Erreur');
      setCandles(j.candles);
      setMeta({ source: j.source, fetchedAt: j.fetchedAt });
      setError(null);
    } catch (e: any) {
      setError(e.message);
      setCandles([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair, tf]);

  const showAnalysis = overlays && analysis && analysis.pair === pair ? analysis : null;
  const H = 300;
  const padR = 62;
  const padB = 22;
  const count = width < 500 ? 60 : 100;
  const view = candles.slice(-count);

  const geom = useMemo(() => {
    if (!view.length) return null;
    let lo = Math.min(...view.map(c => c.l));
    let hi = Math.max(...view.map(c => c.h));
    const plan = showAnalysis?.final.plan;
    if (plan) {
      const pts = [plan.entry, plan.sl, plan.tp1, plan.tp2].filter((x): x is number => x !== null);
      lo = Math.min(lo, ...pts);
      hi = Math.max(hi, ...pts);
    }
    const pad = (hi - lo) * 0.06 || hi * 0.001;
    lo -= pad;
    hi += pad;
    const plotW = width - padR;
    const step = plotW / view.length;
    const y = (p: number) => ((hi - p) / (hi - lo)) * (H - padB);
    const xOfTime = (t: number) => {
      const i = view.findIndex(c => c.t + TF_MS[tf] > t);
      return i < 0 ? plotW : i * step;
    };
    return { lo, hi, step, y, plotW, xOfTime };
  }, [view, width, showAnalysis, tf]);

  const last = view[view.length - 1];

  return (
    <section className="card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex rounded-lg bg-card2 p-0.5">
          {TFS.map(t => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={cx('rounded-md px-3 py-1.5 text-xs font-semibold', tf === t ? 'bg-gold text-bg' : 'text-mute')}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {analysis && analysis.pair === pair && (
            <button
              onClick={() => setOverlays(o => !o)}
              className={cx('rounded-md border px-2 py-1 text-[11px]', overlays ? 'border-gold text-gold' : 'border-line text-mute')}
            >
              Zones
            </button>
          )}
          <button onClick={load} className="rounded-md p-1.5 text-mute" aria-label="Rafraîchir">
            <RefreshCw className={cx('h-4 w-4', loading && 'spin')} />
          </button>
        </div>
      </div>

      <div ref={boxRef} className="relative w-full">
        {error ? (
          <div className="flex h-[300px] items-center justify-center px-6 text-center text-sm text-down">{error}</div>
        ) : !geom ? (
          <div className="flex h-[300px] items-center justify-center text-sm text-mute">Chargement des bougies…</div>
        ) : (
          <svg width={width} height={H} className="block">
            {/* grille + axe des prix */}
            {Array.from({ length: 5 }).map((_, i) => {
              const p = geom.hi - ((geom.hi - geom.lo) * (i + 0.5)) / 5;
              const yy = geom.y(p);
              return (
                <g key={i}>
                  <line x1={0} x2={geom.plotW} y1={yy} y2={yy} stroke="#1f252e" />
                  <text x={geom.plotW + 6} y={yy + 3} fontSize="10" fill="#6b7380" className="num">
                    {fmt(p, decimals)}
                  </text>
                </g>
              );
            })}

            {/* zones FVG / OB */}
            {showAnalysis?.engine.zones.map(z => {
              const x0 = Math.max(0, geom.xOfTime(z.t));
              const y0 = geom.y(z.top);
              const y1 = geom.y(z.bottom);
              if (y1 < 0 || y0 > H - padB) return null;
              const col = z.dir === 'bull' ? '#3fb68b' : '#e5534b';
              return (
                <g key={z.id}>
                  <rect x={x0} y={y0} width={Math.max(4, geom.plotW - x0)} height={Math.max(2, y1 - y0)} fill={col} opacity={z.kind === 'FVG' ? 0.12 : 0.2} />
                  <text x={geom.plotW - 4} y={y0 + 10} textAnchor="end" fontSize="9" fill={col} opacity={0.9}>
                    {z.kind} {z.tf}
                  </text>
                </g>
              );
            })}

            {/* liquidité */}
            {showAnalysis?.engine.liquidity
              .filter(l => !l.swept && l.price > geom.lo && l.price < geom.hi)
              .map(l => (
                <g key={l.id}>
                  <line x1={0} x2={geom.plotW} y1={geom.y(l.price)} y2={geom.y(l.price)} stroke="#8b93a1" strokeDasharray="2 4" opacity={0.6} />
                  <text x={4} y={geom.y(l.price) - 3} fontSize="9" fill="#8b93a1">
                    {l.id.replace(/-\d+$/, '')}
                  </text>
                </g>
              ))}

            {/* bougies */}
            {view.map((c, i) => {
              const x = i * geom.step + geom.step / 2;
              const up = c.c >= c.o;
              const col = up ? '#3fb68b' : '#e5534b';
              const bw = Math.max(1.5, geom.step * 0.62);
              const yo = geom.y(c.o);
              const yc = geom.y(c.c);
              return (
                <g key={c.t}>
                  <line x1={x} x2={x} y1={geom.y(c.h)} y2={geom.y(c.l)} stroke={col} strokeWidth={1} />
                  <rect x={x - bw / 2} y={Math.min(yo, yc)} width={bw} height={Math.max(1, Math.abs(yc - yo))} fill={col} />
                </g>
              );
            })}

            {/* plan de trade */}
            {showAnalysis?.final.plan &&
              (() => {
                const p = showAnalysis.final.plan!;
                const lines: [number | null, string, string][] = [
                  [p.tp2, '#3fb68b', 'TP2'],
                  [p.tp1, '#3fb68b', 'TP1'],
                  [p.entry, '#d99a3d', 'Entrée'],
                  [p.sl, '#e5534b', 'SL'],
                ];
                return lines
                  .filter(l => l[0] !== null)
                  .map(([v, col, lab]) => (
                    <g key={lab}>
                      <line x1={0} x2={geom.plotW} y1={geom.y(v!)} y2={geom.y(v!)} stroke={col} strokeWidth={1.2} strokeDasharray={lab === 'Entrée' ? '0' : '6 3'} />
                      <rect x={geom.plotW} y={geom.y(v!) - 8} width={padR} height={16} fill={col} rx={3} />
                      <text x={geom.plotW + 4} y={geom.y(v!) + 4} fontSize="10" fill="#0e1217" fontWeight={700} className="num">
                        {fmt(v!, decimals)}
                      </text>
                      <text x={geom.plotW - 4} y={geom.y(v!) - 4} textAnchor="end" fontSize="10" fill={col} fontWeight={600}>
                        {lab}
                      </text>
                    </g>
                  ));
              })()}

            {/* dernier prix */}
            {last && (
              <g>
                <line x1={0} x2={geom.plotW} y1={geom.y(last.c)} y2={geom.y(last.c)} stroke="#e7e4dd" strokeOpacity={0.35} />
                <rect x={geom.plotW} y={geom.y(last.c) - 8} width={padR} height={16} fill="#e7e4dd" rx={3} />
                <text x={geom.plotW + 4} y={geom.y(last.c) + 4} fontSize="10" fill="#0e1217" fontWeight={700} className="num">
                  {fmt(last.c, decimals)}
                </text>
              </g>
            )}

            {/* axe du temps */}
            {view.map((c, i) =>
              i % Math.ceil(view.length / 4) === 0 ? (
                <text key={'t' + c.t} x={i * geom.step} y={H - 6} fontSize="10" fill="#6b7380">
                  {tf === 'D1' || tf === 'H4'
                    ? new Date(c.t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
                    : new Date(c.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                </text>
              ) : null
            )}
          </svg>
        )}
      </div>
      <div className="mt-1 text-[10px] text-mute">
        {meta.source ? `Source : ${meta.source}` : ''}
        {meta.fetchedAt ? ` · mis à jour ${localDateTime(meta.fetchedAt)}` : ''}
        {' · heures locales'}
      </div>
    </section>
  );
}
